import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTerminalTheme } from '../../webview/terminal/theme';
import { createTerminalOptions } from '../../webview/terminal/options';

describe('terminal theme integration', () => {
  it('resolves xterm colors from VS Code webview theme variables', () => {
    const values: Record<string, string> = {
      '--vscode-terminal-background': '#101820',
      '--vscode-terminal-foreground': '#f2f2f2',
      '--vscode-terminalCursor-foreground': '#ffcc00',
      '--vscode-terminal-selectionBackground': '#264f78',
      '--vscode-terminal-ansiRed': '#aa0000',
      '--vscode-terminal-ansiBrightGreen': '#00ff44'
    };

    // Three entries below are **not** the fixtures echoed back. `#000000` (1.2:1),
    // `#666666` (3.1:1) and `#aa0000` (2.3:1) all fail the 4.5:1 the official
    // terminal sidebar requires, so `createTerminalTheme` corrects them: the two
    // greys have no hue left to keep and become `#808080`, while the red is
    // lightened along its own hue and stays red. Asserting the uncorrected
    // literals would pin the theme to a palette that fails contrast, which is
    // the defect the correction exists to remove.
    expect(createTerminalTheme((name) => values[name])).toMatchObject({
      background: '#101820',
      foreground: '#f2f2f2',
      cursor: '#ffcc00',
      cursorAccent: '#ffffff',
      selectionBackground: '#264f78',
      black: '#808080',
      red: '#ff0707',
      green: '#b1d631',
      yellow: '#ffd866',
      blue: '#569cd6',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdcaa',
      brightBlack: '#808080',
      brightRed: '#ff6b6b',
      brightGreen: '#00ff44',
      brightYellow: '#fff569',
      brightBlue: '#82aaff',
      brightMagenta: '#ff9ccc',
      brightCyan: '#89ddff',
      brightWhite: '#ffffff'
    });
  });

  it('leaves a color that already meets the ratio byte-identical', () => {
    // The other sixteen entries in the assertion above are verbatim, and that is
    // load-bearing: a theme that already passes must not be reformatted, or every
    // future palette tweak becomes a diff in unrelated colors.
    const values: Record<string, string> = {
      '--vscode-terminal-background': '#101820',
      '--vscode-terminal-foreground': '#f2f2f2'
    };
    const theme = createTerminalTheme((name) => values[name]);
    expect(theme.background).toBe('#101820');
    expect(theme.foreground).toBe('#f2f2f2');
  });

  it('builds modern xterm options from server-provided settings', () => {
    const options = createTerminalOptions(
      {
        scrollback: 9000,
        fontSize: 16,
        fontFamily: 'JetBrains Mono'
      },
      () => undefined
    );

    expect(options).toMatchObject({
      cursorBlink: true,
      cursorStyle: 'bar',
      // Opaque theme background: transparency would only cost render performance.
      allowTransparency: false,
      scrollback: 9000,
      fontSize: 16,
      fontFamily: 'JetBrains Mono'
    });
    expect(options.theme).toMatchObject({
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#569cd6',
      selectionBackground: '#569cd633'
    });
  });

  it('enables allowTransparency only when the theme background has an alpha channel', () => {
    const translucent = createTerminalOptions(
      { scrollback: 1000, fontSize: 14, fontFamily: 'monospace' },
      (name) => (name === '--vscode-terminal-background' ? '#1e1e1e80' : undefined)
    );

    expect(translucent.allowTransparency).toBe(true);
  });

  it('does not hard-code terminal surface colors in CSS', () => {
    const css = readFileSync(join(process.cwd(), 'webview/terminal/index.css'), 'utf8');

    expect(css).toContain('var(--vscode-terminal-background');
    expect(css).toContain('.xterm-viewport');
    expect(css).toContain('background: transparent');
    expect(css).toContain('border-radius: 6px');
    expect(css).toContain('padding: 8px');
    expect(css).toContain('box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2)');
    expect(css).not.toContain('#141414');
    expect(css).not.toContain('#1e1e1e');
  });

  it('reserves bottom space through xterm padding so FitAddon reduces the row count', () => {
    const css = readFileSync(join(process.cwd(), 'webview/terminal/index.css'), 'utf8');

    expect(css).toContain('height: 100%');
    expect(css).toContain('padding: 8px 8px calc(8px + 1.5em)');
    expect(css).not.toContain('height: calc(100% - 1.5em)');
    expect(css).not.toContain('margin-bottom: 1.5em');
  });

  it('keeps the xterm host shrinkable so FitAddon can reduce cols when the panel narrows', () => {
    const css = readFileSync(join(process.cwd(), 'webview/terminal/index.css'), 'utf8');

    expect(css).toContain('min-width: 0');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('position: absolute');
    expect(css).toContain('max-width: 100%');
    expect(css).toContain('overflow-x: hidden');
  });
});
