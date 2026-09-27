/**
 * Values: what a cell means, as opposed to where the table is.
 *
 * Every case here produced a confident wrong answer with nothing to warn the listener:
 * Vietnamese prices totalled a thousand times too small, phone numbers read back as
 * "912.3 million", a budget's own Total row doubling its total, and a date filter
 * that matched on the server and missed on a laptop in Hanoi.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asDate, asNumber, looksLikeIdentifier, profileColumn, readNumber } from '../src/table/infer.ts';
import { isSummaryLabel, materialise } from '../src/table/materialise.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { decodeText, readSpreadsheet } from '../src/ingest/read.ts';
import { runQuery } from '../src/query/engine.ts';
import { createHandler } from '../src/server.ts';
import type { IndexRegion, IndexTable } from '../src/indexfmt.ts';

type Cell = string | number | boolean | null;

function table(name: string, grid: Cell[][]): IndexTable {
  return buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });
}
const region = (name: string, grid: Cell[][]): IndexRegion => table(name, grid).regions[0]!;

const dir = await mkdtemp(join(tmpdir(), 'landmark-values-'));
async function csv(name: string, text: string): Promise<IndexTable> {
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return buildTable(await readSpreadsheet(path));
}

// ── numbers written in other conventions ────────────────────────────────────

test('a number is read by the convention its own text shows', () => {
  assert.equal(asNumber('1.5'), 1.5);
  assert.equal(asNumber('1,234.50'), 1234.5);
  assert.equal(asNumber('1,250,000'), 1250000);
  assert.equal(asNumber('12,50,000'), 1250000, 'lakh grouping still reads');
  assert.equal(asNumber('1,00,000.50'), 100000.5);
  assert.equal(asNumber('€1.234,50'), 1234.5, 'was 1.2345');
  assert.equal(asNumber('1.250.000 ₫'), 1250000, 'was not a number at all');
  assert.equal(asNumber('10,5'), 10.5, 'was 105');
  assert.equal(asNumber('-1.234,5'), -1234.5);
  assert.equal(asNumber('10 000,50'), 10000.5);
  // The dong has no minor unit, so its dot can only group thousands.
  assert.equal(asNumber('45.000 ₫'), 45000, 'was 45');
  assert.equal(asNumber('45.000đ'), 45000);
  assert.equal(asNumber('45.000 VNĐ'), 45000);
  assert.equal(asNumber('45.000 VND'), 45000);
  // Genuinely undecidable text keeps the familiar reading, and says it is a guess.
  assert.deepEqual(readNumber('12,500'), { value: 12500, style: 'ambiguous' });
  assert.deepEqual(readNumber('1.234'), { value: 1.234, style: 'ambiguous' });
  assert.equal(readNumber('1.234', 'comma')?.value, 1234);
  assert.equal(asNumber('04.07.2026'), null, 'a dotted date is not a number');
  assert.equal(asNumber('1.2.3'), null);
});

test('prices in dong are currency, and total correctly', async () => {
  const t = await csv('vnd.csv', 'Item,Price\nA,25.000 ₫\nB,12.500 ₫\nC,45.000 ₫\nD,65.000 ₫\n');
  const price = t.regions[0]!.columns[1]!;
  assert.equal(price.kind, 'currency');
  assert.equal(price.sum, 147500, 'was 147.5');
  assert.equal(runQuery(t.regions[0]!, { aggregate: 'sum', aggregateColumn: 'Price' }).result, 147500);

  for (const mark of ['đ', ' VNĐ', ' VND']) {
    const r = region('dong', [['Item', 'Price'], ['A', `25.000${mark}`], ['B', `1.250.000${mark}`]]);
    assert.equal(r.columns[1]!.kind, 'currency', mark);
    assert.equal(r.columns[1]!.sum, 1275000, mark);
  }
});

test('European amounts total correctly', async () => {
  const t = await csv('eu.csv', 'Item,Amount\nA,"€1.234,50"\nB,"€2.000,00"\nC,"€10,5"\n');
  const r = t.regions[0]!;
  assert.equal(r.columns[1]!.kind, 'currency');
  assert.equal(r.columns[1]!.sum, 3245, 'was 108.23');
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Amount' }).result, 3245);
});

test('a semicolon-separated file is split on semicolons, with comma decimals', async () => {
  const t = await csv('semicolon.csv', 'Name;Amount\nAlpha;1,5\nBeta;2,5\nGamma;10\n');
  const r = t.regions[0]!;
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Name', 'Amount'], 'was one column called "Name;Amount"');
  assert.equal(r.rowCount, 3);
  assert.equal(r.columns[1]!.sum, 14);
  assert.deepEqual(t.warnings, []);

  const comma = await csv('comma.csv', 'Name,Note\nAlpha,"a; b"\nBeta,"c; d"\n');
  assert.deepEqual(comma.regions[0]!.columns.map((c) => c.spoken), ['Name', 'Note'], 'a comma file stays a comma file');

  const single = await csv('single.csv', 'Name\nAlpha\nBeta\n');
  assert.deepEqual(single.warnings, [], 'one column has no separator to detect, and that is fine');
});

test('an ambiguous value is read the way the rest of its column shows', () => {
  const r = region('mixed', [['Item', 'Amount'], ['A', '1.234'], ['B', '10,5'], ['C', '2.000']]);
  assert.equal(r.columns[1]!.sum, 3244.5, '"10,5" shows the comma is the decimal point, so 1.234 is 1234');
  // The stored cells are rewritten so every reader agrees, currency signs kept.
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Amount' }).result, 3244.5);
  assert.deepEqual(r.rows.map((row) => row[1]), ['1234', '10,5', '2000']);

  // A currency amount never has three decimals, so its own text settles it; the cell is
  // kept as written.
  const priced = region('priced', [['Item', 'Price'], ['A', '€1.234'], ['B', '€2,5']]);
  assert.deepEqual(priced.rows.map((row) => row[1]), ['€1.234', '€2,5']);
  assert.equal(priced.columns[1]!.sum, 1236.5);
  assert.equal(priced.columns[1]!.kind, 'currency');
});

test('a column with nothing to decide it follows the rest of the file, and says so', () => {
  const t = table('file', [['Item', 'Price', 'Weight'], ['A', '1.250.000', '2.500'], ['B', '3.000.000', '1.250']]);
  assert.equal(t.regions[0]!.columns[2]!.sum, 3750, 'the file groups with dots, so 2.500 is 2500');
  // A borrowed reading a thousand times from the familiar one is never silent.
  assert.equal(t.warnings.length, 1, t.warnings.join(' | '));
  assert.match(t.warnings[0]!, /"2\.500" in Weight/);
  assert.match(t.warnings[0]!, /rest of the file/);
});

test('one stray value does not set the convention for a whole file', async () => {
  // "8,10" is a list of sizes. It used to make the file comma-decimal, and every
  // "$1,200" in it $1.20: a total of 853.7 for 4,550, with nothing said.
  const sizes = await csv('us-sizes.csv', 'Item,Sizes,Price\nShoe,"8,10","$1,200"\nBoot,"9,11","$2,500"\nSock,"7,9",$850\n');
  const price = sizes.regions[0]!.columns[2]!;
  assert.equal(price.sum, 4550, 'was 853.7');
  assert.deepEqual(sizes.regions[0]!.rows.map((r) => r[2]), ['$1,200', '$2,500', '$850'], 'the stored cells are not rewritten');
  assert.ok(!sizes.warnings.some((w) => /Price/.test(w)), sizes.warnings.join(' | '));

  // Without the dollar signs only the delimiter speaks for Qty, and a comma-separated
  // file does not use the comma as its decimal point.
  const qty = await csv('us-qty.csv', 'Item,Sizes,Qty\nShoe,"8,10","1,200"\nBoot,"9,11","2,500"\nSock,"7,9",850\n');
  assert.equal(qty.regions[0]!.columns[2]!.sum, 4550);
  assert.deepEqual(qty.warnings, []);
});

test('ordinary US amounts carry no warning, and euro amounts group their thousands', async () => {
  const us = await csv('us-amounts.csv', 'Item,Amount\nA,"1,500"\nB,"12,000"\nC,850\n');
  assert.equal(us.regions[0]!.columns[1]!.sum, 14350);
  assert.deepEqual(us.warnings, [], 'no "a thousand times smaller" for every American CSV');

  const eu = await csv('eu-3dec.csv', 'Item,Cost\nA,€1.200\nB,€950\nC,€12.000\n');
  assert.equal(eu.regions[0]!.columns[1]!.sum, 14150, '"€12.000" was twelve euros');
  assert.ok(!eu.warnings.some((w) => /thousand/.test(w)), eu.warnings.join(' | '));
});

test('a delimiter speaks for the numbers, and a guess against it is said out loud', async () => {
  // Semicolons are what Excel writes where the comma is the decimal point.
  const semi = await csv('semi-dots.csv', 'Tên;Giá\nA;1.500\nB;2.000\n');
  assert.equal(semi.regions[0]!.columns[1]!.sum, 3500);
  assert.ok(semi.warnings.some((w) => /"1\.500"/.test(w) && /thousands/.test(w)));

  // A comma-separated export from a spreadsheet set to Vietnamese still writes "45.000".
  // Nothing in this file says which it is, so the familiar reading is kept and doubted.
  const alone = await csv('vn-export.csv', 'Món,Giá\nPhở,45.000\nBún,35.000\n');
  assert.equal(alone.regions[0]!.columns[1]!.sum, 80);
  assert.ok(alone.warnings.some((w) => /"45\.000"/.test(w) && /thousand times larger/.test(w)));

  // Values that settle it beyond doubt outvote the delimiter, and the borrowed reading
  // is still said.
  const grouped = await csv('vn-grouped.csv', 'Món,Giá,Tổng\nPhở,45.000,1.250.000\nBún,35.000,2.500.000\n');
  assert.equal(grouped.regions[0]!.columns[1]!.sum, 80000);
  assert.ok(grouped.warnings.some((w) => /"45\.000"/.test(w) && /rest of the file/.test(w)));
});

test('a semicolon table under a title line is still split on semicolons', async () => {
  const t = await csv('semi-title.csv', 'Báo cáo tháng 9\n\nMón;Giá\nPhở;45.000 ₫\nBún;35.000 ₫\nCơm;1.250.000 ₫\n');
  const r = t.regions[0]!;
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Món', 'Giá'], 'was one column called "Món;giá"');
  assert.equal(r.title, 'Báo cáo tháng 9');
  assert.equal(r.columns[1]!.sum, 1330000);

  const names = ['Phở', 'Bún', 'Cơm', 'Chè', 'Bánh mì', 'Gỏi', 'Nem', 'Xôi', 'Lẩu', 'Cháo'];
  const ten = await csv('semi-title10.csv', `Báo cáo tháng 9\n\nMón;Giá\n${names.map((n, i) => `${n};${i + 1},5`).join('\n')}\n`);
  assert.equal(ten.regions[0]!.rowCount, 10);
  assert.equal(ten.regions[0]!.columns[1]!.sum, 60, '"1,5" was cut in half');
});

test('a column whose convention cannot be told says so', () => {
  const dots = table('weights', [['Item', 'Weight'], ['A', '1.250'], ['B', '2.500']]);
  assert.equal(dots.regions[0]!.columns[1]!.sum, 3.75, 'the familiar reading is kept');
  assert.ok(dots.warnings.some((w) => /Weight/.test(w) && /1\.250/.test(w) && /thousand/.test(w)));

  const mixed = table('mixed', [['Item', 'Amount'], ['A', '1,234.50'], ['B', '2.000,75']]);
  assert.ok(mixed.warnings.some((w) => /Amount/.test(w) && /two styles/.test(w)));

  const plain = table('plain', [['Item', 'Amount'], ['A', '1.5'], ['B', '12'], ['C', '1,234.50']]);
  assert.deepEqual(plain.warnings, [], 'nothing ambiguous, nothing said');
});

// ── identifiers ─────────────────────────────────────────────────────────────

test('identifier columns are text, whatever digits they hold', () => {
  assert.equal(profileColumn(['0912345678', '0987654321'], 'Phone', 0, 0).kind, 'text');
  assert.equal(profileColumn([50012, 50013], 'Customer ID', 0, 0).kind, 'text');
  assert.equal(profileColumn(['02134', '10001'], 'Zip', 0, 0).kind, 'text');
  assert.equal(profileColumn(['00123', '00456'], 'Reference', 0, 0).kind, 'text', 'a leading zero is enough');
  assert.equal(profileColumn([1001, 1002], 'Order No.', 0, 0).kind, 'text');
  assert.equal(profileColumn([1, 2], 'Mã hàng', 0, 0).kind, 'text');
  assert.equal(profileColumn([912345678, 987654321], 'Mobile', 0, 0).kind, 'text', 'a phone number stored as a number');
  assert.equal(profileColumn(['0912 345 678', '0987 654 321'], 'Phone number', 0, 0).kind, 'text');
  assert.equal(profileColumn(['0912345678'], 'Số điện thoại', 0, 0).kind, 'text');
  // Quantities that merely contain the letters stay quantities.
  for (const h of ['Paid', 'Valid', 'Width', 'Account balance', 'Amount', 'Units']) {
    assert.equal(profileColumn([10, 20], h, 0, 0).kind, 'number', h);
  }
});

test('a quantity whose heading mentions a phone, a post office or a code stays a quantity', () => {
  // The identifier word has to end the heading: "Phone sales" is sales.
  for (const h of ['Phone sales', 'Mobile revenue', 'Mobile users', 'Postal charges', 'Code coverage', 'Promo code uses']) {
    assert.equal(profileColumn([10, 20, 35], h, 0, 0).kind, 'number', h);
  }
  // A channel called Mobile: takings with decimals, or in round thousands of dong.
  assert.equal(profileColumn([800.5, 900.25], 'Mobile', 0, 0).kind, 'number');
  assert.equal(profileColumn([800, 950], 'Mobile', 0, 0).kind, 'number', 'too short to be a phone number');
  assert.equal(profileColumn([12500000, 8000000], 'Mobile', 0, 0).kind, 'number');
  // Even under an identifier heading, an amount written as an amount is one.
  assert.equal(profileColumn(['$1,200', '$850'], 'Code', 0, 0).kind, 'currency');
  // One zero-padded entry is a typing habit, not a column of codes.
  const amount = profileColumn(['05', '10', '20', '30'], 'Amount', 0, 0);
  assert.equal(amount.kind, 'number');
  assert.equal(amount.numeric?.sum, 65);
});

test('phone numbers and postcodes are read back as written', async () => {
  const t = await csv('contacts.csv', 'Name,Phone,Zip,Amount\nAnh,0912345678,02134,10\nBao,0987654321,10001,20\n');
  const r = t.regions[0]!;
  assert.deepEqual(r.columns.map((c) => c.kind), ['text', 'text', 'text', 'number']);
  assert.deepEqual(r.rows[0], ['Anh', '0912345678', '02134', '10'], 'leading zeros kept');
  assert.equal(r.columns[1]!.sum, undefined, 'not offered as a total');

  // Stored as spreadsheet numbers, they become their text so nothing scales them.
  const ids = region('ids', [['Customer ID', 'Balance'], [50012, 10], [50013, 20]]);
  assert.deepEqual(ids.rows.map((row) => row[0]), ['50012', '50013']);
});

// ── dates ───────────────────────────────────────────────────────────────────

test('dates are read in the forms people write and the server speaks, as UTC days', () => {
  const day = (s: string) => asDate(s)?.toISOString() ?? null;
  const JULY_4 = '2026-07-04T00:00:00.000Z';
  assert.equal(day('2026-07-04'), JULY_4);
  assert.equal(day('7/4/2026'), JULY_4);
  assert.equal(day('07-04-2026'), JULY_4);
  assert.equal(day('July 4, 2026'), JULY_4, 'the server says dates this way');
  assert.equal(day('Jul 4 2026'), JULY_4);
  assert.equal(day('4 July 2026'), JULY_4);
  assert.equal(day('04-Jul-2026'), JULY_4);
  assert.equal(day('04.07.2026'), JULY_4, 'dots mean day first');
  assert.equal(day('15/01/2024'), '2024-01-15T00:00:00.000Z', 'only one way round fits');
  assert.equal(day('2026-07-04T10:30:00+07:00'), '2026-07-04T03:30:00.000Z');
  assert.equal(day('2/30/2026'), null, 'not a real day');
  assert.equal(day('2026-02-30'), null);
  assert.equal(day('2026-02-30T00:00:00.000Z'), null, 'not rolled into March');
  assert.equal(day('2026-07-04T00:00:00.000Z'), JULY_4, 'the stored form reads back as itself');
  assert.equal(day('2026'), null, 'a bare year is a number');
  assert.equal(day('Unit 4, 2026'), null);
});

test('reading a date does not depend on the host time zone', () => {
  // A negative offset is where local-time parsing moved every date a day early. The
  // zone is set inside the child: some shells on Windows do not pass TZ through, and
  // a test that silently ran in the local zone would prove nothing.
  for (const [tz, offset] of [['America/Los_Angeles', 480], ['Asia/Ho_Chi_Minh', -420]] as const) {
    const code = `process.env.TZ = ${JSON.stringify(tz)};
      const { asDate } = await import('./src/table/infer.ts');
      console.log(JSON.stringify({
        offset: new Date(2024, 0, 15).getTimezoneOffset(),
        days: ['1/15/2024', 'January 15, 2024', '2024-01-15'].map((s) => asDate(s).toISOString()),
      }));`;
    const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], {
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    const got = JSON.parse(out.stdout) as { offset: number; days: string[] };
    assert.equal(got.offset, offset, `the child really ran in ${tz}`);
    assert.deepEqual(got.days, Array(3).fill('2024-01-15T00:00:00.000Z'), tz);
  }
});

test('a date column is stored as ISO days, read day-first where the column shows it', () => {
  const us = region('us', [['When', 'Amount'], ['1/15/2024', 1], ['2/1/2024', 2]]);
  assert.equal(us.columns[0]!.kind, 'date');
  assert.deepEqual(us.rows.map((r) => r[0]), ['2024-01-15T00:00:00.000Z', '2024-02-01T00:00:00.000Z']);

  const vn = region('vn', [['Ngày', 'Amount'], ['15/01/2024', 1], ['04/07/2024', 2]]);
  assert.deepEqual(vn.rows.map((r) => r[0]), ['2024-01-15T00:00:00.000Z', '2024-07-04T00:00:00.000Z'], '4 July, not 7 April');
  // The stored rows agree, so re-reading under a correction cannot decide it afresh.
  assert.deepEqual(vn.allRows.map((r) => r[0]), ['Ngày', '2024-01-15T00:00:00.000Z', '2024-07-04T00:00:00.000Z']);
  const reread = materialise(vn.allRows.slice(1), vn.startRow + 1, vn.firstCol, 0);
  assert.equal(reread.rows[1]![0], '2024-07-04T00:00:00.000Z');

  const q = runQuery(us, { filters: [{ column: 'When', op: 'eq', value: 'January 15, 2024' }], aggregate: 'count' });
  assert.equal(q.result, 1, 'filtering by the spoken form finds the row');
});

test('a date column with "TBD" against unscheduled rows is still a date column', () => {
  const tasks = region('tasks', [
    ['Task', 'Owner', 'Due'],
    ['Book venue', 'Anh', '2026-10-01'],
    ['Invites', 'Bao', 'TBD'],
    ['Catering', 'Chi', '2026-10-05'],
    ['Music', 'Dung', 'TBD'],
    ['Flowers', 'Em', '2026-10-09'],
  ]);
  assert.equal(tasks.columns[2]!.kind, 'date', 'was "mixed"');
  assert.deepEqual(tasks.rows.map((r) => r[2]), [
    '2026-10-01T00:00:00.000Z',
    'TBD',
    '2026-10-05T00:00:00.000Z',
    'TBD',
    '2026-10-09T00:00:00.000Z',
  ]);

  const dayFirst = region('dmy', [['Task', 'Due'], ['A', '15/10/2026'], ['B', 'TBD'], ['C', '04/11/2026'], ['D', '05/11/2026']]);
  assert.equal(dayFirst.columns[1]!.kind, 'date');
  assert.equal(dayFirst.rows[2]![1], '2026-11-04T00:00:00.000Z', '4 November, as the column shows, not 11 April');
  assert.equal(dayFirst.allRows[3]![1], '2026-11-04T00:00:00.000Z', 'and the stored rows agree');
});

// ── categories and names ────────────────────────────────────────────────────

test('any text column small enough to list says what is in it', () => {
  const r = region('people', [
    ['Name', 'Region'],
    ['Anh', 'Europe'],
    ['Bao', 'Asia'],
    ['Chi', 'Africa'],
  ]);
  assert.equal(r.columns[1]!.kind, 'text', 'three distinct in three rows is still text');
  assert.deepEqual(r.columns[1]!.categories, ['Africa', 'Asia', 'Europe'], 'but "Europe" is recognisable');

  const many = region('many', [['Code word'], ...Array.from({ length: 30 }, (_, i) => [`word ${i}`])]);
  assert.equal(many.columns[0]!.categories, undefined, 'too many to be worth listing');
});

test('two columns with the same heading can each be named', () => {
  const r = region('dups', [['Name', 'Amount', 'Amount'], ['a', 1, 2], ['b', 3, 4]]);
  assert.deepEqual(r.columns.map((c) => c.spoken), ['Name', 'Amount', 'Amount 2']);
  assert.deepEqual(r.columns.map((c) => c.path), [['Name'], ['Amount'], ['Amount']], 'paths stay as written');

  const clash = region('clash', [['Amount', 'Amount', 'Amount 2'], [1, 2, 3], [4, 5, 6]]);
  const names = clash.columns.map((c) => c.spoken.toLowerCase());
  assert.equal(new Set(names).size, 3, names.join(' | '));
});

// ── total and subtotal rows ─────────────────────────────────────────────────

test('a trailing Total row is marked and left out of the column figures', () => {
  const r = region('budget', [
    ['Department', 'Amount'],
    ['Engineering', 480000],
    ['Design', 210000],
    ['Ops', 95000],
    ['HR', 60000],
    ['Total', 845000],
  ]);
  assert.deepEqual(r.summaryRows, [4]);
  assert.equal(r.rowCount, 5, 'the row is still there to be read');
  assert.equal(r.columns[1]!.sum, 845000, 'was 1.69 million');
  assert.equal(r.columns[1]!.max, 480000, 'the total is not the largest department');
  assert.equal(r.columns[1]!.nonEmpty, 4);
});

test('subtotals and a grand total are all marked', () => {
  const r = region('regions', [
    ['Region', 'Rep', 'Amount'],
    ['North', 'Anh', 10],
    ['North', 'Bao', 20],
    ['Subtotal', null, 30],
    ['South', 'Chi', 40],
    ['South', 'Dung', 50],
    ['Sub-total:', null, 90],
    ['Grand total', null, 120],
  ]);
  assert.deepEqual(r.summaryRows, [2, 5, 6]);
  assert.equal(r.columns[2]!.sum, 120);
  assert.deepEqual(r.columns[0]!.categories, ['North', 'South'], '"Subtotal" is not a region to filter by');
});

test('Vietnamese totals are recognised, and look-alike names are not', () => {
  const vn = region('vn', [['Hạng mục', 'Số tiền'], ['A', '1.000.000 ₫'], ['B', '2.000.000 ₫'], ['C', '3.000.000 ₫'], ['Tổng cộng', '6.000.000 ₫']]);
  assert.deepEqual(vn.summaryRows, [3]);
  assert.equal(vn.columns[1]!.sum, 6000000);

  const records = region('stores', [
    ['Store', 'Sales'],
    ['Total Wine & More', 10],
    ['Tổng công ty Điện lực', 20],
    ['Cộng hòa Séc', 30],
  ]);
  assert.equal(records.summaryRows, undefined);
  assert.equal(records.columns[1]!.sum, 60);

  for (const label of ['Total', 'TOTALS', 'Grand total:', 'Subtotal', 'Sub-total', 'Tổng', 'Tổng cộng', 'Tổng số', 'Cộng:']) {
    assert.ok(isSummaryLabel(label), label);
  }
  // The same words decomposed, as some Vietnamese keyboards and exports write them.
  assert.ok(isSummaryLabel('Tổng cộng'.normalize('NFD')));
});

test('a record with "Total" in a later column is a record', () => {
  // A total row opens with its label. These open with a claim number.
  const claims = region('claims', [
    ['Claim', 'Amount', 'Loss'],
    [1001, 5000, 'Total'],
    [1002, 1200, 'Partial'],
    [1003, 800, 'Partial'],
    [1004, 9000, 'Total'],
  ]);
  assert.equal(claims.summaryRows, undefined, 'was [0, 3]: half the claims dropped');
  assert.equal(claims.columns[1]!.sum, 16000, 'was 2000');
  assert.deepEqual(claims.columns[2]!.categories, ['Partial', 'Total']);

  const status = region('status', [['Amount', 'Status'], [5000, 'Total'], [1200, 'Open'], [800, 'Open']]);
  assert.equal(status.summaryRows, undefined);
  assert.equal(status.columns[0]!.sum, 7000);

  // A label that is the row's first filled cell still marks a total, blank corner or not.
  const indented = region('indented', [['Group', 'Department', 'Amount'], ['A', 'Eng', 100], ['A', 'Ops', 50], [null, 'Total', 150]]);
  assert.deepEqual(indented.summaryRows, [2]);
  assert.equal(indented.columns[2]!.sum, 150);
});

test('total rows are found again under any heading count', () => {
  const r = region('budget', [['Department', 'Amount'], ['Eng', 100], ['Ops', 50], ['Total', 150]]);
  const headless = materialise(r.allRows, r.startRow, r.firstCol, 0);
  assert.deepEqual(headless.summaryRows, [3], 'the header row is now row 0, so the total moved down one');

  const alone = region('alone', [['Total', 150]]);
  assert.equal(alone.summaryRows, undefined, 'a table that is only a total row is still its own content');
});

// ── what a final verification found still wrong ─────────────────────────────

/** Ask the real handler about these tables, the way a host does. */
function speaker(...tables: IndexTable[]) {
  const handler = createHandler({ index: buildIndex(tables) });
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          'x-landmark-session': 'ingest-values-final',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
    );
    const body = JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } };
    return body.result.structuredContent;
  };
}

