import type { MetaDetail } from '../../lib/types';

/* ---- THE CAST, AS FACES -------------------------------------------------------------------------
 * The TV title screen's credits (TvDetail) are the leading cast as a row of round headshots, edge to
 * edge, each in a thin light ring, with the first name beneath — and nothing else: no director line, no
 * label. It was a line of text on the argument that the web modal's 38px avatars are unreadable from a
 * sofa: an argument about the SIZE, not the photos. A face at ninety pixels is recognised before any
 * name is read, which is the point of a cast list on a television.
 *
 * FIVE, BILLING ORDER. TMDB orders cast by billing, so the faces anyone knows are at the front. Five is
 * the row as it was drawn beside a label column; with the label gone the column has room for more, and
 * the count stayed (`.tv-det-faces` in tv.css).
 *
 * FIRST NAMES, UNLESS TWO ARE THE SAME. A circle is as wide as its caption can be, so the caption is a
 * cue, not the credit — the photo is the credit. But "Chris" twice in a Marvel cast, or a Korean cast
 * where the first word is the family name ("Lee Jung-jae", "Lee Byung-hun"), would put two identical
 * words under two different people. Those get the next word's initial: "Chris E.", "Chris H.". */
export const CAST_FACES = 5;

export interface CastFace {
  /** The full name, for assistive tech; the screen prints `label`. */
  name: string;
  /** The first name, or the first name and an initial where two in the row share it. */
  label: string;
  /** Too wide for the circle at the caption's size, so it sets a step smaller (`.is-long` in tv.css). */
  long: boolean;
  /** The headshot (TMDB w185 via the server), or '' when TMDB has none. */
  url: string;
}

/* HOW WIDE A NAME SETS, in Latin letters. The caption is no wider than its circle (88px at 1080p), and
 * at its size eight Latin letters fit — "Leonardo" is 78px — while nine are at the edge ("Alexandra"
 * ~87px). A count of characters is the wrong ruler for anything else: Georgian letters set about a
 * quarter wider ("ლეონარდო", eight letters, is 94px) and CJK about 1.7× ("渡辺謙" is 50px for three).
 * Measured in the app's own fonts on Chromium 120; a guess is all a render can afford here, and the
 * ellipsis is still there for the name that beats it. */
const LONG_AT = 8;
function setWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x10a0 && c <= 0x10ff) || (c >= 0x1c90 && c <= 0x1cbf) ? 1.25
      : (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) ? 1.7
      : 1;
  }
  return w;
}

export function castFaces(meta: Pick<MetaDetail, 'cast'> | null | undefined): CastFace[] {
  const picked: { name: string; words: string[]; url: string }[] = [];
  const seen = new Set<string>();
  for (const c of meta?.cast ?? []) {
    const name = c?.name?.trim();
    // One actor voicing two characters is listed twice; the row shows the person once.
    if (!name || seen.has(name)) continue;
    seen.add(name);
    picked.push({ name, words: name.split(/\s+/), url: c.profile || '' });
    if (picked.length === CAST_FACES) break;
  }
  const count = new Map<string, number>();
  for (const p of picked) count.set(p.words[0], (count.get(p.words[0]) ?? 0) + 1);
  return picked.map(({ name, words, url }) => {
    const label = (count.get(words[0]) ?? 0) > 1 && words[1] ? `${words[0]} ${words[1][0]}.` : words[0];
    return { name, label, long: setWidth(label) > LONG_AT, url };
  });
}

/* ---- THE FACES ARE ALREADY THERE WHEN THE SCREEN OPENS ---------------------------------------------
 * Resting on a title warms its screen (lib/queries `useWarmDetail`): the detail, the backdrop, the
 * wordmark — and these, so the row is dealt with its photos rather than circles that light up one by one
 * a beat after everything else. Kept in a cache of their own, like the episode stills (deckGeometry
 * `warmStill`): five headshots per title would otherwise push the row's backdrops out of the shared one
 * (lib/useImageReady). Asked for at low priority — a ~10KB face for a title that may never be opened
 * must not queue in front of the posters the walk is about to show. */
const FACE_KEEP = 24;
const faceCache = new Map<string, HTMLImageElement>();
export function warmFace(url: string): void {
  const hit = faceCache.get(url);
  if (hit) { faceCache.delete(url); faceCache.set(url, hit); return; }
  const im = new Image();
  im.decoding = 'async';
  im.fetchPriority = 'low';
  im.src = url;
  if (typeof im.decode === 'function') im.decode().catch(() => { /* the circle stays dark */ });
  faceCache.set(url, im);
  while (faceCache.size > FACE_KEEP) {
    const oldest = faceCache.keys().next().value;
    if (oldest === undefined) break;
    faceCache.delete(oldest);
  }
}
/** Whether a face is held here and loaded — so a photo mounting with it in hand needs no fade. */
export function faceReady(url: string): boolean {
  const hit = faceCache.get(url);
  return !!hit && hit.complete && hit.naturalWidth > 0;
}
