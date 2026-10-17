/**
 * The file page: a **read-only** tree of the followed SSH terminal's remote filesystem.
 *
 * Read-only is the whole of DSH-23, and it shows in what is deliberately absent: no
 * rename, no delete, no upload, no drag and drop. Those exist in the VS Code variant and
 * they will arrive here when the Host half grows the RPCs for them; a control that cannot
 * work is worse than no control, which is the same reason the server form ships without
 * its "Test Connection" button.
 *
 * The page renders exactly the rows `flattenSftpTree` returns — all the recursion and all
 * four state cases live there, where they are unit-tested without a DOM.
 *
 * The tree's accessibility surface is split the same way: which attributes a row
 * carries and what each key means are pure functions in `models.ts`, so the parts that
 * can be wrong without ever being seen (a leaf claiming `aria-expanded`, `→` landing
 * on a `pending` placeholder) are asserted without a DOM. What is left here is the part
 * that genuinely needs one: moving the caret.
 *
 * Pure render function: all state and handlers come from the body.
 */

import {
  count,
  sftpDirFailureKey,
  sftpEntrySize,
  sftpListing,
  sftpRowA11y,
  sftpTreeFocusKey,
  sftpTreeKeyAction,
  text,
  type SftpEntryView,
  type SftpRow,
  type SftpTransferProgress,
  type Translate
} from '../models';
import {
  chevronDownRegular,
  chevronRightRegular,
  fileRegular,
  folderRegular,
  symlinkRegular,
  warningTriangleRegular
} from '../icons';
import {
  h,
  navPanelId,
  navTabId,
  pathLabel,
  renderFailure,
  renderNav,
  type AsyncState,
  type El,
  type PanelMode
} from './shared';

export interface SftpViewProps {
  t: Translate;
  visible: boolean;
  mode: PanelMode;
  onMode(mode: PanelMode): void;
  state: AsyncState<unknown>;
  /**
   * A failure from an action rather than the read — `sftp.goUp` against a terminal that
   * dropped between the listing and the click. Kept separate from `state` so it cannot be
   * mistaken for the state of the tree itself.
   */
  failure: { code: string; message: string } | null;
  rows: SftpRow[];
  expanded: readonly string[];
  busy: boolean;
  onToggle(path: string): void;
  onGoUp(): void;
  onRefresh(): void;
  /**
   * The file the toolbar's actions act on, or `null`.
   *
   * Selection is a **file** concept here, not a row one: 查看 / 编辑 / 下载 have nothing to
   * say about a directory, so a directory row never becomes selected and the three controls
   * stay disabled rather than being offered and then refusing.
   */
  selectedPath: string | null;
  onSelect(path: string): void;
  /** Open a file in the pane. `edit` is only ever passed for a file the user can edit. */
  onOpen(path: string, mode: 'view' | 'edit'): void;
  onDownload(path: string): void;
  downloading?: boolean;
  /** Where an upload would land — the directory the tree is rooted at. */
  uploadTarget: string;
  /** Files the user picked, on their way to the server. */
  onUpload(files: File[]): void;
  uploading: boolean;
  /**
   * Progress of an active upload or download, or `null`.
   */
  progress: SftpTransferProgress | null;
  /**
   * The outcome of the last upload, when there was one to report.
   *
   * Deliberately **not** `failure`: `failure` renders as `操作失败` with an error code, and
   * "you skipped one file because it already existed" is neither. A notice is a sentence
   * that appears above the tree and goes away on the next read.
   */
  notice: string | null;
  onRowContextMenu?(
    event: { preventDefault(): void; stopPropagation?(): void; clientX: number; clientY: number },
    row: SftpRow
  ): void;
  onContainerContextMenu?(
    event: { preventDefault(): void; clientX: number; clientY: number }
  ): void;
}

/**
 * The row that owns the tree's single tab stop, remembered across renders.
 *
 * Module scope rather than a prop, and that is a debt: the honest carrier is a `useRef`
 * in the Body component, which re-renders on every read, but `body.ts` belongs to
 * another task. The alternative — recomputing the stop from `document.activeElement` on
 * every render — reads the DOM during render, which is worse: it makes the render
 * output depend on what happened to be mounted, so the same props could produce a
 * different tree.
 *
 * A remembered key is only ever a *preference*: `sftpTreeFocusKey` drops it when the row
 * it names is gone, so a stale value can leave the tree unfocusable but never wrong
 * about what is in it.
 */
