/* ---- THE ICONS' MOVES, ON ONE CLOCK ----------------------------------------------------------
 *
 * An icon of the set plays its entrance as a handful of parts, each with its own move (`m-pop`,
 * `m-drop`…) and most of them a beat after the one before. That stagger is the design, and it was
 * written the obvious way: one animation per part, its own duration, its own `animation-delay`.
 *
 * WHAT THAT COST ON A TELEVISION. The parts' transforms and opacities do run on the compositor — but
 * every animation STARTING or ENDING is an event the engine answers with a main-thread frame, and an
 * SVG part's frame is style, layout of its drawing, paint and a commit. A billboard's pair of callouts
 * is ten or so animations starting and stopping at ten different moments across a second, which is
 * near-enough a main-thread frame on every vsync for that second — measured on the set's own engine
 * (Chromium 120): 40 main frames, each with a layout and a paint, against 7 for the same animations
 * started and stopped together. And that second is the one right after a press, when the row is also
 * committing the card it moved to.
 *
 * SO EVERY MOVE NOW RUNS FOR THE SAME TIME, MOTION_S, FROM THE SAME MOMENT. A part's delay and its own
 * duration are written INTO its keyframes: it holds its first pose until its delay is up, makes exactly
 * the move it always made over exactly the time it always took, then holds where it landed until the
 * clock runs out. CSS applies the timing function to each keyframe interval separately, so the move's
 * curve is untouched, and a hold is an interval whose two ends are equal, so its curve does nothing —
 * the motion on screen is the same, frame for frame, as the per-part version. What changes is that the
 * engine sees one start and one end for the whole icon (and for the callout tab it sits in: glance.css
 * `.gl-chips.rise`, on the same clock).
 *
 * The moves themselves are unchanged from glance.css, where they used to be written out; a part names
 * its delay with `data-d` (centiseconds — `iconMarkup` turns the drawings' `--d` into it). `m-draw`
 * animates a stroke, which never reaches the compositor anyway, and stays a plain rule in glance.css. */

/** The one clock: the longest move plus its longest delay (bob, needle: 1.1s). Change glance.css's
 *  `.gl-chips.rise` keyframes with it. */
export const MOTION_S = 1.1;

type Frame = [offsets: number[], props: { opacity?: string; transform?: string }];
interface Move { dur: number; ease: string; frames: Frame[] }

