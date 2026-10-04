/**
 * What a second fresh-eyes review found in the router's first round of fixes, through the
 * real voice client and the real handler: a question passed back and forth between two
 * files until the page ran out of stack; "the biggest line item per department" spoken as
 * each department's total; "did better than Anh" read as Anh; "the total number of units"
 * counted as rows; a refused comparison leaving a figure nobody heard as the last answer;
 * "a population under 1 million" asked about in a loop; "an average deal" read as the rep
 * An; and a Variance column in one file refusing "variance" in every other.
 *
 * Every truth is worked out here from the rows — of data/index.json, or of a grid built
 * the way ingest builds any file — never copied from a reply. An honest question back is
 * accepted where one is pinned; a wrong figure never is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createHandler } from '../src/server.ts';
import { assertIndex } from '../src/indexfmt.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { context, converse, loadCatalogue, resetContext } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(parsed);
const bundled = createHandler({ index: parsed });

// Files shaped as real ones are, for what the bundled samples do not hold.
const grid = (name: string, rows: unknown[][]) =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid: rows, merges: [] }], warnings: [] });
const ORDERS: [string, string, number, number][] = [
  ['A1', 'Latte', 2, 45000],
  ['A2', 'Espresso', 1, 30000],
  ['A3', 'Latte', 3, 45000],
  ['A4', 'Tea', 2, 25000],
  ['A5', 'Latte', 1, 45000],
];
// Product, then January, February and March, each as Units and Revenue.
const MONTHS: [string, number, number, number, number, number, number][] = [
  ['Matcha 100g', 25, 7500000, 40, 12000000, 60, 18000000],
  ['Cocoa powder', 30, 4500000, 35, 5250000, 49, 7350000],
  ['Green tea 500g', 60, 7200000, 70, 8400000, 76, 9120000],
];
// Item, its unit of measure, how many are on hand, and their value.
const STOCK: [string, string, number, number][] = [
  ['Stapler, medium', 'pcs', 30, 2850000],
  ['Paper A4', 'ream', 85, 5400000],
  ['Folder', 'box', 12, 900000],
];
const MARKS: [string, number][] = [
  ['Hà', 9.5],
  ['Minh', 5.25],
  ['Lan', 7.5],
  ['Tuấn', 6],
];
const READINGS: [string, number][] = [
  ['Hanoi', 31],
  ['Hanoi', 29],
  ['Saigon', 34],
];
const ACCOUNTS: [string, number, number][] = [
  ['Travel', 15000, 9800],
  ['Marketing', 20000, 23100],
  ['Office', 5000, 5000],
];
const own = createHandler({
  index: buildIndex([
    grid('cafe orders', [['Order', 'Item', 'Qty', 'Unit price'], ...ORDERS]),
    grid('q1 units', [
      [null, 'January', 'January', 'February', 'February', 'March', 'March'],
      ['Product', 'Units', 'Revenue', 'Units', 'Revenue', 'Units', 'Revenue'],
      ...MONTHS,
    ]),
    grid('inventory', [['Item', 'Unit', 'Qty on hand', 'Stock value'], ...STOCK]),
    grid('gradebook', [['Student', 'Average'], ...MARKS]),
    grid('weather', [['Station', 'Temp (°C)'], ...READINGS]),
    grid('budget variance', [['Account', 'Budget', 'Actual', 'Variance'], ...ACCOUNTS.map(([a, b, c]) => [a, b, c, c - b])]),
  ]),
});

let handler = bundled;
let session = 'router2-review-0';
let seq = 0;

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
  const body = JSON.parse(await res.text()) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  assert.ok(body.result, `tool ${name} failed at the protocol level`);
  return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
}

interface Turn {
  plan: { tool?: string; args?: Record<string, unknown>; speak?: string };
  payload: Record<string, unknown> | null;
  spoken: string;
}
const say = async (u: string): Promise<Turn> => (await converse(u, call)) as Turn;

async function open(phrase: string, files = bundled): Promise<void> {
  handler = files;
  session = `router2-review-${++seq}`;
  resetContext();
  await loadCatalogue(call);
  if (phrase) await say(phrase);
}

async function ask(table: string, question: string, files = bundled): Promise<Turn> {
  await open(table, files);
  return say(question);
}

const SALES = 'open the sales table';
const BUDGET = 'open the budget file';
const COUNTRIES = 'open the countries table';

type Row = Record<string, string | number>;
const tables = (parsed as { tables: { id: string; regions: { rows: unknown[][] }[] }[] }).tables;
function rowsOf(id: string, keys: string[], region = 0): Row[] {
  return tables.find((t) => t.id === id)!.regions[region]!.rows.map((r) =>
    Object.fromEntries(keys.map((k, i) => [k, typeof r[i] === 'string' && /^-?\d+(\.\d+)?$/.test(r[i] as string) ? Number(r[i]) : (r[i] as string | number)])),
  );
}
const sales = rowsOf('01-flat', ['Region', 'Rep', 'Revenue', 'Closed']);
const budget = rowsOf('04-title-and-vmerge', ['Department', 'Item', 'Amount']);
const countries = rowsOf('06-countries', ['Country', 'Population', 'GDP', 'Region']);
const quarterly = rowsOf('02-stacked-header', ['Region', 'Q1', 'Q2', 'Q3']);
const units = rowsOf('05-three-regions', ['Product', 'Units']);
const targets = rowsOf('05-three-regions', ['Region', 'Target', 'Actual'], 1);

const num = (r: Row, k: string): number => Number(r[k]);
const total = (rows: Row[], k: string): number => rows.reduce((s, r) => s + num(r, k), 0);
const mean = (rows: Row[], k: string): number => total(rows, k) / rows.length;
const of = (rows: Row[], k: string, v: string): Row => rows.find((r) => r[k] === v)!;
const groupsOf = (t: Turn) => (t.payload?.['groups'] ?? []) as { key: string; value: number }[];
const labelsOf = (t: Turn) => ((t.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort();
/** Each group's highest or lowest, as the truth for "the biggest … in each …". */
function extremes(rows: Row[], by: string, k: string, pick: (...n: number[]) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of new Set(rows.map((r) => String(r[by])))) out[key] = pick(...rows.filter((r) => r[by] === key).map((r) => num(r, k)));
  return out;
}
const asRecord = (t: Turn) => Object.fromEntries(groupsOf(t).map((g) => [g.key, g.value]));

