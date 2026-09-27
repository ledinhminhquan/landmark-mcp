# Product feedback

Updated September 27, 2026. One entry for each tool, API, SDK or body of documentation this
project actually used, each answering the same five questions. Everything here can be checked
against the repository, its tests, the pages linked, or the [friction log](FRICTION-LOG.md).
Where something was never measured, such as how long onboarding took, I say so rather than
estimate it.

No Amazon or AWS service is called at runtime. The Alexa+ toolkit, CLI, Local Inspector and Web
Simulator were not used: the hackathon FAQ says participants cannot get them. AWS IAM, STS,
CodeArtifact and CDK appear only as steps I read in the Alexa+ setup guide. Bedrock, Lambda, S3
and the rest were not used, so there is no feedback on them to give.

## Amazon Alexa+ MCP documentation (read only)

**What I used it for.** Choosing the protocol revision and transport, shaping every spoken
reply, and checking the design against Amazon's accessibility guidance. The pages I relied on
were the MCP Toolkit Overview, the Functional Requirements, and the design guide's
Conversation Surface, Tools, Schema, and Data Design, and Accessibility pages.

**What worked well.** The overview states the target plainly: "Alexa+ for Builders supports the
2025-11-25 version of the MCP specification", over Streamable HTTP. The Functional Requirements
are concrete enough to become code. At most five options with pagination, voice responses
under 30 seconds, no API codes, tool names or internal ids in anything a customer hears, and an
actionable next step for every error: `src/voice/speak.ts` is built around exactly those rules.
The accessibility page's "input parity" (voice only, without touching the screen; touch only,
without voice) is one reason the voice page has a typed-question box that is always visible.

**What needs work.** Five documentation problems, each in the friction log. The lifecycle
example uses revision 2025-03-26 without saying why (entry 1). The partner-only status is
missing from the setup pages a developer lands on (entry 2). The service-token scopes contradict
each other (entry 3). The requirements hold the add-on to its spoken reply while the design
guide says the add-on cannot script it (entry 4). And the accessibility checks can only be run
on a device (entry 5).

**How onboarding felt.** Not timed. I reached a working, tested MCP server on my own, but not an
Alexa "hello world": the toolkit is partner-only, which I learned for certain from the hackathon
FAQ rather than from the setup pages.

**Would I build with it again?** Yes for the public MCP route these pages describe. For the
private toolkit I cannot say; I never had access to it.

## MCP specification 2025-11-25 and the TypeScript SDK 1.30.0

**What I used it for.** The whole server: `McpServer` with nine tools, one `ui://` resource and
server instructions, served through `WebStandardStreamableHTTPServerTransport`, stateless per
request, with JSON responses. The tests also use the SDK's own `Client` and
`StreamableHTTPClientTransport` against the server.

**What worked well.** The Web-standard transport takes a `Request` and returns a `Response`, so
one handler (`createHandler` in `src/server.ts`) runs unchanged on Cloudflare Workers and behind
a small Node adapter; the deployed path and the tested path are the same code. SDK 1.30.0
negotiates 2025-11-25 out of the box, and a test pins it. `enableJsonResponse: true` gives one
complete response per call. The SDK's client echoes an `Mcp-Session-Id` it is given, so two SDK
clients were kept apart with no configuration, and after a 405 on GET an idle client stopped
asking for an event stream (both in `test/transport.test.ts`). The server, its first eight tools
and the Streamable HTTP endpoint were committed on September 9, the day after the project's first
commit.

**What needs work.**

- Arguments that fail the schema are refused before any handler runs, as text with no
  `structuredContent`, and the method that builds that reply is `private`. A voice host has
  nothing to say. I replaced it through a cast, which may break on upgrade (friction log 7).
- Closing a per-request transport too early returns HTTP 200 with an empty body and no error
  anywhere (friction log 6).
- Every `McpServer` builds its own JSON Schema validator unless one is passed in. With a server
  per request, that measured 0.10–0.16 ms per server against 0.01 ms or less with a shared
  validator (four runs of 300 constructions, Node 23.11, September 27). Small, but the Workers
  free plan allows 10 ms of CPU per request. The `jsonSchemaValidator` option fixes it; I would
  like the stateless example to use it.
- A stateless transport issues no session id. That is allowed, but it means every client lands
  in the same application state unless the server issues an id itself, which Landmark now does
  on each `initialize`.
- Two mistakes were mine, not the SDK's: answering GET with an event stream that closed at once
  (SDK clients then reconnected every second), and first registering tools from JSON Schema
  (friction log 8).

