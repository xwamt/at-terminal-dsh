/**
 * The tab-keyed UI store: what survives a tab switch, and what is deliberately dropped.
 *
 * This file is the **behavioural** proof for UI2-03. The bundle suite cannot give it: its React
 * shim keeps one hook-slot array for the life of a harness, so a "re-render after unmount"
 * there still finds the old `useState` slots and would pass whether or not the store worked at
 * all. What the bundle suite can see is the wiring (a scroll handler and a ref on the list box),
 * and that is all it asserts.
 *
 * The store is module-level, so every test clears it first — otherwise the shared
 * `anonymous` fallback key hands one test's draft form to the next.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { emptyForm, type FormModel } from '../../src/platform/dsh/client/models';
import {
  clearAllTabState,
  clearTabState,
  draftForm,
  readAssetsState,
  readSftpState,
  saveAssetsState,
  saveSftpState,
  tabStateCount,
  type AssetsTabState
} from '../../src/platform/dsh/client/tabState';

function form(overrides: Partial<FormModel> = {}): FormModel {
  return { ...emptyForm(), ...overrides };
}

function assetsState(overrides: Partial<AssetsTabState> = {}): AssetsTabState {
  return {
    formOpen: false,
    form: form(),
    listSelectedId: '',
    collapsedGroups: [],
    scrollTop: 0,
    ...overrides
  };
}

describe('tab state — what a tab switch keeps (UI2-03)', () => {
  beforeEach(() => {
    clearAllTabState();
  });

  it('returns what a previous mount of the same tab stored', () => {
    saveAssetsState('tab-a', {
      formOpen: true,
      form: form({ label: 'prod', host: '10.0.0.1' }),
      listSelectedId: 'srv-1',
      collapsedGroups: ['ops'],
      scrollTop: 240
    });

    expect(readAssetsState('tab-a')).toMatchObject({
      formOpen: true,
      listSelectedId: 'srv-1',
      collapsedGroups: ['ops'],
      scrollTop: 240
    });
    expect(readAssetsState('tab-a')?.form.host).toBe('10.0.0.1');
  });

  it('keeps two tabs apart', () => {
    saveAssetsState('tab-a', assetsState({ listSelectedId: 'a' }));
    saveAssetsState('tab-b', assetsState({ listSelectedId: 'b' }));

    expect(readAssetsState('tab-a')?.listSelectedId).toBe('a');
    expect(readAssetsState('tab-b')?.listSelectedId).toBe('b');
    expect(readAssetsState('tab-c')).toBeUndefined();
  });

  it('never stores the password, whoever writes the state', () => {
    // Stripped on the way in rather than by the caller: the body has nine setters that touch
    // `form`, and a rule that has to be remembered at each of them is a rule that gets missed.
    saveAssetsState('tab-a', assetsState({ form: form({ label: 'x', password: 'hunter2' }) }));

    expect(readAssetsState('tab-a')?.form.password).toBe('');
    expect(draftForm(form({ password: 'hunter2' })).password).toBe('');
    // Everything else about the draft is kept, so the "leave blank to keep the stored one" hint
    // still describes a usable form.
    expect(readAssetsState('tab-a')?.form.label).toBe('x');
  });

  it('does not mutate the object it was handed', () => {
    // `draftForm` returns the same reference when there is no password, so a store that copied
    // lazily would let a later keystroke on the live form reach the saved draft.
    const live = form({ label: 'before', password: 'secret' });
    saveAssetsState('tab-a', assetsState({ form: live }));

    live.label = 'after';
    expect(readAssetsState('tab-a')?.form.label).toBe('before');
    expect(live.password).toBe('secret');
  });

  it('clears one tab, or one half of one tab', () => {
    saveAssetsState('tab-a', assetsState({ listSelectedId: 'a' }));
    saveSftpState('tab-a', { expanded: ['/root'], scrollTop: 10 });
    saveSftpState('tab-b', { expanded: ['/etc'], scrollTop: 0 });

    clearTabState('tab-a', 'sftp');
    expect(readSftpState('tab-a')).toBeUndefined();
    expect(readAssetsState('tab-a')).toBeDefined();

    clearTabState('tab-a');
    expect(readAssetsState('tab-a')).toBeUndefined();
    // A neighbour's bucket is untouched: a close is about one tab.
    expect(readSftpState('tab-b')?.expanded).toEqual(['/etc']);
  });

  it('ignores an empty key rather than storing a bucket nothing can name', () => {
    saveAssetsState('', assetsState({ listSelectedId: 'ghost' }));
    clearTabState('');

    expect(readAssetsState('')).toBeUndefined();
    expect(tabStateCount()).toBe(0);
  });

  it('stays bounded when close handlers never fire', () => {
    // The close path is the normal one; this is the backstop for the paths that skip it (a
    // host that reloads, a frame that drops a tab without an event). Losing the oldest draft
    // costs one form; keeping every draft of a day-long session costs the page.
    for (let index = 0; index < 40; index += 1) {
      saveAssetsState(`tab-${index}`, assetsState({ listSelectedId: `srv-${index}` }));
    }

    expect(tabStateCount()).toBeLessThanOrEqual(32);
    // The newest is the one that must survive: it is the tab the user is looking at.
    expect(readAssetsState('tab-39')?.listSelectedId).toBe('srv-39');
    expect(readAssetsState('tab-0')).toBeUndefined();
  });
});
