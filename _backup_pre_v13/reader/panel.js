/**
 * Reading-settings drawer.
 *
 * Every control here is generated from schema.js: SECTIONS gives the groups,
 * SETTINGS the rows, PRESETS the colour swatches. Nothing in this file knows a
 * setting's label, range or default, so a new entry in the schema shows up
 * without touching the panel.
 *
 * Draft model: edits land in `draft`; `committed` mirrors getSettings(). The
 * footer counts keys where the two differ. Apply sends only those keys to the
 * integrator, Discard copies committed back over the draft. When
 * settings.livePreview is on, edits are applied as they happen (coalesced over
 * ~100 ms so a slider drag doesn't hammer chrome.storage.sync) and the two
 * objects never diverge. `touched` remembers which keys the user edited so a
 * refresh() from another tab can update everything else without silently
 * clobbering their in-progress edits.
 */

import {
  SECTIONS, SETTINGS, PRESETS, SECTION_KEYS, BY_KEY, RERENDER_KEYS, BASIC,
  coerce, activePreset,
} from './lib/schema.js';
import { applyCssVars } from './lib/settings.js';
import { renderInto } from './lib/markup.js';

const LS_COLLAPSED = 'lucid.panel.collapsed';
const LIVE_FLUSH_MS = 30;
const CLOSE_MS = 260;

/* Which keys a preset patches — derived from the preset shape, not assumed. */
const PRESET_KEYS = Object.keys(PRESETS[0] ?? {}).filter(k => BY_KEY[k]);

/* The sample is rendered through markup.js so it can never disagree with the
   document: same word spans, same bionic split, same first-letter rules. */
const SAMPLE = [{
  type: 'p', page: 0,
  text: 'Reading should feel effortless. Adjust the type, colours and reading ' +
        'aids here, and this sample updates immediately — the document itself ' +
        'only changes when you apply.',
}];
const SAMPLE_CUR = /^sample/i;   // the word shown as the pacer's current word

/* Section icons, keyed by the schema's `icon` names. Unknown names get a dot. */
const ICONS = {
  type:        'M5 7V4h14v3M9 20h6M12 4v16',
  palette:     'M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.9 0-1.1-.9-1.4-.9-2.2 0-.7.6-1.2 1.3-1.2H16a5 5 0 0 0 5-5C21 6.3 17 3 12 3zM7.5 11h.01M10 7h.01M14.5 7h.01M17 10.5h.01',
  bolt:        'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  highlighter: 'M9 11l-6 6v3h3l6-6M14 4l6 6-8 8-6-6z',
  focus:       'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6',
  sparkles:    'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  layout:      'M4 5h16v14H4zM4 10h16M10 10v9',
  columns:     'M4 5h16v14H4zM12 5v14',
  pause:       'M8 5v14M16 5v14',
  sliders:     'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M8 14v6',
  default:     'M12 12h.01',
};
const ICON_CHEVRON = 'M6 9l6 6 6-6';
const ICON_CLOSE = 'M6 6l12 12M18 6 6 18';
const ICON_CHECK = 'M5 12l5 5L20 7';

const svg = (d, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

/** Tiny element builder; keeps the generated DOM readable without templates. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

/* Number formatting follows the step so "1.65" and "19" both look natural. */
function decimals(def) {
  const s = String(def.step ?? 1);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
const fmt = (def, v) => Number(v).toFixed(decimals(def));

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...set])); }
  catch { /* private mode / quota — collapse state is a nicety */ }
}

