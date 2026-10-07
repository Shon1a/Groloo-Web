import { lazy, Suspense, useEffect, useState } from 'react';
import { useIdle } from '../../lib/idle';

/* Loads the screensaver (IdleSlideshow) the first time the idle clock runs out, the same way the
 * player and the title screen wait for their first use: most sessions never sit still for ten
 * minutes, and the ones that do can spare the moment the chunk takes.
 *
 * It stays mounted through its fade-out, still catching the pointer, so the click or tap that woke
 * the screen lands on the slideshow and not on whatever the slideshow was covering. */
const IdleSlideshow = lazy(() => import('./IdleSlideshow'));

/** `.idle-show.is-leaving` in spotlight.css, and a frame to spare. */
const LEAVE_MS = 400;

export default function IdleSlideshowGate() {
  const on = useIdle((s) => s.on);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (on) { setMounted(true); return; }
    const id = window.setTimeout(() => setMounted(false), LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [on]);

  if (!mounted) return null;
  return <Suspense fallback={null}><IdleSlideshow leaving={!on} /></Suspense>;
}