// ── one move to another file, never a loop ──────────────────────────────────

test('a word only another file has does not pass the question back and forth, nor leave the file switched', async () => {
  for (const q of ['deals closed in 2025', 'revenue from deals closed in 2025', 'population closed', 'line items closed']) {
    await open(SALES);
    const t = await say(q); // threw "Maximum call stack size exceeded"
    assert.equal(typeof t.spoken, 'string', q);
    assert.match(t.spoken, /could not find/, q);
    assert.equal(context.tableId, '01-flat', `${q}: left in another file without a word`);
    assert.equal((await say('how many rows')).payload?.['result'], sales.length, `${q}: the next question was asked of another file`);
  }
});

test('a question about another file moves there once, says so, and answers from it', async () => {
  const engineering = await ask(SALES, 'total amount for engineering');
  assert.equal(engineering.payload?.['result'], total(budget.filter((r) => r['Department'] === 'Engineering'), 'Amount'));
  assert.match(engineering.spoken, /^In FY2026 Departmental Budget\. /);

  // Only table 2 of the three-regions file has Target: it is moved to, and named.
  const byRegion = await ask(BUDGET, 'targets by region');
  assert.deepEqual(asRecord(byRegion), Object.fromEntries(targets.map((r) => [r['Region'], num(r, 'Target')])), byRegion.spoken);
  assert.match(byRegion.spoken, /^In Mixed sheet, table 2\. /);

  // Two files have Q2: asked which, and "the first one" is the first offered.
  const q2 = await ask(SALES, 'what is the q2 revenue');
  assert.equal(q2.spoken, 'Which file? "q2" is in Quarterly data and Compare sheet.');
  const first = await say('the first one');
  assert.equal(first.payload?.['result'], total(quarterly, 'Q2'), 'opened the file already open');
  assert.match(first.spoken, /^In Quarterly data\. /);
});

// ── the biggest row in each group ───────────────────────────────────────────

