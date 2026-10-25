import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer, durationFrom, isRealWord } from '../reader/lib/pacer.js';
import { FLAG } from '../reader/lib/markup.js';
import { DEFAULTS } from '../reader/lib/schema.js';

/* A word index built the way markup.js builds one, minus the DOM. */
function makeIndex(blocks) {
  const text = [], flags = [], blockOf = [];
  blocks.forEach((b, bi) => {
    const words = b.text.split(/\s+/).filter(Boolean);
    words.forEach((w, wi) => {
      let f = 0;
      if (/[,;:—–]$/.test(w)) f |= FLAG.CLAUSE;
      if (/[.!?…]$/.test(w)) f |= FLAG.SENTENCE;
      if (wi === words.length - 1) f |= FLAG.PARA;
      if (b.type === 'h1') f |= FLAG.HEADING;
      text.push(w); flags.push(f); blockOf.push(bi);
    });
  });
  return {
    count: text.length, text, flags: Uint8Array.from(flags),
    blockOf: Int32Array.from(blockOf), pageOf: new Int32Array(text.length),
    spans: text.map(() => ({})), blockEls: [], FLAG,
  };
}

/* A deterministic clock: frames run only when the test says so. */
function makeClock() {
  let t = 0;
  const queue = [];
  return {
    now: () => t,
    raf: cb => { queue.push(cb); return queue.length; },
    caf: () => { queue.length = 0; },
    /** Advance time by ms and run one frame at the new time. */
    frame(ms) {
      t += ms;
      const cbs = queue.splice(0);
      for (const cb of cbs) cb(t);
    },
  };
}

function build(blocks, overrides = {}, clock = makeClock()) {
  const settings = { ...DEFAULTS, ...overrides };
  const words = [];
  const states = [];
  const index = makeIndex(blocks);
  const pacer = new Pacer({
    index,
    getSettings: () => settings,
    onWord: i => words.push(i),
    onStateChange: s => states.push({ ...s }),
    raf: clock.raf, caf: clock.caf, now: clock.now,
  });
  return { pacer, settings, words, states, clock, index };
}

const PROSE = [
  { type: 'h1', text: 'A short heading' },
  { type: 'p', text: 'Hello, world. This — is extraordinarily long-winded prose.' },
  { type: 'p', text: '• Second paragraph!' },
];

test('durationFor: base delay, largest multiplier wins, long words by letter count', () => {
  const { pacer, settings, index } = build(PROSE, { wpm: 300 });
  const base = 60000 / 300;
  const at = w => index.text.indexOf(w);

  assert.equal(pacer.durationFor(at('This')), base);
  assert.equal(pacer.durationFor(at('Hello,')), base * settings.pauseComma);
  // "world." ends a sentence; not a paragraph, not long.
  assert.equal(pacer.durationFor(at('world.')), base * settings.pausePeriod);
  // paragraph end + sentence end: max, not product
  assert.equal(pacer.durationFor(at('prose.')), base * Math.max(settings.pausePeriod, settings.pauseParagraph));
  // long word threshold follows longWordLen, not the index's fixed LONG flag
  assert.equal(pacer.durationFor(at('extraordinarily')), base * settings.pauseLongWord);
  settings.longWordLen = 20;
  assert.equal(pacer.durationFor(at('extraordinarily')), base);
  settings.longWordLen = 9;
  // "long-winded" has 10 letters
  assert.equal(pacer.durationFor(at('long-winded')), base * settings.pauseLongWord);
});

test('durationFor: heading pause lands on the heading\'s last word only', () => {
  const { pacer, settings, index } = build(PROSE, { wpm: 300 });
  const base = 60000 / 300;
  assert.equal(pacer.durationFor(index.text.indexOf('short')), base);
  assert.equal(pacer.durationFor(index.text.indexOf('heading')), base * settings.pauseHeading);
});

