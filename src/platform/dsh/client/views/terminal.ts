/**
 * The terminal page: the real xterm terminal, wrapped in the **same chrome the
 * VS Code variant renders** (`TerminalPanel.ts`'s `.terminal-shell` →
 * `.terminal-status` header with dot, text, reconnect button and find bar →
 * `.terminal-surface`), so `webview/terminal/index.css` styles it unchanged.
 *
 * This is a component (not a plain render function) because the engine owns
 * DOM-bound lifecycle: it is created against the container ref, recreated when
 * the user's settings change, re-fitted when the page becomes visible again,
 * and disposed on unmount. The socket and flow control stay in the body — the
 * engine is only the renderer end of them.
 */

import React, { type ReactElement } from 'react';

import { resolveTerminalStatusClass, type TerminalStatusState } from '../../../../../webview/terminal/clipboard';
import type { TerminalSessionState } from '../frames';
import { count, text, type ServerView, type Translate } from '../models';
import type { TerminalEngine, TerminalEngineHooks, TerminalUiSettings } from '../xtermEngine';
import { createTerminalEngine } from '../xtermEngine';
import { h, navPanelId, navTabId, renderNav, type El, type PanelMode } from './shared';

export interface TerminalViewProps {
  t: Translate;
  visible: boolean;
  mode: PanelMode;
  onMode(mode: PanelMode): void;
  serversState: { kind: string };
  servers: ServerView[];
  selectedServerId: string;
  onSelect(id: string): void;
  onConnect(): void;
  onDisconnect(): void;
  termState: TerminalSessionState;
  settings: TerminalUiSettings;
  /** Bumped when `settings` changed; the engine is recreated on it. */
  settingsVersion: number;
  encoding: string | undefined;
  hooks: TerminalEngineHooks;
  onEngine(engine: TerminalEngine | null): void;
  onOpenMonitor?(): void;
}

function statusText(t: Translate, termState: TerminalSessionState): string {
  const label = t(`terminal.state.${termState.kind}`);
  const detail = text(termState.text);
  return detail === '' ? label : `${label} — ${detail}`;
}

