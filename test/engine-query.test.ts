/**
 * The query engine's answers, checked against what is actually in the rows.
 *
 * Each case is a way the engine used to give a confident wrong answer: comparing
 * numbers as text, counting "n/a" as larger than 50, counting a Total row as a record,
 * or naming a column nobody asked for. Pinned west of UTC so the date cases cannot
 * pass by the accident of the developer's own time zone.
 */
process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildTable } from '../src/ingest/build.ts';
import { QueryError, resolveColumn, runQuery, summaryLabel, type QuerySpec } from '../src/query/engine.ts';
import { speakDescribe, speakError, speakQuery } from '../src/voice/speak.ts';
import type { IndexRegion, IndexTable } from '../src/indexfmt.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = async (file: string, i = 0): Promise<IndexRegion> =>
  (await buildTable(await readSpreadsheet(join(FIX, file)))).regions[i]!;

type Cell = string | number | boolean | null;
const ingest = (name: string, grid: Cell[][]): IndexTable =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });

const countries = await fixture('06-countries.csv');
const flat = await fixture('01-flat.xlsx');

const count = (r: IndexRegion, filters: QuerySpec['filters']) =>
  runQuery(r, { filters: filters ?? [], aggregate: 'count' }).result;

const refuses = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof QueryError && pattern.test(`${e.message} ${e.nextStep}`));

// ── numeric and date filters never fall back to text ────────────────────────

test('"more than 100 million" is read as a number, not compared as text', () => {
  assert.equal(count(countries, [{ column: 'Population', op: 'gt', value: '100 million' }]), 3);
  assert.equal(count(countries, [{ column: 'Population', op: 'gt', value: '100,000,000' }]), 3);
});

test('an unreadable number is refused with a way to say it, not sorted as text', () => {
  refuses(() => count(countries, [{ column: 'Population', op: 'gt', value: 'lots' }]), /couldn't read "lots" as a number.*digits/);
  refuses(() => count(countries, [{ column: 'Population', op: 'gt', value: '10 bananas' }]), /as a number/);
});

test('a cell that is not a number is skipped and said, not sorted after the digits', () => {
  const r = ingest('scores', [['Name', 'Score'], ['a', 10], ['b', 60], ['c', 70], ['d', 80], ['e', 90], ['f', 100], ['g', 'n/a']]).regions[0]!;
  const q = runQuery(r, { filters: [{ column: 'Score', op: 'gt', value: '50' }], aggregate: 'count' });
  assert.equal(q.result, 5);
  assert.equal(q.unreadable.length, 1);
  assert.match(speakQuery(r, { aggregate: 'count' }, null, q), /skipped 1 row whose Score was not a number/);
  // Asking for the text itself still finds it.
  assert.equal(count(r, [{ column: 'Score', op: 'eq', value: 'n/a' }]), 1);
  assert.equal(count(r, [{ column: 'Score', op: 'gt', value: '10k' }]), 0);
});

test('a mixed column compares its numbers numerically', () => {
  // The Score column is there so the heading row is detected whatever the inference
  // makes of a column that is only partly numbers. The kind is then set by hand:
  // whether ingest calls this column mixed or numbers-with-gaps is ingest's decision,
  // and the engine must compare numerically either way.
  const base = ingest('mixed', [
    ['Name', 'Qty', 'Score'],
    ['a', 10, 1], ['b', 20, 2], ['c', 30, 3], ['d', 100, 4], ['e', 'TBD', 5], ['f', 'TBD', 6], ['g', 'N/A', 7], ['h', 40, 8],
  ]).regions[0]!;
  for (const kind of ['mixed', 'number'] as const) {
    const r: IndexRegion = { ...base, columns: base.columns.map((c) => (c.i === 1 ? { ...c, kind } : c)) };
    assert.equal(count(r, [{ column: 'Qty', op: 'gt', value: '5' }]), 5, `${kind}: 10, 20, 30, 100 and 40 — not TBD, TBD and N/A`);
  }
});

test('dates filter as calendar days, whatever form they are said in', () => {
  assert.equal(count(flat, [{ column: 'Closed', op: 'gt', value: '2026-08-01' }]), 3);
  assert.equal(count(flat, [{ column: 'Closed', op: 'gt', value: 'August 1, 2026' }]), 3);
  assert.equal(count(flat, [{ column: 'Closed', op: 'eq', value: '7/4/2026' }]), 1, 'local midnight used to miss the UTC date');
  assert.equal(count(flat, [{ column: 'Closed', op: 'lte', value: '4 July 2026' }]), 1);
  refuses(() => count(flat, [{ column: 'Closed', op: 'gt', value: 'last summer' }]), /as a date/);
});

test('a missing filter value is asked for in words, never as an operator code', () => {
  try {
    count(countries, [{ column: 'Population', op: 'gt' }]);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof QueryError);
    assert.ok(!/"gt"|\bgt\b/.test(`${e.message} ${e.nextStep}`), e.message);
    assert.match(`${e.message} ${e.nextStep}`, /Population.*more than/);
  }
});

