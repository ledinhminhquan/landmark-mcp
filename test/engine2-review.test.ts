/**
 * The engine's share of the 4 October review, driven through the real handler.
 *
 * Each case is a finding reproduced as a listener met it: told they had no
 * spreadsheets, handed a total of per-person figures, given evidence for an answer
 * they had not just asked about, stopped at the eighth column of forty, and read a
 * "lowest" list from the top. What is asserted is what they should hear instead.
 *
 * Tool calls only: what the voice client does with these replies is pinned by the
 * client's own tests, so a change to the page cannot break the engine's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import { assertIndex, type IndexTable, type LandmarkIndex } from '../src/indexfmt.ts';
import { cleanText, rateLike, runQuery } from '../src/query/engine.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundled: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(bundled);

type Cell = string | number | boolean | null;
const ingest = (name: string, grid: Cell[][]): IndexTable =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });

interface Reply {
  isError: boolean;
  s: Record<string, unknown>;
  spoken: string;
}

let sessions = 0;
/** A conversation against an index: each gets its own session, so nothing leaks between tests. */
function conversation(idx: LandmarkIndex) {
  const handler = createHandler({ index: idx });
  const session = `engine2-${++sessions}`;
  return async (name: string, args: Record<string, unknown>): Promise<Reply> => {
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
      result: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    const s = body.result.structuredContent ?? {};
    return { isError: body.result.isError === true, s, spoken: String(s['spoken'] ?? '') };
  };
}

const words = (s: string) => s.trim().split(/\s+/).length;

// ── table_list past the end ────────────────────────────────────────────────

test('a list cursor at or past the end never says there are no tables', async () => {
  const call = conversation(bundled);
  for (const cursor of ['6', '99']) {
    const r = await call('table_list', { cursor });
    assert.ok(!/no tables/i.test(r.spoken), `cursor ${cursor} said: ${r.spoken}`);
    assert.equal(r.spoken, 'That is all of them: you have 6 tables.');
    assert.equal(r.s['more_available'], false);
    assert.equal(r.s['cursor'], null);
  }
});

test('a negative or unreadable list cursor starts from the top and never hands itself back', async () => {
  const call = conversation(bundled);
  const first = await call('table_list', {});
  for (const cursor of ['-3', 'abc']) {
    const r = await call('table_list', { cursor });
    assert.equal(r.spoken, first.spoken, `cursor ${cursor}`);
    assert.equal(r.s['cursor'], '5', 'was "-3", so a host following it looped on an empty page');
    assert.notEqual(r.s['cursor'], cursor);
  }
  // Following the cursor it gave reaches the last table, and then the end.
  const next = await call('table_list', { cursor: '5' });
  assert.equal(next.spoken, 'You have Countries.');
  assert.equal(next.s['cursor'], null);
});

test('"no tables loaded" is still said when it is true', async () => {
  const call = conversation(buildIndex([]));
  assert.equal((await call('table_list', {})).spoken, 'There are no tables loaded.');
  assert.equal((await call('table_list', { cursor: '3' })).spoken, 'There are no tables loaded.');
});

// ── query cursors ──────────────────────────────────────────────────────────

test('a breakdown cursor past the last group says every group was read, not that nothing held a number', async () => {
  const call = conversation(bundled);
  const sum = await call('table_query', {
    table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population', group_by: 'Country', cursor: '99',
  });
  assert.equal(sum.spoken, 'That was every Country: 8 in all.', 'was "There is no total. No matching row held a number in Population."');
  assert.equal(sum.s['cursor'], null);
  const count = await call('table_query', { table_id: '06-countries', aggregate: 'count', group_by: 'Region', cursor: '99' });
  assert.equal(count.spoken, 'That was every Region: 4 in all.');
});

test('a negative query cursor reads from the first row and moves on from where it stopped', async () => {
  const call = conversation(bundled);
  const r = await call('table_query', { table_id: '06-countries', cursor: '-3' });
  assert.ok(!/-\d/.test(r.spoken), `said a negative row number: ${r.spoken}`);
  assert.match(r.spoken, /^8 rows match\. Vietnam:/);
  const fresh = await call('table_query', { table_id: '06-countries' });
  assert.equal(r.s['cursor'], fresh.s['cursor'], 'was 2, which re-read rows already heard');
});

// ── totals of rates ───────────────────────────────────────────────────────

