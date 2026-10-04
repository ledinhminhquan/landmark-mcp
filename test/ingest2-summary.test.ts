/**
 * Summary rows that are not totals: Average, Count, Max and Min.
 *
 * A home budget with "Total" and then "Average" under its months, a gradebook ending in
 * "Class average", a class list ending in "Trung bình", and Excel's own Data > Subtotal
 * set to Average or Count. Each extra row was counted as a record, so "how many months"
 * said 7, the total of Food was 22.9 thousand where it is 19.6, and the answer added "I
 * left out the Total row" as if the sum were now clean. The workbooks are built here the
 * way Excel writes them, formulas and cached results included.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { readSpreadsheet } from '../src/ingest/read.ts';
import { runQuery } from '../src/query/engine.ts';
import { createHandler } from '../src/server.ts';
import type { IndexRegion, IndexTable } from '../src/indexfmt.ts';

type Cell = string | number | boolean | null;

const dir = await mkdtemp(join(tmpdir(), 'landmark-summary-'));

async function workbook(name: string, fill: (ws: ExcelJS.Worksheet) => void): Promise<IndexTable> {
  const wb = new ExcelJS.Workbook();
  fill(wb.addWorksheet(name));
  const path = join(dir, `${name}.xlsx`);
  await wb.xlsx.writeFile(path);
  return buildTable(await readSpreadsheet(path));
}

const region = (name: string, grid: Cell[][]): IndexRegion =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] }).regions[0]!;

/** Ask the real handler, the way a host does. */
function speaker(...tables: IndexTable[]) {
  const handler = createHandler({ index: buildIndex(tables) });
  return async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          'x-landmark-session': 'ingest2-summary',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'table_query', arguments: args } }),
      }),
    );
    const body = JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } };
    return body.result.structuredContent;
  };
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

// ── the layouts the review found ────────────────────────────────────────────

test('a budget with a Total row and an Average row under its months counts six months', async () => {
  const months: [string, number, number, number][] = [
    ['January', 4500, 3200, 600],
    ['February', 4500, 2900, 650],
    ['March', 4500, 3500, 580],
    ['April', 4500, 3100, 700],
    ['May', 4500, 3300, 620],
    ['June', 4500, 3600, 690],
  ];
  const t = await workbook('home-budget', (ws) => {
    ws.addRow(['Month', 'Rent', 'Food', 'Transport']);
    months.forEach((m) => ws.addRow(m));
    const col = (k: 1 | 2 | 3): number[] => months.map((m) => m[k]);
    ws.addRow(['Total', ...[1, 2, 3].map((k, i) => ({ formula: `SUM(${'BCD'[i]}2:${'BCD'[i]}7)`, result: sum(col(k as 1 | 2 | 3)) }))]);
    ws.addRow(['Average', ...[1, 2, 3].map((k, i) => ({ formula: `AVERAGE(${'BCD'[i]}2:${'BCD'[i]}7)`, result: sum(col(k as 1 | 2 | 3)) / 6 }))]);
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [6, 7], 'only the Total row was marked');
  assert.equal(r.columns[2]!.sum, 19600, 'was 22866.67, the average counted as a seventh month');
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 6, 'was 7');
  assert.ok(!r.columns[0]!.categories?.includes('Average'), '"Average" is not a month');

  const ask = speaker(t);
  const total = await ask({ table_id: 'home-budget', aggregate: 'sum', aggregate_column: 'Food' });
  assert.equal(total['result'], 19600);
  assert.match(String(total['spoken']), /across 6 rows/);
  const lowest = await ask({ table_id: 'home-budget', aggregate: 'min', aggregate_column: 'Food' });
  assert.match(String(lowest['spoken']), /^2900, for February\./);
});

test("Excel's Subtotal set to Average: each group's average and the grand average are left out", async () => {
  const t = await workbook('subtotal-average', (ws) => {
    ws.addRow(['Category', 'Item', 'Amount']);
    ws.addRow(['Food', 'Groceries', 320]);
    ws.addRow(['Food', 'Restaurants', 180]);
    ws.addRow(['Food Average', null, { formula: 'SUBTOTAL(1,C2:C3)', result: 250 }]);
    ws.addRow(['Housing', 'Rent', 1500]);
    ws.addRow(['Housing', 'Utilities', 210]);
    ws.addRow(['Housing', 'Insurance', 90]);
    ws.addRow(['Housing Average', null, { formula: 'SUBTOTAL(1,C5:C7)', result: 600 }]);
    ws.addRow(['Grand Average', null, { formula: 'SUBTOTAL(1,C2:C8)', result: 460 }]);
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [2, 6, 7]);
  assert.equal(r.columns[2]!.sum, 2300, 'was 3610');
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 5, 'was 8');
  assert.deepEqual(r.columns[0]!.categories, ['Food', 'Housing'], '"Food Average" is not a category');
});

