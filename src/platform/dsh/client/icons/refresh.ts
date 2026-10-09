/**
 * The refresh glyph: an almost-closed circular arrow.
 *
 * Geometry is copied unchanged from the official `IconRefreshOutline` artwork, which is
 * the glyph the product already uses for a retry affordance — reusing it means a refresh
 * button here is the same mark as a refresh button in the Host, rather than a second
 * spinner-shaped thing that has to be learned.
 *
 * Two paths, and the split is load-bearing:
 *
 * - the arc runs from the arrowhead's tip clockwise most of the way round and stops
 *   short of closing. The gap is what tells the eye this is a *cycle*; a closed ring
 *   reads as a record button or a loading dot.
 * - the arrowhead is a separate path because it must stay square-cornered where it
 *   meets the arc's tangent. That is the one place a round join would be wrong: a
 *   rounded elbow there softens the arrow into a smudge at 14px.
 *
 * The official artwork sets no `stroke-linecap`, so this keeps the default butt cap for
 * the same reason — a round cap would blunt the arrowhead's two free ends.
 *
 * The arc spans 1.5..14.5 on both axes, so the Medium stroke clears the artboard
 * (0.85..15.15 stroked) rather than touching its edge.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** The cycle arc, copied from the official `IconRefreshOutline` artwork. */
const ARC =
  'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 ' +
  '14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 ' +
  '12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 ' +
  '5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 ' +
  '1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1';

/** The arrowhead elbow, copied from the same artwork. */
const ARROWHEAD = 'M14.4999 1.5V5.1H10.8999';

function refreshLine(strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [
    ['path', { d: ARC }],
    ['path', { d: ARROWHEAD }]
  ];
  return lineIcon({
    name: 'refresh',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    // Left at the SVG default (butt, miter) on purpose: the arrowhead's corner has to
    // stay crisp and its two ends stay flat, which is how the official ships it.
    children
  });
}

/** The refresh arrow at the official 1px weight. */
export function refreshRegular(options: IconOptions = {}): El {
  return refreshLine(REGULAR_STROKE, options);
}

/** The refresh arrow at the official 1.3px weight. */
export function refreshMedium(options: IconOptions = {}): El {
  return refreshLine(MEDIUM_STROKE, options);
}
