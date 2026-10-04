/**
 * Where the 4 October fixes met each other. Each cluster's own tests passed alone; these
 * are the places where one cluster's change altered what another relied on, pinned as a
 * listener or a host meets them once all of it runs together.
 *
 *   - The engine began refusing a total of a rate. The voice client used a total as "the
 *     row's own figure" — for "lower than Thailand" and for a ranking one row to a group —
 *     so those questions were refused, though nothing was being added up.
 *   - Describe began giving a cursor for a wide table. "More" after a page of column
 *     names went back to that cursor instead of reading on from the page just heard, and
 *     a describe made only to learn the columns left a cursor nobody had heard.
 *   - Ingest began leaving Average, Count, Max and Min rows out of answers. The engine
 *     still called every one of them a total row, and a row-number column "holds number".
 *   - The bundled files got names a person would give them, by a titles file kept with
 *     the fixtures; the ids, and the old names, still reach them.
 *
 * Every truth is worked out here from the rows, not copied from a reply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import { assertIndex, type IndexTable, type LandmarkIndex } from '../src/indexfmt.ts';
import { QueryError, runQuery } from '../src/query/engine.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundled: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(bundled);

type Cell = string | number | boolean | null;
const table = (name: string, grid: Cell[][]): IndexTable =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });

interface Turn {
  plan: { tool?: string; args?: Record<string, unknown>; speak?: string };
  payload: Record<string, unknown> | null;
  spoken: string;
}

let sessions = 0;
/** A voice conversation against an index, driven as the page drives it. */
function voice(index: LandmarkIndex) {
  const handler = createHandler({ index });
  let session = '';
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          'x-landmark-session': session,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
    );
    const body = JSON.parse(await res.text()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
  };
  const say = async (u: string): Promise<Turn> => (await converse(u, call)) as Turn;
  const open = async (phrase: string): Promise<void> => {
    session = `integrate2-${++sessions}`;
    resetContext();
    await loadCatalogue(call);
    if (phrase) await say(phrase);
  };
  return { call, say, open };
}

const countries = bundled.tables.find((t) => t.id === '06-countries')!.regions[0]!;
const gdpOf = (country: string): number => {
  const row = countries.rows.find((r) => r[0] === country)!;
  return Number(row[2]);
};

// ── a total that adds nothing up ───────────────────────────────────────────

test('a total of a rate over one row is that row\'s figure, and over several is still refused', () => {
  const gdp = 'GDP per capita (usd)';
  // One country: nothing is added, so there is nothing to refuse.
  const peru = runQuery(countries, { filters: [{ column: 'Country', op: 'eq', value: 'Peru' }], aggregate: 'sum', aggregateColumn: gdp });
  assert.equal(peru.result, gdpOf('Peru'));
  // One row to a group: each figure is the row's own.
  const ranked = runQuery(countries, { aggregate: 'sum', aggregateColumn: gdp, groupBy: 'Country', order: 'asc', limit: 50 });
  assert.equal(ranked.oneRowEach, true);
  assert.deepEqual(
    ranked.groups.map((g) => g.value),
    countries.rows.map((r) => Number(r[2])).sort((a, b) => a - b),
  );
  // Several countries to a region, or to Asia: their per-person figures added up mean nothing.
  assert.throws(() => runQuery(countries, { aggregate: 'sum', aggregateColumn: gdp, groupBy: 'Region' }), QueryError);
  assert.throws(
    () => runQuery(countries, { filters: [{ column: 'Region', op: 'eq', value: 'Asia' }], aggregate: 'sum', aggregateColumn: gdp }),
    /is a per-capita figure, so adding it up across rows gives no real total/,
  );
});

test('the voice client\'s lookups and one-row rankings of a rate are answered, not refused', async () => {
  const { say, open } = voice(bundled);
  await open('open the countries table');
  const peru = gdpOf('Peru');
  const higher = await say('how many countries have a higher gdp per capita than peru');
  assert.equal(higher.payload?.['result'], countries.rows.filter((r) => Number(r[2]) > peru).length, higher.spoken);
  assert.match(higher.spoken, /^Peru: GDP per capita \(usd\) /);

  await open('open the countries table');
  const lowest = await say('rank the countries by gdp per capita from lowest to highest');
  const order = [...countries.rows].sort((a, b) => Number(a[2]) - Number(b[2])).map((r) => String(r[0]));
  assert.equal(((lowest.payload?.['groups'] ?? []) as { key: string }[])[0]?.key, order[0], lowest.spoken);
  assert.doesNotMatch(lowest.spoken, /no real total/);
});

