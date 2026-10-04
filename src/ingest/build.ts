/**
 * Grid → index. The offline half of the system, where all the inference happens.
 */

import { analyseHeader, MAX_HEADER_ROWS, resolveMerges } from '../table/header.ts';
import { materialise } from '../table/materialise.ts';
import {
  asDate,
  asNumber,
  detectRegions,
  numberConvention,
  parseDateText,
  readNumber,
  speakDate,
  stronglyDecided,
  type Grid,
} from '../table/infer.ts';
import { a1, isBlank, type CellValue } from '../table/model.ts';
import {
  INDEX_VERSION,
  slugify,
  slugifySheet,
  titleize,
  uniqueId,
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

interface RawRegion {
  readonly startRow: number;
  readonly endRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
}

type Convention = 'dot' | 'comma';

/**
 * What the file as a whole says about how it writes numbers, for the columns whose own
 * values cannot say. `from` records the kind of evidence, because the two kinds settle
 * different questions: numbers the file writes unambiguously elsewhere say which mark
 * is the decimal point, while a comma delimiter says only that the comma is not.
 */
interface FileNumbers {
  readonly convention: Convention | null;
  readonly from: 'values' | 'delimiter' | null;
}

interface NumberProblem {
  readonly column: number;
  /**
   * `conflicting`: the column shows both conventions. `guessed`: nothing decided it and
   * the familiar reading was kept. `borrowed`: the rest of the file decided it, and the
   * reading differs from the familiar one. `money`: a Vietnamese heading naming an
   * amount of money decided it.
   */
  readonly problem: 'conflicting' | 'guessed' | 'borrowed' | 'money';
  readonly example: string | null;
  readonly convention: Convention;
}

/**
 * A currency named in a column's heading: "Giá (VNĐ)", "Price ($)", "Amount in EUR",
 * "Số tiền (đồng)". It settles the column's ambiguous numbers the way a sign on the
 * value does — a currency has two minor digits at most, so "45.000" under "Giá (VNĐ)"
 * is forty-five thousand dong. The words are matched whole: "Đơn giá" starts with a
 * đ that is not the dong. The dong without its marks, "dong", is also a name — a rep
 * called Dong Li heads his own column in a sheet of sales by rep — so it counts only
 * where a currency goes: "(dong)", "in dong", "Amount, dong".
 */
const HEADING_CURRENCY =
  /[$£€¥₫]|(?<![\p{L}\p{N}])(?:VNĐ|VND|USD|EUR|GBP|đồng|đ)(?![\p{L}\p{N}])|(?:\(\s*dong\s*\)|(?<![\p{L}\p{N}])in\s+dong|[,/]\s*dong)(?![\p{L}\p{N}])/iu;

/**
 * A Vietnamese heading that names an amount of money: "Số tiền", "Thành tiền", "Đơn giá",
 * "Lương", "Chi phí", "Doanh thu". In a file written in Vietnamese, where the dot groups
 * thousands and the dong has no minor unit, "45.000" under one of these is forty-five
 * thousand dong. Read with the dot as a decimal point, a household's spending sheet —
 * the most ordinary file this audience has — totalled 685 where it spent 685 thousand.
 * Not "Tỷ giá", an exchange rate, nor "Chỉ số giá", a price index, which have decimals,
 * nor "Đánh giá", a rating. "Giá trị" is a value of any kind — "Giá trị đo", a
 * measurement — and names money only with what it is the value of: "Giá trị hợp đồng".
 */
const VN_MONEY_HEADING =
  /(?<![\p{L}\p{N}])(?:tiền|(?<!(?:tỷ|tỉ|đánh|chỉ\s+số)\s+)giá(?!\s+trị(?![\p{L}\p{N}]))|giá\s+trị\s+(?:hợp\s+đồng|đơn\s+hàng|giao\s+dịch|hóa\s+đơn|hoá\s+đơn|thanh\s+toán|tài\s+sản|hàng\s+hóa|hàng\s+hoá|còn\s+lại)|lương|chi\s+phí|phí|doanh\s+thu|doanh\s+số|lợi\s+nhuận|thu\s+nhập|chi\s+tiêu|phụ\s+cấp|thưởng|thực\s+lĩnh|thực\s+nhận|tạm\s+ứng|ngân\s+sách|số\s+dư|công\s+nợ)(?![\p{L}\p{N}])/iu;
/**
 * A heading that names a rate, a score or a coefficient, whatever money word follows:
 * "Tỷ lệ phí" (a fee rate), "Điểm thưởng" (bonus points), "Hệ số lương" (a salary
 * coefficient), "Phí (%)". Those carry decimals: "1.125" there is one and an eighth.
 */
const VN_NOT_MONEY = /^(?:tỷ\s+lệ|tỉ\s+lệ|điểm|hệ\s+số|chỉ\s+số|lãi\s+suất)(?![\p{L}\p{N}])|%/iu;

/**
 * Settle each column's decimal convention, and rewrite the values whose reading it
 * changes so every later reader agrees without knowing about conventions.
 *
 * A column's own values decide first. Only a column made entirely of ambiguous values
 * ("1.234", "12,500") borrows the file's convention, and whenever that borrowed reading
 * differs from the familiar dot reading it is said out loud: a factor of a thousand is
 * exactly the error a listener has no way to catch.
 *
 * Only the ambiguous values are rewritten — "1.234" in a column read with dots grouping
 * thousands becomes "1234" — and the rest of the text, currency sign included, is kept.
 * The rewrite goes into the stored rows, which is what lets the query engine, a spoken
 * correction's re-read and the column statistics all read the same number from the same
 * cell.
 */
function settleNumbers(
  allRows: Json[][],
  width: number,
  file: FileNumbers,
  headings: readonly string[],
  vietnamese: boolean,
): { problems: NumberProblem[]; conventions: (Convention | null)[] } {
  const problems: NumberProblem[] = [];
  const conventions: (Convention | null)[] = [];
  for (let i = 0; i < width; i++) {
    const own = numberConvention(allRows.map((row) => row[i] ?? null));
    if (own.conflicting) {
      problems.push({ column: i, problem: 'conflicting', example: own.example, convention: own.convention });
      conventions.push(null);
      continue;
    }
    let convention = own.convention;
    if (own.ambiguous) {
      // Which mark the ambiguous values carry: "1.234" or "12,500".
      const dotted = /\.\d{3}\b/.test(own.example ?? '');
      convention = file.convention ?? 'dot';
      let problem: NumberProblem['problem'] | null;
      const heading = (headings[i] ?? '').normalize('NFC');
      if (HEADING_CURRENCY.test(heading)) {
        // The heading names a currency: the one mark in "45.000" groups thousands.
        convention = dotted ? 'comma' : 'dot';
        problem = null;
      } else if (convention === 'comma') {
        problem = 'borrowed';
      } else if (
        dotted &&
        vietnamese &&
        // The file's own figures write the dot as a decimal point ("2.5 kg"), and that
        // evidence outranks a heading's wording.
        !(file.from === 'values' && file.convention === 'dot') &&
        VN_MONEY_HEADING.test(heading) &&
        !VN_NOT_MONEY.test(heading.trim())
      ) {
        // The heading names money in a Vietnamese file: the dot groups thousands. Said
        // aloud unless every such value ends in ".000", which nobody writes for 45.
        convention = 'comma';
        const thousands = allRows.every((row) => {
          const v = row[i] ?? null;
          return typeof v !== 'string' || readNumber(v)?.style !== 'ambiguous' || /\.000(?!\d)/.test(v);
        });
        problem = thousands ? null : 'money';
      } else if (dotted) {
        // "1.234" read as one point two: only the file's own dot decimals make that
        // safe. A comma delimiter does not — a sheet in Vietnamese exports "45.000".
        problem = file.from === 'values' ? null : 'guessed';
      } else {
        // "12,500" read as twelve thousand five hundred: any evidence at all will do.
        problem = file.from === null ? 'guessed' : null;
      }
      if (problem) problems.push({ column: i, problem, example: own.example, convention });
    }
    conventions.push(convention);

    if (convention !== 'comma') continue;
    for (const row of allRows) {
      const v = row[i] ?? null;
      if (typeof v !== 'string') continue;
      const r = readNumber(v, 'comma');
      if (r?.style !== 'ambiguous') continue;
      const rewritten = v.replace(/\d{1,3}[.,]\d{3}/, String(Math.abs(r.value)));
      row[i] = asNumber(rewritten) === r.value ? rewritten : r.value;
    }
  }
  return { problems, conventions };
}

/**
 * Which convention the file shows, from the evidence that deserves a vote.
 *
 * A column votes only when at least two of its values decide the convention and none
 * decides the other way; one stray "8,10" in a column of shoe sizes had made a whole
 * American file comma-decimal, and every "$1,200" in it $1.20. Percentages are left out:
 * an Excel percent cell reaches here as text this reader wrote itself.
 *
 * The delimiter outranks weak votes. A comma-separated file does not use the comma as
 * its decimal point — only values that settle it beyond doubt ("1.250.000", "€1.200")
 * outvote that — and a semicolon-separated one almost always does.
 */
function fileNumbersOf(read: ReadResult): FileNumbers {
  let dot = 0;
  let comma = 0;
  let strongComma = 0;
  for (const sheet of read.sheets) {
    const width = sheet.grid.reduce((w, r) => Math.max(w, r.length), 0);
    for (let c = 0; c < width; c++) {
      const tally = { dot: 0, comma: 0, strongComma: 0 };
      for (const row of sheet.grid) {
        const v = row[c] ?? null;
        if (typeof v !== 'string' || v.trim().endsWith('%')) continue;
        const style = readNumber(v)?.style;
        if (style === 'dot') tally.dot++;
        else if (style === 'comma') {
          tally.comma++;
          if (stronglyDecided(v)) tally.strongComma++;
        }
      }
      if (tally.dot >= 2 && tally.comma === 0) dot++;
      if (tally.comma >= 2 && tally.dot === 0) {
        comma++;
        if (tally.strongComma >= 2) strongComma++;
      }
    }
  }
  const votes: Convention | null = dot > 0 && comma === 0 ? 'dot' : comma > 0 && dot === 0 ? 'comma' : null;
  const fromValues = (convention: Convention | null): FileNumbers => ({
    convention,
    from: convention ? 'values' : null,
  });

  if (read.delimiter === ',') {
    return strongComma > 0 && dot === 0
      ? { convention: 'comma', from: 'values' }
      : votes === 'dot'
        ? fromValues('dot')
        : { convention: 'dot', from: 'delimiter' };
  }
  if (read.delimiter === ';') {
    if (votes) return fromValues(votes);
    return dot > 0 ? fromValues(null) : { convention: 'comma', from: 'delimiter' };
  }
  return fromValues(votes);
}

/**
 * Letters only Vietnamese writes — not the â, ê and ô French and Portuguese share: a
 * file in Vietnamese writes its dates day first.
 */
const VIETNAMESE = /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu;
/**
 * Money written the way day-first countries write it. "dong" without its marks only
 * after a figure, "45.000 dong": on its own it is a name — Dong Li, Kim Dong-hyun — and
 * one such rep in an American sales sheet turned every "02/03/2026" into 2 March.
 */
const LOCAL_MONEY = /[₫€]|(?<![\p{L}\p{N}])(?:VNĐ|VND|đồng)(?![\p{L}\p{N}])|\d\s?dong(?![\p{L}\p{N}])/iu;

/**
 * Is the file written in Vietnamese? Judged by the lines above the first figure on each
 * sheet — the title and the headings — not by the names in the records: an American
 * sales sheet with reps called Bảo and Dũng still writes its dates month first.
 */
function vietnameseHeadings(read: ReadResult): boolean {
  for (const sheet of read.sheets) {
    for (const row of sheet.grid) {
      if (row.some((v) => typeof v === 'number' || v instanceof Date || asNumber(v) !== null || asDate(v) !== null)) break;
      if (row.some((v) => typeof v === 'string' && VIETNAMESE.test(v.trim()))) return true;
    }
  }
  return false;
}

/**
 * Which way round the file as a whole writes its dates, for columns whose own values
 * cannot say ("01/09/2026" and nothing past the 12th).
 *
 * Read month first by default, a Vietnamese sales export's 1 September became 9
 * January, silently, and a filter on September found nothing. Day first is chosen when
 * the file shows it: a date elsewhere that only fits day first, a dotted date, a
 * semicolon delimiter or comma decimals, dong or euro amounts, or Vietnamese headings.
 * A date anywhere that only fits month first keeps the file month first.
 */
function fileDateOrder(read: ReadResult, numbers: FileNumbers, vietnamese: boolean): 'dmy' | null {
  let dayFirst = 0;
  let monthFirst = 0;
  let dotted = 0;
  let local = 0;
  for (const sheet of read.sheets) {
    for (const row of sheet.grid) {
      for (const v of row) {
        if (typeof v !== 'string') continue;
        const t = v.trim();
        const m = /^(\d{1,2})([/\-.])(\d{1,2})[/\-.]\d{2,4}\b/.exec(t);
        if (m) {
          const a = Number(m[1]);
          const b = Number(m[3]);
          if (m[2] === '.') dotted++;
          if (a > 12 && b <= 12) dayFirst++;
          else if (b > 12 && a <= 12) monthFirst++;
          continue;
        }
        if (LOCAL_MONEY.test(t)) local++;
      }
    }
  }
  if (monthFirst > 0 && dayFirst === 0) return null;
  if (dayFirst > 0 || dotted > 0 || local > 0 || vietnamese) return 'dmy';
  return read.delimiter === ';' || numbers.convention === 'comma' ? 'dmy' : null;
}

function buildRegionIndex(
  sheet: ReadSheet,
  raw: RawRegion,
  id: string,
  titleAbove: string | null,
  file: FileNumbers,
  fileDates: 'dmy' | null,
  vietnamese: boolean,
): { region: IndexRegion; warnings: string[] } {
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

  const headingRows = allRows.slice(0, Math.min(analysis.chosen.rows, Math.max(0, allRows.length - 1)));
  const headings = Array.from({ length: width }, (_, i) =>
    headingRows.map((row) => (row[i] === null || row[i] === undefined ? '' : String(row[i]))).join(' '),
  );
  const settled = settleNumbers(allRows, width, file, headings, vietnamese);
  const numberProblems = settled.problems;
  const m = materialise(allRows, raw.startRow, raw.firstCol, analysis.chosen.rows, fileDates ?? 'mdy');

  // Every date in the index is an ISO day, the stored rows included: a correction
  // re-reads these, and "4/7/2026" must not be decided afresh, perhaps the other way
  // round, by whatever reads it next.
  const headerCount = m.headerRows.length;
  m.columns.forEach((c) => {
    if (c.kind !== 'date') return;
    m.rows.forEach((row, r) => {
      const target = allRows[headerCount + r];
      if (target) target[c.i] = row[c.i] ?? null;
    });
  });

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
  // Columns that share one heading, with a label among their first records over the
  // numbers below, are the mark of a heading block read too shallow: its lower heading
  // rows ("2025", "H1") have become records, and four columns are "FY Revenue", "FY
  // Revenue 2" and so on. That is doubt however the rows scored, and one more heading
  // row is the reading to offer.
  const tooShallow = m.ambiguousColumns.some(
    (i) =>
      m.columns[i]?.kind === 'mixed' &&
      m.rows.slice(0, 2).some((row) => {
        const v = row[i] ?? null;
        return typeof v === 'string' && v.trim() !== '' && asNumber(v) === null && asDate(v) === null;
      }),
  );
  const ambiguous = analysis.ambiguous || tooShallow;
  if (tooShallow && chosen.headerRows < MAX_HEADER_ROWS && !alternatives.some((a) => a.headerRows === chosen.headerRows + 1)) {
    alternatives.unshift({
      headerRows: chosen.headerRows + 1,
      score: 0.5,
      why: 'take one more row as a heading level',
    });
  }
  // An uncertain reading must always name something else it could be; "I am not
  // certain" with nothing to offer leaves the listener no way to fix it.
  if (ambiguous && alternatives.length === 0) {
    alternatives.push(
      chosen.headerRows === 0
        ? { headerRows: 1, score: 0.5, why: 'read the first row as labels' }
        : { headerRows: 0, score: Math.round((1 - chosen.score) * 100) / 100, why: 'treat every row as data' },
    );
  }

  // Each column's own caveat is also kept on the column, so every figure computed from
  // it can say so; the file's warnings still carry them all, for describe.
  const notes = new Map<number, string>();
  const warnings = numberProblems.map(({ column, problem, example, convention }) => {
    const name = m.columns[column]?.spoken ?? `column ${column + 1}`;
    if (problem === 'conflicting') {
      notes.set(column, `The numbers in ${name} mix two styles, so this may be wrong.`);
      return `The numbers in ${name} on "${sheet.name}" mix two styles, some with a comma as the decimal point and some with a dot, so totals there may be wrong.`;
    }
    const mark = /\.\d{3}\b/.test(example ?? '') ? 'dot' : 'comma';
    // Read as a decimal point, or as a thousands separator, under the chosen convention.
    const decimal = (mark === 'dot') === (convention === 'dot');
    const how = decimal ? `with the ${mark} as a decimal point` : `with the ${mark} separating thousands`;
    const where =
      problem === 'borrowed'
        ? ', as the rest of the file writes them'
        : problem === 'money'
          ? ', since the heading names an amount of money'
          : '';
    const otherwise = decimal
      ? `If the ${mark} separates thousands there, those figures are a thousand times larger.`
      : `If the ${mark} is a decimal point there, those figures are a thousand times smaller.`;
    notes.set(
      column,
      `I read "${example}" in ${name} ${how}; if that is wrong, this is a thousand times ${decimal ? 'larger' : 'smaller'}.`,
    );
    return `I read numbers like "${example}" in ${name} on "${sheet.name}" ${how}${where}. ${otherwise}`;
  });
  for (const g of m.dateGuesses) {
    const name = m.columns[g.column]?.spoken ?? `column ${g.column + 1}`;
    const day = parseDateText(g.example, g.order);
    const as = day ? `, as ${speakDate(day)}` : '';
    warnings.push(
      g.order === 'dmy'
        ? `I read dates like "${g.example}" in ${name} on "${sheet.name}" day first${as}, the way the rest of the file is written. If the month comes first there, the day and month are swapped.`
        : `I read dates like "${g.example}" in ${name} on "${sheet.name}" month first${as}. Nothing in the file shows which comes first; if the day does, the day and month are swapped.`,
    );
  }
  const columns = m.columns.map((c) => {
    const comma = settled.conventions[c.i] === 'comma' && c.sum !== undefined;
    const note = c.sum !== undefined ? notes.get(c.i) : undefined;
    if (!comma && !note) return c;
    return { ...c, ...(comma ? { numberConvention: 'comma' as const } : {}), ...(note ? { numberNote: note } : {}) };
  });

  const region: IndexRegion = {
    id,
    sheet: sheet.name,
    title: titleAbove,
    headerRows: m.headerRows,
    // Same number as structure.chosen.score, kept so older readers do not break.
    headerConfidence: chosen.score,
    structure: { chosen, alternatives, ambiguous, revision: 1 },
    startRow: raw.startRow,
    allRows,
    firstDataRow: m.firstDataRow,
    firstCol: raw.firstCol,
    rowCount: m.rows.length,
    columns,
    rows: m.rows,
    inherited,
    labelColumn: m.labelColumn,
    ambiguousColumns: m.ambiguousColumns,
    ...(m.summaryRows.length ? { summaryRows: m.summaryRows } : {}),
  };
  return { region, warnings };
}

/** The non-blank cells of one row within a region's columns, as trimmed text. */
function filledCells(
  sheet: ReadSheet,
  row: number,
  region: { firstCol: number; lastCol: number },
): { c: number; v: CellValue; text: string }[] {
  const cells = sheet.grid[row] ?? [];
  const out: { c: number; v: CellValue; text: string }[] = [];
  for (let c = region.firstCol; c <= region.lastCol; c++) {
    const v = cells[c] ?? null;
    if (!isBlank(v)) out.push({ c, v, text: String(v instanceof Date ? v.toISOString() : v).trim() });
  }
  return out;
}

/**
 * The row is one piece of text starting at the region's left edge: a single cell, or
 * one horizontal merge anchored there. ExcelJS repeats a merged value in every cell
 * the merge covers, so "Merge & Center" arrives as the same text several times over.
 */
function loneText(sheet: ReadSheet, row: number, region: { firstCol: number; lastCol: number }): string | null {
  const filled = filledCells(sheet, row, region);
  const first = filled[0];
  if (!first || first.c !== region.firstCol) return null;
  if (filled.length === 1) return first.text;
  const same = filled.every((f) => f.text === first.text);
  const merge = sheet.merges.find(
    (m) => m.topRow === row && m.bottomRow === row && m.leftCol === region.firstCol && m.rightCol > m.leftCol,
  );
  return same && merge && filled.every((f) => f.c <= merge.rightCol) ? first.text : null;
}

/**
 * A line that names the document. In Vietnamese the kind of document comes first:
 * "BẢNG LƯƠNG THÁNG 9/2026", "Báo cáo doanh thu", "Danh sách học sinh". In English it
 * comes last, in a short line: "Income Statement", "Inventory Report — Warehouse 2",
 * "Q3 Payroll". A long line that merely mentions a report — "Source: finance team
 * monthly report", "Exported from the inventory system" — is not one.
 */
const VN_DOCUMENT = /^(?:bảng|báo\s+cáo|danh\s+sách|sổ|phiếu|bản\s+kê|tổng\s+hợp|kế\s+hoạch|dự\s+toán|thống\s+kê)(?![\p{L}\p{N}])/iu;
const EN_DOCUMENT = /^(?:report|statement|summary|schedule|ledger|register|budget|invoice|inventory|payroll|roster|timesheet|gradebook)$/iu;

/**
 * A line that names who issued the document — a company, an office, the national
 * motto at the head of every Vietnamese form — and one that says what the figures are
 * measured in or when they were taken. Neither is a title while another line is.
 */
const ISSUER_LINE =
  /^(?:công\s+ty|cty|tổng\s+công\s+ty|tập\s+đoàn|ngân\s+hàng|chi\s+nhánh|cửa\s+hàng|trường|ủy\s+ban|uỷ\s+ban|ubnd|sở|bộ|phòng|cộng\s+hòa|cộng\s+hoà|độc\s+lập)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:inc|ltd|llc|plc|corp|corporation|company|co|gmbh|jsc|limited)\.?$/iu;