test('"the biggest line item per department" is each department\'s biggest line item, not its total', async () => {
  const biggest = extremes(budget, 'Department', 'Amount', Math.max);
  for (const q of ['which department has the biggest line item', 'biggest line item per department', 'the largest line item by department']) {
    const t = await ask(BUDGET, q);
    assert.equal(t.plan.args?.['aggregate'], 'max', q);
    assert.deepEqual(asRecord(t), biggest, `${q}: ${t.spoken}`);
  }
  assert.deepEqual(biggest, { Engineering: 480000, Design: 210000 });
  const smallest = extremes(budget, 'Department', 'Amount', Math.min);
  for (const q of ['which department has the smallest line item', 'what is the smallest line item in each department', 'the cheapest line item in each department']) {
    const t = await ask(BUDGET, q);
    assert.deepEqual(asRecord(t), smallest, `${q}: ${t.spoken}`);
    assert.equal(t.plan.args?.['order'], 'asc', q);
  }
});

test('"the biggest deal in each region" is each region\'s biggest deal; "which region has the highest revenue" still totals', async () => {
  const biggest = extremes(sales, 'Region', 'Revenue', Math.max);
  for (const q of ['the biggest deal in each region', 'what was the highest revenue in each region']) {
    const t = await ask(SALES, q);
    assert.deepEqual(asRecord(t), biggest, `${q}: ${t.spoken}`);
  }
  assert.equal(biggest['South'], 21000);
  const smallest = await ask(SALES, 'which region has the smallest deal');
  const lowest = Math.min(...sales.map((r) => num(r, 'Revenue')));
  // Lowest first: the region holding the smallest deal, with that deal's figure.
  assert.equal(groupsOf(smallest)[0]?.key, String(sales.find((r) => num(r, 'Revenue') === lowest)!['Region']), smallest.spoken);
  assert.equal(groupsOf(smallest)[0]?.value, lowest);
  // Naming a figure, with "which", ranks the regions by their totals, as before.
  const totals = await ask(SALES, 'which region has the highest revenue');
  assert.equal(totals.plan.args?.['aggregate'], 'sum');
  assert.equal(asRecord(totals)['South'], total(sales.filter((r) => r['Region'] === 'South'), 'Revenue'));
});

// ── better and worse than a named row ───────────────────────────────────────

test('"did better than Anh" and "worse than Chi" compare with their figures', async () => {
  const anh = num(of(sales, 'Rep', 'Anh'), 'Revenue');
  const chi = num(of(sales, 'Rep', 'Chi'), 'Revenue');
  const better = await ask(SALES, 'which reps did better than Anh');
  assert.deepEqual(labelsOf(better), sales.filter((r) => num(r, 'Revenue') > anh).map((r) => String(r['Rep'])).sort(), better.spoken);
  const worse = await ask(SALES, 'how many reps did worse than Chi');
  assert.equal(worse.payload?.['result'], sales.filter((r) => num(r, 'Revenue') < chi).length, worse.spoken);
  const above = await ask(SALES, 'who sold above Anh');
  assert.deepEqual(labelsOf(above), sales.filter((r) => num(r, 'Revenue') > anh).map((r) => String(r['Rep'])).sort(), above.spoken);

  // Nobody has a better average than the best student: no rows, said as none.
  const top = Math.max(...MARKS.map(([, a]) => a));
  const best = MARKS.find(([, a]) => a === top)![0];
  const none = await ask('open the gradebook table', `who has a better average than ${best}`, own);
  assert.equal(none.payload?.['matched_rows'], 0, none.spoken);
  assert.match(none.spoken, /No rows match/);
  // "Better" alone could be any number column; with one, it is that one.
  const minh = MARKS.find(([s]) => s === 'Minh')![1];
  const who = await ask('open the gradebook table', 'who did better than Minh', own);
  assert.deepEqual(labelsOf(who), MARKS.filter(([, a]) => a > minh).map(([s]) => s).sort(), who.spoken);
});

test('"bigger than an average deal" is compared with the average, not with the rep An', async () => {
  const average = mean(sales, 'Revenue');
  for (const q of ['how many deals were bigger than an average deal', 'how many deals were above the average one']) {
    const t = await ask(SALES, q);
    assert.equal(t.payload?.['result'], sales.filter((r) => num(r, 'Revenue') > average).length, `${q}: ${t.spoken}`);
    assert.doesNotMatch(t.spoken, /^An:/, q);
  }
});