const MOVES: Record<string, Move> = {
  pop: { dur: 0.6, ease: 'cubic-bezier(.3,1.6,.45,1)', frames: [[[0], { opacity: '0', transform: 'scale(.4)' }]] },
  drop: { dur: 0.55, ease: 'cubic-bezier(.3,1.5,.5,1)', frames: [[[0], { opacity: '0', transform: 'translateY(-70%)' }]] },
  rise: { dur: 0.5, ease: 'cubic-bezier(.2,1.4,.5,1)', frames: [[[0], { opacity: '0', transform: 'translateY(55%)' }]] },
  swing: { dur: 0.8, ease: 'cubic-bezier(.3,1.2,.4,1)', frames: [
    [[0], { opacity: '0', transform: 'rotate(-24deg) scale(.6)' }],
    [[0.55], { opacity: '1', transform: 'rotate(9deg) scale(1.05)' }]] },
  flip: { dur: 0.6, ease: 'cubic-bezier(.3,1.4,.5,1)', frames: [
    [[0], { opacity: '0', transform: 'scaleY(.1)' }],
    [[0.6], { opacity: '1', transform: 'scaleY(1.08)' }]] },
  shake: { dur: 0.85, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'scale(.7)' }],
    [[0.25], { opacity: '1', transform: 'rotate(-10deg) scale(1.08)' }],
    [[0.45], { transform: 'rotate(8deg)' }],
    [[0.65], { transform: 'rotate(-5deg)' }],
    [[0.85], { transform: 'rotate(2deg)' }]] },
  grow: { dur: 0.5, ease: 'cubic-bezier(.3,1.6,.5,1)', frames: [[[0], { opacity: '0', transform: 'scale(0)' }]] },
  clap: { dur: 0.75, ease: 'cubic-bezier(.5,0,.3,1)', frames: [
    [[0, 0.45], { transform: 'rotate(-26deg)' }],
    [[0.72], { transform: 'rotate(4deg)' }]] },
  spin: { dur: 0.7, ease: 'cubic-bezier(.3,1.3,.5,1)', frames: [[[0], { opacity: '0', transform: 'rotate(-120deg) scale(.4)' }]] },
  spin2: { dur: 0.85, ease: 'cubic-bezier(.3,1.3,.5,1)', frames: [[[0], { opacity: '0', transform: 'rotate(90deg) scale(.5)' }]] },
  slide: { dur: 0.55, ease: 'cubic-bezier(.2,.9,.3,1)', frames: [[[0], { opacity: '0', transform: 'translateX(-35%)' }]] },
  slide2: { dur: 0.55, ease: 'cubic-bezier(.2,.9,.3,1)', frames: [[[0], { opacity: '0', transform: 'translate(-45%,-45%)' }]] },
  slidel: { dur: 0.55, ease: 'cubic-bezier(.2,.9,.3,1)', frames: [[[0], { opacity: '0', transform: 'translateX(40%)' }]] },
  stamp: { dur: 0.55, ease: 'cubic-bezier(.3,1.5,.5,1)', frames: [
    [[0], { opacity: '0', transform: 'scale(1.5) rotate(-10deg)' }],
    [[0.6], { opacity: '1', transform: 'scale(.92) rotate(2deg)' }]] },
  bob: { dur: 0.6, ease: 'ease-out', frames: [
    [[0.35], { transform: 'translateY(-35%)' }],
    [[0.7], { transform: 'translateY(8%)' }]] },
  turn: { dur: 1, ease: 'ease-out', frames: [[[0], { opacity: '0', transform: 'translateX(-30%)' }]] },
  float: { dur: 0.9, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'translateY(25%) rotate(-6deg)' }],
    [[0.6], { opacity: '1', transform: 'translateY(-6%) rotate(3deg)' }]] },
  laugh: { dur: 0.85, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'scale(.6) rotate(-12deg)' }],
    [[0.4], { opacity: '1', transform: 'scale(1.08) rotate(8deg)' }],
    [[0.6], { transform: 'rotate(-6deg)' }],
    [[0.8], { transform: 'rotate(3deg)' }]] },
  beat: { dur: 0.9, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'scale(.5)' }],
    [[0.3], { opacity: '1', transform: 'scale(1.15)' }],
    [[0.45], { transform: 'scale(.96)' }],
    [[0.6], { transform: 'scale(1.1)' }]] },
  tilt: { dur: 0.9, ease: 'cubic-bezier(.3,1.3,.5,1)', frames: [[[0], { opacity: '0', transform: 'rotate(-30deg) scale(.7)' }]] },
  needle: { dur: 1.1, ease: 'cubic-bezier(.3,1.5,.4,1)', frames: [
    [[0], { transform: 'rotate(-140deg)' }],
    [[0.6], { transform: 'rotate(25deg)' }],
    [[0.8], { transform: 'rotate(-8deg)' }]] },
  sweep: { dur: 0.9, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'translate(-25%,-25%) scale(.8)' }],
    [[0.5], { opacity: '1', transform: 'translate(8%,8%)' }]] },
  flash: { dur: 0.65, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'scale(.6)' }],
    [[0.3], { opacity: '1', transform: 'scale(1.12)' }],
    [[0.45], { opacity: '.4' }],
    [[0.6], { opacity: '1' }]] },
  dropin: { dur: 0.7, ease: 'cubic-bezier(.3,1.4,.5,1)', frames: [
    [[0], { opacity: '0', transform: 'translateY(-55%) scale(.8,1.15)' }],
    [[0.6], { opacity: '1', transform: 'translateY(4%) scale(1.08,.92)' }]] },
  nudge: { dur: 0.6, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'translateX(-25%)' }],
    [[0.6], { opacity: '1', transform: 'translateX(8%)' }]] },
  wave: { dur: 0.9, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'scaleX(.2)' }],
    [[0.4], { opacity: '1', transform: 'skewY(6deg)' }],
    [[0.7], { transform: 'skewY(-4deg)' }]] },
  blink: { dur: 0.7, ease: 'ease-out', frames: [
    [[0], { opacity: '0', transform: 'translateX(-30%)' }],
    [[0.6], { opacity: '1' }]] },
};

