# Demo video — shot list and narration

**Hard limit: 3:00.** The rules say judges are not required to watch past it, so nothing
load-bearing goes after 2:30. Public YouTube, English, no third-party music or footage.

**Narration budget: 150 words per minute.** That is a comfortable rate for a clear
non-native speaker, and the word counts below are checked against it. Read slower than
feels natural — every recording is faster than it sounded while filming.

**The one rule for the whole video:** never say "as you can see". The product is for
people who cannot. If a sentence only works because the viewer is looking at the screen,
rewrite it.

---

## Beat sheet

| Time | On screen | Narration | Criterion shown |
|---|---|---|---|
| 0:00–0:12 | Excel open, a budget sheet. Screen reader audible, reading `A4… blank… B4… Tooling… C4… 62000` | *"This is a budget in Excel, read by a screen reader. Row four says its department is blank. It isn't — it's Engineering, three rows up, in a merged cell."* (38 w) | Potential Impact |
| 0:12–0:30 | Cut to the Landmark client. Ring idle. Presenter turns away from the monitor. | *"Landmark is an MCP server that lets you ask the sheet instead of walking it. Same file. No screen."* (20 w) | Design |
| 0:30–0:48 | Ring goes blue. Spoken: "what's in the budget file". Answer plays. Latency pill reads under 20 ms. | *"It orients you first — size, columns, and the thing the file hides."* (13 w) | Tech Implementation |
| 0:48–1:05 | Spoken: "total for engineering". Answer: *"560 thousand. That is the total of Amount across 3 rows."* | *"Three rows. Two of them are blank in the file. It resolved the merge to find them."* (17 w) | Tech Implementation |
| 1:05–1:30 | **The beat that matters.** Spoken: "how do you know". Answer: *"That came from C3 through C5 on Budget. Each one is Amount."* | *"Research on blind spreadsheet users found they never fully trust a number they can't verify. Over audio there's no cell to glance at — so every answer carries the cells it came from, and reads them back."* (41 w) | Quality of the Idea |
| 1:30–1:50 | Switch to the merged-header file. Describe it. Four columns all labelled "Revenue" come back as `2026, Q1, Revenue` … | *"Four columns here are all called Revenue. The server rebuilds the full heading path, so each one can be named and asked for."* (23 w) | Tech Implementation |
| 1:50–2:05 | Spoken: "compare 2026 Q1 revenue and 2025 Q1 revenue". One sentence with the difference and direction. | *"Cross-column questions come back as one sentence, so nobody holds two numbers in their head and subtracts."* (18 w) | Design |
| 2:05–2:20 | Spoken: "save my place". Reload the page. Spoken: "carry on". It re-orients. | *"A long table is a job you come back to. Bookmarks survive the session and re-orient before reading."* (18 w) | Quality of the Idea |
| 2:20–2:40 | Split: DevTools network tab showing the POST to `/mcp` and the `2025-11-25` handshake, beside the terminal running the test suite green. | *"Every answer in this video was a live MCP call over Streamable HTTP, spec 2025-11-25. Sixty tests, and the arithmetic happens in the server — never in a language model."* (30 w) | Tech Implementation |
| 2:40–2:55 | Back to the idle ring. | *"Landmark. Open source, MIT. Built for people who need the answer, not the grid."* (14 w) | — |

**Total narration: ~232 words ≈ 1:33 spoken**, leaving roughly half the runtime for the
product's own voice and the pauses between turns. Do not fill that space.

---

## Capture checklist

Record in this order. Each is a separate take; assemble afterwards.

1. **The Excel + screen reader opener.** Hardest to get and sets up everything. NVDA is
   free. Capture system audio. Get a clean read of a merged-cell row announcing blank.
2. **Screen-off segment.** Film at least 30 seconds with the monitor dark or the
   presenter's face turned away, doing a real exchange. Amazon's accessibility guidance
   asks for "voice only, without touching the screen" — show it literally rather than
   claiming it.
3. **The five voice exchanges.** One take each, in order. Let the answer finish. Silence
   after an answer reads as confidence.
4. **The provenance beat** (1:05). Re-record until it is clean. It is the single
   strongest thing in the video.
5. **DevTools network panel** showing the POST to `/mcp`, `mcp-protocol-version:
   2025-11-25`, and the response time.
6. **Terminal**: `npm test` running to 60 passing.
7. **Narration**, last, against the assembled picture.

---

## If the live voice fails on camera

It will, at least once. Do not fight it on the day.

```js
// In the browser console. Drives exactly the path a spoken utterance takes.
await landmark.script([
  "what's in the budget file",
  'total for engineering',
  'how do you know',
])
```

Record the client's synthesised speech and the on-screen turns from that, and speak the
questions yourself over the top. The answers are still genuinely produced by live MCP
calls; only the microphone is bypassed. Say so in the submission text — a demo that
quietly fakes its input is worse than one that explains its capture method.

---

## Things not to do

- **No title card.** The first frame is a problem being demonstrated. Judges watch
  dozens of these and the opening 15 seconds decide whether they lean in.
- **No architecture diagram before 2:20.** Show it working, then show why it works.
- **No "revolutionary", "seamless", "leverages", "empowers".** State what it does.
- **Do not claim it is faster than a screen reader.** Experienced users listen at rates
  synthesised speech in this demo will not match, and an expert judge will know. The
  claim is situational: screenless, hands-free, and for questions whose answers need
  aggregating across hundreds of cells, where traversal genuinely is the wrong tool.
- **Do not say "first".** Say what was checked: the MCP registry's accessibility servers
  are all developer-facing auditing tools. That is reproducible; "first" is not.
