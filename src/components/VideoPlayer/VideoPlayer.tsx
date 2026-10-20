import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { usePlayer } from '../../stores/player';
import { useModal } from '../../stores/modal';
import { useHistory } from '../../stores/history';
import { useSettings } from '../../stores/settings';
import { useT } from '../../i18n/i18n';
import { loadHls, isHlsUrl, type HlsInstance } from '../../lib/hls';
import { toVttBlobUrl, cueLook, subPickKey, loadSubPick, saveSubPick, autoSubIndex, bareSubLabel, type SubPick } from '../../lib/subtitles';
import { isDecodingSilently, SILENT_AFTER } from '../../lib/codecs';
import { resolvePlayback } from '../../lib/streamingServer';
import { playDemuxed, probeUrl, type DemuxHandle } from '../../lib/browserDemux';
import { playWithWasmAudio, needsWasmDecoder, type WasmAudioHandle } from '../../lib/wasmAudio';
import { langName, normalizeSubLang, collectAddonSubtitles, canStartHere, type AddonStream } from '../../lib/addonClient';
import { apiFetch } from '../../lib/api';
import { registerBackHandler, BACK_LAYER, mediaAction } from '../../lib/tvKeys';
import { useKeepAwake } from '../../lib/idle';
import { useSeason } from '../../lib/queries';
import { rasterLogo } from '../../lib/img';
import { epLabel } from '../../lib/utils';
import EpisodeRail from './EpisodeRail';
import { scrollCardToSlot } from './railScroll';
import { createCreditsDetector, creditsFallback, creditsWatchFrom, type CreditsDetector } from '../../lib/creditsDetect';

/* POST-PLAY IS ITS OWN CHUNK. Most playbacks never reach the credits (a series rolls straight into
 * the next episode, a film gets closed early), so the screen, its data hooks and its stylesheet are
 * fetched only once a film is close enough to its end to need them — see `ppArmed` below. */
const PostPlay = lazy(() => import('../Spotlight/PostPlay'));
/** How long post-play keeps the credits in their corner before they fade out. */
const PP_MINI_MS = 10000;

/* THE TWO BUILDS ARE ONE PLAYER WITH TWO INPUTS, and this constant is what splits them.
 * `import.meta.env.MODE` is a Vite compile-time string, so every `IS_TV` branch below is resolved
 * at build time and the losing side is dropped: the website never carries the remote-control
 * code, and the TV never carries the mouse-gesture code. See "TEN FEET AWAY" below.
 *
 * THE CHROME IS THE SAME ON BOTH NOW. It used to be two players — a YouTube-shaped row of eleven
 * buttons under a thin bar on the web, and the one-line disc · elapsed · bar · duration transport
 * on the television — and the web one was the older and the worse of the two. The TV's layout is
 * the layout: title beside the episode, audio and ⋯ in the top-right corner, the settings menu a
 * sheet on the right edge with a section chip over its list, and the episodes a shelf of stills
 * under the scrubber. What still differs is what each input NEEDS: the web keeps a close button,
 * fullscreen, picture-in-picture and a volume control, because a mouse has no Back key, no
 * fullscreen key and no volume rocker; the TV keeps none of them for the opposite reason. */
const IS_TV = import.meta.env.MODE === 'tv';

/* iOS IS THE ONE PLATFORM WHERE `video.volume` IS READ-ONLY. Setting it is silently ignored — the
 * value reads back 1 forever — because Apple reserves volume for the hardware rocker; only
 * `muted` takes. The volume swipe worked on every Android phone and did nothing on any iPhone,
 * with the HUD cheerfully drawing a level the audio was not following. Detected up front rather
 * than probed on the element (a probe fires two `volumechange` events on every other browser),
 * and iPadOS is caught by the touch-points test because it reports itself as a Mac. */
const VOL_LOCKED = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// skip-intro heuristic window (s) + credits-tail length when no IntroDB markers exist
const INTRO_FROM = 8, INTRO_TO = 92, CREDITS_TAIL = 35;
/* Where the intro, recap, credits ("outro") and next-episode preview are, in seconds — from
 * /api/segments, which merges the community databases (SkipDB, TheIntroDB, IntroDB, AniSkip) and checks each marker against this file's
 * length. Credits and previews may run to the end of the file (`end` null). */
interface Segments {
  intro?: { start: number; end: number } | null;
  recap?: { start: number; end: number } | null;
  outro?: { start: number; end: number | null } | null;
  preview?: { start: number; end: number | null } | null;
}

/* THE ICON ROW over the scrubber: Episodes, Next, Subtitles, Audio — the glyphs and the order a
 * viewer knows from the big streaming apps, so none of them needs a label. */
const IcEpisodes = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <rect x="3" y="5" width="3" height="2.4" rx=".7" /><rect x="8.5" y="5" width="12.5" height="2.4" rx="1.2" />
    <rect x="3" y="10.8" width="3" height="2.4" rx=".7" /><rect x="8.5" y="10.8" width="12.5" height="2.4" rx="1.2" />
    <rect x="3" y="16.6" width="3" height="2.4" rx=".7" /><rect x="8.5" y="16.6" width="12.5" height="2.4" rx="1.2" />
  </svg>
);
// The solid play triangle on the Next Episode prompt — filled, not the stroked transport glyph.
const IcPlaySolid = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>;
const IcNext = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M5.5 5.6v12.8L15 12 5.5 5.6zM16.6 5.6h2.4v12.8h-2.4z" /></svg>;
const IcSubs = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.2 4h15.6c.7 0 1.2.5 1.2 1.2v10.6c0 .7-.5 1.2-1.2 1.2H11l-4.4 3.4V17H4.2c-.7 0-1.2-.5-1.2-1.2V5.2C3 4.5 3.5 4 4.2 4z" />
    <path d="M7 9.4h4.2M13.8 9.4H17M7 12.8h6.6M16 12.8h1" />
  </svg>
);

/* A track's name for the Audio box. Accepts both track shapes: hls.js renditions ({name, lang})
 * and native AudioTrack ({label, language}).
 *
 * THE LANGUAGE IS NAMED THE WAY THE SOURCES BELOW IT ARE — "Русский", not "Russian" — through the
 * same `langName`, after `normalizeSubLang` has turned "rus" / "ru-RU" into "ru". A title the file
 * gives its own track ("Commentary", "Dub · Studio") wins over that, since it says more. A track
 * tagged with no language at all ("und", which is what most rips carry) answers '' — the box then
 * names it by what this playback is in, or "Track 2". */
const NO_LANG = ['', 'und', 'mul', 'zxx', 'mis'];
function audioName(a: { name?: string; lang?: string; label?: string; language?: string }, _i: number): string {
  const tag = (a.lang || a.language || '').toLowerCase().replace(/_/g, '-').split('-')[0].trim();
  const code = NO_LANG.includes(tag) ? '' : normalizeSubLang(tag).code;
  const own = (a.name || a.label || '').trim();
  if (own && !NO_LANG.includes(own.toLowerCase()) && own.toLowerCase() !== tag && !/^audio ?\d*$/i.test(own)) return own;
  return code ? langName(code) : '';
}
function levelLabel(l: { height?: number; width?: number; bitrate?: number }): string {
  const eq = Math.max(l.height || 0, l.width ? Math.round((l.width * 9) / 16) : 0);
  if (eq >= 1900) return '2160p'; if (eq >= 1300) return '1440p'; if (eq >= 900) return '1080p';
  if (eq >= 650) return '720p'; if (eq >= 400) return '480p'; if (eq >= 300) return '360p';
  if (eq > 0) return '240p'; return l.bitrate ? Math.round(l.bitrate / 1000) + 'k' : '?';
}
/* Every spelling of a language an audio rendition might be tagged with: ISO-639-1, both
 * 639-2 forms, the English name and the endonym. A track arrives as "rus", "ru-RU",
 * "Russian" or "Русский" depending on who muxed it, and all four have to hit.
 *
 * MATCHING IS AGAINST THIS SET, NEVER A SUBSTRING OF THE CODE. The previous rule was
 * `new RegExp(pref, 'i').test(name + ' ' + lang)`, i.e. the bare two-letter code tested as
 * a free substring — so the default preference 'en' matched "French", "Slovenian" and
 * "Danish" before it reached "English", and asking for English handed you whichever of
 * those the muxer happened to list first. Tags match on the base subtag; names match on a
 * whole word. */
const LANG_ALIASES: Record<string, string[]> = {
  en: ['en', 'eng', 'english'],
  ru: ['ru', 'rus', 'russian', 'русский'],
  ka: ['ka', 'kat', 'geo', 'georgian', 'ქართული'],
  uk: ['uk', 'ukr', 'ukrainian', 'українська'],
  de: ['de', 'ger', 'deu', 'german', 'deutsch'],
  fr: ['fr', 'fre', 'fra', 'french', 'français', 'francais'],
  es: ['es', 'spa', 'spanish', 'español', 'espanol', 'castellano', 'latino'],
  it: ['it', 'ita', 'italian', 'italiano'],
  pt: ['pt', 'por', 'portuguese', 'português', 'portugues', 'brazilian'],
  ja: ['ja', 'jpn', 'jap', 'japanese', '日本語'],
  ko: ['ko', 'kor', 'korean', '한국어'],
  zh: ['zh', 'chi', 'zho', 'cmn', 'chinese', 'mandarin', '中文'],
  ar: ['ar', 'ara', 'arabic', 'العربية'],
  hi: ['hi', 'hin', 'hindi', 'हिन्दी'],
  tr: ['tr', 'tur', 'turkish', 'türkçe', 'turkce'],
  pl: ['pl', 'pol', 'polish', 'polski'],
  nl: ['nl', 'dut', 'nld', 'dutch', 'nederlands'],
  id: ['id', 'ind', 'indonesian', 'bahasa indonesia'],
  ms: ['ms', 'may', 'msa', 'malay', 'melayu'],
  th: ['th', 'tha', 'thai', 'ไทย'],
  vi: ['vi', 'vie', 'vietnamese', 'tiếng việt'],
  he: ['he', 'heb', 'hebrew', 'עברית'],
  sv: ['sv', 'swe', 'swedish', 'svenska'],
  da: ['da', 'dan', 'danish', 'dansk'],
  no: ['no', 'nor', 'nob', 'norwegian', 'norsk'],
  fi: ['fi', 'fin', 'finnish', 'suomi'],
  cs: ['cs', 'cze', 'ces', 'czech', 'čeština'],
  el: ['el', 'gre', 'ell', 'greek', 'ελληνικά'],
  ro: ['ro', 'rum', 'ron', 'romanian', 'română'],
  hu: ['hu', 'hun', 'hungarian', 'magyar'],
};
const langAliases = (code: string): string[] => LANG_ALIASES[code.toLowerCase()] || [code.toLowerCase()];

/** Does this audio rendition carry `code`? `lang` is compared on its base subtag
 *  (`ru-RU` → `ru`); `name` is compared on whole words, so "French" cannot answer for
 *  "en" and "Latino" cannot be found inside some unrelated release string. */
function trackIsLang(t: { name?: string; lang?: string; label?: string; language?: string }, code: string): boolean {
  const aliases = langAliases(code);
  const tag = (t.lang || t.language || '').toLowerCase().replace(/_/g, '-').split('-')[0].trim();
  if (tag && aliases.includes(tag)) return true;
  const name = (t.name || t.label || '').toLowerCase().trim();
  if (!name) return false;
  return aliases.some((a) => new RegExp(`(^|[^\\p{L}])${a}($|[^\\p{L}])`, 'u').test(name));
}

/** Index of the first rendition in `code`, or -1. 'original'/'' → -1 (leave the stream's
 *  own default alone, which is what "Original" means). */
function pickAudioTrack(tracks: Array<{ name?: string; lang?: string; label?: string; language?: string }>, code: string): number {
  if (!code || code === 'original') return -1;
  return tracks.findIndex((t) => trackIsLang(t, code));
}

function applyAudioPref(hls: HlsInstance, pref: string) {
  const i = pickAudioTrack(hls.audioTracks || [], pref);
  if (i >= 0 && hls.audioTrack !== i) { try { hls.audioTrack = i; } catch { /* ignore */ } }
}

/* Native (progressive mp4/mkv/webm) playback has its own track list, and it is NOT
 * hls.js's. `HTMLMediaElement.audioTracks` is implemented by Safari, iOS and the WebKit-
 * derived TV browsers (Tizen, webOS) — where the TV build actually runs — and is absent
 * in Chrome, Edge and Firefox, which expose no way to enumerate or switch the audio
 * tracks of a progressive file at all. Where it is missing a multi-audio release plays
 * whichever track the container marks default and no web player can do better; the menu
 * simply stays empty rather than offering a switch that would do nothing. */
interface NativeAudioTrack { id?: string; kind?: string; label?: string; language?: string; enabled: boolean }
interface NativeAudioTrackList { length: number; [i: number]: NativeAudioTrack; onchange?: ((this: unknown, ev: Event) => void) | null }
const nativeAudioTracks = (v: HTMLVideoElement): NativeAudioTrackList | null => {
  const l = (v as unknown as { audioTracks?: NativeAudioTrackList }).audioTracks;
  return l && typeof l.length === 'number' ? l : null;
};
const nativeAudioList = (l: NativeAudioTrackList): NativeAudioTrack[] => Array.from({ length: l.length }, (_, i) => l[i]);

/* Core video player — reproduces the #playerOverlay markup/classes (so app.css
 * styles it) with HLS.js + native playback and the essential controls: play/pause,
 * scrubber (buffered + played + tooltip), ±10s, volume/mute, time, speed, quality
 * (HLS levels), subtitles, PiP, fullscreen, keyboard, and auto-hide chrome.
 *
 * On touch devices a full-frame gesture surface adds phone controls: tap to
 * toggle chrome, double-tap the left/right third to seek ±10s (accumulating),
 * vertical drag for volume (right half) / brightness (left half), and a
 * horizontal drag to scrub — mirroring the native mobile players. */

/* PLAY AND PAUSE, WITH ROUNDED CORNERS — the two glyphs that get drawn biggest and looked at
 * hardest, so they are the two worth building properly.
 *
 * The old pair were the geometric primitives every player ships with: `M8 5v14l11-7z` and two
 * plain rects. At 18px beside a cursor that is fine. Blown up into a 60px disc on a television
 * the triangle's point becomes a needle and the bars' corners become four hard right angles, and
 * the whole control reads as clip-art next to type that is rounded and a disc that is a circle.
 *
 * THE TRIANGLE IS ROUNDED BY STROKING ITS OWN PATH. `stroke-linejoin: round` with the stroke
 * painted in the same ink as the fill turns each vertex into an arc of half the stroke width —
 * one path, no arc maths, and it stays correct at any size because the radius scales with the
 * viewBox. The path is inset to compensate: a 3-wide stroke straddles the edge, adding 1.5 all
 * round, so the geometry is drawn 1.5 smaller than the space it should occupy.
 *
 * The bars are `rx` on a rect, which is the honest way to say the same thing.
 *
 * THE TRIANGLE'S OPTICAL OFFSET LIVES IN THE PATH, not in a margin on the element. It used to be
 * `margin-left: 6%` on the <svg> in tv.css, applied on top of a path that was ALREADY sitting
 * right of centre in its own viewBox — two corrections for one problem, which is why the glyph
 * read as parked against the right of the disc. Here the box is centred (8.3 → 16.9 about 12.6)
 * and carries the whole nudge itself: half a unit, because a triangle's mass is toward its base
 * and geometric centring leaves it looking as though it has slipped left. Anything positioning
 * this glyph can now simply centre it. */
const IcPlay = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M8.3 6.8 16.9 12 8.3 17.2Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
);
const IcPause = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <rect x="6.2" y="4.8" width="4.2" height="14.4" rx="1.7" />
    <rect x="13.6" y="4.8" width="4.2" height="14.4" rx="1.7" />
  </svg>
);
// a single checkable option row (OptRow, below) is what every menu section is built from
const IcMute = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M18.5 6a7 7 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
/* The TV's settings button. A cogwheel is a fiddly shape at three metres — a lot of small teeth
 * that turn to mush once a set scales the frame — and it also names a category ("machine
 * settings") narrower than what the menu now holds. Three dots read at any distance and mean
 * "more", which is the whole menu. */
const IcMore = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>;
const IcPip = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 5h18v14H3V5zm2 2v10h14V7H5zm6 4h7v5h-7v-5z" /></svg>;
/* Audio track: a speaker with stacked bars — deliberately NOT the volume speaker (which has
 * arcs) and not a musical note, which reads as "music" rather than "spoken language". */
const IcAudioTrack = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M3 9v6h3.6L11 18.8V5.2L6.6 9H3z" />
    <rect x="13.6" y="7" width="1.8" height="10" rx=".9" />
    <rect x="17" y="9.2" width="1.8" height="5.6" rx=".9" />
    <rect x="20.4" y="10.8" width="1.8" height="2.4" rx=".9" />
  </svg>
);
const IcFs = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm12 0h2v5h-5v-2h3v-3z" /></svg>;

// gesture-HUD glyphs: double-chevron seek ripples + volume/brightness meters
const IcRew = <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M11 6l-6 6 6 6V6zm8 0l-6 6 6 6V6z" /></svg>;
const IcFF = <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M13 6l6 6-6 6V6zM5 6l6 6-6 6V6z" /></svg>;
const IcVolHud = <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const IcVolMuteHud = <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const IcSun = <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/* A REMOTE HAS NO SLIDER. The two enhance controls are `<input type=range>` on the web, which is
 * the right control for a mouse and an unusable one for a D-pad: arrows nudge it by one step, and
 * nothing moves focus back OUT of it. On the TV they become four presets each — the same list
 * shape as every other menu section, so the same one press picks one. */
const TV_GRAIN = [0, 0.08, 0.18, 0.3];
const TV_CLARITY = [0, 0.25, 0.5, 0.85];
const TV_LEVEL_KEYS = ['menu.off', 'menu.low', 'menu.medium', 'menu.high'];

/* The ⋯ box's sections, in the order it lists them: set-and-forget last. Quality / source is
 * listed whether or not the stream offers more than one level — a list whose LENGTH depends on the
 * release means the row under the remote changes identity between one title and the next, and
 * muscle memory is worth more than a saved line. (Subtitles has its own button and box.) */
const MORE_SECS = [
  { key: 'speed', i18n: 'menu.speed' },
  { key: 'quality', i18n: 'menu.quality' },
  { key: 'enhance', i18n: 'menu.enhance' },
] as const;
type MoreSec = typeof MORE_SECS[number]['key'];

const qualClass = (q: string) => (q === '4K' ? 'q-4k' : q === '1080p' ? 'q-1080' : 'q-720');
/** One source, the same one however many times the title screen re-ranks its list. */
const srcKey = (x: AddonStream) => `${x.source}|${x.infoHash || x.url}|${x.fileIdx ?? ''}`;

/* ---- TEN FEET AWAY: WHAT THE REMOTE DOES ---------------------------------------------------
 * The player has two modes on a TV and exactly one thing moves between them.
 *
 *   TRANSPORT (default). The chrome is down or merely showing, and nothing in it holds focus.
 *   Left/Right seek, OK plays and pauses, the remote's own ▶ ⏸ ⏪ ⏩ do what they say. This is
 *   what someone watching a film wants from a remote 95% of the time and it must cost zero
 *   presses to reach — so it is where the player starts and where it returns.
 *
 *   CONTROLS. Up or Down summons the bar and hands the D-pad to TvSpatialNav (via the `tv-nav`
 *   class it watches for), which walks the buttons, the gear menu, the subtitle and quality
 *   lists and the episode panel as ordinary focus targets. Back steps out again — one layer at
 *   a time, through the menu and the panel first, exactly like every other overlay in the app.
 *
 * SEEKING IS PREVIEWED, NOT APPLIED. A remote autorepeats, and setting `currentTime` on every
 * repeat asks the demuxer to re-seek ten times a second — on a TV that is a black screen and a
 * spinner for as long as the button is held. So presses accumulate into a PREVIEW position that
 * only the scrubber knows about, and the seek happens once, ~half a second after the last press.
 * Holding the button also lengthens the step (10s → 30s → 60s), because crossing forty minutes
 * of a film ten seconds at a time is not something anyone should have to sit through. */
const TV_SEEK_COMMIT_MS = 550;  // FALLBACK only — stillness that ends a scrub on a remote that never reports a release
const TV_SEEK_REPEAT_MS = 400;  // gap under which two presses count as "held"
const TV_SEEK_RELEASE_MS = 150; // grace after a key-up before the scrub commits (see tvSeekRelease)
const TV_SEEK_TAP = 10;         // one deliberate press, in seconds of film
const TV_RAMP_V0 = 45;          // seconds of film per second at the instant a hold takes over
const TV_RAMP_GROWTH = 3.2;     // and how that rate multiplies per further second of holding
const TV_HIDE_MS = 5000;        // chrome auto-hide — longer than the desktop's 3s; reading is slower from a sofa

/* THE SKIP PROMPTS COUNT DOWN, in seconds of PLAYBACK — the fill pauses with the film. */
const SKIP_SHOW_S = 10;         // Skip Intro / Skip Recap fills, then steps aside
const NEXT_COUNT_S = 10;        // Next Episode fills, then starts the next episode


/* The tick sits at the row's far end, after the label — where the big apps put it. A row with a
 * list behind it (`drill`) ends in a chevron, and carries `dataKey` so the box can hand focus back
 * to it when the viewer steps back out of that list. */
function OptRow({ on, label, sub, drill, dataKey, onClick }: { on: boolean; label: string; sub?: string; drill?: boolean; dataKey?: string; onClick: () => void }) {
  return (
    <div className={`vp-opt${drill ? ' vp-opt-sub' : ''}${on ? ' on' : ''}`} role="menuitemradio" aria-checked={on} tabIndex={0} data-key={dataKey}
      onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <span className="lbl">{label}</span>{sub ? <span className="sub">{sub}</span> : null}<span className="ck" aria-hidden="true">{on ? '✓' : ''}</span>
      {drill && <span className="chev" aria-hidden="true" />}
    </div>
  );
}