test('"the total GDP of Asia" is not a sum of GDP per capita', async () => {
  const call = conversation(bundled);
  const asia = await call('table_query', {
    table_id: '06-countries',
    filters: [{ column: 'Region', op: 'eq', value: 'Asia' }],
    aggregate: 'sum',
    aggregate_column: 'GDP per capita (usd)',
  });
  assert.equal(asia.isError, true, `answered: ${asia.spoken}`);
  assert.ok(!/16\.4 thousand/.test(asia.spoken), 'the three countries\' per-person figures, added up');
  assert.equal(
    asia.spoken,
    '"GDP per capita (usd)" is a per-capita figure, so adding it up across rows gives no real total. ' +
      'Ask for its average, highest or lowest instead.',
  );

  // Per region, the same: each region's sum of per-person figures meant nothing either.
  const byRegion = await call('table_query', {
    table_id: '06-countries', aggregate: 'sum', aggregate_column: 'GDP per capita (usd)', group_by: 'Region',
  });
  assert.equal(byRegion.isError, true);

  // What the refusal offers works.
  const avg = await call('table_query', {
    table_id: '06-countries',
    filters: [{ column: 'Region', op: 'eq', value: 'Asia' }],
    aggregate: 'avg',
    aggregate_column: 'GDP per capita (usd)',
  });
  assert.equal(avg.isError, false);
  assert.equal(avg.s['result'], 5477.33333333);

  // Describe says which columns have no total, so a caller can ask for the average first.
  const d = await call('table_describe', { table_id: '06-countries' });
  const cols = d.s['columns'] as { name: string; no_total?: string }[];
  assert.equal(cols.find((c) => c.name === 'GDP per capita (usd)')?.no_total, 'a per-capita figure');
  assert.equal(cols.find((c) => c.name === 'Population')?.no_total, undefined);
  assert.equal(cols.find((c) => c.name === 'Country')?.no_total, undefined);
});

