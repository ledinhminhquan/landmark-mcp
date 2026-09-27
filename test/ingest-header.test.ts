/**
 * Header inference on the everyday shapes an adversarial review found it losing.
 *
 * Each grid here was read wrongly and silently: a labelled table taken as headerless
 * with no doubt expressed, a staff list whose column names became a record, a roster
 * whose first person became a heading. The rule these tests hold the code to is the
 * one the module states: decide when the evidence decides, and when it does not, say
 * so and name the other reading.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyseHeader, detectHeaderRowCount, resolveMerges } from '../src/table/header.ts';
import { detectRegions } from '../src/table/infer.ts';
import { materialise } from '../src/table/materialise.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import type { MergeSpan } from '../src/table/model.ts';
import type { IndexRegion } from '../src/indexfmt.ts';

type Cell = string | number | boolean | null | Date;

function region(name: string, grid: Cell[][], merges: MergeSpan[] = []): IndexRegion {
  return buildTable({
    sourceName: `${name}.csv`,
    format: 'csv',
    sheets: [{ name, grid, merges }],
    warnings: [],
  }).regions[0]!;
}

const analyse = (grid: Cell[][], merges: MergeSpan[] = []) => {
  const r = detectRegions(grid)[0]!;
  return analyseHeader(resolveMerges(grid, merges), r.startRow, r.endRow, r.firstCol, r.lastCol, merges);
};

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const YEARS: Cell[][] = [
  ['Region', 2024, 2025, 2026],
  ['North', 100, 110, 120],
  ['South', 200, 210, 220],
];

const MONTHS: Cell[][] = [
  ['Department', utc('2024-01-01'), utc('2024-02-01'), utc('2024-03-01')],
  ['Engineering', 10, 20, 30],
  ['Design', 1, 2, 3],
  ['Ops', 4, 5, 6],
  ['Sales', 7, 8, 9],
  ['HR', 1, 1, 1],
];

const EMPLOYEES: Cell[][] = [
  ['Name', 'Department', 'Title', 'Email', 'Salary'],
  ['Anh', 'Engineering', 'Developer', 'anh@example.com', 52000],
  ['Bao', 'Operations', 'Manager', 'bao@example.com', 61000],
  ['Chi', 'Engineering', 'Developer', 'chi@example.com', 55000],
  ['Dung', 'People', 'Lead', 'dung@example.com', 58000],
];

// ── a label column beside years or dates ──────────────────────────────────

test('a label column beside year headings is reported as undecided, with the heading reading offered', () => {
  const r = region('years', YEARS);
  // Either reading could be right; what must never happen is choosing one quietly.
  assert.equal(r.structure.ambiguous, true, 'a total of 2324 was spoken as fact before');
  assert.ok(r.structure.alternatives.some((a) => a.headerRows === 1));
  assert.match(r.structure.alternatives[0]!.why, /years/);
});

test('month headings typed as dates are undecided too, and read as month names once confirmed', () => {
  const r = region('months', MONTHS);
  assert.equal(r.structure.ambiguous, true);
  assert.ok(r.structure.alternatives.some((a) => a.headerRows === 1));
  assert.match(r.structure.alternatives[0]!.why, /dates/);

  const corrected = materialise(r.allRows, r.startRow, r.firstCol, 1);
  assert.deepEqual(
    corrected.columns.map((c) => c.spoken),
    ['Department', 'January 2024', 'February 2024', 'March 2024'],
    'not "2024 01 01 t00:00:00 000 Z"',
  );
  assert.equal(corrected.rows.length, 5);
});

test('ordinary label-plus-number data stays confidently headerless', () => {
  // The heading reading is offered for years and dates because they look like labels;
  // a row of ordinary values does not, and asking about every such table would bury
  // the question that matters under ones that do not.
  for (const grid of [
    [['North', 100], ['South', 200], ['East', 300]],
    [['Alice', 30, 'Paris'], ['Bob', 40, 'London'], ['Cara', 50, 'Rome']],
    [['Alice', 1990], ['Bob', 1985], ['Cara', 1970]],
    // One amount that happens to fall between 1900 and 2100 is not a row of years.
    [['Rent', 2000], ['Food', 450], ['Gas', 120]],
    [['Rent', 2000, 'monthly'], ['Food', 450, 'weekly'], ['Gas', 120, 'weekly']],
  ] as Cell[][][]) {
    const r = region('data', grid);
    assert.deepEqual(r.headerRows, [], JSON.stringify(grid[0]));
    assert.equal(r.rowCount, grid.length, 'every row is a record');
    assert.equal(r.structure.ambiguous, false, JSON.stringify(grid[0]));
  }
});

test('a headerless numeric control keeps every row', () => {
  const r = region('numbers', [[1, 2], [3, 4], [5, 6]]);
  assert.equal(r.rowCount, 3);
  assert.deepEqual(r.headerRows, []);
});

// ── mostly-text tables ──────────────────────────────────────────────────────

test('a staff list with one numeric column keeps its header', () => {
  const r = region('staff', EMPLOYEES);
  assert.deepEqual(r.headerRows, [0], 'the header was read as a fifth employee');
  assert.equal(r.rowCount, 4);
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Name', 'Department', 'Title', 'Email', 'Salary']);
  assert.equal(r.columns[4]!.sum, 226000, 'Salary can be totalled');

  const resolved = resolveMerges(EMPLOYEES, []);
  assert.equal(detectHeaderRowCount(resolved, 0, 4, 0, 4), 1);
  const headless = EMPLOYEES.slice(1);
  assert.equal(detectHeaderRowCount(resolveMerges(headless, []), 0, 3, 0, 4), 0, 'and without it, none');
});

test('contact, task and inventory lists keep their headers', () => {
  const contacts = region('contacts', [
    ['Name', 'City', 'Country', 'Age'],
    ['Alice', 'Paris', 'France', 34],
    ['Bob', 'London', 'UK', 41],
    ['Cara', 'Rome', 'Italy', 29],
  ]);
  assert.deepEqual(contacts.headerRows, [0]);

  const tasks = region('tasks', [
    ['Task', 'Owner', 'Status', 'Notes', 'Due'],
    ['Write', 'Anh', 'open', 'draft first', '2026-01-02'],
    ['Test', 'Bao', 'done', 'all green', '2026-01-05'],
    ['Ship', 'Chi', 'open', 'after review', '2026-02-01'],
  ]);
  assert.deepEqual(tasks.headerRows, [0]);
  assert.equal(tasks.columns[4]!.kind, 'date');

  const inventory = region('inventory', [
    ['SKU name', 'Category', 'Colour', 'Size', 'Brand', 'Supplier', 'Season', 'Material', 'Fit', 'Origin', 'Qty'],
    ['Tee', 'Apparel', 'Red', 'M', 'Acme', 'North', 'SS', 'Cotton', 'Slim', 'VN', 10],
    ['Cap', 'Accessory', 'Blue', 'S', 'Acme', 'South', 'AW', 'Wool', 'One', 'CN', 4],
    ['Polo', 'Apparel', 'Green', 'L', 'Bolt', 'North', 'SS', 'Cotton', 'Regular', 'VN', 7],
    ['Scarf', 'Apparel', 'Grey', 'M', 'Bolt', 'East', 'AW', 'Wool', 'One', 'TH', 2],
  ]);
  assert.deepEqual(inventory.headerRows, [0]);
  assert.equal(inventory.rowCount, 4);
  assert.equal(inventory.columns[10]!.sum, 23);
});

test('a numeric column with a few text placeholders does not cost the table its header', () => {
  const r = region('placeholders', [
    ['Item', 'Amount', 'Owner'],
    ['a', '10', 'x'],
    ['b', '20', 'y'],
    ['c', '30', 'x'],
    ['d', '100', 'y'],
    ['e', 'TBD', 'x'],
    ['f', 'TBD', 'y'],
    ['g', 'N/A', 'x'],
    ['h', '40', 'y'],
  ]);
  assert.deepEqual(r.headerRows, [0], 'the header was counted as a ninth record');
  assert.equal(r.structure.ambiguous, false, 'labels over a column of amounts is clear');
  assert.equal(r.rowCount, 8);
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Item', 'Amount', 'Owner']);
  // The placeholders are gaps written as text: the column is still one of amounts.
  assert.equal(r.columns[1]!.kind, 'number', 'was "mixed", and could not be totalled');
  assert.equal(r.columns[1]!.sum, 200);
  assert.equal(r.columns[1]!.nonNumeric, 3);
});

// ── a blank top-left corner in an all-text table ────────────────────────────

test('a roster with a blank corner keeps its first person', () => {
  const r = region('roster', [
    [null, 'Mon', 'Tue'],
    ['Anh', 'Gym', 'Rest'],
    ['Bao', 'Run', 'Swim'],
    ['Chi', 'Yoga', 'Walk'],
  ]);
  assert.deepEqual(r.headerRows, [0], 'Anh was eaten into the headings');
  assert.equal(r.rowCount, 3);
  assert.deepEqual(r.rows.map((row) => row[0]), ['Anh', 'Bao', 'Chi']);
  assert.deepEqual(r.columns.map((c) => c.path), [[], ['Mon'], ['Tue']]);
});

test('a text table with a blank last heading keeps its first record', () => {
  const r = region('names', [
    ['Name', 'City', null],
    ['Alice', 'Paris', 'x'],
    ['Bob', 'London', 'y'],
    ['Cara', 'Rome', 'z'],
  ]);
  assert.deepEqual(r.columns.map((c) => c.path), [['Name'], ['City'], []]);
  assert.equal(r.rowCount, 3);
});

test('a sparse line over a text table is not decided by fullness, and both readings are available', () => {
  // Two cells of title over a full row of labels. Without typed values nothing says
  // which row names the columns; what must not happen is a silent choice.
  const r = region('staff', [
    ['Staff list', 'v2', null, null],
    ['Name', 'City', 'Role', 'Team'],
    ['Alice', 'Paris', 'Lead', 'Ops'],
    ['Bob', 'London', 'Dev', 'Web'],
  ]);
  assert.equal(r.structure.ambiguous, true);
  const readings = [r.structure.chosen, ...r.structure.alternatives].map((a) => a.headerRows);
  assert.ok(readings.includes(2), 'the reading that names the columns is offered');
  assert.ok(readings.includes(1));
});

test('a label row with blanks in a text table keeps its labels and every record', () => {
  // Two unlabelled columns at the left of a roster.
  const roster = region('roster', [
    [null, null, 'Mon', 'Tue'],
    ['Anh', 'A', 'Gym', 'Rest'],
    ['Bao', 'B', 'Run', 'Swim'],
    ['Chi', 'C', 'Yoga', 'Walk'],
  ]);
  assert.deepEqual(roster.headerRows, [0], 'was read as headerless: no column names at all');
  assert.equal(roster.rowCount, 3);
  assert.deepEqual(roster.columns.map((c) => c.path), [[], [], ['Mon'], ['Tue']]);

  // Labels for the first two columns only.
  const contacts = region('contacts', [
    ['Name', 'Email', null, null],
    ['Anh', 'a@example.com', 'Hanoi', 'Vietnam'],
    ['Bao', 'b@example.com', 'Hue', 'Vietnam'],
    ['Chi', 'c@example.com', 'Paris', 'France'],
  ]);
  assert.deepEqual(contacts.headerRows, [0]);
  assert.equal(contacts.rowCount, 3);
  assert.deepEqual(contacts.columns.map((c) => c.spoken).slice(0, 2), ['Name', 'Email']);
  // Unsure either way in a text-only table, so the other readings are there to take.
  assert.equal(contacts.structure.ambiguous, true);
  assert.ok(contacts.structure.alternatives.some((a) => a.headerRows === 0));
});

test('group labels exported to CSV from a merged heading are a heading level', async () => {
  // Excel writes a merged "Contact" over two columns as "Contact," — the label, then a
  // blank for each further column it covers.
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readSpreadsheet } = await import('../src/ingest/read.ts');
  const path = join(await mkdtemp(join(tmpdir(), 'landmark-header-')), 'contacts.csv');
  await writeFile(
    path,
    'Contact,,Location,\nName,Email,City,Country\nAnh,a@example.com,Hanoi,Vietnam\nBao,b@example.com,Hue,Vietnam\nChi,c@example.com,Paris,France\n',
  );
  const r = buildTable(await readSpreadsheet(path)).regions[0]!;
  assert.deepEqual(r.headerRows, [0, 1], 'was read as headerless, with five records and no names');
  assert.equal(r.rowCount, 3);
  // Each label covers the blank after it, as the merge it was exported from did.
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Contact, Name', 'Contact, Email', 'Location, City', 'Location, Country']);
  assert.equal(r.structure.ambiguous, true);
  assert.equal(r.structure.alternatives[0]!.headerRows, 1, 'the one-row reading is offered first');
});

test('an unsure multi-row reading offers the one-row reading', () => {
  // A merged group label over a text table: the merge is structural evidence for two
  // heading rows, but the text gives nothing to confirm it.
  const grid: Cell[][] = [
    ['Contact', 'Contact', 'Role'],
    ['Name', 'Email', 'Team'],
    ['Alice', 'a@example.com', 'Ops'],
    ['Bob', 'b@example.com', 'Sales'],
  ];
  const merges: MergeSpan[] = [{ value: 'Contact', topRow: 0, bottomRow: 0, leftCol: 0, rightCol: 1, a1: 'A1' }];
  const a = analyse(grid, merges);
  assert.equal(a.chosen.rows, 2);
  assert.equal(a.ambiguous, true);
  assert.equal(a.alternatives[0]!.rows, 1, 'the commonest reading comes first');
});

// ── the promise every ambiguous reading makes ───────────────────────────────

test('an uncertain reading always names something else it could be', () => {
  const grids: Cell[][][] = [
    YEARS,
    MONTHS,
    EMPLOYEES,
    [['Name', 'City'], ['Alice', 'Paris'], ['Bob', 'London']],
    [['Alice', 'Paris'], ['Bob', 'London'], ['Cara', 'Rome'], ['Dan', 'Hanoi']],
    [[2024, 2025], [1, 2], [3, 4]],
    [['only one row']],
    [[null, 'Mon', 'Tue'], ['Anh', 'Gym', 'Rest'], ['Bao', 'Run', 'Swim']],
    [['Note', 'Status'], ['Q3 close', 'pending']],
  ];
  for (const grid of grids) {
    const r = region('any', grid);
    if (r.structure.ambiguous) {
      assert.ok(r.structure.alternatives.length > 0, `"I could instead ." for ${JSON.stringify(grid[0])}`);
      for (const alt of r.structure.alternatives) {
        assert.notEqual(alt.headerRows, r.structure.chosen.headerRows);
        assert.ok(alt.why.length > 0);
      }
    }
  }
});

// ── the correction, over the wire ───────────────────────────────────────────

const handler = createHandler({
  index: buildIndex([
    buildTable({ sourceName: 'plan.csv', format: 'csv', sheets: [{ name: 'plan', grid: MONTHS, merges: [] }], warnings: [] }),
    buildTable({ sourceName: 'regions.csv', format: 'csv', sheets: [{ name: 'regions', grid: YEARS, merges: [] }], warnings: [] }),
  ]),
});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': 'ingest-header-test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } };
  return body.result.structuredContent;
}

test('describing the year table says it is unsure, and the correction gives the right total', async () => {
  const d = await call('table_describe', { table_id: 'regions' });
  assert.match(String(d['spoken']), /not certain/i);

  await call('table_structure', { table_id: 'regions', header_rows: 1 });
  const q = await call('table_query', { table_id: 'regions', aggregate: 'sum', aggregate_column: '2024' });
  assert.equal(q['result'], 300);
});

test('after the correction, month columns are named as months', async () => {
  const fixed = await call('table_structure', { table_id: 'plan', header_rows: 1 });
  assert.deepEqual(fixed['columns'], ['Department', 'January 2024', 'February 2024', 'March 2024']);
  const q = await call('table_query', { table_id: 'plan', aggregate: 'sum', aggregate_column: 'January 2024' });
  assert.equal(q['result'], 23);
});

// ── deeper and exported stacked headings ────────────────────────────────────

test('a four-level heading is read whole, not as two levels over two records', () => {
  // FY / Revenue / 2025, 2026 / H1, H2, merged the way a finance report merges them.
  const grid: Cell[][] = [
    ['Region', 'FY', 'FY', 'FY', 'FY'],
    ['Region', 'Revenue', 'Revenue', 'Revenue', 'Revenue'],
    ['Region', 2025, 2025, 2026, 2026],
    ['Region', 'H1', 'H2', 'H1', 'H2'],
    ['North', 1, 2, 3, 4],
    ['South', 5, 6, 7, 8],
  ];
  const span = (topRow: number, bottomRow: number, leftCol: number, rightCol: number): MergeSpan => ({
    value: grid[topRow]![leftCol]!,
    topRow,
    bottomRow,
    leftCol,
    rightCol,
    a1: `${String.fromCharCode(65 + leftCol)}${topRow + 1}`,
  });
  const r = region('m4', grid, [span(0, 3, 0, 0), span(0, 0, 1, 4), span(1, 1, 1, 4), span(2, 2, 1, 2), span(2, 2, 3, 4)]);
  assert.deepEqual(r.headerRows, [0, 1, 2, 3], 'was [0, 1], with "2025" and "H1" read as records');
  assert.equal(r.rowCount, 2);
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Region', 'FY, Revenue, 2025, H1', 'FY, Revenue, 2025, H2', 'FY, Revenue, 2026, H1', 'FY, Revenue, 2026, H2']);
  assert.equal(r.columns[4]!.sum, 12);
});

test('read too shallow, a heading block leaves columns that share a heading and mix text with numbers', () => {
  // Read two rows deep, the lower heading rows land among the records. Ingest takes
  // exactly this mark as doubt, and offers one more heading row.
  const m = materialise(
    [
      ['Region', 'FY', 'FY', 'FY', 'FY'],
      ['Region', 'Revenue', 'Revenue', 'Revenue', 'Revenue'],
      ['Region', 'H1', 'H2', 'H1', 'H2'],
      ['North', 1, 2, 3, 4],
      ['South', 5, 6, 7, 8],
    ],
    0,
    0,
    2,
  );
  assert.ok(m.ambiguousColumns.length > 0);
  assert.ok(m.ambiguousColumns.some((i) => m.columns[i]!.kind === 'mixed'));
});

test('a heading block exported to CSV keeps each group label over every column it covers', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readSpreadsheet } = await import('../src/ingest/read.ts');
  const path = join(await mkdtemp(join(tmpdir(), 'landmark-header-')), 'stacked.csv');
  await writeFile(path, ',2026,,2025,\n,Q1,Q2,Q1,Q2\nRegion,Revenue,Revenue,Revenue,Revenue\nNorth,1,2,3,4\nSouth,5,6,7,8\n');
  const r = buildTable(await readSpreadsheet(path)).regions[0]!;
  assert.deepEqual(r.columns.map((c) => c.spoken), [
    'Region',
    '2026, Q1, Revenue',
    '2026, Q2, Revenue',
    '2025, Q1, Revenue',
    '2025, Q2, Revenue',
  ], 'the second of each group was "Q2 Revenue" and "Q2 Revenue 2"');
  assert.deepEqual(r.ambiguousColumns, []);
});
