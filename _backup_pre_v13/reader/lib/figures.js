/**
 * Finds charts, diagrams, pictures and tables on a page and captures each one
 * as an image cropped from the rendered page.
 *
 * Reflowing text is the wrong treatment for these: a chart's axis labels or a
 * table's cells come out of extraction as a scatter of three-word
 * "paragraphs" and the graphic itself is lost. So a region that is mostly
 * non-text ink, or a run of lines laid out in table columns, is kept as a
 * picture and the text lines inside it leave the reading flow.
 *
 * Two kinds of candidate region:
 *   - ink regions: rows of the rendered page that have pixels differing from
 *     the background *outside* every text box (lines, bars, images, shading)
 *   - table runs: three or more consecutive lines split into 3+ short cells
 *
 * Shaded boxes that hold ordinary prose (callouts, cards) are recognised by
 * their fill ratio and their long lines, and left as text.
 *
 * Everything is in PDF user space except where a name ends in Px.
 */

const IMAGE_OPS = [
  'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject',
  'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup',
  'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask',
];

const INK_DIFF = 40;      // per-channel difference from the background that counts as ink
const MERGE_GAP = 10;     // pt of blank rows that still join two ink bands
const PAD = 4;            // pt of breathing room around a crop

/** Text runs on a line separated by gaps wider than a word space. */
export function lineCells(line) {
  const its = line.items.slice().sort((a, b) => a.x0 - b.x0);
  const cells = [];
  let cur = null;
  for (const it of its) {
    if (cur && it.x0 - cur.x1 <= 1.2 * line.size) { cur.x1 = Math.max(cur.x1, it.x1); cur.chars += it.str.length; continue; }
    cur = { x0: it.x0, x1: it.x1, chars: it.str.length };
    cells.push(cur);
  }
  return cells;
}

// Table cells are short; a column of prose runs 45+ characters per line, which
// is what keeps three columns of text from reading as a three-cell table.
const isTableRow = l => {
  const cells = lineCells(l);
  if (cells.length < 3) return false;
  if (cells.some(c => c.chars >= 45)) return false;
  return cells.reduce((s, c) => s + c.chars, 0) / cells.length <= 40;
};

/**
 * Column detection may already have cut a table's rows into per-column
 * segments; glue segments sharing a baseline back into one row.
 */
function visualRows(lines) {
  const ls = lines.slice().sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const rows = [];
  for (const l of ls) {
    const R = rows[rows.length - 1];
    if (R && Math.abs(R.y - l.y) <= 0.5 * Math.max(R.size, l.size)) {
      R.items.push(...l.items);
      R.x0 = Math.min(R.x0, l.x0); R.x1 = Math.max(R.x1, l.x1);
      R.chars += l.chars; R.size = Math.max(R.size, l.size);
    } else {
      rows.push({ y: l.y, size: l.size, x0: l.x0, x1: l.x1, chars: l.chars, items: l.items.slice() });
    }
  }
  return rows;
}

/** Ordinary running text: long and in one piece. */
const isProse = l => l.chars >= 45 && lineCells(l).length <= 1;

/** Consecutive table-like rows, as rectangles. Pure — unit-testable. */
export function tableRuns(lines) {
  const ls = visualRows(lines);
  const runs = [];
  let cur = [];
  let pending = [];   // short single-cell lines: a cell that wrapped ("difficulty)")
  const close = () => {
    if (cur.filter(isTableRow).length >= 3) runs.push(cur.concat(pending));
    cur = []; pending = [];
  };
  for (const l of ls) {
    const near = cur.length && cur[cur.length - 1].y - l.y <= 3 * l.size;
    if (!isTableRow(l)) {
      if (near && l.chars <= 60 && lineCells(l).length <= 3 && pending.length < 3) { pending.push(l); continue; }
      close();
      continue;
    }
    if (cur.length && !near && !(pending.length && pending[pending.length - 1].y - l.y <= 3 * l.size)) close();
    cur.push(...pending, l);
    pending = [];
  }
  close();
  return runs.map(r => {
    const its = r.flatMap(l => l.items);
    const numeric = its.filter(it => /^[\s\d$€£%+\-−–.,()/x×]+$/.test(it.str)).length / Math.max(1, its.length);
    return {
      x0: Math.min(...r.map(l => l.x0)),
      x1: Math.max(...r.map(l => l.x1)),
      top: Math.max(...r.map(l => l.y + l.size)),
      bottom: Math.min(...r.map(l => l.y - 0.3 * l.size)),
      table: true,
      numeric,
    };
  });
}

const lineCentreIn = (l, R, pad = PAD) => {
  const cx = (l.x0 + l.x1) / 2, cy = l.y + 0.35 * l.size;
  return cx >= R.x0 - pad && cx <= R.x1 + pad && cy >= R.bottom - pad && cy <= R.top + pad;
};