// ── when nothing matches, say why ───────────────────────────────────────────

test('no matching department is not reported as "no numbers"', async () => {
  const budget = await fixture('04-title-and-vmerge.xlsx');
  const spec = {
    filters: [{ column: 'Department', op: 'eq' as const, value: 'Engineering Dept' }],
    aggregate: 'sum' as const,
    aggregateColumn: 'Amount',
  };
  const said = speakQuery(budget, spec, budget.columns[2]!, runQuery(budget, spec));
  assert.match(said, /no row has Department equal to Engineering Dept/);
  assert.match(said, /Department holds Design and Engineering/);
  assert.ok(!/held a number/.test(said), said);
});

// ── column names ────────────────────────────────────────────────────────────

test('a column resolves by the name describe speaks, with or without commas', async () => {
  const merged = await fixture('03-merged-header.xlsx');
  for (const name of ['2026 Q1 Revenue', '2026, Q1, Revenue', '2026,Q1,Revenue', '2026 q1 revenue']) {
    assert.equal(resolveColumn(merged, name).i, 1, name);
  }
});

test('the fallback matches whole words, so "core" does not find "Score"', () => {
  const r = ingest('s', [['Name', 'Score', 'Average price'], ['a', 1, 2], ['b', 3, 4]]).regions[0]!;
  refuses(() => resolveColumn(r, 'core'), /no column called "core"/);
  refuses(() => resolveColumn(r, 'age'), /no column called "age"/);
  assert.equal(resolveColumn(r, 'price').i, 2);
});

test('columns that differ only by a symbol are each reachable by their own name', () => {
  // Comparing only punctuation-free forms made "Margin" and "Margin %" the same name,
  // so neither could be asked for at all.
  const r = ingest('fin', [
    ['#', 'Region', 'Margin', 'Margin %', 'Cost', 'Cost ($)'],
    [1, 'North', 100, '10%', 5, 6],
    [2, 'South', 200, '20%', 7, 8],
    [3, 'East', 300, '30%', 9, 10],
  ]).regions[0]!;
  const at = (name: string) => r.columns[resolveColumn(r, name).i]!.spoken;
  for (const c of r.columns) assert.equal(at(c.spoken), c.spoken, `"${c.spoken}" resolves to itself`);
  assert.equal(at('margin percent'), 'Margin %', '"%" is a word when spoken');
  assert.equal(at('MARGIN %'), 'Margin %');
  refuses(() => resolveColumn(r, 'Cost $'), /matches 2 columns.*Cost and Cost \(\$\)/);
});

test('repeated headings numbered apart ("Amount", "Amount 2") are both reachable', () => {
  // Ingest makes spoken names unique and leaves the heading path as written, so both
  // columns carry the path ["Amount"]. The name describe speaks must still pick one.
  const base = ingest('dup', [['Item', 'Amount', 'Total'], ['a', 1, 10], ['b', 2, 20]]).regions[0]!;
  const r: IndexRegion = {
    ...base,
    columns: base.columns.map((c) => (c.i === 2 ? { ...c, path: ['Amount'], spoken: 'Amount 2' } : c)),
  };
  assert.equal(resolveColumn(r, 'Amount').i, 1);
  assert.equal(resolveColumn(r, 'amount 2').i, 2);
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Amount' }).result, 3);
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Amount 2' }).result, 30);
});

