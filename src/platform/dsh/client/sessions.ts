/**
 * Live SSH terminals, held **outside React**, keyed by the tab that owns them.
 *
 * ## Why this file exists
 *
 * A tab body is unmounted the moment another tab in the same pane comes to the front — this
 * plugin deliberately does not set `keepMounted` (see `definition()` in `main.ts` for why that
 * flag blanks the panel). So while the socket, the flow controller and the PTY's identity lived
 * in `AtTerminalBody`'s hooks, **switching tabs closed the SSH connection**, and switching back
 * opened a new one. That is the defect this module removes.
 *
 * The official `terminal` type solves it the same way, and this is a port of its shape rather
 * than an invention: a model registry outside React (`ctx.webTerminals`), a window hold driven
 * by the frame's own **open-tab inventory** (`sidebarRight.openTabs`), and a close handler
 * (`registerCloseHandler`) for the frame's own removal path. The three of them are wired in
 * `main.ts`; what lives here is only the registry they act on.
 *
 * ## What survives, and what does not
 *
 * | | while the tab is in the background |
 * |---|---|
 * | the WebSocket, the PTY, the remote process | **alive** — nothing closes them |
 * | the connection state, the target, the chosen page | **alive** — they are fields here |
 * | every byte the session has ever produced | **retained**, in a bounded ring |
 * | the xterm instance (and its screen buffer, scrollback, selection) | **gone** — the engine is DOM-bound and is disposed with the body |
 *
 * The last row is the honest limit, and it is the reason the third one has to be so greedy: the
 * screen a user sees **is** the xterm instance, and nothing else holds it. The ring is therefore
 * the only copy of that screen, which means it has to hold everything the session ever produced —
 * not merely what arrived while nobody was looking.
 *
 * Retaining only the detached window was this file's first shape, and it produced exactly the
 * complaint it invited: an idle shell emits nothing while you are away, so coming back to a tab
 * rebuilt an **empty** terminal — connected, according to its own state, with no prompt on it —
 * until the next keystroke made the shell print a new one. `consume` retains unconditionally now.
 *
 * On re-attach the ring is **replayed into a fresh xterm**, in order, which rebuilds the screen as
 * long as the ring still holds the whole session; only a session that has produced more than
 * `RETAIN_LIMIT_BYTES` loses its head (and then a reset is written first, so the replay starts
 * from a clean screen instead of mid-escape-sequence). A replay does **not** empty the ring: a
 * second switch away has to replay the same history, and dropping it there is how a terminal comes
 * back showing only what arrived since the last time it was looked at.
 *
 * ## Backpressure is deliberately unchanged
 *
 * `flow` still counts produced-but-unrendered bytes, and still asks the host to pause past the
 * threshold — even while no engine is attached. Two things follow, and both are wanted: the ring
 * cannot grow without bound (the host stops once the threshold is crossed), and **nothing the
 * remote produced is lost** (the remote process blocks instead of its output being dropped).
 * The debt is settled on re-attach, where the replay's write callbacks acknowledge the retained
 * bytes and the host resumes.
 */

import React from 'react';

import { callRpc, postDiagnostic } from './channel';
import { createFlowController, type FlowController } from './flow';
import { createTerminalFrameHandler, type TerminalSessionState } from './frames';
import { asFailure, resolveSocketUrl, text, type ChannelEndpoints } from './models';
import type { TerminalEngine } from './xtermEngine';

/** The terminal id this client opens; one PTY per session, so one id. */
export const TERMINAL_ID = 'at-terminal-pane';

/**
 * How many bytes of a session's output are kept so that its screen can be rebuilt.
 *
 * This is a **screen budget, not a backpressure bound**. The flow controller's 256 KiB pause is
 * about *unrendered* bytes, which is a different quantity: a tab in the foreground renders
 * everything it is sent, so nothing but this constant stands between the ring and unbounded
 * growth. (While a tab is detached the two do overlap — the host pauses before the ring can reach
 * this ceiling — but a session is retained for its whole life now, not only while hidden.)
 *
 * 4 MiB on purpose. What can actually be displayed is xterm's own scrollback — the user's
 * `scrollback` setting, in lines — and a few thousand lines is a few hundred KiB, so the ceiling
 * sits an order of magnitude above anything a replay can show. Dropping the head therefore takes
 * megabytes produced while the user was watching, and what it costs is the older half of a
 * scrollback that the terminal could not have shown anyway.
 */
const RETAIN_LIMIT_BYTES = 4 * 1024 * 1024;

/** A single frame bigger than this is replayed but not retained, so one frame cannot evict the ring. */
const RETAIN_LIMIT_CHUNKS = 20000;

/**
 * Written before a truncated replay, so the fresh terminal starts from a clean screen:
 * reset attributes, clear the screen, drop the scrollback, home the cursor.
 *
 * Encoded by hand rather than with `TextEncoder`, which the browser-bundle gate's sandbox does not
 * define — and the sequence is ASCII by construction, so `charCodeAt` is the whole of the encoding
 * it needs. Reaching for a global the baseline does not promise is how a plugin fails to load on a
 * page where everything else works.
 */
const RESET_BYTES = new Uint8Array(
  [...'\u001b[0m\u001b[2J\u001b[3J\u001b[H'].map((char) => char.charCodeAt(0))
);

export interface SessionFailure {
  code: string;
  message: string;
  fingerprint: string;
  /** The host a host-key refusal was about — the **bastion** when a jump host is used. */
  host?: string;
  port?: number;
}

/** Which of the session tab's two pages is showing. Part of the tab's surviving state. */
export type SessionPage = 'terminal' | 'sftp';

/**
 * One live terminal.
 *
 * The first block is what a view renders; the second is the machinery. They are one object
 * rather than two because every state change and every protocol callback has to reach the same
 * socket, and splitting them would only add a layer of indirection between the two.
 */
