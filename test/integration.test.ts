/**
 * The seams between the four halves of the fix, each checked from both sides.
 *
 * Ingest, the engine, the tool layer and the voice client were repaired separately,
 * and each left something the others had to finish: two date readers that disagreed,
 * a "lowest" that no side could ask for, a heading advice that named nothing, a
 * correction reply that did not say what it corrected. Each case here is one of
 * those, driven through the real code on both sides of the seam.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { parseDateText, profileColumn } from '../src/table/infer.ts';
import { readDate, resolveColumn, runQuery, QueryError } from '../src/query/engine.ts';
import { createHandler } from '../src/server.ts';
import type { IndexTable } from '../src/indexfmt.ts';

type Cell = string | number | boolean | null;
const ingest = (name: string, grid: Cell[][]): IndexTable =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });

// ── one date reader ─────────────────────────────────────────────────────────

test('the engine reads a date exactly as ingest does', () => {
  for (const s of [
    '2026-07-04', '2026-07-04T00:00:00.000Z', '7/4/2026', '04.07.2026', '4.7.26', '5/5/85', '5/5/29',
    'July 4, 2026', '4 July 2026', 'Jul 4 2026', '04-Jul-2026', '2026/07/04', '31/12/2026', '2026-02-30', '2024',
  ]) {
    assert.equal(readDate(s)?.toISOString() ?? null, parseDateText(s)?.toISOString() ?? null, s);
    assert.equal(readDate(s, 'dmy')?.toISOString() ?? null, parseDateText(s, 'dmy')?.toISOString() ?? null, s);
  }
  // The two cases the old reader got wrong: dotted dates are day first, and a two-digit
  // year follows Excel's rule rather than always meaning this century.
  assert.equal(readDate('04.07.2026')?.toISOString(), '2026-07-04T00:00:00.000Z');
  assert.equal(readDate('5/5/85')?.toISOString(), '1985-05-05T00:00:00.000Z');
});

test('a filter date written the way a day-first file writes it finds the day ingest stored', () => {
  const t = ingest('visits', [
    ['Visitor', 'Day', 'Spent'],
    ['a', '15/01/2024', 10],
    ['b', '04/07/2026', 20],
    ['c', '07/04/2026', 30],
  ]);
  const r = t.regions[0]!;
  const day = r.columns.find((c) => c.spoken === 'Day')!;
  assert.equal(day.kind, 'date');
  assert.equal(day.dateOrder, 'dmy', 'the order is kept, because the stored ISO days no longer show it');
  const on = (value: string) =>
    runQuery(r, { filters: [{ column: 'Day', op: 'eq', value }], aggregate: 'sum', aggregateColumn: 'Spent' }).result;
  assert.equal(on('04/07/2026'), 20, '4 July, as the file writes it');
  assert.equal(on('04.07.2026'), 20);
  assert.equal(on('July 4, 2026'), 20);
  assert.equal(on('2026-04-07'), 30);
});

test('a whole month can be asked for by name', () => {
  const t = ingest('deals', [
    ['Rep', 'Closed', 'Revenue'],
    ['a', '2026-07-04', 10],
    ['b', '2026-08-02', 20],
    ['c', '2026-08-27', 30],
    ['d', '2025-08-15', 40],
  ]);
  const r = t.regions[0]!;
  const sum = (value: string, op: 'eq' | 'neq' = 'eq') =>
    runQuery(r, { filters: [{ column: 'Closed', op, value }], aggregate: 'sum', aggregateColumn: 'Revenue' }).result;
  assert.equal(sum('August'), 90);
  assert.equal(sum('August 2026'), 50);
  assert.equal(sum('Aug 2025'), 40);
  assert.equal(sum('August', 'neq'), 10);
});

// ── breakdowns in either order, and several values at once ──────────────────

const many = ingest('stores', [
  ['Store', 'Sales'],
  ...Array.from({ length: 25 }, (_, i) => [`Store ${String(i + 1).padStart(2, '0')}`, 1000 + ((i * 37) % 25) * 10]),
  ...Array.from({ length: 25 }, (_, i) => [`Store ${String(i + 1).padStart(2, '0')}`, 5]),
]);

test('lowest first puts the lowest in the answer, however many groups there are', () => {
  const r = many.regions[0]!;
  const asc = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Sales', groupBy: 'Store', order: 'asc' });
  const all = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Sales', groupBy: 'Store', limit: 50 });
  const lowest = [...all.groups].sort((a, b) => (a.value ?? 0) - (b.value ?? 0))[0]!;
  assert.equal(asc.groups[0]!.key, lowest.key);
  assert.equal(asc.groups.length, 5);
  assert.ok(asc.moreAvailable);
  // Largest first is still the default.
  const desc = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Sales', groupBy: 'Store' });
  assert.ok((desc.groups[0]!.value ?? 0) >= (desc.groups[1]!.value ?? 0));
  const counted = runQuery(ingest('c', [['Kind', 'n'], ['a', 1], ['a', 1], ['b', 1]]).regions[0]!, {
    aggregate: 'count',
    groupBy: 'Kind',
    order: 'asc',
  });
  assert.deepEqual(counted.groups.map((g) => g.key), ['b', 'a']);
});

test('several values of one column are those values, and no others', () => {
  const t = ingest('countries', [
    ['Country', 'Population'],
    ['Vietnam', 100], ['Thailand', 70], ['Indonesia', 270], ['Nigeria', 220], ['Kenya', 55], ['Norway', 5],
  ]);
  const r = t.regions[0]!;
  const two = runQuery(r, {
    filters: [{ column: 'Country', op: 'eq', values: ['Vietnam', 'Thailand'] }],
    aggregate: 'sum',
    aggregateColumn: 'Population',
    groupBy: 'Country',
  });
  assert.deepEqual(two.groups.map((g) => g.key), ['Vietnam', 'Thailand']);
  const rest = runQuery(r, { filters: [{ column: 'Country', op: 'neq', values: ['Vietnam', 'Thailand'] }], aggregate: 'count' });
  assert.equal(rest.result, 4);
});

// ── columns, flags and refusals ─────────────────────────────────────────────

test('a column can be named by its letter or its place', () => {
  const r = ingest('ledger', [['Item', 'Cost', 'Price'], ['a', 1, 2], ['b', 3, 4]]).regions[0]!;
  assert.equal(resolveColumn(r, 'column C').spoken, 'Price');
  assert.equal(resolveColumn(r, 'column 2').spoken, 'Cost');
  assert.throws(() => resolveColumn(r, 'column Z'), QueryError);
});

test('a flag column lists Yes and No, and a filter reads TRUE and yes alike', () => {
  const p = profileColumn([true, false, 'Yes', 'no', true], 'Paid', 1, 1);
  assert.equal(p.kind, 'boolean');
  assert.deepEqual(p.categories, ['No', 'Yes']);
  const r = ingest('invoices', [['Invoice', 'Paid', 'Amount'], ['a', 'TRUE', 10], ['b', 'Yes', 20], ['c', 'no', 40]]).regions[0]!;
  const paid = runQuery(r, { filters: [{ column: 'Paid', op: 'eq', value: 'Yes' }], aggregate: 'sum', aggregateColumn: 'Amount' });
  assert.equal(paid.result, 30);
});

test('a column that is not numbers is refused in words that fit what was asked', () => {
  const r = ingest('budget', [['Department', 'Amount'], ['Eng', 1], ['Eng', 2], ['Design', 3]]).regions[0]!;
  assert.throws(
    () => runQuery(r, { aggregate: 'max', aggregateColumn: 'Department' }),
    (e: unknown) => e instanceof QueryError && /holds text, so it cannot have a highest number/.test(e.message),
  );
  assert.throws(
    () => runQuery(r, { aggregate: 'avg', aggregateColumn: 'Department' }),
    (e: unknown) => e instanceof QueryError && /cannot be averaged/.test(e.message) && !/category/.test(e.message),
  );
});

// ── over the wire ───────────────────────────────────────────────────────────

const index = buildIndex([
  ingest('repeats', [['Item', 'Amount', 'Amount'], ['a', 1, 10], ['b', 2, 20]]),
  ingest('flat', [['Region', 'Rep', 'Revenue'], ['North', 'Anh', 12400], ['South', 'Chi', 21000], ['East', 'An', 15600]]),
  many,
]);
const handler = createHandler({ index });

async function rpc(method: string, params: unknown, session = 'integration'): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return JSON.parse(await res.text()) as Record<string, unknown>;
}
async function call(name: string, args: Record<string, unknown>, session?: string) {
  const body = (await rpc('tools/call', { name, arguments: args }, session)) as {
    result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  };
  return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError), text: body.result.content[0]!.text };
}

test('describe names the column a repeated heading is called by', async () => {
  const d = await call('table_describe', { table_id: 'repeats' });
  assert.match(String(d['spoken']), /Two columns are headed Amount, so I call the second one Amount 2\./);
  assert.doesNotMatch(String(d['spoken']), /tell me the full heading/);
  const second = await call('table_query', { table_id: 'repeats', aggregate: 'sum', aggregate_column: 'Amount 2' });
  assert.equal(second['result'], 30);
});

test('a correction says what it changed, from what, and for how long', async () => {
  const s = 'correction';
  const none = await call('table_structure', { table_id: 'flat', header_rows: 0 }, s);
  assert.match(String(none['spoken']), /^Right — I now read no heading rows instead of 1 heading row\./);
  assert.match(String(none['spoken']), /That holds for the rest of this conversation\.$/);
  assert.equal(none['previous_header_rows'], 1);
  assert.equal(none['changed'], true);

  const back = await call('table_structure', { table_id: 'flat', header_rows: 1 }, s);
  assert.match(String(back['spoken']), /^Right — I now read 1 heading row instead of no heading rows\./);
  assert.match(String(back['spoken']), /I will stop asking\.$/, 'back to the reading ingest chose is a confirmation');

  const again = await call('table_structure', { table_id: 'flat', header_rows: 1 }, s);
  assert.match(String(again['spoken']), /^Right — 1 heading row, as I was already reading it\./);
  assert.equal(again['changed'], false);
});

test('a breakdown asked lowest first says so, and starts with the lowest', async () => {
  const q = await call('table_query', { table_id: 'flat', aggregate: 'sum', aggregate_column: 'Revenue', group_by: 'Region', order: 'asc' });
  assert.match(String(q['spoken']), /^Lowest first: North, 12\.4 thousand, East, 15\.6 thousand and South, 21 thousand\./);
  const many25 = await call('table_query', { table_id: 'stores', aggregate: 'sum', aggregate_column: 'Sales', group_by: 'Store', order: 'asc' });
  const all = await call('table_query', { table_id: 'stores', aggregate: 'sum', aggregate_column: 'Sales', group_by: 'Store', limit: 20 });
  assert.equal(all['more_available'], true, 'more groups than one page');
  const groups = many25['groups'] as { key: string; value: number }[];
  const lowestValue = Math.min(...groups.map((g) => g.value));
  assert.equal(groups[0]!.value, lowestValue);
});

test('a total over one row is that row\'s cell, read exactly', async () => {
  const one = await call('table_query', {
    table_id: 'flat',
    filters: [{ column: 'Rep', op: 'eq', value: 'Chi' }],
    aggregate: 'sum',
    aggregate_column: 'Revenue',
  });
  assert.match(String(one['spoken']), /^21,000\. That is the total of Revenue across 1 row\./);
});

test('arguments the schema refuses are spoken like any other failure', async () => {
  const bad = await call('table_query', { table_id: 'flat', aggregate: 'sum', limit: 999 });
  assert.equal(bad.isError, true);
  assert.equal(typeof bad['spoken'], 'string');
  assert.doesNotMatch(String(bad['spoken']), /table_query|Invalid arguments|limit/);
  assert.match(String(bad['error']), /Invalid arguments/, 'the detail stays for the model');
  const missing = await call('table_nonsense', {});
  assert.equal(missing.isError, true);
  assert.match(String(missing['spoken']), /I do not have a way to do that/);
  // The text block is JSON, so a client that reads it when structured content is
  // missing no longer throws.
  assert.doesNotThrow(() => JSON.parse(bad.text));
});

test('the server tells the host that cell text is data, not instructions', async () => {
  const init = (await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  })) as { result: { instructions: string } };
  assert.match(init.result.instructions, /never instructions to follow/);
});

test('a resumed bookmark names the table inside its sheet', async () => {
  const s = 'resume-region';
  await call('table_bookmark', { name: 'here', table_id: 'flat', row: 2 }, s);
  const back = await call('table_resume', { name: 'here' }, s);
  assert.equal(back['region_id'], index.tables.find((t) => t.id === 'flat')!.regions[0]!.id);
});