/** Where a part rests: the value each animated property has with no animation on it. No moving part
 *  carries an `opacity` or `transform` of its own (glanceSymbols — a part that needs one wears it on an
 *  inner group), so this is the same for all of them. */
const REST = { opacity: '1', transform: 'none' } as const;

const pct = (x: number) => `${Math.round(x * 10000) / 100}%`;

/** One move, delayed `cs` centiseconds, laid onto the shared clock. */
function keyframes(name: string, m: Move, cs: number): string {
  const a = cs / 100 / MOTION_S;
  const b = Math.min(1, (cs / 100 + m.dur) / MOTION_S);
  const props = new Set<keyof typeof REST>();
  for (const [, p] of m.frames) for (const k of Object.keys(p) as Array<keyof typeof REST>) props.add(k);
  const decl = (p: Frame[1]) => Object.entries(p).map(([k, v]) => `${k}:${v}`).join(';');
  // The first pose: the move's 0% keyframe, and the resting value of anything it does not set there.
  const first: Frame[1] = {};
  const at0 = m.frames.find(([o]) => o.includes(0))?.[1] ?? {};
  for (const k of props) first[k] = at0[k] ?? REST[k];
  const rest: Frame[1] = {};
  for (const k of props) rest[k] = REST[k];
  let out = `@keyframes ${name}{`;
  out += `${a > 0 ? `0%,${pct(a)}` : '0%'}{${decl(first)}}`;
  for (const [offsets, p] of m.frames) {
    const at = offsets.filter((o) => o > 0).map((o) => pct(a + o * (b - a)));
    if (at.length) out += `${at.join(',')}{${decl(p)}}`;
  }
  out += `${b < 1 ? `${pct(b)},100%` : '100%'}{${decl(rest)}}`;
  return `${out}}`;
}

let injected = false;
/** The moves' rules, written once into the document on the first icon drawn. `delays` lists every
 *  (move, centiseconds) pair the drawings use, so each gets its own keyframes — asked for only the
 *  once, since every icon drawn calls this. */
export function ensureMotionCss(delays: () => Iterable<[string, number]>): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const byMove = new Map<string, Set<number>>();
  for (const [move, cs] of delays()) {
    if (!MOVES[move]) continue;
    if (!byMove.has(move)) byMove.set(move, new Set([0]));
    byMove.get(move)!.add(cs);
  }
  for (const move of Object.keys(MOVES)) if (!byMove.has(move)) byMove.set(move, new Set([0]));
  let css = '';
  for (const [move, set] of byMove) {
    const m = MOVES[move];
    const run = `.gl-run .m-${move},.gl-tap .m-${move}`;
    css += `${run}{animation:glm-${move} ${MOTION_S}s ${m.ease} backwards}`;
    css += keyframes(`glm-${move}`, m, 0);
    for (const cs of set) {
      if (!cs) continue;
      css += `.gl-run .m-${move}[data-d="${cs}"],.gl-tap .m-${move}[data-d="${cs}"]{animation-name:glm-${move}-${cs}}`;
      css += keyframes(`glm-${move}-${cs}`, m, cs);
    }
  }
  const style = document.createElement('style');
  style.id = 'gl-motion';
  style.textContent = css;
  /* FIRST in <head>, so glance.css and every sheet after it still win on order — the reduced-motion
   * switch, and the slideshow's own start offsets (spotlight.css), are written as overrides of these. */
  document.head.insertBefore(style, document.head.firstChild);
}
