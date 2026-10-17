/**
 * The import/export dialogs. The fields are the same ones the committed
 * single-column panel had, moved into a modal so the assets page stays a list:
 * export = two inclusion checkboxes + the package password; import = file +
 * password + conflict strategy. Both render their outcome **inside** the
 * dialog, with the same failure banner (code-specific copy + raw evidence)
 * every other surface uses, and both keep the Host as the authority on the
 * `.at-terminal-assets` envelope — this side never authors one.
 */

import { count, text, type Translate } from '../models';
import { h, renderFailure, type El } from './shared';

export interface ExportState {
  kind: 'idle' | 'pending';
}
export interface ExportDone {
  kind: 'ok';
  filename: string;
  omissions: number;
}
export interface ExportFailed {
  kind: 'failed';
  code: string;
  message: string;
}

export interface ImportSummary {
  imported?: number;
  skipped?: number;
  overwritten?: number;
  renamed?: number;
  privateKeysWritten?: number;
}
export interface ImportState {
  kind: 'idle' | 'pending';
}
export interface ImportDone {
  kind: 'ok';
  summary: ImportSummary;
}
export interface ImportFailed {
  kind: 'failed';
  code: string;
  message: string;
}

export interface ExportDialogProps {
  t: Translate;
  includePasswords: boolean;
  includePrivateKeys: boolean;
  password: string;
  state: ExportState | ExportDone | ExportFailed;
  onIncludePasswords(value: boolean): void;
  onIncludePrivateKeys(value: boolean): void;
  onPassword(value: string): void;
  onSubmit(): void;
  onClose(): void;
}

export interface ImportDialogProps {
  t: Translate;
  fileName: string | null;
  password: string;
  strategy: string;
  state: ImportState | ImportDone | ImportFailed;
  onFile(file: { name?: string } | null, read: () => Promise<string>): void;
  onPassword(value: string): void;
  onStrategy(value: string): void;
  onSubmit(): void;
  onClose(): void;
}

/* ------------------------------- focus management ------------------------------ */

/**
 * Where focus came from, so closing can hand it back. Module-level because only
 * one dialog is ever open, and because the ref callback below has to stay
 * identity-stable across renders.
 */
let focusOrigin: HTMLElement | null = null;

/**
 * Both dialogs are plain functions called from the body render, not components,
 * so there is no boundary to hang `useEffect` on without changing the body half.
 * A **stable** `ref` callback does the same job: React calls it once on mount
 * with the node and once on unmount with `null` — the only two moments focus has
 * to move. It must be module-level, not a fresh closure per render: a changing
 * identity makes React detach/reattach (null, then node) on every keystroke,
 * which would bounce focus back to the first control mid-typing.
 *
 * Why not React's `autoFocus`: it commits during the same pass that inserts the
 * trigger's sibling, before the opening control has been recorded, so there is
 * nothing to hand focus back to on close.
 */
const dialogRef = (node: HTMLElement | null): void => {
  if (node === null) {
    const origin = focusOrigin;
    focusOrigin = null;
    // The dialog held focus while it was open; dropping it on the floor would
    // leave a keyboard user at the top of the document with no way back.
    origin?.focus();
    return;
  }
  // Captured on mount, before focus moves: whatever was focused is the control
  // that opened the dialog. The `contains` guard keeps a re-attach (StrictMode
  // detaches and re-runs ref callbacks) from recording the dialog itself as the
  // origin, which would make close restore focus to a node that is going away.
  if (focusOrigin === null) {
    const active = node.ownerDocument.activeElement;
    if (active instanceof HTMLElement && !node.contains(active)) focusOrigin = active;
  }
  const initial = node.querySelector<HTMLElement>('[data-modal-autofocus]');
  (initial ?? node).focus();
};

/**
 * Everything a Tab can land on inside the dialog. `[tabindex^="-"]` keeps the
 * programmatically focusable (`tabindex="-1"`) out of the ring.
 */
const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex^="-"])'
].join(',');

interface DialogKeyEvent {
  key: string;
  shiftKey?: boolean;
  currentTarget: HTMLElement;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Escape closes; Tab wraps. Both are handled on the container rather than on
 * `document` so the background page's own Escape handling (the context menu)
 * cannot also react to the same key.
 */
function dialogKeydown(event: DialogKeyEvent, onClose: () => void): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(TABBABLE));
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const active = event.currentTarget.ownerDocument.activeElement;
  const backward = event.shiftKey === true;
  const boundary = backward ? items[0] : items[items.length - 1];
  // Focus sitting on the container itself (no `data-modal-autofocus` target)
  // enters the ring from the right end.
  if (active === boundary || active === event.currentTarget) {
    event.preventDefault();
    (backward ? items[items.length - 1] : items[0]).focus();
  }
}

