/**
 * Query engine.
 *
 * Two rules shape everything here, and both come from the fact that the answer will
 * be spoken to someone who cannot glance at the sheet to check it.
 *
 * 1. NOTHING IS ESTIMATED, AND NOTHING IS COMPUTED BY A LANGUAGE MODEL. Filtering and
 *    aggregation happen in this file, over the index, deterministically. The model's
 *    job is to choose the query and read the sentence, not to do arithmetic.
 *
 * 2. EVERY ANSWER CARRIES ITS PROVENANCE. Which cells produced this number, and which
 *    rows were skipped and why. A sighted user checks a total by looking at the
 *    column; over audio there is nothing to look at, so the check has to be a tool
 *    call. Exclusions are counted rather than quietly dropped: "the total of 47 of
 *    the 52 rows; five were empty" is a different statement from "the total".
 */

import { asNumber, dateOrder, MONTH_NAMES, parseDateText, readNumber } from '../table/infer.ts';
import { a1 } from '../table/model.ts';
import type { IndexColumn, IndexRegion } from '../indexfmt.ts';

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'is_empty'
  | 'is_not_empty';

export type Aggregate = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface Filter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value?: string;
  /**
   * For eq and neq: several values, any one of which matches (eq) or none of which
   * may (neq). Filters combine with AND, so "Vietnam and Thailand" could only be asked
   * as a breakdown of every country, and past the first page the two named were not
   * in the answer at all.
   */
  readonly values?: readonly string[];
}

/** Which end of a breakdown comes first. */
export type GroupOrder = 'desc' | 'asc';

export interface QuerySpec {
  readonly filters?: readonly Filter[];
  readonly aggregate?: Aggregate;
  readonly aggregateColumn?: string;
  readonly groupBy?: string;
  /**
   * Groups come largest first unless this says 'asc'. "Which department spent the
   * least" answered largest first named the most first, and with more groups than a
   * page the least was not in the answer at all.
   */
  readonly order?: GroupOrder;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ExcludedCell {
  readonly address: string;
  readonly reason: string;
}

export interface Provenance {
  readonly sheet: string;
  /**
   * Addresses that contributed to the answer. Capped; `cellCount` is the truth. For a
   * highest or lowest value the winning cells come first, so an explanation that can
   * only name a few names the one that answered the question.
   */
  readonly cells: readonly string[];
  readonly cellCount: number;
  readonly excluded: readonly ExcludedCell[];
}

export interface GroupResult {
  readonly key: string;
  readonly value: number | null;
  readonly rowCount: number;
}

/** A row that passed the other filters but whose cell could not be compared. */
export interface UnreadableRow {
  readonly row: number;
  readonly column: IndexColumn;
  /** What the filter needed the cell to be. */
  readonly wanted: 'number' | 'date';
}

export interface QueryResult {
  readonly result: number | null;
  /** Rows matching the filters, before any limit is applied. */
  readonly matchedRows: number;
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  /** Data-row indices of `rows`, so callers can map back for labels. */
  readonly rowIndices: readonly number[];
  readonly groups: readonly GroupResult[];
  readonly provenance: Provenance;
  readonly moreAvailable: boolean;
  readonly nextOffset: number | null;
  /** Total and subtotal rows that passed the filters and were left out. */
  readonly summarySkipped: readonly number[];
  /** Rows a numeric or date filter could not compare ("n/a" in a number column). */
  readonly unreadable: readonly UnreadableRow[];
  /**
   * For a highest or lowest value: the data rows that hold it, at most WINNER_CAP of
   * them. A flag column where every row holds 1 has twenty thousand "winners", and
   * naming them all costs a Worker's whole budget to say "and 19,999 others".
   */
  readonly winners: readonly number[];
  /** How many rows hold the highest or lowest value, however many `winners` names. */
  readonly winnerCount: number;
  /** The column the answer was broken down by, so its keys are spoken in its kind. */
  readonly groupColumn: IndexColumn | null;
  /**
   * How many groups a breakdown has in all, across every page. A cursor past the last
   * of them used to come back as "There is no total. No matching row held a number" —
   * a false statement about rows that held numbers and had all been read.
   */
  readonly groupCount: number;
  /**
   * Every group of a breakdown holds a single row, so each figure is that row's own
   * value: "the highest GDP per capita" of one country is just its GDP per capita.
   */
  readonly oneRowEach: boolean;
  /** When nothing matched: the first filter that on its own matches no row at all. */
  readonly unmatched: { readonly column: IndexColumn; readonly op: FilterOp; readonly value: string | null } | null;
}

export class QueryError extends Error {
  /**
   * What the caller should do instead. This is spoken to the user, so it must be
   * actionable — "ask which column they mean", not "invalid argument".
   *
   * Declared as a field rather than a constructor parameter property: parameter
   * properties emit code, so they are not erasable, and Node's type stripping
   * rejects them outright.
   */
  readonly nextStep: string;
  /**
   * The column name that matched nothing, when that is what went wrong — so the tool
   * layer, which can see the other tables in the file, can point to the one that has it.
   */
  readonly missing: string | null;

  constructor(message: string, nextStep: string, missing: string | null = null) {
    super(message);
    this.name = 'QueryError';
    this.nextStep = nextStep;
    this.missing = missing;
  }
}

const PROVENANCE_CELL_CAP = 200;
/** How many rows holding a highest or lowest value are named. */
export const WINNER_CAP = 5;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Cell = string | number | boolean | null;

function blank(v: Cell): boolean {
  return v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Round away binary floating-point noise before a number is compared or spoken.
 *
 * 10.10 + 20.20 is 30.299999999999997 in binary, so a cents column compared with
 * itself came out "0 less than … 30.3 against 30.3". Twelve significant digits keeps
 * every figure a spreadsheet can meaningfully hold and drops the noise below it.
 */
export function tidy(n: number): number {
  return Number.isFinite(n) && n !== 0 ? Number(n.toPrecision(12)) : n;
}

/**
 * Text from a cell, a heading or a note, made safe to put in a spoken sentence.
 *
 * Cell text is data someone else typed. A newline or a control character inside it
 * would break the sentence it is dropped into, and a bidirectional override can make
 * the text read differently from what is stored. `cap` bounds a single cell so one
 * pasted paragraph cannot take over a thirty-second answer.
 */
export function cleanText(s: string, cap = 0): string {
  const flat = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cap > 0 && flat.length > cap) return `${flat.slice(0, cap).replace(/\s+\S*$/, '')}…`;
  return flat;
}

/**
 * A column's name as it should be heard: the heading path run together as a phrase
 * ("2026 Q1 Revenue"), never the comma-joined identifier, whose commas sound exactly
 * like the ones between columns in a list.
 */
export function columnName(c: IndexColumn): string {
  return cleanText(c.spoken.replace(/,\s*/g, ' '));
}

const SCALE_WORDS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  mil: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  tn: 1e12,
  trillion: 1e12,
  percent: 1,
};