**How onboarding felt.** Not timed. The installed version could be exercised locally without a
network; a fresh install from the lockfile (`npm ci`) completed in the September 27 end-to-end
check.

**Would I build with it again?** Yes, pinned to a known version, with the transport's lifetime
handled as above and client-level tests.

## MCP Apps extension (the `ui://` widget on `table_explain`)

**What I used it for.** A widget that shows the grid around an answer's source cells, with the
counted cells highlighted, for someone with some sight or a sighted colleague. It is declared in
the tool's `_meta` and served as a `ui://landmark/explain` resource with the
`text/html;profile=mcp-app` type, written against the core SDK, not the
`@modelcontextprotocol/ext-apps` package.

**What worked well.** The contract is small: a metadata key and one resource. The widget is a
real `<table>` with header scopes, marks counted cells with text as well as colour, and writes
only with `textContent`. Its handshake, teardown, ping, host theme and message-source check are
covered in `test/engine-widget.test.ts`, which runs the widget's own script against a
simulated host.

**What needs work.** I had no real MCP Apps host to test in, and still have not tried one; the
Alexa+ overview says Alexa+ supports MCP Apps, but its toolkit is not available to entrants. My
first version did not complete the handshake at all, which a review found on September 12; that
was my error, not the specification's.

**How onboarding felt.** Not timed. I did not install the extension package, so I cannot rate
its setup.

**Would I build with it again?** Yes, if there is a host to test against. The browser page in the
demo does not render the widget, and the video does not show it.

## Zod 3.25.76

**What I used it for.** Input schemas for all nine tools, and the bounds on every input: text at
most 200 characters (notes 500), at most 10 filters and 20 values per filter, result limits.

**What worked well.** A bound is one call (`z.string().max(200)`), and the SDK accepts both a raw
shape and `z.object()` (friction log 8). Out-of-range input never reaches a handler
(`test/engine-tools.test.ts`: "inputs are bounded").

