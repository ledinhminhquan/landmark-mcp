/**
 * The demo conversation, driven end to end.
 *
 * Every case here is a sentence from the recorded demo script that did not work when
 * spoken to the real thing. The router had no tests at all, which is how a client that
 * answers the wrong file, sums the wrong column and cannot say "more" shipped as the
 * headline demo.
 *
 * These tests drive the actual server — `route()` picks a tool, the tool runs behind
 * the real MCP handler, and `absorb()` folds the real payload back into conversation
 * state before the next utterance. Hand-written payloads would have agreed with the
 * bugs, because the bugs were in what the client believed the server returned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createHandler } from '../src/server.ts';
import { assertIndex } from '../src/indexfmt.ts';

// @ts-expect-error - the voice client is plain JavaScript, deliberately not compiled.
import { converse, loadCatalogue, context, resetContext } from '../web/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'data', 'index.json'), 'utf8'));
assertIndex(parsed);
const handler = createHandler({ index: parsed });

interface Routed {
  tool?: string;
  args?: Record<string, unknown>;
  speak?: string;
}

/**
 * Call a tool the way the page's client does: the structured payload, with isError.
 * The session header stands in for the per-browser id the real client sends.
 */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'x-landmark-session': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = JSON.parse(await res.text()) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    error?: { message: string };
  };
  assert.ok(body.result, `tool ${name} failed at the protocol level: ${JSON.stringify(body.error)}`);
  return { ...(body.result.structuredContent ?? {}), isError: Boolean(body.result.isError) };
}

/**
 * One turn, exactly as the page takes it: route the utterance, make any quiet
 * preparatory call, run the answering tool for real, absorb the answer.
 */
async function say(utterance: string): Promise<{
  routed: Routed;
  spoken: string;
  payload: Record<string, unknown>;
  calls: string[];
}> {
  const turn = (await converse(utterance, call)) as {
    plan: Routed;
    payload: Record<string, unknown> | null;
    spoken: string;
    calls: string[];
  };
  return { routed: turn.plan, spoken: turn.spoken, payload: turn.payload ?? {}, calls: turn.calls };
}

let session = 'conv-0';
let seq = 0;

/** A fresh conversation: new server-side session, and client memory wiped. */
function reset(): void {
  session = `conv-${++seq}`;
  resetContext();
}

/** A reload: the page forgets everything, the browser keeps its session id. */
async function reload(): Promise<void> {
  resetContext();
  await loadCatalogue(call);
}

/** A fresh conversation, opened the way the app opens one: connect, then catalogue. */
async function start(): Promise<void> {
  reset();
  await loadCatalogue(call);
}

// ── naming a file ───────────────────────────────────────────────────────────

test('"the budget file" opens the budget table, not whichever was first', async () => {
  await start();

  const { routed } = await say("what's in the budget file");

  // The defect: "Budget" is the sheet name, and table_list did not report sheet names,
  // so nothing matched and the router silently described 01-flat instead. Describing
  // the wrong table is worse than failing, because nothing announces it went wrong.
  assert.equal(routed.tool, 'table_describe');
  assert.equal(
    routed.args?.['table_id'],
    '04-title-and-vmerge',
    'asked for the budget file and got a different table',
  );
});

test('a vague name still resolves by title', async () => {
  await start();
  const { routed } = await say('tell me about the countries one');
  assert.equal(routed.args?.['table_id'], '06-countries');
});

test('a word that is merely a substring does not select a table', async () => {
  await start();
  context.tableId = '01-flat';
  // "flatly" contains "flat", but nobody naming a table says it. Substring matching
  // let stray syllables steer the conversation.
  const { routed } = await say('read that back to me flatly');
  assert.notEqual(routed.tool, 'table_list');
});

// ── naming a column ─────────────────────────────────────────────────────────

test('"2025 Q2 revenue" sums the 2025 Q2 column, not another revenue column', async () => {
  await start();
  await say('open the merged header table');

  const { routed, spoken } = await say("what's the total 2025 Q2 revenue");

  // Four columns end in "Revenue": 2026 Q1, 2026 Q2, 2025 Q1, 2025 Q2. Matching on the
  // last path segment made all four equally good and the tie went to the first — a
  // confidently spoken total from the wrong year, which a listener cannot catch.
  assert.equal(routed.tool, 'table_query');
  assert.equal(routed.args?.['aggregate'], 'sum');
  // Compared without commas: the client sends back whatever name describe gave it,
  // and the server may spell a stacked heading either way.
  assert.equal(
    String(routed.args?.['aggregate_column']).replace(/,/g, ''),
    '2025 Q2 Revenue',
    `said: ${spoken}`,
  );
});

