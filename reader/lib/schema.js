/**
 * Single source of truth for every user-adjustable setting.
 *
 * Everything else derives from this file:
 *   - the settings panel UI is generated from it (panel.js)
 *   - defaults / reset-to-default come from `def`
 *   - the CSS custom properties applied to the reader come from `cssVar` + `toCss`
 *   - persisted values are validated/coerced against it (settings.js)
 *
 * Adding a setting = adding one entry here. No other file needs to know about it
 * unless it has behaviour beyond a CSS variable.
 *
 * Field reference:
 *   key      unique id, also the storage key
 *   type     'range' | 'number' | 'bool' | 'select' | 'color' | 'text'
 *   def      default value
 *   min/max/step  for range/number
 *   unit     shown in the label, e.g. 'px'
 *   options  [{value,label}] for select
 *   cssVar   '--r-foo' -> written to the reader root on apply
 *   toCss    (v, all) => string  transform before writing cssVar
 *   nullable for color: allows '' meaning "inherit"
 *   hint     small helper text under the control
 *   showIf   (all) => bool  hide the control when irrelevant (purely cosmetic)
 */

export const SECTIONS = [
  { id: 'type',       label: 'Typography',                         icon: 'type',       group: 1 },
  { id: 'color',      label: 'Colors & contrast',                  icon: 'palette',    group: 1 },
  { id: 'headings',   label: 'Headings & links',                   icon: 'type',       group: 3 },
  { id: 'skim',       label: 'Skim: sentences, numbers, names',    icon: 'highlighter',group: 1 },
  { id: 'bionic',     label: 'Bionic reading',                     icon: 'bolt',       group: 3 },
  { id: 'stripes',    label: 'Line stripes',                       icon: 'highlighter',group: 3 },
  { id: 'focus',      label: 'Focus & dim',                        icon: 'focus',      group: 3 },
  { id: 'speed',      label: 'Speed & time left (all paced modes)', icon: 'sliders',   group: 1 },
  { id: 'pacer',      label: 'Read-along (mode 2)',                icon: 'sparkles',   group: 2 },
  { id: 'autoscroll', label: 'Auto-scroll (mode 3)',               icon: 'sparkles',   group: 2 },
  { id: 'bar',        label: 'Descending bar (modes 2 & 3)',       icon: 'layout',     group: 2 },
  { id: 'flow',       label: 'Flow (mode 4)',                      icon: 'sparkles',   group: 2 },
  { id: 'rsvp',       label: 'RSVP (mode 5)',                      icon: 'layout',     group: 2 },
  { id: 'rsvpPause',  label: 'Pauses at commas, periods… (modes 2, 4, 5)', icon: 'pause', group: 2 },
  { id: 'outline',    label: 'Contents panel',                     icon: 'columns',    group: 3 },
  { id: 'pages',      label: 'Pages, figures & tables',            icon: 'layout',     group: 3 },
  { id: 'rails',      label: 'Side rails',                         icon: 'columns',    group: 3 },
  { id: 'behavior',   label: 'Behavior',                           icon: 'sliders',    group: 3 },
];

/* ---------------------------------------------------------------- fonts --- */

/** Bundled families (fonts/fonts.css) + safe system stacks. */
export const FONTS = [
  { group: 'Serif — bundled', items: [
    ['Literata',              "'Literata', Georgia, serif"],
    ['Merriweather',          "'Merriweather', Georgia, serif"],
    ['Source Serif 4',        "'Source Serif 4', Georgia, serif"],
    ['EB Garamond',           "'EB Garamond', Garamond, serif"],
    ['Crimson Pro',           "'Crimson Pro', Georgia, serif"],
    ['Newsreader',            "'Newsreader', Georgia, serif"],
    ['Lora',                  "'Lora', Georgia, serif"],
    ['Bitter',                "'Bitter', Georgia, serif"],
    ['Vollkorn',              "'Vollkorn', Georgia, serif"],
    ['Libre Baskerville',     "'Libre Baskerville', Baskerville, serif"],
    ['PT Serif',              "'PT Serif', Georgia, serif"],
    ['IBM Plex Serif',        "'IBM Plex Serif', Georgia, serif"],
    ['Fraunces',              "'Fraunces', Georgia, serif"],
  ]},
  { group: 'Sans — bundled', items: [
    ['Inter',                 "'Inter', system-ui, sans-serif"],
    ['Source Sans 3',         "'Source Sans 3', system-ui, sans-serif"],
    ['Public Sans',           "'Public Sans', system-ui, sans-serif"],
    ['IBM Plex Sans',         "'IBM Plex Sans', system-ui, sans-serif"],
    ['Open Sans',             "'Open Sans', system-ui, sans-serif"],
    ['Nunito Sans',           "'Nunito Sans', system-ui, sans-serif"],
  ]},
  { group: 'Accessible / dyslexia', items: [
    ['Atkinson Hyperlegible', "'Atkinson Hyperlegible Next', system-ui, sans-serif"],
    ['OpenDyslexic',          "'OpenDyslexic', Comic Sans MS, sans-serif"],
    ['Lexend',                "'Lexend', system-ui, sans-serif"],
  ]},
  { group: 'Monospace', items: [
    ['JetBrains Mono',        "'JetBrains Mono', ui-monospace, monospace"],
  ]},
  { group: 'System', items: [
    ['System UI',             "system-ui, -apple-system, sans-serif"],
    ['Georgia',               "Georgia, 'Times New Roman', serif"],
    ['Palatino',              "'Palatino Linotype', Palatino, 'Book Antiqua', serif"],
    ['Baskerville',           "Baskerville, 'Times New Roman', serif"],
    ['Iowan Old Style',       "'Iowan Old Style', Georgia, serif"],
    ['Charter',               "Charter, Georgia, serif"],
    ['Times New Roman',       "'Times New Roman', Times, serif"],
    ['Helvetica',             "Helvetica, Arial, sans-serif"],
    ['Arial',                 "Arial, Helvetica, sans-serif"],
    ['Avenir',                "Avenir, 'Avenir Next', system-ui, sans-serif"],
    ['Verdana',               "Verdana, Geneva, sans-serif"],
    ['Tahoma',                "Tahoma, Geneva, sans-serif"],
    ['Trebuchet MS',          "'Trebuchet MS', Tahoma, sans-serif"],
    ['Courier New',           "'Courier New', Courier, monospace"],
  ]},
];

