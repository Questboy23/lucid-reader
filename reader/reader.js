/**
 * Reader orchestrator.
 *
 * Owns: loading the PDF, rendering the reflowed text, switching reading modes,
 * pagination, keyboard handling and the status/progress chrome. Every reading
 * aid itself lives in its own module under lib/ and is driven from here.
 */

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { DEFAULTS, SECTION_KEYS, BY_KEY } from './lib/schema.js';
import * as store from './lib/settings.js';
import { renderInto, finishIndex, redecorate, FLAG } from './lib/markup.js';
import { extractDocument, addFigures } from './lib/extract.js';
import { cacheKey, loadDoc, saveDoc } from './lib/cache.js';
import { createOverlay } from './lib/overlay.js';
import { Pacer } from './lib/pacer.js';
import { createReadAlong } from './lib/readalong.js';
import { createAutoScroll } from './lib/autoscroll.js';
import { createRsvp } from './lib/rsvp.js';
import { createFlow } from './lib/flow.js';
import { createOutline } from './lib/outline.js';
import { createSearch } from './lib/search.js';
import { detectFigures } from './lib/figures.js';
import { createPanel } from './panel.js';

// A plain web page can also expose a stub `chrome.runtime`, so the presence of
// getURL is what actually distinguishes "running as an extension". This is also
// what lets reader.html be served over http during development.
const RUNTIME = typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function'
  ? chrome.runtime
  : null;
const url = p => (RUNTIME ? RUNTIME.getURL(p) : `../${p}`);

pdfjs.GlobalWorkerOptions.workerSrc = url('vendor/pdfjs/pdf.worker.min.mjs');

const $ = id => document.getElementById(id);

const el = {
  app: $('app'),
  stage: $('stage'),
  scroller: $('scroller'),
  measure: $('measure'),
  doc: $('doc'),
  overlay: $('overlay'),
  pdfview: $('pdfview'),
  rsvp: $('rsvp'),
  panel: $('panel'),
  scrim: $('panel-scrim'),
  modes: $('modes'),
  title: $('doc-title'),
  sub: $('doc-sub'),
  progress: $('progress'),
  progressBar: $('progress').firstElementChild,
  statusLeft: $('status-left'),
  statusRight: $('status-right'),
  wpm: $('wpm'),
  welcome: $('welcome'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  loadingBar: $('loading-bar').firstElementChild,
  error: $('error'),
  errorTitle: $('error-title'),
  errorMsg: $('error-msg'),
  dropzone: $('dropzone'),
  toast: $('toast'),
  shortcuts: $('shortcuts'),
  railL: $('rail-l'),
  railR: $('rail-r'),
  fileInput: $('file-input'),
};

/** Everything mutable about the current session. */
const state = {
  settings: { ...DEFAULTS },
  doc: null,          // Doc from extract.js
  index: null,        // WordIndex from markup.js
  mode: 'normal',
  word: 0,
  source: null,       // { kind:'url'|'file', url?, file?, name }
  docId: null,
  pdf: null,          // PDFDocumentProxy, kept for the original-PDF view
  pageBreaks: null,   // paginated mode: array of scrollTop offsets
  page: 0,
  pdfRendered: false,
  ready: false,
};

let overlay = null;
let pacer = null;
let readalong = null;
let autoscroll = null;
let rsvp = null;
let flow = null;
let outline = null;
let search = null;
let panel = null;

/** Canvas + encoder for figure capture; blob URLs keep figures out of the JS heap. */
const figureCapture = {
  detect: detectFigures,
  OPS: pdfjs.OPS,
  createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  },
  encode(c) {
    return new Promise((resolve, reject) => {
      c.toBlob(b => {
        if (!b) { reject(new Error('encode failed')); return; }
        const u = URL.createObjectURL(b);
        figureBlobs.set(u, b);      // kept for the document cache
        resolve(u);
      }, 'image/png');
    });
  },
};
let figureUrls = [];
const figureBlobs = new Map();
let figureJob = null;
const timings = {};

/* ------------------------------------------------------------------ misc --- */

let toastTimer = 0;
function toast(msg, ms = 1900) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function showLoading(text, frac) {
  el.loading.hidden = false;
  if (text) el.loadingText.textContent = text;
  el.loadingBar.style.width = `${Math.round((frac ?? 0) * 100)}%`;
}
const hideLoading = () => { el.loading.hidden = true; };