export interface TerminalSession {
  /** The tab this session belongs to: its `contentId` when the frame supplies one. */
  readonly key: string;
  /** When the session was created, so a stale open gesture cannot be adopted by it (see `takeSessionSeed`). */
  readonly createdAt: number;
  /** The server this session is (or was last) pointed at. */
  serverId: string;
  /** The page the user was on, so a tab switch does not silently send them back to 终端. */
  page: SessionPage;
  state: TerminalSessionState;
  failure: SessionFailure | null;
  reason: string;
  /**
   * A failure that happened **before** a socket existed, as an i18n key rather than copy.
   *
   * A key and not the sentence because this module has no translator — the registry is also
   * reachable from `apply`, which has no locale at all. The view resolves it, which is the same
   * rule the rest of the panel follows.
   */
  connectError: string | null;
  trusted: { host: string; port: number } | null;
  /** The host's id for this PTY; what every SFTP read is scoped by. `''` until `terminal.opened`. */
  hostTerminalId: string;

  /* -------------------------------- machinery -------------------------------- */

  socket: WebSocket | null;
  flow: FlowController | null;
  engine: TerminalEngine | null;
  readonly frames: ReturnType<typeof createTerminalFrameHandler>;
  /** True only between `terminal.opened` and teardown; gates keystrokes and fits. */
  opened: boolean;
  /** The ring of bytes a fresh engine replays. Emptied on attach. */
  retained: Uint8Array[];
  retainedBytes: number;
  /** Set when the ring had to drop its head, so the replay can start from a clean screen. */
  truncated: boolean;
  /**
   * True while `attachEngine` is still writing the retained ring into the new engine.
   *
   * Live frames that arrive during that window are held in `replayBacklog` and written after it,
   * so the screen cannot show new output and then paint history over it. See `consume`.
   */
  replaying: boolean;
  replayBacklog: Uint8Array[];
  readonly listeners: Set<() => void>;
  /**
   * Whether this tab's open-time target has already been turned into a connect attempt.
   *
   * On the **session** rather than in a `useRef`, because the decision belongs to the tab and not to
   * a mount: the body is unmounted every time another tab comes to the front, so a fresh ref would
   * let a return visit re-decide — and re-connect — a tab the user is already working in. It is also
   * what stops a late `params` write from retargeting a tab whose connect is already in flight.
   */
  autoConnected: boolean;
  /**
   * Whether the frame's open-tab inventory has ever listed this session's tab.
   *
   * The reaper only removes a session it has seen listed and now does not find, because the
   * inventory starts from saved layouts and a momentarily empty snapshot must not be read as
   * "every tab closed".
   */
  confirmedOpen: boolean;
  /** The tab occurrence's abort signal, kept so a close is noticed even while unmounted. */
  signal?: AbortSignal;
}

const sessions = new Map<string, TerminalSession>();

/* -------------------------- active terminal tracking ----------------------- */

export interface ActiveTerminalState {
  activeKey: string | null;
  activeServerId: string | null;
  activeLabel: string | null;
  isConnected: boolean;
  hasAnyConnected: boolean;
}

let activeSessionKey: string | null = null;
let lastKnownConnectedServerId: string | null = null;
let lastKnownConnectedLabel: string | null = null;
const activeTerminalListeners = new Set<(info: ActiveTerminalState) => void>();

export function getActiveTerminalState(): ActiveTerminalState {
  let active = activeSessionKey ? sessions.get(activeSessionKey) : null;
  const allSessions = Array.from(sessions.values());
  const hasAnyConnected = allSessions.some((s) => s.state.kind === 'connected');

  if (active && active.state.kind === 'connected') {
    lastKnownConnectedServerId = active.serverId;
    lastKnownConnectedLabel = badges.get(active.key)?.label || active.serverId;
  } else if (!active && hasAnyConnected) {
    const connectedSession = allSessions.find((s) => s.state.kind === 'connected');
    if (connectedSession) {
      active = connectedSession;
      lastKnownConnectedServerId = connectedSession.serverId;
      lastKnownConnectedLabel = badges.get(connectedSession.key)?.label || connectedSession.serverId;
    }
  }

  const activeKey = active?.key ?? (hasAnyConnected ? (allSessions.find((s) => s.state.kind === 'connected')?.key ?? null) : null);
  const activeServerId = active?.serverId ?? lastKnownConnectedServerId;
  const activeLabel = (activeKey ? badges.get(activeKey)?.label : null) ?? lastKnownConnectedLabel;
  const isConnected = Boolean(active && active.state.kind === 'connected');

  return {
    activeKey,
    activeServerId,
    activeLabel,
    isConnected,
    hasAnyConnected
  };
}

export function subscribeActiveTerminal(listener: (info: ActiveTerminalState) => void): () => void {
  activeTerminalListeners.add(listener);
  return () => {
    activeTerminalListeners.delete(listener);
  };
}

export function notifyActiveTerminal(): void {
  const state = getActiveTerminalState();
  for (const listener of activeTerminalListeners) {
    try {
      listener(state);
    } catch {}
  }
}

export function markSessionActive(key: string): void {
  if (key && activeSessionKey !== key) {
    activeSessionKey = key;
    notifyActiveTerminal();
  }
}

export function unmarkSessionActive(key: string): void {
  if (key && activeSessionKey === key) {
    activeSessionKey = null;
    notifyActiveTerminal();
  }
}

/**
 * Wake every mounted view of one session. Cheap; views that changed nothing re-render anyway.
 *
 * The listener set is **snapshotted** before the loop, and every call is isolated.
 *
 * A listener is `() => bump()` on a React component, so calling it synchronously flushes an update
 * whose cleanup may unsubscribe (`session.listeners.delete(...)`) — mutating the very `Set` being
 * iterated. A `for…of` over a Set that is modified mid-loop skips elements, and with a
 * `clear()` (see `disposeSession`) the next step reads `undefined` and throws
 * "listener is not a function", mid tab-close. One component throwing must also not stop the
 * other views of the same session from hearing about the change.
 */
function notify(session: TerminalSession): void {
  for (const listener of [...session.listeners]) {
    try {
      listener();
    } catch {
      // A view that throws on re-render must not take the registry down with it.
    }
  }
  notifyActiveTerminal();
}

/* ---------------------------------- badges ---------------------------------- */

