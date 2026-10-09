/**
 * The server glyph: a two-bay rack.
 *
 * ## Why a rack and not a "host" box
 *
 * This panel lists remote machines reached over SSH, so the mark has to say "a machine
 * on a network" rather than "this computer". A rack is the shape that already carries
 * that meaning — the stacked-bay silhouette is the standard signal for hosted
 * infrastructure — and it stays unambiguous at 14px, where a tower or a monitor shape
 * collapses into a plain rectangle.
 *
 * ## Geometry
 *
 * Two stacked rounded rects sharing one set of columns, plus a short status tick in
 * each bay:
 *
 * - the bays are 12×4.5 at y=2.75 and y=8.75, leaving a 2px gap. The gap is what makes
 *   it read as *two* units; a single rect with a divider would read as one box with a
 *   line through it.
 * - `rx=1.25` scales with the bay height (a quarter of it), matching the terminal
 *   glyph's "rounded chrome" family rather than inventing a sharper second style.
 * - the tick is a 2.5px horizontal stroke inset 2.5 from the bay's left edge, on the
 *   bay's centreline. Asymmetric on purpose: a centred tick would read as a minus sign
 *   or a battery level, whereas an off-centre one reads as an indicator lamp.
 *
 * All strokes round-capped for the same reason as the terminal glyph: a 1.3px Medium
 * weight with a butt cap leaves a visibly open end on a 2.5px line.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** The indicator tick, shared by both bays so the two cannot drift apart. */
const TICK = 'M4.5 5H7M4.5 11H7';

function serverLine(strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [
    ['rect', { x: '2', y: '2.75', width: '12', height: '4.5', rx: '1.25' }],
    ['rect', { x: '2', y: '8.75', width: '12', height: '4.5', rx: '1.25' }],
    ['path', { d: TICK }]
  ];
  return lineIcon({
    name: 'server',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children
  });
}

/** The rack at the official 1px weight. */
export function serverRegular(options: IconOptions = {}): El {
  return serverLine(REGULAR_STROKE, options);
}

/** The rack at the official 1.3px weight. */
export function serverMedium(options: IconOptions = {}): El {
  return serverLine(MEDIUM_STROKE, options);
}