const META_LINE = /^(?:đơn\s+vị\s+tính|đvt|đơn\s+vị|unit|units|currency|exported|printed|generated|as\s+of|ngày|date|kỳ|period)(?![\p{L}\p{N}])/iu;
/** "Budget owner: Jane Doe", "Địa chỉ: 12 Lê Lợi": a short label, then what it labels. */
const LABELLED_LINE = /^[^:]{1,30}:\s*\S/u;
/** A whole date: "30/09/2026", "2026-09-30", "ngày 30 tháng 9", "30 September 2026". */
const DATE_IN_LINE =
  /(?<!\d)\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}(?!\d)|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|ngày\s+\d{1,2}\s+tháng|(?<!\d)\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}|(?<![\p{L}\p{N}])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/iu;
/**
 * Who made it, not what it is: "Prepared by Finance", "… generated by J. Smith". Not
 * "Sales by Region": "by" names a person only after a verb of making, or before
 * initials.
 */
const BY_NAME =
  /(?<![\p{L}\p{N}])(?:prepared|generated|compiled|created|exported|printed|submitted|approved|reviewed|made|written|updated|issued|signed|owned|maintained)\s+by(?![\p{L}\p{N}])/iu;
const BY_INITIALS = /(?<![\p{L}\p{N}])by\s+(?:\p{Lu}\.\s?)+\p{Lu}/u;

