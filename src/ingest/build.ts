/**
 * Grid → index. The offline half of the system, where all the inference happens.
 */

import {
  buildHeaderPaths,
  detectHeaderRowCount,
  resolveMerges,
} from '../table/header.ts';
import { detectRegions, profileColumn, type Grid } from '../table/infer.ts';
import { a1, columnLetter, isBlank, toSpokenName, type CellValue } from '../table/model.ts';
import {
  INDEX_VERSION,
  slugify,
  titleize,
  type IndexColumn,
  type IndexInherited,
  type IndexRegion,
  type IndexTable,
  type LandmarkIndex,
} from '../indexfmt.ts';
import type { ReadResult, ReadSheet } from './read.ts';

/** JSON has no Date. Serialise explicitly rather than letting JSON.stringify decide. */
type Json = string | number | boolean | null;
function toJson(v: CellValue): Json {
  if (v instanceof Date) return v.toISOString();
  return v;
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

function buildRegionIndex(
  sheet: ReadSheet,
  raw: { startRow: number; endRow: number; firstCol: number; lastCol: number },
  id: string,
  titleAbove: string | null,
): IndexRegion {
  const resolved = resolveMerges(sheet.grid as Grid, sheet.merges);

  const headerRowCount = detectHeaderRowCount(
    resolved,
    raw.startRow,
    raw.endRow,
    raw.firstCol,
    raw.lastCol,
  );
  const headerRows = Array.from({ length: headerRowCount }, (_, i) => raw.startRow + i).filter(
    (r) => r <= raw.endRow,
  );

  // Header detection can legitimately conclude there is no header (all-numeric grid).
  // We keep the rows it consumed only if the data below is non-empty.
  const firstDataRow = raw.startRow + headerRows.length;
  const hasData = firstDataRow <= raw.endRow;
  const effectiveHeaderRows = hasData ? headerRows : [];
  const dataStart = hasData ? firstDataRow : raw.startRow;

  const { paths, ambiguous } = buildHeaderPaths(
    resolved,
    effectiveHeaderRows,
    raw.firstCol,
    raw.lastCol,
  );

  const width = raw.lastCol - raw.firstCol + 1;
  const rows: Json[][] = [];
  const inherited: IndexInherited[] = [];

  for (let r = dataStart; r <= raw.endRow; r++) {
    const out: Json[] = [];
    for (let i = 0; i < width; i++) {
      const c = raw.firstCol + i;
      const v = resolved.cells[r]?.[c] ?? null;
      out.push(toJson(v));
      if (resolved.origin[r]?.[c] === 'merge') {
        const at = a1(r, c);
        const from = resolved.anchor.get(at);
        if (from) inherited.push({ at, from });
      }
    }
    rows.push(out);
  }

  const columns: IndexColumn[] = paths.map((path, i) => {
    const values = rows.map((row) => (row[i] ?? null) as CellValue);
    const label = path[path.length - 1] ?? '';
    const p = profileColumn(values, label, i, raw.firstCol + i);
    const spokenLeaf = toSpokenName(label, i);
    // Speak the full path when it disambiguates; the leaf alone when it does not.
    const spoken = path.length > 1 ? path.join(', ') : spokenLeaf;

    const base: IndexColumn = {
      i,
      path,
      spoken,
      col: columnLetter(raw.firstCol + i),
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

  // Reuse the primary header row's score as the confidence we report aloud.
  const primary = effectiveHeaderRows[effectiveHeaderRows.length - 1];
  const confidence =
    primary === undefined
      ? 0
      : Math.min(
          1,
          columns.filter((c) => c.path.length > 0).length / Math.max(1, columns.length),
        );

  return {
    id,
    sheet: sheet.name,
    title: titleAbove,
    headerRows: effectiveHeaderRows,
    headerConfidence: confidence,
    firstDataRow: dataStart,
    firstCol: raw.firstCol,
    rowCount: rows.length,
    columns,
    rows,
    inherited,
    labelColumn: pickLabelColumn(columns, rows.length),
    ambiguousColumns: ambiguous,
  };
}

/**
 * A single non-blank row sitting immediately above a region, spanning fewer columns
 * than the region, is a title — the "Q3 Regional Sales" line. Consume it so it does
 * not get mistaken for a header row, and use it as the region's spoken name.
 */
function extractTitle(
  sheet: ReadSheet,
  region: { startRow: number; firstCol: number; lastCol: number },
): { title: string | null; startRow: number } {
  const row = sheet.grid[region.startRow];
  if (!row) return { title: null, startRow: region.startRow };
  const filled: string[] = [];
  for (let c = region.firstCol; c <= region.lastCol; c++) {
    const v = row[c] ?? null;
    if (!isBlank(v)) filled.push(String(v).trim());
  }
  const span = region.lastCol - region.firstCol + 1;
  const isTitle = filled.length === 1 && span > 1 && sheet.grid[region.startRow + 1] !== undefined;
  return isTitle
    ? { title: filled[0] ?? null, startRow: region.startRow + 1 }
    : { title: null, startRow: region.startRow };
}

export function buildTable(read: ReadResult): IndexTable {
  const id = slugify(read.sourceName);
  const regions: IndexRegion[] = [];
  const warnings = [...read.warnings];

  for (const sheet of read.sheets) {
    const raws = detectRegions(sheet.grid as Grid);
    if (raws.length === 0) {
      warnings.push(`Sheet "${sheet.name}" is empty.`);
      continue;
    }
    raws.forEach((raw, i) => {
      const { title, startRow } = extractTitle(sheet, raw);
      if (startRow > raw.endRow) return; // a title with nothing under it
      const regionId = `${slugify(sheet.name)}.t${i + 1}`;
      regions.push(buildRegionIndex(sheet, { ...raw, startRow }, regionId, title));
    });
  }

  if (regions.length > 1) {
    warnings.push(
      `This file holds ${regions.length} separate tables. Say which one you want, or ask me to describe them.`,
    );
  }

  return {
    id,
    title: titleize(read.sourceName),
    format: read.format,
    sourceName: read.sourceName,
    ingestedAt: new Date().toISOString(),
    regions,
    warnings,
  };
}

export function buildIndex(tables: readonly IndexTable[]): LandmarkIndex {
  return { version: INDEX_VERSION, tables };
}
