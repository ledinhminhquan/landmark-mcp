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
 * Numbers get particular care. "4,238,914" read digit by digit is unusable; a person
 * asking for a total wants "about 4.2 million" and can ask for the exact figure.
 */

import type { IndexColumn, IndexRegion } from '../indexfmt.ts';
import type { ExcludedCell, GroupResult, QueryResult } from '../query/engine.ts';

/** Roughly 30 seconds of synthesised speech at a conversational rate. */
export const SPOKEN_WORD_LIMIT = 70;
/** The tighter ceiling for a headline answer, per the tool contract. */
export const HEADLINE_WORD_LIMIT = 30;

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Trim to a word budget at a sentence boundary where possible. Truncating a spoken
 * sentence mid-clause is worse than dropping it, because the listener cannot see
 * that something was cut.
 */
export function capWords(text: string, limit: number): string {
  if (wordCount(text) <= limit) return text;
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
  let out = '';
  for (const s of sentences) {
    if (wordCount(out + s) > limit) break;
    out += s;
  }
  if (out.trim()) return out.trim();
  return text.split(/\s+/).slice(0, limit).join(' ') + '…';
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const SYMBOL: Record<string, string> = {
  currency: '',
  percent: '%',
};

/**
 * A number as a person would say it. Large values are rounded to a scale word,
 * because six digits read aloud are not retained; small and non-round values keep
 * their precision.
 */
export function speakNumber(n: number, kind = 'number'): string {
  if (!Number.isFinite(n)) return 'not a number';
  const abs = Math.abs(n);
  const sign = n < 0 ? 'minus ' : '';

  const scaled = (v: number, word: string): string => {
    const r = Math.round(v * 10) / 10;
    return `${Number.isInteger(r) ? r : r.toFixed(1)} ${word}`;
  };

  let body: string;
  if (abs >= 1_000_000_000) body = scaled(abs / 1_000_000_000, 'billion');
  else if (abs >= 1_000_000) body = scaled(abs / 1_000_000, 'million');
  else if (abs >= 10_000) body = scaled(abs / 1_000, 'thousand');
  else if (Number.isInteger(abs)) body = String(abs);
  else body = String(Math.round(abs * 100) / 100);

  const suffix = SYMBOL[kind] ?? '';
  return `${sign}${body}${suffix}`;
}

/** The exact figure, grouped, for when someone asks to hear it precisely. */
export function exactNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2);
}

export function speakCell(v: string | number | boolean | null, kind = 'text'): string {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return 'empty';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return speakNumber(v, kind);
  if (kind === 'date') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }
  }
  return String(v);
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

