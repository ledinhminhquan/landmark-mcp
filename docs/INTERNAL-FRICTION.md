# Internal application friction — observed review cases

These cases belong to Landmark. They are not complaints about Amazon, Cloudflare, Node or MCP. Seventeen entries correspond to observed September 12 A5 findings; APP-X01 adds a saved conditional locale probe and states its assumption. They are not claimed as incidents during the original September 8–9 build. None was fixed by this documentation revision.

Evidence: [A5 module results](feedback-evidence/a5-reproduction-results.json), [A5 runtime results](feedback-evidence/a5-runtime-results.json), [audit](feedback-evidence/a5-npm-audit.json). Paths/lines refer to baseline commit `60dc1881e73f10d9c219f5eabb6fe3d5da69623d`. No real user data, microphone, deployed Worker, Alexa device or simulator was involved. The probe descriptions below distinguish actual local calls from doubles.

Do not paste these as vendor failures to seek a bonus. Use them to explain project learning and prioritize fixes. Source-only or uncorroborated historical items are listed separately in the evidence ledger.

## APP-F01 — Preserve data in an all-text table

**Task attempted.** Preserve data in an all-text table. Owner: Landmark. Evidence anchor: `src/table/header.ts:223; src/ingest/build.ts:67`; A5 case `allTextHeader`.

**Steps taken.** Ingest Name,City plus Alice/Paris, Bob/London, Cara/Rome using the original inference/build modules.

**Expected vs actual.** Expected the named task to complete correctly. Three records expected; only Cara/Rome remained, with the other rows classified as headers and confidence 1.

**Severity rating.** High for this application.

**Workaround used.** No general workaround was verified; the A6 demo uses a separately checked numeric Budget fixture.

**Actionable suggestion.** Require explicit header confirmation when ambiguous and preserve all records.

## APP-F02 — Resolve a fully qualified revenue column

**Task attempted.** Resolve a fully qualified revenue column. Owner: Landmark. Evidence anchor: `web/app.js:206`; A5 case `mergedColumnRouting`.

**Steps taken.** Route total 2025 Q2 revenue while disabling only filename matching to isolate column resolution.

**Expected vs actual.** Expected the named task to complete correctly. Expected 2025 Q2 / 1850; selected 2026 Q1 / 2100. A comparison utterance also did not create a comparison.

**Severity rating.** High for this application.

**Workaround used.** A6 avoids this multi-year query; no general voice fix was made.

**Actionable suggestion.** Resolve full header paths and clarify ambiguous candidates.

## APP-F03 — Explain both operands of a cross-sheet comparison

**Task attempted.** Explain both operands of a cross-sheet comparison. Owner: Landmark. Evidence anchor: `src/mcp/tools.ts:583; src/mcp/tools.ts:456`; A5 case `crossSheetProvenance`.

**Steps taken.** Compare Left revenue 61050 with Right revenue 5, then request explanation.

**Expected vs actual.** Expected the named task to complete correctly. Difference 61045 was correct; provenance retained only the left sheet identity.

**Severity rating.** High for this application.

**Workaround used.** A6 demonstrates a single-sheet explanation only.

**Actionable suggestion.** Store table/sheet/path per operand and render both sources.

## APP-F04 — Keep answer IDs unique across store instances

**Task attempted.** Keep answer IDs unique across store instances. Owner: Landmark. Evidence anchor: `src/mcp/store.ts:119; src/worker.ts:30`; A5 case `kvCollision`.

**Steps taken.** Create two original KVStore instances backed by one deterministic in-memory KV double; put two different answers.

**Expected vs actual.** Expected the named task to complete correctly. Both returned a1; the second overwrote what the first instance subsequently read. No cloud concurrency test occurred.

**Severity rating.** High for this application.

**Workaround used.** No shared public deployment was performed.

**Actionable suggestion.** Use globally unique IDs plus authenticated ownership namespaces.

## APP-F05 — Keep caller bookmarks separate

**Task attempted.** Keep caller bookmarks separate. Owner: Landmark. Evidence anchor: `src/mcp/store.ts:140; src/server.ts:76`; A5 case `sharedBookmarks`.

**Steps taken.** Use synthetic callers A/B against one handler; save and resume the same bookmark name.

**Expected vs actual.** Expected the named task to complete correctly. B could read A’s note and overwrite the position A later resumed. Synthetic data only.

**Severity rating.** High for this application.

**Workaround used.** No verified multi-user workaround exists in the product.

**Actionable suggestion.** Bind storage keys and authorization to an authenticated owner.

## APP-F06 — Serve the voice UI from the Worker entry point

