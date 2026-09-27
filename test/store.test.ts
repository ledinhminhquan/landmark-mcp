/**
 * State, in both of its homes.
 *
 * The Durable Objects that hold state on the deployed Worker cannot run under Node, so
 * their logic lives in SessionState, AnswerState and IdleExpiry and is exercised here
 * against a fake storage that behaves like the real one where it matters: values are
 * structured-cloned on the way in and out (so nothing can rely on getting the same
 * object back), and listing is in key order, not insertion order.
 *
 * The Store that used to back the Worker had no tests at all, which is how answers
 * sharing a key prefix with structure corrections went unnoticed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readSpreadsheet } from '../src/ingest/read.ts';
import { buildIndex, buildTable } from '../src/ingest/build.ts';
import { createHandler } from '../src/server.ts';
import { AnswerBook, MAX_BOOKMARKS, MemoryStore, type Bookmark, type StoredAnswer } from '../src/mcp/store.ts';
import {
  ANSWER_TTL_MS,
  AnswerState,
  IDLE_MS,
  IdleExpiry,
  SessionState,
  type AlarmLike,
  type StorageLike,
} from '../src/state/session-state.ts';
import { DurableStore, type Namespace, type StateNamespaces } from '../src/state/durable-store.ts';

/** Durable Object storage, as far as the state classes can tell. */
class FakeStorage implements StorageLike, AlarmLike {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  writes = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async put<T>(entries: Record<string, T>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) {
      this.data.set(k, structuredClone(v));
      this.writes++;
    }
  }

  async delete(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    this.writes += n;
    return n;
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
    this.writes++;
  }
}

/** A Durable Object namespace: one storage per name, a fresh object per stub. */
class FakeNamespace<Stub> implements Namespace<Stub> {
  readonly storages = new Map<string, FakeStorage>();
  stubs = 0;
  readonly #make: (storage: FakeStorage) => Stub;

  constructor(make: (storage: FakeStorage) => Stub) {
    this.#make = make;
  }

  idFromName(name: string): string {
    return name;
  }

  get(id: unknown): Stub {
    this.stubs++;
    const name = String(id);
    let s = this.storages.get(name);
    if (!s) this.storages.set(name, (s = new FakeStorage()));
    // A new object each time, as an evicted and recreated one would be: anything it
    // kept in memory instead of storage would be lost here.
    return this.#make(s);
  }
}

function namespaces() {
  const conversations = new FakeNamespace((s) => new SessionState(s));
  const answers = new FakeNamespace((s) => new AnswerState(s));
  const ns: StateNamespaces = { conversations, answers };
  return { conversations, answers, ns };
}

function answer(label: string): StoredAnswer {
  return {
    parts: [{ label, tableId: 't', regionId: 'r', sheet: 's', cells: ['A1'], cellCount: 1, excluded: [], path: [label] }],
    spec: { label },
    structureRevision: 1,
  };
}

function mark(savedAt: string, rowIndex = 0): Bookmark {
  return { tableId: 't', regionId: 'r', rowIndex, note: null, savedAt };
}

// ── answers ─────────────────────────────────────────────────────────────────

test('an answer comes back by the id it was given, and nothing else reads it', async () => {
  const { answers, ns } = namespaces();
  const store = new DurableStore(ns, 'alice');
  const id = await store.putAnswer(answer('first'));
  // 64 random bits: the id is all that stands between a caller and the working.
  assert.match(id, /^a\d+-[0-9a-f]{16}$/);
  assert.deepEqual(await store.getAnswer(id), answer('first'));

  await store.putStructure('01-flat/sales.t1', 0);
  await store.putBookmark('my place', mark('2026-09-01T00:00:00.000Z'));
  // The key-value store this replaced answered "st:<region>" with a correction, and
  // explain then failed with a raw TypeError. Only ids mintId could have made are
  // looked up at all — anything else never gets as far as naming an object.
  const stubs = answers.stubs;
  for (const probe of ['st:01-flat/sales.t1', 'bm:my place', 'seq', '', 'a1', 'a1-ZZZZZZZZZZZZZZZZ', id + 'x', `a1-00000000`]) {
    assert.equal(await store.getAnswer(probe), null, probe);
  }
  assert.equal(answers.stubs, stubs, 'a malformed id created a Durable Object stub');

  // A well-formed id that was never issued names an empty object, and reads nothing.
  const forged = id.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.equal(await store.getAnswer(forged), null);
});

