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

// The dong is written with its own sign (₫), with a plain "đ" in everyday Vietnamese
// typing, or as VND/VNĐ. All four mark the same currency, and all four have to be
// recognised or a Vietnamese price list reads as text.
const CURRENCY_MARK = String.raw`(?:[$£€¥₫]|VNĐ|VND|USD|EUR|GBP|đ)`;
const CURRENCY = new RegExp(
  String.raw`^\s*${CURRENCY_MARK}\s?-?[\d,.\s]+$|^\s*-?[\d,.\s]+\s?${CURRENCY_MARK}\s*$`,
  'iu',
);
const PERCENT = /^\s*-?[\d,.]+\s*%\s*$/;
const BOOLEANISH = /^(true|false|yes|no|y|n|có|không)$/i;
/**
 * A currency amount has two minor digits at most — the dong and the yen have none — so
 * one separator followed by exactly three digits can only group thousands: "€1.200",
 * "$1,200", "45.000 ₫". Read as a decimal, "€12.000" was twelve euros.
 */
const CURRENCY_SIGN = new RegExp(CURRENCY_MARK, 'iu');
/** Digits grouped by commas in thousands ("1,250,000"), or in lakhs and crores ("12,50,000"). */
const COMMA_GROUPED = String.raw`(?:\d{1,3}(?:,\d{3})*|\d{1,2}(?:,\d{2})+,\d{3})`;
const COMMA_GROUPED_WHOLE = new RegExp(`^${COMMA_GROUPED}$`);
const COMMA_GROUPED_DECIMAL = new RegExp(String.raw`^${COMMA_GROUPED}\.\d+$`);

/**
 * How a number written as text uses its separators.
 *
 * - `dot`: a dot is the decimal point and commas group thousands — "1,234.50".
 * - `comma`: a comma is the decimal point and dots group thousands — "1.234,50",
 *   the convention in Vietnam and most of Europe.
 * - `ambiguous`: one separator followed by exactly three digits — "1.234", "12,500".
 *   Both conventions read it, a thousand times apart, and the text alone cannot say
 *   which was meant.
 * - `plain`: no separator at all, so there is nothing to decide.
 */
export type NumberStyle = 'dot' | 'comma' | 'ambiguous' | 'plain';

export interface ReadNumber {
  readonly value: number;
  readonly style: NumberStyle;
}

/**
 * Parse a number written as text, reporting which separator convention it used.
 *
 * Stripping every comma and keeping the dot — the obvious implementation — reads
 * "1.234,50" as 1.2345 and "45.000 ₫" as 45: a Vietnamese price list totals a
 * thousand times too small, with nothing to tell the listener. So the convention is
 * decided from the text wherever the text decides it (two different separators, a
 * separator used twice, a comma followed by anything but three digits), and only the
 * genuinely ambiguous shape falls back to `convention`, which defaults to the dot.
 */
export function readNumber(v: CellValue, convention: 'dot' | 'comma' = 'dot'): ReadNumber | null {
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, style: 'plain' } : null;
  if (typeof v === 'boolean' || v instanceof Date || v === null) return null;
  const s = v.trim();
  // Most text is not a number at all; this runs on every cell of every query.
  if (!s || !/\d/.test(s)) return null;
  const body = s.replace(/VNĐ|VND|USD|EUR|GBP|[$£€¥₫%\s]/giu, '').replace(/^đ|đ$/iu, '');
  if (!/^-?[\d.,]*\d$/.test(body)) return null;

  const negative = body.startsWith('-');
  const digits = negative ? body.slice(1) : body;
  const signed = (n: number): number => (negative ? -n : n);
  const done = (text: string, style: NumberStyle): ReadNumber | null => {
    const n = Number(text);
    return Number.isFinite(n) ? { value: signed(n), style } : null;
  };

  const dots = (digits.match(/\./g) ?? []).length;
  const commas = (digits.match(/,/g) ?? []).length;

  if (dots === 0 && commas === 0) return done(digits, 'plain');

  if (dots > 0 && commas > 0) {
    // Both present: whichever comes last is the decimal point.
    if (digits.lastIndexOf('.') > digits.lastIndexOf(',')) {
      return COMMA_GROUPED_DECIMAL.test(digits) ? done(digits.replace(/,/g, ''), 'dot') : null;
    }
    return /^\d{1,3}(?:\.\d{3})*,\d+$/.test(digits)
      ? done(digits.replace(/\./g, '').replace(',', '.'), 'comma')
      : null;
  }

  const sep = dots > 0 ? '.' : ',';
  const count = dots > 0 ? dots : commas;
  if (count > 1) {
    // The same separator twice can only be grouping: "1.250.000", "1,250,000".
    const grouped = sep === '.' ? /^\d{1,3}(?:\.\d{3})+$/ : COMMA_GROUPED_WHOLE;
    if (!grouped.test(digits)) return null;
    return done(digits.split(sep).join(''), sep === '.' ? 'comma' : 'dot');
  }

  const [whole = '', fraction = ''] = digits.split(sep);
  // A group of three after one to three digits (not a lone zero) is the only shape
  // that both conventions accept.
  const couldGroup = fraction.length === 3 && /^[1-9]\d{0,2}$/.test(whole);
  if (!couldGroup) {
    // Anything else can only be a decimal point: "1.5", "10,5", "1234,56".
    return done(`${whole || '0'}.${fraction}`, sep === '.' ? 'dot' : 'comma');
  }
  if (CURRENCY_SIGN.test(s)) return done(whole + fraction, sep === '.' ? 'comma' : 'dot');
  // A percentage almost never runs into the thousands, so a dot before three digits is
  // its decimal point. This is also exactly how the reader writes an Excel cell shown
  // through "0.0%" (0.07125 becomes "7.125%"); read as grouping, a Vietnamese file's
  // discount column became 7125%.
  if (sep === '.' && s.endsWith('%')) return done(`${whole}.${fraction}`, 'dot');
  const groupingRead = sep === (convention === 'comma' ? '.' : ',');
  return done(groupingRead ? whole + fraction : `${whole}.${fraction}`, 'ambiguous');
}