export function createPanel(opts) {
  const { root, scrim } = opts;
  const app = document.getElementById('app');
  const snap = () => ({ ...(opts.getSettings?.() ?? {}) });
  const isLive = () => !!opts.getSettings?.()?.applyInstantly;
  const uid = k => `pn-${k}`;

  let committed = snap();
  let draft = { ...committed };
  const touched = new Set();
  const ctl = new Map();          // key -> { def, row, set(v) }
  const presetBtns = [];          // [id, button]
  const collapsed = loadCollapsed();

  let isOpen = false;
  let prevFocus = null;
  let closeTimer = 0;
  let liveQueue = null;
  let liveTimer = 0;

  /* ------------------------------------------------------------ draft --- */

  function pendingKeys() {
    return SETTINGS.map(s => s.key).filter(k => draft[k] !== committed[k]);
  }

  function edit(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!BY_KEY[k]) continue;
      const c = coerce(k, v);
      if (c !== draft[k]) clean[k] = c;
    }
    const keys = Object.keys(clean);
    if (!keys.length) {
      // An out-of-range entry that coerced back to the current value still
      // needs the control redrawn so the box shows the clamped number.
      syncControls(Object.keys(patch).filter(k => BY_KEY[k]));
      return;
    }
    Object.assign(draft, clean);
    for (const k of keys) touched.add(k);
    if (isLive()) {
      // Optimistic: the footer must never flash "1 pending change" in live mode.
      Object.assign(committed, clean);
      for (const k of keys) touched.delete(k);
      queueLive(clean);
    }
    afterDraftChange(keys);
  }

  function afterDraftChange(keys) {
    syncControls(keys);
    applyVisibility();
    updatePresets();
    updatePreview(keys);
    updateFooter();
    try { opts.onPreview?.({ ...draft }); }
    catch (e) { console.warn('[lucid] panel: onPreview failed', e); }
  }

  function queueLive(patch) {
    liveQueue = { ...(liveQueue ?? {}), ...patch };
    clearTimeout(liveTimer);
    liveTimer = setTimeout(flushLive, LIVE_FLUSH_MS);
  }
  function flushLive() {
    clearTimeout(liveTimer);
    liveTimer = 0;
    const p = liveQueue;
    liveQueue = null;
    if (!p) return;
    Promise.resolve().then(() => opts.onApply?.(p))
      .catch(e => console.warn('[lucid] panel: live apply failed', e));
  }

  async function apply() {
    const patch = {};
    for (const k of pendingKeys()) patch[k] = draft[k];
    if (!Object.keys(patch).length) return;
    btnApply.disabled = true;
    btnDiscard.disabled = true;
    try {
      await opts.onApply?.(patch);
      committed = snap();
      // Draft values are kept: if the integrator committed them the diff is
      // empty; if it didn't, the footer keeps telling the truth.
      for (const k of Object.keys(patch)) touched.delete(k);
    } catch (e) {
      console.warn('[lucid] panel: apply failed', e);
    }
    renderAll();
  }

  function discard() {
    draft = { ...committed };
    touched.clear();
    renderAll();
  }

  async function resetAll() {
    flushLive();
    try { await opts.onReset?.(); }
    catch (e) { console.warn('[lucid] panel: reset failed', e); }
    committed = snap();
    draft = { ...committed };
    touched.clear();
    renderAll();
  }

  async function resetSection(id) {
    const keys = SECTION_KEYS[id] ?? [];
    flushLive();
    try { await opts.onReset?.(keys); }
    catch (e) { console.warn('[lucid] panel: section reset failed', e); }
    committed = snap();
    for (const k of keys) { draft[k] = committed[k]; touched.delete(k); }
    renderAll();
  }

  function refresh() {
    // Edits still waiting in the live queue haven't reached the store yet;
    // treat them as committed so they don't flicker back to the old value.
    committed = { ...snap(), ...(liveQueue ?? {}) };
    for (const k of Object.keys(committed)) {
      if (!touched.has(k)) draft[k] = committed[k];
      else if (draft[k] === committed[k]) touched.delete(k);
    }
    renderAll();
  }

  /* ------------------------------------------------------------- build --- */

  root.replaceChildren();
  root.setAttribute('role', 'dialog');
  // Non-modal: the drawer stays open while the reader keeps working.
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-labelledby', 'pn-title');
  root.tabIndex = -1;

  const btnReset = h('button', {
    type: 'button', class: 'pn-textbtn', text: 'Reset',
    title: 'Reset every setting to its default',
  });
  const btnClose = h('button', {
    type: 'button', class: 'pn-iconbtn pn-close', 'aria-label': 'Close settings',
    html: svg(ICON_CLOSE),
  });
  const head = h('header', { class: 'pn-head' },
    h('div', { class: 'pn-head-text' },
      h('h2', { class: 'pn-title', id: 'pn-title', text: 'Reading settings' }),
      h('p', { class: 'pn-sub', text: 'Changes show on the page as you make them.' })),
    h('div', { class: 'pn-head-actions' }, btnReset, btnClose));

  const previewDoc = h('div', { class: 'pn-preview-doc' });
  const preview = h('section', { class: 'pn-preview', 'aria-hidden': 'true' },
    h('div', { class: 'pn-eyebrow', text: 'Preview' }), previewDoc);

  const body = h('div', { class: 'pn-body' }, preview, ...SECTIONS.map(buildSection));

  // Normal shows the settings most people change; Advanced shows all of them.
  const LEVEL_KEY = 'lucid-panel-level';
  const lvlBtns = ['normal', 'advanced'].map(v => h('button', {
    type: 'button', class: 'pn-lvl-btn', 'data-level': v, text: v === 'normal' ? 'Normal settings' : 'All settings',
  }));
  const setLevel = v => {
    body.classList.toggle('lvl-adv', v === 'advanced');
    for (const b of lvlBtns) b.setAttribute('aria-pressed', String(b.dataset.level === v));
    try { localStorage.setItem(LEVEL_KEY, v); } catch { /* private window */ }
  };
  for (const b of lvlBtns) b.addEventListener('click', () => setLevel(b.dataset.level));
  body.prepend(h('div', { class: 'pn-level', role: 'group', 'aria-label': 'How many settings to show' }, ...lvlBtns));
  let savedLevel = 'normal';
  try { savedLevel = localStorage.getItem(LEVEL_KEY) === 'advanced' ? 'advanced' : 'normal'; } catch { /* ignore */ }
  setLevel(savedLevel);

  const pendingEl = h('span', { class: 'pn-pending', 'aria-live': 'polite' });
  const btnDiscard = h('button', { type: 'button', class: 'pn-btn', text: 'Discard' });
  const btnApply = h('button', {
    type: 'button', class: 'pn-btn pn-btn-primary',
    html: `${svg(ICON_CHECK)}<span>Apply changes</span>`,
  });
  const foot = h('footer', { class: 'pn-foot' },
    pendingEl, h('div', { class: 'pn-foot-actions' }, btnDiscard, btnApply));

  root.append(head, body, foot);

  function buildSection(sec) {
    const bodyId = `pn-sec-${sec.id}`;
    const btnId = `pn-sec-btn-${sec.id}`;
    const toggle = h('button', {
      type: 'button', class: 'pn-sec-toggle', id: btnId,
      'aria-expanded': 'true', 'aria-controls': bodyId,
      html: svg(ICONS[sec.icon] ?? ICONS.default, 'pn-sec-icon'),
    });
    toggle.append(h('span', { class: 'pn-sec-title', text: sec.label }));
    toggle.insertAdjacentHTML('beforeend', svg(ICON_CHEVRON, 'pn-chevron'));

    const reset = h('button', {
      type: 'button', class: 'pn-sec-reset', text: 'Reset section',
      'aria-label': `Reset ${sec.label} to defaults`,
    });

    const defs = SETTINGS.filter(d => d.section === sec.id);
    const nBasic = defs.filter(d => BASIC.has(d.key)).length;
    const nAdv = defs.length - nBasic;
    const advBtn = nBasic && nAdv
      ? h('button', { type: 'button', class: 'pn-sec-adv', 'aria-pressed': 'false', text: `Advanced (${nAdv})` })
      : null;

    const inner = h('div', { class: 'pn-sec-in' });
    if (PRESET_KEYS.length && BY_KEY[PRESET_KEYS[0]].section === sec.id) {
      inner.append(buildPresets());
    }
    inner.append(h('div', { class: 'pn-rows' },
      ...SETTINGS.filter(d => d.section === sec.id).map(buildRow)));

    const secBody = h('div', {
      class: 'pn-sec-body', id: bodyId, role: 'region', 'aria-labelledby': btnId,
    }, inner);
    const el = h('section', { class: `pn-sec${nBasic ? ' has-basic' : ''}`, 'data-sec': sec.id },
      h('div', { class: 'pn-sec-head' }, toggle, advBtn, reset), secBody);
    advBtn?.addEventListener('click', () => {
      const on = el.classList.toggle('show-adv');
      advBtn.setAttribute('aria-pressed', String(on));
      advBtn.textContent = on ? 'Normal' : `Advanced (${nAdv})`;
    });

    const setCollapsed = (yes, persist = true) => {
      el.classList.toggle('is-collapsed', yes);
      toggle.setAttribute('aria-expanded', String(!yes));
      secBody.inert = yes;
      if (yes) collapsed.add(sec.id); else collapsed.delete(sec.id);
      if (persist) saveCollapsed(collapsed);
    };
    setCollapsed(collapsed.has(sec.id), false);

    toggle.addEventListener('click', () => setCollapsed(!collapsed.has(sec.id)));
    reset.addEventListener('click', () => resetSection(sec.id));
    return el;
  }

  function buildPresets() {
    const grid = h('div', { class: 'pn-presets', role: 'group', 'aria-label': 'Colour presets' });
    for (const p of PRESETS) {
      const b = h('button', {
        type: 'button', class: 'pn-preset', 'aria-pressed': 'false',
        title: p.label, 'aria-label': `${p.label} preset`,
      });
      for (const k of PRESET_KEYS) b.style.setProperty(`--pv-${k}`, p[k]);
      b.append(
        h('span', { class: 'pn-preset-swatch', 'aria-hidden': 'true', text: 'Aa' }),
        h('span', { class: 'pn-preset-name', text: p.label }));
      b.addEventListener('click', () => {
        const patch = {};
        for (const k of PRESET_KEYS) patch[k] = p[k];
        edit(patch);
      });
      presetBtns.push([p.id, b]);
      grid.append(b);
    }
    return grid;
  }

  function buildRow(def) {
    const id = uid(def.key);
    const hintId = null;
    const label = h('label', {
      class: `pn-label${def.strong ? ' is-strong' : ''}`, for: id, text: def.label,
    });
    if (def.unit) label.append(' ', h('span', { class: 'pn-unit', text: `(${def.unit})` }));
    // Explanations live in a hover tooltip, so no caption text sits under the control.
    const hint = null;

    let ctlEl;
    let set;
    let boolCtl = null;

    switch (def.type) {
      case 'range':
      case 'number': {
        const slider = def.type === 'range' ? h('input', {
          type: 'range', id, min: def.min, max: def.max, step: def.step,
          'aria-describedby': hintId,
        }) : null;
        const num = h('input', {
          type: 'number', class: 'pn-num', min: def.min, max: def.max, step: def.step,
          inputmode: 'decimal', autocomplete: 'off', name: `${def.key}-value`,
          id: slider ? null : id,
          'aria-label': slider ? `${def.label} value${def.unit ? ` (${def.unit})` : ''}` : null,
          'aria-describedby': slider ? null : hintId,
        });
        slider?.addEventListener('input', () => edit({ [def.key]: slider.value }));
        const commitNum = () => {
          const n = parseFloat(num.value);
          if (Number.isFinite(n)) edit({ [def.key]: n });
          num.value = fmt(def, draft[def.key]);
        };
        num.addEventListener('change', commitNum);
        num.addEventListener('blur', commitNum);
        num.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); commitNum(); }
        });
        set = v => {
          if (slider) {
            slider.value = String(v);
            const span = def.max - def.min || 1;
            slider.style.setProperty('--pn-fill', `${((v - def.min) / span) * 100}%`);
            if (def.unit) slider.setAttribute('aria-valuetext', `${fmt(def, v)} ${def.unit}`);
          }
          if (document.activeElement !== num) num.value = fmt(def, v);
        };
        ctlEl = h('div', { class: 'pn-ctl pn-ctl-range' }, slider, num);
        break;
      }

      case 'bool': {
        const cb = h('input', {
          type: 'checkbox', role: 'switch', class: 'pn-switch', id,
          'aria-describedby': hintId,
        });
        cb.addEventListener('change', () => edit({ [def.key]: cb.checked }));
        set = v => { cb.checked = !!v; };
        boolCtl = h('div', { class: 'pn-ctl-bool' }, label, cb);
        break;
      }

      case 'select': {
        const sel = h('select', { id, class: 'pn-select', 'aria-describedby': hintId });
        const groups = new Map();
        for (const o of def.options ?? []) {
          const opt = h('option', { value: o.value, text: o.label });
          if (o.group) {
            let g = groups.get(o.group);
            if (!g) { g = h('optgroup', { label: o.group }); groups.set(o.group, g); sel.append(g); }
            g.append(opt);
          } else {
            sel.append(opt);
          }
        }
        sel.addEventListener('change', () => edit({ [def.key]: sel.value }));
        set = v => { sel.value = String(v); };
        ctlEl = h('div', { class: 'pn-ctl pn-ctl-select' }, sel);
        break;
      }

      case 'color': {
        const swatch = h('input', {
          type: 'color', class: 'pn-swatch', name: `${def.key}-picker`,
          'aria-label': `${def.label} picker`,
        });
        const hex = h('input', {
          type: 'text', id, class: 'pn-hex', maxlength: 7, spellcheck: 'false',
          autocomplete: 'off', placeholder: def.nullable ? 'inherit' : '#rrggbb',
          'aria-describedby': hintId,
        });
        const inherit = def.nullable ? h('button', {
          type: 'button', class: 'pn-inherit', text: 'Inherit',
          title: 'Use the text colour', 'aria-pressed': 'false',
        }) : null;
        const normHex = raw => {
          const v = raw.trim();
          return v && !v.startsWith('#') ? `#${v}` : v;
        };
        swatch.addEventListener('input', () => edit({ [def.key]: swatch.value }));
        // A complete hex applies as it's typed; anything else waits for blur.
        hex.addEventListener('input', () => {
          const v = normHex(hex.value);
          if (/^#[0-9a-f]{6}$/i.test(v)) edit({ [def.key]: v });
        });
        const commitHex = () => {
          const v = normHex(hex.value);
          if (v === '' && def.nullable) edit({ [def.key]: '' });
          else if (/^#[0-9a-f]{6}$/i.test(v)) edit({ [def.key]: v });
          hex.value = draft[def.key] ?? '';
        };
        hex.addEventListener('change', commitHex);
        hex.addEventListener('blur', commitHex);
        hex.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); commitHex(); }
        });
        inherit?.addEventListener('click', () => edit({ [def.key]: '' }));
        ctlEl = h('div', { class: 'pn-ctl pn-ctl-color' }, swatch, hex, inherit);
        set = v => {
          const empty = v === '' || v == null;
          ctlEl.classList.toggle('is-inherit', empty);
          if (!empty) swatch.value = v;
          if (document.activeElement !== hex) hex.value = empty ? '' : v;
          inherit?.setAttribute('aria-pressed', String(empty));
        };
        break;
      }

      default: {
        const inp = h('input', {
          type: 'text', id, class: 'pn-text', autocomplete: 'off',
          'aria-describedby': hintId,
        });
        inp.addEventListener('change', () => edit({ [def.key]: inp.value }));
        set = v => { if (document.activeElement !== inp) inp.value = v ?? ''; };
        ctlEl = h('div', { class: 'pn-ctl' }, inp);
      }
    }

    const row = h('div', { class: `pn-row pn-row-${def.type}${BASIC.has(def.key) ? '' : ' pn-adv'}`, 'data-key': def.key, title: def.hint || null },
      h('div', { class: 'pn-row-in' }, ...(boolCtl ? [boolCtl, hint] : [label, ctlEl, hint])));
    ctl.set(def.key, { def, row, set });
    return row;
  }

  /* ------------------------------------------------------------ render --- */

  function syncControls(keys) {
    for (const k of keys ?? ctl.keys()) ctl.get(k)?.set(draft[k]);
  }

  function applyVisibility() {
    for (const { def, row } of ctl.values()) {
      if (!def.showIf) continue;
      let show = true;
      try { show = !!def.showIf(draft); } catch { show = true; }
      if (row.classList.contains('is-hidden') === !show) continue;
      row.classList.toggle('is-hidden', !show);
      row.inert = !show;
    }
  }

  function updatePresets() {
    const active = activePreset(draft);
    for (const [id, b] of presetBtns) b.setAttribute('aria-pressed', String(id === active));
  }

  function renderSample() {
    previewDoc.replaceChildren();
    const idx = renderInto(previewDoc, SAMPLE, draft);
    const i = idx.text.findIndex(w => SAMPLE_CUR.test(w));
    idx.spans[i >= 0 ? i : Math.min(4, idx.spans.length - 1)]?.classList.add('cur');
  }

  /* Static examples of the overlay aids, drawn as background layers so the
     sample text itself is never touched. Line height comes from the same
     custom properties the document uses. */
  function previewLayers() {
    const LH = 'calc(var(--r-fs) * var(--r-zoom) * var(--r-lh))';
    const layers = [];
    if (draft.barOn) {
      const c = 'color-mix(in srgb, var(--r-bar) calc(var(--r-bar-op) * 100%), transparent)';
      const top = `calc(${LH} * 1.5 - var(--r-bar-h) / 2)`;
      const bottom = `calc(${top} + var(--r-bar-h))`;
      layers.push(`linear-gradient(to bottom, transparent ${top}, ${c} ${top}, ${c} ${bottom}, transparent ${bottom})`);
    }
    if (draft.stripesOn) {
      const n = Math.max(1, Math.round(Number(draft.stripeEvery) || 1));
      const c1 = 'color-mix(in srgb, var(--r-stripe) calc(var(--r-stripe-op) * 100%), transparent)';
      const stops = [
        'transparent 0', `transparent calc(${LH} * ${n - 1})`,
        `${c1} calc(${LH} * ${n - 1})`, `${c1} calc(${LH} * ${n})`,
      ];
      if (draft.stripeAlternate) {
        const c2 = 'color-mix(in srgb, var(--r-stripe2) calc(var(--r-stripe-op) * 100%), transparent)';
        stops.push(
          `transparent calc(${LH} * ${n})`, `transparent calc(${LH} * ${2 * n - 1})`,
          `${c2} calc(${LH} * ${2 * n - 1})`, `${c2} calc(${LH} * ${2 * n})`);
      }
      layers.push(`repeating-linear-gradient(to bottom, ${stops.join(', ')})`);
    }
    return layers.length ? layers.join(', ') : 'none';
  }

  function updatePreview(keys) {
    applyCssVars(previewDoc, draft);
    if (!keys || keys.some(k => RERENDER_KEYS.has(k))) renderSample();
    previewDoc.classList.toggle('pacer-nobg', draft.pacerBackground === false);
    previewDoc.classList.toggle('pacer-tint', !!draft.pacerTintText);
    previewDoc.classList.toggle('pacer-underline', !!draft.pacerUnderline);
    previewDoc.style.setProperty('--pv-layers', previewLayers());
  }

  function updateFooter() {
    const n = pendingKeys().length;
    pendingEl.textContent = n === 0
      ? 'No pending changes'
      : `${n} pending change${n === 1 ? '' : 's'}`;
    root.classList.toggle('has-pending', n > 0);
    root.classList.toggle('is-live', isLive());
    btnDiscard.disabled = n === 0;
    btnApply.disabled = n === 0;
  }

  function renderAll() {
    syncControls();
    applyVisibility();
    updatePresets();
    updatePreview();
    updateFooter();
  }

  /* ---------------------------------------------------- open / close --- */

  function focusables() {
    const sel = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
    return [...root.querySelectorAll(sel)].filter(el =>
      !el.disabled && !el.closest('[inert]') &&
      (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.offsetParent !== null));
  }

  function trapTab(e) {
    const f = focusables();
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0];
    const last = f[f.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || cur === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') trapTab(e);
    // Keys typed into the panel must not reach the reader's global shortcuts.
    e.stopPropagation();
  }
  const swallow = e => e.stopPropagation();

  function onFocusIn(e) {
    // No focus trap: the page stays usable with the drawer open.
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    clearTimeout(closeTimer);
    prevFocus = document.activeElement;
    refresh();
    root.classList.toggle('no-motion', !!committed.reduceMotion);
    root.hidden = false;
    scrim.hidden = false;
    void root.offsetWidth;            // let the transition start from off-screen
    root.classList.add('is-open');
    scrim.classList.add('is-open');
    app?.classList.add('panel-open');
    root.focus({ preventScroll: true });
    document.addEventListener('focusin', onFocusIn);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    flushLive();
    document.removeEventListener('focusin', onFocusIn);
    root.classList.remove('is-open');
    scrim.classList.remove('is-open');
    app?.classList.remove('panel-open');
    const done = () => { if (!isOpen) { root.hidden = true; scrim.hidden = true; } };
    if (root.classList.contains('no-motion')) done();
    else closeTimer = setTimeout(done, CLOSE_MS);
    if (prevFocus?.isConnected && typeof prevFocus.focus === 'function') {
      prevFocus.focus({ preventScroll: true });
    }
    prevFocus = null;
  }

  function toggle() { isOpen ? close() : open(); }

  function destroy() {
    close();
    clearTimeout(closeTimer);
    clearTimeout(liveTimer);
    root.removeEventListener('keydown', onKeyDown);
    root.removeEventListener('keyup', swallow);
    root.removeEventListener('keypress', swallow);
    scrim.removeEventListener('click', close);
    document.removeEventListener('focusin', onFocusIn);
    root.replaceChildren();
    root.hidden = true;
    scrim.hidden = true;
    ctl.clear();
    presetBtns.length = 0;
  }

  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('keyup', swallow);
  root.addEventListener('keypress', swallow);
  scrim.addEventListener('click', close);
  btnClose.addEventListener('click', close);
  btnReset.addEventListener('click', resetAll);
  btnDiscard.addEventListener('click', discard);
  btnApply.addEventListener('click', apply);

  renderAll();

  return { open, close, toggle, isOpen: () => isOpen, refresh, destroy };
}