test('a bare column name still works when it is unambiguous', async () => {
  await start();
  await say('open 01 flat');
  const { routed } = await say('what is the total revenue');
  assert.equal(routed.args?.['aggregate_column'], 'Revenue');
});

// ── a question that needs one more word ─────────────────────────────────────

test('"total for engineering" uses the only number column instead of asking which', async () => {
  await start();
  await say('open the budget table');

  // The defect: Budget has one column of numbers, and the client still asked "Which
  // column? I have Department, Line item, Amount." — offering two columns that cannot
  // be totalled, and turning the demo's opening question into two turns.
  const { routed, payload } = await say('what is the total for engineering');
  assert.equal(routed.tool, 'table_query', `asked instead: ${routed.speak ?? ''}`);
  assert.equal(routed.args?.['aggregate_column'], 'Amount');
  assert.deepEqual(routed.args?.['filters'], [{ column: 'Department', op: 'eq', value: 'Engineering' }]);
  assert.equal(payload['result'], 560000);
});

test('"total for europe" asks which number column and then remembers the filter', async () => {
  await start();
  await say('open the countries table');

  const ask = await say('what is the total for europe');
  assert.ok(ask.routed.speak, 'two number columns: it should ask which');
  assert.match(ask.routed.speak ?? '', /population/i, 'the question should offer the measures it has');
  assert.doesNotMatch(ask.routed.speak ?? '', /country|region/i, 'text columns cannot be totalled');

  // The follow-up word used to be routed from scratch. "Population" has no aggregate
  // verb in it, so it fell through to describing the table, and the question died.
  const answer = await say('population');
  assert.equal(answer.routed.tool, 'table_query', `follow-up went to ${answer.routed.tool}`);
  assert.equal(answer.routed.args?.['aggregate'], 'sum', 'the aggregate was forgotten');
  assert.equal(answer.routed.args?.['aggregate_column'], 'Population');
  assert.deepEqual(
    answer.routed.args?.['filters'],
    [{ column: 'Region', op: 'eq', value: 'Europe' }],
    'the Europe filter was dropped, so this totals the whole table',
  );
  assert.match(answer.spoken, /42\.2 million/);
});

test('a clarification does not swallow the next real question', async () => {
  await start();
  await say('open the countries table');
  const ask = await say('what is the total for europe');
  assert.ok(ask.routed.speak, 'the clarifying question has to be pending for this to test anything');

  // Changing the subject must abandon the pending question rather than fold the new
  // utterance into it.
  const next = await say('what do I have');
  assert.equal(next.routed.tool, 'table_list');
  assert.equal(context.pending, null, 'the pending question should have been dropped');
});

// ── keep going ──────────────────────────────────────────────────────────────

test('"more" reads the next rows rather than the same ones again', async () => {
  await start();
  await say('open the countries table');

  const first = await say('read me the rows');
  assert.equal(first.routed.tool, 'table_read_rows');
  assert.equal(first.payload['start_row'], 1);
  assert.equal(first.payload['more_available'], true, 'the fixture should have more than one page');

  const second = await say('more');

  // The defect: read_rows returned a cursor and its description told clients to send
  // it back, but the input schema had no cursor field, so it was stripped and the
  // start_row from the first call was replayed. "More" repeated itself forever.
  assert.equal(second.routed.tool, 'table_read_rows');
  assert.equal(second.payload['start_row'], 6, 'the second page started where the first ended');
  assert.notDeepEqual(second.payload['rows'], first.payload['rows']);
});

test('"more" after the last page says so instead of erroring', async () => {
  await start();
  await say('open 01 flat');
  const only = await say('read me the rows');
  assert.equal(only.payload['more_available'], false, '01-flat fits in one page');

  const past = await say('more');
  assert.ok(past.routed.speak, 'with nothing left to continue, it should say so rather than re-read');
  assert.match(past.routed.speak ?? '', /nothing more|that was all|end/i);
});

