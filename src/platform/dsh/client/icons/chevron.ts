/**
 * Directions for the two chevrons this panel uses: disclosure (down / right) and "go up".
 *
 * One geometry table and one function, because the three are the **same stroke**. A chevron
 * authored separately per direction is three drawings that drift by a half pixel and then show it
 * in a tree where they sit one above the other.
 *
 * The 4×4 box each chevron occupies is centred on the artboard: `y` is the middle two pixels and
 * the arms are symmetric, so rotating the direction swaps the axis without moving the optical
 * centre — which is what keeps a disclosure at 12px aligned with a file glyph at 16px.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** Four directions, one shape. */
const PATHS = {
  down: 'M4.5 6.5L8 10L11.5 6.5',
  right: 'M6.5 4.5L10 8L6.5 11.5',
  up: 'M4.5 9.5L8 6L11.5 9.5'
} as const;

export type ChevronDirection = keyof typeof PATHS;

function chevronLine(direction: ChevronDirection, strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [['path', { d: PATHS[direction] }]];
  return lineIcon({
    name: `chevron-${direction}`,
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children
  });
}

export function chevronDownRegular(options: IconOptions = {}): El {
  return chevronLine('down', REGULAR_STROKE, options);
}

export function chevronDownMedium(options: IconOptions = {}): El {
  return chevronLine('down', MEDIUM_STROKE, options);
}

export function chevronRightRegular(options: IconOptions = {}): El {
  return chevronLine('right', REGULAR_STROKE, options);
}

export function chevronRightMedium(options: IconOptions = {}): El {
  return chevronLine('right', MEDIUM_STROKE, options);
}

export function chevronUpRegular(options: IconOptions = {}): El {
  return chevronLine('up', REGULAR_STROKE, options);
}
