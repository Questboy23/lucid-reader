import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupIntoLines, detectColumns, findRunningHeads, isPageNumber, classifySizes,
  headingLevel, computeStats, joinLines, dehyphenate, splitListMarker,
  extractDocument, extractionStats,
} from '../reader/lib/extract.js';

/* ------------------------------------------------------------ fixtures --- */

const STYLES = {
  'f-body': { fontFamily: 'serif', ascent: 0.7, descent: -0.2, vertical: false },
  'f-head': { fontFamily: 'serif', ascent: 0.7, descent: -0.2, vertical: false },
  'f-bold': { fontFamily: 'serif', ascent: 0.7, descent: -0.2, vertical: false, fontWeight: 'bold' },
  'f-mono': { fontFamily: 'monospace', ascent: 0.7, descent: -0.2, vertical: false },
};

/** [str, x, y, size, {width, font}] -> pdf.js text item */
function item([str, x, y, size, o = {}]) {
  return {
    str, dir: 'ltr',
    width: o.width ?? str.length * size * 0.5,
    height: size,
    transform: [size, 0, 0, size, x, y],
    fontName: o.font ?? 'f-body',
    hasEOL: false,
  };
}
const items = specs => specs.map(item);
const lines = specs => groupIntoLines(items(specs), STYLES);

/** n body lines at x, top y, pitch p; `widths[i]` overrides the default full width. */
function para(texts, x, top, { size = 10, pitch = 14, width = 230, widths = {}, font } = {}) {
  return texts.map((t, i) => [t, x, top - i * pitch, size, { width: widths[i] ?? width, font }]);
}

const statsFor = ls => computeStats([{ lines: ls }]);
const texts = blocks => blocks.map(b => b.text);

/* ------------------------------------------------------ line grouping --- */

test('groupIntoLines: merges items on one baseline, orders top-to-bottom and left-to-right', () => {
  const ls = lines([
    ['world', 130, 600, 10],            // second word of line 2, emitted first
    ['Second', 100, 600, 10, { width: 28 }],
    ['line', 100, 700, 10, { width: 20 }],
    ['First', 60, 700, 10, { width: 25 }],
    ['', 0, 0, 0],                      // empty items are noise
    ['   ', 60, 650, 10],
  ]);
  assert.equal(ls.length, 2);
  assert.equal(ls[0].text, 'First line');
  assert.equal(ls[1].text, 'Second world');
  assert.ok(ls[0].y > ls[1].y);
  assert.equal(ls[0].x0, 60);
  assert.equal(ls[0].x1, 120);
});

test('groupIntoLines: baseline tolerance scales with glyph height; superscripts join, next line does not', () => {
  const ls = lines([
    ['Body text', 60, 700, 10, { width: 45 }],
    ['1', 106, 704, 6, { width: 3 }],        // footnote marker, raised 4pt
    ['Next line', 60, 688, 10, { width: 45 }],
  ]);
  assert.equal(ls.length, 2);
  assert.equal(ls[0].text, 'Body text 1');
  assert.equal(ls[0].size, 10, 'dominant size wins over the superscript');
  assert.ok(Math.abs(ls[0].y - 700) < 0.5, 'baseline is not dragged by the superscript');
});

test('groupIntoLines: glyph-per-item text gets word spaces from gaps, not from adjacent glyphs', () => {
  const g = (ch, x) => [ch, x, 500, 10, { width: 5 }];
  const ls = lines([g('a', 60), g('b', 65), g('c', 70), g('d', 78), g('e', 83)]);
  assert.equal(ls[0].text, 'abc de');
});

test('groupIntoLines: drops rotated and mirrored text (marginal stamps)', () => {
  const rotated = item(['Downloaded from', 20, 400, 8]);
  rotated.transform = [0, 8, -8, 0, 20, 400];
  const flipped = item(['upside down', 60, 300, 8]);
  flipped.transform = [8, 0, 0, -8, 60, 300];
  const ls = groupIntoLines([rotated, flipped, item(['Body', 60, 500, 10])], STYLES);
  assert.deepEqual(ls.map(l => l.text), ['Body']);
});

