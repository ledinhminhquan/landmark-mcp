/**
 * Grid → index. The offline half of the system, where all the inference happens.
 */

import { analyseHeader, resolveMerges } from '../table/header.ts';
import { materialise } from '../table/materialise.ts';
import { detectRegions, type Grid } from '../table/infer.ts';
import { a1, isBlank, type CellValue } from '../table/model.ts';
import {
  INDEX_VERSION,
  slugify,
  titleize,
  type IndexInherited,
  type IndexRegion,
  type IndexTable,
  type LandmarkIndex,
  type StructureReading,
} from '../indexfmt.ts';
import type { ReadResult, ReadSheet } from './read.ts';

/** JSON has no Date. Serialise explicitly rather than letting JSON.stringify decide. */
type Json = string | number | boolean | null;
function toJson(v: CellValue): Json {
  if (v instanceof Date) return v.toISOString();
  return v;
}

function buildRegionIndex(
  sheet: ReadSheet,
  raw: { startRow: number; endRow: number; firstCol: number; lastCol: number },
  id: string,
  titleAbove: string | null,
): IndexRegion {
  const resolved = resolveMerges(sheet.grid as Grid, sheet.merges);
  const analysis = analyseHeader(
    resolved,
    raw.startRow,
    raw.endRow,
    raw.firstCol,
    raw.lastCol,
    sheet.merges,
  );

  // Every row of the region, header included, plus a record of which cells only have
  // a value because a merge covers them. Keeping the header rows here is what lets
  // the reading be corrected later without the source file.
  const width = raw.lastCol - raw.firstCol + 1;
  const allRows: Json[][] = [];
  const inherited: IndexInherited[] = [];

  for (let r = raw.startRow; r <= raw.endRow; r++) {
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
    allRows.push(out);
  }

  const m = materialise(allRows, raw.startRow, raw.firstCol, analysis.chosen.rows);

  const reading = (c: { rows: number; score: number; why: string }): StructureReading => ({
    headerRows: c.rows,
    score: Math.round(c.score * 100) / 100,
    why: c.why,
  });

  // Report the reading that was actually applied, not the one that was proposed.
  // `materialise` clamps a header block that would leave no data rows, and a
  // structure record that disagreed with its own columns would be worse than none:
  // it is exactly the kind of quiet inconsistency this whole change exists to remove.
  const chosen = reading({ ...analysis.chosen, rows: m.headerRows.length });
  const alternatives = analysis.alternatives
    .map(reading)
    .filter((a) => a.headerRows !== chosen.headerRows);

  return {
    id,
    sheet: sheet.name,
    title: titleAbove,
    headerRows: m.headerRows,
    // Same number as structure.chosen.score, kept so older readers do not break.
    headerConfidence: chosen.score,
    structure: { chosen, alternatives, ambiguous: analysis.ambiguous, revision: 1 },
    startRow: raw.startRow,
    allRows,
    firstDataRow: m.firstDataRow,
    firstCol: raw.firstCol,
    rowCount: m.rows.length,
    columns: m.columns,
    rows: m.rows,
    inherited,
    labelColumn: m.labelColumn,
    ambiguousColumns: m.ambiguousColumns,
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
