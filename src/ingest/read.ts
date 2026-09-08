/**
 * File readers. Node-only — this never ships to the Worker.
 *
 * Both readers normalise to the same pair: a rectangular grid of primitive values,
 * and the merge spans, because merges are load-bearing for this project and are the
 * one thing a naive reader throws away.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';

import { a1, type CellValue, type MergeSpan } from '../table/model.ts';

export interface ReadSheet {
  readonly name: string;
  readonly grid: readonly (readonly CellValue[])[];
  readonly merges: readonly MergeSpan[];
}

export interface ReadResult {
  readonly sourceName: string;
  readonly format: 'xlsx' | 'csv' | 'tsv';
  readonly sheets: readonly ReadSheet[];
  readonly warnings: readonly string[];
}

/**
 * ExcelJS hands back rich cell objects for formulas, hyperlinks and rich text.
 * Flatten to the value a person would hear, and prefer the cached formula RESULT
 * over the formula source — someone asking for a total wants 4820, not "=SUM(F2:F9)".
 */
function flatten(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return flatten(v['result']); // formula: use the cached result
    if ('text' in v && typeof v['text'] === 'string') return v['text']; // hyperlink
    if ('richText' in v && Array.isArray(v['richText'])) {
      return (v['richText'] as { text?: string }[]).map((p) => p.text ?? '').join('');
    }
    if ('error' in v) return null; // #DIV/0! and friends read as a gap, not as text
  }
  return String(value);
}

/** "B2:D5" → a MergeSpan. ExcelJS reports merges in this form. */
function parseMergeRange(range: string, grid: readonly (readonly CellValue[])[]): MergeSpan | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.toUpperCase());
  if (!m) return null;
  const col = (letters: string): number =>
    [...letters].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const topRow = Number(m[2]) - 1;
  const bottomRow = Number(m[4]) - 1;
  const leftCol = col(m[1]!);
  const rightCol = col(m[3]!);
  return {
    value: grid[topRow]?.[leftCol] ?? null,
    topRow,
    bottomRow,
    leftCol,
    rightCol,
    a1: a1(topRow, leftCol),
  };
}

async function readXlsx(path: string): Promise<ReadResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  const sheets: ReadSheet[] = [];
  const warnings: string[] = [];

  wb.eachSheet((ws) => {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') {
      warnings.push(`Sheet "${ws.name}" is hidden in the file and was skipped.`);
      return;
    }

    const width = Math.max(1, ws.columnCount);
    const grid: CellValue[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const out: CellValue[] = [];
      for (let c = 1; c <= width; c++) out.push(flatten(row.getCell(c).value));
      grid.push(out);
    }

    // ExcelJS exposes merges as an object keyed by range on some versions and an
    // array on others; normalise both rather than trusting one shape.
    const raw = (ws.model as { merges?: string[] | Record<string, unknown> }).merges;
    const ranges: string[] = Array.isArray(raw) ? raw : raw ? Object.keys(raw) : [];
    const merges = ranges
      .map((r) => parseMergeRange(r, grid))
      .filter((m): m is MergeSpan => m !== null);

    sheets.push({ name: ws.name, grid, merges });
  });

  if (sheets.length === 0) warnings.push('The workbook contains no visible sheets.');
  return { sourceName: basename(path), format: 'xlsx', sheets, warnings };
}

async function readDelimited(path: string, delimiter: ',' | '\t'): Promise<ReadResult> {
  const text = await readFile(path, 'utf8');
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: false, // blank rows separate regions — they are signal, not noise
    dynamicTyping: false, // we do our own type inference, with confidence reporting
  });

  const warnings: string[] = [];
  for (const err of parsed.errors.slice(0, 3)) {
    warnings.push(`Row ${(err.row ?? 0) + 1}: ${err.message}`);
  }
  if (parsed.errors.length > 3) {
    warnings.push(`${parsed.errors.length - 3} further parse problems were not listed.`);
  }

  const grid: CellValue[][] = parsed.data.map((row) =>
    row.map((cell) => {
      const t = typeof cell === 'string' ? cell.trim() : cell;
      return t === '' || t === undefined ? null : t;
    }),
  );

  return {
    sourceName: basename(path),
    format: delimiter === '\t' ? 'tsv' : 'csv',
    // A delimited file has exactly one sheet; name it after the file so speech has
    // something to say other than "sheet 1".
    sheets: [{ name: basename(path, extname(path)), grid, merges: [] }],
    warnings,
  };
}

export async function readSpreadsheet(path: string): Promise<ReadResult> {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.xlsx':
    case '.xlsm':
      return readXlsx(path);
    case '.tsv':
      return readDelimited(path, '\t');
    case '.csv':
      return readDelimited(path, ',');
    default:
      throw new Error(
        `Landmark reads .xlsx, .xlsm, .csv and .tsv. "${basename(path)}" is ${ext || 'extensionless'}.`,
      );
  }
}
