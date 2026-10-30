import { mkdtemp, realpath, rm, symlink, writeFile as writeLocalFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import { SftpSession } from '../../src/sftp/SftpSession';
import type { TransferProgress } from '../../src/sftp/TransferService';

function server(): ServerConfig {
  return {
    id: 'srv',
    label: 'Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 15,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

/**
 * The real, non-faked half of the local upload path.
 *
 * Everything here runs against the filesystem the Host actually has — no SSH, no fake session —
 * because these two methods decide *which file* an upload is authorized against. The service
 * tests use a fake session and therefore cannot catch a `realpath` that does not resolve, a `~`
 * that does not expand, or an `isFile` nobody consults.
 */
describe('SftpSession local upload source', () => {
  let directory = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'at-terminal-local-upload-'));
  });

  afterAll(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  function session(): SftpSession {
    // Nothing here connects: both methods are pure local-filesystem work, and a session that
    // never reached `connect()` is exactly the state the service is in when it stats a source.
    return new SftpSession(server(), {} as never, { verify: async () => true }, {
      allowSudoFallback: false
    });
  }

  it('reports the size and the real path of a regular file', async () => {
    const file = join(directory, 'artifact.bin');
    await writeLocalFile(file, Buffer.alloc(1024, 7));

    const stat = await session().statLocalFile(file);

    expect(stat.size).toBe(1024);
    expect(stat.isFile).toBe(true);
    expect(stat.realPath).toBe(await realpath(file));
  });

  it('resolves a symlink to the file it points at', async () => {
    const key = join(directory, 'id_rsa');
    await writeLocalFile(key, 'PRIVATE KEY');
    const link = join(directory, 'payload.bin');
    await symlink(key, link);

    const stat = await session().statLocalFile(link);

    // The name says payload.bin; the real path is the key, which is what the sensitive-source
    // check, the confirmation and the audit row have to see.
    expect(stat.realPath).toBe(await realpath(key));
    expect(stat.realPath).not.toBe(link);
  });

  it('reports a directory as not a file', async () => {
    const stat = await session().statLocalFile(directory);

    expect(stat.isFile).toBe(false);
    expect(stat.realPath).toBe(await realpath(directory));
  });

  it('rejects a missing path with ENOENT, so the caller can say "was not found"', async () => {
    await expect(session().statLocalFile(join(directory, 'nope.bin'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('expands a leading "~" against the Host home directory', async () => {
    const name = `at-terminal-missing-${process.pid}-${Date.now()}`;
    // Nothing is created under the real home directory: the expansion is proven by the ENOENT
    // naming the expanded path, which is the path the stat would have used had it existed.
    await expect(session().statLocalFile(`~/${name}`)).rejects.toMatchObject({
      code: 'ENOENT',
      path: join(homedir(), name)
    });
  });

  it('leaves "~user" alone, the way the remote side does', async () => {
    // Another account's home needs a passwd lookup; inventing one is worse than the ENOENT.
    await expect(session().statLocalFile('~deploy/at-terminal-missing')).rejects.toMatchObject({
      path: '~deploy/at-terminal-missing'
    });
  });

  it('passes the overwrite decision through to the transfer', async () => {
    const subject = session();
    const uploadFile = vi.spyOn(subject, 'uploadFile').mockResolvedValue(undefined);
    const progress: TransferProgress = { report: vi.fn() };

    await subject.uploadLocalFile('/tmp/source.bin', '/opt/app/bin', { overwrite: true, progress });

    expect(uploadFile).toHaveBeenCalledWith('/tmp/source.bin', '/opt/app/bin', progress, {
      overwrite: true
    });

    // The TOCTOU case: the dialog said "Overwrite: no", so the transfer must re-check rather
    // than force the overwrite through.
    await subject.uploadLocalFile('/tmp/source.bin', '/opt/app/bin', { overwrite: false });

    expect(uploadFile).toHaveBeenLastCalledWith('/tmp/source.bin', '/opt/app/bin', undefined, {
      overwrite: false
    });
  });
});
