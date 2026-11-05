/**
 * Line-based reading aids — stripes, dim veils, descending bar — painted as
 * absolutely-positioned children of #overlay so the text is never touched.
 *
 * Coordinate spaces (the one thing here that must not drift):
 *
 *   - The line map stores rects relative to #doc's border box, as the contract
 *     asks, so scrolling never invalidates it: #doc scrolls with #measure.
 *   - #overlay fills #measure, so overlay coordinates are #measure-relative.
 *     #measure is the only child of #scroller and sits at its origin, which
 *     makes an overlay y equal to a `scroller.scrollTop` y. `state.scrollTop`
 *     and `state.viewportHeight` are therefore used as-is.
 *   - The single conversion is `docOff` (#doc's border box inside #overlay),
 *     read once per measure and added at paint time. A consumer that wants a
 *     scrollTop value out of lineRect() adds `doc.offsetTop` itself.
 *
 * Reads and writes never interleave inside a frame. Measuring (getClientRects)
 * runs in time-boxed chunks at the top of one requestAnimationFrame callback,
 * painting runs at the bottom of the same callback, and update() never touches
 * the DOM directly — it records state and asks for a frame. That is what lets
 * scroll and the pacer both call it at 60Hz without a forced layout each time.
 */

const CHUNK_MS = 6;          // measuring budget per frame; the rest is the browser's
const CHECK_EVERY = 32;      // words between clock checks (power of two)
const FP_SAMPLES = 48;       // spans sampled by the layout fingerprint
const JUMP_VIEWPORTS = 2.5;  // a bar move bigger than this snaps instead of easing
const MARGIN_VIEWPORTS = 1;  // painted area beyond the viewport on each side

const px = v => `${Math.round(v * 100) / 100}px`;
const q = v => Math.round(v * 4); // quarter-pixel quantisation for the fingerprint

function newMap(count) {
  return {
    done: false,
    wordLine: new Int32Array(count).fill(-1),
    top: [], bottom: [], left: [], right: [],
    first: [], last: [],
    prov: [],   // 1 while a line's word range was seeded by a wrapped word's tail
    n: 0,
    maxH: 0,    // tallest line box, the slack for range searches on `top`
  };
}

