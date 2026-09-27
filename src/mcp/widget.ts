/**
 * The MCP App widget for `table_explain`.
 *
 * Why a visual surface exists in a product built for people who cannot see one:
 *
 * "Blind and low-vision" is not one audience. Most people in it have some usable
 * sight, and a great many work alongside sighted colleagues. When Landmark says a
 * total came from C3 through C5, a person with residual vision, or the colleague
 * sitting next to them, should be able to see those three cells lit up in the sheet
 * rather than take the sentence on faith. That is input parity — the same fact,
 * available through whichever channel the person actually has — and it is the reason
 * this is not a decoration bolted on for a rubric.
 *
 * The widget never replaces the spoken answer. It renders the same provenance the
 * `spoken` field already carries, and it is the only place in the project where
 * anything is drawn.
 *
 * Implementation note: this is wired with the core SDK's `_meta` support and a plain
 * resource, not with `@modelcontextprotocol/ext-apps`. The 2.x line of that package
 * peer-depends on the v2 SDK split (`core`/`client`/`server`), zod 4 and React. The
 * 1.7.5 line is compatible, and its React peers are optional, but a server that renders
 * one static HTML document, declares its metadata keys and serves one resource does not
 * justify the dependency. The contract below — the `_meta.ui.resourceUri` key with its
 * deprecated flat twin `ui/resourceUri`, and the `text/html;profile=mcp-app` MIME type —
 * is taken from that package's own build.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LandmarkIndex } from '../indexfmt.ts';

/**
 * The `_meta` key a host reads to find a tool's UI.
 *
 * There are two, and a tool has to declare both. `_meta.ui.resourceUri` is the current
 * shape; the flat `ui/resourceUri` is the deprecated one that older hosts still read.
 * The extension package's own documentation says hosts must check both, which is only
 * useful advice if servers send both — this one sent the deprecated key alone.
 */
export const UI_RESOURCE_KEY = 'ui/resourceUri';

/** The UI extension revision this widget speaks, distinct from the MCP revision. */
export const UI_PROTOCOL_VERSION = '2026-01-26';

/** Everything a tool must put in `_meta` for a host to find and render this widget. */
export function uiMeta(uri: string): Record<string, unknown> {
  return { ui: { resourceUri: uri }, [UI_RESOURCE_KEY]: uri };
}
/** MIME type that marks a resource as an MCP App rather than plain HTML. */
export const UI_MIME = 'text/html;profile=mcp-app';
export const EXPLAIN_UI_URI = 'ui://landmark/explain';

/**
 * The widget document.
 *
 * Self-contained: no network, no CDN, no fonts to fetch. It renders whatever the host
 * hands it and says so plainly if it is opened with nothing.
 *
 * Accessibility of the accessibility tool matters here more than usual. The grid is a
 * real `<table>` with scope-bearing headers, highlighted cells are marked with text as
 * well as colour, and the summary is in an `aria-live` region — so a screen-reader user
 * who opens the widget gets the same information a sighted one does, rather than a
 * decorative picture of it.
 *
 * The audience is people with residual sight, so contrast is held to WCAG AA: the
 * "(counted)" marker is drawn in the body ink rather than the dimmed tone, which
 * measured 4.1:1 on the dark highlight, and the highlight outline is dark enough to
 * see against white. A host's own light or dark theme, when it sends one, wins over
 * the operating system's, so a dark host does not get a white box dropped into it.
 */
function widgetHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Where that number came from</title>
<style>
  :root { color-scheme: light dark; --line:#c9d2dc; --hi:#ffe9a8; --hi-line:#8a6d00; --ink:#101418; --dim:#5b6672; --bg:#fff; --bad:#a1260d; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --line:#2b3542; --hi:#4a3c12; --hi-line:#e0b52a; --ink:#e7edf3; --dim:#a3b1c0; --bg:#0f141a; --bad:#ff9a85; }
  }
  :root[data-theme="dark"] { --line:#2b3542; --hi:#4a3c12; --hi-line:#e0b52a; --ink:#e7edf3; --dim:#a3b1c0; --bg:#0f141a; --bad:#ff9a85; }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  body { margin:0; padding:14px; background:var(--bg); color:var(--ink);
         font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size:.78rem; letter-spacing:.1em; text-transform:uppercase; color:var(--dim);
       margin:0 0 .35rem; font-weight:600; }
  .said { font-size:1rem; margin:0 0 .9rem; }
  .said.error { color:var(--bad); font-weight:600; }
  .wrap { overflow-x:auto; border:1px solid var(--line); border-radius:6px; }
  .wrap:empty { display:none; }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
  caption { text-align:left; padding:.5rem .6rem; color:var(--dim); font-size:.8rem; }
  th, td { border:1px solid var(--line); padding:.32rem .55rem; text-align:left; white-space:nowrap; }
  th { background:color-mix(in srgb, var(--line) 30%, transparent); font-weight:600; font-size:.85rem; }
  th[scope="row"] { font-weight:500; }
  .hi { background:var(--hi); box-shadow: inset 0 0 0 2px var(--hi-line); font-weight:600; }
  .mark { font-size:12px; color:var(--ink); margin-left:.4rem; font-weight:500; }
  tr.total > * { border-top:2px solid var(--ink); }
  .addr { font:12px ui-monospace, monospace; color:var(--dim); }
  .note { margin-top:.7rem; font-size:.82rem; color:var(--dim); }
  .empty { color:var(--dim); }
</style>
</head>
<body>
<h1>Where that number came from</h1>
<p class="said" id="said" aria-live="polite">Waiting for an answer to explain.</p>
<div class="wrap" id="wrap"></div>
<p class="note" id="note" aria-live="polite"></p>

<script>
// The host posts the tool result in; render whatever arrives, and stay useful if
// nothing does. No network calls — everything shown is already in the message.
/**
 * A cell as a person should see it.
 *
 * Dates arrive as ISO strings because that is what survives JSON. Printed raw, a
 * column of "2026-07-04T00:00:00.000Z" is exactly the machine noise a screen reader
 * user is being spared — and the colleague reading along over their shoulder is the
 * whole reason this panel exists. They are UTC midnight, so they are shown in UTC:
 * in the viewer's own zone, everyone west of Greenwich saw every date a day early.
 */
function show(value) {
  if (value === null || value === undefined) return '';
  // Doubled on purpose: this document is built from a template literal, so a single
  // backslash is eaten before it ever reaches the browser and the test never matches.
  if (typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
    }
  }
  // Grouped from five digits, as the voice reads it: "2,024" was shown for the year the
  // voice called 2024.
  if (typeof value === 'number') return value.toLocaleString(undefined, { useGrouping: Math.abs(value) >= 10000 });
  return String(value);
}

/**
 * A cell in its column's kind. A CSV delivers every number as text, so a population
 * showed as "100352192" beside a spoken "100,352,192"; a plain digit string in a
 * number column is grouped here too. A number in a text column is an identifier and
 * is shown as stored, and a leading zero always means an identifier.
 */
function showCell(value, kind) {
  const numeric = kind === 'number' || kind === 'currency' || kind === 'percent' || kind === 'mixed';
  if (typeof value === 'number' && !numeric) return String(value);
  if (typeof value === 'string' && kind === 'number') {
    const t = value.trim();
    if (/^-?\\d+(\\.\\d+)?$/.test(t) && !/^-?0\\d/.test(t)) return show(Number(t));
  }
  return show(value);
}

