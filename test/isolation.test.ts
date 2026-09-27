/**
 * State isolation and transport security.
 *
 * Each case here reproduces something a review found the deployed server doing
 * wrong: two callers sharing one namespace of bookmarks, two isolates minting the
 * same answer id, an Origin check that was switched off unless an allowlist happened
 * to be configured — which it never was, in either default deployment — and a local
 * server that answered any Host, so a web page could rebind its name to 127.0.0.1.
 *
 * What these tests do NOT claim: that the server knows who anybody is. It has no
 * authentication, so it isolates conversations, not people: a conversation is
 * whatever sends the same session header. Callers that send none share one demo
 * namespace (see sessionKey in src/server.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler, hostAllowed, isHostHeader } from '../src/server.ts';
import { MemoryStore } from '../src/mcp/store.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const index = buildIndex([buildTable(await readSpreadsheet(join(FIX, '01-flat.xlsx')))]);

function post(
  handler: (r: Request) => Promise<Response>,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
}

/**
 * `isError` lives on the tool result, not inside `structuredContent` — reading the
 * wrong one makes a refusal look like a success, which is how this file's first
 * draft "found" a leak that was not there.
 */
async function result(res: Response): Promise<{ isError: boolean; content: Record<string, unknown> }> {
  const body = JSON.parse(await res.text()) as {
    result: { isError?: boolean; structuredContent: Record<string, unknown> };
  };
  return { isError: body.result.isError === true, content: body.result.structuredContent };
}

async function structured(res: Response): Promise<Record<string, unknown>> {
  return (await result(res)).content;
}

// ── Origin ──────────────────────────────────────────────────────────────────

test('a browser origin that is not allowed is refused with 403', async () => {
  const handler = createHandler({ index, allowedOrigins: ['https://landmark.example'] });
  const res = await post(handler, 'table_list', {}, { origin: 'https://untrusted.invalid' });
  assert.equal(res.status, 403, 'the transport specification requires this, and it was not happening');
});

test('the configured origin is accepted, and a request with no Origin still works', async () => {
  const handler = createHandler({ index, allowedOrigins: ['https://landmark.example'] });
  assert.equal(
    (await post(handler, 'table_list', {}, { origin: 'https://landmark.example' })).status,
    200,
  );
  // Server-side MCP clients do not send Origin. Refusing them would break the
  // protocol's normal case in the name of a browser-only threat.
  assert.equal((await post(handler, 'table_list', {})).status, 200);
});

test('with no configuration at all, a foreign Origin is refused and the own origin served', async () => {
  // Both default deployments — the Worker with no vars, and the local runner — used to
  // accept any Origin, because the check only existed when an allowlist was passed.
  const handler = createHandler({ index });
  for (const origin of ['https://untrusted.invalid', 'null', 'http://localhost:9999', 'https://localhost']) {
    assert.equal((await post(handler, 'table_list', {}, { origin })).status, 403, origin);
  }
  assert.equal((await post(handler, 'table_list', {}, { origin: 'http://localhost' })).status, 200);
  assert.equal((await post(handler, 'table_list', {})).status, 200);
});

test('an allowed origin is added to the own origin, not instead of it', async () => {
  const handler = createHandler({ index, allowedOrigins: ['https://landmark.example'] });
  assert.equal((await post(handler, 'table_list', {}, { origin: 'http://localhost' })).status, 200);
});