/**
 * A line that reads as a title at all: not an issuer, a unit or date line, a source or
 * note, a "Label: value" pair, a dated line, or a byline.
 */
function titleLike(line: string): boolean {
  const l = line.normalize('NFC').trim();
  return !(
    ISSUER_LINE.test(l) ||
    META_LINE.test(l) ||
    NOTE_LEAD.test(l) ||
    LABELLED_LINE.test(l) ||
    DATE_IN_LINE.test(l) ||
    BY_NAME.test(l) ||
    BY_INITIALS.test(l)
  );
}

const isDocumentLine = (line: string): boolean => {
  const l = line.normalize('NFC').trim();
  if (!titleLike(l)) return false;
  if (VN_DOCUMENT.test(l)) return true;
  const words = l.match(/\p{L}+/gu) ?? [];
  return words.length <= 8 && words.slice(-3).some((w) => EN_DOCUMENT.test(w));
};

/** A unit, date or source line: what it says is about the figures, not their name. */
const metaLine = (line: string): boolean => {
  const l = line.normalize('NFC').trim();
  return META_LINE.test(l) || NOTE_LEAD.test(l);
};

/**
 * Which of a report's heading lines is its title.
 *
 * The first, unless the first names who issued the report. On the standard Vietnamese
 * report the first line is the company or the national motto: "CÔNG TY TNHH ABC" over
 * "BẢNG LƯƠNG THÁNG 9/2026", so the table was spoken of by its issuer's name and its
 * real title kept as a note. Then a line that names the document wins; failing that,
 * the first line that reads as a title; failing that, the first line. Under any other
 * first line — "Sales by Region" over "Report generated 30/09/2026 by J. Smith" — the
 * first line stays the title, since what comes under a title is about it. The others
 * stay notes, in their order.
 */
