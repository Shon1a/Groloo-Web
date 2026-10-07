import { lazy, Suspense, useState, type ElementType } from 'react';
import { useModal } from '../../stores/modal';
import { loadDetailModal, loadedDetailModal } from './loadDetailModal';

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
 * ONCE OPENED, STAYS MOUNTED. The component chosen at the first open is kept for the gate's
 * life, so closing a title does not unmount the modal (its own close transition needs to
 * play) and does not throw the chunk away to be refetched on the next open. The cost is one
 * always-null component after first use, which is nothing.
 *
 * CODE THAT IS ALREADY HERE IS RENDERED, NOT SUSPENDED ON. React holds a Suspense boundary
 * that has shown its fallback for at least 300ms before it reveals what it was waiting for
 * (react-dom's fallback throttle) — so going through `lazy` cost the first OK of a session a
 * third of a second of black even when the chunk had been fetched and evaluated long before,
 * which on the television it has (lib/bootGate.ts preloads it under the splash). Measured at
 * the set's speed: the overlay appeared 319ms after OK, with the main thread idle for all but
 * 30ms of it. So the loader remembers the module once it has evaluated, and a first open that
 * finds it is the same single commit as every open after it. `lazy` remains for a first open
 * that beats the download (the website, which does not preload). And the latch is set during
 * render, not in an effect: an effect committed the closed placeholder once more before the
 * modal could mount, a whole extra pass on the open. */
const DetailModal = lazy(loadDetailModal);

const closed = <div className="overlay" id="overlay" aria-hidden="true" />;

export default function DetailModalGate() {
  const hasTarget = useModal((s) => !!s.target);
  const [Modal, setModal] = useState<ElementType | null>(null);
  if (hasTarget && !Modal) setModal(() => loadedDetailModal() ?? DetailModal);

  if (!Modal) return closed;
  if (Modal === DetailModal) return <Suspense fallback={closed}><DetailModal /></Suspense>;
  return <Modal />;
}
