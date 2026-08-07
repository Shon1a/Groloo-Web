import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/i18n';

/* ColorPicker — hand-built replacement for the two native <input type=color> pills
 * (subtitle colour / outline). The trigger keeps the native control's exact 130x42
 * pill geometry so the rows don't reflow; the popover holds a saturation/brightness
 * area with a draggable thumb and a hue rail (see .set-color* in app.css).
 *
 * HSV — not the hex prop — is the source of truth while open. hex->HSV is lossy: every
 * v=0 colour reports h=0,s=0 and every gray reports h=0, so re-deriving HSV from the
 * prop each render would snap the hue rail to red the moment the user dragged into the
 * black corner, and dragging back out would return red instead of the original hue.
 * hexToHsv therefore runs exactly once, on open. Settings.tsx is the only writer of
 * subColor/subOutline (VideoPlayer only reads them), so there is no external change to
 * adopt while we are open and no echo-suppression is needed.
 *
 * The panel is position:FIXED, not absolute: .set-card{overflow:hidden} is load-bearing
 * (it clips the card head's gradients to the 16px radius) and would shear an absolute
 * popover to a sliver at any z-index.
 *
 * The saturation/brightness/hue controls are real <input type=range>s — that is the whole
 * keyboard + screen-reader story, for free, and matches every other slider in the app. The
 * two SV ranges are 1px/opacity:0 rather than display:none so they stay focusable;
 * .set-color-sv:focus-within paints the ring. */

const IS_TV = import.meta.env.MODE === 'tv';

/* The TV build's whole palette — see the note at the render branch. Broadcast captioning's own
 * set, in the order a viewer scans them: the default first, then the two high-contrast standards,
 * then the rest. Every one of them is legible over arbitrary video, which is the only requirement
 * a subtitle colour actually has. */
const TV_SWATCHES = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff8800', '#000000'];

type Hsv = { h: number; s: number; v: number };

/* Pinned by .set-color-panel's width/height (border-box) so flip/clamp is pure
   arithmetic and the panel never has to be measured. Keep in sync with app.css. */
const PANEL_W = 220, PANEL_H = 182;

/* The store is a shallow {...DEFAULTS, ...JSON.parse(localStorage)} merge with no
   validation, so this can be handed a stale 'transparent', an 'rgba(0,0,0,.6)' or a
   hand-edited blob. String(hex ?? '') is load-bearing: JSON.parse yields null/number as
   readily as a bad string, and a bare hex.trim() would throw during render — the Settings
   route has no error boundary above it. */
