import { useEffect, useMemo, useRef, useState } from 'react';
import { useHome } from '../../lib/queries';
import { usePicks } from '../../lib/picks';
import { markShown, wake } from '../../lib/idle';
import { registerBackHandler, BACK_LAYER } from '../../lib/tvKeys';
import SlideShow from './SlideShow';
import { slideArt, warmPicture } from './slideArt';
import { useMoreList, type SpotItem } from './spotData';

const IS_TV = import.meta.env.MODE === 'tv';

/* ---- THE SCREENSAVER ------------------------------------------------------------------------------
 *
 * Post-play's slideshow (SlideShow.tsx), over everything, once ten minutes have passed in which
 * nobody touched anything and nothing was playing — lib/idle.ts keeps that clock and catches the
 * press that ends it. The titles are the mix post-play's slideshow takes: series, films and anime in
 * turn plus a couple still to come, ranked by the viewer's taste, from their picks and the home rows.
 *
 * IT ONLY COMES UP READY. Mounted when the clock runs out, it stays invisible — and lets every press
 * through — until its titles are dressed and the first picture is decoded; then black fades in over
 * the screen with that picture already rising out of it. Nothing to show (offline, a home screen that
 * never loaded) and it quietly stands down: the clock simply starts again. */

/** Fewer titles than this is not a slideshow. */
const MIN_SLIDES = 3;
/** How long the titles may take to arrive before the screen is left alone. */
const GIVE_UP_MS = 20000;
/** How long the first picture may take before the curtain rises without it. */
const PICTURE_PATIENCE = 6000;
const NONE = new Set<string>();

export default function IdleSlideshow({ leaving }: { leaving: boolean }) {
  // The rows' titles, even when the home screen's copy has been dropped since it was last open.
  useHome();
  const { picks } = usePicks(12, true);
  const sources = useMemo(() => [picks.map((p) => p.item)], [picks]);
  const { items, ready } = useMoreList(sources, NONE, true);

  /* TAKEN ONCE, when its artwork has arrived: a refetch behind the screen must not swap the titles
   * under a slideshow that is already running. */
  const [list, setList] = useState<SpotItem[] | null>(null);
  useEffect(() => {
    if (!list && ready && items.length >= MIN_SLIDES) setList(items);
  }, [list, ready, items]);
  useEffect(() => {
    if (list) return;
    const id = window.setTimeout(wake, GIVE_UP_MS);
    return () => window.clearTimeout(id);
  }, [list]);

  const [pictured, setPictured] = useState(false);
  useEffect(() => {
    if (!list) return;
    let alive = true;
    const go = () => { if (alive) setPictured(true); };
    void warmPicture(slideArt(list[0])).then(go);
    const id = window.setTimeout(go, PICTURE_PATIENCE);
    return () => { alive = false; window.clearTimeout(id); };
  }, [list]);

  const up = !!list && pictured;
  useEffect(() => { if (up) markShown(); }, [up]);
  /* Back that arrives as a history step rather than a key — a TV's own browser, see tvKeys — wakes
   * the screen too, instead of closing whatever is underneath it. */
  useEffect(() => {
    if (!up || leaving) return;
    return registerBackHandler(() => { wake(); return true; }, BACK_LAYER.screensaver);
  }, [up, leaving]);

  // A wheel over the slideshow must not scroll the page behind it while it fades away.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  return (
    <div ref={rootRef} className={`idle-show pp-host${up ? (leaving ? ' is-leaving' : ' is-on') : ''}`} aria-hidden="true">
      {list && pictured && (
        <div className={`pp-root${IS_TV ? ' tv' : ' web'}`}>
          <SlideShow items={list} held={false} />
        </div>
      )}
    </div>
  );
}
