import { useId, useMemo } from 'react';
import { iconMarkup, type GlanceIconName } from './glanceSymbols';
import '../../styles/glance.css';

export type { GlanceIconName } from './glanceSymbols';

/* One icon of the set (glanceSymbols.ts): an inline SVG carrying its own gradients, coloured by the
 * custom properties in glance.css.
 *
 * ITS INSIDES ARE WRITTEN ONCE PER MOUNT, AND THAT IS WHAT STOPS THE BLINK. React 19 compares the
 * `dangerouslySetInnerHTML` prop BY IDENTITY, not by its string: a fresh `{ __html }` object on every
 * render rewrote every icon on a billboard each time the billboard re-rendered (focus, a trailer
 * starting, an answer arriving), and a rewritten icon restarts its animation. So the object itself is
 * memoised, and the gradient ids inside it come from `useId`, stable for the icon's life. */
export function GlanceIcon({ name, className, title }: { name: GlanceIconName; className?: string; title?: string }) {
  const uid = useId();
  const inner = useMemo(() => ({ __html: iconMarkup(name, `g${uid.replace(/[^a-zA-Z0-9]/g, '')}`) }), [name, uid]);
  return (
    <svg
      className={`gl-ic gl-ic-${name}${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
      dangerouslySetInnerHTML={inner}
    />
  );
}

/* ---- THE BUTTONS ANSWER THE POINTER AND THE REMOTE ------------------------------------------
 * A button with an icon of the set replays that icon's move when it is hovered, clicked, or — the
 * television's hover — reached by the remote. One delegated listener for the whole app, and a class
 * (`gl-tap`) taken off and put back, which is what restarts a CSS animation; it is removed again once
 * the move is over. Only these buttons: a billboard is a button too, and its callouts must not replay
 * every time the remote lands on it. */
const HOT = '.m-disc, .tv-det-disc, .hero-btn, .pp-btn, .rate-opt, .pp-close, .pp-sound, .addon-signin-btn';
if (typeof document !== 'undefined') {
  const timers = new WeakMap<Element, number>();
  const last = new WeakMap<Element, number>();
  const replay = (el: Element) => {
    if (!el.querySelector('.gl-ic')) return;
    /* One gesture, one move: a click focuses before it clicks, and a hover is often followed by the
     * click — restarting a move that has only just begun reads as a flicker, not as an answer. */
    const now = performance.now();
    if (now - (last.get(el) || -1e9) < 350) return;
    last.set(el, now);
    el.classList.remove('gl-tap');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('gl-tap');
    window.clearTimeout(timers.get(el));
    timers.set(el, window.setTimeout(() => el.classList.remove('gl-tap'), 1400));
  };
  const hot = (t: EventTarget | null) => (t instanceof Element ? t.closest(HOT) : null);
  document.addEventListener('mouseover', (e) => {
    const b = hot(e.target);
    if (b && !(e.relatedTarget instanceof Node && b.contains(e.relatedTarget))) replay(b);
  }, true);
  document.addEventListener('focusin', (e) => { const b = hot(e.target); if (b) replay(b); }, true);
  document.addEventListener('click', (e) => { const b = hot(e.target); if (b) replay(b); }, true);
}
