/**
 * What the 4 October review found ingest and the engine still getting wrong, once all of
 * that round's fixes ran together:
 *
 *   - An Average row rounded the way a workbook rounds it — ROUND(AVERAGE(…), 0) under a
 *     budget, ROUND(…, 1) in a Vietnamese gradebook — was counted as a record, and the
 *     Highest, Lowest and Count rows under it went with it.
 *   - The new refusal of a total of a rate refused real totals: a trip's cost per person,
 *     a budget of monthly averages, and shares not named in English.
 *   - Footnote marks "(1)", "(2)" under "Ghi chú" read as minus one and minus two.
 *   - A cash-flow statement's "Net cash …" subtotals counted as lines.
 *   - "Prepared by: | Jordan Lee" beside each other, and a heading laid out in two columns,
 *     each made extra records or extra tables.
 *
 * The workbooks are built here the way Excel writes them, formulas and cached results
 * included; the CSV files as Excel exports them. Every truth is worked out from the rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { readSpreadsheet } from '../src/ingest/read.ts';
import { noTotal, rateLike, runQuery, sumCaution } from '../src/query/engine.ts';
import { createHandler } from '../src/server.ts';
import type { IndexTable, LandmarkIndex } from '../src/indexfmt.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const dir = await mkdtemp(join(tmpdir(), 'landmark-repair2-'));

async function workbook(name: string, fill: (ws: ExcelJS.Worksheet) => void): Promise<IndexTable> {
  const wb = new ExcelJS.Workbook();
  fill(wb.addWorksheet(name));
  const path = join(dir, `${name}.xlsx`);
  await wb.xlsx.writeFile(path);
  return buildTable(await readSpreadsheet(path));
}

async function csv(name: string, text: string): Promise<IndexTable> {
  const path = join(dir, `${name}.csv`);
  await writeFile(path, text, 'utf8');
  return buildTable(await readSpreadsheet(path));
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

let sessions = 0;
/** Ask the real handler, the way a host does. */
function host(index: LandmarkIndex) {
  const handler = createHandler({ index });
  const session = `repair2-ingest-${++sessions}`;
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
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
}

/** The voice client over an index, as the page drives it. */
async function voice(index: LandmarkIndex, opener: string) {
  const call = host(index);
  resetContext();
  await loadCatalogue(call);
  const say = async (u: string) => (await converse(u, call)) as { plan: { args?: Record<string, unknown> }; payload: Record<string, unknown> | null; spoken: string };
  await say(opener);
  return say;
}

// ── averages a workbook rounds ───────────────────────────────────────────────

