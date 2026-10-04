/**
 * Questions a judge might make up on the spot, through the real voice client.
 *
 * Every case here was asked of the bundled tables by a probe that compared each spoken
 * answer with figures worked out separately from the rows, and every case once came
 * back wrong: a count of rows for "how many units", the countries IN Asia for "not in
 * Asia", "that was all of it" for "is engineering spending more than design", the
 * largest first for "which department spent the least". An honest question back is an
 * acceptable answer; a confident wrong number is not, so each case pins the number.
 *
 * Driven exactly as the page drives it: `converse()` routes the words, makes any quiet
 * preparatory call, runs the answering tool behind the real handler, and folds the
 * reply back into the conversation.
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

let session = 'judge-0';
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

/** A fresh conversation with a table open, the way a judge would start. */
async function open(phrase: string): Promise<void> {
  session = `judge-${++seq}`;
  resetContext();
  await loadCatalogue(call);
  if (phrase) await say(phrase);
}

/** Ask one question in a fresh conversation and return the turn. */
async function ask(table: string, question: string): Promise<Turn> {
  await open(table);
  return say(question);
}

const SALES = 'open the sales table';
const BUDGET = 'open the budget file';
const COUNTRIES = 'open the countries table';
const THREE = 'open the three regions file';
const MERGED = 'open the merged header file';

// ── a comparison of columns that live in another file ───────────────────────

test('comparing two columns this table lacks goes to the one file that has both', async () => {
  // The defect: with the sales table open, its single Revenue column could not be both
  // sides, so the comparison fell through and the sales table was described again.
  const turn = await ask(SALES, 'compare 2026 q1 revenue and 2025 q1 revenue');
  assert.equal(turn.plan.tool, 'table_compare');
  assert.equal(turn.plan.args?.['table_id'], '03-merged-header');
  // 2100 and 1900 are the column totals of 03-merged-header's two rows.
  assert.match(turn.spoken, /2026 Q1 Revenue is 200 more than 2025 Q1 Revenue, about 11%: 2100 against 1900\./);
});

// ── breakdowns asked for the least ──────────────────────────────────────────

test('"the least" is asked lowest first, and the lowest is heard first', async () => {
  const least = await ask(BUDGET, 'which department spent the least');
  assert.equal(least.plan.args?.['order'], 'asc');
  assert.match(least.spoken, /^Lowest first: Design, 234 thousand and Engineering, 560 thousand\./);

  const items = await ask(BUDGET, 'which line item costs the least');
  assert.match(items.spoken, /^Lowest first: Travel, 18 thousand, /);

  const fewest = await ask(COUNTRIES, 'which region has the fewest countries');
  assert.equal(fewest.plan.args?.['aggregate'], 'count');
  assert.match(fewest.spoken, /^Lowest first: Americas, 1 row, /);
});

test('"the most reps" counts reps; "the top rep" is the rep with the highest figure', async () => {
  const most = await ask(SALES, 'which region has the most reps');
  assert.equal(most.plan.args?.['aggregate'], 'count');
  assert.equal(most.plan.args?.['group_by'], 'Region');
  assert.match(most.spoken, /North, 2 rows, South, 2 rows and East, 1 row/);

  const top = await ask(SALES, 'who is the top rep');
  assert.match(top.spoken, /^21 thousand, for Chi\./);

  const countries = await ask(COUNTRIES, 'which region has the most countries');
  assert.match(countries.spoken, /^Asia, 3 rows, /);
});

// ── counting things, not rows ───────────────────────────────────────────────

test('"how many units" is the units, not the number of rows', async () => {
  assert.equal((await ask(THREE, 'how many units')).payload?.['result'], 165);
  assert.equal((await ask(THREE, 'how many units did gadget sell')).payload?.['result'], 45);
  assert.equal((await ask(THREE, 'how many widgets')).payload?.['result'], 120);
  // Counting rows is still counting rows.
  assert.equal((await ask(COUNTRIES, 'how many countries are in Europe')).payload?.['result'], 2);
});

