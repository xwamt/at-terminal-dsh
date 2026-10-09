/**
 * The xterm engine for the dsh terminal page — the counterpart of
 * `webview/terminal/index.ts` with the VS Code webview glue replaced by the
 * Host↔Client channel.
 *
 * Every capability the VS Code terminal has is composed from the **same**
 * building blocks, imported from `webview/terminal/*` rather than rewritten:
 * options + theme (`createTerminalOptions`, `applyTerminalTheme`), the WebGL
 * renderer with DOM fallback (`setupTerminalRenderer`), zebra stripes
 * (`watchTerminalZebraStripes`), search (`createTerminalSearchController`),
 * clipboard and Ctrl+C/V semantics (`createTerminalKeyboardHandler`,
 * `installTerminalClipboardPasteHandler`, `installTerminalFocusRecovery`), and
 * the output path with legacy-encoding decoding, semantic highlighting and the
 * flow-control acknowledgement (`createTerminalByteDecoder`,
 * `writeTerminalOutputMessage`).
 *
 * What changes is only the seam:
 *
 * - `acquireVsCodeApi().postMessage({type:'input'})` becomes the injected
 *   `hooks.onInput` (the caller sends `terminal.input` over the WebSocket);
 * - resize reporting becomes `hooks.onResize` (`terminal.resize`);
 * - the theme reader reads computed styles from the **panel root**, where
 *   `styles.ts` bridges `--vscode-*` onto the Harness `--dsw-alias-*` tokens,
 *   instead of `document.body` (the page belongs to the Harness, not to us);
 * - the document-level Ctrl+F listener is dropped — on a shared page it would
 *   hijack the browser's find while focus is outside the panel. The shortcut
 *   still works through xterm's own key handler when the terminal has focus.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

import {
  createTerminalKeyboardHandler,
  installTerminalClipboardPasteHandler,
  installTerminalFocusRecovery,
  type TerminalClipboard
} from '../../../../webview/terminal/clipboard';
import { createTerminalOptions } from '../../../../webview/terminal/options';
import {
  createTerminalByteDecoder,
  writeTerminalOutputMessage,
  type TerminalOutputOptions
} from '../../../../webview/terminal/output';
import { setupTerminalRenderer } from '../../../../webview/terminal/renderer';
import {
  createTerminalSearchController,
  isTerminalSearchShortcut,
  type TerminalSearchController
} from '../../../../webview/terminal/search';
import { applyTerminalTheme } from '../../../../webview/terminal/theme';
import { watchTerminalZebraStripes } from '../../../../webview/terminal/zebra';

export interface TerminalUiSettings {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  semanticHighlight: boolean;
  zebraStripes: boolean;
}

export interface TerminalEngineHooks {
  /** Keystroke/paste bytes for the remote PTY. */
  onInput(data: string): void;
  /** The fitted grid changed; report `terminal.resize`. */
  onResize(rows: number, cols: number): void;
}

export interface TerminalSearchElements {
  bar: HTMLElement;
  input: HTMLInputElement;
  prev: HTMLElement;
  next: HTMLElement;
  close: HTMLElement;
}

export interface TerminalEngine {
  /**
   * Write one decoded-or-raw chunk of remote output. `acknowledge` fires when
   * xterm has consumed the chunk, with its original byte length — the hook the
   * flow controller subtracts from.
   */
  writeOutput(bytes: Uint8Array, acknowledge: (byteLength: number) => void): void;
  /** Switch the legacy-encoding decoder (per-server `encoding`). */
  setEncoding(encoding: string | undefined): void;
  /** Re-fit to the container and report the size, e.g. after the page becomes visible. */
  fit(): void;
  focus(): void;
  readonly cols: number;
  readonly rows: number;
  dispose(): void;
}

export interface CreateTerminalEngineOptions {
  container: HTMLElement;
  /** The panel root carrying the bridged `--vscode-*` variables. */
  root: HTMLElement;
  settings: TerminalUiSettings;
  encoding: string | undefined;
  hooks: TerminalEngineHooks;
  search: TerminalSearchElements;
}

