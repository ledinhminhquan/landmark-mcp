/**
 * The tool surface.
 *
 * Nine tools, not nineteen. There is no `get_cell`, no `get_row`, no `get_column` —
 * those would rebuild the cell-by-cell maze in tool form and hand the traversal
 * problem to the model instead of solving it.
 *
 * Treat every description string below as UX copy. It is the only instruction the
 * model gets about when to reach for a tool and how to speak the result, and on a
 * voice product that makes it interface design rather than documentation.
 *
 * Alexa+'s functional requirements are encoded structurally rather than requested
 * politely: at most five items with a continuation token, responses inside a thirty
 * second budget, no identifiers or tool names in anything spoken, and an actionable
 * next step on every error.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { IndexColumn, IndexRegion, IndexTable, LandmarkIndex } from '../indexfmt.ts';
import {
  cleanText,
  columnName,
  matchColumns,
  OP_WORDS,
  QueryError,
  noTotal,
  rateLike,
  resolveColumn,
  rowLabel,
  runQuery,
  summaryLabel,
  summaryRowsOf,
  tidy,
  type Aggregate,
  type FilterOp,
} from '../query/engine.ts';
import {
  answerAbout,
  capWords,
  describeRegion,
  exactNumber,
  fitGroups,
  plural,
  queryNotes,
  speakAmount,
  speakCell,
  speakColumnPage,
  speakError,
  speakExplain,
  speakList,
  speakName,
  speakQuery,
  winnerLabels,
  wordCount,
  HEADLINE_WORD_LIMIT,
  SPOKEN_WORD_LIMIT,
} from '../voice/speak.ts';
import type { AnswerPart, Store, StoredAnswer } from './store.ts';
import { materialise, type Materialised } from '../table/materialise.ts';
import { MAX_HEADER_ROWS } from '../table/header.ts';
import { EXPLAIN_UI_URI, uiMeta } from './widget.ts';

const PAGE = 5;

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

type Structured = Record<string, unknown>;

/**
 * Every success returns structured content plus the same payload serialised into a
 * text block — the spec asks for the mirror so clients without structured-content
 * support still see the result.
 *
 * `widgetOnly` names fields that exist for the explain widget alone. They stay in
 * `structuredContent`, which is what a host hands the widget, and are left out of the
 * text mirror, which every host puts in front of the model: a forty-row grid is five
 * thousand tokens of cells the model has no use for and might be tempted to read out.
 */
function ok(spoken: string, extra: Structured = {}, widgetOnly: readonly string[] = []) {
  const payload = { spoken, ...extra };
  const mirror = widgetOnly.length
    ? Object.fromEntries(Object.entries(payload).filter(([k]) => !widgetOnly.includes(k)))
    : payload;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(mirror) }],
    structuredContent: payload,
  };
}

/**
 * Failures are spoken too. Two lines, always: what happened, then what to do about
 * it. `isError` marks it for the protocol; the `spoken` field is what reaches a
 * listener, and it never contains a tool name, a field name or an id.
 */
function fail(message: string, nextStep: string) {
  const spoken = speakError(message, nextStep);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ spoken, error: message, next_step: nextStep }) }],
    structuredContent: { spoken, error: message, next_step: nextStep },
  };
}

type ToolResult = ReturnType<typeof ok> | ReturnType<typeof fail>;

function guard<T>(fn: () => T): T | ReturnType<typeof fail> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof QueryError) return fail(e.message, e.nextStep);
    throw e;
  }
}
function isFailure(v: unknown): v is ReturnType<typeof fail> {
  return typeof v === 'object' && v !== null && 'isError' in v;
}

/**
 * Wrap a handler so nothing it throws reaches a listener raw.
 *
 * An exception used to surface as its own message — a KV error code, a stack-shaped
 * sentence — in a product whose only output is speech. A QueryError already carries a
 * spoken sentence and a next step; anything else is a fault on this side, said as one
 * in plain words, with the detail kept for the log where someone can act on it.
 */
function safe<A>(doing: string, fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof QueryError) return fail(e.message, e.nextStep);
      console.error(`landmark: failed while ${doing}`, e);
      return fail(`Something went wrong on my side while ${doing}.`, 'Try that again, or ask it a different way.');
    }
  };
}

/**
 * An answer's working, plus what the answer was in a few words — "690 thousand, the
 * total of Amount for Salaries" — so an explanation asked for after other questions can
 * say which answer it is about. Carried beside the stored fields, the way an index
 * carries `summaryRows`: every store keeps the record whole, and an answer kept before
 * this existed simply has none, and is described from its parts instead.
 */
type Kept = StoredAnswer & { readonly about?: string };

/** Room for a measure, its figure and a condition or two, not twenty values said in full. */
const ABOUT_CHARS = 120;

/**
 * Keep an answer's working, or say it could not be kept.
 *
 * The answer has already been computed; failing to file its working — a Durable Object
 * over its daily write quota, or briefly unavailable — used to throw the answer away as
 * well, and a question answered a moment earlier came back "Something went wrong". The
 * answer is given without an id instead, and "how do you know" says the working is gone.
 */
async function keepAnswer(store: Store, answer: Kept): Promise<string | null> {
  try {
    return await store.putAnswer(answer);
  } catch (e) {
    console.error('landmark: could not keep the working for an answer; answering without it', e);
    return null;
  }
}

/** Bounded text input: long enough for any real name, too short to carry a payload. */
const text = (max = 200) => z.string().max(max);

/**
 * Where a continuation token says to pick up: never before the start, never past `end`.
 *
 * Tokens are this server's own, but a host model can make one up, or count on from one
 * by itself. "-3" was handed back as "-3", so a host that followed it asked for the same
 * page forever, and a listing said "Rows -2 to 2 of 8".
 */
function pageOffset(cursor: string | undefined, end = Number.POSITIVE_INFINITY): number {
  const n = Number.parseInt(cursor ?? '0', 10);
  return Number.isFinite(n) ? Math.min(Math.max(0, n), end) : 0;
}

/**
 * A continuation token that is really there. Some hosts fill every optional string with
 * "", and some copy the last call's arguments whole; neither is a request to read on.
 */
function continuing(cursor: string | undefined): cursor is string {
  return cursor !== undefined && cursor.trim() !== '';
}

const SHEET_HELP =
  'Sheet name, or a table number such as "2" when the file holds several tables (the describe ' +
  'tool lists them under regions), or a region id from that list. Omit for the first table.';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

