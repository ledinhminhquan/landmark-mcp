/**
 * The document model.
 *
 * Design constraint that drives everything here: the consumer is a *voice* agent
 * speaking to someone who cannot see the grid.
 *
 * To be accurate about the problem, because overstating it is both wrong and easy to
 * catch: modern screen readers CAN announce headers in Excel. JAWS and NVDA both
 * support it. The difficulty is not that the capability is missing — it is that
 *
 *   - header association is set up manually, per worksheet, and does not travel
 *     between readers (NVDA #11801 has been open since 2020),
 *   - most files never declare structure at all — the WebAIM Million (Feb 2026) found
 *     valid data-table markup on 19% of the 948,225 tables it sampled, and
 *     Section508.gov states plainly that "Excel does not provide tools to make complex
 *     tables accessible",
 *   - and even with headers announced, every aggregate, comparison or cross-reference
 *     question costs O(rows x cols) of traversal, with no cheap way to learn a table's
 *     shape before committing to it.
 *
 * So this model exists to *infer* the structure a file never declared, and to make
 * that structure addressable. Two consequences:
 *
 *   1. Nothing is addressed by bare coordinates. Every reference carries its own
 *      header path, so an answer can be spoken as "2026, Q3, EMEA, Revenue: 4,820"
 *      rather than "C7" — and can be traced back to the cells it came from.
 *
 *   2. A sheet is not a table. Real spreadsheets carry title rows, blank spacer rows,
 *      notes under the data, and several tables stacked on one sheet. We model regions
 *      explicitly so the agent can say "this sheet has two tables" and mean it.
 */

/** A2-style address, kept only for provenance and for sighted collaborators. */
export type A1 = string;

export type CellValue = string | number | boolean | Date | null;

/**
 * Inferred semantic type of a column. Deliberately coarser than a spreadsheet's
 * internal format: the agent needs to know "can I total this" and "can I sort this
 * chronologically", not the difference between two currency masks.
 */
export type ColumnKind =
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'boolean'
  | 'category' // low-cardinality text: usable as a filter or grouping key
  | 'text'
  | 'empty'
  | 'mixed'; // genuinely inconsistent — worth telling the user about

export interface NumericSummary {
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly mean: number;
  /** Rows the value could not be read as a number. Spoken as a caveat. */
  readonly nonNumeric: number;
}

export interface ColumnProfile {
  /** Zero-based index within the region, not the sheet. */
  readonly index: number;
  /** Header text as written. Empty string when the column is genuinely unlabelled. */
  readonly header: string;
  /**
   * What to call this column out loud. Falls back to an ordinal when the header is
   * missing or is something unspeakable like "Unnamed: 3" — a very common artefact
   * of exported spreadsheets.
   */
  readonly spokenName: string;
  readonly kind: ColumnKind;
  readonly nonEmpty: number;
  readonly empty: number;
  readonly distinct: number;
  /** Present only for low-cardinality columns, where listing them aloud is useful. */
  readonly categories?: readonly string[];
  readonly numeric?: NumericSummary;
  /**
   * The values are identifiers written in digits — phone numbers, postcodes, order
   * numbers. Typed as text, and read back exactly as written, never as a quantity.
   */
  readonly identifier?: boolean;
  /**
   * The column numbers the rows: "STT" over 1, 2, 3. Unlike other identifiers it stays
   * a number column, so "items 1 to 5" compares 10 with 5 as numbers rather than as
   * text ("10" sorts before "5"), but it has no `numeric` summary: a total of row
   * numbers is never what anyone asked for.
   */
  readonly rowNumbers?: boolean;
  /** Column letter in the original sheet, for provenance. */
  readonly sheetColumn: string;
}

/**
 * Merged cells are the classic screen-reader trap: the value exists once, but the
 * span covers rows or columns that then read as blank, so the user is told a field
 * is empty when it is not. We surface them rather than silently forward-filling,
 * because "this label covers the next four rows" is information the user needs.
 */
export interface MergeSpan {
  readonly value: CellValue;
  readonly topRow: number;
  readonly bottomRow: number;
  readonly leftCol: number;
  readonly rightCol: number;
  readonly a1: A1;
}

export interface TableRegion {
  /** Stable id used in tool calls, e.g. "sheet1.table1". */
  readonly id: string;
  /** Human label if one was found above the region (a title row), else null. */
  readonly title: string | null;
  readonly headerRow: number | null;
  readonly firstDataRow: number;
  readonly lastDataRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
  readonly rowCount: number;
  readonly columns: readonly ColumnProfile[];
  readonly rows: readonly (readonly CellValue[])[];
  readonly merges: readonly MergeSpan[];
  /**
   * Confidence that the header row was identified correctly, 0..1. Surfaced honestly:
   * a voice agent that says "I think row 3 is the header" is more useful than one
   * that quietly guesses wrong and reports nonsense totals.
   */
  readonly headerConfidence: number;
}