test('"how many tables are in this file" counts the tables, not the rows', async () => {
  const t = await ask(THREE, 'how many tables are in this file');
  assert.equal(t.plan.tool, undefined);
  assert.equal(t.spoken, 'Mixed sheet has one sheet, holding 3 tables. Say "table 2" to open the second.');
});

// ── conditions ──────────────────────────────────────────────────────────────

test('"not in Asia" and "excluding the East" leave those out', async () => {
  const notAsia = await ask(COUNTRIES, 'how many countries are not in Asia');
  assert.deepEqual(notAsia.plan.args?.['filters'], [{ column: 'Region', op: 'neq', value: 'Asia' }]);
  assert.equal(notAsia.payload?.['result'], 5);

  const excluding = await ask(SALES, 'total revenue excluding the east');
  assert.equal(excluding.payload?.['result'], 45450);
});

test('a condition on a number is a filter, not a word to look up', async () => {
  const over = await ask(COUNTRIES, 'how many countries have a population over 100 million');
  assert.deepEqual(over.plan.args?.['filters'], [{ column: 'Population', op: 'gt', value: '100 million' }]);
  assert.equal(over.payload?.['result'], 3);

  const reps = await ask(SALES, 'how many reps have revenue over 10000');
  assert.equal(reps.payload?.['result'], 3);

  // "Which items cost more than 50000" asks for the items.
  const items = await ask(BUDGET, 'which items cost more than 50000');
  assert.equal(items.plan.args?.['aggregate'], 'none');
  assert.match(items.spoken, /Salaries: .*Tooling: /);
  assert.doesNotMatch(items.spoken, /Travel|Software/);
});

test('a month is a condition on the date column', async () => {
  assert.equal((await ask(SALES, 'how many deals closed in august')).payload?.['result'], 2);
  assert.equal((await ask(SALES, 'total revenue in august')).payload?.['result'], 24900);
  const september = await ask(SALES, 'list the deals from september');
  assert.match(september.spoken, /^An: Region East, Revenue 15,600 and Closed September 1, 2026\./);
});

test('several values of one column are answered for those values only', async () => {
  const two = await ask(COUNTRIES, 'compare the population of Vietnam and Thailand');
  assert.deepEqual(two.plan.args?.['filters'], [{ column: 'Country', op: 'eq', values: ['Thailand', 'Vietnam'] }]);
  assert.equal(two.spoken, 'Vietnam, about 100.4 million and Thailand, about 71.8 million.');
});

test('"African" is Africa', async () => {
  const t = await ask(COUNTRIES, 'which African country has the highest population');
  assert.match(t.spoken, /^About 223\.8 million, for Nigeria\./);
});

// ── lookups with no aggregate word ──────────────────────────────────────────

test('a record, named, is read whole', async () => {
  assert.match((await ask(COUNTRIES, 'what region is Peru in')).spoken, /^Peru: .*Region Americas\.$/);
  assert.match((await ask(SALES, 'when did Chi close')).spoken, /Closed August 2, 2026/);
  assert.match((await ask(COUNTRIES, 'tell me about Kenya')).spoken, /^Kenya: Population 55,100,586/);
});

test('a number column with no aggregate word is its total, or its value for a record', async () => {
  assert.equal((await ask(MERGED, 'what is the 2025 q2 revenue')).payload?.['result'], 1850);
  assert.equal((await ask(MERGED, '2026 q1 revenue')).payload?.['result'], 2100);
  assert.equal((await ask(BUDGET, "what's the design software cost")).payload?.['result'], 24000);
  assert.equal((await ask(BUDGET, "what's the engineering budget")).payload?.['result'], 560000);
  assert.equal((await ask(SALES, 'what did Dũng sell')).payload?.['result'], 3900);
  // "GDP" is how people shorten "GDP per capita".
  assert.equal((await ask(COUNTRIES, "what's the GDP of Vietnam")).payload?.['result'], 4347);
});

test('a question of its own is not taken as the last one continued', async () => {
  await open(BUDGET);
  await say("what's the highest amount");
  // It used to inherit "highest" and answer 210 thousand, the highest Design row.
  const amount = await say('what is the amount for design');
  assert.equal(amount.payload?.['result'], 234000);
  // "What about …" does continue the last question.
  await say('what is the average amount for engineering');
  const about = await say('what about design');
  assert.equal(about.plan.args?.['aggregate'], 'avg');
  assert.equal(about.payload?.['result'], 117000);
});

