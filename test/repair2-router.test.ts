/**
 * What the 4 October review found the voice client saying with confidence and wrong, once
 * all of that round's fixes ran together, pinned through the real client and the real
 * handler:
 *
 *   - "Over" had become a word to ignore, so "how many regions are over target" counted
 *     both regions, and "everyone but Anh" — "everyone" ignored too — was Anh's own figure.
 *   - A named row compared with ("more than Anh and Bảo") turned the second name into a
 *     filter; "the total over Anh and Chi" compared instead of adding; and "what about Bảo"
 *     after "more than Anh" counted Bảo's one row.
 *   - The rows just listed, and the figure just heard, were forgotten by "their total" and
 *     "more than that"; "aren't in Asia" was "in Asia".
 *   - A condition on a group's figure was applied row by row, and the result spoken under
 *     the group's name; "is the North's revenue above average" did the same.
 *   - Smaller things: a difference answered with one side, "bigger than Kenya" measured in
 *     GDP per capita, "top 2 line items" adding rows silently, "Compare sheet" not
 *     choosable by its name, "revenue in q3" moving to another file, "the top rep" answered
 *     with a revenue, and "break it down" dropping the condition it was asked after.
 *
 * Every truth is worked out here from the rows, never copied from a reply. An honest
 * question back is accepted where one is pinned; a wrong figure never is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createHandler } from '../src/server.ts';
import { assertIndex, type LandmarkIndex } from '../src/indexfmt.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { context, converse, loadCatalogue, resetContext } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundled: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(bundled);

interface Turn {
  plan: { tool?: string; args?: Record<string, unknown>; speak?: string };
  payload: Record<string, unknown> | null;
  spoken: string;
}

let sessions = 0;
/** A voice conversation against an index, driven as the page drives it. */
function voice(index: LandmarkIndex) {
  const handler = createHandler({ index });
  let session = '';
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
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
    const body = JSON.parse(await res.text()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
  };
  const say = async (u: string): Promise<Turn> => (await converse(u, call)) as Turn;
  const open = async (phrase: string): Promise<void> => {
    session = `repair2-${++sessions}`;
    resetContext();
    await loadCatalogue(call);
    if (phrase) await say(phrase);
  };
  return { say, open };
}

const { say, open } = voice(bundled);

// ── the rows, as they are ─────────────────────────────────────────────────────

type Row = Record<string, string | number>;
const region = (id: string, n = 0) => bundled.tables.find((t) => t.id === id)!.regions[n]!;
const rowsOf = (id: string, keys: string[], n = 0): Row[] =>
  region(id, n).rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] as string | number])));
const num = (r: Row, k: string) => Number(r[k]);
const sum = (rows: Row[], k: string) => rows.reduce((s, r) => s + num(r, k), 0);
const avg = (rows: Row[], k: string) => sum(rows, k) / rows.length;
const of = (rows: Row[], k: string, v: string) => rows.find((r) => r[k] === v)!;

const sales = rowsOf('01-flat', ['Region', 'Rep', 'Revenue', 'Closed']);
const budget = rowsOf('04-title-and-vmerge', ['Department', 'Item', 'Amount']);
const units = rowsOf('05-three-regions', ['Product', 'Units']);
const targets = rowsOf('05-three-regions', ['Region', 'Target', 'Actual'], 1);
const countries = rowsOf('06-countries', ['Country', 'Population', 'GDP', 'Region']);

const result = (t: Turn) => t.payload?.['result'];
const groups = (t: Turn) => ((t.payload?.['groups'] ?? []) as { key: string; value: number }[]).map((g) => [g.key, g.value] as const);
const listed = (t: Turn) => ((t.payload?.['rows'] ?? []) as { label?: string }[]).map((r) => r.label);
const byKey = (pairs: readonly (readonly [string, number])[]) => [...pairs].sort((a, b) => a[0].localeCompare(b[0]));

const SALES = 'open the sales file';
const BUDGET = 'open the budget file';
const MIXED = 'open the three regions file';
const COUNTRIES = 'open the countries table';
async function ask(opener: string, ...lines: string[]): Promise<Turn> {
  await open(opener);
  let last: Turn | null = null;
  for (const line of lines) last = await say(line);
  return last!;
}

// ── "over" compares, unless it plainly means across ───────────────────────────