test('with a host allowlist, a rebinding-shaped request is refused', async () => {
  // What the local runner passes when bound to loopback. A page on attacker.example
  // that rebinds its name to 127.0.0.1 is same-origin with itself, so the Origin check
  // alone passes it; the Host it sends is still its own name.
  const handler = createHandler({ index, allowedHosts: ['localhost', '127.0.0.1', '[::1]'] });
  const at = (host: string, path = '/mcp') =>
    handler(
      new Request(`http://${host}${path}`, {
        method: 'POST',
        headers: {
          host,
          origin: `http://${host}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'table_list', arguments: {} } }),
      }),
    );
  assert.equal((await at('attacker.example:8787')).status, 403);
  assert.equal((await at('attacker.example:8787', '/health')).status, 403);
  for (const ok of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
    assert.equal((await at(ok)).status, 200, ok);
  }
});

test('a Host header is read strictly, not through the URL parser', async () => {
  // The URL parser finds "localhost" in all of these. None is a Host an HTTP client
  // sends, and the first made the local runner fail with a 500 building its Request.
  const allowed = ['localhost', '127.0.0.1', '[::1]'];
  for (const bad of ['evil.com@localhost:8787', 'evil.com@localhost', 'localhost/evil', 'localhost:8787/x', '0x7f.1', 'localhost:', 'localhost:123456', 'local host', '']) {
    assert.equal(hostAllowed(bad, allowed), false, bad);
  }
  assert.equal(isHostHeader('evil.com@localhost'), false);
  for (const ok of ['localhost', 'LOCALHOST:8787', '127.0.0.1:1', '[::1]:8787', '[::1]']) {
    assert.equal(hostAllowed(ok, allowed), true, ok);
    assert.equal(isHostHeader(ok), true, ok);
  }
  // A name only matches itself: a suffix or prefix of an allowed name is not allowed.
  assert.equal(hostAllowed('notlocalhost', allowed), false);
  assert.equal(hostAllowed('localhost.evil.example', allowed), false);

  const handler = createHandler({ index, allowedHosts: allowed });
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { host: 'evil.com@localhost', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  );
  assert.equal(res.status, 403);
});

// ── who owns what ───────────────────────────────────────────────────────────

test('two conversations do not share bookmarks', async () => {
  const handler = createHandler({ index });
  const call = (session: string, name: string, args: Record<string, unknown>) =>
    post(handler, name, args, { 'x-landmark-session': session }).then(structured);

  await call('alice', 'table_bookmark', { name: 'my place', table_id: '01-flat', row: 3 });

  const bob = await call('bob', 'table_resume', { name: 'my place' });
  assert.match(
    String(bob['spoken']),
    /nothing is saved/i,
    `bob should not see alice's bookmark, got: ${String(bob['spoken'])}`,
  );

  const alice = await call('alice', 'table_resume', { name: 'my place' });
  assert.match(String(alice['spoken']), /row 3/, 'and alice must still have hers');
});

test('the working behind an answer is reached only by its id, which cannot be guessed', async () => {
  // Answers are found by id from any conversation, because a host that reconnects for
  // every turn is a new conversation every turn and still has to ask "how do you know"
  // about the last one. What keeps bob out of alice's working is that the id — 64
  // random bits, in alice's result only — cannot be listed or guessed.
  const handler = createHandler({ index });
  const alice = await post(handler, 'table_query', {
    table_id: '01-flat',
    aggregate: 'sum',
    aggregate_column: 'Revenue',
  }, { 'x-landmark-session': 'alice' }).then(structured);
  const id = String(alice['answer_id']);
  assert.match(id, /^a\d+-[0-9a-f]{16}$/);

  for (const guess of [id.replace(/-.*/, '-0000000000000000'), id.slice(0, -1) + (id.endsWith('0') ? '1' : '0'), 'a1', 'a1-00000000']) {
    const stolen = await post(handler, 'table_explain', { answer_id: guess }, {
      'x-landmark-session': 'bob',
    }).then(result);
    assert.equal(stolen.isError, true, `bob read alice's working with ${guess}`);
    assert.match(String(stolen.content['spoken']), /no longer have the working/i);
  }
});

test('answer ids from separate stores do not collide', async () => {
  // The defect: a counter starting at zero inside each store, so two isolates
  // writing to one namespace both minted "a1" and the second overwrote the first.
  const one = new MemoryStore();
  const two = new MemoryStore();
  const answer = {
    parts: [
      { label: 'x', tableId: 't', regionId: 'r', sheet: 's', cells: ['A1'], cellCount: 1, excluded: [], path: [] },
    ],
    spec: {},
    structureRevision: 1,
  };

  const idA = await one.putAnswer(answer);
  const idB = await two.putAnswer(answer);
  assert.notEqual(idA, idB, 'two fresh stores must not mint the same first id');

  const many = new Set<string>();
  for (let i = 0; i < 50; i++) many.add(await new MemoryStore().putAnswer(answer));
  assert.equal(many.size, 50, 'fifty fresh stores produced a duplicate id');
});

test('a caller with no session header still gets working state', async () => {
  // The documented single-user demo path must not be broken by the isolation work.
  const handler = createHandler({ index });
  const q = await post(handler, 'table_query', {
    table_id: '01-flat',
    aggregate: 'sum',
    aggregate_column: 'Revenue',
  }).then(structured);
  const e = await post(handler, 'table_explain', { answer_id: q['answer_id'] }).then(result);
  assert.equal(e.isError, false);
  assert.deepEqual(e.content['cells'], ['C2', 'C3', 'C4', 'C5', 'C6']);
});
