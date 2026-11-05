/**
 * Saved setups: named snapshots of the reading settings, plus five built-in
 * ones tuned for fast reading.
 *
 * A setup stores only the settings that differ from the schema defaults, so a
 * later default change reaches setups for everything they never touched, and
 * each one stays a few hundred bytes. Applying one writes *every* key it
 * covers (defaults for the ones it omits), so using a setup always gives that
 * exact look rather than a blend with whatever was on before.
 *
 * Keys about the extension itself (taking over PDFs, shortcuts, saving
 * position) are never part of a setup: switching looks must not turn Lucid off.
 *
 * Storage is chrome.storage.local (the list can outgrow the 8 kB per-item
 * sync quota), falling back to localStorage so the reader also works served
 * over http while developing.
 */

import { DEFAULTS, SETTINGS, coerce } from './schema.js';

const STORE_KEY = 'lucid.setups';
const VERSION = 1;

export const SETUP_EXCLUDE = new Set([
  'takeover', 'keyboardShortcuts', 'applyInstantly', 'rememberPosition', 'reduceMotion', 'outlineOpen',
]);
export const SETUP_KEYS = SETTINGS.map(s => s.key).filter(k => !SETUP_EXCLUDE.has(k));

/* ------------------------------------------------------------ built-ins --- */
/*
 * Sized for a screen about 30 x 23 cm (12 x 9 in) seen from about 46 cm
 * (18 in). Assuming about 110 CSS pixels per inch, one degree of visual angle
 * is roughly 35 CSS px there, so a 20 px font is about 0.6 degrees tall.
 * That assumption is an estimate: tell it your real screen size and it can be
 * re-tuned. The reasoning behind each one:
 *
 *  - A fixation takes in about 4 letters left of the eye and 14-15 right
 *    (perceptual span, Rayner). Lines of 44-52 characters are 11-13 degrees
 *    wide, so a line is 5-6 fixations and the return sweep stays short.
 *  - Reading speed is flat across print sizes of roughly 0.2 to 2 degrees
 *    (Legge), so size can shrink to fit more letters in one glance until the
 *    letters get too small to resolve.
 *  - Moving guides (a band, a bar, a sweep) set the pace for the eyes, which
 *    cuts regressions and slow re-reads; they do not make fixations shorter.
 *  - No setup here is a measured speed-up. Skilled readers trade speed for
 *    comprehension past roughly 400-500 wpm (Rayner et al. 2016). Start at
 *    the wpm shown, press J/K to find where comprehension starts to slip, and
 *    keep the setup you finish more pages with.
 */
export const BUILTINS = [
  {
    seed: 'fast-flow',
    name: 'Fast Flow',
    s: {
      defaultMode: 'flow', wpm: 450, wpmStep: 25,
      fontFamily: "'Literata', Georgia, serif", fontSize: 21, lineHeight: 1.6, columnWidth: 44,
      bg: '#f6f0e2', fg: '#2b2620', textContrast: 20,
      firstSentence: 'bold', firstSentenceWeight: 800, lastSentence: 'bold', lastSentenceWeight: 800,
      sentenceBrightness: 100, middleFade: 25,
      phraseSpacing: true, phraseGap: 6, phraseMax: 4,
      flowGuide: 'band', flowAnchor: 42, flowBandLines: 1, flowBandStyle: 'fill-rules', flowBandOpacity: 14,
      flowHighlight: 'phrase', flowHighlightOpacity: 24, flowSweep: 'underline',
      flowFadeAbove: 55, flowFadeBelow: 30, flowFadeClear: 1.5, flowFadeSoftness: 35,
      flowScroll: 'continuous', flowGlide: 2,
    },
  },
  {
    seed: 'bionic-auto',
    name: 'Bionic Auto-scroll',
    s: {
      defaultMode: 'autoscroll', wpm: 400,
      fontFamily: "'Inter', system-ui, sans-serif", fontSize: 20, lineHeight: 1.55, columnWidth: 46,
      bg: '#f4f4f0', fg: '#22252a', textContrast: 15,
      bionicOn: true, bionicPercent: 45, bionicMinLen: 3, bionicRemainderOpacity: 70, bionicWeight: 760,
      dimOn: true, dimStyle: 'gradual', dimStrength: 70, dimLines: 3, dimFalloff: 7, dimAnchor: 42,
      pacerAnchor: 40, autoScrollHideWord: true,
      firstSentence: 'off', lastSentence: 'off',
    },
  },
  {
    seed: 'phrase-rsvp',
    name: 'Phrase RSVP',
    s: {
      defaultMode: 'rsvp', wpm: 550, wpmStep: 25,
      phraseMax: 4,
      rsvpPhrase: true, rsvpFontSize: 36, rsvpBg: '#0f172a', rsvpFg: '#f8fafc',
      rsvpOrp: true, rsvpOrpColor: '#f43f5e', rsvpOrpBold: true,
      rsvpShowGuides: true, rsvpGuideStyle: 'funnel', rsvpGuideLength: 90, rsvpGuideSpread: 38,
      rsvpGuideGap: 8, rsvpGuideThickness: 2, rsvpGuideOpacity: 75,
      rsvpShowContext: false, rsvpShowProgress: true,
      pauseComma: 1.3, pausePeriod: 1.7, pauseParagraph: 2, pauseHeading: 3, pauseLongWord: 1.3, longWordLen: 10,
    },
  },
  {
    seed: 'skim-first',
    name: 'Skim First',
    s: {
      defaultMode: 'normal',
      fontSize: 19, lineHeight: 1.5, columnWidth: 52, paragraphSpacing: 18,
      bg: '#ffffff', fg: '#1a1c1f', textContrast: 30,
      firstSentence: 'bold', firstSentenceWeight: 850, lastSentence: 'bold', lastSentenceWeight: 850,
      sentenceBrightness: 100, middleFade: 50,
      numberStyle: 'bold-color', numberColor: '#1d4ed8', nameStyle: 'color', nameColor: '#6d28d9',
      fillerFade: true, fillerOpacity: 60,
    },
  },
  {
    seed: 'dense-readalong',
    name: 'Dense Read-along',
    s: {
      defaultMode: 'readalong', wpm: 350, wpmStep: 25,
      fontFamily: "'Inter', system-ui, sans-serif", fontSize: 16, lineHeight: 1.45, columnWidth: 60,
      fontWeight: 430, textThicken: 0.1,
      bg: '#e9e9e4', fg: '#262824', textContrast: 25,
      pacerColor: '#e11d48', pacerBackground: true, pacerFollow: true, pacerAnchor: 40,
      barOn: true, barColor: '#e11d48', barOpacity: 12, barHeight: 24,
      stripesOn: true, stripeEvery: 3, stripeColor: '#fff59d', stripeOpacity: 20,
      firstSentence: 'bold', firstSentenceWeight: 750, lastSentence: 'off', sentenceBrightness: 100,
    },
  },
];