test('a budget Average row from ROUND(AVERAGE(), 0) is a summary, and so are the Highest, Lowest and Count rows under it', async () => {
  const months: [string, number, number, number][] = [
    ['Jan', 1250, 3210, 415],
    ['Feb', 1250, 2985, 388],
    ['Mar', 1300, 3340, 402],
    ['Apr', 1300, 3105, 371],
    ['May', 1300, 3475, 456],
    ['Jun', 1350, 3190, 433],
  ];
  const col = (k: 1 | 2 | 3) => months.map((m) => m[k]);
  // Not a whole number in any column, so only the rounding makes it match.
  for (const k of [1, 2, 3] as const) assert.notEqual(sum(col(k)) / months.length, Math.round(sum(col(k)) / months.length));
  const letter = ['', 'B', 'C', 'D'];
  const t = await workbook('home-budget', (ws) => {
    ws.addRow(['Month', 'Rent', 'Food', 'Transport']);
    for (const m of months) ws.addRow([...m]);
    const row = (label: string, fn: string, value: (xs: number[]) => number) =>
      ws.addRow([label, ...([1, 2, 3] as const).map((k) => ({ formula: fn.replace('X', `${letter[k]}2:${letter[k]}7`), result: value(col(k)) }))]);
    row('Total', 'SUM(X)', sum);
    row('Average', 'ROUND(AVERAGE(X),0)', (xs) => Math.round(sum(xs) / xs.length));
    row('Highest', 'MAX(X)', (xs) => Math.max(...xs));
    row('Lowest', 'MIN(X)', (xs) => Math.min(...xs));
    row('Count', 'COUNT(X)', (xs) => xs.length);
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [6, 7, 8, 9, 10]);
  assert.equal(runQuery(r, { aggregate: 'count' }).result, months.length);
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Food' }).result, sum(col(2)));
  assert.equal(runQuery(r, { aggregate: 'min', aggregateColumn: 'Transport' }).result, Math.min(...col(3)));
  assert.ok(!r.columns[0]!.categories?.some((v) => ['Average', 'Highest', 'Lowest', 'Count'].includes(String(v))));
});

test('a Vietnamese gradebook\'s class average, rounded to one place, is a summary, with Cao nhất and Thấp nhất under it', async () => {
  const students: [string, number, number, number][] = [
    ['Nguyễn Hoàng An', 8.5, 7.0, 9.0],
    ['Trần Thị Bình', 9.5, 8.5, 8.0],
    ['Lê Minh Đức', 6.0, 7.5, 5.5],
    ['Phạm Gia Hân', 7.5, 6.5, 7.0],
    ['Hồ Ngọc Phương', 9.0, 9.0, 9.5],
    ['Bùi Quốc Nam', 4.5, 5.5, 4.5],
    ['Đặng Thùy Linh', 8.0, 8.5, 9.0],
    ['Vũ Thanh Tâm', 5.5, 6.0, 6.5],
  ];
  const col = (k: 1 | 2 | 3) => students.map((s) => s[k]);
  const letter = ['', 'B', 'C', 'D'];
  const t = await workbook('lop-10a2', (ws) => {
    ws.addRow(['Họ và tên', 'Toán', 'Ngữ văn', 'Tiếng Anh']);
    for (const s of students) ws.addRow([...s]);
    const row = (label: string, fn: string, value: (xs: number[]) => number) =>
      ws.addRow([label, ...([1, 2, 3] as const).map((k) => ({ formula: fn.replace('X', `${letter[k]}2:${letter[k]}9`), result: value(col(k)) }))]);
    row('Điểm trung bình lớp', 'ROUND(AVERAGE(X),1)', (xs) => Math.round((sum(xs) / xs.length) * 10) / 10);
    row('Cao nhất', 'MAX(X)', (xs) => Math.max(...xs));
    row('Thấp nhất', 'MIN(X)', (xs) => Math.min(...xs));
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [8, 9, 10]);
  assert.equal(runQuery(r, { aggregate: 'count' }).result, students.length);
  assert.equal(runQuery(r, { aggregate: 'avg', aggregateColumn: 'Toán' }).result, sum(col(1)) / students.length);
  const lowest = runQuery(r, { aggregate: 'min', aggregateColumn: 'Toán' });
  assert.equal(lowest.result, Math.min(...col(1)));
  assert.equal(lowest.winnerCount, 1, 'the "Thấp nhất" row tied the lowest student');
});

test('a one-column figure rounded to one place, with nothing else to say what it is, is still a record', async () => {
  // The band called "Average" ties nothing exactly, and nothing above it is a summary.
  const t = await workbook('bands-again', (ws) => {
    ws.addRow(['Band', 'Share']);
    for (const m of [['Excellent', 0.15], ['Good', 0.2], ['Fair', 0.19], ['Average', 0.2]] as const) ws.addRow([...m]);
  });
  assert.equal(t.regions[0]!.summaryRows, undefined);
});

// ── a total that may be a real one ─────────────────────────────────────────

test('a total of figures per person, or of averages, is given when asked for, and said to add them up', async () => {
  const trip = await csv(
    'trip-budget',
    'Day,Activity,Cost per person (USD)\nDay 1,Airport transfer,25\nDay 1,Hotel night 1,60\nDay 2,Ha Long Bay cruise,120\nDay 2,Hotel night 2,60\nDay 3,Cooking class,45\nDay 3,Street food tour,30\n',
  );
  const household = await csv(
    'household-averages',
    'Category,Average monthly spend\nRent,1200\nGroceries,450\nUtilities,180\nTransport,220\nPhone and internet,65\nEntertainment,140\n',
  );
  const cost = trip.regions[0]!.columns[2]!;
  assert.equal(noTotal(cost, trip.regions[0]!), null);
  assert.equal(sumCaution(cost, trip.regions[0]!), 'a per-person figure');

  const call = host(buildIndex([trip, household]));
  const total = await call('table_query', { table_id: 'trip-budget', aggregate: 'sum', aggregate_column: 'Cost per person (usd)' });
  assert.equal(total['isError'], false, String(total['spoken']));
  assert.equal(total['result'], 340);
  assert.equal(total['spoken'], '340. That adds up Cost per person (usd) across 6 rows, each of them a per-person figure.');
  const monthly = await call('table_query', { table_id: 'household-averages', aggregate: 'sum', aggregate_column: 'Average monthly spend' });
  assert.equal(monthly['result'], 2255);
  assert.match(String(monthly['spoken']), /That adds up Average monthly spend across 6 rows, each of them an average\.$/);
  // Neither is described as having no total, so the voice client asks for the total.
  const described = await call('table_describe', { table_id: 'trip-budget' });
  assert.ok((described['columns'] as { no_total?: string }[]).every((c) => c.no_total === undefined));

  for (const q of ['what is the total', 'what is the total cost per person', 'how much will the trip cost per person']) {
    const say = await voice(buildIndex([trip]), 'open the trip budget file');
    const t = await say(q);
    assert.equal(t.payload?.['result'], 340, `${q}: ${t.spoken}`);
    assert.doesNotMatch(t.spoken, /cannot be added up/, q);
  }
});

test('a share of the whole adds up in Vietnamese and as ownership; a per-capita figure is still refused', async () => {
  const shares = await csv('ty-trong', 'Nhóm hàng,Doanh thu,Tỷ trọng (%)\nĐồ uống,"450.000.000",45%\nBánh ngọt,"300.000.000",30%\nQuà tặng,"250.000.000",25%\n');
  const cap = await csv('cap-table', 'Shareholder,Shares,Ownership %\nA. Nguyen,6000,60%\nB. Tran,2500,25%\nC. Le,1500,15%\n');
  const mix = await csv('co-cau', 'Khoản,Cơ cấu (%)\nLương,55%\nThuê nhà,30%\nKhác,15%\n');
  const margins = await csv('margins', 'Product,Margin 2026 (%)\nCoffee,35%\nTea,27%\nCocoa,22%\n');
  for (const t of [shares, cap, mix]) {
    const r = t.regions[0]!;
    const c = r.columns[r.columns.length - 1]!;
    assert.equal(rateLike(c, r), null, c.spoken);
    assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: c.spoken }).result, 100, c.spoken);
  }
  // A percentage of each row's own — a margin — has no total still.
  assert.equal(noTotal(margins.regions[0]!.columns[1]!, margins.regions[0]!), 'a percentage');
  const countries = await csv('per-capita', 'Country,GDP per capita (USD)\nVietnam,4347\nThailand,7297\n');
  assert.throws(
    () => runQuery(countries.regions[0]!, { aggregate: 'sum', aggregateColumn: 'GDP per capita (usd)' }),
    /is a per-capita figure, so adding it up across rows gives no real total/,
  );
  const say = await voice(buildIndex([shares]), 'open the ty trong file');
  const total = await say('what is the total ty trong');
  assert.equal(total.payload?.['result'], 100, total.spoken);
});