let focusedRowKey: string | null = null;

/**
 * Move the caret to `key` and leave the roving tab stop sitting under it.
 *
 * Both halves are needed and neither is enough. Calling `focus()` alone leaves the
 * `tabindex` attributes stale, because a pure caret move re-renders nothing — so Tab
 * would jump back to whichever row still claimed `tabIndex=0`. Writing the attributes
 * alone leaves the caret in the old row, which is the failure the plan calls out: a
 * focusable tree the keyboard cannot walk.
 *
 * The lookup walks the rows and compares the attribute rather than interpolating the
 * key into a selector: row keys are remote paths, and a filename containing a quote
 * would end the selector early and silently target the wrong row.
 */
export function moveTreeFocus(from: Element | null, key: string): void {
  const tree = from?.closest('[role="tree"]') ?? null;
  if (tree === null) return;
  // Locate the currently active row directly
  const previous = tree.querySelector<HTMLElement>('[tabindex="0"]');
  if (previous !== null) {
    previous.setAttribute('tabindex', '-1');
    previous.removeAttribute('data-at-terminal-sftp-focus');
  }
  // Target row lookup by attribute selector with quoted escape, falling back defensively if selector syntax fails
  let target: HTMLElement | null = null;
  try {
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
    target = tree.querySelector<HTMLElement>(`[data-at-terminal-sftp-row="${escaped}"]`);
  } catch {
    for (const el of tree.querySelectorAll<HTMLElement>('[data-at-terminal-sftp-row]')) {
      if (el.getAttribute('data-at-terminal-sftp-row') === key) {
        target = el;
        break;
      }
    }
  }
  if (target !== null) {
    target.setAttribute('tabindex', '0');
    target.setAttribute('data-at-terminal-sftp-focus', 'true');
    target.focus();
  }
}

/**
 * The pending line: a spinner plus the read's own words.
 *
 * The visible text is `aria-hidden` and the ring carries `role="img"` with the *same*
 * string, so a live region announces the state exactly once. Labelling both would make
 * it read the sentence twice, which is how a screen-reader user ends up switching live
 * regions off. The name is the visible one either way, which is the point: a loading
 * state nobody can hear is not a loading state.
 *
 * Duplicated from `assets.ts` rather than lifted into `shared.ts`: that file belongs to
 * another task, and a page importing a presentational helper from a sibling page is a
 * worse home for it than a few repeated lines.
 *
 * The fragment is shared by both places this page shows a read in flight — the status
 * line above the tree and the `treeitem` placeholder inside it — so the two cannot drift
 * apart visually. Each caller keeps its own wrapper: the placeholder's
 * `sftpRowA11y` attributes are not something a fragment may decide.
 */
function renderPendingFragment(t: Translate, labelKey: string): El[] {
  const label = t(labelKey);
  return [
    h('span', { key: 'spinner', className: 'att-spinner', role: 'img', 'aria-label': label }),
    h('span', { key: 'label', 'aria-hidden': 'true' }, label)
  ];
}

/**
 * The keyboard contract for one row, as a plain function of the key.
 *
 * The mapping itself is `sftpTreeKeyAction`'s (in `models.ts`, unit-tested); what is
 * left here is the part that needs a live document — turning the action into an RPC and
 * a caret. `Tab` and `Escape` are deliberately untouched: the tree is one stop in a
 * panel that has its own shortcuts, and swallowing either would strand the user.
 */
