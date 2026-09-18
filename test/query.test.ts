import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildTable } from '../src/ingest/build.ts';
import { QueryError, resolveColumn, rowLabel, runQuery } from '../src/query/engine.ts';
import {
  capWords,
  speakCell,
  speakDescribe,
  speakError,
  speakExplain,
  speakName,
  speakNumber,
  speakQuery,
  wordCount,
  HEADLINE_WORD_LIMIT,
  SPOKEN_WORD_LIMIT,
} from '../src/voice/speak.ts';
import type { IndexRegion } from '../src/indexfmt.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const region = async (file: string, i = 0): Promise<IndexRegion> =>
  (await buildTable(await readSpreadsheet(join(FIX, file)))).regions[i]!;

// ── filtering and aggregation ───────────────────────────────────────────────

test('totals a column and reports how many rows it actually read', async () => {
  const r = await region('01-flat.xlsx');
  const q = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Revenue' });
  assert.equal(q.result, 61050);
  assert.equal(q.matchedRows, 5);
  assert.equal(q.provenance.cellCount, 5);
  assert.deepEqual(q.provenance.cells, ['C2', 'C3', 'C4', 'C5', 'C6']);
  assert.equal(q.provenance.sheet, 'Sales');
});

test('filters numerically, not lexically', async () => {
  const r = await region('01-flat.xlsx');
  // A string comparison would put "8150" above "21000".
  const q = runQuery(r, {
    filters: [{ column: 'Revenue', op: 'gt', value: '10000' }],
    aggregate: 'count',
  });
  assert.equal(q.result, 3, '12400, 21000 and 15600');
});

test('counts and averages agree with the rows they came from', async () => {
  const r = await region('01-flat.xlsx');
  const north = { column: 'Region', op: 'eq' as const, value: 'north' };
  assert.equal(runQuery(r, { filters: [north], aggregate: 'count' }).result, 2);
  const avg = runQuery(r, { filters: [north], aggregate: 'avg', aggregateColumn: 'Revenue' });
  assert.equal(avg.result, (12400 + 8150) / 2);
});

test('groups, orders by value, and paginates', async () => {
  const r = await region('01-flat.xlsx');
  const q = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Revenue', groupBy: 'Region', limit: 2 });
  assert.equal(q.groups.length, 2);
  assert.deepEqual(
    q.groups.map((g) => g.key),
    ['South', 'North'],
    'largest first: South 24900, North 20550, East 15600',
  );
  assert.equal(q.groups[0]!.value, 24900);
  assert.equal(q.moreAvailable, true);
  assert.equal(q.nextOffset, 2);
});

test('excluded cells are accounted for, not silently dropped', async () => {
  const r = await region('01-flat.xlsx');
  const holed: IndexRegion = {
    ...r,
    rows: [
      ['North', 'Anh', 12400, '2026-07-04'],
      ['North', 'Bảo', null, '2026-07-19'],
      ['South', 'Chi', 'n/a', '2026-08-02'],
    ],
    rowCount: 3,
  };
  const q = runQuery(holed, { aggregate: 'sum', aggregateColumn: 'Revenue' });
  assert.equal(q.result, 12400);
  assert.equal(q.matchedRows, 3, 'three rows matched the (absent) filters');
  assert.equal(q.provenance.cellCount, 1, 'but only one contributed');
  assert.equal(q.provenance.excluded.length, 2);
  assert.deepEqual(q.provenance.excluded[0], { address: 'C3', reason: 'empty' });
  assert.match(q.provenance.excluded[1]!.reason, /not a number/);
});

test('a merged label is filterable, which is the whole point of resolving it', async () => {
  const r = await region('04-title-and-vmerge.xlsx');
  const q = runQuery(r, {
    filters: [{ column: 'Department', op: 'eq', value: 'Engineering' }],
    aggregate: 'sum',
    aggregateColumn: 'Amount',
  });
  assert.equal(q.result, 480000 + 62000 + 18000);
  assert.equal(q.provenance.cellCount, 3, 'including the two rows that are blank in the file');
});

test('a full header path resolves, and so does its leaf when unambiguous', async () => {
  const r = await region('03-merged-header.xlsx');
  assert.equal(resolveColumn(r, '2026, Q2, Revenue').i, 2);
  assert.equal(resolveColumn(r, 'Region').i, 0);
  assert.throws(
    () => resolveColumn(r, 'Revenue'),
    (e: unknown) => e instanceof QueryError && /ambiguous|matches/.test((e as Error).message),
    'four columns are called Revenue; guessing one would be wrong',
  );
});

test('an unknown column names the real ones rather than failing blankly', async () => {
  const r = await region('01-flat.xlsx');
  try {
    resolveColumn(r, 'Profit');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof QueryError);
    assert.match(e.nextStep, /Region.*Rep.*Revenue.*Closed/);
  }
});

