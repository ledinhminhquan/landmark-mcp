# Demo video — script and recording plan

Updated September 27, 2026. **Target running time: 2:50** (170 seconds, 12 shots). The rules
require a video under three minutes, publicly visible on YouTube or Vimeo, in English, with no
third-party trademarks or copyrighted music unless the entrant has permission
([official rules](https://amazonappdev2026.devpost.com/rules)).

**Status: script ready; nothing has been recorded, uploaded or submitted.**

The five exchanges below are not a plan for what the product might say. They are what it says
now: `test/demo.test.ts` drives the page's own router against the real MCP handler and fails if
any of the five replies changes by one character. The same sequence was also entered into the
real page of this build, served by the local server, through its typed-question path, and
every reply matched.

The story is one budget review. Ask for a department's total, ask where it came from, change
department, ask again, then hear both totals. A real answer is heard before 0:15. The budget
file is opened before the take and the opener says so on screen. The video makes no claim of
Alexa device integration, of persistence across sessions, of an MCP Apps widget on screen, of
measured user benefit, or of being first.

**The one rule for the whole video:** never say "as you can see". The product is for people
who cannot. If a sentence only works because the viewer is looking at the screen, rewrite it.

---

## The conversation, verbatim

Preparation, before the camera rolls (it is also the warm-up):

| Say or type | Reply |
|---|---|
| what's in the budget file | "FY2026 Departmental Budget" has 5 rows and 3 columns. The columns are Department, Line item and Amount. 3 cells take their label from a merged block, so they are not the blanks they look like. |

The filmed exchanges, in order:

| # | Say | Reply |
|---|---|---|
| 1 | Total amount for engineering. | 560 thousand. That is the total of Amount across 3 rows. |
| 2 | How do you know? | That came from C3 through C5 on Budget. Each one is Amount. |
| 3 | Total amount for design. | 234 thousand. That is the total of Amount across 2 rows. |
| 4 | How do you know? | That came from C6 through C7 on Budget. Each one is Amount. |
| 5 | Break it down. | Engineering, 560 thousand and Design, 234 thousand. |

Each reply is one real MCP tool call: `table_query` for 1, 3 and 5, and `table_explain` for 2
and 4, which reads back the cells behind the answer the page received last. Record the
product's own speech. Never re-voice a reply yourself.

---

## Audio budget

| Voice | Words spoken |
|---|---:|
| Narrator | **196** |
| User questions | **19** |
| Product replies | **71** |
| All voices | **286** |

The narration has 194 written words. "MCP" is said as three letters, which makes 196 spoken
words. Product replies are counted as they are pronounced: "560 thousand" is "five hundred and
sixty thousand", "C3" is "C three".

At 150 words a minute all speech needs about 114 seconds, which leaves about 56 seconds of the
170 for response time, breaths and holds. Spread over its own time slot, no narration passage
needs more than 116 words a minute. That is a timing budget, not a measurement of anyone's
voice: rehearse the real audio. Never overlap the narrator and the product, and never cut the
product's words to fit.

These are target edit times. If a reply arrives early, keep its natural start and put the spare
time into a genuine hold on the ready screen at the end of that shot. Never freeze a
"Working…" state to fake a delay. Reconcile the caption times to the real recording.

---

## Shot-by-shot timeline

Keep a small, legible label on screen during all application footage: **Browser voice
prototype · Local MCP server · Synthetic data**. Add **Budget opened before the take** in the
opener. Criterion labels, if you use them, go in a corner; the behaviour beside each label is
the evidence.

| Time | Shot / voice | Exact audio | Words | Direction / criterion |
|---|---|---|---:|---|
| 00:00–00:04 | 01 · Narrator | Which rows belong in this department's total? | 7 | First frame: the real Landmark page, already on the budget, with a small source-data inset showing the merged Engineering label and its three amounts. No title card. **Potential Impact** |
| 00:04–00:06 | 01 · User | Total amount for engineering. | 4 | Press **Ask by voice**, wait for the tone, speak. The recognised words appear in the conversation panel. **Design, Tech Implementation** |
| 00:06–00:08 | 01 · Silence | — | 0 | The real "Working…" state; nothing replaces the response. |
| 00:08–00:15 | 01 · Product | 560 thousand. That is the total of Amount across 3 rows. | 14 | The whole reply plays and its text is on screen. The product has answered before 0:15. **Tech Implementation** |
| 00:15–00:29 | 02 · Narrator | Landmark is a browser voice prototype for blind and low vision spreadsheet users. This demonstration uses a synthetic budget and a local MCP server. | 26 | Hold the answer and the inset. Caption: *Intended users: blind and low-vision spreadsheet users.* **Potential Impact** |
| 00:29–00:31 | 03 · User | How do you know? | 4 | Same conversation; no cell is selected or named. **Design, Quality of the Idea** |
| 00:31–00:33 | 03 · Silence | — | 0 | Real processing state. |
| 00:33–00:40 | 03 · Product | That came from C3 through C5 on Budget. Each one is Amount. | 14 | Show the real reply. Highlight C3, C4 and C5 in the inset, labelled *Source-data annotation*. **Quality of the Idea** |
| 00:40–00:57 | 04 · Narrator | The file merges Engineering across three rows. Landmark resolves that shared label, adds the three amounts, and keeps their cell addresses with the answer. Here are the same source cells. | 30 | Enlarge the inset: A3:A5 merged "Engineering"; C3 = 480000, C4 = 62000, C5 = 18000. Keep row numbers visible. **Tech Implementation, Quality of the Idea** |
| 00:57–00:59 | 05 · User | Total amount for design. | 4 | Back to the page; only the department changes. **Design** |
| 00:59–01:01 | 05 · Silence | — | 0 | Real processing state. |
| 01:01–01:09 | 05 · Product | 234 thousand. That is the total of Amount across 2 rows. | 15 | The different total, spoken and on screen. **Design, Tech Implementation** |
| 01:09–01:11 | 06 · User | How do you know? | 4 | The same short follow-up, with no filename, amount or cell in it. **Design** |
| 01:11–01:13 | 06 · Silence | — | 0 | Real processing state. |
| 01:13–01:20 | 06 · Product | That came from C6 through C7 on Budget. Each one is Amount. | 14 | The inset now highlights C6 and C7, not C3 to C5. **Design, Quality of the Idea** |
| 01:20–01:37 | 07 · Narrator | The follow up now checks Design. It uses the latest answer, so the listener does not repeat a filename or a cell range. Both the question and its evidence can be heard. | 32 | Show both question-and-explanation pairs in the conversation panel. Caption: *Follow-up context: latest answer.* **Design, Quality of the Idea** |
| 01:37–01:39 | 08 · User | Break it down. | 3 | Stay on the budget. **Design** |
| 01:39–01:41 | 08 · Silence | — | 0 | Real processing state. |
| 01:41–01:49 | 08 · Product | Engineering, 560 thousand and Design, 234 thousand. | 14 | Two departments, no wall of rows. **Design** |
| 01:49–02:03 | 09 · Narrator | Two departments, one short answer. This is for someone reviewing a budget by audio, who needs both a result and a way to question it. | 25 | Hold the breakdown beside the two explanations. Caption: *Intended task: review and check a budget by audio.* No user-study or time-saving claim. **Potential Impact** |
| 02:03–02:24 | 10 · Narrator | This recording uses real calls to the server. Initialization selects the protocol version shown here. The browser calls the query tool, receives its answer identifier, then calls explain with that identifier. | 31 | Three 7-second crops from the network log of the same take (see *Network proof* below). Caption: *Streamable HTTP · MCP 2025-11-25*. **Tech Implementation** |
| 02:24–02:40 | 11 · Narrator | The prototype understands questions by rules, not a language model. Testing with blind and low vision users is the next step: can they check an answer and stay oriented using speech? | 31 | Back to the real page. Caption: *Rule-based routing · User testing not yet done.* No testimonials. **Potential Impact, Design** |
| 02:40–02:48 | 12 · Narrator | Landmark gives a spoken answer and a way to check it against the source. | 14 | The last reply and its source cells together. No new feature, no title card. **Quality of the Idea** |
| 02:48–02:50 | 12 · Silence | — | 0 | Hold the final working frame for two seconds and end. No outro. |

**Optional spoken protocol line.** The protocol version is on screen in shot 10 but never said
aloud, so a judge who only listens will not hear it. If you want it heard, replace the shot 10
narration with: *"This recording uses real M C P calls to the server. Initialization selects
protocol version twenty twenty-five, eleven, twenty-five. The browser calls the query tool,
receives its answer identifier, then calls explain with that identifier."* That is 35 spoken
words in 21 seconds (100 words a minute) and brings all voices to 290 words, about 116 seconds
at 150 words a minute.

## Where the four criteria are shown

| Criterion | Time | Evidence |
|---|---|---|
| Tech Implementation | 00:04–00:15; 00:40–00:57; 02:03–02:24 | A real tool reply; the merged label mapped to the three source cells; the real initialize → query → answer id → explain requests over `/mcp`. |
| Design | 00:29–00:40; 00:57–01:20; 01:37–01:49 | A four-word follow-up retrieves the latest answer's source; changing department changes both the total and the source; the breakdown stays short. |
| Potential Impact | 00:00–00:04; 00:15–00:29; 01:49–02:03; 02:24–02:40 | One specific job, checking a budget by audio, for a named audience. User testing is stated as not yet done. |
| Quality of the Idea | 00:29–00:57; 01:09–01:37; 02:40–02:50 | Provenance tied to the answer: the same question moves from C3–C5 to C6–C7 after a new total. |

This shows evidence for each criterion. It cannot show adoption or accessibility benefit; that
needs testing with blind and low-vision users, which has not happened. Do not add "proven
accessible", "works with any spreadsheet", "first", or a speed comparison.

---

## Before recording

From the repository root (Node 22.7 or later; this was checked on Node 23.11):

```bash
npm ci
node --test --experimental-strip-types test/demo.test.ts   # the five exchanges, word for word
npm run serve                                              # http://127.0.0.1:8787, this machine only
```

If `test/demo.test.ts` fails, the build no longer says what this script says. Fix the build or
the script before filming, never the footage.

`npm run serve` prints an "ExperimentalWarning: Type Stripping" line from Node. Keep the terminal
out of the shot. The server binds to this machine only and accepts `localhost` and `127.0.0.1`
as host names, so open `http://localhost:8787/`.

The page opens by connecting and asking "what do I have" on its own. The conversation panel
therefore starts with "Connected to landmark 0.1.0.", then that question, then a list of the
bundled files: "You have 01 flat, 02 stacked header, 03 merged header, FY2026 Departmental
Budget and 05 three regions. There is 1 more." Most are named after test fixtures; the budget
is named by its own title. Those turns and the preparation turn are above the filmed exchanges
in the panel. There is no button
that clears the panel; a reload clears it but also clears the open table.

## Recording checklist (Windows 11, one person)

**Equipment**

1. Wired headphones, so the recogniser does not hear the product's answer, and a headset or USB
   microphone.
2. Turn on Do Not Disturb. Close every other tab and app that makes sound, so the recording
   holds only the page's speech and yours.
3. OBS Studio (free). *Settings → Video*: base and output 1920×1080, 30 fps. *Settings →
   Output*: Advanced mode, recording tracks 1, 2 and 3. *Edit → Advanced Audio Properties*:
   Desktop Audio on track 2, microphone on track 3, so the product and your voice can be edited
   separately. Xbox Game Bar (Win+Alt+R) works as a backup, but it mixes the audio together.
   Edit in Clipchamp or DaVinci Resolve, and do not use their stock music.

**Browser**

4. Chrome or Edge, a fresh profile, no extensions. Both provide the speech recognition the
   page uses. In a browser without it, the page says so and asks for typed questions instead.
5. Open `http://localhost:8787/`. Allow the microphone once, before recording.
6. Zoom to 150% and press F11. On a 1920×1080 screen that lays the page out at 1280×720, the
   size at which it was checked on September 27: the page itself does not scroll, the
   conversation scrolls inside its panel, and the typed-question box stays at the bottom.
   Full screen keeps browser branding out of the frame.
7. Leave **Speak answers** ticked (it is on by default). Unticked, answers go to a screen reader
   instead of being spoken, which is the mode for screen-reader users, not for this video.
8. The page has no voice picker; it speaks with the browser's default English voice (language
   en-US, rate 1.0). In a check on September 27 on this Windows machine, Chromium's default was
   Microsoft David; each of the five replies spoke for 5.5–6.9 seconds and started 0.4–0.8
   seconds after the call, which fits the 7–8 second product slots. Use the same browser and
   voice in every take, and re-time the edit if either changes.
9. Browsers may refuse to speak before the page has had a click or key press. After the page
   loads, click once on an empty part of it; if the opening list was refused on load, the page
   says it then. Let it finish.

**Takes**

10. Reload the page before each master take. Do the preparation turn ("what's in the budget
    file"), wait for the reply to finish and the status to read **Ready**, then start.
11. For each line: press **Ask by voice** (or Space when no button or text field has focus),
    wait for the rising tone, speak, and stop. Listening ends by itself when you stop talking,
    with a falling tone. Wait for the reply to finish and the status to return to **Ready**,
    count two seconds, then ask the next line.
12. Read the **YOU** line on screen after every question. If the recognised words differ from
    the script, retake that exchange, even when the answer came out right: the words on screen
    and in the captions must be the words that were heard.
13. Record the five exchanges as one continuous master, with a few seconds before and after
    each. Use it for shots 01, 03, 05, 06 and 08, and its real transcript for the narrated shots.

**If the microphone fails: typed input, still live**

Type each question into the **Type a question** box and press **Ask**, or run the lines in the
browser console. Both go through exactly the same router and MCP calls as a spoken question;
only speech recognition is skipped. Run one line at a time and wait for the reply to finish
before the next:

```javascript
await landmark.ask('total amount for engineering');
// wait for the whole reply
await landmark.ask('how do you know');
// wait
await landmark.ask('total amount for design');
// wait
await landmark.ask('how do you know');
// wait
await landmark.ask('break it down');
```

Do not use `landmark.script([...])` for filming. It now waits for each reply to finish, but it
runs straight through: it will carry on after a wrong answer, and its quarter-second gap between
lines does not match the timeline. One line at a time lets you check each reply and control the
pauses.

From the first typed frame, show **Typed input · Live MCP response** on screen. If you read the
question aloud over it, that is narration of typed input, not recognition; do not present it as
recognised speech. Suggested video description in that case:

> Browser voice prototype using a local MCP server and a synthetic budget. Questions were
> entered as text through the same client router; answers came from live MCP calls. Source-cell
> highlights are editorial annotations. Speech recognition is not demonstrated in the typed
> segments. Testing with blind and low-vision users has not yet been done.

**Network proof (shot 10)**

Before reloading for the master take, open DevTools → Network and tick **Preserve log**. Then
take three 7-second crops from that same take, showing only request and response text:

1. 02:03–02:10: the `initialize` response with `"protocolVersion": "2025-11-25"`, and the
   `Mcp-Session-Id` header the server returns with it; then a later POST to `/mcp` carrying the
   `mcp-protocol-version: 2025-11-25` header. The first initialize request does not carry that
   header, and it should not.
2. 02:10–02:17: the `tools/call` for `table_query` (Department = Engineering, sum of Amount)
   and its result with `answer_id`.
3. 02:17–02:24: the `tools/call` for `table_explain` with the same `answer_id`, and its cells
   C3, C4, C5.

Answer ids look like `a1-` followed by 16 hex characters and change on every run; use the pair
from your own take. Crop out the DevTools interface and the value of the `x-landmark-session`
request header. That value is the key to this browser's saved places on the server; it is not
a password, but there is no reason to publish it.

**Source-cell graphic**

This is an **editorial reference graphic** you make from the fixture, labelled *Source-data
annotation · Synthetic budget* whenever it is on screen. The server does have an MCP Apps widget
on `table_explain` that draws the grid and highlights the counted cells, but only an MCP Apps
host renders it, and the browser page in this video is not one. It has not been checked in a
real MCP Apps host. So the video does not show the widget, and the graphic must not be presented
as product output.

| Row | A: Department | B: Line item | C: Amount |
|---:|---|---|---:|
| 1 | FY2026 Departmental Budget (title) | | |
| 2 | Department | Line item | Amount |
| 3 | Engineering (merged A3:A5) | Salaries | 480000 |
| 4 | | Tooling | 62000 |
| 5 | | Travel | 18000 |
| 6 | Design (merged A6:A7) | Salaries | 210000 |
| 7 | | Software | 24000 |

Draw each department label once, across its merged span. Engineering is
480000 + 62000 + 18000 = 560000; Design is 210000 + 24000 = 234000. The fixture
(`test/fixtures/make.ts`) has no currency, so do not add a dollar sign. Make three frames: the
whole table, C3–C5 highlighted, C6–C7 highlighted.

**Narration and captions**

14. Assemble the picture first, then record the narration against it, in your own voice
    (Audacity, or OBS with only the microphone). Read the narration column exactly. Say "M C P"
    as letters. Narration stops completely whenever the product speaks.
15. Hold real frames under narration. Do not loop a listening or speaking animation to suggest
    activity that did not happen.
16. Write English captions for every audible line and upload them as an `.srt` file. Check the
    numbers and the cell names ("C three"); automatic captions tend to garble both.

**Export and upload**

17. Export 1080p, 30 fps, MP4. Confirm the duration is under 3:00 (2:50 is 5,100 frames) and
    that the first answer has finished before 0:15.
18. Watch it once listening without looking, and once muted with captions.
19. YouTube Studio: *No, it's not made for kids*; visibility **Public** (the rules say publicly
    visible; do not use Unlisted or Private); upload the `.srt`. Suggested title: *Landmark —
    Ask a budget, check the answer*.
20. Open the link in a private window, signed out, and confirm it plays. Then paste it into the
    Devpost submission.

## If something fails on the day

| Failure | Action | What to disclose |
|---|---|---|
| A question is misheard | Let the reply end, reload, do the preparation turn, and retake the whole exchange. | Never caption the intended words over a different recognised question. |
| Recognition keeps failing | Use the typed fallback above, one line at a time. | Show *Typed input · Live MCP response* from the first typed frame. This proves the tool conversation, not the microphone. |
| The product's speech fails | Retake, or use a genuine earlier take from the same build and data. | Never replace product audio with your own or another synthetic voice. |
| A reply is wrong or missing | Stop. Run `node --test --experimental-strip-types test/demo.test.ts`, fix the cause, then record the fixed build. | No canned JSON, no reply spliced in from another take. |
| A take overruns its slot | Retake at the planned pace, or trim holds in the edit. | Never speed up speech or cut the product's words. The export stays under 3:00. |

**Local or hosted.** This plan records against the local server, and the on-screen label and
the shot 02 narration say so. If you record against a deployed Worker instead, change "local"
to "hosted" in both places (the word count does not change), and first check that the
deployment's `/health` reports `"state": "durable"`. The Worker has been run only under
`wrangler dev` on this machine; nothing has been deployed yet.

## Rights and trademarks

- Only original footage of this project: the page, its network log, the terminal if you use it,
  and the graphic above. No Excel, NVDA, Windows or Chrome logos or interfaces; F11 and cropping
  keep browser branding out. No stock footage, no borrowed screen-reader recordings, and no
  imitation of a well-known assistant's voice.
- No music at all.
- The budget is synthetic data written by `test/fixtures/make.ts` in this MIT-licensed
  repository, so it needs no attribution.
- Keep the countries table out of the video. Unlike the budget, its figures appear to come
  from published population statistics, and the video does not need them.
