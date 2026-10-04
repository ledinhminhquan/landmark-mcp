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

import { a1, isBlank, isColumnNumbering, isPivotHeading, type CellValue, type MergeSpan } from './model.ts';
import { headerSignals, speakDate, type Grid, type HeaderSignals } from './infer.ts';

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

export interface HeaderCandidate {
  /** Number of rows read as header. 0 means the region has no header. */
  readonly rows: number;
  /** Evidence for this reading, 0..1. */
  readonly score: number;
  /** One speakable clause explaining the evidence. */
  readonly why: string;
}

export interface HeaderAnalysis {
  readonly chosen: HeaderCandidate;
  /** Other readings worth offering, strongest first. May be empty. */
  readonly alternatives: readonly HeaderCandidate[];
  /**
   * True when the evidence does not settle the question. The caller must ask rather
   * than commit — see `structure` in the index and the `table_structure` tool.
   */
  readonly ambiguous: boolean;
}

/** Above this, a reading is safe to act on without asking. */
const CONFIDENT = 0.7;
/** Below this, a row is data, not a label row. */
const MIN_HEADER = 0.5;
/**
 * The deepest heading block considered. Three missed the common four-level report
 * (FY / Revenue / 2025, 2026 / H1, H2): its last two heading rows were read as records,
 * and four columns came out as "FY Revenue", "FY Revenue 2" and so on, silently.
 */
export const MAX_HEADER_ROWS = 5;

/**
 * Work out how many rows at the top of a region are header, and how sure we are.
 *
 * Two rules earn their keep here, and both were learned by losing data.
 *
 * **Everything above the best-scoring row is header.** That row is the one that
 * separates labels from data, so rows above it are grouping rows by construction —
 * this is what recovers `2026 / Q1 / Revenue`.
 *
 * **Extending DOWNWARD requires positive evidence, not merely another passing score.**
 * The earlier version extended while the next row also scored above threshold. On a
 * table that is text from top to bottom every row clears that bar, so an address book
 * had three rows eaten into its column names and reported full confidence with one
 * record left. A row only continues the header block if it looks like a *grouping*
 * row: it spans columns through a horizontal merge, or it is sparser than the row
 * beneath it. Both are structural facts about the sheet, not restatements of the
 * score that already chose the row.
 *
 * Where the evidence genuinely cannot decide — an all-numeric row over numeric data
 * is the honest example — this returns `ambiguous` with both readings instead of
 * picking one. A human cannot resolve that from the values either.
 */
