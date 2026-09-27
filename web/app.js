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
 * problem the server exists to solve. The one thing added is the name of a table the
 * client moved to on its own, because a listener cannot see which file answered.
 */

const PROTOCOL_VERSION = '2025-11-25';
// Same origin as the page, so the deployed Worker serves both. Guarded so this
// module can be imported by the routing tests under Node, where there is no page.
const ENDPOINT =
  typeof location === 'undefined' ? 'http://localhost:8787/mcp' : new URL('/mcp', location.href).href;

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

/**
 * One id per browser, kept across reloads.
 *
 * The server keeps answers, bookmarks and heading corrections per caller, and a caller
 * that names no session lands in one namespace shared with every other such caller.
 * This client used to name none — so two judges trying the demo at once overwrote
 * each other's saved place, and one person's heading correction changed the numbers
 * the other heard. It has to survive a reload, because "save my place, reload, carry
 * on" is the feature being demonstrated.
 *
 * Storage can be refused (private windows, sandboxed frames) and randomUUID needs a
 * secure context, so each falls back rather than breaking the client. The fallback id
 * lasts for this page only: still isolation, just not persistence.
 */
const SESSION_KEY = 'landmark-session';
let memorySession = null;

function newSessionId() {
  const c = globalThis.crypto;
  try {
    if (typeof c?.randomUUID === 'function') return c.randomUUID();
  } catch {
    // Not a secure context. Fall through to plain random bytes.
  }
  if (typeof c?.getRandomValues === 'function') {
    return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Isolation between visitors, not a secret: nothing is protected by this id.
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function browserSession() {
  let saved = null;
  try {
    saved = globalThis.localStorage?.getItem(SESSION_KEY) ?? null;
  } catch {
    // Storage refused; the in-memory id below stands in for it.
  }
  if (saved) return saved;
  memorySession ??= newSessionId();
  try {
    globalThis.localStorage?.setItem(SESSION_KEY, memorySession);
  } catch {
    // Kept for this page only.
  }
  return memorySession;
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

/**
 * Read a JSON-RPC reply out of a Streamable HTTP response body.
 *
 * The first version took the first line beginning with "data:" and parsed it. That is
 * not what an event stream is. A conforming server may send a comment as a keep-alive,
 * may send notifications or a ping ahead of the reply, and may split one event's data
 * across several "data:" lines which the reader is required to rejoin with newlines.
 * Against any of those this client would have thrown, or — worse — answered the
 * question using a notification it mistook for the result.
 *
 * Events are separated by a blank line; within an event, one leading space after the
 * colon is part of the syntax rather than the data. The reply we want is the one
 * carrying our own request id; falling back to the first message with a result or an
 * error keeps a server that omits the id working rather than failing the call.
 */
function readEventStream(text, id) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A keep-alive comment or a partial frame. Not ours to interpret.
    }
  }
  return (
    messages.find((m) => m && m.id === id) ??
    messages.find((m) => m && (m.result !== undefined || m.error !== undefined)) ??
    null
  );
}

class McpClient {
  #id = 0;
  #initialized = false;
  #session = browserSession();
  /** The transport session the server issued at initialize, if it issued one. */
  #mcpSession = null;
  lastLatencyMs = 0;
  tools = [];

  /**
   * Every request names this browser's session. The notification used to go out
   * without it too, so the one request that tells the server the handshake finished
   * arrived as a stranger.
   */
  #headers() {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-landmark-session': this.#session,
      // The transport spec requires a client to echo a session id the server issued.
      // The server reads x-landmark-session first, so this per-page id does not
      // replace the per-browser one that bookmarks survive a reload on.
      ...(this.#mcpSession ? { 'mcp-session-id': this.#mcpSession } : {}),
      ...(this.#initialized ? { 'mcp-protocol-version': PROTOCOL_VERSION } : {}),
    };
  }

  async #rpc(method, params) {
    const id = ++this.#id;
    const started = performance.now();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    this.lastLatencyMs = Math.round(performance.now() - started);

    if (!res.ok) throw new Error(`The table service answered ${res.status}.`);
    if (method === 'initialize') this.#mcpSession = res.headers.get('mcp-session-id') || null;

    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    // Streamable HTTP lets the server answer a POST with either JSON or an event
    // stream, and the choice is the server's. A client that handles only one of them
    // works until the day the deployment is configured the other way.
    let body;
    if (type.includes('application/json')) {
      body = JSON.parse(text);
    } else {
      body = readEventStream(text, id);
    }
    if (!body) throw new Error('The table service sent an empty reply.');
    if (body.error) throw new Error(body.error.message ?? 'The table service refused that.');
    return body.result;
  }

  async #notify(method) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
    // Read the empty 202 to its end. Chromium logs an unread body as an aborted
    // request, and a red "failed" line in the network panel during the handshake
    // looks like a protocol error to anyone watching it.
    await res.text().catch(() => '');
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

const Recognition =
  typeof window === 'undefined' ? undefined : (window.SpeechRecognition ?? window.webkitSpeechRecognition);

class Voice {
  #recognition = null;
  #utterance = null;
  #primed = false;
  onheard = () => {};
  onstate = () => {};
  /**
   * A recognition failure, by its Web Speech error code. These used to collapse into
   * one visual "Say again?" — which is the wrong advice for a blocked or missing
   * microphone, and advice a blind user never saw.
   */
  onproblem = () => {};

  get canListen() {
    return Boolean(Recognition);
  }

