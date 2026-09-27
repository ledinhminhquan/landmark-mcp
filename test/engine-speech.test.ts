/**
 * How numbers, dates and cell text are spoken.
 *
 * Pinned to a time zone west of UTC on purpose. The developer's machine is UTC+7,
 * where formatting a UTC-midnight date in local time happens to land on the right
 * day — which is how "July 3" for a 4 July close shipped unnoticed to anyone in the
 * Americas. Node applies a TZ change at runtime, and each test file is its own
 * process, so this does not leak into other files.
 */
process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanText, readDate, readSpokenNumber, tidy } from '../src/query/engine.ts';
import {
  capWords,
  exactNumber,
  speakAmount,
  speakCell,
  speakCellRuns,
  speakNumber,
} from '../src/voice/speak.ts';

test('the time zone pin is in effect, so the date tests below mean something', () => {
  assert.equal(new Date('2026-07-04T00:00:00.000Z').getDate(), 3, 'local time should be a day behind UTC here');
});

// ── trimming ────────────────────────────────────────────────────────────────

test('trimming to a budget never ends a sentence at a decimal point', () => {
  const cut = capWords('Peru: Population 34.4 million. Norway: Population 5.5 million.', 6);
  assert.equal(cut, 'Peru: Population 34.4 million.');
  assert.ok(!/\d\.$/.test(capWords('Anh: Region North, Revenue 12.4 thousand and more words here.', 5)));
});

// ── aggregates: rounded for listening, and honest about it ──────────────────

test('a rounded total says "about", an exact one does not', () => {
  assert.equal(speakAmount(61050), 'about 61.1 thousand');
  assert.equal(speakAmount(560000), '560 thousand', 'the filmed demo figure is exact and must stay bare');
  assert.equal(speakAmount(234000), '234 thousand');
  assert.equal(speakAmount(2100), '2100');
  assert.equal(speakAmount(1234.5678), 'about 1234.57');
  assert.equal(exactNumber(61050), '61,050');
});

test('scale words carry over instead of saying "1000 thousand"', () => {
  assert.equal(speakNumber(999950), '1 million');
  assert.equal(speakNumber(999_999_999), '1 billion');
  assert.equal(speakNumber(2.5e12), '2.5 trillion');
});

test('a small non-zero value is never spoken as zero', () => {
  assert.equal(speakNumber(0.0035), '0.0035');
  assert.equal(speakNumber(1.5e-7), '0.00000015');
  assert.equal(speakNumber(-0.004), 'minus 0.004');
  assert.equal(speakNumber(0), '0');
  assert.equal(speakAmount(0.0035), '0.0035');
});

test('floating-point noise is rounded away before anything is compared or said', () => {
  assert.equal(tidy(0.1 + 0.2), 0.3);
  assert.equal(tidy(10.1 + 20.2), 30.3);
  assert.equal(speakAmount(0.1 + 0.2), '0.3');
});

// ── single records: read exactly ────────────────────────────────────────────

test('one record\'s value is read exactly, so different ids sound different', () => {
  assert.notEqual(speakCell(104233, 'number'), speakCell(104239, 'number'));
  assert.equal(speakCell(104233, 'number'), '104,233');
  assert.equal(speakCell('48213.57', 'number'), '48,213.57');
  assert.equal(speakCell(0.0035, 'number'), '0.0035');
  assert.equal(speakCell(-12, 'number'), 'minus 12');
  assert.equal(speakCell('12%', 'percent'), '12%');
});

test('identifiers are read as written', () => {
  assert.equal(speakCell('0901234567', 'number'), '0901234567', 'a leading zero is part of a phone number');
  assert.equal(speakCell('02134', 'text'), '02134');
  assert.equal(speakCell(104233, 'text'), '104233', 'a number in a text column is an id, not a quantity');
});

// ── dates ───────────────────────────────────────────────────────────────────

test('stored dates are spoken as the day they are, in any server time zone', () => {
  assert.equal(speakCell('2026-07-04T00:00:00.000Z', 'date'), 'July 4, 2026');
  assert.equal(speakCell('2026-07-04', 'date'), 'July 4, 2026');
  assert.equal(speakCell('7/4/2026', 'date'), 'July 4, 2026');
});

test('dates are read as UTC calendar days in every spoken form', () => {
  const want = '2026-07-04T00:00:00.000Z';
  for (const said of ['2026-07-04', '7/4/2026', 'July 4, 2026', '4 July 2026', 'Jul 4 2026', 'July 4th, 2026']) {
    assert.equal(readDate(said)?.toISOString(), want, said);
  }
  assert.equal(readDate('2026-02-30'), null, 'a day that does not exist is not a date');
  assert.equal(readDate('2024'), null, 'a bare year is a number');
  assert.equal(readDate('Maybe 4 2026'), null);
});

// ── spoken numbers as filter values ─────────────────────────────────────────

test('numbers arrive the way people say them', () => {
  assert.equal(readSpokenNumber('100 million'), 100_000_000);
  assert.equal(readSpokenNumber('1.5k'), 1500);
  assert.equal(readSpokenNumber('$2 billion'), 2e9);
  assert.equal(readSpokenNumber('minus 5'), -5);
  assert.equal(readSpokenNumber('100,000,000'), 100_000_000);
  assert.equal(readSpokenNumber('banana'), null);
  assert.equal(readSpokenNumber('10 bananas'), null);
});

// ── cell text is data ───────────────────────────────────────────────────────

test('cell text cannot break the sentence it is read inside', () => {
  // Built from code points so this file stays plain ASCII: a newline, a bell, a
  // right-to-left override and a Unicode line separator, all inside one cell.
  const [bell, rlo, lsep] = [0x07, 0x202e, 0x2028].map((c) => String.fromCharCode(c));
  const nasty = `line one\nline two${bell}${rlo}evil${lsep}end`;
  const said = speakCell(nasty, 'text');
  for (const bad of ['\n', '\r', bell, rlo, lsep]) assert.ok(!said.includes(bad), JSON.stringify(said));
  assert.equal(said, 'line one line two evil end');
  const long = 'word '.repeat(100);
  assert.ok(speakCell(long, 'text').length <= 125, 'a pasted paragraph is capped');
  assert.ok(cleanText(long, 20).endsWith('…'));
});

// ── naming cells ────────────────────────────────────────────────────────────

test('only adjacent cells are spoken as a range', () => {
  assert.deepEqual(speakCellRuns(['C3', 'C4', 'C5'], 5), { text: 'C3 through C5', named: 3 });
  assert.deepEqual(speakCellRuns(['C3', 'C5', 'C7', 'C9', 'C11'], 5), {
    text: 'C3, C5, C7, C9 and C11',
    named: 5,
  });
  assert.deepEqual(speakCellRuns(['C3', 'C5', 'C7', 'C9', 'C11'], 2), { text: 'C3 and C5', named: 2 });
  assert.deepEqual(speakCellRuns(['B2', 'B3', 'D2', 'D3'], 5), { text: 'B2 through B3 and D2 through D3', named: 4 });
});