// Exactly what Excel's Data > Subtotal writes: each group's own "<group> Total".
const EXCEL_SUBTOTALS: Cell[][] = [
  ['Category', 'Item', 'Budgeted', 'Actual'],
  ['Housing', 'Rent', 1200, 1200],
  ['Housing', 'Utilities', 150, 172.35],
  ['Housing Total', null, 1350, 1372.35],
  ['Food', 'Groceries', 400, 438.1],
  ['Food', 'Dining out', 150, 96.5],
  ['Food Total', null, 550, 534.6],
  ['Transport', 'Fuel', 120, 101.2],
  ['Transport Total', null, 120, 101.2],
  ['Grand Total', null, 2020, 2008.15],
];

test('the subtotal rows Excel writes itself are totals, not records', async () => {
  const t = table('budget-subtotals', EXCEL_SUBTOTALS);
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [2, 5, 7, 8], 'only Grand Total was marked');
  assert.ok(Math.abs(r.columns[3]!.sum! - 2008.15) < 1e-9, 'was 4016.3: every figure doubled');
  assert.deepEqual(r.columns[0]!.categories, ['Food', 'Housing', 'Transport'], '"Housing Total" is not a category');

  const call = speaker(t);
  const sum = await call('table_query', { table_id: 'budget-subtotals', aggregate: 'sum', aggregate_column: 'Actual' });
  assert.equal(sum['result'], 2008.15);
  assert.match(String(sum['spoken']), /across 5 rows\. I left out 4 total rows\.$/);
  assert.equal((await call('table_query', { table_id: 'budget-subtotals', aggregate: 'count' }))['result'], 5);
  const max = await call('table_query', { table_id: 'budget-subtotals', aggregate: 'max', aggregate_column: 'Actual' });
  assert.match(String(max['spoken']), /^1200, for Rent\./, 'was "1372.35, for Housing Total"');
});

