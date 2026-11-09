import React from 'react';

import { nextIndex } from './listNav';

/* ------------------------- host context-menu hand-off ------------------------ */

/**
 * Custom menu target kinds this plugin declares.
 *
 * The host's `dsh-client-ui-context-menu` lets a plugin extend `ContextMenuTargetMap`; this
 * client half cannot import that package (nor any `@deepseek-ai/*` implementation — the
 * browser module table is frozen), so the same declaration is kept structural here. The
 * strings are the contract: they must match the `target` passed to `ctx.contextMenus.register`
 * and the `kind` carried by `getTriggerProps`.
 *
 * Values are JSON-compatible identifiers only — a captured target outlives the row that
 * produced it, so it must not hold a closure or a DOM node. Everything mutable (the server
 * record, the terminal session) is re-read by the action callback before it runs.
 */
export const SERVER_MENU_TARGET = 'at-terminal.server' as const;
export const SFTP_ENTRY_MENU_TARGET = 'at-terminal.sftp-entry' as const;
export const SFTP_CONTAINER_MENU_TARGET = 'at-terminal.sftp-container' as const;

export type MenuTargetKind =
  | typeof SERVER_MENU_TARGET
  | typeof SFTP_ENTRY_MENU_TARGET
  | typeof SFTP_CONTAINER_MENU_TARGET;

export interface MenuTarget {
  kind: MenuTargetKind;
  value: Record<string, unknown>;
}

/**
 * One plain-data action, as `ctx.contextMenus.resolve` publishes it.
 *
 * `run` is the only non-serializable member and it never leaves the registry: the overlay
 * gets presentation fields and invokes the captured callback by its encoded id. Returning
 * `void` or a promise is both fine; the host reports a rejection through `failureLabel`.
 */
export interface MenuAction {
  id: string;
  label: string;
  run: () => unknown;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  failureLabel?: string;
}

export type MenuActionBuilder = (value: Record<string, unknown>) => MenuAction[];

/** The trigger-prop factory the host injects into every Slot scope (`useContextMenu`). */
export type GetTriggerProps = (
  target: MenuTarget,
  handlers?: Record<string, unknown>
) => Record<string, unknown>;

/** The subset of the host's `contextMenus` service this client half uses. */
export interface ContextMenuService {
  register(input: {
    id: string;
    target: MenuTargetKind;
    order?: number;
    resolve: (value: Record<string, unknown>, signal?: AbortSignal) => MenuAction[] | Promise<MenuAction[]>;
  }): () => void;
  open?(target: MenuTarget, point: { x: number; y: number }): void;
}

/**
 * The body-side half of a menu.
 *
 * Registration happens once per target family in `apply`, but the *actions* belong to one
 * mounted body: they need that body's live state, its `t`, and its RPC session. So each body
 * publishes a builder here while it is mounted, keyed by its tab key (the same identity the
 * target value carries). A provider resolving a target for a closed tab finds no builder and
 * returns nothing — the menu cannot act on a server or path nobody is showing.
 *
 * The map is module state rather than a service because it is a table of currently mounted
 * UI owners, not an application capability. `set…` returns the unregister function the mount
 * effect must call; deleting by identity keeps a late cleanup from removing a newer mount of
 * the same tab.
 */
type MenuBuilderMap = Map<string, MenuActionBuilder>;

const serverMenuBuilders: MenuBuilderMap = new Map();
const sftpMenuBuilders: MenuBuilderMap = new Map();

function tabKeyOf(value: Record<string, unknown>): string {
  return typeof value.tabKey === 'string' ? value.tabKey : '';
}

function resolveMenuActions(map: MenuBuilderMap, value: Record<string, unknown>): MenuAction[] {
  const builder = map.get(tabKeyOf(value));
  if (builder !== undefined) return builder(value);
  // A single mounted body is unambiguous even if an older target came from a tab whose
  // `tabKey` was not carried (a restored layout from before this field existed).
  if (map.size === 1) return [...map.values()][0](value);
  return [];
}

export function setServerMenuBuilder(tabKey: string, build: MenuActionBuilder): () => void {
  serverMenuBuilders.set(tabKey, build);
  return () => {
    if (serverMenuBuilders.get(tabKey) === build) serverMenuBuilders.delete(tabKey);
  };
}

export function resolveServerMenuActions(value: Record<string, unknown>): MenuAction[] {
  return resolveMenuActions(serverMenuBuilders, value);
}

export function setSftpMenuBuilder(tabKey: string, build: MenuActionBuilder): () => void {
  sftpMenuBuilders.set(tabKey, build);
  return () => {
    if (sftpMenuBuilders.get(tabKey) === build) sftpMenuBuilders.delete(tabKey);
  };
}

