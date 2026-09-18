/**
 * Query engine.
 *
 * Two rules shape everything here, and both come from the fact that the answer will
 * be spoken to someone who cannot glance at the sheet to check it.
 *
 * 1. NOTHING IS ESTIMATED, AND NOTHING IS COMPUTED BY A LANGUAGE MODEL. Filtering and
 *    aggregation happen in this file, over the index, deterministically. The model's
 *    job is to choose the query and read the sentence, not to do arithmetic.
 *
 * 2. EVERY ANSWER CARRIES ITS PROVENANCE. Which cells produced this number, and which
 *    rows were skipped and why. A sighted user checks a total by looking at the
 *    column; over audio there is nothing to look at, so the check has to be a tool
 *    call. Exclusions are counted rather than quietly dropped: "the total of 47 of
 *    the 52 rows; five were empty" is a different statement from "the total".
 */

import { asNumber, asDate } from '../table/infer.ts';
import { a1 } from '../table/model.ts';
import type { IndexColumn, IndexRegion } from '../indexfmt.ts';

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'is_empty'
  | 'is_not_empty';

export type Aggregate = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface Filter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value?: string;
}

export interface QuerySpec {
  readonly filters?: readonly Filter[];
  readonly aggregate?: Aggregate;
  readonly aggregateColumn?: string;
  readonly groupBy?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ExcludedCell {
  readonly address: string;
  readonly reason: string;
}

export interface Provenance {
  readonly sheet: string;
  /** Addresses that contributed to the answer. Capped; `cellCount` is the truth. */
  readonly cells: readonly string[];
  readonly cellCount: number;
  readonly excluded: readonly ExcludedCell[];
}

export interface GroupResult {
  readonly key: string;
  readonly value: number | null;
  readonly rowCount: number;
}

export interface QueryResult {
  readonly result: number | null;
  /** Rows matching the filters, before any limit is applied. */
  readonly matchedRows: number;
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  /** Data-row indices of `rows`, so callers can map back for labels. */
  readonly rowIndices: readonly number[];
  readonly groups: readonly GroupResult[];
  readonly provenance: Provenance;
  readonly moreAvailable: boolean;
  readonly nextOffset: number | null;
}

export class QueryError extends Error {
  /**
   * What the caller should do instead. This is spoken to the user, so it must be
   * actionable — "ask which column they mean", not "invalid argument".
   *
   * Declared as a field rather than a constructor parameter property: parameter
   * properties emit code, so they are not erasable, and Node's type stripping
   * rejects them outright.
   */
  readonly nextStep: string;

