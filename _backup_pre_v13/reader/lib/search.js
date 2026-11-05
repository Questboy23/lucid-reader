/**
 * Find in the reflowed text, like Cmd+F: a bar under the top bar, every match
 * highlighted, "3 of 12", Enter / Shift+Enter to step, Escape to close.
 *
 * Searches the word index rather than the DOM, so a phrase that wraps across
 * lines, or across a link, still matches. Matching ignores case and
 * punctuation at word edges ("model," matches "model").
 */

const norm = w => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function findMatches(text, query) {
  const q = query.trim().split(/\s+/).map(norm).filter(Boolean);
  if (!q.length) return [];
  const out = [];
  const n = text.length, m = q.length;
  for (let i = 0; i + m <= n; i++) {
    let ok = true;
    for (let k = 0; k < m && ok; k++) {
      const w = norm(text[i + k]);
      // The last query word may be partial, so typing "algo" finds "algorithm".
      ok = k === m - 1 ? w.startsWith(q[k]) : w === q[k];
    }
    if (ok) out.push([i, i + m - 1]);
  }
  return out;
}

export function createSearch({ host, getIndex, getPosition, onGo }) {
  const bar = document.createElement('div');
  bar.id = 'searchbar';
  bar.hidden = true;
  bar.innerHTML = `
    <input type="search" placeholder="Find in document" aria-label="Find in document" spellcheck="false">
    <span class="sb-count" aria-live="polite"></span>
    <button class="sb-prev" title="Previous (Shift+Enter)" aria-label="Previous match">↑</button>
    <button class="sb-next" title="Next (Enter)" aria-label="Next match">↓</button>
    <button class="sb-x" title="Close (Esc)" aria-label="Close search">✕</button>`;
  host.appendChild(bar);
  const input = bar.querySelector('input');
  const count = bar.querySelector('.sb-count');

  let hits = [];
  let cur = -1;
  let marked = [];
  let timer = 0;

  function clearMarks() {
    for (const s of marked) s.classList.remove('sr-hit', 'sr-cur');
    marked = [];
  }

  function paint() {
    const idx = getIndex();
    clearMarks();
    if (!idx) return;
    hits.forEach(([a, b], k) => {
      for (let i = a; i <= b; i++) {
        const s = idx.spans[i];
        if (!s) continue;
        s.classList.add('sr-hit');
        if (k === cur) s.classList.add('sr-cur');
        marked.push(s);
      }
    });
    count.textContent = input.value.trim()
      ? (hits.length ? `${cur + 1} of ${hits.length}` : 'No matches')
      : '';
  }

  function run() {
    const idx = getIndex();
    hits = idx ? findMatches(idx.text, input.value) : [];
    // Start from the first match at or after where you are reading.
    const pos = getPosition();
    cur = hits.length ? Math.max(0, hits.findIndex(([a]) => a >= pos)) : -1;
    if (hits.length && cur < 0) cur = 0;
    paint();
    if (cur >= 0) onGo(hits[cur][0]);
  }

  function step(d) {
    if (!hits.length) return;
    cur = (cur + d + hits.length) % hits.length;
    paint();
    onGo(hits[cur][0]);
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); if (!hits.length) run(); else step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); api.close(); }
    e.stopPropagation();          // reading shortcuts must not fire while typing
  });
  bar.querySelector('.sb-prev').addEventListener('click', () => step(-1));
  bar.querySelector('.sb-next').addEventListener('click', () => step(1));
  bar.querySelector('.sb-x').addEventListener('click', () => api.close());

  const api = {
    open() {
      bar.hidden = false;
      input.focus();
      input.select();
      if (input.value.trim()) run();
    },
    close() {
      bar.hidden = true;
      clearMarks();
      count.textContent = '';
      input.blur();
    },
    isOpen: () => !bar.hidden,
    /** The document was re-rendered: spans changed, so search again. */
    refresh() { if (!bar.hidden && input.value.trim()) { hits = []; run(); } else clearMarks(); },
  };
  return api;
}
