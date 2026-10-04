/**
 * Numbers written the way finance exports and Vietnamese households write them.
 *
 * A P&L saved as CSV writes its loss month "(2,300)", and that row — the one that
 * mattered — was dropped while "no row has Profit less than 0" was said aloud. A
 * household's spending sheet writes "45.000" under "Số tiền" and totalled 685 where it
 * spent 685 thousand. "1.250.000 đồng" could not be totalled at all. And the STT column
 * that numbers the rows of nearly every Vietnamese sheet was offered as something to
 * total, so "what is the total" asked which column was meant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import { accountingNegative, asNumber, numbersRows, readNumber } from '../src/table/infer.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { readSpreadsheet } from '../src/ingest/read.ts';
import { runQuery } from '../src/query/engine.ts';
import { createHandler } from '../src/server.ts';
import type { IndexTable } from '../src/indexfmt.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'landmark-values2-'));

async function csv(name: string, text: string): Promise<IndexTable> {
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return buildTable(await readSpreadsheet(path));
}

// ── accounting negatives ────────────────────────────────────────────────────

test('a negative in parentheses is a negative number, with its currency or percent inside or out', () => {
  assert.equal(asNumber('(2,300)'), -2300);
  assert.equal(asNumber('($219.99)'), -219.99);
  assert.equal(asNumber('$ (219.99)'), -219.99);
  assert.equal(asNumber('(1.3%)'), -1.3);
  assert.equal(asNumber('(2.300 ₫)'), -2300);
  assert.equal(asNumber('(2.300) ₫'), -2300);
  assert.equal(asNumber('(123)'), -123);
  assert.equal(readNumber('(2,300)')?.style, 'ambiguous', 'decided like "2,300" would be');
  // A small loss in a statement "in thousands" is a loss too. A form's column-numbering
  // row, "(1) | (2) | (3)", is told apart as a row, under its headings (tested below).
  assert.equal(asNumber('(45)'), -45);
  assert.equal(asNumber('(1)'), -1);

  // Not numbers: a year or a unit written under a heading, words in brackets, a sign
  // inside the brackets, and a phone number with its area code in brackets.
  for (const text of ['(2025)', '(000)', '(USD 000)', '(Ký, họ tên)', '(note 1)', '(-5)', '(415) 555-0132']) {
    assert.equal(asNumber(text), null, text);
  }
  assert.equal(accountingNegative('($219.99)'), '$219.99');
  assert.equal(accountingNegative('(7)'), '7');
});

test("a P&L saved as CSV by Excel keeps its loss month", async () => {
  // A #,##0_);(#,##0) column, exactly as Excel's "Save as CSV" writes it.
  const t = await csv(
    'pnl.csv',
    'Month,Revenue,Profit\nJan,"12,400","1,850"\nFeb,"11,900","1,420"\nMar,"9,800","(2,300)"\nApr,"12,750","2,050"\nMay,"13,100","1,760"\nJun,"14,200","2,480"\n',
  );
  const r = t.regions[0]!;
  const profit = r.columns[2]!;
  assert.equal(profit.kind, 'number');
  assert.equal(profit.nonNumeric, 0, 'the loss was "not a number"');
  assert.equal(profit.sum, 7260, 'was 9560');
  assert.equal(profit.min, -2300);

  const lowest = runQuery(r, { aggregate: 'min', aggregateColumn: 'Profit' });
  assert.equal(lowest.result, -2300, 'was 1420, for Feb');
  const losses = runQuery(r, { filters: [{ column: 'Profit', op: 'lt', value: '0' }], aggregate: 'count' });
  assert.equal(losses.result, 1, 'was "no row has Profit less than 0"');
});

test('a variance column of bracketed amounts and percentages is money and percent, not "mixed"', async () => {
  const t = await csv(
    'variance.csv',
    'Account,Budget,Actual,Variance,Variance %\n' +
      'Salaries,"$120,000.00","$118,500.00","$1,500.00",1.3%\n' +
      'Rent,"$36,000.00","$36,000.00",$0.00,0.0%\n' +
      'Marketing,"$15,000.00","$20,200.00","($5,200.00)",(34.7%)\n' +
      'Travel,"$8,000.00","$3,100.00","$4,900.00",61.3%\n' +
      'Software,"$6,000.00","$6,900.00",($900.00),(15.0%)\n' +
      'Training,"$4,000.00","$5,300.00","($1,300.00)",(32.5%)\n',
  );
  const [, , , variance, percent] = t.regions[0]!.columns;
  assert.equal(variance!.kind, 'currency', 'three of six were negatives, so it was "mixed" and refused');
  assert.equal(variance!.sum, -1000);
  assert.equal(percent!.kind, 'percent');
  assert.equal(Number(percent!.sum!.toFixed(1)), -19.6);
});

test('a Vietnamese form numbering its columns "(1)" to "(5)" under the headings is not read as negatives', async () => {
  // How that row reads is a question of its own; it must not become five negative figures.
  const t = buildTable({
    sourceName: 'bang-luong.csv',
    format: 'csv',
    sheets: [{
      name: 'Lương',
      grid: [
        ['STT', 'Họ và tên', 'Lương cơ bản', 'Phụ cấp', 'Thực lĩnh'],
        ['(1)', '(2)', '(3)', '(4)', '(5)'],
        [1, 'An', 10000000, 2000000, 12000000],
        [2, 'Bình', 20000000, 3000000, 23000000],
      ],
      merges: [],
    }],
    warnings: [],
  });
  for (const c of t.regions[0]!.columns) assert.ok(c.min === undefined || c.min >= 0, `${c.spoken} has min ${c.min}`);
});

test('a small loss in a statement in thousands, "(45)", is a loss', async () => {
  // The review's P&L: one small loss among gains, as Excel writes #,##0_);(#,##0).
  const t = await csv(
    'pnl-small-loss.csv',
    'Month,Revenue,Profit\nJan,"9,000","1,850"\nFeb,"8,500","1,420"\nMar,"6,000",(45)\nApr,"9,200","2,050"\nMay,"8,800","1,760"\nJun,"9,900","2,480"\n',
  );
  const r = t.regions[0]!;
  const profit = r.columns[2]!;
  assert.equal(profit.kind, 'number');
  assert.equal(profit.nonNumeric, 0, '"(45)" was "not a number"');
  assert.equal(profit.min, -45, 'was 1420');
  assert.equal(profit.sum, 9515, 'was 9560');
  const lowest = runQuery(r, { aggregate: 'min', aggregateColumn: 'Profit' });
  assert.equal(lowest.result, -45, '"lowest profit" was 1420, for Feb');
  assert.deepEqual(lowest.winners, [2], 'March');
  const losses = runQuery(r, { filters: [{ column: 'Profit', op: 'lt', value: '0' }], aggregate: 'count' });
  assert.equal(losses.result, 1, 'was "no row has Profit less than 0"');

  // Every line of a statement in thousands: costs, other expense and tax in brackets.
  const lines = await csv('pnl-thousands.csv', 'Line,Q1,Q2\nRevenue,"1,200","1,350"\nCost of sales,(850),(910)\nOther expense,(45),(12)\nTax,(87),(95)\n');
  const [, q1, q2] = lines.regions[0]!.columns;
  assert.equal(q1!.kind, 'number', 'was "mixed", and refused');
  assert.equal(q1!.sum, 218);
  assert.equal(q2!.sum, 333);

  // A statement's note references are labels in brackets, not small losses.
  const noted = await csv('noted.csv', 'Line,Note,2026\nRevenue,(3),"1,200"\nCost of sales,(4),(850)\nTax,,(87)\n');
  const [, note, year] = noted.regions[0]!.columns;
  assert.equal(note!.kind, 'text');
  assert.equal(note!.sum, undefined);
  assert.equal(year!.sum, 263);
});

test("the row numbering a form's columns is told apart as a row, and kept out of the column names", () => {
  const form = (name: string, numbering: string[], records: (string | number)[][]) =>
    buildTable({
      sourceName: `${name}.csv`,
      format: 'csv',
      sheets: [{ name, grid: [['STT', 'Họ và tên', 'Lương cơ bản', 'Phụ cấp', 'Thực lĩnh'], numbering, ...records], merges: [] }],
      warnings: [],
    }).regions[0]!;

  // A CSV of grouped figures: "(3)" sits in a column that also holds "10,000,000", and
  // is still no negative.
  const grouped = form('luong-csv', ['(1)', '(2)', '(3)', '(4)', '(5)'], [
    ['1', 'An', '10,000,000', '2,000,000', '12,000,000'],
    ['2', 'Bình', '20,000,000', '3,000,000', '23,000,000'],
  ]);
  assert.equal(grouped.headerRows.length, 2, 'the numbering row is part of the headings');
  assert.equal(grouped.rowCount, 2);
  assert.deepEqual(
    grouped.columns.map((c) => c.spoken),
    ['STT', 'Họ và tên', 'Lương cơ bản', 'Phụ cấp', 'Thực lĩnh'],
    'were "STT, (1)" and so on',
  );
  assert.equal(grouped.columns[2]!.min, 10000000);
  assert.match(grouped.structure.chosen.why, /numbers the columns/);

  // Letters over the text columns, and a column that adds two others.
  const lettered = form('luong-chu', ['A', 'B', '(1)', '(2)', '(3=1+2)'], [
    [1, 'An', 10000000, 2000000, 12000000],
    [2, 'Bình', 20000000, 3000000, 23000000],
  ]);
  assert.equal(lettered.rowCount, 2);
  assert.equal(lettered.columns[4]!.sum, 35000000);
  assert.equal(lettered.columns[4]!.spoken, 'Thực lĩnh');

  // A first record of small losses is a record: it has a label, so it numbers nothing.
  const losses = buildTable({
    sourceName: 'lo.csv',
    format: 'csv',
    sheets: [{ name: 'lo', grid: [['Line', 'Q1', 'Q2'], ['Other', '(1)', '(2)'], ['Tax', '(3)', '(4)']], merges: [] }],
    warnings: [],
  }).regions[0]!;
  assert.equal(losses.rowCount, 2);
  assert.equal(losses.columns[1]!.sum, -4);
});

// ── the dong written as a word ──────────────────────────────────────────────

test('"1.250.000 đồng" and "45.000 dong" are amounts of money', async () => {
  assert.equal(asNumber('4.500.000 đồng'), 4500000);
  assert.equal(asNumber('45.000 dong'), 45000, 'one dot before three digits groups thousands of dong');
  assert.equal(asNumber('45.000 Đồng'), 45000);
  assert.equal(asNumber('4.500.000 đồng'.normalize('NFD')), 4500000, 'typed with combining marks');
  assert.equal(asNumber('5 dongs'), null);

  const t = await csv('dong.csv', 'Item,Amount\nRent,4.500.000 đồng\nFood,3.200.000 đồng\nPower,1.250.000 đồng\n');
  const amount = t.regions[0]!.columns[1]!;
  assert.equal(amount.kind, 'currency', 'was text: "Amount holds text, so it cannot be totalled"');
  assert.equal(amount.sum, 8950000);
});

// ── Vietnamese money headings ───────────────────────────────────────────────

test('"45.000" under "Số tiền" in a Vietnamese file is forty-five thousand dong', async () => {
  // A household spending sheet saved as CSV with Excel's UTF-8 mark.
  const t = await csv(
    'so-chi-tieu.csv',
    '﻿Ngày,Khoản chi,Số tiền\n01/09/2026,Đi chợ,45.000\n02/09/2026,Ăn sáng,65.000\n03/09/2026,Gửi xe,5.000\n05/09/2026,Xăng,120.000\n07/09/2026,Tiền điện,450.000\n',
  );
  const money = t.regions[0]!.columns[2]!;
  assert.equal(money.sum, 685000, 'was 685');
  assert.equal(money.numberNote, undefined, 'nobody writes 45.000 for forty-five; nothing to doubt');
  assert.ok(!t.warnings.some((w) => /thousand times/.test(w)), t.warnings.join(' | '));
});

test('a money heading settles the reading only in a Vietnamese file, and says so when it is a guess', async () => {
  // "1.500" is not a round thousand: the reading is still said with every figure.
  const unit = await csv('don-gia.csv', 'Mặt hàng,Đơn giá\nBút bi,"1.500"\nThước kẻ,"2.250"\n');
  const price = unit.regions[0]!.columns[1]!;
  assert.equal(price.sum, 3750, 'was 3.75');
  assert.match(price.numberNote ?? '', /"1\.500" in Đơn giá with the dot separating thousands/);
  assert.ok(unit.warnings.some((w) => /since the heading names an amount of money/.test(w)), unit.warnings.join(' | '));

  // English headings: the dot stays a decimal point, and the guess is said, as before.
  const english = await csv('en.csv', 'Item,Price\nPen,"1.500"\nRuler,"2.250"\n');
  assert.equal(english.regions[0]!.columns[1]!.sum, 3.75);

  // An exchange rate is not an amount of money, and can have decimals.
  const rate = await csv('ty-gia.csv', 'Ngày,Tỷ giá\n01/09/2026,"1.085"\n02/09/2026,"1.091"\n');
  assert.equal(Number(rate.regions[0]!.columns[1]!.sum!.toFixed(3)), 2.176, 'was read as 2176 thousand');
});

test("the file's own dot decimals outrank a money heading, and a rate, a score or a measurement is not money", async () => {
  // "2.5 kg" says this file writes the dot as a decimal point.
  const own = await csv('can-hang.csv', 'Mặt hàng,Khối lượng (kg),Thành tiền\nGạo,2.5,"1.234"\nĐường,3.75,"2.468"\n');
  assert.equal(Number(own.regions[0]!.columns[2]!.sum!.toFixed(3)), 3.702, 'was 3702');
  assert.ok(!own.warnings.some((w) => /amount of money/.test(w)), own.warnings.join(' | '));

  // "Giá trị đo" is a measured value, not a price.
  const measure = await csv('mau-do.csv', 'Mẫu,Giá trị đo\nA,"1.234"\nB,"2.468"\nC,"1.502"\n');
  assert.equal(Number(measure.regions[0]!.columns[1]!.sum!.toFixed(3)), 5.204, 'was 5204');
  assert.ok(!measure.warnings.some((w) => /amount of money/.test(w)));

  // A fee rate, bonus points and a salary coefficient carry decimals.
  const rate = await csv('ty-le-phi.csv', 'Khoản,Tỷ lệ phí\nA,"1.125"\nB,"2.250"\n');
  assert.equal(rate.regions[0]!.columns[1]!.sum, 3.375, 'was 3375');
  assert.ok(rate.warnings.some((w) => /"1\.125" in Tỷ lệ phí .*with the dot as a decimal point/.test(w)), 'still said to be a guess');
  const points = await csv('diem-thuong.csv', 'Họ tên,Điểm thưởng\nAn,"1.250"\nBình,"2.500"\n');
  assert.equal(points.regions[0]!.columns[1]!.sum, 3.75);
  const coefficient = await csv('he-so.csv', 'Họ tên,Hệ số lương\nAn,"2.340"\nBình,"3.660"\n');
  assert.equal(coefficient.regions[0]!.columns[1]!.sum, 6);

  // The value of an order is money.
  const order = await csv('don-hang.csv', 'Đơn hàng,Giá trị đơn hàng\nĐH-01,"45.000"\nĐH-02,"120.000"\n');
  assert.equal(order.regions[0]!.columns[1]!.sum, 165000);
});

// ── the dong is also a name ─────────────────────────────────────────────────

test('a rep called Dong does not turn an American sales sheet day first', async () => {
  for (const [file, rep] of [['us-dong-li.csv', 'Dong Li'], ['us-dong-hyun.csv', 'Kim Dong-hyun']] as const) {
    // Monthly figures dated on the 1st are all ambiguous; nothing else says which way.
    const t = await csv(file, `Date,Rep,Amount\n01/05/2026,${rep},120\n02/03/2026,Sarah Kim,80\n03/04/2026,Mike Ross,95\n`);
    const r = t.regions[0]!;
    assert.equal(r.columns[0]!.dateOrder, undefined, `${rep}: the file was read day first`);
    assert.equal(r.rows[1]![0], '2026-02-03T00:00:00.000Z', `${rep}: 02/03/2026 became 2 March`);
    assert.ok(t.warnings.some((w) => /month first, as January 5, 2026/.test(w)), t.warnings.join(' | '));
  }

  // After a figure, the word is the currency, and the file writes its dates day first.
  const vn = await csv('dong-after-figure.csv', 'Date,Item,Amount\n01/05/2026,Rent,4.500.000 dong\n02/03/2026,Food,3.200.000 dong\n');
  assert.equal(vn.regions[0]!.columns[0]!.dateOrder, 'dmy');

  // A column headed by the rep is not priced in dong; one headed "(dong)" is.
  const byRep = await csv('by-rep.csv', 'Month,Dong Li,Sarah Kim\nJan,"1.250","2.500"\nFeb,"1.750","3.125"\n');
  assert.equal(byRep.regions[0]!.columns[1]!.sum, 3, 'was 3000');
  const inDong = await csv('in-dong.csv', 'Item,Amount (dong)\nRent,"45.000"\nFood,"65.000"\n');
  assert.equal(inDong.regions[0]!.columns[1]!.sum, 110000);
});

// ── row numbers ─────────────────────────────────────────────────────────────

test('an STT column numbers the rows; it is not an amount', async () => {
  for (const [heading, values] of [
    ['STT', [1, 2, 3, 4]],
    ['TT', ['1', '2', '3']],
    ['No.', [1, 2, 3]],
    ['#', [3, 2, 1]],
    ['Số TT', [1, 2, 1, 2, 3]],
  ] as const) {
    assert.ok(numbersRows(heading, values), `${heading}: ${values.join(',')}`);
  }
  assert.ok(!numbersRows('STT', [2, 3, 4]), 'does not start at 1');
  assert.ok(!numbersRows('No.', [1, 1, 1]), 'a column of ones is a count');
  assert.ok(!numbersRows('Amount', [1, 2, 3]), 'the heading has to say so');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tháng 9');
  ws.addRow(['STT', 'Khoản chi', 'Danh mục', 'Số tiền']);
  const items: [string, string, number][] = [
    ['Tiền nhà', 'Nhà ở', 4500000],
    ['Tiền điện', 'Hóa đơn', 850000],
    ['Nước', 'Hóa đơn', 180000],
    ['Đi chợ', 'Ăn uống', 3200000],
    ['Xăng xe', 'Đi lại', 600000],
  ];
  items.forEach((it, i) => ws.addRow([i + 1, ...it]));
  ws.addRow([null, 'Tổng cộng', null, { formula: 'SUM(D2:D6)', result: 9330000 }]);
  const path = join(dir, 'chi-tieu.xlsx');
  await wb.xlsx.writeFile(path);
  const t = buildTable(await readSpreadsheet(path));
  const r = t.regions[0]!;
  const stt = r.columns[0]!;
  assert.equal(stt.sum, undefined, 'was "STT number sum=15"');
  assert.equal(stt.categories, undefined, '"top 3" must not name row 3');
  assert.equal(r.labelColumn, 1, 'a row is named by its Khoản chi');
  assert.equal(r.columns[3]!.sum, 9330000);

  // The voice client goes straight to the one amount there is.
  const handler = createHandler({ index: buildIndex([t]) });
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          'x-landmark-session': 'ingest2-stt',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
    );
    const body = JSON.parse(await res.text()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
  };
  resetContext();
  await loadCatalogue(call);
  await converse('open the chi tieu table', call);
  const total = (await converse('what is the total', call)) as { plan: { args?: Record<string, unknown> }; payload: Record<string, unknown> | null; spoken: string };
  assert.equal(total.plan.args?.['aggregate_column'], 'Số tiền', `asked instead: ${total.spoken}`);
  assert.equal(total.payload?.['result'], 9330000);
});

test('row numbers stay numbers: "items 1 to 5" is five items, not six', async () => {
  // Ten rows, so "10" sorts before "5" if the numbers are compared as text.
  const items: [string, number][] = [
    ['Tiền nhà', 4500000], ['Tiền điện', 850000], ['Nước', 180000], ['Đi chợ', 3200000], ['Xăng xe', 600000],
    ['Internet', 250000], ['Học phí', 1500000], ['Thuốc', 320000], ['Quà cưới', 500000], ['Sửa xe', 450000],
  ];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tháng 9');
  ws.addRow(['STT', 'Khoản chi', 'Số tiền']);
  items.forEach((it, i) => ws.addRow([i + 1, ...it]));
  const path = join(dir, 'chi-tieu-10.xlsx');
  await wb.xlsx.writeFile(path);
  const fromCsv = await csv('chi-tieu-10.csv', `STT,Khoản chi,Số tiền\n${items.map((it, i) => `${i + 1},${it[0]},${it[1]}`).join('\n')}\n`);

  for (const t of [buildTable(await readSpreadsheet(path)), fromCsv]) {
    const r = t.regions[0]!;
    const stt = r.columns[0]!;
    assert.equal(stt.kind, 'number', `${t.format}: was text`);
    assert.equal(stt.identifier, 'row');
    assert.equal(stt.sum, undefined, 'never offered as a total');
    const firstFive = runQuery(r, { filters: [{ column: 'STT', op: 'lte', value: '5' }], aggregate: 'count' });
    assert.equal(firstFive.result, 5, `${t.format}: was 6, "10" <= "5" as text`);
    const spent = runQuery(r, { filters: [{ column: 'STT', op: 'lte', value: '5' }], aggregate: 'sum', aggregateColumn: 'Số tiền' });
    assert.equal(spent.result, 9330000, 'was 9.9 million across 6 rows');
    const last = runQuery(r, { filters: [{ column: 'STT', op: 'gt', value: '8' }], aggregate: 'count' });
    assert.equal(last.result, 2, 'was 1');
  }
});

// ── the CLI shows what it could not read ───────────────────────────────────

test('the ingest report shows values it could not read as numbers, and every summary row', async () => {
  const path = join(dir, 'skipped.csv');
  await writeFile(path, 'Month,Amount\nJan,100\nFeb,TBD\nMar,250\nApr,175\nTotal,525\nAverage,175\n', 'utf8');
  const numbered = join(dir, 'numbered.csv');
  await writeFile(numbered, 'STT,Khoản chi,Số tiền\n1,Tiền nhà,4500000\n2,Tiền điện,850000\n3,Nước,180000\n', 'utf8');
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'src/ingest/cli.ts', path, numbered, '--out', join(dir, 'skipped.json')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Amount\s+number\s+4\/4\s+sum=525\s+range=100\.\.250\s+non-numeric=1/, out.stdout);
  assert.match(out.stdout, /total and summary rows, left out of answers: 6, 7/, out.stdout);
  // A number column with no total is said to be the row numbering, not left blank.
  assert.match(out.stdout, /STT\s+number\s+3\/3\s+numbers the rows, never totalled/, out.stdout);
});
