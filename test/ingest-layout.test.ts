/**
 * Layout: what is a table, what is its title, what is a note, and what is it called.
 *
 * A source line under a table became a record or a table of its own; a heading with
 * a blank corner became the title and left both columns unnamed; two files, or two
 * sheets, that slugged alike shared one id, so a bookmark on one resumed on the other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { readSpreadsheet } from '../src/ingest/read.ts';
import { slugify, slugifySheet } from '../src/indexfmt.ts';
import { runQuery } from '../src/query/engine.ts';
import { speakDescribe } from '../src/voice/speak.ts';
import type { IndexTable } from '../src/indexfmt.ts';

type Cell = string | number | boolean | null;

function table(name: string, ...sheets: [string, Cell[][]][]): IndexTable {
  return buildTable({
    sourceName: `${name}.xlsx`,
    format: 'xlsx',
    sheets: sheets.map(([sheet, grid]) => ({ name: sheet, grid, merges: [] })),
    warnings: [],
  });
}

const dir = await mkdtemp(join(tmpdir(), 'landmark-layout-'));

test('a source line typed straight under a table is a note, not a record', async () => {
  const path = join(dir, 'footnote-attached.csv');
  await writeFile(path, 'Department,Amount\nEngineering,100\nDesign,50\nOps,25\nSource: finance export 2026-09\n');
  const t = buildTable(await readSpreadsheet(path));
  const r = t.regions[0]!;
  assert.equal(r.rowCount, 3, 'was 4, with an empty Amount');
  assert.equal(r.columns[1]!.empty, 0);
  assert.equal(t.regions.length, 1);
  assert.ok(t.warnings.some((w) => /Source: finance export 2026-09/.test(w)), 'and it is kept, where describe reports it');
});

test('a sentence under a table is a note, but a record with a long name and no values is still a record', () => {
  const noted = table('noted', ['Sheet1', [
    ['Product', 'Units'],
    ['Widget', 120],
    ['Gadget', 45],
    ['Figures are provisional until the audit closes.', null],
  ]]).regions[0]!;
  assert.equal(noted.rowCount, 2);

  // Cutting a record is the worse mistake: nothing can bring it back. These are the
  // last records of their tables, not notes.
  const companies = table('companies', ['Sheet1', [
    ['Company', 'Revenue', 'Employees'],
    ['Acme', 100, 10],
    ['Globex', 200, 20],
    ['International Business Machines', null, null],
  ]]).regions[0]!;
  assert.equal(companies.rowCount, 3, 'count said "2 rows match"');

  const tasks = table('tasks', ['Sheet1', [
    ['Task', 'Owner', 'Due'],
    ['Pay rent', 'Anh', '2026-10-01'],
    ['Renew insurance', 'Bao', '2026-10-05'],
    ['Book movers', 'Chi', '2026-10-09'],
    ['Follow up with the landlord about the lease renewal', null, null],
  ]]).regions[0]!;
  assert.equal(tasks.rowCount, 4);

  const sparse = table('sparse', ['Sheet1', [
    ['Product', 'Units'],
    ['Widget', 120],
    ['Gadget', 45],
    ['Sprocket', null],
  ]]).regions[0]!;
  assert.equal(sparse.rowCount, 3, 'a product with no units yet is a product');

  const listing = table('listing', ['Sheet1', [['Name'], ['Alice'], ['Bob'], ['Note: Carol joins in May']]]).regions[0]!;
  assert.equal(listing.rowCount, 3, 'a one-column list keeps everything; nothing marks it off as a note');
});

test('a note after a blank line is not announced as a second table', () => {
  const t = table('countries', ['Countries', [
    ['Country', 'Population'],
    ['Vietnam', 100352192],
    ['Kenya', 55100586],
    [null, null],
    ['Source: illustrative figures for testing only', null],
  ]]);
  assert.equal(t.regions.length, 1);
  assert.ok(!t.warnings.some((w) => /separate tables/.test(w)));
  assert.ok(t.warnings.some((w) => /illustrative figures/.test(w)));
});

test('a title above a blank line names the table under it', () => {
  const t = table('budget', ['Sheet1', [
    ['FY2026 Budget', null],
    [null, null],
    ['Department', 'Amount'],
    ['Engineering', 100],
    ['Ops', 50],
  ]]);
  assert.equal(t.regions.length, 1, 'the title was "table 1", a one-cell table hiding the real one');
  const r = t.regions[0]!;
  assert.equal(r.title, 'FY2026 Budget');
  assert.equal(r.id, 'sheet1.t1');
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Department', 'Amount']);
  assert.equal(r.columns[1]!.sum, 150);
});

test('a sheet that holds a single line keeps it as its table', () => {
  const t = table('stub', ['Sheet1', [['only one row']]]);
  assert.equal(t.regions.length, 1);
  assert.equal(t.regions[0]!.rowCount, 1);
});

test('a heading beside a blank corner is a heading, not a title', async () => {
  // Every pandas Series written with its index has this shape.
  const path = join(dir, 'blank-first-header.csv');
  await writeFile(path, ',Amount\nNorth,10\nSouth,20\nEast,30\n');
  const r = buildTable(await readSpreadsheet(path)).regions[0]!;
  assert.equal(r.title, null, 'was titled "Amount"');
  assert.deepEqual(r.columns.map((c) => c.path), [[], ['Amount']]);
  assert.equal(r.columns[1]!.sum, 60);
  assert.equal(r.rowCount, 3);
});

test('a short title at the left of a wide table is still a title', () => {
  const r = table('sales', ['Sales', [
    ['Q3 Regional Sales', null, null],
    ['Region', 'Rep', 'Revenue'],
    ['North', 'Anh', 12400],
    ['South', 'Chi', 21000],
  ]]).regions[0]!;
  assert.equal(r.title, 'Q3 Regional Sales');
});

test('sheet ids are unique, whatever the names slug to', () => {
  assert.equal(slugifySheet('Q1.2025'), 'q1-2025', 'a sheet name has no extension to strip');
  assert.equal(slugify('Q3 Sales (final).xlsx'), 'q3-sales-final', 'a file name still does');
  assert.equal(slugifySheet('Tổng hợp đơn hàng'), 'tong-hop-don-hang');

  const t = table(
    'many',
    ['Q1 2025', [['Region', 'Sales'], ['North', 1], ['South', 2]]],
    ['Q1-2025', [['Region', 'Sales'], ['North', 3], ['South', 4]]],
    ['売上', [['Region', 'Sales'], ['North', 5], ['South', 6]]],
    ['予算', [['Region', 'Sales'], ['North', 7], ['South', 8]]],
  );
  const ids = t.regions.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(', '));
  assert.deepEqual(ids, ['q1-2025.t1', 'q1-2025-2.t1', 'sheet.t1', 'sheet-2.t1']);
});

test('two files with the same name get different table ids', () => {
  const xlsx = table('Budget', ['Budget', [['Department', 'Amount'], ['Eng', 1], ['Ops', 2]]]);
  const csv = buildTable({
    sourceName: 'budget.csv',
    format: 'csv',
    sheets: [{ name: 'budget', grid: [['Department', 'Amount'], ['Eng', 3], ['Ops', 4]], merges: [] }],
    warnings: [],
  });
  const index = buildIndex([xlsx, csv]);
  assert.deepEqual(index.tables.map((t) => t.id), ['budget', 'budget-2']);
  assert.ok(index.tables[1]!.warnings.some((w) => /budget-2/.test(w)), 'and the renamed one says why');
  assert.equal(index.tables[0], xlsx, 'the first keeps its id and is untouched');
  // Spoken, the two were "Budget, Budget", and naming either reached the first.
  assert.deepEqual(index.tables.map((t) => t.title), ['Budget', 'Budget (CSV)']);
});

// ── a report's heading block, and a table split by a spacer column ──────────

test('a heading block of several lines above a blank row is the title of the table under it', () => {
  // The standard Vietnamese report header: company, report title, a blank row, the table.
  const t = table('bao-cao', ['Báo cáo', [
    ['CÔNG TY TNHH ABC', null, null, null],
    ['BÁO CÁO DOANH THU THÁNG 9/2026', null, null, null],
    [null, null, null, null],
    ['STT', 'Tên hàng', 'Số lượng', 'Thành tiền'],
    [1, 'Cà phê', 120, 4200000],
    [2, 'Trà', 85, 3825000],
    [3, 'Bánh mì', 200, 5000000],
    ['TỔNG CỘNG', null, 405, 13025000],
  ]]);
  assert.equal(t.regions.length, 1, 'table 1 was a one-column table called "Công TY tnhh ABC"');
  const r = t.regions[0]!;
  // The line that names the report is its title; the company that issued it is a note.
  assert.equal(r.title, 'BÁO CÁO DOANH THU THÁNG 9/2026', 'was "CÔNG TY TNHH ABC"');
  assert.equal(r.id, 'bao-cao.t1');
  assert.equal(r.columns[3]!.sum, 13025000);
  assert.ok(t.warnings.some((w) => /CÔNG TY TNHH ABC/.test(w)), 'the company line is kept as a note');
  assert.ok(!t.warnings.some((w) => /separate tables/.test(w)));

  // A merged title and a merged unit line, as Excel's "Merge & Center" writes them.
  const merged = buildTable({
    sourceName: 'bao-cao-2.xlsx',
    format: 'xlsx',
    sheets: [{
      name: 'BC',
      grid: [
        ['BÁO CÁO CHI PHÍ QUÝ 3', 'BÁO CÁO CHI PHÍ QUÝ 3', 'BÁO CÁO CHI PHÍ QUÝ 3'],
        ['Đơn vị tính: đồng', 'Đơn vị tính: đồng', 'Đơn vị tính: đồng'],
        [null, null, null],
        ['Khoản mục', 'Kế hoạch', 'Thực hiện'],
        ['Lương', 300000000, 310000000],
        ['Marketing', 50000000, 42500000],
      ],
      merges: [0, 1].map((row) => ({ value: null, topRow: row, bottomRow: row, leftCol: 0, rightCol: 2, a1: `A${row + 1}` })),
    }],
    warnings: [],
  });
  assert.equal(merged.regions.length, 1, 'table 1 was "1 row and 3 columns" of the unit line');
  assert.equal(merged.regions[0]!.title, 'BÁO CÁO CHI PHÍ QUÝ 3');
  assert.deepEqual(merged.regions[0]!.columns.map((c) => c.spoken), ['Khoản mục', 'Kế hoạch', 'Thực hiện']);
  assert.ok(merged.warnings.some((w) => /Đơn vị tính: đồng/.test(w)));
});

test('a second title line straight above the headings is a note, not a heading level', () => {
  const r = table('report', ['Report', [
    ['Acme Corp', null, null],
    ['Regional Sales, Q3 2026', null, null],
    ['Region', 'Units', 'Revenue'],
    ['North', 120, 24000],
    ['South', 80, 16000],
  ]]);
  // The company that issued the report is not its title, and is kept as a note.
  assert.equal(r.regions[0]!.title, 'Regional Sales, Q3 2026', 'was "Acme Corp"');
  assert.deepEqual(r.regions[0]!.columns.map((c) => c.spoken), ['Region', 'Units', 'Revenue'], 'was "Regional Sales, Q3 2026, Region"');
  assert.ok(r.warnings.some((w) => /Acme Corp/.test(w)));
});

test('a block of lines that heads no table stays a table', () => {
  // A one-column list under another table is a list, not a title.
  const t = table('lists', ['Sheet1', [
    ['Department', 'Amount'],
    ['Eng', 100],
    [null, null],
    ['Team'],
    ['Anh'],
    ['Bao'],
  ]]);
  assert.equal(t.regions.length, 2);
  assert.equal(t.regions[1]!.rowCount, 2);
});

test('a spacer column inside a table does not split it in two', () => {
  const t = table('spacer', ['Report', [
    ['Region', 'Sales 2025', 'Sales 2026', null, 'Growth'],
    ['North', 100, 120, null, '20%'],
    ['South', 200, 190, null, '-5%'],
    ['East', 50, 80, null, '60%'],
  ]]);
  assert.equal(t.regions.length, 1, 'Growth was a table of its own, with no Region to ask by');
  const r = t.regions[0]!;
  const growth = r.columns.find((c) => c.spoken === 'Growth')!;
  assert.equal(growth.col, 'E', 'every cell keeps its own address');
  const north = runQuery(r, { filters: [{ column: 'Region', op: 'eq', value: 'North' }], aggregate: 'max', aggregateColumn: 'Growth' });
  assert.equal(north.result, 20);
  // The spacer is neither counted nor named.
  assert.match(speakDescribe(r, false), /^This table has 3 rows and 4 columns\. The columns are Region, Sales 2025, Sales 2026 and Growth\./);

  const short = table('q', ['Sheet1', [['Region', 'Q1', null, 'Q2'], ['North', 10, null, 20], ['South', 30, null, 40]]]);
  assert.equal(short.regions.length, 1);
  assert.equal(runQuery(short.regions[0]!, { filters: [{ column: 'Region', op: 'eq', value: 'North' }], aggregate: 'sum', aggregateColumn: 'Q2' }).result, 20);
});

test('two tables side by side still split, when the right one has labels of its own', () => {
  const words = table('side', ['Ops', [
    ['Item', 'Qty', null, 'Invoice', 'Total'],
    ['Paper', 10, null, 'INV-1', 120],
    ['Ink', 2, null, 'INV-2', 340],
  ]]);
  assert.equal(words.regions.length, 2);
  // Invoice numbers written in digits are labels too.
  const digits = table('side2', ['Ops', [
    ['Item', 'Qty', null, 'Invoice no.', 'Total'],
    ['Paper', 10, null, 1001, 120],
    ['Ink', 2, null, 1002, 340],
  ]]);
  assert.equal(digits.regions.length, 2);
});

test('a code column is not what names a row', () => {
  const grades = table('gradebook', ['CS101', [
    ['Student ID', 'Name', 'Final'],
    [20210001, 'An', 8],
    [20210002, 'Bình', 9.5],
    [20210003, 'Chi', 5.5],
  ]]).regions[0]!;
  assert.equal(grades.columns[grades.labelColumn!]!.spoken, 'Name', 'was Student ID');
  const best = runQuery(grades, { aggregate: 'max', aggregateColumn: 'Final' });
  assert.deepEqual(best.winners.map((i) => grades.rows[i]![grades.labelColumn!]), ['Bình'], 'was "for 20210002"');

  for (const [heading, name] of [['Employee ID', 'Name'], ['Order number', 'Customer'], ['SKU', 'Product'], ['Mã NV', 'Họ tên']]) {
    const r = table('t', ['S', [[heading, name, 'Amount'], ['A1', 'x', 1], ['A2', 'y', 2], ['A3', 'z', 3]]]).regions[0]!;
    assert.equal(r.columns[r.labelColumn!]!.spoken, name, heading);
  }
  // A table with nothing else still has its code to name rows by.
  const only = table('codes', ['S', [['SKU', 'Qty'], [100234, 3], [100235, 4]]]).regions[0]!;
  assert.equal(only.columns[only.labelColumn!]!.spoken, 'SKU');
});

test('side-by-side tables of different lengths each keep only their own rows', () => {
  const stores = table('dashboard', ['Dashboard', [
    ['Sales by product', null, null, null, 'Stores', null, null],
    ['Product', 'Units', 'Revenue', null, 'Store', 'City', 'Staff'],
    ['Laptop', 12, 14400, null, 'Store 1', 'Hanoi', 12],
    ['Monitor', 30, 6000, null, 'Store 2', 'Saigon', 18],
    ['Keyboard', 55, 2750, null, 'Store 3', 'Da Nang', 7],
    ['Mouse', 80, 1600, null, null, null, null],
    ['Dock', 9, 1800, null, null, null, null],
  ]]);
  assert.equal(stores.regions.length, 2);
  assert.equal(runQuery(stores.regions[0]!, { aggregate: 'count' }).result, 5);
  assert.equal(stores.regions[1]!.rowCount, 3, 'was 5, two of them empty');
  assert.equal(runQuery(stores.regions[1]!, { aggregate: 'count' }).result, 3);

  const longRight = table('teams', ['Sheet1', [
    ['Team', 'Wins', null, 'Player', 'Goals'],
    ['Red', 7, null, 'An', 3],
    ['Blue', 5, null, 'Bình', 5],
    [null, null, null, 'Chi', 2],
    [null, null, null, 'Dũng', 6],
  ]]);
  assert.equal(runQuery(longRight.regions[0]!, { aggregate: 'count' }).result, 2, 'was 4');
  assert.equal(runQuery(longRight.regions[1]!, { aggregate: 'count' }).result, 4);
});

test('an Excel PivotTable is read with both of its heading rows', () => {
  const pivot = table('pivot', ['Pivot', [
    ['Sum of Revenue', 'Column Labels', null, null, null],
    ['Row Labels', 2023, 2024, 2025, 'Grand Total'],
    ['East', 120, 135, 150, 405],
    ['North', 200, 210, 190, 600],
    ['South', 90, 110, 130, 330],
    ['West', 160, 150, 175, 485],
    ['Grand Total', 570, 605, 645, 1820],
  ]]).regions[0]!;
  assert.equal(runQuery(pivot, { aggregate: 'sum', aggregateColumn: '2024' }).result, 605, 'was "no column called 2024", then 2629');
  assert.equal(runQuery(pivot, { aggregate: 'count' }).result, 4, 'was 5, the years counted as a row');
  assert.equal(pivot.structure?.ambiguous ?? false, false);
  // Without the pivot's own words, a first record of years is at least said to be doubtful.
  const years = table('years', ['S', [
    ['Sum of Sales', 'Year', null, null],
    ['Area', 2023, 2024, 2025],
    ['East', 120, 135, 150],
    ['North', 200, 210, 190],
  ]]).regions[0]!;
  assert.equal(years.structure?.ambiguous, true, 'was read at 0.93 with nothing flagged');
  assert.equal(years.structure?.alternatives[0]?.headerRows, 2);
});

test('a "Source:" line with its text beside it, or a sentence under a number column, is a note', () => {
  const source = table('source', ['Sheet1', [
    ['Month', 'Revenue'],
    ['January', 1000],
    ['February', 1200],
    ['March', 900],
    ['Source:', 'General ledger export, 2 April 2026'],
  ]]);
  const r = source.regions[0]!;
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 3, 'was 4');
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Revenue' }).result, 3100, 'was refused as a mix of text and numbers');
  assert.ok(source.warnings.some((w) => /Source: General ledger export/.test(w)));

  const vat = table('vat', ['Sheet1', [
    ['Item', 'Qty', 'Price'],
    ['Pens', 10, 1.5],
    ['Paper', 5, 4],
    ['Staples', 2, 3],
    [null, 'Prices include VAT.', null],
  ]]).regions[0]!;
  assert.equal(runQuery(vat, { aggregate: 'count' }).result, 3);
  assert.equal(runQuery(vat, { aggregate: 'sum', aggregateColumn: 'Qty' }).result, 17);

  const stock = table('stock', ['Stock', [
    ['SKU', 'Product', 'Qty', 'Unit price', 'Value'],
    ['100231', 'USB-C cable', 40, 4.5, 180],
    ['100232', 'Wireless mouse', 12, 19.99, 239.88],
    ['100236', 'HDMI adapter', 0, 7.25, 0],
    ['100240', 'AA batteries (4)', 75, 1.2, 90],
    ['100251', 'Webcam', 8, 49, 392],
    ['Notes:', 'Two cartons of cables damaged; see ticket 4411.', null, null, null],
  ]]).regions[0]!;
  assert.equal(runQuery(stock, { aggregate: 'count' }).result, 5, 'was 6');

  // A list with no numbers keeps its last row, whatever it is called.
  const settings = table('settings', ['S', [['Field', 'Value'], ['Owner', 'Finance'], ['Notes', 'Reviewed monthly']]]).regions[0]!;
  assert.equal(settings.rowCount, 2);
});