const FONT_OPTIONS = FONTS.flatMap(g =>
  g.items.map(([label, stack]) => ({ value: stack, label, group: g.group })));

/* -------------------------------------------------------------- presets --- */

/** Colour presets. Each only touches bg/fg so nothing else is clobbered. */
export const PRESETS = [
  { id: 'cream',     label: 'Cream',     bg: '#f6f0e2', fg: '#3a3229' },
  { id: 'paper',     label: 'Paper',     bg: '#ffffff', fg: '#1f2328' },
  { id: 'sepia',     label: 'Sepia',     bg: '#f4ecd8', fg: '#5b4636' },
  { id: 'solarized', label: 'Solarized', bg: '#fdf6e3', fg: '#586e75' },
  { id: 'grey',      label: 'Soft grey', bg: '#e9e9e4', fg: '#33352f' },
  { id: 'dark',      label: 'Dark',      bg: '#14161a', fg: '#e6e6e6' },
  { id: 'midnight',  label: 'Midnight',  bg: '#0b1020', fg: '#dbe3f4' },
  { id: 'slate',     label: 'Slate',     bg: '#1c1f26', fg: '#cfd6e0' },
  { id: 'amber',     label: 'Night amber',bg:'#17130c', fg: '#f0d9a8' },
  { id: 'contrast',  label: 'High contrast', bg: '#000000', fg: '#ffffff' },
];

/* -------------------------------------------------------------- helpers --- */

const px = v => `${v}px`;
const num = v => String(v);
const pct = v => `${v}%`;
/** 0-100 -> 0-1 opacity string */
const frac = v => String(Math.round((v / 100) * 1000) / 1000);

/** How a highlighted thing (first sentence, numbers…) is drawn. */
const STYLE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'bold', label: 'Bold' },
  { value: 'highlight', label: 'Highlight' },
  { value: 'bold-highlight', label: 'Bold + highlight' },
  { value: 'color', label: 'Colored text' },
  { value: 'bold-color', label: 'Bold + colored text' },
  { value: 'underline', label: 'Underline' },
];

