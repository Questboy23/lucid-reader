# Lucid Reader — module contract

A Chrome MV3 extension that reflows PDFs into a real reading view. Read this
before touching anything; it is the interface every module is written against.

Already written (do **not** modify these files):

| file | role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `background.js` | PDF takeover via dynamic declarativeNetRequest rules |
| `reader/reader.html` | full DOM skeleton — every id you need already exists |
| `reader/reader.css` | shell + typography contract + CSS custom properties |
| `reader/lib/schema.js` | **single source of truth** for all settings |
| `reader/lib/settings.js` | load/save/reset/subscribe + `applyCssVars` |
| `reader/lib/markup.js` | word spans, bionic/first-letter decoration, word index |
| `reader/reader.js` | orchestrator (owned by the integrator) |

## Hard rules

1. **ES modules only**, no build step, no bundler, no npm imports. Import with
   relative paths (`./lib/foo.js`). No CDN URLs anywhere — MV3's CSP blocks
   remote script and the extension must work offline.
2. **No inline event handler attributes** and no `eval`/`new Function`. MV3 CSP.
3. **Never change text metrics to show transient state.** Highlighting a word
   may only touch colour, background, box-shadow, opacity, text-decoration and
   outline. Changing font-weight, font-size, letter-spacing, padding, margin or
   `display` on a live word reflows the line and makes the text visibly jump —
   this is the single most important UX rule in the project.
4. Read settings through the object passed to you; never reach into
   `chrome.storage` yourself.
5. Every user-adjustable value must already exist in `schema.js`. If you need
   one that isn't there, say so in your report rather than inventing a key.
6. Degrade quietly. A failure in a reading aid must never break the text view.
7. Keep to the house style of the existing files: comments explain *why*, not
   *what*; no decorative banners beyond the ones already used.

## Shared types

```js
// The document model produced by extract.js
Doc = {
  title: string,          // best-effort title (metadata, else first heading, else filename)
  numPages: number,
  blocks: Block[],
  truncated: boolean,     // true if extraction stopped early at a page cap
}

Block =
  | { type: 'h1'|'h2'|'h3', text: string, page: number }
  | { type: 'p'|'quote'|'pre', text: string, page: number }
  | { type: 'li', text: string, page: number, marker: string }   // marker e.g. "•", "3."
  | { type: 'pagebreak', page: number }                          // page N ended here

// The word index produced by markup.js (read-only for everyone else)
WordIndex = {
  count: number,
  spans: HTMLSpanElement[],   // spans[i] is word i, always display:inline
  text: string[],             // text[i] is the raw word including punctuation
  blockOf: Int32Array,
  pageOf: Int32Array,
  flags: Uint8Array,          // bitmask, see FLAG
  blockEls: HTMLElement[],
  FLAG: { CLAUSE:1, SENTENCE:2, PARA:4, HEADING:8, LONG:16 },
}
```

`Settings` is always a plain object with every key in `schema.js` present and
already validated — treat values as trustworthy and in range.

## Modules to build

### A. `reader/lib/extract.js`

```js
export async function extractDocument(pdf, opts) -> Doc
// pdf  : a pdf.js PDFDocumentProxy
// opts : { onProgress?(done, total), maxPages?: number, fallbackTitle?: string, signal?: AbortSignal }
```

This is the module that decides whether the reader feels good or useless, and
it is worth real effort. From each page's `getTextContent()` items you must:

- group items into lines using their transform matrices (y with a tolerance
  derived from glyph height, then sort by x);
- detect multi-column layouts and read columns in order, not interleaved —
  a two-column paper read row-by-row is unusable;
- join lines into paragraphs: break on a vertical gap meaningfully larger than
  the median line gap, on a first-line indent, or on a short line that ends a
  sentence;
- de-hyphenate words split across lines (`"inter-" + "esting"` → `"interesting"`)
  but keep genuine hyphens (`"well-being"`, and a line ending in `-` followed by
  a capitalised word or a digit);
- drop running headers/footers and page numbers: text that repeats at roughly
  the same y on three or more pages, or a line that is just a number/roman
  numeral near the top or bottom margin;
- classify headings from the font-size histogram (body size = the most common
  size weighted by character count) plus boldness and line length;
- detect list items and emit `li` with the marker split off the text;
- emit a `pagebreak` block between pages;
- treat a page with almost no extractable text as a scanned page.

If the whole document yields essentially no text (scanned PDF), return a Doc
whose `blocks` is empty — the caller shows a "no text layer" message and offers
the original-PDF view. Do not attempt OCR.

Also export, for the caller's diagnostics:
```js
export function extractionStats() -> { pagesWithText, pagesEmpty, droppedRunningHeads, columnsSeen }
```

`test/extract.test.mjs` should exercise the pure helpers you split out
(line grouping, de-hyphenation, running-head detection, heading
classification) with plain node — no browser. Run it with
`node --test test/`. Keep the pure logic in exported functions so it is
testable without pdf.js.

