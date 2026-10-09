import { ConfigManager } from '../../config/ConfigManager';
import type { ServerConfig } from '../../config/schema';
import type { Platform } from '../../core/ports';
import { HostKeyStore } from '../../ssh/HostKeyStore';
import type { HostKeyVerifier } from '../../ssh/SshConnectionConfig';
import { safePreviewName } from '../../sftp/RemotePath';
import { SftpManager, type SftpSessionLike } from '../../sftp/SftpManager';
import { SftpSession } from '../../sftp/SftpSession';
import type { SftpEntry, SftpFileStat } from '../../sftp/SftpTypes';
import type { TerminalContext } from '../../terminal/TerminalContext';
import { classifySshFailure } from './sshFailure';
import type { DshTerminalObserver, DshTerminalPresence } from './services';

/**
 * The SFTP face the dsh panels drive — DSH-16's third service, after the server records and
 * the terminal sessions.
 *
 * It is a **composition over `SftpManager`**, not a second implementation of it. That
 * manager already owns the three things this milestone actually needs:
 *
 * - the root resolution (`realpath('.')`, so the tree opens where the user's shell opens)
 *   and a listing cache with explicit invalidation;
 * - the `none | active | disconnected` state machine — the distinction DSH-23's DoD calls
 *   out ("断开态呈现明确，不谎报「无活动终端」");
 * - one SFTP connection per terminal, invalidated when that terminal disconnects.
 *
 * Re-deriving any of it here would make the two platforms' trees disagree about what an
 * SFTP view is, which is exactly the drift the VS Code variant's frontend reuse was chosen
 * to avoid.
 *
 * ## Two facts this file exists to absorb
 *
 * **1. A rejected `verify()` loses its reason.** `createHostVerifier`
 * (`src/ssh/SshConnectionConfig.ts:187-192`) does `.then(verify, () => verify(false))`, so a
 * verifier that *throws* — the natural way to report "this host key is unknown" from a
 * request/response surface — arrives at ssh2 as a bare `Host denied (verification failed)`.
 * The terminal path solves this with `emit` (an event frame the panel reads); a unary RPC
 * has no frame to push, so this face **records** the refusal and consults it when the
 * operation fails. One slot is enough: it is cleared at the start of every operation that
 * can open a connection, so what is read back is always this attempt's.
 *
 * **2. There is no "focused terminal" here.** The VS Code variant's tree follows the
 * focused terminal and re-syncs from a registry that is the source of truth. dsh has one
 * panel, so the honest analogue is "the terminal the user most recently opened that is
 * still live", and the Host half tells this service about exactly that (it owns the
 * terminals). The tree therefore always prefers a live terminal, and only falls back to
 * the `disconnected` view — the last listing, frozen — when **no** terminal is live. It never
 * prefers a dead terminal over a live one, because a stale tree under a live terminal is
 * precisely the lie the DoD forbids.
 *
 * ## The four transfer operations
 *
 * `readFile` / `writeFile` / `download` / `upload` are the write half of this face, and
 * they answer a different question than `list` does. A listing may be served from memory
 * when the terminal is gone ("this is what it last saw"); **bytes cannot be**, so every one
 * of them refuses with `sftp-disconnected` or `no-active-terminal` rather than pretending.
 *
 * Three limits are deliberate and are stated to the caller rather than silently applied:
 *
 * - a **text** file is refused above {@link SFTP_TEXT_MAX_BYTES} (or truncated for a read
 *   with `truncated: true`), because an editor holding half a file is worse than an editor
 *   that says it will not open it;
 * - a **transfer** is refused above {@link SFTP_TRANSFER_MAX_BYTES}, because both
 *   directions travel inside one JSON RPC and the channel caps a request body at 8 MiB —
 *   base64 inflates by 4/3, so the byte budget is the cap divided by that, not the cap;
 * - a **binary** file is refused by `readFile` with `sftp-binary-file`. The payload would
 *   decode into replacement characters and a save would write those back, corrupting the
 *   file. `download` is the operation for it, and the refusal says so.
 *
 * Conflicts are checked **on the server's own stat**, not on the listing: the editor sends
 * back the size and mtime it opened the file with, and a mismatch is `sftp-conflict` rather
 * than a silent overwrite. That is the same rule `SftpEditSessionManager` applies in the
 * VS Code variant (`uploadIfUnchanged`) — one definition of "somebody else changed this".
 *
 * ## What is deliberately still absent
 *
 * Rename, delete, `mkdir` and "new file". `SftpManager` has all four, so this is a scope
 * decision rather than a capability gap: each needs its own confirmation shape (a recursive
 * delete needs the entry count first, a rename needs a name prompt), and shipping a control
 * whose confirmation is missing is the defect this file's sibling modules keep warning
 * about. The UI the panel ships shows exactly the operations this face can finish.
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * What the tree is rendering, plus the listing.
 *
 * `kind` is `SftpTreeState`'s own vocabulary, carried across the wire unchanged so the
 * browser half branches on the same three cases the VS Code tree does.
 */
export interface DshSftpListing {
  kind: 'none' | 'active' | 'disconnected';
  /** The tree's top directory, once one has been resolved. */
  rootPath: string | null;
  /** The directory these entries came from. Equals `rootPath` for a root listing. */
  path: string | null;
  entries: SftpEntry[];
  serverId: string | null;
  serverLabel: string | null;
}

