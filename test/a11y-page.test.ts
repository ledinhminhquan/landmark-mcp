/**
 * The voice page's accessibility, checked without a browser.
 *
 * Everything else in the client is tested through web/app.js, but the page's own
 * script, markup and styles in web/index.html had no test at all, and each of these
 * was found by hand in a review rather than by the suite: a focus ring drawn off
 * screen, a page that scrolled sideways at 320px, screen-reader advice nobody tabbing
 * would meet, a wait that was silent, a ring reading "Ready" with the server down,
 * and a text box whose edge was 2:1. Layout and focus were checked in a browser when
 * they were fixed; these keep the causes from coming back.
 *
 * The page's functions are lifted out of its script and run against stand-ins, so
 * what is tested is the code the browser runs rather than a copy of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = await readFile(join(ROOT, 'web', 'index.html'), 'utf8');

const between = (open: RegExp, close: string): string => {
  const m = open.exec(PAGE);
  assert.ok(m, `the page has ${open}`);
  const start = m.index + m[0].length;
  return PAGE.slice(start, PAGE.indexOf(close, start));
};
const CSS = between(/<style>/, '</style>').replace(/\/\*[\s\S]*?\*\//g, '');
const SCRIPT = between(/<script type="module">/, '</script>');
const MARKUP = PAGE.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');

// ── markup ────────────────────────────────────────────────────────────────

const ids = new Set([...MARKUP.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test('every label, description and name points at an element that exists', () => {
  const refs = [...MARKUP.matchAll(/\s(?:aria-describedby|aria-labelledby|for)="([^"]+)"/g)].flatMap((m) =>
    (m[1] ?? '').split(/\s+/),
  );
  assert.ok(refs.length >= 3);
  for (const ref of refs) assert.ok(ids.has(ref), `#${ref} exists`);
  // The script looks elements up by id too; a renamed one fails silently in a browser.
  for (const [, id] of SCRIPT.matchAll(/\bel\('([^']+)'\)/g)) assert.ok(ids.has(id ?? ''), `#${id} exists`);
});

test('the Speak answers switch carries the screen-reader advice, where Tab reaches it', () => {
  const box = /<input[^>]*id="speak-answers"[^>]*>/.exec(MARKUP)?.[0] ?? '';
  const described = /aria-describedby="([^"]+)"/.exec(box)?.[1];
  assert.ok(described, 'the checkbox has a description');
  const text = new RegExp(`id="${described}"[^>]*>([\\s\\S]*?)</span>`).exec(MARKUP)?.[1]?.replace(/<[^>]+>/g, '') ?? '';
  assert.match(text, /screen reader/i);
});

test('the hint never tells someone on a focused control to press Space', () => {
  // Space toggles a focused checkbox, so a bare "or Space" told someone who had just
  // unticked Speak answers to press the key that ticks it again.
  const hint = /<p class="hint"[\s\S]*?<\/p>/.exec(MARKUP)?.[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') ?? '';
  const sentences = hint.split(/(?<=\.)\s/).filter((s) => /\bSpace\b/.test(s));
  assert.ok(sentences.length > 0);
  for (const s of sentences) assert.match(s, /focus/, `qualified: "${s}"`);
});

// ── styles ────────────────────────────────────────────────────────────────

/** Every declaration of a property, in source order, for rules whose selector includes `selector`. */
function declared(selector: string, property: string): string[] {
  const out: string[] = [];
  for (const [, selectors, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!(selectors ?? '').split(',').some((s) => s.trim() === selector)) continue;
    for (const [, value] of (body ?? '').matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))) {
      out.push((value ?? '').trim());
    }
  }
  return out;
}

test('the conversation log draws its focus ring inside its own edge', () => {
  // Full width and taller than the window on a phone or a zoomed laptop, so a ring
  // drawn outside the log landed entirely off screen.
  const offset = declared('.log:focus-visible', 'outline-offset').at(-1) ?? '';
  assert.match(offset, /^-\d/, `outline-offset ${offset}`);
  assert.ok(declared('.log:focus-visible', 'outline').length > 0);
});

test('no grid track refuses to shrink, so 320px does not scroll sideways', () => {
  // A bare 1fr track is at least as wide as its content: the 260px ring plus padding.
  const tracks = [...CSS.matchAll(/grid-template-columns\s*:\s*([^;}]+)/g)].map((m) => m[1] ?? '');
  assert.ok(tracks.length >= 2);
  for (const t of tracks) assert.doesNotMatch(t.replace(/minmax\([^)]*\)/g, ''), /fr\b/, t);
});