test('a total of a population, an amount or a price still adds up', async () => {
  const call = conversation(bundled);
  const pop = await call('table_query', { table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population' });
  assert.equal(pop.isError, false);
  const prices = ingest('prices', [['Item', 'Price', 'Rent per month', 'Share %'], ['a', 10, 1200, '60%'], ['b', 15, 900, '40%']]);
  const r = prices.regions[0]!;
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Price' }).result, 25);
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Rent per month' }).result, 2100, 'rent per month adds up across flats');
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Share %' }).result, 100, 'shares of a whole add up to the whole');
});

test('which headings are rates, and why each is said to be', () => {
  const t = ingest('rates', [
    [
      'Margin %', 'Growth', 'Conversion rate', 'Debt ratio', 'Avg. price', 'Mean score', 'Median income',
      'Births per 1,000 people', 'Cost per unit', 'Salary per annum', 'Budget allocation (%)', 'Performance', 'Percentile', 'Revenue',
    ],
    ['10%', '5%', 0.1, 0.5, 10, 70, 30000, 12, 3, 50000, '25%', 4, 90, 100],
    ['20%', '7%', 0.2, 0.6, 12, 80, 32000, 14, 4, 60000, '75%', 5, 80, 200],
  ]);
  const said = Object.fromEntries(t.regions[0]!.columns.map((c) => [c.spoken, rateLike(c)]));
  assert.deepEqual(said, {
    'Margin %': 'a percentage',
    Growth: 'a percentage',
    'Conversion rate': 'a rate',
    'Debt ratio': 'a ratio',
    'Avg price': 'already an average',
    'Mean score': 'already an average',
    'Median income': 'already a median',
    'Births per 1,000 people': 'a rate',
    'Cost per unit': 'a per-unit figure',
    'Salary per annum': null,
    'Budget allocation (%)': null,
    Performance: null,
    Percentile: null,
    Revenue: null,
  });
});

test('a figure per whatever each row is adds up, and so does a percentage of a whole', async () => {
  // A row to each region: the sales per region are the regions' sales. Refused, the
  // listener was told "Headcount per team is a per-team figure" — false, and final.
  const t = ingest('per-row', [
    ['Region', 'Sales per region', 'Headcount per team', 'Spend per department', 'Revenue (per store)', '% of total', 'Percent of budget', 'Percentage of spend'],
    ['North', 100, 12, 30, 40, '25%', '40%', '30%'],
    ['South', 300, 8, 70, 60, '75%', '60%', '70%'],
  ]);
  const r = t.regions[0]!;
  for (const c of r.columns.slice(1)) {
    assert.equal(rateLike(c, r), null, c.spoken);
    assert.equal(rateLike(c), null, `${c.spoken}, without the table`);
  }
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Sales per region' }).result, 400);

  const call = conversation(buildIndex([t]));
  const head = await call('table_query', { table_id: 'per-row', aggregate: 'sum', aggregate_column: 'Headcount per team' });
  assert.equal(head.isError, false, head.spoken);
  assert.equal(head.s['result'], 20);
  const share = await call('table_query', { table_id: 'per-row', aggregate: 'sum', aggregate_column: '% of total' });
  assert.equal(share.isError, false, share.spoken);
  assert.equal(share.s['result'], 100, 'the shares of a whole add up to the whole');
  // Nothing here is said to have no total.
  const d = await call('table_describe', { table_id: 'per-row' });
  assert.ok((d.s['columns'] as { no_total?: string }[]).every((c) => c.no_total === undefined));
});

test('a figure per person adds up when each row is that person, and is otherwise totalled only with a word', async () => {
  // A row to each customer: the revenue per customer is each customer's revenue.
  const customers = ingest('customers', [['Customer', 'Revenue per customer'], ['Ada', 100], ['Bo', 200]]);
  const cr = customers.regions[0]!;
  assert.equal(rateLike(cr.columns[1]!, cr), null);
  assert.equal(runQuery(cr, { aggregate: 'sum', aggregateColumn: 'Revenue per customer' }).result, 300);
  // Named "Customer name", the rows are still customers.
  const named = ingest('named', [['Customer name', 'Spend per customers'], ['Ada', 100], ['Bo', 200]]);
  assert.equal(rateLike(named.regions[0]!.columns[1]!, named.regions[0]!), null);

  // A row to each region, with a count of customers beside it: an average per customer.
  // Its total may mean nothing, or may be just what was wanted ("Cost per person" over the
  // days of a trip), so asked for in so many words it is given, and said to add up
  // per-customer figures. Only a figure per capita or per head is refused outright.
  const regions = ingest('regions', [['Region', 'Customer count', 'Revenue per customer'], ['North', 10, 100], ['South', 20, 200]]);
  const rr = regions.regions[0]!;
  assert.equal(rateLike(rr.columns[2]!, rr), 'a per-customer figure');
  const call = conversation(buildIndex([regions]));
  const r = await call('table_query', { table_id: 'regions', aggregate: 'sum', aggregate_column: 'Revenue per customer' });
  assert.equal(r.isError, false, r.spoken);
  assert.equal(r.s['result'], 300);
  assert.match(r.spoken, /^300\. That adds up Revenue per customer across 2 rows, each of them a per-customer figure\./);
  const heads = ingest('heads', [['Region', 'Spend per head'], ['North', 10], ['South', 20]]);
  const h = await conversation(buildIndex([heads]))('table_query', { table_id: 'heads', aggregate: 'sum', aggregate_column: 'Spend per head' });
  assert.equal(h.isError, true);
  assert.match(h.spoken, /^"Spend per head" is a per-head figure, so adding it up across rows gives no real total\./);
});

test('an average is one whatever else its heading says, and a rate is one whatever it is per', () => {
  const t = ingest('more-rates', [
    [
      'Average weight', 'Avg. weight (kg)', 'Mean split time', 'Rate per hour', 'Hourly rate', 'Speed (km per hour)',
      'Miles per hour', 'Births per 1000', 'Per-unit cost', 'Price per kg', 'Earnings per share', 'Rent per month',
      'Calls per hour', 'Weight (kg)', 'Split %',
    ],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, '40%'],
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, '60%'],
  ]);
  const r = t.regions[0]!;
  const said = Object.fromEntries(r.columns.map((c) => [c.spoken, rateLike(c, r)]));
  assert.deepEqual(said, {
    // Were let through: "weight" and "split" are shares only of a percentage.
    'Average weight': 'already an average',
    'Avg weight (kg)': 'already an average',
    'Mean split time': 'already an average',
    // An amount per stretch of time adds up; something called a rate does not, whatever it is per.
    'Rate per hour': 'a rate',
    'Hourly rate': 'a rate',
    // A distance per hour is a speed, not rent per month.
    'Speed (km per hour)': 'a speed',
    'Miles per hour': 'a speed',
    // Per a number with nothing after it, and "per-unit" with its hyphen.
    'Births per 1000': 'a rate',
    'Per unit cost': 'a per-unit figure',
    'Price per kg': 'a per-kg figure',
    'Earnings per share': 'a per-share figure',
    'Rent per month': null,
    'Calls per hour': null,
    'Weight (kg)': null,
    'Split %': null,
  });
});

