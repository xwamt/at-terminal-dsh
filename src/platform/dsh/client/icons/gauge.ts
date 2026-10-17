/**
 * The monitor glyph: a dial, not a bar chart.
 *
 * A chart would say "statistics"; this panel shows the **current** state of one machine — CPU,
 * memory, load, agent activity — which is a dial's subject, not a report's. The needle also
 * survives the sizes this glyph is used at (16px in a toolbar, 12px in a HUD pill) where three
 * bars would collapse into a smudge.
 *
 * Geometry: a 220-degree arc with a gap at the bottom, and a needle from the centre out to the
 * upper right. The gap is what keeps it from reading as a clock, and the needle's endpoint stays
 * clear of the arc so the two never touch at 1px.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** The arc, then the needle. One path each, so a weight change moves both together. */
const ARC = 'M2.6 11.2A5.8 5.8 0 0 1 13.4 11.2';
const NEEDLE = 'M8 9.6L10.6 6.6';

function gaugeLine(strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [
    ['path', { d: ARC }],
    ['path', { d: NEEDLE }]
  ];
  return lineIcon({
    name: 'gauge',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children
  });
}

export function gaugeRegular(options: IconOptions = {}): El {
  return gaugeLine(REGULAR_STROKE, options);
}

export function gaugeMedium(options: IconOptions = {}): El {
  return gaugeLine(MEDIUM_STROKE, options);
}
