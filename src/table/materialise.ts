/**
 * Turning a region's rows into named columns, for a given reading of its structure.
 *
 * This exists as its own module because the same computation has to run in two
 * places, and they must not drift apart. Ingest runs it once offline to produce the
 * default reading. The server runs it again whenever someone corrects that reading
 * out loud — "no, the first row is data" — and the corrected answer has to be built
 * by the same code that built the original, or the correction becomes its own class
 * of bug.
 *
 * It works on the region's rows as stored: merge-resolved, region-sliced, with the
 * header rows still attached. Keeping the header rows in the index is what makes a
 * correction possible at all; a region stored with its headers already stripped
 * cannot be re-read without the source file, which the Worker does not have.
 */

import { columnLetter, isColumnNumbering, isPivotHeading, toSpokenName, type CellValue } from './model.ts';
import {
  asNumber,
  dateOrderEvidence,
  identifierHeadingKind,
  MONTH_NAMES,
  parseDateText,
  profileColumn,
  restoredPhone,
} from './infer.ts';
import type { IndexColumn } from '../indexfmt.ts';

type Json = string | number | boolean | null;

export interface Materialised {
  /** Absolute sheet row indices consumed as header, in order. Empty if headerless. */
  readonly headerRows: readonly number[];
  /** Absolute sheet row index of the first data row. */
  readonly firstDataRow: number;
  readonly columns: readonly IndexColumn[];
  readonly rows: readonly (readonly Json[])[];
  readonly labelColumn: number | null;
  readonly ambiguousColumns: readonly number[];
  /**
   * Indices into `rows` of the sheet's own total and subtotal rows. They stay in
   * `rows` — cell addresses are counted from the first data row, and reading the
   * sheet row by row should still reach them — but column statistics leave them out,
   * and so must every answer that counts or sums.
   */
  readonly summaryRows: readonly number[];
  /**
   * Date columns whose day-and-month order nothing in the column settles ("01/09/2026"
   * and nothing past the 12th), with one such value and the order used, so the file's
   * warnings can say it was a guess.
   */
  readonly dateGuesses: readonly { readonly column: number; readonly example: string; readonly order: 'mdy' | 'dmy' }[];
}

/**
 * A row's label says it is the sheet's own total. Whole-cell only: "Total" and
 * "Tổng cộng:" are totals, "Total Wine & More" and "Cộng hòa Séc" are records.
 */
const SUMMARY_LABEL = /^(?:(?:grand\s+|sub[\s-]?)?totals?|tổng(?:\s+(?:cộng|số))?|cộng)\s*:?$/iu;

export function isSummaryLabel(text: string): boolean {
  return SUMMARY_LABEL.test(text.normalize('NFC').trim());
}

/**
 * A group's own total, the way Excel labels one: "Housing Total" from Data > Subtotal,
 * "North Total" from a PivotTable. The label names the group first, so on its own it
 * could also be a record ("Sales Total" as a line item); it is only believed once the
 * row's figures turn out to be the sum of the group above it.
 */
const GROUP_TOTAL_LABEL = /^\S.*\s(?:sub[\s-]?)?totals?\s*:?$/iu;

/**
 * A total named for what it adds up, the way people type one by hand: "Total Expenses",
 * "TOTAL EXPENSES", "Grand total revenue", "Tổng doanh thu". Counted as data, "Total
 * Expenses" doubled the total and was named as the biggest expense. Like a group's own
 * total, it could be a record ("Total Wine & More"), so it is believed only when its
 * figures add up the rows above it — and names that merely start with the word
 * ("Cộng hòa Séc", a country; "Tổng công ty", a corporation) are never taken for one.
 */
const LEAD_TOTAL_LABEL =
  /^(?:(?:grand\s+|sub[\s-]?)?totals?|tổng(?:\s+cộng)?(?!\s+(?:công\s+ty|giám\s+đốc|cục|lãnh\s+sự)\b)|cộng(?!\s+(?:hòa|hoà|đồng|sự|tác)\b))\s+\S/iu;

/** "Net Savings", "Net income": a total less another, believed only when it is one. */
const NET_LABEL = /^net\s+\S/iu;

/**
 * What a summary row states about the rows above it, when it is not their sum.
 *
 * A budget with "Total" and then "Average" under its months, a gradebook ending in
 * "Class average", Excel's Data > Subtotal set to Average or Count ("Food Average",
 * "Grand Count"): each was counted as one more record. "How many months" said 7 where
 * there are 6, the total of Food was 22.9 thousand where it is 19.6, and the answer
 * added that it had left out the Total row, as if that settled it.
 */
type Statistic = 'mean' | 'count' | 'max' | 'min';

interface StatLabel {
  readonly stat: Statistic;
  /**
   * The group the label names, lower-cased — "food" in Excel's "Food Average" — or null
   * for a label that names none: "Average", "Grand Count", "Trung bình", "Class average".
   */
  readonly group: string | null;
  /** A bare "Max" or "Min", which is also somebody's name. */
  readonly nameLike: boolean;
}

