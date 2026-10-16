import { create } from 'zustand';

/* Playback / interface settings, persisted to localStorage (groloo.settings.v1),
 * mirroring the vanilla SETTINGS object. A focused subset is wired now; the full
 * control set (external player, popup-ring, etc.) can extend this store. */

const KEY = 'groloo.settings.v1';

export interface Settings {
  // interface
  blurUnwatched: boolean;
  /* TV build only: play a muted trailer on the row billboard once the remote rests on a title.
   * A setting rather than a fixed behaviour because it is the one feature here whose cost lands
   * squarely on the weakest hardware the app runs on — an autoplaying embed is the heaviest thing
   * on the screen, and how well a given set copes is not something the app can measure. On by
   * default (the shelf preview is the expected behaviour on a TV); off is one switch away for a
   * set where browsing starts to feel sticky. Ignored entirely by the web build. */
  tvRowTrailers: boolean;
  // auto-play
  autoplayNext: boolean;
  nextPopup: number;          // seconds the next-video popup stays up
  /** When a film (or a series' last episode) reaches its credits, shrink it into the corner and
   *  play trailers of what to watch next — the post-play screen. */
  postPlay: boolean;
  // subtitles
  subLang: 'off' | 'en' | 'ka' | 'ru';
  subSize: number;            // % of base subtitle size
  subColor: string;
  subBg: string;
  subOutline: string;
  subOutlineW: number;
  subItalic: boolean;
  /** Which subtitle defaults this profile has been moved onto — see `load`. */
  subLook: number;
  // playback preferences
  autoQuality: 'best' | '4k' | '1080';
  audioLang: 'en' | 'original';
  // advanced
  externalPlayer: 'disabled' | 'vlc' | 'infuse' | 'outplayer' | 'nplayer';
  // picture-enhance (player)
  enhance: boolean;
  grain: number;              // 0–0.35 grain overlay opacity
  clarity: number;            // 0–1 unsharp-mask strength
}

const DEFAULTS: Settings = {
  blurUnwatched: false,
  tvRowTrailers: true,
  autoplayNext: true,
  nextPopup: 15,
  postPlay: true,
  /* English subtitles ON whenever a track exists, and drawn the way Netflix draws them: warm
   * off-white, italic, no box — the soft shadow lives in lib/subtitles `cueLook`. */
  subLang: 'en',
  subSize: 100,
  subColor: '#faf5e6',
  subBg: 'transparent',
  subOutline: '#000000',
  subOutlineW: 0,
  subItalic: true,
  subLook: 2,
  autoQuality: 'best',
  audioLang: 'en',
  externalPlayer: 'disabled',
  /* PICTURE ENHANCE IS OFF UNTIL ASKED FOR. It is a look, not a correction — grain and a sharpen
   * pass are things a viewer opts into, and a player that ships with them on is deciding how
   * somebody else's film should look.
   *
   * THE TWO LEVELS BELOW ARE THE "LOW" PRESETS, EXACTLY. They must stay equal to TV_GRAIN[1] and
   * TV_CLARITY[1] in VideoPlayer, and that is a real constraint rather than a tidy coincidence:
   * the TV menu offers four fixed levels and ticks the row whose value MATCHES, so a default that
   * merely sits near one ticks nothing at all. They were 0.10 and 0.40, which are between presets
   * — so on a television, switching the enhancement on used to light up "Film grain & color
   * boost" above four grain rows and four clarity rows with no mark against any of them, and the
   * header read 10%. Now turning it on lands on Low · Low, which is both the gentlest setting and
   * a visible one.
   *
   * The web keeps sliders and does not care where the value sits, so it simply starts gentler. */
  enhance: false,
  grain: 0.08,
  clarity: 0.25,
};

function load(): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return { ...DEFAULTS }; }
  const s: Settings = { ...DEFAULTS, ...saved };
  /* MOVING A SAVED PROFILE ONTO THE NEW SUBTITLE DEFAULTS (subLook 2), once. `save` writes the WHOLE object, so anyone who
   * ever touched a setting has the old defaults stored as if chosen — subtitles off, pure white on a
   * dimmed box — and new defaults alone would never reach them. Each value is moved only while it
   * still equals the old default, so a colour somebody actually picked stays theirs. */
  if (Object.keys(saved).length && (saved.subLook ?? 1) < 2) {
    if (s.subLang === 'off') s.subLang = 'en';
    if (String(s.subColor).toLowerCase() === '#ffffff') s.subColor = DEFAULTS.subColor;
    if (s.subBg === 'rgba(0,0,0,.6)') s.subBg = DEFAULTS.subBg;
    if (s.subOutlineW === 2 && String(s.subOutline).toLowerCase() === '#000000') s.subOutlineW = DEFAULTS.subOutlineW;
    s.subLook = 2;
    save(s);
  }
  return s;
}
function save(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota */ }
}

interface SettingsState {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: load(),
  update: (patch) => { const next = { ...get().settings, ...patch }; save(next); set({ settings: next }); },
}));