/**
 * What one tab's chip says, published by its body and read by its title.
 *
 * The tab strip's chip text is captured by the frame **when the tab opens**
 * (`definition.title(address)`), so it cannot know which server this instance ends up connected
 * to — that is only decided later, by a click inside the body. Two terminals to the same host
 * would therefore be indistinguishable, which is the one thing a tab strip exists to prevent.
 *
 * It lives here, beside the sessions, because a badge is a summary of one session and because
 * the **registry** is what must clear it: a tab can be closed while its body is unmounted, which
 * is exactly the case an unmount-based cleanup cannot see (it was, until this change, why every
 * chip forgot its host the moment the user looked at another tab).
 *
 * Keyed by the same opaque key the sessions use, so a reader only needs `tabKey()`.
 */
export interface TabBadge {
  /** The connected (or targeted) server's label, or '' when this tab has no target yet. */
  label: string;
  kind: 'connecting' | 'connected' | 'problem';
}

const badges = new Map<string, TabBadge>();
const badgeListeners = new Set<() => void>();

/** Record a tab's badge and wake the chips. A no-op when nothing changed. */
export function publishTabBadge(key: string, badge: TabBadge): void {
  if (key === '') return;
  const current = badges.get(key);
  if (current !== undefined && current.label === badge.label && current.kind === badge.kind) return;
  badges.set(key, badge);
  for (const listener of badgeListeners) listener();
  notifyActiveTerminal();
}

/**
 * Drop a tab's badge.
 *
 * Called by `disposeSession` — i.e. when the tab is really gone — and **not** when the body
 * unmounts, which merely means another tab is in front. See the module docblock: getting that
 * distinction wrong is what made every background chip fall back to the bare product name.
 */
export function clearTabBadge(key: string): void {
  if (key === '' || !badges.delete(key)) return;
  for (const listener of badgeListeners) listener();
  notifyActiveTerminal();
}

/** The chip's live view of one tab. Subscribing is what re-renders it on a change. */
export function useTabBadge(key: string): TabBadge | undefined {
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    const listener = (): void => bump();
    badgeListeners.add(listener);
    return () => {
      badgeListeners.delete(listener);
    };
  }, []);
  return key === '' ? undefined : badges.get(key);
}

/* --------------------------------- creation --------------------------------- */

function createSession(key: string): TerminalSession {
  const session: TerminalSession = {
    key,
    createdAt: Date.now(),
    serverId: '',
    page: 'terminal',
    state: { kind: 'idle', text: '' },
    failure: null,
    reason: '',
    connectError: null,
    trusted: null,
    hostTerminalId: '',
    socket: null,
    flow: null,
    engine: null,
    opened: false,
    retained: [],
    retainedBytes: 0,
    truncated: false,
    replaying: false,
    replayBacklog: [],
    listeners: new Set(),
    autoConnected: false,
    confirmedOpen: false,
    frames: createTerminalFrameHandler({
      requestOpen: () => {
        const size = engineSize(session);
        sendWs(session, {
          type: 'terminal.open',
          id: TERMINAL_ID,
          serverId: session.serverId,
          rows: size.rows,
          cols: size.cols
        });
      },
      onOpened: (terminalId: string) => {
        session.opened = true;
        session.state = { kind: 'connected', text: '' };
        session.failure = null;
        // Learned here, before anything can ask for a directory: the file tree can only be
        // scoped to a terminal once the host has named it.
        session.hostTerminalId = terminalId;
        const size = engineSize(session);
        sendWs(session, { type: 'terminal.resize', id: TERMINAL_ID, rows: size.rows, cols: size.cols });
        notify(session);
      },
      onState: (state: TerminalSessionState) => {
        session.state = state;
        notify(session);
      },
      onOutput: (bytes: Uint8Array) => {
        session.flow?.produced(bytes.length);
        consume(session, bytes);
      },
      onError: (failure) => {
        session.failure = failure;
        // A coded failure during the connect attempt ends that attempt. Leaving the panel on
        // "connecting" forever hides the one thing the user can do about it — trust the host
        // (the refusal carries a fingerprint) or retry. An error reported while already
        // connected mid-session leaves the state alone: the session is still the user's.
        if (session.state.kind === 'connecting') session.state = { kind: 'disconnected', text: '' };
        notify(session);
      },
      onClosed: (reason: string) => {
        session.state = { kind: 'disconnected', text: '' };
        session.reason = reason;
        notify(session);
      }
    })
  };
  sessions.set(key, session);
  return session;
}

/**
 * The session for one tab, created on first use.
 *
 * Called during render on purpose. It is the alternative to a mount effect that would leave the
 * first render with no session at all — and therefore with a `null` branch on every field the
 * view draws — while buying nothing: creation runs no `fetch`, opens no socket and touches no
 * DOM, so it is bookkeeping rather than a side effect, and it is idempotent per key, which is
 * what makes it safe under React 18's double-invoked render.
 *
 * The session starts with **no target**. What the tab was opened for is adopted by the body
 * (`adoptSessionTarget`), and not passed in here, because at creation time it may not be readable
 * yet — see `readTabParams`. One path for the target means one place where "the params arrived
 * late" can be handled.
 */
export function ensureSession(key: string): TerminalSession {
  return sessions.get(key) ?? createSession(key);
}

/**
 * The session a tab key names, and a body keyed by `tabId` or `contentId`.
 *
 * A hook rather than a plain read because a session changes from **outside** React: a frame
 * arrives on a socket no component owns, the host reports a new state, a trust request comes
 * back. None of those are a `setState` anywhere, so the view has to be told, and a listener set
 * plus "re-render with the same props" is the shape the chip badge already uses.
 *
 * Subscribing in an effect keyed on `key` rather than on the session keeps the subscription
 * stable when a reaper and a remount race — the body re-subscribes to whatever is current.
 */
export function useSession(key: string): TerminalSession {
  const session = ensureSession(key);
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    const listener = (): void => bump();
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }, [key]);
  return session;
}

/* ------------------------------ the open gesture ----------------------------- */