test('groupIntoLines: bold/mono from styles and font names', () => {
  const ls = lines([
    ['Heading', 60, 700, 10, { font: 'f-bold' }],
    ['code', 60, 680, 10, { font: 'f-mono' }],
    ['Plain', 60, 660, 10, { font: 'TimesNewRoman-Bold' }],
  ]);
  assert.equal(ls[0].bold, true);
  assert.equal(ls[1].mono, true);
  assert.equal(ls[2].bold, true, 'bold is inferred from a real font name too');
});

/* ------------------------------------------------------ de-hyphenation --- */

test('dehyphenate: joins a word split at a line end', () => {
  assert.equal(dehyphenate('inter-', 'esting'), 'interesting');
  assert.equal(dehyphenate('This is inter-', 'esting stuff'), 'This is interesting stuff');
  assert.equal(dehyphenate('soft­', 'ware'), 'software');
});

test('dehyphenate: keeps genuine hyphens', () => {
  assert.equal(dehyphenate('well-', 'Being'), 'well-Being');     // capitalised continuation
  assert.equal(dehyphenate('24-', 'hour'), '24-hour');           // digit before
  assert.equal(dehyphenate('Figure 3-', '2'), 'Figure 3-2');     // digit after
  assert.equal(dehyphenate('X-', 'ray'), 'X-ray');               // all-caps fragment
  assert.equal(dehyphenate('self-', 'aware'), 'self-aware');     // known prefix
});

test('dehyphenate: returns null when there is nothing to join', () => {
  assert.equal(dehyphenate('cat', 'dog'), null);
  assert.equal(dehyphenate('foo -', 'bar'), null);               // spaced dash, not a break
  assert.equal(dehyphenate('foo —', 'bar'), null);
  assert.equal(dehyphenate('', 'bar'), null);
  assert.equal(dehyphenate('foo-', ''), null);
});

test('dehyphenate: en dash ranges join without a space', () => {
  assert.equal(dehyphenate('pages 10–', '20'), 'pages 10–20');
});

/* ------------------------------------------------------ page furniture --- */

test('isPageNumber', () => {
  for (const s of ['12', ' 7 ', '- 12 -', 'Page 3 of 10', 'iv', 'xiv', '[7]', '3 / 12', 'p. 4']) {
    assert.ok(isPageNumber(s), `should match ${JSON.stringify(s)}`);
  }
  for (const s of ['12 apples', 'Chapter 12', 'Section', '', '1. Introduction', 'Table 3']) {
    assert.ok(!isPageNumber(s), `should not match ${JSON.stringify(s)}`);
  }
});

test('findRunningHeads: text repeating near the same y on 3+ pages is dropped, body text is not', () => {
  const pages = [];
  for (let p = 1; p <= 4; p++) {
    pages.push({
      height: 792,
      lines: lines([
        [`Journal of Reading ${p + 10}`, 200, 760, 9, { width: 120 }],  // header, page number varies
        [`Chapter ${p}`, 60, 700, 14, { width: 60 }],                   // heading at 88% — not furniture
        [`Body paragraph on page ${p}.`, 60, 680, 10, { width: 230 }],
        ['Journal of Reading', 60, 400, 10, { width: 120 }],            // same text mid-page: not furniture
        [`Author et al. — ${p}`, 60, 30, 9, { width: 100 }],            // footer
      ]),
    });
  }
  const drop = findRunningHeads(pages);
  const dropped = [...drop].map(l => l.text).sort();
  assert.equal(drop.size, 8, `dropped: ${dropped.join(' | ')}`);
  for (const pg of pages) {
    assert.ok(drop.has(pg.lines[0]), 'header dropped');
    assert.ok(drop.has(pg.lines[4]), 'footer dropped');
    assert.ok(!drop.has(pg.lines[1]), 'chapter heading kept');
    assert.ok(!drop.has(pg.lines[2]), 'body kept');
    assert.ok(!drop.has(pg.lines[3]), 'mid-page repeat kept');
  }
});

