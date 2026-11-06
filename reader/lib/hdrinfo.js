/**
 * Top-bar reading info: time to the next chapter, time to the end of the book
 * (stopping before the bibliography, index, notes and other back matter), and
 * whatever else the reader turns on in Settings > Top bar.
 *
 * findChapters() runs once per render. It reads the heading flags the markup
 * step already set, so it costs one pass over the word index.
 * headerInfo() runs on every status update and only does array lookups.
 */

const LEVEL = { h1: 1, h2: 2, h3: 3 };
const HEADING = 8; // FLAG.HEADING in markup.js

/** Heading text that starts the back matter nobody reads. */
export const BACK_MATTER = new RegExp(
  '^\\s*(?:[0-9ivx]+[.)]?\\s+)?(?:' + [
    'bibliography', 'selected bibliography', 'references', 'reference list', 'works cited',
    'literature cited', 'sources', 'notes', 'endnotes', 'end notes', 'notes and references',
    'index', 'subject index', 'name index', 'general index', 'appendix', 'appendices',
    'acknowledg(?:e)?ments?', 'about the authors?', 'glossary', 'further reading',
    'suggested reading', 'also by', 'colophon', 'permissions', 'credits', 'photo credits',
    'image credits', 'citations',
  ].join('|') + ')\\b', 'i');

/**
 * @returns {{ chapters: {start:number,title:string}[], bookEnd: number }}
 * bookEnd is the first word of the back matter, or idx.count when none is found.
 */
export function findChapters(idx, doc) {
  const heads = [];
  if (!idx || !doc) return { chapters: [], bookEnd: idx?.count ?? 0 };
  let prevBlock = -1;
  for (let i = 0; i < idx.count; i++) {
    if (!(idx.flags[i] & HEADING)) continue;
    const b = idx.blockOf[i];
    if (b === prevBlock) continue;
    prevBlock = b;
    const lvl = LEVEL[doc.blocks[b]?.type] ?? 3;
    if (lvl > 2) continue;
    let j = i;
    while (j < idx.count && idx.blockOf[j] === b) j++;
    heads.push({ start: i, level: lvl, title: idx.text.slice(i, j).join(' ') });
  }

  // Chapters are the h1s when there are at least two, else h1s and h2s together.
  const h1 = heads.filter(x => x.level === 1);
  const chapters = (h1.length >= 2 ? h1 : heads).map(({ start, title }) => ({
    start, title: title.length > 60 ? `${title.slice(0, 58)}…` : title,
  }));

  // Back matter only counts in the second half, so a "Notes on method" intro stays in.
  let bookEnd = idx.count;
  const half = idx.count / 2;
  for (const x of heads) {
    if (x.start >= half && BACK_MATTER.test(x.title)) { bookEnd = x.start; break; }
  }
  return { chapters, bookEnd };
}

/** 95 min -> "1 h 35 m"; under a minute -> "<1 m". */
export function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (ms > 0 && m < 1) return '<1 m';
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

/**
 * Builds the top-bar text.
 * @param {object} o
 * @param {number} o.pos        current word
 * @param {number} o.count      words in the document
 * @param {{chapters, bookEnd}} o.ch  from findChapters
 * @param {(from:number)=>number} o.msLeft  ms from a word to the end of the PDF
 * @param {object} o.s          settings
 * @param {number} o.page       current PDF page
 * @param {number} o.pages      PDF page count
 * @param {Date}  [o.now]
 */
export function headerInfo({ pos, count, ch, msLeft, s, page, pages, now = new Date() }) {
  if (!count) return '';
  const between = (a, b) => Math.max(0, msLeft(a) - msLeft(b));
  const end = s.hdrSkipBackMatter ? ch.bookEnd : count;
  const out = [];

  let cur = -1;
  for (let k = 0; k < ch.chapters.length; k++) if (ch.chapters[k].start <= pos) cur = k; else break;

  if (s.hdrChapterName && cur >= 0) out.push(ch.chapters[cur].title);

  if (s.hdrNextChapter && ch.chapters.length) {
    const next = ch.chapters[cur + 1];
    if (next && next.start < end) out.push(`Next chapter ${fmtDur(between(pos, next.start))}`);
    else if (pos < end) out.push(`Last chapter, ends in ${fmtDur(between(pos, end))}`);
  }

  if (s.hdrBookEnd) {
    if (pos >= end && end < count) out.push('Main text done');
    else out.push(`Book end ${fmtDur(between(pos, end))}`);
  }

  if (s.hdrWholeDoc) out.push(`Whole PDF ${fmtDur(msLeft(pos))}`);
  if (s.hdrPercent) out.push(`${Math.round((Math.min(pos, end) / Math.max(1, end)) * 100)}%`);
  if (s.hdrPage) out.push(`p. ${page}/${pages}`);
  if (s.hdrFinishClock) {
    const ms = between(pos, end);
    if (ms > 60000) {
      const t = new Date(now.getTime() + ms);
      const clock = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      out.push(t.toDateString() === now.toDateString() ? `done ${clock}` : `done ${t.toLocaleDateString([], { weekday: 'short' })} ${clock}`);
    }
  }
  return out.join(' · ');
}
