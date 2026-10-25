# Task for the fcc-mode Claude Code session (Lucid Reader, ~/pdf-reader)

No mannered prose. Answer first, short sentences, numbers and names, end on the result.

Read HANDOFF.md, CONTRACT.md and README.md first. This is a Chrome MV3 extension (no build step, ES modules). Back up first:
`cp -R ~/pdf-reader ~/code-backups/pdf-reader-$(date +%m%d-%H%M)`.

Owner's requests (Oct 18, 4:55 PM), all required:

1. Flow mode (reader/lib/flow.js, mode 4): the reading band AND the current line must stay perfectly still on screen while the text scrolls up through them. Today the line drifts and the motion lags. Make the default `flowGuide: 'band'` lock the current line's centre exactly to the band centre (no easing lag by default: `flowGlide` default 1), scrolling continuously at the pacer's rate (interpolate within each word's time slot, which flow.js already computes). Keep the other guide options. Verify by playing Flow at 250 wpm and checking, via JS each 200 ms for 5 s, that the current line's top relative to the viewport changes by under 2 px.
2. First sentence of each paragraph is bold by default (`firstSentence: 'bold'` in reader/lib/schema.js, wrappers `.sn.fs` in reader/lib/markup.js, CSS in reader/reader.css). Verify it actually renders bold on a real PDF (getComputedStyle on a `.sn.fs` element: fontWeight >= 600). Fix whatever stops it.
3. Remove the labels in the page corners: the "p 1" PDF page markers (`.pagemark::after` in reader.css) and any leftover running headers/footers (book title, chapter title, page numbers repeated at page tops/bottoms) that extraction lets through. Default `showPdfPageMarks` to false and drop the corner label entirely; strengthen `findRunningHeads` in reader/lib/extract.js (match repeated lines on 2+ pages within the outer 12% when text is short, ignoring digits). Add a unit test.
4. Settings must be clearer: every label plain and specific, every non-obvious control gets a one-line hint saying what it does, sections ordered: Typography, Colors & contrast, Skim, Flow (mode 4), Read-along (mode 2), Auto-scroll (mode 3), RSVP (mode 5), Speed, Pauses, Contents panel, Pages, Headings & links, Bionic, Stripes, Focus & dim, Side rails, Behavior. The panel is generated from reader/lib/schema.js SECTIONS + SETTINGS.
5. Pages and cutoffs: in paginated mode (reader/reader.js computePageBreaks/goToPage) pages cut lines in half and leave odd partial text at the bottom. Break only between whole lines (prefer between paragraphs when within the last 3 lines), never show a partial line at the bottom (clip the scroller to the page height), keep figures whole on one page, and add a page number + "next page" affordance. Also check the Original PDF view sizing.
6. Remaining items from HANDOFF.md (render speed with content-visibility on blocks, panel preview styles, version bump to 1.2.0, ./package.sh).

Testing: `node --test test/*.test.mjs` must pass. For browser checks serve with `python3 /tmp/nocache.py` (port 8766, no-store) and open http://127.0.0.1:8766/reader/reader.html?file=http://127.0.0.1:8766/.devtools/sample.pdf (copy a PDF there, e.g. ~/Efficiency_Loop_All_Ideas_Scored.pdf). Use headless Chromium via Playwright if available (`npx playwright` or python playwright) for the measurements above.

When done, overwrite HANDOFF.md with: what changed, measured results (numbers), anything not done. Then print DONE.
