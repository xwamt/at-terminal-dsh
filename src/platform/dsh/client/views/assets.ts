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
import {
  chevronDownRegular,
  chevronRightRegular,
  exportRegular,
  gaugeRegular,
  importRegular,
  overflowRegular,
  refreshRegular,
  serverRegular,
  terminalRegular
} from '../icons';

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
  /**
   * The list filter, owned by the body.
   *
   * In the body rather than here because this is a pure render function — and because the value
   * has to survive a re-render triggered by an unrelated RPC reply, which is exactly what a
   * `useState` inside a function called during another component's render does not buy.
   */
  query: string;
  onQuery(value: string): void;
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
  /**
   * Open the monitor tab. Optional on purpose: the toolbar button only exists when the frame
   * offers the tab — and it takes no argument, because the toolbar is not about any one row.
   * Reading the row selection here would point the HUD at a server the user never asked about.
   */
  onOpenMonitor?(): void;
  collapsedGroups?: readonly string[];
  onToggleGroup?(groupKey: string): void;
  /**
   * The scrolling list box, so the body can put it back where the user left it.
   *
   * A ref object rather than a callback: the body needs to *write* `scrollTop` after an
   * asynchronous read lands, which is not a moment React will call anything back on.
   */
  scrollRef?: { current: HTMLElement | null };
  /** Reported on scroll only — the offset never re-renders the list. */
  onScrollTop?(top: number): void;
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

/**
 * A 28px icon-only toolbar button.
 *
 * The `title` and the `aria-label` carry the same string, and both are needed: `title` is the
 * hover tooltip, `aria-label` is the accessible name. An icon-only control with only one of them
 * is either unreadable to a screen reader or undiscoverable with a mouse — and a `title` alone is
 * the more common mistake, because it *looks* like it labels the button.
 *
 * The icon is `aria-hidden` by construction (see `icons/index.ts`), so the name has to come from
 * here or the button has none.
 */
function iconButton(
  key: string,
  label: string,
  icon: El,
  onClick: () => void,
  disabled = false,
  action = key
): El {
  return h(
    'button',
    {
      key,
      type: 'button',
      className: 'att-btn att-icon-btn',
      title: label,
      'aria-label': label,
      disabled,
      onClick,
      'data-at-terminal-action': action
    },
    icon
  );
}

/**
 * Where a menu opened from a *button* should sit.
 *
 * A right-click already carries the pointer position; a click on the row's `⋯` carries the
 * pointer too, but a keyboard-activated click reports 0,0, which would pin the menu to the
 * viewport corner. The button's own rect is the honest anchor in that case — and it is also
 * better for the pointer: the menu opens under the button the user actually pressed.
 */
function menuAnchor(event: {
  clientX?: number;
  clientY?: number;
  currentTarget?: { getBoundingClientRect?: () => { left: number; bottom: number } };
}): { clientX: number; clientY: number } {
  const rect = event.currentTarget?.getBoundingClientRect?.();
  if (rect !== undefined && (event.clientX === undefined || event.clientX === 0)) {
    return { clientX: rect.left, clientY: rect.bottom };
  }
  return { clientX: Number(event.clientX ?? 0), clientY: Number(event.clientY ?? 0) };
}

