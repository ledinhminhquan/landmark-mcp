/**
 * The ingest CLI, run the way Windows runs it.
 *
 * PowerShell and cmd.exe hand "test/fixtures/*.xlsx" to the program untouched, so the
 * documented quick-start failed with "File not found" on the platform this project is
 * built on. These tests spawn the CLI with no shell at all, which is the same thing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandPattern } from '../src/ingest/glob.ts';
import { assertIndex } from '../src/indexfmt.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'landmark-cli-'));

// Without npm's own npm_config_out, whatever the runner was started with, unless a test
// sets it: the CLI reads it (see the PowerShell test below).
const { npm_config_out: _ignored, ...baseEnv } = process.env;

function cli(...args: string[]) {
  return cliWith({}, ...args);
}

function cliWith(env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/ingest/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  });
}

test('wildcards are expanded by the CLI itself, sorted like a shell would', async () => {
  const cwd = process.cwd();
  process.chdir(ROOT);
  try {
    const xlsx = await expandPattern('test/fixtures/*.xlsx');
    assert.deepEqual(xlsx.map((p) => basename(p)), [
      '01-flat.xlsx',
      '02-stacked-header.xlsx',
      '03-merged-header.xlsx',
      '04-title-and-vmerge.xlsx',
      '05-three-regions.xlsx',
    ]);
    assert.deepEqual((await expandPattern('test/fixtures/0?-countries.csv')).map((p) => basename(p)), ['06-countries.csv']);
    assert.deepEqual((await expandPattern('test/fixtures\\*.csv')).map((p) => basename(p)), ['06-countries.csv'], 'backslashes too');
    assert.deepEqual((await expandPattern('test/fix*/[0][6]*')).map((p) => basename(p)), ['06-countries.csv']);
    assert.deepEqual(await expandPattern('test/fixtures/*.nothing'), []);
    assert.deepEqual(await expandPattern('plain-name.xlsx'), ['plain-name.xlsx'], 'a name without a wildcard is left alone');
  } finally {
    process.chdir(cwd);
  }
});

test('the documented command builds the index from unexpanded wildcards', async () => {
  const out = join(dir, 'index.json');
  const run = cli('test/fixtures/*.xlsx', 'test/fixtures/*.csv', '--out', out);
  assert.equal(run.status, 0, run.stderr);

  const text = await readFile(out, 'utf8');
  const parsed: unknown = JSON.parse(text);
  assertIndex(parsed);
  assert.deepEqual(parsed.tables.map((t) => t.id), [
    '01-flat',
    '02-stacked-header',
    '03-merged-header',
    '04-title-and-vmerge',
    '05-three-regions',
    '06-countries',
  ]);

  // The size printed is the size written, not the size of a more compact encoding.
  const kb = /\(6 table\(s\), ([\d.]+) KB\)/.exec(run.stdout);
  assert.ok(kb, run.stdout);
  assert.equal(kb[1], ((await stat(out)).size / 1024).toFixed(1));

  // The score is described as what it is, and doubt is printed where it exists.
  assert.ok(!/% of columns labelled/.test(run.stdout));
  assert.match(run.stdout, /evidence 0\.\d\d/);
  // How many heading rows, then where: "header rows: 5" for one heading on row 5 read as five.
  assert.match(run.stdout, /mixed\.t2 — 2 rows x 3 cols\r?\n {4}header: 1 row \(sheet row 5\) — /);
  assert.doesNotMatch(run.stdout, /header rows: /);
  assert.match(run.stdout, /mixed\.t3[\s\S]*AMBIGUOUS — could instead 0 header row\(s\): treat every row as data/);
});

test('an input that cannot be read writes nothing, rather than a partial index', async () => {
  const out = join(dir, 'partial.json');
  // What PowerShell produces from `npm run ingest -- a.xlsx --out x.json`: the output
  // path arrives as one more input.
  const run = cli('test/fixtures/01-flat.xlsx', out.replace(/partial/, 'meant-as-output'), '--out', out);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Nothing written/);
  assert.match(run.stderr, /quote the double dash/);
  await assert.rejects(stat(out), 'no index was written');

  const none = cli('test/fixtures/*.nothing', '--out', out);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No files match test\/fixtures\/\*\.nothing/);
});

test('an --out that npm kept for itself still decides where the index goes', async () => {
  // PowerShell drops the unquoted "--" in `npm run ingest -- *.xlsx --out=mine.json`,
  // so npm keeps "--out=mine.json" as its own setting, passes it on as npm_config_out,
  // and runs the script with the files alone. The index used to go to the default
  // path, replacing data/index.json — the demo's — with someone's own spreadsheets.
  const out = join(dir, 'kept-by-npm.json');
  const demo = join(ROOT, 'data', 'index.json');
  const before = await readFile(demo, 'utf8');
  const run = cliWith({ npm_config_out: out }, 'test/fixtures/01-flat.xlsx');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /npm kept --out for itself/);
  assertIndex(JSON.parse(await readFile(out, 'utf8')));
  assert.equal(await readFile(demo, 'utf8'), before, 'the default index was left alone');

  // An --out on the command line still wins, and npm's bare flag is not a path.
  const explicit = join(dir, 'explicit.json');
  assert.equal(cliWith({ npm_config_out: out }, 'test/fixtures/01-flat.xlsx', '--out', explicit).status, 0);
  await stat(explicit);
  const flagOnly = cliWith({ npm_config_out: 'true' }, 'test/fixtures/01-flat.xlsx', '--out', join(dir, 'flag.json'));
  assert.equal(flagOnly.status, 0, flagOnly.stderr);
  assert.doesNotMatch(flagOnly.stdout, /npm kept --out/);
});
