/**
 * The tools, driven over the wire the way a host drives them.
 *
 * Every case here is a finding from the audit, reproduced through the real handler
 * and asserted as the behaviour a listener should get: rows that are actually heard,
 * numbers that say whose they are, tables that can be reached, corrections that stick,
 * and evidence that says when it has gone stale.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import { MemoryStore, type Store } from '../src/mcp/store.ts';
import type { IndexTable, LandmarkIndex } from '../src/indexfmt.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

type Cell = string | number | boolean | null;
const ingest = (name: string, grid: Cell[][], warnings: string[] = []): IndexTable =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings });

const fixtures: IndexTable[] = [];
for (const f of ['01-flat.xlsx', '03-merged-header.xlsx', '04-title-and-vmerge.xlsx', '05-three-regions.xlsx', '06-countries.csv']) {
  fixtures.push(buildTable(await readSpreadsheet(join(FIX, f))));
}

const extras: IndexTable[] = [
  ingest('wide', [
    ['Person', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
    ...Array.from({ length: 8 }, (_, i) => [`Person ${i + 1}`, `a${i}`, `b${i}`, `c${i}`, `d${i}`, `e${i}`, `f${i}`]),
  ]),
  ingest('scores', [['Name', 'Team', 'Score'], ['Ann', 'Odd', 10], ['Ben', 'Even', 20], ['Cal', 'Odd', 30], ['Dee', 'Even', 40], ['Eve', 'Odd', 50], ['Fay', 'Even', 60]]),
  ingest('cents', [['Item', 'Amount'], ['a', 10.1], ['b', 20.2]]),
  ingest('cents2', [['Item', 'Amount'], ['c', 30.3]]),
  ingest('spacer', [['Department', 'Amount'], ['Engineering', 100], ['Design', 50], [null, null], ['Ops', 25], ['Sales', 75]]),
  ingest('years', [[2024, 2025, 2026], [100, 110, 120], [200, 210, 220]]),
  ingest('staff', [['Name', 'Department', 'Title', 'Email', 'Salary'], ['Ann', 'Eng', 'Dev', 'a@x', 50000], ['Ben', 'Eng', 'Dev', 'b@x', 60000], ['Cal', 'Ops', 'Lead', 'c@x', 70000], ['Dee', 'Ops', 'Dev', 'd@x', 80000]]),
  ingest('warned', [['Region', 'Revenue'], ['North', 10], ['South', 20]], ['Sheet "Hidden" is hidden in the file and was skipped.']),
  // Text from top to bottom: nothing can show a label sitting over values of another
  // kind, so this reading stays in doubt.
  ingest('memo', [['Note', 'Status'], ['Q3 close', 'pending'], ['Audit', 'done'], ['Payroll', 'pending']]),
];

// A budget with a Total row, marked the way ingest marks it: `summaryRows` holds
// 0-based indices into the region's rows. Optional in the index, so added by hand.
const totalled = ((): IndexTable => {
  const t = ingest('totalled', [
    ['Department', 'Line item', 'Amount'],
    ['Engineering', 'Salaries', 480000],
    ['Engineering', 'Tooling', 62000],
    ['Design', 'Salaries', 210000],
    ['Total', null, 752000],
  ]);
  const r = t.regions[0]!;
  return { ...t, regions: [{ ...r, summaryRows: [r.rowCount - 1] } as typeof r] };
})();

// Twenty-five columns of figures: one record is longer than a whole spoken answer.
const wide25 = ingest('wide25', [
  ['Name', ...Array.from({ length: 24 }, (_, i) => `Field ${i + 1}`)],
  ...Array.from({ length: 4 }, (_, r) => [`Person ${r + 1}`, ...Array.from({ length: 24 }, (_, i) => 1000 + r * 100 + i)]),
]);

// Headings that differ only by a symbol, and one that is nothing but a symbol.
const fin = ingest('fin', [
  ['#', 'Region', 'Margin', 'Margin %', 'Cost', 'Cost ($)'],
  [1, 'North', 100, '10%', 5, 6],
  [2, 'South', 200, '20%', 7, 8],
  [3, 'East', 300, '30%', 9, 10],
]);

// A twelve-column table whose reading is in doubt. The doubt is set by hand so the
// test does not depend on how ingest scores this particular sheet.
const doubtful = ((): IndexTable => {
  const names = ['Name', 'Department', 'Title', 'Email', 'Phone', 'Office', 'Manager', 'Start date', 'Salary', 'Bonus', 'Level', 'Grade'];
  const t = ingest('doubtful', [names, ...Array.from({ length: 5 }, (_, i) => [`P${i}`, ...names.slice(1).map((_, k) => 100 * i + k)])]);
  const r = t.regions[0]!;
  const structure = {
    ...r.structure,
    ambiguous: true,
    alternatives: [{ headerRows: 0, score: 0.4, why: 'treat every row as data' }],
  };
  return { ...t, regions: [{ ...r, structure }] };
})();

// A nine-column table with a second table beside it in the same file.
const pair = ((): IndexTable => {
  const names = ['Name', 'Department', 'Title', 'Email', 'Phone', 'Office', 'Manager', 'Start', 'Salary'];
  const first = ingest('pair', [names, ...Array.from({ length: 5 }, (_, i) => [`P${i}`, ...names.slice(1).map((_, k) => 10 * i + k)])]);
  const second = ingest('pair2', [['Region', 'Target', 'Actual'], ['North', 1, 2], ['South', 3, 4]]).regions[0]!;
  return { ...first, regions: [first.regions[0]!, { ...second, id: 'pair.t2', sheet: first.regions[0]!.sheet }] };
})();

const index = buildIndex([...fixtures, ...extras, totalled, wide25, fin, doubtful, pair]);

function handlerFor(idx: LandmarkIndex, store?: Store) {
  return createHandler({ index: idx, ...(store ? { makeStore: () => store } : {}) });
}

interface Reply {
  isError: boolean;
  s: Record<string, unknown>;
  spoken: string;
  text: string;
}

async function callOn(handler: (r: Request) => Promise<Response>, session: string, name: string, args: Record<string, unknown>): Promise<Reply> {
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
    result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  };
  const s = body.result.structuredContent ?? {};
  return { isError: body.result.isError === true, s, spoken: String(s['spoken'] ?? ''), text: body.result.content[0]?.text ?? '' };
}

const handler = handlerFor(index);
let sessions = 0;
/** Each test gets its own conversation, so bookmarks and corrections do not leak between them. */
const conversation = () => {
  const session = `engine-${++sessions}`;
  return (name: string, args: Record<string, unknown>) => callOn(handler, session, name, args);
};
const words = (s: string) => s.trim().split(/\s+/).length;