/** Strip grouping separators and symbols, then parse. Returns null if not numeric. */
export function asNumber(v: CellValue): number | null {
  return readNumber(v)?.value ?? null;
}

/**
 * The text decides its own convention beyond reasonable doubt: two separators
 * ("1.234,50", "1.250.000") or a currency sign ("€1.200"). A lone "8,10" also reads one
 * way only if it is a number at all — in a list of shoe sizes it is not — so it is
 * weaker evidence about how the rest of a file writes its numbers.
 */
export function stronglyDecided(text: string): boolean {
  return (text.match(/[.,]/g) ?? []).length >= 2 || CURRENCY_SIGN.test(text);
}

/**
 * Decide a column's separator convention from the values that show it.
 *
 * When nothing in the column settles it, the dot wins — the common case — and
 * `ambiguous` says the reading is a guess. The caller may then borrow what the rest of
 * the file shows (a file written in one locale is written in it throughout), and says
 * so out loud either way rather than burying it.
 */
export function numberConvention(values: readonly CellValue[]): {
  readonly convention: 'dot' | 'comma';
  /** Values that read differently under the two conventions exist and nothing decided them. */
  readonly ambiguous: boolean;
  /** Both conventions are demonstrably in use in this column. */
  readonly conflicting: boolean;
  /** One value that reads differently under the two conventions, for a spoken example. */
  readonly example: string | null;
} {
  let dot = 0;
  let comma = 0;
  let example: string | null = null;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const r = readNumber(v);
    if (!r) continue;
    if (r.style === 'dot') dot++;
    else if (r.style === 'comma') comma++;
    else if (r.style === 'ambiguous') example ??= v.trim();
  }
  if (dot > 0 && comma > 0) {
    return { convention: 'dot', ambiguous: false, conflicting: true, example };
  }
  if (comma > 0) return { convention: 'comma', ambiguous: false, conflicting: false, example };
  if (dot > 0) return { convention: 'dot', ambiguous: false, conflicting: false, example };
  return { convention: 'dot', ambiguous: example !== null, conflicting: false, example };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** Month names for speech, indexed like Date.getUTCMonth(). */
export const MONTH_NAMES = MONTHS.map((m) => m.charAt(0).toUpperCase() + m.slice(1));

function monthNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return null;
  const i = MONTHS.findIndex((m) => m === w || (m.startsWith(w) && (w.length === 3 || w === 'sept')));
  return i < 0 ? null : i + 1;
}

/**
 * A calendar date (and optional wall-clock time) as a UTC instant, or null when the
 * parts do not name a real day. Date.UTC quietly rolls 31 February into March;
 * checking the parts back is what makes "2/30/2026" fail instead of meaning 2 March.
 */
function utcDate(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0): Date | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  const t = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  const date = new Date(t);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Date.toISOString() output: "2026-07-04T00:00:00.000Z". */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fullYear(y: string): number {
  const n = Number(y);
  // Excel's own two-digit rule: 00-29 are this century, 30-99 the last.
  return y.length === 2 ? (n < 30 ? 2000 + n : 1900 + n) : n;
}