export function analyseHeader(
  resolved: ResolvedGrid,
  startRow: number,
  endRow: number,
  firstCol: number,
  lastCol: number,
  merges: readonly MergeSpan[] = [],
): HeaderAnalysis {
  const slice = (r: number): CellValue[] => {
    const row = resolved.cells[r];
    if (!row) return [];
    return row.slice(firstCol, lastCol + 1) as CellValue[];
  };
  // Bounded to this region, not the sheet. A sheet can hold several tables stacked
  // with blank rows between them; scoring a header against rows belonging to the
  // next table down drags every signal towards noise and loses the header entirely.
  const limit = Math.min(endRow, resolved.cells.length - 1);

  const signals: HeaderSignals[] = [];
  for (let offset = 0; offset < MAX_HEADER_ROWS; offset++) {
    const r = startRow + offset;
    if (r > limit || resolved.cells[r] === undefined) break;
    const body: CellValue[][] = [];
    for (let b = r + 1; b <= limit; b++) body.push(slice(b));
    if (body.length === 0) break;
    signals.push(headerSignals(slice(r), body));
  }

  // A PivotTable says where its headings end: "Sum of Revenue | Column Labels" over
  // "Row Labels | 2023 | 2024". Scored, the first row alone won at 0.91 and nothing was
  // flagged, though the years under it were read as a record.
  if (signals.length >= 2 && isPivotHeading(slice(startRow), slice(startRow + 1))) {
    return {
      chosen: { rows: 2, score: 0.95, why: "an Excel PivotTable's headings fill its first two rows" },
      alternatives: [],
      ambiguous: false,
    };
  }

  // A single-row region: nothing below it, so there is nothing to infer from. Read it
  // as data rather than as a header — a heading with no rows beneath it labels
  // nothing, and calling it a header would leave the region with no records at all.
  if (signals.length === 0) {
    return {
      chosen: { rows: 0, score: 0.5, why: 'a single row, with nothing beneath it to label' },
      alternatives: [{ rows: 1, score: 0.5, why: 'treat the row as a heading' }],
      ambiguous: true,
    };
  }

  // A region with no mostly-typed column anywhere gives the one strong signal nothing
  // to work with; what is left is distinctness, brevity and density.
  const untyped = signals.every((s) => s.typedColumns === 0);
  // In such a region, density must not pick a lower row as the label row. A label
  // row with a blank top-left corner ("", Mon, Tue over Anh, Gym, Rest) is less dense
  // than every record under it, so letting fullness decide ate the first record into
  // the headings. Where typed columns exist, a stacked grouping row really is sparser
  // than the row it groups, and the discontinuity signal keeps that honest.
  const weight = (s: HeaderSignals): number => (untyped ? s.score - 0.15 * s.density : s.score);
  // And for the same reason, density must not decide whether a row there is labels at
  // all: "Name, Email" over four filled columns, or a roster whose two left columns
  // have no heading, scored under the threshold only for their blanks, and the table
  // lost every column name. There, a row is judged as though it were full.
  const effective = (i: number): number => {
    const s = signals[i]!;
    return untyped ? s.score + 0.15 * (1 - s.density) : s.score;
  };

  // A row of group labels as a CSV writes a merged heading — "Contact", "", "Location",
  // "" — has its labels separated by the blanks of the columns each one covers. That is
  // the same structural fact a merge records, and it is read the same way: as a level
  // above the row that names the columns. At most half full, so a record that merely
  // has a gap or two is not taken for one.
  const grouping = (i: number): boolean => {
    const row = slice(startRow + i);
    const filled = row.flatMap((v, c) => (isBlank(v) ? [] : [c]));
    if (filled.length < 2 || filled.length * 2 > row.length) return false;
    return filled[filled.length - 1]! - filled[0]! + 1 > filled.length;
  };

  let best = 0;
  // Strictly greater keeps the shallowest row on a tie, so a plain single-header
  // table is never over-read as multi-level. The margin keeps floating-point noise
  // between two equal sums from counting as a win.
  for (let i = 1; i < signals.length; i++) {
    if (weight(signals[i]!) > weight(signals[best]!) + 1e-9) best = i;
  }

  // ── no row separates labels from data ────────────────────────────────────
  if (effective(best) < MIN_HEADER) {
    const headerless: HeaderCandidate = {
      rows: 0,
      score: 1 - effective(best),
      why: 'no row looks like labels over data',
    };
    // The all-numeric veto is the reason the score is low, not evidence that the
    // row is data. So is a first row of labels whose typed cells are years or dates
    // ("Region, 2024, 2025, 2026"; "Department, Jan 2024, Feb 2024"): both would read
    // as headings to anyone looking. Offer both readings and say we are unsure.
    const first = signals[0]!;
    if (first.allNumeric || first.vetoed) {
      return {
        chosen: headerless,
        alternatives: [
          {
            rows: 1,
            score: 0.5,
            why: `read the first row as labels, such as ${first.labelKind === 'dates' ? 'dates' : 'years'}`,
          },
        ],
        ambiguous: true,
      };
    }
    // Ambiguous means there is something else to offer. An uncertain reading with no
    // alternative left the listener hearing "I could instead ." and nothing to say.
    // A lower row that does read as labels on its own is offered too: in a text-only
    // region it lost only because fullness is not allowed to decide there.
    const offers: HeaderCandidate[] = [];
    signals.forEach((_, i) => {
      const score = effective(i);
      if (i === best ? score > 0.35 : score >= MIN_HEADER) {
        offers.push({
          rows: i + 1,
          score,
          why: i === 0 ? 'read the first row as labels' : `read the first ${i + 1} rows as headings`,
        });
      }
    });
    // Shallowest first. The first offer is the one said aloud, and the one-row reading
    // is both the commonest shape and the one that costs no record if it is wrong;
    // ranked by score, "read the first 2 rows as headings" could be spoken first.
    offers.sort((a, b) => a.rows - b.rows);
    return { chosen: headerless, alternatives: offers, ambiguous: offers.length > 0 };
  }

  // ── extend downward, but only on structural evidence ─────────────────────
  const density = (r: number): number => {
    const row = slice(r);
    if (row.length === 0) return 0;
    return row.filter((v) => !isBlank(v)).length / row.length;
  };
  const spansColumns = (r: number): boolean =>
    merges.some((m) => m.topRow <= r && m.bottomRow >= r && m.rightCol > m.leftCol);

  let last = best;
  let extendedBy = '';
  while (last + 1 < signals.length && effective(last + 1) >= MIN_HEADER) {
    const row = startRow + last;
    const merged = spansColumns(row);
    // Not in an untyped region, for the reason given above: there, a blank corner
    // makes the label row sparser than the first record, which proves nothing.
    const sparser = !untyped && density(row) < density(row + 1);
    const grouped = untyped && grouping(last);
    if (!merged && !sparser && !grouped) break;
    extendedBy = merged
      ? 'a heading spans several columns'
      : grouped
        ? 'group labels each cover several columns'
        : 'a grouping row sits above a denser one';
    last++;
  }

  const deepest = signals[last]!;
  const deepestScore = effective(last);
  // A Vietnamese form numbers its columns in the row under its headings: "(1) | (2) |
  // (3)". Those are accounting negatives to a cell-by-cell reader, so the row scores as
  // figures and was read as the first record — a row of negatives in every column. As a
  // row it is plainly part of the headings.
  const numbered =
    last + 1 < MAX_HEADER_ROWS && signals.length > last + 1 && isColumnNumbering(slice(startRow + last + 1));
  const rows = last + 1 + (numbered ? 1 : 0);

  // Three ways to end up with more than one header row, and the reason spoken aloud
  // should say which one actually happened rather than asserting the last branch.
  const groupingAbove = best > 0;
  const reason =
    last === 0
      ? deepest.discontinuity > 0
        ? 'labels sit above values of a different kind'
        : 'the first row reads as labels'
      : extendedBy && groupingAbove
        ? `headings are stacked above the row that names the values, and ${extendedBy}`
        : groupingAbove
          ? 'headings are stacked above the row that names the values'
          : `${extendedBy}, over a row of labels`;
  const why = numbered ? `${reason}, and the row under them numbers the columns` : reason;

  const chosen: HeaderCandidate = { rows, score: deepestScore, why };

  // Where the boundary row is only weakly supported — an all-text table gives the
  // discontinuity signal nothing to work with — offer the neighbouring readings.
  const alternatives: HeaderCandidate[] = [];
  if (deepestScore < CONFIDENT) {
    // The one-row reading is the commonest shape of all, and a multi-row reading that
    // is unsure of itself must offer it: otherwise the correction that restores the
    // lost first record is never suggested.
    if (rows > 1) {
      alternatives.push({ rows: 1, score: effective(0), why: 'read only the first row as headings' });
    }
    if (rows > 0) {
      alternatives.push({ rows: 0, score: 1 - deepestScore, why: 'treat every row as data' });
    }
    if (rows < MAX_HEADER_ROWS && signals.length > rows) {
      alternatives.push({
        rows: rows + 1,
        score: effective(rows),
        why: 'take one more row as a second heading level',
      });
    }
  }

  // A first record that is a label over a run of years — "Row Labels, 2023, 2024,
  // 2025" under a pivot's value heading — is far more likely a heading level the
  // evidence missed than a record. Said as uncertain, with the reading that fixes it.
  const record = slice(startRow + rows);
  const figures = record.filter((v) => typeof v === 'number' || (typeof v === 'string' && /^\s*\d{4}\s*$/.test(v))).map(Number);
  const years =
    figures.length >= 2 && figures.every((y, k) => Number.isInteger(y) && y >= 1900 && y <= 2100 && (k === 0 || y === figures[k - 1]! + 1));
  const labelled = typeof record.find((v) => !isBlank(v)) === 'string';
  if (years && labelled && rows < MAX_HEADER_ROWS && signals.length > rows && !alternatives.some((a) => a.rows === rows + 1)) {
    alternatives.unshift({ rows: rows + 1, score: 0.5, why: 'take one more row as a second heading level' });
    return { chosen, alternatives, ambiguous: true };
  }

  return { chosen, alternatives, ambiguous: deepestScore < CONFIDENT };
}

/** Backwards-compatible shorthand: the chosen row count only. */
export function detectHeaderRowCount(
  resolved: ResolvedGrid,
  startRow: number,
  endRow: number,
  firstCol: number,
  lastCol: number,
  merges: readonly MergeSpan[] = [],
): number {
  return analyseHeader(resolved, startRow, endRow, firstCol, lastCol, merges).chosen.rows;
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
      ? speakDate(value)
      : String(value);
  const note = origin === 'merge' ? ' (inherited from a merged label)' : '';
  return `${what}${where}: ${shown}${note}`;
}
