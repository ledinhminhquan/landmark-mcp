# Landmark — Implementation-Ready Build Spec

> **Name:** the repo is `landmark` (ARIA "landmark" is the accessibility term of art for an
> orientation point — exactly what this provides for a table). The research agent drafted this
> spec under the working name TableTalk; it has been renamed throughout.
**Amazon Developer Hackathon 2026 · Alexa+ track · solo build · Vietnam · 2026-09-08 → 2026-10-23 12:00 PT (2026-10-24 02:00 GMT+7)**

Every version number, package name and URL below traces to the verified research. Anything not traceable is explicitly marked **UNVERIFIED** — do not treat those as facts, confirm them on day 1.

---

## 1. Go / no-go

**GO — with a forced change of channel that costs you nothing under the actual rules.**

Two questions had to be answered before committing, and both are settled.

**Is Alexa+ access possible from Vietnam? No, and it is not possible for anyone outside Amazon's partner program.** Amazon's docs home states verbatim: "At this time, Category SDK and MCP Toolkit are available to select partners only." The MCP Toolkit Overview adds: "The MCP Toolkit is available in the United States." The `alexa-ai` CLI and the Local Inspector ship through a private AWS CodeArtifact registry requiring `sts:AssumeRole` on `arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`, and setup instructs you to use "the AWS account that you provided to the Alexa Solutions Architect." Both `@alexa-ai/cli` and `@alexa-ai/addon-local-inspector` return HTTP 404 on public npm — tested live, twice, by two independent passes. Alexa+ consumer availability does not include Vietnam, and Amazon's setup docs require an Alexa+-supported marketplace and locale, so importing an Echo would not help either.

**Does that kill the project? No — because the hackathon never asks for Alexa+ access.** The Devpost Resources page's entire Alexa+ section contains exactly two links, both to `modelcontextprotocol.io`, neither to Amazon. Official Rules: "Alexa+: A working Agent Skill or a self-hosted MCP server, implementing MCP spec version 2025-11-25 (or a later version, once confirmed) over Streamable HTTP." The deliverable is a spec-compliant MCP server, a public repo where the technology is "imported and actually called" at runtime, and a sub-3-minute video. Vietnam is eligible: the exclusion list is Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea and OFAC-comprehensively-sanctioned jurisdictions. Vietnam is none of these.

**Is it derivative? Not at the intersection, and the intersection is the whole product.** Three crowded neighbourhoods surround this idea and you must concede all three out loud:

- Spreadsheet MCP servers are commodity. The official MCP registry returns roughly 50 tabular-data servers (excel 8, csv 13, spreadsheet 6, sheets 17, tabular 1, xlsx 4); GitHub returns 359 repos for `mcp server excel in:name,description` and 562 for `mcp csv`. `haris-musa/excel-mcp-server` has 4,162 stars and already advertises Streamable HTTP. `jgravelle/jdatamunch-mcp` (81 stars, pushed 2026-09-01) is your architecture minus the user.
- Voice queries over data for blind users is four years old: VoxLens (CHI 2022, 22 participants, 122% accuracy gain, 36% faster) and VERSE (ASSETS 2019, Microsoft Research, 12 blind participants).
- "Ask instead of traverse" ships today from both incumbents: Microsoft's "Use Copilot in Excel with a screen reader" (Narrator, JAWS, NVDA, VoiceOver on iPad; hands-free voice input) and JAWS 2026's Page Explorer in FSCompanion.

What is empty, and was verified by direct paged queries against `registry.modelcontextprotocol.io` on 2026-09-08: the registry's ~7 accessibility servers are **all** axe-core/WCAG/VPAT auditing tools built for sighted developers (mcp-agent-accessibility-auditor, accessibility-scanner-mcp, accessibility-ai-mcp, mcp-accessibility-scanner, wcag-accessibility, accessibility-ai, WCAG-Compliance/mcp). Zero overlap with the tabular servers. `screen reader` and `sonification` return zero servers. GitHub returns 0 for `mcp spreadsheet accessibility`, 0 for `mcp screen reader accessibility assistive`, 0 for `voice spreadsheet blind`.

**The one true, checkable, reproducible claim:** as of 2026-09-08 the official MCP registry contains no assistive MCP server whose consumer is a disabled end user rather than a developer. State the query so a judge can reproduce it. Never claim a "first" beyond that.

**Best alternative if you kill it:** none is better. The nearest pivots (a WCAG audit MCP server; a generic spreadsheet MCP server) are the two most crowded categories in the registry. Build this.

**The one thing that genuinely could sink it is not access — it is the rubric.** Official Rules, Quality of the Idea, Alexa+ track, verbatim: "Obvious: single-turn Q&A bot, basic MCP wrapper around an existing API. Creative: agentic workflow that orchestrates across services autonomously, context-aware add-on that maintains state across sessions, purchasing capabilities, media support (cards, carousels, etc), MCP Apps, Agent Skills." A spreadsheet-query MCP server reads as "basic MCP wrapper" on first glance. Section 3 and Section 6 are designed specifically to defeat that reading. That is not decoration; it is 25% of the score.

---

## 2. The product, sharpened

### The paragraph

Four out of five data tables on the live web carry no valid header markup, and the US federal government states in writing that Excel cannot make complex tables accessible at all. So a blind analyst handed a budget workbook does not read it — they traverse it, cell by cell, holding column headers in working memory while a synthesiser reads out "B7, 4820". Landmark is a self-hosted MCP server that turns any spreadsheet or CSV into something you can *ask*. It infers the structure that the file never declared — detecting header rows, virtually un-merging merged header blocks, and reconstructing a full header path for any cell, so "4820" comes back as "2026, Q3, EMEA, Revenue: 4,820." Every answer it speaks carries its own provenance: the value, the cells it came from, the rows it excluded, and a follow-up tool that reads those exact source cells back on request, because the CHI 2026 study of blind spreadsheet users found they never fully trust an AI number they cannot verify. And because the answer arrives through a speaker rather than a screen, the server governs its own result size — shape and aggregates first, at most five items, an explicit continuation token for "tell me more" — instead of reproducing over audio the exact linearisation problem it set out to fix.

### The accessibility failure it fixes

**Strongest single piece of evidence, put it on screen verbatim with the URL visible:**

> "Excel does not provide tools to make complex tables accessible."
> — Section508.gov, *Accessibility Bytes No. 12: Data Tables in Microsoft Word, PowerPoint, Excel, and PDFs*, August 2025
> https://www.section508.gov/blog/accessibility-bytes/data-tables-in-documents/

Supporting, all verified twice:

- **WebAIM Million, February 2026**: "948,225 tables were observed on 143,575 pages… 181,188 (19%) of the tables had valid data table markup." 95.9% of home pages had detected WCAG 2 failures; 56.1 errors per page, up 10.1% year over year. This frames your work as structure **inference**, not structure reading — the harder and more impressive technical claim.
- **Microsoft's own documentation**, on Excel with a screen reader: "Your screen reader announces the column and row of each cell as well as its contents." The page nowhere states that semantic headers are announced automatically. The vendor documents the maze.
- **NVDA issue #11801**, "Excel 365 column/row headings created by NVDA+Shift+C and NVDA+Shift+R shortcuts do not speak in JAWS as indicated in the User Guide" — opened 2020-11-01, still open on 2026-09-08. Header association in Excel is manual, per-worksheet, and does not travel between screen readers. Describe the interop failure; do **not** display the JAWS Defined Names token spellings, which remain unverified (Freedom Scientific returns 403 to automated fetch).
- **Peer-reviewed, all citable with confidence**: CHI 2024, Perera, Lee, Choe, Marriott, "Visual Cues for Data Analysis Features Amplify Challenges for Blind Spreadsheet Users", DOI 10.1145/3613904.3642753, 12 blind screen-reader users; abstract names cognitive overload and the time-information trade-off. CHI 2025, Perera et al., DOI 10.1145/3706598.3713634, 99 surveyed + 16 interviewed. CHI 2026, Perera, Ananthanarayan, Goncu, Marriott, "I'm Always a Little Skeptical of It: Verification Practices of Blind Users When Working with Generative AI in Spreadsheets", DOI 10.1145/3772318.3790988, 12 blind spreadsheet users; participants never fully trusted outputs and cross-checked constantly. Retrieve metadata via `https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/3772318.3790988?fields=title,abstract,authors,year,venue` — dl.acm.org returns 403 to every automated request and always will.
- **Amazon says it too.** Alexa+ MCP Design Guide: Accessibility (updated 2026-07-21): "Input parity — You should be able to complete your experience end-to-end through any single input: Voice only, without touching the screen" and "Information read by VoiceView must match the quality of information shown on screen." You are implementing Amazon's own published requirement.
- **Population figure, use exactly this wording**: "Globally, at least 2.2 billion people have a near or distance vision impairment" (WHO, updated 2026-02-10). The fact sheet gives **no** separate global blindness total — never attribute one to WHO. Do not put any AFB employment percentage on a slide; none were verified.
- **WCAG anchor**: SC 1.3.1 Info and Relationships (Level A) — "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text." Write "W3C Recommendation, 12 December 2024" for WCAG 2.2 — that is what the masthead at w3.org/TR/WCAG22/ says today, **not** October 2023.