/**
 * Parse a date written as text into a UTC instant.
 *
 * Every date is a calendar date in UTC. `new Date("1/15/2024")` reads the string in
 * the host's own time zone while a spreadsheet date arrives as UTC midnight, so the
 * same filter matched on a UTC Worker and missed on a laptop in Hanoi. Building the
 * instant from the parts removes the host from the answer.
 *
 * `order` decides a numeric day-and-month that fits both ways ("04/07/2026"); a value
 * that only fits one way ("15/01/2024") is read that way regardless.
 */
export function parseDateText(text: string, order: 'mdy' | 'dmy' = 'mdy'): Date | null {
  const s = text.trim();
  // Every accepted form has a digit and is short; anything else is answered at once.
  if (!s || s.length > 40 || !/\d/.test(s)) return null;
  // The form this system stores every date in, which is already an exact instant.
  // Its day is checked back, because Date rolls "02-30" into March without a word.
  if (CANONICAL_INSTANT.test(s)) {
    const d = new Date(s);
    return d.getUTCDate() === Number(s.slice(8, 10)) && d.getUTCMonth() + 1 === Number(s.slice(5, 7)) ? d : null;
  }

  // July 4, 2026 / Jul 4 2026 / Sept. 4th, 2026 — the form the server itself speaks,
  // and the only accepted form that does not start with a digit.
  const lead = s.charCodeAt(0);
  if (lead < 48 || lead > 57) {
    const mdy = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
    const m = mdy ? monthNumber(mdy[1]!) : null;
    return mdy && m ? utcDate(Number(mdy[3]), m, Number(mdy[2])) : null;
  }

  // ISO: 2026-07-04, 2026-07-04T13:45:00, with an optional zone.
  const iso =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
  if (iso) {
    const [, y, mo, d, hh, mi, ss, ms, zone] = iso;
    const local = utcDate(
      Number(y), Number(mo), Number(d),
      Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0), Number((ms ?? '0').padEnd(3, '0')),
    );
    if (!local || !zone || /^z$/i.test(zone)) return local;
    // An explicit offset names an instant; honour it rather than the wall clock.
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!z) return null;
    const offset = (Number(z[2]) * 60 + Number(z[3])) * (z[1] === '-' ? -1 : 1);
    return new Date(local.getTime() - offset * 60_000);
  }

  // 2026/07/04
  const ymd = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (ymd) return utcDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));

  // 7/4/2026, 04.07.26, with an optional time.
  const num = /^(\d{1,2})([/\-.])(\d{1,2})[/\-.](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (num) {
    const [, a, separator, b, y, hh, mi, ss] = num;
    const time = [Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0)] as const;
    // Nobody writes a month-first date with dots; "04.07.2026" is 4 July everywhere
    // that uses the dot.
    const monthFirst = order === 'mdy' && separator !== '.';
    const first = monthFirst ? [Number(a), Number(b)] : [Number(b), Number(a)];
    const second = monthFirst ? [Number(b), Number(a)] : [Number(a), Number(b)];
    return (
      utcDate(fullYear(y!), first[0]!, first[1]!, ...time) ??
      utcDate(fullYear(y!), second[0]!, second[1]!, ...time)
    );
  }

  // 4 July 2026 / 4 Jul 2026 / 04-Jul-2026 / 4-Jul-26
  const dmy = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]([a-z]{3,9})\.?,?[\s-](\d{4}|\d{2})$/i.exec(s);
  if (dmy) {
    const m = monthNumber(dmy[2]!);
    return m ? utcDate(fullYear(dmy[3]!), m, Number(dmy[1])) : null;
  }

  return null;
}

/**
 * A date, or null. Only shapes that are unambiguously dates are accepted; a bare
 * "2024" is a number. Date-only text becomes UTC midnight.
 */
export function asDate(v: CellValue): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  return parseDateText(v);
}

/**
 * Which way round a column writes its numeric dates. One value that only fits
 * day-first ("15/01/2024") settles it for the "04/07/2026" beside it, the way a
 * person reading the column would; anything unsettled stays month-first.
 */
export function dateOrder(values: readonly CellValue[], fallback: 'mdy' | 'dmy' = 'mdy'): 'mdy' | 'dmy' {
  return dateOrderEvidence(values).order ?? fallback;
}

/**
 * What a column's own dates say about their order: `dmy` or `mdy` when a value only
 * fits one way (both at once keeps month first, as before), or null when none does.
 * `example` is a value that reads as two different days — "01/09/2026" is 1 September
 * or 9 January — when there is one, which is when a guess changes the answer. A dotted
 * date is never one: nobody writes month first with dots.
 */
