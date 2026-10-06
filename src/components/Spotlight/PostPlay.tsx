import { useCallback } from 'react';
import { useT } from '../../i18n/i18n';
import { useModal, openItem } from '../../stores/modal';
import { usePlayer, type PlayMedia } from '../../stores/player';
import SpotlightStage from './SpotlightStage';
import { usePostPlayData, type SpotItem } from './spotData';

/* ---- POST-PLAY — what the screen becomes when the credits roll ----------------------------------
 *
 * Mounted by the player a few minutes before the end, so the recommendations, their descriptions
 * and their trailers are already resolved by the time the credits start; it renders nothing until
 * `open`. Then the film shrinks into the corner (the player does that, by class — see
 * spotlight.css), the room dims, and SpotlightStage takes over.
 *
 * Choosing a title closes the film and opens that title, the same way a poster anywhere else does —
 * a source still has to be picked, and the title screen is where that happens. Back leaves the
 * player altogether, which is the reference's "back to the menu". */

/** Each title's trailer runs this long before the next one takes the screen. */
const CLIP_SECONDS = 20;

export interface PostPlayProps {
  media: PlayMedia;
  open: boolean;
  /** The credits have had their ten seconds in the corner and faded out (the player decides when). */
  miniGone: boolean;
  /** The frame in the corner was chosen: give the film the whole screen again. */
  onBackToCredits: () => void;
  onAudible: (audible: boolean) => void;
}

export default function PostPlay({ media, open, miniGone, onBackToCredits, onAudible }: PostPlayProps) {
  const t = useT();
  const { spot, more, settled, finished } = usePostPlayData(media, true);

  const onOpen = useCallback((it: SpotItem) => {
    useModal.getState().open(openItem(it));
    usePlayer.getState().close();
  }, []);
  const onClose = useCallback(() => usePlayer.getState().close(), []);

  if (!open) return null;
  const title = finished?.title || media.title || '';
  return (
    <SpotlightStage
      spot={spot}
      more={more}
      settled={settled}
      kicker={title ? t('postplay.because', { title }) : t('postplay.label')}
      rowLabel={t('postplay.label')}
      clipSeconds={CLIP_SECONDS}
      onOpen={onOpen}
      onClose={onClose}
      mini={{ label: t('postplay.back_to_credits'), onActivate: onBackToCredits, gone: miniGone }}
      onAudible={onAudible}
    />
  );
}
