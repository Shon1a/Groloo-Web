import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/* ============================================================================
 * A QR CODE, AS ONE SVG PATH.
 *
 * WHY A LIBRARY AND NOT A HAND-ROLL. This file is the exception to the "deliberately
 * library-free" line TvSpatialNav takes, and the difference is that spatial navigation is a
 * direction cone and a distance score — a few dozen lines you can read and check — whereas a QR
 * symbol is Reed-Solomon error correction over GF(256), eight candidate mask patterns scored
 * against a penalty table, and a version/capacity table. A subtly wrong QR does not look wrong;
 * it looks like a QR and fails silently in the one moment it is needed. `qrcode-generator` is
 * ~12KB, has no dependencies of its own and is ES5, which keeps it inside the Chromium-87 floor
 * the TV build targets.
 *
 * WHY SVG RATHER THAN CANVAS. A QR is a grid of hard-edged squares, which is exactly what vector
 * output is good at and what a canvas has to be told the device pixel ratio to get right. It also
 * scales to whatever the layout gives it without going soft on a 4K panel, and it costs no
 * `useRef`/imperative draw step. The whole symbol is ONE `<path>` of rect subpaths rather than
 * ~1000 `<rect>` elements: same picture, one node, and nothing for the compositor to walk.
 *
 * `shape-rendering: crispEdges` is the load-bearing attribute. Anti-aliased module edges are the
 * usual reason a screen-displayed QR scans badly — a phone camera across a room is already
 * fighting the panel's own pixel grid, and softened borders blur adjacent modules together.
 * ==========================================================================*/

export interface QrCodeProps {
  /** what the code encodes — here, the verify URL with the pairing code in its query */
  value: string;
  /** accessible name; the code is decorative to a screen reader without one */
  title?: string;
  className?: string;
}

/* Error correction 'M' (~15% recoverable) rather than 'L'. A TV screen is photographed at an
 * angle, off a glossy panel, often with a reflection across part of it — the redundancy is worth
 * the extra modules, and at this physical size the modules are still enormous. */
const ECC = 'M';
/** Quiet zone, in modules. The spec requires 4; less and scanners fail to find the symbol. */
const QUIET = 4;

export default function QrCode({ value, title, className }: QrCodeProps) {
  const { d, size } = useMemo(() => {
    // typeNumber 0 = pick the smallest version that fits the data.
    const qr = qrcode(0, ECC);
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.isDark(r, c)) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      }
    }
    return { d: path, size: count + QUIET * 2 };
  }, [value]);

  return (
    <svg
      className={className}
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
      role="img"
      aria-label={title}
    >
      {/* The quiet zone has to be WHITE, not transparent. The card behind this is near-black, and
          a symbol whose margin shows the card through it has no quiet zone at all as far as a
          scanner is concerned — the most common way a dark-themed QR fails to read. */}
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