test('"over target" is a comparison of two columns, refused, never a count of every region', async () => {
  const beat = targets.filter((r) => num(r, 'Actual') > num(r, 'Target')).length;
  assert.equal(beat, 1);
  for (const q of ['how many regions are over target', 'how many regions went over their target', 'which regions went over target']) {
    const t = await ask(MIXED, q);
    assert.equal(t.plan.tool, undefined, `${q}: ${t.spoken}`);
    assert.notEqual(result(t), targets.length, q);
    assert.match(t.spoken, /I can compare a column with a number, not with another column yet\./, q);
  }
  // A budget-against-actual sheet of one's own: "over budget" the same.
  const accounts: [string, number, number][] = [['Travel', 15000, 9800], ['Marketing', 20000, 23100], ['Office', 5000, 5200]];
  const own = voice(
    buildIndex([
      buildTable({
        sourceName: 'budget vs actual.csv',
        format: 'csv',
        sheets: [{ name: 'budget vs actual', grid: [['Account', 'Budget', 'Actual'], ...accounts], merges: [] }],
        warnings: [],
      }),
    ]),
  );
  await own.open('open the budget vs actual table');
  const over = await own.say('how many accounts are over budget');
  assert.equal(over.plan.tool, undefined, over.spoken);
  assert.match(over.spoken, /not with another column yet\. Say "compare Actual and Budget"/);
  // "Over" before a group, or before all of them, is "across".
  assert.equal(result(await ask(SALES, 'total revenue over the north')), sum(sales.filter((r) => r['Region'] === 'North'), 'Revenue'));
  assert.equal(result(await ask(SALES, 'total revenue over all the regions')), sum(sales, 'Revenue'));
  // "How much went to engineering" still asks for an amount.
  assert.equal(result(await ask(BUDGET, 'how much went to engineering')), sum(budget.filter((r) => r['Department'] === 'Engineering'), 'Amount'));
});

test('"everyone but Anh" leaves Anh out, rather than answering with Anh\'s own figure', async () => {
  const but = (k: string, v: string) => sales.filter((r) => r[k] !== v);
  assert.equal(result(await ask(SALES, 'how much did everybody but anh make')), sum(but('Rep', 'Anh'), 'Revenue'));
  assert.equal(result(await ask(SALES, 'total for everyone but the south')), sum(but('Region', 'South'), 'Revenue'));
  assert.equal(result(await ask(SALES, 'average revenue for everyone but dung')), avg(but('Rep', 'Dũng'), 'Revenue'));
  assert.equal(result(await ask(SALES, 'how many deals did everyone but chi close')), but('Rep', 'Chi').length);
  assert.equal(result(await ask(SALES, 'what did all but chi make')), sum(but('Rep', 'Chi'), 'Revenue'));
  assert.equal(result(await ask(BUDGET, 'total for everything but salaries')), sum(budget.filter((r) => r['Item'] !== 'Salaries'), 'Amount'));
  assert.equal(
    result(await ask(COUNTRIES, 'total population of everyone but indonesia')),
    sum(countries.filter((r) => r['Country'] !== 'Indonesia'), 'Population'),
  );
  assert.equal(result(await ask(COUNTRIES, 'how many countries but asia')), countries.filter((r) => r['Region'] !== 'Asia').length);
  // Two left out are one figure for the rest, not every other country's own.
  assert.equal(
    result(await ask(COUNTRIES, 'total population excluding indonesia and nigeria')),
    sum(countries.filter((r) => r['Country'] !== 'Indonesia' && r['Country'] !== 'Nigeria'), 'Population'),
  );
  assert.equal(result(await ask(SALES, 'total revenue for everyone but anh and bao')), sum(sales.filter((r) => r['Rep'] !== 'Anh' && r['Rep'] !== 'Bảo'), 'Revenue'));
  // "Everything" and "anyone" still name nothing where they are not followed by "but".
  assert.equal(listed(await ask(BUDGET, 'list everything engineering spends money on')).length, budget.filter((r) => r['Department'] === 'Engineering').length);
});

test('"aren\'t in Asia" is not "in Asia"', async () => {
  assert.equal(result(await ask(COUNTRIES, "how many countries aren't in asia")), countries.filter((r) => r['Region'] !== 'Asia').length);
  const notNorth = await ask(SALES, "which reps aren't in the north");
  assert.deepEqual(listed(notNorth).sort(), sales.filter((r) => r['Region'] !== 'North').map((r) => String(r['Rep'])).sort(), notNorth.spoken);
});

