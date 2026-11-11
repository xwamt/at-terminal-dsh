import { posix } from 'node:path';
import type { ServerConfig } from '../config/schema';
import { formatFileSize } from '../sftp/FileSize';
import {
  isSftpConflictError,
  SftpEditMatchError,
  SftpNotObservedError,
  SftpPatchRejectedError,
  SftpPatchSyntaxError,
  SftpStaleVersionError,
  type SftpPatchRefusal
} from '../sftp/SftpErrors';
import { applyHunks, PatchParseError, parsePatch, type PatchHunk, type ParsedPatchOperation } from '../sftp/patch';
import type { SftpEntry, SftpEntryType, SftpFileStat } from '../sftp/SftpTypes';
import type { TransferProgress } from '../sftp/TransferService';
import { dirname, joinRemotePath } from '../sftp/RemotePath';
import type { TerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import type { AgentAuditRecorder } from './AgentAuditLog';
import { isSensitiveRemotePath, isWithinRemoteDirectory } from './remoteWritePolicy';
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

/**
 * How strongly an agent SFTP write is checked against a prior read.
 *
 * - `off`: the 0.3.0 behaviour — existence and overwrite rules only.
 * - `observe` (default): explicit `expectedSize` / `expectedModifiedAt` are enforced, so a
 *   caller that read the file can protect itself; one that did not keeps working.
 * - `strict`: the caller must have read the file through this connection, and the current
 *   stat must still match that read. The only mode that protects a caller which forgot to
 *   pass expected values.
 */
export type SftpWriteGuard = 'off' | 'observe' | 'strict';

/** The metadata a read leaves behind, compared before a later write on the same connection. */
interface SftpFileVersion {
  size: number;
  modifiedAt: number;
}

/** Simulated file state used while preflighting a whole patch. */
interface PatchFileState {
  exists: boolean;
  stat?: SftpFileStat;
  /** LF-normalized content; present for an existing file and for a simulated add/update. */
  text?: string;
  eol: 'lf' | 'crlf';
  /** True once an earlier operation in this patch changed the simulated state. */
  touched: boolean;
}

/** One parsed operation after path resolution and in-memory hunk application. */
interface PlannedPatchOperation {
  index: number;
  kind: 'add' | 'update' | 'delete' | 'move';
  path: string;
  destination?: string;
  patchLine: number;
  /** Add content, or the target of an update/move after hunk application. */
  content?: string;
  /** Update/move source before the hunk application (LF-normalized). */
  before?: string;
  /** Line-ending convention of the source; update/move restore it. */
  eol?: 'lf' | 'crlf';
  /** Version observed during preflight, for the commit re-check. */
  sourceStat?: SftpFileStat;
  /** True when an earlier operation in this patch already changed the source. */
  sourceTouched?: boolean;
  /** Move destination must not exist; add destination likewise. */
  destinationStat?: SftpFileStat;
}

interface PatchAttempt {
  operation: PlannedPatchOperation;
  status: SftpApplyPatchOperation['status'];
  code?: string;
  message?: string;
  hunkLine?: number;
  bytesWritten?: number;
}

/** What `editFile` reports back: the replacement count plus the file's post-write stat. */
export interface SftpEditResult {
  terminalId?: string;
  serverId: string;
  path: string;
  replacements: number;
  bytesWritten: number;
  size: number;
  modifiedAt: number;
}

/** One operation in an apply-patch commit, including the part that succeeded. */
export interface SftpApplyPatchOperation {
  /** Zero-based position in patch order. */
  index: number;
  kind: 'add' | 'update' | 'delete' | 'move';
  /** Resolved absolute source path. */
  path: string;
  /** Present only for a move: the resolved absolute destination. */
  destination?: string;
  /** One-based operation-header line in the original patch. */
  patchLine: number;
  status: 'completed' | 'failed' | 'unknown' | 'skipped';
  code?: string;
  message?: string;
  /** One-based hunk line for a matching failure. */
  hunkLine?: number;
  bytesWritten?: number;
}

/** What `applyPatch` returns when the commit phase actually started. */
export interface SftpApplyPatchResult {
  terminalId?: string;
  serverId: string;
  phase: 'commit';
  cancelled: boolean;
  operations: SftpApplyPatchOperation[];
  affectedPaths: string[];
}

/** Version facts a write/delete caller may carry from its last read. */
interface SftpExpectedVersion {
  expectedSize?: number;
  expectedModifiedAt?: number;
  sftpWriteGuard?: SftpWriteGuard;
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
 * Largest file `editFile` will read into memory and rewrite.
 *
 * Matches the Host's own in-panel text cap (`SFTP_TEXT_MAX_BYTES`, 2 MiB): a remote file and
 * a local one should hit "too big to edit this way" at the same place. Editing must read the
 * whole file — a literal replacement cannot be applied to a window it might straddle — so
 * this is the one tool where the cap is a memory bound, not just a display bound.
 */
const SFTP_EDIT_MAX_BYTES = 2 * 1024 * 1024;

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
  /**
   * Reads remembered per connection, keyed by scope (`terminal:<id>` / `server:<id>`), then
   * by `serverId\0resolvedPath`. Two levels because the scope is what a reconnect destroys:
   * a version read over one SSH connection is not evidence about the file as seen through a
   * different one, and the file itself can be replaced while the link is down.
   */
  private readonly observations = new Map<string, Map<string, SftpFileVersion>>();

  /** Removes the terminal-context subscriptions added in the constructor. */
  private readonly terminalContextSubscriptions: Array<{ dispose(): void }> = [];

  constructor(private readonly options: SftpAgentServiceOptions) {
    /**
     * A terminal that disconnects must not leave its pooled SFTP connection (or the
     * versions read over it) alive. The registry keeps a closed terminal in its map as
     * `connected: false` — it is `onDidChangeContext`, not `onDidRemoveContext`, that
     * announces that transition — so subscribing to removal alone left an idle or
     * closed tab's SSH session open indefinitely.
     */
    const onConnectionChange = this.options.terminalContext.onDidChangeContext?.((context) => {
      if (!context.connected) this.disposeTerminal(context.terminalId);
    });
    // Kept as well: a terminal can be removed outright without passing through a
    // disconnected state (for example when the panel tears the registry entry down).
    const onRemoval = this.options.terminalContext.onDidRemoveContext?.((terminalId) =>
      this.disposeTerminal(terminalId)
    );
    if (onConnectionChange) this.terminalContextSubscriptions.push(onConnectionChange);
    if (onRemoval) this.terminalContextSubscriptions.push(onRemoval);
  }

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
        const stat = await withTimeout(
          lease.session.stat(path),
          READ_TIMEOUT_MS,
          `Timed out reading metadata for ${path}.`
        );
        // A stat is a read of the file's identity: the caller now knows the version it is
        // about to overwrite, so `strict` must count this as the read it asked for.
        this.observe(target, lease, path, stat);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          resolvedBy: target.resolvedBy,
          ...(target.candidates === undefined ? {} : { candidates: target.candidates }),
          path,
          ...stat
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
        // Any successful read is evidence of the version the caller saw, even a windowed one:
        // the guard protects against a *changed file*, not against a caller that chose not to
        // read every byte. Recorded after the binary check because a read that threw told the
        // caller nothing to trust.
        this.observe(target, lease, path, stat);
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
    } & SftpExpectedVersion
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
        const current = await statIfPresent(lease.session, writable.path);
        const exists = current !== undefined;
        if (exists && !input.overwrite) {
          throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
        }
        // Checked before the authorization prompt: asking a human to approve a write that
        // will then be refused for a version conflict wastes the one decision they get.
        await this.assertVersionAllowsWrite(target, lease, writable.path, input, current);
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
        await this.observeAfterWrite(target, lease, writable.path);
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
   * Replaces one literal string inside a remote text file.
   *
   * The alternative was read-everything + write-everything: for a large config file that
   * costs the model the whole file twice, and any read window smaller than the file turns a
   * whole-file write into silent truncation. Here the file is read on the Host, matched
   * literally, and only the replacement travels back through the tool arguments.
   *
   * Line endings are data. `oldString` / `newString` are normalised to LF for matching and
   * the file's own convention is restored on write, so a CRLF file is not rewritten as LF by
   * an edit that never mentioned line endings. `replaceAll` has to be opt-in: a short needle
   * that happens to occur twice is exactly when a blind global replace is wrong.
   */
  async editFile(
    input: SftpTargetInput & {
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    } & SftpExpectedVersion
  ): Promise<SftpEditResult> {
    return await this.withAudit('sftp_edit_file', input, async () => {
      const target = await this.resolveTarget(input, 'write');
      const lease = await this.leaseFor(target);
      try {
        const writable = await this.resolveWritablePath(lease, input.path);
        const current = await statIfPresent(lease.session, writable.path);
        if (current === undefined) {
          throw new Error('Remote file was not found.');
        }
        if (current.size > SFTP_EDIT_MAX_BYTES) {
          throw new Error(tooLargeToEditMessage(current.size));
        }
        if (typeof input.oldString !== 'string' || input.oldString === '') {
          throw new Error('oldString must be a non-empty string.');
        }
        if (typeof input.newString !== 'string') {
          throw new Error('newString must be a string.');
        }
        // Read one byte past the recorded size so a file that grew since the stat is
        // detectable instead of being silently cut to the old length. The cap keeps the
        // allocation bounded even when the server ignores the requested length.
        const readLimit = Math.min(current.size + 1, SFTP_EDIT_MAX_BYTES + 1);
        const buffer = await withTimeout(
          lease.session.readFile(writable.path, readLimit),
          READ_TIMEOUT_MS,
          `Timed out reading remote file ${writable.path}.`
        );
        if (buffer.length > SFTP_EDIT_MAX_BYTES) {
          throw new Error(tooLargeToEditMessage(buffer.length));
        }
        if (buffer.length !== current.size) {
          const actual = await statIfPresent(lease.session, writable.path);
          throw new SftpStaleVersionError(
            writable.path,
            { size: current.size, modifiedAt: current.modifiedAt },
            actual ?? { size: buffer.length, modifiedAt: current.modifiedAt }
          );
        }
        if (looksBinary(buffer)) {
          throw new Error(
            `Remote file appears to be binary; refusing to edit ${writable.path}. ` +
              'Download it or change it with a command on the server instead.'
          );
        }
        const eol = detectEol(buffer);
        const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
        const oldString = normalizeEol(input.oldString);
        const newString = normalizeEol(input.newString);
        const occurrences = countOccurrences(text, oldString);
        if (occurrences === 0) {
          throw new SftpEditMatchError(writable.path, 0);
        }
        if (occurrences > 1 && input.replaceAll !== true) {
          throw new SftpEditMatchError(writable.path, occurrences);
        }
        const replaced =
          input.replaceAll === true
            ? text.split(oldString).join(newString)
            : replaceFirst(text, oldString, newString);
        const encodedText = eol === 'crlf' ? replaced.replace(/\n/g, '\r\n') : replaced;
        const content = Buffer.from(encodedText, 'utf8');
        if (content.length > SFTP_EDIT_MAX_BYTES) {
          throw new Error(
            `The edited text is ${content.length} bytes, over the ${SFTP_EDIT_MAX_BYTES}-byte limit for remote edit.`
          );
        }
        await this.assertVersionAllowsWrite(target, lease, writable.path, input, current);
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            // `write_file` is the authorizer's existing vocabulary; the confirmation names a
            // single path write, which is exactly what an edit is. A new operation string
            // would require the confirmation copy to learn a synonym for the same decision.
            operation: 'write_file',
            path: writable.path,
            overwrite: true,
            workspaceRoot: writable.workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP edit authorization for ${writable.path}.`
        );
        await withTimeout(
          lease.session.writeFile(writable.path, content),
          WRITE_TIMEOUT_MS,
          `Timed out writing remote file ${writable.path}.`
        );
        // The output's `size` / `modifiedAt` are the next call's expected values, so they are
        // read back rather than derived from `content.length`: a server that rewrites through
        // a temporary file leaves a different inode and timestamp.
        const after = await withTimeout(
          lease.session.stat(writable.path),
          READ_TIMEOUT_MS,
          `Timed out reading metadata for ${writable.path}.`
        );
        this.observe(target, lease, writable.path, after);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path: writable.path,
          replacements: input.replaceAll === true ? occurrences : 1,
          bytesWritten: content.length,
          size: after.size,
          modifiedAt: after.modifiedAt
        };
      } finally {
        lease.release();
      }
    });
  }


  /**
   * Applies one Codex-style patch to a set of remote UTF-8 files.
   *
   * SFTP has no transaction: the only honest design is the one the Host's local `apply_patch`
   * uses -- parse and simulate the whole patch first, refuse everything if any operation cannot
   * be applied, then commit in order with the first failure stopping later operations. The
   * returned `operations` array keeps the completed prefix and marks the rest `skipped`; a
   * mutation whose outcome cannot be known (a timed-out write) is `unknown`, never silently
   * reported as failed.
   *
   * All hunks are matched against LF-normalized text; each file's original CRLF/LF convention
   * is restored on write. Preflight and commit share one lease, which is also what makes
   * `strict` write guarding see the reads this method performs.
   */
  async applyPatch(
    input: SftpTargetInput & {
      path: string;
      input: string;
      signal?: AbortSignal;
      sftpWriteGuard?: SftpWriteGuard;
    }
  ): Promise<SftpApplyPatchResult> {
    return await this.withAudit('sftp_apply_patch', input, async () => {
      const target = await this.resolveTarget(input, 'write');
      const lease = await this.leaseFor(target);
      try {
        const base = await this.resolvePatchBase(lease, input.path);
        const parsed = this.parsePatchInput(input.input);
        if (parsed.length === 0) {
          return {
            terminalId: target.terminalId,
            serverId: target.server.id,
            phase: 'commit',
            cancelled: false,
            operations: [],
            affectedPaths: []
          } satisfies SftpApplyPatchResult;
        }
        const planned = await this.planPatch(target, lease, base, parsed);
        return await this.commitPatch(target, lease, planned, input.signal, input.sftpWriteGuard);
      } finally {
        lease.release();
      }
    });
  }

  /** Parse the model's patch text, translating the parser's error into the service vocabulary. */
  private parsePatchInput(input: string): ParsedPatchOperation[] {
    try {
      return parsePatch(input);
    } catch (error) {
      if (error instanceof PatchParseError) {
        throw new SftpPatchSyntaxError(error.lineNumber, error.reason);
      }
      throw error;
    }
  }

  /** Resolve the patch base directory; patch paths are relative to it and cannot escape it. */
  private async resolvePatchBase(lease: SessionLease, path: string): Promise<string> {
    const base = await this.resolvePath(lease, path);
    const stat = await withTimeout(
      lease.session.stat(base),
      READ_TIMEOUT_MS,
      `Timed out reading metadata for ${base}.`
    );
    if (stat.type !== undefined && stat.type !== 'directory') {
      throw new Error(`Patch base path is not a directory: ${base}`);
    }
    return base;
  }

  /** Resolve one patch path against the base, rejecting absolute paths and `..` escapes. */
  private async resolvePatchOperationPath(lease: SessionLease, base: string, rawPath: string): Promise<string> {
    const raw = rawPath.trim();
    if (raw === '') {
      throw new Error('Patch path cannot be empty.');
    }
    if (raw.startsWith('/')) {
      throw new Error(`Patch path must be relative to the patch base directory: ${rawPath}`);
    }
    if (raw.startsWith('~')) {
      throw new Error(`Patch path cannot use "~": ${rawPath}`);
    }
    const candidate = posix.normalize(joinRemotePath(base, raw));
    if (!isWithinRemoteDirectory(base, candidate)) {
      throw new Error(`Patch path escapes the base directory (${base}): ${rawPath}`);
    }
    return (await this.resolveWritablePath(lease, candidate)).path;
  }

  /**
   * Preflight every operation against one simulated map.
   *
   * The map is what catches "the patch looks valid one file at a time but not as a sequence":
   * an Add followed by an Update must see the added content, a Delete followed by an Add must
   * see an absent path, and repeated aliases of the same resolved path share one state.
   */
  private async planPatch(
    target: SftpTarget,
    lease: SessionLease,
    base: string,
    parsed: ParsedPatchOperation[]
  ): Promise<PlannedPatchOperation[]> {
    const states = new Map<string, PatchFileState>();
    const operations: PlannedPatchOperation[] = [];
    const refusals: SftpPatchRefusal[] = [];

    const refuse = (
      index: number,
      kind: SftpPatchRefusal['kind'],
      path: string,
      patchLine: number,
      message: string,
      code: string,
      extra: { destination?: string; hunkLine?: number } = {}
    ): void => {
      refusals.push({ index, kind, path, patchLine, message, code, ...extra });
    };

    for (const [index, operation] of parsed.entries()) {
      const kind: SftpPatchRefusal['kind'] =
        operation.kind === 'update' && operation.moveTo !== undefined ? 'move' : operation.kind;
      let path = operation.path;
      let destination: string | undefined;
      try {
        path = await this.resolvePatchOperationPath(lease, base, operation.path);
        if (operation.kind === 'update' && operation.moveTo !== undefined) {
          destination = await this.resolvePatchOperationPath(lease, base, operation.moveTo);
          if (destination === path) {
            refuse(index, 'move', path, operation.lineNumber, `cannot move "${path}" to itself`, 'sftp-patch-same-target', {
              destination
            });
            continue;
          }
        }

        switch (operation.kind) {
          case 'add': {
            const state = await this.patchState(target, lease, states, path, false);
            if (state.exists) {
              refuse(index, 'add', path, operation.lineNumber, `cannot add "${path}": file already exists`, 'sftp-patch-already-exists');
              break;
            }
            operations.push({
              index,
              kind: 'add',
              path,
              patchLine: operation.lineNumber,
              content: operation.content
            });
            states.set(path, { exists: true, text: operation.content, eol: 'lf', touched: true });
            break;
          }
          case 'update': {
            const state = await this.patchState(target, lease, states, path);
            if (!state.exists) {
              refuse(index, kind, path, operation.lineNumber, `cannot update "${path}": file not found`, 'sftp-patch-not-found');
              break;
            }
            const applied = applyHunks(state.text ?? '', operation.hunks);
            if (!applied.ok) {
              refuse(
                index,
                kind,
                path,
                operation.lineNumber,
                `hunk at patch line ${applied.failure.hunkLineNumber} (${applied.failure.stage}) does not match`,
                'sftp-patch-mismatch',
                { hunkLine: applied.failure.hunkLineNumber }
              );
              break;
            }
            if (destination !== undefined) {
              const destinationState = await this.patchState(target, lease, states, destination);
              if (destinationState.exists) {
                refuse(index, 'move', path, operation.lineNumber, `cannot move to "${destination}": destination already exists`, 'sftp-patch-already-exists', { destination });
                break;
              }
              if (isSensitiveRemotePath(path)) {
                refuse(index, 'move', path, operation.lineNumber, `cannot move sensitive path "${path}"`, 'sftp-patch-sensitive-path', { destination });
                break;
              }
              if (await this.isSymlinkPatchSource(lease, path)) {
                refuse(index, 'move', path, operation.lineNumber, `cannot move "${path}": path is a symbolic link`, 'sftp-patch-symlink-source', { destination });
                break;
              }
              operations.push({
                index,
                kind: 'move',
                path,
                destination,
                patchLine: operation.lineNumber,
                before: state.text ?? '',
                content: applied.after,
                eol: state.eol,
                sourceStat: state.stat,
                sourceTouched: state.touched,
                destinationStat: destinationState.stat
              });
              states.set(path, { exists: false, eol: state.eol, touched: true });
              states.set(destination, { exists: true, text: applied.after, eol: state.eol, touched: true });
              break;
            }
            operations.push({
              index,
              kind: 'update',
              path,
              patchLine: operation.lineNumber,
              before: state.text ?? '',
              content: applied.after,
              eol: state.eol,
              sourceStat: state.stat,
              sourceTouched: state.touched
            });
            states.set(path, { ...state, text: applied.after, touched: true });
            break;
          }
          case 'delete': {
            const state = await this.patchState(target, lease, states, path, false);
            if (!state.exists) {
              refuse(index, 'delete', path, operation.lineNumber, `cannot delete "${path}": file not found`, 'sftp-patch-not-found');
              break;
            }
            if (isSensitiveRemotePath(path)) {
              refuse(index, 'delete', path, operation.lineNumber, `cannot delete sensitive path "${path}"`, 'sftp-patch-sensitive-path');
              break;
            }
            if (await this.isSymlinkPatchSource(lease, path)) {
              refuse(index, 'delete', path, operation.lineNumber, `cannot delete "${path}": path is a symbolic link`, 'sftp-patch-symlink-source');
              break;
            }
            operations.push({
              index,
              kind: 'delete',
              path,
              patchLine: operation.lineNumber,
              sourceStat: state.stat,
              sourceTouched: state.touched
            });
            states.set(path, { exists: false, eol: state.eol, touched: true });
            break;
          }
        }
      } catch (error) {
        refuse(index, kind, path, operation.lineNumber, errorMessage(error), patchRefusalCode(error), {
          ...(destination === undefined ? {} : { destination })
        });
      }
    }

    if (refusals.length > 0) {
      refusals.sort((left, right) => left.index - right.index);
      throw new SftpPatchRejectedError(refusals);
    }
    return operations;
  }

  /** Read and cache one file's simulated state for preflight. */
  private async patchState(
    target: SftpTarget,
    lease: SessionLease,
    states: Map<string, PatchFileState>,
    path: string,
    readText = true
  ): Promise<PatchFileState> {
    const known = states.get(path);
    if (known !== undefined) {
      return known;
    }
    const stat = await statIfPresent(lease.session, path);
    if (stat === undefined) {
      const state: PatchFileState = { exists: false, eol: 'lf', touched: false };
      states.set(path, state);
      return state;
    }
    if (stat.type !== undefined && stat.type !== 'file') {
      throw new Error(`Remote path is not a regular file: ${path}`);
    }
    if (!readText) {
      // A stat is still a read of the file's identity (see `statPath`), so a strict delete
      // can be authorized without fetching bytes it is about to remove.
      this.observe(target, lease, path, stat);
      const state: PatchFileState = { exists: true, stat, eol: 'lf', touched: false };
      states.set(path, state);
      return state;
    }
    const content = await this.readPatchFile(target, lease, path, stat);
    const state: PatchFileState = { exists: true, stat, text: content.text, eol: content.eol, touched: false };
    states.set(path, state);
    return state;
  }

  /** Read a file for patch preflight, enforcing the same text/size/binary rules as editFile. */
  private async readPatchFile(
    target: SftpTarget,
    lease: SessionLease,
    path: string,
    stat: SftpFileStat
  ): Promise<{ text: string; eol: 'lf' | 'crlf' }> {
    if (stat.size > SFTP_EDIT_MAX_BYTES) {
      throw new Error(tooLargeToPatchMessage(stat.size));
    }
    const readLimit = Math.min(stat.size + 1, SFTP_EDIT_MAX_BYTES + 1);
    const buffer = await withTimeout(
      lease.session.readFile(path, readLimit),
      READ_TIMEOUT_MS,
      `Timed out reading remote file ${path}.`
    );
    if (buffer.length > SFTP_EDIT_MAX_BYTES) {
      throw new Error(tooLargeToPatchMessage(buffer.length));
    }
    if (buffer.length !== stat.size) {
      throw new SftpStaleVersionError(path, { size: stat.size, modifiedAt: stat.modifiedAt });
    }
    if (looksBinary(buffer)) {
      throw new Error(`Remote file appears to be binary; refusing to patch ${path}.`);
    }
    // A preflight read is exactly the read `strict` asks for; record it before the commit
    // phase so the caller does not have to issue a second read-only call for every file.
    this.observe(target, lease, path, stat);
    return {
      text: buffer.toString('utf8').replace(/\r\n/g, '\n'),
      eol: detectEol(buffer)
    };
  }

  private async isSymlinkPatchSource(lease: SessionLease, path: string): Promise<boolean> {
    return (await remoteEntryType(lease.session, path)) === 'symlink';
  }

  /** Commit a fully admitted plan in order; first failure stops later operations. */
  private async commitPatch(
    target: SftpTarget,
    lease: SessionLease,
    operations: PlannedPatchOperation[],
    signal: AbortSignal | undefined,
    guard: SftpWriteGuard | undefined
  ): Promise<SftpApplyPatchResult> {
    const attempts: PatchAttempt[] = operations.map((operation) => ({ operation, status: 'skipped' }));
    let cancelled = false;

    for (const [index, operation] of operations.entries()) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      let started = false;
      let result: PatchAttempt;
      try {
        if (operation.kind === 'add') {
          const exists = await statIfPresent(lease.session, operation.path);
          if (exists !== undefined) {
            throw new Error(`Remote file already exists: ${operation.path}`);
          }
          await this.patchAuthorizeWrite(target, lease, operation.path, 'create_file', false);
          started = true;
          await withTimeout(
            lease.session.createFile(operation.path),
            WRITE_TIMEOUT_MS,
            `Timed out creating remote file ${operation.path}.`
          );
          const content = Buffer.from(operation.content ?? '', 'utf8');
          if (content.length > 0) {
            await withTimeout(
              lease.session.writeFile(operation.path, content),
              WRITE_TIMEOUT_MS,
              `Timed out writing remote file ${operation.path}.`
            );
          }
          const after = await this.expectPatchStat(lease, operation.path);
          this.observe(target, lease, operation.path, after);
          result = { operation, status: 'completed', bytesWritten: content.length };
        } else if (operation.kind === 'update') {
          const current = await this.readPatchCurrent(target, lease, operation.path);
          if (operation.before !== undefined && current.text !== operation.before) {
            throw new SftpStaleVersionError(operation.path, operation.sourceStat, current.stat);
          }
          await this.assertVersionAllowsWrite(target, lease, operation.path, { sftpWriteGuard: guard }, current.stat);
          await this.patchAuthorizeWrite(target, lease, operation.path, 'write_file', true);
          started = true;
          const content = Buffer.from(restorePatchEol(operation.content ?? '', operation.eol ?? current.eol), 'utf8');
          await withTimeout(
            lease.session.writeFile(operation.path, content),
            WRITE_TIMEOUT_MS,
            `Timed out writing remote file ${operation.path}.`
          );
          const after = await this.expectPatchStat(lease, operation.path);
          this.observe(target, lease, operation.path, after);
          result = { operation, status: 'completed', bytesWritten: content.length };
        } else if (operation.kind === 'delete') {
          const current = await statIfPresent(lease.session, operation.path);
          if (current === undefined) {
            throw new SftpStaleVersionError(operation.path, operation.sourceStat);
          }
          await this.assertPatchVersion(operation, current);
          await this.assertVersionAllowsWrite(target, lease, operation.path, { sftpWriteGuard: guard }, current);
          await this.patchAuthorizeDelete(target, lease, operation.path);
          started = true;
          await withTimeout(
            lease.session.deleteFile(operation.path),
            WRITE_TIMEOUT_MS,
            `Timed out deleting remote file ${operation.path}.`
          );
          this.forgetObservation(target, lease, operation.path);
          result = { operation, status: 'completed' };
        } else {
          const current = await this.readPatchCurrent(target, lease, operation.path);
          if (operation.before !== undefined && current.text !== operation.before) {
            throw new SftpStaleVersionError(operation.path, operation.sourceStat, current.stat);
          }
          await this.assertVersionAllowsWrite(target, lease, operation.path, { sftpWriteGuard: guard }, current.stat);
          const destinationExists = await statIfPresent(lease.session, operation.destination!);
          if (destinationExists !== undefined) {
            throw new Error(`Remote destination already exists: ${operation.destination}`);
          }
          if ((operation.content ?? '') === (operation.before ?? '')) {
            await this.patchAuthorizeWrite(target, lease, operation.path, 'rename', false);
            await this.patchAuthorizeWrite(target, lease, operation.destination!, 'rename', false);
            started = true;
            await withTimeout(
              lease.session.rename(operation.path, operation.destination!),
              WRITE_TIMEOUT_MS,
              `Timed out renaming remote path ${operation.path}.`
            );
            this.forgetObservation(target, lease, operation.path);
            const after = await this.expectPatchStat(lease, operation.destination!);
            this.observe(target, lease, operation.destination!, after);
            result = { operation, status: 'completed' };
          } else {
            const content = Buffer.from(restorePatchEol(operation.content ?? '', operation.eol ?? current.eol), 'utf8');
            await this.patchAuthorizeWrite(target, lease, operation.destination!, 'create_file', false);
            started = true;
            await withTimeout(
              lease.session.createFile(operation.destination!),
              WRITE_TIMEOUT_MS,
              `Timed out creating remote file ${operation.destination}.`
            );
            if (content.length > 0) {
              await withTimeout(
                lease.session.writeFile(operation.destination!, content),
                WRITE_TIMEOUT_MS,
                `Timed out writing remote file ${operation.destination}.`
              );
            }
            try {
              await this.patchAuthorizeDelete(target, lease, operation.path);
              await withTimeout(
                lease.session.deleteFile(operation.path),
                WRITE_TIMEOUT_MS,
                `Timed out deleting remote file ${operation.path}.`
              );
            } catch (deleteError) {
              const destinationAfter = await statIfPresent(lease.session, operation.destination!);
              if (destinationAfter !== undefined) this.observe(target, lease, operation.destination!, destinationAfter);
              result = {
                operation,
                status: 'failed',
                code: 'sftp-patch-move-partial',
                message: `destination ${operation.destination} was written but source ${operation.path} could not be removed: ${errorMessage(deleteError)}`,
                bytesWritten: content.length
              };
              attempts[index] = result;
              break;
            }
            this.forgetObservation(target, lease, operation.path);
            const after = await this.expectPatchStat(lease, operation.destination!);
            this.observe(target, lease, operation.destination!, after);
            result = { operation, status: 'completed', bytesWritten: content.length };
          }
        }
      } catch (error) {
        const failure = patchCommitFailure(error, started);
        result = { operation, status: failure.unknown ? 'unknown' : 'failed', ...failure };
      }
      attempts[index] = result;
      if (result.status !== 'completed') {
        break;
      }
    }

    const affectedPaths = new Set<string>();
    for (const attempt of attempts) {
      if (attempt.status === 'completed' || attempt.code === 'sftp-patch-move-partial') {
        affectedPaths.add(attempt.operation.path);
        if (attempt.operation.destination !== undefined) affectedPaths.add(attempt.operation.destination);
      }
    }
    return {
      terminalId: target.terminalId,
      serverId: target.server.id,
      phase: 'commit',
      cancelled,
      operations: attempts.map((attempt) => ({
        index: attempt.operation.index,
        kind: attempt.operation.kind,
        path: attempt.operation.path,
        ...(attempt.operation.destination === undefined ? {} : { destination: attempt.operation.destination }),
        patchLine: attempt.operation.patchLine,
        status: attempt.status,
        ...(attempt.code === undefined ? {} : { code: attempt.code }),
        ...(attempt.message === undefined ? {} : { message: attempt.message }),
        ...(attempt.hunkLine === undefined ? {} : { hunkLine: attempt.hunkLine }),
        ...(attempt.bytesWritten === undefined ? {} : { bytesWritten: attempt.bytesWritten })
      })),
      affectedPaths: [...affectedPaths]
    };
  }

  private async readPatchCurrent(
    target: SftpTarget,
    lease: SessionLease,
    path: string
  ): Promise<{ stat: SftpFileStat; text: string; eol: 'lf' | 'crlf' }> {
    const stat = await statIfPresent(lease.session, path);
    if (stat === undefined) {
      throw new SftpStaleVersionError(path);
    }
    if (stat.type !== undefined && stat.type !== 'file') {
      throw new Error(`Remote path is not a regular file: ${path}`);
    }
    const file = await this.readPatchFile(target, lease, path, stat);
    return { stat, ...file };
  }

  private async expectPatchStat(lease: SessionLease, path: string): Promise<SftpFileStat> {
    return await withTimeout(
      lease.session.stat(path),
      READ_TIMEOUT_MS,
      `Timed out reading metadata for ${path}.`
    );
  }

  private async assertPatchVersion(operation: PlannedPatchOperation, current: SftpFileStat): Promise<void> {
    if (operation.sourceTouched === true || operation.sourceStat === undefined) {
      return;
    }
    if (
      current.size !== operation.sourceStat.size ||
      current.modifiedAt !== operation.sourceStat.modifiedAt
    ) {
      throw new SftpStaleVersionError(operation.path, operation.sourceStat, current);
    }
  }

  private async patchAuthorizeWrite(
    target: SftpTarget,
    lease: SessionLease,
    path: string,
    operation: 'write_file' | 'create_file' | 'rename',
    overwrite: boolean
  ): Promise<void> {
    await withTimeout(
      this.options.authorizer.requireWrite(target.server, {
        operation,
        path,
        overwrite,
        workspaceRoot: this.scopeWorkspaceRoot(lease)
      }),
      WRITE_TIMEOUT_MS,
      `Timed out waiting for SFTP patch authorization for ${path}.`
    );
  }

  private async patchAuthorizeDelete(target: SftpTarget, lease: SessionLease, path: string): Promise<void> {
    await withTimeout(
      this.options.authorizer.requireDelete(target.server, {
        operation: 'delete_file',
        path,
        overwrite: false,
        workspaceRoot: this.scopeWorkspaceRoot(lease)
      }),
      WRITE_TIMEOUT_MS,
      `Timed out waiting for SFTP patch delete confirmation for ${path}.`
    );
  }

  private scopeWorkspaceRoot(lease: SessionLease): string {
    return this.roots.get(lease.rootKey) ?? '/';
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
    } & SftpExpectedVersion,
    target: SftpTarget,
    lease: SessionLease,
    writable: WritableTarget
  ) {
    const local = await statLocalSource(lease.session, localPath);
    const sourcePath = local.realPath;
    const current = await statIfPresent(lease.session, writable.path);
    const exists = current !== undefined;
    if (exists && !input.overwrite) {
      throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
    }
    await this.assertVersionAllowsWrite(target, lease, writable.path, input, current);
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
    await this.observeAfterWrite(target, lease, writable.path);
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

  async deleteFile(input: SftpTargetInput & { path: string } & SftpExpectedVersion) {
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
        // Deleting the file someone else just replaced is the other half of the stale-write
        // problem: the bytes the caller decided to remove may no longer exist, and the file
        // now at this path may be the new one. One stat, only when the guard can use it.
        if (needsVersionCheck(input)) {
          const current = await statIfPresent(lease.session, path);
          if (current === undefined) {
            throw new Error('Remote file was not found.');
          }
          await this.assertVersionAllowsWrite(target, lease, path, input, current);
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
        this.forgetObservation(target, lease, path);
        return { terminalId: target.terminalId, serverId: target.server.id, path, deleted: true };
      } finally {
        lease.release();
      }
    });
  }

  /** Drops the pooled session bound to a terminal that closed or disconnected. */
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
    // The connection that produced these versions is gone. Keeping them would let a
    // reconnect with `strict` write against a file the caller read before the link dropped —
    // the exact assumption the guard exists to reject.
    this.clearObservations(`terminal:${terminalId}`);
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
    this.clearObservations(`server:${serverId}`);
  }

  dispose(): void {
    for (const subscription of this.terminalContextSubscriptions) {
      subscription.dispose();
    }
    this.terminalContextSubscriptions.length = 0;
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
    this.observations.clear();
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
        this.clearObservations(`terminal:${context.terminalId}`);
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
      this.clearObservations(`server:${serverId}`);
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

  /** The connection a version belongs to: a terminal session or a pooled background one. */
  private scopeFor(target: SftpTarget, lease: SessionLease): string {
    return target.terminalId === undefined ? lease.rootKey : `terminal:${target.terminalId}`;
  }

  private observe(target: SftpTarget, lease: SessionLease, path: string, stat: SftpFileStat): void {
    if (!Number.isFinite(stat.size) || !Number.isFinite(stat.modifiedAt)) {
      return;
    }
    const scope = this.scopeFor(target, lease);
    let files = this.observations.get(scope);
    if (files === undefined) {
      files = new Map();
      this.observations.set(scope, files);
    }
    files.set(observationKey(target.server.id, path), { size: stat.size, modifiedAt: stat.modifiedAt });
  }

  private observationFor(target: SftpTarget, lease: SessionLease, path: string): SftpFileVersion | undefined {
    return this.observations.get(this.scopeFor(target, lease))?.get(observationKey(target.server.id, path));
  }

  private forgetObservation(target: SftpTarget, lease: SessionLease, path: string): void {
    const scope = this.scopeFor(target, lease);
    const files = this.observations.get(scope);
    if (files === undefined) {
      return;
    }
    files.delete(observationKey(target.server.id, path));
    if (files.size === 0) {
      this.observations.delete(scope);
    }
  }

  private clearObservations(scope: string): void {
    this.observations.delete(scope);
  }

  /**
   * Refuse a write of an existing file when the caller's version information disagrees with
   * the server, or when `strict` has no read to compare against.
   *
   * `expectedSize` / `expectedModifiedAt` are compared only when supplied. `strict` also
   * compares the stored observation even when the caller passed no expected values — that is
   * the whole point of requiring a read; `observe` deliberately does not, because it must not
   * change the behaviour of a caller that never opted into passing a version.
   *
   * A missing `current` means the file does not exist. Creating a new file needs no prior
   * read; replacing an observed file that has since disappeared does, because the bytes the
   * caller planned to overwrite are gone and the path may now be something else.
   */
  private async assertVersionAllowsWrite(
    target: SftpTarget,
    lease: SessionLease,
    path: string,
    input: SftpExpectedVersion,
    current: SftpFileStat | undefined
  ): Promise<void> {
    const guard = resolveWriteGuard(input.sftpWriteGuard);
    if (guard === 'off') {
      return;
    }
    const observed = this.observationFor(target, lease, path);
    if (current === undefined) {
      // A caller that carried a version expected a file to be there. Its disappearance is a
      // change like any other, and creating a new file is not an overwrite.
      if (input.expectedSize !== undefined || input.expectedModifiedAt !== undefined) {
        throw new SftpStaleVersionError(path, {
          size: input.expectedSize,
          modifiedAt: input.expectedModifiedAt
        });
      }
      if (guard === 'strict' && observed !== undefined) {
        throw new SftpStaleVersionError(path, observed);
      }
      return;
    }
    if (input.expectedSize !== undefined && current.size !== input.expectedSize) {
      throw new SftpStaleVersionError(
        path,
        { size: input.expectedSize, modifiedAt: input.expectedModifiedAt },
        { size: current.size, modifiedAt: current.modifiedAt }
      );
    }
    if (input.expectedModifiedAt !== undefined && current.modifiedAt !== input.expectedModifiedAt) {
      throw new SftpStaleVersionError(
        path,
        { size: input.expectedSize, modifiedAt: input.expectedModifiedAt },
        { size: current.size, modifiedAt: current.modifiedAt }
      );
    }
    if (guard !== 'strict') {
      return;
    }
    if (observed === undefined) {
      throw new SftpNotObservedError(path);
    }
    if (observed.size !== current.size || observed.modifiedAt !== current.modifiedAt) {
      throw new SftpStaleVersionError(path, observed, { size: current.size, modifiedAt: current.modifiedAt });
    }
  }

  /**
   * Record the post-write stat a later `strict` check will compare against.
   *
   * Best-effort on purpose: the write has already landed, so a stat that fails afterwards
   * must not turn a successful write into an apparent failure and invite a duplicate edit.
   * Dropping the observation is the honest fallback — the next strict write asks for a fresh
   * read instead of comparing against a version nobody could confirm.
   */
  private async observeAfterWrite(target: SftpTarget, lease: SessionLease, path: string): Promise<void> {
    try {
      const stat = await withTimeout(
        lease.session.stat(path),
        READ_TIMEOUT_MS,
        `Timed out reading metadata for ${path}.`
      );
      this.observe(target, lease, path, stat);
    } catch {
      this.forgetObservation(target, lease, path);
    }
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
  return (await statIfPresent(session, path)) !== undefined;
}

/** The file's stat, or `undefined` when the server says nothing is there. */
async function statIfPresent(session: AgentSftpSession, path: string): Promise<SftpFileStat | undefined> {
  try {
    return await session.stat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
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

/** Connection-and-path key for the observation map. NUL cannot appear in an SFTP path. */
function observationKey(serverId: string, path: string): string {
  return `${serverId}\0${path}`;
}

/** Validate the per-call guard mode; an absent or unknown value means the safe default. */
function resolveWriteGuard(value: SftpWriteGuard | undefined): SftpWriteGuard {
  return value === 'off' || value === 'strict' || value === 'observe' ? value : 'observe';
}

/** Whether this call has any version question to ask before it touches the remote file. */
function needsVersionCheck(input: SftpExpectedVersion): boolean {
  if (resolveWriteGuard(input.sftpWriteGuard) === 'off') {
    return false;
  }
  return input.expectedSize !== undefined || input.expectedModifiedAt !== undefined || resolveWriteGuard(input.sftpWriteGuard) === 'strict';
}

/** The file's line-ending convention, using the same tie-break as the in-panel editor. */
function detectEol(bytes: Buffer): 'lf' | 'crlf' {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1;
    else lf += 1;
  }
  return crlf > 0 && crlf >= lf ? 'crlf' : 'lf';
}

/** Model-supplied text may carry CRLF; matching and reconstruction are both LF-based. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Non-overlapping literal occurrence count — the same count `split`/`join` would replace. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const found = haystack.indexOf(needle);
  return found === -1 ? haystack : haystack.slice(0, found) + replacement + haystack.slice(found + needle.length);
}

function tooLargeToEditMessage(size: number): string {
  return (
    `Remote file is ${formatFileSize(size)}, over the ${formatFileSize(SFTP_EDIT_MAX_BYTES)}-byte limit for remote edit. ` +
    'Use at_terminal_sftp_read_file with offset/limit to inspect it, or change it with a command on the server.'
  );
}

function tooLargeToPatchMessage(size: number): string {
  return (
    `Remote file is ${formatFileSize(size)}, over the ${formatFileSize(SFTP_EDIT_MAX_BYTES)}-byte limit for remote patch. ` +
    'Split the change or use a command on the server for a file this large.'
  );
}

/** Normalize an LF result back to the source file's line-ending convention. */
function restorePatchEol(text: string, eol: 'lf' | 'crlf'): string {
  return eol === 'lf' ? text : text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stable, compact code for a preflight refusal. */
function patchRefusalCode(error: unknown): string {
  if (error instanceof SftpStaleVersionError) return 'sftp-stale-version';
  if (error instanceof SftpNotObservedError) return 'sftp-not-observed';
  const message = errorMessage(error);
  if (message.includes('appears to be binary')) return 'sftp-patch-binary';
  if (message.includes('limit for remote patch')) return 'sftp-patch-too-large';
  if (message.includes('escapes the base directory')) return 'sftp-patch-path-escape';
  if (message.includes('not a regular file')) return 'sftp-patch-not-regular-file';
  if (message.includes('not found')) return 'sftp-patch-not-found';
  return 'sftp-patch-failed';
}

/** How a failure during commit should be reported: a known failure vs. an unknown outcome. */
function patchCommitFailure(
  error: unknown,
  started: boolean
): { unknown: boolean; code: string; message: string } {
  const message = errorMessage(error);
  if (error instanceof SftpStaleVersionError) {
    return { unknown: false, code: 'sftp-stale-version', message };
  }
  if (error instanceof SftpNotObservedError) {
    return { unknown: false, code: 'sftp-not-observed', message };
  }
  // A timed-out write/delete/rename may have partially happened on the server. Reporting
  // `failed` would invite a blind retry; `unknown` tells the caller to re-read first.
  if (started && /^Timed out (?:writing|creating|deleting|renaming)/.test(message)) {
    return {
      unknown: true,
      code: 'sftp-patch-unknown',
      message: `${message} — re-read the affected files before retrying.`
    };
  }
  return { unknown: false, code: patchRefusalCode(error), message };
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
  // Version guard failures are decisions, not transport errors: the caller has a concrete
  // recovery (`re-read`), and an audit that lumps them under `error` hides that from review.
  if (message.includes('file has not been read')) {
    return 'not_observed';
  }
  if (message.includes('changed since it was read')) {
    return 'stale_version';
  }
  if (message.startsWith('Found 0 occurrences') || message.includes('pass replaceAll or provide a longer match')) {
    return 'edit_match_failed';
  }
  if (message.includes('appears to be binary')) {
    return 'binary_file';
  }
  if (message.includes('limit for remote edit')) {
    return 'file_too_large';
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