test('durationFrom: multipliers never multiply together', () => {
  const s = { ...DEFAULTS, wpm: 600, pauseComma: 2, pausePeriod: 3, pauseParagraph: 4, pauseLongWord: 3, longWordLen: 5 };
  const all = FLAG.CLAUSE | FLAG.SENTENCE | FLAG.PARA;
  assert.equal(durationFrom(s, all, 12, FLAG), 100 * 4);
  assert.equal(durationFrom(s, 0, 12, FLAG), 100 * 3);
  assert.equal(durationFrom(s, 0, 2, FLAG), 100);
});

test('stray glyphs are not words: duration 0, seek/step skip them both ways', () => {
  assert.equal(isRealWord('—'), false);
  assert.equal(isRealWord('•'), false);
  assert.equal(isRealWord('(a)'), true);
  assert.equal(isRealWord('42'), true);

  const { pacer, words, index } = build(PROSE);
  const dash = index.text.indexOf('—');
  const bullet = index.text.indexOf('•');
  assert.equal(pacer.durationFor(dash), 0);
  assert.equal(pacer.durationFor(bullet), 0);

  pacer.seek(dash);
  assert.equal(pacer.index, dash + 1, 'seek lands on the next real word');
  pacer.step(-1);
  assert.equal(pacer.index, dash - 1, 'stepping back hops over the glyph');
  pacer.step(2);
  assert.equal(pacer.index, dash + 2);

  pacer.seek(bullet);
  assert.equal(index.text[pacer.index], 'Second');
  pacer.step(-1);
  assert.equal(index.text[pacer.index], 'prose.');
  assert.ok(words.every(i => isRealWord(index.text[i])), 'onWord never sees a glyph');
});

test('step clamps at both ends without wrapping', () => {
  const { pacer, index } = build(PROSE);
  pacer.step(-5);
  assert.equal(pacer.index, 0);
  pacer.step(1000);
  assert.equal(pacer.index, index.count - 1);
  assert.equal(pacer.done, false, 'stepping to the end does not mark done');
});

test('playback advances on deadlines and carries the remainder', () => {
  const clock = makeClock();
  const { pacer, words } = build([{ type: 'p', text: 'one two three four five six' }], { wpm: 600 }, clock);
  // base dwell 100ms; no punctuation, so every word except the last is exactly 100ms
  pacer.play();
  assert.deepEqual(words, [0], 'play shows the first word immediately');
  clock.frame(16);
  clock.frame(16);
  assert.deepEqual(words, [0]);
  clock.frame(70);            // t = 102 -> word 1 (deadline was 100; 2ms carried)
  assert.deepEqual(words, [0, 1]);
  clock.frame(96);            // t = 198 -> still 1 (deadline 200)
  assert.deepEqual(words, [0, 1]);
  clock.frame(4);             // t = 202 -> word 2
  assert.deepEqual(words, [0, 1, 2]);
});

