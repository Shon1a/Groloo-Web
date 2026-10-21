import { useCallback } from 'react';
import { useT } from '../../i18n/i18n';
import { useModal, openItem } from '../../stores/modal';
import { usePlayer, type PlayMedia } from '../../stores/player';
import SpotlightStage from './SpotlightStage';
import { usePostPlayData, type SpotItem } from './spotData';

/* ---- POST-PLAY — "See More", once the credits roll ----------------------------------------------
 *
 * Mounted by the player a few minutes before the end, so the recommendations, their descriptions
 * and their trailers are already resolved by the time the credits start; it renders nothing until
 * `open` — See More pressed, or filled, or the film over. Then the film is paused and covered in
 * black (spotlight.css), and SpotlightStage takes over.
 *
 * Choosing a title closes the film and opens that title, the same way a poster anywhere else does —
 * a source still has to be picked, and the title screen is where that happens. Back leaves the
 * player altogether, which is the reference's "back to the menu". */

export interface PostPlayProps {
  media: PlayMedia;
  open: boolean;
  onAudible: (audible: boolean) => void;
}

export default function PostPlay({ media, open, onAudible }: PostPlayProps) {
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
      onOpen={onOpen}
      onClose={onClose}
      onAudible={onAudible}
    />
  );
}
