/**
 * Structure inference.
 *
 * A spreadsheet file gives you a grid of values. It does not tell you where the
 * tables are, which row is the header, or what a column means. Sighted users infer
 * all of that in about a second from visual layout — a glance costs nothing and is
 * not sequential. Recovering the same facts through a serial audio channel means
 * traversing the grid, which is why this module reconstructs the structure once, up
 * front, so a voice agent can describe a file the way a colleague would.
 *
 * Every heuristic here reports a confidence rather than a verdict, because being
 * honestly uncertain out loud ("I think row 3 is the header") is far more useful to
 * a blind user than a confident wrong answer they have no way to spot.
 */

import {
  a1,
  columnLetter,
  isBlank,
  plural,
  toSpokenName,
  type CellValue,
  type ColumnKind,
  type ColumnProfile,
  type MergeSpan,
  type NumericSummary,
  type TableRegion,
} from './model.ts';

export type Grid = readonly (readonly CellValue[])[];

/** Rows of blank that we treat as separating two independent tables. */
const REGION_GAP = 1;
/**
 * Above this share of distinct values, a text column is prose rather than a category.
 * The ratio alone is not enough on small samples — four rows holding two regions give
 * a ratio of 0.5, which is obviously categorical — so it is paired with a hard
 * requirement that at least one value repeats. Four distinct names in four rows is
 * a list of names, not a category.
 */
const CATEGORY_MAX_RATIO = 0.5;
const CATEGORY_MAX_DISTINCT = 25;

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

const CURRENCY = /^\s*(?:[$£€¥₫]|VND|USD|EUR|GBP)\s?-?[\d,.\s]+$|^\s*-?[\d,.\s]+\s?(?:[$£€¥₫]|VND|USD|EUR|GBP)\s*$/i;
const PERCENT = /^\s*-?[\d,.]+\s*%\s*$/;
const BOOLEANISH = /^(true|false|yes|no|y|n|có|không)$/i;

