import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { attachKeyboardInteractive } from '../ssh/KeyboardInteractive';
import { getSsh2 } from '../ssh/ssh2Loader';
import { wrapCommand } from './remoteCommandShell';
import {
  buildSshConnectionHandle,
  type HostKeyVerifier,
  type SshConnectionHandle
} from '../ssh/SshConnectionConfig';

/** One decoded chunk of remote output, tagged with the stream it came from. */
export interface RemoteCommandOutputChunk {
  channel: 'stdout' | 'stderr';
  text: string;
}

export interface RemoteCommandRequest {
  command: string;
  cwd?: string;
  /**
   * Deadline in milliseconds. `0` means **no deadline**: the caller owns the lifetime.
   *
   * Only the background path sets it, because a background command's lifetime is the job's
   * and the job is what stops it. `undefined` keeps the documented default, so nothing that
   * existed before this field changed meaning.
   */
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /**
   * Called as output arrives, in addition to the buffered result.
   *
   * A background job needs this: its reader (`job_output`) reads a ring that must fill
   * while the command runs, and a command that only returns at the end would make the
   * feature useless for anything long. Text is decoded with a streaming decoder so a
   * multi-byte character split across two TCP segments is not mangled — the buffered
   * result already decodes once at the end and cannot suffer this.
   */
  onOutput?: (chunk: RemoteCommandOutputChunk) => void;
}

export interface RemoteCommandResult {
  serverId: string;
  serverLabel: string;
  host: string;
  command: string;
  cwd?: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const MAX_OUTPUT_BYTES = 256_000;

/**
 * How long a pooled connection may sit unused before it is closed. Long enough to cover
 * the pauses in a conversation with an agent, short enough that an abandoned chat does
 * not hold a server-side session all day.
 */
const IDLE_CONNECTION_TTL_MS = 5 * 60_000;

class PooledConnection {
  /** Resolves once the connection is authenticated; rejects if it never got there. */
  readonly ready: Promise<Client>;
  client: Client | undefined;
  handle: SshConnectionHandle | undefined;
  /** Commands currently holding a channel on this connection. */
  inFlight = 0;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed = false;

  constructor(open: (connection: PooledConnection) => Promise<Client>) {
    this.ready = open(this);
  }
}

interface ConnectionLease {
  client: Client;
  release(): void;
}

/**
 * Runs agent commands over SSH, reusing one connection per server.
 *
 * A fresh TCP + KEX + auth round trip per command costs a few hundred milliseconds each
 * (more with a jump host, which needs a second connection), which an agent firing a
 * dozen commands pays over and over. Connections are therefore keyed by `serverId` and
 * kept until they go idle, drop, or the extension shuts down.
 *
 * Concurrent commands on one server share the connection and open a channel each, which
 * is what SSH multiplexing is for; queueing them behind a single channel would serialize
 * an agent that legitimately fans out. A server whose `MaxSessions` is exhausted fails
 * that one `exec` rather than the whole connection.
 *
 * Reusing the `Client` behind an open terminal session would save one more connection,
 * but it would put the agent's commands at the mercy of the user closing that panel, so
 * the agent keeps its own.
 */
export class RemoteCommandExecutor {
  private readonly pool = new Map<string, PooledConnection>();
  private disposed = false;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly hostKeyVerifier: HostKeyVerifier
  ) {}

