import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { usePlayer } from '../../stores/player';
import { useHistory } from '../../stores/history';
import { useSettings } from '../../stores/settings';
import { useT } from '../../i18n/i18n';
import { loadHls, isHlsUrl, type HlsInstance } from '../../lib/hls';
import { toVttBlobUrl } from '../../lib/subtitles';
import { isDecodingSilently, SILENT_AFTER } from '../../lib/codecs';
import { resolvePlayback } from '../../lib/streamingServer';
import { playDemuxed, probeUrl, type DemuxHandle, type DemuxBlocker } from '../../lib/browserDemux';
import { playWithWasmAudio, needsWasmDecoder, type WasmAudioHandle } from '../../lib/wasmAudio';
import { langName, normalizeSubLang, collectAddonSubtitles } from '../../lib/addonClient';
import { apiFetch } from '../../lib/api';
import { registerBackHandler, BACK_LAYER, mediaAction } from '../../lib/tvKeys';
import EpisodePanel from './EpisodePanel';
import EpisodeRail from './EpisodeRail';
import TvChipMenu, { type ChipOption } from '../DetailModal/TvChipMenu';
import { scrollCardToSlot } from './railScroll';

/* THE TV BUILD IS A DIFFERENT PLAYER, and this constant is what splits them. `import.meta.env.MODE`
 * is a Vite compile-time string, so every `IS_TV` branch below is resolved at build time and the
 * losing side is dropped: the website never carries the remote-control code, and the TV never
 * carries the mouse-gesture code or the controls a set has no use for. See "TEN FEET AWAY" below. */
const IS_TV = import.meta.env.MODE === 'tv';

// skip-intro heuristic window (s) + credits-tail length when no IntroDB markers exist
const INTRO_FROM = 8, INTRO_TO = 92, CREDITS_TAIL = 35;
interface Segments { intro?: { start: number; end: number }; outro?: { start: number; end: number } }

const IcEpisodes = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 5h16v2H4zM4 11h16v2H4zM4 17h10v2H4z" /></svg>;

