/**
 * Spreadsheets shaped the way real ones are, asked about by voice through the real
 * handler: product names with sizes in them, months repeated over Units and Revenue, a
 * Total column, an Average column, a Variance column, a row-number column, and a sheet
 * forty columns wide. The bundled samples have none of these, so the questions below
 * once came back wrong only on a judge's or a user's own file: the grand total spoken as
 * the matcha figure, January's units for March, the average of a Total column given as
 * its sum, a Variance column refused outright.
 *
 * Every table is built the way ingest builds any file, and every truth is worked out
 * here from the grid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const table = (name: string, grid: unknown[][]) =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });

const PRODUCTS: [string, number, number, number, number, number, number][] = [
  ['Matcha 100g', 25, 3000000, 40, 4800000, 60, 18000000],
  ['Coffee beans 1kg', 90, 30000000, 95, 31000000, 120, 45000000],
  ['Coffee beans 500g', 70, 12000000, 65, 11000000, 80, 14000000],
  ['Green tea 500g', 60, 9000000, 70, 10500000, 76, 11400000],
  ['Oolong', 30, 4500000, 35, 5250000, 49, 7350000],
];
const q1 = [
  [null, 'January', 'January', 'February', 'February', 'March', 'March'],
  ['Product', 'Units', 'Revenue', 'Units', 'Revenue', 'Units', 'Revenue'],
  ...PRODUCTS,
];
const STOCK: [string, string, number][] = [
  ['Stapler, medium', 'pcs', 2850000],
  ['Paper A4', 'ream', 5400000],
  ['Pens blue', 'box', 1200000],
  ['Folder', 'pcs', 900000],
];
const inventory = [['Item', 'Unit', 'Stock value'], ...STOCK];
const QUARTERS: [string, number, number, number, number][] = [
  ['North', 1200, 1350, 1100, 1600],
  ['South', 2100, 1950, 2300, 2500],
  ['East', 900, 1000, 950, 1200],
  ['West', 1500, 1400, 1700, 1650],
  ['Central', 700, 800, 650, 900],
];
const totals = [['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'], ...QUARTERS.map((r) => [...r, r[1] + r[2] + r[3] + r[4]])];
const MARKS: [string, number, number][] = [
  ['Hà', 9.5, 9.5],
  ['Minh', 5, 5.5],
  ['Lan', 7, 8],
  ['Tuấn', 6.5, 6],
];
const gradebook = [['Student', 'Math', 'Literature', 'Average'], ...MARKS.map(([s, m, l]) => [s, m, l, (m + l) / 2])];
const ACCOUNTS: [string, number, number][] = [
  ['Travel', 15000, 9800],
  ['Marketing', 20000, 23100],
  ['Software', 10000, 11500],
  ['Office', 5000, 5000],
];
const variance = [
  ['Account', 'Budget', 'Actual', 'Variance', 'Variance %'],
  ...ACCOUNTS.map(([a, b, c]) => [a, b, c, c - b, `${(((c - b) / b) * 100).toFixed(2)}%`]),
];
const SPENT: [string, number][] = [
  ['Tiền nhà', 4500000],
  ['Điện', 1250000],
  ['Đi chợ', 3200000],
  ['Học phí', 2000000],
];
const household = [['STT', 'Khoản chi', 'Số tiền'], ...SPENT.map(([k, v], i) => [i + 1, k, v])];
const WEEKS = 30;
const wide = [
  ['Store', 'Region', ...Array.from({ length: WEEKS }, (_, i) => `W${i + 1}`), 'Total'],
  ...['Ben Thanh', 'Cho Lon', 'Thu Duc'].map((store, s) => {
    const weeks = Array.from({ length: WEEKS }, (_, i) => 100 + s * 10 + i);
    return [store, s === 2 ? 'East' : 'Central', ...weeks, weeks.reduce((a, b) => a + b, 0)];
  }),
];

const handler = createHandler({
  index: buildIndex([
    table('q1 sales', q1),
    table('inventory', inventory),
    table('regions total', totals),
    table('gradebook', gradebook),
    table('budget variance', variance),
    table('chi tieu', household),
    table('weekly', wide),
    table('subtotal count', [['Team', 'Hours'], ['Ops', 4], ['Web', 6]]),
    table('subtotal average', [['Category', 'Amount'], ['Food', 120], ['Rent', 900]]),
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
        'x-landmark-session': 'router2-files',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = JSON.parse(await res.text()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
  return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
}

interface Turn {
  plan: { tool?: string; args?: Record<string, unknown>; speak?: string };
  payload: Record<string, unknown> | null;
  spoken: string;
}
const say = async (u: string): Promise<Turn> => (await converse(u, call)) as Turn;

async function open(name: string): Promise<void> {
  resetContext();
  await loadCatalogue(call);
  const described = await say(`open the ${name} table`);
  assert.equal(described.plan.tool, 'table_describe', `could not open ${name}: ${described.spoken}`);
}

const product = (name: string) => PRODUCTS.find((p) => p[0] === name)!;

test('part of a product name is that product, said back, and never the whole table', async () => {
  await open('q1 sales');
  const matcha = await say('what was the revenue for matcha in march');
  assert.equal(matcha.payload?.['result'], product('Matcha 100g')[6], 'was the March total of every product');
  assert.match(matcha.spoken, /^Taking matcha as Matcha 100g\. /);
  const tea = await say('what was the march revenue of green tea');
  assert.equal(tea.payload?.['result'], product('Green tea 500g')[6]);

  // Two products hold "coffee beans": asked which, then answered for the one chosen.
  const which = await say('total march revenue for coffee beans');
  assert.equal(which.plan.tool, undefined);
  assert.equal(which.spoken, 'Which Product do you mean: Coffee beans 1kg or Coffee beans 500g?');
  const chosen = await say('the 500g one');
  assert.equal(chosen.payload?.['result'], product('Coffee beans 500g')[6]);

  await open('inventory');
  const stapler = await say('what is the stock value of the stapler');
  assert.equal(stapler.payload?.['result'], STOCK[0][2], 'was the stock value of everything');
});

test('"how many units in March" is March\'s units; with no month, it is asked', async () => {
  await open('q1 sales');
  const march = PRODUCTS.reduce((s, p) => s + p[5], 0);
  assert.equal((await say('how many units in march')).payload?.['result'], march, 'was January');
  assert.equal((await say('how many units were sold in march')).payload?.['result'], march);
  assert.equal((await say('how many units did matcha 100g sell in march')).payload?.['result'], product('Matcha 100g')[5]);
  const bare = await say('how many units');
  assert.equal(bare.spoken, 'Which one: January Units, February Units or March Units?');
  assert.equal((await say('february')).payload?.['result'], PRODUCTS.reduce((s, p) => s + p[3], 0));
});

test('a column called Total or Average is that column, and the other word is the figure', async () => {
  const sums = QUARTERS.map((r) => r[1] + r[2] + r[3] + r[4]);
  await open('regions total');
  for (const q of ['average total', 'what is the average of the total column']) {
    const t = await say(q);
    assert.equal(t.plan.args?.['aggregate'], 'avg', q);
    assert.equal(t.payload?.['result'], sums.reduce((a, b) => a + b, 0) / sums.length, q);
  }
  assert.equal((await say('what is the lowest total')).payload?.['result'], Math.min(...sums));
  assert.equal((await say('what is the total')).payload?.['result'], sums.reduce((a, b) => a + b, 0));

  const averages = MARKS.map(([, m, l]) => (m + l) / 2);
  await open('gradebook');
  for (const q of ['who has the lowest average', 'which student has the lowest average']) {
    const t = await say(q);
    assert.equal(t.payload?.['result'], Math.min(...averages), `${q}: ${t.spoken}`);
    assert.match(t.spoken, /for Minh\./, q);
  }
  assert.equal((await say('highest average')).payload?.['result'], Math.max(...averages));
  // A column named whole still decides: the average of Math, not of Average.
  assert.equal((await say('what is the average math score')).payload?.['result'], MARKS.reduce((s, [, m]) => s + m, 0) / MARKS.length);
});

test('a Variance column can be asked about, and a file named for it opened', async () => {
  resetContext();
  await loadCatalogue(call);
  const opened = await say('open the budget variance table');
  assert.equal(opened.plan.tool, 'table_describe', 'was "I cannot work out a variance"');
  const gaps = ACCOUNTS.map(([, b, c]) => c - b);
  assert.equal((await say('what is the total variance')).payload?.['result'], gaps.reduce((a, b) => a + b, 0));
  const lowest = await say('which account has the lowest variance');
  assert.equal(lowest.payload?.['result'], Math.min(...gaps));
  assert.match(lowest.spoken, /for Travel\./);
  // A figure this client cannot work out is still refused.
  assert.match((await say('what is the median actual')).spoken, /^I cannot work out a median\./);
});

test('a row-number column is not offered as a figure to total', async () => {
  await open('chi tieu');
  const t = await say('what is the total');
  assert.equal(t.plan.args?.['aggregate_column'], 'Số tiền', `was "Which column? I have STT and Số tiền": ${t.spoken}`);
  assert.equal(t.payload?.['result'], SPENT.reduce((s, [, v]) => s + v, 0));
});

test('a wide table\'s column names can all be heard, a page at a time', async () => {
  await open('weekly');
  const names = wide[0] as string[];
  const first = await say('what are the columns');
  assert.equal(first.spoken, `The columns are ${names.slice(0, 10).join(', ')}, and ${names.length - 10} more. Say more for the rest.`);
  const next = await say('more');
  assert.equal(next.spoken, `The next columns are ${names.slice(10, 20).join(', ')}, and ${names.length - 20} more. Say more for the rest.`);
  assert.equal((await say('what is the last column')).spoken, `The last column is ${names.at(-1)}.`);

  // After describe's "and 24 more", "more" reads on through the names instead of
  // saying there is nothing more — from where describe stopped, at W7.
  await say('describe it');
  const after = await say('more');
  assert.doesNotMatch(after.spoken, /That was all of it/);
  assert.match(after.spoken, /\bW7\b/);
});

test('a file whose name holds "count", "average" or "total" opens when named', async () => {
  resetContext();
  await loadCatalogue(call);
  const count = await say('open the subtotal count file');
  assert.equal(count.plan.tool, 'table_describe', count.spoken);
  assert.equal(count.plan.args?.['table_id'], 'subtotal-count');
  const average = await say('open the subtotal average file');
  assert.equal(average.plan.args?.['table_id'], 'subtotal-average', average.spoken);
  const totals = await say('open the regions total file');
  assert.equal(totals.plan.tool, 'table_describe', 'was answered as a question about a total');
});
