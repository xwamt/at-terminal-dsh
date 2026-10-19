/**
 * Shared view helpers: the React element shorthand, the async-state shape every
 * Host read uses, and the two chrome fragments (failure banner, mode nav) that
 * more than one page renders.
 */

import React, { type ReactElement } from 'react';

import { errorKey, splitPathForDisplay, type Translate } from '../models';

export const h = React.createElement;

export type El = ReactElement;

/**
 * The honest state of one Host read: pending, failed **with the Host's code**,
 * or ok. A failed read never renders as an empty list — "the Host is
 * unreachable" and "there is nothing configured" must stay distinguishable.
 */
export type AsyncState<T> =
  | { kind: 'pending' }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'ok'; result: T };

export const pendingState: AsyncState<never> = { kind: 'pending' };

/**
 * Whether a single-line label needs a disclosure control.
 *
 * The monitor views render long values (a command, a container mount path) on one clipped line;
 * this is the shared rule for when to offer the chevron that reveals the full text. A newline can
 * never be shown on one line, however short the value is.
 */
export function needsTextDisclosure(text: string, limit = 24): boolean {
  return text.length > limit || text.includes('\n');
}

export function failedState(error: { code?: unknown; message?: unknown }): AsyncState<never> {
  return {
    kind: 'failed',
    code: typeof error.code === 'string' ? error.code : 'client-error',
    message: String(error.message ?? '')
  };
}

/**
 * The failure banner: what happened, the code-specific copy, and the raw evidence line.
 *
 * `actions` exists because the copy for several codes ends in 「可重试」 — and a banner that tells
 * the user a retry is possible while offering nowhere to press is worse than one that stays
 * silent about it: they go looking for the control instead of reading the rest. The slot is
 * optional and rendered last so the banner still reads top-down as statement → detail → verb.
 */
export function renderFailure(
  t: Translate,
  failure: { code: string; message: string },
  actions: El[] = []
): El {
  return h(
    'div',
    { className: 'att-banner', 'data-at-terminal-error': failure.code },
    h('div', null, t('error.title')),
    h('div', null, t(errorKey(failure.code))),
    h('div', null, t('error.detail', { code: failure.code, message: failure.message })),
    ...(actions.length === 0 ? [] : [h('div', { key: 'actions', className: 'att-banner-actions' }, ...actions)])
  );
}

/**
 * The two pages of a **terminal tab**.
 *
 * It used to have a third, `'assets'`, because one body carried the server manager and the
 * connection behind one nav. They are two tab kinds now (`channel.ts` explains why), so the asset
 * list is not a page of anything and this type says what it means: the pages of one connection.
 */
export type PanelMode = 'sftp' | 'terminal';

/**
 * A single-line path, split so the directory dims and the leaf keeps the primary
 * color — the official `PathLabel` behavior.
 *
 * The split is what makes truncation honest. `text-overflow: ellipsis` cuts the
 * **tail**, which for a path discards the informative head (`/root/...`) and keeps
 * a long filename; the stylesheet instead pins the content to the right edge so the
 * overflow falls off the left, behind a mask. That only works if the two halves are
 * separate elements, which is why this is a component rather than a string.
 *
 * `title` goes on the container, not on a half: a tooltip on a clipped span reports
 * only the part that is still painted.
 *
 * The caller owns the truncation flag. Do **not** compute it from `scrollWidth` —
 * overflow past the *start* edge is not scrollable overflow in LTR, so it can equal
 * `clientWidth` while the text is visibly cut. Compare the sum of the halves'
 * `offsetWidth` against the container's, and recompute on resize.
 */
export function pathLabel(path: string, options: { truncated?: boolean } = {}): El {
  const { base, leaf } = splitPathForDisplay(path);
  return h(
    'span',
    {
      className: 'att-dir',
      title: path,
      'data-at-terminal-path-truncated': options.truncated === true ? 'true' : 'false'
    },
    h('span', { className: 'att-dir-base' }, base),
    h('span', { className: 'att-dir-leaf' }, leaf)
  );
}

/**
 * Ids for the nav/panel pairing, derived here so a new page cannot spell them wrong.
 *
 * The `scope` argument exists because both pages render their **own** nav and both stay
 * mounted at once (the inactive one is `hidden`, not unmounted). A tab id built from the mode
 * alone would therefore appear twice per document, and `aria-labelledby` resolves to whichever
 * copy the browser reaches first — the one inside a hidden page, which names nothing. Scoping the
 * tab to the page that hosts the nav keeps every id unique.
 *
 * The panel id needs no scope: there is exactly one panel per mode in the document, and both
 * navs legitimately point at the same pair.
 */
export function navTabId(scope: PanelMode, mode: PanelMode): string {
  return `at-tab-${scope}-${mode}`;
}

export function navPanelId(mode: PanelMode): string {
  return `at-panel-${mode}`;
}

/**
 * The segmented 文件/终端 switch shown on both pages of a **terminal tab**.
 *
 * 文件 is a peer page rather than a panel inside 终端: the file tree belongs to a live terminal,
 * and a tree reachable only from the terminal itself would be hard to find — while a tree shown
 * next to a *selected but unconnected* server would suggest it belongs to that server. Two tabs of
 * one connection is the honest shape.
 *
 * There is no 资产 entry. The server manager is a different tab kind with its own chip in the tab
 * strip, and a nav button that swapped this tab's body for a wholly different one is exactly what
 * this split removed.
 *
 * `scope` is the page hosting this nav, which is what keeps `navTabId` unique across the two
 * copies mounted at once. It defaults to `terminal` so the terminal page — whose own panel is
 * rendered by a DOM-bound component this module does not own — still gets distinct ids rather than
 * colliding with the file nav.
 */
export function renderNav(
  t: Translate,
  mode: PanelMode,
  onMode: (mode: PanelMode) => void,
  scope: PanelMode = 'terminal'
): El {
  const button = (value: PanelMode, key: string): El =>
    h(
      'button',
      {
        key: value,
        type: 'button',
        className: 'att-nav-btn',
        // `role="tab"` is what makes `aria-selected` meaningful; on a plain button the
        // attribute is inert, so the nav announced three unselected buttons.
        role: 'tab',
        id: navTabId(scope, value),
        'aria-selected': mode === value,
        // Points at the panel this tab reveals. Both navs name the same two panels, which is
        // correct: the nav is repeated per page, the panels are not.
        'aria-controls': navPanelId(value),
        onClick: () => onMode(value),
        'data-at-terminal-action': `mode-${value}`
      },
      t(key)
    );
  return h(
    'div',
    { className: 'att-nav', role: 'tablist', 'data-at-terminal-mode': mode },
    button('terminal', 'mode.terminal'),
    button('sftp', 'mode.sftp')
  );
}