/**
 * The assets page: **only** the server list, per the layout the VS Code variant established — a
 * tree of grouped rows — with every management action moved out of the rows: 新增/导入/导出/刷新
 * live on the toolbar, and per-server actions (连接/编辑/复制地址/删除) live in the right-click menu
 * the body renders. Rows stay clean: label, address, auth badge, stored-password badge.
 *
 * **A double-click opens a terminal tab for that server** — the row gesture is how a connection is
 * started. The prop is named `onOpenInNewTab` rather than `onConnect` on purpose: the connection it
 * triggers belongs to a *different tab*, and naming it `onConnect` is how it would quietly be
 * rewired to mean "connect here" — which this page has no terminal for.
 *
 * **No page nav.** This page used to sit behind a 资产/文件/终端 switch, sharing one body with the
 * terminal; the connection pages are their own tab kind now, so the switch is gone rather than
 * merely hidden — a nav with one reachable item is a control that cannot do anything.
 *
 * Pure render function: all state and handlers come from the body.
 */

import {
  authLabel,
  count,
  groupServers,
  serverViews,
  text,
  type ServerView,
  type Translate
} from '../models';
import { h, pathLabel, renderFailure, type AsyncState, type El } from './shared';

export interface AssetSummary {
  servers?: number;
  passwords?: number;
  privateKeyFiles?: number;
  privateKeyDirectory?: string;
}

export interface RemovalState {
  kind: 'idle' | 'pending';
}

export interface RemovalDone {
  kind: 'ok';
  label: string;
  removed: boolean;
}

export interface RemovalFailed {
  kind: 'failed';
  code: string;
  message: string;
}

export interface AssetsViewProps {
  t: Translate;
  hidden: boolean;
  summaryState: AsyncState<AssetSummary>;
  serversState: AsyncState<unknown>;
  removal: RemovalState | RemovalDone | RemovalFailed;
  savedLabel: string | null;
  selectedId: string;
  busy: boolean;
  copied: string | null;
  /**
   * Why a double-click did not open a tab, when the frame refused it — see `openAssetInSessionTab`.
   * A sentence rather than a flag, because the useful answer is "what to do instead".
   */
  notice: string | null;
  onSelect(server: ServerView): void;
  /** Open this server in a **terminal** tab. Wired to the row's double-click. */
  onOpenInNewTab(server: ServerView): void;
  onEdit(server: ServerView): void;
  onRemove(server: ServerView): void;
  onRowMenu(event: { preventDefault(): void; clientX: number; clientY: number }, server: ServerView): void;
  onNew(): void;
  onImport(): void;
  onExport(): void;
  onRefresh(): void;
  collapsedGroups?: readonly string[];
  onToggleGroup?(groupKey: string): void;
}

function toolbarButton(
  t: Translate,
  key: string,
  labelKey: string,
  onClick: () => void,
  disabled: boolean,
  primary = false
): El {
  return h(
    'button',
    {
      key,
      type: 'button',
      className: primary ? 'att-btn primary' : 'att-btn',
      disabled,
      onClick,
      'data-at-terminal-action': key
    },
    t(labelKey)
  );
}

function renderRow(t: Translate, server: ServerView, props: AssetsViewProps): El {
  const selected = props.selectedId === text(server.id);
  return h(
    'div',
    {
      key: text(server.id),
      className: 'att-row',
      role: 'option',
      'aria-selected': selected,
      'data-at-terminal-row': text(server.id),
      onClick: () => props.onSelect(server),
      // A double-click opens a **terminal tab** for this server. The keyboard route to the same act
      // is the `atTerminal.newTab` shortcut; `role="option"` has no key gesture of its own, so
      // nothing here claims one.
      onDoubleClick: () => props.onOpenInNewTab(server),
      onContextMenu: (event: { preventDefault(): void; clientX: number; clientY: number }) =>
        props.onRowMenu(event, server)
    },
    h('span', { className: 'att-row-label' }, text(server.label)),
    h(
      'span',
      { className: 'att-row-addr' },
      `${text(server.username)}@${text(server.host)}:${count(server.port)}`
    ),
    h('span', { className: 'att-badge' }, authLabel(t, server.authType)),
    server.hasPassword === true && server.authType === 'password'
      ? h(
          'span',
          { className: 'att-badge', 'data-at-terminal-badge': 'has-password' },
          t('servers.hasPassword')
        )
      : null
  );
}

/**
 * The pending line: a spinner plus the read's own words.
 *
 * The visible text is `aria-hidden` and the ring carries `role="img"` with the *same*
 * string, so the state is announced exactly once. Labelling both would make a live
 * region read the sentence twice, which is the failure mode that makes a screen-reader
 * user turn live regions off entirely. The name is the visible one either way, which is
 * the point: a loading state nobody can hear is not a loading state.
 *
 * The ring is decorative geometry, so everything about how it looks — the 14px, the
 * rotation, the reduced-motion dot — is in `styles.ts`. Nothing here knows about it.
 *
 * Duplicated verbatim in `sftp.ts` rather than lifted into `shared.ts`: that file is
 * another task's, and a page importing a presentational helper from a sibling page is a
 * worse home for it than a few repeated lines.
 */
function renderPending(t: Translate, labelKey: string): El {
  const label = t(labelKey);
  return h(
    'div',
    { key: 'pending', className: 'att-line att-pending', role: 'status', 'aria-live': 'polite' },
    h('span', { className: 'att-spinner', role: 'img', 'aria-label': label }),
    h('span', { 'aria-hidden': 'true' }, label)
  );
}

