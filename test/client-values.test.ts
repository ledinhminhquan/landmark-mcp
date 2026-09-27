/**
 * Values made of everyday words, asked about by voice, against a real server.
 *
 * Status, priority and flag columns hold High, Low, Open and Closed; sales sheets hold
 * reps with short names like An. The router once stripped every everyday word out of a
 * value before matching it, so none of these could be named: "how many are open"
 * counted every row, and "total revenue for An" spoke the total of every rep. Both came
 * out as confident numbers, which is the failure a listener cannot catch. These tables
 * are built the way ingest builds any file, and every question goes through the real
 * handler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const PRIORITY = ['High', 'Low', 'Medium', 'High', 'Low', 'Medium', 'High', 'Low', 'Low', 'Medium'];
const STATUS = ['Open', 'Closed', 'Open', 'Open', 'Closed', 'Closed', 'Open', 'Closed', 'Open', 'Closed'];
const tasks: unknown[][] = [['Task', 'Priority', 'Status', 'Hours', 'Cost']];
PRIORITY.forEach((p, i) => tasks.push([`Task ${i + 1}`, p, STATUS[i], i + 1, (i + 1) * 100]));

// Reps repeat, so every version of the index lists them as values.
const sales: unknown[][] = [
  ['Region', 'Rep', 'Revenue'],
  ['North', 'An', 100],
  ['North', 'Chi', 200],
  ['South', 'An', 300],
  ['South', 'Bao', 400],
  ['East', 'Chi', 500],
  ['East', 'An', 600],
  ['North', 'Bao', 700],
  ['South', 'Chi', 800],
];

const table = (name: string, grid: unknown[][]) =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });

const handler = createHandler({ index: buildIndex([table('tasks', tasks), table('sales', sales)]) });

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': 'everyday-values',
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

async function open(name: string): Promise<void> {
  resetContext();
  await loadCatalogue(call);
  const described = await say(`open the ${name} table`);
  assert.equal(described.plan.args?.['table_id'], name);
}

test('priority and status values are counted as asked', async () => {
  await open('tasks');
  for (const [question, rows] of [
    ['how many are high priority', 3],
    ['how many are open', 5],
    ['how many are low', 4],
  ] as const) {
    const turn = await say(question);
    assert.equal(turn.payload?.['result'], rows, `"${question}" said: ${turn.spoken}`);
  }
});

test('totals honour everyday values, alone and together', async () => {
  await open('tasks');
  const low = await say('total hours for low priority');
  assert.equal(low.payload?.['result'], 2 + 5 + 8 + 9);

  const both = await say('total hours for high priority tasks that are open');
  assert.equal(both.payload?.['result'], 1 + 4 + 7);
});

test('a rep called An is answered for, not dropped into the total of everyone', async () => {
  await open('sales');
  for (const question of ['total revenue for an', 'how much did An sell']) {
    const turn = await say(question);
    assert.equal(turn.payload?.['result'], 1000, `"${question}" said: ${turn.spoken}`);
  }
  // "An" as an article stays an article.
  const avg = await say("what's an average revenue");
  assert.equal(avg.payload?.['result'], 450);
});
