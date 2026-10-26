import { isMacPlatform } from './platform';

export interface TerminalClipboard {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}

interface ClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
  focus(): void;
}

interface PasteTerminal {
  paste(data: string): void;
  focus(): void;
}

interface KeyboardHandlerOptions {
  clipboard: TerminalClipboard;
  sendInput(data: string): void;
  /**
   * Force the Command-vs-Control family instead of detecting it.
   *
   * Only the tests set this: the handler has to behave the same in the VS Code webview and the
   * DSH browser page, and both read the platform off `navigator`.
   */
  isMac?: boolean;
}

interface FocusRecoveryOptions {
  container: EventTarget;
  document: EventTarget;
  setTimeout: (callback: () => void, delay?: number) => unknown;
}

const INTERRUPT_BYTE = '\x03';

export function createTerminalKeyboardHandler(
  terminal: ClipboardTerminal,
  options: KeyboardHandlerOptions
): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown') {
      return true;
    }

    const isMac = options.isMac ?? isMacPlatform();
    const key = event.key.toLowerCase();

    if (isMac) {
      /*
       * Command is the platform's copy/paste modifier; Control belongs to the shell.
       *
       * The old handler required Control on every platform, which on macOS turned Ctrl+C into
       * "copy" and left Cmd+C doing nothing — the Windows habits the panel was ported with. A
       * mac user now gets Ctrl+C = SIGINT (xterm's own mapping) and Cmd+C = copy.
       */
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return true;
      }
      if (key === 'c') {
        // xterm's selection is not a native text selection, so the browser's own copy cannot see
        // it; consume the gesture even when nothing is selected so it cannot fall through.
        event.preventDefault();
        if (terminal.hasSelection()) {
          void options.clipboard
            .writeText(terminal.getSelection())
            .then(() => terminal.clearSelection())
            .finally(() => terminal.focus());
        }
        return false;
      }
      /*
       * Cmd+V is deliberately left to the browser: it fires a real `paste` event on the xterm
       * textarea, which `installTerminalClipboardPasteHandler` consumes with the clipboard
       * payload. Reading the clipboard from keydown would need an extra permission for no gain.
       */
      return true;
    }

    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      return true;
    }

    if (key === 'c') {
      if (terminal.hasSelection()) {
        void options.clipboard
          .writeText(terminal.getSelection())
          .then(() => terminal.clearSelection())
          .finally(() => terminal.focus());
        return false;
      }

      options.sendInput(INTERRUPT_BYTE);
      terminal.focus();
      return false;
    }

    if (key === 'v') {
      event.preventDefault();
      event.stopImmediatePropagation();
      void options.clipboard
        .readText()
        .then((text) => {
          if (text) {
            terminal.paste(text);
          }
        })
        .catch(() => undefined)
        .finally(() => terminal.focus());
      return false;
    }

    return true;
  };
}

/**
 * Installs the copy/paste focus recovery and returns the disposer that removes it.
 *
 * The disposer is not optional bookkeeping: these listeners live on the **document**, so a caller
 * that drops the returned function leaks two listeners per installed terminal, and every copy or
 * paste anywhere in the page then calls `focus()` on a terminal that has already been disposed —
 * which either no-ops on a detached textarea or yanks the caret out of whatever field the user was
 * actually in. The dsh client rebuilds its engine on every settings/encoding change, so this used
 * to grow by two listeners per rebuild for the life of the page.
 */
export function installTerminalFocusRecovery(
  terminal: Pick<ClipboardTerminal, 'focus'>,
  options: FocusRecoveryOptions
): () => void {
  const scheduleFocus = () => {
    options.setTimeout(() => terminal.focus(), 0);
  };

  options.document.addEventListener('copy', scheduleFocus);
  options.document.addEventListener('paste', scheduleFocus);
  return () => {
    options.document.removeEventListener('copy', scheduleFocus);
    options.document.removeEventListener('paste', scheduleFocus);
  };
}

export function installTerminalClipboardPasteHandler(terminal: PasteTerminal, target: EventTarget): void {
  target.addEventListener(
    'paste',
    (event) => {
      const clipboardEvent = event as ClipboardEvent;
      const text = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
      if (!text) {
        return;
      }

      clipboardEvent.preventDefault();
      clipboardEvent.stopImmediatePropagation();
      terminal.paste(text);
      terminal.focus();
    },
    true
  );
}

export type TerminalStatusState = 'connected' | 'disconnected' | 'connecting';

export interface TerminalStatusPayload {
  state: TerminalStatusState;
  text: string;
}

/**
 * The host always sends a structured `{ state, text }` status. The class comes from the
 * machine-readable state alone — matching on display text broke as soon as the text was
 * localized (Chinese 已断开连接 used to render as "connecting").
 */
export function resolveTerminalStatusClass(state: unknown): TerminalStatusState {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'connecting';
  }
}
