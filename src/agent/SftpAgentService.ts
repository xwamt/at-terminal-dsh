import type { ServerConfig } from '../config/schema';
import { formatFileSize } from '../sftp/FileSize';
import { isSftpConflictError } from '../sftp/SftpErrors';
import type { SftpEntry, SftpEntryType, SftpFileStat } from '../sftp/SftpTypes';
import type { TransferProgress } from '../sftp/TransferService';
import { dirname, joinRemotePath } from '../sftp/RemotePath';
import type { TerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import type { AgentAuditRecorder } from './AgentAuditLog';
import type { SftpWriteAuthorizer } from './SftpWriteAuthorizer';
import {
  implicitTarget,
  type ResolvedBy,
  type ServerCandidate,
  type ServerTargetIntent
} from './serverTarget';

export interface AgentSftpSession {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  stat(path: string): Promise<SftpFileStat>;
  readFile(path: string, maxBytes: number, offset?: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  /**
   * Metadata of a file on the Host's own disk, resolved to its real location.
   *
   * Separate from `stat` because the two answer about different machines: conflating them
   * would let a remote path be resolved against the local filesystem, or the reverse. The
   * `realPath` is what the upload is authorized against — a symlink's own name is not evidence
   * of what is in the file.
   */
  statLocalFile(localPath: string): Promise<{ size: number; isFile: boolean; realPath: string }>;
  /** Streams a local file to `remotePath`; the bytes never pass through this service. */
  uploadLocalFile(
    localPath: string,
    remotePath: string,
    options: { overwrite: boolean; progress?: TransferProgress }
  ): Promise<void>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  dispose(): void;
}

export interface SftpAgentServiceOptions {
  terminalContext: TerminalContextRegistry;
  /**
   * Builds a session for the given server. Terminal-bound and background targets share
   * this factory; production must construct it with `allowSudoFallback: false` so a
   * denied agent write stays denied.
   */
  createSession(target: { server: ServerConfig }): AgentSftpSession;
  authorizer: Pick<SftpWriteAuthorizer, 'requireWrite' | 'requireDelete' | 'requireUpload'>;
  /**
   * Looks a server up by id for background SFTP (no connected UI terminal). Servers
   * resolved this way must have `backgroundConnectionAllowed === true` or the call is
   * refused before any connection is made.
   */
  resolveBackgroundServer?(serverId: string): Promise<ServerConfig | undefined>;
  audit?: AgentAuditRecorder;
}

export interface SftpTargetInput {
  terminalId?: string;
  serverId?: string;
}

/** What a `writeFile` call reports back; `localPath` is present only for a streamed upload. */
export interface SftpWriteResult {
  terminalId?: string;
  serverId: string;
  path: string;
  bytesWritten: number;
  overwritten: boolean;
  localPath?: string;
}

interface SftpTarget {
  /** Present only when the target is a connected UI terminal. */
  terminalId?: string;
  server: ServerConfig;
  context?: TerminalContext;
  /** How this target was decided — recorded on the read results, see `serverTarget.ts`. */
  resolvedBy: ResolvedBy;
  /** Present only when the choice was ambiguous and therefore had to be stated. */
  candidates?: ServerCandidate[];
}

interface SessionLease {
  session: AgentSftpSession;
  /** Key for the cached `realpath('.')`; terminal and background sessions never collide. */
  rootKey: string;
  release(): void;
  /**
   * Drop the pooled session this lease came from, closing its SSH connection.
   *
   * The only cancellation ssh2's `fastPut` offers. It has no abort API and no per-chunk hook a
   * caller can stop from, so a transfer that has to be stopped is stopped by the connection
   * under it going away; the alternative is a "timed out" answer that keeps writing. The cost is
   * honest and bounded: any other operation sharing that pooled session fails with it, and the
   * next call reconnects.
   */
  abort?(): void;
}

interface TerminalSessionEntry {
  serverId: string;
  promise: Promise<AgentSftpSession>;
}

interface BackgroundSessionEntry {
  session: AgentSftpSession;
  ready: Promise<AgentSftpSession>;
  /** Operations currently using this session. */
  inFlight: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

interface WritableTarget {
  /** Server-resolved absolute path of the write target. */
  path: string;
  /** `realpath('.')` for this session, used as the write jail. */
  workspaceRoot: string;
}

const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 500;
const MAX_ENTRIES = 5_000;
const WRITE_TIMEOUT_MS = 60_000;

/**
 * Deadline for a streamed local upload.
 *
 * Five minutes, not the write budget. A text write is bounded by a string the model already
 * holds; an upload is bounded by the link, and 7 MB over a slow one legitimately takes minutes.
 *
 * Reaching it is destructive on the remote side and is handled as such: `fastPut` opens the
 * destination with `w`, so the file is already truncated by the time this deadline fires, and
 * the transfer cannot be cancelled except by closing the connection. `uploadLocalSource` does
 * exactly that and says so in the error — the deadline does not by itself make a cut-off
 * transfer safe, it only decides when to stop pretending the call is still going well.
 */
const UPLOAD_TIMEOUT_MS = 300_000;

/**
 * Largest local file an agent upload may carry.
 *
 * Not a protocol limit — SFTP streams, so the transfer itself does not care. It is a bound on
 * what one confirmation covers: a mistyped path can name a disk image or a database dump, and
 * the dialog the user just answered promised to move one artifact, not a gigabyte of whatever
 * happened to be at that path.
 */
export const MAX_LOCAL_UPLOAD_BYTES = 1024 * 1024 * 1024;

/**
 * Read-side deadline.
 *
 * The write paths always had one, because a write that never returns holds a confirmation
 * prompt and a half-written file. Reads had none: a stalled SFTP channel made `read_file`
 * return an empty-looking result, which the model reads as "the file is empty" rather than
 * "the connection is gone" — the difference between a wrong answer and a retryable failure.
 *
 * Shorter than the write budget on purpose: a write has a human in the loop (the authorizer
 * prompt), a read does not.
 */
const READ_TIMEOUT_MS = 30_000;

/**
 * How long an idle background session is kept before its SSH connection is closed.
 * Mirrors `RemoteCommandExecutor`: long enough for the pauses in an agent conversation,
 * short enough that an abandoned chat does not hold a server-side session all day.
 */
const BACKGROUND_IDLE_TTL_MS = 5 * 60_000;

export class SftpAgentService {
  /** One session per connected UI terminal; lives until the terminal closes. */
  private readonly terminalSessions = new Map<string, TerminalSessionEntry>();
  /** One session per background server, reaped after BACKGROUND_IDLE_TTL_MS idle. */
  private readonly backgroundSessions = new Map<string, BackgroundSessionEntry>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly options: SftpAgentServiceOptions) {}

  async listDirectory(input: SftpTargetInput & { path?: string; maxEntries?: number; offset?: number }) {
    return await this.withAudit('sftp_list_directory', input, async () => {
      const target = await this.resolveTarget(input, 'read');
      const lease = await this.leaseFor(target);
      try {
        const path = await this.resolvePath(lease, input.path);
        const entries = await withTimeout(
          lease.session.listDirectory(path),
          READ_TIMEOUT_MS,
          `Timed out listing remote directory ${path}.`
        );
        const maxEntries = clampMaxEntries(input.maxEntries);
        const offset = clampListOffset(input.offset);
        const page = entries.slice(offset, offset + maxEntries);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          // Said out loud, not implied: with several servers connected this call picked one,
          // and the caller has to be able to tell which — and on what grounds.
          resolvedBy: target.resolvedBy,
          ...(target.candidates === undefined ? {} : { candidates: target.candidates }),
          path,
          entries: page,
          truncated: offset + page.length < entries.length,
          offset,
          total: entries.length
        };
      } finally {
        lease.release();
      }
    });
  }

  async statPath(input: SftpTargetInput & { path: string }) {
    return await this.withAudit('sftp_stat_path', input, async () => {
      const target = await this.resolveTarget(input, 'read');
      const lease = await this.leaseFor(target);
      try {
        const path = await this.resolvePath(lease, input.path);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          resolvedBy: target.resolvedBy,
          ...(target.candidates === undefined ? {} : { candidates: target.candidates }),
          path,
          ...(await withTimeout(
            lease.session.stat(path),
            READ_TIMEOUT_MS,
            `Timed out reading metadata for ${path}.`
          ))
        };
      } finally {
        lease.release();
      }
    });
  }

  async readFile(input: SftpTargetInput & { path: string; maxBytes?: number; offset?: number }) {
    return await this.withAudit('sftp_read_file', input, async () => {
      const target = await this.resolveTarget(input, 'read');
      const lease = await this.leaseFor(target);
      try {
        const path = await this.resolvePath(lease, input.path);
        const stat = await withTimeout(
          lease.session.stat(path),
          READ_TIMEOUT_MS,
          `Timed out reading metadata for ${path}.`
        );
        const maxBytes = clampReadBytes(input.maxBytes);
        const start = resolveReadStart(input.offset, stat.size);
        const window = Math.min(Math.max(stat.size - start, 0), maxBytes);
        const buffer =
          window === 0
            ? Buffer.alloc(0)
            : (
                await withTimeout(
                  lease.session.readFile(path, window, start),
                  READ_TIMEOUT_MS,
                  `Timed out reading remote file ${path}.`
                )
              ).subarray(0, window);
        if (looksBinary(buffer)) {
          throw new Error('Remote file appears to be binary.');
        }
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          resolvedBy: target.resolvedBy,
          ...(target.candidates === undefined ? {} : { candidates: target.candidates }),
          path,
          content: buffer.toString('utf8'),
          truncated: start + buffer.length < stat.size,
          offset: start,
          size: stat.size,
          modifiedAt: stat.modifiedAt
        };
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Writes a remote file from one of two sources.
   *
   * `content` is the original shape and still the right one for text: the bytes are already in
   * the caller's hands. `localPath` exists because the alternative for a binary was to base64
   * it through the model's context — 7.3 MB became ~2.5M tokens, so the call could not happen
   * at all. With `localPath` the Host reads its own disk and streams the file, and the payload
   * never becomes a string.
   */
  async writeFile(
    input: SftpTargetInput & {
      path: string;
      content?: string;
      localPath?: string;
      overwrite?: boolean;
      onProgress?: (transferredBytes: number, totalBytes: number) => void;
    }
  ): Promise<SftpWriteResult> {
    return await this.withAudit('sftp_write_file', input, async () => {
      const source = resolveWriteSource(input);
      const target = await this.resolveTarget(input, 'write');
      const lease = await this.leaseFor(target);
      try {
        const writable = await this.resolveWritablePath(lease, input.path);
        if (source.kind === 'local') {
          return await this.uploadLocalSource(source.localPath, input, target, lease, writable);
        }
        const exists = await pathExists(lease.session, writable.path);
        if (exists && !input.overwrite) {
          throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
        }
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'write_file',
            path: writable.path,
            overwrite: Boolean(exists),
            workspaceRoot: writable.workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP write authorization for ${writable.path}.`
        );
        const content = Buffer.from(source.content, 'utf8');
        await withTimeout(
          lease.session.writeFile(writable.path, content),
          WRITE_TIMEOUT_MS,
          `Timed out writing remote file ${writable.path}.`
        );
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path: writable.path,
          bytesWritten: content.length,
          overwritten: exists
        };
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Streams a local file to the remote path.
   *
   * Same gate as a text write — overwrite refusal, human authorization, a deadline — plus the
   * things only an upload needs: the source is resolved and stat'ed first, so a missing,
   * non-file or symlinked-to-something-sensitive path is decided before anyone is asked to
   * approve it, and its size travels with the request so the dialog can state what is about to
   * move. Everything past the stat names the *resolved* path: the name the caller used is not
   * evidence of what is in the file.
   */
  private async uploadLocalSource(
    localPath: string,
    input: {
      overwrite?: boolean;
      onProgress?: (transferredBytes: number, totalBytes: number) => void;
    },
    target: SftpTarget,
    lease: SessionLease,
    writable: WritableTarget
  ) {
    const local = await statLocalSource(lease.session, localPath);
    const sourcePath = local.realPath;
    const exists = await pathExists(lease.session, writable.path);
    if (exists && !input.overwrite) {
      throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
    }
    await withTimeout(
      this.options.authorizer.requireUpload(target.server, {
        operation: 'upload_local_file',
        path: writable.path,
        overwrite: Boolean(exists),
        workspaceRoot: writable.workspaceRoot,
        localPath: sourcePath,
        localBytes: local.size
      }),
      WRITE_TIMEOUT_MS,
      `Timed out waiting for SFTP upload authorization for ${writable.path}.`
    );
    const progress = progressFor(input.onProgress);
    try {
      await withTimeout(
        lease.session.uploadLocalFile(
          sourcePath,
          writable.path,
          // `exists`, not `input.overwrite`: the flag that reaches the transfer has to be the
          // state the user was shown. Passing the caller's permission would tell `uploadFile`
          // "replacing is fine" for a path the dialog described as missing, and a file that
          // appeared while the dialog was open would be clobbered with no conflict raised.
          progress === undefined
            ? { overwrite: Boolean(exists) }
            : { overwrite: Boolean(exists), progress }
        ),
        UPLOAD_TIMEOUT_MS,
        `Timed out uploading ${sourcePath} to ${writable.path}.`
      );
    } catch (error) {
      // A file that appeared while the dialog was open must not be clobbered: the user was
      // shown "Overwrite: no", so the late arrival is a conflict, not a reason to proceed.
      if (isSftpConflictError(error)) {
        throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
      }
      if (isUploadTimeout(error)) {
        // Reporting the deadline is not stopping the transfer. `fastPut` has no cancel, and the
        // destination was already truncated by its `open('w')`, so closing the pooled connection
        // is the only way to end the writes — and the message has to say that the remote file
        // may be incomplete rather than implying a clean failure.
        lease.abort?.();
        throw new Error(
          `Timed out uploading ${sourcePath} to ${writable.path} after ${UPLOAD_TIMEOUT_MS / 1000} s; ` +
            'the transfer was aborted and the remote file may be incomplete. ' +
            'Check the remote file before relying on it, and retry with overwrite: true if it needs replacing.'
        );
      }
      throw error;
    }
    return {
      terminalId: target.terminalId,
      serverId: target.server.id,
      path: writable.path,
      bytesWritten: local.size,
      overwritten: exists,
      localPath: sourcePath
    };
  }

  async createFile(input: SftpTargetInput & { path: string; content?: string }) {
    return await this.withAudit('sftp_create_file', input, async () => {
      const target = await this.resolveTarget(input, 'write');
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        if (await pathExists(lease.session, path)) {
          throw new Error('Remote file already exists.');
        }
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'create_file',
            path,
            overwrite: false,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP create authorization for ${path}.`
        );
        if (input.content === undefined) {
          await withTimeout(
            lease.session.createFile(path),
            WRITE_TIMEOUT_MS,
            `Timed out creating remote file ${path}.`
          );
        } else {
          await withTimeout(
            lease.session.writeFile(path, Buffer.from(input.content, 'utf8')),
            WRITE_TIMEOUT_MS,
            `Timed out writing remote file ${path}.`
          );
        }
        return { terminalId: target.terminalId, serverId: target.server.id, path };
      } finally {
        lease.release();
      }
    });
  }

  async createDirectory(input: SftpTargetInput & { path: string }) {
    return await this.withAudit('sftp_create_directory', input, async () => {
      const target = await this.resolveTarget(input, 'write');
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'create_directory',
            path,
            overwrite: false,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP create directory authorization for ${path}.`
        );
        await withTimeout(
          lease.session.mkdir(path),
          WRITE_TIMEOUT_MS,
          `Timed out creating remote directory ${path}.`
        );
        return { terminalId: target.terminalId, serverId: target.server.id, path };
      } finally {
        lease.release();
      }
    });
  }

  async rename(input: SftpTargetInput & { path: string; newPath: string }) {
    return await this.withAudit('sftp_rename', input, async () => {
      const target = await this.resolveTarget(input, 'write');
      const lease = await this.leaseFor(target);
      try {
        const source = await this.resolveWritablePath(lease, input.path);
        const destination = await this.resolveWritablePath(lease, input.newPath);
        if (!(await pathExists(lease.session, source.path))) {
          throw new Error('Remote source path was not found.');
        }
        if (await pathExists(lease.session, destination.path)) {
          throw new Error('Remote destination already exists.');
        }
        // Both ends go through write authorization: moving a file out of an approved
        // directory is as much a write as creating one there.
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'rename',
            path: source.path,
            overwrite: false,
            workspaceRoot: source.workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP rename authorization for ${source.path}.`
        );
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'rename',
            path: destination.path,
            overwrite: false,
            workspaceRoot: destination.workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP rename authorization for ${destination.path}.`
        );
        await withTimeout(
          lease.session.rename(source.path, destination.path),
          WRITE_TIMEOUT_MS,
          `Timed out renaming remote path ${source.path}.`
        );
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path: source.path,
          newPath: destination.path
        };
      } finally {
        lease.release();
      }
    });
  }

  async deleteFile(input: SftpTargetInput & { path: string }) {
    return await this.withAudit('sftp_delete', input, async () => {
      const target = await this.resolveTarget(input, 'write');
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        const entryType = await remoteEntryType(lease.session, path);
        if (entryType === undefined) {
          throw new Error('Remote file was not found.');
        }
        if (entryType === 'directory') {
          // Refused on purpose (the implementation contract forbids making recursive
          // directory removal an Agent tool), but not a dead end: the command path already
          // has a policy engine, destructive-command confirmation and audit, so the message
          // names it instead of stopping at "no".
          throw new Error(
            'sftp_delete removes single files only. For a directory, use at_terminal_run_remote_command (it goes through the command policy and destructive warnings).'
          );
        }
        await withTimeout(
          this.options.authorizer.requireDelete(target.server, {
            operation: 'delete_file',
            path,
            overwrite: false,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP delete confirmation for ${path}.`
        );
        await withTimeout(
          lease.session.deleteFile(path),
          WRITE_TIMEOUT_MS,
          `Timed out deleting remote file ${path}.`
        );
        return { terminalId: target.terminalId, serverId: target.server.id, path, deleted: true };
      } finally {
        lease.release();
      }
    });
  }

  /** Drops the pooled session bound to a closed terminal. Wire to `onDidRemoveContext`. */
  disposeTerminal(terminalId: string): void {
    const entry = this.terminalSessions.get(terminalId);
    if (entry) {
      this.terminalSessions.delete(terminalId);
      void entry.promise.then(
        (session) => session.dispose(),
        () => undefined
      );
    }
    this.roots.delete(`terminal:${terminalId}`);
  }

  /** Drops every pooled session for a server, e.g. after the server is deleted or edited. */
  disposeServer(serverId: string): void {
    const background = this.backgroundSessions.get(serverId);
    if (background) {
      this.evictBackgroundSession(serverId, background);
    }
    for (const [terminalId, entry] of [...this.terminalSessions]) {
      if (entry.serverId === serverId) {
        this.disposeTerminal(terminalId);
      }
    }
    this.roots.delete(`server:${serverId}`);
  }

  dispose(): void {
    for (const [serverId, entry] of [...this.backgroundSessions]) {
      this.evictBackgroundSession(serverId, entry);
    }
    this.backgroundSessions.clear();
    for (const entry of this.terminalSessions.values()) {
      void entry.promise.then(
        (session) => session.dispose(),
        () => undefined
      );
    }
    this.terminalSessions.clear();
    this.roots.clear();
  }

  /**
   * Resolve the server and session a call acts on.
   *
   * `intent` is what makes the no-`serverId` case safe: a read with several servers connected
   * is allowed and says how it chose, a write throws instead of picking one. See
   * `serverTarget.ts` for why the difference is not a nicety — a write that lands on the wrong
   * host is indistinguishable from a successful one.
   */
  private async resolveTarget(input: SftpTargetInput, intent: ServerTargetIntent): Promise<SftpTarget> {
    if (!input.terminalId && !input.serverId) {
      const choice = implicitTarget(this.options.terminalContext, intent);
      if (choice.context) {
        return {
          terminalId: choice.context.terminalId,
          server: choice.context.server,
          context: choice.context,
          resolvedBy: choice.resolvedBy,
          ...(choice.candidates === undefined ? {} : { candidates: choice.candidates })
        };
      }
    }
    const context =
      this.options.terminalContext.getConnectedTerminalById(input.terminalId) ??
      this.options.terminalContext.getConnectedTerminalByServerId(input.serverId);
    if (context) {
      return { terminalId: context.terminalId, server: context.server, context, resolvedBy: 'explicit' };
    }
    if (input.serverId && this.options.resolveBackgroundServer) {
      const server = await this.options.resolveBackgroundServer(input.serverId);
      if (!server) {
        throw new Error(`SSH server "${input.serverId}" was not found.`);
      }
      if (server.backgroundConnectionAllowed !== true) {
        throw new Error(
          `SSH server "${server.id}" does not allow background connections. ` +
            'Ask the user to enable "Allow background connections" on the AT Terminal server edit form, ' +
            'or open a terminal tab for that server in the AT Terminal panel. ' +
            'A `terminal_*` session does not count: the check reads the panel\'s own terminal tabs.'
        );
      }
      return { server, resolvedBy: 'explicit' };
    }
    throw new Error(
      'No matching connected AT Terminal SSH session is available. Connect an AT Terminal session first.'
    );
  }

  private async leaseFor(target: SftpTarget): Promise<SessionLease> {
    if (target.context) {
      const terminalId = target.context.terminalId;
      const session = await this.ensureTerminalSession(target.context);
      return {
        session,
        rootKey: `terminal:${terminalId}`,
        release: () => undefined,
        // Dropping the pooled session disposes the SSH connection, which is what stops a
        // `fastPut` that has to be stopped. The terminal stays connected in the panel; the next
        // agent SFTP call on it opens a fresh session.
        abort: () => this.disposeTerminal(terminalId)
      };
    }
    return await this.leaseBackgroundSession(target.server);
  }

  private async ensureTerminalSession(context: TerminalContext): Promise<AgentSftpSession> {
    const existing = this.terminalSessions.get(context.terminalId);
    if (existing) {
      return await existing.promise;
    }
    const session = this.options.createSession({ server: context.server });
    const promise = Promise.resolve()
      .then(async () => {
        await session.connect();
        return session;
      })
      .catch((error) => {
        session.dispose();
        this.terminalSessions.delete(context.terminalId);
        throw error;
      });
    this.terminalSessions.set(context.terminalId, { serverId: context.server.id, promise });
    return await promise;
  }

  private async leaseBackgroundSession(server: ServerConfig): Promise<SessionLease> {
    let entry = this.backgroundSessions.get(server.id);
    if (!entry || entry.closed) {
      entry = this.openBackgroundSession(server);
      this.backgroundSessions.set(server.id, entry);
    }
    entry.inFlight += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const held = entry;
    try {
      const session = await held.ready;
      return {
        session,
        rootKey: `server:${server.id}`,
        release: () => this.releaseBackgroundSession(server.id, held),
        // Same reasoning as the terminal lease: evicting the pooled session disposes its
        // connection, which is the only way to stop a `fastPut` already in flight. The entry is
        // marked closed, so the release that follows cannot re-arm its idle timer.
        abort: () => this.evictBackgroundSession(server.id, held)
      };
    } catch (error) {
      this.releaseBackgroundSession(server.id, held);
      throw error;
    }
  }

  private openBackgroundSession(server: ServerConfig): BackgroundSessionEntry {
    const session = this.options.createSession({ server });
    const entry: BackgroundSessionEntry = {
      session,
      inFlight: 0,
      idleTimer: undefined,
      closed: false,
      ready: Promise.resolve().then(async () => {
        await session.connect();
        return session;
      })
    };
    // A session that never connected must leave the pool, or the next call is handed a
    // dead session and fails for a reason unrelated to the call itself.
    entry.ready.catch(() => this.evictBackgroundSession(server.id, entry));
    return entry;
  }

  private releaseBackgroundSession(serverId: string, entry: BackgroundSessionEntry): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.inFlight > 0 || entry.closed || entry.idleTimer) {
      return;
    }
    entry.idleTimer = setTimeout(() => this.evictBackgroundSession(serverId, entry), BACKGROUND_IDLE_TTL_MS);
    entry.idleTimer.unref?.();
  }

  private evictBackgroundSession(serverId: string, entry: BackgroundSessionEntry): void {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (this.backgroundSessions.get(serverId) === entry) {
      this.backgroundSessions.delete(serverId);
      this.roots.delete(`server:${serverId}`);
    }
    entry.session.dispose();
  }

  private async withAudit<
    T extends {
      serverId?: string;
      terminalId?: string;
      path?: string;
      truncated?: boolean;
      localPath?: string;
    }
  >(
    tool: string,
    input: SftpTargetInput & { path?: string; localPath?: string },
    fn: () => Promise<T>
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      const path = result.path ?? input.path;
      this.options.audit?.record({
        tool,
        serverId: result.serverId ?? input.serverId,
        terminalId: result.terminalId ?? input.terminalId,
        path,
        // An upload has two ends and `path` only names one. "Which file on the operator's
        // machine was put on that box" is a question this trail has to answer, or the row says
        // a file appeared and nothing about where it came from.
        ...(result.localPath === undefined
          ? {}
          : { command: `upload ${result.localPath} -> ${path ?? ''}` }),
        reasonCode: 'ok',
        durationMs: Date.now() - started,
        ...(result.truncated === undefined ? {} : { truncated: result.truncated })
      });
      return result;
    } catch (error) {
      this.options.audit?.record({
        tool,
        serverId: input.serverId,
        terminalId: input.terminalId,
        path: input.path,
        // A refused upload still names its source. "The agent tried to send `~/.ssh/id_rsa` to
        // that box and the user said no" is the row an incident review is looking for, and it
        // is the only place that attempt is recorded at all.
        ...(input.localPath === undefined
          ? {}
          : { command: `upload ${input.localPath} -> ${input.path ?? ''}` }),
        reasonCode: auditReasonForError(error),
        durationMs: Date.now() - started
      });
      throw error;
    }
  }

  private async resolvePath(lease: SessionLease, path: string | undefined): Promise<string> {
    const root = await this.rootFor(lease);
    if (!path || path === '.' || path === '~') {
      return root;
    }
    const anchored = expandHome(root, path);
    return anchored.startsWith('/')
      ? await lease.session.realpath(anchored)
      : await lease.session.realpath(joinRemotePath(root, anchored));
  }

  private async resolveWritablePath(lease: SessionLease, path: string): Promise<WritableTarget> {
    if (!path.trim()) {
      throw new Error('Remote path cannot be empty.');
    }
    const workspaceRoot = await this.rootFor(lease);
    const anchored = path.startsWith('/') ? path : expandHome(workspaceRoot, path);
    const candidate = anchored.startsWith('/') ? anchored : joinRemotePath(workspaceRoot, anchored);
    const normalized = candidate.replace(/\/+$/, '') || '/';
    if (normalized === '/') {
      throw new Error('Remote root path cannot be modified.');
    }
    const parent = await lease.session.realpath(dirname(normalized));
    const resolved = joinRemotePath(parent, basenameRemotePath(normalized));
    if (resolved === '/') {
      throw new Error('Remote root path cannot be modified.');
    }
    return { path: resolved, workspaceRoot };
  }

  private async rootFor(lease: SessionLease): Promise<string> {
    const existing = this.roots.get(lease.rootKey);
    if (existing) {
      return existing;
    }
    const root = await lease.session.realpath('.');
    this.roots.set(lease.rootKey, root);
    return root;
  }
}

