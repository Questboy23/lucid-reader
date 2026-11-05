/**
 * Settings persistence + application.
 *
 * Saved values are always run through the schema's `normalize`, so a stale or
 * hand-edited store can never put the reader into an impossible state — the
 * worst case is a setting silently falling back to its default.
 *
 * chrome.storage.sync carries settings between the user's machines; the whole
 * object is a couple of kB, well inside the 8 kB per-item quota. Reading
 * position is high-churn and device-specific, so it lives in storage.local.
 */

import { DEFAULTS, normalize, cssVars, SETTINGS } from './schema.js';

const KEY = 'settings';
const hasChrome = typeof chrome !== 'undefined' && chrome.storage;

/** storage.sync with a graceful fall back to local, then memory. */
const backend = (() => {
  if (!hasChrome) {
    let mem = {};
    return {
      async get(k) { return { [k]: mem[k] }; },
      async set(o) { Object.assign(mem, o); },
      onChanged: { addListener() {} },
    };
  }
  return {
    async get(k) {
      try { return await chrome.storage.sync.get(k); }
      catch { return await chrome.storage.local.get(k); }
    },
    async set(o) {
      try { await chrome.storage.sync.set(o); }
      catch { await chrome.storage.local.set(o); }
    },
    onChanged: chrome.storage.onChanged,
  };
})();

let current = { ...DEFAULTS };
const listeners = new Set();

export function get() {
  return current;
}

export async function load() {
  const got = await backend.get(KEY);
  const raw = { ...(got?.[KEY] ?? {}) };
  // v2: bolder first sentence, last sentence bold too (older saves had 650 / off).
  if ((raw._v ?? 1) < 2) {
    if (!(raw.firstSentenceWeight > 650)) raw.firstSentenceWeight = 800;
    if (!raw.lastSentence || raw.lastSentence === 'off') raw.lastSentence = raw.firstSentence && raw.firstSentence !== 'off' ? raw.firstSentence : 'bold';
    if (!(raw.lastSentenceWeight > 650)) raw.lastSentenceWeight = 800;
  }
  current = normalize(raw);
  if ((raw._v ?? 1) < 2) backend.set({ [KEY]: { ...current, _v: 2 } }).catch(() => {});
  return current;
}

/** Merge a patch, persist, notify. Returns the new settings. */
export async function save(patch) {
  const next = normalize({ ...current, ...patch });
  const changed = SETTINGS.filter(s => next[s.key] !== current[s.key]).map(s => s.key);
  current = next;
  // Show the change first, write it to disk after. Chrome's synced storage
  // takes tens of ms per write and allows only 120 writes a minute, so a
  // slider drag used to wait on it (and then hit the limit).
  if (changed.length) emit(changed);
  persistSoon();
  return next;
}

let persistTimer = 0;
let persistDone = Promise.resolve();
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistDone = backend.set({ [KEY]: { ...current, _v: 2 } }).catch(e => console.warn('[lucid] settings save failed', e));
  }, 400);
}
/** Resolves once the latest settings are on disk (used before leaving the page). */
export function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; persistDone = backend.set({ [KEY]: { ...current, _v: 2 } }); }
  return persistDone;
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { flush(); });

/** Reset everything, or only the given keys, to schema defaults. */
export async function reset(keys) {
  const patch = {};
  for (const k of keys ?? Object.keys(DEFAULTS)) patch[k] = DEFAULTS[k];
  return save(patch);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(changedKeys) {
  for (const fn of listeners) {
    try { fn(current, changedKeys); }
    catch (e) { console.error('[lucid] settings listener failed', e); }
  }
}

// Another tab (or the options page) changing settings updates this one live.
backend.onChanged.addListener((changes, area) => {
  if (!changes[KEY] || (area !== 'sync' && area !== 'local')) return;
  const next = normalize(changes[KEY].newValue ?? {});
  const changed = SETTINGS.filter(s => next[s.key] !== current[s.key]).map(s => s.key);
  if (!changed.length) return;
  current = next;
  emit(changed);
});

/**
 * Write a settings object onto an element as CSS custom properties.
 * Used both for the reader root and for the panel's live preview box, which is
 * why it takes an explicit element instead of assuming :root.
 */
const lastVars = new WeakMap();
export function applyCssVars(el, s = current) {
  const vars = cssVars(s);
  // Only touch variables that changed: each write on the root can make
  // Chrome restyle every word in the book.
  let seen = lastVars.get(el);
  if (!seen) { seen = new Map(); lastVars.set(el, seen); }
  for (const [k, v] of Object.entries(vars)) {
    if (seen.get(k) === v) continue;
    seen.set(k, v);
    el.style.setProperty(k, v);
  }
}

/* ------------------------------------------------- reading position memory */

const posStore = hasChrome ? chrome.storage.local : null;

function posKey(docId) { return `pos:${docId}`; }

export async function loadPosition(docId) {
  if (!posStore || !docId) return null;
  try {
    const got = await posStore.get(posKey(docId));
    const v = got[posKey(docId)];
    return v && typeof v.word === 'number' ? v : null;
  } catch { return null; }
}

export async function savePosition(docId, pos) {
  if (!posStore || !docId || !current.rememberPosition) return;
  try { await posStore.set({ [posKey(docId)]: { ...pos, at: Date.now() } }); }
  catch { /* quota — not worth surfacing */ }
}

/** Keep the position store from growing without bound. */
export async function prunePositions(max = 200) {
  if (!posStore) return;
  try {
    const all = await posStore.get(null);
    const entries = Object.entries(all).filter(([k]) => k.startsWith('pos:'));
    if (entries.length <= max) return;
    entries.sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0));
    const drop = entries.slice(0, entries.length - max).map(([k]) => k);
    await posStore.remove(drop);
  } catch { /* ignore */ }
}
