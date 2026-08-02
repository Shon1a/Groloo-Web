import { create } from 'zustand';

/* WHETHER THE SHELF PREVIEW HAS SOUND. TV build only; the red button on the remote toggles it
 * (see isPreviewSoundKey in tvKeys, and the listener in TvSpotlight).
 *
 * A STORE RATHER THAN ROW STATE, because the preview is not a property of a row — it is one
 * thing playing on one screen, and the row it belongs to changes every time the remote moves up
 * or down. Held per row, turning sound on and then walking to the shelf below would land on a
 * row that had never heard of the decision and play muted again.
 *
 * NOT PERSISTED, unlike the settings store. Sound is a thing you asked for while looking at a
 * particular trailer, not a preference; a set that came back from standby playing audio at
 * whoever turned it on — from a shelf, before anything was chosen — is the behaviour every TV
 * app that ships this is careful to avoid. It resets with the app, which is where a fresh room
 * expects it. */
interface PreviewSoundState {
  /** True while row-billboard previews should play with sound. */
  on: boolean;
  toggle: () => void;
}

export const usePreviewSound = create<PreviewSoundState>((set) => ({
  on: false,
  toggle: () => set((s) => ({ on: !s.on })),
}));