const vars = Object.fromEntries([...CSS.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const colour = (value: string): string => {
  const hex = /#[0-9a-f]{6}/i.exec(value)?.[0] ?? vars[/var\((--[\w-]+)\)/.exec(value)?.[1] ?? ''];
  assert.ok(hex, `a colour in "${value}"`);
  return hex;
};
/** WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test('the text box and outlined buttons have an edge that can be seen (3:1)', () => {
  const box = colour(declared('.ask input', 'border').at(-1) ?? '');
  const fill = colour(declared('.ask input', 'background').at(-1) ?? '');
  assert.ok(contrast(box, colour('var(--panel)')) >= 3, `text box edge on the panel: ${contrast(box, colour('var(--panel)')).toFixed(2)}`);
  assert.ok(contrast(box, fill) >= 3, `text box edge on its fill: ${contrast(box, fill).toFixed(2)}`);
  const ghost = colour(declared('button.ghost', 'border').at(-1) ?? '');
  for (const bg of ['var(--bg)', 'var(--panel)']) assert.ok(contrast(ghost, colour(bg)) >= 3, `outlined button on ${bg}`);
});

// ── the page's script ─────────────────────────────────────────────────────

/** The source of one of the page's functions (one whose parameters hold no braces). */
function source(name: string): string {
  const start = SCRIPT.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is in the page script`);
  let depth = 0;
  for (let i = SCRIPT.indexOf('{', start); i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') depth++;
    else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error(`${name} never closes`);
}

/**
 * Run one of the page's functions with `env` standing in for the page around it. A
 * sloppy-mode `with` makes its free variables (turnSeq, owed, setState…) read and
 * write `env`, so a test can change them while the function runs.
 */
function lift<F>(name: string, env: Record<string, unknown>): F {
  return new Function('env', `with (env) { return (${source(name)}); }`)(env) as F;
}

/** The value of one of the page's top-level constants, evaluated from its own source. */
function constant(name: string): unknown {
  const start = SCRIPT.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} is in the page script`);
  const expr = SCRIPT.slice(start + `const ${name} = `.length, SCRIPT.indexOf(';\n', start));
  return new Function(`return (${expr});`)();
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('without speech recognition, the advice matches the Speak answers switch', () => {
  const say = (canSpeak: boolean, speakAnswers: boolean) =>
    lift<() => string>('cannotListen', { voice: { canSpeak }, speakAnswers })();
  assert.match(say(true, true), /still spoken/);
  // Firefox with a screen reader, switch off: the page must not promise its own voice.
  assert.doesNotMatch(say(true, false), /spoken/);
  assert.match(say(true, false), /screen reader/);
  assert.doesNotMatch(say(false, true), /spoken/);
});

/** A takeTurn wired to stand-ins, recording what it showed, said and announced. */
function turnRig(over: Record<string, unknown> = {}) {
  const states: string[] = [];
  const announced: string[] = [];
  const responded: Array<{ text: string; urgent: boolean }> = [];
  const env: Record<string, unknown> = {
    SLOW_MS: 30,
    turnSeq: 1,
    speakAnswers: false,
    voice: { canSpeak: true },
    context: {},
    client: { lastLatencyMs: 5 },
    addTurn() {},
    interrupt() {},
    setState: (s: string) => states.push(s),
    announce: (t: string) => announced.push(t),
    respond: async (text: string, opts?: { urgent?: boolean }) => {
      responded.push({ text, urgent: Boolean(opts?.urgent) });
    },
    callTool: async () => ({}),
    connected: async () => {},
    converse: async () => ({ calls: ['table_query'], spoken: '560 thousand.', payload: {} }),
    ...over,
  };
  const takeTurn = lift<(said: string, turn: number) => Promise<void>>('takeTurn', env);
  return { env, states, announced, responded, takeTurn };
}

test('a slow answer is announced as in hand to a screen-reader user, then answered', async () => {
  const rig = turnRig({ connected: () => pause(90) });
  await rig.takeTurn('total amount for design', 1);
  assert.deepEqual(rig.announced, ['Working on it.']);
  assert.deepEqual(rig.responded.map((r) => r.text), ['560 thousand.']);
});

test('a quick answer, or a spoken one, has no "working" notice before it', async () => {
  const quick = turnRig();
  await quick.takeTurn('total amount for design', 1);
  await pause(60);
  assert.deepEqual(quick.announced, []);
  assert.deepEqual(quick.responded.map((r) => r.text), ['560 thousand.']);

  // Speaking aloud: the page's own voice would be cut off by the answer anyway.
  const aloud = turnRig({ speakAnswers: true, connected: () => pause(90) });
  await aloud.takeTurn('total amount for design', 1);
  assert.deepEqual(aloud.announced, []);
  assert.deepEqual(aloud.responded.map((r) => r.text), ['560 thousand.']);

  // Superseded while waiting: the newer turn speaks for itself.
  const rig = turnRig({ connected: () => pause(90) });
  const pending = rig.takeTurn('total amount for design', 1);
  rig.env['turnSeq'] = 2;
  await pending;
  assert.deepEqual(rig.announced, []);
});

test('a question the server cannot be reached for leaves the ring on Offline, not Ready', async () => {
  const rig = turnRig({ connected: async () => { throw new Error('Failed to fetch'); } });
  await rig.takeTurn('total amount for design', 1);
  assert.equal(rig.responded.length, 1);
  assert.equal(rig.responded[0]?.urgent, true);
  assert.equal(rig.states.at(-1), 'offline');

  // Unless something newer has started meanwhile: its state is not ours to change.
  const later = turnRig({
    connected: async () => { throw new Error('Failed to fetch'); },
    respond: async () => { later.env['turnSeq'] = 2; },
  });
  await later.takeTurn('total amount for design', 1);
  assert.notEqual(later.states.at(-1), 'offline');
});

test('a failed question is never followed by "working on it", even with speech turned off mid-error', async () => {
  // Spoken aloud, the error takes seconds, and turning Speak answers off while it plays
  // is what a screen-reader user hearing a second voice is told to do. The wait notice
  // must already be cancelled by then: the question has failed, not gone quiet.
  const rig = turnRig({
    speakAnswers: true,
    connected: async () => { throw new Error('Failed to fetch'); },
    respond: async () => {
      rig.env['speakAnswers'] = false;
      await pause(90);
    },
  });
  await rig.takeTurn('total amount for design', 1);
  await pause(60);
  assert.deepEqual(rig.announced, []);
  assert.equal(rig.states.at(-1), 'offline');
});

test('a newer announcement replaces one still waiting to be written', async () => {
  const written: string[] = [];
  const region = {
    set textContent(t: string) {
      if (t) written.push(t);
    },
  };
  const announce = lift<(text: string) => void>('announce', { el: () => region, pendingWrite: new Map() });
  announce('Working on it.');
  await pause(10);
  announce('560 thousand.');
  await pause(120);
  assert.deepEqual(written, ['560 thousand.']);
});

/** firstGesture wired to stand-ins, recording what it said and how many listeners it removed. */
function gestureRig(userActivation?: { hasBeenActive: boolean }) {
  class Element {
    closest(): null {
      return null;
    }
  }
  const said: string[] = [];
  const rig = {
    said,
    removed: 0,
    env: {
      owed: 'You have 01 flat, 02 stacked header.',
      NOT_A_REQUEST: constant('NOT_A_REQUEST'),
      Element,
      navigator: { userActivation },
      document: { removeEventListener: () => rig.removed++ },
      wakeAudio() {},
      voice: { prime() {} },
      aside: (t: string) => said.push(t),
    } as Record<string, unknown>,
    press: (key: string, more: Record<string, unknown> = {}) =>
      firstGesture({ type: 'keydown', key, code: key, target: new Element(), ...more }),
    click: () => firstGesture({ type: 'click', target: new Element() }),
  };
  const firstGesture = lift<(e: unknown) => void>('firstGesture', rig.env);
  return rig;
}

test('moving focus, scrolling or quieting the reader does not set the page talking over it', () => {
  // Real keys, as a browser sends them: Shift+Tab is a Shift keydown first, and Control
  // is how an NVDA or JAWS user silences their reader. One Tab has already unlocked
  // speech by then, so any of these, taken as the first gesture, talked over the reader.
  const rig = gestureRig({ hasBeenActive: true });
  rig.press('Tab');
  rig.press('Shift', { shiftKey: true });
  rig.press('Tab', { shiftKey: true });
  rig.press('Control', { ctrlKey: true });
  for (const key of ['Alt', 'Meta', 'CapsLock', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown']) rig.press(key);
  assert.deepEqual(rig.said, []);
  assert.equal(rig.removed, 0, 'still waiting for a real gesture');
  assert.equal(rig.env['owed'], 'You have 01 flat, 02 stacked header.', 'the answer is still owed');

  // A click on the page, as in the filmed demo, still says it.
  rig.click();
  assert.deepEqual(rig.said, ['You have 01 flat, 02 stacked header.']);
  assert.equal(rig.removed, 2);

  // So does a key that does something, where the browser has no activation API to ask.
  const enter = gestureRig();
  enter.press('Enter');
  assert.deepEqual(enter.said, ['You have 01 flat, 02 stacked header.']);
});

test('a key the browser did not count as a gesture leaves the owed answer for one it does', () => {
  // Chromium refuses speech until the page has been activated. Taken as the gesture,
  // such a key removed the listeners, speaking was refused and the answer owed again,
  // and nothing was left to say it. Which key does not matter: the browser's own
  // record of activation is what decides, and here it says none has happened.
  const rig = gestureRig({ hasBeenActive: false });
  rig.press('Enter');
  assert.deepEqual(rig.said, []);
  assert.equal(rig.removed, 0);
  assert.equal(rig.env['owed'], 'You have 01 flat, 02 stacked header.');
  (rig.env['navigator'] as { userActivation: { hasBeenActive: boolean } }).userActivation.hasBeenActive = true;
  rig.click();
  assert.deepEqual(rig.said, ['You have 01 flat, 02 stacked header.']);
  assert.equal(rig.removed, 2);
});
