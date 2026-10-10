import type { GlanceCallout } from '../../lib/glance';
import { GlanceIcon } from './GlanceIcons';
import { useSettledGlance, type GlanceSource } from './useGlance';

const IS_TV = import.meta.env.MODE === 'tv';

/** The chips themselves. Renders nothing at all when a title has no callout — most don't. */
export function GlanceChips({ callouts, max = 2, className, rise = true }: {
  callouts: GlanceCallout[];
  max?: number;
  className?: string;
  rise?: boolean;
}) {
  const shown = callouts.slice(0, max);
  if (!shown.length) return null;
  return (
    <div className={`gl-chips${IS_TV ? ' tv' : ''}${rise ? ' rise gl-run' : ''}${className ? ` ${className}` : ''}`}>
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
export default function Glance(props: GlanceSource & { max?: number; className?: string; rise?: boolean; waitForMeta?: boolean }) {
  const callouts = useSettledGlance(props, `${props.item.type}:${props.item.id}`,
    { waitForMeta: props.waitForMeta, maxWaitMs: props.waitForMeta ? 1600 : 900 });
  return <GlanceChips callouts={callouts} max={props.max} className={props.className} rise={props.rise} />;
}