/**
 * The server a 「在新标签页中连接」 gesture named, held for the tab the frame is about to mint.
 *
 * `params` is the primary channel and the one that survives docking and a reload. This is the
 * **fallback** for the case `readTabParams` documents: the frame records `params` in its own
 * `onCommitted` callback, so the tab's occurrence can legitimately be read before that write lands.
 * A body that adopted the target only from `params` would then open a terminal with nothing
 * selected — the user's "double-click does not connect" report, which this closes by construction
 * rather than by hoping the ordering is favourable.
 *
 * Bounded on purpose, so it cannot become a shadow copy of the tab's own state: single use, and
 * only for a session created *after* the gesture (see `takeSessionSeed`).
 */
const SEED_TTL_MS = 3000;
let seed: { serverId: string; at: number } | null = null;

/** Remember the target of an open gesture. Called by the opener, immediately before `openTab`. */
export function stashSessionSeed(serverId: string): void {
  const wanted = text(serverId);
  seed = wanted === '' ? null : { serverId: wanted, at: Date.now() };
}

/**
 * The seed, if it belongs to a session created at `createdAt` — and consumed either way, so two
 * tabs opened by one gesture cannot both claim it and a tab that predates the gesture never can.
 */
export function takeSessionSeed(createdAt: number): string {
  const held = seed;
  if (held === null) return '';
  if (Date.now() - held.at > SEED_TTL_MS || held.at > createdAt) return '';
  seed = null;
  return held.serverId;
}

/* ---------------------------------- target ---------------------------------- */

/**
 * Point this tab at the server it was opened for.
 *
 * Ignored once the tab is in use — a target the user picked inside the tab, or a connect already in
 * flight, outranks a `params` write that arrives afterwards. That ordering is the point: the frame
 * may deliver the opener's params late, and "late" must not mean "overrides what the user has done
 * since".
 *
 * `source` is diagnostic only, and it is the one fact worth logging here: whether the target came
 * down the frame's own channel (`params`) or from the opener's fallback (`seed`). The second means
 * the frame handed this body nothing, which is worth knowing before trusting `params` alone.
 */
export function adoptSessionTarget(
  session: TerminalSession,
  serverId: string,
  source: 'params' | 'seed' = 'params'
): boolean {
  const wanted = text(serverId);
  if (wanted === '' || session.serverId === wanted) return false;
  if (session.serverId !== '' || session.autoConnected) {
    // Worth a line, because it closes a question the log could not answer before: this is where a
    // frame's `params` lands when the opener's fallback has already been adopted, so the arrival
    // of a *late* params and the *absence* of one used to look identical from the outside — and
    // they call for different fixes.
    postDiagnostic(
      'info',
      `at-terminal target-ignored key=${session.key} serverId=${wanted} source=${source} keeping=${session.serverId}`,
      'session',
      null,
      null
    );
    return false;
  }
  session.serverId = wanted;
  postDiagnostic(
    'info',
    `at-terminal target-adopted key=${session.key} serverId=${wanted} source=${source}`,
    'session',
    null,
    null
  );
  notify(session);
  return true;
}

/**
 * Connect a freshly opened tab, once, to whatever it was opened for.
 *
 * Called from the body's effect on every render whose target it can see, and idempotent per
 * **session**: `autoConnected` is set on the first attempt, so a tab that comes back to the front
 * (a fresh mount, a fresh effect) is never reconnected, and a target adopted one render after the
 * mount still gets its connection — which is the whole reason this is not a mount-time `useRef`.
 *
 * A session that already holds a socket is left alone: the registry exists so the connect happens
 * once per tab, not once per visit.
 */
export function maybeAutoConnect(session: TerminalSession, serverId: string): void {
  const wanted = text(serverId);
  if (wanted === '' || session.autoConnected) return;
  session.autoConnected = true;
  if (session.socket !== null || session.state.kind !== 'idle') return;
  postDiagnostic(
    'info',
    `at-terminal auto-connect key=${session.key} serverId=${wanted}`,
    'session',
    null,
    null
  );
  void connectSession(session);
}

/* --------------------------------- lifetime --------------------------------- */

/**
 * Forget one session, closing its PTY first.
 *
 * `notifyHost: false` where the host is already gone (a socket that closed itself, a page being torn
 * down) — sending `terminal.close` into a dead socket is noise, and the host reaps the PTY when
 * the connection drops anyway.
 *
 * The tab's badge is cleared too, and by the registry rather than by the body: a tab can be
 * closed while its body is unmounted, which is exactly the case the old unmount-based cleanup
 * could not see.
 *
 * `why` is diagnostic only, and every caller passes one. It is the answer to the one question this
 * module cannot answer from the outside — *which* of the four paths ended a session — and without it
 * a connection that dies while its tab is in the background leaves no trace at all: the body that
 * would have logged the state change is unmounted.
 */
export function disposeSession(key: string, notifyHost = true, why = 'unspecified'): void {
  const session = sessions.get(key);
  if (session === undefined) return;
  postDiagnostic(
    'info',
    `at-terminal dispose key=${key} why=${why} socket=${session.socket === null ? 'none' : 'open'} state=${session.state.kind} target=${session.serverId}`,
    'session',
    null,
    null
  );
  sessions.delete(key);
  teardown(session, notifyHost);
  clearTabBadge(key);
  // Snapshot, clear, then call: `disposeSession` is the one place that both notifies and empties
  // the set, so iterating it live is guaranteed to race its own listeners' unsubscribe.
  const listeners = [...session.listeners];
  session.listeners.clear();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // See `notify`: one broken view must not abort the teardown of the session.
    }
  }
  notifyActiveTerminal();
}

/** Every session this page holds. Only the plugin's own teardown should need this. */
export function disposeAllSessions(why = 'unload'): void {
  for (const key of [...sessions.keys()]) disposeSession(key, true, why);
}

/**
 * The content ids the frame's open-tab inventory last listed.
 *
 * Kept because one of the two things that can end a session is the occurrence signal, and that
 * signal on its own is not proof: it is read here purely as a **cross-check** (see
 * `retainSessionSignal`). Written by `retainSessions`, which `main.ts` subscribes to the inventory.
 */
