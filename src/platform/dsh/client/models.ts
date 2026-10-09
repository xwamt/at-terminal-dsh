/**
 * Pure logic of the dsh Client half: wire types, form model, list grouping and
 * the small helpers every view shares.
 *
 * Everything here is side-effect free except `saveDownload` (which the browser
 * drives) — that split is deliberate: these are the pieces the vitest suite can
 * exercise directly, without a DOM, a React shim or a socket.
 */

import { formatFileSize } from '../../../sftp/FileSize';
import { dirname, joinRemotePath } from '../../../sftp/RemotePath';

export { formatFileSize, dirname, joinRemotePath };

export type Translate = (key: string, args?: Record<string, unknown>) => string;

/** A failure the UI renders: the Host's `code`, its message, and an optional fingerprint. */
export interface Failure {
  code: string;
  message: string;
  fingerprint?: string;
}

/** A server exactly as the Host's redacted view sends it (never a password). */
export interface ServerView {
  id: string;
  label: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  hasPassword?: boolean;
  privateKeyPath?: string;
  privateKeyFileName?: string;
  jumpHostId?: string;
  encoding?: string;
  keepAliveInterval?: number;
  agentCommandTrust?: string;
  backgroundConnectionAllowed?: boolean;
}

export type TrustLevel = 'none' | 'policy' | 'full';

/** The form's working copy. Ports and numbers are strings, because that is what inputs hold. */
export interface FormModel {
  id: string;
  label: string;
  group: string;
  host: string;
  port: string;
  username: string;
  authType: string;
  password: string;
  privateKeyPath: string;
  jumpHostId: string;
  encoding: string;
  keepAliveInterval: string;
  agentCommandTrust: TrustLevel;
  backgroundConnectionAllowed: boolean;
}

/** An `Error` that also carries a machine-readable `code`, the way the Host sends it. */
export function rpcError(code: string | undefined, message: string | undefined): Error & { code: string } {
  const error = new Error(
    typeof message === 'string' && message !== '' ? message : 'channel rpc failed'
  ) as Error & { code: string };
  error.code = typeof code === 'string' && code !== '' ? code : 'rpc-error';
  return error;
}

/** Normalize anything thrown into the `{ code, message }` shape the UI renders. */
export function asFailure(error: unknown): Failure {
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'client-error',
    message: String(candidate?.message ?? error)
  };
}

