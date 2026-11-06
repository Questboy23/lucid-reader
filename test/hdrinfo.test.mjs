import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChapters, headerInfo, BACK_MATTER } from '../reader/lib/hdrinfo.js';

// 1000 words: h1 at 0, 300, 600, "Bibliography" h1 at 900. 1 word = 1 s.
function fixture(titles = ['Chapter One', 'Chapter Two', 'Chapter Three', 'Bibliography']) {
  const count = 1000, starts = [0, 300, 600, 900];
  const flags = new Uint8Array(count), blockOf = new Int32Array(count), text = [], blocks = [];
  let b = 0;
  for (let i = 0; i < count; i++) {
    const k = starts.indexOf(i);
    if (k >= 0) { blocks.push({ type: 'h1' }); b = blocks.length - 1; flags[i] = 8; text.push(titles[k]); }
    else { if (blocks[b]?.type === 'h1') { blocks.push({ type: 'p' }); b = blocks.length - 1; } text.push('w'); }
    blockOf[i] = b;
  }
  return { idx: { count, flags, blockOf, text, pageOf: new Int32Array(count).fill(1) }, doc: { blocks, numPages: 10 } };
}
const msLeft = from => (1000 - from) * 1000;
const S = { hdrNextChapter: true, hdrBookEnd: true, hdrSkipBackMatter: true };

test('chapters found and back matter cut off', () => {
  const { idx, doc } = fixture();
  const ch = findChapters(idx, doc);
  assert.equal(ch.chapters.length, 4);
  assert.equal(ch.bookEnd, 900);
});

test('header shows next chapter and book end without the bibliography', () => {
  const { idx, doc } = fixture();
  const ch = findChapters(idx, doc);
  const txt = headerInfo({ pos: 120, count: 1000, ch, msLeft, s: S, page: 1, pages: 10 });
  assert.equal(txt, 'Next chapter 3 m · Book end 13 m');
  const last = headerInfo({ pos: 700, count: 1000, ch, msLeft, s: S, page: 1, pages: 10 });
  assert.equal(last, 'Last chapter, ends in 3 m · Book end 3 m');
  const all = headerInfo({ pos: 120, count: 1000, ch, msLeft, s: { ...S, hdrSkipBackMatter: false }, page: 1, pages: 10 });
  assert.equal(all, 'Next chapter 3 m · Book end 15 m');
});

test('no back matter means the book ends at the last word', () => {
  const { idx, doc } = fixture(['A', 'B', 'C', 'D']);
  assert.equal(findChapters(idx, doc).bookEnd, 1000);
});

test('back-matter headings match, real chapters do not', () => {
  for (const t of ['Bibliography', 'References', 'Index', 'Notes', 'Appendix A', 'Acknowledgments', '12. Works Cited'])
    assert.ok(BACK_MATTER.test(t), t);
  for (const t of ['Indexing the Past', 'The Reference Class', 'Chapter 9', 'Noteworthy'])
    assert.ok(!BACK_MATTER.test(t), t);
});