// ── what is counted ─────────────────────────────────────────────────────────

test('"the total number of units" is the units, not the rows', async () => {
  const sum = total(units, 'Units');
  for (const q of ["what's the total number of units", 'what is the total number of units sold', 'what is the number of units in total']) {
    assert.equal((await ask('open the three regions file', q)).payload?.['result'], sum, q);
  }
  assert.equal(sum, 165);
  const march = MONTHS.reduce((s, m) => s + m[5], 0);
  assert.equal((await ask('open the q1 units table', "what's the total number of units in march", own)).payload?.['result'], march);
  const lattes = ORDERS.filter((o) => o[1] === 'Latte').reduce((s, o) => s + o[2], 0);
  assert.equal((await ask('open the cafe orders table', "what's the total number of lattes", own)).payload?.['result'], lattes);
  assert.equal((await say('how many lattes')).payload?.['result'], lattes);
});

// ── a comparison refused leaves nothing behind ──────────────────────────────

test('a refused comparison does not leave its hidden lookup as the last answer', async () => {
  const design = budget.filter((r) => r['Department'] === 'Design');
  await open(BUDGET);
  assert.equal((await say('total amount for design')).payload?.['result'], total(design, 'Amount'));
  const refused = await say('which line items cost less than salaries');
  assert.equal(refused.plan.tool, undefined);
  assert.match((await say('how do you know')).spoken, /^About the earlier answer, 234 thousand, the total of Amount for Design: /, 'named a figure never said');
  assert.equal((await say('and the average')).payload?.['result'], mean(design, 'Amount'), "was Salaries' average");

  await open(BUDGET);
  await say('total amount for design');
  await say('how many items are in the same department as salaries');
  assert.match((await say('how do you know')).spoken, /^About the earlier answer, 234 thousand, the total of Amount for Design: /);
});

// ── a condition on a column named with it ───────────────────────────────────

test('a condition on the column named with it is answered, even when no row meets it', async () => {
  const cases: [string, number][] = [
    ['how many countries have a population under 1 million', countries.filter((r) => num(r, 'Population') < 1e6).length],
    ['how many countries have a gdp per capita over 100000', countries.filter((r) => num(r, 'GDP') > 100000).length],
  ];
  for (const [q, truth] of cases) {
    const t = await ask(COUNTRIES, q);
    assert.equal(t.plan.tool, 'table_query', `${q}: asked "which column?" in a loop`);
    assert.equal(t.payload?.['result'] ?? 0, truth, q);
    assert.equal(t.payload?.['matched_rows'], truth, q);
  }
  // "Over 50 million people" is still asked about, and the reply finishes that condition,
  // not the one after it.
  await open(COUNTRIES);
  const which = await say('how many countries with over 50 million people have a gdp per capita under 5000');
  assert.match(which.spoken, /^Which column should be over 50 million people\?/);
  const answered = await say('population');
  assert.equal(answered.payload?.['result'], countries.filter((r) => num(r, 'Population') > 50e6 && num(r, 'GDP') < 5000).length, answered.spoken);
});

// ── a figure called variance ────────────────────────────────────────────────

test('a Variance column in one file does not stop "variance" being refused in another', async () => {
  const variance = await ask('open the weather table', 'what is the variance of the temperature', own);
  assert.match(variance.spoken, /^I cannot work out a variance\./);
  // Asked for by its name, the Variance column is found in the file that has it.
  const there = await ask('open the weather table', 'what is the total variance', own);
  assert.equal(there.payload?.['result'], ACCOUNTS.reduce((s, [, b, c]) => s + c - b, 0), there.spoken);
  assert.match(there.spoken, /^In Budget variance\. /);
});

// ── smaller things ──────────────────────────────────────────────────────────

test('wording: a region is "not one row", and an earlier answer is quoted mid-sentence', async () => {
  const east = await ask(SALES, 'how many reps sold more than the east');
  assert.match(east.spoken, /^East is a Region, not one row/);
  await open(SALES);
  await say('total revenue');
  await say('what is the median revenue');
  assert.match((await say('how do you know')).spoken, /^About the earlier answer, about 61\.1 thousand, the total of Revenue: /);
});

