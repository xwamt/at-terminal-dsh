/**
 * The terminal glyph: a window frame with a `>` prompt and a cursor.
 *
 * ## Why this is not the official `PluginArtworkTerminal`
 *
 * That artwork is a 36×36 **illustration**: a fixed-palette scene with a light-blue
 * prompt, drawn to sit in a plugin card or a sidebar guide entry. Dropping a 36px
 * illustration into a 16px toolbar row (or a 14px status line) would make it the
 * loudest thing on the line and would not follow the theme, because its palette is
 * embedded by design. So this is an independent line glyph on the 16px artboard: the
 * frame says "a terminal", the prompt says "a shell", and neither borrows a hue.
 *
 * ## Geometry
 *
 * Three strokes, all in one 16×16 box with the frame inset to 1.5 so a 1.3px Medium
 * stroke still clears the artboard edge instead of touching it:
 *
 * - the frame is a rounded rect, 13×10 at (1.5, 3). `rx=2` rather than square: a square
 *   window at this size reads as a stop sign, and the radius is what makes it read as
 *   chrome.
 * - the prompt is a `>` chevron, two segments meeting at the frame's optical centre.
 * - the cursor is a short baseline under the chevron's right, which is what
 *   distinguishes "a terminal" from "a code file" (`file.ts`) — the same rectangle with
 *   no prompt would be ambiguous next to it.
 *
 * Stems and corners are round: at 1.3px a miter join on the chevron's point pushes a
 * visible spike, and the round cap is the product's convention for line glyphs.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** The prompt and the cursor, kept as one path so the two never drift apart. */
const PROMPT = 'M4.75 6.75L7 8.5L4.75 10.25M8.25 10.75H11.25';

function terminalLine(strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = [
    ['rect', { x: '1.5', y: '3', width: '13', height: '10', rx: '2' }],
    ['path', { d: PROMPT }]
  ];
  return lineIcon({
    name: 'terminal',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children
  });
}

/** The terminal prompt at the official 1px weight. */
export function terminalRegular(options: IconOptions = {}): El {
  return terminalLine(REGULAR_STROKE, options);
}

/** The terminal prompt at the official 1.3px weight. */
export function terminalMedium(options: IconOptions = {}): El {
  return terminalLine(MEDIUM_STROKE, options);
}