function pickTitle(lines: readonly string[]): { title: string; rest: string[] } {
  let at = 0;
  if (ISSUER_LINE.test(lines[0]!.normalize('NFC').trim())) {
    at = lines.findIndex(isDocumentLine);
    if (at < 0) at = lines.findIndex(titleLike);
    if (at < 0) at = 0;
  }
  return { title: lines[at]!, rest: lines.filter((_, k) => k !== at) };
}

/**
 * The lines a report is signed off with. Who prepared, received or approved it — "Người
 * lập biểu", "Người nhận tiền", "Prepared by", "Approved by:" — where to sign, "(Ký, họ
 * tên)", and the date and place, "Hà Nội, ngày 30 tháng 9 năm 2026". Each is the whole
 * cell, or the whole cell up to a colon or a bracket: "Approved by board" is a task's
 * status, not a sign-off.
 */
const SIGNER =
  /^(?:(?:tm|kt|tl|tuq|q|p)\.\s*)?(?:người\s+(?:lập(?:\s+(?:biểu|bảng|phiếu))?|nhận(?:\s+(?:tiền|hàng))?|giao(?:\s+hàng)?|duyệt|kiểm\s+tra|nộp(?:\s+tiền)?|mua\s+hàng|bán\s+hàng|đại\s+diện)|lập\s+biểu|xác\s+nhận(?:\s+của\s+.+)?|(?:prepared|approved|checked|reviewed|verified|authori[sz]ed|received|certified|submitted|signed)\s+by)\s*(?::.*|\(.*\))?$/isu;