test('"list the deals by region" lists the deals; "list the items by amount" ranks them, and says what a repeated item is', async () => {
  const deals = await ask(SALES, 'list the deals by region');
  assert.equal(deals.plan.args?.['aggregate'], 'none', 'was each region\'s total revenue');
  assert.deepEqual(labelsOf(deals), sales.map((r) => String(r['Rep'])).sort());
  const countriesListed = await ask(COUNTRIES, 'list the countries by region');
  assert.equal(countriesListed.plan.args?.['aggregate'], 'none', 'was "Country holds text"');
  const items = await ask(BUDGET, 'list the items by amount');
  assert.equal(asRecord(items)['Salaries'], total(budget.filter((r) => r['Item'] === 'Salaries'), 'Amount'));
  assert.match(items.spoken, /^Where a line item is on more than one row, its figure is their total\. /);
});

test('part of a name said where a name does not go is asked about, not taken', async () => {
  const medium = await ask('open the inventory table', 'which items have medium stock', own);
  assert.equal(medium.plan.tool, undefined, 'answered for the stapler alone');
  assert.equal(medium.spoken, 'Do you mean the Item Stapler, medium? Say yes or no.');
  // Yes: the stapler, as asked.
  assert.equal(asRecord(await say('yes'))[STOCK[0][0]], STOCK[0][3]);
  // Where a name goes, it is still taken, and said.
  const stapler = await ask('open the inventory table', 'what is the stock value of the stapler', own);
  assert.equal(stapler.payload?.['result'], STOCK[0][3]);
});

test('two named rows in one question are both looked up', async () => {
  await open('');
  const chi = num(of(sales, 'Rep', 'Chi'), 'Revenue');
  const bao = num(of(sales, 'Rep', 'Bảo'), 'Revenue');
  const t = await say('how many reps earned less than Chi and more than Bao');
  assert.equal(t.payload?.['result'], sales.filter((r) => num(r, 'Revenue') < chi && num(r, 'Revenue') > bao).length, t.spoken);
});

test('things said between questions are not looked up as words of the table', async () => {
  await open(SALES);
  for (const q of ['great', 'cool', 'thanks']) {
    const t = await say(q);
    assert.doesNotMatch(t.spoken, /could not find/, q);
    assert.equal(t.plan.tool, undefined, q);
  }
  assert.equal((await say('goodbye')).spoken, 'Goodbye.');
  await say('total revenue');
  assert.match((await say("that's wrong")).spoken, /^Sorry about that\. Say "how do you know"/);
  const again = await say('huh');
  assert.match(again.spoken, /^Sorry about that\./, 'repeats the last reply');
});

// ── what a probe of new questions found ─────────────────────────────────────

test('two named groups compared are compared by their totals; "combined" is one figure', async () => {
  const region = (name: string) => total(sales.filter((r) => r['Region'] === name), 'Revenue');
  const better = await ask(SALES, 'is the north doing better than the east');
  assert.deepEqual(asRecord(better), { North: region('North'), East: region('East') }, `was each one's biggest deal: ${better.spoken}`);
  const both = await ask(SALES, 'combined revenue of anh and bao');
  assert.equal(both.payload?.['result'], num(of(sales, 'Rep', 'Anh'), 'Revenue') + num(of(sales, 'Rep', 'Bảo'), 'Revenue'));
  assert.equal((await ask(SALES, "what's the smallest deal anh closed")).payload?.['result'], num(of(sales, 'Rep', 'Anh'), 'Revenue'), 'was "Closed holds dates"');
  const anh = num(of(sales, 'Rep', 'Anh'), 'Revenue');
  assert.equal((await ask(SALES, 'how many reps beat anh')).payload?.['result'], sales.filter((r) => num(r, 'Revenue') > anh).length);
});