/** The icon row's own buttons, in row order — not the rows of a popup hanging off one of them. */
function rowIcons(root: HTMLElement | null): HTMLElement[] {
  const row = root?.querySelector<HTMLElement>('.vp-bottom .vp-controls');
  if (!row) return [];
  return Array.from(row.querySelectorAll<HTMLElement>('.vp-icon'))
    .filter((el) => !el.closest('.vp-menu') && el.tabIndex >= 0 && el.getClientRects().length > 0);
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(ss).padStart(2, '0')}`;
}

interface Level { i: number; height?: number }

/* A subtitle track the user COULD pick, not one that has been fetched. `url` is the
 * add-on's own (SRT, often gzipped, frequently on a host with no CORS); it becomes
 * playable only after `toVttBlobUrl`. `source` is the add-on's name, shown as the row's
 * second line so two identical "English" rows are still telling the user something. */
interface SubCandidate { lang: string; label: string; url: string; source?: string }

/* A <track> TAKEN OUT WHILE IT IS SHOWING LEAVES ITS LINE ON THE PICTURE. Chrome does not repaint the
 * cue display when the element is removed, so the old line stays under the new one — one more per
 * episode, source or file swap. Switching the outgoing track off first clears it; called before
 * every setVtt that replaces or drops the mounted track (`keep` = the url staying mounted). */
/* One subtitle line as the player draws it: the cue's own markup (<i>, <b>…, built by the browser's
 * `getCueAsHTML`, which makes nothing but text and those few tags) and whether the file asked for it
 * at the TOP — a sign or an on-screen caption, as VTT `line` or as the `{\an8}` tag SRT files carry.
 * Those tags are taken out of the text either way: printed, they read as "{\an8}". */
interface CueLine { html: string; top: boolean }
const ASS_TAG = /\{\\[^}]*\}/g;
function cueLine(c: VTTCue): CueLine {
  const an = /\{\\an([1-9])\}/.exec(c.text)?.[1];
  const top = an ? +an >= 7 : typeof c.line === 'number' && (c.snapToLines ? c.line >= 0 && c.line < 4 : c.line < 40);
  const d = document.createElement('div');
  d.appendChild(c.getCueAsHTML());
  return { html: d.innerHTML.replace(ASS_TAG, ''), top };
}

function retireTrack(v: HTMLVideoElement | null, keep?: string) {
  const el = v?.querySelector('track');
  if (el && el.getAttribute('src') !== keep) el.track.mode = 'disabled';
}

export default function VideoPlayer() {
  const t = useT();
  const source = usePlayer((s) => s.source);
  const close = usePlayer((s) => s.close);
  const parked = usePlayer((s) => s.parked);
  const park = usePlayer((s) => s.park);
  const record = useHistory((s) => s.record);
  const putProgress = useHistory((s) => s.putProgress);
  const getResume = useHistory((s) => s.getResume);
  const flush = useHistory((s) => s.flush);
  const settings = useSettings((s) => s.settings);
  const updateSettings = useSettings((s) => s.update);
  const kernelRef = useRef<SVGFEConvolveMatrixElement>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const recordedRef = useRef(false);   // record watch-history once per opened source
  const lastProgRef = useRef(0);       // throttle progress writes
  const resumedRef = useRef(false);    // seek-to-resume once per source
  /* Has this source ever actually rendered? It is what tells a decode failure that means "this
   * browser cannot play the file" from one that means "something went wrong twenty minutes in" —
   * see the <video>'s onError. */
  const startedRef = useRef(false);
  const audioPrefDone = useRef(false); // audio-language preference applied once per source
  const subPicked = useRef(false);     // the USER chose a subtitle → stop applying the preference
  const subMemo = useRef<SubPick | null>(null); // what the viewer last picked for this TITLE (lib/subtitles)
  const vttCache = useRef(new Map<string, string>()); // add-on subtitle url → converted blob: url
  const demuxRef = useRef<DemuxHandle | null>(null); // in-page demuxer, when one is driving playback
  const wasmRef = useRef<WasmAudioHandle | null>(null); // in-page Dolby/DTS decoder, likewise

  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [levels, setLevels] = useState<Level[]>([]);
  const [curLevel, setCurLevel] = useState(-1);
  const [loading, setLoading] = useState(true);
  // null = no error; 'source' = stream host unreachable (network/manifest — try another
  // source); 'codec' = file loaded but the browser can't decode it (mkv/AC3…)
  const [errKind, setErrKind] = useState<null | 'source' | 'codec'>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [currentSub, setCurrentSub] = useState(-1); // -1 = subtitles off
  const [audioTracks, setAudioTracks] = useState<Array<{ i: number; name: string }>>([]);
  const [curAudio, setCurAudio] = useState(0);
  /* THE BOX'S SECOND LEVEL. Every box opens on a short list — subtitle languages, audio languages,
   * the ⋯ sections — and a row with more behind it opens that list in the same box. This is the key
   * of the row that was opened (a language code, or a ⋯ section); null is the box's first list. */
  const [boxLevel, setBoxLevel] = useState<string | null>(null);
  const levelFrom = useRef<string | null>(null); // the row just stepped back out of, for focus
  const [fs, setFs] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  /* Every subtitle track OFFERED for this source — the ones embedded in the stream plus
   * everything the installed subtitle add-ons answered. URLs only; see the block above
   * `resolveSub` for why exactly one of these is ever downloaded. */
  const [subs, setSubs] = useState<SubCandidate[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);   // add-ons still being asked
  const [subFailed, setSubFailed] = useState(false);       // the chosen track would not load
  const [subBad, setSubBad] = useState<Set<string>>(() => new Set()); // auto-picked urls that would not load
  // the one track currently converted to VTT and mounted as a <track>; null = none showing
  const [vtt, setVtt] = useState<{ lang: string; label: string; url: string } | null>(null);
  const [epPanelOpen, setEpPanelOpen] = useState(false);
  /* TWO STATES FOR ONE SHELF, because a CSS transition needs both ends of it to exist.
   *
   *   railMounted  the rail is in the DOM. Goes true with `epPanelOpen` and stays true for the
   *                length of the slide-down after it goes false — an unmounted element does not
   *                animate, which is why closing it used to blink out of existence while the
   *                control bar slid gracefully back down without it.
   *   railShown    the rail is UP. Held back one animation frame on opening, because a
   *                transition with no previous frame to interpolate from does not run at all: the
   *                shelf would appear already in place. It also drives the overlay's `tv-rail`
   *                class, so the bar's lift and the shelf's rise begin on the SAME frame —
   *                driving them from different states is what made the two look uncoordinated. */
  const [railMounted, setRailMounted] = useState(false);
  const [railShown, setRailShown] = useState(false);
  const [segments, setSegments] = useState<Segments | null>(null);
  const [silent, setSilent] = useState(false); // playing video, decoding no audio at all
  const [audioOpen, setAudioOpen] = useState(false); // the audio-track popup
  /* WHICH DOOR OPENED THE SETTINGS SHEET. Two buttons in the row lead to it: Subtitles, which opens
   * it on the subtitle list, and ⋯, which opens it on everything else (speed first). One sheet,
   * two starting sections — and Back hands the remote to whichever button it came from. */
  const [menuDoor, setMenuDoor] = useState<'subs' | 'more'>('more');
  const [logoFailed, setLogoFailed] = useState(false); // the wordmark would not load → text title
  const [logoReady, setLogoReady] = useState(false);   // decoded, so its entrance can play on a real picture

  /* ---- POST-PLAY: the credits shrink into the corner and the next thing to watch takes over -----
   * Two states, because the screen has to be READY before it is SHOWN: `ppArmed` mounts it a few
   * minutes before the end so its recommendations and trailers resolve while the film is still on,
   * `ppOpen` is the takeover itself. Only for a film, or a series with no next episode to roll
   * into — an episode with a next one keeps the Next Episode button, as it always did. */
  const [ppArmed, setPpArmed] = useState(false);
  const [ppOpen, setPpOpen] = useState(false);
  const ppOpenRef = useRef(false);
  /* "Back to credits" was chosen: the viewer wants the names, so post-play stays out of the way
   * until the film actually ends. */
  const ppDismissed = useRef(false);
  /* The film's own `muted`, held while a trailer has the sound — null when nothing is ducked. */
  const ppDucked = useRef<boolean | null>(null);
  const detector = useRef<CreditsDetector | null>(null);
  const detectorBlocked = useRef(false);
  useEffect(() => { ppOpenRef.current = ppOpen; }, [ppOpen]);
  /* The credits keep their corner for PP_MINI_MS, then fade away (see the effect by backToCredits). */
  const [ppMiniGone, setPpMiniGone] = useState(false);

  // --- TV remote (see "TEN FEET AWAY" above; all of this is dropped from the web build) ---
  const [tvNav, setTvNav] = useState(false);              // the D-pad is driving the chrome
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [landed, setLanded] = useState(false);            // the half-second after a scrub commits
  const [ramping, setRamping] = useState(false);          // a held button is driving the preview continuously
  const tvNavRef = useRef(false);                         // fresh read from bump()'s timer
  const seekPreviewRef = useRef<number | null>(null);     // fresh read from the key handler
  const seekCommitTimer = useRef<number | undefined>(undefined);
  const landedTimer = useRef<number | undefined>(undefined);
  const lastScrubAt = useRef(0);                          // when a scrub last committed (prompt focus waits it out)
  const seekReleaseTimer = useRef<number | undefined>(undefined);
  const seekHoldDir = useRef<0 | 1 | -1>(0);              // which way the held button is pulling
  const rampRaf = useRef(0);
  const rampVel = useRef(0);                              // seconds of film per second, right now
  const rampAt = useRef(0);                               // timestamp of the last ramp frame
  const rampPaint = useRef(0);                            // timestamp of the last state write
  const seekLastAt = useRef(0);
  /* Where the bar should re-seed focus when a layer above it closes. 'scrubber' is distinct
   * from 'bar': 'bar' is "no opinion, use the usual order" (which prefers a visible Skip
   * Intro button), while 'scrubber' means the viewer stepped UP out of the episode rail and
   * the timeline is the thing they stepped up FROM — landing them on Skip Intro instead
   * would move them sideways for no reason they asked for. */
  const tvWantFocus = useRef<'bar' | 'scrubber' | 'gear' | 'subs' | 'audio' | 'episodes'>('bar'); // where the bar should re-seed focus
  // The icon the remote last stood on in the row, so Up from the scrubber goes back to it.
  const rowLast = useRef('');
  const railFrom = useRef<'bar' | 'button'>('button'); // which door opened the episode rail
  /* Something is open ON TOP of the control bar and is being read. The auto-hide consults this
   * rather than the three states directly, because it fires from a timer closed over on mount and
   * would otherwise need re-arming on every one of them. */
  const uiBusyRef = useRef(false);
  // `exitTvNav` is defined below `bump`, and `bump`'s timer has to call it. A ref rather than
  // reordering the two: they genuinely depend on each other, and this is the seam.
  const exitTvNavRef = useRef<() => void>(() => {});
  useEffect(() => { tvNavRef.current = tvNav; }, [tvNav]);

  // --- mobile touch gestures ---
  // enabled only where the primary pointer is coarse (phones/tablets), so the
  // gesture surface never eats mouse clicks on hybrid laptops.
  const [isTouch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);
  const [webkitPip, setWebkitPip] = useState(false); // iPad/iOS per-video PiP
  const [bright, setBright] = useState(1);            // 1 = full; web can't set device brightness so we dim the frame
  const [seekHud, setSeekHud] = useState<{ side: 'left' | 'right'; secs: number } | null>(null);
  // `note` is the one-line caption under the meter — only iOS uses it, to say where volume went
  const [vHud, setVHud] = useState<{ kind: 'vol' | 'bright'; val: number; note?: string } | null>(null);
  const hideUiRef = useRef(false);                    // fresh read for deferred single-tap
  /* When a tap outside a menu closed it. The single-tap timer consults this so the same tap does
   * not ALSO hide the chrome 280ms later — closing a sheet is not a request to lose the bar. */
  const menuClosedAt = useRef(0);
  const gestRef = useRef({ active: false, x0: 0, y0: 0, t0: 0, w: 1, h: 1, mode: '' as '' | 'seek' | 'vol' | 'bright', startVol: 1, startBright: 1, startTime: 0 });
  const lastTapRef = useRef({ t: 0, x: 0, side: '' as '' | 'left' | 'center' | 'right' });
  /* ZOOM TO FILL, the phone apps' pinch: spread two fingers and the picture fills the screen, cropping
   * its edges (object-fit: cover); pinch them together and the whole picture comes back. Kept for the
   * rest of the session, like the apps do. `d0` is the fingers' distance when the pinch began, 0 when
   * there is none. */
  const [fill, setFill] = useState(false);
  const [zoomHud, setZoomHud] = useState<string | null>(null);
  const zoomHudTimer = useRef<number | undefined>(undefined);
  const pinchRef = useRef({ d0: 0, ratio: 1 });
  const seekAccumRef = useRef<{ side: '' | 'left' | 'right'; secs: number }>({ side: '', secs: 0 });
  const singleTapTimer = useRef<number | undefined>(undefined);
  const seekHudTimer = useRef<number | undefined>(undefined);
  const vHudTimer = useRef<number | undefined>(undefined);
  useEffect(() => { hideUiRef.current = hideUi; }, [hideUi]);

  /* RESOLVE BEFORE ATTACHING. A progressive file goes to the local streaming server first
   * to be re-served as HLS when that would gain anything — several audio tracks to choose
   * between, a codec this browser cannot decode, a container it will not open. See
   * lib/streamingServer.ts. Costs one probe, and only when a server is actually running;
   * every failure path falls back to the original URL, so this can only improve on direct
   * playback. `playSrc` gates the attach effect below, which is what keeps the element
   * from loading the raw URL first and swapping under itself. */
  const [playSrc, setPlaySrc] = useState<{ url: string; kind: 'hls' | 'url'; via: boolean } | null>(null);
  useEffect(() => {
    if (!source) { setPlaySrc(null); return; }
    const ctrl = new AbortController();
    let alive = true;
    setPlaySrc(null); setLoading(true); setErrKind(null); setSilent(false);
    resolvePlayback(source.url, source.kind, ctrl.signal, source.notWebReady)
      .then((r) => { if (alive) setPlaySrc(r); })
      .catch(() => { if (alive) setPlaySrc({ url: source.url, kind: source.kind || 'url', via: false }); });
    return () => { alive = false; ctrl.abort(); };
  }, [source]);

  // attach the source (HLS via hls.js, else native)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !source || !playSrc) return;
    let cancelled = false;
    recordedRef.current = false; resumedRef.current = false; lastProgRef.current = 0; startedRef.current = false;
    setLoading(true); setErrKind(null); setPlaying(false); setCur(0); setDur(0); setBuffered(0); setLevels([]); setCurLevel(-1); setMenuOpen(false); setAudioOpen(false); setHideUi(false); setAudioTracks([]); setCurAudio(0); setEpPanelOpen(false); setBright(1); setSeekHud(null); setVHud(null); seekAccumRef.current = { side: '', secs: 0 };
    setTvNav(false); setSeekPreview(null); seekPreviewRef.current = null; window.clearTimeout(seekCommitTimer.current);
    setLanded(false); window.clearTimeout(landedTimer.current);
    const url = playSrc.url;
    // Prefer hls.js for any HLS source. DON'T gate on canPlayType('…mpegurl'):
    // modern Chrome returns "maybe" for that MIME type yet CANNOT actually play HLS
    // (no native demuxer) — trusting it sent every HLS stream down the native path and
    // stalled on a black screen. Native HLS is only a fallback for Safari/iOS, where
    // hls.js reports isSupported()===false.
    const isHls = playSrc.kind === 'hls' || isHlsUrl(url);
    const canNativeHls = !!v.canPlayType('application/vnd.apple.mpegurl');
    /* The language THIS playback was asked for beats the standing preference. `source.lang`
     * is the bucket the user clicked in the detail modal — an explicit, per-title choice —
     * and `settings.audioLang` is the default for when they made none. Applied once per
     * source (the ref), so a manual pick from the audio menu is never overwritten by a
     * later `hlsAudioTracksUpdated`. */
    const wantLang = source.lang || settings.audioLang;
    audioPrefDone.current = false;

    if (isHls) {
      loadHls().then((Hls) => {
        if (cancelled || !v) return;
        if (Hls && Hls.isSupported()) {
          /* Buffer ahead (and keep a back-buffer) so rewinds / short forward-seeks land in
           * already-loaded video instead of stalling and snapping back; generous manifest/level
           * timeouts for slow add-on hosts.
           *
           * THE BUFFER NUMBERS ARE A TV BUDGET NOW, NOT A DESKTOP ONE. They were 600s forward and
           * 180s back, which on a set with a few hundred MB of headroom is not a buffer, it is an
           * out-of-memory report waiting to be filed: at a 6 Mbps stream 600s is ~450 MB of
           * demuxed fMP4 held live, and the pressure lands as decode stutter long before it lands
           * as a crash. 120/60 still covers every seek the remote can actually make — the bar
           * skips in tens of seconds — and is what the browser is asked to hold at once.
           *
           * capLevelToPlayerSize IS THE OTHER HALF, and the more important one. Without it ABR
           * climbs the ladder on bandwidth alone: a 4K rendition would be fetched, demuxed and
           * DECODED to be painted into a 1080p panel, which is the single most expensive thing
           * this player can be asked to do and buys nothing anyone can see. With it the ladder is
           * capped by the element's real painted size, so a 1080p set decodes 1080p. */
          const hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 120,
            backBufferLength: 60,
            capLevelToPlayerSize: true,
            manifestLoadingTimeOut: 20000,
            levelLoadingTimeOut: 20000,
          });
          hlsRef.current = hls;
          // Recover from fatal-but-recoverable errors instead of stalling forever on
          // the loading spinner — the #1 reason some add-on streams never started.
          const fail = () => { try { hls.destroy(); } catch { /* ignore */ } setLoading(false); setErrKind('source'); };
          let fragTries = 0, mediaTries = 0;
          hls.on('hlsError', (...a: unknown[]) => {
            const data = a[1] as { fatal?: boolean; type?: string; details?: string } | undefined;
            if (!data || !data.fatal) return;
            const d = data.details || '';
            // A playlist that can't be fetched/parsed (upstream 403, expired token, dead
            // host) is terminal — startLoad() only resumes FRAGMENT loading, not the
            // manifest, so retrying here just hangs on a black screen. Surface it.
            if (/manifestLoad|manifestParsing|manifestIncompatible|levelLoad|levelEmpty|noLevelsAvailable/i.test(d)) { fail(); return; }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              if (fragTries++ >= 3) { fail(); return; }   // fragments keep failing → give up
              try { hls.startLoad(); } catch { fail(); }
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              if (mediaTries++ >= 2) { fail(); return; }
              try { hls.recoverMediaError(); } catch { fail(); }
            } else { fail(); }
          });
          hls.loadSource(url);
          hls.attachMedia(v);
          hls.on('hlsManifestParsed', () => {
            setLevels(hls.levels.map((l, i) => ({ i, height: l.height })));
            // apply the preferred-quality setting (else stay on auto)
            const pref = settings.autoQuality;
            if (pref !== 'best') {
              const want = pref === '4k' ? 2160 : 1080;
              let best = -1, bestH = -1;
              hls.levels.forEach((l, i) => { const h = l.height ?? 0; if (h <= want && h > bestH) { bestH = h; best = i; } });
              if (best >= 0) hls.currentLevel = best;
            }
            // audio renditions + preferred audio language (a single one is still listed, by name)
            if (hls.audioTracks && hls.audioTracks.length > 0) {
              if (!audioPrefDone.current) { applyAudioPref(hls, wantLang); audioPrefDone.current = true; }
              setAudioTracks(hls.audioTracks.map((a, i) => ({ i, name: audioName(a, i) })));
              setCurAudio(hls.audioTrack);
            }
            v.play().catch(() => {});
          });
          hls.on('hlsLevelSwitched', () => setCurLevel(hls.currentLevel));
          hls.on('hlsAudioTrackSwitched', () => setCurAudio(hls.audioTrack));
          /* Renditions can land AFTER manifest-parsed (a demuxed-alternate-audio manifest
           * publishes its list on the first fragment), which is why the preference is
           * applied here too and not only above — otherwise the pick silently no-opped on
           * exactly the multi-audio streams it exists for. `audioPrefDone` keeps it to one
           * application per source so it can't stomp a manual choice from the menu. */
          hls.on('hlsAudioTracksUpdated', () => {
            if (hls.audioTracks && hls.audioTracks.length > 0) {
              if (!audioPrefDone.current) { applyAudioPref(hls, wantLang); audioPrefDone.current = true; }
              setAudioTracks(hls.audioTracks.map((a, i) => ({ i, name: audioName(a, i) })));
              setCurAudio(hls.audioTrack);
            }
          });
        } else if (canNativeHls) {
          // Safari / iOS: real native HLS playback.
          v.src = url; v.play().catch(() => {});
        } else {
          setLoading(false); setErrKind('source');
        }
      });
    } else {
      /* PROGRESSIVE FILE. Straight to <video> is the fast path and the wrong one when the
       * file has more than one audio track, because the element will play whichever the
       * muxer marked default and offer no way to change it. `playDemuxed` opens the
       * container in the page instead and feeds MediaSource one track at a time, which is
       * the only route to audio-track switching that needs nothing installed.
       *
       * ONLY WHEN IT BUYS SOMETHING. One audio track, or a codec no browser decodes
       * (AC-3/DTS), and demuxing gains nothing — so the element gets the URL as before and
       * pays none of the cost. Any failure falls back the same way: this can start
       * playback that would otherwise be in the wrong language, and can never prevent
       * playback that would otherwise have worked. */
      void (async () => {
        const probe = await probeUrl(url).catch(() => ({ ok: false as const, reason: 'unreadable' as const }));
        if (cancelled) return;
        if (!probe.ok) {
          /* DOLBY / DTS — the one blocker with an answer. Everything else falls through to
           * direct playback as before; only this case is worth 32 MB of decoder, and only
           * once the file is already open and known to need it. Failure falls back to the
           * same direct playback, so the worst case is what happened before. */
          const wasm = probe.reason === 'undecodable-audio'
            && probe.tracks?.find((t) => needsWasmDecoder(t.codec));
          if (wasm) {
            try {
              setLoading(true);
              const pick = probe.tracks!.findIndex((t) => trackIsLang({ lang: t.language }, wantLang));
              const h = await playWithWasmAudio(v, url, pick >= 0 ? pick : 0,
                (m) => { if (import.meta.env.DEV) console.info('[wasm-audio]', m); });
              if (cancelled) { void h.destroy(); return; }
              wasmRef.current = h;
              setAudioTracks(h.tracks.map((t) => ({ i: t.index, name: audioName({ lang: t.language }, t.index) })));
              setCurAudio(pick >= 0 ? pick : 0);
              audioPrefDone.current = true;
              v.play().catch(() => {});
              return;
            } catch (e) {
              if (import.meta.env.DEV) console.info('[wasm-audio] falling back:', (e as Error).message);
            }
          }
          // ONE TRACK: nothing to switch, but the Audio box can still say which language it is.
          if (probe.reason === 'single-track' && probe.tracks?.length) {
            setAudioTracks(probe.tracks.map((t) => ({ i: t.index, name: audioName({ lang: t.language }, t.index) })));
            setCurAudio(0);
          }
          v.src = url; v.play().catch(() => {});
          return;
        }
        try {
          const want = Math.max(0, probe.tracks.findIndex((t) => t.playable && trackIsLang({ lang: t.language }, wantLang)));
          const h = await playDemuxed(v, url, want, (m) => { if (import.meta.env.DEV) console.info('[demux]', m); });
          if (cancelled) { void h.destroy(); return; }
          demuxRef.current = h;
          setAudioTracks(h.tracks.map((t) => ({ i: t.index, name: audioName({ lang: t.language }, t.index) })));
          setCurAudio(h.current());
          audioPrefDone.current = true;  // the language was chosen when the stream was built
          v.play().catch(() => {});
        } catch (e) {
          if (import.meta.env.DEV) console.info('[demux] falling back to direct playback:', (e as Error).message);
          v.src = url; v.play().catch(() => {});
        }
      })();
    }

    /* Native audio renditions, for both native paths above (progressive files AND
     * Safari's own HLS). The list is only populated once metadata is in, and on some
     * WebKit builds it arrives a beat later still, hence the `addtrack` listener as well
     * as `loadedmetadata`. Where the browser has no `audioTracks` (Chrome, Edge, Firefox)
     * every line here is a no-op and the menu stays empty — see the note on
     * `nativeAudioTracks`. hls.js drives its own list and must not be touched from here. */
    const syncNativeAudio = () => {
      if (cancelled || hlsRef.current) return;
      const list = nativeAudioTracks(v);
      if (!list || list.length < 1) return;
      const tracks = nativeAudioList(list);
      if (!audioPrefDone.current) {
        const want = pickAudioTrack(tracks, wantLang);
        if (want >= 0) { try { tracks.forEach((t, i) => { t.enabled = i === want; }); } catch { /* ignore */ } }
        audioPrefDone.current = true;
      }
      setAudioTracks(tracks.map((t, i) => ({ i, name: audioName(t, i) })));
      setCurAudio(Math.max(0, tracks.findIndex((t) => t.enabled)));
    };
    v.addEventListener('loadedmetadata', syncNativeAudio);
    const nlist = nativeAudioTracks(v) as unknown as EventTarget | null;
    nlist?.addEventListener?.('addtrack', syncNativeAudio);
    nlist?.addEventListener?.('change', syncNativeAudio);

    return () => {
      cancelled = true;
      window.clearTimeout(hideTimer.current); // don't let a pending auto-hide fire into the next open
      v.removeEventListener('loadedmetadata', syncNativeAudio);
      nlist?.removeEventListener?.('addtrack', syncNativeAudio);
      nlist?.removeEventListener?.('change', syncNativeAudio);
      flush(); // persist any pending resume-progress when the source changes / player closes
      if (wasmRef.current) { void wasmRef.current.destroy(); wasmRef.current = null; }
      if (demuxRef.current) { void demuxRef.current.destroy(); demuxRef.current = null; }
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch { /* ignore */ } hlsRef.current = null; }
      try { v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
    };
  }, [playSrc, source, flush]);

  /* SILENT PLAYBACK IS NOT AN ERROR AND NOTHING ELSE REPORTS IT.
   *
   * Chrome and Edge ship no Dolby or DTS decoder, so an AC-3 / E-AC-3 / DTS track decodes
   * to nothing while the video plays perfectly: no `error` event, no stall, no clue. The
   * source list warns where the release NAME gives the codec away, but plenty of captions
   * say nothing, and remuxes are mislabelled — so this is the backstop that reads what the
   * decoder actually did. `webkitAudioDecodedByteCount` pinned at zero while
   * `webkitVideoDecodedByteCount` climbs is exactly that condition, and it is unambiguous.
   *
   * Polled rather than event-driven because there is no event to listen for, and stopped
   * the moment it answers so a long watch is not paying for a check that has finished. */
  useEffect(() => {
    setSilent(false);
    if (!source) return;
    const v = videoRef.current;
    if (!v || isDecodingSilently(v) === null) return; // counters absent → cannot tell, say nothing
    let played = 0;
    const id = window.setInterval(() => {
      if (v.paused || v.readyState < 3) return;
      played += 1;
      if (played < SILENT_AFTER) return;
      window.clearInterval(id);
      if (isDecodingSilently(v)) setSilent(true);
    }, 1000);
    return () => window.clearInterval(id);
  }, [source]);

  /* WHAT THIS SOURCE COULD SHOW, in one list, without downloading any of it.
   *
   * Two origins, and they arrive at different times. The stream's own embedded tracks are
   * already in hand and go in synchronously, so a source that carries subtitles has a
   * populated menu on the first frame exactly as it did before. The subtitle ADD-ONS are a
   * network round-trip and land second, appended — never replacing, because a user who
   * opened the menu immediately and picked the embedded English must not have the row
   * renumbered out from under them. Appending keeps every existing index stable, which is
   * what makes `currentSub` safe to hold across the update. */
  useEffect(() => {
    /* NORMALISED ON THE WAY IN, the same way the add-on tracks are. What a muxer wrote in the
     * file — `rus_forced_4`, `eng_5` — is not a language code, and carrying it through meant the
     * player held `ru` for an add-on's Russian and `rus_forced_4` for the stream's own: two
     * strings for one language, which every comparison then treated as two languages. The menu
     * grouped them apart, and the default-subtitle-language preference could match one and miss
     * the other on the same title.
     *
     * The stream's own label still wins where it has one — it is the only place the release's
     * wording ("Signs & Songs") survives — and the derived label is the fallback, which keeps the
     * forced/region qualifier that the code deliberately drops. */
    const embedded: SubCandidate[] = (source?.subtitles || []).map((s) => {
      const n = normalizeSubLang(s.lang || '');
      /* A LABEL THAT IS JUST THE CODE AGAIN IS NOT A LABEL. DetailModal builds these rows as
       * `label: x.lang || 'Subtitle'` — so for a stream with no title of its own the "label" is
       * the raw token, and preferring it would print `rus_forced_4` as the row's own name inside
       * a group headed Русский. Only a label that says something the code does not gets to win. */
      const own = s.label && s.label !== s.lang ? s.label : '';
      return { lang: n.code, label: own || n.label || 'Subtitle', url: s.url };
    });
    setSubs(embedded);
    setCurrentSub(-1);
    /* Cleared HERE and not left to the resolve effect below. That effect is keyed on
     * [subs, currentSub], so on the commit that swaps the source its deps have not changed
     * yet and it does not run — leaving one rendered frame in which the <track> still
     * points at a blob the cleanup has just revoked, and the browser fetches it and logs
     * the failure. Dropping it in the same pass as the list is what closes that frame. */
    retireTrack(videoRef.current);
    setVtt(null);
    setSubFailed(false);
    setSubBad(new Set());
    subPicked.current = false;
    subMemo.current = loadSubPick(subPickKey(source?.media));
    // The subtitle face loads on first use; asked now, the first line is not drawn in a stand-in.
    if (source) void document.fonts?.load('italic 600 32px Inter').catch(() => {});

    const q = source?.subsQuery;
    if (!q) { setSubsLoading(false); return; }
    let alive = true;
    setSubsLoading(true);
    collectAddonSubtitles(q.videoId, q.type)
      .then((list) => { if (alive && list.length) setSubs([...embedded, ...list]); })
      .catch(() => { /* the fan-out already swallows per-add-on failures */ })
      .finally(() => { if (alive) setSubsLoading(false); });
    return () => { alive = false; };
  }, [source]);

  /* TURN A TRACK ON BY ITSELF — the one picked for this title last time (same language, same
   * add-on: the next episode carries the choice on), else the default language from Settings
   * (English). `autoSubIndex` in lib/subtitles has the ranking.
   *
   * `subPicked` is why this is not simply keyed on the list: the add-on tracks arrive after
   * the menu is already usable, so this effect necessarily re-runs on a list the user may
   * have already made a choice in, and without the flag it would overrule them a second or
   * two into playback. Until then it re-runs on the grown list, which is how a remembered
   * add-on's file wins over the stream's own once its answer lands. */
  useEffect(() => {
    if (subPicked.current) return;
    const i = autoSubIndex(subs, subMemo.current, settings.subLang, subBad, subsLoading);
    if (i != null) setCurrentSub(i);
  }, [subs, subsLoading, subBad, settings.subLang]);

  /* DOWNLOAD THE ONE TRACK THAT IS SHOWING, and cache it for the rest of the playback.
   *
   * The old code fetched, gunzipped and converted EVERY track up front and mounted them all
   * as <track> elements. With only a stream's embedded subtitles that is two or three
   * requests and it was fine. It stops being fine the moment subtitle add-ons are in the
   * list: OpenSubtitles answers a popular episode with dozens of files, and paying for all
   * of them to render a menu — most of which the user will never open — is the reason a
   * lazy fetch is the only workable shape here. Only the chosen track is ever fetched.
   *
   * The cache is what keeps switching back and forth cheap, and it is keyed by the ADD-ON's
   * url (the stable identity) rather than the blob's. Every blob it holds is revoked when
   * the source changes — a blob: URL is a document-lifetime leak otherwise, and a
   * binge-watch is a hundred episodes in one document. */
  useEffect(() => {
    const c = subs[currentSub];
    if (!c) { retireTrack(videoRef.current); setVtt(null); return; }
    const hit = vttCache.current.get(c.url);
    if (hit) { retireTrack(videoRef.current, hit); setVtt({ lang: c.lang, label: c.label, url: hit }); setSubFailed(false); return; }
    let alive = true;
    setSubFailed(false);
    void toVttBlobUrl(c.url).then((url) => {
      if (!alive) return;
      if (!url) {
        /* A subtitle host without permissive CORS cannot be read from a browser at all, and
         * that is most of them. Saying so beats a row that ticks and shows nothing. A track
         * that was turned on BY ITSELF says nothing: the next one in its language is tried. */
        retireTrack(videoRef.current);
        setVtt(null);
        if (subPicked.current) { setSubFailed(true); return; }
        setSubBad((b) => new Set(b).add(c.url));
        setCurrentSub(-1);
        return;
      }
      vttCache.current.set(c.url, url);
      retireTrack(videoRef.current, url);
      setVtt({ lang: c.lang, label: c.label, url });
    });
    return () => { alive = false; };
  }, [subs, currentSub]);

  /* THE SUBTITLES ARE DRAWN BY THE PLAYER, in a layer of their own over the picture and the
   * controls' shade, not by the browser inside the <video>. The browser still loads the track and
   * says which cues are on (the track is `hidden`, so `cuechange` keeps firing); the player prints
   * them. Two things only that way:
   *   · NOT DIMMED. Anything the browser draws is part of the video, so the bottom bar's dark
   *     gradient lay over it — a line placed beside the controls came out grey.
   *   · PLACED. While the controls are up the line moves into the open space beside them: just above
   *     the progress bar, to the right of the title, the episode line and the icons, and it WRAPS
   *     inside that space. The browser's own cues can be pushed around a little but always wrap at
   *     the full width, so a long line ran into the title or off the screen. (Lifting it over the
   *     whole stack, the first try, put it half way up the picture.)
   * In picture-in-picture and the iPhone's own fullscreen the page is not on screen, so there the
   * browser draws them again (`nativeCues`).
   *
   * MEASURED, NOT A FIXED NUMBER: the stack's size is a clamp() of the screen, the wordmark's width
   * is the art's, the web build has volume/PiP/fullscreen at the far end of the row, and the episodes
   * shelf moves it all. Read once the stack has settled (its entrance is a transform) and again when
   * the wordmark arrives; the last reading is used at once the next time the controls come up. When
   * a long title leaves too little room beside it, the line goes over the whole stack instead.
   *
   * `x` moves the line's centre from the middle of the screen, `y` is its bottom's height above the
   * bottom of the screen, `w` the width it wraps at, `vh` the picture's height (the type is 5% of it,
   * the size browsers give subtitles, times the Settings size). */
  const [cueBox, setCueBox] = useState({ x: 0, y: 0, w: 0, vh: 0 });

  /* WHICH LINES ARE ON NOW, read from the mounted track. `load` as well as `cuechange`, because a
   * track mounted while paused has its first cue on before any time has passed. */
  const [cueLines, setCueLines] = useState<CueLine[]>([]);
  useEffect(() => {
    const el = videoRef.current?.querySelector('track');
    if (!el || !vtt) { setCueLines([]); return; }
    const tt = el.track;
    const read = () => setCueLines(Array.from(tt.activeCues ?? []).map((c) => cueLine(c as VTTCue)));
    read();
    tt.addEventListener('cuechange', read);
    el.addEventListener('load', read);
    return () => { tt.removeEventListener('cuechange', read); el.removeEventListener('load', read); };
  }, [vtt]);

  /* PICTURE-IN-PICTURE AND THE IPHONE'S OWN FULLSCREEN show the <video> without the page, and so
   * without the player's subtitle layer: there the browser draws the cues itself. */
  const [nativeCues, setNativeCues] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      const mode = (v as HTMLVideoElement & { webkitPresentationMode?: string }).webkitPresentationMode;
      setNativeCues(document.pictureInPictureElement === v || mode === 'picture-in-picture' || mode === 'fullscreen');
    };
    const evs = ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged', 'webkitbeginfullscreen', 'webkitendfullscreen'];
    evs.forEach((e) => v.addEventListener(e, sync));
    return () => evs.forEach((e) => v.removeEventListener(e, sync));
  }, [source]);

  /* One mounted <track> at a time, so turning it on is not an index lookup. `hidden`, not `showing`:
   * the cues still load and change, and the player draws them (see `cueLines`) — except where the
   * page is not on screen and the browser has to (`nativeCues`). */
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const tt = v.textTracks[0];
    if (tt) tt.mode = vtt ? (nativeCues ? 'showing' : 'hidden') : 'disabled';
  }, [vtt, nativeCues]);

  // drop every converted subtitle when the source changes (and on unmount)
  useEffect(() => () => {
    vttCache.current.forEach((u) => URL.revokeObjectURL(u));
    vttCache.current.clear();
  }, [source]);

  /* WHERE THE INTRO, RECAP AND CREDITS ARE — for a film as much as for an episode.
   *
   * Asked once per source, and not until the file's LENGTH is known: the server checks every
   * community marker against it (an "intro" two hours into a film is a bad submission; credits
   * that end past the end of this file were timed on a longer cut), and one of the two databases
   * uses it to prefer markers made against this same release. Until it answers the skip button
   * falls back to its heuristic window on a series; a film just has no markers.
   *
   * TheIntroDB is keyed by TMDB, in the numbering the viewer picked; IntroDB by IMDb, in the
   * stream numbering — the two differ for an anime whose sequel season lives under its own IMDb
   * id, so the second key travels alongside (`iimdb`, `is`, `ie`).
   *
   * A server that predates /api/segments answers 404; an episode then falls back to the old
   * IntroDB-only route, so the player can ship before the server does.
   *
   * THE ANSWER BELONGS TO THE SOURCE IT WAS ASKED FOR, and nothing else may cancel it. It used to
   * be dropped by this effect's cleanup, which runs on every change of `dur` — and on a real
   * stream the length is written more than once (reset to 0 when the source attaches, set again
   * on each loadedmetadata as the stream is probed and re-attached). The first write sent the
   * request, the next one threw its answer away, and `segAsked` stopped it being asked again: a
   * title with markers in both databases played with none. A local test file, whose length is
   * written once, could never show it. So the guard is the source itself, read when the answer
   * lands. */
  const segAsked = useRef<typeof source | null>(null);
  const segSource = useRef<typeof source | null>(null);
  useEffect(() => { segSource.current = source; }, [source]);
  useEffect(() => {
    if (segAsked.current !== source) setSegments(null);
    if (!source || !dur || segAsked.current === source) return;
    segAsked.current = source;
    const m = source.media, s = source.series;
    const tmdbOf = (id: unknown) => (/^\d+$/.test(String(id ?? '')) ? String(id) : '');
    const q = new URLSearchParams();
    if (s) {
      const st = s.seasons.find((x) => x.season === s.season)?.stream;
      q.set('type', 'tv');
      if (tmdbOf(s.metaId)) q.set('tmdb', tmdbOf(s.metaId));
      if (s.imdb) q.set('imdb', s.imdb);
      q.set('s', String(s.season)); q.set('e', String(s.ep));
      if (st) { q.set('iimdb', st.imdb); q.set('is', String(st.season)); q.set('ie', String(s.ep)); }
    } else if (m) {
      q.set('type', 'movie');
      if (tmdbOf(m.id)) q.set('tmdb', tmdbOf(m.id));
      if (m.imdb) q.set('imdb', m.imdb);
    } else return;
    if (!q.get('tmdb') && !q.get('imdb')) return;
    q.set('dur', String(Math.round(dur)));
    /* The answer's VERSION. The service worker keeps these a day and serves the kept copy first, so
       when the server's sources change (SkipDB added Oct 16 = v3; SkipDB made the main source = v4)
       an old wrong answer would still be shown
       once per episode. A new value is a new cache key; the server ignores it. */
    q.set('v', '4');
    const asked = source;
    const take = (d: { intro?: Segments['intro']; recap?: Segments['recap']; credits?: Segments['outro']; outro?: Segments['outro']; preview?: Segments['preview'] } | null) => {
      if (!d || segSource.current !== asked) return;
      const seg: Segments = { intro: d.intro, recap: d.recap, outro: d.credits ?? d.outro, preview: d.preview };
      if (seg.intro || seg.recap || seg.outro || seg.preview) setSegments(seg);
    };
    apiFetch(`/api/segments?${q}`)
      .then((r) => {
        if (r.ok) return r.json();
        // An older server: the IntroDB-only route, episodes only.
        if (r.status === 404 && s?.imdb) {
          const st = s.seasons.find((x) => x.season === s.season)?.stream;
          const [imdb, season] = st ? [st.imdb, st.season] : [s.imdb, s.season];
          return apiFetch(`/api/introdb/${encodeURIComponent(imdb)}/${season}/${s.ep}`).then((r2) => (r2.ok ? r2.json() : null));
        }
        return null;
      })
      .then(take)
      .catch(() => {});
  }, [source, dur]);


  const bump = useCallback(() => {
    setHideUi(false);
    window.clearTimeout(hideTimer.current);
    /* IDLE IN CONTROLS MODE NOW ENDS IT, and that is the replacement for a Back press.
     *
     * This used to return early whenever the D-pad held the chrome, on the reasoning that chrome
     * the remote is standing on must not fade out from under it — true, and it only worked
     * because Back was the way out of controls mode. Back closes the player now, so an early
     * return here would leave the bar up forever after a single Down press, with nothing that
     * dismisses it.
     *
     * Five seconds of no presses is the viewer having stopped using the controls, so the controls
     * stop: focus is parked back on the overlay (via `exitTvNav`, so no invisible selection is
     * left behind) and the chrome fades. Never while a menu, the audio popup or the episode shelf
     * is open — those are things being READ, and reading is not idleness. */
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current?.paused || uiBusyRef.current) return;
      if (IS_TV && tvNavRef.current) exitTvNavRef.current();
      setHideUi(true);
    }, IS_TV ? TV_HIDE_MS : 3000);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);

  /* ONE BOX OPEN AT A TIME. Each button in the row opens its own box hanging over it — Subtitles,
   * Audio, ⋯ — and opening one shuts whichever was up, along with the episode shelf: a box over the
   * row with the shelf lifting the row is two layers fighting for the same strip of screen. The
   * button that opened a box shuts it again. */
  const toggleMenu = (door: 'subs' | 'more') => {
    setAudioOpen(false);
    setEpPanelOpen(false);
    // However the box ends up closing — a pick, Back, a click outside — the remote goes back to
    // the button that opened it.
    tvWantFocus.current = door === 'subs' ? 'subs' : 'gear';
    if (menuOpen && menuDoor === door) { setMenuOpen(false); return; }
    setMenuDoor(door);
    setBoxLevel(null);
    setMenuOpen(true);
  };
  const toggleAudio = () => {
    setMenuOpen(false);
    setEpPanelOpen(false);
    setBoxLevel(null);
    tvWantFocus.current = 'audio';
    setAudioOpen((o) => !o);
  };

  useEffect(() => { setLogoFailed(false); setLogoReady(false); }, [source?.logo]);

  /* THE EPISODE'S NAME, for the line under the wordmark. The same season query the episode shelf
   * and the title screen's list make, so it is nearly always already in the cache by the time
   * anything plays. Asked only for a TMDB title: an add-on series carries its episodes in its own
   * meta and has no season endpoint to ask (the title screen makes the same distinction). */
  const epSeries = source?.series;
  const epTmdb = epSeries != null && /^\d+$/.test(String(epSeries.metaId));
  const epSeason = useSeason(epTmdb ? epSeries.metaId : undefined, epTmdb ? epSeries.season : undefined, epSeries?.imdb);
  const epFound = epSeries ? epSeason.data?.episodes?.find((e) => e.episode === epSeries.ep)?.name : undefined;
  // TMDB's placeholder for an unnamed episode is "Episode 3", which the S1 | E3 beside it already says.
  const epName = epFound && !/^episode\s+\d+$/i.test(epFound.trim()) ? epFound : undefined;

  /* ---- POST-PLAY: WHEN ---------------------------------------------------------------------------
   * Eligible: a film, or a series with no next episode to roll into, when the setting is on and the
   * title is one we can describe. The moment is the start of the credits, from the best source
   * available — IntroDB's outro marker, then the picture itself (lib/creditsDetect), then a
   * conservative tail — and failing all of those, the end of the film. */
  const ppEligible = !!source?.media && settings.postPlay !== false && !(source?.series && source?.next);

  useEffect(() => {
    setPpArmed(false); setPpOpen(false);
    ppDismissed.current = false; ppDucked.current = null;
    detector.current?.dispose(); detector.current = null; detectorBlocked.current = false;
  }, [source]);

  const openPostPlay = useCallback(() => {
    if (ppOpenRef.current) return;
    ppOpenRef.current = true;
    setPpArmed(true);
    setPpOpen(true);
    // Whatever the viewer had open over the film goes with it; the D-pad belongs to post-play now.
    setMenuOpen(false); setAudioOpen(false); setEpPanelOpen(false); setTvNav(false); setHideUi(false);
    /* THE FILM COUNTS AS WATCHED from here. Continue Watching should not offer to resume someone
     * into the credits of a film they finished; the progress writes below stand down while this is
     * up so the playing credits cannot pull it back under the line. */
    const v = videoRef.current, m = source?.media;
    if (v && m?.key && v.duration > 0) putProgress(m.key, v.duration, v.duration, m.lang);
  }, [source, putProgress]);

  const backToCredits = useCallback(() => {
    ppDismissed.current = true;
    ppOpenRef.current = false;
    setPpOpen(false);
    const v = videoRef.current;
    if (v && ppDucked.current !== null) { v.muted = ppDucked.current; ppDucked.current = null; }
    if (IS_TV) overlayRef.current?.focus({ preventScroll: true });
    bump();
  }, [bump]);

  /* THE CORNER IS BRIEF. The credits hold their frame for ten seconds — long enough to see the film
   * has not been taken away, and to step back into it — and then fade out of the screen, leaving the
   * trailers alone. Once faded the film is paused: its picture is gone, its music would only fight
   * the trailers', and on a television its decoder is the one the trailers need. */
  useEffect(() => {
    if (!ppOpen) { setPpMiniGone(false); return; }
    const id = window.setTimeout(() => setPpMiniGone(true), PP_MINI_MS);
    return () => window.clearTimeout(id);
  }, [ppOpen]);
  useEffect(() => {
    if (!ppMiniGone) return;
    const id = window.setTimeout(() => { const v = videoRef.current; if (v && !v.paused) v.pause(); }, 900);
    return () => window.clearTimeout(id);
  }, [ppMiniGone]);

  /* A post-play trailer with its sound up takes the room's sound: the credits are ducked under it
   * and given back the moment it stops (the slideshow is silent, so the music returns there). */
  const onPpAudible = useCallback((audible: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    if (audible) {
      if (ppDucked.current === null) { ppDucked.current = v.muted; v.muted = true; }
    } else if (ppDucked.current !== null) {
      v.muted = ppDucked.current; ppDucked.current = null;
    }
  }, []);

  // Arming, and the two answers that do not need the picture: the outro marker and the tail.
  useEffect(() => {
    if (!ppEligible || !dur || ppOpen) return;
    const short = dur < 600;   // a clip, a short: no credits worth detecting — only its end counts
    if (!ppArmed && cur >= (short ? dur * 0.5 : Math.min(dur - 240, creditsWatchFrom(dur)))) setPpArmed(true);
    if (ppDismissed.current || short) return;
    const outro = segments?.outro && segments.outro.start > 0 && segments.outro.start < dur ? segments.outro.start : null;
    /* While the picture can still be read, the tail waits for it — down to the last 25 seconds, for
     * credits rolled over footage that the detector will never recognise. */
    const at = outro ?? (detectorBlocked.current ? creditsFallback(dur) : dur - 25);
    if (cur >= at && dur - cur > 1) openPostPlay();
  }, [cur, dur, ppEligible, ppArmed, ppOpen, segments, openPostPlay]);

  // The picture: once a second over the last stretch of the film, while it is playing.
  useEffect(() => {
    if (!ppEligible || ppOpen || !playing || !dur || dur < 600) return;
    const v = videoRef.current;
    if (!v) return;
    const id = window.setInterval(() => {
      if (ppDismissed.current || detectorBlocked.current) return;
      if (v.currentTime < creditsWatchFrom(v.duration || dur)) return;
      if (!detector.current) detector.current = createCreditsDetector(v);
      const r = detector.current.sample();
      if (r.verdict === 'blocked') detectorBlocked.current = true;
      else if (r.verdict === 'credits') openPostPlay();
    }, IS_TV ? 1500 : 1000);
    return () => window.clearInterval(id);
  }, [ppEligible, ppOpen, playing, dur, openPostPlay]);

  /** Tear down the hold ramp. Safe to call when no ramp is running. */
  const stopRamp = useCallback(() => {
    if (rampRaf.current) cancelAnimationFrame(rampRaf.current);
    rampRaf.current = 0;
    rampVel.current = 0;
    seekHoldDir.current = 0;
    setRamping(false);
  }, []);

  /* Apply a pending scrub. Called by the release grace, by OK, by the idle fallback, and by
   * anything that ends the gesture early (leaving the bar, a transport key, closing the player). */
  const commitSeek = useCallback(() => {
    window.clearTimeout(seekCommitTimer.current);
    window.clearTimeout(seekReleaseTimer.current);
    stopRamp();
    const pos = seekPreviewRef.current;
    seekPreviewRef.current = null;
    setSeekPreview(null);
    const v = videoRef.current;
    if (v && pos != null) {
      v.currentTime = pos;
      /* AND THE BAR IS TOLD IN THE SAME BREATH, which is the whole fix for the snap-back.
       *
       * The scrubber renders `seekPreview ?? cur`. Dropping the preview on commit therefore fell
       * back to `cur` — and `cur` is only refreshed by the video's own `timeupdate`, which does not
       * arrive until the seek has actually landed, up to a quarter-second later and longer on a
       * cold buffer. For that whole window the bar was reading the position the viewer had just
       * rewound AWAY from, so a scrub visibly recoiled to where it started and then jumped to the
       * destination once the event caught up. Two movements for one gesture, and the wrong one
       * first.
       *
       * Seeding it here closes the window: `v.currentTime` is already `pos`, so this is not an
       * optimistic guess about where the video will end up — it is the same fact, delivered to
       * React without waiting to be told it a second time. */
      setCur(pos);
      /* THE LANDING. Committing used to be silent: the preview markers vanished and the picture
       * changed whenever the demuxer got there, so the gesture had no ending — it just stopped
       * being. `.landed` gives the dot a half-second squash-and-settle (see "THE DOT" in the
       * stylesheets), and it fires the instant the seek is issued rather than when the frame
       * arrives, so it also covers the decode gap that is otherwise dead air on a slow TV. */
      setLanded(true);
      lastScrubAt.current = performance.now();
      window.clearTimeout(landedTimer.current);
      landedTimer.current = window.setTimeout(() => setLanded(false), 520);
    }
    bump();
  }, [bump, stopRamp]);

  /* ---- THE RAMP: WHAT A HELD BUTTON ACTUALLY DRIVES -------------------------------------------
   *
   * A held remote key is not a stream of small seeks — it is one continuous motion, and it has to
   * be driven by a clock rather than by the autorepeat. The previous version advanced the preview
   * once per repeat, which meant the playhead moved at whatever rate the TV's key repeat happened
   * to fire (every ~160ms on some, ~40ms on others, irregular under load on all of them). Easing
   * each of those hops only smoothed the individual jumps; the gesture was still a stutter,
   * because the thing generating it was stuttering.
   *
   * So a hold now starts a rAF loop that integrates a velocity: position += rate × elapsed, every
   * frame, from the frame clock. The autorepeat stops being motion and becomes what it should have
   * been all along — a signal that the button is still down. Rate is exponential in the DURATION of
   * the hold, not in the press count, so the acceleration curve is identical on every remote.
   *
   * The cap is derived from the runtime rather than fixed: whatever is playing, holding at full
   * tilt crosses the whole of it in about fourteen seconds. A constant would make a 22-minute
   * episode feel twitchy at the same setting that makes a three-hour film feel like wading. */
  const rampFrame = useCallback((t: number) => {
    const v = videoRef.current;
    const dir = seekHoldDir.current;
    if (!v || !dir || !v.duration) { stopRamp(); return; }
    // Clamped, because a backgrounded tab or a dropped frame on a slow TV hands back a huge
    // delta, and integrating it raw would teleport the playhead — the exact artefact this exists
    // to remove.
    const dt = Math.min((t - rampAt.current) / 1000, 0.05);
    rampAt.current = t;
    const vmax = Math.max(400, v.duration / 14);
    rampVel.current = Math.min(vmax, rampVel.current * Math.pow(TV_RAMP_GROWTH, dt));
    const base = seekPreviewRef.current ?? v.currentTime;
    const next = clamp(base + dir * rampVel.current * dt, 0, v.duration);
    seekPreviewRef.current = next;
    /* PAINT AT ~18Hz, NOT AT 60. The ref is what the next frame integrates from, so the motion is
     * frame-accurate regardless; this only governs how often React re-renders the bar. A TV that
     * is already decoding video cannot re-render this subtree every frame, and it does not need
     * to — the CSS transition below interpolates between paints, so the playhead glides at 60fps
     * off ~18 state writes a second. */
    if (t - rampPaint.current >= 55) { rampPaint.current = t; setSeekPreview(next); }
    // Both ends are absorbing: park there and keep the ramp alive, so releasing still commits and
    // reversing picks straight back up without a fresh tap.
    rampRaf.current = requestAnimationFrame(rampFrame);
  }, [stopRamp]);

  /** One press of Left/Right (or ⏪/⏩) in TV mode: extend the preview, defer the seek. */
  const tvSeek = useCallback((dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    // A key going down cancels any release that was pending — see tvSeekRelease for why a release
    // is not acted on immediately.
    window.clearTimeout(seekReleaseTimer.current);
    const now = performance.now();
    const held = seekHoldDir.current === dir && now - seekLastAt.current < TV_SEEK_REPEAT_MS;
    seekLastAt.current = now;
    seekHoldDir.current = dir;

    if (!held) {
      /* A DELIBERATE PRESS IS STILL EXACTLY TEN SECONDS. Tapping is aiming, and aiming needs an
       * answer that does not depend on how long the finger stayed down — a tap that seeked by
       * "however far the ramp got" would be unrepeatable. Reversing mid-hold lands here too, which
       * is what makes an overshoot correctable: the ramp is dropped and the first press back is a
       * precise ten seconds rather than a resumption of full-tilt travel in the other direction. */
      stopRamp();
      seekHoldDir.current = dir;
      const base = seekPreviewRef.current ?? v.currentTime;
      const next = clamp(base + dir * TV_SEEK_TAP, 0, v.duration);
      seekPreviewRef.current = next;
      setSeekPreview(next);
    } else if (!rampRaf.current) {
      // Second repeat in the same direction: the button is being HELD. Hand over to the clock.
      rampVel.current = TV_RAMP_V0;
      rampAt.current = now;
      rampPaint.current = now;
      setRamping(true);
      rampRaf.current = requestAnimationFrame(rampFrame);
    }

    // Show the bar for the duration of the scrub without handing the D-pad over: the viewer is
    // seeking, not choosing, and the next Left press must still seek rather than move a selection.
    setHideUi(false);
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(seekCommitTimer.current);
    seekCommitTimer.current = window.setTimeout(commitSeek, TV_SEEK_COMMIT_MS);
  }, [commitSeek, stopRamp, rampFrame]);

  /* THE BUTTON COMING BACK UP IS THE END OF THE GESTURE, and waiting half a second to notice was
   * the dead stop at the end of every scrub: the viewer stopped pressing, the bar sat frozen with
   * a stale number on it, and only then did the picture move. The idle timer is still there, but
   * demoted to a fallback for remotes that report no release at all.
   *
   * THE 150ms GRACE IS NOT POLISH — IT IS THE WHOLE RELIABILITY STORY. Several TV platforms
   * implement autorepeat as repeated key-down/key-up PAIRS rather than as repeated downs, so a
   * held button on those devices reports a release between every repeat. Committing on the first
   * one would make holding impossible: the scrub would seek and reset a dozen times. The grace is
   * long enough that the next repeat cancels it and short enough that a real release still reads
   * as instant — 150ms is under the ~200ms at which a delay stops being felt as causation. */
  const tvSeekRelease = useCallback(() => {
    if (seekPreviewRef.current == null) return;
    window.clearTimeout(seekReleaseTimer.current);
    seekReleaseTimer.current = window.setTimeout(commitSeek, TV_SEEK_RELEASE_MS);
  }, [commitSeek]);

  /** Summon the controls and give the D-pad to them. */
  const enterTvNav = useCallback(() => {
    if (seekPreviewRef.current != null) commitSeek();
    setTvNav(true);
    /* ARM THE IDLE CLOCK ON THE WAY IN. This used to clear the hide timer and leave it cleared,
     * which was right when Back was the way out of controls mode; with Back now closing the
     * player, the press that summons the bar has to also start the thing that dismisses it, or
     * the bar is up for the rest of the film. */
    bump();
  }, [commitSeek, bump]);

  /** Step back out to transport mode: nothing selected, chrome free to fade again. */
  const exitTvNav = useCallback(() => {
    setTvNav(false);
    tvNavRef.current = false;                 // bump() reads the ref, and state lands a tick late
    // Park focus on the overlay itself rather than leaving it on a button that is about to fade:
    // a stray OK would otherwise fire whatever the remote happened to be standing on.
    overlayRef.current?.focus({ preventScroll: true });
    bump();
  }, [bump]);
  useEffect(() => { exitTvNavRef.current = exitTvNav; }, [exitTvNav]);
  useEffect(() => { uiBusyRef.current = menuOpen || audioOpen || epPanelOpen; }, [menuOpen, audioOpen, epPanelOpen]);

  /* WHERE THE REMOTE LANDS IN THE CONTROL BAR, and where it goes back to when a panel over the
   * bar closes. Both are the same problem — something has just appeared or disappeared and focus
   * has nowhere valid to be — so they share one effect keyed on all three states.
   *
   * The closing case is not optional. TvSpatialNav's own focus recovery deliberately skips this
   * overlay (the player manages itself), so with the gear menu unmounted the element the remote
   * was standing on is gone and focus falls to <body>; the next arrow press would restart from
   * the first candidate in the overlay, which is the ✕ in the far corner. Putting it back on the
   * button that opened the panel is what a viewer expects from closing one. */
  useEffect(() => {
    if (!IS_TV || !tvNav) return;
    const id = requestAnimationFrame(() => {
      const root = overlayRef.current;
      if (!root) return;
      if (menuOpen || audioOpen || epPanelOpen) return; // the box or the shelf seeds its own first row
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && ae !== root && root.contains(ae)) return; // already somewhere real
      /* AN EXPLICIT HINT BEATS EVERYTHING, because it means the viewer has just closed a panel
         and there is a right answer: the button they opened it with. Only when there is no hint
         does SKIP INTRO take it — that button is on screen for perhaps ninety seconds and is the
         only reason most people touch the remote during them, so summoning the controls while it
         is up should land on it rather than make the viewer walk there from the scrubber.
         `.show` is load-bearing: the button is in the DOM the whole time and `display:none` when
         it has nothing to say. */
      const target = (tvWantFocus.current === 'gear' ? root.querySelector<HTMLElement>('#vpGear') : null)
        ?? (tvWantFocus.current === 'subs' ? root.querySelector<HTMLElement>('#vpSubs') : null)
        ?? (tvWantFocus.current === 'audio' ? root.querySelector<HTMLElement>('#vpAudio') : null)
        ?? (tvWantFocus.current === 'episodes' ? root.querySelector<HTMLElement>('#vpEpisodes') : null)
        ?? (tvWantFocus.current === 'scrubber' ? barRef.current : null)
        ?? root.querySelector<HTMLElement>('.vp-prompt.show .vp-pbtn.sel')
        ?? barRef.current
        ?? root.querySelector<HTMLElement>('#vpPlay');
      tvWantFocus.current = 'bar';
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [tvNav, menuOpen, audioOpen, epPanelOpen]);

  /* A BOX OPENS WITH THE REMOTE ALREADY ON WHAT IS SELECTED — the subtitle language in use, the
   * audio track playing — so the box reads the way it is drawn: the white pill is both "you are
   * here" and "this is on", and changing nothing costs nothing. With nothing selected it lands on the
   * first row. Stepping back out of a second-level list lands on the row that opened it, not at the
   * top.
   *
   * Both builds: on the web the focus is for a keyboard, and a mouse never sees it (Chrome does not
   * paint `:focus-visible` for a focus() issued from a click). A frame's delay, because the box is
   * mounted by the same render that opens it and is not in the document until that commits. */
  useEffect(() => {
    if (!menuOpen && !audioOpen) return;
    const id = requestAnimationFrame(() => {
      const box = overlayRef.current?.querySelector<HTMLElement>('.vp-box');
      if (!box) return;
      const from = levelFrom.current;
      levelFrom.current = null;
      const rows = Array.from(box.querySelectorAll<HTMLElement>('.vp-box-back, .vp-opt')).filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled'));
      const to = (from && box.querySelector<HTMLElement>(`[data-key="${from}"]`))
        || rows.find((el) => el.classList.contains('on'))
        || rows.find((el) => !el.classList.contains('vp-box-back'))
        || rows[0];
      to?.focus({ preventScroll: true });
      to?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [menuOpen, audioOpen, menuDoor, boxLevel]);
  /* Drive the rail's mount/slide off `epPanelOpen`. 470ms is the 420ms transform (`--vp-rail-ease`
   * in tv.css and app.css) plus margin; it only has to OUTLAST the animation — unmounting a few ms
   * late costs nothing, unmounting early is the blink this exists to prevent, so if the curve is
   * ever lengthened this number goes up with it. */
  useEffect(() => {
    if (epPanelOpen) {
      setRailMounted(true);
      /* TWO FRAMES, NOT ONE, AND THAT IS THE WHOLE REASON THE SHELF DID NOT SLIDE.
       *
       * A rAF callback runs BEFORE the paint of the frame it was scheduled for. Setting state
       * there gives React a chance to render and commit the `.open` class within that very same
       * frame, so the browser paints `translateY(100%)` and `translateY(0)` in one go and there
       * is no start state to interpolate from — the shelf simply appears, which is exactly what
       * "showing without scrolling animation from the bottom" looks like. The control bar was
       * unaffected because it is always mounted and only receives a class, so its previous frame
       * genuinely exists. The second rAF guarantees a painted frame in between. */
      let inner = 0;
      const id = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setRailShown(true));
      });
      return () => { cancelAnimationFrame(id); cancelAnimationFrame(inner); };
    }
    setRailShown(false);
    const id = window.setTimeout(() => setRailMounted(false), 470);
    return () => window.clearTimeout(id);
  }, [epPanelOpen]);

  const toggleMute = useCallback(() => { const v = videoRef.current; if (v) v.muted = !v.muted; }, []);
  const toggleFs = useCallback(() => {
    const el = overlayRef.current;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (el?.requestFullscreen) { el.requestFullscreen(); return; }
    // iPhone Safari can't fullscreen an element — only the <video> itself
    if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen();
  }, []);
  const togglePip = useCallback(async () => {
    const v = videoRef.current as (HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string }) | null;
    if (!v) return;
    try {
      // iPad/iOS expose PiP via webkitSetPresentationMode, not the standard API
      if (typeof v.webkitSetPresentationMode === 'function') {
        v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
        return;
      }
      if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v.requestPictureInPicture();
    } catch { /* ignore */ }
  }, []);
  const setLevel = (i: number) => { const h = hlsRef.current; if (h) h.currentLevel = i; setCurLevel(i); };
  const setSpeed = (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; setRate(r); };
  /* Pick a track by its index in `subs`. The element's textTracks are NOT touched here any
   * more: only the chosen track is ever mounted, so which one shows follows from which one
   * was fetched, and the effect that mounts it also sets its mode. Setting a mode here
   * would be setting it on the OUTGOING track, one commit before the incoming one exists. */
  const selectSub = (i: number) => {
    subPicked.current = true;
    setCurrentSub(i);
    // Remembered for the TITLE, so the next episode (and a source switch) opens on the same track.
    const c = subs[i];
    saveSubPick(subPickKey(source?.media), c ? { lang: c.lang, source: c.source ?? '', label: bareSubLabel(c.label), url: c.url } : { off: true });
  };
  /* Manual audio switch. hls.js owns the list when it is attached; otherwise the list came
   * from the element itself, where switching means enabling one track and disabling the
   * rest (a native AudioTrackList permits several enabled at once, which would mix them). */
  const selectAudio = (i: number) => {
    /* THE IN-PAGE DEMUXER GOES FIRST, because when it is driving there is no track to
     * select on the element — the stream it built has exactly one, and changing language
     * means rebuilding it around a different one from the current position. */
    const w = wasmRef.current;
    if (w) {
      setCurAudio(i);
      void w.switchAudio(i).then(() => videoRef.current?.play().catch(() => {}));
      return;
    }
    const d = demuxRef.current;
    if (d) {
      setCurAudio(i);
      void d.switchAudio(i)
        .then(() => videoRef.current?.play().catch(() => {}))
        /* A FILE CAN MIX CODECS ACROSS ITS TRACKS, and the one being switched to may be
         * Dolby when the one playing was not — real example: Apex, five tracks, three of
         * them Russian. The demuxer cannot help there and says so; handing over to the WASM
         * decoder at the same timestamp is the answer, and letting the failure surface as
         * "this file can't play in the browser" (which is what happened) blames the file
         * for a switch we simply had not implemented. */
        .catch(async (e: Error) => {
          const v = videoRef.current;
          if (!v || !source || e.message !== 'NEEDS_WASM_DECODER') { if (import.meta.env.DEV) console.warn('[demux] switch failed:', e.message); return; }
          const at = v.currentTime;
          try {
            await d.destroy();
            demuxRef.current = null;
            const h = await playWithWasmAudio(v, source.url, i,
              (m) => { if (import.meta.env.DEV) console.info('[wasm-audio]', m); });
            wasmRef.current = h;
            v.currentTime = at;
            v.play().catch(() => {});
          } catch (err) {
            if (import.meta.env.DEV) console.warn('[wasm-audio] handover failed:', (err as Error).message);
          }
        });
      return;
    }
    const h = hlsRef.current;
    if (h) { try { h.audioTrack = i; } catch { /* ignore */ } }
    else {
      const v = videoRef.current, list = v && nativeAudioTracks(v);
      if (list) { try { nativeAudioList(list).forEach((t, k) => { t.enabled = k === i; }); } catch { /* ignore */ } }
    }
    audioPrefDone.current = true; // an explicit pick outranks any later preference pass
    setCurAudio(i);
  };

  /* ---- A POINTER SCRUB IS A PREVIEW TOO, and that is what made the web bar stop stuttering.
   *
   * Dragging used to write `currentTime` on every pointermove — a real seek per mouse event, so
   * the demuxer was asked for a new position a hundred times a second and the playhead, which
   * only moves on `timeupdate` after each seek LANDS, lurched along a few hundred milliseconds
   * behind the cursor and froze on every miss. The remote solved the same problem with a preview
   * that the bar renders and a single seek on release (see "SEEKING IS PREVIEWED" above), and the
   * pointer now uses exactly that machinery: `seekPreviewRef` is where the finger is, `.ramping`
   * gives the fill and the disc the short linear transition that tracks a continuous motion, and
   * `commitSeek` on pointer-up is the one seek. A click with no drag is a press and a release in
   * the same place, which commits at once. */
  const previewToClient = useCallback((clientX: number) => {
    const bar = barRef.current, v = videoRef.current; if (!bar || !v || !v.duration) return;
    const r = bar.getBoundingClientRect();
    const pos = clamp((clientX - r.left) / r.width, 0, 1) * v.duration;
    seekPreviewRef.current = pos;
    setSeekPreview(pos);
  }, []);
  const onBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    window.clearTimeout(seekReleaseTimer.current);
    window.clearTimeout(seekCommitTimer.current);
    setRamping(true);                       // the linear curve — the cursor is a continuous input
    setHideUi(false); window.clearTimeout(hideTimer.current);
    previewToClient(e.clientX);
    const move = (ev: PointerEvent) => previewToClient(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      commitSeek();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /* ---- THE PLAYHEAD MOVES EVERY FRAME, NOT EVERY QUARTER SECOND (web only).
   *
   * `timeupdate` fires about four times a second, so a bar driven from `cur` alone advances in
   * 250ms steps — on a two-hour film that is a sub-pixel twitch nobody sees, on a three-minute
   * trailer it is a visible tick, and either way it is not the glide the TV's scrub has. This
   * loop reads `currentTime` on every animation frame and writes the two positions straight to
   * the DOM, bypassing React: the same two numbers React would compute, sixty times a second
   * instead of four, and with no re-render to pay for. React still owns the elements — its own
   * render writes the same values from `cur` a moment behind, and the next frame here corrects
   * a difference no larger than 250ms of film.
   *
   * It stands aside whenever a preview is up (the transition is doing the moving then, and this
   * loop would fight it) and while the element reports `seeking` — some browsers hand back the
   * OLD position for a tick after a seek is issued, which is the recoil `commitSeek` documents.
   * Not on the television: a style write per frame is a style recalc per frame, and that budget
   * is spent (see the TV build's effect ceiling). The TV's bar steps, as it always has. */
  useEffect(() => {
    if (IS_TV || !playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current, bar = barRef.current, thumb = thumbRef.current;
      if (v && bar && thumb && v.duration && !v.seeking && seekPreviewRef.current == null) {
        const p = (v.currentTime / v.duration) * 100;
        // One played fill per chapter piece, each measured against its own ends.
        bar.querySelectorAll<HTMLElement>('.vp-played').forEach((el) => {
          const a = Number(el.dataset.a), b = Number(el.dataset.b);
          el.style.width = `${clamp((p - a) / (b - a), 0, 1) * 100}%`;
        });
        thumb.style.left = `${p}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // --- touch gesture handlers (single tap shows the chrome, or pauses while it shows; double-tap the left/right
  // third seeks ±10s and accumulates; a vertical drag adjusts volume on the right half
  // and brightness on the left; a horizontal drag scrubs) ---
  const showVHud = (kind: 'vol' | 'bright', val: number, note?: string) => { window.clearTimeout(vHudTimer.current); setVHud({ kind, val, note }); };
  const hideVHudSoon = () => { window.clearTimeout(vHudTimer.current); vHudTimer.current = window.setTimeout(() => setVHud(null), 650); };

  const doDoubleTap = (region: 'left' | 'center' | 'right') => {
    const v = videoRef.current; if (!v) return;
    if (region === 'center') { togglePlay(); bump(); return; }
    const dir = region === 'left' ? -1 : 1;
    const acc = seekAccumRef.current;
    const secs = (acc.side === region ? acc.secs : 0) + 10;
    seekAccumRef.current = { side: region, secs };
    v.currentTime = clamp(v.currentTime + dir * 10, 0, v.duration || 0);
    setSeekHud({ side: region === 'left' ? 'left' : 'right', secs });
    window.clearTimeout(seekHudTimer.current);
    seekHudTimer.current = window.setTimeout(() => { setSeekHud(null); seekAccumRef.current = { side: '', secs: 0 }; }, 700);
  };

  const fingerGap = (ts: React.TouchList) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  const onGestureStart = (e: React.TouchEvent) => {
    const g = gestRef.current;
    if (e.touches.length === 2) {                                // a pinch: the one-finger gesture is off
      g.active = false;
      window.clearTimeout(singleTapTimer.current);
      pinchRef.current = { d0: fingerGap(e.touches), ratio: 1 };
      return;
    }
    if (e.touches.length !== 1) { g.active = false; return; }   // ignore other multi-touch
    const el = overlayRef.current, v = videoRef.current; if (!el) return;
    const r = el.getBoundingClientRect(), tch = e.touches[0];
    g.active = true; g.mode = ''; g.t0 = performance.now();
    g.x0 = tch.clientX - r.left; g.y0 = tch.clientY - r.top; g.w = r.width; g.h = r.height;
    g.startVol = v?.muted ? 0 : (v?.volume ?? 1); g.startBright = bright;
    // A swipe that begins while a scrub is still previewing extends the preview, not the video.
    g.startTime = seekPreviewRef.current ?? v?.currentTime ?? 0;
  };
  const onGestureMove = (e: React.TouchEvent) => {
    const g = gestRef.current;
    const p = pinchRef.current;
    if (p.d0 && e.touches.length === 2) { p.ratio = fingerGap(e.touches) / p.d0; return; }
    if (!g.active || e.touches.length !== 1) return;
    const el = overlayRef.current, v = videoRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.touches[0].clientX - r.left) - g.x0, dy = (e.touches[0].clientY - r.top) - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;       // below intent threshold
      g.mode = Math.abs(dx) > Math.abs(dy) ? 'seek' : (g.x0 < g.w / 2 ? 'bright' : 'vol');
      if (g.mode === 'seek') {
        // Reveal the scrubber and put it in its continuous-motion state — a finger is a ramp.
        setHideUi(false); window.clearTimeout(hideTimer.current);
        window.clearTimeout(seekReleaseTimer.current); window.clearTimeout(seekCommitTimer.current);
        setRamping(true);
      }
    }
    const span = g.h * 0.6;                                     // full-scale drag distance
    if (g.mode === 'vol' && v) {
      if (VOL_LOCKED) {
        /* iOS: the level is the rocker's alone (see VOL_LOCKED), so the swipe drives the one
         * thing it CAN — mute. Down past a short dead zone mutes, up past it unmutes, and the
         * HUD says where the volume itself went so the gesture does not look broken. */
        if (dy > span * 0.12) v.muted = true; else if (dy < -span * 0.12) v.muted = false;
        showVHud('vol', v.muted ? 0 : 1, t('player.vol_ios'));
      } else {
        const nv = clamp(g.startVol - dy / span, 0, 1);
        v.volume = nv; v.muted = nv <= 0.001;
        showVHud('vol', nv);
      }
    } else if (g.mode === 'bright') {
      const nb = clamp(g.startBright - dy / span, 0.15, 1);
      setBright(nb); showVHud('bright', (nb - 0.15) / 0.85);
    } else if (g.mode === 'seek' && v && v.duration) {
      const reach = Math.min(v.duration, 180);                  // full swipe = ±180s (or whole clip)
      // Previewed, not applied — the seek happens once, when the finger lifts (onGestureEnd).
      const pos = clamp(g.startTime + (dx / g.w) * reach, 0, v.duration);
      seekPreviewRef.current = pos;
      setSeekPreview(pos);
    }
  };
  const onGestureEnd = () => {
    const g = gestRef.current;
    const p = pinchRef.current;
    if (p.d0) {                                                 // the pinch ends with its first finger up
      const to = p.ratio > 1.15 ? true : p.ratio < 0.87 ? false : null;
      pinchRef.current = { d0: 0, ratio: 1 };
      // Landscape only, like the apps: held upright, filling the screen would crop most of the film.
      if (to === false || (to && window.innerWidth > window.innerHeight)) {
        setFill(to);
        setZoomHud(t(to ? 'player.zoom_fill' : 'player.zoom_original'));
        window.clearTimeout(zoomHudTimer.current);
        zoomHudTimer.current = window.setTimeout(() => setZoomHud(null), 1100);
      }
      return;
    }
    if (!g.active) return;
    g.active = false;
    if (g.mode) {                                               // a drag — settle HUDs
      if (g.mode === 'vol' || g.mode === 'bright') hideVHudSoon();
      else commitSeek();                                        // scrub: the one real seek, then auto-hide
      return;
    }
    const dt = performance.now() - g.t0;
    if (dt > 500) return;                                       // long-press: not a tap
    const region: 'left' | 'center' | 'right' = g.x0 < g.w * 0.35 ? 'left' : g.x0 > g.w * 0.65 ? 'right' : 'center';
    const now = performance.now(), last = lastTapRef.current;
    if (now - last.t < 320 && Math.abs(g.x0 - last.x) < 90 && last.side === region) {
      window.clearTimeout(singleTapTimer.current);             // upgrade to a double-tap
      lastTapRef.current = { t: now, x: g.x0, side: region };
      doDoubleTap(region);
    } else {
      lastTapRef.current = { t: now, x: g.x0, side: region };
      window.clearTimeout(singleTapTimer.current);
      singleTapTimer.current = window.setTimeout(() => {       // defer so a 2nd tap can upgrade
        if (performance.now() - menuClosedAt.current < 600) { bump(); return; } // this tap closed a sheet
        // The first tap brings the controls up; a tap while they are up pauses (or plays) — the
        // controls then fade on their own timer.
        if (hideUiRef.current) bump(); else { togglePlay(); bump(); }
      }, 280);
    }
  };

  // clear gesture timers on unmount
  useEffect(() => () => { window.clearTimeout(singleTapTimer.current); window.clearTimeout(seekHudTimer.current); window.clearTimeout(vHudTimer.current); window.clearTimeout(zoomHudTimer.current); }, []);

  // detect iPad/iOS per-video PiP once the media element exists
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & { webkitSupportsPresentationMode?: (m: string) => boolean }) | null;
    if (v && typeof v.webkitSupportsPresentationMode === 'function') {
      try { setWebkitPip(!!v.webkitSupportsPresentationMode('picture-in-picture')); } catch { /* ignore */ }
    }
  }, [source]);

  // keyboard + fullscreen listener while open
  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      // Post-play answers its own keys (in the capture phase, so they never reach here); Escape
      // leaves the player from it, as Back does on a remote.
      if (ppOpenRef.current) { if (e.key === 'Escape') close(); return; }
      /* Escape walks OUT one layer at a time. It used to close the whole player from anywhere,
       * so dismissing the gear menu tore down playback with it — two layers deep, wrong layer
       * closed. (On TV this handler never sees Escape at all: lib/tvKeys.ts resolves Back in the
       * capture phase and swallows it. The same order is repeated here because the website has
       * no such resolver and the bug was the website's too.) */
      if (e.key === 'Escape') {
        if (document.fullscreenElement) document.exitFullscreen();
        else if ((menuOpen || audioOpen) && boxLevel) { levelFrom.current = boxLevel; setBoxLevel(null); }
        else if (audioOpen) setAudioOpen(false);
        else if (menuOpen) setMenuOpen(false);
        else if (epPanelOpen) setEpPanelOpen(false);
        else close();
        return;
      }
      /* Transport keys belong to the VIDEO, so they stand down while a panel is over it —
       * otherwise Left/Right seeks the film underneath the menu the user is reading. The one
       * exception is Up with the shelf open, which is how the shelf closes — the same axis that
       * opened it, exactly as on the remote. */
      if (epPanelOpen && e.key === 'ArrowUp') { e.preventDefault(); setEpPanelOpen(false); bump(); return; }
      if (menuOpen || audioOpen || epPanelOpen) return;
      // Not from inside a text field or a slider — the volume range wants its own arrows.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      /* THE KEYBOARD SCRUBS THE WAY THE REMOTE DOES. Left/Right used to seek ten seconds on the
       * spot, and holding the key was a seek per autorepeat — the black-screen-and-spinner the
       * TV section describes, at a keyboard's 30ms repeat rate. `tvSeek` is not TV-specific in
       * anything but its name: a press extends a preview the bar glides to, a held key ramps,
       * and the release (below) is the one seek. */
      else if (e.key === 'ArrowLeft') { e.preventDefault(); tvSeek(-1); return; }
      else if (e.key === 'ArrowRight') { e.preventDefault(); tvSeek(1); return; }
      else if (e.key === 'ArrowDown' && source.series) { e.preventDefault(); railFrom.current = 'bar'; setEpPanelOpen(true); }
      else if (e.key === 'm') toggleMute();
      else if (e.key === 'f') toggleFs();
      bump();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') tvSeekRelease();
    };
    const onFs = () => setFs(!!document.fullscreenElement);
    /* NOT ON THE TV. The remote handler below replaces this one wholesale rather than layering
     * over it — these bindings assume a keyboard (space, k, m, f) and, worse, an unconsumed
     * ArrowLeft reaching here would seek the film a second time on top of the scrub the remote
     * handler had already started. The fullscreen listener stays either way; it costs nothing
     * and a TV shell can still be in and out of it. */
    if (!IS_TV) { window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKeyUp); }
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [source, close, togglePlay, tvSeek, tvSeekRelease, toggleMute, toggleFs, bump, menuOpen, boxLevel, audioOpen, epPanelOpen]);

  /* ---- THE REMOTE ---------------------------------------------------------------------------
   * CAPTURE PHASE, and load-bearing for the same reason tvKeys' Back listener is: TvSpatialNav
   * binds `keydown` on the bubble phase, so a capture listener here runs first and can take
   * Left/Right back for the scrubber before spatial navigation treats them as movement.
   *
   * `stopImmediatePropagation` on everything consumed, so a press never does two jobs. */
  useEffect(() => {
    if (!IS_TV || !source) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      /* POST-PLAY HAS THE REMOTE. This listener was registered first, so it is the one that must
         step aside: the arrows walk post-play's row, OK opens a title, and nothing here may seek the
         credits playing in the corner. Stop still means stop. */
      if (ppOpenRef.current) {
        if (mediaAction(e) === 'stop') { e.preventDefault(); close(); }
        return;
      }
      const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      /* PARKED, THE REMOTE IS THE TITLE SCREEN'S — all but ▶, which picks the film up as its Play
         does, and ■, which ends it. */
      if (usePlayer.getState().parked) {
        const pm = mediaAction(e);
        if (pm === 'play' || pm === 'playpause') { consume(); usePlayer.getState().resume(); }
        else if (pm === 'stop') { consume(); close(); }
        return;
      }
      const v = videoRef.current;

      /* 1. THE TRANSPORT ROW, which works from anywhere including inside the gear menu. These
       * buttons name their own action, so honouring them regardless of what has focus is what
       * the viewer expects — ⏸ means pause, not "pause unless a list is open". */
      const m = mediaAction(e);
      if (m) {
        consume();
        if (m === 'rew') { tvSeek(-1); return; }
        if (m === 'ff') { tvSeek(1); return; }
        if (seekPreviewRef.current != null) commitSeek();
        if (m === 'playpause') togglePlay();
        else if (m === 'play') v?.play().catch(() => { /* autoplay policy — the button stays */ });
        else if (m === 'pause') v?.pause();
        else if (m === 'stop') close();
        else if (m === 'next') startNextRef.current();
        // 'prev' has no meaning here: there is no previous-episode action in the player.
        bump();
        return;
      }

      const k = e.key;
      const onBar = document.activeElement === barRef.current;

      /* 2. THE EPISODE RAIL owns the D-pad while it is up, and unlike the gear menu it cannot
       * simply be handed to TvSpatialNav and forgotten.
       *
       * UP HAS TO BE TAKEN. Geometrically the rail sits at the bottom of the screen with the
       * scrubber directly above it, so Up "works" — but it leaves the rail OPEN behind the
       * bar, covering the bottom third of the picture, with no press that obviously shuts it
       * again. Down opened it; Up closes it. The whole gesture is one axis.
       *
       * LEFT/RIGHT HAVE TO BE TAKEN for the reason the control row documents at length below:
       * `pick` scores travel + 2x drift, and the scrubber is a full-width element sitting
       * directly above a strip of ~300px cards — from the first card, Left has nowhere to go
       * along the row and the enormous bar overhead wins on distance. Walking the track in DOM
       * order makes the ends stop instead of teleporting to the timeline. */
      if (epPanelOpen && IS_TV) {
        if (k === 'ArrowUp') {
          consume();
          /* MOVE FOCUS HERE, NOT VIA THE RESTORE EFFECT. That effect bails when the remote is
           * already on something inside the overlay ("already somewhere real"), and on the
           * commit that closes the shelf the remote IS — on the card it was standing on, which
           * is still mounted for its slide-down. So it declines to act, the card then goes
           * `tabIndex={-1}` and the browser blurs it, and focus lands on <body>: the next arrow
           * press restarts from the ✕ in the far corner. Measured, not theorised. The hint is
           * still set, as the answer for the frame where the bar has not rendered yet. */
          tvWantFocus.current = 'scrubber';
          setEpPanelOpen(false);
          barRef.current?.focus({ preventScroll: true });
          return;
        }
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          const ae = document.activeElement as HTMLElement | null;
          const track = ae?.closest<HTMLElement>('.vp-eprail-track');
          if (track && ae) {
            const cards = Array.from(track.querySelectorAll<HTMLElement>('.vp-epcard'));
            const at = cards.indexOf(ae);
            if (at >= 0) {
              consume();
              /* The card the remote lands on becomes the LEFTMOST one and the strip slides under
                 it, rather than a highlight travelling along a strip that stays put. See
                 `scrollCardToSlot` for why this is not `scrollIntoView` — that scrolls the whole
                 overlay along with the strip, and takes the picture with it. */
              const to = cards[at + (k === 'ArrowRight' ? 1 : -1)];
              if (to) { to.focus({ preventScroll: true }); scrollCardToSlot(to); }
            }
          }
        }
        return;
      }

      // A box or the shelf over the bar owns the D-pad completely — the box walks itself (see
      // `onBoxKey`), and seeking the film underneath a list the viewer is reading is the bug this
      // exists to prevent.
      if (menuOpen || audioOpen || epPanelOpen) return;

      /* 2b. A PROMPT ON SCREEN TAKES OK, as it does on every streaming app: Skip Intro is pressed
       * with the button the viewer's thumb is already on, without summoning the controls first.
       * With the credits pair up, Left and Right choose between Watch Credits and Next Episode
       * instead of seeking — the one stretch of a film where nobody is scrubbing. A scrub still
       * waiting to be committed keeps OK. */
      const pr = promptRef.current;
      if (!tvNav && pr) {
        if ((k === 'Enter' || k === ' ') && seekPreviewRef.current == null) { consume(); pr.act(); bump(); return; }
        if (pr.kind === 'next' && (k === 'ArrowLeft' || k === 'ArrowRight')) { consume(); setPromptSel(k === 'ArrowLeft' ? 'ghost' : 'main'); return; }
      }

      // 3. THE SCRUBBER, whether it holds focus or nothing does. Same two keys, same job — which
      // is the point: Left is "back a bit" in both modes, so there is nothing to learn.
      if (!tvNav || onBar) {
        if (k === 'ArrowLeft') { consume(); tvSeek(-1); return; }
        if (k === 'ArrowRight') { consume(); tvSeek(1); return; }
        if (k === 'Enter' && seekPreviewRef.current != null) { consume(); commitSeek(); return; }
        /* OK ON THE SCRUBBER, WITH NOTHING PENDING, IS PLAY/PAUSE. It has to be, now that the
         * play button is a badge rather than a stop on the row: the bar is where the remote
         * lives in controls mode, and OK there previously did nothing at all unless a scrub was
         * waiting to be committed. Same meaning it has in transport mode, so there is nothing
         * new to learn — OK is play/pause everywhere except when it has a seek to confirm. */
        if (onBar && (k === 'Enter' || k === ' ')) { consume(); togglePlay(); bump(); return; }
      }

      /* 3b. DOWN FROM THE SCRUBBER OPENS THE EPISODE RAIL — the one gesture this whole feature
       * is. It is available only from the bar, and only in controls mode: in transport mode
       * Down is how you summon the chrome in the first place (step 4), and spending that press
       * on a shelf of episodes would take the seek bar away from someone who only wanted the
       * bar. So it is always exactly two presses from watching — Down, Down — and the second
       * one is in the direction the shelf appears from.
       *
       * The bar is the BOTTOM control on a television (the transport row is rendered above it
       * there, matching every TV player and freeing this press); on the web the order is
       * reversed and none of this code runs. A film has no rail and Down does nothing. */
      if (tvNav && onBar && k === 'ArrowDown' && source.series) {
        consume();
        railFrom.current = 'bar';
        setEpPanelOpen(true);
        return;
      }

      /* 3c. UP FROM THE SCRUBBER IS THE ICON ROW, and it is answered here rather than left to
       * TvSpatialNav for the same reason Left/Right in the row are (step 6): the bar is a
       * full-width element and the row is a short cluster at its left end, so "nearest thing
       * above" from the playhead is decided by pixels the viewer cannot see — from a playhead
       * three quarters along it was the Skip button, or nothing. Up goes back to the icon the
       * remote last stood on, else the first one; the row is one press away whatever the
       * playhead's position. */
      if (tvNav && onBar && k === 'ArrowUp') {
        const items = rowIcons(overlayRef.current);
        const to = items.find((el) => el.id === rowLast.current) ?? items[0];
        if (to) { consume(); to.focus({ preventScroll: true }); bump(); return; }
      }

      if (!tvNav) {
        /* 4. TRANSPORT MODE.
         *
         * OK IS PLAY/PAUSE AND NOTHING ELSE. It flashes the bar up (bump) as confirmation, and
         * that bar fades on its own once playback resumes — it deliberately does NOT hand the
         * D-pad over. Someone pausing to answer the door is not asking to be put into a control
         * bar they then have to press Back to escape; and if OK claimed the D-pad, the very next
         * Left press would move a selection instead of rewinding.
         *
         * Up or Down is the way in, which is what it is on every other television app. */
        if (k === 'Enter' || k === ' ') { consume(); togglePlay(); bump(); return; }
        if (k === 'ArrowUp' || k === 'ArrowDown') { consume(); enterTvNav(); return; }
        return;
      }

      // 5. CONTROLS MODE. Vertical movement and OK belong to TvSpatialNav and to the buttons
      // themselves; this keeps the bar alive while the remote is working in it.
      /* Every press restarts the idle clock. It used to CANCEL it — correct when only Back could
         leave controls mode, and wrong now that going idle is what leaves it: cancelling would
         mean the first press into the bar was also the last thing that could ever dismiss it. */
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Enter' || k === ' ') {
        bump();
      }

      /* 6. LEFT/RIGHT INSIDE THE CONTROL ROW WALK THE ROW, and they have to be taken back from
       * spatial navigation to do it.
       *
       * THE DEFECT, MEASURED ON THE RUNNING PLAYER: Right from 🔊 landed on the PROGRESS BAR
       * rather than on ⚙, and Left from ⚙ did the same. Geometry explains it and geometry cannot
       * fix it. `pick` scores a candidate as travel + 2x drift, and the scrubber is a full-width
       * element sitting one row above the buttons — so from mute its centre is ~700px away with
       * only the few px between the two rows as drift, while the gear is a genuine ~1460px along
       * the row. The bar wins a HORIZONTAL press on distance, because it is enormous and directly
       * overhead. Every gap in the row (the time read-out, the spacer that pushes ⚙ to the far
       * corner) makes it worse, which is why it bites exactly where the row has holes in it.
       *
       * Widening `pick`'s cross-axis test would fix it here and break the home screen, where a
       * full-width billboard being reachable from a narrow poster is the whole reason the test is
       * a span overlap rather than centre-to-centre (see the note there). So this is answered
       * locally, where the answer is unambiguous: within a row of transport buttons, Left and
       * Right mean the NEXT BUTTON, never a jump to another control. Up and Down still belong to
       * spatial nav, which already does the right thing — the bar is directly above, and ✕ above
       * that.
       *
       * DOM ORDER, NOT GEOMETRY, because the row IS its DOM order and the buttons are optional:
       * Episodes only exists for a series and CC only when the file has subtitles, so any fixed
       * list of ids would silently skip whichever is absent.
       *
       * THE ENDS STOP RATHER THAN WRAP, and the press is consumed either way — that is the whole
       * point. Letting a press at the end fall through is precisely how the scrubber captured it. */
      const ae = document.activeElement as HTMLElement | null;
      const prompts = Array.from(overlayRef.current?.querySelectorAll<HTMLElement>('.vp-prompt.show .vp-pbtn') ?? []);
      const atPrompt = ae ? prompts.indexOf(ae) : -1;

      /* 6a. THE ROW SITS DIRECTLY ON TOP OF THE SCRUBBER, so Down from any icon is the bar and Up
       * from one is nothing — the top of the screen is empty on a television, and a press that
       * wandered off to the Skip button in the far corner would be a move nobody aimed. */
      if (ae && (k === 'ArrowUp' || k === 'ArrowDown') && rowIcons(overlayRef.current).includes(ae)) {
        consume();
        if (k === 'ArrowDown') barRef.current?.focus({ preventScroll: true });
        return;
      }
      /* THE PROMPT stands at the row's right end, at the row's height, so it joins the row: Right
       * off the last icon reaches it, Left and Right walk its buttons (Watch Credits, Next Episode)
       * and Left off the first comes back, and Down from it is the bar like Down from any icon. */
      if (atPrompt >= 0 && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowDown' || k === 'ArrowUp')) {
        consume();
        if (k === 'ArrowDown') barRef.current?.focus({ preventScroll: true });
        else if (k === 'ArrowRight') prompts[atPrompt + 1]?.focus({ preventScroll: true });
        else if (k === 'ArrowLeft') {
          const items = rowIcons(overlayRef.current);
          (prompts[atPrompt - 1] ?? items.find((el) => el.id === rowLast.current) ?? items[items.length - 1])?.focus({ preventScroll: true });
        }
        return;
      }

      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        const row = ae?.closest<HTMLElement>('.vp-controls');
        if (row && ae) {
          const items = Array.from(row.querySelectorAll<HTMLElement>('button, [tabindex]'))
            .filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length > 0);
          const at = items.indexOf(ae);
          if (at >= 0) {
            consume();
            const to = items[at + (k === 'ArrowRight' ? 1 : -1)] ?? (k === 'ArrowRight' ? prompts[0] : null);
            to?.focus({ preventScroll: true });
          }
        }
      }
    };
    /* THE MATCHING KEY-UP, which is the other half of every hold. It is deliberately NOT filtered
     * by mode or by focus the way the key-down above is: whatever state the player has got itself
     * into by the time the finger comes off, a scrub that is up MUST be able to end. The handler
     * is inert unless one is actually pending, so there is nothing to guard against. */
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'MediaRewind' || k === 'MediaFastForward') tvSeekRelease();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [source, tvNav, menuOpen, audioOpen, epPanelOpen, tvSeek, tvSeekRelease, commitSeek, enterTvNav, togglePlay, close, bump]);

  // A pending scrub must never outlive the player (or the source it was measured against) — and
  // neither must the ramp that is driving it.
  useEffect(() => () => {
    window.clearTimeout(seekCommitTimer.current);
    window.clearTimeout(seekReleaseTimer.current);
    window.clearTimeout(landedTimer.current);
    if (rampRaf.current) cancelAnimationFrame(rampRaf.current);
  }, []);

  /* The two layers the Back chain cannot see from outside: both are local state, not a store.
   * Registered while the player is open so a remote's Back closes the menu, then the episode
   * panel, then playback — one press each. On the website a browser Back (or a phone's back swipe)
   * reaches them the same way (tvKeys `installBackGuard`). */
  useEffect(() => {
    // Parked, the film is behind the title screen and its Back is the screen's (tvKeys `handleBack`).
    if (!source || parked) return;
    return registerBackHandler(() => {
      // The hint tells the focus effect which button to hand the remote back to — see there.
      // A box's second-level list steps back to its first list; the box itself closes next.
      if ((menuOpen || audioOpen) && boxLevel) { levelFrom.current = boxLevel; setBoxLevel(null); return true; }
      if (menuOpen) { tvWantFocus.current = menuDoor === 'subs' ? 'subs' : 'gear'; setMenuOpen(false); return true; }
      /* THE AUDIO POPUP IS A LAYER AND WAS NOT IN THIS CHAIN. It never had to be while Back's
       * last step was "dismiss the control bar" — a Back with the popup open closed the bar and
       * the popup went with it, which looked right by accident. Now that the last step ends the
       * film, the same press closed the whole player out from under a viewer who had opened a
       * list to change the audio track. Measured, not theorised. */
      if (audioOpen) {
        setAudioOpen(false);
        if (IS_TV) overlayRef.current?.querySelector<HTMLElement>('#vpAudio')?.focus({ preventScroll: true });
        return true;
      }
      /* BACK PUTS THE REMOTE WHERE THE EPISODES CAME FROM, and on a TV there are now two doors
       * into them. Handing it back to the Episodes button is right when that button opened it,
       * and wrong when Down from the scrubber did: the button is at the far end of the control
       * row, so Back would close the shelf and simultaneously teleport the selection across the
       * bar — a move the viewer did not ask for and cannot undo with the same key. */
      if (epPanelOpen) {
        const toBar = railFrom.current === 'bar';
        tvWantFocus.current = toBar ? 'scrubber' : 'episodes';
        setEpPanelOpen(false);
        // Same reason as the Up handler's explicit focus: on the TV the rail outlives this
        // commit by the length of its slide-down, so the restore effect sees the remote as
        // already parked somewhere valid and leaves it on a card that is about to be blurred.
        if (IS_TV) {
          (toBar ? barRef.current : overlayRef.current?.querySelector<HTMLElement>('#vpEpisodes'))
            ?.focus({ preventScroll: true });
        }
        return true;
      }
      /* THE CONTROL BAR IS NO LONGER A LAYER BACK HAS TO PEEL, and that is a deliberate reversal.
       *
       * It used to be one, so that Back from the gear button dismissed the chrome instead of
       * ending the film — a real hazard when the gear, CC, Episodes, skip and mute all lived in
       * that row and a viewer could be several presses deep in it. That row is now the scrubber
       * and nothing else: the settings menu answers its own Back, the episode shelf answers its
       * own, and what is left underneath is a seek bar over a playing film. Making Back mean
       * "dismiss the seek bar" there spends a press on removing something that fades by itself
       * after five seconds, and puts a second press between the viewer and leaving.
       *
       * So Back now falls through to the app's chain, which closes the player. Settings first,
       * shelf next, then out — one press each, in the order they were opened. */
      /* …EXCEPT ON THE TV, WHERE OUT IS THE TITLE SCREEN WITH THE FILM STILL IN HAND — Netflix's Back
       * (the user, Oct 20): paused, its frame behind the screen it was started from, and that screen's
       * Play picks it up on the same frame. Only a film that has a frame to show, and only over its own
       * title screen; post-play, an error or a source still loading leave the old way. */
      const v = videoRef.current;
      if (IS_TV && !ppOpenRef.current && !errKind && v && v.readyState >= 2
        && String(useModal.getState().target?.id ?? '') === String(source.media?.id ?? '-')) {
        if (seekPreviewRef.current != null) commitSeek();
        park();
        return true;
      }
      return false;
      /* Registered AT THE PLAYER'S OWN LEVEL so that "falls through to the app's chain" means the
       * player closes, and not that the title screen underneath quietly steps its own view back
       * first — which is exactly what a series cost: one wasted press with nothing visibly
       * happening. See BACK_LAYER. */
    }, BACK_LAYER.player);
  }, [source, parked, park, errKind, commitSeek, menuOpen, menuDoor, boxLevel, audioOpen, epPanelOpen]);

  /* PARKING AND PICKING UP. Parked: paused, its place written down (the title screen's Resume reads
   * it), the remote let go. Picked up: playing again from the same frame, the remote back on the film. */
  const wasParked = useRef(false);
  useEffect(() => {
    if (!source) { wasParked.current = false; return; }
    const v = videoRef.current;
    if (parked) {
      wasParked.current = true;
      v?.pause();
      if (v && source.media?.key && v.currentTime > 0) putProgress(source.media.key, v.currentTime, v.duration || 0, source.media.lang);
      setTvNav(false);
      tvNavRef.current = false;
      return;
    }
    if (!wasParked.current) return;
    wasParked.current = false;
    overlayRef.current?.focus({ preventScroll: true });
    v?.play().catch(() => { /* autoplay policy — the play button stays */ });
  }, [parked, source, putProgress]);
  // The title screen it is parked behind went (Back, or another title opened in its place): so does the film.
  const modalId = useModal((s) => (s.target ? String(s.target.id) : ''));
  useEffect(() => {
    if (parked && modalId !== String(source?.media?.id ?? '')) close();
  }, [parked, modalId, source, close]);

  // picture-enhance: rewrite the unsharp-mask convolution kernel from the clarity
  // slider (identity at 0 → 3×3 Laplacian sharpen at 1; energy-preserving so it
  // doesn't shift brightness)
  useEffect(() => {
    const k = kernelRef.current; if (!k) return;
    const c = settings.clarity;
    k.setAttribute('kernelMatrix', `0 ${-c} 0 ${-c} ${1 + 4 * c} ${-c} 0 ${-c} 0`);
  }, [settings.clarity]);

  /* NO SCREENSAVER WHILE SOMETHING IS BEING WATCHED (lib/idle.ts): a film or an episode playing, or
   * post-play holding the screen. Paused — or stopped on an error — is not watching, so after ten
   * idle minutes the slideshow may come up over it, and goes again with the next press. */
  useKeepAwake(!!source && ((playing && !errKind) || ppOpen));

  /* THE CONTEXTUAL PROMPT — "Skip Recap", "Skip Intro", or "Watch Credits" + "Next Episode" once a
   * series' credits start. Markers when there are some (films too — a film's opening titles are as
   * skippable as a series intro); without them a series falls back to a heuristic intro window and
   * a fixed tail, and a film offers nothing, because guessing where a film's titles are is how a
   * button lands on the opening scene. Worked out above the early return because the prompt has
   * state of its own (below) and hooks cannot follow a return. */
  let skipMode: 'intro' | 'recap' | 'next' | null = null;
  let skipTo = INTRO_TO;
  if (source && dur >= 300) {
    const intro = segments?.intro && segments.intro.end < dur ? segments.intro : null;
    const recap = segments?.recap && segments.recap.end < dur ? segments.recap : null;
    const outroStart = segments?.outro && segments.outro.start > 0 && segments.outro.start < dur ? segments.outro.start : null;
    const nextAt = outroStart != null ? outroStart : dur - CREDITS_TAIL;
    if (source.series && source.next && cur >= nextAt && dur - cur > 0.5) skipMode = 'next';
    /* The end is EXCLUSIVE: Skip lands exactly on it, and a prompt still "inside" at that instant
       stayed up until the next timeupdate carried the clock past it — the press looked ignored. */
    else if (recap && cur >= recap.start && cur < recap.end) { skipMode = 'recap'; skipTo = recap.end; }
    else if (intro ? (cur >= intro.start && cur < intro.end) : (!!source.series && !segments && cur >= INTRO_FROM && cur < INTRO_TO)) {
      skipMode = 'intro'; skipTo = intro ? intro.end : INTRO_TO;
    }
  }

  /* THE PROMPTS COUNT DOWN, the way the big streaming apps' do. Each one carries a white fill that
   * sweeps across it:
   *
   *   Skip Intro / Skip Recap   fills over SKIP_SHOW_S and then steps aside — it was offered, the
   *                             viewer let it pass. It comes back whenever the controls are up,
   *                             for as long as the intro lasts, solid.
   *   Next Episode              fills over NEXT_COUNT_S and then STARTS the next episode, unless
   *                             the viewer pressed Watch Credits beside it (or has auto-play-next
   *                             off, when it waits, solid, to be pressed).
   *
   * The fill is a CSS animation on a transform, so it costs the compositor and not a render per
   * frame, and it is paused with the film (`animation-play-state`), so a viewer who pauses on the
   * credits is not carried into the next episode behind their back. `promptRun` restarts it: a
   * prompt that appears again (a seek back into the intro) counts from the beginning. */
  /* NEXT EPISODE ANSWERS THE PRESS, NOT THE NETWORK. Between the press and the next episode's
   * first frame there is a source to find and a file to open, and for all of that the old
   * episode used to carry on rolling its credits under the button as if nothing had been asked.
   * Now the press is answered in the same frame: the credits stop, the picture goes to black, the
   * bar and buttons step out, and the episode line already names the episode that is coming
   * (`switching` holds that label). The new episode's first `playing` lifts it, and so does an
   * error — or thirty seconds of nothing, which leaves the viewer a paused episode and the
   * controls, never a black screen with no way out. */
  const [switching, setSwitching] = useState<string | null>(null);
  const switchTimer = useRef<number | undefined>(undefined);
  /* SKIP INTRO / SKIP RECAP ANSWER IT TOO. The bar and the button react the instant it is
   * pressed (see `skipAhead`); the picture is the one thing that genuinely has to wait for the
   * seek, and if that takes long enough to be seen, it waits in black rather than on a frozen
   * frame of the intro that was just skipped. `jumping` is that black. */
  const [jumping, setJumping] = useState(false);
  const jumpTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!source) { setSwitching(null); window.clearTimeout(switchTimer.current); }
    setJumping(false); window.clearTimeout(jumpTimer.current);
  }, [source]);
  useEffect(() => { if (errKind) { setSwitching(null); window.clearTimeout(switchTimer.current); } }, [errKind]);
  useEffect(() => () => { window.clearTimeout(switchTimer.current); window.clearTimeout(jumpTimer.current); }, []);

  /* THE NEXT EPISODE'S SOURCES ARE ASKED FOR WHILE THIS ONE PLAYS — half way through, or five
   * minutes before its credits, whichever comes first — so that when Next Episode is pressed (or
   * counts down) the add-ons have long since answered and it starts on the same release at once.
   * Once per episode. See `sharedAddonStreams`. */
  const prefetchedFor = useRef<object | null>(null);
  useEffect(() => {
    if (!source?.prefetchNext || prefetchedFor.current === source || !dur) return;
    const outroAt = segments?.outro?.start;
    if (cur >= dur * 0.5 || dur - cur < 300 || (outroAt != null && cur >= outroAt - 300)) {
      prefetchedFor.current = source;
      source.prefetchNext();
    }
  }, [source, cur, dur, segments]);

  const [promptGone, setPromptGone] = useState(false);
  const [creditsDismissed, setCreditsDismissed] = useState(false);
  const [promptSel, setPromptSel] = useState<'main' | 'ghost'>('main');
  const [promptRun, setPromptRun] = useState(0);
  useEffect(() => { setPromptGone(false); setPromptSel('main'); setPromptRun((n) => n + 1); }, [skipMode]);
  useEffect(() => { setCreditsDismissed(false); }, [source]);
  const promptShown = (skipMode === 'next' ? !creditsDismissed : !!skipMode && (!promptGone || !hideUi)) && switching == null;
  /* THE BOTTOM STACK IS UP FROM THE FIRST FRAME: the wordmark, the episode line, the icons and the
   * bar, the moment the player opens. It used to be held until the file's length was known and the
   * chapter markers had answered (up to 8 s), so the stack arrived in one piece — and a film opened
   * on a black screen with only the ✕ for as long as the source took to start, which was the worse
   * wait. The bar's chapter gaps now open when the markers answer.
   *
   * AFTER NEXT EPISODE it is still held, black, until the new episode plays (`switching`): there the
   * old episode's bar would be the one on screen. An error, or 8 s, lets it go. */
  const [holdOver, setHoldOver] = useState(false);
  useEffect(() => {
    setHoldOver(false);
    const id = window.setTimeout(() => setHoldOver(true), 8000);
    return () => window.clearTimeout(id);
  }, [source, switching]);
  const held = !errKind && !holdOver && switching != null;
  // When it lands, the controls are shown afresh (and fade on the usual timer), as on any wake.
  const wasHeld = useRef(true);
  useEffect(() => {
    if (wasHeld.current && !held && !ppOpen) bump();
    wasHeld.current = held;
  }, [held, ppOpen, bump]);
  /* WHERE THE SUBTITLE LAYER SITS (`cueBox`, explained where it is declared). Down here because it
   * also makes room for the Skip / Next Episode prompt, which is decided just above. */
  const shownBox = useRef<{ x: number; y: number; w: number; vh: number } | null>(null);
  useEffect(() => {
    const at = () => {
      const v = videoRef.current, root = overlayRef.current;
      if (!v || !root) return null;
      const vr = v.getBoundingClientRect(), or = root.getBoundingClientRect();
      if (!vr.width || !or.width) return null;
      /* On a phone held upright, the PICTURE: the <video> fills the screen and the film is a band
       * across its middle (object-fit: contain), so 5% of the element was a line twice the size, under
       * the film. A wide screen keeps the element — a scope film's line sits low in the bar there, as
       * on the television. */
      const k = vr.height > vr.width && v.videoWidth && v.videoHeight ? Math.min(vr.width / v.videoWidth, vr.height / v.videoHeight) : 0;
      const pw = k ? v.videoWidth * k : vr.width, ph = k ? v.videoHeight * k : vr.height;
      const pb = vr.top + (vr.height + ph) / 2;
      // At rest: centred on the picture, a little up from its bottom edge, 88% of its width.
      return { vr, or, rest: { x: Math.round(vr.left + vr.width / 2 - (or.left + or.width / 2)), y: Math.round(or.bottom - pb + ph * 0.05), w: Math.round(pw * 0.88), vh: Math.round(ph) } };
    };
    // The picture's size is known from `loadedmetadata` on, and changes with a quality switch.
    const v = videoRef.current;
    const rest = () => { const a = at(); if (a) setCueBox(a.rest); };
    if (!source || hideUi || held || ppOpen) {
      rest();
      window.addEventListener('resize', rest);
      v?.addEventListener('resize', rest);
      return () => { window.removeEventListener('resize', rest); v?.removeEventListener('resize', rest); };
    }
    if (shownBox.current) setCueBox(shownBox.current); else rest();
    const measure = () => {
      const a = at(), root = overlayRef.current;
      const bar = root?.querySelector<HTMLElement>('.vp-progress');
      if (!a || !root || !bar) return;
      const { vr, or } = a;
      const br = bar.getBoundingClientRect();
      if (!br.height) return;
      const gap = window.innerHeight * 0.015;
      // The right edge of what is drawn, not of the box: the title and the episode line are blocks.
      const inked = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return b.width ? b.right : el.getBoundingClientRect().right; };
      const lefts = [
        ...Array.from(root.querySelectorAll('.vp-meta .vp-logo')).map((el) => el.getBoundingClientRect().right),
        ...Array.from(root.querySelectorAll('.vp-meta .vp-title, .vp-epline > span')).map(inked),
        ...Array.from(root.querySelectorAll('.vp-bottom > .vp-controls > :not(.vp-tail)')).map((el) => el.getBoundingClientRect().right),
      ].filter((n) => n > 0);
      // Hidden on phones (app.css), where its box would measure as the screen's left edge.
      const tail = Array.from(root.querySelectorAll<HTMLElement>('.vp-bottom .vp-tail')).find((el) => el.getBoundingClientRect().width > 0);
      const L = (lefts.length ? Math.max(...lefts) : vr.left) + gap * 2;
      // A Skip / Next Episode prompt sits at the right end, over the bar: the space ends where it starts.
      const prompt = root.querySelector<HTMLElement>('.vp-prompt.show');
      const R = Math.min(tail ? tail.getBoundingClientRect().left : br.right, prompt ? prompt.getBoundingClientRect().left : Infinity) - gap;
      const mid = or.left + or.width / 2;
      const tops = Array.from(root.querySelectorAll<HTMLElement>('.vp-bottom > .vp-meta, .vp-bottom > .vp-controls'))
        .map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top);
      const top = Math.min(br.top, ...tops);
      let next;
      if (or.bottom - a.rest.y <= top - gap) {
        // The stack is below the picture (a phone held upright): nothing covers the line, it stays.
        next = a.rest;
      } else if (R - L >= vr.width * 0.3) {
        next = { x: Math.round((L + R) / 2 - mid), y: Math.round(or.bottom - br.top + gap), w: Math.round(R - L), vh: a.rest.vh };
      } else {
        next = { ...a.rest, y: Math.round(or.bottom - top + gap) };
      }
      shownBox.current = next;
      setCueBox(next);
    };
    const t = window.setTimeout(measure, 450);
    window.addEventListener('resize', measure);
    v?.addEventListener('resize', measure);
    return () => { window.clearTimeout(t); window.removeEventListener('resize', measure); v?.removeEventListener('resize', measure); };
  }, [source, hideUi, held, ppOpen, railShown, logoReady, promptShown]);
  /* A pressed prompt takes the remote with it when it goes: focus would otherwise fall to <body> as
   * the button unmounts, and the next arrow would restart from wherever spatial navigation likes. */
  const promptLeft = () => {
    if (IS_TV && document.activeElement?.closest('.vp-prompt')) barRef.current?.focus({ preventScroll: true });
  };
  const skipAhead = () => {
    const v = videoRef.current;
    if (v) {
      const to = Math.min((v.duration || 0) - 1, Math.max(v.currentTime, skipTo));
      v.currentTime = to;
      /* The bar and the prompt are told now — `v.currentTime` already reads `to`, so this is the
         same fact, not a guess — instead of on the seek's first timeupdate, which on a cold
         buffer is a second later with the button still sitting there looking unpressed. */
      setCur(to);
      setLanded(true);
      window.clearTimeout(landedTimer.current);
      landedTimer.current = window.setTimeout(() => setLanded(false), 520);
      // Black only if the seek is slow enough to be seen; a quick one just cuts.
      window.clearTimeout(jumpTimer.current);
      jumpTimer.current = window.setTimeout(() => {
        if (!v.seeking) return;
        setJumping(true);
        jumpTimer.current = window.setTimeout(() => setJumping(false), 8000);
      }, 120);
    }
    promptLeft();
    bump();
  };
  /* Where Next Episode goes, as the player can work it out itself — the same walk as the title
   * screen's `nextEpOf`: the next episode in the season, else the first of the next season. */
  const nextEpLabel = (() => {
    const se = source?.series;
    if (!se) return '';
    const eps = (n: number) => se.seasons.find((x) => x.season === n)?.episodes ?? 0;
    if (se.ep < eps(se.season)) return epLabel(se.season, se.ep + 1);
    const ns = se.seasons.filter((x) => x.season > se.season && x.episodes > 0).map((x) => x.season).sort((a, b) => a - b)[0];
    return ns != null ? epLabel(ns, 1) : '';
  })();
  const startNext = () => {
    if (!source?.next) return;
    promptLeft();
    videoRef.current?.pause();
    setSwitching(nextEpLabel);
    setHideUi(false);
    window.clearTimeout(switchTimer.current);
    switchTimer.current = window.setTimeout(() => setSwitching(null), 30000);
    source.next();
  };
  const startNextRef = useRef(startNext);
  startNextRef.current = startNext;
  const goNext = startNext;
  const watchCredits = () => { promptLeft(); setCreditsDismissed(true); bump(); };
  /* ON THE TV THE PROMPT IS WHERE THE REMOTE IS. In transport mode OK already presses it (2b in
   * the key handler). With the controls up, the remote was left wherever it stood — usually the
   * scrubber, where OK pauses — so a viewer pressing OK at a white Skip Intro paused the film
   * instead. Now the button takes focus the moment it appears, and OK is all it needs. Not while
   * a box or the shelf is open, not mid-scrub, and not in the second and a half after a scrub
   * landed: someone who has just rewound INTO the intro is aiming the bar, and the next Left
   * press should keep rewinding rather than walk off the Skip button. */
  const panelUp = useRef(false);
  panelUp.current = menuOpen || audioOpen || epPanelOpen;
  useEffect(() => {
    if (!IS_TV || !promptShown || !skipMode || !tvNavRef.current) return;
    if (panelUp.current || seekPreviewRef.current != null) return;
    if (performance.now() - lastScrubAt.current < 1500) return;
    const id = requestAnimationFrame(() => {
      overlayRef.current?.querySelector<HTMLElement>('.vp-prompt.show .vp-pbtn.sel')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [skipMode, promptShown]);
  /* What OK does in transport mode while a prompt is up — read by the remote's handler, which is
   * bound once per mode and would otherwise see the prompt as it was when it was bound. */
  const promptRef = useRef<{ kind: 'intro' | 'recap' | 'next'; act: () => void } | null>(null);
  useEffect(() => {
    promptRef.current = promptShown && skipMode
      ? { kind: skipMode, act: skipMode === 'next' ? (promptSel === 'ghost' ? watchCredits : goNext) : skipAhead }
      : null;
  });

  if (!source) return <div className="vp-overlay" id="playerOverlay" />;

  /* While a remote scrub is pending the bar shows where it WOULD land, not where the video still
   * is — that preview is the entire feedback for a seek that has not happened yet. */
  const shownTime = seekPreview ?? cur;
  const pct = dur ? (shownTime / dur) * 100 : 0;
  const bufPct = dur ? (buffered / dur) * 100 : 0;
  /* Where the video ACTUALLY is while a preview is pending — the origin of the jump. The bar
   * paints the span between this and `pct` so the skip has a length on screen and not just a
   * number attached to it. */
  const curPct = dur ? (cur / dur) * 100 : 0;

  /* CHAPTERS, WHEN THE FILM OR EPISODE HAS REAL ONES. The recap, intro, credits and preview markers
   * cut the bar into pieces with a gap at each edge, and the piece the playhead is in is named under
   * the clock — "12:04 · Intro". Only real markers draw anything: the skip button's guessed intro
   * window is a heuristic for offering a button, not a claim about where the opening titles are,
   * and a gap drawn from a guess would be a line on the timeline that means nothing. */
  const endOf = (g: { end: number | null }) => (g.end != null ? g.end : dur);
  const recapSeg = segments?.recap && segments.recap.start < dur ? segments.recap : null;
  const introSeg = segments?.intro && segments.intro.end > segments.intro.start && segments.intro.start < dur ? segments.intro : null;
  const outroSeg = segments?.outro && segments.outro.start > 0 && segments.outro.start < dur ? segments.outro : null;
  const previewSeg = segments?.preview && segments.preview.start < dur ? segments.preview : null;
  const within = (g: { start: number; end: number | null } | null) => !!g && shownTime >= g.start && shownTime < endOf(g);
  const chapter = within(recapSeg) ? t('player.ch_recap')
    : within(introSeg) ? t('player.ch_intro')
    : within(outroSeg) ? t('player.ch_credits')
    : within(previewSeg) ? t('player.ch_preview')
    : '';
  const marks = dur > 0
    ? [recapSeg?.start, recapSeg?.end, introSeg?.start, introSeg?.end, outroSeg?.start, outroSeg?.end, previewSeg?.start]
      .filter((x): x is number => x != null && x > 2 && x < dur - 2)
      .map((x) => (x / dur) * 100)
      .sort((a, b) => a - b)
      .filter((p, i, a) => i === 0 || p - a[i - 1] > 0.5)
    : [];
  /* THE BAR IS DRAWN AS PIECES, one per chapter, each a pill with its own round ends — the gap
   * between two chapters is a pair of rounded caps facing each other, not a square notch cut out
   * of one long line. Each piece carries its own share of the played, buffered and scrub fills,
   * measured against its own length (`fillIn`). With no chapters it is one piece, the whole bar.
   * The playhead sits outside the pieces and is never cut. */
  const bounds = [0, ...marks, 100];
  const segs = bounds.slice(1).map((b, i) => [bounds[i], b] as const);
  const fillIn = (p: number, a: number, b: number) => `${clamp((p - a) / (b - a), 0, 1) * 100}%`;
  const logoSrc = source.logo && !logoFailed ? rasterLogo(source.logo, 'original') : '';

  /* INSIDE A BOX THE ARROWS WALK THE LIST, NOT THE GEOMETRY.
   *
   * TvSpatialNav picks the nearest candidate in the direction pressed, scored on travel and drift
   * — the right instrument for a screen of cards and the wrong one for a stacked list, where it
   * could step out of the box sideways onto an icon in the row underneath it. A list has an
   * unambiguous answer and it is DOM order: Up and Down are the row above and the row below, and
   * the ends stop rather than leave — the box is left with Back (or the button that opened it).
   * Left and Right are the box's two levels: Right opens the row it is on when there is a list
   * behind it, Left steps back out.
   *
   * Taken here, in the box's own handler, so it runs before TvSpatialNav (bound on the window) and
   * stops there; the TV's transport handler already stands aside while a box is open. A range
   * input keeps its own arrows — on the web they are what move the slider. */
  const onBoxKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    const box = e.currentTarget;
    const ae = document.activeElement as HTMLElement | null;
    if (!ae || !box.contains(ae) || ae.tagName === 'INPUT') return;
    e.preventDefault();
    e.stopPropagation();
    if (k === 'ArrowLeft') {
      if (boxLevel) { levelFrom.current = boxLevel; setBoxLevel(null); }
      return;
    }
    if (k === 'ArrowRight') {
      if (ae.classList.contains('vp-opt-sub')) ae.click();
      return;
    }
    const stops = Array.from(box.querySelectorAll<HTMLElement>('.vp-box-back, .vp-opt'))
      .filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled'));
    const to = stops[stops.indexOf(ae) + (k === 'ArrowDown' ? 1 : -1)];
    if (!to) return;
    to.focus({ preventScroll: true });
    // `nearest` does nothing when the row is already in view — the box only scrolls for a long list.
    to.scrollIntoView({ block: 'nearest' });
  };

  /* THE SUBTITLE TRACKS, GATHERED UNDER THEIR LANGUAGES — one row per language in the box.
   *
   * Grouped in the order each language FIRST APPEARS rather than alphabetically. `subs` is already
   * ordered by how likely the track is to be the one wanted — the viewer's preferred language and
   * the stream's embedded tracks come first — and sorting the languages A-Z would throw that away
   * to put Arabic above English on an English profile. First-appearance keeps the ranking and
   * still guarantees each language is named once.
   *
   * The index carried alongside each track is its position in the ORIGINAL array, because that is
   * what `selectSub` and `currentSub` speak. Grouping is a presentation of the list, not a
   * renumbering of it — a subtle but total difference if these ever drift apart. */
  const subGroups = (() => {
    const out: Array<{ lang: string; name: string; items: Array<{ s: SubCandidate; i: number }> }> = [];
    const at = new Map<string, number>();
    subs.forEach((s, i) => {
      /* NORMALISED AGAIN HERE, AND THAT IS NOT REDUNDANT. Both paths that fill `subs` today
       * already store a clean code, so this is a no-op for them — `normalizeSubLang('ru')` is
       * `ru`. It exists because grouping is the one place where a raw token does visible damage
       * (a whole extra heading reading RUS_FORCED_4), and the list has two producers today and
       * could have a third tomorrow. Guarding at the point of harm costs one map lookup per
       * track and cannot be forgotten by whoever adds the next origin. */
      const lang = normalizeSubLang(s.lang || '').code;
      let idx = at.get(lang);
      if (idx == null) {
        idx = out.length;
        at.set(lang, idx);
        out.push({ lang, name: langName(lang) || lang || t('menu.track').trim(), items: [] });
      }
      out[idx].items.push({ s, i });
    });
    return out;
  })();
  const spanFrom = Math.min(pct, curPct);
  const spanWidth = Math.abs(pct - curPct);

  // The subtitle look (lib/subtitles `cueLook`): on the player's own layer, and as ::cue for the
  // browser's drawing in picture-in-picture / native fullscreen.
  const cue = cueLook(settings);
  const cueCss = `#playerVideo::cue{color:${cue.color};background-color:${cue.background};font-family:${cue.fontFamily};`
    + `font-weight:${cue.fontWeight};font-style:${cue.fontStyle};font-size:${settings.subSize}%;text-shadow:${cue.textShadow}}`;
  const cueFs = Math.round(cueBox.vh * 0.05 * (settings.subSize / 100));
  const cueSpan = { background: cue.background, padding: cue.background === 'transparent' ? undefined : '0 .3em' };

  /* THE TAIL OF THE ICON ROW — web only. Three controls a television has no use for and a
   * browser cannot do without: NEITHER fullscreen nor picture-in-picture means anything on a set
   * that is already the whole screen, and volume is on the remote. On a page they are the only
   * way to those three things, so they sit at the far right end of the row, away from the
   * viewing controls. Phones drop all three in CSS — the side buttons, the OS's own PiP and the
   * phone itself do those jobs, and the tail squeezed the subtitles' room beside the row — and on
   * iOS the slider is dropped by the markup, because `video.volume` cannot be set there at all
   * (see VOL_LOCKED). */
  const tailRow = !IS_TV && (
    <div className="vp-controls vp-tail">
      <div className="vp-vol">
        <button className="vp-icon" id="vpMute" aria-label={t('ctl.mute_a')} aria-pressed={muted} onClick={toggleMute}>{IcMute}</button>
        {!VOL_LOCKED && (
          <input type="range" className="vp-vol-slider" id="vpVol" min={0} max={1} step={0.02} value={muted ? 0 : vol} aria-label={t('ctl.vol_a')}
            onChange={(e) => { const v = videoRef.current; if (v) { v.volume = +e.target.value; v.muted = +e.target.value === 0; } }} />
        )}
      </div>
      {(document.pictureInPictureEnabled || webkitPip) && (
        <button className="vp-icon" id="vpPip" aria-label={t('ctl.pip_a')} onClick={togglePip}>{IcPip}</button>
      )}
      <button className="vp-icon" id="vpFs" aria-label={t('ctl.fs_a')} aria-pressed={fs} onClick={toggleFs}>{IcFs}</button>
    </div>
  );

  /* THE PLAY DISC. BOTH GLYPHS ARE ALWAYS MOUNTED, one on top of the other, and the class decides
   * which is visible. Swapping `playing ? IcPause : IcPlay` replaces the node, and a node that
   * does not exist yet cannot animate out of anything — the best that gets you is the incoming
   * mark appearing while the outgoing one has already blinked away. Stacked, the change is one
   * state on one element: two opacities and two transforms cross over each other, which is the
   * only kind of transition that reads as one thing BECOMING another rather than as a cut.
   *
   * WEB ONLY, first in the icon row. A television has OK for this from anywhere — transport mode
   * and the scrubber both — and the TV row is modelled on the big streaming apps' rows, which
   * carry no play button for exactly that reason. On the web it is the play button, the only one, and a
   * <button> is what a click and a Tab key both expect. */
  const discInner = (
    <>
      <span className="ic-play">{IcPlay}</span>
      <span className="ic-pause">{IcPause}</span>
    </>
  );
  const playDisc = IS_TV
    ? null
    : <button type="button" className={`vp-play-disc${playing ? ' playing' : ''}`} id="vpPlay" aria-label={t('ctl.play_a')} onClick={togglePlay}>{discInner}</button>;

  /* THE ICON ROW, between the title and the scrubber, on BOTH builds.
   *
   * Episodes · Next · Subtitles · Audio · ⋯ — the row a viewer already knows from the big
   * streaming apps, sitting over the left end of the bar under the title's wordmark. The top of the
   * screen is left to the picture on a television.
   *
   * Episodes is in it on the TV too. Down from the bar still opens the shelf, and is still the quick
   * way; the button is the way a viewer who has never been told about Down finds it.
   *
   * The web adds what only a page needs: play/pause first (a mouse has no OK key), and volume,
   * picture-in-picture and fullscreen at the far end (`tailRow`).
   *
   * EACH OF THE THREE MENU BUTTONS OPENS A SMALL BOX HANGING OVER IT, not a sheet across the right
   * of the picture: a rounded dark card, its name in small capitals at the top, a plain list under
   * that, the selected row a white pill with a tick. All three are built the same way: a short first
   * list (subtitle languages, audio languages, the ⋯ sections), and a row with more behind it opens
   * that list in the same box, the same size, with a back row at the top.
   *
   * A VARIABLE RATHER THAN THE JSX TWICE. The boxes are a hundred lines of lists, and a second copy
   * behind an `IS_TV` branch is two copies to keep in step — the exact drift the add-on client's
   * header warns about, in a file where nobody would think to look. */
  const srcs = audioOpen ? source.sources : undefined;
  const srcLangs = srcs?.langs ?? [];
  // The language this playback is in, among the source languages — the one the Audio box ticks.
  const playLang = srcLangs.find((l) => l === source.lang) ?? '';
  const curSrc = srcs ? srcKey(srcs.current) : '';
  // What this playback is in, by name — for a file whose one track carries no language tag.
  const playName = langName(source.lang || source.langs?.[0] || '') || t('menu.audio_default');
  const pickSource = (x: AddonStream, lang: string) => {
    setAudioOpen(false);
    if (!srcs || srcKey(x) === curSrc) return;
    srcs.play(x, lang, videoRef.current?.currentTime ?? 0);
  };
  const curSubLang = currentSub >= 0 ? normalizeSubLang(subs[currentSub]?.lang || '').code : null;
  const subOpen = menuOpen && menuDoor === 'subs' && boxLevel ? subGroups.find((g) => g.lang === boxLevel) : undefined;
  const moreSec = menuOpen && menuDoor === 'more' ? (MORE_SECS.find((m) => m.key === boxLevel)?.key ?? null) : null;
  const moreValue = (k: MoreSec) => k === 'speed' ? `${rate}×`
    : k === 'quality' ? (curLevel < 0 ? t('menu.auto') : levelLabel(levels.find((l) => l.i === curLevel) ?? {}))
    : t(settings.enhance ? 'menu.on' : 'menu.off');
  const moreLabel = MORE_SECS.find((m) => m.key === moreSec)?.i18n;
  /* The row that steps back out of a second-level list: a chevron pointing back, and the name of
     the row that opened it. */
  const backRow = (label: string) => (
    <button type="button" className="vp-box-back" onClick={() => { levelFrom.current = boxLevel; setBoxLevel(null); }}>
      <span className="chev" aria-hidden="true" />{label}
    </button>
  );

  const controlsRow = (
    <div className="vp-controls" onFocus={(e) => { const el = e.target as HTMLElement; if (el.classList.contains('vp-icon') && el.id) rowLast.current = el.id; }}>
            {playDisc}
            {source.series && (
              <button className={`vp-icon${epPanelOpen ? ' on' : ''}`} id="vpEpisodes" aria-label={t('ctl.episodes_a')} aria-pressed={epPanelOpen}
                onClick={() => { railFrom.current = 'button'; setEpPanelOpen((o) => !o); }}>{IcEpisodes}</button>
            )}
            {source.next && (
              <button className="vp-icon" id="vpNext" aria-label={t('ctl.next_a')} title={IS_TV ? undefined : t('ctl.next_a')} onClick={startNext}>{IcNext}</button>
            )}

            {/* SUBTITLES: one row per LANGUAGE, the way the big apps list them. The add-ons often
                answer with a dozen files for one language, so a language with more than one opens
                its files in the same box (a chevron says so); a language with a single file is
                picked outright. The files are named by the add-on that sent them, numbered when
                several share a name. */}
            <div className="vp-menu-wrap">
              <button className={`vp-icon${menuOpen && menuDoor === 'subs' ? ' on' : ''}`} id="vpSubs"
                aria-label={t('ctl.subtitles_a')} title={IS_TV ? undefined : t('ctl.subtitles_a')} aria-haspopup="menu" aria-expanded={menuOpen && menuDoor === 'subs'}
                onClick={() => toggleMenu('subs')}>{IcSubs}</button>
              {menuOpen && menuDoor === 'subs' && (
                <div className="vp-box" role="menu" aria-label={t('menu.subtitles')} onKeyDown={onBoxKey}>
                  {subOpen ? (
                    <>
                      {backRow(subOpen.name)}
                      {subOpen.items.map(({ s: c, i }, n) => {
                        const name = c.source || c.label || c.lang || `${t('menu.track')}${i + 1}`;
                        const dupe = subOpen.items.some(({ s: o }, m) => m !== n && (o.source || o.label || o.lang) === name);
                        return (
                          <OptRow key={`${c.source || ''}${c.url}`} on={i === currentSub} label={name} sub={dupe ? `#${n + 1}` : undefined}
                            onClick={() => { selectSub(i); setMenuOpen(false); }} />
                        );
                      })}
                    </>
                  ) : (
                    <>
                      <div className="vp-box-title">{t('menu.subtitles')}</div>
                      <OptRow on={currentSub < 0} label={t('menu.off')} onClick={() => { selectSub(-1); setMenuOpen(false); }} />
                      {subGroups.map((g) => (
                        <OptRow key={g.lang} dataKey={g.lang} on={curSubLang === g.lang} label={g.name} drill={g.items.length > 1}
                          onClick={() => {
                            if (g.items.length > 1) { setBoxLevel(g.lang); return; }
                            selectSub(g.items[0].i);
                            setMenuOpen(false);
                          }} />
                      ))}
                      {/* The three end states are deliberately distinct: still asking, asked and
                          nothing came back, and nothing was asked because no subtitle add-on is
                          installed. The last one is the only one the user can act on. */}
                      {subsLoading && <div className="vp-box-note">{t('menu.loading_subs')}</div>}
                      {!subsLoading && subs.length === 0 && (
                        <div className="vp-box-note">{source.subsQuery ? t('menu.no_subs_found') : t('menu.install_sub_addon')}</div>
                      )}
                      {subFailed && <div className="vp-box-note warn">{t('menu.sub_failed')}</div>}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* AUDIO, ON EVERY STREAM, built the way Subtitles is: a list of LANGUAGES by name — the
                languages the add-ons offer this film or episode in — and a language opens its
                sources in the same box, ranked exactly as the title screen ranks them. Picking a
                source starts it from the second the current one had reached, so changing source is
                changing the voice, not starting over. When the file itself carries several tracks
                the player can switch between, those come first, above the languages. */}
            <div className="vp-menu-wrap">
              <button className={`vp-icon${audioOpen ? ' on' : ''}`} id="vpAudio"
                aria-label={t('ctl.audio_a')} title={IS_TV ? undefined : t('ctl.audio_a')} aria-haspopup="menu" aria-expanded={audioOpen}
                onClick={toggleAudio}>{IcAudioTrack}</button>
              {audioOpen && (
                <div className="vp-box" role="menu" aria-label={t('menu.audio')} onKeyDown={onBoxKey}>
                  {srcs && boxLevel ? (
                    <>
                      {backRow(langName(boxLevel))}
                      {/* Link-outs are left out: a source that opens a web page is not one to switch
                          a playing film to. */}
                      {srcs.list(boxLevel).filter((x) => x.kind !== 'external' && x.kind !== 'youtube').map((x) => {
                        const on = srcKey(x) === curSrc;
                        const ok = canStartHere(x);
                        return (
                          <button type="button" key={srcKey(x)} className={`vp-opt vp-src${on ? ' on' : ''}`} disabled={!ok} onClick={() => pickSource(x, boxLevel)}>
                            <span className={`quality-badge ${qualClass(x.quality)}`}>{x.quality || 'SD'}</span>
                            <span className="vp-src-txt">
                              <span className="vp-src-name">{x.label || x.source}</span>
                              <span className="vp-src-sub">{[x.size, x.source, !ok && t('menu.source_server')].filter(Boolean).join(' · ')}</span>
                            </span>
                            <span className="ck" aria-hidden="true">{on ? '✓' : ''}</span>
                          </button>
                        );
                      })}
                    </>
                  ) : (
                    <>
                      {/* TWO LISTS, EACH WITH ITS OWN TICK: the audio tracks inside THIS file (switched in
                          place), then the SOURCES — every other file of this title, by language. When
                          the file's tracks cannot be read the first list names the one playing. */}
                      <div className="vp-box-title">{t('menu.audio_tracks')}</div>
                      {audioTracks.length > 0 ? audioTracks.map((a, n) => {
                        const name = a.name || (audioTracks.length === 1 ? playName : `${t('menu.track')}${n + 1}`);
                        const dupe = !!a.name && audioTracks.some((o, m) => m !== n && o.name === a.name);
                        return (
                          <OptRow key={a.i} on={a.i === curAudio} label={name} sub={dupe ? `#${n + 1}` : undefined}
                            onClick={() => { if (a.i !== curAudio) selectAudio(a.i); setAudioOpen(false); }} />
                        );
                      }) : (
                        <OptRow on label={playName} onClick={() => setAudioOpen(false)} />
                      )}
                      {srcLangs.length > 0 && (
                        <>
                          <div className="vp-box-title vp-box-title-2">{t('menu.sources')}</div>
                          {srcLangs.map((l) => (
                            <OptRow key={l} dataKey={l} drill label={langName(l)} on={l === playLang} onClick={() => setBoxLevel(l)} />
                          ))}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ⋯ — SPEED, QUALITY, ENHANCE PICTURE. The box opens on a list of the three, each with its
                current value beside it; a row opens its own list in the same box, with a back row
                at the top (Back on the remote, Escape, or Left does the same). One list on screen
                at a time, always the size of the question being asked. */}
            <div className="vp-menu-wrap">
              <button className={`vp-icon${menuOpen && menuDoor === 'more' ? ' on' : ''}`} id="vpGear" aria-label={t('ctl.settings_a')} title={IS_TV ? undefined : t('ctl.settings_a')} aria-haspopup="menu" aria-expanded={menuOpen && menuDoor === 'more'} onClick={() => toggleMenu('more')}>{IcMore}</button>
              {menuOpen && menuDoor === 'more' && (
                <div className="vp-box" role="menu" aria-label={t('menu.settings')} onKeyDown={onBoxKey}>
                  {moreSec == null ? (
                    <>
                      <div className="vp-box-title">{t('menu.settings')}</div>
                      {MORE_SECS.map((m) => (
                        <div key={m.key} className="vp-opt vp-opt-sub" data-key={m.key} role="menuitem" tabIndex={0}
                          onClick={() => setBoxLevel(m.key)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBoxLevel(m.key); } }}>
                          <span className="lbl">{t(m.i18n)}</span>
                          <span className="val">{moreValue(m.key)}</span>
                          <span className="chev" aria-hidden="true" />
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      {backRow(moreLabel ? t(moreLabel) : '')}
                      {moreSec === 'speed' && SPEEDS.map((r) => (
                        <OptRow key={r} on={r === rate} label={`${r}×`} onClick={() => setSpeed(r)} />
                      ))}
                      {moreSec === 'quality' && (
                        <>
                          <OptRow on={curLevel < 0} label={t('menu.auto')} onClick={() => setLevel(-1)} />
                          {[...levels].sort((a, b) => (b.height || 0) - (a.height || 0)).map((l) => (
                            <OptRow key={l.i} on={l.i === curLevel} label={levelLabel(l)} onClick={() => setLevel(l.i)} />
                          ))}
                        </>
                      )}
                      {moreSec === 'enhance' && (
                        <>
                          {/* SWITCHING IT ON HAS TO LAND ON A LEVEL, not just raise a flag.
                              `enhance: !enhance` alone can produce an enhancement that is on and
                              doing nothing: the grain rows set `enhance: g > 0`, so choosing
                              "Grain · Off" is how you turn the whole thing off — which leaves
                              `grain` at 0. Switching back on from here then gave 0% grain, no row
                              ticked, and a picture identical to the one before the press.
                              So a level that is at Off comes up at LOW, which is where the
                              defaults start and the gentlest thing that is actually visible. A
                              level the viewer has already set to Medium or High is left alone —
                              this is a resume, not a reset. */}
                          <OptRow on={settings.enhance} label={t('menu.enhance_on')}
                            onClick={() => updateSettings(settings.enhance
                              ? { enhance: false }
                              : {
                                  enhance: true,
                                  grain: settings.grain > 0 ? settings.grain : TV_GRAIN[1],
                                  clarity: settings.clarity > 0 ? settings.clarity : TV_CLARITY[1],
                                })} />
                          {/* PRESETS ON THE TV, SLIDERS ON THE WEB — see TV_GRAIN above. A range
                              input is the one control a D-pad cannot get back out of: arrows move
                              the value, so nothing is left to move focus, and the remote is
                              trapped on it. A mouse has the opposite problem — four fixed steps
                              are a coarser instrument than the one it is holding. */}
                          {IS_TV ? (
                            <>
                              {TV_GRAIN.map((g, i) => (
                                <OptRow key={g} on={settings.enhance && settings.grain === g} label={`${t('ctl.grain')} · ${t(TV_LEVEL_KEYS[i])}`}
                                  onClick={() => updateSettings({ enhance: g > 0, grain: g })} />
                              ))}
                              {/* GATED ON `enhance`, THE SAME WAY THE GRAIN ROWS ARE. A ✓ against
                                  something that is not in effect is the menu disagreeing with the
                                  picture. */}
                              {TV_CLARITY.map((c, i) => (
                                <OptRow key={c} on={settings.enhance && settings.clarity === c} label={`${t('menu.clarity')} · ${t(TV_LEVEL_KEYS[i])}`}
                                  onClick={() => updateSettings({ clarity: c })} />
                              ))}
                            </>
                          ) : (
                            <>
                              <div className="vp-enh-row"><span className="vp-enh-label">{t('ctl.grain')}</span></div>
                              <div className={`vp-enh-slider${settings.enhance ? '' : ' off'}`}>
                                <input type="range" min={0} max={0.35} step={0.01} value={settings.grain} disabled={!settings.enhance} onChange={(e) => updateSettings({ grain: +e.target.value })} aria-label={t('ctl.grain')} />
                                <span className="vp-enh-val">{Math.round(settings.grain * 100)}%</span>
                              </div>
                              <OptRow on={settings.enhance && settings.clarity > 0} label={t('menu.clarity')} onClick={() => updateSettings({ clarity: settings.clarity > 0 ? 0 : 0.5 })} />
                              <div className={`vp-enh-slider${settings.enhance && settings.clarity > 0 ? '' : ' off'}`}>
                                <input type="range" min={0} max={1} step={0.05} value={settings.clarity} disabled={!settings.enhance || settings.clarity <= 0} onChange={(e) => updateSettings({ clarity: +e.target.value })} aria-label={t('ctl.clarity')} />
                                <span className="vp-enh-val">{Math.round(settings.clarity * 100)}%</span>
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            {tailRow}
    </div>
  );

  return (
    <div
      /* `tv-nav` is the flag TvSpatialNav watches: present means the D-pad drives the chrome,
         absent means the arrows are transport and it must stand down. `tv` / `web` are the
         styling hooks for the two builds' own stylesheets; `tv-rail` lifts the bar clear of the
         episode shelf on both. */
      className={`vp-overlay open pp-host${hideUi ? ' hide-ui' : ''}${settings.enhance ? ' enhance-on' : ''}${isTouch ? ' gestures-on' : ''}${webkitPip ? ' vp-has-webkit-pip' : ''}${IS_TV ? ' tv' : ' web'}${IS_TV && tvNav ? ' tv-nav' : ''}${railShown ? ' tv-rail' : ''}${ppOpen ? ' pp-on' : ''}${ppOpen && ppMiniGone ? ' pp-mini-gone' : ''}${switching != null ? ' vp-switching' : ''}${held ? ' vp-held' : ''}${jumping ? ' vp-jumping' : ''}${fill ? ' vp-fill' : ''}${parked ? ' vp-parked' : ''}`}
      id="playerOverlay"
      ref={overlayRef}
      /* Focusable-but-not-tabbable so the remote has somewhere to rest when it steps out of the
         control bar. -1 keeps it out of TvSpatialNav's candidate pool (it filters tabIndex < 0). */
      tabIndex={IS_TV ? -1 : undefined}
      style={{ ['--grain' as string]: settings.enhance ? settings.grain : 0 }}
      onPointerMove={bump}
      onClick={(e) => {
        /* A CLICK OUTSIDE A SHEET CLOSES IT — the settings sheet and the audio popup are the two
           layers on this screen with no close button of their own, and a mouse has no Back key.
           The click that closes one does nothing else: it must not also toggle playback. */
        const el = e.target as HTMLElement;
        if (menuOpen && !el.closest('.vp-box, #vpGear, #vpSubs')) { setMenuOpen(false); menuClosedAt.current = performance.now(); return; }
        if (audioOpen && !el.closest('.vp-box, #vpAudio')) { setAudioOpen(false); menuClosedAt.current = performance.now(); return; }
        if (e.target === videoRef.current) togglePlay();
      }}
    >
      {/* unsharp-mask filter for the Clarity control (kernel rewritten live above) */}
      <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <filter id="vpSharpen" colorInterpolationFilters="sRGB">
          <feConvolveMatrix ref={kernelRef} order="3" preserveAlpha="true" kernelMatrix="0 0 0 0 1 0 0 0 0" />
        </filter>
      </svg>
      <video
        id="playerVideo"
        ref={videoRef}
        playsInline
        style={{ filter: settings.enhance && settings.clarity > 0 ? 'url(#vpSharpen)' : undefined }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDur(v.duration || 0);
          // resume where we left off (once): the exact second of the source just switched away from,
          // else the saved progress for this title
          if (!resumedRef.current && source.startAt && source.startAt < (v.duration || Infinity)) {
            resumedRef.current = true;
            v.currentTime = source.startAt;
          } else if (!resumedRef.current && source.media?.key) {
            resumedRef.current = true;
            const r = getResume(source.media.key);
            if (r && r.pos > 0 && r.pos < (v.duration || Infinity)) v.currentTime = r.pos;
          }
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          /* NOT WHILE THE ELEMENT IS SEEKING. Browsers differ on what `currentTime` reads back
             between a seek being issued and it completing, and some report the OLD position for a
             tick or two — which would undo the seeding in commitSeek and put the recoil straight
             back. `seeking` is false again the moment the new position is real. */
          if (!v.seeking) setCur(v.currentTime);
          // throttle resume-progress writes to ~once/5s — and none while post-play holds the screen,
          // which has already marked the film finished (see openPostPlay)
          const now = v.currentTime;
          if (source.media?.key && !ppOpenRef.current && v.currentTime > 8 && Math.abs(now - lastProgRef.current) >= 5) {
            lastProgRef.current = now;
            putProgress(source.media.key, v.currentTime, v.duration || 0, source.media.lang);
          }
        }}
        onProgress={(e) => { const v = e.currentTarget; if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1)); }}
        onPlay={() => {
          setPlaying(true); bump();
          if (!recordedRef.current && source.media) {
            recordedRef.current = true;
            const m = source.media;
            record({ id: m.id, title: m.title, poster: m.poster, year: m.year, type: m.type, genre: m.genre, rating: m.rating, ep: m.ep, key: m.key, season: m.season, episode: m.episode, imdb: m.imdb, addonType: m.addonType, backdrop: m.backdrop });
          }
        }}
        onPause={() => { setPlaying(false); setHideUi(false); }}
        onWaiting={() => setLoading(true)}
        onPlaying={() => { setLoading(false); setErrKind(null); startedRef.current = true; if (switching != null) { setSwitching(null); window.clearTimeout(switchTimer.current); } }}
        onSeeked={() => { window.clearTimeout(jumpTimer.current); setJumping(false); }}
        onCanPlay={() => { setLoading(false); setErrKind(null); }}
        /* WHAT WENT WRONG IS IN `v.error.code`, AND THIS USED TO IGNORE IT.
         *
         * Every failure the element could report was labelled `codec`, which prints "This file
         * can't play in the browser · Many .mkv files use codecs browsers can't decode". For a
         * file that never started that is usually right. For one that had been playing for twenty
         * minutes it is self-evidently false — a stream the browser cannot decode does not play
         * twenty minutes of itself first — and it sends the viewer to the Quality menu to fix a
         * problem that is not there, while the actual cause (the host dropped, or the decoder
         * gave up on a frame) goes unnamed.
         *
         * The four codes are not shades of one thing:
         *   1 ABORTED           our own teardown, nearly always — switching source, closing the
         *                       player, hls.destroy(). Never an error to show anybody.
         *   2 NETWORK           the bytes stopped arriving. A source problem, whatever the codec.
         *   3 DECODE            the decoder failed on data it had accepted. Genuinely ambiguous:
         *                       before playback starts it means "cannot handle this", after
         *                       playback has started it means a bad segment or a decoder that
         *                       fell over — so `startedRef` decides, because "has this ever
         *                       rendered a frame" is exactly the question that separates them.
         *   4 SRC_NOT_SUPPORTED the only code that actually means what the codec message says.
         *
         * Also guarded on the TARGET. React simulates bubbling for `error`, which does not bubble
         * natively, so a failing child — the <track> below, whose blob can 404 or be revoked
         * mid-playback — dispatches through this handler as if the video itself had died. That
         * alone could put a codec error over a film that was playing perfectly. */
        onError={(e) => {
          if (e.target !== e.currentTarget) return;      // a child's failure is not the video's
          const err = e.currentTarget.error;
          if (import.meta.env.DEV) console.warn('[player] media error', err?.code, err?.message);
          if (err?.code === 1) return;                   // aborted: ours, and not worth a screen
          setLoading(false);
          const kind = err?.code === 2 ? 'source'
            : err?.code === 3 ? (startedRef.current ? 'source' : 'codec')
            : 'codec';
          setErrKind((k) => k ?? kind);
        }}
        onVolumeChange={(e) => { setVol(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
        onEnded={() => {
          setPlaying(false);
          /* The end of a film is post-play's last cue, whatever happened before it — including a
             viewer who chose to watch the credits, who has now watched them. */
          if (ppEligible) { ppDismissed.current = false; openPostPlay(); return; }
          if (settings.autoplayNext && source.next) startNext();
        }}
      >
        {/* `key` is the blob url so switching tracks REPLACES the element rather than
            mutating its src — a <track> that has already loaded keeps its old cues when
            src changes underneath it, which showed the previous language's subtitles. */}
        {vtt && <track key={vtt.url} kind="subtitles" src={vtt.url} srcLang={vtt.lang} label={vtt.label} />}
      </video>

      {/* subtitle appearance from Settings, for the browser's own drawing (picture-in-picture) */}
      <style>{cueCss}</style>

      {/* THE SUBTITLES, drawn by the player over the picture and the controls' shade (see `cueBox`). */}
      {!nativeCues && !ppOpen && cueLines.length > 0 && cueBox.vh > 0 && (
        <div className="vp-cues" aria-hidden="true"
          style={{ fontSize: cueFs, color: cue.color, fontFamily: cue.fontFamily, fontWeight: cue.fontWeight, fontStyle: cue.fontStyle, textShadow: cue.textShadow }}>
          {cueLines.some((l) => l.top) && (
            <div className="vp-cues-top">
              {cueLines.filter((l) => l.top).map((l, i) => <div className="vp-cue" key={i}><span style={cueSpan} dangerouslySetInnerHTML={{ __html: l.html }} /></div>)}
            </div>
          )}
          <div className="vp-cues-bottom" style={{ width: cueBox.w, transform: `translate(calc(-50% + ${cueBox.x}px), ${-cueBox.y}px)` }}>
            {cueLines.filter((l) => !l.top).map((l, i) => <div className="vp-cue" key={i}><span style={cueSpan} dangerouslySetInnerHTML={{ __html: l.html }} /></div>)}
          </div>
        </div>
      )}

      <div className="vp-grain" id="vpGrain" aria-hidden="true" />

      {/* mobile gesture surface: tap toggles chrome, double-tap sides seek ±10s,
          vertical drag = volume (right) / brightness (left), horizontal drag scrubs */}
      {isTouch && (
        <div className="vp-gestures" onTouchStart={onGestureStart} onTouchMove={onGestureMove} onTouchEnd={onGestureEnd} onTouchCancel={onGestureEnd}>
          <div className="vp-bright" style={{ opacity: clamp(1 - bright, 0, 0.85) }} />
          <div className={`vp-seekpulse left${seekHud?.side === 'left' ? ' show' : ''}`}>
            <span className="rip" />
            <span className="lbl">{IcRew}{(seekHud?.side === 'left' ? seekHud.secs : 10)}s</span>
          </div>
          <div className={`vp-seekpulse right${seekHud?.side === 'right' ? ' show' : ''}`}>
            <span className="rip" />
            <span className="lbl">{(seekHud?.side === 'right' ? seekHud.secs : 10)}s{IcFF}</span>
          </div>
          <div className={`vp-vhud${vHud ? ' show' : ''}${vHud?.note ? ' has-note' : ''}`}>
            <span className="ic">{vHud?.kind === 'bright' ? IcSun : (vHud && vHud.val <= 0.001 ? IcVolMuteHud : IcVolHud)}</span>
            <span className="bar"><i style={{ width: `${Math.round((vHud?.val ?? 0) * 100)}%` }} /></span>
            {vHud?.note && <span className="note">{vHud.note}</span>}
          </div>
          <div className={`vp-zoomhud${zoomHud ? ' show' : ''}`} role="status">{zoomHud}</div>
        </div>
      )}

      {/* NO SPINNER WHILE IT LOADS, on either build. The ring sat in the middle of the picture and
          dimmed the frame behind it for every rebuffer, which on a slow source was most of the
          film. The title stack and the bar are already up while a source starts, and a stalled
          picture with the clock not moving says "loading" without anything drawn over the film.
          The status stays for screen readers, unpainted (`.sr-only`), so the wait is still
          announced. */}
      {loading && !errKind && (
        <div className="sr-only" id="vpLoading" role="status" aria-live="polite">{t('player.preparing')}</div>
      )}

      {errKind && (
        <div className="vp-loading show" id="vpError" role="alert" aria-live="assertive">
          <div className="lt">{t(errKind === 'source' ? 'player.source_unavailable' : 'player.cant_play')}</div>
          <div className="ls" style={{ opacity: 0.75, maxWidth: 420, textAlign: 'center' }}>{t(errKind === 'source' ? 'player.source_unavailable_sub' : 'player.cant_play_sub')}</div>
        </div>
      )}

      {/* A TOAST AND NOT AN ERROR SCREEN, because this is not a failure: the video is
          playing correctly and only the audio track is undecodable. Blanking the frame
          over it would throw away the half that works. */}
      {/* Not while the audio menu is open — it is explaining the same thing in more detail
          three centimetres away, and the two boxes overlapped each other on screen. */}
      {silent && !audioOpen && (
        <div className="vp-silent" role="status" aria-live="polite">{t('player.silent')}</div>
      )}

      <div className="vp-ui">
        {/* THE TOP OF THE SCREEN IS THE PICTURE'S. The title, the episode and the corner group all
            moved down into the stack over the scrubber, so what is left up here is the status line
            and, on the web, the close button — a phone has no Escape key. NO CLOSE BUTTON ON A
            TELEVISION: Back on the remote closes the player, which is the gesture people already
            use to leave anything (see `registerBackHandler`). */}
        <div className="vp-top">
          <div className="vp-top-right">
            <div className="vp-status" id="playerStatus" role="status" aria-live="polite" />
            {!IS_TV && <button className="vp-icon" id="vpClose" title="Close (Esc)" aria-label={t('player.close')} onClick={close}>✕</button>}
          </div>
        </div>

        {/* THE STACK OVER THE BOTTOM EDGE, top to bottom: the title's wordmark, the episode line,
            the icon row, the scrubber running the full width, and the two clocks under its ends.
            The layout of the big streaming apps on a television, and the one a viewer reads
            without being taught: what is this, what can I do, where am I in it. */}
        <div className="vp-bottom">
          {/* KEYED ON WHAT IS PLAYING, so the next episode gets its own entrance rather than
              inheriting the last one's settled block. */}
          <div className="vp-meta" key={`${source.media?.key || source.url}${held ? ':held' : ''}`}>
            {logoSrc ? (
              /* THE WORDMARK, NOT THE NAME SET IN TYPE, whenever the title has one. It is the same
                 art the title screen showed a second ago (same raster size, so a cache hit), and it
                 carries the film's own lettering — which is the point of putting it here. It pops
                 in once it has decoded, not while it is still arriving: an entrance played over an
                 empty box is an entrance nobody saw. */
              <img
                className={`vp-logo${logoReady ? ' rdy' : ''}`}
                id="playerTitle"
                src={logoSrc}
                alt={source.title || ''}
                decoding="async"
                ref={(el) => { if (el?.complete && el.naturalWidth > 0 && !logoReady) setLogoReady(true); }}
                onLoad={() => setLogoReady(true)}
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <div className="vp-title" id="playerTitle">{source.title || ''}</div>
            )}
            {/* S1 | E3  "Lord Snow" — the label in the mono face, the episode's own name in quotes
                beside it, the way the big apps print it. */}
            {switching ? (
              <div className="vp-epline vp-epline-next" key={switching}>
                <span className="vp-subtitle" id="vpSubtitle">{switching}</span>
              </div>
            ) : source.subtitle && (
              <div className="vp-epline">
                <span className="vp-subtitle" id="vpSubtitle">{source.subtitle}</span>
                {epName && <span className="vp-eptitle">“{epName}”</span>}
              </div>
            )}
          </div>

          {controlsRow}

          <div
            className={`vp-progress${seekPreview != null ? ' seeking' : ''}${ramping ? ' ramping' : ''}${landed ? ' landed' : ''}`}
            id="vpProgress"
            ref={barRef}
            onPointerDown={onBarPointerDown}
            /* On the TV the bar is a control in its own right — the remote lands on it and
               Left/Right move the preview, which is exactly a slider. On the web it is a drag
               target and the keyboard's arrows do the same job from anywhere. */
            tabIndex={IS_TV ? 0 : undefined}
            role={IS_TV ? 'slider' : undefined}
            aria-label={IS_TV ? t('player.seek') : undefined}
            aria-valuemin={IS_TV ? 0 : undefined}
            aria-valuemax={IS_TV ? Math.round(dur) : undefined}
            aria-valuenow={IS_TV ? Math.round(shownTime) : undefined}
            aria-valuetext={IS_TV ? fmt(shownTime) : undefined}
          >
            <div className="vp-bar">
              {/* The pieces (see `segs`), each with its slice of the fills. `data-a`/`data-b` are
                  the piece's ends in percent of the film, for the web's playhead loop, which writes
                  the played width every frame without a render. */}
              {segs.map(([a, b], i) => (
                <div className="vp-seg" key={`${a}-${b}`}
                  style={{ left: i ? `calc(${a}% + var(--vp-gap))` : '0%', right: i < segs.length - 1 ? `calc(${100 - b}% + var(--vp-gap))` : '0%' }}>
                  <div className="vp-buffered" style={{ width: fillIn(bufPct, a, b) }} />
                  <div className="vp-played" data-a={a} data-b={b} style={{ width: fillIn(pct, a, b) }} />
                  {/* THE GROUND THE SCRUB HAS COVERED, drawn between where the video is and where
                      it would land — each piece paints the part of it that falls inside it. */}
                  {seekPreview != null && spanWidth > 0 && spanFrom < b && spanFrom + spanWidth > a && (
                    <div className="vp-seek-span" aria-hidden="true"
                      style={{ left: fillIn(spanFrom, a, b), width: `calc(${fillIn(spanFrom + spanWidth, a, b)} - ${fillIn(spanFrom, a, b)})` }} />
                  )}
                </div>
              ))}
              <div className="vp-thumb" id="vpThumb" ref={thumbRef} style={{ left: `${pct}%` }} />
            </div>
          </div>

          {/* THE CLOCKS SIT UNDER THE BAR'S ENDS, not beside them, so the bar runs the full width
              and the digits changing can never move it. Elapsed (and the chapter it is in) under
              the left end, the running time under the right. */}
          <div className="vp-times">
            <span className="vp-t vp-t-cur" id="vpCur">{fmt(shownTime)}</span>
            {chapter && <span className="vp-chapter">{chapter}</span>}
            <span className="vp-t vp-t-dur" id="vpDur">{dur > 0 ? fmt(dur) : ''}</span>
          </div>
        </div>
      </div>

      {/* THE PROMPT — see "THE PROMPTS COUNT DOWN" above. Bottom right, at the icon row's height. The
          selected button is the white one (`.sel`): the one OK presses, with the fill sweeping it. */}
      <div className={`vp-prompt${promptShown ? ' show' : ''}`}>
        {skipMode === 'next' ? (
          <>
            <button type="button" className={`vp-pbtn${promptSel === 'ghost' ? ' sel full' : ''}`} id="vpWatchCredits"
              onFocus={() => setPromptSel('ghost')} onClick={watchCredits}>
              <span>{t('player.watch_credits')}</span>
            </button>
            <button type="button" className={`vp-pbtn vp-pbtn-main${promptSel === 'main' ? ' sel' : ''}${settings.autoplayNext ? '' : ' full'}`} id="vpSkip"
              onFocus={() => setPromptSel('main')} onClick={goNext}>
              {settings.autoplayNext && promptShown && (
                <span className="vp-pfill" key={promptRun} aria-hidden="true"
                  style={{ animationDuration: `${NEXT_COUNT_S}s`, animationPlayState: playing ? 'running' : 'paused' }}
                  onAnimationEnd={goNext} />
              )}
              {IcPlaySolid}<span>{t('player.next_episode')}</span>
            </button>
          </>
        ) : skipMode ? (
          <button type="button" className={`vp-pbtn vp-pbtn-main sel${promptGone ? ' full' : ''}`} id="vpSkip" onClick={skipAhead}>
            {!promptGone && (
              <span className="vp-pfill" key={promptRun} aria-hidden="true"
                style={{ animationDuration: `${SKIP_SHOW_S}s`, animationPlayState: playing ? 'running' : 'paused' }}
                onAnimationEnd={() => setPromptGone(true)} />
            )}
            <span>{t(skipMode === 'recap' ? 'player.skip_recap' : 'player.skip_intro')}</span>
          </button>
        ) : null}
      </div>

      {/* IN-PLAYER EPISODES (series) — THE SHELF, ON BOTH BUILDS. `epPanelOpen` drives it, so
          the Episodes button, the keyboard's Down, the remote's Down, the Back chain and the
          focus-restore effect all share one "episodes are open" truth. The right-hand slide-in
          panel the web used to have is gone: a vertical list pinned to the right edge covered
          half the picture to show 118px thumbnails, and the next episode you want is one press
          away in the direction you are already looking — down, from the bar.

          Unmounted when closed, for the same reason the settings sheet is on the TV: parked
          off-screen it still has real geometry, so every card would be a live D-pad target while
          the shelf was shut. It also saves the season fetches on mount. `railMounted` outlives
          `epPanelOpen` by the length of the slide-down so the close can animate. */}
      {source.series && railMounted && (
        <EpisodeRail open={railShown} series={source.series} onClose={() => setEpPanelOpen(false)} />
      )}

      {/* POST-PLAY — mounted once armed (its data resolves while the film is still on), shown once
          the credits start. The film's own <video> above is what shrinks into the corner. */}
      {ppArmed && source.media && (
        <Suspense fallback={null}>
          <PostPlay media={source.media} open={ppOpen} miniGone={ppMiniGone} onBackToCredits={backToCredits} onAudible={onPpAudible} />
        </Suspense>
      )}
    </div>
  );
}
