/**
 * The panel's icon set: six glyphs, each at the official `Regular` (1px) and `Medium`
 * (1.3px) weights.
 *
 * Geometry is copied from `@deepseek-ai/dsh-client-ui-primitives`, which this package
 * deliberately does not import (see `frame.ts` for why that is a load failure rather
 * than a style preference). What is *not* copied is the import: there is no
 * `@deepseek-ai/dsh-*` specifier anywhere under this directory, which is what
 * `dsh/scripts/verify.mjs` requires of a shipped bundle.
 *
 * Two families, and the difference decides which weight a caller should reach for:
 *
 * - **stroked** (`terminal`, `server`, `warningTriangle`, `refresh`) — `Regular` for a
 *   quiet inline mark, `Medium` where the glyph is the point of the control (a retry
 *   button, a selected tab).
 * - **filled** (`folder`, `file`) — both weights are the same drawing, because a plate
 *   has no stroke to thicken. They are still exported at both names so a row of mixed
 *   icons can be weighted uniformly without the caller special-casing them.
 *
 * Every glyph is `aria-hidden`. A caller rendering one on its own — an icon-only button
 * — must supply the accessible name itself; a glyph next to a text label must not.
 */

export { fileMedium, fileRegular } from './file';
export { folderMedium, folderRegular } from './folder';
export { refreshMedium, refreshRegular } from './refresh';
export { serverMedium, serverRegular } from './server';
export { terminalMedium, terminalRegular } from './terminal';
export { warningTriangleMedium, warningTriangleRegular } from './warningTriangle';

/* ---- UI2-06: the glyphs the chrome was drawing with characters and emoji ---- */
export { gaugeMedium, gaugeRegular } from './gauge';
export {
  chevronDownMedium,
  chevronDownRegular,
  chevronRightMedium,
  chevronRightRegular,
  chevronUpRegular,
  type ChevronDirection
} from './chevron';
export { closeMedium, closeRegular, gripRegular } from './close';
export { boltMedium, boltRegular, symlinkMedium, symlinkRegular } from './bolt';
export { guideTerminalArtwork } from './artwork';

export { MEDIUM_STROKE, REGULAR_STROKE, type IconOptions } from './frame';
