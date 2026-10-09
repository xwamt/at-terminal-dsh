/**
 * The folder glyph: a closed folder plate with a lighter label band across it.
 *
 * Geometry is copied from the official `FileTypeIcon` folder — the same solid category
 * plate the file tree already uses, at its 28px artboard — so a folder in a row list
 * and a folder in the tree are the same shape rather than two that merely rhyme. The
 * official source is the `FolderGlyph` body path plus its 2.38px label rule.
 *
 * Two deliberate departures from the official:
 *
 * 1. **The body is `currentColor`, not a category token.** The official glyph reaches
 *    for `--dsw-static-amber-400` by default. A static token is a fixed hue, and the
 *    point of this panel is that everything follows the Harness theme, so the caller
 *    picks the tone (see `att-icon-folder` in `styles.ts`) and the glyph inherits it.
 * 2. **The label band is `--dsw-alias-bg-layer-1` rather than white.** The official
 *    marks it with a translucent white (`--dsw-static-neutral-00` at 0.7). A
 *    translucent white over an unknown caller-chosen folder colour is a contrast
 *    gamble; a theme surface token is guaranteed to differ from the plate in both
 *    themes, which is the only property the mark actually needs.
 *
 * Filled, so `Regular` and `Medium` are the same drawing — there is no stroke to
 * thicken. Both names are exported so a caller can weight every row uniformly without
 * knowing which glyphs ignore it.
 */

import { plateIcon, type IconOptions, type SvgChild } from './frame';
import type { El } from '../views/shared';

/** The 28px artboard the official folder plate is drawn against. */
const VIEW_BOX = '0 0 28 28';

/**
 * The folder body: a rounded tab on the left, a squared shoulder, and a base that
 * closes flat. Copied from the official `FolderGlyph` body path.
 */
const FOLDER_BODY =
  'M2.80078 10.2112C2.80078 9.52802 2.80078 9.18642 2.85314 8.866C2.98648 8.05 3.36942 7.29538 ' +
  '3.94925 6.70595C4.17694 6.4745 4.45264 6.2728 5.00404 5.86939C5.29197 5.65874 5.43594 5.55342 ' +
  '5.58711 5.46632C5.97089 5.24521 6.39638 5.10618 6.83667 5.05803C7.01011 5.03906 7.18849 5.03906 ' +
  '7.54524 5.03906H11.6543C12.4669 5.03906 12.8732 5.03906 13.2599 5.13697C13.3882 5.16945 13.5143 ' +
  '5.20986 13.6375 5.25795C14.0091 5.40294 14.3398 5.63902 15.0012 6.1112L16.2632 7.01224C16.5526 ' +
  '7.21881 16.6972 7.3221 16.8598 7.38553C16.9137 7.40657 16.9689 7.42425 17.025 7.43846C17.1942 ' +
  '7.4813 17.372 7.4813 17.7275 7.4813H19.8008C22.0506 7.4813 23.1755 7.4813 23.9641 8.05425C24.2188 ' +
  '8.23928 24.4428 8.46326 24.6278 8.71794C25.2008 9.50654 25.2008 10.6315 25.2008 12.8813V18.7283' +
  'C25.2008 20.9781 25.2008 22.1031 24.6278 22.8917C24.4428 23.1463 24.2188 23.3703 23.9641 23.5554' +
  'C23.1755 24.1283 22.0506 24.1283 19.8008 24.1283H8.20077C5.95094 24.1283 4.82602 24.1283 4.03743 ' +
  '23.5554C3.78274 23.3703 3.55877 23.1463 3.37373 22.8917C2.80078 22.1031 2.80078 20.9781 2.80078 ' +
  '18.7283V10.2112Z';

function folderPlate(options: IconOptions = {}): El {
  const children: SvgChild[] = [
    ['path', { d: FOLDER_BODY, fill: 'currentColor' }],
    [
      'path',
      {
        d: 'M6.31445 13.0693H21.6893',
        stroke: 'var(--dsw-alias-bg-layer-1)',
        strokeWidth: '2.38',
        strokeLinecap: 'round'
      }
    ]
  ];
  return plateIcon({
    name: 'folder',
    viewBox: VIEW_BOX,
    size: options.size ?? 28,
    className: options.className,
    children
  });
}

/** The folder at the official 1px weight; identical to {@link folderMedium} because it is filled. */
export function folderRegular(options: IconOptions = {}): El {
  return folderPlate(options);
}

/** The folder at the official 1.3px weight; identical to {@link folderRegular} because it is filled. */
export function folderMedium(options: IconOptions = {}): El {
  return folderPlate(options);
}