  async execute(server: ServerConfig, request: RemoteCommandRequest): Promise<RemoteCommandResult> {
    const command = request.command.trim();
    if (!command) {
      throw new Error('Remote command cannot be empty.');
    }

    // `0` is the one value the clamp must not silently turn back into the default: it is
    // how the background path says "no deadline", and a default applied here would kill a
    // legitimate long-running job at 30 seconds.
    const timeoutMs =
      request.timeoutMs === 0
        ? undefined
        : clampPositiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clampPositiveInteger(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();
    const execCommand = wrapCommand(command, request.cwd);
    let stream: ClientChannel | undefined;
    let settled = false;
    let timedOut = false;

    return new Promise<RemoteCommandResult>((resolve, reject) => {
      const stdout = new OutputBuffer(maxOutputBytes);
      const stderr = new OutputBuffer(maxOutputBytes);
      // Only allocated when someone is listening: `StringDecoder` carries state, and a
      // decoder that is never read is just an object to keep alive.
      const decodeOut = request.onOutput ? new StringDecoder('utf8') : undefined;
      const decodeErr = request.onOutput ? new StringDecoder('utf8') : undefined;
      let lease: ConnectionLease | undefined;
      let abortListener: (() => void) | undefined;
      // Armed before acquisition so the caller's timeout still covers a connection that
      // never comes up, not just a command that never returns.
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              stream?.close();
              finish(null);
            }, timeoutMs);

      const onConnectionLost = (error?: Error): void => {
        rejectOnce(error ?? new Error('SSH connection closed before the command finished.'));
      };
      const detach = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (abortListener && request.signal) {
          request.signal.removeEventListener('abort', abortListener);
        }
        if (!lease) {
          return;
        }
        lease.client.off('error', onConnectionLost);
        lease.client.off('close', onConnectionLost);
        lease.release();
      };

      if (request.signal) {
        if (request.signal.aborted) {
          timedOut = false;
          rejectOnce(new Error('Remote command was aborted.'));
          return;
        }
        abortListener = () => {
          stream?.close();
          rejectOnce(new Error('Remote command was aborted.'));
        };
        request.signal.addEventListener('abort', abortListener, { once: true });
      }

      function finish(exitCode: number | null, signal?: string): void {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        resolve({
          serverId: server.id,
          serverLabel: server.label,
          host: server.host,
          command,
          cwd: request.cwd,
          exitCode,
          signal,
          stdout: stdout.text(),
          // A timeout appends its notice instead of replacing stderr: whatever the
          // command managed to print before it overran is usually the diagnosis.
          // `timedOut` is only ever set by the timer, which only exists when
          // `timeoutMs` does, so the fallback is unreachable rather than a real default.
          stderr: timedOut ? appendTimeoutNotice(stderr.text(), timeoutMs ?? 0) : stderr.text(),
          durationMs: Date.now() - started,
          timedOut,
          truncated: stdout.truncated || stderr.truncated
        });
      }

      function rejectOnce(error: unknown): void {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        reject(error);
      }

      void this.acquire(server).then((acquired) => {
        if (settled) {
          // Timed out while connecting; hand the connection straight back.
          acquired.release();
          return;
        }
        lease = acquired;
        acquired.client.once('error', onConnectionLost);
        acquired.client.once('close', onConnectionLost);
        acquired.client.exec(execCommand, (error, execStream) => {
          if (error) {
            rejectOnce(error);
            return;
          }

          stream = execStream;
          execStream.on('data', (data: Buffer) => {
            stdout.append(data);
            const text = decodeOut?.write(data);
            if (text) request.onOutput?.({ channel: 'stdout', text });
          });
          execStream.stderr.on('data', (data: Buffer) => {
            stderr.append(data);
            const text = decodeErr?.write(data);
            if (text) request.onOutput?.({ channel: 'stderr', text });
          });
          execStream.once('close', (code: number | null, signalName?: string) => {
            // Whatever the streaming decoder still holds is the tail of the last chunk —
            // a partial character cannot be, since the stream is done, but a whole
            // character can still be buffered from an incomplete sequence.
            const restOut = decodeOut?.end();
            if (restOut) request.onOutput?.({ channel: 'stdout', text: restOut });
            const restErr = decodeErr?.end();
            if (restErr) request.onOutput?.({ channel: 'stderr', text: restErr });
            finish(code, signalName);
          });
        });
      }, rejectOnce);
    });
  }

  /** Closes every pooled connection. Must run on extension deactivate. */
  dispose(): void {
    this.disposed = true;
    for (const [serverId, connection] of [...this.pool]) {
      this.evict(serverId, connection);
    }
    this.pool.clear();
  }

  private async acquire(server: ServerConfig): Promise<ConnectionLease> {
    if (this.disposed) {
      throw new Error('The remote command executor has been disposed.');
    }

    let connection = this.pool.get(server.id);
    if (!connection || connection.closed) {
      connection = this.open(server);
      this.pool.set(server.id, connection);
    }

    connection.inFlight += 1;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }

    const held = connection;
    try {
      return {
        client: await held.ready,
        release: () => this.release(server.id, held)
      };
    } catch (error) {
      this.release(server.id, held);
      throw error;
    }
  }

  private open(server: ServerConfig): PooledConnection {
    const connection = new PooledConnection(async (self) => {
      // Pooling reuses an already-verified socket; every connection it opens still goes
      // through buildSshConnectionHandle, so host key verification is never skipped.
      const handle = await buildSshConnectionHandle(server, this.configManager, this.hostKeyVerifier);
      self.handle = handle;
      const client = new (await getSsh2()).Client();
      // Each in-flight command attaches its own error/close listeners, so the default
      // ceiling of 10 would warn once a handful of channels run at once.
      client.setMaxListeners(64);
      self.client = client;
      // A dropped connection must leave the pool, or the next command is handed a dead
      // client and fails for a reason that has nothing to do with the command.
      const drop = (): void => this.evict(server.id, self);
      client.on('error', drop);
      client.on('close', drop);
      client.on('end', drop);
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        attachKeyboardInteractive(client, undefined, reject);
        client.connect(handle.config);
      });
      return client;
    });
    connection.ready.catch(() => this.evict(server.id, connection));

    return connection;
  }

  private release(serverId: string, connection: PooledConnection): void {
    connection.inFlight = Math.max(0, connection.inFlight - 1);
    if (connection.inFlight > 0 || connection.closed || connection.idleTimer) {
      return;
    }
    connection.idleTimer = setTimeout(() => this.evict(serverId, connection), IDLE_CONNECTION_TTL_MS);
    connection.idleTimer.unref?.();
  }

  private evict(serverId: string, connection: PooledConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
    if (this.pool.get(serverId) === connection) {
      this.pool.delete(serverId);
    }
    connection.client?.end();
    connection.handle?.dispose();
  }
}

function appendTimeoutNotice(capturedStderr: string, timeoutMs: number): string {
  const notice = `Command timed out after ${timeoutMs}ms.`;
  if (!capturedStderr) {
    return notice;
  }
  return capturedStderr.endsWith('\n') ? `${capturedStderr}${notice}` : `${capturedStderr}\n${notice}`;
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(data: Buffer): void {
    if (this.size >= this.maxBytes) {
      this.truncated = true;
      return;
    }

    const remaining = this.maxBytes - this.size;
    if (data.length > remaining) {
      this.chunks.push(data.subarray(0, remaining));
      this.size = this.maxBytes;
      this.truncated = true;
      return;
    }

    this.chunks.push(data);
    this.size += data.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