test('findRunningHeads: needs three pages unless the document only has two', () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({
    height: 792,
    lines: lines([['Running head', 60, 770, 9, { width: 60 }], [`Body ${i}`, 60, 600, 10]]),
  }));
  assert.equal(findRunningHeads(mk(1)).size, 0);
  assert.equal(findRunningHeads(mk(2)).size, 2);
  const three = mk(3);
  three[2].lines[0].y = 500;                       // third page has it mid-body: only 2 pages agree on y
  assert.equal(findRunningHeads(three).size, 0);
});

/* ------------------------------------------------------------ headings --- */

test('classifySizes: body size is the char-weighted mode; heading sizes rank downward', () => {
  const ls = lines([
    ['A Big Title Here', 60, 740, 20, { width: 200, font: 'f-head' }],
    ['1 Section', 60, 700, 14, { width: 80, font: 'f-head' }],
    ...para(Array(12).fill('The quick brown fox jumps over the lazy dog again and again.'), 60, 680),
    ['2 Section', 60, 500, 14, { width: 80, font: 'f-head' }],
    ...para(Array(6).fill('Small footnote text that is long enough to count a bit.'), 60, 480, { size: 8, pitch: 10 }),
  ]);
  const s = classifySizes(ls);
  assert.equal(s.bodySize, 10);
  assert.deepEqual(s.headingSizes, [20, 14]);
  assert.equal(s.bodyFont, 'f-body');
  assert.equal(headingLevel(20, false, s), 1);
  assert.equal(headingLevel(14, false, s), 2);
  assert.equal(headingLevel(10, true, s), 3, 'bold body-size text sits under the sized headings');
  assert.equal(headingLevel(10, false, s), 0);
  assert.equal(headingLevel(8, true, s), 0, 'small bold text is never a heading');
});

test('joinLines: headings by size, by bold, and by a rare font on a short line', () => {
  const ls = lines([
    ['A Big Title', 60, 740, 20, { width: 120, font: 'f-head' }],
    ['1 Section', 60, 700, 14, { width: 60, font: 'f-head' }],
    ...para(Array(10).fill('Body text that runs to the full measure of the column, yes.'), 60, 680),
    ['Bold lead', 60, 520, 10, { width: 50, font: 'f-bold' }],
    ...para(Array(3).fill('Body text that runs to the full measure of the column, yes.'), 60, 500),
    ['Italic subhead', 60, 440, 10, { width: 70, font: 'f-ital' }],
    ...para(Array(3).fill('Body text that runs to the full measure of the column, yes.'), 60, 420),
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.deepEqual(blocks.map(b => b.type), ['h1', 'h2', 'p', 'h3', 'p', 'h3', 'p']);
  assert.equal(blocks[0].text, 'A Big Title');
  assert.equal(blocks[3].text, 'Bold lead');
  assert.equal(blocks[5].text, 'Italic subhead');
});

test('joinLines: a two-line title is one heading, not two', () => {
  const ls = lines([
    ['Saccadic Control in', 60, 740, 20, { width: 170, font: 'f-head' }],
    ['Continuous Reading', 60, 718, 20, { width: 175, font: 'f-head' }],
    ...para(Array(8).fill('Body text that runs to the full measure of the column, yes.'), 60, 690),
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks[0].type, 'h1');
  assert.equal(blocks[0].text, 'Saccadic Control in Continuous Reading');
});

/* ---------------------------------------------------------- paragraphs --- */

const FULL = 'Body text that runs to the full measure of the column, yes.';

test('joinLines: a vertical gap larger than the line pitch starts a paragraph', () => {
  const ls = lines([
    ...para([FULL, FULL, 'ends here'], 60, 700, { widths: { 2: 45 } }),
    ...para([FULL, FULL, FULL], 60, 700 - 2 * 14 - 24),       // 24pt gap vs 14pt pitch
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].text.endsWith('ends here'));
});

test('joinLines: lines at normal pitch stay one paragraph even when a line ends with a period', () => {
  const ls = lines(para([
    'A sentence that ends right at the edge of the measure now.',
    'Another one continues here without any paragraph break at',
    'all and keeps going.',
  ], 60, 700, { widths: { 2: 90 } }));
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'A sentence that ends right at the edge of the measure now. Another one continues here without any paragraph break at all and keeps going.');
});

test('joinLines: a first-line indent starts a paragraph', () => {
  const specs = para([FULL, FULL, FULL, FULL, FULL, FULL], 60, 700);
  specs[3][1] = 78;                                            // 18pt indent at 10pt body
  specs[3][4].width = 212;
  const ls = lines(specs);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text.split(FULL).length - 1, 3);
});

test('joinLines: a hanging-indent bibliography breaks on the outdented entry starts', () => {
  const entry = (top, n) => [
    [`[${n}] A. Author, "A title," Journal, 2020.`, 60, top, 10, { width: 230 }],
    ['continued reference text here, pp. 1–10.', 80, top - 14, 10, { width: 200 }],
    ['and a third line of the reference.', 80, top - 28, 10, { width: 160 }],
  ];
  const ls = lines([...entry(700, 1), ...entry(658, 2), ...entry(616, 3)]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].text.startsWith('[2]'));
  assert.ok(blocks[1].text.endsWith('third line of the reference.'));
});

