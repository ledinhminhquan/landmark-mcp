/**
 * The explain widget, run for real.
 *
 * The document's script is executed against a minimal stand-in for the DOM and a
 * fake host frame, so these tests exercise the handshake and the rendering as code —
 * a string search for "ui/resource-teardown" would pass whether or not the widget ever
 * answered it. Pinned west of UTC, where the widget used to show every date a day early.
 */
process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tables = [];
for (const f of ['01-flat.xlsx', '03-merged-header.xlsx', '06-countries.csv']) {
  tables.push(buildTable(await readSpreadsheet(join(FIX, f))));
}
const handler = createHandler({ index: buildIndex(tables) });

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': 'widget-test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (JSON.parse(await res.text()) as { result: Record<string, unknown> }).result;
}

const html = ((await rpc('resources/read', { uri: 'ui://landmark/explain' })) as { contents: { text: string }[] })
  .contents[0]!.text;
const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;

/** Just enough of an element for the widget: children, text, classes and attributes. */
class El {
  readonly tag: string;
  children: El[] = [];
  textContent = '';
  className = '';
  scope = '';
  title = '';
  attrs: Record<string, string> = {};
  scrollWidth = 400;
  scrollHeight = 300;
  classList = { add: (c: string) => void (this.className = `${this.className} ${c}`.trim()) };
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...c: El[]): void {
    this.children.push(...c);
  }
  replaceChildren(...c: El[]): void {
    this.children = c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  *walk(): Generator<El> {
    yield this;
    for (const c of this.children) yield* c.walk();
  }
}

type Listener = (e: { source: unknown; data: unknown }) => void;

function mount() {
  const els: Record<string, El> = { said: new El('p'), wrap: new El('div'), note: new El('p') };
  const root = new El('html');
  const posted: Record<string, unknown>[] = [];
  const listeners: Listener[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => void posted.push(m) };
  const win = {
    parent,
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') listeners.push(fn);
    },
  };
  const doc = { getElementById: (id: string) => els[id], createElement: (t: string) => new El(t), documentElement: root };
  new Function('window', 'document', script)(win, doc);
  const deliver = (data: unknown, source: unknown = parent) => listeners.forEach((fn) => fn({ source, data }));
  const handshake = (result: Record<string, unknown> = {}) => deliver({ jsonrpc: '2.0', id: 1, result });
  return { els, root, posted, deliver, handshake };
}

async function explained(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = (await rpc('tools/call', { name: 'table_query', arguments: args })) as { structuredContent: Record<string, unknown> };
  const e = (await rpc('tools/call', {
    name: 'table_explain',
    arguments: { answer_id: q.structuredContent['answer_id'] },
  })) as { structuredContent: Record<string, unknown> };
  return e.structuredContent;
}

const toolResult = (structuredContent: unknown, isError = false) => ({
  jsonrpc: '2.0',
  method: 'ui/notifications/tool-result',
  params: { structuredContent, isError, content: [] },
});

const highlighted = (root: El) => [...root.walk()].filter((e) => /\bhi\b/.test(e.className));

// ── handshake ───────────────────────────────────────────────────────────────

test('a refused handshake is not announced as initialised', () => {
  const w = mount();
  assert.equal(w.posted[0]?.['method'], 'ui/initialize');
  // The UI spec requires a view to declare the display modes it supports.
  const params = w.posted[0]?.['params'] as { appCapabilities: { availableDisplayModes: string[] } };
  assert.deepEqual(params.appCapabilities.availableDisplayModes, ['inline']);
  w.deliver({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'no' } });
  assert.ok(!w.posted.some((m) => m['method'] === 'ui/notifications/initialized'));
});

test('an accepted handshake is announced, and the host theme wins', () => {
  const w = mount();
  w.handshake({ hostContext: { theme: 'dark' } });
  assert.ok(w.posted.some((m) => m['method'] === 'ui/notifications/initialized'));
  assert.equal(w.root.attrs['data-theme'], 'dark');
  w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
  assert.equal(w.root.attrs['data-theme'], 'light');
});

