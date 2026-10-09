/**
 * AT Terminal — dsh Client half entry (DSH-19/20, M3/M4).
 *
 * Compiled by `node dsh/esbuild.dsh.mjs` into `dsh/client.js`, a single lazy
 * ModuleLoader factory: the build wraps this module's exports in
 * `window.__ModuleLoader__.load({ id, factory })` with `react` external (the
 * browser baseline provides it) and everything else — xterm, its addons, the
 * reused `webview/terminal` building blocks and the three stylesheets — bundled
 * in, because the runtime module table guarantees nothing beyond the baseline.
 *
 * Registration mirrors the committed contract, verified against the installed
 * Harness (docs/research/2026-09-29-dsh-sidebar-right-contract.md):
 *
 * - **two** right-sidebar tab types via `ctx.sidebarRightTabs.register`, both under
 *   our own kinds, leaving the official `terminal` kind untouched — 资产 (the
 *   manager, the column's default page) and 终端 (one connection, `multiple: true`);
 * - a pane **body** and a chip **title** for each, through the two-stage
 *   `ctx.slots.inject → ctx.slots.register` path, keyed by each definition's `id`;
 * - the session lifetime: `ctx.sidebarRight.registerCloseHandler` for the frame's own
 *   removal path, `ctx.sidebarRight.openTabs` as the authoritative open-tab inventory
 *   that holds a background connection alive and reaps what is closed, and
 *   `sessions.ts` for the state itself;
 * - the page switches and the two connection commands on the official `shortcuts`
 *   registry, which the reference panel derives its list from — this plugin keeps no
 *   second copy of the bindings;
 * - the stylesheet injected once per page, guarded by element id so
 *   enable/disable cycles cannot stack copies.
 */

import React, { useEffect, useState } from 'react';
import {
  announceToHost,
  ID,
  ID_SESSION,
  ID_MONITOR,
  KIND,
  KIND_SESSION,
  KIND_MONITOR,
  installDiagnostics,
  postDiagnostic,
  listenMonitorEvents,
  getHardwareMetricsRpc,
  getAgentExecutionStatusRpc
} from './channel';
import { NS, en, zh } from './i18n';
import { AtTerminalBody, AtTerminalTitle, wrapWithLocale } from './body';
import { AtTerminalSessionBody } from './body-session';
import { AtTerminalMonitorBody, AtTerminalMonitorTitle } from './views/monitorPane';
import { MonitorHudWidget } from './views/monitorHud';
import {
  disposeAllSessions,
  disposeSession,
  retainSessions,
  stashSessionSeed,
  subscribeActiveTerminal,
  getActiveTerminalState,
  type ActiveTerminalState
} from './sessions';
import { ensureStyles } from './styles';
import type { AgentExecutionSnapshot, HardwareMetrics, Translate } from './models';
import type { PanelMode } from './views/shared';
import { h } from './views/shared';

/** The narrow slice of the client context this plugin touches. */
export interface ClientContext {
  effect(setup: () => unknown, label?: string): unknown;
  locale: {
    bind(ns: string): Translate;
    register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void;
  };
  shortcuts: {
    register(command: ShortcutCommand): () => void;
  };
  sidebarRightTabs: {
    register(definition: Record<string, unknown>): () => void;
  };
  sidebarRight: {
    openTab(kind: string, options?: Record<string, unknown>): unknown;
    openTabFromTarget(kind: string, target: unknown): void;
    float?(tabId: string, rect?: { width?: number; height?: number; x?: number; y?: number }): void;
    registerCloseHandler(
      kind: string,
      handler: (sessionId: string, tab: { id: string; contentId?: unknown }) => void
    ): () => void;
    openTabs: {
      getSnapshot(): ReadonlyArray<{ sessionId?: unknown; tabId?: unknown; kind?: unknown; contentId?: unknown }>;
      subscribe(listener: () => void): () => void;
    };
  };
  slots: {
    inject(key: string, callback: () => unknown): () => unknown;
    register(options: Record<string, unknown>, component: unknown): () => unknown;
  };
}

