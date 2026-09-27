/**
 * The voice router, on its own.
 *
 * test/conversation.test.ts drives the router against the real server and the bundled
 * index. These cases build the conversation state by hand instead, for the shapes that
 * index does not happen to contain: a text column whose values are listed, a catalogue
 * that lists each file's columns, a bookmark from before a reload. The router has to
 * be right about those before any server sends them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { route, absorb, context, resetContext } from '../web/app.js';

interface Plan {
  tool?: string;
  args?: Record<string, unknown>;
  speak?: string;
  then?: string;
  announce?: string;
}

const plan = (said: string): Plan => route(said) as Plan;

const SALES = [
  { name: 'Region', header_path: ['Region'], type: 'text', non_empty: 5, distinct: 3, categories: ['East', 'North', 'South'] },
  { name: 'Rep', header_path: ['Rep'], type: 'text', non_empty: 5, distinct: 5 },
  { name: 'Revenue', header_path: ['Revenue'], type: 'number', non_empty: 5, distinct: 5, min: 3900, max: 21000, sum: 61050 },
];

const CATALOGUE = [
  {
    table_id: 'sales',
    title: 'Sales',
    sheets: ['Sales'],
    regions: [{ n: 1, id: 'sales.t1', sheet: 'Sales', title: null, row_count: 5, columns: ['Region', 'Rep', 'Revenue'] }],
  },
  {
    table_id: 'budget',
    title: 'Budget',
    sheets: ['Budget'],
    regions: [{ n: 1, id: 'budget.t1', sheet: 'Budget', title: null, row_count: 5, columns: ['Department', 'Line item', 'Amount'] }],
  },
  {
    table_id: 'quarters',
    title: 'Quarters',
    sheets: ['Quarterly'],
    regions: [{ n: 1, id: 'q.t1', sheet: 'Quarterly', title: null, row_count: 3, columns: ['Region', 'Q1 Revenue', 'Q2 Revenue'] }],
  },
];

/** A conversation with the sales table open and described. */
function salesOpen(): void {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales';
  context.chosen = true;
  context.columns = structuredClone(SALES);
}

test('a value listed for a text column is recognised as a filter', () => {
  salesOpen();
  // Region is typed text here, not category. Only category columns used to be searched,
  // so "north" was dropped and the total of every region was spoken instead.
  const p = plan('total revenue for north');
  assert.equal(p.tool, 'table_query');
  assert.deepEqual(p.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'North' }]);
  assert.equal(p.args?.['aggregate_column'], 'Revenue');
});

test('a misheard value is asked about with the values it could have been', () => {
  salesOpen();
  const p = plan('total revenue for northe');
  assert.equal(p.tool, undefined);
  assert.equal(p.speak, 'I could not find "northe" in this table. The regions are East, North and South.');
});

test('with one measure, a filter alone is enough to answer', () => {
  salesOpen();
  const p = plan('total for south');
  assert.equal(p.args?.['aggregate_column'], 'Revenue');
  assert.deepEqual(p.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'South' }]);
});

test('"per" groups only when a column follows it', () => {
  salesOpen();
  assert.equal(plan('total revenue per region').args?.['group_by'], 'Region');
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales';
  context.chosen = true;
  context.columns = [
    { name: 'GDP per capita (usd)', header_path: ['GDP per capita (USD)'], type: 'number', non_empty: 8, distinct: 8, min: 1, max: 9, sum: 40 },
    { name: 'Region', header_path: ['Region'], type: 'category', non_empty: 8, distinct: 4, categories: ['Asia', 'Europe'] },
  ];
  const p = plan('average gdp per capita');
  assert.equal(p.args?.['group_by'], undefined, '"per capita" is part of the column name');
  assert.equal(p.args?.['aggregate_column'], 'GDP per capita (usd)');
});

