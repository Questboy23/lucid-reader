/**
 * The timing engine behind read-along, auto-scroll and RSVP.
 *
 * Pure: it only knows the word index and the clock. It never touches the DOM,
 * which is what lets one engine drive three very different renderers and lets
 * the timing be unit-tested in node. The clock (`raf`/`now`) is injectable
 * for the same reason.
 *
 * Scheduling is deadline-based, not a chain of timeouts: each frame compares
 * `now` against the moment the current word expires. That keeps the average
 * rate exact under frame jitter (the remainder carries over) and gives us one
 * place to deal with a throttled tab: Chrome stops firing rAF in background
 * tabs entirely, so the first frame after the user comes back can be minutes
 * late. Replaying that backlog word by word would rocket through a paragraph,
 * so a gap longer than STALL_MS is treated as time that didn't happen — the
 * current word simply keeps whatever dwell it had left. Smaller gaps (a jank
 * at high wpm) may advance a few words at once, capped at MAX_CATCHUP.
 */

const STALL_MS = 400;     // a frame gap longer than this is a stall, not lag
const MAX_CATCHUP = 3;    // most words a single late frame may advance

const HAS_ALNUM = /[\p{L}\p{N}]/u;
const NON_ALNUM = /[^\p{L}\p{N}]/gu;

const defaultRaf = typeof requestAnimationFrame === 'function'
  ? cb => requestAnimationFrame(cb)
  : cb => setTimeout(() => cb(defaultNow()), 16);
const defaultCaf = typeof cancelAnimationFrame === 'function'
  ? id => cancelAnimationFrame(id)
  : id => clearTimeout(id);
const defaultNow = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

export class Pacer {
  /**
   * @param {object} o
   * @param {WordIndex} o.index
   * @param {() => Settings} o.getSettings
   * @param {(i:number) => void} [o.onWord]           the shown word changed
   * @param {(s:{playing,done,index}) => void} [o.onStateChange]
   * @param {Function} [o.raf]  @param {Function} [o.caf]  @param {Function} [o.now]
   *   clock overrides, for tests
   */
  constructor({ index, getSettings, onWord, onStateChange, raf, caf, now }) {
    this._index = index;
    this._getSettings = getSettings;
    this._onWord = onWord || null;
    this._onState = onStateChange || null;
    this._raf = raf || defaultRaf;
    this._caf = caf || defaultCaf;
    this._now = now || defaultNow;

    const n = index?.count ?? 0;
    // Letter/digit counts drive both "skip this glyph" and the long-word rule;
    // computing them once here keeps the regex out of durationFor.
    this._letters = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const w = index.text[i];
      this._letters[i] = w ? Math.min(65535, w.replace(NON_ALNUM, '').length) : 0;
    }

    this._i = n ? this._nextReal(0, 1) : 0;
    if (this._i < 0) this._i = 0;
    this._playing = false;
    this._done = false;
    this._frame = 0;
    this._deadline = 0;
    this._lastFrame = 0;
    this._tick = this._tick.bind(this);