/** Render a number that came off the wire, without letting `NaN` reach a label. */
export function count(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/** Render a string field, tolerating `undefined`/`null` from an older Host half. */
export function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Which copy explains which code. Anything unknown falls back to the generic line.
 *
 * The SSH codes come from `src/platform/dsh/sshFailure.ts` (a rejected credential, an
 * unreachable port, a missing key file). They exist because a real connect surfaced the
 * alternative: ssh2's own "All configured authentication methods failed" reached the
 * user verbatim, naming neither what was tried nor what to do about it.
 */
export function errorKey(code: string): string {
  if (code === 'bad-params') return 'error.badParams';
  if (code === 'wrong-password') return 'error.wrongPassword';
  if (code === 'unreadable-package') return 'error.unreadablePackage';
  if (code === 'host-key-unknown') return 'error.hostKeyUnknown';
  if (code === 'host-key-changed') return 'error.hostKeyChanged';
  if (code === 'authentication-failed') return 'error.authenticationFailed';
  if (code === 'password-missing') return 'error.passwordMissing';
  if (code === 'private-key-path-missing') return 'error.privateKeyPathMissing';
  if (code === 'private-key-unreadable') return 'error.privateKeyUnreadable';
  if (code === 'connection-refused') return 'error.connectionRefused';
  if (code === 'connection-timeout') return 'error.connectionTimeout';
  if (code === 'host-unresolved') return 'error.hostUnresolved';
  if (code === 'host-unreachable') return 'error.hostUnreachable';
  // The two states the file tree can be in without a live terminal. They are separate
  // entries because their remedies differ: one says "connect something", the other says
  // "reconnect the server you were already on".
  if (code === 'no-active-terminal') return 'error.noActiveTerminal';
  if (code === 'sftp-disconnected') return 'error.sftpDisconnected';
  // Read failures are kept apart from connect failures because their remedies are
  // different: one is "look at the path", the other is "look at the host".
  if (code === 'sftp-no-such-file') return 'error.sftpNoSuchFile';
  if (code === 'sftp-permission-denied') return 'error.sftpPermissionDenied';
  if (code === 'sftp-read-failed') return 'error.sftpReadFailed';
  // The transfer family. Every one of these is a *different* thing for the user to do, which
  // is the whole reason they are separate codes rather than one "it did not work":
  // re-encode, download instead, pick a smaller file, overwrite or reload, fix the mode.
  if (code === 'sftp-file-too-large') return 'error.sftpFileTooLarge';
  if (code === 'sftp-binary-file') return 'error.sftpBinaryFile';
  if (code === 'sftp-not-a-file') return 'error.sftpNotAFile';
  if (code === 'sftp-conflict') return 'error.sftpConflict';
  if (code === 'sftp-write-failed') return 'error.sftpWriteFailed';
  if (code === 'sftp-bad-params') return 'error.sftpBadParams';
  // The one code the browser half raises itself, before any RPC: a page whose
  // `FileReader`/`Blob` support is missing (or a file the picker could not read).
  if (code === 'no-file-reader') return 'error.noFileReader';
  return 'error.generic';
}

/**
 * Which copy explains **one level** of the file tree that could not be read.
 *
 * A separate namespace from `errorKey`, and deliberately different copy rather than a
 * reuse: the `error.sftp*` lines are written for a failure of *the page's* read ("refresh
 * and expand again", "check it from the Terminal page"), while this one is scoped to a
 * single directory sitting between two levels that read fine. Its whole job is to be
 * distinguishable from "this directory is empty" — so every variant opens by saying the
 * level was not read, and none of them offers whole-page advice.
 *
 * The codes are literals rather than imports from `src/platform/dsh/sftp.ts`: that module
 * pulls in the server-side config and credential store, and this half is bundled for a
 * browser. `errorKey` spells the same three the same way.
 */
export function sftpDirFailureKey(code: string): string {
  if (code === 'sftp-no-such-file') return 'sftp.dirFailedNoSuchFile';
  if (code === 'sftp-permission-denied') return 'sftp.dirFailedPermissionDenied';
  if (code === 'sftp-read-failed') return 'sftp.dirFailedReadFailed';
  // An unrecognised code still has to say *that* the level was not read. Falling through
  // to no line at all would leave a silent gap in the tree, which reads as "empty".
  return 'sftp.dirFailed';
}

/** How an `authType` reads in a list row. An unknown value is shown as it came. */
export function authLabel(t: Translate, authType: unknown): string {
  if (authType === 'password') return t('auth.password');
  if (authType === 'privateKey') return t('auth.privateKey');
  if (authType === 'agent') return t('auth.agent');
  return text(authType);
}

/** Read the list's servers, tolerating any shape an unrelated reply might have. */
export function serverViews(result: unknown): ServerView[] {
  const list = (result ?? {}) as { servers?: unknown };
  if (!Array.isArray(list.servers)) return [];
  return list.servers.filter(
    (server): server is ServerView => server !== null && typeof server === 'object'
  );
}

export interface ServerGroup {
  name: string | null;
  servers: ServerView[];
}

/**
 * Group server views the way the list shows them: named groups in the order the
 * Host sorted them, and the records with no group last — where a user looks for
 * the ones they have not organised yet.
 */
export function groupServers(servers: ServerView[]): ServerGroup[] {
  const named = new Map<string, ServerView[]>();
  const ungrouped: ServerView[] = [];
  for (const server of servers) {
    const name = typeof server.group === 'string' && server.group !== '' ? server.group : null;
    if (name === null) {
      ungrouped.push(server);
      continue;
    }
    const bucket = named.get(name);
    if (bucket === undefined) named.set(name, [server]);
    else bucket.push(server);
  }
  const groups: ServerGroup[] = [];
  for (const [name, items] of named) groups.push({ name, servers: items });
  if (ungrouped.length > 0) groups.push({ name: null, servers: ungrouped });
  return groups;
}

/** A blank form. */
export function emptyForm(): FormModel {
  return {
    id: '',
    label: '',
    group: '',
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    privateKeyPath: '',
    jumpHostId: '',
    encoding: 'utf-8',
    keepAliveInterval: '30',
    agentCommandTrust: 'none',
    backgroundConnectionAllowed: false
  };
}

function trustLevel(value: unknown): TrustLevel {
  return value === 'policy' || value === 'full' ? value : 'none';
}

/**
 * Load a server view into the form for editing.
 *
 * The password is deliberately **not** carried over — the Host never sends it,
 * and the empty field is what "leave blank to keep the stored password" means.
 */
export function formFromServer(server: ServerView): FormModel {
  return {
    id: text(server.id),
    label: text(server.label),
    group: text(server.group),
    host: text(server.host),
    port: String(count(server.port) || 22),
    username: text(server.username),
    authType: text(server.authType) || 'password',
    password: '',
    privateKeyPath: text(server.privateKeyPath),
    jumpHostId: text(server.jumpHostId),
    encoding: text(server.encoding) || 'utf-8',
    keepAliveInterval: String(
      Number.isFinite(Number(server.keepAliveInterval)) ? Number(server.keepAliveInterval) : 30
    ),
    agentCommandTrust: trustLevel(server.agentCommandTrust),
    backgroundConnectionAllowed: server.backgroundConnectionAllowed === true
  };
}

/**
 * Inline validation, run **before** any RPC: a rejected form must not reach the
 * Host, whose `bad-params` answer names the field only in its own vocabulary.
 */
export function validateForm(
  t: Translate,
  form: FormModel,
  isNew: boolean
): { field: string; message: string } | null {
  if (form.label.trim() === '') return { field: 'label', message: t('validate.label') };
  if (form.host.trim() === '') return { field: 'host', message: t('validate.host') };
  if (form.username.trim() === '') return { field: 'username', message: t('validate.username') };
  if (!/^\d+$/.test(form.port.trim()) || Number(form.port) < 1 || Number(form.port) > 65535) {
    return { field: 'port', message: t('validate.port') };
  }
  if (!/^\d+$/.test(form.keepAliveInterval.trim())) {
    return { field: 'keepAliveInterval', message: t('validate.keepAlive') };
  }
  if (form.authType === 'password' && isNew && form.password === '') {
    return { field: 'password', message: t('validate.password') };
  }
  if (form.authType === 'privateKey' && form.privateKeyPath.trim() === '') {
    return { field: 'privateKeyPath', message: t('validate.privateKeyPath') };
  }
  return null;
}

/**
 * The `DshServerInput` the Host expects: no `hasPassword`, no display-only
 * fields, and the same "disabled control is excluded" rule the VS Code form
 * has — an untrusted server never carries `backgroundConnectionAllowed`.
 */
export function buildServerInput(form: FormModel, isNew: boolean): Record<string, unknown> {
  const input: Record<string, unknown> = {
    label: form.label.trim(),
    host: form.host.trim(),
    username: form.username.trim(),
    port: Number(form.port),
    authType: form.authType,
    encoding: form.encoding,
    keepAliveInterval: Number(form.keepAliveInterval),
    agentCommandTrust: form.agentCommandTrust
  };
  if (!isNew) input.id = form.id;
  if (form.group.trim() !== '') input.group = form.group.trim();
  if (form.authType === 'privateKey' && form.privateKeyPath.trim() !== '') {
    input.privateKeyPath = form.privateKeyPath.trim();
  }
  if (form.jumpHostId !== '') input.jumpHostId = form.jumpHostId;
  if (form.agentCommandTrust !== 'none') {
    input.backgroundConnectionAllowed = form.backgroundConnectionAllowed;
  }
  // Write-only, and omitted when blank: an empty string would clear a stored
  // password on an edit that never mentioned it.
  if (form.authType === 'password' && form.password !== '') input.password = form.password;
  return input;
}

/** The summary panel's five lines, computed from the form — a pure `updateSummary`. */
export function summarizeForm(
  t: Translate,
  form: FormModel,
  servers: ServerView[]
): { target: string; auth: string; group: string; route: string; agent: string } {
  const username = form.username.trim();
  const host = form.host.trim();
  const port = form.port.trim() === '' ? '22' : form.port.trim();
  const jump = servers.find((server) => server.id === form.jumpHostId);
  return {
    target: username !== '' && host !== '' ? `${username}@${host}:${port}` : t('form.summaryEnterHostUser'),
    auth: t('form.summaryAuth', { auth: authLabel(t, form.authType) }),
    group: t('form.summaryGroup', {
      group: form.group.trim() === '' ? t('form.defaultGroup') : form.group.trim()
    }),
    route:
      jump === undefined
        ? t('form.summaryRouteDirect')
        : t('form.summaryRouteVia', { host: `${jump.label} (${jump.host})` }),
    agent:
      form.agentCommandTrust === 'full'
        ? t('form.summaryAgentFull')
        : form.agentCommandTrust === 'policy'
          ? t('form.summaryAgentPolicy')
          : t('form.summaryAgentManual')
  };
}

/** The help copy under the trust select, mirroring the VS Code form's three texts. */
export function trustHelpKey(trust: TrustLevel): string {
  if (trust === 'full') return 'form.trustHelpFull';
  if (trust === 'policy') return 'form.trustHelpPolicy';
  return 'form.trustHelpNone';
}

/**
 * Decode one base64 frame into a `Uint8Array`.
 *
 * The wire carries bytes this way because a PTY stream is arbitrary bytes: a
 * JSON string would corrupt anything that is not valid UTF-8 on its own, a
 * split multi-byte sequence being the obvious case.
 */
export function decodeBase64Frame(data: unknown): Uint8Array {
  if (typeof atob !== 'function') {
    throw rpcError('no-base64', 'this page cannot decode base64 terminal output');
  }
  const binary = atob(String(data === null || data === undefined ? '' : data));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The WebSocket URL for the terminal, derived from the page's own origin: the
 * only host guaranteed to reach the channel is the one the page came from.
 */
export function terminalSocketUrl(location: { protocol?: string; host?: string } | undefined): string {
  const host = location && typeof location.host === 'string' ? location.host : '';
  if (host === '') {
    throw rpcError('no-origin', 'the page has no host, so the terminal address is unknown');
  }
  const scheme = location?.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${host}/dsh-at-terminal/ws`;
}

/** What `rpc channel.info` reports: the channel's real loopback address. */
export interface ChannelEndpoints {
  wsUrl?: string | null;
}

/**
 * The terminal's WebSocket address, from whichever source is authoritative for
 * the page this panel runs in.
 *
 * - **http(s) page** (the web GUI, including LAN browsers): the page's own
 *   origin is the reachable HTTP server, so the address is derived from it —
 *   asking the Host would answer `127.0.0.1`, which a LAN browser cannot use.
 * - **custom-scheme page** (the Desktop shell serves `dsh-app://app`): relative
 *   `fetch` is carried over the shell's IPC bridge, but a `WebSocket` needs a
 *   real network address and `location.host` is `app` — a name nothing can
 *   connect to. There the Host-reported loopback endpoint (rpc `channel.info`)
 *   is the only authority.
 */
export function resolveSocketUrl(
  location: { protocol?: string; host?: string } | undefined,
  endpoints: ChannelEndpoints | null
): string {
  const protocol = location?.protocol;
  if (protocol === 'http:' || protocol === 'https:') {
    return terminalSocketUrl(location);
  }
  const wsUrl = typeof endpoints?.wsUrl === 'string' ? endpoints.wsUrl.trim() : '';
  if (wsUrl === '') {
    throw rpcError(
      'no-ws-endpoint',
      'the page has no web origin and the Host reported no websocket endpoint'
    );
  }
  return wsUrl;
}

/**
 * Hand a returned envelope to the browser as a file download. The Host builds
 * the envelope, so the saved file carries the exact `.at-terminal-assets`
 * format the VS Code extension writes; this side only names it.
 */
export function saveDownload(filename: string, envelope: unknown): void {
  const payload = typeof envelope === 'string' ? envelope : JSON.stringify(envelope, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* -------------------------------------------------------------------------- */
/* SFTP file tree (DSH-23)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One entry as the Host sends it.
 *
 * The shape is `src/sftp/SftpTypes.ts#SftpEntry` verbatim — the Host forwards the
 * domain's own entries rather than mapping them into a wire-specific type, because a
 * second definition of "an SFTP entry" is how the two halves start disagreeing about
 * what a symlink is.
 */
export interface SftpEntryView {
  name: string;
  path: string;
  type: string;
  targetType?: string;
  size?: number;
  modifiedAt?: number;
}

/** `SftpTreeState`'s vocabulary, carried across the wire unchanged. */
export type SftpKind = 'none' | 'active' | 'disconnected';

export interface SftpListing {
  kind: SftpKind;
  rootPath: string;
  path: string;
  entries: SftpEntryView[];
  serverId: string;
  serverLabel: string;
}

/**
 * Read the Host's answer into the shape the tree renders, tolerating anything.
 *
 * `kind` falls back to `'none'` rather than to `'active'`: an unrecognised state must
 * never render as a live tree, because a live tree claims its contents are current.
 */
export function sftpListing(result: unknown): SftpListing {
  const source = (result ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(source.entries)
    ? source.entries.filter(
        (entry): entry is SftpEntryView =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as SftpEntryView).name === 'string' &&
          typeof (entry as SftpEntryView).path === 'string'
      )
    : [];
  return {
    kind: source.kind === 'active' || source.kind === 'disconnected' ? source.kind : 'none',
    rootPath: text(source.rootPath),
    path: text(source.path),
    entries,
    serverId: text(source.serverId),
    serverLabel: text(source.serverLabel)
  };
}

/**
 * Whether a row can be opened.
 *
 * A symlink to a directory stays expandable because its listing is taken through the
 * link's own path and the server resolves it; a dangling or file symlink renders as a
 * file. Mirrors `src/tree/SftpTreeProvider.ts#toTreeItem` so both platforms agree.
 */
export function sftpExpandable(entry: SftpEntryView): boolean {
  return entry.type === 'directory' || (entry.type === 'symlink' && entry.targetType === 'directory');
}

/** How an entry's size reads. Only a file has one worth showing. */
export function sftpEntrySize(entry: SftpEntryView): string {
  return entry.type === 'file' && typeof entry.size === 'number' ? formatFileSize(entry.size) : '';
}

/** One child listing, as the tree state machine tracks it. */
export type SftpChildState =
  | { kind: 'pending' }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'ok'; entries: SftpEntryView[] };

/** A rendered row. The view maps these one-to-one; no nesting is left to the renderer. */
export interface SftpRow {
  kind: 'entry' | 'parent' | 'pending' | 'failed';
  key: string;
  depth: number;
  entry?: SftpEntryView;
  code?: string;
  message?: string;
  expandable: boolean;
  expanded: boolean;
}

export interface SftpTreeInput {
  rootPath: string;
  entries: SftpEntryView[];
  /** Directory paths the user has opened. */
  expanded: readonly string[];
  children: Readonly<Record<string, SftpChildState | undefined>>;
  /**
   * The followed terminal is gone, so this is the **last** listing.
   *
   * Nothing below the root was ever read and the server cannot be asked now, so the tree
   * collapses to the single level it actually has instead of offering expanders that
   * cannot work. (`SftpTreeProvider#getChildren` makes the same choice.)
   */
  disconnected: boolean;
}

/**
 * Flatten the tree into the rows to render.
 *
 * Pure, and that is the point: the recursion, the `..` row's rule and the
 * disconnected collapse are the parts of this feature worth testing in isolation, and
 * none of them needs a DOM or a socket to be exercised.
 */
export function flattenSftpTree(input: SftpTreeInput): SftpRow[] {
  const root = input.rootPath;
  if (root === '') return [];

  const rows: SftpRow[] = [];
  const expanded = new Set(input.expanded);

  // `..` belongs at the top of the tree only. At `/` there is nowhere to go, and offering
  // it there would be a button that reloads the same directory.
  if (!input.disconnected && root !== '/') {
    rows.push({ kind: 'parent', key: 'parent', depth: 0, expandable: false, expanded: false });
  }

  const walk = (entries: SftpEntryView[], depth: number): void => {
    for (const entry of entries) {
      const expandable = !input.disconnected && sftpExpandable(entry);
      const isExpanded = expandable && expanded.has(entry.path);
      rows.push({ kind: 'entry', key: entry.path, depth, entry, expandable, expanded: isExpanded });
      if (!isExpanded) continue;

      const child = input.children[entry.path];
      if (child === undefined || child.kind === 'pending') {
        rows.push({
          kind: 'pending',
          key: `${entry.path}#pending`,
          depth: depth + 1,
          expandable: false,
          expanded: false
        });
        continue;
      }
      if (child.kind === 'failed') {
        rows.push({
          kind: 'failed',
          key: `${entry.path}#failed`,
          depth: depth + 1,
          code: child.code,
          message: child.message,
          expandable: false,
          expanded: false
        });
        continue;
      }
      walk(child.entries, depth + 1);
    }
  };

  walk(input.entries, 0);
  return rows;
}

/** The directory above `path`, resolved by the domain's own POSIX path rules. */
export function parentRemotePath(path: string): string {
  return dirname(path);
}

/* -------------------------------------------------------------------------- */
/* One remote file, in the panel (DSH-23's read/write half)                     */
/* -------------------------------------------------------------------------- */

/** How the file pane is showing a file: read-only, or with an editable buffer. */
export type SftpFileMode = 'view' | 'edit';

/** `sftp.readFile`'s reply, as the pane needs it. */
export interface SftpFileTextView {
  path: string;
  text: string;
  /** The convention that read reported; handed straight back to `sftp.writeFile`. */
  eol: 'lf' | 'crlf';
  size: number;
  modifiedAt: number;
  truncated: boolean;
}

/**
 * Read the Host's `sftp.readFile` reply, tolerating anything.
 *
 * `eol` falls back to `'lf'` rather than being guessed from the text: the text is already
 * LF-only by contract, so guessing would be reading the answer out of the thing it
 * describes. `'lf'` is the safe default because it is what a file written by a caller that
 * forgot the flag already is — the failure mode is "a CRLF file became LF", never "a file
 * acquired stray `\r`s".
 */
export function sftpFileText(result: unknown): SftpFileTextView {
  const source = (result ?? {}) as Record<string, unknown>;
  return {
    path: text(source.path),
    text: typeof source.text === 'string' ? source.text : '',
    eol: source.eol === 'crlf' ? 'crlf' : 'lf',
    size: count(source.size),
    modifiedAt: count(source.modifiedAt),
    truncated: source.truncated === true
  };
}

/** What a `sftp.writeFile` / `sftp.upload` reply leaves behind. */
export interface SftpWriteView {
  size: number;
  modifiedAt: number;
}

export interface SftpTransferProgress {
  kind: 'upload' | 'download';
  name: string;
  loaded: number;
  total: number;
  percent: number;
  detail?: string;
}

export function sftpWriteResult(result: unknown): SftpWriteView {
  const source = (result ?? {}) as Record<string, unknown>;
  return { size: count(source.size), modifiedAt: count(source.modifiedAt) };
}

/** Where an uploaded local file lands, given the directory the panel is showing. */
export function uploadTargetPath(directory: string, localName: string): string {
  return joinRemotePath(directory, localName);
}

/** How a file's size reads in the pane's status line. */
export function sftpFileSize(entry: { size: number }): string {
  return formatFileSize(entry.size);
}

/**
 * Save arbitrary bytes the Host returned as base64.
 *
 * A sibling of `saveDownload` rather than a generalisation of it: that one writes JSON the
 * Host authored (an asset package), this one writes bytes the *server* authored, and the
 * MIME type is the only thing the two share. Both go through the same anchor mechanism,
 * because in a `dsh-app://` page it is the only download route there is.
 */
export function saveBytes(filename: string, base64: string, type = 'application/octet-stream'): void {
  let blob: Blob;
  if (typeof (Uint8Array as any).fromBase64 === 'function') {
    blob = new Blob([(Uint8Array as any).fromBase64(base64)], { type });
  } else if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    blob = new Blob([Buffer.from(base64, 'base64')], { type });
  } else if (typeof atob === 'function') {
    const byteCharacters = atob(base64);
    const byteNumbers = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i += 65536) {
      const end = Math.min(i + 65536, byteCharacters.length);
      for (let j = i; j < end; j += 1) {
        byteNumbers[j] = byteCharacters.charCodeAt(j);
      }
    }
    blob = new Blob([byteNumbers], { type });
  } else {
    const bytes = decodeBase64Frame(base64);
    blob = new Blob([bytes as unknown as BlobPart], { type });
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }, 1000);
  }
}

