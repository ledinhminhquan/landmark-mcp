/**
 * What sits around a report's table: who signs it off, and what it is called.
 *
 * A Vietnamese payroll ends with the date, "Người lập biểu", "Kế toán trưởng", "Giám
 * đốc", "(Ký, họ tên)" and the names. Each block became a table of its own, so the file
 * "held 4 tables", describe named three that do not exist, and every answer added "That
 * covers only the first of 4 tables". And the report was called by its company line,
 * "CÔNG TY TNHH ABC", while its title, "BẢNG LƯƠNG THÁNG 9/2026", was kept as a note.
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
import type { IndexTable } from '../src/indexfmt.ts';

type Cell = string | number | boolean | null;

const dir = await mkdtemp(join(tmpdir(), 'landmark-layout2-'));

async function workbook(name: string, fill: (ws: ExcelJS.Worksheet) => void): Promise<IndexTable> {
  const wb = new ExcelJS.Workbook();
  fill(wb.addWorksheet(name));
  const path = join(dir, `${name}.xlsx`);
  await wb.xlsx.writeFile(path);
  return buildTable(await readSpreadsheet(path));
}

const grid = (name: string, rows: Cell[][]): IndexTable =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid: rows, merges: [] }], warnings: [] });

const PAYROLL: [string, string, number, number][] = [
  ['Nguyễn Văn Tâm', 'Giám đốc', 30000000, 5000000],
  ['Lê Thị Hoa', 'Kế toán', 15000000, 2000000],
  ['Trần Minh Khang', 'Nhân viên', 9000000, 1000000],
  ['Phạm Thu Trang', 'Nhân viên', 9500000, 1000000],
  ['Võ Đức Thịnh', 'Bảo vệ', 6000000, 500000],
];

/** A payroll as an accountant lays it out in Excel, sign-off and all. */
function payroll(ws: ExcelJS.Worksheet, gap: boolean): void {
  ws.addRow(['CÔNG TY TNHH ABC']);
  ws.addRow(['BẢNG LƯƠNG THÁNG 9/2026']);
  ws.mergeCells('A2:F2');
  ws.addRow(['Đơn vị tính: đồng']);
  ws.addRow([]);
  ws.addRow(['STT', 'Họ và tên', 'Chức vụ', 'Lương cơ bản', 'Phụ cấp', 'Thực lĩnh']);
  PAYROLL.forEach((p, i) => ws.addRow([i + 1, ...p, { formula: `D${i + 6}+E${i + 6}`, result: p[2] + p[3] }]));
  ws.addRow(['Tổng cộng', null, null, { formula: 'SUM(D6:D10)', result: 69500000 }, { formula: 'SUM(E6:E10)', result: 9500000 }, { formula: 'SUM(F6:F10)', result: 79000000 }]);
  ws.mergeCells('A11:C11');
  if (gap) ws.addRow([]);
  ws.addRow([null, null, null, null, 'Ngày 30 tháng 9 năm 2026']);
  ws.addRow(['Người lập biểu', null, 'Kế toán trưởng', null, 'Giám đốc']);
  ws.addRow(['(Ký, họ tên)', null, '(Ký, họ tên)', null, '(Ký, ghi rõ họ tên)']);
  ws.addRow([]);
  ws.addRow([]);
  ws.addRow(['Lê Thị Hoa', null, 'Lê Thị Hoa', null, 'Nguyễn Văn Tâm']);
}