test('an answer is reachable from any conversation that holds its id', async () => {
  // A host that reconnects for every turn is a new conversation every turn. The id in
  // the last turn's result is what it asks "how do you know" with, from the new one.
  const { answers, conversations, ns } = namespaces();
  const id = await new DurableStore(ns, 'turn-1').putAnswer(answer('said'));
  assert.deepEqual(await new DurableStore(ns, 'turn-2').getAnswer(id), answer('said'));
  assert.deepEqual([...answers.storages.keys()], [id], 'one object per answer, named by its id');
  assert.equal(conversations.storages.size, 0, 'answers are not kept in any conversation');
});

test('an answer is kept for a week and costs two rows', async () => {
  const storage = new FakeStorage();
  const at = Date.UTC(2026, 8, 1);
  const state = new AnswerState(storage, () => at);
  await state.keep('a1-0123456789abcdef', answer('x'));
  assert.equal(storage.alarm, at + ANSWER_TTL_MS);
  // The free plan counts rows written: the answer, and the alarm that clears it.
  assert.equal(storage.writes, 2);
  assert.deepEqual(await new AnswerState(storage).read('a1-0123456789abcdef'), answer('x'), 'survives a recreated object');
  assert.equal(await state.read('a1-fedcba9876543210'), null, 'reached by another name, it gives nothing back');
});

test('in memory, one book serves every conversation and lets the oldest go', async () => {
  const book = new AnswerBook(3);
  const alice = new MemoryStore({ answers: book });
  const bob = new MemoryStore({ answers: book });
  const first = await alice.putAnswer(answer('first'));
  assert.deepEqual(await bob.getAnswer(first), answer('first'));
  for (const label of ['b', 'c', 'd']) await bob.putAnswer(answer(label));
  assert.equal(await alice.getAnswer(first), null, 'the oldest answer should have gone');

  // Without a shared book a store keeps its own, as before.
  const own = new MemoryStore();
  assert.equal(await own.getAnswer(first), null);
});

// ── bookmarks ───────────────────────────────────────────────────────────────

test('bookmarks match names loosely and list oldest save first, in both stores', async () => {
  for (const store of [new MemoryStore(), new SessionState(new FakeStorage())]) {
    const kind = store.constructor.name;
    await store.putBookmark('zebra', mark('2026-09-01T00:00:00.000Z', 1));
    await store.putBookmark('  Apple ', mark('2026-09-02T00:00:00.000Z', 2));
    await store.putBookmark('mango', mark('2026-09-03T00:00:00.000Z', 3));
    assert.equal((await store.getBookmark('APPLE'))?.rowIndex, 2, kind);

    // Saving an existing name again moves it to the end: it is now the latest.
    await store.putBookmark('zebra', mark('2026-09-04T00:00:00.000Z', 9));
    assert.deepEqual(
      (await store.listBookmarks()).map((b) => b.name),
      ['apple', 'mango', 'zebra'],
      kind,
    );
    assert.equal((await store.getBookmark('zebra'))?.rowIndex, 9, kind);
  }
});

test('a conversation keeps at most a hundred bookmarks, letting the oldest save go', async () => {
  for (const store of [new MemoryStore(), new SessionState(new FakeStorage())]) {
    const kind = store.constructor.name;
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    for (let i = 0; i < MAX_BOOKMARKS; i++) await store.putBookmark(`b${i}`, mark(at(i)));
    // Re-saving an existing name at the cap makes no room and loses nothing.
    await store.putBookmark('b0', mark(at(500)));
    assert.equal((await store.listBookmarks()).length, MAX_BOOKMARKS, kind);
    assert.ok(await store.getBookmark('b1'), kind);

    await store.putBookmark('new', mark(at(501)));
    const names = (await store.listBookmarks()).map((b) => b.name);
    assert.equal(names.length, MAX_BOOKMARKS, kind);
    assert.ok(!names.includes('b1'), `${kind}: the oldest save should have gone`);
    assert.ok(names.includes('b0') && names.includes('new'), kind);
  }
});

