# Friction log — evidence-qualified revision

Updated September 13, 2026, against Landmark commit `60dc1881e73f10d9c219f5eabb6fe3d5da69623d`.

This is a retrospective reconstruction from committed notes, code, saved reviews and explicitly dated local probes. It is not a contemporaneous diary. No time-to-hello-world measurements are available. Documentation observations are labelled separately from runtime attempts. Severity is our engineering assessment, not a vendor rating.

FL01–FL03 concern Amazon documentation that we read; FL04–FL07 concern third-party tools and our integration. We have not run the Alexa+ private toolkit, an Alexa simulator/device, or an AWS service. There is no claim of a production incident.

The optional bonus is discretionary and capped at 10%; it is not a guaranteed 10% component. Product feedback is required separately. [Official rules](https://amazonappdev2026.devpost.com/rules).

For compact form space, prioritize FL01, FL02, FL03 and FL04, retaining their scope labels. See [feedback](PRODUCT-FEEDBACK.md), [requests](FEATURE-REQUESTS.md), [evidence and exclusions](FRICTION-EVIDENCE.md), and [internal application friction](INTERNAL-FRICTION.md). Our application defects are not attributed to Amazon.

## FL01 — Reconcile the Alexa+ lifecycle example with the supported revision

**Task attempted.** Determine the wire revision to demonstrate. Owner: Amazon Alexa+ documentation. Observation: documentation review on September 10–13, 2026; no Alexa client was run.

**Steps taken.** Compare the Toolkit Overview, the lifecycle initialize request/response, and the hackathon requirement; check the local initialize assertion in `test/wire.test.ts:78`.

**Expected vs actual.** Expected a consistent target or an explicit compatibility note. The overview identifies 2025-11-25, while both lifecycle examples still carry 2025-03-26. These can coexist as compatibility examples, but that purpose is not explained beside the payloads. [Overview](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html); [lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html).

**Severity rating.** Medium — required extra cross-checking of the compliance target. No rejection or measured delay is claimed.

**Workaround used.** Pin SDK 1.30.0 and assert a real 2025-11-25 initialize exchange. Treat the SDK fallback date as backwards compatibility, not the target. The local client exchange passed; Alexa negotiation remains untested.

**Actionable suggestion.** Put a revision label beside each payload and add a 2025-11-25 request/response pair with an executable assertion. Retain older examples only with their compatibility purpose stated.

## FL02 — Determine the prerequisite for private Alexa+ tooling

**Task attempted.** Find the path from public documentation to an authorized local development environment. Owner: Amazon Alexa+ onboarding documentation. This was a documentation walkthrough, not an attempted private-package installation.

**Steps taken.** Read Toolkit Overview, then Set Up Your Development Environment through the AWS-account and scoped-registry steps, from a Windows/Node 23 development environment in Vietnam.

**Expected vs actual.** Expected the first setup page to distinguish public MCP development from private-toolkit access. The overview states US availability; setup lists macOS/Ubuntu and Node 24+, and assumes an AWS account already supplied to an Alexa Solutions Architect before private CodeArtifact setup. We could not establish an applicable onboarding route from those instructions. This is not proof that every Vietnam account is rejected. [Setup](https://www.developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html).

**Severity rating.** Medium for integration planning; no blocker to the independent MCP path. No failed login, CLI 404, elapsed onboarding time or support refusal is claimed.

**Workaround used.** Build and test the public MCP server with a custom browser client. No AWS credentials, role assumption, registry changes, private CLI or Alexa simulator were used.

**Actionable suggestion.** Add a prerequisites gate at the top: access status, supported developer locations/OS, how to request access, and the public MCP route for entrants without toolkit access. Provide a harmless preflight that explains missing authorization before credential setup.

## FL03 — Resolve conflicting service-token scope guidance

**Task attempted.** Review authorization boundaries before planning private user data. Owner: Amazon Alexa+ authentication documentation. Documentation-only observation, September 10–13; Landmark has no implemented OAuth flow.

**Steps taken.** Compare Client credentials runtime flow step 5 with Scope separation model and Token endpoint requirements item 6 on the same page.

**Expected vs actual.** Expected one scope rule. Step 5 names mcp:tools and singular mcp:resource for a service token, while the separation table and requirements reserve user scopes for authorization_code and restrict service tokens to mcp:service. [Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html).

**Severity rating.** High for a future private-data integration; no live authorization failure or data exposure was observed.

**Workaround used.** A3 records the restrictive interpretation and postpones real account linking. No service token was granted user data access.

**Actionable suggestion.** Align step 5 with the separation table, correct the resource/resources spelling, and provide a negative test showing that a service token cannot invoke a user-specific tool.

## FL04 — Preserve a Streamable HTTP response until it is consumed

**Task attempted.** Return an MCP tool result from a per-request Web-standard handler. Owner: our integration, with a documentation suggestion for the MCP TypeScript SDK maintainers. Historical log corroborated by a controlled local reproduction on September 13.

**Steps taken.** Use SDK 1.30.0, register delayed_echo with a 30 ms synthetic delay, connect a fresh transport, await handleRequest, then immediately close the transport. Repeat while keeping it open through body consumption, and with enableJsonResponse enabled. [Probe](feedback-evidence/probe.mjs).

**Expected vs actual.** Expected the tool result to survive handler return. Premature close produced HTTP 200, text/event-stream, empty body. Keeping the transport open produced the SSE result; JSON mode also returned the result. Stateless deployment and SSE are compatible when lifetime is managed correctly. This was local, not a Cloudflare or Alexa outage. [Results](feedback-evidence/legacy-probe-results.json).

**Severity rating.** Medium — the original lifecycle pattern loses the response without an HTTP error. The 30 ms is a probe input, not a measured platform latency.

**Workaround used.** The product already uses enableJsonResponse: true at `src/server.ts:115`. The probe verifies this response-lifetime workaround; it does not certify the whole server.

**Actionable suggestion.** Add a per-request Web Response example showing when cleanup is safe, including a delayed tool. Explain the JSON-response option for finite calls. Do not describe JSON as mandatory for all stateless deployments or treat close as an automatic flush.

## FL05 — Translate a wire JSON Schema into the SDK registration API

**Task attempted.** Register a tool from a schema initially expressed as JSON Schema. Owner: our SDK integration; low-priority API-onboarding feedback. The old log reported a type error; that original compiler output was not preserved.

**Steps taken.** On September 13, call registerTool with a Zod raw shape, a z.object(), and a plain JSON Schema object using the installed SDK 1.30.0/Zod 3.25.76. Call the valid tools through Streamable HTTP. [Probe and results](feedback-evidence/legacy-probe-results.json).

**Expected vs actual.** Expected to identify the accepted registration representation. Both Zod forms succeeded and returned the supplied value. Plain JSON Schema was rejected with a message explicitly requiring a Zod schema or raw shape. The old claims that z.object() is unsupported and runtime errors give no guidance are not supported.

**Severity rating.** Low — a schema-adapter learning step, not a confirmed SDK defect.

**Workaround used.** Use the Zod schemas already present in `src/mcp/tools.ts`. Do not bypass the type checker to pass a wire schema.

**Actionable suggestion.** In a porting example, place a wire JSON Schema beside both valid registerTool inputs and explain the distinction. The runtime diagnostic already exists; do not request it as a missing feature.

## FL06 — Retain merge provenance after ExcelJS expands cell values

**Task attempted.** Preserve which values are inherited from a merge when building the speech index. Owner: our ingest adapter; feedback to spreadsheet-adapter authors. Historical code comments corroborated with ExcelJS 4.4.0 on September 13.

**Steps taken.** Create an XLSX with A1:A3 merged and Engineering at A1; serialize and reload with ExcelJS. Inspect values, isMerged, master.address and worksheet.model.merges. [Results](feedback-evidence/legacy-probe-results.json).

**Expected vs actual.** Expected value-only reads to distinguish anchors from covered cells. All three cells returned Engineering; their master was A1. The model merge list was an array. No second ExcelJS version or object-shaped model was verified. The accessibility provenance must therefore be retained separately from the returned value.

**Severity rating.** Medium — value-only copying erases an explanation the product promises. This is an adapter issue, not evidence that ExcelJS computed the wrong value.

**Workaround used.** Keep merge spans from `src/ingest/read.ts:94` and mark origin independently of whether a value needed filling in `src/table/header.ts:82`.

**Actionable suggestion.** Provide a minimal ingest recipe carrying address, value, merge anchor and span together, plus a round-trip fixture. Prefer the public cell master/isMerged API where suitable. Do not claim undocumented multi-version behavior without named versions and reproductions.

## FL07 — Match TypeScript checking to Node strip-only execution

**Task attempted.** Run project TypeScript directly on Node 23.11.0. Owner: our toolchain configuration. Historical note corroborated on September 13.

**Steps taken.** Import a minimal class with a constructor parameter property under --experimental-strip-types. Check the installed TypeScript version and whether its CLI accepts --erasableSyntaxOnly.

**Expected vs actual.** Expected compile-time validation to catch syntax rejected by our runtime path. Node raised ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX; installed TypeScript 5.7.2 rejected --erasableSyntaxOnly as unknown. Node documentation already recommends TypeScript 5.8+ with that option. The old assertion that Node docs omit it is false. [Node documentation](https://nodejs.org/docs/latest-v23.x/api/typescript.html); [local results](feedback-evidence/legacy-probe-results.json).

**Severity rating.** Low — known syntax/runtime mismatch, not a Node regression.

**Workaround used.** The product declares QueryError.nextStep as a field and assigns it in the constructor (`src/query/engine.ts:87`). No compiler or runtime upgrade was installed in A7.

**Actionable suggestion.** Add a project toolchain check pairing runtime and compiler capabilities. When upgrading, enable the documented erasable-syntax check on a supporting compiler and repeat runtime imports. Do not promise that adding the flag to TypeScript 5.7 fixes it.