const SIGN_HERE =
  /^\(\s*(?:ký|đã\s+ký|signature|signed|sign)(?![\p{L}\p{N}]).*\)$|^ký(?:\s+tên|,?\s+(?:ghi\s+rõ\s+)?họ\s+tên)(?![\p{L}\p{N}])|^signature\s*:?$/isu;
const SIGN_DATE = /ngày\s*(?:\d{1,2}|[.…_]+)\s*tháng\s*(?:\d{1,2}|[.…_]+)\s*năm/iu;
/**
 * A job title that signs a Vietnamese report: "Kế toán trưởng", "Thủ quỹ", "Giám đốc",
 * "KT. GIÁM ĐỐC". Each is as often a record's position beside a name, so it counts only
 * in a row where every other cell signs off too, and only beside a line that is plainly
 * a sign-off.
 */
const SIGNING_TITLE =
  /^(?:(?:tm|kt|tl|tuq|q|p)\.\s*)?(?:(?:phó\s+)?(?:tổng\s+)?giám\s+đốc|ban\s+giám\s+đốc|kế\s+toán(?:\s+trưởng)?|thủ\s+trưởng(?:\s+đơn\s+vị)?|thủ\s+quỹ|thủ\s+kho|trưởng\s+(?:phòng|ban|bộ\s+phận)(?:\s+\S+){0,3}|hiệu\s+trưởng|chủ\s+tịch|giáo\s+viên\s+chủ\s+nhiệm)\s*(?::.*|\(.*\))?$/isu;

/** What a cell of a sign-off row is: a plain sign-off line, a title, a date, or not one. */
function signOffKind(v: CellValue): 'line' | 'title' | 'date' | null {
  if (v instanceof Date) return 'date';
  if (typeof v !== 'string' || asNumber(v) !== null) return null;
  const t = v.normalize('NFC').trim();
  if (SIGNER.test(t) || SIGN_HERE.test(t) || SIGN_DATE.test(t)) return 'line';
  return SIGNING_TITLE.test(t) ? 'title' : null;
}

/**
 * Is this row part of a sign-off, judged as a row? Every filled cell must sign off —
 * "Người lập biểu | Kế toán trưởng | Giám đốc", "(Ký, họ tên) | (Ký, họ tên)" — so a
 * record whose position is "Kế toán trưởng" beside the name "Chi" stays a record. The
 * counts of its plain sign-off lines and of all its sign-off cells, or null.
 *
 * Except a name written in the cell after its own sign-off label: "Prepared by: | Jordan
 * Lee | Approved by: | Sam Park". Each label and its name are one sign-off line. Not
 * read as one, the names became records — "list the categories" named Jordan Lee — or,
 * after a blank row, a second table every answer apologised for.
 */
function signOffRow(cells: readonly { v: CellValue }[]): { lines: number; cells: number } | null {
  let lines = 0;
  let count = 0;
  let named = false;
  for (const f of cells) {
    const kind = signOffKind(f.v);
    if (kind === null) {
      // The name beside a label that asks for one; a figure or a second word is not.
      if (!named || typeof f.v !== 'string' || asNumber(f.v) !== null || asDate(f.v) !== null) return null;
      named = false;
      continue;
    }
    named = kind === 'line' && typeof f.v === 'string' && SIGNER_LABEL.test(f.v.normalize('NFC').trim());
    if (kind === 'date') continue;
    count++;
    if (kind === 'line') lines++;
  }
  return count > 0 ? { lines, cells: count } : null;
}

/** A sign-off label that a name is written beside: "Prepared by:", "Approved by", "Signature:". */
const SIGNER_LABEL =
  /^(?:(?:prepared|approved|checked|reviewed|verified|authori[sz]ed|received|certified|submitted|signed)\s+by|người\s+(?:lập(?:\s+(?:biểu|bảng|phiếu))?|nhận(?:\s+(?:tiền|hàng))?|giao(?:\s+hàng)?|duyệt|kiểm\s+tra)|signature|chữ\s+ký)\s*:?$/iu;

/** Text, or a date: what a sign-off is written in. A figure means it is not one. */
const signOffCell = (v: CellValue): boolean => v instanceof Date || (typeof v === 'string' && asNumber(v) === null);

/**
 * Do these rows, top to bottom, read as a sign-off block? It opens with a sign-off row,
 * holds at least two sign-off cells, one of them plainly so, and at most two other
 * rows — the names written under the titles. A second small table under the first,
 * "Order | Status" over "Received by customer", opens with its headings and is kept.
 */
function signOffBlock(rows: readonly (readonly { v: CellValue }[])[]): boolean {
  let lines = 0;
  let cells = 0;
  let other = 0;
  let opened = false;
  for (const row of rows) {
    if (!row.length) continue;
    const s = signOffRow(row);
    if (!opened && !s) return false;
    opened = true;
    if (s) {
      lines += s.lines;
      cells += s.cells;
    } else {
      other++;
    }
  }
  return lines >= 1 && cells >= 2 && other <= 2;
}

/**
 * Is everything left on the sheet the report's sign-off?
 *
 * A Vietnamese payroll ends with the date, "Người lập biểu", "Kế toán trưởng", "Giám
 * đốc", "(Ký, họ tên)" and the names, set apart by blank columns. Each block became a
 * table of its own: the file "held 4 tables", describe named three that do not exist,
 * and every answer added "That covers only the first of 4 tables". It is the sign-off
 * when everything left is a few lines of text that read as one, taken row by row
 * across the blocks — or when a sign-off was already found on this sheet, and these
 * are no more than two rows of names under it.
 */
function signOffRest(sheet: ReadSheet, rest: readonly RawRegion[], signing: boolean): boolean {
  // A sign-off is a handful of blocks; asking this of a long run of them at every step
  // would be quadratic in a sheet of scattered notes.
  if (rest.length > 12) return false;
  for (const r of rest) {
    if (r.endRow - r.startRow + 1 > 6) return false;
    for (let row = r.startRow; row <= r.endRow; row++) {
      if (!filledCells(sheet, row, r).every((f) => signOffCell(f.v))) return false;
    }
  }
  const top = Math.min(...rest.map((r) => r.startRow));
  const bottom = Math.max(...rest.map((r) => r.endRow));
  const rows: { v: CellValue }[][] = [];
  for (let row = top; row <= bottom; row++) {
    rows.push(rest.filter((r) => r.startRow <= row && row <= r.endRow).flatMap((r) => filledCells(sheet, row, r)));
  }
  if (signing) return rows.filter((row) => row.length && !signOffRow(row)).length <= 2;
  return signOffBlock(rows);
}

