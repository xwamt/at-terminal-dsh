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

import React, { useEffect, useRef, useState } from 'react';
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
import { AtTerminalCommandRow, TOOL_RUN_REMOTE_COMMAND } from './views/toolCall';
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
import { clearAllTabState, clearTabState } from './tabState';
import { disposeStyles, withStyles } from './stylesGate';
import { setFormatLocale } from './localeFormat';
import { gaugeRegular, guideTerminalArtwork } from './icons';
import type { AgentAuditSummary, AgentExecutionSnapshot, HardwareMetrics, Translate } from './models';
import type { PanelMode } from './views/shared';
import { h } from './views/shared';
import { AtTerminalSettingsTab } from './views/settingsTab';

/** The narrow slice of the client context this plugin touches. */
export interface ClientContext {
  effect(setup: () => unknown, label?: string): unknown;
  locale: {
    bind(ns: string): Translate;
    register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void;
    /** Optional in the host's service directory — probed, never assumed. See `apply`. */
    getLocale?: () => string;
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
        description: () => t('guide.description'),
        /*
         * The two fields that make the standard guide card look finished (UI2-06).
         *
         * Without `icon` the card renders the registry's placeholder square — the one card in the
         * column that looks unfinished. Without `commandId` it renders no shortcut, even though
         * this panel has one. Both fields are what the host's own `sidebar-files` entry supplies,
         * which is how the shape was confirmed rather than guessed.
         *
         * The artwork is 26px and drawn at 1.5px on its own artboard; see `icons/artwork.ts` for
         * why the 16px glyph is not scaled up into this slot.
         */
        icon: guideTerminalArtwork,
        commandId: 'atTerminal.mode.assets'
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
      className: 'att-nav-btn att-icon-btn',
      // Styled inline as well as by class: this button lives in the conversation header, so it
      // mounts in *every* session, and a class-only button would drag the styles chunk onto that
      // path (which is the whole 77 kB the split exists to avoid). The inline copy is the static
      // half of `.att-nav-btn`; hover and the selected state still come from the stylesheet once
      // some other surface has loaded it.
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '28px',
        padding: '0 10px',
        border: 'none',
        background: 'transparent',
        color: 'var(--vscode-descriptionForeground)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px'
      },
      title: props.t('monitor.title'),
      'aria-label': props.t('monitor.title'),
      onClick: () => props.onOpenPane()
    },
    // The glyph replaces a `📊` emoji, which rendered in colour on every platform and at a weight
    // no token could control — the loudest thing in a 28px toolbar.
    gaugeRegular({ size: 16 })
  );
}

interface HudController {
  /**
   * Show the HUD. `serverId` names whose numbers to show; without it the HUD keeps following
   * the active terminal session, which is the right default for a user-opened panel and the
   * wrong one for an explicit request (a tool call or `/ssh-metrics` naming a server).
   */
  open(target?: 'hardware' | 'agent_execution', serverId?: string): void;
  close(): void;
  toggle(): void;
}