const openKeys = new Set<string>();

/**
 * Reconcile with the frame's open-tab inventory: mark what is open, reap what is gone.
 *
 * This is the official `webTerminals.retainTabs` shape, and holding is the half that matters — a
 * listed tab keeps its connection whether or not its body is mounted, which is what makes switching
 * tabs free. Reaping is deliberately narrow, because the two ways to get it wrong cost very
 * different things: a false positive kills an SSH session the user is using, a false negative leaves
 * one until `disposeAllSessions` sweeps it on unload.
 *
 * So a session is reaped only when the inventory has dropped its key **and** one of these holds:
 *
 * - its occurrence signal has already aborted — the tab's record left the layout, which is the
 *   frame's own account of the same event; or
 * - no signal was ever registered, so nothing else will ever speak for the session.
 *
 * The inventory alone is not enough. It is a **derived** view — assembled per session store, and a
 * store that is re-adopted publishes an empty membership for the moment before its layout lands —
 * and reading that moment as "every tab closed" is a plausible way for a background terminal to be
 * killed by the very subscription that is supposed to be holding it open. Requiring the signal to
 * agree makes the reaper act only on two witnesses.
 */
export function retainSessions(tabs: ReadonlyArray<{ contentId?: unknown }>): void {
  const open = new Set<string>();
  for (const tab of tabs) {
    const contentId = tab.contentId;
    if (typeof contentId === 'string' && contentId !== '') open.add(contentId);
  }
  recordInventory(open);
  for (const [key, session] of [...sessions]) {
    if (open.has(key)) {
      session.confirmedOpen = true;
      continue;
    }
    if (!session.confirmedOpen) continue;
    if (session.signal !== undefined && !session.signal.aborted) {
      // Contradiction: the frame still holds this tab's occurrence, so it has not been closed —
      // whatever emptied this snapshot was something else.
      postDiagnostic(
        'info',
        `at-terminal inventory-drop-ignored key=${key} (occurrence not aborted)`,
        'session',
        null,
        null
      );
      continue;
    }
    disposeSession(key, true, 'inventory-reap');
  }
}

/** Replace the cached inventory and log the change — the one line that shows a held session losing its tab. */
function recordInventory(open: ReadonlySet<string>): void {
  const next = [...open].sort().join(' ');
  const previous = [...openKeys].sort().join(' ');
  openKeys.clear();
  for (const key of open) openKeys.add(key);
  if (next !== previous) {
    postDiagnostic('info', `at-terminal inventory [${next}]`, 'session', null, null);
  }
}

/**
 * Tie a session's life to its tab occurrence.
 *
 * `tab.signal` aborts when the tab's record leaves the layout — a real close, a docking away, an
 * unload — and **not** when the body merely stops being the visible one. Registering the
 * listener here rather than in the body's cleanup is the point: the body is unmounted exactly
 * when a close is most likely to arrive, so a listener that lives with the body would miss it.
 *
 * The abort is **cross-checked against the inventory** before it is believed, because a session that
 * dies while its tab is still open is the worse of the two failures and the harder one to notice.
 * A real removal is visible to both witnesses — `TabDomain.sync` aborts the signal from the same
 * layout commit that empties the inventory entry, and the inventory is published first — so an abort
 * that arrives while the frame still lists the tab did not mean "the tab is gone", and acting on it
 * would be acting on evidence the frame itself contradicts.
 */
export function retainSessionSignal(session: TerminalSession, signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (session.signal === signal) {
    if (signal.aborted) closeOnSignalAbort(session);
    return;
  }
  session.signal = signal;
  signal.addEventListener('abort', () => closeOnSignalAbort(session));
  if (signal.aborted) closeOnSignalAbort(session);
}

/** The occurrence's abort arrived. Believe it only if the inventory agrees the tab is gone. */
function closeOnSignalAbort(session: TerminalSession): void {
  if (openKeys.has(session.key)) {
    postDiagnostic(
      'info',
      `at-terminal occurrence-abort-ignored key=${session.key} (tab still listed)`,
      'session',
      null,
      null
    );
    return;
  }
  disposeSession(session.key, false, 'occurrence-abort');
}

/**
 * Whether this session's PTY is live enough that retargeting it would be a lie.
 *
 * `connected` and `connecting` both count. `connecting` is the one that actually needs the
 * guard: the socket is already open and the PTY is about to be requested for `serverId`, so a
 * retarget accepted in that window changes what the status bar and the tab chip **say** while
 * the PTY is being opened against the old server — the "chip says B, PTY is on A" report.
 *
 * `disconnected` deliberately does not count: the PTY is gone, so picking a new server and
 * pressing 连接 is exactly what the user should be able to do next.
 */
export function isSessionLive(session: TerminalSession): boolean {
  return session.state.kind === 'connected' || session.state.kind === 'connecting';
}

/**
 * Point the session at another server, from inside the tab. Does not connect; the view connects when asked.
 *
 * Refuses while live, and the view **also** disables the selector — two independent guards for
 * one rule, because they fail differently. The disabled attribute is what the user sees and what
 * a keyboard user hits; this check is what a programmatic call (a shortcut, a future "connect
 * here" menu item, a stale closure) hits. Either one alone leaves a hole: a disabled control can
 * still be driven through `onChange` by a test or a script, and a guard alone would let the user
 * change a selector whose value then silently snaps back.
 */
export function setSessionTarget(session: TerminalSession, serverId: string): void {
  if (session.serverId === serverId) return;
  if (isSessionLive(session)) {
    postDiagnostic(
      'info',
      `at-terminal target-locked key=${session.key} wanted=${serverId} keeping=${session.serverId} state=${session.state.kind}`,
      'session',
      null,
      null
    );
    return;
  }
  session.serverId = serverId;
  notify(session);
}

/**
 * Record a failure without touching the socket, and wake the views.
 *
 * Used by the trust actions, whose own RPC can fail *after* the connection was cleared — the
 * session is still the user's, so only the banner changes.
 */
export function setSessionFailure(session: TerminalSession, failure: SessionFailure): void {
  session.failure = failure;
  notify(session);
}