/**
 * One shortcut command, as `dsh-client-shortcuts` reads it.
 *
 * The service is reached only through `ctx`, never imported: the module table that
 * would resolve a `@deepseek-ai/*` specifier is frozen, and a plugin half that names
 * one is rejected outright. Every field below was read off the shipped registry
 * (`ShortcutRegistry.register`) and two real call sites
 * (`dsh-client-ui-sidebar-files`, `dsh-client-ui-sidebar-terminal`).
 *
 * - `defaults` is keyed `<runtime>:<platform>` and each value is a **physical** key:
 *   a `KeyboardEvent.code` plus logical `modifiers`, where `primary` expands to Meta on
 *   macOS and Control elsewhere. There is no `"Mod+P"` string form.
 * - **Omitting a key is how "no default" is expressed** — an absent entry resolves to
 *   `undefined` and the command shows as unbound. `web:linux` is omitted on purpose:
 *   browsers there reserve every combination we would pick (the service rejects the
 *   rest as `unsupported-browser`), which is why no official command binds one either.
 * - `resolve` returns `{status:'handled',run}`, `{status:'blocked',reason}`, or
 *   `{status:'pass'}`. Returning `handled` with a no-op `run` is how a command that is
 *   already satisfied stays silent instead of throwing.
 */
export interface ShortcutBinding {
  code: string;
  modifiers: string[];
}

export interface ShortcutCommand {
  id: string;
  label: () => string;
  aliases?: string[];
  defaults?: Record<string, ShortcutBinding>;
  regions: string[];
  modals: string[];
  resolve: (context: { region: string; modal: string | null; target: Element | null }) => unknown;
}

/* ------------------------------- the commands -------------------------------- */

/**
 * 「在新标签页中连接」 as a command, the way the official `terminal` type registers its own
 * `terminal.new`.
 *
 * There is no toolbar button mirroring it: a bare 「新建终端」 could only ever open an *empty* tab,
 * which landed the user back on the asset list with nothing selected — the thing that reads as "the
 * button did nothing". So this command is the **keyboard route to the row double-click**, and it
 * therefore has to name a server the same way the double-click does. `focusedServerId` reads that
 * name out of the panel the user is looking at.
 *
 * `resolve` hands back `{status:'handled', run}` rather than running inline: the dispatcher skips
 * `run` on key repeat, so holding the combination down cannot open a dozen tabs. Nothing to act on
 * is `blocked` with a reason, which is the registry's own vocabulary for "the gesture was
 * understood and refused" — silently opening an empty tab is what this is replacing.
 *
 * ## Why there is no `web:*` binding — this cost a boot
 *
 * `ctx.shortcuts.register` **validates every declared default and throws**:
 * ```js
 * if (runtime === "web" && !isWebBindingAllowed(binding, platform))
 *   throw new Error(`Unsupported Web shortcut: ${command.id}`)
 * ```
 * A single modifier is not admitted in a browser, so `web:macos`/`web:windows` bound to `primary`
 * made `register` throw **inside `ctx.effect` during `apply`**. The fiber went to `failed`, and web
 * boot refused to start the whole client:
 * `web boot: 1 entry did not activate / @at-series/dsh-at-terminal: failed`.
 *
 * That admission rule is not arbitrary: `⌘T`/`Ctrl+T` is the browser's own "new tab" and never
 * reaches the page. The page switches pass because they bind **two** modifiers (`primary` + `alt`),
 * which is the shape `isWebBindingAllowed` admits. Ours uses one, because one is what ⌘T means on
 * the desktop — so `web` is left unbound, which the registry documents as the way to say "no
 * default" (`resolveShortcutDefault` is a plain exact lookup with no fallback, and an absent entry
 * skips validation entirely). On the web, the row double-click is the route.
 */
function newTabCommand(t: Translate, openSessionTab: (serverId: string) => boolean): ShortcutCommand {
  return {
    id: 'atTerminal.newTab',
    label: () => t('shortcut.newTab'),
    aliases: ['at terminal new tab', 'new terminal', 'open server in new tab'],
    defaults: {
      // Desktop only. `primary` expands to Meta on macOS and Control elsewhere, and
      // `bindingIssue` returns null immediately for desktop macOS/Windows.
      'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyT', modifiers: ['primary'] }
    },
    // Same three regions as the page switches: the gesture has to work from the terminal
    // this panel embeds, which is where the user actually is when they want another tab.
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: ({ target }) => {
      const body = activeBody(target);
      // Nothing mounted, or an ambiguous pair of panes: `pass` leaves the gesture to the
      // browser instead of consuming it on behalf of a tab that is not showing.
      if (body === null) return { status: 'pass' };
      const serverId = focusedServerId(body);
      if (serverId === '') return { status: 'blocked', reason: t('shortcut.pickAsset') };
      return { status: 'handled', run: () => openSessionTab(serverId) };
    }
  };
}