// friendly name for an HLS audio rendition + a snapped quality label (matches vanilla)
const AUDIO_NAMES: Record<string, string> = { eng: 'English', en: 'English', rus: 'Russian', ru: 'Russian', ka: 'ქართული', kat: 'ქართული', geo: 'ქართული', ukr: 'Ukrainian', uk: 'Ukrainian', tur: 'Turkish', fre: 'French', fr: 'French', ger: 'German', de: 'German', ita: 'Italian', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', spa: 'Spanish', es: 'Spanish' };
/* Accepts both track shapes: hls.js renditions ({name, lang}) and native
 * AudioTrack ({label, language}). The code lookup strips any region subtag so
 * "ru-RU" still resolves to "Russian" rather than falling through to the raw tag. */
function audioName(a: { name?: string; lang?: string; label?: string; language?: string }, i: number): string {
  const raw = a.lang || a.language || '';
  const tag = raw.toLowerCase().replace(/_/g, '-').split('-')[0];
  return a.name || a.label || AUDIO_NAMES[tag] || raw || `Track ${i + 1}`;
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

const Worm = (
  <svg className="vp-pl" viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">
    {/* THE SAME FOUR STOPS THE SCRUBBER'S PLAYED FILL USES, and horizontal for the same reason it
        is there: the worm travels a circle, so a gradient laid across the box paints it by
        POSITION — the dash cools from cyan through blue to indigo as it comes round, which is the
        one thing a static two-tone sweep could never do. Vertical (the grey it replaces) would
        have given a top half and a bottom half and looked like a lighting error. */}
    <defs>
      <linearGradient id="vpPlGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#64f8ff" />
        <stop offset="42%" stopColor="#1fa5f0" />
        <stop offset="72%" stopColor="#060eff" />
        <stop offset="100%" stopColor="#280880" />
      </linearGradient>
    </defs>
    <circle className="vp-pl__ring" r="56" cx="64" cy="64" fill="none" strokeWidth="16" strokeLinecap="round" />
    <path className="vp-pl__worm" d="M92,15.492S78.194,4.967,66.743,16.887c-17.231,17.938-28.26,96.974-28.26,96.974L119.85,59.892l-99-31.588,57.528,89.832L97.8,19.349,13.636,88.51l89.012,16.015S81.908,38.332,66.1,22.337C50.114,6.156,36,15.492,36,15.492a56,56,0,1,0,56,0Z" fill="none" stroke="url(#vpPlGrad)" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="44 1111" strokeDashoffset="10" />
  </svg>
);
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
const IcBack = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12.5 7V4l-5 5 5 5V11a4.5 4.5 0 1 1-4.5 4.5H6A6 6 0 1 0 12.5 7z" /></svg>;
const IcFwd = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M11.5 7V4l5 5-5 5V11A4.5 4.5 0 1 0 16 15.5h1.5A6 6 0 1 1 11.5 7z" /></svg>;
const IcMute = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M18.5 6a7 7 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const IcGear = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6h-3.8l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 11a7.8 7.8 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h3.8l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4zM12 15.2A3.2 3.2 0 1 1 12 8.8a3.2 3.2 0 0 1 0 6.4z" /></svg>;
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

/* The settings panel's four sections, in the order the chip offers them. Ordered by how often a
 * viewer comes here for each: Subtitles is why this menu gets opened most nights, Enhance picture
 * is set once and forgotten. Quality / source sits third whether or not the stream offers more
 * than one level — a list whose LENGTH depends on the release means the row under the remote
 * changes identity between one title and the next, and muscle memory is worth more than a saved
 * line. */
const SET_TABS = [
  { key: 'subs', i18n: 'menu.subtitles' },
  { key: 'speed', i18n: 'menu.speed' },
  { key: 'quality', i18n: 'menu.quality' },
  { key: 'enhance', i18n: 'menu.enhance' },
] as const;
type SetTab = typeof SET_TABS[number]['key'];

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

// each menu section's collapsible gear-header icon + a single checkable option row
const AccIc = <svg className="vp-acc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;

function OptRow({ on, label, sub, onClick }: { on: boolean; label: string; sub?: string; onClick: () => void }) {
  return (
    <div className={`vp-opt${on ? ' on' : ''}`} role="menuitemradio" aria-checked={on} tabIndex={0}
      onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <span className="ck">{on ? '✓' : ''}</span>{label}{sub ? <span className="sub">{sub}</span> : null}
    </div>
  );
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

export default function VideoPlayer() {
  const t = useT();
  const source = usePlayer((s) => s.source);
  const close = usePlayer((s) => s.close);
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
  const [acc, setAcc] = useState<Record<string, boolean>>({}); // expanded accordion sections (web)
  const [setTab, setSetTab] = useState<SetTab>('subs');        // which section the TV panel is showing
  const [subLang, setSubLang] = useState<string | null>(null); // which language group is expanded
  const [fs, setFs] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  /* Every subtitle track OFFERED for this source — the ones embedded in the stream plus
   * everything the installed subtitle add-ons answered. URLs only; see the block above
   * `resolveSub` for why exactly one of these is ever downloaded. */
  const [subs, setSubs] = useState<SubCandidate[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);   // add-ons still being asked
  const [subFailed, setSubFailed] = useState(false);       // the chosen track would not load
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
  // why in-page demuxing is not driving this source; null when it is
  const [demuxBlocker, setDemuxBlocker] = useState<DemuxBlocker | null>(null);
  const ccOn = currentSub >= 0;

  // --- TV remote (see "TEN FEET AWAY" above; all of this is dropped from the web build) ---
  const [tvNav, setTvNav] = useState(false);              // the D-pad is driving the chrome
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [landed, setLanded] = useState(false);            // the half-second after a scrub commits
  const [ramping, setRamping] = useState(false);          // a held button is driving the preview continuously
  const tvNavRef = useRef(false);                         // fresh read from bump()'s timer
  const seekPreviewRef = useRef<number | null>(null);     // fresh read from the key handler
  const seekCommitTimer = useRef<number | undefined>(undefined);
  const landedTimer = useRef<number | undefined>(undefined);
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
  const tvWantFocus = useRef<'bar' | 'scrubber' | 'gear' | 'episodes'>('bar'); // where the bar should re-seed focus
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
  const [vHud, setVHud] = useState<{ kind: 'vol' | 'bright'; val: number } | null>(null);
  const hideUiRef = useRef(false);                    // fresh read for deferred single-tap
  const gestRef = useRef({ active: false, x0: 0, y0: 0, t0: 0, w: 1, h: 1, mode: '' as '' | 'seek' | 'vol' | 'bright', startVol: 1, startBright: 1, startTime: 0 });
  const lastTapRef = useRef({ t: 0, x: 0, side: '' as '' | 'left' | 'center' | 'right' });
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
    setPlaySrc(null); setLoading(true); setErrKind(null); setSilent(false); setDemuxBlocker(null);
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
            // audio renditions + preferred audio language
            if (hls.audioTracks && hls.audioTracks.length > 1) {
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
            if (hls.audioTracks && hls.audioTracks.length > 1) {
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
              setDemuxBlocker(null);
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
          setDemuxBlocker(probe.reason);
          v.src = url; v.play().catch(() => {});
          return;
        }
        setDemuxBlocker(null);
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
      if (!list || list.length < 2) return;
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
    setVtt(null);
    setSubFailed(false);
    subPicked.current = false;

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

  /* Honour the default-subtitles-language setting — ONCE, and only until the user disagrees.
   *
   * `subPicked` is why this is not simply keyed on the list: the add-on tracks arrive after
   * the menu is already usable, so this effect necessarily re-runs on a list the user may
   * have already made a choice in, and without the flag it would overrule them a second or
   * two into playback. It also lets an add-on's Georgian win when the stream carried none:
   * the preference is re-evaluated against the grown list precisely while the user has
   * expressed no preference of their own. */
  useEffect(() => {
    if (subPicked.current || !subs.length) return;
    const want = settings.subLang;
    if (want === 'off') return;
    const i = subs.findIndex((s) => s.lang?.toLowerCase().startsWith(want));
    if (i >= 0) setCurrentSub(i);
  }, [subs, settings.subLang]);

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
    if (!c) { setVtt(null); return; }
    const hit = vttCache.current.get(c.url);
    if (hit) { setVtt({ lang: c.lang, label: c.label, url: hit }); setSubFailed(false); return; }
    let alive = true;
    setSubFailed(false);
    void toVttBlobUrl(c.url).then((url) => {
      if (!alive) return;
      if (!url) {
        /* A subtitle host without permissive CORS cannot be read from a browser at all, and
         * that is most of them. Saying so beats a row that ticks and shows nothing. */
        setVtt(null); setSubFailed(true); return;
      }
      vttCache.current.set(c.url, url);
      setVtt({ lang: c.lang, label: c.label, url });
    });
    return () => { alive = false; };
  }, [subs, currentSub]);

  // one mounted <track> at a time, so showing it is not an index lookup
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const tt = v.textTracks[0];
    if (tt) tt.mode = vtt ? 'showing' : 'hidden';
  }, [vtt]);

  // drop every converted subtitle when the source changes (and on unmount)
  useEffect(() => () => {
    vttCache.current.forEach((u) => URL.revokeObjectURL(u));
    vttCache.current.clear();
  }, [source]);

  // IntroDB intro/outro markers for the current episode (best-effort; the skip button
  // falls back to the heuristic window when there are none)
  useEffect(() => {
    setSegments(null);
    const s = source?.series;
    if (!s?.imdb) return;
    let alive = true;
    apiFetch(`/api/introdb/${encodeURIComponent(s.imdb)}/${s.season}/${s.ep}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && (d.intro || d.outro)) setSegments(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [source?.series]);

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
  const nudge = useCallback((d: number) => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d)); }, []);

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
       * being. A half-second ring off the playhead gives the scrub a full stop, and it fires the
       * instant the seek is issued rather than when the frame arrives, so it also covers the
       * decode gap that is otherwise dead air on a slow TV. */
      setLanded(true);
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
      if (menuOpen || epPanelOpen) return;            // the panel seeds its own first row
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
        ?? (tvWantFocus.current === 'episodes' ? root.querySelector<HTMLElement>('#vpEpisodes') : null)
        ?? (tvWantFocus.current === 'scrubber' ? barRef.current : null)
        ?? root.querySelector<HTMLElement>('.vp-skip.show')
        ?? barRef.current
        ?? root.querySelector<HTMLElement>('#vpPlay');
      tvWantFocus.current = 'bar';
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [tvNav, menuOpen, epPanelOpen]);

  /* THE SETTINGS MENU OPENS WITH SUBTITLES ALREADY SELECTED.
   *
   * Nothing used to seed focus into this panel at all — the effect above explicitly stands aside
   * for it ("the panel seeds its own first row"), which was true of the episode rail and never
   * true here. So focus stayed on the ⋯ button OUTSIDE the menu, and the first Down handed the
   * question to TvSpatialNav, which answers it geometrically: it picks whatever is nearest in
   * that direction, which is not reliably the top row and was landing on Enhance picture. A menu
   * that opens on its last item reads as though it remembered something the viewer never chose.
   *
   * Subtitles is the answer rather than "the first row" by coincidence: it is the first row AND
   * the reason this menu is opened most of the time, and on a TV those two agreeing is what makes
   * the common case cost one press. Taking the first control in DOM order gives it without
   * hard-coding an id — if the rows are ever reordered, this follows the order rather than
   * contradicting it. Two selectors because the panel is chips on a television and accordions on
   * the web, and this effect is the one piece of it that both builds share.
   *
   * A frame's delay, because the panel is mounted by the same render that sets `menuOpen` and is
   * not in the document to be focused until after it commits. */
  useEffect(() => {
    if (!IS_TV || !menuOpen) return;
    // Every open starts on Subtitles rather than resuming wherever the last visit ended. The panel
    // is opened for one errand at a time and the common errand is subtitles; remembering a section
    // the viewer chose ten minutes ago only means they have to notice and undo it.
    setSetTab('subs');
    /* The language currently in use comes up expanded; with subtitles off, everything is closed.
     * Opening on the group you are already in is what makes "same language, different file" — the
     * reason most people return to this list — cost no presses to reach, while a viewer who wants
     * a different language sees an unexpanded index of what is available instead of one language's
     * files pushing the rest off the screen. Deliberately keyed on the OPEN rather than on
     * `currentSub`: re-deriving it whenever the selection changes would slam a group shut under
     * the remote the moment a track from another language was chosen. */
    setSubLang(currentSub >= 0 ? (subs[currentSub]?.lang || null) : null);
    const id = requestAnimationFrame(() => {
      overlayRef.current?.querySelector<HTMLElement>('#vpMenu .tv-chipmenu-btn, #vpMenu .vp-acc-head')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [menuOpen]);
  /* Drive the rail's mount/slide off `epPanelOpen`. 470ms is the 420ms transform (`--vp-rail-ease`
   * in tv.css) plus margin; it only has to OUTLAST the animation — unmounting a few ms late costs
   * nothing, unmounting early is the blink this exists to prevent, so if the curve is ever
   * lengthened this number goes up with it. */
  useEffect(() => {
    if (!IS_TV) return;
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
  const selectSub = (i: number) => { subPicked.current = true; setCurrentSub(i); };
  const toggleCC = () => { if (!subs.length) return; selectSub(ccOn ? -1 : Math.max(0, currentSub)); };
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
  const toggleAcc = (sec: string) => setAcc((a) => ({ ...a, [sec]: !a[sec] }));

  // scrub
  const seekToClient = useCallback((clientX: number) => {
    const bar = barRef.current, v = videoRef.current; if (!bar || !v || !v.duration) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    v.currentTime = ratio * v.duration;
  }, []);
  const onBarPointerDown = (e: React.PointerEvent) => {
    seekToClient(e.clientX);
    const move = (ev: PointerEvent) => seekToClient(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- touch gesture handlers (single tap toggles chrome; double-tap the left/right
  // third seeks ±10s and accumulates; a vertical drag adjusts volume on the right half
  // and brightness on the left; a horizontal drag scrubs) ---
  const showVHud = (kind: 'vol' | 'bright', val: number) => { window.clearTimeout(vHudTimer.current); setVHud({ kind, val }); };
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

  const onGestureStart = (e: React.TouchEvent) => {
    const g = gestRef.current;
    if (e.touches.length !== 1) { g.active = false; return; }   // ignore pinch/multi-touch
    const el = overlayRef.current, v = videoRef.current; if (!el) return;
    const r = el.getBoundingClientRect(), tch = e.touches[0];
    g.active = true; g.mode = ''; g.t0 = performance.now();
    g.x0 = tch.clientX - r.left; g.y0 = tch.clientY - r.top; g.w = r.width; g.h = r.height;
    g.startVol = v?.muted ? 0 : (v?.volume ?? 1); g.startBright = bright; g.startTime = v?.currentTime ?? 0;
  };
  const onGestureMove = (e: React.TouchEvent) => {
    const g = gestRef.current;
    if (!g.active || e.touches.length !== 1) return;
    const el = overlayRef.current, v = videoRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.touches[0].clientX - r.left) - g.x0, dy = (e.touches[0].clientY - r.top) - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;       // below intent threshold
      g.mode = Math.abs(dx) > Math.abs(dy) ? 'seek' : (g.x0 < g.w / 2 ? 'bright' : 'vol');
      if (g.mode === 'seek') { setHideUi(false); window.clearTimeout(hideTimer.current); } // reveal scrubber
    }
    const span = g.h * 0.6;                                     // full-scale drag distance
    if (g.mode === 'vol' && v) {
      const nv = clamp(g.startVol - dy / span, 0, 1);
      v.volume = nv; v.muted = nv <= 0.001;
      showVHud('vol', nv);
    } else if (g.mode === 'bright') {
      const nb = clamp(g.startBright - dy / span, 0.15, 1);
      setBright(nb); showVHud('bright', (nb - 0.15) / 0.85);
    } else if (g.mode === 'seek' && v && v.duration) {
      const reach = Math.min(v.duration, 180);                  // full swipe = ±180s (or whole clip)
      v.currentTime = clamp(g.startTime + (dx / g.w) * reach, 0, v.duration);
    }
  };
  const onGestureEnd = () => {
    const g = gestRef.current;
    if (!g.active) return;
    g.active = false;
    if (g.mode) {                                               // a drag — settle HUDs
      if (g.mode === 'vol' || g.mode === 'bright') hideVHudSoon();
      else bump();                                              // scrub: restart auto-hide
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
        if (hideUiRef.current) bump(); else { setHideUi(true); window.clearTimeout(hideTimer.current); }
      }, 280);
    }
  };

  // clear gesture timers on unmount
  useEffect(() => () => { window.clearTimeout(singleTapTimer.current); window.clearTimeout(seekHudTimer.current); window.clearTimeout(vHudTimer.current); }, []);

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
      /* Escape walks OUT one layer at a time. It used to close the whole player from anywhere,
       * so dismissing the gear menu tore down playback with it — two layers deep, wrong layer
       * closed. (On TV this handler never sees Escape at all: lib/tvKeys.ts resolves Back in the
       * capture phase and swallows it. The same order is repeated here because the website has
       * no such resolver and the bug was the website's too.) */
      if (e.key === 'Escape') {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (audioOpen) setAudioOpen(false);
        else if (menuOpen) setMenuOpen(false);
        else if (epPanelOpen) setEpPanelOpen(false);
        else close();
        return;
      }
      /* Transport keys belong to the VIDEO, so they stand down while a panel is over it —
       * otherwise Left/Right seeks the film underneath the menu the user is reading. */
      if (menuOpen || epPanelOpen) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') nudge(-10);
      else if (e.key === 'ArrowRight') nudge(10);
      else if (e.key === 'm') toggleMute();
      else if (e.key === 'f') toggleFs();
      bump();
    };
    const onFs = () => setFs(!!document.fullscreenElement);
    /* NOT ON THE TV. The remote handler below replaces this one wholesale rather than layering
     * over it — these bindings assume a keyboard (space, k, m, f) and, worse, an unconsumed
     * ArrowLeft reaching here would seek the film a second time on top of the scrub the remote
     * handler had already started. The fullscreen listener stays either way; it costs nothing
     * and a TV shell can still be in and out of it. */
    if (!IS_TV) window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onFs); };
  }, [source, close, togglePlay, nudge, toggleMute, toggleFs, bump, menuOpen, epPanelOpen]);

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
      const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
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
        else if (m === 'next') source.next?.();
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

      // A panel over the bar owns the D-pad completely — spatial nav walks it, and seeking
      // the film underneath a list the viewer is reading is the bug this exists to prevent.
      if (menuOpen || epPanelOpen) return;

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
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        const ae = document.activeElement as HTMLElement | null;
        const row = ae?.closest<HTMLElement>('.vp-controls');
        if (row && ae) {
          const items = Array.from(row.querySelectorAll<HTMLElement>('button, [tabindex]'))
            .filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length > 0);
          const at = items.indexOf(ae);
          if (at >= 0) {
            consume();
            items[at + (k === 'ArrowRight' ? 1 : -1)]?.focus({ preventScroll: true });
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
  }, [source, tvNav, menuOpen, epPanelOpen, tvSeek, tvSeekRelease, commitSeek, enterTvNav, togglePlay, close, bump]);

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
   * panel, then playback — one press each. Inert on the website, where nothing installs the
   * resolver that calls these. */
  useEffect(() => {
    if (!source) return;
    return registerBackHandler(() => {
      // The hint tells the focus effect which button to hand the remote back to — see there.
      if (menuOpen) { tvWantFocus.current = 'gear'; setMenuOpen(false); return true; }
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
      return false;
      /* Registered AT THE PLAYER'S OWN LEVEL so that "falls through to the app's chain" means the
       * player closes, and not that the title screen underneath quietly steps its own view back
       * first — which is exactly what a series cost: one wasted press with nothing visibly
       * happening. See BACK_LAYER. */
    }, BACK_LAYER.player);
  }, [source, menuOpen, audioOpen, epPanelOpen]);

  // picture-enhance: rewrite the unsharp-mask convolution kernel from the clarity
  // slider (identity at 0 → 3×3 Laplacian sharpen at 1; energy-preserving so it
  // doesn't shift brightness)
  useEffect(() => {
    const k = kernelRef.current; if (!k) return;
    const c = settings.clarity;
    k.setAttribute('kernelMatrix', `0 ${-c} 0 ${-c} ${1 + 4 * c} ${-c} 0 ${-c} 0`);
  }, [settings.clarity]);

  if (!source) return <div className="vp-overlay" id="playerOverlay" />;

  /* While a remote scrub is pending the bar shows where it WOULD land, not where the video still
   * is — that preview is the entire feedback for a seek that has not happened yet. */
  const shownTime = seekPreview ?? cur;
  const seekDelta = seekPreview == null ? 0 : Math.round(seekPreview - cur);
  const pct = dur ? (shownTime / dur) * 100 : 0;
  const bufPct = dur ? (buffered / dur) * 100 : 0;
  /* Where the video ACTUALLY is while a preview is pending — the origin of the jump. The bar
   * paints the span between this and `pct` so the skip has a length on screen and not just a
   * number attached to it. */
  const curPct = dur ? (cur / dur) * 100 : 0;
  /* Width of both TV clocks, in characters of the longest string either will ever hold. The floor
   * of 5 ("00:00") stops the cell — and so the bar — resizing once when the duration arrives and
   * "0:00" becomes "24:15". */
  const clockCh = Math.max(5, fmt(dur).length);

  /* UP AND DOWN INSIDE THE SETTINGS PANEL WALK THE LIST, NOT THE GEOMETRY.
   *
   * TvSpatialNav picks the nearest candidate in the direction pressed, scored on travel and
   * drift. That is the right instrument for a screen of cards and the wrong one here, because
   * this panel's rows are full-width and stacked: several of them are almost equally "up" from
   * any given row, and the language headings sit inline among the tracks they introduce. From a
   * source row, Up could land on the heading above it, on a row two groups away, or on the
   * section chip, depending on pixels the viewer cannot see and did not choose.
   *
   * A list has an unambiguous answer and it is DOM order. Up from the first track of a language
   * is that language's own heading — the button that opened it, which is what a viewer reaching
   * back up is reaching for — and Up from a heading is whatever the list actually holds above it.
   * Down is the same walk in reverse. Nothing here depends on how the rows happen to be laid out.
   *
   * DELIBERATELY NOT EXHAUSTIVE. `.vp-speed` is left out: the speeds are a horizontal grid, and
   * pulling them into a vertical walk would make Down step sideways through 0.5×, 0.75×, 1×.
   * Focus sitting anywhere this list does not name falls through untouched, which is also what
   * carries the remote out of the panel at either end — the ends are not trapped, so Up from the
   * chip still leaves for the bar above it. */
  const onSetPanelKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const ae = document.activeElement as HTMLElement | null;
    if (!ae) return;
    const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.tv-chipmenu-btn, .vp-subgroup-head, .vp-opt'));
    const at = stops.indexOf(ae);
    if (at < 0) return;
    const to = stops[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!to) return;
    e.preventDefault();
    e.stopPropagation();
    to.focus({ preventScroll: true });
    // `nearest` honours the row's scroll-margin and does nothing when it is already on screen,
    // which is the common case — the panel only scrolls for a long list.
    to.scrollIntoView({ block: 'nearest' });
  };

  /* THE SUBTITLE TRACKS, GATHERED UNDER THEIR LANGUAGES (TV panel only).
   *
   * Grouped in the order each language FIRST APPEARS rather than alphabetically. `subs` is already
   * ordered by how likely the track is to be the one wanted — the viewer's preferred language and
   * the stream's embedded tracks come first — and sorting the headings A-Z would throw that away
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
  const hasSubs = subs.length > 0;

  // ::cue styling from the subtitle settings (color / bg / size / outline)
  const ow = settings.subOutlineW, oc = settings.subOutline;
  const cueOutline = ow > 0 ? `text-shadow:${-ow}px ${-ow}px 0 ${oc},${ow}px ${-ow}px 0 ${oc},${-ow}px ${ow}px 0 ${oc},${ow}px ${ow}px 0 ${oc};` : '';
  const cueCss = `#playerVideo::cue{color:${settings.subColor};background-color:${settings.subBg};font-size:${settings.subSize}%;${cueOutline}}`;

  // contextual skip button: "Skip Intro" in the intro window, "Next Episode" in the
  // credits tail — IntroDB markers when available, else the heuristic (series, 5min+)
  let skipMode: 'intro' | 'next' | null = null;
  let skipTo = INTRO_TO;
  if (source.series && dur >= 300) {
    const intro = segments?.intro && segments.intro.end < dur ? segments.intro : null;
    const outroStart = segments?.outro && segments.outro.start > 0 && segments.outro.start < dur ? segments.outro.start : null;
    const nextAt = outroStart != null ? outroStart : dur - CREDITS_TAIL;
    if (source.next && cur >= nextAt && dur - cur > 0.5) skipMode = 'next';
    else {
      const inIntro = intro ? (cur >= intro.start && cur <= intro.end) : (cur >= INTRO_FROM && cur <= INTRO_TO);
      if (inIntro) { skipMode = 'intro'; skipTo = intro ? intro.end : INTRO_TO; }
    }
  }

  /* THE CONTROL GROUP, BUILT ONCE AND MOUNTED IN ONE OF TWO PLACES.
   *
   * On the web it is the row under the scrubber, exactly as before. On a television everything
   * in it that belonged to a transport row has been taken out — play moved into the scrubber
   * line as a badge, skip and mute went to the remote, CC went to the menu it duplicates, and
   * Episodes went to the shelf that Down already opens — which leaves the audio picker and the
   * settings menu. Those two are not transport; they are what the corner of a TV player is for,
   * so on that build this whole group is rendered inside `.vp-top-right` instead.
   *
   * A VARIABLE RATHER THAN THE JSX TWICE. The settings menu underneath is two hundred lines of
   * accordions, and a second copy behind an `IS_TV` branch is two copies to keep in step — the
   * exact drift the add-on client's header warns about, in a file where nobody would think to
   * look for it. Built here, mounted once, in whichever parent the build calls for. */
  const controlsRow = (
    <div className="vp-controls">
            {/* Play is the scrubber line's own disc on a TV — see the note where it is rendered. */}
            {!IS_TV && <button className="vp-icon" id="vpPlay" aria-label={t('ctl.play_a')} onClick={togglePlay}>{playing ? IcPause : IcPlay}</button>}
            {/* SKIP ±10 AND MUTE ARE WEB-ONLY NOW, and both for the same reason: on a television
                the remote already does them better than a button the viewer has to walk to.
                Left/Right on the scrubber seek, with a step that grows while the key is held (see
                "SEEKING IS PREVIEWED" above) — reaching a ⏪ button costs presses to do something
                worse. Mute is on the remote and handled below the browser on all three TV
                platforms, exactly as volume already was; the note that kept mute here argued it
                "IS ours", which was true and is not the same as it being worth a slot in a row
                walked by a D-pad. Nothing is lost from the web player. */}
            {!IS_TV && (
              <>
                <button className="vp-icon" id="vpBack" aria-label={t('ctl.back_a')} onClick={() => nudge(-10)}>{IcBack}</button>
                <button className="vp-icon" id="vpFwd" aria-label={t('ctl.fwd_a')} onClick={() => nudge(10)}>{IcFwd}</button>
                <div className="vp-vol">
                  <button className="vp-icon" id="vpMute" aria-label={t('ctl.mute_a')} aria-pressed={muted} onClick={toggleMute}>{IcMute}</button>
                  <input type="range" className="vp-vol-slider" id="vpVol" min={0} max={1} step={0.02} value={muted ? 0 : vol} aria-label={t('ctl.vol_a')}
                    onChange={(e) => { const v = videoRef.current; if (v) { v.volume = +e.target.value; v.muted = +e.target.value === 0; } }} />
                </div>
                <div className="vp-time">
                  <span id="vpCur">{fmt(shownTime)}</span> / <span id="vpDur">{fmt(dur)}</span>
                  {seekDelta !== 0 && <span className="vp-seekdelta">{seekDelta > 0 ? '+' : '−'}{fmt(Math.abs(seekDelta))}</span>}
                </div>
              </>
            )}
            {!IS_TV && <div className="vp-spacer" />}
            {/* EPISODES AND CC ARE WEB-ONLY NOW, and both are duplicates on a television rather
                than losses. Down from the scrubber opens the episode shelf, which is a better
                instrument than this button ever was and is already one press away; and the CC
                toggle only ever switched between "off" and "the first track", which the menu's
                Subtitles list does with the track names visible. Two fewer stops in a row the
                D-pad walks, and nothing that can no longer be reached. */}
            {!IS_TV && source.series && (
              <button className={`vp-icon${epPanelOpen ? ' on' : ''}`} id="vpEpisodes" aria-label={t('ctl.episodes_a')} aria-pressed={epPanelOpen}
                onClick={() => { railFrom.current = 'button'; setEpPanelOpen((o) => !o); }}>{IcEpisodes}</button>
            )}
            {!IS_TV && hasSubs && (
              <button className={`vp-icon cc${ccOn ? ' on' : ''}`} id="vpCC" aria-label={t('ctl.subs_a')} aria-pressed={ccOn} onClick={toggleCC}>CC</button>
            )}

            {/* AUDIO TRACK — a control bar button, not a row buried three levels into the gear
                menu's Settings accordion, which is where the only way to change audio used to
                live. It is rendered whenever the RELEASE claims more than one language, even
                when none of them can be selected, because "the button is missing" and "this
                browser cannot switch tracks" look identical from the outside and only one of
                them is true. When it cannot switch it says so in place of the list. */}
            {(audioTracks.length > 1 || (source.langs?.length ?? 0) > 1) && (
              <div className="vp-menu-wrap">
                <button
                  className={`vp-icon${audioOpen ? ' on' : ''}${audioTracks.length > 1 ? '' : ' vp-icon-muted'}`}
                  id="vpAudio" aria-label={t('ctl.audio_a')} aria-haspopup="menu" aria-expanded={audioOpen}
                  onClick={() => { setAudioOpen((o) => !o); setMenuOpen(false); }}
                >{IcAudioTrack}</button>
                {(!IS_TV || audioOpen) && (
                  <div className={`vp-menu vp-audio-menu${audioOpen ? ' open' : ''}`} role="menu">
                    <div className="vp-menu-title">{t('menu.audio_lang')}</div>
                    {audioTracks.length > 1 ? (
                      audioTracks.map((a) => (
                        <OptRow key={a.i} on={a.i === curAudio} label={a.name} onClick={() => { selectAudio(a.i); setAudioOpen(false); }} />
                      ))
                    ) : (
                      <div className="vp-menu-note">
                        {t(demuxBlocker === 'undecodable-audio' ? 'player.audio_dolby'
                          : demuxBlocker === 'unreadable' ? 'player.audio_unreadable'
                          : 'player.audio_locked', { langs: (source.langs || []).map(langName).join(', ') })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="vp-menu-wrap">
              <button className="vp-icon" id="vpGear" aria-label={t('ctl.settings_a')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen((o) => !o); setAudioOpen(false); }}>{IS_TV ? IcMore : IcGear}</button>
              {/* A CLOSED DROPDOWN IS STILL IN THE DOM, AND THAT IS A BUG FOR A REMOTE. `.vp-menu`
                  hides itself with opacity + pointer-events, which a pointer respects and
                  geometry does not: every row inside it keeps a real bounding box floating above
                  the gear button, so TvSpatialNav offered "Subtitles / Off / English…" as targets
                  while the menu was shut. Not rendering it is the fix — and it also spares the TV
                  the cost of a menu nobody opened. The web keeps the node so it can animate. */}
              {(!IS_TV || menuOpen) && (
              <div className={`vp-menu${menuOpen ? ' open' : ''}`} id="vpMenu" role="menu">
                {IS_TV ? (
                  /* ONE PICKER, THEN WHATEVER IT PICKED.
                   *
                   * The panel was four accordions, then four label-and-chip rows, and both had the
                   * same flaw at ten feet: four controls on screen at once, of which the viewer
                   * wants exactly one. The accordions also resized the panel under the D-pad as
                   * they unfolded, so the rows below the one being used kept moving.
                   *
                   * A single chip naming the SECTION, with that section's options laid out below
                   * it, is one thing to aim at and one list to read. The chip stays put, the list
                   * under it swaps, and nothing above the chosen option can move — which is what
                   * makes the second press (choosing a value) safe to make without re-reading the
                   * screen. It is also the shape the title screen already uses for seasons and
                   * sources, so the remote's habits carry straight over.
                   *
                   * The options below stay plain rows rather than becoming a second chip: they are
                   * the destination, not another branch, and a menu that opens a menu is the thing
                   * this panel keeps being redesigned to avoid. */
                  <div className="vp-setpanel" onKeyDown={onSetPanelKey}>
                    <TvChipMenu
                      options={SET_TABS.map((s) => ({ key: s.key, label: t(s.i18n) }))}
                      value={setTab}
                      onSelect={(k) => setSetTab(k as SetTab)}
                      ariaLabel={t('ctl.settings_a')}
                    />
                    <div className="vp-setbody">
                      {setTab === 'subs' && (
                        <>
                          <OptRow on={currentSub < 0} label={t('menu.off')} onClick={() => selectSub(-1)} />
                          {/* GROUPED BY LANGUAGE, because the flat list was not a list of choices —
                              it was a list of the same choice repeated. A popular release comes
                              back from the add-ons with a dozen English files and a dozen Spanish
                              ones, interleaved in whatever order they were fetched, and a viewer
                              scrolling for Spanish had to read every English row on the way past.
                              Under a heading, the same twelve rows are one thing to skip.

                              The heading is not a focus stop: it is a `<div>` with no tabIndex, so
                              the D-pad steps straight from the last track of one language to the
                              first of the next. It orients, it does not obstruct. */}
                          {subGroups.map((g) => (
                            <div className={`vp-subgroup${subLang === g.lang ? ' open' : ''}`} key={g.lang}>
                              {/* ONE LANGUAGE OPEN AT A TIME, and that is the point rather than a
                                  limitation. Left to expand freely, three or four languages open
                                  together restore the endless list this grouping exists to break
                                  up — and on a D-pad the cost of collapsing what you no longer
                                  want is a press per group. Opening one closes the last, so the
                                  panel is always as short as the question being asked. */}
                              <button type="button" className="vp-subgroup-head"
                                aria-expanded={subLang === g.lang}
                                onClick={() => setSubLang((l) => (l === g.lang ? null : g.lang))}>
                                <span className="vp-subgroup-name">{g.name}</span>
                                {/* The count is what makes a collapsed row worth reading: it is the
                                    difference between "English, one file" and "English, fourteen",
                                    which is exactly what decides whether it is worth opening. */}
                                <span className="vp-subgroup-n">{g.items.length}</span>
                                <span className="vp-subgroup-chev" aria-hidden="true" />
                              </button>
                              {subLang === g.lang && g.items.map(({ s, i }) => (
                                <OptRow key={`${s.source || ''}${s.url}`} on={i === currentSub}
                                  /* The language is on the heading now, so the row spends its width
                                     on what actually distinguishes it from its neighbours — the
                                     add-on's own title for the file. `label` is the fallback for
                                     tracks embedded in the stream, which have no source. */
                                  label={s.source || s.label || s.lang || `${t('menu.track')}${i + 1}`}
                                  onClick={() => selectSub(i)} />
                              ))}
                            </div>
                          ))}
                          {subsLoading && <div className="vp-opt" style={{ opacity: 0.5 }}>{t('menu.loading_subs')}</div>}
                          {!subsLoading && subs.length === 0 && (
                            <div className="vp-opt" style={{ opacity: 0.5 }}>
                              {source.subsQuery ? t('menu.no_subs_found') : t('menu.install_sub_addon')}
                            </div>
                          )}
                          {subFailed && <div className="vp-menu-note">{t('menu.sub_failed')}</div>}
                        </>
                      )}
                      {setTab === 'speed' && (
                        <div className="vp-speeds">
                          {SPEEDS.map((r) => <button key={r} type="button" className={`vp-speed${r === rate ? ' on' : ''}`} onClick={() => setSpeed(r)}>{r}×</button>)}
                        </div>
                      )}
                      {setTab === 'quality' && (
                        <>
                          <OptRow on={curLevel < 0} label={t('menu.auto')} onClick={() => setLevel(-1)} />
                          {[...levels].sort((a, b) => (b.height || 0) - (a.height || 0)).map((l) => (
                            <OptRow key={l.i} on={l.i === curLevel} label={levelLabel(l)} onClick={() => setLevel(l.i)} />
                          ))}
                        </>
                      )}
                      {setTab === 'enhance' && (
                        <>
                          {/* Switching it on has to land on a level rather than only raising a
                              flag — the grain rows set `enhance: g > 0`, so an enhancement can
                              otherwise be on and doing nothing. See the web branch below, which
                              documents the same trap at length. */}
                          <OptRow on={settings.enhance} label={t('menu.enhance_on')}
                            onClick={() => updateSettings(settings.enhance
                              ? { enhance: false }
                              : {
                                  enhance: true,
                                  grain: settings.grain > 0 ? settings.grain : TV_GRAIN[1],
                                  clarity: settings.clarity > 0 ? settings.clarity : TV_CLARITY[1],
                                })} />
                          {TV_GRAIN.map((g, i) => (
                            <OptRow key={g} on={settings.enhance && settings.grain === g} label={`${t('ctl.grain')} · ${t(TV_LEVEL_KEYS[i])}`}
                              onClick={() => updateSettings({ enhance: g > 0, grain: g })} />
                          ))}
                          {TV_CLARITY.map((c, i) => (
                            <OptRow key={c} on={settings.enhance && settings.clarity === c} label={`${t('menu.clarity')} · ${t(TV_LEVEL_KEYS[i])}`}
                              onClick={() => updateSettings({ clarity: c })} />
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                {/* Subtitles */}
                <div className={`vp-acc${acc.subs ? ' open' : ''}`}>
                  <button className="vp-acc-head" aria-expanded={acc.subs} onClick={() => toggleAcc('subs')}>
                    {AccIc}<span className="vp-acc-label">{t('menu.subtitles')}</span>
                    <span className="vp-acc-val">{currentSub < 0 ? t('menu.off') : (subs[currentSub]?.label || subs[currentSub]?.lang || '')}</span>
                  </button>
                  <div className="vp-acc-body">
                    <OptRow on={currentSub < 0} label={t('menu.off')} onClick={() => selectSub(-1)} />
                    {subs.map((s, i) => (
                      <OptRow key={`${s.source || ''}${s.url}`} on={i === currentSub}
                        label={s.label || s.lang || `${t('menu.track')}${i + 1}`}
                        sub={s.source} onClick={() => selectSub(i)} />
                    ))}
                    {/* The three end states are deliberately distinct: still asking, asked
                        and nothing came back, and nothing was asked because no subtitle
                        add-on is installed. The last one is the only one the user can act
                        on, and conflating it with "none found" is what made a missing
                        feature look like a missing subtitle. */}
                    {subsLoading && <div className="vp-opt" style={{ opacity: 0.5 }}>{t('menu.loading_subs')}</div>}
                    {!subsLoading && subs.length === 0 && (
                      <div className="vp-opt" style={{ opacity: 0.5 }}>
                        {source.subsQuery ? t('menu.no_subs_found') : t('menu.install_sub_addon')}
                      </div>
                    )}
                    {subFailed && <div className="vp-menu-note">{t('menu.sub_failed')}</div>}
                  </div>
                </div>
                {/* Audio language (HLS renditions) */}
                {audioTracks.length > 1 && (
                  <div className={`vp-acc${acc.audio ? ' open' : ''}`}>
                    <button className="vp-acc-head" aria-expanded={acc.audio} onClick={() => toggleAcc('audio')}>
                      {AccIc}<span className="vp-acc-label">{t('menu.audio_lang')}</span>
                      <span className="vp-acc-val">{audioTracks.find((a) => a.i === curAudio)?.name || ''}</span>
                    </button>
                    <div className="vp-acc-body">
                      {audioTracks.map((a) => <OptRow key={a.i} on={a.i === curAudio} label={a.name} onClick={() => selectAudio(a.i)} />)}
                    </div>
                  </div>
                )}
                {/* Playback speed */}
                <div className={`vp-acc${acc.speed ? ' open' : ''}`}>
                  <button className="vp-acc-head" aria-expanded={acc.speed} onClick={() => toggleAcc('speed')}>
                    {AccIc}<span className="vp-acc-label">{t('menu.speed')}</span><span className="vp-acc-val">{rate}×</span>
                  </button>
                  <div className="vp-acc-body">
                    <div className="vp-speeds">
                      {SPEEDS.map((r) => <button key={r} type="button" className={`vp-speed${r === rate ? ' on' : ''}`} onClick={() => setSpeed(r)}>{r}×</button>)}
                    </div>
                  </div>
                </div>
                {/* QUALITY / SOURCE (HLS levels).
                    On the web this section appears only when there is a genuine choice to make —
                    a single-level stream has nothing to offer and an inert row is clutter beside
                    a cursor. The TV keeps it up unconditionally, which is the opposite call for
                    the opposite reason: this menu is walked by a D-pad, and a list whose LENGTH
                    depends on the stream means the row under the remote changes identity between
                    one title and the next. Muscle memory is worth more here than one saved row,
                    so the four sections are always the same four, in the same order. */}
                {(IS_TV || levels.length > 1) && (
                  <div className={`vp-acc${acc.quality ? ' open' : ''}`}>
                    <button className="vp-acc-head" aria-expanded={acc.quality} onClick={() => toggleAcc('quality')}>
                      {AccIc}<span className="vp-acc-label">{t('menu.quality')}</span>
                      <span className="vp-acc-val">{curLevel < 0 ? t('menu.auto') : levelLabel(levels.find((l) => l.i === curLevel) || {})}</span>
                    </button>
                    <div className="vp-acc-body">
                      <OptRow on={curLevel < 0} label={t('menu.auto')} onClick={() => setLevel(-1)} />
                      {[...levels].sort((a, b) => (b.height || 0) - (a.height || 0)).map((l) => <OptRow key={l.i} on={l.i === curLevel} label={levelLabel(l)} onClick={() => setLevel(l.i)} />)}
                    </div>
                  </div>
                )}
                {/* Picture enhance */}
                <div className={`vp-acc${acc.enhance ? ' open' : ''}`}>
                  <button className="vp-acc-head" aria-expanded={acc.enhance} onClick={() => toggleAcc('enhance')}>
                    {AccIc}<span className="vp-acc-label">{t('menu.enhance')}</span>
                    <span className="vp-acc-val">{settings.enhance ? `${Math.round(settings.grain * 100)}%` : t('menu.off')}</span>
                  </button>
                  <div className="vp-acc-body">
                    {/* SWITCHING IT ON HAS TO LAND ON A LEVEL, not just raise a flag.
                        `enhance: !enhance` alone can produce an enhancement that is on and doing
                        nothing: the grain rows set `enhance: g > 0`, so choosing "Grain · Off" is
                        how you turn the whole thing off — which leaves `grain` at 0. Switching
                        back on from here then gave 0% grain, no row ticked, and a picture
                        identical to the one before the press.
                        So a level that is at Off comes up at LOW, which is where the defaults
                        start and the gentlest thing that is actually visible. A level the viewer
                        has already set to Medium or High is left alone — this is a resume, not a
                        reset, and re-picking their strength on every toggle would be the more
                        annoying failure of the two. */}
                    <OptRow on={settings.enhance} label={t('menu.enhance_on')}
                      onClick={() => updateSettings(settings.enhance
                        ? { enhance: false }
                        : {
                            enhance: true,
                            grain: settings.grain > 0 ? settings.grain : TV_GRAIN[1],
                            clarity: settings.clarity > 0 ? settings.clarity : TV_CLARITY[1],
                          })} />
                    {/* PRESETS ON THE TV, SLIDERS ON THE WEB — see TV_GRAIN above. A range input
                        is the one control a D-pad cannot get back out of: arrows move the value,
                        so nothing is left to move focus, and the remote is trapped on it. */}
                    {IS_TV ? (
                      <>
                        {TV_GRAIN.map((g, i) => (
                          <OptRow key={g} on={settings.enhance && settings.grain === g} label={`${t('ctl.grain')} · ${t(TV_LEVEL_KEYS[i])}`}
                            onClick={() => updateSettings({ enhance: g > 0, grain: g })} />
                        ))}
                      </>
                    ) : (
                      <div className={`vp-enh-slider${settings.enhance ? '' : ' off'}`}>
                        <input type="range" min={0} max={0.35} step={0.01} value={settings.grain} disabled={!settings.enhance} onChange={(e) => updateSettings({ grain: +e.target.value })} aria-label={t('ctl.grain')} />
                        <span className="vp-enh-val">{Math.round(settings.grain * 100)}%</span>
                      </div>
                    )}
                    {IS_TV ? (
                      <>
                        {/* GATED ON `enhance`, THE SAME WAY THE GRAIN ROWS ARE. The tick was on
                            `clarity === c` alone, so with the enhancement switched off the menu
                            still showed "Clarity · Low" marked — while the sharpen filter it
                            names is applied only when `enhance` is true (see the <video>'s
                            `filter` above). A ✓ against something that is not in effect is worse
                            than no ✓: it is the menu disagreeing with the picture. */}
                        {TV_CLARITY.map((c, i) => (
                          <OptRow key={c} on={settings.enhance && settings.clarity === c} label={`${t('menu.clarity')} · ${t(TV_LEVEL_KEYS[i])}`}
                            onClick={() => updateSettings({ clarity: c })} />
                        ))}
                      </>
                    ) : (
                      <>
                        <OptRow on={settings.clarity > 0} label={t('menu.clarity')} onClick={() => updateSettings({ clarity: settings.clarity > 0 ? 0 : 0.5 })} />
                        <div className={`vp-enh-slider${settings.clarity > 0 ? '' : ' off'}`}>
                          <input type="range" min={0} max={1} step={0.05} value={settings.clarity} disabled={settings.clarity <= 0} onChange={(e) => updateSettings({ clarity: +e.target.value })} aria-label={t('ctl.clarity')} />
                          <span className="vp-enh-val">{Math.round(settings.clarity * 100)}%</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                  </>
                )}
              </div>
              )}
            </div>
            {/* NEITHER OF THESE MEANS ANYTHING ON A TELEVISION. The app is already the whole
                screen, so fullscreen has nothing to toggle, and picture-in-picture has no second
                window to go to. Left in, they are two dead stops the D-pad has to walk past to
                reach the gear — which on a remote is a real cost, unlike an unused button on a
                web page. */}
            {!IS_TV && (document.pictureInPictureEnabled || webkitPip) && (
              <button className="vp-icon" id="vpPip" aria-label={t('ctl.pip_a')} onClick={togglePip}>{IcPip}</button>
            )}
            {!IS_TV && <button className="vp-icon" id="vpFs" aria-label={t('ctl.fs_a')} aria-pressed={fs} onClick={toggleFs}>{IcFs}</button>}
    </div>
  );

  return (
    <div
      /* `tv-nav` is the flag TvSpatialNav watches: present means the D-pad drives the chrome,
         absent means the arrows are transport and it must stand down. `tv` is the styling hook
         for the 10-foot control bar. */
      className={`vp-overlay open${hideUi ? ' hide-ui' : ''}${settings.enhance ? ' enhance-on' : ''}${isTouch ? ' gestures-on' : ''}${webkitPip ? ' vp-has-webkit-pip' : ''}${IS_TV ? ' tv' : ''}${IS_TV && tvNav ? ' tv-nav' : ''}${IS_TV && railShown ? ' tv-rail' : ''}`}
      id="playerOverlay"
      ref={overlayRef}
      /* Focusable-but-not-tabbable so the remote has somewhere to rest when it steps out of the
         control bar. -1 keeps it out of TvSpatialNav's candidate pool (it filters tabIndex < 0). */
      tabIndex={IS_TV ? -1 : undefined}
      style={{ ['--grain' as string]: settings.enhance ? settings.grain : 0 }}
      onPointerMove={bump}
      onClick={(e) => { if (e.target === videoRef.current) togglePlay(); }}
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
          // resume where we left off (once), if there's saved progress for this title
          if (!resumedRef.current && source.media?.key) {
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
          // throttle resume-progress writes to ~once/5s
          const now = v.currentTime;
          if (source.media?.key && v.currentTime > 8 && Math.abs(now - lastProgRef.current) >= 5) {
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
            record({ id: m.id, title: m.title, poster: m.poster, year: m.year, type: m.type, genre: m.genre, rating: m.rating, ep: m.ep, key: m.key, season: m.season, episode: m.episode });
          }
        }}
        onPause={() => { setPlaying(false); setHideUi(false); }}
        onWaiting={() => setLoading(true)}
        onPlaying={() => { setLoading(false); setErrKind(null); startedRef.current = true; }}
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
        onEnded={() => { setPlaying(false); if (settings.autoplayNext && source.next) source.next(); }}
      >
        {/* `key` is the blob url so switching tracks REPLACES the element rather than
            mutating its src — a <track> that has already loaded keeps its old cues when
            src changes underneath it, which showed the previous language's subtitles. */}
        {vtt && <track key={vtt.url} kind="subtitles" src={vtt.url} srcLang={vtt.lang} label={vtt.label} default />}
      </video>

      {/* subtitle appearance from Settings, applied to the cue text */}
      <style>{cueCss}</style>

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
          <div className={`vp-vhud${vHud ? ' show' : ''}`}>
            <span className="ic">{vHud?.kind === 'bright' ? IcSun : (vHud && vHud.val <= 0.001 ? IcVolMuteHud : IcVolHud)}</span>
            <span className="bar"><i style={{ width: `${Math.round((vHud?.val ?? 0) * 100)}%` }} /></span>
          </div>
        </div>
      )}

      {loading && !errKind && (
        <div className="vp-loading show" id="vpLoading" role="status" aria-live="polite">
          {Worm}
          {/* THE WORM SAYS IT, THE CAPTION ONLY REPEATED IT — on the TV. A spinner over a black
              screen already means "wait"; "Preparing stream…" underneath is the same information
              spelled out, and it is the part that dates badly, because it names a stage the viewer
              has no use for and cannot act on. The web keeps it: a browser tab can be one of many
              things doing one of many things, and the words say which. A television is showing one
              film and nothing else.
              UNPAINTED RATHER THAN DELETED, the same call as the panel headings in TvDetail. The
              wrapper is a `role="status"` live region and the worm is a CSS animation — with the
              text gone outright there is nothing in it to announce, so a reader would meet a
              silent region and the wait would be invisible twice over. `.sr-only` takes the
              pixels and keeps the announcement. */}
          <div className={IS_TV ? 'lt sr-only' : 'lt'}>{t('player.preparing')}</div>
          <div className="ls" />
        </div>
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
        <div className="vp-top">
          {/* THE EPISODE SITS BESIDE THE TITLE, NOT UNDER IT. Stacked, it was a second line of
              chrome over the picture for four characters of information, and at the top-left
              corner of a television that is the most expensive real estate on the screen. On one
              line the pair reads as what it is — one name for what is playing. */}
          <div className="vp-titlerow">
            <div className="vp-title" id="playerTitle">{source.title || ''}</div>
            {source.subtitle && <div className="vp-subtitle" id="vpSubtitle">{source.subtitle}</div>}
          </div>
          <div className="vp-top-right">
            <div className="vp-status" id="playerStatus" role="status" aria-live="polite" />
            {/* NO CLOSE BUTTON ON A TELEVISION. Back on the remote closes the player — that is
                the gesture people already use to leave anything, it costs no travel, and it is
                the one this build's Back chain now ends in (see `registerBackHandler`). A ✕ in
                the far corner was a D-pad journey to do what one press already did, and it was
                the target focus fell back to whenever anything else went wrong. */}
            {!IS_TV && <button className="vp-icon" id="vpClose" title="Close (Esc)" aria-label={t('player.close')} onClick={close}>✕</button>}
            {/* The settings group lives up here on a TV — see the note where it is built. */}
            {IS_TV && controlsRow}
          </div>
        </div>

        {/* THE CENTRE DISC IS WEB-ONLY NOW. On a TV it had already been demoted from a button to a
            badge — it could not be focusable, because it is a second, ambiguous play control in the
            middle of the screen and TvSpatialNav would offer it above the bar's own ▶ — which left
            it as a "this is paused" sign, drawn as a dark circle over the middle of the picture.
            That is a caption on a still frame nobody asked for: the control bar comes up with the
            same glyph on its own disc whenever playback stops, so the state was already stated
            somewhere the viewer is looking, by something they can actually press. Two signs for
            one fact, and this was the one sitting on the film. */}
        {!IS_TV && (
          <button className={`vp-center${playing ? ' hidden' : ''}`} aria-label="Play / Pause" onClick={togglePlay}>
            <span className="ic">{playing ? IcPause : IcPlay}</span>
          </button>
        )}

        <div className="vp-bottom">
          {/* ONE LINE ON A TELEVISION: disc, elapsed, bar, duration. The buttons that used to sit
              under the scrubber are gone (skip and mute to the remote, CC and Episodes to the
              menu and the shelf) and the settings group has moved to the top-right corner, which
              leaves the transport with nothing to say that this row cannot say inline. Each time
              sits at the end of the bar it describes rather than both being crammed into one
              "13:27 / 23:40" cell. */}
          {IS_TV && (
            <>
              {/* A BADGE, NOT A BUTTON — the same decision the centre disc documents. It is not
                  focusable: OK toggles playback from transport mode and from the scrubber, so a
                  second play control in the D-pad's path would be one more stop that does what
                  OK already did, and TvSpatialNav would offer it beside the bar. */}
              {/* BOTH GLYPHS ARE ALWAYS MOUNTED, one on top of the other, and the class decides
                  which is visible. Swapping `playing ? IcPause : IcPlay` replaces the node, and a
                  node that does not exist yet cannot animate out of anything — the best that gets
                  you is the incoming mark appearing while the outgoing one has already blinked
                  away. Stacked, the change is one state on one element: two opacities and two
                  transforms cross over each other, which is the only kind of transition that
                  reads as one thing BECOMING another rather than as a cut. It costs a second
                  inert <svg> in the DOM, which is nothing beside the alternative. */}
              <div className={`vp-play-disc${playing ? ' playing' : ''}`} aria-hidden="true">
                <span className="ic-play">{IcPlay}</span>
                <span className="ic-pause">{IcPause}</span>
              </div>
              {/* The scrub offset used to ride here, inline, in red. It had to move: this cell is
                  in the flex row that also holds the bar, so a number appearing inside it widened
                  the cell and squeezed the scrubber — the bar changed length every time the viewer
                  touched Left or Right, which is the one element that must not move while it is
                  being aimed. It now floats over the bar instead, out of flow. See `.vp-seek-cue`
                  below the scrubber. */}
              {/* THE CELL IS SIZED FROM THE DURATION, NOT FROM ITS OWN CONTENTS. `tabular-nums`
                  alone was not enough and the comment on `.vp-t` used to claim otherwise: equal
                  digit widths keep 1:11 and 9:99 the same size, but they do nothing about the
                  digit COUNT, so 9:59 → 10:00 still widened this cell and pushed the bar's left
                  end along with it — mid-scrub, while the viewer is aiming at it. The duration is
                  fixed for the whole film and is always the longest the elapsed time can get, so
                  measuring the cell against it holds the ends still for good. */}
              <span className="vp-t vp-t-cur" id="vpCur" style={{ minWidth: `${clockCh}ch` }}>{fmt(shownTime)}</span>
            </>
          )}
          <div
            className={`vp-progress${seekPreview != null ? ' seeking' : ''}${ramping ? ' ramping' : ''}${landed ? ' landed' : ''}`}
            id="vpProgress"
            ref={barRef}
            onPointerDown={onBarPointerDown}
            /* On the TV the bar is a control in its own right — the remote lands on it and
               Left/Right move the preview, which is exactly a slider. On the web it stays a
               click target and nothing about it changes. */
            tabIndex={IS_TV ? 0 : undefined}
            role={IS_TV ? 'slider' : undefined}
            aria-label={IS_TV ? t('player.seek') : undefined}
            aria-valuemin={IS_TV ? 0 : undefined}
            aria-valuemax={IS_TV ? Math.round(dur) : undefined}
            aria-valuenow={IS_TV ? Math.round(shownTime) : undefined}
            aria-valuetext={IS_TV ? fmt(shownTime) : undefined}
          >
            <div className="vp-bar">
              <div className="vp-buffered" id="vpBuffered" style={{ width: `${bufPct}%` }} />
              <div className="vp-played" id="vpPlayed" style={{ width: `${pct}%` }} />
              {/* THE GROUND THE SCRUB HAS COVERED, drawn between where the video is and where it
                  would land. Absolutely positioned inside the bar, so it costs the layout nothing
                  and the bar keeps its length. */}
              {IS_TV && seekPreview != null && spanWidth > 0 && (
                <div className="vp-seek-span" style={{ left: `${spanFrom}%`, width: `${spanWidth}%` }} aria-hidden="true" />
              )}
              {IS_TV && seekPreview != null && <div className="vp-seek-origin" style={{ left: `${curPct}%` }} aria-hidden="true" />}
              <div className="vp-thumb" id="vpThumb" style={{ left: `${pct}%` }} />
            </div>
            {/* THE OFFSET, FLOATING OVER THE BAR AND CLAMPED OFF ITS ENDS. `left` is clamped in px
                rather than in % because the guard is about the pill's own width, which does not
                scale with the bar: near 0:00 an uncorrected pill would hang off the left edge of
                the screen. */}
            {IS_TV && seekDelta !== 0 && (
              <div
                className={`vp-seek-cue${seekDelta > 0 ? ' fwd' : ' back'}`}
                style={{ left: `clamp(64px, ${pct}%, calc(100% - 64px))` }}
                aria-hidden="true"
              >
                {/* A TRUE MINUS SIGN (U+2212), not a hyphen. At this size a hyphen is a short
                    stub sitting low against a tabular digit, which reads as a dash between two
                    things rather than as the sign of the number after it; the minus is cut to the
                    digits' own width and sits on their midline. The forward case takes no `+` —
                    an unsigned offset while the playhead runs forward is the resting reading, and
                    a sign that is present half the time is a sign worth noticing. */}
                <span className="vp-seek-num">{seekDelta < 0 ? '−' : ''}{fmt(Math.abs(seekDelta))}</span>
              </div>
            )}
          </div>
          {IS_TV && <span className="vp-t vp-t-dur" id="vpDur" style={{ minWidth: `${clockCh}ch` }}>{fmt(dur)}</span>}
          {!IS_TV && controlsRow}
        </div>
      </div>

      {/* Contextual skip button — "Skip Intro" in the intro window, "Next Episode" in
          the credits tail (series only) */}
      {source.series && (
        <button
          className={`vp-skip${skipMode ? ' show' : ''}`}
          id="vpSkip"
          type="button"
          onClick={() => {
            if (skipMode === 'next') source.next?.();
            else if (skipMode === 'intro') { const v = videoRef.current; if (v) v.currentTime = Math.min((v.duration || 0) - 1, Math.max(v.currentTime, skipTo)); }
            bump();
          }}
        >
          {skipMode === 'next' ? `${t('player.next_episode')} ›` : skipMode === 'intro' ? t('player.skip_intro') : ''}
        </button>
      )}

      {/* IN-PLAYER EPISODES (series) — SAME STATE, SAME `playEp`, TWO INSTRUMENTS. The web keeps
          the right-hand slide-in panel; the television gets the bottom rail. `epPanelOpen` drives
          both, so the Episodes button, the Back chain and the focus-restore effect are untouched
          and there is only ever one "episodes are open" truth.

          The TV branch is unmounted when closed, for the same reason the gear menu is: parked
          off-screen it still has real geometry, so every card would be a live D-pad target while
          the shelf was shut. It also saves the season fetches on mount. The web branch stays
          mounted so it can slide. */}
      {source.series && (IS_TV
        ? railMounted && <EpisodeRail open={railShown} series={source.series} onClose={() => setEpPanelOpen(false)} />
        : <EpisodePanel open={epPanelOpen} series={source.series} onClose={() => setEpPanelOpen(false)} />)}
    </div>
  );
}
