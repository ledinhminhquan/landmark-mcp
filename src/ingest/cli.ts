/**
 * Ingest CLI.  npm run ingest -- <files...> [--out data/index.json]
 *
 * Deliberately boring and loud: it prints what it inferred for every region so a
 * mistaken header guess is visible here, on a screen, rather than discovered later
 * through a synthesised voice saying something wrong with confidence.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readSpreadsheet } from './read.ts';
import { buildIndex, buildTable } from './build.ts';
import type { IndexTable } from '../indexfmt.ts';

function parseArgs(argv: readonly string[]): { files: string[]; out: string } {
  const files: string[] = [];
  let out = 'data/index.json';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out' || a === '-o') {
      const next = argv[++i];
      if (!next) throw new Error('--out needs a path.');
      out = next;
    } else files.push(a);
  }
  return { files, out };
}

function report(t: IndexTable): void {
  console.log(`\n${t.title}  [${t.format}, ${t.regions.length} region(s)]`);
  for (const r of t.regions) {
    const conf = Math.round(r.headerConfidence * 100);
    console.log(`  ${r.id}${r.title ? ` "${r.title}"` : ''} — ${r.rowCount} rows x ${r.columns.length} cols`);
    console.log(
      `    header rows: ${r.headerRows.length ? r.headerRows.map((n) => n + 1).join(', ') : 'none detected'} (${conf}% of columns labelled)`,
    );
    for (const c of r.columns) {
      const extra =
        c.sum !== undefined
          ? `  sum=${c.sum}  range=${c.min}..${c.max}`
          : c.categories
            ? `  categories=${c.categories.slice(0, 6).join('|')}${c.categories.length > 6 ? '…' : ''}`
            : '';
      console.log(`      ${c.col}  ${c.spoken.padEnd(28)} ${c.kind.padEnd(9)} ${c.nonEmpty}/${c.nonEmpty + c.empty}${extra}`);
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

const { files, out } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error('usage: npm run ingest -- <file.xlsx|file.csv> [more…] [--out data/index.json]');
  process.exit(2);
}

const tables: IndexTable[] = [];
for (const f of files) {
  try {
    const table = buildTable(await readSpreadsheet(f));
    tables.push(table);
    report(table);
  } catch (err) {
    console.error(`\n${f}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

if (tables.length) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(buildIndex(tables), null, 1), 'utf8');
  const bytes = JSON.stringify(buildIndex(tables)).length;
  console.log(`\nwrote ${out}  (${tables.length} table(s), ${(bytes / 1024).toFixed(1)} KB)`);
}
