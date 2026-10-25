/**
 * Contents panel: the document's chapters and sections down the left side,
 * each with how long it takes to read, how long until you reach it, and a
 * progress bar, plus that panel's own settings pinned at the bottom.
 *
 * Section times come from a prefix sum of the pacer's per-word durations, so
 * they include the comma/sentence/paragraph pauses and change with wpm.
 * Sections are the headings (h1-h3, filtered by depth) or, for a document
 * without headings, its PDF pages.
 */

import { BY_KEY } from './schema.js';

const LEVEL = { h1: 1, h2: 2, h3: 3 };
const PANEL_KEYS = [
  'outlineSource', 'outlineDepth', 'outlineShowLength', 'outlineShowUntil',
  'outlineShowBars', 'outlineShowWords', 'outlineShowPages', 'outlineFollow', 'outlineWidth',
];

export function fmtMs(ms) {
  const m = Math.round(ms / 60000);
  if (ms > 0 && m < 1) return '<1 m';
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
};

export function createOutline({ root, getIndex, getDoc, getSettings, getPosition, getDuration, onJump, onSave, onClose }) {
  root.textContent = '';
  root.setAttribute('aria-label', 'Contents');
  const head = h('div', { class: 'ol-head' },
    h('div', { class: 'ol-title', text: 'Contents' }),
    h('button', { class: 'ol-x', 'aria-label': 'Close contents', title: 'Close (O)', text: '✕' }));
  const summary = h('div', { class: 'ol-summary' });
  const list = h('ol', { class: 'ol-list' });
  const foot = h('details', { class: 'ol-settings' }, h('summary', { text: 'Contents settings' }));
  const footBody = h('div', { class: 'ol-set-body' });
  foot.append(footBody);
  root.append(head, summary, list, foot);
  head.querySelector('.ol-x').addEventListener('click', () => onClose?.());

  let sections = [];       // { start, end, level, title, page, li, timeEl, untilEl, barEl }
  let prefix = null;       // prefix[i] = ms to read words [0, i)
  let prefixSig = '';
  let lastCur = -2;

  /* ------------------------------------------------------------ timing --- */

  function ensurePrefix() {
    const idx = getIndex();
    const s = getSettings();
    if (!idx) return null;
    const sig = `${idx.count}|${s.wpm}|${s.pauseComma}|${s.pausePeriod}|${s.pauseParagraph}|${s.pauseHeading}|${s.pauseLongWord}|${s.longWordLen}`;
    if (prefix && sig === prefixSig) return prefix;
    prefix = new Float64Array(idx.count + 1);
    for (let i = 0; i < idx.count; i++) prefix[i + 1] = prefix[i] + Math.max(0, getDuration(i));
    prefixSig = sig;
    return prefix;
  }
  const msBetween = (a, b) => (prefix ? prefix[Math.max(a, 0)] - prefix[Math.max(b, 0)] : 0);

  /* ---------------------------------------------------------- sections --- */

  function buildSections() {
    const idx = getIndex(), doc = getDoc(), s = getSettings();
    if (!idx || !doc) return [];
    const out = [];
    const useHeadings = s.outlineSource !== 'pages';
    if (useHeadings) {
      let prevBlock = -1;
      for (let i = 0; i < idx.count; i++) {
        if (!(idx.flags[i] & 8)) continue;                     // FLAG.HEADING
        const b = idx.blockOf[i];
        if (b === prevBlock) continue;
        prevBlock = b;
        const lvl = LEVEL[doc.blocks[b]?.type] ?? 3;
        if (lvl > s.outlineDepth) continue;
        let j = i;
        while (j < idx.count && idx.blockOf[j] === b) j++;
        const title = idx.text.slice(i, j).join(' ');
        out.push({ start: i, level: lvl, title: title.length > 90 ? `${title.slice(0, 88)}…` : title, page: idx.pageOf[i] });
      }
      // Text before the first heading is a section of its own.
      if (out.length && out[0].start > 0) out.unshift({ start: 0, level: 1, title: 'Opening', page: idx.pageOf[0] });
    }
    if (!out.length && s.outlineSource !== 'headings') {
      let prev = -1;
      for (let i = 0; i < idx.count; i++) {
        const p = idx.pageOf[i];
        if (p === prev) continue;
        prev = p;
        const first = idx.text.slice(i, i + 8).join(' ');
        out.push({ start: i, level: 1, title: `Page ${p}: ${first}…`, page: p });
      }
    }
    for (let k = 0; k < out.length; k++) out[k].end = k + 1 < out.length ? out[k + 1].start : idx.count;
    return out;
  }

  function rebuild() {
    ensurePrefix();
    sections = buildSections();
    list.textContent = '';
    const s = getSettings();
    const idx = getIndex();
    for (const sec of sections) {
      const words = sec.end - sec.start;
      const meta = [];
      if (s.outlineShowLength) meta.push(h('span', { class: 'ol-len', text: fmtMs(msBetween(sec.end, sec.start)) }));
      if (s.outlineShowWords) meta.push(h('span', { class: 'ol-words', text: `${words.toLocaleString()} w` }));
      if (s.outlineShowPages) meta.push(h('span', { class: 'ol-page', text: `p. ${sec.page}` }));
      sec.untilEl = h('span', { class: 'ol-until' });
      sec.barEl = h('i');
      const li = h('li', { class: `ol-item lv${sec.level}`, tabindex: '0', role: 'button' },
        h('div', { class: 'ol-row' },
          h('span', { class: 'ol-name', text: sec.title }),
          h('span', { class: 'ol-meta' }, ...meta)),
        s.outlineShowUntil ? sec.untilEl : null,
        s.outlineShowBars ? h('div', { class: 'ol-bar' }, sec.barEl) : null);
      li.addEventListener('click', () => onJump(sec.start));
      li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump(sec.start); } });
      sec.li = li;
      list.append(li);
    }
    if (!sections.length) list.append(h('li', { class: 'ol-empty', text: idx?.count ? 'No headings found. Switch "Sections come from" to PDF pages below.' : 'Nothing to list yet.' }));
    buildSettings();
    lastCur = -2;
    update(true);
  }

  /* ------------------------------------------------------------ update --- */

  function update(force = false) {
    const idx = getIndex();
    if (!idx || !sections.length || root.hidden) return;
    ensurePrefix();
    const s = getSettings();
    const pos = Math.max(0, Math.min(idx.count, getPosition()));
    const total = prefix[idx.count];
    const left = total - prefix[pos];
    let cur = -1;
    for (let k = 0; k < sections.length; k++) if (sections[k].start <= pos) cur = k; else break;

    const next = sections[cur + 1];
    const parts = [`${Math.round((pos / Math.max(1, idx.count)) * 100)}% read`, `${fmtMs(left)} left at ${s.wpm} wpm`];
    if (next) parts.push(`next section in ${fmtMs(prefix[next.start] - prefix[pos])}`);
    summary.textContent = parts.join(' · ');

    for (let k = 0; k < sections.length; k++) {
      const sec = sections[k];
      const len = Math.max(1, sec.end - sec.start);
      const done = Math.max(0, Math.min(1, (pos - sec.start) / len));
      sec.barEl.style.transform = `scaleX(${done.toFixed(3)})`;
      sec.li.classList.toggle('is-done', pos >= sec.end);
      sec.li.classList.toggle('is-cur', k === cur);
      if (!s.outlineShowUntil) continue;
      if (k === cur) sec.untilEl.textContent = `reading now · ${fmtMs(prefix[sec.end] - prefix[pos])} left in section`;
      else if (pos >= sec.end) sec.untilEl.textContent = 'done';
      else sec.untilEl.textContent = `starts in ${fmtMs(prefix[sec.start] - prefix[pos])}`;
    }
    if ((force || cur !== lastCur) && cur >= 0 && s.outlineFollow) {
      sections[cur].li.scrollIntoView({ block: 'nearest', behavior: s.reduceMotion ? 'auto' : 'smooth' });
    }
    lastCur = cur;
  }

  /* --------------------------------------------- settings at the bottom --- */

  function buildSettings() {
    const s = getSettings();
    footBody.textContent = '';
    for (const key of PANEL_KEYS) {
      const def = BY_KEY[key];
      if (!def) continue;
      const id = `ol-set-${key}`;
      const row = h('div', { class: 'ol-set-row' });
      const label = h('label', { for: id, text: def.label + (def.unit ? ` (${def.unit})` : '') });
      let ctl;
      if (def.type === 'bool') {
        ctl = h('input', { id, type: 'checkbox' });
        ctl.checked = !!s[key];
        ctl.addEventListener('change', () => onSave({ [key]: ctl.checked }));
        row.append(ctl, label);
        row.classList.add('is-check');
      } else if (def.type === 'select') {
        ctl = h('select', { id });
        for (const o of def.options) {
          const opt = h('option', { value: o.value, text: o.label });
          if (o.value === s[key]) opt.selected = true;
          ctl.append(opt);
        }
        ctl.addEventListener('change', () => onSave({ [key]: ctl.value }));
        row.append(label, ctl);
      } else if (def.type === 'range') {
        const out = h('output', { text: String(s[key]) });
        ctl = h('input', { id, type: 'range', min: String(def.min), max: String(def.max), step: String(def.step) });
        ctl.value = String(s[key]);
        ctl.addEventListener('input', () => { out.textContent = ctl.value; onSave({ [key]: Number(ctl.value) }); });
        row.append(label, h('div', { class: 'ol-range' }, ctl, out));
      }
      footBody.append(row);
    }
  }

  return {
    rebuild,
    update: () => update(false),
    /** Settings changed: rebuild only when it changes what is listed. */
    onSettings(changed) {
      const structural = ['outlineOpen', 'outlineSource', 'outlineDepth', 'outlineShowLength', 'outlineShowUntil',
        'outlineShowBars', 'outlineShowWords', 'outlineShowPages'];
      const timing = ['wpm', 'pauseComma', 'pausePeriod', 'pauseParagraph', 'pauseHeading', 'pauseLongWord', 'longWordLen'];
      if (!changed || changed.some(k => structural.includes(k) || timing.includes(k))) {
        // Keep focus on a slider being dragged in the panel's own settings.
        const active = document.activeElement?.id;
        rebuild();
        if (active && active.startsWith('ol-set-')) document.getElementById(active)?.focus();
      } else update(false);
    },
  };
}
