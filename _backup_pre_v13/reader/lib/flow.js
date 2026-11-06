/**
 * Flow mode: read-along and auto-scroll in one.
 *
 * The pacer steps word by word; this module turns that into continuous
 * motion. The reading guide (a band) can stay fixed on screen while the text
 * rises through it, or ride along with the current line. The page scrolls so
 * the current line sits at `flowAnchor`, interpolated *within* each word's
 * time slot, so the motion is a glide instead of a jump per line.
 *
 * Performance: geometry is read once per word (a handful of rects); each
 * animation frame only writes scrollTop and transforms. Highlights are drawn
 * as positioned boxes, so no word's class or style changes and the browser
 * never restyles or re-lays-out text while playing.
 */

const PHRASE = 32;   // markup.FLAG.PHRASE
const PARA = 4;      // markup.FLAG.PARA

const ease = t => t * t * (3 - 2 * t);   // smoothstep, for the fades

export function createFlow({ index, doc, scroller, stage, overlay, getSettings, onUserScroll }) {
  let layer = null, sweep = null;
  const hlPool = [];
  let lineGuide = null;
  let fixed = null, band = null, fadeTop = null, fadeBot = null;

  let active = false, playing = false, raf = 0, lastT = 0;
  let cur = -1;
  // Cached geometry in #doc coordinates, refreshed per word.
  let L = null, nextTop = NaN, lineFirst = -1, lineLast = 0, docOff = 0;
  let prog0 = 0, prog1 = 0, progT0 = 0, progDur = 1;

  /* --------------------------------------------------------------- DOM --- */

  const div = (cls, parent) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };

  function ensureLayers() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.className = 'flow-layer';
      layer.setAttribute('aria-hidden', 'true');
      doc.appendChild(layer);
      lineGuide = div('flow-band', layer);
      sweep = div('flow-sweep', layer);
      hlPool.length = 0;
    }
    if (!fixed || !fixed.isConnected) {
      fixed = document.createElement('div');
      fixed.className = 'flow-fixed';
      fixed.setAttribute('aria-hidden', 'true');
      stage.appendChild(fixed);
      fadeTop = div('flow-fade', fixed);
      fadeBot = div('flow-fade', fixed);
      band = div('flow-band', fixed);
    }
  }

  const hlBox = k => {
    while (hlPool.length <= k) hlPool.push(div('flow-hl', layer));
    return hlPool[k];
  };

  /* ---------------------------------------------------------- geometry --- */

  function phraseRange(i) {
    const f = index.flags;
    let a = i;
    while (a > 0 && !(f[a - 1] & (PHRASE | PARA))) a--;
    let z = i;
    while (z < index.count - 1 && !(f[z] & (PHRASE | PARA))) z++;
    return [a, z];
  }

  /** Line rectangles covering words a..z (spaces included), in #doc coordinates. */
  function rangeRects(a, z, d) {
    const A = index.spans[a], Z = index.spans[z];
    if (!A || !Z) return [];
    const r = document.createRange();
    r.setStartBefore(A);
    r.setEndAfter(Z);
    const out = [];
    for (const q of r.getClientRects()) {
      if (q.width < 1 || q.height < 1) continue;
      const top = q.top - d.top, bottom = q.bottom - d.top;
      const row = out.find(o => Math.abs(o.top - top) < 0.5 * (bottom - top));
      if (row) { row.left = Math.min(row.left, q.left - d.left); row.right = Math.max(row.right, q.right - d.left); row.bottom = Math.max(row.bottom, bottom); row.top = Math.min(row.top, top); }
      else out.push({ top, bottom, left: q.left - d.left, right: q.right - d.left });
    }
    return out;
  }

  function textColumn(d) {
    const cs = getComputedStyle(doc);
    const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    return { left: pl, right: d.width - pr };
  }

  /* --------------------------------------------------------- per word --- */

  function setWord(i, dur) {
    if (!active || !index.count) return;
    ensureLayers();
    const s = getSettings();
    cur = i;
    const n = overlay.lineOfWord(i);
    if (n < 0) return;
    const [a, z] = overlay.wordRangeOfLine(n);

    // Reads first …
    const d = doc.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    docOff = d.top - sr.top + scroller.scrollTop;
    const lineRect = rangeRects(a, z, d)[0];
    const wr = index.spans[i]?.getBoundingClientRect();
    let nt = NaN;
    if (n + 1 < overlay.lineCount()) {
      const nr = overlay.lineRect(n + 1);
      if (nr) nt = nr.top;
    }
    const hlRange = s.flowHighlight === 'word' ? [i, i] : s.flowHighlight === 'phrase' ? phraseRange(i) : null;
    const hl = hlRange ? rangeRects(hlRange[0], hlRange[1], d) : [];
    const col = textColumn(d);
    if (!lineRect || !wr) return;

    // … then writes.
    const newLine = a !== lineFirst;
    L = lineRect;
    lineFirst = a; lineLast = z;
    nextTop = Number.isFinite(nt) && nt > L.top ? nt : NaN;
    const W = { left: wr.left - d.left, right: wr.right - d.left };
    const lh = L.bottom - L.top;

    for (let k = 0; k < Math.max(hl.length, hlPool.length); k++) {
      const box = hlBox(k);
      const r = hl[k];
      if (!r) { box.hidden = true; continue; }
      box.hidden = false;
      const pad = 0.12 * (r.bottom - r.top);
      box.style.transform = `translate(${r.left - pad}px, ${r.top - pad / 2}px)`;
      box.style.width = `${r.right - r.left + 2 * pad}px`;
      box.style.height = `${r.bottom - r.top + pad}px`;
    }

    // Line-following guide.
    const guideOnLine = s.flowGuide === 'line';
    lineGuide.hidden = !guideOnLine;
    if (guideOnLine) {
      const bh = lh * s.flowBandLines;
      const x0 = s.flowWidth === 'page' ? 0 : col.left - 6;
      const x1 = s.flowWidth === 'page' ? d.width : col.right + 6;
      lineGuide.className = `flow-band ${s.flowBandStyle}`;
      lineGuide.style.transform = `translate(${x0}px, ${L.top + lh / 2 - bh / 2}px)`;
      lineGuide.style.width = `${x1 - x0}px`;
      lineGuide.style.height = `${bh}px`;
      lineGuide.style.transition = s.reduceMotion ? 'none' : 'transform .12s linear';
    }

    // Pace sweep along the line.
    const mode = s.flowSweep;
    sweep.hidden = mode === 'off';
    if (mode !== 'off') {
      const th = s.flowSweepThickness;
      const span = Math.max(1, L.right - L.left);
      const ms = playing && !s.reduceMotion ? Math.max(30, dur) : 0;
      sweep.className = `flow-sweep ${mode}`;
      if (mode === 'caret') {
        const sz = th * 2 + 4;
        sweep.style.width = `${sz}px`;
        sweep.style.height = `${sz}px`;
        if (newLine) {
          sweep.style.transition = 'none';
          sweep.style.transform = `translate(${W.left - sz / 2}px, ${L.bottom + 1}px)`;
          void sweep.offsetWidth;
        }
        sweep.style.transition = ms ? `transform ${ms}ms linear` : 'none';
        sweep.style.transform = `translate(${W.right - sz / 2}px, ${L.bottom + 1}px)`;
      } else {
        const y = mode === 'fill' ? L.top : L.bottom - th + 2;
        const h = mode === 'fill' ? lh : th;
        sweep.style.width = `${span}px`;
        sweep.style.height = `${h}px`;
        sweep.style.transformOrigin = '0 0';
        if (newLine) {
          sweep.style.transition = 'none';
          sweep.style.transform = `translate(${L.left}px, ${y}px) scaleX(${Math.max(0, (W.left - L.left) / span)})`;
          void sweep.offsetWidth;          // commit the jump before animating
        }
        sweep.style.transition = ms ? `transform ${ms}ms linear` : 'none';
        sweep.style.transform = `translate(${L.left}px, ${y}px) scaleX(${Math.min(1, (W.right - L.left) / span)})`;
      }
    }

    // Progress through the line, for continuous scrolling.
    const count = Math.max(1, lineLast - lineFirst + 1);
    prog0 = (i - lineFirst) / count;
    prog1 = playing ? (i - lineFirst + 1) / count : prog0;
    progT0 = performance.now();
    progDur = Math.max(1, dur || 1);
    placeFixed(s, d, lh);
    kick();
  }

  /* ------------------------------------------------- still band + fades --- */

  let fixedSig = '';
  function placeFixed(s, d, lh) {
    const vh = scroller.clientHeight;
    const st = stage.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    const col = textColumn(d);
    const sig = [vh, Math.round(st.width), Math.round(d.left), Math.round(d.width), Math.round(lh), s.flowGuide, s.flowBandLines,
      s.flowBandStyle, s.flowWidth, s.flowAnchor, s.flowFadeAbove, s.flowFadeBelow, s.flowFadeClear, s.flowFadeSoftness, s.bg].join('|');
    if (sig === fixedSig) return;
    fixedSig = sig;

    const ay = vh * (s.flowAnchor / 100) + (sr.top - st.top);
    const bh = lh * s.flowBandLines;
    band.hidden = s.flowGuide !== 'band';
    if (!band.hidden) {
      const x0 = s.flowWidth === 'page' ? 0 : d.left - st.left + col.left - 6;
      const x1 = s.flowWidth === 'page' ? st.width : d.left - st.left + col.right + 6;
      band.className = `flow-band ${s.flowBandStyle}`;
      band.style.transform = `translate(${x0}px, ${ay - bh / 2}px)`;
      band.style.width = `${x1 - x0}px`;
      band.style.height = `${bh}px`;
    }

    // Fades: smoothstep-shaped gradients with many stops, so the falloff
    // reads as one soft gradient rather than a hard edge.
    const clear = Math.max(bh, lh) / 2 + s.flowFadeClear * lh;
    const soft = Math.max(20, vh * s.flowFadeSoftness / 100);
    const grad = (strength, dir) => {
      const stops = [];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        const a = Math.round(strength * ease(t) * 1000) / 10;
        stops.push(`color-mix(in srgb, ${s.bg} ${a}%, transparent) ${Math.round(t * soft)}px`);
      }
      return `linear-gradient(${dir}, ${stops.join(', ')})`;
    };
    const topH = Math.max(0, ay - clear);
    fadeTop.hidden = !(s.flowFadeAbove > 0) || topH < 2;
    if (!fadeTop.hidden) {
      fadeTop.style.top = '0px';
      fadeTop.style.height = `${topH}px`;
      fadeTop.style.background = grad(s.flowFadeAbove / 100, 'to top');
    }
    const botTop = ay + clear;
    fadeBot.hidden = !(s.flowFadeBelow > 0) || botTop > st.height - 2;
    if (!fadeBot.hidden) {
      fadeBot.style.top = `${botTop}px`;
      fadeBot.style.height = `${Math.max(0, st.height - botTop)}px`;
      fadeBot.style.background = grad(s.flowFadeBelow / 100, 'to bottom');
    }
  }

  /* ------------------------------------------------------------ motion --- */

  function targetScroll(s, now) {
    if (!L) return null;
    let y = L.top;
    if (s.flowScroll !== 'line' && Number.isFinite(nextTop)) {
      const t = Math.min(1, (now - progT0) / progDur);
      const p = prog0 + (prog1 - prog0) * t;
      y = L.top + p * (nextTop - L.top);
    }
    const lh = L.bottom - L.top;
    const max = scroller.scrollHeight - scroller.clientHeight;
    return Math.max(0, Math.min(max, docOff + y + lh / 2 - scroller.clientHeight * (s.flowAnchor / 100)));
  }

  function frame(now) {
    raf = 0;
    if (!active) return;
    const s = getSettings();
    const dt = lastT ? Math.min(100, now - lastT) : 16;
    lastT = now;
    const goal = targetScroll(s, now);
    let moving = false;
    if (goal != null) {
      const at = scroller.scrollTop;
      const tau = s.reduceMotion ? 0 : (s.flowGlide - 1) * 45;      // ms
      const alpha = dt <= 0 ? 0 : tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      const diff = goal - at;
      if (Math.abs(diff) > 0.3) {
        scroller.scrollTop = at + diff * alpha;
        moving = true;
      }
    }
    if (playing || moving) kick();
    else lastT = 0;
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  // Wheel or touch while playing hands control back to the reader.
  const onIntent = () => { if (active && playing && getSettings().flowPauseOnScroll) onUserScroll?.(); };
  scroller.addEventListener('wheel', onIntent, { passive: true });
  scroller.addEventListener('touchmove', onIntent, { passive: true });
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { fixedSig = ''; if (active && cur >= 0) setWord(cur, 0); })
    : null;
  ro?.observe(stage);

  return {
    start() {
      active = true;
      ensureLayers();
      layer.hidden = false;
      fixed.hidden = false;
      fixedSig = '';
      lineFirst = -1;
      if (cur >= 0) setWord(cur, 0);
      kick();
    },
    stop() {
      active = false;
      playing = false;
      if (layer) layer.hidden = true;
      if (fixed) fixed.hidden = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      lastT = 0;
      L = null;
    },
    setPlaying(p) {
      playing = !!p;
      if (!playing && sweep) {
        // Freeze the sweep where it is rather than letting it run on.
        const tf = getComputedStyle(sweep).transform;
        sweep.style.transition = 'none';
        if (tf && tf !== 'none') sweep.style.transform = tf;
        prog1 = prog0;
      }
      kick();
    },
    setWord,
    refresh() { fixedSig = ''; lineFirst = -1; if (active && cur >= 0) setWord(cur, 0); },
    destroy() {
      this.stop();
      ro?.disconnect();
      scroller.removeEventListener('wheel', onIntent);
      scroller.removeEventListener('touchmove', onIntent);
      layer?.remove();
      fixed?.remove();
    },
  };
}
