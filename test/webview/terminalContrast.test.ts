import { describe, expect, it } from 'vitest';
import {
  auditTerminalTheme,
  contrastRatio,
  ensureContrast,
  parseColor,
  pickAdjustDirection
} from '../../webview/terminal/contrast';

const BG = '#101820';
const bg = parseColor(BG)!;

describe('terminal contrast — the numbers the official sidebar states', () => {
  it('measures WCAG reference pairs exactly', () => {
    // Published values: black/white 21, #777 on white 4.478, #767676 on white 4.542.
    expect(contrastRatio(parseColor('#000000')!, parseColor('#ffffff')!)).toBeCloseTo(21, 2);
    expect(contrastRatio(parseColor('#777777')!, parseColor('#ffffff')!)).toBeCloseTo(4.478, 2);
    expect(contrastRatio(parseColor('#767676')!, parseColor('#ffffff')!)).toBeCloseTo(4.542, 2);
  });

  it('reports the three palette entries that used to fail, and passes them after correction', () => {
    // The literals the VS Code palette shipped, against the terminal background.
    for (const [name, value] of [
      ['black', '#000000'],
      ['brightBlack', '#666666'],
      ['red', '#aa0000']
    ] as const) {
      const before = contrastRatio(parseColor(value)!, bg);
      expect(before, `${name} was expected to fail before correction`).toBeLessThan(4.5);
      const after = contrastRatio(parseColor(ensureContrast(value, BG, 4.5, 'lighten'))!, bg);
      expect(after, `${name} must clear 4.5:1 after correction`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('never rewrites a color that already passes', () => {
    // Verbatim return matters: the red-line test asserts 16 of the 19 values byte for byte.
    for (const value of ['#b1d631', '#569cd6', '#c678dd', '#f2f2f2', '#56b6c2']) {
      expect(ensureContrast(value, BG, 4.5, 'lighten')).toBe(value);
    }
  });

  it('keeps the cursor bar at 3:1 rather than the 4.5:1 of text', () => {
    const direction = pickAdjustDirection(BG, 3);
    const fixed = ensureContrast('#569cd6', BG, 3, direction);
    expect(contrastRatio(parseColor(fixed)!, bg)).toBeGreaterThanOrEqual(3);
  });

  it('preserves hue when it has to lighten a semantic color', () => {
    // A darker red that stops reading as "error" would be worse than a slightly-off grey.
    const lifted = ensureContrast('#aa0000', BG, 4.5, 'lighten');
    const { r, g, b } = parseColor(lifted)!;
    expect(r, 'red must stay dominant').toBeGreaterThan(g * 2);
    expect(r, 'red must stay dominant').toBeGreaterThan(b * 2);
  });

  it('walks the whole theme and reports every row', () => {
    const theme = {
      background: BG,
      foreground: '#f2f2f2',
      cursor: '#569cd6',
      black: '#808080',
      red: '#ff0707',
      brightBlack: '#808080'
    };
    const rows = auditTerminalTheme(theme, 4.5, 3);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.ok, `${row.name} at ${row.ratio}`).toBe(row.ratio >= row.required);
    }
  });
});
