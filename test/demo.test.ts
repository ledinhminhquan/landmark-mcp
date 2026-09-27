/**
 * The filmed conversation, pinned word for word.
 *
 * The demo video (docs/DEMO-SCRIPT.md) is timed to
 * these exact replies: each one has a 7–8 second slot, and the source-cell graphic is
 * drawn from the cell ranges spoken here. Any change to routing, inference or spoken
 * formatting that alters one of these strings breaks a recorded video, so it must be
 * deliberate and must update the script at the same time.
 *
 * Driven exactly as the page drives it: `route()` picks a tool, the real MCP handler
 * runs it, and `absorb()` folds the reply back into conversation state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createHandler } from '../src/server.ts';
import { assertIndex } from '../src/indexfmt.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { route, absorb, loadCatalogue, context } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(parsed);
const handler = createHandler({ index: parsed });
const SESSION = 'filmed-demo';

async function post(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': SESSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = JSON.parse(await res.text()) as {
    result?: { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
    error?: unknown;
  };
  assert.ok(body.result, `tool ${name} failed at the protocol level: ${JSON.stringify(body.error)}`);
  return body.result.structuredContent ?? {};
}

async function say(utterance: string): Promise<{ tool: string | undefined; spoken: string }> {
  const routed = route(utterance) as { tool?: string; args?: Record<string, unknown>; speak?: string };
  if (!routed.tool) return { tool: undefined, spoken: routed.speak ?? '' };
  const payload = await post(routed.tool, routed.args ?? {});
  absorb(routed.tool, routed.args ?? {}, payload);
  return { tool: routed.tool, spoken: String(payload['spoken'] ?? '') };
}

test('the filmed demo conversation says exactly what the video shows', async () => {
  await loadCatalogue(post);

  // Preparation, before the camera rolls: open the budget.
  const prep = await say("what's in the budget file");
  assert.equal(prep.tool, 'table_describe');
  assert.match(prep.spoken, /^"?FY2026 Departmental Budget"? has 5 rows and 3 columns\./);

  const script: [string, string][] = [
    ['total amount for engineering', '560 thousand. That is the total of Amount across 3 rows.'],
    ['how do you know', 'That came from C3 through C5 on Budget. Each one is Amount.'],
    ['total amount for design', '234 thousand. That is the total of Amount across 2 rows.'],
    ['how do you know', 'That came from C6 through C7 on Budget. Each one is Amount.'],
    ['break it down', 'Engineering, 560 thousand and Design, 234 thousand.'],
  ];
  for (const [utterance, expected] of script) {
    const { spoken } = await say(utterance);
    assert.equal(spoken, expected, `"${utterance}" no longer says what the video shows`);
  }
  assert.equal(context.tableId, '04-title-and-vmerge');
});