/** Strip grouping separators and symbols, then parse. Returns null if not numeric. */
export function asNumber(v: CellValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v instanceof Date || v === null) return null;
  const s = v.trim();
  if (!s) return null;
  const cleaned = s.replace(/[$£€¥₫\s%]|VND|USD|EUR|GBP/gi, '').replace(/,/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function asDate(v: CellValue): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // Only accept shapes that are unambiguously dates; a bare "2024" is a number.
  if (!/^\d{4}-\d{1,2}-\d{1,2}|^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Region detection
// ---------------------------------------------------------------------------

function rowIsBlank(row: readonly CellValue[] | undefined): boolean {
  return !row || row.every(isBlank);
}

interface RawRegion {
  readonly startRow: number;
  readonly endRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
}

/**
 * Split a sheet into blocks of contiguous non-blank rows. Blank rows are the
 * near-universal convention for separating tables, and they are exactly what a
 * screen reader renders as an unexplained silence.
 */
export function detectRegions(grid: Grid): RawRegion[] {
  const regions: RawRegion[] = [];
  let start: number | null = null;
  let gap = 0;

  const flush = (endRow: number) => {
    if (start === null) return;
    const bounds = columnBounds(grid, start, endRow);
    if (bounds) regions.push({ startRow: start, endRow, ...bounds });
    start = null;
  };

  for (let r = 0; r < grid.length; r++) {
    if (rowIsBlank(grid[r])) {
      gap++;
      if (start !== null && gap >= REGION_GAP) flush(r - gap);
    } else {
      if (start === null) start = r;
      gap = 0;
    }
  }
  if (start !== null) flush(grid.length - 1);
  return regions.filter((r) => r.endRow >= r.startRow);
}

function columnBounds(
  grid: Grid,
  startRow: number,
  endRow: number,
): { firstCol: number; lastCol: number } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = -1;
  for (let r = startRow; r <= endRow; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (!isBlank(row[c] ?? null)) {
        if (c < first) first = c;
        if (c > last) last = c;
      }
    }
  }
  return last < 0 ? null : { firstCol: first, lastCol: last };
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

/**
 * Decide whether the first row of a region is a header, and how sure we are.
 *
 * Four independent signals, because no single one is reliable. A table of country
 * names has an all-text header *and* all-text data; a table with a numeric header
 * row like "2021 2022 2023" breaks the type-discontinuity signal entirely.
 */
export function scoreHeaderRow(
  candidate: readonly CellValue[],
  body: Grid,
): number {
  if (candidate.length === 0) return 0;
  const cells = candidate.filter((c) => !isBlank(c));
  if (cells.length === 0) return 0;

  let score = 0;

  // 1. Header cells are text while the column below is not. The strongest signal.
  let discontinuities = 0;
  let comparable = 0;
  for (let c = 0; c < candidate.length; c++) {
    const head = candidate[c] ?? null;
    if (isBlank(head)) continue;
    const below = body.map((r) => r[c] ?? null).filter((v) => !isBlank(v));
    if (below.length === 0) continue;
    comparable++;
    const headIsText = asNumber(head) === null && asDate(head) === null;
    const belowMostlyTyped =
      below.filter((v) => asNumber(v) !== null || asDate(v) !== null).length / below.length > 0.7;
    if (headIsText && belowMostlyTyped) discontinuities++;
  }
  if (comparable > 0) score += 0.45 * (discontinuities / comparable);

  // 2. Headers are distinct from one another. Data rows repeat; labels rarely do.
  const texts = cells.map((c) => String(c).trim().toLowerCase());
  score += 0.2 * (new Set(texts).size / texts.length);

  // 3. Headers are dense — a label row with holes in it is usually a data row.
  score += 0.15 * (cells.length / candidate.length);

  // 4. Headers are short. Prose in row 1 is a title or a note, not a header.
  const avgLen = texts.reduce((a, t) => a + t.length, 0) / texts.length;
  score += 0.2 * (avgLen > 0 && avgLen <= 32 ? 1 : avgLen <= 60 ? 0.4 : 0);

  // Signals 2-4 are weak on their own: an all-numeric first row over numeric data
  // scores well on distinctness, density and brevity while being almost certainly
  // data. Type discontinuity is the only strong signal, so let its absence veto —
  // but only where the signal could have fired at all.
  //
  // In a region that is text from top to bottom (a notes table, a status list) there
  // is nothing for a type discontinuity to be made of. Penalising the row for failing
  // to demonstrate a distinction the data cannot express reads absence of evidence as
  // evidence of absence, and loses the header on every all-text table.
  const typedBelow = body.some((row) =>
    row.some((v) => !isBlank(v) && (asNumber(v) !== null || asDate(v) !== null)),
  );

  const allNumeric = cells.every((c) => asNumber(c) !== null);
  if (allNumeric) {
    // A row like "2021 2022 2023" genuinely is an ambiguous case even for a human.
    // We report low confidence and let the caller override rather than guess.
    score *= 0.3;
  } else if (typedBelow && comparable > 0 && discontinuities / comparable < 0.3) {
    score *= 0.6;
  }

  return Math.min(1, score);
}

// ---------------------------------------------------------------------------
// Column profiling
// ---------------------------------------------------------------------------

export function profileColumn(
  values: readonly CellValue[],
  header: string,
  indexInRegion: number,
  sheetColIndex: number,
): ColumnProfile {
  const present = values.filter((v) => !isBlank(v));
  const empty = values.length - present.length;
  const distinctSet = new Set(present.map((v) => String(v instanceof Date ? v.toISOString() : v).trim()));

  const base = {
    index: indexInRegion,
    header,
    spokenName: toSpokenName(header, indexInRegion),
    nonEmpty: present.length,
    empty,
    distinct: distinctSet.size,
    sheetColumn: columnLetter(sheetColIndex),
  } as const;

  if (present.length === 0) {
    return { ...base, kind: 'empty' };
  }

  const numbers = present.map(asNumber);
  const numericCount = numbers.filter((n) => n !== null).length;
  const dateCount = present.filter((v) => asDate(v) !== null).length;
  const boolCount = present.filter(
    (v) => typeof v === 'boolean' || (typeof v === 'string' && BOOLEANISH.test(v.trim())),
  ).length;

  const share = (n: number) => n / present.length;

  if (share(boolCount) > 0.9) return { ...base, kind: 'boolean' };
  if (share(dateCount) > 0.8) return { ...base, kind: 'date' };

  if (share(numericCount) > 0.8) {
    const vals = numbers.filter((n): n is number => n !== null);
    const sum = vals.reduce((a, b) => a + b, 0);
    const numeric: NumericSummary = {
      min: Math.min(...vals),
      max: Math.max(...vals),
      sum,
      mean: sum / vals.length,
      nonNumeric: present.length - numericCount,
    };
    const strings = present.filter((v) => typeof v === 'string') as string[];
    const currencyish = strings.filter((s) => CURRENCY.test(s)).length;
    const percentish = strings.filter((s) => PERCENT.test(s)).length;
    const kind: ColumnKind =
      strings.length > 0 && currencyish / strings.length > 0.6
        ? 'currency'
        : strings.length > 0 && percentish / strings.length > 0.6
          ? 'percent'
          : 'number';
    return { ...base, kind, numeric };
  }

  // Mixed: enough typed values to be confusing, not enough to be trustworthy.
  if (share(numericCount) > 0.3 || share(dateCount) > 0.3) {
    return { ...base, kind: 'mixed' };
  }

  const ratio = distinctSet.size / present.length;
  const repeats = distinctSet.size < present.length;
  if (repeats && distinctSet.size <= CATEGORY_MAX_DISTINCT && ratio <= CATEGORY_MAX_RATIO) {
    return {
      ...base,
      kind: 'category',
      categories: [...distinctSet].sort((a, b) => a.localeCompare(b)),
    };
  }

  return { ...base, kind: 'text' };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildRegion(
  grid: Grid,
  raw: RawRegion,
  id: string,
  merges: readonly MergeSpan[],
  titleAbove: string | null,
): TableRegion {
  const width = raw.lastCol - raw.firstCol + 1;
  const slice = (r: number): CellValue[] => {
    const row = grid[r] ?? [];
    return Array.from({ length: width }, (_, i) => row[raw.firstCol + i] ?? null);
  };

  const firstRow = slice(raw.startRow);
  const body = [];
  for (let r = raw.startRow + 1; r <= raw.endRow; r++) body.push(slice(r));

  const confidence = body.length === 0 ? 0 : scoreHeaderRow(firstRow, body);
  const hasHeader = confidence >= 0.5 && body.length > 0;

  const headerRow = hasHeader ? raw.startRow : null;
  const dataRows = hasHeader ? body : [firstRow, ...body];
  const firstDataRow = hasHeader ? raw.startRow + 1 : raw.startRow;

  const headers = hasHeader
    ? firstRow.map((c) => (isBlank(c) ? '' : String(c).trim()))
    : Array.from({ length: width }, () => '');

  const columns = headers.map((h, i) =>
    profileColumn(
      dataRows.map((r) => r[i] ?? null),
      h,
      i,
      raw.firstCol + i,
    ),
  );

  const inRegion = merges.filter(
    (m) =>
      m.topRow >= raw.startRow &&
      m.bottomRow <= raw.endRow &&
      m.leftCol >= raw.firstCol &&
      m.rightCol <= raw.lastCol,
  );

  return {
    id,
    title: titleAbove,
    headerRow,
    firstDataRow,
    lastDataRow: raw.endRow,
    firstCol: raw.firstCol,
    lastCol: raw.lastCol,
    rowCount: dataRows.length,
    columns,
    rows: dataRows,
    merges: inRegion,
    headerConfidence: confidence,
  };
}

// ---------------------------------------------------------------------------
// Spoken descriptions
// ---------------------------------------------------------------------------

/**
 * The one-breath summary an agent reads when a table is opened. Ordered by what a
 * blind user needs first: how big is it, what is in it, and is anything odd.
 */
export function describeRegion(region: TableRegion): string {
  const parts: string[] = [];
  const label = region.title ? `"${region.title}"` : 'This table';
  parts.push(
    `${label} has ${plural(region.rowCount, 'row')} and ${plural(region.columns.length, 'column')}.`,
  );

  if (region.headerRow === null) {
    parts.push('I could not find a header row, so I will refer to columns by position.');
  } else if (region.headerConfidence < 0.7) {
    parts.push(
      `I think row ${region.headerRow + 1} is the header, but I am not certain — say "check the header" if that sounds wrong.`,
    );
  }

  const named = region.columns.filter((c) => c.kind !== 'empty');
  if (named.length) {
    parts.push(`The columns are: ${named.map((c) => c.spokenName).join(', ')}.`);
  }

  const numeric = named.filter((c) => c.numeric);
  if (numeric.length) {
    parts.push(`You can total or compare: ${numeric.map((c) => c.spokenName).join(', ')}.`);
  }

  const gappy = named.filter((c) => c.empty > 0 && c.nonEmpty > 0);
  if (gappy.length) {
    parts.push(
      `Some columns have gaps: ${gappy.map((c) => `${c.spokenName} is missing ${c.empty}`).join('; ')}.`,
    );
  }

  if (region.merges.length) {
    // State the structural fact, not a claim about what any particular reader does.
    // The value is stored once; the cells the span covers are genuinely empty in the
    // file, so anything reading them literally reports a gap that is not there.
    parts.push(
      `Note: ${plural(region.merges.length, 'merged cell')} in this table. The label is stored once and covers the rows beneath it, so those cells read as empty even though they are labelled.`,
    );
  }

  const mixed = named.filter((c) => c.kind === 'mixed');
  if (mixed.length) {
    parts.push(
      `${mixed.map((c) => c.spokenName).join(' and ')} mix text and numbers, so totals there may be unreliable.`,
    );
  }

  return parts.join(' ');
}

/** Anchor a single cell to its identity, so it can be spoken without coordinates. */
export function describeCell(
  region: TableRegion,
  rowIndex: number,
  colIndex: number,
): string {
  const col = region.columns[colIndex];
  const value = region.rows[rowIndex]?.[colIndex] ?? null;
  const name = col?.spokenName ?? `column ${colIndex + 1}`;
  const shown = isBlank(value) ? 'empty' : String(value instanceof Date ? value.toDateString() : value);
  const addr = a1(region.firstDataRow + rowIndex, region.firstCol + colIndex);
  return `${name}: ${shown} (${addr})`;
}