test("Excel's Subtotal set to Count: the counts are not hours", async () => {
  const t = await workbook('subtotal-count', (ws) => {
    ws.addRow(['Team', 'Ticket', 'Hours']);
    ws.addRow(['Support', 'T-1', 3]);
    ws.addRow(['Support', 'T-2', 5]);
    ws.addRow(['Support Count', null, { formula: 'SUBTOTAL(2,C2:C3)', result: 2 }]);
    ws.addRow(['Billing', 'T-3', 4]);
    ws.addRow(['Billing', 'T-4', 2]);
    ws.addRow(['Billing', 'T-5', 6]);
    ws.addRow(['Billing Count', null, { formula: 'SUBTOTAL(2,C5:C7)', result: 3 }]);
    ws.addRow(['Grand Count', null, { formula: 'SUBTOTAL(2,C2:C8)', result: 5 }]);
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [2, 6, 7]);
  assert.equal(r.columns[2]!.sum, 20, 'was 30');
  const ask = speaker(t);
  const fewest = await ask({ table_id: 'subtotal-count', aggregate: 'min', aggregate_column: 'Hours' });
  assert.match(String(fewest['spoken']), /^2, for T-4\./, 'was "2, for Support Count and T-4"');
});

test('a gradebook with a class average row counts its students', async () => {
  const students: [string, number, number, number][] = [
    ['Nguyễn Văn An', 8.5, 7.0, 9.0],
    ['Trần Thị Bình', 9.25, 8.5, 8.0],
    ['Lê Hoàng Cường', 6.0, 7.5, 5.5],
    ['Phạm Minh Đức', 7.75, 6.25, 7.0],
    ['Hoàng Thu Hà', 10, 9.0, 9.5],
    ['Võ Quốc Huy', 5.0, 6.5, 4.75],
    ['Đặng Ngọc Lan', 8.0, 8.75, 9.25],
    ['Bùi Gia Minh', 4.5, 5.0, 6.0],
  ];
  const rounded = students.map((s) => Math.round(((s[1] + s[2] + s[3]) / 3) * 100) / 100);
  const t = await workbook('gradebook', (ws) => {
    ws.addRow(['Student', 'Math', 'Literature', 'English', 'Average']);
    students.forEach((s, i) => ws.addRow([...s, { formula: `ROUND(AVERAGE(B${i + 2}:D${i + 2}),2)`, result: rounded[i]! }]));
    const mean = (k: 1 | 2 | 3): number => sum(students.map((s) => s[k])) / students.length;
    ws.addRow([
      'Class average',
      { formula: 'AVERAGE(B2:B9)', result: mean(1) },
      { formula: 'AVERAGE(C2:C9)', result: mean(2) },
      { formula: 'AVERAGE(D2:D9)', result: mean(3) },
      { formula: 'AVERAGE(E2:E9)', result: sum(rounded) / students.length },
    ]);
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [8]);
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 8, 'was 9');
  assert.equal(r.columns[1]!.sum, 59, 'was 66.375');
  const over7 = runQuery(r, { filters: [{ column: 'Math', op: 'gt', value: '7' }], aggregate: 'count' });
  assert.equal(over7.result, 5, 'the class average of 7.375 was counted as a student over 7');
  assert.ok(!r.columns[0]!.categories?.includes('Class average'), '"list the students" named the class average');
});

test('a Vietnamese class list ending in "Trung bình" totals its students only', async () => {
  const t = await workbook('lop-11b', (ws) => {
    ws.addRow(['Họ tên', 'Điểm Toán']);
    for (const s of [['Nguyễn An', 8], ['Trần Bình', 6.5], ['Lê Chi', 9], ['Phạm Dũng', 5.5]] as const) ws.addRow([...s]);
    ws.addRow(['Trung bình', { formula: 'AVERAGE(B2:B5)', result: 7.25 }]);
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [4]);
  assert.equal(r.columns[1]!.sum, 29, 'was 36.25');
});

// ── more of the same shape ──────────────────────────────────────────────────

test('Total, Average, Max and Min under the same rows are all summaries', () => {
  const r = region('budget-stats', [
    ['Month', 'Rent', 'Food'],
    ['Jan', 4500, 3200],
    ['Feb', 4500, 2900],
    ['Mar', 4500, 3500],
    ['Total', 13500, 9600],
    ['Average', 4500, 3200],
    ['Max', 4500, 3500],
    ['Min', 4500, 2900],
  ]);
  assert.deepEqual(r.summaryRows, [3, 4, 5, 6]);
  assert.equal(r.columns[2]!.sum, 9600);
  assert.equal(r.columns[2]!.max, 3500);
});

test('an average saved to CSV as displayed, rounded, is still the average', () => {
  // Excel writes what the cell shows: 3216.67 under a whole-number format is "3,217".
  const r = region('rounded', [
    ['Month', 'Food'],
    ['Jan', '3,200'],
    ['Feb', '2,900'],
    ['Mar', '3,550'],
    ['Total', '9,650'],
    ['Average', '3,217'],
  ]);
  assert.deepEqual(r.summaryRows, [3, 4]);
  assert.equal(r.columns[1]!.sum, 9650);
});

test('Subtotal run twice writes an Average and a Total under each group; both are found', () => {
  const r = region('double-subtotal', [
    ['Category', 'Item', 'Amount'],
    ['Food', 'Groceries', 320],
    ['Food', 'Restaurants', 180],
    ['Food Average', null, 250],
    ['Food Total', null, 500],
    ['Housing', 'Rent', 1500],
    ['Housing', 'Utilities', 210],
    ['Housing Average', null, 855],
    ['Housing Total', null, 1710],
    ['Grand Average', null, 552.5],
    ['Grand Total', null, 2210],
  ]);
  assert.deepEqual(r.summaryRows, [2, 3, 6, 7, 8, 9], '"Food Total" under "Food Average" was a record');
  assert.equal(r.columns[2]!.sum, 2210);
});

test('Vietnamese summary rows: "Điểm trung bình lớp", "Cao nhất", "Thấp nhất"', () => {
  const r = region('diem', [
    ['STT', 'Họ tên', 'Toán', 'Văn'],
    [1, 'An', 8, 7],
    [2, 'Bình', 6.5, 8],
    [3, 'Chi', 9, 6],
    [null, 'Điểm trung bình lớp', 7.83, 7],
    [null, 'Cao nhất', 9, 8],
    [null, 'Thấp nhất', 6.5, 6],
  ]);
  assert.deepEqual(r.summaryRows, [3, 4, 5]);
  assert.equal(r.columns[2]!.sum, 23.5);
});

// ── records that only look like summaries ───────────────────────────────────

test('a record called Average, Trung bình or Max stays a record', () => {
  // A grade band in the middle of the scale.
  const bands = region('bands', [['Grade', 'Students'], ['Excellent', 5], ['Good', 10], ['Average', 8], ['Poor', 2]]);
  assert.equal(bands.summaryRows, undefined);
  assert.equal(bands.columns[1]!.sum, 25);

  // The Vietnamese grading scale ends its passing grades with "Trung bình".
  const xepLoai = region('xep-loai', [['Xếp loại', 'Số HS'], ['Giỏi', 10], ['Khá', 15], ['Trung bình', 8]]);
  assert.equal(xepLoai.summaryRows, undefined);

  // A table of statistics is records, whatever its labels say.
  const stats = region('stats', [['Statistic', 'Value'], ['Count', 10], ['Mean', 5.5], ['Max', 10], ['Min', 1]]);
  assert.equal(stats.summaryRows, undefined);
  assert.equal(stats.columns[1]!.sum, 26.5);

  // Max is a name. Last in the list, with the top score so far, he is still a student.
  const names = region('names', [['Name', 'Score'], ['Anna', 8], ['Ben', 9], ['Max', 9]]);
  assert.equal(names.summaryRows, undefined);
  const totalled = region('names-total', [['Name', 'Score'], ['Anna', 8], ['Ben', 9], ['Max', 9], ['Total', 26]]);
  assert.deepEqual(totalled.summaryRows, [3], 'only the Total');

  // "Monthly average" whose figure is not the average of anything above is a line item.
  const lines = region('lines', [['Line', 'Amount'], ['Rent', 1200], ['Food', 400], ['Monthly average', 950]]);
  assert.equal(lines.summaryRows, undefined);
});

// ── ties that only look like statistics ─────────────────────────────────────

test('a product line under its base model, with the same figure, stays a record', async () => {
  const phones = await workbook('iphone', (ws) => {
    ws.addRow(['Model', 'Year']);
    for (const m of [['iPhone 15', 2023], ['iPhone 15 Pro', 2023], ['iPhone 15 Pro Max', 2023], ['iPhone 16', 2024]] as const) ws.addRow([...m]);
  });
  assert.equal(phones.regions[0]!.summaryRows, undefined, '"iPhone 15 Pro Max" was the highest of "iPhone 15 Pro"');
  assert.equal(phones.regions[0]!.columns[1]!.sum, 8093, 'was 6070');

  const audio = await workbook('airpods', (ws) => {
    ws.addRow(['Product', 'Qty']);
    for (const m of [['AirPods', 10], ['AirPods Max', 10], ['AirPods Pro', 25], ['Beats', 7]] as const) ws.addRow([...m]);
  });
  assert.equal(audio.regions[0]!.summaryRows, undefined);
  assert.equal(audio.regions[0]!.columns[1]!.sum, 52, 'was 42');

  // Excel's own Subtotal still is one, down to a group of a single record: its average
  // is found where the group plainly starts, under the previous group's.
  const r = region('one-record-group', [
    ['Category', 'Item', 'Amount'],
    ['Food', 'Groceries', 320],
    ['Food', 'Restaurants', 180],
    ['Food Average', null, 250],
    ['Rent', 'Flat', 1500],
    ['Rent Average', null, 1500],
    ['Grand Average', null, 666.67],
  ]);
  assert.deepEqual(r.summaryRows, [2, 4, 5]);
  assert.equal(r.columns[2]!.sum, 2000);
});

test('a rating scale stays whole: survey answers, "Below average", and the ends of a risk scale', async () => {
  // 16 is the mean of 12 and 20, and "Below average" ends the list.
  const csvLikert = region('likert', [['Rating', 'Responses'], ['Excellent', '12'], ['Good', '20'], ['Average', '16'], ['Below average', '4']]);
  assert.equal(csvLikert.summaryRows, undefined, '"Average" was left out');
  assert.equal(csvLikert.columns[1]!.sum, 52, 'was 36');
  const xlsxLikert = await workbook('likert-x', (ws) => {
    ws.addRow(['Rating', 'Responses']);
    for (const m of [['Excellent', 12], ['Good', 20], ['Average', 16], ['Below average', 4]] as const) ws.addRow([...m]);
  });
  assert.equal(xlsxLikert.regions[0]!.summaryRows, undefined);

  // Three answers above it, and the mean of them all.
  const wider = region('likert-5', [['Rating', 'Responses'], ['Excellent', 10], ['Very good', 20], ['Good', 15], ['Average', 15], ['Below average', 5]]);
  assert.equal(wider.summaryRows, undefined);

  // The last of only two answers above it, ending the list.
  const short = region('likert-3', [['Rating', 'Responses', 'Share'], ['Excellent', '12', '25%'], ['Good', '20', '41.7%'], ['Average', '16', '33.3%']]);
  assert.equal(short.summaryRows, undefined);
  assert.equal(short.columns[1]!.sum, 48);

  // A scale that names its ends: "Highest" ties "High" and is the top level, not a maximum.
  const risk = region('risk', [['Level', 'Score'], ['Lowest', 1], ['Low', 2], ['Medium', 3], ['High', 4], ['Highest', 4]]);
  assert.equal(risk.summaryRows, undefined, '"Highest" was left out');
  assert.equal(risk.columns[1]!.sum, 14);
});

test('students called Max and Min are students, even with the best and worst marks', () => {
  const r = region('class', [['Name', 'Score'], ['Anna', 7], ['Ben', 9], ['Chi', 8], ['Max', 9], ['Min', 7]]);
  assert.equal(r.summaryRows, undefined, 'Max and Min were left out as the highest and lowest');
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 5);
});

test('a workbook figure rounded to one place is not the average of figures that need two', async () => {
  // 0.2 is not the 0.18 above it; a share band called "Average" is one more band.
  const t = await workbook('bands', (ws) => {
    ws.addRow(['Band', 'Share']);
    for (const m of [['Excellent', 0.15], ['Good', 0.2], ['Fair', 0.19], ['Average', 0.2]] as const) ws.addRow([...m]);
  });
  assert.equal(t.regions[0]!.summaryRows, undefined);
  assert.equal(Number(t.regions[0]!.columns[1]!.sum!.toFixed(2)), 0.74);
});