test('a pivot table report counts its reps, not its region totals', () => {
  // The rows under a two-level heading, as a PivotTable lays them out: Region merged
  // down its reps, "North Total" and "South Total" under each, "Grand Total" last.
  const pivot = materialise(
    [
      ['Region', 'Rep', '2025', '2025', '2026', '2026'],
      ['Region', 'Rep', 'H1', 'H2', 'H1', 'H2'],
      ['North', 'An', 10, 12, 14, 16],
      ['North', 'Bình', 20, 22, 24, 26],
      ['North Total', null, 30, 34, 38, 42],
      ['South', 'Chi', 5, 6, 7, 8],
      ['South', 'Dũng', 1, 2, 3, 4],
      ['South Total', null, 6, 8, 10, 12],
      ['Grand Total', null, 36, 42, 48, 54],
    ],
    0,
    0,
    2,
  );
  assert.deepEqual(pivot.summaryRows, [2, 5, 6]);
  assert.equal(pivot.columns[5]!.sum, 54, 'was 108');
  assert.equal(pivot.columns[5]!.max, 26, 'the highest rep, not "North Total"');
});

test('a line item that merely ends in "Total" is still a record', () => {
  // Its figures are not the sum of anything above it, so the label alone decides nothing.
  const r = region('lines', [['Line', 'Amount'], ['Sales', 100], ['Returns', 20], ['Sales Total', 400], ['Fees', 5]]);
  assert.equal(r.summaryRows, undefined);
  assert.equal(r.columns[1]!.sum, 525);
});

