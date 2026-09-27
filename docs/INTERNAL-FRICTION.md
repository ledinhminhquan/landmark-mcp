# Internal friction — our own defects, and what became of them

Updated September 27, 2026. Everything here is Landmark's own doing. None of it is a complaint
about Amazon, Cloudflare, Node or MCP, and none of it belongs in the vendor
[friction log](FRICTION-LOG.md).

Two reviews found these. The first, on September 12, reproduced seventeen defects against the
commit then published (`60dc188`), plus one conditional number-format probe; those eighteen are
listed below with what happened to each. The second, on September 27, was much wider; a
selection of what it found and what was fixed follows them. Every "fixed" below names the test
that now fails if the defect comes back. In this build 439 tests pass and `npm run typecheck` is
clean.

Evidence for the first review: [module results](feedback-evidence/a5-reproduction-results.json),
[runtime results](feedback-evidence/a5-runtime-results.json) and the
[dependency audit of that day](feedback-evidence/a5-npm-audit.json). No real user data,
microphone, deployed Worker, Alexa device or simulator was involved in either review.

## At a glance

| # | Defect found on September 12 | Status on September 27 |
|---:|---|---|
| 1 | An all-text table lost two of its three records | Fixed |
| 2 | "2025 Q2 revenue" summed the wrong year's column | Fixed |
| 3 | Explaining a comparison named only one side's source | Fixed |
| 4 | Answer ids collided across stores | Fixed |
| 5 | Callers shared bookmarks | Fixed for the voice client and standard MCP clients; callers that send no session header still share one conversation, by design |
| 6 | The Worker did not serve the voice page | Fixed |
| 7 | A foreign Origin was accepted | Fixed |
| 8 | "The budget file" opened the wrong table | Fixed |
| 9 | "Total for engineering" stalled on a clarifying question | Fixed |
| 10 | "More" repeated the same rows | Fixed |
| 11 | Saving a place saved row 1; resuming did not go back | Fixed |
| 12 | Bookmarks did not survive a restart | Fixed on the Worker; the local server still keeps state in memory |
| 13 | A grouped count came back empty; its explanation named no rows | Fixed |
| 14 | The MCP Apps widget never completed its handshake | Fixed in a simulated host; not tried in a real one |
| 15 | The page's client could not read a valid event stream | Fixed |
| 16 | `npm start` failed on a clean checkout | Fixed |
| 17 | The security notes missed three high advisories | Fixed |
| 18 | "1.234,56" was read as 1.23456 | Fixed |

## The eighteen cases from September 12

### 1. Preserve the records of an all-text table

**Task attempted.** Keep every record of a table whose cells are all text.
**Steps taken.** Ingested `Name, City` followed by Alice/Paris, Bob/London, Cara/Rome
(case `allTextHeader`).
**Expected vs actual.** Expected three records; only Cara/Rome remained, the other rows taken as
headings, with confidence 1.
**Severity rating.** High.
**Workaround used.** None at the time; the demo used a numeric budget.
**Actionable suggestion.** Keep every record, and admit when the heading reading is uncertain.
**Status: fixed.** All three records are kept, and a table like this is reported as uncertain
with its other possible reading offered. `test/structure.test.ts`: "a labelled all-text table
keeps every record"; "an all-text table admits it cannot be sure, and says what else it could
be".

### 2. Resolve a fully qualified revenue column

**Task attempted.** Total "2025 Q2 revenue" in a table with four Revenue columns under year and
quarter headings (case `mergedColumnRouting`).
**Steps taken.** Routed the question with filename matching disabled to isolate column choice.
**Expected vs actual.** Expected 1850 from the 2025 Q2 column; got 2100 from 2026 Q1. A
comparison question also failed to become a comparison.
**Severity rating.** High.
**Workaround used.** The demo avoided the multi-year table.
**Actionable suggestion.** Match the whole heading path, and ask when candidates tie.
**Status: fixed.** On September 27, "total 2025 q2 revenue" answered "1850. That is the total of
2025 Q2 Revenue across 2 rows.", and "compare 2026 q1 revenue and 2025 q1 revenue" answered
"2026 Q1 Revenue is 200 more than 2025 Q1 Revenue, about 11%: 2100 against 1900."
`test/conversation.test.ts`: "\"2025 Q2 revenue\" sums the 2025 Q2 column, not another revenue
column".

