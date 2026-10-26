import React from 'react';

import { nextIndex } from './listNav';

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