/** Remember which page the user is on, so a tab switch comes back to it. */
export function setSessionPage(session: TerminalSession, page: SessionPage): void {
  if (session.page === page) return;
  session.page = page;
  notify(session);
}

/* --------------------------------- the wire --------------------------------- */

/** Send one already-built frame, if this session's socket is open. */
function sendWs(session: TerminalSession, message: Record<string, unknown>): void {
  const socket = session.socket;
  if (socket === null || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    /* a socket that died between the check and the write is disposed by onclose */
  }
}

/**
 * One keystroke or paste, for the remote PTY.
 *
 * Gated on `opened`: the engine starts fitting (and users start typing) the moment the pane turns
 * visible, which is while the SSH connect is still in flight. Frames for a PTY that does not exist
 * yet are noise — the size is re-reported on `terminal.opened`, and keystrokes before a shell
 * exists have nowhere to go.
 */
export function sendSessionInput(session: TerminalSession, data: string): void {
  if (data === '' || !session.opened) return;
  sendWs(session, { type: 'terminal.input', id: TERMINAL_ID, data });
}

/** The fitted grid changed; report `terminal.resize`. Dropped before the PTY exists, per above. */
export function sendSessionResize(session: TerminalSession, rows: number, cols: number): void {
  if (!session.opened) return;
  sendWs(session, { type: 'terminal.resize', id: TERMINAL_ID, rows, cols });
}

/** The grid to open with: the attached engine's, or the VT default while none is. */
function engineSize(session: TerminalSession): { rows: number; cols: number } {
  const engine = session.engine;
  if (engine !== null && engine.rows > 0 && engine.cols > 0) {
    return { rows: engine.rows, cols: engine.cols };
  }
  return { rows: 24, cols: 80 };
}

/**
 * Retain one chunk of remote output, and render it if there is a renderer.
 *
 * Retaining is **unconditional**, which is the correction this function needed. The ring is not a
 * "what did I miss" buffer — with the engine disposed on every unmount it is the only copy of the
 * screen, so it must hold everything, exactly as it arrives. Retaining only while detached kept a
 * copy of what arrived while nobody was looking, i.e. almost nothing: the user's prompt was sent
 * while the tab was in front, so it was rendered and forgotten, and coming back rebuilt an empty
 * terminal.
 *
 * Two consequences of the ordering, both deliberate. The ring is written **before** the renderer,
 * so a `writeOutput` that throws — a disposed engine, a renderer that lost its context — cannot
 * cost the session its bytes. And retention no longer depends on the body's cleanup having run:
 * because the bytes are kept whether or not an engine is attached, a `session.engine` left behind
 * by an unmount can delay the *renderer* but can never stop the *record*.
 *
 * `acknowledge` stays the flow controller's debit, and it is still only called once the bytes have
 * really reached xterm — while detached nothing debits, which is what keeps the host paused and the
 * ring from pulling an unbounded stream.
 */
function dropRetainedHead(session: TerminalSession, count: number): void {
  if (count <= 0) return;
  if (count >= session.retained.length) {
    session.retained = [];
    session.retainedBytes = 0;
    return;
  }
  session.retained.splice(0, count);
}

export function consume(session: TerminalSession, bytes: Uint8Array): void {
  session.retained.push(bytes);
  session.retainedBytes += bytes.length;
  // Both ceilings are needed: a byte ceiling alone lets a chatty shell pin tens of thousands of
  // tiny frames (one keystroke echo is one frame), and a chunk ceiling alone lets a few large
  // frames hold megabytes. Dropping the head is what `truncated` records.
  if (
    session.retained.length > RETAIN_LIMIT_CHUNKS ||
    session.retainedBytes > RETAIN_LIMIT_BYTES
  ) {
    session.truncated = true;
    let dropCount = 0;
    let droppedBytes = 0;
    while (
      (session.retained.length - dropCount > RETAIN_LIMIT_CHUNKS ||
        session.retainedBytes - droppedBytes > RETAIN_LIMIT_BYTES) &&
      dropCount < session.retained.length
    ) {
      droppedBytes += session.retained[dropCount].length;
      dropCount += 1;
    }
    session.retainedBytes -= droppedBytes;
    dropRetainedHead(session, dropCount);
  }
  const engine = session.engine;
  if (engine === null) return;
  /*
   * A live chunk that arrives mid-replay is held until the replay has reached xterm.
   *
   * `attachEngine` writes the whole retained ring (up to 64 KB per call) and then returns; the
   * frames that arrived while this tab was hidden keep coming the moment the socket is live again.
   * xterm queues writes in call order, but the batch is composed *synchronously* only because
   * `flushBatch` runs in one loop — the switch back to the tab re-runs the whole body, and a
   * `terminal.output` frame can be dispatched between the last `writeOutput` of the replay and its
   * acknowledgement callback. When that happened the new output was painted first and then typed
   * over by history from an older cursor position, which looks like garbled text until the remote
   * repaints. Holding the chunk here — and flushing in order from the replay's last
   * acknowledgement — keeps the screen monotonic without buffering anything unbounded: the hold is
   * only ever as long as the ring being written.
   */
  if (session.replaying) {
    session.replayBacklog.push(bytes);
    return;
  }
  engine.writeOutput(bytes, (byteLength) => session.flow?.rendered(byteLength));
}

/**
 * Close the socket and everything the transport owned. `notifyHost` asks the host to close the PTY.
 *
 * The ring is deliberately **not** cleared here. A disconnect leaves a screen behind — the engine
 * keeps it, and the user can switch tabs and come back to it, which is the "keep the screen and
 * offer a reconnect" the plan records as the intended behaviour for a dropped connection. What
 * clears the ring is the start of a **new shell** (`connectSession`), where the previous shell's
 * bytes would otherwise be replayed into a terminal that never produced them.
 */
