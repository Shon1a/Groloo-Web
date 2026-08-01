import { useLayoutEffect } from 'react';
import { installTvKeys } from '../lib/tvKeys';

/* Mounts the Back-key resolver for the `--mode tv` build. All of the behaviour lives in
 * lib/tvKeys.ts, deliberately framework-free: the Android carrier is a bridge call from Kotlin
 * rather than a React event, and webOS reads its launch/relaunch feeds outside React too, so the
 * resolver has to be callable without a component in the way. Renders nothing. */
/* A LAYOUT EFFECT, NOT A PASSIVE ONE, AND THE DIFFERENCE IS THE WHOLE BROWSER-BACK FIX.
 *
 * tvKeys listens for `popstate` so Alt+Left steps the app's layers instead of navigating away
 * from them. HashRouter listens for the same event, and whichever registered first wins the
 * press: React runs EVERY layout effect (children before parents) before ANY passive effect, so
 * with `useEffect` here the router — a parent, but a layout-effect subscriber — always got there
 * first. It changed the route, DetailModal's pathname watcher closed the modal, and by the time
 * this file's handler ran there was no layer left to step; measured, it saw `layerOpen=false`.
 *
 * As a layout effect this component is a child running in the children-first pass, so it
 * subscribes before the router and the press reaches the back chain with the layer still up. */
export default function TvBackKey() {
  useLayoutEffect(() => installTvKeys(), []);
  return null;
}
