import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHeaderPaths,
  detectHeaderRowCount,
  resolveMerges,
  speakPath,
  speakValue,
} from '../src/table/header.ts';
import type { Grid } from '../src/table/infer.ts';
import type { CellValue, MergeSpan } from '../src/table/model.ts';

/**
 * The shape this module exists for: two grouping rows above the real header, with
 * horizontal merges, so four different columns are all literally labelled "Revenue".
 *
 *          |        2026        |        2025
 *          |   Q1    |    Q2    |   Q1    |   Q2
 *   Region | Revenue | Revenue  | Revenue | Revenue
 */
const MULTI: Grid = [
  [null, '2026', null, '2025', null],
  [null, 'Q1', 'Q2', 'Q1', 'Q2'],
  ['Region', 'Revenue', 'Revenue', 'Revenue', 'Revenue'],
  ['North', 1200, 1400, 1100, 1000],
  ['South', 900, 950, 800, 850],
];

const MULTI_MERGES: MergeSpan[] = [
  { value: '2026', topRow: 0, bottomRow: 0, leftCol: 1, rightCol: 2, a1: 'B1' },
  { value: '2025', topRow: 0, bottomRow: 0, leftCol: 3, rightCol: 4, a1: 'D1' },
];

test('merge resolution fills a span from its anchor and records the origin', () => {
  const r = resolveMerges(MULTI, MULTI_MERGES);
  assert.equal(r.cells[0]![1], '2026');
  assert.equal(r.cells[0]![2], '2026', 'C1 is covered by the B1:C1 merge');
  assert.equal(r.origin[0]![1], 'literal');
  assert.equal(r.origin[0]![2], 'merge');
  assert.equal(r.anchor.get('C1'), 'B1', 'provenance points at the cell that holds the value');
});

test('merge resolution never overwrites a real value', () => {
  const grid: Grid = [['keep', 'existing']];
  const r = resolveMerges(grid, [
    { value: 'keep', topRow: 0, bottomRow: 0, leftCol: 0, rightCol: 1, a1: 'A1' },
  ]);
  assert.equal(r.cells[0]![1], 'existing');
  assert.equal(r.origin[0]![1], 'literal');
});

test('merge resolution is not a forward-fill — a genuinely empty cell stays empty', () => {
  const grid: Grid = [['North', null], ['South', null]];
  const r = resolveMerges(grid, []);
  assert.equal(r.cells[0]![1], null);
  assert.equal(r.cells[1]![0], 'South', 'no inventing values in unmerged gaps');
});

test('builds the full header path so four "Revenue" columns become distinguishable', () => {
  const resolved = resolveMerges(MULTI, MULTI_MERGES);
  const { paths, ambiguous } = buildHeaderPaths(resolved, [0, 1, 2], 0, 4);

  assert.deepEqual(paths[0], ['Region']);
  assert.deepEqual(paths[1], ['2026', 'Q1', 'Revenue']);
  assert.deepEqual(paths[2], ['2026', 'Q2', 'Revenue']);
  assert.deepEqual(paths[3], ['2025', 'Q1', 'Revenue']);
  assert.deepEqual(paths[4], ['2025', 'Q2', 'Revenue']);
  assert.deepEqual(ambiguous, [], 'the paths are now unique even though the labels are not');
});

test('reports ambiguity rather than hiding it', () => {
  const grid: Grid = [['Revenue', 'Revenue'], [1, 2]];
  const resolved = resolveMerges(grid, []);
  const { ambiguous } = buildHeaderPaths(resolved, [0], 0, 1);
  assert.deepEqual(ambiguous, [0, 1], 'two identically-labelled columns must be flagged');
});

test('skips blank levels instead of emitting gaps in the spoken path', () => {
  const grid: Grid = [[null, 'Total'], ['Region', 'Revenue'], ['North', 5]];
  const resolved = resolveMerges(grid, []);
  const { paths } = buildHeaderPaths(resolved, [0, 1], 0, 1);
  assert.deepEqual(paths[0], ['Region'], 'no empty string from the blank level above');
  assert.deepEqual(paths[1], ['Total', 'Revenue']);
});

test('collapses a label repeated down levels by a merge', () => {
  const grid: Grid = [['2026'], ['2026'], [5]];
  const resolved = resolveMerges(grid, []);
  const { paths } = buildHeaderPaths(resolved, [0, 1], 0, 0);
  assert.deepEqual(paths[0], ['2026'], 'saying "2026, 2026" aloud helps nobody');
});

test('detects the two grouping rows above the real header', () => {
  const resolved = resolveMerges(MULTI, MULTI_MERGES);
  const n = detectHeaderRowCount(resolved, 0, 4, 0, 4);
  assert.equal(n, 3, 'year row, quarter row, and the measure row');
});

test('a plain single-header table is not over-read as multi-level', () => {
  const grid: Grid = [['Region', 'Revenue'], ['North', 10], ['South', 20]];
  const resolved = resolveMerges(grid, []);
  assert.equal(detectHeaderRowCount(resolved, 0, 2, 0, 1), 1);
});

test('speaks a value with its full identity and flags inherited labels', () => {
  assert.equal(speakPath(['2026', 'Q2', 'Revenue']), '2026, Q2, Revenue');
  assert.equal(speakPath([]), 'an unlabelled column');

  assert.equal(
    speakValue(['2026', 'Q2', 'Revenue'], 'North', 1400),
    '2026, Q2, Revenue for North: 1400',
  );
  assert.equal(
    speakValue(['Region'], null, 'North', 'merge'),
    'Region: North (inherited from a merged label)',
  );
  assert.equal(speakValue(['Notes'], 'South', null), 'Notes for South: empty');
});

test('the merged-label case that a literal read reports as an empty cell', () => {
  // A3:A4 merged on "North": row 4 has no value of its own in the file.
  const grid: Grid = [
    ['Region', 'Rep', 'Revenue'],
    ['North', 'Anh', 12400],
    [null, 'Bảo', 8150],
  ];
  const merges: MergeSpan[] = [
    { value: 'North', topRow: 1, bottomRow: 2, leftCol: 0, rightCol: 0, a1: 'A2' },
  ];

  const naive = grid[2]![0] as CellValue;
  assert.equal(naive, null, 'reading the file literally yields nothing for row 3');

  const resolved = resolveMerges(grid, merges);
  assert.equal(resolved.cells[2]![0], 'North', 'resolved, the row is labelled');
  assert.equal(resolved.origin[2]![0], 'merge');
  assert.equal(resolved.anchor.get('A3'), 'A2', 'and we can say where that came from');
});