/**
 * The **终端** tab's two page switches, plus the one that goes back to 资产.
 *
 * The two are peers rather than modes of a body: 终端 and 文件 are the pages of one connection,
 * and both live in the `at-terminal-session` tab. 资产 is a **different tab kind**, so its command
 * reveals that tab instead of switching a page — which is exactly what the split bought. Keeping all
 * three in one list is deliberate: the reference panel lists them together, so "the third screen" is
 * still one keystroke away from wherever the user is.
 *
 * The panel's page lives in `body-session.ts` as session state behind `changePage`, which this file
 * cannot reach: it is not published by any service. So each command drives the switch the way the
 * toolbar does — by clicking the nav button — and finds it through the `data-at-terminal-action`
 * hook the views already render. That keeps one owner for the transition: `changePage` also latches
 * the first SFTP visit and kicks the reload, all of which a bare `setState` would skip.
 *
 * The digits are `primary+alt`, which read as "the Nth page" and are disjoint from every official
 * default (`KeyB/O/T/P/N/K/R`, `Comma`, `Slash`, `Backquote`) — the registry throws on an
 * overlapping default, so a mnemonic that collided would fail the whole plugin at load rather than
 * degrade.
 */
const MODE_COMMANDS: ReadonlyArray<{ mode: PanelMode; digit: string }> = [
  { mode: 'terminal', digit: 'Digit1' },
  { mode: 'sftp', digit: 'Digit2' }
];

/** English search aliases; the reference panel matches these alongside the label. */
function modeAliases(mode: PanelMode): string[] {
  if (mode === 'sftp') return ['at terminal files', 'files', 'sftp'];
  return ['at terminal terminal', 'terminal', 'shell'];
}

/**
 * Defaults for one command, as the registry's `<runtime>:<platform>` table.
 *
 * `web:linux` is absent by design (see `ShortcutCommand`). Desktop and Web agree on `primary+alt`
 * here: unlike the official tabs, these keys are already two modifiers deep, so the extra `alt` the
 * Web defaults add to disambiguate single-modifier combinations buys nothing.
 */
function modeDefaults(code: string): Record<string, ShortcutBinding> {
  const binding: ShortcutBinding = { code, modifiers: ['primary', 'alt'] };
  return {
    'desktop:macos': binding,
    'desktop:windows': binding,
    'desktop:linux': binding,
    'web:macos': binding,
    'web:windows': binding
  };
}

/** Every mounted panel body; there is one per open AT Terminal tab of either kind. */
function panelBodies(): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll<HTMLElement>('[data-at-terminal-body]')];
}

/**
 * The body a gesture belongs to.
 *
 * Two tabs can be open at once, and switching the one that is not on screen would look like the
 * shortcut did nothing. So the focused element decides: whichever body contains it is the one the
 * user is looking at. Failing that a single open body is unambiguous, but several are not —
 * returning `null` then leaves the gesture alone rather than guessing which pane to move.
 */
function activeBody(target: Element | null): HTMLElement | null {
  const fromTarget = target?.closest<HTMLElement>('[data-at-terminal-body]') ?? null;
  if (fromTarget !== null) return fromTarget;
  const bodies = panelBodies();
  return bodies.length === 1 ? (bodies[0] as HTMLElement) : null;
}

/**
 * The server a 「在新标签页中连接」 gesture means, read out of the panel the user is looking at.
 *
 * The command lives in `apply` and cannot see the body's React state, so it reads the panel's own
 * DOM — the same route `requestMode` takes to the nav button, and for the same reason: the state has
 * one owner, and a second copy of it here is how the two start disagreeing.
 *
 * Which control answers depends on the tab, and the answer is the one a user would give:
 *
 * - **资产** — the highlighted row, i.e. *"open a terminal for this one"*. Same act as double-clicking
 *   it. Read only on that page: the highlight outlives a tab switch, and acting on it from a
 *   terminal tab would open a server the user is no longer looking at.
 * - **终端 / 文件** — this tab's own selector, i.e. *"another shell on the machine I am on"*. It is
 *   the common case (a second shell on the host you are already working in) and the only answer on
 *   those pages, where a highlighted row from the past is meaningless.
 *
 * Reading the row first and only on 资产 is what keeps the two answers apart: the terminal
 * `<select>` is rendered (hidden) on **every** page of a session tab, so asking it on 资产 would
 * answer with a stale binding were it rendered at all — and on the manager it is not rendered,
 * which is the point of the split.
 *
 * Nothing selected is a real state, not an error: it returns `''` and the caller answers `blocked`.
 * Guessing "the first server in the list" would spend a connection nobody asked for.
 */
