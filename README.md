# Landmark

**An MCP server that lets you ask a spreadsheet questions out loud, instead of walking it cell by cell.**

Built for the Alexa+ track of the Amazon Developer Hackathon 2026.
MIT licensed. Spec revision `2025-11-25` over Streamable HTTP, self-hosted.

---

## The problem, stated accurately

It is tempting to write "screen readers lose header context." That is not true, and
getting it wrong would be the fastest way to lose the trust of anyone who actually
uses one. JAWS and NVDA both announce headers in Excel.

The real difficulty is narrower and harder:

- **Header association is manual, per worksheet, and does not travel.** Headers set up
  for one reader do not carry to another — [NVDA #11801](https://github.com/nvaccess/nvda/issues/11801),
  open since November 2020, is about exactly that.
- **Most files never declare structure at all.** The
  [WebAIM Million, February 2026](https://webaim.org/projects/million/) observed 948,225 tables
  and found valid data-table markup on **19%** of them. Section508.gov puts it plainly:
  *"Excel does not provide tools to make complex tables accessible."*
- **Even with headers announced, questions cost traversal.** "What is the total?" is
  O(rows). "Which region did best?" is O(rows × cols). There is no cheap way to learn a
  table's shape before committing to walking it.

A sighted reader answers all three with a glance, which costs nothing and is not
sequential. Landmark reconstructs the structure the file never declared, so the same
questions can be *asked* rather than *traversed*.

## What it does

```
"What's in the budget file?"
   → "FY2026 Departmental Budget has 5 rows and 3 columns. The columns are
      Department, Line item and Amount. 3 cells take their label from a merged
      block, so they are not the blanks they look like."

"Total for Engineering?"
   → "560 thousand. That is the total of Amount across 3 rows."

"How do you know?"
   → "That came from C3 through C5 on Budget. Each one is Amount."
```

The third exchange is the one that matters. [CHI 2026 research on blind spreadsheet
users](https://arxiv.org/abs/2601.18092) found they never fully trust an AI-produced
number they cannot verify — and over audio there is no cell to glance at. So every
answer carries the cells it was computed from, and `table_explain` reads them back.

## Why this is not a basic MCP wrapper

The Alexa+ track rules name "a basic MCP wrapper around an existing API" as the
*obvious* shape of entry, against a *creative* list that includes cross-session state,
autonomous orchestration and MCP Apps. That is a fair challenge to put to a project
shaped like this one, so here is the answer in specifics.

**1. It infers structure that is not in the file.** A spreadsheet declares a grid, not
a table. Landmark detects table regions separated by blank rows, scores which rows are
headers and reports its confidence rather than guessing silently, resolves merged
blocks, and reconstructs a full header path for every column. Four columns all labelled
`Revenue` come back as `2026, Q1, Revenue` … `2025, Q2, Revenue`. There is no API to
wrap here — this is the work.

**2. Provenance is a protocol affordance, not a log line.** Every aggregate records its
source cells, the rows it excluded, and why. Nothing is recomputed on explain, because a
recomputation that disagreed with what was already spoken would be worse than no
provenance at all. Excluded rows are said out loud: *"the total across 47 of the 52
rows; five were empty"* is a different claim from *"the total"*.

**3. The result-size governance is in the server, not the prompt.** Every tool returns a
`spoken` field inside a word budget, capped at five items with a continuation token,
with numbers scaled for listening and identifiers stripped. A voice product whose
brevity depends on the model remembering to be brief is a chatbot that happens to be
read aloud.

**4. State survives the session.** `table_bookmark` and `table_resume` keep a place in a
long table across days, backed by KV rather than conversation history, and re-orient
before reading — because the user may not have been here for a week.

**5. It orchestrates across sheets.** `table_compare` runs two aggregations in different
regions or different files and returns the difference and its direction in one sentence,
so nobody has to hold two numbers in their head and subtract them.

**And what it deliberately does not do:** there is no `get_cell`, `get_row` or
`get_column`. Those would rebuild the cell-by-cell maze in tool form and hand the
traversal problem back to the model.

## Prior art, conceded

The intersection is unoccupied; none of the neighbourhoods are.

| | |
|---|---|
| **~50 spreadsheet MCP servers** exist in the official registry ([`excel-mcp-server`](https://github.com/haris-musa/excel-mcp-server) has 4,000+ stars and already speaks Streamable HTTP) | They exist to save an LLM tokens. Their consumer is a developer. None mention accessibility, blind users, voice or speech. |
| **VoxLens** (CHI 2022) and **VERSE** (ASSETS 2019) did voice and sonified access to data for screen-reader users years ago | Both require the data's *publisher* to instrument the content. An MCP server inverts that: the user brings their own file and needs nobody's cooperation. |
| **Copilot in Excel** works with a screen reader today | It documents a prerequisite of AutoSave and OneDrive. It does not help with a CSV someone emailed you, and it returns a chat pane you must then navigate. |

The one checkable claim, and reproducible by anyone: as of 2026-09-08 the official MCP
registry's accessibility servers are **all** axe/WCAG auditing tools built for sighted
developers. Query `registry.modelcontextprotocol.io` for `accessibility` and read the
descriptions. There is no assistive MCP server whose consumer is a disabled end user.

## Run it

```bash
npm install
npm run fixtures                                   # generate the sample spreadsheets
npm run ingest -- test/fixtures/*.xlsx test/fixtures/*.csv
npm run serve                                      # http://localhost:8787/mcp
```

A demo index ships in `data/index.json`, so `npm run serve` works immediately after
`npm install`. Point any MCP client at `http://localhost:8787/mcp`; `GET /health`
reports the negotiated protocol revision and the corpus size.

```bash
npm test          # 60 tests
npm run typecheck # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm run demo      # prints what the voice agent actually says
```

## How it is put together

```
spreadsheet ──[ ingest CLI, Node ]──▶ data/index.json ──[ Worker ]──▶ MCP tools
```

The split is forced and useful. ExcelJS needs Node streams and Buffer, which Cloudflare
Workers do not have. Rather than shim it, everything expensive happens once, offline,
and the server does pure computation over plain JSON — which is what keeps a grouped
aggregate over 2,000 rows at **p95 under 5 ms** against a 500 ms budget, with no cold
start to pay because V8 isolates do not have one.

| Path | What lives there |
|---|---|
| `src/table/` | Region detection, header scoring, merge resolution, header paths, type inference |
| `src/ingest/` | Readers for xlsx/csv/tsv and the index builder — Node only |
| `src/query/` | Deterministic filtering and aggregation, with exclusion accounting |
| `src/voice/` | Spoken formatting, word budgets, number scaling |
| `src/mcp/` | The eight tools and the answer/bookmark store |
| `src/server.ts` | Web-standard fetch handler — the same code locally and on Workers |

## The eight tools

| Tool | For |
|---|---|
| `table_list` | What files are available |
| `table_describe` | Orientation: shape, columns, types, gaps — call it first |
| `table_query` | Filter and aggregate; returns a spoken sentence plus provenance |
| `table_explain` | Read back the exact cells behind a previous answer |
| `table_read_rows` | Individual rows, five at a time, when a summary will not do |
| `table_compare` | Two measures, across columns, sheets or files |
| `table_bookmark` | Save a place |
| `table_resume` | Come back to it, re-oriented |

## Status and honest limits

- Header detection is heuristic and says so. Where confidence is low the server tells
  the user out loud rather than guessing silently — an audible *"I could not find a
  header row, so I am calling the columns by position"* is both better engineering and
  better accessibility than a confident wrong answer nobody can spot.
- Alexa+ device integration is not possible for anyone outside Amazon's partner
  program: the MCP Toolkit is documented as "available to select partners only" and
  "available in the United States". The MCP server is the deliverable the track asks
  for; the accompanying voice client stands in for device access.
- No blind co-designer yet. Every study cited above ran with 12–99 participants; this
  has run with none, and that gap is real. A feedback session is being arranged and
  will be credited here by name.

## Licence

MIT — see [LICENSE](LICENSE). Dependency audit notes are in
[docs/SECURITY-NOTES.md](docs/SECURITY-NOTES.md); the two moderate advisories `npm audit`
reports are analysed rather than suppressed.
