/**
 * The Worker's side of its state: a Store whose every call is forwarded to a Durable
 * Object — the conversation's own for bookmarks and corrections, the answer's own for
 * the working behind an answer.
 *
 * No 'cloudflare:workers' import here, so this file is importable — and tested — under
 * Node. A namespace is described by the two calls made on it, which the real binding
 * satisfies.
 */

import { answerSeq, mintId, type Bookmark, type Store, type StoredAnswer, type StructureOverride } from '../mcp/store.ts';
import type { AnswerHolder, ConversationStore } from './session-state.ts';

/** A Durable Object binding, reduced to the two calls this file makes on it. */
export interface Namespace<Stub> {
  idFromName(name: string): unknown;
  get(id: unknown): Stub;
}

/** The two bindings declared in wrangler.jsonc. */
export interface StateNamespaces {
  /** LandmarkState: one object per conversation. */
  readonly conversations: Namespace<ConversationStore>;
  /** LandmarkAnswer: one object per answer. */
  readonly answers: Namespace<AnswerHolder>;
}

/**
 * Sequence numbers for the ids this isolate mints. They only make an id easier to
 * read in a log; uniqueness and secrecy come from mintId's random part, so it does not
 * matter that every isolate counts from one.
 */
let minted = 0;

export class DurableStore implements Store {
  readonly #ns: StateNamespaces;
  readonly #key: string;

  constructor(ns: StateNamespaces, sessionKey: string) {
    this.#ns = ns;
    this.#key = sessionKey;
  }

  /**
   * A fresh stub for every call rather than one kept for the life of the isolate.
   * Stubs are cheap, and Cloudflare's guidance is that a stub which has seen certain
   * errors may stay broken — a cached one would turn one bad moment into a
   * conversation that can no longer save anything.
   */
  #conversation(): ConversationStore {
    const ns = this.#ns.conversations;
    return ns.get(ns.idFromName(this.#key));
  }

  #answer(id: string): AnswerHolder {
    const ns = this.#ns.answers;
    return ns.get(ns.idFromName(id));
  }

  /**
   * Filed under its own id, not under this conversation: a host that opens a new
   * connection for each turn asks "how do you know" from a different conversation
   * than the one that gave the answer, and has only the id to go on.
   */
  async putAnswer(answer: StoredAnswer): Promise<string> {
    const id = mintId(++minted);
    await this.#answer(id).keep(id, answer);
    return id;
  }

  /** Only an id mintId could have produced names an object; anything else is no answer. */
  async getAnswer(id: string): Promise<StoredAnswer | null> {
    if (answerSeq(id) === null) return null;
    return this.#answer(id).read(id);
  }

  putBookmark(name: string, mark: Bookmark): Promise<void> {
    return this.#conversation().putBookmark(name, mark);
  }

  getBookmark(name: string): Promise<Bookmark | null> {
    return this.#conversation().getBookmark(name);
  }

  listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]> {
    return this.#conversation().listBookmarks();
  }

  getStructure(regionKey: string): Promise<StructureOverride | null> {
    return this.#conversation().getStructure(regionKey);
  }

  putStructure(regionKey: string, headerRows: number): Promise<StructureOverride> {
    return this.#conversation().putStructure(regionKey, headerRows);
  }
}