function focusedServerId(body: HTMLElement): string {
  const page = body.dataset.atTerminalBody;
  if (page === 'assets') {
    const row = body.querySelector<HTMLElement>('[data-at-terminal-row][aria-selected="true"]');
    return row?.getAttribute('data-at-terminal-row') ?? '';
  }
  if (page !== 'terminal' && page !== 'sftp') return '';
  const select = body.querySelector<HTMLSelectElement>('[data-at-terminal-action="term-select"]');
  return typeof select?.value === 'string' ? select.value : '';
}

/**
 * Switch pages by clicking the panel's own nav button.
 *
 * Every early return is a silent no-op rather than a throw, because the command is also reachable
 * from the menu and the reference panel with no tab of ours open.
 */
function requestMode(body: HTMLElement, mode: PanelMode): void {
  // The server form is a full-panel editor holding unsaved input; it belongs to the 资产 tab, which
  // has no page switch — so its presence means this is not a session tab at all.
  if (body.dataset.atTerminalBody === 'form') return;
  // Already there. Re-clicking is harmless but pointless, and skipping it keeps the SFTP
  // first-visit latch from being re-triggered on every press.
  if (body.dataset.atTerminalBody === mode) return;
  body.querySelector<HTMLElement>(`[data-at-terminal-action="mode-${mode}"]`)?.click();
}

/** Build one page-switch command for the 终端 tab. */
function modeCommand(t: Translate, mode: PanelMode, digit: string): ShortcutCommand {
  return {
    id: `atTerminal.mode.${mode}`,
    label: () => t(`mode.${mode}`),
    aliases: modeAliases(mode),
    defaults: modeDefaults(digit),
    // `page` alone would make the switch unreachable from the panel's own inputs and from the
    // terminal it embeds, which is where a user paging between views sits.
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: ({ target }) => {
      const body = activeBody(target);
      // Nothing mounted, or an ambiguous pair of panes: `pass` leaves the gesture to the browser
      // instead of consuming it on behalf of a tab that is not showing.
      if (body === null) return { status: 'pass' };
      // The click itself belongs in `run`: the dispatcher skips `run` on key repeat, and the menu
      // path calls `resolve` without a gesture to consume.
      return { status: 'handled', run: () => requestMode(body, mode) };
    }
  };
}

/**
 * 「资产」 — reveal the server manager's tab.
 *
 * Not a page switch: 资产 is its own tab kind, and `openTab(KIND)` on a `multiple: false` type lands
 * on the already-open tab rather than minting a second one (`placeTab` gives every open the same
 * fixed content address, and the frame's own `findContentTab` resolves it). So this command is
 * `handled` with a `run` that cannot fail in a way the user needs to hear about — the frame only
 * throws when there is no surface to place a tab into, and the tab is already there in that case
 * only if it is open, which means there is one.
 */
function assetsCommand(t: Translate, revealAssets: () => void): ShortcutCommand {
  return {
    id: 'atTerminal.mode.assets',
    label: () => t('mode.assets'),
    aliases: ['at terminal assets', 'servers', 'assets'],
    // `Digit0` because the three pages read as a set: 0 is the home screen, 1 and 2 are the pages of
    // a connection. Free on every official default.
    defaults: modeDefaults('Digit0'),
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: () => ({ status: 'handled', run: revealAssets })
  };
}

/* --------------------------------- the types --------------------------------- */

/**
 * The 资产 tab type's registry definition.
 *
 * No `priority`: the default band is `extension`, which pairs with (rather than replaces) a
 * `builtin` holding the same kind — and we hold our own kind anyway. No `patterns`: this tab claims
 * no resource address, so it is reached from the guide rather than by opening a
 * `dsh-resource://` address. `guide[].order` and `guide[].title` are required by the registry;
 * `description` and `icon` are not, and we omit the icon rather than borrow an official component
 * from outside the frozen module baseline.
 *
 * ## Why `multiple: false`, and why this is the only guide entry
 *
 * Two reasons that turn out to be the same one. The asset list is a **manager**: two copies of the
 * same list in one pane is a defect a user can see, and a fixed content address is what makes
 * re-opening it *reveal* the tab instead of duplicating it. And the frame picks the right column's
 * default page from the registered guide entries — `defaultSeed` uses the sole entry's kind when
 * there is exactly one, and the guide otherwise — so keeping exactly one entry here is what makes
 * 资产 the page the column opens with, while the 终端 kind (see `sessionDefinition`) contributes
 * none and stays reachable only by the gesture that names a server.
 */
