import { describe, expect, it, vi } from 'vitest';
import { isMacPlatform } from '../../webview/terminal/platform';
import {
  createTerminalKeyboardHandler,
  installTerminalClipboardPasteHandler,
  installTerminalFocusRecovery,
  resolveTerminalStatusClass,
  type TerminalClipboard
} from '../../webview/terminal/clipboard';

function keyEvent(
  key: string,
  modifiers: Partial<{
    type: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {}
): KeyboardEvent {
  return {
    type: 'keydown',
    key,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  } as unknown as KeyboardEvent;
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  fire(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function pasteEvent(text: string) {
  return {
    clipboardData: {
      getData: vi.fn((type: string) => (type === 'text/plain' ? text : ''))
    },
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  };
}

async function flushClipboardPromise(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('terminal clipboard shortcuts', () => {
  it('copies the current xterm selection on Ctrl+C without sending interrupt input', async () => {
    const clipboard: TerminalClipboard = {
      readText: vi.fn(),
      writeText: vi.fn(async () => undefined)
    };
    const sendInput = vi.fn();
    const handler = createTerminalKeyboardHandler(
      {
        hasSelection: () => true,
        getSelection: () => 'selected text',
        clearSelection: vi.fn(),
        focus: vi.fn(),
        paste: vi.fn()
      },
      { clipboard, sendInput, isMac: false }
    );

    expect(handler(keyEvent('c'))).toBe(false);
    await Promise.resolve();

    expect(clipboard.writeText).toHaveBeenCalledWith('selected text');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('sends the terminal interrupt byte on a single Ctrl+C when there is no selection', () => {
    const sendInput = vi.fn();
    const handler = createTerminalKeyboardHandler(
      {
        hasSelection: () => false,
        getSelection: () => '',
        clearSelection: vi.fn(),
        focus: vi.fn(),
        paste: vi.fn()
      },
      {
        clipboard: { readText: vi.fn(), writeText: vi.fn() },
        sendInput,
        isMac: false
      }
    );

    expect(handler(keyEvent('c'))).toBe(false);
    expect(sendInput).toHaveBeenCalledWith('\x03');
  });

  it('pastes Ctrl+V through the terminal paste API when the xterm input is focused', async () => {
    const sendInput = vi.fn();
    const readText = vi.fn(async () => 'pasted text');
    const event = keyEvent('v');
    const terminal = {
      hasSelection: () => false,
      getSelection: () => '',
      clearSelection: vi.fn(),
      focus: vi.fn(),
      paste: vi.fn()
    };
    const handler = createTerminalKeyboardHandler(
      terminal,
      {
        clipboard: {
          readText,
          writeText: vi.fn()
        },
        sendInput,
        isMac: false
      }
    );

    expect(handler(event)).toBe(false);
    await flushClipboardPromise();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith('pasted text');
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps focus and does not send input when Ctrl+V clipboard access fails', async () => {
    const sendInput = vi.fn();
    const event = keyEvent('v');
    const terminal = {
      hasSelection: () => false,
      getSelection: () => '',
      clearSelection: vi.fn(),
      focus: vi.fn(),
      paste: vi.fn()
    };
    const handler = createTerminalKeyboardHandler(
      terminal,
      {
        clipboard: {
          readText: vi.fn(async () => {
            throw new Error('clipboard denied');
          }),
          writeText: vi.fn()
        },
        sendInput,
        isMac: false
      }
    );

    expect(handler(event)).toBe(false);
    await flushClipboardPromise();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('pastes from the browser paste event so focused xterm input still pastes once', () => {
    const target = new FakeEventTarget();
    const terminal = {
      paste: vi.fn(),
      focus: vi.fn()
    };
    const event = pasteEvent('pasted text');

    installTerminalClipboardPasteHandler(terminal, target as never);
    target.fire('paste', event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith('pasted text');
    expect(terminal.focus).toHaveBeenCalledOnce();
  });
});

describe('terminal focus recovery', () => {
  it('refocuses xterm after copy and paste actions without stealing context-menu focus', () => {
    const container = new FakeEventTarget();
    const document = new FakeEventTarget();
    const focus = vi.fn();
    const timers: Array<() => void> = [];

    installTerminalFocusRecovery(
      {
        focus
      },
      {
        container: container as never,
        document: document as never,
        setTimeout: (callback) => {
          timers.push(callback);
          return timers.length;
        }
      }
    );

    container.fire('contextmenu');
    document.fire('copy');
    document.fire('paste');
    for (const timer of timers) {
      timer();
    }

    expect(focus).toHaveBeenCalledTimes(2);
  });
});

describe('terminal status classes', () => {
  it('maps each structured connection state to its status class', () => {
    expect(resolveTerminalStatusClass('connected')).toBe('connected');
    expect(resolveTerminalStatusClass('disconnected')).toBe('disconnected');
    expect(resolveTerminalStatusClass('connecting')).toBe('connecting');
  });

  it('never derives the class from display text, so localized copy cannot break it', () => {
    // These are texts, not states: an unknown value falls back to connecting instead of
    // being substring-matched against English words.
    expect(resolveTerminalStatusClass('Disconnected after 30 minute(s) of inactivity.')).toBe('connecting');
    expect(resolveTerminalStatusClass('已断开连接')).toBe('connecting');
    expect(resolveTerminalStatusClass(undefined)).toBe('connecting');
  });
});

describe('platform-aware copy/paste', () => {
  function macTerminal(hasSelection: boolean) {
    return {
      hasSelection: () => hasSelection,
      getSelection: () => 'selected text',
      clearSelection: vi.fn(),
      focus: vi.fn(),
      paste: vi.fn()
    };
  }

  it('copies on Cmd+C and leaves Ctrl+C as the interrupt on macOS', async () => {
    const clipboard = { readText: vi.fn(), writeText: vi.fn(async () => undefined) };
    const sendInput = vi.fn();
    const handler = createTerminalKeyboardHandler(macTerminal(true), {
      clipboard,
      sendInput,
      isMac: true
    });

    const copy = keyEvent('c', { ctrlKey: false, metaKey: true });
    expect(handler(copy)).toBe(false);
    await Promise.resolve();
    expect(copy.preventDefault).toHaveBeenCalledOnce();
    expect(clipboard.writeText).toHaveBeenCalledWith('selected text');

    // Control belongs to the shell on macOS: xterm's own mapping turns it into ETX.
    const interrupt = keyEvent('c');
    expect(handler(interrupt)).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  it('consumes Cmd+C with nothing selected without interrupting the shell', () => {
    const clipboard = { readText: vi.fn(), writeText: vi.fn() };
    const sendInput = vi.fn();
    const handler = createTerminalKeyboardHandler(macTerminal(false), {
      clipboard,
      sendInput,
      isMac: true
    });

    const event = keyEvent('c', { ctrlKey: false, metaKey: true });
    expect(handler(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('leaves Cmd+V to the native paste event on macOS', () => {
    const clipboard = { readText: vi.fn(), writeText: vi.fn() };
    const terminal = macTerminal(false);
    const handler = createTerminalKeyboardHandler(terminal, {
      clipboard,
      sendInput: vi.fn(),
      isMac: true
    });

    const event = keyEvent('v', { ctrlKey: false, metaKey: true });
    // Returning true lets the browser dispatch `paste` on the xterm textarea, which
    // `installTerminalClipboardPasteHandler` consumes — no clipboard-read permission needed.
    expect(handler(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('ignores the platform modifier it does not own', () => {
    const clipboard = { readText: vi.fn(), writeText: vi.fn() };
    const sendInput = vi.fn();
    const control = createTerminalKeyboardHandler(macTerminal(true), {
      clipboard,
      sendInput,
      isMac: false
    });
    // Cmd+C is not the copy gesture on Windows/Linux.
    expect(control(keyEvent('c', { ctrlKey: false, metaKey: true }))).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();

    const mac = createTerminalKeyboardHandler(macTerminal(true), {
      clipboard,
      sendInput,
      isMac: true
    });
    // and Ctrl+V is not the paste gesture on macOS.
    expect(mac(keyEvent('v'))).toBe(true);
    expect(clipboard.readText).not.toHaveBeenCalled();
  });
});

describe('platform detection', () => {
  it('recognises macOS from the platform field, user agent and userAgentData', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false);
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false);
    expect(isMacPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true);
    expect(isMacPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false);
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' } })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' } })).toBe(false);
    expect(isMacPlatform({})).toBe(false);
  });
});
