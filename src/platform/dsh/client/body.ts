/**
 * The **资产** tab's body, plus the tab infrastructure both bodies share.
 *
 * This file used to be one body that carried the server list, the connection form, the file
 * tree and the terminal behind a three-way page switch. It is now the half that manages
 * **servers**: the list, the form, import/export — and a double-click that opens a *session* tab
 * for the row (see `body-session.ts` for the other half, and `channel.ts` for why they are two
 * tab kinds rather than two pages of one).
 *
 * What stays here is what either half needs and neither owns:
 *
 * - the locale bridge (`BodyLocale` / `wrapWithLocale`), because the framework injects the
 *   tab's *record* into a seat, not copy;
 * - the tab-identity readers, each with the hook-discipline rule spelled out on `readTabId`;
 * - `AtTerminalTitle`, the chip both kinds register.
 */

import React, { type ReactElement } from 'react';

import { callRpc, KIND_SESSION, postDiagnostic } from './channel';
import {
  asFailure,
  buildServerInput,
  count,
  emptyForm,
  formFromServer,
  rpcError,
  saveDownload,
  serverViews,
  text,
  validateForm,
  type FormModel,
  type ServerView,
  type Translate
} from './models';
import { useTabBadge } from './sessions';
import { readAssetsState, saveAssetsState } from './tabState';
import { renderAssetsView, type AssetSummary } from './views/assets';
import {
  renderConfirmDialog,
  renderExportDialog,
  renderImportDialog,
  type ConfirmDialogProps,
  type ExportDone,
  type ExportFailed,
  type ExportState,
  type ImportDone,
  type ImportFailed,
  type ImportState,
  type ImportSummary
} from './views/dialogs';
import { renderFormView, type SaveDone, type SaveFailed, type SaveState } from './views/form';
import { h, failedState, pendingState, renderFailure, type AsyncState, type El } from './views/shared';
import type { TerminalUiSettings } from './xtermEngine';

const DEFAULT_UI_SETTINGS: TerminalUiSettings = {
  fontSize: 14,
  fontFamily: 'Cascadia Code, Menlo, monospace',
  scrollback: 10000,
  semanticHighlight: true,
  zebraStripes: false
};

/**
 * The bodies need a translator, and the framework's automatic tab-info injection carries the
 * tab's record, not copy — so `apply` hands the namespace-bound `t` down through a context of
 * our own.
 */
export const BodyLocale = React.createContext<Translate>((key) => key);

/** What `apply` lends a body beyond copy: the one action a body cannot perform itself. */
export interface BodyExtras {
  openSessionTab?: (serverId: string) => boolean;
  openMonitorTab?: (options?: { serverId?: string; target?: 'hardware' | 'agent_execution'; mode?: 'float' | 'hud' | 'tab' }) => boolean;
  onFloat?: (tabId: string) => void;
  [key: string]: unknown;
}

/**
 * Bind our `t` into `BodyLocale` around one body component.
 *
 * `extras` are merged **before** `props`, never after — see `BodyExtras`.
 */
export function wrapWithLocale<P = any>(
  Component: (props: P) => any,
  t: Translate,
  extras: BodyExtras = { openSessionTab: () => false }
): (props: Record<string, unknown>) => ReactElement {
  return function LocaleBoundBody(props: Record<string, unknown>): ReactElement {
    return h(BodyLocale.Provider, { value: t }, h(Component as any, { t, ...extras, ...props }));
  };
}

/* ------------------------------- tab identity -------------------------------- */

/**
 * The tab record the frame injects, or `undefined` when there is none.
 *
 * `useTabInfo` arrives as a **prop** on both of our seats — the frame injects
 * `{ hooks: { tabInfo } }` into the keyed `sidebar.right.pane.tab[.title]` seats and the hook
 * becomes a prop. A hook that throws is caught rather than allowed to escape: a missing or
 * throwing `useTabInfo` must degrade to "no tab identity" (a working panel with a static chip)
 * instead of taking the whole right sidebar down.
 *
 * **Never call this from inside another hook's callback.** `useState(() => readTabId(props))` was
 * the outage: a lazy initialiser runs *inside* `mountState`, so the framework's own `useMemo` was
 * dispatched in the middle of `useState`'s hook entry and left the fiber's hook list
 * inconsistent — one good frame, then a dead subtree (`React error #311`). The official
 * `terminal` type shows the intended shape: read it straight in the component body, every render.
 * `test/dsh/client-hooks.test.ts` enforces exactly that, structurally.
 */