/**
 * A sign-off typed straight under the last row, with no blank line between: the first
 * row of it, or null. It is the run of text-only rows at the bottom, from its highest
 * sign-off row down, when that reads as a sign-off block — in a table with figures
 * above it, and with at least a heading and a record left.
 */
function attachedSignOff(sheet: ReadSheet, region: RawRegion): number | null {
  let top: number | null = null;
  for (let row = region.endRow; row > region.startRow + 1; row--) {
    const filled = filledCells(sheet, row, region);
    if (!filled.length || !filled.every((f) => signOffCell(f.v))) break;
    if (signOffRow(filled)) top = row;
  }
  if (top === null) return null;
  const rows: { v: CellValue }[][] = [];
  for (let row = top; row <= region.endRow; row++) rows.push(filledCells(sheet, row, region));
  if (!signOffBlock(rows)) return null;
  return numberColumns(sheet, top, region).size > 0 ? top : null;
}

/**
 * The sign-off as one note, read row by row as it is laid out. "(Ký, họ tên)" says
 * where to sign, not who did, and is left out. A merged cell arrives repeated in each
 * cell it covers and is said once; the same name under two titles is said twice.
 */
function signOffText(sheet: ReadSheet, regions: readonly RawRegion[]): string {
  const top = Math.min(...regions.map((r) => r.startRow));
  const bottom = Math.max(...regions.map((r) => r.endRow));
  const lines: string[] = [];
  for (let row = top; row <= bottom; row++) {
    const cells: string[] = [];
    let last = -2;
    const across = regions.filter((r) => r.startRow <= row && row <= r.endRow).sort((a, b) => a.firstCol - b.firstCol);
    for (const r of across) {
      for (const f of filledCells(sheet, row, r)) {
        const text = f.v instanceof Date ? speakDate(f.v) : f.text;
        const repeated = f.c === last + 1 && cells[cells.length - 1] === text;
        last = f.c;
        if (/^\(.*\)$/u.test(text) || repeated) continue;
        // "Prepared by:" and the name beside it are one line: "Prepared by: Jordan Lee".
        if (cells.length && /:$/u.test(cells[cells.length - 1]!) && signOffKind(f.v) === null) {
          cells[cells.length - 1] = `${cells[cells.length - 1]} ${text}`;
          continue;
        }
        cells.push(text);
      }
    }
    if (cells.length) lines.push(cells.join('; '));
  }
  return lines.join('. ');
}

/**
 * A single non-blank row sitting immediately above a region, spanning fewer columns
 * than the region, is a title — the "Q3 Regional Sales" line. Consume it so it does
 * not get mistaken for a header row, and use it as the region's spoken name.
 *
 * Two shapes need care. A title merged and centred across the table is still a
 * title, though it reaches here repeated in every cell of the merge; missed, it became
 * a heading level stuck to the front of every column name. And a lone label to the
 * right of a blank corner in a two-column table — ",Amount" over "North,10", the shape
 * every pandas Series export has — is the value column's heading, not a title: taken
 * as one, it left both columns unnamed.
 *
 * A title often comes with a line or two under it — "Regional Sales, Q3 2026" under the
 * company name, "Unit: dong" under the report title — and the second line became a
 * heading level glued to the first column's name ("Regional Sales, Q3 2026, Region").
 * Lone lines of text straight under the title are kept as notes, as long as a heading
 * row and a record are left below them.
 */
function extractTitle(
  sheet: ReadSheet,
  region: { startRow: number; endRow: number; firstCol: number; lastCol: number },
): { title: string | null; startRow: number; notes: string[] } {
  const none = { title: null, startRow: region.startRow, notes: [] };
  const span = region.lastCol - region.firstCol + 1;
  if (span <= 1 || sheet.grid[region.startRow + 1] === undefined) return none;

  const lone = loneText(sheet, region.startRow, region);
  if (lone !== null) {
    const notes: string[] = [];
    let next = region.startRow + 1;
    while (notes.length < 3 && next + 2 <= region.endRow) {
      const line = loneText(sheet, next, region);
      const cell = sheet.grid[next]?.[region.firstCol] ?? null;
      if (line === null || typeof cell !== 'string' || asNumber(cell) !== null || asDate(cell) !== null) break;
      // A run of lone lines all the way down is a one-column layout, not a title block.
      if (loneText(sheet, next + 1, region) !== null) break;
      notes.push(line);
      next++;
    }
    const picked = pickTitle([lone, ...notes]);
    return { title: picked.title, startRow: next, notes: picked.rest };
  }

  // A single cell set in from the left of a wider table is a title centred by hand.
  const filled = filledCells(sheet, region.startRow, region);
  if (filled.length === 1 && span > 2) return { title: filled[0]!.text, startRow: region.startRow + 1, notes: [] };
  return none;
}

/**
 * The lines of a block that is nothing but lone lines of text: one cell each, or one
 * merge anchored at the left, none of them a number or a date. Null for anything else.
 *
 * A report's heading block — "CÔNG TY TNHH ABC", then "BÁO CÁO DOANH THU THÁNG 9/2026",
 * then a blank row — is the standard Vietnamese layout, and read as a table of its own
 * it became "table 1", a one-column table every default question landed on.
 */
function textLines(sheet: ReadSheet, found: RawRegion): string[] | null {
  if (found.endRow - found.startRow + 1 > 5) return null;
  const lines: string[] = [];
  for (let r = found.startRow; r <= found.endRow; r++) {
    // "Source:" with its text in the next cell is one line too.
    const pair = filledCells(sheet, r, found);
    const labelled =
      pair.length === 2 && pair[0]!.c === found.firstCol && NOTE_LEAD.test(pair[0]!.text) && pair.every((f) => isWords(f.v))
        ? `${pair[0]!.text} ${pair[1]!.text}`
        : null;
    const line = labelled ?? loneText(sheet, r, found);
    const cell = sheet.grid[r]?.[found.firstCol] ?? null;
    if (line === null || typeof cell !== 'string' || asNumber(cell) !== null || asDate(cell) !== null) return null;
    lines.push(line);
  }
  return lines;
}

/**
 * A line of a document's heading: who issued it, the national motto under it, a
 * "Label: value" line, a line that names the document, or a unit or date line.
 */
const headingLine = (line: string): boolean => {
  const l = line.normalize('NFC').trim();
  return ISSUER_LINE.test(l) || MOTTO.test(l) || LABELLED_LINE.test(l) || isDocumentLine(l) || META_LINE.test(l) || DATE_IN_LINE.test(l);
};
/** The motto under "Cộng hòa xã hội chủ nghĩa Việt Nam", however it is dashed. */
const MOTTO = /^độc\s+lập\s*[-–—]\s*tự\s+do\s*[-–—]\s*hạnh\s+phúc$/iu;