// ── named rows ────────────────────────────────────────────────────────────────

test('two rows compared with are added together when said together, and one at a time otherwise', async () => {
  const anh = num(of(sales, 'Rep', 'Anh'), 'Revenue');
  const bao = num(of(sales, 'Rep', 'Bảo'), 'Revenue');
  const combined = await ask(SALES, 'how many reps sold more than anh and bao combined');
  assert.equal(result(combined), sales.filter((r) => num(r, 'Revenue') > anh + bao).length, combined.spoken);
  assert.match(combined.spoken, /^Anh and Bảo together: Revenue 20,550\./);

  for (const [opener, q] of [
    [SALES, 'how many reps sold more than anh and bao'],
    [SALES, 'which reps sold more than anh and chi'],
    [COUNTRIES, 'which countries have more population than kenya and peru'],
    [COUNTRIES, 'how many countries have a lower gdp per capita than peru and thailand'],
  ] as const) {
    const t = await ask(opener, q);
    assert.equal(t.plan.tool, undefined, `${q}: ${t.spoken}`);
    assert.match(t.spoken, /^I can compare with one row at a time\./, q);
  }

  const kenyaPeru = num(of(countries, 'Country', 'Kenya'), 'Population') + num(of(countries, 'Country', 'Peru'), 'Population');
  const bigger = await ask(COUNTRIES, 'which countries have more population than kenya and peru combined');
  assert.deepEqual(
    groups(bigger).map(([k]) => k).sort(),
    countries.filter((r) => num(r, 'Population') > kenyaPeru).map((r) => String(r['Country'])).sort(),
    bigger.spoken,
  );
  // A value in a comparison of its own is not a second row: "less than Chi and more than Bảo".
  const between = await ask(SALES, 'how many reps earned less than Chi and more than Bao');
  assert.equal(result(between), sales.filter((r) => num(r, 'Revenue') < 21000 && num(r, 'Revenue') > bao).length, between.spoken);
});

test('"the total over Anh and Chi" adds the two up, and is never a comparison with Anh', async () => {
  const two = (rows: Row[], k: string, a: string, b: string) => rows.filter((r) => r[k] === a || r[k] === b);
  assert.equal(result(await ask(SALES, 'total revenue over anh and chi')), sum(two(sales, 'Rep', 'Anh', 'Chi'), 'Revenue'));
  assert.equal(result(await ask(COUNTRIES, 'total population over vietnam and thailand')), sum(two(countries, 'Country', 'Vietnam', 'Thailand'), 'Population'));
  assert.equal(result(await ask(COUNTRIES, 'average gdp per capita over norway and poland')), avg(two(countries, 'Country', 'Norway', 'Poland'), 'GDP'));
  assert.equal(result(await ask(SALES, 'the average over chi and an')), avg(two(sales, 'Rep', 'Chi', 'An'), 'Revenue'));
  // One row with "over" and a figure asked for is not guessed at.
  const one = await ask(SALES, 'total revenue over anh');
  assert.notEqual(result(one), num(of(sales, 'Rep', 'Chi'), 'Revenue'));
  assert.equal(one.plan.tool, undefined, one.spoken);
});

test('"what about Bảo" after "more than Anh" asks the same comparison of Bảo', async () => {
  await open(SALES);
  const anh = await say('how many reps sold more than anh');
  assert.equal(result(anh), sales.filter((r) => num(r, 'Revenue') > 12400).length);
  const bao = await say('what about bao');
  assert.equal(result(bao), sales.filter((r) => num(r, 'Revenue') > num(of(sales, 'Rep', 'Bảo'), 'Revenue')).length, bao.spoken);
  assert.match(bao.spoken, /^Bảo: Revenue 8,150\./);

  await open(COUNTRIES);
  await say('how many countries have a smaller population than vietnam');
  const thailand = await say('what about thailand');
  assert.equal(result(thailand), countries.filter((r) => num(r, 'Population') < num(of(countries, 'Country', 'Thailand'), 'Population')).length, thailand.spoken);

  // A comparison of its own, said as a follow-up, is asked of the same rows.
  await open(SALES);
  await say('how many reps sold more than anh');
  const lessChi = await say('what about less than chi');
  assert.equal(result(lessChi), sales.filter((r) => num(r, 'Revenue') < num(of(sales, 'Rep', 'Chi'), 'Revenue')).length, lessChi.spoken);
  await open(SALES);
  await say('how many reps sold less than chi');
  const lessAn = await say('and less than an');
  assert.equal(result(lessAn), sales.filter((r) => num(r, 'Revenue') < num(of(sales, 'Rep', 'An'), 'Revenue')).length, lessAn.spoken);

  // Once something else is answered, "what about Chi" is Chi's own figure again.
  await open(SALES);
  await say('how many reps sold more than anh');
  await say('what is the total revenue');
  assert.equal(result(await say('what about chi')), num(of(sales, 'Rep', 'Chi'), 'Revenue'));
});

