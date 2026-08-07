import { create } from 'zustand';
import type { MediaItem } from '../lib/types';

/* Which title's detail modal is open. `target` is the seed card data (for the
 * instant placeholder + initial title/meta); the modal fetches full /api/meta on
 * top. null → closed. Mirrors the vanilla openInfoModal(ds)/closeInfoModal flow. */

export interface ModalTarget {
  id: string | number;
  type?: MediaItem['type'];
  title?: string;
  year?: string | number;
  rating?: number;
  genre?: string;
  poster?: string;
  seed?: number;
  /** IMDb id, when the card that was clicked already carried one (`MediaItem.imdb` — the
   *  backend attaches it to every catalog card it lets through). Carried here PURELY so the
   *  add-on stream fan-out can start on the click instead of after /api/meta returns: it is
   *  the only field of the detail payload that request exists to supply which the row
   *  already knows. `meta.imdb` still wins once it lands — see the fan-out effect in
   *  DetailModal. Absent on a deep link and on Continue Watching, both of which fall back
   *  to the old behaviour rather than getting it wrong. */
  imdb?: string;
  /** when reopened from Continue Watching for a series, the episode to resume */
  resumeEp?: { season: number; episode: number };
}

interface ModalState {
  target: ModalTarget | null;
  open: (t: ModalTarget) => void;
  close: () => void;
}

export const useModal = create<ModalState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** Convenience: open the modal from a catalog MediaItem. */
export function openItem(item: MediaItem, seed = 0): ModalTarget {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    year: item.year,
    rating: item.rating,
    genre: item.genre,
    poster: item.poster,
    imdb: typeof item.imdb === 'string' ? item.imdb : undefined,
    seed,
  };
}
