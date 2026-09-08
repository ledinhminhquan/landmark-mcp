/**
 * Merge resolution and header-path construction.
 *
 * This is the module that earns the project its keep, so it is worth being precise
 * about what it does and why.
 *
 * A merged cell stores its value once, at the top-left of the span. Every other cell
 * the span covers is genuinely empty in the file. Anything that reads those cells
 * literally reports a gap that is not there — and that is not a screen-reader defect,
 * it is what the file says. Sighted users are rescued by the border being drawn
 * around the whole span; there is no equivalent rescue in a serial channel.
 *
 * Multi-level headers compound it. A sheet with
 *
 *        |        2026        |        2025
 *        |   Q1    |    Q2    |   Q1    |   Q2
 *   Region| Revenue | Revenue | Revenue | Revenue
 *
 * has three header rows and horizontally merged blocks in the top two. Column 2's
 * real identity is "2026 / Q2 / Revenue", but every cell in it is labelled, in the
 * file, with nothing but "Revenue". Four columns share that label. Reading them out
 * as "Revenue" four times is worse than useless.
 *
 * So: resolve the merges, then walk the header rows top to bottom collecting each
 * column's full path. Every value the server later speaks can then carry its own
 * identity, and `explain` can read the path back on demand.
 */

import { a1, isBlank, type CellValue, type MergeSpan } from './model.ts';
import { scoreHeaderRow, type Grid } from './infer.ts';

/** Where a cell's value came from, so we never silently invent data. */
export type CellOrigin = 'literal' | 'merge';

export interface ResolvedGrid {
  /** Same shape as the input, with merge spans filled from their anchor. */
  readonly cells: readonly (readonly CellValue[])[];
  /** Parallel grid recording whether each value was written or inherited. */
  readonly origin: readonly (readonly CellOrigin[])[];
  /** Anchor address for a filled cell, so provenance points at the real cell. */
  readonly anchor: ReadonlyMap<string, string>;
}

/**
 * Fill every merge span from its anchor value.
 *
 * Deliberately NOT a general forward-fill. Forward-filling a column because it "looks
 * sparse" invents data — a genuinely empty cell and a merge-covered cell mean
 * different things, and only the file can tell you which is which. We fill only what
 * the merge list authorises, and record the origin of everything we touch.
 */
export function resolveMerges(grid: Grid, merges: readonly MergeSpan[]): ResolvedGrid {
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const cells: CellValue[][] = grid.map((row) =>
    Array.from({ length: width }, (_, c) => row[c] ?? null),
  );
  const origin: CellOrigin[][] = grid.map(() =>
    Array.from({ length: width }, () => 'literal' as CellOrigin),
  );
  const anchor = new Map<string, string>();

  for (const m of merges) {
    const value = m.value ?? cells[m.topRow]?.[m.leftCol] ?? null;
    if (isBlank(value)) continue;
    const anchorAddr = a1(m.topRow, m.leftCol);
    for (let r = m.topRow; r <= m.bottomRow; r++) {
      for (let c = m.leftCol; c <= m.rightCol; c++) {
        if (r === m.topRow && c === m.leftCol) continue;
        const row = cells[r];
        const orow = origin[r];
        if (!row || !orow || c >= width) continue;

        const existing = row[c] ?? null;
        if (isBlank(existing)) {
          row[c] = value;
        } else if (existing !== value) {
          // A non-blank value that disagrees with the anchor should not exist inside
          // a merge. Trust the file over our model and leave it alone.
          continue;
        }
        // Reached either because we filled the cell, or because the reader had
        // already filled it for us — ExcelJS propagates a merged value across the
        // span in its own object model, while a CSV cannot. Being inside the span is
        // a fact about the file, not about which reader loaded it, so the origin is
        // recorded either way. Without this, provenance silently depends on format.
        orow[c] = 'merge';
        anchor.set(a1(r, c), anchorAddr);
      }
    }
  }

  return { cells, origin, anchor };
}

export interface HeaderPathResult {
  /** One path per column, outermost label first. Empty array = unlabelled column. */
  readonly paths: readonly (readonly string[])[];
  /** How many rows were consumed as header. */
  readonly headerRowCount: number;
  /** Columns whose path is not unique — a real and speakable problem. */
  readonly ambiguous: readonly number[];
}

/**
 * Build each column's full header path from one or more header rows.
 *
 * `headerRows` are absolute row indices into the resolved grid, in order. Callers
 * that only detected a single header row pass one; the multi-level case passes
 * several. Blank cells at a level are skipped rather than emitted, so a column under
 * a merged "2026" that has no quarter label reads as "2026 / Revenue", not
 * "2026 / (blank) / Revenue".
 */
