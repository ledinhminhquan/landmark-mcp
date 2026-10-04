/**
 * Speech formatting.
 *
 * Every tool returns a `spoken` field that is safe to read aloud verbatim. Putting
 * the constraint here rather than in the model's prompt is the point: a voice product
 * whose brevity depends on the model remembering to be brief is not a voice product,
 * it is a chatbot that happens to be read out.
 *
 * The rules encoded below come from Alexa+'s published functional requirements —
 * at most five items with pagination, responses under thirty seconds, no API codes
 * or internal identifiers in anything a customer hears, and an actionable next step
 * on every error.
 *
 * Numbers get particular care, and two kinds are treated differently. A total or an
 * average is rounded to a scale a listener can hold — "about 4.2 million" — and says
 * "about" whenever the rounding changed it; the exact figure travels alongside in the
 * structured result. A single record's cell is read exactly: rounding an employee id
 * or a salary to "104.2 thousand" makes three different people sound identical.
 */

import { asNumber } from '../table/infer.ts';
import type { IndexColumn, IndexRegion } from '../indexfmt.ts';
import {
  cleanText,
  columnName,
  isGutter,
  OP_WORDS,
  readDate,
  rowLabel,
  sumCaution,
  summaryLabel,
  summaryRowsOf,
  tidy,
  type ExcludedCell,
  type GroupResult,
  type QueryResult,
} from '../query/engine.ts';

/** Roughly 30 seconds of synthesised speech at a conversational rate. */
export const SPOKEN_WORD_LIMIT = 70;
/** The tighter ceiling for a headline answer, per the tool contract. */
export const HEADLINE_WORD_LIMIT = 30;
/** The longest a single cell may run when it is read out, in characters. */
export const CELL_CHAR_LIMIT = 120;

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Trim to a word budget at a sentence boundary where possible. Truncating a spoken
 * sentence mid-clause is worse than dropping it, because the listener cannot see
 * that something was cut.
 *
 * A full stop ends a sentence only when whitespace or the end of the text follows it.
 * Splitting on every full stop treated the decimal point in "6.2 million" as a
 * sentence end, so a trimmed answer could stop at "Population 6." — a wrong number,
 * spoken with confidence.
 */
export function capWords(text: string, limit: number): string {
  if (wordCount(text) <= limit) return text;
  const out = wholeSentences(text, limit);
  if (out) return out;
  return text.split(/\s+/).slice(0, limit).join(' ') + '…';
}

/**
 * The leading whole sentences that fit a word budget, or nothing. For text that is
 * better left unsaid than cut mid-sentence, such as a note about the rest of the file.
 */
export function wholeSentences(text: string, limit: number): string {
  if (limit <= 0 || !text.trim()) return '';
  if (wordCount(text) <= limit) return text.trim();
  const sentences = text.match(/[^]+?(?:[.!?]+(?=\s|$)|$)\s*/g) ?? [text];
  let out = '';
  for (const s of sentences) {
    if (wordCount(out + s) > limit) break;
    out += s;
  }
  return out.trim();
}

/** Upper-case the first letter, for a sentence that starts with a word like "about". */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const SYMBOL: Record<string, string> = {
  currency: '',
  percent: '%',
};

const SCALES: readonly [number, string][] = [
  [1e3, 'thousand'],
  [1e6, 'million'],
  [1e9, 'billion'],
  [1e12, 'trillion'],
];

/** The spoken body of a non-negative number, and the value that body actually says. */
function scaled(abs: number): { text: string; value: number } {
  if (abs >= 10_000) {
    let k = abs >= 1e12 ? 3 : abs >= 1e9 ? 2 : abs >= 1e6 ? 1 : 0;
    let r = Math.round((abs / SCALES[k]![0]) * 10) / 10;
    // 999,950 rounds to 1000.0 thousand; say "1 million", as a person would.
    if (r >= 1000 && k < SCALES.length - 1) {
      k++;
      r = Math.round((abs / SCALES[k]![0]) * 10) / 10;
    }
    return { text: `${Number.isInteger(r) ? r : r.toFixed(1)} ${SCALES[k]![1]}`, value: r * SCALES[k]![0] };
  }
  if (Number.isInteger(abs)) return { text: String(abs), value: abs };
  if (abs >= 1) {
    const r = Math.round(abs * 100) / 100;
    return r >= 10_000 ? scaled(r) : { text: String(r), value: r };
  }
  // Below one, keep two significant digits rather than two decimal places: a rate of
  // 0.0035 rounded to two places is "0", which is a different claim, not a shorter one.
  return {
    text: abs.toLocaleString('en-US', { maximumSignificantDigits: 2 }),
    value: Number(abs.toPrecision(2)),
  };
}

/**
 * A number as a person would say it. Large values are rounded to a scale word,
 * because six digits read aloud are not retained; small and non-round values keep
 * their precision. See `speakAmount` for when that rounding must be admitted.
 */
export function speakNumber(n: number, kind = 'number'): string {
  if (!Number.isFinite(n)) return 'not a number';
  const t = tidy(n);
  const { text } = scaled(Math.abs(t));
  const sign = t < 0 ? 'minus ' : '';
  return `${sign}${text}${SYMBOL[kind] ?? ''}`;
}