const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgbHex = a => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const lum = h => { const [r, g, b] = hexRgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
/** Text colour pushed toward black/white (away from the background) by pct, or toward the background when negative. */
export function contrastFg(fg, bg, pct) {
  if (!pct || !/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(bg)) return fg;
  const target = pct > 0 ? (lum(bg) > 0.5 ? '#000000' : '#ffffff') : bg;
  const t = Math.abs(pct) / 100;
  const a = hexRgb(fg), b = hexRgb(target);
  return rgbHex(a.map((v, i) => v + (b[i] - v) * t));
}

/** Per-style CSS variables for one highlighted thing; prefix e.g. 'fs'. */
function styleVars(prefix, style, color, weight) {
  const st = style || 'off';
  return {
    [`--r-${prefix}-w`]: /bold/.test(st) ? String(weight) : 'inherit',
    [`--r-${prefix}-hl`]: /highlight/.test(st) ? color : 'transparent',
    [`--r-${prefix}-c`]: /color/.test(st) ? color : 'inherit',
    [`--r-${prefix}-ul`]: st === 'underline' ? 'underline' : 'none',
  };
}

/** Variables derived from several settings at once. */
function derivedVars(s) {
  const bold = Math.min(900, (s.fontWeight ?? 400) + 250);
  const shape = { full: ['0%', '100%'], marker: ['30%', '96%'], band: ['72%', '96%'] }[s.hlShape] ?? ['30%', '96%'];
  return {
    ...styleVars('fs', s.firstSentence, s.firstSentenceColor, s.firstSentenceWeight),
    ...styleVars('ls', s.lastSentence, s.lastSentenceColor, s.lastSentenceWeight),
    ...styleVars('num', s.numberStyle, s.numberColor, bold),
    ...styleVars('nm', s.nameStyle, s.nameColor, bold),
    '--hl-a': shape[0],
    '--hl-b': shape[1],
  };
}

/* --------------------------------------------------------------- schema --- */

export const SETTINGS = [
  /* ============================================================ TYPOGRAPHY */
  { key: 'fontFamily', section: 'type', label: 'Font family', type: 'select',
    def: "'Literata', Georgia, serif", options: FONT_OPTIONS, cssVar: '--r-font' },

  { key: 'zoom', section: 'type', label: 'Zoom', type: 'range', unit: 'x',
    def: 1, min: 0.6, max: 2.5, step: 0.05, cssVar: '--r-zoom', toCss: num,
    hint: 'Scales text and spacing together.' },

  { key: 'fontSize', section: 'type', label: 'Font size', type: 'range', unit: 'px',
    def: 19, min: 11, max: 44, step: 1, cssVar: '--r-fs', toCss: px },

  { key: 'lineHeight', section: 'type', label: 'Line height', type: 'range',
    def: 1.65, min: 1, max: 2.6, step: 0.05, cssVar: '--r-lh', toCss: num },

  { key: 'letterSpacing', section: 'type', label: 'Letter spacing', type: 'range', unit: 'px',
    def: 0, min: -1, max: 4, step: 0.1, cssVar: '--r-ls', toCss: px },

  { key: 'wordSpacing', section: 'type', label: 'Word spacing', type: 'range', unit: 'px',
    def: 0, min: 0, max: 16, step: 0.5, cssVar: '--r-ws', toCss: px },

  { key: 'paragraphSpacing', section: 'type', label: 'Paragraph spacing', type: 'range', unit: 'px',
    def: 14, min: 0, max: 56, step: 1, cssVar: '--r-ps', toCss: px },

  { key: 'columnWidth', section: 'type', label: 'Column width', type: 'range', unit: 'ch',
    def: 68, min: 30, max: 120, step: 1, cssVar: '--r-cw', toCss: v => `${v}ch`,
    hint: 'You can also drag the edges of the text column.' },

  { key: 'fontWeight', section: 'type', label: 'Font weight (boldness)', type: 'range',
    def: 400, min: 200, max: 900, step: 10, cssVar: '--r-fw', toCss: num },

  { key: 'alignment', section: 'type', label: 'Alignment', type: 'select', def: 'left',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'justify', label: 'Justified' },
      { value: 'center', label: 'Centered' },
      { value: 'right', label: 'Right' },
    ], cssVar: '--r-align' },

  { key: 'hyphenate', section: 'type', label: 'Hyphenate', type: 'bool', def: false,
    cssVar: '--r-hyphens', toCss: v => (v ? 'auto' : 'manual'),
    hint: 'Recommended with justified text to avoid gappy lines.' },

  { key: 'indentParagraphs', section: 'type', label: 'Indent paragraphs', type: 'bool', def: false,
    cssVar: '--r-indent', toCss: v => (v ? '2em' : '0') },

  /* ================================================================ COLORS */
  { key: 'bg', section: 'color', label: 'Background', type: 'color', def: '#f6f0e2',
    cssVar: '--r-bg' },
  { key: 'fg', section: 'color', label: 'Text color', type: 'color', def: '#3a3229',
    cssVar: '--r-fg', toCss: (v, s) => contrastFg(v, s.bg, s.textContrast) },
  { key: 'pagePadding', section: 'color', label: 'Page padding', type: 'range', unit: 'px',
    def: 48, min: 0, max: 160, step: 4, cssVar: '--r-pad', toCss: px },
  { key: 'textContrast', section: 'color', label: 'Text contrast', type: 'range', unit: '%',
    def: 0, min: -60, max: 100, step: 5,
    hint: 'Pushes the text color toward pure black or white (negative softens it).' },
  { key: 'textThicken', section: 'color', label: 'Thicken letters', type: 'range', unit: 'px',
    def: 0, min: 0, max: 1, step: 0.05, cssVar: '--r-stroke', toCss: px,
    hint: 'Adds weight to thin fonts without changing their size or spacing.' },
  { key: 'selectionColor', section: 'color', label: 'Selection color', type: 'color', def: '#93c5fd',
    cssVar: '--r-sel' },

  /* ============================================================== HEADINGS */
  { key: 'headingScale', section: 'headings', label: 'Heading size', type: 'range', unit: 'x',
    def: 1, min: 0.7, max: 2, step: 0.05, cssVar: '--r-hs', toCss: num },
  { key: 'headingWeight', section: 'headings', label: 'Heading boldness', type: 'range',
    def: 700, min: 400, max: 900, step: 50, cssVar: '--r-hw', toCss: num },
  { key: 'headingColor', section: 'headings', label: 'Heading color', type: 'color', def: '',
    nullable: true, cssVar: '--r-hc', toCss: v => v || 'inherit' },
  { key: 'headingSpace', section: 'headings', label: 'Space above headings', type: 'range', unit: 'x',
    def: 2, min: 0.5, max: 5, step: 0.25, cssVar: '--r-hsp', toCss: num },
  { key: 'linkColor', section: 'headings', label: 'Link color', type: 'color', def: '#2563eb',
    cssVar: '--r-link' },
  { key: 'linkUnderline', section: 'headings', label: 'Underline links', type: 'bool', def: true,
    cssVar: '--r-link-ul', toCss: v => (v ? 'underline' : 'none') },

  /* ================================================================ BIONIC */
  { key: 'bionicOn', section: 'bionic', label: 'Enable bionic', type: 'bool', def: false,
    strong: true, rerender: true },
  { key: 'bionicPercent', section: 'bionic', label: 'Bolded letters', type: 'range', unit: '%',
    def: 40, min: 5, max: 90, step: 1, rerender: true, showIf: s => s.bionicOn },
  { key: 'bionicMinLen', section: 'bionic', label: 'Skip words shorter than', type: 'range', unit: 'letters',
    def: 4, min: 1, max: 8, step: 1, rerender: true, showIf: s => s.bionicOn },
  { key: 'bionicRemainderOpacity', section: 'bionic', label: 'Remainder opacity', type: 'range', unit: '%',
    def: 75, min: 20, max: 100, step: 1, cssVar: '--r-bi-rest', toCss: frac,
    showIf: s => s.bionicOn },
  { key: 'bionicWeight', section: 'bionic', label: 'Bold weight', type: 'range',
    def: 700, min: 500, max: 900, step: 10, cssVar: '--r-bi-weight', toCss: num,
    showIf: s => s.bionicOn },
  { key: 'bionicColor', section: 'bionic', label: 'Bold color', type: 'color', def: '',
    nullable: true, cssVar: '--r-bi-color', toCss: v => v || 'inherit',
    showIf: s => s.bionicOn },

  /* ================================================================== SKIM */
  { key: 'firstSentence', section: 'skim', label: 'First sentence of each paragraph', type: 'select', def: 'bold',
    options: STYLE_OPTIONS, strong: true,
    hint: 'Most paragraphs state their point first. Read just these to skim a chapter.' },
  { key: 'firstSentenceColor', section: 'skim', label: 'First-sentence color', type: 'color', def: '#fde047',
    showIf: s => /highlight|color/.test(s.firstSentence) },
  { key: 'firstSentenceWeight', section: 'skim', label: 'First-sentence boldness', type: 'range',
    def: 650, min: 500, max: 900, step: 50, showIf: s => /bold/.test(s.firstSentence) },
  { key: 'lastSentence', section: 'skim', label: 'Last sentence of each paragraph', type: 'select', def: 'off',
    options: STYLE_OPTIONS, strong: true, hint: 'Often the conclusion or the bridge to the next paragraph.' },
  { key: 'lastSentenceColor', section: 'skim', label: 'Last-sentence color', type: 'color', def: '#bae6fd',
    showIf: s => /highlight|color/.test(s.lastSentence) },
  { key: 'lastSentenceWeight', section: 'skim', label: 'Last-sentence boldness', type: 'range',
    def: 600, min: 500, max: 900, step: 50, showIf: s => /bold/.test(s.lastSentence) },

  { key: 'numberStyle', section: 'skim', label: 'Numbers & statistics', type: 'select', def: 'off',
    options: STYLE_OPTIONS, strong: true },
  { key: 'numberColor', section: 'skim', label: 'Number color', type: 'color', def: '#2563eb',
    showIf: s => /highlight|color/.test(s.numberStyle) },
  { key: 'nameStyle', section: 'skim', label: 'Names & key terms', type: 'select', def: 'off',
    options: STYLE_OPTIONS, strong: true, hint: 'Capitalized words mid-sentence and acronyms. Runs like "New York Times" mark as one piece.' },
  { key: 'nameColor', section: 'skim', label: 'Name color', type: 'color', def: '#c4b5fd',
    showIf: s => /highlight|color/.test(s.nameStyle) },

  { key: 'hlShape', section: 'skim', label: 'Highlighter shape', type: 'select', def: 'marker',
    options: [
      { value: 'full', label: 'Full height (solid)' },
      { value: 'marker', label: 'Marker (lower 2/3, like a real highlighter)' },
      { value: 'band', label: 'Thin band under the text' },
    ], hint: 'Applies to every highlight style above. Spaces between words are covered too.' },
  { key: 'hlOpacity', section: 'skim', label: 'Highlighter strength', type: 'range', unit: '%',
    def: 55, min: 10, max: 100, step: 1, cssVar: '--hl-op', toCss: frac },
  { key: 'hlRound', section: 'skim', label: 'Rounded highlight ends', type: 'bool', def: true,
    cssVar: '--hl-radius', toCss: v => (v ? '.25em' : '0') },

  { key: 'fillerFade', section: 'skim', label: 'Fade filler words', type: 'bool', def: false, strong: true,
    hint: 'Function words (the, of, which…) recede so content words stand out. "not"/"no" never fade.' },
  { key: 'fillerOpacity', section: 'skim', label: 'Filler opacity', type: 'range', unit: '%',
    def: 55, min: 10, max: 95, step: 1, cssVar: '--r-sw-op', toCss: (v, s) => (s.fillerFade ? frac(v) : '1'),
    showIf: s => s.fillerFade },

  { key: 'phraseSpacing', section: 'skim', label: 'Space out phrases', type: 'bool', def: false, strong: true,
    hint: 'Adds a gap between 2-4 word meaning units, the size your eye takes in per glance.' },
  { key: 'phraseGap', section: 'skim', label: 'Phrase gap', type: 'range', unit: 'px',
    def: 7, min: 1, max: 30, step: 1, cssVar: '--r-pe-gap', toCss: (v, s) => (s.phraseSpacing ? px(v) : '0px'),
    showIf: s => s.phraseSpacing },
  { key: 'phraseMax', section: 'skim', label: 'Longest phrase', type: 'range', unit: 'words',
    def: 4, min: 2, max: 7, step: 1, rerender: true,
    hint: 'Also sets the phrase size for the Flow highlight and RSVP phrases.' },
  { key: 'sentenceGap', section: 'skim', label: 'Extra space after sentences', type: 'range', unit: 'px',
    def: 0, min: 0, max: 30, step: 1, cssVar: '--r-se-gap', toCss: px },

  { key: 'compress', section: 'skim', label: 'Compress text', type: 'select', def: 'off',
    options: [
      { value: 'off', label: 'Off: full text' },
      { value: 'filler', label: 'Drop filler words (telegraph style)' },
      { value: 'topic', label: 'First sentence of each paragraph only' },
    ], rerender: true,
    hint: 'Shortens what the pacer, RSVP and time estimate run over. Headings always stay.' },

  /* =============================================================== STRIPES */
  { key: 'stripesOn', section: 'stripes', label: 'Highlight every Nth line', type: 'bool',
    def: false, strong: true },
  { key: 'stripeEvery', section: 'stripes', label: 'Every N lines', type: 'range',
    def: 3, min: 2, max: 10, step: 1, showIf: s => s.stripesOn },
  { key: 'stripeColor', section: 'stripes', label: 'Stripe color', type: 'color', def: '#fff59d',
    cssVar: '--r-stripe', showIf: s => s.stripesOn },
  { key: 'stripeOpacity', section: 'stripes', label: 'Stripe opacity', type: 'range', unit: '%',
    def: 25, min: 2, max: 100, step: 1, cssVar: '--r-stripe-op', toCss: frac,
    showIf: s => s.stripesOn },
  { key: 'stripeAlternate', section: 'stripes', label: 'Alternate second color', type: 'bool',
    def: false, showIf: s => s.stripesOn },
  { key: 'stripeColor2', section: 'stripes', label: 'Second color', type: 'color', def: '#b3e5fc',
    cssVar: '--r-stripe2', showIf: s => s.stripesOn && s.stripeAlternate },

  /* ========================================================== FOCUS & DIM */
  { key: 'dimOn', section: 'focus', label: 'Dim mode', type: 'bool', def: false, strong: true,
    hint: 'Fades everything except the lines you are on.' },
  { key: 'dimStrength', section: 'focus', label: 'Dim strength', type: 'range', unit: '%',
    def: 60, min: 10, max: 95, step: 1, cssVar: '--r-dim', toCss: frac, showIf: s => s.dimOn },
  { key: 'dimLines', section: 'focus', label: 'Visible lines', type: 'range',
    def: 3, min: 1, max: 12, step: 1, showIf: s => s.dimOn },
  { key: 'firstLetterOn', section: 'focus', label: 'First-letter emphasis', type: 'bool',
    def: false, strong: true, rerender: true },
  { key: 'firstLetterScope', section: 'focus', label: 'Apply to', type: 'select', def: 'word',
    options: [
      { value: 'word', label: 'First letter of every word' },
      { value: 'sentence', label: 'First letter of each sentence' },
      { value: 'paragraph', label: 'First letter of each paragraph' },
    ], rerender: true, showIf: s => s.firstLetterOn },
  { key: 'firstLetterColor', section: 'focus', label: 'First-letter color', type: 'color',
    def: '#c2410c', cssVar: '--r-fl-color', showIf: s => s.firstLetterOn },
  { key: 'firstLetterBold', section: 'focus', label: 'Bold the first letter', type: 'bool',
    def: false, cssVar: '--r-fl-weight', toCss: (v, s) => (v ? String(Math.min(900, s.fontWeight + 300)) : 'inherit'),
    showIf: s => s.firstLetterOn },

  /* ================================================================= SPEED */
  { key: 'wpm', section: 'speed', label: 'Words per minute', type: 'range',
    def: 250, min: 60, max: 1200, step: 10, strong: true,
    hint: 'Drives Read-along, Auto-scroll, Flow and RSVP. J / K to change while reading.' },
  { key: 'wpmStep', section: 'speed', label: 'J / K step', type: 'range', unit: 'wpm',
    def: 25, min: 5, max: 100, step: 5 },
  { key: 'showTimeLeft', section: 'speed', label: 'Show "done in…" estimate', type: 'bool', def: true,
    strong: true, hint: 'Time to finish the document at your current wpm. Toggle with T.' },
  { key: 'timeLeftClock', section: 'speed', label: 'Include the finish time', type: 'bool', def: true,
    showIf: s => s.showTimeLeft },

  /* ============================================================ READ-ALONG */
  { key: 'pacerColor', section: 'pacer', label: 'Pacer color', type: 'color', def: '#e11d48',
    cssVar: '--r-pacer' },
  { key: 'pacerBackground', section: 'pacer', label: 'Pacer background', type: 'bool', def: true },
  { key: 'pacerUnderline', section: 'pacer', label: 'Pacer underline', type: 'bool', def: false },
  { key: 'pacerTintText', section: 'pacer', label: 'Tint the word itself', type: 'bool', def: false,
    hint: 'Colors the current word instead of only its backdrop.' },
  { key: 'pacerFollow', section: 'pacer', label: 'Keep current word on screen', type: 'bool', def: true },
  { key: 'pacerAnchor', section: 'pacer', label: 'Hold the word at', type: 'range', unit: '% of height',
    def: 40, min: 15, max: 80, step: 5, showIf: s => s.pacerFollow },

  /* =========================================================== AUTO-SCROLL */
  { key: 'autoScrollHideWord', section: 'autoscroll', label: 'Hide word highlight while auto-scrolling',
    type: 'bool', def: true },

  /* ================================================================== BAR */
  { key: 'barOn', section: 'bar', label: 'Descending bar', type: 'bool', def: false, strong: true,
    hint: 'A translucent band that tracks the line you are reading.' },
  { key: 'barColor', section: 'bar', label: 'Bar color', type: 'color', def: '#e11d48',
    cssVar: '--r-bar', showIf: s => s.barOn },
  { key: 'barOpacity', section: 'bar', label: 'Bar opacity', type: 'range', unit: '%',
    def: 18, min: 2, max: 80, step: 1, cssVar: '--r-bar-op', toCss: frac, showIf: s => s.barOn },
  { key: 'barHeight', section: 'bar', label: 'Bar height', type: 'range', unit: 'px',
    def: 40, min: 4, max: 160, step: 2, cssVar: '--r-bar-h', toCss: px, showIf: s => s.barOn },

  /* ================================================================== FLOW */
  { key: 'flowGuide', section: 'flow', label: 'Reading guide', type: 'select', def: 'band', strong: true,
    options: [
      { value: 'band', label: 'Fixed band: stays still, text rises through it' },
      { value: 'line', label: 'Follows the current line' },
      { value: 'none', label: 'None' },
    ] },
  { key: 'flowAnchor', section: 'flow', label: 'Band / line height on screen', type: 'range', unit: '% from top',
    def: 45, min: 10, max: 90, step: 1 },
  { key: 'flowBandLines', section: 'flow', label: 'Band height', type: 'range', unit: 'lines',
    def: 1, min: 1, max: 6, step: 0.5, showIf: s => s.flowGuide !== 'none' },
  { key: 'flowBandStyle', section: 'flow', label: 'Guide look', type: 'select', def: 'fill',
    options: [
      { value: 'fill', label: 'Tinted band' },
      { value: 'rules', label: 'Two lines above and below' },
      { value: 'outline', label: 'Outlined box' },
      { value: 'fill-rules', label: 'Tinted band + lines' },
    ], showIf: s => s.flowGuide !== 'none' },
  { key: 'flowColor', section: 'flow', label: 'Flow color', type: 'color', def: '#e11d48',
    cssVar: '--r-flow' },
  { key: 'flowBandOpacity', section: 'flow', label: 'Guide strength', type: 'range', unit: '%',
    def: 12, min: 2, max: 70, step: 1, cssVar: '--r-flow-band-op', toCss: frac, showIf: s => s.flowGuide !== 'none' },
  { key: 'flowWidth', section: 'flow', label: 'Guide width', type: 'select', def: 'text',
    options: [
      { value: 'text', label: 'Text column only' },
      { value: 'page', label: 'Whole page width' },
    ], showIf: s => s.flowGuide !== 'none' },

  { key: 'flowScroll', section: 'flow', label: 'Scrolling', type: 'select', def: 'continuous',
    options: [
      { value: 'continuous', label: 'Continuous glide (constant motion)' },
      { value: 'line', label: 'Line by line (moves when a line ends)' },
    ] },
  { key: 'flowGlide', section: 'flow', label: 'Glide smoothness', type: 'range',
    def: 1, min: 1, max: 10, step: 1, hint: '1 = locked to the pace, 10 = very soft easing.' },

  { key: 'flowHighlight', section: 'flow', label: 'Highlight', type: 'select', def: 'phrase',
    options: [
      { value: 'phrase', label: 'Current phrase (2-4 words)' },
      { value: 'word', label: 'Current word' },
      { value: 'none', label: 'None' },
    ] },
  { key: 'flowHighlightOpacity', section: 'flow', label: 'Highlight strength', type: 'range', unit: '%',
    def: 22, min: 5, max: 80, step: 1, cssVar: '--r-flow-hl-op', toCss: frac, showIf: s => s.flowHighlight !== 'none' },
  { key: 'flowSweep', section: 'flow', label: 'Pace sweep along the line', type: 'select', def: 'underline',
    options: [
      { value: 'underline', label: 'Underline that grows across the line' },
      { value: 'fill', label: 'Shading that fills the line' },
      { value: 'caret', label: 'Moving marker' },
      { value: 'off', label: 'Off' },
    ], hint: 'Runs at your wpm. Keep your eyes just ahead of it.' },
  { key: 'flowSweepThickness', section: 'flow', label: 'Sweep thickness', type: 'range', unit: 'px',
    def: 3, min: 1, max: 8, step: 1, cssVar: '--r-flow-sweep-h', toCss: px, showIf: s => s.flowSweep !== 'off' },

  { key: 'flowFadeAbove', section: 'flow', label: 'Fade text above the guide', type: 'range', unit: '%',
    def: 35, min: 0, max: 95, step: 1, hint: 'A smooth gradient: the further from the guide, the fainter.' },
  { key: 'flowFadeBelow', section: 'flow', label: 'Fade text below the guide', type: 'range', unit: '%',
    def: 20, min: 0, max: 95, step: 1 },
  { key: 'flowFadeClear', section: 'flow', label: 'Clear zone around the guide', type: 'range', unit: 'lines',
    def: 1.5, min: 0, max: 10, step: 0.5, showIf: s => s.flowFadeAbove > 0 || s.flowFadeBelow > 0 },
  { key: 'flowFadeSoftness', section: 'flow', label: 'Fade length', type: 'range', unit: '% of screen',
    def: 35, min: 5, max: 60, step: 1, showIf: s => s.flowFadeAbove > 0 || s.flowFadeBelow > 0,
    hint: 'How far the gradient takes to reach full strength.' },
  { key: 'flowPauseOnScroll', section: 'flow', label: 'Pause when I scroll', type: 'bool', def: true },

  /* =============================================================== OUTLINE */
  { key: 'outlineOpen', section: 'outline', label: 'Show the contents panel', type: 'bool', def: false,
    strong: true, hint: 'Chapters and sections on the left, with timings. Toggle with O.' },
  { key: 'outlineSource', section: 'outline', label: 'Sections come from', type: 'select', def: 'auto',
    options: [
      { value: 'auto', label: 'Headings, or pages if there are none' },
      { value: 'headings', label: 'Headings' },
      { value: 'pages', label: 'PDF pages' },
    ] },
  { key: 'outlineDepth', section: 'outline', label: 'Heading levels shown', type: 'range',
    def: 2, min: 1, max: 3, step: 1, hint: '1 = chapters only, 3 = every subsection.' },
  { key: 'outlineShowLength', section: 'outline', label: 'Reading time of each section', type: 'bool', def: true },
  { key: 'outlineShowUntil', section: 'outline', label: 'Time until each section', type: 'bool', def: true },
  { key: 'outlineShowBars', section: 'outline', label: 'Progress bar on each section', type: 'bool', def: true },
  { key: 'outlineShowWords', section: 'outline', label: 'Word counts', type: 'bool', def: false },
  { key: 'outlineShowPages', section: 'outline', label: 'PDF page numbers', type: 'bool', def: true },
  { key: 'outlineFollow', section: 'outline', label: 'Keep the current section in view', type: 'bool', def: true },
  { key: 'outlineWidth', section: 'outline', label: 'Panel width', type: 'range', unit: 'px',
    def: 300, min: 220, max: 480, step: 10, cssVar: '--outline-w', toCss: px },

  /* ================================================================= PAGES */
  { key: 'showFigures', section: 'pages', label: 'Show figures, charts & tables', type: 'bool', def: true,
    rerender: true, hint: 'Captured from the PDF as pictures, in reading order.' },
  { key: 'figureInvert', section: 'pages', label: 'Invert figures (for dark themes)', type: 'bool', def: false,
    cssVar: '--r-fig-filter', toCss: v => (v ? 'invert(1) hue-rotate(180deg)' : 'none'), showIf: s => s.showFigures },
  { key: 'figureMaxWidth', section: 'pages', label: 'Figure size', type: 'range', unit: '%',
    def: 100, min: 40, max: 160, step: 5, cssVar: '--r-fig-scale', toCss: v => String(v / 100),
    showIf: s => s.showFigures },
  { key: 'paginated', section: 'pages', label: 'Paginated (no scroll)', type: 'bool', def: false,
    strong: true },
  { key: 'wordsPerPage', section: 'pages', label: 'Words per page (0 = fit to window)', type: 'range',
    def: 0, min: 0, max: 900, step: 10, showIf: s => s.paginated },
  { key: 'showPageNumbers', section: 'pages', label: 'Show page numbers', type: 'bool', def: true },
  { key: 'showPdfPageMarks', section: 'pages', label: 'Show original PDF page breaks', type: 'bool',
    def: false, rerender: true, hint: 'Thin marker where each PDF page ended.' },

  /* ================================================================= RAILS */
  { key: 'railsOn', section: 'rails', label: 'Show side rails', type: 'bool', def: false, strong: true },
  { key: 'railColor', section: 'rails', label: 'Rail color', type: 'color', def: '#94a3b8',
    cssVar: '--r-rail', showIf: s => s.railsOn },
  { key: 'railThickness', section: 'rails', label: 'Rail thickness', type: 'range', unit: 'px',
    def: 2, min: 1, max: 12, step: 1, cssVar: '--r-rail-w', toCss: px, showIf: s => s.railsOn },
  { key: 'railGap', section: 'rails', label: 'Rail gap from text', type: 'range', unit: 'px',
    def: 16, min: 0, max: 80, step: 2, cssVar: '--r-rail-gap', toCss: px, showIf: s => s.railsOn },

  /* ================================================================== RSVP */
  { key: 'rsvpPhrase', section: 'rsvp', label: 'Show whole phrases', type: 'bool', def: false,
    hint: 'Flashes 2-4 word meaning units instead of single words. Overrides chunk size.' },
  { key: 'rsvpChunk', section: 'rsvp', label: 'Chunk size', type: 'range', unit: 'words',
    def: 1, min: 1, max: 5, step: 1, showIf: s => !s.rsvpPhrase },
  { key: 'rsvpFontSize', section: 'rsvp', label: 'Font size', type: 'range', unit: 'px',
    def: 56, min: 20, max: 140, step: 2, cssVar: '--r-rsvp-fs', toCss: px },
  { key: 'rsvpBg', section: 'rsvp', label: 'Box background', type: 'color', def: '#0f172a',
    cssVar: '--r-rsvp-bg' },
  { key: 'rsvpFg', section: 'rsvp', label: 'Box text', type: 'color', def: '#f8fafc',
    cssVar: '--r-rsvp-fg' },
  { key: 'rsvpOrp', section: 'rsvp', label: 'ORP (middle-letter highlight)', type: 'bool', def: true,
    hint: 'Aligns every word on its optimal recognition point.' },
  { key: 'rsvpOrpColor', section: 'rsvp', label: 'ORP color', type: 'color', def: '#f43f5e',
    cssVar: '--r-orp', showIf: s => s.rsvpOrp },
  { key: 'rsvpOrpBold', section: 'rsvp', label: 'ORP bold', type: 'bool', def: true,
    cssVar: '--r-orp-weight', toCss: v => (v ? '800' : 'inherit'), showIf: s => s.rsvpOrp },
  // Renamed from rsvpGuides/rsvpContext/rsvpProgress so the new off defaults
  // apply to existing installs too.
  { key: 'rsvpShowGuides', section: 'rsvp', label: 'ORP tick marks above and below', type: 'bool', def: false,
    showIf: s => s.rsvpOrp },
  { key: 'rsvpShowContext', section: 'rsvp', label: 'Show surrounding words above and below', type: 'bool',
    def: false, hint: 'Off keeps the eye on one spot, which is the point of RSVP.' },
  { key: 'rsvpShowProgress', section: 'rsvp', label: 'Show progress bar', type: 'bool', def: false },

  /* ========================================================== RSVP PAUSES */
  { key: 'pauseComma', section: 'rsvpPause', label: 'Comma pause', type: 'range', unit: 'x',
    def: 1.4, min: 1, max: 4, step: 0.1 },
  { key: 'pausePeriod', section: 'rsvpPause', label: 'Period pause', type: 'range', unit: 'x',
    def: 1.8, min: 1, max: 5, step: 0.1 },
  { key: 'pauseParagraph', section: 'rsvpPause', label: 'Paragraph pause', type: 'range', unit: 'x',
    def: 2.2, min: 1, max: 6, step: 0.1 },
  { key: 'pauseHeading', section: 'rsvpPause', label: 'Heading pause', type: 'range', unit: 'x',
    def: 4, min: 1, max: 8, step: 0.1 },
  { key: 'pauseLongWord', section: 'rsvpPause', label: 'Long word pause', type: 'range', unit: 'x',
    def: 1.4, min: 1, max: 4, step: 0.1 },
  { key: 'longWordLen', section: 'rsvpPause', label: 'A word is "long" at', type: 'range', unit: 'letters',
    def: 9, min: 5, max: 20, step: 1 },

  /* ============================================================== BEHAVIOR */
  { key: 'keyboardShortcuts', section: 'behavior', label: 'Keyboard shortcuts', type: 'bool', def: true,
    hint: 'Space play/pause · ←/→ word · ↑/↓ line · J/K speed · 1-6 modes · F flow · T time left · S settings.' },
  { key: 'applyInstantly', section: 'behavior', label: 'Apply changes instantly', type: 'bool', def: true,
    hint: 'Off: changes preview in the panel until you click Apply.' },
  { key: 'rememberPosition', section: 'behavior', label: 'Remember where I stopped', type: 'bool', def: true },
  { key: 'defaultMode', section: 'behavior', label: 'Mode on open', type: 'select', def: 'normal',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'readalong', label: 'Read-along' },
      { value: 'autoscroll', label: 'Auto-scroll' },
      { value: 'flow', label: 'Flow (read-along + scroll)' },
      { value: 'rsvp', label: 'RSVP' },
    ]},
  { key: 'takeover', section: 'behavior', label: 'Open PDFs in this reader automatically', type: 'bool',
    def: true, hint: 'Off: use the toolbar button or Alt+R on a PDF.' },
  { key: 'reduceMotion', section: 'behavior', label: 'Reduce animation', type: 'bool', def: false },
];

