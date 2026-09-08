# Devpost submission — draft text

Paste into the Devpost form. Every field the rules require has a section here.
**Check the bracketed items before submitting** — they need a URL or a decision only
you can supply.

---

## Track

**Alexa+** — self-hosted MCP server, spec revision 2025-11-25, Streamable HTTP.

## Mini challenge

**Open Source.** New MIT-licensed project, shipped during the hackathon window.
Repository: `https://github.com/ledinhminhquan/landmark-mcp`
Contribution URL: *(the same repo — it is a new open-source project rather than a PR
to an existing one, which the rules permit)*
GitHub username: `ledinhminhquan`

*Not entering AWS Builder: no AWS service is used, and claiming the category without
one would be false.*

---

## Elevator pitch *(200 characters)*

> Ask a spreadsheet questions out loud instead of walking it cell by cell. An MCP
> server that rebuilds the structure a file never declared — for blind and low-vision users.

## What it does

Landmark is a self-hosted MCP server that makes a spreadsheet answerable by voice.

Ask what is in a file and it orients you: size, column names, types, where the gaps
are, and what the file is hiding. Ask for a total, an average, a comparison or a
breakdown and it answers in one spoken sentence. Ask *how do you know* and it reads
back the exact cells the number came from.

That third one is the point. Research on blind spreadsheet users finds they never
fully trust a number they cannot verify — and over audio there is no cell to glance
at. So provenance is not a log line here, it is a tool.

## The problem, stated accurately

It is tempting to write "screen readers lose header context." That is not true, and an
accessibility-literate reader would rightly discount everything after it. JAWS and NVDA
both announce headers in Excel.

The real difficulty is narrower and harder to fix:

- **Header association is manual, per worksheet, and does not travel between readers.**
  NVDA issue #11801 has been open since November 2020 on exactly that.
- **Most files never declare structure at all.** The WebAIM Million (February 2026)
  observed 948,225 tables and found valid data-table markup on **19%** of them.
  Section508.gov states it plainly: *"Excel does not provide tools to make complex
  tables accessible."*
- **Even with headers announced, questions cost traversal.** "What is the total?" is
  O(rows). "Which region did best?" is O(rows × cols). There is no cheap way to learn a
  table's shape before committing to walking it.

A sighted reader answers all three with a glance — which costs nothing and is not
sequential. Landmark reconstructs the structure the file never declared, so the same
questions can be *asked* rather than *traversed*.

## How I built it

**Structure inference.** A spreadsheet declares a grid, not a table. The server detects
table regions separated by blank rows, scores which rows are headers and reports its
confidence rather than guessing silently, resolves merged blocks, and reconstructs a
full header path for every column. Four columns all labelled `Revenue` come back as
`2026, Q1, Revenue` … `2025, Q2, Revenue`.

**Arithmetic never happens in a language model.** Filtering and aggregation are
deterministic, in the server. A model that computes a total can be wrong in a way the
listener has no way to catch. Rows that could not be counted are named and excluded out
loud — *"the total across 47 of the 52 rows; five were empty"* is a different claim from
*"the total"*.

**Voice constraints are structural, not requested.** Every tool returns a `spoken` field
already inside a word budget, capped at five items with a continuation token, with
numbers scaled for listening and identifiers stripped before anything reaches a speaker.
A voice product whose brevity depends on the model remembering to be brief is a chatbot
that happens to be read aloud.

**The split is forced by the platform and useful anyway.** ExcelJS needs Node streams
and Buffer, which Cloudflare Workers do not have. So ingest runs offline in Node and
emits versioned JSON; the Worker does pure computation over it. A grouped aggregate over
2,000 rows measures **p95 4.2 ms** against a 500 ms voice budget, with no cold start.

**Eight tools, not eighteen.** There is no `get_cell`, `get_row` or `get_column` —
those would rebuild the cell-by-cell maze in tool form and hand the traversal problem
back to the model.

## Challenges

Three that cost real time, all written up in `docs/FRICTION-LOG.md`:

