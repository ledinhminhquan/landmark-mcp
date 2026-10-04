/**
 * Questions a fresh-eyes review asked of the bundled tables, through the real voice
 * client, each of which once came back with a confident wrong number, or with a
 * description of the table in place of an answer.
 *
 * The truth in every case is worked out here from the rows of data/index.json, not
 * copied from a reply: "less than Chi" is the reps whose revenue is below Chi's, "the
 * biggest deal" the largest Revenue, "top three" the three largest. An honest question
 * back is an acceptable answer where one is pinned; a wrong figure never is.
 *
 * Driven exactly as the page drives it: `converse()` routes the words, makes any quiet
 * preparatory call — a describe, or the named row's own figure — runs the answering tool
 * behind the real handler, and folds the reply back into the conversation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createHandler } from '../src/server.ts';
import { assertIndex } from '../src/indexfmt.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(parsed);
const handler = createHandler({ index: parsed });

let session = 'router2-0';
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

async function open(phrase: string): Promise<void> {
  session = `router2-${++seq}`;
  resetContext();
  await loadCatalogue(call);
  if (phrase) await say(phrase);
}

async function ask(table: string, question: string): Promise<Turn> {
  await open(table);
  return say(question);
}

const SALES = 'open the sales table';
const BUDGET = 'open the budget file';
const COUNTRIES = 'open the countries table';
const QUARTERLY = 'open the quarterly table';
const MERGED = 'open the merged header file';

// ── the truth, from the rows ────────────────────────────────────────────────

type Row = Record<string, string | number>;
const tables = (parsed as { tables: { id: string; regions: { rows: unknown[][] }[] }[] }).tables;
function rowsOf(id: string, keys: string[]): Row[] {
  const region = tables.find((t) => t.id === id)!.regions[0]!;
  return region.rows.map((r) =>
    Object.fromEntries(keys.map((k, i) => [k, typeof r[i] === 'string' && /^-?\d+(\.\d+)?$/.test(r[i] as string) ? Number(r[i]) : (r[i] as string | number)])),
  );
}
const sales = rowsOf('01-flat', ['Region', 'Rep', 'Revenue', 'Closed']);
const budget = rowsOf('04-title-and-vmerge', ['Department', 'Item', 'Amount']);
const countries = rowsOf('06-countries', ['Country', 'Population', 'GDP', 'Region']);
const quarterly = rowsOf('02-stacked-header', ['Region', 'Q1', 'Q2', 'Q3']);
const merged = rowsOf('03-merged-header', ['Region', 'y26q1', 'y26q2', 'y25q1', 'y25q2']);

const num = (r: Row, k: string): number => Number(r[k]);
const total = (rows: Row[], k: string): number => rows.reduce((s, r) => s + num(r, k), 0);
const mean = (rows: Row[], k: string): number => total(rows, k) / rows.length;
const of = (rows: Row[], k: string, v: string): Row => rows.find((r) => r[k] === v)!;
const month = (r: Row): number => new Date(String(r['Closed'])).getUTCMonth() + 1;
/** Labels largest first by a figure, as a ranking says them. */
const ranked = (rows: Row[], label: string, k: string): string[] =>
  [...rows].sort((a, b) => num(b, k) - num(a, k)).map((r) => String(r[label]));

// ── compared with a named row ───────────────────────────────────────────────