test('"highest revenue by region" ranks regions by their totals', () => {
  salesOpen();
  const p = plan('highest revenue by region');
  assert.equal(p.args?.['group_by'], 'Region');
  assert.equal(p.args?.['aggregate'], 'sum');
});

test('with no table chosen, the only file holding the named column is opened, and named', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales'; // the page's default, which nobody chose
  const p = plan('total amount for engineering');
  // Learn the budget's columns first, then route the same words again.
  assert.equal(p.tool, 'table_describe');
  assert.equal(p.args?.['table_id'], 'budget');
  assert.equal(p.then, 'total amount for engineering');
  assert.equal(p.announce, 'In Budget.');
});

test('with no table chosen and several files holding the column, it asks which, by name', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales';
  const p = plan('what is the total revenue');
  assert.equal(p.speak, 'Which file? Revenue is in Sales and Quarters.');

  // The reply picks the file, and the question comes back to be answered.
  const next = plan('the quarters one');
  assert.equal(next.tool, 'table_describe');
  assert.equal(next.args?.['table_id'], 'quarters');
  assert.equal(next.then, 'what is the total revenue');
});

test('a word naming both the open table and another file stays with the open table', () => {
  salesOpen();
  context.tables.push({ table_id: 'regions', title: 'Three regions', sheets: ['Mixed'] });
  const p = plan('how many regions');
  assert.equal(p.args?.['table_id'], 'sales');
});

test('naming another file plainly still moves to it, and says so', () => {
  salesOpen();
  const p = plan('total amount in the budget file');
  assert.equal(p.tool, 'table_describe', 'the budget columns are not known yet');
  assert.equal(p.args?.['table_id'], 'budget');
  assert.equal(p.announce, 'In Budget.');
});

test('"carry on" asks for the saved place by name, with or without a remembered one', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales';
  // After a reload the page has forgotten which name it saved under.
  assert.deepEqual(plan('carry on').args, { name: 'my place' });

  context.bookmarkName = 'budget review';
  assert.deepEqual(plan('where was I').args, { name: 'budget review' });
});

test('resuming sets up "more" to read on from the saved row', () => {
  salesOpen();
  absorb('table_resume', { name: 'my place' }, { name: 'my place', table_id: 'budget', sheet: 'Budget', row: 4 });
  assert.equal(context.tableId, 'budget');
  assert.deepEqual(context.columns, [], 'the sales columns do not belong to the budget');
  const p = plan('more');
  assert.equal(p.tool, 'table_read_rows');
  assert.equal(p.args?.['cursor'], '4');
  assert.equal(p.args?.['table_id'], 'budget');
});

test('structure phrases reach the structure tool with the right heading count', () => {
  salesOpen();
  assert.deepEqual(plan('how are you reading this table').args, { table_id: 'sales' });
  assert.equal(plan('check the structure').tool, 'table_structure');
  assert.equal(plan('there are no headings').args?.['header_rows'], 0);
  assert.equal(plan('the first row is data').args?.['header_rows'], 0);
  assert.equal(plan('use two heading rows').args?.['header_rows'], 2);
  assert.equal(plan('the first row is headings').args?.['header_rows'], 1);
});

test('"yes, that\'s right" confirms the reading just described, and only then', () => {
  salesOpen();
  absorb('table_structure', { table_id: 'sales' }, { table_id: 'sales', header_rows: 2, ambiguous: true });
  const yes = plan("yes, that's right");
  assert.equal(yes.tool, 'table_structure');
  assert.deepEqual(yes.args, { table_id: 'sales', header_rows: 2 });

  absorb('table_describe', { table_id: 'sales' }, { table_id: 'sales', columns: SALES });
  assert.notEqual(plan('yes').tool, 'table_structure', 'a yes to anything else is not a correction');
});

