# Friction log

Written while building, not reconstructed afterwards. Each entry is something that
actually cost time on this project, in the format the rules ask for: the task, the
steps, expected against actual, a severity, the workaround, and a suggestion someone
could act on.

Entries marked **[VERIFY BEFORE SUBMITTING]** come from research rather than from
first-hand attempts on this machine. Confirm each one yourself, or delete it. A
friction log is read by the engineers who own the product, and an entry that turns out
to be second-hand costs more credibility than it earns points.

---

## 1. Streamable HTTP: an SSE response and a stateless handler are in direct conflict

**Task.** Serve MCP over Streamable HTTP from a stateless per-request handler, using
`WebStandardStreamableHTTPServerTransport`.

**Steps.** Construct the transport per request, `server.connect(transport)`, return
`await transport.handleRequest(request)`, and close the transport in a `finally` block
so the isolate does not accumulate keep-alive timers.

**Expected.** A complete JSON-RPC response.

**Actual.** Every response arrived with `content-type: text/event-stream` and an empty
body. The transport writes into a stream that outlives `handleRequest`, so closing the
transport immediately after it returns killed the stream before the message reached it.
The failure is silent — a 200 with nothing in it — which cost far longer to diagnose
than an error would have.

**Severity.** Medium. Recoverable, but it presents as "my server returns nothing" with
no signal pointing at lifetime.

**Workaround.** `enableJsonResponse: true`. This server never initiates a message, so
there is nothing an event stream buys it, and one complete Response per request removes
the question entirely.

**Suggestion.** Have `close()` on a transport with an unfinished response either flush
it or reject with a message that names the cause. Failing that, say in the Streamable
HTTP docs that the SSE path requires the transport to outlive the handler, and that
`enableJsonResponse` is the right default for a stateless deployment. Right now a
reader has to infer both.

---

## 2. `registerTool` accepts a Zod raw shape, and the type error when you pass JSON Schema does not say so

**Task.** Register a tool whose input schema was already written as JSON Schema, since
the MCP spec describes tool schemas in JSON Schema terms.

**Steps.** Pass the JSON Schema object as `inputSchema` to `registerTool`.

**Expected.** Either acceptance, or a message naming the expected form.

**Actual.** A generic assignability error mentioning `ZodRawShapeCompat | AnySchema`.
Working out that the intended input is a *plain object whose values are Zod schemas* —
not a Zod object, and not JSON Schema — took a read of `mcp.d.ts`.

**Severity.** Low. Once known, it is obvious.

**Suggestion.** One line in the `registerTool` doc comment with a two-property example.
The spec talks in JSON Schema, so arriving with JSON Schema in hand is the common path,
and the gap between the two is the first thing a new implementer hits.

---

## 3. Documentation and examples disagree on the protocol revision to target

**Task.** Confirm which revision to implement, given the track requires
"spec version 2025-11-25 (or a later version, once confirmed)".

**Steps.** Read the SDK's exported constants, then compare against published examples.

**Expected.** Agreement.

**Actual.** `LATEST_PROTOCOL_VERSION` is `2025-11-25`, but
`DEFAULT_NEGOTIATED_PROTOCOL_VERSION` is `2025-03-26`, and quickstart examples in
circulation still send `2025-06-18`. A newcomer copying an example gets a server that
negotiates an older revision and has no reason to notice.

**Severity.** Medium for this hackathon specifically, where the revision is the
requirement.

**Workaround.** Assert it. `test/wire.test.ts` fails if `initialize` returns anything
but `2025-11-25`, so a dependency bump cannot quietly change the answer.

**Suggestion.** Have the quickstart send `LATEST_PROTOCOL_VERSION` rather than a
hard-coded date, and note next to `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` that it exists
for clients that never negotiated, not as a value to target.

---

## 4. ExcelJS reports merged values in two shapes, and only one is documented

**Task.** Read merge spans, which are load-bearing for this project.

**Steps.** Read `worksheet.model.merges`.

**Expected.** An array of `"A3:A5"` range strings.

**Actual.** An array on some versions and an object keyed by range on others. Worse for
correctness: ExcelJS *also* propagates the merged value across every covered cell in its
own object model, while a CSV read cannot. Code that only records provenance when it
does the filling itself therefore loses "this cell is covered by a merge" precisely for
the format where merges occur.

**Severity.** Medium, and quiet. Nothing errors; a feature silently depends on file
format.

**Workaround.** Normalise both shapes, and record merge origin from the span list rather
than from whether we filled the cell.

**Suggestion.** Not Amazon's product, but worth stating for anyone building on
spreadsheets: the merge model is the part most likely to differ between readers, and it
is the part accessibility tooling depends on most.

---

## 5. Node's `--experimental-strip-types` rejects TypeScript parameter properties, at runtime

**Task.** Run TypeScript directly under Node 23 without a build step.

**Steps.** Declare `constructor(message: string, readonly nextStep: string)`.

**Expected.** Either support, or a compile-time diagnostic.

**Actual.** `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, thrown when the module loads. It is
correct — parameter properties emit code and are therefore not erasable — but it
surfaces at run time, from a test file that does not contain the offending syntax.

**Severity.** Low.

**Suggestion.** Have `tsc` offer an "erasable syntax only" diagnostic so this is caught
at typecheck rather than on first import. *(TypeScript's `--erasableSyntaxOnly` covers
this; the friction is that it is off by default and unmentioned in Node's own docs.)*

---

## 6. [VERIFY BEFORE SUBMITTING] The Alexa+ MCP Toolkit path cannot be started from the documentation

Research indicates the toolkit is gated — "available to select partners only",
"available in the United States" — that `@alexa-ai/cli` and
`@alexa-ai/addon-local-inspector` return 404 on public npm, and that setup requires an
AWS account "provided to the Alexa Solutions Architect" with no way to initiate that
contact from the docs. If so, a developer can read the entire setup path before
discovering they are blocked, because the partner-only note is on the docs home rather
than on the overview and quickstart pages people actually land on.

**Before including this, spend thirty minutes attempting it yourself and write down what
happens.** First-hand friction is worth reporting; repeated research is not.