test('state outlives the object holding it: a recreated object carries on', async () => {
  const storage = new FakeStorage();
  const first = new SessionState(storage);
  await first.putBookmark('Budget Review', mark('2026-09-01T00:00:00.000Z', 4));
  await first.putStructure('t/r', 2);

  const second = new SessionState(storage);
  assert.equal((await second.getBookmark('budget review'))?.rowIndex, 4);
  assert.deepEqual(await second.getStructure('t/r'), { headerRows: 2, revision: 2 });
});

// ── how long a conversation is kept ─────────────────────────────────────────

test('a conversation in use is never cleared, reads included, at one row a day', async () => {
  // The defect: only writes pushed the clearing alarm back, so somebody who saved once
  // and then said "carry on" every week lost the bookmark ninety days after the save.
  const storage = new FakeStorage();
  let now = Date.UTC(2026, 0, 1);
  const expiry = new IdleExpiry(storage, () => now);

  await expiry.touch();
  assert.equal(storage.alarm, now + IDLE_MS, 'the first use sets the alarm');
  assert.equal(storage.writes, 1);

  // Used again the same day: nothing written.
  now += 60 * 60 * 1000;
  for (let i = 0; i < 20; i++) await expiry.touch();
  assert.equal(storage.writes, 1, 'the alarm moved more than once a day');

  // Resumed once a week for a year, never saving: the alarm stays ahead of every use.
  for (let week = 0; week < 52; week++) {
    now += 7 * 24 * 60 * 60 * 1000;
    assert.ok((storage.alarm ?? 0) > now, `cleared while still in use, in week ${week}`);
    await expiry.touch();
    assert.ok((storage.alarm ?? 0) >= now + IDLE_MS - 24 * 60 * 60 * 1000);
  }
  assert.equal(storage.writes, 53, 'one row a week of use, not one per call');

  // A recreated object reads the alarm once rather than writing it again.
  const again = new IdleExpiry(storage, () => now);
  await again.touch();
  assert.equal(storage.writes, 53);

  // Once it has fired, the next use sets a new one.
  again.fired();
  storage.alarm = null;
  await again.touch();
  assert.equal(storage.alarm, now + IDLE_MS);
});

// ── structure corrections ───────────────────────────────────────────────────

test('each correction gets the next revision, per region', async () => {
  const state = new SessionState(new FakeStorage());
  assert.equal(await state.getStructure('t/r'), null);
  assert.deepEqual(await state.putStructure('t/r', 0), { headerRows: 0, revision: 2 });
  assert.deepEqual(await state.putStructure('t/r', 1), { headerRows: 1, revision: 3 });
  assert.deepEqual(await state.putStructure('t/other', 2), { headerRows: 2, revision: 2 });
  assert.deepEqual(await state.getStructure('t/r'), { headerRows: 1, revision: 3 });
});

// ── through the handler, as the Worker wires it ─────────────────────────────

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const index = buildIndex([buildTable(await readSpreadsheet(join(FIX, '01-flat.xlsx')))]);

async function tool(
  handler: (r: Request) => Promise<Response>,
  session: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; content: Record<string, unknown> }> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  return { isError: body.result.isError === true, content: body.result.structuredContent };
}

