/**
 * The index format — the contract between the two halves of this system.
 *
 * Ingest runs in Node, where ExcelJS and the filesystem exist. The MCP server runs on
 * Cloudflare Workers, where neither does. Rather than fight that (ExcelJS depends on
 * Node streams and Buffer, and shimming it into a Worker is a week of yak-shaving with
 * a cold-start penalty at the end), the split is deliberate:
 *
 *   spreadsheet ──[ingest CLI, Node]──▶ index.json ──[Worker]──▶ MCP tools
 *
 * Everything expensive and Node-shaped happens once, offline. The Worker does pure
 * computation over plain JSON, which is exactly what V8 isolates are good at and what
 * keeps p95 under the 500 ms Alexa+ budget with no cold start.
 *
 * This file is the frozen shape. It carries a version because the ingest CLI and the
 * deployed server will drift out of step at some point during a 45-day build, and a
 * loud mismatch is better than a silent misread.
 */

export const INDEX_VERSION = 2 as const;

/** Inferred semantic type. Mirrors ColumnKind in table/model.ts. */
export type IndexColumnKind =
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'boolean'
  | 'category'
  | 'text'
  | 'empty'
  | 'mixed';

export interface IndexColumn {
  /** Position within the region. */
  readonly i: number;
  /**
   * Full header path, outermost first: ["2026", "Q2", "Revenue"].
   * Empty when the column carries no label at all.
   */
  readonly path: readonly string[];
  /** What to say out loud. Never empty — falls back to "column 3". */
  readonly spoken: string;
  /** Column letter in the source sheet, for provenance. */
  readonly col: string;
  readonly kind: IndexColumnKind;
  readonly nonEmpty: number;
  readonly empty: number;
  readonly distinct: number;
  /** Only for low-cardinality columns, where reading them aloud is useful. */
  readonly categories?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly sum?: number;
  readonly mean?: number;
  /** Values in a numeric column that could not be read as numbers. */
  readonly nonNumeric?: number;
  /**
   * Set only on a date column the file wrote day first ("15/01/2024"). Its cells are
   * stored as ISO days, which no longer show the order, so a filter value written the
   * file's way ("04/07/2026") is read with this rather than guessed month first.
   */
  readonly dateOrder?: 'dmy';
  /**
   * Set on a column of identifiers written in digits: `phone` for phone numbers, `code`
   * for the rest. A phone number typed as "0912345678" has to find the 912345678 Excel
   * stored, and neither kind is the name a row should be spoken by. `row` marks the
   * column that numbers the rows ("STT" over 1, 2, 3): it keeps its number kind, so a
   * range filter compares numbers, but has no sum, min, max or mean.
   */
  readonly identifier?: 'phone' | 'code' | 'row';
  /**
   * Set when the column's numbers use the comma as their decimal point ("1.234,50",
   * "45.000 ₫"), so a filter value written the same way ("30.000") is read that way
   * too, rather than as thirty.
   */
  readonly numberConvention?: 'comma';
  /**
   * Said with any figure computed from this column, when how its numbers were read was
   * a guess: "45.000" as forty-five or as forty-five thousand is a factor of a thousand
   * the listener cannot catch, and a warning heard only in the description was missed
   * by everyone who asked a question first.
   */
  readonly numberNote?: string;
}

/**
 * A cell that exists only because a merge covers it. Kept explicitly rather than
 * baked into the values, so `table_explain` can say "that came from A2, which is
 * merged down to A5" instead of pretending A5 held the value.
 */
export interface IndexInherited {
  /** Address of the covered cell, e.g. "A5". */
  readonly at: string;
  /** Address that actually holds the value, e.g. "A2". */
  readonly from: string;
}

/** One way of reading where a region's header stops. */
export interface StructureReading {
  /** Number of header rows. 0 means the region has no header. */
  readonly headerRows: number;
  /** Evidence for this reading, 0..1. */
  readonly score: number;
  /** One speakable clause explaining the evidence. */
  readonly why: string;
}

/**
 * How the region's structure was decided, and whether anyone should trust it yet.
 *
 * The previous format carried a single `headerConfidence` computed as the share of
 * columns that ended up with a heading path. That number could only go up when the
 * inference consumed more rows, so the reading that destroyed the most data reported
 * the most confidence. It is replaced here by the evidence for the chosen reading,
 * the readings that were rejected, and an explicit flag for "ask before relying on
 * this".
 */
export interface RegionStructure {
  readonly chosen: StructureReading;
  /** Other readings worth offering aloud. May be empty. */
  readonly alternatives: readonly StructureReading[];
  /** True when the evidence does not settle it and the user should be asked. */
  readonly ambiguous: boolean;
  /**
   * Bumped whenever a person corrects the reading. Every answer records the revision
   * it was computed under, so a later correction cannot silently rewrite the
   * evidence for something already spoken.
   */
  readonly revision: number;
  /** Set when a person chose this reading rather than the inference. */
  readonly confirmedBy?: 'user';
}

