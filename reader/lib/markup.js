/**
 * Turns the extracted document model into DOM, and builds the word index that
 * every reading mode is driven from.
 *
 * Layout safety rules this file exists to enforce:
 *
 *  1. Every word is a `<span class="w">` that stays `display: inline`. Inline
 *     spans do not affect line breaking, so wrapping words cannot change where
 *     lines wrap.
 *  2. Words are separated by real " " text nodes, never by margins/padding or
 *     `inline-block`, so word spacing stays exactly what the font and the
 *     `word-spacing` setting say it is.
 *  3. Nothing that highlights a word may change its metrics. Highlighting uses
 *     colour, background and box-shadow only — never font-weight, size,
 *     letter-spacing or padding, which would reflow the line and make text
 *     visibly jump as the pacer moves.
 *  4. Decorations that *do* change metrics (bionic bolding, first-letter bold)
 *     are applied as part of the static render, before anything is measured.
 */

export const FLAG = {
  CLAUSE: 1,    // word ends a clause: , ; : —
  SENTENCE: 2,  // word ends a sentence: . ! ?
  PARA: 4,      // last word of a paragraph
  HEADING: 8,   // word belongs to a heading
  // Precomputed at the schema's default threshold, purely as a fast path. The
  // authoritative test is `text[i]` against `settings.longWordLen`, since the
  // user can move that threshold without re-rendering.
  LONG: 16,
  PHRASE: 32,   // last word of a phrase chunk (see phraseEnds)
};

/* ------------------------------------------------------------ skim aids --- */

// Function words: they carry grammar, not content, so a skimming eye can
// glance off them. Faded, never removed.
const FILLER = new Set(('a an the of to in on at by for with from as is are was were be been being ' +
  'and or but so yet that this these those it its it\'s there their they them then than ' +
  'which who whom whose what when where while if because although though also just very ' +
  'has have had do does did will would shall should can could may might must ' +
  'into onto upon about over under after before such some any each both either ' +
  'i me my we our us you your he him his she her').split(/\s+/));
// Never faded or dropped: losing one of these flips the meaning of a sentence.
// (They are simply absent from FILLER; listed here so nobody adds them back.)
// not no nor neither never none nothing without

/**
 * Which words survive text compression. null = keep everything.
 *   'filler' drops function words (telegraph style) but never a sentence's
 *            last word, so punctuation and sentence ends survive.
 *   'topic'  keeps only the first sentence of the block.
 */
// Fine to fade, but dropping them changes logic: conditions, contrasts, comparisons.
const LOGIC_WORDS = new Set(['if', 'or', 'but', 'although', 'though', 'than', 'because', 'while', 'yet', 'must', 'may', 'might', 'should', 'can', 'could', 'would', 'will']);

export function compressKeep(words, mode) {
  if (mode === 'filler') {
    return words.map((w, i) => {
      if (i === words.length - 1 || /[.!?…;:]$/.test(w)) return true;
      const b = bare(w);
      return !FILLER.has(b) || LOGIC_WORDS.has(b);
    });
  }
  if (mode === 'topic') {
    let open = true;
    return words.map(w => { const k = open; if (open && endsSentence(w)) open = false; return k; });
  }
  return null;
}

// Words a phrase usually starts with: prepositions, conjunctions, relatives.
// Readers take text in at roughly phrase-sized fixations (about 3 words), so
// grouping on these boundaries matches how the eye already chunks a sentence.
const PHRASE_START = new Set(('of in on at to for with from by into onto about over under ' +
  'between through during without within after before since until across against among ' +
  'and but or nor so yet because although though while when whenever if unless that ' +
  'which who whom whose where than as like').split(/\s+/));

const bare = w => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Indices of words that end a phrase chunk. Pure — unit-testable. */
export function phraseEnds(words, maxLen = 4) {
  const ends = new Set();
  let len = 0;
  for (let i = 0; i < words.length; i++) {
    len++;
    const w = words[i];
    const next = words[i + 1];
    const punct = /[,;:—–.!?…)"”]$/.test(w);
    const nextStarts = next != null && PHRASE_START.has(bare(next));
    if (next == null || punct || len >= maxLen || (nextStarts && len >= 2)) { ends.add(i); len = 0; }
  }
  return ends;
}