### Explicit differentiation — say all of this out loud in the video

| Prior art | What it does | The delta, stated accurately |
|---|---|---|
| **Copilot in Excel with a screen reader** (Microsoft) | Formula generation, trend/outlier analysis, questions about your data; Narrator, JAWS, NVDA, VoiceOver on iPad; hands-free voice input | Documented prerequisite, verbatim: "Enable AutoSave to save the document to OneDrive to activate the Copilot chat pane in Excel." It needs a PC session, a screen reader running, and the file in OneDrive. It does not work on a CSV someone emailed you or a government open-data download, and it returns a chat pane you must then navigate, not a navigable structural model. **Do not claim an M365 licence is a documented prerequisite — that page documents only the OneDrive/AutoSave requirement.** |
| **JAWS 2026 Page Explorer** (FSCompanion, Insert+Shift+E) | Summarises a web page and answers questions about it | No source shows it operating on spreadsheets or arbitrary tabular files. The paradigm is validated by the incumbent; the tabular case is unoccupied. Confirm the keystroke in a real browser before saying it on camera — freedomscientific.com blocks automated fetching and this was corroborated only from a reseller help page. |
| **VoxLens** (CHI 2022), **VERSE** (ASSETS 2019), **Olli**, **Umwelt** | Voice/sonified access to charts and web content for screen-reader users | All require the data owner or page author to instrument the content. An MCP server inverts that: the BLV user brings their own file and needs no publisher's cooperation. That structural inversion is your strongest genuinely-novel argument and it reads as scholarship. |
| **~50 spreadsheet MCP servers** (excel-mcp-server 4,162★; jdatamunch-mcp) | Token-efficient tabular retrieval for coding agents | They exist to save an LLM tokens. Their consumer is a developer. None mention accessibility, blind users, voice or speech. Yours is the assistive one. |

**Your three claimed contributions, stated as a checkable list:** (1) header-path reconstruction across merged and multi-level headers on files that declare no structure; (2) cell-level provenance attached to every spoken answer, with a verification tool; (3) result-size governance for a speech-only channel, plus place-keeping state that survives across sessions.

