/**
 * Conversation state and answers, kept in Durable Object storage.
 *
 * Isolate memory is not state on Workers: Cloudflare routes consecutive requests to
 * whichever instance it likes and evicts instances when it needs the room, so an
 * answer, a correction or a bookmark held in a Map could be gone — or never have been
 * there — by the next request. "How do you know" then found no working, and a spoken
 * correction to how a table is read applied on one isolate and not the next, so
 * answers flipped between two readings of the same file without a word said.
 *
 * Workers KV was the documented fix and is the wrong one here: it is eventually
 * consistent (a read straight after a write can miss, and misses are cached for about
 * a minute), and the free plan allows a thousand writes a day, which is a thousand
 * questions. SQLite-backed Durable Objects are strongly consistent, run one request at
 * a time, and are on the free plan.
 *
 * There are two kinds of object. Each conversation has one holding its bookmarks and
 * structure corrections (SessionState). Each answer has one of its own (AnswerState),
 * named by the answer's unguessable id, so that it can be read back from any
 * conversation: a host that reconnects for every turn gets a new conversation every
 * turn, and "how do you know" still has to find what was said in the last one.
 *
 * These classes are the logic only, written against the few storage calls they need,
 * so they run under Node with a Map standing in for storage. The Durable Objects that
 * own real storage are thin shells around them (durable.ts), and nothing here keeps
 * state of its own that matters: an object that is evicted and recreated picks up
 * exactly where the last one stopped.
 */

import {
  MAX_BOOKMARKS,
  type Bookmark,
  type Store,
  type StoredAnswer,
  type StructureOverride,
} from '../mcp/store.ts';

/** The subset of Durable Object storage used here. Values are structured-cloned, not JSON. */
export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** The alarm calls on Durable Object storage. */
export interface AlarmLike {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** What a conversation's object answers to: every Store call except the answers. */
export type ConversationStore = Omit<Store, 'putAnswer' | 'getAnswer'>;

/** What an answer's object answers to. */
export interface AnswerHolder {
  keep(id: string, answer: StoredAnswer): Promise<void>;
  read(id: string): Promise<StoredAnswer | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a conversation's state is kept with no use at all.
 *
 * The key-value store this replaced let answers expire after an hour and corrections
 * after a day, which bounded storage for free. Here a single alarm is pushed back by
 * every call; when it finally fires, nobody has saved, resumed, listed or corrected
 * anything in this conversation for three months, and the whole object is cleared.
 * That is long enough for "pick this up next week" and still stops abandoned
 * conversations — every MCP client that connects starts one — from filling the free
 * plan's storage forever.
 */
export const IDLE_MS = 90 * DAY_MS;

/**
 * How long an answer's working is kept after it was given.
 *
 * Long enough to ask "how do you know" in a conversation picked up days later; short
 * enough that storage stays bounded however many questions arrive, since every answer
 * is its own object and nothing else would ever clear it.
 */
export const ANSWER_TTL_MS = 7 * DAY_MS;

/**
 * Keeps a conversation's clearing alarm IDLE_MS after its latest use.
 *
 * Every call counts as use, reads included. It used to be pushed only by writes, so
 * somebody who saved a place once and then said "carry on" every week lost it ninety
 * days after the save, while still using it — and a bookmark that quietly vanishes is
 * worse than none.
 *
 * Moving the alarm is a row written, and the free plan counts rows written, so it
 * moves at most once a day: a day's slack on a three-month limit. The alarm time is
 * remembered in memory after the first look, so most calls cost no storage at all.
 */
export class IdleExpiry {
  readonly #storage: AlarmLike;
  readonly #now: () => number;
  /** The alarm as last read or set; undefined until the first look. */
  #due: number | null | undefined;