### 3. Explain both sides of a comparison

**Task attempted.** Ask where a cross-sheet comparison came from (case `crossSheetProvenance`).
**Steps taken.** Compared revenue on two sheets, then asked for the explanation.
**Expected vs actual.** The difference was right; the explanation kept only the left side's
sheet.
**Severity rating.** High.
**Workaround used.** The demo explained single-sheet answers only.
**Actionable suggestion.** Store the table, sheet and cells of each side.
**Status: fixed.** Each side is explained separately, for example "2026 Q1 Revenue came from B4
through B5 on Compare. 2025 Q1 Revenue came from D4 through D5 on Compare."
`test/engine-tools.test.ts`: "same-named measures in different files are told apart, and cents
compare equal"; "explain lights every counted cell, and keeps the grid out of the model's text".

### 4. Keep answer ids unique across stores

**Task attempted.** Store answers from two store instances sharing one backing store (case
`kvCollision`).
**Steps taken.** Two stores over one in-memory key-value double, one answer each.
**Expected vs actual.** Both answers got id `a1`, and the second overwrote the first.
**Severity rating.** High.
**Workaround used.** Nothing was deployed.
**Actionable suggestion.** Globally unique ids.
**Status: fixed.** Ids are `a<n>-` plus 64 random bits, and the key-value store is gone.
`test/isolation.test.ts`: "answer ids from separate stores do not collide".

### 5. Keep callers' bookmarks apart

**Task attempted.** Two callers saving and resuming the same bookmark name (case
`sharedBookmarks`).
**Steps taken.** Synthetic callers A and B against one handler.
**Expected vs actual.** B could read A's note and move the place A later resumed.
**Severity rating.** High.
**Workaround used.** None.
**Actionable suggestion.** Key state to its owner.
**Status: fixed for real clients.** State is kept per conversation. The voice page keeps one
random id per browser and sends it on every request; the server issues an `Mcp-Session-Id` on
every `initialize`, which standard MCP clients echo. A caller that sends neither, such as a bare
`curl`, still shares one in-memory conversation with other such callers. There is no
authentication, so this is isolation, not access control (see
[SECURITY-NOTES.md](SECURITY-NOTES.md)). `test/isolation.test.ts`: "two conversations do not
share bookmarks"; `test/client-session.test.ts`: "two browsers do not see each other's saved
place"; `test/transport.test.ts`: "two SDK clients are isolated from each other with no
configuration at all".

### 6. Serve the voice page from the Worker

**Task attempted.** Open the deployment's own URL in a browser (case `workerAssets`).
**Steps taken.** Called the Worker's `fetch` for `/` and `/app.js`.
**Expected vs actual.** `/` returned 406 JSON and `/app.js` 404; only the local Node server served
the page.
**Severity rating.** High.
**Workaround used.** The demo was planned on the local server.
**Actionable suggestion.** Configure static assets beside the MCP route.
**Status: fixed.** `wrangler.jsonc` serves `web/` as assets and sends `/mcp` and `/health` to the
Worker first. Checked by request under `wrangler dev --local` on September 27: `/` returned 200
`text/html` and `/app.js` 200. No automated test, because the Worker entry imports
`cloudflare:workers`, which Node tests cannot load.

### 7. Refuse an untrusted Origin

**Task attempted.** Send a request with `Origin: https://untrusted.invalid` (case
`invalidOrigin`).
**Steps taken.** POSTed `tools/list` to the handler as configured by default.
**Expected vs actual.** Expected 403; got 200. The check existed only when an allow-list was
set, and none was.
**Severity rating.** High.
**Workaround used.** None.
**Actionable suggestion.** Check Origin in the handler, and bind the local server to loopback.
**Status: fixed.** A present, foreign Origin gets 403 with no configuration; the local server
binds to 127.0.0.1 and checks `Host`. `test/isolation.test.ts`: "with no configuration at all, a
foreign Origin is refused and the own origin served"; "with a host allowlist, a rebinding-shaped
request is refused".

