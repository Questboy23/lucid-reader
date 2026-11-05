/**
 * Read-along: highlights the pacer's word in the text and keeps it on screen.
 *
 * The per-word step must stay cheap — at 1200 wpm it runs twenty times a
 * second on a page with 100k spans — so it is one class removal, one class
 * addition and some arithmetic against the overlay's line map. Nothing in the
 * hot path reads layout: scrollTop and the viewport height are cached from
 * events, and the word's position comes from the overlay's #doc-relative line
 * rects. Layout is read only when a scroll correction is actually issued,
 * which happens once every few lines, not every word.
 *
 * Scroll follow uses hysteresis. The word may drift inside a band around the
 * anchor line; only when it leaves the band do we scroll, and then we put it
 * back on the anchor — so the page moves in comfortable line-sized hops
 * rather than crawling on every word. While a smooth scroll is in flight the
 * band is checked against its destination, not the current mid-animation
 * position, so one correction never triggers a second that fights it.
 *
 * The user is allowed to scroll. Their own wheel/touch scrolls are told apart
 * from ours (ours have a known destination) and suspend following until the
 * word has actually left the viewport, after a grace period — so a manual
 * scroll is never instantly undone, but the reader does catch up once the
 * pacer has walked out of view.
 */

const FLIGHT_MS = 900;        // longest we expect a smooth scroll to take
const USER_GRACE_MS = 2500;   // no corrections this long after a manual scroll
const INTENT_MS = 400;        // a scroll this soon after wheel/touch is the user's
const JUMP_FACTOR = 3;        // farther than this many viewports: jump, don't glide
const DRAG_PX = 4;            // pointer travel past which a click is a drag