test('dong amounts whose currency is named only in the heading are read in thousands', async () => {
  // Google Sheets in Vietnamese exports a comma CSV with "45.000" and the currency in the heading.
  const t = await csv('bang-gia.csv', 'Món,Giá (VNĐ)\nPhở bò,"45.000"\nBún chả,"40.000"\nCơm tấm,"35.000"\nTrà đá,"5.000"\n');
  assert.equal(t.regions[0]!.columns[1]!.sum, 125000, 'was 125');
  assert.ok(!t.warnings.some((w) => /decimal point/.test(w)), t.warnings.join(' | '));
  // "Đơn giá" starts with a đ that is not the dong: that heading decides nothing.
  const unit = await csv('don-gia.csv', 'Món,Đơn giá\nA,"1.500"\nB,"2.250"\n');
  assert.ok(unit.warnings.some((w) => /decimal point/.test(w)), unit.warnings.join(' | '));
});

test('a guessed number convention is said with every figure from that column, not only in describe', async () => {
  const t = await csv('guessed.csv', 'Item,Weight\nA,"1.500"\nB,"2.250"\n');
  const call = speaker(t);
  const sum = await call('table_query', { table_id: 'guessed', aggregate: 'sum', aggregate_column: 'Weight' });
  assert.equal(sum['result'], 3.75);
  assert.match(
    String(sum['spoken']),
    /I read "1\.500" in Weight with the dot as a decimal point; if that is wrong, this is a thousand times larger\./,
  );
  // An answer that computes nothing from that column says nothing about it.
  const counted = await call('table_query', { table_id: 'guessed', aggregate: 'count' });
  assert.doesNotMatch(String(counted['spoken']), /thousand times/);
});