test('a difference named on both sides is not answered with one side\'s figure', async () => {
  const chi = await ask(SALES, 'how much more than anh did chi sell');
  assert.notEqual(result(chi), num(of(sales, 'Rep', 'Chi'), 'Revenue'), chi.spoken);
  assert.deepEqual(byKey(groups(chi)), byKey([['Anh', 12400], ['Chi', 21000]]), chi.spoken);
  const widget = await ask(MIXED, 'how many units more than the gadget did the widget sell');
  assert.notEqual(result(widget), num(of(units, 'Product', 'Widget'), 'Units'), widget.spoken);
  assert.deepEqual(byKey(groups(widget)), byKey(units.map((r) => [String(r['Product']), num(r, 'Units')] as const)), widget.spoken);
});

test('"bigger than Kenya" is not measured in the GDP per capita being averaged', async () => {
  const kenya = num(of(countries, 'Country', 'Kenya'), 'Population');
  await open(COUNTRIES);
  const asked = await say('average gdp per capita of countries bigger than kenya');
  assert.equal(asked.spoken, 'Bigger than Kenya in which column? I have Population and GDP per capita (usd).');
  const answered = await say('population');
  assert.equal(result(answered), avg(countries.filter((r) => num(r, 'Population') > kenya), 'GDP'), answered.spoken);
  assert.equal((await ask(COUNTRIES, 'total gdp per capita of countries smaller than peru')).plan.tool, undefined);
  // Said of an amount, "larger" is still that amount.
  assert.equal(
    result(await ask(COUNTRIES, 'what is the total population of countries larger than kenya')),
    sum(countries.filter((r) => num(r, 'Population') > kenya), 'Population'),
  );
});

test('"how many deals did the top rep close" counts the top rep\'s deals', async () => {
  const top = [...sales].sort((a, b) => num(b, 'Revenue') - num(a, 'Revenue'))[0]!;
  const t = await ask(SALES, 'how many deals did the top rep close');
  assert.equal(result(t), sales.filter((r) => r['Rep'] === top['Rep']).length, t.spoken);
  assert.match(t.spoken, new RegExp(`^${String(top['Rep'])} has the highest Revenue\\. `));
});

// ── what was just heard ──────────────────────────────────────────────────────

test('"their total" after a listing is the total of the rows just listed', async () => {
  const north = sales.filter((r) => r['Region'] === 'North');
  assert.equal(result(await ask(SALES, 'which reps are in the north', 'what is their total')), sum(north, 'Revenue'));
  assert.equal(result(await ask(SALES, 'which reps sold more than 12000', 'how many is that')), sales.filter((r) => num(r, 'Revenue') > 12000).length);
  assert.equal(
    result(await ask(SALES, 'total revenue for the south', 'list the reps in the east', 'what is their average')),
    avg(sales.filter((r) => r['Region'] === 'East'), 'Revenue'),
  );
  assert.equal(result(await ask(BUDGET, 'list the items over 50000', 'what do they add up to')), sum(budget.filter((r) => num(r, 'Amount') > 50000), 'Amount'));
  assert.equal(
    result(await ask(COUNTRIES, 'which countries are in the same region as kenya', 'and their average gdp per capita')),
    avg(countries.filter((r) => r['Region'] === 'Africa'), 'GDP'),
  );
  const mean = avg(sales, 'Revenue');
  assert.equal(result(await ask(SALES, 'which reps sold more than the average', 'how many is that')), sales.filter((r) => num(r, 'Revenue') > mean).length);
  // "What about the south" after a listing lists the South.
  const south = await ask(SALES, 'which reps are in the north', 'what about the south');
  assert.deepEqual(listed(south).sort(), sales.filter((r) => r['Region'] === 'South').map((r) => String(r['Rep'])).sort(), south.spoken);
});

