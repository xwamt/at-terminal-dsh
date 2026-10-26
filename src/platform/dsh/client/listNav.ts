/**
 * Arrow-key arithmetic for the two list surfaces this plugin owns.
 *
 * Kept out of the views because it is the only part of keyboard navigation that has a right
 * answer independent of the DOM: given an index and a key, which index should be focused. The
 * rest — actually moving focus, keeping selection in sync — is DOM work that belongs next to the
 * element that owns it.
 *
 * The model is the single-select listbox one: arrows move by one and **stop at the ends** rather
 * than wrapping, Home/End jump. Wrapping is the convention for composite widgets like radiogroups
 * but it is wrong here: a user holding ArrowDown to reach the bottom of a 40-server list does not
 * expect to be thrown back to the top, and the browser's own `<select>` does not do it either.
 */
export function nextIndex(current: number, total: number, key: string): number | null {
  if (total <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(total - 1, Math.max(0, current + 1));
    case 'ArrowUp':
      return Math.max(0, Math.min(total - 1, current - 1));
    case 'Home':
      return 0;
    case 'End':
      return total - 1;
    default:
      return null;
  }
}

/**
 * Move focus to a sibling row and let the row's own click handler take it from there.
 *
 * `click()` rather than a direct `onSelect` call is deliberate: the row already knows what
 * selecting means (it sets the body's selection *and* the shortcut's target), and a second code
 * path that only set one of them is exactly how keyboard and mouse behaviour drift apart. A
 * synthetic click is one thing every browser and every DOM stand-in implements.
 */
export function moveRowFocus(
  event: { key?: string; currentTarget?: unknown; preventDefault?: () => void },
  selector: string
): boolean {
  const doc = typeof document === 'undefined' ? undefined : document;
  if (doc === undefined) return false;
  /*
   * Scope the search to the list that received the key, never to the whole document.
   *
   * This used to be `doc.querySelectorAll(selector)` against a bare attribute such as
   * `[data-at-terminal-row]`. Two things share that attribute across the page — a second mounted
   * asset body (the frame keeps a background tab's body mounted once it has been visited) and the
   * SFTP rows when both pages exist — so ArrowDown at the end of *this* list stepped into another
   * container and fired **its** `onSelect`, changing a selection the user could not even see.
   *
   * `currentTarget` is the row that owns the handler; its nearest `[role="listbox"]` /
   * `[role="tree"]` ancestor is exactly the list the arrow key is about. When no such ancestor
   * exists (a caller outside a listbox) the current-target check below rejects the move, which is
   * the same answer the old `at < 0` guard gave — just for the right reason.
   */
  const owner = event.currentTarget as { closest?: (selector: string) => Element | null } | undefined;
  const root = (owner?.closest?.('[role="listbox"],[role="tree"],[role="grid"]') ?? null) as Element | null;
  const rows = Array.from((root ?? doc).querySelectorAll(selector)) as unknown as Array<{
    focus?: () => void;
    click?: () => void;
  }>;
  if (rows.length === 0) return false;
  const at = rows.indexOf(event.currentTarget as never);
  // `-1` means the element that received the key is not one of the rows this selector matches —
  // for instance a row rendered inside a different container. Computing from -1 would land on
  // the first row and silently throw the user back to the top of the list.
  if (at < 0) return false;
  const next = nextIndex(at, rows.length, String(event.key ?? ''));
  if (next === null) return false;
  event.preventDefault?.();
  const node = rows[next];
  node?.focus?.();
  node?.click?.();
  return true;
}