test('bank accounts, identity cards and passports are identifiers, and read back whole', () => {
  const accounts = [19036512345011, 19036512345022, 19036512345033];
  for (const heading of ['Số tài khoản', 'STK', 'Bank account', 'Card number', 'CCCD', 'Số CCCD', 'CMND', 'Passport no.', 'Số ĐT']) {
    assert.ok(looksLikeIdentifier(heading, accounts), heading);
  }
  // Whatever the heading: long runs of digits of one length, not in round thousands.
  assert.ok(looksLikeIdentifier('Ref', ['4111111111111111', '4012888888881881', '5555555555554444']));
  assert.ok(!looksLikeIdentifier('Amount', [1250000000, 3400000000, 2100000000]), 'dong in the billions end in 000');
  assert.ok(!looksLikeIdentifier('Population', [1411750000, 331900000, 1428627663]), 'lengths vary');

  const r = region('nhan-su', [['Họ tên', 'Số tài khoản', 'Lương'], ['An', 19036512345011, 18000000], ['Bình', 19036512345022, 15000000]]);
  assert.equal(r.columns[1]!.kind, 'text', 'was a number, totalled to 38 trillion');
  assert.equal(r.rows[0]![1], '19036512345011', 'every digit, not 19,036,512,345,000');
});

test('a phone number Excel stored without its zero is found by the number as written', async () => {
  const t = table('lien-he', [['Họ tên', 'Số điện thoại'], ['An', 912345678], ['Bình', 987654321]]);
  const r = t.regions[0]!;
  assert.equal(r.columns[1]!.identifier, 'phone');
  assert.equal(r.rows[0]![1], '0912345678', 'the zero Excel dropped is back');
  assert.deepEqual(r.columns[1]!.categories, ['0912345678', '0987654321']);
  const call = speaker(t);
  const found = await call('table_query', {
    table_id: 'lien-he',
    filters: [{ column: 'Số điện thoại', op: 'eq', value: '0912 345 678' }],
    aggregate: 'count',
  });
  assert.equal(found['result'], 1);

  // An English phone column keeps its digits as stored, and still matches as written.
  const en = table('contacts', [['Name', 'Phone'], ['Ann', 4155550132], ['Bob', 4155550199]]);
  const q = runQuery(en.regions[0]!, { filters: [{ column: 'Phone', op: 'eq', value: '(415) 555-0132' }], aggregate: 'count' });
  assert.equal(q.result, 1);
});

