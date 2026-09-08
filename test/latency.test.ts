/**
 * Latency budget.
 *
 * Alexa+'s published guidance puts a tool round trip under 500 ms. That number is
 * not decoration for a voice product: the gap between a question and the first
 * syllable of the answer is the entire perceived responsiveness of the thing, and
 * there is no spinner to look at while it thinks.
 *
 * This asserts the server's own share of that budget — parse, route, query, format —
 * measured over the largest fixture. Network and speech synthesis are on top, which
 * is exactly why the server's share needs to be small rather than merely acceptable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import type { IndexTable } from '../src/indexfmt.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Grow a fixture to a realistic working size: 2,000 rows is a normal export. */
function inflate(table: IndexTable, factor: number): IndexTable {
  return {
    ...table,
    regions: table.regions.map((r) => {
      const rows = [];
      for (let i = 0; i < factor; i++) rows.push(...r.rows);
      return { ...r, rows, rowCount: rows.length };
    }),
  };
}

const base = buildTable(await readSpreadsheet(join(FIX, '01-flat.xlsx')));
const big = inflate(base, 400); // 5 rows x 400 = 2,000 rows
const handler = createHandler({ index: buildIndex([big]) });

async function callOnce(body: unknown): Promise<number> {
  const started = performance.now();
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify(body),
    }),
  );
  await res.text();
  assert.equal(res.status, 200);
  return performance.now() - started;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

test('a grouped aggregate over 2,000 rows stays well inside the voice budget', async () => {
  const call = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'table_query',
      arguments: {
        table_id: '01-flat',
        aggregate: 'sum',
        aggregate_column: 'Revenue',
        group_by: 'Region',
      },
    },
  };

  await callOnce(call); // warm the module graph, not a cache — there isn't one
  const samples: number[] = [];
  for (let i = 0; i < 40; i++) samples.push(await callOnce(call));

  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  console.log(`      2,000 rows, grouped sum — p50 ${p50.toFixed(1)}ms  p95 ${p95.toFixed(1)}ms`);
  assert.ok(p95 < 500, `p95 was ${p95.toFixed(1)}ms, over the 500ms budget`);
});

test('describing a table is cheap enough to call before every question', async () => {
  const call = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'table_describe', arguments: { table_id: '01-flat', detail: 'full' } },
  };
  await callOnce(call);
  const samples: number[] = [];
  for (let i = 0; i < 40; i++) samples.push(await callOnce(call));
  const p95 = percentile(samples, 95);
  console.log(`      describe (full) — p95 ${p95.toFixed(1)}ms`);
  assert.ok(p95 < 250, `p95 was ${p95.toFixed(1)}ms`);
});
