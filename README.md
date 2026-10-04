# Landmark

**An MCP server that lets you ask a spreadsheet questions out loud, instead of walking it cell by cell.**

Built for the Alexa+ track of the Amazon Developer Hackathon 2026. MIT licensed.
A self-hosted MCP server on protocol revision `2025-11-25` over Streamable HTTP, with a
browser voice client that stands in for a device.

## Quick start

Needs Node.js 22.7 or later and npm. The commands are the same in bash and PowerShell:

```
git clone https://github.com/ledinhminhquan/landmark-mcp
cd landmark-mcp
npm ci
npm run serve
```

Open `http://localhost:8787/` in Chrome or Edge. Type each of these into the box and press
Enter, or press **Ask by voice** and say them:

1. *what's in the budget file*
2. *total amount for engineering* (560 thousand)
3. *how do you know* (the cells it came from: C3 through C5)

The typed box works in any browser. `npm test` runs the 615 tests, and [Run it](#run-it)
has the options.

---

## The problem, stated accurately

It is tempting to write "screen readers lose header context." That is not true, and
getting it wrong would be the fastest way to lose the trust of anyone who actually
uses one. JAWS and NVDA both announce headers in Excel.

The real difficulty is narrower and harder:

- **Header association is manual, per worksheet, and does not travel.** Headers set up
  for one reader do not carry to another. [NVDA #11801](https://github.com/nvaccess/nvda/issues/11801),
  open since November 2020, is about exactly that: headings defined with NVDA's
  commands are not spoken in JAWS, although NVDA's user guide says they will be.
- **Authors rarely declare a table's structure, even where they can.** The
  [WebAIM Million, February 2026](https://webaim.org/projects/million/) counted 948,225
  tables on the top million home pages and found valid data-table markup on 19% of them.
  That is web pages, not spreadsheets, but it is the largest count we know of how often
  people mark up headers when a way to do so exists. For spreadsheets, Section508.gov
  puts it plainly: *"Excel does not provide tools to make complex tables accessible."*
- **Even with headers announced, questions cost traversal.** "What is the total?" is
  O(rows). "Which region did best?" is O(rows × cols). There is no cheap way to learn a
  table's shape before committing to walking it.

A sighted reader answers all three with a glance, which costs nothing and is not
sequential. Landmark reconstructs the structure the file never declared, so the same
questions can be *asked* rather than *traversed*.

## What it does

Word for word, from the bundled budget file (`npm run demo` prints these and more,
from the real server):

```
You:       what's in the budget file
Landmark:  "FY2026 Departmental Budget" has 5 rows and 3 columns. The columns are
           Department, Line item and Amount. 3 cells take their label from a merged
           block, so they are not the blanks they look like.

You:       total amount for engineering
Landmark:  560 thousand. That is the total of Amount across 3 rows.

You:       how do you know
Landmark:  That came from C3 through C5 on Budget. Each one is Amount.
```

The third exchange is the one that matters. At CHI 2026, Perera, Ananthanarayan, Goncu
and Marriott studied how 12 blind spreadsheet users check what generative AI gives them
([*"I'm Always a Little Skeptical of It": Verification Practices of Blind Users When
Working with Generative AI in Spreadsheets*](https://doi.org/10.1145/3772318.3790988)).
Their participants never fully trusted the output without verifying it, and verifying
was often effortful or time-consuming. Over audio there is no cell to glance at. So the
arithmetic happens in the server, not in a language model, every answer keeps the cells
it came from, and `table_explain` reads them back.

For a highest or a lowest, it names the row, and the explanation starts with the
winning cell:

```
You:       who is the top rep                                (the sales table)
Landmark:  21 thousand, for Chi. That is the highest Revenue across 5 rows.

You:       how do you know
Landmark:  That came from C4 on Sales, for Chi, the highest of 5 cells: C2 through C6.
           Each one is Revenue.
```

Cells it could not count are said out loud, because "the total" and "the total of the
rows that held numbers" are different claims. A `table_query` on a five-row CSV with one
blank cell and one "n/a" (made for this check, not in the bundled data):

```
Landmark:  650. That is the total of Sales across 3 rows. I skipped 2 rows: 1 was empty
           and 1 did not hold a number.

You:       how do you know
Landmark:  That came from B2, B4 and B6 on gaps. Each one is Sales. 2 cells did not
           count: B3 empty and B5 not a number ("n/a").
```

Some figures have no total. Adding up a rate or a ratio, a speed, a median, a figure per
capita or per head, or a percentage that is not a share of the whole gives a number that
means nothing, so the server refuses it and offers the average, highest or lowest instead.
A single row's figure, or a ranking with one row per group, is still answered. The voice
client asks for the average and says that it did:

```
You:       total GDP per capita                              (the countries table)
Landmark:  GDP per capita (usd) cannot be added up into a total, so this is its average.
           About 17.2 thousand. That is the average of GDP per capita (usd) across 8 rows.
```

A share of the whole ("Ownership %", "% of total", "Tỷ trọng (%)") adds up as usual, to
100%. A column that is already an average, or a figure per person, unit or serving, can
add up to something real: the cost per person of each part of a trip adds up to what the
trip costs one person. So a total of one, asked for in so many words, is given and said
to be one. From a six-row trip budget made for this check, not in the bundled data:

```
You:       what is the total cost per person
Landmark:  340. That adds up Cost per person (usd) across 6 rows, each of them a
           per-person figure.
```

## Try it on the bundled tables

`data/index.json` holds six small tables. Five are workbooks generated by
`test/fixtures/make.ts`: *Sales data*, *Quarterly data* (a stacked header), *Compare
sheet* (a merged header), the budget, whose own title is *FY2026 Departmental Budget*,
and *Mixed sheet* (one sheet holding three tables). The sixth is *Countries*
(`06-countries.csv`): eight countries with population, GDP per capita and region. That
CSV's own note calls its figures "illustrative figures for testing only"; they appear to
match World Bank World Development Indicators estimates (CC BY 4.0), so treat them as
public data, not ours. The spoken titles come from `test/fixtures/titles.json`; the
fixture file names ("the three regions file") still open the same tables.

Run the server (below), open `http://localhost:8787/` in Chrome or Edge, and either
press **Ask by voice** (or Space, when no button or text box has focus), wait for the
tone and speak, or type in the **Type a question** box and press **Ask**. Esc
interrupts. Turn **Speak answers** off to have answers announced through your own screen
reader instead of the page's voice.

Questions like these are answered; each was checked against the running server:

- *what's in the budget file*, *total amount for design*, *break it down*,
  *which department spent the least*
- *open the countries table*, *compare the population of Vietnam and Thailand*,
  *what regions are there*, *total population not in Asia*,
  *which countries have a population over 100 million*, *what region is Peru in*
- *open the sales table*, *who is the top rep*, *rank the reps by revenue*,
  *total revenue excluding the east*, *how many deals closed in August*,
  *how many deals closed after July 4*, *which region has the most reps*
- *open the mixed sheet*, *how many tables are in this file*, *table 2*,
  *total actual*
- *check the structure*, *use the first row as headings*, *the top two rows are
  headings*, *row one is data*
- *how do you know*, *save my place*, *carry on*, *more*, *help*, *start over*

It cannot work out a median or percentiles, a difference per group ("which region grew
the most"), or synonyms it was not told ("richest", "populous", "people"). Those get a
question back or a plain refusal, never a guessed number:

```
You:       what is the median population
Landmark:  I cannot work out a median. I can give a total, an average, the highest,
           the lowest, or a count.

You:       which country is the richest
Landmark:  I could not find "richest" in this table. The columns are Country,
           Population, GDP per capita (usd) and Region.
```

## Why this is not a basic MCP wrapper

The Alexa+ track rules name "a basic MCP wrapper around an existing API" as the
*obvious* shape of entry, against a *creative* list that includes state across
sessions, MCP Apps and Agent Skills. That is a fair challenge to put to a project
shaped like this one, so here is the answer in specifics.

**1. It infers structure that is not in the file.** A spreadsheet declares a grid, not
a table. Landmark detects table regions separated by blank rows, scores which rows are
headings and says when it is unsure, resolves merged blocks, and rebuilds a full
heading path for every column. Four columns all labelled `Revenue` come back as
*2026 Q1 Revenue* … *2025 Q2 Revenue*, with the path `["2026", "Q1", "Revenue"]` kept
in the structured result. A row labelled Total, Subtotal or Tổng cộng is recognised
and left out of answers, and the answer says so ("300. That is the total of Amount
across 2 rows. I left out the Total row."). So is a "Housing Total" row of the kind
Excel's Subtotal command and PivotTables write, or a hand-typed "Total Expenses" or
"Tổng doanh thu", once its figures add up the rows above it. Rows labelled Average,
Count, Max or Min (or Highest, Lowest, Trung bình…) are left out the same way, but only
when every figure in them is that statistic of the rows above, and the answer names them
("I left out the Total and Average rows."). Numbers written the Vietnamese or European
way ("1.234,56", "45.000 ₫") are read as such; a value that could go either way ("12.500") is read with the dot as the decimal
point, and the description and every total, average, highest, lowest or breakdown of
that column say so out loud.
Dates such as 01/09/2026 are read day first when the rest of the file is written that
way; when nothing in the file settles it, the reading is stated as a guess. When the
reading of the headings is wrong, the listener can correct it by voice:

```
You:       check the structure                     (table 3 of the mixed sheet)
Landmark:  I am treating 1 row as headings — the first row reads as labels. That gives
           the columns Note and Status. I am not certain: I could instead treat every
           row as data. Tell me how many rows are headings to change it.

You:       row one is data
Landmark:  Right — I now read no heading rows instead of 1 heading row. That gives 2
           rows of data, and I will call the columns by position. That holds for the
           rest of this conversation.
```

There is no API to wrap here; this is the work.

**2. Provenance is a tool, not a log line.** Every aggregate records its source cells,
the rows it left out, and why. Nothing is recomputed on explain, because a
recomputation that disagreed with what was already spoken would be worse than no
provenance at all.

**3. Output is shaped for listening in the server, not left to a prompt.** Every tool
returns a `spoken` field: a ready-to-say summary capped at about 70 words (roughly 30
seconds of speech), at most five items at a time by default with a cursor for the rest,
numbers scaled for listening ("about 100.4 million"), and no tool names, ids or field
names.
The exact figures stay in the structured result. The server's instructions offer
`spoken` as ready to say and ask the host to say it as written. That is an offer, not
a script: Amazon's add-on design guidance says you influence Alexa's response *through
the data you return, not by scripting it directly*, so a host that writes its own reply
still has the exact numbers and cells to write it from. Errors are spoken too, with a
next step, including arguments the schema refuses and tools that do not exist.

**4. State outlasts the request, and where it lives is stated.** Answers, heading
corrections and bookmarks are kept per conversation. On Cloudflare Workers each
conversation is a SQLite-backed Durable Object, cleared after 90 days without use, and
each answer is its own Durable Object, deleted after 7 days. Bookmarks carry across
conversations only for the voice client, which keeps one random id per browser in
`localStorage`; for MCP hosts they, and structure corrections, last one connection.
Answers can be explained from any later connection by their id, for a week on the
Worker. Run locally, all of this is in memory and ends when the server stops. Callers
that send no session id share one in-memory conversation, and `GET /health` says which
of these you are getting (`"state": "durable"` or `"this instance only"`).

**5. It works across sheets and files.** `table_compare` runs two aggregations over
different columns, sheets or files and returns the difference and its direction in one
sentence ("2026 Q1 Revenue is 200 more than 2025 Q1 Revenue, about 11%: 2100 against
1900."), so nobody has to hold two numbers in their head and subtract them. It takes the
same conditions as a query and says them first ("For South, Target is 5100 more than
Actual, about 131%: 9000 against 3900.").

**6. An MCP App shows the cells.** `table_explain` declares a UI resource,
`ui://landmark/explain` (`text/html;profile=mcp-app`), that draws the source table with
every counted cell highlighted and marked "(counted)" in text as well as colour, and the
winning cell of a highest or lowest marked "(the answer)", up to 40 rows. Many blind and low-vision people have some usable sight or work beside sighted
colleagues; this lets them, or the colleague, see the cells the sentence names. It never
replaces the spoken answer. Its handshake and rendering are tested in Node against the
MCP Apps message shapes (`test/engine-widget.test.ts`); it has not yet been rendered in
a real MCP Apps host, and the bundled voice client does not show it.

**7. An Agent Skill teaches a model how to use it.**
[`skills/landmark-tables/SKILL.md`](skills/landmark-tables/SKILL.md) is an Agent Skill
for an assistant driving these tools: describe before querying, aggregate instead of
reading rows, say the `spoken` sentence, offer the working after a total, carry the
cursor on "more". It has not been evaluated with a model yet.

**And what it deliberately does not do:** there is no `get_cell`, `get_row` or
`get_column`. Those would rebuild the cell-by-cell maze in tool form and hand the
traversal problem back to the model.

## Prior art, conceded

The intersection is unoccupied; none of the neighbourhoods are.

| | |
|---|---|
| **Dozens of spreadsheet MCP servers** are in the official registry (a name search for excel, spreadsheet, csv and xlsx on 2026-09-27 returned 46 distinct servers; [`excel-mcp-server`](https://github.com/haris-musa/excel-mcp-server) alone has 4,000+ stars) | They exist to let an LLM read and edit files. Their consumer is a developer. None of their descriptions mention accessibility, blind users, screen readers, voice or speech. |
| **VoxLens** (CHI 2022) makes online charts accessible to screen-reader users through an interactive JavaScript plug-in | The chart's publisher has to add the plug-in. A self-hosted server that ingests your own file does not need the publisher's cooperation, though today it does need someone to run the ingest step (see limits). |
| **VERSE** (ASSETS 2019) paired a screen reader with a voice assistant for eyes-free web search | Close in spirit, voice alongside a screen reader, but it is about web search, not tables. |
| **Copilot in Excel** works with a screen reader today | It documents a prerequisite of AutoSave and OneDrive, and it answers in a chat pane you must then navigate. |

The honest version of the market claim. We know of no MCP server that lets a blind
user interrogate a spreadsheet by voice, and that is the gap this fills, but it is an
observation, not a claim of being first. Two things cut against a stronger version.
The official registry does contain end-user assistive servers: **NeuroDock** publishes
several for cognitive and executive-function support, aimed at neurodivergent users
rather than at developers. And the registry's `search` matches substrings of *server
names* only, not descriptions or audiences, so a query returning nothing for
"assistive" is evidence of nothing. An earlier draft of this README said the registry
contained no assistive server whose consumer is a disabled end user. That was wrong,
and it was wrong in the direction that flattered us.

## Run it

Needs Node.js 22.7 or later and npm. Every script runs the TypeScript directly with
`--experimental-strip-types`; 22.6, the first release to have it, cannot parse this
code. Built on Node 23.11 on Windows 11, and tested on every push on Linux, macOS and
Windows with Node 22 and 24, plus 22.7 on Linux. These commands are the same in bash and
PowerShell (`npm ci` installs exactly the versions in `package-lock.json`; `npm install`
works too):

```
npm ci
npm run serve
```

Then open `http://localhost:8787/` for the voice client. The MCP endpoint is
`http://localhost:8787/mcp` (POST only) and `GET /health` reports the protocol
revision, the number of tables and rows, and where state is kept. The bundled index
ships in `data/index.json`, so there is nothing to generate first.

- Another port: `npm run serve -- 8788` works in both shells, as does setting `PORT`
  (`PORT=8788 npm run serve` in bash, `$env:PORT=8788; npm run serve` in PowerShell).
- `npm start` builds with `tsc` first, then runs the compiled `dist/src/local.js`.
  `npm run dev` restarts on changes.
- The server listens on 127.0.0.1 only and refuses requests whose Host header is not a
  loopback name. `HOST=0.0.0.0` opens it to the network, with no Host check. Behind a
  tunnel, name the tunnel's host in `LANDMARK_ALLOWED_HOSTS` instead; that also admits
  its `https://` origin for the voice client.

`npm run serve`, `npm run ingest` and `npm run demo` run the TypeScript directly, so Node
prints an `ExperimentalWarning` about type stripping first; it is harmless.

### Your own spreadsheet

Files are loaded by an offline ingest step, not uploaded at runtime. It reads `.xlsx`,
`.xlsm`, `.csv` and `.tsv`, prints what it inferred for every table, and writes an
index. This form works in both bash and PowerShell (PowerShell swallows a bare `--`,
so it is quoted):

```
npm run ingest '--' path/to/budget.xlsx path/to/*.csv --out data/mine.json
```

Then start the server on that index:

```
LANDMARK_INDEX=data/mine.json npm run serve                  # bash
$env:LANDMARK_INDEX="data/mine.json"; npm run serve          # PowerShell
```

The CLI expands wildcards itself, so patterns work in any shell. If any input cannot be
read, nothing is written. `--out` defaults to `data/index.json`, the demo's index;
writing elsewhere keeps the demo intact (`data/*` other than `index.json` is
git-ignored).

When the list of files is read out, a file holding one table with a title row above it is
called by that title. Any other file is called by a name made from its file name, or by
the title you give it with `--titles titles.json`: a JSON object from file name to title,
1 to 60 characters each, such as `{ "budget.xlsx": "Household budget" }`. A title
changes only what is said, never the table's id. If the titles file names a file that is
not among the inputs, or gives a blank title, nothing is written.

This rebuilds the bundled index, in either shell:

```
npm run ingest '--' test/fixtures/*.xlsx test/fixtures/*.csv --titles test/fixtures/titles.json
```

The committed `data/index.json` is identical to a fresh build apart from its
`ingestedAt` timestamps, and a test (`test/integrate2-review.test.ts`) fails if it is
not.

## Deploy to Cloudflare (optional)

The hackathon FAQ says hosting is not required: a locally runnable public repository
and the demo video are enough. To put it on the internet anyway, on the Workers free
plan:

1. Create a Cloudflare account.
2. `npx wrangler login`
3. `npx wrangler deploy`. If the account has no `workers.dev` subdomain yet, Wrangler
   asks you to register one.
4. Open `https://landmark-mcp.<your-subdomain>.workers.dev/health` and check it says
   `"state": "durable"`.

The two Durable Object classes are declared in `wrangler.jsonc` and created by the
first deploy; there are no ids to paste and no KV namespace. `npx wrangler deploy
--dry-run` (Wrangler 4.147.0, on 4 October 2026) shows both bindings (`LANDMARK_STATE`
and `LANDMARK_ANSWERS`) and a bundle of about 1,000 KiB, 204 KiB gzipped, with no ExcelJS
or PapaParse code in it. The voice client is served from the same origin as
`/mcp`. Other browser origins get 403 unless listed in the `LANDMARK_ALLOWED_ORIGINS`
variable; no CORS headers are sent. To run the Workers build locally with its Durable
Objects, use `npx wrangler dev`.

This repository has not been deployed by its author yet, so there is no public URL
here.

## How it is put together

```
spreadsheet ──[ ingest CLI, Node ]──▶ data/index.json ──[ server ]──▶ MCP tools
                                                            │
                                   voice client (web/) ─────┘  same origin, POST /mcp
```

The split is deliberate. ExcelJS wants Node streams and Buffer, which Workers provide
only behind the `nodejs_compat` flag, so parsing there is possible but not free. A
spreadsheet does not change between deploys, so everything expensive happens once,
offline, and the server does pure computation over plain JSON. The same fetch handler
runs under Node locally and on Workers.

Measured on the Windows 11 machine this was built on, on 4 October 2026: a grouped sum
over 2,000 rows, through the full handler in one process, took 1.8–2.7 ms at the median
and 4.5–7.7 ms at the 95th percentile over six runs of `test/latency.test.ts`, which
asserts that the 95th percentile stays under 500 ms. Network time is on top of that.
Start-up on Cloudflare itself has not been measured.

| Path | What lives there |
|---|---|
| `src/table/` | Region detection, heading scoring, merge resolution, heading paths, type and number inference |
| `src/ingest/` | Readers for xlsx/xlsm/csv/tsv, wildcard expansion and the index builder (Node only) |
| `src/query/` | Deterministic filtering and aggregation, with an account of what was left out |
| `src/voice/` | Spoken formatting, word budgets, number scaling |
| `src/mcp/` | The nine tools, the explain widget and the in-memory store |
| `src/state/` | The Durable Objects that hold state on Workers |
| `src/server.ts` | The web-standard fetch handler, the same code locally and on Workers |
| `src/local.ts`, `src/worker.ts` | The Node runner (with the static voice client) and the Workers entry |
| `web/` | The voice client: a real MCP client, with rule-based routing rather than a language model |

## The nine tools

| Tool | For |
|---|---|
| `table_list` | What files are available, five per page with a cursor, with the tables inside each |
| `table_describe` | Orientation: shape, columns, types, categories, merged cells, other tables in the file, and any doubt about the reading; a wide table's column names come a page at a time, with a cursor. Call it first |
| `table_structure` | Say how many rows are read as headings and why, and change it (0–5) when that is wrong |
| `table_query` | Filter and aggregate (count, sum, average, highest, lowest, optionally grouped and ordered); returns a spoken sentence plus the working |
| `table_explain` | Read back the exact cells behind a previous answer, first naming that answer when other questions came between; also the MCP App above |
| `table_read_rows` | Individual rows, up to ten a call, when a summary will not do |
| `table_compare` | Two measures across columns, sheets or files, optionally under the same conditions as a query |
| `table_bookmark` | Save a place in this conversation |
| `table_resume` | Come back to it, re-oriented; with no name, the newest |

## Tests

```
npm test            # 615 tests
npm run typecheck   # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm run demo        # prints what the server says to a scripted conversation
```

`test/demo.test.ts` pins the filmed demo conversation word for word, and
`test/judge-questions.test.ts` pins questions a judge might make up. GitHub Actions
(`.github/workflows/test.yml`) runs the typecheck, the suite and the build on every push
and pull request: on Linux, macOS and Windows with Node 22 and 24, and on Linux with
Node 22.7.0, the oldest supported. The suite also passes with the process time zone set
to America/Los_Angeles, Pacific/Kiritimati and Asia/Ho_Chi_Minh. In Git Bash on the
Windows machine those runs were made on, a `TZ` set on the command line did not reach
Node; in PowerShell, `$env:TZ = 'Pacific/Kiritimati'; npm test` did, and that is how this
build's runs were made on October 4 (Asia/Ho_Chi_Minh is that machine's own zone).

## Status and honest limits

- **No blind or low-vision person has used it yet.** The CHI 2026 study above worked
  with 12 blind spreadsheet users; this has been tried by none, and that gap is real.
- **You cannot bring a file at runtime.** A spreadsheet reaches Landmark only through
  the offline ingest CLI, followed by a restart of the local server (or `LANDMARK_INDEX`
  pointing at the new index) or a redeploy of the Worker. A deployed Worker serves the
  index it was built with to everyone.
- **English only.** Speech recognition and synthesis are set to US English and the
  voice client's routing rules are English. Column names in other languages are kept as
  written, but an English voice reads them.
- **Speech input depends on the browser.** It uses the Web Speech API's recognition,
  which Chrome and Edge provide; Safari also exposes it but has not been tested here,
  and Firefox does not, so there you type. Chrome's recognition is server-based, so the
  audio of a question leaves the machine even when Landmark runs locally. The typed box
  avoids that. The microphone path and screen readers (NVDA, JAWS, VoiceOver) have
  not been tried on real hardware with this build; the typed path has been checked in a
  browser.
- **The voice client is a rule router, not a language model.** It handles the phrasings
  above and asks when it is unsure. It was probed with several hundred improvised
  questions, each checked against figures worked out separately from the rows, and every
  wrong answer those probes found is now a regression test — but a phrasing outside its
  rules can still be misread rather than refused. "How do you know" names the exact rows
  and cells behind any answer, which is the way to catch that. A model-driven MCP host
  would not be bound to those rules, but none has been tested.
- **Heading detection is a heuristic, and says so.** When it is unsure it tells the
  listener and offers the alternative, and the listener can correct it by voice.
- **Ambiguous numbers are a guess.** A column whose only values look like "12.500" is
  read with the dot as the decimal point, and the description and every total, average,
  highest, lowest or breakdown of that column warn that the figures may be a thousand
  times larger.
- **Not tested on Alexa+.** Amazon's Alexa+ MCP Toolkit is available to select partners
  only; the hackathon FAQ says there is currently no way for hackathon participants to
  apply for or gain access. The MCP server is the deliverable the track asks for, and
  the browser client stands in for a device. How an Alexa+ host holds MCP sessions,
  and therefore how long corrections and bookmarks last there, is unknown.
- **No authentication.** A session id separates conversations; it is not a password.
  Anyone who can reach a deployed endpoint can read every bundled table. Text from
  cells, headings and notes is passed to a host as data, and the server's instructions
  say it is never to be followed as instructions.

## Licence

MIT; see [LICENSE](LICENSE).

On 4 October 2026, `npm audit` reported two moderate entries and nothing higher. Both are
one advisory, uuid below 11.1.1
([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)), reached
through ExcelJS, which the server never loads (the offline ingest step, the fixture
generator and the tests use it). npm's only offered fix installs exceljs 3.4.0, a
breaking downgrade. [docs/SECURITY-NOTES.md](docs/SECURITY-NOTES.md) explains why it is
accepted rather than suppressed. New advisories appear over time, so run `npm audit` to see today's state.
