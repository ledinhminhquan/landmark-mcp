#!/usr/bin/env node
/**
 * Local runner. Serves the same Web-standard handler the Worker will, behind a small
 * node:http adapter, so what is tested locally is the deployed code path rather than
 * a parallel implementation of it.
 *
 *   npm run serve            # reads data/index.json
 *   npm run serve -- 8788    # on another port
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

import { createHandler } from './server.ts';
import { assertIndex } from './indexfmt.ts';

const port = Number(process.argv[2] ?? process.env['PORT'] ?? 8787);

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

const handle = createHandler({ index: parsed });

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

  const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
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
}).listen(port, () => {
  // `parsed` is already narrowed to LandmarkIndex by assertIndex above.
  console.log(`landmark listening on http://localhost:${port}`);
  console.log(`  MCP endpoint  http://localhost:${port}/mcp`);
  console.log(`  health        http://localhost:${port}/health`);
  console.log(`  voice client  http://localhost:${port}/`);
  console.log(`  index         ${indexPath} (${parsed.tables.length} tables)`);
});
