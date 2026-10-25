import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phraseEnds, compressKeep } from '../reader/lib/markup.js';
import { findMatches } from '../reader/lib/search.js';
import { tableRuns } from '../reader/lib/figures.js';
import { insertFigures } from '../reader/lib/extract.js';

const words = s => s.split(' ');

test('phrases break before prepositions and at punctuation, max length respected', () => {
  const w = words('The quick fox ran over the hill, and then slept in the barn.');
  const ends = [...phraseEnds(w, 4)];
  assert.ok(ends.includes(3), 'break before "over"');
  assert.ok(ends.includes(6), 'break at the comma');
  assert.ok(ends.includes(w.length - 1));
  let len = 0;
  for (let i = 0; i < w.length; i++) { len++; if (ends.includes(i)) { assert.ok(len <= 4); len = 0; } }
});

test('compress drops filler but keeps negations, logic words and sentence ends', () => {
  const w = words('It is not the case that the model will fail.');
  const keep = compressKeep(w, 'filler');
  const kept = w.filter((_, i) => keep[i]).join(' ');
  assert.match(kept, /not/);
  assert.match(kept, /will/);
  assert.match(kept, /fail\.$/);
  assert.doesNotMatch(kept, /\bthe\b/);
});

test('compress topic mode keeps only the first sentence', () => {
  const w = words('First point here. Second point there. Third.');
  const keep = compressKeep(w, 'topic');
  assert.equal(w.filter((_, i) => keep[i]).join(' '), 'First point here.');
});

test('search matches phrases across punctuation and partial last word', () => {
  const text = words('The stall loop, then the Stall algorithm.');
  assert.deepEqual(findMatches(text, 'stall loop'), [[1, 2]]);
  assert.deepEqual(findMatches(text, 'stall algo'), [[5, 6]]);
  assert.deepEqual(findMatches(text, 'zebra'), []);
});

const item = (x0, x1, str) => ({ x0, x1, str });
const row = (y, cells) => ({
  y, size: 10, x0: cells[0][0], x1: cells[cells.length - 1][1],
  chars: cells.reduce((s, c) => s + c[2].length, 0),
  items: cells.map(c => item(...c)),
});

test('table runs need 3+ rows of 3+ short cells', () => {
  const t = [700, 685, 670].map(y => row(y, [[50, 80, '12'], [150, 200, 'Alpha'], [300, 340, '4.5']]));
  assert.equal(tableRuns(t).length, 1);
  const prose = [700, 685, 670].map(y => row(y, [[50, 550, 'x'.repeat(90)]]));
  assert.equal(tableRuns(prose).length, 0);
  const cols = [700, 685, 670].map(y => row(y, [[50, 200, 'y'.repeat(50)], [220, 370, 'y'.repeat(50)], [390, 540, 'y'.repeat(50)]]));
  assert.equal(tableRuns(cols).length, 0, 'three columns of prose are not a table');
});

test('figures slot in before the first block below them in their column', () => {
  const blocks = [
    { type: 'p', text: 'a', _g: { top: 700, bottom: 650, x0: 50, x1: 550 } },
    { type: 'p', text: 'b', _g: { top: 400, bottom: 350, x0: 50, x1: 550 } },
  ];
  const out = insertFigures(blocks, [{ x0: 60, x1: 500, top: 600, bottom: 450, src: 'x' }], 1);
  assert.deepEqual(out.map(b => b.type === 'figure' ? 'F' : b.text), ['a', 'F', 'b']);
});