// ── footnote marks ─────────────────────────────────────────────────────────

test('footnote marks under "Ghi chú" are text, and never offered as a figure to total', async () => {
  const t = await csv(
    'chi-tieu-ghichu',
    '﻿Khoản mục,Số tiền,Ghi chú\nTiền nhà,"5.000.000",(1)\nĐiện nước,"1.200.000",\nĂn uống,"4.500.000",(2)\nĐi lại,"800.000",\nHọc phí,"3.000.000",(3)\n',
  );
  const notes = t.regions[0]!.columns[2]!;
  assert.equal(notes.kind, 'text');
  assert.equal(notes.sum, undefined);
  assert.deepEqual(notes.categories, ['(1)', '(2)', '(3)']);
  for (const [heading, marks] of [['Remarks', '(1)'], ['Comments', '(2)'], ['Chú thích', '(3)'], ['Footnotes', '(4)']] as const) {
    const other = await csv(`notes-${heading}`, `Item,Amount,${heading}\nA,10,${marks}\nB,20,\n`);
    assert.equal(other.regions[0]!.columns[2]!.kind, 'text', heading);
  }
  const say = await voice(buildIndex([t]), 'open the chi tieu ghichu file');
  const total = await say('what is the total');
  assert.equal(total.plan.args?.['aggregate_column'], 'Số tiền', `was "Which column? I have Số tiền and Ghi chú": ${total.spoken}`);
  assert.equal(total.payload?.['result'], 14500000);
});