**Do not write "screen readers lose header context."** It is inaccurate — JAWS and NVDA both have header announcement in Excel — and an accessibility-literate judge will discount everything else you say. Write: header setup is manual, per-file, and breaks across readers (#11801, open since 2020); every aggregate, comparison or cross-reference question costs O(rows × cols) of traversal; and there is no cheap way to learn a table's shape before committing to that traversal.

---

## 3. MCP tool surface

Eight tools, one `table_` prefix, consistent throughout. Design rules applied, each traceable:

- Anthropic's tool guidance: "Fewer, more thoughtful tools outperform comprehensive tool libraries" and "Rather than a `list_contacts` tool that returns everything, implement `search_contacts` with filtering." No `get_cell` / `get_row` / `get_column` — that would rebuild the screen-reader maze in tool form.
- Alexa+ Functional Requirement 9, verbatim: "Present a maximum of 5 options with key differentiators and offer pagination" and "Keep voice responses under 30 seconds. For longer content, offer to 'tell you more' rather than reading everything upfront." This is live Alexa+ certification text, not legacy guidance — cite it as such.
- Alexa+ Functional Requirement 13, verbatim: "Design your tools so the output of one can feed the next — return stable identifiers (for example, a search-state ID) and accept the identifiers you previously returned on subsequent calls."
- Alexa+ Functional Requirements also mandate: "Surface no API codes, tool names, JSON, or internal IDs in any customer-facing response" and "Provide actionable next step for every error."
- MCP 2025-11-25 tool rules: names 1–128 chars from `[A-Za-z0-9_.-]`, case-sensitive, unique per server; JSON Schema defaults to draft 2020-12; a no-argument tool should use `{"type":"object","additionalProperties":false}`, never `null`.

Every tool returns a `spoken` field — one sentence, 30 words or fewer, safe to read aloud verbatim. That field is the voice-first design made structural rather than left to the model's phrasing, and it is the single most demonstrable thing you can point a judge at.

### Shared return envelope

Every successful call returns `structuredContent` conforming to its `outputSchema`, plus a mirrored JSON string in a `TextContent` block ("For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block").

```
spoken:        string   // ≤30 words, speak verbatim
answer_id:     string   // stable id; feed to table_explain (FR-13)
provenance:    { sheet: string, cells: string[], cell_count: integer, excluded: string|null }
more_available: boolean
cursor:        string|null   // opaque continuation token
```

### 1. `table_list`

**Description string (UX copy — this is what the model reads):**
> List the tables this person has available, newest first. Call this when they ask what they have, name a file only vaguely ("the budget one"), or when you need a `table_id` and do not already have one. Returns at most five tables with a short spoken sentence naming them; say that sentence, then wait. If they have more than five, ask whether to continue rather than listing everything.

**Input schema:** `{"type":"object","properties":{"cursor":{"type":"string","description":"Continuation token from a previous call. Omit for the first page."}},"additionalProperties":false}`

**Returns:** `spoken`, `tables[]` of `{table_id, title, sheet_count, row_count, last_opened}`, `more_available`, `cursor`.

### 2. `table_describe`

**Description string:**
> Describe the shape of one table before anything else — what it is, how big it is, what its columns are called, what kind of values they hold, and where the gaps are. Call this first for any table you have not described in this conversation; it is the orientation step that replaces reading a page to see what is on it. If the sheet has stacked or merged headers, this is where you learn the real column names. Returns one spoken sentence plus structured detail. Never guess a column name — get it from here.

**Input schema:**
```json
{"type":"object",
 "properties":{
  "table_id":{"type":"string","description":"Identifier from table_list. Not the human title."},
  "sheet":{"type":"string","description":"Sheet name. Omit for the first sheet, or when the table has only one."},
  "detail":{"type":"string","enum":["brief","full"],"default":"brief",
            "description":"'brief' is one speakable sentence plus column names. Use 'full' only when the person asks for value ranges, gap counts, or the header structure."}},
 "required":["table_id"],"additionalProperties":false}
```

**Returns:** `spoken` (e.g. "Regional sales, 87 rows and 6 columns, covering January to December across four regions; revenue runs from 12,000 to 890,000, and three cells are empty."), `columns[]` of `{name, header_path[], type, non_null, distinct, min, max, source_column}`, `row_count`, `sheets[]`, `header_rows`, `merged_header_blocks`, `notes[]`.

### 3. `table_query`

**Description string:**
> Answer a question about one table by filtering and aggregating its rows, and return a sentence ready to be spoken aloud. Use this instead of reading cells whenever someone asks how many, what is the total, average, highest or lowest, or which rows match something. Call `table_describe` first if you do not already know this table's exact column names. Every answer comes back with the cells it was computed from, so if the person doubts a number, pass the `answer_id` to `table_explain` rather than recomputing. Returns at most five rows because the result is spoken, not displayed.

**Input schema:**
```json
{"type":"object",
 "properties":{
  "table_id":{"type":"string"},
  "sheet":{"type":"string"},
  "filters":{"type":"array","default":[],
    "description":"Row conditions combined with AND. An empty array means every row.",
    "items":{"type":"object",
      "properties":{
        "column":{"type":"string","description":"Exact column name as returned by table_describe."},
        "op":{"type":"string","enum":["eq","neq","gt","gte","lt","lte","contains","is_empty","is_not_empty"]},
        "value":{"type":"string","description":"Value to compare against, as text. Numbers and dates are parsed server-side."}},
      "required":["column","op"],"additionalProperties":false}},
  "aggregate":{"type":"string","enum":["none","count","sum","avg","min","max"],"default":"none",
    "description":"Aggregation over aggregate_column. Use 'none' to return the matching rows themselves."},
  "aggregate_column":{"type":"string","description":"Numeric column to aggregate. Required unless aggregate is 'none' or 'count'."},
  "group_by":{"type":"string","description":"Optional column to break the aggregate down by. Keep to one column; more than one is unspeakable."},
  "limit":{"type":"integer","minimum":1,"maximum":20,"default":5,
    "description":"Maximum rows or groups to return. Keep at 5 or fewer for speech; the person can ask for more."}},
 "required":["table_id"],"additionalProperties":false}
```

**Returns:** `spoken`, `answer_id`, `result` (number or null), `matched_rows` (total **before** `limit`), `rows[]` or `groups[]`, `provenance`, `more_available`, `cursor`.

Example `spoken`: "Four point two million. That is the total of the Revenue column across 47 of the 52 rows; five were empty."

### 4. `table_explain`

**Description string:**
> Show exactly where a previous answer came from. Pass the `answer_id` you were given and this reads back the source cells by address, with each one's full header path, and names anything that was skipped. Use it any time the person asks how you know, are you sure, where did that come from, or which rows those were — and offer it yourself after any total or average, because people are entitled to check a number they cannot see. Returns up to five cells by default and says how many more there are.

**Input schema:**
```json
{"type":"object",
 "properties":{
  "answer_id":{"type":"string","description":"From a previous table_query, table_compare or table_read_rows result."},
  "limit":{"type":"integer","minimum":1,"maximum":20,"default":5},
  "cursor":{"type":"string"}},
 "required":["answer_id"],"additionalProperties":false}
```

**Returns:** `spoken`, `cells[]` of `{address, value, header_path[], row_label}`, `total_cells`, `excluded[]` of `{address, reason}`, `formula_note`, `more_available`, `cursor`.

Example `spoken`: "That total came from cells F2 through F53 on the Sales sheet. Each one is 2026, Revenue. Five were blank: F14, F27, F31, F44 and F50."

This is the CHI 2026 finding turned into a protocol affordance. It is also the tool that most clearly separates you from every other spreadsheet MCP server.

### 5. `table_read_rows`

**Description string:**
> Read specific rows out loud, a few at a time, when the person genuinely wants the individual records rather than a summary. Only reach for this after `table_query` or `table_describe` — reading rows is slow over audio and is the thing this tool exists to avoid. Each row is spoken as its label plus the columns asked for, never as raw cell coordinates. Returns at most five rows and a continuation token; call it again with the token when they say to keep going.

**Input schema:**
```json
{"type":"object",
 "properties":{
  "table_id":{"type":"string"},
  "sheet":{"type":"string"},
  "columns":{"type":"array","items":{"type":"string"},
    "description":"Column names to read. Omit for all columns, but naming two or three reads far better aloud."},
  "filters":{"type":"array","items":{"type":"object"},"default":[],
    "description":"Same shape as table_query filters."},
  "limit":{"type":"integer","minimum":1,"maximum":10,"default":3},
  "cursor":{"type":"string","description":"Continuation token from a previous call. Use this for 'keep going' rather than re-filtering."}},
 "required":["table_id"],"additionalProperties":false}
```

**Returns:** `spoken`, `answer_id`, `rows[]` of `{row_label, values{}, address_range}`, `position` ("rows 4 to 6 of 87"), `more_available`, `cursor`.

### 6. `table_compare`

**Description string:**
> Compare the same measure across two groups, two time periods, or two sheets in one step, and say which is bigger and by how much. Use this instead of running `table_query` twice and doing arithmetic yourself — the comparison is computed here, so the difference and the percentage are exact and both sides carry their own source cells. Good for "how did EMEA do against APAC", "is Q3 up on Q2", or "does the summary sheet match the detail sheet". Returns one spoken sentence with both figures and the gap.

**Input schema:**
```json
{"type":"object",
 "properties":{
  "table_id":{"type":"string"},
  "left":{"type":"object","description":"First side of the comparison.",
    "properties":{"sheet":{"type":"string"},"filters":{"type":"array","items":{"type":"object"}},"label":{"type":"string","description":"How to name this side out loud, e.g. 'EMEA'."}},
    "required":["label"],"additionalProperties":false},
  "right":{"type":"object","description":"Second side. Same shape as left.",
    "properties":{"sheet":{"type":"string"},"filters":{"type":"array","items":{"type":"object"}},"label":{"type":"string"}},
    "required":["label"],"additionalProperties":false},
  "measure":{"type":"string","description":"Numeric column to compare, or 'rows' to compare counts."},
  "aggregate":{"type":"string","enum":["sum","avg","count","min","max"],"default":"sum"}},
 "required":["table_id","left","right","measure"],"additionalProperties":false}
```

**Returns:** `spoken`, `answer_id`, `left_value`, `right_value`, `difference`, `percent_change`, `direction`, `provenance` (both sides).

### 7. `table_bookmark`

**Description string:**
> Remember where this person is, so they can leave and come back. Save the table, the sheet, the filters in play and an optional note in their own words. Offer this when they say they are done for now, when a call is being interrupted, or after any answer they seem likely to want again. Returns a short confirmation naming what was saved. It survives across days and devices.

**Input schema:**
```json
{"type":"object",
 "properties":{
  "table_id":{"type":"string"},
  "sheet":{"type":"string"},
  "note":{"type":"string","maxLength":200,"description":"The person's own words for what they were doing, e.g. 'checking which regions missed target'."},
  "answer_id":{"type":"string","description":"Optional. Pins the exact last answer so table_resume can restate it."}},
 "required":["table_id"],"additionalProperties":false}
```

**Returns:** `spoken`, `bookmark_id`, `saved_at`.

### 8. `table_resume`

**Description string:**
> Pick up where this person left off. Call this at the start of a conversation, or whenever they say "where was I", "carry on", or "the thing from yesterday". It returns the table and sheet they were last in, the filters that were applied, their own note, and the last answer they heard — so you can restate it rather than making them rebuild the question. If there is nothing saved, it says so plainly and suggests listing their tables instead.

**Input schema:** `{"type":"object","properties":{"bookmark_id":{"type":"string","description":"Omit to get the most recent bookmark, which is almost always what they mean."}},"additionalProperties":false}`

**Returns:** `spoken`, `bookmark_id`, `table_id`, `sheet`, `filters[]`, `note`, `last_answer`, `saved_at`.

Tools 7 and 8 are the "context-aware add-on that maintains state across sessions" bullet from the Creative list, and they are simultaneously the most authentic blind-user feature in the build: place-keeping is exactly what cell-by-cell traversal destroys.

### Error phrasing for voice

Every argument problem returns a **Tool Execution Error** — `{ isError: true, content: [{ type: "text", text: "…" }] }` — never a JSON-RPC error. The spec is explicit: "Tool Execution Errors contain actionable feedback that language models can use to self-correct and retry with adjusted parameters… Clients SHOULD provide tool execution errors to language models to enable self-correction." Protocol errors are for unknown tools and malformed requests only. On a voice surface this is the difference between a graceful re-prompt and a dead end the user hears as a crash.

**Use a strict two-line format.** Line 1 is speakable and contains no identifiers. Line 2 is the machine hint the model uses to retry, and the model must never read it aloud.

```
There is no column called Sales in this sheet. The columns are Region, Month, Revenue, Target and Variance — which one did you mean?
[retry] Unknown column "Sales". Valid: Region, Month, Revenue, Target, Variance. Re-call table_query with an exact name.
```

```
I could not find that table. You have three: Regional Sales, Q3 Budget and Headcount. Which one?
[retry] Unknown table_id "budget2026". Call table_list, then retry with a returned table_id.
```

```
That is a text column, so I cannot total it. The numeric columns are Revenue, Target and Variance. Shall I count the rows instead?
[retry] aggregate "sum" requires a numeric aggregate_column. Numeric: Revenue, Target, Variance. Or use aggregate "count".
```

```
I do not have that earlier answer any more — it has been a while. Ask me the question again and I will keep the working this time.
[retry] answer_id expired (24h TTL). Re-run the originating table_query, then call table_explain with the new answer_id.
```

```
Nothing matched. Every row in this sheet is above target, so nothing is below it. Would you like the three smallest margins instead?
[not an error: matched_rows 0, with a suggested next step per FR: "Provide a helpful message with alternative suggestions when no results are found"]
```

Rules that follow directly from Alexa+ Functional Requirements: no tool name, no JSON, no internal ID, no cell address in line 1 unless the address *is* the answer (as in `table_explain`); every error names the valid alternatives; every error ends with one suggested next action, not a menu of recovery paths.

---

## 4. Architecture

### Components

```
┌──────────────────────────────────────────────────────────────────────┐
│ INGEST (offline, Node CLI — never runs at the edge)                  │
│   npm run ingest -- ./bus-schedule.xlsx                              │
│   .xlsx/.xlsm/.csv/.tsv  →  parse  →  region detect  →  header       │
│   inference  →  merge resolution  →  type inference  →  columnar     │
│   index + provenance map  →  <table_id>.index.json                   │
└──────────────────────────────────────────────────────────────────────┘
                     │  (committed to repo for demo files;
                     │   uploaded to Cloudflare KV for user files)
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ MCP SERVER (Cloudflare Worker, Web-standard fetch)                   │
│   POST /mcp  Streamable HTTP, spec 2025-11-25, application/json      │
│   GET  /mcp  → 405        DELETE /mcp → 405                          │
│   index loader (KV/static) → query planner → executor (pure TS)      │
│   → spoken-summary formatter → provenance attacher                   │
│   bookmark store (KV, keyed by profile id)                           │
└──────────────────────────────────────────────────────────────────────┘
                     ▲                                   │
                     │ Streamable HTTP over the network  │ ui:// resource
                     │                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ VOICE CLIENT (static page — the "Alexa+ simulation")                 │
│   Web Speech API STT → LLM tool-calling loop → MCP client            │
│   → SpeechSynthesis TTS.  Echo-frame styling. Screen-off capable.    │
│   Optional: renders the MCP App widget the server exposes.           │
└──────────────────────────────────────────────────────────────────────┘
```

**Why ingestion is a separate offline step, not a tool call.** Amazon's published budget is "round-trip query response latency of less than 500 ms." Parsing a workbook inside `tools/call` blows that instantly. It also keeps the xlsx parser — the largest dependency in the project — entirely out of the runtime bundle, which is the single biggest supply-chain reduction available to you: the edge bundle contains the MCP SDK and Zod and nothing else. Note the separate, looser budget you also get: Functional Requirement 7 says "Return results within 3 seconds. If processing takes longer, surface an interim message" — that applies to search-shaped operations, so `table_query` has 3 s of headroom, not 500 ms. Design to 500 ms anyway.

### File formats supported

| Format | Ingest path | Notes |
|---|---|---|
| `.csv`, `.tsv` | Hand-rolled RFC 4180 parser (~120 lines, zero dependencies) | Handles quoted fields, embedded newlines, CRLF, BOM. Delimiter sniffed from the first non-empty line. |
| `.xlsx`, `.xlsm` | `exceljs` in the CLI only | You need the sheet's `mergeCells` ranges, number formats and cached formula values. This is the only heavyweight dependency and it never ships to the edge. |
| `.xls` (legacy) | **Not supported.** Say so in the README. | Out of scope for 45 days. |
| Google Sheets | **Not supported.** | A second OAuth surface. Explicitly deferred in the README as future work. |

### How structure inference works

This is the demonstrable technical core — a real algorithm a Tech Implementation judge can evaluate — and it maps directly onto W3C's "Tables with irregular headers" and "Tables with multi-level headers" patterns from the WAI Tables Tutorial.

1. **Region detection.** Walk the used range; split on fully-empty rows and columns into candidate rectangular regions. A sheet with a title block, a table, and a notes block yields three regions; only regions with ≥2 rows and ≥2 columns and ≥50% non-empty become tables.
2. **Header-row detection.** For each candidate region, score the top *k* rows (k ≤ 4) on: proportion of text cells versus the column's modal type below; presence of bold/fill formatting (exceljs exposes both); absence of numeric values; distinctness across the row; and whether the row below changes type. The highest contiguous run of qualifying rows from the top becomes the header block. If nothing qualifies, mark `header_rows: 0` and synthesise `Column A`, `Column B` — and **say so in `table_describe`'s `spoken`**, because an inference the user cannot hear is an inference they cannot verify.
3. **Merge resolution.** Read every merged range in the header block. Virtually un-merge: write the anchor cell's value into every covered cell, then forward-fill horizontally across the header block for horizontally-merged spans and vertically for vertically-merged ones. This is the step that makes a `2026 | 2026 | 2025 | 2025` / `Q3 | Q4 | Q3 | Q4` stacked header resolvable at all. Merged cells inside the *body* are recorded in the provenance map, not filled, and reported in `table_describe`'s `notes[]`.
4. **Header-path construction.** For each data column, the header path is the top-to-bottom tuple of resolved header cells, deduplicated for repeats: `["2026", "Q3", "Revenue"]`. Row headers are inferred symmetrically when the leftmost column is text and the columns to its right are numeric — giving each cell a full path `2026 > Q3 > EMEA > Revenue`. This is precisely what WCAG SC 1.3.1's own bus-schedule example says assistive technology should be able to determine, on a file where the markup does not exist.
5. **Type inference.** Per column, sample up to 200 non-empty values against ordered matchers: integer, decimal, currency (from the cell number format when available, else a leading/trailing symbol), percentage, ISO date, common locale dates, boolean, text. A column is typed when ≥90% of samples agree; otherwise `mixed`, and the disagreeing cells are recorded so `table_explain` can name them.
6. **Provenance map.** Every index cell stores its origin as `{sheet, row, col}`, serialised to A1 notation on output. Nothing is ever computed from a value whose address cannot be named.

**Test it against W3C's bus-schedule shape.** Use a dataset structurally identical to the Understanding SC 1.3.1 example. It lets you say your tool does what WCAG says assistive technology should be able to do, on a file where the markup is absent.

### How query planning works

No LLM runs inside the server. Ever. Every number is computed in TypeScript.

1. **Validate** — resolve `table_id` and `sheet`; check every referenced column against the index; check aggregate/column type compatibility. Any failure returns the two-line Tool Execution Error from Section 3.
2. **Compile predicates** — each filter becomes a closure over one column's typed array, with the comparison value coerced once, up front, into the column's type. Coercion failure is an error, not a silent no-match ("I could not read 'last March' as a date in the Month column — try a month name or a year.").
3. **Single pass** — one loop over row indices applying the AND-chain, accumulating: matched row indices, the aggregate accumulator, per-group accumulators when `group_by` is set, and the set of contributing cell addresses (capped at 500 stored, with an exact total count).
4. **Exclusion accounting** — blank, non-numeric and merged-body cells inside an aggregated column are counted and their addresses retained. This is what makes "averaged 47 of 52 rows; 5 were blank" possible, and it is the sentence that earns trust.
5. **Govern the result** — apply `limit` (default 5, hard cap 20), set `more_available`, and mint a `cursor` encoding `{table_id, sheet, filter_hash, offset}`. Mint an `answer_id` and store the full provenance for `table_explain` under a 24-hour TTL.
6. **Format the sentence** — a template-driven formatter, not free text: number formatting from the column's inferred type (currency symbol, thousands separators, sensible rounding), header-path naming, exclusion clause, and a hard 30-word ceiling with a deterministic trim.

Complexity is O(rows) per query over pre-typed arrays. A 100,000-row index answers in low single-digit milliseconds. Log per-tool latency and assert p95 under 500 ms in your test harness — then put the measured number in the README.

### Dependencies — exact packages and versions

Keep this list short and boring. Commit `package-lock.json`. Run `npm audit` before submission.

**Runtime (ships to the edge) — 2 direct dependencies:**

| Package | Version | Status |
|---|---|---|
| `@modelcontextprotocol/sdk` | `1.30.0` (pin exact, not `^`) | **VERIFIED.** npm dist-tag `latest` = 1.30.0, published 2026-07-27, `engines: {"node":">=18"}`, `"type":"module"`. Compiled `dist/esm/types.js` declares `LATEST_PROTOCOL_VERSION = '2025-11-25'`. Minimum version with 2025-11-25 support is **1.24.1** (1.24.0 and 1.23.x still declare `2025-06-18`). |
| `zod` | `^3.25 \|\| ^4.0` | **VERIFIED as the SDK-compatible range.** Exact patch UNVERIFIED — pin whatever installs. Import from `zod/v4` as the SDK examples do. |

**Dev / ingest only (never bundled to the edge):**

| Package | Version | Status |
|---|---|---|
| `exceljs` | **UNVERIFIED** — no version appears in the verified research. Pin the exact version you install and record it. | Used only by `npm run ingest`. |
| `typescript`, `@types/node`, `vitest` (or `node:test`) | **UNVERIFIED** versions | Standard, low risk. Prefer built-in `node:test` to remove one dependency. |
| `express` | **UNVERIFIED** version (research says "express 5") | **Local dev only.** Not needed if you develop directly against the Workers runtime. Dropping it is a legitimate simplification. |
| `wrangler` | **UNVERIFIED** version | Cloudflare deploy tooling. |

**Explicitly rejected:**

- `papaparse` — replaced by ~120 lines of RFC 4180 parsing you own and can read in full.
- `@modelcontextprotocol/core` / `/server` / `/client` **2.0.0** — the v2 rewrite (published 2026-07-27, `engines: node >=20`). It targets the 2026-07-28 era. Do not adopt it. v1.x "continues to receive bug fixes and security updates for at least 6 months after v2's release," which runs well past your deadline.
- `cloudflare/workers-oauth-provider` — you are not implementing OAuth (Section 5), and it emits `WWW-Authenticate` on 401 by default, which Alexa+ explicitly does not support.
- `@alexa-ai/cli`, `@alexa-ai/addon-local-inspector` — **404 on public npm.** Not obtainable. Do not put them in your plan, your README, or your video. Note also that `npm install alexa-ai` (unscoped) resolves to an unrelated third-party WhatsApp bot package — a real name-confusion hazard, and a good friction-log entry.

**Node version: use Node 24 LTS, not 23.11.** Node 23 is an odd-numbered non-LTS line and this project must stay healthy through 2026-11-20. The SDK needs `>=18`; `@modelcontextprotocol/ext-apps` needs `>=20`. Nothing you actually build requires 24, but LTS is the right base for something judges will hit a month after you stop touching it.

---

## 5. Protocol implementation

**Target MCP specification revision 2025-11-25. Do not target 2026-07-28.**

The current published revision is 2026-07-28 — the versioning page says so outright — and the hackathon says "2025-11-25 (or a later version, once confirmed)". "Once confirmed" means not pre-approved. Meanwhile Amazon states verbatim: "Alexa+ for Builders supports the 2025-11-25 version of the MCP specification," and the Devpost Alexa+ resource link points at `/specification/2025-11-25/basic/transports#streamable-http`. And 2026-07-28 is a breaking rewrite: it removes the GET stream endpoint, removes protocol-level sessions, drops `Last-Event-ID` resumability, deletes `initialize` in favour of a mandatory `server/discover` RPC, moves version negotiation into `_meta`, and requires `Mcp-Method`/`Mcp-Name` headers that must match the body or return HTTP 400 with JSON-RPC `-32020 HeaderMismatch`. A 2026-07-28-only server looks broken to the very client this track is about.

**The good news: you get 2025-11-25 by default.** `@modelcontextprotocol/sdk@1.30.0` still declares `LATEST_PROTOCOL_VERSION = '2025-11-25'`. Do not pass a `protocolVersion` anywhere. Add one boot assertion as cheap disqualification insurance and as something a judge skimming the repo will see:

```ts
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
if (LATEST_PROTOCOL_VERSION !== '2025-11-25') {
  throw new Error(`Expected MCP 2025-11-25, SDK reports ${LATEST_PROTOCOL_VERSION}`);
}
console.log(`Landmark MCP · spec ${LATEST_PROTOCOL_VERSION} · Streamable HTTP`);
```

### Transport setup

Build **stateless**, with **JSON responses**, **405 on GET and DELETE**. Every part of that is fully compliant and each removes a class of failure.

The spec, verbatim: on POST of a request the server "MUST either return `Content-Type: text/event-stream`… or `Content-Type: application/json`, to return one JSON object." On GET it "MUST either return `Content-Type: text/event-stream`… or else return HTTP 405 Method Not Allowed." And "A server using the Streamable HTTP transport **MAY** assign a session ID." So: no SSE means no reverse-proxy buffering bugs and no held connections; no protocol sessions means no in-memory-Map-behind-a-load-balancer failure; JSON-only is the lowest-latency shape against the 500 ms budget.

**Local development (Node + express):**

```ts
// src/dev-server.ts — local only
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTableTools } from './tools.js';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'tabletalk', version: '0.1.0', title: 'Landmark' },
    {
      capabilities: { logging: {} },
      instructions:
        'Spreadsheets and CSVs, answered out loud, for people who cannot see the screen. ' +
        'Start with table_resume if this may be a returning conversation. ' +
        'Call table_describe before naming any column. Answer with table_query rather than reading rows. ' +
        'Offer table_explain after any total or average so the person can check it. ' +
        'Never read a table row by row unless explicitly asked; speak at most five items and offer to continue.'
    }
  );
  registerTableTools(server);
  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true         // plain application/json, never SSE
  });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);            // connect BEFORE handling
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
    }
  }
});

app.get('/mcp',    (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());

app.listen(3000, () => console.log('MCP endpoint: http://127.0.0.1:3000/mcp'));
```

Every import path and option name above is **VERIFIED** to exist in 1.30.0 (`dist/esm/server/{mcp,streamableHttp,express,webStandardStreamableHttp}.js`; `webStandardStreamableHttp.d.ts` declares `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`, `enableJsonResponse`, `eventStore`, `allowedHosts`, `allowedOrigins`, `enableDnsRebindingProtection`, `retryInterval`, `keepAliveMs`). The composition is **UNTESTED as written** — compile it on day 1.

**Production (Cloudflare Worker, Web-standard fetch).** The module `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` is **VERIFIED to exist** in 1.30.0 with the options above; its **exported class name is UNVERIFIED**. Confirm it in the `.d.ts` on day 1 — this is a 10-minute check that gates your hosting choice, so do it before anything else.

```ts
// src/worker.ts — sketch; confirm the exported transport name first
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// import { <ConfirmMe> } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method === 'GET' || request.method === 'DELETE') {
      return new Response(null, { status: 405 });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    // Origin check — ONLY when the header is present.
    const origin = request.headers.get('origin');
    if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    // Protocol version — accept permissively; 400 only on a version we do not support.
    const pv = request.headers.get('mcp-protocol-version');
    if (pv !== null && !SUPPORTED.has(pv)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32000, message: `Unsupported protocol version ${pv}` } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    // … build McpServer, connect the web-standard transport, return its Response
  }
};
```

**Fallback if the web-standard transport does not work out:** run the Node + express server on Deno Deploy or a small always-on Node host. Do not spend more than one day on this; the Worker is an optimisation, not the product.

### Session handling

**MCP protocol sessions: none.** `sessionIdGenerator: undefined`. GET and DELETE return 405. This is compliant because session assignment is MAY.

**Application state: persisted, and this is the stronger design.** The "where was I" feature (`table_bookmark` / `table_resume`) is keyed by a stable profile identifier, not by an MCP session, and lives in Cloudflare KV. That is what makes it survive across days and devices — which is the actual user need and the actual Creative-rubric bullet ("maintains state across sessions"). Say this distinction explicitly in the README: transport-level statelessness plus application-level durability, not the other way round.

Profile identity for the hackathon: a `profile` argument threaded through the voice client, defaulting to a demo profile. Document it as the seam where account linking would attach in a certified add-on. Do not build account linking.

### Auth decision

**Skip OAuth 2.1 entirely.** Justify it in the README in exactly these terms, because the sloppy version of this claim is false:

> The MCP specification states "Authorization is **OPTIONAL** for MCP implementations." The hackathon requires a self-hosted MCP server over Streamable HTTP and does **not** require a connected or certified Alexa+ add-on. Amazon's OAuth requirements gate account linking to Alexa+, which is unavailable outside its partner program, so implementing them would gate nothing and demonstrate nothing.

Do **not** write "auth is only needed for certification" — that is wrong. Amazon's authentication checklist sits inside the QuickStart section headed "MCP requirements for Alexa+," prefaced by "Make sure that your MCP server meets all the requirements in this section." It gates connecting at all.

What you would need if you ever did implement it, recorded here so the README can say you know: OAuth 2.1 authorization code flow with PKCE where `code_challenge_methods_supported` "must be present and must include S256. Account linking won't proceed without it"; a **two-tier** model where Tier 1 `client_credentials` (HTTP Basic on `/token`, `resource` validated against your canonical MCP URI, `expires_in <= 3600`, no refresh token, scope `mcp:service`) must be established *before* user-level linking and is what Alexa+ uses for `initialize` and `tools/list`, with Tier 2 `authorization_code` + PKCE for `mcp:tools` / `mcp:resources`; RFC 9728 Protected Resource Metadata at the well-known URI; AS metadata at `/.well-known/oauth-authorization-server`; and — the detail that inverts the MCP spec's own guidance — **"Your MCP server returns 401 Unauthorized (without a WWW-Authenticate header) for unauthenticated requests."** Alexa+ lists Dynamic Client Registration, Client ID Metadata Documents, OpenID Connect, Step-Up Authorization and "WWW-Authenticate headers in 401 responses" as unsupported. Two paragraphs in the README showing you know all of this is worth more than two weeks implementing it.

### The five mistakes to avoid

**1. Blanket-403 on the Origin header.** The rule is conditional, verbatim: "If the `Origin` header is present and invalid, servers MUST respond with HTTP 403 Forbidden." A server that 403s on a *missing* Origin rejects curl, every non-browser MCP client, and Amazon's own tooling. Check `origin !== null` first. This is the single most likely way to take yourself offline during the November judging window.

**2. Returning JSON-RPC protocol errors for bad tool arguments.** Use `isError: true` results. The spec: "Clients SHOULD provide tool execution errors to language models to enable self-correction." On a voice surface a `-32602` for a mistyped column name is a dead end the user hears as a crash; an `isError` result enumerating the valid columns is a re-prompt. One implementation choice satisfying three rubrics — SEP-1303, Anthropic's tool guidance, and Alexa+'s "clear error messages with specific re-prompts for invalid input."

**3. Hard-rejecting protocol versions, or hand-rolling session branches.** Keep the SDK's default `SUPPORTED_PROTOCOL_VERSIONS` (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07). Amazon's own Local Inspector documentation handshakes with `"protocolVersion":"2025-06-18"` — a server that only accepts 2025-11-25 would reject Amazon's own tool. If the header is absent the spec says assume 2025-03-26, not fail. And do not write your own 404/400 session branches: the stateful transport already returns 404 for unknown session IDs and 400 for non-init requests without one. You are stateless anyway.

**4. Assuming SSE, or fighting it.** Do not implement streaming. `enableJsonResponse: true` removes an entire class of bug: reverse proxies (nginx, Cloudflare, tunnels) buffer by default, which turns SSE into a hang that looks like a broken server on camera. Related: never return a bare 200 with JSON from GET — it must be `text/event-stream` or 405.

**5. Parsing a workbook inside `tools/call`.** Amazon documents "round-trip query response latency of less than 500 ms." Index at ingest; keep tool bodies to indexed lookups. Also: `createMcpExpressApp()` accepts **only** `{host, allowedHosts}` — `enableDnsRebindingProtection` and `allowedOrigins` live on the transport constructor, and passing `host:'0.0.0.0'` with no `allowedHosts` gives you a console warning and zero protection, not the safety you assumed.

Runners-up for the checklist: answer notifications and responses with `202 Accepted` and no body; use `{"type":"object","additionalProperties":false}` for any no-argument tool, never `null`; keep tool names inside `[A-Za-z0-9_.-]`, 1–128 chars.

**Ship a wire-contract test harness in the repo.** A tiny MCP client that asserts: `initialize` returns `protocolVersion: "2025-11-25"`; `notifications/initialized` returns 202 with an empty body; a present-but-invalid Origin returns 403 while an absent Origin returns 200; GET and DELETE return 405; an unsupported `MCP-Protocol-Version` returns 400; and p95 tool latency is under 500 ms. Run it in CI. This is simultaneously a real test suite and the cleanest possible proof of the rules' "imported and actually called" requirement.

---

## 6. Alexa+ integration path

**Decision: build the real MCP server as the primary deliverable, and build a self-hosted voice web client as the demo surface. Do not submit down the "simulated Alexa+ experience instead" path.**

Real device or preview is impossible. Verified three ways: the toolkit is partner-only, it is US-only, the CLI 404s on public npm and lives behind an Amazon-owned IAM role, and Alexa+ has not launched in Vietnam. There is no waitlist, no signup form, no preview request anywhere in Amazon's docs. Stop looking; it does not exist for you or for any non-partner.

But read the rules carefully before taking the fallback. The alternate path says entrants "may submit a simulated Alexa+ experience **instead**" — instead of building an MCP server, not instead of having a device — and it is "exempt from the runtime-technology-hook requirement," which means it forfeits the strongest available Tech Implementation evidence. You do not want that exemption. You want the primary path plus your own client:

- The MCP server is real, spec-compliant, self-hosted, and imported and called at runtime → the runtime-technology-hook requirement is satisfied by the primary path.
- The voice client is a genuine **MCP client** that connects to the deployed server over Streamable HTTP across the network → the video shows the server in action, not a mock.
- Say this explicitly in the submission text: *"This is the primary MCP path. The web client stands in for device access, which is restricted to Amazon's partner program; it is not a substitute for the MCP server."*

### What the simulation must contain to score, rather than look like a shortcut

If the video shows a chat textbox, judges read "web chatbot" and Design collapses. Design is judged on whether the interaction model is intuitive and well-considered **for the target device**, and the target device is a screenless Echo. Non-negotiables:

1. **Real speech in, real speech out.** Web Speech API `SpeechRecognition` for input and `SpeechSynthesis` for output. No typing in the demo, at all. (Browser support specifics: **UNVERIFIED** — test in Chrome on day 1 of week 4 and have a pre-recorded audio path as backup.)
2. **A real MCP client, over the network.** The page performs the 2025-11-25 handshake against the deployed HTTPS endpoint. Show the wire frames on screen for a few seconds in the architecture beat.
3. **Screen-off operation.** Film at least 30 seconds with the monitor dark or the user's face turned away. Amazon's own accessibility guide demands "Voice only, without touching the screen." Demonstrate it literally.
4. **Echo constraints honoured, visibly.** At most five items spoken; responses under 30 seconds; "tell you more" as a real continuation token round-trip, not an LLM improvisation; no on-screen references in the speech ("as you can see" is disqualifying); no tool names, JSON or IDs ever spoken. Narrate the line from Amazon's requirements: "Test your complete flow on the lowest-capability device (Echo Dot) first" — for a blind-and-low-vision product, that is the primary surface, not the floor.
5. **A visible latency read-out.** A small counter showing per-call round-trip time, staying under 500 ms. That is Amazon's own published number, measured live, on camera.
6. **Echo-frame styling.** Present the client as a device simulation, not a web app. Blue listening ring, Alexa-style turn-taking cadence, and — crucially — a barge-in affordance so the user can interrupt a long answer, because that is what a real voice user does.
7. **The MCP App widget.** Both of the hackathon's only two Alexa+ resource links point at MCP Apps, and "MCP Apps" is named verbatim in the rules' Creative list. Ship one: declare `_meta.ui.resourceUri` on `table_explain` pointing at a `ui://` resource that renders the table region and highlights the exact cells behind the spoken answer. Package: `@modelcontextprotocol/ext-apps`, **1.7.5**, published 2026-07-23, `engines: node >=20` (**VERIFIED**); extension spec revision **2026-01-26** (as stated in the verified research). It renders in a sandboxed iframe and talks `postMessage` with `ui/` methods; `_meta.ui.csp` allows external origins. Note the Local Inspector page phrases this as a capability, not a MUST: "Tools that include a `ui://` resource URI in their metadata (`_meta.ui.resourceUri`) support visual rendering" — do not quote a stronger version. Justify the widget on substance, not rubric-chasing: a low-vision user with residual sight, or a sighted colleague, sees the region the voice answer refers to. That *is* the input-parity story from Amazon's accessibility guide.

**Do not plan around `@alexa-ai/addon-local-inspector` or a `certification-verdict.json`.** It 404s on public npm and its install path runs through a US-gated Developer Console. If you want to try, timebox it to 30 minutes and abandon it immediately on failure. It becomes a friction-log entry, not a deliverable.

**Optionally ship a small Agent Skill** — the rules say "Build a working Agent Skill **or** a self-hosted MCP server," and "Agent Skills" appears in the Creative list. The spec at agentskills.io requires only `SKILL.md` with YAML frontmatter: `name` 1–64 chars, lowercase alphanumeric and hyphens, no leading/trailing/consecutive hyphens, **must match the parent directory name**; `description` 1–1024 chars covering what it does and when to use it; body under 500 lines. Validate with `skills-ref validate ./my-skill`. A few hours for a named rubric hit. Justify it from the rules text, not from the Devpost "Build with Agent Skills" link — that link is actually the MCP Apps documentation hub.

---

## 7. Hosting

**Primary: Cloudflare Workers.** Free tier is 100,000 requests/day with 10 ms CPU per invocation; the $5/month Workers Paid plan raises this to 30 million CPU-milliseconds/month and "Max of 5 minutes of CPU time per invocation (default: 30 seconds)" — all **VERIFIED** from developers.cloudflare.com/workers/platform/pricing.

Why it wins on your exact constraints:

- **V8 isolates, no cold start.** A judge hitting your endpoint on 2026-11-14 gets an answer immediately. Compare Render, which "spins down a Free web service that goes 15 minutes without receiving any inbound traffic" with spin-up taking "about one minute" — and additionally caps free workspaces at 750 instance hours per calendar month, after which *all* free services are suspended until the month rolls over. That is a cliff inside your judging window, not a delay.
- **Never sleeps, no trial expiry.** Koyeb's free tier scales to zero after an hour and cannot be configured otherwise; Railway has no permanent free tier since 2024; Fly.io discontinued its free tier.
- **No card at signup, no US address required.** Vietnam is not OFAC-comprehensively-sanctioned, so no US-jurisdiction provider has a legal basis to refuse you. (This is **UNVERIFIED** as a positive statement — no provider terms were fetched. Mitigate by choosing a provider whose free tier needs no card at all, which Cloudflare is.)
- **KV for bookmark state and index storage**, which is exactly the durable-but-tiny store `table_resume` needs.
- **The 10 ms free CPU ceiling is a real risk** — mitigated structurally by the architecture in Section 4: indexes are prebuilt offline, so a query is an indexed pass over typed arrays. Test with your largest realistic file. **Budget the $5/month Paid plan** anyway; it is trivial money against a hackathon and it removes the ceiling entirely.

**Named backup: Deno Deploy.** Free tier is 1M requests/month, 20 GiB egress, 10 hours active CPU per month, 150 GiB-hour memory, 3 team members (**VERIFIED** from deno.com/deploy/pricing — note the recon's "50 ms CPU/request" figure was wrong; the constraint is a monthly CPU *budget*, a different shape). Same V8-isolate profile, so negligible cold start, and it consumes the same Web-standard fetch transport with no code change. Whether it requires a credit card is **UNVERIFIED**. Deploy to it in week 4 and list its URL in the README as a standby.

**Third option if both disappoint: Vercel Hobby.** Its real limit is "Hobby: 300s default and maximum" function duration (**VERIFIED**), not the 10 seconds widely repeated — but request and response bodies cap at 4.5 MB (413 `FUNCTION_PAYLOAD_TOO_LARGE`), which matters if you ever add a file-upload endpoint.

**Avoid:** Render (spin-down plus the 750-hour cliff), Fly.io (no free tier), Railway (trial credit only), Koyeb (forced scale-to-zero), Oracle Cloud (aggressive signup fraud detection that rejects legitimate applicants, free-tier allowances reduced mid-2026, idle-instance reclamation), Hugging Face Spaces (free CPU Basic appears to have been removed for new Spaces around June 2026 — **UNVERIFIED**, from a community thread; test Space creation on your own account before relying on it, despite already having an account).

**Drop the AWS Lambda `RESPONSE_STREAM` idea entirely.** It solves a problem your stateless-JSON architecture does not have, and its stated justification was wrong — AWS's own documentation says Lambda "can also stream response payloads through the Amazon API Gateway proxy integration." If you want the AWS Builder mini challenge, Kiro Crew "qualifies on its own as a development tool used during the hackathon" with no runtime AWS service required.

**November reliability protocol.** The rules oblige you: "The Entrant must make the Project available free of charge and without any restriction, for testing, evaluation and use by the Sponsor, Administrator and Judges until the Judging Period ends" — Judging runs 2026-11-09 12:00 PT to 2026-11-20 12:00 PT. Set an external uptime pinger now. Put a calendar reminder on 2026-11-08 to health-check the endpoint end to end. Add a `GET /health` that returns build SHA and index count. And note the safety net: "Judges are not required to test the Project and may choose to judge based solely on the text description, images, and video." The video is the load-bearing artefact; the live endpoint is corroboration.

---

## 8. Demo plan

Under three minutes, public, English, YouTube or Vimeo. "Judges are not required to watch beyond three minutes," so the thesis must land in the first twenty seconds. Four judging criteria, equally weighted, each visibly demonstrated below.

**0:00–0:22 — The maze (Potential Impact, Quality of the Idea)**
Screen recording of a real screen reader arrowing across a real workbook: "B7, 4820… C7, 3910…" Let it run four seconds past comfortable — the boredom is the argument. Cut to the Section508.gov sentence on screen, URL visible: *"Excel does not provide tools to make complex tables accessible."* One line of narration over it: "Four out of five tables on the web have no header markup at all — that is 948,225 tables measured by WebAIM this February, and only 19% with valid markup."

**0:22–0:35 — Naming the incumbents (Quality of the Idea)**
"Microsoft ships Copilot in Excel with a screen reader. JAWS 2026 added Page Explorer. Asking instead of traversing is not a new idea. But Copilot needs Windows, a screen reader session, and the file saved to OneDrive with AutoSave on. This needs a speaker and a file." Pre-empting the objection reads as domain command; being caught unaware reads as not having done the work.

**0:35–1:45 — The ask (Design, and THE ACCESSIBILITY MOMENT)**
Screen dark. Speaker only. Four exchanges, all real, no cuts inside them:

1. *"What's in the regional sales file?"* → `table_describe` speaks the shape in one sentence: rows, columns, what the columns are, where the gaps are. **This is orientation — the thing no screen reader, no Excel feature, and no other MCP server does.**
2. *"Which regions were below target in more than half the months?"* → `table_query`. One question. On a 12×40 sheet this costs hundreds of keystrokes to traverse. **This contrast is the pitch.**
3. **THE MOMENT — 0:58 to 1:20.** *"How do you know?"* → `table_explain`: "That came from cells F14, F27 and F31 on the Sales sheet. Each one is 2026, Q3, EMEA, Revenue. Two rows were excluded because their target cells were blank." On screen, a slow zoom into the workbook showing a stacked, merged header block — `2026 | 2026` over `Q3 | Q4` — with the caption: *the file declares none of this; the server infers it.* Narration, eight seconds: "CHI 2026 studied twelve blind spreadsheet users. None of them fully trusted an AI answer they could not verify. So every answer here carries the cells it came from, and the header path for each one." **This is the beat that proves accessibility value, and it is the only beat you must not cut.**
4. *"Save my place, I'll come back to this."* → `table_bookmark`. Hard cut. Caption: **next day.** *"Where was I?"* → `table_resume` restates the table, the filter and the last answer.

**1:45–2:15 — More than a wrapper (Quality of the Idea, Design)**
Ten seconds of `table_compare` orchestrating across two sheets. Ten seconds of the MCP App widget rendering the highlighted cell region on a second screen while the voice answer plays — "input parity, from Amazon's own accessibility guide." Ten seconds of result governance: ask for something that matches 40 rows, hear the aggregate plus "would you like the top three?", say yes, hear exactly three.

**2:15–2:45 — The build (Tech Implementation)**
Fast cuts, no narration beyond a single sentence: the wire-contract test suite going green; a terminal showing the 2025-11-25 handshake frames; the p95 latency assertion under 500 ms against Amazon's published budget; the boot assertion line `spec 2025-11-25 · Streamable HTTP`; a diagram of ingest → index → planner → spoken summary with the header-path resolver highlighted. One sentence: "Self-hosted MCP server, spec 2025-11-25, Streamable HTTP, stateless JSON, two runtime dependencies, every number computed in TypeScript — never by a language model."

**2:45–3:00 — The claim (Potential Impact)**
"As of today the official MCP registry has no assistive server whose user is a disabled person — every accessibility server in it is an auditing tool for sighted developers. Here is the query. WHO counts at least 2.2 billion people with a near or distance vision impairment." Repo URL and live endpoint on screen.

**If you can get a blind or low-vision user to try it and give you ten seconds of reaction, put that at 2:45 instead and move the claim to the description.** It is the highest-leverage hour available to you across two of the four criteria. Reach out in week 1, not week 5 — r/Blind, the NVDA users group at nvda.groups.io, AppleVis, AFB and NFB communities, or the Vietnam Blind Association. Credit them by name in the README and the video. A solo sighted developer shipping a BLV product with zero BLV input is the failure mode this community recognises instantly.

---

## 9. 45-day schedule

Today is 2026-09-08. Hard deadline 2026-10-23 12:00 PT = 2026-10-24 02:00 GMT+7. **Feature freeze: 2026-10-10, end of week 5.** Everything after that is polish, video, submission and buffer.

**Week 1 · Sep 8–14 — De-risk, then skeleton**
- Day 1, in this order, before any product code: confirm the exported class name in `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.d.ts`; install `@modelcontextprotocol/sdk@1.30.0` and assert `LATEST_PROTOCOL_VERSION === '2025-11-25'`; create the Cloudflare account and deploy a hello-world Worker; upgrade to Node 24 LTS.
- Stateless Streamable HTTP endpoint live over HTTPS with one trivial tool. Wire-contract harness written and green: 2025-11-25 handshake, 202 on notification, 403 only on present-and-invalid Origin, 405 on GET/DELETE, 400 on unsupported version.
- Post to r/Blind and nvda.groups.io asking for one 30-minute feedback session in early October. This has days of lead time — start it now.
- Repo public, MIT or Apache-2.0 set via **GitHub's License field** so it shows in the About section, not just a committed LICENSE file.
- Timebox 30 minutes to the Alexa+ Local Inspector; abandon on failure and write the friction-log entry immediately while it is fresh.

**Week 2 · Sep 15–21 — Structure inference (the technical core)**
- Ingest CLI: CSV/TSV parser (hand-rolled), exceljs xlsx path, region detection, header-row scoring, merge resolution and forward-fill, header-path construction, type inference, provenance map.
- Index format frozen and versioned. Golden-file tests over five hand-built fixtures: flat table; two-row stacked header; horizontally merged header block; irregular header with a title row above; a sheet with three separate regions. Include a W3C bus-schedule-shaped fixture.
- **Milestone: `npm run ingest` produces a correct header path for every cell in all five fixtures.** If this slips past Sep 21, cut `table_compare` from scope immediately.

**Week 3 · Sep 22–28 — Tools and query planning**
- All eight tools registered with final names, schemas and description strings. Query planner, executor, exclusion accounting, `answer_id` store, cursor minting.
- Spoken-summary formatter with the 30-word ceiling and number formatting by inferred type.
- Every error path returning the two-line `isError` format.
- KV-backed bookmark store; `table_bookmark` / `table_resume` working across a server restart.
- Latency harness asserting p95 under 500 ms on the largest fixture.

**Week 4 · Sep 29 – Oct 5 — Voice client**
- Web Speech API STT/TTS page. Real MCP client over Streamable HTTP to the deployed endpoint. LLM tool-calling loop. Echo-frame styling, listening ring, barge-in, latency read-out.
- **Test in Chrome on day 1 of this week.** If Web Speech recognition disappoints, fall back to push-to-talk with a different STT and keep `SpeechSynthesis` for output; do not let this consume more than two days.
- Deploy the Deno Deploy standby.
- Demo dataset finalised and rehearsed — the 12×40 sheet with a merged multi-level header that makes beat 3 land.

**Week 5 · Sep 29 – Oct 12 — Creative-rubric hardening, then FREEZE**
- MCP App `ui://` widget on `table_explain` using `@modelcontextprotocol/ext-apps@1.7.5`. Optional `SKILL.md`.
- README section literally titled **"Why this is not a basic MCP wrapper"**, answering the rubric language head-on: state across sessions, orchestration across sheets, MCP Apps, and the three claimed technical contributions.
- BLV feedback session. Fix whatever it surfaces. Credit by name.
- **2026-10-10: FEATURE FREEZE. No new tools, no new formats, no new surfaces after this date, for any reason.**

**Week 6 · Oct 13–19 — Video and submission assets**
- Storyboard, film, cut. Budget three full days — the video is the load-bearing artefact and always takes longer than expected.
- Devpost submission text, images, full description. Product Feedback section (mandatory: which tools, what worked, what needs work, zero-to-hello-world onboarding, would you build again and why).
- **Friction log — reserve a real block, not the last 90 minutes.** The rules: "During Stage 1 downselection, Amazon's internal review team assesses each submission's friction log entries (if provided) and passes a recommended bonus — up to 10% — to the Stage 2 judging panel." It is quality-assessed, not automatic. You have six strong, verifiable entries already: (1) `@alexa-ai/cli` 404s on public npm with no error guidance; (2) setup requires an AWS account "provided to the Alexa Solutions Architect" with no way to initiate that contact from the docs; (3) prerequisites list only macOS and Ubuntu, silently excluding Windows; (4) the Local Inspector's own curl example sends `protocolVersion 2025-06-18` while the toolkit overview states 2025-11-25 support; (5) "select partners only" appears on the docs home but not on the overview and quickstart pages a developer actually lands on, so you can read the whole path before discovering you are blocked; (6) unscoped `npm install alexa-ai` resolves to an unrelated third-party package adjacent to Amazon's private `@alexa-ai` scope — a name-confusion hazard. Write each as task, steps, expected vs actual, severity, workaround, actionable suggestion.
- Request the $150 AWS credits by **2026-10-21 12:00 PT** using the form in the Official Rules (forms.gle/5hyhr1u6x3fuV2aW7). The Resources page links a different form (forms.gle/GaHFxSbBQNG9Kti6A) and the Rules control on conflict — if the rules form fails, submit the other and screenshot it.

**Week 7 · Oct 20–23 — Buffer and submit**
- **Submit by Oct 21.** Two clear days of margin before the Oct 23 12:00 PT cutoff. Do not plan to submit on the last day from GMT+7.
- Final `npm audit`, lockfile committed, README run instructions verified from a clean clone.
- Enter both mini challenges (Open Source and AWS Builder) — but note the ceiling: "A project can only win one (1) track prize and one (1) mini challenge prize."
- Oct 22–23 held empty for whatever breaks.

**Cut list, in the order things get cut if you slip:** `table_compare` → the MCP App widget → `SKILL.md` → `group_by` in `table_query` → `.xlsm` support. Never cut: `table_explain`, the two-line error format, the spoken-summary ceiling, the wire-contract tests, or the video.

---

## 10. Kill risks, ranked

**1. The "basic MCP wrapper" reading, on a criterion worth 25%.**
The rules name your project's shape as the Obvious archetype for this track. Accessibility framing earns Potential Impact, a different criterion, and does not rescue this one.
*Mitigation:* ship state across sessions (`table_bookmark`/`table_resume`, KV-backed), cross-sheet orchestration (`table_compare`), and the MCP Apps `ui://` widget — three named Creative bullets. Write the README section "Why this is not a basic MCP wrapper" and answer the rubric language directly. Lead the Devpost description with the assistive-consumer claim, not with the tool list.

**2. Scope collapse in a 45-day solo build.**
The optimal plan is server + inference engine + voice client + widget + video + friction log. The video and the friction log get scored and are the first things a tired builder cuts.
*Mitigation:* the hard Oct 10 feature freeze and the explicit cut list above. Three days budgeted for the video in week 6, not the last night. The friction log gets its own block.

**3. Structure inference is harder than it looks.**
Header detection, merge resolution and multi-level paths on arbitrary real files is the actual engineering work, and it is week 2 of seven.
*Mitigation:* five golden fixtures, frozen index format, a hard Sep 21 milestone with a pre-agreed consequence (cut `table_compare`). Scope inference to what the demo dataset needs and be honest in `table_describe`'s `spoken` when inference is low-confidence — an audible "I could not find a header row in this sheet, so I am calling the columns A through F" is better engineering *and* better accessibility than a silent guess.

**4. Availability collapse during Nov 9–20.**
You must keep the project reachable and free to test for 28 days after you stop working. A sleeping free tier or an expired credit silently zeroes you.
*Mitigation:* Cloudflare Workers (never sleeps, no cold start, no trial expiry), $5/month Paid to remove the CPU ceiling, Deno Deploy standby URL in the README, external uptime pinger from week 4, `/health` endpoint, Nov 8 calendar reminder. Fallback comfort: judges may judge on description, images and video alone.

**5. Unsourced spoken numbers destroy trust — the documented failure mode.**
CHI 2026 found blind spreadsheet users never fully trust AI output and verify constantly. A voice channel is the worst possible medium for verification: there is no cell to glance at.
*Mitigation:* this is why `table_explain` exists and why no LLM computes anything inside the server. Make provenance the headline feature, not a footnote, and cite CHI 2026 as the reason. This converts your biggest risk into your strongest design argument.

**6. The speed objection from an expert blind judge.**
Experienced screen-reader users listen at rates Alexa's TTS cannot match or be configured to match. "Faster than a screen reader" is a claim you will lose.
*Mitigation:* never make it. Argue situationally — screenless, hands-free, away from the desk, and questions whose answers require aggregation across hundreds of cells where traversal is genuinely worse. Frame the product as a complementary reconnaissance and orientation channel, not a replacement for the workbook session. That framing also answers the CHI 2025 finding that AI must "support existing SR workflows." **Do not quote the 250–780 WPM speech-rate figures — they were never verified by anyone on this project.**

**7. No blind co-designer.**
Every paper cited here involves 12–99 BLV participants. A solo sighted developer shipping a BLV tool with zero BLV input is the most visible failure mode in this category.
*Mitigation:* one 30-minute session with one screen-reader user, arranged in week 1, credited by name in the README and video. Frame the evaluation in the same terms as the CHI 2026 AskEase paper (arXiv 2601.18092) — within-subjects, task success, perceived workload — even at n=3, and say so.

**8. Web Speech API disappoints, taking the demo surface with it.**
Browser support and recognition quality are **UNVERIFIED**.
*Mitigation:* test it on day 1 of week 4, not week 6. Fallbacks in order: push-to-talk instead of continuous listening; a different STT with `SpeechSynthesis` retained for output; a pre-recorded audio track over live screen capture. Two days maximum on this.

**9. The web-standard transport does not compose cleanly on Workers, or exceljs cannot be kept out of the edge bundle.**
The module is verified to exist; the exported class name is not.
*Mitigation:* it is the day-1 task for exactly this reason. Fallback is the Node + express server on Deno Deploy or a small always-on Node host, costing a small amount of cold-start margin and nothing else. The offline-ingest architecture already guarantees exceljs never reaches the runtime bundle.

**10. Stale or fragile citations caught on camera.**
Several load-bearing sources block automated fetching, and WebAIM Survey #11 may publish inside your build window.
*Mitigation:* before recording, confirm in a real browser: the JAWS 2026 Page Explorer scope and the Insert+Shift+E keystroke on freedomscientific.com (403s to automated fetch; current corroboration is a reseller page); webaim.org/projects/screenreadersurvey11/ — if #11 has published, cite it and drop the January-2024 figures. **Never say Survey #11 "closed on 31 August" — the page gives no date.** Never display the JAWS Defined Names token spellings. Never state a global blind-population total attributed to WHO. Never put an AFB employment percentage on a slide. Write "W3C Recommendation, 12 December 2024" for WCAG 2.2. Never claim tables are the top screen-reader pain point — WebAIM Survey #10 ranks complex data tables 10th of 12, and a knowledgeable judge will use it against you; say instead that the ranking has been "largely unchanged over the last 14 years," in WebAIM's own words, and note that the survey covers web content and contains nothing about Excel at all.

**11. The wrong protocol revision, in the direction nobody expects.**
The risk is not that 2025-11-25 is too old — it is prompting an AI assistant with "use the latest MCP spec" and getting a 2026-07-28 server that Alexa+ cannot speak, or `pip install`-style drift into SDK v2.
*Mitigation:* pin `@modelcontextprotocol/sdk` to exactly `1.30.0`, commit the lockfile, keep the boot assertion, and never install `@modelcontextprotocol/core|server|client` 2.x. Instruct any coding assistant explicitly: target 2025-11-25.