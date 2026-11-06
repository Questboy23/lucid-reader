# Task 2 for the fcc-mode session (Lucid Reader, ~/pdf-reader). Owner request Oct 18, 6:27 PM.

No mannered prose. Answer first, short sentences, numbers and names, end on the result.
Do FCC_TASK.md first if HANDOFF.md says any of it is unfinished. Back up before starting:
`cp -R ~/pdf-reader ~/code-backups/pdf-reader-t2-$(date +%m%d-%H%M)`.
Also search the web yourself (WebFetch/WebSearch if available) for more reading-speed and comprehension techniques, and add any good ones beyond this list.

## A. Settings menu: clean structure
Order in the panel, built from SECTIONS in reader/lib/schema.js (add a `group` field and render group headers in reader/panel.js):
1. Group "Applies to every mode": Typography; Page & layout; Colors & contrast; Highlights & skimming; Speed & time left; Comprehension aids.
2. Group "Modes" (one section per mode, only that mode's settings): Normal, Read-along, Auto-scroll, Flow, RSVP, Cascade (new), Listen (new).
3. Group "Other": Contents panel, Figures & links, Behavior.
Every setting gets: a plain label, a one-line hint, and a "More" toggle that expands a longer explanation (what it does, why it helps, how strong the evidence is: strong / some / weak). Store the long text as `more:` in schema.js.
Settings must apply instantly: CSS-only settings must not re-render (target under 50 ms, measure with performance.now around applySettings). Re-render settings must keep the reading position and finish in under 1 s on a 500-page book; use redecorate() where possible.

## B. Reading-speed and comprehension features (each toggleable, default off unless noted)
1. Line color gradient (BeeLine style): text colour shifts gradually along each line and flips direction per line so the eye finds the next line. Colors and strength adjustable. Evidence: some.
2. Cascade mode (new mode 7, Live Ink style "cascaded text"): each sentence laid out as short phrase lines, indented by phrase depth (indent after prepositions/conjunctions, reset at clauses). Uses phraseEnds() from markup.js. Evidence: some (comprehension gains in school studies).
3. One sentence per line (semantic line breaks) option.
4. Columns: 1, 2 or 3 columns with gap and optional rule; in paginated mode 2-column = two-page book spread.
5. Book look preset and its parts: justified with hyphenation, first-line indent with no paragraph gap, drop cap at chapter starts, small caps for the first line of a chapter, old-style numerals, ligatures and kerning, hanging punctuation, widows/orphans control (2 lines) in paginated mode, paper tint background option.
6. Chapters that look like chapters: detect chapters (h1, "Chapter N", "Part N", numbered top headings), start each on a new page in paginated mode, chapter opener = small "CHAPTER" label + number + title, generous space, optional ornament rule. Section headings get clear hierarchy (size scale, spacing above > below, optional numbering). No corner labels or running headers by default.
7. Typography controls: font, size, weight, line height, letter spacing, word spacing, paragraph spacing, text width in characters with an "ideal 60-70 characters" preset, side margins, alignment, hyphenation on/off, font-variant options (small caps, numerals), optical sizing, text thickening, text shadow off/on.
8. Key terms: compute document-specific key terms offline (TF-IDF over chapters, stopword list), highlight the top N per chapter (N adjustable), list them in the Contents panel per chapter.
9. Fixation points (saccade guides): faint marks every N characters to train fewer, longer fixations. Spacing adjustable. Evidence: weak.
10. Alternating phrase tint: every other phrase chunk gets a faint tint. Evidence: weak.
11. Reading window / mask: show only N lines around the current line, rest masked (dim exists; add a hard mask variant).
12. Smart pacing for paced modes: speed ramp-up over the first 30-90 s (adjustable), slow down on long or rare words (ship a small English frequency list, top 10,000 words, inside the extension), slow at headings and new paragraphs. Evidence: some.
13. Listen mode (new mode 8): read aloud with the Web Speech API, highlighting the current word; only offer voices where `localService === true` so no audio or text leaves the machine; speed, voice and pitch controls. Evidence: some (reading while listening helps comprehension).
14. Comprehension aids: end-of-chapter recap (the first sentence of each paragraph of the chapter, shown in a card when the chapter ends, can be turned off); "where was I" recap when reopening (last 3 first-sentences before the saved position); time left in chapter in the status bar.
15. First topic sentence bold stays the default.

## C. Flow: new "line jump" scroll style
Add `flowScroll: 'jump'`: the guide band and the current line stay still while the line is read; when the line finishes, the text moves up one line in a quick animation (duration adjustable 0-400 ms, default 120 ms, ease-out). Keep 'continuous' and 'line' too. Verify with Playwright: during a line the line's viewport top changes under 1 px; at the line change it moves exactly one line height within the set duration +- 30 ms.

## D. Checks before DONE
- node --test test/*.test.mjs passes; add tests for TF-IDF, cascade phrase layout, frequency-based pacing, link href filtering.
- Playwright: open 3 PDFs (a book from ~/Calibre Library, ~/Efficiency_Loop_All_Ideas_Scored.pdf, ~/tax-f8886/i8886.pdf); zero console errors; screenshot each new feature into ~/pdf-reader/.devtools/shots/ and look at every screenshot.
- Security: no network requests except the PDF and extension files; Listen mode uses local voices only; no eval or remote scripts; manifest permissions unchanged.
- Bump manifest version to 1.3.0, run ./package.sh.
Overwrite HANDOFF.md with what changed, measured numbers, anything not done. Then print DONE.