// ── a cash-flow statement ───────────────────────────────────────────────────

test('a cash-flow statement\'s "Net cash …" subtotals and its net change are left out of the lines', async () => {
  const lines: [string, string, number, number | null][] = [
    ['Net income', '', 4820, 3950],
    ['Depreciation', '(7)', 1240, 1180],
    ['Change in receivables', '', -615, -240],
    ['Change in inventory', '(8)', -1, 310],
    ['Change in payables', '', 402, null],
    ['Purchase of equipment', '(9)', -2750, -1980],
    ['Proceeds from asset sales', '', 120, -45],
    ['Dividends paid', '', -1000, -900],
    ['Loan repayments', '(12)', -450, -450],
  ];
  const t = await csv(
    'cash-flow-fy26',
    [
      'Northwind Traders Ltd,,,',
      'Statement of Cash Flows,,,',
      'For the year ended 30 June 2026,,,',
      '(in thousands of USD),,,',
      ',,,',
      'Line item,Note,FY2026,FY2025',
      'Net income,,"4,820","3,950"',
      'Depreciation,(7),"1,240","1,180"',
      'Change in receivables,,(615),(240)',
      'Change in inventory,(8),(1),"310"',
      'Change in payables,,"402",-',
      'Net cash from operating activities,,"5,846","5,200"',
      'Purchase of equipment,(9),"(2,750)","(1,980)"',
      'Proceeds from asset sales,,"120",(45)',
      'Net cash used in investing activities,,"(2,630)","(2,025)"',
      'Dividends paid,,"(1,000)",(900)',
      'Loan repayments,(12),(450),(450)',
      'Net cash used in financing activities,,"(1,450)","(1,350)"',
      'Net change in cash,,"1,766","1,825"',
      '',
    ].join('\n'),
  );
  const r = t.regions[0]!;
  assert.equal(r.summaryRows?.length, 4, 'three "Net cash …" subtotals and the net change');
  assert.equal(runQuery(r, { aggregate: 'count' }).result, lines.length);
  const fy26 = r.columns.find((c) => c.spoken === 'Fy2026')!.spoken;
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: fy26 }).result, sum(lines.map((l) => l[2])));
  assert.equal(
    runQuery(r, { filters: [{ column: fy26, op: 'lt', value: '0' }], aggregate: 'count' }).result,
    lines.filter((l) => l[2] < 0).length,
  );
  assert.equal(lines.filter((l) => l[2] < 0).length, 5);
});

// ── sign-offs and headings laid out in pairs ───────────────────────────────

const EXPENSES: [string, string, number][] = [
  ['Flight', 'Travel', 189.5],
  ['Hotel', 'Lodging', 140],
  ['Dinner', 'Meals', 76.25],
  ['Taxi', 'Travel', 18.4],
  ['Flight back', 'Travel', 172],
];