test('"less than Chi" compares with Chi\'s figure, and says it, rather than counting Chi', async () => {
  const chi = num(of(sales, 'Rep', 'Chi'), 'Revenue');
  const anh = num(of(sales, 'Rep', 'Anh'), 'Revenue');
  const cases: [string, string, number][] = [
    [SALES, 'how many reps earned less than Chi', sales.filter((r) => num(r, 'Revenue') < chi).length],
    [SALES, 'how many deals had more revenue than Anh', sales.filter((r) => num(r, 'Revenue') > anh).length],
  ];
  const kenya = num(of(countries, 'Country', 'Kenya'), 'Population');
  const vietnam = num(of(countries, 'Country', 'Vietnam'), 'Population');
  const peru = num(of(countries, 'Country', 'Peru'), 'GDP');
  cases.push(
    [COUNTRIES, 'how many countries have a population less than Kenya', countries.filter((r) => num(r, 'Population') < kenya).length],
    [COUNTRIES, 'how many countries have a higher population than Vietnam', countries.filter((r) => num(r, 'Population') > vietnam).length],
    [COUNTRIES, 'how many countries have a higher gdp per capita than peru', countries.filter((r) => num(r, 'GDP') > peru).length],
    [COUNTRIES, 'what is the total population of countries larger than kenya', total(countries.filter((r) => num(r, 'Population') > kenya), 'Population')],
  );
  const tooling = num(of(budget, 'Item', 'Tooling'), 'Amount');
  cases.push([BUDGET, 'how many items cost more than tooling', budget.filter((r) => num(r, 'Amount') > tooling).length]);
  for (const [table, question, truth] of cases) {
    const t = await ask(table, question);
    assert.equal(t.payload?.['result'], truth, `${question}: ${t.spoken}`);
  }
  // The row's own figure is said first, so the comparison can be checked by ear.
  assert.match((await ask(COUNTRIES, 'how many countries have a population less than Kenya')).spoken, /^Kenya: Population 55,100,586\. 3 rows match\.$/);
});

