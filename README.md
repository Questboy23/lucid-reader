# Lucid Reader

A Chrome extension that turns a PDF into something you can actually read: your
font, your spacing, your colours, and four ways of moving through the text.

PDFs are laid out for paper. Chrome's viewer shows you the paper. Lucid Reader
pulls the text out, rebuilds it as a proper reading column, and leaves the
original a keystroke away.

## Install (unpacked)

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose this folder.
3. Optional but recommended: click **Details** on Lucid Reader and turn on
   **Allow access to file URLs**, so PDFs on your own machine open too.

Open any PDF. It lands in the reader. Press <kbd>S</kbd> for settings.

## The five modes

| Mode | What it does |
| --- | --- |
| **Normal** | Just the reflowed text. Scroll it yourself. |
| **Read-along** | A pacer highlights each word at your wpm, scrolling to keep it in place. |
| **Auto-scroll** | The page scrolls continuously at your reading speed, no highlight. |
| **RSVP** | One word at a time in a fixed box, aligned on its optimal recognition point. |
| **Original PDF** | The untouched pages, rendered by PDF.js. |

Nothing is destructive: the original PDF is always one click (or <kbd>5</kbd>)
away, and <kbd>Alt</kbd>+<kbd>R</kbd> hands the tab back to Chrome's viewer.

## What you can adjust

Everything below lives in the in-reader settings panel (<kbd>S</kbd>), previews
before it applies, and resets per-section or all at once.

- **Typography** — 36 fonts (23 bundled, including Atkinson Hyperlegible,
  OpenDyslexic and Lexend), zoom, size, line height, letter/word/paragraph
  spacing, column width, weight, alignment, hyphenation, indents.
- **Colours** — ten presets plus free background/text colours and page padding.
- **Bionic reading** — bold-prefix percentage, minimum word length, remainder
  opacity, bold weight and colour.
- **Line stripes** — tint every Nth line, one or two alternating colours.
- **Focus & dim** — dim everything but the lines you're on; first-letter
  emphasis per word, sentence or paragraph.
- **Pacer** — wpm, highlight colour and style, follow-scrolling and its anchor,
  and a descending bar that tracks your line.
- **Pages** — paginated (no-scroll) reading, words per page, PDF page marks.
- **Side rails** — guide lines beside the column; drag them to resize it.
- **RSVP** — chunk size, box colours, ORP highlight and anchor guides,
  surrounding-word context, progress.
- **RSVP pauses** — separate multipliers for commas, sentences, paragraphs,
  headings and long words.
- **Behavior** — keyboard shortcuts, instant-apply, position memory, default
  mode, PDF takeover, reduced motion.

## Keyboard

<kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> word (Shift: ten) ·
<kbd>↑</kbd><kbd>↓</kbd> line · <kbd>J</kbd><kbd>K</kbd> slower/faster ·
<kbd>1</kbd>–<kbd>5</kbd> modes · <kbd>S</kbd> settings ·
<kbd>B</kbd> bionic · <kbd>D</kbd> dim · <kbd>P</kbd> paginated ·
<kbd>?</kbd> the full list.

## Layout safety

Reflowing a PDF is only useful if the result is stable. Two rules are enforced
throughout the code:

- Every word is an `inline` span separated by real spaces, so wrapping words for
  the pacer cannot change where lines break.
- Nothing that shows transient state may change text metrics. Highlights use
  colour, background and box-shadow only. Line stripes, dim veils and the
  descending bar are absolutely-positioned elements in an overlay layer and
  never touch the text at all.

Decorations that genuinely change metrics — bionic bolding, first-letter bold —
are applied as part of the static render, before anything is measured.

## Privacy

No network access of any kind. Fonts and PDF.js are bundled; the only thing
fetched is the PDF you asked for. Settings sync through your Chrome profile;
reading positions stay on the device.

## Layout of the source

```
manifest.json          MV3 manifest
background.js          PDF takeover (dynamic declarativeNetRequest), toolbar, commands
options/               the handful of settings that belong outside a document
reader/
  reader.html          DOM skeleton
  reader.css           shell + the typography contract
  reader.js            orchestrator: load, render, modes, pagination, keyboard
  panel.js/.css        settings panel, generated entirely from the schema
  lib/schema.js        single source of truth for every setting
  lib/settings.js      persistence, CSS-variable application, position memory
  lib/markup.js        word spans, bionic/first-letter, the word index
  lib/extract.js       PDF -> paragraphs (columns, de-hyphenation, running heads)
  lib/overlay.js/.css  line map, stripes, dim veils, descending bar
  lib/pacer.js         pure timing engine shared by every paced mode
  lib/readalong.js     word highlight + follow scrolling
  lib/autoscroll.js    continuous scrolling at reading speed
  lib/rsvp.js/.css     one-word view with fixed ORP alignment
vendor/pdfjs/          PDF.js 6.3 + cmaps + standard fonts
fonts/                 23 bundled families, latin subsets, variable where available
test/                  node tests + PDF fixtures
```

Adding a setting means adding one entry to `reader/lib/schema.js`. The panel,
the CSS variables and reset-to-default all follow from it.

## Development

```sh
node --test test/                                   # unit tests
node .devtools/inspect-extract.mjs test/fixtures/twocol.pdf   # extraction quality
./package.sh                                        # build the store zip
```

`.devtools/` and `test/` are excluded from the packaged zip.

## New in 1.1

- **Links stay clickable.** Web links open in a new tab; in-document links ("see page 12", tables of contents) jump within the reader.
- **Charts, graphs, diagrams and tables** are captured from the PDF as pictures and placed in reading order, instead of turning into fragments of text. Toggle, resize and dark-theme inversion under Pages.
- **Flow mode** (key 4, or F to start playing): read-along and auto-scroll combined. The current line is held at a fixed height (Flow → "Hold the current line at") and the text glides under it; the current phrase is highlighted and a sweep runs across each line at your wpm.
- **Skim & compress:** first-sentence highlight, number and name emphasis, filler-word fading, phrase spacing, sentence spacing, and Compress text (drop filler words, or first sentences only).
- **Phrase chunking:** words are grouped into 2-4 word meaning units, used by phrase spacing, the Flow highlight and RSVP "Show whole phrases".
- **RSVP** opens clean: surrounding words, tick marks and the progress bar are off by default (all still available).
- **Done-in estimate** in the status bar ("done in 1 h 35 m at 300 wpm (7:24 PM)"); toggle with T.
- **Contents panel** (O): every chapter/section with its reading time, time until you reach it, page, and progress, with its own settings at the bottom.
- **Search** (⌘F or /): highlights every match, "3 of 12", Enter / Shift+Enter to step.
- Settings apply instantly and the drawer floats over the page instead of moving it.
