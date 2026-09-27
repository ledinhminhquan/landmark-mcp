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

import { a1, columnLetter, isBlank, plural, type CellValue, type MergeSpan } from '../table/model.ts';

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
  /**
   * The separator a delimited file was split on. It is evidence about the numbers in
   * it: a comma-separated file does not use the comma as its decimal point, and a
   * semicolon-separated one almost always does.
   */
  readonly delimiter?: Delimiter;
}

export type Delimiter = ',' | ';' | '\t' | '|';
const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];

/**
 * Which separator splits this text into a table.
 *
 * Each candidate is scored by how many non-blank lines it splits into the same number
 * of fields, two or more. Papa's own guesser averages over every line, so a title line
 * above a semicolon table ("Báo cáo tháng 9", then "Món;Giá") pulled every candidate
 * under its bar and it fell back to the comma: one column called "Món;giá", and "1,5"
 * cut in half. Counting agreeing lines lets the table outvote a title or a note. A tie
 * keeps the earlier candidate, so a file with nothing to split stays comma-separated.
 */
function sniffDelimiter(text: string): Delimiter {
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const rows = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: 'greedy', preview: 50 }).data;
    const counts = new Map<number, number>();
    for (const row of rows) {
      if (row.length >= 2) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    }
    const score = Math.max(0, ...counts.values());
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** Cells whose value could not be read as the sheet shows it, by kind, with addresses. */
interface CellTrouble {
  /** Formulas saved without a result — written by a program, never opened in Excel. */
  readonly unsaved: string[];
  /** Cells showing a spreadsheet error such as #DIV/0!, as [address, error]. */
  readonly errors: [string, string][];
  /** Cell objects of a shape this reader does not know. */
  readonly unknown: string[];
}

/**
 * ExcelJS hands back rich cell objects for formulas, hyperlinks and rich text.
 * Flatten to the value a person would hear, and prefer the cached formula RESULT
 * over the formula source — someone asking for a total wants 4820, not "=SUM(F2:F9)".
 *
 * Nothing here may fall through to String(object): "[object Object]" spoken aloud is
 * a JavaScript artefact, and one of them turns a whole column into untotalable text.
 * What cannot be read becomes a gap, and is counted so the file's warnings say so.
 */
function flatten(value: unknown, at: string, trouble: CellTrouble): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('error' in v) {
      // An error is not a blank. Kept as the error's own text, so an answer that
      // skips it says it "did not hold a number" rather than that it was empty.
      const code = String(v['error']);
      trouble.errors.push([at, code]);
      return code;
    }
    if ('formula' in v || 'sharedFormula' in v || 'result' in v) {
      const result = v['result'];
      if (result === undefined || result === null) {
        trouble.unsaved.push(at);
        return null;
      }
      return flatten(result, at, trouble); // formula: use the cached result
    }
    if ('richText' in v && Array.isArray(v['richText'])) {
      return (v['richText'] as { text?: unknown }[])
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('');
    }
    // A hyperlink: its text may itself be rich text.
    if ('text' in v) return flatten(v['text'], at, trouble);
    if ('hyperlink' in v && typeof v['hyperlink'] === 'string') return v['hyperlink'];
  }
  trouble.unknown.push(at);
  return null;
}

/**
 * A cell's value with a formula's saved result intact.
 *
 * ExcelJS's `value` getter copies a formula's fields only when they are truthy, so a
 * saved result of 0, FALSE or "" vanished: `=C4*D4` showing 0 arrived as a formula with
 * no result, was read as empty, and the file was said to need re-saving in Excel. An
 * average then left the zero out and a lookup for 0 found nothing. The cell's model
 * still holds the result, so it is read from there; only a result that is truly absent
 * is unsaved.
 */
function cellValue(cell: ExcelJS.Cell): unknown {
  const value: unknown = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    const saved = (cell as unknown as { model?: { result?: unknown } }).model?.result;
    return { ...value, result: saved !== undefined ? saved : (value as { result?: unknown }).result };
  }
  return value;
}