test('a reply that asks its own question is not folded into ours', async () => {
  await open(MERGED);
  const which = await say('total revenue in 2026');
  assert.match(which.spoken, /^Which one: 2026 Q1 Revenue or 2026 Q2 Revenue\?/);
  // The South used to be dropped: 2100, the total for both regions.
  const south = await say('south 2026 q1 revenue');
  assert.equal(south.payload?.['result'], 900);

  await open(BUDGET);
  const lost = await say('how much money does design get on things');
  assert.match(lost.spoken, /could not find "things"/);
  const travel = await say("what's the travel budget");
  assert.equal(travel.payload?.['result'], 18000, `said: ${travel.spoken}`);
});

test('"more than" in a question is not a request to read on', async () => {
  const t = await ask(BUDGET, 'is engineering spending more than design');
  assert.equal(t.plan.tool, 'table_query');
  assert.match(t.spoken, /^Engineering, 560 thousand and Design, 234 thousand\./);
});

// ── the rest of the file, and files not yet open ────────────────────────────

test('a column in another table of the same file is found there', async () => {
  const actual = await ask(THREE, 'total actual');
  assert.equal(actual.plan.args?.['sheet'], 'mixed.t2');
  assert.match(actual.spoken, /^In table 2\. 16\.3 thousand\./);
  const status = await ask(THREE, "what's the status");
  assert.equal(status.spoken, 'In table 3. Q3 close: Status pending.');
});

test('naming a file with a question in it answers the question', async () => {
  await open('');
  const t = await say('the population of vietnam in the countries table');
  assert.equal(t.payload?.['result'], 100352192);
  assert.match(t.spoken, /^In Countries\. 100,352,192\./);
});

test('before any file is open, a question names the files it could be about', async () => {
  await open('');
  const t = await say("what's the q2 revenue for south");
  assert.equal(t.spoken, 'Which file? Q2 Revenue is in Quarterly data and Compare sheet.');
  const answered = await say('the stacked header one');
  assert.equal(answered.payload?.['result'], 950);
  // Answered in the words just heard, too.
  await open('');
  await say("what's the q2 revenue for south");
  assert.equal((await say('the quarterly one')).payload?.['result'], 950);
});

// ── the rest of the words people use ────────────────────────────────────────

test('ranking, growth, values and unsupported figures', async () => {
  const rank = await ask(SALES, 'rank the reps by revenue');
  assert.equal(rank.plan.args?.['group_by'], 'Rep');
  assert.match(rank.spoken, /^Chi, 21 thousand, An, 15\.6 thousand, /);

  const grow = await ask(MERGED, 'did revenue grow from 2025 q2 to 2026 q2');
  assert.match(grow.spoken, /^2026 Q2 Revenue is 500 more than 2025 Q2 Revenue/);

  // "Which region grew the most" is not a comparison of two totals.
  const grew = await ask('open the quarterly table', 'which region grew the most from q1 to q3');
  assert.notEqual(grew.plan.tool, 'table_compare');

  assert.equal((await ask(COUNTRIES, 'what regions are there')).spoken, 'The regions are Africa, Americas, Asia and Europe.');
  assert.match((await ask(SALES, "what's the median revenue")).spoken, /^I cannot work out a median\./);
  assert.match((await ask(COUNTRIES, "what's the richest country")).spoken, /could not find "richest"/);
});

test('the heading phrasings people use reach the structure tool', async () => {
  const cases: [string, number][] = [
    ['use the first row as headings', 1],
    ['the top two rows are headings', 2],
    ['row one is data', 0],
    ['treat the first row as labels', 1],
  ];
  for (const [said, rows] of cases) {
    const t = await ask(SALES, said);
    assert.equal(t.plan.tool, 'table_structure', said);
    assert.equal(t.plan.args?.['header_rows'], rows, said);
  }
  const two = await ask(SALES, 'the top two rows are headings');
  assert.match(two.spoken, /^Right — I now read 2 heading rows instead of 1 heading row\./);
});