/**
 * Which terminal a read is about.
 *
 * Every read names one, because with several tabs open there is no longer a single answer:
 * these calls arrive over HTTP, so nothing in the request identifies the caller, and "the
 * terminal that most recently connected" would show one tab another tab's directory. The
 * browser learned its id from the `terminal.opened` frame of its own socket.
 *
 * Optional, and that is deliberate — an older caller that names nothing still works, falling
 * back to the newest live session exactly as this face behaved when it was the only one.
 */
export interface SftpTerminalScope {
  terminalId?: string;
}

export interface DshSftpApi extends DshTerminalObserver {
  /**
   * List a directory.
   *
   * No `path` (or the root itself) reports the tree's state and its entries — the one read
   * that works without a live connection, because a disconnected tree still shows what it
   * last saw. A path **below** the root needs a live connection to read; asking for one
   * over a dead terminal is an error rather than an empty list, since "this directory is
   * empty" and "this directory cannot be read right now" must not look the same.
   */
  list(request?: SftpTerminalScope & { path?: string }): Promise<DshSftpListing>;
  /** Move the tree's root up one level. Needs a live connection. */
  goUp(request?: SftpTerminalScope): Promise<DshSftpListing>;
  /** Drop every cached listing, so the next read reaches the server. */
  refresh(request?: SftpTerminalScope): Promise<{ refreshed: true }>;

  /**
   * Read one file as text, for the viewer and the editor.
   *
   * Refuses a directory (`sftp-not-a-file`) and a binary file (`sftp-binary-file`); a file
   * longer than the cap comes back cut, with `truncated: true`, so the caller can decide
   * whether a truncated view is worth showing — the editor must not, and the viewer may.
   */
  readFile(request: SftpTerminalScope & { path: string; maxBytes?: number }): Promise<DshSftpFileText>;

  /**
   * Replace one file's contents with `text`.
   *
   * `text` is LF-only, as `readFile` produced it; `eol` is the convention that read
   * reported, and the bytes written use it. Passing the wrong one (or none) converts the
   * file's line endings — which is exactly the silent edit this parameter exists to
   * prevent.
   *
   * `expectedSize` / `expectedModifiedAt` are the stat the caller last saw. When both are
   * supplied and the server disagrees, the write is refused with `sftp-conflict` unless
   * `overwrite` is set — the only guard against two people editing one file.
   */
  writeFile(
    request: SftpTerminalScope & {
      path: string;
      text: string;
      eol?: 'lf' | 'crlf';
      expectedSize?: number;
      expectedModifiedAt?: number;
      overwrite?: boolean;
    }
  ): Promise<DshSftpWriteResult>;

  /** Move one file's bytes to the caller, base64-encoded. */
  download(request: SftpTerminalScope & { path: string }): Promise<DshSftpFileBytes>;

  /**
   * Write bytes the caller holds to one remote path.
   *
   * An existing destination is `sftp-conflict` unless `overwrite` is set: an upload is a
   * whole-file replacement, and clobbering a file the user did not name is not a thing a
   * panel gets to do quietly.
   */
  upload(
    request: SftpTerminalScope & { path: string; base64: string; overwrite?: boolean }
  ): Promise<DshSftpWriteResult>;

  /** Create an empty file at one remote path. */
  createFile(request: SftpTerminalScope & { path: string }): Promise<{ created: true; path: string }>;

  /** Delete a file or directory at one remote path. */
  delete(request: SftpTerminalScope & { path: string }): Promise<{ deleted: true; path: string }>;

  /** Release the manager and every SFTP connection it holds. Idempotent. */
  dispose(): void;
}

/** One file's text, as the viewer and the editor both receive it. */
export interface DshSftpFileText {
  path: string;
  /**
   * The file's text, **always with `\n` line endings**.
   *
   * Normalised on the way out, and `eol` says how to put it back. The reason is not
   * tidiness: `HTMLTextAreaElement.value` normalises every line ending to `\n` by
   * specification, so a `\r\n` file round-tripped through the editor would be silently
   * rewritten as LF on save — every line changed, in a diff the user never asked for.
   * Carrying the convention as data is the only way the save can undo that.
   */
  text: string;
  /** The line ending the file used; `writeFile` restores it. */
  eol: 'lf' | 'crlf';
  /** The file's real size on the server, **not** `text.length` — see `truncated`. */
  size: number;
  modifiedAt: number;
  /** The file is longer than the cap; `text` holds only its leading bytes. */
  truncated: boolean;
}

/** One file's bytes on their way to the browser. */
export interface DshSftpFileBytes {
  path: string;
  /** A name usable as a local filename — the same sanitising the VS Code preview uses. */
  name: string;
  size: number;
  modifiedAt: number;
  base64: string;
}

/** What a write leaves behind, so the caller can update its conflict baseline. */
export interface DshSftpWriteResult {
  path: string;
  size: number;
  modifiedAt: number;
}