test('a comparison of rates compares their averages unless told otherwise, and says so', async () => {
  const margins = ingest('margins', [['Region', 'Margin 2025 %', 'Margin 2026 %'], ['North', '10%', '12%'], ['South', '20%', '26%']]);
  const call = conversation(buildIndex([margins]));
  const c = await call('table_compare', { table_id: 'margins', left_column: 'Margin 2026 %', right_column: 'Margin 2025 %' });
  assert.equal(c.isError, false, c.spoken);
  // The gap between percentages in points, beside the relative change in percent: it
  // was "4% more than …, about 27%", two different percentages said the same way.
  assert.equal(
    c.spoken,
    'Average Margin 2026 % is 4 percentage points more than average Margin 2025 %, about 27%: 19% against 15%.',
  );
  assert.match(c.spoken, /: 19% against 15%\./, 'the averages, where the sums were 38% against 30%');
  const one = await call('table_compare', {
    table_id: 'margins', left_column: 'Margin 2026 %', right_column: 'Margin 2025 %', filters: [{ column: 'Region', op: 'eq', value: 'North' }],
  });
  assert.match(one.spoken, /is 2 percentage points more than/);

  const summed = await call('table_compare', {
    table_id: 'margins', left_column: 'Margin 2026 %', right_column: 'Margin 2025 %', aggregate: 'sum',
  });
  assert.equal(summed.isError, true, 'a total of percentages asked for in so many words is refused');

  // Amounts still compare as totals, and a total is not announced as anything else.
  const bundledCall = conversation(bundled);
  const amounts = await bundledCall('table_compare', { table_id: '05-three-regions', sheet: '2', left_column: 'Target', right_column: 'Actual' });
  assert.match(amounts.spoken, /^Target is /);
});

// ── explaining an earlier answer ──────────────────────────────────────────

test('explaining an earlier answer can name it first, and does not otherwise', async () => {
  const call = conversation(bundled);
  const total = await call('table_query', {
    table_id: '04-title-and-vmerge',
    filters: [{ column: 'Line item', op: 'eq', value: 'Salaries' }],
    aggregate: 'sum',
    aggregate_column: 'Amount',
  });
  assert.equal(total.spoken, '690 thousand. That is the total of Amount across 2 rows.');
  // A question refused in between, as "largest line item" was.
  const refused = await call('table_query', { table_id: '04-title-and-vmerge', aggregate: 'max', aggregate_column: 'Line item' });
  assert.equal(refused.isError, true);

  const plain = await call('table_explain', { answer_id: total.s['answer_id'] });
  assert.equal(plain.spoken, 'That came from C3 and C6 on Budget. Each one is Amount.', 'the filmed wording is unchanged');
  assert.equal(plain.s['answer_about'], '690 thousand, the total of Amount for Salaries');

  const named = await call('table_explain', { answer_id: total.s['answer_id'], restate: true });
  assert.equal(
    named.spoken,
    'For the earlier answer, 690 thousand, the total of Amount for Salaries: that came from C3 and C6 on Budget. Each one is Amount.',
  );
});

test('every kind of answer can be named, and a named explanation stays inside the budget', async () => {
  const call = conversation(bundled);
  const cases: [Record<string, unknown>, string][] = [
    [{ table_id: '06-countries', aggregate: 'max', aggregate_column: 'GDP per capita (usd)' }, 'about 88 thousand, the highest GDP per capita (usd)'],
    [{ table_id: '06-countries', aggregate: 'avg', aggregate_column: 'Population', group_by: 'Region' }, 'the average of Population by Region'],
    [{ table_id: '06-countries', aggregate: 'count', filters: [{ column: 'Region', op: 'eq', value: 'Asia' }] }, 'the count of 3 rows for Asia'],
    [{ table_id: '06-countries', aggregate: 'count', group_by: 'Region' }, 'the count of rows by Region'],
    [{ table_id: '06-countries', filters: [{ column: 'Region', op: 'eq', value: 'Europe' }] }, 'the rows for Europe'],
  ];
  for (const [args, about] of cases) {
    const q = await call('table_query', args);
    const e = await call('table_explain', { answer_id: q.s['answer_id'], restate: true });
    assert.equal(e.s['answer_about'], about);
    assert.ok(e.spoken.startsWith(`For the earlier answer, ${about}: `), e.spoken);
    assert.ok(!/\babout\b.*\babout\b/i.test(e.spoken.slice(0, 40)), `"about" twice: ${e.spoken}`);
    assert.ok(words(e.spoken) <= 70, `${words(e.spoken)} words: ${e.spoken}`);
  }

  const c = await call('table_compare', {
    table_id: '05-three-regions', sheet: '2', left_column: 'Target', right_column: 'Actual',
    filters: [{ column: 'Region', op: 'eq', value: 'North' }],
  });
  const ce = await call('table_explain', { answer_id: c.s['answer_id'], restate: true });
  assert.equal(ce.spoken, 'For the earlier answer, Target against Actual for North: Target came from B6 on Mixed. Actual came from C6 on Mixed.');
});