// ── what a final verification still found ───────────────────────────────────

const QUARTERLY = 'open the quarterly table';

test('a comparison keeps the region it was asked for, and says it', async () => {
  const cases: [string, string, string, RegExp][] = [
    [QUARTERLY, 'compare q1 and q3 revenue for the north', 'North', /^For North, Q1 Revenue is 300 less than Q3 Revenue, about 20%: 1200 against 1500\./],
    [QUARTERLY, 'did revenue grow from q1 to q2 in the east', 'East', /^For East, Q2 Revenue is 120 more than Q1 Revenue, about 17%: 820 against 700\./],
    [MERGED, 'did the south grow from 2025 q1 to 2026 q1', 'South', /^For South, 2026 Q1 Revenue is 100 more than 2025 Q1 Revenue, about 13%: 900 against 800\./],
    [MERGED, 'compare 2026 q2 revenue with 2025 q2 revenue for the south', 'South', /^For South, 2026 Q2 Revenue is 100 more than 2025 Q2 Revenue, about 12%: 950 against 850\./],
  ];
  for (const [table, question, region, spoken] of cases) {
    const t = await ask(table, question);
    assert.equal(t.plan.tool, 'table_compare', question);
    assert.deepEqual(t.plan.args?.['filters'], [{ column: 'Region', op: 'eq', value: region }], question);
    assert.match(t.spoken, spoken, question);
  }

  await open(THREE);
  await say('table 2');
  const target = await say('compare target and actual for the south');
  assert.match(target.spoken, /^For South, Target is 5100 more than Actual, about 131%: 9000 against 3900\./, 'was 2700 more, over both regions');

  // A region it cannot find is asked about, not compared past.
  await open(THREE);
  await say('table 2');
  const misheard = await say('compare target and actual for the sooth');
  assert.equal(misheard.plan.tool, undefined);
  assert.match(misheard.spoken, /could not find "sooth"/);
});

test('"since August" is August onwards, not August alone', async () => {
  const since = await ask(SALES, 'total revenue since august');
  assert.deepEqual(since.plan.args?.['filters'], [{ column: 'Closed', op: 'gte', value: 'August' }]);
  assert.equal(since.payload?.['result'], 40500, 'was 24.9 thousand, August alone');
  assert.equal((await ask(SALES, 'how many deals closed since july')).payload?.['result'], 5, 'was 2');
  assert.equal((await ask(SALES, 'how many deals closed before august')).payload?.['result'], 2);
  assert.equal((await ask(SALES, 'how many deals closed after july')).payload?.['result'], 3);
  assert.equal((await ask(SALES, 'total revenue from august onwards')).payload?.['result'], 40500);
  // A day without its year, in the year the rows share.
  assert.equal((await ask(SALES, 'how many deals closed after august 15')).payload?.['result'], 2, 'was "I could not find after august 15"');
  assert.equal((await ask(SALES, 'how many deals closed on august 2')).payload?.['result'], 1);
  // "From September" alone is still September's deals.
  assert.match((await ask(SALES, 'list the deals from september')).spoken, /^An: Region East, Revenue 15,600 and Closed September 1, 2026\./);
});

test("a condition's own column does not outbid the measure asked for", async () => {
  const total = await ask(COUNTRIES, 'what is the total population where gdp per capita is under 5000');
  assert.equal(total.plan.args?.['aggregate_column'], 'Population');
  assert.equal(total.payload?.['result'], 656791532, 'was the total of GDP per capita');
  const avg = await ask(COUNTRIES, 'average population where gdp per capita is over 7000');
  assert.equal(avg.payload?.['result'], 37078551.75);
  const top = await ask(COUNTRIES, 'highest population among countries with gdp per capita under 5000');
  assert.match(top.spoken, /^About 277\.5 million, for Indonesia\./);
  assert.equal((await ask(COUNTRIES, 'what is the population of countries where gdp per capita is above 20000')).payload?.['result'], 42160209);
  // Named only in the condition, it is still the measure.
  assert.equal((await ask(COUNTRIES, 'total population over 50 million')).payload?.['result'], 728592811);

  // Two one-word measures used to loop on "Which one: Target or Actual?".
  await open(THREE);
  await say('table 2');
  const actual = await say('total actual where target is over 9500');
  assert.equal(actual.plan.args?.['aggregate_column'], 'Actual');
  assert.equal(actual.payload?.['result'], 12400);
});