// ── found by the 120-question probe ────────────────────────────────────────

test('"the highest amount per department" is each department\'s highest, said as one', async () => {
  const { say, open } = voice(bundled);
  await open('open the budget');
  const t = await say('highest amount per department');
  // Each department's totals (560 and 234 thousand) were spoken with no word that they
  // were totals, to someone who had asked for its highest line.
  const groups = Object.fromEntries(((t.payload?.['groups'] ?? []) as { key: string; value: number }[]).map((g) => [g.key, g.value]));
  assert.deepEqual(groups, { Engineering: 480000, Design: 210000 }, t.spoken);
  assert.match(t.spoken, /^Highest Amount: /);
  // "Which department spends the most" still ranks the departments by their totals.
  await open('open the budget');
  const most = await say('which department spends the most');
  assert.equal(((most.payload?.['groups'] ?? []) as { key: string; value: number }[])[0]?.value, 480000 + 62000 + 18000);
});

test('"from lowest to highest" is the order of the list, not a request for the highest', async () => {
  const { say, open } = voice(bundled);
  await open('open the quarterly data');
  const t = await say('q1 revenue for every region from lowest to highest');
  // It was "Highest Q1 Revenue: North, 1200, South, 900 and East, 700" — largest first.
  assert.deepEqual(
    ((t.payload?.['groups'] ?? []) as { key: string; value: number }[]).map((g) => [g.key, g.value]),
    [['East', 700], ['South', 900], ['North', 1200]],
  );
  assert.equal(t.spoken, 'Lowest first: East, 700, South, 900 and North, 1200.');
  await open('open the countries');
  const asked = await say('population for every region from the biggest to the smallest');
  assert.equal(((asked.payload?.['groups'] ?? []) as { key: string }[])[0]?.key, 'Asia', asked.spoken);
  assert.equal(asked.plan.args?.['aggregate'], 'sum');
});

// ── a column's own judgement, from describe ────────────────────────────────

const perRow = table('regions', [['Region', 'Headcount per team', 'Sales per region'], ['North', 12, 100], ['South', 8, 300]]);
const incomes = table('incomes', [['District', 'Region', 'Median income'], ['A', 'North', 30000], ['B', 'North', 34000], ['C', 'South', 28000]]);

test('a total the server says adds up is given as a total, with no word that it cannot be', async () => {
  const { say, open } = voice(buildIndex([perRow, incomes]));
  await open('open the regions table');
  // "Per team" in a sheet with a row to each region: the heading alone said "cannot be
  // added up into a total", and the average was given in its place.
  const head = await say('what is the total headcount');
  assert.equal(head.payload?.['result'], 20, head.spoken);
  assert.doesNotMatch(head.spoken, /cannot be added up/);

  // "Median income" names no rate in the client's own list, but the server says it has no
  // total: a question with no aggregate word is its average, not a refused total.
  await open('open the incomes table');
  const north = await say('what is the income for the north');
  assert.equal(north.payload?.['result'], 32000, north.spoken);
  assert.equal(north.plan.args?.['aggregate'], 'avg');
  // Asked for as a total in so many words, it is the average, and said to be.
  const total = await say('what is the total median income');
  assert.ok(Math.abs(Number(total.payload?.['result']) - (30000 + 34000 + 28000) / 3) < 1e-6, total.spoken);
  assert.match(total.spoken, /^Median income cannot be added up into a total, so this is its average\. /);
});

// ── reading on through a wide table's names ────────────────────────────────

const WEEKS = 38;
const weekly = table('weekly', [
  ['Store', ...Array.from({ length: WEEKS }, (_, i) => `W${i + 1}`), 'Total'],
  ...['Ben Thanh', 'Cho Lon'].map((store, s) => {
    const weeks = Array.from({ length: WEEKS }, (_, i) => 10 + s + i);
    return [store, ...weeks, weeks.reduce((a, b) => a + b, 0)];
  }),
]);
const teams = table('teams', [['Team', 'Headcount'], ['Ops', 12], ['Web', 8]]);