export function dateOrderEvidence(values: readonly CellValue[]): {
  readonly order: 'mdy' | 'dmy' | null;
  readonly example: string | null;
  /** How many values are written as numbers with a day and a month in some order. */
  readonly written: number;
} {
  let dayFirst = 0;
  let monthFirst = 0;
  let written = 0;
  let example: string | null = null;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const m = /^(\d{1,2})([/\-.])(\d{1,2})[/\-.]\d{2,4}\b/.exec(v.trim());
    if (!m) continue;
    written++;
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
    else if (a !== b && a >= 1 && b >= 1 && m[2] !== '.') example ??= v.trim();
  }
  const order = dayFirst > 0 && monthFirst === 0 ? 'dmy' : monthFirst > 0 ? 'mdy' : null;
  return { order, example, written };
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
    if (bounds) {
      // A band of rows can still hold two unrelated tables side by side. Splitting
      // on blank rows alone merges them into one region, which then invents a
      // relationship between an item list and an invoice list that share nothing but
      // a row number — and reads out column names from both as if they were one table.
      for (const span of splitOnBlankColumns(grid, start, endRow, bounds.firstCol, bounds.lastCol)) {
        // Each table keeps only its own rows. Side by side with a longer one, a table of
        // three stores took the other's five rows, and was counted as five, the last two
        // read aloud as "City empty and Staff empty".
        const filled = (r: number): boolean => {
          for (let c = span.firstCol; c <= span.lastCol; c++) if (!isBlank(grid[r]?.[c] ?? null)) return true;
          return false;
        };
        let top = start;
        let bottom = endRow;
        while (top < bottom && !filled(top)) top++;
        while (bottom > top && !filled(bottom)) bottom--;
        regions.push({ startRow: top, endRow: bottom, ...span });
      }
    }
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

/**
 * Split a band of rows into column runs separated by columns that are blank all the
 * way down.
 *
 * A column that happens to be empty in the header row is not a separator — a title
 * row above a table leaves plenty of those. The separator has to be empty across the
 * *whole* band, which is what makes it a gutter between two tables rather than a gap
 * inside one.
 */
function splitOnBlankColumns(
  grid: Grid,
  startRow: number,
  endRow: number,
  firstCol: number,
  lastCol: number,
): { firstCol: number; lastCol: number }[] {
  const columnIsBlank = (c: number): boolean => {
    for (let r = startRow; r <= endRow; r++) {
      if (!isBlank(grid[r]?.[c] ?? null)) return false;
    }
    return true;
  };

  const runs: { firstCol: number; lastCol: number }[] = [];
  let runStart: number | null = null;
  for (let c = firstCol; c <= lastCol; c++) {
    if (columnIsBlank(c)) {
      if (runStart !== null) {
        runs.push({ firstCol: runStart, lastCol: c - 1 });
        runStart = null;
      }
    } else if (runStart === null) {
      runStart = c;
    }
  }
  if (runStart !== null) runs.push({ firstCol: runStart, lastCol });

  // One run means there was nothing to split; hand back the original bounds so the
  // common case is untouched.
  if (!runs.length) return [{ firstCol, lastCol }];

  // A block of figures on the far side of a spacer column, on the same rows and with no
  // label column of its own, is the rest of the table on its left: "Region | Sales 2025
  // | Sales 2026 | (blank) | Growth". Split off, "Growth for North" had no North to find
  // and the table on the left had no Growth. The spacer stays inside the table as an
  // unnamed empty column; a block that brings its own labels is a table of its own.
  const joined: { firstCol: number; lastCol: number }[] = [];
  for (const run of runs) {
    const left = joined[joined.length - 1];
    if (left && continuesLeft(grid, startRow, endRow, left, run)) {
      joined[joined.length - 1] = { firstCol: left.firstCol, lastCol: run.lastCol };
    } else {
      joined.push(run);
    }
  }
  return joined;
}

/**
 * Is `right` a continuation of `left` across a spacer column?
 *
 * It must fill exactly the rows `left` fills, from its own first row down — a title
 * line above both may sit on the left alone — and below that first row, its heading,
 * hold nothing but numbers and dates. A text cell there is a label, and a block with
 * labels of its own is a separate table.
 */