test('naming the column a condition needs finishes the question it was asked for', async () => {
  await open(COUNTRIES);
  const which = await say('how many countries have more than 50 million people');
  assert.match(which.spoken, /^Which column should be more than 50 million people\?/);
  const five = await say('population');
  assert.equal(five.plan.args?.['aggregate'], 'count');
  assert.equal(five.payload?.['result'], 5, 'was the grand total of Population');

  await open(COUNTRIES);
  await say('how many countries have a population over 100 million');
  const moved = await say('what about over 50 million');
  assert.deepEqual(moved.plan.args?.['filters'], [{ column: 'Population', op: 'gt', value: '50 million' }]);
  assert.equal(moved.payload?.['result'], 5);
});

test('"break it down" after the highest gives each group\'s highest, and says so', async () => {
  await open(SALES);
  await say('highest revenue');
  const down = await say('break it down');
  assert.equal(down.plan.args?.['aggregate'], 'max');
  assert.equal(down.spoken, 'Highest Revenue: South, 21 thousand, East, 15.6 thousand and North, 12.4 thousand.');

  await open(SALES);
  await say('lowest revenue');
  assert.match((await say('break it down')).spoken, /^Lowest Revenue: .*South, 3900\./);

  // Naming the group still asks for each group's total, largest first.
  const which = await ask(SALES, 'which region has the highest revenue');
  assert.equal(which.plan.args?.['aggregate'], 'sum');
});

test('"what about" after a count continues the count', async () => {
  await open(SALES);
  await say('total revenue for north');
  await say('how many deals in the south');
  const east = await say('what about the east');
  assert.equal(east.plan.args?.['aggregate'], 'count');
  assert.equal(east.payload?.['result'], 1, 'was the East\'s revenue, from the question before');
  const down = await say('break it down');
  assert.equal(down.plan.args?.['aggregate'], 'count');
});

test('help, start over and stop are not questions about the table', async () => {
  await open('');
  const help = await say('what can you do');
  assert.equal(help.plan.tool, undefined);
  assert.match(help.spoken, /^Ask for a total, an average, the highest or lowest, a count, or a breakdown/);
  assert.equal((await say('help')).spoken, help.spoken);
  // Describing a table nobody chose names it first.
  assert.match((await say('okay')).spoken, /^In Sales data\. This table has 5 rows/);

  await open(BUDGET);
  await say('total amount for engineering');
  const over = await say('start over');
  assert.match(over.spoken, /^Starting over\./);
  const lost = await say('how do you know');
  assert.match(lost.spoken, /^Ask me something with a number in it first/, 'the old answer was forgotten');

  const stop = await say('stop');
  assert.equal(stop.plan.tool, undefined);
  assert.equal((stop.plan as { interrupt?: boolean }).interrupt, true);
  assert.equal(stop.spoken, '');

  // Misheard demo lines reach what they meant.
  await open(BUDGET);
  await say('total amount for design');
  assert.equal((await say('how do you no')).plan.tool, 'table_explain');
  assert.equal((await say('brake it down')).plan.args?.['group_by'], 'Department');
});

test('a hesitation, a wake word or "team" after a value is not a word to look up', async () => {
  for (const q of ['total amount for the design team', 'the design team total']) {
    assert.equal((await ask(BUDGET, q)).payload?.['result'], 234000, q);
  }
  for (const q of ['um total amount for engineering', 'hey landmark, total amount for engineering', 'total amount 4 engineering']) {
    assert.equal((await ask(BUDGET, q)).payload?.['result'], 560000, q);
  }
  assert.equal((await ask(MERGED, 'did revenue grow from 2025 q2 2 2026 q2')).plan.tool, 'table_compare');
  // A number that counts stays a number.
  assert.match((await ask(COUNTRIES, 'how many countries have a population over 4 million')).spoken, /^\d+ rows? match/);
});