// ── saving a place ──────────────────────────────────────────────────────────

test('saving a place saves where they actually are', async () => {
  await start();
  await say('open the countries table');
  await say('read me the rows');
  await say('more');

  const saved = await say('save my place');

  // The defect: the client hardcoded row 1, so every bookmark pointed at the top of
  // the table no matter how far in someone had read. The one feature whose whole
  // purpose is not losing your position lost your position.
  assert.equal(saved.routed.tool, 'table_bookmark');
  assert.equal(saved.routed.args?.['row'], 6, `saved row ${String(saved.routed.args?.['row'])}`);
  assert.equal(saved.routed.args?.['table_id'], '06-countries');
});

test('"more" right after saving a place carries on reading', async () => {
  await start();
  await say('open the countries table');
  await say('read me the rows');
  await say('save my place');

  // The defect: the bookmark became the last call, with no cursor, so "more" said
  // "That was all of it" while rows 6 to 8 were still unread.
  const next = await say('more');
  assert.equal(next.routed.tool, 'table_read_rows');
  assert.doesNotMatch(next.spoken, /nothing more to read/);
  assert.equal(next.payload['start_row'], 6, `read from row ${String(next.payload['start_row'])}`);
});

test('resuming returns to the saved place, by name', async () => {
  await start();
  await say('open the countries table');
  await say('read me the rows');
  await say('more');
  await say('save my place');

  const back = await say('where was I');

  // The defect: resume was called with no name, which lists what is saved instead of
  // going anywhere. The demo script answers "carry on" with a list of bookmark names.
  assert.equal(back.routed.tool, 'table_resume');
  assert.equal(back.routed.args?.['name'], 'my place');
  assert.equal(back.payload['row'], 6);
  assert.match(back.spoken, /row 6/);
});

test('resuming with nothing saved says so', async () => {
  await start();
  const back = await say('where was I');
  assert.equal(back.routed.tool, 'table_resume');
  assert.match(back.spoken, /nothing is saved/i);
  // Once, followed by how to save one, rather than the same sentence twice.
  assert.doesNotMatch(back.spoken, /nothing is saved[\s\S]*nothing is saved/i, back.spoken);
  assert.match(back.spoken, /save your place/i, back.spoken);
});

// ── resuming after a reload ─────────────────────────────────────────────────

test('"carry on" after a reload goes back to the saved row, and "more" reads on from it', async () => {
  await start();
  await say('open the countries table');
  await say('read me the rows');
  await say('more');
  await say('save my place');

  // The defect: the page forgot the bookmark's name on reload, sent resume with no
  // name, and the server listed "You have my place." forever instead of going there.
  await reload();
  const back = await say('carry on');
  assert.equal(back.routed.tool, 'table_resume');
  assert.equal(back.routed.args?.['name'], 'my place');
  assert.match(back.spoken, /row 6/);

  const next = await say('more');
  assert.equal(next.routed.tool, 'table_read_rows', 'resuming is the start of reading on');
  assert.match(String((next.payload['rows'] as string[] | undefined)?.[0] ?? ''), /^Peru/);
});

// ── filters that were silently dropped ──────────────────────────────────────

test('"how many countries are in Europe" counts Europe, from the countries table, and says which table', async () => {
  await start();
  // The defect: switching tables cleared the columns and skipped describing, so the
  // filter could not be recognised and "8 rows match" was spoken where the answer is 2.
  const { routed, payload, spoken } = await say('how many countries are in Europe');
  assert.equal(routed.args?.['table_id'], '06-countries');
  assert.deepEqual(routed.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'Europe' }]);
  assert.equal(payload['result'], 2);
  assert.match(spoken, /countries/i, 'moving to another file must be said out loud');
});

test('"how many rows in the budget are engineering" counts the engineering rows', async () => {
  await start();
  const { payload } = await say('how many rows in the budget are engineering');
  assert.equal(payload['result'], 3);
});

test('"how many departments" counts departments, not rows', async () => {
  await start();
  await say('open the budget table');
  const { routed, payload } = await say('how many departments');
  assert.equal(routed.args?.['group_by'], 'Department');
  assert.equal((payload['groups'] as unknown[]).length, 2);
});