/**
 * Largest file the text operations will touch.
 *
 * 2 MiB, which is not a number picked here: it is the default page the **installed
 * Harness's own** file provider renders (`dsh-client-ui-sidebar-documentpreview`'s
 * `file-provider`, `maxBytes: 2097152`, 5000 lines per page). Matching it means a remote
 * file and a local one hit the "too big to show" wall in the same place, so a user who has
 * learned one panel has learned the other. It is also far past the point where a
 * `<textarea>` is a reasonable editing surface.
 */
export const SFTP_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How much of a file is sampled to decide whether it is text.
 *
 * 8192 bytes, the same window the installed Harness uses for its own binary check
 * (`dsh-client-ui-sidebar-documentpreview`'s `DshBinary`). Sampling rather than scanning
 * the whole payload keeps the decision O(1) in file size, and 8 KiB is well past where
 * every common format declares itself — ELF, PNG, gzip, sqlite and a `.class` file all
 * carry a NUL in their first bytes.
 */
const BINARY_SAMPLE_BYTES = 8192;

/**
 * Largest file the byte operations will move in one call.
 *
 * 256 MiB. The previous 4 MiB was a conservative initial value that blocked realistic
 * binary packages and archives (e.g. maven, tar.gz, archives). 256 MiB allows full in-panel
 * download and upload with real-time transfer progress while bounding memory. Larger transfers
 * are directed to the Terminal page (scp or rsync).
 */
export const SFTP_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;

/**
 * How a session is created for one terminal.
 *
 * The verifier is handed over because it is the part of this face a fake session has to be
 * able to exercise: production passes it straight into `SftpSession`, and a test's fake
 * calls it to prove what a refusal is reported as.
 */
export type DshSftpSessionFactory = (
  context: TerminalContext,
  verifier: HostKeyVerifier
) => SftpSessionLike;

export interface DshSftpApiOptions {
  readonly platform: Platform;
  /**
   * Substitute the SFTP session factory.
   *
   * Production passes nothing and gets a real `SftpSession` over `ssh2`. Tests pass a fake
   * so the state machine — which terminal is followed, what a disconnected tree shows,
   * which failures are coded — can be driven without an SSH server, exactly as the server
   * face takes an injectable id generator for the same reason.
   */
  readonly createSession?: DshSftpSessionFactory;
}

/** Codes this face throws. The browser half has copy for each. */
export const SFTP_ERROR_NO_ACTIVE_TERMINAL = 'no-active-terminal';
export const SFTP_ERROR_DISCONNECTED = 'sftp-disconnected';
export const SFTP_ERROR_READ_FAILED = 'sftp-read-failed';
export const SFTP_ERROR_NO_SUCH_FILE = 'sftp-no-such-file';
export const SFTP_ERROR_PERMISSION_DENIED = 'sftp-permission-denied';
export const SFTP_ERROR_WRITE_FAILED = 'sftp-write-failed';
export const SFTP_ERROR_NOT_A_FILE = 'sftp-not-a-file';
export const SFTP_ERROR_FILE_TOO_LARGE = 'sftp-file-too-large';
export const SFTP_ERROR_BINARY_FILE = 'sftp-binary-file';
export const SFTP_ERROR_CONFLICT = 'sftp-conflict';
export const SFTP_ERROR_BAD_PARAMS = 'sftp-bad-params';

/**
 * The prefix every code above shares.
 *
 * `translate` uses it to recognise a failure this face raised **itself** and to pass it
 * through untouched: a directory where a file was expected, a binary payload, a refused
 * overwrite all arrive here already carrying a sentence written at the point the fact was
 * known, and re-classifying them would replace the useful half with ssh2's.
 * `no-active-terminal` is the one exception — it predates the prefix and is never thrown
 * from inside a `try`, so it never reaches the translator either.
 */
const SFTP_ERROR_PREFIX = 'sftp-';

/** `ssh2/lib/protocol/SFTP.js`'s `STATUS_CODE`, the two that have distinct remedies. */
const SFTP_STATUS_NO_SUCH_FILE = 2;
const SFTP_STATUS_PERMISSION_DENIED = 3;

/** A failure already classified, in the shape `channel.js` turns into `{code, message}`. */
interface CodedError extends Error {
  code: string;
  fingerprint?: string;
}

function coded(code: string, message: string, fingerprint?: string): CodedError {
  return Object.assign(new Error(message), fingerprint === undefined ? { code } : { code, fingerprint });
}

/**
 * Whether a failure came from **opening** the connection rather than from the operation.
 *
 * `classifySshFailure` speaks about connects only: to it, `ENOENT` means "the private key
 * file is missing". An SFTP operation fails with a different animal — a protocol status
 * error, which ssh2 gives a **numeric** `code` (`SFTP.js` tests `er.code === STATUS_CODE.EOF`)
 * and renders as `No such file or directory` / `Permission denied`. Every connect-phase
 * failure, by contrast, carries either a Node transport code or ssh2's `level`, and both of
 * those are strings.
 *
 * Running a read failure through the connect classifier reported an unreadable directory as
 * "the private key could not be read" — sending the user to edit a key path that is fine.
 */
function isConnectFailure(error: unknown): boolean {
  const candidate = (error ?? undefined) as { code?: unknown; level?: unknown } | undefined;
  return typeof candidate?.level === 'string' || typeof candidate?.code === 'string';
}

// ---------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------

export function createDshSftpApi({ platform, createSession }: DshSftpApiOptions): DshSftpApi {
  const configManager = new ConfigManager(platform.state, platform.secrets);
  const hostKeyStore = new HostKeyStore(platform.state);

  /**
   * The host key this attempt's handshake refused, if it refused one.
   *
   * See the file comment: `createHostVerifier` converts a rejected `verify` into
   * `verify(false)`, so ssh2 reports the refusal as the generic
   * `Host denied (verification failed)` and the fingerprint — the one thing the user needs
   * to act on — would be gone.
   */
  let refusal: { code: string; fingerprint: string } | undefined;

  const verifier: HostKeyVerifier = {
    async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
      const status = await hostKeyStore.check(host, port, fingerprint);
      if (status === 'trusted') return true;
      // Same policy as the terminal face: never trust silently. The difference is only in
      // how the refusal travels back — an event frame there, this slot here.
      refusal = { code: status === 'changed' ? 'host-key-changed' : 'host-key-unknown', fingerprint };
      return false;
    }
  };

  const manager = new SftpManager({
    createSession: (terminal) =>
      (createSession ??
        ((context: TerminalContext, trust: HostKeyVerifier) =>
          // `allowSudoFallback: false`: this surface reads directories and nothing else, and
          // the flag only widens *writes* to `sudo -n`. Enabling it now would pre-authorise
          // an escalation no code path here can reach.
          new SftpSession(context.server, configManager, trust, { allowSudoFallback: false })))(
        terminal,
        verifier
      ),
    reporter: platform.transfers
  });

  /**
   * Every terminal the Host half has announced, with whether it is still live.
   *
   * Closed terminals stay in the map rather than being deleted: the tree keeps showing what
   * the dead one last saw, and the status bar still needs to name the server it belonged to.
   */
  const tracked = new Map<string, { presence: DshTerminalPresence; connected: boolean }>();
  /** The terminal the tree is currently following. */
  let followedId: string | undefined;

  function liveTerminal(): DshTerminalPresence | undefined {
    let newest: DshTerminalPresence | undefined;
    for (const entry of tracked.values()) {
      if (entry.connected) newest = entry.presence;
    }
    return newest;
  }

  function followed(): { presence: DshTerminalPresence; connected: boolean } | undefined {
    return followedId === undefined ? undefined : tracked.get(followedId);
  }

  /**
   * Point the manager at **the terminal the caller named**, or the newest live one when it
   * named none.
   *
   * The named case is what makes several tabs work. These reads arrive over HTTP, so nothing
   * about the request says which tab asked — the browser has to name the terminal it means,
   * and it learned that id from the `terminal.opened` frame of its own socket. Without it
   * this function kept guessing "newest live", which with one terminal was a safe default
   * and with two is a coin toss: tab A's file tree would answer with tab B's directory.
   *
   * The fallback stays for a caller that names nothing (an older client, or a read issued
   * before the socket opened), because refusing outright would break the single-terminal case
   * this face shipped with.
   *
   * A `disconnected` state deliberately does **not** block adoption: the only way to leave
   * the stale tree on screen while another terminal is live is to make the user's terminal
   * unreachable, and `SftpManager` keeps the stale snapshot per terminal anyway — so coming
   * back to a dead-but-previously-followed terminal still renders it.
   */
  function followTerminal(requestedId?: string): void {
    const named =
      typeof requestedId === 'string' && requestedId !== '' ? tracked.get(requestedId) : undefined;
    const target = named ?? (() => {
      const newest = liveTerminal();
      return newest === undefined ? undefined : tracked.get(newest.terminalId);
    })();
    if (target === undefined) return;
    if (target.presence.terminalId === followedId) return;
    followedId = target.presence.terminalId;
    manager.setTerminalContext(contextOf(target.presence, target.connected));
  }

  function contextOf(presence: DshTerminalPresence, connected = true): TerminalContext {
    return {
      terminalId: presence.terminalId,
      server: presence.server,
      connected,
      // Read by nothing on the SFTP path (`SftpManager` only reads `terminalId`,
      // `connected` and `server`), but it is the session's own writer rather than a stub:
      // inventing a no-op here would be the fake adapter the port layer refuses.
      write: (data: string) => presence.write(data)
    };
  }

  function label(): { serverId: string | null; serverLabel: string | null } {
    const entry = followed();
    return entry === undefined
      ? { serverId: null, serverLabel: null }
      : { serverId: entry.presence.server.id, serverLabel: entry.presence.server.label };
  }

  function listing(
    kind: DshSftpListing['kind'],
    rootPath: string | null,
    path: string | null,
    entries: SftpEntry[]
  ): DshSftpListing {
    return { kind, rootPath, path, entries, ...label() };
  }

  /**
   * Turn whatever failed into the browser half's vocabulary, preferring a recorded refusal.
   *
   * Four kinds of failure reach here and they are kept apart on purpose: a failure **this
   * face raised itself** (already coded, passed straight through), a refused host key
   * (whose code and fingerprint were recorded during the handshake), a **connect** failure
   * (classified), and a **protocol** failure (a status the path and the verb explain better
   * than any classifier could).
   *
   * `verb` is what keeps the two protocol failures readable as the same code: "Permission
   * denied reading /root" sends the user to check a read path, while a *write* that the
   * server refused needs to say writing, because the remedy is the file's mode or the
   * account's group — the same code, a different sentence.
   */
  function translate(
    error: unknown,
    server: ServerConfig | undefined,
    path?: string,
    verb: 'read' | 'write' = 'read'
  ): CodedError {
    const recorded = refusal;
    refusal = undefined;
    if (recorded !== undefined) {
      const where = server === undefined ? 'the server' : `${server.host}:${server.port}`;
      return coded(
        recorded.code,
        recorded.code === 'host-key-changed'
          ? `The host key for ${where} does not match the one recorded earlier.`
          : `${where} is not a known host. Trust the host key from the terminal page, then reload.`,
        recorded.fingerprint
      );
    }
    // Our own codes, raised inside the same `try` this translator wraps. ssh2's protocol
    // statuses are **numeric**, so a string code that carries our prefix can only be ours.
    const own = ((error ?? undefined) as { code?: unknown }).code;
    if (typeof own === 'string' && own.startsWith(SFTP_ERROR_PREFIX)) return error as CodedError;

    const message = error instanceof Error ? error.message : String(error);
    if (isConnectFailure(error)) {
      // `SftpManager` throws a message-only error when there is no connected terminal; the
      // state check above is what normally catches that, and this is the race that slips
      // past it (the terminal dropped between the check and the read).
      const failure = classifySshFailure(error, server === undefined ? {} : { host: server.host, port: server.port });
      return coded(failure.code, failure.message);
    }
    const status = own;
    const at = path === undefined ? '' : ` ${path}`;
    if (status === SFTP_STATUS_NO_SUCH_FILE) {
      return coded(SFTP_ERROR_NO_SUCH_FILE, `No such file or directory:${at}`.trim() + '.');
    }
    if (status === SFTP_STATUS_PERMISSION_DENIED) {
      return coded(
        SFTP_ERROR_PERMISSION_DENIED,
        verb === 'write'
          ? `Permission denied writing${at}. The SFTP panel never escalates privileges, so check the file's mode or use an account that owns it.`
          : `Permission denied reading${at}.`
      );
    }
    return coded(
      verb === 'write' ? SFTP_ERROR_WRITE_FAILED : SFTP_ERROR_READ_FAILED,
      path === undefined ? message : `${message} (${verb === 'write' ? 'writing' : 'reading'} ${path})`
    );
  }

  async function readDirectory(path: string): Promise<SftpEntry[]> {
    refusal = undefined;
    const presence = followed();
    try {
      return await manager.listDirectory(path);
    } catch (error) {
      throw translate(error, presence?.presence.server, path);
    }
  }

  /**
   * Resolve the tree's root before the first listing.
   *
   * `SftpManager.getState()` answers `'.'` until `ensureRoot()` has run, which would make
   * the panel's status bar say `"."` and give the first read a cache key of `.` — so the
   * second read, now keyed by the resolved path, would miss the cache and re-list. Resolving
   * first costs one `realpath` and removes both.
   */
  async function ensureRoot(): Promise<void> {
    if (manager.getActiveViewDescriptor()?.rootPath !== undefined) return;
    refusal = undefined;
    const presence = followed();
    try {
      await manager.ensureRoot();
    } catch (error) {
      throw translate(error, presence?.presence.server);
    }
  }

  /* ---------------------------- transfer operations --------------------------- */

  /**
   * Point the manager at the caller's terminal and hand back its presence, or say why not.
   *
   * Every transfer calls this **first**, and it is what makes those four methods refuse
   * honestly: `list` can answer a dead tree from memory, but bytes cannot, so there is no
   * branch here that returns a stale answer. The two "no connection" codes stay apart
   * because their remedies differ — `no-active-terminal` means "connect something",
   * `sftp-disconnected` means "reconnect the server you were already on".
   */
  function requireLiveTerminal(requestedId?: string): DshTerminalPresence {
    followTerminal(requestedId);
    const entry = followed();
    const state = manager.getState();
    // `connected` lives on the **map entry**, not on the presence the Host half announced:
    // the presence is what it told us at open time and does not change, while the entry is
    // this face's own record of whether that terminal is still live.
    if (state.kind === 'active' && entry !== undefined && entry.connected) {
      return entry.presence;
    }
    if (state.kind === 'disconnected') {
      throw coded(
        SFTP_ERROR_DISCONNECTED,
        'The SSH terminal for this tree is no longer connected, so a file cannot be read or written.'
      );
    }
    throw coded(SFTP_ERROR_NO_ACTIVE_TERMINAL, 'No connected SSH terminal is active.');
  }

  /** A remote path a transfer can act on: absolute, non-empty, and never the empty string. */
  function requiredRemotePath(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw coded(SFTP_ERROR_BAD_PARAMS, 'a non-empty remote path is required');
    }
    return value;
  }

  /**
   * `stat`, where "there is nothing there" is an answer rather than a failure.
   *
   * The distinction is load-bearing for an upload: `sftp-no-such-file` is how a **free**
   * destination reports itself, and turning it into a thrown error would make every
   * first-time upload look like a failure. Only that one status is absorbed — a connection
   * error or a permission failure must still surface, or `stat` would silently claim the
   * path is free and the write would fail somewhere with a worse message.
   */
  async function statIfPresent(path: string): Promise<SftpFileStat | undefined> {
    try {
      return await manager.stat(path);
    } catch (error) {
      if (((error ?? undefined) as { code?: unknown }).code === SFTP_STATUS_NO_SUCH_FILE) return undefined;
      throw error;
    }
  }

  /**
   * Whether bytes are text.
   *
   * A NUL byte in the first {@link BINARY_SAMPLE_BYTES} is the signal, and it is the right
   * one: every text encoding a shell hands us — UTF-8, ASCII, the single-byte Latin and GBK
   * families — leaves `0x00` unused, while the binary formats an SFTP user actually meets
   * carry one almost immediately. A UTF-16 file is the deliberate casualty: it is full of
   * NULs and gets refused here rather than being read as mojibake and written back as
   * garbage. The refusal says what to do instead.
   */
  function looksBinary(bytes: Buffer): boolean {
    const sample = Math.min(bytes.length, BINARY_SAMPLE_BYTES);
    for (let index = 0; index < sample; index += 1) {
      if (bytes[index] === 0) return true;
    }
    return false;
  }

  /**
   * Which line ending this text uses.
   *
   * The majority wins, so a file that is mostly CRLF with a stray LF keeps its convention
   * instead of flipping on save. Ties go to CRLF (a lone `\r\n` in an otherwise LF file is
   * the case where the editor's own normalisation would be most destructive). A file with
   * no line ending at all is `lf`, which is what `writeFile` would then write.
   *
   * Mixed endings are **not** preserved exactly — that would need a per-line record, and
   * Textual (a mature TUI editor) documents the same limitation. What is preserved is the
   * file's convention, which is the part a diff notices.
   */
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

  /** A size a caller may pass, clamped to the text cap and to a sane floor of one byte. */
  function clampTextLimit(value: unknown): number {
    if (!Number.isFinite(Number(value))) return SFTP_TEXT_MAX_BYTES;
    return Math.max(1, Math.min(SFTP_TEXT_MAX_BYTES, Math.floor(Number(value))));
  }

  /** Run one transfer, translating whatever it threw with the verb that describes it. */
  async function runTransfer<T>(
    requestedId: string | undefined,
    verb: 'read' | 'write',
    path: string | undefined,
    job: (presence: DshTerminalPresence) => Promise<T>
  ): Promise<T> {
    const presence = requireLiveTerminal(requestedId);
    // Cleared *after* the state check, so a recorded refusal from a previous attempt cannot
    // be reported for an operation that never opened a connection.
    refusal = undefined;
    try {
      return await job(presence);
    } catch (error) {
      throw translate(error, presence.server, path, verb);
    }
  }

  return {
    /* ------------------------- DshTerminalObserver ------------------------- */

    opened(presence: DshTerminalPresence): void {
      tracked.set(presence.terminalId, { presence, connected: true });
      // Do not adopt here: `list` adopts, and adopting on open would make the tree jump the
      // moment a terminal connects even if the user is looking at another one.
    },

    closed(terminalId: string): void {
      const entry = tracked.get(terminalId);
      if (entry === undefined) return;
      entry.connected = false;
      // Tells the manager this terminal is gone: it disposes the SFTP connection but keeps
      // the last `rootPath`/listing as the snapshot a `disconnected` tree renders. The
      // active-terminal pointer is deliberately **not** cleared — clearing it would drop
      // that snapshot and report `none`, which is the "no active terminal" lie the DoD
      // forbids when a tree has just been on screen.
      manager.syncTerminalContext(contextOf(entry.presence, false));
    },

    /* -------------------------------- reads -------------------------------- */

    async list(request: { path?: string; terminalId?: string } = {}): Promise<DshSftpListing> {
      followTerminal(request.terminalId);
      const requested = typeof request.path === 'string' && request.path !== '' ? request.path : undefined;
      const state = manager.getState();

      if (state.kind === 'none') {
        return listing('none', null, null, []);
      }

      if (state.kind === 'disconnected') {
        if (requested !== undefined && requested !== state.rootPath) {
          // The last listing is all this tree has; children of a subdirectory were never
          // read, and reporting them as empty would claim a directory is empty when the
          // truth is that nobody can look.
          throw coded(
            SFTP_ERROR_DISCONNECTED,
            `The SSH terminal for this tree is no longer connected, so ${requested} cannot be read.`
          );
        }
        return listing('disconnected', state.rootPath, state.rootPath, state.entries);
      }

      await ensureRoot();
      const resolved = manager.getState();
      if (resolved.kind !== 'active') {
        // The terminal dropped while the root was being resolved. Reporting that state is
        // the honest answer; the next read picks up whatever the user reconnects.
        return resolved.kind === 'disconnected'
          ? listing('disconnected', resolved.rootPath, resolved.rootPath, resolved.entries)
          : listing('none', null, null, []);
      }
      const path = requested ?? resolved.rootPath;
      const entries = await readDirectory(path);
      return listing('active', resolved.rootPath, path, entries);
    },

    async goUp(request: { terminalId?: string } = {}): Promise<DshSftpListing> {
      followTerminal(request.terminalId);
      if (manager.getState().kind === 'active' && manager.getActiveViewDescriptor()?.rootPath === undefined) {
        // Resolving the root is what `goUp` needs before it can walk to the parent; without
        // it `changeToParentDirectory` would be walking up from the `'.'` placeholder.
        await ensureRoot();
      }
      const state = manager.getState();
      const presence = followed();
      if (state.kind !== 'active' || presence === undefined) {
        throw coded(SFTP_ERROR_NO_ACTIVE_TERMINAL, 'No connected SSH terminal is active.');
      }
      refusal = undefined;
      let rootPath: string;
      try {
        rootPath = await manager.changeToParentDirectory();
      } catch (error) {
        throw translate(error, presence.presence.server);
      }
      const entries = await readDirectory(rootPath);
      return listing('active', rootPath, rootPath, entries);
    },

    async refresh(request: { terminalId?: string } = {}): Promise<{ refreshed: true }> {
      // Adopted so 刷新 in a background tab invalidates **that tab's** listing rather than
      // whichever one the manager happened to be following.
      followTerminal(request.terminalId);
      // Deliberately cache-only: refresh is "do not serve me the 20s TTL cache", not "open a
      // connection". A tree with no terminal can still be refreshed, and the next read says
      // why there is nothing to show.
      manager.invalidateAllListings();
      return { refreshed: true };
    },

    /* ------------------------------ transfer ops ------------------------------ */

    async readFile(request: { path: string; terminalId?: string; maxBytes?: number }): Promise<DshSftpFileText> {
      const path = requiredRemotePath(request?.path);
      const limit = clampTextLimit(request?.maxBytes);
      return await runTransfer(request?.terminalId, 'read', path, async () => {
        const stat = await manager.stat(path);
        if (stat.type === 'directory') {
          // Checked before any read: `open(dir, 'r')` fails with a protocol status that
          // carries no remedy, while this sentence names the actual situation.
          throw coded(SFTP_ERROR_NOT_A_FILE, `${path} is a directory, not a file.`);
        }
        const truncated = stat.size > limit;
        // Only the window that will be shown is fetched. Asking for `stat.size` bytes of a
        // 900 MiB log because the file is *text* would be the one way this cap could be
        // defeated.
        const bytes = await manager.readFile(path, truncated ? limit : stat.size);
        if (looksBinary(bytes)) {
          throw coded(
            SFTP_ERROR_BINARY_FILE,
            `${path} is not a text file, so it cannot be shown or edited here. Download it instead, or read it from the Terminal page.`
          );
        }
        return {
          path,
          // NUL-stripped of its `\r`s so the wire text is LF-only and the editor cannot be
          // tricked by a `\r` it will not reproduce (see `DshSftpFileText.text`).
          text: bytes.toString('utf8').replace(/\r\n/g, '\n'),
          eol: detectEol(bytes),
          size: stat.size,
          modifiedAt: stat.modifiedAt,
          truncated
        };
      });
    },

    async writeFile(request: {
      path: string;
      text: string;
      terminalId?: string;
      eol?: 'lf' | 'crlf';
      expectedSize?: number;
      expectedModifiedAt?: number;
      overwrite?: boolean;
    }): Promise<DshSftpWriteResult> {
      const path = requiredRemotePath(request?.path);
      if (typeof request?.text !== 'string') {
        throw coded(SFTP_ERROR_BAD_PARAMS, 'the text to write is required');
      }
      // The editor's buffer is LF-only by the time it gets here (a `<textarea>` guarantees
      // it), but a caller assembling the body by hand might not be — so `\r` is stripped
      // before the terminator is re-applied, which makes this idempotent instead of
      // producing `\r\r\n`.
      const lfText = request.text.replace(/\r\n/g, '\n');
      const encoded = request.eol === 'crlf' ? lfText.replace(/\n/g, '\r\n') : lfText;
      const content = Buffer.from(encoded, 'utf8');
      if (content.length > SFTP_TEXT_MAX_BYTES) {
        throw coded(
          SFTP_ERROR_FILE_TOO_LARGE,
          `The edited text is ${content.length} bytes, over the ${SFTP_TEXT_MAX_BYTES}-byte limit for an in-panel edit.`
        );
      }
      const expected =
        Number.isFinite(Number(request.expectedSize)) && Number.isFinite(Number(request.expectedModifiedAt))
          ? { size: Number(request.expectedSize), modifiedAt: Number(request.expectedModifiedAt) }
          : undefined;
      return await runTransfer(request?.terminalId, 'write', path, async () => {
        const current = await manager.stat(path);
        if (current.type === 'directory') {
          throw coded(SFTP_ERROR_NOT_A_FILE, `${path} is a directory, not a file.`);
        }
        // The conflict rule from `SftpEditSessionManager#uploadIfUnchanged`, restated for a
        // browser that has no document-save event to hang it on: the caller remembers the
        // stat it opened, and a server that disagrees means somebody else wrote the file.
        if (request.overwrite !== true && expected !== undefined) {
          if (current.size !== expected.size || current.modifiedAt !== expected.modifiedAt) {
            throw coded(
              SFTP_ERROR_CONFLICT,
              `${path} changed on the server since it was opened (${expected.size} bytes / ${expected.modifiedAt} then, ${current.size} bytes / ${current.modifiedAt} now). Overwrite it, or reload and redo the edit.`
            );
          }
        }
        await manager.writeFile(path, content);
        // Re-statted rather than assumed: this is the baseline the *next* save will be
        // checked against, and a server that rewrites through a temp file would otherwise
        // leave the editor comparing against a timestamp that no longer exists.
        const after = await manager.stat(path);
        return { path, size: after.size, modifiedAt: after.modifiedAt };
      });
    },

    async download(request: { path: string; terminalId?: string }): Promise<DshSftpFileBytes> {
      const path = requiredRemotePath(request?.path);
      return await runTransfer(request?.terminalId, 'read', path, async () => {
        const stat = await manager.stat(path);
        if (stat.type === 'directory') {
          throw coded(
            SFTP_ERROR_NOT_A_FILE,
            `${path} is a directory. Recursive download is not available in this panel yet — use the Terminal page (tar over ssh, or scp -r).`
          );
        }
        if (stat.size > SFTP_TRANSFER_MAX_BYTES) {
          throw coded(
            SFTP_ERROR_FILE_TOO_LARGE,
            `${path} is ${stat.size} bytes, over the ${SFTP_TRANSFER_MAX_BYTES}-byte transfer limit. Use the Terminal page (scp or rsync) for a file this large.`
          );
        }
        const bytes = await manager.readFile(path, SFTP_TRANSFER_MAX_BYTES);
        return {
          path,
          // The domain's own sanitiser, so a filename with a `:` or a newline cannot become
          // an invalid local name — the same rule the VS Code preview path follows.
          name: safePreviewName(path),
          size: bytes.length,
          modifiedAt: stat.modifiedAt,
          // Base64 for the same reason the PTY stream uses it: a JSON string cannot carry
          // arbitrary bytes, and a split multi-byte sequence is the obvious casualty.
          base64: bytes.toString('base64')
        };
      });
    },

    async upload(request: {
      path: string;
      base64: string;
      terminalId?: string;
      overwrite?: boolean;
    }): Promise<DshSftpWriteResult> {
      const path = requiredRemotePath(request?.path);
      if (typeof request?.base64 !== 'string' || request.base64 === '') {
        throw coded(SFTP_ERROR_BAD_PARAMS, 'the file content is required');
      }
      // Checked on the **encoded** length before decoding: a caller that sends a 400 MiB
      // body must be refused without the Host first allocating the buffer it decodes into.
      // The channel's own 8 MiB body cap would catch that anyway, but this is the limit the
      // message can explain.
      if (request.base64.length > Math.ceil(SFTP_TRANSFER_MAX_BYTES / 3) * 4 + 8) {
        throw coded(
          SFTP_ERROR_FILE_TOO_LARGE,
          `The upload is larger than the ${SFTP_TRANSFER_MAX_BYTES}-byte limit for this panel. Use the Terminal page (scp or rsync) instead.`
        );
      }
      const content = Buffer.from(request.base64, 'base64');
      if (content.length > SFTP_TRANSFER_MAX_BYTES) {
        throw coded(
          SFTP_ERROR_FILE_TOO_LARGE,
          `The upload is ${content.length} bytes, over the ${SFTP_TRANSFER_MAX_BYTES}-byte limit for this panel.`
        );
      }
      return await runTransfer(request?.terminalId, 'write', path, async () => {
        if (request.overwrite !== true) {
          const existing = await statIfPresent(path);
          if (existing !== undefined && existing.type === 'directory') {
            throw coded(SFTP_ERROR_NOT_A_FILE, `${path} is a directory, so a file cannot be written over it.`);
          }
          if (existing !== undefined) {
            // An upload is a whole-file replacement. The caller saw a tree that may be up to
            // 20 seconds old, so "the name looked free" is not evidence that it is.
            throw coded(
              SFTP_ERROR_CONFLICT,
              `${path} already exists on the server. Overwrite it, or upload under a different name.`
            );
          }
        }
        await manager.writeFile(path, content);
        const after = await manager.stat(path);
        return { path, size: after.size, modifiedAt: after.modifiedAt };
      });
    },

    async createFile(request: { path: string; terminalId?: string }): Promise<{ created: true; path: string }> {
      const path = requiredRemotePath(request?.path);
      return await runTransfer(request?.terminalId, 'write', path, async () => {
        const existing = await statIfPresent(path);
        if (existing !== undefined) {
          throw coded(
            SFTP_ERROR_CONFLICT,
            `${path} already exists on the server.`
          );
        }
        await manager.createFile(path);
        return { created: true, path };
      });
    },

    async delete(request: { path: string; terminalId?: string }): Promise<{ deleted: true; path: string }> {
      const path = requiredRemotePath(request?.path);
      return await runTransfer(request?.terminalId, 'write', path, async () => {
        const existing = await statIfPresent(path);
        if (existing === undefined) {
          throw coded(SFTP_ERROR_NO_SUCH_FILE, `No such file or directory: ${path}`);
        }
        const name = path.split('/').filter(Boolean).pop() || '';
        await manager.deleteEntry({ path, type: existing.type ?? 'file', name });
        return { deleted: true, path };
      });
    },

    dispose(): void {
      manager.dispose();
      tracked.clear();
      followedId = undefined;
    }
  };
}