test('"more than that" compares with the figure just heard, and asks when there is none', async () => {
  const thailand = num(of(countries, 'Country', 'Thailand'), 'Population');
  const more = await ask(COUNTRIES, 'population of thailand', 'how many countries have more than that');
  assert.equal(result(more), countries.filter((r) => num(r, 'Population') > thailand).length, more.spoken);
  const an = num(of(sales, 'Rep', 'An'), 'Revenue');
  assert.equal(result(await ask(SALES, 'total revenue for an', 'how many reps sold more than that')), sales.filter((r) => num(r, 'Revenue') > an).length);
  const mean = avg(sales, 'Revenue');
  const less = await ask(SALES, 'average revenue', 'who sold less than that');
  assert.deepEqual(listed(less).sort(), sales.filter((r) => num(r, 'Revenue') < mean).map((r) => String(r['Rep'])).sort(), less.spoken);
  const none = await ask(SALES, 'how many deals are there', 'how many have more than that');
  assert.equal(none.plan.tool, undefined);
  assert.match(none.spoken, /^More than what\?/);
  // "That of Thailand" is a row, not the figure just heard.
  const ofThailand = await ask(COUNTRIES, 'population of kenya', 'how many countries have a lower gdp per capita than that of thailand');
  assert.equal(result(ofThailand), countries.filter((r) => num(r, 'GDP') < num(of(countries, 'Country', 'Thailand'), 'GDP')).length, ofThailand.spoken);
});

// ── a group's own figure ─────────────────────────────────────────────────────

test('a condition on a group\'s figure is tested on that figure, not row by row', async () => {
  const totals = (rows: Row[], g: string, k: string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(String(r[g]), (m.get(String(r[g])) ?? 0) + num(r, k));
    return [...m];
  };
  const regions = await ask(SALES, 'which regions made more than 20000');
  assert.deepEqual(byKey(groups(regions)), byKey(totals(sales, 'Region', 'Revenue').filter(([, v]) => v > 20000)), regions.spoken);
  const departments = await ask(BUDGET, 'which departments spend more than 230 thousand');
  assert.deepEqual(byKey(groups(departments)), byKey(totals(budget, 'Department', 'Amount').filter(([, v]) => v > 230000)), departments.spoken);
  const over40 = await ask(COUNTRIES, 'which regions have a total population over 40 million');
  assert.deepEqual(byKey(groups(over40)), byKey(totals(countries, 'Region', 'Population').filter(([, v]) => v > 40e6)), over40.spoken);
  const over100 = await ask(COUNTRIES, 'what regions have a population over 100 million');
  assert.deepEqual(byKey(groups(over100)), byKey(totals(countries, 'Region', 'Population').filter(([, v]) => v > 100e6)), over100.spoken);
  assert.match(over100.spoken, /^These are the regions whose total Population is over 100 million\. /);
  // "Items over 100000" is about the items: they are listed, each saying its department.
  const items = await ask(BUDGET, 'what departments have items over 100000');
  assert.equal(((items.payload?.['rows'] ?? []) as unknown[]).length, budget.filter((r) => num(r, 'Amount') > 100000).length, items.spoken);
});