test('a value that is not in the table is asked about, never dropped into a grand total', async () => {
  await start();
  await say('open the budget table');

  const ask = await say('total amount for engineeringg');
  assert.ok(ask.routed.speak, 'a misheard department must not become the total of everything');
  assert.match(ask.spoken, /could not find "engineeringg"/i);
  assert.match(ask.spoken, /departments are (Design and Engineering|Engineering and Design)/);

  // Naming the right value finishes the question that was asked.
  const fixed = await say('engineering');
  assert.equal(fixed.payload['result'], 560000);
});

test('a plural still finds the value it names', async () => {
  await start();
  await say('open the budget table');
  const { payload } = await say('total amount for designs');
  assert.equal(payload['result'], 234000);
});

test('"total revenue for north" never answers with the whole table', async () => {
  await start();
  await say('open the flat one');
  const { routed, payload } = await say('total revenue for north');
  // Region in this sample holds three values over five rows. Servers that list those
  // values let the filter through; older ones do not, and then the only honest reply
  // is a question. What must never happen is 61.1 thousand, the total of everything.
  if (routed.tool === 'table_query') {
    assert.deepEqual(routed.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'North' }]);
    assert.equal(payload['result'], 20550);
  } else {
    assert.match(routed.speak ?? '', /could not find "north"/i);
  }
});

test('"total revenue for an" answers for the rep called An', async () => {
  await start();
  await say('open the flat one');
  const rep = (context.columns as { name: string; categories?: string[] }[]).find((c) => c.name === 'Rep');
  // An index that lists the reps' names lets the router find An; one that lists none
  // leaves nothing to match, which test/client-values.test.ts covers with a table whose
  // reps are listed in every version.
  if (!rep?.categories?.includes('An')) return;
  for (const q of ['total revenue for an', 'how much did An sell']) {
    const { routed, payload, spoken } = await say(q);
    assert.deepEqual(routed.args?.['filters'], [{ column: 'Rep', op: 'eq', value: 'An' }], `"${q}" said: ${spoken}`);
    assert.equal(payload['result'], 15600);
  }
});

// ── which table a question is about ─────────────────────────────────────────

test('"how many regions" with the countries table open stays in the countries table', async () => {
  await start();
  await say('open the countries table');
  // The defect: "regions" also names the file "05 three regions", and the router
  // switched to it silently and answered "2 rows match". The countries table has 4.
  const { routed, payload } = await say('how many regions');
  assert.equal(routed.args?.['table_id'], '06-countries');
  assert.equal(routed.args?.['group_by'], 'Region');
  assert.equal((payload['groups'] as unknown[]).length, 4);
});

test('"how many regions are in the countries table" answers from the countries table', async () => {
  await start();
  const { routed, payload } = await say('how many regions are in the countries table');
  assert.equal(routed.args?.['table_id'], '06-countries');
  assert.equal((payload['groups'] as unknown[]).length, 4);
});

test('a column of the open table is not taken as the name of another file', async () => {
  await start();
  await say('open the flat one');
  const { routed } = await say('how many regions');
  assert.equal(routed.args?.['table_id'], '01-flat');
});

test('a question with no table open asks which file, then answers it', async () => {
  await start();
  // The page opens on the first file without anyone choosing it. The old reply here was
  // "Open a table first — say, what do I have", which changed nothing when followed.
  const ask = await say('what is the total revenue');
  assert.match(ask.routed.speak ?? '', /^Which file\?/);
  assert.match(ask.routed.speak ?? '', /01 flat/);

  const answer = await say('the flat one');
  assert.equal(answer.payload['result'], 61050);
  assert.match(answer.spoken, /^In 01 flat\./);
});

// ── phrasings that aggregated the wrong column ──────────────────────────────

test('"which country has the highest population" ranks countries by population', async () => {
  await start();
  await say('open the countries table');
  const { routed, payload } = await say('which country has the highest population');
  assert.equal(routed.args?.['group_by'], 'Country');
  assert.equal(routed.args?.['aggregate_column'], 'Population');
  assert.equal((payload['groups'] as { key: string }[])[0]?.key, 'Indonesia');
});