### 8. Open the table a question names

**Task attempted.** "What's in the budget file" with the default catalogue (case
`demoBudgetSelection`).
**Steps taken.** Routed the question; also routed a question containing a year.
**Expected vs actual.** The description stayed on the sales table; a year also matched a
numbered file name and switched tables.
**Severity rating.** High.
**Workaround used.** The demo opened the budget with another phrase.
**Actionable suggestion.** Match whole words and table titles; ignore file-number tokens.
**Status: fixed.** It is now the demo's preparation line. `test/conversation.test.ts`: "\"the
budget file\" opens the budget table, not whichever was first"; "a word that is merely a
substring does not select a table"; "\"2025 Q2 revenue\" sums the 2025 Q2 column, not another
revenue column" (a year in the question no longer switches files); `test/demo.test.ts`.

### 9. Answer "total for engineering" in one turn

**Task attempted.** Describe the budget, then ask "total for engineering" (case
`demoEngineering`).
**Steps taken.** Routed both through the page's router.
**Expected vs actual.** Expected 560 thousand; got "Which column?", and the pending question was
lost on the next turn.
**Severity rating.** High.
**Workaround used.** The demo said "total amount for engineering".
**Actionable suggestion.** Use the only number column when there is one; keep a pending question
until it is answered.
**Status: fixed.** "Total for engineering" now answers "560 thousand. That is the total of Amount
across 3 rows." `test/conversation.test.ts`: "\"total for engineering\" uses the only number
column instead of asking which"; "a clarification does not swallow the next real question".

### 10. Continue to the next rows

**Task attempted.** Read two rows, then say "more" (case `rowPagination`).
**Steps taken.** Sent the router's continuation with its cursor.
**Expected vs actual.** The schema dropped the cursor and the same rows were read again.
**Severity rating.** High.
**Workaround used.** The demo avoided reading rows.
**Actionable suggestion.** Make the schema, the description and the client agree on the cursor.
**Status: fixed.** `test/conversation.test.ts`: "\"more\" reads the next rows rather than the
same ones again"; "\"more\" after the last page says so instead of erroring";
`test/engine-tools.test.ts`: "read_rows never moves the cursor past a row it did not speak".

### 11. Save and restore a reading position

**Task attempted.** Save a place partway through a table, then "carry on" (case
`bookmarkRouting`).
**Steps taken.** Routed "save my place" at row 3, then "carry on".
**Expected vs actual.** The save recorded row 1; resuming listed bookmark names instead of going
back.
**Severity rating.** High.
**Workaround used.** The demo dropped the bookmark scene.
**Actionable suggestion.** Save the real position and resume by name.
**Status: fixed.** A save records the first row of the page most recently read, and resuming
always goes by name, including after a reload. `test/conversation.test.ts`: "saving a place
saves where they actually are"; "\"carry on\" after a reload goes back to the saved row, and
\"more\" reads on from it"; "resuming with nothing saved says so".

### 12. Keep a bookmark across a restart

**Task attempted.** Save, build a new handler, resume (case `restartPersistence`).
**Steps taken.** A simulated restart with the default store.
**Expected vs actual.** Nothing survived.
**Severity rating.** High.
**Workaround used.** No persistence was claimed.
**Actionable suggestion.** Durable storage, tested across a restart.
**Status: fixed on the Worker only.** With both Durable Object bindings, conversations and
answers live in SQLite Durable Objects, and a restart of `wrangler dev` with the same
`--persist-to` directory kept them (end-to-end check, September 27). The local Node server still
keeps everything in memory and loses it on restart.
`test/store.test.ts`: "state outlives the object holding it: a recreated object carries on";
"with durable state, a second isolate sees the first one's work, and conversations stay apart".

### 13. Count by group and explain a count