/** A number format with its quoted literals and escaped characters removed. */
function formatCode(numFmt: unknown): string {
  if (typeof numFmt !== 'string') return '';
  return (numFmt.split(';')[0] ?? '').replace(/"[^"]*"|\\./g, '');
}

/**
 * Apply the two number formats that change what a value IS, not just how it looks.
 *
 * Excel stores 7.5% as 0.075 and shows it through a "0.0%" format; read raw, it is
 * spoken as "0.08". It is stored the way a CSV's "7.5%" already is, so both
 * formats of the same file mean the same thing. A "00000" format is how a postcode
 * keeps its leading zero — the number 2134 displayed as 02134 — and that zero is the
 * difference between a postcode and a quantity.
 */
function applyFormat(n: number, numFmt: unknown): CellValue {
  const code = formatCode(numFmt);
  if (code.includes('%')) {
    const pct = Number((n * 100).toPrecision(12));
    return `${Math.abs(pct) < 1e-9 ? 0 : pct}%`;
  }
  if (/^0{2,}$/.test(code) && Number.isInteger(n) && n >= 0) {
    return String(n).padStart(code.length, '0');
  }
  return n;
}

/** Excel's day zero. A time of day with no date arrives as a Date on this day. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/**
 * A time of day, as the sheet shows it: "08:30".
 *
 * Excel stores a time as a fraction of a day, and a cell showing 08:30 reaches here as
 * a Date on 30 December 1899 — spoken as "Start December 30, 1899". A cell is a time
 * when its format shows only hours, minutes or seconds, or when its date is Excel's
 * day zero, which no real record is dated. A duration format ("[h]:mm") counts its
 * hours past a day, so 25 hours is "25:00" and not "01:00".
 */
function timeOfDay(d: Date, numFmt: unknown): string | null {
  // Colour and locale tags ("[Red]", "[$-409]") are not hours; "[h]" is.
  const code = formatCode(numFmt).replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '');
  const timeOnly = /[hs]/i.test(code) && !/[yd]/i.test(code);
  const t = Math.round(d.getTime() / 1000) * 1000;
  const onEpoch = t >= EXCEL_EPOCH && t < EXCEL_EPOCH + 2 * DAY_MS;
  if (!timeOnly && !onEpoch) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (/\[h+\]/i.test(code)) {
    const minutes = Math.round((t - EXCEL_EPOCH) / 60_000);
    return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
  }
  const at = new Date(t);
  const seconds = at.getUTCSeconds() && /s/i.test(code) ? `:${pad(at.getUTCSeconds())}` : '';
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}${seconds}`;
}

function troubleWarnings(sheet: string, t: CellTrouble): string[] {
  const out: string[] = [];
  if (t.unsaved.length) {
    out.push(
      `Sheet "${sheet}" has ${plural(t.unsaved.length, 'formula')} with no saved result, starting at ${t.unsaved[0]}, so I read ${t.unsaved.length === 1 ? 'it' : 'them'} as empty. Opening the file in Excel and saving it stores the results.`,
    );
  }
  if (t.errors.length) {
    const [at, code] = t.errors[0]!;
    out.push(
      `Sheet "${sheet}" has ${plural(t.errors.length, 'cell')} showing a spreadsheet error, such as ${code} in ${at}. Those are errors, not numbers or blanks.`,
    );
  }
  if (t.unknown.length) {
    out.push(
      `Sheet "${sheet}" has ${plural(t.unknown.length, 'cell')} I could not read, starting at ${t.unknown[0]}, so I treated ${t.unknown.length === 1 ? 'it' : 'them'} as empty.`,
    );
  }
  return out;
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
    const trouble: CellTrouble = { unsaved: [], errors: [], unknown: [] };
    const hiddenRows: number[] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const out: CellValue[] = [];
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        const v = flatten(cellValue(cell), a1(r - 1, c - 1), trouble);
        out.push(
          typeof v === 'number' ? applyFormat(v, cell.numFmt) : v instanceof Date ? (timeOfDay(v, cell.numFmt) ?? v) : v,
        );
      }
      grid.push(out);
      if (row.hidden && out.some((v) => !isBlank(v))) hiddenRows.push(r);
    }
    const hiddenCols: string[] = [];
    for (let c = 1; c <= width; c++) {
      if (ws.getColumn(c).hidden && grid.some((row) => !isBlank(row[c - 1] ?? null))) {
        hiddenCols.push(columnLetter(c - 1));
      }
    }

    warnings.push(...troubleWarnings(ws.name, trouble));
    // Hidden rows and columns are read, as Excel's own SUM reads them, but a sighted
    // colleague does not see them — so the difference between what they see and what
    // is heard has to be said rather than discovered.
    if (hiddenRows.length || hiddenCols.length) {
      const parts: string[] = [];
      if (hiddenRows.length) {
        parts.push(`${plural(hiddenRows.length, 'hidden row')} (${hiddenRows.slice(0, 5).join(', ')}${hiddenRows.length > 5 ? ' …' : ''})`);
      }
      if (hiddenCols.length) {
        parts.push(`${plural(hiddenCols.length, 'hidden column')} (${hiddenCols.slice(0, 5).join(', ')}${hiddenCols.length > 5 ? ' …' : ''})`);
      }
      warnings.push(
        `Sheet "${ws.name}" has ${parts.join(' and ')}. I included them, so totals match Excel's own SUM rather than only what is visible on screen.`,
      );
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