test('"which rep has the most revenue" ranks reps by revenue', async () => {
  await start();
  await say('open the flat one');
  const { routed, payload } = await say('which rep has the most revenue');
  assert.equal(routed.args?.['group_by'], 'Rep');
  assert.equal((payload['groups'] as { key: string }[])[0]?.key, 'Chi');
});

test('"total amount by department" breaks the amount down by department', async () => {
  await start();
  await say('open the budget table');
  const { routed, spoken } = await say('total amount by department');
  assert.equal(routed.args?.['aggregate_column'], 'Amount');
  assert.equal(routed.args?.['group_by'], 'Department');
  assert.match(spoken, /Engineering, 560 thousand/);
});

test('naming the department column beside a value still totals the amount', async () => {
  await start();
  await say('open the budget table');
  for (const q of ['total amount for the engineering department', 'how much did engineering spend']) {
    const { payload, spoken } = await say(q);
    assert.equal(payload['result'], 560000, `"${q}" said: ${spoken}`);
  }
});

test('"GDP per capita" is a column, not a request to group per something', async () => {
  await start();
  await say('open the countries table');

  const avg = await say('what is the average GDP per capita');
  assert.equal(avg.routed.args?.['aggregate'], 'avg');
  assert.match(String(avg.routed.args?.['aggregate_column']), /gdp per capita/i);
  assert.equal(avg.routed.args?.['group_by'], undefined);

  // As the reply to a clarifying question it used to trigger "per" grouping and answer
  // with population by region.
  const ask = await say('what is the highest');
  assert.ok(ask.routed.speak);
  const reply = await say('gdp per capita');
  assert.equal(reply.routed.args?.['aggregate'], 'max');
  assert.match(String(reply.routed.args?.['aggregate_column']), /gdp per capita/i);
  assert.equal(reply.routed.args?.['group_by'], undefined);
});

test('"total population by region" groups instead of dropping "by region"', async () => {
  await start();
  await say('open the countries table');
  const { routed } = await say('total population by region');
  assert.equal(routed.args?.['group_by'], 'Region');
});

test('equally good columns are asked about, and the question never speaks commas', async () => {
  await start();
  await say('open the merged header table');

  // Four columns share "Revenue". The first used to be picked silently.
  const tie = await say('total revenue');
  assert.match(tie.routed.speak ?? '', /^Which one:/);
  assert.doesNotMatch(tie.routed.speak ?? '', /\d, Q\d/, 'column names are spoken without commas');

  const pick = await say('2025 q1');
  assert.equal(String(pick.routed.args?.['aggregate_column']).replace(/,/g, ''), '2025 Q1 Revenue');

  const which = await say('what is the highest');
  assert.match(which.routed.speak ?? '', /^Which column\? I have 2026 Q1 Revenue, /);
  assert.doesNotMatch(which.routed.speak ?? '', /Region/, 'only columns of numbers can be the answer');
});

test('"which country has the lowest population" asks for the lowest row, not a list largest first', async () => {
  await start();
  await say('open the countries table');
  // Grouped, the first country heard was the most populous — the opposite of the
  // question — and past one page the least populous was not said at all.
  const { routed, spoken } = await say('which country has the lowest population');
  assert.equal(routed.args?.['aggregate'], 'min');
  assert.equal(routed.args?.['group_by'], undefined);
  assert.match(spoken, /5\.5 million/);
});

test('"which region has the lowest population" starts with the lowest', async () => {
  await start();
  await say('open the countries table');
  const { routed, spoken } = await say('which region has the lowest population');
  assert.equal(routed.args?.['group_by'], 'Region');
  assert.equal(routed.args?.['order'], 'asc');
  assert.match(spoken, /^Lowest first: Americas, about 34\.4 million, Europe, /);
});

test('a column that is not a number is asked about as named, never swapped for Revenue', async () => {
  await start();
  await say('open the flat one');
  // 01 flat has one number column, and "the highest closed" used to answer the highest
  // Revenue under a sentence that sounded right.
  const { routed, payload, spoken } = await say('what is the highest closed');
  assert.equal(routed.args?.['aggregate_column'], 'Closed');
  assert.equal(payload['isError'], true);
  assert.match(spoken, /Revenue/, 'the refusal names the column that can be used');
});