test('a payroll signed off under its table is one table, called by its title', async () => {
  const t = await workbook('bang-luong', (ws) => payroll(ws, true));
  assert.equal(t.regions.length, 1, 'was 4: "Người lập biểu", "Kế toán trưởng" and the date were tables');
  assert.ok(!t.warnings.some((w) => /separate tables/.test(w)), t.warnings.join(' | '));
  const r = t.regions[0]!;
  assert.equal(r.title, 'BẢNG LƯƠNG THÁNG 9/2026', 'was "CÔNG TY TNHH ABC"');
  assert.equal(r.rowCount, 6);
  assert.equal(r.columns[5]!.sum, 79000000);
  // The sign-off is kept, once, as a note: who signed is worth knowing.
  const signOff = t.warnings.filter((w) => /Người lập biểu/.test(w));
  assert.equal(signOff.length, 1, t.warnings.join(' | '));
  assert.match(signOff[0]!, /Ngày 30 tháng 9 năm 2026\. Người lập biểu; Kế toán trưởng; Giám đốc\. Lê Thị Hoa; Lê Thị Hoa; Nguyễn Văn Tâm/);
  assert.doesNotMatch(signOff[0]!, /\(Ký/, 'where to sign is not what was signed');
  assert.ok(t.warnings.some((w) => /CÔNG TY TNHH ABC/.test(w)), 'the company line is a note');

  // No answer is said to cover "only the first of 4 tables".
  const handler = createHandler({ index: buildIndex([t]) });
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': 'ingest2-layout',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'table_query', arguments: { table_id: 'bang-luong', aggregate: 'sum', aggregate_column: 'Thực lĩnh' } },
      }),
    }),
  );
  const answer = (JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
  assert.equal(answer['result'], 79000000);
  assert.doesNotMatch(String(answer['spoken']), /tables/);
});

test('a sign-off typed straight under the total, with no blank row, is a note, not three records', async () => {
  const t = await workbook('bang-luong-lien', (ws) => payroll(ws, false));
  assert.equal(t.regions.length, 1, t.regions.map((r) => r.id).join(', '));
  const r = t.regions[0]!;
  assert.equal(r.rowCount, 6, 'the date, titles and "(Ký, họ tên)" were records');
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 5);
  assert.ok(!r.columns[2]!.categories?.includes('Kế toán trưởng'), 'Chức vụ stays a column of job titles');
  assert.ok(t.warnings.some((w) => /A note under a table .*Người lập biểu/.test(w)), t.warnings.join(' | '));
});

