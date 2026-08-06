/** Put `card` in the episode rail's first slot, scrolling THE STRIP AND NOTHING ELSE.
 *
 *  `scrollIntoView` cannot be used here and this is why: it scrolls every scrollable ancestor,
 *  and `.vp-overlay` is one — `overflow:hidden` still scrolls under script, it only refuses a
 *  scrollbar. So while the shelf was still sliding up (its cards below the fold), the browser
 *  obligingly scrolled the whole overlay down to reveal the card it had been asked to reveal,
 *  taking the <video> with it, and scrolled back when the slide finished. That is the picture
 *  drifting up and down on every open — an ancestor doing exactly what it was told.
 *
 *  Written against `getBoundingClientRect` rather than `offsetLeft` so it does not depend on
 *  which ancestor happens to be positioned; horizontal geometry is unaffected by the rail's
 *  vertical transform, so it is correct mid-slide too.
 *
 *  Its own module rather than an export beside the component, so `EpisodeRail.tsx` stays a
 *  components-only file and keeps fast refresh. */
export function scrollCardToSlot(card: HTMLElement, behavior: ScrollBehavior = 'smooth') {
  const track = card.parentElement;
  if (!track) return;
  const delta = card.getBoundingClientRect().left - track.getBoundingClientRect().left;
  track.scrollTo({ left: track.scrollLeft + delta, behavior });
}
