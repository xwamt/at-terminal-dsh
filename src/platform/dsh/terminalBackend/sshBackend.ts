/**
 * The `ssh` PTY backend: a remote shell that survives across tool calls.
 *
 * dsh already has a terminal *registry* (`ctx.terminals`) and a set of tools
 * (`terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` /
 * `terminal_close`). What it does not have is a backend that runs those sessions on a
 * **remote** host — the shipped one spawns a local pty through `ctx.subprocess`. So this
 * file implements the backend half of the published contract and nothing else:
 *
 *   backend  = { type, spawn(spec) -> session }
 *   spec     = { sessionId, owner, type, name?, cwd?, signal }
 *   session  = { motd, startSend, read, signal, close, status }
 *   send     = { viewport, waitReason, sessionStatus, truncated }
 *   read     = { text, totalLines, lineBegin, lineEnd, truncated }
 *   status   = { kind: 'running' } | { kind: 'exited', exitCode, signal }
 *
 * Verified against the installed packages (`@deepseek-ai/dsh-terminal` 0.2.1-rc.2 and
 * `@deepseek-ai/dsh-terminal-bash` 0.2.1-rc.2, read out of `app.asar`), not against
 * documentation — none of this is published on npm.
 *
 * ## Two places where SSH is *not* a local pty, stated rather than papered over
 *
 * 1. **Readiness.** The local backend inspects its pty's foreground process:
 *    `stdin_read` there means "the foreground process is the shell, blocked on stdin". An
 *    SSH session has no such probe — `ssh2` gives a byte stream and nothing else. So the
 *    evidence here is the **prompt text at the tail** of the output after a quiet period.
 *    A prompt is real evidence the shell is waiting; it is *not* the same evidence the
 *    local backend has, and the wait reason says `stdin_read` only when that prompt was
 *    actually seen. Otherwise the session settles as `inferred_idle`, which is exactly the
 *    weaker claim it sounds like.
 * 2. **Signals.** `ssh2` has no side channel for `kill -SIG`. Claiming `delivered: true`
 *    with an invented `targetPgid` would be fabricated evidence, and the tool's output
 *    schema (`delivered: const true`, `targetPgid: integer`) leaves no honest way to say
 *    "no". So `signal()` **throws**, and the message names the two real options: write
 *    `\u0003` (which is what a terminal sends for Ctrl+C) or close the session.
 *
 * ## Where the server comes from
 *
 * `terminal_open` takes `{ type, name?, cwd? }` — there is **no** `serverId` parameter, so
 * `name` is the selector: a server id or label. With no name, the caller decides (see
 * `terminalEntry.ts`, which applies the same single-vs-many rule the tools use). Note that
 * the registry also stores `name` as the session's owner-local display name, so an SSH
 * session's name doubles as its target — which is honest, because for this backend they
 * genuinely are the same choice.
 */

/** What the backend needs from the environment; everything testable is injected. */
export interface SshBackendDeps {
  /** Backend type as the model will name it in `terminal_open`. */
  type?: string;
  /** Remote geometry requested at connect time. */
  rows?: number;
  cols?: number;
  /** Quiet period after which a send is considered settled. */
  idleSilenceMs?: number;
  /** Hard cap on one send. */
  sendTimeoutMs?: number;
  /** Cap on one `read()` page, in bytes. */
  maxReadBytes?: number;
  /** Scrollback retention, in lines. */
  scrollbackLines?: number;
  /** Connect to one server and hand back a byte-level channel. */
  open(serverId: string, handlers: SshOutputHandlers): Promise<SshConnection>;
}

/** Output, exit and failure, as the connection reports them. */
export interface SshOutputHandlers {
  output(text: string): void;
  exit(info: { exitCode: number | null; signal: string | null }): void;
}

export interface SshConnection {
  write(data: string): void;
  close(): void;
}

export interface TerminalSessionStatus {
  kind: 'running' | 'exited';
  exitCode?: number | null;
  signal?: string | null;
}

/** Why a send settled. Deliberately the same four names the registry's tools render. */
export type TerminalWaitReason = 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit';

