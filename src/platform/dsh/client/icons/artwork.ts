/**
 * The 26px artwork the sidebar's guide card draws.
 *
 * ## Why not the 16px glyph, scaled
 *
 * The plan records the measurement: a 1.3px stroke on a 16px artboard, rendered at 26px, is drawn
 * at **2.1px** — because scaling a viewBox scales the stroke with it. Side by side with the host's
 * own 26px guide artwork (authored at 1.5px on its own artboard) the scaled glyph looks like a
 * heavier, different icon set. So this is a second drawing: the same geometry proportions, on a
 * 26-unit artboard, with a 1.5px stroke that lands at 1.5px.
 *
 * ## What it deliberately is not
 *
 * Not the official `PluginArtworkTerminal`, which is a 36px fixed-palette illustration (a
 * light-blue prompt in a scene). It would be the only thing on the card that does not follow the
 * theme, and its palette is embedded by design rather than by accident.
 */

import { lineIcon, type SvgChild } from './frame';
import type { El } from '../views/shared';

/** The artboard the geometry below is authored against. */
const GUIDE_VIEW_BOX = '0 0 26 26';

/**
 * 1.5px at 26 units. The host's own guide artwork is drawn at this weight, so this is the number
 * that makes the two look like one set rather than two.
 */
const GUIDE_STROKE = 1.5;

/**
 * The terminal window, at guide scale.
 *
 * The frame is inset 2.4 from the artboard edge — the 16px glyph's 1.5 inset at the same ratio —
 * so a 1.5px stroke clears the edge instead of being clipped by it.
 */
const FRAME = { x: '2.4', y: '4.9', width: '21.2', height: '16.2', rx: '3.2' };
/** The same prompt and cursor as the 16px glyph, scaled onto this artboard. */
const PROMPT = 'M7.7 11L11.4 13.8L7.7 16.7M13.4 17.5H18.3';

export function guideTerminalArtwork(options: { className?: string } = {}): El {
  const children: SvgChild[] = [
    ['rect', FRAME],
    ['path', { d: PROMPT }]
  ];
  return lineIcon({
    name: 'guide-terminal',
    viewBox: GUIDE_VIEW_BOX,
    strokeWidth: GUIDE_STROKE,
    size: 26,
    className: options.className,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children
  });
}
