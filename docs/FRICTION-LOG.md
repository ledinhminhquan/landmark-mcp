# Friction log

Updated September 27, 2026.

This log is about other people's tools and documentation: where Amazon's Alexa+ documentation,
the MCP TypeScript SDK, ExcelJS and npm made the work harder than it needed to be. Problems in
our own code are not here; they are in [INTERNAL-FRICTION.md](INTERNAL-FRICTION.md), with what
was fixed and the test that proves it.

How it was written: reconstructed from the repository's history, saved probe results and pages
read on the dates given, not kept as a diary while building. Every Amazon entry was re-checked
against the live page on September 27, 2026. Every tool entry has a local reproduction, dated.
No time-to-hello-world was measured, so none is claimed. Severity is our own assessment of the
effect on this project. We never ran the Alexa+ private toolkit, an Alexa simulator or device,
or any AWS service; Amazon entries are documentation observations, not runtime failures.

Entries 1–5 concern Amazon documentation. Entries 6–10 concern the MCP TypeScript SDK,
ExcelJS and npm. The friction-log bonus is optional and assessed by Amazon's review team
([official rules](https://amazonappdev2026.devpost.com/rules)); if space is short, entries 1, 2,
4 and 5 matter most. Related: [product feedback](PRODUCT-FEEDBACK.md),
[feature requests](FEATURE-REQUESTS.md), [evidence and exclusions](FRICTION-EVIDENCE.md).

## 1. The Alexa+ lifecycle example uses a different protocol revision from the one supported

**Task attempted.** Decide which MCP revision to implement and show. Owner: Amazon Alexa+
documentation. Checked September 27, 2026, by reading the pages; no Alexa client was run.

**Steps taken.** Read the MCP Toolkit Overview (last updated Aug 3, 2026), then the Alexa+ MCP
Client and App Lifecycle page (last updated Jul 10, 2026), and compared both with the hackathon
requirement.

**Expected vs actual.** Expected the worked initialize example to use the revision the overview
names. The overview says "Alexa+ for Builders supports the 2025-11-25 version of the MCP
specification." Both the initialize request and the initialize response on the lifecycle page
carry `"protocolVersion": "2025-03-26"`, with no note saying why.
[Overview](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html);
[lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html).

**Severity rating.** Medium. It cost extra cross-checking of the one version the hackathon makes
mandatory. No rejection or measured delay is claimed.

**Workaround used.** Pinned `@modelcontextprotocol/sdk` 1.30.0, whose latest revision is
2025-11-25, and asserted a real 2025-11-25 initialize exchange in `test/wire.test.ts` ("negotiates
exactly the revision the hackathon requires"). How Alexa+ itself negotiates is untested.

**Actionable suggestion.** Label each example payload with its revision, add a 2025-11-25
request and response pair, and keep older examples only with a note saying what they are for.

## 2. The partner-only status of the Alexa+ tools is missing from the pages a developer lands on

**Task attempted.** Find the route from the public documentation to an authorised local setup
for the Alexa+ toolkit. Owner: Amazon Alexa+ onboarding documentation. A documentation
walkthrough, re-checked September 27; no private package was installed.

**Steps taken.** Read the MCP Toolkit Overview, then Set Up Your Development Environment
through the AWS-account and private-registry steps, from Windows with Node 23 in Vietnam. Then
read the hackathon FAQ.

**Expected vs actual.** Expected the first page to say whether an ordinary developer can get
access at all. The overview says "The MCP Toolkit is available in the United States" and says
nothing about partners. The setup page lists macOS and Ubuntu with Node 24 or later, and assumes
"the AWS account that you provided to the Alexa Solutions Architect" before private CodeArtifact
setup. The answer came from the hackathon FAQ instead: the tools "are in preview and available
to select partners only - there is currently no way for hackathon participants to apply for or
gain access", noting this is "sometimes missing from individual setup-guide pages, which has
caused some confusion".
[Setup](https://www.developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html);
[FAQ](https://amazonappdev2026.devpost.com/details/faqs).

**Severity rating.** Medium for planning. It did not block the public MCP route. No failed login
or support refusal is claimed.

**Workaround used.** Built and tested a public MCP server with our own browser client. No AWS
credentials, role assumption, private registry or Alexa simulator were used.

**Actionable suggestion.** Put the partner-only notice at the top of the overview and of every
setup page, with how to request access, and point developers without access to the public MCP
route.

## 3. Service-token scope guidance contradicts itself

**Task attempted.** Understand the authorisation boundary before planning any private user
data. Owner: Amazon Alexa+ authentication documentation. Documentation only, re-checked
September 27; Landmark has no OAuth flow.

**Steps taken.** Compared step 5 of the client-credentials runtime flow with the scope
separation table and item 6 of the token endpoint requirements, all on the same page.

**Expected vs actual.** Expected one rule. Step 5 names `mcp:tools` and `mcp:resource`
(singular) for a service token, while the separation table and the requirements reserve user
scopes for `authorization_code` and allow service tokens only `mcp:service`.
[Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html).

**Severity rating.** High for any future integration that touches private data. No live
authorisation failure or data exposure was observed.

**Workaround used.** Took the restrictive reading and postponed account linking. Landmark has
no authentication at all, and its security notes say not to deploy private data publicly.

**Actionable suggestion.** Align step 5 with the separation table, fix the
`mcp:resource`/`mcp:resources` spelling, and add a negative test showing that a service token
cannot call a user-specific tool.

## 4. The requirements hold the add-on to its spoken reply; the design guide says it cannot write one

**Task attempted.** Make answers that suit someone who is only listening, which is the whole
point of Landmark, and find out how an MCP add-on controls what Alexa says. Owner: Amazon Alexa+
design guide and Functional Requirements. Read September 27, 2026.

**Steps taken.** Read Functional Requirements §2 and §9 (last updated Jul 21, 2026), then the
design guide's "The Conversation Surface" and "Tools, Schema, and Data Design" pages (both last
updated Jul 21, 2026).

**Expected vs actual.** Expected the pages to agree on who writes the words Alexa speaks. The
Functional Requirements, which "define what an add-on must deliver to pass certification", put
spoken output on the add-on: "Surface no API codes, tool names, JSON, or internal IDs in any
customer-facing response", "Present a maximum of 5 options", and the best practice "Keep voice
responses under 30 seconds". Their example reads "The add-on responds: 'I found 3 Italian
restaurants nearby…'". The design guide says the opposite: "You influence Alexa's response
through the data you return, not by scripting it directly", and "You can't 'script' what Alexa
says". No page says which part of a tool result Alexa's voice draws on (text content or
`structuredContent`), whether a ready-made sentence is used as written or rephrased, or whether
the server's `instructions` are read.
[Functional Requirements](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html);
[The Conversation Surface](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-conversation-surface.html);
[Tools, Schema, and Data Design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html).

**Severity rating.** Medium, and higher for voice-first and accessibility add-ons, whose value
depends on the length and wording of what is heard.

**Workaround used.** Every Landmark result carries a `spoken` sentence already inside the
limits (about 70 words at most, five items by default, no tool names or ids), and the structured data
behind it. The server's instructions ask the host to say `spoken` as written. Our browser client
does; whether Alexa+ would is unknown, since we cannot run it.

**Actionable suggestion.** State which fields of a tool result Alexa's voice uses and whether a
supplied sentence can be spoken as written. Then say how the voice requirements in §2 and §9
are judged when Alexa composes the reply, and rewrite the "The add-on responds" examples to
match.

## 5. Accessibility checks can only be run on a device entrants cannot get

**Task attempted.** Check Landmark against Amazon's own accessibility guidance before
submitting. Owner: Amazon Alexa+ design guide. Read September 27, 2026.

**Steps taken.** Read "Design Guide: Accessibility" and "Design Guide: Test Your Add-on
Customer Experience" (both last updated Jul 21, 2026), then the hackathon FAQ on access.

**Expected vs actual.** Expected a way to run at least part of the accessibility checklist
without a device. The accessibility page ends: "Accessibility features must be tested on
device." The test page's accessibility steps are device settings ("Go to Settings →
Accessibility → VoiceView…", Captioning, Screen Magnifier, Color Correction), with "All steps
apply to multimodal devices unless noted." The FAQ says hackathon participants cannot get the
toolkit or the Web Simulator. For an entry built for blind and low-vision users, Amazon's own
accessibility checks cannot be run.
[Accessibility](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-accessibility.html);
[Test your add-on CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html).

**Severity rating.** Medium for accessibility-focused entries; low for others.

**Workaround used.** Applied the checks that need no device to our browser stand-in: the whole
budget conversation works typed, without voice, through an always-visible text box, and every
reply is spoken and pinned by a test (`test/demo.test.ts`), so it can be followed without
looking; each listening tone comes with a visible status change. Speech recognition with a
real microphone was not tried with this build, and VoiceView, captions and magnifier checks on
a device were not run.

**Actionable suggestion.** Mark which accessibility checks can be done without a device (voice
only, touch and keyboard only, without looking), and say how an entrant without toolkit access
should show accessibility instead.

## 6. A Streamable HTTP response disappears if the transport is closed too early

**Task attempted.** Return a tool result from a per-request, Web-standard handler. Owner: our
integration, with a documentation suggestion for the MCP TypeScript SDK. Reproduced September
13, 2026 with a local probe; the probe was re-run in a clean clone on September 27 with the
same result.

**Steps taken.** With SDK 1.30.0, registered a tool with a 30 ms synthetic delay, connected a
fresh transport, awaited `handleRequest`, then closed the transport straight away. Repeated
with the transport kept open until the body was read, and with `enableJsonResponse: true`.
[Probe](feedback-evidence/probe.mjs).

**Expected vs actual.** Expected the result to survive the handler returning. The early close
produced HTTP 200, `text/event-stream`, and an empty body: no error anywhere. Keeping the
transport open delivered the result over SSE; JSON mode delivered it too. This was local, not a
Cloudflare or Alexa failure. [Results](feedback-evidence/legacy-probe-results.json).

**Severity rating.** Medium. The failure is silent. The 30 ms is a probe input, not a measured
platform latency.

**Workaround used.** Landmark answers with `enableJsonResponse: true` (`src/server.ts`), so the
response is complete when `handleRequest` returns, and only then closes the transport, in a
`finally`.

**Actionable suggestion.** Add a per-request Web `Response` example with a delayed tool, showing
when cleanup is safe, and explain that the JSON option suits finite calls. Do not present JSON
as mandatory for stateless servers.

## 7. Arguments the schema refuses come back in a shape a voice host cannot use, with no supported hook

**Task attempted.** Make every failure speakable: a voice host reads a `spoken` field, and a
refusal with nothing to say leaves the listener in silence. Owner: MCP TypeScript SDK.
Reproduced September 27, 2026 with SDK 1.30.0 and Zod 3.25.76 on Node 23.11.

**Steps taken.** Registered a tool whose only argument is `z.string().max(5)`, called it with a
longer string over Streamable HTTP, and read the result. Then looked for a way to shape that
result.

**Expected vs actual.** Expected either the tool's own error shape or a hook to supply one. The
SDK answers before any handler runs, with text only and no `structuredContent`:
`{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments
for tool echo: String must contain at most 5 character(s) at value"}],"isError":true}`. The
method that builds this, `createToolError`, is declared `private` in `server/mcp.d.ts`, so there
is no supported way to change it. The same path answers a call to an unknown tool.

**Severity rating.** Medium for voice hosts. Our own browser client, which falls back to
parsing the text as JSON when there is no structured result, throws on this reply.

**Workaround used.** `src/server.ts` replaces `createToolError` at runtime through a type cast
and returns a spoken refusal with a next step. It depends on a private member and may break on
an SDK upgrade; `test/integration.test.ts` ("arguments the schema refuses are spoken like any
other failure") will catch that.

**Actionable suggestion.** Offer a public option for shaping input-validation and unknown-tool
errors, or pass them to a handler the server registers, so the result can carry
`structuredContent` like any other tool error.

## 8. Registering a tool from a JSON Schema instead of Zod

**Task attempted.** Register a tool whose input was first written as JSON Schema. Owner: our
SDK integration; low-priority onboarding feedback for the SDK. Reproduced September 13 with
SDK 1.30.0 and Zod 3.25.76; the earlier compiler output that prompted it was not kept.

**Steps taken.** Called `registerTool` with a Zod raw shape, with `z.object()`, and with a plain
JSON Schema object, then called the two valid tools over Streamable HTTP.
[Results](feedback-evidence/legacy-probe-results.json).

**Expected vs actual.** Expected to learn which form is accepted. Both Zod forms worked. The
plain JSON Schema was refused with a message that says a Zod schema or raw shape is required.
Earlier notes claiming `z.object()` is unsupported, or that the error gives no guidance, were
wrong.

**Severity rating.** Low. A learning step, not an SDK defect.

**Workaround used.** Zod schemas throughout `src/mcp/tools.ts`.

**Actionable suggestion.** In a porting guide, put a wire JSON Schema beside both accepted
`registerTool` forms. The runtime message is already clear.

## 9. ExcelJS gives every cell of a merge the same value, so provenance must be kept separately

**Task attempted.** Keep track of which values were inherited from a merged cell, because
Landmark tells a listener that "3 cells take their label from a merged block". Owner: our ingest
adapter, with a documentation suggestion for spreadsheet-reading libraries. Reproduced
September 13 with ExcelJS 4.4.0.

**Steps taken.** Wrote a workbook with A1:A3 merged and "Engineering" in A1, saved and reloaded
it with ExcelJS, and read each cell's value, `isMerged`, `master.address` and the sheet's merge
list. [Results](feedback-evidence/legacy-probe-results.json).

**Expected vs actual.** Expected a value read to tell the anchor from the covered cells. All
three cells returned "Engineering", each with master A1; the merge list was an array of ranges.
The value alone cannot say where it came from. No second ExcelJS version was tested.

**Severity rating.** Medium for this project. ExcelJS computes nothing wrongly; a value-only
copy just loses what we need to explain.

**Workaround used.** `src/ingest/read.ts` keeps the merge ranges beside the grid, and
`src/table/header.ts` records for every cell whether its value was written or inherited.

**Actionable suggestion.** A short recipe in the documentation for carrying address, value,
merge anchor and span together through an import, with a round-trip example.

## 10. In PowerShell, `npm run x -- --flag value` loses the `--`, and npm keeps the flag

**Task attempted.** Run the documented ingest command, which passes an output path after `--`,
from PowerShell on Windows. Owner: npm's PowerShell shim (`npm.ps1`) and npm's documentation.
Reproduced September 27, 2026 with PowerShell 7.6.6, npm 11.7.0 and Node 23.11.0 on Windows 11.

**Steps taken.** Made a throwaway package whose script prints the arguments it receives and
`npm_config_out`. Ran `npm run show -- a.xlsx --out b.json` in PowerShell, then with
`--out=b.json`, then with the dash quoted (`'--'`), then through `npm.cmd`, and once in Git Bash.
`Get-Command npm` resolves to `C:\Program Files\nodejs\npm.ps1`.

**Expected vs actual.** Expected the script to receive `a.xlsx --out b.json`, as it does in Git
Bash. In PowerShell the bare `--` never reaches npm, so npm reads `--out` as its own setting. It
warns `Unknown cli config "--out"` and `"b.json" is being parsed as a normal command line
argument`, and the script receives `["a.xlsx","b.json"]`. With `--out=b.json` the script
receives only `["a.xlsx"]`, and the path turns up in the environment as `npm_config_out`. With
`'--'` quoted, or through `npm.cmd`, all three arguments arrive.

**Severity rating.** Medium for us. Before our fix, `npm run ingest -- <files> --out=<path>` in
PowerShell ignored the path, overwrote the default `data/index.json`, which is the demo's own
index, and exited 0.

**Workaround used.** The ingest CLI now reads `npm_config_out` when npm kept the flag, and
refuses, writing nothing, when a bare path shows npm took `--out` (`test/ingest-cli.test.ts`:
"an --out that npm kept for itself still decides where the index goes"). Its message tells
PowerShell users to quote the dash: `npm run ingest '--' <files> --out <path>`.

**Actionable suggestion.** Have `npm.ps1` pass a bare `--` through to npm, or have npm's
`run-script` documentation say that PowerShell users must quote it, and say in the warning that
the flag was not passed to the script.