function teardown(session: TerminalSession, notifyHost: boolean): void {
  session.opened = false;
  // The host mints a new terminalId per session, so the old one is dead the moment this socket
  // goes. Leaving it would have the file tree address a session that no longer exists.
  session.hostTerminalId = '';
  session.flow?.reset();
  session.flow = null;
  const socket = session.socket;
  session.socket = null;
  if (socket === null) return;
  if (notifyHost) {
    try {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'terminal.close', id: TERMINAL_ID }));
    } catch {
      /* closing anyway */
    }
  }
  // Detach first: `close()` fires onclose, and re-entering the handler would leak a torn-down
  // socket back into state.
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  try {
    socket.close();
  } catch {
    /* already closed */
  }
}

/**
 * Open (or re-open) this session's PTY, against whatever server it is pointed at.
 *
 * Reconnecting is the same call as connecting: the old socket is torn down first, without
 * notifying the host — the close makes the host reap the PTY, and a `terminal.close` for a
 * session it is about to see die is a race it does not need.
 */
export async function connectSession(session: TerminalSession): Promise<void> {
  const wanted = text(session.serverId);
  if (wanted === '') {
    session.connectError = 'terminal.pick';
    session.page = 'terminal';
    notify(session);
    return;
  }
  session.serverId = wanted;
  session.connectError = null;
  session.failure = null;
  session.reason = '';
  session.trusted = null;
  session.page = 'terminal';
  teardown(session, false);
  // A new PTY is a new screen, and this is the **only** place the ring is emptied. Every other way
  // a connection ends keeps the screen on purpose (see `teardown`); a fresh shell, though, must not
  // open onto the output of the one that just died.
  session.retained = [];
  session.retainedBytes = 0;
  session.truncated = false;
  notify(session);

  // The address source depends on how the page is served. An http(s) page (the web GUI, a LAN
  // browser) derives it from its own origin — asking the host there would answer `127.0.0.1`,
  // which a remote browser cannot use. The desktop shell serves `dsh-app://app`, whose
  // `location.host` is a name nothing can connect to: relative fetch is bridged by the shell,
  // but a WebSocket is not, so the host's reported loopback endpoint is the only authority.
  const pageLocation = typeof window === 'undefined' ? undefined : window.location;
  const pageHasWebOrigin =
    pageLocation !== undefined &&
    (pageLocation.protocol === 'http:' || pageLocation.protocol === 'https:');

  let url: string;
  try {
    if (pageHasWebOrigin) {
      url = resolveSocketUrl(pageLocation, null);
    } else {
      const endpoints = (await callRpc('channel.info', {}).catch(() => null)) as ChannelEndpoints | null;
      url = resolveSocketUrl(pageLocation, endpoints);
    }
  } catch (error) {
    session.state = { kind: 'idle', text: '' };
    session.connectError = asFailure(error).code === 'no-origin' ? 'terminal.noOrigin' : 'terminal.noWsEndpoint';
    notify(session);
    return;
  }
  if (sessions.get(session.key) !== session) return;

  const WebSocketImpl =
    typeof window !== 'undefined' && typeof window.WebSocket === 'function'
      ? window.WebSocket
      : undefined;
  if (WebSocketImpl === undefined) {
    session.state = { kind: 'idle', text: '' };
    session.connectError = 'terminal.noWebSocket';
    notify(session);
    return;
  }

  /*
   * Re-check liveness immediately before opening the socket.
   *
   * The one check above sits after the endpoint `await`, and the work between it and this line is
   * synchronous — but `notify()` below flushes React updates, and a flush is re-entrant: a cleanup
   * that closes this tab runs `disposeSession`, which deletes the session from the map and nulls
   * its socket. Without this second check that path still opened a WebSocket for a tab nobody can
   * see any more; the host then minted a PTY whose only handle was this closure, so nothing ever
   * closed it.
   */
  if (sessions.get(session.key) !== session) return;

  session.flow = createFlowController({
    onPauseChange: (paused) => sendWs(session, { type: 'terminal.pause', id: TERMINAL_ID, paused })
  });
  session.state = { kind: 'connecting', text: '' };
  notify(session);

  // ...and once more after the flush: everything after this point acts on the socket.
  if (sessions.get(session.key) !== session) {
    session.flow?.reset();
    session.flow = null;
    return;
  }

  const socket = new WebSocketImpl(url);
  session.socket = socket;
  socket.onopen = () =>
    postDiagnostic('info', `at-terminal ws-open key=${session.key} url=${url}`, 'session', null, null);
  socket.onmessage = (event: { data?: unknown }) => session.frames.handle(event?.data);
  // The three socket events are logged because a session that dies while its tab is in the
  // background has no body left to render the state change: without these lines the only evidence
  // is that the terminal is dead when the user comes back, which says nothing about who closed it.
  socket.onerror = () => {
    postDiagnostic('error', `at-terminal ws-error key=${session.key} url=${url}`, 'session', null, null);
    session.opened = false;
    session.failure = { code: 'websocket-error', message: url, fingerprint: '' };
    session.state = { kind: 'disconnected', text: '' };
    notify(session);
  };
  socket.onclose = (event?: { code?: unknown; reason?: unknown; wasClean?: unknown }) => {
    if (session.socket !== socket) return;
    postDiagnostic(
      'info',
      `at-terminal ws-close key=${session.key} code=${String(event?.code ?? '?')} clean=${String(event?.wasClean ?? '?')} reason=${String(event?.reason ?? '')}`,
      'session',
      null,
      null
    );
    session.socket = null;
    session.opened = false;
    if (session.state.kind !== 'disconnected') session.state = { kind: 'disconnected', text: '' };
    notify(session);
  };
}

/** The user's 断开: close the PTY here and on the host, and leave the session in place. */
export function disconnectSession(session: TerminalSession): void {
  teardown(session, true);
  session.state = { kind: 'disconnected', text: '' };
  session.reason = '';
  notify(session);
}

/* --------------------------------- the engine -------------------------------- */