  constructor(storage: AlarmLike, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  /**
   * Best effort, and never a reason for the call it follows to fail. Moving the alarm
   * is a write, and a read that failed because a write could not be made — the free
   * plan's daily rows-written quota, which any anonymous caller can use up, or a
   * transient storage error — left every conversation unable to describe a table. The
   * alarm is tried again on the next use.
   */
  async touch(): Promise<void> {
    try {
      const due = this.#now() + IDLE_MS;
      if (this.#due === undefined) this.#due = await this.#storage.getAlarm();
      if (this.#due !== null && this.#due >= due - DAY_MS) return;
      await this.#storage.setAlarm(due);
      this.#due = due;
    } catch (e) {
      console.error('landmark: could not move the idle alarm; trying again on the next use', e);
    }
  }

  /** The alarm fired and the state is gone: the next use has to set a new one. */
  fired(): void {
    this.#due = null;
  }
}

// Key layout. Each kind has its own prefix, so no name a caller sends can reach a
// record of another kind.
const ANSWER = 'answer';
const BOOKMARK = 'bm:';
const STRUCTURE = 'st:';

interface AnswerRecord {
  readonly id: string;
  readonly answer: StoredAnswer;
}

/**
 * One answer, in an object of its own.
 *
 * Two rows written per answer, the answer and the alarm that clears it, and nothing to
 * list or trim: the free plan counts rows. The id is stored alongside and checked on
 * the way out, so an object reached by any other name gives nothing back.
 */
export class AnswerState implements AnswerHolder {
  readonly #storage: StorageLike & AlarmLike;
  readonly #now: () => number;

  constructor(storage: StorageLike & AlarmLike, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  async keep(id: string, answer: StoredAnswer): Promise<void> {
    const record: AnswerRecord = { id, answer };
    await this.#storage.put<AnswerRecord>({ [ANSWER]: record });
    await this.#storage.setAlarm(this.#now() + ANSWER_TTL_MS);
  }

  async read(id: string): Promise<StoredAnswer | null> {
    const record = await this.#storage.get<AnswerRecord>(ANSWER);
    return record && record.id === id ? record.answer : null;
  }
}

/** One conversation's bookmarks and structure corrections. */
export class SessionState implements ConversationStore {
  readonly #storage: StorageLike;

  constructor(storage: StorageLike) {
    this.#storage = storage;
  }

  async putBookmark(name: string, mark: Bookmark): Promise<void> {
    const key = BOOKMARK + name.trim().toLowerCase();
    if ((await this.#storage.get(key)) === undefined) {
      // A new name: make room first, letting go of the oldest save.
      const all = await this.listBookmarks();
      const surplus = all.length + 1 - MAX_BOOKMARKS;
      if (surplus > 0) {
        await this.#storage.delete(all.slice(0, surplus).map((b) => BOOKMARK + b.name));
      }
    }
    await this.#storage.put({ [key]: mark });
  }

  async getBookmark(name: string): Promise<Bookmark | null> {
    return (await this.#storage.get<Bookmark>(BOOKMARK + name.trim().toLowerCase())) ?? null;
  }

  /**
   * Oldest save first, so the most recent is last — the order MemoryStore gives.
   * Storage lists by key, which is alphabetical, so the order is restored from the
   * timestamps.
   */
  async listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]> {
    const rows = await this.#storage.list<Bookmark>({ prefix: BOOKMARK });
    return [...rows.entries()]
      .map(([key, mark]) => ({ name: key.slice(BOOKMARK.length), mark }))
      .sort((a, b) => a.mark.savedAt.localeCompare(b.mark.savedAt) || a.name.localeCompare(b.name));
  }

  async getStructure(regionKey: string): Promise<StructureOverride | null> {
    return (await this.#storage.get<StructureOverride>(STRUCTURE + regionKey)) ?? null;
  }

  /**
   * Read, then write. On KV this pair raced and the read could be a cached miss; inside
   * a Durable Object requests run one at a time and reads see the last write, so the
   * revision cannot go backwards or be issued twice.
   */
  async putStructure(regionKey: string, headerRows: number): Promise<StructureOverride> {
    const previous = await this.getStructure(regionKey);
    const next: StructureOverride = { headerRows, revision: (previous?.revision ?? 1) + 1 };
    await this.#storage.put({ [STRUCTURE + regionKey]: next });
    return next;
  }
}
