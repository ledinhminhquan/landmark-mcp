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

**The split is deliberate, not forced.** ExcelJS wants Node streams and Buffer, which
Workers provide only behind the `nodejs_compat` flag — possible, but not free, and a
spreadsheet does not change between deploys, so parsing on the request path is work
repaid never. Ingest runs offline in Node and emits versioned JSON; the Worker does pure
computation over it. A grouped aggregate over 2,000 rows is asserted to stay inside the
500 ms voice budget and measures in single to low double-digit milliseconds on a laptop,
with no cold start.

**Nine tools, not nineteen.** There is no `get_cell`, `get_row` or `get_column` —
those would rebuild the cell-by-cell maze in tool form and hand the traversal problem
back to the model.

## Challenges

The September 13 evidence review corroborated a premature transport-close failure: a delayed SSE tool response became an empty HTTP 200 when we closed the transport before consumption. JSON mode works for our finite responses; keeping the SSE transport alive also works. This is a lifecycle mistake in our integration, not an inherent stateless/SSE conflict.

Our local review also found application defects in header inference, table/column routing, source provenance and state. They are recorded with scope and reproduction evidence in [INTERNAL-FRICTION.md](INTERNAL-FRICTION.md); they have not been fixed by the feedback revision. Historical notes about intermediate header-regression patches and per-request storage lack original failing transcripts and are qualified in [FRICTION-EVIDENCE.md](FRICTION-EVIDENCE.md).

## Accomplishments

Sixty-two tests, typecheck clean under `strict` with `noUncheckedIndexedAccess`. The
protocol revision is asserted, so a dependency bump cannot silently change it. Every
example in the README is verbatim output from a real call.

And a narrow claim rather than a grand one. We know of no MCP server that lets a
blind user interrogate their own spreadsheet by voice. That is an observation about
what we could find, not a claim of being first — the official registry does contain
end-user assistive servers, notably **NeuroDock**'s set for cognitive and
executive-function support, and the registry's `search` matches substrings of server
*names* only, so an empty result for "assistive" proves nothing either way. An earlier
draft asserted that no assistive MCP server had a disabled end user as its consumer.
That was false, and false in the flattering direction. The gap this fills is the
specific one: spreadsheets, by voice, for someone who cannot see the grid.

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
- `git clone && npm install && npm test` — 100 tests
- `npm run ingest -- test/fixtures/*.xlsx test/fixtures/*.csv && npm start`, then open
  `http://localhost:8787/` for the voice client and `/health` for the negotiated
  protocol revision
- Not yet deployed to a public URL: publishing needs a Cloudflare account, which is the
  owner's to create. `wrangler deploy` is configured and passes `--dry-run`; the live
  endpoint goes here once it exists rather than standing as a placeholder that looks
  like an oversight.

---

## Product feedback (required)

Use the five-field entries in [PRODUCT-FEEDBACK.md](PRODUCT-FEEDBACK.md). They cover the actual direct tools and distinguish Amazon documentation from private-toolkit or AWS runtime use. No AWS service is demonstrated in this project.

Onboarding durations were not measured. The earlier claims that z.object() was unsupported and that the hand-written Apps bridge worked first time have been withdrawn. See the [evidence ledger](FRICTION-EVIDENCE.md).

## Friction log and optional feature requests

Use [FRICTION-LOG.md](FRICTION-LOG.md): seven evidence-qualified entries with all six required fields. The log is retrospective, with documentation observations and newly reproduced local cases labelled by scope and date. [FEATURE-REQUESTS.md](FEATURE-REQUESTS.md) supplies priorities and acceptance checks.

[INTERNAL-FRICTION.md](INTERNAL-FRICTION.md) records our own application defects; do not attribute them to vendors. A7 edits only these feedback sections and the challenges summary. The remaining submission pitch, benchmarks, deployment and video claims require their own final verification before submission.