test('"Prepared by: | Jordan Lee | Approved by: | Sam Park" is a sign-off, attached or after a blank row', async () => {
  const layouts: [string, (ws: ExcelJS.Worksheet) => void][] = [
    ['attached-pairs', (ws) => { ws.addRow(['Prepared by:', 'Jordan Lee']); ws.addRow(['Approved by:', 'Sam Park']); }],
    ['detached-pairs', (ws) => { ws.addRow([]); ws.addRow(['Prepared by:', 'Jordan Lee']); ws.addRow(['Approved by:', 'Sam Park']); }],
    ['detached-oneline', (ws) => { ws.addRow([]); ws.addRow(['Prepared by:', 'Jordan Lee', 'Approved by:', 'Sam Park']); }],
    ['attached-oneline', (ws) => { ws.addRow(['Prepared by:', 'Jordan Lee', 'Approved by:', 'Sam Park']); ws.addRow(['Signature:', null, 'Signature:', null]); }],
  ];
  for (const [name, signOff] of layouts) {
    const t = await workbook(name, (ws) => {
      ws.addRow(['Description', 'Category', 'Amount']);
      for (const e of EXPENSES) ws.addRow([...e]);
      ws.addRow(['Total', null, { formula: 'SUM(C2:C6)', result: sum(EXPENSES.map((e) => e[2])) }]);
      signOff(ws);
    });
    assert.equal(t.regions.length, 1, `${name}: the sign-off became a table`);
    const r = t.regions[0]!;
    assert.equal(runQuery(r, { aggregate: 'count' }).result, EXPENSES.length, name);
    assert.ok(!r.columns[1]!.categories?.some((v) => /Jordan|Sam/.test(String(v))), `${name}: a name was read as a category`);
    assert.ok(t.warnings.some((w) => /Prepared by: Jordan Lee/.test(w) && /Approved by: Sam Park/.test(w)), `${name}: ${t.warnings.join(' | ')}`);
  }
  // A record whose cells merely start the same way is still a record.
  const tasks = await workbook('tasks', (ws) => {
    ws.addRow(['Task', 'Status', 'Hours']);
    ws.addRow(['Draft', 'Open', 3]);
    ws.addRow(['Review', 'Approved by board', 2]);
    ws.addRow(['Ship', 'Open', 4]);
  });
  assert.equal(runQuery(tasks.regions[0]!, { aggregate: 'count' }).result, 3);
});

test('a heading laid out in two columns above the table is one heading, not a table of its own', async () => {
  const vn = await workbook('bang-ke-thuong', (ws) => {
    ws.addRow(['CÔNG TY CP THƯƠNG MẠI MINH AN', null, null, null, 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM']);
    ws.addRow(['Phòng Tài chính - Kế toán', null, null, null, 'Độc lập - Tự do - Hạnh phúc']);
    ws.addRow([]);
    ws.addRow(['BẢNG KÊ THANH TOÁN TIỀN THƯỞNG QUÝ III/2026']);
    ws.mergeCells('A4:E4');
    ws.addRow([]);
    ws.addRow(['STT', 'Họ và tên', 'Chức vụ', 'Mức thưởng', 'Thực nhận']);
    ws.addRow([1, 'Nguyễn Minh Anh', 'Trưởng phòng', 8000000, 8000000]);
    ws.addRow([2, 'Trần Quốc Bảo', 'Kế toán trưởng', 6500000, 6500000]);
    ws.addRow([3, 'Lê Thị Cúc', 'Nhân viên', 4000000, 4000000]);
  });
  assert.equal(vn.regions.length, 1, vn.regions.map((r) => r.title).join(' | '));
  assert.equal(vn.regions[0]!.title, 'BẢNG KÊ THANH TOÁN TIỀN THƯỞNG QUÝ III/2026');
  assert.equal(runQuery(vn.regions[0]!, { aggregate: 'count' }).result, 3);
  assert.ok(vn.warnings.some((w) => /Độc lập - Tự do - Hạnh phúc/.test(w)));

  const en = await workbook('travel-expenses', (ws) => {
    ws.addRow(['Travel Expense Report — September 2026']);
    ws.addRow(['Employee: Jordan Lee', null, 'Department: Field Sales']);
    ws.addRow([]);
    ws.addRow(['Description', 'Category', 'Amount']);
    for (const e of EXPENSES) ws.addRow([...e]);
  });
  assert.equal(en.regions.length, 1, en.regions.map((r) => r.title).join(' | '));
  assert.equal(en.regions[0]!.title, 'Travel Expense Report — September 2026');
  assert.equal(runQuery(en.regions[0]!, { aggregate: 'count' }).result, EXPENSES.length);
  assert.ok(en.warnings.some((w) => /Department: Field Sales/.test(w)));
  // Two small tables side by side above another are still tables.
  const side = await workbook('side-by-side', (ws) => {
    ws.addRow(['Store', 'Staff', null, 'City', 'Stores']);
    ws.addRow(['A', 3, null, 'Hanoi', 2]);
    ws.addRow(['B', 4, null, 'Hue', 1]);
    ws.addRow([]);
    ws.addRow(['Item', 'Qty']);
    ws.addRow(['Pen', 10]);
    ws.addRow(['Ink', 5]);
  });
  assert.equal(side.regions.length, 3);
});
