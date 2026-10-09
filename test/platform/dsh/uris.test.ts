import { describe, expect, it } from 'vitest';
import { createDshUriService } from '../../../src/platform/dsh/uris';
import { FakeUri } from '../../core/fakes';

/**
 * `UriService` contract on the dsh side. The expectations mirror
 * `test/core/platform-contract.test.ts`'s `UriService` block (the in-memory reference),
 * so the dsh implementation is held to the same behaviour as the Fake and the VS Code
 * adapter.
 */

describe('createDshUriService', () => {
  it('file() yields a file URI whose toString() is a usable file:// URL', () => {
    const uris = createDshUriService();

    const uri = uris.file('/home/user/.at-terminal/storage');

    expect(uri.scheme).toBe('file');
    expect(uri.fsPath).toBe('/home/user/.at-terminal/storage');
    expect(uri.toString()).toBe('file:///home/user/.at-terminal/storage');
  });

  it('joinPath() joins filesystem segments and keeps the base scheme', () => {
    const uris = createDshUriService();

    const storage = uris.file('/home/user/.at-terminal/storage');
    expect(uris.joinPath(storage, 'sftp-edit', 'server-1', 'hash', 'file.txt').fsPath).toBe(
      '/home/user/.at-terminal/storage/sftp-edit/server-1/hash/file.txt'
    );
    expect(uris.joinPath(uris.file('/opt/ext'), 'dist', 'webview', 'terminal.js').fsPath).toBe(
      '/opt/ext/dist/webview/terminal.js'
    );

    // The preview scheme is not `file`, and joining onto it must not rewrite it to one.
    const preview = uris.from({ scheme: 'ssh-manager-sftp-preview', path: '/notes' });
    expect(uris.joinPath(preview, 'sub', 'a.txt').scheme).toBe('ssh-manager-sftp-preview');
  });

  it('joinPath() with no segments is a no-op that preserves query and fragment', () => {
    const uris = createDshUriService();

    const preview = uris.from({
      scheme: 'ssh-manager-sftp-preview',
      path: '/notes.txt',
      query: 'local=%2Ftmp%2Fnotes.txt'
    });

    // Rebuilding from scheme+fsPath would drop the query here, and the preview map keys
    // its documents by the full `toString()` (src/sftp/SftpPreview.ts:12-20).
    expect(uris.joinPath(preview)).toBe(preview);
    expect(uris.joinPath(preview).toString()).toBe(preview.toString());
  });

  it('parse() round-trips a file URL, decoding percent-encoding', () => {
    const uris = createDshUriService();

    const parsed = uris.parse('file:///tmp/dropped.txt');
    expect(parsed.scheme).toBe('file');
    expect(parsed.fsPath).toBe('/tmp/dropped.txt');
    expect(parsed.toString()).toBe('file:///tmp/dropped.txt');

    // A dropped file whose name has a space / non-ASCII character arrives encoded, and
    // `fsPath` must be the decoded path a `readFile` can use.
    const spaced = uris.parse('file:///tmp/a%20b.txt');
    expect(spaced.fsPath).toBe('/tmp/a b.txt');
    expect(spaced.toString()).toBe('file:///tmp/a%20b.txt');

    const nonAscii = uris.parse('file:///tmp/%E4%B8%AD%E6%96%87.txt');
    expect(nonAscii.fsPath).toBe('/tmp/中文.txt');
    expect(nonAscii.toString()).toBe('file:///tmp/%E4%B8%AD%E6%96%87.txt');
  });

  it('parse() treats a bare path as a file URI, and a custom scheme keeps its parts', () => {
    const uris = createDshUriService();

    const bare = uris.parse('/tmp/plain.txt');
    expect(bare.scheme).toBe('file');
    expect(bare.fsPath).toBe('/tmp/plain.txt');

    const relative = uris.parse('notes.txt');
    expect(relative.scheme).toBe('file');
    expect(relative.fsPath).toBe('notes.txt');

    const custom = uris.parse('ssh-manager-sftp-preview:/notes.txt?local=%2Ftmp%2Fnotes.txt');
    expect(custom.scheme).toBe('ssh-manager-sftp-preview');
    expect(custom.fsPath).toBe('/notes.txt');
    expect(custom.toString()).toBe('ssh-manager-sftp-preview:/notes.txt?local=%2Ftmp%2Fnotes.txt');
  });

  it('from() carries query and fragment into toString() instead of dropping them', () => {
    const uris = createDshUriService();

    const preview = uris.from({
      scheme: 'ssh-manager-sftp-preview',
      path: '/notes.txt',
      query: 'local=%2Ftmp%2Fnotes.txt'
    });
    expect(preview.scheme).toBe('ssh-manager-sftp-preview');
    expect(preview.fsPath).toBe('/notes.txt');
    expect(preview.toString()).toBe(
      'ssh-manager-sftp-preview:/notes.txt?local=%2Ftmp%2Fnotes.txt'
    );

    const withFragment = uris.from({ scheme: 'at-terminal', path: '/log', fragment: 'tail' });
    expect(withFragment.toString()).toBe('at-terminal:/log#tail');
  });

  it('isUri() accepts only URIs this service built', () => {
    const uris = createDshUriService();

    expect(uris.isUri(uris.file('/a.txt'))).toBe(true);
    expect(uris.isUri(uris.parse('file:///tmp/a.txt'))).toBe(true);
    expect(uris.isUri(uris.from({ scheme: 'ssh-manager-sftp-preview', path: '/a.txt' }))).toBe(true);

    // A structurally-identical object from elsewhere is *not* one of ours -- the same
    // "only the host's own Uri passes" rule the VS Code adapter implements with
    // `value instanceof vscode.Uri`.
    expect(uris.isUri({ scheme: 'file', fsPath: '/tmp/x', toString: () => 'file:///tmp/x' })).toBe(
      false
    );
    expect(uris.isUri(new FakeUri('file', '/tmp/x'))).toBe(false);
    expect(uris.isUri('file:///tmp/x')).toBe(false);
    expect(uris.isUri(undefined)).toBe(false);
    expect(uris.isUri(null)).toBe(false);
  });

  it('isUri() narrows the type, so a caller can read fsPath after the check', () => {
    const uris = createDshUriService();
    const value: unknown = uris.file('/a.txt');

    // Compile-time anchor: this only type-checks because `isUri` is a predicate.
    if (uris.isUri(value)) {
      expect(value.fsPath).toBe('/a.txt');
      expect(value.scheme).toBe('file');
    } else {
      throw new Error('expected the URI built by this service to pass isUri');
    }
  });
});
