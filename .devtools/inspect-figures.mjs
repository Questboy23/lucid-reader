/**
 * Dev harness (not shipped): run extraction *with* figure capture in node and
 * dump every captured figure as a PNG, plus the block list, for eyeballing.
 *
 *   node .devtools/inspect-figures.mjs <file.pdf> <outdir> [maxPages]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [file, outDir, maxPagesArg] = process.argv.slice(2);
if (!file || !outDir) { console.error('usage: inspect-figures.mjs <pdf> <outdir> [maxPages]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
const pdfjs = await import('./pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = path.resolve('.devtools/pdf.worker.mjs');
const { extractDocument } = await import('../reader/lib/extract.js');
const { detectFigures } = await import('../reader/lib/figures.js');

let n = 0;
const figures = {
  detect: detectFigures,
  OPS: pdfjs.OPS,
  createCanvas: (w, h) => createCanvas(w, h),
  encode: async c => {
    const p = path.join(outDir, `fig-${String(++n).padStart(2, '0')}.png`);
    fs.writeFileSync(p, c.toBuffer('image/png'));
    return p;
  },
};

const data = new Uint8Array(fs.readFileSync(file));
const pdf = await pdfjs.getDocument({
  data, cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true,
  standardFontDataUrl: 'vendor/pdfjs/standard_fonts/', isEvalSupported: false,
}).promise;

const t0 = performance.now();
const doc = await extractDocument(pdf, { figures, maxPages: Number(maxPagesArg) || 0, fallbackTitle: path.basename(file) });
const ms = performance.now() - t0;
const counts = {};
for (const b of doc.blocks) counts[b.type] = (counts[b.type] || 0) + 1;
const shortP = doc.blocks.filter(b => b.type === 'p' && b.text.split(/\s+/).length < 8).length;
const links = doc.blocks.reduce((s, b) => s + (b.hrefs ? b.hrefs.filter(Boolean).length : 0), 0);
console.log(`blocks ${JSON.stringify(counts)}  short-p ${shortP}/${counts.p || 0}  linked-words ${links}  ${ms.toFixed(0)} ms`);
for (const b of doc.blocks) {
  if (b.type === 'pagebreak') { console.log(`--- page ${b.page}`); continue; }
  if (b.type === 'figure') { console.log(`[FIGURE p${b.page}] ${path.basename(b.src)} ${b.wPt.toFixed(0)}x${b.hPt.toFixed(0)}pt`); continue; }
  const t = b.text.length > 110 ? b.text.slice(0, 110) + '…' : b.text;
  const l = b.hrefs ? ` {links: ${[...new Set(b.hrefs.filter(Boolean))].join(', ')}}` : '';
  console.log(`[${b.type.padEnd(5)} p${b.page}] ${t}${l}`);
}