test('a wide table\'s errors still end with something to do', () => {
  const names = ['Name', ...Array.from({ length: 19 }, (_, i) => `Metric ${i + 1}`)];
  const r = ingest('wide', [names, ...Array.from({ length: 3 }, (_, k) => [`P${k}`, ...names.slice(1).map((_, i) => k * i + 1)])]).regions[0]!;
  const cases: [() => unknown, RegExp][] = [
    [() => resolveColumn(r, 'Revenue'), /^The columns are: Name, Metric 1, .* and \d+ more\.$/],
    [() => runQuery(r, { aggregate: 'sum' }), /^Ask which column: Metric 1, .* and \d+ more\.$/],
    [() => runQuery(r, { aggregate: 'sum', aggregateColumn: 'Name' }), /^Numeric columns here: Metric 1, .* and \d+ more\.$/],
  ];
  for (const [fn, next] of cases) {
    try {
      fn();
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof QueryError);
      assert.match(e.nextStep, next);
      const said = speakError(e.message, e.nextStep);
      assert.ok(said.endsWith(e.nextStep), `the next step survives: ${said}`);
      assert.ok(said.split(/\s+/).length <= 40, said);
    }
  }
});

test('errors list columns by their spoken names, without commas inside a name', async () => {
  const merged = await fixture('03-merged-header.xlsx');
  try {
    resolveColumn(merged, 'Profit');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof QueryError);
    assert.ok(!/2026, Q/.test(e.nextStep), e.nextStep);
    assert.match(e.nextStep, /2026 Q1 Revenue/);
  }
});

// ── highest and lowest name their row ───────────────────────────────────────

test('the highest value says whose it is, and its cell leads the evidence', () => {
  const q = runQuery(countries, { aggregate: 'max', aggregateColumn: 'GDP per capita (usd)' });
  assert.equal(q.result, 87962);
  assert.deepEqual(q.winners, [6]);
  assert.equal(q.provenance.cells[0], 'C8', "Norway's cell comes first");
  const said = speakQuery(countries, { aggregate: 'max' }, countries.columns[2]!, q);
  assert.match(said, /^About 88 thousand, for Norway\. That is the highest GDP per capita/);

  const low = runQuery(countries, { aggregate: 'min', aggregateColumn: 'Population' });
  assert.match(speakQuery(countries, { aggregate: 'min' }, countries.columns[1]!, low), /for Norway.*lowest Population/);
});

test('a tie names both rows', () => {
  const r = ingest('t', [['Name', 'Score'], ['Ann', 5], ['Ben', 9], ['Cal', 9]]).regions[0]!;
  const q = runQuery(r, { aggregate: 'max', aggregateColumn: 'Score' });
  assert.match(speakQuery(r, { aggregate: 'max' }, r.columns[1]!, q), /^9, for Ben and Cal\./);
});

test('twenty thousand tied rows are counted, not all named', () => {
  // A 0/1 flag column: every row holds the highest value. Winner membership was a list
  // scan per row, and every winner's label went into the answer and its stored copy.
  const rows = Array.from({ length: 20_000 }, (_, i) => [`P${i}`, 1] as Cell[]);
  const base = ingest('flags', [['Name', 'Flag'], ['a', 1], ['b', 1]]).regions[0]!;
  const r: IndexRegion = { ...base, rows, rowCount: rows.length };
  const started = performance.now();
  const q = runQuery(r, { aggregate: 'max', aggregateColumn: 'Flag' });
  const took = performance.now() - started;
  assert.ok(took < 150, `${took.toFixed(0)} ms`);
  assert.ok(q.winners.length <= 5);
  assert.equal(q.winnerCount, 20_000);
  assert.equal(q.provenance.cells[0], 'B2');
  assert.match(speakQuery(r, { aggregate: 'max' }, r.columns[1]!, q), /^1, for P0 and 19999 others\./);
});

test('sums of cents carry no floating-point noise', () => {
  const r = ingest('c', [['Item', 'Amount'], ['a', 0.1], ['b', 0.2]]).regions[0]!;
  assert.equal(runQuery(r, { aggregate: 'sum', aggregateColumn: 'Amount' }).result, 0.3);
});

test('grouped dates are spoken as dates, not ISO strings', () => {
  const q = runQuery(flat, { aggregate: 'count', groupBy: 'Closed' });
  const said = speakQuery(flat, { aggregate: 'count' }, null, q);
  assert.ok(!/T00:00/.test(said), said);
  assert.match(said, /July 4 2026, 1 row/);
});