/** First index in `arr[0..n)` whose value is >= x (arr ascending). */
function lowerBound(arr, n, x) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function createOverlay(opts) {
  const { host, doc } = opts;
  const getSettings = typeof opts.getSettings === 'function' ? opts.getSettings : () => ({});
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  // A getter is accepted as well as a fixed index so a re-rendered document
  // does not need a new overlay.
  const getIndex = typeof opts.index === 'function' ? opts.index : () => opts.index;

  let map = newMap(0);
  let docOff = { top: 0, left: 0 };       // #doc border box inside #overlay
  let col = { left: 0, width: 0 };        // #doc content box, overlay x
  let fp = null;                          // layout fingerprint the map was built from
  let job = null;                         // in-progress measuring job
  let measureWanted = false;
  let waiters = [];                       // measure() promises
  let raf = 0;
  let destroyed = false;

  const state = { mode: 'normal', wordIndex: -1, playing: false, scrollTop: 0, viewportHeight: 0 };

  /* ------------------------------------------------------------ elements --- */

  const mk = (cls) => {
    const el = document.createElement('div');
    el.className = cls;
    el.hidden = true;
    host.appendChild(el);
    return { el, top: NaN, h: NaN, shown: false };
  };
  const bar = Object.assign(mk('ov-bar'), { y: NaN, unjump: false });
  const veilTop = mk('ov-veil ov-veil-top');
  const veilBot = mk('ov-veil ov-veil-bot');
  const stripes = [];   // pool; stripes are inserted before the bar so tree order is stripes, bar, veils

  const hostVars = {};
  function setVar(name, value) {
    const v = String(value ?? '');
    if (hostVars[name] === v) return;
    hostVars[name] = v;
    host.style.setProperty(name, v);
  }
  let noMotion = null;

  function place(rec, top, h) {
    if (!(h > 0.5)) { hide(rec); return; }
    if (rec.top !== top) { rec.top = top; rec.el.style.top = px(top); }
    if (rec.h !== h) { rec.h = h; rec.el.style.height = px(h); }
    if (!rec.shown) { rec.shown = true; rec.el.hidden = false; }
  }
  function hide(rec) {
    if (rec.shown) { rec.shown = false; rec.el.hidden = true; }
  }

  function stripeAt(k) {
    if (k < stripes.length) return stripes[k];
    const el = document.createElement('div');
    el.className = 'ov-stripe';
    el.hidden = true;
    host.insertBefore(el, bar.el);
    const rec = { el, top: NaN, h: NaN, alt: false, shown: false };
    stripes.push(rec);
    return rec;
  }
  function trimStripes(used) {
    for (let k = used; k < stripes.length; k++) hide(stripes[k]);
    // Keep a few spares so a scroll doesn't churn elements, but no more.
    const keep = Math.max(used * 2, 16);
    while (stripes.length > keep) stripes.pop().el.remove();
  }

  /* ----------------------------------------------------------- measuring --- */

  /**
   * Everything the map depends on besides the spans themselves, plus a sample
   * of span rects. Equal fingerprints mean the layout has not moved, so a
   * measure() prompted by a colour change costs 50 rect reads, not 100k.
   */
  function readLayout(spans) {
    const hostRect = host.getBoundingClientRect();
    const docRect = doc.getBoundingClientRect();
    const cs = getComputedStyle(doc);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const off = { top: docRect.top - hostRect.top, left: docRect.left - hostRect.left };
    const column = { left: off.left + pl, width: Math.max(0, docRect.width - pl - pr) };

    const n = spans.length;
    const parts = [n, q(docRect.width), q(docRect.height), q(off.top), q(off.left)];
    const step = Math.max(1, Math.floor(n / FP_SAMPLES));
    for (let i = 0; i < n; i += step) parts.push(sample(spans[i], docRect));
    if (n > 1) parts.push(sample(spans[n - 1], docRect));
    return { fp: parts.join('|'), off, column };
  }
  function sample(span, docRect) {
    const r = span.getClientRects()[0];
    return r ? `${q(r.top - docRect.top)},${q(r.left - docRect.left)},${q(r.width)}` : 'x';
  }

  function startJob() {
    const idx = getIndex();
    const spans = idx?.spans ?? [];
    const lay = readLayout(spans);
    docOff = lay.off;
    col = lay.column;
    if (lay.fp === fp && (map.done || job)) {
      // Same layout: keep the finished map, or let the running job finish.
      if (map.done) settle();
      return;
    }
    fp = lay.fp;
    map = newMap(spans.length);
    job = { spans, blockOf: idx?.blockOf ?? null, i: 0, prevBlock: -1 };
    if (!spans.length) finishJob();
  }

  function runChunk() {
    const { spans, blockOf } = job;
    const m = map;
    // Re-read the origin every chunk: the user may have scrolled between frames
    // and client rects are viewport-relative.
    const docRect = doc.getBoundingClientRect();
    const dx = docRect.left, dy = docRect.top;
    const deadline = performance.now() + CHUNK_MS;
    const end = spans.length;
    let i = job.i;

    while (i < end) {
      const rects = spans[i].getClientRects();
      // A block always starts a fresh line, whatever the rect tops say.
      let breakLine = blockOf ? blockOf[i] !== job.prevBlock : false;
      if (blockOf) job.prevBlock = blockOf[i];
      let primary = -1;

      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        if (r.height < 0.5 || r.width < 0.5) continue;
        const top = r.top - dy, bottom = r.bottom - dy;
        const left = r.left - dx, right = r.right - dx;
        const h = bottom - top;
        const n = m.n;

        // Tolerance comes from this rect's own box, so it scales with the font.
        if (!breakLine && n > 0 && Math.abs(top - m.top[n - 1]) <= h / 3) {
          const j = n - 1;
          if (bottom > m.bottom[j]) m.bottom[j] = bottom;
          if (left < m.left[j]) m.left[j] = left;
          if (right > m.right[j]) m.right[j] = right;
          if (m.bottom[j] - m.top[j] > m.maxH) m.maxH = m.bottom[j] - m.top[j];
          if (primary < 0) {
            primary = j;
            if (m.prov[j]) { m.first[j] = i; m.prov[j] = 0; }
            m.last[j] = i;
          }
        } else {
          m.top.push(top); m.bottom.push(bottom); m.left.push(left); m.right.push(right);
          m.first.push(i); m.last.push(i);
          // The tail of a wrapped word opens a line but belongs to the previous
          // one; the next word that lands here claims the range instead.
          if (primary < 0) { primary = n; m.prov.push(0); } else m.prov.push(1);
          m.n++;
          if (h > m.maxH) m.maxH = h;
        }
        breakLine = false;
      }

      m.wordLine[i] = primary;
      i++;
      if ((i & (CHECK_EVERY - 1)) === 0 && performance.now() > deadline) break;
    }

    job.i = i;
    if (onProgress) onProgress(i, end);
    if (i >= end) finishJob();
  }

  function finishJob() {
    map.done = true;
    job = null;
    settle();
  }
  function settle() {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  }

  /* ------------------------------------------------------------ painting --- */

  function currentLine(m, vh) {
    if (!m.n) return -1;
    const wi = state.wordIndex;
    if (state.mode !== 'normal' && Number.isInteger(wi) && wi >= 0 && wi < m.wordLine.length) {
      return m.wordLine[wi]; // -1 while that word is still unmeasured
    }
    // Normal mode has no pacer word: follow the middle of the viewport.
    const cy = state.scrollTop + vh / 2 - docOff.top;
    const j = lowerBound(m.top, m.n, cy);
    if (j === 0) return 0;
    if (j >= m.n) return m.n - 1;
    const dPrev = Math.abs(cy - (m.top[j - 1] + m.bottom[j - 1]) / 2);
    const dNext = Math.abs(cy - (m.top[j] + m.bottom[j]) / 2);
    return dPrev <= dNext ? j - 1 : j;
  }

  // The veil edges sit in the leading between lines, not on the glyph boxes.
  function edgeAbove(m, a) {
    if (a > 0) return (m.bottom[a - 1] + m.top[a]) / 2;
    return m.top[a] - (m.bottom[a] - m.top[a]) * 0.3;
  }
  function edgeBelow(m, b) {
    if (b < m.n - 1) return (m.bottom[b] + m.top[b + 1]) / 2;
    return m.bottom[b] + (m.bottom[b] - m.top[b]) * 0.3;
  }

  function paint() {
    const s = getSettings() || {};
    const m = map;
    const vh = state.viewportHeight > 0 ? state.viewportHeight : window.innerHeight;
    const winTop = state.scrollTop - vh * MARGIN_VIEWPORTS;   // overlay space
    const winBot = state.scrollTop + vh * (1 + MARGIN_VIEWPORTS);

    setVar('--ov-stripe-c1', s.stripeColor);
    setVar('--ov-stripe-c2', s.stripeAlternate ? s.stripeColor2 : s.stripeColor);
    setVar('--ov-stripe-op', (s.stripeOpacity ?? 0) / 100);
    setVar('--ov-dim', (s.dimStrength ?? 0) / 100);
    setVar('--ov-bar-c', s.barColor);
    setVar('--ov-bar-op', (s.barOpacity ?? 0) / 100);
    setVar('--ov-bar-h', px(s.barHeight ?? 0));
    setVar('--ov-col-l', px(col.left));
    setVar('--ov-col-w', px(col.width));
    if (noMotion !== !!s.reduceMotion) {
      noMotion = !!s.reduceMotion;
      host.classList.toggle('ov-nomotion', noMotion);
    }

    /* stripes — static, by line number only */
    let used = 0;
    if (s.stripesOn && m.n) {
      const every = Math.max(1, s.stripeEvery | 0);
      let n = lowerBound(m.top, m.n, winTop - docOff.top - m.maxH);
      // "every Nth" counts from 1: lines N, 2N, 3N…  i.e. (n + 1) % every === 0
      n += (every - 1 - (n % every) + every) % every;
      for (; n < m.n; n += every) {
        const top = m.top[n] + docOff.top;
        if (top > winBot) break;
        const h = m.bottom[n] - m.top[n];
        if (top + h < winTop) continue;
        const alt = !!s.stripeAlternate && (((n + 1) / every) % 2 === 0);
        const rec = stripeAt(used++);
        if (rec.alt !== alt) { rec.alt = alt; rec.el.classList.toggle('alt', alt); }
        place(rec, top, h);
      }
    }
    trimStripes(used);

    const cur = (s.dimOn || s.barOn) ? currentLine(m, vh) : -1;

    /* dim veils — two blocks around the focus window */
    if (s.dimOn && cur >= 0) {
      const lines = Math.max(1, s.dimLines | 0);
      const above = Math.floor((lines - 1) / 2);
      const a = Math.max(0, cur - above);
      const b = Math.min(m.n - 1, cur + (lines - 1 - above));
      const focusTop = edgeAbove(m, a) + docOff.top;
      const focusBot = edgeBelow(m, b) + docOff.top;
      const t0 = Math.max(0, winTop);
      place(veilTop, t0, focusTop - t0);
      place(veilBot, focusBot, winBot - focusBot);
    } else {
      hide(veilTop);
      hide(veilBot);
    }

    /* descending bar — eases via a transform transition */
    if (s.barOn && cur >= 0) {
      const bh = s.barHeight ?? 0;
      const y = (m.top[cur] + m.bottom[cur]) / 2 + docOff.top - bh / 2;
      if (y + bh < winTop || y > winBot) {
        hide(bar);
      } else {
        const snap = !bar.shown || Math.abs(y - bar.y) > JUMP_VIEWPORTS * vh;
        if (snap && !bar.unjump) { bar.unjump = true; bar.el.classList.add('ov-jump'); }
        if (bar.y !== y) { bar.y = y; bar.el.style.transform = `translateY(${px(y)})`; }
        if (!bar.shown) { bar.shown = true; bar.el.hidden = false; }
      }
    } else {
      hide(bar);
    }
  }

  /* ---------------------------------------------------------- scheduling --- */

  function schedule() {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (destroyed) return;
    try {
      // The snap class from the previous frame has been applied by now; drop it
      // so the next ordinary move eases again.
      if (bar.unjump) { bar.unjump = false; bar.el.classList.remove('ov-jump'); }
      if (measureWanted) { measureWanted = false; startJob(); }   // reads
      if (job) runChunk();                                          // reads
      paint();                                                      // writes
    } catch (e) {
      // A broken aid must never take the text down with it.
      console.warn('[lucid] overlay paint failed', e);
      job = null;
      settle();
    }
    if (job || bar.unjump) schedule();
  }

  function requestMeasure() {
    measureWanted = true;
    schedule();
  }

  // Layout can move under us without anyone calling measure(): the column
  // grips, a window resize, a late web font. Watching for those is cheaper
  // than being half a line off.
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(requestMeasure);
    ro.observe(doc);
    ro.observe(host);
  }
  const onFonts = () => requestMeasure();
  document.fonts?.addEventListener?.('loadingdone', onFonts);

  /* ----------------------------------------------------------------- API --- */

  return {
    /** Rebuild the line map. Resolves when the map is complete. */
    measure() {
      return new Promise(resolve => {
        if (destroyed) { resolve(); return; }
        waiters.push(resolve);
        requestMeasure();
      });
    },

    /** Record the new state and repaint on the next frame. Never reads layout. */
    update(next) {
      if (!next) { schedule(); return; }
      if (next.mode !== undefined) state.mode = next.mode;
      if (next.wordIndex !== undefined) state.wordIndex = next.wordIndex;
      if (next.playing !== undefined) state.playing = !!next.playing;
      if (next.scrollTop !== undefined) state.scrollTop = +next.scrollTop || 0;
      if (next.viewportHeight !== undefined) state.viewportHeight = +next.viewportHeight || 0;
      schedule();
    },

    /** Line of word i, or -1 if unknown (out of range, or not yet measured). */
    lineOfWord(i) {
      return i >= 0 && i < map.wordLine.length ? map.wordLine[i] : -1;
    },

    /**
     * Geometry of line n relative to #doc's border box (add `doc.offsetTop`
     * for a scroller.scrollTop value). null when n is out of range.
     */
    lineRect(n) {
      if (!(n >= 0 && n < map.n)) return null;
      const top = map.top[n], bottom = map.bottom[n];
      return { top, bottom, left: map.left[n], right: map.right[n], height: bottom - top };
    },

    /** Lines measured so far; partial while a measure is in progress. */
    lineCount() {
      return map.n;
    },

    /** [firstWord, lastWord] of line n (clamped into range); [-1, -1] when empty. */
    wordRangeOfLine(n) {
      if (!map.n) return [-1, -1];
      const k = Math.min(map.n - 1, Math.max(0, n | 0));
      return [map.first[k], map.last[k]];
    },

    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      job = null;
      ro?.disconnect();
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      host.replaceChildren();
      host.classList.remove('ov-nomotion');
      for (const name of Object.keys(hostVars)) host.style.removeProperty(name);
      stripes.length = 0;
      map = newMap(0);
      settle();
    },
  };
}