function onRowKeyDown(
  event: { key: string; currentTarget: Element | null; preventDefault(): void },
  row: SftpRow,
  props: SftpViewProps
): void {
  if (event.key === 'Tab' || event.key === 'Escape') return;
  const action = sftpTreeKeyAction(props.rows, row.key, event.key);
  if (action.kind === 'none') return;
  // Space would scroll the panel and the arrows would scroll the listing, both of which
  // read as the tree having ignored the key.
  event.preventDefault();

  if (action.kind === 'go-up') {
    props.onGoUp();
    return;
  }
  if (action.kind === 'toggle') {
    // The row keeps the caret: a directory that expands under the user should still be
    // the row they are on, which is what makes `→` useful straight after `Enter`.
    focusedRowKey = row.key;
    props.onToggle(action.path);
    return;
  }
  if (action.kind === 'open') {
    // Selection first, then the pane: 查看 is a mode change, and coming back from it should
    // land on the file the user was looking at rather than on a bare tree. The row also
    // keeps the caret, for the same reason `toggle` does.
    focusedRowKey = row.key;
    props.onSelect(action.path);
    props.onOpen(action.path, 'view');
    return;
  }
  focusedRowKey = action.key;
  moveTreeFocus(event.currentTarget, action.key);
}

/**
 * The disclosure marker.
 *
 * A `button` rather than a click-on-row affordance so the row itself stays a file
 * selector, and so the thing that mutates state is reachable by keyboard.
 *
 * `aria-hidden` on the triangle spans: the state is already on the row as
 * `aria-expanded`, and a screen reader that meets "collapsed" twice — once from the
 * row, once from the button inside it — says it twice.
 */
function renderDisclosure(t: Translate, row: SftpRow, onToggle: (path: string) => void): El | null {
  if (row.entry === undefined || !row.expandable) return null;
  const path = row.entry.path;
  return h(
    'button',
    {
      key: `${path}#disclosure`,
      type: 'button',
      className: 'att-tree-disclosure',
      'aria-expanded': row.expanded,
      'data-at-terminal-action': 'sftp-toggle',
      'data-at-terminal-path': path,
      title: row.expanded ? t('sftp.collapse') : t('sftp.expand'),
      onClick: () => onToggle(path)
    },
    h(
      'span',
      { 'aria-hidden': 'true' },
      row.expanded ? chevronDownRegular({ size: 12 }) : chevronRightRegular({ size: 12 })
    )
  );
}

/**
 * The failure accent, inline because the sheet belongs to another task.
 *
 * A failed level has to be visible without being the page's alarm: `att-banner` is
 * deliberately not used here, so the accent is what carries "something went wrong" once
 * the banner's border and heading are gone. A theme token rather than a literal colour,
 * which is also what keeps the sheet's rule intact — the panel reads `--vscode-*` only.
 */
const FAILURE_COLOR = { color: 'var(--vscode-errorForeground)' } as const;

/**
 * The directory a `failed` row belongs to, recovered from its own key.
 *
 * `flattenSftpTree` names that row `` `${entry.path}#failed` `` and gives it no `entry`, so
 * the key is the only thing on the row that names what failed. Stripping the suffix from
 * the end is exact even for a path that itself ends in `#failed`: only the last occurrence
 * is removed, and that is the one the row builder appended.
 */
function failedRowPath(row: SftpRow): string {
  const suffix = '#failed';
  return row.key.endsWith(suffix) ? row.key.slice(0, -suffix.length) : row.key;
}

/**
 * The row's leading mark: a folder, a file, or a link.
 *
 * It used to return three characters — `↪`, `▣`, `·` — which is worth spelling out because each
 * one failed differently: `▣` is a *box* (it says "checkbox" before it says "folder"), `·` is a
 * middle dot that at 12px reads as dust rather than as a file, and `↪` is a return arrow rather
 * than a link. All three also came from the ambient font, so their weight and bearing changed with
 * the platform while the icons beside them did not.
 *
 * Returns an element rather than a string, which is why the caller no longer renders it as text.
 */
function rowGlyph(row: SftpRow): El | null {
  const entry = row.entry;
  if (entry === undefined) return null;
  if (entry.type === 'symlink') return symlinkRegular({ size: 14 });
  if (entry.type === 'directory') return folderRegular({ size: 14 });
  return fileRegular({ size: 14 });
}