test('"more" after describe reads every column of a forty-column table, to the last', async () => {
  const { say, open } = voice(buildIndex([weekly, teams]));
  await open('');
  const first = await say('open the weekly table');
  assert.match(first.spoken, / and 32 more\. Say more for the rest\.$/);
  const heard: string[] = [];
  for (let i = 0; i < 6; i++) {
    const t = await say('more');
    heard.push(t.spoken);
    if (/^The last columns are/.test(t.spoken)) break;
    assert.equal(t.plan.tool, 'table_describe', t.spoken);
  }
  assert.match(heard.at(-1)!, /^The last columns are .* and Total\.$/);
  assert.equal((await say('more')).spoken, 'That was all of it — nothing more to read.');
});

test('a describe made only to learn the columns leaves nothing for "more" to read on through', async () => {
  const { say, open } = voice(buildIndex([weekly, teams]));
  await open('open the teams table');
  // The weekly table is described quietly to answer this, and the answer is a question back.
  const asked = await say('in the weekly table how many columns are there');
  assert.match(asked.spoken, /^In Weekly\. This table has 40 columns\./);
  const more = await say('more');
  assert.doesNotMatch(more.spoken, /^The next columns are W8\b/, 'read on through a list the listener never heard');
});

test('"I could not find" in a wide table names its columns a page at a time, and "more" reads on', async () => {
  const { say, open } = voice(buildIndex([weekly, teams]));
  await open('open the weekly table');
  const missing = await say('what is the total sprockets');
  assert.equal(
    missing.spoken,
    'I could not find "sprockets" in this table. The first columns are Store, W1, W2, W3, W4, W5, W6, W7, W8, W9, and 30 more. Say more for the rest.',
  );
  assert.match((await say('more')).spoken, /^The next columns are W10, W11, /);
  // The question is still open: naming a column answers it.
  const w12 = await say('what is the total w12');
  assert.equal(w12.payload?.['result'], 10 + 11 + 11 + 11);
});

// ── summary rows that are not totals, and a column that numbers the rows ───

test('Average rows left out of answers are named as what they are, not called totals', async () => {
  const home = table('home budget', [['Item', 'Amount'], ['Rent', 900], ['Food', 300], ['Travel', 150], ['Total', 1350], ['Average', 450]]);
  const stt = table('chi tieu', [['STT', 'Khoản chi', 'Số tiền'], [1, 'Tiền nhà', 4500000], [2, 'Điện', 1250000], [3, 'Đi chợ', 3200000]]);
  const unread = table('unread', [['Item', 'Amount', 'Score'], ['a', 10, 5], ['b', 'n/a', 'abc'], ['c', 30, 12], ['d', 40, 'def']]);
  const { call } = voice(buildIndex([home, stt, unread]));

  const total = await call('table_query', { table_id: 'home-budget', aggregate: 'sum', aggregate_column: 'Amount' });
  assert.equal(total['result'], 900 + 300 + 150);
  assert.equal(total['spoken'], '1350. That is the total of Amount across 3 rows. I left out the Total and Average rows.');
  const described = await call('table_describe', { table_id: 'home-budget' });
  assert.match(String(described['spoken']), /Its Total and Average rows are left out of answers\./);

  // Totals alone are still counted as before.
  const two = table('two totals', [['Item', 'Amount'], ['a', 1], ['b', 2], ['Subtotal', 3], ['c', 4], ['Total', 7]]);
  const twoCall = voice(buildIndex([two])).call;
  const r = await twoCall('table_query', { table_id: 'two-totals', aggregate: 'sum', aggregate_column: 'Amount' });
  assert.match(String(r['spoken']), /I left out 2 total rows\.$/);

  // "STT" numbers the rows, and is said to.
  const numbered = await call('table_query', { table_id: 'chi-tieu', aggregate: 'sum', aggregate_column: 'STT' });
  assert.equal(numbered['isError'], true);
  assert.match(String(numbered['spoken']), /^"STT" numbers the rows, so it cannot be totalled\./);

  // A full description says what could not be read as a number.
  const full = await call('table_describe', { table_id: 'unread', detail: 'full' });
  assert.match(String(full['spoken']), /Amount has 1 value I could not read as a number\./);
  assert.match(String(full['spoken']), /Score mixes text and numbers, so I cannot add it up\./);
});

