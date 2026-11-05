/**
 * Gradual dimming: a veil whose opacity rises smoothly with distance from the
 * clear zone, instead of one flat step. Pure functions so the shape can be
 * tested without a browser.
 *
 * The curve is smoothstep (3t^2 - 2t^3): it starts and ends with zero slope, so
 * there is no visible edge where the fade begins or where it reaches full
 * strength. Twelve stops are enough for the eye not to see banding.
 */

const STEPS = 12;
const ease = t => t * t * (3 - 2 * t);

/** [[alphaPercent, px], …] from the clear edge (0 px, 0 %) out to full strength at lenPx. */
export function dimStops(strength, lenPx, steps = STEPS) {
  const str = Math.min(1, Math.max(0, strength));
  const len = Math.max(8, lenPx);
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    out.push([Math.round(str * ease(t) * 1000) / 10, Math.round(t * len * 10) / 10]);
  }
  return out;
}

/**
 * CSS linear-gradient for a veil. `dir` is the direction the dimming grows:
 * 'to top' for the veil above the clear zone (its bottom edge touches the zone),
 * 'to bottom' for the veil below it.
 */
export function dimGradient(strength, lenPx, dir) {
  const stops = dimStops(strength, lenPx).map(([a, px]) => `color-mix(in srgb, var(--r-bg) ${a}%, transparent) ${px}px`);
  const last = Math.round(Math.min(1, Math.max(0, strength)) * 1000) / 10;
  stops.push(`color-mix(in srgb, var(--r-bg) ${last}%, transparent) 100%`);
  return `linear-gradient(${dir}, ${stops.join(', ')})`;
}