/**
 * One tree row.
 *
 * `focusedKey` is threaded in rather than read from a module global here, so the
 * attributes a row renders are a function of its inputs — the caret position is state,
 * but which row is the tab stop for a given rows-and-caret pair is arithmetic, and
 * `sftpRowA11y` is where that arithmetic is tested.
 */
function renderRow(t: Translate, row: SftpRow, props: SftpViewProps, focusedKey: string | null): El {
  const pad = { paddingLeft: `${8 + row.depth * 14}px` };
  const key = `row:${row.key}`;
  const focused = row.key === focusedKey;

  if (row.kind === 'parent') {
    return h(
      'div',
      {
        key,
        className: 'att-tree-row att-tree-parent',
        ...sftpRowA11y(row, focused),
        style: pad,
        'data-at-terminal-action': 'sftp-up',
        title: t('sftp.goUp'),
        onClick: () => props.onGoUp(),
        onContextMenu: (event: { preventDefault(): void; stopPropagation?(): void; clientX: number; clientY: number }) => {
          event.preventDefault();
          event.stopPropagation?.();
          props.onRowContextMenu?.(event, row);
        },
        onKeyDown: (event: { key: string; currentTarget: Element | null; preventDefault(): void }) =>
          onRowKeyDown(event, row, props)
      },
      h('span', { className: 'att-tree-glyph', 'aria-hidden': 'true' }, '↑'),
      h('span', { className: 'att-tree-name' }, '..'),
      h('span', { className: 'att-tree-meta' }, t('sftp.parent'))
    );
  }

  // A placeholder is a treeitem the user cannot land on: `sftpRowA11y` gives it the role
  // and level a screen reader needs to meet it — a `role="tree"` may only own treeitems —
  // while `sftpRowFocusable` keeps it out of the tab ring, so `Enter` on it is never a
  // dead key. `aria-live` is a global attribute, so it rides on the treeitem rather than
  // replacing the role: a read that finishes under the user is announced whether or not
  // the caret is anywhere near this row.
  if (row.kind === 'pending') {
    return h(
      'div',
      {
        key,
        className: 'att-line att-pending',
        ...sftpRowA11y(row, false),
        style: pad,
        'aria-live': 'polite',
        'data-at-terminal-sftp': 'pending'
      },
      ...renderPendingFragment(t, 'sftp.dirPending')
    );
  }

  if (row.kind === 'failed') {
    const code = text(row.code);
    // A local line, not `renderFailure`. That helper is the *page's* failure shape: a
    // titled banner that ends in `error.detail`, i.e. the Host's own message spelled at the
    // user. Here the Host's message is the problem — `No such file or directory: /root/x`
    // names a path the user did not ask about and offers nothing to do — so the row carries
    // one localized sentence and nothing else. The raw code still rides along as
    // `data-at-terminal-sftp-code` and as the row's `title`, which is where a bug report
    // gets it from.
    //
    // `sftpRowA11y` is spread unchanged, so this stays the `treeitem` the tree already
    // promised, at the level of the directory whose read failed. The retry is a real
    // `<button>` inside it, which is what makes it reachable: the row itself is not a tab
    // stop (`sftpRowFocusable` excludes a read's state on purpose), so without a control
    // in it a keyboard user would have no way to ask again.
    return h(
      'div',
      {
        key,
        className: 'att-tree-row',
        ...sftpRowA11y(row, false),
        style: pad,
        'aria-live': 'assertive',
        title: code,
        'data-at-terminal-sftp': 'failed',
        'data-at-terminal-sftp-code': code
      },
      h(
        'span',
        { className: 'att-tree-glyph', style: FAILURE_COLOR, 'aria-hidden': 'true' },
        warningTriangleRegular({ size: 14 })
      ),
      h('span', { className: 'att-tree-name', style: FAILURE_COLOR }, t(sftpDirFailureKey(code))),
      // A real `<button>`, which is what makes the retry reachable: the row itself is not a
      // tab stop (`sftpRowFocusable` excludes a read's state on purpose), so a control inside
      // it is the only way a keyboard user can ask again.
      //
      // It re-reads the whole tree rather than this one level, and that is a limit of the
      // props this page is given, not a choice: `onToggle` would *collapse* the directory
      // (it is already expanded), and the page has no per-path re-read. The alternative —
      // no control at all — is worse, because a failed child is cached in the body and so
      // survives collapse-and-reopen; the toolbar refresh would be the only escape.
      h(
        'button',
        {
          key: `${row.key}#retry`,
          type: 'button',
          className: 'att-btn',
          // The label next to it is the long one and it ellipsizes; the retry must not be
          // what gets crushed when the panel is narrow, so it opts out of shrinking.
          style: { flex: '0 0 auto', marginLeft: 'auto' },
          onClick: props.onRefresh,
          'data-at-terminal-action': 'sftp-retry-dir',
          'data-at-terminal-path': failedRowPath(row)
        },
        t('sftp.retry')
      )
    );
  }

  const entry = row.entry as SftpEntryView;
  // Only a **file** row is selectable: `查看`/`编辑`/`下载` have no meaning for a directory,
  // and marking one `aria-selected` would announce a selection the toolbar then refuses to
  // act on. A symlink is a file row here whatever it points at — `sftpExpandable` is what
  // decides expandability, and a link to a directory is already excluded by `row.expandable`.
  const selectable = !row.expandable;
  const selected = selectable && props.selectedPath === entry.path;
  const selection: Record<string, unknown> = selectable
    ? { 'aria-selected': selected, 'data-at-terminal-sftp-selected': selected ? 'true' : 'false' }
    : {};
  return h(
    'div',
    {
      key,
      className: selected ? 'att-tree-row selected' : 'att-tree-row',
      ...sftpRowA11y(row, focused),
      ...selection,
      style: pad,
      'data-at-terminal-sftp': 'entry',
      'data-at-terminal-entry': entry.type,
      title: entry.path,
      onClick: selectable ? () => props.onSelect(entry.path) : undefined,
      // Double-click is the gesture the 资产 list already taught this panel for "open the
      // thing this row names", so it opens the viewer rather than inventing a second one.
      onDoubleClick: selectable ? () => props.onOpen(entry.path, 'view') : undefined,
      onContextMenu: (event: { preventDefault(): void; stopPropagation?(): void; clientX: number; clientY: number }) => {
        event.preventDefault();
        event.stopPropagation?.();
        props.onRowContextMenu?.(event, row);
      },
      onKeyDown: (event: { key: string; currentTarget: Element | null; preventDefault(): void }) =>
        onRowKeyDown(event, row, props)
    },
    renderDisclosure(t, row, props.onToggle),
    h(
      'span',
      { className: 'att-tree-glyph', 'aria-hidden': 'true' },
      rowGlyph(row)
    ),
    h('span', { className: 'att-tree-name' }, entry.name),
    h('span', { className: 'att-tree-meta', 'aria-hidden': 'true' }, sftpEntrySize(entry))
  );
}