### B. `reader/panel.js` + `reader/panel.css`

```js
export function createPanel(opts) -> {
  open(), close(), toggle(), isOpen(),
  refresh(),                  // re-read settings (e.g. changed in another tab)
  destroy(),
}
// opts = {
//   root: HTMLElement,           // #panel, already in the DOM, starts [hidden]
//   scrim: HTMLElement,          // #panel-scrim
//   getSettings(): Settings,     // committed settings
//   onApply(patch): Promise,     // commit a patch (integrator persists it)
//   onPreview(draft): void,      // called on every draft change (live preview mode)
//   onReset(keys?): Promise,     // reset all, or one section's keys
// }
```

Build the whole panel from `SECTIONS` + `SETTINGS` in `schema.js`. Nothing in
this file may hard-code a setting's label, range or default.

Required behaviour, matching the reference screenshots:

- Header: "Reading settings" / subtitle "Changes preview here — click Apply to
  update the reader.", a **Reset** button and a close ✕.
- Collapsible sections with an icon, title and chevron; collapsed state is
  remembered in `localStorage` (not in settings).
- Every control is a row: label (with unit in parentheses) and the control.
  `range` renders as a slider **plus a number box** that are two-way bound, as
  in the screenshots. `color` renders as a swatch + hex text field; a nullable
  colour also gets an "inherit" button that clears it.
- A setting whose `showIf` is false is hidden with a short fade, so turning
  "Enable bionic" on reveals its parameters. Sections whose settings are all
  `showIf`-hidden still show their master toggle.
- `strong: true` settings render with a heavier label (they are the master
  switch of their group).
- **Preview-then-apply.** Edits go into a draft. The footer shows
  "No pending changes" or "N pending changes", plus **Discard** and
  **Apply changes**. The document only changes on Apply — *unless*
  `settings.livePreview` is on, in which case every edit calls `onApply`
  immediately and the footer stays in the "no pending changes" state.
- A live **preview sample** near the top of the panel: two or three sentences
  rendered with the draft's typography, colours, bionic and first-letter
  settings, so the user sees the effect without the document reflowing under
  them. Apply the draft to it with `applyCssVars(previewEl, draft)` from
  `settings.js`, and use `markup.js`'s exported helpers for the bionic split so
  the preview cannot disagree with the real render.
- Colour presets (`PRESETS` from schema.js) as a grid of swatch buttons in the
  Colors section, each previewing its own colours; the active one is marked.
- A per-section reset ("Reset section") in each section header, calling
  `onReset(SECTION_KEYS[id])`.
- Keyboard: Escape closes, the panel traps focus while open, controls are
  reachable by Tab, and sliders respond to arrow keys (native behaviour is
  fine — just don't break it).
- The panel is a fixed-width (360px) right-hand drawer, scrollable, with the
  footer pinned to the bottom. It must not cover the text column on wide
  screens: set `#app` class `panel-open` and let the integrator's CSS shift the
  stage — you only own `#panel` and `#panel-scrim`.
- Accessibility: `role="dialog"`, `aria-modal="true"`, labelled controls
  (`<label for>` or `aria-label`), `aria-valuetext` on sliders where the raw
  number is not self-explanatory.

`panel.css` owns only `#panel`, `#panel-scrim` and their descendants. Use the
existing `--ui-*` custom properties so the panel follows the page colours.

### C. `reader/lib/overlay.js` + `reader/lib/overlay.css`

Line-based reading aids, drawn as absolutely-positioned elements in `#overlay`
so no text is ever touched.

```js
export function createOverlay(opts) -> {
  measure(),                      // rebuild the line map (after render/resize/setting change)
  update(state),                  // repaint; cheap, called on scroll and on every pacer step
  lineOfWord(i) -> number,
  lineRect(n) -> {top,bottom,left,right,height},
  lineCount() -> number,
  wordRangeOfLine(n) -> [firstWord, lastWord],
  destroy(),
}
// opts  = { host: HTMLElement /* #overlay */, doc: HTMLElement /* #doc */,
//           index: WordIndex, getSettings(): Settings }
// state = { mode, wordIndex, playing, scrollTop, viewportHeight }
```

- The line map is built by walking the word spans and grouping them by the top
  of their client rects (use `Range.getClientRects()` on a span that wraps, and
  bucket with a tolerance of about a third of the line box). Store rects in
  `#doc`-relative coordinates so scrolling doesn't require re-measuring.
- Measuring 100k spans must not lock the page: measure in chunks and expose
  progress via the optional `onProgress` callback, or measure lazily per block
  and fill in as needed — your call, but a 400-page document must stay
  responsive.
- **Stripes**: tint every Nth line (`stripeEvery`), optionally alternating
  `stripeColor`/`stripeColor2`, at `stripeOpacity`. Stripes are static: they
  depend only on line number, not on the pacer.
- **Dim mode**: everything except a window of `dimLines` lines around the
  current line is covered by a `var(--r-bg)` veil at `dimStrength`. In Normal
  mode there is no pacer word, so follow the mouse/caret: use the line nearest
  the vertical centre of the viewport. Use two blocks (above/below), not a
  per-line mask, so it stays smooth.
- **Descending bar**: a `barHeight`-tall band at `barColor`/`barOpacity` that
  tracks the current line; it should ease to its new position (respect
  `reduceMotion`).
- Only paint what's visible: elements outside the scroll viewport (plus a
  small margin) should not exist in the DOM.