  get canSpeak() {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  get supported() {
    return typeof window !== 'undefined' && this.canListen && this.canSpeak;
  }

  listen() {
    if (!Recognition) return false;
    this.stopSpeaking(); // barge-in: a new question cancels the current answer
    this.stopListening();
    const r = new Recognition();
    r.lang = 'en-US';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      this.onheard(last[0].transcript.trim(), last.isFinal, last[0].confidence);
    };
    // Listening is announced when the microphone is actually open, not when it was
    // asked for: a permission prompt can sit between the two, and the tone that
    // tells someone to start talking must not play before anything can hear them.
    r.onstart = () => {
      if (this.#recognition === r) this.onstate('listening');
    };
    r.onend = () => {
      if (this.#recognition === r) this.#recognition = null;
      this.onstate('idle');
    };
    r.onerror = (e) => this.onproblem(e.error ?? 'unknown');
    this.#recognition = r;
    try {
      r.start();
    } catch {
      this.#recognition = null;
      this.onproblem('start-failed');
    }
    return true;
  }

  stopListening() {
    // abort, not stop: stop() still delivers whatever was heard so far, so an
    // interrupted question went on to be answered anyway.
    const r = this.#recognition;
    this.#recognition = null;
    try {
      r?.abort();
    } catch {
      // Already ended.
    }
  }

  /**
   * iOS Safari only speaks if the first utterance of the page starts inside a user
   * gesture, and every answer here arrives after a network round trip. One silent
   * utterance, spoken from the first tap, unlocks the ones that follow.
   */
  prime() {
    if (this.#primed || !this.canSpeak) return;
    this.#primed = true;
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {
      // Nothing to unlock.
    }
  }

  /** `onend` receives null when the sentence finished, or the error code when it did not. */
  speak(text, onend) {
    this.stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.0;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      // Only the utterance still current may change the display. A cancelled one
      // reports late — after its replacement has started — and must not mark the
      // new answer as finished.
      if (this.#utterance === u) {
        this.#utterance = null;
        this.onstate('idle');
      }
      onend?.(error);
    };
    u.onend = () => finish(null);
    // Chromium ends a cancelled utterance with an error event ("interrupted",
    // "canceled", or "not-allowed" before the page has had a gesture) and no end
    // event. Waiting on end alone left every interrupted turn hanging until a timer.
    u.onerror = (e) => finish(e.error ?? 'error');
    this.#utterance = u;
    this.onstate('speaking');
    try {
      speechSynthesis.speak(u);
    } catch {
      finish('error');
    }
  }

  stopSpeaking() {
    if (!this.canSpeak) return;
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    this.#utterance = null;
  }
}

// ---------------------------------------------------------------------------
// Conversation memory
// ---------------------------------------------------------------------------

function freshContext() {
  return {
    tableId: null,
    /**
     * Whether they picked the current table. The page defaults to the first file in the
     * list, and answering a question from a file nobody chose — without saying which —
     * is how "what's the total revenue" came to depend on catalogue order.
     */
    chosen: false,
    lastAnswerId: null,
    /** The last answer was given, but the server could not keep its working. */
    workingLost: false,
    lastCursor: null,
    lastCall: null,
    /** The last number asked for, so "break it down" breaks down that measure. */
    lastQuery: null,
    columns: [],
    /** Everything the server said exists, so an utterance can name one. */
    tables: [],
    /** Columns learned per table by describing it, so a question can find its table. */
    known: {},
    /** A question we asked back, waiting on one more word to become answerable. */
    pending: null,
    /** Where in the table they actually are, so a bookmark saves the place they reached. */
    row: null,
    /** The bookmark this conversation is using, so "carry on" goes somewhere. */
    bookmarkName: null,
    /** The reading a structure check just reported, so "yes, that's right" can confirm it. */
    structure: null,
    /**
     * Which table inside the file is open, when it is not the first: a region id the
     * server listed, sent as `sheet` on every call about this file. Describe says "Say
     * 'table 2' to open one", and saying it used to describe table 1 again.
     */
    sheet: null,
    /** The tables inside each file, as the last describe of it listed them. */
    regions: {},
  };
}

/** Conversation memory: what we are looking at and what we last said. */
const context = freshContext();

/** Forget the conversation, as a reload does. The server-side session is untouched. */
function resetContext() {
  Object.assign(context, freshContext());
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * Lowercase whole words, with accents folded. Comparing words rather than substrings
 * is the entire point. Folding matters because the fixtures hold names like "Bảo" and
 * "Dũng": split on a-z alone they became meaningless fragments, and a typed "bao"
 * could never find them.
 */
function words(text) {
  return writtenWords(text).map((w) => w.toLowerCase());
}

/** The same words with their capitals kept, because "An" typed mid-sentence is a name. */
function writtenWords(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The crudest useful plural folding. People say "departments" for a column called
 * Department and "designs" for a value called Design; an exact match turned both into
 * a silently dropped filter. Applied to both sides, so a wrong stem still agrees with
 * itself.
 */
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Words worth comparing: stemmed, and never a stray letter left by "what's". */
function terms(text) {
  return words(text).map(stem).filter((w) => w.length > 1 || /\d/.test(w));
}

const stems = (list) => new Set(list.split(/\s+/).filter(Boolean).map(stem));

/**
 * Words that carry intent rather than naming anything, stripped before matching a
 * table. One of the sheets is called "Compare", and "compare target and actual" is a
 * request to compare two columns of the table already open — not a request to switch
 * to a different file whose tab happens to share that word. The heading words are here
 * for the same reason: "use two heading rows" is about this table, not the one called
 * "02 stacked header".
 */
const INTENT_WORDS = stems(
  'compare versus vs read list total sum average mean count more next continue keep going save ' +
    'bookmark remember resume describe explain group breakdown highest lowest maximum minimum max ' +
    'min biggest smallest most least structure heading headings header headers row rows data first ' +
    'zero one two three which per each every',
);

/** Words too generic to identify a table: they appear in half the sentences spoken. */
const STOP_WORDS = stems(
  'the a an of and to in it is my me that this one file files table tables sheet sheets ' +
    'spreadsheet about show tell open what whats how do i have for from with',
);

/**
 * Words that can sit in a question about numbers without naming anything in the table.
 * Anything else that matches no column and no value is treated as something the
 * listener meant and we missed — and asked about, rather than dropped. Dropping it was
 * the worst failure this client had: "total for engineeringg" silently became the total
 * of everything, spoken with the same confidence as a right answer.
 */
const FILLER = stems(
  'the a an of and or but to in on at into onto from with without for by per as is are was were be ' +
    'been being am it its this that these those there here then than so such i me my mine we us our ' +
    'you your he she they them their his her what whats which who whom whose where when why how do ' +
    'does did done doing have has had having can could would should will shall may might must please ' +
    'just only also too very really quite about around roughly approximately much many more most less ' +
    'least few all any some each every both either whole entire overall altogether combined together ' +
    'give get got tell show say said let lets know find see want need like row rows record records ' +
    'entry entries line lines value values number numbers figure figures data column columns field ' +
    'fields table tables file files sheet sheets spreadsheet spreadsheets tab tabs one ones workbook ' +
    'total totals sum average mean typical count highest lowest maximum minimum max min biggest ' +
    'smallest largest greatest best worst top bottom big small large high low higher lower up down ' +
    'add break breakdown broken split group grouped spend spent spending cost make made earn earned ' +
    'sell sold yes no not ok okay right now again same other else hey hi hello thanks thank there ' +
    'different distinct separately open switch go look use describe read compare versus vs against ' +
    'deal deals sale sales transaction transactions money fewest bigger larger greater better smaller worse ' +
    'rank ranked ranking sort sorted except excluding exclude excluded outside besides apart bring brought ' +
    'difference between across among within save bookmark resume continue keep next',
);

/**
 * Words that only hold a sentence together. A listed value is matched on its other
 * words. Stripping all of FILLER instead made High, Low, Open, Yes, No and Other —
 * the ordinary values of priority, status and flag columns — impossible to name, and
 * "how many are open" counted every row.
 */
const GRAMMAR = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'is', 'are', 'it']);

/** Words that ask for a number. A value made of them (Top, Average) is also the question. */
const ASKING = stems(
  'total sum altogether average mean typical highest maximum max biggest largest most best top ' +
    'lowest minimum min smallest least worst fewest count',
);

/** Words after which a name is being given: "for An", "did An sell", "by An", "what about An". */
const VALUE_SLOT = new Set(['for', 'did', 'does', 'by', 'from', 'of', 'where', 'about']);

/** A value made only of words a sentence uses anyway: "An", "IT", "Top", a grade "A". */
const weakWord = (w) => GRAMMAR.has(w) || ASKING.has(stem(w)) || (w.length < 2 && !/\d/.test(w));

/** "a, b and c" — spoken lists use "and", not a trailing comma. */
function spokenList(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** How far apart two phrases are, 0 to 1: enough to tell "engineeringg" is near Engineering. */
function similarity(a, b) {
  const x = words(a).join('');
  const y = words(b).join('');
  if (!x || !y) return 0;
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return 1 - row[y.length] / Math.max(x.length, y.length);
}

// ---------------------------------------------------------------------------
// Tables and columns
// ---------------------------------------------------------------------------

const isMeasure = (c) => typeof c.sum === 'number';

/**
 * A column name as it should be heard. The server spells a stacked heading with commas
 * ("2026, Q1, Revenue"), and spoken aloud five such columns are thirteen comma-separated
 * items — the listener cannot hear where one column ends and the next begins. The
 * comma form is still what goes back to the server.
 */
function nameOf(c) {
  return String(c.name ?? c).replace(/,\s*/g, ' ');
}

/**
 * The words a column can be called by: every heading segment, with bracketed units
 * dropped. Nobody says "GDP per capita U S D", and requiring it meant the column was
 * unreachable by the name people actually use.
 */
function segmentsOf(c) {
  const path = Array.isArray(c.header_path) && c.header_path.length ? c.header_path : [c.name ?? c];
  const bare = path.map((s) => terms(String(s).replace(/\([^)]*\)|\[[^\]]*\]/g, ' '))).filter((s) => s.length);
  return bare.length ? bare : path.map((s) => terms(String(s))).filter((s) => s.length);
}

/**
 * How well an utterance names a column.
 *
 * Scored over every segment of the header path rather than only the last one. A
 * quarterly sheet has four columns whose final segment is "Revenue"; matching on that
 * alone made all four equally good, and the tie went to whichever came first — so "the
 * total 2025 Q2 revenue" confidently spoke the 2026 Q1 figure, which is exactly the
 * kind of wrong a listener cannot catch. Naming the year and the quarter now beats
 * merely sharing the word revenue. A segment made only of question words ("Total")
 * counts for little, so "the total amount" means Amount even beside a Total column.
 */
function scoreColumn(c, have) {
  let score = 0;
  for (const seg of segmentsOf(c)) {
    if (seg.every((w) => have.has(w))) {
      score += seg.some((w) => !FILLER.has(w)) ? 100 + seg.length : 1;
      continue;
    }
    // "The GDP of Vietnam" means "GDP per capita": a distinctive word of a longer
    // heading, worth far less than naming a heading whole, so it only decides when
    // nothing is named whole. Requiring every word left the column unreachable by the
    // name people shorten it to.
    const hit = seg.length > 1 ? seg.filter((w) => have.has(w) && !FILLER.has(w) && !/^\d+$/.test(w)).length : 0;
    if (hit) score += 10 + hit;
  }
  return score;
}

/** The best-matching column, or every column tied for best when the words cannot choose. */
function pickColumn(text, pool) {
  const have = new Set(terms(text));
  const ranked = pool
    .map((c) => ({ c, score: scoreColumn(c, have) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { column: null, tied: [] };
  const tied = ranked.filter((m) => m.score === ranked[0].score).map((m) => m.c);
  return tied.length === 1 ? { column: tied[0], tied: [] } : { column: null, tied };
}

function findColumn(text, pool = context.columns) {
  return pickColumn(text, pool).column;
}

/**
 * Where a value made only of everyday words ("An", "IT", "Top") was said as a name.
 *
 * Such a value cannot be matched on its words alone — "an" is in half of everything
 * anyone says — and it cannot be ignored either: the rep called An was silently dropped,
 * and "total revenue for An" spoke the total of every rep. So it counts where a name
 * goes: after "for", "did", "by"; beside its own column's name ("rep An", "top
 * priority"); as a possessive; or typed with its own capitals mid-sentence. An article
 * in front of a word it belongs to ("an average") is grammar. What is left is a word
 * spelled like an article that no article reading explains, which is asked about:
 * `'value'`, `'unsure'`, or null.
 */
function weakValueUse(said, value, c) {
  const raw = words(said);
  const written = writtenWords(said);
  const vw = words(value);
  const vwritten = writtenWords(value);
  const own = new Set(segmentsOf(c).flat());
  const ownWord = (w) => w !== undefined && own.has(stem(w));
  const asking = vw.some((w) => ASKING.has(stem(w)));
  const capitalised = /\p{Lu}/u.test(value);
  // "How much did it cost" is about the table, whatever department is called IT. The
  // department is said as "IT", or beside its column's name.
  const pronoun = vw.length === 1 && vw[0] === 'it';
  let unsure = false;
  for (let i = 0; i + vw.length <= raw.length; i++) {
    if (!vw.every((w, k) => raw[i + k] === w)) continue;
    const prev = raw[i - 1];
    const next = raw[i + vw.length];
    const article =
      vw.length === 1 &&
      next !== undefined &&
      ((vw[0] === 'an' && /^([aeiou]|h(our|onest|onou?r|eir))/.test(next)) || vw[0] === 'a' || vw[0] === 'the');
    if (article) continue;
    if (
      (!pronoun && VALUE_SLOT.has(prev)) ||
      ownWord(prev) ||
      ownWord(next) ||
      (!pronoun && next === 's') ||
      prev === vw[0] ||
      (asking && ['is', 'are', 'was', 'were'].includes(prev)) ||
      (['is', 'was'].includes(prev) && (ownWord(raw[i - 2]) || raw[i - 2] === 'where')) ||
      (i > 0 && capitalised && vwritten.every((w, k) => written[i + k] === w))
    ) {
      return 'value';
    }
    // "It", "in" and "on" hold every other sentence together, so only a name spelled
    // like an article, and not used as one, is worth a question.
    if (vw.length === 1 && ['a', 'an', 'the'].includes(vw[0])) unsure = true;
  }
  return unsure ? 'unsure' : null;
}

/** Words that turn a value into one to leave out: "not in Asia", "excluding the East". */
const NEGATION = new Set(['not', 'except', 'excluding', 'exclude', 'without', 'outside', 'besides']);

/**
 * Is this value said as one to leave out? The words before it are read back past
 * grammar and the column's own name ("not in the Asia region", "other than the Design
 * department"). Ignored, "how many countries are not in Asia" counted the countries in
 * Asia — the opposite answer, said with the same confidence.
 */
function negatedValue(said, value, c) {
  const raw = words(said);
  const vw = words(value);
  const own = new Set(segmentsOf(c).flat());
  for (let i = 0; i + vw.length <= raw.length; i++) {
    if (!vw.every((w, k) => stem(raw[i + k]) === stem(w))) continue;
    let j = i - 1;
    while (j >= 0 && (GRAMMAR.has(raw[j]) || ['from', 'be', 'any', 'all'].includes(raw[j]) || own.has(stem(raw[j])))) j--;
    const before = raw[j];
    if (NEGATION.has(before)) return true;
    if (before === 'than' && raw[j - 1] === 'other') return true;
    if (before === 'apart' || (before === 'from' && raw[j - 1] === 'apart')) return true;
  }
  return false;
}

/** The words that name a yes-or-no column: "Paid", "Is active" → paid, active. */
const flagWords = (c) => segmentsOf(c).flat().filter((w) => !GRAMMAR.has(w));

/**
 * A yes-or-no column said as a predicate — "are paid", "paid tasks", "not paid",
 * "unpaid", "haven't been paid" — as the stored answer to filter on, and whether it was
 * negated. Not after "by" or "per", where the column is what to group by.
 */
function flagSaid(said, c) {
  const own = flagWords(c);
  if (!own.length) return null;
  const raw = words(said);
  const yes = (c.categories ?? []).find((v) => /^(yes|true|y|có)$/i.test(String(v))) ?? 'Yes';
  for (let i = 0; i + own.length <= raw.length; i++) {
    const un = own.length === 1 && raw[i] === `un${own[0]}`;
    if (!un && !own.every((w, k) => stem(raw[i + k]) === w)) continue;
    if (['by', 'per', 'each', 'every'].includes(raw[i - 1])) return null;
    let j = i - 1;
    while (j >= 0 && (GRAMMAR.has(raw[j]) || ['be', 'been', 'being', 'yet', 'was', 'were', 'is', 'are', 'got', 'get'].includes(raw[j]))) j--;
    // "Aren't" reaches here as "aren" and "t".
    const negated = un || ['not', 'never', 'no'].includes(raw[j]) || (raw[j] === 't' && /n$/.test(raw[j - 1] ?? ''));
    return { value: String(yes), negated };
  }
  return null;
}

/**
 * Values named in the utterance, from any column the server listed values for — not
 * only columns typed as categories. Region in the flat sample holds three values over
 * five rows, so it was typed as text, and "revenue for north" dropped North.
 *
 * `unsure` holds values that may have been named and may have been grammar; the caller
 * asks rather than guess either way.
 */
function findFilters(text, pool = context.columns) {
  const have = new Set(terms(text));
  // The words in order, to tell "north west" said as one phrase from "north and west".
  // Grammar inside a value's name ("Bank of America") is skipped; "and" and "or",
  // which separate values, are kept.
  const sequence = terms(text)
    .filter((w) => !GRAMMAR.has(w) || w === 'and' || w === 'or')
    .join(' ');
  const filters = [];
  const unsure = [];
  let several = null;
  let severalValues = [];
  for (const c of pool) {
    const hits = [];
    for (const v of c.categories ?? []) {
      const value = String(v);
      // A flag column's Yes and No are words every reply is made of, so they count
      // only where a value goes — "paid yes", "for no" — never as a bare "yes".
      if (c.type === 'boolean' || words(value).every(weakWord)) {
        const use = weakValueUse(text, value, c);
        if (use === 'value') hits.push({ v: value, t: [], n: words(value).length });
        else if (use === 'unsure') unsure.push({ column: c, value });
        continue;
      }
      const vt = terms(value).filter((w) => !GRAMMAR.has(w));
      if (vt.length && vt.every((w) => have.has(w))) hits.push({ v: value, t: vt, n: vt.length });
    }
    // A value inside a longer one said as one phrase is part of it: "north west" is
    // North West, not North and West as well — which read as several values and
    // answered for every region.
    const kept = hits.filter(
      (h) =>
        !hits.some(
          (o) =>
            o !== h &&
            h.t.length > 0 &&
            o.t.length > h.t.length &&
            ` ${sequence} `.includes(` ${o.t.join(' ')} `) &&
            h.t.every((w) => o.t.includes(w)),
        ),
    );
    if (!kept.length) {
      // A yes-or-no column named on its own: "how many are paid", "paid tasks", "not
      // paid", "unpaid". Only "paid yes" used to filter; the rest counted every row.
      const flag = c.type === 'boolean' ? flagSaid(text, c) : null;
      if (flag) filters.push({ column: c.name, op: flag.negated ? 'neq' : 'eq', value: flag.value });
      continue;
    }
    kept.sort((a, b) => b.n - a.n);
    const op = kept.some((h) => negatedValue(text, h.v, c)) ? 'neq' : 'eq';
    filters.push({ column: c.name, op, value: kept[0].v });
    // "Engineering and design" cannot be one filter — filters combine with AND — so it
    // becomes one answer per value, for those values and no others.
    if (kept.length > 1 && !several) {
      several = c;
      severalValues = kept.map((h) => h.v);
    }
  }
  return { filters, several, severalValues, unsure };
}

const MONTH_WORDS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
/** A month, with a day and a year when said: "August", "August 2", "Aug 2nd, 2026". */
const MONTH_AT = new RegExp(`\\b(${MONTH_WORDS})\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b)?(?:,?\\s+(\\d{4}))?\\b`, 'g');
const MONTH_FULL = MONTH_WORDS.split('|').slice(0, 12);

/** The opposite condition: "not over 50 million" is at most 50 million. */
const INVERSE_OP = { eq: 'neq', neq: 'eq', gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt' };

/** Words a negation can stand behind: "don't HAVE a", "were not closed in". */
const NEGATION_SKIP = new Set([
  ...GRAMMAR, 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'was', 'were', 'be', 'been', 'being', 'any', 'all',
]);

/** The words of a sentence with where each one sits, so a phrase can be cut out of it. */
function wordSpans(text) {
  return [...String(text).matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    w: words(m[0])[0] ?? '',
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * A negation just before a condition, read back past grammar, "have" and "do", and the
 * condition's own column ("don't have a population over", "were not closed in"). Ignored,
 * "how many countries don't have a population over 50 million" counted the five that do,
 * and "total revenue not in August" totalled August — the opposite rows, said with the
 * same confidence. Returns where the negation sits, so it can be taken out of the words.
 */
function negationBefore(text, end, column) {
  const own = new Set(column ? segmentsOf(column).flat() : []);
  // "Closed" is also said "close" and "closing".
  const ownish = (w) => own.has(stem(w)) || [...own].some((o) => o.length >= 4 && w.length >= 4 && o.slice(0, 4) === w.slice(0, 4));
  const toks = wordSpans(String(text).slice(0, end));
  let j = toks.length - 1;
  // A comma ends the clause: "no, over 50 million" corrects, it does not negate.
  const broken = (k) => /[,.;:!?]/.test(String(text).slice(toks[k].end, k + 1 < toks.length ? toks[k + 1].start : end));
  while (j >= 0 && !broken(j) && (NEGATION_SKIP.has(toks[j].w) || ownish(toks[j].w))) j--;
  if (j < 0 || broken(j)) return null;
  const w = toks[j].w;
  const prev = toks[j - 1]?.w ?? '';
  const span = (from) => ({ start: toks[from].start, end: toks[j].end });
  // A "no" that opens the sentence answers something: "no over 100 million" moves a bound.
  if (w === 'no' && j === 0) return null;
  if (['not', 'never', 'no', 'except', 'excluding', 'exclude', 'without', 'outside', 'besides', 'apart'].includes(w)) return span(j);
  // "Don't", "isn't", "aren't" reach here as "don" and "t".
  if (w === 't' && /n$/.test(prev)) return span(j - 1);
  if (w === 'than' && prev === 'other') return span(j - 1);
  if (w === 'from' && prev === 'apart') return span(j - 1);
  if (w === 'of' && prev === 'outside') return span(j - 1);
  return null;
}

/** Blank out part of a sentence, keeping every other word where it was. */
const blank = (text, start, end) => `${text.slice(0, start)}${' '.repeat(end - start)}${text.slice(end)}`;

/**
 * The words before a date that bound it, longest first. "On or after August 2" is August
 * 2 onwards: read one word at a time it was "after", and the total left August 2 out.
 * "Up to", "by" and "no later than" reached the server as the day itself. `from` is
 * decided by what follows; `in` and its kind are the date itself.
 */
const DATE_BOUNDS = [
  ['on or after', 'gte'], ['on or before', 'lte'], ['starting from', 'gte'], ['starting on', 'gte'],
  ['beginning from', 'gte'], ['beginning on', 'gte'], ['up to', 'lte'], ['up until', 'lte'], ['later than', 'gt'],
  ['earlier than', 'lt'], ['prior to', 'lt'], ['as of', 'gte'], ['starting', 'gte'], ['beginning', 'gte'],
  ['since', 'gte'], ['after', 'gt'], ['before', 'lt'], ['until', 'lte'], ['till', 'lte'], ['til', 'lte'],
  ['through', 'lte'], ['thru', 'lte'], ['by', 'lte'], ['upto', 'lte'], ['from', 'from'], ['between', 'from'],
  ['in', 'eq'], ['during', 'eq'], ['for', 'eq'], ['of', 'eq'], ['throughout', 'eq'], ['over', 'eq'], ['on', 'eq'],
].map(([phrase, op]) => ({ w: phrase.split(' '), op }));

/** Words after a date that open it up: "August 2 or later", "from August onwards". */
const DATE_AFTER = [
  ['or later', 'gte'], ['and later', 'gte'], ['or after', 'gte'], ['and after', 'gte'], ['onwards', 'gte'],
  ['onward', 'gte'], ['or earlier', 'lte'], ['and earlier', 'lte'], ['or before', 'lte'], ['and before', 'lte'],
].map(([phrase, op]) => ({ w: phrase.split(' '), op }));

/** The month said at `m`, as the server reads it: "August", "August 2", "August 2, 2026". */
function monthValue(m) {
  const full = MONTH_FULL.find((name) => name.startsWith(m[1])) ?? m[1];
  return `${full.charAt(0).toUpperCase()}${full.slice(1)}${m[2] ? ` ${m[2]}` : ''}${m[3] ? `${m[2] ? ',' : ''} ${m[3]}` : ''}`;
}

/**
 * "In August", "since July", "on or before August 27", "not in August", "from July to
 * August": conditions on the table's one date column, when no column is called August.
 *
 * A month counts only with a word that places it in time, a day, or a year after it,
 * because "may" and "march" are also everyday words. "From August" alone is still August
 * — "the deals from September" is a listing of September's — unless "on" or "onwards"
 * follows it. The server reads a month with an ordering condition as the days it spans,
 * in the year said or the one every row shares, and asks when the rows span several.
 *
 * A day said with no word that bounds it ("deals closed August 27", "from August 2") is
 * asked about: sent as that day alone, "up to August 27" totalled one deal.
 */
function monthIn(rest, cols) {
  const dates = cols.filter((c) => c.type === 'date');
  if (dates.length !== 1) return null;
  const column = dates[0];
  const text = String(rest).toLowerCase();
  for (const m of text.matchAll(MONTH_AT)) {
    if (cols.some((c) => segmentsOf(c).flat().includes(stem(m[1])))) return null;
    const pre = wordSpans(text.slice(0, m.index));
    const post = wordSpans(text.slice(m.index + m[0].length)).map((x) => ({
      ...x,
      start: x.start + m.index + m[0].length,
      end: x.end + m.index + m[0].length,
    }));
    const ends = (phrase) => phrase.length <= pre.length && phrase.every((w, k) => pre[pre.length - phrase.length + k].w === w);
    const starts = (phrase) => phrase.length <= post.length && phrase.every((w, k) => post[k].w === w);
    const bound = DATE_BOUNDS.find((b) => ends(b.w));
    let start = bound ? pre[pre.length - bound.w.length].start : m.index;
    let end = m.index + m[0].length;
    let op = bound?.op ?? null;
    const after = DATE_AFTER.find((a) => starts(a.w));
    if (after && (!op || op === 'eq' || op === 'from')) {
      op = after.op;
      end = post[after.w.length - 1].end;
    } else if (op === 'from' && post[0]?.w === 'on') {
      // "From August 2 on".
      op = 'gte';
      end = post[0].end;
    }
    // "From July to August", "between July 10 and August 5": both ends.
    const joins = bound?.w[0] === 'between' ? ['and'] : ['to', 'until', 'till', 'through', 'thru'];
    if (op === 'from' && post[0] && joins.includes(post[0].w)) {
      const second = [...text.slice(post[0].end).matchAll(MONTH_AT)][0];
      if (second && !text.slice(post[0].end, post[0].end + second.index).trim()) {
        const closes = post[0].end + second.index + second[0].length;
        const filters = [
          { column: column.name, op: 'gte', value: monthValue(m) },
          { column: column.name, op: 'lte', value: monthValue(second) },
        ];
        const neg = negationBefore(text, start, column);
        if (neg) {
          return { filters: [], index: start, length: closes - start, ask: `I can leave out one end of a range at a time, not both. Ask for before ${monthValue(m)} and after ${monthValue(second)} separately.` };
        }
        return { filters, index: start, length: closes - start };
      }
    }
    if (op === 'from') op = m[2] ? null : 'eq';
    const value = monthValue(m);
    const neg = negationBefore(text, start, column);
    if (!op && !neg && !m[2] && !m[3]) continue; // "may", "march": everyday words, not a month
    if (!op && m[2] && !neg) {
      // A day with nothing to say which side of it: ask, rather than send the day alone.
      return {
        filters: [],
        index: start,
        length: end - start,
        ask: `Do you mean on ${value} only, up to ${value}, or from ${value} on? Say "on", "up to" or "from".`,
        pending: { value },
      };
    }
    op ??= 'eq';
    if (neg) {
      op = INVERSE_OP[op];
      start = neg.start;
    }
    return { filters: [{ column: column.name, op, value }], index: start, length: end - start };
  }
  return null;
}

/**
 * Conditions on numbers: "revenue over 10000", "a population above 100 million". The
 * column is the number column named just before the condition, else the only one
 * named, else the table's only one. The words are taken out of the question, so what
 * is left can be matched as usual.
 */
function comparisonsIn(said, cols) {
  const measures = cols.filter(isMeasure);
  const filters = [];
  let rest = String(said);
  for (let guard = 0; guard < 3; guard++) {
    const m = rest.toLowerCase().match(COMPARISON);
    if (!m) break;
    let before = rest.slice(0, m.index);
    const tail = before.toLowerCase().split(/\b(?:and|with|where|whose|that|who)\b/).pop() ?? '';
    const named = pickColumn(tail, measures).column;
    const column = named ?? pickColumn(rest, measures).column ?? (measures.length === 1 ? measures[0] : null);
    if (!column) return { filters, rest, missing: m[0].trim() };
    const value = `${m[2].replace(/\s+/g, ' ').trim()}${m[3] ?? ''}`;
    // "Don't have a population over 50 million", "not above 100 million": the other side.
    const neg = negationBefore(before, before.length, column);
    if (neg) before = blank(before, neg.start, neg.end);
    filters.push({ column: column.name, op: neg ? INVERSE_OP[COMPARISON_OPS[m[1]]] : COMPARISON_OPS[m[1]], value });
    // The words that named the condition's column go with the condition. Left in, they
    // outbid the measure asked for: "the total population where GDP per capita is under
    // 5000" totalled GDP per capita, and "total actual where target is over 9500" asked
    // "Target or Actual?" for ever. They stay only when nothing else names a measure —
    // "total population over 50 million" is still a total of Population.
    let head = before;
    if (named) {
      const own = new Set(segmentsOf(named).flat());
      const start = before.length - tail.length;
      const stripped = before.slice(start).replace(/[\p{L}\p{N}]+/gu, (w) => (own.has(stem(words(w)[0] ?? '')) ? ' ' : w));
      const candidate = `${before.slice(0, start)}${stripped} ${rest.slice(m.index + m[0].length)}`;
      const left = pickColumn(candidate, measures);
      if (left.column || left.tied.length) head = `${before.slice(0, start)}${stripped}`;
    }
    rest = `${head} ${rest.slice(m.index + m[0].length)}`;
  }
  // "Closed in August": the month, on the table's date column.
  const month = monthIn(rest, cols);
  if (month?.ask) {
    const date = month.pending ? { said: String(said), phrase: rest.slice(month.index, month.index + month.length), value: month.pending.value } : null;
    return { filters, rest, missing: null, ask: month.ask, date };
  }
  if (month) {
    filters.push(...month.filters);
    rest = `${rest.slice(0, month.index)} ${rest.slice(month.index + month.length)}`;
  }
  return { filters, rest, missing: null };
}

/**
 * The question back when a date's side was not said. The words are kept, so "up to" or
 * "on" alone finishes the question as it was asked.
 */
function askDateSide(cmp) {
  if (cmp.date) context.pending = { kind: 'date', ...cmp.date };
  return { speak: cmp.ask };
}

/**
 * "African", "Asian", "Vietnamese": a value said as the word for its people. Nothing
 * matched them, so "which African country has the highest population" was asked
 * about instead of answered. Only a word that names nothing else is folded, and only
 * onto a one-word value it plainly comes from.
 */
function foldDemonyms(said, cols) {
  const known = new Set();
  const values = new Map();
  for (const c of cols) {
    segmentsOf(c).flat().forEach((w) => known.add(w));
    for (const v of c.categories ?? []) {
      const t = terms(String(v));
      t.forEach((w) => known.add(w));
      if (t.length === 1 && t[0].length >= 4) values.set(t[0], String(v));
    }
  }
  if (!values.size) return said;
  return String(said).replace(/\p{L}+/gu, (w) => {
    const low = stem(words(w)[0] ?? '');
    if (!low || known.has(low) || FILLER.has(low)) return w;
    // Only the endings such words have — Asian, European, Vietnamese, Northern. Cutting
    // any ending folded a misheard "northe" onto North, a guess said as an answer.
    const cuts = /ese$|ern$/.test(low) ? [3] : /an$/.test(low) ? [1, 2] : /n$/.test(low) ? [1] : [];
    for (const cut of cuts) {
      const base = stem(low.slice(0, -cut));
      if (base.length >= 4 && values.has(base)) return values.get(base);
    }
    return w;
  });
}

/**
 * The aggregate asked for. A value that is itself an asking word — "how many are top
 * priority", "total hours for average ratings" — names a value there, so the question
 * is whatever the rest of the words ask.
 */
function askedFor(t, filters) {
  const agg = aggregateOf(t);
  const named = new Set(filters.flatMap((f) => words(f.value)).filter((w) => ASKING.has(stem(w))));
  if (!agg || !named.size) return agg;
  return aggregateOf(words(t).filter((w) => !named.has(w)).join(' ')) ?? agg;
}

/** Whether a column repeats its values, so grouping by it says something. */
function repeats(c) {
  if (typeof c.distinct === 'number' && typeof c.non_empty === 'number') {
    return c.distinct > 1 && c.distinct < c.non_empty;
  }
  return (c.categories?.length ?? 0) > 1;
}

/** What "break it down" groups by: the non-numeric column with the fewest repeating values. */
function defaultGroup(pool) {
  const size = (c) => c.distinct ?? c.categories?.length ?? Infinity;
  return (
    pool
      .filter((c) => !isMeasure(c) && c.type !== 'date' && repeats(c))
      .sort((a, b) => size(a) - size(b))[0] ?? null
  );
}

/**
 * A grouping column named in the utterance: "by region", "per department", "for each
 * rep", "which country". 'Per' only counts when a column follows it, because "GDP per
 * capita" is a column name, and treating its 'per' as a request to group answered a
 * question about GDP with population by region.
 */
function groupNamed(text, dims, whatToo) {
  const seq = terms(text);
  const triggers = new Set(['by', 'per', 'each', 'every', 'which', ...(whatToo ? ['what'] : [])]);
  for (let i = 0; i < seq.length; i++) {
    if (!triggers.has(seq[i])) continue;
    let j = i + 1;
    while (['the', 'each', 'every', 'an'].includes(seq[j])) j++;
    let best = null;
    for (const c of dims) {
      for (const seg of segmentsOf(c)) {
        if (seg.every((w, k) => seq[j + k] === w) && (!best || seg.length > best.n)) best = { c, n: seg.length };
      }
    }
    if (best) return best.c;
  }
  return null;
}

/** "How many departments": the column counted, when one follows "how many". */
function countedNamed(text, dims) {
  const seq = terms(text);
  const at = seq.indexOf('many');
  if (at < 0) return null;
  let j = at + 1;
  while (['different', 'distinct', 'separate', 'the'].includes(seq[j])) j++;
  for (const c of dims) {
    for (const seg of segmentsOf(c)) {
      if (seg.every((w, k) => seq[j + k] === w)) return c;
    }
  }
  return null;
}

/** A measure that is itself a rate, where adding rows together means nothing. */
function isRate(c) {
  return c.type === 'percent' || /\b(per|rate|ratio|average|avg|mean|price|percent|share)\b|%/i.test(nameOf(c));
}

/**
 * A file's name as it should be heard. A workbook with its own title row is called by it
 * — "FY2026 Departmental Budget", as describe says it — rather than by its file name,
 * which for the bundled samples is a test fixture's ("04 title and vmerge").
 */
function titleOf(tableId) {
  const table = context.tables.find((t) => t.table_id === tableId);
  const regions = Array.isArray(table?.regions) ? table.regions : [];
  const own = regions.length === 1 ? regions[0]?.title : null;
  return own || table?.title || tableId || 'this table';
}

/**
 * The columns known for a table without describing it: from an earlier describe, or
 * from the listing, which newer servers send per region as names alone.
 */
function knownColumns(tableId) {
  if (tableId === context.tableId && context.columns.length) return context.columns;
  if (context.known[tableId]?.length) return context.known[tableId];
  const listed = context.tables.find((t) => t.table_id === tableId)?.regions?.[0]?.columns ?? [];
  return listed.map((name) => ({ name }));
}

/** Every word that names a column or a value of a table. */
function tableTerms(tableId) {
  const set = new Set();
  for (const c of knownColumns(tableId)) {
    for (const seg of segmentsOf(c)) seg.forEach((w) => set.add(w));
    for (const v of c.categories ?? []) terms(String(v)).forEach((w) => set.add(w));
  }
  return set;
}

/**
 * Resolve a table named in an utterance.
 *
 * Without this, "describe the budget one" silently describes whatever table happened
 * to be current — which reads as the assistant ignoring you, and is worse than an
 * error because nothing announces that it went wrong. Matching is deliberately loose:
 * people say "the budget one", not "04-title-and-vmerge".
 *
 * It compares whole words, so "read that back to me flatly" does not select the table
 * called "01 flat" on the strength of a shared syllable, and it matches sheet names as
 * well as titles, because people name a spreadsheet by the tab they remember.
 *
 * What it must not do is take over a question. "How many regions" asked of the
 * countries table used to answer from the file called "05 three regions", silently. So
 * a word that is a column or a value of the table already open does not count towards
 * another table — unless the name is plainly being used as one ("the regions file",
 * "open …") — and a tie goes to the table already open.
 */
function findTable(text) {
  const seq = terms(text);
  const spoken = new Set(seq.filter((w) => !INTENT_WORDS.has(w)));
  const namedAsTable = new Set(
    seq.filter((w, i) => /^(file|table|sheet|spreadsheet|one|tab|workbook)$/.test(seq[i + 1] ?? '')),
  );
  const openWords = /\b(open|describe|switch to|go to|change to|move to|look at|use the|tell me about|what.?s in|what is in)\b/.test(
    String(text).toLowerCase(),
  );
  const here = tableTerms(context.tableId);

  let best = [];
  let bestScore = 0;
  for (const table of context.tables) {
    const names = [table.title, titleOf(table.table_id), table.table_id, ...(table.sheets ?? [])].join(' ');
    const nameTerms = [...new Set(terms(names))].filter((w) => w.length > 1 && !STOP_WORDS.has(w));
    const hits = nameTerms.filter((w) => spoken.has(w));
    const counted = hits.filter(
      (w) => table.table_id === context.tableId || openWords || namedAsTable.has(w) || !here.has(w),
    );
    const score = counted.length + (counted.some((w) => namedAsTable.has(w)) ? 0.5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = [table];
    } else if (score === bestScore && score > 0) {
      best.push(table);
    }
  }
  if (!best.length) return null;
  const current = best.find((t) => t.table_id === context.tableId);
  if (current) return current;
  // Two other files named equally well: moving to either would be a guess.
  return best.length === 1 ? best[0] : null;
}

/**
 * Page through the whole catalogue once, so a table can be named before it has ever
 * been spoken about.
 *
 * table_list returns five at a time on purpose — a spoken sentence naming thirty files
 * is unusable. But the client needs to *know* all of them to resolve "the countries
 * one", and with six fixtures the sixth was unreachable by name: the router had never
 * heard of it and quietly described a different table instead.
 */
async function loadCatalogue(call) {
  const seen = new Set(context.tables.map((t) => t.table_id));
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const payload = await call('table_list', cursor ? { cursor } : {});
    for (const t of payload.tables ?? []) {
      if (!seen.has(t.table_id)) {
        seen.add(t.table_id);
        context.tables.push(t);
      }
    }
    cursor = payload.cursor ?? null;
    if (!cursor) break;
  }
  context.tableId ??= context.tables[0]?.table_id ?? null;
  return context.tables;
}

// ---------------------------------------------------------------------------
// Intent routing
// ---------------------------------------------------------------------------

const AGGREGATES = [
  [/\b(total|sum|altogether|add up|how much)\b/i, 'sum'],
  [/\b(average|mean|typical)\b/i, 'avg'],
  [/\b(highest|maximum|max|biggest|largest|most|best|top|bigger|larger|greater|better|higher)\b/i, 'max'],
  [/\b(lowest|minimum|min|smallest|least|worst|fewest|smaller|lower|worse)\b/i, 'min'],
  [/\b(how many|count|number of)\b/i, 'count'],
];

const aggregateOf = (t) => AGGREGATES.find(([re]) => re.test(t))?.[1] ?? null;

/**
 * A question that continues the last one: "what about design", "and for the south".
 * Only these take the last question's measure and aggregate. Every question used to,
 * so "what is the amount for design" straight after "what's the highest amount" was
 * answered as the highest amount for Design — a different number under a sentence
 * that said so, but not the one asked for.
 */
const FOLLOW_UP = /^(and |so |ok(ay)?,? )?(what|how) about\b|^and (for |in |of )?\b|^(same|now) for\b/;
/**
 * Words that point back at the rows just answered: "how many rows is that", "and their
 * average", "how many of those". "That" alone is not one — "countries that have" is a
 * new question — and nor is a "their" after its own noun: "how many countries have
 * their population over 50 million" is about countries, not the last answer's rows.
 */
function pointsBack(t) {
  if (/\b(is|was|are|were) (that|those|these|they)\b/.test(t)) return true;
  const m = t.match(/\b(their|those|these|them|they)\b|\b(of|among|for|from|in) that\b/);
  return Boolean(m) && !contentTerms(t.slice(0, m.index)).length;
}
/** Things counted in rows: "the most deals" is how many rows, where no column is called Deal. */
const ROW_NOUNS = stems('deal deals order orders entry entries record records row rows transaction transactions line lines');
/** Things that could be counted or totalled: "the most sales". */
const EITHER_NOUNS = stems('sale sales business');

/**
 * What "the most …" or "the fewest …" counts, when it names no column: `'rows'` for a
 * deal, an order, a record; `'either'` for sales; null otherwise.
 */
function countedNoun(t, cols) {
  const m = t.match(/\b(?:most|fewest|least|more|fewer)\s+(?:number\s+of\s+)?(\p{L}+)|\bnumber\s+of\s+(\p{L}+)/u);
  if (!m) return null;
  const noun = stem(words(m[1] ?? m[2])[0] ?? '');
  if (cols.some((c) => segmentsOf(c).flat().includes(noun))) return null;
  if (ROW_NOUNS.has(noun)) return 'rows';
  if (EITHER_NOUNS.has(noun)) return 'either';
  return null;
}
/** Verbs that ask for an amount: "what did Dũng sell", "what does engineering spend". */
const QUANTITY =
  /\b(spend|spends|spent|spending|cost|costs|costing|sell|sells|sold|make|makes|made|earn|earns|earned|pay|pays|paid|owe|owes|bring in|brought in|budget|budgets|budgeted|money|get|gets|got)\b/;
/** "Rank the reps by revenue", "sort the regions": a breakdown, largest first. */
const RANK = /\b(rank|ranked|ranking|sort|sorted)\b/;
/** Figures this client cannot ask for, said as such rather than described past. */
const UNSUPPORTED = /\b(median|standard deviation|std dev|variance|percentile|quartile)\b/;
/** "How many tables", "how many files do I have". */
const HOW_MANY_TABLES = /\bhow many (tables|sheets|files|spreadsheets|workbooks)\b/;
/** A number column that counts things, so "how many widgets" is its total, not a row count. */
const COUNT_LIKE = /\b(units?|qty|quantity|quantities|pieces|items|count|stock|volume|sold)\b/i;

/**
 * "Over 100 million", "at least 5000", "under 2k": a condition on a number column.
 * Nothing understood these, so "how many countries have a population over 100 million"
 * was answered "I could not find over 100 million" at best.
 */
// The word for what is counted, when it names no column — "50 million people", "200
// dollars" — goes with the number. Left behind, "people" was asked about as a word this
// table does not have, straight after the column it measures had been named.
const COMPARISON = new RegExp(
  '\\b(more than|greater than|bigger than|larger than|higher than|over|above|exceeding|at least|no less than|' +
    'less than|fewer than|smaller than|lower than|under|below|at most|no more than)\\s+' +
    '([$£€₫]?\\s?-?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:k|thousand|m|mn|million|b|bn|billion|%|percent))?)\\b(%)?' +
    '(?:\\s+(?:people|persons|inhabitants|residents|citizens|dollars|bucks|euros|pounds|dong)\\b)?',
);
const COMPARISON_OPS = {
  'more than': 'gt', 'greater than': 'gt', 'bigger than': 'gt', 'larger than': 'gt', 'higher than': 'gt',
  over: 'gt', above: 'gt', exceeding: 'gt', 'at least': 'gte', 'no less than': 'gte',
  'less than': 'lt', 'fewer than': 'lt', 'smaller than': 'lt', 'lower than': 'lt', under: 'lt', below: 'lt',
  'at most': 'lte', 'no more than': 'lte',
};

// "Brake it down" is how a recogniser often writes it.
const BREAKDOWN = /\b((break|brake) (it |that |this |them )?down|breakdown|broken down|split (it |that )?up)\b/;
// The files, and only the files. A bare "list" also caught "list the rows" and "list
// the countries in Africa", and answered both with the catalogue.
const LIST =
  /\b(what do i have|what files|which files|what tables|list (my |the |all |all the )?(files|tables|spreadsheets|workbooks)|my (files|tables)|what.?s available)\b/;
// "How do you no" and "how do you now" are the same question misheard.
const EXPLAIN = /\b(how do (you|u) (know|no|now)|are you sure|where did that come from|which rows|show your working|prove it)\b/;
const TELL_MORE = /\b(tell me more|more about|in (full )?detail|full detail|more detail)\b/;
const CONTINUE = /\b(more|keep going|go on|continue|next)\b/;
const SAVE = /\b(save|bookmark|remember) (my |this |the )?(place|spot|position|here)\b|\bbookmark this\b/;
const RESUME = /\b(carry on|resume|pick up|where was i)\b|\bback to (my|the) (place|spot|bookmark)\b/;
const COMPARE = /\b(compare|versus|vs\.?|against|difference between)\b/;
const READ_ROWS = /\b(read|list) (me )?(the |all (the )?)?(rows|records|entries|lines)\b/;
/** "List the countries in Africa": the matching rows themselves. */
const LIST_ROWS = /^(please )?(list|name)\b|\b(list|name|show) (me )?(all )?the\b/;
const STRUCTURE =
  /\b(check|show|explain|fix|correct)( me)? (the |its |your )?(structure|headings?|headers?)\b|\bhow are you reading\b|\bhow (do|did) you read\b/;
/**
 * A yes that is only a yes. Anchored at the start alone, "right, what is the total
 * amount" confirmed a heading reading and dropped the question, and "sure, use the first
 * row as headings" confirmed the opposite of what it asked for.
 */
const YES =
  /^(yes|yeah|yep|yup|correct|right|exactly|sure|ok|okay|that.?s (right|correct)|that is (right|correct))(,? (it is|that.?s (right|correct)|that is (right|correct)|please|thanks|thank you))?[.!]?$/;
const NO = /^(no|nope|nah|not that( one)?|wrong)(,? (thanks|thank you))?[.!]?$/;
const GROUPING = /\b(by|per|which|each|every)\b/;
const CANCEL = /^(never ?mind|cancel|forget (it|that)|nothing)\b/;
/** "What can you do", "help": what can be asked, not a description of whatever table is open. */
const HELP = /^(help( me)?|what can (you|i) (do|ask|say)|what do you do|how does (this|it) work|what are my options)\b/;
/** "Start over": a new conversation, as a reload gives. */
const START_OVER = /^(start (over|again|afresh)|new conversation|begin again|reset|clear (the )?conversation)\b/;
/** "Stop" on its own is Escape, not a question. */
const STOP = /^(stop|stop (it|that|talking)|be quiet|quiet|hush|shush|silence)[.!]?$/;
/** "Table 2", "the second table": another table in the same file, as describe names them. */
const TABLE_N =
  /\btable (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\bthe (first|second|third|fourth|fifth) table\b/;
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, 'a single': 1, single: 1,
};
const countOf = (w) => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w] ?? null);

/**
 * How many rows are headings, when they say. The reading can only be corrected through
 * the structure tool, and the voice client had no way to reach it — so "check the
 * structure", the very phrase describe tells a listener to say, described the table
 * again, and the correction path existed for everyone except the person it was for.
 */
function headerRowsSaid(t) {
  const HEAD = '(the |a )?(headings?|headers?|labels?|column names?)';
  if (
    new RegExp(
      '\\b(first|top) row is (just |also )?(data|a record|a row|not (a |the )?(heading|header)s?)\\b|\\brow (one|1) is (just |also )?data\\b|' +
        '\\bno (headings?|headers?|heading rows?|header rows?)\\b|\\bevery row is data\\b|\\ball (the )?rows are data\\b|' +
        '\\b(zero|0) (heading|header) rows?\\b',
    ).test(t)
  ) {
    return 0;
  }
  const n = t.match(/\b(one|a single|1|two|2|three|3) (heading|header) rows?\b/);
  if (n) return countOf(n[1]);
  const top = t.match(new RegExp(`\\b(first|top) (two|2|three|3) rows are ${HEAD}\\b`));
  if (top) return countOf(top[2]);
  const inRows = t.match(/\b(headings?|headers?|labels?|column names?) (are|is) (in|on|across) the (first|top) (two|2|three|3) rows\b/);
  if (inRows) return countOf(inRows[5]);
  if (
    new RegExp(
      `\\b(first|top) row is ${HEAD}\\b|\\b(use|treat|take) the (first|top) row as ${HEAD}\\b|` +
        '\\b(headings?|headers?|labels?|column names?) (are|is) (in|on) the (first|top) row\\b',
    ).test(t)
  ) {
    return 1;
  }
  return null;
}

/** Wording that asks for something of its own, not the answer to a question we asked. */
const NEW_REQUEST =
  /\b(what do i have|what files|list|show me|my tables|describe|what.?s in|what is in|tell me about|read|save|bookmark|resume|carry on|where was i|more|compare|how do you know|break it down|structure|heading|headings|header|headers)\b/;

/**
 * A reply that opens like a question of its own. "I could not find money" is answered
 * with a word — "amount" — not with "what's the travel budget", which used to be folded
 * into the old question and asked for Design's travel, matching nothing.
 */
const OWN_QUESTION = /^(what|what's|whats|how|which|who|whose|when|where|is|are|does|do|did|show|list|tell|give|compare|read)\b/;

/** Does this utterance start something new, rather than answer what we just asked? */
function startsSomethingNew(t) {
  return (
    NEW_REQUEST.test(t) ||
    OWN_QUESTION.test(t) ||
    AGGREGATES.some(([re]) => re.test(t)) ||
    (findTable(t)?.table_id ?? context.tableId) !== context.tableId
  );
}

/** The tables inside the current file, as the server listed them; empty when it did not. */
function regionsOf(tableId) {
  const listed = context.regions[tableId] ?? context.tables.find((t) => t.table_id === tableId)?.regions;
  return Array.isArray(listed) ? listed : [];
}

/** Which table of the file is open: 1 unless another was asked for. */
function regionNumber() {
  if (!context.sheet) return 1;
  return regionsOf(context.tableId).find((r) => r.id === context.sheet || String(r.n) === context.sheet)?.n ?? null;
}

/** "Table 2", when this file has a table 2. */
function regionSaid(t) {
  const m = t.match(TABLE_N);
  if (!m) return null;
  const n = countOf(m[1] ?? m[2]);
  const regions = regionsOf(context.tableId);
  return regions.length > 1 ? regions.find((r) => r.n === n) ?? null : null;
}

/** Move to another table in the same file. Its columns are its own. */
function switchRegion(region) {
  context.sheet = region.n === 1 ? null : region.id;
  context.columns = region.n === 1 ? context.known[context.tableId] ?? [] : [];
  context.lastCursor = null;
  context.lastCall = null;
  context.lastQuery = null;
  context.row = null;
  context.structure = null;
}

/** Move to a table, forgetting what belonged to the last one. */
function switchTable(table) {
  context.tableId = table.table_id;
  context.sheet = null;
  context.chosen = true;
  // The previous table's column names are not merely useless here — they would match
  // against the wrong column and produce a confident answer from the wrong data,
  // which is the failure mode a listener has no way to catch.
  context.columns = context.known[table.table_id] ?? [];
  context.lastAnswerId = null;
  context.lastCursor = null;
  context.lastCall = null;
  context.lastQuery = null;
  context.row = null;
  context.structure = null;
}

/**
 * Learn the current table's columns quietly, then route the same words again.
 *
 * A question that named a table used to switch to it and then answer with no columns
 * known, so "how many countries are in Europe" went out with no filter and "8 rows
 * match" was spoken where the answer is 2. Describing first costs one call; answering
 * without it cost the answer.
 */
function prepare(said, announce) {
  return {
    tool: 'table_describe',
    args: { table_id: context.tableId, detail: 'brief' },
    then: said,
    ...(announce ? { announce } : {}),
  };
}

/**
 * No table open, and a question that needs one: find the file it can be about.
 *
 * The page opens on the first file in the list without anyone choosing it, and the old
 * answer to a question here was "Open a table first — say, what do I have", which the
 * page had already said. Saying it again changed nothing. Now the question itself picks
 * the file when only one could hold it, and otherwise we ask which, by name, and keep
 * the question until they answer.
 *
 * Files are ranked by how many of the question's words their columns and values hold,
 * every table in the file included: "the q2 revenue for south" is about the files with
 * a Q2 Revenue, not every file that says revenue, and "the target for north" is about
 * the file whose second table has Target.
 */
function chooseTable(said) {
  const have = new Set(terms(said).filter((w) => !FILLER.has(w)));
  let best = [];
  let bestScore = 0;
  for (const table of context.tables) {
    const regions = regionsOf(table.table_id);
    const options = [
      { region: null, cols: knownColumns(table.table_id) },
      ...regions.filter((r) => r.n !== 1).map((r) => ({ region: r, cols: (r.columns ?? []).map((name) => ({ name })) })),
    ];
    for (const option of options) {
      // Any content word of a column counts here: "revenue" is in a file whose columns
      // are "Q1 Revenue" and "Q2 Revenue", even though it names neither exactly. It is
      // named back by the column's own name — "Region is in …", not the "Regions" said.
      const hits = new Set();
      let what = null;
      let most = 0;
      for (const c of option.cols) {
        const matched = segmentsOf(c).flat().filter((w) => have.has(w));
        if (!matched.length) continue;
        matched.forEach((w) => hits.add(w));
        if (matched.length > most) {
          most = matched.length;
          what = nameOf(c);
        }
      }
      const found = findFilters(said, option.cols);
      for (const f of found.filters) {
        terms(f.value).forEach((w) => hits.add(w));
        what ??= f.value;
      }
      if (!what && found.unsure[0]) {
        hits.add(`?${found.unsure[0].value}`);
        what = found.unsure[0].value;
      }
      if (!hits.size || hits.size < bestScore) continue;
      if (hits.size > bestScore) best = [];
      bestScore = hits.size;
      if (!best.some((b) => b.table === table)) best.push({ table, region: option.region, what });
    }
  }

  const only = best.length === 1 ? best[0] : context.tables.length === 1 ? { table: context.tables[0], region: null } : null;
  if (only) {
    switchTable(only.table);
    if (only.region) switchRegion(only.region);
    const lead = only.region ? `In ${titleOf(only.table.table_id)}, table ${only.region.n}.` : `In ${titleOf(only.table.table_id)}.`;
    return context.columns.length ? route(said, lead) : prepare(said, lead);
  }
  if (!context.tables.length) return { speak: 'There are no tables loaded yet.' };

  const among = best.length ? best.map((b) => b.table) : context.tables;
  context.pending = { kind: 'table', said, among: among.map((t) => t.table_id) };
  const where = best.length
    ? `${best[0].what} is in ${spokenList(among.map((t) => titleOf(t.table_id)))}.`
    : `You have ${spokenList(among.map((t) => titleOf(t.table_id)))}.`;
  return { speak: `Which file? ${where}` };
}

/**
 * Words a question can carry that name nothing and ask nothing: hesitations, a wake word,
 * and the nouns people put after a value — "the design team", "the sales side". Asked
 * about, they turned "total amount for the design team" into "I could not find team".
 * Kept apart from FILLER, which also decides how well a heading matches, because a
 * column may well be called Team.
 */
const SPOKEN_NOISE = stems(
  'um umm uh uhh er erm hmm hey landmark alexa okay please team teams side sides department departments dept division ' +
    // Contractions reach here cut at the apostrophe: "haven't" is "haven" and "t".
    'haven hasn hadn isn aren wasn weren don doesn didn won wouldn couldn shouldn',
);

/**
 * Words in a question that name nothing here — no column, no value, no file — grouped
 * into the phrases they were said in, so a misheard "engine ring" is quoted whole.
 */
function unknownPhrases(said, cols) {
  const known = new Set([...FILLER, ...SPOKEN_NOISE]);
  for (const c of cols) {
    terms(String(c.name ?? c)).forEach((w) => known.add(w));
    segmentsOf(c).flat().forEach((w) => known.add(w));
    for (const v of c.categories ?? []) terms(String(v)).forEach((w) => known.add(w));
    // "Unpaid" names the Paid column's No.
    if (c.type === 'boolean') flagWords(c).forEach((w) => known.add(stem(`un${w}`)));
  }
  for (const table of context.tables) {
    terms([table.title, table.table_id, ...(table.sheets ?? [])].join(' ')).forEach((w) => known.add(w));
  }

  const raw = words(said);
  const phrases = [];
  let run = [];
  let before = null;
  raw.forEach((w, i) => {
    const skip = (w.length < 2 && !/\d/.test(w)) || known.has(stem(w));
    if (!skip) {
      if (!run.length) before = raw[i - 1] ?? null;
      run.push(w);
      return;
    }
    if (run.length) phrases.push({ text: run.join(' '), before });
    run = [];
  });
  if (run.length) phrases.push({ text: run.join(' '), before });
  return phrases;
}

/** A short plural for a column heard as a kind of thing: Department → departments. */
function pluralName(c) {
  const name = nameOf(c);
  const lower = name === name.toUpperCase() ? name : name.toLowerCase();
  if (/[^aeiou]y$/i.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

/**
 * The next step after "I could not find …": the values it was probably meant to be,
 * when it sat where a value goes ("for engineeringg") or sounds like one, and
 * otherwise the columns.
 */
function hintFor(unknown, cols) {
  const listed = cols.filter((c) => (c.categories ?? []).length > 1);
  const asValue = unknown.some((u) => ['for', 'in', 'from', 'of', 'at', 'is', 'are', 'about'].includes(u.before ?? ''));
  let best = null;
  for (const c of listed) {
    const score = Math.max(...c.categories.flatMap((v) => unknown.map((u) => similarity(u.text, String(v)))));
    if (!best || score > best.score || (score === best.score && c.categories.length < best.c.categories.length)) {
      best = { c, score };
    }
  }
  const asColumn = Math.max(0, ...cols.flatMap((c) => unknown.map((u) => similarity(u.text, nameOf(c)))));
  if (best && (asValue || best.score >= 0.6) && best.score >= asColumn) {
    const values = best.c.categories.map(String);
    // "Department" makes "departments"; "column 2" makes nothing a listener can parse.
    const name = nameOf(best.c);
    const kind = /\d$|[^\p{L}\p{N} ]/u.test(name) ? `values of ${name}` : pluralName(best.c);
    return values.length > 8
      ? `The ${kind} include ${spokenList(values.slice(0, 6))}.`
      : `The ${kind} are ${spokenList(values)}.`;
  }
  return `The columns are ${spokenList(cols.map(nameOf))}.`;
}

/** A column holding a different value on every row, like Country or Rep. */
const onePerRow = (c) => typeof c.distinct === 'number' && c.distinct > 1 && c.distinct === c.non_empty;

/** A column that is not a number, named where the number would go ("the highest closed"). */
function namedNonMeasure(t, dims) {
  const have = new Set(terms(t));
  return (
    dims
      .map((c) => ({ c, score: scoreColumn(c, have) }))
      .filter((m) => m.score >= 100)
      .sort((a, b) => b.score - a.score)[0]?.c ?? null
  );
}

/**
 * The number column named right after "how many": "how many units" is the total of
 * Units. Counted as rows, it was "2 rows match" for a table holding 165 units.
 */
function measureAfterMany(t, measures) {
  const seq = terms(t);
  const at = seq.indexOf('many');
  if (at < 0) return null;
  let j = at + 1;
  while (['the', 'of'].includes(seq[j])) j++;
  for (const c of measures) {
    for (const seg of segmentsOf(c)) {
      if (seg.every((w, k) => seq[j + k] === w)) return c;
    }
  }
  return null;
}

/** A name on every row, like Rep or Country: text, and different on every row. */
const isNameColumn = (c) => (c.type === 'text' || c.type === 'category') && onePerRow(c);

/**
 * A question about numbers, with the table's columns known: which measure, which
 * filters, and whether to break it down. `lookup` is a question with no aggregate word
 * in it — "what is the amount for engineering", "the population of Vietnam" — which
 * used to fall through to describing the table as though it had not been asked.
 */
function routeQuestion(said, t, lookup = false) {
  const cols = context.columns;
  const measures = cols.filter(isMeasure);
  const dims = cols.filter((c) => !isMeasure(c));
  // The question as said, conditions and all, for a question back to finish. Kept with
  // the conditions taken out, the reply answered without them.
  const heard = said;

  // A question that continues the last one: "what about the east", "and over 50 million".
  const continuing = FOLLOW_UP.test(t) && context.lastQuery?.table_id === context.tableId;
  // It is about the same rows unless it says otherwise: "what about the average" after
  // the total for Engineering is Engineering's average, and "how many rows is that"
  // counts those rows. Both used to drop the condition and answer for every row, under a
  // sentence that did not say so. "Break it down" is the exception: it asks for every
  // group, and the filmed demo says so.
  const sameRows =
    context.lastQuery?.table_id === context.tableId && (continuing || pointsBack(t)) && !BREAKDOWN.test(t);

  // Conditions on numbers first, so "over 100 million" is not taken for anything else.
  const cmp = comparisonsIn(said, cols);
  if (cmp.missing) {
    if (!measures.length) return { speak: `Nothing in this table is a number, so nothing can be ${cmp.missing}.` };
    // "What about over 50 million", after a question with a condition on Population, is
    // the same condition moved.
    const earlier = continuing
      ? (context.lastQuery.filters ?? []).find((f) => ['gt', 'gte', 'lt', 'lte'].includes(f.op) && measures.some((c) => c.name === f.column))
      : null;
    const column = earlier ? measures.find((c) => c.name === earlier.column) : null;
    if (column) return route(`${said} ${nameOf(column)}`);
    // The question is kept, so the reply — "population" — finishes it. Dropped, that
    // reply was routed on its own and answered with the grand total of Population.
    context.pending = { kind: 'measure', said, among: measures.map((c) => c.name) };
    return { speak: `Which column should be ${cmp.missing}? I have ${spokenList(measures.map(nameOf))}.` };
  }
  if (cmp.ask) return askDateSide(cmp);
  said = cmp.rest;
  t = String(said).toLowerCase().replace(/\s+/g, ' ').trim();

  const { filters: named, several, severalValues, unsure } = findFilters(said, cols);
  // Several values of one column are asked for together: "north and south" is those
  // two, not a breakdown of every region with the two somewhere in it — and past the
  // first page, not in it at all.
  const asked = several
    ? named.map((f) => (f.column === several.name ? { column: f.column, op: f.op, values: severalValues } : f))
    : named;
  // The last question's conditions, less any on a column this one names afresh: "what
  // about design" swaps Engineering for Design, "and over 50 million" moves the bound.
  // A record named by its name — "what about Chi" after the North's total — is that
  // record, whatever group the last question was about: kept, the North's condition
  // left Chi, a rep in the South, with no rows at all. The other way about, "what about
  // the South" after Anh's total is the South, not Anh in the South.
  const fresh = [...asked, ...cmp.filters];
  const isRecord = (f) => cols.some((c) => c.name === f.column && isNameColumn(c));
  const namesRecord = named.some((f) => f.op === 'eq' && isRecord(f));
  const carried =
    sameRows && !namesRecord
      ? (context.lastQuery.filters ?? []).filter((f) => !fresh.some((g) => g.column === f.column) && !(named.length && isRecord(f)))
      : [];
  let filters = [...carried, ...fresh];
  let agg = askedFor(t, named);
  // "What about the east" after "how many deals in the south" continues the count, and
  // "break it down" after a count breaks the count down. Only a count was never
  // remembered, so both answered the revenue question asked before it.
  if (
    !agg &&
    context.lastQuery?.aggregate === 'count' &&
    context.lastQuery.table_id === context.tableId &&
    (continuing || BREAKDOWN.test(t)) &&
    !pickColumn(t, measures.filter((c) => !cmp.filters.some((f) => f.column === c.name))).column
  ) {
    agg = 'count';
  }

  // "How many units" is the total of Units; "how many widgets", in a table that counts
  // its units, is the units of the widget rows. Both used to be a count of rows.
  let counts = null;
  if (agg === 'count') {
    counts = measureAfterMany(t, measures);
    if (!counts && named.length) {
      const seq = terms(t);
      const after = seq[seq.indexOf('many') + 1];
      const countLike = measures.filter((c) => COUNT_LIKE.test(nameOf(c)));
      if (countLike.length === 1 && named.some((f) => terms(f.value).includes(after))) counts = countLike[0];
    }
    if (counts) agg = 'sum';
  }

  let group = groupNamed(t, dims, agg === 'max' || agg === 'min');
  // Where the grouping came from: only a question that names it ("which region", "by
  // region") asks for each group's total when it says highest or lowest.
  let groupFrom = group ? 'named' : null;
  if (!group && agg === 'count') {
    // "How many departments" is two, not the five rows they sit on; "how many
    // countries", where each row is one, is the row count.
    const counted = countedNamed(t, dims);
    if (counted && repeats(counted)) [group, groupFrom] = [counted, 'counted'];
  }
  if (!group && several) [group, groupFrom] = [several, 'several'];
  // "Rank the reps by revenue", "sort the regions by population": each one's figure,
  // in order. "By revenue" names a number, not something to group by, so the group is
  // whichever other column was named.
  if (!group && RANK.test(t)) {
    group = namedNonMeasure(t, dims);
    if (group) groupFrom = 'rank';
  }
  if (!group && BREAKDOWN.test(t)) {
    groupFrom = 'breakdown';
    group = defaultGroup(cols);
    if (!group) {
      return {
        speak: 'I cannot break this table down: no column repeats its values, so there is nothing to group by. Say "read me the rows" instead.',
      };
    }
  }
  // "And by region" after the total for the North is every region, not the North alone.
  if (group) filters = filters.filter((f) => !(carried.includes(f) && f.column === group.name));
  if (!agg && !group && !lookup && !cmp.filters.length) return null;

  if (unsure.length) {
    // Neither silently a filter nor silently nothing: either guess is a confident wrong
    // number when it is the wrong guess.
    const { column, value } = unsure[0];
    context.pending = { kind: 'value', said: heard, value };
    return { speak: `Do you mean the ${nameOf(column)} ${value}? Say yes or no.` };
  }

  const unknown = unknownPhrases(said, cols);
  if (unknown.length) return couldNotFind(said, unknown);

  const base = {
    table_id: context.tableId,
    ...(filters.length ? { filters } : {}),
    ...(group ? { group_by: group.name } : {}),
  };
  const listRows = () => ({
    tool: 'table_query',
    args: { table_id: context.tableId, ...(filters.length ? { filters } : {}), aggregate: 'none' },
  });

  if (agg === 'count' || (!agg && !measures.length && !cmp.filters.length)) {
    return { tool: 'table_query', args: { ...base, aggregate: 'count' } };
  }

  const picked = pickColumn(t, measures);

  // "Which countries are in Asia", "revenue over 10000": the rows themselves. Asked of
  // a table with two number columns, the first was answered "Which column?", a
  // question about a total nobody asked for.
  if (!agg && !counts && !picked.column && !picked.tied.length) {
    if (group && group !== several && isNameColumn(group)) return listRows();
    // "What did we sell in August" is a total, where the table has one number to total.
    if (!group && cmp.filters.length && (/^(which|who|list|show|name)\b/.test(t) || !(QUANTITY.test(t) && measures.length === 1))) {
      return listRows();
    }
  }

  // "Which region has the most reps", "the fewest countries": how many of them each
  // group holds, since a rep is a name on every row and not a number to add up; and
  // "who is the top rep", the rep with the highest figure, whom the answer names.
  const things =
    !counts && !picked.column && (agg === 'max' || agg === 'min')
      ? namedNonMeasure(t, dims.filter((c) => c !== group))
      : null;
  if (things && isNameColumn(things) && !filters.some((f) => f.column === things.name)) {
    if (group) {
      return { tool: 'table_query', args: { ...base, aggregate: 'count', ...(agg === 'min' ? { order: 'asc' } : {}) } };
    }
    if (measures.length === 1) {
      return { tool: 'table_query', args: { ...base, aggregate: agg, aggregate_column: measures[0].name } };
    }
  }

  // "Which region has the most deals": how many rows each region holds, since a deal is
  // a row here and names no column. Totalled instead, it spoke each region's revenue as
  // though it were the number of deals. "The most sales" could be either, so it is asked.
  if (group && groupFrom === 'named' && !counts && !picked.column && !picked.tied.length && (agg === 'max' || agg === 'min')) {
    const noun = countedNoun(t, cols);
    const order = agg === 'min' ? { order: 'asc' } : {};
    if (noun === 'rows') return { tool: 'table_query', args: { ...base, aggregate: 'count', ...order } };
    if (noun === 'either' && measures.length) {
      context.pending = { kind: 'rows-or-measure', said: heard, count: { ...base, aggregate: 'count', ...order }, among: measures.map((c) => c.name) };
      return { speak: `By number of rows, or by ${orList(measures.map(nameOf))}?` };
    }
  }

  let measure = counts ?? picked.column;
  if (!measure && picked.tied.length) {
    context.pending = { kind: 'measure', said: heard, among: picked.tied.map((c) => c.name) };
    return { speak: `Which one: ${orList(picked.tied.map(nameOf))}?` };
  }
  // "Break it down" right after a figure breaks down that figure, whatever else it says
  // ("break down the average by region"): it has no measure of its own to name. Only
  // the follow-up phrases shared it, so after "total population" in a table with two
  // number columns, "break it down" was answered "Which column?".
  const breakdown = BREAKDOWN.test(t);
  const followUp = (FOLLOW_UP.test(t) || breakdown || sameRows) && context.lastQuery?.table_id === context.tableId;
  if (!measure && (!agg || breakdown) && followUp) {
    measure = measures.find((c) => c.name === context.lastQuery.aggregate_column) ?? null;
  }
  if (!measure) {
    // "What is the highest closed" names a column that is not a number. Answering with
    // the only number column instead answered a question nobody asked, under a sentence
    // that sounded right; the server's refusal names the columns that can be used.
    const other = namedNonMeasure(t, dims);
    if (other && other !== group && !filters.some((f) => f.column === other.name)) {
      return { tool: 'table_query', args: { ...base, aggregate: agg ?? 'sum', aggregate_column: other.name } };
    }
  }
  // One number column means one thing to total. Asking "which column?" of a table with
  // a single measure turned the demo's opening question into two turns.
  if (!measure && measures.length === 1) measure = measures[0];
  if (!measure) {
    if (!measures.length) {
      return { speak: 'Nothing in this table is a number, so there is nothing to total. I can count rows instead — ask how many.' };
    }
    context.pending = { kind: 'measure', said: heard, among: measures.map((c) => c.name) };
    return { speak: `Which column? I have ${spokenList(measures.map(nameOf))}.` };
  }

  let aggregate = agg;
  if (!aggregate) {
    // Only a question that continues the last one takes its aggregate: "what about
    // design" after an average is an average. A question of its own is a total.
    const last = followUp ? context.lastQuery.aggregate : null;
    aggregate = ['sum', 'avg', 'min', 'max'].includes(last) ? last : 'sum';
    // "The GDP per capita of Asia" is an average: a sum of rates means nothing.
    if (aggregate === 'sum' && isRate(measure)) aggregate = 'avg';
  }

  // "Which country has the lowest population": one row per country, so the lowest row
  // is the answer, and the server names it.
  if (group && agg === 'min' && group !== several && onePerRow(group)) {
    const { group_by: _, ...ungrouped } = base;
    return { tool: 'table_query', args: { ...ungrouped, aggregate: 'min', aggregate_column: measure.name } };
  }
  // "Which region has the highest revenue" asks for each region's total, largest
  // first — not the single biggest row. A rate is the exception: adding up GDP per
  // capita across countries means nothing, so its highest stays a highest.
  //
  // Only when the question itself names the group. "Break it down" after "the highest
  // revenue" asks for each region's highest, and rewritten to a total it spoke South's
  // 24.9 thousand straight after an overall highest of 21 thousand, with no word to say
  // the figures had become totals. The server names a highest or lowest per group.
  // Nor for values named together: "the highest amount for engineering and design" is
  // each one's highest, and totalled it spoke 560 thousand where the answer is 480.
  const namesGroup = groupFrom === 'named' || groupFrom === 'rank';
  if (group && namesGroup && (agg === 'max' || agg === 'min') && !isRate(measure)) aggregate = 'sum';
  // "Which department spent the least" is asked lowest first, so the answer starts
  // with it however many groups there are. Asked largest first, the least came last
  // and, past a page of groups, not at all.
  return {
    tool: 'table_query',
    args: { ...base, aggregate, aggregate_column: measure.name, ...(group && agg === 'min' ? { order: 'asc' } : {}) },
  };
}

/**
 * Map an utterance to a tool call. Order matters: the most specific intents are
 * tested first, and anything unmatched falls through to describing the table, which
 * is the useful default when someone is lost.
 *
 * A plan is one of: `{ tool, args }` to call; `{ speak }` to say without calling; or
 * `{ tool, args, then }`, a quiet preparatory call after which the same words are
 * routed again. `announce`, when present, is said before the answer: the name of a
 * table the client moved to on its own, and anything the answer's order needs said.
 */
function route(heard, announce) {
  // "Brake it down" is how a recogniser often writes the demo's own line.
  const said = digitsAsWords(String(heard).replace(/\bbrake(?= (it |that |this |them )?down\b)/gi, 'break'));
  const t = String(said).toLowerCase().trim();
  const turn = { announce: announce ?? null };
  const plan = routeInner(said, t, turn);
  let lead = turn.announce;
  // Acting on a table nobody picked: say which, since the listener cannot see it.
  if (!lead && !context.chosen && plan.tool && plan.tool !== 'table_describe' && plan.tool !== 'table_list') {
    if (plan.args?.table_id === context.tableId && context.tableId) lead = `In ${titleOf(context.tableId)}.`;
  }
  const first = joinLead(lead, plan.announce);
  if (first) plan.announce = first;
  // Every call about the open file goes to the table inside it that is open.
  if (context.sheet && plan.args?.table_id === context.tableId && SHEETED.has(plan.tool) && plan.args.sheet === undefined) {
    plan.args = { ...plan.args, sheet: context.sheet };
  }
  return plan;
}

/** Words before a number that make it a number: "top 4", "over 2", "table 2", "Q4". */
const COUNTING = new Set([
  'top', 'bottom', 'first', 'last', 'over', 'under', 'above', 'below', 'than', 'least', 'most', 'table', 'row',
  'rows', 'page', 'q', 'quarter', 'number', 'no', 'item', 'items', 'next',
]);

/**
 * A recogniser writes "for" as 4 and "to" as 2 often enough to lose a question: "total
 * amount 4 engineering" was answered "I could not find 4". A lone 4 between words is
 * "for" when a value this table holds follows it; a lone 2 is "to" in a "from … to"
 * question. After a word that counts ("top 4", "over 2", "table 2") it stays a number.
 */
function digitsAsWords(said) {
  const text = String(said);
  if (!/(^|\s)[24](\s|$)/.test(text)) return text;
  const values = new Set(context.columns.flatMap((c) => (c.categories ?? []).flatMap((v) => terms(String(v)))));
  // The word before has a letter in it ("q1" does, "2025" does not); after a "from", the
  // one after may be a year: "from 2025 q2 2 2026 q2".
  const around = /([\p{L}\p{N}]*\p{L}[\p{L}\p{N}]*)(\s+)([24])(\s+)([\p{L}\p{N}]+)/gu;
  const month = new RegExp(`^(${MONTH_WORDS})$`);
  return text.replace(around, (whole, before, s1, digit, s2, after, offset) => {
    // "From August 2 on" is a day: made "from august to on", it was August entire.
    if (COUNTING.has(words(before)[0] ?? '') || month.test(words(before)[0] ?? '')) return whole;
    const next = stem(words(after)[0] ?? '');
    if (digit === '4' && (values.has(next) || next === 'the' || next === 'each' || next === 'every')) return `${before}${s1}for${s2}${after}`;
    if (digit === '2' && /\bfrom\b/i.test(text.slice(0, offset))) return `${before}${s1}to${s2}${after}`;
    return whole;
  });
}

/** Tools that act on one table inside a file, and so need to know which. */
const SHEETED = new Set(['table_describe', 'table_structure', 'table_query', 'table_read_rows', 'table_compare', 'table_bookmark']);

/** Two lead-ins, each said once: "In 05 three regions." then "In table 2.". */
function joinLead(a, b) {
  if (!a) return b || null;
  if (!b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a} ${b}`;
}

/** "a, b or c", for a question that offers a choice. */
const orList = (items) => spokenList(items).replace(/ and ([^,]*)$/, ' or $1');

/** "Did revenue grow from 2025 Q2 to 2026 Q2": two columns, the earlier and the later. */
const FROM_TO = /\bfrom (.+?) to (.+)$/;

/**
 * Wording that asks for something other than a figure or a record. Narrower than
 * NEW_REQUEST, which also holds "tell me about" — and "tell me about Kenya" asks for
 * Kenya's row.
 */
const OWN_REQUEST =
  /\b(what do i have|what files|describe|read|save|bookmark|resume|carry on|where was i|compare|how do you know|break it down|structure|headings?|headers?)\b/;

/** Words that are neither grammar, nor a request, nor a stray letter. */
const contentTerms = (t) =>
  terms(t).filter((w) => !FILLER.has(w) && !INTENT_WORDS.has(w) && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

/**
 * Does naming this table come with a question of its own? "The population of Vietnam
 * in the countries table" asks something of the file it names, and used to be answered
 * with a description of that file.
 */
function asksOfTable(t, table) {
  const names = new Set(terms([table.title, table.table_id, ...(table.sheets ?? [])].join(' ')));
  return contentTerms(t).some((w) => !names.has(w));
}

/** Every word that names a column or a value of the columns known. */
function termsOf(cols) {
  const set = new Set();
  for (const c of cols) {
    for (const seg of segmentsOf(c)) seg.forEach((w) => set.add(w));
    for (const v of c.categories ?? []) terms(String(v)).forEach((w) => set.add(w));
  }
  return set;
}

/**
 * Another table in this file that has the column named, when this one does not.
 * "Total actual" asked of the file with three tables answered "I could not find
 * actual" — while the server's own description said table 2 has Actual.
 */
function regionNaming(t) {
  const regions = regionsOf(context.tableId);
  if (regions.length < 2 || !context.columns.length) return null;
  const here = termsOf(context.columns);
  const wanted = contentTerms(t).filter((w) => !here.has(w));
  if (!wanted.length) return null;
  const current = regionNumber();
  const hits = regions.filter(
    (r) =>
      r.n !== current &&
      (r.columns ?? []).some((name) => segmentsOf({ name }).flat().some((w) => wanted.includes(w))),
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * "How many tables are in this file", "how many files do I have". The first was
 * counted as rows, "2 rows match"; the second listed five and said "1 more".
 */
function tablesCounted(t) {
  if (/\b(in (this|the|that|it)|this (file|spreadsheet|workbook))\b|\bsheets\b/.test(t)) {
    if (!context.tableId) return null;
    const k = Math.max(1, regionsOf(context.tableId).length);
    const table = context.tables.find((x) => x.table_id === context.tableId);
    const sheets = table?.sheets?.length ?? 1;
    const next = k > 1 ? ' Say "table 2" to open the second.' : '';
    return {
      speak: `${titleOf(context.tableId)} has ${sheets === 1 ? 'one sheet' : `${sheets} sheets`}, holding ${k === 1 ? 'one table' : `${k} tables`}.${next}`,
    };
  }
  const n = context.tables.length;
  if (!n) return null;
  return { speak: `You have ${n === 1 ? 'one file' : `${n} files`}: ${spokenList(context.tables.map((x) => titleOf(x.table_id)))}.` };
}

/**
 * "What regions are there", "list the departments": the values of a column, which the
 * server has already listed. Asked as a question, this described the table; asked as a
 * listing, it read every row to get at one column.
 */
function valuesAsked(t) {
  if (!/^(what|which|list|name|tell me)\b/.test(t)) return null;
  if (
    !/\b(are there|do (we|i|you) have|exist|are listed|are in (it|this|this table|the table))\b|^(what|which) are the \w+$|^(list|name) (all )?(of )?(the )?\w+$/.test(
      t,
    )
  ) {
    return null;
  }
  const have = new Set(terms(t));
  const c = context.columns.find(
    (x) => !isMeasure(x) && (x.categories ?? []).length > 1 && segmentsOf(x).some((seg) => seg.every((w) => have.has(w))),
  );
  if (!c || findFilters(t).filters.length) return null;
  const values = c.categories.map(String);
  const name = nameOf(c);
  const kind = /\d$|[^\p{L}\p{N} ]/u.test(name) ? `values of ${name}` : pluralName(c);
  return {
    speak:
      values.length > 8
        ? `There are ${values.length} ${kind}, including ${spokenList(values.slice(0, 6))}.`
        : `The ${kind} are ${spokenList(values)}.`,
  };
}

/** Values named in the words, with several of one column asked for together. */
function valueFilters(said) {
  const found = findFilters(said);
  const filters = found.several
    ? found.filters.map((f) =>
        f.column === found.several.name ? { column: f.column, op: f.op, values: found.severalValues } : f,
      )
    : found.filters;
  return { filters, unsure: found.unsure };
}

function routeInner(said, t, turn) {
  // Answering a question we asked. "What is the total for europe" names a filter but
  // no measure, so we ask which column — and the reply is a bare noun with no verb in
  // it. Routed from scratch, that fell through to describing the table, losing both
  // the aggregate and the filter, and the question simply died.
  if (context.pending) {
    const pending = context.pending;
    context.pending = null;
    const answered = answerPending(pending, t);
    if (answered) return answered;
    // Either they changed the subject, or we still cannot tell. Drop it rather than
    // trapping them in a question they have no way out of.
  }

  if (CANCEL.test(t)) return { speak: 'All right.' };
  // Said as Escape: nothing to answer, and nothing said over whatever comes next.
  if (STOP.test(t)) return { speak: '', interrupt: true };
  if (HELP.test(t)) {
    return {
      speak:
        'Ask for a total, an average, the highest or lowest, a count, or a breakdown — like "total amount for engineering". ' +
        'Say "how do you know" to hear the cells behind a number, "what do I have" to hear your files, and "start over" to begin again.',
    };
  }
  if (START_OVER.test(t)) {
    // What the server listed stays known; what this conversation built up goes.
    const tables = context.tables;
    resetContext();
    context.tables = tables;
    context.tableId = tables[0]?.table_id ?? null;
    return { speak: 'Starting over. Say "what do I have" to hear your files, or ask about one of them.' };
  }
  if (HOW_MANY_TABLES.test(t)) {
    const counted = tablesCounted(t);
    if (counted) return counted;
  }
  if (LIST.test(t)) return { tool: 'table_list', args: {} };
  if (!context.tableId) return { speak: 'There are no tables loaded yet. Say "what do I have" in a moment.' };

  // "African" is Africa, "Vietnamese" Vietnam, when the table lists them.
  if (context.columns.length) {
    const folded = foldDemonyms(said, context.columns);
    if (folded !== said) {
      said = folded;
      t = String(folded).toLowerCase().trim();
    }
  }

  const headerRows = headerRowsSaid(t);
  const structural = STRUCTURE.test(t) || headerRows !== null;
  // A condition on a number or a month: "over 100 million", "closed in August".
  const comparing = COMPARISON.test(t) || Boolean(monthIn(t, context.columns));
  const asking =
    Boolean(aggregateOf(t)) || BREAKDOWN.test(t) || GROUPING.test(t) || COMPARE.test(t) || FROM_TO.test(t) || RANK.test(t);
  const question = asking || comparing;
  const reading = READ_ROWS.test(t);
  // "Name the rep with the highest revenue" is a question; "list the countries in
  // Africa" is a listing, and so is "list the deals from September".
  const listing = !reading && !asking && LIST_ROWS.test(t) && !/\b(columns?|headings?|headers?|structure)\b/.test(t);
  // Naming a table, and asking nothing else of it, is a request to know what is in it.
  const onlyNaming = !structural && !question && !reading && !listing && !SAVE.test(t);
  const describe = (sheet) => ({
    tool: 'table_describe',
    args: { table_id: context.tableId, ...(sheet ? { sheet } : {}), detail: TELL_MORE.test(t) ? 'full' : 'brief' },
  });

  const named = findTable(t);
  if (named && named.table_id !== context.tableId) {
    switchTable(named);
    const region = regionSaid(t);
    if (region && region.n !== 1) switchRegion(region);
    if (onlyNaming) {
      // "The population of Vietnam in the countries table" asks something of the file
      // it names: learn its columns, then answer.
      if (asksOfTable(t, named)) return prepare(said, `In ${titleOf(named.table_id)}.`);
      return describe(context.sheet);
    }
    turn.announce ??= `In ${titleOf(named.table_id)}.`;
  } else if (named) {
    context.chosen = true;
  }

  // "Table 2": the server's own words for another table in this file. Nothing routed
  // them, so saying them described table 1 again, which said "table 2" again.
  const region = regionSaid(t);
  if (region && region.n !== regionNumber()) {
    switchRegion(region);
    if (onlyNaming) {
      // "What is the target for the North in table 2" asks something of table 2: learn
      // its columns, then answer, rather than describe it and drop the question.
      if (contentTerms(t.replace(new RegExp(TABLE_N.source, 'g'), ' ')).length) return prepare(said, `In table ${region.n}.`);
      return describe(context.sheet);
    }
    turn.announce ??= `In table ${region.n}.`;
  }
  if (region) {
    // Said, and acted on: "table 2" is not a value to look for in the question.
    said = String(said).replace(new RegExp(TABLE_N.source, 'gi'), ' ');
    t = t.replace(new RegExp(TABLE_N.source, 'g'), ' ').trim();
  } else if (!structural && !SAVE.test(t) && !RESUME.test(t)) {
    // A column this table does not have, which another table in the file does.
    const other = regionNaming(t);
    if (other) {
      switchRegion(other);
      turn.announce ??= `In table ${other.n}.`;
      if (!context.columns.length) return prepare(said, turn.announce);
    }
  }

  if (EXPLAIN.test(t)) {
    if (!context.lastAnswerId) {
      return context.workingLost
        ? { speak: 'I could not keep the working for that answer, so I cannot show where it came from. Ask it again and I will try to keep it.' }
        : { speak: 'Ask me something with a number in it first, then I can show you where it came from.' };
    }
    return { tool: 'table_explain', args: { answer_id: context.lastAnswerId } };
  }

  // Before "more", which it contains: "tell me more about it" is a request for the
  // full description, and used to be answered "that was all of it".
  if (TELL_MORE.test(t)) {
    return { tool: 'table_describe', args: { table_id: context.tableId, detail: 'full' } };
  }

  // "More", "keep going" and "next" on their own ask to read on. "Which rep has more
  // revenue", "a population more than 100 million" and "is engineering spending more
  // than design" are questions; the last used to be answered "that was all of it".
  const onlyContinuing = !contentTerms(t.replace(new RegExp(CONTINUE.source, 'g'), ' ')).length;
  if (CONTINUE.test(t) && onlyContinuing && !aggregateOf(t) && !comparing) {
    if (context.lastCall && context.lastCursor) {
      // The cursor supersedes whatever position the previous call started from.
      // Sending both meant the server saw the old start_row and replayed it, so
      // "keep going" read the same five rows forever.
      const args = { ...context.lastCall.args, cursor: context.lastCursor };
      delete args.start_row;
      return { tool: context.lastCall.tool, args };
    }
    if (context.lastCall) {
      return { speak: 'That was all of it — nothing more to read.' };
    }
  }

  if (SAVE.test(t)) {
    // Saving row 1 regardless of how far they had read defeated the whole feature: the
    // one thing whose purpose is not losing your place lost your place.
    return {
      tool: 'table_bookmark',
      args: {
        name: context.bookmarkName ?? 'my place',
        table_id: context.tableId,
        row: context.row ?? 1,
      },
    };
  }
  if (RESUME.test(t)) {
    // Always by name. With no name the server lists what is saved instead of going
    // anywhere, and after a reload this page has forgotten which name it used — so
    // "carry on" listed bookmarks forever. The page only ever saves under 'my place'.
    return { tool: 'table_resume', args: { name: context.bookmarkName ?? 'my place' } };
  }

  if (context.structure && headerRows === null && YES.test(t)) {
    return {
      tool: 'table_structure',
      args: { table_id: context.structure.table_id, header_rows: context.structure.header_rows },
    };
  }
  if (headerRows !== null) {
    return { tool: 'table_structure', args: { table_id: context.tableId, header_rows: headerRows } };
  }
  if (STRUCTURE.test(t)) {
    return { tool: 'table_structure', args: { table_id: context.tableId } };
  }

  // Said as not possible, rather than answered with a description of the table.
  const unsupported = t.match(UNSUPPORTED);
  if (unsupported) {
    return {
      speak: `I cannot work out a ${unsupported[1]}. I can give a total, an average, the highest, the lowest, or a count.`,
    };
  }

  if ((question || listing) && !context.chosen) return chooseTable(said);
  // A question with no question word in it — "the q2 revenue for south" — asked before
  // any table was picked. It described the first file, which could not answer it.
  if (!context.chosen && !reading && !structural && contentTerms(t).length) return chooseTable(said);
  if ((question || listing) && !context.columns.length) return prepare(said, turn.announce);
  // The same with a table open whose columns are not known yet (after a correction).
  if (!context.columns.length && !reading && contentTerms(t).length) return prepare(said, turn.announce);

  // "Did revenue grow from 2025 Q2 to 2026 Q2": the later against the earlier.
  const fromTo = groupNamed(t, context.columns.filter((c) => !isMeasure(c)), true) ? null : t.match(FROM_TO);
  if (fromTo) {
    const measures = context.columns.filter(isMeasure);
    const from = findColumn(fromTo[1], measures);
    const to = findColumn(fromTo[2], measures);
    if (from && to && from !== to) return comparePlan(said, to, from);
  }

  if (COMPARE.test(t)) {
    const measures = context.columns.filter(isMeasure);
    const pool = measures.length >= 2 ? measures : context.columns;
    const parts = t.split(/\b(?:and|versus|vs\.?|against|with)\b/).map((s) => s.trim()).filter(Boolean);
    const left = parts.map((p) => findColumn(p, pool)).find(Boolean);
    const right = parts.slice().reverse().map((p) => findColumn(p, pool)).find((c) => c && c !== left);
    if (left && right) return comparePlan(said, left, right);
    // Two columns this table does not have, which another file does. "Compare 2026 Q1
    // revenue and 2025 Q1 revenue" with the sales table open described the sales table,
    // because its one Revenue column could not be both sides of the comparison.
    const elsewhere = context.tables.filter((x) => {
      if (x.table_id === context.tableId) return false;
      const cols = knownColumns(x.table_id);
      const l = parts.map((p) => findColumn(p, cols)).find(Boolean);
      return Boolean(l && parts.slice().reverse().map((p) => findColumn(p, cols)).find((c) => c && c !== l));
    });
    if (elsewhere.length === 1) {
      switchTable(elsewhere[0]);
      const lead = `In ${titleOf(elsewhere[0].table_id)}.`;
      return context.columns.length ? route(said, lead) : prepare(said, lead);
    }
    if (elsewhere.length > 1) {
      context.pending = { kind: 'table', said, among: elsewhere.map((x) => x.table_id) };
      return { speak: `Which file? Both of those are in ${spokenList(elsewhere.map((x) => titleOf(x.table_id)))}.` };
    }
  }

  if (reading) {
    return { tool: 'table_read_rows', args: { table_id: context.tableId, start_row: 1 } };
  }

  const values = valuesAsked(t);
  if (values) return values;

  if (listing) {
    // "List the countries in Africa": the matching rows, not the whole table.
    const cmp = comparisonsIn(said, context.columns);
    if (cmp.missing) return { speak: `Which column should be ${cmp.missing}?` };
    if (cmp.ask) return askDateSide(cmp);
    const { filters } = valueFilters(cmp.rest);
    const unknown = unknownPhrases(cmp.rest.replace(/\b(list|name)\b/gi, ' '), context.columns);
    if (unknown.length) return couldNotFind(said, unknown);
    const all = [...filters, ...cmp.filters];
    return all.length
      ? { tool: 'table_query', args: { table_id: context.tableId, filters: all, aggregate: 'none' } }
      : { tool: 'table_read_rows', args: { table_id: context.tableId, start_row: 1 } };
  }

  if (question) {
    const plan = routeQuestion(said, t);
    if (plan) return plan;
  }
  if (context.columns.length && !OWN_REQUEST.test(t) && !YES.test(t) && !NO.test(t)) {
    const measures = context.columns.filter(isMeasure);
    const dims = context.columns.filter((c) => !isMeasure(c));
    const { filters, unsure } = valueFilters(said);
    const picked = pickColumn(t, measures);
    const followUp = FOLLOW_UP.test(t) && context.lastQuery?.table_id === context.tableId;
    const valued = filters.length > 0 || unsure.length > 0;
    // "What is the amount for engineering", "the population of Vietnam", "what did Dũng
    // sell", and "what about design" straight after a total: a number and a value, with
    // no aggregate word. These described the table, as though nothing had been asked.
    if (valued && (picked.column || picked.tied.length || followUp || (QUANTITY.test(t) && measures.length === 1))) {
      const plan = routeQuestion(said, t, true);
      if (plan) return plan;
    }
    // "What is the 2025 Q2 revenue", or just "2026 Q1 revenue": a number column, named
    // with nothing else asked of it.
    const bare =
      picked.column && contentTerms(t).every((w) => segmentsOf(picked.column).flat().includes(w));
    if (!valued && picked.column && (/^(what|how much)\b/.test(t) || bare)) {
      const plan = routeQuestion(said, t, true);
      if (plan) return plan;
    }
    // "What region is Peru in", "when did Chi close", "tell me about Kenya": a record,
    // named. Its row holds the answer, so it is read whole.
    if (filters.length && !unsure.length) {
      return { tool: 'table_query', args: { table_id: context.tableId, filters, aggregate: 'none' } };
    }
    // "What's the status": a column that is not a number, named alone. Read it.
    const dim = !valued && !picked.column && /^(what|which)\b/.test(t) ? namedNonMeasure(t, dims) : null;
    // Only when every word is accounted for: "what's the richest country" read out the
    // Country column as though it were the answer.
    const unknown = dim ? unknownPhrases(said, context.columns) : [];
    if (dim && unknown.length) return couldNotFind(said, unknown);
    if (dim) {
      return { tool: 'table_read_rows', args: { table_id: context.tableId, columns: [dim.name], start_row: 1 } };
    }
  }

  // Nothing else fitted, so the table is described. Named first when nobody chose it,
  // or a listener hears "This table has 5 rows" with no idea which table.
  return {
    tool: 'table_describe',
    args: { table_id: context.tableId, detail: /\b(full|detail)\b/.test(t) ? 'full' : 'brief' },
    ...(!context.chosen ? { announce: `In ${titleOf(context.tableId)}.` } : {}),
  };
}

/** Words a comparison is asked with, which name nothing in the table. */
const COMPARING_WORDS = stems(
  'grow grows grew grown growth change changed changes rise rises rose risen fall falls fell fallen drop drops ' +
    'dropped increase increased decrease decreased perform performed improve improved shrink shrank climb ' +
    'climbed jump jumped move moved stack stacks up',
);

/**
 * A comparison of two columns, under the conditions the question names.
 *
 * "Compare Q1 and Q3 revenue for the north" was answered for every region, in a sentence
 * that never said so — the North heard correctly, then dropped. The conditions now go
 * with the comparison, and the server says them at its head ("For North, …"). A word
 * that names nothing is asked about, as it is for any other question, rather than
 * compared past.
 */
function comparePlan(said, left, right) {
  const cmp = comparisonsIn(said, context.columns);
  if (cmp.missing) return { speak: `Which column should be ${cmp.missing}?` };
  if (cmp.ask) return askDateSide(cmp);
  const { filters, unsure } = valueFilters(cmp.rest);
  if (unsure.length) {
    const { column, value } = unsure[0];
    context.pending = { kind: 'value', said, value };
    return { speak: `Do you mean the ${nameOf(column)} ${value}? Say yes or no.` };
  }
  const unknown = unknownPhrases(cmp.rest, context.columns).filter(
    (u) => !u.text.split(' ').every((w) => COMPARING_WORDS.has(stem(w))),
  );
  if (unknown.length) return couldNotFind(said, unknown);
  const all = [...filters, ...cmp.filters];
  return {
    tool: 'table_compare',
    args: { table_id: context.tableId, left_column: left.name, right_column: right.name, ...(all.length ? { filters: all } : {}) },
  };
}

/** "I could not find …", keeping the question so naming the right thing finishes it. */
function couldNotFind(said, unknown) {
  context.pending = { kind: 'replace', said, unknown: unknown.map((u) => u.text) };
  const quoted = spokenList(unknown.slice(0, 2).map((u) => `"${u.text}"`)).replace(/ and "/, ' or "');
  return { speak: `I could not find ${quoted} in this table. ${hintFor(unknown, context.columns)}` };
}

/** Finish a question we asked, if this reply answers it. */
function answerPending(pending, t) {
  if (pending.kind === 'value') {
    // "Do you mean the Rep An?" Yes puts the name where a name goes; no drops the word.
    if (YES.test(t)) return route(`${pending.said} for ${pending.value}`);
    if (NO.test(t)) {
      const drop = new Set(words(pending.value));
      return route(words(pending.said).filter((w) => !drop.has(w)).join(' '));
    }
    return null;
  }
  if (pending.kind === 'table') {
    // Only one of the files offered finishes the question, and only when the reply asks
    // nothing of its own: "what's in the budget file" is a new request that happens to
    // name a file, and used to be answered as the old question asked of the budget.
    const named = findTable(t);
    if (!named || !(pending.among ?? []).includes(named.table_id)) return null;
    // The file's own name is not a request: "the stacked header one" names a file whose
    // title says "header", and was taken for a request about headings.
    const title = new Set(terms([named.title, named.table_id, ...(named.sheets ?? [])].join(' ')));
    const rest = words(t).filter((w) => !title.has(stem(w))).join(' ');
    if (NEW_REQUEST.test(rest) || aggregateOf(rest) || BREAKDOWN.test(rest)) return null;
    switchTable(named);
    return context.columns.length ? route(pending.said, `In ${titleOf(named.table_id)}.`) : prepare(pending.said, `In ${titleOf(named.table_id)}.`);
  }
  if (pending.kind === 'rows-or-measure') {
    // "By number of rows, or by Revenue?" Before the new-question test, which "number of
    // rows" would pass as a count of its own. Only a short reply naming nothing else:
    // "how many deals are in the north" is a question of its own.
    if (t.split(/\s+/).length > 5 || findFilters(t).filters.length) return null;
    if (/\b(number|count|rows?|how many|many)\b/.test(t) && !findColumn(t, context.columns.filter(isMeasure))) {
      return { tool: 'table_query', args: pending.count };
    }
    const picked = findColumn(t, context.columns.filter((c) => pending.among.includes(c.name)));
    return picked ? route(`${pending.said} ${nameOf(picked)}`) : null;
  }
  if (startsSomethingNew(t)) return null;
  if (pending.kind === 'date') {
    // "Do you mean on August 27 only, up to it, or from it on?" The side is put into the
    // question where the day was said, and the question asked again. Only a short reply
    // that names nothing else: "revenue by region" is a new question, not "by".
    const names = pickColumn(t, context.columns);
    if (t.split(/\s+/).length > 5 || findFilters(t).filters.length || names.column || names.tied.length) return null;
    const side = /\b(up to|until|till|by|before|or earlier|through|no later)\b/.test(t)
      ? `up to ${pending.value}`
      : /\b(from|onwards?|after|since|or later|starting)\b/.test(t)
        ? `from ${pending.value} on`
        : /\b(on|only|just|exactly|that day)\b/.test(t)
          ? `on ${pending.value}`
          : null;
    if (!side) return null;
    const at = pending.said.toLowerCase().indexOf(pending.phrase.toLowerCase());
    if (at < 0) return null;
    return route(`${pending.said.slice(0, at)}${side}${pending.said.slice(at + pending.phrase.length)}`);
  }
  if (pending.kind === 'measure') {
    // A reply that is a question of its own is asked as one. "Q1 revenue by region" and
    // "south 2026 q1 revenue", said after "Which one?", were folded into the old
    // question as a bare column name — the breakdown and the South were dropped, and
    // the old question was answered as though they had been asked.
    const dims = context.columns.filter((c) => !isMeasure(c));
    if (groupNamed(t, dims, false) || BREAKDOWN.test(t) || COMPARISON.test(t) || findFilters(t).filters.length) return null;
    const pool = context.columns.filter((c) => pending.among.includes(c.name));
    const picked = pickColumn(t, pool);
    // Route the question again with the column's full name in it, so everything the
    // question already held — its filter, its grouping — comes along.
    if (picked.column) return route(`${pending.said} ${nameOf(picked.column)}`);
    // "2026" narrows four revenue columns to two. Dropping the question there left
    // someone narrowing it step by step with nothing to narrow.
    if (picked.tied.length >= 2 && picked.tied.length < pool.length) {
      context.pending = { ...pending, among: picked.tied.map((c) => c.name) };
      return { speak: `Which one: ${orList(picked.tied.map(nameOf))}?` };
    }
    return null;
  }
  if (pending.kind === 'replace') {
    // Only a reply that names something here finishes the question. Anything else
    // would be folded in, found wanting, and asked about again — a loop with no exit.
    const found = findFilters(t);
    if (!found.filters.length && !found.unsure.length && !findColumn(t)) return null;
    const unknown = new Set(pending.unknown.flatMap((u) => u.split(' ')));
    const kept = words(pending.said).filter((w) => !unknown.has(w));
    return route(`${kept.join(' ')} ${words(t).join(' ')}`);
  }
  return null;
}

/** Remember what the answer gives us, so follow-ups work without repeating context. */
function absorb(tool, args, payload) {
  // A refusal changes nothing we know. Recording it as the last call made "more"
  // after an error say there was nothing more to read.
  if (!payload || payload.isError) return;

  // Saving a place is an aside, not a new reading. Recording it as the last call
  // replaced the rows cursor with nothing, so "more" straight after "save my place"
  // said there was nothing left to read while rows remained.
  if (tool === 'table_bookmark') {
    if (payload.name) context.bookmarkName = payload.name;
    return;
  }

  context.structure = null;
  context.lastCall = { tool, args };
  context.lastCursor = payload.cursor ?? null;
  if (tool === 'table_query' || tool === 'table_compare') {
    // An answer given without its working must not be explained with an older answer's.
    context.lastAnswerId = payload.answer_id ?? null;
    context.workingLost = !payload.answer_id;
  } else if (payload.answer_id) {
    context.lastAnswerId = payload.answer_id;
  }

  if (tool === 'table_list') {
    if (payload.tables?.length) {
      // Accumulate across pages rather than replacing, so "the countries one" still
      // resolves after the user has paged past it.
      const seen = new Set(context.tables.map((x) => x.table_id));
      context.tables.push(...payload.tables.filter((x) => !seen.has(x.table_id)));
      context.tableId ??= payload.tables[0].table_id;
    }
    return;
  }

  if (payload.table_id) {
    if (payload.table_id !== context.tableId) {
      // Arriving somewhere else — a resumed bookmark, most often — makes the columns
      // we knew belong to another table.
      context.tableId = payload.table_id;
      context.sheet = null;
      context.columns = [];
      context.lastQuery = null;
      context.row = null;
    }
    context.chosen = true;
  }
  if (tool === 'table_describe' && Array.isArray(payload.columns)) {
    const first = !args.sheet || payload.table_number === 1;
    context.columns = payload.columns;
    context.sheet = first ? null : args.sheet;
    if (first && payload.table_id) context.known[payload.table_id] = payload.columns;
    if (Array.isArray(payload.regions) && payload.table_id) context.regions[payload.table_id] = payload.regions;
  }
  if (tool === 'table_structure') {
    if (args.header_rows === undefined) {
      context.structure = { table_id: payload.table_id, header_rows: payload.header_rows };
    } else {
      // The correction renamed the columns (these come back as bare names); learn
      // them again before the next question rather than match against the old ones.
      context.columns = [];
      delete context.known[payload.table_id];
    }
  }
  // A count is remembered too, so "what about the east" after "how many deals in the
  // south" continues the count rather than the revenue question asked before it.
  if (tool === 'table_query' && (args.aggregate_column || args.aggregate === 'count')) {
    context.lastQuery = { ...args };
  }
  // Where they are now, so "save my place" saves this rather than the top of the table.
  if (typeof payload.start_row === 'number') context.row = payload.start_row;
  if (typeof payload.row === 'number') context.row = payload.row;
  if ((tool === 'table_bookmark' || tool === 'table_resume') && payload.name) {
    context.bookmarkName = payload.name;
  }
  if (tool === 'table_resume' && typeof payload.row === 'number' && payload.table_id) {
    // Coming back is the start of reading on, so "more" reads from the saved row
    // rather than saying there is nothing left. A region id, when the server sends
    // one, names the table inside the sheet; the sheet name alone means its first.
    const sheet = payload.region_id ?? payload.sheet;
    context.lastCall = {
      tool: 'table_read_rows',
      args: { table_id: payload.table_id, ...(sheet ? { sheet } : {}) },
    };
    context.lastCursor = String(payload.row);
  }
}

/**
 * One turn, start to finish: route the words, make any quiet preparatory call, then
 * the call that answers. The page and the tests both drive this, so the conversation
 * under test is the one a listener has.
 *
 * `call(name, args)` returns the tool's structured payload with `isError` set.
 */
async function converse(said, call) {
  const calls = [];
  const run = async (plan) => {
    const payload = await call(plan.tool, plan.args);
    calls.push(plan.tool);
    absorb(plan.tool, plan.args, payload);
    return payload;
  };
  const withAnnounce = (announce, text) => (announce ? `${announce} ${text}` : text);

  let plan = route(said);
  let announce = plan.announce ?? '';
  for (let step = 0; plan.then !== undefined; step++) {
    const prep = await run(plan);
    if (prep.isError) {
      return { plan, payload: prep, calls, spoken: withAnnounce(announce, prep.spoken ?? 'I could not open that table.') };
    }
    if (step >= 2) {
      plan = { speak: 'I could not read the columns of that table. Try describing it first.' };
      break;
    }
    plan = route(plan.then);
    announce = joinLead(announce, plan.announce) ?? '';
  }
  if (plan.speak !== undefined) return { plan, payload: null, calls, spoken: withAnnounce(announce, plan.speak) };

  const payload = await run(plan);
  return {
    plan,
    payload,
    calls,
    spoken: withAnnounce(announce, payload.spoken ?? 'I could not put that into words.'),
  };
}

export {
  McpClient,
  Voice,
  readEventStream,
  route,
  absorb,
  converse,
  loadCatalogue,
  context,
  resetContext,
  browserSession,
  SESSION_KEY,
};
