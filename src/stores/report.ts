import { create } from 'zustand';

/* Which thing the report sheet is open on. null → closed. A global store rather than
 * local `useState` in the one screen that opens it, because reporting has to be reachable
 * from inside DetailModal — which is itself mounted at App level, outside <Routes> — as
 * well as from the Add-ons screen. Mirrors stores/modal.ts. */

export type ReportKind = 'addon' | 'title' | 'stream';

export interface ReportTarget {
  kind: ReportKind;
  /** Identifies the thing reported: an origin for an add-on, an id for a title/stream.
   *  Sent verbatim as `targetKey`. Never a full manifest URL — by add-on protocol convention
   *  that path carries the user's own API key, which must not ride into a report. */
  targetKey: string;
  /** Display-only, so the sheet and the admin queue can name the thing without a lookup. */
  targetName?: string;
  /** Publishing host, where known. This is the field that makes a repeat offender
   *  visible across otherwise unrelated reports, so pass it whenever there is one. */
  origin?: string;
}

interface ReportState {
  target: ReportTarget | null;
  open: (t: ReportTarget) => void;
  close: () => void;
}

export const useReport = create<ReportState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