test('a correction makes the next question relearn the columns', () => {
  salesOpen();
  absorb('table_structure', { table_id: 'sales', header_rows: 0 }, { table_id: 'sales', header_rows: 0, columns: ['column 1'] });
  assert.deepEqual(context.columns, [], 'bare names from a correction are not column records');
  const p = plan('total revenue');
  assert.equal(p.tool, 'table_describe');
  assert.equal(p.then, 'total revenue');
});

test('"tell me more" reaches the full description', () => {
  salesOpen();
  absorb('table_describe', { table_id: 'sales' }, { table_id: 'sales', columns: SALES });
  for (const said of ['tell me more', 'tell me more about it']) {
    const p = plan(said);
    assert.equal(p.tool, 'table_describe', said);
    assert.equal(p.args?.['detail'], 'full', said);
  }
});

test('the clarifying question lists only measures, without commas in their names', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'quarters';
  context.chosen = true;
  context.columns = [
    { name: 'Region', header_path: ['Region'], type: 'text', non_empty: 3, distinct: 3 },
    { name: 'Q1, Revenue', header_path: ['Q1', 'Revenue'], type: 'number', non_empty: 3, distinct: 3, min: 1, max: 3, sum: 6 },
    { name: 'Q2, Target', header_path: ['Q2', 'Target'], type: 'number', non_empty: 3, distinct: 3, min: 1, max: 3, sum: 6 },
  ];
  assert.equal(plan('what is the average').speak, 'Which column? I have Q1 Revenue and Q2 Target.');
  // The reply is matched by its words, and the name that goes back is the server's own.
  assert.equal(plan('q2 target').args?.['aggregate_column'], 'Q2, Target');
});

test('a typed name with accents folded still finds the value', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales';
  context.chosen = true;
  context.columns = [
    { name: 'Rep', header_path: ['Rep'], type: 'text', non_empty: 4, distinct: 2, categories: ['Bảo', 'Dũng'] },
    { name: 'Revenue', header_path: ['Revenue'], type: 'number', non_empty: 4, distinct: 4, min: 1, max: 4, sum: 10 },
  ];
  assert.deepEqual(plan('total revenue for bao').args?.['filters'], [{ column: 'Rep', op: 'eq', value: 'Bảo' }]);
  assert.deepEqual(plan('total revenue for Dũng').args?.['filters'], [{ column: 'Rep', op: 'eq', value: 'Dũng' }]);
});

// ── values made of everyday words ───────────────────────────────────────────

/** The flat sample as a server that lists every short text column's values describes it. */
const SALES_LISTED = [
  { name: 'Region', header_path: ['Region'], type: 'text', non_empty: 5, distinct: 3, categories: ['East', 'North', 'South'] },
  { name: 'Rep', header_path: ['Rep'], type: 'text', non_empty: 5, distinct: 5, categories: ['An', 'Anh', 'Bảo', 'Chi', 'Dũng'] },
  { name: 'Revenue', header_path: ['Revenue'], type: 'number', non_empty: 5, distinct: 5, min: 3900, max: 21000, sum: 61050 },
  { name: 'Closed', header_path: ['Closed'], type: 'date', non_empty: 5, distinct: 5 },
];

function salesListed(): void {
  salesOpen();
  context.columns = structuredClone(SALES_LISTED);
}

test('a rep called An is found where a name goes, and not where "an" is an article', () => {
  salesListed();
  // Every everyday word was stripped from values, so An matched nothing and "total
  // revenue for an" spoke the total of every rep.
  const an = [{ column: 'Rep', op: 'eq', value: 'An' }];
  assert.deepEqual(plan('total revenue for an').args?.['filters'], an);
  assert.deepEqual(plan('how much did An sell').args?.['filters'], an);
  assert.deepEqual(plan("what is An's revenue").args?.['filters'], an);

  const avg = plan("what's an average revenue");
  assert.equal(avg.args?.['aggregate'], 'avg');
  assert.equal(avg.args?.['filters'], undefined, '"an average" is an article, not the rep');
});