const overlaps = (a, b, pad = 0) =>
  a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.bottom < b.top + pad && a.top > b.bottom - pad;

function union(a, b) {
  return {
    x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
    top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom),
    table: !!(a.table || b.table), fill: Math.max(a.fill ?? 0, b.fill ?? 0),
  };
}

function mergeAll(rects, pad) {
  const out = rects.slice();
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (overlaps(out[i], out[j], pad)) { out[i] = union(out[i], out[j]); out.splice(j, 1); changed = true; break; }
      }
    }
  }
  return out;
}

async function countOps(page, OPS) {
  let images = 0, paths = 0;
  try {
    const ol = await page.getOperatorList();
    const img = new Set(IMAGE_OPS.map(n => OPS?.[n]).filter(v => v != null));
    const path = OPS?.constructPath;
    for (const fn of ol.fnArray) {
      if (img.has(fn)) images++;
      else if (fn === path) paths++;
    }
  } catch { /* treat as unknown: fall through to rendering only if tables exist */ }
  return { images, paths };
}

/**
 * detectFigures(page, lines, opts) -> { figures: [{x0,x1,top,bottom,src}], absorbed: Set<Line> }
 *   lines are in the page's raw coordinates (before any view-box shift)
 *   opts  = { OPS, createCanvas(w,h), encode(canvas) -> Promise<string>, maxSide? }
 */