test('an English report signed "Prepared by" and "Approved by" is one table', async () => {
  const t = await workbook('inventory', (ws) => {
    ws.addRow(['Inventory Report — Warehouse 2']);
    ws.mergeCells('A1:E1');
    ws.addRow(['Exported: 30/09/2026 17:42']);
    ws.mergeCells('A2:E2');
    ws.addRow([]);
    ws.addRow(['SKU', 'Item', 'Unit', 'Qty on hand', 'Unit cost']);
    ws.addRow(['SKU-1001', 'Ballpoint pen, blue', 'box', 120, 45000]);
    ws.addRow(['SKU-1002', 'A4 paper, 80gsm', 'ream', 85, 72000]);
    ws.addRow(['SKU-1003', 'Stapler, medium', 'pcs', 30, 95000]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow(['Prepared by', null, null, 'Approved by']);
    ws.addRow(['(signature, full name)', null, null, '(signature, full name)']);
    ws.addRow([]);
    ws.addRow(['Nguyễn Thị Mai', null, null, 'Trần Văn Long']);
  });
  assert.equal(t.regions.length, 1, 'was 3');
  assert.equal(t.regions[0]!.title, 'Inventory Report — Warehouse 2');
  assert.ok(t.warnings.some((w) => /Prepared by; Approved by\. Nguyễn Thị Mai; Trần Văn Long/.test(w)), t.warnings.join(' | '));
});

test('text under a table that signs nothing off is still what it was', () => {
  // A small status table after the figures, as in the demo's three-region sheet.
  const status = grid('status', [
    ['Region', 'Target', 'Actual'],
    ['North', 10000, 12400],
    ['South', 9000, 3900],
    [null, null, null],
    ['Note', 'Status'],
    ['Q3 close', 'pending'],
  ]);
  assert.equal(status.regions.length, 2);

  // One "Approved by" in a record is a status, not a sign-off: the task stays a task.
  const tasks = grid('tasks', [
    ['Task', 'Status', 'Hours'],
    ['Draft budget', 'Done', 6],
    ['Review budget', 'Done', 3],
    ['Publish budget', 'Approved by finance', null],
  ]);
  assert.equal(tasks.regions[0]!.rowCount, 3);
});

test('a line that names the report is its title, over the company and the national motto', () => {
  const t = grid('bang-ke', [
    ['CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', null, null],
    ['Độc lập - Tự do - Hạnh phúc', null, null],
    ['BẢNG KÊ CHI PHÍ QUÝ 3/2026', null, null],
    [null, null, null],
    ['Khoản mục', 'Kế hoạch', 'Thực hiện'],
    ['Lương', 300000000, 310000000],
    ['Marketing', 50000000, 42500000],
  ]);
  assert.equal(t.regions.length, 1);
  assert.equal(t.regions[0]!.title, 'BẢNG KÊ CHI PHÍ QUÝ 3/2026');
  assert.ok(t.warnings.some((w) => /CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM/.test(w)));

  // With no line naming the report, the company still gives way to the line under it,
  // but never to a unit line.
  const units = grid('units', [
    ['CÔNG TY CP XYZ', null],
    ['Đơn vị tính: đồng', null],
    [null, null],
    ['Khoản mục', 'Số tiền'],
    ['Lương', 300000000],
    ['Thuê nhà', 50000000],
  ]);
  assert.equal(units.regions[0]!.title, 'CÔNG TY CP XYZ');

  // A report title further up outranks a unit line straight above the headings.
  const above = grid('above', [
    ['BÁO CÁO DOANH THU THÁNG 9', null],
    [null, null],
    ['Đơn vị tính: đồng', null],
    ['Chi nhánh', 'Doanh thu'],
    ['Hà Nội', 428000000],
    ['Đà Nẵng', 185000000],
  ]);
  assert.equal(above.regions[0]!.title, 'BÁO CÁO DOANH THU THÁNG 9');
  assert.ok(above.warnings.some((w) => /Đơn vị tính: đồng/.test(w)));
});

// ── what a sign-off is not ──────────────────────────────────────────────────

test('a record whose position is a signing title, or whose status starts "Approved by", stays a record', async () => {
  // The last two staff have no salary yet. "Kế toán trưởng" beside "Chi" is her post.
  const staff = await workbook('nhan-su', (ws) => {
    ws.addRow(['Họ tên', 'Chức vụ', 'Lương']);
    ws.addRow(['An', 'Giám đốc', 30000000]);
    ws.addRow(['Bình', 'Nhân viên', 10000000]);
    ws.addRow(['Chi', 'Kế toán trưởng', null]);
    ws.addRow(['Dung', 'Thủ quỹ', null]);
  });
  const r = staff.regions[0]!;
  assert.equal(r.rowCount, 4, 'was 2, with "Chi; Kế toán trưởng. Dung; Thủ quỹ" kept as a note');
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 4, '"how many staff" said 2');
  assert.ok(!staff.warnings.some((w) => /Thủ quỹ/.test(w)), staff.warnings.join(' | '));

  // A document tracker whose last two documents have no page count yet.
  const tracker = grid('tracker', [
    ['Doc', 'Status', 'Pages'],
    ['Plan', 'Draft', 12],
    ['Budget', 'Draft', 4],
    ['Policy', 'Approved by board', null],
    ['Memo', 'Reviewed by legal', null],
  ]);
  assert.equal(tracker.regions[0]!.rowCount, 4, 'the approved and reviewed documents were cut');
  assert.deepEqual(tracker.regions[0]!.columns[1]!.categories, ['Approved by board', 'Draft', 'Reviewed by legal']);

  // Written the way a sign-off is, "Approved by: CFO" beside a document's name is still
  // that document's status: the row has a cell that signs nothing.
  const colon = grid('tracker-colon', [
    ['Doc', 'Status', 'Pages'],
    ['Plan', 'Draft', 12],
    ['Budget', 'Draft', 4],
    ['Policy', 'Approved by: CFO', null],
    ['Memo', 'Reviewed by: legal', null],
  ]);
  assert.equal(colon.regions[0]!.rowCount, 4);
});

