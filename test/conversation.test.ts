/**
 * The demo conversation, driven end to end.
 *
 * Every case here is a sentence from the recorded demo script that did not work when
 * spoken to the real thing. The router had no tests at all, which is how a client that
 * answers the wrong file, sums the wrong column and cannot say "more" shipped as the
 * headline demo.
 *
 * These tests drive the actual server — `route()` picks a tool, the tool runs behind
 * the real MCP handler, and `absorb()` folds the real payload back into conversation
 * state before the next utterance. Hand-written payloads would have agreed with the
 * bugs, because the bugs were in what the client believed the server returned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createHandler } from '../src/server.ts';
import { assertIndex } from '../src/indexfmt.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { route, absorb, loadCatalogue, context } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(parsed);
const handler = createHandler({ index: parsed });

interface Routed {
  tool?: string;
  args?: Record<string, unknown>;
  speak?: string;
}

/** Call a tool directly, without routing or absorbing — what loadCatalogue needs. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } };
  return body.result.structuredContent ?? {};
}

/** One turn: route the utterance, run the tool for real, absorb the answer. */
async function say(utterance: string): Promise<{
  routed: Routed;
  spoken: string;
  payload: Record<string, unknown>;
}> {
  const routed = route(utterance) as Routed;
  if (!routed.tool) return { routed, spoken: routed.speak ?? '', payload: {} };

  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': session,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: routed.tool, arguments: routed.args ?? {} },
      }),
    }),
  );
  const body = JSON.parse(await res.text()) as {
    result: {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent: Record<string, unknown>;
    };
    error?: { message: string };
  };
  assert.ok(body.result, `tool ${routed.tool} failed at the protocol level: ${JSON.stringify(body.error)}`);
  const payload = body.result.structuredContent ?? {};
  absorb(routed.tool, routed.args ?? {}, payload);
  return { routed, spoken: String(payload['spoken'] ?? body.result.content[0]?.text ?? ''), payload };
}

let session = 'conv-0';
let seq = 0;

/** A fresh conversation: new server-side session, and client memory wiped. */
function reset(): void {
  session = `conv-${++seq}`;
  context.tableId = null;
  context.lastAnswerId = null;
  context.lastCursor = null;
  context.lastCall = null;
  context.columns = [];
  context.tables = [];
  context.pending = null;
  context.row = null;
  context.bookmarkName = null;
}

/** A fresh conversation, opened the way the app opens one: connect, then catalogue. */
async function start(): Promise<void> {
  reset();
  await loadCatalogue(call);
}

// ── naming a file ───────────────────────────────────────────────────────────

test('"the budget file" opens the budget table, not whichever was first', async () => {
  await start();

  const { routed } = await say("what's in the budget file");

  // The defect: "Budget" is the sheet name, and table_list did not report sheet names,
  // so nothing matched and the router silently described 01-flat instead. Describing
  // the wrong table is worse than failing, because nothing announces it went wrong.
  assert.equal(routed.tool, 'table_describe');
  assert.equal(
    routed.args?.['table_id'],
    '04-title-and-vmerge',
    'asked for the budget file and got a different table',
  );
});

test('a vague name still resolves by title', async () => {
  await start();
  const { routed } = await say('tell me about the countries one');
  assert.equal(routed.args?.['table_id'], '06-countries');
});

test('a word that is merely a substring does not select a table', async () => {
  await start();
  context.tableId = '01-flat';
  // "flatly" contains "flat", but nobody naming a table says it. Substring matching
  // let stray syllables steer the conversation.
  const { routed } = await say('read that back to me flatly');
  assert.notEqual(routed.tool, 'table_list');
});

// ── naming a column ─────────────────────────────────────────────────────────

test('"2025 Q2 revenue" sums the 2025 Q2 column, not another revenue column', async () => {
  await start();
  await say('open the merged header table');

  const { routed, spoken } = await say("what's the total 2025 Q2 revenue");

  // Four columns end in "Revenue": 2026 Q1, 2026 Q2, 2025 Q1, 2025 Q2. Matching on the
  // last path segment made all four equally good and the tie went to the first — a
  // confidently spoken total from the wrong year, which a listener cannot catch.
  assert.equal(routed.tool, 'table_query');
  assert.equal(routed.args?.['aggregate'], 'sum');
  assert.equal(routed.args?.['aggregate_column'], '2025, Q2, Revenue', `said: ${spoken}`);
});

