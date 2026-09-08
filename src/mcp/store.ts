/**
 * Session state.
 *
 * Two things need to outlive a single tool call.
 *
 * ANSWERS. When a total is spoken, the cells behind it have to remain retrievable, so
 * `table_explain` can read them back without recomputing — recomputation could
 * disagree with what was said, which is the one thing a provenance feature must never
 * do. Answers are short-lived and capped.
 *
 * BOOKMARKS. Someone working through a large table over several sessions needs to
 * come back to where they were. This is deliberately durable rather than
 * conversational: a place-keeping tool that forgets between sessions is not
 * place-keeping.
 *
 * The interface is small enough that an in-memory map serves for local runs and a
 * Cloudflare KV namespace serves in production, without either leaking into the
 * tools.
 */

import type { ExcludedCell } from '../query/engine.ts';

export interface StoredAnswer {
  readonly tableId: string;
  readonly regionId: string;
  readonly sheet: string;
  readonly cells: readonly string[];
  readonly cellCount: number;
  readonly excluded: readonly ExcludedCell[];
  /** Header path of the aggregated column, for "each one is 2026, Q2, Revenue". */
  readonly path: readonly string[];
  /** Enough of the query to re-run a continuation. */
  readonly spec: unknown;
}

export interface Bookmark {
  readonly tableId: string;
  readonly regionId: string;
  readonly rowIndex: number;
  readonly note: string | null;
  readonly savedAt: string;
}

export interface Store {
  putAnswer(answer: StoredAnswer): Promise<string>;
  getAnswer(id: string): Promise<StoredAnswer | null>;
  putBookmark(name: string, mark: Bookmark): Promise<void>;
  getBookmark(name: string): Promise<Bookmark | null>;
  listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]>;
}

/**
 * Answer ids are sequential rather than random.
 *
 * A random id would be fine functionally, but these are occasionally read out during
 * development and always compared in tests, and a deterministic sequence makes both
 * bearable. They are not secrets: an id is only useful to a caller who already has
 * the session.
 */
export class MemoryStore implements Store {
  #answers = new Map<string, StoredAnswer>();
  #bookmarks = new Map<string, Bookmark>();
  #seq = 0;
  readonly #maxAnswers: number;
  readonly #now: () => string;

  constructor(options: { maxAnswers?: number; now?: () => string } = {}) {
    this.#maxAnswers = options.maxAnswers ?? 50;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async putAnswer(answer: StoredAnswer): Promise<string> {
    const id = `a${++this.#seq}`;
    this.#answers.set(id, answer);
    // Map preserves insertion order, so the oldest key is the first one.
    while (this.#answers.size > this.#maxAnswers) {
      const oldest = this.#answers.keys().next().value;
      if (oldest === undefined) break;
      this.#answers.delete(oldest);
    }
    return id;
  }

  async getAnswer(id: string): Promise<StoredAnswer | null> {
    return this.#answers.get(id) ?? null;
  }

  async putBookmark(name: string, mark: Bookmark): Promise<void> {
    this.#bookmarks.set(name.trim().toLowerCase(), mark);
  }

  async getBookmark(name: string): Promise<Bookmark | null> {
    return this.#bookmarks.get(name.trim().toLowerCase()) ?? null;
  }

  async listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]> {
    return [...this.#bookmarks.entries()].map(([name, mark]) => ({ name, mark }));
  }

  /** Exposed for the tools that need a timestamp without importing a clock. */
  now(): string {
    return this.#now();
  }
}

/** Minimal shape of a Cloudflare KV namespace, so the Worker types are not needed here. */
export interface KVLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

/**
 * KV-backed store for the deployed Worker. Answers expire; bookmarks do not, because
 * a bookmark that quietly vanishes is worse than no bookmark at all.
 */
export class KVStore implements Store {
  readonly #kv: KVLike;
  #seq = 0;
  readonly #sessionPrefix: string;

  constructor(kv: KVLike, sessionId: string) {
    this.#kv = kv;
    this.#sessionPrefix = `ans:${sessionId}:`;
  }

  async putAnswer(answer: StoredAnswer): Promise<string> {
    const id = `a${++this.#seq}`;
    await this.#kv.put(this.#sessionPrefix + id, JSON.stringify(answer), {
      expirationTtl: 3600,
    });
    return id;
  }

  async getAnswer(id: string): Promise<StoredAnswer | null> {
    return ((await this.#kv.get(this.#sessionPrefix + id, 'json')) as StoredAnswer) ?? null;
  }

  async putBookmark(name: string, mark: Bookmark): Promise<void> {
    await this.#kv.put(`bm:${name.trim().toLowerCase()}`, JSON.stringify(mark));
  }

  async getBookmark(name: string): Promise<Bookmark | null> {
    return ((await this.#kv.get(`bm:${name.trim().toLowerCase()}`, 'json')) as Bookmark) ?? null;
  }

  async listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]> {
    const { keys } = await this.#kv.list({ prefix: 'bm:' });
    const out: { name: string; mark: Bookmark }[] = [];
    for (const k of keys) {
      const mark = (await this.#kv.get(k.name, 'json')) as Bookmark | null;
      if (mark) out.push({ name: k.name.slice(3), mark });
    }
    return out;
  }
}