test('day-first dates follow the rest of the file, and a guess is said', async () => {
  // A Vietnamese export: semicolons, dotted thousands, and every day of the month under 13.
  const vn = await csv('ban-hang.csv', '﻿Ngày;Chi nhánh;Thành tiền\n01/09/2026;Hà Nội;4.200.000\n02/09/2026;TP.HCM;3.825.000\n11/09/2026;Hà Nội;5.000.000\n');
  const r = vn.regions[0]!;
  assert.equal(r.rows[0]![0], '2026-09-01T00:00:00.000Z', 'was 9 January');
  assert.equal(r.columns[0]!.dateOrder, 'dmy');
  assert.ok(vn.warnings.some((w) => /"01\/09\/2026" in Ngày .* day first, as September 1, 2026/.test(w)), vn.warnings.join(' | '));
  const september = runQuery(r, { filters: [{ column: 'Ngày', op: 'eq', value: 'September 2026' }], aggregate: 'count' });
  assert.equal(september.result, 3);

  // A comma file with dong amounts, and a German one with comma decimals.
  const comma = await csv('ban-hang-comma.csv', 'Ngày,Chi nhánh,Thành tiền\n01/09/2026,Hà Nội,"4.200.000 ₫"\n05/09/2026,Đà Nẵng,"2.100.000 ₫"\n');
  assert.equal(comma.regions[0]!.rows[1]![0], '2026-09-05T00:00:00.000Z');
  const de = await csv('eu.csv', 'Datum;Kunde;Betrag\n03/02/2026;Müller;1.234,56\n04/02/2026;Weber;980,00\n');
  assert.equal(de.regions[0]!.rows[0]![0], '2026-02-03T00:00:00.000Z', 'was March 2');

  // Vietnamese headings are enough on their own; Vietnamese names in an English file are not.
  const rates = await csv('ty-gia.csv', 'Ngày,Tỷ giá\n01/09/2026,24350\n02/09/2026,24400\n');
  assert.equal(rates.regions[0]!.rows[0]![0], '2026-09-01T00:00:00.000Z');
  const reps = await csv('us-reps.csv', 'Rep,Closed\nBảo,7/4/2026\nDũng,8/2/2026\n');
  assert.equal(reps.regions[0]!.rows[0]![1], '2026-07-04T00:00:00.000Z', 'the reps are not the language of the file');

  // An American file with nothing to settle it stays month first, and says it guessed.
  const us = await csv('us.csv', 'Date,Amount\n07/04/2026,10\n08/02/2026,20\n');
  assert.equal(us.regions[0]!.rows[0]![0], '2026-07-04T00:00:00.000Z');
  assert.ok(us.warnings.some((w) => /month first, as July 4, 2026/.test(w)), us.warnings.join(' | '));
  // One date past the 12th settles it, and nothing is said.
  const settled = await csv('settled.csv', 'Date,Amount\n07/04/2026,10\n08/22/2026,20\n');
  assert.ok(!settled.warnings.some((w) => /dates like/.test(w)));
});