test('"an" that could be either is asked about, and the answer decides', () => {
  salesListed();
  const ask = plan('an sold how much');
  assert.equal(ask.tool, undefined);
  assert.equal(ask.speak, 'Do you mean the Rep An? Say yes or no.');
  assert.deepEqual(plan('yes').args?.['filters'], [{ column: 'Rep', op: 'eq', value: 'An' }]);

  plan('an sold how much');
  const no = plan('no');
  assert.equal(no.tool, 'table_query');
  assert.equal(no.args?.['filters'], undefined);
});

test('a department called IT is found as "IT" or beside its column, never as the pronoun', () => {
  salesOpen();
  context.columns = [
    { name: 'Department', header_path: ['Department'], type: 'category', non_empty: 6, distinct: 3, categories: ['Design', 'IT', 'Sales'] },
    { name: 'Amount', header_path: ['Amount'], type: 'number', non_empty: 6, distinct: 6, min: 1, max: 6, sum: 21 },
  ];
  const it = [{ column: 'Department', op: 'eq', value: 'IT' }];
  assert.deepEqual(plan('what is the total for IT').args?.['filters'], it);
  assert.deepEqual(plan('total amount for the it department').args?.['filters'], it);
  assert.equal(plan('how much did it cost').args?.['filters'], undefined);
  assert.equal(plan('what is the total for it').args?.['filters'], undefined);
});

const TASKS = [
  { name: 'Task', header_path: ['Task'], type: 'text', non_empty: 10, distinct: 10 },
  { name: 'Priority', header_path: ['Priority'], type: 'category', non_empty: 10, distinct: 4, categories: ['High', 'Low', 'Medium', 'Top'] },
  { name: 'Status', header_path: ['Status'], type: 'category', non_empty: 10, distinct: 3, categories: ['Closed', 'On hold', 'Open'] },
  { name: 'Paid', header_path: ['Paid'], type: 'category', non_empty: 10, distinct: 2, categories: ['No', 'Yes'] },
  { name: 'Hours', header_path: ['Hours'], type: 'number', non_empty: 10, distinct: 8, min: 1, max: 10, sum: 55 },
];

test('ordinary values of status and priority columns are filters, not filler', () => {
  salesOpen();
  context.columns = structuredClone(TASKS);
  const filterOf = (said: string): unknown => plan(said).args?.['filters'];
  assert.deepEqual(filterOf('how many are high priority'), [{ column: 'Priority', op: 'eq', value: 'High' }]);
  assert.deepEqual(filterOf('how many are low'), [{ column: 'Priority', op: 'eq', value: 'Low' }]);
  assert.deepEqual(filterOf('how many are open'), [{ column: 'Status', op: 'eq', value: 'Open' }]);
  assert.deepEqual(filterOf('how many are on hold'), [{ column: 'Status', op: 'eq', value: 'On hold' }]);
  assert.deepEqual(filterOf('total hours where paid is no'), [{ column: 'Paid', op: 'eq', value: 'No' }]);
  assert.deepEqual(filterOf('total hours for high priority tasks that are open'), [
    { column: 'Priority', op: 'eq', value: 'High' },
    { column: 'Status', op: 'eq', value: 'Open' },
  ]);

  // A value that is also an asking word names the value, and the rest still asks.
  const top = plan('how many are top priority');
  assert.equal(top.args?.['aggregate'], 'count');
  assert.deepEqual(top.args?.['filters'], [{ column: 'Priority', op: 'eq', value: 'Top' }]);
  const most = plan('what are the most hours');
  assert.equal(most.args?.['aggregate'], 'max');
  assert.equal(most.args?.['filters'], undefined, '"most" asks; it is not a value here');
});