export interface TerminalSendOutcome {
  viewport: string;
  waitReason: TerminalWaitReason;
  sessionStatus: TerminalSessionStatus;
  truncated: boolean;
}

export interface TerminalSendOperation {
  readonly done: Promise<TerminalSendOutcome>;
  readonly settled: boolean;
  cancel(): void;
}

export interface TerminalSpawnSpec {
  sessionId: string;
  type: string;
  name?: string;
  cwd?: string;
  signal?: AbortSignal;
}

/** Strip ANSI so prompt detection reads text, not escape codes. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

/**
 * Does the tail look like a shell waiting for input?
 *
 * A prompt ends a line with one of `$ # % >` (optionally followed by a space). This is
 * text evidence and it is allowed to be wrong in both directions — which is why the
 * caller gets `stdin_read` only when it matched, and `inferred_idle` otherwise. Being
 * conservative here costs a weaker claim, never a false one.
 */
const PROMPT_TAIL = /(?:^|\n)[^\n]{0,160}[#$%>]\s*$/;

export function looksLikePrompt(tail: string): boolean {
  return PROMPT_TAIL.test(stripAnsi(tail));
}

/**
 * One remote shell, presented as the session the registry expects.
 *
 * Everything here is synchronous bookkeeping around an asynchronous stream, so the class
 * holds no policy of its own beyond the readiness rules documented above.
 */
export class SshPtySession {
  motd = '';
  private readonly buffer = new BoundedScrollback(64 * 1024, 4000);
  private readonly decoder = new TextDecoder('utf-8');
  private statusValue: TerminalSessionStatus = { kind: 'running' };
  private closing = false;
  private closePromise?: Promise<void>;
  private active?: SshSendOperation;
  private lastOutputAt = Date.now();
  private exitWaiters: Array<() => void> = [];

  constructor(
    private readonly connection: SshConnection,
    private readonly config: Required<Pick<SshBackendDeps, 'idleSilenceMs' | 'sendTimeoutMs' | 'maxReadBytes'>> & {
      scrollbackLines: number;
    }
  ) {}

  /** Called by the backend for every chunk the connection reports. */
  feed(chunk: string): void {
    if (chunk.length === 0) return;
    this.lastOutputAt = Date.now();
    this.buffer.append(chunk);
    this.active?.append(chunk);
  }

  /** Called once when the remote side ends. */
  end(info: { exitCode: number | null; signal: string | null }): void {
    if (this.statusValue.kind === 'exited') return;
    this.statusValue = { kind: 'exited', exitCode: info.exitCode, signal: info.signal };
    if (this.active !== undefined) this.settle(this.active, 'session_exit');
    for (const resolve of this.exitWaiters.splice(0)) resolve();
  }

  /**
   * Wait for the shell to reach its first prompt, and keep that as the MOTD.
   *
   * Same shape as the local backend's startup: one send with no text. If it settles as
   * `timeout` or `session_exit` the spawn fails, because a session that never produced a
   * prompt is not one the caller can use.
   */
  async start(): Promise<void> {
    const outcome = await this.startSend({ text: '', submit: false }).done;
    if (outcome.waitReason === 'session_exit') {
      throw new Error('SSH session ended during startup.');
    }
    if (outcome.waitReason === 'timeout') {
      throw new Error(
        `SSH session did not reach a prompt within ${Math.round(this.config.sendTimeoutMs / 1000)}s.`
      );
    }
    this.motd = outcome.viewport;
  }

  startSend(request: { text: string; submit?: boolean; signal?: AbortSignal }): TerminalSendOperation {
    if (this.closing) throw new Error('Terminal session is closing.');
    if (this.statusValue.kind === 'exited') throw new Error('Terminal session has exited.');
    if (this.active !== undefined) throw new Error('Terminal session already has an active send.');
    if (request.signal?.aborted === true) throw new Error('Terminal send aborted before write.');

    const operation = new SshSendOperation((reason, fromCancel) => {
      void fromCancel;
      this.settle(operation, reason);
    });
    this.active = operation;
    this.lastOutputAt = Date.now();
    this.arm(operation);

    const input = `${request.text}${request.submit === true ? '\r' : ''}`;
    try {
      if (input.length > 0) this.connection.write(input);
    } catch (error) {
      this.fail(operation, error);
      return operation;
    }
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', () => operation.cancel(), { once: true });
    }
    return operation;
  }

  read(request: { offset?: number; count?: number } = {}): {
    text: string;
    totalLines: number;
    lineBegin: number;
    lineEnd: number;
    truncated: boolean;
  } {
    const snapshot = this.buffer.snapshot();
    const lines = snapshot.text.length === 0 ? [] : snapshot.text.split('\n');
    const totalLines = lines.length;
    const offset = request.offset ?? 0;
    const count = request.count ?? 500;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Terminal read offset must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error('Terminal read count must be a positive safe integer.');
    }
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated };
    }
    // Offset is newest-relative, exactly as the local backend defines it: 0 is the last page.
    const end = totalLines - offset;
    const start = Math.max(0, end - count);
    const text = tailBytes(lines.slice(start, end).join('\n'), this.config.maxReadBytes);
    const returnedLines = text.text.length === 0 ? 0 : text.text.split('\n').length;
    return {
      text: text.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || text.truncated
    };
  }

  /**
   * Signals are refused, on purpose — see the header.
   *
   * `ssh2` has no pty-signal channel, and the tool's output schema demands
   * `delivered: true` with an integer `targetPgid`. There is no honest value for either,
   * so this throws with the two things that do work.
   */
  signal(name: string): never {
    throw new Error(
      `An SSH terminal cannot deliver ${name}: the remote pty has no signal channel. ` +
        'Send Ctrl+C through terminal_send ("\\u0003") or close the session with terminal_close.'
    );
  }

  status(): TerminalSessionStatus {
    return this.statusValue;
  }

  close(reason: string): Promise<void> {
    void reason;
    this.closing = true;
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = (async () => {
      try {
        this.connection.close();
      } finally {
        // The connection reports the exit; if it does not (a channel that dies without
        // an `exit` event), the session must still settle or `terminal_close` hangs.
        this.end({ exitCode: null, signal: null });
        this.decoder.decode();
      }
    })();
    return this.closePromise;
  }

  /** Resolve when the remote side ends — used by the backend to fail a spawn cleanly. */
  whenExited(): Promise<void> {
    if (this.statusValue.kind === 'exited') return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  private arm(operation: SshSendOperation): void {
    const deadline = Date.now() + this.config.sendTimeoutMs;
    // Polling, not a one-shot timer: the settle condition is "quiet for N ms", which has to
    // be re-evaluated as output arrives. The local backend polls for the same reason.
    const tick = (): void => {
      if (this.active !== operation || operation.settled) return;
      if (this.statusValue.kind === 'exited') {
        this.settle(operation, 'session_exit');
        return;
      }
      const quietFor = Date.now() - this.lastOutputAt;
      if (quietFor >= this.config.idleSilenceMs) {
        this.settle(operation, looksLikePrompt(this.buffer.tail(4096)) ? 'stdin_read' : 'inferred_idle');
        return;
      }
      if (Date.now() >= deadline) {
        this.settle(operation, 'timeout');
        return;
      }
      setTimeout(tick, Math.min(50, this.config.idleSilenceMs)).unref?.();
    };
    setTimeout(tick, Math.min(50, this.config.idleSilenceMs)).unref?.();
  }

  private settle(operation: SshSendOperation, reason: TerminalWaitReason): void {
    if (this.active !== operation) return;
    this.active = undefined;
    const view = operation.consume();
    operation.resolve({
      viewport: view.text,
      waitReason: reason,
      sessionStatus: this.statusValue,
      truncated: view.truncated
    });
  }

  private fail(operation: SshSendOperation, error: unknown): void {
    if (this.active !== operation) return;
    this.active = undefined;
    operation.reject(error);
  }
}

