/* cn() — the class-name joiner that shadcn/lucide-animated components import from
 * "@/lib/utils". Upstream it is twMerge(clsx(inputs)), but this app has no Tailwind:
 * there are no utility classes to de-duplicate, so twMerge would be a no-op and clsx
 * a dependency for a filter+join. If Tailwind ever lands here, swap the body for the
 * real thing rather than teaching callers to work around this one. */

export type ClassValue = string | number | null | undefined | false;

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(' ');
}

/* ONE SPELLING OF "WHICH EPISODE", FOR THE WHOLE APP.
 *
 * This label appears in four places a viewer passes through in a single sitting: the sources
 * panel heading, the stream rows under it, the player's title line, and the episode shelf inside
 * the player. It had four spellings — `S1 · E4`, `· S1 E4`, `S1 EP4` and `S1E4` — because each
 * was written where it was needed, and a separator that differs between two screens shown ten
 * seconds apart reads as two different things being named rather than one.
 *
 * The pipe is the separator because the two halves are coordinate, not a list: `S1 · E4` uses the
 * character this app spends everywhere on enumerations (`Action · 2026 · 1h 42m`), which quietly
 * says "season one, and also episode four" instead of "season one, episode four".
 *
 * NOT the storage key. `S1E4` compact — `progress[`${id}:S${s}E${e}`]`, `media.ep` — is an
 * identifier that is persisted and matched on, and it must never inherit a change made for how a
 * label looks. Those stay literal at their call sites, deliberately. */
export const epLabel = (season: number, episode: number): string => `S${season} | E${episode}`;
