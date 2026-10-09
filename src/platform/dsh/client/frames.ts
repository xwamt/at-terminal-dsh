/**
 * The terminal wire protocol, as a pure frame handler.
 *
 * One function turns a raw WebSocket frame into calls on an injected `deps`
 * surface — no socket, no state, no DOM — so every branch of the protocol the
 * Host implements (`dsh/channel.js` → `handleTerminalMessage`) is unit-tested
 * here rather than observed once through a browser.
 *
 * Frame contract (mirrors the Host):
 *
 * | in (Host → client)                        | effect                              |
 * |-------------------------------------------|-------------------------------------|
 * | `hello`                                   | `requestOpen()` — the socket is handshaked, ask for the PTY |
 * | `terminal.opened`                         | `onOpened()` — connected; report size |
 * | `terminal.output {data: base64}`          | `onOutput(bytes)`                   |
 * | `terminal.status {state, text}`           | `onState({kind, text})`             |
 * | `terminal.error {code, message, fingerprint?}` | `onError(failure)`             |
 * | `terminal.closed {reason}`                | disconnected + `onClosed(reason)`   |
 * | `error {message}`                         | `onError({code:'frame-error'})`     |
 * | `bye`                                     | disconnected                        |
 *
 * Unknown frames are ignored, not guessed at.
 */

import { asFailure, decodeBase64Frame, text } from './models';

export interface TerminalSessionState {
  kind: 'idle' | 'connecting' | 'connected' | 'disconnected';
  text: string;
}

export interface TerminalFrameDeps {
  /** The socket finished its handshake; open the PTY with the current size/server. */
  requestOpen(): void;
  /** The PTY is open. Carries the Host's terminal id, which scopes this tab's SFTP reads. */
  onOpened(terminalId: string): void;
  onState(state: TerminalSessionState): void;
  /** One decoded chunk of remote output, as bytes. */
  onOutput(bytes: Uint8Array): void;
  /**
   * `host`/`port` name the host a host-key refusal was actually about, and are absent
   * otherwise.
   *
   * With a jump host these are the **bastion**, not the server the user picked: the jump
   * host's key is verified first, so it is the one refused first. The body needs them to
   * record an accepted fingerprint against the right address — sending only the server id
   * is what left the bastion permanently untrusted while the store looked updated.
   *
   * Absent rather than empty when the frame carries none, because the trust button branches
   * on the pair and an empty host is not a host.
   */
  onError(failure: {
    code: string;
    message: string;
    fingerprint: string;
    host?: string;
    port?: number;
  }): void;
  onClosed(reason: string): void;
}

export interface TerminalFrameHandler {
  handle(raw: unknown): void;
}

export function createTerminalFrameHandler(deps: TerminalFrameDeps): TerminalFrameHandler {
  return {
    handle(raw: unknown): void {
      let message: { type?: unknown; [key: string]: unknown };
      try {
        message = JSON.parse(String(raw)) as { type?: unknown };
      } catch {
        return;
      }
      if (message === null || typeof message !== 'object') return;
      const type = message.type;

      if (type === 'hello') {
        deps.requestOpen();
        return;
      }
      if (type === 'terminal.opened') {
        // The Host's id for this session. Absent on an older Host build, which yields ''
        // and leaves the file tree unscoped — the single-terminal behaviour, degraded but
        // not broken, rather than a hard failure against a mismatched pair.
        deps.onOpened(text(message.terminalId));
        return;
      }
      if (type === 'terminal.output') {
        if (typeof message.data !== 'string' || message.data === '') return;
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64Frame(message.data);
        } catch (error) {
          const failure = asFailure(error);
          deps.onError({ code: failure.code, message: failure.message, fingerprint: '' });
          return;
        }
        if (bytes.length === 0) return;
        deps.onOutput(bytes);
        return;
      }
      if (type === 'terminal.status') {
        const state = typeof message.state === 'string' ? message.state : 'disconnected';
        deps.onState({
          kind:
            state === 'connected' || state === 'connecting' || state === 'disconnected'
              ? state
              : 'disconnected',
          text: text(message.text)
        });
        return;
      }
      if (type === 'terminal.error') {
        // `host` and `port` are carried **independently**. A frame can name a host and a
        // port that did not survive the wire as a number (`"22"`), and dropping the host
        // along with it would send the trust request back to the server instead of the host
        // that actually refused — the exact mistake that made a jump host permanently
        // untrusted. Each is admitted only in its own right, and an absent one stays absent
        // rather than becoming `''`, which the trust button would read as a real host.
        const host = typeof message.host === 'string' && message.host !== '' ? message.host : undefined;
        const port = typeof message.port === 'number' ? message.port : undefined;
        deps.onError({
          code: text(message.code) || 'terminal-error',
          message: text(message.message),
          fingerprint: text(message.fingerprint),
          ...(host === undefined ? {} : { host }),
          ...(port === undefined ? {} : { port })
        });
        return;
      }
      if (type === 'terminal.closed') {
        deps.onState({ kind: 'disconnected', text: '' });
        deps.onClosed(text(message.reason));
        return;
      }
      if (type === 'error') {
        deps.onError({ code: 'frame-error', message: text(message.message), fingerprint: '' });
        return;
      }
      if (type === 'bye') {
        deps.onState({ kind: 'disconnected', text: '' });
      }
    }
  };
}