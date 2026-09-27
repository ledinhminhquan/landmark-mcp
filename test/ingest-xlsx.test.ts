/**
 * What an .xlsx file carries beyond the grid of values.
 *
 * Formulas, number formats, errors, hidden rows, merged titles and sheet names all
 * changed an answer while nothing said so. The workbooks are built here with ExcelJS
 * rather than committed as binaries, so each case is readable in the test that uses it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { materialise } from '../src/table/materialise.ts';
import { createHandler } from '../src/server.ts';
import { runQuery } from '../src/query/engine.ts';
import type { IndexTable } from '../src/indexfmt.ts';

const dir = await mkdtemp(join(tmpdir(), 'landmark-xlsx-'));

async function workbook(name: string, fill: (wb: ExcelJS.Workbook) => void): Promise<IndexTable> {
  const wb = new ExcelJS.Workbook();
  fill(wb);
  const path = join(dir, `${name}.xlsx`);
  await wb.xlsx.writeFile(path);
  return buildTable(await readSpreadsheet(path));
}

const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

test('a Total row computed by a formula is marked, and the column adds up without it', async () => {
  const t = await workbook('total-row', (wb) => {
    const ws = wb.addWorksheet('Budget');
    ws.addRow(['Department', 'Amount']);
    ws.addRow(['Engineering', 480000]);
    ws.addRow(['Design', 210000]);
    ws.addRow(['Ops', 95000]);
    ws.addRow(['HR', 60000]);
    ws.addRow(['Total', { formula: 'SUM(B2:B5)', result: 845000 }]);
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.summaryRows, [4]);
  assert.equal(r.rows[4]![1], 845000, 'the cached result, not the formula');
  assert.equal(r.columns[1]!.sum, 845000, 'was 1.7 million');
  assert.equal(r.columns[1]!.max, 480000);
});

test('formulas without results, rich-text links and error cells never become "[object Object]"', async () => {
  const t = await workbook('formulas', (wb) => {
    const ws = wb.addWorksheet('Lines');
    ws.addRow(['Item', 'Qty', 'Price', 'Line total', 'Ratio']);
    ws.addRow(['A', 2, 10, { formula: 'B2*C2', result: 20 }, { formula: 'B2/2', result: 1 }]);
    ws.addRow(['B', 3, 10, { formula: 'B3*C3', result: 30 }, { error: '#DIV/0!' }]);
    // Written by a program and never opened in Excel: a formula with no saved result.
    ws.addRow(['C', 4, 10, { formula: 'B4*C4' } as ExcelJS.CellFormulaValue, 2]);
    ws.addRow(['D', 1, 5, 5, 3]);
    ws.addRow([null, 1, 1, 1, 1]);
    ws.getCell('A6').value = {
      text: { richText: [{ text: 'Rich' }, { text: ' link' }] },
      hyperlink: 'https://example.com',
    } as unknown as ExcelJS.CellHyperlinkValue;
  });
  const r = t.regions[0]!;
  const everything = JSON.stringify(r.rows) + JSON.stringify(r.columns);
  assert.ok(!everything.includes('[object'), everything);

  assert.equal(r.rows[4]![0], 'Rich link');
  assert.equal(r.rows[2]![3], null, 'no result is a gap');
  assert.equal(r.columns[3]!.kind, 'number', 'and the column can still be totalled');
  assert.equal(r.columns[3]!.sum, 56);

  // An error is an error: not a blank, and not a reason to refuse the whole column.
  assert.equal(r.rows[1]![4], '#DIV/0!');
  assert.equal(r.columns[4]!.kind, 'number');
  assert.equal(r.columns[4]!.nonNumeric, 1);
  assert.equal(r.columns[4]!.empty, 0);

  assert.ok(t.warnings.some((w) => /1 formula with no saved result/.test(w) && /D4/.test(w)));
  assert.ok(t.warnings.some((w) => /#DIV\/0!/.test(w) && /E3/.test(w)));
});

test('hidden rows and columns are read, and the file says they were', async () => {
  const t = await workbook('hidden', (wb) => {
    const ws = wb.addWorksheet('Costs');
    ws.addRow(['Department', 'Old amount', 'Amount']);
    ws.addRow(['Engineering', 1, 100]);
    ws.addRow(['Design (cancelled)', 2, 999]);
    ws.addRow(['Ops', 3, 50]);
    ws.getRow(3).hidden = true;
    ws.getColumn(2).hidden = true;
  });
  // Excel's own SUM includes hidden rows, so the total agrees with the sheet's formula.
  assert.equal(t.regions[0]!.columns[2]!.sum, 1149);
  const w = t.warnings.find((x) => /hidden/.test(x));
  assert.ok(w, 'no warning, where a hidden sheet in the same file got one');
  assert.match(w, /1 hidden row \(3\)/);
  assert.match(w, /1 hidden column \(B\)/);
});

test('percent-formatted cells are percentages, and zero-padded codes keep their zeros', async () => {
  const t = await workbook('formats', (wb) => {
    const ws = wb.addWorksheet('Growth');
    ws.addRow(['Region', 'Growth', 'Zip']);
    ws.addRow(['North', 0.12, 2134]);
    ws.addRow(['South', 0.075, 10001]);
    ws.getCell('B2').numFmt = '0%';
    ws.getCell('B3').numFmt = '0.0%';
    ws.getCell('C2').numFmt = '00000';
    ws.getCell('C3').numFmt = '00000';
  });
  const r = t.regions[0]!;
  assert.equal(r.columns[1]!.kind, 'percent');
  assert.deepEqual(r.rows.map((row) => row[1]), ['12%', '7.5%'], 'was spoken as 0.12 and 0.08');
  assert.equal(r.columns[1]!.mean, 9.75);
  assert.equal(r.columns[2]!.kind, 'text');
  assert.deepEqual(r.rows.map((row) => row[2]), ['02134', '10001']);
});

test('a percent cell this reader wrote is never taken for a grouped number', async () => {
  // 0.07125 shown as 7.1% is stored as "7.125%". Beside prices in dong, which group
  // their thousands with dots, it was read the same way: a discount of 7125%.
  const vn = await workbook('pct-vn', (wb) => {
    const ws = wb.addWorksheet('Menu');
    ws.addRow(['Món', 'Giá', 'Chiết khấu']);
    ws.addRow(['Phở', '45.000 ₫', 0.07125]);
    ws.addRow(['Bún', '35.000 ₫', 0.05375]);
    ws.getCell('C2').numFmt = '0.0%';
    ws.getCell('C3').numFmt = '0.0%';
  });
  const r = vn.regions[0]!;
  assert.equal(r.columns[1]!.sum, 80000);
  assert.equal(r.columns[2]!.kind, 'percent');
  assert.equal(r.columns[2]!.sum, 12.5, 'was 12500');
  assert.deepEqual(r.rows.map((row) => row[2]), ['7.125%', '5.375%']);
  assert.ok(!vn.warnings.some((w) => /thousand/.test(w)), vn.warnings.join(' | '));

  // And alone, it is not doubted: this is the reader's own output, not the author's.
  const alone = await workbook('pct-alone', (wb) => {
    const ws = wb.addWorksheet('Rates');
    ws.addRow(['Item', 'Rate']);
    ws.addRow(['A', 0.12345]);
    ws.addRow(['B', 0.23456]);
    ws.getCell('B2').numFmt = '0.0%';
    ws.getCell('B3').numFmt = '0.0%';
  });
  assert.deepEqual(alone.warnings, []);
  assert.equal(alone.regions[0]!.columns[1]!.sum, 35.801);
});

test('a sales channel called Mobile is a column of amounts', async () => {
  const t = await workbook('mobile-channel', (wb) => {
    const ws = wb.addWorksheet('Sales');
    ws.addRow(['Month', 'Web', 'Mobile', 'Store']);
    ws.addRow(['Jan', 1200, 800.5, 400]);
    ws.addRow(['Feb', 1300, 900.25, 450]);
  });
  const mobile = t.regions[0]!.columns[2]!;
  assert.equal(mobile.kind, 'number', 'was text, and could not be totalled');
  assert.equal(mobile.sum, 1700.75);
  assert.deepEqual(t.regions[0]!.rows.map((r) => r[2]), [800.5, 900.25], 'not rewritten as text');
});

test('a title merged across the table is a title, not a heading level', async () => {
  const t = await workbook('merged-title', (wb) => {
    const ws = wb.addWorksheet('Budget');
    ws.addRow(['FY2026 Budget']);
    ws.addRow(['Department', 'Line item', 'Amount']);
    ws.addRow(['Engineering', 'Salaries', 100]);
    ws.addRow(['Ops', 'Travel', 50]);
    ws.mergeCells('A1:C1');
  });
  const r = t.regions[0]!;
  assert.equal(r.title, 'FY2026 Budget');
  assert.deepEqual(r.columns.map((c) => c.path), [['Department'], ['Line item'], ['Amount']]);
  assert.deepEqual(r.headerRows, [1]);
});

test('a merged group heading that does not start at the left is still a heading level', async () => {
  const t = await workbook('group', (wb) => {
    const ws = wb.addWorksheet('Compare');
    ws.addRow([null, 'Revenue', null]);
    ws.addRow(['Region', 'Q1', 'Q2']);
    ws.addRow(['North', 10, 20]);
    ws.addRow(['South', 30, 40]);
    ws.mergeCells('B1:C1');
  });
  const r = t.regions[0]!;
  assert.equal(r.title, null);
  assert.deepEqual(r.columns.map((c) => c.path), [['Region'], ['Revenue', 'Q1'], ['Revenue', 'Q2']]);
});

test('sheets whose names differ only after a dot get their own ids', async () => {
  const t = await workbook('dotted', (wb) => {
    const a = wb.addWorksheet('Q1.2025');
    a.addRow(['Region', 'Sales']);
    a.addRow(['North', 1]);
    a.addRow(['South', 2]);
    const b = wb.addWorksheet('Q1.2026');
    b.addRow(['Region', 'Sales']);
    b.addRow(['North', 100]);
    b.addRow(['South', 200]);
  });
  const ids = t.regions.map((r) => r.id);
  assert.deepEqual(ids, ['q1-2025.t1', 'q1-2026.t1'], 'both were "q1.t1"');

  // A correction to one sheet must not re-read the other.
  const handler = createHandler({ index: buildIndex([t]) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
          'x-landmark-session': 'dotted-sheets',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
    );
    return (JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } }).result
      .structuredContent;
  };
  await call('table_structure', { table_id: 'dotted', sheet: 'Q1.2025', header_rows: 0 });
  const other = await call('table_describe', { table_id: 'dotted', sheet: 'Q1.2026' });
  assert.equal(other['row_count'], 2, 'Q1.2026 was re-read by a correction made to Q1.2025');
});

test('dates typed into a heading row become month names, in UTC', async () => {
  const t = await workbook('months', (wb) => {
    const ws = wb.addWorksheet('Plan');
    ws.addRow(['Department', utc(2024, 1, 1), utc(2024, 2, 1), utc(2024, 3, 15)]);
    for (const row of [['Eng', 1, 2, 3], ['Ops', 4, 5, 6], ['Des', 7, 8, 9], ['HR', 1, 1, 1], ['Fin', 2, 2, 2]]) {
      ws.addRow(row);
    }
    ws.getRow(1).eachCell((cell, n) => {
      if (n > 1) cell.numFmt = 'mmm-yy';
    });
  });
  const r = t.regions[0]!;
  assert.equal(r.structure.ambiguous, true, 'was read as headerless without a word of doubt');
  assert.ok(r.structure.alternatives.some((a) => a.headerRows === 1));
  const corrected = materialise(r.allRows, r.startRow, r.firstCol, 1);
  assert.deepEqual(corrected.columns.map((c) => c.spoken), ['Department', 'January 2024', 'February 2024', 'March 15 2024']);
});

test('date cells are stored as UTC midnight ISO days', async () => {
  const t = await workbook('dates', (wb) => {
    const ws = wb.addWorksheet('Log');
    ws.addRow(['When', 'Amount']);
    ws.addRow([utc(2024, 1, 15), 1]);
    ws.addRow([utc(2024, 2, 1), 2]);
  });
  assert.deepEqual(t.regions[0]!.rows.map((r) => r[0]), ['2024-01-15T00:00:00.000Z', '2024-02-01T00:00:00.000Z']);
});

test('a time of day is read as the time the sheet shows, not a day in 1899', async () => {
  const t = await workbook('timesheet', (wb) => {
    const ws = wb.addWorksheet('T');
    ws.addRow(['Name', 'Start', 'Hours', 'Logged']);
    ws.addRow(['An', new Date(Date.UTC(1899, 11, 30, 8, 30)), 8, new Date(Date.UTC(1899, 12, 1, 1, 30))]);
    ws.addRow(['Bình', new Date(Date.UTC(1899, 11, 30, 9, 15)), 7.5, new Date(Date.UTC(1899, 11, 30, 20, 0))]);
    for (const a of ['B2', 'B3']) ws.getCell(a).numFmt = 'hh:mm';
    for (const a of ['D2', 'D3']) ws.getCell(a).numFmt = '[h]:mm';
  });
  const r = t.regions[0]!;
  assert.deepEqual(r.rows.map((row) => row[1]), ['08:30', '09:15'], 'was "1899-12-30T08:30:00.000Z"');
  assert.equal(r.columns[1]!.kind, 'text');
  assert.deepEqual(r.rows.map((row) => row[3]), ['49:30', '20:00'], 'a duration counts its hours past a day');

  const handler = createHandler({ index: buildIndex([t]) });
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'table_read_rows', arguments: { table_id: 'timesheet', limit: 1 } } }),
    }),
  );
  const spoken = (JSON.parse(await res.text()) as { result: { structuredContent: { spoken: string } } }).result.structuredContent.spoken;
  assert.match(spoken, /^An: Start 08:30, Hours 8 and Logged 49:30\./, 'was "Start December 30, 1899"');
});

test('a real date keeps its date, whatever its time', async () => {
  const t = await workbook('stamped', (wb) => {
    const ws = wb.addWorksheet('Log');
    ws.addRow(['When', 'Amount']);
    ws.addRow([new Date(Date.UTC(2026, 6, 4, 9, 30)), 1]);
    ws.addRow([new Date(Date.UTC(2026, 6, 5)), 2]);
    ws.getCell('A2').numFmt = 'yyyy-mm-dd hh:mm';
  });
  assert.equal(t.regions[0]!.columns[0]!.kind, 'date');
});

test('a formula whose saved result is 0 or FALSE keeps it, and is not called unsaved', async () => {
  const t = await workbook('zero-results', (wb) => {
    const ws = wb.addWorksheet('Stock');
    ws.addRow(['Product', 'Qty', 'Price', 'Value', 'Over']);
    ws.addRow(['USB-C cable', 40, 4.5, { formula: 'B2*C2', result: 180 }, { formula: 'D2>200', result: false }]);
    ws.addRow(['HDMI adapter', 0, 7.25, { formula: 'B3*C3', result: 0 }, { formula: 'D3>200', result: false }]);
    ws.addRow(['Webcam', 8, 49, { formula: 'B4*C4', result: 392 }, { formula: 'D4>200', result: true }]);
    // Filled down: the cells under the first carry only a reference to its formula.
    ws.addRow(['Left', 100, 100, null, null]);
    ws.addRow(['Right', 80, 80, null, null]);
    ws.getCell('D5').value = { formula: 'B5-C5', result: 0, shareType: 'shared', ref: 'D5:D6' } as unknown as ExcelJS.CellFormulaValue;
    ws.getCell('D6').value = { sharedFormula: 'D5', result: 0 } as unknown as ExcelJS.CellSharedFormulaValue;
  });
  const r = t.regions[0]!;
  assert.equal(r.rows[1]![3], 0, 'was a gap: ExcelJS drops a falsy result');
  assert.equal(r.rows[3]![3], 0, 'a shared formula too');
  assert.equal(r.rows[4]![3], 0);
  assert.equal(r.rows[1]![4], false);
  assert.equal(r.columns[3]!.empty, 0);
  assert.equal(runQuery(r, { aggregate: 'avg', aggregateColumn: 'Value' }).result, 572 / 5, 'was 286, the zeros skipped as blanks');
  assert.equal(runQuery(r, { aggregate: 'min', aggregateColumn: 'Value' }).result, 0);
  assert.equal(runQuery(r, { filters: [{ column: 'Value', op: 'eq', value: '0' }], aggregate: 'count' }).result, 3);
  assert.ok(!t.warnings.some((w) => /no saved result/.test(w)), t.warnings.join(' | '));
});
