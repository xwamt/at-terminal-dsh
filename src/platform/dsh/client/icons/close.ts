/**
 * The close cross, and the drag grip.
 *
 * Both live here because both are HUD furniture and both are geometry rather than decoration: the
 * cross replaces the `✕` character the HUD drew, and the grip replaces a `⋮⋮`-like text stand-in.
 * A character glyph is whatever the ambient font happens to draw — at 11px in a floating window it
 * was inconsistently wide across platforms, which moved the close button's hit area per OS.
 *
 * The cross is 8px inside a 16px box, so its **hit area** (28px, from `.att-icon-btn`) is far
 * larger than the mark — the correct ratio for a control that sits next to a drag handle.
 *
 * The grip is six dots in two columns. Filled, because stroked dots at this size read as dust;
 * `plateIcon` is the frame for that, and each dot states its own fill.
 */

import {
  lineIcon,
  plateIcon,
  MEDIUM_STROKE,
  REGULAR_STROKE,
  type IconOptions,
  type SvgChild
} from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

const CROSS = 'M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5';

function closeLine(strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [['path', { d: CROSS }]];
  return lineIcon({
    name: 'close',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    strokeLinecap: 'round',
    children
  });
}

export function closeRegular(options: IconOptions = {}): El {
  return closeLine(REGULAR_STROKE, options);
}

export function closeMedium(options: IconOptions = {}): El {
  return closeLine(MEDIUM_STROKE, options);
}

/** Six dots: two columns of three, the standard drag-handle read. */
const GRIP_DOTS: Array<[number, number]> = [
  [6, 4],
  [10, 4],
  [6, 8],
  [10, 8],
  [6, 12],
  [10, 12]
];

export function gripRegular(options: IconOptions = {}): El {
  const children: SvgChild[] = GRIP_DOTS.map(
    ([cx, cy]) => ['circle', { cx: String(cx), cy: String(cy), r: '1.1', fill: 'currentColor' }] as SvgChild
  );
  return plateIcon({
    name: 'grip',
    viewBox: VIEW_BOX,
    size: options.size ?? 16,
    className: options.className,
    children
  });
}
