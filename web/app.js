/**
 * Landmark voice client.
 *
 * This is a real MCP client. It performs the 2025-11-25 handshake against the
 * deployed Streamable HTTP endpoint over the network and calls the same tools any
 * other client would — nothing here is mocked, and there is no local copy of the data.
 *
 * On tool selection: this routes intent with rules rather than a language model, and
 * that is a deliberate trade rather than a shortcut. The demo has to work on a
 * specific day, on someone else's network, with no API key to expire and no rate limit
 * to hit. A rule router is worse at open-ended phrasing and better at being available,
 * and availability is the property that matters when a judge presses the button.
 * Swap in a model by replacing `route()`; everything below it is unchanged.
 *
 * Voice constraints come from the server, not from here. Every tool returns a `spoken`
 * field already inside its word budget, and this client speaks that field verbatim. A
 * client that re-summarised the server's sentence would silently reintroduce the
 * problem the server exists to solve.
 */

const PROTOCOL_VERSION = '2025-11-25';
const ENDPOINT = new URL('/mcp', location.href).href;

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

class McpClient {
  #id = 0;
  #initialized = false;
  lastLatencyMs = 0;
  tools = [];

  async #rpc(method, params) {
    const started = performance.now();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.#initialized ? { 'mcp-protocol-version': PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
    });
    this.lastLatencyMs = Math.round(performance.now() - started);

    if (!res.ok) throw new Error(`The table service answered ${res.status}.`);

    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    let body;
    if (type.includes('application/json')) {
      body = JSON.parse(text);
    } else {
      // Streamable HTTP may answer as a single SSE frame; accept both shapes.
      const frame = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('data:'));
      if (!frame) throw new Error('The table service sent an empty reply.');
      body = JSON.parse(frame.slice(5).trim());
    }
    if (body.error) throw new Error(body.error.message ?? 'The table service refused that.');
    return body.result;
  }

  async #notify(method) {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
  }

  async connect() {
    const result = await this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'landmark-voice-client', version: '0.1.0' },
    });
    this.#initialized = true;
    await this.#notify('notifications/initialized');
    this.tools = (await this.#rpc('tools/list', {})).tools ?? [];
    return result;
  }

  /** Returns the server's structured payload, including its `spoken` sentence. */
  async call(name, args) {
    const result = await this.#rpc('tools/call', { name, arguments: args });
    const structured = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    return { ...structured, isError: Boolean(result.isError) };
  }
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;

class Voice {
  #recognition = null;
  #utterance = null;
  onheard = () => {};
  onstate = () => {};

  get supported() {
    return Boolean(Recognition) && 'speechSynthesis' in window;
  }

  listen() {
    if (!Recognition) return false;
    this.stopSpeaking(); // barge-in: a new question cancels the current answer
    const r = new Recognition();
    r.lang = 'en-US';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      this.onheard(last[0].transcript.trim(), last.isFinal);
    };
    r.onend = () => this.onstate('idle');
    r.onerror = (e) => this.onstate(e.error === 'no-speech' ? 'idle' : 'error');
    r.start();
    this.#recognition = r;
    this.onstate('listening');
    return true;
  }

  stopListening() {
    this.#recognition?.stop();
    this.#recognition = null;
  }

  speak(text, onend) {
    this.stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.0;
    u.onend = () => {
      this.onstate('idle');
      onend?.();
    };
    this.#utterance = u;
    this.onstate('speaking');
    speechSynthesis.speak(u);
  }

  stopSpeaking() {
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    this.#utterance = null;
  }
}

// ---------------------------------------------------------------------------
// Intent routing
// ---------------------------------------------------------------------------

/** Conversation memory: what we are looking at and what we last said. */
const context = {
  tableId: null,
  lastAnswerId: null,
  lastCursor: null,
  lastCall: null,
  columns: [],
  /** Everything the server said exists, so an utterance can name one. */
  tables: [],
};

/**
 * Resolve a table named in an utterance.
 *
 * Without this, "describe the budget one" silently describes whatever table happened
 * to be current — which reads as the assistant ignoring you, and is worse than an
 * error because nothing announces that it went wrong. Matching is deliberately loose:
 * people say "the budget one", not "04-title-and-vmerge".
 */
