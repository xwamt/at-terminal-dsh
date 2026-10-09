/**
 * WCAG 2.x contrast math for terminal colors.
 *
 * Deliberately DOM-free and dependency-free: the DSH spec requires xterm to reach
 * 4.5:1 for text and 3:1 for the cursor against the terminal background, and the
 * only way to prove that holds is to keep the math callable from a plain unit test.
 */

/** Opaque or translucent sRGB color. Channels are 0-255, `alpha` is 0-1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

/** One row of the diagnostic table returned by {@link auditTerminalTheme}. */
export interface ContrastReportEntry {
  name: string;
  ratio: number;
  required: number;
  ok: boolean;
}

/**
 * Which way a foreground color may be pushed to gain contrast.
 *
 * The caller picks the direction from the background (see {@link pickAdjustDirection});
 * this module never guesses, because "lighten" is exactly wrong for a light theme.
 */
export type ContrastAdjust = 'lighten' | 'darken';

/**
 * Canonical ANSI palette order.
 *
 * Owned here rather than in `theme.ts` so the audit table has a stable display order
 * that does not depend on object key insertion order. `theme.ts` keys its fallback map
 * by the same names; the two lists must stay in sync.
 */
export const ANSI_COLOR_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

/**
 * WCAG linearisation breakpoint and gamma, spelled out because the 0.03928 /
 * 12.92 / 0.055 / 1.055 / 2.4 constants are not interchangeable between the
 * WCAG 1.x and 2.x revisions and mixing them shifts every ratio slightly.
 */
const LINEAR_BREAKPOINT = 0.03928;
const LINEAR_DIVISOR = 12.92;
const LINEAR_OFFSET = 0.055;
const LINEAR_SCALE = 1.055;
const LINEAR_GAMMA = 2.4;
const CHANNEL_MAX = 255;

/** Lightness step used when walking a color toward an extreme (0.5% of the range). */
const LIGHTNESS_STEP = 0.005;
/** Interpolation steps used for the grayscale fallback ramp. */
const GRAY_STEP = 0.05;

/**
 * Parses `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`.
 *
 * Alpha decision: the channel is parsed and preserved on the result, but it is
 * **never** used to excuse a failing color. WCAG relative luminance is only defined
 * for opaque sRGB, so every measurement in this module happens on a color that has
 * already been composited onto the (opaque) terminal background — see
 * {@link contrastRatio} and the `compositeOver` call in {@link ensureContrast}.
 * Rationale: treating `#rrggbbaa` as if it were `#rrggbb` would *overstate* the
 * contrast of exactly the translucent tokens (dimmed comments, faint separators)
 * that most need checking, and rejecting it outright would make the audit silently
 * skip real palette entries instead of measuring them.
 *
 * Anything non-hex (`rgb()`, a named color, an unresolved `var()`) returns `null`;
 * callers treat that as "cannot measure" and leave the authored token untouched
 * rather than guessing at a replacement.
 */
export function parseColor(input: string | undefined): Rgb | null {
  if (!input) {
    return null;
  }
  const value = input.trim().toLowerCase();
  if (!value.startsWith('#')) {
    return null;
  }
  const digits = value.slice(1);
  const isShort = digits.length === 3 || digits.length === 4;
  if (!isShort && digits.length !== 6 && digits.length !== 8) {
    return null;
  }
  if (!/^[0-9a-f]+$/.test(digits)) {
    return null;
  }
  const expanded = isShort ? digits.split('').map((char) => char + char).join('') : digits;
  const channel = (offset: number): number => parseInt(expanded.slice(offset, offset + 2), 16);
  const hasAlpha = expanded.length === 8;
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    alpha: hasAlpha ? channel(6) / CHANNEL_MAX : 1
  };
}