export interface IndexRegion {
  /** Stable id used in every tool call: "sales.t1". */
  readonly id: string;
  readonly sheet: string;
  /** Title found above the region, if any. */
  readonly title: string | null;
  /** Absolute sheet row indices consumed as header, in order. Empty if headerless. */
  readonly headerRows: readonly number[];
  /**
   * Kept for compatibility; prefer `structure.chosen.score`, which means the same
   * thing and cannot be inflated by consuming more rows.
   */
  readonly headerConfidence: number;
  readonly structure: RegionStructure;
  /** Absolute sheet row index of the region's first row, header included. */
  readonly startRow: number;
  /**
   * Every row of the region, merge-resolved, with the header rows still attached.
   *
   * This is what makes a spoken correction possible: the Worker has no source file,
   * so a region stored with its headers already stripped could never be re-read. The
   * duplication against `rows` is a few kilobytes and is the price of being wrong
   * recoverably.
   */
  readonly allRows: readonly (readonly (string | number | boolean | null)[])[];
  readonly firstDataRow: number;
  readonly firstCol: number;
  readonly rowCount: number;
  readonly columns: readonly IndexColumn[];
  /**
   * Row-major values, merge-resolved. Dates are ISO strings — JSON has no date type
   * and a silent Date-to-string coercion at the boundary is a classic source of
   * off-by-one-day bugs.
   */
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  readonly inherited: readonly IndexInherited[];
  /** Column index nominated as the row label, or null if none is suitable. */
  readonly labelColumn: number | null;
  /** Columns whose header path is not unique. */
  readonly ambiguousColumns: readonly number[];
  /**
   * Indices into `rows` of the sheet's own total and subtotal rows ("Total",
   * "Subtotal", "Tổng cộng"). They are kept in `rows`, so addresses and row-by-row
   * reading are unchanged, but column statistics exclude them and every count, sum,
   * filter and grouping must skip them: summing a column that already contains its
   * own total doubles the answer. Absent when there are none.
   */
  readonly summaryRows?: readonly number[];
}

export interface IndexTable {
  /** Stable id: slug of the source filename. */
  readonly id: string;
  /** Human title for speech. */
  readonly title: string;
  readonly format: 'xlsx' | 'csv' | 'tsv';
  readonly sourceName: string;
  /** ISO timestamp, set by the ingest CLI. */
  readonly ingestedAt: string;
  readonly regions: readonly IndexRegion[];
  /** Non-fatal problems worth mentioning once when the table is opened. */
  readonly warnings: readonly string[];
}

export interface LandmarkIndex {
  readonly version: typeof INDEX_VERSION;
  readonly tables: readonly IndexTable[];
}

// ---------------------------------------------------------------------------

export class IndexVersionError extends Error {
  constructor(found: unknown) {
    super(
      `Index was built by a different version of the ingest tool (found ${JSON.stringify(found)}, expected ${INDEX_VERSION}). Re-run "npm run ingest".`,
    );
    this.name = 'IndexVersionError';
  }
}

/**
 * Validate enough of a parsed index to fail loudly at the boundary rather than
 * mysteriously three tool calls later. Not a full schema check — the producer and
 * consumer are the same codebase — but the version and the shape of the spine.
 */
export function assertIndex(value: unknown): asserts value is LandmarkIndex {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Index is not an object.');
  }
  const v = value as Partial<LandmarkIndex>;
  if (v.version !== INDEX_VERSION) throw new IndexVersionError(v.version);
  if (!Array.isArray(v.tables)) throw new TypeError('Index has no tables array.');
  for (const t of v.tables) {
    if (typeof t?.id !== 'string' || !Array.isArray(t?.regions)) {
      throw new TypeError(`Table ${JSON.stringify(t?.id)} is malformed.`);
    }
  }
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Vietnamese đ has no decomposition, so it would otherwise vanish from the id.
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Filename → stable, speakable id. "Q3 Sales (final).xlsx" → "q3-sales-final". */
export function slugify(name: string): string {
  return slug(name.replace(/\.[^.]+$/, '')) || 'table';
}

/**
 * Sheet name → id part. Unlike a filename, a sheet name has no extension: stripping
 * one turned "Q1.2025" and "Q1.2026" into the same "q1", so a bookmark on one sheet
 * resumed on the other and a correction to one silently re-read both.
 */
export function slugifySheet(name: string): string {
  return slug(name) || 'sheet';
}

/**
 * The first of `base`, `base-2`, `base-3` … not already in `used`, which it joins.
 * Ids are how every tool call finds its target, so two things sharing one is a
 * silent misroute, not a cosmetic clash.
 */
export function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** Filename → human title. "q3_sales_final.xlsx" → "Q3 sales final". */
export function titleize(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Untitled table';
}