/**
 * A filter value as a person would say it. "100 million" and "1.5k" are how a number
 * arrives from speech; reading only digits turned "more than 100 million" into a
 * comparison of text and eight countries out of eight "matched".
 */
export function readSpokenNumber(raw: string, convention: 'dot' | 'comma' = 'dot'): number | null {
  // "30.000" typed against a column of dong is thirty thousand, the way that column
  // writes it, not thirty: a filter value is read in its column's own convention.
  const direct = readNumber(raw, convention)?.value ?? null;
  if (direct !== null) return direct;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^minus\s+/, '-')
    .replace(/^(?:[$£€¥₫]|usd|eur|gbp|vnd)\s*/, '');
  const plain = asNumber(s);
  if (plain !== null) return plain;
  const m = /^(-?[\d,]*\.?\d+)\s*([a-z]+)$/.exec(s);
  if (!m) return null;
  const base = asNumber(m[1]!);
  const scale = SCALE_WORDS[m[2]!];
  if (base === null || scale === undefined) return null;
  return tidy(base * scale);
}

export type DateOrder = 'mdy' | 'dmy';

/**
 * A date, read as a calendar day in UTC — the same convention the index stores every
 * date in ("2026-07-04T00:00:00.000Z").
 *
 * This is ingest's own parser, not a second one. The engine used to keep its own, and
 * the two disagreed: a dotted "04.07.2026" was 4 July to ingest and 7 April here, and
 * "5/5/85" was 1985 to ingest (Excel's rule) and 2085 here — so a filter written the
 * way the file writes its dates missed the very day ingest had stored. `order` settles
 * a numeric day and month that fit both ways, as the column itself shows it.
 */
export function readDate(v: Cell | Date, order: DateOrder = 'mdy'): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  return parseDateText(v, order);
}

/**
 * Which way round a column writes its numeric dates: the order ingest recorded, or
 * for a column whose cells are still the file's own text (a mixed column), the order
 * those cells show. Cached per column, because a filter reads it once per row.
 */
