/**
 * Auto-scroll: the page moves continuously at a speed that matches wpm.
 *
 * Speed comes from the overlay's line map rather than a guess about words per
 * line: pixels per word is the height of the text divided by its word count,
 * which already folds in paragraph gaps and headings. Written out that is the
 * contract's px/s = (wpm / 60) * lineHeightPx / wordsPerLine with both taken
 * as document averages. It is recomputed on a slow cadence so a font-size or
 * wpm change is picked up within half a second without reading layout every
 * frame.
 *
 * Position is kept as a float and only written to scrollTop when it crosses a
 * device pixel, so 40 wpm still advances smoothly instead of freezing between
 * one-pixel jumps. A frame gap longer than a quarter second (throttled tab,
 * heavy jank) is clamped to one frame's worth of motion — the reader wasn't
 * looking, so the page shouldn't lurch to where it "should" be.
 *
 * Scrolls that aren't ours stop the run. Wheel/touch input stops it at once;
 * anything else (scrollbar drag, keyboard, another module) is caught by the
 * scroll event landing somewhere other than where we last wrote.
 */

const RECALC_MS = 500;
const MAX_DT = 0.25;
const WORD_POLL_MS = 120;

export function createAutoScroll({ scroller, index, overlay, getSettings, onWord, onStateChange, onEnd }) {
  let running = false;
  let frame = 0;
  let pos = 0;              // fractional scrollTop
  let expected = -1;        // last value we wrote (device-pixel rounded)
  let lastT = 0;
  let lastRecalc = -Infinity;
  let lastWordPoll = -Infinity;
  let lastWord = -1;
  let speed = 0;            // px/s
  let vh = scroller.clientHeight;
  let maxScroll = 0;
  let docTop = null;
  let dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;

  const now = () => performance.now();
  const docEl = () => index.blockEls?.[0]?.parentElement || index.spans?.[0]?.closest?.('#doc') || null;

  /* --------------------------------------------------------------- geometry --- */

  function measureDocTop() {
    const d = docEl();
    if (!d) { docTop = 0; return 0; }
    const dr = d.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    docTop = dr.top - sr.top + scroller.scrollTop;
    return docTop;
  }

  function recalc() {
    lastRecalc = now();
    vh = scroller.clientHeight;
    maxScroll = Math.max(0, scroller.scrollHeight - vh);
    dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;

    const s = getSettings();
    const count = index.count || 0;
    if (!count) { speed = 0; return; }

    let pxPerWord = 0;
    try {
      const n = overlay.lineCount();
      if (n > 0) {
        const a = overlay.lineRect(0);
        const b = overlay.lineRect(n - 1);
        if (a && b && b.bottom > a.top) {
          // pitch / wordsPerLine == (span / n) / (count / n) == span / count
          pxPerWord = (b.bottom - a.top) / count;
        }
      }
    } catch { pxPerWord = 0; }
    if (!(pxPerWord > 0)) {
      const d = docEl();
      pxPerWord = d ? d.offsetHeight / count : 0;
    }
    speed = (s.wpm / 60) * pxPerWord;
  }

  /* --------------------------------------------------------------- the run --- */

  function write(v) {
    const q = Math.round(v * dpr) / dpr;
    if (q === expected) return;
    expected = q;
    scroller.scrollTop = q;
  }

  function loop(t) {
    frame = 0;
    if (!running) return;
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_DT) dt = 1 / 60;

    if (t - lastRecalc > RECALC_MS) recalc();

    pos += speed * dt;
    if (pos >= maxScroll) {
      pos = maxScroll;
      write(pos);
      finish();
      return;
    }
    write(pos);

    if (onWord && !getSettings().autoScrollHideWord && t - lastWordPoll > WORD_POLL_MS) {
      lastWordPoll = t;
      const w = wordAtScroll(expected);   // what we wrote, not a read-back
      if (w !== lastWord && w >= 0) {
        lastWord = w;
        try { onWord(w); } catch (e) { console.error('[lucid] autoscroll onWord failed', e); }
      }
    }
    frame = requestAnimationFrame(loop);
  }

  function emitState(extra) {
    if (!onStateChange) return;
    try { onStateChange({ running, ...extra }); }
    catch (e) { console.error('[lucid] autoscroll onStateChange failed', e); }
  }

  function start() {
    if (running) return;
    if (!(index.count > 0)) return;
    recalc();
    pos = scroller.scrollTop;
    expected = Math.round(pos * dpr) / dpr;
    if (pos >= maxScroll - 0.5 && maxScroll > 0) {
      // Already at the bottom: nothing to scroll, say so rather than spin.
      finish();
      return;
    }
    running = true;
    lastT = now();
    lastWord = -1;
    lastWordPoll = -Infinity;
    emitState({ done: false });
    frame = requestAnimationFrame(loop);
  }

  function stop(reason) {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (!running) return;
    running = false;
    emitState({ done: false, reason: reason || 'stop' });
  }

  function finish() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    running = false;
    emitState({ done: true, reason: 'end' });
    if (onEnd) {
      try { onEnd(); } catch (e) { console.error('[lucid] autoscroll onEnd failed', e); }
    }
  }

  /* --------------------------------------------------------- word <-> pixel --- */

  function anchorY() {
    return vh * (getSettings().pacerAnchor / 100);
  }

  /** Line containing doc-relative y (last line whose top is at or above y). */
  function lineAt(y) {
    let n;
    try { n = overlay.lineCount(); } catch { n = 0; }
    if (!(n > 0)) return -1;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const r = overlay.lineRect(mid);
      if (r && r.top <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Fallback when the overlay has no line map: binary search span tops. */
  function wordAtFallback(y) {
    const spans = index.spans;
    const d = docEl();
    if (!spans.length || !d) return 0;
    const dTop = d.getBoundingClientRect().top;
    const topOf = i => spans[i].getBoundingClientRect().top - dTop;
    let lo = 0, hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (topOf(mid) <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** The word on the anchor line, derived from where the page actually is. */
  function currentWord() {
    return wordAtScroll(scroller.scrollTop);
  }

  function wordAtScroll(st) {
    if (!(index.count > 0)) return 0;
    const y = st + anchorY() - (docTop ?? measureDocTop());
    const n = lineAt(y);
    if (n < 0) return wordAtFallback(y);
    let range = null;
    try { range = overlay.wordRangeOfLine(n); } catch { range = null; }
    if (!range || !(range[0] >= 0)) return wordAtFallback(y);
    return Math.min(index.count - 1, range[0]);
  }

  /** Put word i's line on the anchor. Instant: this is a hand-over, not a glide. */
  function setFromWord(i) {
    if (!(index.count > 0)) return;
    i = Math.max(0, Math.min(index.count - 1, Math.trunc(i) || 0));
    recalc();
    measureDocTop();
    let mid = null;
    try {
      const n = overlay.lineOfWord(i);
      const r = n >= 0 ? overlay.lineRect(n) : null;
      if (r && Number.isFinite(r.top)) mid = docTop + (r.top + r.bottom) / 2;
    } catch { mid = null; }
    if (mid === null) {
      const span = index.spans[i];
      const rects = span.getClientRects();
      const cr = rects.length ? rects[0] : span.getBoundingClientRect();
      const st = scroller.getBoundingClientRect().top;
      mid = cr.top - st + scroller.scrollTop + cr.height / 2;
    }
    pos = Math.max(0, Math.min(maxScroll, mid - anchorY()));
    expected = -1;
    write(pos);
    lastWord = i;
  }

  /* ------------------------------------------------------- user detection --- */

  function onScroll() {
    if (!running) return;
    const st = scroller.scrollTop;
    if (Math.abs(st - expected) <= 1) return;         // ours
    // Layout is clean inside a scroll event, so this refresh is cheap; without
    // it a document that just got shorter would read as a user scroll.
    maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (st >= maxScroll - 1 && expected >= st) {      // clamped at the bottom
      pos = st;
      finish();
      return;
    }
    stop('user');
  }

  function onIntent() {
    if (running) stop('user');
  }

  const passive = { passive: true };
  scroller.addEventListener('scroll', onScroll, passive);
  scroller.addEventListener('wheel', onIntent, passive);
  scroller.addEventListener('touchmove', onIntent, passive);

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      docTop = null;
      lastRecalc = -Infinity;   // pick up the new layout on the next frame
    });
    ro.observe(scroller);
    const d = docEl();
    if (d) ro.observe(d);
  }

  function destroy() {
    stop('destroy');
    scroller.removeEventListener('scroll', onScroll, passive);
    scroller.removeEventListener('wheel', onIntent, passive);
    scroller.removeEventListener('touchmove', onIntent, passive);
    if (ro) ro.disconnect();
  }

  return {
    start,
    stop: () => stop('stop'),
    running: () => running,
    setFromWord,
    currentWord,
    destroy,
  };
}