/* ------------------------------------------------------------- helpers --- */

/** Only the keys that differ from the defaults, after coercion. */
export function snapshot(settings) {
  const out = {};
  for (const k of SETUP_KEYS) {
    if (!(k in settings)) continue;
    const v = coerce(k, settings[k]);
    if (v !== undefined && v !== DEFAULTS[k]) out[k] = v;
  }
  return out;
}

/** The full patch that makes the reader look exactly like this setup. */
export function patchOf(setup) {
  const patch = {};
  for (const k of SETUP_KEYS) {
    patch[k] = Object.prototype.hasOwnProperty.call(setup.s ?? {}, k) ? coerce(k, setup.s[k]) : DEFAULTS[k];
  }
  return patch;
}

/** True when `settings` would produce exactly this setup. */
export function matches(setup, settings) {
  const a = patchOf(setup);
  return SETUP_KEYS.every(k => k in settings ? coerce(k, settings[k]) === a[k] : true);
}

const newId = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function makeSetup(name, settings) {
  return { id: newId(), name: String(name || 'My setup').slice(0, 40), s: snapshot(settings) };
}

export function builtinSetup(b) {
  return { id: newId(), seed: b.seed, name: b.name, s: snapshot(patchFrom(b.s)) };
}
function patchFrom(s) { return { ...DEFAULTS, ...s }; }

/** Built-ins the list doesn't have (by seed), as new setups. */
export function missingBuiltins(list) {
  const have = new Set(list.map(x => x.seed).filter(Boolean));
  return BUILTINS.filter(b => !have.has(b.seed)).map(builtinSetup);
}

/* ------------------------------------------------------------- storage --- */

const hasChromeLocal = typeof chrome !== 'undefined' && chrome.storage?.local;

async function readRaw() {
  try {
    if (hasChromeLocal) return (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] ?? null;
    const t = localStorage.getItem(STORE_KEY);
    return t ? JSON.parse(t) : null;
  } catch { return null; }
}
async function writeRaw(value) {
  try {
    if (hasChromeLocal) await chrome.storage.local.set({ [STORE_KEY]: value });
    else localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch (e) { console.warn('[lucid] saving setups failed', e); }
}

/** The saved list. First run seeds the five built-ins. */
export async function loadSetups() {
  const raw = await readRaw();
  let list = Array.isArray(raw?.list) ? raw.list.filter(x => x && typeof x.id === 'string' && typeof x.name === 'string' && x.s && typeof x.s === 'object') : [];
  if (!raw?.seeded) {
    list = [...missingBuiltins(list), ...list];
    await writeRaw({ v: VERSION, seeded: true, list });
  }
  return list;
}

export function saveSetups(list) {
  return writeRaw({ v: VERSION, seeded: true, list });
}
