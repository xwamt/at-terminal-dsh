/**
 * The **终端** tab's body: one live terminal and the file tree that follows it.
 *
 * Two pages, no more — 终端 and 文件. There is deliberately no 资产 page here: managing servers
 * belongs to the other tab kind, and a connection tab that could also edit the server list would
 * make "where am I" a question about a mode rather than about a tab.
 *
 * ## What this body does *not* own
 *
 * The socket, the PTY's identity, the connection state and the output the host has already sent
 * all live in `sessions.ts`, keyed by this tab. That is what lets the tab keep its SSH connection
 * while another tab is in front — the frame unmounts this component on every tab switch, and
 * anything held in `useState` here dies with it.
 *
 * What is left here is genuinely per-mount and cheap to rebuild: which directories the user has
 * expanded, what each of those reads returned, and the pending flags for the actions in flight.
 * The pieces that would be *wrong* to lose — the target server, the chosen page, the connection
 * itself — are read back from the session on the first render.
 */

import React, { type ReactElement } from 'react';

import { callRpc, postDiagnostic } from './channel';
import {
  BodyLocale,
  readTabKey,
  readTabSignal,
  useHostRead,
  useTabParams,
  useUiSettings
} from './body';
import {
  asFailure,
  dirname,
  flattenSftpTree,
  formatFileSize,
  joinRemotePath,
  readFileAsBase64,
  saveBytes,
  sftpFileText,
  sftpListing,
  sftpWriteResult,
  serverViews,
  text,
  uploadTargetPath,
  type SftpChildState,
  type SftpEntryView,
  type SftpFileMode,
  type SftpFilePaneState,
  type SftpRow,
  type SftpTransferProgress
} from './models';
import {
  adoptSessionTarget,
  attachEngine,
  connectSession,
  detachEngine,
  disconnectSession,
  forgetSessionHost,
  maybeAutoConnect,
  publishTabBadge,
  refusedHostKey,
  retainSessionSignal,
  sendSessionInput,
  sendSessionResize,
  setSessionFailure,
  setSessionPage,
  setSessionTarget,
  takeSessionSeed,
  trustSessionHost,
  useSession,
  type SessionPage,
  type TerminalSession
} from './sessions';
import { renderSftpView } from './views/sftp';
import { renderSftpFileView } from './views/sftpFile';
import { h, renderFailure, type El } from './views/shared';
import { TerminalView } from './views/terminal';
import type { TerminalEngine, TerminalEngineHooks } from './xtermEngine';

/** The `servers.list` reply, as this body needs it: which servers exist, and their encodings. */
interface ServerListResult {
  servers?: unknown;
}

/** The server a session tab was opened for, or `''` when the frame named none. */
function requestedServerId(params: Record<string, unknown>): string {
  const value = params.serverId;
  return typeof value === 'string' ? value : '';
}

/**
 * The fallback key for a body the frame gave no identity — a harness render, or a frame old enough
 * not to carry `contentId`.
 *
 * A constant rather than a random value, because two renders that cannot name their tab are the
 * *same* tab as far as anything here can tell, and minting a key per render would leak a session
 * (and an SSH connection) per render.
 */
interface SftpMenuState {
  x: number;
  y: number;
  row?: SftpRow;
  targetDir: string;
}

interface NewFileDialogState {
  targetDir: string;
  name: string;
  error: string | null;
  busy: boolean;
}

const ANONYMOUS_KEY = 'anonymous';