test('min and max over a very long column do not overflow the stack', () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => [`r${i}`, i] as Cell[]);
  const r: IndexRegion = { ...flat, rows, rowCount: rows.length, columns: [flat.columns[1]!, { ...flat.columns[2]!, i: 1 }] };
  assert.equal(runQuery(r, { aggregate: 'max', aggregateColumn: 'Revenue' }).result, 199_999);
});

// ── total rows ──────────────────────────────────────────────────────────────
//
// Ingest marks total and subtotal rows in `summaryRows` (0-based indices into rows).
// The field is optional in the index, so these tests add it to a region by hand —
// exactly the shape the ingest step produces.

async function withTotal(): Promise<IndexRegion> {
  const budget = await fixture('04-title-and-vmerge.xlsx');
  return {
    ...budget,
    rows: [...budget.rows, ['Total', null, 794000]],
    rowCount: budget.rowCount + 1,
    summaryRows: [5],
  } as IndexRegion;
}

test('a Total row is left out of a sum, and the answer says so once', async () => {
  const r = await withTotal();
  const spec = { aggregate: 'sum' as const, aggregateColumn: 'Amount' };
  const q = runQuery(r, spec);
  assert.equal(q.result, 794000, 'counted once, not twice');
  assert.equal(q.provenance.cellCount, 5);
  const said = speakQuery(r, spec, r.columns[2]!, q);
  assert.match(said, /I left out the Total row\.$/);
  assert.equal(said.match(/left out/g)?.length, 1);
});

test('a Total row is not a record: counts, listings and groups leave it out', async () => {
  const r = await withTotal();
  assert.equal(runQuery(r, { aggregate: 'count' }).result, 5);
  assert.ok(!runQuery(r, { aggregate: 'none', limit: 20 }).rowIndices.includes(5));
  const groups = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Amount', groupBy: 'Department' }).groups;
  assert.deepEqual(groups.map((g) => g.key), ['Engineering', 'Design']);
});

test('a filter that rules the Total row out anyway does not mention it', async () => {
  const r = await withTotal();
  const spec = {
    filters: [{ column: 'Department', op: 'eq' as const, value: 'Engineering' }],
    aggregate: 'sum' as const,
    aggregateColumn: 'Amount',
  };
  const q = runQuery(r, spec);
  assert.equal(q.result, 560000);
  assert.equal(speakQuery(r, spec, r.columns[2]!, q), '560 thousand. That is the total of Amount across 3 rows.');
});