// ── wide tables ───────────────────────────────────────────────────────────

const HEAD = ['Store', 'Region', 'Manager', ...Array.from({ length: 36 }, (_, i) => `W${i + 1}`), 'Total'];
const weekly = ingest('weekly-wide', [
  HEAD,
  ...Array.from({ length: 6 }, (_, r) => [`S${r}`, r % 2 ? 'North' : 'South', `M${r}`, ...Array.from({ length: 36 }, (_, i) => 10 + i + r), 999]),
]);
const wideIndex = buildIndex([weekly]);

/** Every name a reply lists, from "The columns are A, B and C." or "… and 24 more." */
function namesIn(spoken: string): string[] {
  const m = /(?:The (?:next |last )?columns? (?:are|is)) ([^.]+)\./.exec(spoken);
  if (!m) return [];
  return m[1]!.split(/, | and /).filter((n) => !/^\d+ more$/.test(n));
}

test('every column of a forty-column table can be reached by asking for more', async () => {
  const call = conversation(wideIndex);
  const first = await call('table_describe', { table_id: 'weekly-wide' });
  assert.match(first.spoken, /The columns are Store, Region, Manager, W1, W2, W3, W4, W5 and 32 more\. Say more for the rest\./);
  assert.equal(first.s['cursor'], '8');
  assert.equal(first.s['more_available'], true);
  assert.ok(words(first.spoken) <= 70);

  const heard = namesIn(first.spoken);
  let cursor = first.s['cursor'];
  let pages = 0;
  while (cursor !== null) {
    const next = await call('table_describe', { table_id: 'weekly-wide', cursor });
    assert.equal(next.isError, false, next.spoken);
    assert.equal((next.s['columns'] as unknown[]).length, 40, 'every page still carries the whole structure');
    assert.ok(words(next.spoken) <= 70, next.spoken);
    heard.push(...namesIn(next.spoken));
    cursor = next.s['cursor'];
    if (cursor === null) assert.equal(next.spoken, 'The last columns are W30, W31, W32, W33, W34, W35, W36 and Total.');
    else assert.match(next.spoken, /^The next columns are .* and \d+ more\. Say more for the rest\.$/);
    assert.ok(++pages < 10, 'the pages end');
  }
  assert.deepEqual(heard, HEAD, 'each column name heard once, in order');

  // A cursor past the end says how many there were, never that there are none.
  const past = await call('table_describe', { table_id: 'weekly-wide', cursor: '40' });
  assert.equal(past.spoken, 'That was all 40 columns.');
  assert.equal(past.s['cursor'], null);
});

test('a narrow table is described as before, with nothing to continue', async () => {
  const call = conversation(bundled);
  const d = await call('table_describe', { table_id: '04-title-and-vmerge' });
  assert.match(d.spoken, /^"FY2026 Departmental Budget" has 5 rows and 3 columns\. The columns are Department, Line item and Amount\./);
  assert.ok(!/Say more/.test(d.spoken));
  assert.equal(d.s['cursor'], null);
  assert.equal(d.s['more_available'], false);
});

