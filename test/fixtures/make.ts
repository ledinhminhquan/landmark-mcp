/**
 * Generates the five golden fixtures. Run: npm run fixtures
 *
 * These are the shapes that break naive readers, chosen so each one isolates a
 * different failure. They are generated rather than committed as binaries so the
 * expected structure is readable in source and reviewable in a diff.
 */

import ExcelJS from 'exceljs';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
await mkdir(here, { recursive: true });

async function save(wb: ExcelJS.Workbook, name: string): Promise<void> {
  await wb.xlsx.writeFile(join(here, name));
  console.log('  wrote', name);
}

// ── 1. Flat table. The control case: one header row, no tricks. ──────────────
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales');
  ws.addRow(['Region', 'Rep', 'Revenue', 'Closed']);
  ws.addRow(['North', 'Anh', 12400, new Date('2026-07-04')]);
  ws.addRow(['North', 'Bảo', 8150, new Date('2026-07-19')]);
  ws.addRow(['South', 'Chi', 21000, new Date('2026-08-02')]);
  ws.addRow(['South', 'Dũng', 3900, new Date('2026-08-27')]);
  ws.addRow(['East', 'An', 15600, new Date('2026-09-01')]);
  await save(wb, '01-flat.xlsx');
}

// ── 2. Two-row stacked header, no merges. ───────────────────────────────────
// The quarter row carries no type discontinuity and no merge, which is exactly
// what a top-down header walk gets wrong.
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Quarterly');
  ws.addRow([null, 'Q1', 'Q2', 'Q3']);
  ws.addRow(['Region', 'Revenue', 'Revenue', 'Revenue']);
  ws.addRow(['North', 1200, 1400, 1500]);
  ws.addRow(['South', 900, 950, 1100]);
  ws.addRow(['East', 700, 820, 910]);
  await save(wb, '02-stacked-header.xlsx');
}

// ── 3. Horizontally merged header block over a second level. ────────────────
// Four columns are all literally labelled "Revenue"; only the path distinguishes them.
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Compare');
  ws.addRow([null, '2026', null, '2025', null]);
  ws.addRow([null, 'Q1', 'Q2', 'Q1', 'Q2']);
  ws.addRow(['Region', 'Revenue', 'Revenue', 'Revenue', 'Revenue']);
  ws.addRow(['North', 1200, 1400, 1100, 1000]);
  ws.addRow(['South', 900, 950, 800, 850]);
  ws.mergeCells('B1:C1');
  ws.mergeCells('D1:E1');
  await save(wb, '03-merged-header.xlsx');
}

// ── 4. Title row above, and a vertical merge in the body. ───────────────────
// The vertical merge is the case where a literal read reports a labelled row as empty.
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget');
  ws.addRow(['FY2026 Departmental Budget']);
  ws.addRow(['Department', 'Line item', 'Amount']);
  ws.addRow(['Engineering', 'Salaries', 480000]);
  ws.addRow([null, 'Tooling', 62000]);
  ws.addRow([null, 'Travel', 18000]);
  ws.addRow(['Design', 'Salaries', 210000]);
  ws.addRow([null, 'Software', 24000]);
  ws.mergeCells('A3:A5'); // Engineering spans three line items
  ws.mergeCells('A6:A7'); // Design spans two
  await save(wb, '04-title-and-vmerge.xlsx');
}

// ── 5. Three separate regions on one sheet. ─────────────────────────────────
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mixed');
  ws.addRow(['Product', 'Units']);
  ws.addRow(['Widget', 120]);
  ws.addRow(['Gadget', 45]);
  ws.addRow([]);
  ws.addRow(['Region', 'Target', 'Actual']);
  ws.addRow(['North', 10000, 12400]);
  ws.addRow(['South', 9000, 3900]);
  ws.addRow([]);
  ws.addRow(['Note', 'Status']);
  ws.addRow(['Q3 close', 'pending']);
  await save(wb, '05-three-regions.xlsx');
}

// ── 6. A CSV with a ragged tail, to prove the delimited path. ───────────────
{
  const csv = [
    'Country,Population,GDP per capita (USD),Region',
    'Vietnam,100352192,4347,Asia',
    'Thailand,71801279,7297,Asia',
    'Indonesia,277534122,4788,Asia',
    'Kenya,55100586,2099,Africa',
    'Nigeria,223804632,1596,Africa',
    'Peru,34352719,7126,Americas',
    'Norway,5474360,87962,Europe',
    'Poland,36685849,22113,Europe',
    '',
    'Source: illustrative figures for testing only',
  ].join('\n');
  await writeFile(join(here, '06-countries.csv'), csv, 'utf8');
  console.log('  wrote 06-countries.csv');
}

console.log('fixtures ready');