function showError(title, msg) {
  hideLoading();
  el.errorTitle.textContent = title;
  el.errorMsg.textContent = msg;
  el.error.hidden = false;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const fmt = n => n.toLocaleString();

/* ------------------------------------------------------- source resolution */

/**
 * The takeover redirect substitutes the raw PDF URL after `?file=`, which may
 * itself contain `&` and `=`. So the query is read positionally rather than
 * with URLSearchParams, and only decoded when it actually looks encoded.
 */
function sourceFromLocation() {
  const q = location.search;
  const i = q.indexOf('file=');
  if (i < 0) return null;
  let raw = q.slice(i + 5);
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  }
  if (!raw) return null;
  // A fragment like #page=3 belongs to the PDF, not to this page.
  const base = raw.split(/[?#]/)[0].split('/').pop() || 'document.pdf';
  let name = base;
  try { name = decodeURIComponent(base); } catch { /* a stray % in the name */ }
  return { kind: 'url', url: raw, name };
}

function requestedPage() {
  const m = /[#&?]page=(\d+)/.exec(location.hash);
  return m ? parseInt(m[1], 10) : null;
}

async function bytesFor(source) {
  if (source.kind === 'file') return new Uint8Array(await source.file.arrayBuffer());
  try {
    const r = await fetch(source.url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    // CORS or file:// — the service worker has wider reach than this page.
    if (!RUNTIME) throw e;
    const res = await RUNTIME.sendMessage({ type: 'fetch-pdf', url: source.url })
      .catch(() => null);
    if (res?.ok && res.b64) {
      const bin = atob(res.b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (res?.ok) return new Uint8Array(res.data);
    if (source.url.startsWith('file:')) {
      throw new Error(
        'Chrome blocks extensions from reading local files until you allow it. '
        + 'Open chrome://extensions, click Details on Lucid Reader, and turn on '
        + '"Allow access to file URLs" — or just choose the file below.');
    }
    throw new Error(res?.error || (e && e.message) || 'Could not download the PDF.');
  }
}

/* ------------------------------------------------------------------ load --- */

async function open(source) {
  state.source = source;
  state.docId = hash(source.kind === 'url' ? source.url : `${source.name}:${source.file.size}`);
  el.welcome.hidden = true;
  el.error.hidden = true;
  el.title.textContent = source.name;
  document.title = `${source.name} — Lucid Reader`;
  showLoading('Downloading…', 0.05);

  try {
    const data = await bytesFor(source);
    showLoading('Reading the PDF…', 0.15);

    const task = pdfjs.getDocument({
      data,
      cMapUrl: url('vendor/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: url('vendor/pdfjs/standard_fonts/'),
      isEvalSupported: false,       // MV3 CSP forbids eval in the worker
      useWorkerFetch: false,
    });
    task.onProgress = ({ loaded, total }) => {
      if (total) showLoading('Reading the PDF…', 0.15 + 0.15 * (loaded / total));
    };
    const pdf = await task.promise;
    state.pdf = pdf;

    const meta = await pdf.getMetadata().catch(() => null);
    const metaTitle = meta?.info?.Title?.trim();

    showLoading('Extracting text…', 0.35);
    for (const u of figureUrls) URL.revokeObjectURL(u);
    figureUrls = [];
    figureBlobs.clear();
    figureJob?.abort();
    const t0 = performance.now();
    const key = cacheKey(pdf.fingerprints?.[0]);
    const cached = await loadDoc(key);
    let doc;
    if (cached) {
      doc = cached.doc;
      figureUrls = cached.urls;
    } else {
      // Text first, so reading can start; figures follow in the background.
      doc = await extractDocument(pdf, {
        fallbackTitle: metaTitle || source.name,
        onProgress: (done, total) => {
          showLoading(`Extracting text… page ${done} of ${total}`, 0.35 + 0.45 * (done / total));
        },
      });
    }
    state.doc = doc;
    timings.extract = Math.round(performance.now() - t0);
    timings.cached = !!cached;

    if (metaTitle) el.title.textContent = metaTitle;
    el.sub.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;

    if (!doc.blocks.length) {
      hideLoading();
      setMode('pdf');
      toast('This PDF has no text layer — showing the original pages.', 5000);
      el.sub.textContent = `${doc.numPages} pages · scanned, no text`;
      state.ready = true;
      return;
    }

    showLoading('Laying out…', 0.85);
    const t1 = performance.now();
    await render();
    timings.render = Math.round(performance.now() - t1);
    hideLoading();
    state.ready = true;

    // Mode first, then position: setMode() derives a word from the viewport
    // when entering a paced mode, which would otherwise discard the restore.
    setMode(state.settings.defaultMode);
    await restorePosition();
    updateStatus();
    console.info('[lucid] opened', { words: state.index?.count, ...timings });

    if (!cached) startFigurePass(pdf, doc, key);
  } catch (e) {
    console.error('[lucid] open failed', e);
    // Some sites (download mirrors, expiring links) refuse a second download.
    // Hand the link back to Chrome so the PDF still opens or downloads.
    const msg = String(e?.message || e);
    if (source.kind === 'url' && /^https?:/.test(source.url) && !state.ready
        && /fetch|HTTP|network|download/i.test(msg)) {
      showLoading('Lucid could not load this one. Opening it normally…', 1);
      try { await RUNTIME?.sendMessage({ type: 'bypass-once' }); } catch { /* still try */ }
      location.replace(source.url);
      return;
    }
    showError('Could not open this PDF', msg);
  }
}

/* --------------------------------------------------------------- figures --- */

/**
 * Background figure capture. Runs after the text is on screen, yields to the
 * page between PDF pages, then swaps in the figure-bearing document once,
 * keeping the reader on the same page and word. While a pacer is playing the
 * swap waits for the next pause so the text never jumps under the reader.
 */
let lastInput = 0;
for (const type of ['pointerdown', 'keydown', 'wheel', 'input', 'touchstart']) {
  window.addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
}

function startFigurePass(pdf, doc, key) {
  if (state.settings.showFigures === false) { saveDoc(key, doc, () => null); return; }
  const ctrl = new AbortController();
  figureJob = ctrl;
  // Each page scan blocks the tab for up to a few hundred ms, and a book has
  // hundreds. The scan waits while the settings panel is open, while a paced
  // mode is playing, and for 1.5 s after any click, key, scroll or slider move,
  // so changes and scrolling never queue behind it.
  const busy = () => performance.now() - lastInput < 1500
    || el.app.classList.contains('panel-open')
    || !!pacer?.playing;
  const idle = async () => {
    while (busy() && !ctrl.signal.aborted) await new Promise(r => setTimeout(r, 300));
    await new Promise(r => (window.requestIdleCallback
      ? requestIdleCallback(() => r(), { timeout: 120 })
      : setTimeout(r, 16)));
  };
  (async () => {
    const t0 = performance.now();
    const next = await addFigures(pdf, doc, figureCapture, {
      signal: ctrl.signal,
      between: idle,
      onProgress: (done, total) => { el.sub.textContent = `${doc.numPages} pages · finding figures ${Math.round(100 * done / total)}%`; },
    });
    el.sub.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
    timings.figures = Math.round(performance.now() - t0);
    console.info('[lucid] figure pass', { ms: Math.round(performance.now() - t0), figures: next ? next.blocks.filter(b => b.type === 'figure').length : 0 });
    if (ctrl.signal.aborted || state.doc !== doc) return;
    if (!next) { saveDoc(key, doc, () => null); return; }
    while (pacer?.playing) await new Promise(r => setTimeout(r, 400));
    if (ctrl.signal.aborted || state.doc !== doc) return;
    figureUrls = next.blocks.filter(b => b.type === 'figure').map(b => b.src);
    const scrolled = state.mode === 'normal' || state.mode === 'pdf';
    const at = anchorOfWord(scrolled ? wordAtViewportCentre() : state.word);
    state.doc = next;
    await render();
    seekTo(wordOfAnchor(at));
    saveDoc(key, next, src => figureBlobs.get(src));
  })().catch(e => { if (!ctrl.signal.aborted) console.warn('[lucid] figure pass failed', e); });
}

/** A position that survives re-rendering: PDF page plus the fraction through its words. */
function anchorOfWord(i) {
  const idx = state.index;
  if (!idx?.count) return null;
  const p = idx.pageOf[i];
  let a = i, z = i;
  while (a > 0 && idx.pageOf[a - 1] === p) a--;
  while (z < idx.count - 1 && idx.pageOf[z + 1] === p) z++;
  return { page: p, frac: (i - a) / Math.max(1, z - a + 1) };
}
function wordOfAnchor(at) {
  const idx = state.index;
  if (!at || !idx?.count) return 0;
  let a = idx.pageOf.indexOf(at.page);
  if (a < 0) return Math.min(state.word, idx.count - 1);
  let z = a;
  while (z < idx.count - 1 && idx.pageOf[z + 1] === at.page) z++;
  return a + Math.floor(at.frac * (z - a + 1));
}

/* ---------------------------------------------------------------- render --- */

const CHUNK = 400; // blocks per frame

async function render() {
  el.doc.textContent = '';
  const parts = [];
  const blocks = state.doc.blocks;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    parts.push(renderInto(el.doc, blocks.slice(i, i + CHUNK), state.settings,
      { startWord: parts.reduce((n, p) => n + p.spans.length, 0), startBlock: i }));
    // Hidden tabs get no animation frames, so a background tab would stall here.
    if (blocks.length > CHUNK) await new Promise(r => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(r)));
  }
  state.index = finishIndex(parts);

  buildEngines();
  outline?.rebuild();
  search?.refresh();
  // Webfonts can land after first layout; re-measure when they do.
  document.fonts.ready.then(() => { relayout(); });
  relayout();
}

function buildEngines() {
  overlay?.destroy();
  readalong?.destroy();
  autoscroll?.destroy();
  rsvp?.destroy();
  pacer?.stop();

  const getSettings = () => state.settings;

  overlay = createOverlay({
    host: el.overlay, doc: el.doc, index: state.index, getSettings,
  });

  // Paginated reading and follow-scrolling are mutually exclusive: the pacer
  // must not scroll a page that is meant to sit still, so pages are turned
  // from onWord() instead.
  const readAlongSettings = () => (state.settings.paginated
    ? { ...state.settings, pacerFollow: false }
    : state.settings);

  readalong = createReadAlong({
    index: state.index, doc: el.doc, scroller: el.scroller, overlay,
    getSettings: readAlongSettings,
    onSeek: i => {
      state.word = i;
      pacer.seek(i);
      if (state.mode === 'rsvp') rsvp.setWord(i);
      onWord(i);
    },
  });

  autoscroll = createAutoScroll({
    scroller: el.scroller, index: state.index, overlay, getSettings,
  });

  rsvp = createRsvp({ host: el.rsvp, index: state.index, getSettings });

  flow?.destroy();
  flow = createFlow({
    index: state.index, doc: el.doc, scroller: el.scroller, stage: el.stage, overlay, getSettings,
    onUserScroll: () => { pacer?.pause(); toast('Paused: press Space to resume'); },
  });
  if (state.mode === 'flow') flow.start();

  pacer = new Pacer({
    index: state.index, getSettings,
    onWord,
    onStateChange: s => {
      flow?.setPlaying(state.mode === 'flow' && !!s.playing);
      el.app.classList.toggle('playing', !!s.playing);
      if (s.done) toast('End of document');
      updateStatus();
    },
  });
}

/** One place that every engine's per-word tick funnels through. */
function onWord(i) {
  state.word = i;
  if (state.mode === 'readalong' || (state.mode === 'autoscroll' && !state.settings.autoScrollHideWord)) {
    readalong.setWord(i);
  }
  if (state.mode === 'rsvp') rsvp.setWord(i);
  if (state.mode === 'flow') flow?.setWord(i, pacer?.durationFor ? pacer.durationFor(i) : 0);
  if (state.settings.paginated && state.mode !== 'rsvp' && state.mode !== 'flow') turnToPageOfWord(i);
  overlay?.update(overlayState());
  outlineSoon();
  updateProgress();
  schedulePositionSave();
}

/** In paginated mode the pacer turns pages rather than scrolling. */
function turnToPageOfWord(i) {
  if (!state.pageBreaks || !overlay) return;
  const line = overlay.lineOfWord(i);
  const rect = line >= 0 ? overlay.lineRect(line) : null;
  if (!rect) return;
  let p = 0;
  for (let n = 0; n < state.pageBreaks.length; n++) {
    if (state.pageBreaks[n] <= rect.top + 1) p = n; else break;
  }
  if (p !== state.page) goToPage(p);
}

function overlayState() {
  return {
    mode: state.mode,
    wordIndex: state.word,
    playing: !!pacer?.playing,
    scrollTop: el.scroller.scrollTop,
    viewportHeight: el.scroller.clientHeight,
  };
}

/* -------------------------------------------------------------- settings --- */

function applySettings(changed) {
  const s = state.settings;
  store.applyCssVars(document.documentElement, s);

  if (el.outline) el.outline.hidden = !s.outlineOpen;
  el.app.classList.toggle('outline-open', s.outlineOpen);
  if (s.outlineOpen) outline?.onSettings(changed);
  el.app.classList.toggle('rails', s.railsOn);
  el.app.classList.toggle('paginated', s.paginated);
  el.app.classList.toggle('paper', !!s.pageLook && !s.paginated);
  el.app.classList.toggle('pacer-nobg', !s.pacerBackground);
  el.app.classList.toggle('pacer-underline', s.pacerUnderline);
  el.app.classList.toggle('pacer-tint', s.pacerTintText);
  el.app.classList.toggle('reduce-motion', s.reduceMotion);
  el.app.classList.toggle('hide-word', state.mode === 'autoscroll' && s.autoScrollHideWord);
  if (el.wpm.value !== String(s.wpm)) el.wpm.value = String(s.wpm);

  if (!state.index) return;

  const keys = changed ?? Object.keys(s);
  const needsRedecorate = keys.some(k => [
    'bionicOn', 'bionicPercent', 'bionicMinLen',
    'firstLetterOn', 'firstLetterScope',
  ].includes(k));
  const needsRerender = keys.some(k => ['showPdfPageMarks', 'pageLook', 'showFigures', 'compress', 'phraseMax'].includes(k));
  if (keys.some(k => k.startsWith('flow') || k === 'bg' || k === 'textContrast')) flow?.refresh();

  if (needsRerender) {
    const at = state.word;
    render().then(() => { seekTo(at); });
    return;
  }
  if (needsRedecorate) { redecorateProgressive(s); return; }
  relayout();
}

/**
 * Bionic and first-letter styles rewrite every word. The words on screen are
 * rewritten first, in the same frame; the rest of the book follows in
 * background slices, so the change shows at once instead of after every word.
 */
let redecorateJob = 0;
function redecorateProgressive(s) {
  const idx = state.index;
  const job = ++redecorateJob;
  const n = idx.count;
  const centre = state.mode === 'normal' || state.mode === 'pdf' ? wordAtViewportCentre() : state.word;
  const lo = Math.max(0, centre - 1500), hi = Math.min(n, centre + 1500);
  redecorate(idx, s, lo, hi);
  relayout();
  const rest = [];
  for (let a = hi; a < n; a += 4000) rest.push([a, Math.min(n, a + 4000)]);
  for (let z = lo; z > 0; z -= 4000) rest.push([Math.max(0, z - 4000), z]);
  const step = () => {
    if (job !== redecorateJob || state.index !== idx) return;
    const r = rest.shift();
    if (!r) { relayout(); return; }
    redecorate(idx, state.settings, r[0], r[1]);
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

let outlineTimer = 0;
function outlineSoon() {
  if (outlineTimer || !state.settings.outlineOpen) return;
  outlineTimer = setTimeout(() => { outlineTimer = 0; outline?.update(); }, 250);
}

/**
 * Re-measure everything that depends on layout. Bursts (a slider being
 * dragged with instant apply) collapse into one measure 90 ms after the last
 * call, because measuring a whole book takes tens of milliseconds.
 */
let relayoutPending = false;
let relayoutTimer = 0;
function relayout() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayoutNow, relayoutPending ? 90 : 0);
  relayoutPending = true;
}
function relayoutNow() {
  requestAnimationFrame(() => {
    relayoutPending = false;
    if (!state.index) return;
    overlay?.measure();
    overlay?.update(overlayState());
    positionRails();
    computePageBreaks();
    if (state.settings.paginated) goToPage(state.page, true);
    if (state.mode === 'flow') flow?.refresh();
    updateStatus();
  });
}

/* ------------------------------------------------------------------ mode --- */

const MODES = ['normal', 'readalong', 'autoscroll', 'flow', 'rsvp', 'pdf'];

function setMode(mode) {
  if (!MODES.includes(mode)) mode = 'normal';
  if (mode !== 'pdf' && !state.index) mode = state.doc && !state.doc.blocks.length ? 'pdf' : mode;

  // Hand the reading position over from whatever engine was driving.
  if (state.mode === 'autoscroll' && autoscroll) {
    const w = autoscroll.currentWord();
    if (Number.isFinite(w)) state.word = w;
  }

  pacer?.pause();
  autoscroll?.stop();
  const prev = state.mode;
  state.mode = mode;
  el.app.dataset.mode = mode;
  el.app.classList.remove('playing');
  for (const b of el.modes.children) {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  }
  el.app.classList.toggle('hide-word', mode === 'autoscroll' && state.settings.autoScrollHideWord);

  if (mode === 'rsvp') rsvp?.show(); else rsvp?.hide();
  el.pdfview.hidden = mode !== 'pdf';
  if (mode === 'flow') { readalong?.clear(); flow?.start(); } else flow?.stop();

  if (mode === 'normal') {
    readalong?.clear();
  } else if (mode === 'readalong' || mode === 'rsvp' || mode === 'autoscroll' || mode === 'flow') {
    // Entering a paced mode from a scroll-driven one: start from what's on screen.
    if (prev === 'normal' || prev === 'pdf') {
      const w = wordAtViewportCentre();
      if (Number.isFinite(w)) state.word = w;
    }
    pacer?.seek(state.word);
    if (mode === 'rsvp') rsvp.setWord(state.word);
    else if (mode === 'readalong') readalong.setWord(state.word);
    else if (mode === 'flow') flow?.setWord(state.word, 0);
    if (mode === 'autoscroll') autoscroll.setFromWord(state.word);
  }

  if (mode === 'pdf') renderPdfView();
  overlay?.update(overlayState());
  updateStatus();
}

function wordAtViewportCentre() {
  if (!overlay || !state.index) return state.word;
  const mid = el.scroller.scrollTop + el.scroller.clientHeight * 0.35;
  const n = overlay.lineCount();
  for (let i = 0; i < n; i++) {
    const r = overlay.lineRect(i);
    if (r && r.bottom >= mid) return overlay.wordRangeOfLine(i)[0];
  }
  return state.word;
}

function togglePlay() {
  if (!pacer) return;   // scanned PDF: nothing to pace
  if (state.mode === 'normal' || state.mode === 'pdf') {
    setMode('readalong');
    pacer.play();
    return;
  }
  if (state.mode === 'autoscroll') {
    if (autoscroll.running()) autoscroll.stop();
    else autoscroll.start();
    el.app.classList.toggle('playing', autoscroll.running());
    tickAutoScroll();
    return;
  }
  pacer.toggle();
}

/** While auto-scrolling, keep the overlay/status in step with the scroll. */
let autoTick = 0;
function tickAutoScroll() {
  cancelAnimationFrame(autoTick);
  const loop = () => {
    if (state.mode !== 'autoscroll' || !autoscroll.running()) {
      el.app.classList.remove('playing');
      return;
    }
    const w = autoscroll.currentWord();
    if (Number.isFinite(w)) {
      state.word = w;
      if (!state.settings.autoScrollHideWord) readalong.setWord(w);
      overlay?.update(overlayState());
      updateProgress();
    }
    autoTick = requestAnimationFrame(loop);
  };
  autoTick = requestAnimationFrame(loop);
}

function seekTo(i) {
  const w = Math.max(0, Math.min((state.index?.count ?? 1) - 1, i | 0));
  state.word = w;
  pacer?.seek(w);
  if (state.mode === 'rsvp') rsvp.setWord(w);
  else if (state.mode !== 'normal' && state.mode !== 'flow') readalong.setWord(w);
  scrollWordIntoView(w);
  onWord(w);
}

function scrollWordIntoView(i) {
  const span = state.index?.spans[i];
  if (!span) return;
  if (state.settings.paginated) { turnToPageOfWord(i); return; }
  // offsetTop is relative to #doc, which is not the scroll container; measuring
  // against the scroller's own box avoids having to chase offsetParents.
  const top = span.getBoundingClientRect().top
    - el.scroller.getBoundingClientRect().top + el.scroller.scrollTop;
  el.scroller.scrollTo({
    top: Math.max(0, top - el.scroller.clientHeight * (state.settings.pacerAnchor / 100)),
    behavior: state.settings.reduceMotion ? 'auto' : 'smooth',
  });
}

/* ------------------------------------------------------------ pagination --- */

function computePageBreaks() {
  state.pageBreaks = null;
  if (!state.settings.paginated || !overlay || !state.index) return;
  const n = overlay.lineCount();
  if (!n) return;

  const viewport = el.scroller.clientHeight;
  const breaks = [0];
  const wpp = state.settings.wordsPerPage;

  if (wpp > 0) {
    let nextWord = wpp;
    for (let i = 0; i < n; i++) {
      const [first] = overlay.wordRangeOfLine(i);
      if (first >= nextWord) {
        breaks.push(Math.max(0, overlay.lineRect(i).top - 4));
        nextWord += wpp;
      }
    }
  } else {
    let pageTop = 0;
    for (let i = 0; i < n; i++) {
      const r = overlay.lineRect(i);
      if (!r) continue;
      if (r.bottom - pageTop > viewport - 8) {
        pageTop = Math.max(0, r.top - 4);
        breaks.push(pageTop);
      }
    }
  }
  state.pageBreaks = breaks;
  state.page = Math.min(state.page, breaks.length - 1);
}

function goToPage(n, silent) {
  if (!state.pageBreaks) return;
  const p = Math.max(0, Math.min(state.pageBreaks.length - 1, n));
  state.page = p;
  el.scroller.scrollTop = state.pageBreaks[p];
  overlay?.update(overlayState());
  if (!silent) updateStatus();
}

/* ------------------------------------------------------------ PDF pages --- */

async function renderPdfView() {
  if (!state.pdf || state.pdfRendered) return;
  state.pdfRendered = true;
  el.pdfview.textContent = '';

  const width = Math.min(1100, el.stage.clientWidth - 40);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pending = [];

  for (let p = 1; p <= state.pdf.numPages; p++) {
    const ph = document.createElement('div');
    ph.className = 'pdfpage-ph';
    ph.style.width = `${width}px`;
    ph.style.height = `${Math.round(width * 1.3)}px`;
    el.pdfview.appendChild(ph);
    pending.push([p, ph]);
  }

  // Render lazily: a 400-page PDF must not rasterise all at once.
  const io = new IntersectionObserver(async entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const ph = e.target;
      io.unobserve(ph);
      const p = Number(ph.dataset.p);
      try {
        const page = await state.pdf.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const vp = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement('canvas');
        canvas.className = 'pdfpage';
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${width}px`;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        ph.replaceWith(canvas);
      } catch (err) {
        console.warn('[lucid] page render failed', p, err);
        ph.textContent = `Page ${p} could not be rendered`;
      }
    }
  }, { root: el.pdfview, rootMargin: '600px 0px' });

  for (const [p, ph] of pending) {
    ph.dataset.p = String(p);
    io.observe(ph);
  }
}

/* ----------------------------------------------------------------- rails --- */

function positionRails() {
  const m = el.measure.getBoundingClientRect();
  const d = el.doc.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--r-rail-gap')) || 16;
  el.railL.style.left = `${Math.max(0, d.left - m.left - gap)}px`;
  el.railR.style.left = `${Math.min(m.width, d.right - m.left + gap)}px`;
  const paper = document.getElementById('paper');
  if (paper) {
    paper.style.left = `${d.left - m.left}px`;
    paper.style.top = `${d.top - m.top}px`;
    paper.style.width = `${d.width}px`;
    paper.style.height = `${d.height}px`;
  }
}

/** Width of one "0" in the current reading font, for ch <-> px conversion. */
function chPx() {
  const probe = document.createElement('span');
  probe.textContent = '0'.repeat(20);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  el.doc.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  return w || 10;
}

function initRailDrag() {
  let drag = null;
  for (const grip of document.querySelectorAll('.grip')) {
    grip.addEventListener('pointerdown', e => {
      drag = {
        x: e.clientX,
        edge: grip.dataset.edge,
        startCh: state.settings.columnWidth,
        ch: chPx(),
      };
      grip.setPointerCapture(e.pointerId);
      el.app.classList.add('resizing');
      e.preventDefault();
    });
    grip.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) * (drag.edge === 'l' ? -1 : 1);
      // The column is centred, so a drag widens it on both sides.
      const next = Math.round(drag.startCh + (dx * 2) / drag.ch);
      const clamped = Math.max(BY_KEY.columnWidth.min, Math.min(BY_KEY.columnWidth.max, next));
      if (clamped !== state.settings.columnWidth) {
        state.settings = { ...state.settings, columnWidth: clamped };
        store.applyCssVars(document.documentElement, state.settings);
        positionRails();
      }
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      el.app.classList.remove('resizing');
      store.save({ columnWidth: state.settings.columnWidth });
      panel?.refresh();
      relayout();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }
}

/* ---------------------------------------------------------------- status --- */

function updateProgress() {
  const n = state.index?.count ?? 0;
  if (!n) { el.progressBar.style.width = '0%'; return; }
  const frac = state.mode === 'normal' || state.mode === 'pdf'
    ? scrollFraction()
    : state.word / Math.max(1, n - 1);
  el.progressBar.style.width = `${(frac * 100).toFixed(2)}%`;
  el.progress.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
}

function scrollFraction() {
  const max = el.scroller.scrollHeight - el.scroller.clientHeight;
  return max > 0 ? el.scroller.scrollTop / max : 0;
}

function updateStatus() {
  const n = state.index?.count ?? 0;
  if (!n) {
    el.statusLeft.textContent = state.doc ? `${state.doc.numPages} pages · no text layer` : '';
    el.statusRight.textContent = '';
    updateProgress();
    return;
  }

  const page = state.index.pageOf[Math.min(state.word, n - 1)] || 1;
  const bits = [`page ${page} of ${state.doc.numPages}`, `${fmt(n)} words`];
  if (state.settings.paginated && state.pageBreaks) {
    bits.unshift(`screen ${state.page + 1} of ${state.pageBreaks.length}`);
  }
  el.statusLeft.textContent = bits.join(' · ');

  // In scroll-driven modes the position is wherever the reader has scrolled to.
  const scrolled = state.mode === 'normal' || state.mode === 'pdf';
  const from = scrolled ? Math.round(scrollFraction() * n) : state.word;
  const left = Math.max(0, n - from);
  const pct = `${Math.round((from / n) * 100)}%`;
  if (!state.settings.showTimeLeft) {
    el.statusRight.textContent = scrolled ? pct : `${fmt(left)} words left`;
  } else {
    // Same pause-aware timing as the pacer and the Contents panel, so the numbers agree.
    const ms = pacer?.remainingMs ? pacer.remainingMs(from) : (left / state.settings.wpm) * 60000;
    let txt = `${pct} · done in ${fmtDuration(ms)} at ${state.settings.wpm} wpm`;
    if (state.settings.timeLeftClock && ms > 60000) {
      const end = new Date(Date.now() + ms);
      const sameDay = end.toDateString() === new Date().toDateString();
      const clock = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      txt += ` (${sameDay ? clock : `${end.toLocaleDateString([], { weekday: 'short' })} ${clock}`})`;
    }
    el.statusRight.textContent = txt;
  }
  updateProgress();
  outlineSoon();
}

/** 95 min -> "1 h 35 m"; under a minute -> "<1 m". */
function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1 m';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m`;
}

/* -------------------------------------------------------------- position --- */

let posTimer = 0;
function schedulePositionSave() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    store.savePosition(state.docId, { word: state.word, mode: state.mode });
  }, 1200);
}

async function restorePosition() {
  if (!state.settings.rememberPosition) return;
  const wantPage = requestedPage();
  if (wantPage && state.index) {
    const i = state.index.pageOf.indexOf(wantPage);
    if (i >= 0) { seekTo(i); return; }
  }
  const pos = await store.loadPosition(state.docId);
  if (!pos || !state.index) return;
  if (pos.word > 5 && pos.word < state.index.count) {
    seekTo(pos.word);
    toast('Picked up where you left off');
  }
}

/* -------------------------------------------------------------- keyboard --- */

function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function onKey(e) {
  // Cmd/Ctrl+F opens the reader's own search: the browser's would only see the
  // visible part of the page and none of the PDF's original layout.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); search?.open(); return; }
  if (!state.settings.keyboardShortcuts) return;
  if (isTyping(e.target)) return;

  if (e.key === 'Escape') {
    if (!el.shortcuts.hidden) { el.shortcuts.hidden = true; return; }
    if (panel?.isOpen()) { panel.close(); return; }
  }
  // With the drawer open, shortcuts still work unless a drawer control has focus.
  if (panel?.isOpen() && el.panel.contains(e.target) && e.key !== 's' && e.key !== 'S') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const paged = state.settings.paginated && state.mode !== 'pdf' && state.mode !== 'rsvp';

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (state.mode === 'normal' || state.mode === 'pdf') {
        paged ? goToPage(state.page + 1) : el.scroller.scrollBy({ top: 200 });
      } else { pacer.step(e.shiftKey ? 10 : 1); }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (state.mode === 'normal' || state.mode === 'pdf') {
        paged ? goToPage(state.page - 1) : el.scroller.scrollBy({ top: -200 });
      } else { pacer.step(e.shiftKey ? -10 : -1); }
      break;
    case 'ArrowDown':
      if (state.mode === 'readalong' || state.mode === 'rsvp') {
        e.preventDefault();
        pacer.stepLine(1, overlay);
      } else if (paged) { e.preventDefault(); goToPage(state.page + 1); }
      break;
    case 'ArrowUp':
      if (state.mode === 'readalong' || state.mode === 'rsvp') {
        e.preventDefault();
        pacer.stepLine(-1, overlay);
      } else if (paged) { e.preventDefault(); goToPage(state.page - 1); }
      break;
    case 'PageDown':
      if (paged) { e.preventDefault(); goToPage(state.page + 1); }
      break;
    case 'PageUp':
      if (paged) { e.preventDefault(); goToPage(state.page - 1); }
      break;
    case 'Home':
      e.preventDefault();
      paged ? goToPage(0) : seekTo(0);
      break;
    case 'End':
      e.preventDefault();
      if (paged) goToPage((state.pageBreaks?.length ?? 1) - 1);
      else seekTo((state.index?.count ?? 1) - 1);
      break;
    case 'j': case 'J':
      bumpWpm(-state.settings.wpmStep);
      break;
    case 'k': case 'K':
      bumpWpm(+state.settings.wpmStep);
      break;
    case '1': setMode('normal'); break;
    case '2': setMode('readalong'); break;
    case '3': setMode('autoscroll'); break;
    case '4': setMode('flow'); break;
    case '5': setMode('rsvp'); break;
    case '6': setMode('pdf'); break;
    case 'f': case 'F':
      setMode('flow');
      pacer?.play();
      break;
    case '/':
      e.preventDefault();
      search?.open();
      break;
    case 'o': case 'O':
      store.save({ outlineOpen: !state.settings.outlineOpen });
      break;
    case 't': case 'T':
      store.save({ showTimeLeft: !state.settings.showTimeLeft });
      break;
    case 's': case 'S':
      e.preventDefault();
      panel.toggle();
      break;
    case 'b': case 'B':
      store.save({ bionicOn: !state.settings.bionicOn });
      toast(state.settings.bionicOn ? 'Bionic off' : 'Bionic on');
      break;
    case 'd': case 'D':
      store.save({ dimOn: !state.settings.dimOn });
      toast(state.settings.dimOn ? 'Dim off' : 'Dim on');
      break;
    case 'p': case 'P':
      store.save({ paginated: !state.settings.paginated });
      break;
    case '?':
      el.shortcuts.hidden = !el.shortcuts.hidden;
      break;
    default:
      break;
  }
}

function bumpWpm(d) {
  const next = Math.max(60, Math.min(1200, state.settings.wpm + d));
  if (next === state.settings.wpm) return;
  store.save({ wpm: next });
  toast(`${next} wpm`);
}

/* --------------------------------------------------------------- wiring --- */

function buildShortcutsCard() {
  const rows = [
    ['Space', 'Play / pause'],
    ['← →', 'Previous / next word (Shift: ten)'],
    ['↑ ↓', 'Previous / next line'],
    ['J K', 'Slower / faster'],
    ['1 – 6', 'Normal · Read-along · Auto-scroll · Flow · RSVP · Original PDF'],
    ['F', 'Start Flow (read-along + scroll)'],
    ['T', 'Show or hide the "done in" estimate'],
    ['O', 'Contents panel (chapters, timings)'],
    ['⌘F /', 'Search the document'],
    ['S', 'Reading settings'],
    ['B', 'Toggle bionic'],
    ['D', 'Toggle dim mode'],
    ['P', 'Toggle paginated'],
    ['Home End', 'Start / end'],
    ['?', 'This list'],
  ];
  el.shortcuts.innerHTML = `<div class="sc-card"><h2>Keyboard shortcuts</h2><dl>${
    rows.map(([k, v]) => `<dt>${k.split(' ').map(x => `<kbd>${x}</kbd>`).join(' ')}</dt><dd>${v}</dd>`).join('')
  }</dl></div>`;
  el.shortcuts.addEventListener('click', e => {
    if (e.target === el.shortcuts) el.shortcuts.hidden = true;
  });
}

function wireChrome() {
  el.modes.addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  // Internal PDF links ("see page 12", a table of contents) jump within the
  // reflowed text. Capture phase, so the click-to-seek handler doesn't then
  // pull the position back to the link's own words.
  el.doc.addEventListener('click', e => {
    const a = e.target?.closest?.('a.lnk[data-page]');
    if (!a || !state.index) return;
    e.preventDefault();
    e.stopPropagation();
    const p = Number(a.dataset.page);
    const pages = state.index.pageOf;
    let i = 0;
    while (i < pages.length && pages[i] < p) i++;
    if (i >= pages.length) { toast(`Page ${p} has no text, opening the original`); setMode('pdf'); return; }
    seekTo(i);
    toast(`Jumped to page ${p}`);
  }, true);

  $('btn-play').addEventListener('click', togglePlay);
  $('btn-prev').addEventListener('click', () => pacer?.step(-1));
  $('btn-next').addEventListener('click', () => pacer?.step(1));
  $('btn-settings').addEventListener('click', () => panel.toggle());
  $('btn-search').addEventListener('click', () => (search?.isOpen() ? search.close() : search?.open()));
  $('btn-outline').addEventListener('click', () => store.save({ outlineOpen: !state.settings.outlineOpen }));

  if (!document.getElementById('paper')) {
    const paper = document.createElement('div');
    paper.id = 'paper';
    paper.setAttribute('aria-hidden', 'true');
    el.measure.prepend(paper);
  }

  // Leave the reader for Chrome's own viewer. The service worker lets this
  // one navigation through, otherwise the takeover rule would bounce it back.
  async function openOriginal() {
    if (state.source?.kind !== 'url') { toast('This file was opened from your computer.'); return; }
    try { await RUNTIME?.sendMessage({ type: 'bypass-once' }); } catch { /* still try */ }
    location.href = state.source.url;
  }
  $('btn-back').addEventListener('click', openOriginal);

  $('btn-download').addEventListener('click', async () => {
    if (!state.pdf) { toast('Nothing to download yet.'); return; }
    const data = await state.pdf.getData();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    let name = (state.source?.name || 'document').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  });

  $('btn-power').addEventListener('click', async () => {
    await store.save({ takeover: false });
    await store.flush().catch(() => {}); // the service worker reads it from storage
    toast('Lucid is off. PDFs open and download normally. Right-click the toolbar icon to turn it back on.', 4000);
    setTimeout(openOriginal, 1200);
  });

  // Trackpad pinch arrives as a wheel event with ctrlKey set.
  // Pinch = zoom. Shift + pinch = page width. Option + pinch = line spacing.
  let pinchSave = 0;
  el.scroller.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const s = state.settings;
    const f = Math.exp(-(e.deltaY || e.deltaX) * 0.01);
    const frac = el.scroller.scrollTop / Math.max(1, el.scroller.scrollHeight);
    let next;
    if (e.shiftKey) next = { columnWidth: Math.max(BY_KEY.columnWidth.min, Math.min(BY_KEY.columnWidth.max, Math.round(s.columnWidth * f))) };
    else if (e.altKey) next = { lineHeight: Math.max(BY_KEY.lineHeight.min, Math.min(BY_KEY.lineHeight.max, Math.round(s.lineHeight * f * 100) / 100)) };
    else next = { zoom: Math.max(BY_KEY.zoom.min, Math.min(BY_KEY.zoom.max, Math.round(s.zoom * f * 100) / 100)) };
    state.settings = { ...s, ...next };
    store.applyCssVars(document.documentElement, state.settings);
    el.scroller.scrollTop = frac * el.scroller.scrollHeight;
    positionRails();
    clearTimeout(pinchSave);
    pinchSave = setTimeout(() => {
      const { zoom, columnWidth, lineHeight } = state.settings;
      store.save({ zoom, columnWidth, lineHeight });
      panel?.refresh();
    }, 250);
  }, { passive: false });

  el.wpm.addEventListener('change', () => {
    const v = parseInt(el.wpm.value, 10);
    if (Number.isFinite(v)) store.save({ wpm: v });
  });

  $('btn-open').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    const f = el.fileInput.files?.[0];
    if (f) open({ kind: 'file', file: f, name: f.name });
  });

  $('error-retry').addEventListener('click', () => {
    el.error.hidden = true;
    if (state.source) open(state.source);
  });
  $('error-original').addEventListener('click', () => {
    if (state.source?.kind === 'url') location.href = state.source.url;
    else el.fileInput.click();
  });

  // Drag & drop anywhere in the window.
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    el.dropzone.hidden = false;
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; el.dropzone.hidden = true; }
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.hidden = true;
    const f = [...(e.dataTransfer.files || [])].find(x => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f) open({ kind: 'file', file: f, name: f.name });
    else toast('That does not look like a PDF.');
  });

  el.scroller.addEventListener('scroll', () => {
    // Flow scrolls the page itself; the dim zone is pinned to the screen, so
    // it needs every scroll position, not just every word.
    if (state.mode === 'flow') overlay?.update(overlayState());
    if (state.mode === 'normal' || state.mode === 'pdf') {
      overlay?.update(overlayState());
      updateProgress();
      clearTimeout(scrollStatusTimer);
      scrollStatusTimer = setTimeout(updateStatus, 120);
    }
  }, { passive: true });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 140);
  });

  window.addEventListener('keydown', onKey);
  new ResizeObserver(positionRails).observe(el.doc);
}
let scrollStatusTimer = 0;