/** Case-insensitive substring match across the three fields a user would search by. */
function matchesQuery(server: ServerView, needle: string): boolean {
  if (needle === '') return true;
  const haystack = [
    text(server.label),
    text(server.host),
    text(server.username),
    text(server.group ?? '')
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
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
      : null,
    /*
     * The row's own actions, revealed on hover/focus.
     *
     * Right-click is the menu's only route for a mouse user who never tries it, and no route at all
     * for a touch screen — so the `⋯` is the visible half of the same menu, and 连接 is the
     * discoverable form of the double-click. Both call the handlers the gesture already calls, so
     * there is no second implementation to keep in step; they are absolutely positioned inside the
     * row (`.att-row-actions`) so they take no width when hidden and cannot reflow the address.
     */
    h(
      'span',
      { className: 'att-row-actions' },
      h(
        'button',
        {
          key: 'connect',
          type: 'button',
          className: 'att-row-action',
          title: t('servers.connect'),
          'aria-label': `${t('servers.connect')} ${text(server.label)}`,
          onClick: (event: { stopPropagation(): void }) => {
            // Without this the click also selects the row, which would move the selection out from
            // under the tab that is about to open.
            event.stopPropagation();
            props.onOpenInNewTab(server);
          },
          'data-at-terminal-action': 'row-connect'
        },
        terminalRegular({ size: 14 })
      ),
      h(
        'button',
        {
          key: 'menu',
          type: 'button',
          className: 'att-row-action',
          title: t('servers.more'),
          'aria-label': `${t('servers.more')} ${text(server.label)}`,
          'aria-haspopup': 'menu',
          onClick: (event: {
            stopPropagation(): void;
            clientX?: number;
            clientY?: number;
            currentTarget?: { getBoundingClientRect?: () => { left: number; bottom: number } };
          }) => {
            event.stopPropagation();
            props.onSelect(server);
            props.onRowMenu({ preventDefault() {}, ...menuAnchor(event) }, server);
          },
          'data-at-terminal-action': 'row-menu'
        },
        overflowRegular({ size: 14 })
      )
    )
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

/**
 * The empty list, as an answer rather than a sentence.
 *
 * A bare line of text ("no servers yet") leaves the one question that matters — *what do I do
 * now* — to the toolbar a few hundred pixels above. This puts the two actions that resolve it
 * inside the space where the user is already looking, which is the difference between an empty
 * state and a dead end. It also becomes the home of the double-click hint, which used to sit at
 * the bottom of every list, i.e. out of sight exactly when the list got long.
 */
function renderEmpty(t: Translate, props: AssetsViewProps, filtering: boolean): El {
  if (filtering) {
    return h(
      'div',
      { key: 'empty', className: 'att-empty', 'data-at-terminal-empty': 'filtered' },
      h('span', { className: 'att-empty-icon', 'aria-hidden': 'true' }, serverRegular({ size: 28 })),
      h('span', { className: 'att-empty-title' }, t('servers.noMatch')),
      h('span', { className: 'att-empty-text' }, t('servers.noMatchHint'))
    );
  }
  return h(
    'div',
    { key: 'empty', className: 'att-empty', 'data-at-terminal-empty': 'none' },
    h('span', { className: 'att-empty-icon', 'aria-hidden': 'true' }, serverRegular({ size: 28 })),
    h('span', { className: 'att-empty-title' }, t('servers.emptyTitle')),
    h('span', { className: 'att-empty-text' }, t('servers.empty')),
    h(
      'span',
      { className: 'att-empty-actions' },
      h(
        'button',
        {
          key: 'empty-new',
          type: 'button',
          className: 'att-btn primary',
          onClick: props.onNew,
          'data-at-terminal-action': 'empty-new'
        },
        t('toolbar.new')
      ),
      h(
        'button',
        {
          key: 'empty-import',
          type: 'button',
          className: 'att-btn',
          onClick: props.onImport,
          'data-at-terminal-action': 'empty-import'
        },
        t('toolbar.import')
      )
    ),
    h('span', { className: 'att-empty-hint' }, t('servers.hint'))
  );
}

/**
 * The rows, and *only* rows.
 *
 * `role="listbox"` may contain options and group headers, and nothing else — a hint, a failure
 * banner or an empty state inside one advertises itself as a selectable item to a screen reader
 * and breaks the arrow-key model. They used to be pushed into the same array; the notices now
 * live above the list and the empty state replaces it.
 */
function renderRows(t: Translate, props: AssetsViewProps, servers: ServerView[]): El[] {
  const nodes: El[] = [];
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
        // The disclosure is a glyph rather than a `▶`/`▼` character: those two are drawn by the
        // ambient font, so their weight and bearing changed with the platform and they never lined
        // up with the 16px icons in the rows below.
        h(
          'span',
          { className: 'att-group-disclosure', 'aria-hidden': 'true' },
          isCollapsed ? chevronRightRegular({ size: 12 }) : chevronDownRegular({ size: 12 })
        ),
        group.name === null ? t('servers.ungrouped') : group.name,
        h('span', { className: 'att-group-count', 'aria-hidden': 'true' }, `(${group.servers.length})`)
      )
    );
    if (!isCollapsed) {
      for (const server of group.servers) nodes.push(renderRow(t, server, props));
    }
  }
  return nodes;
}

