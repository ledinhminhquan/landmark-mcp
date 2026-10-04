# Evidence ledger and exclusions

Updated October 4, 2026. This file says where each friction-log entry's evidence is, and what
was withdrawn or narrowed along the way.

The repository has 18 commits, from September 8 to September 18, 2026; the September 27 fixes
come on top of them. The first friction log entered the repository in one commit (`de5e2f9`,
September 9) without the failing console output behind it. Later entries were written from
reproductions made on the dates given. Code corroborates several of the early remedies, but it
cannot prove elapsed times or that every early incident happened as first told, so no elapsed
time is claimed anywhere.

## Evidence for each friction-log entry

| Entry | Evidence | Qualification |
|---|---|---|
| 1. Lifecycle example revision | Overview (last updated Aug 3, 2026) and lifecycle page (Jul 10, 2026), read September 27; `test/wire.test.ts`: "negotiates exactly the revision the hackathon requires" | A documentation mismatch, not an observed Alexa negotiation failure. |
| 2. Partner-only status missing from setup pages | Overview and setup pages; hackathon FAQ, read September 27; overview, setup page and the add-on docs home re-read October 4 | The docs home does carry the partner-only notice; the entry is about the pages a developer following the guide lands on. No private CLI install, contact attempt or account rejection is claimed. |
| 3. Service-token scopes | Authentication page: runtime-flow step 5 against the scope table and token requirements, re-checked September 27 | A documentation inconsistency, not a live security finding. |
| 4. Who writes the spoken reply | Functional Requirements §2 and §9, "The Conversation Surface", "Tools, Schema, and Data Design" (all last updated Jul 21, 2026), read September 27 | How Alexa+ actually treats a `spoken` field is unknown; we could not run it. |
| 5. Accessibility checks need a device | "Design Guide: Accessibility" and "Test Your Add-on Customer Experience" (Jul 21, 2026); hackathon FAQ; read September 27 | No device or simulator was available to try. |
| 6. Transport closed too early | [Probe](feedback-evidence/probe.mjs) and [results](feedback-evidence/legacy-probe-results.json), September 13; re-run in a clean clone September 27, and against SDK 1.32.0 on October 4 | The early-close failure reproduces with a delayed tool; SSE works when the transport is kept open. The committed results are the SDK 1.30.0 run. |
| 7. Refused arguments | Reproduced September 27 with a throwaway script (steps in the entry), and again October 4 with SDK 1.32.0; `createToolError` is declared `private` in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` in both versions; `src/server.ts` (`speakRefusals`); `test/integration.test.ts` | The script is not committed; the entry gives enough to repeat it. |
| 8. JSON Schema against Zod | Same probe results, schemas section; `src/mcp/tools.ts` | Both Zod forms work; the runtime already explains the JSON Schema refusal. The original compiler message was not kept. |
| 9. ExcelJS merges | Same probe results, merges section; `src/ingest/read.ts`; `src/table/header.ts` | Only ExcelJS 4.4.0 was tested. |
| 10. npm and PowerShell | Reproduced September 27 with a throwaway package (steps in the entry); `test/ingest-cli.test.ts`; the `--titles` case run by hand in PowerShell on October 4 | PowerShell 7.6.6, npm 11.7.0, Node 23.11.0 on Windows 11 only. The `--titles` case has no automated test. |
| 11. Tool call without `arguments` | Reproduced October 4 with throwaway scripts against SDK 1.30.0 and 1.32.0, over the Web-standard transport and with the SDK's own client in process (steps in the entry); `CallToolRequestParamsSchema` in the SDK's `dist/esm/types.js`; the SDK's pull requests #1404, #2045 and #2931 and issue #1869, read October 4; `test/transport.test.ts` | The scripts are not committed. Which real MCP hosts leave `arguments` out is untested. Found by a review of this project, not reported by a user. |

To repeat the September 13 probes from the repository root:

```powershell
node docs/feedback-evidence/probe.mjs
```

It makes synthetic local tool calls, builds an in-memory workbook and invokes the installed
compiler and runtime. It needs no network, installation or credentials. It **rewrites**
`legacy-probe-results.json` and `probe-progress.txt` beside itself, so run it in a copy if you
want the committed results left alone. In this build it runs against SDK 1.32.0, but the
`versions.sdk` field it writes is a fixed string, `1.30.0`, the version the committed results
came from; check `node_modules/@modelcontextprotocol/sdk/package.json` for the version a re-run
actually used. Its expected negative cases are the errors being documented, not failing tests.

## Withdrawn or narrowed statements

| Earlier statement | What became of it |
|---|---|
| "Written while building, not reconstructed afterwards" (first friction log) | Withdrawn. The log is reconstructed from evidence and says so. |
| Five first-hand entries in the required format (first submission draft) | Replaced. The old entries did not all have the six fields; every entry now does. |
| "SDK onboarding took under an hour" (first submission draft) | Omitted. Nothing measured it. |
| SSE cannot work with stateless handling | Narrowed to our own early cleanup (entry 6), with a working SSE control. |
| `registerTool` rejects `z.object()` | Refuted by a working call (entry 8). |
| The SDK's fallback revision proves wrong negotiation | Wrong inference. A negotiated 2025-11-25 exchange is tested instead. |
| ExcelJS merge models change shape between versions | Unverified: no second version was named or reproduced. Not claimed. |
| Node's documentation omits `erasableSyntaxOnly` | Refuted: Node 23's TypeScript page recommends it with TypeScript 5.8 or later. The mismatch is our toolchain, now recorded in [INTERNAL-FRICTION.md](INTERNAL-FRICTION.md). |
| Toolkit access is impossible for everyone outside the partner programme | Narrowed to what is documented: the hackathon FAQ, read September 27, says there is "no way for hackathon participants to apply for or gain access". |
| The MCP Apps widget "worked first time" | Withdrawn. It did not complete a handshake at the time. It now does in a simulated host (`test/engine-widget.test.ts`), and it has still not been tried in a real MCP Apps host. |
| The extension package's version and React peer dependencies ruled it out (`src/mcp/widget.ts` comment) | Narrowed. The 1.7.5 line is compatible and its React peers are optional (npm registry metadata, checked September 13); the comment now gives a design reason, that one static document does not justify the dependency, not an install failure. Not in the friction log. |
| A per-request store destroyed explain and resume (early notes) | A historical note without its failing revision. The restart loss found later is a separate case in [INTERNAL-FRICTION.md](INTERNAL-FRICTION.md); they are not counted as two reproduced incidents. |
| The merged-header fix broke stacked headers, then multiple tables | Explains why the golden fixtures exist, but the failing intermediate patch is gone. Not reconstructed by guessing. |
| The screen-reader pitch was corrected | An editorial lesson. No JAWS or NVDA session was run for this project. |
| The scripted demo cut its own speech short | Found by reading the code, then measured in a browser on September 27 before the fix. The page now waits for speech to end; it has not been re-timed with audio since. The demo script runs one line at a time anyway. |
| Bookmarks last "across days, backed by KV" | Withdrawn. KV was never bound. On the Worker, state is now in Durable Objects; locally it is memory. |
| "No cold start" on Workers | Not measured on Cloudflare; nothing is deployed. Locally, `wrangler check startup` reported 68–96 ms of active startup CPU in two runs. |
| Test and tool counts of 60, 62 or 100 tests and "eight tools" | Out of date. This build has 615 tests and nine tools. |
| "Answers and reads keep working" when a free-plan Worker's quota runs out (security notes, September 27) | Narrowed on October 4. True of the daily rows-written limit only. When the daily Durable Object request limit is spent, every table tool except the listing fails for callers that send a session id. See [SECURITY-NOTES.md](SECURITY-NOTES.md). |
| `npm audit`: "2 moderate, 0 high" (security notes, September 27) | True that day, out of date a week later: advisories published September 28 and 29 made it 8 vulnerabilities, 2 of them high. A lockfile update and Wrangler 4.147.0 brought it back to 2 moderate on October 4, and the notes now give both. |
| Speech-recognition error fallback, late responses, remote cold starts | Risks derived from code, not observed service incidents. |
| Cloudflare signup, payment and deploy experience | No account or deployment evidence. Nothing invented to fill the gap. |

## Coverage and attribution

Every friction item from the project's history is either rewritten with evidence or accounted
for above. Our own defects are in [INTERNAL-FRICTION.md](INTERNAL-FRICTION.md), never in the
vendor log. Mistakes in our own probe scripts (for example, reusing a stateless transport across
probe requests) were fixed as probe bugs and are not presented as product friction.

Not verified by anyone on this project: any AWS runtime service, Amazon's private toolkit, a
real Alexa device or simulator, a real MCP Apps host, or a deployed Worker. Product feedback and
friction entries do not make the application release-ready.