/** The words, in English, the way Excel's Subtotal and people write them. */
const STAT_WORDS: readonly (readonly [Statistic, string])[] = [
  ['mean', String.raw`average|avg\.?|mean`],
  ['count', String.raw`count`],
  ['max', String.raw`max\.?|maximum|highest|largest`],
  ['min', String.raw`min\.?|minimum|lowest|smallest`],
];
/**
 * And in Vietnamese, which puts the word first: "Trung bình", "Điểm trung bình lớp",
 * "Bình quân tháng", "Số lượng", "Cao nhất", "Điểm thấp nhất".
 */
const VN_STAT_WORDS: readonly (readonly [Statistic, string])[] = [
  ['mean', String.raw`trung\s+bình|bình\s+quân|tb|đtb`],
  ['count', String.raw`số\s+lượng`],
  ['max', String.raw`cao\s+nhất|lớn\s+nhất|tối\s+đa`],
  ['min', String.raw`thấp\s+nhất|nhỏ\s+nhất|tối\s+thiểu`],
];
/**
 * Words before the statistic that name no group: "Grand Average" is Excel's last row,
 * "Class average" a gradebook's.
 */
const NO_GROUP = /^(?:grand|overall|class|total|monthly|weekly|daily|yearly|annual|quarterly)$/iu;
/**
 * Words before the statistic that make it a rating, not a summary: "Below average" and
 * "Above average" are points on a scale, and a survey's answers end in one as often as
 * not.
 */
const RATING = /^(?:(?:well|far|slightly|just|much)\s+)?(?:below|above|under|over|near|about|around)$/iu;

const statPattern = (words: readonly (readonly [Statistic, string])[], shape: (alternatives: string) => string): RegExp =>
  new RegExp(shape(words.map(([, w]) => `(${w})`).join('|')), 'iu');
/** "Average", "Max.", "Count". */
const BARE_STAT = statPattern(STAT_WORDS, (w) => `^(?:${w})$`);
/** "Food Average", "Grand Count", "Class average": the word last, as Excel writes a subtotal. */
const GROUP_STAT = statPattern(STAT_WORDS, (w) => String.raw`^(\S.*?)\s+(?:${w})$`);
/**
 * "Average monthly spend", "Highest score". Not "Max …" or "Min …": "Max Mustermann" is a
 * person, and a person whose figures tie the best so far would vanish from the table.
 */
const LEAD_WORDS: readonly (readonly [Statistic, string])[] = [
  ['mean', String.raw`average|avg\.?|mean`],
  ['count', String.raw`count`],
  ['max', String.raw`maximum|highest|largest`],
  ['min', String.raw`minimum|lowest|smallest`],
];
const LEAD_STAT = statPattern(LEAD_WORDS, (w) => String.raw`^(?:${w})(?:\s+of)?\s+\S`);
const VN_STAT = statPattern(VN_STAT_WORDS, (w) => String.raw`^(?:(?:điểm|giá\s+trị|mức)\s+)?(?:${w})(?:\s+\S.*)?$`);

/** Which alternative of a pattern built from these lists matched, as its statistic. */
function matchedStat(m: RegExpExecArray, words: readonly (readonly [Statistic, string])[], offset: number): Statistic | null {
  for (let k = 0; k < words.length; k++) if (m[offset + k] !== undefined) return words[k]![0];
  return null;
}

/** The statistic a row's label says it holds, if it says one. */
function statLabel(text: string): StatLabel | null {
  const label = text.normalize('NFC').trim().replace(/\s*:$/u, '');
  let m = BARE_STAT.exec(label);
  if (m) {
    const stat = matchedStat(m, STAT_WORDS, 1)!;
    return { stat, group: null, nameLike: /^(?:max|min)$/iu.test(label) };
  }
  m = GROUP_STAT.exec(label);
  if (m) {
    const stat = matchedStat(m, STAT_WORDS, 2)!;
    const group = m[1]!.trim();
    if (RATING.test(group)) return null;
    return { stat, group: NO_GROUP.test(group) ? null : group.toLowerCase(), nameLike: false };
  }
  m = LEAD_STAT.exec(label);
  if (m) return { stat: matchedStat(m, LEAD_WORDS, 1)!, group: null, nameLike: false };
  m = VN_STAT.exec(label);
  if (m) return { stat: matchedStat(m, VN_STAT_WORDS, 1)!, group: null, nameLike: false };
  return null;
}

/** Any label a summary row could carry, whether or not its figures bear it out. */
function summaryLike(label: string): boolean {
  return (
    isSummaryLabel(label) ||
    GROUP_TOTAL_LABEL.test(label) ||
    LEAD_TOTAL_LABEL.test(label) ||
    NET_LABEL.test(label) ||
    statLabel(label) !== null
  );
}

/**
 * Each column's figures over a run of rows, kept as the rows go by so checking a
 * summary row costs one comparison per column, however many rows it sums up.
 */
interface Tally {
  rows: number;
  readonly filled: number[];
  readonly seen: number[];
  readonly sum: number[];
  readonly max: number[];
  readonly min: number[];
}

