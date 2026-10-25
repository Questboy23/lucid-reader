/**
 * The schema is the contract the whole extension leans on, so the coercion and
 * CSS-variable mapping are worth testing directly: a bad value reaching the
 * reader shows up as a silently broken control, not an exception.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS, SECTIONS, BY_KEY, DEFAULTS, SECTION_KEYS, PRESETS, FONTS,
  coerce, normalize, cssVars, activePreset,
} from '../reader/lib/schema.js';
import { bionicSplit } from '../reader/lib/markup.js';

test('every setting is well-formed', () => {
  const seen = new Set();
  for (const s of SETTINGS) {
    assert.ok(s.key, 'setting needs a key');
    assert.ok(!seen.has(s.key), `duplicate key ${s.key}`);
    seen.add(s.key);
    assert.ok(s.label, `${s.key} needs a label`);
    assert.ok(SECTIONS.some(sec => sec.id === s.section), `${s.key} has an unknown section`);
    assert.notStrictEqual(s.def, undefined, `${s.key} needs a default`);

    if (s.type === 'range' || s.type === 'number') {
      assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max) && s.step > 0,
        `${s.key} needs min/max/step`);
      assert.ok(s.def >= s.min && s.def <= s.max, `${s.key} default is out of range`);
      // A default that isn't on the step grid would move the moment it round-trips.
      assert.equal(coerce(s.key, s.def), s.def, `${s.key} default is not on its step grid`);
    }
    if (s.type === 'select') {
      assert.ok(Array.isArray(s.options) && s.options.length, `${s.key} needs options`);
      assert.ok(s.options.some(o => o.value === s.def), `${s.key} default is not an option`);
    }
    if (s.type === 'bool') assert.equal(typeof s.def, 'boolean');
    if (s.type === 'color') {
      assert.ok(/^#[0-9a-f]{6}$/.test(s.def) || (s.def === '' && s.nullable),
        `${s.key} colour default must be a 6-digit hex (or empty when nullable)`);
    }
  }
});

test('every section has at least one setting, and every setting a section', () => {
  for (const sec of SECTIONS) {
    assert.ok(SECTION_KEYS[sec.id]?.length, `section ${sec.id} is empty`);
  }
  const covered = new Set(Object.values(SECTION_KEYS).flat());
  assert.equal(covered.size, SETTINGS.length);
});

test('coerce clamps, snaps and rejects nonsense', () => {
  assert.equal(coerce('fontSize', 999), BY_KEY.fontSize.max);
  assert.equal(coerce('fontSize', -5), BY_KEY.fontSize.min);
  assert.equal(coerce('fontSize', '23'), 23);
  assert.equal(coerce('fontSize', 'banana'), BY_KEY.fontSize.def);
  assert.equal(coerce('lineHeight', 1.6234), 1.6, 'snaps to the 0.05 grid');
  assert.equal(coerce('bionicOn', 'true'), true);
  assert.equal(coerce('bionicOn', 0), false);
  assert.equal(coerce('alignment', 'sideways'), 'left', 'unknown option falls back');
  assert.equal(coerce('bg', '#ABCDEF'), '#abcdef');
  assert.equal(coerce('bg', 'red'), BY_KEY.bg.def, 'named colours are not accepted');
  assert.equal(coerce('bionicColor', ''), '', 'nullable colour keeps empty');
  assert.equal(coerce('bg', ''), BY_KEY.bg.def, 'non-nullable colour does not');
  assert.equal(coerce('nope', 1), undefined);
});

test('normalize fills gaps and survives hostile input', () => {
  const n = normalize({ fontSize: 1e9, alignment: 'nope', extra: 'ignored' });
  assert.equal(n.fontSize, BY_KEY.fontSize.max);
  assert.equal(n.alignment, 'left');
  assert.equal(Object.keys(n).length, SETTINGS.length, 'no stray keys, no missing keys');
  assert.deepEqual(normalize({}), DEFAULTS);
  assert.deepEqual(normalize(null), DEFAULTS);
  assert.deepEqual(normalize(undefined), DEFAULTS);
});

test('cssVars produces usable CSS for every var-backed setting', () => {
  const vars = cssVars(DEFAULTS);
  for (const s of SETTINGS.filter(x => x.cssVar)) {
    const v = vars[s.cssVar];
    assert.equal(typeof v, 'string', `${s.key} produced no string`);
    assert.ok(v.length > 0, `${s.key} produced an empty value`);
    assert.ok(!/undefined|NaN|\[object/.test(v), `${s.key} produced ${v}`);
  }
  assert.equal(vars['--r-fs'], '19px');
  assert.equal(vars['--r-zoom'], '1');
  assert.equal(vars['--r-cw'], '68ch');
  assert.equal(vars['--r-hyphens'], 'manual');
  assert.equal(vars['--r-bi-color'], 'inherit', 'an empty colour means inherit');
  assert.equal(cssVars({ ...DEFAULTS, hyphenate: true })['--r-hyphens'], 'auto');
  assert.equal(cssVars({ ...DEFAULTS, stripeOpacity: 25 })['--r-stripe-op'], '0.25');
  assert.equal(cssVars({ ...DEFAULTS, bionicColor: '#ff0000' })['--r-bi-color'], '#ff0000');
});

test('first-letter bold derives its weight from the body weight without exceeding 900', () => {
  assert.equal(cssVars({ ...DEFAULTS, firstLetterBold: true, fontWeight: 400 })['--r-fl-weight'], '700');
  assert.equal(cssVars({ ...DEFAULTS, firstLetterBold: true, fontWeight: 800 })['--r-fl-weight'], '900');
  assert.equal(cssVars({ ...DEFAULTS, firstLetterBold: false })['--r-fl-weight'], 'inherit');
});

test('presets are distinct and the default settings match one of them', () => {
  const ids = new Set(PRESETS.map(p => p.id));
  assert.equal(ids.size, PRESETS.length);
  for (const p of PRESETS) {
    assert.ok(/^#[0-9a-f]{6}$/.test(p.bg) && /^#[0-9a-f]{6}$/.test(p.fg), `${p.id} has bad colours`);
  }
  assert.ok(activePreset(DEFAULTS), 'defaults should sit on a named preset');
  assert.equal(activePreset({ ...DEFAULTS, bg: '#123456' }), null);
});

test('font options are unique and the default font family is offered', () => {
  const stacks = FONTS.flatMap(g => g.items.map(([, stack]) => stack));
  assert.equal(new Set(stacks).size, stacks.length, 'duplicate font stack');
  assert.ok(stacks.includes(DEFAULTS.fontFamily), 'default font is not in the list');
  assert.ok(stacks.length >= 30, `expected a generous font list, got ${stacks.length}`);
});

test('bionic split bolds a sensible prefix and ignores punctuation', () => {
  assert.equal('reading'.slice(0, bionicSplit('reading', 40)), 'rea');
  assert.equal('a'.slice(0, bionicSplit('a', 40)), 'a', 'a one-letter word still bolds');
  assert.equal(bionicSplit('—', 40), 0, 'no letters means no split');
  // Leading punctuation must not eat into the letter budget: "quoted" is six
  // letters, so half of it is three, and the quote mark comes along for free.
  assert.equal('"quoted'.slice(0, bionicSplit('"quoted', 50)), '"quo');
  assert.equal(bionicSplit('word', 100), 4);
  assert.ok(bionicSplit('counterrevolutionary', 40) >= 7);
});
