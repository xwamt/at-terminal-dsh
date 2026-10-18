import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearTabState,
  readAssetsState,
  readSftpState,
  saveAssetsState,
  saveSftpState
} from '../../src/platform/dsh/client/tabState';

/**
 * UI2-11 — the file tree comes back the way it was left, and a failed read offers the retry it
 * promises.
 *
 * The store itself is exercised directly (it is plain module state), and the wiring in
 * `body-session.ts` is asserted on the source, for the reason the other client suites give: the
 * React stand-in throws on every hook, so a component cannot be mounted here and a test that
 * claimed to would be asserting on nothing.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

const BODY_SESSION = read('src/platform/dsh/client/body-session.ts');
const SFTP = read('src/platform/dsh/client/views/sftp.ts');
const SFTP_FILE = read('src/platform/dsh/client/views/sftpFile.ts');
const SHARED = read('src/platform/dsh/client/views/shared.ts');

describe('the SFTP bucket in tabState (UI2-11)', () => {
  beforeEach(() => {
    clearTabState('tab-sftp');
    clearTabState('tab-both', 'sftp');
  });

  it('round-trips the expansion list and the reading position', () => {
    saveSftpState('tab-sftp', { expanded: ['/root', '/root/docker'], scrollTop: 240 });
    expect(readSftpState('tab-sftp')).toEqual({ expanded: ['/root', '/root/docker'], scrollTop: 240 });
  });

  it('keeps the two halves of a bucket apart', () => {
    // The asset draft and the file tree are different pages of different tabs; clearing one must
    // not take the other with it.
    saveSftpState('tab-both', { expanded: ['/etc'], scrollTop: 12 });
    saveAssetsState('tab-both', {
      formOpen: false,
      form: { id: '', label: '', host: '', port: '22', username: '', authType: 'password', password: '', group: '' } as never,
      listSelectedId: 'srv-1',
      collapsedGroups: [],
      scrollTop: 4
    });

    clearTabState('tab-both', 'sftp');

    expect(readSftpState('tab-both')).toBeUndefined();
    expect(readAssetsState('tab-both')?.listSelectedId).toBe('srv-1');
  });

  it('refuses to store anything under an empty key', () => {
    saveSftpState('', { expanded: ['/'], scrollTop: 1 });
    expect(readSftpState('')).toBeUndefined();
  });
});

describe('the body restores what the store kept (UI2-11)', () => {
  it('seeds the expansion list from the store, not from an empty array', () => {
    expect(BODY_SESSION).toContain('readSftpState(key)?.expanded ?? []');
  });

  it('writes the expansion list back on every change', () => {
    expect(BODY_SESSION).toContain('saveSftpState(key, { expanded: sftpExpanded');
  });

  it('re-reads the open layers instead of restoring a stale cache', () => {
    // The children cache is deliberately *not* stored: a listing from before the unmount can be
    // minutes old, and a tree that looks expanded over a stale file list is worse than a re-read.
    expect(BODY_SESSION).toContain('if (sftpChildren[path] === undefined) void fetchSftpChildren(path);');
    expect(BODY_SESSION).not.toContain('children: readSftpState');
  });

  it('hands the tree a scroll ref and reports the offset', () => {
    expect(BODY_SESSION).toContain('scrollRef: sftpScrollRef');
    expect(BODY_SESSION).toContain('onScrollTop: (top) => {');
    expect(SFTP).toContain('ref: props.scrollRef');
    expect(SFTP).toContain('props.onScrollTop?.(Number(event?.currentTarget?.scrollTop ?? 0))');
  });

  it('restores the offset only once the tree has rows to scroll', () => {
    // On the first paint the container has no height, so setting scrollTop then clamps to 0 and
    // the position is lost for good. The effect therefore waits for the read to land.
    expect(BODY_SESSION).toContain('node.scrollTop = sftpScrollTopRef.current;');
  });
});

describe('closing a dirty buffer asks first (UI2-11)', () => {
  it('routes 关闭 through the shared confirm dialog', () => {
    expect(BODY_SESSION).toContain('if (sftpFile.kind === \'ready\' && sftpFile.dirty)');
    expect(BODY_SESSION).toContain("t('dialog.confirmDiscardTitle')");
    expect(BODY_SESSION).toContain("t('sftp.discardConfirm'");
    // Cancel keeps the buffer: the early return is the whole difference between a confirmation
    // and a notification.
    expect(BODY_SESSION).toContain('if (!discard) return;');
  });

  it('does not ask after a successful save', () => {
    // `saved` is not `dirty`: asking again would train the user to click through the dialog.
    expect(SFTP_FILE).toContain("pane.save.kind === 'pending'");
  });
});

describe('a failed read offers the retry it promises (D6)', () => {
  it('gives renderFailure an actions slot', () => {
    expect(SHARED).toContain('actions: El[] = []');
    expect(SHARED).toContain("className: 'att-banner-actions'");
  });

  it('uses it on the failed SFTP read', () => {
    // The copy for `error.sftpReadFailed` says 「可重试」 in as many words. The banner used to end
    // there with nothing to press, so the user went looking for the control instead of reading.
    expect(SFTP).toContain("'data-at-terminal-action': 'sftp-retry'");
    expect(SFTP).toContain('renderFailure(t, state, [');
  });
});