/** Tone marks as Windows-1258 writes them, one combining mark after the letter. */
const TONE_MARK = /[\u0300\u0301\u0303\u0309\u0323]/;
/** Letters only Vietnamese has. */
const VIETNAMESE_LETTER = /[\u01A1\u01B0\u0103\u0111\u01A0\u01AF\u0102\u0110]/;

/**
 * The file's text, and the legacy encoding it had to be read in, if any.
 *
 * Excel saves "Unicode Text" and "CSV UTF-16" with a byte-order mark, and "CSV (Comma
 * delimited)" in the computer's own code page. Every file used to be read as UTF-8, so
 * the first came out with a NUL between every letter and the second as "M\uFFFDller" and
 * "K\uFFFDln", with nothing said. A byte-order mark decides it; otherwise UTF-8 is tried
 * strictly, and a file that is not UTF-8 is read as Windows-1258 when it reads as
 * Vietnamese there (a tone mark and a letter like \u01A1 or \u0111), and as Windows-1252
 * otherwise. Excel's own UTF-8 byte-order mark is dropped, or it became part of the
 * first heading.
 */
export function decodeText(bytes: Uint8Array): { text: string; legacy: string | null } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), legacy: null };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), legacy: null };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), legacy: null };
  } catch {
    const vietnamese = new TextDecoder('windows-1258').decode(bytes);
    if (TONE_MARK.test(vietnamese) && VIETNAMESE_LETTER.test(vietnamese)) {
      return { text: vietnamese.normalize('NFC'), legacy: 'Windows-1258' };
    }
    return { text: new TextDecoder('windows-1252').decode(bytes), legacy: 'Windows-1252' };
  }
}

async function readDelimited(path: string, delimiter: ',' | '\t'): Promise<ReadResult> {
  const decoded = decodeText(await readFile(path));
  const text = decoded.text;
  // A ".csv" is comma-separated only where the comma is not the decimal point. In
  // Vietnam and most of Europe, Excel exports semicolons, and splitting those on
  // commas cut "1,5" in half and made "Name;Amount" a single column. So the separator
  // is detected from the file; a tab-separated file says so by its name.
  const separator: Delimiter = delimiter === '\t' ? '\t' : sniffDelimiter(text);
  const parsed = Papa.parse<string[]>(text, {
    delimiter: separator,
    skipEmptyLines: false, // blank rows separate regions — they are signal, not noise
    dynamicTyping: false, // we do our own type inference, with confidence reporting
  });

  const warnings: string[] = [];
  if (decoded.legacy) {
    warnings.push(
      `"${basename(path)}" is not saved as UTF-8, so I read it as ${decoded.legacy}. If any letters sound wrong, save it from Excel as "CSV UTF-8" and load it again.`,
    );
  }
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
    delimiter: separator,
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
