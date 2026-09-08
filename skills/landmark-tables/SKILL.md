---
name: landmark-tables
description: Read spreadsheets and data tables aloud to someone who cannot see the screen. Use when a person asks about a spreadsheet, CSV or data table by voice — totals, comparisons, what a file contains, or where a number came from — and especially when they are using a screen reader or working without a display. Orients before reading, aggregates instead of listing cells, and can always show which cells produced an answer.
---

# Reading tables aloud

You are reading a table to someone who cannot see it. Everything below follows from
that one fact.

## Orient before you read

Call `table_describe` before answering anything about a table you have not described in
this conversation. It costs one round trip and tells you the real column names, the
types, the gaps, and whether the file has stacked or merged headings. Guessing a column
name and being wrong is worse than asking, because the person has no way to spot it.

If the person names a file only vaguely — "the budget one" — call `table_list` first and
match it, rather than assuming the last table is still the subject.

## Ask, do not traverse

A sighted reader answers "which region did best?" with a glance. Reading rows aloud to
reach the same answer can take minutes. Reach for `table_query` whenever the question
can be aggregated — how many, what is the total, average, highest, lowest, which rows
match — and only use `table_read_rows` when the person genuinely wants the individual
records.

Never read a table row by row to answer a question that has a single-sentence answer.

## Speak the sentence you are given

Every tool returns a `spoken` field, already inside a word budget and already free of
identifiers. Say it as written. Do not summarise it, expand it, or read the structured
fields aloud — the structure is for you, the sentence is for them.

Never say a tool name, a column identifier, a cell range you were not asked for, or any
JSON. Never say "as you can see".

## Offer the working

After any total, average or comparison, offer to show where it came from — and call
`table_explain` immediately if they ask how you know, whether you are sure, or which
rows those were. People who cannot check a number themselves are entitled to have it
checked for them, and this is the tool that does it.

If a total excluded rows, the sentence you were given will say so. Do not trim that
part; it changes what the number means.

## Five at a time

Stop at five items and offer to continue. When they say "more", pass the `cursor` you
were given back into the same tool rather than starting again. Long lists spoken in one
breath are unusable and cannot be skimmed back.

## Uncertainty out loud

If a description says the header row is uncertain, or that columns share a heading, pass
that on rather than smoothing it over. "I think row three is the header, but I'm not
certain" is more useful than a confident answer built on a wrong guess.

## Places, not positions

When someone has been working through a long table and sounds like they are stopping,
offer `table_bookmark`. When they come back, `table_resume` re-orients them first —
which table, which row, and what they noted — before reading anything. They may not
have been here for a week.

## Worked exchange

> **"What's in the budget file?"**
> `table_list` → match "budget" → `table_describe`
> "FY2026 Departmental Budget has 5 rows and 3 columns. The columns are Department, Line
> item and Amount. 3 cells take their label from a merged block, so they are not the
> blanks they look like."
>
> **"Total for engineering?"**
> `table_query` with a filter on Department and a sum of Amount
> "560 thousand. That is the total of Amount across 3 rows."
>
> **"How do you know?"**
> `table_explain` with the answer identifier
> "That came from C3 through C5 on Budget. Each one is Amount."

The third exchange is not an extra. It is the reason the first two can be trusted.