test('a workbook with its own title is called by it, not by its file name', async () => {
  await open('');
  const t = await say('total amount for engineering');
  assert.match(t.spoken, /^In FY2026 Departmental Budget\. 560 thousand\./, 'was "In 04 title and vmerge."');
  // The list names it the same way, so one file is not heard under two names.
  await open('');
  const list = await say('what do I have');
  // Every file by a name a person would give it, not by a test fixture's file name.
  assert.equal(list.spoken, 'You have Sales data, Quarterly data, Compare sheet, FY2026 Departmental Budget and Mixed sheet. There is 1 more.');
});

// ── what the last check found ───────────────────────────────────────────────

test('a negation before a month or a number condition leaves those rows out', async () => {
  const cases: [string, string, number][] = [
    [SALES, 'total revenue not in august', 36150],
    [SALES, 'how many deals were not closed in august', 3],
    [SALES, 'total revenue except in july', 40500],
    [SALES, 'how many deals closed outside of july', 3],
    [SALES, 'what was the revenue apart from september', 45450],
    [SALES, 'revenue not before august', 40500],
    [SALES, 'total revenue excluding july', 40500],
    [SALES, 'how many deals are not over 10000', 2],
    [COUNTRIES, "how many countries don't have a population over 50 million", 3],
    [COUNTRIES, 'how many countries have a population not above 100 million', 5],
    [COUNTRIES, 'total population of countries with gdp per capita not below 5000', 148314207],
  ];
  for (const [table, question, truth] of cases) {
    assert.equal((await ask(table, question)).payload?.['result'], truth, question);
  }
  const notAugust = await ask(SALES, 'total revenue not in august');
  assert.deepEqual(notAugust.plan.args?.['filters'], [{ column: 'Closed', op: 'neq', value: 'August' }]);
  // Exactly the countries that do not: it used to name the four that do.
  const which = await ask(COUNTRIES, 'which countries do not have gdp per capita over 5000');
  for (const country of ['Vietnam', 'Indonesia', 'Kenya', 'Nigeria']) assert.match(which.spoken, new RegExp(country), country);
  for (const country of ['Norway', 'Poland', 'Thailand', 'Peru']) assert.doesNotMatch(which.spoken, new RegExp(country), country);
});

test('inclusive and open-ended date bounds keep the day they name', async () => {
  const cases: [string, number][] = [
    ['total revenue on or after august 2', 40500],
    ['how many deals closed on or after august 2', 3],
    ['total revenue on or before july 19', 20550],
    ['how many deals closed on or before august 27', 4],
    ['total revenue up to august 27', 45450],
    ['revenue from august 2 on', 40500],
    ['how many deals closed by august 15', 3],
    ['total revenue no later than august 27', 45450],
    ['total revenue starting august 2', 40500],
    ['how many deals closed august 2 or later', 3],
    ['total revenue from july 10 to august 5', 29150],
  ];
  for (const [question, truth] of cases) {
    assert.equal((await ask(SALES, question)).payload?.['result'], truth, question);
  }
  // A day with no word to say which side of it is asked about, then answered.
  await open(SALES);
  const which = await say('how many deals closed august 27');
  assert.equal(which.plan.tool, undefined);
  assert.match(which.spoken, /^Do you mean on August 27 only, up to August 27, or from August 27 on\?/);
  assert.equal((await say('up to')).payload?.['result'], 4);
});