test('a small text table under the first is a table, though its rows read "Received by" or "Approved by"', () => {
  const orders = grid('orders', [
    ['Order', 'Qty', 'Price'],
    ['A-1001', 2, 50],
    ['A-1002', 1, 80],
    [null, null, null],
    ['Order', 'Status', null],
    ['A-1001', 'Received by customer', null],
    ['A-1002', 'Received by neighbour', null],
  ]);
  assert.equal(orders.regions.length, 2, 'the delivery table became a note');
  assert.equal(orders.regions[1]!.rowCount, 2);
  assert.ok(!orders.warnings.some((w) => /A note .*Received by/.test(w)), orders.warnings.join(' | '));

  const tasks = grid('tasks2', [
    ['Item', 'Qty'],
    ['Pen', 2],
    ['Book', 1],
    [null, null],
    ['Task', 'Owner'],
    ['Prepared by finance', 'Lan'],
    ['Approved by board', 'Minh'],
  ]);
  assert.equal(tasks.regions.length, 2, 'the task list became a note');
  assert.equal(tasks.regions[1]!.rowCount, 2);
});

test('"Prepared by:" and "Approved by:" typed straight under a table still sign it off', () => {
  const t = grid('signed', [
    ['Item', 'Qty', 'Cost'],
    ['Paper', 10, 50],
    ['Ink', 2, 70],
    ['Prepared by: J. Smith', null, 'Approved by:'],
  ]);
  assert.equal(t.regions[0]!.rowCount, 2);
  assert.ok(t.warnings.some((w) => /A note under a table .*Prepared by: J\. Smith; Approved by:/.test(w)), t.warnings.join(' | '));
});

// ── what a title is not ─────────────────────────────────────────────────────

test('a line under a title that mentions a report, a budget or a summary does not take the title', () => {
  const table: Cell[][] = [
    ['Region', 'Units', 'Revenue'],
    ['North', 120, 24000],
    ['South', 80, 16000],
  ];
  const cases: [string, string][] = [
    ['Sales by Region', 'Report generated 30/09/2026 by J. Smith'],
    ['Q3 Sales by Region', 'Source: finance team monthly report'],
    ['Marketing Spend Q3', 'Budget owner: Jane Doe'],
    ['Sales by Region', 'Exported from the inventory system on 30/09/2026'],
  ];
  for (const [title, line] of cases) {
    const t = grid('titled', [[title, null, null], [line, null, null], [null, null, null], ...table]);
    assert.equal(t.regions[0]!.title, title, `was "${line}"`);
    assert.ok(t.warnings.some((w) => w.includes(line)), `"${line}" is kept as a note`);
  }

  // A line under the title that ends like a document's name is still under the title.
  const subtitle = grid('subtitle', [['Marketing Spend Q3', null, null], ['Figures for the year-end budget', null, null], [null, null, null], ...table]);
  assert.equal(subtitle.regions[0]!.title, 'Marketing Spend Q3');

  // Straight above the headings, with no blank row between.
  const direct = grid('direct', [['Sales by Region', null, null], ['See the summary on the next sheet', null, null], ...table]);
  assert.equal(direct.regions[0]!.title, 'Sales by Region', 'was "See the summary on the next sheet"');

  // Under a company line, a dated byline is passed over for the line that reads as a title.
  const acme = grid('acme', [
    ['Acme Corp', null, null],
    ['Report generated 30/09/2026 by J. Smith', null, null],
    ['Regional sales', null, null],
    [null, null, null],
    ...table,
  ]);
  assert.equal(acme.regions[0]!.title, 'Regional sales');
});

test("on a sheet of two tables, each keeps its own caption under the sheet's title", () => {
  const t = grid('annual', [
    ['Annual Report 2026', null, null],
    [null, null, null],
    ['Revenue by region', null, null],
    [null, null, null],
    ['Region', 'Q1', 'Q2'],
    ['North', 10, 12],
    ['South', 8, 9],
    [null, null, null],
    ['Costs by department', null, null],
    [null, null, null],
    ['Dept', 'Q1', 'Q2'],
    ['Ops', 5, 6],
    ['IT', 3, 4],
  ]);
  assert.deepEqual(t.regions.map((r) => r.title), ['Revenue by region', 'Costs by department'], 'table 1 was "Annual Report 2026"');
  assert.ok(t.warnings.some((w) => /A note .*"Annual Report 2026"/.test(w)), t.warnings.join(' | '));
});