/**
 * WCAG relative luminance. Ignores `alpha` on purpose — callers must composite first,
 * because luminance of a translucent color is not defined, only of what it renders as.
 */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/** WCAG contrast ratio: order-independent, so callers need not sort by luminance. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Chooses the only direction worth trying for a given background.
 *
 * The rule is "if pure white already clears the bar against this background, lightening
 * is the cheaper fix; otherwise darkening is the *only* fix". That framing matters
 * because the two extremes are not symmetric: against a mid-light background (say
 * luminance 0.45) white yields 2.1:1 and no amount of lightening can help, while black
 * yields plenty. Deriving the threshold from the actual requirement (`(1.05 / min) - 0.05`)
 * instead of a hard-coded 0.5 keeps the cursor's 3:1 and text's 4.5:1 each on the
 * correct side of the crossover, including the narrow luminance band where neither
 * extreme can reach 4.5:1 at all.
 */
export function pickAdjustDirection(background: string, min: number): ContrastAdjust {
  const parsed = parseColor(background);
  if (!parsed) {
    // Unmeasurable background: lightening is the safer guess because the DSH default
    // terminal background is dark, so the unhandled case is overwhelmingly dark too.
    return 'lighten';
  }
  const luminance = relativeLuminance({ ...parsed, alpha: 1 });
  // Pure white has relative luminance 1.0, so its contrast against this background is
  // (1.0 + 0.05) / (luminance + 0.05). Inverting that for `min` gives the crossover
  // luminance below which lightening can still reach the requirement.
  const WHITE_REFERENCE = 1 + 0.05;
  return luminance <= WHITE_REFERENCE / min - 0.05 ? 'lighten' : 'darken';
}

/**
 * Returns `fg` unchanged when it already clears `min` against `bg`, otherwise a hex
 * color adjusted until it does.
 *
 * Hues are preserved while the color is still meaningful (official spec: "darker themes
 * use lighter, less saturated text"), so `red` stays recognizably red instead of being
 * dragged toward white. Grayscale is the last resort, not the first: an ANSI palette
 * whose errors stop reading as red is worse for accessibility than one whose greys are
 * slightly off, so hue is only surrendered when the requested direction runs out of
 * headroom (e.g. `black` on a dark background has no hue left to keep). At HSL
 * lightness 1 every hue collapses to white anyway, so the "keep the hue" ramp and the
 * grayscale ramp meet at the same extreme — the distinction only decides which path
 * gets taken, not where they end up.
 *
 * Unparseable input on either side returns `fg` verbatim: a token we cannot measure
 * must not be silently replaced, and the original string form (including any alpha
 * suffix) is preserved for every color that already passes.
 */
export function ensureContrast(fg: string, bg: string, min: number, adjust: ContrastAdjust): string {
  const parsedBg = parseColor(bg);
  const parsedFg = parseColor(fg);
  if (!parsedBg || !parsedFg) {
    return fg;
  }

  const backdrop: Rgb = { ...parsedBg, alpha: 1 };
  const solid = compositeOver(parsedFg, backdrop);
  if (contrastRatio(solid, backdrop) >= min) {
    return fg;
  }

  let best = solid;
  let bestRatio = contrastRatio(solid, backdrop);
  const consider = (candidate: Rgb): boolean => {
    const ratio = contrastRatio(candidate, backdrop);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
    return ratio >= min;
  };

  const hsl = rgbToHsl(solid);
  const lightnessDelta = adjust === 'lighten' ? LIGHTNESS_STEP : -LIGHTNESS_STEP;
  for (let step = 1; step * LIGHTNESS_STEP <= 1; step += 1) {
    const lightness = hsl.l + lightnessDelta * step;
    if (lightness < 0 || lightness > 1) {
      break;
    }
    const candidate = hslToRgb(hsl.h, hsl.s, lightness);
    if (consider(candidate)) {
      return toHex(candidate);
    }
  }

  const grayTarget = adjust === 'lighten' ? 0 : CHANNEL_MAX;
  for (let fraction = GRAY_STEP; fraction <= 1; fraction += GRAY_STEP) {
    const candidate: Rgb = {
      r: Math.round(solid.r + (grayTarget - solid.r) * fraction),
      g: Math.round(solid.g + (grayTarget - solid.g) * fraction),
      b: Math.round(solid.b + (grayTarget - solid.b) * fraction),
      alpha: 1
    };
    if (consider(candidate)) {
      return toHex(candidate);
    }
  }

  // No color reaches `min` against this background (possible for a mid-luminance
  // background, where both extremes fall short). Emit the best candidate found so the
  // theme stays as close to spec as physically possible instead of reverting.
  return toHex(best);
}