// ── the bundled files' names ───────────────────────────────────────────────

const FIXTURES = ['01-flat.xlsx', '02-stacked-header.xlsx', '03-merged-header.xlsx', '04-title-and-vmerge.xlsx', '05-three-regions.xlsx', '06-countries.csv'];
const dir = await mkdtemp(join(tmpdir(), 'landmark-integrate2-'));
const { npm_config_out: _o, npm_config_titles: _t, ...baseEnv } = process.env;
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/ingest/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: baseEnv,
  });

test('the bundled index is exactly what the CLI builds from the fixtures and their titles', async () => {
  const out = join(dir, 'rebuilt.json');
  const run = cli(...FIXTURES.map((f) => `test/fixtures/${f}`), '--titles', 'test/fixtures/titles.json', '--out', out);
  assert.equal(run.status, 0, run.stderr);
  const timeless = (text: string) => JSON.stringify(JSON.parse(text), (k, v: unknown) => (k === 'ingestedAt' ? undefined : v));
  assert.equal(
    timeless(await readFile(out, 'utf8')),
    timeless(await readFile(join(ROOT, 'data', 'index.json'), 'utf8')),
    'data/index.json is stale: rebuild it with the command above',
  );
});

test('a titles file names files without touching their ids, and a misspelt name writes nothing', async () => {
  const titles = JSON.parse(await readFile(join(ROOT, 'test', 'fixtures', 'titles.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(titles), FIXTURES, 'one title for every bundled file');
  assert.deepEqual(
    bundled.tables.map((t) => [t.id, t.title]),
    FIXTURES.map((f) => [f.replace(/\.(xlsx|csv)$/, ''), titles[f]]),
  );

  const wrong = join(dir, 'wrong-titles.json');
  await writeFile(wrong, JSON.stringify({ '01-flat.xlsx': 'Sales data', '07-missing.xlsx': 'Nothing' }));
  const out = join(dir, 'never.json');
  const run = cli('test/fixtures/01-flat.xlsx', '--titles', wrong, '--out', out);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--titles names 07-missing\.xlsx, which is not one of the files read/);
  await assert.rejects(stat(out), 'nothing was written');

  const blank = join(dir, 'blank-titles.json');
  await writeFile(blank, JSON.stringify({ '01-flat.xlsx': '  ' }));
  const refused = cli('test/fixtures/01-flat.xlsx', '--titles', blank, '--out', out);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /must be text of 1 to 60 characters/);
  await assert.rejects(stat(out));
});

test('the opening listing names no test fixture, and the old names still open the files', async () => {
  const { say, open } = voice(bundled);
  await open('');
  const list = await say('what do I have');
  assert.doesNotMatch(list.spoken, /\b0\d [a-z]/, `a fixture's file name was read: ${list.spoken}`);
  assert.equal(list.spoken, 'You have Sales data, Quarterly data, Compare sheet, FY2026 Departmental Budget and Mixed sheet. There is 1 more.');
  assert.equal((await say('more')).spoken, 'You have Countries.');
  const opened: [string, string][] = [
    ['open the sales data', '01-flat'],
    ['open the compare sheet', '03-merged-header'],
    ['open the mixed sheet', '05-three-regions'],
    ['open the countries', '06-countries'],
    // As the files were called before, and as tests, bookmarks and people still call them.
    ['open 01 flat', '01-flat'],
    ['open the merged header file', '03-merged-header'],
    ['open the three regions file', '05-three-regions'],
    ['the stacked header one', '02-stacked-header'],
  ];
  for (const [phrase, id] of opened) {
    await open('');
    const t = await say(phrase);
    assert.equal(t.plan.tool, 'table_describe', `${phrase}: ${t.spoken}`);
    assert.equal(t.plan.args?.['table_id'], id, phrase);
  }
});