test('a follow-up that changes the figure keeps the rows it was about', async () => {
  await open(BUDGET);
  await say('total amount for engineering');
  const average = await say('what about the average');
  assert.equal(Number(average.payload?.['result']).toFixed(2), '186666.67', 'was 158.8 thousand, over every department');
  assert.equal((await say('how many rows is that')).payload?.['result'], 3);
  // A value named afresh replaces the one before.
  assert.equal((await say('what about design')).payload?.['result'], 2);

  await open(SALES);
  await say('total revenue for the north');
  assert.match((await say('what about the lowest')).spoken, /^8150, for Bảo\./, 'was 3900, for Dũng of the South');
  assert.match((await say('and the highest')).spoken, /^12\.4 thousand, for Anh\./, 'was 21 thousand, for Chi');
  await say('total revenue for the south');
  assert.equal((await say('and the average')).payload?.['result'], 12450);
  // A rep named by name is that rep, whatever region came before, and the other way about.
  await say('total revenue for the north');
  assert.equal((await say('what about chi')).payload?.['result'], 21000, 'not North and Chi, which matches nothing');
  assert.equal((await say('what about the south')).payload?.['result'], 24900, 'not Chi in the South');

  await open(COUNTRIES);
  await say('how many countries are in asia');
  assert.equal((await say('and their total population')).payload?.['result'], 449687593);
  await say('what is the total population of asia');
  assert.equal(Number((await say('what about gdp per capita')).payload?.['result']).toFixed(2), '5477.33');
  await say('how many countries have a population over 50 million');
  assert.equal((await say('and what is their average gdp per capita')).payload?.['result'], 4025.4);
  // "Their" after its own noun is a question of its own.
  await say('how many countries are in asia');
  assert.equal((await say('how many countries have their population over 50 million')).payload?.['result'], 5);

  await open(THREE);
  await say('table 2');
  await say('what is the actual for the south');
  assert.equal((await say('and the target')).payload?.['result'], 9000, 'was 19 thousand, both regions');

  // "Break it down" is still every group, as the filmed demo says.
  await open(BUDGET);
  await say('total amount for design');
  assert.equal((await say('break it down')).spoken, 'Engineering, 560 thousand and Design, 234 thousand.');
});

test("the highest or lowest of two named values is each one's highest, not its total", async () => {
  const highest = await ask(BUDGET, 'highest amount for engineering and design');
  assert.equal(highest.plan.args?.['aggregate'], 'max');
  assert.equal(highest.spoken, 'Highest Amount: Engineering, 480 thousand and Design, 210 thousand.');
  const lowest = await ask(BUDGET, 'lowest amount for engineering and design');
  assert.match(lowest.spoken, /^Lowest Amount, lowest first: Engineering, 18 thousand and Design, 24 thousand\./);
  assert.equal((await ask(SALES, 'largest deal in the north and south')).spoken, 'Highest Revenue: South, 21 thousand and North, 12.4 thousand.');
  assert.equal(
    (await ask(COUNTRIES, 'highest population in asia and africa')).spoken,
    'Highest Population: Asia, about 277.5 million and Africa, about 223.8 million.',
  );
});

test('"the most deals" counts deals; "the most sales" is asked', async () => {
  for (const q of ['which region has the most deals', 'which region closed the most deals']) {
    const t = await ask(SALES, q);
    assert.equal(t.plan.args?.['aggregate'], 'count', q);
    assert.equal(t.spoken, 'North, 2 rows, South, 2 rows and East, 1 row.', q);
  }
  const fewest = await ask(SALES, 'which region has the fewest deals');
  assert.match(fewest.spoken, /^Lowest first: East, 1 row, /);

  await open(SALES);
  const sales = await say('which region has the most sales');
  assert.equal(sales.spoken, 'By number of rows, or by Revenue?');
  assert.equal((await say('revenue')).plan.args?.['aggregate_column'], 'Revenue');
  await say('which region has the most sales');
  assert.equal((await say('number of rows')).plan.args?.['aggregate'], 'count');
  // A question of its own is not taken as the reply.
  await say('which region has the most sales');
  const own = await say('how many deals are in the north');
  assert.deepEqual(own.plan.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'North' }]);
  assert.equal(own.payload?.['result'], 2);
  await say('how many deals closed august 27');
  assert.equal((await say('revenue by region')).plan.args?.['group_by'], 'Region');
});

test('"who sold less than" names them, and a question asked of table 2 is answered there', async () => {
  const who = await ask(SALES, 'who sold less than 10000');
  assert.equal(who.plan.args?.['aggregate'], 'none');
  assert.match(who.spoken, /^Bảo: .*Dũng: /);
  const target = await ask(THREE, 'what is the target for the north in table 2');
  assert.equal(target.payload?.['result'], 10000, 'was a description of table 2');
});