test('"list the countries in Africa" lists those rows, not the files', async () => {
  await start();
  await say('open the countries table');
  const { routed, payload } = await say('list the countries in Africa');
  assert.equal(routed.tool, 'table_query');
  assert.equal(routed.args?.['aggregate'], 'none');
  assert.deepEqual(routed.args?.['filters'], [{ column: 'Region', op: 'eq', value: 'Africa' }]);
  assert.equal(payload['isError'], false);
});

test('a number and a value with no aggregate word is answered', async () => {
  await start();
  await say('open the budget table');
  const amount = await say('what is the amount for engineering');
  assert.equal(amount.payload['result'], 560000, `said: ${amount.spoken}`);
  // And the same question again, for another value.
  const design = await say('what about design');
  assert.equal(design.payload['result'], 234000, `said: ${design.spoken}`);
});

test('a new request after "Which file?" is answered as itself', async () => {
  await start();
  const ask = await say('what is the total revenue');
  assert.match(ask.spoken, /^Which file\?/);
  // It names a file, but it asks what is in it. It used to be taken as the answer, and
  // "revenue" was looked for in the budget.
  const { routed, spoken } = await say("what's in the budget file");
  assert.equal(routed.tool, 'table_describe');
  assert.equal(routed.args?.['table_id'], '04-title-and-vmerge');
  assert.doesNotMatch(spoken, /could not find/i);
});

test('"break it down" breaks down the figure just given, in a table with two number columns', async () => {
  await start();
  await say('open the countries file');
  await say('total population');

  // The defect: only "what about…" phrases shared the last measure, so in a table with
  // two number columns this was answered "Which column?" right after the total.
  const down = await say('break it down');
  assert.equal(down.routed.tool, 'table_query', down.routed.speak);
  assert.equal(down.routed.args?.['aggregate_column'], 'Population');
  assert.equal(down.routed.args?.['aggregate'], 'sum');
  assert.equal(down.routed.args?.['group_by'], 'Region');
  assert.match(down.spoken, /^Asia, about 449\.7 million, Africa, about 278\.9 million/);

  // An average breaks down as averages, and naming the group still works.
  await say('average gdp per capita');
  const avg = await say('break down the average by region');
  assert.equal(avg.routed.args?.['aggregate_column'], 'GDP per capita (usd)');
  assert.equal(avg.routed.args?.['aggregate'], 'avg');
  // Named as averages, so they are not heard as totals.
  assert.match(avg.spoken, /^Average GDP per capita \(usd\): Europe, about 55 thousand, Americas, 7126/);

  // Anything else with no column named still asks, rather than borrowing one.
  const which = await say('what is the highest');
  assert.match(which.routed.speak ?? '', /^Which column\?/);
});

test('"break it down" says so when there is nothing to group by, rather than describing', async () => {
  await start();
  await say('open the stacked header table');
  const { routed } = await say('break it down');
  assert.match(routed.speak ?? '', /cannot break this table down/i);
});

// ── describing and correcting ───────────────────────────────────────────────

test('"tell me more about it" gives the full description, not "that was all of it"', async () => {
  await start();
  await say('describe the budget one');
  const { routed } = await say('tell me more about it');
  assert.equal(routed.tool, 'table_describe');
  assert.equal(routed.args?.['detail'], 'full');
});

test('the structure can be checked, confirmed and corrected by voice', async () => {
  await start();
  await say('open the budget table');

  // "Check the structure" is the phrase describe tells a listener to say, and it used
  // to describe the table again.
  const check = await say('check the structure');
  assert.equal(check.routed.tool, 'table_structure');
  assert.equal(check.routed.args?.['header_rows'], undefined, 'checking must not change anything');

  const yes = await say("yes, that's right");
  assert.equal(yes.routed.tool, 'table_structure');
  assert.equal(yes.routed.args?.['header_rows'], check.payload['header_rows']);

  const none = await say('the first row is data');
  assert.equal(none.routed.args?.['header_rows'], 0);

  const one = await say('use one heading row');
  assert.equal(one.routed.args?.['header_rows'], 1);

  // Every later question is asked of the corrected reading, with its columns relearned.
  const total = await say('total amount for engineering');
  assert.equal(total.payload['result'], 560000);
});