function continuesLeft(
  grid: Grid,
  startRow: number,
  endRow: number,
  left: { firstCol: number; lastCol: number },
  right: { firstCol: number; lastCol: number },
): boolean {
  const filled = (r: number, span: { firstCol: number; lastCol: number }): boolean => {
    for (let c = span.firstCol; c <= span.lastCol; c++) if (!isBlank(grid[r]?.[c] ?? null)) return true;
    return false;
  };
  let top = -1;
  for (let r = startRow; r <= endRow && top < 0; r++) if (filled(r, right)) top = r;
  if (top < 0 || top === endRow) return false;
  for (let r = top; r <= endRow; r++) {
    if (filled(r, left) !== filled(r, right)) return false;
  }
  for (let c = right.firstCol; c <= right.lastCol; c++) {
    const below: CellValue[] = [];
    for (let r = top + 1; r <= endRow; r++) {
      const v = grid[r]?.[c] ?? null;
      if (isBlank(v) || isPlaceholder(v)) continue;
      if (asNumber(v) === null && asDate(v) === null) return false;
      below.push(v);
    }
    // Invoice numbers are a label column too, even when they are digits.
    const heading = grid[top]?.[c] ?? null;
    if (below.length && looksLikeIdentifier(isBlank(heading) ? '' : String(heading), below)) return false;
  }
  return true;
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
/**
 * Why a candidate row scored the way it did.
 *
 * A bare number cannot distinguish the two situations that matter most here.
 * A row can score low because the evidence says it is data, or because the table
 * offers no evidence either way — an all-numeric row above numeric data is the
 * classic case, and a human reader cannot resolve it from the values alone either.
 * The first calls for a decision; the second calls for a question. Collapsing them
 * into one number is what made this module lose records while reporting confidence.
 */
export interface HeaderSignals {
  readonly score: number;
  /** Every non-blank candidate cell parses as a number. Inherently ambiguous. */
  readonly allNumeric: boolean;
  /** The rows below contain numbers or dates, so a type discontinuity could exist. */
  readonly typedBelow: boolean;
  /** Share of comparable columns where label-over-typed-data actually holds, 0..1. */
  readonly discontinuity: number;
  /** Share of the row's width that is non-blank, 0..1. */
  readonly density: number;
  /**
   * Labelled columns whose values below are mostly numbers or dates — the only
   * columns where a type discontinuity could show. Zero means the region gives the
   * strongest signal nothing to work with.
   */
  readonly typedColumns: number;
  /**
   * The row would have read as a header but for the type-discontinuity veto, and the
   * cells that failed it look like labels anyway: two or more distinct years or dates
   * over values that are not. "Region, 2024, 2025, 2026" is the everyday shape. The veto is the reason the
   * score is low, not evidence that the row is data, so the caller must ask.
   */
  readonly vetoed: boolean;
  /** What the label-like typed cells were, for the spoken alternative. */
  readonly labelKind: 'years' | 'dates' | null;
}

/** A four-digit calendar year, whether stored as a number or typed as text. */
function yearLike(v: CellValue): boolean {
  if (typeof v === 'string' && !/^\s*\d{4}\s*$/.test(v)) return false;
  const n = asNumber(v);
  return n !== null && Number.isInteger(n) && n >= 1900 && n <= 2100;
}

function dateLike(v: CellValue): boolean {
  return v instanceof Date || (typeof v === 'string' && asDate(v) !== null);
}

export function headerSignals(
  candidate: readonly CellValue[],
  body: Grid,
): HeaderSignals {
  const empty: HeaderSignals = {
    score: 0,
    allNumeric: false,
    typedBelow: false,
    discontinuity: 0,
    density: 0,
    typedColumns: 0,
    vetoed: false,
    labelKind: null,
  };
  if (candidate.length === 0) return empty;
  const cells = candidate.filter((c) => !isBlank(c));
  if (cells.length === 0) return empty;

  let score = 0;

  // 1. Header cells are text while the column below is not. The strongest signal.
  let discontinuities = 0;
  let comparable = 0;
  let typedColumns = 0;
  let labelLikeYears = 0;
  let labelLikeDates = 0;
  // The distinct years or dates among them. One is not a heading row: "Rent, 2000" over
  // "Food, 450" is a record whose amount happens to fall between 1900 and 2100. Headings
  // come as a run — 2024, 2025, 2026 — and only a run is worth a question.
  const labelHeads = new Set<string>();
  for (let c = 0; c < candidate.length; c++) {
    const head = candidate[c] ?? null;
    if (isBlank(head)) continue;
    const below = body.map((r) => r[c] ?? null).filter((v) => !isBlank(v));
    if (below.length === 0) continue;
    comparable++;
    // A yes-or-no column is typed too: "Paid" over Yes and No is a label over answers,
    // and without it a Name/Paid list had nothing to show its heading by. "Yes" over
    // "No" is two answers, not a label over one. At least three answers, because one
    // country code "NO" under a record is not a column of answers, and taken for one it
    // made a lower record the heading row.
    const belowFlags = below.length >= 3 && below.filter(booleanish).length / below.length > 0.9;
    const headIsText = asNumber(head) === null && asDate(head) === null && !(belowFlags && booleanish(head));
    const belowMostlyTyped = typedShare(below) > 0.7 || belowFlags;
    if (belowMostlyTyped) {
      typedColumns++;
      // A year or a date heading a column of values that are not years or dates reads
      // as a label to anyone looking at it, even though it is not text.
      const share = (test: (v: CellValue) => boolean) => below.filter(test).length / below.length;
      const key = head instanceof Date ? head.toISOString() : String(head).trim();
      if (!headIsText && dateLike(head) && share(dateLike) < 0.5) {
        labelLikeDates++;
        labelHeads.add(key);
      } else if (!headIsText && yearLike(head) && share(yearLike) < 0.5) {
        labelLikeYears++;
        labelHeads.add(key);
      }
    }
    if (headIsText && belowMostlyTyped) discontinuities++;
  }
  // Measured against the typed columns, the only ones where a label can be seen sitting
  // over values of another kind. Divided by every column, a staff list whose one Salary
  // column showed it perfectly scored 0.64, under the bar for confidence, and every
  // answer from it carried "I am not certain how this table's headings read" — offering
  // to read a plainly labelled heading row as a record.
  if (typedColumns > 0) score += 0.45 * (discontinuities / typedColumns);

  // 2. Headers are distinct from one another. Data rows repeat; labels rarely do.
  // A Date is measured as its calendar day: String(Date) is a fifty-character local
  // time-zone rendering, which made the brevity signal below depend on the host.
  const texts = cells.map((c) =>
    (c instanceof Date ? c.toISOString().slice(0, 10) : String(c)).trim().toLowerCase(),
  );
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
  const discontinuity = comparable > 0 ? discontinuities / comparable : 0;

  const unpenalised = score;
  if (allNumeric) {
    // A row like "2021 2022 2023" genuinely is ambiguous even for a human. The
    // penalty stops it being taken as a header silently; the `allNumeric` flag is
    // what lets the caller ask instead of deciding.
    score *= 0.3;
  } else if (typedColumns > 0 && discontinuities / typedColumns < 0.3) {
    // Measured against the typed columns only. A staff list with one Salary column
    // among four text columns shows its label-over-number break in the only place it
    // could; dividing by every column diluted that to 0.2 and vetoed the header of
    // every mostly-text table.
    score *= 0.6;
  }

  const labelLike = labelLikeYears + labelLikeDates;
  return {
    score: Math.min(1, score),
    allNumeric,
    typedBelow,
    discontinuity,
    density: cells.length / candidate.length,
    typedColumns,
    vetoed: !allNumeric && score < unpenalised && unpenalised >= 0.5 && labelHeads.size >= 2,
    labelKind: labelLike === 0 ? null : labelLikeDates > labelLikeYears ? 'dates' : 'years',
  };
}

/** The score alone, for callers that only need to compare two rows. */
export function scoreHeaderRow(candidate: readonly CellValue[], body: Grid): number {
  return headerSignals(candidate, body).score;
}

// ---------------------------------------------------------------------------
// Column profiling
// ---------------------------------------------------------------------------

/**
 * A heading that ENDS in an identifier word — "Customer ID", "Zip", "Product code",
 * "Phone" — or follows it with a number word: "Phone number", "ID no.", "Order #".
 * English puts the head noun last, so "Mobile revenue", "Phone sales", "Postal charges"
 * and "Code coverage" are quantities, and the letter boundaries keep "Paid", "Valid" and
 * "Width" out. Vietnamese puts it first ("Mã hàng", "Số điện thoại"), so its words may
 * sit anywhere.
 */
const identifierHeading = (words: string, vietnamese: string): RegExp =>
  new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}])${words}\.?(?:\s*(?:no\.?|nr\.?|number|num|#|id))?[\s.:)\]]*$|${vietnamese}`,
    'iu',
  );
// Bank accounts, identity cards and passports were missing: a column of 14-digit
// account numbers was totalled, and each one read back rounded to twelve digits — a
// different account. "Số tài khoản" and "STK" are how Vietnamese sheets head them.
const IDENTIFIER_HEADER = identifierHeading(
  String.raw`(?:ids?|zip|zipcode|postcode|postal|sku|ean|upc|isbn|iban|ssn|code|account|acct|passport|(?:order|invoice|account|customer|reference|ref|serial|tracking|policy|member|card|passport|tax)\s*(?:no\.?|nr\.?|number|num|#))`,
  String.raw`(?:^|\s)(?:mã|stk|mst|cccd|cmnd)(?:\s|$)|số tài khoản|căn cước|hộ chiếu`,
);
/** Phone numbers are held to their shape as well, because "Mobile" also names a sales channel. */
const PHONE_HEADER = identifierHeading(
  String.raw`(?:phone|telephone|tel|mobile|fax)`,
  String.raw`điện thoại|(?:^|\s)(?:sđt|số\s+đt)(?:\s|$)|di động`,
);
/** A phone heading written in Vietnamese, where a mobile number is ten digits with a leading 0. */
const VN_PHONE_HEADER = /điện thoại|(?:^|\s)(?:sđt|số\s+đt)(?:\s|$)|di động/iu;

/**
 * What a heading alone says a column identifies: a phone number, some other code, or
 * nothing. Used where the values cannot say — choosing which column names a row, and
 * how a phone number typed as a filter should be compared.
 */
export function identifierHeadingKind(header: string): 'phone' | 'code' | null {
  const heading = header.normalize('NFC');
  if (PHONE_HEADER.test(heading)) return 'phone';
  return IDENTIFIER_HEADER.test(heading) ? 'code' : null;
}

/**
 * A Vietnamese mobile number that Excel stored as a number, and so without its
 * leading zero: 912345678 is 0912345678. Only under a Vietnamese phone heading, where
 * nine digits can mean nothing else.
 */
export function restoredPhone(header: string, v: CellValue): string | null {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null;
  const digits = String(v);
  return digits.length === 9 && VN_PHONE_HEADER.test(header.normalize('NFC')) ? `0${digits}` : null;
}

/** A whole number written as bare digits — no sign, grouping, decimals, currency or percent. */
function bareDigits(v: CellValue): boolean {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0;
  // A space between digit groups is how phone numbers are written: "0912 345 678".
  return typeof v === 'string' && /^\d+(?: \d+)*$/.test(v.trim());
}

/**
 * Is this a column of identifiers that merely happen to be digits?
 *
 * A phone number, postcode or order number parses as a number, and a number column is
 * summed, ranged and read aloud scaled — "Phone 912.3 million" — which destroys the
 * one thing anyone wants from it. The heading usually says what it is, and a leading
 * zero ("0912345678", "02134") is something no quantity is ever written with.
 *
 * Both are only believed when the values have an identifier's shape. An identifier is
 * a bare run of digits; "800.5" under "Mobile" is revenue, and made text it could not
 * be totalled. A phone number has at least seven digits and does not end in round
 * thousands the way a channel's takings in dong do. One zero-padded "05" among the 10,
 * 20 and 30 of an Amount column is a typing habit, not a column of codes.
 */
export function looksLikeIdentifier(header: string, present: readonly CellValue[]): boolean {
  const numeric = present.filter((v) => asNumber(v) !== null);
  if (numeric.length === 0 || !numeric.every(bareDigits)) return false;
  const heading = header.normalize('NFC');
  if (PHONE_HEADER.test(heading)) {
    const digits = numeric.map((v) => String(v).replace(/\D/g, ''));
    const round = digits.filter((d) => d.endsWith('000')).length;
    return digits.every((d) => d.length >= 7 && d.length <= 15) && round * 2 < digits.length;
  }
  if (IDENTIFIER_HEADER.test(heading)) return true;
  const zeroLed = numeric.filter((v) => typeof v === 'string' && /^0\d/.test(v.trim())).length;
  if (zeroLed >= 2 || (zeroLed > 0 && zeroLed * 2 >= numeric.length)) return true;
  // Whatever the heading: long runs of digits, all the same length and not in round
  // thousands, are account or card numbers. No column of amounts looks like that — a
  // price list in dong ends in 000, and a column of populations varies in length.
  const digits = numeric.map((v) => String(v).replace(/\s/g, ''));
  const round = digits.filter((d) => d.endsWith('000')).length;
  return (
    digits.length >= 3 &&
    digits.every((d) => d.length >= 10 && d.length === digits[0]!.length) &&
    round * 2 < digits.length
  );
}

/** A spreadsheet error value as Excel displays it: #DIV/0!, #N/A, #REF! and the rest. */
const SPREADSHEET_ERROR = /^#(?:DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!|GETTING_DATA)$/i;

export function isSpreadsheetError(v: CellValue): boolean {
  return typeof v === 'string' && SPREADSHEET_ERROR.test(v.trim());
}

/** Text that stands in for a value not known yet: "TBD", "N/A", "-". */
const PLACEHOLDER = /^(?:n\/?a|n\.a\.|tbd|tbc|tba|-{1,3}|—|–|\?{1,3}|none|nil|null)$/i;

/**
 * A few "TBD" and "N/A" cells in a column of amounts are gaps written as text, not a
 * sign that the column is text. Counted against its type, three of them in eight rows
 * made Amount "mixed" — impossible to total — and cost the table its header, since a
 * mixed column cannot show a label sitting over numbers.
 */
function isPlaceholder(v: CellValue): boolean {
  return typeof v === 'string' && PLACEHOLDER.test(v.trim());
}

/** A yes-or-no answer: TRUE, "Yes", "N", "có". */
function booleanish(v: CellValue): boolean {
  return typeof v === 'boolean' || (typeof v === 'string' && BOOLEANISH.test(v.trim()));
}

/** Share of values that are numbers or dates, not counting placeholders. */
function typedShare(values: readonly CellValue[]): number {
  const known = values.filter((v) => !isPlaceholder(v));
  if (known.length === 0) return 0;
  return known.filter((v) => asNumber(v) !== null || asDate(v) !== null).length / known.length;
}

export function profileColumn(
  values: readonly CellValue[],
  header: string,
  indexInRegion: number,
  sheetColIndex: number,
): ColumnProfile {
  const nonBlank = values.filter((v) => !isBlank(v));
  const empty = values.length - nonBlank.length;
  // An error cell (#DIV/0!) says nothing about what the column holds. Counted against
  // the column's type, one error in five rows made a column of ratios "mixed" and
  // refused to total it. It is left out of the typing and counted as a value that is
  // not a number, so answers can say it was skipped — and why.
  const errors = nonBlank.filter(isSpreadsheetError).length;
  const present = errors && errors < nonBlank.length ? nonBlank.filter((v) => !isSpreadsheetError(v)) : nonBlank;
  const distinctSet = new Set(present.map((v) => String(v instanceof Date ? v.toISOString() : v).trim()));
  // Listed for any text column small enough to say, whatever its distinct ratio: a
  // voice client can only recognise "Europe" as a filter value if it has been told
  // Europe is one.
  const listable = (): { categories?: readonly string[] } =>
    distinctSet.size <= CATEGORY_MAX_DISTINCT
      ? { categories: [...distinctSet].sort((a, b) => a.localeCompare(b)) }
      : {};

  const base = {
    index: indexInRegion,
    header,
    spokenName: toSpokenName(header, indexInRegion),
    nonEmpty: nonBlank.length,
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
  // Placeholders do not vote on whether the column holds numbers; they are counted
  // among its non-numeric values instead, so an answer can say it skipped them.
  const known = present.length - present.filter(isPlaceholder).length;
  const numericShare = known > 0 ? numericCount / known : 0;
  // The same for dates. A task list's Due column with "TBD" against the tasks not yet
  // scheduled stayed "mixed", so its dates were never stored as ISO days and a
  // day-first "04/11/2026" was later read month-first.
  const dateShare = known > 0 ? dateCount / known : 0;

  if (share(boolCount) > 0.9) {
    // Listed like any short text column, so a voice client can hear "paid yes" as a
    // value. Said as Yes and No whatever the file wrote (TRUE, có): the engine reads
    // them all as the same answer, and "true" is not a word anyone says about an invoice.
    const said = new Set(
      present.map((v) => {
        const s = String(v).trim();
        return /^(true|yes|y|có)$/i.test(s) ? 'Yes' : /^(false|no|n|không)$/i.test(s) ? 'No' : s;
      }),
    );
    return { ...base, kind: 'boolean', categories: [...said].sort((a, b) => a.localeCompare(b)) };
  }
  if (dateShare > 0.8) return { ...base, kind: 'date' };

  // Identifiers are text that happens to be digits. Kept as text, with the file's own
  // spelling, so "0912345678" is read back as written and never totalled.
  if (share(numericCount) > 0.3 && looksLikeIdentifier(header, present)) {
    return { ...base, kind: 'text', identifier: true, ...listable() };
  }

  if (numericShare > 0.8) {
    const vals = numbers.filter((n): n is number => n !== null);
    // A loop, not Math.min(...vals): spreading a six-figure column into arguments
    // overflows the call stack.
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const n of vals) {
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
    }
    const numeric: NumericSummary = {
      min,
      max,
      sum,
      mean: sum / vals.length,
      nonNumeric: nonBlank.length - numericCount,
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
    return { ...base, kind: 'category', ...listable() };
  }

  return { ...base, kind: 'text', ...listable() };
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

/**
 * A date as a person says it, as a UTC calendar date. Every date in this system is
 * one, so rendering in the host's zone would read it a day early west of Greenwich.
 */
export function speakDate(d: Date): string {
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
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
  const shown = isBlank(value) ? 'empty' : String(value instanceof Date ? speakDate(value) : value);
  const addr = a1(region.firstDataRow + rowIndex, region.firstCol + colIndex);
  return `${name}: ${shown} (${addr})`;
}