test('a record named with "which" is read; "per line item" is the average of the rows; "items that cost more" are listed', async () => {
  const norway = await ask(COUNTRIES, 'which region is norway in');
  assert.deepEqual(labelsOf(norway), ['Norway'], `was "Which column?": ${norway.spoken}`);
  assert.match(norway.spoken, /Region Europe/);
  const engineering = budget.filter((r) => r['Department'] === 'Engineering');
  const per = await ask(BUDGET, 'average spend per line item in engineering');
  assert.ok(Math.abs(Number(per.payload?.['result']) - mean(engineering, 'Amount')) < 0.01, per.spoken);
  const travel = num(of(budget, 'Item', 'Travel'), 'Amount');
  const items = await ask(BUDGET, 'items that cost more than travel');
  assert.deepEqual(labelsOf(items), budget.filter((r) => num(r, 'Amount') > travel).map((r) => String(r['Item'])).sort(), `was their total: ${items.spoken}`);
});

test('a reply that is a question of its own is not folded into the question waiting', async () => {
  // After "I could not find hit", "actual for the south" is asked as itself.
  await open('open the three regions file');
  await say('table 2');
  await say('did the south hit its target');
  assert.equal((await say('actual for the south')).payload?.['result'], num(of(targets, 'Region', 'South'), 'Actual'), 'was "Which one: Target or Actual?"');
  // After "February Units or February Revenue?" about matcha, another product and month.
  await open('open the q1 units table', own);
  const which = await say('what did matcha make in february');
  assert.match(which.spoken, /Which one: February Units or February Revenue\?$/);
  const cocoa = MONTHS.find((m) => m[0] === 'Cocoa powder')!;
  assert.equal((await say('cocoa powder units in january')).payload?.['result'], cocoa[1], "was matcha's February units");
});

test('what is counted: units named after a product, units on hand beside a Unit column, and orders', async () => {
  const cocoa = MONTHS.find((m) => m[0] === 'Cocoa powder')!;
  assert.equal((await ask('open the q1 units table', 'how many cocoa units in march', own)).payload?.['result'], cocoa[5], 'was a count of rows');
  const onHand = await ask('open the inventory table', 'how many units are on hand altogether', own);
  assert.equal(onHand.payload?.['result'], STOCK.reduce((s, x) => s + x[2], 0), `counted rows per unit of measure: ${onHand.spoken}`);
  const espresso = await ask('open the cafe orders table', 'how many espresso orders', own);
  assert.equal(espresso.payload?.['result'], ORDERS.filter((o) => o[1] === 'Espresso').length, 'was the cups in them');
});

test('a value named before any file, or in another file, is found there once its values are known', async () => {
  await open('');
  assert.equal((await say('how many widgets do we have')).payload?.['result'], num(of(units, 'Product', 'Widget'), 'Units'), 'was "Which file?" over every file');
  await open('');
  assert.equal((await say("what's chi's revenue")).payload?.['result'], num(of(sales, 'Rep', 'Chi'), 'Revenue'));
  const anh = await ask(COUNTRIES, 'what did anh sell');
  assert.equal(anh.payload?.['result'], num(of(sales, 'Rep', 'Anh'), 'Revenue'));
  assert.match(anh.spoken, /^In Sales data\. /);
});

test('"more deals", "fewer items" and "more countries" count rows in each group, never total a figure', async () => {
  const countBy = (rows: Row[], k: string) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r[k])] = (out[String(r[k])] ?? 0) + 1;
    return out;
  };
  for (const q of ['which region has more deals', 'which region closed more deals']) {
    const t = await ask(SALES, q);
    assert.deepEqual(asRecord(t), countBy(sales, 'Region'), `was each region's revenue, as deals: ${t.spoken}`);
  }
  assert.deepEqual(asRecord(await ask(BUDGET, 'which department has fewer items')), countBy(budget, 'Department'));
  assert.deepEqual(asRecord(await ask(COUNTRIES, 'which region has more countries')), countBy(countries, 'Region'));
  const two = await ask(SALES, 'does the north have more deals than the east');
  const all = countBy(sales, 'Region');
  assert.deepEqual(asRecord(two), { North: all['North'], East: all['East'] }, two.spoken);
});

test('a heading written short is reached by the word said whole: "temperature" for Temp', async () => {
  const hanoi = READINGS.filter(([s]) => s === 'Hanoi').map(([, v]) => v);
  const t = await ask('open the weather table', 'average temperature at hanoi', own);
  assert.equal(t.payload?.['result'], hanoi.reduce((a, b) => a + b, 0) / hanoi.length, t.spoken);
});