function renderTransferProgress(t: Translate, progress: SftpTransferProgress): El {
  const isUpload = progress.kind === 'upload';
  const title = isUpload
    ? t('sftp.uploadProgress', { name: progress.name })
    : t('sftp.downloadProgress', { name: progress.name });
  const meta = progress.detail
    ? `${progress.detail} (${progress.percent}%)`
    : `${progress.percent}%`;

  return h(
    'div',
    {
      key: 'transfer-progress',
      className: 'att-progress-card',
      role: 'progressbar',
      'aria-valuenow': progress.percent,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-label': `${title} ${meta}`,
      'data-at-terminal-sftp-progress': progress.kind
    },
    h(
      'div',
      { className: 'att-progress-header' },
      h('span', { className: 'att-progress-title' }, title),
      h('span', { className: 'att-progress-meta' }, meta)
    ),
    h(
      'div',
      { className: 'att-progress-track' },
      h('div', {
        className: 'att-progress-fill',
        style: { width: `${Math.max(0, Math.min(100, progress.percent))}%` }
      })
    )
  );
}

/**
 * Everything the page says that is not a row: the read's state, and the banners.
 *
 * Split out of `renderTree` because a `role="tree"` may only own treeitems. Rendering
 * a `disconnected` banner or a "this directory is empty" hint *inside* the tree made a
 * screen reader announce them as rows of the listing — the empty state in particular
 * read as "a directory with one nameless entry in it", which is the opposite of what it
 * means. They stay above the tree, in the same scroll area, so the layout a user sees
 * is unchanged.
 */
