# Devpost submission, ready to paste

Each section below is one field of the Devpost form. Paste what is inside the grey
block; the lines outside the blocks are instructions for you and are not part of the
submission. Two things only you can supply are marked **[YOU FILL: …]**.

Before you submit:

1. **Push first.** Judges read the GitHub repository. Push this version so the public
   repo matches what these fields describe, then open
   https://github.com/ledinhminhquan/landmark-mcp and check the README and the MIT
   licence in the About box.
2. **Video.** Under three minutes, English, uploaded to YouTube or Vimeo and publicly
   visible, with no third-party trademarks or copyrighted music (official rules).
3. **Hosting is optional.** The hackathon FAQ says a locally runnable public repo plus
   the demo video is enough for Alexa+. If you do deploy and list a URL, it must stay
   up, free, until judging ends: 20 November 2026, 12:00 Pacific, which is
   **21 November 03:00 in Vietnam (GMT+7)**.
4. **Deadline:** 23 October 2026, 12:00 PDT, which is **24 October 02:00 in Vietnam**.
   You can edit the entry until then, not after.
5. **Read the product feedback answers as yours.** The rules ask how onboarding went
   and whether you would build with each tool again. The answers below are written
   from the project's record, with nothing timed and no feelings invented; change any
   that is not how it was for you.

---

## Project name

````text
Landmark
````

## Elevator pitch (200 characters at most; this is 182)

````text
Ask a spreadsheet questions out loud instead of walking it cell by cell. An MCP server for blind and low-vision users that answers briefly and says which cells each number came from.
````

## About the project

*If the form gives one "About the project" box, paste the sections below into it in
this order, each under its heading. If it gives separate boxes, paste each into its
own.*

### Inspiration

````markdown
It is tempting to say screen readers lose header context in a spreadsheet. They do not: JAWS and NVDA both announce headers in Excel, and a reader who uses one would rightly stop trusting what came next. The real problem is narrower and harder.

- **Header setup is manual, per worksheet, and does not travel.** NVDA issue #11801, open since November 2020, is about headings defined with NVDA not being spoken in JAWS.
- **Authors rarely declare a table's structure, even where they can.** The WebAIM Million (February 2026) found valid data-table markup on 19% of 948,225 tables on the top million home pages. That is the web, not spreadsheets, but it is the largest count we know of how often people mark up headers when a way exists. Section508.gov: "Excel does not provide tools to make complex tables accessible."
- **Even with headers announced, a question costs a walk.** "What is the total?" means visiting every row. "Which region did best?" means every row and column.