export function TerminalView(props: TerminalViewProps): ReactElement {
  const containerRef = React.useRef<HTMLElement | null>(null);
  const rootRef = React.useRef<HTMLElement | null>(null);
  const barRef = React.useRef<HTMLElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const prevRef = React.useRef<HTMLElement | null>(null);
  const nextRef = React.useRef<HTMLElement | null>(null);
  const closeRef = React.useRef<HTMLElement | null>(null);
  const visibleRef = React.useRef(props.visible);
  const engineRef = React.useRef<TerminalEngine | null>(null);

  const { settingsVersion, encoding } = props;

  // Create the engine against the mounted container. Recreated only when the
  // user's settings change — the caller bumps `settingsVersion` for that.
  React.useEffect(() => {
    const container = containerRef.current;
    const root = rootRef.current;
    const bar = barRef.current;
    const input = inputRef.current;
    const prev = prevRef.current;
    const next = nextRef.current;
    const close = closeRef.current;
    if (
      container === null ||
      root === null ||
      bar === null ||
      input === null ||
      prev === null ||
      next === null ||
      close === null
    ) {
      return undefined;
    }
    const engine = createTerminalEngine({
      container,
      root,
      settings: props.settings,
      encoding,
      hooks: props.hooks,
      search: { bar, input, prev, next, close }
    });
    engineRef.current = engine;
    props.onEngine(engine);
    return () => {
      engine.dispose();
      engineRef.current = null;
      props.onEngine(null);
    };
    // `props.settings`/`props.hooks` are read at creation; identity churn must
    // not rebuild the terminal, so only the version and encoding re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsVersion, encoding]);

  // Re-fit and refocus when the page becomes visible: a `display:none` container
  // has no metrics, so the fit that ran while hidden reported the fallback size.
  React.useEffect(() => {
    if (props.visible && !visibleRef.current) {
      engineRef.current?.fit();
      engineRef.current?.focus();
    }
    visibleRef.current = props.visible;
  }, [props.visible]);

  const { t, termState } = props;
  const live = termState.kind === 'connected' || termState.kind === 'connecting';
  const chosen = props.servers.find((server) => text(server.id) === props.selectedServerId);
  // The webview's own mapping: `idle` lands in the default branch (the yellow
  // "waiting" dot), which is the honest colour for a page nobody connected yet.
  const statusClass: TerminalStatusState = resolveTerminalStatusClass(termState.kind);

  return h(
    'div',
    {
      className: 'att-page att-terminal-page',
      ref: rootRef,
      hidden: !props.visible,
      'data-at-terminal-page': 'terminal',
      // The panel the nav's 终端 tab controls. `aria-labelledby` names the tab *in this
      // page's own nav*, because the other two navs carry tabs of the same name.
      role: 'tabpanel',
      id: navPanelId('terminal'),
      'aria-labelledby': navTabId('terminal', 'terminal')
    },
    h(
      'div',
      { className: 'att-terminal-toolbar' },
      // `'terminal'` is passed explicitly even though `renderNav` defaults to it: the default
      // exists only so this call site kept compiling while the panel ids were being wired up.
      // Relying on it would hide a real intent — this nav must not collide with the other two.
      renderNav(t, props.mode, props.onMode, 'terminal'),
      h(
        'select',
        {
          className: 'att-select',
          value: props.selectedServerId,
          /**
           * Disabled while live, not only while the list is unusable.
           *
           * The selector changes which server the *next* connection opens, but the status bar,
           * the tab chip and the PTY all describe the **current** one. Enabling it mid-session
           * is what produced "the chip says B, the PTY is on A": the state was honest about the
           * selection and the connection was honest about the PTY, and the user had no way to
           * tell which of the two labels to believe. `setSessionTarget` refuses the same change
           * from the model side; see its comment for why both exist.
           */
          disabled:
            props.serversState.kind !== 'ok' || props.servers.length === 0 || live,
          // A disabled control cannot show a tooltip reliably in every browser, but the wrapper
          // keeps the reason reachable: `title` on the select still surfaces on hover in
          // Chromium, and the status line below states the connection anyway.
          title: live ? t('terminal.selectLocked') : undefined,
          onChange: (event: { target?: { value?: unknown } }) => props.onSelect(text(event?.target?.value)),
          'aria-label': t('terminal.select'),
          'aria-describedby': live ? 'att-term-lock-hint' : undefined,
          'data-at-terminal-action': 'term-select',
          'data-at-terminal-locked': live ? 'true' : 'false'
        },
        h('option', { value: '' }, t('terminal.select')),
        props.servers.map((server) =>
          h(
            'option',
            { key: text(server.id), value: text(server.id) },
            `${text(server.label)} (${text(server.username)}@${text(server.host)}:${count(server.port)})`
          )
        )
      ),
      // The reason a keyboard or screen-reader user cannot change the selector. Visually hidden
      // rather than shown: the toolbar is already the tightest row in a narrow panel (UI2-07), and
      // a permanent sentence explaining a disabled control would cost more than it says. Referenced
      // by `aria-describedby` instead of being a second live region — the status line already
      // announces the connection state, and two announcements for one change is noise.
      live
        ? h('span', { id: 'att-term-lock-hint', className: 'att-sr-only' }, t('terminal.selectLocked'))
        : null,
      live
        ? h(
            'button',
            {
              type: 'button',
              className: 'att-btn',
              onClick: props.onDisconnect,
              'data-at-terminal-action': 'term-disconnect'
            },
            t('terminal.disconnect')
          )
        : h(
            'button',
            {
              type: 'button',
              className: 'att-btn primary',
              disabled: props.serversState.kind !== 'ok',
              onClick: props.onConnect,
              'data-at-terminal-action': 'term-connect'
            },
            t('terminal.connect')
          ),
      h('div', { className: 'att-spacer' }),
      props.onOpenMonitor
        ? h(
            'button',
            {
              type: 'button',
              className: 'att-nav-btn',
              title: t('monitor.title'),
              'aria-label': t('monitor.title'),
              onClick: props.onOpenMonitor,
              'data-at-terminal-action': 'term-monitor'
            },
            '📊'
          )
        : null,
      /**
       * No 「新建终端」 button here any more.
       *
       * It could only ever open an *empty* tab — the body has no way to name a server for a
       * tab it is not in — so the user landed on the asset list and had to pick a connection
       * again, which reads as "the button did nothing". Starting a terminal belongs to the
       * gesture that already names one: **double-clicking a row on 资产**, whose keyboard
       * equivalent is the `atTerminal.newTab` shortcut. This toolbar's own selector plus
       * 连接 remains the way to retarget **this** tab.
       *
       * Reverse-tested: restoring a control carrying `data-at-terminal-action="term-new-tab"`
       * fails the assertion in `client-bundle.test.ts`.
       */
      h('span', { className: 'att-chip' }, t('terminal.searchHint'))
    ),
    h(
      'main',
      { className: 'terminal-shell' },
      h(
        'header',
        {
          className: `terminal-status terminal-status--${statusClass}`,
          id: 'status',
          role: 'status',
          'aria-live': 'polite',
          'data-at-terminal-term-status': termState.kind
        },
        h('span', { className: 'terminal-status-dot' }),
        h('span', { className: 'terminal-status-text' }, statusText(t, termState)),
        h(
          'button',
          {
            type: 'button',
            id: 'reconnect',
            className: 'terminal-reconnect',
            hidden: termState.kind !== 'disconnected',
            onClick: props.onConnect,
            'data-at-terminal-action': 'term-reconnect'
          },
          t('terminal.reconnect')
        ),
        h(
          'div',
          { id: 'find', className: 'terminal-find', ref: barRef, hidden: true },
          h('input', {
            id: 'find-input',
            className: 'terminal-find-input',
            type: 'text',
            ref: inputRef,
            placeholder: t('terminal.find'),
            'aria-label': t('terminal.find')
          }),
          h(
            'button',
            {
              type: 'button',
              id: 'find-prev',
              className: 'terminal-find-button',
              ref: prevRef,
              title: t('terminal.findPrev')
            },
            '\u2191'
          ),
          h(
            'button',
            {
              type: 'button',
              id: 'find-next',
              className: 'terminal-find-button',
              ref: nextRef,
              title: t('terminal.findNext')
            },
            '\u2193'
          ),
          h(
            'button',
            {
              type: 'button',
              id: 'find-close',
              className: 'terminal-find-button',
              ref: closeRef,
              title: t('terminal.findClose')
            },
            '\u2715'
          )
        ),
        h(
          'span',
          { className: 'terminal-host' },
          chosen === undefined
            ? t('terminal.engine')
            : `${text(chosen.username)}@${text(chosen.host)}:${count(chosen.port)}`
        )
      ),
      h('section', {
        id: 'terminal',
        className: 'terminal-surface',
        ref: containerRef,
        'data-at-terminal-action': 'term-surface'
      })
    )
  );
}