/**
 * Expand a leading `~` to the session's home directory.
 *
 * The SFTP subsystem is not a shell, so nothing expands `~` on the server: `readdir('~')`
 * answers **"No such file"** for a directory that plainly exists. That answer is worse than a
 * refusal — a model that gets it retries with invented paths instead of asking, and the AT
 * Terminal panel tells it `~` is a thing (the tilde is what a person types).
 *
 * `realpath('.')` is the session's start directory, which is the login home for these
 * sessions and is already the value the write jail calls `workspaceRoot`. So `~`, `.` and no
 * path at all mean the same place here, deliberately.
 *
 * `~user` is **not** expanded: resolving another account's home needs `/etc/passwd`, which is
 * a second round trip answering a different question. It falls through unchanged and fails
 * the way it fails today.
 */
function expandHome(root: string, path: string): string {
  if (path === '~') return root;
  if (path.startsWith('~/')) return joinRemotePath(root, path.slice(2));
  return path;
}

async function pathExists(session: AgentSftpSession, path: string): Promise<boolean> {
  try {
    await session.stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

/** Type of the directory entry at `path`, read from its parent listing; undefined when absent. */
async function remoteEntryType(session: AgentSftpSession, path: string): Promise<SftpEntryType | undefined> {
  const entries = await session.listDirectory(dirname(path));
  const name = basenameRemotePath(path);
  return entries.find((entry) => entry.name === name)?.type;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 2 || code === 'ENOENT';
}

type WriteSource = { kind: 'content'; content: string } | { kind: 'local'; localPath: string };

/**
 * Which source a write carries.
 *
 * Exactly one is required. "Both" is not a richer request but an ambiguous one — which bytes
 * would land? — and "neither" is not a write at all. The caller is a model, so the messages say
 * what to pass rather than which rule was broken.
 */
function resolveWriteSource(input: { content?: string; localPath?: string }): WriteSource {
  const content = typeof input.content === 'string' ? input.content : undefined;
  const localPath = input.localPath;
  if (content !== undefined && localPath !== undefined) {
    throw new Error('Pass either content or localPath, not both.');
  }
  if (content !== undefined) {
    return { kind: 'content', content };
  }
  if (localPath === undefined) {
    throw new Error('Provide either content (inline text) or localPath (a file on this machine).');
  }
  if (localPath.trim() === '') {
    throw new Error('Local path cannot be empty.');
  }
  return { kind: 'local', localPath };
}

/**
 * Local metadata for an upload source, or a refusal that says which check failed.
 *
 * The ENOENT message names the path the caller gave: a model that mistyped a directory gets
 * "was not found" plus the exact string it sent, which is the only way it can see the typo.
 * The other two refusals name the *resolved* path instead — that is the object that would
 * actually move, and for a symlink the name the caller typed points somewhere else.
 * Other failures (EACCES on the file, a vanished mount) are rethrown untouched — they describe
 * the local disk, not the request, and rewriting them here would hide the real cause.
 */
async function statLocalSource(
  session: AgentSftpSession,
  localPath: string
): Promise<{ size: number; isFile: boolean; realPath: string }> {
  let local: { size: number; isFile: boolean; realPath: string };
  try {
    local = await session.statLocalFile(localPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Local file was not found: ${localPath}`);
    }
    throw error;
  }
  if (!local.isFile) {
    throw new Error(`Local path is not a regular file: ${local.realPath}`);
  }
  if (local.size > MAX_LOCAL_UPLOAD_BYTES) {
    // Both bounds are stated because they disagree: the cap is generous enough to invite a
    // retry, and the deadline means anything near it cannot finish. Naming only one of them
    // produces a second failure with the same shape.
    throw new Error(
      `Local file is too large to upload: ${local.realPath} is ${formatFileSize(local.size)}; ` +
        `the limit is ${formatFileSize(MAX_LOCAL_UPLOAD_BYTES)} and the upload deadline is ` +
        `${UPLOAD_TIMEOUT_MS / 1000} s.`
    );
  }
  return local;
}

/**
 * Whether a failure is the upload deadline rather than a transfer error that happens to share
 * the words. `withTimeout` leaves only the message as a marker, so it is matched at the start.
 */
function isUploadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Timed out uploading');
}

/** Bridges the session's `TransferProgress` port to the plain callback the tool layer passes in. */
function progressFor(
  onProgress: ((transferredBytes: number, totalBytes: number) => void) | undefined
): TransferProgress | undefined {
  if (!onProgress) {
    return undefined;
  }
  return { report: ({ transferredBytes, totalBytes }) => onProgress(transferredBytes, totalBytes) };
}

function basenameRemotePath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function clampReadBytes(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_READ_BYTES;
  }
  return Math.min(value, MAX_READ_BYTES);
}

function clampMaxEntries(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_MAX_ENTRIES;
  }
  return Math.min(value, MAX_ENTRIES);
}

function clampListOffset(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return 0;
  }
  return value;
}

/** Byte position a read starts at; negative offsets count back from the end of the file. */
function resolveReadStart(offset: number | undefined, size: number): number {
  if (offset === undefined || !Number.isInteger(offset) || offset === 0) {
    return 0;
  }
  if (offset < 0) {
    return Math.max(0, size + offset);
  }
  return Math.min(offset, size);
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function auditReasonForError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('was cancelled')) {
    return 'user_cancelled';
  }
  if (message.includes('does not allow background connections')) {
    return 'background_denied';
  }
  if (message.includes('Timed out waiting for SFTP')) {
    return 'confirmation_timeout';
  }
  // A stalled channel is not a permission problem and not a bug: it is the case the read
  // deadline exists for, so it gets its own code rather than `error`.
  if (message.includes('Timed out reading') || message.includes('Timed out listing')) {
    return 'read_timeout';
  }
  // Same reasoning on the upload side: a transfer that ran out of time says the link is slow
  // or stalled, which is a different answer from "the call failed".
  if (message.includes('Timed out uploading')) {
    return 'upload_timeout';
  }
  // The local pre-flight has three failure modes a reader has to be able to tell apart: a
  // mistyped path, a directory, and a file too big to move. None of them is a policy denial.
  if (message.startsWith('Local file was not found:')) {
    return 'local_not_found';
  }
  if (message.startsWith('Local path is not a regular file:')) {
    return 'local_not_regular_file';
  }
  if (message.startsWith('Local file is too large to upload:')) {
    return 'local_too_large';
  }
  return 'error';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  // The loser of this race still settles later, and on the upload path that loser is a `fastPut`
  // the abort is about to reject. `Promise.race` already subscribes to every participant, so the
  // rejection is handled today; this keeps it handled if the race is ever rewritten as a manual
  // timer, which would leave the abandoned transfer's rejection unhandled.
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