**Task attempted.** Serve the voice UI from the Worker entry point. Owner: Landmark. Evidence anchor: `src/worker.ts:33; wrangler.jsonc:4`; A5 case `workerAssets`.

**Steps taken.** Call the original Worker.fetch for / and /app.js using the local review environment.

**Expected vs actual.** Expected the named task to complete correctly. Expected UI/assets; / returned 406 JSON and /app.js returned 404. The local Node UI returned HTML 200.

**Severity rating.** High for this application.

**Workaround used.** Use the verified local Node UI for the explicitly labelled local demo.

**Actionable suggestion.** Configure assets and MCP routing before deployment.

## APP-F07 — Reject an untrusted Origin

**Task attempted.** Reject an untrusted Origin. Owner: Landmark. Evidence anchor: `src/server.ts:117; src/local.ts:117`; A5 case `invalidOrigin`.

**Steps taken.** Send a tools/list POST carrying Origin https://untrusted.invalid to the original handler.

**Expected vs actual.** Expected the named task to complete correctly. The configured server returned 200 instead of rejecting the disallowed origin. No DNS-rebinding attack was performed.

**Severity rating.** High for this application.

**Workaround used.** A3 has a separate reference with Origin checks; Landmark was not patched.

**Actionable suggestion.** Validate Origin/Host by environment and bind local hosting to loopback.

## APP-F08 — Select the intended table from a spoken label

**Task attempted.** Select the intended table from a spoken label. Owner: Landmark. Evidence anchor: `web/app.js:184`; A5 case `demoBudgetSelection / yearMatchesFilename`.

**Steps taken.** With the default catalog, route what’s in the budget file; also route a year-bearing query from the merged-header context.

**Expected vs actual.** Expected the named task to complete correctly. Budget description stayed on Sales; a year token also matched a numbered filename and switched tables.

**Severity rating.** High for this application.

**Workaround used.** A6 preselects Budget using the verified describe title command and discloses that setup.

**Actionable suggestion.** Use sheet/region aliases and word boundaries; exclude filename ordinal tokens.

## APP-F09 — Complete an aggregate after a clarification

**Task attempted.** Complete an aggregate after a clarification. Owner: Landmark. Evidence anchor: `web/app.js:300; web/app.js:334`; A5 case `demoEngineering`.

**Steps taken.** Describe Budget and route total for engineering. Inspect the response and follow-up routing.

**Expected vs actual.** Expected the named task to complete correctly. First turn asked Which column instead of returning 560000. Losing the pending intent on a later Amount reply is source-verified, not a live microphone observation.

**Severity rating.** High for this application.

**Workaround used.** A6 uses the tested explicit total amount for engineering wording.

**Actionable suggestion.** Retain a pending intent and fill the missing parameter on the next turn.

## APP-F10 — Continue to the next rows

**Task attempted.** Continue to the next rows. Owner: Landmark. Evidence anchor: `src/mcp/tools.ts:483; web/app.js:269`; A5 case `rowPagination`.

**Steps taken.** Read start_row 1, limit 2; send the router’s more arguments including cursor 3.

**Expected vs actual.** Expected the named task to complete correctly. The schema discarded cursor and rows Anh/Bao were repeated instead of advancing.

**Severity rating.** High for this application.

**Workaround used.** No repaired pagination flow was tested; A6 avoids it.

**Actionable suggestion.** Align tool schema, description, result and client continuation parameters.

## APP-F11 — Save and restore the current reading position

**Task attempted.** Save and restore the current reading position. Owner: Landmark. Evidence anchor: `web/app.js:274; src/mcp/tools.ts:667`; A5 case `bookmarkRouting`.

**Steps taken.** Use a valid table at row 3, route save my place and then carry on.

**Expected vs actual.** Expected the named task to complete correctly. Save recorded row 1; resume listed names rather than restoring context.

**Severity rating.** High for this application.

**Workaround used.** A6 removes the save/reload/resume demonstration.

**Actionable suggestion.** Track actual position and explicitly restore the selected bookmark’s context.

## APP-F12 — Retain a bookmark across a new handler lifetime

**Task attempted.** Retain a bookmark across a new handler lifetime. Owner: Landmark. Evidence anchor: `src/worker.ts:29; wrangler.jsonc:14`; A5 case `restartPersistence`.

**Steps taken.** Save with the default store, construct a new handler and resume.

**Expected vs actual.** Expected the named task to complete correctly. No bookmark survived. This is a new-instance/restart simulation, not a measured Cloudflare eviction.

**Severity rating.** High for this application.

**Workaround used.** No durable default was installed; do not claim persistence from a browser reload.

**Actionable suggestion.** Configure durable storage and repeat process-restart tests after owner/ID fixes.