A sighted reader answers those with a glance. And when an AI answers instead, a blind user has to be able to check it: at CHI 2026, Perera, Ananthanarayan, Goncu and Marriott found that the 12 blind spreadsheet users they studied never fully trusted generative-AI output without verifying it, and that verifying was often effortful ("I'm Always a Little Skeptical of It", https://doi.org/10.1145/3772318.3790988).
````

### What it does

````markdown
Landmark is a self-hosted MCP server (protocol revision 2025-11-25, Streamable HTTP) that makes a spreadsheet answerable by voice, and shows its working.

Ask what is in a file and it orients you: size, column names, merged cells, other tables on the sheet, and any doubt about how it read the headings. Ask for a total, an average, a count, the highest or lowest, a breakdown or a comparison, and it answers in a sentence or two, sized for listening. Ask "how do you know" and it reads back the exact cells. Word for word, from the bundled budget file:

```
You:       what's in the budget file
Landmark:  "FY2026 Departmental Budget" has 5 rows and 3 columns. The columns are Department, Line item and Amount. 3 cells take their label from a merged block, so they are not the blanks they look like.
You:       total amount for engineering
Landmark:  560 thousand. That is the total of Amount across 3 rows.
You:       how do you know
Landmark:  That came from C3 through C5 on Budget. Each one is Amount.
```

For a highest or lowest it names the row ("21 thousand, for Chi. That is the highest Revenue across 5 rows."). Cells it could not count are said out loud ("I skipped 2 rows: 1 was empty and 1 did not hold a number."), and a Total row is left out and mentioned. If the headings were read wrongly, you can say so ("row one is data", "the top two rows are headings") and it re-reads the table for the rest of the conversation. What it cannot do, it says: "I cannot work out a median. I can give a total, an average, the highest, the lowest, or a count."

It comes with:
- **Nine MCP tools**: table_list, table_describe, table_structure, table_query, table_explain, table_read_rows, table_compare, table_bookmark, table_resume. There is deliberately no get_cell or get_row, which would hand the cell-by-cell walk back to the model.
- **A browser voice client**, served from the same origin: a real MCP client that performs the 2025-11-25 handshake and calls the tools over Streamable HTTP. Press "Ask by voice" (or Space) and speak, or type in the always-visible box. A "Speak answers" switch hands answers to your own screen reader instead. It routes words to tools with rules, not a language model, and when it is unsure it asks back rather than guessing.
- **An MCP App**: table_explain declares a ui:// resource that draws the table with every counted cell highlighted and marked "(counted)" in text, and the winning cell of a highest or lowest marked "(the answer)", for people with some sight or a sighted colleague beside them. It is tested against the MCP Apps message shapes but has not yet been shown in a real MCP Apps host.
- **An Agent Skill** (skills/landmark-tables/SKILL.md) that tells an assistant how to use the tools for someone who is listening. It has not yet been evaluated with a model.

A note on Alexa+: the hackathon FAQ says the Alexa+ MCP Toolkit is available to select partners only and that there is currently no way for hackathon participants to apply for or gain access. So Landmark has never run inside Alexa+. The deliverable the track asks for is the self-hosted MCP server; the browser client stands in for a device, and it talks to the real server, not a simulation of it.
````

### How I built it

````markdown
- **Structure inference, offline.** A spreadsheet declares a grid, not a table. An ingest step in Node (ExcelJS for .xlsx/.xlsm, PapaParse for .csv/.tsv) finds table regions separated by blank rows, scores which rows are headings and records how sure it is, resolves merged blocks, and builds a full heading path for every column: four columns all labelled "Revenue" become "2026 Q1 Revenue" … "2025 Q2 Revenue". It reads Vietnamese and European number formats ("1.234,56", "45.000 ₫"), recognises Total rows, and writes a versioned JSON index.
- **Arithmetic in the server, never in a model.** Filtering and aggregation are deterministic. Every answer records the cells it used and the ones it left out, and table_explain reads back exactly those, without recomputing.
- **Output sized for listening.** Every result carries a "spoken" field capped at about 70 words, five items at a time with a cursor, numbers scaled for the ear, no ids or tool names; the exact figures stay in the structured result for the host.
- **One handler, two runtimes.** The MCP endpoint is a web-standard fetch handler on @modelcontextprotocol/sdk 1.30.0. The same code runs under Node locally (bound to 127.0.0.1, with Host and Origin checks) and on Cloudflare Workers, where each conversation's state is a SQLite-backed Durable Object and each answer is its own, so "how do you know" still works from a later connection.
- **State per conversation.** The transport is stateless, so the server issues an Mcp-Session-Id on initialize and keeps state per conversation; the voice client keeps one id per browser so a reload finds your bookmark.
- **Tests as the spec.** 439 tests run with Node's built-in runner, including the filmed demo conversation pinned word for word and a set of questions a judge might improvise, each checked against numbers worked out separately from the rows. TypeScript is strict, run directly with Node's type stripping.
- **Tools.** Written in TypeScript with AI coding assistance (Claude Code, and Codex for some review), with every claim in the docs checked against the tests or the running server.
````

### Challenges I ran into

````markdown
- **Answers that sounded right and were wrong.** An AI-assisted review of the whole project against the running code found about two hundred defects. The worst were confident wrong numbers: "how many countries are in Europe" said "8 rows match" (the answer is 2) because the voice client silently dropped the filter when the same question also opened another table; a Vietnamese or European number such as "1.234,56" was read a thousand times too small; and after a "highest", "how do you know" could name five cells that did not include the winner. Each is fixed and has a regression test; the Europe question now says "2 rows match."
- **Where state lives.** A stateless transport issued no session id, so every standard MCP client, and every browser, shared one conversation: one person's heading correction changed the numbers another heard. On Workers, memory is per instance, so an answer could vanish between "560 thousand" and "how do you know". KV would not have fixed that: it is eventually consistent, caches a miss, and the free plan allows 1,000 writes a day. The Worker now keeps state in strongly consistent Durable Objects; that has been checked in the local Workers runtime, not yet on Cloudflare itself.
- **The transport lifecycle.** Early on, a tool response came back as an empty HTTP 200 because the transport was closed before the response was read. The server now answers each JSON-RPC request with one complete JSON response instead of an event stream.
- **Getting the claims right.** The README cited the wrong paper for its central claim, and an earlier draft said no assistive MCP server served disabled end users, which was false. Both are corrected.
````

### Accomplishments that I'm proud of

````markdown
- 439 tests, all passing, and a clean strict typecheck. The filmed demo is pinned word for word, so the video cannot drift from the product.
- Questions it knows it cannot answer get a question back or a plain refusal, not a guessed number, and every wrong answer that several hundred improvised test questions turned up is now a regression test.
- Every number can be traced to its cells, out loud, and for a highest or lowest the row is named.
- The same handler runs locally and on Cloudflare Workers, and state in the Durable Objects survives a restart of the local Workers runtime.
- A narrow, true market claim. We know of no MCP server that lets a blind user interrogate a spreadsheet by voice. That is an observation, not a claim of being first: the official registry does contain end-user assistive servers (NeuroDock's, for cognitive and executive-function support), and its search matches server names only.
````

### What I learned

````markdown
That getting the problem statement exactly right matters more than making it dramatic. "Screen readers lose header context" would have cost the trust of every reader who uses one; "header setup is manual, per file, and does not survive a change of reader" is true and a stronger argument.

That for someone who cannot check, a question back is an acceptable answer and a confident wrong number is not. Most of the fixes that mattered were about refusing to guess.

That "state across sessions" is a consistency problem before it is a feature: the explanation has to be there on the very next request, which ruled out the obvious store.
````

### What's next for Landmark

````markdown
- Put it in front of blind and low-vision spreadsheet users, paid for their time, through groups that allow such requests, and change it by what they say. No one who is blind or has low vision has used it yet.
- Let people bring their own file at runtime. Today a spreadsheet reaches Landmark only through an offline ingest command.
- Try the MCP App in a real MCP Apps host and the Agent Skill with a real model; neither has been tested that way.
- Medians and percentiles, and change per group ("which region grew the most"), which it now declines.
- Alexa+ itself, if the toolkit opens to developers outside Amazon's partner program.
````

## Built with

*Devpost asks for tags; paste them one at a time or comma-separated, as the form
allows.*

````text
typescript, node.js, model-context-protocol, mcp-typescript-sdk, cloudflare-workers, cloudflare-durable-objects, sqlite, wrangler, exceljs, papaparse, zod, web-speech-api, javascript, html, claude-code
````

## "Try it out" links

````text
https://github.com/ledinhminhquan/landmark-mcp
````

*Add a second link only if you deploy:* **[YOU FILL: https://landmark-mcp.<your-subdomain>.workers.dev/ — or leave this out]**. If you add it, open `/health`
on it first and check it says `"state":"durable"`, and keep it running until
21 November 03:00 Vietnam time.

## Video demo link

**[YOU FILL: the public YouTube or Vimeo URL of the demo video]**

## Testing instructions

*Paste this if the form has a testing-instructions box.*

````markdown
No account or credentials are needed. Needs Node.js 22.6 or later and npm; these commands are the same in bash and PowerShell:

    git clone https://github.com/ledinhminhquan/landmark-mcp
    cd landmark-mcp
    npm install
    npm test          # 439 tests
    npm run demo      # prints what the server says to a scripted conversation
    npm run serve     # then open http://localhost:8787/

The page at http://localhost:8787/ is the voice client (Chrome or Edge for speech input; the typed box works in any browser). Try "what's in the budget file", "total amount for engineering", "how do you know". The MCP endpoint is http://localhost:8787/mcp (POST only), and http://localhost:8787/health reports the protocol revision (2025-11-25), the bundled tables (6) and rows (28), and where state is kept.

The bundled data is six small tables in data/index.json. To use your own spreadsheet, see "Your own spreadsheet" in the README.
````

## Primary track

````text
Alexa+
````

## Mini challenges

*Enter Open Source only. The rules say "Create a new, additional open-source project or
contribute to an existing public repository during the hackathon window, alongside a
primary track submission." Landmark
is a new MIT-licensed repository created in the window (first commit 8 September 2026;
the window opened 31 August), and when someone asked on the hackathon forum whether a
fresh repo created during the window qualifies, an organizer answered "Yes that's
fine!". It is, though, the same repository as the Alexa+ entry rather than a separate
second project, so treat the mini-challenge entry as reasonable but not certain.*

*AWS Builder: not entered. Landmark uses no AWS service. The organizers have said that
Kiro, or Claude Code running on Amazon Bedrock, counts as AWS tooling; nothing in the
project's record shows either being used, so it is not claimed. Enter AWS Builder only
if you actually use one of them, and document the service, region and use in the
product feedback.*

````text
Open Source
````

### Open Source: contribution URL

````text
https://github.com/ledinhminhquan/landmark-mcp
````

### Open Source: project repository URL

````text
https://github.com/ledinhminhquan/landmark-mcp
````

### Open Source: GitHub username

````text
ledinhminhquan
````

### Open Source: what I did, how it works, and why it matters

````markdown
**What I did.** Landmark is a new open-source project, MIT-licensed, started during the hackathon window: an MCP server, an offline spreadsheet ingest CLI, a browser voice client, an MCP App and an Agent Skill, with 439 tests.

**How it works.** The ingest CLI reads .xlsx, .xlsm, .csv and .tsv files and infers the structure a spreadsheet never declares: table regions, heading rows (with a confidence it will say out loud), merged blocks, full heading paths, number formats and Total rows. It writes a versioned JSON index. The server exposes nine MCP tools over Streamable HTTP (protocol 2025-11-25) that describe, filter, aggregate, compare and explain, each returning a short "spoken" sentence plus the exact data and the source cells. One web-standard fetch handler runs under Node and on Cloudflare Workers, with Durable Objects for per-conversation state.

**Why it matters.** Spreadsheets are where a lot of everyday numbers live, and walking one cell by cell with a screen reader is slow. Landmark lets someone ask instead, and check the answer by hearing exactly which cells it came from. The structure inference, the provenance tracking and the voice-sized output are reusable by anyone building accessible data tools on MCP.
````

## Product feedback (required)

*The rules ask, for each tool, API or SDK used: what you used it for, what worked
well, what needs work, how onboarding went, and whether you would build with it again
(Yes/No, and why). This mirrors docs/PRODUCT-FEEDBACK.md, shortened for the form.*

````markdown
No Amazon or AWS service is called at runtime. The Alexa+ toolkit, CLI, Local Inspector and Web Simulator were not used: the hackathon FAQ says participants cannot get them. AWS IAM, STS, CodeArtifact and CDK appear only as steps I read in the Alexa+ setup guide. Onboarding times were never measured, so none is given.

**1. Amazon Alexa+ MCP documentation (read only)**
- *What I used it for:* choosing the protocol revision and transport, shaping every spoken reply, and checking the design against Amazon's accessibility guidance: the MCP Toolkit Overview, the Functional Requirements, and the design guide's Conversation Surface; Tools, Schema, and Data Design; and Accessibility pages.
- *What worked well:* the overview states the target plainly ("Alexa+ for Builders supports the 2025-11-25 version of the MCP specification"). The Functional Requirements are concrete enough to become code: at most five options with pagination, voice responses under 30 seconds, no API codes, tool names or internal ids in anything a customer hears, and an actionable next step for every error. The server's speech formatting is built around exactly those rules. The accessibility page's "input parity" (voice only; touch only, without voice) is why the voice page has a typed-question box that is always visible.
- *What needs work:* five documentation problems, each in the friction log: the lifecycle example uses revision 2025-03-26 without saying why (1); the partner-only status is missing from the setup pages a developer lands on (2); the service-token scopes contradict each other (3); the requirements hold the add-on to its spoken reply while the design guide says the add-on cannot script it (4); the accessibility checks can only be run on a device (5).
- *How onboarding felt:* not timed. I reached a working, tested MCP server on my own, but not an Alexa "hello world": the toolkit is partner-only, which I learned for certain from the hackathon FAQ rather than from the setup pages.
- *Would I build with it again:* Yes for the public MCP route these pages describe. For the private toolkit I cannot say; I never had access to it.

**2. MCP specification 2025-11-25 and the TypeScript SDK 1.30.0**
- *What I used it for:* the whole server: McpServer with nine tools, one ui:// resource and server instructions, served through the web-standard Streamable HTTP transport, stateless per request, with JSON responses. The tests also use the SDK's own client against the server.
- *What worked well:* the web-standard transport takes a Request and returns a Response, so one handler runs unchanged on Cloudflare Workers and behind a small Node adapter; the deployed path and the tested path are the same code. SDK 1.30.0 negotiates 2025-11-25 out of the box, and a test pins it. JSON responses give one complete response per call. The SDK's client echoes an Mcp-Session-Id it is given, so two SDK clients were kept apart with no configuration, and after a 405 on GET an idle client stopped asking for an event stream.
- *What needs work:* arguments that fail the schema are refused before any handler runs, as text with no structuredContent, and the method that builds that reply is private, so a voice host has nothing to say; I replaced it through a cast, which may break on upgrade (friction log 7). Closing a per-request transport too early returns HTTP 200 with an empty body and no error (friction log 6). Every McpServer builds its own JSON Schema validator unless one is passed in: 0.10–0.16 ms per server against 0.01 ms or less with a shared one (four runs of 300 constructions, Node 23.11, 27 September), small but real against the Workers free plan's 10 ms of CPU per request; I would like the stateless example to share one. A stateless transport issues no session id, so every client lands in the same application state unless the server issues an id itself, which Landmark now does on each initialize. Two mistakes were mine, not the SDK's: answering GET with an event stream that closed at once (SDK clients then reconnected every second), and first registering tools from JSON Schema (friction log 8).
- *How onboarding felt:* not timed. The installed version could be exercised locally without a network, and a fresh install from the lockfile (npm ci) worked in the 27 September end-to-end check.
- *Would I build with it again:* Yes, pinned to a known version, with the transport's lifetime handled as above and client-level tests.

**3. MCP Apps extension (the ui:// widget on table_explain)**
- *What I used it for:* a widget that shows the grid around an answer's source cells, with the counted cells highlighted, for someone with some sight or a sighted colleague. Declared in the tool's _meta and served as ui://landmark/explain with the text/html;profile=mcp-app type, written against the core SDK rather than the ext-apps package.
- *What worked well:* the contract is small: a metadata key and one resource. The widget is a real table with header scopes, marks counted cells with text as well as colour, and writes only with textContent. Its handshake, teardown, ping, host theme and message-source check are tested by running the widget's own script against a simulated host.
- *What needs work:* I had no real MCP Apps host to test in, and still have not tried one; the Alexa+ overview says Alexa+ supports MCP Apps, but its toolkit is not available to entrants. My first version did not complete the handshake at all; that was my error, not the specification's.
- *How onboarding felt:* not timed. I did not install the extension package, so I cannot rate its setup.
- *Would I build with it again:* Yes, if there is a host to test against. The demo's browser page does not render the widget, and the video does not show it.

**4. Zod 3.25.76**
- *What I used it for:* input schemas for all nine tools, and the bounds on every input: text at most 200 characters (notes 500), at most 10 filters and 20 values per filter, result limits.
- *What worked well:* a bound is one call (z.string().max(200)), and the SDK accepts both a raw shape and z.object(). Out-of-range input never reaches a handler.
- *What needs work:* nothing in Zod itself; its refusal messages reach the caller through the SDK's refusal text, which is the SDK issue above.
- *How onboarding felt:* not timed. It came in with the SDK.
- *Would I build with it again:* Yes.

**5. ExcelJS 4.4.0**
- *What I used it for:* reading .xlsx files in the offline ingest step (values, merged ranges, number formats, hidden rows and columns, saved formula results, error cells), and writing the test workbooks.
- *What worked well:* merge ranges and each covered cell's master are exposed. Number formats and hidden-row flags are there to read, which is how ingest warns about hidden rows and keeps a percent cell from being read as a grouped number.
- *What needs work:* a merged area's covered cells all report the master's value, so provenance has to be kept separately (friction log 9). A cell value can be a plain value or one of several object shapes (formulas, rich text, hyperlinks, errors); my adapter turned some into "[object Object]" until it handled each. That was my bug, but the variety deserves a table in the documentation. npm audit reports a moderate uuid advisory through ExcelJS whose code path Landmark never reaches, and its suggested fix is a major downgrade.
- *How onboarding felt:* not timed.
- *Would I build with it again:* Yes for offline ingest, with fixtures for merged headings, hidden rows and unusual cells. It never ships to the server: the Worker bundle contains no ExcelJS code.

**6. PapaParse 5.7.0**
- *What I used it for:* parsing CSV and other delimited files at ingest. Landmark tries each candidate delimiter (comma, semicolon, tab, pipe) on the first 50 lines and keeps the one that fits best, then parses the file with it and reports the first parse errors as warnings.
- *What worked well:* it did what was asked in every test, including semicolon-separated files with decimal commas. Rows an early version lost were lost by my heading inference, not by the parser.
- *What needs work:* no PapaParse defect was found.
- *How onboarding felt:* not timed; no large-file benchmark was run.
- *Would I build with it again:* Yes, for this kind of offline use.

**7. Cloudflare Workers, Wrangler 4.134.0 and Durable Objects**
- *What I used it for:* the deployment target: a Worker serving the MCP endpoint and the voice page as static assets, with two SQLite-backed Durable Object classes, one per conversation and one per answer, declared with the exports form in wrangler.jsonc. Run with wrangler dev --local, wrangler deploy --dry-run and wrangler check startup. It has not been deployed.
- *What worked well:* the same web-standard handler runs in the Worker. A dry run of this build listed both Durable Object bindings, with no ids to create or paste, and a bundle of about 970 KiB (195 KiB gzipped). Under wrangler dev the page, /health (reporting "state": "durable"), the 405, the Origin check and a real tool call behaved as on Node, and Durable Object state survived a restart that reused the same --persist-to directory. In a September 27 check on this machine, wrangler dev was ready in about 6 seconds, and a warm table_query round trip took 45–58 ms (median).
- *What needs work:* KV looked like the obvious store, but Cloudflare's own pages say it is eventually consistent and the free plan allows 1,000 writes a day, which does not fit an answer written on one request and read back on the next; Durable Objects do. wrangler check startup measured 68–96 ms of active startup CPU in two local runs and says itself that local CPU differs from Cloudflare's, so the 10 ms per-request limit could not be checked before deploying. The Worker entry imports cloudflare:workers, which Node's test runner cannot load, so the state logic had to be split into Node-safe files to be tested.
- *How onboarding felt:* nothing was deployed, so sign-up, the first deploy, real latency and billing are unrated.
- *Would I build with it again:* Yes, subject to a real deployment trial.

**8. Web Speech API (speech recognition and speech synthesis)**
- *What I used it for:* the browser page listens with SpeechRecognition in en-US, one utterance at a time, and speaks each answer with speechSynthesis. Every recognition error code is turned into spoken advice, and there is always a typed-question box.
- *What worked well:* synthesis is reliable enough to time a video around: in Chromium on this Windows machine, each of the five demo replies spoke for 5.5–6.9 seconds and started 0.4–0.8 seconds after the call.
- *What needs work:* cancelling speech reports an "interrupted" error rather than an end event, so code waiting for the end must also listen for errors. The page handles speech being refused before the first click, which browser autoplay rules can cause, but that path was only checked in simulation.
- *How onboarding felt:* not timed. Recognition with a real microphone, iOS Safari, and NVDA with the page's own speech turned off have not been tried with this build.
- *Would I build with it again:* For a prototype, yes, always with a typed path beside it.

**9. Node.js 23.11 and TypeScript 5.7.2**
- *What I used it for:* Node runs the TypeScript directly with type stripping for the local server, the ingest command and the test suite (node --test); tsc does the type check and the build for npm start.
- *What worked well:* no build step for development or tests. All 439 tests pass, the strict typecheck is clean, and the suite also passes under other time zones.
- *What needs work:* type stripping rejects some syntax that TypeScript 5.7.2 accepts and cannot flag, because --erasableSyntaxOnly arrived in TypeScript 5.8; Node's documentation says so, and the fix is on my side. Every run prints an ExperimentalWarning for type stripping. package.json requires Node 22.6 or later, but only Node 23.11 was actually run.
- *How onboarding felt:* not timed; both were already installed.
- *Would I build with it again:* Yes, with TypeScript 5.8 or later.

Not rated: npm and Git, used in the ordinary way (npm's PowerShell behaviour is friction log entry 10), and the AI coding assistants (Claude Code, and Codex for some review) used to draft parts of the code and these documents.
````

## Feature requests (optional)

*Mirrors docs/FEATURE-REQUESTS.md. The rules ask for a description, why it matters, and
a priority of Critical, Important or Nice-to-have.*

````markdown
None of these has been sent to any team, and nothing is marked Critical to chase a bonus.

1. **Amazon Alexa+ docs: say which fields of a tool result Alexa's voice uses, and whether a ready-made sentence can be spoken as written.** Why: the Functional Requirements hold the add-on to spoken length and wording, while the design guide says the add-on cannot script the reply (friction log 4). Priority: Important, above all for voice-first and accessibility add-ons.
2. **Amazon Alexa+ docs: mark which accessibility checks can be run without a device, and say how an entrant without toolkit access should show accessibility.** Why: today every check needs a device entrants cannot get (friction log 5). Priority: Important for accessibility entries.
3. **Amazon Alexa+ docs: align the service-token scope example with the scope table, and add a test showing a service token cannot reach user data.** Why: the page contradicts itself (friction log 3). Priority: Important before any private-data integration.
4. **Amazon Alexa+ docs: label each lifecycle example with its protocol revision and add a 2025-11-25 pair.** Why: the worked example disagrees with the supported revision (friction log 1). Priority: Important.
5. **Amazon onboarding: put the partner-only notice and the way to request access at the top of the overview and every setup page, and point others to the public MCP route.** Why: a reader should know whether the private toolkit applies before touching AWS or npm settings (friction log 2). Priority: Important.
6. **MCP TypeScript SDK: a public way to shape the result of input-validation and unknown-tool errors, so it can carry structuredContent like any other tool error.** Why: a voice host needs something to say, and today it takes replacing a private method (friction log 7). Priority: Important.
7. **MCP TypeScript SDK docs: a per-request web Response example with a delayed tool, showing when closing the transport is safe, plus the JSON-response alternative.** Why: closing too early loses the result silently (friction log 6). Priority: Important.
8. **npm: pass a bare -- through npm.ps1, or document that PowerShell users must quote it, and say in the warning that the flag did not reach the script.** Why: the failure can overwrite a file without an error (friction log 10). Priority: Important.
9. **MCP TypeScript SDK docs: in the stateless-server example, mention that each server builds its own JSON Schema validator unless one is shared through jsonSchemaValidator.** Why: a server built per request pays for it every time; measured on 27 September at 0.10–0.16 ms per server with the default and 0.01 ms or less with a shared one. Priority: Nice-to-have.
10. **MCP client testing ecosystem: small offline fixtures for clients (an event stream with a keep-alive or notification before the reply, several messages, error replies).** Why: our own page's client once failed the first of these. Priority: Nice-to-have.
11. **Spreadsheet-library documentation: a recipe for keeping a cell's value together with its merge anchor and span through an import.** Why: a value alone cannot say it was inherited from a merge (friction log 9). Priority: Nice-to-have.
12. **Alexa+ developer testing: a public, versioned conformance fixture for tool discovery, tool results and MCP Apps messages that needs no device or private access.** Why: entrants without toolkit access could check wire contracts locally without claiming an Alexa deployment. Priority: Nice-to-have.
````

## Friction log (optional; can add up to 10% to the final score)

*Mirrors docs/FRICTION-LOG.md, shortened for the form. If space is short, entries 1, 2, 4
and 5 matter most: the bonus is assessed by Amazon's review team.*

````markdown
Written from the repository's history, saved probe results and pages read on the dates given; not a diary kept while building. Every Amazon entry was re-checked against the live page on 27 September 2026, and every tool entry has a dated local reproduction. No time-to-hello-world was measured. Severity is our own assessment. Entries 1–5 are Amazon documentation observations: we never ran the Alexa+ toolkit, a simulator, a device or any AWS service.

**1. The Alexa+ lifecycle example uses a different protocol revision from the one supported** (Amazon Alexa+ documentation)
- *Task attempted:* decide which MCP revision to implement and show.
- *Steps taken:* read the MCP Toolkit Overview and the MCP Client and App Lifecycle page, and compared both with the hackathon requirement.
- *Expected vs actual:* expected the worked initialize example to use the revision the overview names. The overview says "Alexa+ for Builders supports the 2025-11-25 version of the MCP specification"; both the initialize request and response on the lifecycle page carry "protocolVersion": "2025-03-26", with no note saying why.
- *Severity:* Medium. Extra cross-checking of the one version the hackathon makes mandatory.
- *Workaround:* pinned @modelcontextprotocol/sdk 1.30.0 and asserted a real 2025-11-25 initialize exchange in a test. How Alexa+ itself negotiates is untested.
- *Suggestion:* label each example payload with its revision and add a 2025-11-25 request and response pair.

**2. The partner-only status of the Alexa+ tools is missing from the pages a developer lands on** (Amazon Alexa+ onboarding documentation)
- *Task attempted:* find the route from the public documentation to an authorised local setup for the Alexa+ toolkit.
- *Steps taken:* read the MCP Toolkit Overview, then Set Up Your Development Environment through the AWS-account and private-registry steps, from Windows with Node 23 in Vietnam; then the hackathon FAQ.
- *Expected vs actual:* expected the first page to say whether an ordinary developer can get access at all. The overview says "The MCP Toolkit is available in the United States" and nothing about partners. The setup page lists macOS and Ubuntu with Node 24 or later and assumes "the AWS account that you provided to the Alexa Solutions Architect". The answer came from the hackathon FAQ: the tools are "available to select partners only - there is currently no way for hackathon participants to apply for or gain access", a notice "sometimes missing from individual setup-guide pages".
- *Severity:* Medium for planning; it did not block the public MCP route.
- *Workaround:* built a self-hosted MCP server with our own browser client. No AWS credentials, private registry or simulator were used.
- *Suggestion:* put the partner-only notice at the top of the overview and every setup page, with how to request access, and point everyone else to the self-hosted MCP route.

**3. Service-token scope guidance contradicts itself** (Amazon Alexa+ authentication documentation)
- *Task attempted:* understand the authorisation boundary before planning any private user data.
- *Steps taken:* compared step 5 of the client-credentials runtime flow with the scope separation table and item 6 of the token endpoint requirements, on the same page.
- *Expected vs actual:* expected one rule. Step 5 names mcp:tools and mcp:resource (singular) for a service token; the table and the requirements keep user scopes for authorization_code and allow service tokens only mcp:service.
- *Severity:* High for any integration that touches private data. No live failure was observed; Landmark has no OAuth flow.
- *Workaround:* took the restrictive reading and postponed account linking.
- *Suggestion:* align step 5 with the table, fix the mcp:resource / mcp:resources spelling, and add a negative test showing a service token cannot call a user-specific tool.

**4. The requirements hold the add-on to its spoken reply; the design guide says it cannot write one** (Amazon Alexa+ design guide and Functional Requirements)
- *Task attempted:* make answers suit someone who is only listening, and find out how an MCP add-on controls what Alexa says.
- *Steps taken:* read Functional Requirements §2 and §9, then the design guide's "The Conversation Surface" and "Tools, Schema, and Data Design" pages.
- *Expected vs actual:* expected the pages to agree on who writes the words Alexa speaks. The Functional Requirements, which "define what an add-on must deliver to pass certification", put spoken output on the add-on ("Surface no API codes, tool names, JSON, or internal IDs in any customer-facing response", "Present a maximum of 5 options", "Keep voice responses under 30 seconds"), with examples like "The add-on responds: 'I found 3 Italian restaurants nearby…'". The design guide says "You influence Alexa's response through the data you return, not by scripting it directly" and "You can't 'script' what Alexa says". No page says which part of a tool result Alexa's voice draws on, whether a ready-made sentence is used as written, or whether the server's instructions are read.
- *Severity:* Medium, higher for voice-first and accessibility add-ons, whose value depends on what is heard.
- *Workaround:* every result carries a "spoken" sentence already inside the limits plus the structured data behind it, and the server's instructions ask the host to say it as written. Our browser client does; whether Alexa+ would is unknown.
- *Suggestion:* state which fields of a tool result Alexa's voice uses and whether a supplied sentence can be spoken as written, say how §2 and §9 are judged when Alexa composes the reply, and align the examples.

**5. Accessibility checks can only be run on a device entrants cannot get** (Amazon Alexa+ design guide)
- *Task attempted:* check Landmark against Amazon's own accessibility guidance before submitting.
- *Steps taken:* read "Design Guide: Accessibility" and "Design Guide: Test Your Add-on Customer Experience", then the hackathon FAQ on access.
- *Expected vs actual:* expected a way to run part of the checklist without a device. The accessibility page ends "Accessibility features must be tested on device."; the test page's accessibility steps are device settings (VoiceView, Captioning, Screen Magnifier, Color Correction). The FAQ says participants cannot get the toolkit or the Web Simulator, so for an entry built for blind and low-vision users, Amazon's own accessibility checks cannot be run.
- *Severity:* Medium for accessibility-focused entries.
- *Workaround:* applied the checks that need no device to our browser stand-in: the whole budget conversation works typed, through an always-visible text box, and every reply is spoken and pinned by a test, so it can be followed without looking. Speech recognition with a real microphone was not tried with this build, and device checks were not run.
- *Suggestion:* mark which accessibility checks can be done without a device, and say how an entrant without toolkit access should show accessibility instead.

**6. A Streamable HTTP response disappears if the transport is closed too early** (MCP TypeScript SDK 1.30.0; our integration)
- *Task attempted:* return a tool result from a per-request, web-standard handler.
- *Steps taken:* registered a tool with a 30 ms delay, awaited handleRequest, then closed the transport at once; repeated with the transport kept open until the body was read, and with enableJsonResponse: true. Reproduced 13 September, re-run 27 September.
- *Expected vs actual:* expected the result to survive the handler returning. The early close gave HTTP 200, text/event-stream and an empty body, with no error anywhere. Keeping the transport open, or JSON mode, delivered the result.
- *Severity:* Medium. The failure is silent.
- *Workaround:* Landmark answers with enableJsonResponse: true and closes the transport only after the response is complete.
- *Suggestion:* a per-request web Response example with a delayed tool showing when cleanup is safe, and a note that JSON responses suit finite calls.

**7. Arguments the schema refuses come back in a shape a voice host cannot use, with no supported hook** (MCP TypeScript SDK 1.30.0)
- *Task attempted:* make every failure speakable, since a voice host reads a "spoken" field.
- *Steps taken:* registered a tool whose only argument is z.string().max(5), called it with a longer string, and looked for a way to shape the result. Reproduced 27 September.
- *Expected vs actual:* expected the tool's own error shape or a hook to supply one. The SDK answers before any handler runs, with text only and no structuredContent ("MCP error -32602: Input validation error: … String must contain at most 5 character(s)"). The method that builds it, createToolError, is private, and the same path answers an unknown tool.
- *Severity:* Medium for voice hosts; our own browser client threw on this reply.
- *Workaround:* the server replaces createToolError at runtime and returns a spoken refusal with a next step. It depends on a private member, and a test will catch an SDK upgrade that breaks it.
- *Suggestion:* a public option, or a handler the server registers, for shaping input-validation and unknown-tool errors.

**8. Registering a tool from a JSON Schema instead of Zod** (MCP TypeScript SDK 1.30.0; low-priority onboarding)
- *Task attempted:* register a tool whose input was first written as JSON Schema.
- *Steps taken:* called registerTool with a Zod raw shape, with z.object(), and with a plain JSON Schema object, then called the valid tools. Reproduced 13 September.
- *Expected vs actual:* both Zod forms worked; the plain JSON Schema was refused with a clear message that a Zod schema or raw shape is required.
- *Severity:* Low. A learning step, not a defect.
- *Workaround:* Zod schemas throughout.
- *Suggestion:* in a porting guide, put a wire JSON Schema beside both accepted registerTool forms.

**9. ExcelJS gives every cell of a merge the same value, so provenance must be kept separately** (ExcelJS 4.4.0; our ingest adapter)
- *Task attempted:* track which values were inherited from a merged cell, because Landmark tells the listener "3 cells take their label from a merged block".
- *Steps taken:* wrote a workbook with A1:A3 merged and "Engineering" in A1, reloaded it, and read each cell's value, isMerged, master.address and the merge list. Reproduced 13 September.
- *Expected vs actual:* all three cells returned "Engineering" with master A1; a value alone cannot say where it came from. ExcelJS computes nothing wrongly.
- *Severity:* Medium for this project.
- *Workaround:* keep the merge ranges beside the grid and record, per cell, whether its value was written or inherited.
- *Suggestion:* a short documented recipe for carrying address, value, merge anchor and span together through an import.

**10. In PowerShell, `npm run x -- --flag value` loses the `--`, and npm keeps the flag** (npm 11.7.0 on Windows, npm.ps1)
- *Task attempted:* run the documented ingest command, which passes an output path after --, from PowerShell.
- *Steps taken:* in a throwaway package whose script prints its arguments, ran `npm run show -- a.xlsx --out b.json` in PowerShell 7.6.6, then with --out=b.json, with the dash quoted ('--'), through npm.cmd, and in Git Bash. Reproduced 27 September.
- *Expected vs actual:* expected the script to receive a.xlsx --out b.json, as in Git Bash. In PowerShell the bare -- never reaches npm, so npm takes --out as its own setting, warns "Unknown cli config", and the script receives ["a.xlsx","b.json"]; with --out=b.json it receives ["a.xlsx"] and the path lands in npm_config_out. Quoting '--', or npm.cmd, passes all three.
- *Severity:* Medium for us: before our fix, the PowerShell form with --out=<path> overwrote the demo's own index and exited 0.
- *Workaround:* the ingest CLI reads npm_config_out when npm kept the flag, refuses and writes nothing when a bare path shows npm took --out, and tells PowerShell users to quote the dash.
- *Suggestion:* have npm.ps1 pass a bare -- through, or document that PowerShell users must quote it, and say in the warning that the flag was not passed to the script.
````