export function createReadAlong({ index, doc, scroller, overlay, getSettings, onSeek }) {
  let cur = -1;
  let curEl = null;

  // Cached geometry: written by events, read by the hot path.
  let scrollTop = scroller.scrollTop;
  let vh = scroller.clientHeight;
  let docTop = null;            // #doc top in scroller content coords; lazy

  // Our own scroll in flight.
  let target = -1;
  let flightUntil = 0;

  // The user's scrolling.
  let lastIntent = -Infinity;
  let userScrollAt = -Infinity;
  let suspended = false;

  const now = () => performance.now();

  /* ------------------------------------------------------------ highlight --- */

  function setWord(i, follow = true) {
    const span = index.spans[i];
    if (!span) return;
    if (span === curEl) {
      if (follow) followWord(i);
      return;
    }
    if (curEl) curEl.classList.remove('cur');
    span.classList.add('cur');
    curEl = span;
    cur = i;
    if (follow) followWord(i);
  }

  function clear() {
    if (curEl) curEl.classList.remove('cur');
    curEl = null;
    cur = -1;
    suspended = false;
    target = -1;
  }

  /* --------------------------------------------------------------- follow --- */

  function measureDocTop() {
    const d = doc.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    docTop = d.top - s.top + scroller.scrollTop;
    return docTop;
  }

  /** {top, bottom} of word i's line in scroller content coordinates, or null. */
  function lineBox(i) {
    let r = null;
    try {
      const n = overlay.lineOfWord(i);
      if (n >= 0) r = overlay.lineRect(n);
    } catch { r = null; }
    if (r && Number.isFinite(r.top) && Number.isFinite(r.bottom)) {
      const dt = docTop ?? measureDocTop();
      return { top: dt + r.top, bottom: dt + r.bottom };
    }
    // Overlay not measured yet (first words after render): one layout read.
    const span = index.spans[i];
    const rects = span.getClientRects();
    const cr = rects.length ? rects[0] : span.getBoundingClientRect();
    const st = scroller.getBoundingClientRect().top;
    const base = scroller.scrollTop;
    return { top: cr.top - st + base, bottom: cr.bottom - st + base };
  }

  function followWord(i) {
    const s = getSettings();
    if (!s.pacerFollow) return;
    const box = lineBox(i);
    if (!box) return;

    const t = now();
    const base = target >= 0 && t < flightUntil ? target : scrollTop;
    const y = box.top - base;              // line top in viewport coords
    const yb = box.bottom - base;
    const lh = Math.max(8, box.bottom - box.top);
    const offscreen = yb < 0 || y > vh;

    if (suspended) {
      if (!offscreen || t - userScrollAt < USER_GRACE_MS) return;
      suspended = false;
    }

    const anchorY = vh * (s.pacerAnchor / 100);
    const below = anchorY + Math.max(lh * 2.5, vh * 0.12);
    const above = anchorY - Math.max(lh * 1.5, vh * 0.08);
    if (y >= above && yb <= below) return;   // inside the dead band

    // A correction: refresh geometry with real reads, then write once.
    measureDocTop();
    const fresh = lineBox(i);
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const mid = fresh.top + (fresh.bottom - fresh.top) / 2;
    const dest = Math.max(0, Math.min(maxScroll, Math.round(mid - anchorY)));
    const from = scroller.scrollTop;
    if (Math.abs(dest - from) < 1) { target = -1; return; }

    const far = Math.abs(dest - from) > vh * JUMP_FACTOR;
    const smooth = !s.reduceMotion && !far;
    target = dest;
    flightUntil = t + (smooth ? FLIGHT_MS : 100);
    scroller.scrollTo({ top: dest, behavior: smooth ? 'smooth' : 'auto' });
  }

  /* --------------------------------------------- telling scrolls apart --- */

  function onScroll() {
    const prev = scrollTop;
    const st = scroller.scrollTop;
    scrollTop = st;
    const t = now();

    if (target >= 0) {
      const rem = Math.abs(target - st);
      const prevRem = Math.abs(target - prev);
      if (rem <= 1) { target = -1; return; }          // arrived
      if (t <= flightUntil && rem <= prevRem + 2) return;   // ours, still gliding
      target = -1;                                     // something else took over
    }
    if (t - lastIntent < INTENT_MS) {
      userScrollAt = t;
      suspended = true;
    }
  }

  function onScrollEnd() {
    if (target >= 0 && Math.abs(target - scroller.scrollTop) <= 1) target = -1;
  }

  function onIntent() { lastIntent = now(); }

  /* -------------------------------------------------------- click to seek --- */

  let downX = 0, downY = 0, downHadSelection = false;

  function onPointerDown(e) {
    downX = e.clientX;
    downY = e.clientY;
    const sel = window.getSelection();
    downHadSelection = !!sel && !sel.isCollapsed;
  }

  function onClick(e) {
    if (!onSeek) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (downHadSelection) return;   // this click only dismissed a selection
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_PX) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const span = e.target && e.target.closest ? e.target.closest('.w') : null;
    if (!span || !doc.contains(span)) return;
    const i = Number(span.dataset.i);
    if (!Number.isInteger(i) || i < 0 || i >= index.count) return;
    try { onSeek(i); }
    catch (err) { console.error('[lucid] onSeek failed', err); }
  }

  /* ---------------------------------------------------------------- wiring --- */

  const passive = { passive: true };
  scroller.addEventListener('scroll', onScroll, passive);
  scroller.addEventListener('scrollend', onScrollEnd, passive);
  scroller.addEventListener('wheel', onIntent, passive);
  scroller.addEventListener('touchstart', onIntent, passive);
  scroller.addEventListener('touchmove', onIntent, passive);
  doc.addEventListener('pointerdown', onPointerDown, passive);
  doc.addEventListener('click', onClick);

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(entries => {
      for (const en of entries) {
        if (en.target === scroller) vh = en.contentRect.height || scroller.clientHeight;
      }
      docTop = null;   // padding/zoom changes move #doc; re-measure on demand
    });
    ro.observe(scroller);
    ro.observe(doc);
  }

  function destroy() {
    clear();
    scroller.removeEventListener('scroll', onScroll, passive);
    scroller.removeEventListener('scrollend', onScrollEnd, passive);
    scroller.removeEventListener('wheel', onIntent, passive);
    scroller.removeEventListener('touchstart', onIntent, passive);
    scroller.removeEventListener('touchmove', onIntent, passive);
    doc.removeEventListener('pointerdown', onPointerDown, passive);
    doc.removeEventListener('click', onClick);
    if (ro) ro.disconnect();
  }

  return { setWord, clear, destroy };
}
