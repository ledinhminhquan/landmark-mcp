/**
 * Golden tests over the six fixtures.
 *
 * These lock the milestone that matters: every cell resolves to a correct header
 * path. Structure inference is heuristic, so a change that improves one shape can
 * silently break another — that already happened once during the build, when a fix
 * for merged headers regressed the stacked-header case. These assertions are the
 * guard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildTable } from '../src/ingest/build.ts';
import type { IndexRegion, IndexTable } from '../src/indexfmt.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = async (name: string): Promise<IndexTable> =>
  buildTable(await readSpreadsheet(join(FIX, name)));
const paths = (r: IndexRegion): string[][] => r.columns.map((c) => [...c.path]);
const kinds = (r: IndexRegion): string[] => r.columns.map((c) => c.kind);

test('01 flat — one header row, types inferred per column', async () => {
  const t = await load('01-flat.xlsx');
  assert.equal(t.regions.length, 1);
  const r = t.regions[0]!;
  assert.equal(r.rowCount, 5);
  assert.deepEqual(paths(r), [['Region'], ['Rep'], ['Revenue'], ['Closed']]);
  assert.deepEqual(kinds(r), ['text', 'text', 'number', 'date']);
  assert.equal(r.columns[2]!.sum, 61050);
  assert.equal(r.inherited.length, 0, 'nothing merged in this fixture');
});

test('02 stacked header — two label rows, no merges, no type discontinuity', async () => {
  const t = await load('02-stacked-header.xlsx');
  const r = t.regions[0]!;
  assert.equal(r.headerRows.length, 2, 'the measure row must not be read as data');
  assert.equal(r.rowCount, 3);
  assert.deepEqual(paths(r), [
    ['Region'],
    ['Q1', 'Revenue'],
    ['Q2', 'Revenue'],
    ['Q3', 'Revenue'],
  ]);
  assert.deepEqual(kinds(r), ['text', 'number', 'number', 'number'], 'not "mixed"');
});

test('03 merged header — four columns labelled "Revenue" become four distinct paths', async () => {
  const t = await load('03-merged-header.xlsx');
  const r = t.regions[0]!;
  assert.equal(r.headerRows.length, 3);
  assert.deepEqual(paths(r), [
    ['Region'],
    ['2026', 'Q1', 'Revenue'],
    ['2026', 'Q2', 'Revenue'],
    ['2025', 'Q1', 'Revenue'],
    ['2025', 'Q2', 'Revenue'],
  ]);
  assert.deepEqual(r.ambiguousColumns, [], 'the paths disambiguate what the labels do not');
  assert.equal(r.columns[1]!.spoken, '2026, Q1, Revenue');
});

test('04 title row and vertical merge — the case a literal read gets wrong', async () => {
  const t = await load('04-title-and-vmerge.xlsx');
  const r = t.regions[0]!;
  assert.equal(r.title, 'FY2026 Departmental Budget', 'title consumed, not read as a header');
  assert.deepEqual(paths(r), [['Department'], ['Line item'], ['Amount']]);
  assert.equal(r.rowCount, 5);

  // The merges are A3:A5 (Engineering) and A6:A7 (Design). Rows 2..5 of the data
  // hold nothing in column A in the file; resolved, they carry their department.
  const deptColumn = r.rows.map((row) => row[0]);
  assert.deepEqual(deptColumn, [
    'Engineering',
    'Engineering',
    'Engineering',
    'Design',
    'Design',
  ]);
  assert.equal(r.columns[0]!.empty, 0, 'no phantom gaps once merges are resolved');
  assert.equal(r.inherited.length, 3, 'and we recorded which three were inherited');
  assert.deepEqual(r.inherited[0], { at: 'A4', from: 'A3' });
  assert.equal(r.columns[2]!.sum, 794000);
});

test('05 three regions on one sheet are kept separate', async () => {
  const t = await load('05-three-regions.xlsx');
  assert.equal(t.regions.length, 3);
  assert.deepEqual(paths(t.regions[0]!), [['Product'], ['Units']]);
  assert.deepEqual(paths(t.regions[1]!), [['Region'], ['Target'], ['Actual']]);
  assert.deepEqual(paths(t.regions[2]!), [['Note'], ['Status']]);
  assert.ok(
    t.warnings.some((w) => /3 separate tables/.test(w)),
    'and the ambiguity is surfaced rather than silently resolved',
  );
});

test('06 csv — delimited path, and a trailing note is not swallowed into the table', async () => {
  const t = await load('06-countries.csv');
  assert.equal(t.format, 'csv');
  const main = t.regions[0]!;
  assert.deepEqual(paths(main), [['Country'], ['Population'], ['GDP per capita (USD)'], ['Region']]);
  assert.equal(main.rowCount, 8, 'the source note below the blank line is not a data row');
  assert.equal(main.columns[1]!.kind, 'number');
  assert.equal(main.columns[3]!.kind, 'category');
  // The note used to become a one-cell "table", so this file announced itself as
  // holding two separate tables. It is kept, as a note, where describe reports it.
  assert.equal(t.regions.length, 1, 'a source line is a note, not a second table');
  assert.ok(!t.warnings.some((w) => /separate tables/.test(w)));
  assert.ok(t.warnings.some((w) => /Source: illustrative figures for testing only/.test(w)));
});

test('every column in every fixture is speakable', async () => {
  for (const name of [
    '01-flat.xlsx',
    '02-stacked-header.xlsx',
    '03-merged-header.xlsx',
    '04-title-and-vmerge.xlsx',
    '05-three-regions.xlsx',
    '06-countries.csv',
  ]) {
    const t = await load(name);
    for (const r of t.regions) {
      for (const c of r.columns) {
        assert.ok(c.spoken.length > 0, `${name} ${r.id} column ${c.i} has no spoken name`);
        assert.ok(!/^\s*$/.test(c.spoken), `${name} ${r.id} column ${c.i} speaks as whitespace`);
        assert.ok(!/undefined|null|NaN|\[object/.test(c.spoken), `${name} leaked a JS artefact: ${c.spoken}`);
      }
    }
  }
});

test('a row label is nominated wherever one is available', async () => {
  const flat = (await load('01-flat.xlsx')).regions[0]!;
  assert.equal(flat.labelColumn, 1, 'Rep is near-unique; Region repeats');

  const budget = (await load('04-title-and-vmerge.xlsx')).regions[0]!;
  assert.equal(budget.labelColumn, 1, 'Line item identifies a row; Department groups them');
});