test('refuses to total a non-numeric column and says which ones it can', async () => {
  const r = await region('01-flat.xlsx');
  try {
    runQuery(r, { aggregate: 'sum', aggregateColumn: 'Rep' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof QueryError);
    assert.match(e.message, /cannot be totalled/);
    assert.match(e.nextStep, /Revenue/);
  }
});

test('row labels come from the nominated column', async () => {
  const r = await region('01-flat.xlsx');
  assert.equal(rowLabel(r, 0), 'Anh');
  assert.equal(rowLabel(r, 3), 'Dũng');
});

// ── speech ──────────────────────────────────────────────────────────────────

test('numbers are spoken at a scale a listener can hold', () => {
  assert.equal(speakNumber(4238914), '4.2 million');
  assert.equal(speakNumber(61050), '61.1 thousand');
  assert.equal(speakNumber(9500), '9500');
  assert.equal(speakNumber(-1250000), 'minus 1.3 million');
  assert.equal(speakNumber(0.5), '0.5');
  assert.equal(speakNumber(45, 'percent'), '45%');
});

test('spoken summaries stay inside the voice budget', async () => {
  for (const f of ['01-flat.xlsx', '03-merged-header.xlsx', '04-title-and-vmerge.xlsx']) {
    const r = await region(f);
    const brief = speakDescribe(r, false);
    const full = speakDescribe(r, true);
    assert.ok(wordCount(brief) <= HEADLINE_WORD_LIMIT + 20, `${f} brief: ${wordCount(brief)} words`);
    assert.ok(wordCount(full) <= SPOKEN_WORD_LIMIT, `${f} full: ${wordCount(full)} words`);
    assert.ok(!/undefined|NaN|\[object/.test(full), `${f} leaked an artefact: ${full}`);
  }
});

test('a total is spoken with its provenance built in', async () => {
  const r = await region('01-flat.xlsx');
  const q = runQuery(r, { aggregate: 'sum', aggregateColumn: 'Revenue' });
  const said = speakQuery(r, { aggregate: 'sum', aggregateColumn: 'Revenue' }, r.columns[2]!, q);
  assert.match(said, /61\.1 thousand/);
  assert.match(said, /total of Revenue across 5 rows/);
});

test('skipped rows are said out loud, because a silent total is a wrong total', async () => {
  const r = await region('01-flat.xlsx');
  const holed: IndexRegion = {
    ...r,
    rows: [['North', 'Anh', 12400, null], ['North', 'Bảo', null, null]],
    rowCount: 2,
  };
  const q = runQuery(holed, { aggregate: 'sum', aggregateColumn: 'Revenue' });
  const said = speakQuery(holed, { aggregate: 'sum', aggregateColumn: 'Revenue' }, holed.columns[2]!, q);
  assert.match(said, /skipped 1 row/);
  assert.match(said, /empty/);
});

test('describe warns that merge-labelled cells are not the blanks they look like', async () => {
  const r = await region('04-title-and-vmerge.xlsx');
  assert.match(speakDescribe(r, false), /merged block/);
});

test('errors never leak tool names or identifiers into speech', () => {
  const said = speakError(
    'Table `table_query` failed: no column matched, table_id was bad.',
    'Call `table_describe` first to get the exact column names.',
  );
  assert.ok(!/table_query|table_describe|table_id|`/.test(said), said);
  assert.match(said, /identifier|that/);
});

test('capWords cuts at a sentence boundary rather than mid-clause', () => {
  const text = 'One two three. Four five six seven eight nine ten eleven twelve.';
  const cut = capWords(text, 5);
  assert.equal(cut, 'One two three.');
  assert.ok(wordCount(cut) <= 5);
});

// ── heard, not read ─────────────────────────────────────────────────────────
//
// Three defects found by listening to the deployed client rather than by reading
// its output. Each was invisible in a transcript and obvious in the ear.

test('a numeric column that arrived as text is still spoken as a number', () => {
  // A CSV has no types. Inference correctly calls this column numbers, but the cell
  // holds the string "100352192" — read as text that is nine digits in a row, which
  // is the exact experience this tool exists to replace.
  assert.equal(speakCell('100352192', 'number'), '100.4 million');
  assert.equal(speakCell(100352192, 'number'), '100.4 million');
  assert.equal(speakCell('4347', 'number'), '4347');
  // Currency reads as a bare number on purpose: SYMBOL.currency is empty because the
  // unit is ambiguous across the locales these files come from.
  assert.equal(speakCell('$1,200', 'currency'), '1200');

  // Text columns are left alone: a postcode or an order number is not a quantity.
  assert.equal(speakCell('100352192', 'text'), '100352192');
  assert.equal(speakCell('not a number at all', 'number'), 'not a number at all');
  assert.equal(speakCell('', 'number'), 'empty');
});

test('a stacked column name does not collide with the commas between columns', async () => {
  // Stored as an identifier the client sends back verbatim; spoken as a phrase.
  assert.equal(speakName('2026, Q2, Revenue'), '2026 Q2 Revenue');
  assert.equal(speakName('Revenue'), 'Revenue');

  const said = speakDescribe(await region('03-merged-header.xlsx'), false);
  // The comma after each Revenue is the separator between columns and belongs there.
  // What must be gone are the commas *inside* a name, which sounded identical.
  assert.ok(
    !/2026, Q1/.test(said),
    `a column name still reads as a comma-separated list: ${said}`,
  );
  assert.match(said, /2026 Q1 Revenue/);
});

test('explain puts a full stop between the source and what it was', () => {
  const said = speakExplain([
    { label: '', tableId: 't', regionId: 'r', sheet: 'Budget', cells: ['C3', 'C4', 'C5'], cellCount: 3, excluded: [], path: ['Amount'] },
  ]);
  // It read "...on Budget Each one is Amount." — one sentence with no join, which a
  // synthesiser runs together without a pause.
  assert.ok(!/Budget Each/.test(said), `missing full stop: ${said}`);
  assert.match(said, /on Budget\. Each one is Amount\./);
});