function tally(width: number): Tally {
  return {
    rows: 0,
    filled: new Array<number>(width).fill(0),
    seen: new Array<number>(width).fill(0),
    sum: new Array<number>(width).fill(0),
    max: new Array<number>(width).fill(Number.NEGATIVE_INFINITY),
    min: new Array<number>(width).fill(Number.POSITIVE_INFINITY),
  };
}

function count(t: Tally, row: readonly Json[]): void {
  t.rows++;
  for (let c = 0; c < t.filled.length; c++) {
    const v = row[c] ?? null;
    if (isBlankJson(v)) continue;
    t.filled[c]!++;
    const n = typeof v === 'boolean' ? null : asNumber(v);
    if (n === null) continue;
    t.seen[c]!++;
    t.sum[c]! += n;
    if (n > t.max[c]!) t.max[c] = n;
    if (n < t.min[c]!) t.min[c] = n;
  }
}

/**
 * Is `shown` the figure `exact`, as a sheet would show it?
 *
 * An average is rarely a round number, and a CSV holds it as displayed — 3266.67, or
 * "3,267" under a whole-number format — so it is compared at the precision it was
 * written to. A number cell from a workbook keeps every digit unless a formula rounded
 * it, and a class average is usually rounded to two places (ROUND(…, 2)): so there a
 * lone figure with fewer than two decimals must match exactly. 7 is not the 7.5 of the
 * rows above it, and 0.2 is not their 0.175.
 *
 * `loose` reads a workbook figure at its own shown precision too, for where the row says
 * otherwise what it is (see statesTally's callers): ROUND(AVERAGE(…), 0) under a budget,
 * and ROUND(…, 1), the rounding a Vietnamese gradebook is required to use. Exact there,
 * the Average row was counted as one more record, and every Highest and Lowest row under
 * it went with it.
 */
function shows(shown: number, exact: number, typed: boolean, loose = false): boolean {
  const text = String(Math.abs(shown));
  const decimals = /e/i.test(text) ? 12 : (text.split('.')[1] ?? '').length;
  const rounding = typed && decimals < 2 && !loose ? 0 : 0.5 * 10 ** -decimals * (1 + 1e-9);
  return Math.abs(shown - exact) <= rounding + 1e-9 * Math.max(1, Math.abs(exact));
}

/**
 * A label that names the whole table's average, which no record is called: "Class
 * average", "Grand average", "Overall mean", "Điểm trung bình lớp", "Trung bình lớp".
 */
const WHOLE_TABLE_MEAN =
  /^(?:(?:class|grand|overall)\s+(?:average|avg\.?|mean)|(?:điểm\s+)?(?:trung\s+bình|tb|đtb|bình\s+quân)\s+(?:lớp|cả\s+lớp|chung|toàn\s+lớp))$/iu;

/**
 * Does every figure in this row state the statistic of its column over these rows?
 *
 * Every figure, not one: a total row may carry a rate beside its sum, but an Average row
 * averages every column it fills, and asking all of them is what keeps a record called
 * "Average" — a grade band, a rating — from being taken for one by a coincidence.
 *
 * How many figures bore it out, or 0 when one did not: two columns agreeing is harder
 * to come by through a tie than one. `loose` reads an average at the precision it shows.
 */
function statesTally(row: readonly Json[], stat: Statistic, t: Tally, labelAt: number, loose = false): number {
  if (t.rows === 0) return 0;
  let checked = 0;
  for (let c = 0; c < row.length; c++) {
    if (c === labelAt) continue;
    const v = row[c] ?? null;
    if (typeof v === 'boolean' || isBlankJson(v)) continue;
    const n = asNumber(v);
    if (n === null) continue;
    const typed = typeof v === 'number';
    if (stat === 'count') {
      // Excel's COUNT counts numbers, COUNTA anything filled, and either may sit in a
      // column of text ("Item"), so any of the three counts is a count.
      if (!Number.isInteger(n) || ![t.rows, t.filled[c], t.seen[c]].includes(n)) return 0;
    } else {
      const seen = t.seen[c] ?? 0;
      if (seen === 0) return 0;
      const exact = stat === 'mean' ? t.sum[c]! / seen : stat === 'max' ? t.max[c]! : t.min[c]!;
      if (!shows(n, exact, typed, loose && stat === 'mean')) return 0;
    }
    checked++;
  }
  return checked;
}

/** What a total row adds up, by its label: "Total Housing" and "Housing Total" → "housing". */
function totalOf(label: string): string {
  return label
    .replace(/^(?:(?:grand\s+|sub[\s-]?)?totals?|tổng(?:\s+cộng)?|cộng)\s+/iu, '')
    .replace(/\s+(?:sub[\s-]?)?totals?\s*:?$/iu, '')
    .trim()
    .toLowerCase();
}

const isBlankJson = (v: Json): boolean => v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Running sums of each column's numbers, row by row, so the sum of any run of rows is
 * one subtraction. Checking each "… Total" label by adding up its group again made a
 * sheet of ten thousand rows labelled "Sales Total" quadratic.
 */