/* ------------------------------------------------------------- utilities --- */

export const BY_KEY = Object.fromEntries(SETTINGS.map(s => [s.key, s]));

export const DEFAULTS = Object.fromEntries(SETTINGS.map(s => [s.key, s.def]));

/** Keys whose change requires re-building word/letter markup rather than just CSS. */
export const RERENDER_KEYS = new Set(SETTINGS.filter(s => s.rerender).map(s => s.key));

export const SECTION_KEYS = Object.fromEntries(
  SECTIONS.map(sec => [sec.id, SETTINGS.filter(s => s.section === sec.id).map(s => s.key)]));

/** Clamp/coerce one value to its schema. Returns the default when unusable. */
export function coerce(key, v) {
  const s = BY_KEY[key];
  if (!s) return undefined;
  switch (s.type) {
    case 'range':
    case 'number': {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (!Number.isFinite(n)) return s.def;
      const clamped = Math.min(s.max, Math.max(s.min, n));
      // snap to step so arbitrary stored values can't produce odd labels
      const steps = Math.round((clamped - s.min) / s.step);
      const snapped = s.min + steps * s.step;
      return Math.round(snapped * 1e6) / 1e6;
    }
    case 'bool':
      return typeof v === 'boolean' ? v : v === 'true';
    case 'select':
      return s.options.some(o => o.value === v) ? v : s.def;
    case 'color': {
      if (typeof v !== 'string') return s.def;
      if (v === '' && s.nullable) return '';
      return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : s.def;
    }
    default:
      return typeof v === 'string' ? v : s.def;
  }
}

/** Validate a whole settings object, filling gaps with defaults. */
export function normalize(raw) {
  const out = {};
  for (const s of SETTINGS) {
    out[s.key] = Object.prototype.hasOwnProperty.call(raw ?? {}, s.key)
      ? coerce(s.key, raw[s.key])
      : s.def;
  }
  return out;
}

/** The CSS custom properties for a settings object. */
export function cssVars(s) {
  const vars = {};
  for (const def of SETTINGS) {
    if (!def.cssVar) continue;
    const v = s[def.key];
    vars[def.cssVar] = def.toCss ? def.toCss(v, s) : String(v);
  }
  return Object.assign(vars, derivedVars(s));
}

/** Which preset (if any) the current colors match. */
export function activePreset(s) {
  const hit = PRESETS.find(p => p.bg === s.bg && p.fg === s.fg);
  return hit ? hit.id : null;
}
