/**
 * The browser client's session identity, over the wire.
 *
 * The server keeps answers, bookmarks and heading corrections per caller. The voice
 * client used to send no session at all, so every visitor shared one namespace: one
 * judge's "save my place" overwrote another's, and a heading correction changed what
 * everyone heard. The conversation tests could not catch it, because their harness
 * sent a session header the real client never did. These drive the real McpClient.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createHandler } from '../src/server.ts';
import { assertIndex } from '../src/indexfmt.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(parsed);
const handler = createHandler({ index: parsed });

type Headers = Record<string, string>;

/** A browser's storage: a plain map, or one that refuses like a private window. */
function storage(refuse = false) {
  const map = new Map<string, string>();
  return {
    map,
    getItem(k: string) {
      if (refuse) throw new Error('SecurityError');
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (refuse) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
  };
}

interface Sent {
  headers: Headers;
  body: { method?: string };
  response: Response;
}

/** Route the client's fetches to the real handler, recording what went out. */
function wire(sent: Sent[], issue?: string): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    let response = await handler(new Request(String(url), init));
    if (body.method === 'notifications/initialized') {
      // An empty body that is still a stream, as a browser sees it, so reading it can be checked.
      response = new Response('', { status: response.status, headers: response.headers });
    } else if (body.method === 'initialize' && issue) {
      const h = new Headers(response.headers);
      h.set('mcp-session-id', issue);
      response = new Response(await response.text(), { status: response.status, headers: h });
    }
    sent.push({ headers, body, response });
    return response;
  }) as typeof fetch;
}

/** A fresh copy of the client module: a new page, with nothing held in memory. */
async function page(): Promise<{ McpClient: new () => { connect(): Promise<unknown>; call(n: string, a: object): Promise<Record<string, unknown>> } }> {
  // @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
  return (await import(`../web/app.js?page=${Math.random()}`)) as never;
}

const g = globalThis as unknown as { fetch: typeof fetch; localStorage?: unknown };
const realFetch = g.fetch;

test('every request carries one per-browser session id, and a reload keeps it', async (t) => {
  t.after(() => {
    g.fetch = realFetch;
    delete g.localStorage;
  });
  const store = storage();
  g.localStorage = store;
  const sent: Sent[] = [];
  g.fetch = wire(sent);

  const { McpClient } = await page();
  const client = new McpClient();
  await client.connect();
  await client.call('table_list', {});

  const ids = sent.map((s) => s.headers['x-landmark-session']);
  assert.equal(sent.length, 4, 'initialize, initialized, tools/list, tools/call');
  assert.ok(ids[0], 'the session header was not sent');
  assert.ok(ids.every((id) => id === ids[0]), `the id changed between requests: ${ids.join(', ')}`);
  assert.equal(store.map.get('landmark-session'), ids[0], 'the id must be kept, so a reload finds it');

  // A reload: a new page and a new client, the same browser storage.
  const again = await page();
  const reloaded = new again.McpClient();
  await reloaded.call('table_list', {});
  assert.equal(sent.at(-1)?.headers['x-landmark-session'], ids[0]);
});

test('with storage refused, the page still has an id of its own', async (t) => {
  t.after(() => {
    g.fetch = realFetch;
    delete g.localStorage;
  });
  g.localStorage = storage(true);
  const sent: Sent[] = [];
  g.fetch = wire(sent);

  const { McpClient } = await page();
  const client = new McpClient();
  await client.connect();
  const ids = sent.map((s) => s.headers['x-landmark-session']);
  assert.ok(ids[0] && ids[0] !== 'shared-demo');
  assert.ok(ids.every((id) => id === ids[0]));
});

test('two browsers do not see each other\'s saved place', async (t) => {
  t.after(() => {
    g.fetch = realFetch;
    delete g.localStorage;
  });
  const sent: Sent[] = [];
  g.fetch = wire(sent);

  g.localStorage = storage();
  const a = new (await page()).McpClient();
  await a.call('table_bookmark', { name: 'my place', table_id: '06-countries', row: 6, note: 'judge one' });

  g.localStorage = storage();
  const b = new (await page()).McpClient();
  const theirs = await b.call('table_resume', { name: 'my place' });
  assert.equal(theirs['isError'], true, `browser B resumed browser A's place: ${String(theirs['spoken'])}`);

  const mine = await a.call('table_resume', { name: 'my place' });
  assert.match(String(mine['spoken']), /row 6/);
});

test('the handshake notification is read to the end, and an issued session id is echoed', async (t) => {
  t.after(() => {
    g.fetch = realFetch;
    delete g.localStorage;
  });
  g.localStorage = storage();
  const sent: Sent[] = [];
  g.fetch = wire(sent, 'issued-by-server');

  const { McpClient } = await page();
  await new McpClient().connect();

  const note = sent.find((s) => s.body.method === 'notifications/initialized');
  assert.ok(note, 'the initialized notification was not sent');
  assert.equal(note.response.bodyUsed, true, 'an unread body shows as a failed request in Chromium');
  assert.ok(note.headers['x-landmark-session'], 'the notification went out without the session');

  // The transport spec: echo what the server issued. The per-browser id still goes too,
  // and the server reads that one first, so bookmarks outlive this page.
  const later = sent.filter((s) => s.body.method !== 'initialize');
  assert.ok(later.every((s) => s.headers['mcp-session-id'] === 'issued-by-server'));
  assert.ok(later.every((s) => s.headers['x-landmark-session'] === sent[0]?.headers['x-landmark-session']));
});
