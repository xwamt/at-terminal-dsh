/**
 * UI state that outlives a tab body's mount, keyed by tab.
 *
 * ## Why this exists
 *
 * The frame **unmounts** a tab's body whenever another tab comes to the front — that is the
 * deliberate design recorded in `body-session.ts`, and it is what makes switching tabs free.
 * The cost is that every `useState` in a body dies with it: on 资产 that meant an unsaved
 * server form, the selected row, the collapsed groups and the scroll position, all gone the
 * moment the user glanced at a terminal and came back.
 *
 * `keepMounted` is the obvious answer and is **not** available: it blanked the panel (the
 * frame renders an inactive tab's body in a zero-size box, so xterm's fit ran with no metrics
 * and the panel came back white). `test/dsh/client-bundle.test.ts` asserts it stays absent.
 * So the state has to live outside React, exactly like `sessions.ts` does for the connection —
 * this module is the same shape for the parts that are *not* a connection.
 *
 * ## What is deliberately not stored
 *
 * | not stored | why |
 * |---|---|
 * | `form.password` | a password re-materialised into a form the user did not re-open is a secret that outlived its reason; `draftForm` blanks it, and the field's own hint says leaving it empty keeps the stored one |
 * | an editor buffer (`body-session.ts`'s `sftpFile`) | a stale buffer is worse than an empty one: it silently looks like the file |
 * | `formError`, `saveState`, `removal`, transfer progress | transient answers to one action; restoring them would attribute a past result to a fresh page |
 *
 * ## Lifetime
 *
 * `main.ts` clears a tab's bucket from the frame's own close handler, so this is bounded by the
 * number of open tabs rather than by the number of tabs ever opened. `MAX_TABS` is a backstop
 * for the paths that never fire it (a host that reloads the page, a frame that drops a tab
 * without a close event): dropping the oldest bucket costs a lost draft, while growing without
 * a bound would keep every draft of a long session alive.
 */

import type { FormModel } from './models';

/** Everything 资产 keeps across a body unmount. Password is always blank here. */
export interface AssetsTabState {
  formOpen: boolean;
  /** The draft. `password` is always `''` — see `draftForm`. */
  form: FormModel;
  /** The row the user last acted on, so the menu/shortcut targets what they were looking at. */
  listSelectedId: string;
  collapsedGroups: readonly string[];
  scrollTop: number;
}

/** What a 文件 page keeps. `body-session.ts` restores the expansion and re-reads the layers. */
export interface SftpTabState {
  /** Absolute directories the user had open, outermost first. */
  expanded: readonly string[];
  scrollTop: number;
}

interface Bucket {
  assets?: AssetsTabState;
  sftp?: SftpTabState;
}

const MAX_TABS = 32;

const buckets = new Map<string, Bucket>();

/**
 * The bucket for `key`, creating it if needed — or `null` for an empty key.
 *
 * Empty means "this body cannot name its tab", and a bucket under that name would be shared by
 * every anonymous render (a harness, an old frame) — one tab's draft appearing in another. The
 * bodies pass a constant fallback instead (`anonymous`), so nothing real lands here.
 */
function bucket(key: string): Bucket | null {
  if (key === '') return null;
  const existing = buckets.get(key);
  if (existing !== undefined) return existing;
  const created: Bucket = {};
  // Re-insert to keep Map iteration order equal to recency, so the eviction below drops the
  // least recently touched tab rather than an arbitrary one.
  buckets.set(key, created);
  if (buckets.size > MAX_TABS) {
    for (const oldest of buckets.keys()) {
      if (buckets.size <= MAX_TABS) break;
      buckets.delete(oldest);
    }
  }
  return created;
}

/**
 * The form as it may be stored.
 *
 * One field, and it is the whole point: a password that comes back by itself is a credential
 * the user never asked to keep resident, and the form already has a documented meaning for an
 * empty one ("leave blank to keep the stored password"). Blanking it on the way *in* means no
 * other caller has to remember to.
 */
export function draftForm(form: FormModel): FormModel {
  return form.password === '' ? form : { ...form, password: '' };
}

export function readAssetsState(key: string): AssetsTabState | undefined {
  return buckets.get(key)?.assets;
}

export function saveAssetsState(key: string, state: AssetsTabState): void {
  const target = bucket(key);
  if (target === null) return;
  target.assets = { ...state, form: draftForm(state.form) };
}

export function readSftpState(key: string): SftpTabState | undefined {
  return buckets.get(key)?.sftp;
}

export function saveSftpState(key: string, state: SftpTabState): void {
  const target = bucket(key);
  if (target === null) return;
  target.sftp = state;
}

/**
 * Drop a tab's bucket. Called from the frame's close handler for each tab kind, and on unload.
 *
 * `kind` narrows the clear to one half: a session tab closing says nothing about the 资产 tab,
 * and they are different `key`s anyway — the argument is there so a future shared key cannot
 * clear a neighbour by accident.
 */
export function clearTabState(key: string, kind?: 'assets' | 'sftp'): void {
  if (key === '') return;
  if (kind === undefined) {
    buckets.delete(key);
    return;
  }
  const existing = buckets.get(key);
  if (existing === undefined) return;
  delete existing[kind];
  if (existing.assets === undefined && existing.sftp === undefined) buckets.delete(key);
}

/** Every bucket. For the plugin-unload path, where nothing survives its own teardown. */
export function clearAllTabState(): void {
  buckets.clear();
}

/** How many tabs currently hold state. Exposed for the tests' leak check, not for the UI. */
export function tabStateCount(): number {
  return buckets.size;
}
