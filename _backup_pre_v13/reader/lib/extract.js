/**
 * Turns pdf.js text content into the Doc model described in CONTRACT.md.
 *
 * pdf.js hands us a bag of positioned strings per page, in content-stream
 * order, with no notion of lines, columns or paragraphs. Everything here is
 * about recovering those from geometry, because the font metadata is thin:
 * `styles[fontName]` only carries a generic fallback family and `fontName`
 * is an internal id (`g_d0_f3`), so boldness cannot be read off a name and
 * has to be inferred from size and from font *identity* (a rarely used font
 * on a short line is almost always a heading or a lead-in).
 *
 * The pipeline is a chain of pure functions over plain objects so it can be
 * unit-tested without pdf.js or a DOM:
 *
 *   items --groupIntoLines--> rows
 *         --findRunningHeads / isPageNumber--> rows minus furniture
 *         --detectColumns--> lines in reading order (col/band tagged)
 *         --computeStats--> body size, line pitch, heading sizes
 *         --joinLines--> blocks
 *
 * Coordinates are PDF user space throughout: y grows upward, so "the line
 * above" has the larger y.
 */

/* ---------------------------------------------------------------- utils --- */

const r1 = v => Math.round(v * 2) / 2;            // sizes are compared at 0.5pt
const median = arr => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
const bump = (map, k, n) => map.set(k, (map.get(k) || 0) + n);
/** Key with the largest count; ties go to the larger key (so sizes prefer the bigger font). */
function argmaxKey(map) {
  let best, bestN = -1;
  for (const [k, n] of map) if (n > bestN || (n === bestN && k > best)) { best = k; bestN = n; }
  return best;
}