function tabRecord(props: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const hook = props?.useTabInfo;
  if (typeof hook !== 'function') return undefined;
  try {
    const info = (hook as () => { tab?: unknown })();
    const tab = info?.tab;
    return tab !== null && typeof tab === 'object' ? (tab as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** This tab's frame-assigned id, or '' when the frame has not supplied one. */
export function readTabId(props: Record<string, unknown> | undefined): string {
  const id = tabRecord(props)?.id;
  return typeof id === 'string' ? id : '';
}

/**
 * The identity a session, a badge and a target are all filed under.
 *
 * `contentId` when the frame supplies one, because that is the **page instance's** durable
 * address: `placeTab` mints `${pageAddress(kind)}/${randomUUID()}` for a `multiple` type, and the
 * registry persists it, so the same terminal keeps the same identity through docking, a pane
 * move and a reload. `tab.id` is layout-local and only unique within a pane.
 *
 * Falls back to `tab.id`, then to `''` — a body rendered outside any frame (the bundle test
 * does exactly that) must still work, and within one page a single session is unambiguous.
 */
export function readTabKey(props: Record<string, unknown> | undefined): string {
  const tab = tabRecord(props);
  const contentId = tab?.contentId;
  if (typeof contentId === 'string' && contentId !== '') return contentId;
  const id = tab?.id;
  return typeof id === 'string' ? id : '';
}

/** This tab's kind, or '' — what the chip title uses to pick its own fallback copy. */
export function readTabKind(props: Record<string, unknown> | undefined): string {
  const kind = tabRecord(props)?.kind;
  return typeof kind === 'string' ? kind : '';
}

/**
 * What this tab was opened **for** — the frame's navigation params, carried by `openTab`'s
 * `options.params` and reachable from `useTabInfo().tab.navigation`.
 *
 * One read, at the moment it is called. That is all a caller who is already re-rendering needs, and
 * it is deliberately the only thing this does: **it is not, on its own, the way to learn the target
 * of a tab that is still being opened.**
 *
 * `TabDomain.navigate`'s contract reads as a guarantee — *"A record the layout has not yet shown the
 * seat gets its occurrence here, so the body's first render already carries the opener's
 * `params`."* — and it holds for the occurrence. It does **not** say the write has already landed in
 * the occurrence the seat read: the seat reconciles the layout with `params: undefined` while the
 * params ride the `onCommitted` callback (`place()`, `dsh-client-ui-sidebar-right`), and both orders
 * are reachable. A body that reads this once at mount therefore commits to whichever order it
 * happened to catch — which is exactly the failure that made a double-clicked asset open a terminal
 * tab with nothing selected. Callers that must not miss the write use `useTabParams`.
 */
export function readTabParams(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const params = readTabNavigation(props)?.getSnapshot?.()?.params;
  return params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

/**
 * This tab's navigation handle, exactly as the frame exposes it on `useTabInfo().tab`.
 *
 * A handle rather than the params themselves, because the two things a caller needs are different:
 * `getSnapshot()` to read, `subscribe()` to hear about a write. And a write **does** happen after
 * the first render — the frame records the opener's `params` in its own `onCommitted` callback
 * (`dsh-client-ui-sidebar-right` → `place()` → `tabDomain.navigate`), while the occurrence may be
 * created a moment earlier by the seat's reconciliation with `params: undefined`.
 *
 * That window is invisible from inside a body unless it subscribes, and that is the whole reason
 * this exists: `useTabInfo` re-renders on **layout** changes only — its `useMemo` lists the
 * navigation *handle* among its deps, and the handle's identity is stable for the tab's lifetime,
 * so a `params` write alone re-renders nothing. Reading `params` once at mount therefore reads
 * whatever was there at that instant, forever.
 */
export function readTabNavigation(
  props: Record<string, unknown> | undefined
): {
  getSnapshot?: () => { params?: unknown };
  subscribe?: (listener: () => void) => (() => void) | undefined;
} | null {
  const navigation = tabRecord(props)?.navigation;
  return navigation !== null && typeof navigation === 'object'
    ? (navigation as { getSnapshot?: () => { params?: unknown } })
    : null;
}

/**
 * This tab's `params`, kept live.
 *
 * The subscription is what makes "the frame will tell the body what it was opened for" true for a
 * body whose first render beats the frame's write: the store's `subscribe` fires on the write, and
 * `bump()` re-renders so the caller reads the new params on the next pass. A frame (or a harness)
 * whose navigation handle has no `subscribe` degrades to the mount-time value rather than throwing.
 *
 * The comparison is on the serialised params, so the extra re-renders a store subscription can
 * deliver for unrelated revisions cost nothing.
 */
export function useTabParams(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const navigation = readTabNavigation(props);
  const propsRef = React.useRef(props);
  propsRef.current = props;
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  const seenRef = React.useRef(JSON.stringify(readTabParams(props)));

  React.useEffect(() => {
    if (navigation === null || typeof navigation.subscribe !== 'function') return undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = navigation.subscribe(() => {
        const next = JSON.stringify(readTabParams(propsRef.current));
        if (next === seenRef.current) return;
        seenRef.current = next;
        bump();
      });
    } catch {
      /* a handle that cannot be subscribed to still reads; see above */
    }
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [navigation]);

  return readTabParams(props);
}

/**
 * This tab's **occurrence lifetime** — the signal that aborts when the tab's record leaves the
 * layout, and *not* when this body merely stops being the visible one.
 *
 * That distinction is the entire reason it exists: a body unmounts whenever another tab comes to
 * the front, so an unmount is not a close. The frame aborts this signal from `TabDomain.sync`
 * when `layout.tabs[tabId]` is gone (`sidebar-right/lib/client.js:6084-6087`), i.e. on a real
 * close, docking away, or plugin unload.
 *
 * `undefined` against an older frame that supplies no signal — callers then keep a coarser
 * signal rather than losing the cleanup entirely.
 */
export function readTabSignal(props: Record<string, unknown> | undefined): AbortSignal | undefined {
  const signal = tabRecord(props)?.signal;
  return signal !== null && typeof signal === 'object' && 'aborted' in (signal as object)
    ? (signal as AbortSignal)
    : undefined;
}

/* --------------------------------- the chip ---------------------------------- */

/**
 * The chip title shown in the tab strip, for **either** kind.
 *
 * Falls back to the static product name when the body has published nothing — the chip is
 * rendered for every tab including ones whose body has not mounted, so a label is the honest
 * answer rather than a blank. The 资产 tab never publishes a badge, so it always shows its own
 * name; a 终端 tab shows `AT 终端 · <server>` as soon as it has a target.
 */
export function AtTerminalTitle(props: Record<string, unknown>): ReactElement {
  const t = React.useContext(BodyLocale);
  const key = readTabKey(props);
  const kind = readTabKind(props);
  const badge = useTabBadge(key);
  // Breadcrumb for the **title** seat, which renders in its own component instance and can
  // therefore fail independently of the body. A title breadcrumb with no body breadcrumb (or
  // vice versa) is what separates "the body never mounted" from "the chip title threw".
  React.useEffect(() => {
    postDiagnostic(
      'info',
      `at-terminal title rendered tab=${key || '(none)'} badge=${badge === undefined ? 'none' : badge.kind}`,
      'title',
      null,
      null
    );
  }, [key, badge?.kind]);
  if (badge === undefined || badge.label === '') {
    return h('span', null, t(kind === KIND_SESSION ? 'session.label' : 'type.label'));
  }
  return h(
    'span',
    { className: 'att-tab-badge', 'data-at-terminal-tab-state': badge.kind },
    h('span', { className: 'att-tab-badge-dot' }),
    `${t(kind === KIND_SESSION ? 'session.label' : 'type.label')} · ${badge.label}`
  );
}

/* ------------------------------- host reads ---------------------------------- */

function clampMenu(position: number, size: number, limit: number): number {
  return Math.max(8, Math.min(position, Math.max(8, limit - size)));
}

function normalizeSettings(result: unknown): TerminalUiSettings {
  const raw = (result ?? {}) as Record<string, unknown>;
  const num = (value: unknown, fallback: number): number =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const family = raw.terminalFontFamily;
  return {
    fontSize: Math.min(200, Math.max(8, num(raw.terminalFontSize, DEFAULT_UI_SETTINGS.fontSize))),
    fontFamily:
      typeof family === 'string' && family.trim() !== '' ? family : DEFAULT_UI_SETTINGS.fontFamily,
    scrollback: Math.max(100, num(raw.scrollback, DEFAULT_UI_SETTINGS.scrollback)),
    semanticHighlight: raw.semanticHighlight !== false,
    zebraStripes: raw.zebraStripes === true
  };
}

/** Read the host's `sshManager.*` settings once per mount; fall back to defaults. */
export function useUiSettings(): { settings: TerminalUiSettings; version: number } {
  const [settings, setSettings] = React.useState<TerminalUiSettings>(DEFAULT_UI_SETTINGS);
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    callRpc('settings.get', {}).then(
      (result) => {
        if (cancelled) return;
        setSettings(normalizeSettings(result));
        setVersion((value) => value + 1);
      },
      () => {
        /* settings are a refinement, not a requirement: defaults stay */
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { settings, version };
}

/**
 * One host read with a revision trigger: pending → ok/failed, never a silent empty.
 *
 * `enabled: false` leaves it pending and issues nothing. The file tree uses that because its read
 * is the one host read that can **open an SSH connection**: doing so because the panel mounted —
 * while the user is looking at the server list — is a side effect nobody asked for.
 *
 * `params` rides along in the dependency list rather than being captured once, so a read that
 * names a terminal re-issues when that terminal changes instead of showing the previous tab's
 * listing.
 */
export function useHostRead<T>(
  method: string,
  revision: number,
  enabled = true,
  params: Record<string, unknown> = {}
): AsyncState<T> {
  const [state, setState] = React.useState<AsyncState<T>>(pendingState);
  // Serialised so the effect depends on a primitive: a fresh object literal every render would
  // re-issue the read on every render.
  const paramKey = JSON.stringify(params);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState(pendingState);
    callRpc(method, JSON.parse(paramKey) as Record<string, unknown>).then(
      (result) => {
        if (!cancelled) setState({ kind: 'ok', result: (result ?? {}) as T });
      },
      (error: unknown) => {
        if (!cancelled) setState(failedState(asFailure(error)));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [method, revision, enabled, paramKey]);

  return state;
}

/* --------------------------------- 资产 body --------------------------------- */

interface MenuState {
  x: number;
  y: number;
  server: ServerView;
}

/** The `servers.list` reply: records plus the distinct group names. */
interface ServerListResult {
  servers?: unknown;
  groups?: string[];
}

/**
 * The bucket key for a body the frame gave no identity — a harness render, or a frame old enough
 * not to carry `contentId`.
 *
 * A constant, for the same reason `body-session.ts` uses one: two renders that cannot name their
 * tab are the same tab as far as anything here can tell. It is also why the store's tests clear
 * themselves — a module-level store and a shared fallback key would otherwise hand one test's
 * draft form to the next.
 */
const ANONYMOUS_TAB_KEY = 'anonymous';

/**
 * Whether two forms differ in anything the user could have typed.
 *
 * Every field, password included: a password typed into a restored draft is a change the user
 * would lose by leaving, and a baseline's own password is always `''` (the store blanks it and
 * `formFromServer` never fills it), so this compares what was typed rather than what is stored.
 */
function formsDiffer(left: FormModel, right: FormModel): boolean {
  return (Object.keys(left) as Array<keyof FormModel>).some((field) => left[field] !== right[field]);
}

/** A question waiting for an answer. The resolver is what turns the click back into a `boolean`. */
interface PendingConfirm {
  request: Omit<ConfirmDialogProps, 't' | 'onConfirm' | 'onClose'>;
  resolve(answer: boolean): void;
}

/**
 * The 资产 tab: a server manager and nothing else.
 *
 * The terminal and the file tree used to be two more pages behind this body's nav. They are not
 * gone — they are the **other tab kind** now (`at-terminal-session`), which is what lets a
 * double-click open a connection in its own tab and lets that tab keep it alive while this one is
 * in front. So this body owns no socket, reads no remote directory, and its toolbar has no page
 * switch: the thing it manages is reached by double-clicking a row.
 */
export function AtTerminalBody(props: Record<string, unknown> = {}): ReactElement {
  const t = React.useContext(BodyLocale);
  const tabId = readTabId(props);
  /**
   * This tab's bucket key, and the state a previous mount of **this** tab left behind.
   *
   * Read once per mount, into the initialisers below — that is what makes a tab switch look
   * like a page the user never left, while a freshly opened tab still starts clean (a new
   * `contentId`, so no bucket). Nothing re-reads it afterwards: the store is written by this
   * body, so a subscription would only echo what this render already knows.
   */
  const tabKey = readTabKey(props) || ANONYMOUS_TAB_KEY;
  const restored = readAssetsState(tabKey);

  const openSessionTab =
    typeof props.openSessionTab === 'function'
      ? (props.openSessionTab as (serverId: string) => boolean)
      : () => false;

  const openMonitorTab =
    typeof props.openMonitorTab === 'function'
      ? (props.openMonitorTab as (options?: { serverId?: string; target?: 'hardware' | 'agent_execution' }) => boolean)
      : undefined;

  const [formOpen, setFormOpen] = React.useState(restored?.formOpen ?? false);
  const [dialog, setDialog] = React.useState<'none' | 'import' | 'export'>('none');
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [listSelectedId, setListSelectedId] = React.useState(restored?.listSelectedId ?? '');
  /**
   * The list's scroll offset, held in a ref rather than in state.
   *
   * A scroll is not a re-render: putting it in `useState` would rebuild the whole list on every
   * wheel tick, and the only reader is the restore effect below. The ref is also what lets the
   * write-through effect persist the *current* offset without depending on it.
   */
  const scrollRef = React.useRef<HTMLElement | null>(null);
  const scrollTopRef = React.useRef(restored?.scrollTop ?? 0);
  /**
   * Why a double-click did not open a tab, when the frame refused it.
   *
   * The frame throws when it has no mounted surface to place a tab into — a real state (the
   * sidebar can be collapsed with nothing in it), and one the user *can* act on. A double-click
   * that silently does nothing reads as a broken list, which is the failure mode this exists to
   * avoid; the sentence says what to do instead.
   */
  const [notice, setNotice] = React.useState<string | null>(null);

  /* ---------------------------------- data ----------------------------------- */

  const [summaryRevision, setSummaryRevision] = React.useState(0);
  const [serversRevision, setServersRevision] = React.useState(0);
  const summaryState = useHostRead<AssetSummary>('assets.summary', summaryRevision);
  const serversState = useHostRead<ServerListResult>('servers.list', serversRevision);
  const servers = serversState.kind === 'ok' ? serverViews(serversState.result) : [];
  const groups =
    serversState.kind === 'ok' && Array.isArray(serversState.result.groups)
      ? serversState.result.groups
      : [];

  /* ---------------------------------- form ----------------------------------- */

  const [form, setForm] = React.useState<FormModel>(restored?.form ?? emptyForm);
  const [formError, setFormError] = React.useState<{ field: string; message: string } | null>(null);
  const [saveState, setSaveState] = React.useState<SaveState | SaveDone | SaveFailed>({ kind: 'idle' });
  const [removal, setRemoval] = React.useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; label: string; removed: boolean }
    | { kind: 'failed'; code: string; message: string }
  >({ kind: 'idle' });
  const [showPassword, setShowPassword] = React.useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = React.useState(false);
  /**
   * The form as it was when this draft started, so "unsaved changes" can be answered rather
   * than guessed. A ref, not state: it never needs to re-render anything — `form` does that —
   * and putting it in state would make the dirty check a render behind the edit.
   */
  const formBaselineRef = React.useRef<FormModel>(form);

  /* ------------------------------ the confirm box ---------------------------- */

  /**
   * One question at a time, answered through a promise.
   *
   * The promise is what makes this usable from the middle of an async flow: the upload loop has
   * to ask about file 3 of 7, so the answer has to suspend that loop rather than block the
   * browser. `window.confirm` could do neither — it froze the page and gave a themed panel a
   * grey system dialog with an origin string in it.
   *
   * Plain functions rather than `useCallback`: a fresh identity per render is harmless here
   * (every caller closes over the render it is in and answers before the next one), and the
   * bundle test's React stand-in does not implement the memo hooks.
   */
  const [confirm, setConfirm] = React.useState<PendingConfirm | null>(null);

  function requestConfirm(
    request: Omit<ConfirmDialogProps, 't' | 'onConfirm' | 'onClose'>
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => setConfirm({ request, resolve }));
  }

  function answerConfirm(answer: boolean): void {
    const pending = confirm;
    if (pending === null) return;
    // Closed **before** resolution, so a caller that immediately opens another dialog is not
    // painted underneath this one for a frame.
    setConfirm(null);
    pending.resolve(answer);
  }

  /** Ask before throwing away edits. True means "there is nothing to lose, carry on". */
  async function confirmDiscard(): Promise<boolean> {
    if (!formsDiffer(form, formBaselineRef.current)) return true;
    return requestConfirm({
      title: t('dialog.confirmDiscardTitle'),
      message: t('form.discardConfirm'),
      confirmLabel: t('form.discard'),
      danger: true
    });
  }

  /* ------------------------------ import/export ------------------------------ */

  const [includePasswords, setIncludePasswords] = React.useState(false);
  const [includePrivateKeys, setIncludePrivateKeys] = React.useState(false);
  const [exportPassword, setExportPassword] = React.useState('');
  const [exportState, setExportState] = React.useState<ExportState | ExportDone | ExportFailed>({ kind: 'idle' });

  const [importFileName, setImportFileName] = React.useState<string | null>(null);
  const [importPassword, setImportPassword] = React.useState('');
  const [importStrategy, setImportStrategy] = React.useState('skip');
  const [importState, setImportState] = React.useState<ImportState | ImportDone | ImportFailed>({ kind: 'idle' });
  const importReadRef = React.useRef<(() => Promise<string>) | null>(null);
  const [collapsedGroups, setCollapsedGroups] = React.useState<string[]>([
    ...(restored?.collapsedGroups ?? [])
  ]);

  /* --------------------------- state that outlives us ------------------------- */

  /**
   * Write the four surviving fields back on every change.
   *
   * A single effect rather than a `persist()` call at each setter: there are nine call sites
   * that touch `form` (one per field), and a write-through that has to be remembered at each of
   * them is a write-through that will be forgotten at one. The deps are the fields themselves,
   * so it runs exactly when something it stores changed.
   *
   * `scrollTop` rides a ref and is therefore not in the deps — it is saved by the scroll
   * handler itself (see `renderAssetsView`'s `onScrollTop`), which is the only moment it moves.
   */
  React.useEffect(() => {
    saveAssetsState(tabKey, {
      formOpen,
      form,
      listSelectedId,
      collapsedGroups,
      scrollTop: scrollTopRef.current
    });
  }, [tabKey, formOpen, form, listSelectedId, collapsedGroups]);

  /**
   * Put the list back where the user left it.
   *
   * Keyed on `serversState.kind` rather than run once on mount, and that is the whole
   * difficulty: the read is in flight on the first paint, so the scroll container has no height
   * to scroll — setting `scrollTop` then clamps to 0 and the position is lost for good. The
   * effect therefore waits for the read to land, which is the first frame the list can actually
   * be scrolled.
   */
  React.useEffect(() => {
    if (serversState.kind !== 'ok') return;
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = scrollTopRef.current;
  }, [serversState.kind]);

  // The context menu closes on any outside click or Escape.
  React.useEffect(() => {
    if (menu === null) return undefined;
    const close = (): void => setMenu(null);
    const onKeydown = (event: { key?: string }): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKeydown);
    };
  }, [menu]);

  const exportBusy = exportState.kind === 'pending';
  const importBusy = importState.kind === 'pending';
  const busy = exportBusy || importBusy || saveState.kind === 'pending';

  function runExport(): void {
    if (exportBusy) return;
    if (exportPassword === '') {
      setExportState({ kind: 'failed', ...asFailure(rpcError('bad-params', t('export.needPassword'))) });
      return;
    }
    setExportState({ kind: 'pending' });
    callRpc('assets.export', {
      includePasswords,
      includePrivateKeys,
      packagePassword: exportPassword
    }).then(
      (result) => {
        const payload = (result ?? {}) as { filename?: unknown; omissions?: unknown; envelope?: unknown };
        const filename = text(payload.filename) || 'at-terminal-assets.at-terminal-assets';
        try {
          saveDownload(filename, payload.envelope);
          setExportState({ kind: 'ok', filename, omissions: count(payload.omissions) });
        } catch (error) {
          setExportState({ kind: 'failed', ...asFailure(error) });
        }
      },
      (error: unknown) => setExportState({ kind: 'failed', ...asFailure(error) })
    );
  }

  function runImport(): void {
    if (importBusy) return;
    const read = importReadRef.current;
    if (read === null) {
      setImportState({ kind: 'failed', ...asFailure(rpcError('bad-params', t('import.needFile'))) });
      return;
    }
    if (importPassword === '') {
      setImportState({ kind: 'failed', ...asFailure(rpcError('bad-params', t('import.needPassword'))) });
      return;
    }
    setImportState({ kind: 'pending' });
    // The host half accepts the raw package text and canonicalizes it there, so the bytes the
    // user picked are never re-encoded on this side.
    read()
      .then((envelope) =>
        callRpc('assets.import', { envelope, packagePassword: importPassword, strategy: importStrategy })
      )
      .then(
        (result) => {
          const payload = (result ?? {}) as { summary?: ImportSummary };
          setImportState({ kind: 'ok', summary: payload.summary ?? {} });
          setSummaryRevision((value) => value + 1);
          setServersRevision((value) => value + 1);
        },
        (error: unknown) => setImportState({ kind: 'failed', ...asFailure(error) })
      );
  }

  function startNew(): void {
    setForm(emptyForm());
    formBaselineRef.current = emptyForm();
    setFormError(null);
    setSaveState({ kind: 'idle' });
    setShowPassword(false);
    setGroupMenuOpen(false);
    setFormOpen(true);
  }

  function startEdit(server: ServerView): void {
    const draft = formFromServer(server);
    setForm(draft);
    formBaselineRef.current = draft;
    setFormError(null);
    setSaveState({ kind: 'idle' });
    setShowPassword(false);
    setGroupMenuOpen(false);
    setFormOpen(true);
  }

  function runSave(): void {
    if (saveState.kind === 'pending') return;
    const isNew = form.id === '';
    const problem = validateForm(t, form, isNew);
    if (problem !== null) {
      // No RPC: the reason is shown next to the field the user has to fix.
      setFormError(problem);
      return;
    }
    setFormError(null);
    setSaveState({ kind: 'pending' });
    callRpc('servers.save', { server: buildServerInput(form, isNew) }).then(
      (result) => {
        const payload = (result ?? {}) as { label?: unknown };
        const label = text(payload.label) || form.label.trim();
        setSaveState({ kind: 'ok', label });
        setForm(emptyForm());
        // Saved is not dirty: without this, closing the form after a save would ask whether to
        // discard edits the user has just persisted.
        formBaselineRef.current = emptyForm();
        setFormOpen(false);
        setServersRevision((value) => value + 1);
        setSummaryRevision((value) => value + 1);
      },
      (error: unknown) => setSaveState({ kind: 'failed', ...asFailure(error) })
    );
  }

  function runRemove(server: ServerView): void {
    setMenu(null);
    void (async () => {
      const confirmed = await requestConfirm({
        title: t('dialog.confirmRemoveTitle'),
        message: t('servers.removeConfirm', { label: text(server.label) }),
        confirmLabel: t('menu.remove'),
        danger: true
      });
      // A refusal is a no-op rather than a cancelled state: nothing was started, so there is
      // nothing to report and no pending flag to unwind.
      if (!confirmed) return;
      setRemoval({ kind: 'pending' });
      callRpc('servers.remove', { id: text(server.id) }).then(
        (result) => {
          const payload = (result ?? {}) as { removed?: unknown };
          setRemoval({ kind: 'ok', label: text(server.label), removed: payload.removed !== false });
          setServersRevision((value) => value + 1);
          setSummaryRevision((value) => value + 1);
        },
        (error: unknown) => setRemoval({ kind: 'failed', ...asFailure(error) })
      );
    })();
  }

  /**
   * A row double-click: open a **terminal tab** for that server. Nothing happens here.
   *
   * The frame mints the tab; this body only names the server. `params` is the one channel that
   * survives the trip — `openTab` can create a tab but cannot put anything in it — so the value
   * goes in `params.serverId` and the new body's mount effect turns it into a connection. That is
   * what makes the gesture "double-click and you are connecting" rather than "double-click and
   * pick a server again".
   *
   * The row is also marked selected, so the shortcut and the context menu act on the row the user
   * just acted on.
   */
  function openAssetInSessionTab(server: ServerView): void {
    const id = text(server.id);
    if (id === '') return;
    setListSelectedId(id);
    setNotice(openSessionTab(id) ? null : t('servers.tabRefused'));
  }

  function copyAddress(server: ServerView): void {
    setMenu(null);
    const target = `${text(server.username)}@${text(server.host)}:${count(server.port)}`;
    const write = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(target) : undefined;
    if (write !== undefined) void write.catch(() => undefined);
    setCopied(t('menu.copied', { target }));
    window.setTimeout(() => setCopied(null), 2000);
  }

  /* --------------------------------- render ---------------------------------- */

  const children: unknown[] = [];

  if (formOpen) {
    children.push(
      renderFormView({
        t,
        form,
        isNew: form.id === '',
        groups,
        servers,
        showPassword,
        groupMenuOpen,
        formError,
        saveState,
        onField: (field, value) => {
          setFormError(null);
          setForm((previous) => ({ ...previous, [field]: value }));
        },
        onCheck: (field, value) => setForm((previous) => ({ ...previous, [field]: value })),
        onAuthType: (value) => {
          setForm((previous) => ({ ...previous, authType: value }));
        },
        onTogglePassword: () => setShowPassword((previous) => !previous),
        onToggleGroupMenu: () => setGroupMenuOpen((previous) => !previous),
        onPickGroup: (name) => {
          setForm((previous) => ({ ...previous, group: name }));
          setGroupMenuOpen(false);
        },
        onSave: runSave,
        onCancel: () => {
          void (async () => {
            if (!(await confirmDiscard())) return;
            setForm(emptyForm());
            formBaselineRef.current = emptyForm();
            setFormError(null);
            setSaveState({ kind: 'idle' });
            setFormOpen(false);
          })();
        },
        // 返回列表 is the same act as 取消 once the form has content worth losing, so it asks the
        // same question through the same dialog rather than a second code path.
        onBack: () => {
          void (async () => {
            if (!(await confirmDiscard())) return;
            setForm(emptyForm());
            formBaselineRef.current = emptyForm();
            setFormError(null);
            setSaveState({ kind: 'idle' });
            setFormOpen(false);
          })();
        }
      })
    );
  }

  children.push(
    renderAssetsView({
      t,
      hidden: formOpen,
      summaryState,
      serversState,
      removal,
      savedLabel: saveState.kind === 'ok' ? saveState.label : null,
      selectedId: listSelectedId,
      busy,
      copied,
      notice,
      onSelect: (server) => setListSelectedId(text(server.id)),
      onOpenInNewTab: openAssetInSessionTab,
      onEdit: (server) => {
        setMenu(null);
        startEdit(server);
      },
      onRemove: runRemove,
      onRowMenu: (event, server) => {
        event.preventDefault();
        setListSelectedId(text(server.id));
        setMenu({
          x: clampMenu(event.clientX, 160, typeof window === 'undefined' ? 1024 : window.innerWidth),
          y: clampMenu(event.clientY, 150, typeof window === 'undefined' ? 768 : window.innerHeight),
          server
        });
      },
      onNew: startNew,
      onImport: () => {
        setImportState({ kind: 'idle' });
        setDialog('import');
      },
      onExport: () => {
        setExportState({ kind: 'idle' });
        setDialog('export');
      },
      onRefresh: () => {
        setServersRevision((value) => value + 1);
        setSummaryRevision((value) => value + 1);
      },
      onOpenMonitor: openMonitorTab
        ? (server) => openMonitorTab({ serverId: text(server.id), target: 'hardware' })
        : undefined,
      collapsedGroups,
      scrollRef,
      onScrollTop: (top) => {
        scrollTopRef.current = top;
        // Saved here rather than through the effect: the offset moves on every wheel tick and
        // nothing re-renders, so this is the only place that sees it change.
        const current = readAssetsState(tabKey);
        if (current !== undefined) saveAssetsState(tabKey, { ...current, scrollTop: top });
      },
      onToggleGroup: (groupKey: string) => {
        setCollapsedGroups((prev) =>
          prev.includes(groupKey) ? prev.filter((k) => k !== groupKey) : [...prev, groupKey]
        );
      }
    })
  );

  if (dialog === 'export') {
    children.push(
      renderExportDialog({
        t,
        includePasswords,
        includePrivateKeys,
        password: exportPassword,
        state: exportState,
        onIncludePasswords: setIncludePasswords,
        onIncludePrivateKeys: setIncludePrivateKeys,
        onPassword: setExportPassword,
        onSubmit: runExport,
        onClose: () => setDialog('none')
      })
    );
  }
  if (dialog === 'import') {
    children.push(
      renderImportDialog({
        t,
        fileName: importFileName,
        password: importPassword,
        strategy: importStrategy,
        state: importState,
        onFile: (file, read) => {
          setImportFileName(file?.name ?? null);
          importReadRef.current = file === null ? null : read;
        },
        onPassword: setImportPassword,
        onStrategy: setImportStrategy,
        onSubmit: runImport,
        onClose: () => setDialog('none')
      })
    );
  }

  if (confirm !== null) {
    children.push(
      renderConfirmDialog({
        t,
        ...confirm.request,
        onConfirm: () => answerConfirm(true),
        onClose: () => answerConfirm(false)
      })
    );
  }

  if (menu !== null) {
    const item = (key: string, labelKey: string, onClick: () => void, danger = false): El =>
      h(
        'button',
        {
          key,
          type: 'button',
          className: danger ? 'att-menu-item danger' : 'att-menu-item',
          role: 'menuitem',
          onClick,
          'data-at-terminal-action': `menu-${key}`
        },
        t(labelKey)
      );
    children.push(
      h(
        'div',
        {
          key: 'menu',
          className: 'att-menu',
          role: 'menu',
          style: { left: `${menu.x}px`, top: `${menu.y}px` },
          'data-at-terminal-menu': text(menu.server.id),
          onClick: (event: { stopPropagation(): void }) => event.stopPropagation()
        },
        // 「连接」 opens a session tab too, and for the same reason the double-click does: this
        // body has no terminal to connect *in*. The label says so rather than promising a
        // connection that would have nowhere to appear.
        item('connect', 'menu.connect', () => openAssetInSessionTab(menu.server)),
        ...(openMonitorTab
          ? [
              item('monitor', 'monitor.title', () => {
                setMenu(null);
                openMonitorTab({ serverId: text(menu.server.id), target: 'hardware' });
              })
            ]
          : []),
        item('edit', 'menu.edit', () => {
          setMenu(null);
          startEdit(menu.server);
        }),
        item('copy', 'menu.copy', () => copyAddress(menu.server)),
        item('remove', 'menu.remove', () => runRemove(menu.server), true)
      )
    );
  }

  // One breadcrumb per committed render of a tab body. A blank panel with **no** breadcrumb means
  // the body never got this far (mount threw above); a breadcrumb followed by an `error` entry
  // names the throw directly. Fire-and-forget and outside the render path's return value, so it
  // cannot affect what is drawn.
  React.useEffect(() => {
    postDiagnostic(
      'info',
      `at-terminal body rendered tab=${tabId || '(none)'} page=${formOpen ? 'form' : 'assets'}`,
      'body',
      null,
      null
    );
  }, [tabId, formOpen]);

  return h(
    'div',
    { className: 'att-root', 'data-at-terminal-body': formOpen ? 'form' : 'assets' },
    children
  );
}
