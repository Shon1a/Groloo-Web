/* WHICH SOURCES THIS BROWSER CAN ACTUALLY MAKE A SOUND WITH.
 *
 * A source can be the right language, the right quality, and still play silently. Chrome,
 * Edge and Firefox ship no Dolby or DTS decoder — there is no licence for one — so an
 * AC-3 / E-AC-3 / DTS track decodes to nothing while the video carries on perfectly. The
 * symptom is not an error and nothing in the player reports it: the file plays, the
 * scrubber moves, and there is silence.
 *
 * Measured in the target browser rather than assumed (`canPlayType`, Chrome 1xx desktop):
 *
 *     audio/mp4; codecs="mp4a.40.2"   probably     AAC
 *     audio/mp4; codecs="flac"        probably
 *     audio/mp4; codecs="Opus"        probably
 *     audio/mp4; codecs="ac-3"        ""    <- Dolby Digital
 *     audio/mp4; codecs="ec-3"        ""    <- Dolby Digital Plus / Atmos
 *     audio/mp4; codecs="dtsc"        ""    <- DTS
 *
 * This matters most on exactly the releases people reach for: Russian dubs ship AC-3 5.1
 * almost universally, and "DDP5.1 Atmos" is the house style of every 4K WEB-DL. A scene
 * name announces its audio codec, so the unplayable ones can be spotted before they are
 * ever started — and where the name is silent, `SILENT_AFTER` below catches it at runtime.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO. It does not block a source: a name is evidence,
 * not proof, remuxes are mislabelled, and a source the user can see and cannot start is
 * worse than one that might disappoint. And it does not treat "unknown" as "bad" — most
 * captions name no codec at all, and those rank with the playable ones rather than being
 * quietly buried. */

/** Codec families a release name can name, in the order they must be tested: the longer,
 *  more specific tokens first, so `DDP` is never matched by the `DD` rule and `DTS-HD`
 *  is never matched as plain `DTS`. */
const AUDIO_TOKENS: Array<{ re: RegExp; codec: string; label: string }> = [
  { re: /\b(ddp|dd\+|e-?ac-?3|eac3|atmos)\b|\bdd\s?plus\b/i, codec: 'ec-3', label: 'Dolby Digital Plus' },
  { re: /\b(truehd|true-?hd)\b/i, codec: 'truehd', label: 'Dolby TrueHD' },
  { re: /\bdts[-\s]?(hd|x|ma|es)\b|\bdts\b/i, codec: 'dtsc', label: 'DTS' },
  { re: /\b(ac-?3|dd\d?(\.\d)?|dolby\s?digital)\b/i, codec: 'ac-3', label: 'Dolby Digital' },
  { re: /\bflac\b/i, codec: 'flac', label: 'FLAC' },
  { re: /\bopus\b/i, codec: 'Opus', label: 'Opus' },
  { re: /\b(aac|he-?aac|lc-?aac)\b/i, codec: 'mp4a.40.2', label: 'AAC' },
  { re: /\bmp3\b/i, codec: 'mp3', label: 'MP3' },
];

/** The audio codec a release NAME claims, or null when it names none. */
export function audioCodecOf(label: string): { codec: string; label: string } | null {
  const t = label || '';
  for (const { re, codec, label: name } of AUDIO_TOKENS) if (re.test(t)) return { codec, label: name };
  return null;
}

/* One <audio> is enough and it is created once: `canPlayType` is a pure query, but making
 * an element per source per render is a lot of DOM for a string comparison. Answers are
 * memoised for the same reason. */
let probe: HTMLAudioElement | null = null;
const answers = new Map<string, boolean>();

/** Can this browser decode `codec`? `truehd` and `mp3` have no useful MIME to ask about —
 *  TrueHD is never decodable here and MP3 always is — so both are answered directly. */
export function canDecodeAudio(codec: string): boolean {
  if (codec === 'truehd') return false;
  if (codec === 'mp3') return true;
  const hit = answers.get(codec);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined') return true;
  probe = probe || document.createElement('audio');
  const ok = !!probe.canPlayType(`audio/mp4; codecs="${codec}"`);
  answers.set(codec, ok);
  return ok;
}

/** Will this source make a sound? `true` playable, `false` the name says otherwise,
 *  `null` the name did not say — which is NOT the same as `false` and must not rank like
 *  it. */
export function audioPlayability(label: string): boolean | null {
  const found = audioCodecOf(label);
  return found ? canDecodeAudio(found.codec) : null;
}

/** Codec name to show on a source this browser cannot make a sound with, else null. */
export function silentCodecName(label: string): string | null {
  const found = audioCodecOf(label);
  return found && !canDecodeAudio(found.codec) ? found.label : null;
}

/* How long playback may run with video decoding and NOT ONE audio byte decoded before the
 * player calls it silent. `webkitAudioDecodedByteCount` is Chrome/Edge only and is exactly
 * the counter needed: an unsupported audio track leaves it pinned at zero while
 * `webkitVideoDecodedByteCount` climbs. Four seconds is long enough to clear a slow start
 * and a genuinely silent opening scene, and short enough to say so before the user has
 * given up and gone back to the list. */
export const SILENT_AFTER = 4;

/** Is this element decoding video but no audio at all? `null` where the counters do not
 *  exist (Firefox, Safari), so the caller can tell "not silent" from "cannot tell". */
export function isDecodingSilently(v: HTMLVideoElement): boolean | null {
  const el = v as unknown as { webkitAudioDecodedByteCount?: number; webkitVideoDecodedByteCount?: number };
  if (typeof el.webkitAudioDecodedByteCount !== 'number' || typeof el.webkitVideoDecodedByteCount !== 'number') return null;
  return el.webkitVideoDecodedByteCount > 0 && el.webkitAudioDecodedByteCount === 0;
}