const TRAILING_CLOSERS = /[")'\]}»”’]+$/;
const endsSentence = t => /[.!?…]$/.test(t.replace(TRAILING_CLOSERS, ''));
const endsPunct = t => /[.!?…,;:]$/.test(t.replace(TRAILING_CLOSERS, ''));
const startsLower = t => /^[^\p{L}]*\p{Ll}/u.test(t);

/* ---------------------------------------------------------------- fonts --- */

const BOLD_RE = /bold|black|heavy|semibold|demibold|extrabold|ultrabold|(?:^|[-_ ,])(?:bd|hv|blk)(?:$|[-_ ,])/i;
const MONO_RE = /mono|courier|consolas|menlo|monaco|typewriter|\bcode\b/i;

/** Best-effort boldness from whatever pdf.js exposes; false for opaque ids. */
export function isBoldFont(fontName, style) {
  const w = style?.fontWeight;
  if (w != null && (typeof w === 'number' ? w >= 600 : /bold|[6-9]00/i.test(String(w)))) return true;
  return BOLD_RE.test(String(fontName ?? '')) || BOLD_RE.test(String(style?.fontFamily ?? ''));
}

export function isMonoFont(fontName, style) {
  if (style?.fontFamily === 'monospace') return true;
  return MONO_RE.test(String(fontName ?? '')) || MONO_RE.test(String(style?.fontFamily ?? ''));
}

/* ---------------------------------------------------------------- lines --- */

const DINGBAT_RUN = /^(\p{L})\1{4,}$/u;

/**
 * Build one Line from a set of glyph items (already known to share a baseline).
 * Line = { y, x0, x1, size, text, chars, bold, mono, font, items, col, band, spanning }
 */
function makeLine(items) {
  const sorted = items.slice().sort((a, b) => a.x0 - b.x0 || a.y - b.y);
  // Words are built as tokens rather than one string so a link can stay
  // attached to exactly the words it covers.
  const words = [];
  let newWord = true;
  let chars = 0, boldChars = 0, monoChars = 0;
  const bySize = new Map(), byFont = new Map();
  const kept = [];
  let prev = null;
  for (const it of sorted) {
    if (prev) {
      // Some producers fake bold by printing a run twice with a hairline offset.
      if (it.str === prev.str && Math.abs(it.x0 - prev.x0) < 0.3 * prev.size && it.x1 < prev.x1 + 0.3 * prev.size) continue;
      // pdf.js usually emits word spaces itself; the gap test covers producers that don't.
      if (it.x0 - prev.x1 > 0.12 * Math.min(it.size, prev.size)) newWord = true;
    }
    for (const part of it.str.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { newWord = true; continue; }
      if (newWord || !words.length) words.push({ t: part, href: it.href ?? null });
      else { const w = words[words.length - 1]; w.t += part; w.href = w.href || it.href || null; }
      newWord = false;
    }
    const n = it.str.replace(/\s+/g, '').length;
    chars += n;
    if (it.bold) boldChars += n;
    if (it.mono) monoChars += n;
    bump(bySize, r1(it.size), n);
    bump(byFont, it.font, n);
    kept.push(it);
    prev = it;
  }
  // Symbol-font rating bars ("nnnnnnnnnn" in ZapfDingbats) are not words.
  const real = words.filter(w => !DINGBAT_RUN.test(w.t));
  const text = real.map(w => w.t).join(' ');
  if (!text || !kept.length) return null;
  const hrefs = real.some(w => w.href) ? real.map(w => w.href) : null;
  const size = argmaxKey(bySize);
  // Baseline from the dominant-size items only, so superscripts don't pull it.
  let ys = 0, ws = 0;
  for (const it of kept) {
    if (Math.abs(r1(it.size) - size) <= 0.5) { const w = it.str.length || 1; ys += it.y * w; ws += w; }
  }
  return {
    y: ws ? ys / ws : kept[0].y,
    x0: Math.min(...kept.map(i => i.x0)),
    x1: Math.max(...kept.map(i => i.x1)),
    size, text, chars, hrefs,
    bold: chars > 0 && boldChars >= 0.8 * chars,
    mono: chars > 0 && monoChars >= 0.8 * chars,
    font: argmaxKey(byFont),
    items: kept,
    col: 0, band: 0, spanning: false,
  };
}

/**
 * Group pdf.js text items into visual rows (top to bottom, then left to
 * right). A row is everything on one baseline across the whole page width;
 * two-column pages therefore produce rows that span both columns, and
 * detectColumns() splits them.
 */
export function groupIntoLines(items, styles = {}, links = null) {
  const glyphs = [];
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const t = it.transform;
    if (!t || t.length < 6) continue;
    const [a, b, c, d, e, f] = t;
    // Rotated (marginal "Downloaded from…") and mirrored text is not part of the reading flow.
    if (Math.abs(b) > 0.35 * Math.abs(a) || d <= 0) continue;
    const size = it.height > 0 ? it.height : Math.hypot(c, d);
    if (!(size > 0.5)) continue;
    const style = styles?.[it.fontName];
    const base = {
      y: f, size,
      font: it.fontName ?? '',
      bold: isBoldFont(it.fontName, style),
      mono: isMonoFont(it.fontName, style),
      href: null,
    };
    const x0 = e, x1 = e + Math.abs(it.width || 0);
    const hit = links && links.length
      ? links.filter(L => L.x0 < x1 && L.x1 > x0 && L.y0 < f + size && L.y1 > f - 0.25 * size)
      : null;
    if (!hit || !hit.length) { glyphs.push({ ...base, x0, x1, str: it.str }); continue; }
    // A run usually holds a whole line, but a link covers only some of its
    // words, so split it and give each word an x proportional to its offset.
    const str = it.str, n = str.length, w = x1 - x0;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(str))) {
      const wx0 = x0 + w * (m.index / n), wx1 = x0 + w * ((m.index + m[0].length) / n);
      const cx = (wx0 + wx1) / 2, cy = f + 0.3 * size;
      const L = hit.find(q => cx >= q.x0 && cx <= q.x1 && cy >= q.y0 && cy <= q.y1);
      glyphs.push({ ...base, x0: wx0, x1: wx1, str: m[0], href: L ? L.href : null });
    }
  }
  glyphs.sort((p, q) => q.y - p.y || p.x0 - q.x0);

  // Running weighted baseline/size per row: weight = chars × size, so a
  // superscript or a drop cap cannot drag the row's baseline or tolerance.
  const rows = [];
  for (const g of glyphs) {
    let target = null;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
      const R = rows[k];
      if (Math.abs(g.y - R.y) <= 0.5 * Math.max(R.size, g.size)) { target = R; break; }
    }
    const w = (g.str.replace(/\s+/g, '').length || 1) * g.size;
    if (target) {
      target.items.push(g);
      target.ySum += g.y * w; target.sSum += g.size * w; target.wSum += w;
      target.y = target.ySum / target.wSum; target.size = target.sSum / target.wSum;
    } else {
      rows.push({ y: g.y, size: g.size, ySum: g.y * w, sSum: g.size * w, wSum: w, items: [g] });
    }
  }
  const lines = [];
  for (const R of rows) { const L = makeLine(R.items); if (L) lines.push(L); }
  lines.sort((p, q) => q.y - p.y || p.x0 - q.x0);
  return lines;
}

/* -------------------------------------------------------------- columns --- */

/** Does this row's text run across the gutter (a spanning title, a wide caption)? */
function rowCrosses(row, g) {
  const its = row.items;
  for (let i = 0; i < its.length; i++) {
    const it = its[i];
    if (it.x0 < g.c && it.x1 > g.c) return true;
    // Per-word items: a word space straddling the gutter is still one line,
    // but a real column gap is always wider than a space.
    if (i > 0) {
      const p = its[i - 1];
      if (p.x1 <= g.c && it.x0 >= g.c && it.x0 - p.x1 < Math.min(row.size, 0.5 * g.w)) return true;
    }
  }
  return false;
}

/**
 * Find column gutters and return the page's lines in reading order.
 *
 * Gutters are vertical stripes inside the text box that almost no item covers
 * once full-width items are ignored. Each candidate must have real text on
 * both sides (three vertically adjacent lines on the right, so a CV's date
 * column doesn't count) and be crossed by fewer than half the rows (so a
 * table's aligned cells inside a one-column page don't count).
 *
 * Rows that cross a gutter and are wide, or sit centred on it, are spanning
 * rows; they cut the page into horizontal bands, and columns are read left to
 * right within each band. That is what puts a title block, then column one,
 * then column two, then a full-width caption, then the columns below it, in
 * the right order.
 *
 * Returns { lines, columns }. Every returned line carries col (-1 = spanning),
 * band and spanning.
 */