export async function detectFigures(page, lines, opts) {
  const out = { figures: [], absorbed: new Set() };
  const { OPS, createCanvas, encode } = opts;
  const tables = tableRuns(lines);
  const { images, paths } = await countOps(page, OPS);
  // Pages that are pure text need no rendering at all.
  if (!images && paths < 4 && !tables.length) return out;

  const base = page.getViewport({ scale: 1 });
  // Detection runs on a small render (about 7x fewer pixels than the crop);
  // only pages that turn out to hold a figure are rendered again sharply.
  const S = Math.min(0.8, 700 / base.width);
  const vp = page.getViewport({ scale: S });
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const px = ctx.getImageData(0, 0, W, H).data;

  // Done with the viewport matrix directly: pdf.js 6 no longer ships the
  // rectangle helpers, and the matrix handles rotation and view-box offsets.
  const mapper = (v, Wd, Hd) => {
    const [ma, mb, mc, md, me, mf] = v.transform;
    const det = ma * md - mb * mc;
    const fwd = (x, y) => [ma * x + mc * y + me, mb * x + md * y + mf];
    return {
      toPx(x0, y0, x1, y1) {
        const p = fwd(x0, y0), q = fwd(x1, y1);
        return [
          Math.max(0, Math.floor(Math.min(p[0], q[0]))), Math.max(0, Math.floor(Math.min(p[1], q[1]))),
          Math.min(Wd, Math.ceil(Math.max(p[0], q[0]))), Math.min(Hd, Math.ceil(Math.max(p[1], q[1]))),
        ];
      },
      inv: (u, w) => [(md * (u - me) - mc * (w - mf)) / det, (-mb * (u - me) + ma * (w - mf)) / det],
    };
  };
  const M = mapper(vp, W, H);
  const toPx = M.toPx;
  const toPdf = (ax, ay, bx, by) => {
    const p = M.inv(ax, ay), q = M.inv(bx, by);
    return { x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]), bottom: Math.min(p[1], q[1]), top: Math.max(p[1], q[1]) };
  };

  // Mask every glyph box so text never counts as ink.
  const mask = new Uint8Array(W * H);
  for (const l of lines) {
    for (const it of l.items) {
      const [a, b, c, d] = toPx(it.x0 - 1, it.y - 0.3 * it.size, it.x1 + 1, it.y + 1.0 * it.size);
      for (let y = b; y < d; y++) mask.fill(1, y * W + a, y * W + c);
    }
  }

  // Background = the most common colour around the page edge.
  const hist = new Map();
  const sample = (x, y) => {
    const p = (y * W + x) * 4;
    const k = ((px[p] >> 3) << 10) | ((px[p + 1] >> 3) << 5) | (px[p + 2] >> 3);
    hist.set(k, (hist.get(k) || 0) + 1);
  };
  for (let x = 0; x < W; x += 3) { sample(x, 1); sample(x, H - 2); }
  for (let y = 0; y < H; y += 3) { sample(1, y); sample(W - 2, y); }
  let bgKey = 0x7fff, bgN = -1;
  for (const [k, n] of hist) if (n > bgN) { bgKey = k; bgN = n; }
  const br = ((bgKey >> 10) & 31) << 3, bg = ((bgKey >> 5) & 31) << 3, bb = (bgKey & 31) << 3;

  const ink = new Uint8Array(W * H);
  const rowN = new Uint32Array(H), rowMin = new Int32Array(H).fill(W), rowMax = new Int32Array(H).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0, i = y * W; x < W; x++, i++) {
      if (mask[i]) continue;
      const p = i * 4;
      if (Math.abs(px[p] - br) > INK_DIFF || Math.abs(px[p + 1] - bg) > INK_DIFF || Math.abs(px[p + 2] - bb) > INK_DIFF) {
        ink[i] = 1;
        rowN[y]++;
        if (x < rowMin[y]) rowMin[y] = x;
        if (x > rowMax[y]) rowMax[y] = x;
      }
    }
  }

  // Bands of inked rows, joined across small gaps.
  const gapPx = MERGE_GAP * S;
  const bands = [];
  let cur = null;
  for (let y = 0; y < H; y++) {
    if (rowN[y] < 2) continue;
    if (cur && y - cur.y1 <= gapPx) {
      cur.y1 = y; cur.x0 = Math.min(cur.x0, rowMin[y]); cur.x1 = Math.max(cur.x1, rowMax[y]); cur.n += rowN[y];
    } else {
      cur = { y0: y, y1: y, x0: rowMin[y], x1: rowMax[y], n: rowN[y] };
      bands.push(cur);
    }
  }

  let regions = [];
  for (const b of bands) {
    const r = toPdf(b.x0, b.y0, b.x1 + 1, b.y1 + 1);
    const area = Math.max(1, (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
    r.fill = b.n / area;
    regions.push(r);
  }
  // Hairline column dividers and margin bars would otherwise glue unrelated
  // regions together across the whole page.
  regions = regions.filter(r => r.x1 - r.x0 >= 12 && !(r.top - r.bottom < 3 && r.x1 - r.x0 > 0.6 * base.width));
  // Narrow columns of prose can pass for table cells, so a table must also
  // carry its own ink (row rules, shading) or be mostly numbers.
  for (const T of tables) {
    const [a, b, c, d] = toPx(T.x0, T.bottom, T.x1, T.top);
    let n = 0;
    for (let y = b; y < d; y++) for (let x = a, i = y * W + a; x < c; x++, i++) n += ink[i];
    const area = Math.max(1, (c - a) * (d - b));
    if (n >= Math.max(12, 0.004 * area) || T.numeric >= 0.5) regions.push(T);
  }
  regions = mergeAll(regions, 2);

  const figs = [];
  for (const R of regions) {
    const inside = lines.filter(l => lineCentreIn(l, R));
    if (!R.table && inside.length) {
      // A filled panel or card behind ordinary text is decoration, not a figure.
      if ((R.fill ?? 0) > 0.6) continue;
      const prose = inside.filter(isProse).length;
      if (prose >= 3 && prose >= 0.5 * inside.length) continue;
      if (prose >= 1 && inside.length <= 2) continue;
    }
    let F = { ...R };
    for (const l of inside) {
      F = union(F, { x0: l.x0, x1: l.x1, top: l.y + l.size, bottom: l.y - 0.3 * l.size });
    }
    const w = F.x1 - F.x0, h = F.top - F.bottom;
    if (w < 50 || h < 24) continue;
    // Small inked shapes with no text and no images are rules and ornaments.
    if (!inside.length && !images && h < 48) continue;
    figs.push({ R: F, inside });
  }

  // Overlapping captures (a table inside a chart frame) become one picture.
  const merged = mergeAll(figs.map(f => f.R), PAD);
  if (!merged.length) return out;

  // Sharp render for the crops.
  const SH = Math.min(2, (opts.maxSide ?? 1600) / base.width, 2400 / base.height);
  const vpH = page.getViewport({ scale: SH });
  const WH = Math.ceil(vpH.width), HH = Math.ceil(vpH.height);
  const hi = createCanvas(WH, HH);
  const hctx = hi.getContext('2d');
  hctx.fillStyle = '#ffffff';
  hctx.fillRect(0, 0, WH, HH);
  await page.render({ canvasContext: hctx, viewport: vpH }).promise;
  const MH = mapper(vpH, WH, HH);

  for (const F of merged) {
    for (const l of lines) if (lineCentreIn(l, F, 1)) out.absorbed.add(l);
    const [a, b, c, d] = MH.toPx(F.x0 - PAD, F.bottom - PAD, F.x1 + PAD, F.top + PAD);
    const cw = c - a, ch = d - b;
    if (cw < 8 || ch < 8) continue;
    const crop = createCanvas(cw, ch);
    crop.getContext('2d').drawImage(hi, a, b, cw, ch, 0, 0, cw, ch);
    const src = await encode(crop);
    out.figures.push({ x0: F.x0 - PAD, x1: F.x1 + PAD, top: F.top + PAD, bottom: F.bottom - PAD, src });
  }
  return out;
}
