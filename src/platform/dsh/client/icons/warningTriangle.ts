/**
 * The warning glyph: a **rounded** triangle around an exclamation mark.
 *
 * The rounding is not a style choice, it is the official rule: the product catalog pairs
 * a circle with `IconWarningOutline` and a rounded triangle with
 * `IconWarningTriangleOutline`, so a triangle with sharp corners would be a shape the
 * product does not use. The geometry below is copied from that glyph unchanged — the
 * 1.33px corner radius is carried by the path's own arc segments, which is why the
 * silhouette stays round at 1px and at 1.3px alike, and why re-rendering it at a larger
 * `size` does not square it off.
 *
 * The mark is two strokes in one path: the bar (`v3`) and the dot (`.01` — a
 * zero-length subpath that a round cap renders as a dot). Keeping them in one `d` means
 * the dot can never drift off the bar's axis, which is the failure that makes a
 * hand-placed dot look like a speck.
 *
 * The geometry spans y 1.97..14 and x 1.31..14.69, so the Medium stroke still clears
 * the artboard (0.66..15.34 stroked) instead of touching its edge. Everything is
 * `currentColor`, so the caller's `att-icon-warn` colour drives it — usually
 * `--dsw-alias-state-warn-primary`.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** The rounded triangle, copied from the official `IconWarningTriangleOutline` artwork. */
const TRIANGLE =
  'M6.87 2.6a1.33 1.33 0 0 1 2.26 0l5.34 9.33A1.33 1.33 0 0 1 13.33 14H2.67a1.33 1.33 0 0 1-1.14-2.07Z';

/** The exclamation bar and its dot, copied from the same artwork. */
const MARK = 'M8 6v3m0 2.33h.01';

function warningTriangleLine(strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [
    ['path', { d: TRIANGLE }],
    ['path', { d: MARK }]
  ];
  return lineIcon({
    name: 'warning',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    // A round join is what the copied path's arcs assume; a miter would spike the
    // already-rounded base corners at 1.3px.
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children
  });
}

/** The rounded warning triangle at the official 1px weight. */
export function warningTriangleRegular(options: IconOptions = {}): El {
  return warningTriangleLine(REGULAR_STROKE, options);
}

/** The rounded warning triangle at the official 1.3px weight. */
export function warningTriangleMedium(options: IconOptions = {}): El {
  return warningTriangleLine(MEDIUM_STROKE, options);
}
