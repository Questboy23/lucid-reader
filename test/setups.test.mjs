import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, BY_KEY, SETTINGS, coerce, normalize, cssVars } from '../reader/lib/schema.js';
import { BUILTINS, SETUP_KEYS, SETUP_EXCLUDE, snapshot, patchOf, matches, makeSetup, builtinSetup, missingBuiltins } from '../reader/lib/setups.js';
import { dimStops, dimGradient } from '../reader/lib/dimgrad.js';

test('every built-in setting is a real key holding an in-range value', () => {
  for (const b of BUILTINS) {
    for (const [k, v] of Object.entries(b.s)) {
      assert.ok(BY_KEY[k], `${b.seed}: unknown key ${k}`);
      assert.equal(coerce(k, v), v, `${b.seed}: ${k}=${v} gets changed by the schema`);
      assert.ok(!SETUP_EXCLUDE.has(k), `${b.seed}: ${k} must not be in a setup`);
    }
  }
});

test('exactly five built-ins, each in a different reading mode or style', () => {
  assert.equal(BUILTINS.length, 5);
  assert.equal(new Set(BUILTINS.map(b => b.seed)).size, 5);
  assert.equal(new Set(BUILTINS.map(b => b.s.defaultMode)).size, 5);
});

test('a setup round-trips: snapshot then patch reproduces the settings', () => {
  for (const b of BUILTINS) {
    const full = normalize({ ...DEFAULTS, ...b.s });
    const st = makeSetup('x', full);
    assert.ok(matches(st, full));
    const patch = patchOf(st);
    for (const k of SETUP_KEYS) assert.equal(patch[k], full[k], `${b.seed}: ${k}`);
  }
});

test('using a setup resets keys it does not mention to the defaults', () => {
  const st = { id: 'a', name: 'a', s: { fontSize: 30 } };
  const patch = patchOf(st);
  assert.equal(patch.fontSize, 30);
  assert.equal(patch.lineHeight, DEFAULTS.lineHeight);
  assert.ok(!('takeover' in patch), 'Lucid on/off must never be changed by a setup');
});

test('snapshot keeps only differences and stays small', () => {
  const s = snapshot({ ...DEFAULTS, wpm: 500 });
  assert.deepEqual(s, { wpm: 500 });
  assert.ok(JSON.stringify(builtinSetup(BUILTINS[0])).length < 1200);
});

test('missingBuiltins only returns seeds the list lacks', () => {
  const have = [builtinSetup(BUILTINS[0]), makeSetup('mine', DEFAULTS)];
  const miss = missingBuiltins(have);
  assert.equal(miss.length, 4);
  assert.ok(!miss.some(m => m.seed === BUILTINS[0].seed));
});

test('wider limits: small text, big zoom, narrow and wide columns, column height', () => {
  assert.equal(coerce('fontSize', 6), 6);
  assert.equal(coerce('zoom', 0.3), 0.3);
  assert.equal(coerce('zoom', 5), 5);
  assert.equal(coerce('columnWidth', 15), 15);
  assert.equal(coerce('columnWidth', 200), 200);
  assert.equal(coerce('columnHeight', 30), 30);
  assert.equal(coerce('columnHeight', 5), 30);
  assert.equal(cssVars({ ...DEFAULTS, columnHeight: 70 })['--r-chh'], '70%');
  assert.equal(cssVars({ ...DEFAULTS, columnPosition: 'left' })['--r-cpos'], 'flex-start');
});

test('paragraph-middle fade only exists when asked for', () => {
  assert.equal(cssVars(DEFAULTS)['--r-mid-c'], 'inherit');
  assert.match(cssVars({ ...DEFAULTS, middleFade: 50 })['--r-mid-c'], /^color-mix\(in srgb, #[0-9a-f]{6} 50%, #[0-9a-f]{6}\)$/);
});

test('"brighter only" first sentence is brighter but not bold', () => {
  const v = cssVars({ ...DEFAULTS, firstSentence: 'bright', sentenceBrightness: 100 });
  assert.equal(v['--r-fs-w'], 'inherit');
  assert.notEqual(v['--r-fs-c'], 'inherit');
});

test('RSVP guide settings produce the CSS variables the stylesheet reads', () => {
  const v = cssVars({ ...DEFAULTS, rsvpGuideLength: 90, rsvpGuideSpread: 38, rsvpGuideGap: 8 });
  assert.equal(v['--r-g-len'], '0.9');
  assert.equal(v['--r-g-spread'], '38%');
  assert.equal(v['--r-g-gap'], '8px');
  assert.equal(v['--r-g-color'], 'var(--r-orp)');
});

test('dim curve starts at zero, ends at full strength and never decreases', () => {
  const stops = dimStops(0.6, 200);
  assert.equal(stops[0][0], 0);
  assert.equal(stops.at(-1)[0], 60);
  assert.equal(stops.at(-1)[1], 200);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i][0] >= stops[i - 1][0]);
  // smoothstep: slope is flat at both ends, so the first step is tiny
  assert.ok(stops[1][0] < 0.05 * 60 * 1.2);
  assert.match(dimGradient(0.6, 200, 'to top'), /^linear-gradient\(to top, /);
});

test('every setting still has a unique key and a section', () => {
  const keys = SETTINGS.map(s => s.key);
  assert.equal(new Set(keys).size, keys.length);
});
