/** Dev harness: render one PDF page to PNG.  node .devtools/render-page.mjs <pdf> <page> <out.png> */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const [file, pageArg, out] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
const pdfjs = await import('./pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = path.resolve('.devtools/pdf.worker.mjs');
const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), standardFontDataUrl: 'vendor/pdfjs/standard_fonts/', isEvalSupported: false }).promise;
const page = await pdf.getPage(Number(pageArg));
const vp = page.getViewport({ scale: 1.2 });
const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
const ctx = c.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
await page.render({ canvasContext: ctx, viewport: vp }).promise;
fs.writeFileSync(out, c.toBuffer('image/png'));