function runningSums(rows: readonly (readonly Json[])[]): { sum: number[][]; seen: number[][] } {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const sum = Array.from({ length: width }, () => [0]);
  const seen = Array.from({ length: width }, () => [0]);
  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      const n = asNumber((row[c] ?? null) as CellValue);
      const s = sum[c]!;
      const k = seen[c]!;
      s.push(s[s.length - 1]! + (n ?? 0));
      k.push(k[k.length - 1]! + (n === null ? 0 : 1));
    }
  }
  return { sum, seen };
}

/**
 * Do this row's figures add up the rows above it, back to the previous total?
 *
 * One column that sums is enough: a subtotal row can hold an average or a rate in
 * another column. A row with no figure to check, or a group with nothing above it,
 * proves nothing, and the row stays a record.
 */
function sumsGroupAbove(
  row: readonly Json[],
  sums: { sum: number[][]; seen: number[][] },
  at: number,
  previous: number,
): boolean {
  for (let c = 0; c < row.length; c++) {
    const value = row[c] ?? null;
    if (typeof value === 'boolean' || isBlankJson(value)) continue;
    const total = asNumber(value);
    const s = sums.sum[c];
    const k = sums.seen[c];
    if (total === null || !s || !k) continue;
    const seen = k[at]! - k[previous + 1]!;
    const sum = s[at]! - s[previous + 1]!;
    // Half a cent, or the rounding a long running sum carries, whichever is larger.
    const slack = Math.max(0.005, Math.abs(total) * 1e-9, Math.abs(s[at]!) * 1e-12);
    if (seen > 0 && Math.abs(sum - total) <= slack) return true;
  }
  return false;
}

/**
 * Do this row's figures add up every record above it, leaving out the totals already
 * found? That is a grand total under subtotals: "TOTAL EXPENSES" beneath "Total Housing"
 * and "Total Food" has no rows of its own since the last total, but is the sum of the
 * items above both.
 */
function sumsRecordsAbove(
  row: readonly Json[],
  sums: { sum: number[][]; seen: number[][] },
  at: number,
  found: readonly number[],
  rows: readonly (readonly Json[])[],
): boolean {
  for (let c = 0; c < row.length; c++) {
    const value = row[c] ?? null;
    if (typeof value === 'boolean' || isBlankJson(value)) continue;
    const total = asNumber(value);
    const s = sums.sum[c];
    const k = sums.seen[c];
    if (total === null || !s || !k) continue;
    let sum = s[at]!;
    let seen = k[at]!;
    for (const f of found) {
      const n = asNumber((rows[f]?.[c] ?? null) as CellValue);
      if (n === null) continue;
      sum -= n;
      seen -= 1;
    }
    const slack = Math.max(0.005, Math.abs(total) * 1e-9, Math.abs(s[at]!) * 1e-12);
    if (seen > 0 && Math.abs(sum - total) <= slack) return true;
  }
  return false;
}

/** Is some figure in this row one total less another, as a "Net Savings" row is? */
function differenceOfTotals(row: readonly Json[], found: readonly number[], rows: readonly (readonly Json[])[]): boolean {
  for (let c = 0; c < row.length; c++) {
    const value = row[c] ?? null;
    if (typeof value === 'boolean' || isBlankJson(value)) continue;
    const net = asNumber(value);
    if (net === null) continue;
    const figures = found.map((f) => asNumber((rows[f]?.[c] ?? null) as CellValue)).filter((n): n is number => n !== null);
    for (const a of figures) {
      for (const b of figures) {
        if (a !== b && Math.abs(a - b - net) <= Math.max(0.005, Math.abs(net) * 1e-9)) return true;
      }
    }
  }
  return false;
}

/**
 * Find the total and subtotal rows.
 *
 * A budget with a Total row under it is the single most common shape there is, and
 * counting that row as data doubles every total and makes the total itself the
 * maximum. The row is recognised by its label, not by position, so subtotals between
 * groups are caught as well as the grand total.
 *
 * The label is the row's first filled cell, whatever its type, and it must be text. A
 * total row opens with its label; a record that merely has "Total" in a later column —
 * a claim whose Loss is "Total" beside its claim number and amount — is a record, and
 * leaving it out silently dropped half an insurer's claims from every count and sum.
 *
 * Excel's own subtotals name their group — "Housing Total", "North Total" — and were
 * counted as data, so a budget built with Data > Subtotal answered with every figure
 * doubled while saying it had left out the grand total. Those are recognised too, but
 * only when the row's figures are the sum of the group directly above it.
 *
 * Rows that state an average, a count, a highest or a lowest are found the same way:
 * by a label that says so, and only when every figure in the row is that statistic of
 * the rows it sums up. A label that names a group ("Food Average") must sit in the
 * shape Excel's Subtotal writes, under records that repeat the group's name. A label
 * that names none ("Average", "Class average", "Grand Count") must close the table,
 * among other summary rows only, and state the statistic of at least three records:
 * the group directly above, reaching back past any summary rows in between — an
 * Average under a Total averages the months, not the Total — or every record above.
 * Each of those rules is there because a record ties a statistic more often than one
 * would think: a product line, a survey answer, the top of a scale, a student's name.
 */