function renderList(t: Translate, props: AssetsViewProps): El[] {
  const nodes: El[] = [];
  const state = props.serversState;

  if (state.kind === 'pending') {
    nodes.push(renderPending(t, 'servers.pending'));
    return nodes;
  }
  if (state.kind === 'failed') {
    nodes.push(h('div', { key: 'failed' }, renderFailure(t, state)));
    return nodes;
  }

  const servers = serverViews(state.result);

  if (props.savedLabel !== null) {
    nodes.push(
      h(
        'div',
        { key: 'saved', className: 'att-line', 'data-at-terminal-save': 'ok' },
        t('form.saved', { label: props.savedLabel })
      )
    );
  }
  if (props.removal.kind === 'ok') {
    nodes.push(
      h(
        'div',
        { key: 'removed', className: 'att-line', 'data-at-terminal-remove': 'ok' },
        props.removal.removed
          ? t('servers.removed', { label: props.removal.label })
          : t('servers.removeMissing')
      )
    );
  }
  if (props.removal.kind === 'failed') {
    nodes.push(h('div', { key: 'remove-failed' }, renderFailure(t, props.removal)));
  }

  if (servers.length === 0) {
    nodes.push(h('div', { key: 'empty', className: 'att-hint' }, t('servers.empty')));
    return nodes;
  }

  for (const group of groupServers(servers)) {
    const groupKey = group.name ?? '__ungrouped__';
    const isCollapsed = props.collapsedGroups?.includes(groupKey) ?? false;
    nodes.push(
      h(
        'div',
        {
          key: `group:${group.name ?? ''}`,
          className: 'att-group-name',
          'data-at-terminal-group': group.name ?? '',
          'aria-expanded': !isCollapsed,
          onClick: () => props.onToggleGroup?.(groupKey)
        },
        h('span', { className: 'att-group-disclosure', 'aria-hidden': 'true' }, isCollapsed ? '▶' : '▼'),
        group.name === null ? t('servers.ungrouped') : group.name,
        h('span', { className: 'att-group-count', 'aria-hidden': 'true' }, `(${group.servers.length})`)
      )
    );
    if (!isCollapsed) {
      for (const server of group.servers) nodes.push(renderRow(t, server, props));
    }
  }
  nodes.push(h('div', { key: 'hint', className: 'att-hint' }, t('servers.hint')));
  return nodes;
}

function renderStatusbar(t: Translate, summaryState: AsyncState<AssetSummary>): El {
  if (summaryState.kind !== 'ok') {
    return h(
      'div',
      { className: 'att-statusbar', role: 'status', 'data-at-terminal-summary': summaryState.kind },
      summaryState.kind === 'pending' ? t('summary.pending') : t('error.title')
    );
  }
  const result = summaryState.result ?? {};
  return h(
    'div',
    { className: 'att-statusbar', role: 'status', 'data-at-terminal-summary': 'ok' },
    h('span', { 'data-at-terminal-summary-count': 'servers' }, t('summary.servers', { count: count(result.servers) })),
    h('span', { 'data-at-terminal-summary-count': 'passwords' }, t('summary.passwords', { count: count(result.passwords) })),
    h('span', { 'data-at-terminal-summary-count': 'privateKeys' }, t('summary.privateKeys', { count: count(result.privateKeyFiles) })),
    // The label stays outside the path element so the path can be one `PathLabel`
    // with a dimmed directory and a primary-colored leaf; folding the sentence into
    // the same span would color the label as if it were part of the path.
    h(
      'span',
      { 'data-at-terminal-summary-count': 'directory' },
      h('span', null, t('summary.directoryLabel')),
      result.privateKeyDirectory === '' || result.privateKeyDirectory === undefined
        ? h('span', { className: 'att-dir' }, t('sftp.pathUnknown'))
        : pathLabel(text(result.privateKeyDirectory))
    )
  );
}

export function renderAssetsView(props: AssetsViewProps): El {
  const { t } = props;
  return h(
    'div',
    {
      className: 'att-page',
      key: 'assets',
      hidden: props.hidden,
      // A region rather than a `tabpanel`: this page is the whole body of its own tab kind, not
      // one panel of a tablist. It used to claim `role="tabpanel"` for the removed page nav, and
      // an orphaned panel role is worse than none — it advertises a controller that is not there.
      role: 'region',
      'aria-label': t('servers.title'),
      'data-at-terminal-page': 'assets'
    },
    h(
      'div',
      { className: 'att-toolbar' },
      h('div', { className: 'att-spacer' }),
      props.copied !== null ? h('span', { className: 'att-copied' }, props.copied) : null,
      toolbarButton(t, 'new-server', 'toolbar.new', props.onNew, props.busy, true),
      toolbarButton(t, 'import', 'toolbar.import', props.onImport, props.busy),
      toolbarButton(t, 'export', 'toolbar.export', props.onExport, props.busy),
      toolbarButton(t, 'refresh', 'toolbar.refresh', props.onRefresh, props.busy)
    ),
    // Directly under the toolbar rather than in the list: the list may be mid-read or empty when
    // the gesture is refused, and a notice inside a region that failed to load is a notice nobody
    // reads. `role="status"` because it appears in response to an action.
    props.notice === null
      ? null
      : h(
          'div',
          { className: 'att-banner', role: 'status', 'data-at-terminal-notice': 'tab-refused' },
          props.notice
        ),
    h('div', { className: 'att-content', role: 'listbox', 'aria-label': t('servers.title') }, renderList(t, props)),
    renderStatusbar(t, props.summaryState)
  );
}