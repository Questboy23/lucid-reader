# Lucid Reader handoff (2026-10-18, 10:07 AM EDT)

Backup before this round: ~/code-backups/pdf-reader-2026-10-18-pre-v12

## Done in this round (code compiles, 65/65 tests pass)
- First/last sentence styles: off, bold (first sentence defaults to bold), highlight, bold+highlight, colored, underline. Sentences and key-word runs are inline wrappers (`.sn.fs`, `.sn.ls`, `.kr.num`, `.kr.nm`) so highlights cover the spaces. Highlighter shape: full, marker, band. CSS vars come from `derivedVars()` in schema.js.
- Settings regrouped by mode: Speed, Read-along (2), Auto-scroll (3), Descending bar (2 & 3), Flow (4), RSVP (5), Pauses. 140 settings total.
- New controls: text contrast (pushes fg toward black/white), thicken letters, selection color, heading size/weight/color/spacing, link underline, J/K step.
- Flow rewritten (reader/lib/flow.js): fixed band where text rises through it (default), or line-following guide; band height, look (fill, rules, outline), width (text column or page); continuous or line-by-line scrolling; glide smoothness; phrase/word highlight drawn as boxes (no restyling while playing); sweep (underline, fill, caret) with thickness; separate smoothstep gradient fades above and below with clear zone and fade length.
- Speed: text shows first, figures are captured in the background and swapped in at the next pause (keeps page + position). Extracted docs cache in IndexedDB keyed by PDF fingerprint (reader/lib/cache.js), so reopening skips extraction. Figure detection renders a small page first and re-renders sharply only pages with figures.
- Fixed: block index bug in chunked render (outline heading levels were wrong after 400 blocks); render stalled in hidden tabs; Contents panel updated on every word (now every 250 ms); relayout runs once per slider burst.

## Measured
- 533-page book (190k words): text extraction 3.4 s, render 5.5 s in the browser.

## Remaining
1. Verify in Chrome: load unpacked, reload, open a book, check Flow band/fades, first-sentence bold, highlight across spaces, Contents panel, search. Dev server: `python3 /tmp/nocache.py` serves on 127.0.0.1:8766 (no-store; the browser pane caches 8765 hard).
2. Render 5.5 s for 190k words is the slowest step. Next speedup: render only blocks near the viewport first (or `content-visibility: auto` on blocks) and fill the rest in idle time.
3. "Overlapping lines" report not reproduced yet. Check a book at lineHeight under 1.3 and the heading line-height (now 1.3).
4. Panel preview sample uses `renderInto` but CSS rules target `#doc`; the preview does not show the new sentence/keyword styles.
5. Bump `version` in manifest.json to 1.2.0, run `./package.sh`.
