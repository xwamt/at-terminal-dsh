/**
 * The monitor glyph: a dial, not a bar chart.
 *
 * A chart would say "statistics"; this panel shows the **current** state of one machine — CPU,
 * memory, load, agent activity — which is a dial's subject, not a report's.
 *
 * **Why the arc is two paths.** A 220-degree dial cannot be written as one `A` command without
 * answering a question the path data does not make obvious: with endpoints at the same height,
 * one `large-arc-flag` value draws the 220-degree arc and the other draws the 140-degree one, and
 * which is which depends on the sweep direction — a coin flip that already came up wrong once
 * (the shipped glyph was a 140-degree dome, i.e. a hat). Two arcs of 110 degrees each are under
 * the half-circle limit, so `large-arc-flag` is 0 for both and there is nothing left to get wrong.
 * The seam at the top is invisible: both halves are tangent there.
 *
 * The hub is filled rather than stroked, and it is what makes the mark read as an instrument at
 * 16px: without it the needle merges into the arc and the whole glyph collapses into a caret.
 * Geometry: centre (8, 9.4), radius 5.5, from 200 degrees round to -20.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** 200° → 90° → -20°, as two sub-180° arcs that meet at the top. */
const ARC_LEFT = 'M2.83 11.28A5.5 5.5 0 0 1 8 3.9';
const ARC_RIGHT = 'M8 3.9A5.5 5.5 0 0 1 13.17 11.28';
/** From the hub out to the upper right, stopping short of the arc. */
const NEEDLE = 'M8 9.4L10.9 6.15';

function gaugeLine(strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [
    ['path', { d: ARC_LEFT }],
    ['path', { d: ARC_RIGHT }],
    ['path', { d: NEEDLE }],
    ['circle', { cx: 8, cy: 9.4, r: 0.95, fill: 'currentColor' }]
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