/** A promise plus its two settlers —  is newer than this lib target. */
function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The rejection is observed by the caller's `done`; this keeps a cancelled send from
  // surfacing as an unhandled rejection when nobody is awaiting it any more.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** One send: what it collected, whether it settled, and how to cancel it. */
class SshSendOperation implements TerminalSendOperation {
  private readonly buffer = new BoundedScrollback(48 * 1024, 2000);
  private readonly deferred = createDeferred<TerminalSendOutcome>();
  private finished = false;
  private cancelled = false;

  constructor(private readonly onCancel: (reason: TerminalWaitReason, fromCancel: boolean) => void) {}

  get done(): Promise<TerminalSendOutcome> {
    return this.deferred.promise;
  }

  get settled(): boolean {
    return this.finished;
  }

  append(text: string): void {
    if (!this.finished) this.buffer.append(text);
  }

  consume(): { text: string; truncated: boolean } {
    const snapshot = this.buffer.snapshot();
    return { text: snapshot.text, truncated: snapshot.truncated };
  }

  resolve(outcome: TerminalSendOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.deferred.resolve(outcome);
  }

  reject(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.deferred.reject(error);
  }

  cancel(): void {
    if (this.finished || this.cancelled) return;
    this.cancelled = true;
    // Cancellation is not a wait reason of its own: the send stops waiting and reports
    // what it has. `inferred_idle` would claim the shell went quiet; `timeout` would claim
    // the deadline passed. Neither is true, so the caller's own abort surfaces instead.
    this.onCancel('inferred_idle', true);
  }
}