**Task attempted.** A count grouped by Region, then an explanation of a count (cases
`groupedCount`, `countExplain`).
**Steps taken.** Called the tools directly.
**Expected vs actual.** A total of 5 with no groups; the explanation named 0 of 5 rows and one
cell.
**Severity rating.** Medium.
**Workaround used.** The demo used sums.
**Actionable suggestion.** Implement grouped counts; explain a count by its rows.
**Status: fixed.** `test/engine-query.test.ts`: "grouped dates are spoken as dates, not ISO
strings" (a grouped count); `test/engine-tools.test.ts`: "a count is explained by the rows it
counted, not by a column it ignored".

### 14. Deliver a result to the MCP Apps widget

**Task attempted.** Run the widget's script against a host's messages (case `widgetProtocol`).
**Steps taken.** A DOM and message double dispatching a standard tool-result notification.
**Expected vs actual.** No initialisation was sent and the widget stayed on its waiting text.
**Severity rating.** Medium.
**Workaround used.** The demo uses an editorial graphic, labelled as such.
**Actionable suggestion.** Implement the handshake and verify in a real host.
**Status: fixed in a simulated host; not tried in a real one.** `test/engine-widget.test.ts`: "an
accepted handshake is announced, and the host theme wins"; "teardown and ping are answered, so
the host is not left waiting"; "only the host frame can put an explanation on screen". The demo
video still does not show the widget.

### 15. Read a valid event stream in the page's MCP client

**Task attempted.** Feed the page's client an event stream with a keep-alive before the reply
(case `validSsePriming`).
**Steps taken.** A standards-shaped fixture, not a live server.
**Expected vs actual.** "Unexpected end of JSON input".
**Severity rating.** Medium.
**Workaround used.** The server answers with plain JSON.
**Actionable suggestion.** Parse event streams properly and match the reply's id.
**Status: fixed.** `test/wire.test.ts`: "the browser client reads an event stream rather than its
first line".

### 16. Start the compiled package

**Task attempted.** `npm start` on a clean checkout (build/start record).
**Steps taken.** Built, then started.
**Expected vs actual.** The build passed; start failed because nothing had been compiled to the
path it ran.
**Severity rating.** Medium.
**Workaround used.** `npm run serve`.
**Actionable suggestion.** Align the entry points and test the published command.
**Status: fixed.** `npm start` now runs `npm run build` first (`prestart`), then
`dist/src/local.js`. Checked in the September 27 end-to-end run: it built, then served. No
automated test.

### 17. Keep the security notes true to the dependency tree

**Task attempted.** Compare `docs/SECURITY-NOTES.md` with that day's `npm audit`.
**Steps taken.** Read the lockfile, the audit and the notes together.
**Expected vs actual.** The notes mentioned two moderate entries; the audit also had three high
ones, all one development-only chain.
**Severity rating.** Medium.
**Workaround used.** None then.
**Actionable suggestion.** Fix what can be fixed, and regenerate the notes from the audit.
**Status: fixed.** The high chain was removed by upgrading `wrangler`, and on September 27
`npm audit` reports 2 moderate, 0 high, as the notes now say.

### 18. Read a comma-decimal number without changing its value

**Task attempted.** Read "1.234,56" (case `localeNumber`, a conditional probe: the expected value
assumes a decimal comma).
**Steps taken.** Called the number reader directly.
**Expected vs actual.** Got 1.23456 where a decimal-comma source means 1234.56.
**Severity rating.** Medium, where such files occur (Vietnamese and many European ones do).
**Workaround used.** The demo data is already numeric.
**Actionable suggestion.** Read the convention the text shows, and say so when it cannot be told.
**Status: fixed.** "1.234,56" now reads as 1234.56, "1,5" as 1.5 and "45.000 ₫" as 45000. A
string that could be either, like "1.234", keeps its old reading unless the rest of the column
settles it, and a column that cannot be told is reported in a warning.
`test/ingest-values.test.ts`: "a number is read by the convention its own text shows"; "one
stray value does not set the convention for a whole file"; "a column whose convention cannot be
told says so".

## Found on September 27 and fixed in this build

The second review found about two hundred verified defects across ingest, the query engine, the
server and the page. A selection, most serious first:

| Defect | Now | Test |
|---|---|---|
| The page sent no session id, so every visitor shared one state, and a stranger's heading correction changed the demo's answer | One id per browser, sent on every request; the server issues ids to MCP clients | `test/client-session.test.ts`: "every request carries one per-browser session id, and a reload keeps it" |
| GET on `/mcp` returned a stream that closed at once, and SDK clients reconnected every second | 405 with `Allow: POST` | `test/transport.test.ts`: "an idle SDK client asks for an event stream once and then leaves it alone" |
| No limit on request size or batches | 413 over 1 MB; batches 400; tool inputs bounded | `test/transport.test.ts`; `test/engine-tools.test.ts`: "inputs are bounded" |
| The demo script on file failed when followed, and nothing pinned the filmed conversation | Script rewritten against the build; the five exchanges are pinned | `test/demo.test.ts` |
| Spoken filters were dropped silently, giving confident totals for everyone ("total for north") | A value the table has becomes a filter; one it lacks is asked about | `test/conversation.test.ts`: "\"total revenue for north\" never answers with the whole table"; "a value that is not in the table is asked about, never dropped into a grand total" |
| Highest and lowest never said which row | The winner is named ("21 thousand, for Chi.") | `test/judge-questions.test.ts`: "\"the most reps\" counts reps; \"the top rep\" is the rep with the highest figure" |
| "Which has the least" was read largest first | Lowest first, and said so | `test/judge-questions.test.ts`: "\"the least\" is asked lowest first, and the lowest is heard first" |
| A "Total" row was counted as a record | Left out of counts, listings and groups, and said | `test/engine-query.test.ts`: "a Total row is not a record: counts, listings and groups leave it out" |
| Heading paths were spoken with commas ("2026, Q1, Revenue") in comparisons and rows | "2026 Q1 Revenue" everywhere | `test/engine-tools.test.ts`: "no spoken sentence runs a heading path together with commas" |
| Dates showed a day early west of UTC | Dates are read and shown in UTC | `test/engine-widget.test.ts`: "dates are shown as the day they are, west of UTC"; the suite also passes under America/Los_Angeles, Pacific/Kiritimati and Asia/Ho_Chi_Minh |
| Identifier columns (codes, phone numbers) were spoken as amounts | Kept as text | `test/ingest-values.test.ts`: "identifier columns are text, whatever digits they hold" |
| Arguments the schema refused came back with nothing to say | A spoken refusal with a next step | `test/integration.test.ts`: "arguments the schema refuses are spoken like any other failure" |
| In PowerShell, `npm run ingest -- … --out=<path>` overwrote the demo's own index | The path is honoured, or nothing is written | `test/ingest-cli.test.ts`: "an --out that npm kept for itself still decides where the index goes" |
| "Break it down" after "total population" asked "Which column?" | It breaks down the figure just given | `test/conversation.test.ts`: "\"break it down\" breaks down the figure just given, in a table with two number columns" |
| "Carry on" with nothing saved said "Nothing is saved" twice | Said once, with how to save | `test/conversation.test.ts`: "resuming with nothing saved says so" |

Two page fixes have no automated test, because the page's own script is inline in
`web/index.html`: the status ring now returns to "Ready" after each answer instead of staying on
"Speaking", and the conversation scrolls inside its panel instead of pushing the newest answer
below the fold. The second was checked in the page at 1280×720 on September 27.

## Found on September 28 and fixed in this build

A last check asked new questions and fed new workbook shapes through the build. Each of these
gave a wrong figure with nothing in the sentence to show it:

| Defect | Now | Test |
|---|---|---|
| "Not in August", "don't have a population over 50 million" answered for the opposite rows | The condition is turned around | `test/judge-questions.test.ts`: "a negation before a month or a number condition leaves those rows out" |
| "On or after August 2" was after; "up to August 27" was that day alone | Inclusive and open bounds are read; a day with no side said is asked about | `test/judge-questions.test.ts`: "inclusive and open-ended date bounds keep the day they name" |
| "What about the average" after Engineering's total averaged every department | A follow-up keeps the rows it was about, unless it names new ones | `test/judge-questions.test.ts`: "a follow-up that changes the figure keeps the rows it was about" |
| "Highest amount for engineering and design" gave each one's total | Each one's highest, labelled | `test/judge-questions.test.ts`: "the highest or lowest of two named values is each one's highest, not its total" |
| "Which region has the most deals" gave revenue totals | Deals are counted; "the most sales" is asked | `test/judge-questions.test.ts`: "\"the most deals\" counts deals; \"the most sales\" is asked" |
| An Excel formula whose saved result was 0 or FALSE was read as empty | The saved result is kept | `test/ingest-xlsx.test.ts`: "a formula whose saved result is 0 or FALSE keeps it, and is not called unsaved" |
| "Total Expenses", "TOTAL EXPENSES", "Tổng doanh thu" were counted as records | Left out, once their figures add up the rows above | `test/ingest-values.test.ts`: "a total named for what it adds up is a total, when its figures add up" |
| The shorter of two side-by-side tables took the longer one's rows | Each keeps its own | `test/ingest-layout.test.ts`: "side-by-side tables of different lengths each keep only their own rows" |
| A PivotTable's year row was read as a record | Both heading rows are read | `test/ingest-layout.test.ts`: "an Excel PivotTable is read with both of its heading rows" |
| "Source: \| text" under a table was a record, and made its number column untotalable | Kept as a note | `test/ingest-layout.test.ts`: "a \"Source:\" line with its text beside it, or a sentence under a number column, is a note" |

## Toolchain: TypeScript checking and Node's type stripping disagree

**Task attempted.** Run the project's TypeScript directly with Node 23.11's
`--experimental-strip-types`. Our own toolchain configuration; this used to sit in the vendor
friction log, but no vendor has anything to fix. Reproduced September 13.
**Steps taken.** Imported a class with a constructor parameter property, and checked whether the
installed TypeScript accepts `--erasableSyntaxOnly`.
**Expected vs actual.** Expected the compiler to catch syntax the runtime rejects. Node raised
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`; TypeScript 5.7.2 does not know `--erasableSyntaxOnly`.
Node's own documentation already recommends TypeScript 5.8 or later with that option.
[Node documentation](https://nodejs.org/docs/latest-v23.x/api/typescript.html);
[results](feedback-evidence/legacy-probe-results.json).
**Severity rating.** Low.
**Workaround used.** The code avoids parameter properties (for example `QueryError.nextStep` is a
declared field assigned in the constructor), and `package.json` requires Node 22.7 or later (22.6.0,
the first release with type stripping, cannot parse a typed private field; checked in CI). TypeScript is still 5.7.2.
**Actionable suggestion.** Upgrade to TypeScript 5.8 or later and turn on
`erasableSyntaxOnly`.

A related testing note, checked September 27: in Git Bash on Windows, `TZ=America/Los_Angeles`
set on the command line did not reach Node, which kept the machine's own zone. In PowerShell,
`$env:TZ = 'Pacific/Kiritimati'; npm test` did reach it, and all 426 tests passed. The
cross-time-zone runs for this build were made with a small preload that sets `process.env.TZ`.

## Still open

- **No authentication and no rate limiting.** See [SECURITY-NOTES.md](SECURITY-NOTES.md).
- **The local server forgets everything on restart.** Only the Worker keeps state durably.
- **For MCP hosts, bookmarks and heading corrections last one connection.** Only the voice page
  carries them from one visit to the next. Answers can be explained from a later connection by
  their id, for a week on the Worker.
- **Nothing is deployed.** The Worker has run only under `wrangler dev` on this machine; its CPU
  time on Cloudflare is unmeasured.
- **Not tested on real devices or people.** Speech recognition with a real microphone, NVDA with
  "Speak answers" off, and iOS Safari have not been tried with this build; the MCP Apps widget
  has not been tried in a real host; and no blind or low-vision person has used Landmark.
- **The page understands a fixed range of phrasings.** It routes by rules, not a model. Medians
  and percentiles, differences between groups ("which region grew the most") and synonyms such
  as "richest" are not supported; they get a plain refusal or a question back, never a guessed
  number. For example, "what is the median
  population" answers "I cannot work out a median. I can give a total, an average, the highest,
  the lowest, or a count."
- **Nobody can bring their own file at runtime.** A new spreadsheet goes through the offline
  ingest command, then a server restart or a redeploy.