/**
 * Give the session a renderer, and catch it up on everything it has produced.
 *
 * Replaying from the ring is what makes a tab switch look like nothing happened, and it is the only
 * thing that can: the previous engine was disposed with its body, so the screen exists nowhere else.
 * Two details carry it — the reset sequence goes first when the ring had to drop its head, so the
 * replay starts from a clean screen rather than mid-escape-sequence, and the replay's `acknowledge`
 * is the real one, because for every chunk that arrived while detached these *are* the
 * produced-but-unrendered bytes the host paused on.
 *
 * Re-acknowledging bytes that were rendered before is harmless and honest at the same time: xterm
 * really is consuming them again, and the flow controller clamps its counter at zero, so the
 * settlement can only ever land on "nothing outstanding" — which is where a full replay leaves it.
 *
 * The ring is left **intact**. Emptying it here was this function's first shape, and it costs the
 * history one visit at a time: the next switch away would replay only what had been produced since
 * this attach, so a terminal came back progressively emptier.
 *
 * The `replay` line is the evidence for all of it. `chunks=0` on a tab that was showing a prompt a
 * moment ago is the whole defect, stated in one line.
 */
export function attachEngine(session: TerminalSession, engine: TerminalEngine): void {
  session.engine = engine;
  const { retained, truncated } = session;
  // Whatever `consume` held from a previous attach is part of the ring now; it will be written by
  // this replay in order, so the backlog starts empty.
  session.replayBacklog = [];
  session.replaying = true;
  const drainBacklog = (): void => {
    session.replaying = false;
    const held = session.replayBacklog;
    session.replayBacklog = [];
    for (const bytes of held) {
      engine.writeOutput(bytes, (byteLength) => session.flow?.rendered(byteLength));
    }
  };
  if (truncated) {
    engine.writeOutput(RESET_BYTES, () => undefined);
  }
  // Batch chunks up to 64KB per write to avoid tens of thousands of engine calls
  const BATCH_LIMIT = 64 * 1024;
  let batchBuffer: Uint8Array[] = [];
  let batchBytes = 0;

  const flushBatch = () => {
    if (batchBuffer.length === 0) return;
    if (batchBuffer.length === 1) {
      const b = batchBuffer[0];
      engine.writeOutput(b, (byteLength) => session.flow?.rendered(byteLength));
    } else {
      const merged = new Uint8Array(batchBytes);
      let offset = 0;
      for (const piece of batchBuffer) {
        merged.set(piece, offset);
        offset += piece.length;
      }
      engine.writeOutput(merged, (byteLength) => session.flow?.rendered(byteLength));
    }
    batchBuffer = [];
    batchBytes = 0;
  };

  for (const bytes of retained) {
    batchBuffer.push(bytes);
    batchBytes += bytes.length;
    if (batchBytes >= BATCH_LIMIT) flushBatch();
  }
  flushBatch();
  /*
   * The replay ends here — the loop above is synchronous, so this is the first moment a live chunk
   * may be written. `writeOutput` appends to xterm's queue in call order, which is exactly the
   * ordering the backlog needs: every retained byte is queued before any held live byte.
   *
   * Draining synchronously (rather than on a microtask or the replay's last acknowledgement) is
   * what keeps `consume` from silently swallowing frames that arrive after `attachEngine` returned
   * — a later callback would make the backlog's lifetime depend on xterm's parse schedule, and a
   * session detached in between would hold bytes nobody writes.
   */
  drainBacklog();
  postDiagnostic(
    'info',
    `at-terminal replay key=${session.key} chunks=${retained.length} bytes=${session.retainedBytes} truncated=${String(truncated)}`,
    'session',
    null,
    null
  );
  engine.fit();
}

/** The renderer went away with its body. The session keeps every byte it has not yet given out. */
export function detachEngine(session: TerminalSession, engine: TerminalEngine): void {
  if (session.engine === engine) session.engine = null;
}

/* ------------------------------- host-key trust ------------------------------ */

/**
 * Record the fingerprint the user just accepted, then reconnect.
 *
 * Reconnecting on the user's behalf is the whole point of accepting a key: making them navigate
 * back and click 连接 again turns one decision into three steps — and after a jump-host refusal
 * the retry is the only way to find out whether the *next* key in the chain also needs accepting.
 */
export async function trustSessionHost(session: TerminalSession): Promise<void> {
  const refused = session.failure;
  if (refused === null) return;
  const result = (await callRpc('terminal.trustHost', {
    serverId: text(session.serverId),
    fingerprint: text(refused.fingerprint),
    // The refused host, not the selected one: with a jump host these differ, and sending only
    // the serverId records the accepted key under the wrong address — which is what left the
    // bastion permanently untrusted while the store looked updated.
    ...(refused.host === undefined
      ? {}
      : { host: refused.host, ...(refused.port === undefined ? {} : { port: refused.port }) })
  })) as { host?: unknown; port?: unknown } | null;
  const payload = result ?? {};
  // Cleared before the reconnect, so the confirmation line survives the state the reconnect
  // sets — `connectSession` publishes `connected` and would otherwise wipe what was just said.
  session.failure = null;
  const retry = connectSession(session);
  session.trusted = { host: text(payload.host), port: Number(payload.port) || 0 };
  notify(session);
  await retry;
}

/** Forget the stored key for the refused host, then retry. The escape hatch from a bad record. */
export async function forgetSessionHost(session: TerminalSession): Promise<void> {
  const refused = session.failure;
  if (refused === null) return;
  const result = (await callRpc('terminal.forgetHost', {
    serverId: text(session.serverId),
    ...(refused.host === undefined
      ? {}
      : { host: refused.host, ...(refused.port === undefined ? {} : { port: refused.port }) })
  })) as { host?: unknown; port?: unknown } | null;
  const payload = result ?? {};
  session.failure = null;
  const retry = connectSession(session);
  session.trusted = { host: text(payload.host), port: Number(payload.port) || 0 };
  notify(session);
  await retry;
}

/**
 * A refusal the view can act on: one that carries a fingerprint.
 *
 * Kept here rather than in the view because both trust and forget start from it, and a view that
 * decided "is this actionable?" for itself is how the trust button ends up rendered for a
 * `websocket-error` that has nothing to trust.
 */
export function refusedHostKey(session: TerminalSession): SessionFailure | null {
  return session.failure !== null && session.failure.fingerprint !== '' ? session.failure : null;
}