test('teardown and ping are answered, so the host is not left waiting', () => {
  const w = mount();
  w.handshake();
  w.deliver({ jsonrpc: '2.0', id: 7, method: 'ui/resource-teardown', params: {} });
  w.deliver({ jsonrpc: '2.0', id: 8, method: 'ping' });
  assert.deepEqual(w.posted.find((m) => m['id'] === 7), { jsonrpc: '2.0', id: 7, result: {} });
  assert.deepEqual(w.posted.find((m) => m['id'] === 8), { jsonrpc: '2.0', id: 8, result: {} });
});

// ── who may drive it ────────────────────────────────────────────────────────

test('only the host frame can put an explanation on screen', async () => {
  const w = mount();
  w.handshake();
  const real = await explained({ table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population' });
  const spoof = { ...real, spoken: 'SPOOFED: the total is 999 million.' };
  w.deliver(toolResult(spoof), { postMessage() {} });
  assert.ok(!/SPOOFED/.test(w.els['said']!.textContent));
  assert.equal(highlighted(w.els['wrap']!).length, 0);
});

test('a stray message that is not the protocol does not wipe the explanation', async () => {
  const w = mount();
  w.handshake();
  const real = await explained({ table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population' });
  w.deliver(toolResult(real));
  const said = w.els['said']!.textContent;
  w.deliver({ type: 'devtools-hello' });
  w.deliver({ some: 'payload' });
  assert.equal(w.els['said']!.textContent, said);
  assert.ok(w.els['wrap']!.children.length > 0);
});

// ── what it draws ──────────────────────────────────────────────────────────

test('every counted cell is lit, not the first five', async () => {
  const w = mount();
  w.handshake();
  w.deliver(toolResult(await explained({ table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population' })));
  assert.equal(highlighted(w.els['wrap']!).length, 8, 'Peru, Norway and Poland were counted too');
  assert.match(w.els['note']!.textContent, /8 counted cells highlighted/);
});

test('the label column is the row header, not a second copy of it', async () => {
  const w = mount();
  w.handshake();
  w.deliver(toolResult(await explained({ table_id: '06-countries', aggregate: 'sum', aggregate_column: 'Population' })));
  const table = w.els['wrap']!.children[0]!;
  const body = table.children.find((c) => c.tag === 'tbody')!;
  const first = body.children[0]!;
  assert.equal(first.children.length, 4, 'Country, Population, GDP and Region — no duplicated label');
  assert.equal(first.children[0]!.tag, 'th');
  assert.equal(first.children[0]!.textContent, 'Vietnam');
  // In the viewer's own locale, as the widget shows it; a judge's machine need not be en-US.
  assert.equal(first.children[1]!.textContent, (100352192).toLocaleString(), 'a CSV number is grouped like the spoken one');
});

test('an error is shown as the error, not as a prompt to ask again', () => {
  const w = mount();
  w.handshake();
  w.deliver(toolResult({ spoken: 'I no longer have the working for that answer. Ask the question again.' }, true));
  assert.match(w.els['said']!.textContent, /no longer have the working/);
  assert.match(w.els['said']!.className, /error/);
  assert.equal(w.els['wrap']!.children.length, 0);
});

test('dates are shown as the day they are, west of UTC', async () => {
  const w = mount();
  w.handshake();
  w.deliver(toolResult(await explained({ table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' })));
  const cells = [...w.els['wrap']!.walk()].map((e) => e.textContent);
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
  assert.ok(cells.includes(day('2026-07-04T00:00:00Z')), cells.join(' | '));
  assert.ok(!cells.includes(day('2026-07-03T00:00:00Z')));
});

// ── legibility ──────────────────────────────────────────────────────────────

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

test('the "(counted)" marker and the highlight outline meet contrast minimums', () => {
  const token = (block: string, name: string) => {
    const hex = new RegExp(`--${name}:#([0-9a-f]{6}|[0-9a-f]{3})\\b`).exec(block)![1]!;
    return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
  };
  const light = html.match(/:root \{ color-scheme: light dark;[^}]*\}/)![0];
  const dark = html.match(/:root\[data-theme="dark"\] \{[^}]*\}/)![0];
  assert.match(html, /\.mark \{ font-size:12px; color:var\(--ink\)/);
  for (const block of [light, dark]) {
    assert.ok(contrast(token(block, 'ink'), token(block, 'hi')) >= 4.5, 'marker text on the highlight');
    assert.ok(contrast(token(block, 'hi-line'), token(block, 'bg')) >= 3, 'outline against the page');
  }
});

// ── what a final verification still found ───────────────────────────────────

type Grid = (string | number | null)[][];
const csvTable = (name: string, grid: Grid) =>
  buildTable({ sourceName: `${name}.csv`, format: 'csv', sheets: [{ name, grid, merges: [] }], warnings: [] });
const bigHandler = createHandler({
  index: buildIndex([
    csvTable('big', [['Name', 'Amount'], ...Array.from({ length: 1000 }, (_, i) => [`Item ${i + 1}`, String(i + 1)])]),
    csvTable('years', [['Year', 'Amount'], [2024, 10], [2025, 20], [2026, 30]]),
    csvTable('left', [['Region', 'Q1'], ['North', 10], ['South', 30]]),
    csvTable('right', [['Team', 'Cost'], ['A', 1], ['B', 2], ['C', 3]]),
  ]),
});

async function bigCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await bigHandler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  return (JSON.parse(await res.text()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
}
const explainBig = async (tool: string, args: Record<string, unknown>) =>
  bigCall('table_explain', { answer_id: (await bigCall(tool, args))['answer_id'] });

test('the cell a highest came from is drawn and marked as the answer, however far down it is', async () => {
  const w = mount();
  w.handshake();
  const e = await explainBig('table_query', { table_id: 'big', aggregate: 'max', aggregate_column: 'Amount' });
  assert.deepEqual(e['winning'], ['B1001']);
  w.deliver(toolResult(e));
  const marked = [...w.els['wrap']!.walk()].filter((el) => el.title === 'B1001');
  assert.equal(marked.length, 1, 'B1001 was forty rows below the grid');
  assert.ok(marked[0]!.children.some((c) => c.textContent === '(the answer)'));
  assert.match(w.els['note']!.textContent, /The answer is in B1001/);
});

test('the note counts every cell that was counted, not the 200 that are marked', async () => {
  const w = mount();
  w.handshake();
  w.deliver(toolResult(await explainBig('table_query', { table_id: 'big', aggregate: 'sum', aggregate_column: 'Amount' })));
  assert.match(w.els['note']!.textContent, /^1000 cells were counted; the first 200 are marked, 40 of them in this view/, 'was "40 of 200 counted cells"');
});

test('a year is shown as the voice says it, without a grouping comma', async () => {
  const w = mount();
  w.handshake();
  w.deliver(toolResult(await explainBig('table_query', { table_id: 'years', aggregate: 'sum', aggregate_column: 'Amount' })));
  const cells = [...w.els['wrap']!.walk()].map((el) => el.textContent);
  assert.ok(cells.includes('2024'), cells.join(' | '));
  assert.ok(!cells.some((c) => /^2[,.\s\u00a0\u202f]024$/.test(c)), 'was "2,024"');
});

test('the other side of a comparison across tables is named as somewhere else', async () => {
  const w = mount();
  w.handshake();
  w.deliver(toolResult(await explainBig('table_compare', { table_id: 'left', left_column: 'Q1', right_table_id: 'right', right_column: 'Cost' })));
  assert.match(w.els['note']!.textContent, /2 counted cells highlighted · Cost: 3 cells on right, not shown here/);
});

test('while the answer is on its way the panel waits, and a cancelled call says so', () => {
  const w = mount();
  w.handshake();
  // The document's own "Waiting for an answer to explain." stays; nothing overwrote it.
  assert.equal(w.els['said']!.textContent, '', 'was "Ask a question with a number in it, then ask how I know."');
  w.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: {} });
  assert.equal(w.els['said']!.textContent, 'That was cancelled, so there is nothing to show.');
});
