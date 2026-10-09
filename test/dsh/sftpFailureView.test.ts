import { describe, expect, it } from 'vitest';

import { sftpDirFailureKey, splitPathForDisplay } from '../../src/platform/dsh/client/models';

/**
 * These two live in `models.ts` rather than in the views because the repository has no
 * `react` dependency: `views/shared.ts` and `views/sftp.ts` both import it, so any test
 * that reached them would fail to resolve. A view-only export would be untestable, which
 * is the whole reason the logic sits on the model side.
 */
describe('a failed SFTP level gets its own copy, not the page-level one', () => {
  it('maps each Host read code to its own line', () => {
    expect(sftpDirFailureKey('sftp-no-such-file')).toBe('sftp.dirFailedNoSuchFile');
    expect(sftpDirFailureKey('sftp-permission-denied')).toBe('sftp.dirFailedPermissionDenied');
    expect(sftpDirFailureKey('sftp-read-failed')).toBe('sftp.dirFailedReadFailed');
  });

  it('still says the level was not read for a code it does not know', () => {
    // Falling through to no line at all would leave a silent gap in the tree, and a gap
    // reads as "empty" — the exact confusion the line exists to prevent.
    expect(sftpDirFailureKey('sftp-something-new')).toBe('sftp.dirFailed');
    expect(sftpDirFailureKey('')).toBe('sftp.dirFailed');
  });

  it('never borrows the page-level keys, whose advice would not apply', () => {
    // `error.sftp*` reads "refresh and expand again" — correct for a whole page that
    // failed, useless for one directory wedged between two that read fine.
    for (const code of ['sftp-no-such-file', 'sftp-permission-denied', 'sftp-read-failed']) {
      expect(sftpDirFailureKey(code).startsWith('sftp.dirFailed')).toBe(true);
    }
  });
});

describe('splitPathForDisplay — the official PathLabel halves', () => {
  it('dims the directory and leaves the leaf as exactly the last segment', () => {
    // The leaf is what a reader identifies the entry by, so the separator belongs to the
    // base half; putting it on the leaf would make the name read as "/known_hosts".
    expect(splitPathForDisplay('/root/.ssh/known_hosts')).toEqual({
      base: '/root/.ssh/',
      leaf: 'known_hosts'
    });
  });

  it('gives a bare filename no base at all', () => {
    expect(splitPathForDisplay('known_hosts')).toEqual({ base: '', leaf: 'known_hosts' });
  });

  it('treats a trailing slash as naming the directory, not the empty string after it', () => {
    expect(splitPathForDisplay('/var/log/')).toEqual({ base: '/var/log/', leaf: '' });
  });

  it('handles the filesystem root without inventing a leaf', () => {
    expect(splitPathForDisplay('/')).toEqual({ base: '/', leaf: '' });
  });

  it('keeps a dotfile leaf intact rather than splitting on its dot', () => {
    expect(splitPathForDisplay('/root/.bashrc')).toEqual({ base: '/root/', leaf: '.bashrc' });
  });

  it('returns two empty halves for an empty path, so the view decides what that means', () => {
    // The caller substitutes its own "unknown" copy; the split must not invent a leaf.
    expect(splitPathForDisplay('')).toEqual({ base: '', leaf: '' });
  });
});
