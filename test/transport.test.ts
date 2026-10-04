/**
 * The HTTP edge of the MCP endpoint, driven the way real clients drive it.
 *
 * Several of these were found by connecting the official TypeScript SDK client — the
 * one inside MCP Inspector, Claude Code and mcp-remote — rather than by hand-built
 * requests: an idle client polling GET every second forever, and every such client
 * sharing one namespace of bookmarks and corrections because no session id was ever
 * issued. Hand-built requests agreed with the server's assumptions, so they passed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler, MAX_BODY_BYTES, type HandlerOptions } from '../src/server.ts';
import { MemoryStore, type Store } from '../src/mcp/store.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const index = buildIndex([buildTable(await readSpreadsheet(join(FIX, '01-flat.xlsx')))]);

const RPC_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

function post(
  handler: (r: Request) => Promise<Response>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...RPC_HEADERS, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function tool(
  handler: (r: Request) => Promise<Response>,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ isError: boolean; content: Record<string, unknown> }> {
  const res = await post(handler, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers);
  const body = (await res.json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  return { isError: body.result.isError === true, content: body.result.structuredContent };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'transport-test', version: '1.0.0' } },
};

/** An SDK client whose fetch goes straight into the handler, counting what it sends. */
async function sdkClient(handler: (r: Request) => Promise<Response>) {
  const counts = { GET: 0, POST: 0, DELETE: 0 };
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (url, init) => {
      const method = (init?.method ?? 'GET') as keyof typeof counts;
      counts[method] = (counts[method] ?? 0) + 1;
      return handler(new Request(url, init));
    },
  });
  const client = new Client({ name: 'transport-test', version: '1.0.0' });
  // The SDK's own two types disagree under exactOptionalPropertyTypes (sessionId?).
  await client.connect(transport as Transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return { isError: r.isError === true, content: r.structuredContent ?? {} };
  };
  return { client, transport, counts, call };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── methods ─────────────────────────────────────────────────────────────────

test('GET and DELETE on /mcp answer 405 with Allow: POST', async () => {
  const handler = createHandler({ index });
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const res = await handler(
      new Request('http://localhost/mcp', { method, headers: { accept: 'text/event-stream' } }),
    );
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST', method);
    const body = (await res.json()) as { jsonrpc: string; id: unknown; error: { code: number } };
    assert.equal(body.id, null);
    assert.equal(body.jsonrpc, '2.0');
  }
});

test('an idle SDK client asks for an event stream once and then leaves it alone', async () => {
  // The defect: GET was answered with an event stream that closed at once, which the
  // SDK reads as a dropped connection and reopens a second later, forever. Over 2.5 s
  // the old server saw three GETs from one idle client; a 405 stops it after one.
  const handler = createHandler({ index });
  const { client, counts } = await sdkClient(handler);
  await new Promise((r) => setTimeout(r, 2500));
  await client.close();
  assert.ok(counts.GET <= 1, `an idle client made ${counts.GET} GETs in 2.5 s`);
});

// ── sessions ────────────────────────────────────────────────────────────────

test('initialize issues a session id; a notification does not', async () => {
  const handler = createHandler({ index });
  const init = await post(handler, INIT);
  assert.equal(init.status, 200);
  assert.match(init.headers.get('mcp-session-id') ?? '', UUID);

  const again = await post(handler, INIT);
  assert.notEqual(again.headers.get('mcp-session-id'), init.headers.get('mcp-session-id'), 'each initialize is a new conversation');

  const note = await post(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(note.headers.get('mcp-session-id'), null);

  // An initialize the server answers with an error starts no conversation.
  const bad = await post(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 7 } });
  const badBody = (await bad.json()) as { error?: unknown };
  assert.ok(badBody.error, 'expected a JSON-RPC error for a malformed initialize');
  assert.equal(bad.headers.get('mcp-session-id'), null);
});

