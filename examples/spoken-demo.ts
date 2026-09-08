/** Prints what the voice agent actually says. Run: npm run demo */
import { detectRegions, buildRegion, describeRegion, describeCell } from '../src/table/infer.ts';
import type { CellValue } from '../src/table/model.ts';

const SHEET: (CellValue[])[] = [
  ['Q3 Regional Sales', null, null, null],
  ['Region', 'Rep', 'Revenue', 'Closed'],
  ['North', 'Anh', '$12,400', '2026-07-04'],
  [null, 'Bảo', '$8,150', '2026-07-19'],   // blank only because A3:A4 is merged
  ['South', 'Anh', '$21,000', '2026-08-02'],
  ['South', 'Chi', '$3,900', '2026-08-27'],
];

const raw = detectRegions(SHEET)[0]!;
const region = buildRegion(
  SHEET,
  { ...raw, startRow: 1 },
  'sales.t1',
  [{ value: 'North', topRow: 2, bottomRow: 3, leftCol: 0, rightCol: 0, a1: 'A3' }],
  'Q3 Regional Sales',
);

console.log('--- what the agent says when the file is opened ---');
console.log(describeRegion(region).replace(/\. /g, '.\n'));
console.log('\n--- a single cell, anchored to its identity (never "C4") ---');
console.log(' ', describeCell(region, 1, 2));
console.log(' ', describeCell(region, 1, 0));