// ── reading rows ────────────────────────────────────────────────────────────

test('read_rows never moves the cursor past a row it did not speak', async () => {
  const call = conversation();
  const first = await call('table_read_rows', { table_id: 'wide' });
  const rows = first.s['rows'] as string[];
  assert.ok(rows.length < 5, 'a wide row cannot fit five to a breath');
  for (const r of rows) assert.ok(first.spoken.includes(r), `row not spoken: ${r}`);
  assert.equal(first.s['returned'], rows.length);
  assert.equal(first.s['cursor'], String(rows.length + 1), 'the next call starts at the first unspoken row');
  assert.match(first.spoken, /Say more to continue\.$/);
  assert.ok(words(first.spoken) <= 70);

  const next = await call('table_read_rows', { table_id: 'wide', cursor: first.s['cursor'] });
  assert.match(next.spoken, new RegExp(`^Person ${rows.length + 1}:`));
});

test('reading rows keeps decimals whole', async () => {
  const call = conversation();
  const r = await call('table_read_rows', { table_id: '06-countries', limit: 8 });
  for (const row of r.s['rows'] as string[]) assert.ok(r.spoken.includes(row));
  assert.ok(!/\d\.\s*Say more/.test(r.spoken));
});

test('a row too wide for one answer is cut by whole columns, out loud', async () => {
  const call = conversation();
  const r = await call('table_read_rows', { table_id: 'wide25' });
  assert.equal(r.s['returned'], 1);
  assert.match(r.spoken, /^Person 1: Field 1 1000, /);
  assert.match(r.spoken, / and \d+ more columns\. Name the columns you want to hear the rest\. Say more to continue\.$/);
  assert.equal(r.s['row_truncated'], true);
  const unread = r.s['columns_not_read'] as string[];
  assert.ok(unread.length > 0 && unread.includes('Field 24'));
  for (const name of unread) assert.ok(!new RegExp(`${name} \\d`).test(r.spoken), `${name} was not spoken`);
  assert.ok(words(r.spoken) <= 70, `${words(r.spoken)} words`);

  // And the rest of that row is there for the asking.
  const rest = await call('table_read_rows', { table_id: 'wide25', columns: unread, limit: 1 });
  assert.match(rest.spoken, /Field 24 1023/);
  assert.equal(rest.s['row_truncated'], undefined);
});

