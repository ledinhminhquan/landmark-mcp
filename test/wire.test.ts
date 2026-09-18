/**
 * Wire-contract tests.
 *
 * These exercise the deployed code path directly — the same Web-standard handler the
 * Worker exports — by handing it Request objects and reading the Responses. No port,
 * no client library, nothing that could pass here and fail in production because a
 * test harness was doing the work.
 *
 * The protocol assertions matter because the hackathon requirement is specific:
 * "implementing MCP spec version 2025-11-25 over Streamable HTTP". A server that
 * negotiates a different revision does not meet it, however well it answers questions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import type { LandmarkIndex } from '../src/indexfmt.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function fixtureIndex(): Promise<LandmarkIndex> {
  const tables = [];
  for (const f of ['01-flat.xlsx', '03-merged-header.xlsx', '04-title-and-vmerge.xlsx']) {
    tables.push(buildTable(await readSpreadsheet(join(FIX, f))));
  }
  return buildIndex(tables);
}

const handler = createHandler({ index: await fixtureIndex() });

const RPC_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

/** Streamable HTTP may answer as JSON or as a single SSE event. Accept both. */
async function readRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return JSON.parse(text) as Record<string, unknown>;
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'));
  assert.ok(line, `no SSE data frame in response:\n${text.slice(0, 400)}`);
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...RPC_HEADERS, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'wire-test', version: '1.0.0' },
  },
};

// ── protocol ────────────────────────────────────────────────────────────────

test('negotiates exactly the revision the hackathon requires', async () => {
  const res = await post(INIT);
  assert.equal(res.status, 200);
  const body = await readRpc(res);
  const result = body['result'] as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(result.serverInfo.name, 'landmark');
});

test('a notification is accepted with 202 and no body', async () => {
  const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.status, 202);
  assert.equal((await res.text()).trim(), '');
});

test('an unsupported protocol version is refused rather than silently downgraded', async () => {
  // The header is not consulted on initialize — that request is where the version is
  // negotiated in the body. It governs every request after it, so assert it there.
  const res = await post(
    { jsonrpc: '2.0', id: 9, method: 'tools/list' },
    { 'mcp-protocol-version': '1999-01-01' },
  );
  assert.equal(res.status, 400);
});

test('health reports the protocol and the corpus, for judging weeks from now', async () => {
  const res = await handler(new Request('http://localhost/health'));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['ok'], true);
  assert.equal(body['protocol'], '2025-11-25');
  assert.equal(body['tables'], 3);
  assert.ok((body['rows'] as number) > 0);
});

test('an unknown path 404s with a pointer rather than a blank page', async () => {
  const res = await handler(new Request('http://localhost/nope'));
  assert.equal(res.status, 404);
  assert.match(JSON.stringify(await res.json()), /\/mcp/);
});

// ── tools ───────────────────────────────────────────────────────────────────

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await post({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const body = await readRpc(res);
  assert.ok(!body['error'], `transport error: ${JSON.stringify(body['error'])}`);
  const result = body['result'] as { structuredContent?: Record<string, unknown>; isError?: boolean };
  assert.ok(result.structuredContent, `no structuredContent in ${JSON.stringify(body).slice(0, 300)}`);
  return result.structuredContent;
}

test('all nine tools are advertised with descriptions and schemas', async () => {
  const body = await readRpc(await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
  const tools = (body['result'] as { tools: { name: string; description?: string; inputSchema: unknown }[] }).tools;

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      'table_bookmark',
      'table_compare',
      'table_describe',
      'table_explain',
      'table_list',
      'table_query',
      'table_read_rows',
      'table_resume',
      'table_structure',
    ],
  );
  for (const t of tools) {
    assert.ok(t.inputSchema, `${t.name} has no input schema`);
    assert.ok((t.description ?? '').length > 80, `${t.name}'s description is too thin to guide a model`);
    assert.ok(/^[A-Za-z0-9_.-]{1,128}$/.test(t.name), `${t.name} breaks the spec's name rules`);
  }
});

test('list, describe and query round-trip over the wire', async () => {
  const list = await call('table_list', {});
  assert.match(String(list['spoken']), /01 flat|03 merged|04 title/i);

  const desc = await call('table_describe', { table_id: '01-flat' });
  assert.match(String(desc['spoken']), /5 rows and 4 columns/);
  assert.equal((desc['columns'] as unknown[]).length, 4);

  const q = await call('table_query', {
    table_id: '01-flat',
    aggregate: 'sum',
    aggregate_column: 'Revenue',
  });
  assert.equal(q['result'], 61050);
  assert.match(String(q['spoken']), /61\.1 thousand/);
  assert.ok(q['answer_id'], 'every answer must be explainable');
});