export function definition(t: Translate): Record<string, unknown> {
  return {
    id: ID,
    kind: KIND,
    multiple: false,
    title: () => t('type.label'),
    guide: [
      {
        id: 'at-terminal',
        order: 50,
        title: () => t('guide.title'),
        description: () => t('guide.description')
      }
    ]
  };
}

/**
 * The 终端 tab type: one live connection, one `multiple` instance per open.
 *
 * `multiple: true` is what makes a second terminal possible at all — the registry's own words:
 * *"A tab type can declare `multiple: true` for independent instances such as terminals. Each open
 * receives a distinct content address, so placement and docking preserve those instances; ordinary
 * pages retain per-pane uniqueness."* The implementation is one line —
 * `definition.multiple === true ? \`${pageAddress(kind)}/${randomUUID()}\` : pageAddress(kind)` — so
 * without it every open lands on **one** fixed address and the sidebar treats them as the same page.
 *
 * **No guide entry, deliberately.** Every entry on that list becomes a door in the column's guide
 * *and* a candidate for the default page; this kind needs a server to be worth opening, and an
 * entry here would offer a nameless door onto an empty terminal. It is opened by the gesture that
 * names one — a row double-click on 资产, or `atTerminal.newTab`.
 *
 * `keepMounted` is deliberately **not** set either. It was tried first, on the reasoning that a
 * background tab's body must survive being hidden. In the app that made the panel flash once and go
 * blank: the frame retains a visited body by moving it into a hidden background subtree, and one
 * React component per tab had no registry to keep its socket alive. The right answer is the one the
 * official `terminal` type uses — keep the *connection* outside React (`sessions.ts`) and let the
 * body come and go — which is what this now does.
 */
export function sessionDefinition(t: Translate): Record<string, unknown> {
  return {
    id: ID_SESSION,
    kind: KIND_SESSION,
    multiple: true,
    title: () => t('session.label')
  };
}

/**
 * The 监控 tab type: hardware metrics & agent execution monitor.
 * Single instance, reveals or floats independently.
 */
export function monitorDefinition(t: Translate): Record<string, unknown> {
  return {
    id: ID_MONITOR,
    kind: KIND_MONITOR,
    multiple: false,
    title: () => t('monitor.title')
  };
}

function monitorDefaults(code: string): Record<string, ShortcutBinding> {
  const binding: ShortcutBinding = { code, modifiers: ['primary', 'shift'] };
  return {
    'desktop:macos': binding,
    'desktop:windows': binding,
    'desktop:linux': binding,
    'web:macos': binding,
    'web:windows': binding
  };
}

function toggleMonitorCommand(t: Translate, openMonitor: () => void): ShortcutCommand {
  return {
    id: 'atTerminal.toggleMonitor',
    label: () => t('shortcut.monitor'),
    aliases: ['at terminal monitor', 'monitor', 'toggle monitor', 'system metrics'],
    defaults: monitorDefaults('KeyM'),
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: () => ({ status: 'handled', run: openMonitor })
  };
}

function MonitorHeaderButton(props: { t: Translate; onOpenPane: () => void }) {
  return h(
    'button',
    {
      className: 'att-nav-btn',
      title: props.t('monitor.title'),
      'aria-label': props.t('monitor.title'),
      onClick: () => props.onOpenPane(),
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
    },
    '📊'
  );
}

interface HudController {
  open(target?: 'hardware' | 'agent_execution'): void;
  close(): void;
  toggle(): void;
}