test('a listing of rows wider than an answer still speaks every row it counts', async () => {
  const call = conversation();
  let cursor: unknown;
  const heard: string[] = [];
  for (let page = 0; page < 6; page++) {
    const r = await call('table_query', { table_id: 'wide25', ...(cursor ? { cursor } : {}) });
    const rows = r.s['rows'] as { label: string }[];
    assert.ok(rows.length >= 1, r.spoken);
    for (const row of rows) {
      assert.ok(r.spoken.includes(`${row.label}: Field 1 `), `${row.label} is counted but not spoken: ${r.spoken}`);
      heard.push(row.label);
    }
    assert.equal(r.s['row_truncated'], true);
    assert.match(r.spoken, /more columns\. Name the columns you want to hear the rest\./);
    cursor = r.s['cursor'];
    if (!cursor) break;
  }
  assert.deepEqual(heard, ['Person 1', 'Person 2', 'Person 3', 'Person 4']);
});

test('an error on a wide table keeps its next step', async () => {
  const call = conversation();
  for (const r of [
    await call('table_query', { table_id: 'wide25', aggregate: 'sum', aggregate_column: 'Revenue' }),
    await call('table_read_rows', { table_id: 'wide25', columns: ['Revenue'] }),
  ]) {
    assert.equal(r.isError, true);
    assert.match(r.spoken, /no column called "Revenue"\. The columns are: Name, Field 1, .* and \d+ more\.$/);
  }
});

test('asking to read a column that does not exist names the ones that do', async () => {
  const call = conversation();
  const r = await call('table_read_rows', { table_id: 'scores', columns: ['Salary'] });
  assert.equal(r.isError, true);
  assert.match(r.spoken, /no column called "Salary".*Name, Team and Score/);
  const ok = await call('table_read_rows', { table_id: 'scores', columns: ['score'] });
  assert.match(ok.spoken, /^Ann: Score 10\./);
});

// ── listings speak the rows ─────────────────────────────────────────────────

test('"which rows" is answered with the rows, not a count', async () => {
  const call = conversation();
  const north = await call('table_query', { table_id: '01-flat', filters: [{ column: 'Region', op: 'eq', value: 'North' }] });
  assert.match(north.spoken, /Anh/);
  assert.match(north.spoken, /Bảo/);
  assert.ok(!/^2 rows\.$/.test(north.spoken));

  const vietnam = await call('table_query', { table_id: '06-countries', filters: [{ column: 'Country', op: 'eq', value: 'Vietnam' }] });
  assert.match(vietnam.spoken, /Population 100,352,192/);
});

test('a long listing fits the budget and pages from the first row not spoken', async () => {
  const call = conversation();
  const page = await call('table_query', { table_id: '06-countries', limit: 20 });
  assert.ok(words(page.spoken) <= 70, `${words(page.spoken)} words`);
  assert.match(page.spoken, /^8 rows match\./);
  assert.match(page.spoken, /Say more for the rest\.$/);
  const listed = (page.s['rows'] as unknown[]).length;
  assert.equal(page.s['cursor'], String(listed));

  const rest = await call('table_query', { table_id: '06-countries', limit: 20, cursor: page.s['cursor'] });
  assert.match(rest.spoken, new RegExp(`^Rows ${listed + 1} to 8 of 8\\.`));
  assert.equal(rest.s['more_available'], false);
});

// ── highest and lowest, and how you know ────────────────────────────────────

test('"highest" names the row, and explain cites the winning cell first', async () => {
  const call = conversation();
  const q = await call('table_query', { table_id: '06-countries', aggregate: 'max', aggregate_column: 'GDP per capita (usd)' });
  assert.match(q.spoken, /for Norway/);
  assert.deepEqual(q.s['winners'], ['Norway']);
  assert.equal(q.s['exact'], '87,962');
  const e = await call('table_explain', { answer_id: q.s['answer_id'] });
  assert.match(e.spoken, /^That came from C8 on 06-countries, for Norway, the highest of 8 cells: C2 through C9\./);
});

test('explain never calls non-adjacent cells a range', async () => {
  const call = conversation();
  const q = await call('table_query', {
    table_id: 'scores',
    filters: [{ column: 'Team', op: 'eq', value: 'Odd' }],
    aggregate: 'sum',
    aggregate_column: 'Score',
  });
  const e = await call('table_explain', { answer_id: q.s['answer_id'] });
  assert.ok(!/through/.test(e.spoken), e.spoken);
  assert.match(e.spoken, /C2, C4 and C6/);
});