test('a bare column name still works when it is unambiguous', async () => {
  await start();
  await say('open 01 flat');
  const { routed } = await say('what is the total revenue');
  assert.equal(routed.args?.['aggregate_column'], 'Revenue');
});

// ── a question that needs one more word ─────────────────────────────────────

test('"total for engineering" asks which column and then remembers the filter', async () => {
  await start();
  await say('open the budget table');

  const ask = await say('what is the total for engineering');
  assert.ok(ask.routed.speak, 'it should ask, since Engineering names a filter but no measure');
  assert.match(ask.routed.speak ?? '', /amount/i, 'the question should offer the columns it has');

  // The defect: the follow-up word was routed from scratch. "Amount" has no aggregate
  // verb in it, so it fell through to describing the table, and the question died.
  const answer = await say('amount');
  assert.equal(answer.routed.tool, 'table_query', `follow-up went to ${answer.routed.tool}`);
  assert.equal(answer.routed.args?.['aggregate'], 'sum', 'the aggregate was forgotten');
  assert.equal(answer.routed.args?.['aggregate_column'], 'Amount');
  assert.deepEqual(
    answer.routed.args?.['filters'],
    [{ column: 'Department', op: 'eq', value: 'Engineering' }],
    'the Engineering filter was dropped, so this totals the whole table',
  );
});

test('a clarification does not swallow the next real question', async () => {
  await start();
  await say('open the budget table');
  await say('what is the total for engineering');

  // Changing the subject must abandon the pending question rather than fold the new
  // utterance into it.
  const next = await say('what do I have');
  assert.equal(next.routed.tool, 'table_list');
  assert.equal(context.pending, null, 'the pending question should have been dropped');
});

// ── keep going ──────────────────────────────────────────────────────────────

test('"more" reads the next rows rather than the same ones again', async () => {
  await start();
  await say('open the countries table');

  const first = await say('read me the rows');
  assert.equal(first.routed.tool, 'table_read_rows');
  assert.equal(first.payload['start_row'], 1);
  assert.equal(first.payload['more_available'], true, 'the fixture should have more than one page');

  const second = await say('more');

  // The defect: read_rows returned a cursor and its description told clients to send
  // it back, but the input schema had no cursor field, so it was stripped and the
  // start_row from the first call was replayed. "More" repeated itself forever.
  assert.equal(second.routed.tool, 'table_read_rows');
  assert.equal(second.payload['start_row'], 6, 'the second page started where the first ended');
  assert.notDeepEqual(second.payload['rows'], first.payload['rows']);
});

test('"more" after the last page says so instead of erroring', async () => {
  await start();
  await say('open 01 flat');
  const only = await say('read me the rows');
  assert.equal(only.payload['more_available'], false, '01-flat fits in one page');

  const past = await say('more');
  assert.ok(past.routed.speak, 'with nothing left to continue, it should say so rather than re-read');
  assert.match(past.routed.speak ?? '', /nothing more|that was all|end/i);
});

// ── saving a place ──────────────────────────────────────────────────────────

test('saving a place saves where they actually are', async () => {
  await start();
  await say('open the countries table');
  await say('read me the rows');
  await say('more');

  const saved = await say('save my place');

  // The defect: the client hardcoded row 1, so every bookmark pointed at the top of
  // the table no matter how far in someone had read. The one feature whose whole
  // purpose is not losing your position lost your position.
  assert.equal(saved.routed.tool, 'table_bookmark');
  assert.equal(saved.routed.args?.['row'], 6, `saved row ${String(saved.routed.args?.['row'])}`);
  assert.equal(saved.routed.args?.['table_id'], '06-countries');
});

test('resuming returns to the saved place, by name', async () => {
  await start();
  await say('open the countries table');
  await say('read me the rows');
  await say('more');
  await say('save my place');

  const back = await say('where was I');

  // The defect: resume was called with no name, which lists what is saved instead of
  // going anywhere. The demo script answers "carry on" with a list of bookmark names.
  assert.equal(back.routed.tool, 'table_resume');
  assert.equal(back.routed.args?.['name'], 'my place');
  assert.equal(back.payload['row'], 6);
  assert.match(back.spoken, /row 6/);
});

test('resuming with nothing saved says so', async () => {
  await start();
  const back = await say('where was I');
  assert.equal(back.routed.tool, 'table_resume');
  assert.match(back.spoken, /nothing is saved/i);
});