interface Located {
  readonly table: IndexTable;
  readonly region: IndexRegion;
  /** 1-based position of the region in its file, as it is spoken: "table 2". */
  readonly n: number;
  /**
   * How the region was chosen. Only a missing `sheet` or a sheet name leaves the
   * choice to this code — a sheet holding three tables answers with its first — so
   * only those warrant saying that other tables were not looked at.
   */
  readonly by: 'default' | 'id' | 'sheet' | 'title' | 'number';
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** "2", "table 2", "the second table", "table two", "2nd" → 2. Anything else → null. */
function tableNumber(s: string): number | null {
  let t = s.trim().toLowerCase().replace(/^the\s+/, '');
  t = t.replace(/^(?:table|block|region|number|no\.?|#)\s*/, '').replace(/\s+(?:table|block|region|one)$/, '');
  if (/^\d+$/.test(t)) return Number(t);
  const suffixed = /^(\d+)(?:st|nd|rd|th)$/.exec(t);
  if (suffixed) return Number(suffixed[1]);
  const ord = ORDINALS.indexOf(t);
  if (ord >= 0) return ord + 1;
  const word = NUMBER_WORDS.indexOf(t);
  return word >= 0 ? word + 1 : null;
}

function locate(index: LandmarkIndex, tableId: string, sheet?: string): Located {
  const want = tableId.trim().toLowerCase();
  const table =
    index.tables.find((t) => t.id.toLowerCase() === want) ??
    index.tables.find((t) => t.title.toLowerCase() === want) ??
    (want ? index.tables.find((t) => t.id.toLowerCase().includes(want)) : undefined);

  if (!table) {
    throw new QueryError(
      `I do not have a table called "${cleanText(tableId, 60)}".`,
      index.tables.length
        ? `Available: ${speakList(index.tables.slice(0, 8).map((t) => cleanText(t.title, 60)))}.`
        : 'No tables have been loaded yet.',
    );
  }
  if (table.regions.length === 0) {
    throw new QueryError(`"${cleanText(table.title, 60)}" has no readable tables in it.`, 'Try another file.');
  }

  if (!sheet || !sheet.trim()) return { table, region: table.regions[0]!, n: 1, by: 'default' };

  // A file with several tables used to expose only the first on each sheet: the
  // region ids that reach the others were never returned, and "table 2" matched
  // nothing. Ids, sheet names and titles are tried first, then a spoken number.
  const s = sheet.trim().toLowerCase();
  let by: Located['by'] = 'id';
  let i = table.regions.findIndex((r) => r.id.toLowerCase() === s);
  if (i < 0) {
    by = 'sheet';
    i = table.regions.findIndex((r) => r.sheet.toLowerCase() === s);
  }
  if (i < 0) {
    by = 'title';
    i = table.regions.findIndex((r) => (r.title ?? '').toLowerCase() === s);
  }
  if (i < 0) {
    by = 'number';
    const n = tableNumber(s);
    if (n !== null && n >= 1 && n <= table.regions.length) i = n - 1;
  }

  if (i < 0) {
    const sheets = speakList([...new Set(table.regions.map((r) => cleanText(r.sheet, 60)))]);
    throw new QueryError(
      `"${cleanText(table.title, 60)}" has no sheet or table called "${cleanText(sheet, 60)}".`,
      table.regions.length > 1
        ? `Say a table number from 1 to ${table.regions.length}, or a sheet: ${sheets}.`
        : `It has ${sheets}.`,
    );
  }
  return { table, region: table.regions[i]!, n: i + 1, by };
}

/**
 * A file as it is named aloud: by its own title row when it holds one table under one
 * ("FY2026 Departmental Budget"), which is what describe calls it too, and otherwise by
 * its file name. The list used to name the file one way and the answers another.
 */
function spokenTitle(t: IndexTable): string {
  const only = t.regions.length === 1 ? t.regions[0]?.title : null;
  return only?.trim() ? only : t.title;
}

/** The tables in a file, so a caller can name one by number or id. */
function regionList(table: IndexTable) {
  return table.regions.map((r, i) => ({
    n: i + 1,
    id: r.id,
    sheet: r.sheet,
    title: r.title,
    row_count: r.rowCount,
    columns: r.columns.map(columnName),
  }));
}

/**
 * Regions re-read under a correction, kept for the life of the isolate.
 *
 * A correction used to re-run `materialise` on every tool call, which at ten thousand
 * rows is most of a Worker's CPU budget spent re-deriving the same columns. The result
 * depends only on the region and the heading count, so it is cached on exactly that.
 */
const rereads = new WeakMap<IndexRegion, Map<number, IndexRegion>>();

function reread(region: IndexRegion, headerRows: number): IndexRegion {
  if (headerRows === region.headerRows.length) return region;
  let byCount = rereads.get(region);
  if (!byCount) {
    byCount = new Map();
    rereads.set(region, byCount);
  }
  const cached = byCount.get(headerRows);
  if (cached) return cached;

  const m = materialise(region.allRows, region.startRow, region.firstCol, headerRows);
  // Total rows are found by materialise when it knows how; indices from the old
  // reading would point at the wrong rows once the heading count changes.
  const totals = (m as Materialised & { readonly summaryRows?: readonly number[] }).summaryRows;
  // A day-first date column is stored as ISO days, so re-reading it cannot see which
  // way round the file wrote them; the order found at ingest is carried across by
  // position, which a change of heading rows does not move. So is how the column's
  // numbers were read, which ingest settled from the whole file.
  const columns = m.columns.map((c) => {
    const was = region.columns[c.i];
    if (!was) return c;
    const carried = {
      ...(c.kind === 'date' && was.dateOrder && !c.dateOrder ? { dateOrder: was.dateOrder } : {}),
      ...(c.sum !== undefined && was.numberConvention ? { numberConvention: was.numberConvention } : {}),
      ...(c.sum !== undefined && was.numberNote ? { numberNote: was.numberNote } : {}),
    };
    return Object.keys(carried).length ? { ...c, ...carried } : c;
  });
  const corrected: IndexRegion & { readonly summaryRows?: readonly number[] } = {
    ...region,
    headerRows: m.headerRows,
    firstDataRow: m.firstDataRow,
    rowCount: m.rows.length,
    columns,
    rows: m.rows,
    labelColumn: m.labelColumn,
    ambiguousColumns: m.ambiguousColumns,
    summaryRows: totals ?? [],
  };
  byCount.set(headerRows, corrected);
  return corrected;
}

/**
 * Locate a region and apply any correction the person has made to how its structure
 * is read.
 *
 * Every tool goes through here rather than through `locate` directly, so a spoken
 * correction takes effect everywhere at once. Re-reading runs the same
 * `materialise` the ingest step used, so a corrected table is built by code that is
 * already tested rather than by a second, less-travelled path.
 *
 * A stored correction that agrees with the inference is a confirmation, not a no-op.
 * It used to be treated as one: "yes, one heading row" left the table flagged as
 * uncertain forever, and the revision just announced disagreed with the one later
 * answers carried.
 */
async function located(
  index: LandmarkIndex,
  store: Store,
  tableId: string,
  sheet?: string,
): Promise<(Located & { revision: number; original: IndexRegion }) | ReturnType<typeof fail>> {
  const base = guard(() => locate(index, tableId, sheet));
  if (isFailure(base)) return base;
  const { table, region } = base;

  const override = await store.getStructure(`${table.id}/${region.id}`);
  if (!override) return { ...base, original: region, revision: region.structure.revision };

  const confirmed = override.headerRows === region.headerRows.length;
  const read = reread(region, override.headerRows);
  const corrected: IndexRegion = {
    ...read,
    headerConfidence: 1,
    structure: {
      chosen: confirmed
        ? region.structure.chosen
        : { headerRows: read.headerRows.length, score: 1, why: 'you told me where the headings stop' },
      alternatives: [],
      ambiguous: false,
      revision: override.revision,
      confirmedBy: 'user',
    },
  };
  return { ...base, original: region, region: corrected, revision: override.revision };
}

/** A one-row, one-column block: a source line or a footnote, not a table. */
function isNote(r: IndexRegion): boolean {
  return r.rowCount === 1 && r.columns.length === 1 && r.headerRows.length === 0;
}

/**
 * The other tables in the file, said aloud.
 *
 * A file with three tables, or one table split by a blank spacer row, used to be
 * described as its first block alone; the only hint that anything else existed sat in
 * a structured warning no listener hears. A total over the first block then sounded
 * like the total of the table. Named by number and by their columns, so "table 2"
 * means something, and a one-line note is called a note rather than a table.
 */
function otherTables(table: IndexTable, n: number): string {
  const others = table.regions.map((r, i) => ({ r, n: i + 1 })).filter((o) => o.n !== n);
  const tables = others.filter((o) => !isNote(o.r));
  const notes = others.filter((o) => isNote(o.r));

  const name = ({ r, n: k }: { r: IndexRegion; n: number }): string => {
    if (r.title) return `table ${k} is "${cleanText(r.title, 60)}"`;
    const cols = r.headerRows.length ? r.columns.filter((c) => c.path.length).map(columnName) : [];
    if (!cols.length) {
      return `table ${k} has ${plural(r.rowCount, 'row')} with no headings, from row ${r.startRow + 1}`;
    }
    return `table ${k} has ${speakList(cols.length > 3 ? [...cols.slice(0, 3), `${cols.length - 3} more`] : cols)}`;
  };

  let out = '';
  if (tables.length) {
    const listed = tables.slice(0, 3).map(name).join('; ');
    const rest = tables.length > 3 ? `; and ${tables.length - 3} more` : '';
    out +=
      n === 1
        ? ` This file has ${plural(tables.length, 'more table')}: ${listed}${rest}. Say "table ${tables[0]!.n}" to open ${tables.length === 1 ? 'it' : 'one'}.`
        : ` This is table ${n} of ${table.regions.length}. The ${tables.length === 1 ? 'other' : 'others'}: ${listed}${rest}.`;
  }
  const note = notes[0]?.r.rows[0]?.[0];
  if (note !== undefined && note !== null && String(note).trim()) {
    out += ` There is also a one-line note: "${cleanText(String(note), 80)}".`;
  }
  return out;
}

/** How ingest words a line of text it kept as a note rather than as a table. */
const NOTE_WARNING = /^A note(?: under a table)? on sheet "([^"]*)" reads: ([^]*)$/;

/**
 * The file's own warnings, said once when it is described. The several-tables warning
 * is left out because `otherTables` says the same thing with the tables named.
 *
 * One warning is spoken, cut at a word budget rather than a character count (which
 * stopped mid-word, "Opening the file in Excel…"), and the rest are counted. Problems
 * with the reading come first: a formula read as empty changes an answer, a source
 * line does not. A note is said as a note — "Note: A note on sheet …" said it twice.
 */
function spokenWarnings(table: IndexTable, region: IndexRegion): string {
  const all = table.warnings.filter((w) => !/separate tables/i.test(w));
  const ordered = [...all.filter((w) => !NOTE_WARNING.test(w)), ...all.filter((w) => NOTE_WARNING.test(w))];
  const first = ordered[0];
  if (first === undefined) return '';
  const note = NOTE_WARNING.exec(first);
  const text = note
    ? `There is also a note${note[1] === region.sheet ? '' : ` on ${note[1]}`}: ${note[2]}`
    : `Note: ${first}`;
  const one = capWords(cleanText(text).replace(/([^.!?…"])$/, '$1.'), 30);
  const rest = ordered.length - 1;
  return ` ${one}${rest ? ` There ${rest === 1 ? 'is 1 more note' : `are ${rest} more notes`} about this file.` : ''}`;
}

/**
 * A caveat for answers read from a structure nobody has confirmed.
 *
 * Describe said "I am not certain", and then every later answer was stated as fact —
 * so a client that skipped describe, or asked a second question, heard 2324 for a
 * column whose first cell was probably the year it was labelled with. The answer is
 * still given; the doubt travels with it.
 */
function structureCaveat(region: IndexRegion): string {
  const s = region.structure;
  if (!s.ambiguous || s.confirmedBy === 'user') return '';
  const alt = s.alternatives[0]?.why?.trim();
  return (
    ` I am not certain how this table's headings read${alt ? `; I could instead ${alt}` : ''}.` +
    ' Say "check the structure" if that sounds wrong.'
  );
}

/** Evidence the answer was built on a reading that might be wrong, for a model to act on. */
function structureFlags(region: IndexRegion): Structured {
  const s = region.structure;
  if (!s.ambiguous || s.confirmedBy === 'user') return {};
  return {
    structure_uncertain: true,
    alternatives: s.alternatives.map((a) => ({ header_rows: a.headerRows, why: a.why })),
    next_step: 'Offer to check the structure, which can change how many rows are headings.',
  };
}

/**
 * The slice of the sheet the widget draws, addressed so highlights line up.
 *
 * Capped at 40 rows: a highlighted cell needs its neighbours to mean anything, but
 * nobody needs a thousand-row grid inside an explanation, and a Worker response is not
 * the place to ship one. When highlights exist, the window is centred on them rather
 * than starting at the top, so the evidence is actually on screen.
 */
function buildGrid(region: IndexRegion, highlighted: readonly string[], winning: readonly string[] = []): {
  columns: { name: string; letter: string; kind: string }[];
  rows: { number: number; label: string | null; total: boolean; cells: { address: string; value: unknown }[] }[];
  label_letter: string | null;
} {
  const MAX_ROWS = 40;
  const rowOf = (addr: string): number => Number.parseInt(addr.replace(/^[A-Z]+/, ''), 10) - 1;
  // A highest or lowest came from one cell, and that cell is what the panel is for: the
  // window is centred on it, not on the first cell compared against it, which for a
  // winner on row 1001 of a thousand-row sheet left it forty rows out of view.
  const hits = (winning.length ? winning : highlighted).map(rowOf).filter((n) => Number.isFinite(n));

  let start = 0;
  if (hits.length && region.rowCount > MAX_ROWS) {
    let lowest = hits[0]!;
    for (const h of hits) if (h < lowest) lowest = h;
    const first = lowest - region.firstDataRow;
    start = Math.max(0, Math.min(first - 2, region.rowCount - MAX_ROWS));
  }
  const end = Math.min(region.rowCount, start + MAX_ROWS);
  const totals = summaryRowsOf(region);

  const rows = [];
  for (let i = start; i < end; i++) {
    rows.push({
      number: region.firstDataRow + i + 1,
      label: rowLabel(region, i),
      total: totals.has(i),
      cells: region.columns.map((c) => ({
        address: `${c.col}${region.firstDataRow + i + 1}`,
        value: region.rows[i]?.[c.i] ?? null,
      })),
    });
  }

  return {
    columns: region.columns.map((c) => ({ name: c.spoken, letter: c.col, kind: c.kind })),
    rows,
    label_letter: region.labelColumn === null ? null : (region.columns[region.labelColumn]?.col ?? null),
  };
}

/**
 * A row's label and its "column value" pairs. A total row is labelled as one, so
 * "Total: Amount 794,000" is not heard as a department called Total, and it is read
 * as its figures alone: the word that made it a total is its label, and its blank
 * cells ("Line item empty") are noise on a row that is only numbers.
 */
function rowParts(
  region: IndexRegion,
  dataRow: number,
  columns?: readonly IndexColumn[],
): { label: string | null; parts: { column: IndexColumn; text: string }[] } {
  const isTotal = summaryRowsOf(region).has(dataRow);
  const totalWord = isTotal ? summaryLabel(region, dataRow) : '';
  const label = isTotal ? `${totalWord} row` : rowLabel(region, dataRow);
  // The label is said once, as the label: asked for the Country column, "Vietnam:
  // Country Vietnam" said every name twice.
  const said = (c: IndexColumn): boolean => label !== null && !isTotal && c.i === region.labelColumn;
  const asked = columns ?? region.columns.filter((c) => c.i !== region.labelColumn);
  const wanted = asked.filter((c) => !said(c)).filter((c) => {
    if (!isTotal) return true;
    const v = region.rows[dataRow]?.[c.i] ?? null;
    if (v === null || (typeof v === 'string' && !v.trim())) return false;
    return !(typeof v === 'string' && cleanText(v, 40).replace(/\s*:$/, '') === totalWord);
  });
  return {
    label,
    parts: wanted.map((c) => ({
      column: c,
      text: `${columnName(c)} ${speakCell(region.rows[dataRow]?.[c.i] ?? null, c.kind)}`,
    })),
  };
}

/** Rows are spoken as label plus columns, never as coordinates. */
function speakRow(region: IndexRegion, dataRow: number, columns?: readonly IndexColumn[]): string {
  const { label, parts } = rowParts(region, dataRow, columns);
  if (!parts.length) return label ?? 'empty';
  return label ? `${label}: ${speakList(parts.map((p) => p.text))}` : speakList(parts.map((p) => p.text));
}

/** Whole rows within a word budget: a row is spoken completely or left for "more". */
function fitRows(sentences: readonly string[], budget: number): string[] {
  const said: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const w = wordCount(s);
    if (used + w > budget) break;
    said.push(s);
    used += w;
  }
  return said;
}

/** Said after a row too wide to speak whole, so the cut is never silent. */
const ROW_CUT = ' Name the columns you want to hear the rest.';

/**
 * One page of rows for speech: whole rows within the budget, and exactly the rows
 * said, so the cursor moves past those and no others.
 *
 * A row wider than the whole budget used to be admitted anyway and then trimmed away
 * with the rest of the sentence — a 25-column table paged "Rows 2 to 2 of 4", "Rows 3
 * to 3 of 4" and never spoke a record. Such a row is now cut by whole columns, and
 * the cut is said: "… and 12 more columns. Name the columns you want to hear the rest."
 */
function pageRows(
  region: IndexRegion,
  indices: readonly number[],
  columns: readonly IndexColumn[] | undefined,
  budget: number,
): { text: string; rows: string[]; unread: string[] } {
  if (indices[0] === undefined) return { text: '', rows: [], unread: [] };
  const said = fitRows(indices.map((i) => speakRow(region, i, columns)), budget);
  if (said.length) return { text: `${said.join('. ')}.`, rows: said, unread: [] };

  const { label, parts } = rowParts(region, indices[0], columns);
  const lead = label ? `${label}: ` : '';
  // Room for the cut notice and for "and N more columns" at the end of the list.
  let used = wordCount(lead) + wordCount(ROW_CUT) + 4;
  const kept: string[] = [];
  for (const p of parts) {
    const w = wordCount(p.text);
    if (kept.length && used + w > budget) break;
    kept.push(p.text);
    used += w;
  }
  const unread = parts.slice(kept.length).map((p) => columnName(p.column));
  const row = `${lead}${speakList(unread.length ? [...kept, plural(unread.length, 'more column')] : kept)}`;
  return { text: `${row}.${unread.length ? ROW_CUT : ''}`, rows: [row], unread };
}

/** Does this region have a column by that name? */
function hasColumn(region: IndexRegion, name: string): boolean {
  try {
    return matchColumns(region, name).length > 0;
  } catch {
    return false;
  }
}

/**
 * Point a missing column at the table in the same file that has it.
 *
 * "Sum Actual" on a sheet of three tables answered "This table has no column called
 * Actual" and stopped, while table 2 had it; a host that had not re-read describe had
 * nowhere to go. The next step now names the table.
 */
function pointElsewhere(at: Located, e: unknown): unknown {
  if (!(e instanceof QueryError) || e.missing === null) return e;
  const name = e.missing;
  const has = at.table.regions
    .map((r, i) => ({ r, k: i + 1 }))
    .filter(({ r, k }) => k !== at.n && !isNote(r) && hasColumn(r, name));
  const lead = has[0];
  if (lead === undefined) return e;
  const which =
    has.length === 1
      ? `Table ${lead.k} in this file has ${name}.`
      : `Tables ${speakList(has.slice(0, 3).map((h) => String(h.k)))} in this file have ${name}.`;
  return new QueryError(e.message, `${which} Say "table ${lead.k}" to use it.`, name);
}

/** Run a lookup against a located region, pointing a missing column elsewhere. */
function within<T>(at: Located, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw pointElsewhere(at, e);
  }
}

/** Row conditions, as table_query and table_compare both take them. */
const FILTERS = z
  .array(
    z.object({
      column: text().describe('Column name as given by the describe tool, or as it is spoken.'),
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_empty', 'is_not_empty']),
      value: text()
        .optional()
        .describe(
          'Value to compare against, as text. Numbers may be digits or spoken ("100 million", ' +
            '"1.5k"); dates as 2026-08-01 or August 1, 2026, or a whole month as "August" or ' +
            '"August 2026" — with gte for "since August", gt for "after", lt for "before".',
        ),
      values: z
        .array(text())
        .max(20)
        .optional()
        .describe(
          "For 'eq' or 'neq' only: several values, any one of which matches ('eq') or none of " +
            "which may ('neq'). Use it for \"Vietnam and Thailand\", with group_by on the same column.",
        ),
    }),
  )
  .max(10)
  .default([]);

type FilterArg = { column: string; op: FilterOp; value?: string; values?: string[] };

/**
 * The conditions a comparison was made under, said at its head: "For South, …".
 *
 * A comparison asked "for the north" was computed over the whole table and spoken as
 * though it were the North's. With the conditions applied, they are also said, so the
 * listener hears which rows the two figures cover.
 */
function conditionsSaid(region: IndexRegion, filters: readonly FilterArg[]): string {
  const parts = filters.map((f) => {
    const vals = (f.values?.length ? f.values : f.value !== undefined ? [f.value] : []).map((v) => cleanText(v, 40));
    let name = cleanText(f.column, 60);
    try {
      name = columnName(resolveColumn(region, f.column));
    } catch {
      // Said as given; the query itself reports a column that does not exist.
    }
    if (f.op === 'eq') return speakList(vals);
    if (f.op === 'neq') return `all but ${speakList(vals)}`;
    if (f.op === 'is_empty' || f.op === 'is_not_empty') return `${name} ${OP_WORDS[f.op]}`;
    return `${name} ${OP_WORDS[f.op]} ${speakList(vals)}`;
  });
  return parts.length ? `For ${speakList(parts)}, ` : '';
}

/** The same conditions as the end of a phrase: " for South", or nothing. */
function conditionsTail(region: IndexRegion, filters: readonly FilterArg[]): string {
  const said = conditionsSaid(region, filters);
  return said ? ` for ${said.slice('For '.length, -', '.length)}` : '';
}

/**
 * What an answer was, for one kept before answers carried it: the measure without its
 * figure, which is still enough to tell the total of Amount from the count before it.
 */
function aboutParts(parts: readonly AnswerPart[]): string {
  const [first, second] = parts;
  if (!first) return 'that answer';
  if (second) return `${speakName(first.label)} against ${speakName(second.label)}`;
  const name = speakName(first.label);
  switch (first.aggregate) {
    case 'sum': return `the total of ${name}`;
    case 'avg': return `the average of ${name}`;
    case 'max': return `the highest ${name}`;
    case 'min': return `the lowest ${name}`;
    case 'count': return 'the count of rows';
    default: return 'the rows I read';
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, index: LandmarkIndex, store: Store): void {
  // ── 1. table_list ────────────────────────────────────────────────────────
  server.registerTool(
    'table_list',
    {
      title: 'List available tables',
      description:
        'List the spreadsheets this person has available. Call this when they ask what they have, ' +
        'name a file only vaguely ("the budget one"), or when you need a table to work on and do not ' +
        'already have one. Returns at most five with a short sentence naming them; say that sentence, ' +
        'then wait. If there are more than five, ask whether to go on rather than listing everything.',
      inputSchema: {
        cursor: text(20)
          .optional()
          .describe('Continuation token from a previous call. Omit for the first page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe('listing the tables', async ({ cursor }) => {
      const offset = pageOffset(cursor, index.tables.length);
      const page = index.tables.slice(offset, offset + PAGE);
      const more = offset + page.length < index.tables.length;

      const remaining = index.tables.length - offset - page.length;
      // "No tables loaded" is said only when that is true. A cursor at or past the end —
      // one a host model made up, or counted on by itself — used to get it too, so
      // someone with six spreadsheets was told confidently that they had none.
      const spoken = page.length
        ? capWords(
            `You have ${speakList(page.map((t) => cleanText(spokenTitle(t), 60)))}.` +
              // "There are 1 more" is the kind of thing you only notice once it is
              // spoken aloud, which is the entire argument for testing by listening.
              (more ? ` There ${remaining === 1 ? 'is 1 more' : `are ${remaining} more`}.` : ''),
            HEADLINE_WORD_LIMIT,
          )
        : index.tables.length
          ? `That is all of them: you have ${plural(index.tables.length, 'table')}.`
          : 'There are no tables loaded.';

      return ok(spoken, {
        tables: page.map((t) => {
          const sheets = [...new Set(t.regions.map((r) => r.sheet))];
          return {
            table_id: t.id,
            title: t.title,
            // People name a spreadsheet by the tab they remember, not by the filename
            // it was saved under — "the budget one" means the sheet called Budget in a
            // file called 04-title-and-vmerge. Reporting only a count made that name
            // unresolvable, so a client had nothing to match and answered about some
            // other table instead.
            sheets,
            sheet_count: sheets.length,
            row_count: t.regions.reduce((n, r) => n + r.rowCount, 0),
            regions: regionList(t),
          };
        }),
        more_available: more,
        cursor: more ? String(offset + page.length) : null,
      });
    }),
  );

  // ── 2. table_describe ────────────────────────────────────────────────────
  server.registerTool(
    'table_describe',
    {
      title: 'Describe a table before reading it',
      description:
        'Describe the shape of a table before anything else — what it is, how big it is, what its ' +
        'columns are called, what kind of values they hold, and where the gaps are. Call this first ' +
        'for any table you have not already described in this conversation; it is the orientation ' +
        'step that replaces glancing at a page to see what is on it. If the sheet has stacked or ' +
        'merged headings, this is where you learn the real column names. Never guess a column name — ' +
        'get it from here. When a file holds several tables, `regions` lists them; pass a table ' +
        'number as `sheet` to open another. A wide table names its first columns and returns a ' +
        'cursor; when they say more, or ask for the rest of the columns, call it again with that ' +
        'cursor to read the next names.',
      inputSchema: {
        table_id: text().describe('Identifier from the list of tables, not the spoken title.'),
        sheet: text().optional().describe(SHEET_HELP),
        detail: z
          .enum(['brief', 'full'])
          .default('brief')
          .describe(
            "'brief' is one speakable sentence plus column names. Use 'full' only when they ask " +
              'for value ranges, gap counts, or how the headings are structured.',
          ),
        cursor: text(20)
          .optional()
          .describe('Continuation token from a previous description: reads on through the column names.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe('describing that table', async ({ table_id, sheet, detail, cursor }) => {
      const found = await located(index, store, table_id, sheet);
      if (isFailure(found)) return found;
      const { table, region, n } = found;
      const totals = summaryRowsOf(region);

      // With a cursor, the reply is the next column names alone: the rest of the
      // description was said the first time. Everything structured is the same either
      // way, so a caller keeping the column list never loses it to a continuation. An
      // empty cursor is no cursor: some hosts fill every optional string with "", and
      // the whole description was then lost to a bare list of column names.
      const said = continuing(cursor)
        ? speakColumnPage(region, pageOffset(cursor))
        : describeRegion(region, detail === 'full', otherTables(table, n) + spokenWarnings(table, region));
      return ok(said.text, {
        table_id: table.id,
        sheet: region.sheet,
        title: region.title,
        table_number: n,
        row_count: region.rowCount,
        ...(totals.size ? { summary_rows: [...totals].map((i) => i + 1) } : {}),
        header_levels: region.headerRows.length,
        merged_label_cells: region.inherited.length,
        columns: region.columns.map((c) => ({
          name: c.spoken,
          spoken_name: columnName(c),
          header_path: c.path,
          type: c.kind,
          non_empty: c.nonEmpty,
          empty: c.empty,
          distinct: c.distinct,
          ...(c.categories ? { categories: c.categories } : {}),
          ...(c.min !== undefined ? { min: c.min, max: c.max, sum: c.sum } : {}),
          // A number column whose total means nothing, and why, so a caller can ask for
          // its average instead of being refused.
          ...(c.sum !== undefined && noTotal(c, region) ? { no_total: noTotal(c, region) } : {}),
          source_column: c.col,
        })),
        sheets: [...new Set(table.regions.map((r) => r.sheet))],
        regions: regionList(table),
        warnings: table.warnings,
        ...structureFlags(region),
        more_available: said.next !== null,
        cursor: said.next === null ? null : String(said.next),
      });
    }),
  );

  // ── 3. table_structure ───────────────────────────────────────────────────
  server.registerTool(
    'table_structure',
    {
      title: 'Check or correct how a table is being read',
      description:
        'Say how this table is currently being read — how many rows are treated as headings and ' +
        'why — and change it when that reading is wrong. Offer this whenever a description says ' +
        'the reading is uncertain, whenever a column is named after something that sounds like ' +
        'data ("Alice", "2024"), or whenever someone says a row count or a total looks wrong. ' +
        'Call it with no heading count to hear the current reading and the alternatives; call it ' +
        'with one to change it, or to confirm the current reading so it is no longer flagged. ' +
        'Changing it re-reads the table immediately and every later answer uses the corrected reading.',
      inputSchema: {
        table_id: text(),
        sheet: text().optional().describe(SHEET_HELP),
        header_rows: z
          .number()
          .int()
          .min(0)
          .max(MAX_HEADER_ROWS)
          .optional()
          .describe(
            'How many rows at the top are headings. 0 means the table has none and every row is ' +
              'data. Omit to inspect without changing anything.',
          ),
        cursor: text(20)
          .optional()
          .describe(
            'Continuation token from a previous reply: reads on through the column names under the ' +
              'current reading, and changes nothing. With a heading count that would change or first ' +
              'confirm the reading, the count is applied and the cursor ignored.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe('checking how that table is read', async ({ table_id, sheet, header_rows, cursor }) => {
      const found = await located(index, store, table_id, sheet);
      if (isFailure(found)) return found;
      const { table, region, original } = found;
      const SHOWN = 8;
      const names = (cols: readonly IndexColumn[]): { listed: string; cut: boolean } => {
        const named = cols.filter((c) => c.path.length).map(columnName);
        const cut = named.length > SHOWN;
        return { listed: speakList(cut ? [...named.slice(0, SHOWN), `${named.length - SHOWN} more`] : named), cut };
      };
      const SAY_COLUMNS = ' Say more to hear the columns.';
      // The reply with its list of column names when that fits, and otherwise without the
      // list but with how to hear it. Capped as one text, a table with long headings lost
      // the list whole, and the reply handed back a cursor nobody was told to follow.
      // "More" then picks up past the names said, or from the first if none were.
      const fit = (
        withNames: string,
        withoutNames: string,
        budget: number,
        listed: boolean,
        cut: boolean,
      ): { spoken: string; resume: Structured } => {
        if (!listed) return { spoken: capWords(withNames, budget), resume: { more_available: false, cursor: null } };
        if (wordCount(withNames) <= budget) {
          return {
            spoken: withNames,
            resume: cut ? { more_available: true, cursor: String(SHOWN) } : { more_available: false, cursor: null },
          };
        }
        return {
          spoken: capWords(withoutNames, budget - wordCount(SAY_COLUMNS)) + SAY_COLUMNS,
          resume: { more_available: true, cursor: '0' },
        };
      };

      // ── read on through the column names ──
      //
      // "More" after this reply used to answer "That was all of it" while 32 column names
      // had not been said. A continuation reads them and changes nothing, even when the
      // reply it continues was a correction: that correction is already in place, and
      // "more" after it repeats the same heading count with the cursor.
      //
      // Only a real token that asks for no change continues. A heading count that differs
      // from the reading in use, or confirms one not yet confirmed, is a correction
      // whatever else comes with it: taken as a continuation, {header_rows: 1, cursor: ""}
      // — an empty string from a host that fills every optional field, or the last call's
      // arguments copied whole — read out column names and never wrote the correction,
      // and the reply did not say so.
      const asksChange =
        header_rows !== undefined &&
        !(header_rows === region.headerRows.length && region.structure.confirmedBy === 'user');
      if (continuing(cursor) && !asksChange) {
        const page = speakColumnPage(region, pageOffset(cursor));
        return ok(page.text, {
          table_id: table.id,
          sheet: region.sheet,
          header_rows: region.structure.chosen.headerRows,
          data_rows: region.rowCount,
          columns: region.columns.map((c) => c.spoken),
          more_available: page.next !== null,
          cursor: page.next === null ? null : String(page.next),
        });
      }

      // ── inspect ──
      if (header_rows === undefined) {
        const s = region.structure;
        const head =
          s.chosen.headerRows === 0
            ? 'I am treating every row as data.'
            : `I am treating ${plural(s.chosen.headerRows, 'row')} as headings — ${s.chosen.why}.`;
        const { listed, cut } = names(region.columns);
        const cols = listed ? ` That gives the columns ${listed}.${cut ? ' Say more for the rest.' : ''}` : '';
        // An empty list of alternatives used to be spoken as "I could instead ." —
        // a correction prompt that names no correction.
        const alts = s.alternatives.map((a) => a.why).filter((w) => w.trim());
        const doubt = s.ambiguous
          ? (alts.length ? ` I am not certain: I could instead ${speakList(alts)}.` : ' I am not certain.') +
            ' Tell me how many rows are headings to change it.'
          : s.confirmedBy === 'user'
            ? ' You confirmed this.'
            : '';
        const said = fit(head + cols, head, SPOKEN_WORD_LIMIT - wordCount(doubt), listed !== '', cut);
        return ok(said.spoken + doubt, {
          table_id: table.id,
          sheet: region.sheet,
          header_rows: s.chosen.headerRows,
          data_rows: region.rowCount,
          why: s.chosen.why,
          ambiguous: s.ambiguous,
          confirmed_by_user: s.confirmedBy === 'user',
          revision: s.revision,
          alternatives: s.alternatives.map((a) => ({ header_rows: a.headerRows, why: a.why })),
          columns: region.columns.map((c) => c.spoken),
          ...said.resume,
        });
      }

      // ── correct ──
      if (header_rows >= original.allRows.length) {
        return fail(
          `This table only has ${plural(original.allRows.length, 'row')} in total.`,
          'Choose a smaller number of heading rows so some rows remain as data.',
        );
      }

      const override = await store.putStructure(`${table.id}/${original.id}`, header_rows);
      const m = reread(original, header_rows);
      const { listed, cut } = names(m.columns);
      const confirmed = header_rows === original.headerRows.length;
      // What it was read as a moment ago: the inference, or an earlier correction.
      const before = region.headerRows.length;
      const headings = (n: number): string => (n === 0 ? 'no heading rows' : plural(n, 'heading row'));

      // The reply says what changed, from what to what, and for how long. "Right — 1
      // heading row" did not say whether anything had changed at all, and a listener
      // who cannot see the sheet has only this sentence to know the correction took.
      const change =
        header_rows === before
          ? `Right — ${headings(header_rows)}, as I was already reading it.`
          : `Right — I now read ${headings(header_rows)} instead of ${headings(before)}.`;
      const listing = header_rows === 0 || !listed ? '' : `, with the columns ${listed}.${cut ? ' Say more for the rest.' : ''}`;
      const rows = ` That gives ${plural(m.rowCount, 'row')} of data`;
      const shape = header_rows === 0 ? `${rows}, and I will call the columns by position.` : rows + (listing || '.');
      const lasting = confirmed ? ' I will stop asking.' : ' That holds for the rest of this conversation.';
      const said = fit(change + shape, `${change}${rows}.`, SPOKEN_WORD_LIMIT - wordCount(lasting), listing !== '', cut);

      return ok(said.spoken + lasting, {
        table_id: table.id,
        sheet: region.sheet,
        header_rows,
        previous_header_rows: before,
        changed: header_rows !== before,
        data_rows: m.rowCount,
        revision: override.revision,
        confirmed_by_user: true,
        columns: m.columns.map((c) => c.spoken),
        // Confirming the reading already in use changes no answer given under it.
        ...(confirmed ? {} : { note: 'Answers given before this correction were computed under the previous reading.' }),
        ...said.resume,
      });
    }),
  );

  // ── 4. table_query ───────────────────────────────────────────────────────
  server.registerTool(
    'table_query',
    {
      title: 'Answer a question about a table',
      description:
        'Answer a question about one table by filtering and aggregating its rows, and return a ' +
        'sentence ready to be spoken. Use this instead of reading cells whenever someone asks how ' +
        'many, what the total, average, highest or lowest is, or which rows match something. Call ' +
        'the describe tool first if you do not already know this table\'s exact column names. Every ' +
        'answer comes back with the cells it was computed from — if they doubt a number, pass the ' +
        'answer identifier to the explain tool rather than working it out again. A listing speaks ' +
        'the rows themselves, as many as fit, with a token for the rest; `exact` holds the unrounded figure.',
      inputSchema: {
        table_id: text(),
        sheet: text().optional().describe(SHEET_HELP),
        filters: FILTERS.describe('Row conditions, combined with AND. An empty list means every row.'),
        aggregate: z
          .enum(['none', 'count', 'sum', 'avg', 'min', 'max'])
          .default('none')
          .describe(
            "Use 'none' to return the matching rows themselves. A percentage, a rate or a figure per " +
              "capita has no total (the description marks it no_total), so 'sum' of one is refused: use " +
              "'avg'. A 'sum' of figures that are each an average or per person is given, and said to add them up.",
          ),
        aggregate_column: text()
          .optional()
          .describe("Numeric column to aggregate. Required unless the aggregate is 'none' or 'count'."),
        group_by: text()
          .optional()
          .describe('Optional column to break the answer down by. One column only — more is unspeakable.'),
        order: z
          .enum(['desc', 'asc'])
          .default('desc')
          .describe(
            "Which end of a breakdown comes first. 'asc' for lowest, least, smallest or fewest questions " +
              'and for "from lowest to highest", whether each group\'s figure is a total, an average or a ' +
              'count, so the answer starts with the lowest however many groups there are.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(PAGE)
          .describe('Keep at five or fewer for speech; they can always ask for more.'),
        cursor: text(20).optional().describe('Continuation token from a previous call.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe('answering that', async (args) => {
      const found = await located(index, store, args.table_id, args.sheet);
      if (isFailure(found)) return found;
      const { table, region } = found;
      const aggregate = args.aggregate as Aggregate;
      const offset = pageOffset(args.cursor);

      const run = within(found, () =>
        runQuery(region, {
          filters: args.filters as { column: string; op: FilterOp; value?: string; values?: string[] }[],
          aggregate,
          ...(args.aggregate_column ? { aggregateColumn: args.aggregate_column } : {}),
          ...(args.group_by ? { groupBy: args.group_by } : {}),
          order: args.order,
          limit: args.limit,
          offset,
        }),
      );

      const numeric = aggregate === 'sum' || aggregate === 'avg' || aggregate === 'min' || aggregate === 'max';
      const target = numeric && args.aggregate_column ? resolveColumn(region, args.aggregate_column) : null;
      // A count's evidence is each counted row's identifying cell, so that is the
      // column it is explained under — not whichever column the caller happened to name.
      const counted = aggregate === 'count' ? (region.columns[region.labelColumn ?? 0] ?? null) : null;

      // Said after the answer, never trimmed: a total over the first of three tables
      // sounds like the total of the file unless someone says otherwise. Named by
      // number or id, the caller chose the table; named by a sheet holding several, it
      // got the first of them and was not told.
      const siblings =
        found.by === 'default'
          ? table.regions.filter((r) => r.id !== region.id && !isNote(r))
          : found.by === 'sheet'
            ? table.regions.filter((r) => r.id !== region.id && r.sheet === region.sheet && !isNote(r))
            : [];
      const after =
        (siblings.length === 0
          ? ''
          : found.by === 'sheet'
            ? ` That covers only the first of ${siblings.length + 1} tables on ${cleanText(region.sheet, 60)}.`
            : ` That covers only the first of ${siblings.length + 1} tables in this file.`) + structureCaveat(region);

      // ── plain listing: speak the rows themselves ──
      //
      // This answered "which reps closed in August?" with "2 rows." — the rows were
      // only in the structured result, which the server's own instructions tell hosts
      // not to read aloud. Rows are spoken whole, within the budget, and the cursor
      // moves past only the rows that were actually said. The budget is set aside for
      // everything else the answer must say before any row is admitted, rather than the
      // whole text being trimmed afterwards, which could drop a row already counted.
      let listed = run.rowIndices;
      let more = run.moreAvailable;
      let nextCursor = run.nextOffset === null ? null : String(run.nextOffset);
      let unread: string[] = [];
      let spokenGroups = run.groups.length;
      let spoken: string;
      if (aggregate === 'none' && run.rowIndices.length) {
        const suffix = ' Say more for the rest.';
        const notes = queryNotes(region, run);
        // "8 rows match." or "Rows 11 to 15 of 40." — numbers are one word each. The
        // rows keep a floor of their own: a long caveat may push the whole answer a
        // little past the ceiling, but it must not leave room for only a label.
        const head = offset === 0 ? 3 : 6;
        const budget = Math.max(
          HEADLINE_WORD_LIMIT + 15,
          SPOKEN_WORD_LIMIT - head - wordCount(suffix) - wordCount(notes) - wordCount(after),
        );
        const page = pageRows(region, run.rowIndices, undefined, budget);
        listed = run.rowIndices.slice(0, page.rows.length);
        unread = page.unread;
        const consumed = offset + page.rows.length;
        more = consumed < run.matchedRows;
        nextCursor = more ? String(consumed) : null;
        const opening =
          offset === 0 && !more
            ? ''
            : offset === 0
              ? `${plural(run.matchedRows, 'row')} match. `
              : `Rows ${offset + 1} to ${consumed} of ${run.matchedRows}. `;
        spoken = opening + page.text + (more ? suffix : '') + notes;
      } else {
        const spec = {
          aggregate,
          order: args.order,
          from: offset,
          ...(args.aggregate_column ? { aggregateColumn: args.aggregate_column } : {}),
        };
        spoken =
          // A cursor past the last group: every group has been read. Spoken as a single
          // figure it was "There is no total. No matching row held a number" — false of
          // rows that held numbers and had all been said.
          run.groupColumn && offset > 0 && !run.groups.length && run.groupCount > 0
            ? `That was every ${columnName(run.groupColumn)}: ${run.groupCount} in all.`
            : speakQuery(region, spec, target, run);
        // A breakdown says whole groups within the budget, and the cursor moves past
        // exactly those: trimmed afterwards, groups eleven to twenty were counted as read
        // and never heard, and "say more" was cut off with them.
        if (run.groups.length && !(run.matchedRows === 0 && run.summarySkipped.length)) {
          const fitted = fitGroups(target, spec, run);
          spokenGroups = fitted.count;
          more = fitted.more;
          nextCursor = more ? String(offset + fitted.count) : null;
        }
        // How this column's numbers were read, when that was a guess: said with the
        // figure, because "125" for a price list worth 125 thousand is exactly the
        // mistake a listener cannot catch, and describe is not always asked first.
        if (target?.numberNote && (run.result !== null || run.groups.length)) spoken += ` ${cleanText(target.numberNote, 200)}`;
      }
      spoken += after;

      const shownRows = new Set(listed.map((i) => region.firstDataRow + i + 1));
      const rowOf = (addr: string): number => Number.parseInt(addr.replace(/^[A-Z]+/, ''), 10);
      const cells =
        aggregate === 'none' ? run.provenance.cells.filter((a) => shownRows.has(rowOf(a))) : run.provenance.cells;
      const winners = winnerLabels(region, run.winners);

      const part: AnswerPart = {
        label: target ? columnName(target) : counted ? 'the rows counted' : 'the matching rows',
        tableId: table.id,
        regionId: region.id,
        sheet: region.sheet,
        cells,
        cellCount: aggregate === 'none' ? listed.length * region.columns.length : run.provenance.cellCount,
        excluded: run.provenance.excluded,
        path: target?.path ?? counted?.path ?? [],
        aggregate,
        ...(run.winners.length
          ? {
              winners: run.provenance.cells.slice(0, run.winners.length),
              winnerLabels: winners,
              winnerCount: run.winnerCount,
            }
          : {}),
        structureRevision: found.revision,
        headerRows: region.headerRows.length,
        ingestedAt: table.ingestedAt,
      };
      const about = cleanText(
        answerAbout({ aggregate }, target, run, conditionsTail(region, args.filters as FilterArg[])),
        ABOUT_CHARS,
      );
      const answerId = await keepAnswer(store, { parts: [part], spec: args, structureRevision: found.revision, about });

      return ok(spoken, {
        // With the id, what the answer was in a few words: a client that explains it after
        // other questions can name it in the words table_explain's `restate` uses.
        ...(answerId ? { answer_id: answerId, answer_about: about } : { working_kept: false }),
        result: run.result,
        exact: run.result === null ? null : exactNumber(run.result),
        matched_rows: run.matchedRows,
        rows: listed.map((i) => ({ label: rowLabel(region, i), spoken: speakRow(region, i) })),
        groups: run.groups.slice(0, spokenGroups).map((g) => ({
          key: g.key,
          value: g.value,
          row_count: g.rowCount,
          ...(g.value === null ? {} : { exact: exactNumber(g.value) }),
        })),
        ...(winners.length ? { winners, winner_count: run.winnerCount } : {}),
        ...(unread.length ? { row_truncated: true, columns_not_read: unread } : {}),
        ...(run.summarySkipped.length
          ? { left_out_summary_rows: run.summarySkipped.map((i) => i + 1) }
          : {}),
        ...(run.unreadable.length ? { unreadable_rows: run.unreadable.map((u) => u.row + 1) } : {}),
        provenance: {
          sheet: run.provenance.sheet,
          cell_count: part.cellCount,
          excluded_count: run.provenance.excluded.length,
        },
        more_available: more,
        cursor: nextCursor,
        ...structureFlags(region),
      });
    }),
  );

  // ── 4. table_explain ─────────────────────────────────────────────────────
  server.registerTool(
    'table_explain',
    {
      // The only tool with a visual surface, and the only one that warrants one:
      // a person with residual sight, or a sighted colleague reading along, can see
      // the counted cells lit up instead of taking the sentence on faith. Hosts that
      // do not understand MCP Apps ignore this key and lose nothing.
      _meta: uiMeta(EXPLAIN_UI_URI),
      title: 'Show where an answer came from',
      description:
        'Show exactly where a previous answer came from. Pass the answer identifier you were given ' +
        'and this reads back the source cells, with the full heading each one sits under, and names ' +
        'anything that was skipped. Use it whenever they ask how you know, are you sure, where that ' +
        'came from, or which rows those were — and offer it yourself after any total or average, ' +
        'because someone who cannot see the sheet is entitled to check a number. If anything else ' +
        'has been asked since that answer, set `restate`, so the reply first says which answer it is about.',
      inputSchema: {
        answer_id: text(80).describe('From a previous query result.'),
        limit: z.number().int().min(1).max(50).default(PAGE),
        restate: z
          .boolean()
          .default(false)
          .describe(
            'True when other questions came between that answer and this one: the reply then starts ' +
              'by naming the answer it explains ("For the earlier answer, 690 thousand, the total of Amount").',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe('reading back that answer', async ({ answer_id, limit, restate }) => {
      const a: Kept | null = await store.getAnswer(answer_id);
      if (!a) {
        return fail(
          'I no longer have the working for that answer.',
          'Ask the question again and I will keep it this time.',
        );
      }
      // Which answer this is about. Straight after it, the listener knows; after a
      // refused question or two, "That came from C3 and C6" was heard as evidence for
      // whatever they had asked last. A caller that knows other questions came between
      // asks for the answer to be named first.
      // "For", not "About": an answer over many rows is itself "about 88 thousand", and
      // "About the earlier answer, about 88 thousand" said the word twice in five.
      const about = a.about ?? aboutParts(a.parts);
      const lead = restate ? `For the earlier answer, ${about}: ` : '';
      // Each operand keeps its own sheet, cells and heading. A comparison that
      // pooled them would have to pick one heading for both, which is how this tool
      // came to tell people that the second column's cells held the first column's
      // measure.
      const explained = speakExplain(
        a.parts.map((p) => ({
          label: p.label,
          sheet: p.sheet,
          cells: p.cells,
          totalCells: p.cellCount,
          path: p.path,
          excluded: p.excluded,
          limit,
          ...(p.aggregate ? { aggregate: p.aggregate } : {}),
          ...(p.winners ? { winners: p.winners } : {}),
          ...(p.winnerLabels ? { winnerLabels: p.winnerLabels } : {}),
          ...(p.winnerCount !== undefined ? { winnerCount: p.winnerCount } : {}),
        })),
        SPOKEN_WORD_LIMIT - wordCount(lead),
      );
      // "For the earlier answer, 690 thousand, the total of Amount: that came from …".
      let spoken = lead ? lead + explained.replace(/^(That|Those) /, (w) => w.toLowerCase()) : explained;

      // Every operand is checked against the table as it stands now. Only the first
      // was, so correcting the right-hand table of a comparison left the comparison
      // looking current. A reading is judged by its heading count where the answer
      // recorded one: confirming the reading in use bumps the revision but changes no
      // cell, and calling every earlier answer stale after "yes, that's right" was false.
      const currents: Awaited<ReturnType<typeof located>>[] = [];
      for (const p of a.parts) currents.push(await located(index, store, p.tableId, p.regionId));
      const staleRevision = a.parts.some((p, k) => {
        const c = currents[k];
        if (c === undefined || isFailure(c)) return false;
        return p.headerRows !== undefined
          ? c.region.headerRows.length !== p.headerRows
          : c.revision !== (p.structureRevision ?? a.structureRevision);
      });
      // A re-ingested file can hold new values in the very cells named below; saying
      // "that came from B2" about a B2 that has since changed is evidence for a
      // different answer.
      const reloaded = a.parts.some((p, k) => {
        const c = currents[k];
        return p.ingestedAt !== undefined && c !== undefined && !isFailure(c) && c.table.ingestedAt !== p.ingestedAt;
      });
      const gone = currents.some((c) => c === undefined || isFailure(c));
      if (staleRevision) {
        spoken +=
          ' Note that you changed how this table is read after I gave that answer, so ask it again for a current one.';
      }
      if (reloaded) {
        spoken += ' The file has been loaded again since I gave that answer, so those cells may hold different values now.';
      }
      if (gone) spoken += ' That table is no longer loaded, so I cannot show the cells themselves.';

      // The widget needs the surrounding region, not just the cell list — a
      // highlighted cell with no neighbours conveys nothing. It draws the first
      // operand's region and lights every counted cell of every operand that sits in
      // it; it used to light only the first five of the first operand, so the rest of
      // a total looked as though it had been left out.
      //
      // Alongside: the cells that hold a highest or lowest (`winning`), so the answer
      // itself is marked and in view; how many cells were counted in all (`counted`),
      // because the list of cells stops at 200 and "40 of 200 counted" was said of a
      // thousand-row total; and the operands on other tables (`elsewhere`), which a
      // comparison across files could not show and did not mention.
      const first = a.parts[0];
      const current = currents[0];
      const drawn = first ? a.parts.filter((p) => p.tableId === first.tableId && p.regionId === first.regionId) : [];
      const highlight = drawn.flatMap((p) => p.cells);
      const winning = drawn.flatMap((p) => p.winners ?? []);
      const counted = drawn.reduce((n, p) => n + p.cellCount, 0);
      const elsewhere = a.parts
        .filter((p) => !drawn.includes(p))
        .map((p) => ({ name: speakName(p.label), sheet: p.sheet, cells: p.cellCount }));
      const visual =
        current === undefined || isFailure(current)
          ? null
          : {
              grid: buildGrid(current.region, highlight, winning),
              title: current.region.title,
              highlight,
              winning,
              counted,
              elsewhere,
            };

      const perPart = a.parts.map((p) => ({
        name: p.label,
        sheet: p.sheet,
        cells: p.cells.slice(0, limit),
        total_cells: p.cellCount,
        header_path: p.path,
        excluded: p.excluded.map((e) => ({ address: e.address, reason: e.reason })),
        ...(p.winners ? { winning_cells: p.winners } : {}),
        ...(p.winnerCount !== undefined ? { winner_count: p.winnerCount } : {}),
      }));

      return ok(
        spoken,
        {
          // What the explained answer was, in words a caller can say before the cells.
          answer_about: about,
          parts: perPart,
          // Flattened view of the first operand, for callers expecting one set.
          sheet: first?.sheet ?? null,
          cells: perPart[0]?.cells ?? [],
          total_cells: first?.cellCount ?? 0,
          header_path: first?.path ?? [],
          excluded: (first?.excluded ?? []).map((e) => ({ address: e.address, reason: e.reason })),
          more_available: a.parts.some((p) => p.cells.length > limit),
          structure_revision: a.structureRevision,
          structure_changed_since: staleRevision,
          file_changed_since: reloaded,
          ...(visual ?? {}),
        },
        ['grid', 'highlight', 'winning', 'counted', 'elsewhere'],
      );
    }),
  );

  // ── 5. table_read_rows ───────────────────────────────────────────────────
  server.registerTool(
    'table_read_rows',
    {
      title: 'Read specific rows aloud',
      description:
        'Read individual rows out loud, a few at a time, when they genuinely want the records rather ' +
        'than a summary. Reach for this only after describing or querying the table — reading rows is ' +
        'slow over audio and is the thing this whole tool exists to avoid. Each row is spoken as its ' +
        'label plus the columns asked for, never as cell coordinates. Returns at most five rows and a ' +
        'token; call it again with the token when they say to keep going.',
      inputSchema: {
        table_id: text(),
        sheet: text().optional().describe(SHEET_HELP),
        columns: z
          .array(text())
          .max(20)
          .optional()
          .describe('Which columns to read. Omit to read them all.'),
        start_row: z.number().int().min(1).default(1).describe('One-based row number within the data.'),
        // This tool told clients to "call it again with the token" and then had nowhere
        // to put one: the token was silently dropped and start_row from the previous
        // call was replayed, so "keep going" read the same five rows forever.
        cursor: text(20)
          .optional()
          .describe('Continuation token from a previous call. Takes precedence over start_row.'),
        limit: z.number().int().min(1).max(10).default(PAGE),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe('reading those rows', async ({ table_id, sheet, columns, start_row, cursor, limit }) => {
      const found = await located(index, store, table_id, sheet);
      if (isFailure(found)) return found;
      const { region } = found;

      const resumeAt = cursor === undefined ? start_row : Number.parseInt(cursor, 10);
      const from = Math.max(0, (Number.isFinite(resumeAt) ? resumeAt : 1) - 1);
      const slice = region.rows.slice(from, from + limit);
      if (slice.length === 0) {
        return fail(
          `This table only has ${plural(region.rowCount, 'row')}.`,
          'Ask for an earlier row.',
        );
      }

      // A column that matches nothing is an error that names the real ones. It used
      // to be silently dropped, and the reply was "Ann: . Ben: . Cal: ." — a row of
      // labels with nothing after them.
      let wanted: IndexColumn[] | undefined;
      if (columns?.length) {
        const byIndex = new Map<number, IndexColumn>();
        for (const name of columns) for (const c of within(found, () => matchColumns(region, name))) byIndex.set(c.i, c);
        wanted = [...byIndex.values()].sort((x, y) => x.i - y.i);
      }

      // Whole rows within the budget, and the cursor set to the first row NOT spoken.
      // Trimming the joined text afterwards used to drop rows four and five from the
      // speech while the cursor moved past them, so they were never heard at all; and
      // a row wider than the budget was cut mid-row, silently, with its last columns
      // skipped by the cursor. That row is now cut by whole columns, out loud.
      const suffix = ' Say more to continue.';
      const page = pageRows(region, slice.map((_, i) => from + i), wanted, SPOKEN_WORD_LIMIT - wordCount(suffix));
      const said = page.rows;
      const next = from + said.length;
      const more = next < region.rowCount;
      const totals = summaryRowsOf(region);
      const totalHere = said.map((_, i) => from + i).filter((i) => totals.has(i));

      return ok(page.text + (more ? suffix : ''), {
        rows: said,
        start_row: from + 1,
        returned: said.length,
        total_rows: region.rowCount,
        more_available: more,
        cursor: more ? String(next + 1) : null,
        ...(page.unread.length ? { row_truncated: true, columns_not_read: page.unread } : {}),
        ...(totalHere.length ? { summary_rows: totalHere.map((i) => i + 1) } : {}),
      });
    }),
  );

  // ── 6. table_compare ─────────────────────────────────────────────────────
  server.registerTool(
    'table_compare',
    {
      title: 'Compare two columns or two tables',
      description:
        'Compare one measure across two columns, or the same measure across two different tables or ' +
        'sheets. Use it for "how does this year compare with last", "which is bigger", or "what ' +
        'changed". It returns the two totals, the difference and the direction in one spoken ' +
        'sentence, so they do not have to hold two numbers in their head and subtract them.',
      inputSchema: {
        table_id: text(),
        sheet: text().optional().describe(SHEET_HELP),
        left_column: text().describe('First measure. Use the full heading when several share a name.'),
        right_column: text().describe('Second measure.'),
        right_table_id: text()
          .optional()
          .describe('Only when the second measure lives in a different file.'),
        right_sheet: text().optional().describe('Sheet or table number of the second measure, when it differs.'),
        aggregate: z
          .enum(['sum', 'avg', 'min', 'max'])
          .optional()
          .describe(
            'What to compare. Omit to compare totals, or averages for a percentage, a rate or a ' +
              'per-person figure, whose totals mean nothing.',
          ),
        filters: FILTERS.describe(
          'Row conditions applied to both sides, combined with AND: "for the north" is Region equal to ' +
            'North. They are said at the head of the answer. Omit to compare every row.',
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe('comparing those', async (args) => {
      const left = await located(index, store, args.table_id, args.sheet);
      if (isFailure(left)) return left;
      const right = await located(
        index,
        store,
        args.right_table_id ?? args.table_id,
        args.right_sheet ?? args.sheet,
      );
      if (isFailure(right)) return right;

      const lc = within(left, () => resolveColumn(left.region, args.left_column));
      const rc = within(right, () => resolveColumn(right.region, args.right_column));
      const filters = args.filters as FilterArg[];
      // Left unsaid, a comparison of amounts compares totals and one of rates their
      // averages. It always compared totals, so "how does this year's margin compare"
      // added up every row's percentage on each side and set the two sums against each
      // other. Asked for in so many words, a total of a rate is refused, as it is anywhere.
      const aggregate = args.aggregate ?? (rateLike(lc, left.region) || rateLike(rc, right.region) ? 'avg' : 'sum');
      const a = within(left, () =>
        runQuery(left.region, { filters, aggregate, aggregateColumn: args.left_column }),
      );
      const b = within(right, () =>
        runQuery(right.region, { filters, aggregate, aggregateColumn: args.right_column }),
      );
      const conditions = conditionsSaid(left.region, filters);

      if (a.result === null || b.result === null) {
        return filters.length && (a.matchedRows === 0 || b.matchedRows === 0)
          ? fail(
              `No row matches ${conditions.replace(/^For /, '').replace(/, $/, '')}, so there is nothing to compare.`,
              'Check the value, or compare the whole table.',
            )
          : fail('One of those columns had no numbers to compare.', 'Check the column names, or ask me to describe the table.');
      }

      // Differences of sums of cents carry binary noise; 30.3 against 30.3 used to be
      // "0 less than". Anything below the twelfth significant digit is the same.
      const av = tidy(a.result);
      const bv = tidy(b.result);
      const raw = tidy(av - bv);
      const diff = Math.abs(raw) <= Math.max(Math.abs(av), Math.abs(bv)) * 1e-12 ? 0 : raw;
      const dir = diff === 0 ? 'the same as' : diff > 0 ? 'more than' : 'less than';
      const pct = diff !== 0 && bv !== 0 ? Math.abs((diff / bv) * 100) : null;
      const pctPhrase =
        pct === null || pct >= 1000 ? '' : pct < 1 ? ', less than 1%' : `, about ${Math.round(pct)}%`;

      // "Revenue is 61 thousand more than Revenue" names nothing. When both sides
      // share a name, say where each one lives.
      let ln = columnName(lc);
      let rn = columnName(rc);
      if (ln.toLowerCase() === rn.toLowerCase()) {
        if (left.table.id !== right.table.id) {
          ln = `${ln} in ${cleanText(left.table.title, 60)}`;
          rn = `${rn} in ${cleanText(right.table.title, 60)}`;
        } else if (left.region.sheet !== right.region.sheet) {
          ln = `${ln} on ${cleanText(left.region.sheet, 60)}`;
          rn = `${rn} on ${cleanText(right.region.sheet, 60)}`;
        } else if (left.region.id !== right.region.id) {
          ln = `${ln} in table ${left.n}`;
          rn = `${rn} in table ${right.n}`;
        }
      }

      const side = (
        l: typeof left,
        c: IndexColumn,
        q: typeof a,
        name: string,
      ): AnswerPart => ({
        label: name,
        tableId: l.table.id,
        regionId: l.region.id,
        sheet: l.region.sheet,
        cells: q.provenance.cells,
        cellCount: q.provenance.cellCount,
        excluded: q.provenance.excluded,
        path: c.path,
        aggregate,
        ...(q.winners.length
          ? {
              winners: q.provenance.cells.slice(0, q.winners.length),
              winnerLabels: winnerLabels(l.region, q.winners),
              winnerCount: q.winnerCount,
            }
          : {}),
        // Each operand records its own reading and its own file version, so a
        // correction to either side marks the comparison as stale.
        structureRevision: l.revision,
        headerRows: l.region.headerRows.length,
        ingestedAt: l.table.ingestedAt,
      });

      // Anything but a total is named on both sides: an average compared without the word
      // sounds exactly like a total.
      const measured = { sum: '', avg: 'average ', max: 'highest ', min: 'lowest ' }[aggregate];
      const lw = measured + ln;
      const rw = measured + rn;

      const about = cleanText(`${lw} against ${rw}${conditionsTail(left.region, filters)}`, ABOUT_CHARS);
      const answerId = await keepAnswer(store, {
        parts: [side(left, lc, a, ln), side(right, rc, b, rn)],
        spec: { ...args, aggregate },
        structureRevision: left.revision,
        about,
      });

      // A total row left out of either side is said, as it is for any other answer:
      // "Amount and Amount are both 752 thousand" gave no hint that the sheet's own
      // Total row was not counted. Said once when both sides skipped the same thing.
      const leftNotes = queryNotes(left.region, a);
      const sameRegion = right.table.id === left.table.id && right.region.id === left.region.id;
      const rightNotes = sameRegion ? '' : queryNotes(right.region, b);
      const notes = rightNotes === leftNotes ? leftNotes : leftNotes + rightNotes;

      // How either column's numbers were read, when that was a guess; once if they share it.
      const numberNotes = [...new Set([lc.numberNote, rc.numberNote].filter((n): n is string => Boolean(n)))]
        .map((n) => ` ${cleanText(n, 200)}`)
        .join('');
      // The gap between two percentages is in points. "4% more than …, about 27%" set a
      // difference of points beside a relative change, both said as percent, and now
      // that a comparison of margins compares them by default, every one was said so.
      const points = lc.kind === 'percent' && rc.kind === 'percent';
      const gap = points
        ? `${speakAmount(Math.abs(diff))} percentage ${tidy(Math.abs(diff)) === 1 ? 'point' : 'points'}`
        : speakAmount(Math.abs(diff), lc.kind);
      const sentence =
        diff === 0
          ? `${lw} and ${rw} are both ${speakAmount(av, lc.kind)}.`
          : `${lw} is ${gap} ${dir} ${rw}${pctPhrase}: ` +
            `${speakAmount(av, lc.kind)} against ${speakAmount(bv, rc.kind)}.`;
      const spoken =
        capWords(
          conditions + (conditions || !measured ? sentence : sentence.charAt(0).toUpperCase() + sentence.slice(1)),
          HEADLINE_WORD_LIMIT + 10 + wordCount(conditions) + wordCount(measured) * 2 + (points ? 2 : 0),
        ) +
        notes +
        numberNotes +
        (structureCaveat(left.region) || structureCaveat(right.region));

      return ok(spoken, {
        // With the id, what the answer was in a few words: a client that explains it after
        // other questions can name it in the words table_explain's `restate` uses.
        ...(answerId ? { answer_id: answerId, answer_about: about } : { working_kept: false }),
        ...(filters.length ? { filters_applied: filters } : {}),
        left: { name: lc.spoken, value: av, exact: exactNumber(av) },
        right: { name: rc.spoken, value: bv, exact: exactNumber(bv) },
        difference: diff,
        exact_difference: exactNumber(diff),
        percent_difference: pct,
        ...structureFlags(left.region),
        ...structureFlags(right.region),
      });
    }),
  );

  // ── 7. table_bookmark ────────────────────────────────────────────────────
  server.registerTool(
    'table_bookmark',
    {
      title: 'Save a place to come back to',
      description:
        'Save where they are in a table so they can pick it up later in this conversation. Offer it ' +
        'unprompted when someone has been working through a long table and ' +
        'sounds like they are stopping. Give the bookmark a short name they chose, or describe the ' +
        'place if they did not.',
      inputSchema: {
        name: text().describe('A short name they will recognise, like "budget review".'),
        table_id: text(),
        sheet: text().optional().describe(SHEET_HELP),
        row: z.number().int().min(1).default(1).describe('One-based row number within the data.'),
        note: text(500).optional().describe('Anything they want said back to them on return.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe('saving that place', async ({ name, table_id, sheet, row, note }) => {
      const found = await located(index, store, table_id, sheet);
      if (isFailure(found)) return found;
      const { table, region } = found;
      if (!name.trim()) {
        return fail('A bookmark needs a name.', 'Ask what they would like to call this place.');
      }
      if (row > region.rowCount) {
        return fail(
          `This table only has ${plural(region.rowCount, 'row')}.`,
          `Choose a row from 1 to ${region.rowCount}.`,
        );
      }

      await store.putBookmark(name, {
        tableId: table.id,
        regionId: region.id,
        rowIndex: Math.max(0, row - 1),
        note: note ?? null,
        savedAt: new Date().toISOString(),
        // What the row number meant when it was saved, so a return after the file or
        // its reading has changed can say so instead of landing somewhere else quietly.
        ingestedAt: table.ingestedAt,
        structureRevision: found.revision,
        headerRows: region.headerRows.length,
      });

      return ok(
        capWords(
          `Saved "${cleanText(name, 60)}" at row ${row} of ${cleanText(region.title ?? table.title, 80)}.`,
          HEADLINE_WORD_LIMIT,
        ),
        { name, table_id: table.id, row },
      );
    }),
  );

  // ── 8. table_resume ──────────────────────────────────────────────────────
  server.registerTool(
    'table_resume',
    {
      title: 'Return to a saved place',
      description:
        'Pick up from a saved bookmark. Call this when they say they want to carry on, get back to ' +
        'something, or name a bookmark. It re-orients them first — which table, which row, and what ' +
        'they noted — before reading anything, because they may not have been here for days. Omit ' +
        'the name to return to the most recent one.',
      inputSchema: {
        name: text().optional().describe('Bookmark name. Omit for the most recent.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe('finding that place', async ({ name: asked }) => {
      // "Carry on" after a page reload has no name to send. It used to list the
      // bookmarks and stop, so the one phrase that means "take me back" never did.
      let name = asked?.trim() ? asked : undefined;
      let others: string[] = [];
      if (!name) {
        const all = await store.listBookmarks();
        if (!all.length) return ok('Nothing is saved yet.', { bookmarks: [] });
        const newest = [...all].sort((x, y) => y.mark.savedAt.localeCompare(x.mark.savedAt));
        name = newest[0]!.name;
        others = newest.slice(1).map((b) => b.name);
      }

      const mark = await store.getBookmark(name);
      if (!mark) {
        const all = await store.listBookmarks();
        // With nothing saved at all, the next step says how to save, not the same
        // thing twice: "carry on" in a fresh browser used to hear "Nothing is saved
        // under my place. Nothing is saved yet."
        return fail(
          `Nothing is saved under "${cleanText(name, 60)}".`,
          all.length
            ? `You have ${speakList(all.slice(0, 5).map((b) => cleanText(b.name, 60)))}.`
            : 'Ask me to save your place while reading, and I can bring you back to it.',
        );
      }

      const found = await located(index, store, mark.tableId, mark.regionId);
      if (isFailure(found)) return found;
      const { table, region } = found;

      const where = `${cleanText(region.title ?? table.title, 80)}, row ${mark.rowIndex + 1} of ${region.rowCount}`;
      // The note is their own words, returned as data: flattened to one line and
      // bounded, so it cannot break the sentence it is read inside.
      const noted = mark.note ? ` You noted: ${cleanText(mark.note, 200)}.` : '';
      const reloaded = mark.ingestedAt !== undefined && mark.ingestedAt !== table.ingestedAt;
      // Judged by heading count where the bookmark recorded one: confirming the
      // reading in use bumps the revision but moves no row.
      const reread =
        mark.headerRows !== undefined
          ? mark.headerRows !== region.headerRows.length
          : mark.structureRevision !== undefined && mark.structureRevision !== found.revision;
      const changed = reloaded
        ? ' The file has been loaded again since you saved this, so that row may hold something different now.'
        : reread
          ? ' How this table is read has changed since you saved this, so the row number may point somewhere else.'
          : '';
      const also = others.length
        ? ` You also have ${speakList(
            others.length > 3
              ? [...others.slice(0, 3).map((o) => cleanText(o, 60)), `${others.length - 3} more`]
              : others.map((o) => cleanText(o, 60)),
          )}.`
        : '';

      return ok(capWords(`Back in ${where}.${noted}`, HEADLINE_WORD_LIMIT + 10) + changed + also, {
        name,
        table_id: table.id,
        sheet: region.sheet,
        // The sheet alone reopens its first table; a bookmark in table 2 of a sheet
        // holding three has to be resumed by the region itself.
        region_id: region.id,
        row: mark.rowIndex + 1,
        note: mark.note,
        row_spoken: mark.rowIndex < region.rowCount ? speakRow(region, mark.rowIndex) : null,
        ...(others.length ? { others } : {}),
        ...(changed ? { changed_since_saved: true } : {}),
      });
    }),
  );
}