## APP-F13 — Count by group and explain the rows counted

**Task attempted.** Count by group and explain the rows counted. Owner: Landmark. Evidence anchor: `src/query/engine.ts:272; src/voice/speak.ts:228`; A5 case `groupedCount / countExplain`.

**Steps taken.** Request count grouped by Region, then explain a count result.

**Expected vs actual.** Expected the named task to complete correctly. Returned total 5 with empty groups; explanation named 0 of 5 and described one cell.

**Severity rating.** Medium for this application.

**Workaround used.** No workaround validated for grouped count; A6 uses sum.

**Actionable suggestion.** Implement grouped count or reject that combination explicitly; represent row provenance.

## APP-F15 — Deliver a result to the hand-written MCP Apps widget

**Task attempted.** Deliver a result to the hand-written MCP Apps widget. Owner: Landmark. Evidence anchor: `src/mcp/widget.ts:157`; A5 case `widgetProtocol`.

**Steps taken.** Run the original iframe script in a DOM/message double and dispatch a standard tool-result notification.

**Expected vs actual.** Expected the named task to complete correctly. No initialization messages were sent and the display stayed on its waiting text. No real Apps host was tested.

**Severity rating.** Medium for this application.

**Workaround used.** A6 uses visible source evidence with disclosed editorial highlighting, not a working Apps widget claim.

**Actionable suggestion.** Implement the extension lifecycle and payload contract, then verify in a real host.

## APP-F16 — Read a valid priming SSE event in the custom browser MCP client

**Task attempted.** Read a valid priming SSE event in the custom browser MCP client. Owner: Landmark. Evidence anchor: `web/app.js:49`; A5 case `validSsePriming`.

**Steps taken.** Feed the original client an SSE response with an empty priming data event before the JSON-RPC response.

**Expected vs actual.** Expected the named task to complete correctly. Connect failed with Unexpected end of JSON input. This was a standards fixture, not a live server outage.

**Severity rating.** Medium for this application.

**Workaround used.** The current product server uses JSON and the A6 local HTTP sequence passes.

**Actionable suggestion.** Use an appropriate client transport or a complete SSE parser that matches response IDs.

## APP-F17 — Start the compiled package

**Task attempted.** Start the compiled package. Owner: Landmark. Evidence anchor: `package.json:10; package.json:16; tsconfig.json:9`; A5 case `A5 build/start record`.

**Steps taken.** During A5 run the existing build, then npm start. Inspect main/bin/dev against emitted files.

**Expected vs actual.** Expected the named task to complete correctly. Build passed; start failed because dist/index.js does not exist. The compiler emits dist/src files.

**Severity rating.** Medium for this application.

**Workaround used.** npm run serve starts the local app with installed dependencies.

**Actionable suggestion.** Align entry points and run the published start command on a clean checkout.

## APP-F18 — Reconcile security notes with the resolved dependency tree

**Task attempted.** Reconcile security notes with the resolved dependency tree. Owner: Landmark. Evidence anchor: `docs/SECURITY-NOTES.md:3; package-lock.json:3180`; A5 case `saved npm-audit.json`.

**Steps taken.** Read the lockfile and saved September 12 npm audit alongside SECURITY-NOTES.md.

**Expected vs actual.** Expected the named task to complete correctly. Notes discussed only two moderate entries; the audit had five affected-package entries, including three high along one dev-toolchain chain. These are not five independent flaws or proof of compromise.

**Severity rating.** Medium for this application.

**Workaround used.** No dependency upgrade or audit fix was applied; risk remains recorded for review.

**Actionable suggestion.** Review applicable advisories, validate a compatible update and regenerate notes from the reviewed lockfile.

## APP-X01 — Interpret a comma-decimal number without silently changing its value

**Task attempted.** Interpret a comma-decimal number without silently changing its value. Owner: Landmark. Evidence anchor: `src/table/infer.ts (asNumber); A5 reproduce.ts:153`; A5 case `localeNumber`.

**Steps taken.** The saved A5 probe calls our asNumber helper with the string 1.234,56. This is a conditional locale case, not an additional numbered A5 finding.

**Expected vs actual.** Expected the named task to complete correctly. Actual numeric output was 1.23456. If the source intended a decimal comma and grouping dot, its value is 1234.56. That expected interpretation is conditional; no real customer file or declared locale was tested.

**Severity rating.** Medium, conditional on the source locale for this application.

**Workaround used.** No locale-aware fix was made. Use already-numeric verified fixtures for the current demo.

**Actionable suggestion.** Ask for or preserve the source number convention and reject ambiguous text instead of silently changing magnitude.
