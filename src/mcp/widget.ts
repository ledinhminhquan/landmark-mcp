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
 * peer-depends on the v2 SDK split (`core`/`client`/`server`), zod 4 and React; the
 * 1.7.5 line is compatible but still pulls React peers for a server that renders one
 * static HTML document. Declaring one metadata key and serving one resource does not
 * justify either. The contract below — the `ui/resourceUri` key and the
 * `text/html;profile=mcp-app` MIME type — is taken from that package's own build.
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
 */
function widgetHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Where that number came from</title>
<style>
  :root { color-scheme: light dark; --line:#c9d2dc; --hi:#ffe9a8; --hi-line:#d9a800; --ink:#101418; --dim:#5b6672; --bg:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --line:#2b3542; --hi:#4a3c12; --hi-line:#c99a12; --ink:#e7edf3; --dim:#93a2b3; --bg:#0f141a; }
  }
  body { margin:0; padding:14px; background:var(--bg); color:var(--ink);
         font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size:.78rem; letter-spacing:.1em; text-transform:uppercase; color:var(--dim);
       margin:0 0 .35rem; font-weight:600; }
  .said { font-size:1rem; margin:0 0 .9rem; }
  .wrap { overflow-x:auto; border:1px solid var(--line); border-radius:6px; }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
  caption { text-align:left; padding:.5rem .6rem; color:var(--dim); font-size:.8rem; }
  th, td { border:1px solid var(--line); padding:.32rem .55rem; text-align:left; white-space:nowrap; }
  th { background:color-mix(in srgb, var(--line) 30%, transparent); font-weight:600; font-size:.85rem; }
  th[scope="row"] { font-weight:500; }
  td.hi { background:var(--hi); box-shadow: inset 0 0 0 2px var(--hi-line); font-weight:600; }
  td.hi .mark { font-size:.7rem; color:var(--dim); margin-left:.4rem; }
  .addr { font:11px ui-monospace, monospace; color:var(--dim); }
  .note { margin-top:.7rem; font-size:.82rem; color:var(--dim); }
  .empty { color:var(--dim); }
</style>
</head>
<body>
<h1>Where that number came from</h1>
<p class="said" id="said">Waiting for an answer to explain.</p>
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
 * whole reason this panel exists.
 */
function show(value) {
  if (value === null || value === undefined) return '';
  // Doubled on purpose: this document is built from a template literal, so a single
  // backslash is eaten before it ever reaches the browser and the test never matches.
  if (typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
  }
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}

function render(data) {
  const said = document.getElementById('said');
  const wrap = document.getElementById('wrap');
  const note = document.getElementById('note');
  if (!data || !data.grid) {
    said.textContent = 'Ask a question with a number in it, then ask how I know.';
    return;
  }
  said.textContent = data.spoken || '';
  const hi = new Set(data.cells || []);

  const t = document.createElement('table');
  const cap = document.createElement('caption');
  cap.textContent = data.title
    ? data.title + ' — ' + data.sheet
    : data.sheet;
  t.append(cap);

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('td');
  hr.append(corner);
  for (const col of data.grid.columns) {
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

  const tb = document.createElement('tbody');
  data.grid.rows.forEach((row) => {
    const tr = document.createElement('tr');
    const rh = document.createElement('th');
    rh.scope = 'row';
    rh.textContent = row.label ?? String(row.number);
    tr.append(rh);
    row.cells.forEach((cell) => {
      const td = document.createElement('td');
      td.textContent = show(cell.value);
      if (hi.has(cell.address)) {
        td.className = 'hi';
        // Colour alone is not a signal a screen reader can convey.
        const m = document.createElement('span');
        m.className = 'mark';
        m.textContent = '(counted)';
        td.append(m);
      }
      td.title = cell.address;
      tr.append(td);
    });
    tb.append(tr);
  });
  t.append(tb);

  wrap.replaceChildren(t);

  const bits = [];
  if (data.cells?.length) bits.push(data.cells.length + ' cell(s) highlighted');
  if (data.excluded?.length) {
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

const initializeId = nextId++;

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  // The answer to our own ui/initialize.
  if (msg.id === initializeId && !initialized) {
    initialized = true;
    notify('ui/notifications/initialized', {});
    reportSize();
    return;
  }

  if (msg.method === 'ui/notifications/tool-result') {
    render(msg.params?.structuredContent ?? msg.params?.data ?? null);
    reportSize();
    return;
  }

  // Hosts that predate the handshake just post the payload. Keep rendering it rather
  // than showing an empty frame to someone whose host is a version behind.
  if (msg.method === undefined && msg.id === undefined) {
    render(msg.params?.data ?? msg.data ?? msg.result?.structuredContent ?? msg);
    reportSize();
  }
});

post({
  jsonrpc: '2.0',
  id: initializeId,
  method: 'ui/initialize',
  params: {
    protocolVersion: UI_PROTOCOL,
    appInfo: { name: 'landmark-explain', version: '0.1.0' },
    appCapabilities: {},
  },
});

render(null);
</script>
</body>
</html>`;
}

/**
 * Register the widget resource. The tool that uses it declares
 * `_meta['ui/resourceUri']` pointing here; hosts that do not understand MCP Apps
 * ignore the key and the spoken answer is unaffected.
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