test('a value inside a longer one said as a phrase is the longer one', () => {
  salesOpen();
  context.columns = [
    { name: 'Region', header_path: ['Region'], type: 'category', non_empty: 12, distinct: 4, categories: ['West', 'North West', 'North', 'East'] },
    { name: 'Revenue', header_path: ['Revenue'], type: 'number', non_empty: 12, distinct: 12, min: 1, max: 9, sum: 50 },
  ];
  // It used to count as North, West and North West at once — "several values" — and
  // answered with every region.
  const p = plan('total revenue for north west');
  assert.deepEqual(p.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'North West' }]);
  assert.equal(p.args?.['group_by'], undefined);
  assert.equal(plan('total revenue for north and west').args?.['group_by'], 'Region', 'two values said apart are two');
});

// ── what the question asks for ──────────────────────────────────────────────

test('a named column that is not a number is sent as named, not swapped for the only number', () => {
  salesListed();
  // With one number column, "what is the highest closed" answered the highest Revenue.
  for (const [said, column] of [
    ['what is the highest closed', 'Closed'],
    ['total rep', 'Rep'],
    ['what is the highest region', 'Region'],
  ] as const) {
    assert.equal(plan(said).args?.['aggregate_column'], column, said);
  }
  // Naming the column a filter is on is not naming a measure.
  const north = plan('what is the total for the north region');
  assert.equal(north.args?.['aggregate_column'], 'Revenue');
  assert.deepEqual(north.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'North' }]);
});

test('"which rep has the lowest" asks for the lowest row; a repeating group is asked lowest first', () => {
  salesListed();
  // One row per rep: the lowest row is the answer, and the server names it.
  const rep = plan('which rep has the lowest revenue');
  assert.equal(rep.args?.['aggregate'], 'min');
  assert.equal(rep.args?.['group_by'], undefined);
  assert.equal(rep.args?.['limit'], undefined);

  // Regions repeat: each region's total, asked for lowest first, so the answer starts
  // with the lowest however many regions there are. Largest first, it came last, and
  // past a page of groups not at all.
  const region = plan('which region has the lowest revenue');
  assert.equal(region.args?.['group_by'], 'Region');
  assert.equal(region.args?.['order'], 'asc');
  assert.equal(region.args?.['limit'], undefined, 'a limit past one page skipped the groups the word budget cut');
  assert.equal(region.announce, undefined, 'the order is said by the server, not announced');

  // "Highest" is the server's default order and is not asked for.
  assert.equal(plan('which region has the highest revenue').args?.['order'], undefined);
});

test('a number and a value with no aggregate word is a question, not a request to describe', () => {
  salesListed();
  const p = plan('what is the revenue for north');
  assert.equal(p.tool, 'table_query');
  assert.equal(p.args?.['aggregate'], 'sum');
  assert.deepEqual(p.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'North' }]);

  absorb('table_query', p.args, { table_id: 'sales', answer_id: 'a1', result: 20550 });
  const next = plan('what about south');
  assert.equal(next.args?.['aggregate_column'], 'Revenue');
  assert.deepEqual(next.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'South' }]);
});

// ── tables inside a file ────────────────────────────────────────────────────

const MIXED_REGIONS = [
  { n: 1, id: 'mixed.t1', sheet: 'Mixed', title: null, row_count: 2, columns: ['Product', 'Units'] },
  { n: 2, id: 'mixed.t2', sheet: 'Mixed', title: null, row_count: 2, columns: ['Region', 'Target', 'Actual'] },
];

