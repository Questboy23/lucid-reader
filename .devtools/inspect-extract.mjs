/**
 * Dev harness (not shipped): run extract.js against a real PDF in plain node so
 * extraction quality can be judged without loading the extension.
 *
 *   node .devtools/inspect-extract.mjs test/fixtures/twocol.pdf [--full]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const file = process.argv[2];
if (!file) {
  console.error('usage: node .devtools/inspect-extract.mjs <file.pdf> [--full]');
  process.exit(1);
}
const full = process.argv.includes('--full');

const require = createRequire(import.meta.url);
const pdfjs = await import('./pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = path.resolve('.devtools/pdf.worker.mjs');

const { extractDocument, extractionStats } = await import('../reader/lib/extract.js');

const data = new Uint8Array(fs.readFileSync(file));
const pdf = await pdfjs.getDocument({
  data,
  cMapUrl: 'vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
  isEvalSupported: false,
}).promise;

const t0 = performance.now();
const doc = await extractDocument(pdf, { fallbackTitle: path.basename(file) });
const ms = performance.now() - t0;

const words = doc.blocks.reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);
const counts = {};
for (const b of doc.blocks) counts[b.type] = (counts[b.type] || 0) + 1;

console.log('='.repeat(78));
console.log(`file        ${file}`);
console.log(`title       ${doc.title}`);
console.log(`pages       ${doc.numPages}`);
console.log(`blocks      ${doc.blocks.length}  ${JSON.stringify(counts)}`);
console.log(`words       ${words}`);
console.log(`extract ms  ${ms.toFixed(0)}`);
if (typeof extractionStats === 'function') {
  console.log(`stats       ${JSON.stringify(extractionStats())}`);
}
console.log('='.repeat(78));

const show = full ? doc.blocks : doc.blocks.slice(0, 40);
for (const b of show) {
  if (b.type === 'pagebreak') { console.log(`\n--- page ${b.page} ---`); continue; }
  const tag = b.type.padEnd(5);
  const text = full ? b.text : b.text.slice(0, 300) + (b.text.length > 300 ? ' …' : '');
  console.log(`[${tag} p${String(b.page).padStart(3)}] ${b.marker ? b.marker + ' ' : ''}${text}`);
}

/* Quality checks a human would otherwise have to eyeball. */
const problems = [];
const paras = doc.blocks.filter(b => b.type === 'p');
const shortParas = paras.filter(b => b.text.split(/\s+/).length < 8).length;
if (paras.length && shortParas / paras.length > 0.4) {
  problems.push(`${shortParas}/${paras.length} paragraphs are under 8 words — lines are probably not being joined`);
}
const midHyphen = doc.blocks.filter(b => /\w-\s+\w/.test(b.text)).length;
if (midHyphen) problems.push(`${midHyphen} blocks still contain a hyphen + space (de-hyphenation missed)`);
const headerLeak = doc.blocks.filter(b => /Working Paper 14|Saccadic Control in Continuous/.test(b.text)).length;
if (headerLeak > 2) problems.push(`running header appears in ${headerLeak} blocks (should be dropped)`);
const pageNums = doc.blocks.filter(b => b.type !== 'pagebreak' && /^\d{1,3}$/.test(b.text.trim())).length;
if (pageNums) problems.push(`${pageNums} blocks are bare page numbers`);

console.log('\n' + (problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'no obvious extraction problems'));