test('"more" after checking the structure of a wide table reads on, and changes nothing', async () => {
  const call = conversation(wideIndex);
  const inspect = await call('table_structure', { table_id: 'weekly-wide' });
  assert.match(inspect.spoken, /That gives the columns Store, Region, Manager, W1, W2, W3, W4, W5 and 32 more\. Say more for the rest\./);
  assert.equal(inspect.s['cursor'], '8');
  const revision = inspect.s['revision'];

  const next = await call('table_structure', { table_id: 'weekly-wide', cursor: '8' });
  assert.equal(next.spoken, 'The next columns are W6, W7, W8, W9, W10, W11, W12, W13 and 24 more. Say more for the rest.');
  assert.equal(next.s['cursor'], '16');

  // After a correction, "more" repeats the call with its heading count; it reads on
  // under that reading rather than making the correction again.
  const fix = await call('table_structure', { table_id: 'weekly-wide', header_rows: 1 });
  assert.equal(fix.s['cursor'], '8');
  const after = await call('table_structure', { table_id: 'weekly-wide', header_rows: 1, cursor: '8' });
  assert.match(after.spoken, /^The next columns are W6, /);
  const again = await call('table_structure', { table_id: 'weekly-wide' });
  assert.equal(again.s['revision'], fix.s['revision'], 'the continuation did not write another correction');
  assert.notEqual(again.s['revision'], revision);
});

test('a heading count sent with a cursor is still a correction, and an empty cursor is no cursor', async () => {
  // 02-stacked-header is read with 2 heading rows. A host that fills every optional
  // string with "", or copies the last call's arguments, sends a cursor with the count;
  // that used to read out the column names and never write the correction.
  for (const cursor of ['', '   ', '0', '8']) {
    const call = conversation(bundled);
    const r = await call('table_structure', { table_id: '02-stacked-header', header_rows: 1, cursor });
    assert.match(r.spoken, /^Right — I now read 1 heading row instead of 2 heading rows\./, `cursor ${JSON.stringify(cursor)}: ${r.spoken}`);
    assert.equal(r.s['header_rows'], 1);
    assert.equal(r.s['changed'], true);
    const after = await call('table_structure', { table_id: '02-stacked-header' });
    assert.equal(after.s['header_rows'], 1, 'the correction was written');
    assert.equal(after.s['revision'], r.s['revision']);
  }

  // Confirming a reading not yet confirmed is a change too, cursor or not.
  const wide = conversation(wideIndex);
  const confirm = await wide('table_structure', { table_id: 'weekly-wide', header_rows: 1, cursor: '8' });
  assert.match(confirm.spoken, /^Right — 1 heading row, as I was already reading it\./);
  assert.equal((await wide('table_structure', { table_id: 'weekly-wide' })).s['confirmed_by_user'], true);

  // An empty cursor alone inspects, as no cursor does.
  const call = conversation(bundled);
  const plain = await call('table_structure', { table_id: '02-stacked-header' });
  const empty = await call('table_structure', { table_id: '02-stacked-header', cursor: '' });
  assert.equal(empty.spoken, plain.spoken);
});

test('a description asked with an empty cursor is the whole description', async () => {
  const call = conversation(bundled);
  for (const detail of ['brief', 'full']) {
    const plain = await call('table_describe', { table_id: '04-title-and-vmerge', detail });
    const empty = await call('table_describe', { table_id: '04-title-and-vmerge', detail, cursor: '' });
    assert.equal(empty.spoken, plain.spoken, `${detail}: was only "The columns are Department, Line item and Amount."`);
  }
});

test('headings too long to list in the reply are offered, not dropped in silence', async () => {
  const long = (i: number) => `Subsidiary ${i} quarterly revenue from regional operations adjusted for currency`;
  for (const width of [6, 12]) {
    const heads = Array.from({ length: width }, (_, i) => long(i + 1));
    const t = ingest('long-heads', [heads, heads.map((_, i) => i + 1), heads.map((_, i) => i + 2)]);
    const call = conversation(buildIndex([t]));
    const inspect = await call('table_structure', { table_id: 'long-heads' });
    assert.ok(words(inspect.spoken) <= 70, inspect.spoken);
    assert.ok(!/That gives the columns/.test(inspect.spoken), 'the list does not fit');
    assert.match(inspect.spoken, / Say more to hear the columns\.$/, `${width} columns: ${inspect.spoken}`);
    assert.equal(inspect.s['more_available'], true);
    assert.equal(inspect.s['cursor'], '0');

    // Following it reads every name, from the first.
    const heard: string[] = [];
    let cursor = inspect.s['cursor'];
    for (let pages = 0; cursor !== null && pages < 20; pages++) {
      const next = await call('table_structure', { table_id: 'long-heads', cursor });
      heard.push(...namesIn(next.spoken));
      cursor = next.s['cursor'];
    }
    assert.deepEqual(heard, heads.map((h) => cleanText(h, 60)));

    // A correction that cannot fit its list says the same.
    const fix = await call('table_structure', { table_id: 'long-heads', header_rows: 1 });
    assert.match(fix.spoken, /^Right — 1 heading row, as I was already reading it\. That gives 2 rows of data\. Say more to hear the columns\. I will stop asking\.$/);
    assert.equal(fix.s['cursor'], '0');
  }
});