**What needs work.** Nothing in Zod itself. Its refusal messages ("String must contain at most 5
character(s)") reach the caller through the SDK's refusal text, which is the SDK issue above. I
keep Zod on the 3.x line the SDK version expects.

**How onboarding felt.** Not timed. It came in with the SDK.

**Would I build with it again?** Yes.

## ExcelJS 4.4.0

**What I used it for.** Reading `.xlsx` files in the offline ingest step: values, merged ranges,
number formats (to read percentages as percentages), hidden rows and columns, saved formula
results and error cells. The fixture generator also writes the test workbooks with it.

**What worked well.** Merge ranges and each covered cell's master are exposed (friction log 9).
Number formats and hidden-row flags are there to read, which is how ingest warns about hidden
rows and keeps a percent cell from being read as a grouped number
(`test/ingest-xlsx.test.ts`: "a percent cell this reader wrote is never taken for a grouped
number").

**What needs work.** A merged area's covered cells all report the master's value, so provenance
has to be kept separately (friction log 9). A cell value can be a plain value or one of several
object shapes (formulas, rich text, hyperlinks, errors); my adapter turned some into
"[object Object]" until it handled each (`test/ingest-xlsx.test.ts`: "formulas without results,
rich-text links and error cells never become \"[object Object]\""). That was my bug, but the
variety is worth a table in the documentation. `npm audit` reports a moderate `uuid` advisory
through ExcelJS whose code path Landmark never reaches, and its suggested fix is a major
downgrade ([SECURITY-NOTES.md](SECURITY-NOTES.md)).

**How onboarding felt.** Not timed.

**Would I build with it again?** Yes for offline ingest, with fixtures for merged headings, hidden
rows and unusual cells. It never ships to the server: a dry-run Worker bundle contains no ExcelJS
code.

## PapaParse 5.7.0

**What I used it for.** Parsing CSV and other delimited files in the offline ingest step
(`src/ingest/read.ts`). Unless the file is named as tab-separated, Landmark tries each candidate
delimiter (comma, semicolon, tab, pipe) on the first 50 lines with PapaParse and keeps the one
that fits best, then parses the file with it and reports the first three parse errors as
warnings.

**What worked well.** It did what was asked in every test, including semicolon-separated files
with decimal commas (`test/ingest-values.test.ts`: "a semicolon-separated file is split on
semicolons, with comma decimals"). The rows that an early version lost were lost by my heading
inference, not by the parser.

**What needs work.** No PapaParse defect was found.

**How onboarding felt.** Not timed; no large-file benchmark was run.

**Would I build with it again?** Yes, for this kind of offline use.

## Cloudflare Workers, Wrangler 4.134.0 and Durable Objects

**What I used it for.** The deployment target: a Worker (`src/worker.ts`) serving the MCP
endpoint and the voice page as static assets, with two SQLite-backed Durable Object classes, one
per conversation and one per answer, declared with the `exports` form in `wrangler.jsonc`. It
was run with `wrangler dev --local`, `wrangler deploy --dry-run` and `wrangler check startup`.
It has not been deployed.

**What worked well.** The same Web-standard handler runs in the Worker. A dry run of this build
listed both Durable Object bindings, with no ids to create or paste, and a bundle of about
970 KiB (195 KiB gzipped). Under `wrangler dev --local` the page, `/health` (reporting
`"state": "durable"`), the 405, the Origin check and a real tool call all behaved as on Node, and
the Durable Object state survived a restart that reused the same `--persist-to` directory: an
answer given before the restart was explained after it, from another conversation. In the
September 27 end-to-end check on this machine, `wrangler dev` was ready in about 6 seconds and
a warm `table_query` round trip took 45–58 ms (median).

**What needs work.** KV looked like the obvious store, but Cloudflare's own pages say it is
eventually consistent, with changes taking up to 60 seconds or more to reach other locations,
and the free plan allows 1,000 writes a day. That does not fit an answer written on one request
and read back on the next; Durable Objects do. `wrangler check startup` measured 68–96 ms of
active startup CPU in two local runs, and says itself that local CPU differs from Cloudflare's,
so the free plan's 10 ms per-request limit could not be checked before deploying. The Worker
entry imports `cloudflare:workers`, which Node's test runner cannot load, so the state logic had
to be split into Node-safe files to be tested. `wrangler deploy --dry-run` writes a `.wrangler/`
folder into the project, which needs to be in `.gitignore` (it is).

**How onboarding felt.** Nothing was deployed, so signup, the first deploy, real latency and
billing are unrated.

**Would I build with it again?** Yes, subject to a real deployment trial.

## Web Speech API (speech recognition and speech synthesis)

**What I used it for.** The browser page listens with `SpeechRecognition` (or
`webkitSpeechRecognition`) in en-US, one utterance at a time, and speaks each answer with
`speechSynthesis` at rate 1.0. Recognition errors are turned into advice on what to do next, and
there is always a typed-question box.

**What worked well.** The recognition object exists in Chromium, and synthesis is reliable
enough to time a video around: on September 27, in Chromium on this Windows machine with its
default voice, each of the five demo replies spoke for 5.5–6.9 seconds and started 0.4–0.8
seconds after the call.

**What needs work.** Cancelling speech reports an "interrupted" error rather than an end event
(seen in Chromium on September 27), so code waiting for the end must also listen for errors. The
page is written to handle speech being refused before the first click, which browser autoplay
rules can cause, but that path was only checked in simulation.

**How onboarding felt.** Not timed. Recognition with a real microphone, iOS Safari, and NVDA with
the page's own speech turned off have not been tried with this build.

**Would I build with it again?** For a prototype, yes, always with a typed path beside it.

## Node.js 23.11 and TypeScript 5.7.2

**What I used it for.** Node runs the TypeScript directly with `--experimental-strip-types` for
the local server, the ingest command and the test suite (`node --test`); `tsc` does the type
check and the build for `npm start`.

**What worked well.** No build step for development or tests. `npm test` runs all 439 tests in
about 13–18 seconds on this machine, and `npm run typecheck` is clean. The suite also passes under
other time zones.

**What needs work.** Node's type stripping rejects some syntax that TypeScript 5.7.2 accepts and
cannot flag, because `--erasableSyntaxOnly` arrived in TypeScript 5.8. Node's documentation says
so; the fix is on my side (upgrade TypeScript), and it is recorded in
[INTERNAL-FRICTION.md](INTERNAL-FRICTION.md). Every run prints an ExperimentalWarning for type
stripping. `package.json` requires Node 22.6 or later, the first release with type stripping,
but only Node 23.11 was actually run.

**How onboarding felt.** Not timed; both were already installed.

**Would I build with it again?** Yes, with TypeScript 5.8 or later.

---

Not rated here: npm and Git, used in the ordinary way (npm's PowerShell behaviour is friction
log entry 10), and the AI coding assistants used to draft parts of the code and these documents.