test('a long frame gap (hidden tab) does not replay the backlog', () => {
  const clock = makeClock();
  const { pacer, words } = build(
    [{ type: 'p', text: Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ') }],
    { wpm: 1200 }, clock);   // 50ms per word
  pacer.play();
  clock.frame(16);
  clock.frame(60_000);         // a minute in the background
  assert.deepEqual(words, [0], 'a stall freezes the clock instead of advancing');
  // after the stall the current word still has its remaining dwell
  clock.frame(20);
  assert.deepEqual(words, [0]);
  clock.frame(20);             // 16 + 20 + 20 = 56ms of visible time > 50
  assert.deepEqual(words, [0, 1]);
});

test('a moderate jank catches up by a few words at most', () => {
  const clock = makeClock();
  const { pacer, words } = build(
    [{ type: 'p', text: Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ') }],
    { wpm: 1200 }, clock);   // 50ms per word
  pacer.play();
  clock.frame(350);            // 7 words overdue, but under the stall threshold
  assert.ok(words.length - 1 <= 3, `advanced ${words.length - 1} words, expected at most 3`);
  assert.ok(words.length - 1 >= 1);
  const last = pacer.index;
  // the backlog is dropped: the next frame does not keep rushing
  clock.frame(16);
  assert.equal(pacer.index, last);
});

test('a wpm change while playing takes effect on the next word', () => {
  const clock = makeClock();
  const { pacer, settings, words } = build([{ type: 'p', text: 'a b c d e' }], { wpm: 600 }, clock);
  pacer.play();
  clock.frame(50);
  settings.wpm = 300;          // 200ms per word from now on
  clock.frame(52);             // t = 102: word 1 (its dwell was set at 100ms)
  assert.deepEqual(words, [0, 1]);
  clock.frame(150);            // t = 252: word 1's dwell is 200ms -> still 1
  assert.deepEqual(words, [0, 1]);
  clock.frame(60);             // t = 312 > 302 -> word 2
  assert.deepEqual(words, [0, 1, 2]);
});

test('reaching the end pauses, sets done, and play restarts from the top', () => {
  const clock = makeClock();
  const { pacer, words, states } = build([{ type: 'p', text: 'x y' }], { wpm: 600 }, clock);
  pacer.play();
  clock.frame(101);            // -> y
  assert.equal(pacer.index, 1);
  clock.frame(200);            // y's dwell is 100 * pauseParagraph = 220ms
  clock.frame(200);            // (two frames: one 500ms gap would read as a stall)
  assert.equal(pacer.playing, false);
  assert.equal(pacer.done, true);
  assert.deepEqual(states.at(-1), { playing: false, done: true, index: 1 });
  pacer.play();
  assert.equal(pacer.index, 0);
  assert.equal(pacer.done, false);
  assert.equal(words.at(-1), 0);
});

test('remainingMs matches the sum of durations and tracks setting changes', () => {
  const { pacer, settings, index } = build(PROSE, { wpm: 250 });
  const sum = from => {
    let t = 0;
    for (let i = from; i < index.count; i++) t += pacer.durationFor(i);
    return t;
  };
  assert.ok(Math.abs(pacer.remainingMs(0) - sum(0)) < 1e-6);
  pacer.seek(5);
  assert.ok(Math.abs(pacer.remainingMs() - sum(5)) < 1e-6);
  settings.wpm = 500;
  assert.ok(Math.abs(pacer.remainingMs(0) - sum(0)) < 1e-6, 'cache invalidates on wpm change');
  settings.pauseHeading = 8;
  assert.ok(Math.abs(pacer.remainingMs(0) - sum(0)) < 1e-6, 'cache invalidates on multiplier change');
  assert.equal(pacer.remainingMs(index.count), 0);
});

test('stepLine uses the overlay line map and lands on a real word', () => {
  const { pacer, index } = build(PROSE);
  // Pretend each block is one line.
  const overlay = {
    lineOfWord: i => index.blockOf[i],
    lineCount: () => 3,
    wordRangeOfLine: n => {
      const first = index.blockOf.indexOf(n);
      const last = index.blockOf.lastIndexOf(n);
      return [first, last];
    },
  };
  pacer.seek(0);
  pacer.stepLine(1, overlay);
  assert.equal(index.text[pacer.index], 'Hello,');
  pacer.stepLine(1, overlay);
  assert.equal(index.text[pacer.index], 'Second', 'the line starts with "•", which is skipped');
  pacer.stepLine(1, overlay);
  assert.equal(index.text[pacer.index], 'Second', 'no line below: stays put');
  pacer.stepLine(-2, overlay);
  assert.equal(pacer.index, 0);
  pacer.stepLine(-1, overlay);
  assert.equal(pacer.index, 0);
  // a broken overlay is tolerated
  pacer.stepLine(1, { lineOfWord() { throw new Error('nope'); } });
  assert.equal(pacer.index, 0);
});

test('an empty index is inert', () => {
  const { pacer, words, states } = build([]);
  pacer.play();
  pacer.step(1);
  pacer.seek(3);
  assert.equal(pacer.playing, false);
  assert.equal(pacer.remainingMs(), 0);
  assert.equal(pacer.durationFor(0), 0);
  assert.deepEqual(words, []);
  assert.deepEqual(states, []);
});