- Repaints must be idempotent and must not thrash layout — read all geometry
  first, then write. `update()` may be called 60 times a second.

`overlay.css` owns `#overlay` and its children only.

### D. `reader/lib/pacer.js`, `reader/lib/readalong.js`, `reader/lib/autoscroll.js`

```js
// pacer.js — pure timing engine, no DOM.
export class Pacer {
  constructor({ index, getSettings, onWord, onStateChange })
  play(); pause(); toggle(); stop();
  seek(wordIndex); step(delta);      // delta in words, may be negative
  stepLine(delta, overlay);          // move by whole lines
  get index(); get playing(); get done();
  durationFor(i) -> number;          // ms this word is held, incl. multipliers
  remainingMs(from?) -> number;      // for the status bar's "12 min left"
}
```
- Base delay is `60000 / wpm`, multiplied by `pauseComma` (FLAG.CLAUSE),
  `pausePeriod` (SENTENCE), `pauseParagraph` (PARA), `pauseHeading` (HEADING)
  and `pauseLongWord` when the word's letter count ≥ `longWordLen`. When
  several apply, use the largest rather than the product.
- Schedule from timestamps with `requestAnimationFrame`, not a chain of
  `setTimeout`s, and tolerate a throttled/backgrounded tab: on a long frame gap
  do **not** fast-forward through hundreds of words — clamp the catch-up and
  keep going from the current word. A wpm change while playing takes effect on
  the next word without restarting the run.
- Words with no letters or digits (stray glyphs) are skipped, not shown.

```js
// readalong.js
export function createReadAlong({ index, doc, scroller, overlay, getSettings }) -> {
  setWord(i), clear(), destroy()
}
```
- Marks word `i` with class `cur` (and clears the previous one) — one class
  change per step, nothing else.
- When `pacerFollow` is on, keeps the current word at `pacerAnchor`% of the
  viewport height, scrolling only when the word has drifted out of a comfortable
  band, so the page doesn't crawl on every word. Smooth unless `reduceMotion`.
- Clicking a word must be able to move the pacer there — expose that by
  accepting an `onSeek` callback and wiring a delegated click listener on `doc`
  (ignore clicks that are part of a text selection).

```js
// autoscroll.js
export function createAutoScroll({ scroller, index, overlay, getSettings }) -> {
  start(), stop(), running(), setFromWord(i), currentWord() -> number, destroy()
}
```
- Continuous pixel scrolling whose speed is derived from wpm and the measured
  average words-per-line: `px/s = (wpm / 60) * lineHeightPx / wordsPerLine`.
  Recompute when settings or layout change.
- Sub-pixel accumulation so slow speeds still move smoothly; pause when the
  user scrolls manually (and resume only on an explicit play).
- Stops at the end of the document and reports it via the pacer's state.

### E. `reader/lib/rsvp.js` + `reader/lib/rsvp.css`

```js
export function createRsvp({ host /* #rsvp */, index, getSettings }) -> {
  show(), hide(), setWord(i), destroy()
}
```
- One word (or `rsvpChunk` words) at a time in a large fixed box.
- **ORP**: the optimal recognition point letter is highlighted in `rsvpOrpColor`
  and the word is positioned so that letter sits at a fixed x for every word —
  that alignment is the whole point of RSVP and it must not wobble. Use the
  standard pivot by word length (1 → 0, 2–5 → 1, 6–9 → 2, 10–13 → 3, else 4)
  and lay the word out as three inline pieces in a grid so the pivot column is
  fixed. Measure with the actual rendered font.
- `rsvpGuides`: short vertical ticks above and below the pivot column.
- `rsvpContext`: the previous and next words faded above and below.
- `rsvpProgress`: a thin progress bar in the box.
- The box uses `--r-rsvp-*` and `--r-orp*` custom properties.
- Long words must not overflow the box: shrink to fit rather than clip, and keep
  the pivot aligned while doing so.

`rsvp.css` owns `#rsvp` and its children only.

## Checking your work

- The extension must load with zero console errors and zero CSP violations.
- `node --check <file>` on every JS file you write.
- State clearly in your report: what you built, anything you could not do, and
  anything you think the contract gets wrong.