function overlay(key: string, title: string, body: El[], actions: El, onClose: () => void): El {
  return h(
    'div',
    {
      key,
      className: 'att-overlay',
      onClick: (event: { target?: unknown; currentTarget?: unknown }) => {
        // Click on the backdrop (not the dialog) closes.
        if (event.target === event.currentTarget) onClose();
      },
      'data-at-terminal-dialog': key
    },
    h(
      'div',
      {
        className: 'att-dialog',
        role: 'dialog',
        'aria-modal': true,
        'aria-label': title,
        // Focusable so the dialog can hold focus when it has no autofocus
        // target, and so Escape/Tab have an element to listen on.
        tabIndex: -1,
        ref: dialogRef,
        onKeyDown: (event: DialogKeyEvent) => dialogKeydown(event, onClose)
      },
      h('h2', { className: 'att-dialog-title' }, title),
      body,
      actions
    )
  );
}

function checkRow(
  t: Translate,
  key: string,
  labelKey: string,
  checked: boolean,
  disabled: boolean,
  onChange: (value: boolean) => void
): El {
  return h(
    'label',
    { key, className: 'att-check' },
    h('input', {
      type: 'checkbox',
      checked,
      disabled,
      // Whether stored credentials leave the machine is an on/off capability,
      // not a selection among items, so it is announced as a switch. The
      // wrapping <label> is what gives the control its accessible name.
      role: 'switch',
      'aria-checked': checked,
      onChange: (event: { target?: { checked?: unknown } }) => onChange(event?.target?.checked === true),
      'data-at-terminal-action': key
    }),
    t(labelKey)
  );
}

function passwordField(
  t: Translate,
  key: string,
  labelKey: string,
  hintKey: string | null,
  value: string,
  disabled: boolean,
  onChange: (value: string) => void,
  autoFocus = false
): El {
  const control: Record<string, unknown> = {
    type: 'password',
    value,
    disabled,
    placeholder: hintKey === null ? '' : t(hintKey),
    onChange: (event: { target?: { value?: unknown } }) => onChange(text(event?.target?.value)),
    'data-at-terminal-action': key
  };
  if (autoFocus) {
    // The package password is the one field export cannot proceed without, so
    // it is where focus belongs on open — landing on a checkbox instead would
    // invite a stray Space that silently includes stored passwords.
    control['data-modal-autofocus'] = true;
  }
  return h('label', { key, className: 'att-field' }, t(labelKey), h('input', control));
}

export function renderExportDialog(props: ExportDialogProps): El {
  const { t } = props;
  const busy = props.state.kind === 'pending';
  const body: El[] = [
    checkRow(t, 'export-include-passwords', 'export.includePasswords', props.includePasswords, busy, props.onIncludePasswords),
    checkRow(t, 'export-include-private-keys', 'export.includePrivateKeys', props.includePrivateKeys, busy, props.onIncludePrivateKeys),
    passwordField(t, 'export-password', 'export.password', 'export.passwordHint', props.password, busy, props.onPassword, true)
  ];
  if (props.state.kind === 'pending') {
    body.push(h('div', { key: 'pending', className: 'att-line' }, t('export.pending')));
  }
  if (props.state.kind === 'ok') {
    body.push(
      h(
        'div',
        { key: 'done', className: 'att-line', 'data-at-terminal-export': 'filename' },
        t('export.done', { filename: props.state.filename })
      )
    );
    if (props.state.omissions > 0) {
      body.push(
        h(
          'div',
          { key: 'omissions', className: 'att-line', 'data-at-terminal-export': 'omissions' },
          t('export.omissions', { count: props.state.omissions })
        )
      );
    }
  }
  if (props.state.kind === 'failed') {
    body.push(h('div', { key: 'failed' }, renderFailure(t, props.state)));
  }
  return overlay(
    'export',
    t('export.title'),
    body,
    h(
      'div',
      { className: 'att-dialog-actions' },
      h(
        'button',
        { type: 'button', className: 'att-btn', onClick: props.onClose, 'data-at-terminal-action': 'export-close' },
        t('dialog.close')
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'att-btn primary',
          disabled: busy,
          onClick: props.onSubmit,
          'data-at-terminal-action': 'export-submit'
        },
        t('export.submit')
      )
    ),
    props.onClose
  );
}

