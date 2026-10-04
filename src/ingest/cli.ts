/**
 * Ingest CLI.  npm run ingest -- <files...> [--out data/index.json]
 *
 * Deliberately boring and loud: it prints what it inferred for every region so a
 * mistaken header guess is visible here, on a screen, rather than discovered later
 * through a synthesised voice saying something wrong with confidence.
 *
 * Wildcards are expanded here rather than trusted to the shell, because PowerShell
 * and cmd.exe pass "*.xlsx" through untouched.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { readSpreadsheet } from './read.ts';
import { buildIndex, buildTable } from './build.ts';
import { expandPattern } from './glob.ts';
import type { IndexTable } from '../indexfmt.ts';

/**
 * The output path npm kept for itself, if it did.
 *
 * PowerShell drops an unquoted "--" before npm sees it, so in
 * `npm run ingest -- *.xlsx --out=mine.json` npm reads "--out=mine.json" as its own
 * setting and hands the script only the files. The script then wrote to the default,
 * data/index.json, and said so in one line nobody reads: someone indexing their own
 * spreadsheets beside the demo replaced the demo's index instead. npm does pass the
 * setting on, as npm_config_out, so the path they typed is still here to honour. (The
 * spaced form, "--out mine.json", arrives as an input and is caught further down.)
 */
function outFromNpm(): string | null {
  const v = process.env['npm_config_out'];
  return v && v !== 'true' && v !== 'false' ? v : null;
}

/** The titles file npm kept for itself, as it keeps --out (see outFromNpm). */
function titlesFromNpm(): string | null {
  const v = process.env['npm_config_titles'];
  return v && v !== 'true' && v !== 'false' ? v : null;
}

function parseArgs(argv: readonly string[]): { files: string[]; out: string; fromNpm: boolean; titles: string | null } {
  const files: string[] = [];
  let out: string | null = null;
  let titles: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out' || a === '-o') {
      const next = argv[++i];
      if (!next) throw new Error('--out needs a path.');
      out = next;
    } else if (a.startsWith('--out=')) {
      out = a.slice('--out='.length);
    } else if (a === '--titles') {
      const next = argv[++i];
      if (!next) throw new Error('--titles needs a path.');
      titles = next;
    } else if (a.startsWith('--titles=')) {
      titles = a.slice('--titles='.length);
    } else files.push(a);
  }
  titles ??= titlesFromNpm();
  if (out !== null) return { files, out, fromNpm: false, titles };
  const npmOut = outFromNpm();
  return npmOut ? { files, out: npmOut, fromNpm: true, titles } : { files, out: 'data/index.json', fromNpm: false, titles };
}

/** The longest title a file may be given: it is spoken in every listing of the files. */
const TITLE_CHARS = 60;

/**
 * Titles to speak for files, by file name: `{ "01-flat.xlsx": "Sales data" }`.
 *
 * A file is otherwise called by its file name, and a test fixture's file name is a
 * test fixture's: the page's opening listing read "You have 01 flat, 02 stacked header,
 * 03 merged header…" to everyone who opened it. A title changes what is said, never the
 * table's id, so a bookmark or a call by id still reaches the same table. Every name in
 * the file must be one of the inputs: a misspelt one would quietly leave the file name
 * in place, which is the thing the file is there to stop.
 */
async function readTitles(path: string): Promise<Map<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`--titles ${path} could not be read as JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--titles ${path} must hold one object, from file name to title.`);
  }
  const titles = new Map<string, string>();
  for (const [file, title] of Object.entries(parsed)) {
    const said = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    if (!said || said.length > TITLE_CHARS) {
      throw new Error(`--titles ${path}: the title for ${file} must be text of 1 to ${TITLE_CHARS} characters.`);
    }
    titles.set(file, said);
  }
  return titles;
}