/**
 * A computed figure — a total, an average, a difference — as it should be heard:
 * rounded for listening, and prefixed "about" whenever the rounding changed it.
 * "61.1 thousand" for 61,050 was spoken as though exact; 560 thousand is exact and
 * is said without a qualifier.
 */
export function speakAmount(n: number, kind = 'number'): string {
  if (!Number.isFinite(n)) return 'not a number';
  const t = tidy(n);
  const approx = tidy(scaled(Math.abs(t)).value) !== Math.abs(t);
  return `${approx ? 'about ' : ''}${speakNumber(t, kind)}`;
}

/** The exact figure, grouped, for the structured result and for anyone who asks. */
export function exactNumber(n: number): string {
  return tidy(n).toLocaleString('en-US', { maximumSignificantDigits: 15 });
}

/**
 * One record's value, read exactly. Grouping starts at five digits, where speech
 * engines need it to read "100,352,192" as one number rather than nine digits;
 * below that, grouping would turn the year 2024 into "two thousand twenty-four".
 */
function exactCell(n: number): string {
  const t = tidy(n);
  const body = Math.abs(t).toLocaleString('en-US', {
    maximumSignificantDigits: 15,
    useGrouping: Math.abs(t) >= 10_000,
  });
  return `${t < 0 ? 'minus ' : ''}${body}`;
}

/** Kinds whose values are numbers even when the file stored them as text. */
const NUMERIC_KINDS = new Set(['number', 'currency', 'percent']);

/**
 * A date as a person says it. Formatted in UTC because the index stores every date as
 * UTC midnight: formatting in the server's own zone read 4 July as "July 3" on any
 * machine west of Greenwich.
 */
