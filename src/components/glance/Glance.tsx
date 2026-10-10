import type { GlanceCallout } from '../../lib/glance';
import { GlanceIcon } from './GlanceIcons';
import { useSettledGlance, type GlanceSource } from './useGlance';

const IS_TV = import.meta.env.MODE === 'tv';

/** The chips themselves. Renders nothing at all when a title has no callout — most don't.
 *  `icons` (default: `rise`) is whether the icons make their move with the tab's rise; a surface that
 *  moves (the TV home's featured billboard) hands it later, once the remote is still — an icon's move is
 *  main-thread work on every frame of it (see tvRowStage ICON_QUIET_MS). */
export function GlanceChips({ callouts, max = 2, className, rise = true, icons }: {
  callouts: GlanceCallout[];
  max?: number;
  className?: string;
  rise?: boolean;
  icons?: boolean;
}) {
  const shown = callouts.slice(0, max);
  if (!shown.length) return null;
  return (
    <div className={`gl-chips${IS_TV ? ' tv' : ''}${rise ? ' rise' : ''}${(icons ?? rise) ? ' gl-run' : ''}${className ? ` ${className}` : ''}`}>
      {shown.map((c) => (
        <span key={c.kind} className={`gl-chip k-${c.kind}`}>
          <GlanceIcon name={c.icon} />
          <span>{c.text}</span>
        </span>
      ))}
    </div>
  );
}

/** A title's settled callouts (useSettledGlance) as chips, for the common case. `waitForMeta` for a
 *  surface that fetches the title's detail: its callouts wait for it, a little longer. */
export default function Glance(props: GlanceSource & { max?: number; className?: string; rise?: boolean; icons?: boolean; waitForMeta?: boolean }) {
  const callouts = useSettledGlance(props, `${props.item.type}:${props.item.id}`,
    { waitForMeta: props.waitForMeta, maxWaitMs: props.waitForMeta ? 1600 : 900 });
  return <GlanceChips callouts={callouts} max={props.max} className={props.className} rise={props.rise} icons={props.icons} />;
}