/** Last-N-lines scrollback with a byte cap, dropping from the head. */
class BoundedScrollback {
  private text = '';
  private dropped = false;

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number
  ) {}

  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.maxBytes) {
      this.text = this.text.slice(this.text.length - this.maxBytes);
      this.dropped = true;
    }
    const lines = this.text.split('\n');
    if (lines.length > this.maxLines) {
      this.text = lines.slice(lines.length - this.maxLines).join('\n');
      this.dropped = true;
    }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.text, truncated: this.dropped };
  }

  tail(bytes: number): string {
    return this.text.length <= bytes ? this.text : this.text.slice(this.text.length - bytes);
  }
}

/** Keep the tail of a page, so a truncated read still ends at the newest output. */
function tailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const buffer = Buffer.from(text, 'utf8');
  return { text: buffer.subarray(buffer.length - maxBytes).toString('utf8'), truncated: true };
}

/** The backend object the registry expects. */
export function createSshTerminalBackend(deps: SshBackendDeps): {
  type: string;
  spawn(spec: TerminalSpawnSpec): Promise<SshPtySession>;
} {
  const resolved = {
    idleSilenceMs: deps.idleSilenceMs ?? 350,
    sendTimeoutMs: deps.sendTimeoutMs ?? 30_000,
    maxReadBytes: deps.maxReadBytes ?? 64 * 1024,
    scrollbackLines: deps.scrollbackLines ?? 4000
  };
  if (resolved.idleSilenceMs <= 0 || resolved.sendTimeoutMs <= 0) {
    throw new Error('at-terminal: idleSilenceMs and sendTimeoutMs must be positive');
  }
  return {
    type: deps.type ?? 'ssh',
    async spawn(spec: TerminalSpawnSpec): Promise<SshPtySession> {
      spec.signal?.throwIfAborted();
      // `name` is the server selector for this backend — see the header. The registry
      // requires a non-empty name when one is given, and hands it through untouched.
      const serverId = spec.name;
      if (serverId === undefined) {
        throw new Error(
          'at-terminal: open an SSH terminal with name set to the server id or label; ' +
            'this backend has no default target.'
        );
      }
      let session: SshPtySession | undefined;
      const connection = await deps.open(serverId, {
        output: (text) => session?.feed(text),
        exit: (info) => session?.end(info)
      });
      spec.signal?.throwIfAborted();
      session = new SshPtySession(connection, resolved);
      try {
        await session.start();
        return session;
      } catch (error) {
        // A spawn that fails after connecting must release the connection: the registry
        // never publishes it, so nothing else would ever close it.
        await session.close('spawn failed').catch(() => undefined);
        throw error;
      }
    }
  };
}
