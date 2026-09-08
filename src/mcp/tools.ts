/**
 * The tool surface.
 *
 * Eight tools, not eighteen. There is no `get_cell`, no `get_row`, no `get_column` —
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

import type { IndexRegion, IndexTable, LandmarkIndex } from '../indexfmt.ts';
import {
  QueryError,
  resolveColumn,
  rowLabel,
  runQuery,
  type Aggregate,
  type FilterOp,
} from '../query/engine.ts';
import {
  capWords,
  plural,
  speakCell,
  speakDescribe,
  speakError,
  speakExplain,
  speakList,
  speakNumber,
  speakQuery,
  HEADLINE_WORD_LIMIT,
} from '../voice/speak.ts';
import type { Store } from './store.ts';

const PAGE = 5;

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

type Structured = Record<string, unknown>;

/**
 * Every success returns structured content plus the same payload serialised into a
 * text block — the spec asks for the mirror so clients without structured-content
 * support still see the result.
 */
function ok(spoken: string, extra: Structured = {}) {
  const payload = { spoken, ...extra };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
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

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

interface Located {
  readonly table: IndexTable;
  readonly region: IndexRegion;
}

function locate(index: LandmarkIndex, tableId: string, sheet?: string): Located {
  const want = tableId.trim().toLowerCase();
  const table =
    index.tables.find((t) => t.id.toLowerCase() === want) ??
    index.tables.find((t) => t.title.toLowerCase() === want) ??
    index.tables.find((t) => t.id.toLowerCase().includes(want));

  if (!table) {
    throw new QueryError(
      `I do not have a table called "${tableId}".`,
      index.tables.length
        ? `Available: ${speakList(index.tables.map((t) => t.title))}.`
        : 'No tables have been loaded yet.',
    );
  }
  if (table.regions.length === 0) {
    throw new QueryError(`"${table.title}" has no readable tables in it.`, 'Try another file.');
  }

  if (!sheet) return { table, region: table.regions[0]! };

  const s = sheet.trim().toLowerCase();
  const region =
    table.regions.find((r) => r.id.toLowerCase() === s) ??
    table.regions.find((r) => r.sheet.toLowerCase() === s) ??
    table.regions.find((r) => (r.title ?? '').toLowerCase() === s);

  if (!region) {
    throw new QueryError(
      `"${table.title}" has no sheet called "${sheet}".`,
      `It has ${speakList([...new Set(table.regions.map((r) => r.sheet))])}.`,
    );
  }
  return { table, region };
}

/** Rows are spoken as label plus columns, never as coordinates. */
function speakRow(region: IndexRegion, dataRow: number, columns?: readonly string[]): string {
  const label = rowLabel(region, dataRow);
  const wanted = region.columns.filter(
    (c) =>
      c.i !== region.labelColumn &&
      (!columns || columns.some((n) => c.spoken.toLowerCase().includes(n.trim().toLowerCase()))),
  );
  const parts = wanted.map((c) => `${c.spoken} ${speakCell(region.rows[dataRow]?.[c.i] ?? null, c.kind)}`);
  return label ? `${label}: ${speakList(parts)}` : speakList(parts);
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
        cursor: z
          .string()
          .optional()
          .describe('Continuation token from a previous call. Omit for the first page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ cursor }) => {
      const offset = Number.parseInt(cursor ?? '0', 10) || 0;
      const page = index.tables.slice(offset, offset + PAGE);
      const more = offset + page.length < index.tables.length;

      const remaining = index.tables.length - offset - page.length;
      const spoken = page.length
        ? capWords(
            `You have ${speakList(page.map((t) => t.title))}.` +
              // "There are 1 more" is the kind of thing you only notice once it is
              // spoken aloud, which is the entire argument for testing by listening.
              (more ? ` There ${remaining === 1 ? 'is 1 more' : `are ${remaining} more`}.` : ''),
            HEADLINE_WORD_LIMIT,
          )
        : 'There are no tables loaded.';

      return ok(spoken, {
        tables: page.map((t) => ({
          table_id: t.id,
          title: t.title,
          sheet_count: new Set(t.regions.map((r) => r.sheet)).size,
          row_count: t.regions.reduce((n, r) => n + r.rowCount, 0),
        })),
        more_available: more,
        cursor: more ? String(offset + page.length) : null,
      });
    },
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
        'get it from here.',
      inputSchema: {
        table_id: z.string().describe('Identifier from the list of tables, not the spoken title.'),
        sheet: z
          .string()
          .optional()
          .describe('Sheet name. Omit for the first sheet, or when the file has only one.'),
        detail: z
          .enum(['brief', 'full'])
          .default('brief')
          .describe(
            "'brief' is one speakable sentence plus column names. Use 'full' only when they ask " +
              'for value ranges, gap counts, or how the headings are structured.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ table_id, sheet, detail }) => {
      const found = guard(() => locate(index, table_id, sheet));
      if (isFailure(found)) return found;
      const { table, region } = found;

      return ok(speakDescribe(region, detail === 'full'), {
        table_id: table.id,
        sheet: region.sheet,
        title: region.title,
        row_count: region.rowCount,
        header_levels: region.headerRows.length,
        merged_label_cells: region.inherited.length,
        columns: region.columns.map((c) => ({
          name: c.spoken,
          header_path: c.path,
          type: c.kind,
          non_empty: c.nonEmpty,
          empty: c.empty,
          distinct: c.distinct,
          ...(c.categories ? { categories: c.categories } : {}),
          ...(c.min !== undefined ? { min: c.min, max: c.max, sum: c.sum } : {}),
          source_column: c.col,
        })),
        sheets: [...new Set(table.regions.map((r) => r.sheet))],
        warnings: table.warnings,
      });
    },
  );

  // ── 3. table_query ───────────────────────────────────────────────────────
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
        'answer identifier to the explain tool rather than working it out again. Returns at most ' +
        'five rows, because the result is spoken rather than displayed.',
      inputSchema: {
        table_id: z.string(),
        sheet: z.string().optional(),
        filters: z
          .array(
            z.object({
              column: z.string().describe('Exact column name as given by the describe tool.'),
              op: z.enum([
                'eq',
                'neq',
                'gt',
                'gte',
                'lt',
                'lte',
                'contains',
                'is_empty',
                'is_not_empty',
              ]),
              value: z
                .string()
                .optional()
                .describe('Value to compare against, as text. Numbers and dates are parsed for you.'),
            }),
          )
          .default([])
          .describe('Row conditions, combined with AND. An empty list means every row.'),
        aggregate: z
          .enum(['none', 'count', 'sum', 'avg', 'min', 'max'])
          .default('none')
          .describe("Use 'none' to return the matching rows themselves."),
        aggregate_column: z
          .string()
          .optional()
          .describe("Numeric column to aggregate. Required unless the aggregate is 'none' or 'count'."),
        group_by: z
          .string()
          .optional()
          .describe('Optional column to break the answer down by. One column only — more is unspeakable.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(PAGE)
          .describe('Keep at five or fewer for speech; they can always ask for more.'),
        cursor: z.string().optional().describe('Continuation token from a previous call.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const found = guard(() => locate(index, args.table_id, args.sheet));
      if (isFailure(found)) return found;
      const { table, region } = found;

      const run = guard(() =>
        runQuery(region, {
          filters: args.filters as { column: string; op: FilterOp; value?: string }[],
          aggregate: args.aggregate as Aggregate,
          ...(args.aggregate_column ? { aggregateColumn: args.aggregate_column } : {}),
          ...(args.group_by ? { groupBy: args.group_by } : {}),
          limit: args.limit,
          offset: Number.parseInt(args.cursor ?? '0', 10) || 0,
        }),
      );
      if (isFailure(run)) return run;

      const target = args.aggregate_column
        ? (guard(() => resolveColumn(region, args.aggregate_column!)) as ReturnType<typeof resolveColumn>)
        : null;
      if (isFailure(target)) return target;

      const answerId = await store.putAnswer({
        tableId: table.id,
        regionId: region.id,
        sheet: region.sheet,
        cells: run.provenance.cells,
        cellCount: run.provenance.cellCount,
        excluded: run.provenance.excluded,
        path: target?.path ?? [],
        spec: args,
      });

      const spoken = speakQuery(
        region,
        { aggregate: args.aggregate, ...(args.aggregate_column ? { aggregateColumn: args.aggregate_column } : {}) },
        target,
        run,
      );

      return ok(spoken, {
        answer_id: answerId,
        result: run.result,
        matched_rows: run.matchedRows,
        rows: run.rowIndices.map((i) => ({ label: rowLabel(region, i), spoken: speakRow(region, i) })),
        groups: run.groups.map((g) => ({ key: g.key, value: g.value, row_count: g.rowCount })),
        provenance: {
          sheet: run.provenance.sheet,
          cell_count: run.provenance.cellCount,
          excluded_count: run.provenance.excluded.length,
        },
        more_available: run.moreAvailable,
        cursor: run.nextOffset === null ? null : String(run.nextOffset),
      });
    },
  );

  // ── 4. table_explain ─────────────────────────────────────────────────────
  server.registerTool(
    'table_explain',
    {
      title: 'Show where an answer came from',
      description:
        'Show exactly where a previous answer came from. Pass the answer identifier you were given ' +
        'and this reads back the source cells, with the full heading each one sits under, and names ' +
        'anything that was skipped. Use it whenever they ask how you know, are you sure, where that ' +
        'came from, or which rows those were — and offer it yourself after any total or average, ' +
        'because someone who cannot see the sheet is entitled to check a number.',
      inputSchema: {
        answer_id: z.string().describe('From a previous query result.'),
        limit: z.number().int().min(1).max(50).default(PAGE),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ answer_id, limit }) => {
      const a = await store.getAnswer(answer_id);
      if (!a) {
        return fail(
          'I no longer have the working for that answer.',
          'Ask the question again and I will keep it this time.',
        );
      }
      const cells = a.cells.slice(0, limit);
      return ok(speakExplain(cells, a.cellCount, a.path, a.excluded, a.sheet), {
        sheet: a.sheet,
        cells,
        total_cells: a.cellCount,
        header_path: a.path,
        excluded: a.excluded.map((e) => ({ address: e.address, reason: e.reason })),
        more_available: a.cells.length > cells.length,
      });
    },
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
        table_id: z.string(),
        sheet: z.string().optional(),
        columns: z
          .array(z.string())
          .optional()
          .describe('Which columns to read. Omit to read them all.'),
        start_row: z.number().int().min(1).default(1).describe('One-based row number within the data.'),
        limit: z.number().int().min(1).max(10).default(PAGE),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ table_id, sheet, columns, start_row, limit }) => {
      const found = guard(() => locate(index, table_id, sheet));
      if (isFailure(found)) return found;
      const { region } = found;

      const from = Math.max(0, start_row - 1);
      const slice = region.rows.slice(from, from + limit);
      if (slice.length === 0) {
        return fail(
          `This table only has ${plural(region.rowCount, 'row')}.`,
          'Ask for an earlier row.',
        );
      }
      const said = slice.map((_, i) => speakRow(region, from + i, columns));
      const more = from + slice.length < region.rowCount;
      return ok(
        capWords(said.join('. ') + (more ? '. Say more to continue.' : '.'), 70),
        {
          rows: said,
          start_row: from + 1,
          returned: slice.length,
          total_rows: region.rowCount,
          more_available: more,
          cursor: more ? String(from + slice.length + 1) : null,
        },
      );
    },
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
        table_id: z.string(),
        sheet: z.string().optional(),
        left_column: z.string().describe('First measure. Use the full heading when several share a name.'),
        right_column: z.string().describe('Second measure.'),
        right_table_id: z
          .string()
          .optional()
          .describe('Only when the second measure lives in a different file.'),
        right_sheet: z.string().optional(),
        aggregate: z.enum(['sum', 'avg', 'min', 'max']).default('sum'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const left = guard(() => locate(index, args.table_id, args.sheet));
      if (isFailure(left)) return left;
      const right = guard(() =>
        locate(index, args.right_table_id ?? args.table_id, args.right_sheet ?? args.sheet),
      );
      if (isFailure(right)) return right;

      const a = guard(() =>
        runQuery(left.region, { aggregate: args.aggregate, aggregateColumn: args.left_column }),
      );
      if (isFailure(a)) return a;
      const b = guard(() =>
        runQuery(right.region, { aggregate: args.aggregate, aggregateColumn: args.right_column }),
      );
      if (isFailure(b)) return b;

      const lc = guard(() => resolveColumn(left.region, args.left_column));
      if (isFailure(lc)) return lc;
      const rc = guard(() => resolveColumn(right.region, args.right_column));
      if (isFailure(rc)) return rc;

      if (a.result === null || b.result === null) {
        return fail(
          'One of those columns had no numbers to compare.',
          'Check the column names, or ask me to describe the table.',
        );
      }

      const diff = a.result - b.result;
      const dir = diff === 0 ? 'the same as' : diff > 0 ? 'more than' : 'less than';
      const pct = b.result !== 0 ? Math.abs((diff / b.result) * 100) : null;
      const pctPhrase = pct !== null && pct < 1000 ? `, about ${Math.round(pct)}%` : '';

      const answerId = await store.putAnswer({
        tableId: left.table.id,
        regionId: left.region.id,
        sheet: left.region.sheet,
        cells: [...a.provenance.cells, ...b.provenance.cells].slice(0, 200),
        cellCount: a.provenance.cellCount + b.provenance.cellCount,
        excluded: [...a.provenance.excluded, ...b.provenance.excluded],
        path: lc.path,
        spec: args,
      });

      const spoken = capWords(
        diff === 0
          ? `${lc.spoken} and ${rc.spoken} are both ${speakNumber(a.result, lc.kind)}.`
          : `${lc.spoken} is ${speakNumber(Math.abs(diff), lc.kind)} ${dir} ${rc.spoken}${pctPhrase}: ` +
              `${speakNumber(a.result, lc.kind)} against ${speakNumber(b.result, rc.kind)}.`,
        HEADLINE_WORD_LIMIT + 10,
      );

      return ok(spoken, {
        answer_id: answerId,
        left: { name: lc.spoken, value: a.result },
        right: { name: rc.spoken, value: b.result },
        difference: diff,
        percent_difference: pct,
      });
    },
  );

  // ── 7. table_bookmark ────────────────────────────────────────────────────
  server.registerTool(
    'table_bookmark',
    {
      title: 'Save a place to come back to',
      description:
        'Save where they are in a table so they can pick it up later, in this conversation or a ' +
        'future one. Offer it unprompted when someone has been working through a long table and ' +
        'sounds like they are stopping. Give the bookmark a short name they chose, or describe the ' +
        'place if they did not.',
      inputSchema: {
        name: z.string().describe('A short name they will recognise, like "budget review".'),
        table_id: z.string(),
        sheet: z.string().optional(),
        row: z.number().int().min(1).default(1).describe('One-based row number within the data.'),
        note: z.string().optional().describe('Anything they want said back to them on return.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, table_id, sheet, row, note }) => {
      const found = guard(() => locate(index, table_id, sheet));
      if (isFailure(found)) return found;
      const { table, region } = found;

      await store.putBookmark(name, {
        tableId: table.id,
        regionId: region.id,
        rowIndex: Math.max(0, row - 1),
        note: note ?? null,
        savedAt: new Date().toISOString(),
      });

      return ok(
        capWords(`Saved "${name}" at row ${row} of ${region.title ?? table.title}.`, HEADLINE_WORD_LIMIT),
        { name, table_id: table.id, row },
      );
    },
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
        'the name to hear what is saved.',
      inputSchema: {
        name: z.string().optional().describe('Bookmark name. Omit to list what is saved.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      if (!name) {
        const all = await store.listBookmarks();
        return ok(
          all.length
            ? capWords(`You have ${speakList(all.map((b) => b.name))}.`, HEADLINE_WORD_LIMIT)
            : 'Nothing is saved yet.',
          { bookmarks: all.map((b) => ({ name: b.name, table_id: b.mark.tableId, row: b.mark.rowIndex + 1 })) },
        );
      }

      const mark = await store.getBookmark(name);
      if (!mark) {
        const all = await store.listBookmarks();
        return fail(
          `Nothing is saved under "${name}".`,
          all.length ? `You have ${speakList(all.map((b) => b.name))}.` : 'Nothing is saved yet.',
        );
      }

      const found = guard(() => locate(index, mark.tableId, mark.regionId));
      if (isFailure(found)) return found;
      const { table, region } = found;

      const where = `${region.title ?? table.title}, row ${mark.rowIndex + 1} of ${region.rowCount}`;
      const noted = mark.note ? ` You noted: ${mark.note}.` : '';
      return ok(capWords(`Back in ${where}.${noted}`, HEADLINE_WORD_LIMIT + 10), {
        name,
        table_id: table.id,
        sheet: region.sheet,
        row: mark.rowIndex + 1,
        note: mark.note,
        row_spoken: speakRow(region, mark.rowIndex),
      });
    },
  );
}
