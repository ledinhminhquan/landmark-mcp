/**
 * Session state.
 *
 * Two things need to outlive a single tool call.
 *
 * ANSWERS. When a total is spoken, the cells behind it have to remain retrievable, so
 * `table_explain` can read them back without recomputing — recomputation could
 * disagree with what was said, which is the one thing a provenance feature must never
 * do. Answers are short-lived and capped, and are found by their id from any
 * conversation (see AnswerBook).
 *
 * BOOKMARKS. Someone working through a large table over several sessions needs to
 * come back to where they were. This is deliberately durable rather than
 * conversational: a place-keeping tool that forgets between sessions is not
 * place-keeping. They belong to a conversation, though, and how long a conversation
 * lasts is up to the caller (see sessionKey in server.ts): the voice client keeps one
 * per browser, while an MCP host gets a new one with every connection.
 *
 * The interface is small enough that an in-memory map serves for local runs and a
 * SQLite-backed Durable Object serves the deployed Worker (src/state/), without either
 * leaking into the tools.
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
  /** What was computed ('sum', 'count', 'max', 'none', …): it changes what the cells prove. */
  readonly aggregate?: string;
  /** For a highest or lowest value: the cells holding it, and the rows they belong to. */
  readonly winners?: readonly string[];
  readonly winnerLabels?: readonly string[];
  /** How many rows hold that value: `winners` keeps only the first few when many tie. */
  readonly winnerCount?: number;
  /** Structure revision of THIS operand's table, so a correction to either side is caught. */
  readonly structureRevision?: number;
  /**
   * Heading rows of the reading this was computed under. Confirming the reading bumps
   * the revision without changing a single cell, so staleness is judged on this.
   */
  readonly headerRows?: number;
  /** The table's `ingestedAt` when answered, so a re-ingested file is not cited as evidence. */
  readonly ingestedAt?: string;
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
  /** The table's `ingestedAt` when saved: a row number means nothing in a different file. */
  readonly ingestedAt?: string;
  /** The structure revision when saved: a heading correction shifts every row number. */
  readonly structureRevision?: number;
  /** Heading rows when saved; only a different count moves the row a number points at. */
  readonly headerRows?: number;
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
 * Answer ids have to be unique everywhere, and impossible to guess.
 *
 * Unique: they used to be a counter starting at zero inside each store instance. Two
 * Worker isolates writing to the same namespace therefore both minted `a1`, and the
 * second silently overwrote the first — so asking "how do you know" could return the
 * working for somebody else's question.
 *
 * Unguessable: an answer is found by its id alone, from any conversation (see
 * AnswerBook), because a host that reconnects for every turn starts a new
 * conversation every turn and still has to be able to ask about the last one. The id
 * is therefore the only thing standing between a caller and somebody else's working,
 * so it carries 64 random bits — too many to find by trying, still short enough to
 * read in a log and for a model to copy from one turn to the next.
 */
export function mintId(seq: number): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `a${seq}-${rand}`;
}

/**
 * The sequence number inside an id `mintId` produced, or null for anything else.
 *
 * A store has to refuse ids it did not mint rather than look them up: the key-value
 * store this replaced kept structure corrections under the same prefix as answers, so
 * asking to explain "st:<region>" handed a correction to code expecting an answer and
 * it failed with a raw TypeError. On the Worker an id also names the Durable Object
 * that holds the answer, so only well-formed ids get as far as creating a stub.
 */
export function answerSeq(id: string): number | null {
  const m = /^a(\d{1,15})-[0-9a-f]{16}$/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * How many answers one store keeps, and how many bookmarks one conversation keeps.
 *
 * Answers only need to last as long as someone might ask "how do you know" about
 * them. Bookmarks are durable, but a caller that saves a new name on every request
 * must not grow one conversation's state without end; a hundred is far past what a
 * person keeps track of by voice, and the oldest save is the one to let go.
 */
export const MAX_ANSWERS = 50;
export const MAX_BOOKMARKS = 100;

/**
 * Answers held in memory, found by id, oldest let go first.
 *
 * One book can serve many conversations, and the server shares one across all of
 * them: an answer is reachable by its unguessable id from whichever conversation asks
 * (see mintId), not only from the one that produced it. That is what lets "how do you
 * know" work on a host that opens a new connection — and so gets a new conversation —
 * for every turn. Bookmarks and structure corrections are not shared this way: a name
 * like "my place" can be guessed, and a correction changes what everybody hears.
 */
export class AnswerBook {
  readonly #answers = new Map<string, StoredAnswer>();
  readonly #max: number;
  #seq = 0;

  constructor(max: number = MAX_ANSWERS) {
    this.#max = max;
  }

  put(answer: StoredAnswer): string {
    const id = mintId(++this.#seq);
    this.#answers.set(id, answer);
    // Map preserves insertion order, so the oldest key is the first one.
    while (this.#answers.size > this.#max) {
      const oldest = this.#answers.keys().next().value;
      if (oldest === undefined) break;
      this.#answers.delete(oldest);
    }
    return id;
  }

  get(id: string): StoredAnswer | null {
    return this.#answers.get(id) ?? null;
  }
}

export class MemoryStore implements Store {
  readonly #answers: AnswerBook;
  #bookmarks = new Map<string, Bookmark>();
  #structures = new Map<string, StructureOverride>();
  readonly #maxBookmarks: number;
  readonly #now: () => string;

  /**
   * `answers` shares one book between stores; without it this store keeps its own
   * `maxAnswers`.
   */
  constructor(
    options: { answers?: AnswerBook; maxAnswers?: number; maxBookmarks?: number; now?: () => string } = {},
  ) {
    this.#answers = options.answers ?? new AnswerBook(options.maxAnswers ?? MAX_ANSWERS);
    this.#maxBookmarks = options.maxBookmarks ?? MAX_BOOKMARKS;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async putAnswer(answer: StoredAnswer): Promise<string> {
    return this.#answers.put(answer);
  }

  async getAnswer(id: string): Promise<StoredAnswer | null> {
    return this.#answers.get(id);
  }

  async putBookmark(name: string, mark: Bookmark): Promise<void> {
    const key = name.trim().toLowerCase();
    // Delete first so a re-save moves to the end: insertion order is then save order,
    // which is what listBookmarks promises and what the cap evicts by.
    this.#bookmarks.delete(key);
    this.#bookmarks.set(key, mark);
    while (this.#bookmarks.size > this.#maxBookmarks) {
      const oldest = this.#bookmarks.keys().next().value;
      if (oldest === undefined) break;
      this.#bookmarks.delete(oldest);
    }
  }

  async getBookmark(name: string): Promise<Bookmark | null> {
    return this.#bookmarks.get(name.trim().toLowerCase()) ?? null;
  }

  /** Oldest save first, so the most recent is last. */
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