export function createTerminalEngine(options: CreateTerminalEngineOptions): TerminalEngine {
  const { container, root, settings, hooks, search } = options;

  // The theme reader reads from the panel root, where the token bridge lives;
  // reading `document.body` would see the Harness page, which defines none of
  // the `--vscode-*` names the reused theme module asks for.
  const readCssVariable = (name: string): string | undefined =>
    getComputedStyle(root).getPropertyValue(name);

  const term = new Terminal(
    createTerminalOptions(
      {
        scrollback: settings.scrollback,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily
      },
      readCssVariable
    )
  );

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  term.open(container);

  // Zebra striping restyles DOM rows, so it forces the DOM renderer; otherwise
  // WebGL is attached and any load failure or GPU context loss falls back.
  setupTerminalRenderer(term, {
    zebraStripes: settings.zebraStripes,
    createWebglAddon: () => new WebglAddon()
  });
  const zebraWatcher = settings.zebraStripes ? watchTerminalZebraStripes(term, container) : undefined;

  // Theme: re-apply whenever the host flips light/dark. The Harness theme
  // service swaps attributes on the document element; observing every attribute
  // of both roots is cheap and catches class, style and data-* strategies alike.
  let themeFrame = 0;
  const reapplyTheme = (): void => {
    if (themeFrame !== 0) return;
    themeFrame = requestAnimationFrame(() => {
      themeFrame = 0;
      applyTerminalTheme(term, root);
    });
  };
  const themeObserver = new MutationObserver(reapplyTheme);
  const themeFilter = { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] };
  themeObserver.observe(document.documentElement, themeFilter);
  themeObserver.observe(document.body, themeFilter);

  const clipboard: TerminalClipboard = {
    readText: () => navigator.clipboard?.readText() ?? Promise.resolve(''),
    writeText: (value) => navigator.clipboard?.writeText(value) ?? Promise.resolve()
  };

  const searchController: TerminalSearchController = createTerminalSearchController(searchAddon, {
    bar: search.bar,
    input: search.input,
    focusTerminal: () => term.focus()
  });
  const onSearchKeydown = (event: Event): void =>
    searchController.handleInputKeydown(event as KeyboardEvent);
  const onSearchInput = (): void => searchController.findNext();
  const onPrev = (): void => searchController.findPrevious();
  const onNext = (): void => searchController.findNext();
  const onClose = (): void => searchController.close();
  search.input.addEventListener('keydown', onSearchKeydown);
  search.input.addEventListener('input', onSearchInput);
  search.prev.addEventListener('click', onPrev);
  search.next.addEventListener('click', onNext);
  search.close.addEventListener('click', onClose);

  const keyboardHandler = createTerminalKeyboardHandler(term, {
    clipboard,
    sendInput: (data) => hooks.onInput(data)
  });
  term.attachCustomKeyEventHandler((event) => {
    if (isTerminalSearchShortcut(event)) {
      searchController.open();
      return false;
    }
    return keyboardHandler(event);
  });
  if (term.textarea !== undefined) {
    installTerminalClipboardPasteHandler(term, term.textarea);
  }
  installTerminalFocusRecovery(term, {
    container,
    document,
    setTimeout: window.setTimeout.bind(window)
  });

  term.onData((data) => hooks.onInput(data));

  let lastCols = 0;
  let lastRows = 0;
  let fitFrame = 0;

  const fitAndNotify = (force: boolean): void => {
    try {
      fitAddon.fit();
    } catch {
      // A detached or zero-sized container (the page is hidden) cannot be fitted;
      // the next visibility change fits again.
      return;
    }
    if (!force && term.cols === lastCols && term.rows === lastRows) return;
    lastCols = term.cols;
    lastRows = term.rows;
    hooks.onResize(term.rows, term.cols);
  };

  const scheduleFit = (force = false): void => {
    if (fitFrame !== 0) cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      fitAndNotify(force);
    });
  };

  const resizeObserver = new ResizeObserver(() => scheduleFit(false));
  resizeObserver.observe(container);
  const onWindowResize = (): void => scheduleFit(false);
  window.addEventListener('resize', onWindowResize);

  // The decoder is stateful (`stream: true`) so multi-byte GBK/Big5 sequences
  // split across chunks survive; it is recreated per encoding switch, never per
  // message.
  let outputOptions: TerminalOutputOptions = {
    semanticHighlight: settings.semanticHighlight,
    decodeBytes: createTerminalByteDecoder(options.encoding)
  };

  scheduleFit(true);

  return {
    writeOutput(bytes: Uint8Array, acknowledge: (byteLength: number) => void): void {
      writeTerminalOutputMessage({ type: 'outputBytes', payload: bytes }, term, {
        ...outputOptions,
        acknowledge
      });
    },
    setEncoding(encoding: string | undefined): void {
      outputOptions = {
        ...outputOptions,
        decodeBytes: createTerminalByteDecoder(encoding)
      };
    },
    fit(): void {
      scheduleFit(true);
    },
    focus(): void {
      term.focus();
    },
    get cols(): number {
      return term.cols;
    },
    get rows(): number {
      return term.rows;
    },
    dispose(): void {
      if (fitFrame !== 0) cancelAnimationFrame(fitFrame);
      if (themeFrame !== 0) cancelAnimationFrame(themeFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', onWindowResize);
      themeObserver.disconnect();
      zebraWatcher?.dispose();
      search.input.removeEventListener('keydown', onSearchKeydown);
      search.input.removeEventListener('input', onSearchInput);
      search.prev.removeEventListener('click', onPrev);
      search.next.removeEventListener('click', onNext);
      search.close.removeEventListener('click', onClose);
      term.dispose();
    }
  };
}