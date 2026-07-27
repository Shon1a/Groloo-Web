import { lazy, Suspense, useEffect, useState } from 'react';
import { useModal } from '../../stores/modal';

/* Loads the DetailModal chunk only once a title has actually been opened.
 *
 * DetailModal is always in the app tree — it renders its own empty overlay when closed so
 * its open/close transition has something to animate. That is exactly what makes a plain
 * `lazy(DetailModal)` pointless: an always-mounted lazy component loads its chunk on first
 * render, i.e. immediately, defeating the split. So this gate stands in for the closed
 * state with the SAME empty overlay the modal itself renders when `target` is null, and
 * mounts the real chunk only after the first open.
 *
 * THE PLACEHOLDER MUST MATCH byte-for-byte — same element, same id, same aria — or the
 * home screen shifts under the screenshot baseline before anyone has opened anything. It
 * mirrors DetailModal's own `if (!target) return <div className="overlay" id="overlay"
 * aria-hidden="true" />`.
 *
 * ONCE OPENED, STAYS MOUNTED. `everOpened` latches true and never flips back, so closing a
 * title does not unmount the modal (its own close transition needs to play) and does not
 * throw the chunk away to be refetched on the next open. The cost is one always-null
 * component after first use, which is nothing. */
const DetailModal = lazy(() => import('./DetailModal'));

const closed = <div className="overlay" id="overlay" aria-hidden="true" />;

export default function DetailModalGate() {
  const hasTarget = useModal((s) => !!s.target);
  const [everOpened, setEverOpened] = useState(hasTarget);
  useEffect(() => { if (hasTarget) setEverOpened(true); }, [hasTarget]);

  if (!everOpened) return closed;
  return <Suspense fallback={closed}><DetailModal /></Suspense>;
}