test('"which countries have a lower GDP per capita than Thailand" names exactly those countries', async () => {
  const thailand = num(of(countries, 'Country', 'Thailand'), 'GDP');
  const truth = countries.filter((r) => num(r, 'GDP') < thailand).map((r) => String(r['Country']));
  const t = await ask(COUNTRIES, 'which countries have a lower GDP per capita than Thailand');
  const named = ((t.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key);
  assert.deepEqual(named.sort(), truth.sort(), t.spoken);

  // "Who sold more than Chi": nobody did, and no figure of Chi's is spoken as theirs.
  const who = await ask(SALES, 'who sold more than chi');
  assert.equal(who.payload?.['matched_rows'], 0, who.spoken);
  const reps = await ask(SALES, 'which reps sold less than An');
  const an = num(of(sales, 'Rep', 'An'), 'Revenue');
  assert.deepEqual(
    ((reps.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort(),
    sales.filter((r) => num(r, 'Revenue') < an).map((r) => String(r['Rep'])).sort(),
  );
});

test('"the same region as Kenya" looks Kenya\'s region up, then asks about it', async () => {
  const kenya = String(of(countries, 'Country', 'Kenya')['Region']);
  const t = await ask(COUNTRIES, 'total population of countries in the same region as Kenya');
  assert.equal(t.payload?.['result'], total(countries.filter((r) => r['Region'] === kenya), 'Population'));
  assert.match(t.spoken, /^Kenya: Region Africa\. /);

  const chi = String(of(sales, 'Rep', 'Chi')['Region']);
  assert.equal((await ask(SALES, 'how many reps are in the same region as Chi')).payload?.['result'], sales.filter((r) => r['Region'] === chi).length);
  // "Other" leaves Chi out.
  assert.equal((await ask(SALES, 'how many other reps are in the same region as Chi')).payload?.['result'], sales.filter((r) => r['Region'] === chi).length - 1);
});

test('a later or earlier date than a named row is that row\'s date, looked up', async () => {
  const chi = String(of(sales, 'Rep', 'Chi')['Closed']);
  const t = await ask(SALES, 'reps who closed later than Chi');
  assert.deepEqual(
    ((t.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort(),
    sales.filter((r) => String(r['Closed']) > chi).map((r) => String(r['Rep'])).sort(),
  );
  assert.match(t.spoken, /^Chi: Closed August 2, 2026\. /);
});

test('a row that is on several rows, or a comparative that does not say of what, is asked about', async () => {
  // Salaries is two rows: there is no one Amount to compare with.
  const salaries = await ask(BUDGET, 'how many items cost more than salaries');
  assert.equal(salaries.plan.tool, undefined);
  assert.match(salaries.spoken, /^Salaries is on 2 rows/);
  // "Poorer" than Peru in population, or in GDP per capita? Asked, then answered.
  await open(COUNTRIES);
  const poorer = await say('how many countries are poorer than Peru');
  assert.equal(poorer.plan.tool, undefined);
  assert.match(poorer.spoken, /in which column\? I have Population and GDP per capita/);
  const peru = num(of(countries, 'Country', 'Peru'), 'GDP');
  assert.equal((await say('gdp per capita')).payload?.['result'], countries.filter((r) => num(r, 'GDP') < peru).length);
});

test('questions that name both sides still compare the two', async () => {
  const both = await ask(BUDGET, 'is engineering spending more than design');
  assert.match(both.spoken, /^Engineering, 560 thousand and Design, 234 thousand\./);
  const regions = await ask(SALES, 'did the north earn more than the south');
  assert.equal(regions.spoken, 'South, 24.9 thousand and North, about 20.6 thousand.');
  // Both reps named, one of them between the comparative and "than".
  const reps = await ask(SALES, 'how much more did chi make than anh');
  assert.deepEqual(reps.plan.args?.['filters'], [{ column: 'Rep', op: 'eq', values: ['Anh', 'Chi'] }]);
});

test('"more than the average" compares with the average, and says it', async () => {
  const average = mean(sales, 'Revenue');
  const t = await ask(SALES, 'how many reps sold more than the average');
  assert.equal(t.payload?.['result'], sales.filter((r) => num(r, 'Revenue') > average).length, 'was the average itself');
  assert.match(t.spoken, /^The average Revenue is about 12\.2 thousand\. /);
  const pop = mean(countries, 'Population');
  const above = await ask(COUNTRIES, 'which countries have above average population');
  assert.deepEqual(
    ((above.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key).sort(),
    countries.filter((r) => num(r, 'Population') > pop).map((r) => String(r['Country'])).sort(),
  );
});

// ── the aggregate asked for ─────────────────────────────────────────────────

test('the most specific word chooses the figure: "how much was the biggest deal" is the biggest', async () => {
  const cases: [string, string, number][] = [
    [SALES, 'how much was the biggest deal', Math.max(...sales.map((r) => num(r, 'Revenue')))],
    [SALES, 'how much did the north make on average', mean(sales.filter((r) => r['Region'] === 'North'), 'Revenue')],
    [SALES, 'how many deals are there in total', sales.length],
    [SALES, "what's the total number of deals", sales.length],
    [BUDGET, 'how much is the average amount', mean(budget, 'Amount')],
    [BUDGET, 'how much is the lowest amount for engineering', Math.min(...budget.filter((r) => r['Department'] === 'Engineering').map((r) => num(r, 'Amount')))],
    [BUDGET, 'how many items in total for engineering', budget.filter((r) => r['Department'] === 'Engineering').length],
    [COUNTRIES, 'how much is the average population', mean(countries, 'Population')],
    [COUNTRIES, 'how much is the average gdp per capita in asia', mean(countries.filter((r) => r['Region'] === 'Asia'), 'GDP')],
    [QUARTERLY, 'how much was the highest q1 revenue', Math.max(...quarterly.map((r) => num(r, 'Q1')))],
    [SALES, 'how much did the top rep sell', Math.max(...sales.map((r) => num(r, 'Revenue')))],
    [SALES, 'how many reps altogether', sales.length],
    [COUNTRIES, 'how many countries are there in total', countries.length],
  ];
  for (const [table, question, truth] of cases) {
    const t = await ask(table, question);
    assert.ok(Math.abs(Number(t.payload?.['result']) - truth) < 0.01, `${question}: ${t.spoken} (truth ${truth})`);
  }
});

test('"lowest", "least", "less" and "from smallest to largest" are heard lowest first', async () => {
  const lowAvg = await ask(COUNTRIES, 'which region has the lowest average population');
  assert.equal(lowAvg.plan.args?.['order'], 'asc');
  assert.match(lowAvg.spoken, /^Average Population, lowest first: Europe, /);
  assert.match((await ask(COUNTRIES, 'which region has the least total population')).spoken, /^Lowest first: Americas, /);
  assert.match((await ask(BUDGET, 'which department has the lowest average spend')).spoken, /^Average Amount, lowest first: Design, /);
  assert.match((await ask(BUDGET, 'which department spends less')).spoken, /^Lowest first: Design, /);
  const sorted = await ask(COUNTRIES, 'sort the countries by population from smallest to largest');
  assert.equal(((sorted.payload?.['groups'] ?? []) as { key: string }[])[0]?.key, ranked(countries, 'Country', 'Population').at(-1));
  assert.match((await ask(COUNTRIES, 'rank the countries by gdp per capita from lowest to highest')).spoken, /^Lowest first: Nigeria, 1596, /);
  assert.match((await ask(SALES, 'rank the reps from lowest to highest')).spoken, /^Lowest first: Dũng, 3900, /);
  assert.match((await ask(COUNTRIES, 'list the countries by population in ascending order')).spoken, /^Lowest first: Norway, /);
});

// ── a rep called An ─────────────────────────────────────────────────────────

test('the rep called An is a name before "earn", "and" and "or", not an article', async () => {
  const an = num(of(sales, 'Rep', 'An'), 'Revenue');
  for (const q of ['how much did An earn', 'how much did an earn', 'how much revenue did an earn', 'what did an earn']) {
    assert.equal((await ask(SALES, q)).payload?.['result'], an, q);
  }
  const two = await ask(SALES, 'revenue for an and chi');
  assert.deepEqual(two.plan.args?.['filters'], [{ column: 'Rep', op: 'eq', values: ['An', 'Chi'] }]);
  assert.equal(two.spoken, 'Chi, 21 thousand and An, 15.6 thousand.');
  assert.deepEqual((await ask(SALES, 'how much did an and anh sell')).plan.args?.['filters'], [{ column: 'Rep', op: 'eq', values: ['An', 'Anh'] }]);
  // Unsure is asked, never guessed.
  assert.match((await ask(SALES, 'how much has an earned')).spoken, /^Do you mean the Rep An\?/);
  // An article is still an article.
  assert.equal((await ask(SALES, 'what is an average deal')).payload?.['result'], mean(sales, 'Revenue'));
});

// ── conditions on the right column ──────────────────────────────────────────

test('"people" after a number is asked about, and a column named after the number is used', async () => {
  for (const q of [
    'how many countries with over 50 million people have a gdp per capita under 5000',
    'average gdp per capita of countries with more than 100 million people',
    'highest gdp per capita among countries with more than 100 million people',
  ]) {
    const t = await ask(COUNTRIES, q);
    assert.equal(t.plan.tool, undefined, q);
    assert.match(t.spoken, /^Which column should be (over|more than) \d+ million people\?/, q);
  }
  const after = await ask(COUNTRIES, 'total population of countries with over 5000 dollars gdp per capita');
  assert.equal(after.payload?.['result'], total(countries.filter((r) => num(r, 'GDP') > 5000), 'Population'), 'was the total of GDP per capita');
  // A column another condition holds is not borrowed: two conditions, two columns.
  const two = await ask(COUNTRIES, 'how many countries with over 50 million have a gdp per capita under 5000');
  assert.equal(two.plan.tool, undefined);
  // "Between" is both ends, on one column.
  const between = await ask(COUNTRIES, 'total population of countries with gdp per capita between 4000 and 8000');
  assert.equal(between.payload?.['result'], total(countries.filter((r) => num(r, 'GDP') >= 4000 && num(r, 'GDP') <= 8000), 'Population'));
  const range = await ask(COUNTRIES, 'how many countries have a population between 30 and 60 million');
  assert.equal(range.payload?.['result'], countries.filter((r) => num(r, 'Population') >= 30e6 && num(r, 'Population') <= 60e6).length);
});

test('"total GDP" of a per-person figure is its average, and is said to be one', async () => {
  const t = await ask(COUNTRIES, "what's the total gdp of asia");
  assert.equal(t.plan.args?.['aggregate'], 'avg');
  assert.ok(Math.abs(Number(t.payload?.['result']) - mean(countries.filter((r) => r['Region'] === 'Asia'), 'GDP')) < 0.01);
  assert.match(t.spoken, /^GDP per capita \(USD\) cannot be added up into a total, so this is its average\. /i);
});

// ── places below the top, and how many ──────────────────────────────────────

test('"next highest" is the one below the top, not the top again', async () => {
  const next = await ask(SALES, 'what is the next biggest deal');
  assert.deepEqual(((next.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key), ranked(sales, 'Rep', 'Revenue').slice(0, 2));
  await open(BUDGET);
  await say('highest amount');
  const amounts = budget.map((r) => num(r, 'Amount')).sort((a, b) => b - a);
  const after = await say('and the next highest');
  assert.equal(after.payload?.['result'], amounts[1], 'was the highest again');
  assert.match(after.spoken, /^After the highest, 480,000: 210 thousand/);
  const population = await ask(COUNTRIES, 'next largest population');
  assert.deepEqual(((population.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key), ranked(countries, 'Country', 'Population').slice(0, 2));
  assert.deepEqual(
    (((await ask(SALES, 'second biggest deal')).payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key),
    ranked(sales, 'Rep', 'Revenue').slice(0, 2),
  );
});

test('"top three" is three, and a file\'s name does not hide the number', async () => {
  for (const q of ['top three reps', 'top 3 reps by revenue']) {
    const t = await ask(SALES, q);
    assert.deepEqual(((t.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key), ranked(sales, 'Rep', 'Revenue').slice(0, 3), q);
  }
  const bottom = await ask(SALES, 'bottom 2 reps by revenue');
  assert.deepEqual(((bottom.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key), ranked(sales, 'Rep', 'Revenue').reverse().slice(0, 2));
  const pop = await ask(COUNTRIES, 'top three countries by population');
  assert.deepEqual(((pop.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key), ranked(countries, 'Country', 'Population').slice(0, 3));
  // Words of other files' names are not words this table knows.
  assert.match((await ask(BUDGET, 'total budget for the flat regions')).spoken, /^I could not find "flat regions"/);
});

// ── follow-ups ──────────────────────────────────────────────────────────────

test('"there" and "in it" keep the rows just answered about', async () => {
  const north = sales.filter((r) => r['Region'] === 'North');
  await open(SALES);
  await say('total revenue for the north');
  assert.equal((await say("what's the average there")).payload?.['result'], mean(north, 'Revenue'));
  assert.match((await say('who is the top rep there')).spoken, /^12\.4 thousand, for Anh\./, 'was Chi, of the South');
  await open(BUDGET);
  await say('total amount for design');
  assert.equal((await say("what's the biggest item in it")).payload?.['result'], Math.max(...budget.filter((r) => r['Department'] === 'Design').map((r) => num(r, 'Amount'))));
  // "There" that only says something exists is not one.
  await open(SALES);
  await say('total revenue for the north');
  assert.equal((await say('how many deals are there')).payload?.['result'], sales.length);
});

test('"and the average" after a figure in a two-measure table keeps its column', async () => {
  const asia = countries.filter((r) => r['Region'] === 'Asia');
  await open(COUNTRIES);
  await say('population of asia');
  const average = await say('and the average');
  assert.ok(Math.abs(Number(average.payload?.['result']) - mean(asia, 'Population')) < 0.01, `was "Which column?": ${average.spoken}`);
  await say('total population');
  assert.match((await say('and the highest')).spoken, /^About 277\.5 million, for Indonesia\./);
});

test('a month on its own continues the question; two months are both', async () => {
  const inMonth = (m: number) => sales.filter((r) => month(r) === m);
  await open(SALES);
  await say('total revenue in july');
  assert.equal((await say('what about august')).payload?.['result'], total(inMonth(8), 'Revenue'), 'was a description of the table');
  assert.equal((await say('and september')).payload?.['result'], total(inMonth(9), 'Revenue'));
  await open(SALES);
  await say('how many deals in july');
  assert.equal((await say('what about september')).payload?.['result'], inMonth(9).length);
  assert.equal((await say('and their total revenue')).payload?.['result'], total(inMonth(9), 'Revenue'), 'was July\'s total');
  await open(SALES);
  await say('total revenue in july');
  assert.equal((await say('and in august')).payload?.['result'], total(inMonth(8), 'Revenue'), 'used to read the August rows');
  assert.equal((await ask(SALES, 'revenue for july and august')).payload?.['result'], total([...inMonth(7), ...inMonth(8)], 'Revenue'));
  assert.equal((await ask(SALES, 'how many deals closed in july or august')).payload?.['result'], inMonth(7).length + inMonth(8).length);
});

// ── checking a number ───────────────────────────────────────────────────────

test('the ordinary ways of asking "how do you know" all reach the working', async () => {
  for (const q of ['how did you get that', 'where did you get that', 'how did you work that out', 'can you prove that', 'explain that', 'which cells', 'why', 'show me the working']) {
    await open(SALES);
    await say('total revenue for the north');
    const t = await say(q);
    assert.equal(t.plan.tool, 'table_explain', q);
    assert.equal(t.spoken, 'That came from C2 through C3 on Sales. Each one is Revenue.', q);
  }
});

test('explaining an answer from before a refusal names that answer first', async () => {
  await open(BUDGET);
  await say('total salaries');
  await say('what is the median amount');
  const t = await say('how do you know');
  // Named in the server's words, so the listener hears what the figure was of, not a bare number.
  assert.equal(
    t.spoken,
    'About the earlier answer, 690 thousand, the total of Amount for Salaries: That came from C3 and C6 on Budget. Each one is Amount.',
  );
  // Straight after its answer, as the demo does it, nothing is added.
  await say('total amount for engineering');
  assert.equal((await say('how do you know')).spoken, 'That came from C3 through C5 on Budget. Each one is Amount.');
});

// ── everyday words ──────────────────────────────────────────────────────────

test('"close", "deal size", "expense" and "goes to" are understood', async () => {
  assert.equal((await ask(SALES, 'how many deals did we close in september')).payload?.['result'], sales.filter((r) => month(r) === 9).length);
  assert.equal((await ask(SALES, 'whats the average deal size')).payload?.['result'], mean(sales, 'Revenue'));
  assert.equal((await ask(BUDGET, 'biggest expense')).payload?.['result'], Math.max(...budget.map((r) => num(r, 'Amount'))));
  assert.equal((await ask(BUDGET, 'how much money goes to engineering')).payload?.['result'], total(budget.filter((r) => r['Department'] === 'Engineering'), 'Amount'));
  assert.equal((await ask(BUDGET, "what's the cheapest line item")).payload?.['result'], Math.min(...budget.map((r) => num(r, 'Amount'))));
  const everything = await ask(BUDGET, 'list everything engineering spends money on');
  assert.equal(((everything.payload?.['rows'] ?? []) as unknown[]).length, budget.filter((r) => r['Department'] === 'Engineering').length);
});

test('a label said as the thing measured is the measure, or a count of it', async () => {
  assert.equal((await ask(BUDGET, 'average line item cost')).payload?.['result'], mean(budget, 'Amount'));
  assert.match((await ask(BUDGET, 'largest line item')).spoken, /^480 thousand, for Salaries\./);
  const most = await ask(BUDGET, 'which department has the most line items');
  assert.equal(most.plan.args?.['aggregate'], 'count');
  assert.match(most.spoken, /^Engineering, 3 rows and Design, 2 rows\./);
  assert.equal((await ask(SALES, 'what is the total for reps in the north')).payload?.['result'], total(sales.filter((r) => r['Region'] === 'North'), 'Revenue'));
});

test('"what items" and "what countries" list them, as "which" does', async () => {
  const items = await ask(BUDGET, 'what items cost more than 50000');
  assert.equal(items.plan.args?.['aggregate'], 'none');
  assert.deepEqual(((items.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort(), budget.filter((r) => num(r, 'Amount') > 50000).map((r) => String(r['Item'])).sort());
  const big = await ask(COUNTRIES, 'what countries have a population over 100 million');
  assert.deepEqual(((big.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key).sort(), countries.filter((r) => num(r, 'Population') > 1e8).map((r) => String(r['Country'])).sort());
  const reps = await ask(SALES, 'what reps have revenue over 10000');
  assert.deepEqual(((reps.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key).sort(), sales.filter((r) => num(r, 'Revenue') > 10000).map((r) => String(r['Rep'])).sort());
});

// ── nothing silently described ──────────────────────────────────────────────

test('a question that cannot be answered says what was not understood, instead of describing the table', async () => {
  for (const q of ['revenue in the west', 'revenue for the west region', 'west']) {
    const t = await ask(SALES, q);
    assert.notEqual(t.plan.tool, 'table_describe', q);
    assert.match(t.spoken, /could not find "west"/, q);
  }
  const q1 = await ask(MERGED, 'Q1 revenue');
  assert.equal(q1.spoken, 'Which one: 2026 Q1 Revenue or 2025 Q1 Revenue?');
  // "The first one" picks the first offered.
  assert.equal((await say('the first one')).payload?.['result'], total(merged, 'y26q1'));
  assert.match((await ask(BUDGET, 'spending in marketing')).spoken, /could not find "marketing"/);
  // A question about another file goes there, and says so.
  const elsewhere = await ask(SALES, "what's the population of vietnam");
  assert.equal(elsewhere.payload?.['result'], num(of(countries, 'Country', 'Vietnam'), 'Population'));
  assert.match(elsewhere.spoken, /^In Countries\. /);
  // "What regions are there", asked of the budget, no longer opens "05 three regions".
  const regions = await ask(BUDGET, 'what regions are there');
  assert.notEqual(regions.plan.args?.['table_id'], '05-three-regions');
  // Opening a file, or a word with no question in it, still describes.
  assert.equal((await ask(BUDGET, "what's in the budget file")).plan.tool, 'table_describe');
  assert.equal((await ask(SALES, 'okay')).plan.tool, 'table_describe');
});

test('quarters and years said aloud are Q1 and 2025', async () => {
  for (const q of ['first quarter revenue', 'quarter one revenue', 'q one revenue']) {
    assert.equal((await ask(QUARTERLY, q)).payload?.['result'], total(quarterly, 'Q1'), q);
  }
  assert.equal((await ask(MERGED, 'two thousand twenty five q1 revenue')).payload?.['result'], total(merged, 'y25q1'));
  assert.equal((await ask(MERGED, 'what was revenue in the first quarter of 2026')).payload?.['result'], total(merged, 'y26q1'));
  assert.equal((await ask(QUARTERLY, 'second quarter revenue for north')).payload?.['result'], num(of(quarterly, 'Region', 'North'), 'Q2'));
});

// ── what the probe of new questions found ───────────────────────────────────

test('a value many rows share is not compared row by row, and "the top rep in each region" is each one\'s highest', async () => {
  // "More than the East" compares region totals; read row by row it named the South
  // alone, for its one big deal, and left the North out.
  const east = await ask(SALES, 'which region earned more than the east');
  assert.equal(east.plan.tool, undefined);
  assert.match(east.spoken, /^East is a Region, not one row, so I cannot compare rows with it directly\./);

  // Each region's top rep, by name: the row holding each region's highest Revenue, and
  // no other. It was a count of reps per region, then each region's figure with no name.
  const top = await ask(SALES, 'top rep in each region');
  const best = (region: string) => Math.max(...sales.filter((r) => r['Region'] === region).map((r) => num(r, 'Revenue')));
  const tops = [...new Set(sales.map((r) => String(r['Region'])))].map((region) => String(sales.find((r) => r['Region'] === region && num(r, 'Revenue') === best(region))!['Rep']));
  assert.deepEqual(((top.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort(), tops.sort(), top.spoken);
  assert.match(top.spoken, /^The highest Revenue in each Region: /);
});

test('"compare 2025 and 2026 Q1 revenue" shares its last words between both sides', async () => {
  const t = await ask(MERGED, 'compare 2025 and 2026 q1 revenue for the south');
  assert.equal(t.plan.tool, 'table_compare', 'was a description of the table');
  const south = of(merged, 'Region', 'South');
  assert.match(t.spoken, new RegExp(`^For South, 2025 Q1 Revenue is ${num(south, 'y26q1') - num(south, 'y25q1')} less than 2026 Q1 Revenue`));
});

test('a condition no value of the borrowed column could meet is asked about, then put where it fits', async () => {
  await open(COUNTRIES);
  // GDP per capita never reaches 100 million; the question meant Population.
  const which = await say('average gdp per capita for countries over 100 million');
  assert.equal(which.plan.tool, undefined, 'was "There is no average"');
  assert.match(which.spoken, /^Which column should be over 100 million\?/);
  const answered = await say('population');
  assert.equal(answered.payload?.['result'], mean(countries.filter((r) => num(r, 'Population') > 1e8), 'GDP'));
});

test('"the top country in each region" is each region\'s highest row, and "which two" is two', async () => {
  const t = await ask(COUNTRIES, 'top country by population in each region');
  const best = (region: string) => Math.max(...countries.filter((r) => r['Region'] === region).map((r) => num(r, 'Population')));
  const tops = countries.filter((r) => num(r, 'Population') === best(String(r['Region']))).map((r) => String(r['Country']));
  assert.deepEqual(((t.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort(), tops.sort(), `was each region's total: ${t.spoken}`);

  const two = await ask(SALES, 'which two reps sold the most');
  assert.deepEqual(((two.payload?.['groups'] ?? []) as { key: string }[]).map((g) => g.key), ranked(sales, 'Rep', 'Revenue').slice(0, 2));
  assert.equal((await ask(SALES, "what's the most anyone sold")).payload?.['result'], Math.max(...sales.map((r) => num(r, 'Revenue'))));
  assert.equal((await ask(SALES, 'how much did the lowest earner make')).payload?.['result'], Math.min(...sales.map((r) => num(r, 'Revenue'))));
});

test('"how much more", with nothing to be more than, is asked about rather than answered with a total', async () => {
  const t = await ask(BUDGET, 'how much more does engineering spend');
  assert.equal(t.plan.tool, undefined, 'was engineering\'s total, heard as the difference');
  assert.match(t.spoken, /^More than what\?/);
});

test('"which ones" lists the rows just counted, and "how much more is that than the actual" compares', async () => {
  await open(COUNTRIES);
  await say('how many countries are in africa');
  const ones = await say('which ones');
  assert.equal(ones.plan.args?.['aggregate'], 'none', 'was a description of the table');
  assert.deepEqual(
    ((ones.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort(),
    countries.filter((r) => r['Region'] === 'Africa').map((r) => String(r['Country'])).sort(),
  );

  await open('open the three regions file');
  await say('table 2');
  await say('what is the target for the south');
  const gap = await say('how much more is that than the actual');
  assert.equal(gap.plan.tool, 'table_compare', 'was the South\'s Actual alone');
  assert.match(gap.spoken, /^For South, Target is 5100 more than Actual/);
});

test('rows named by their kind are listed; a row read out never stands in for a percent', async () => {
  const listed = await ask(COUNTRIES, 'countries with gdp per capita between 4000 and 8000');
  assert.equal(listed.plan.args?.['aggregate'], 'none', 'was the average of GDP per capita');
  assert.deepEqual(
    ((listed.payload?.['rows'] ?? []) as { label: string }[]).map((r) => r.label).sort(),
    countries.filter((r) => num(r, 'GDP') >= 4000 && num(r, 'GDP') <= 8000).map((r) => String(r['Country'])).sort(),
  );
  const percent = await ask(SALES, 'what percent of sales is the east');
  assert.equal(percent.plan.tool, undefined, "was the East's row, read as the answer");
  assert.match(percent.spoken, /could not find "percent"/);
  const spent = await ask(BUDGET, 'what is spent on salaries across both departments');
  assert.equal(spent.payload?.['result'], total(budget.filter((r) => r['Item'] === 'Salaries'), 'Amount'), 'was refused: Department holds text');
});

test('"how many columns" counts columns, and "say that again" repeats the last reply', async () => {
  const columns = await ask(SALES, 'how many columns are there');
  assert.equal(columns.spoken, 'This table has 4 columns: Region, Rep, Revenue and Closed.', 'was "5 rows match"');

  await open(COUNTRIES);
  const which = await say('how many countries have more than 50 million people');
  const again = await say('say that again');
  assert.equal(again.plan.tool, undefined);
  assert.equal(again.spoken, which.spoken);
  // The question asked is still waiting for its answer.
  assert.equal((await say('population')).payload?.['result'], countries.filter((r) => num(r, 'Population') > 50e6).length);
});