export function renderImportDialog(props: ImportDialogProps): El {
  const { t } = props;
  const busy = props.state.kind === 'pending';
  const body: El[] = [
    h(
      'label',
      { key: 'file', className: 'att-field' },
      t('import.file'),
      h('input', {
        type: 'file',
        accept: '.at-terminal-assets',
        disabled: busy,
        // Import cannot start until a package is picked, so this is the control
        // focus belongs on; the password and strategy only matter afterwards.
        'data-modal-autofocus': true,
        onChange: (event: { target?: { files?: ArrayLike<File> | null } }) => {
          const file = event?.target?.files?.[0] ?? null;
          props.onFile(file, () => (file === null ? Promise.resolve('') : file.text()));
        },
        'data-at-terminal-action': 'import-file'
      }),
      props.fileName !== null ? h('span', { className: 'att-chip' }, props.fileName) : null
    ),
    passwordField(t, 'import-password', 'import.password', null, props.password, busy, props.onPassword),
    h(
      'label',
      { key: 'strategy', className: 'att-field' },
      t('import.strategy'),
      h(
        'select',
        {
          value: props.strategy,
          disabled: busy,
          onChange: (event: { target?: { value?: unknown } }) =>
            props.onStrategy(text(event?.target?.value) || 'skip'),
          'data-at-terminal-action': 'import-strategy'
        },
        h('option', { value: 'skip' }, t('import.strategy.skip')),
        h('option', { value: 'overwrite' }, t('import.strategy.overwrite')),
        h('option', { value: 'rename' }, t('import.strategy.rename'))
      )
    )
  ];
  if (props.state.kind === 'pending') {
    body.push(h('div', { key: 'pending', className: 'att-line' }, t('import.pending')));
  }
  if (props.state.kind === 'ok') {
    const summary = props.state.summary ?? {};
    body.push(
      h('div', { key: 'done', className: 'att-line', 'data-at-terminal-import': 'done' }, t('import.done')),
      h('div', { key: 'imported', className: 'att-line', 'data-at-terminal-import': 'imported' }, t('import.result.imported', { count: count(summary.imported) })),
      h('div', { key: 'skipped', className: 'att-line', 'data-at-terminal-import': 'skipped' }, t('import.result.skipped', { count: count(summary.skipped) })),
      h('div', { key: 'overwritten', className: 'att-line', 'data-at-terminal-import': 'overwritten' }, t('import.result.overwritten', { count: count(summary.overwritten) })),
      h('div', { key: 'renamed', className: 'att-line', 'data-at-terminal-import': 'renamed' }, t('import.result.renamed', { count: count(summary.renamed) })),
      h('div', { key: 'privateKeys', className: 'att-line', 'data-at-terminal-import': 'privateKeys' }, t('import.result.privateKeys', { count: count(summary.privateKeysWritten) }))
    );
  }
  if (props.state.kind === 'failed') {
    body.push(h('div', { key: 'failed' }, renderFailure(t, props.state)));
  }
  return overlay(
    'import',
    t('import.title'),
    body,
    h(
      'div',
      { className: 'att-dialog-actions' },
      h(
        'button',
        { type: 'button', className: 'att-btn', onClick: props.onClose, 'data-at-terminal-action': 'import-close' },
        t('dialog.close')
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'att-btn primary',
          disabled: busy,
          onClick: props.onSubmit,
          'data-at-terminal-action': 'import-submit'
        },
        t('import.submit')
      )
    ),
    props.onClose
  );
}

/* ------------------------------ the confirm box ------------------------------ */

/**
 * A yes/no question, as one shape for the whole panel.
 *
 * Before this, three destructive paths asked the browser: `window.confirm` for 删除服务器,
 * 覆盖上传 and 删除远端文件. Four things were wrong with that, and only the first is cosmetic:
 *
 * 1. It is the **browser's** chrome — a grey system dialog in the middle of a themed sidebar,
 *    with the origin string in it;
 * 2. it is **not themeable and not localizable** beyond the message text (its buttons say OK /
 *    Cancel in the browser's own language, which is often not the panel's);
 * 3. it **blocks the thread**, so an asynchronous flow cannot ask from inside a loop without
 *    freezing what it is doing — the upload path did, file by file;
 * 4. it has **no focus management** — focus lands wherever the browser puts it and comes back
 *    to the document, not to the control that asked.
 *
 * This reuses the import/export dialogs' own focus machinery (`dialogRef`, `dialogKeydown`),
 * which is the point: there is one Escape/Tab implementation in this panel, not two.
 */
export interface ConfirmDialogProps {
  t: Translate;
  title: string;
  message: string;
  /** The verb, not "确定": "删除" tells the user what they are about to do. */
  confirmLabel: string;
  /** Renders the confirm button in the error colour. */
  danger?: boolean;
  /** The action is in flight; both buttons stop responding. */
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
}

export function renderConfirmDialog(props: ConfirmDialogProps): El {
  const { t } = props;
  return overlay(
    'confirm',
    props.title,
    [h('p', { key: 'message', className: 'att-dialog-message' }, props.message)],
    h(
      'div',
      { className: 'att-dialog-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'att-btn',
          disabled: props.busy === true,
          onClick: props.onClose,
          // Focus starts on **cancel**: a destructive question whose default answer is "yes"
          // is a question a stray Return answers for you. This is the opposite of the import
          // dialog's choice, and deliberately so — there, Enter should proceed.
          'data-modal-autofocus': true,
          'data-at-terminal-action': 'confirm-cancel'
        },
        t('dialog.cancel')
      ),
      h(
        'button',
        {
          type: 'button',
          className: props.danger === true ? 'att-btn danger' : 'att-btn primary',
          disabled: props.busy === true,
          onClick: props.onConfirm,
          'data-at-terminal-action': 'confirm-accept'
        },
        props.confirmLabel
      )
    ),
    props.onClose
  );
}