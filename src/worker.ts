/**
 * Cloudflare Workers entry.
 *
 * Thin by design: the handler in server.ts is the whole server, and it takes only
 * Web-standard Request and Response, so this file exists to bind an index and a KV
 * namespace to it. Everything testable is tested against `createHandler` directly,
 * which means the deployed path and the tested path are the same code.
 *
 * The index is bundled at build time rather than fetched at runtime. It is small
 * (kilobytes), it never changes between deploys, and a fetch on the request path
 * would add latency to every cold isolate for no benefit.
 */

import index from '../data/index.json' with { type: 'json' };
import { createHandler } from './server.ts';
import { KVStore, type KVLike } from './mcp/store.ts';

export interface Env {
  /** Optional. Without it, bookmarks live only as long as one isolate. */
  LANDMARK_KV?: KVLike;
}

let handler: ((request: Request) => Promise<Response>) | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    handler ??= createHandler({
      index: index as never,
      ...(env.LANDMARK_KV
        ? { makeStore: () => new KVStore(env.LANDMARK_KV as KVLike, 'shared') }
        : {}),
    });
    return handler(request);
  },
};