/**
 * The regions from `i` on that sit side by side in the same rows, when together they
 * are a document's heading laid out across columns above a table: every one of them
 * lone lines of text, every line a heading line, and a table below. Their lines, read
 * row by row from left to right, and which regions they were; or null.
 */
function headingAcross(
  sheet: ReadSheet,
  raws: readonly RawRegion[],
  i: number,
): { lines: string[]; regions: number[] } | null {
  const first = raws[i]!;
  const group: number[] = [i];
  let bottom = first.endRow;
  for (let k = i + 1; k < raws.length && raws[k]!.startRow <= bottom; k++) {
    group.push(k);
    bottom = Math.max(bottom, raws[k]!.endRow);
  }
  if (group.length < 2) return null;
  const below = raws.slice(group[group.length - 1]! + 1);
  if (!below.some((r) => r.startRow > bottom && r.lastCol > r.firstCol)) return null;
  const blocks = group.map((k) => ({ r: raws[k]!, lines: textLines(sheet, raws[k]!) }));
  if (blocks.some((b) => b.lines === null || !b.lines.every(headingLine))) return null;
  const lines: string[] = [];
  for (let row = first.startRow; row <= bottom; row++) {
    for (const b of [...blocks].sort((x, y) => x.r.firstCol - y.r.firstCol)) {
      if (row >= b.r.startRow && row <= b.r.endRow) lines.push(b.lines![row - b.r.startRow]!);
    }
  }
  return { lines, regions: group };
}

/** Sources, notes and footnotes start like this, in English and in Vietnamese. */
const NOTE_LEAD =
  /^\s*(?:[*†‡¹²³]|(?:source|sources|note|notes|nb|n\.b\.|ghi chú|nguồn|chú thích|lưu ý)(?=[\s:.,\-–—]|$))/iu;

/**
 * Is this row a note written under the table rather than a record in it?
 *
 * "Source: finance export 2026-09" typed straight under the last row became a data
 * row: one more record, an empty cell in every numeric column, and a count that was
 * one too high. A note is one piece of text at the left edge with nothing else on the
 * row, and it reads as a note: it opens like one ("Source:", "Note:", "*"), or it is
 * written as a sentence — a full stop at the end, forty characters or more, and at
 * least twice as long as any label in the column above it.
 *
 * Everything else stays a record, because the two mistakes are not equal. A note
 * counted as a record is heard, and can be questioned; a record taken for a note is cut
 * from the table where no correction can reach it. "International Business Machines"
 * with no figures yet, or the last task on a list with no owner, is a record.
 */
