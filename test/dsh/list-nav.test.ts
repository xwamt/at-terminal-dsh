import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { moveRowFocus, nextIndex } from '../../src/platform/dsh/client/listNav';

/**
 * UI2-09 — the asset list and the two context menus, from the keyboard.
 *
 * The split here is the same one the implementation makes:
 *
 * - `nextIndex` and `moveRowFocus` are the parts with a right answer independent of React, so
 *   they are tested directly — including a stub `document`, which is enough to prove the focus
 *   actually moves and that selection follows it through the row's own click handler.
 * - The wiring (a row that passes the handler, a menu that mounts the hook) is asserted on the
 *   **source**. A component cannot be mounted in these node-side tests — the React stand-in
 *   throws on every hook by design — and a test that pretended otherwise would be asserting on
 *   nothing.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

const ASSETS = read('src/platform/dsh/client/views/assets.ts');
const BODY = read('src/platform/dsh/client/body.ts');
const BODY_SESSION = read('src/platform/dsh/client/body-session.ts');

describe('nextIndex (UI2-09)', () => {
  it('moves by one and stops at the ends rather than wrapping', () => {
    // Wrapping is the radiogroup convention; holding ArrowDown through a long server list and
    // being thrown back to the top is the behaviour a <select> does not have either.
    expect(nextIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(nextIndex(2, 3, 'ArrowDown')).toBe(2);
    expect(nextIndex(1, 3, 'ArrowUp')).toBe(0);
    expect(nextIndex(0, 3, 'ArrowUp')).toBe(0);
  });

  it('jumps to the ends on Home and End', () => {
    expect(nextIndex(1, 5, 'Home')).toBe(0);
    expect(nextIndex(1, 5, 'End')).toBe(4);
  });

  it('reports "not mine" for any other key', () => {
    for (const key of ['Enter', ' ', 'a', 'Tab', 'PageDown']) {
      expect(nextIndex(1, 5, key)).toBeNull();
    }
  });

  it('refuses to compute an index in an empty list', () => {
    expect(nextIndex(0, 0, 'ArrowDown')).toBeNull();
    expect(nextIndex(-1, 0, 'Home')).toBeNull();
  });
});

describe('moveRowFocus (UI2-09)', () => {
  const original = globalThis.document;

  /** Three pretend rows that record what happened to them. */
  function makeRows(): Array<{ focus: () => void; click: () => void; focused: boolean; clicked: boolean }> {
    return [0, 1, 2].map(() => {
      const row = {
        focused: false,
        clicked: false,
        focus() {
          row.focused = true;
        },
        click() {
          row.clicked = true;
        }
      };
      return row;
    });
  }

  function withRows(rows: unknown[]): void {
    (globalThis as { document?: unknown }).document = { querySelectorAll: () => rows };
  }

  afterEach(() => {
    (globalThis as { document?: unknown }).document = original;
  });

  it('focuses the next row and lets its own click handler select it', () => {
    const rows = makeRows();
    withRows(rows);
    const preventDefault = vi.fn();

    const handled = moveRowFocus({ key: 'ArrowDown', currentTarget: rows[0], preventDefault }, '[data-at-terminal-row]');

    expect(handled).toBe(true);
    expect(rows[1].focused).toBe(true);
    // Selection follows focus *through the row's own onClick* — a second "set selection only"
    // path is how keyboard and mouse behaviour drift apart.
    expect(rows[1].clicked).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('leaves the page alone for a key it does not own', () => {
    const rows = makeRows();
    withRows(rows);
    const preventDefault = vi.fn();

    expect(moveRowFocus({ key: 'Enter', currentTarget: rows[0], preventDefault }, '[data-at-terminal-row]')).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(rows.some((row) => row.focused)).toBe(false);
  });

  it('does nothing when the current row is not in the list it queried', () => {
    const rows = makeRows();
    withRows(rows);
    // indexOf() === -1: ArrowDown would otherwise land on row 0 and undo the user's position.
    expect(moveRowFocus({ key: 'ArrowDown', currentTarget: {}, preventDefault: () => {} }, '[x]')).toBe(false);
  });

  it('survives a page with no rows', () => {
    withRows([]);
    expect(moveRowFocus({ key: 'ArrowDown', currentTarget: {}, preventDefault: () => {} }, '[x]')).toBe(false);
  });
});

describe('asset rows are reachable (UI2-09)', () => {
  it('gives the list exactly one Tab stop, on a row that can be reached', () => {
    // `role="option"` with no tabIndex was the defect: announced as selectable, unreachable.
    expect(ASSETS).toContain('tabIndex: roving ? 0 : -1');
    // Without the fallback an unselected list has no stop at all and Tab skips the whole list.
    expect(ASSETS).toContain('const rovingId = selectedOnScreen ? props.selectedId');
  });

  it('maps Enter to "open a terminal" and Space to "select"', () => {
    expect(ASSETS).toContain("if (key === 'Enter')");
    expect(ASSETS).toContain("props.onOpenInNewTab(server)");
    expect(ASSETS).toContain("if (key === ' ' || key === 'Spacebar')");
    // Everything that is not Enter or Space is left to the shared row-navigation helper, which
    // is where "does not move past the ends" and "does not fire for unrelated keys" are decided.
    expect(ASSETS).toContain("moveRowFocus(event, '[data-at-terminal-row]')");
  });

  it('makes the group header a button named by its own group', () => {
    expect(ASSETS).toContain("className: 'att-group'");
    expect(ASSETS).toContain("role: 'group'");
    expect(ASSETS).toContain("'aria-labelledby': headerId");
    // A `div` with aria-expanded had no role and no tabindex: a disclosure nothing could operate.
    expect(ASSETS).toContain("className: 'att-group-name',");
    expect(ASSETS).toContain("'aria-expanded': !isCollapsed");
  });
});

describe('both context menus share one behaviour (UI2-09)', () => {
  it('mounts the shared hook in the asset body and in the SFTP body', () => {
    expect(BODY).toContain('useMenuFocus(menu !== null');
    expect(BODY_SESSION).toContain('useMenuFocus(sftpMenu !== null');
  });

  it('gives menu items one focus stop between them', () => {
    // Every item is -1: the menu owns the stop, arrows move inside it, Tab leaves the menu
    // instead of walking its five entries.
    expect(BODY).toContain('tabIndex: -1');
    expect(BODY_SESSION).toContain('tabIndex: -1');
  });

  it('wires the ref and the arrow-key handler into the menu element', () => {
    expect(BODY).toContain('ref: menuFocus.ref');
    expect(BODY).toContain('onKeyDown: menuFocus.onKeyDown');
    expect(BODY_SESSION).toContain('ref: sftpMenuFocus.ref');
    expect(BODY_SESSION).toContain('onKeyDown: sftpMenuFocus.onKeyDown');
  });

  it('no longer carries a second copy of the close-on-escape effect', () => {
    // Two hand-written effects with the same three omissions is what the hook replaced.
    expect(BODY).not.toContain("document.addEventListener('keydown', onKeydown)");
    expect(BODY_SESSION).not.toContain("document.addEventListener('keydown', onKeydown)");
  });
});
