/**
 * Turning a region's rows into named columns, for a given reading of its structure.
 *
 * This exists as its own module because the same computation has to run in two
 * places, and they must not drift apart. Ingest runs it once offline to produce the
 * default reading. The server runs it again whenever someone corrects that reading
 * out loud — "no, the first row is data" — and the corrected answer has to be built
 * by the same code that built the original, or the correction becomes its own class
 * of bug.
 *
 * It works on the region's rows as stored: merge-resolved, region-sliced, with the
 * header rows still attached. Keeping the header rows in the index is what makes a
 * correction possible at all; a region stored with its headers already stripped
 * cannot be re-read without the source file, which the Worker does not have.
 */

import { columnLetter, toSpokenName, type CellValue } from './model.ts';
import { profileColumn } from './infer.ts';
import type { IndexColumn } from '../indexfmt.ts';

type Json = string | number | boolean | null;

export interface Materialised {
  /** Absolute sheet row indices consumed as header, in order. Empty if headerless. */
  readonly headerRows: readonly number[];
  /** Absolute sheet row index of the first data row. */
  readonly firstDataRow: number;
  readonly columns: readonly IndexColumn[];
  readonly rows: readonly (readonly Json[])[];
  readonly labelColumn: number | null;
  readonly ambiguousColumns: readonly number[];
}

/**
 * Which column identifies a row when speaking it?
 *
 * "Revenue for North" needs "North" to come from somewhere. Prefer a leftmost column
 * that is text-like and close to unique — that is what an identifier looks like. A
 * category column is the fallback: less precise, but "Revenue for the South region"
 * still beats "Revenue for row 14".
 */
function pickLabelColumn(columns: readonly IndexColumn[], rowCount: number): number | null {
  const usable = columns.filter((c) => c.kind === 'text' || c.kind === 'category');
  if (usable.length === 0) return null;
  const identifier = usable.find((c) => rowCount > 0 && c.distinct / rowCount >= 0.8);
  return (identifier ?? usable[0])!.i;
}

/**
 * Build each column's heading path from the chosen header rows.
 *
 * Blank levels are skipped rather than emitted, and a label repeated down levels by
 * a merge is collapsed, so "2026, 2026, Revenue" never reaches a speaker.
 */
function headerPaths(
  headerBlock: readonly (readonly Json[])[],
  width: number,
): { paths: string[][]; ambiguous: number[] } {
  const paths: string[][] = [];
  for (let c = 0; c < width; c++) {
    const path: string[] = [];
    for (const row of headerBlock) {
      const v = row[c] ?? null;
      if (v === null || (typeof v === 'string' && v.trim() === '')) continue;
      const text = String(v).trim();
      if (path[path.length - 1] === text) continue;
      path.push(text);
    }
    paths.push(path);
  }

  const seen = new Map<string, number[]>();
  paths.forEach((p, i) => {
    const key = p.join(' › ').toLowerCase();
    if (!key) return;
    const list = seen.get(key);
    if (list) list.push(i);
    else seen.set(key, [i]);
  });
  const ambiguous = [...seen.values()]
    .filter((l) => l.length > 1)
    .flat()
    .sort((a, b) => a - b);

  return { paths, ambiguous };
}

/**
 * Read `allRows` under one interpretation of where the header stops.
 *
 * `headerRowCount` of 0 means the region has no header; every row is data and the
 * columns are named by position. Anything larger than the region has rows is clamped
 * rather than throwing — a caller correcting a structure out loud should get a
 * sensible answer, not an error about bounds.
 */
export function materialise(
  allRows: readonly (readonly Json[])[],
  regionStartRow: number,
  firstCol: number,
  headerRowCount: number,
): Materialised {
  const width = allRows.reduce((w, r) => Math.max(w, r.length), 0);
  // Always leave at least one data row: a region that is entirely header is not a
  // reading anyone means, and silently producing zero records is the failure this
  // module was written to end.
  const headerCount = Math.max(0, Math.min(headerRowCount, Math.max(0, allRows.length - 1)));

  const headerBlock = allRows.slice(0, headerCount);
  const dataRows = allRows.slice(headerCount);
  const { paths, ambiguous } = headerPaths(headerBlock, width);

  const columns: IndexColumn[] = paths.map((path, i) => {
    const values = dataRows.map((row) => (row[i] ?? null) as CellValue);
    const leaf = path[path.length - 1] ?? '';
    const p = profileColumn(values, leaf, i, firstCol + i);
    const spoken = path.length > 1 ? path.join(', ') : toSpokenName(leaf, i);

    const base: IndexColumn = {
      i,
      path,
      spoken,
      col: columnLetter(firstCol + i),
      kind: p.kind,
      nonEmpty: p.nonEmpty,
      empty: p.empty,
      distinct: p.distinct,
    };
    return {
      ...base,
      ...(p.categories ? { categories: p.categories } : {}),
      ...(p.numeric
        ? {
            min: p.numeric.min,
            max: p.numeric.max,
            sum: p.numeric.sum,
            mean: p.numeric.mean,
            nonNumeric: p.numeric.nonNumeric,
          }
        : {}),
    };
  });

  return {
    headerRows: Array.from({ length: headerCount }, (_, i) => regionStartRow + i),
    firstDataRow: regionStartRow + headerCount,
    columns,
    rows: dataRows,
    labelColumn: pickLabelColumn(columns, dataRows.length),
    ambiguousColumns: ambiguous,
  };
}