function noteRow(sheet: ReadSheet, row: number, region: RawRegion): string | null {
  const text = loneText(sheet, row, region);
  if (text === null) return noteBesideLabel(sheet, row, region);
  const v = sheet.grid[row]?.[region.firstCol] ?? null;
  if (typeof v !== 'string' || asNumber(v) !== null || asDate(v) !== null) return null;
  if (NOTE_LEAD.test(text)) return text;
  if (text.length < 40 || !/\s/.test(text) || !/\.["')\]]?$/.test(text)) return null;
  let longest = 0;
  for (let r = region.startRow; r < row; r++) {
    const above = sheet.grid[r]?.[region.firstCol] ?? null;
    if (!isBlank(above)) longest = Math.max(longest, String(above).trim().length);
  }
  return text.length >= 2 * longest ? text : null;
}

/** Text that is neither a number nor a date. */
const isWords = (v: CellValue): v is string => typeof v === 'string' && asNumber(v) === null && asDate(v) === null;

/**
 * The columns of a region that hold numbers above this row: mostly numbers, allowing
 * for a heading or two at the top.
 */
function numberColumns(sheet: ReadSheet, row: number, region: RawRegion): Set<number> {
  const out = new Set<number>();
  for (let c = region.firstCol; c <= region.lastCol; c++) {
    let numbers = 0;
    let words = 0;
    for (let r = region.startRow; r < row; r++) {
      const v = sheet.grid[r]?.[c] ?? null;
      if (isBlank(v)) continue;
      if (typeof v === 'number' || (typeof v === 'string' && asNumber(v) !== null)) numbers++;
      else words++;
    }
    if (numbers >= 2 && numbers >= 2 * words) out.add(c);
  }
  return out;
}

/**
 * The two other shapes a note under a table takes. "Source:" in the first column with
 * its text in the next — "Source: | General ledger export" — made one more record and
 * turned Revenue into a mix of text and numbers that could no longer be totalled. And a
 * sentence on its own under a column of numbers ("Prices include VAT." under Qty) did
 * the same to that column. Either is a note only in a table that has numbers, on a row
 * that has none: a list of settings, all text, keeps its "Notes" row.
 */
function noteBesideLabel(sheet: ReadSheet, row: number, region: RawRegion): string | null {
  const filled = filledCells(sheet, row, region);
  if (!filled.length || filled.length > 2 || !filled.every((f) => isWords(f.v))) return null;
  const numeric = numberColumns(sheet, row, region);
  if (!numeric.size) return null;
  const [first, second] = filled;
  if (first!.c === region.firstCol && second && NOTE_LEAD.test(first!.text)) return `${first!.text} ${second.text}`;
  if (!second && first!.c !== region.firstCol && numeric.has(first!.c) && /\s/.test(first!.text) && (NOTE_LEAD.test(first!.text) || /[.!]["')\]]?$/.test(first!.text))) {
    return first!.text;
  }
  return null;
}

const clip = (s: string): string => (s.length > 160 ? `${s.slice(0, 157)}…` : s);

export function buildTable(read: ReadResult): IndexTable {
  const id = slugify(read.sourceName);
  const regions: IndexRegion[] = [];
  const warnings = [...read.warnings];
  const notes: string[] = [];
  const fileNumbers = fileNumbersOf(read);
  const vietnamese = vietnameseHeadings(read);
  const fileDates = fileDateOrder(read, fileNumbers, vietnamese);
  const sheetIds = new Set<string>();

  for (const sheet of read.sheets) {
    const raws = detectRegions(sheet.grid as Grid);
    if (raws.length === 0) {
      warnings.push(`Sheet "${sheet.name}" is empty.`);
      continue;
    }
    // Unique across the file's sheets: two sheets whose names slug alike ("Q1.2025"
    // and "Q1 2025", or two names in a script the slug cannot spell) must not share
    // region ids, or every tool call aimed at one lands on the other.
    const sheetId = uniqueId(slugifySheet(sheet.name), sheetIds);

    // A lone line of text above a blank row names the table below it.
    let titleBelow: string | null = null;
    // Numbered by the tables actually emitted, so a title or note consumed along the
    // way does not leave the first real table called "t2".
    let emitted = 0;
    // A sign-off has been found on this sheet; what follows it is names and signatures.
    let signing = false;
    let signedOff = false;
    const noteOf = (text: string): string => `A note on sheet "${sheet.name}" reads: "${clip(text)}".`;

    // Regions already read as part of a heading laid out across columns.
    const consumed = new Set<number>();
    raws.forEach((found, i) => {
      if (signedOff || consumed.has(i)) return;
      // A heading block laid out in two columns above the first table — the company over
      // its department on the left, the national motto on the right; or "Employee: …"
      // beside "Department: …" — is one heading, read row by row across the columns.
      // Each column used to become a table of its own: the file opened on a one-row table
      // named after the company, and every answer began "In table 2".
      if (emitted === 0 && titleBelow === null) {
        const across = headingAcross(sheet, raws, i);
        if (across !== null) {
          across.regions.forEach((k) => consumed.add(k));
          const picked = pickTitle(across.lines);
          titleBelow = picked.title;
          for (const line of picked.rest) notes.push(noteOf(line));
          return;
        }
      }
      // Everything left under the last table is its sign-off: one note, not tables.
      const rest = raws.slice(i);
      if (emitted > 0 && signOffRest(sheet, rest, signing)) {
        if (titleBelow !== null) notes.push(noteOf(titleBelow));
        titleBelow = null;
        const text = signOffText(sheet, rest);
        if (text) notes.push(noteOf(text));
        signedOff = true;
        return;
      }
      // A line of text on its own is not a table. Above a table, after a blank row,
      // it is that table's title: read as a region of its own it became "table 1",
      // a one-cell table that hid the real one. Anywhere else — a source, a note, a
      // "Draft" stamp — it is a note, and announcing it as a table made every file
      // with a source line "hold two separate tables". A note is about a table, so a
      // sheet holding nothing else keeps its one line as the table it is.
      //
      // Several such lines together — a company, a report title, a unit line — are the
      // heading block of the table under them: the line that names the report is its
      // title, the rest are kept as notes. Anywhere but above a table, a block of
      // several lines stays the one-column table it may well be.
      const lines = raws.length > 1 ? textLines(sheet, found) : null;
      const next = raws[i + 1];
      const heads =
        lines !== null &&
        next !== undefined &&
        next.startRow > found.endRow &&
        found.firstCol >= next.firstCol &&
        found.firstCol <= next.lastCol &&
        !NOTE_LEAD.test(lines[0]!) &&
        (lines.length === 1 || next.lastCol > next.firstCol);
      if (lines !== null && (lines.length === 1 || heads)) {
        const picked = heads ? pickTitle(lines) : null;
        // A unit or source line nearer the table does not displace a title further up;
        // anything else is the nearer table's own caption, and wins, as it always has.
        if (picked && titleBelow !== null && metaLine(picked.title)) {
          for (const line of lines) notes.push(noteOf(line));
          return;
        }
        if (titleBelow !== null) notes.push(noteOf(titleBelow));
        titleBelow = null;
        if (picked) {
          titleBelow = picked.title;
          for (const line of picked.rest) notes.push(noteOf(line));
        } else {
          notes.push(noteOf(lines[0]!));
        }
        return;
      }

      let raw: RawRegion = found;
      const extracted = extractTitle(sheet, raw);
      if (extracted.startRow > raw.endRow) return; // a title with nothing under it
      raw = { ...raw, startRow: extracted.startRow };
      // The table's own title row wins, unless it is only a unit or source line ("Đơn vị
      // tính: đồng") under a title further up; the other is then a note.
      let title = extracted.title ?? titleBelow;
      if (titleBelow !== null && extracted.title !== null) {
        const above = metaLine(extracted.title);
        title = above ? titleBelow : extracted.title;
        notes.push(noteOf(above ? extracted.title : titleBelow));
      }
      for (const line of extracted.notes) notes.push(noteOf(line));
      titleBelow = null;

      // Notes typed directly under the last row, with no blank line between. At
      // least a heading and one record stay, whatever the notes look like. A sign-off
      // typed there is one note, and the names under it, further down, are its own.
      const trailing: string[] = [];
      const signedAt = raw.lastCol > raw.firstCol ? attachedSignOff(sheet, raw) : null;
      if (signedAt !== null) {
        const text = signOffText(sheet, [{ ...raw, startRow: signedAt }]);
        if (text) trailing.push(text);
        raw = { ...raw, endRow: signedAt - 1 };
        signing = true;
      }
      while (raw.lastCol > raw.firstCol && raw.endRow > raw.startRow + 1) {
        const note = noteRow(sheet, raw.endRow, raw);
        if (note === null) break;
        trailing.unshift(note);
        raw = { ...raw, endRow: raw.endRow - 1 };
      }
      for (const note of trailing) notes.push(`A note under a table on sheet "${sheet.name}" reads: "${clip(note)}".`);

      const built = buildRegionIndex(sheet, raw, `${sheetId}.t${++emitted}`, title, fileNumbers, fileDates, vietnamese);
      regions.push(built.region);
      warnings.push(...built.warnings);
    });
    if (titleBelow !== null) notes.push(`A note on sheet "${sheet.name}" reads: "${clip(titleBelow)}".`);
  }

  if (regions.length > 1) {
    warnings.push(
      `This file holds ${regions.length} separate tables. Say which one you want, or ask me to describe them.`,
    );
  }
  warnings.push(...notes);

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

/**
 * Assemble the index. Table ids must be unique across it: "Budget.xlsx" and
 * "budget.csv" both slug to "budget", and every lookup by id would reach only the
 * first. A later duplicate is renumbered, and says so.
 */
export function buildIndex(tables: readonly IndexTable[]): LandmarkIndex {
  const used = new Set<string>();
  // Spoken titles must be unique too. "Budget.xlsx" and "budget.csv" were listed as
  // "Budget, Budget", and naming either reached only the first. A later file with a
  // title already taken is called by its format as well: "Budget (CSV)".
  const titles = new Set<string>();
  const unique = tables.map((t) => {
    const id = uniqueId(t.id, used);
    let title = t.title;
    if (titles.has(title.toLowerCase())) {
      title = `${t.title} (${t.format.toUpperCase()})`;
      for (let n = 2; titles.has(title.toLowerCase()); n++) title = `${t.title} (${t.format.toUpperCase()} ${n})`;
    }
    titles.add(title.toLowerCase());
    if (id === t.id && title === t.title) return t;
    const why =
      title !== t.title
        ? `Another file is also called "${t.title}", so this one, ${t.sourceName}, is called "${title}"${id !== t.id ? ` and has the identifier "${id}"` : ''}.`
        : `Another file's name makes the same identifier, so this one, ${t.sourceName}, has the identifier "${id}".`;
    return { ...t, id, title, warnings: [...t.warnings, why] };
  });
  return { version: INDEX_VERSION, tables: unique };
}