function findSummaryRows(rows: readonly (readonly Json[])[]): number[] {
  const found: number[] = [];
  let sums: ReturnType<typeof runningSums> | null = null;
  const labels = rows.map((row) => {
    const first = row.find((v) => !isBlankJson(v));
    return typeof first === 'string' ? first.normalize('NFC').trim() : null;
  });
  const stats = labels.map((label) => (label === null ? null : statLabel(label)));
  // Worked out only for a table that has such a label at all.
  const counting = stats.some((s) => s !== null);
  const width = counting ? rows.reduce((w, r) => Math.max(w, r.length), 0) : 0;
  // The records since the last summary row; the group before the summary rows directly
  // above; and every record so far.
  let group = tally(width);
  let before = tally(width);
  const records = tally(width);
  // The first row of the run of summary-like rows that closes the table. A blank row
  // (left by a spacer) does not break the run.
  let closing = rows.length;
  if (counting) {
    while (closing > 0 && (labels[closing - 1] === null ? rows[closing - 1]!.every(isBlankJson) : summaryLike(labels[closing - 1]!))) {
      closing--;
    }
  }
  // "Lowest" or "Average" among the records, before that closing run, says the words
  // name rows here — the points of a scale, a grade band — rather than sum them up: a
  // risk scale ending "High 4, Highest 4" lost its top level as "the highest".
  const scale = stats.slice(0, closing).some((s) => s !== null && s.group === null && !s.nameLike);
  /** The first row of the run of summary rows directly above row `i`. */
  const runTop = (i: number): { top: number; previous: number } => {
    let k = found.length - 1;
    let top = i;
    while (k >= 0 && found[k] === top - 1) {
      top--;
      k--;
    }
    return { top, previous: k >= 0 ? found[k]! : -1 };
  };

  const isSummary = (row: readonly Json[], i: number): boolean => {
    const label = labels[i] ?? null;
    if (label === null) return false;
    if (isSummaryLabel(label)) return true;
    const grouped = GROUP_TOTAL_LABEL.test(label);
    const leading = LEAD_TOTAL_LABEL.test(label);
    const net = NET_LABEL.test(label);
    if (grouped || leading || net) {
      sums ??= runningSums(rows);
      if (net) {
        if (differenceOfTotals(row, found, rows)) return true;
        // A cash-flow statement's "Net cash from operating activities" is the sum of the
        // lines above it, outflows in brackets included, and its last "Net change in
        // cash" the sum of every line. Counted as lines, "the total FY2026" was 5298
        // where the statement's own net change is 1766, and "how many lines were below
        // 0" counted two subtotals among them.
        const { top, previous } = runTop(i);
        return sumsGroupAbove(row, sums, top, previous) || sumsRecordsAbove(row, sums, i, found, rows);
      }
      // The group reaches back past summary rows directly above: Excel's Subtotal run
      // twice writes "Food Average" and then "Food Total" under the same rows.
      const { top, previous } = runTop(i);
      if (sumsGroupAbove(row, sums, top, previous) || (leading && sumsRecordsAbove(row, sums, i, found, rows))) return true;
    }
    const stat = stats[i];
    if (!stat) return false;
    const labelAt = row.findIndex((v) => !isBlankJson(v));
    const { top } = runTop(i);
    if (stat.group !== null) {
      // A label that names a group is believed only in the shape Excel's Data > Subtotal
      // writes: the group's value on every record of it, straight above — "Food",
      // "Food", then "Food Average". One record above that merely starts with the same
      // words is a product line: "iPhone 15 Pro Max" under "iPhone 15 Pro", "AirPods
      // Max" under "AirPods", each with the same figure, had vanished from the table. A
      // highest, lowest or count of one record ties it by definition, so those need two;
      // an average of one stands only where the group plainly starts — at the top, or
      // under another group's subtotal.
      const name = (r: number): string | null => {
        const v = rows[r]?.[labelAt] ?? null;
        return typeof v === 'string' ? v.normalize('NFC').trim().toLowerCase() : null;
      };
      let members = 0;
      while (top - members - 1 >= 0 && name(top - members - 1) === stat.group) members++;
      const starts = top - members === 0 || found.includes(top - members - 1);
      if (members < 2 && !(members === 1 && stat.stat === 'mean' && starts)) return false;
      const own = tally(width);
      for (let r = top - members; r < top; r++) count(own, rows[r]!);
      return statesTally(row, stat.stat, own, labelAt) > 0;
    }
    // Anything else closes the table, under nothing but summary rows already found: a
    // table of statistics ("Count", "Mean", "Max" down its first column) is records, and
    // so is a scale that names its ends ("Lowest" … "High", "Highest").
    if (i < closing || scale) return false;
    // A row of the closing run not taken for a summary. It used to rule out every row
    // after it — so one Average row the figures did not bear out took the Highest, Lowest
    // and Count rows under it into the records. Now a row after it must bear itself out
    // in two columns or more.
    let unconfirmed = false;
    for (let j = closing; j < i; j++) if (!found.includes(j) && !rows[j]!.every(isBlankJson)) unconfirmed = true;
    // Over at least three records: the average of two is a tie away from any third
    // rating — Excellent 12, Good 20, then Average 16 — and the highest of two a tie
    // away from the next name.
    const own = group.rows > 0 ? group : before;
    let agreed = 0;
    for (const t of [own, records]) {
      if (t.rows < 3) continue;
      agreed = statesTally(row, stat.stat, t, labelAt);
      if (agreed > 0) break;
    }
    // An average shown rounded — ROUND(AVERAGE(…), 0) or (…, 1) — is read at the precision
    // it shows where something else says what it is: two columns or more agreeing; the row
    // straight under a Total or another summary row; or a label naming the whole table's
    // average, which no record is called. A lone one-column figure still has to be exact.
    if (agreed === 0 && stat.stat === 'mean') {
      const underSummary = found.includes(i - 1) || (i > 0 && rows[i - 1]!.every(isBlankJson) && found.includes(i - 2));
      const wholeTable = WHOLE_TABLE_MEAN.test(label.replace(/\s*:$/u, ''));
      for (const t of [own, records]) {
        if (t.rows < 3) continue;
        const loose = statesTally(row, stat.stat, t, labelAt, true);
        if (loose >= 2 || (loose > 0 && (underSummary || wholeTable))) {
          agreed = loose;
          break;
        }
      }
    }
    if (agreed === 0) return false;
    if (unconfirmed && agreed < 2) return false;
    // "Max" or "Min" alone is somebody's name — the last two students, Max and Min, can
    // hold the best and worst marks. As summaries they come under a Total or an Average,
    // or agree in more than one column.
    return !stat.nameLike || agreed >= 2 || found.some((j) => j >= closing && j < i && !stats[j]?.nameLike);
  };

  rows.forEach((row, i) => {
    if (isSummary(row, i)) {
      found.push(i);
      if (counting && group.rows > 0) {
        before = group;
        group = tally(width);
      }
      return;
    }
    if (counting) {
      count(group, row);
      count(records, row);
    }
  });
  // "HOUSING" over the rows that "Total Housing" adds up is the group's heading, not a
  // record: counted, "how many items" said 6 where the budget holds 4.
  const headings: number[] = [];
  let from = 0;
  for (const at of found) {
    const first = rows[at]?.find((v) => !isBlankJson(v));
    const text = typeof first === 'string' ? first.normalize('NFC').trim() : '';
    // Only a total names its group's heading; "Average" heads nothing.
    const named = text && !statLabel(text) ? totalOf(text) : '';
    for (let j = from; named && j < at; j++) {
      const filled = (rows[j] ?? []).filter((v) => !isBlankJson(v));
      if (filled.length === 1 && typeof filled[0] === 'string' && filled[0].normalize('NFC').trim().toLowerCase() === named) {
        headings.push(j);
        break;
      }
    }
    from = at + 1;
  }
  const all = [...found, ...headings].sort((a, b) => a - b);
  // A region that is nothing but a total row — one separated from its table by a
  // blank line — is still the only thing there is to read. Leaving all of it out
  // would answer every question about it with nothing.
  return all.length === rows.length ? [] : all;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** A heading cell as it should be named aloud. */
function headingText(v: Json): string {
  const text = String(v).trim();
  // A date typed into a heading row (Jan-24, Feb-24 over monthly figures) is stored
  // as an ISO instant, and "2024 01 01 t00:00:00 000 Z" is not a column name anyone
  // can say. Only the stored ISO form is reformatted, in UTC like every date here: a
  // CSV's "1/2/2024" is kept as written rather than guessed at.
  if (ISO_INSTANT.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      const month = MONTH_NAMES[d.getUTCMonth()]!;
      return d.getUTCDate() === 1
        ? `${month} ${d.getUTCFullYear()}`
        : `${month} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
    }
  }
  return text;
}

/**
 * Make every spoken name unique within the region.
 *
 * Two columns both headed "Amount" left the second unreachable: every way of naming
 * it also named the first, so the clarifying question had no possible answer. The
 * first keeps its name; later ones are numbered, skipping any number another heading
 * already uses.
 */
function uniqueNames(names: readonly string[]): string[] {
  const key = (s: string) => s.toLowerCase();
  const taken = new Set(names.map(key));
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(key(name))) {
      used.add(key(name));
      return name;
    }
    let n = 2;
    let candidate = `${name} ${n}`;
    while (taken.has(key(candidate)) || used.has(key(candidate))) candidate = `${name} ${++n}`;
    used.add(key(candidate));
    return candidate;
  });
}

/**
 * Which column identifies a row when speaking it?
 *
 * "Revenue for North" needs "North" to come from somewhere. Prefer a leftmost column
 * that is text-like and close to unique — that is what an identifier looks like. A
 * category column is the fallback: less precise, but "Revenue for the South region"
 * still beats "Revenue for row 14".
 *
 * A code is unique on every row too, and it is the leftmost column of half the sheets
 * people keep — Student ID, Employee ID, SKU, Mã NV. Once numeric codes were read as the
 * text they are, they won this rule, and "the highest Final" was said to be "for
 * 20210002" instead of for Bình. A code names the row only when nothing else can.
 */
function pickLabelColumn(columns: readonly IndexColumn[], rowCount: number): number | null {
  const usable = columns.filter((c) => c.kind === 'text' || c.kind === 'category');
  if (usable.length === 0) return null;
  const code = (c: IndexColumn): boolean =>
    c.identifier !== undefined || identifierHeadingKind(c.path[c.path.length - 1] ?? '') !== null;
  const named = usable.filter((c) => !code(c));
  const pool = named.length ? named : usable;
  const unique = pool.find((c) => rowCount > 0 && c.distinct / rowCount >= 0.8);
  return (unique ?? pool[0])!.i;
}

/**
 * A row of group labels as a CSV writes a merged heading — ",2026,,2025," — carries
 * each label across the blanks after it, up to the next label, as the merge it was
 * exported from did. Without this the second column of each group lost its year, and
 * "2025 Q2 Revenue" was "Q2 Revenue 2", which nobody would think to ask for.
 *
 * Only a sparse row of labels over a fuller heading row is read this way — at least
 * two labels, at most half the row, with gaps between them — and a label is carried
 * only over columns the row beneath names, so it never runs past the table.
 */
function carryGroupLabels(row: readonly Json[], below: readonly Json[], width: number): readonly Json[] {
  const filled: number[] = [];
  for (let c = 0; c < width; c++) if (!isBlankJson(row[c] ?? null)) filled.push(c);
  if (filled.length < 2 || filled.length * 2 > width) return row;
  if (filled[filled.length - 1]! - filled[0]! + 1 === filled.length) return row;
  const out = Array.from({ length: width }, (_, c) => row[c] ?? null);
  let label: Json = null;
  for (let c = filled[0]!; c < width; c++) {
    if (!isBlankJson(out[c] ?? null)) label = out[c]!;
    else if (label !== null && !isBlankJson(below[c] ?? null)) out[c] = label;
    else label = null;
  }
  return out;
}

/**
 * Build each column's heading path from the chosen header rows.
 *
 * Blank levels are skipped rather than emitted, and a label repeated down levels by
 * a merge is collapsed, so "2026, 2026, Revenue" never reaches a speaker.
 */
function headerPaths(
  block: readonly (readonly Json[])[],
  width: number,
): { paths: string[][]; ambiguous: number[] } {
  const headerBlock = block.map((row, k) => (k < block.length - 1 ? carryGroupLabels(row, block[k + 1]!, width) : row));
  const paths: string[][] = [];
  // A PivotTable's "Column Labels" and "Row Labels" are placeholders: its value, "Sum
  // of Revenue", heads each figure column, and the row field keeps Excel's own name.
  if (block.length === 2 && isPivotHeading(block[0]!, block[1]!)) {
    const value = String(block[0]!.find((v) => typeof v === 'string' && v.trim()) ?? '').trim();
    for (let c = 0; c < width; c++) {
      const own = block[1]![c] ?? null;
      const label = own === null || (typeof own === 'string' && !own.trim()) ? '' : headingText(own);
      paths.push(c === 0 ? [label || 'Row Labels'] : label ? [value, label] : []);
    }
    return { paths, ambiguous: [] };
  }
  // The row that numbers a form's columns, "(1) | (2) | (3)", says nothing a listener
  // asks by: "Lương cơ bản, (3)" is only harder to say than "Lương cơ bản".
  const named = headerBlock.filter((row, k) => !isColumnNumbering(block[k]!) || block.length === 1);
  for (let c = 0; c < width; c++) {
    const path: string[] = [];
    for (const row of named) {
      const v = row[c] ?? null;
      if (v === null || (typeof v === 'string' && v.trim() === '')) continue;
      const text = headingText(v);
      if (path[path.length - 1] === text) continue;
      path.push(text);
    }
    paths.push(path);
  }

  const seen = new Map<string, number[]>();
  paths.forEach((p, i) => {
    const key = p.join(' › ').toLowerCase();
    if (!key) return;
    const list = seen.get(key);
    if (list) list.push(i);
    else seen.set(key, [i]);
  });
  const ambiguous = [...seen.values()]
    .filter((l) => l.length > 1)
    .flat()
    .sort((a, b) => a - b);

  return { paths, ambiguous };
}

/**
 * Read `allRows` under one interpretation of where the header stops.
 *
 * `headerRowCount` of 0 means the region has no header; every row is data and the
 * columns are named by position. Anything larger than the region has rows is clamped
 * rather than throwing — a caller correcting a structure out loud should get a
 * sensible answer, not an error about bounds.
 */
export function materialise(
  allRows: readonly (readonly Json[])[],
  regionStartRow: number,
  firstCol: number,
  headerRowCount: number,
  /**
   * Which way round to read a date column whose own values do not say: the order the
   * rest of the file points to (a Vietnamese or European file writes day first), or
   * month first when nothing does.
   */
  defaultDateOrder: 'mdy' | 'dmy' = 'mdy',
): Materialised {
  const width = allRows.reduce((w, r) => Math.max(w, r.length), 0);
  // Always leave at least one data row: a region that is entirely header is not a
  // reading anyone means, and silently producing zero records is the failure this
  // module was written to end.
  const headerCount = Math.max(0, Math.min(headerRowCount, Math.max(0, allRows.length - 1)));

  const headerBlock = allRows.slice(0, headerCount);
  const dataRows = allRows.slice(headerCount);
  const { paths, ambiguous } = headerPaths(headerBlock, width);

  // Computed here, for whatever heading count was asked for, because a spoken
  // correction re-reads the region through this same function.
  const summaryRows = findSummaryRows(dataRows);
  const summary = new Set(summaryRows);
  const records = dataRows.filter((_, r) => !summary.has(r));

  const profiles = paths.map((path, i) =>
    profileColumn(
      records.map((row) => (row[i] ?? null) as CellValue),
      path[path.length - 1] ?? '',
      i,
      firstCol + i,
    ),
  );
  const spokenNames = uniqueNames(
    paths.map((path, i) => (path.length > 1 ? path.join(', ') : toSpokenName(path[0] ?? '', i))),
  );

  // Values are stored the way every reader can agree on. Dates become ISO instants —
  // a CSV's "4/7/2026" otherwise means one day to the ingest step and another to a
  // filter — read month- or day-first as the column itself shows. Identifier digits
  // stored as spreadsheet numbers become the text they are, so a postcode is read
  // back as a postcode rather than as "50 thousand".
  const dateGuesses: { column: number; example: string; order: 'mdy' | 'dmy' }[] = [];
  const orders = profiles.map((p, i) => {
    if (p.kind !== 'date') return null;
    const evidence = dateOrderEvidence(records.map((row) => (row[i] ?? null) as CellValue));
    // The file's order is only borrowed by a column that writes its dates as numbers.
    // Real date cells have no order to borrow, and marking them day first made a filter
    // typed "7/4/2026" mean 7 April.
    const order = evidence.order ?? (evidence.written > 0 ? defaultDateOrder : 'mdy');
    if (evidence.order === null && evidence.example !== null) dateGuesses.push({ column: i, example: evidence.example, order });
    return order;
  });
  // Identifier digits as the text they are; a Vietnamese mobile number gets back the
  // leading zero Excel dropped, so "0912345678" is read, and found, as written.
  const heading = (i: number): string => paths[i]?.[paths[i]!.length - 1] ?? '';
  const asCode = (v: number, i: number): string => restoredPhone(heading(i), v) ?? String(v);
  // A column that numbers the rows stays the numbers it holds: compared as text, row 10
  // came before row 5.
  const coded = profiles.map((p) => Boolean(p.identifier && !p.rowNumbers));
  const rewrites = orders.some((o) => o !== null) || coded.some(Boolean);
  const rows: readonly (readonly Json[])[] = !rewrites
    ? dataRows
    : dataRows.map((row) =>
        row.map((v, i) => {
          const order = orders[i];
          if (order && typeof v === 'string' && !ISO_INSTANT.test(v)) {
            const d = parseDateText(v, order);
            return d ? d.toISOString() : v;
          }
          if (coded[i] && typeof v === 'number') return asCode(v, i);
          return v;
        }),
      );

  const columns: IndexColumn[] = paths.map((path, i) => {
    const p = profiles[i]!;
    const spoken = spokenNames[i]!;

    const base: IndexColumn = {
      i,
      path,
      spoken,
      col: columnLetter(firstCol + i),
      kind: p.kind,
      nonEmpty: p.nonEmpty,
      empty: p.empty,
      distinct: p.distinct,
    };
    // Listed as stored, so a restored phone number is offered with its zero.
    const categories = p.identifier
      ? p.categories?.map((v) => (/^\d+$/.test(v) && String(Number(v)) === v ? asCode(Number(v), i) : v))
      : p.categories;
    const code = p.rowNumbers ? 'row' : p.identifier ? (identifierHeadingKind(heading(i)) === 'phone' ? 'phone' : 'code') : null;
    return {
      ...base,
      ...(categories ? { categories } : {}),
      ...(code ? { identifier: code } : {}),
      // Kept because the stored ISO days no longer show it, and a filter value written
      // the way the file writes its dates has to be read the same way round.
      ...(orders[i] === 'dmy' ? { dateOrder: 'dmy' as const } : {}),
      ...(p.numeric
        ? {
            min: p.numeric.min,
            max: p.numeric.max,
            sum: p.numeric.sum,
            mean: p.numeric.mean,
            nonNumeric: p.numeric.nonNumeric,
          }
        : {}),
    };
  });

  return {
    headerRows: Array.from({ length: headerCount }, (_, i) => regionStartRow + i),
    firstDataRow: regionStartRow + headerCount,
    columns,
    rows,
    labelColumn: pickLabelColumn(columns, records.length),
    ambiguousColumns: ambiguous,
    summaryRows,
    dateGuesses,
  };
}