test('explain reads back the cells behind the number it just said', async () => {
  const q = await call('table_query', {
    table_id: '01-flat',
    aggregate: 'sum',
    aggregate_column: 'Revenue',
  });
  const e = await call('table_explain', { answer_id: q['answer_id'] });
  assert.deepEqual(e['cells'], ['C2', 'C3', 'C4', 'C5', 'C6']);
  assert.equal(e['total_cells'], 5);
  assert.match(String(e['spoken']), /C2 through C6/);
  assert.match(String(e['spoken']), /Sales/);
});

test('the merged-header table is queryable by its full heading path', async () => {
  const q = await call('table_query', {
    table_id: '03-merged-header',
    aggregate: 'sum',
    aggregate_column: '2026, Q2, Revenue',
  });
  assert.equal(q['result'], 2350);
});

test('an ambiguous column name is refused with the choices, not guessed', async () => {
  const r = await call('table_query', {
    table_id: '03-merged-header',
    aggregate: 'sum',
    aggregate_column: 'Revenue',
  });
  assert.match(String(r['spoken']), /which one|ambiguous|matches/i);
  assert.match(String(r['spoken']), /2026|2025/);
});

test('nothing spoken leaks a tool name, a field name or an identifier', async () => {
  const bad = await call('table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Nope' });
  const spoken = String(bad['spoken']);
  assert.ok(!/table_|answer_id|_id\b|structuredContent|json/i.test(spoken), spoken);
  assert.match(spoken, /Region|Rep|Revenue|Closed/, 'and it names what they could ask for instead');
});

test('bookmarks survive within a session and re-orient on return', async () => {
  // Stateless transport, but the store is per-handler, so a bookmark set through one
  // request is visible to the next — which is the behaviour a user expects.
  await call('table_bookmark', { name: 'budget review', table_id: '04-title-and-vmerge', row: 3 });
  const back = await call('table_resume', { name: 'budget review' });
  assert.match(String(back['spoken']), /row 3/);
  assert.match(String(back['row_spoken']), /Travel|Engineering/);
});

test('comparison states the direction and the gap in one sentence', async () => {
  const c = await call('table_compare', {
    table_id: '03-merged-header',
    left_column: '2026, Q1, Revenue',
    right_column: '2025, Q1, Revenue',
  });
  assert.equal(c['difference'], 2100 - 1900);
  assert.match(String(c['spoken']), /more than/);
});

// ── MCP App widget ──────────────────────────────────────────────────────────

test('table_explain advertises a UI resource, and the resource is servable', async () => {
  const list = await readRpc(await post({ jsonrpc: '2.0', id: 20, method: 'tools/list' }));
  const tools = (list['result'] as { tools: { name: string; _meta?: Record<string, unknown> }[] }).tools;
  const explain = tools.find((t) => t.name === 'table_explain');
  assert.equal(
    explain?._meta?.['ui/resourceUri'],
    'ui://landmark/explain',
    'the flat slash key is the contract, not a nested _meta.ui.resourceUri',
  );

  const res = await readRpc(
    await post({ jsonrpc: '2.0', id: 21, method: 'resources/read', params: { uri: 'ui://landmark/explain' } }),
  );
  const contents = (res['result'] as { contents: { mimeType: string; text: string }[] }).contents;
  assert.equal(contents[0]!.mimeType, 'text/html;profile=mcp-app');
  assert.match(contents[0]!.text, /<table|createElement\('table'\)/);
  assert.ok(!/https?:\/\//.test(contents[0]!.text), 'the widget must not fetch anything');
});

test('explain ships the surrounding grid so a highlight has neighbours', async () => {
  const q = await call('table_query', {
    table_id: '04-title-and-vmerge',
    filters: [{ column: 'Department', op: 'eq', value: 'Engineering' }],
    aggregate: 'sum',
    aggregate_column: 'Amount',
  });
  const e = await call('table_explain', { answer_id: q['answer_id'] });

  const grid = e['grid'] as { columns: unknown[]; rows: { cells: { address: string }[] }[] };
  assert.ok(grid, 'no grid means the widget has nothing to draw');
  assert.equal(grid.columns.length, 3);
  assert.equal(grid.rows.length, 5, 'the whole small region, not just the counted rows');

  const addresses = grid.rows.flatMap((r) => r.cells.map((c) => c.address));
  for (const cell of e['cells'] as string[]) {
    assert.ok(addresses.includes(cell), `highlighted ${cell} is not in the grid it must line up with`);
  }
  assert.equal(e['title'], 'FY2026 Departmental Budget');
});