test('with durable state, a second isolate sees the first one\'s work, and conversations stay apart', async () => {
  // Two handlers are two isolates: on Workers, consecutive requests can land on either.
  // With state in isolate memory, explain and corrections broke between them.
  const { conversations, answers, ns } = namespaces();
  const isolate = () =>
    createHandler({ index, makeStore: (key) => new DurableStore(ns, key), durableState: true });
  const one = isolate();
  const two = isolate();

  const q = await tool(one, 'alice', 'table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
  const id = String(q.content['answer_id']);
  const e = await tool(two, 'alice', 'table_explain', { answer_id: id });
  assert.equal(e.isError, false, 'the working written on one isolate was missing on the other');
  assert.deepEqual(e.content['cells'], ['C2', 'C3', 'C4', 'C5', 'C6']);

  await tool(one, 'alice', 'table_structure', { table_id: '01-flat', header_rows: 0 });
  const onTwo = await tool(two, 'alice', 'table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
  assert.equal(onTwo.isError, true, 'the correction made on one isolate was ignored on the other');

  const bob = await tool(two, 'bob', 'table_query', { table_id: '01-flat', aggregate: 'sum', aggregate_column: 'Revenue' });
  assert.equal(bob.content['result'], 61050, "alice's correction reached bob");
  // The working is found by its id, which only alice's result carried; one that
  // merely looks like it finds nothing.
  const forged = id.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.equal((await tool(two, 'bob', 'table_explain', { answer_id: forged })).isError, true);

  await tool(one, 'alice', 'table_bookmark', { name: 'my place', table_id: '01-flat', row: 3, note: 'hers' });
  assert.match(String((await tool(two, 'alice', 'table_resume', { name: 'my place' })).content['spoken']), /hers/);
  assert.equal((await tool(two, 'bob', 'table_resume', { name: 'my place' })).isError, true);

  assert.deepEqual([...conversations.storages.keys()].sort(), ['alice', 'bob'], 'one object per conversation');
  assert.ok(answers.storages.has(id), 'and one per answer, named by its id');
  assert.ok(conversations.stubs + answers.stubs >= 8, 'a stub per call, never one cached for the life of an isolate');
});

// ── when the storage behind a conversation fails ────────────────────────────

test('a read never fails because the idle alarm could not be moved', async () => {
  // The free plan's daily rows-written quota, used up, makes every write throw. Each
  // read moves the alarm, so every read threw too, and no table could be described.
  const storage = new FakeStorage();
  let refuse = true;
  storage.setAlarm = async (at: number) => {
    if (refuse) throw new Error('Exceeded allowed rows written in Durable Objects free tier.');
    storage.alarm = at;
  };
  const state = new SessionState(storage);
  const expiry = new IdleExpiry(storage, () => Date.UTC(2026, 0, 1));
  const read = async () => {
    const value = await state.getStructure('t/r');
    await expiry.touch();
    return value;
  };
  assert.equal(await read(), null, 'the read answers');
  assert.equal(storage.alarm, null);
  refuse = false;
  await expiry.touch();
  assert.equal(storage.alarm, Date.UTC(2026, 0, 1) + IDLE_MS, 'and the alarm is set on the next use that can write');
});

test('an answer whose working cannot be kept is still given', async () => {
  class Full extends MemoryStore {
    override async putAnswer(): Promise<string> {
      throw new Error('Exceeded allowed rows written in Durable Objects free tier.');
    }
  }
  const both = buildIndex(
    await Promise.all(['03-merged-header.xlsx', '04-title-and-vmerge.xlsx'].map(async (f) => buildTable(await readSpreadsheet(join(FIX, f))))),
  );
  const h = createHandler({ index: both, makeStore: () => new Full(), durableState: true });
  const q = await tool(h, 'full', 'table_query', {
    table_id: '04-title-and-vmerge',
    filters: [{ column: 'Department', op: 'eq', value: 'Engineering' }],
    aggregate: 'sum',
    aggregate_column: 'Amount',
  });
  assert.equal(q.isError, false, 'was "Something went wrong on my side"');
  assert.equal(q.content['spoken'], '560 thousand. That is the total of Amount across 3 rows.');
  assert.equal(q.content['answer_id'], undefined);
  assert.equal(q.content['working_kept'], false);
  const c = await tool(h, 'full', 'table_compare', { table_id: '03-merged-header', left_column: '2026 Q1 Revenue', right_column: '2025 Q1 Revenue' });
  assert.equal(c.isError, false);
});