- The Streamable HTTP transport answered with SSE while my stateless handler closed it
  in a `finally` block, so the stream died before the message was written and every
  response came back as an empty 200. Silent failures are expensive.
- The store was constructed per request, which made `table_explain` and `table_resume`
  silently useless — every call succeeded and found nothing.
- A fix for merged headers regressed the stacked-header case, and a fix for that
  regressed a sheet holding three tables. Structure inference is heuristic, so the six
  golden fixtures exist precisely because improving one shape can quietly break another.

## Accomplishments

Sixty-two tests, typecheck clean under `strict` with `noUncheckedIndexedAccess`. The
protocol revision is asserted, so a dependency bump cannot silently change it. Every
example in the README is verbatim output from a real call.

And a specific, reproducible claim rather than a grand one: as of 2026-09-08 the
official MCP registry's accessibility servers are **all** axe/WCAG auditing tools built
for sighted developers. Query `registry.modelcontextprotocol.io` for `accessibility` and
read the descriptions. There is no assistive MCP server whose consumer is a disabled end
user. That is the gap this fills.

## What I learned

That getting the problem statement *exactly* right matters more than getting it
dramatic. The first version of this pitch said screen readers lose header context. It
was wrong, and it would have cost the trust of every reader who actually uses one. The
accurate version — manual, per-file, does not survive a change of reader — is both true
and a stronger argument.

## What's next

A design session with a screen-reader user, and their name in this README. Every study
cited above ran with 12–99 blind participants; this has run with none, and that gap is
real rather than rhetorical.

---

## Demo notes for judges *(include this — it is better than being asked)*

**On the Alexa+ integration.** The MCP Toolkit is documented as available to select
partners only, and in the United States. I am a student in Vietnam and cannot obtain
access; `@alexa-ai/cli` returns 404 on public npm. The deliverable this track asks for
is a spec-compliant self-hosted MCP server, and that is what this is — the accompanying
web client is a genuine MCP client performing the 2025-11-25 handshake over Streamable
HTTP against the deployed endpoint. It stands in for device access. It is not a
simulation of the server.

**Verify it yourself:**
- Live endpoint: `[YOUR WORKERS URL]/health` — reports the negotiated protocol revision
- `git clone && npm install && npm test` — 62 tests
- `npm run serve` then open `http://localhost:8787/`

---

## Product feedback *(required field — do not skip)*

**@modelcontextprotocol/sdk 1.30.0** — Used for the server, the Streamable HTTP
transport and tool registration. Zero to a working endpoint took under an hour, which is
good. Two things cost time. `registerTool` takes a Zod raw shape while the spec talks in
JSON Schema, and the type error when you pass JSON Schema does not say so. And the
SSE-versus-stateless lifetime conflict above produced an empty 200 with no diagnostic —
`enableJsonResponse: true` is the right default for a stateless deployment and deserves
to be said out loud in the docs. Would build with it again: yes, unreservedly.

**MCP spec 2025-11-25** — Clear and implementable. `structuredContent` with the mirrored
text block is a good design and the reason a voice client can consume tool output
without parsing prose. One friction: quickstart examples in circulation still send
`2025-06-18` while `LATEST_PROTOCOL_VERSION` is `2025-11-25`, so a newcomer copying an
example ends up negotiating an older revision with no reason to notice.

**MCP Apps (`ui/resourceUri`)** — Implemented against the core SDK's `_meta` support
rather than the extension package, because the 2.x line peer-depends on the v2 SDK
split, zod 4 and React, and the 1.7.x line still pulls React peers to render one static
document. The metadata contract itself is simple and worked first time. A short
"server-side, no framework" section in the docs would save the next person the
reverse-engineering.

**Alexa+ MCP Toolkit** — *[Attempt this yourself for thirty minutes before including
anything here. Report only what you saw first-hand.]*

**Cloudflare Workers** — *[Fill in after deploying. Note the signup experience from
Vietnam, whether a card was required, and how long the first deploy took.]*

---

## Friction log

See `docs/FRICTION-LOG.md` — five first-hand entries in the required six-field format.
**Delete or verify entry 6 before submitting.**
