import type { MetaDetail } from './types';

type Ep = { season: number; episode: number };

/** An episode REMEMBERED somewhere — a Continue Watching entry, a deep link — in the numbering
 *  the show is shown in now.
 *
 *  The server re-numbers shows whose TMDB layout is not the one stream add-ons answer to (see
 *  server.js `episodeMap`), and a resume point saved before that happened is in TMDB's numbering:
 *  Bleach's "S2E46" is Thousand-Year Blood War episode 46, which is season 20 episode 6 now —
 *  season 2 is 21 episodes of the original run. `meta.tmdbRuns` is the translation, sent only for
 *  a re-numbered show.
 *
 *  ONLY AN EPISODE THE CURRENT LAYOUT DOES NOT HAVE IS TRANSLATED. One it does have is assumed to
 *  be in the current numbering already, which is right for everything saved from now on and
 *  leaves a remembered episode that happens to exist in both numberings where it was — the price
 *  of the stored entries carrying no record of which numbering they were saved in. */
export function currentEp<T extends Ep>(meta: MetaDetail | undefined, ep: T | undefined): T | Ep | undefined {
  if (!ep || !meta?.tmdbRuns?.length) return ep;
  const s = meta.seasonList?.find((x) => x.season === ep.season);
  if (s && ep.episode >= 1 && ep.episode <= s.episodes) return ep;
  for (const [ds, de, ts, te, n] of meta.tmdbRuns) {
    if (ts === ep.season && ep.episode >= te && ep.episode < te + n) return { season: ds, episode: de + (ep.episode - te) };
  }
  return ep;
}
