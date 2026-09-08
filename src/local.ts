/**
 * Local runner. Serves the same Web-standard handler the Worker will, behind a small
 * node:http adapter, so what is tested locally is the deployed code path rather than
 * a parallel implementation of it.
 *
 *   npm run serve            # reads data/index.json
 *   npm run serve -- 8788    # on another port
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { createHandler } from './server.ts';
import { assertIndex } from './indexfmt.ts';

const port = Number(process.argv[2] ?? process.env['PORT'] ?? 8787);
const indexPath = process.env['LANDMARK_INDEX'] ?? 'data/index.json';

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

createHttpServer((req, res) => {
  handle(toRequest(req))
    .then((out) => send(res, out))
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
  console.log(`  index         ${indexPath} (${parsed.tables.length} tables)`);
});