    this._cum = null;
    this._cumKey = '';
  }

  get index() { return this._i; }
  get playing() { return this._playing; }
  get done() { return this._done; }

  /* ---------------------------------------------------------- transport --- */

  play() {
    if (this._playing) return;
    const n = this._index?.count ?? 0;
    if (!n) return;
    if (this._done) {
      // Play after the end starts over rather than sitting on the last word.
      const first = this._nextReal(0, 1);
      if (first >= 0) this._i = first;
      this._done = false;
    }
    const now = this._now();
    this._playing = true;
    this._lastFrame = now;
    this._deadline = now + this.durationFor(this._i);
    this._emitWord();
    this._emitState();
    this._schedule();
  }

  pause() {
    if (!this._playing) return;
    this._playing = false;
    this._cancel();
    this._emitState();
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  /**
   * Halt without touching the position. The index is left alone on purpose:
   * stop() is what a mode switch calls, and the other engine needs to pick up
   * from the same word.
   */
  stop() {
    const was = this._playing || this._done;
    this._playing = false;
    this._done = false;
    this._cancel();
    if (was) this._emitState();
  }

  /* --------------------------------------------------------- navigation --- */

  /** Jump to word `i` (or the nearest real word at/after it). */
  seek(i) {
    const n = this._index?.count ?? 0;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, Math.trunc(Number(i)) || 0));
    let t = this._nextReal(i, 1);
    if (t < 0) t = this._nextReal(i, -1);
    if (t < 0) return;
    this._land(t);
  }

  /** Move by `delta` real words; stops at either end. */
  step(delta) {
    const n = this._index?.count ?? 0;
    if (!n || !delta) return;
    const dir = delta > 0 ? 1 : -1;
    let t = this._i;
    for (let k = Math.abs(delta); k > 0; k--) {
      const nx = this._nextReal(t + dir, dir);
      if (nx < 0) break;
      t = nx;
    }
    // Landing on the same word still re-emits, so a paused read-along that
    // has nothing highlighted yet shows where it is.
    this._land(t);
  }

  /** Move by whole lines, using the overlay's line map (the only DOM-derived input). */
  stepLine(delta, overlay) {
    if (!overlay || !delta) return;
    let line, count, range;
    try {
      line = overlay.lineOfWord(this._i);
      count = overlay.lineCount();
    } catch { return; }
    if (!(line >= 0) || !(count > 0)) return;
    const target = Math.max(0, Math.min(count - 1, line + delta));
    if (target === line) return;
    try { range = overlay.wordRangeOfLine(target); } catch { return; }
    if (!range || !(range[0] >= 0)) return;
    this.seek(range[0]);
  }

  /* ------------------------------------------------------------- timing --- */

  /** Milliseconds word `i` is held, including pause multipliers. */
  durationFor(i) {
    const idx = this._index;
    if (!idx || i < 0 || i >= idx.count) return 0;
    if (this._letters[i] === 0) return 0;              // skipped glyph
    const s = this._getSettings();
    return durationFrom(s, idx.flags[i], this._letters[i], idx.FLAG);
  }

  /**
   * Estimated time to the end from `from` (default: the current word). Uses a
   * prefix sum that is rebuilt only when a timing setting changes, so the
   * status bar can poll it every frame on a 100k-word document.
   */
  remainingMs(from = this._i) {
    const n = this._index?.count ?? 0;
    if (!n) return 0;
    const s = this._getSettings();
    const key = `${s.wpm}|${s.pauseComma}|${s.pausePeriod}|${s.pauseParagraph}|${s.pauseHeading}|${s.pauseLongWord}|${s.longWordLen}`;
    if (!this._cum || this._cumKey !== key) {
      const cum = new Float64Array(n + 1);
      const { flags, FLAG } = this._index;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const L = this._letters[i];
        if (L) acc += durationFrom(s, flags[i], L, FLAG);
        cum[i + 1] = acc;
      }
      this._cum = cum;
      this._cumKey = key;
    }
    from = Math.max(0, Math.min(n, Math.trunc(from) || 0));
    return this._cum[n] - this._cum[from];
  }

  /* ----------------------------------------------------------- internals --- */

  /** Index of the first real (letter/digit-bearing) word from `i` in direction `dir`, or -1. */
  _nextReal(i, dir) {
    const n = this._index?.count ?? 0;
    const L = this._letters;
    for (; i >= 0 && i < n; i += dir) if (L[i]) return i;
    return -1;
  }

  _land(t) {
    this._i = t;
    this._done = false;
    if (this._playing) {
      const now = this._now();
      this._lastFrame = now;
      this._deadline = now + this.durationFor(t);
    }
    this._emitWord();
  }

  _schedule() {
    this._cancel();
    this._frame = this._raf(this._tick);
  }

  _cancel() {
    if (this._frame) { this._caf(this._frame); this._frame = 0; }
  }

  _tick(now) {
    this._frame = 0;
    if (!this._playing) return;
    if (typeof now !== 'number') now = this._now();

    const gap = now - this._lastFrame;
    this._lastFrame = now;
    // A stall (hidden tab, modal, GC pause) is time the reader didn't see:
    // shift the deadline so the current word resumes with its remaining dwell.
    if (gap > STALL_MS) this._deadline += gap;

    let advanced = false;
    let steps = 0;
    while (now >= this._deadline && steps < MAX_CATCHUP) {
      const nx = this._nextReal(this._i + 1, 1);
      if (nx < 0) {
        this._playing = false;
        this._done = true;
        this._emitState();
        return;
      }
      this._i = nx;
      // Settings are read per word, so a wpm change lands on the next word.
      this._deadline += this.durationFor(nx);
      advanced = true;
      steps++;
    }
    // Still behind after the cap: drop the backlog rather than rushing later,
    // and give the word we landed on its full dwell.
    if (now > this._deadline) this._deadline = now + this.durationFor(this._i);

    if (advanced) this._emitWord();
    if (this._playing) this._frame = this._raf(this._tick);
  }

  _emitWord() {
    if (!this._onWord) return;
    try { this._onWord(this._i); }
    catch (e) { console.error('[lucid] pacer onWord failed', e); }
  }

  _emitState() {
    if (!this._onState) return;
    try { this._onState({ playing: this._playing, done: this._done, index: this._i }); }
    catch (e) { console.error('[lucid] pacer onStateChange failed', e); }
  }
}

/**
 * The per-word dwell rule, exported so it can be tested in isolation.
 *
 * Multipliers combine by max, not product: "sentence end + long word" should
 * feel like a sentence end, not a two-second freeze. The heading multiplier is
 * applied at the heading's last word — a pause *after* the title — rather than
 * to every word in it; four times the base dwell on each word of a six-word
 * title would hold the reader for six seconds before the body even starts.
 */
export function durationFrom(s, flags, letters, FLAG) {
  const base = 60000 / Math.max(1, s.wpm);
  let m = 1;
  if (flags & FLAG.CLAUSE) m = Math.max(m, s.pauseComma);
  if (flags & FLAG.SENTENCE) m = Math.max(m, s.pausePeriod);
  if (flags & FLAG.PARA) m = Math.max(m, s.pauseParagraph);
  if ((flags & FLAG.HEADING) && (flags & FLAG.PARA)) m = Math.max(m, s.pauseHeading);
  if (letters >= s.longWordLen) m = Math.max(m, s.pauseLongWord);
  return base * m;
}

/** True when the word carries at least one letter or digit. */
export function isRealWord(word) {
  return !!word && HAS_ALNUM.test(word);
}
