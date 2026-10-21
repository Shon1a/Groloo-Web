import type { Thumb } from '../../stores/ratings';

/* Netflix's three ratings, in outline: a thumb down, a thumb up, two thumbs up. The pair's front thumb
 * is cut out of the back one by a band of the background's colour (`--knock`, tv.css), and a rating
 * given fills its thumb. The title page's (TvDetail) and post-play's (SpotlightStage). */
const THUMB_D = 'M7 20.5H4.6c-.6 0-1.1-.5-1.1-1.1v-7.3c0-.6.5-1.1 1.1-1.1H7m0 9.5h9.6c1 0 1.9-.7 2.1-1.7l1.5-6.2c.3-1.3-.7-2.5-2-2.5h-4.6l.8-3.8c.2-1-.4-2-1.4-2.3l-.3-.1c-.4-.1-.8.1-1 .4L7 11z';
export default function ThumbIcon({ kind }: { kind: Thumb }) {
  return (
    <svg className="tv-dm-thumb" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      {kind === 'up' && <path className="tv-thumb" d={THUMB_D} />}
      {kind === 'down' && <path className="tv-thumb" d={THUMB_D} transform="rotate(180 12 12)" />}
      {kind === 'love' && (
        <>
          <path className="tv-thumb" d={THUMB_D} strokeWidth="2.2" transform="translate(.6 .4) scale(.8)" />
          <path className="tv-thumb-gap" d={THUMB_D} strokeWidth="5" transform="translate(5 4.4) scale(.8)" />
          <path className="tv-thumb" d={THUMB_D} strokeWidth="2.2" transform="translate(5 4.4) scale(.8)" />
        </>
      )}
    </svg>
  );
}