function renderStatus(t: Translate, props: SftpViewProps): El[] {
  const nodes: El[] = [];
  const state = props.state;

  if (props.progress !== null) {
    nodes.push(renderTransferProgress(t, props.progress));
  }

  // Above everything, including the read's own state: an upload's outcome is about the
  // action the user just took, and burying it under a fresh `pending` spinner would hide it
  // for exactly as long as the re-read takes.
  if (props.notice !== null) {
    nodes.push(
      h(
        'div',
        { key: 'notice', className: 'att-banner info', role: 'status', 'data-at-terminal-sftp': 'notice' },
        props.notice
      )
    );
  }

  if (state.kind === 'pending') {
    nodes.push(
      h(
        'div',
        { key: 'pending', className: 'att-line att-pending', role: 'status', 'aria-live': 'polite' },
        ...renderPendingFragment(t, 'sftp.pending')
      )
    );
    return nodes;
  }
  if (state.kind === 'failed') {
    // A failed read renders as a failure **with its code** — never as an empty tree. The
    // Host's `sftp-disconnected` and `no-active-terminal` mean different things, and a
    // silently empty listing would hide both.
    nodes.push(h('div', { key: 'failed', role: 'status' }, renderFailure(t, state)));
    return nodes;
  }

  const listing = sftpListing(state.result);

  if (listing.kind === 'none') {
    // The honest empty state: no SSH terminal is connected, so there is nothing to list.
    // It says which of the two reasons it is rather than showing an empty directory.
    //
    // It is also the one state here that can act on its own cause. 'sftp.noTerminal'
    // names the fix in its own sentence -- connect a server on the Terminal page --
    // and an empty state that names a fix the user cannot reach is an explanation
    // with no exit. 'onMode' is this page's own nav callback and it is already in
    // the props (the toolbar's segmented nav calls it), so the button is the same
    // navigation the nav performs, not a new capability added to the page.
    //
    // The label is the destination page's own nav label rather than a new string:
    // 'mode.terminal' is what the tab the user has to find says on it, so the
    // button and the tab it sends them to are worded identically. Inventing a
    // separate 'go to terminal' string would be a second name for one destination,
    // and this plugin does not add locale keys it does not need.
    nodes.push(
      h(
        'div',
        { key: 'none', className: 'att-hint', role: 'status', 'data-at-terminal-sftp': 'none' },
        t('sftp.noTerminal'),
        h(
          'div',
          { className: 'att-banner-actions' },
          h(
            'button',
            {
              key: 'goto-terminal',
              type: 'button',
              className: 'att-btn',
              onClick: () => props.onMode('terminal'),
              'data-at-terminal-action': 'sftp-goto-terminal'
            },
            t('mode.terminal')
          )
        )
      )
    );
    return nodes;
  }

  if (listing.kind === 'disconnected') {
    // Explicit, and above the entries: this listing is the **last** one, and the server
    // cannot be asked again until a terminal is reconnected.
    //
    // The way out is 'terminal.reconnect', the same label the terminal page's own
    // reconnect button uses, because it is the same action from the user's side. What
    // it actually does here is re-read (onRefresh): the plugin has no RPC that
    // reconnects a session from this page -- that lives on the terminal page, which
    // owns the connection -- so the honest thing is to re-ask the server and let the
    // answer either come back or not. Showing the screen is the point; the host's
    // internal error is not repeated underneath it, which is what the official
    // 'sidebar-terminal' rule asks for.
    //
    // Disabled while busy for the same reason the toolbar's refresh button is: a
    // second read while one is in flight is two reads of the same directory, and the
    // user gets no way to tell which answer they are looking at.
    nodes.push(
      h(
        'div',
        { key: 'disconnected', className: 'att-banner info', role: 'status', 'data-at-terminal-sftp': 'disconnected' },
        t('sftp.disconnected'),
        h(
          'div',
          { className: 'att-banner-actions' },
          h(
            'button',
            {
              key: 'reconnect',
              type: 'button',
              className: 'att-btn',
              disabled: props.busy,
              onClick: props.onRefresh,
              'data-at-terminal-action': 'sftp-reconnect'
            },
            t('terminal.reconnect')
          )
        )
      )
    );
  }

  if (props.rows.length === 0) {
    nodes.push(
      h('div', { key: 'empty', className: 'att-hint', role: 'status' }, t('sftp.empty'))
    );
  }

  return nodes;
}

