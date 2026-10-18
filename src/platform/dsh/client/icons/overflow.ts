/**
 * The overflow mark: three dots, for the row's own menu.
 *
 * A row that offers its actions only on right-click is invisible to a touch screen and to anyone
 * who never thinks to try. This is the visible half of the same menu — the right-click and this
 * button open one component with one behaviour, so there is no second menu to keep in sync.
 *
 * Filled circles rather than a `⋯` character for the reason the rest of this directory exists: the
 * character comes from the ambient font, so its dot size and spacing change with the platform and
 * it sits off the optical centre of a 28px target.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** Three dots on one baseline, 3.6px apart — the pitch the official overflow mark uses. */
const DOTS: SvgChild[] = [
  ['circle', { cx: 4.4, cy: 8, r: 1.05, fill: 'currentColor' }],
  ['circle', { cx: 8, cy: 8, r: 1.05, fill: 'currentColor' }],
  ['circle', { cx: 11.6, cy: 8, r: 1.05, fill: 'currentColor' }]
];

function overflowDots(strokeWidth: number, options: IconOptions): El {
  return lineIcon({
    name: 'overflow',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    // The dots are filled, so the stroke never paints. It is passed anyway so the caller can treat
    // every icon the same way without knowing which ones are filled.
    children: DOTS
  });
}

/** The overflow mark at the 1px weight. */
export function overflowRegular(options: IconOptions = {}): El {
  return overflowDots(REGULAR_STROKE, options);
}

/** The overflow mark at the 1.3px weight; identical because the dots are filled. */
export function overflowMedium(options: IconOptions = {}): El {
  return overflowDots(MEDIUM_STROKE, options);
}