// ── lowest first ──────────────────────────────────────────────────────────

test('asked lowest first, an average, a total or a count per group starts with the lowest', async () => {
  const call = conversation(bundled);
  const avg = await call('table_query', {
    table_id: '06-countries', aggregate: 'avg', aggregate_column: 'Population', group_by: 'Region', order: 'asc',
  });
  assert.match(avg.spoken, /^Average Population, lowest first: Europe, about 21\.1 million, /);

  const total = await call('table_query', {
    table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population', group_by: 'Region', order: 'asc',
  });
  assert.match(total.spoken, /^Lowest first: Americas, about 34\.4 million, Europe, about 42\.2 million, /);

  const spend = await call('table_query', {
    table_id: '04-title-and-vmerge', aggregate: 'avg', aggregate_column: 'Amount', group_by: 'Department', order: 'asc',
  });
  assert.match(spend.spoken, /^Average Amount, lowest first: Design, 117 thousand and Engineering, about 186\.7 thousand\./);

  // One country to each group, smallest first: Norway is heard first, not past the page.
  const countries = await call('table_query', {
    table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population', group_by: 'Country', order: 'asc',
  });
  assert.match(countries.spoken, /^Lowest first: Norway, about 5\.5 million, /);
});

test('a ranking of one row per group, lowest first, does not call itself the highest', async () => {
  const call = conversation(bundled);
  for (const aggregate of ['max', 'min', 'avg']) {
    const r = await call('table_query', {
      table_id: '06-countries', aggregate, aggregate_column: 'GDP per capita (usd)', group_by: 'Country', order: 'asc',
    });
    assert.match(r.spoken, /^GDP per capita \(usd\), lowest first: Nigeria, 1596, Kenya, 2099, /, `${aggregate}: ${r.spoken}`);
  }
  // Groups of several rows keep their measure's name: each region's highest is not its value.
  const regions = await call('table_query', {
    table_id: '06-countries', aggregate: 'max', aggregate_column: 'GDP per capita (usd)', group_by: 'Region', order: 'asc',
  });
  assert.match(regions.spoken, /^Highest GDP per capita \(usd\), lowest first: /);
  // Largest first is unchanged.
  const desc = await call('table_query', {
    table_id: '06-countries', aggregate: 'max', aggregate_column: 'GDP per capita (usd)', group_by: 'Country',
  });
  assert.match(desc.spoken, /^Highest GDP per capita \(usd\): Norway, /);
});

test('a later page of a breakdown never introduces its groups as the lowest or the highest', async () => {
  const call = conversation(bundled);
  // The last page of a lowest-first ranking holds one country, the highest of them all.
  const last = await call('table_query', {
    table_id: '06-countries', aggregate: 'min', aggregate_column: 'GDP per capita (usd)', group_by: 'Country', order: 'asc', cursor: '7',
  });
  assert.equal(last.spoken, 'GDP per capita (usd): Norway, about 88 thousand.', 'was "Lowest GDP per capita (usd): Norway"');
  // Largest first, the second page is the middle and bottom of the list, not its top.
  const second = await call('table_query', {
    table_id: '06-countries', aggregate: 'max', aggregate_column: 'GDP per capita (usd)', group_by: 'Country', cursor: '5',
  });
  assert.equal(second.spoken, 'GDP per capita (usd): Vietnam, 4347, Kenya, 2099 and Nigeria, 1596.');
  // Groups of several rows keep their measure, without repeating "lowest first" over the largest.
  const avg = await call('table_query', {
    table_id: '06-countries', aggregate: 'avg', aggregate_column: 'Population', group_by: 'Region', order: 'asc', cursor: '3',
  });
  assert.equal(avg.spoken, 'Average Population: Asia, about 149.9 million.');
  for (const r of [last, second, avg]) assert.ok(!/lowest|highest/i.test(r.spoken), r.spoken);
});