test('two SDK clients are isolated from each other with no configuration at all', async () => {
  const handler = createHandler({ index });
  const a = await sdkClient(handler);
  const b = await sdkClient(handler);
  try {
    // The stateless SDK transport accepts the issued id on later requests, and the SDK
    // client adopts it from the initialize response and echoes it from then on.
    assert.match(a.transport.sessionId ?? '', UUID);
    assert.match(b.transport.sessionId ?? '', UUID);
    assert.notEqual(a.transport.sessionId, b.transport.sessionId);

    // Bookmarks and notes.
    await a.call('table_bookmark', { name: 'my place', table_id: '01-flat', row: 3, note: 'only for a' });
    const bResume = await b.call('table_resume', { name: 'my place' });
    assert.equal(bResume.isError, true, `b read a's bookmark: ${String(bResume.content['spoken'])}`);
    assert.match(String((await a.call('table_resume', { name: 'my place' })).content['spoken']), /only for a/);

    // The working behind an answer is reached by its id, which only a's result carries.
    // b cannot list a's answers, and an id that merely looks like one finds nothing.
    const q = await a.call('table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
    assert.equal(q.content['result'], 61050);
    const id = String(q.content['answer_id']);
    const forged = id.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    assert.equal((await b.call('table_explain', { answer_id: forged })).isError, true);
    assert.equal((await b.call('table_explain', { answer_id: 'a1-0000000000000000' })).isError, true);
    assert.equal((await a.call('table_explain', { answer_id: id })).isError, false);

    // A structure correction — the one that changed what everyone else heard.
    await a.call('table_structure', { table_id: '01-flat', header_rows: 0 });
    const bSum = await b.call('table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
    assert.equal(bSum.content['result'], 61050, "a's correction changed b's answer");
    const aSum = await a.call('table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
    assert.notEqual(aSum.content['result'], 61050, 'and a is reading the table the way a asked');
  } finally {
    await a.client.close();
    await b.client.close();
  }
});

test('a host that reconnects for every turn can still ask where the last answer came from', async () => {
  // Some hosts open a new connection for each turn, and each connection is a new
  // conversation with a new session id. With answers filed under the conversation,
  // "how do you know" in the next turn found nothing, every time.
  const handler = createHandler({ index });
  const turn1 = await sdkClient(handler);
  const q = await turn1.call('table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
  await turn1.call('table_bookmark', { name: 'my place', table_id: '01-flat', row: 3 });
  await turn1.client.close();

  const turn2 = await sdkClient(handler);
  try {
    assert.notEqual(turn2.transport.sessionId, turn1.transport.sessionId);
    const e = await turn2.call('table_explain', { answer_id: q.content['answer_id'] });
    assert.equal(e.isError, false, `the next turn lost the working: ${String(e.content['spoken'])}`);
    assert.deepEqual(e.content['cells'], ['C2', 'C3', 'C4', 'C5', 'C6']);
    // Bookmarks stay with the conversation that made them: a name can be guessed.
    assert.equal((await turn2.call('table_resume', { name: 'my place' })).isError, true);
  } finally {
    await turn2.client.close();
  }
});

test('the browser header wins over the MCP session id', async () => {
  const handler = createHandler({ index });
  await tool(handler, 'table_bookmark', { name: 'here', table_id: '01-flat', row: 2 }, {
    'x-landmark-session': 'browser-1',
    'mcp-session-id': 'mcp-1',
  });
  assert.equal((await tool(handler, 'table_resume', { name: 'here' }, { 'x-landmark-session': 'browser-1' })).isError, false);
  assert.equal((await tool(handler, 'table_resume', { name: 'here' }, { 'mcp-session-id': 'mcp-1' })).isError, true);
  assert.equal((await tool(handler, 'table_resume', { name: 'here' })).isError, true, 'nor does it land in the shared demo');
});

test('an empty browser header does not hide the MCP session id', async () => {
  // An empty value carries no id. It used to win anyway, and drop a caller with a
  // perfectly good mcp-session-id into the shared demo.
  const handler = createHandler({ index });
  await tool(handler, 'table_bookmark', { name: 'mine', table_id: '01-flat', row: 2 }, { 'mcp-session-id': 'sess-1' });
  const both = { 'x-landmark-session': '', 'mcp-session-id': 'sess-1' };
  assert.equal((await tool(handler, 'table_resume', { name: 'mine' }, both)).isError, false);

  // Empty everywhere is the shared demo, as no header at all is.
  await tool(handler, 'table_bookmark', { name: 'shared', table_id: '01-flat', row: 2 }, { 'x-landmark-session': '', 'mcp-session-id': '' });
  assert.equal((await tool(handler, 'table_resume', { name: 'shared' })).isError, false);
});

test('session ids are used as given, and a malformed one is refused', async () => {
  const handler = createHandler({ index });
  // Stripping punctuation used to put "a.b" and "ab" in one conversation.
  await tool(handler, 'table_bookmark', { name: 'mine', table_id: '01-flat', row: 2 }, { 'x-landmark-session': 'a.b' });
  assert.equal((await tool(handler, 'table_resume', { name: 'mine' }, { 'x-landmark-session': 'ab' })).isError, true);
  assert.equal((await tool(handler, 'table_resume', { name: 'mine' }, { 'x-landmark-session': 'a.b' })).isError, false);

  for (const bad of ['has space', 'x'.repeat(129)]) {
    const res = await post(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'x-landmark-session': bad });
    assert.equal(res.status, 400, bad.slice(0, 20));
  }
});

test('the conversation map lets go of the least recently used, not the oldest', async () => {
  const made: string[] = [];
  const handler = createHandler({
    index,
    makeStore: (key) => {
      made.push(key);
      return new MemoryStore();
    },
  });
  const as = (s: string) => ({ 'x-landmark-session': s });

  await tool(handler, 'table_bookmark', { name: 'keep', table_id: '01-flat', row: 2 }, as('keep'));
  for (let i = 0; i < 199; i++) await tool(handler, 'table_list', {}, as(`probe-${i}`));
  // Touch it, then push one more past the cap: the oldest untouched session goes.
  assert.equal((await tool(handler, 'table_resume', { name: 'keep' }, as('keep'))).isError, false);
  await tool(handler, 'table_list', {}, as('one-more'));
  assert.equal((await tool(handler, 'table_resume', { name: 'keep' }, as('keep'))).isError, false, 'a session in use was evicted');
  assert.equal(made.filter((k) => k === 'keep').length, 1);
  assert.ok(made.includes('probe-0'));
  await tool(handler, 'table_list', {}, as('probe-0'));
  assert.equal(made.filter((k) => k === 'probe-0').length, 2, 'the least recently used one was not the one evicted');
});

test('a flood of new session ids cannot wipe the shared session', async () => {
  // Least-recently-used keeps conversations in use, not idle ones: a burst of made-up
  // ids still pushes those out. The shared session is outside the map for that
  // reason. It is the documented single-caller path, and on the Worker it is the one
  // conversation kept in memory, so two hundred requests used to wipe it.
  let made = 0;
  const handler = createHandler({
    index,
    makeStore: () => {
      made++;
      return new MemoryStore();
    },
  });
  await tool(handler, 'table_bookmark', { name: 'budget review', table_id: '01-flat', row: 3 });
  for (let i = 0; i < 250; i++) await tool(handler, 'table_list', {}, { 'x-landmark-session': `flood-${i}` });
  const back = await tool(handler, 'table_resume', { name: 'budget review' });
  assert.equal(back.isError, false, String(back.content['spoken']));
  assert.equal(made, 250, 'the shared session was handed to makeStore');
});

test('health says whether state is durable, and creates no conversation', async () => {
  let made = 0;
  const makeStore = (): Store => {
    made++;
    return new MemoryStore();
  };
  const read = async (options: HandlerOptions) =>
    (await (await createHandler(options)(
      new Request('http://localhost/health', { headers: { 'x-landmark-session': 'probe' } }),
    )).json()) as Record<string, unknown>;

  assert.equal((await read({ index })).state, 'this instance only');
  const durable = await read({ index, makeStore, durableState: true });
  assert.equal(durable.state, 'durable');
  // Header-less callers are in memory even then, and health says that too.
  assert.equal(durable['shared_session'], 'this instance only');
  // Durable without a store to make it so is still memory.
  assert.equal((await read({ index, durableState: true })).state, 'this instance only');
  assert.equal(made, 0, 'a health probe with a session header created a store');
});

// ── calls without arguments ─────────────────────────────────────────────────

test('a tool call that leaves out `arguments` is answered, as the specification allows', async () => {
  // The 2025-11-25 schema makes `arguments` optional on tools/call, and a host may send
  // only the name for a tool that needs nothing. SDK 1.30.0 validated the missing field
  // as `undefined` against the tool's object schema and refused it as "Required", so the
  // first thing anyone asks — what tables do I have — and "pick up where I left off"
  // both failed, and were spoken as "name a column from the description". The voice
  // client always sends `arguments: {}`, so only hand-built and third-party calls hit it.
  const handler = createHandler({ index });
  const bare = async (name: string, headers: Record<string, string> = {}) => {
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } };
    assert.ok(!('arguments' in message.params), 'the request under test must omit the field');
    const res = await post(handler, message, headers);
    assert.equal(res.status, 200, name);
    const body = (await res.json()) as {
      error?: unknown;
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.equal(body.error, undefined, `${name}: ${JSON.stringify(body.error)}`);
    const spoken = String(body.result?.structuredContent?.['spoken']);
    assert.notEqual(body.result?.isError, true, `${name} was refused: ${spoken}`);
    return spoken;
  };

  assert.match(await bare('table_list'), /^You have 01 flat\b/);
  // With nothing saved, resume says so rather than failing ...
  assert.equal(await bare('table_resume'), 'Nothing is saved yet.');
  // ... and with a bookmark, a bare resume goes back to the most recent one.
  const as = { 'x-landmark-session': 'no-arguments' };
  assert.equal((await tool(handler, 'table_bookmark', { name: 'my place', table_id: '01-flat', row: 3 }, as)).isError, false);
  assert.match(await bare('table_resume', as), /row 3/);
});

test('the SDK client can call a tool with no arguments at all', async () => {
  // The SDK client sends `params` as given, so `callTool({ name })` puts no `arguments`
  // on the wire: the same request as above, from the client MCP Inspector, Claude Code
  // and mcp-remote are built on.
  const handler = createHandler({ index });
  const calls: { params?: Record<string, unknown> }[] = [];
  const recording = async (r: Request) => {
    if (r.method === 'POST') {
      const message = (await r.clone().json()) as { method?: string; params?: Record<string, unknown> };
      if (message.method === 'tools/call') calls.push(message);
    }
    return handler(r);
  };
  const { client } = await sdkClient(recording);
  try {
    for (const name of ['table_list', 'table_resume']) {
      const r = (await client.callTool({ name })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      assert.notEqual(r.isError, true, `${name} was refused: ${String(r.structuredContent?.['spoken'])}`);
    }
  } finally {
    await client.close();
  }
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(c.params && !('arguments' in c.params), JSON.stringify(c));
});

// ── bodies ──────────────────────────────────────────────────────────────────

test('a JSON-RPC batch is refused rather than run', async () => {
  const handler = createHandler({ index });
  const res = await post(handler, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { id: unknown; error: { code: number; message: string } };
  assert.equal(body.id, null);
  assert.match(body.error.message, /one JSON-RPC message/i);
});

test('a body over 1 MB is refused with 413, and one under it is served', async () => {
  const handler = createHandler({ index });
  const call = (note: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'table_bookmark', arguments: { name: 'big', table_id: '01-flat', row: 1, note } },
  });

  // No Content-Length (a streamed body), so the cap has to count what arrives.
  assert.equal((await post(handler, call('x'.repeat(MAX_BODY_BYTES)))).status, 413);

  // A declared length over the cap is refused before anything is read.
  const declared = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...RPC_HEADERS, 'content-length': String(MAX_BODY_BYTES + 1) },
      body: '{}',
    }),
  );
  assert.equal(declared.status, 413);

  assert.equal((await post(handler, call('y'.repeat(100_000)))).status, 200);
  assert.equal((await post(handler, '{"jsonrpc":')).status, 400, 'and malformed JSON is a parse error');
});