test('a count is explained by the rows it counted, not by a column it ignored', async () => {
  const call = conversation();
  const q = await call('table_query', { table_id: 'scores', aggregate: 'count', aggregate_column: 'Score' });
  const e = await call('table_explain', { answer_id: q.s['answer_id'] });
  assert.match(e.spoken, /counted 6 rows: A2 through A7 on scores, in the Name column/);
  assert.deepEqual(e.s['header_path'], ['Name']);
});

// ── every table in a file can be reached ────────────────────────────────────

test('describe says the file holds more tables, and lists them for a caller', async () => {
  const call = conversation();
  const d = await call('table_describe', { table_id: '05-three-regions' });
  assert.match(d.spoken, /2 more tables: table 2 has Region, Target and Actual; table 3 has Note and Status/);
  const regions = d.s['regions'] as { n: number; id: string; columns: string[] }[];
  assert.deepEqual(regions.map((r) => r.id), ['mixed.t1', 'mixed.t2', 'mixed.t3']);
  assert.deepEqual(regions[1]!.columns, ['Region', 'Target', 'Actual']);

  const list = await call('table_list', { cursor: '0' });
  const t5 = (list.s['tables'] as { table_id: string; regions: unknown[] }[]).find((t) => t.table_id === '05-three-regions');
  assert.equal(t5?.regions.length, 3);
});

test('"table 2" reaches the second table, however it is said', async () => {
  const call = conversation();
  for (const sheet of ['2', 'table 2', 'the second table', 'mixed.t2', 'Table Two']) {
    const q = await call('table_query', { table_id: '05-three-regions', sheet, aggregate: 'sum', aggregate_column: 'Actual' });
    assert.equal(q.s['result'], 16300, `sheet "${sheet}": ${q.spoken}`);
  }
  const c = await call('table_compare', { table_id: '05-three-regions', sheet: '2', left_column: 'Target', right_column: 'Actual' });
  assert.match(c.spoken, /Target is 2700 more than Actual/);

  const bad = await call('table_describe', { table_id: '05-three-regions', sheet: 'Nope' });
  assert.match(bad.spoken, /table number from 1 to 3/);
});

test('a table split by a blank row says the rest exists, in describe and in its totals', async () => {
  const call = conversation();
  const d = await call('table_describe', { table_id: 'spacer' });
  assert.match(d.spoken, /1 more table: table 2 has 2 rows with no headings, from row 5/);
  const q = await call('table_query', { table_id: 'spacer', aggregate: 'sum', aggregate_column: 'Amount' });
  assert.match(q.spoken, /covers only the first of 2 tables/);
});