function render(data, isError) {
  const said = document.getElementById('said');
  const wrap = document.getElementById('wrap');
  const note = document.getElementById('note');
  said.className = 'said';
  // An error, or an explanation with no grid to draw, is shown as the sentence that
  // was spoken. The panel used to answer a failed "how do you know" by telling the
  // person to ask how it knew, next to a stale table.
  if (!data || isError || !data.grid) {
    said.textContent = (data && data.spoken) || (isError
      ? 'That did not work, so there is nothing to show.'
      : 'Ask a question with a number in it, then ask how I know.');
    if (isError) said.className = 'said error';
    wrap.replaceChildren();
    note.textContent = '';
    return;
  }
  said.textContent = data.spoken || '';
  // Every counted cell of every operand in this region, not the first five named aloud.
  const hi = new Set(data.highlight || data.cells || []);
  // The cell a highest or lowest came from: marked as the answer, not as one of many.
  const win = new Set(data.winning || []);
  const labelLetter = data.grid.label_letter || null;

  const t = document.createElement('table');
  const cap = document.createElement('caption');
  cap.textContent = data.title
    ? data.title + ' — ' + data.sheet
    : data.sheet;
  t.append(cap);

  // The label column is the row header itself, rather than a copy of it in a column
  // of its own: the grid used to read "Salaries | Engineering | Salaries | 480,000".
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  if (!labelLetter) {
    const corner = document.createElement('td');
    corner.textContent = 'Row';
    corner.className = 'addr';
    hr.append(corner);
  }
  const kinds = {};
  for (const col of data.grid.columns) {
    kinds[col.letter] = col.kind;
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = col.name;
    const a = document.createElement('div');
    a.className = 'addr';
    a.textContent = col.letter;
    th.append(a);
    hr.append(th);
  }
  thead.append(hr);
  t.append(thead);

  let shown = 0;
  const winShown = [];
  const tb = document.createElement('tbody');
  data.grid.rows.forEach((row) => {
    const tr = document.createElement('tr');
    if (row.total) tr.className = 'total';
    if (!labelLetter) {
      const rh = document.createElement('th');
      rh.scope = 'row';
      rh.textContent = String(row.number);
      tr.append(rh);
    }
    row.cells.forEach((cell) => {
      const letter = cell.address.replace(/\\d+$/, '');
      const isLabel = labelLetter !== null && letter === labelLetter;
      const el = document.createElement(isLabel ? 'th' : 'td');
      if (isLabel) el.scope = 'row';
      el.textContent = showCell(cell.value, kinds[letter]);
      if (isLabel && row.total) {
        const m = document.createElement('span');
        m.className = 'mark';
        m.textContent = '(total row)';
        el.append(m);
      }
      if (hi.has(cell.address) || win.has(cell.address)) {
        if (hi.has(cell.address)) shown++;
        if (win.has(cell.address)) winShown.push(cell.address);
        el.classList.add('hi');
        // Colour alone is not a signal a screen reader can convey.
        const m = document.createElement('span');
        m.className = 'mark';
        m.textContent = win.has(cell.address) ? '(the answer)' : '(counted)';
        el.append(m);
      }
      el.title = cell.address;
      tr.append(el);
    });
    tb.append(tr);
  });
  t.append(tb);

  wrap.replaceChildren(t);

  const bits = [];
  if (winShown.length) {
    bits.push('The answer is in ' + winShown.join(' and '));
  }
  // Counted in all, which the list of marked cells (at most 200) is not.
  const counted = typeof data.counted === 'number' && data.counted > hi.size ? data.counted : hi.size;
  if (hi.size) {
    bits.push(counted > hi.size
      ? counted + ' cells were counted; the first ' + hi.size + ' are marked, ' + shown + ' of them in this view'
      : shown === hi.size
        ? hi.size + (hi.size === 1 ? ' counted cell highlighted' : ' counted cells highlighted')
        : shown + ' of ' + hi.size + ' counted cells are in this view');
  }
  // The other side of a comparison across tables is somewhere this grid is not.
  for (const other of data.elsewhere || []) {
    bits.push(other.name + ': ' + other.cells + (other.cells === 1 ? ' cell' : ' cells') + ' on ' + other.sheet + ', not shown here');
  }
  if (data.excluded && data.excluded.length) {
    bits.push(data.excluded.length + ' skipped: ' +
      data.excluded.slice(0, 4).map((e) => e.address + ' ' + e.reason).join(', '));
  }
  note.textContent = bits.join(' · ');
}

/*
 * The host handshake.
 *
 * This document used to listen for a message and render whatever arrived. That is not
 * the protocol, and it fails in both directions: a host that waits to be told the app
 * is ready waits forever, and a host that sends the tool result before this script
 * runs finds nobody listening. Neither shows up in a screenshot of a working demo,
 * because the demo was driving the widget by hand.
 *
 * The sequence is: post ui/initialize, wait for the result, post
 * ui/notifications/initialized, then receive ui/notifications/tool-result. Method
 * names and parameter shapes are taken from the ext-apps package's own generated
 * schema. The sandboxed frame has an opaque origin, so "*" is the target the
 * reference implementation uses too.
 *
 * Only the frame's own host is listened to. Any other frame in the same page can post
 * a message here, and one that could pose as the host could light up cells that were
 * never counted — false provenance, shown to someone relying on it. The reference
 * transport makes the same check.
 */