export function buildHeaderPaths(
  resolved: ResolvedGrid,
  headerRows: readonly number[],
  firstCol: number,
  lastCol: number,
): HeaderPathResult {
  const paths: string[][] = [];

  for (let c = firstCol; c <= lastCol; c++) {
    const path: string[] = [];
    for (const r of headerRows) {
      const v = resolved.cells[r]?.[c] ?? null;
      if (isBlank(v)) continue;
      const text = String(v).trim();
      // A merged label repeated down levels adds nothing when spoken.
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
  const ambiguous = [...seen.values()].filter((l) => l.length > 1).flat().sort((a, b) => a - b);

  return { paths, headerRowCount: headerRows.length, ambiguous };
}

/**
 * Detect how many rows at the top of a region are header rows.
 *
 * The obvious approach — walk down and stop when a row stops looking like a header —
 * fails on the shape this module exists for. In
 *
 *        |   2026   |   2025          <- merged grouping row
 *        | Q1  | Q2 | Q1  | Q2        <- no merges, no type discontinuity
 *   Region| Revenue | Revenue | ...   <- the row that actually names the measures
 *
 * the middle row carries neither of the signals a top-down walk looks for, so the
 * walk stops early and the measure row is read as data.
 *
 * So work from the bottom of the block instead: find the row that most convincingly
 * separates labels from typed data — the same score `infer.ts` already uses and
 * tests — and take everything from the top of the region down to it. Grouping rows
 * above the real header are, by construction, part of the header.
 *
 * Capped at three rows: past that a spoken path stops being comprehensible and the
 * file needs a human.
 */
export function detectHeaderRowCount(
  resolved: ResolvedGrid,
  startRow: number,
  endRow: number,
  firstCol: number,
  lastCol: number,
): number {
  const MAX = 3;
  const slice = (r: number): CellValue[] => {
    const row = resolved.cells[r];
    if (!row) return [];
    return row.slice(firstCol, lastCol + 1) as CellValue[];
  };
  // Bounded to this region, not the sheet. A sheet can hold several tables stacked
  // with blank rows between them; scoring a header against rows belonging to the
  // next table down drags every signal towards noise and loses the header entirely.
  const limit = Math.min(endRow, resolved.cells.length - 1);

  /** Below this, a row is data, not a label row. */
  const MIN_HEADER = 0.5;

  const scores: number[] = [];
  for (let offset = 0; offset < MAX; offset++) {
    const r = startRow + offset;
    if (r > limit || resolved.cells[r] === undefined) break;
    const body: CellValue[][] = [];
    for (let b = r + 1; b <= limit; b++) body.push(slice(b));
    if (body.length === 0) break;
    scores.push(scoreHeaderRow(slice(r), body));
  }
  if (scores.length === 0) return 1;

  let best = 0;
  // Strictly greater keeps the shallowest row on a tie, so a plain single-header
  // table is never over-read as multi-level.
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[best]!) best = i;

  // No row here separates labels from data — an all-numeric block, for instance.
  // Report zero rather than consuming a data row as a header.
  if (scores[best]! < MIN_HEADER) return 0;

  // Everything above the best row is a grouping row by construction, so it is part
  // of the header block. Then extend DOWNWARD while the next row still reads as
  // labels rather than data.
  //
  // The downward extension is what a pure argmax misses. Given
  //
  //        | Q1      | Q2      | Q3
  //   Region| Revenue | Revenue | Revenue
  //
  // the quarter row wins on distinctness precisely because the row beneath it
  // repeats one label three times — and that repetition is the whole reason the
  // path is needed. Scoring alone would stop at the quarter row and read the
  // measure row as data.
  let last = best;
  while (last + 1 < scores.length && scores[last + 1]! >= MIN_HEADER) last++;

  return last + 1;
}

/** Speakable rendering of a header path: "2026, Q2, Revenue". */
export function speakPath(path: readonly string[]): string {
  return path.length ? path.join(', ') : 'an unlabelled column';
}

/**
 * Anchor a value to its full identity for speech, e.g.
 *   "2026, Q2, Revenue for North: 4,820"
 * The row label is whatever the region nominated as its identifying column.
 */
export function speakValue(
  path: readonly string[],
  rowLabel: string | null,
  value: CellValue,
  origin: CellOrigin = 'literal',
): string {
  const what = speakPath(path);
  const where = rowLabel ? ` for ${rowLabel}` : '';
  const shown = isBlank(value)
    ? 'empty'
    : value instanceof Date
      ? value.toDateString()
      : String(value);
  const note = origin === 'merge' ? ' (inherited from a merged label)' : '';
  return `${what}${where}: ${shown}${note}`;
}
