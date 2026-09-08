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

export const INDEX_VERSION = 1 as const;

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

export interface IndexRegion {
  /** Stable id used in every tool call: "sales.t1". */
  readonly id: string;
  readonly sheet: string;
  /** Title found above the region, if any. */
  readonly title: string | null;
  /** Absolute sheet row indices consumed as header, in order. Empty if headerless. */
  readonly headerRows: readonly number[];
  /** 0..1. Surfaced honestly in speech when low. */
  readonly headerConfidence: number;
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

/** Filename → stable, speakable id. "Q3 Sales (final).xlsx" → "q3-sales-final". */
export function slugify(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'table'
  );
}

/** Filename → human title. "q3_sales_final.xlsx" → "Q3 sales final". */
export function titleize(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Untitled table';
}
