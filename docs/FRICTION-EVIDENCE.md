# A7 evidence ledger and exclusions

Audit date: September 13, 2026. Baseline: `60dc1881e73f10d9c219f5eabb6fe3d5da69623d`. The repository has nine commits. The earlier log entered the repository in one commit, `de5e2f9`; it was not accompanied by original failing console transcripts. Code corroborates several remedies, but does not prove exact elapsed time or that every incident occurred as narrated. New local probes are explicitly dated A7.

## Published log evidence

| Entry | Primary evidence | Qualification |
|---|---|---|
| FL01 | Official Amazon lifecycle and overview URLs in the entry; `test/wire.test.ts:78`; A5 actual client result | Documentation mismatch, not an observed Alexa negotiation failure. SDK fallback date is legitimate compatibility behavior. |
| FL02 | Official environment setup and overview; prior A3 walkthrough re-read in A7 | No private CLI install, npm 404 test, contact attempt or account rejection is claimed. |
| FL03 | Official authentication page: runtime-flow step 5 versus scope table/token requirements | Documentation inconsistency, not a live security finding. |
| FL04 | [A7 probe](feedback-evidence/probe.mjs), [results](feedback-evidence/legacy-probe-results.json); `src/server.ts:105`; historical `de5e2f9` log #1 | The early-close failure was reproduced with a delayed tool. SSE works with correct lifetime. |
| FL05 | Same A7 results, schemas section; `src/mcp/tools.ts`; historical log #2 | Zod raw shape AND z.object work. Runtime already explains unsupported JSON Schema. The exact original TypeScript diagnostic was not preserved. |
| FL06 | Same A7 results, merges section; `src/ingest/read.ts:94`; `src/table/header.ts:82` | Only ExcelJS 4.4.0 tested. Array merge list and public master relationship observed. No cross-version object-shape claim. |
| FL07 | Same A7 results, parameterProperty/erasableFlag; `src/query/engine.ts:87`; official Node23 documentation | Node error reproduced; TS5.7.2 lacks the flag. Node docs explicitly explain it for newer TypeScript. |

Run the optional small reproduction from the repository root with existing compatible dependencies:

```powershell
node docs/feedback-evidence/probe.mjs
```

It makes synthetic local tool calls, creates an in-memory workbook and invokes the existing compiler/runtime. It writes its results beside itself. Expected negative cases are errors being documented, not a product test suite passing. No network, installation or credentials are needed. The original A3/A5/A6 research scripts remain in the workspace handoff; the JSON copies here expose the observations used in these drafts.

## Withdrawn or qualified historical statements

| Earlier statement / source at baseline | Disposition |
|---|---|
| “Written while building, not reconstructed afterwards”; original FRICTION-LOG:3 | Withdrawn for this revision. We are reconstructing from evidence; do not fabricate a contemporaneous diary. |
| Five first-hand entries in exact format; SUBMISSION:186 | Replaced. Old entries had separate expected/actual fields and some omitted a workaround. The new log has exactly six named fields per entry. |
| SDK onboarding took under an hour; SUBMISSION:157 | Omitted. No trustworthy elapsed-time measurement. |
| SSE conflicts inherently with stateless handling; old log #1 | Narrowed to our premature cleanup, with a successful SSE control. |
| registerTool rejects z.object; old log #2 | Refuted by successful local call. |
| SDK default revision proves incorrect negotiation; old log #3 | Incorrect inference. Show a negotiated exchange; fallback constants alone are not a defect. |
| ExcelJS merge models change shape across versions; old log #4 | Unverified. No named second version or preserved reproduction. |
| Node docs omit erasableSyntaxOnly; old log #5 | Refuted by official Node23 documentation. |
| Toolkit access impossible for all non-partners; briefing / old log #6 | Not established by our account experience. Report only the documented prerequisite and unknown access path. |
| MCP Apps metadata worked first time; SUBMISSION:174 | Withdrawn as an interoperability claim; A5 F15 shows an incomplete hand-written bridge. |
| Extension-package version/React peer conflicts; widget.ts:19 | Design rationale in a comment, not an installed-package failure. Keep out of observed friction until exact package metadata/version evidence is supplied. |
| Per-request store destroyed explain/resume; SUBMISSION:102, server.ts:69 | Historical self-authored implementation note. Current shared store remedy is visible; original failing revision/transcript is absent. A5 restart loss is separately observed in APP-F12. Do not count both as independently reproduced incidents. |
| Merged-header fix regressed stacked header, then multiple tables; ingest.golden.test.ts:5 and SUBMISSION:104 | Historical note supports why fixtures were added. The intermediate failing patch is absent; no exact failing input/output or recovery sequence can honestly be reconstructed. Not promoted to a six-field observed vendor log. |
| Screen-reader pitch was corrected; SUBMISSION:122 | Editorial learning, not a screen-reader runtime incident. No JAWS/NVDA trial or disabled-user session was conducted here. |
| A5 F14 automatic script cuts TTS; index.html:216/236 and app.js:137 | Source-level ordering finding only; no audible run. A6 deliberately avoids batch playback. Not a first-hand speech failure log. |
| Recognition error fallback, late fetch response, remote cold starts | Code-derived risks or untested hypotheses, not observed service incidents. |
| Cloudflare signup/payment/cold-start experience | No account/deployment evidence. Do not fill the old placeholder with invented experience. |

## Coverage and attribution

Reviewed the commit history and current source/comments/tests/README/docs. Every explicit legacy friction item is either rewritten with evidence or accounted for above. Seventeen observed A5 findings plus one conditional number-locale probe are in INTERNAL-FRICTION.md; source-only F14 is excluded from that observed set. The historical header and multi-table regression claims were not recreated by guessing inputs. New A7 harness mistakes (for example, reusing a stateless transport across probe requests) were corrected as probe bugs, not presented as old product friction.

No AWS runtime service, Amazon private toolkit, real voice endpoint or live Apps host is verified. Feedback includes actual direct dependencies and relevant docs-only exposure, with untested surfaces explicitly labelled. Product feedback and logs do not make the application release-ready.