test('files saved as UTF-16 or in a Windows code page are read as their letters', () => {
  const text = 'Kunde,Stadt,Betrag\nMüller,Köln,100\n';
  const utf16 = decodeText(new Uint8Array([0xff, 0xfe, ...Buffer.from(text, 'utf16le')]));
  assert.equal(utf16.text, text);
  assert.equal(utf16.legacy, null);
  const latin = decodeText(new Uint8Array(Buffer.from(text, 'latin1')));
  assert.equal(latin.text, text, 'was "M�ller" and "K�ln"');
  assert.equal(latin.legacy, 'Windows-1252');
  // "Hà Nội,đ" in Windows-1258: a base letter, then its tone mark.
  const vn = decodeText(new Uint8Array([0x48, 0x61, 0xcc, 0x20, 0x4e, 0xf4, 0xf2, 0x69, 0x2c, 0xf0]));
  assert.equal(vn.text, 'Hà Nội,đ');
  assert.equal(vn.legacy, 'Windows-1258');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).text, 'A', "Excel's UTF-8 mark is dropped");
});

test('a total named for what it adds up is a total, when its figures add up', () => {
  const expenses = region('expenses', [
    ['Expense', 'Amount'],
    ['Rent', 1200],
    ['Groceries', 450],
    ['Utilities', 180],
    ['Total Expenses', 1830],
  ]);
  assert.deepEqual(expenses.summaryRows, [3]);
  assert.equal(runQuery(expenses, { aggregate: 'sum', aggregateColumn: 'Amount' }).result, 1830, 'was 3660');
  assert.equal(runQuery(expenses, { aggregate: 'max', aggregateColumn: 'Amount' }).result, 1200, 'was 1830, for Total Expenses');
  assert.equal(runQuery(expenses, { aggregate: 'count' }).result, 3);

  // Section headings, subtotals and a grand total, all typed by hand.
  const budget = region('budget', [
    ['Category', 'Budget', 'Actual'],
    ['HOUSING', null, null],
    ['Rent', 1500, 1500],
    ['Utilities', 165, 173.17],
    ['Total Housing', 1665, 1673.17],
    ['FOOD', null, null],
    ['Groceries', 600, 642.55],
    ['Dining out', 250, 258.65],
    ['Total Food', 850, 901.2],
    ['TOTAL EXPENSES', 2515, 2574.37],
  ]);
  assert.equal(Number(runQuery(budget, { aggregate: 'sum', aggregateColumn: 'Actual' }).result).toFixed(2), '2574.37', 'was 7723.11');
  assert.equal(runQuery(budget, { aggregate: 'max', aggregateColumn: 'Actual' }).result, 1500, 'was 2574.37, for TOTAL EXPENSES');
  assert.equal(runQuery(budget, { aggregate: 'count' }).result, 4, 'was 9');

  const vn = region('doanh-thu', [
    ['Chi nhánh', 'Doanh thu'],
    ['Hà Nội', 428000],
    ['TP.HCM', 261500],
    ['Đà Nẵng', 185000],
    ['Tổng doanh thu', 874500],
  ]);
  assert.equal(runQuery(vn, { aggregate: 'sum', aggregateColumn: 'Doanh thu' }).result, 874500, 'was about 1.7 million');

  // A net line under two totals is neither a record nor a total of the rows above it.
  const net = region('net', [
    ['Item', 'Monthly'],
    ['Salary', 5000],
    ['Freelance', 800],
    ['Total Income', 5800],
    ['Rent', 1500],
    ['Food', 700],
    ['Total Expenses', 2200],
    ['Net Savings', 3600],
  ]);
  assert.deepEqual(net.summaryRows, [2, 5, 6]);

  // A name that only starts like a total, whose figure does not add up, is a record.
  const shop = region('shop', [['Store', 'Sales'], ['Main St', 10], ['Total Wine & More', 25], ['Harbour', 5]]);
  assert.equal(shop.summaryRows, undefined);
});
