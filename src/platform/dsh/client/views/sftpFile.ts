/**
 * One remote file, opened: read-only in 查看, editable in 编辑.
 *
 * ## Why this is a page of its own rather than a dialog
 *
 * The panel is a **sidebar**, and a dialog inside a sidebar would be a box in a box: the
 * column is a few hundred pixels wide, and the thing being edited is a file, which is
 * exactly the content a narrow column is worst at. So the pane takes the page over, the same
 * way the server form takes the 资产 page over (see `assets.ts`'s `hidden: formOpen`) — one
 * surface is visible, the other stays mounted and hidden, and the transition is the same
 * gesture the user already performs there.
 *
 * ## Why the editor is a `<textarea>` and not a code editor
 *
 * This bundle is a single `ModuleLoader` factory with `react` as its only external
 * (`dsh/esbuild.dsh.mjs`), so bundling Monaco or CodeMirror means shipping an editor larger
 * than the rest of the plugin to edit a config file. What a `<textarea>` costs is syntax
 * colouring; what it buys is a control that is accessible, undoable and mobile-correct for
 * free. The three things it does *not* give for free are handled here rather than glossed
 * over:
 *
 * - **CRLF.** `<textarea>` normalises every line ending to `\n` by specification, so the
 *   Host normalises on read and carries the convention as `eol`, and the save hands it back.
 *   Without that, opening and saving a Windows-authored file would rewrite every line.
 * - **Tab.** A `Tab` press moves focus, which strands a keyboard user outside the buffer
 *   mid-line. It inserts a tab character instead, and the caret keeps its place.
 * - **No line numbers.** Deliberate: a gutter is the part of a code editor that a
 *   `<textarea>` genuinely cannot fake, and a fake one (a column that scrolls out of step)
 *   is worse than none. The status line carries what *is* knowable — size, line count,
 *   line ending, and whether the buffer differs from the file.
 *
 * Pure render function, like every other view here: the pane's state and every handler come
 * from the body, and nothing in this file reads the DOM except the two helpers below, which
 * exist because `selectionStart` is a DOM property and a controlled component cannot reach it.
 */

import {
  sftpFileSize,
  text,
  type SftpFilePaneState,
  type SftpFileTextView,
  type Translate
} from '../models';
import {
  h,
  navPanelId,
  navTabId,
  pathLabel,
  renderFailure,
  renderNav,
  type El,
  type PanelMode
} from './shared';

export interface SftpFileViewProps {
  t: Translate;
  visible: boolean;
  mode: PanelMode;
  onMode(mode: PanelMode): void;
  pane: SftpFilePaneState;
  /** The editor's buffer changed. */
  onDraft(value: string): void;
  /** Switch the same file into the editor, without re-reading it. */
  onEdit(): void;
  /** Drop the buffer and go back to reading the file as the server has it. */
  onRevert(): void;
  /** Save the buffer; `overwrite` is the user's answer to a conflict. */
  onSave(overwrite: boolean): void;
  /** Re-read the file from the server, dropping the local buffer. */
  onReload(): void;
  /** Leave the pane and go back to the tree. */
  onClose(): void;
  /** Save this file to the local machine as it is on the server. */
  onDownload(): void;
}