function MonitorHudContainer(props: {
  t: Translate;
  onOpenPane: (target: 'hardware' | 'agent_execution', serverId?: string) => void;
  onRegisterController?: (ctrl: HudController | null) => void;
}) {
  const { t, onOpenPane, onRegisterController } = props;
  const [metrics, setMetrics] = useState<HardwareMetrics | null>(null);
  const [snapshot, setSnapshot] = useState<AgentExecutionSnapshot | null>(null);
  const [visible, setVisible] = useState<boolean>(false);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [forceExpanded, setForceExpanded] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (onRegisterController) {
      onRegisterController({
        open: (_target) => {
          setVisible(true);
          setForceExpanded(true);
        },
        close: () => {
          setForceExpanded(false);
        },
        toggle: () => {
          setVisible((prev) => !prev);
        }
      });
      return () => {
        onRegisterController(null);
      };
    }
  }, [onRegisterController]);

  // Synchronize with active connected terminal session
  useEffect(() => {
    const handleActiveTerminal = (state: ActiveTerminalState) => {
      setActiveServerId(state.activeServerId);
      setActiveLabel(state.activeLabel);
      if (state.hasAnyConnected) {
        setVisible(true);
      } else {
        setVisible(false);
      }
    };
    const unsubscribe = subscribeActiveTerminal(handleActiveTerminal);
    handleActiveTerminal(getActiveTerminalState());
    return () => {
      unsubscribe();
    };
  }, []);

  // Poll metrics for current activeServerId
  useEffect(() => {
    let unmounted = false;
    const fetchLatest = () => {
      Promise.all([
        getHardwareMetricsRpc(activeServerId || undefined).catch(() => null),
        getAgentExecutionStatusRpc(5).catch(() => null)
      ]).then(([m, s]) => {
        if (!unmounted) {
          if (m) setMetrics(m);
          if (s) setSnapshot(s);
        }
      });
    };
    fetchLatest();
    const interval = setInterval(fetchLatest, 4000);
    return () => {
      unmounted = true;
      clearInterval(interval);
    };
  }, [activeServerId]);

  if (!visible) return null;

  return h(MonitorHudWidget, {
    t,
    metrics,
    snapshot,
    forceExpanded,
    activeServerId,
    activeLabel,
    onOpenPane: (target: 'hardware' | 'agent_execution') => onOpenPane(target, activeServerId || undefined),
    onCloseHud: () => setVisible(false)
  });
}

/* ---------------------------------- apply ------------------------------------ */

/**
 * Required browser services. `sidebarRightTabs` is the tab-type registry, `slots` the seat registry,
 * `locale` the dictionaries above and `shortcuts` the command registry the page switches and the
 * two connection commands are registered into, and `sidebarRight` the frame's navigation face —
 * needed because opening another instance of our own tab types is a frame operation, not a registry
 * one, and because the open-tab inventory it publishes is what decides whether a background
 * connection lives.
 *
 * `shortcuts` and `sidebarRight` come last because they are the only two this plugin merely *calls
 * into*; the others are read while rendering, so they must resolve first.
 */
export const inject = ['slots', 'sidebarRightTabs', 'locale', 'shortcuts', 'sidebarRight'];