export function speakDate(v: string): string | null {
  const d = readDate(v);
  if (!d) return null;
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

export function speakCell(v: string | number | boolean | null, kind = 'text'): string {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return 'empty';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';

  // A digit string with a leading zero is an identifier — a phone number, a postcode —
  // and reading it as a quantity drops the zero and rounds the rest.
  if (typeof v === 'string' && /^\s*\+?0\d/.test(v)) return cleanText(v, CELL_CHAR_LIMIT);

  if (typeof v === 'number') {
    // A number in a text column is an identifier that happened to be stored as one.
    if (!NUMERIC_KINDS.has(kind) && kind !== 'mixed') return String(v);
    return exactCell(v) + (SYMBOL[kind] ?? '');
  }

  // A CSV carries no types: every cell arrives as text, so a population column that
  // inference correctly typed as numbers still holds the string "100352192". Parsed
  // with the same reader that decided the column was numeric, so what is spoken and
  // what is counted cannot disagree. The stored cell keeps the file's own text; only
  // the reading changes.
  if (NUMERIC_KINDS.has(kind)) {
    const n = asNumber(v);
    if (n !== null) return exactCell(n) + (SYMBOL[kind] ?? '');
  }

  if (kind === 'date') {
    const d = speakDate(v);
    if (d) return d;
  }
  return cleanText(String(v), CELL_CHAR_LIMIT);
}

/**
 * A column's name as it should be heard.
 *
 * Names are stored as their header path joined with commas — "2026, Q2, Revenue" —
 * which is unambiguous on screen and unusable aloud: listing four such columns
 * produces twelve comma pauses and no way to hear where one column ends and the next
 * begins. Spoken, the path runs together as the phrase a person would say.
 */
export function speakName(name: string): string {
  return cleanText(name.replace(/,\s*/g, ' '));
}

/** "a, b and c" — spoken lists use "and", not a trailing comma. */
export function speakList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Tool summaries
// ---------------------------------------------------------------------------

/** How many column names a description reads before it says "and N more". */
const DESCRIBE_COLUMNS = 8;
/** The fewest it reads, however much else there is to say. */
const DESCRIBE_COLUMNS_MIN = 3;
/** Said after a list of columns cut short, so the listener knows how to reach the rest. */
const MORE_COLUMNS = ' Say more for the rest.';

/**
 * The names a description lists, in order: every column with a heading. A column with
 * none has no name to say, and is reached by its letter instead.
 */
export function headedColumnNames(region: IndexRegion): string[] {
  if (region.headerRows.length === 0) return [];
  return region.columns.filter((c) => c.path.length > 0).map((c) => cleanText(columnName(c), 60));
}

/** Spoken text, and where a continuation picks up: the first column name not yet said. */
export interface ColumnsSpoken {
  readonly text: string;
  readonly next: number | null;
}

/**
 * Describe a region. `after` — the file's other tables and its warnings — is appended
 * once the budget has been applied, like the uncertainty warning, because it carries
 * something the listener has no other way to learn.
 *
 * The first sentence and the column list are always said. The list used to be dropped
 * whole whenever a warning or the other tables took its room, which left a blind user
 * at the orientation step with a row count and nothing to ask about. Now it shrinks to
 * make room, never below three names and a count of the rest, and `after` is bounded
 * by whole sentences so the total stays inside the thirty-second ceiling.
 */
export function speakDescribe(region: IndexRegion, full: boolean, after = ''): string {
  return describeRegion(region, full, after).text;
}

/** A row that sums up with a statistic rather than a total: "Average", "Max", "Trung bình". */
const STATISTIC_LABEL = /\b(?:average|avg|mean|count|max|min|maximum|minimum|highest|lowest)\b|trung bình|bình quân|số lượng|cao nhất|thấp nhất|lớn nhất|nhỏ nhất/iu;

/**
 * Several of the sheet's own summary rows, as a listener should hear them: "2 total
 * rows" while every one is a total, as before; otherwise by name, "the Total and Average
 * rows", or "5 summary rows" when there are too many kinds to name. Ingest leaves
 * Average, Count, Max and Min rows out of answers as well as totals, and "I left out 2
 * total rows" called a budget's Average row a total. `the` puts the article before a
 * list of names, where the sentence needs one.
 */
function summaryRowsSaid(region: IndexRegion, rows: Iterable<number>, the: boolean): string {
  const list = [...rows];
  const labels = [...new Set(list.map((i) => summaryLabel(region, i)))];
  if (!labels.some((l) => STATISTIC_LABEL.test(l))) return `${list.length} total rows`;
  if (labels.length <= 3) return `${the ? 'the ' : ''}${speakList(labels)} rows`;
  return `${list.length} summary rows`;
}

/**
 * `speakDescribe`, with where the column list stopped.
 *
 * A forty-column sheet was described as "Store, Region, Manager, W1 … W5 and 32 more",
 * and nothing could say the other 32: "more" answered "That was all of it", and every
 * other way of asking stopped at the same eight. The cut is now a place to continue
 * from, and the list says so.
 */
export function describeRegion(region: IndexRegion, full: boolean, after = ''): ColumnsSpoken {
  const parts: string[] = [];
  const name = region.title ? `"${cleanText(region.title, 80)}"` : 'This table';
  const totals = summaryRowsOf(region);
  const records = region.rowCount - totals.size;
  const width = region.columns.filter((c) => !isGutter(c)).length;
  const first = `${name} has ${plural(records, 'row')} and ${plural(width, 'column')}.`;

  const named = headedColumnNames(region);
  const columns = (k: number): string =>
    region.headerRows.length === 0
      ? 'I am treating every row as data, with no headings.'
      : named.length === 0
        ? 'None of its columns has a heading.'
        : k < named.length
          ? `The columns are ${speakList([...named.slice(0, k), `${named.length - k} more`])}.${MORE_COLUMNS}`
          : `The columns are ${speakList(named)}.`;

  if (region.headerRows.length > 1) {
    parts.push(`They sit under ${plural(region.headerRows.length, 'level')} of headings.`);
  }

  if (totals.size === 1) {
    parts.push(`Its ${summaryLabel(region, [...totals][0]!)} row is left out of answers.`);
  } else if (totals.size > 1) {
    parts.push(`Its ${summaryRowsSaid(region, totals, false)} are left out of answers.`);
  }

  if (full) {
    const numeric = region.columns.filter((c) => c.sum !== undefined);
    // Said before the ranges, since it changes what a total means: a figure ingest could
    // not read is in no answer, and a full description was the one place a listener
    // could have learnt that, and did not.
    for (const c of numeric) {
      if (c.nonNumeric) parts.push(`${columnName(c)} has ${plural(c.nonNumeric, 'value')} I could not read as a number.`);
    }
    for (const c of region.columns.filter((x) => x.kind === 'mixed')) {
      parts.push(`${columnName(c)} mixes text and numbers, so I cannot add it up.`);
    }
    for (const c of numeric.slice(0, 3)) {
      parts.push(
        `${columnName(c)} runs from ${speakNumber(c.min!, c.kind)} to ${speakNumber(c.max!, c.kind)}.`,
      );
    }
    const gaps = region.columns.filter((c) => c.empty > 0);
    if (gaps.length) {
      parts.push(`Gaps: ${speakList(gaps.map((c) => `${columnName(c)} is missing ${c.empty}`))}.`);
    }
  }

  if (region.inherited.length) {
    parts.push(
      `${plural(region.inherited.length, 'cell')} take their label from a merged block, so they are not the blanks they look like.`,
    );
  }
  const repeated = repeatedHeadings(region);
  if (repeated) parts.push(repeated);

  // The uncertainty warning is composed last so it reads in its natural place, then
  // appended AFTER the budget is applied so length can never remove it. A listener
  // who cannot see the sheet has no other way to learn that the reading is a guess;
  // trimming that sentence to save four words would take away their only recourse.
  let warning = '';
  if (region.structure.ambiguous && region.structure.confirmedBy !== 'user') {
    const alt = region.structure.alternatives[0]?.why?.trim();
    warning =
      ` I am not certain how to read the headings${alt ? `; I could instead ${alt}` : ''}.` +
      ' Say "check the structure" if a column name sounds like data.';
  }

  // What must be said is sized against the thirty-second ceiling; what may be said
  // (heading levels, ranges, gaps) against the tighter budget of a brief answer.
  const least = Math.min(DESCRIBE_COLUMNS_MIN, named.length);
  const must = wordCount(first) + wordCount(warning);
  const tail = wholeSentences(after, SPOKEN_WORD_LIMIT - must - wordCount(columns(least)));
  let k = Math.min(DESCRIBE_COLUMNS, named.length);
  while (k > least && must + wordCount(columns(k)) + wordCount(tail) > SPOKEN_WORD_LIMIT) k--;
  const head = `${first} ${columns(k)}`;
  const budget = full ? SPOKEN_WORD_LIMIT : HEADLINE_WORD_LIMIT + 20;
  const extra = wholeSentences(parts.join(' '), budget - wordCount(head) - wordCount(warning) - wordCount(tail));
  return {
    text: (extra ? `${head} ${extra}` : head) + warning + (tail ? ` ${tail}` : ''),
    next: k < named.length ? k : null,
  };
}

/**
 * The column names after `from`, for "more" after a description cut its list short.
 *
 * As many whole names as a description reads, within a word budget, then a count of
 * the rest. Past the last name it says how many there were, never that there are none:
 * a cursor a host made up is still not a reason to tell someone a sheet is empty.
 */
export function speakColumnPage(region: IndexRegion, from: number): ColumnsSpoken {
  const named = headedColumnNames(region);
  if (named.length === 0) {
    return {
      text: region.headerRows.length === 0 ? 'This table has no headings, so its columns have no names to read.' : 'None of its columns has a heading.',
      next: null,
    };
  }
  const start = Math.max(0, from);
  if (start >= named.length) {
    return { text: named.length === 1 ? 'That was the only column.' : `That was all ${named.length} columns.`, next: null };
  }
  const said: string[] = [];
  let words = 0;
  for (const n of named.slice(start)) {
    const w = wordCount(n);
    if (said.length >= DESCRIBE_COLUMNS || (said.length > 0 && words + w > HEADLINE_WORD_LIMIT + 20)) break;
    said.push(n);
    words += w;
  }
  const end = start + said.length;
  const rest = named.length - end;
  if (rest > 0) {
    const lead = start === 0 ? 'The columns are' : 'The next columns are';
    return { text: `${lead} ${speakList([...said, `${rest} more`])}.${MORE_COLUMNS}`, next: end };
  }
  if (start === 0) return { text: `The columns are ${speakList(said)}.`, next: null };
  return {
    text: said.length === 1 ? `The last column is ${said[0]}.` : `The last columns are ${speakList(said)}.`,
    next: null,
  };
}

/**
 * What a repeated heading is called now. Ingest numbers the repeats ("Amount",
 * "Amount 2"), so the advice names the name to use; "tell me the full heading" was
 * advice with no possible answer, because both columns had the same full heading.
 */
function repeatedHeadings(region: IndexRegion): string {
  if (!region.ambiguousColumns.length) return '';
  const groups = new Map<string, IndexColumn[]>();
  for (const i of region.ambiguousColumns) {
    const c = region.columns[i];
    if (!c) continue;
    const key = c.path.join(' ').toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const sets = [...groups.values()].filter((g) => g.length > 1);
  const renamed = sets.flatMap((g) => g.slice(1)).map((c) => cleanText(columnName(c), 60));
  const first = sets[0];
  // An index built before the repeats were numbered: every copy has the same name.
  if (!first || sets.some((g) => new Set(g.map((c) => columnName(c).toLowerCase())).size < g.length)) {
    return 'Some columns share a heading, so tell me the full heading if I pick the wrong one.';
  }
  if (sets.length === 1) {
    const heading = cleanText(first[0]!.path.join(' '), 60);
    const n = first.length === 2 ? 'Two' : first.length === 3 ? 'Three' : String(first.length);
    return first.length === 2
      ? `${n} columns are headed ${heading}, so I call the second one ${renamed[0]}.`
      : `${n} columns are headed ${heading}, so I call the others ${speakList(renamed)}.`;
  }
  return `Some headings repeat, so I number the repeats: ${speakList(renamed.slice(0, 4))}.`;
}

function excludedPhrase(excluded: readonly ExcludedCell[]): string {
  if (excluded.length === 0) return '';
  const empty = excluded.filter((e) => e.reason === 'empty').length;
  const other = excluded.length - empty;
  const bits: string[] = [];
  if (empty) bits.push(`${empty} ${empty === 1 ? 'was' : 'were'} empty`);
  if (other) bits.push(`${other} did not hold ${other === 1 ? 'a number' : 'numbers'}`);
  return ` I skipped ${plural(excluded.length, 'row')}: ${speakList(bits)}.`;
}

/**
 * What an answer left out that the listener would otherwise assume it included: a
 * Total row, and rows a numeric or date condition could not read. Said once, after
 * the budget, because a total that silently skipped a row is a wrong total. `totals`
 * false leaves the Total row to a caller that says it in its own words.
 */
export function queryNotes(region: IndexRegion, q: QueryResult, totals = true): string {
  let notes = '';
  if (totals && q.summarySkipped.length === 1) {
    notes += ` I left out the ${summaryLabel(region, q.summarySkipped[0]!)} row.`;
  } else if (totals && q.summarySkipped.length > 1) {
    notes += ` I left out ${summaryRowsSaid(region, q.summarySkipped, true)}.`;
  }
  const byColumn = new Map<string, number>();
  const wanted = new Map<string, string>();
  for (const u of q.unreadable) {
    const name = columnName(u.column);
    byColumn.set(name, (byColumn.get(name) ?? 0) + 1);
    wanted.set(name, u.wanted);
  }
  for (const [name, n] of byColumn) {
    notes += ` I skipped ${plural(n, 'row')} whose ${name} was not a ${wanted.get(name)}.`;
  }
  return notes;
}

/** "no row has Department equal to Sales. Department holds Design and Engineering." */
function unmatchedPhrase(u: NonNullable<QueryResult['unmatched']>): string {
  const name = columnName(u.column);
  const what =
    u.op === 'is_empty' || u.op === 'is_not_empty'
      ? `no row has ${name} ${OP_WORDS[u.op]}`
      : `no row has ${name} ${OP_WORDS[u.op]} ${cleanText(u.value ?? '', 40)}`;
  const cats = u.column.categories ?? [];
  const offer =
    cats.length && (u.op === 'eq' || u.op === 'contains')
      ? ` ${name} holds ${speakList(
          cats.length > 6
            ? [...cats.slice(0, 6).map((c) => cleanText(c, 40)), `${cats.length - 6} more`]
            : cats.map((c) => cleanText(c, 40)),
        )}.`
      : '';
  return `${what}.${offer}`;
}

/**
 * A group's key as a listener should hear it: dates as dates, never ISO strings. A
 * date loses its own comma here, because "July 4, 2026, 1 row, July 19, 2026, 1 row"
 * gives the ear no way to tell where one group ends.
 */
function groupName(key: string, col: IndexColumn | null): string {
  if (key === '(blank)') return 'blank';
  if (!key) return 'unlabelled';
  if (col?.kind === 'date') return speakCell(key, 'date').replace(/,/g, '');
  if (col && NUMERIC_KINDS.has(col.kind)) return speakCell(key, col.kind);
  return cleanText(key, 60);
}

/**
 * When the only rows a question matched are the sheet's own total rows. They are left
 * out of every answer, so there is nothing to give; saying "no row has Department
 * equal to Total" beside "I left out the Total row" contradicted itself, when the
 * truth is that the Total row matched and can be read.
 */
function onlyTotals(region: IndexRegion, q: QueryResult): string {
  const rows = q.summarySkipped;
  if (rows.length === 1) {
    return (
      `The only row that matches is the sheet's own ${summaryLabel(region, rows[0]!)} row, which I leave out of answers.` +
      ` To hear it, ask me to read row ${rows[0]! + 1}.`
    );
  }
  return (
    `The only rows that match are the sheet's own ${summaryRowsSaid(region, rows, false)}, which I leave out of answers.` +
    ` To hear them, ask me to read from row ${rows[0]! + 1}.`
  );
}

/**
 * ", for Norway" — the record that holds a highest or lowest value. `count` is how many
 * rows hold it, which can be far more than the labels kept.
 */
export function winnerPhrase(labels: readonly string[], count = labels.length): string {
  if (!labels.length || count < 1) return '';
  if (count === 1) return `, for ${labels[0]}`;
  if (count === 2 && labels.length >= 2) return `, for ${labels[0]} and ${labels[1]}`;
  return `, for ${labels[0]} and ${count - 1} others`;
}

/** Labels for the winning rows, falling back to the sheet row number. */
export function winnerLabels(region: IndexRegion, rows: readonly number[]): string[] {
  return rows.map((i) => rowLabel(region, i) ?? `row ${region.firstDataRow + i + 1}`);
}

/** `from` is where this page of a breakdown starts among all its groups: 0, or a cursor. */
type SpokenSpec = { aggregate?: string; aggregateColumn?: string; groupBy?: string; order?: 'desc' | 'asc'; from?: number };

/**
 * A breakdown's groups, as many whole as fit the budget, and how many that was.
 *
 * The groups used to be joined and then trimmed as one text, so a page of long supplier
 * names stopped mid-list — "Northern Regional Supply Company Number 16, 2301,…" — lost
 * "Say more for the rest", and the cursor skipped the groups never heard. Each group is
 * now said whole or left for the next page, like rows.
 *
 * A total or a count per group is the breakdown people expect and is said as a list. A
 * highest, lowest or average per group is named first ("Highest Revenue: South, 21
 * thousand, …"), because without it those figures sound like totals.
 */
export function fitGroups(
  target: IndexColumn | null,
  spec: SpokenSpec,
  q: QueryResult,
  budget = SPOKEN_WORD_LIMIT,
): { text: string; count: number; more: boolean } {
  const agg = spec.aggregate ?? 'none';
  const name = target ? columnName(target) : 'that column';
  const what = agg === 'max' ? `Highest ${name}` : agg === 'min' ? `Lowest ${name}` : agg === 'avg' ? `Average ${name}` : '';
  // Largest first is what a breakdown is heard as; the other way round is said, or
  // "Design, 234 thousand and Engineering, 560 thousand" sounds like the top spender.
  // Decided by the whole breakdown, not this page: the last page of a lowest-first
  // ranking may hold one group, and was led "Lowest GDP per capita: Norway" — the
  // highest of them all, introduced as the lowest.
  const asc = spec.order === 'asc' && Math.max(q.groupCount, q.groups.length) > 1;
  // A later page goes on from one already heard, which said the order. Said again over
  // the largest figures, "lowest first" sounded as though they were the lowest.
  const later = (spec.from ?? 0) > 0;
  // One row to each group ("rank the countries from lowest to highest"): each figure is
  // that row's own value, so the column is named on its own. "Highest GDP per capita,
  // lowest first" told the listener two opposite things about one list, and "Highest
  // GDP per capita: Peru, …" on a second page called the middle of the list its top.
  const plain = q.oneRowEach && what !== '' && (asc || later);
  const order = asc && !later ? ', lowest first' : '';
  const lead = plain
    ? `${name}${order}: `
    : what
      ? `${what}${order}: `
      : order
        ? 'Lowest first: '
        : '';
  const items = q.groups.map((g) =>
    agg === 'count'
      ? `${groupName(g.key, q.groupColumn)}, ${plural(g.value ?? 0, 'row')}`
      : `${groupName(g.key, q.groupColumn)}, ${g.value === null ? 'nothing' : speakAmount(g.value, target?.kind)}`,
  );
  const rest = ' Say more for the rest.';
  let used = wordCount(lead) + wordCount(rest);
  const kept: string[] = [];
  for (const item of items) {
    const w = wordCount(item) + 1;
    if (kept.length && used + w > budget) break;
    kept.push(item);
    used += w;
  }
  const more = q.moreAvailable || kept.length < items.length;
  return { text: `${lead}${speakList(kept)}.${more ? rest : ''}`, count: kept.length, more };
}

/**
 * A computed figure as an answer says it. Over one row the answer is that row's cell,
 * and is read exactly, like any cell: "about 88 thousand" for Norway's 87,962 rounded a
 * figure nobody had to add up.
 */
function spokenFigure(value: number, counted: number, target: IndexColumn | null): string {
  return counted === 1 ? exactCell(value) + (SYMBOL[target?.kind ?? ''] ?? '') : speakAmount(value, target?.kind);
}

/**
 * What an answer was, in a few words: "690 thousand, the total of Amount for Salaries".
 *
 * Kept with the answer's working, so an explanation asked for after other questions
 * can say which answer it is about. "How do you know" after a refused question used to
 * read back the cells of the answer before it, and nothing in the reply said so: the
 * listener heard cells for a question those cells had nothing to do with. `conditions`
 * is the rows it covered, as " for Salaries", or empty.
 */
export function answerAbout(spec: SpokenSpec, target: IndexColumn | null, q: QueryResult, conditions = ''): string {
  const agg = spec.aggregate ?? 'none';
  const by = q.groupColumn ? ` by ${columnName(q.groupColumn)}` : '';
  if (agg === 'none') return conditions ? `the rows${conditions}` : 'the rows I read';
  if (agg === 'count') {
    return by ? `the count of rows${by}${conditions}` : `the count of ${plural(q.result ?? 0, 'row')}${conditions}`;
  }
  const name = target ? columnName(target) : 'that column';
  const what =
    agg === 'sum' ? `the total of ${name}` : agg === 'avg' ? `the average of ${name}` : agg === 'max' ? `the highest ${name}` : `the lowest ${name}`;
  if (by || q.result === null) return `${what}${by}${conditions}`;
  return `${spokenFigure(q.result, q.provenance.cellCount, target)}, ${what}${conditions}`;
}

export function speakQuery(
  region: IndexRegion,
  spec: SpokenSpec,
  target: IndexColumn | null,
  q: QueryResult,
): string {
  const agg = spec.aggregate ?? 'none';
  const notes = queryNotes(region, q);

  if (q.matchedRows === 0 && q.summarySkipped.length) {
    return capWords(onlyTotals(region, q), SPOKEN_WORD_LIMIT) + queryNotes(region, q, false);
  }

  if (agg === 'count') {
    // A grouped count answers "how many in each", which is a different sentence from
    // a single total and was previously collapsed into one.
    if (q.groups.length) return fitGroups(target, spec, q).text + notes;
    if (q.matchedRows === 0 && q.unmatched) {
      return capWords(`No rows match: ${unmatchedPhrase(q.unmatched)}`, HEADLINE_WORD_LIMIT + 10) + notes;
    }
    return (
      capWords(`${plural(q.result ?? 0, 'row')} ${(q.result ?? 0) === 1 ? 'matches' : 'match'}.`, HEADLINE_WORD_LIMIT) +
      notes
    );
  }

  const name = target ? columnName(target) : 'that column';

  if (q.groups.length) return fitGroups(target, spec, q).text + notes;

  if (agg !== 'none') {
    const noun = agg === 'sum' ? 'total' : agg === 'avg' ? 'average' : agg === 'max' ? 'highest value' : 'lowest value';
    if (q.result === null) {
      // "No such department" and "no numbers there" are different answers, and the
      // listener needs to know which one they got.
      if (q.matchedRows === 0) {
        return capWords(
          q.unmatched
            ? `There is no ${noun}: ${unmatchedPhrase(q.unmatched)}`
            : `There is no ${noun}: no row matches all of those conditions.`,
          HEADLINE_WORD_LIMIT + 10,
        ) + notes;
      }
      return capWords(
        `There is no ${noun}. No matching row held a number in ${name}.`,
        HEADLINE_WORD_LIMIT,
      ) + notes;
    }
    const verb =
      agg === 'sum' ? 'the total of' : agg === 'avg' ? 'the average of' : agg === 'max' ? 'the highest' : 'the lowest';
    const who = agg === 'max' || agg === 'min' ? winnerPhrase(winnerLabels(region, q.winners), q.winnerCount) : '';
    const counted = q.provenance.cellCount;
    // A total of figures that are each already an average, or per person, may or may not
    // be a real one: it is given, as asked, with what was added up said plainly.
    const caution = agg === 'sum' && counted > 1 && target ? sumCaution(target, region) : null;
    const base = caution
      ? `${sentence(spokenFigure(q.result, counted, target))}. That adds up ${name} across ${plural(counted, 'row')}, each of them ${caution.replace(/^already /, '')}.`
      : `${sentence(spokenFigure(q.result, counted, target))}${who}. That is ${verb} ${name} across ${plural(counted, 'row')}.`;
    return capWords(base + excludedPhrase(q.provenance.excluded), SPOKEN_WORD_LIMIT) + notes;
  }

  // Plain row listing. The rows themselves are spoken by the query tool, which knows
  // the word budget and the cursor; this covers the case where there are none.
  if (q.matchedRows === 0) {
    return (q.unmatched ? `No rows match: ${unmatchedPhrase(q.unmatched)}` : 'No rows match that.') + notes;
  }
  const shown = q.rows.length;
  const head =
    shown === 0
      ? `${plural(q.matchedRows, 'row')} ${q.matchedRows === 1 ? 'matches' : 'match'}, and I have read them all.`
      : q.matchedRows === shown
        ? `${plural(shown, 'row')}.`
        : `${plural(q.matchedRows, 'row')} match. Here are the first ${shown}.`;
  return capWords(head, HEADLINE_WORD_LIMIT) + notes;
}

export interface ExplainPart {
  readonly label: string;
  readonly sheet: string;
  /** Every stored cell, in evidence order — for a highest value, the winner first. */
  readonly cells: readonly string[];
  readonly totalCells: number;
  readonly path: readonly string[];
  readonly excluded: readonly ExcludedCell[];
  /** What the answer computed; changes what the cells are evidence of. */
  readonly aggregate?: string;
  /** For a highest or lowest value: the winning cells and the rows they belong to. */
  readonly winners?: readonly string[];
  readonly winnerLabels?: readonly string[];
  /** How many rows hold that value; more than `winners` keeps when many are tied. */
  readonly winnerCount?: number;
  /** At most this many runs of cells are named aloud. */
  readonly limit?: number;
}

function parseAddress(a: string): { col: string; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(a);
  return m ? { col: m[1]!, row: Number(m[2]) } : null;
}

/**
 * Name cells aloud without claiming more than is true.
 *
 * "C3 through C11" for C3, C5, C7, C9 and C11 told a listener checking the number to
 * add up the rows in between as well. Only a run of cells that really are adjacent is
 * spoken as a range; anything else is listed, and `named` says how many cells the
 * words actually cover, so "I am naming X of Y" is true of what was said.
 */
export function speakCellRuns(cells: readonly string[], maxItems: number): { text: string; named: number } {
  const runs: string[][] = [];
  for (const c of cells) {
    const here = parseAddress(c);
    const run = runs[runs.length - 1];
    const prev = run ? parseAddress(run[run.length - 1]!) : null;
    if (run && here && prev && here.col === prev.col && here.row === prev.row + 1) run.push(c);
    else runs.push([c]);
  }
  const shown = runs.slice(0, Math.max(1, maxItems));
  const items = shown.map((r) => (r.length > 1 ? `${r[0]} through ${r[r.length - 1]}` : r[0]!));
  return { text: speakList(items), named: shown.reduce((n, r) => n + r.length, 0) };
}

/** Sheet rows named by the cells of a row listing: "rows 2, 3 and 5". */
function speakRowRuns(cells: readonly string[], maxItems: number): { text: string; rows: number } {
  const rows = [...new Set(cells.map((c) => parseAddress(c)?.row).filter((r): r is number => r !== undefined))];
  const runs: number[][] = [];
  for (const r of rows) {
    const run = runs[runs.length - 1];
    if (run && r === run[run.length - 1]! + 1) run.push(r);
    else runs.push([r]);
  }
  const shown = runs.slice(0, Math.max(1, maxItems));
  const items = shown.map((r) => (r.length > 1 ? `${r[0]} through ${r[r.length - 1]}` : String(r[0])));
  const count = shown.reduce((n, r) => n + r.length, 0);
  return { text: `${count === 1 ? 'row' : 'rows'} ${speakList(items)}`, rows: count };
}

/**
 * Read back where an answer came from, one operand at a time.
 *
 * A comparison has two sides, on possibly different sheets, under different
 * headings. Speaking them as one pooled range forces a single heading onto both and
 * misnames half the evidence — which defeats the only mechanism a listener has for
 * checking a number they cannot see.
 */
export function speakExplain(parts: readonly ExplainPart[], budget = SPOKEN_WORD_LIMIT): string {
  if (parts.length === 0 || parts.every((p) => p.totalCells === 0)) {
    return 'That answer did not read any cells — it came from the row count alone.';
  }

  const describe = (p: ExplainPart, named: boolean): string => {
    const limit = p.limit ?? 5;
    const label = speakName(p.label);
    const sheet = cleanText(p.sheet, 60);
    const heading = p.path.length ? speakName(p.path.join(', ')) : '';
    const skipped = p.excluded.length
      ? ` ${plural(p.excluded.length, 'cell')} did not count: ${speakList(p.excluded.slice(0, 3).map((e) => `${e.address} ${e.reason}`))}.`
      : '';

    // A row listing: the evidence is the rows, and naming every cell of each would
    // spend the whole budget on coordinates.
    if (p.aggregate === 'none') {
      const r = speakRowRuns(p.cells, limit);
      const lead = named ? `${label} came from` : 'Those were';
      return `${lead} ${r.text} on ${sheet}.`;
    }

    // A count's cells are the rows' identifying cells, not the column a caller
    // happened to name, so they are described as what they are.
    if (p.aggregate === 'count') {
      const { text, named: n } = speakCellRuns(p.cells, limit);
      const shown = p.totalCells > n ? ` I am naming ${n} of ${p.totalCells}.` : '';
      const lead = named ? `${label} counted` : 'That counted';
      return `${lead} ${plural(p.totalCells, 'row')}: ${text} on ${sheet}${heading ? `, in the ${heading} column` : ''}.${shown}`;
    }

    // A highest or lowest value came from one cell. Name it first, with its row, then
    // the cells it was compared against — sorted, so a contiguous column reads as one
    // range rather than the winner followed by a list.
    if ((p.aggregate === 'max' || p.aggregate === 'min') && p.winners?.length) {
      const which = p.aggregate === 'max' ? 'highest' : 'lowest';
      const count = Math.max(p.winnerCount ?? 0, p.winners.length);
      const first = p.winners.slice(0, 3);
      const win = speakList(count > first.length ? [...first, `${count - first.length} more`] : first);
      const who = winnerPhrase(p.winnerLabels ?? [], count);
      const sorted = [...p.cells].sort((a, b) => {
        const x = parseAddress(a);
        const y = parseAddress(b);
        return x && y ? x.col.localeCompare(y.col) || x.row - y.row : 0;
      });
      const { text, named: n } = speakCellRuns(sorted, limit);
      const shown = p.totalCells > n ? ` I am naming ${n} of ${p.totalCells}.` : '';
      const lead = named ? `${label} came from` : 'That came from';
      const what = !named && heading ? ` Each one is ${heading}.` : '';
      return `${lead} ${win} on ${sheet}${who}, the ${which} of ${plural(p.totalCells, 'cell')}: ${text}.${what}${skipped}${shown}`;
    }

    const { text, named: n } = speakCellRuns(p.cells, limit);
    const range = text || 'one cell';
    const lead = named ? `${label} came from ${range} on ${sheet}` : `That came from ${range} on ${sheet}`;
    const what = !named && heading ? `. Each one is ${heading}.` : '.';
    const shown = p.totalCells > n ? ` I am naming ${n} of ${p.totalCells}.` : '';
    return lead + what + skipped + shown;
  };

  // One operand reads as a statement; several are named so the listener can tell
  // which set of cells belongs to which measure.
  const text =
    parts.length === 1
      ? describe(parts[0]!, false)
      : parts.map((p) => describe(p, true)).join(' ');

  return capWords(text, budget);
}

/**
 * Errors are spoken too, so they follow the same contract: say what went wrong in
 * plain words, then say what to do about it. Never surface a tool name, a field name
 * or an identifier — the listener did not choose them and cannot act on them.
 *
 * The two are budgeted separately. Capped as one text, a long next step was the
 * sentence that went, and the listener heard what was wrong with nothing to do about it.
 */
export function speakError(message: string, nextStep: string): string {
  const clean = (s: string) =>
    cleanText(s)
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\btable_[a-z_]+\b/g, 'that')
      .replace(/\b[a-z_]+_id\b/g, 'identifier')
      .trim();
  const limit = HEADLINE_WORD_LIMIT + 10;
  const next = clean(nextStep);
  const said = capWords(clean(message), Math.max(12, limit - wordCount(next)));
  return `${said} ${capWords(next, Math.max(12, limit - wordCount(said)))}`.trim();
}
