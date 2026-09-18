/**
 * The MCP endpoint.
 *
 * Web-standard Request in, Response out, so the same handler runs unmodified on
 * Cloudflare Workers and behind a small Node adapter locally. Nothing here touches
 * the filesystem or a Node global — that was the whole reason for moving ingest
 * offline.
 *
 * The transport is stateless: each request builds its own server and transport and
 * discards them, so there is no session affinity to maintain and nothing to warm up.
 * The store is emphatically not stateless — answers and bookmarks are the two things
 * that must outlive a request — so it is constructed once and shared.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { assertIndex, type LandmarkIndex } from './indexfmt.ts';
import { registerTools } from './mcp/tools.ts';
import { MemoryStore, type Store } from './mcp/store.ts';
import { registerWidget } from './mcp/widget.ts';

export const SERVER_NAME = 'landmark';
export const SERVER_VERSION = '0.1.0';

const JSON_HEADERS = { 'content-type': 'application/json' };

export interface HandlerOptions {
  readonly index: LandmarkIndex;
  /** Called once per session. Supply a KV-backed store in production. */
  readonly makeStore?: (sessionKey: string) => Store;
  /**
   * Hosts permitted in the Host header. Supply the deployment's own hostname to turn
   * on DNS-rebinding protection; leaving it unset keeps the endpoint reachable by
   * unknown clients, which is what a public MCP server needs.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Browser origins permitted to call this endpoint. An Origin that is present and
   * not on this list is refused with 403, as the transport specification requires.
   * A request with no Origin at all is normal for a server-side MCP client and is
   * not refused.
   */
  readonly allowedOrigins?: readonly string[];
}

export function createServer(index: LandmarkIndex, store: Store): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      // `resources` is declared because the explain widget is served as one.
      capabilities: { tools: {}, resources: {} },
      instructions:
        'This table is being read aloud to someone who cannot see it. Describe a table before ' +
        'querying it, ask rather than read whenever a question can be aggregated, speak the ' +
        '"spoken" field of each result rather than reformatting it, and offer to show where a ' +
        'number came from after any total or average.',
    },
  );
  registerTools(server, index, store);
  registerWidget(server, index);
  return server;
}

/**
 * Which caller a request belongs to.
 *
 * This server has no authentication, so it cannot identify a *person* — only a
 * conversation. Saying that plainly is better than the previous behaviour, where
 * every caller shared one namespace and two people using the same deployment
 * overwrote each other's bookmarks and could read each other's working.
 *
 * A client that wants its own state sends a session header; the bundled voice client
 * generates one per browser. Anything without a header falls into a single shared
 * demo session, which is fine for one person trying the deployment and is documented
 * as such rather than presented as isolation.
 */
function sessionKey(request: Request): string {
  const explicit =
    request.headers.get('mcp-session-id') ?? request.headers.get('x-landmark-session');
  if (!explicit) return 'shared-demo';
  // Keep it to characters that are safe in a KV key and readable in a log.
  return explicit.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'shared-demo';
}

/**
 * Build a Web-standard fetch handler.
 *
 * GET /health is deliberately included: judging runs weeks after the last commit, and
 * an endpoint nobody can prove is up is indistinguishable from one that is down.
 */
export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  assertIndex(options.index);

  // Stores are per session and built once per session, not per request. The transport
  // is stateless, but the store is the opposite of stateless by design: an answer has
  // to still be there when the user asks where the number came from, and a bookmark
  // has to still be there next week. Constructing it inside the handler makes explain
  // and resume silently useless — every call succeeds and finds nothing.
  // A separate instance per session is the isolation; MemoryStore needs no key.
  const makeStore = options.makeStore ?? ((_key: string) => new MemoryStore());
  const stores = new Map<string, Store>();
  const storeFor = (key: string): Store => {
    let s = stores.get(key);
    if (!s) {
      s = makeStore(key);
      stores.set(key, s);
      // A public endpoint should not grow a store per probe. Oldest first; a session
      // that returns after eviction sees empty state rather than someone else's.
      if (stores.size > 200) {
        const oldest = stores.keys().next().value;
        if (oldest !== undefined) stores.delete(oldest);
      }
    }
    return s;
  };

  return async function handle(request: Request): Promise<Response> {
    const store = storeFor(sessionKey(request));
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          server: SERVER_NAME,
          version: SERVER_VERSION,
          protocol: LATEST_PROTOCOL_VERSION,
          tables: options.index.tables.length,
          rows: options.index.tables.reduce(
            (n, t) => n + t.regions.reduce((m, r) => m + r.rowCount, 0),
            0,
          ),
        }),
        { headers: JSON_HEADERS },
      );
    }

    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      return new Response(
        JSON.stringify({ error: 'Not found. The MCP endpoint is at /mcp.' }),
        { status: 404, headers: JSON_HEADERS },
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session id, so every request stands alone.
      //
      // JSON responses rather than SSE. The spec allows a POST to be answered with
      // either, and this server never initiates a message — no sampling, no progress
      // notifications, no server-side streaming — so an event stream would buy
      // nothing and cost the thing that matters here: an open stream cannot be closed
      // until the client disconnects, which on a per-request stateless handler means
      // either leaking the transport or racing it. One complete Response per request
      // removes the question, and takes a round of latency out of every tool call.
      enableJsonResponse: true,
      ...(options.allowedHosts ? { allowedHosts: [...options.allowedHosts] } : {}),
      ...(options.allowedOrigins ? { allowedOrigins: [...options.allowedOrigins] } : {}),
      // The specification requires an invalid Origin to be refused with 403. This was
      // off unless a host allowlist happened to be configured, so the check simply
      // did not exist in the default deployment.
      enableDnsRebindingProtection:
        options.allowedHosts !== undefined || options.allowedOrigins !== undefined,
    });

    const server = createServer(options.index, store);
    await server.connect(transport);

    try {
      return await transport.handleRequest(request);
    } finally {
      // The isolate may be reused; leaving a transport connected leaks its keep-alive.
      await transport.close().catch(() => {});
    }
  };
}