export function detectColumns(lines, pageWidth) {
  const rows = lines.slice().sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const single = () => {
    for (const r of rows) { r.col = 0; r.band = 0; r.spanning = false; }
    return { lines: rows, columns: 1 };
  };
  if (rows.length < 3) return single();

  const medSize = median(rows.map(l => l.size));
  const x0s = rows.map(l => l.x0).sort((a, b) => a - b);
  const x1s = rows.map(l => l.x1).sort((a, b) => a - b);
  const left = percentile(x0s, 0.05);
  const right = percentile(x1s, 0.95);
  const bw = right - left;
  if (!(bw > 4 * medSize) || !(pageWidth > 0)) return single();

  // Coverage profile at 1pt resolution; each row counts once per bin.
  const nb = Math.ceil(bw) + 1;
  const cov = new Uint16Array(nb);
  const stamp = new Int32Array(nb).fill(-1);
  rows.forEach((row, ri) => {
    for (const it of row.items) {
      if (it.x1 - it.x0 >= 0.7 * bw) continue;    // full-width text says nothing about columns
      const b0 = Math.max(0, Math.floor(it.x0 - left));
      const b1 = Math.min(nb - 1, Math.ceil(it.x1 - left));
      for (let b = b0; b <= b1; b++) if (stamp[b] !== ri) { stamp[b] = ri; cov[b]++; }
    }
  });

  const thr = Math.max(1, 0.12 * rows.length);
  const lo = Math.floor(0.15 * bw), hi = Math.ceil(0.85 * bw);
  const minW = Math.max(3, 0.35 * medSize);
  const candidates = [];
  for (let b = lo; b <= hi;) {
    if (cov[b] > thr) { b++; continue; }
    let e = b;
    while (e + 1 < nb && cov[e + 1] <= thr) e++;
    const touchesEdge = b <= lo || e >= hi;       // a low stripe at the edge is just the margin/ragged zone
    if (!touchesEdge && e - b + 1 >= minW) {
      candidates.push({ x0: left + b, x1: left + e + 1, c: left + (b + e + 1) / 2, w: e - b + 1 });
    }
    b = e + 1;
  }

  const gutters = [];
  for (const g of candidates) {
    let crossing = 0, leftRows = 0;
    const rightRows = [];
    for (const row of rows) {
      if (rowCrosses(row, g)) { crossing++; continue; }
      let hasL = false, hasR = false;
      for (const it of row.items) { if (it.x1 <= g.c) hasL = true; else hasR = true; }
      if (hasL) leftRows++;
      if (hasR) rightRows.push(row);
    }
    if (leftRows < 3 || rightRows.length < 3) continue;
    if (crossing > 0.5 * rows.length) continue;
    let run = 1, best = 1;
    for (let i = 1; i < rightRows.length; i++) {
      run = rightRows[i - 1].y - rightRows[i].y <= 2.5 * medSize ? run + 1 : 1;
      if (run > best) best = run;
    }
    if (best < 3) continue;
    gutters.push(g);
  }
  if (!gutters.length) return single();

  const colOf = x => { let c = 0; for (const g of gutters) if (x >= g.c) c++; return c; };
  const out = [];
  let band = 0, lastSpanning = null;
  const place = (line, spanning) => {
    if (lastSpanning !== null && lastSpanning !== spanning) band++;
    lastSpanning = spanning;
    line.band = band; line.spanning = spanning;
    out.push(line);
  };
  for (const row of rows) {
    const crossed = gutters.filter(g => rowCrosses(row, g));
    if (crossed.length) {
      const center = (row.x0 + row.x1) / 2;
      const wide = row.x1 - row.x0 >= 0.6 * bw;
      const onGutter = crossed.some(g => Math.abs(center - g.c) < 1.5 * row.size);
      if (wide || onGutter) { row.col = -1; place(row, true); }
      else { row.col = colOf(center); place(row, false); }    // an overflowing equation stays in its column
      continue;
    }
    const groups = new Map();
    for (const it of row.items) {
      const c = colOf((it.x0 + it.x1) / 2);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(it);
    }
    if (groups.size === 1) { row.col = groups.keys().next().value; place(row, false); continue; }
    for (const [c, its] of groups) {
      const seg = makeLine(its);
      if (seg) { seg.col = c; place(seg, false); }
    }
  }
  out.sort((p, q) => p.band - q.band || p.col - q.col || q.y - p.y || p.x0 - q.x0);
  return { lines: out, columns: gutters.length + 1 };
}

/* -------------------------------------------------------- page furniture --- */

const PAGE_NUM_RE = /^[\s\-–—•·|[\]()]*(?:page\s*|p\.?\s*|pg\.?\s*)?(?:\d{1,4}|[ivxlcdm]{1,8})(?:\s*(?:of|\/|-|–|—)\s*\d{1,4})?[\s\-–—•·|[\]()]*$/i;

/** "12", "- 12 -", "Page 3 of 10", "iv", "[7]" … */
export function isPageNumber(text) {
  return PAGE_NUM_RE.test(text.trim());
}

/**
 * Lines that repeat at about the same height on enough pages are running
 * heads/feet. `pages` is [{ lines, height }]. Returns the Set of line objects
 * to drop.
 *
 * Two tiers: in the outer 8% of the page the key ignores digits (so
 * "Author et al. 12" matches on every page); in the outer 10% the text must
 * match exactly, which keeps "Chapter 3"-style headings at the top of a text
 * block from being mistaken for furniture.
 */