function renderTree(t: Translate, props: SftpViewProps, focusedKey: string | null): El[] {
  const nodes: El[] = [];
  for (const row of props.rows) nodes.push(renderRow(t, row, props, focusedKey));
  return nodes;
}

/**
 * The upload control: a `<label>` wrapping a visually-hidden file input.
 *
 * Why a label rather than a button plus a hidden input driven by a DOM query: the frame
 * carries no ref for a pure render function to hold, so a click handler would have to find
 * the input again by selector — and a selector built from a path is exactly the mistake
 * `moveTreeFocus` documents. Letting the browser forward the label's activation to its own
 * control removes the lookup entirely.
 *
 * The input is hidden the way a keyboard user can still reach it (`1px`, transparent,
 * clipped) rather than with `display: none`, which would also remove it from the tab ring —
 * an upload only reachable by mouse is not a control this panel ships.
 *
 * `multiple` because picking a directory's worth of files one dialog at a time is the
 * interaction users complain about, and the Host already accepts one call per file.
 */
function renderUploadControl(t: Translate, props: SftpViewProps): El {
  const disabled = props.busy || props.uploading;
  return h(
    'label',
    {
      key: 'upload',
      className: 'att-btn att-upload',
      // The destination, named on the control: the tree can be rooted anywhere, and "where
      // did my file go" is the one question an upload must not leave open.
      title: t('sftp.uploadTo', { path: props.uploadTarget }),
      'data-at-terminal-action': 'sftp-upload'
    },
    props.uploading ? t('sftp.uploading') : t('sftp.upload'),
    h('input', {
      type: 'file',
      multiple: true,
      className: 'att-file-input',
      disabled,
      'aria-label': t('sftp.uploadTo', { path: props.uploadTarget }),
      onChange: (event: { target?: { files?: ArrayLike<File> | null; value?: string } }) => {
        const files = event?.target?.files;
        const picked: File[] = [];
        for (let index = 0; index < (files?.length ?? 0); index += 1) {
          const file = files?.[index];
          if (file !== undefined) picked.push(file);
        }
        // Cleared so choosing the same file again still fires `change`: the input keeps its
        // value otherwise, and a silent no-op reads as a broken button.
        if (event?.target !== undefined) event.target.value = '';
        if (picked.length > 0) props.onUpload(picked);
      },
      'data-at-terminal-action': 'sftp-upload-input'
    })
  );
}

