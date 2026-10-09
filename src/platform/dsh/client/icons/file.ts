/**
 * The file glyph: a grey sheet with a darker folded corner.
 *
 * Geometry is copied from the official `FileTypeIcon` generic-file pair — the `FILE_BODY`
 * sheet silhouette and the `FILE_FOLD` corner triangle that sits on top of it, at the
 * official 28px artboard. Copying rather than redrawing is the point: this is the shape
 * users already read as "a file" everywhere else in the product.
 *
 * The official renders the generic file as a grey sheet with a darker grey corner, which
 * is what makes it read as *untyped* — a coloured sheet means a known category, and this
 * panel has no category to claim. Both tones are theme tokens rather than the official's
 * greys: `--dsw-alias-label-secondary` for the sheet and `--dsw-alias-label-dimmed` for
 * the fold, which is one step further from the page, so the sheet reads as the dominant
 * plane and the corner as the part turned away from the light. A literal grey could not
 * follow the light/dark switch.
 *
 * Filled, so `Regular` and `Medium` are the same drawing — there is no stroke to
 * thicken. Both names are exported so a caller can weight every row uniformly without
 * knowing which glyphs ignore it.
 */

import { plateIcon, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

/** The 28px artboard the official file plate is drawn against. */
const VIEW_BOX = '0 0 28 28';

/**
 * The sheet: a rounded-corner page with the top-right corner cut away for the fold.
 * Copied from the official `FILE_BODY`.
 */
const FILE_BODY =
  'M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 26.0417 ' +
  '25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 26.3909 8.09593 ' +
  '26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 6.86303 25.7177 6.69799 ' +
  '25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 19.3769 0.38885C19.126 0.220541 ' +
  '18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 ' +
  '0.349145C3.31672 0.814671 2.4238 1.70759 1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 ' +
  '6.88011V21.1199C1.60913 23.257 1.60913 24.3256 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 ' +
  '27.6509C5.28351 28 6.35209 28 8.48924 28Z';

/** The folded corner, drawn over the sheet's cut-out. Copied from the official `FILE_FOLD`. */
const FILE_FOLD =
  'M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 6.48096 ' +
  '19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 7.37445H26.3909Z';

function filePlate(options: IconOptions = {}): El {
  const children: SvgChild[] = [
    ['path', { d: FILE_BODY, fill: 'var(--dsw-alias-label-secondary)' }],
    ['path', { d: FILE_FOLD, fill: 'var(--dsw-alias-label-dimmed)' }]
  ];
  return plateIcon({
    name: 'file',
    viewBox: VIEW_BOX,
    size: options.size ?? 28,
    className: options.className,
    children
  });
}

/** The file at the official 1px weight; identical to {@link fileMedium} because it is filled. */
export function fileRegular(options: IconOptions = {}): El {
  return filePlate(options);
}

/** The file at the official 1.3px weight; identical to {@link fileRegular} because it is filled. */
export function fileMedium(options: IconOptions = {}): El {
  return filePlate(options);
}
