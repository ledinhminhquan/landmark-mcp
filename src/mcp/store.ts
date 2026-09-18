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

/**
 * One side of an answer, with the cells that produced it.
 *
 * A comparison reads two columns, often on different sheets. Storing one flat set of
 * addresses and one heading meant explaining a comparison labelled the second
 * column's cells with the first column's name — telling someone that C6 and C7 hold
 * "Target" when they hold "Actual". The one feature that lets a listener check a
 * number was misreporting half of it, so provenance is per operand.
 */
export interface AnswerPart {
  /** What to call this side aloud: "2026, Q1, Revenue". */
  readonly label: string;
  readonly tableId: string;
  readonly regionId: string;
  readonly sheet: string;
  readonly cells: readonly string[];
  readonly cellCount: number;
  readonly excluded: readonly ExcludedCell[];
  /** Heading path of the aggregated column, for "each one is 2026, Q2, Revenue". */
  readonly path: readonly string[];
}

export interface StoredAnswer {
  /** One entry for a plain query; one per operand for a comparison. */
  readonly parts: readonly AnswerPart[];
  /** Enough of the query to re-run a continuation. */
  readonly spec: unknown;
  /**
   * Structure revision this answer was computed under. If the person later corrects
   * how the table is read, explaining this answer must say so rather than quietly
   * presenting evidence from a different reading of the file.
   */
  readonly structureRevision: number;
}

export interface Bookmark {
  readonly tableId: string;
  readonly regionId: string;
  readonly rowIndex: number;
  readonly note: string | null;
  readonly savedAt: string;
}

/**
 * A person's correction to how a region's structure is read.
 *
 * Inference gets tables wrong, and a tool that cannot be corrected out loud leaves a
 * blind user with no recourse at all — they cannot open the file and look. The
 * revision is what keeps earlier answers honest: every answer records the revision it
 * was computed under, so a correction cannot silently rewrite the evidence for
 * something already spoken.
 */
export interface StructureOverride {
  readonly headerRows: number;
  readonly revision: number;
}

export interface Store {
  putAnswer(answer: StoredAnswer): Promise<string>;
  getAnswer(id: string): Promise<StoredAnswer | null>;
  putBookmark(name: string, mark: Bookmark): Promise<void>;
  getBookmark(name: string): Promise<Bookmark | null>;
  listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]>;
  getStructure(regionKey: string): Promise<StructureOverride | null>;
  /** Records the correction and returns the new revision. */
  putStructure(regionKey: string, headerRows: number): Promise<StructureOverride>;
}

/**
 * Answer ids must be unique across every process that shares a backing store.
 *
 * They used to be a counter starting at zero inside each store instance. Two Worker
 * isolates writing to the same namespace therefore both minted `a1`, and the second
 * silently overwrote the first — so asking "how do you know" could return the
 * working for somebody else's question. A short random suffix removes the collision
 * without making the id unreadable when it appears in a log.
 */
function mintId(seq: number): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `a${seq}-${rand}`;
}

export class MemoryStore implements Store {
  #answers = new Map<string, StoredAnswer>();
  #bookmarks = new Map<string, Bookmark>();
  #structures = new Map<string, StructureOverride>();
  #seq = 0;
  readonly #maxAnswers: number;
  readonly #now: () => string;

  constructor(options: { maxAnswers?: number; now?: () => string } = {}) {
    this.#maxAnswers = options.maxAnswers ?? 50;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async putAnswer(answer: StoredAnswer): Promise<string> {
    const id = mintId(++this.#seq);
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

  async getStructure(regionKey: string): Promise<StructureOverride | null> {
    return this.#structures.get(regionKey) ?? null;
  }

  async putStructure(regionKey: string, headerRows: number): Promise<StructureOverride> {
    const previous = this.#structures.get(regionKey);
    const next: StructureOverride = { headerRows, revision: (previous?.revision ?? 1) + 1 };
    this.#structures.set(regionKey, next);
    return next;
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
  readonly #bookmarkPrefix: string;

  constructor(kv: KVLike, sessionId: string) {
    this.#kv = kv;
    this.#sessionPrefix = `ans:${sessionId}:`;
    // Bookmarks were keyed by name alone, so two people using the same deployment
    // both saved "my place" to the same key and each kept overwriting the other.
    // Without authentication the server cannot identify a person, only a session —
    // so that is what it scopes to, and the README says exactly that.
    this.#bookmarkPrefix = `bm:${sessionId}:`;
  }

  async putAnswer(answer: StoredAnswer): Promise<string> {
    const id = mintId(++this.#seq);
    await this.#kv.put(this.#sessionPrefix + id, JSON.stringify(answer), {
      expirationTtl: 3600,
    });
    return id;
  }

  async getAnswer(id: string): Promise<StoredAnswer | null> {
    return ((await this.#kv.get(this.#sessionPrefix + id, 'json')) as StoredAnswer) ?? null;
  }

  async putBookmark(name: string, mark: Bookmark): Promise<void> {
    await this.#kv.put(this.#bookmarkPrefix + name.trim().toLowerCase(), JSON.stringify(mark));
  }

  async getBookmark(name: string): Promise<Bookmark | null> {
    return ((await this.#kv.get(this.#bookmarkPrefix + name.trim().toLowerCase(), 'json')) as Bookmark) ?? null;
  }

  async getStructure(regionKey: string): Promise<StructureOverride | null> {
    return ((await this.#kv.get(this.#sessionPrefix + 'st:' + regionKey, 'json')) as StructureOverride) ?? null;
  }

  async putStructure(regionKey: string, headerRows: number): Promise<StructureOverride> {
    const previous = await this.getStructure(regionKey);
    const next: StructureOverride = { headerRows, revision: (previous?.revision ?? 1) + 1 };
    await this.#kv.put(this.#sessionPrefix + 'st:' + regionKey, JSON.stringify(next), {
      expirationTtl: 86400,
    });
    return next;
  }

  async listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]> {
    const { keys } = await this.#kv.list({ prefix: this.#bookmarkPrefix });
    const out: { name: string; mark: Bookmark }[] = [];
    for (const k of keys) {
      const mark = (await this.#kv.get(k.name, 'json')) as Bookmark | null;
      if (mark) out.push({ name: k.name.slice(this.#bookmarkPrefix.length), mark });
    }
    return out;
  }
}
