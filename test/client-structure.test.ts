/**
 * Correcting how a table is read, by voice alone.
 *
 * describe tells a listener who hears a column named like data to say "check the
 * structure". The voice client had no route to the structure tool, so saying it
 * described the table again, and a row of years stayed a row of data. This drives the
 * whole correction through the router, against a real server holding that table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const handler = createHandler({
  index: buildIndex([
    buildTable({
      sourceName: 'years.csv',
      format: 'csv',
      sheets: [{ name: 'years', grid: [[2024, 2025, 2026], [100, 110, 120], [200, 210, 220]], merges: [] }],
      warnings: [],
    }),
  ]),
});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': 'structure-by-voice',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = JSON.parse(await res.text()) as {
    result: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
}

interface Turn {
  plan: { tool?: string; args?: Record<string, unknown>; speak?: string };
  payload: Record<string, unknown> | null;
  spoken: string;
}
const say = async (utterance: string): Promise<Turn> => (await converse(utterance, call)) as Turn;

test('a row of years is corrected to headings by voice, and the total changes to match', async () => {
  resetContext();
  await loadCatalogue(call);
  await say('describe it');

  const check = await say('check the structure');
  assert.equal(check.plan.tool, 'table_structure');
  assert.equal(check.plan.args?.['header_rows'], undefined);

  const fix = await say('use one heading row');
  assert.equal(fix.plan.args?.['header_rows'], 1);
  assert.match(fix.spoken, /2 rows of data/);

  // The years are headings now, so 2024's total is the two values beneath it.
  const total = await say('what is the total for 2024');
  assert.equal(total.plan.tool, 'table_query', `asked instead: ${total.spoken}`);
  assert.equal(total.payload?.['result'], 300);

  // And back again: with no headings, the year is counted as data.
  const none = await say('there are no headings');
  assert.equal(none.plan.args?.['header_rows'], 0);
  const all = await say('total column 1');
  assert.equal(all.payload?.['result'], 2324);
});