/** 120 columns' worth of `\n`s. Counted rather than inferred from a wrapped layout. */
export function lineCount(value: string): number {
  if (value === '') return 1;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/**
 * The spinner fragment, as a live region announces it exactly once.
 *
 * Duplicated from `sftp.ts`'s copy rather than lifted into `shared.ts`: the two pages are
 * independently owned, and a page reaching into a sibling page for a presentational
 * fragment couples them for six lines of markup. (The same reasoning, and the same wording,
 * as the copy in `sftp.ts`.)
 */
function renderPending(t: Translate, labelKey: string): El {
  const label = t(labelKey);
  return h(
    'div',
    { className: 'att-line att-pending', role: 'status', 'aria-live': 'polite' },
    h('span', { className: 'att-spinner', role: 'img', 'aria-label': label }),
    h('span', { 'aria-hidden': 'true' }, label)
  );
}

/**
 * The `Tab` key inside the editor inserts a tabstop.
 *
 * A controlled `<textarea>` cannot insert at the caret from a value change alone, so this
 * reads `selectionStart`/`selectionEnd` — the one piece of state React does not own — and
 * reports back the reassembled buffer plus the caret position it should land on. The caret
 * is restored on the **next animation frame**, because React has not committed the new
 * value yet when this handler returns and setting `selectionStart` early would be undone by
 * the commit.
 *
 * `Shift+Tab` and `Escape` are left alone: the first must keep moving focus backwards (a
 * keyboard user needs a way out), and the second closes nothing here because the pane's own
 * 返回 button is the explicit exit.
 */
function onEditorKeyDown(
  event: {
    key: string;
    shiftKey?: boolean;
    currentTarget: HTMLTextAreaElement;
    preventDefault(): void;
  },
  props: SftpFileViewProps
): void {
  if (event.key !== 'Tab' || event.shiftKey === true) return;
  event.preventDefault();
  const target = event.currentTarget;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  const value = target.value;
  const next = `${value.slice(0, start)}\t${value.slice(end)}`;
  props.onDraft(next);
  const caret = start + 1;
  const restore = (): void => {
    target.setSelectionRange(caret, caret);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  else restore();
}

/** The status line: what is knowable about this buffer, and nothing invented. */
function renderFileStatus(t: Translate, file: SftpFileTextView, draft: string, dirty: boolean): El {
  const count = lineCount(draft);
  const nodes: El[] = [
    h(
      'span',
      { key: 'size', 'data-at-terminal-sftp-file-size': String(file.size) },
      t('sftp.fileSize', { size: sftpFileSize(file) })
    ),
    h(
      'span',
      {
        key: 'lines',
        'data-at-terminal-sftp-file-lines': String(count)
      },
      t('sftp.fileLines', { count })
    ),
    // `eol` is shown because it is a fact the editor is *preserving* on the user's behalf.
    // A convention that is silently maintained is indistinguishable from one that is
    // silently changed, and this panel claims the former.
    h(
      'span',
      { key: 'eol', 'data-at-terminal-sftp-file-eol': file.eol },
      file.eol === 'crlf' ? t('sftp.fileEolCrlf') : t('sftp.fileEolLf')
    ),
    dirty
      ? h('span', { key: 'dirty', className: 'att-chip', 'data-at-terminal-sftp-file': 'dirty' }, t('sftp.fileDirty'))
      : h('span', { key: 'clean', className: 'att-chip', 'data-at-terminal-sftp-file': 'clean' }, t('sftp.fileClean'))
  ];
  return h('div', { className: 'att-statusbar' }, nodes);
}

/** The truncated / conflict banners, split out so the main render stays readable. */
function renderNotices(t: Translate, props: SftpFileViewProps, file: SftpFileTextView): El[] {
  const nodes: El[] = [];

  if (file.truncated) {
    // Said in both modes, because the two consequences differ: in 查看 the tail is simply
    // missing, and in 编辑 saving would **destroy** it. The pane never pretends the buffer
    // is the whole file.
    nodes.push(
      h(
        'div',
        { key: 'truncated', className: 'att-banner info', role: 'status', 'data-at-terminal-sftp-file': 'truncated' },
        t('sftp.fileTruncated', { size: sftpFileSize(file) })
      )
    );
  }

  const save = props.pane.kind === 'ready' ? props.pane.save : { kind: 'idle' as const };

  if (save.kind === 'conflict') {
    // A question, not an error: the file changed under the user, and only they can say
    // whether their version is the one worth keeping. `renderFailure` is deliberately not
    // used — its heading is 「操作失败」, and nothing has failed yet.
    nodes.push(
      h(
        'div',
        { key: 'conflict', className: 'att-banner info', role: 'alert', 'data-at-terminal-sftp-file': 'conflict' },
        t('sftp.fileConflict'),
        h('div', { className: 'att-banner-actions' },
          h(
            'button',
            {
              key: 'overwrite',
              type: 'button',
              className: 'att-btn primary',
              onClick: () => props.onSave(true),
              'data-at-terminal-action': 'sftp-file-overwrite'
            },
            t('sftp.fileOverwrite')
          ),
          h(
            'button',
            {
              key: 'reload',
              type: 'button',
              className: 'att-btn',
              onClick: props.onReload,
              'data-at-terminal-action': 'sftp-file-reload'
            },
            t('sftp.fileReload')
          )
        )
      )
    );
  }

  if (save.kind === 'failed') {
    nodes.push(h('div', { key: 'save-failed' }, renderFailure(t, save)));
  }

  return nodes;
}

function renderToolbar(t: Translate, props: SftpFileViewProps): El {
  const pane = props.pane;
  const editing = pane.mode === 'edit';
  const ready = pane.kind === 'ready';
  // Saving is blocked while a save is already in flight, and in edit mode when the buffer is
  // not the whole file — the same condition `renderBody` refuses to draw an editor under, so
  // the disabled button and the missing textarea can never disagree.
  const canSave = ready && pane.save.kind !== 'pending' && !pane.file.truncated;
  return h(
    'div',
    { className: 'att-toolbar' },
    renderNav(t, props.mode, props.onMode, 'sftp'),
    h('div', { className: 'att-spacer' }),
    // The file being looked at, as a path. Named here rather than only in a title attribute:
    // a `<textarea>` in a narrow column pushes everything else out of sight, and "which file
    // am I about to overwrite" is not a question a tooltip should have to answer.
    pathLabel(pane.path),
    editing
      ? h(
          'button',
          {
            key: 'save',
            type: 'button',
            className: 'att-btn primary',
            disabled: !canSave,
            /*
             * A disabled primary button owes the user a reason.
             *
             * The only explanation used to be `fileEditBlocked`, attached to the 编辑 button — so
             * in the state where 保存 is greyed out because the pane is **pending** (a reload, or
             * the read that failed), the control said nothing at all. It rendered as dead and,
             * because the handler behind it returns early on a non-ready pane, clicking it did
             * nothing visible either. Name the actual cause here, per state.
             */
            title: canSave
              ? ''
              : pane.kind !== 'ready'
                ? t('sftp.fileNotReady')
                : pane.save.kind === 'pending'
                  ? t('sftp.fileSaving')
                  : t('sftp.fileEditBlocked'),
            onClick: () => props.onSave(false),
            'data-at-terminal-action': 'sftp-file-save'
          },
          pane.kind === 'ready' && pane.save.kind === 'pending' ? t('sftp.fileSaving') : t('sftp.fileSave')
        )
      : h(
          'button',
          {
            key: 'edit',
            type: 'button',
            className: 'att-btn',
            disabled: !ready,
            // The reason 编辑 is refused, on the control that refuses it: a truncated file
            // cannot be edited without deleting every line past the cap (see `renderBody`).
            title: ready && pane.file.truncated ? t('sftp.fileEditBlocked') : '',
            onClick: props.onEdit,
            'data-at-terminal-action': 'sftp-file-edit'
          },
          t('sftp.fileEdit')
        ),
    editing
      ? h(
          'button',
          {
            key: 'revert',
            type: 'button',
            className: 'att-btn',
            disabled: !ready,
            onClick: props.onRevert,
            'data-at-terminal-action': 'sftp-file-revert'
          },
          t('sftp.fileRevert')
        )
      : null,
    h(
      'button',
      {
        key: 'download',
        type: 'button',
        className: 'att-btn',
        disabled: ready && pane.save.kind === 'pending',
        onClick: props.onDownload,
        'data-at-terminal-action': 'sftp-file-download'
      },
      t('sftp.download')
    ),
    h(
      'button',
      {
        key: 'close',
        type: 'button',
        className: 'att-btn',
        onClick: props.onClose,
        'data-at-terminal-action': 'sftp-file-close'
      },
      t('sftp.fileBack')
    )
  );
}

function renderBody(t: Translate, props: SftpFileViewProps): El[] {
  const pane = props.pane;

  if (pane.kind === 'pending') return [renderPending(t, 'sftp.filePending')];
  if (pane.kind === 'failed') {
    return [
      h('div', { key: 'failed' }, renderFailure(t, pane)),
      h(
        'div',
        { key: 'failed-actions', className: 'att-banner-actions' },
        h(
          'button',
          { key: 'retry', type: 'button', className: 'att-btn', onClick: props.onReload, 'data-at-terminal-action': 'sftp-file-retry' },
          t('sftp.retry')
        ),
        h(
          'button',
          { key: 'download', type: 'button', className: 'att-btn', onClick: props.onDownload, 'data-at-terminal-action': 'sftp-file-download-fallback' },
          // Offered unconditionally, and it is the useful escape from two of the failures
          // this pane has: a file too large to show, and a binary one. Both are files the
          // user still wants.
          t('sftp.download')
        )
      )
    ];
  }

  const editing = pane.mode === 'edit' && !pane.file.truncated;
  const nodes: El[] = renderNotices(t, props, pane.file);

  if (pane.mode === 'edit' && pane.file.truncated) {
    // The refusal, said where the 编辑 control already is. Returning is the only action a
    // truncated buffer can honestly offer: saving it would delete every line past the cap.
    nodes.push(
      h('div', { key: 'edit-blocked', className: 'att-hint', role: 'status' }, t('sftp.fileEditBlocked'))
    );
    return nodes;
  }

  if (editing) {
    nodes.push(
      h('textarea', {
        key: 'editor',
        className: 'att-file-editor',
        spellCheck: false,
        value: pane.draft,
        // `wrap="off"` — soft wrapping in an editor renumbers the visual lines and makes a
        // single long line look like several, which is how a wrapped JSON blob gets edited
        // into invalid JSON. A horizontal scrollbar is the honest alternative, and the
        // viewer below wraps instead because reading prose and editing code want opposite
        // things from the same width.
        wrap: 'off',
        'aria-label': t('sftp.fileEditorLabel', { path: pane.path }),
        onChange: (event: { target?: { value?: unknown } }) => props.onDraft(text(event?.target?.value)),
        onKeyDown: (event: {
          key: string;
          shiftKey?: boolean;
          currentTarget: HTMLTextAreaElement;
          preventDefault(): void;
        }) => onEditorKeyDown(event, props),
        'data-at-terminal-sftp-editor': 'true'
      })
    );
  } else {
    nodes.push(
      h(
        'pre',
        {
          key: 'viewer',
          className: 'att-file-text',
          // Read-only by construction: a `<pre>` has no editing affordance at all, so nothing
          // here has to remember to lock one.
          tabIndex: 0,
          'aria-label': t('sftp.fileViewerLabel', { path: pane.path }),
          'data-at-terminal-sftp-viewer': 'true'
        },
        pane.draft
      )
    );
  }

  if (pane.save.kind === 'saved') {
    nodes.push(
      h(
        'div',
        { key: 'saved', className: 'att-line', role: 'status', 'data-at-terminal-sftp-file': 'saved' },
        t('sftp.fileSaved', { size: sftpFileSize({ size: pane.save.size }) })
      )
    );
  }

  nodes.push(renderFileStatus(t, pane.file, pane.draft, pane.dirty));
  return nodes;
}

export function renderSftpFileView(props: SftpFileViewProps): El {
  const { t } = props;
  return h(
    'div',
    {
      className: 'att-page att-sftp-page att-sftp-file-page',
      key: 'sftp-file',
      hidden: !props.visible,
      // A `region`, not a `tabpanel`: this pane is a sub-view of the 文件 page rather than a
      // third destination in the nav, and `aria-labelledby` points at the 文件 tab that
      // revealed it. (`shared.ts` derives the tabpanel ids from a `PanelMode`, and claiming
      // one of those here would collide with the tree page's own panel while both are
      // mounted — see the `hidden`-not-unmounted note at the top of this file.)
      role: 'region',
      'aria-labelledby': navTabId('sftp', 'sftp'),
      'data-at-terminal-sftp-file-pane': navPanelId('sftp')
    },
    renderToolbar(t, props),
    h('div', { className: 'att-content att-file-content' }, renderBody(t, props))
  );
}
