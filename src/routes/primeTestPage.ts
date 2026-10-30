import { lazyNow } from '../lib/lazyNow';

/* The Prime-layout TEST page's route component (App.tsx), shared with the TV bar (TvTopNav), whose
 * prefetch keeps it in hand so the switch to it renders at once (lib/lazyNow.ts). TV only: the web
 * build folds this to null and never traces the import. */
export const PrimeTestPage = import.meta.env.MODE === 'tv' ? lazyNow(() => import('./PrimeTest')) : null;