/** Client plugin body. Every registration is owned by an effect, so unloading removes it. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'at-terminal: dictionaries');
  ctx.effect(() => ensureStyles(document), 'at-terminal: styles');
  ctx.effect(() => ctx.sidebarRightTabs.register(definition(t)), 'at-terminal: assets tab type');
  ctx.effect(
    () => ctx.sidebarRightTabs.register(sessionDefinition(t)),
    'at-terminal: session tab type'
  );
  ctx.effect(
    () => ctx.sidebarRightTabs.register(monitorDefinition(t)),
    'at-terminal: monitor tab type'
  );

  /* ------------------------------- the commands ------------------------------ */

  // Registered before the seats so the reference panel lists them from the first activation; each
  // disposer is the registry's own, so unloading removes the rows.
  for (const { mode, digit } of MODE_COMMANDS) {
    ctx.effect(
      () => ctx.shortcuts.register(modeCommand(t, mode, digit)),
      `at-terminal: ${mode} shortcut`
    );
  }

  /**
   * Open another instance of the 终端 type, for one named server.
   *
   * `openTab` rather than something of our own because the *address* is the frame's business: for a
   * `multiple` type it mints `${pageAddress(kind)}/${randomUUID()}`, and the new tab therefore keeps
   * its own identity through docking, splitting and reload. All this plugin owns is deciding *when*
   * to ask, and *what for*.
   *
   * **`params` is why this takes a server id.** `openTab` can create a tab but cannot put anything
   * in it; `options.params` is the only channel that reaches the new body, which reads it back from
   * `useTabInfo().tab.navigation` and connects. Without it the tab is empty and the user is back on
   * the asset list choosing a connection again — which is exactly the report that 「新建终端」 "did
   * nothing". `params` also survives docking and a reload, because the frame persists it with the
   * tab's navigation rather than holding it in this closure.
   *
   * The **seed** is stashed alongside as a fallback, and it is not a second copy of the tab's state:
   * the frame records `params` from its own `onCommitted` callback, so a body whose first render
   * lands before that write reads nothing (see `readTabParams`), and this keeps the gesture landing
   * in that window too. It is single-use and expires (`takeSessionSeed`), and the body prefers
   * `params` whenever they are readable.
   *
   * Returns whether the frame took the request, so the caller can say so instead of leaving a
   * double-click with no effect. The frame throws when it has no mounted session to place the tab
   * into — a real state (the sidebar can be collapsed with nothing in it), and one the user *can*
   * act on, so the refusal becomes copy at the call site.
   */
  const openSessionTab = (serverId: string): boolean => {
    stashSessionSeed(serverId);
    try {
      ctx.sidebarRight.openTab(KIND_SESSION, { params: { serverId } });
      return true;
    } catch (error) {
      console.warn('at-terminal: could not open a terminal tab', error);
      return false;
    }
  };

  let hudController: HudController | null = null;

  /** Open or float the monitor tab. */
  const openMonitorTab = (options?: {
    target?: 'hardware' | 'agent_execution';
    serverId?: string;
    mode?: 'float' | 'hud';
  }): boolean => {
    try {
      const mode = options?.mode ?? 'float';
      const target = options?.target ?? 'hardware';
      const serverId = options?.serverId;
      if (mode === 'hud') {
        hudController?.open(target);
        return true;
      }
      const tabResult = ctx.sidebarRight.openTab(KIND_MONITOR, { params: { target, serverId } });
      const openTabs = ctx.sidebarRight.openTabs?.getSnapshot?.() ?? [];
      const monitorTab = openTabs.find((tab) => tab.kind === KIND_MONITOR);
      const tabId = typeof tabResult === 'string' ? tabResult : ((tabResult as any)?.id ?? monitorTab?.tabId);
      if (mode === 'float' && tabId && ctx.sidebarRight.float) {
        ctx.sidebarRight.float(String(tabId), { width: 620, height: 480 });
      }
      return true;
    } catch (error) {
      console.warn('at-terminal: could not open monitor tab', error);
      return false;
    }
  };

  /** Reveal the 资产 tab. A `multiple: false` kind, so this focuses it rather than duplicating it. */
  const revealAssets = (): void => {
    try {
      ctx.sidebarRight.openTab(KIND);
    } catch (error) {
      console.warn('at-terminal: could not reveal the assets tab', error);
    }
  };

  ctx.effect(() => ctx.shortcuts.register(newTabCommand(t, openSessionTab)), 'at-terminal: new tab shortcut');
  ctx.effect(() => ctx.shortcuts.register(assetsCommand(t, revealAssets)), 'at-terminal: assets shortcut');
  ctx.effect(
    () => ctx.shortcuts.register(toggleMonitorCommand(t, () => void openMonitorTab())),
    'at-terminal: monitor shortcut'
  );

  /* --------------------------- monitor sse listener -------------------------- */

  ctx.effect(
    () =>
      listenMonitorEvents((msg) => {
        if (msg.action === 'open') {
          if (msg.mode === 'hud') {
            hudController?.open(msg.target);
          } else {
            openMonitorTab({
              target: msg.target,
              serverId: msg.serverId,
              mode: msg.mode ?? 'float'
            });
          }
        } else if (msg.action === 'close') {
          if (msg.mode === 'hud') {
            hudController?.close();
          }
        }
      }),
    'at-terminal: monitor sse events'
  );

  /* --------------------------- the session lifetime -------------------------- */

  /**
   * Close a session when the frame closes its tab.
   *
   * The frame calls this *before* removing the tab record ("Failure preserves the tab"), which is
   * the only moment at which the content id is still resolvable — after the removal there is nothing
   * left to name. `contentId` is what the session is keyed by, with `tab.id` as the fallback for a
   * body that could not read one.
   */
  ctx.effect(
    () =>
      ctx.sidebarRight.registerCloseHandler(KIND_SESSION, (_sessionId, tab) => {
        const contentId = tab?.contentId;
        const key = typeof contentId === 'string' && contentId !== '' ? contentId : String(tab?.id ?? '');
        if (key !== '') disposeSession(key, true, 'close-handler');
      }),
    'at-terminal: session close'
  );

  /**
   * Hold a connection open for as long as its tab is open — **visible or not**.
   *
   * This is the half that makes switching tabs free. The frame unmounts a background tab's body, so
   * nothing inside React can be the authority on whether a session should live; the frame's own
   * inventory can, and this subscribes to it: every entry of our session kind keeps its connection,
   * and anything the inventory no longer lists is reaped **if the tab's occurrence agrees it is
   * gone** — see `retainSessions`, which explains why the inventory alone is not sufficient evidence.
   *
   * `retainSessions` only ever reaps a session it has previously seen listed, because the inventory
   * is built from saved layouts and a snapshot taken before this window's layout is adopted would
   * otherwise read as "every tab is closed" and kill a connection the user just made.
   */
  ctx.effect(() => {
    const sync = (): void =>
      retainSessions(
        ctx.sidebarRight.openTabs.getSnapshot().filter((tab) => tab.kind === KIND_SESSION)
      );
    const unsubscribe = ctx.sidebarRight.openTabs.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
    };
  }, 'at-terminal: session holds');

  // Unloading the plugin closes every PTY it opened. Without this a disable/enable cycle would leave
  // SSH sessions running with no tab, no chip and no way to reach them.
  ctx.effect(() => () => disposeAllSessions('unload'), 'at-terminal: session teardown');

  // Announced once per activation, before the seats: it answers "did this half run?" independently
  // of whether the user ever opens the tab.
  announceToHost();

  /**
   * The browser-failure trap, installed **first** — before any registration below can throw.
   *
   * A non-fatal render failure leaves no crash report (see `installDiagnostics`), so without this the
   * exact class of bug that blanks the panel is the one bug with no evidence at all.
   */
  installDiagnostics();
  postDiagnostic('info', 'at-terminal client half activating', 'apply', null, null);

  /* --------------------------------- the seats ------------------------------- */

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        // The key is the *definition id*, not the kind: `entryKey: definition?.id ?? tab.kind`. Two
        // types therefore need two ids as well as two kinds, or both bodies would resolve to
        // whichever registered last.
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: ID, locale: NS },
          wrapWithLocale(AtTerminalBody, t, { openSessionTab, openMonitorTab })
        )
      ),
    'at-terminal: assets pane body'
  );

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: ID_SESSION, locale: NS },
          wrapWithLocale(AtTerminalSessionBody, t, { openMonitorTab })
        )
      ),
    'at-terminal: terminal pane body'
  );

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: ID_MONITOR, locale: NS },
          wrapWithLocale(AtTerminalMonitorBody, t, {
            onFloat: (tabId: string) => {
              if (ctx.sidebarRight.float) ctx.sidebarRight.float(tabId, { width: 620, height: 480 });
            }
          })
        )
      ),
    'at-terminal: monitor pane body'
  );

  // Chip titles: reads the badge for its own tab key and picks its
  // fallback label from the tab's kind, so the chips cannot drift apart in what they say.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () => {
        const disposeAssets = ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, wrapWithLocale(AtTerminalTitle, t));
        const disposeSession = ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: ID_SESSION },
          wrapWithLocale(AtTerminalTitle, t)
        );
        const disposeMonitor = ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: ID_MONITOR },
          wrapWithLocale(AtTerminalMonitorTitle, t)
        );
        return () => {
          disposeMonitor();
          disposeSession();
          disposeAssets();
        };
      }),
    'at-terminal: chip titles'
  );

  // HUD floating widget in shell.overlay
  ctx.effect(
    () =>
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: '@at-series/dsh-at-terminal/monitor-hud', locale: NS },
          wrapWithLocale(MonitorHudContainer, t, {
            onOpenPane: (target: 'hardware' | 'agent_execution', serverId?: string) => {
              openMonitorTab({ target, serverId, mode: 'float' });
            },
            onRegisterController: (ctrl: HudController | null) => {
              hudController = ctrl;
            }
          })
        )
      ),
    'at-terminal: monitor hud overlay'
  );

  // Session header utilities button
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: '@at-series/dsh-at-terminal/monitor-button',
            order: 40,
            locale: NS
          },
          wrapWithLocale(MonitorHeaderButton, t, {
            onOpenPane: () => {
              openMonitorTab({ target: 'hardware' });
            }
          })
        )
      ),
    'at-terminal: monitor header button'
  );
}
