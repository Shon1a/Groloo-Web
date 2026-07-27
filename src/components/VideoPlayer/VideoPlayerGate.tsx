import { lazy, Suspense, useEffect, useState } from 'react';
import { usePlayer } from '../../stores/player';

/* Loads the VideoPlayer chunk only once playback has actually started.
 *
 * Same shape and same reasoning as DetailModalGate. VideoPlayer is the heaviest deferrable
 * screen in the app — it pulls in the HLS path and the whole player UI — and the large
 * majority of sessions never start playback, so this is the single biggest first-load win
 * in the split. The placeholder mirrors VideoPlayer's own closed return
 * (`if (!source) return <div className="vp-overlay" id="playerOverlay" />`) exactly, so
 * nothing moves before the first play. */
const VideoPlayer = lazy(() => import('./VideoPlayer'));

const closed = <div className="vp-overlay" id="playerOverlay" />;

export default function VideoPlayerGate() {
  const hasSource = usePlayer((s) => !!s.source);
  const [everPlayed, setEverPlayed] = useState(hasSource);
  useEffect(() => { if (hasSource) setEverPlayed(true); }, [hasSource]);

  if (!everPlayed) return closed;
  return <Suspense fallback={closed}><VideoPlayer /></Suspense>;
}
