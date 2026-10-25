/**
 * Remembers each extracted document (text blocks plus figure images) in
 * IndexedDB, keyed by the PDF's own fingerprint. Reopening a 500-page book
 * then skips the 10-20 s of extraction and figure capture entirely.
 *
 * Bump VERSION whenever extract.js or figures.js change what they produce,
 * so stale results are ignored instead of shown.
 */

const DB = 'lucid-cache';
const STORE = 'docs';
const VERSION = 3;
const KEEP = 20;          // most recently opened documents kept

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(e => { console.warn('[lucid] cache unavailable', e); return null; });
  return dbp;
}

function tx(d, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const cacheKey = fingerprint => (fingerprint ? `v${VERSION}:${fingerprint}` : null);

/** Doc with figure srcs turned back into fresh object URLs, or null. */
export async function loadDoc(key) {
  if (!key) return null;
  try {
    const d = await db();
    if (!d) return null;
    const rec = await tx(d, 'readonly', s => s.get(key));
    if (!rec?.doc) return null;
    rec.at = Date.now();
    tx(d, 'readwrite', s => s.put(rec, key)).catch(() => {});
    const urls = [];
    for (const b of rec.doc.blocks) {
      if (b.type === 'figure' && b.blob) { b.src = URL.createObjectURL(b.blob); urls.push(b.src); delete b.blob; }
    }
    return { doc: rec.doc, urls };
  } catch (e) {
    console.warn('[lucid] cache read failed', e);
    return null;
  }
}

/** blobFor(src) returns the image Blob behind a figure's object URL. */
export async function saveDoc(key, doc, blobFor) {
  if (!key) return;
  try {
    const d = await db();
    if (!d) return;
    const blocks = doc.blocks.map(b => {
      if (b.type !== 'figure') return b;
      const { src, ...rest } = b;
      return { ...rest, blob: blobFor(src) ?? null };
    });
    await tx(d, 'readwrite', s => s.put({ at: Date.now(), doc: { ...doc, blocks } }, key));
    prune(d);
  } catch (e) {
    console.warn('[lucid] cache write failed', e);
  }
}

async function prune(d) {
  try {
    const keys = await tx(d, 'readonly', s => s.getAllKeys());
    if (!keys || keys.length <= KEEP) return;
    const recs = await Promise.all(keys.map(k => tx(d, 'readonly', s => s.get(k)).then(r => [k, r?.at ?? 0])));
    recs.sort((a, b) => a[1] - b[1]);
    const drop = recs.slice(0, recs.length - KEEP).map(([k]) => k);
    await tx(d, 'readwrite', s => { for (const k of drop) s.delete(k); });
  } catch { /* best effort */ }
}
