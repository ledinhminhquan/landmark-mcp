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

export const SERVER_NAME = 'landmark';
export const SERVER_VERSION = '0.1.0';

const JSON_HEADERS = { 'content-type': 'application/json' };

export interface HandlerOptions {
  readonly index: LandmarkIndex;
  /** Called once. Supply a KV-backed store in production; defaults to in-memory. */
  readonly makeStore?: () => Store;
  /**
   * Hosts permitted in the Host header. Left undefined, DNS-rebinding protection
   * stays off — correct for a public MCP endpoint reached by unknown clients, and
   * the reason this server holds no credentials worth stealing.
   */
  readonly allowedHosts?: readonly string[];
}

export function createServer(index: LandmarkIndex, store: Store): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'This table is being read aloud to someone who cannot see it. Describe a table before ' +
        'querying it, ask rather than read whenever a question can be aggregated, speak the ' +
        '"spoken" field of each result rather than reformatting it, and offer to show where a ' +
        'number came from after any total or average.',
    },
  );
  registerTools(server, index, store);
  return server;
}

/**
 * Build a Web-standard fetch handler.
 *
 * GET /health is deliberately included: judging runs weeks after the last commit, and
 * an endpoint nobody can prove is up is indistinguishable from one that is down.
 */
export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  assertIndex(options.index);

  // Built once, not per request. The transport is stateless, but the store is the
  // opposite of stateless by design: an answer has to still be there when the user
  // asks where the number came from, and a bookmark has to still be there next week.
  // Constructing it inside the handler makes explain and resume silently useless —
  // every call succeeds and finds nothing.
  //
  // In a single Worker isolate this backs both correctly. Across isolates only the
  // KV-backed store does, which is why makeStore is injectable rather than assumed.
  const store = (options.makeStore ?? (() => new MemoryStore()))();

  return async function handle(request: Request): Promise<Response> {
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
      enableDnsRebindingProtection: options.allowedHosts !== undefined,
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