export function resolveSftpMenuActions(value: Record<string, unknown>): MenuAction[] {
  return resolveMenuActions(sftpMenuBuilders, value);
}

/**
 * One behaviour for both context menus — the asset list's and the SFTP tree's.
 *
 * They were two hand-written effects with the same three omissions, which is the argument for
 * this being a hook rather than a copied block: the second copy is where the fix goes missing.
 *
 * What "open a menu" has to mean, and what each of these was:
 *
 * 1. **Focus moves into the menu.** Neither did. A keyboard user who opened it with the `⋯`
 *    button (or Shift+F10) had nowhere to go but onward through the page, with the menu still
 *    open behind them.
 * 2. **Escape closes it and returns focus to whatever opened it.** Closing alone loses the tab
 *    position, so the next Tab press restarts from the top of the panel.
 * 3. **It closes when the surface it points at scrolls.** The menu is positioned at a viewport
 *    coordinate captured at open time; once the list scrolls, that coordinate names a different
 *    row — or nothing. A menu that outlives its anchor is worse than a closed one.
 *
 * The scroll listener is on `document` in the **capture** phase because the thing that scrolls
 * is the list, not the page, and scroll events do not bubble.
 *
 * Arrow keys are deliberately *not* bound here. They belong on the menu element
 * (`menuKeyDown`), because a document-level handler would fight the list's own arrow-key
 * navigation while a menu happens to be open.
 */
export function useMenuFocus(
  open: boolean,
  onClose: () => void
): {
  ref: { current: HTMLElement | null };
  onKeyDown: (event: { key?: string; preventDefault?: () => void; currentTarget?: unknown }) => void;
} {
  const ref = React.useRef<HTMLElement | null>(null);
  // The close callback is almost always a new closure per render, so it is kept in a ref and read
  // inside the effect: depending on it directly would re-run the effect on every render and
  // re-focus the first item while the user was arrowing down the list.
  const closeRef = React.useRef(onClose);
  React.useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!open) return undefined;
    const doc = typeof document === 'undefined' ? undefined : document;
    if (doc === undefined) return undefined;
    const trigger = doc.activeElement as HTMLElement | null;
    const items = (): HTMLElement[] =>
      ref.current === null
        ? []
        : (Array.from(ref.current.querySelectorAll('[role="menuitem"]')) as unknown as HTMLElement[]);
    items()[0]?.focus?.();
    const close = (): void => closeRef.current();
    const onKeydown = (event: { key?: string }): void => {
      if (event.key !== 'Escape') return;
      closeRef.current();
      trigger?.focus?.();
    };
    /*
     * "The list scrolled away from the anchor" — with two exceptions.
     *
     * 1. A scroll **inside the menu itself** is not the anchor moving. Focusing the first item
     *    (`items()[0]?.focus?.()` above) can scroll the menu's own scroll container, and on a menu
     *    opened near the bottom of a panel that scroll arrives as a document-level scroll event in
     *    the capture phase. Without this guard the menu closed itself the instant it opened, which
     *    reads as "right-click does nothing".
     * 2. The scroll fired by that same focus call must be ignored for one frame, because the
     *    container being scrolled may be an *ancestor* of the menu rather than the menu.
     */
    let settle = true;
    const onScroll = (event?: Event): void => {
      if (settle) return;
      const target = event?.target;
      if (ref.current !== null && target instanceof Node && ref.current.contains(target)) return;
      closeRef.current();
    };
    const closeClick = (): void => closeRef.current();
    doc.addEventListener('click', closeClick);
    doc.addEventListener('keydown', onKeydown);
    doc.addEventListener('scroll', onScroll, true);
    // Cleared after the focus-induced scroll has been dispatched, before any user scroll can be.
    const settled = typeof setTimeout === 'function' ? setTimeout(() => { settle = false; }, 0) : 0;
    return () => {
      settle = true;
      if (typeof clearTimeout === 'function' && settled !== 0) clearTimeout(settled);
      doc.removeEventListener('click', closeClick);
      doc.removeEventListener('keydown', onKeydown);
      doc.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const onKeyDown = (event: {
    key?: string;
    preventDefault?: () => void;
    currentTarget?: unknown;
  }): void => {
    const host = event.currentTarget as { querySelectorAll?: (selector: string) => unknown } | undefined;
    const nodes = Array.from(
      (host?.querySelectorAll?.('[role="menuitem"]') ?? []) as ArrayLike<HTMLElement>
    );
    if (nodes.length === 0) return;
    const doc = typeof document === 'undefined' ? undefined : document;
    const at = doc === undefined ? -1 : nodes.indexOf(doc.activeElement as HTMLElement);
    const next = nextIndex(at, nodes.length, String(event?.key ?? ''));
    if (next === null) return;
    event.preventDefault?.();
    nodes[next]?.focus?.();
  };

  return { ref, onKeyDown };
}