  constructor(message: string, nextStep: string) {
    super(message);
    this.name = 'QueryError';
    this.nextStep = nextStep;
  }
}

const PROVENANCE_CELL_CAP = 200;

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a column by name. Accepts the leaf label, the full path joined by commas,
 * or the spoken name — a voice agent will produce any of the three, and rejecting two
 * of them produces a baffling failure for the user.
 */
export function resolveColumn(region: IndexRegion, name: string): IndexColumn {
  const want = name.trim().toLowerCase();
  if (!want) {
    throw new QueryError('No column name was given.', 'Ask which column they mean.');
  }

  const candidates = region.columns.filter((c) => {
    const leaf = (c.path[c.path.length - 1] ?? '').toLowerCase();
    const full = c.path.join(', ').toLowerCase();
    const spoken = c.spoken.toLowerCase();
    return leaf === want || full === want || spoken === want;
  });

  if (candidates.length === 1) return candidates[0]!;

  if (candidates.length > 1) {
    throw new QueryError(
      `"${name}" matches ${candidates.length} columns in this table.`,
      `Ask which one: ${candidates.map((c) => c.spoken).join(', ')}.`,
    );
  }

  // Fall back to a containment match before giving up, so "revenue" finds
  // "2026, Q2, Revenue" when only one column could be meant.
  const loose = region.columns.filter((c) => c.spoken.toLowerCase().includes(want));
  if (loose.length === 1) return loose[0]!;
  if (loose.length > 1) {
    throw new QueryError(
      `"${name}" is ambiguous.`,
      `Ask which one: ${loose.map((c) => c.spoken).join(', ')}.`,
    );
  }

  throw new QueryError(
    `This table has no column called "${name}".`,
    `The columns are: ${region.columns.map((c) => c.spoken).join(', ')}.`,
  );
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

type Cell = string | number | boolean | null;

function blank(v: Cell): boolean {
  return v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Compare a cell against a filter value, using the column's inferred type to decide
 * how. A string comparison on "1200" vs "900" gets the wrong answer; a numeric
 * comparison on region names is meaningless. The column already told us which it is.
 */
function compare(cell: Cell, op: FilterOp, raw: string | undefined, kind: string): boolean {
  if (op === 'is_empty') return blank(cell);
  if (op === 'is_not_empty') return !blank(cell);
  if (raw === undefined) {
    throw new QueryError(`The "${op}" test needs a value to compare against.`, 'Ask what to compare with.');
  }
  if (blank(cell)) return false;

  const numericKind = kind === 'number' || kind === 'currency' || kind === 'percent';
  if (numericKind) {
    const a = asNumber(cell);
    const b = asNumber(raw);
    if (a !== null && b !== null) {
      switch (op) {
        case 'eq': return a === b;
        case 'neq': return a !== b;
        case 'gt': return a > b;
        case 'gte': return a >= b;
        case 'lt': return a < b;
        case 'lte': return a <= b;
        case 'contains': return String(cell).includes(raw);
      }
    }
  }

  if (kind === 'date') {
    const a = asDate(cell);
    const b = asDate(raw);
    if (a !== null && b !== null) {
      const x = a.getTime();
      const y = b.getTime();
      switch (op) {
        case 'eq': return x === y;
        case 'neq': return x !== y;
        case 'gt': return x > y;
        case 'gte': return x >= y;
        case 'lt': return x < y;
        case 'lte': return x <= y;
        case 'contains': return String(cell).includes(raw);
      }
    }
  }

  const s = String(cell).trim().toLowerCase();
  const t = raw.trim().toLowerCase();
  switch (op) {
    case 'eq': return s === t;
    case 'neq': return s !== t;
    case 'contains': return s.includes(t);
    case 'gt': return s > t;
    case 'gte': return s >= t;
    case 'lt': return s < t;
    case 'lte': return s <= t;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function runQuery(region: IndexRegion, spec: QuerySpec): QueryResult {
  const filters = spec.filters ?? [];
  const aggregate: Aggregate = spec.aggregate ?? 'none';
  const limit = Math.max(1, Math.min(spec.limit ?? 5, 20));
  const offset = Math.max(0, spec.offset ?? 0);

  const resolvedFilters = filters.map((f) => ({ ...f, col: resolveColumn(region, f.column) }));

  const matching: number[] = [];
  for (let i = 0; i < region.rows.length; i++) {
    const row = region.rows[i]!;
    const keep = resolvedFilters.every((f) =>
      compare(row[f.col.i] ?? null, f.op, f.value, f.col.kind),
    );
    if (keep) matching.push(i);
  }

  const address = (dataRow: number, colIndex: number): string =>
    a1(region.firstDataRow + dataRow, region.firstCol + colIndex);

  // ── no aggregate: return the rows themselves ────────────────────────────
  if (aggregate === 'none') {
    const page = matching.slice(offset, offset + limit);
    const cells: string[] = [];
    for (const i of page) {
      for (let c = 0; c < region.columns.length && cells.length < PROVENANCE_CELL_CAP; c++) {
        cells.push(address(i, c));
      }
    }
    return {
      result: null,
      matchedRows: matching.length,
      rows: page.map((i) => region.rows[i]!),
      rowIndices: page,
      groups: [],
      provenance: {
        sheet: region.sheet,
        cells,
        cellCount: page.length * region.columns.length,
        excluded: [],
      },
      moreAvailable: offset + page.length < matching.length,
      nextOffset: offset + page.length < matching.length ? offset + page.length : null,
    };
  }

  // ── count needs no target column, but it does need grouping ─────────────
  //
  // This used to return before grouping was applied, so "how many by region"
  // answered with one total and no breakdown — and its provenance claimed a cell
  // count while naming no cells, which made explaining a count read as nonsense.
  // A count reads the rows it counted, so its evidence is those rows' identifying
  // cells.
  if (aggregate === 'count') {
    const identifying = region.labelColumn ?? 0;
    const countedCells = matching
      .slice(0, PROVENANCE_CELL_CAP)
      .map((i) => address(i, identifying));
    const countProvenance: Provenance = {
      sheet: region.sheet,
      cells: countedCells,
      cellCount: matching.length,
      excluded: [],
    };

    if (!spec.groupBy) {
      return {
        result: matching.length,
        matchedRows: matching.length,
        rows: [],
        rowIndices: [],
        groups: [],
        provenance: countProvenance,
        moreAvailable: false,
        nextOffset: null,
      };
    }

    const by = resolveColumn(region, spec.groupBy);
    const tally = new Map<string, number>();
    for (const i of matching) {
      const key = String(region.rows[i]![by.i] ?? '(blank)');
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const all: GroupResult[] = [...tally.entries()]
      .map(([key, n]) => ({ key, value: n, rowCount: n }))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const page = all.slice(offset, offset + limit);

    return {
      result: matching.length,
      matchedRows: matching.length,
      rows: [],
      rowIndices: [],
      groups: page,
      provenance: countProvenance,
      moreAvailable: offset + page.length < all.length,
      nextOffset: offset + page.length < all.length ? offset + page.length : null,
    };
  }

  // ── numeric aggregates ──────────────────────────────────────────────────
  if (!spec.aggregateColumn) {
    throw new QueryError(
      `A ${aggregate} needs to know which column to work on.`,
      `Ask which column: ${region.columns.filter((c) => c.sum !== undefined).map((c) => c.spoken).join(', ') || 'this table has no numeric columns'}.`,
    );
  }
  const target = resolveColumn(region, spec.aggregateColumn);
  if (target.sum === undefined) {
    throw new QueryError(
      `"${target.spoken}" holds ${target.kind === 'mixed' ? 'a mix of text and numbers' : target.kind}, so it cannot be totalled.`,
      `Numeric columns here: ${region.columns.filter((c) => c.sum !== undefined).map((c) => c.spoken).join(', ') || 'none'}.`,
    );
  }

  const groupCol = spec.groupBy ? resolveColumn(region, spec.groupBy) : null;

  const excluded: ExcludedCell[] = [];
  const usedCells: string[] = [];
  const buckets = new Map<string, number[]>();

  for (const i of matching) {
    const cell = region.rows[i]![target.i] ?? null;
    const n = asNumber(cell);
    const addr = address(i, target.i);
    if (n === null) {
      excluded.push({ address: addr, reason: blank(cell) ? 'empty' : `not a number ("${String(cell)}")` });
      continue;
    }
    if (usedCells.length < PROVENANCE_CELL_CAP) usedCells.push(addr);
    const key = groupCol ? String(region.rows[i]![groupCol.i] ?? '(blank)') : '';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(n);
    else buckets.set(key, [n]);
  }

  const reduce = (values: readonly number[]): number | null => {
    if (values.length === 0) return null;
    switch (aggregate) {
      case 'sum': return values.reduce((a, b) => a + b, 0);
      case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
      case 'min': return Math.min(...values);
      case 'max': return Math.max(...values);
      default: return null;
    }
  };

  const provenance: Provenance = {
    sheet: region.sheet,
    cells: usedCells,
    cellCount: matching.length - excluded.length,
    excluded,
  };

  if (!groupCol) {
    return {
      result: reduce(buckets.get('') ?? []),
      matchedRows: matching.length,
      rows: [],
      rowIndices: [],
      groups: [],
      provenance,
      moreAvailable: false,
      nextOffset: null,
    };
  }

  const all: GroupResult[] = [...buckets.entries()]
    .map(([key, values]) => ({ key, value: reduce(values), rowCount: values.length }))
    .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));

  const page = all.slice(offset, offset + limit);
  return {
    result: null,
    matchedRows: matching.length,
    rows: [],
    rowIndices: [],
    groups: page,
    provenance,
    moreAvailable: offset + page.length < all.length,
    nextOffset: offset + page.length < all.length ? offset + page.length : null,
  };
}

/** The label to speak for one data row, using the region's nominated label column. */
export function rowLabel(region: IndexRegion, dataRow: number): string | null {
  if (region.labelColumn === null) return null;
  const v = region.rows[dataRow]?.[region.labelColumn] ?? null;
  return blank(v) ? null : String(v);
}
