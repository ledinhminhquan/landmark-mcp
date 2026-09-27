#!/usr/bin/env node
/**
 * Local runner. Serves the same Web-standard handler the Worker will, behind a small
 * node:http adapter, so what is tested locally is the deployed code path rather than
 * a parallel implementation of it.
 *
 *   npm run serve            # reads data/index.json
 *   npm run serve -- 8788    # on another port
 *   HOST=0.0.0.0 npm run serve   # reachable from other machines (off by default)
 *
 * Behind a tunnel, name it with LANDMARK_ALLOWED_HOSTS (comma-separated, for example
 * LANDMARK_ALLOWED_HOSTS=demo.trycloudflare.com) instead of opening the port with HOST.
 * That admits the tunnel's name as a Host, and its https:// origin for the voice
 * client opened through it. LANDMARK_ALLOWED_ORIGINS adds any other browser origin.
 *
 * This file is also the package's `bin`, so it cannot assume the working directory is
 * the checkout: the index and the web client are located relative to the package root,
 * which is found by walking up from this module until a package.json appears.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { createHandler, hostAllowed, isHostHeader } from './server.ts';
import { assertIndex } from './indexfmt.ts';

const port = Number(process.argv[2] ?? process.env['PORT'] ?? 8787);

/**
 * Loopback unless asked otherwise. This is how someone queries their own private
 * spreadsheets, and it used to listen on every interface with no Host or Origin check:
 * anyone on the same Wi-Fi could read every table, and any web page could rebind its
 * own hostname to 127.0.0.1 and do the same from the browser. The specification says
 * a local server SHOULD bind to localhost; HOST=0.0.0.0 remains an explicit opt-in.
 */
const host = process.env['HOST'] || '127.0.0.1';
const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);

/** Comma-separated environment list, for the two escape hatches below. */
const listEnv = (name: string): string[] =>
  (process.env[name] ?? '').split(',').map((v) => v.trim()).filter(Boolean);

// A tunnel (cloudflared, ngrok) forwards its own public name as the Host; name it in
// LANDMARK_ALLOWED_HOSTS rather than opening the port to the network with HOST.
const tunnels = listEnv('LANDMARK_ALLOWED_HOSTS');
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]', ...tunnels];

// The tunnel ends TLS and forwards plain http, so the request URL built below says
// http://<tunnel> while a browser on the tunnel sends Origin https://<tunnel>. Without
// this, naming the tunnel let its requests in and still refused the voice client
// opened through it.
const allowedOrigins = [...listEnv('LANDMARK_ALLOWED_ORIGINS'), ...tunnels.map((t) => `https://${t}`)];

/** The same JSON-RPC shape the handler refuses with, for requests refused before it. */
function refuse(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** Nearest ancestor of this module holding a package.json; the checkout when run from source. */
async function packageRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up++) {
    try {
      await stat(join(dir, 'package.json'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

const root = await packageRoot();

/** An explicit path wins; otherwise prefer the working directory, then the package's own copy. */
async function locateIndex(): Promise<string> {
  const explicit = process.env['LANDMARK_INDEX'];
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);
  for (const candidate of [resolve('data/index.json'), join(root, 'data', 'index.json')]) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return resolve('data/index.json');
}

const indexPath = await locateIndex();

let parsed: unknown;
try {
  parsed = JSON.parse(await readFile(indexPath, 'utf8'));
} catch {
  console.error(
    `Could not read ${indexPath}.\nRun the ingest step first, for example:\n` +
      '  npm run fixtures\n  npm run ingest -- test/fixtures/*.xlsx test/fixtures/*.csv',
  );
  process.exit(1);
}
assertIndex(parsed);

// Bound to loopback, the only names a legitimate request can carry in its Host header
// are loopback names. A rebinding page sends its own.
const handle = createHandler({
  index: parsed,
  ...(loopback ? { allowedHosts: ALLOWED_HOSTS } : {}),
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
});

/** node:http request → Web Request. */
function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);
}

/** Web Response → node:http response, streaming the body rather than buffering it. */
async function send(res: ServerResponse, out: Response): Promise<void> {
  res.statusCode = out.status;
  out.headers.forEach((value, key) => res.setHeader(key, value));
  if (!out.body) {
    res.end();
    return;
  }
  const reader = out.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/**
 * Serve the voice client from web/ alongside the MCP endpoint, so the demo talks to
 * the server over a real network request from a real origin rather than through a
 * bundler shim. Path traversal is blocked by normalising and re-checking the prefix.
 */
async function tryStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/mcp' || path === '/health') return false;

  // A malformed escape ("/%E0%A4%A") is no file of ours. It used to throw here and come
  // back as a 500 with a stack trace in the console; it now falls through to the same
  // 404 the Worker gives.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  const rel = path === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const webRoot = resolve(root, 'web');
  const file = normalize(join(webRoot, rel));
  // Compare against the directory *with* a separator: a bare prefix test would also
  // accept a sibling whose name merely starts with "web".
  if (file !== webRoot && !file.startsWith(webRoot + sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return true;
  }
  try {
    const body = await readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

createHttpServer((req, res) => {
  // Every URL below is built from the Host header, and the URL parser accepts things
  // no HTTP client sends — "evil.com@localhost" became a request with credentials in
  // its URL, which Request refuses, and the caller got a 500. Refuse those first,
  // whether or not the Host is checked against a list.
  const hostHeader = req.headers.host;
  if (hostHeader !== undefined && !isHostHeader(hostHeader)) {
    refuse(res, 400, 'Malformed Host header.');
    return;
  }
  // The static files get the same Host rule as /mcp, which the handler applies itself.
  if (loopback && !hostAllowed(hostHeader ?? null, ALLOWED_HOSTS)) {
    refuse(res, 403, 'This server only answers requests addressed to its own host name.');
    return;
  }
  tryStatic(req, res)
    .then((served) => {
      if (served) return;
      return handle(toRequest(req))
        .then((out) => send(res, out));
    })
    .catch((err: unknown) => {
      console.error(err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Internal error' }));
    });
}).listen(port, host, () => {
  // `parsed` is already narrowed to LandmarkIndex by assertIndex above.
  const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  console.log(`landmark listening on ${host} port ${port}` + (loopback ? ' (this machine only; set HOST to change)' : ''));
  if (!loopback) {
    console.log('  reachable from other machines on the network, with no Host check');
  }
  console.log(`  MCP endpoint  http://${shown}:${port}/mcp`);
  console.log(`  health        http://${shown}:${port}/health`);
  console.log(`  voice client  http://${shown}:${port}/`);
  console.log(`  index         ${indexPath} (${parsed.tables.length} tables)`);
});