test('"table 2" opens the second table of the file, and later calls stay in it', () => {
  resetContext();
  context.tables = [{ table_id: 'mixed', title: 'Three regions', sheets: ['Mixed'] }];
  context.tableId = 'mixed';
  context.chosen = true;
  absorb(
    'table_describe',
    { table_id: 'mixed' },
    {
      table_id: 'mixed',
      table_number: 1,
      columns: [
        { name: 'Product', type: 'text', non_empty: 2, distinct: 2 },
        { name: 'Units', type: 'number', non_empty: 2, distinct: 2, min: 45, max: 120, sum: 165 },
      ],
      regions: MIXED_REGIONS,
    },
  );

  // Describe ends 'Say "table 2" to open one', and saying it described table 1 again.
  const open = plan('table 2');
  assert.equal(open.tool, 'table_describe');
  assert.equal(open.args?.['sheet'], 'mixed.t2');
  absorb('table_describe', open.args, {
    table_id: 'mixed',
    table_number: 2,
    columns: [
      { name: 'Region', type: 'text', non_empty: 2, distinct: 2 },
      { name: 'Target', type: 'number', non_empty: 2, distinct: 2, min: 9000, max: 10000, sum: 19000 },
      { name: 'Actual', type: 'number', non_empty: 2, distinct: 2, min: 3900, max: 12400, sum: 16300 },
    ],
    regions: MIXED_REGIONS,
  });

  const compare = plan('compare target and actual');
  assert.equal(compare.tool, 'table_compare');
  assert.equal(compare.args?.['sheet'], 'mixed.t2');
  assert.equal(plan('total target').args?.['sheet'], 'mixed.t2');

  const back = plan('table 1');
  assert.equal(back.tool, 'table_describe');
  assert.equal(back.args?.['sheet'], undefined, 'the first table is the one with no sheet named');
});

test('"table 2" is left alone when the server listed no tables inside the file', () => {
  salesOpen();
  const p = plan('table 2');
  assert.equal(p.tool, 'table_describe');
  assert.equal(p.args?.['sheet'], undefined);
});

// ── confirming, and correcting, a reading ───────────────────────────────────

test('only a plain yes confirms the reported reading', () => {
  const inspected = (): void => {
    salesOpen();
    absorb('table_structure', { table_id: 'sales' }, { table_id: 'sales', header_rows: 2, ambiguous: true });
  };
  inspected();
  assert.equal(plan('right, what is the total revenue').tool, 'table_query', 'a question after "right" is a question');

  inspected();
  assert.equal(plan('sure, use the first row as headings').args?.['header_rows'], 1);

  inspected();
  assert.equal(plan('correct the headings').args?.['header_rows'], undefined, 'asking to correct is not confirming');

  inspected();
  assert.equal(plan('yes please').args?.['header_rows'], 2);
});

test('more ways of saying how many rows are headings', () => {
  for (const [said, n] of [
    ['use the first row as headings', 1],
    ['use the first row as labels', 1],
    ['the top row is the heading', 1],
    ['the top two rows are headings', 2],
    ['the first 2 rows are the headers', 2],
    ['the headings are in the first two rows', 2],
    ['row one is data', 0],
    ['row 1 is just data', 0],
  ] as const) {
    salesOpen();
    assert.equal(plan(said).args?.['header_rows'], n, said);
  }
});

// ── asking back ─────────────────────────────────────────────────────────────

test('a new request is not taken as the answer to "Which file?"', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales';
  assert.match(plan('what is the total revenue').speak ?? '', /^Which file\?/);
  // It names a file, but it asks for that file's contents; the old question is dropped.
  const p = plan("what's in the budget file");
  assert.equal(p.tool, 'table_describe');
  assert.equal(p.args?.['table_id'], 'budget');
  assert.equal(p.then, undefined);
  assert.equal(context.pending, null);
});

test('"Which file?" names the column by its own name', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'sales';
  assert.equal(plan('how many regions').speak, 'Which file? Region is in Sales and Quarters.');
});

