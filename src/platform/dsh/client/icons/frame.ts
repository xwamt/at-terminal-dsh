/**
 * The two pieces every glyph in here shares: the `<svg>` frame, and the weight pair.
 *
 * ## Why the Harness primitive package is not imported
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is a Host-internal package, so importing it
 * is not a style question but a load failure: `dsh/scripts/verify.mjs` rejects any
 * `@deepseek-ai/dsh-*` specifier outright, because the npm preview is an older release
 * and a `link:` install cannot resolve the sandbox copy. What is legitimate is the
 * geometry itself, so the path data below is copied from the primitive package and
 * re-expressed here under this panel's own `att-` class names. Only the `--dsw-alias-*`
 * token references survive that copy; the primitive's own `--dsw-static-*` literals do
 * not (see the file notes on `file.ts` and `folder.ts` for what replaced them).
 *
 * ## Weights are a parameter, not a second file
 *
 * The official rule is one geometry exported twice: `Regular` is the supplied 1px line,
 * `Medium` is *the same geometry* at 1.3px. A separate 1.3px drawing would be a second
 * thing free to drift, and these glyphs are small enough that any drift would be a
 * visible misalignment rather than a subtle one. So each icon file holds one geometry
 * and exports it at both weights.
 *
 * The exception is the filled glyphs. `folder.ts` and `file.ts` are solid plates with
 * no stroke, and the official catalog is explicit that fill-only pairs render
 * identically — there is no line to thicken. They still export both names, because a
 * caller picking a weight should not have to know which glyphs happen to ignore it.
 *
 * ## Colour
 *
 * Everything is `currentColor` or a `--dsw-alias-*` token, so a glyph follows the theme
 * without knowing what the theme is. There are no literal colours: a hardcoded value
 * cannot follow the light/dark switch, which is the same reason the `--vscode-*` bridge
 * in `styles.ts` carries no literal fallbacks.
 *
 * ## Accessibility
 *
 * Every glyph is `aria-hidden`. Each one sits beside a label that already names it, so
 * exposing the glyph adds a second, redundant announcement rather than information.
 * The corollary is that a caller must render the name in text — an icon-only control
 * needs an `aria-label` of its own.
 */

import { h, type El } from '../views/shared';

/** The official 1px product-icon weight. */
export const REGULAR_STROKE = 1;

/**
 * The official 1.3px product-icon weight.
 *
 * 1.3 rather than 1.5 because that is the number the design system pairs with the 1px
 * artwork; a rounder value would be a second, unofficial weight that no other glyph in
 * the product shares, and the mismatch shows wherever a 14px row puts a Medium glyph
 * next to a Regular one.
 */
export const MEDIUM_STROKE = 1.3;

/** The SVG namespace. React needs it spelled out for a server-side or detached render. */
const XMLNS = 'http://www.w3.org/2000/svg';

export type IconOptions = {
  /** Rendered edge length in px. The viewBox is what the geometry is authored against. */
  size?: number;
  /** Appended to this panel's own base classes, never replacing them. */
  className?: string;
};

/**
 * The panel's class names for a glyph: a shared base plus the per-glyph hook.
 *
 * The caller's `className` is appended rather than swapped in, so a glyph stays
 * identifiable and styleable from `styles.ts` even when a view gives it a layout class
 * of its own.
 */
function iconClass(name: string, extra?: string): string {
  return extra ? `att-icon att-icon-${name} ${extra}` : `att-icon att-icon-${name}`;
}

/**
 * One child element: its tag and its props.
 *
 * A tuple rather than a bare props object because `createElement` takes the tag as its
 * first argument — passing a lone `{ d: ... }` as a child would hand React an object
 * where it expects an element, and it throws. Keeping the tag in the data lets a glyph
 * file describe its geometry as plain values while the frame still builds real elements.
 */
export type SvgChild = readonly [tag: 'path' | 'rect' | 'circle', props: Record<string, unknown>];

function renderChildren(children: SvgChild[]): unknown[] {
  return children.map(([tag, props]) => h(tag, props));
}

/**
 * A stroked glyph: `fill="none"` with `currentColor` lines, the shape most of a product
 * icon set is made of.
 *
 * The stroke lives on the root `<svg>` rather than on each path, so a glyph cannot end
 * up with two weights in it — a per-path `strokeWidth` is exactly the drift the
 * single-geometry rule above exists to prevent.
 */
export function lineIcon(options: {
  name: string;
  viewBox: string;
  strokeWidth: number;
  size?: number;
  className?: string;
  strokeLinecap?: 'round' | 'butt' | 'square';
  strokeLinejoin?: 'round' | 'miter' | 'bevel';
  children: SvgChild[];
}): El {
  return h(
    'svg',
    {
      width: options.size,
      height: options.size,
      viewBox: options.viewBox,
      fill: 'none',
      xmlns: XMLNS,
      // Decorative by construction: every call site pairs the glyph with a text label,
      // so a non-hidden icon makes a screen reader say the same thing twice.
      'aria-hidden': 'true',
      className: iconClass(options.name, options.className),
      stroke: 'currentColor',
      strokeWidth: options.strokeWidth,
      strokeLinecap: options.strokeLinecap,
      strokeLinejoin: options.strokeLinejoin
    },
    ...renderChildren(options.children)
  );
}

/**
 * A filled glyph: the root stays `fill="none"` and each child carries its own fill.
 *
 * Kept separate from `lineIcon` because a plate needs per-child fills (a body, then a
 * corner in a second tone) and must not inherit a `currentColor` stroke it would then
 * outline itself with.
 */
export function plateIcon(options: {
  name: string;
  viewBox: string;
  size?: number;
  className?: string;
  children: SvgChild[];
}): El {
  return h(
    'svg',
    {
      width: options.size,
      height: options.size,
      viewBox: options.viewBox,
      fill: 'none',
      xmlns: XMLNS,
      'aria-hidden': 'true',
      className: iconClass(options.name, options.className)
    },
    ...renderChildren(options.children)
  );
}