export interface SheetModel {
  readonly name: string;
  readonly index: number;
  readonly regions: readonly TableRegion[];
  /** Rows that sit outside any detected region — titles, notes, footnotes. */
  readonly strayText: readonly { readonly row: number; readonly text: string }[];
  readonly hidden: boolean;
}

export interface WorkbookModel {
  readonly sourceName: string;
  readonly format: 'xlsx' | 'csv';
  readonly sheets: readonly SheetModel[];
  readonly loadedAt: Date;
  /** Non-fatal problems worth mentioning once, aloud, when the file is opened. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function a1(row: number, col: number): A1 {
  return `${columnLetter(col)}${row + 1}`;
}

export function isBlank(v: CellValue): boolean {
  return v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Turn a header into something a synthesised voice can say without embarrassing
 * itself. Spreadsheet headers are full of snake_case, ALLCAPS, trailing units in
 * brackets, and export artefacts like "Unnamed: 4".
 */
export function toSpokenName(header: string, index: number): string {
  const raw = header.trim();
  if (!raw || /^unnamed(:|\s|$)/i.test(raw) || /^column\s*\d+$/i.test(raw)) {
    return `column ${index + 1}`;
  }
  const words = raw
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep acronyms upper, lower the rest; leave the first letter capitalised.
  const spoken = words
    .split(' ')
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(' ');
  return spoken.charAt(0).toUpperCase() + spoken.slice(1);
}

/**
 * The two heading rows an Excel PivotTable writes for itself: its value ("Sum of
 * Revenue") beside "Column Labels", over "Row Labels" and the column field's values
 * (2023, 2024, 2025, Grand Total). Read as one heading row, the years became a record,
 * "2024" named no column, and its total had the year itself added in.
 */
export function isPivotHeading(top: readonly unknown[], next: readonly unknown[]): boolean {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const value = top.map(text).find(Boolean) ?? '';
  return (
    /^(?:sum|count|average|max|min|product|stddev|stdevp?|var|varp|count numbers)\s+of\s+\S/i.test(value) &&
    top.some((v) => /^column labels$/i.test(text(v))) &&
    /^row labels$/i.test(next.map(text).find(Boolean) ?? '')
  );
}

/**
 * One cell of the row a Vietnamese form writes under its headings to number its
 * columns: "(1)", "(3=1+2)", "(3) = (1) + (2)", or a letter for a text column, "A".
 * The number it gives the column, or the letter, or null for anything else.
 */
function columnNumber(v: unknown): number | string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^[A-Z]$/.test(t) || /^\(\s*[A-Z]\s*\)$/.test(t)) return t.replace(/[()\s]/g, '');
  const m = /^\(\s*(\d{1,2})\s*(?:\)\s*)?(?:=\s*[()\d\s+\-x×*/.]+)?\)?$/u.exec(t);
  // Bracketed, whole: "(3)", "(3=1+2)", "(3)=(1)+(2)". A bare "3" is a figure.
  if (!m || !t.startsWith('(') || (t.match(/\(/g) ?? []).length !== (t.match(/\)/g) ?? []).length) return null;
  return Number(m[1]);
}

/**
 * Is this the row that numbers a form's columns — "(1) | (2) | (3) | (4) | (5)", or
 * "A | B | (1) | (2) | (3=1+2)" — rather than a record?
 *
 * A bracketed figure is an accounting negative, so "(45)" in a P&L is −45. Under a
 * form's headings, though, "(1)" to "(5)" are labels, and read as figures that row
 * became a record of negatives in every column. It is told apart as a row, not cell by
 * cell: every filled cell is such a label, at least two are numbers, the numbers count
 * up by one from left to right, and they fill at least half the row.
 */
export function isColumnNumbering(row: readonly unknown[]): boolean {
  const filled = row.filter((v) => !(v === null || v === undefined || (typeof v === 'string' && v.trim() === '')));
  if (filled.length < 2 || filled.length * 2 < row.length) return false;
  const labels = filled.map(columnNumber);
  if (labels.some((l) => l === null)) return false;
  const numbers = labels.filter((l): l is number => typeof l === 'number');
  return numbers.length >= 2 && numbers.every((n, k) => k === 0 || n === numbers[k - 1]! + 1);
}

/** A short, speakable count phrase: avoids "1 rows". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