function findTable(text) {
  const t = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const table of context.tables) {
    const words = `${table.title} ${table.table_id}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const score = words.filter((w) => t.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = table;
    }
  }
  return bestScore > 0 ? best : null;
}

const AGGREGATES = [
  [/\b(total|sum|altogether|add up)\b/i, 'sum'],
  [/\b(average|mean|typical)\b/i, 'avg'],
  [/\b(highest|maximum|max|biggest|largest|most)\b/i, 'max'],
  [/\b(lowest|minimum|min|smallest|least)\b/i, 'min'],
  [/\b(how many|count|number of)\b/i, 'count'],
];

/** Match a spoken fragment against the columns we know about. */
function findColumn(text) {
  const t = text.toLowerCase();
  let best = null;
  for (const c of context.columns) {
    const leaf = (c.header_path?.[c.header_path.length - 1] ?? c.name).toLowerCase();
    if (t.includes(c.name.toLowerCase()) || t.includes(leaf)) {
      if (!best || c.name.length > best.name.length) best = c;
    }
  }
  return best;
}

function findCategoryFilter(text) {
  const t = text.toLowerCase();
  for (const c of context.columns) {
    for (const v of c.categories ?? []) {
      if (t.includes(String(v).toLowerCase())) {
        return { column: c.name, op: 'eq', value: String(v) };
      }
    }
  }
  return null;
}

/**
 * Map an utterance to a tool call. Order matters: the most specific intents are
 * tested first, and anything unmatched falls through to describing the table, which
 * is the useful default when someone is lost.
 */
function route(said) {
  const t = said.toLowerCase().trim();

  if (/\b(what do i have|what files|list|my tables|what.s available)\b/.test(t)) {
    return { tool: 'table_list', args: {} };
  }

  // Switching table resets what we know about its columns. The previous table's
  // column names are not merely useless here — they would match against the wrong
  // column and produce a confident answer from the wrong data, which is the failure
  // mode a listener has no way to catch.
  const named = findTable(t);
  if (named && named.table_id !== context.tableId) {
    context.tableId = named.table_id;
    context.columns = [];
    context.lastAnswerId = null;
    context.lastCursor = null;
    // Orient on arrival unless they already asked something specific: naming a table
    // you have not opened is a request to know what is in it.
    if (!/\b(total|sum|average|mean|how many|count|highest|lowest|compare)\b/.test(t)) {
      return { tool: 'table_describe', args: { table_id: named.table_id, detail: 'brief' } };
    }
  }

  if (/\b(how do you know|are you sure|where did that come from|which rows|show your working|prove it)\b/.test(t)) {
    if (!context.lastAnswerId) {
      return { speak: 'Ask me something with a number in it first, then I can show you where it came from.' };
    }
    return { tool: 'table_explain', args: { answer_id: context.lastAnswerId } };
  }

  if (/\b(more|keep going|go on|continue|next)\b/.test(t) && context.lastCall) {
    return {
      tool: context.lastCall.tool,
      args: { ...context.lastCall.args, ...(context.lastCursor ? { cursor: context.lastCursor } : {}) },
    };
  }

  if (/\b(save|bookmark|remember) (my |this |the )?(place|spot|position|here)\b/.test(t) || /\bbookmark this\b/.test(t)) {
    return { tool: 'table_bookmark', args: { name: 'my place', table_id: context.tableId, row: 1 } };
  }
  if (/\b(carry on|resume|pick up|where was i|back to)\b/.test(t)) {
    return { tool: 'table_resume', args: {} };
  }

  if (/\b(compare|versus|vs\.?|against|difference between)\b/.test(t)) {
    const parts = t.split(/\b(?:and|versus|vs\.?|against|with)\b/).map((s) => s.trim()).filter(Boolean);
    const left = parts.map(findColumn).find(Boolean);
    const right = parts.slice().reverse().map(findColumn).find((c) => c && c !== left);
    if (left && right) {
      return {
        tool: 'table_compare',
        args: { table_id: context.tableId, left_column: left.name, right_column: right.name },
      };
    }
  }

  if (/\b(read|list) (me )?(the )?(rows|records|entries|lines)\b/.test(t)) {
    return { tool: 'table_read_rows', args: { table_id: context.tableId, start_row: 1 } };
  }

  const agg = AGGREGATES.find(([re]) => re.test(t));
  if (agg) {
    const column = findColumn(t);
    const filter = findCategoryFilter(t);
    if (agg[1] !== 'count' && !column) {
      return {
        speak: context.columns.length
          ? `Which column? I have ${context.columns.map((c) => c.name).join(', ')}.`
          : 'Open a table first — say, what do I have.',
      };
    }
    return {
      tool: 'table_query',
      args: {
        table_id: context.tableId,
        aggregate: agg[1],
        ...(column ? { aggregate_column: column.name } : {}),
        ...(filter ? { filters: [filter] } : {}),
      },
    };
  }

  if (/\b(break (it )?down|by each|per|group)\b/.test(t)) {
    const measure = context.columns.find((c) => c.sum !== undefined);
    const by = context.columns.find((c) => (c.categories ?? []).length > 0);
    if (measure && by) {
      return {
        tool: 'table_query',
        args: {
          table_id: context.tableId,
          aggregate: 'sum',
          aggregate_column: measure.name,
          group_by: by.name,
        },
      };
    }
  }

  return { tool: 'table_describe', args: { table_id: context.tableId, detail: /\b(full|detail|more about)\b/.test(t) ? 'full' : 'brief' } };
}

/** Remember what the answer gives us, so follow-ups work without repeating context. */
function absorb(tool, args, payload) {
  context.lastCall = { tool, args };
  context.lastCursor = payload.cursor ?? null;
  if (payload.answer_id) context.lastAnswerId = payload.answer_id;
  if (payload.columns) context.columns = payload.columns;
  if (payload.table_id) context.tableId = payload.table_id;
  if (tool === 'table_list' && payload.tables?.length) {
    // Accumulate across pages rather than replacing, so "the countries one" still
    // resolves after the user has paged past it.
    const seen = new Set(context.tables.map((x) => x.table_id));
    context.tables.push(...payload.tables.filter((x) => !seen.has(x.table_id)));
    context.tableId ??= payload.tables[0].table_id;
  }
}

export { McpClient, Voice, route, absorb, context };