export function findRunningHeads(pages) {
  const drop = new Set();
  const withText = (pages || []).filter(p => p.lines.length).length;
  if (withText < 2) return drop;
  const need = withText >= 3 ? 3 : 2;              // scanned pages cannot vote
  const outer = new Map(), inner = new Map();
  const push = (map, key, entry) => { if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  pages.forEach((pg, pi) => {
    const H = pg.height > 0 ? pg.height : 792;
    for (const line of pg.lines) {
      const edge = Math.min(line.y, H - line.y) / H;
      if (edge > 0.10) continue;
      const base = line.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (base.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) push(inner, base, { pi, line });
      if (edge <= 0.12) {
        const key = base.replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim();
        if (key.replace(/[#\s]/g, '').length >= 3) push(outer, key, { pi, line });
      }
    }
  });
  for (const map of [outer, inner]) {
    for (const list of map.values()) {
      if (list.length < need) continue;
      for (const e of list) {
        const near = new Set();
        for (const o of list) if (Math.abs(o.line.y - e.line.y) <= 12) near.add(o.pi);
        if (near.size >= need) drop.add(e.line);
      }
    }
  }
  return drop;
}

/* ---------------------------------------------------------------- stats --- */

/**
 * Body size = most common size weighted by character count; heading sizes
 * are the distinct larger sizes, biggest first. Also finds the body font so
 * a rarely used font can stand in for the boldness pdf.js doesn't expose.
 */
export function classifySizes(lines) {
  const bySize = new Map(), byFont = new Map();
  let total = 0;
  for (const l of lines) {
    const n = l.chars ?? l.text.replace(/\s+/g, '').length;
    total += n;
    bump(bySize, r1(l.size), n);
    bump(byFont, l.font ?? '', n);
  }
  const bodySize = total ? argmaxKey(bySize) : 10;
  const bodyFont = total ? argmaxKey(byFont) : null;
  const fontShare = {};
  for (const [f, n] of byFont) fontShare[f] = n / total;
  const headingSizes = [...bySize.keys()]
    .filter(s => s >= bodySize * 1.08 && s >= bodySize + 0.5)
    .sort((a, b) => b - a);
  return { bodySize, bodyFont, fontShare, headingSizes };
}

/**
 * Heading level for a block: 1–3, or 0 for body text.
 * Larger sizes rank by their position among the document's heading sizes;
 * bold text at body size becomes the next level down.
 */
export function headingLevel(size, bold, stats) {
  const s = r1(size);
  if (s >= stats.bodySize * 1.08 && s >= stats.bodySize + 0.5) {
    const rank = stats.headingSizes.filter(h => h > s + 0.01).length + 1;
    return Math.min(3, rank);
  }
  if (bold && s >= stats.bodySize * 0.95) return Math.min(3, stats.headingSizes.length + 1);
  return 0;
}

/** Document-wide stats: classifySizes() plus the median baseline pitch of body text. */
export function computeStats(pages) {
  const all = [];
  for (const pg of pages) all.push(...pg.lines);
  const stats = classifySizes(all);
  const dys = [];
  for (const pg of pages) {
    const ls = pg.lines;
    for (let i = 1; i < ls.length; i++) {
      const a = ls[i - 1], b = ls[i];
      if (a.col !== b.col || a.band !== b.band) continue;
      if (Math.abs(a.size - stats.bodySize) > 0.1 * stats.bodySize) continue;
      if (Math.abs(b.size - stats.bodySize) > 0.1 * stats.bodySize) continue;
      const dy = a.y - b.y;
      if (dy > 0.6 * stats.bodySize && dy < 3 * stats.bodySize) dys.push(dy);
    }
  }
  stats.pitch = dys.length ? median(dys) : 1.2 * stats.bodySize;
  return stats;
}

/* --------------------------------------------------------- de-hyphenation --- */

// Prefixes whose trailing hyphen is (nearly) always a real one. Deliberately
// short: "pre-", "co-", "multi-" are common syllable breaks inside words.
const KEEP_PREFIX = new Set(['self', 'non', 'anti', 'semi', 'cross', 'well', 'quasi', 'pseudo', 'half', 'ultra', 'e', 't', 'x']);

/**
 * Join a line ending in a hyphen with the next line. Returns the joined text,
 * or null when the first line doesn't end in a hyphen/dash (caller joins
 * with a space). The hyphen is removed for an ordinary word break and kept
 * when the break looks like a real compound: a digit on either side, a
 * capital or all-caps fragment, or a prefix from KEEP_PREFIX.
 */
export function dehyphenate(prev, next) {
  const p = String(prev ?? '').replace(/\s+$/, '');
  const n = String(next ?? '').replace(/^\s+/, '');
  if (!p || !n) return null;
  const last = p[p.length - 1];
  if (last === '­') return p.slice(0, -1) + n;
  if (last === '–' || last === '—') return /\s/.test(p[p.length - 2] || ' ') ? null : p + n;
  if (last !== '-' && last !== '‐' && last !== '‑') return null;
  const m = p.match(/([\p{L}\p{N}]+)[-‐‑]$/u);
  if (!m) return null;                                   // "foo -" is a spaced dash
  const head = n.match(/^[\p{L}\p{N}]+/u);
  if (!head) return null;
  const frag = m[1];
  const keep =
    /^\p{N}/u.test(frag) || /^\p{N}/u.test(head[0]) ||
    /^\p{Lu}/u.test(head[0]) ||
    (frag.length <= 3 && /\p{Lu}/u.test(frag) && frag === frag.toUpperCase()) ||
    KEEP_PREFIX.has(frag.toLowerCase());
  return keep ? p + n : p.slice(0, -1) + n;
}

/* ---------------------------------------------------------------- lists --- */

const BULLET_RE = /^([•·◦▪▫■□●○►▸▶‣⁃∙⁍❖✓✔➢➤→\-–—*]|[-])\s+(\S.*)$/u;
const NUMBER_RE = /^(\d{1,2}(?:\.\d{1,2}){1,3}\.?(?=\s+\p{Lu})|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,5}[.)]|\(?[IVX]{2,5}[.)]|\(?[A-Z]\))\s+(?=[\p{L}"'“‘(\[])(\S.*)$/u;

/** Split "• foo" / "3. foo" / "(b) foo" into { marker, text, kind }, else null. */
export function splitListMarker(text) {
  const t = text.trim();
  let m = t.match(BULLET_RE);
  if (m) return { marker: m[1], text: m[2], kind: 'bullet' };
  m = t.match(NUMBER_RE);
  if (m) return { marker: m[1], text: m[2], kind: 'number' };
  return null;
}

/* ----------------------------------------------------------- paragraphs --- */

/** Left/right edges and justification of one column on one page. */
function geometry(lines, body) {
  const xs = lines.map(l => l.x0).sort((a, b) => a - b);
  // Left edge = leftmost point of the densest 1.5pt cluster of line starts, so
  // first-line indents and hanging indents don't move it.
  let bi = 0, bc = 0;
  for (let i = 0, j = 0; i < xs.length; i++) {
    while (xs[i] - xs[j] > 1.5) j++;
    if (i - j + 1 > bc) { bc = i - j + 1; bi = j; }
  }
  const colLeft = xs.length ? xs[bi] : 0;
  const x1s = lines.map(l => l.x1).sort((a, b) => a - b);
  const colRight = x1s.length ? (lines.length >= 10 ? percentile(x1s, 0.95) : x1s[x1s.length - 1]) : 0;
  const colWidth = Math.max(colRight - colLeft, 4 * body);
  const bodyLines = lines.filter(l => Math.abs(l.size - body) <= 0.1 * body && l.chars >= 20);
  const full = bodyLines.filter(l => l.x1 >= colRight - 1.5).length;
  const justified = bodyLines.length >= 4 && full >= 0.6 * bodyLines.length;
  // A last line is "short" if it clearly stops before the edge; ragged text
  // needs a much bigger allowance than justified text.
  const shortGap = justified ? 1.5 * body : Math.max(3 * body, 0.2 * colWidth);
  return { colLeft, colRight, colWidth, justified, shortGap };
}

const isShort = (l, g) => l.x1 < g.colRight - g.shortGap;
const isCentered = (l, g) => {
  const c = (l.x0 + l.x1) / 2, cc = (g.colLeft + g.colRight) / 2;
  return Math.abs(c - cc) <= 0.02 * g.colWidth + 1 && l.x0 > g.colLeft + 1.5 * l.size && l.x1 < g.colRight - 1.5 * l.size;
};

/** Where the text after a list marker starts, for lining up continuation lines. */
function markerTextX(line, marker) {
  const its = line.items;
  if (its.length > 1 && its[0].str.trim() === marker) return its[1].x0;
  const first = its[0];
  const frac = Math.min(1, (marker.length + 1) / Math.max(1, first.str.length));
  return first.x0 + (first.x1 - first.x0) * frac;
}

/**
 * Join reading-ordered lines of one page into blocks. `stats` comes from
 * computeStats()/classifySizes() (+ pitch). Paragraph breaks come from, in
 * order of reliability: size/font changes, vertical gaps, list markers,
 * first-line indents / hanging outdents, and a short line that ends a
 * sentence.
 */
export function joinLines(lines, stats, page = 0) {
  const body = stats.bodySize || 10;
  const pitch = stats.pitch || 1.2 * body;
  const share = stats.fontShare || {};
  const emph = l => l.bold || (stats.bodyFont != null && l.font !== stats.bodyFont && (share[l.font] ?? 0) < 0.2);

  const geoms = new Map();
  const geomFor = col => {
    if (!geoms.has(col)) geoms.set(col, geometry(col === -1 ? lines : lines.filter(l => l.col === col), body));
    return geoms.get(col);
  };

  const blocks = [];
  let cur = null;

  const flush = () => {
    if (cur) { const b = finishBlock(cur, stats, page, emph); if (b) blocks.push(b); }
    cur = null;
  };
  const start = line => {
    const lm = splitListMarker(line.text);
    cur = { lines: [line], dys: [], marker: lm ? lm.marker : null, textX: lm ? markerTextX(line, lm.marker) : null, mono: line.mono, geom: geomFor(line.col) };
  };

  for (const b of lines) {
    if (!cur) { start(b); continue; }
    const a = cur.lines[cur.lines.length - 1];
    const ga = geomFor(a.col), gb = geomFor(b.col);
    const columnBreak = a.col !== b.col || a.band !== b.band;
    const dy = a.y - b.y;

    let brk = false;
    if (!columnBreak && Math.abs(dy) < 0.5 * Math.min(a.size, b.size)) {
      brk = false;                                              // two segments of one visual line
    } else if (Math.abs(a.size - b.size) > 0.08 * Math.max(a.size, b.size)) {
      brk = true;
    } else if (a.mono !== b.mono || a.bold !== b.bold) {
      brk = true;
    } else {
      if (!columnBreak) {
        const ref = cur.dys.length ? median(cur.dys) : pitch * Math.max(1, a.size / body);
        if (dy > 1.3 * ref) brk = true;
      }
      const lm = brk ? null : splitListMarker(b.text);
      if (lm && (lm.kind === 'bullet' || columnBreak || cur.marker || isShort(a, ga))) brk = true;
      if (!brk && ((emph(a) && !emph(b) && isShort(a, ga)) || (!emph(a) && emph(b) && isShort(b, gb)))) brk = true;
      if (!brk) {
        const aC = isCentered(a, ga), bC = isCentered(b, gb);
        if (aC !== bC && (aC || isShort(a, ga))) brk = true;
        if (!brk && !bC) {
          const ind = b.x0 - gb.colLeft;
          const listCont = cur.textX != null && Math.abs(b.x0 - cur.textX) <= 1.0 * body;
          const uniform = Math.abs(b.x0 - a.x0) <= 0.3 * body && a.x0 > ga.colLeft + 0.7 * body;
          if (ind > 0.7 * body && ind < 6 * body && !listCont && !uniform) brk = true;
          else if (b.x0 < gb.colLeft - 0.7 * body && b.x0 < a.x0 - 0.7 * body) brk = true;
        }
      }
      if (!brk && isShort(a, ga) && endsSentence(a.text) && !startsLower(b.text)) brk = true;
    }

    if (brk) { flush(); start(b); }
    else { if (!columnBreak && dy > 0) cur.dys.push(dy); cur.lines.push(b); }
  }
  flush();
  return blocks;
}

const lineHrefs = l => l.hrefs || new Array(l.text.split(' ').length).fill(null);

function finishBlock(cur, stats, page, emph) {
  const b = buildBlock(cur, stats, page, emph);
  if (!b) return null;
  const ls = cur.lines;
  // Where the block sat on the page, so figures can be slotted in beside it.
  b._g = {
    top: Math.max(...ls.map(l => l.y + l.size)),
    bottom: Math.min(...ls.map(l => l.y)),
    x0: Math.min(...ls.map(l => l.x0)),
    x1: Math.max(...ls.map(l => l.x1)),
  };
  if (b.type === 'pre' || !ls.some(l => l.hrefs)) return b;
  // Merge per-line link arrays the same way the text was merged: a
  // de-hyphenated join fuses the last word of one line with the first of the next.
  let acc = lineHrefs(ls[0]).slice();
  let text = ls[0].text;
  for (let i = 1; i < ls.length; i++) {
    const nh = lineHrefs(ls[i]);
    const j = dehyphenate(text, ls[i].text);
    if (j !== null) { acc[acc.length - 1] = acc[acc.length - 1] || nh[0]; acc.push(...nh.slice(1)); text = j; }
    else { acc.push(...nh); text = `${text} ${ls[i].text}`; }
  }
  if (b.marker) acc = acc.slice(b.marker.split(/\s+/).length);
  if (acc.length === b.text.split(/\s+/).length && acc.some(Boolean)) b.hrefs = acc;
  return b;
}

function buildBlock(cur, stats, page, emph) {
  const ls = cur.lines;
  const body = stats.bodySize || 10;
  const g = cur.geom;
  let text = ls[0].text;
  for (let i = 1; i < ls.length; i++) {
    const j = dehyphenate(text, ls[i].text);
    text = j ?? `${text} ${ls[i].text}`;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (cur.mono && ls.every(l => l.mono)) return { type: 'pre', text: ls.map(l => l.text).join('\n'), page };

  const chars = ls.reduce((s, l) => s + l.chars, 0);
  const lm = splitListMarker(text);
  if (lm?.kind === 'bullet') return { type: 'li', text: lm.text, marker: lm.marker, page };

  if (ls.length <= 3 && chars <= 200) {
    const size = ls[0].size;
    const strong = ls.every(l => l.bold);
    // Font identity is a weaker signal than a bold name: only trust it for a
    // single short line that doesn't read like a sentence.
    const weak = !strong && ls.length === 1 && chars <= 100 && !endsPunct(text) && emph(ls[0]);
    const lvl = headingLevel(size, strong || weak, stats);
    if (lvl) return { type: `h${lvl}`, text, page };
  }

  if (lm) return { type: 'li', text: lm.text, marker: lm.marker, page };

  const quote = ls.length >= 2 && ls[0].size <= body * 1.05 &&
    ls.every(l => l.x0 >= g.colLeft + 1.5 * body && l.x0 <= g.colLeft + 8 * body && l.x1 <= g.colRight - 1.0 * body);
  return { type: quote ? 'quote' : 'p', text, page };
}

/* ------------------------------------------------------------ document --- */

/** Carry a hyphenated word across a page break: "inter-" | pagebreak | "esting …". */
function stitchPages(blocks) {
  for (let i = 1; i + 1 < blocks.length; i++) {
    if (blocks[i].type !== 'pagebreak') continue;
    const prev = blocks[i - 1], next = blocks[i + 1];
    if (!prev.text || !next.text || next.type === 'pagebreak') continue;
    if (!/[-‐‑­]$/.test(prev.text)) continue;
    const m = next.text.match(/^(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const joined = dehyphenate(prev.text, m[1]);
    if (joined === null) continue;
    prev.text = joined;
    if (prev.hrefs && next.hrefs) prev.hrefs[prev.hrefs.length - 1] ||= next.hrefs[0];
    if (m[2]) {
      next.text = m[2];
      if (next.hrefs) next.hrefs = next.hrefs.slice(1);
    } else blocks.splice(i + 1, 1);
  }
}

/* ---------------------------------------------------------------- links --- */

async function destPage(pdf, dest) {
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d) || d[0] == null) return 0;
    if (typeof d[0] === 'number') return d[0] + 1;
    return (await pdf.getPageIndex(d[0])) + 1;
  } catch { return 0; }
}

/**
 * Link annotations of one page, as rectangles in the page's own coordinates.
 * External links keep their URL; internal ones become "#page=N".
 */
export async function pageLinks(pdf, page) {
  let annots;
  try { annots = await page.getAnnotations({ intent: 'display' }); } catch { return []; }
  const out = [];
  for (const a of annots || []) {
    if (a?.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
    let href = null;
    const u = a.url || a.unsafeUrl;
    if (typeof u === 'string' && /^(https?:|mailto:)/i.test(u)) href = u;
    else if (a.dest != null) {
      const p = await destPage(pdf, a.dest);
      if (p) href = `#page=${p}`;
    }
    if (!href) continue;
    const [x1, y1, x2, y2] = a.rect;
    out.push({ x0: Math.min(x1, x2), x1: Math.max(x1, x2), y0: Math.min(y1, y2), y1: Math.max(y1, y2), href });
  }
  return out;
}

/* -------------------------------------------------------------- figures --- */

/**
 * Slot figure blocks into a page's reading order: each goes before the first
 * block that starts below the figure's top and overlaps it horizontally, so a
 * figure in column two lands in column two.
 */
export function insertFigures(blocks, figures, page) {
  const out = blocks.slice();
  const sorted = figures.slice().sort((a, b) => b.top - a.top);
  for (const f of sorted) {
    const fb = {
      type: 'figure', page, src: f.src, wPt: f.x1 - f.x0, hPt: f.top - f.bottom,
      _g: { top: f.top, bottom: f.bottom, x0: f.x0, x1: f.x1 },
    };
    let at = out.findIndex(b => b._g && b._g.top < f.top - 2 && b._g.x0 < f.x1 && b._g.x1 > f.x0);
    if (at < 0) at = out.length;
    out.splice(at, 0, fb);
  }
  return out;
}

function cleanTitle(s) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^microsoft (?:word|powerpoint) - /i, '').replace(/\.(pdf|docx?|tex|indd|pptx?|odt)$/i, '');
  if (t.length < 2 || /^untitled/i.test(t)) return '';
  return t;
}

function pickTitle(metaTitle, blocks, fallbackTitle) {
  const meta = cleanTitle(metaTitle);
  if (meta) return meta;
  const head = blocks.slice(0, 12);
  const h = head.find(b => b.type === 'h1') || head.find(b => b.type === 'h2' || b.type === 'h3');
  if (h && h.text.length <= 200) return h.text;
  return String(fallbackTitle ?? '').trim();
}

function shiftLines(lines, dx, dy) {
  for (const l of lines) {
    l.x0 += dx; l.x1 += dx; l.y += dy;
    for (const it of l.items) { it.x0 += dx; it.x1 += dx; it.y += dy; }
  }
}

let lastStats = { pagesWithText: 0, pagesEmpty: 0, droppedRunningHeads: 0, columnsSeen: 1 };

/** Diagnostics for the most recent extractDocument() call. */
export function extractionStats() {
  return { ...lastStats };
}

/**
 * extractDocument(pdf, opts) -> Doc
 *   pdf  : pdf.js PDFDocumentProxy
 *   opts : { onProgress?(done, total), maxPages?, fallbackTitle?, signal? }
 */
export async function extractDocument(pdf, opts = {}) {
  const { onProgress, maxPages, fallbackTitle = '', signal } = opts;
  // { detect(page, lines, opts) -> { figures, absorbed }, ... } — injected so
  // this module stays testable in plain node without a canvas.
  const figureOpts = opts.figures && typeof opts.figures.detect === 'function' ? opts.figures : null;
  const stats = { pagesWithText: 0, pagesEmpty: 0, droppedRunningHeads: 0, columnsSeen: 1 };
  lastStats = stats;
  const abortCheck = () => {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    throw signal.reason instanceof Error ? signal.reason : new Error('Extraction aborted');
  };

  const numPages = Math.max(0, pdf.numPages | 0);
  const total = maxPages > 0 ? Math.min(numPages, Math.floor(maxPages)) : numPages;

  let metaTitle = '';
  try { metaTitle = (await pdf.getMetadata())?.info?.Title ?? ''; } catch { /* metadata is optional */ }

  const pages = [];
  for (let n = 1; n <= total; n++) {
    abortCheck();
    let lines = [], offset = [0, 0], width = 612, height = 792;
    try {
      const page = await pdf.getPage(n);
      const view = Array.isArray(page.view) && page.view.length === 4 ? page.view : null;
      if (view) { width = view[2] - view[0]; height = view[3] - view[1]; }
      else { const vp = page.getViewport({ scale: 1 }); width = vp.width; height = vp.height; }
      const tc = await page.getTextContent();
      const links = await pageLinks(pdf, page);
      lines = groupIntoLines(tc.items, tc.styles, links);
      if (view && (view[0] || view[1])) {
        shiftLines(lines, -view[0], -view[1]);
        offset = [view[0], view[1]];
      }
      try { page.cleanup?.(); } catch { /* best effort */ }
    } catch (e) {
      if (signal?.aborted) throw e;
      lines = [];                                             // an unreadable page reads as empty
    }
    const chars = lines.reduce((s, l) => s + l.chars, 0);
    if (chars < 20) { stats.pagesEmpty++; lines = []; }       // scanned or blank
    else stats.pagesWithText++;
    pages.push({ num: n, width, height, lines, offset, figures: [] });
    onProgress?.(n, total);
  }

  const heads = findRunningHeads(pages);
  for (const pg of pages) {
    pg.lines = pg.lines.filter(l => {
      const edge = Math.min(l.y, pg.height - l.y) / pg.height;
      const drop = heads.has(l) || (edge <= 0.10 && isPageNumber(l.text));
      if (drop) stats.droppedRunningHeads++;
      return !drop;
    });
    const res = detectColumns(pg.lines, pg.width);
    pg.lines = res.lines;
    if (res.columns > stats.columnsSeen) stats.columnsSeen = res.columns;
  }

  const ctx = { pages, stats, metaTitle, fallbackTitle, numPages, total };
  if (figureOpts) {
    await runFigurePass(pdf, ctx, figureOpts, { onProgress: opts.onFigureProgress, signal });
  }
  return assemble(ctx);
}

/**
 * Charts, diagrams and tables are captured as pictures and their labels
 * leave the text flow, so they don't become fragment paragraphs. This runs
 * after column detection so each column's lines are judged on their own:
 * three columns of prose must not look like a three-cell table.
 */
async function runFigurePass(pdf, ctx, figureOpts, { onProgress, signal, between } = {}) {
  let found = 0;
  if (!ctx.stats.pagesWithText) return 0;          // a scan: the original-pages view handles it
  for (const pg of ctx.pages) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    const [vx, vy] = pg.offset;
    try {
      const page = await pdf.getPage(pg.num);
      if (vx || vy) shiftLines(pg.lines, vx, vy);          // back to raw page space
      let r;
      try { r = await figureOpts.detect(page, pg.lines, figureOpts); }
      finally { if (vx || vy) shiftLines(pg.lines, -vx, -vy); }
      for (const f of r.figures) { f.x0 -= vx; f.x1 -= vx; f.top -= vy; f.bottom -= vy; }
      pg.figures = r.figures;
      found += r.figures.length;
      if (r.absorbed.size) pg.lines = pg.lines.filter(l => !r.absorbed.has(l));
      try { page.cleanup?.(); } catch { /* best effort */ }
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn('[lucid] figure detection failed on page', pg.num, e);
    }
    onProgress?.(pg.num, ctx.pages.length);
    if (between) await between();
  }
  return found;
}

/**
 * Second pass for a document extracted with `deferFigures`: captures figures
 * in the background and returns a new Doc with them in place, or null when
 * the document has none (so the caller can skip a re-render).
 */
export async function addFigures(pdf, doc, figureOpts, opts = {}) {
  const ctx = doc?._ctx;
  if (!ctx || !figureOpts) return null;
  const found = await runFigurePass(pdf, ctx, figureOpts, opts);
  return found ? assemble(ctx) : null;
}

function assemble(ctx) {
  const { pages, stats, metaTitle, fallbackTitle, numPages, total } = ctx;
  const docStats = computeStats(pages);
  const blocks = [];
  // A document with no text at all is a scan: return no blocks so the caller
  // falls back to the original pages instead of a column of page pictures.
  const hasText = stats.pagesWithText > 0;
  for (const pg of pages) {
    const figs = hasText ? pg.figures : [];
    if (!pg.lines.length && !figs.length) continue;
    let bs = pg.lines.length ? joinLines(pg.lines, docStats, pg.num) : [];
    if (figs.length) bs = insertFigures(bs, figs, pg.num);
    if (!bs.length) continue;
    blocks.push(...bs, { type: 'pagebreak', page: pg.num });
  }
  if (blocks.length && blocks[blocks.length - 1].type === 'pagebreak') blocks.pop();
  stitchPages(blocks);

  const doc = {
    title: pickTitle(metaTitle, blocks, fallbackTitle),
    numPages,
    blocks,
    truncated: total < numPages,
  };
  // Kept off the enumerable fields so the Doc stays plain data (cacheable).
  Object.defineProperty(doc, '_ctx', { value: ctx, enumerable: false });
  for (const b of blocks) delete b._g;
  return doc;
}