function report(t: IndexTable): void {
  console.log(`\n${t.title}  [${t.format}, ${t.regions.length} region(s)]`);
  for (const r of t.regions) {
    const s = r.structure;
    console.log(`  ${r.id}${r.title ? ` "${r.title}"` : ''} — ${r.rowCount} rows x ${r.columns.length} cols`);
    // The score is the evidence for the chosen reading, 0..1 — not a share of anything.
    // How many heading rows, then where they are: "header rows: 5" for a one-row heading
    // on sheet row 5 read as a count of five.
    const n = r.headerRows.length;
    const where = n ? `${n} row${n === 1 ? '' : 's'} (sheet row${n === 1 ? '' : 's'} ${r.headerRows.map((k) => k + 1).join(', ')})` : 'none';
    console.log(
      `    header: ${where} — ${s.chosen.why} (evidence ${s.chosen.score.toFixed(2)})${s.confirmedBy ? ', confirmed' : ''}`,
    );
    if (s.ambiguous) {
      const alts = s.alternatives.map((a) => `${a.headerRows} header row(s): ${a.why}`).join('; ');
      console.log(`    AMBIGUOUS — could instead ${alts || '(no alternative offered)'}`);
    }
    for (const c of r.columns) {
      // Values that are not numbers in a number column are left out of every figure from
      // it; shown here, so a dropped "(2,300)" is seen on the screen, not heard later as
      // a total that is off by exactly that row.
      const skipped = c.nonNumeric ? `  non-numeric=${c.nonNumeric}` : '';
      // A number column with no total is the rows' own numbering ("STT"); said so, rather
      // than left looking like a column whose figures went missing.
      const extra =
        c.sum !== undefined
          ? `  sum=${c.sum}  range=${c.min}..${c.max}${skipped}`
          : c.identifier === 'row'
            ? '  numbers the rows, never totalled'
            : c.categories
              ? `  categories=${c.categories.slice(0, 6).join('|')}${c.categories.length > 6 ? '…' : ''}`
              : '';
      console.log(`      ${c.col}  ${c.spoken.padEnd(28)} ${c.kind.padEnd(9)} ${c.nonEmpty}/${c.nonEmpty + c.empty}${extra}`);
    }
    if (r.summaryRows?.length) {
      console.log(
        `    total and summary rows, left out of answers: ${r.summaryRows.map((i) => r.firstDataRow + i + 1).join(', ')}`,
      );
    }
    if (r.inherited.length) {
      console.log(`    ${r.inherited.length} cell(s) filled from merged labels, e.g. ${r.inherited.slice(0, 3).map((x) => `${x.at}<-${x.from}`).join(', ')}`);
    }
    if (r.ambiguousColumns.length) {
      console.log(`    AMBIGUOUS header paths at columns: ${r.ambiguousColumns.join(', ')}`);
    }
  }
  for (const w of t.warnings) console.log(`  ! ${w}`);
}

const { files: patterns, out, fromNpm, titles: titlesPath } = parseArgs(process.argv.slice(2));
if (patterns.length === 0) {
  console.error('usage: npm run ingest -- <file.xlsx|file.csv|pattern> [more…] [--out data/index.json] [--titles titles.json]');
  process.exit(2);
}
if (fromNpm) console.log(`output: ${out} (npm kept --out for itself and passed it on)`);

let titles = new Map<string, string>();
if (titlesPath !== null) {
  try {
    titles = await readTitles(titlesPath);
  } catch (err) {
    console.error(`\n${(err as Error).message}\nNothing written.`);
    process.exit(1);
  }
}

const files: string[] = [];
let failed = 0;
for (const p of patterns) {
  const matched = await expandPattern(p);
  if (matched.length === 0) {
    console.error(`\nNo files match ${p}`);
    failed++;
  }
  files.push(...matched);
}

const tables: IndexTable[] = [];
const titled = new Set<string>();
for (const f of files) {
  try {
    const built = buildTable(await readSpreadsheet(f));
    const title = titles.get(built.sourceName);
    if (title !== undefined) titled.add(built.sourceName);
    const table = title !== undefined ? { ...built, title } : built;
    tables.push(table);
    report(table);
  } catch (err) {
    console.error(`\n${f}: ${(err as Error).message}`);
    if (extname(f).toLowerCase() === '.json') {
      // What PowerShell does to `npm run ingest -- a.xlsx --out x.json`: it drops the
      // "--", npm keeps "--out" for itself, and the output path arrives as an input.
      console.error(
        `  If ${f} was meant as the output, npm took --out for itself. In PowerShell, quote the double dash: npm run ingest '--' <files> --out ${f}`,
      );
    }
    failed++;
  }
}

// A title for a file that was not read: misspelt, or for a file left out. Either way
// some file is about to be called by its file name after all.
for (const file of titles.keys()) {
  if (!titled.has(file)) {
    console.error(`\n--titles names ${file}, which is not one of the files read.`);
    failed++;
  }
}

// A partial index is worse than none: it silently replaces the one that worked, and
// in the case above it would overwrite the default path the person was avoiding.
if (failed) {
  console.error(`\nNothing written: ${failed} input(s) could not be read.`);
  process.exitCode = 1;
} else if (tables.length) {
  const json = JSON.stringify(buildIndex(tables), null, 1);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, json, 'utf8');
  const bytes = Buffer.byteLength(json, 'utf8');
  console.log(`\nwrote ${out}  (${tables.length} table(s), ${(bytes / 1024).toFixed(1)} KB)`);
}