test('joinLines: a short line that ends a sentence, followed by a capital, ends the paragraph', () => {
  const ls = lines([
    ...para([FULL, FULL, 'the end.'], 60, 700, { widths: { 2: 40 } }),
    ...para([FULL, FULL], 60, 700 - 3 * 14),                  // same pitch, no gap, no indent
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].text.endsWith('the end.'));
});

test('joinLines: a short line followed by a lowercase continuation is not a break', () => {
  const ls = lines([
    ...para([FULL, 'see e.g.'], 60, 700, { widths: { 1: 40 } }),
    ...para(['the following lines which continue the same sentence and', FULL], 60, 700 - 2 * 14),
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 1);
});

test('joinLines: de-hyphenates across lines inside a paragraph', () => {
  const ls = lines(para([
    'Reading on screens is an inter-',
    'esting problem for a well-',
    'Known reason: the twenty-',
    'four hour cycle.',
  ], 60, 700, { widths: { 3: 80 } }));
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'Reading on screens is an interesting problem for a well-Known reason: the twentyfour hour cycle.');
});

test('joinLines: monospace lines become a pre block that keeps line breaks', () => {
  const ls = lines([
    ...para([FULL, FULL], 60, 700),
    ...para(['def f(x):', '    return x'], 60, 700 - 2 * 14, { font: 'f-mono', widths: { 0: 50, 1: 60 } }),
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, 'pre');
  // Indentation is positional in a PDF and markup.js splits on whitespace anyway; line breaks are what matter.
  assert.equal(blocks[1].text, 'def f(x):\nreturn x');
});

test('joinLines: a block inset on both sides is a quote', () => {
  const ls = lines([
    ...para([FULL, FULL, FULL, FULL], 60, 700),
    ...para(['A quoted passage that is inset from', 'both margins of the column here.'], 90, 700 - 4 * 14 - 10, { width: 170 }),
    ...para([FULL, FULL, FULL, FULL], 60, 700 - 6 * 14 - 20),
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.deepEqual(blocks.map(b => b.type), ['p', 'quote', 'p']);
});

/* --------------------------------------------------------------- lists --- */

test('splitListMarker: bullets and numbers are split, prose is not', () => {
  assert.deepEqual(splitListMarker('• Foo bar'), { marker: '•', text: 'Foo bar', kind: 'bullet' });
  assert.deepEqual(splitListMarker('- Foo bar'), { marker: '-', text: 'Foo bar', kind: 'bullet' });
  assert.deepEqual(splitListMarker('3. Foo'), { marker: '3.', text: 'Foo', kind: 'number' });
  assert.deepEqual(splitListMarker('(b) Foo'), { marker: '(b)', text: 'Foo', kind: 'number' });
  assert.deepEqual(splitListMarker('iv) Foo'), { marker: 'iv)', text: 'Foo', kind: 'number' });
  assert.deepEqual(splitListMarker('2.1 Results'), { marker: '2.1', text: 'Results', kind: 'number' });
  assert.equal(splitListMarker('2019. The year it began'), null);
  assert.equal(splitListMarker('1.5 mm of rain'), null);
  assert.equal(splitListMarker('I. Newton wrote'), null);
  assert.equal(splitListMarker('e.g. the following'), null);
  assert.equal(splitListMarker('A. Smith and B. Jones'), null);
  assert.equal(splitListMarker('Plain sentence.'), null);
});

test('joinLines: bullet items become li blocks with the marker split off, continuation lines stay attached', () => {
  const ls = lines([
    ['Three consequences follow:', 60, 700, 10, { width: 120 }],
    ['•', 66, 680, 10, { width: 4, font: 'f-sym' }], ['Line length interacts with line height and', 80, 680, 10, { width: 200 }],
    ['keeps going on a second line.', 80, 666, 10, { width: 130 }],
    ['•', 66, 646, 10, { width: 4, font: 'f-sym' }], ['Font size is not font weight.', 80, 646, 10, { width: 130 }],
    ['•', 66, 626, 10, { width: 4, font: 'f-sym' }], ['Contrast has a floor.', 80, 626, 10, { width: 100 }],
    ...para([FULL, FULL, FULL, FULL, FULL, FULL], 60, 600),
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.deepEqual(blocks.map(b => b.type), ['p', 'li', 'li', 'li', 'p']);
  assert.equal(blocks[1].marker, '•');
  assert.equal(blocks[1].text, 'Line length interacts with line height and keeps going on a second line.');
  assert.equal(blocks[3].text, 'Contrast has a floor.');
});

test('joinLines: numbered items split after a short line; a year mid-paragraph does not', () => {
  const ls = lines([
    ['Steps:', 60, 700, 10, { width: 30 }],
    ['1. Open the file.', 60, 686, 10, { width: 80 }],
    ['2. Read it.', 60, 672, 10, { width: 60 }],
    ['3) Close it.', 60, 658, 10, { width: 60 }],
    ...para(['It was first described in the winter of', '2019. The finding was later replicated', 'by others and still holds.'], 60, 630, { widths: { 2: 120 } }),
  ]);
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.deepEqual(blocks.map(b => b.type), ['p', 'li', 'li', 'li', 'p']);
  assert.deepEqual(blocks.slice(1, 4).map(b => b.marker), ['1.', '2.', '3)']);
  assert.equal(blocks[4].text, 'It was first described in the winter of 2019. The finding was later replicated by others and still holds.');
});

/* ------------------------------------------------------------- columns --- */

/** Two columns of body text with equal baselines; returns item specs. */
function twoColumns(top, n, { l1 = 60, l2 = 320, w = 230, tag = '' } = {}) {
  const specs = [];
  for (let i = 0; i < n; i++) {
    specs.push([`L${tag}${i} left column text fills the measure`, l1, top - i * 14, 10, { width: w }]);
    specs.push([`R${tag}${i} right column text fills the measure`, l2, top - i * 14, 10, { width: w }]);
  }
  return specs;
}

test('detectColumns: a two-column page is read column by column, title first', () => {
  const ls = lines([
    ['A Title That Spans The Whole Page Width', 60, 740, 18, { width: 490 }],
    ...twoColumns(700, 10),
  ]);
  const { lines: ordered, columns } = detectColumns(ls, 612);
  assert.equal(columns, 2);
  const seq = ordered.map(l => l.text.split(' ')[0]);
  assert.deepEqual(seq, ['A', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']);
  assert.equal(ordered[0].col, -1);
  assert.equal(ordered[1].col, 0);
  assert.equal(ordered[11].col, 1);
});

test('detectColumns: a full-width caption splits the page into bands', () => {
  const ls = lines([
    ...twoColumns(700, 4, { tag: 'a' }),
    ['Figure 1: a caption that runs across both columns of the page here', 60, 630, 9, { width: 470 }],
    ...twoColumns(600, 4, { tag: 'b' }),
  ]);
  const { lines: ordered, columns } = detectColumns(ls, 612);
  assert.equal(columns, 2);
  const seq = ordered.map(l => l.text.split(' ')[0]);
  assert.deepEqual(seq, ['La0', 'La1', 'La2', 'La3', 'Ra0', 'Ra1', 'Ra2', 'Ra3', 'Figure', 'Lb0', 'Lb1', 'Lb2', 'Lb3', 'Rb0', 'Rb1', 'Rb2', 'Rb3']);
});

test('detectColumns: columns with unaligned baselines and a short second column still read in order', () => {
  const specs = [];
  for (let i = 0; i < 12; i++) specs.push([`L${i} left column text fills the measure`, 60, 700 - i * 14, 10, { width: 230 }]);
  for (let i = 0; i < 5; i++) specs.push([`R${i} right column text fills the measure`, 320, 693 - i * 14, 10, { width: 230 }]);
  const { lines: ordered, columns } = detectColumns(lines(specs), 612);
  assert.equal(columns, 2);
  const seq = ordered.map(l => l.text.split(' ')[0]);
  assert.deepEqual(seq.slice(0, 12), Array.from({ length: 12 }, (_, i) => `L${i}`));
  assert.deepEqual(seq.slice(12), ['R0', 'R1', 'R2', 'R3', 'R4']);
});

test('detectColumns: a small table inside a one-column page does not create columns', () => {
  const specs = para(Array(12).fill(FULL), 60, 740, { width: 490 });
  for (let i = 0; i < 4; i++) {
    specs.push([`row ${i}`, 60, 560 - i * 14, 10, { width: 40 }]);
    specs.push([`${i * 10}`, 300, 560 - i * 14, 10, { width: 20 }]);
  }
  specs.push(...para(Array(6).fill(FULL), 60, 480, { width: 490 }));
  const { lines: ordered, columns } = detectColumns(lines(specs), 612);
  assert.equal(columns, 1);
  assert.deepEqual(ordered.map(l => l.text).slice(12, 16), ['row 0 0', 'row 1 10', 'row 2 20', 'row 3 30']);
});

test('detectColumns: a CV-style right-hand date column is read row by row', () => {
  const specs = [];
  for (let i = 0; i < 10; i++) {
    specs.push([`Entry ${i} description of the role and its duties`, 60, 700 - i * 14, 10, { width: 190 }]);
    if (i % 3 === 0) specs.push([`201${i}`, 500, 700 - i * 14, 10, { width: 20 }]);
  }
  const { lines: ordered, columns } = detectColumns(lines(specs), 612);
  assert.equal(columns, 1);
  assert.equal(ordered[0].text, 'Entry 0 description of the role and its duties 2010');
  assert.equal(ordered[3].text, 'Entry 3 description of the role and its duties 2013');
});

test('joinLines: a paragraph flowing from column one into column two is joined', () => {
  const specs = [];
  const L = ['Start of a paragraph in the first column that', 'continues over several lines of text and', 'finally spills into the second column with no'];
  const R = ['visible break at all.', 'A fresh paragraph starts here and fills the', 'measure of the right column entirely, yes.'];
  L.forEach((t, i) => specs.push([t, 60, 700 - i * 14, 10, { width: 230 }]));
  R.forEach((t, i) => specs.push([t, 320, 700 - i * 14, 10, { width: i === 0 ? 100 : 230 }]));
  const ls = detectColumns(lines(specs), 612).lines;
  const blocks = joinLines(ls, statsFor(ls), 1);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].text.endsWith('with no visible break at all.'));
  assert.ok(blocks[1].text.startsWith('A fresh paragraph'));
});

/* ------------------------------------------------------ extractDocument --- */

function fakePdf(pagesOfItems, { title = '' } = {}) {
  return {
    numPages: pagesOfItems.length,
    async getMetadata() { return { info: { Title: title } }; },
    async getPage(n) {
      return {
        view: [0, 0, 612, 792],
        getViewport: () => ({ width: 612, height: 792 }),
        async getTextContent() { return { items: pagesOfItems[n - 1], styles: STYLES }; },
        cleanup() {},
      };
    },
  };
}

function bodyPage(n, texts) {
  return items([
    [`Working Paper 14 — Reading ${n}`, 200, 760, 9, { width: 150 }],
    [String(n), 300, 30, 9, { width: 6 }],
    ...para(texts, 60, 700, { width: 490 }),
  ]);
}

test('extractDocument: pages, running heads, page breaks, title and stats', async () => {
  const pdf = fakePdf([
    bodyPage(1, [FULL, FULL, 'ending with an inter-']),
    items([]),                                                // scanned page
    bodyPage(3, ['esting continuation.', FULL, FULL]),
    bodyPage(4, [FULL, FULL, FULL]),
  ], { title: 'Microsoft Word - My Paper.docx' });
  const progress = [];
  const doc = await extractDocument(pdf, { onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(doc.title, 'My Paper');
  assert.equal(doc.numPages, 4);
  assert.equal(doc.truncated, false);
  assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.deepEqual(doc.blocks.map(b => b.type), ['p', 'pagebreak', 'p', 'pagebreak', 'p']);
  assert.deepEqual(doc.blocks.map(b => b.page), [1, 1, 3, 3, 4]);
  assert.ok(doc.blocks[0].text.endsWith('ending with an interesting'), 'hyphenated word carried across the page break');
  assert.equal(doc.blocks[2].text.startsWith('continuation.'), true);
  const s = extractionStats();
  assert.equal(s.pagesWithText, 3);
  assert.equal(s.pagesEmpty, 1);
  assert.equal(s.droppedRunningHeads, 6);
  assert.equal(s.columnsSeen, 1);
});

test('extractDocument: falls back to the first heading, then to fallbackTitle', async () => {
  const withHeading = fakePdf([items([
    ['The Real Title', 60, 740, 20, { width: 150, font: 'f-head' }],
    ...para([FULL, FULL, FULL], 60, 700, { width: 490 }),
  ])]);
  assert.equal((await extractDocument(withHeading, { fallbackTitle: 'file.pdf' })).title, 'The Real Title');
  const plain = fakePdf([items(para([FULL, FULL, FULL], 60, 700, { width: 490 }))], { title: 'untitled' });
  assert.equal((await extractDocument(plain, { fallbackTitle: 'file.pdf' })).title, 'file.pdf');
});

test('extractDocument: maxPages truncates, a scanned document yields no blocks, abort rejects', async () => {
  const pdf = fakePdf([bodyPage(1, [FULL, FULL]), bodyPage(2, [FULL, FULL]), bodyPage(3, [FULL, FULL])]);
  const doc = await extractDocument(pdf, { maxPages: 2 });
  assert.equal(doc.truncated, true);
  assert.equal(doc.numPages, 3);
  assert.deepEqual(doc.blocks.map(b => b.page), [1, 1, 2]);

  const scanned = await extractDocument(fakePdf([items([]), items([['x', 60, 700, 10]])]));
  assert.deepEqual(scanned.blocks, []);
  assert.equal(extractionStats().pagesEmpty, 2);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(extractDocument(pdf, { signal: ac.signal }));
});

test('extractDocument: a page that throws is treated as empty, not fatal', async () => {
  const pdf = fakePdf([bodyPage(1, [FULL, FULL]), bodyPage(2, [FULL, FULL]), bodyPage(3, [FULL, FULL])]);
  const orig = pdf.getPage.bind(pdf);
  pdf.getPage = async n => { if (n === 2) throw new Error('boom'); return orig(n); };
  const doc = await extractDocument(pdf);
  assert.deepEqual(doc.blocks.map(b => b.page), [1, 1, 3]);
  assert.equal(extractionStats().pagesEmpty, 1);
  assert.equal(extractionStats().pagesWithText, 2);
  assert.equal(extractionStats().droppedRunningHeads, 4, 'running heads are judged on the pages that have text');
});