test('a reply that narrows the choice keeps the question and asks again', () => {
  resetContext();
  context.tables = structuredClone(CATALOGUE);
  context.tableId = 'quarters';
  context.chosen = true;
  const rev = (y: string, q: string): Record<string, unknown> => ({
    name: `${y}, ${q}, Revenue`,
    header_path: [y, q, 'Revenue'],
    type: 'number',
    non_empty: 2,
    distinct: 2,
    min: 1,
    max: 2,
    sum: 3,
  });
  context.columns = [
    { name: 'Region', header_path: ['Region'], type: 'text', non_empty: 2, distinct: 2 },
    rev('2026', 'Q1'),
    rev('2026', 'Q2'),
    rev('2025', 'Q1'),
    rev('2025', 'Q2'),
  ];
  assert.match(plan('total revenue').speak ?? '', /^Which one: 2026 Q1 Revenue, /);
  assert.equal(plan('2026').speak, 'Which one: 2026 Q1 Revenue or 2026 Q2 Revenue?');
  assert.equal(plan('q2').args?.['aggregate_column'], '2026, Q2, Revenue');
});

test('values of a column with no noun form are called its values', () => {
  salesOpen();
  context.columns = [
    { name: 'column 2', header_path: [], type: 'category', non_empty: 6, distinct: 3, categories: ['High', 'Low', 'Medium'] },
    { name: 'column 3', header_path: [], type: 'number', non_empty: 6, distinct: 6, min: 1, max: 6, sum: 21 },
  ];
  assert.equal(
    plan('total for hihg').speak,
    'I could not find "hihg" in this table. The values of column 2 are High, Low and Medium.',
  );
});

// ── listing ─────────────────────────────────────────────────────────────────

test('"list" reaches the rows, and only "list my files" reaches the files', () => {
  salesListed();
  assert.equal(plan('list the rows').tool, 'table_read_rows');
  assert.equal(plan('list my files').tool, 'table_list');
  assert.equal(plan('what do I have').tool, 'table_list');
  const p = plan('list the reps in the north');
  assert.equal(p.tool, 'table_query');
  assert.equal(p.args?.['aggregate'], 'none');
  assert.deepEqual(p.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'North' }]);
});

// ── a yes-or-no column named on its own ─────────────────────────────────────

const FLAGGED_TASKS = [
  { name: 'Task', header_path: ['Task'], type: 'text', non_empty: 8, distinct: 8 },
  { name: 'Owner', header_path: ['Owner'], type: 'category', non_empty: 8, distinct: 3, categories: ['Linh', 'Mai', 'Tuan'] },
  { name: 'Hours', header_path: ['Hours'], type: 'number', non_empty: 8, distinct: 8, min: 1, max: 8, sum: 36 },
  { name: 'Paid', header_path: ['Paid'], type: 'boolean', non_empty: 8, distinct: 2, categories: ['No', 'Yes'] },
];

function flaggedTasksOpen(): void {
  resetContext();
  context.tables = [{ table_id: 'tasks', title: 'Tasks', sheets: ['Tasks'] }];
  context.tableId = 'tasks';
  context.chosen = true;
  context.columns = structuredClone(FLAGGED_TASKS);
}

test('a yes-or-no column said as a predicate is a filter on its answer', () => {
  // All of these counted or totalled every row: only "paid yes" used to filter.
  const cases: [string, string, string][] = [
    ['how many tasks are paid', 'eq', 'count'],
    ['total hours for paid tasks', 'eq', 'sum'],
    ['how many tasks are not paid', 'neq', 'count'],
    ['how many unpaid tasks', 'neq', 'count'],
    ["how many tasks haven't been paid", 'neq', 'count'],
    ['how many are paid yes', 'eq', 'count'],
  ];
  for (const [said, op, aggregate] of cases) {
    flaggedTasksOpen();
    const p = plan(said);
    assert.equal(p.tool, 'table_query', `${said}: ${p.speak ?? ''}`);
    assert.deepEqual(p.args?.['filters'], [{ column: 'Paid', op, value: 'Yes' }], said);
    assert.equal(p.args?.['aggregate'], aggregate, said);
  }
  // Grouped by, it is what to group by, not a condition.
  flaggedTasksOpen();
  const by = plan('hours by paid');
  assert.equal(by.args?.['group_by'], 'Paid');
  assert.equal(by.args?.['filters'], undefined);
});