export function AtTerminalSessionBody(props: Record<string, unknown> = {}): ReactElement {
  const t = React.useContext(BodyLocale);
  const key = readTabKey(props) || ANONYMOUS_KEY;
  // Live, not a one-shot read. The frame records the opener's `params` in its own `onCommitted`
  // callback, so a body whose first render beats that write would otherwise never see what it was
  // opened for — and a terminal tab with no target is the "double-click did not connect" report.
  const params = useTabParams(props);
  const signal = readTabSignal(props);

  const session = useSession(key);

  /* --------------------------------- lifetime -------------------------------- */

  // Tie the session's end to the tab occurrence, and **not** to this component. The component
  // unmounts on every tab switch, which is precisely when a close is most likely to arrive
  // unnoticed; the listener therefore lives on the session, not on the body's cleanup.
  React.useEffect(() => {
    retainSessionSignal(session, signal);
  }, [session, signal]);

  /**
   * Adopt what this tab was opened for.
   *
   * Two sources, in order, and both are needed. `params` is the frame's own channel and the only one
   * that survives docking and a reload; the **seed** is the opener's memory of the gesture, used
   * when the params have not landed yet (or at all) — `readTabParams` documents why they can be
   * missing on the first render. `adoptSessionTarget` ignores both once the tab is in use, so a
   * write that arrives after the user has already picked something cannot retarget it.
   */
  const requested = requestedServerId(params);
  React.useEffect(() => {
    if (requested !== '') {
      adoptSessionTarget(session, requested);
      return;
    }
    adoptSessionTarget(session, takeSessionSeed(session.createdAt), 'seed');
  }, [session, requested]);

  /**
   * Connect the moment this tab has a target — once per tab, not once per mount.
   *
   * Keyed on the target rather than run once on mount, because the target itself can arrive a render
   * later (see above): a mount-time `useRef` would latch the empty first read and never revisit it.
   * The one-shot half lives on the session (`autoConnected`), so returning to a live tab shows the
   * connection that is already there instead of replacing it — and is also what keeps React 18's
   * double-invoked effects from opening two PTYs for one tab.
   */
  React.useEffect(() => {
    maybeAutoConnect(session, session.serverId);
  }, [session, session.serverId]);

  // One line per mount, so the log says what the frame actually handed this body: the params it
  // could read, and whether the fallback had to stand in for them. `buffered` is what this tab has
  // to restore its screen with — it is read after the terminal view's own effect has replayed it
  // (child effects run first), so a non-zero value here means the switch back had history to draw.
  React.useEffect(() => {
    postDiagnostic(
      'info',
      `at-terminal session body mount key=${key} params=${JSON.stringify(params)} target=${session.serverId} buffered=${session.retainedBytes}/${session.retained.length}`,
      'session',
      null,
      null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------- data ----------------------------------- */

  const serversState = useHostRead<ServerListResult>('servers.list', 0);
  const servers = serversState.kind === 'ok' ? serverViews(serversState.result) : [];
  const { settings, version: settingsVersion } = useUiSettings();
  const chosen = servers.find((server) => text(server.id) === session.serverId);

  /* ---------------------------------- badge ---------------------------------- */

  /**
   * Publish this tab's chip.
   *
   * Driven off state rather than off events so it cannot drift: any path that changes the
   * connection state or the selection updates the chip. A `problem` badge wins over `connecting`
   * because a refusal the user still has to act on is the more useful thing to see on a tab chip.
   *
   * The label comes from the server list, so nothing is published until that read lands — until
   * then the chip correctly falls back to the bare product name rather than showing a state dot
   * next to nothing. Note that a missing row must **not** clear the badge: the list is empty on
   * the first render of every mount, and clearing there is what used to make every background
   * chip forget its host the moment the user looked at another tab.
   */
  React.useEffect(() => {
    const server = servers.find((entry) => text(entry.id) === session.serverId);
    if (server === undefined) return;
    const badgeKind =
      session.failure !== null ? 'problem' : session.state.kind === 'connected' ? 'connected' : 'connecting';
    publishTabBadge(key, { label: server.label === '' ? server.host : server.label, kind: badgeKind });
  }, [key, servers, session, session.serverId, session.state.kind, session.failure]);

  /* ---------------------------------- files ---------------------------------- */

  /**
   * The file tree is a **read** of this session's PTY, so it has no session state of its own: the
   * root comes from `sftp.list`, and each expanded directory from one more `sftp.list` with a path.
   *
   * The one exception is `sftpVisited`, seeded from the session's remembered page: a tab the user
   * left on 文件 must come back to 文件, and the read has to be latched on for that first paint
   * instead of waiting for a page switch that will not come.
   */
  const [sftpRevision, setSftpRevision] = React.useState(0);
  const [sftpVisited, setSftpVisited] = React.useState(session.page === 'sftp');
  const [sftpBusy, setSftpBusy] = React.useState(false);
  const [sftpFailure, setSftpFailure] = React.useState<{ code: string; message: string } | null>(null);
  const [sftpExpanded, setSftpExpanded] = React.useState<string[]>([]);
  const [sftpChildren, setSftpChildren] = React.useState<Record<string, SftpChildState | undefined>>({});

  /**
   * The file pane, the file it acts on, and the upload's progress.
   *
   * All three are per-mount, like the expansion state above, and for the same reason: the
   * frame unmounts a background tab's body, and an open editor in a tab nobody is looking at
   * is not state worth keeping alive — a stale buffer coming back would be worse than one
   * that came back empty, because it would silently be a copy of a file that moved on. The
   * **connection** is the part that has to survive, and it lives in `sessions.ts`.
   */
  const [sftpFile, setSftpFile] = React.useState<SftpFilePaneState | null>(null);
  const [sftpSelected, setSftpSelected] = React.useState<string | null>(null);
  const [sftpUploading, setSftpUploading] = React.useState(false);
  const [sftpDownloading, setSftpDownloading] = React.useState(false);
  const [sftpTransferProgress, setSftpTransferProgress] = React.useState<SftpTransferProgress | null>(null);
  const [sftpNotice, setSftpNotice] = React.useState<string | null>(null);
  const [sftpMenu, setSftpMenu] = React.useState<SftpMenuState | null>(null);
  const [newFileDialog, setNewFileDialog] = React.useState<NewFileDialogState | null>(null);
  const sftpUploadTargetRef = React.useRef<string>('');
  const sftpFileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (sftpMenu === null) return undefined;
    const close = (): void => setSftpMenu(null);
    const onKeydown = (event: { key?: string }): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKeydown);
    };
  }, [sftpMenu]);

  // Scoped to *this* session's terminal. Without the id the host falls back to "the newest live
  // session", which is a coin toss once two tabs are connected and would show tab A's files under
  // tab B. `sftpRevision` rides along so a reconnect (which mints a new host terminalId) re-reads
  // the tree instead of keeping the dead session's listing.
  const sftpScope = React.useMemo(
    () => ({ terminalId: session.hostTerminalId, revision: sftpRevision }),
    [session.hostTerminalId, sftpRevision]
  );
  const sftpState = useHostRead<unknown>('sftp.list', sftpRevision, sftpVisited, sftpScope);
  const sftpList = sftpState.kind === 'ok' ? sftpListing(sftpState.result) : null;

  /** Read one directory below the root. Failures stay on that directory, not on the tree. */
  async function fetchSftpChildren(path: string): Promise<void> {
    const terminalId = session.hostTerminalId;
    setSftpChildren((current) => ({ ...current, [path]: { kind: 'pending' } }));
    try {
      const child = sftpListing(await callRpc('sftp.list', { path, terminalId }));
      setSftpChildren((current) => ({ ...current, [path]: { kind: 'ok', entries: child.entries } }));
    } catch (error) {
      const failure = asFailure(error);
      setSftpChildren((current) => ({
        ...current,
        [path]: { kind: 'failed', code: failure.code, message: failure.message }
      }));
    }
  }

  function toggleSftpDirectory(path: string): void {
    const isOpen = sftpExpanded.includes(path);
    setSftpExpanded(isOpen ? sftpExpanded.filter((value) => value !== path) : [...sftpExpanded, path]);
    // Fetched once per directory: collapsing and reopening must not hit the server again, which is
    // why the cache is only dropped by an explicit refresh.
    if (!isOpen && sftpChildren[path] === undefined) void fetchSftpChildren(path);
  }

  /**
   * Re-read the tree. `dropCache` is the difference between 刷新 and re-entering the page: the host
   * caches listings for 20 seconds, so a refresh that did not invalidate would show the user the
   * state they were trying to get away from.
   */
  function reloadSftp(dropCache: boolean): void {
    if (dropCache) {
      void callRpc('sftp.refresh', { terminalId: session.hostTerminalId }).catch((error: unknown) =>
        setSftpFailure(asFailure(error))
      );
    }
    setSftpFailure(null);
    // The notice described the previous listing ("uploaded 2 files"); leaving it up over a
    // fresh read would attribute it to the wrong state.
    setSftpNotice(null);
    // Children were read against the previous root; re-reading them is the only way the expanded
    // tree stays truthful, so they are dropped and refetched for the open ones.
    setSftpChildren({});
    setSftpRevision((value) => value + 1);
  }

  /* ---------------------------------- files ---------------------------------- */

  /**
   * Read one remote file into the pane.
   *
   * `mode` is what the user asked for, and it is carried through to the pane rather than
   * being decided here: whether a file can actually be **edited** depends on facts only the
   * read knows (its size on the server, whether it is text), and the pane is where those
   * facts are rendered. Deciding here would mean a second copy of the same rule.
   */
  function openSftpFile(path: string, mode: SftpFileMode): void {
    setSftpSelected(path);
    setSftpFailure(null);
    setSftpFile({ kind: 'pending', path, mode });
    callRpc('sftp.readFile', { path, terminalId: session.hostTerminalId }).then(
      (result) => {
        const file = sftpFileText(result);
        setSftpFile((current) =>
          current === null || current.kind !== 'pending' || current.path !== path
            ? current
            : { kind: 'ready', path, mode, file, draft: file.text, dirty: false, save: { kind: 'idle' } }
        );
      },
      (error: unknown) => {
        const failure = asFailure(error);
        setSftpFile((current) =>
          current === null || current.kind !== 'pending' || current.path !== path
            ? current
            : { kind: 'failed', path, mode, code: failure.code, message: failure.message }
        );
      }
    );
  }

  /** Switch the same file into the editor. No re-read: the buffer is the file we already have. */
  function editSftpFile(): void {
    setSftpFile((pane) =>
      pane === null || pane.kind !== 'ready' ? pane : { ...pane, mode: 'edit', save: { kind: 'idle' } }
    );
  }

  /** Throw the buffer away and go back to reading. */
  function revertSftpFile(): void {
    setSftpFile((pane) =>
      pane === null || pane.kind !== 'ready'
        ? pane
        : { ...pane, mode: 'view', draft: pane.file.text, dirty: false, save: { kind: 'idle' } }
    );
  }

  function draftSftpFile(value: string): void {
    setSftpFile((pane) =>
      pane === null || pane.kind !== 'ready' ? pane : { ...pane, draft: value, dirty: value !== pane.file.text }
    );
  }

  /**
   * Write the buffer back.
   *
   * The conflict check is the Host's (`sftp.writeFile` compares the stat this read reported),
   * and this side's only job is to make the refusal **askable**: a `sftp-conflict` becomes a
   * question with an explicit 覆盖 action rather than a dead end. Everything else is a plain
   * failure, because there is nothing for the user to decide.
   */
  function saveSftpFile(overwrite: boolean): void {
    const pane = sftpFile;
    if (pane === null || pane.kind !== 'ready') return;
    setSftpFile({ ...pane, save: { kind: 'pending' } });
    callRpc('sftp.writeFile', {
      path: pane.path,
      text: pane.draft,
      eol: pane.file.eol,
      expectedSize: pane.file.size,
      expectedModifiedAt: pane.file.modifiedAt,
      overwrite,
      terminalId: session.hostTerminalId
    }).then(
      (result) => {
        const written = sftpWriteResult(result);
        setSftpFile((current) =>
          current === null || current.kind !== 'ready' || current.path !== pane.path
            ? current
            : {
                ...current,
                // The stat the *server* reported, not the size of the buffer: a CRLF file
                // written back is larger than the LF-only text that produced it, and the
                // next save must be checked against what is really there.
                file: { ...current.file, text: current.draft, size: written.size, modifiedAt: written.modifiedAt },
                dirty: false,
                save: { kind: 'saved', size: written.size }
              }
        );
        // The row's size and mtime changed; the tree's cached listing still holds the old
        // ones, and a stale size next to a file the user just edited is a visible lie.
        setSftpRevision((value) => value + 1);
      },
      (error: unknown) => {
        const failure = asFailure(error);
        setSftpFile((current) =>
          current === null || current.kind !== 'ready' || current.path !== pane.path
            ? current
            : {
                ...current,
                save:
                  failure.code === 'sftp-conflict'
                    ? { kind: 'conflict', message: failure.message }
                    : { kind: 'failed', ...failure }
              }
        );
      }
    );
  }

  /** Ask the Host for a file's bytes and hand them to the browser. */
  function downloadSftpFile(path: string): void {
    const fileName = path.split('/').filter(Boolean).pop() || 'remote-file';
    setSftpDownloading(true);
    setSftpFailure(null);
    setSftpTransferProgress({
      kind: 'download',
      name: fileName,
      loaded: 0,
      total: 0,
      percent: 0,
      detail: t('sftp.downloading')
    });

    callRpc(
      'sftp.download',
      { path, terminalId: session.hostTerminalId },
      {
        onDownloadProgress: ({ loaded, total, percent }) => {
          const detail = total > 0
            ? `${formatFileSize(loaded)} / ${formatFileSize(total)}`
            : formatFileSize(loaded);
          setSftpTransferProgress({
            kind: 'download',
            name: fileName,
            loaded,
            total,
            percent,
            detail
          });
        }
      }
    ).then(
      (result) => {
        const payload = (result ?? {}) as { name?: unknown; base64?: unknown; size?: unknown };
        const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : fileName;
        const size = typeof payload.size === 'number' ? payload.size : 0;
        try {
          // `saveBytes` is the browser's download route; it throws where the page has none,
          // and that belongs on the page's failure line rather than in the console.
          saveBytes(name, typeof payload.base64 === 'string' ? payload.base64 : '');
          setSftpTransferProgress({
            kind: 'download',
            name,
            loaded: size,
            total: size,
            percent: 100,
            detail: `${formatFileSize(size)} / ${formatFileSize(size)}`
          });
          setTimeout(() => {
            setSftpTransferProgress(null);
            setSftpDownloading(false);
          }, 800);
          setSftpNotice(t('sftp.downloadDone', { name, size: formatFileSize(size) }));
        } catch (error) {
          setSftpTransferProgress(null);
          setSftpDownloading(false);
          setSftpFailure(asFailure(error));
        }
      },
      (error: unknown) => {
        setSftpTransferProgress(null);
        setSftpDownloading(false);
        setSftpFailure(asFailure(error));
      }
    );
  }

  /**
   * Move picked local files to the directory the tree is showing.
   *
   * One RPC per file rather than one batch call, and that is a deliberate limit rather than
   * an oversight: the channel's request body is capped, while a `multiple` pick can
   * legitimately be a directory's worth of files. Batching would either raise that cap for
   * every caller or fail the whole selection on its largest member; per-file keeps each
   * request inside the budget and lets the good ones land.
   *
   * A collision is asked about, not assumed: `sftp.upload` refuses an existing destination,
   * and the answer here is a plain confirm — the same shape 删除 uses on the 资产 page, so
   * the panel has one way of asking a yes/no question rather than two.
   */
  function uploadSftpFiles(files: File[], directory: string): void {
    if (directory === '') return;
    setSftpUploading(true);
    setSftpFailure(null);
    setSftpNotice(null);

    const uploadOne = async (file: File, fileIndex: number, totalFiles: number): Promise<string | null> => {
      const target = uploadTargetPath(directory, file.name);
      setSftpTransferProgress({
        kind: 'upload',
        name: file.name,
        loaded: 0,
        total: file.size,
        percent: 0,
        detail: totalFiles > 1 ? `(${fileIndex + 1}/${totalFiles}) 0%` : '0%'
      });
      let base64: string;
      try {
        base64 = await readFileAsBase64(file);
      } catch (error) {
        return `${file.name}: ${asFailure(error).message}`;
      }
      const send = (overwrite: boolean): Promise<unknown> =>
        callRpc(
          'sftp.upload',
          { path: target, base64, terminalId: session.hostTerminalId, overwrite },
          {
            onUploadProgress: ({ loaded, total, percent }) => {
              const fileLoaded = Math.min(file.size, Math.round((loaded / total) * file.size));
              const prefix = totalFiles > 1 ? `(${fileIndex + 1}/${totalFiles}) ` : '';
              const detail = `${prefix}${formatFileSize(fileLoaded)} / ${formatFileSize(file.size)}`;
              setSftpTransferProgress({
                kind: 'upload',
                name: file.name,
                loaded: fileLoaded,
                total: file.size,
                percent,
                detail
              });
            }
          }
        );
      try {
        await send(false);
        return null;
      } catch (error) {
        const failure = asFailure(error);
        if (failure.code !== 'sftp-conflict') return `${file.name}: ${failure.message}`;
        const confirmed =
          typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(t('sftp.uploadConflict', { path: target }))
            : false;
        if (!confirmed) return t('sftp.uploadSkipped', { name: file.name });
        try {
          await send(true);
          return null;
        } catch (retry: unknown) {
          return `${file.name}: ${asFailure(retry).message}`;
        }
      }
    };

    void (async () => {
      let uploaded = 0;
      const problems: string[] = [];
      const totalFiles = files.length;
      for (let i = 0; i < totalFiles; i += 1) {
        const file = files[i];
        const problem = await uploadOne(file, i, totalFiles);
        if (problem === null) uploaded += 1;
        else problems.push(problem);
      }
      setSftpTransferProgress(null);
      setSftpUploading(false);
      // Re-read even on a total failure: a partial success still changed the directory, and
      // the 20-second listing cache would otherwise show the user the state they just left.
      reloadSftp(true);
      setSftpNotice(
        problems.length === 0
          ? t('sftp.uploadDone', { count: uploaded })
          : [t('sftp.uploadDone', { count: uploaded }), ...problems].join(' · ')
      );
    })();
  }

  async function goUpSftp(): Promise<void> {
    setSftpBusy(true);
    setSftpFailure(null);
    try {
      await callRpc('sftp.goUp', { terminalId: session.hostTerminalId });
      setSftpExpanded([]);
      setSftpChildren({});
      setSftpRevision((value) => value + 1);
    } catch (error) {
      setSftpFailure(asFailure(error));
    } finally {
      setSftpBusy(false);
    }
  }

  function copyRemotePath(path: string): void {
    setSftpMenu(null);
    const write = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(path) : undefined;
    if (write !== undefined) void write.catch(() => undefined);
    setSftpNotice(t('sftp.copiedPath', { path }));
  }

  function triggerUpload(targetDir: string): void {
    setSftpMenu(null);
    sftpUploadTargetRef.current = targetDir;
    if (sftpFileInputRef.current !== null) {
      sftpFileInputRef.current.click();
    } else if (typeof document !== 'undefined') {
      const input = document.querySelector<HTMLInputElement>('[data-at-terminal-action="sftp-menu-upload-input"]');
      input?.click();
    }
  }

  function deleteRemoteItem(path: string, name: string): void {
    setSftpMenu(null);
    const message = t('sftp.deleteConfirm', { name });
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return;
    if (window.confirm(message) !== true) return;
    setSftpBusy(true);
    setSftpFailure(null);
    callRpc('sftp.delete', { path, terminalId: session.hostTerminalId })
      .then(
        () => {
          if (sftpSelected === path) setSftpSelected(null);
          if (sftpFile?.path === path) setSftpFile(null);
          setSftpNotice(t('sftp.deleteDone', { name }));
          reloadSftp(true);
        },
        (error: unknown) => setSftpFailure(asFailure(error))
      )
      .finally(() => setSftpBusy(false));
  }

  function openNewFileDialog(targetDir: string): void {
    setSftpMenu(null);
    setNewFileDialog({ targetDir, name: '', error: null, busy: false });
  }

  async function submitNewFile(): Promise<void> {
    if (newFileDialog === null || newFileDialog.busy) return;
    const trimmed = newFileDialog.name.trim();
    if (trimmed === '') return;
    const fullPath = joinRemotePath(newFileDialog.targetDir, trimmed);
    setNewFileDialog((prev) => (prev ? { ...prev, busy: true, error: null } : null));
    try {
      await callRpc('sftp.createFile', { path: fullPath, terminalId: session.hostTerminalId });
      setNewFileDialog(null);
      setSftpNotice(t('sftp.createDone', { name: trimmed }));
      reloadSftp(true);
      openSftpFile(fullPath, 'edit');
    } catch (error) {
      const failure = asFailure(error);
      setNewFileDialog((prev) => (prev ? { ...prev, busy: false, error: failure.message } : null));
    }
  }

  /**
   * Switching to 文件 re-reads. A terminal may have connected or dropped while the user was on
   * another page, and the host half only knows the terminals it was told about — so the page's
   * first paint after a switch is the moment its answer can be stale.
   */
  function changePage(next: SessionPage): void {
    setSessionPage(session, next);
    if (next !== 'sftp') {
      // Leaving 文件 closes the file pane. The pane belongs to the 文件 page rather than to
      // the tab, so a half-written buffer waiting behind 终端 is a thing the user cannot see
      // and did not ask to keep.
      setSftpFile(null);
      setSftpMenu(null);
      setNewFileDialog(null);
      return;
    }
    setSftpVisited(true);
    reloadSftp(false);
  }

  /* --------------------------------- engine ---------------------------------- */

  // Stable engine hooks: the engine captures them at creation, so they route through refs rather
  // than closing over one render's functions.
  const inputHandlerRef = React.useRef<(data: string) => void>(() => undefined);
  const resizeHandlerRef = React.useRef<(rows: number, cols: number) => void>(() => undefined);
  const hooksRef = React.useRef<TerminalEngineHooks | null>(null);
  let hooks = hooksRef.current;
  if (hooks === null) {
    hooks = {
      onInput: (data) => inputHandlerRef.current(data),
      onResize: (rows, cols) => resizeHandlerRef.current(rows, cols)
    };
    hooksRef.current = hooks;
  }
  inputHandlerRef.current = (data: string) => sendSessionInput(session, data);
  resizeHandlerRef.current = (rows: number, cols: number) => sendSessionResize(session, rows, cols);

  const engineRef = React.useRef<TerminalEngine | null>(null);

  /**
   * The engine attached or left. Either way the **session** is what holds the connection, so this
   * is a hand-off rather than a lifecycle: on attach the session replays everything it buffered
   * while this tab was in the background, and on detach it goes on keeping them.
   */
  function onEngine(engine: TerminalEngine | null): void {
    const previous = engineRef.current;
    engineRef.current = engine;
    if (engine === null) {
      if (previous !== null) detachEngine(session, previous);
      return;
    }
    // Encoding before the replay: the retained chunks are raw bytes and go through this decoder,
    // so setting it afterwards would render the tab's history in the wrong charset.
    engine.setEncoding(chosen?.encoding);
    attachEngine(session, engine);
  }

  /* ---------------------------------- trust ---------------------------------- */

  const [trustPending, setTrustPending] = React.useState(false);
  const refusal = refusedHostKey(session);

  /** Accept or forget a host key, then let the session reconnect — one decision, not three steps. */
  function runTrust(action: (target: TerminalSession) => Promise<void>): void {
    if (trustPending) return;
    setTrustPending(true);
    action(session).then(
      () => setTrustPending(false),
      (error: unknown) => {
        setTrustPending(false);
        setSessionFailure(session, { ...asFailure(error), fingerprint: '' });
      }
    );
  }

  /* --------------------------------- render ---------------------------------- */

  const banners: unknown[] = [];
  if (session.connectError !== null) {
    banners.push(
      h(
        'div',
        { key: 'connect-error', className: 'att-banner', 'data-at-terminal-validation': 'terminal' },
        // `connectError` is an i18n **key**, not a sentence: the registry has no translator, and
        // resolving it here is the same rule the rest of the panel follows.
        t(session.connectError)
      )
    );
  }
  if (session.failure !== null) {
    banners.push(h('div', { key: 'term-error' }, renderFailure(t, session.failure)));
    if (refusal !== null) {
      banners.push(
        h(
          'div',
          { key: 'trust', className: 'att-banner info' },
          h(
            'div',
            { 'data-at-terminal-fingerprint': refusal.fingerprint },
            t('terminal.fingerprint', { fingerprint: refusal.fingerprint })
          ),
          h(
            'div',
            { className: 'att-banner-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'att-btn',
                disabled: trustPending,
                onClick: () => runTrust(trustSessionHost),
                'data-at-terminal-action': 'term-trust'
              },
              t('terminal.trust')
            ),
            trustPending ? h('span', { className: 'att-chip' }, t('terminal.trustPending')) : null,
            // Only when the recorded key *disagrees* with the host: an entry recorded under the
            // wrong address reports `host-key-changed` forever, and the only other way out of that
            // would be to accept whatever fingerprint appeared next.
            refusal.code === 'host-key-changed'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'att-btn',
                    disabled: trustPending,
                    onClick: () => runTrust(forgetSessionHost),
                    'data-at-terminal-action': 'term-forget'
                  },
                  t('terminal.forget')
                )
              : null
          )
        )
      );
    }
  }
  if (session.trusted !== null) {
    banners.push(
      h(
        'div',
        { key: 'trusted', className: 'att-line', 'data-at-terminal-trusted': 'ok' },
        t('terminal.trusted', { host: session.trusted.host, port: session.trusted.port })
      )
    );
  }
  if (session.reason !== '') {
    banners.push(
      h(
        'div',
        { key: 'closed', className: 'att-line', 'data-at-terminal-term-closed': session.reason },
        t('terminal.closed', { reason: session.reason })
      )
    );
  }

  const children: unknown[] = [];

  const uploadTarget = sftpList === null ? '' : sftpList.rootPath;

  children.push(
    renderSftpView({
      t,
      // The file pane takes the page over rather than sitting inside it: two surfaces that
      // mount and hide each other, the same shape the 资产 page uses for its server form.
      visible: session.page === 'sftp' && sftpFile === null,
      mode: session.page,
      onMode: changePage,
      state: sftpState,
      failure: sftpFailure,
      // The rows are computed here rather than in the view because the recursion lives in
      // `flattenSftpTree`, which is unit-tested without a DOM; the view only maps rows.
      rows: flattenSftpTree({
        rootPath: sftpList === null ? '' : sftpList.rootPath,
        entries: sftpList === null ? [] : sftpList.entries,
        expanded: sftpExpanded,
        children: sftpChildren,
        disconnected: sftpList !== null && sftpList.kind === 'disconnected'
      }),
      expanded: sftpExpanded,
      busy: sftpBusy,
      onToggle: toggleSftpDirectory,
      onGoUp: () => void goUpSftp(),
      onRefresh: () => reloadSftp(true),
      selectedPath: sftpSelected,
      onSelect: setSftpSelected,
      onOpen: openSftpFile,
      onDownload: downloadSftpFile,
      downloading: sftpDownloading,
      uploadTarget,
      onUpload: (files: File[]) => uploadSftpFiles(files, uploadTarget),
      uploading: sftpUploading,
      progress: sftpTransferProgress,
      notice: sftpNotice,
      onRowContextMenu: (event, row) => {
        const listing = sftpList;
        if (listing === null || listing.kind !== 'active') return;
        let targetDir = listing.rootPath;
        if (row.kind === 'entry') {
          const entry = row.entry as SftpEntryView;
          if (entry.type === 'directory') {
            targetDir = entry.path;
          } else {
            targetDir = dirname(entry.path);
            setSftpSelected(entry.path);
          }
        }
        setSftpMenu({
          x: event.clientX,
          y: event.clientY,
          row,
          targetDir
        });
      },
      onContainerContextMenu: (event) => {
        const listing = sftpList;
        if (listing === null || listing.kind !== 'active') return;
        setSftpMenu({
          x: event.clientX,
          y: event.clientY,
          targetDir: listing.rootPath
        });
      }
    })
  );

  if (session.page === 'sftp') {
    children.push(
      h('input', {
        key: 'sftp-menu-file-input',
        type: 'file',
        multiple: true,
        ref: sftpFileInputRef,
        style: { display: 'none' },
        'data-at-terminal-action': 'sftp-menu-upload-input',
        onChange: (event: { target?: { files?: ArrayLike<File> | null; value?: string } }) => {
          const files = event?.target?.files;
          const picked: File[] = [];
          for (let index = 0; index < (files?.length ?? 0); index += 1) {
            const file = files?.[index];
            if (file !== undefined) picked.push(file);
          }
          if (event?.target !== undefined) event.target.value = '';
          if (picked.length > 0) {
            uploadSftpFiles(picked, sftpUploadTargetRef.current || uploadTarget);
          }
        }
      })
    );

    if (sftpMenu !== null) {
      const menuRow = sftpMenu.row;
      const menuItems: El[] = [];
      const menuItem = (itemKey: string, label: string, onClick: () => void, danger = false): El =>
        h(
          'button',
          {
            key: itemKey,
            type: 'button',
            className: danger ? 'att-menu-item danger' : 'att-menu-item',
            role: 'menuitem',
            onClick,
            'data-at-terminal-action': `sftp-menu-${itemKey}`
          },
          label
        );

      if (menuRow?.kind === 'parent') {
        menuItems.push(
          menuItem('up', t('sftp.goUp'), () => {
            setSftpMenu(null);
            void goUpSftp();
          }),
          menuItem('refresh', t('toolbar.refresh'), () => {
            setSftpMenu(null);
            reloadSftp(true);
          })
        );
      } else if (menuRow?.kind === 'entry') {
        const entry = menuRow.entry as SftpEntryView;
        if (entry.type === 'directory') {
          menuItems.push(
            menuItem('new-file', t('sftp.newFile'), () => openNewFileDialog(entry.path)),
            menuItem('upload', t('sftp.uploadHere'), () => triggerUpload(entry.path)),
            menuItem('refresh', t('toolbar.refresh'), () => {
              setSftpMenu(null);
              reloadSftp(true);
            }),
            menuItem('copy-path', t('sftp.copyPath'), () => copyRemotePath(entry.path)),
            menuItem('delete', t('sftp.delete'), () => deleteRemoteItem(entry.path, entry.name), true)
          );
        } else {
          menuItems.push(
            menuItem('view', t('sftp.view'), () => {
              setSftpMenu(null);
              openSftpFile(entry.path, 'view');
            }),
            menuItem('edit', t('sftp.edit'), () => {
              setSftpMenu(null);
              openSftpFile(entry.path, 'edit');
            }),
            menuItem('download', t('sftp.download'), () => {
              setSftpMenu(null);
              downloadSftpFile(entry.path);
            }),
            menuItem('new-file', t('sftp.newFile'), () => openNewFileDialog(dirname(entry.path))),
            menuItem('copy-path', t('sftp.copyPath'), () => copyRemotePath(entry.path)),
            menuItem('delete', t('sftp.delete'), () => deleteRemoteItem(entry.path, entry.name), true)
          );
        }
      } else {
        const canGoUp = sftpList !== null && sftpList.rootPath !== '' && sftpList.rootPath !== '/';
        menuItems.push(
          menuItem('new-file', t('sftp.newFile'), () => openNewFileDialog(sftpMenu.targetDir)),
          menuItem('upload', t('sftp.upload'), () => triggerUpload(sftpMenu.targetDir))
        );
        if (canGoUp) {
          menuItems.push(
            menuItem('up', t('sftp.goUp'), () => {
              setSftpMenu(null);
              void goUpSftp();
            })
          );
        }
        menuItems.push(
          menuItem('refresh', t('toolbar.refresh'), () => {
            setSftpMenu(null);
            reloadSftp(true);
          })
        );
      }

      children.push(
        h(
          'div',
          {
            key: 'sftp-menu',
            className: 'att-menu',
            role: 'menu',
            style: { left: `${sftpMenu.x}px`, top: `${sftpMenu.y}px` },
            'data-at-terminal-sftp-menu': 'true',
            onClick: (event: { stopPropagation(): void }) => event.stopPropagation()
          },
          ...menuItems
        )
      );
    }

    if (newFileDialog !== null) {
      children.push(
        h(
          'div',
          {
            key: 'new-file-dialog',
            className: 'att-overlay',
            'data-at-terminal-dialog': 'sftp-new-file',
            onClick: (event: { target?: unknown; currentTarget?: unknown }) => {
              if (event.target === event.currentTarget && !newFileDialog.busy) setNewFileDialog(null);
            }
          },
          h(
            'div',
            {
              className: 'att-dialog',
              role: 'dialog',
              'aria-modal': true,
              'aria-label': t('sftp.newFileTitle'),
              tabIndex: -1,
              onKeyDown: (event: { key: string; stopPropagation(): void }) => {
                if (event.key === 'Escape' && !newFileDialog.busy) {
                  event.stopPropagation();
                  setNewFileDialog(null);
                }
              }
            },
            h('h2', { className: 'att-dialog-title' }, t('sftp.newFileTitle')),
            h(
              'div',
              { className: 'att-field' },
              h('span', null, t('sftp.newFileTargetDir', { dir: newFileDialog.targetDir })),
              h('label', { htmlFor: 'sftp-new-file-input' }, t('sftp.newFilePrompt')),
              h('input', {
                id: 'sftp-new-file-input',
                type: 'text',
                value: newFileDialog.name,
                placeholder: t('sftp.newFileNamePlaceholder'),
                disabled: newFileDialog.busy,
                autoFocus: true,
                'data-at-terminal-action': 'sftp-new-file-input',
                onChange: (event: { target?: { value?: string } }) => {
                  const val = event?.target?.value ?? '';
                  setNewFileDialog((prev) => (prev ? { ...prev, name: val, error: null } : null));
                },
                onKeyDown: (event: { key: string; preventDefault(): void }) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitNewFile();
                  }
                }
              }),
              newFileDialog.error !== null
                ? h('div', { className: 'att-banner', role: 'alert' }, newFileDialog.error)
                : null
            ),
            h(
              'div',
              { className: 'att-dialog-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'att-btn',
                  disabled: newFileDialog.busy,
                  onClick: () => setNewFileDialog(null),
                  'data-at-terminal-action': 'sftp-new-file-cancel'
                },
                t('sftp.cancel')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'att-btn primary',
                  disabled: newFileDialog.busy || newFileDialog.name.trim() === '',
                  onClick: () => void submitNewFile(),
                  'data-at-terminal-action': 'sftp-new-file-submit'
                },
                t('sftp.create')
              )
            )
          )
        )
      );
    }
  }

  if (sftpFile !== null) {
    children.push(
      renderSftpFileView({
        t,
        visible: session.page === 'sftp',
        mode: session.page,
        onMode: changePage,
        pane: sftpFile,
        onDraft: draftSftpFile,
        onEdit: editSftpFile,
        onRevert: revertSftpFile,
        onSave: saveSftpFile,
        onReload: () => openSftpFile(sftpFile.path, sftpFile.mode),
        onClose: () => setSftpFile(null),
        onDownload: () => downloadSftpFile(sftpFile.path)
      })
    );
  }

  children.push(
    h(TerminalView, {
      key: 'terminal',
      t,
      visible: session.page === 'terminal',
      mode: session.page,
      onMode: changePage,
      serversState,
      servers,
      selectedServerId: session.serverId,
      onSelect: (id: string) => setSessionTarget(session, id),
      onConnect: () => void connectSession(session),
      onDisconnect: () => disconnectSession(session),
      termState: session.state,
      settings,
      settingsVersion,
      encoding: chosen?.encoding,
      hooks,
      onEngine
    })
  );

  // The failure/trust banners live here rather than inside the view: they are session state, and
  // keeping them in this body's own tree is what makes them reachable to the bundle test's element
  // walk — the xterm view is a DOM-bound component the test harness does not instantiate.
  if (banners.length > 0) {
    children.push(
      h(
        'div',
        { key: 'terminal-banners', className: 'att-banners', hidden: session.page !== 'terminal' },
        banners
      )
    );
  }

  // One breadcrumb per committed render of a tab body. A blank panel with **no** breadcrumb means
  // the body never got this far (mount threw above); a breadcrumb followed by an `error` entry
  // names the throw directly. Fire-and-forget and outside the render path's return value.
  React.useEffect(() => {
    postBodyRendered(key, session.page);
  }, [key, session.page]);

  return h('div', { className: 'att-root', 'data-at-terminal-body': session.page }, children);
}

/** The breadcrumb, through `channel`'s poster. Split out so the effect body stays one statement. */
function postBodyRendered(key: string, page: string): void {
  postDiagnostic('info', `at-terminal body rendered tab=${key} page=${page}`, 'body', null, null);
}
