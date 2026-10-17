/**
 * Two more line glyphs the monitor surface needs: a bolt for "agent execution" and a link for a
 * symlink.
 *
 * The bolt is an outline rather than a solid: the agent tab sits next to a hardware tab whose icon
 * is a stroked dial, and a filled glyph beside a stroked one reads as "this one is selected" when
 * it only means "this one is the other tab".
 *
 * The link is the conventional chain of two half-rings. It says "a pointer to somewhere else",
 * which is exactly what an SFTP symlink row is — and it says it without the `↪` character, whose
 * weight and bearing came from whatever font was in effect.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** A lightning bolt: two strokes meeting at the waist. */
const BOLT = 'M9.4 1.8L4.2 9.1H7.6L6.6 14.2L11.8 6.9H8.4L9.4 1.8Z';

/** Two interlocking half-rings, drawn as one path each so the join stays clean at 1px. */
const LINK_A = 'M6.7 9.3a2.6 2.6 0 0 0 3.7 0l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-.6.6';
const LINK_B = 'M9.3 6.7a2.6 2.6 0 0 0-3.7 0L3.7 8.6a2.6 2.6 0 0 0 3.7 3.7l.6-.6';

function draw(name: string, d: string[], strokeWidth: number, options: IconOptions): El {
  const children: SvgChild[] = d.map((path) => ['path', { d: path }] as SvgChild);
  return lineIcon({
    name,
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children
  });
}

export function boltRegular(options: IconOptions = {}): El {
  return draw('bolt', [BOLT], REGULAR_STROKE, options);
}

export function boltMedium(options: IconOptions = {}): El {
  return draw('bolt', [BOLT], MEDIUM_STROKE, options);
}

export function symlinkRegular(options: IconOptions = {}): El {
  return draw('symlink', [LINK_A, LINK_B], REGULAR_STROKE, options);
}

export function symlinkMedium(options: IconOptions = {}): El {
  return draw('symlink', [LINK_A, LINK_B], MEDIUM_STROKE, options);
}