function MonitorHudContainer(props: {
  t: Translate;
  onRegisterController?: (ctrl: HudController | null) => void;
}) {
  const { t, onRegisterController } = props;
  const [metrics, setMetrics] = useState<HardwareMetrics | null>(null);
  const [snapshot, setSnapshot] = useState<AgentExecutionSnapshot | null>(null);
  const [visible, setVisible] = useState<boolean>(false);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [forceExpanded, setForceExpanded] = useState<boolean | undefined>(undefined);
  const [initialSubtab, setInitialSubtab] = useState<'overview' | 'hardware' | 'agent'>('overview');
  /**
   * Audits seen since the current connection started, newest first.
   *
   * The RPC answers with the server's most recent slice, so the HUD keeps what it has already
   * seen and merges each poll into it — that is what lets the agent tab offer "this connection's
   * history" instead of only the last few rows. Cleared on disconnect, so reconnecting starts a
   * new list rather than inheriting the previous connection's rows.
   */
  const [auditHistory, setAuditHistory] = useState<AgentAuditSummary[]>([]);
  const connectedRef = useRef(false);
  const connectionStartedAtRef = useRef(0);
  const seenAuditIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (onRegisterController) {
      onRegisterController({
        open: (target, serverId) => {
          setVisible(true);
          setForceExpanded(true);
          if (target === 'hardware') setInitialSubtab('hardware');
          else if (target === 'agent_execution') setInitialSubtab('agent');
          else setInitialSubtab('overview');
          // An explicit request picks its own server; otherwise the active-terminal sync below
          // keeps deciding, which is what an idle HUD should do.
          if (serverId !== undefined && serverId !== '') setActiveServerId(serverId);
        },
        close: () => {
          setVisible(false);
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
        if (!connectedRef.current) {
          /*
           * A brand-new connection opens as the capsule, not the expanded window.
           *
           * `forceExpanded` outlives a disconnect — the container is mounted for the page's whole
           * lifetime — so without resetting it here the HUD came back expanded after any earlier
           * `open()`, which is exactly the "connected and it popped open" report. The tab and the
           * history reset with it: a new connection starts clean.
           */
          connectedRef.current = true;
          connectionStartedAtRef.current = Date.now();
          seenAuditIdsRef.current = new Set();
          setAuditHistory([]);
          setForceExpanded(false);
          setInitialSubtab('overview');
        }
        setVisible(true);
      } else {
        connectedRef.current = false;
        connectionStartedAtRef.current = 0;
        seenAuditIdsRef.current = new Set();
        setAuditHistory([]);
        setForceExpanded(false);
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
        // Ask for everything the bridge retains: the history view must be able to show more
        // than the four rows the default view renders, and the merge below de-duplicates.
        getAgentExecutionStatusRpc(50).catch(() => null)
      ]).then(([m, s]) => {
        if (unmounted) return;
        if (m) setMetrics(m);
        if (s) {
          setSnapshot(s);
          const startedAt = connectionStartedAtRef.current;
          if (startedAt > 0) {
            const seen = seenAuditIdsRef.current;
            const fresh = (s.recentAudits || []).filter(
              (audit) => !seen.has(audit.id) && audit.timestamp >= startedAt
            );
            if (fresh.length > 0) {
              for (const audit of fresh) seen.add(audit.id);
              setAuditHistory((prev) =>
                [...fresh, ...prev].sort((a, b) => b.timestamp - a.timestamp).slice(0, 200)
              );
            }
          }
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
    initialSubtab,
    activeServerId,
    activeLabel,
    auditHistory,
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

  /*
   * Hand the host's locale to the clock formatter.
   *
   * `getLocale` is optional in the service directory, so this probes instead of assuming: on a
   * host that does not expose it the formatter keeps the runtime default, which is exactly the
   * old behaviour — no throw, no blank column. Read once at activation because the panel has no
   * subscription to locale changes and a re-read on every render would cost more than the drift
   * it fixes.
   */
  if (typeof ctx.locale.getLocale === 'function') {
    try {
      setFormatLocale(ctx.locale.getLocale());
    } catch {
      // A locale service that throws on read is not worth failing activation over.
    }
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'at-terminal: dictionaries');
  // The stylesheet is a chunk now: injected by the first surface that renders, not here.
  // This effect only owns the teardown, so an unload still removes what the gate added.
  ctx.effect(() => () => disposeStyles(), 'at-terminal: styles teardown');
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

  /**
   * Open the monitor: floating HUD by default, right-sidebar pane when asked for `tab`.
   *
   * The pane and the HUD read the target from different places — the pane from its tab's
   * `navigation.params`, the HUD from its controller — so both are passed explicitly. The
   * `mode` argument used to be accepted and ignored, which made `open_monitor`'s `mode` a
   * promise the client broke without saying so.
   */
  const openMonitorTab = (options?: {
    target?: 'hardware' | 'agent_execution';
    serverId?: string;
    mode?: 'hud' | 'tab';
  }): boolean => {
    const target = options?.target ?? 'hardware';
    if (options?.mode === 'tab') {
      try {
        // `multiple: false`, so this focuses the existing pane instead of stacking duplicates.
        ctx.sidebarRight.openTab(KIND_MONITOR, {
          params: { target, serverId: options.serverId }
        });
        return true;
      } catch (error) {
        // The frame throws when there is no mounted session to place the tab into — the sidebar
        // can be collapsed with nothing in it. Said out loud rather than falling back to the
        // HUD, because silently rendering somewhere else is the confusion this whole card is
        // about.
        console.warn('at-terminal: could not open the monitor tab', error);
        return false;
      }
    }
    try {
      if (hudController) {
        hudController.open(target, options?.serverId);
        return true;
      }
      return false;
    } catch (error) {
      console.warn('at-terminal: could not open monitor floating window', error);
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
          // Unknown modes fall to the HUD, matching the Host's own default (`input.mode ?? 'hud'`).
          // This used to test for `'hud'` and send everything else down the pane path with a
          // `?? 'float'` default — a mode that no longer exists anywhere.
          if (msg.mode === 'tab') {
            openMonitorTab({ target: msg.target, serverId: msg.serverId, mode: 'tab' });
          } else {
            // `msg.serverId` was dropped here, so a HUD opened by a tool call or a command
            // showed the active terminal's server — or "未选择服务器" when none was open.
            hudController?.open(msg.target, msg.serverId);
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
        if (key === '') return;
        disposeSession(key, true, 'close-handler');
        // The tab is gone for good, so its UI bucket is too: an expansion list and a scroll
        // offset for a tab nobody can reopen are the only unbounded part of `tabState`.
        clearTabState(key);
      }),
    'at-terminal: session close'
  );

  /**
   * The same for the 资产 tab, which has UI state but no session.
   *
   * Both kinds are registered rather than one: `registerCloseHandler` is per kind, and the
   * assets tab's draft form is exactly the state a user would be most upset to have survive a
   * close and reappear in a *new* tab (a new tab gets a new `contentId`, so it would not — but
   * the bucket would sit in memory labelling a tab that no longer exists).
   */
  ctx.effect(
    () =>
      ctx.sidebarRight.registerCloseHandler(KIND, (_sessionId, tab) => {
        const contentId = tab?.contentId;
        const key = typeof contentId === 'string' && contentId !== '' ? contentId : String(tab?.id ?? '');
        clearTabState(key);
      }),
    'at-terminal: assets tab state'
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
  ctx.effect(
    () => () => {
      disposeAllSessions('unload');
      // The UI buckets belong to the tabs this activation can see; a reload builds a new set.
      clearAllTabState();
    },
    'at-terminal: session teardown'
  );

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
          wrapWithLocale(withStyles(AtTerminalBody), t, { openSessionTab, openMonitorTab })
        )
      ),
    'at-terminal: assets pane body'
  );

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: ID_SESSION, locale: NS },
          wrapWithLocale(withStyles(AtTerminalSessionBody), t, { openMonitorTab })
        )
      ),
    'at-terminal: terminal pane body'
  );

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: ID_MONITOR, locale: NS },
          wrapWithLocale(withStyles(AtTerminalMonitorBody), t)
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

  /**
   * Settings → 插件 → AT Terminal.
   *
   * `settings.plugins.tab` is a **list** slot owned by `ui-settings-plugins`
   * (`lib/client.js:201-212`); that package owns the Settings navigation entry and the tab
   * chrome, and renders each tab's body through the same slot with `only: <id>` (`:68`). So
   * this one registration is the whole tab — no section plumbing of our own, and no `kind`
   * taken from anyone else.
   */
  ctx.effect(
    () =>
      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: '@at-series/dsh-at-terminal/settings',
            order: 20,
            label: () => 'AT Terminal'
          },
          // Wrapped, not bare: the slot hands a body its tab record, not copy, so the tab reads
          // `t` from `BodyLocale` — exactly like the two sidebar bodies. A bare registration
          // compiles and mounts, and then prints dictionary keys or, worse, whatever language
          // was hard-coded, to a user whose Harness is in the other one.
          wrapWithLocale(withStyles(AtTerminalSettingsTab), t)
        )
      ),
    'at-terminal: settings tab'
  );

  // HUD floating widget in shell.overlay
  ctx.effect(
    () =>
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: '@at-series/dsh-at-terminal/monitor-hud', locale: NS },
          wrapWithLocale(withStyles(MonitorHudContainer), t, {
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

  /**
   * The conversation card for one remote command (UI2-12).
   *
   * The slot is keyed by the **wire** tool name, so this registration replaces the Host's generic
   * row for that one tool and nothing else. It is last in `apply` on purpose: it is the one seat
   * here that renders outside our panel, and if it ever has to be withdrawn — the block contract
   * moves, the row reads wrong — deleting this block is the whole rollback, with no other seat
   * depending on it.
   */
  ctx.effect(
    () =>
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: TOOL_RUN_REMOTE_COMMAND, locale: NS },
          wrapWithLocale(withStyles(AtTerminalCommandRow), t)
        )
      ),
    'at-terminal: remote command tool card'
  );
}