/**
 * Measures foreground, cursor and the 16 ANSI colors against the theme background.
 * Diagnostics and tests only — `createTerminalTheme` corrects colors as it builds them
 * and never calls this, to keep the hot theme path free of measurement work for colors
 * that already passed.
 *
 * Takes `object` rather than xterm's `ITheme` on purpose: `ITheme` is an interface with
 * no index signature, so it is not assignable to `Record<string, string>`, and
 * redeclaring all 19 theme fields here would just be a second place to forget a key.
 */
export function auditTerminalTheme(theme: object, minText: number, minCursor: number): ContrastReportEntry[] {
  const record = theme as Record<string, unknown>;
  const background = parseColor(asColorString(record.background));
  const entries: ContrastReportEntry[] = [];

  const measure = (name: string, required: number): void => {
    const parsed = parseColor(asColorString(record[name]));
    if (!background || !parsed) {
      return;
    }
    const ratio = contrastRatio(compositeOver(parsed, { ...background, alpha: 1 }), { ...background, alpha: 1 });
    entries.push({ name, ratio: round(ratio), required, ok: ratio >= required });
  };

  measure('foreground', minText);
  measure('cursor', minCursor);
  for (const name of ANSI_COLOR_NAMES) {
    measure(name, minText);
  }
  return entries;
}

function asColorString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function linearize(channel: number): number {
  const normalized = channel / CHANNEL_MAX;
  return normalized <= LINEAR_BREAKPOINT
    ? normalized / LINEAR_DIVISOR
    : Math.pow((normalized + LINEAR_OFFSET) / LINEAR_SCALE, LINEAR_GAMMA);
}

/** Alpha compositing of `source` over an already-opaque `backdrop`. */
function compositeOver(source: Rgb, backdrop: Rgb): Rgb {
  if (source.alpha >= 1) {
    return { ...source, alpha: 1 };
  }
  return {
    r: source.r * source.alpha + backdrop.r * (1 - source.alpha),
    g: source.g * source.alpha + backdrop.g * (1 - source.alpha),
    b: source.b * source.alpha + backdrop.b * (1 - source.alpha),
    alpha: 1
  };
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const red = r / CHANNEL_MAX;
  const green = g / CHANNEL_MAX;
  const blue = b / CHANNEL_MAX;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) {
    return { h: 0, s: 0, l: lightness };
  }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) {
    hue = ((green - blue) / delta) % 6;
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }
  hue *= 60;
  if (hue < 0) {
    hue += 360;
  }
  return { h: hue, s: saturation, l: lightness };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = h / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  let rgb: [number, number, number];
  if (sector < 1) {
    rgb = [chroma, x, 0];
  } else if (sector < 2) {
    rgb = [x, chroma, 0];
  } else if (sector < 3) {
    rgb = [0, chroma, x];
  } else if (sector < 4) {
    rgb = [0, x, chroma];
  } else if (sector < 5) {
    rgb = [x, 0, chroma];
  } else {
    rgb = [chroma, 0, x];
  }
  const offset = l - chroma / 2;
  return {
    r: Math.round((rgb[0] + offset) * CHANNEL_MAX),
    g: Math.round((rgb[1] + offset) * CHANNEL_MAX),
    b: Math.round((rgb[2] + offset) * CHANNEL_MAX),
    alpha: 1
  };
}

function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(CHANNEL_MAX, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Ratios are reported to 2 decimals: enough to judge 4.5:1, short enough to read in a diff. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}