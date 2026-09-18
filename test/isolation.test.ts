/**
 * State isolation and transport security.
 *
 * Each case here reproduces something a review found the deployed server doing
 * wrong: two callers sharing one namespace of bookmarks, two isolates minting the
 * same answer id, and an Origin check that was switched off unless an unrelated
 * option happened to be set.
 *
 * What these tests do NOT claim: that the server knows who anybody is. It has no
 * authentication, so it isolates conversations, not people. That limit is real and
 * is stated in the README rather than papered over here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
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

test('two conversations do not share the working behind an answer', async () => {
  const handler = createHandler({ index });
  const alice = await post(handler, 'table_query', {
    table_id: '01-flat',
    aggregate: 'sum',
    aggregate_column: 'Revenue',
  }, { 'x-landmark-session': 'alice' }).then(structured);

  const stolen = await post(handler, 'table_explain', { answer_id: alice['answer_id'] }, {
    'x-landmark-session': 'bob',
  }).then(result);

  assert.equal(stolen.isError, true, "bob must not be able to read alice's working");
  assert.match(String(stolen.content['spoken']), /no longer have the working/i);
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
