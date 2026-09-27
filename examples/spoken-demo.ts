/**
 * What Landmark actually says, printed from the real server. Run: npm run demo
 *
 * Every reply is produced by the same handler that `npm run serve` and the Worker run
 * (createHandler in src/server.ts), over real JSON-RPC, against the bundled
 * data/index.json. The questions go through the voice client's own router
 * (web/app.js), so the tool and arguments printed under each question are the ones
 * the page would send.
 *
 * An earlier version of this file called the structure-inference helpers directly. No
 * tool uses those, so it printed sentences the server never says ("Region: empty
 * (A4)" for a cell the server calls a merged label) under a heading claiming to show
 * what the agent says. A demo that can disagree with the product is worse than none,
 * so this one has no speech of its own: if a line below changes, the product changed.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHandler } from '../src/server.ts';
import { assertIndex } from '../src/indexfmt.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, resetContext } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(parsed);
const handle = createHandler({ index: parsed });

// One conversation per section, the way two separate visitors would each have one.
let session = 'spoken-demo-0';
let nextId = 0;

async function rpc(method: string, params: Record<string, unknown>): Promise<Response> {
  return handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++nextId }), method, params }),
    }),
  );
}

/** A tools/call, returned the way the page sees it: the structured result plus isError. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = (await (await rpc('tools/call', { name, arguments: args })).json()) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    error?: { message: string };
  };
  if (!body.result) throw new Error(`${name} failed at the protocol level: ${body.error?.message ?? 'no result'}`);
  return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
}

interface Turn {
  plan: { tool?: string; args?: Record<string, unknown> };
  calls: string[];
  spoken: string;
}

/** Stands for closing and reopening the page: same browser session, page memory gone. */
const RELOAD = Symbol('reload');

async function section(title: string, questions: readonly (string | typeof RELOAD)[]): Promise<void> {
  session = `spoken-demo-${title.toLowerCase().replace(/\W+/g, '-')}`;
  resetContext();
  await loadCatalogue(call);
  console.log(`\n-- ${title} --`);
  for (const q of questions) {
    if (q === RELOAD) {
      // What a reload does to the page: everything it remembered about the
      // conversation is gone, and only the session id kept in localStorage survives.
      resetContext();
      await loadCatalogue(call);
      console.log('\n           (page reloaded: same browser session, the page itself remembers nothing)');
      continue;
    }
    const turn = (await converse(q, call)) as Turn;
    // Where the client already knew the answer from an earlier call (the regions it was
    // told about, the tables in a file), or its own rules say the question cannot be
    // answered, it replies without a call. Printed as such rather than passed off as a
    // server reply.
    const how = turn.plan.tool
      ? `${turn.calls.join(', ')} ${JSON.stringify(turn.plan.args ?? {})}`
      : '(no call: the voice client answered this itself, from its rules and earlier replies)';
    console.log(`\nYou:       ${q}\n           -> ${how}\nLandmark:  ${turn.spoken}`);
  }
}

// The handshake any MCP client performs, so the revision printed is the one negotiated.
const init = (await (
  await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'spoken-demo', version: '1' },
  })
).json()) as { result: { protocolVersion: string; serverInfo: { name: string; version: string } } };
await rpc('notifications/initialized', {});
const listed = (await (await rpc('tools/list', {})).json()) as { result: { tools: { name: string }[] } };

console.log('Landmark, as it speaks. Each reply is the "spoken" field of a real tools/call');
console.log('against the bundled data/index.json, unless the line says no call was made.');
console.log(`\ninitialize: protocol ${init.result.protocolVersion}, ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
console.log(`tools/list: ${listed.result.tools.length} tools: ${listed.result.tools.map((t) => t.name).join(', ')}`);

await section('A budget with merged cells', [
  "what's in the budget file",
  'total amount for engineering',
  'how do you know',
  'total amount for design',
  'how do you know',
  'break it down',
  'which department spent the least',
]);

await section('Highest, and which row it was', ['open the sales table', 'who is the top rep', 'how do you know']);

await section('A sheet holding three tables', [
  'open the three regions file',
  'how many tables are in this file',
  'table 2',
  'total actual',
  'table 3',
  'check the structure',
  'row one is data',
]);

await section('Countries, and what it will not guess', [
  'open the countries table',
  'compare the population of Vietnam and Thailand',
  'what regions are there',
  'total population',
  'break it down',
  'what is the median population',
  'which country is the richest',
]);

await section('A place to come back to', [
  'open the countries table',
  'read the rows',
  'more',
  'save my place',
  RELOAD,
  'carry on',
  'more',
]);