const orders = new WeakMap<IndexColumn, DateOrder>();
export function columnDateOrder(region: IndexRegion, col: IndexColumn): DateOrder {
  if (col.dateOrder) return col.dateOrder;
  let order = orders.get(col);
  if (order === undefined) {
    order = col.kind === 'date' || col.kind === 'mixed' ? dateOrder(region.rows.map((r) => r[col.i] ?? null)) : 'mdy';
    orders.set(col, order);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Total rows
// ---------------------------------------------------------------------------

/**
 * Rows that are totals of the rows above them, as found at ingest.
 *
 * Counting a "Total" row into a sum doubles it, and counting it as a record makes
 * "how many" one too many. The field is optional because an index built before total
 * detection existed has none, and that must still load.
 */
export function summaryRowsOf(region: IndexRegion): ReadonlySet<number> {
  const rows = (region as IndexRegion & { readonly summaryRows?: readonly number[] }).summaryRows;
  return new Set(rows ?? []);
}

/**
 * "Total", "Grand total", "Tổng cộng" — the text that made a row a total, as written.
 *
 * Found the way ingest finds it: the first text cell that is neither a number nor a
 * date. A ledger's total row starts with the month it closes, and taking that cell
 * announced "the 2026-07-31T00:00:00.000Z row".
 */
export function summaryLabel(region: IndexRegion, dataRow: number): string {
  const row = region.rows[dataRow] ?? [];
  for (const v of row) {
    if (typeof v === 'string' && v.trim() && asNumber(v) === null && readDate(v) === null) {
      return cleanText(v, 40).replace(/\s*:$/, '');
    }
  }
  return 'Total';
}

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

/** Lowercase, with spacing tidied but every symbol kept: the name exactly as written. */
function lower(s: string): string {
  return cleanText(s).toLowerCase();
}

/**
 * Lowercase words only, so "2026, Q1, Revenue", "2026 Q1 Revenue" and "2026,Q1,Revenue"
 * agree. "%" and "#" are words when spoken ("margin percent", "order number"), so they
 * become those words rather than vanishing; a name that is nothing but symbols keeps
 * its symbols, because an empty name matches nothing and "#" is a real heading.
 */
function norm(s: string): string {
  const words = s
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/#/g, ' number ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return words || lower(s);
}

/** Every written form a column can be asked for by. */
function formsOf(c: IndexColumn): string[] {
  return [c.spoken, columnName(c), c.path[c.path.length - 1] ?? '', c.path.join(', '), c.path.join(' ')];
}

/**
 * Every word asked for appears as a whole word in the column's name. Substring
 * matching let "core" find "Score" and "age" find "Average price", which answered a
 * question nobody asked.
 */
function looseMatches(region: IndexRegion, want: string): IndexColumn[] {
  const asked = want.split(' ').filter(Boolean);
  if (!asked.length) return [];
  return region.columns.filter((c) => {
    const words = new Set(norm(`${c.path.join(' ')} ${c.spoken}`).split(' '));
    return asked.every((w) => words.has(w));
  });
}

type Found =
  | { readonly one: IndexColumn }
  | { readonly many: readonly IndexColumn[]; readonly loosely: boolean }
  | null;

/**
 * What a column name could mean, most exact reading first.
 *
 * Comparing only the punctuation-free forms made "Margin" and "Margin %", or "Cost" and
 * "Cost ($)", the same name, so neither could be asked for at all; and once ingest
 * numbered repeated headings ("Amount", "Amount 2", both with the heading Amount), the
 * first answered to nothing because its heading matched the second too. So the name
 * describe speaks wins outright when it is unique, then any form written exactly,
 * then the same ignoring punctuation, and only then whole words.
 */
function find(region: IndexRegion, name: string): Found {
  const raw = lower(name);
  const n = norm(name);
  const cols = region.columns;

  const spoken = cols.filter((c) => lower(c.spoken) === raw || lower(columnName(c)) === raw);
  if (spoken.length === 1) return { one: spoken[0]! };
  const exact = cols.filter((c) => formsOf(c).some((f) => lower(f) === raw));
  if (exact.length === 1) return { one: exact[0]! };
  if (exact.length > 1) return { many: exact, loosely: false };

  const spokenLoose = cols.filter((c) => norm(c.spoken) === n);
  if (spokenLoose.length === 1) return { one: spokenLoose[0]! };
  const normal = cols.filter((c) => formsOf(c).some((f) => norm(f) === n));
  if (normal.length === 1) return { one: normal[0]! };
  if (normal.length > 1) return { many: normal, loosely: false };

  // A whole-word match before giving up, so "revenue" finds "2026, Q2, Revenue" when
  // only one column could be meant.
  const loose = looseMatches(region, n);
  if (loose.length === 1) return { one: loose[0]! };
  if (loose.length > 1) return { many: loose, loosely: true };

  // Last, a column by its sheet letter or its place in the table, the way someone
  // reading the sheet names one: "column C", "column 3". Only once nothing is called
  // that, so a heading that really is "Column 3" still answers to its own name.
  const at = /^col(?:umn)?\s+(?:([a-z]{1,3})|(\d{1,3}))$/i.exec(cleanText(name));
  if (at) {
    const hit = at[1]
      ? cols.find((c) => c.col.toLowerCase() === at[1]!.toLowerCase())
      : cols[Number(at[2]) - 1];
    if (hit) return { one: hit };
  }
  return null;
}

/**
 * A column with no heading and nothing in it: the spacer between the two halves of a
 * table that ingest joined back together. It is kept, so every cell keeps its address,
 * but it is not a column anyone can ask about, and naming it "column 4" in a list of
 * the columns is noise.
 */
export function isGutter(c: IndexColumn): boolean {
  return c.kind === 'empty' && c.path.length === 0;
}

/**
 * Column names for a sentence that has other work to do: the first few, then "and N
 * more". An error's next step used to list every column, and on a twenty-column table
 * the sentence ran past the word budget and was dropped whole, leaving an error with
 * nothing to do about it.
 */
export function nameList(cols: readonly IndexColumn[], max = 8, maxWords = 24): string {
  const names = cols.filter((c) => !isGutter(c)).map((c) => cleanText(columnName(c), 60));
  const said: string[] = [];
  let words = 0;
  for (const name of names) {
    const w = name.split(' ').length;
    if (said.length >= max || (said.length > 0 && words + w > maxWords)) break;
    said.push(name);
    words += w;
  }
  const items = said.length < names.length ? [...said, `${names.length - said.length} more`] : said;
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function notFound(region: IndexRegion, name: string): QueryError {
  const said = cleanText(name, 60);
  return new QueryError(
    `This table has no column called "${said}".`,
    `The columns are: ${nameList(region.columns)}.`,
    said,
  );
}

/**
 * Resolve a column by name. Accepts the spoken name, the leaf label, or the full path
 * joined by commas or by spaces — a voice agent will produce any of them, and the one
 * describe speaks aloud ("2026 Q1 Revenue") used to be the one refused.
 */
export function resolveColumn(region: IndexRegion, name: string): IndexColumn {
  if (!cleanText(name)) {
    throw new QueryError('No column name was given.', 'Ask which column they mean.');
  }
  const found = find(region, name);
  if (found === null) throw notFound(region, name);
  if ('one' in found) return found.one;
  throw new QueryError(
    found.loosely
      ? `"${cleanText(name, 60)}" is ambiguous.`
      : `"${cleanText(name, 60)}" matches ${found.many.length} columns in this table.`,
    `Ask which one: ${nameList(found.many)}.`,
  );
}

/**
 * Every column a name could mean, for reading rather than computing: asking to hear
 * "revenue" on a sheet with four revenue columns reasonably reads all four, where
 * totalling "revenue" must ask which. Throws when the name matches nothing, so a
 * request for a column that is not there is an error rather than silence.
 */
export function matchColumns(region: IndexRegion, name: string): IndexColumn[] {
  const found = cleanText(name) ? find(region, name) : null;
  if (found === null) throw notFound(region, name);
  return 'one' in found ? [found.one] : [...found.many];
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Filter tests as words, because a code like "gt" must never reach a listener. */
export const OP_WORDS: Record<FilterOp, string> = {
  eq: 'equal to',
  neq: 'other than',
  gt: 'more than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  contains: 'containing',
  is_empty: 'empty',
  is_not_empty: 'filled in',
};

const NUMERIC_KINDS = new Set(['number', 'currency', 'percent']);

/** What a column that is not numbers holds, as it is said. */
const KIND_WORDS: Partial<Record<string, string>> = {
  text: 'text',
  category: 'text',
  mixed: 'a mix of text and numbers',
  date: 'dates',
  boolean: 'yes or no answers',
  empty: 'nothing',
};

type Outcome = boolean | 'unreadable';

/** "August", "Aug 2026", "August, 2026": a month and, if said, its year. */
function monthOnly(raw: string): { month: number; year: number | null } | null {
  const m = /^([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/i.exec(raw.trim());
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  const i = MONTH_NAMES.findIndex((name) => {
    const n = name.toLowerCase();
    return n === w || (n.startsWith(w) && (w.length === 3 || w === 'sept'));
  });
  return i < 0 ? null : { month: i + 1, year: m[2] ? Number(m[2]) : null };
}

function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '');
  const i = MONTH_NAMES.findIndex((name) => {
    const n = name.toLowerCase();
    return n === w || (w.length >= 3 && n.startsWith(w) && (w.length === 3 || w === 'sept'));
  });
  return i < 0 ? null : i + 1;
}

/**
 * "July 4", "4 July", "the 4th of July", "07/04": a day with no year. Asked of a date
 * column it used to be compared as text and answered "No rows match", however many
 * rows closed on 4 July; it now matches the day in any year.
 */
function monthDay(raw: string, order: DateOrder): { month: number; day: number } | null {
  const s = raw.trim().replace(/^the\s+/i, '');
  const named =
    /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/i.exec(s) ?? /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?$/i.exec(s);
  let month: number | null = null;
  let day: number | null = null;
  if (named) {
    const [word, digits] = /^\d/.test(named[1]!) ? [named[2]!, named[1]!] : [named[1]!, named[2]!];
    month = monthOf(word);
    day = Number(digits);
  } else {
    const num = /^(\d{1,2})([/\-.])(\d{1,2})$/.exec(s);
    if (!num) return null;
    const dayFirst = order === 'dmy' || num[2] === '.';
    month = Number(dayFirst ? num[3] : num[1]);
    day = Number(dayFirst ? num[1] : num[3]);
  }
  return month && day && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null;
}

/**
 * The one year every dated row of a column falls in, if they share one: "since August"
 * means August of that year. Null when they span several, so the question is asked.
 */
function sharedYear(region: IndexRegion, col: IndexColumn, order: DateOrder): number | null {
  const summary = summaryRowsOf(region);
  let year: number | null = null;
  for (let i = 0; i < region.rows.length; i++) {
    if (summary.has(i)) continue;
    const d = readDate(region.rows[i]?.[col.i] ?? null, order);
    if (!d) continue;
    if (year === null) year = d.getUTCFullYear();
    else if (year !== d.getUTCFullYear()) return null;
  }
  return year;
}

/**
 * A condition in whole months on a date column, as the days it means. "Since August"
 * is on or after 1 August; "after August", on or after 1 September; "before August",
 * before 1 August; "until August", before 1 September. The year is the one said, or the
 * one every row shares; when the rows span years and none was said, the question is
 * asked rather than a year guessed.
 */
function monthBound(region: IndexRegion, f: Resolved): Resolved {
  const ordered = f.op === 'gt' || f.op === 'gte' || f.op === 'lt' || f.op === 'lte';
  if (f.col.kind !== 'date' || !ordered || f.value === undefined || readDate(f.value, f.order) !== null) return f;
  // "After August 15": a day with no year, in the year the rows share.
  const day = monthDay(f.value, f.order);
  if (day) {
    const shared = sharedYear(region, f.col, f.order);
    const said = `${MONTH_NAMES[day.month - 1]} ${day.day}`;
    if (shared === null) {
      throw new QueryError(`Which year do you mean for ${said}? The dates here span more than one.`, `Say it with the year, like ${said}, 2026.`);
    }
    return { ...f, value: new Date(Date.UTC(shared, day.month - 1, day.day)).toISOString() };
  }
  const month = monthOnly(f.value);
  if (!month) return f;
  const year = month.year ?? sharedYear(region, f.col, f.order);
  const name = MONTH_NAMES[month.month - 1]!;
  if (year === null) {
    throw new QueryError(`Which year do you mean for ${name}? The dates here span more than one.`, `Say it with the year, like ${name} 2026.`);
  }
  const after = f.op === 'gt' || f.op === 'lte';
  const first = new Date(Date.UTC(year, month.month - 1 + (after ? 1 : 0), 1)).toISOString();
  return { ...f, op: f.op === 'gt' || f.op === 'gte' ? 'gte' : 'lt', value: first };
}

/** Yes and no as a flag column writes them, in the languages the fixtures use. */
function truth(v: Cell): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (/^(true|yes|y|có)$/.test(s)) return true;
  if (/^(false|no|n|không)$/.test(s)) return false;
  return null;
}

/**
 * Compare a cell against a filter value, using the column's inferred type to decide
 * how. A string comparison on "1200" vs "900" gets the wrong answer; a numeric
 * comparison on region names is meaningless. The column already told us which it is.
 *
 * A numeric or date column never falls back to comparing text for an ordering test.
 * It used to: a value that did not parse ("100 million") was compared as text, so
 * "71801279" came out greater than "100 million" and every row matched, spoken as a
 * confident count. Now an unreadable value is refused with a sentence saying how to
 * say it, and an unreadable cell ("n/a" in a number column) is reported as
 * `unreadable` rather than sorted after the digits.
 */
function compare(cell: Cell, op: FilterOp, raw: string | undefined, col: IndexColumn, order: DateOrder = 'mdy'): Outcome {
  if (op === 'is_empty') return blank(cell);
  if (op === 'is_not_empty') return !blank(cell);
  if (raw === undefined || raw.trim() === '') {
    throw new QueryError(
      `I need something to compare ${columnName(col)} with.`,
      `Ask what ${columnName(col)} should be ${OP_WORDS[op]}.`,
    );
  }
  if (blank(cell)) return false;

  // A flag column stores TRUE, Yes or có for the same answer; "paid equal to yes"
  // compared as text never matched a cell that held TRUE.
  if (col.kind === 'boolean' && (op === 'eq' || op === 'neq')) {
    const want = truth(raw);
    const have = truth(cell);
    if (want !== null && have !== null) return op === 'eq' ? have === want : have !== want;
  }

  // "Closed in August": a whole month, by name. A day-level reader refused it as "not
  // a date", so the most ordinary question about a sales sheet had no way in.
  if (col.kind === 'date' && (op === 'eq' || op === 'neq')) {
    const month = monthOnly(raw);
    if (month) {
      const d = readDate(cell, order);
      if (!d) return 'unreadable';
      const same = d.getUTCMonth() + 1 === month.month && (month.year === null || d.getUTCFullYear() === month.year);
      return op === 'eq' ? same : !same;
    }
    const day = readDate(raw, order) === null ? monthDay(raw, order) : null;
    if (day) {
      const d = readDate(cell, order);
      if (!d) return 'unreadable';
      const same = d.getUTCMonth() + 1 === day.month && d.getUTCDate() === day.day;
      return op === 'eq' ? same : !same;
    }
  }

  // A phone number is the same number with or without its leading zero, spaces or
  // dashes: Excel keeps 0912345678 as 912345678, and someone asking for it says the zero.
  if (col.identifier === 'phone' && (op === 'eq' || op === 'neq')) {
    const digits = (x: string): string => x.trim().replace(/^\+84/, '0').replace(/\D/g, '').replace(/^0+/, '');
    const want = digits(raw);
    if (want.length >= 6) {
      const same = digits(String(cell)) === want;
      return op === 'eq' ? same : !same;
    }
  }

  const ordered = op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
  const kind = col.kind;
  if (op !== 'contains' && (NUMERIC_KINDS.has(kind) || kind === 'date' || kind === 'mixed')) {
    const asNum = readSpokenNumber(raw, col.numberConvention ?? 'dot');
    const dateLike = kind === 'date' || (kind === 'mixed' && asNum === null && readDate(raw, order) !== null);
    const want = dateLike ? (readDate(raw, order)?.getTime() ?? null) : asNum;
    if (want !== null) {
      const have = dateLike ? (readDate(cell, order)?.getTime() ?? null) : asNumber(cell);
      if (have === null) return 'unreadable';
      const x = dateLike ? have : tidy(have);
      switch (op) {
        case 'eq': return x === want;
        case 'neq': return x !== want;
        case 'gt': return x > want;
        case 'gte': return x >= want;
        case 'lt': return x < want;
        case 'lte': return x <= want;
      }
    }
    if (ordered && kind !== 'mixed') {
      throw kind === 'date'
        ? new QueryError(
            `I couldn't read "${cleanText(raw, 40)}" as a date.`,
            'Say the date as year, month and day, like 2026-08-01, or as August 1, 2026.',
          )
        : new QueryError(
            `I couldn't read "${cleanText(raw, 40)}" as a number.`,
            'Say the number in digits, like 100000000, or as 100 million.',
          );
    }
    // Equality with a value that is not a number falls through to text, so "n/a" can
    // still be found in a number column by asking for it.
  }

  const s = String(cell).trim().toLowerCase();
  const t = raw.trim().toLowerCase();
  switch (op) {
    case 'eq': return s === t;
    case 'neq': return s !== t;
    case 'contains': return s.includes(t);
    case 'gt': return s > t;
    case 'gte': return s >= t;
    case 'lt': return s < t;
    case 'lte': return s <= t;
  }
}

// ---------------------------------------------------------------------------
// Measures that do not add up
// ---------------------------------------------------------------------------

/** An amount over a stretch of time: rent per month across three flats is their rent per month. */
const PER_TIME = /\bper\s+(?:hour|hr|day|night|shift|week|fortnight|month|quarter|year|annum)\b/g;

/**
 * A share of a whole: "Budget allocation (%)", "% of total", "Percent of spend". Its parts
 * sum to the whole when the sheet is complete, which is exactly what someone checking an
 * allocation asks, so a percentage like this one adds up.
 */
const SHARE = /\b(?:share|shares|portion|allocation|allocated|split|weight|weighting|ownership|owned|stake|stakes)\b|(?:%|\bper\s?cent|\bpercentage)\s+of\b/;
/**
 * The same in Vietnamese: "Tỷ trọng (%)" is a share of the whole, "Cơ cấu (%)" a breakdown
 * of it. Neither was a share, so "what is the total tỷ trọng" was refused and its average,
 * 33.33%, given in its place, where the shares add up to 100%.
 */
const SHARE_VN = /(?:^|[^\p{L}])(?:t[ỷỉ]\s+tr[ọo]ng|c[ơo]\s+c[ấa]u)(?![\p{L}])/u;

/**
 * A distance over a stretch of time is a speed, and the speeds of three cars add up to
 * nothing. Checked before an amount per stretch of time is let through, which would
 * otherwise let "km per hour" through with "rent per month".
 */
const SPEED =
  /\b(?:speed|velocity|mph|kph|kmh|km\/h)\b|\b(?:km|kilomet(?:er|re)s?|miles?|met(?:er|re)s?|m|ft|feet|yards?)\s+(?:per|an?)\s+(?:hour|hr|h|minute|min|second|sec|s)\b/;

/**
 * What a figure "per" one of them is a figure per: a person, a unit, a kilo, a game. A
 * total of them is a sum of averages — each row's figure is already divided by that row's
 * own count — and means nothing. "Per region", "per team" and "per store" are not here:
 * in a sheet with a row to each region the sales per region are the regions' sales, and
 * their sum is the real total. Refusing them told a listener something false about their
 * own sheet, and left no way to get the total at all.
 */
const PER_ONE = new Set([
  'capita', 'head', 'person', 'people', 'individual', 'resident', 'inhabitant', 'citizen', 'adult', 'child',
  'employee', 'worker', 'staff', 'fte', 'member', 'customer', 'client', 'user', 'patient', 'student', 'pupil',
  'visitor', 'guest', 'subscriber', 'household', 'family', 'unit', 'item', 'piece', 'share', 'order',
  'transaction', 'sale', 'visit', 'game', 'match', 'serving', 'dose', 'kg', 'kgs', 'kilo', 'kilogram', 'gram',
  'lb', 'lbs', 'pound', 'ton', 'tonne', 'litre', 'liter', 'gallon', 'mile', 'km', 'kilometre', 'kilometer',
  'metre', 'meter', 'acre', 'hectare', 'room', 'bed', 'seat', 'trip', 'call', 'click', 'impression', 'view',
]);

/** "Regions" as "region", "countries" as "country": enough to match a heading's own word. */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(?:ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * The row is one of `word`: a text column in the same table is called that — "Region",
 * "Store name", "Customer ID" — so a figure per one of them is each row's own figure.
 */
function rowsAre(region: IndexRegion, c: IndexColumn, word: string): boolean {
  return region.columns.some((o) => {
    if (o === c || (o.kind !== 'text' && o.kind !== 'category')) return false;
    const called = columnName(o).toLowerCase().replace(/\s+(?:name|names|id|code|no|number)$/, '').trim();
    return called !== '' && singular(called) === word;
  });
}

/**
 * Why adding a column up gives no total, as the end of "X is …", or null when it does.
 *
 * GDP per capita, a margin percentage, an average price: each row's figure is already a
 * ratio over that row's own base, so their sum is a number that means nothing. "What is
 * the total GDP of Asia" was answered "About 16.4 thousand. That is the total of GDP per
 * capita across 3 rows" — the per-person figures of three countries added together,
 * spoken as an answer.
 *
 * In order, because the first that applies is the reason given:
 *   - an average, mean or median already is one, whatever else the heading says;
 *   - a percentage has no total, unless it is a share of a whole ("Budget allocation
 *     (%)", "% of total"), whose parts sum to the whole;
 *   - a speed has none, though it is a distance per stretch of time;
 *   - a heading that calls itself a rate or a ratio is one, whatever it is per: "Hourly
 *     rate" and "Rate per hour" are refused alike;
 *   - a figure per thousand of something ("Births per 1,000") is a rate, and one per
 *     person, unit, kilo or game is an average over those (see PER_ONE).
 * An amount per stretch of time adds up (the rent per month of every flat sums to the rent
 * per month for all of them), and so does a figure per whatever each row is: "Sales per
 * region" in a sheet with a Region column. `region`, when given, is what says what each
 * row is; without it that last exemption is not made.
 *
 * Read from the heading, which is all there is to go on, and narrowly: "price" is not
 * here, because a total price is an ordinary question where a total of GDP per capita
 * is not. Only a total is refused; the average, highest and lowest of a rate all mean
 * what they say.
 */
export function rateLike(c: IndexColumn, region?: IndexRegion): string | null {
  const said = columnName(c).normalize('NFC').toLowerCase();
  if (/\b(?:average|avg|mean)\b/.test(said)) return 'already an average';
  if (/\bmedian\b/.test(said)) return 'already a median';
  if (c.kind === 'percent' || /%|\bper\s?cent\b|\bpercentage\b/.test(said)) return SHARE.test(said) || SHARE_VN.test(said) ? null : 'a percentage';
  if (SPEED.test(said)) return 'a speed';
  const rate = /\b(rate|ratio)\b/.exec(said);
  if (rate) return `a ${rate[1]}`;
  // "Per 1,000 people" is said "per 1 000 people", and "per 1000" may end the heading.
  const per = /\bper[\s-]+(?:(\d|hundred\b|thousand\b|million\b)|(\p{L}+))/u.exec(said.replace(PER_TIME, ' '));
  if (!per) return null;
  if (per[1]) return 'a rate';
  const word = singular(per[2]!);
  if (region && rowsAre(region, c, word)) return null;
  if (PER_ONE.has(per[2]!)) return `a per-${per[2]} figure`;
  return PER_ONE.has(word) ? `a per-${word} figure` : null;
}

/** Per one of these, a figure's total is never one: GDP per capita, spending per head. */
const PER_HEAD = /^a per-(?:capita|head) figure$/;

/**
 * Whether a total of this column is refused outright, and why: the cases that cannot be a
 * total whatever the rows are — a figure per capita or per head, a rate or a ratio, a
 * speed, a median, a percentage that is not a share of a whole.
 *
 * The rest of rateLike's cases may well add up, and are answered when a total is asked
 * for in so many words (see sumCaution): "Cost per person" over the days of a trip adds up
 * to what the trip costs one person, 340, and "Average monthly spend" over the categories
 * of a budget to the month's spending. Refused, and their average given instead under
 * "cannot be added up into a total", the listener was told something false about their
 * own sheet.
 */
export function noTotal(c: IndexColumn, region?: IndexRegion): string | null {
  const why = rateLike(c, region);
  return why && !sumCaution(c, region) ? why : null;
}

/**
 * The word a total of this column is given with, where it may or may not be a real one:
 * "already an average", "a per-person figure". Said after the figure — "That adds up Cost
 * per person across 6 rows, each of them a per-person figure" — so the listener knows
 * what was added.
 */
export function sumCaution(c: IndexColumn, region?: IndexRegion): string | null {
  const why = rateLike(c, region);
  if (why === 'already an average') return why;
  return why && /^a per-[\p{L}-]+ figure$/u.test(why) && !PER_HEAD.test(why) ? why : null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Resolved = Filter & { readonly col: IndexColumn; readonly order: DateOrder };

/**
 * Refuse a value a date column cannot be compared with, rather than compare it as text.
 * "No rows match: no row has Closed equal to July 4" was a confident zero for a day
 * that had a sale on it. A value some cell holds as written ("TBD") is still found.
 */
function unreadableDate(region: IndexRegion, f: Resolved, v: string): void {
  if (!v.trim() || readDate(v, f.order) !== null || monthOnly(v) !== null || monthDay(v, f.order) !== null) return;
  const t = v.trim().toLowerCase();
  if (region.rows.some((row) => String(row[f.col.i] ?? '').trim().toLowerCase() === t)) return;
  throw new QueryError(
    `I couldn't read "${cleanText(v, 40)}" as a date.`,
    'Say the date with its year, like August 1, 2026, or as 2026-08-01.',
  );
}

/** One filter against one cell, several values counting as any one of them. */
function passes(cell: Cell, f: Resolved): Outcome {
  const many = f.values?.length && (f.op === 'eq' || f.op === 'neq') ? f.values : null;
  if (!many) return compare(cell, f.op, f.value, f.col, f.order);
  let unread = false;
  for (const v of many) {
    const o = compare(cell, 'eq', v, f.col, f.order);
    if (o === true) return f.op === 'eq';
    if (o === 'unreadable') unread = true;
  }
  return unread ? 'unreadable' : f.op === 'neq';
}

export function runQuery(region: IndexRegion, spec: QuerySpec): QueryResult {
  const filters = spec.filters ?? [];
  const aggregate: Aggregate = spec.aggregate ?? 'none';
  const limit = Math.max(1, Math.min(spec.limit ?? 5, 50));
  const offset = Math.max(0, spec.offset ?? 0);
  const ascending = spec.order === 'asc';
  // Empty groups (no number in any of their rows) go last either way round.
  const byValue = (a: GroupResult, b: GroupResult): number =>
    a.value === null || b.value === null
      ? (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0)
      : ascending
        ? a.value - b.value
        : b.value - a.value;

  const resolvedFilters: Resolved[] = filters.map((f) => {
    const col = resolveColumn(region, f.column);
    const resolved = monthBound(region, { ...f, col, order: columnDateOrder(region, col) });
    if (col.kind === 'date' && (f.op === 'eq' || f.op === 'neq')) {
      for (const v of f.values?.length ? f.values : f.value !== undefined ? [f.value] : []) unreadableDate(region, resolved, v);
    }
    return resolved;
  });
  const summary = summaryRowsOf(region);

  const matching: number[] = [];
  const summarySkipped: number[] = [];
  const unreadable: UnreadableRow[] = [];
  for (let i = 0; i < region.rows.length; i++) {
    const row = region.rows[i]!;
    // Every filter is evaluated, so a row is reported as unreadable only when it
    // passed everything else — an "n/a" on a row the other filters rule out anyway
    // is not a row anyone lost.
    let failed = false;
    let unread: UnreadableRow | null = null;
    for (const f of resolvedFilters) {
      const o = passes(row[f.col.i] ?? null, f);
      if (o === 'unreadable') {
        unread ??= { row: i, column: f.col, wanted: f.col.kind === 'date' ? 'date' : 'number' };
      } else if (!o) {
        failed = true;
      }
    }
    if (failed) continue;
    if (summary.has(i)) {
      summarySkipped.push(i);
      continue;
    }
    if (unread) {
      unreadable.push(unread);
      continue;
    }
    matching.push(i);
  }

  // Nothing matched: say which condition ruled everything out, because "nothing to
  // sum" cannot tell "no such department" from "no numbers there". Not when a total
  // row matched and was left out: "Department equal to Total" did match a row, and
  // reporting that no row has it contradicts the "I left out the Total row" beside it.
  let unmatched: QueryResult['unmatched'] = null;
  if (matching.length === 0 && resolvedFilters.length && summarySkipped.length === 0) {
    for (const f of resolvedFilters) {
      const any = region.rows.some((row, i) => !summary.has(i) && passes(row[f.col.i] ?? null, f) === true);
      if (!any) {
        const said = f.values?.length && (f.op === 'eq' || f.op === 'neq') ? f.values.join(' or ') : f.value;
        unmatched = { column: f.col, op: f.op, value: said ?? null };
        break;
      }
    }
  }

  const address = (dataRow: number, colIndex: number): string =>
    a1(region.firstDataRow + dataRow, region.firstCol + colIndex);

  const common = {
    summarySkipped,
    unreadable,
    unmatched,
    winners: [] as number[],
    winnerCount: 0,
    groupColumn: null,
    groupCount: 0,
    oneRowEach: false,
  };

  // ── no aggregate: return the rows themselves ────────────────────────────
  if (aggregate === 'none') {
    const page = matching.slice(offset, offset + limit);
    const cells: string[] = [];
    for (const i of page) {
      for (let c = 0; c < region.columns.length && cells.length < PROVENANCE_CELL_CAP; c++) {
        cells.push(address(i, c));
      }
    }
    return {
      ...common,
      result: null,
      matchedRows: matching.length,
      rows: page.map((i) => region.rows[i]!),
      rowIndices: page,
      groups: [],
      provenance: {
        sheet: region.sheet,
        cells,
        cellCount: page.length * region.columns.length,
        excluded: [],
      },
      moreAvailable: offset + page.length < matching.length,
      nextOffset: offset + page.length < matching.length ? offset + page.length : null,
    };
  }

  const groupKey = (i: number, col: IndexColumn): string => {
    const v = region.rows[i]![col.i] ?? null;
    return blank(v) ? '(blank)' : String(v);
  };

  // ── count needs no target column, but it does need grouping ─────────────
  //
  // This used to return before grouping was applied, so "how many by region"
  // answered with one total and no breakdown — and its provenance claimed a cell
  // count while naming no cells, which made explaining a count read as nonsense.
  // A count reads the rows it counted, so its evidence is those rows' identifying
  // cells.
  if (aggregate === 'count') {
    const identifying = region.labelColumn ?? 0;
    const countedCells = matching
      .slice(0, PROVENANCE_CELL_CAP)
      .map((i) => address(i, identifying));
    const countProvenance: Provenance = {
      sheet: region.sheet,
      cells: countedCells,
      cellCount: matching.length,
      excluded: [],
    };

    if (!spec.groupBy) {
      return {
        ...common,
        result: matching.length,
        matchedRows: matching.length,
        rows: [],
        rowIndices: [],
        groups: [],
        provenance: countProvenance,
        moreAvailable: false,
        nextOffset: null,
      };
    }

    const by = resolveColumn(region, spec.groupBy);
    const tally = new Map<string, number>();
    for (const i of matching) {
      const key = groupKey(i, by);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const all: GroupResult[] = [...tally.entries()]
      .map(([key, n]) => ({ key, value: n, rowCount: n }))
      .sort(byValue);
    const page = all.slice(offset, offset + limit);

    return {
      ...common,
      groupColumn: by,
      groupCount: all.length,
      oneRowEach: all.length > 0 && all.every((g) => g.rowCount === 1),
      result: matching.length,
      matchedRows: matching.length,
      rows: [],
      rowIndices: [],
      groups: page,
      provenance: countProvenance,
      moreAvailable: offset + page.length < all.length,
      nextOffset: offset + page.length < all.length ? offset + page.length : null,
    };
  }

  // ── numeric aggregates ──────────────────────────────────────────────────
  const numeric = region.columns.filter((c) => c.sum !== undefined);
  if (!spec.aggregateColumn) {
    const noun = { sum: 'total', avg: 'average', min: 'lowest value', max: 'highest value' }[aggregate];
    throw new QueryError(
      `A ${noun} needs to know which column to work on.`,
      numeric.length ? `Ask which column: ${nameList(numeric)}.` : 'This table has no numeric columns.',
    );
  }
  const target = resolveColumn(region, spec.aggregateColumn);
  if (target.sum === undefined) {
    // In words a listener would use: "holds category" was the type's internal name,
    // and "cannot be totalled" was said of a highest or an average as well.
    // A row-number column ("STT" over 1, 2, 3) keeps its number kind and has no total:
    // "holds number, so it cannot be totalled" said nothing a listener could follow.
    const holds = target.identifier === 'row' ? 'numbers the rows' : `holds ${KIND_WORDS[target.kind] ?? target.kind}`;
    const cannot = { sum: 'be totalled', avg: 'be averaged', min: 'have a lowest number', max: 'have a highest number' }[aggregate];
    throw new QueryError(
      `"${cleanText(columnName(target), 60)}" ${holds}, so it cannot ${cannot}.`,
      `Numeric columns here: ${nameList(numeric) || 'none'}.`,
    );
  }
  // A total of a rate is refused (below, once the rows are bucketed) rather than answered
  // with an average in its place: a host model that asked for a total and got an average
  // back may well say "the total is", and the refusal's next step is one it can act on in
  // the same turn. A caller that wants the average instead asks for it, and says to the
  // listener that it did.
  const why = aggregate === 'sum' ? noTotal(target, region) : null;

  const groupCol = spec.groupBy ? resolveColumn(region, spec.groupBy) : null;

  const excluded: ExcludedCell[] = [];
  const usedRows: number[] = [];
  const buckets = new Map<string, { values: number[]; rows: number[] }>();

  for (const i of matching) {
    const cell = region.rows[i]![target.i] ?? null;
    const n = asNumber(cell);
    const addr = address(i, target.i);
    if (n === null) {
      excluded.push({ address: addr, reason: blank(cell) ? 'empty' : `not a number ("${cleanText(String(cell), 40)}")` });
      continue;
    }
    usedRows.push(i);
    const key = groupCol ? groupKey(i, groupCol) : '';
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.values.push(n);
      bucket.rows.push(i);
    } else {
      buckets.set(key, { values: [n], rows: [i] });
    }
  }
  // Only where two or more figures would really be added together. A "total" of one
  // row's GDP per capita is that row's figure, and a sum grouped one row to a group
  // ("rank the countries by GDP per capita") adds nothing up: refused, the voice client's
  // "lower than Thailand" (Thailand's own figure, looked up first) and every one-row
  // ranking of a rate were told that "adding it up across rows gives no real total" —
  // false of a question that added nothing — and went unanswered.
  if (why && [...buckets.values()].some((b) => b.values.length > 1)) {
    throw new QueryError(
      `"${cleanText(columnName(target), 60)}" is ${why}, so adding it up across rows gives no real total.`,
      'Ask for its average, highest or lowest instead.',
    );
  }

  // Loops, not Math.min(...values): spreading a column into arguments overflows the
  // call stack somewhere past a hundred thousand rows.
  const reduce = (b: { values: readonly number[]; rows: readonly number[] }): { value: number | null; winners: number[] } => {
    const values = b.values;
    if (values.length === 0) return { value: null, winners: [] };
    if (aggregate === 'sum' || aggregate === 'avg') {
      let total = 0;
      for (const v of values) total += v;
      return { value: tidy(aggregate === 'sum' ? total : total / values.length), winners: [] };
    }
    let best = values[0]!;
    for (const v of values) if (aggregate === 'max' ? v > best : v < best) best = v;
    const winners = b.rows.filter((_, k) => values[k] === best);
    return { value: tidy(best), winners };
  };

  if (!groupCol) {
    const { value, winners } = reduce(buckets.get('') ?? { values: [], rows: [] });
    // The winning cells lead the evidence, so "how do you know" names the cell that
    // answered "which is highest" before the ones it was compared against. Membership
    // is a set and the walk stops at the cap: `includes` over twenty thousand tied rows
    // was four hundred million comparisons.
    const won = new Set(winners);
    const cells = winners.slice(0, PROVENANCE_CELL_CAP).map((i) => address(i, target.i));
    for (const i of usedRows) {
      if (cells.length >= PROVENANCE_CELL_CAP) break;
      if (!won.has(i)) cells.push(address(i, target.i));
    }
    return {
      ...common,
      winners: winners.slice(0, WINNER_CAP),
      winnerCount: winners.length,
      result: value,
      matchedRows: matching.length,
      rows: [],
      rowIndices: [],
      groups: [],
      provenance: {
        sheet: region.sheet,
        cells,
        cellCount: matching.length - excluded.length,
        excluded,
      },
      moreAvailable: false,
      nextOffset: null,
    };
  }

  const all: GroupResult[] = [...buckets.entries()]
    .map(([key, b]) => ({ key, value: reduce(b).value, rowCount: b.values.length }))
    .sort(byValue);

  const page = all.slice(offset, offset + limit);
  return {
    ...common,
    groupColumn: groupCol,
    groupCount: all.length,
    oneRowEach: all.length > 0 && all.every((g) => g.rowCount === 1),
    result: null,
    matchedRows: matching.length,
    rows: [],
    rowIndices: [],
    groups: page,
    provenance: {
      sheet: region.sheet,
      cells: usedRows.slice(0, PROVENANCE_CELL_CAP).map((i) => address(i, target.i)),
      cellCount: matching.length - excluded.length,
      excluded,
    },
    moreAvailable: offset + page.length < all.length,
    nextOffset: offset + page.length < all.length ? offset + page.length : null,
  };
}

/** The label to speak for one data row, using the region's nominated label column. */
export function rowLabel(region: IndexRegion, dataRow: number): string | null {
  if (region.labelColumn === null) return null;
  const v = region.rows[dataRow]?.[region.labelColumn] ?? null;
  return blank(v) ? null : cleanText(String(v), 80);
}