/**
 * One picked local file, as base64 — the body an upload sends.
 *
 * `FileReader.readAsDataURL` rather than `btoa(await file.text())`, and the difference is
 * correctness rather than convenience: `file.text()` decodes with UTF-8, so a binary file
 * would arrive as replacement characters and be uploaded corrupted. `readAsDataURL` moves
 * the bytes untouched and hands back the base64 already encoded.
 *
 * The `data:` prefix carries the sniffed MIME type, which this panel has no use for — the
 * remote file is written byte-for-byte and the server has no idea what a media type is —
 * so it is cut off at the first comma. It is cut by **position**, not by regex: a base64
 * payload may itself contain a comma, and `split(',')[1]` would silently truncate it.
 */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(rpcError('no-file-reader', 'this page cannot read a local file'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(rpcError('no-file-reader', `could not read ${nameOfBlob(file)}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(rpcError('no-file-reader', `could not read ${nameOfBlob(file)}`));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma === -1 ? '' : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** A `Blob`'s name when it has one (a `File` does); `Blob` itself does not. */
function nameOfBlob(blob: Blob): string {
  return typeof (blob as { name?: unknown }).name === 'string' ? (blob as File).name : 'the chosen file';
}

/* -------------------------------------------------------------------------- */
/* The file pane's state machine                                               */
/* -------------------------------------------------------------------------- */

/** How a save ended. `conflict` is its own case because it is a question, not a failure. */
export type SftpSaveState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saved'; size: number }
  | { kind: 'conflict'; message: string }
  | { kind: 'failed'; code: string; message: string };

/**
 * The file pane, as one value.
 *
 * `pending` and `failed` carry `path`/`mode` so the pane can still name what it is about:
 * a failure with no subject ("could not read") is the shape this repository keeps rejecting,
 * and the mode matters because 查看 and 编辑 fail the same way but return to different places.
 */
export type SftpFilePaneState =
  | { kind: 'pending'; path: string; mode: SftpFileMode }
  | { kind: 'failed'; path: string; mode: SftpFileMode; code: string; message: string }
  | {
      kind: 'ready';
      path: string;
      mode: SftpFileMode;
      file: SftpFileTextView;
      /** The editor's live buffer. Equals `file.text` in view mode and until the first keystroke. */
      draft: string;
      dirty: boolean;
      save: SftpSaveState;
    };

/* -------------------------------------------------------------------------- */
/* A path, split for display (UI-12)                                           */
/* -------------------------------------------------------------------------- */

/**
 * One remote path as the two halves the official `PathLabel` renders separately:
 * the directory dims, the leaf keeps the primary color, and the separator belongs
 * to the base half so the leaf is exactly the last segment — the part a reader
 * identifies the entry by.
 *
 * A path with no separator has no base. A trailing slash yields an empty leaf
 * rather than a base holding everything, because `/a/b/` names `b` and the empty
 * string after the final slash is not a name.
 *
 * The split lives here, away from the view, because the repository has no `react`
 * dependency: `views/shared.ts` imports it, so a test can only reach this logic by
 * importing a module that has no React in it. A view-only export would be untestable.
 */
export function splitPathForDisplay(path: string): { base: string; leaf: string } {
  const cut = path.lastIndexOf('/');
  if (cut === -1) return { base: '', leaf: path };
  return { base: path.slice(0, cut + 1), leaf: path.slice(cut + 1) };
}

/* -------------------------------------------------------------------------- */
/* The file tree's accessibility surface (UI-02)                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether a row can hold the tree's focus.
 *
 * `pending` and `failed` are excluded on purpose: they are the *state of a read*, not
 * entries, and a focus stop on a row that cannot be opened or selected is a keyboard
 * trap — `Enter` on it would do nothing and there would be no way to tell that from a
 * broken control. They are still announced (they are treeitems, and a read in progress
 * is a live region), so skipping them costs a screen-reader user nothing.
 *
 * The `..` row counts: it is a real destination (`sftp.goUp`), so leaving it out of the
 * ring would make the one row that moves the root unreachable.
 */
export function sftpRowFocusable(row: SftpRow): boolean {
  return row.kind === 'entry' || row.kind === 'parent';
}

/**
 * The ARIA and focus attributes one row carries, ready to be spread into the element.
 *
 * Two decisions are load-bearing:
 *
 * - **Roving tabindex, not `tabIndex=0` everywhere.** A tree is one tab stop; giving
 *   every row its own makes Tab walk the listing a row at a time, which is the
 *   behaviour `role="tree"` exists to remove. The roving row is also what makes
 *   `data-at-terminal-sftp-focus` worth having: it is the one row that is both
 *   focusable and remembered, so a re-render can put the tab stop back where the user
 *   left it.
 * - **`aria-level`, because the DOM is flat.** `flattenSftpTree` returns a list and
 *   the view renders a list — depth is padding, not nesting — so without an explicit
 *   level a screen reader announces `sub/deep.txt` as a sibling of `sub`.
 *
 * `aria-expanded` goes only on a directory. On a leaf it would announce a disclosure
 * that does not exist, and on a disconnected tree every row is a leaf, which is
 * exactly the case where claiming "collapsible" would be a lie.
 *
 * Every row is a `treeitem`, the `pending` and `failed` placeholders included: a
 * `role="tree"` may only own treeitems, and those rows sit *inside* the listing where a
 * screen reader walking the tree has to meet them — hearing "reading this directory",
 * or the permission error, is the whole reason they are rendered rather than dropped. So
 * they are treeitems *without* a tab stop, which is the one thing `sftpRowFocusable`
 * decides; `{}` would have been wrong, leaving non-treeitems inside a tree.
 */
export function sftpRowA11y(row: SftpRow, focused: boolean): Record<string, unknown> {
  const props: Record<string, unknown> = {
    role: 'treeitem',
    'aria-level': row.depth + 1,
    // The row's own identity, because the keyboard handler finds the next row through
    // the DOM. It lives beside the ARIA so the attribute the handler queries and the
    // attribute the render writes cannot drift apart.
    'data-at-terminal-sftp-row': row.key
  };
  if (sftpRowFocusable(row)) {
    props.tabIndex = focused ? 0 : -1;
    if (focused) props['data-at-terminal-sftp-focus'] = 'true';
  }
  if (row.expandable) props['aria-expanded'] = row.expanded;
  return props;
}

/**
 * The row that owns the tree's tab stop.
 *
 * `wanted` is remembered across renders, so it has to be validated: `..`, a refresh
 * and a collapse all replace the row set under the user, and a remembered key that no
 * longer names anything would leave the whole listing out of the tab order. Falling
 * back to the first focusable row keeps the tree enterable; an empty tree has no tab
 * stop at all, which is correct — there is nothing in it to stop on.
 */
export function sftpTreeFocusKey(rows: readonly SftpRow[], wanted: string | null): string | null {
  if (wanted !== null && rows.some((row) => row.key === wanted && sftpRowFocusable(row))) {
    return wanted;
  }
  for (const row of rows) {
    if (sftpRowFocusable(row)) return row.key;
  }
  return null;
}

/** What one key press on the focused row asks the page to do. */
export type SftpTreeNav =
  /** Not a key the tree owns: leave it to the browser and to the panel's shortcuts. */
  | { kind: 'none' }
  /** `..` was activated. */
  | { kind: 'go-up' }
  /** A directory's expansion should flip. */
  | { kind: 'toggle'; path: string }
  /** A **file** was activated: open it in the viewer. */
  | { kind: 'open'; path: string }
  /** The caret should move to this row. */
  | { kind: 'focus'; key: string };

/**
 * Map one key press on the focused row to the action it means.
 *
 * Pure and index-based on the flat row list, which is what makes the awkward cases
 * testable without a DOM: `→` on an expanded directory must land on its first child
 * even when that child is a `pending` placeholder, and `←` on a collapsed row must
 * find the nearest shallower row — the `..` row included, since at depth 0 the walk
 * stops there rather than wrapping to the end of the listing.
 *
 * `Enter` and `Space` are the same action because the disclosure they stand in for is
 * a `<button>`, and a button answers both. Neither is `event.code` (`Space` vs
 * `Spacebar`): `key` is what the layout produced, so it is the one that survives a
 * non-US layout.
 *
 * The move keys stop at the ends instead of wrapping. A file listing is not a carousel,
 * and wrapping makes "the last row" impossible to land on deliberately.
 */
export function sftpTreeKeyAction(
  rows: readonly SftpRow[],
  focusedKey: string,
  key: string
): SftpTreeNav {
  const index = rows.findIndex((row) => row.key === focusedKey);
  // A caret on a row that is not in the list cannot be moved relative to that list.
  if (index < 0) return { kind: 'none' };
  const row = rows[index];

  if (key === 'Enter' || key === ' ') {
    if (row.kind === 'parent') return { kind: 'go-up' };
    // A file has no disclosure to stand in for, so activation means the one thing a file
    // can be opened as: the viewer. `Enter` on a directory keeps flipping its expansion,
    // which is what a tree's own contract says it does.
    //
    // The test is `sftpExpandable` on the **entry**, not `row.expandable`: the latter is
    // forced false for every row of a disconnected tree, so a directory in a frozen listing
    // would be offered as a file — and the Host would refuse it with `sftp-not-a-file`,
    // which is a worse answer than the tree simply not claiming it can open one.
    if (row.entry !== undefined && !sftpExpandable(row.entry)) return { kind: 'open', path: row.entry.path };
    if (!row.expandable || row.entry === undefined) return { kind: 'none' };
    return { kind: 'toggle', path: row.entry.path };
  }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const step = key === 'ArrowDown' ? 1 : -1;
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      if (sftpRowFocusable(rows[next])) return { kind: 'focus', key: rows[next].key };
    }
    return { kind: 'none' };
  }

  if (key === 'ArrowRight') {
    if (row.kind !== 'entry' || !row.expandable || row.entry === undefined) return { kind: 'none' };
    if (!row.expanded) return { kind: 'toggle', path: row.entry.path };
    // Already open: step onto the first child, which is the next row only when it is
    // genuinely deeper. A directory whose listing is still `pending` has no focusable
    // child yet, and claiming otherwise would move the caret onto a placeholder.
    const child = rows[index + 1];
    if (child === undefined || child.depth <= row.depth || !sftpRowFocusable(child)) {
      return { kind: 'none' };
    }
    return { kind: 'focus', key: child.key };
  }

  if (key === 'ArrowLeft') {
    if (row.kind === 'entry' && row.expandable && row.expanded && row.entry !== undefined) {
      return { kind: 'toggle', path: row.entry.path };
    }
    // The `..` row is a sibling of the depth-0 entries, not their parent, so the walk
    // for a shallower row stops at the real containing directory and never lands on it.
    for (let prev = index - 1; prev >= 0; prev -= 1) {
      if (rows[prev].depth < row.depth) return { kind: 'focus', key: rows[prev].key };
    }
    return { kind: 'none' };
  }

  return { kind: 'none' };
}