test('asking for the Total row itself says it matched and was left out, not that nothing matched', async () => {
  const r = await withTotal();
  const spec = {
    filters: [{ column: 'Department', op: 'eq' as const, value: 'Total' }],
    aggregate: 'sum' as const,
    aggregateColumn: 'Amount',
  };
  const q = runQuery(r, spec);
  assert.equal(q.unmatched, null);
  const said = speakQuery(r, spec, r.columns[2]!, q);
  assert.ok(!/no row has/.test(said), said);
  assert.match(said, /only row that matches is the sheet's own Total row.*read row 6/);
  assert.equal(said.match(/Total row/g)?.length, 1);
});

test('a total row that starts with a date is named by its label, not by the date', () => {
  const base = ingest('ledger', [['Closed', 'Item', 'Amount'], ['2026-07-01', 'a', 100], ['2026-07-15', 'b', 400], ['2026-07-31', 'x', 500]]).regions[0]!;
  const r = {
    ...base,
    rows: [...base.rows.slice(0, 2), ['2026-07-31T00:00:00.000Z', 'Total:', 500]],
    summaryRows: [2],
  } as IndexRegion;
  assert.equal(summaryLabel(r, 2), 'Total');
  const q = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Amount' });
  assert.match(speakQuery(r, { aggregate: 'sum' }, r.columns[2]!, q), /I left out the Total row\.$/);
});

test('describe counts records without the Total row and says it is left out', async () => {
  const said = speakDescribe(await withTotal(), false);
  assert.match(said, /has 5 rows and 3 columns/);
  assert.match(said, /Total row is left out of answers/);
});

// ── what a final verification still found ───────────────────────────────────

test('a whole month with an ordering condition covers the days it spans', () => {
  // Closed: Jul 4, Jul 19, Aug 2, Aug 27, Sep 1 — all 2026.
  assert.equal(count(flat, [{ column: 'Closed', op: 'gte', value: 'August' }]), 3, 'since August');
  assert.equal(count(flat, [{ column: 'Closed', op: 'gt', value: 'July' }]), 3, 'after July');
  assert.equal(count(flat, [{ column: 'Closed', op: 'lt', value: 'August' }]), 2, 'before August');
  assert.equal(count(flat, [{ column: 'Closed', op: 'lte', value: 'August 2026' }]), 4, 'until August');
  assert.equal(count(flat, [{ column: 'Closed', op: 'gt', value: 'August 15' }]), 2, 'a day, in the year the rows share');

  // Rows in two years and no year said: ask, rather than guess one.
  const deals = ingest('two-years', [['Rep', 'Closed'], ['a', '2025-08-15'], ['b', '2026-08-02'], ['c', '2026-09-01']]).regions[0]!;
  refuses(() => count(deals, [{ column: 'Closed', op: 'gte', value: 'August' }]), /Which year do you mean for August\?.*August 2026/);
  assert.equal(count(deals, [{ column: 'Closed', op: 'gte', value: 'August 2026' }]), 2);
});

test('a day without its year is that day, and an unreadable day is refused', () => {
  for (const value of ['July 4', 'Jul 4', '4 July', 'the 4th of July']) {
    assert.equal(count(flat, [{ column: 'Closed', op: 'eq', value }]), 1, `${value}: was "No rows match"`);
  }
  assert.equal(count(flat, [{ column: 'Closed', op: 'neq', value: 'July 4' }]), 4);
  refuses(() => count(flat, [{ column: 'Closed', op: 'eq', value: 'someday' }]), /couldn't read "someday" as a date.*with its year/);
  // Text a date column really holds is still found as written.
  const tasks = ingest('due', [['Task', 'Due'], ['a', '2026-10-01'], ['b', '2026-10-05'], ['c', '2026-10-09'], ['d', '2026-10-12'], ['e', 'TBD']]).regions[0]!;
  assert.equal(count(tasks, [{ column: 'Due', op: 'eq', value: 'TBD' }]), 1);
});

test('a filter value is read in its column\'s own number convention', () => {
  const prices = ingest('gia', [['Món', 'Giá'], ['Phở', '45.000 ₫'], ['Bún', '35.000 ₫'], ['Bánh', '12.500 ₫'], ['Trà', '20.000 ₫']]).regions[0]!;
  assert.equal(prices.columns[1]!.numberConvention, 'comma');
  assert.equal(count(prices, [{ column: 'Giá', op: 'gt', value: '30.000' }]), 2, 'was 4: "30.000" read as thirty');
  assert.equal(count(prices, [{ column: 'Giá', op: 'gt', value: '30000' }]), 2);
  assert.equal(count(prices, [{ column: 'Giá', op: 'gt', value: '30 thousand' }]), 2);
  // A column written with the dot as its decimal point still reads "30.5" as thirty and a half.
  const plain = ingest('plain', [['Item', 'Weight'], ['a', '30.25'], ['b', '31.5']]).regions[0]!;
  assert.equal(count(plain, [{ column: 'Weight', op: 'gt', value: '30.5' }]), 1);
});

test('a breakdown says whole groups, and the cursor moves past only those', () => {
  const names = Array.from({ length: 25 }, (_, i) => `Northern Regional Supply Company Number ${i + 1}`);
  const suppliers = ingest('suppliers', [['Supplier', 'Spend'], ...names.map((n, i) => [n, 1000 + i * 100])]).regions[0]!;
  const run = runQuery(suppliers, { aggregate: 'sum', aggregateColumn: 'Spend', groupBy: 'Supplier', limit: 20 });
  const said = speakQuery(suppliers, { aggregate: 'sum', aggregateColumn: 'Spend' }, suppliers.columns[1]!, run);
  assert.match(said, / Say more for the rest\.$/, 'was cut off mid-list, with "say more" lost');
  assert.doesNotMatch(said, /…/);
  const heard = (said.match(/Number \d+, /g) ?? []).length;
  assert.ok(heard > 0 && heard < 20, `${heard} groups said`);
});
