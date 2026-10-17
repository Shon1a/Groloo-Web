/* ---- THE TV'S CARD GEOMETRY ON WHOLE PIXELS -------------------------------------------------------
 *
 * THE DEFECT: a beat after every up/down press, some of the posters beside the billboard slipped one
 * pixel to the left — one frame, then they stayed there. Hard to name, easy to feel: it is the moment
 * the row looks like it moved without anyone pressing anything.
 *
 * THE CAUSE: every number the row is laid out from is a fraction of the screen (tv.css, `.tv-shell`):
 * the side gutter is 3.4vw (65.28px on a 1920 panel), the card height min(26.5vw, 52vh) (508.8px),
 * and the poster, gap and billboard widths are fractions of that. So the strip's offset and every
 * poster's `left` land between pixels. Painted into the page, a fraction rounds one way; once the row
 * is `is-primed` the strip becomes its own compositor layer (`will-change: transform`, so the first
 * left/right press does not build one mid-slide) and the same fraction is placed another way. The
 * difference is the pixel. Measured: with the promotion switched off the posters did not move at all;
 * with it on they jumped 1px on most presses.
 *
 * THE FIX keeps the promotion and takes the fractions away: each of these is measured as the stylesheet
 * computes it and pinned, rounded, on `.tv-shell` itself — under half a pixel off what the formula
 * says, which nothing can see. The formulas in tv.css stay the one place the geometry is written; this
 * only rounds their answer, again whenever the window changes size. */
const VARS = ['--page-pad', '--spot-h', '--sp-wl', '--sp-wp', '--sp-gap', '--sp-end-step', '--sp-end-drop'];

export function snapTvGeometry(shell: HTMLElement): void {
  for (const v of VARS) shell.style.removeProperty(v);
  // One probe per value, all read after a single layout.
  const probes = VARS.map((v) => {
    const p = document.createElement('div');
    p.style.cssText = `position:absolute;left:0;top:0;height:0;visibility:hidden;pointer-events:none;width:var(${v})`;
    shell.appendChild(p);
    return p;
  });
  const widths = probes.map((p) => p.getBoundingClientRect().width);
  for (const p of probes) p.remove();
  VARS.forEach((v, i) => { if (widths[i] > 0) shell.style.setProperty(v, `${Math.round(widths[i])}px`); });
}

/** Snap now and on every resize. Returns the cleanup. */
export function keepTvGeometrySnapped(shell: HTMLElement): () => void {
  snapTvGeometry(shell);
  const onResize = () => snapTvGeometry(shell);
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}
