/**
 * Import and export: the same tray, with the arrow pointing the way the data moves.
 *
 * Drawn as a pair rather than sourced separately, and that is the whole design argument: 导入 and
 * 导出 sit next to each other in the same toolbar and do opposite things to the same asset file.
 * Two unrelated glyphs (a folder and a document, say) would make the reader learn which is which;
 * one tray with the arrow flipped makes the pair self-explaining at a glance, and the direction is
 * the only difference the eye has to resolve.
 *
 * The tray is a `rect` with no top edge — three sides and two short uprights — because a full
 * rectangle plus an arrow inside it collapses into a "download to disk" icon at 14px, and the two
 * would then be indistinguishable from the SFTP transfer controls next door. Leaving the top open
 * keeps the reading "into the panel" rather than "onto the disk".
 *
 * Both are stroked, so the two weights exist for the same reason every other outline icon here has
 * them.
 */

import { lineIcon, MEDIUM_STROKE, REGULAR_STROKE, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

const VIEW_BOX = '0 0 16 16';

/** The open-topped tray: two uprights and a floor. */
const TRAY = 'M3 9.5V12.5C3 13.0523 3.44772 13.5 4 13.5H12C12.5523 13.5 13 13.0523 13 12.5V9.5';

/** Into the panel: a shaft with a head at its foot. */
const ARROW_IN = ['M8 2.5V9.5', 'M5.4 6.9L8 9.5L10.6 6.9'];

/** Out of the panel: the same shaft, head at its top. */
const ARROW_OUT = ['M8 9.5V2.5', 'M5.4 5.1L8 2.5L10.6 5.1'];

function trayArrow(direction: 'in' | 'out', strokeWidth: number, options: IconOptions): El {
  const shaft = direction === 'in' ? ARROW_IN : ARROW_OUT;
  const children: SvgChild[] = [
    ['path', { d: TRAY }],
    ['path', { d: shaft[0] }],
    ['path', { d: shaft[1] }]
  ];
  return lineIcon({
    name: direction === 'in' ? 'import' : 'export',
    viewBox: VIEW_BOX,
    strokeWidth,
    size: options.size ?? 16,
    className: options.className,
    children
  });
}

/** 导入 at the 1px weight. */
export function importRegular(options: IconOptions = {}): El {
  return trayArrow('in', REGULAR_STROKE, options);
}

/** 导入 at the 1.3px weight. */
export function importMedium(options: IconOptions = {}): El {
  return trayArrow('in', MEDIUM_STROKE, options);
}

/** 导出 at the 1px weight. */
export function exportRegular(options: IconOptions = {}): El {
  return trayArrow('out', REGULAR_STROKE, options);
}

/** 导出 at the 1.3px weight. */
export function exportMedium(options: IconOptions = {}): El {
  return trayArrow('out', MEDIUM_STROKE, options);
}