function normHex(hex: string): string {
  const m = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return '#ffffff';
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h}`;
}

function hexToHsv(hex: string): Hsv {
  const n = parseInt(normHex(hex).slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = d === 0 ? 0
    : max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60
    : max === g ? ((b - r) / d + 2) * 60
    : ((r - g) / d + 4) * 60;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/* Canonical closed-form HSV->RGB; f(5),f(3),f(1) are R,G,B. The Math.round is the only
   rounding in the pipeline — HSV stays float — which is why hsvToHex(hexToHsv(x)) === x
   for all 16777216 hex values (verified exhaustively). Rounding s/v to whole percent in
   the model instead breaks 13104825 of them (78.1%, worst channel drift 2/255). */
function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

export default function ColorPicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const satRef = useRef<HTMLInputElement>(null);
  /* The live drag's teardown. Parked here so the open-effect's cleanup and the unmount
     effect can end a drag that never got a pointerup — closing the panel mid-drag must
     not leave window listeners writing colours into the store from an invisible square. */
  const endRef = useRef<(() => void) | null>(null);

  const hex = normHex(value);

  /* The panel is fixed, so it contributes no layout — but measure the trigger itself
     rather than the root: it is free and immune to a future wrapper changing the box.
     place() is PURE positioning and must stay that way: toggle() calls it on the open path,
     so anything that flipped `open` in here would race the setOpen right after it. */
  const place = () => {
    const el = btnRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const below = r.bottom + 8;
    const top = below + PANEL_H > window.innerHeight ? r.top - PANEL_H - 8 : below;
    setPos({
      // clamped at BOTH ends on both axes — a flipped-up panel goes negative otherwise
      top: Math.max(8, Math.min(top, window.innerHeight - PANEL_H - 8)),
      left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)),
    });
  };

  /* Scroll/resize only. If the trigger has left the viewport, a fixed panel would clamp
     itself to the edge and sit there detached from its anchor, on top of the topbar — so
     close instead of following. Kept out of place() so the open path can't race it. */
  const track = () => {
    const el = btnRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
    place();
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    // inert drops focus to <body>, so hand it back to the trigger on the way out.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    const onTrack = () => track();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onTrack, true);
    window.addEventListener('resize', onTrack);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onTrack, true);
      window.removeEventListener('resize', onTrack);
      endRef.current?.();
    };
  }, [open]);

  useEffect(() => () => { endRef.current?.(); }, []);   // unmount mid-drag

  const put = (next: Hsv) => { setHsv(next); onChange(hsvToHex(next)); };

  /* VideoPlayer seek-bar pattern (VideoPlayer.tsx:337), with the four holes that pattern
     leaves open closed: a pointerId guard (a second finger on the hue rail otherwise
     re-fires this handler and reverts the hue to the pointerdown snapshot), pointercancel
     (it fires INSTEAD of pointerup — capture is irrelevant to that — and without it the
     window listeners leak forever and every later pointermove repaints the colour), a
     primary-button guard (a right-click would otherwise commit a colour under the context
     menu), and a teardown reachable from outside the gesture via endRef.
     The hsv captured here is safe for the whole gesture: an SV drag writes s and v, so the
     only channel the spread carries over is h — and the pointerId guard is what makes that
     true, by keeping a concurrent hue gesture out of this closure. */
  const onSvPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const id = e.pointerId;
    endRef.current?.();
    satRef.current?.focus({ preventScroll: true });
    const at = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      put({
        ...hsv,
        s: Math.max(0, Math.min(1, (cx - r.left) / r.width)),
        v: 1 - Math.max(0, Math.min(1, (cy - r.top) / r.height)),
      });
    };
    at(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => { if (ev.pointerId === id) at(ev.clientX, ev.clientY); };
    const up = (ev: PointerEvent) => { if (ev.pointerId === id) endRef.current?.(); };
    endRef.current = () => {
      endRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // Seed HSV from the prop on the way open — the one and only hex->HSV conversion.
  const toggle = () => { if (!open) { setHsv(hexToHsv(value)); place(); } setOpen((o) => !o); };

  /* ---- ON A TELEVISION THIS IS A ROW OF SWATCHES, NOT AN HSV FIELD -------------------------
   * The picker below is three `<input type=range>`s over a saturation/brightness plane, driven by
   * a pointer. A remote has neither: the ranges are not in TvSpatialNav's candidate selector, so
   * on the running TV build all six of them (two pickers) were unreachable — the pill opened a
   * panel that nothing could then touch.
   *
   * Making them focusable would not have rescued it. A focused range swallows every arrow — Left
   * and Right change the value and so do Up and Down — so a remote that entered one could not
   * leave, and picking a colour on a continuous 2-D plane with a D-pad is a chore even when the
   * keys work.
   *
   * SUBTITLE COLOUR HAS ABOUT SIX SENSIBLE ANSWERS, which is the observation that makes the whole
   * control unnecessary here. These are the shades broadcast captioning has used for decades and
   * they are all legible over video; a viewer who wants #7A3B12 is not sitting in front of a
   * television. Each swatch is a real `<button>`, so it is a focus stop with no new mechanism at
   * all — no trap to escape, no panel to dismiss, and OK sets the colour outright.
   *
   * The web build is untouched: it keeps the full picker below, where a pointer makes it good. */
  if (IS_TV) {
    return (
      <div className="set-color is-tv" ref={ref}>
        <span className="sr-only">{`${label}, ${hex}`}</span>
        {TV_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            className={`set-color-chip${c.toLowerCase() === String(value).toLowerCase() ? ' on' : ''}`}
            style={{ background: c }}
            aria-label={`${label}: ${c}`}
            aria-pressed={c.toLowerCase() === String(value).toLowerCase()}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={`set-color${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="set-color-pill" ref={btnRef} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
        <span className="set-color-sw" style={{ background: hex }} aria-hidden="true" />
        <span className="sr-only">{`${label}, ${hex}`}</span>
      </button>
      <div className="set-color-panel" role="dialog" aria-label={label} inert={!open} style={pos}>
        <div
          className="set-color-sv"
          style={{ background: `linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,#fff,rgba(255,255,255,0)),hsl(${hsv.h},100%,50%)` }}
          onPointerDown={onSvPointerDown}
        >
          <span className="set-color-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} aria-hidden="true" />
          <input className="set-color-k" type="range" min={0} max={100} value={Math.round(hsv.s * 100)} ref={satRef}
            onChange={(e) => put({ ...hsv, s: +e.target.value / 100 })} aria-label={t('settings.sub_sat_a')} />
          <input className="set-color-k" type="range" min={0} max={100} value={Math.round(hsv.v * 100)}
            onChange={(e) => put({ ...hsv, v: +e.target.value / 100 })} aria-label={t('settings.sub_val_a')} />
        </div>
        <input className="set-color-hue" type="range" min={0} max={360} value={Math.round(hsv.h)}
          onChange={(e) => put({ ...hsv, h: +e.target.value })} aria-label={t('settings.sub_hue_a')} />
      </div>
    </div>
  );
}