function renderToolbar(t: Translate, props: SftpViewProps): El {
  const state = props.state;
  const listing = state.kind === 'ok' ? sftpListing(state.result) : undefined;
  const live = listing !== undefined && listing.kind === 'active';
  const canGoUp = live && listing.rootPath !== '' && listing.rootPath !== '/';
  const selected = props.selectedPath;
  // Every file action needs a live connection *and* a named file: listing a stale tree is
  // fine, acting on it is not, and the Host would refuse anyway — this is so the button says
  // why rather than the banner afterwards.
  const fileActionDisabled = props.busy || !live || selected === null;
  return h(
    'div',
    { className: 'att-toolbar' },
    renderNav(t, props.mode, props.onMode, 'sftp'),
    h('div', { className: 'att-spacer' }),
    listing !== undefined && listing.serverLabel !== ''
      ? h('span', { className: 'att-chip', 'data-at-terminal-sftp-server': listing.serverLabel }, listing.serverLabel)
      : null,
    h(
      'button',
      {
        key: 'view',
        type: 'button',
        className: 'att-btn',
        disabled: fileActionDisabled,
        onClick: () => selected !== null && props.onOpen(selected, 'view'),
        'data-at-terminal-action': 'sftp-file-view'
      },
      t('sftp.view')
    ),
    h(
      'button',
      {
        key: 'edit',
        type: 'button',
        className: 'att-btn',
        disabled: fileActionDisabled,
        onClick: () => selected !== null && props.onOpen(selected, 'edit'),
        'data-at-terminal-action': 'sftp-file-edit'
      },
      t('sftp.edit')
    ),
    h(
      'button',
      {
        key: 'download',
        type: 'button',
        className: 'att-btn',
        disabled: fileActionDisabled || props.downloading === true,
        onClick: () => selected !== null && props.onDownload(selected),
        'data-at-terminal-action': 'sftp-download'
      },
      props.downloading === true ? t('sftp.downloading') : t('sftp.download')
    ),
    renderUploadControl(t, props),
    h(
      'button',
      {
        key: 'up',
        type: 'button',
        className: 'att-btn',
        disabled: props.busy || !canGoUp,
        onClick: props.onGoUp,
        'data-at-terminal-action': 'sftp-toolbar-up'
      },
      t('sftp.goUp')
    ),
    h(
      'button',
      {
        key: 'refresh',
        type: 'button',
        className: 'att-btn',
        disabled: props.busy,
        onClick: props.onRefresh,
        'data-at-terminal-action': 'sftp-refresh'
      },
      t('toolbar.refresh')
    )
  );
}

function renderPath(t: Translate, props: SftpViewProps): El {
  const listing = props.state.kind === 'ok' ? sftpListing(props.state.result) : undefined;
  const rootPath = listing === undefined ? '' : listing.rootPath;
  return h(
    'div',
    { className: 'att-statusbar', role: 'status', 'data-at-terminal-sftp-path': text(rootPath) },
    // An unresolved root keeps its own sentence rather than an empty path label:
    // "unknown" and "the empty string" are different answers, and the bar is the
    // only place that knows which one it has.
    rootPath === ''
      ? h('span', { className: 'att-dir', title: '' }, t('sftp.pathUnknown'))
      : pathLabel(rootPath),
    listing !== undefined && listing.kind === 'active'
      ? h('span', { className: 'att-chip' }, t('sftp.entryCount', { count: count(listing.entries.length) }))
      : null
  );
}

export function renderSftpView(props: SftpViewProps): El {
  const { t } = props;
  // Rendering stays free of side effects, so the caret is not reset here. It does not
  // need to be: a hidden page is out of the tab order entirely, and `sftpTreeFocusKey`
  // drops a remembered row that no longer exists — which is what a `..` or a collapse
  // does. Coming back to the same directory therefore *restores* the row the user left,
  // which is what a tree is supposed to do.
  const focusedKey = sftpTreeFocusKey(props.rows, focusedRowKey);
  return h(
    'div',
    {
      className: 'att-page att-sftp-page',
      key: 'sftp',
      hidden: !props.visible,
      // Labelled by the tab in *this* page's nav; the other two navs have tabs of the same
      // name, so a mode-only id here would resolve to whichever one React mounted first.
      role: 'tabpanel',
      id: navPanelId('sftp'),
      'aria-labelledby': navTabId('sftp', 'sftp')
    },
    renderToolbar(t, props),
    h(
      'div',
      {
        className: 'att-content',
        onContextMenu: (event: { preventDefault(): void; clientX: number; clientY: number }) => {
          event.preventDefault();
          props.onContainerContextMenu?.(event);
        }
      },
      renderStatus(t, props),
      props.failure === null
        ? null
        : h('div', { key: 'action-failed' }, renderFailure(t, props.failure)),
      h(
        'div',
        {
          role: 'tree',
          // The listing is the page's whole content, so the page's own title names it;
          // `sftp.title` is already that string in both locales.
          'aria-label': t('sftp.title'),
          // A read in flight is exactly what `aria-busy` is for, and it is the only
          // thing on this page that changes without the user's hands on the keyboard.
          'aria-busy': props.state.kind === 'pending',
          'data-at-terminal-sftp-tree': 'true'
        },
        renderTree(t, props, focusedKey)
      )
    ),
    renderPath(t, props)
  );
}