/* ------------------------------------------------------------------ boot --- */

async function boot() {
  state.settings = await store.load();
  applySettings();

  store.subscribe((s, changed) => {
    state.settings = s;
    applySettings(changed);
    panel?.refresh();
    updateStatus();
  });

  // Contents panel: floats over the left of the page, like the settings drawer on the right.
  el.outline = document.createElement('aside');
  el.outline.id = 'outline';
  el.outline.hidden = !state.settings.outlineOpen;
  el.stage.appendChild(el.outline);
  outline = createOutline({
    root: el.outline,
    getIndex: () => state.index,
    getDoc: () => state.doc,
    getSettings: () => state.settings,
    getPosition: () => {
      const n = state.index?.count ?? 0;
      return state.mode === 'normal' || state.mode === 'pdf' ? Math.round(scrollFraction() * n) : state.word;
    },
    getDuration: i => (pacer?.durationFor ? pacer.durationFor(i) : 60000 / state.settings.wpm),
    onJump: i => { if (state.mode === 'pdf') setMode('normal'); seekTo(i); },
    onSave: patch => store.save(patch),
    onClose: () => store.save({ outlineOpen: false }),
  });

  search = createSearch({
    host: el.stage,
    getIndex: () => state.index,
    getPosition: () => {
      const n = state.index?.count ?? 0;
      return state.mode === 'normal' || state.mode === 'pdf' ? Math.round(scrollFraction() * n) : state.word;
    },
    onGo: i => { if (state.mode === 'pdf') setMode('normal'); seekTo(i); },
  });

  panel = createPanel({
    root: el.panel,
    scrim: el.scrim,
    getSettings: () => state.settings,
    onApply: patch => store.save(patch),
    // A saved setup also switches the reading mode it was saved with.
    onUseSetup: async patch => {
      await store.save(patch);
      if (patch.defaultMode && patch.defaultMode !== state.mode) setMode(patch.defaultMode);
    },
    getMode: () => state.mode,
    onPreview: () => {},
    onReset: keys => store.reset(keys),
  });
  // The panel sets this class; the stage reacts to it.
  new MutationObserver(() => relayout()).observe(el.app, {
    attributes: true, attributeFilter: ['class'],
  });

  buildShortcutsCard();
  wireChrome();
  initRailDrag();
  store.prunePositions();

  const source = sourceFromLocation();
  if (source) await open(source);
  else el.welcome.hidden = false;
}

boot().catch(e => {
  console.error('[lucid] boot failed', e);
  showError('Lucid Reader failed to start', String(e?.message || e));
});

// Exposed for the panel's section-reset helper and for debugging in DevTools.
Object.assign(window, { __lucid: { state, SECTION_KEYS, FLAG, timings } });