test('"is the North\'s revenue above average" gives the North\'s own figure, not its rows above the average', async () => {
  const north = await ask(SALES, "is the north's revenue above average");
  assert.equal(result(north), sum(sales.filter((r) => r['Region'] === 'North'), 'Revenue'), north.spoken);
  assert.match(north.spoken, /^The average Revenue of one row is about 12\.2 thousand\. North's total, to set beside it: /);
  assert.equal(result(await ask(BUDGET, "is engineering's spending above average")), sum(budget.filter((r) => r['Department'] === 'Engineering'), 'Amount'));
  assert.equal(result(await ask(BUDGET, 'is design spending more than average')), sum(budget.filter((r) => r['Department'] === 'Design'), 'Amount'));
  // Counting the rows above the average is still a count of rows.
  const mean = avg(sales, 'Revenue');
  assert.equal(result(await ask(SALES, 'how many deals are above average')), sales.filter((r) => num(r, 'Revenue') > mean).length);
});

test('a ranking says when one name\'s figure is several rows\', and does not rank the groups for "in each"', async () => {
  const top = await ask(BUDGET, 'top 2 line items');
  assert.match(top.spoken, /^Where a line item is on more than one row, its figure is their total\. Salaries, 690 thousand/);
  const each = await ask(SALES, 'top 2 reps in each region');
  assert.equal(each.plan.tool, undefined, each.spoken);
  assert.match(each.spoken, /^I cannot rank reps inside each region yet\./);
});

// ── files ────────────────────────────────────────────────────────────────────

test('a file called "Compare sheet" can be chosen by saying its name', async () => {
  for (const reply of ['compare sheet', 'the compare sheet', 'the compare one']) {
    await open('');
    const asked = await say("what was the north's q2 revenue");
    assert.match(asked.spoken, /^Which file\? Q2 Revenue is in Quarterly data and Compare sheet\./);
    const chosen = await say(reply);
    assert.equal(context.tableId, '03-merged-header', `${reply}: ${chosen.spoken}`);
    assert.match(chosen.spoken, /^In Compare sheet\. /, reply);
  }
  await open('');
  const bare = await say('compare sheet');
  assert.equal(bare.plan.tool, 'table_describe', bare.spoken);
  assert.equal(context.tableId, '03-merged-header');
  // "What is the total" is not a file called "… total".
  await open(SALES);
  assert.equal(result(await say('what is the total')), sum(sales, 'Revenue'));
});

test('a year or a quarter asked of a table with dates stays with it, and a move only to ask back is undone', async () => {
  for (const q of ['revenue in q3', 'revenue in 2026']) {
    await open(SALES);
    const t = await say(q);
    assert.equal(context.tableId, '01-flat', `${q}: ${t.spoken}`);
    assert.equal(t.plan.tool, undefined, q);
    assert.match(t.spoken, /Its dates are in the Closed column/, q);
    const next = await say('how much did the north make');
    assert.equal(result(next), sum(sales.filter((r) => r['Region'] === 'North'), 'Revenue'), `${q}, then: ${next.spoken}`);
  }
  // Moved only to be asked "which one?", a question of the open file goes back to it.
  await open(SALES);
  const moved = await say('what is the 2026 revenue');
  assert.match(moved.spoken, /^In Compare sheet\. Which one: /);
  const back = await say('how much did the north make');
  assert.equal(result(back), sum(sales.filter((r) => r['Region'] === 'North'), 'Revenue'), back.spoken);
  assert.match(back.spoken, /^Back in Sales data\. /);
});

// ── break it down ────────────────────────────────────────────────────────────

test('"break it down" keeps the condition it was asked after, and says it', async () => {
  const salaries = await ask(BUDGET, 'total amount for salaries', 'break it down');
  const paid = budget.filter((r) => r['Item'] === 'Salaries');
  assert.deepEqual(byKey(groups(salaries)), byKey(paid.map((r) => [String(r['Department']), num(r, 'Amount')] as const)), salaries.spoken);
  assert.match(salaries.spoken, /^For Salaries: /);

  const notAsia = await ask(COUNTRIES, 'total population not in asia', 'break it down');
  assert.ok(!groups(notAsia).some(([k]) => k === 'Asia'), notAsia.spoken);
  assert.equal(groups(notAsia).reduce((s, [, v]) => s + v, 0), sum(countries.filter((r) => r['Region'] !== 'Asia'), 'Population'));
  assert.match(notAsia.spoken, /^For all but Asia: /);

  const august = await ask(SALES, 'total revenue for deals closed in august', 'break it down');
  const inAugust = sales.filter((r) => String(r['Closed']).slice(5, 7) === '08');
  assert.equal(groups(august).reduce((s, [, v]) => s + v, 0), sum(inAugust, 'Revenue'), august.spoken);
  assert.match(august.spoken, /^For Closed in August: /);

  // A condition on the column broken down by goes, as the filmed demo has it.
  const all = await ask(BUDGET, 'total amount for design', 'break it down');
  assert.equal(all.spoken, 'Engineering, 560 thousand and Design, 234 thousand.');
});
