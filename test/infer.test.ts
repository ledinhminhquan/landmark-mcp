import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asNumber,
  asDate,
  buildRegion,
  describeRegion,
  detectRegions,
  profileColumn,
  scoreHeaderRow,
  type Grid,
} from '../src/table/infer.ts';
import { toSpokenName, type CellValue } from '../src/table/model.ts';

/**
 * A sheet shaped the way real ones are: a title, a header, data, a blank spacer,
 * then a second unrelated table. This layout is exactly what a screen reader
 * flattens into one undifferentiated stream.
 */
const SHEET: Grid = [
  ['Q3 Regional Sales', null, null, null],
  ['Region', 'Rep', 'Revenue', 'Closed'],
  ['North', 'Anh', '$12,400', '2026-07-04'],
  ['North', 'Bảo', '$8,150', '2026-07-19'],
  ['South', 'Anh', '$21,000', '2026-08-02'],
  ['South', 'Chi', '$3,900', '2026-08-27'],
  [null, null, null, null],
  ['Product', 'Units'],
  ['Widget', 120],
  ['Gadget', 45],
];

test('splits a sheet into independent table regions at blank rows', () => {
  const regions = detectRegions(SHEET);
  assert.equal(regions.length, 2, 'title+table and the second table are separate regions');
  assert.equal(regions[0]!.startRow, 0);
  assert.equal(regions[0]!.endRow, 5);
  assert.equal(regions[1]!.startRow, 7);
  assert.equal(regions[1]!.endRow, 9);
});

test('scores a real header row above a title row', () => {
  const header = scoreHeaderRow(
    ['Region', 'Rep', 'Revenue', 'Closed'],
    SHEET.slice(2, 6),
  );
  const title = scoreHeaderRow(
    ['Q3 Regional Sales', null, null, null],
    SHEET.slice(2, 6),
  );
  assert.ok(header > 0.5, `header should score above 0.5, got ${header.toFixed(2)}`);
  assert.ok(header > title, 'a header row must outscore a sparse title row');
});

test('profiles currency, category and date columns distinctly', () => {
  const rows = SHEET.slice(2, 6) as readonly (readonly CellValue[])[];
  const col = (i: number) => rows.map((r) => r[i] ?? null);

  const region = profileColumn(col(0), 'Region', 0, 0);
  assert.equal(region.kind, 'category');
  assert.deepEqual(region.categories, ['North', 'South']);

  const revenue = profileColumn(col(2), 'Revenue', 2, 2);
  assert.equal(revenue.kind, 'currency');
  assert.equal(revenue.numeric?.sum, 45450);
  assert.equal(revenue.numeric?.max, 21000);

  const closed = profileColumn(col(3), 'Closed', 3, 3);
  assert.equal(closed.kind, 'date');
});

test('counts gaps rather than silently dropping them', () => {
  const withHoles = profileColumn(['a', null, '', 'b'], 'Notes', 0, 0);
  assert.equal(withHoles.nonEmpty, 2);
  assert.equal(withHoles.empty, 2);
});

test('builds a region whose spoken description leads with size and columns', () => {
  const raw = detectRegions(SHEET)[0]!;
  // Row 0 is the title; the region proper starts at the header.
  const region = buildRegion(SHEET, { ...raw, startRow: 1 }, 'sheet1.table1', [], 'Q3 Regional Sales');

  assert.equal(region.headerRow, 1);
  assert.equal(region.rowCount, 4);
  assert.equal(region.columns.length, 4);
  assert.equal(region.columns[2]!.spokenName, 'Revenue');

  const spoken = describeRegion(region);
  assert.match(spoken, /4 rows and 4 columns/);
  assert.match(spoken, /Region, Rep, Revenue, Closed/);
  assert.match(spoken, /total or compare: Revenue/);
});

test('flags merged cells, whose covered rows are genuinely empty in the file', () => {
  const raw = detectRegions(SHEET)[0]!;
  const region = buildRegion(
    SHEET,
    { ...raw, startRow: 1 },
    'sheet1.table1',
    [{ value: 'North', topRow: 2, bottomRow: 3, leftCol: 0, rightCol: 0, a1: 'A3' }],
    null,
  );
  assert.equal(region.merges.length, 1);
  assert.match(describeRegion(region), /merged cell/);
  assert.match(describeRegion(region), /read as empty even though they are labelled/);
});

test('falls back to positional names for unspeakable headers', () => {
  assert.equal(toSpokenName('Unnamed: 3', 2), 'column 3');
  assert.equal(toSpokenName('', 0), 'column 1');
  assert.equal(toSpokenName('total_revenue_usd', 0), 'Total revenue usd');
  assert.equal(toSpokenName('ClosedDate', 0), 'Closed date');
});

test('number coercion handles separators, symbols and rejects non-numbers', () => {
  assert.equal(asNumber('$12,400'), 12400);
  assert.equal(asNumber('1 234,5'.replace(',', '.')), 1234.5);
  assert.equal(asNumber('45%'), 45);
  assert.equal(asNumber('N/A'), null);
  assert.equal(asNumber(''), null);
  assert.equal(asDate('2026-07-04')?.getUTCFullYear(), 2026);
  assert.equal(asDate('2026'), null, 'a bare year is a number, not a date');
});

test('a headerless region still reports itself usefully', () => {
  const grid: Grid = [
    [1, 2],
    [3, 4],
  ];
  const raw = detectRegions(grid)[0]!;
  const region = buildRegion(grid, raw, 'x.1', [], null);
  assert.equal(region.headerRow, null);
  assert.equal(region.rowCount, 2, 'no header means every row is data');
  assert.match(describeRegion(region), /could not find a header row/);
});
