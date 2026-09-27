/**
 * Cloudflare Workers entry.
 *
 * Thin by design: the handler in server.ts is the whole server, and it takes only
 * Web-standard Request and Response, so this file exists to bind an index and the
 * Durable Objects that hold state to it. Everything testable is tested against
 * `createHandler` directly, which means the deployed path and the tested path are the
 * same code.
 *
 * The index is bundled at build time rather than fetched at runtime. It is small
 * (kilobytes), it never changes between deploys, and a fetch on the request path
 * would add latency to every cold isolate for no benefit.
 */

import { env } from 'cloudflare:workers';

import index from '../data/index.json' with { type: 'json' };
import { createHandler } from './server.ts';
import { DurableStore, type Namespace, type StateNamespaces } from './state/durable-store.ts';
import type { AnswerHolder, ConversationStore } from './state/session-state.ts';

// Wrangler finds the Durable Object classes among the entry module's exports.
export { LandmarkAnswer, LandmarkState } from './state/durable.ts';

export interface Env {
  /**
   * The LandmarkState namespace declared in wrangler.jsonc: one SQLite-backed object
   * per conversation holding its structure corrections and bookmarks.
   */
  LANDMARK_STATE?: Namespace<ConversationStore>;
  /**
   * The LandmarkAnswer namespace: one object per answer, holding the working behind it
   * for "how do you know". Without both bindings the server still answers, but all of
   * this lasts only as long as one isolate, and GET /health says so.
   */
  LANDMARK_ANSWERS?: Namespace<AnswerHolder>;
  /**
   * Optional, comma-separated extra browser origins allowed to call /mcp. The Worker's
   * own origin is always allowed and any other Origin is refused. No CORS headers are
   * sent, so this helps only a front end that does not need them.
   */
  LANDMARK_ALLOWED_ORIGINS?: string;
}

/**
 * Built at module scope, not on the first request. Bindings are readable here, and the
 * work of building the handler — checking the index, compiling the tool schemas once —
 * then counts against start-up, which has a budget of its own, instead of against the
 * first question someone asks, which has the free plan's 10 ms of CPU.
 */
const bindings = env as Env;
const namespaces: StateNamespaces | null =
  bindings.LANDMARK_STATE && bindings.LANDMARK_ANSWERS
    ? { conversations: bindings.LANDMARK_STATE, answers: bindings.LANDMARK_ANSWERS }
    : null;

/**
 * Every conversation that identifies itself gets its own Durable Object. The shared
 * session — callers that send no header at all — is not asked for here: the handler
 * keeps it in isolate memory whatever store it is given, because made durable, one
 * anonymous caller's structure correction or note would be served to every other
 * anonymous caller, worldwide, for months.
 */
const makeStore = (ns: StateNamespaces) => (key: string) => new DurableStore(ns, key);

const handler = createHandler({
  index: index as never,
  ...(namespaces ? { makeStore: makeStore(namespaces), durableState: true } : {}),
  ...(bindings.LANDMARK_ALLOWED_ORIGINS
    ? {
        allowedOrigins: bindings.LANDMARK_ALLOWED_ORIGINS.split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      }
    : {}),
});

export default {
  fetch(request: Request): Promise<Response> {
    return handler(request);
  },
};
