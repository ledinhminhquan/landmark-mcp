/**
 * Structure inference, and the path that lets a person correct it.
 *
 * These replace an earlier probe that asserted the *buggy* outputs — it pinned the
 * behaviour where a four-line address book came back with one record and full
 * confidence. Keeping a test that expects a defect only makes the defect harder to
 * remove, so every assertion here states what the code should do.
 *
 * The cases come from an adversarial review of this module. Each one is a shape the
 * inference got wrong, and the ones that remain genuinely undecidable are asserted as
 * *ambiguous* rather than as a particular answer, because pretending to know is the
 * failure this work exists to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyseHeader, resolveMerges } from '../src/table/header.ts';
import { detectRegions } from '../src/table/infer.ts';
import { materialise } from '../src/table/materialise.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import type { IndexTable } from '../src/indexfmt.ts';

type Cell = string | number | boolean | null;

function ingest(name: string, grid: Cell[][]): IndexTable {
  return buildTable({
    sourceName: `${name}.csv`,
    format: 'csv',
    sheets: [{ name, grid, merges: [] }],
    warnings: [],
  });
}

const analyse = (grid: Cell[][]) => {
  const resolved = resolveMerges(grid, []);
  const r = detectRegions(grid)[0]!;
  return analyseHeader(resolved, r.startRow, r.endRow, r.firstCol, r.lastCol, []);
};

// ── records must survive inference ──────────────────────────────────────────

test('a labelled all-text table keeps every record', () => {
  // Previously: three rows were eaten into the column names, one person survived,
  // and the region reported confidence 1.
  const t = ingest('address_book', [
    ['Name', 'City'],
    ['Alice', 'Paris'],
    ['Bob', 'London'],
    ['Cara', 'Rome'],
  ]);
  const r = t.regions[0]!;

  assert.equal(r.rowCount, 3, 'Alice, Bob and Cara are records, not column names');
  assert.deepEqual(r.headerRows, [0]);
  assert.deepEqual(
    r.columns.map((c) => c.path),
    [['Name'], ['City']],
  );
  assert.deepEqual(
    r.rows.map((row) => row[0]),
    ['Alice', 'Bob', 'Cara'],
  );
});

test('an all-text table admits it cannot be sure, and says what else it could be', () => {
  const a = analyse([
    ['Name', 'City'],
    ['Alice', 'Paris'],
    ['Bob', 'London'],
  ]);
  assert.equal(a.chosen.rows, 1);
  assert.equal(a.ambiguous, true, 'text over text gives the type signal nothing to work with');
  assert.ok(
    a.alternatives.some((alt) => alt.rows === 0),
    'the listener must be offered the reading where no row is a heading',
  );
});

test('a headerless export loses no more than the one row it cannot distinguish', () => {
  // Genuinely undecidable from the values: this is the same shape as the table above
  // with its header removed. The contract is that it stays ambiguous and correctable,
  // not that inference magically resolves it.
  const t = ingest('export', [
    ['Alice', 'Paris'],
    ['Bob', 'London'],
    ['Cara', 'Rome'],
    ['Dan', 'Hanoi'],
  ]);
  const r = t.regions[0]!;
  assert.equal(r.rowCount, 3);
  assert.equal(r.structure.ambiguous, true);
  assert.ok(r.structure.alternatives.some((alt) => alt.headerRows === 0));
});

test('numeric year headings are reported as undecided rather than guessed', () => {
  const t = ingest('years', [
    [2024, 2025, 2026],
    [100, 110, 120],
    [200, 210, 220],
  ]);
  const r = t.regions[0]!;
  assert.equal(r.structure.ambiguous, true);
  assert.ok(
    r.structure.alternatives.some((alt) => alt.headerRows === 1),
    'a row of years is a plausible heading and must be offered',
  );
});

// ── regions ─────────────────────────────────────────────────────────────────

test('two tables separated by a blank column are not merged into one', () => {
  const regions = detectRegions([
    ['Item', 'Qty', null, 'Invoice', 'Total'],
    ['Bolt', 1, null, 'X', 100],
    ['Nut', 2, null, 'Y', 200],
  ]);
  assert.equal(regions.length, 2, 'an item list and an invoice list share only a row number');
  assert.deepEqual(
    regions.map((r) => [r.firstCol, r.lastCol]),
    [
      [0, 1],
      [3, 4],
    ],
  );
});

test('a column blank only in the heading row is not a separator', () => {
  // A title row above a table leaves plenty of gaps; splitting on those would break
  // every real spreadsheet.
  const regions = detectRegions([
    [null, 'Revenue', 'Cost'],
    ['North', 10, 4],
    ['South', 20, 6],
  ]);
  assert.equal(regions.length, 1);
});

// ── confidence must mean something ──────────────────────────────────────────

test('confidence is evidence for the reading, not the share of columns with a name', () => {
  const confident = ingest('flat', [
    ['Region', 'Revenue'],
    ['North', 10],
    ['South', 20],
  ]).regions[0]!;
  const unsure = ingest('text', [
    ['Name', 'City'],
    ['Alice', 'Paris'],
    ['Bob', 'London'],
  ]).regions[0]!;

  assert.equal(confident.structure.ambiguous, false);
  assert.equal(unsure.structure.ambiguous, true);
  assert.ok(
    confident.structure.chosen.score > unsure.structure.chosen.score,
    'a table whose labels sit over typed values is better evidenced than one that cannot show it',
  );
  // Both name every column, which is exactly why the old measure could not tell them apart.
  assert.ok(confident.columns.every((c) => c.path.length > 0));
  assert.ok(unsure.columns.every((c) => c.path.length > 0));
});

test('the structure record always matches the columns that were actually built', () => {
  for (const grid of [
    [['Region', 'Revenue'], ['North', 10]],
    [[2024, 2025], [1, 2], [3, 4]],
    [['only one row']],
  ] as Cell[][][]) {
    const r = ingest('x', grid).regions[0]!;
    assert.equal(
      r.structure.chosen.headerRows,
      r.headerRows.length,
      `structure claims ${r.structure.chosen.headerRows} heading rows but ${r.headerRows.length} were used`,
    );
    assert.ok(r.rowCount > 0, 'no reading may leave a region with no records');
  }
});

// ── re-reading under a correction ───────────────────────────────────────────

test('materialise re-reads the same rows under a different heading count', () => {
  const rows: Cell[][] = [
    [2024, 2025, 2026],
    [100, 110, 120],
    [200, 210, 220],
  ];
  const asData = materialise(rows, 0, 0, 0);
  assert.equal(asData.rows.length, 3);
  assert.equal(asData.columns[0]!.sum, 2324, 'every row counted, years included');

  const asHeader = materialise(rows, 0, 0, 1);
  assert.equal(asHeader.rows.length, 2);
  assert.deepEqual(asHeader.columns[0]!.path, ['2024']);
  assert.equal(asHeader.columns[0]!.sum, 300, 'the year is a label, so only 100 and 200 count');
});

test('a header block that would leave no records is refused, not applied', () => {
  const m = materialise([['a', 'b'], ['c', 'd']], 0, 0, 5);
  assert.ok(m.rows.length >= 1, 'clamped rather than producing an empty table');
});

// ── the correction path, over the wire ──────────────────────────────────────

const handler = createHandler({ index: buildIndex([ingest('years', [
  [2024, 2025, 2026],
  [100, 110, 120],
  [200, 210, 220],
])]) });

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } };
  return body.result.structuredContent;
}

test('describing an uncertain table says so out loud', async () => {
  const d = await call('table_describe', { table_id: 'years' });
  assert.match(String(d['spoken']), /not certain/i);
  assert.match(String(d['spoken']), /check the structure/i);
});

test('a spoken correction re-reads the table and changes the answer', async () => {
  const before = await call('table_query', {
    table_id: 'years',
    aggregate: 'sum',
    aggregate_column: 'column 1',
  });
  assert.equal(before['result'], 2324, 'the year is being counted as data');

  const fixed = await call('table_structure', { table_id: 'years', header_rows: 1 });
  assert.equal(fixed['header_rows'], 1);
  assert.equal(fixed['data_rows'], 2);
  assert.match(String(fixed['spoken']), /2 rows of data/);

  const after = await call('table_query', {
    table_id: 'years',
    aggregate: 'sum',
    aggregate_column: '2024',
  });
  assert.equal(after['result'], 300, 'the corrected reading is used by every later answer');
});

test('explaining an answer given under an older reading says the reading changed', async () => {
  const q = await call('table_query', {
    table_id: 'years',
    aggregate: 'sum',
    aggregate_column: '2024',
  });
  await call('table_structure', { table_id: 'years', header_rows: 0 });
  const e = await call('table_explain', { answer_id: q['answer_id'] });

  assert.equal(e['structure_changed_since'], true);
  assert.match(String(e['spoken']), /changed how this table is read/i);
});

test('inspecting the structure reports the reading and its alternatives', async () => {
  const s = await call('table_structure', { table_id: 'years' });
  assert.equal(typeof s['header_rows'], 'number');
  assert.equal(typeof s['why'], 'string');
  assert.ok(Array.isArray(s['alternatives']));
  assert.ok(!/table_|_id\b|json/i.test(String(s['spoken'])), 'nothing internal reaches a speaker');
});

test('a correction that would empty the table is refused with a next step', async () => {
  const r = await call('table_structure', { table_id: 'years', header_rows: 3 });
  assert.match(String(r['spoken']), /only has 3 rows|smaller number/i);
});