test('a one-line footnote is called a note, not a table', async () => {
  // Ingest may keep the footnote as a one-cell region or report it as a note in the
  // file's warnings; either way it is said once, as a note.
  const call = conversation();
  const d = await call('table_describe', { table_id: '06-countries' });
  assert.match(d.spoken, /There is also a (?:one-line )?note: "Source: illustrative figures/);
  assert.ok(!/more table/.test(d.spoken));
  assert.ok(!/Note: A note/i.test(d.spoken), d.spoken);
  assert.equal(d.spoken.match(/illustrative figures/g)?.length, 1);
});

test('the file\'s warnings are said on describe, once', async () => {
  const call = conversation();
  const d = await call('table_describe', { table_id: 'warned' });
  assert.equal(d.spoken.match(/is hidden in the file/g)?.length, 1, d.spoken);
});

test('describe always names the columns, however much else it has to say', async () => {
  const call = conversation();
  // An uncertain reading of a twelve-column table: the warning used to take the
  // column list's room and the list was dropped whole.
  const doubt = await call('table_describe', { table_id: 'doubtful' });
  assert.match(doubt.spoken, /The columns are Name, Department, Title(?:, [A-Za-z ]+)* and \d+ more\./);
  assert.match(doubt.spoken, /not certain how to read the headings/);
  assert.ok(words(doubt.spoken) <= 70, `${words(doubt.spoken)} words`);

  // A nine-column table in a file with a second table.
  const two = await call('table_describe', { table_id: 'pair' });
  assert.match(two.spoken, /The columns are Name, Department, Title/);
  assert.match(two.spoken, /1 more table: table 2 has Region, Target and Actual/);
  assert.ok(words(two.spoken) <= 70, `${words(two.spoken)} words`);

  // Two long ingest warnings: one is said, cut at a sentence, never mid-word.
  const long = buildTable({
    sourceName: 'noisy.csv',
    format: 'csv',
    sheets: [{ name: 'noisy', grid: [['Department', 'Q1', 'Q2', 'Amount'], ['Eng', 1, 2, 480000], ['Design', 3, 4, 62000], ['Ops', 5, 6, 7000]], merges: [] }],
    warnings: [
      'Sheet "noisy" has 3 formulas with no saved result, starting at D5, so I read them as empty. Opening the file in Excel and saving it stores the results.',
      'Sheet "noisy" has 2 hidden rows (5, 6). I included them, so totals match Excel\'s own SUM rather than only what is visible on screen.',
    ],
  });
  const noisy = await callOn(handlerFor(buildIndex([long])), 'n', 'table_describe', { table_id: 'noisy' });
  assert.match(noisy.spoken, /The columns are Department, Q1, Q2 and Amount\./);
  assert.match(noisy.spoken, /Note: Sheet "noisy" has 3 formulas with no saved result, starting at D5, so I read them as empty\./);
  assert.ok(!/hidden rows/.test(noisy.spoken), 'one warning, not two');
  assert.ok(!/…/.test(noisy.spoken), noisy.spoken);
  assert.ok(words(noisy.spoken) <= 70, `${words(noisy.spoken)} words`);
});

test('a column that is in another table of the file is pointed to', async () => {
  const call = conversation();
  const q = await call('table_query', { table_id: '05-three-regions', aggregate: 'sum', aggregate_column: 'Actual' });
  assert.equal(q.isError, true);
  assert.match(q.spoken, /no column called "Actual"\. Table 2 in this file has Actual\. Say "table 2" to use it\./);
  const bySheet = await call('table_query', { table_id: '05-three-regions', sheet: 'Mixed', aggregate: 'sum', aggregate_column: 'Actual' });
  assert.match(bySheet.spoken, /Table 2 in this file has Actual/);
  const read = await call('table_read_rows', { table_id: '05-three-regions', columns: ['Status'] });
  assert.match(read.spoken, /Table 3 in this file has Status/);
  const c = await call('table_compare', { table_id: '05-three-regions', left_column: 'Target', right_column: 'Actual' });
  assert.match(c.spoken, /Table 2 in this file has Target/);
});

test('a sheet holding several tables says the answer covers only its first', async () => {
  const call = conversation();
  const bySheet = await call('table_query', { table_id: '05-three-regions', sheet: 'Mixed', aggregate: 'sum', aggregate_column: 'Units' });
  assert.match(bySheet.spoken, /That covers only the first of 3 tables on Mixed\.$/);
  for (const sheet of ['1', 'mixed.t1']) {
    const chosen = await call('table_query', { table_id: '05-three-regions', sheet, aggregate: 'sum', aggregate_column: 'Units' });
    assert.ok(!/covers only/.test(chosen.spoken), `named "${sheet}", the caller chose it: ${chosen.spoken}`);
  }
});

// ── total rows ──────────────────────────────────────────────────────────────

test('a Total row is left out of answers but read, and named, as a total row', async () => {
  const call = conversation();
  const d = await call('table_describe', { table_id: 'totalled' });
  assert.match(d.spoken, /has 3 rows and 3 columns/);
  assert.deepEqual(d.s['summary_rows'], [4]);

  const q = await call('table_query', { table_id: 'totalled', aggregate: 'sum', aggregate_column: 'Amount' });
  assert.equal(q.s['result'], 752000);
  assert.match(q.spoken, /across 3 rows\. I left out the Total row\.$/);
  assert.deepEqual(q.s['left_out_summary_rows'], [4]);

  const rows = await call('table_read_rows', { table_id: 'totalled' });
  assert.match(rows.spoken, /Total row: Amount 752,000\.$/, 'a total row is read as its figures, without its blank cells');
  assert.ok(!/Department Total/.test(rows.spoken), 'the word that made it a total is not read as a department');
  assert.deepEqual(rows.s['summary_rows'], [4]);

  const c = await call('table_compare', { table_id: 'totalled', left_column: 'Amount', right_column: 'Amount' });
  assert.match(c.spoken, /are both 752 thousand\. I left out the Total row\.$/);
  assert.equal(c.spoken.match(/left out/g)?.length, 1);

  const itself = await call('table_query', {
    table_id: 'totalled',
    filters: [{ column: 'Department', op: 'eq', value: 'Total' }],
    aggregate: 'sum',
    aggregate_column: 'Amount',
  });
  assert.ok(!/no row has/.test(itself.spoken), itself.spoken);
  assert.match(itself.spoken, /only row that matches is the sheet's own Total row/);
});

// ── uncertain structure ─────────────────────────────────────────────────────

test('an answer from an unconfirmed reading carries the doubt with it', async () => {
  const call = conversation();
  const q = await call('table_query', { table_id: 'years', aggregate: 'sum', aggregate_column: 'column 1' });
  assert.equal(q.s['result'], 2324, 'still answered');
  assert.match(q.spoken, /not certain.*check the structure/i);
  assert.equal(q.s['structure_uncertain'], true);
});

test('confirming the inferred reading settles it, with one consistent revision', async () => {
  const call = conversation();
  const fixed = await call('table_structure', { table_id: 'years', header_rows: 0 });
  const after = await call('table_structure', { table_id: 'years' });
  assert.equal(after.s['confirmed_by_user'], true);
  assert.equal(after.s['ambiguous'], false);
  assert.equal(after.s['revision'], fixed.s['revision'], 'the revision announced is the one in force');
  assert.match(after.spoken, /You confirmed this/);

  const d = await call('table_describe', { table_id: 'years' });
  assert.ok(!/not certain/i.test(d.spoken), d.spoken);
  const q = await call('table_query', { table_id: 'years', aggregate: 'sum', aggregate_column: 'column 1' });
  assert.ok(!/not certain/i.test(q.spoken));
  assert.equal(q.s['structure_uncertain'], undefined);
});

test('confirming the reading in use does not make earlier answers or bookmarks stale', async () => {
  const call = conversation();
  const q = await call('table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
  await call('table_bookmark', { name: 'here', table_id: '01-flat', row: 2 });
  const yes = await call('table_structure', { table_id: '01-flat', header_rows: 1 });
  assert.equal(yes.s['note'], undefined, 'nothing computed before it changes');

  const e = await call('table_explain', { answer_id: q.s['answer_id'] });
  assert.equal(e.s['structure_changed_since'], false);
  assert.ok(!/changed how this table is read/.test(e.spoken), e.spoken);
  const back = await call('table_resume', { name: 'here' });
  assert.ok(!/has changed since you saved/.test(back.spoken), back.spoken);

  // A real change still is.
  await call('table_structure', { table_id: '01-flat', header_rows: 0 });
  assert.equal((await call('table_explain', { answer_id: q.s['answer_id'] })).s['structure_changed_since'], true);
  assert.match((await call('table_resume', { name: 'here' })).spoken, /has changed since you saved this/);
});

test('an uncertain reading with nothing to offer never says "I could instead ."', async () => {
  const call = conversation();
  const s = await call('table_structure', { table_id: 'memo' });
  assert.ok(!/instead\s*\./.test(s.spoken), s.spoken);
  assert.match(s.spoken, /not certain/);
});

test('a plainly labelled staff list is not in doubt, and its answers carry no caveat', async () => {
  // One Salary column is the only place a label can be seen over a number, and it shows
  // it. Scored against every column, this read as uncertain, and every answer offered to
  // treat the heading row as a record.
  const call = conversation();
  const s = await call('table_structure', { table_id: 'staff' });
  assert.doesNotMatch(s.spoken, /not certain/);
  const avg = await call('table_query', { table_id: 'staff', aggregate: 'avg', aggregate_column: 'Salary' });
  assert.equal(avg.spoken, '65 thousand. That is the average of Salary across 4 rows.');
});

// ── comparisons ─────────────────────────────────────────────────────────────

test('the filmed comparison reads without commas inside the names', async () => {
  const call = conversation();
  const c = await call('table_compare', { table_id: '03-merged-header', left_column: '2026, Q1, Revenue', right_column: '2025 Q1 Revenue' });
  assert.equal(c.spoken, '2026 Q1 Revenue is 200 more than 2025 Q1 Revenue, about 11%: 2100 against 1900.');
});

test('same-named measures in different files are told apart, and cents compare equal', async () => {
  const call = conversation();
  const c = await call('table_compare', { table_id: 'cents', left_column: 'Amount', right_table_id: 'cents2', right_column: 'Amount' });
  assert.equal(c.spoken, 'Amount in Cents and Amount in Cents2 are both 30.3.');
  assert.equal(c.s['difference'], 0);
  const e = await call('table_explain', { answer_id: c.s['answer_id'] });
  assert.match(e.spoken, /Amount in Cents came from .* Amount in Cents2 came from/);
});

test('correcting the right-hand table marks a comparison as stale', async () => {
  const call = conversation();
  const c = await call('table_compare', { table_id: 'cents', left_column: 'Amount', right_table_id: 'cents2', right_column: 'Amount' });
  await call('table_structure', { table_id: 'cents2', header_rows: 0 });
  const e = await call('table_explain', { answer_id: c.s['answer_id'] });
  assert.equal(e.s['structure_changed_since'], true);
  assert.match(e.spoken, /changed how this table is read/);
});

// ── the file changing underneath an answer ──────────────────────────────────

test('explain and resume say so when the file was loaded again since', async () => {
  const v1 = ingest('ledger', [['Dept', 'Amount'], ['Eng', 10], ['Ops', 20]]);
  const v2: IndexTable = { ...ingest('ledger', [['Dept', 'Amount'], ['Eng', 500], ['Ops', 700], ['HR', 900]]), ingestedAt: '2099-01-01T00:00:00.000Z' };
  const store = new MemoryStore();
  const before = handlerFor(buildIndex([v1]), store);
  const after = handlerFor(buildIndex([v2]), store);

  const q = await callOn(before, 's', 'table_query', { table_id: 'ledger', aggregate: 'sum', aggregate_column: 'Amount' });
  await callOn(before, 's', 'table_bookmark', { name: 'ops', table_id: 'ledger', row: 2 });

  const e = await callOn(after, 's', 'table_explain', { answer_id: q.s['answer_id'] });
  assert.equal(e.s['file_changed_since'], true);
  assert.match(e.spoken, /loaded again since I gave that answer/);

  const back = await callOn(after, 's', 'table_resume', { name: 'ops' });
  assert.match(back.spoken, /loaded again since you saved this/);
});

// ── names are spoken without commas, everywhere ─────────────────────────────

test('no spoken sentence runs a heading path together with commas', async () => {
  const call = conversation();
  const said: string[] = [];
  said.push((await call('table_describe', { table_id: '03-merged-header', detail: 'full' })).spoken);
  said.push((await call('table_read_rows', { table_id: '03-merged-header' })).spoken);
  said.push((await call('table_query', { table_id: '03-merged-header', aggregate: 'sum', aggregate_column: 'Profit' })).spoken);
  said.push((await call('table_query', { table_id: '03-merged-header', aggregate: 'sum', aggregate_column: 'Revenue' })).spoken);
  said.push((await call('table_structure', { table_id: '03-merged-header' })).spoken);
  const c = await call('table_compare', { table_id: '03-merged-header', left_column: '2026 Q1 Revenue', right_column: '2025 Q1 Revenue' });
  said.push(c.spoken, (await call('table_explain', { answer_id: c.s['answer_id'] })).spoken);
  const q = await call('table_query', { table_id: '03-merged-header', aggregate: 'sum', aggregate_column: '2026 Q2 Revenue' });
  said.push(q.spoken, (await call('table_explain', { answer_id: q.s['answer_id'] })).spoken);
  said.push((await call('table_structure', { table_id: '03-merged-header', header_rows: 3 })).spoken);
  for (const s of said) assert.ok(!/20\d\d, Q\d/.test(s), `comma-joined heading in: ${s}`);
  assert.equal(q.s['result'], 2350, 'and the spoken form resolves');
});

test('every column name describe hands out resolves when it is handed back', async () => {
  const call = conversation();
  for (const table_id of ['fin', '03-merged-header', 'wide25', '06-countries']) {
    const d = await call('table_describe', { table_id });
    const columns = d.s['columns'] as { name: string; spoken_name: string; type: string }[];
    for (const c of columns) {
      for (const name of [c.name, c.spoken_name]) {
        const q = await call('table_query', { table_id, aggregate: 'count', group_by: name, limit: 1 });
        assert.equal(q.isError, false, `${table_id}: "${name}" → ${q.spoken}`);
      }
    }
  }
});

test('highest over thousands of tied rows is quick, and names a few with a count', async () => {
  const base = ingest('flags', [['Name', 'Flag'], ['a', 1], ['b', 1]]);
  const r = base.regions[0]!;
  const rows = Array.from({ length: 20_000 }, (_, i) => [`P${i}`, 1] as Cell[]);
  const flags: IndexTable = { ...base, regions: [{ ...r, rows, rowCount: rows.length }] };
  const h = handlerFor(buildIndex([flags]));
  const started = performance.now();
  const q = await callOn(h, 'f', 'table_query', { table_id: 'flags', aggregate: 'max', aggregate_column: 'Flag' });
  const took = performance.now() - started;
  assert.ok(took < 250, `${took.toFixed(0)} ms`);
  assert.ok((q.s['winners'] as string[]).length <= 5);
  assert.equal(q.s['winner_count'], 20_000);
  assert.ok(q.text.length < 4000, `${q.text.length} bytes`);
  assert.match(q.spoken, /^1, for P0 and 19999 others\./);
  const e = await callOn(h, 'f', 'table_explain', { answer_id: q.s['answer_id'] });
  assert.match(e.spoken, /for P0 and 19999 others/);
});

// ── bookmarks ───────────────────────────────────────────────────────────────

test('"carry on" with no name returns to the most recent place', async () => {
  const call = conversation();
  assert.match((await call('table_resume', {})).spoken, /nothing is saved/i);
  await call('table_bookmark', { name: 'first', table_id: '06-countries', row: 3 });
  await new Promise((r) => setTimeout(r, 5));
  await call('table_bookmark', { name: 'my place', table_id: '06-countries', row: 6, note: 'check\nNorway' });
  const back = await call('table_resume', {});
  assert.equal(back.s['name'], 'my place');
  assert.equal(back.s['row'], 6);
  assert.match(back.spoken, /^Back in 06 countries, row 6 of 8\. You noted: check Norway\. You also have first\.$/);
});

test('a bookmark past the end of the table is refused', async () => {
  const call = conversation();
  const r = await call('table_bookmark', { name: 'far', table_id: '01-flat', row: 99 });
  assert.equal(r.isError, true);
  assert.match(r.spoken, /only has 5 rows/);
});

// ── robustness ──────────────────────────────────────────────────────────────

test('a store failure is spoken as a sentence, not as the raw exception', async () => {
  const broken: Store = new Proxy(new MemoryStore(), {
    get(target, prop) {
      if (prop === 'putAnswer' || prop === 'getStructure') {
        return async () => {
          throw new Error('KV GET failed: 10013 internal-secret-detail');
        };
      }
      return Reflect.get(target, prop);
    },
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await callOn(handlerFor(index, broken), 'x', 'table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
    assert.equal(r.isError, true);
    assert.match(r.spoken, /went wrong on my side/);
    assert.ok(!/KV|10013|secret/.test(r.spoken + r.text), r.text);
  } finally {
    console.error = quiet;
  }
});

test('inputs are bounded', async () => {
  const call = conversation();
  assert.equal((await call('table_describe', { table_id: 'x'.repeat(201) })).isError, true);
  const filters = Array.from({ length: 11 }, () => ({ column: 'Region', op: 'eq', value: 'North' }));
  assert.equal((await call('table_query', { table_id: '01-flat', filters })).isError, true);
  assert.equal(
    (await call('table_bookmark', { name: 'n', table_id: '01-flat', row: 1, note: 'x'.repeat(501) })).isError,
    true,
  );
});

// ── the widget's share of an explanation ────────────────────────────────────

test('explain lights every counted cell, and keeps the grid out of the model\'s text', async () => {
  const call = conversation();
  const q = await call('table_query', { table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population' });
  const e = await call('table_explain', { answer_id: q.s['answer_id'] });
  assert.deepEqual(e.s['highlight'], ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']);
  assert.ok(e.s['grid'], 'the widget still gets its grid');
  assert.ok(!/"grid"|"highlight"/.test(e.text), 'but the model-visible mirror does not');

  const c = await call('table_compare', { table_id: '03-merged-header', left_column: '2026 Q1 Revenue', right_column: '2025 Q1 Revenue' });
  const ce = await call('table_explain', { answer_id: c.s['answer_id'] });
  assert.deepEqual(ce.s['highlight'], ['B4', 'B5', 'D4', 'D5'], 'both operands, not just the first');
});

test('a long breakdown pages by the groups it said, and always says there is more', async () => {
  const names = Array.from({ length: 25 }, (_, i) => `Northern Regional Supply Company Number ${i + 1}`);
  const suppliers = ingest('suppliers', [['Supplier', 'Spend'], ...names.map((n, i) => [n, 1000 + i * 100])]);
  const h = handlerFor(buildIndex([suppliers]));
  const first = await callOn(h, 'groups', 'table_query', { table_id: 'suppliers', aggregate: 'sum', aggregate_column: 'Spend', group_by: 'Supplier', limit: 20 });
  const groups = first.s['groups'] as { key: string }[];
  assert.ok(groups.length > 0 && groups.length < 20, `${groups.length} groups said`);
  assert.equal(first.s['cursor'], String(groups.length), 'the cursor was 20, past groups never heard');
  assert.match(first.spoken, /Say more for the rest\.$/);
  for (const g of groups) assert.ok(first.spoken.includes(g.key), `${g.key} is in the answer`);

  const next = await callOn(h, 'groups', 'table_query', {
    table_id: 'suppliers', aggregate: 'sum', aggregate_column: 'Spend', group_by: 'Supplier', limit: 20, cursor: first.s['cursor'],
  });
  const after = (next.s['groups'] as { key: string }[])[0]!.key;
  assert.ok(!groups.some((g) => g.key === after), 'the next page starts with the first group not yet said');
});