export function speakDescribe(region: IndexRegion, full: boolean): string {
  const parts: string[] = [];
  const name = region.title ? `"${region.title}"` : 'This table';
  parts.push(`${name} has ${plural(region.rowCount, 'row')} and ${plural(region.columns.length, 'column')}.`);

  if (region.headerRows.length === 0) {
    parts.push('I am treating every row as data, with no headings.');
  } else {
    const named = region.columns.filter((c) => c.path.length > 0);
    parts.push(`The columns are ${speakList(named.map((c) => c.spoken))}.`);
    if (region.headerRows.length > 1) {
      parts.push(`They sit under ${plural(region.headerRows.length, 'level')} of headings.`);
    }
  }

  if (full) {
    const numeric = region.columns.filter((c) => c.sum !== undefined);
    for (const c of numeric.slice(0, 3)) {
      parts.push(
        `${c.spoken} runs from ${speakNumber(c.min!, c.kind)} to ${speakNumber(c.max!, c.kind)}.`,
      );
    }
    const gaps = region.columns.filter((c) => c.empty > 0);
    if (gaps.length) {
      parts.push(`Gaps: ${speakList(gaps.map((c) => `${c.spoken} is missing ${c.empty}`))}.`);
    }
  }

  if (region.inherited.length) {
    parts.push(
      `${plural(region.inherited.length, 'cell')} take their label from a merged block, so they are not the blanks they look like.`,
    );
  }
  if (region.ambiguousColumns.length) {
    parts.push('Some columns share a heading, so tell me the full heading if I pick the wrong one.');
  }

  // The uncertainty warning is composed last so it reads in its natural place, then
  // appended AFTER the budget is applied so length can never remove it. A listener
  // who cannot see the sheet has no other way to learn that the reading is a guess;
  // trimming that sentence to save four words would take away their only recourse.
  let warning = '';
  if (region.structure.ambiguous) {
    const alt = region.structure.alternatives[0];
    warning =
      ` I am not certain how to read the headings${alt ? `; I could instead ${alt.why}` : ''}.` +
      ' Say "check the structure" if a column name sounds like data.';
  }

  const budget = full ? SPOKEN_WORD_LIMIT : HEADLINE_WORD_LIMIT + 20;
  return capWords(parts.join(' '), Math.max(8, budget - wordCount(warning))) + warning;
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

export function speakQuery(
  region: IndexRegion,
  spec: { aggregate?: string; aggregateColumn?: string; groupBy?: string },
  target: IndexColumn | null,
  q: QueryResult,
): string {
  const agg = spec.aggregate ?? 'none';

  if (agg === 'count') {
    return capWords(
      `${plural(q.result ?? 0, 'row')} ${(q.result ?? 0) === 1 ? 'matches' : 'match'}.`,
      HEADLINE_WORD_LIMIT,
    );
  }

  if (q.groups.length) {
    const named = q.groups.map(
      (g: GroupResult) => `${g.key || 'unlabelled'}, ${g.value === null ? 'nothing' : speakNumber(g.value, target?.kind)}`,
    );
    const head = `${speakList(named)}.`;
    const more = q.moreAvailable ? ' Say more for the rest.' : '';
    return capWords(head + more, SPOKEN_WORD_LIMIT);
  }

  if (agg !== 'none') {
    if (q.result === null) {
      return capWords(
        `Nothing to ${agg === 'avg' ? 'average' : agg}. No matching row held a number in ${target?.spoken ?? 'that column'}.`,
        HEADLINE_WORD_LIMIT,
      );
    }
    const verb =
      agg === 'sum' ? 'the total of' : agg === 'avg' ? 'the average of' : `the ${agg} of`;
    const counted = q.provenance.cellCount;
    const base = `${speakNumber(q.result, target?.kind)}. That is ${verb} ${target?.spoken ?? 'that column'} across ${plural(counted, 'row')}.`;
    return capWords(base + excludedPhrase(q.provenance.excluded), SPOKEN_WORD_LIMIT);
  }

  // Plain row listing.
  if (q.matchedRows === 0) {
    return 'No rows match that.';
  }
  const shown = q.rows.length;
  const head =
    q.matchedRows === shown
      ? `${plural(shown, 'row')}.`
      : `${plural(q.matchedRows, 'row')} match. Here are the first ${shown}.`;
  return capWords(head, HEADLINE_WORD_LIMIT);
}

export function speakExplain(
  cells: readonly string[],
  totalCells: number,
  path: readonly string[],
  excluded: readonly ExcludedCell[],
  sheet: string,
): string {
  if (totalCells === 0) {
    return 'That answer did not read any cells — it came from the row count alone.';
  }
  const range =
    cells.length > 1
      ? `${cells[0]} through ${cells[cells.length - 1]}`
      : (cells[0] ?? 'one cell');
  const what = path.length ? ` Each one is ${path.join(', ')}.` : '';
  const skipped = excluded.length
    ? ` ${plural(excluded.length, 'cell')} did not count: ${speakList(excluded.slice(0, 5).map((e) => `${e.address} ${e.reason}`))}.`
    : '';
  const shown =
    totalCells > cells.length ? ` I am naming ${cells.length} of ${totalCells}.` : '';
  return capWords(
    `That came from ${range} on ${sheet}.${what}${skipped}${shown}`,
    SPOKEN_WORD_LIMIT,
  );
}

/**
 * Errors are spoken too, so they follow the same contract: say what went wrong in
 * plain words, then say what to do about it. Never surface a tool name, a field name
 * or an identifier — the listener did not choose them and cannot act on them.
 */
export function speakError(message: string, nextStep: string): string {
  const clean = (s: string) =>
    s
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\btable_[a-z_]+\b/g, 'that')
      .replace(/\b[a-z_]+_id\b/g, 'identifier')
      .trim();
  return capWords(`${clean(message)} ${clean(nextStep)}`.replace(/\s+/g, ' '), HEADLINE_WORD_LIMIT + 10);
}