const UI_PROTOCOL = '${UI_PROTOCOL_VERSION}';
const host = window.parent;
let nextId = 1;
let initialized = false;

function post(message) {
  if (host && host !== window) host.postMessage(message, '*');
}

function notify(method, params) {
  post({ jsonrpc: '2.0', method: method, params: params || {} });
}

/** Tell the host how tall we are, so the frame is not a scrollbar around a table. */
function reportSize() {
  const el = document.documentElement;
  notify('ui/notifications/size-changed', {
    width: Math.ceil(el.scrollWidth),
    height: Math.ceil(el.scrollHeight),
  });
}

/** Follow the host's theme when it states one, instead of the operating system's. */
function applyHost(context) {
  if (context && (context.theme === 'dark' || context.theme === 'light')) {
    document.documentElement.setAttribute('data-theme', context.theme);
  }
}

const initializeId = nextId++;

window.addEventListener('message', (e) => {
  if (e.source !== host) return;
  const msg = e.data;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

  // The answer to our own ui/initialize. A refusal is not a handshake: announcing
  // ourselves initialised after an error told the host something untrue.
  if (msg.id === initializeId && msg.method === undefined) {
    if (initialized || msg.error) return;
    initialized = true;
    applyHost(msg.result && msg.result.hostContext);
    notify('ui/notifications/initialized', {});
    reportSize();
    return;
  }

  if (msg.method === 'ui/notifications/tool-result') {
    const result = msg.params || {};
    render(result.structuredContent || null, result.isError === true);
    reportSize();
    return;
  }

  if (msg.method === 'ui/notifications/tool-cancelled') {
    const said = document.getElementById('said');
    said.className = 'said';
    said.textContent = 'That was cancelled, so there is nothing to show.';
    document.getElementById('wrap').replaceChildren();
    document.getElementById('note').textContent = '';
    reportSize();
    return;
  }

  if (msg.method === 'ui/notifications/host-context-changed') {
    applyHost(msg.params);
    return;
  }

  // Requests from the host expect an answer. A host waits for this one before it
  // removes the frame, and used to wait out its own timeout instead.
  if (msg.id !== undefined && msg.method !== undefined) {
    if (msg.method === 'ui/resource-teardown' || msg.method === 'ping') {
      post({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else {
      post({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});

post({
  jsonrpc: '2.0',
  id: initializeId,
  method: 'ui/initialize',
  params: {
    protocolVersion: UI_PROTOCOL,
    appInfo: { name: 'landmark-explain', version: '0.1.0' },
    // The display modes this view supports, which the UI spec requires it to declare:
    // it is drawn inline, beside the conversation.
    appCapabilities: { availableDisplayModes: ['inline'] },
  },
});

// Nothing is rendered until a result arrives: "Waiting for an answer to explain." stays
// up while the host runs the tool. Rendering the empty state here told someone who had
// just asked "how do you know" to ask a question and then ask how it knew.
</script>
</body>
</html>`;
}

/**
 * Register the widget resource. The tool that uses it declares both
 * `_meta.ui.resourceUri` and the deprecated flat `ui/resourceUri` pointing here (see
 * uiMeta); hosts that do not understand MCP Apps ignore the keys and the spoken answer
 * is unaffected.
 */
export function registerWidget(server: McpServer, _index: LandmarkIndex): void {
  server.registerResource(
    'explain-widget',
    EXPLAIN_UI_URI,
    {
      title: 'Where that number came from',
      description:
        'Shows the region of the sheet behind a spoken answer, with the cells that were '
        + 'counted highlighted and the ones that were skipped named. For someone with '
        + 'residual sight, or a sighted colleague reading along.',
      mimeType: UI_MIME,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: UI_MIME, text: widgetHtml() }],
    }),
  );
}
