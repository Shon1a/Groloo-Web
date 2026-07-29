import { useEffect } from 'react';
import { installTvKeys } from '../lib/tvKeys';

/* Mounts the Back-key resolver for the `--mode tv` build. All of the behaviour lives in
 * lib/tvKeys.ts, deliberately framework-free: the Android carrier is a bridge call from Kotlin
 * rather than a React event, and webOS reads its launch/relaunch feeds outside React too, so the
 * resolver has to be callable without a component in the way. Renders nothing. */
export default function TvBackKey() {
  useEffect(() => installTvKeys(), []);
  return null;
}
