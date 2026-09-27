/**
 * The Durable Objects behind the Worker's state. Worker-only: this file imports
 * 'cloudflare:workers', so nothing Node runs may import it. The logic they serve
 * lives in session-state.ts, which is tested under Node against a fake storage.
 *
 * Both are SQLite-backed, because that is the storage the Workers free plan offers,
 * and reached over RPC: each public method below is one call from DurableStore.
 *
 *   LandmarkState   one per conversation, named by its session key: bookmarks and
 *                   structure corrections, cleared after three months without use.
 *   LandmarkAnswer  one per answer, named by the answer's unguessable id, so any
 *                   conversation holding the id can read it back; cleared a week
 *                   after it was given.
 */

import { DurableObject, type DurableObjectState } from 'cloudflare:workers';

import type { Bookmark, StoredAnswer, StructureOverride } from '../mcp/store.ts';
import {
  AnswerState,
  IdleExpiry,
  SessionState,
  type AnswerHolder,
  type ConversationStore,
} from './session-state.ts';

export class LandmarkState extends DurableObject implements ConversationStore {
  readonly #state: SessionState;
  readonly #expiry: IdleExpiry;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#state = new SessionState(ctx.storage);
    this.#expiry = new IdleExpiry(ctx.storage);
  }

  /** Every call is use, reads included: see IdleExpiry. */
  async #used<T>(result: Promise<T>): Promise<T> {
    const value = await result;
    await this.#expiry.touch();
    return value;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.#expiry.fired();
  }

  putBookmark(name: string, mark: Bookmark): Promise<void> {
    return this.#used(this.#state.putBookmark(name, mark));
  }

  getBookmark(name: string): Promise<Bookmark | null> {
    return this.#used(this.#state.getBookmark(name));
  }

  listBookmarks(): Promise<readonly { name: string; mark: Bookmark }[]> {
    return this.#used(this.#state.listBookmarks());
  }

  getStructure(regionKey: string): Promise<StructureOverride | null> {
    return this.#used(this.#state.getStructure(regionKey));
  }

  putStructure(regionKey: string, headerRows: number): Promise<StructureOverride> {
    return this.#used(this.#state.putStructure(regionKey, headerRows));
  }
}

export class LandmarkAnswer extends DurableObject implements AnswerHolder {
  readonly #state: AnswerState;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#state = new AnswerState(ctx.storage);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  keep(id: string, answer: StoredAnswer): Promise<void> {
    return this.#state.keep(id, answer);
  }

  read(id: string): Promise<StoredAnswer | null> {
    return this.#state.read(id);
  }
}