/** The transient lines above the list: saved, removed, and the removal's failure. */
function renderNotices(t: Translate, props: AssetsViewProps): El[] {
  const nodes: El[] = [];
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
  return nodes;
}

/**
 * The bar under the list.
 *
 * Keeps the two facts a user reads without deciding anything — how many servers there are, and
 * where private keys live — and moves the other two into a `title`. 已存口令 / 私钥文件 are
 * counts nobody acts on; they cost a third of a 380px bar and forced the path to wrap. A tooltip
 * still answers the question, and the `data-` hooks stay so the numbers remain assertable.
 */
function renderStatusbar(t: Translate, summaryState: AsyncState<AssetSummary>): El {
  if (summaryState.kind !== 'ok') {
    return h(
      'div',
      { className: 'att-statusbar', role: 'status', 'data-at-terminal-summary': summaryState.kind },
      summaryState.kind === 'pending' ? t('summary.pending') : t('error.title')
    );
  }
  const result = summaryState.result ?? {};
  const detail = [
    t('summary.passwords', { count: count(result.passwords) }),
    t('summary.privateKeys', { count: count(result.privateKeyFiles) })
  ].join(' · ');
  return h(
    'div',
    { className: 'att-statusbar', role: 'status', 'data-at-terminal-summary': 'ok' },
    h(
      'span',
      {
        'data-at-terminal-summary-count': 'servers',
        title: detail,
        'data-at-terminal-summary-detail': detail
      },
      t('summary.servers', { count: count(result.servers) })
    ),
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
  const state = props.serversState;
  const all = state.kind === 'ok' ? serverViews(state.result) : [];
  const filtering = props.query.trim() !== '';
  const visible = all.filter((server) => matchesQuery(server, props.query.trim()));

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
      /*
       * Search first, because it is the only control that scales with the list. It filters
       * locally: `servers.list` has already returned every record, so a round trip per keystroke
       * would be slower and would also empty the list while the user is still typing.
       *
       * `type="search"` rather than `text`: the browser's own clear affordance and Escape are then
       * free, and a filter box with no visible way out is the one thing users get stuck on.
       */
      h('input', {
        className: 'att-search',
        type: 'search',
        value: props.query,
        placeholder: t('servers.search'),
        'aria-label': t('servers.search'),
        'data-at-terminal-search': 'servers',
        onChange: (event: { target?: { value?: unknown } }) => props.onQuery(text(event?.target?.value))
      }),
      h('div', { className: 'att-spacer' }),
      props.copied !== null ? h('span', { className: 'att-copied' }, props.copied) : null,
      toolbarButton(t, 'new-server', 'toolbar.new', props.onNew, props.busy, true),
      // Four icon buttons instead of four words: at 380px the four labels alone wrapped the
      // toolbar onto a second row. Each keeps `data-at-terminal-action`, so the tests that drive
      // them by name are untouched by the change of surface.
      iconButton('import', t('toolbar.import'), importRegular({ size: 16 }), props.onImport, props.busy),
      iconButton('export', t('toolbar.export'), exportRegular({ size: 16 }), props.onExport, props.busy),
      iconButton('refresh', t('toolbar.refresh'), refreshRegular({ size: 16 }), props.onRefresh, props.busy),
      props.onOpenMonitor === undefined
        ? null
        : iconButton(
            'open-monitor',
            t('monitor.title'),
            gaugeRegular({ size: 16 }),
            () => props.onOpenMonitor?.(),
            props.busy
          )
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
    h(
      'div',
      {
        className: 'att-content',
        ref: props.scrollRef,
        onScroll: (event: { currentTarget?: { scrollTop?: unknown } }) =>
          props.onScrollTop?.(Number(event?.currentTarget?.scrollTop ?? 0))
      },
      renderNotices(t, props),
      state.kind === 'pending'
        ? renderPending(t, 'servers.pending')
        : state.kind === 'failed'
          ? h('div', { key: 'failed' }, renderFailure(t, state))
          : visible.length === 0
            ? renderEmpty(t, props, filtering)
            : h(
                'div',
                { role: 'listbox', 'aria-label': t('servers.title') },
                renderRows(t, props, visible)
              )
    ),
    renderStatusbar(t, props.summaryState)
  );
}