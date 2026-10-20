/* SWIPE IN FROM THE LEFT EDGE TO GO BACK — the iPhone home-screen app only.
 *
 * A Safari tab has this gesture, and so does Android, at the system level: both arrive as a browser
 * Back, which tvKeys' `installBackGuard` turns into "close the top layer". The page opened from the
 * iPhone home screen runs with no browser around it and has no back gesture at all, so there the page
 * draws its own: a finger that starts at the left edge and travels right pulls a small disc out of the
 * edge, the disc turns white past the mark, and lifting it there is a Back. Nowhere else — where the
 * platform has the gesture, a second one would spend one swipe on two Backs.
 *
 * Not inside the player, where a sideways drag already scrubs the film. */
const EDGE = 24;   // px from the left edge a swipe has to start within
const GO = 72;     // px of travel that makes it a Back

export function installEdgeSwipeBack(): () => void {
  if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return () => {};

  const disc = document.createElement('div');
  disc.className = 'edge-back';
  disc.setAttribute('aria-hidden', 'true');
  document.body.appendChild(disc);

  let on = false, claimed = false, x0 = 0, y0 = 0, dx = 0;

  const start = (e: TouchEvent) => {
    on = false; claimed = false; dx = 0;
    const t = e.touches[0];
    if (e.touches.length !== 1 || t.clientX > EDGE) return;
    if ((e.target as Element | null)?.closest?.('.vp-overlay')) return;
    on = true; x0 = t.clientX; y0 = t.clientY;
  };
  const move = (e: TouchEvent) => {
    if (!on) return;
    const t = e.touches[0];
    dx = t.clientX - x0;
    const dy = t.clientY - y0;
    if (!claimed) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > dx) { on = false; return; }   // a scroll, not a swipe
      if (dx < 10) return;
      claimed = true;
      disc.style.top = `${Math.round(Math.min(Math.max(y0, 60), window.innerHeight - 60))}px`;
      disc.classList.add('on');
    }
    // The swipe is ours from here: a row under the finger must not scroll along with it.
    e.preventDefault();
    disc.style.transform = `translateX(${Math.round(Math.min(Math.max(dx, 0), GO) * 0.8 - 44)}px)`;
    disc.classList.toggle('go', dx >= GO);
  };
  const finish = (go: boolean) => {
    if (claimed && go) history.back();
    on = false; claimed = false;
    disc.classList.remove('on', 'go');
    disc.style.transform = '';
  };
  const end = () => finish(dx >= GO);
  const cancel = () => finish(false);

  document.addEventListener('touchstart', start, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', cancel);
  return () => {
    document.removeEventListener('touchstart', start);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', cancel);
    disc.remove();
  };
}