/** Skim classes for one word: numbers, names/terms, filler. */
function skimClass(word, sentenceStart, isHeading) {
  const b = bare(word);
  if (/\p{N}/u.test(word)) return ' num';
  if (!isHeading && !sentenceStart) {
    const letters = word.replace(/[^\p{L}]/gu, '');
    // Capitalised mid-sentence (names, places, terms) or an acronym.
    if (letters.length >= 2 && /^\p{Lu}/u.test(letters) && b !== 'i') return ' nm';
  }
  if (FILLER.has(b)) return ' sw';
  return '';
}

const BLOCK_TAG = {
  h1: 'h1', h2: 'h2', h3: 'h3',
  p: 'p', li: 'li', quote: 'blockquote', pre: 'pre',
};

/** Abbreviations that end in "." without ending a sentence. */
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'eg', 'ie',
  'fig', 'figs', 'no', 'vol', 'ch', 'ed', 'eds', 'al', 'pp', 'cf', 'approx',
  'inc', 'ltd', 'co', 'dept', 'univ', 'ave', 'ref', 'refs', 'sec', 'min', 'max',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const TRAILING_QUOTES = /[")'\]}»”’]+$/;

function endsSentence(word) {
  const bare = word.replace(TRAILING_QUOTES, '');
  if (!/[.!?…]$/.test(bare)) return false;
  if (/[!?…]$/.test(bare)) return true;
  // "." needs more care: abbreviations and initials are not sentence ends.
  const stem = bare.slice(0, -1);
  if (/^[A-Z]$/.test(stem)) return false;                 // initials: "J."
  if (ABBREV.has(stem.toLowerCase().replace(/\./g, ''))) return false;
  if (/^\d+$/.test(stem)) return false;                   // list numbering: "1."
  return true;
}

function endsClause(word) {
  return /[,;:—–]$/.test(word.replace(TRAILING_QUOTES, ''));
}

/** Where the bolded prefix of a bionic word ends. */
export function bionicSplit(word, percent) {
  // Measure letters only, so "(don't)" bolds by its letters not its brackets.
  const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (!letters) return 0;
  const n = Math.max(1, Math.round((letters * percent) / 100));
  let seen = 0;
  for (let i = 0; i < word.length; i++) {
    if (/[\p{L}\p{N}]/u.test(word[i])) {
      seen++;
      if (seen >= n) return i + 1;
    }
  }
  return word.length;
}

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * The inner HTML of one word span, given the active decorations.
 * Returns a plain string when no decoration applies, which lets the caller use
 * the much cheaper textContent path.
 */
function wordHtml(word, s, isFirstOfSentence, isFirstOfParagraph) {
  const bionic = s.bionicOn && word.replace(/[^\p{L}\p{N}]/gu, '').length >= s.bionicMinLen;

  let firstLetter = false;
  if (s.firstLetterOn) {
    if (s.firstLetterScope === 'word') firstLetter = true;
    else if (s.firstLetterScope === 'sentence') firstLetter = isFirstOfSentence;
    else firstLetter = isFirstOfParagraph;
  }
  // Only decorate a real letter, and only when it isn't swallowed by bionic's
  // bold prefix (doubling both on one glyph looks broken).
  const firstIdx = firstLetter ? word.search(/[\p{L}\p{N}]/u) : -1;
  if (firstIdx < 0) firstLetter = false;

  if (!bionic && !firstLetter) return null;

  if (bionic) {
    const cut = bionicSplit(word, s.bionicPercent);
    let head = esc(word.slice(0, cut));
    const tail = esc(word.slice(cut));
    if (firstLetter && firstIdx < cut) {
      const a = esc(word.slice(0, firstIdx));
      const l = esc(word[firstIdx]);
      const b = esc(word.slice(firstIdx + 1, cut));
      head = `${a}<span class="fl">${l}</span>${b}`;
    }
    return `<b class="bi">${head}</b>${tail ? `<span class="bx">${tail}</span>` : ''}`;
  }

  const a = esc(word.slice(0, firstIdx));
  const l = esc(word[firstIdx]);
  const b = esc(word.slice(firstIdx + 1));
  return `${a}<span class="fl">${l}</span>${b}`;
}

/**
 * Render blocks into `container`, returning the word index.
 *
 * Rendering is synchronous per call but the caller may split `doc.blocks` into
 * chunks across frames; pass `startWord` to continue numbering.
 */
export function renderInto(container, blocks, settings, opts = {}) {
  const frag = document.createDocumentFragment();
  const spans = [];
  const text = [];
  const blockOf = [];
  const pageOf = [];
  const flags = [];
  const blockEls = [];
  let w = opts.startWord ?? 0;
  const b0 = opts.startBlock ?? 0;

  blocks.forEach((block, bLocal) => {
    // Index into the whole document, not this chunk: outline and autoscroll
    // look blocks up by it.
    const bi = b0 + bLocal;
    if (block.type === 'pagebreak') {
      if (settings.showPdfPageMarks) {
        const hr = document.createElement('div');
        hr.className = 'pagemark';
        hr.dataset.page = String(block.page);
        hr.setAttribute('aria-hidden', 'true');
        frag.appendChild(hr);
        blockEls.push(hr);
      }
      return;
    }

    if (block.type === 'figure') {
      if (settings.showFigures === false || !block.src) return;
      const fig = document.createElement('figure');
      fig.className = 'blk fig';
      fig.dataset.b = String(bi);
      fig.dataset.page = String(block.page ?? 0);
      const img = document.createElement('img');
      img.src = block.src;
      img.alt = `Figure from page ${block.page}`;
      img.decoding = 'async';
      // Natural size: 1pt = 4/3 CSS px, scaled with the reader's zoom.
      if (block.wPt > 0) img.style.setProperty('--fig-w', `${Math.round(block.wPt * 4 / 3)}px`);
      if (block.wPt > 0 && block.hPt > 0) img.style.aspectRatio = `${block.wPt} / ${block.hPt}`;
      fig.appendChild(img);
      frag.appendChild(fig);
      blockEls.push(fig);
      return;
    }

    const tag = BLOCK_TAG[block.type] || 'p';
    const el = document.createElement(tag);
    el.className = 'blk';
    el.dataset.b = String(bi);
    el.dataset.page = String(block.page ?? 0);
    if (block.type === 'li') el.classList.add('li');
    if (block.marker) el.dataset.marker = block.marker;

    const isHeading = tag === 'h1' || tag === 'h2' || tag === 'h3';
    const isProse = !isHeading && tag !== 'pre';
    const all = block.text.split(/\s+/).filter(Boolean);
    const allHrefs = Array.isArray(block.hrefs) && block.hrefs.length === all.length ? block.hrefs : null;
    const keep = isProse ? compressKeep(all, settings.compress) : null;
    const words = keep ? all.filter((_, k) => keep[k]) : all;
    const hrefs = allHrefs ? (keep ? allHrefs.filter((_, k) => keep[k]) : allHrefs) : null;
    if (!words.length) return;
    const ends = phraseEnds(words, settings.phraseMax ?? 4);

    // Sentence of each word, so the first and last sentence of a paragraph can
    // each be wrapped in one inline element. Styling the wrapper (not the
    // words) paints straight across the spaces, the way a highlighter does.
    const sentOf = new Int32Array(words.length);
    let ns = 0;
    for (let k = 0; k < words.length; k++) { sentOf[k] = ns; if (endsSentence(words[k]) && k < words.length - 1) ns++; }
    const lastSent = ns;
    const sentClass = s => {
      if (!isProse) return 'sn';
      if (s === 0) return 'sn fs';
      if (s === lastSent) return 'sn ls';
      return 'sn';
    };
    const kinds = words.map((wd, k) => skimClass(wd, k === 0 || (k > 0 && sentOf[k] !== sentOf[k - 1]), isHeading));
    const runKind = k => (kinds[k] === ' num' ? 'num' : kinds[k] === ' nm' ? 'nm' : '');

    let sent = null, link = null, run = null;
    let sentenceStart = true;

    words.forEach((word, wi) => {
      // Open the containers this word needs: sentence > link > key-word run.
      if (!sent) {
        sent = document.createElement('span');
        sent.className = sentClass(sentOf[wi]);
        el.appendChild(sent);
      }
      const href = hrefs ? hrefs[wi] : null;
      if (href && !link) {
        link = document.createElement('a');
        link.className = 'lnk';
        link.href = href;
        const pg = /^#page=(\d+)$/.exec(href);
        if (pg) link.dataset.page = pg[1];
        else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        sent.appendChild(link);
      }
      const rk = runKind(wi);
      if (rk && !run) {
        run = document.createElement('span');
        run.className = `kr ${rk}`;
        (link || sent).appendChild(run);
      }

      const span = document.createElement('span');
      span.dataset.i = String(w);
      let cls = 'w' + kinds[wi];
      const html = wordHtml(word, settings, sentenceStart, wi === 0);
      if (html === null) span.textContent = word;
      else span.innerHTML = html;
      (run || link || sent).appendChild(span);

      let f = 0;
      if (endsClause(word)) f |= FLAG.CLAUSE;
      if (endsSentence(word)) f |= FLAG.SENTENCE;
      if (wi === words.length - 1) f |= FLAG.PARA;
      if (isHeading) f |= FLAG.HEADING;
      if (word.replace(/[^\p{L}\p{N}]/gu, '').length >= 9) f |= FLAG.LONG;
      if (ends.has(wi)) { f |= FLAG.PHRASE; cls += ' pe'; }
      if (f & FLAG.SENTENCE && wi < words.length - 1) cls += ' se';
      span.className = cls;
      sentenceStart = !!(f & FLAG.SENTENCE);

      // Close what the next word doesn't share; the space goes in the
      // innermost container both words share, so highlights cover it.
      if (wi < words.length - 1) {
        const sameSent = sentOf[wi + 1] === sentOf[wi];
        const nextHref = hrefs ? hrefs[wi + 1] : null;
        const sameLink = sameSent && !!link && nextHref === href;
        const sameRun = sameSent && !!run && runKind(wi + 1) === rk && (sameLink || (!link && !nextHref));
        if (!sameRun) run = null;
        if (!sameLink) link = null;
        const space = document.createTextNode(' ');
        if (sameRun) run.appendChild(space);
        else if (sameLink) link.appendChild(space);
        else if (sameSent) sent.appendChild(space);
        else { sent = null; el.appendChild(space); }
      }

      spans.push(span);
      text.push(word);
      blockOf.push(bi);
      pageOf.push(block.page ?? 0);
      flags.push(f);
      w++;
    });

    frag.appendChild(el);
    blockEls.push(el);
  });

  container.appendChild(frag);
  return { spans, text, blockOf, pageOf, flags, blockEls };
}

/** Assemble chunked render results into the final immutable index. */
export function finishIndex(parts) {
  const spans = [];
  const text = [];
  const blockEls = [];
  let n = 0;
  for (const p of parts) n += p.spans.length;
  const blockOf = new Int32Array(n);
  const pageOf = new Int32Array(n);
  const flags = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    for (let i = 0; i < p.spans.length; i++) {
      spans.push(p.spans[i]);
      text.push(p.text[i]);
      blockOf[o] = p.blockOf[i];
      pageOf[o] = p.pageOf[i];
      flags[o] = p.flags[i];
      o++;
    }
    blockEls.push(...p.blockEls);
  }
  return { count: n, spans, text, blockOf, pageOf, flags, blockEls, FLAG };
}

/**
 * Rewrite word interiors after a decoration setting changed, without touching
 * the spans themselves — keeps the index, scroll position and any live pacer
 * state valid.
 */
export function redecorate(index, settings) {
  const { spans, text, flags } = index;
  let sentenceStart = true;
  for (let i = 0; i < spans.length; i++) {
    const isParaFirst = i === 0 || !!(flags[i - 1] & FLAG.PARA);
    if (isParaFirst) sentenceStart = true;
    const html = wordHtml(text[i], settings, sentenceStart, isParaFirst);
    const span = spans[i];
    if (html === null) {
      if (span.firstChild?.nodeType !== 3 || span.childNodes.length !== 1) {
        span.textContent = text[i];
      }
    } else {
      span.innerHTML = html;
    }
    sentenceStart = !!(flags[i] & FLAG.SENTENCE);
  }
}

/** Plain text of a range of words, for the RSVP box and copy support. */
export function sliceText(index, from, to) {
  return index.text.slice(Math.max(0, from), Math.max(0, to)).join(' ');
}
