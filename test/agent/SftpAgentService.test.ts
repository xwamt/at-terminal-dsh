import { describe, expect, it, vi } from 'vitest';
import {
  MAX_LOCAL_UPLOAD_BYTES,
  SftpAgentService,
  type AgentSftpSession
} from '../../src/agent/SftpAgentService';
import type { ServerConfig } from '../../src/config/schema';
import type { SftpEntry } from '../../src/sftp/SftpTypes';
import type { TransferProgress } from '../../src/sftp/TransferService';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

function server(id = 'server-1', overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function connectedRegistry(): TerminalContextRegistry {
  const registry = new TerminalContextRegistry();
  registry.setActive({
    terminalId: 'terminal-1',
    server: server(),
    connected: true,
    write: vi.fn()
  });
  return registry;
}

function missingPathError(): Error & { code: number } {
  const error = new Error('No such file') as Error & { code: number };
  error.code = 2;
  return error;
}

// `any` keeps individually-typed vi.fn mocks assignable; tests cast the result at use sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSession(overrides: Partial<Record<keyof AgentSftpSession, any>> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    realpath: vi.fn(async (path = '.') => (path === '.' ? '/home/deploy' : path)),
    listDirectory: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: 1 })),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    writeFile: vi.fn(async () => undefined),
    statLocalFile: vi.fn(async (path: string) => ({ size: 0, isFile: true, realPath: path })),
    uploadLocalFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    createFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...overrides
  };
}

function authorizer() {
  return {
    requireWrite: vi.fn(async () => undefined),
    requireDelete: vi.fn(async () => undefined),
    requireUpload: vi.fn(async () => undefined)
  };
}

describe('SftpAgentService', () => {
  it('lists a directory using the default connected terminal', async () => {
    const session = makeSession({
      listDirectory: vi.fn(async () => [
        { name: 'app.js', path: '/home/deploy/app.js', type: 'file', size: 10, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.listDirectory({ path: '.' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      resolvedBy: 'single-connected',
      path: '/home/deploy',
      entries: [{ name: 'app.js', path: '/home/deploy/app.js', type: 'file', size: 10, modifiedAt: 1 }],
      truncated: false,
      offset: 0,
      total: 1
    });
  });

  it('truncates directory listings when entries exceed maxEntries', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `/tmp/file-${index}.txt`,
      type: 'file' as const,
      size: index,
      modifiedAt: index
    }));
    const session = makeSession({
      realpath: vi.fn(async () => '/tmp'),
      listDirectory: vi.fn(async () => entries)
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.listDirectory({ path: '/tmp', maxEntries: 5 })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      resolvedBy: 'single-connected',
      path: '/tmp',
      entries: entries.slice(0, 5),
      truncated: true,
      offset: 0,
      total: 12
    });
  });

  it('pages directory listings with offset', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `/tmp/file-${index}.txt`,
      type: 'file' as const,
      size: index,
      modifiedAt: index
    }));
    const session = makeSession({
      realpath: vi.fn(async () => '/tmp'),
      listDirectory: vi.fn(async () => entries)
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    const middle = await service.listDirectory({ path: '/tmp', maxEntries: 5, offset: 5 });
    expect(middle.entries).toEqual(entries.slice(5, 10));
    expect(middle.truncated).toBe(true);
    expect(middle.offset).toBe(5);
    expect(middle.total).toBe(12);

    const lastPage = await service.listDirectory({ path: '/tmp', maxEntries: 5, offset: 10 });
    expect(lastPage.entries).toEqual(entries.slice(10));
    expect(lastPage.truncated).toBe(false);

    const beyond = await service.listDirectory({ path: '/tmp', maxEntries: 5, offset: 50 });
    expect(beyond.entries).toEqual([]);
    expect(beyond.truncated).toBe(false);
    expect(beyond.total).toBe(12);
  });

  it('defaults maxEntries to 500 and clamps oversized requests', async () => {
    const entries = Array.from({ length: 600 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `/tmp/file-${index}.txt`,
      type: 'file' as const,
      size: 1,
      modifiedAt: 1
    }));
    const session = makeSession({
      realpath: vi.fn(async () => '/tmp'),
      listDirectory: vi.fn(async () => entries)
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    const defaulted = await service.listDirectory({ path: '/tmp' });
    expect(defaulted.truncated).toBe(true);
    expect(defaulted.total).toBe(600);
    expect(defaulted.entries).toHaveLength(500);

    const clamped = await service.listDirectory({ path: '/tmp', maxEntries: 50_000 });
    expect(clamped.entries).toHaveLength(600);
    expect(clamped.truncated).toBe(false);
    expect(clamped.total).toBe(600);
  });

  it('reads bounded UTF-8 text and reports truncation', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 123 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/home/deploy/app.txt', maxBytes: 5 })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      resolvedBy: 'single-connected',
      path: '/home/deploy/app.txt',
      content: 'hello',
      truncated: true,
      offset: 0,
      size: 11,
      modifiedAt: 123
    });
    expect(session.readFile).toHaveBeenCalledWith('/home/deploy/app.txt', 5, 0);
  });

  it('reads from a positive byte offset', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 123 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/app.txt', maxBytes: 5, offset: 6 })).resolves.toMatchObject({
      content: 'world',
      truncated: false,
      offset: 6,
      size: 11
    });
    expect(session.readFile).toHaveBeenCalledWith('/app.txt', 5, 6);
  });

  it('reads the tail of a file for a negative offset', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 123 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/app.txt', offset: -5 })).resolves.toMatchObject({
      content: 'world',
      truncated: false,
      offset: 6
    });
    // A tail larger than the file starts at byte 0 rather than failing.
    await expect(service.readFile({ path: '/app.txt', offset: -500 })).resolves.toMatchObject({
      content: 'hello world',
      offset: 0,
      truncated: false
    });
  });

  it('returns empty content when the offset is at or past the end of the file', async () => {
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 11, modifiedAt: 123 }))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/app.txt', offset: 999 })).resolves.toMatchObject({
      content: '',
      truncated: false,
      offset: 11
    });
    expect(session.readFile).not.toHaveBeenCalled();
  });

  it('rejects binary-looking file content', async () => {
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 3, modifiedAt: 1 })),
      readFile: vi.fn(async () => Buffer.from([0x61, 0x00, 0x62]))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/bin.dat' })).rejects.toThrow('Remote file appears to be binary.');
  });

  it('requires authorization and overwrite flag before writing existing files', async () => {
    const auth = authorizer();
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 }))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.writeFile({ path: '/app.txt', content: 'next' })).rejects.toThrow(
      'Remote file already exists. Pass overwrite: true to replace it.'
    );
    await expect(service.writeFile({ path: '/app.txt', content: 'next', overwrite: true })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/app.txt',
      bytesWritten: 4,
      overwritten: true
    });
    expect(auth.requireWrite).toHaveBeenCalledTimes(1);
    expect(session.writeFile).toHaveBeenCalledWith('/app.txt', Buffer.from('next', 'utf8'));
  });

  it('returns a timeout error instead of hanging when a remote write never completes', async () => {
    vi.useFakeTimers();
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 })),
      writeFile: vi.fn(() => new Promise<void>(() => undefined))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    try {
      const write = service.writeFile({ path: '/app.txt', content: 'next', overwrite: true });
      await Promise.resolve();
      await Promise.resolve();
      const expectation = expect(write).rejects.toThrow('Timed out writing remote file /app.txt.');
      await vi.advanceTimersByTimeAsync(60_000);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes new files by resolving the parent directory instead of the leaf path', async () => {
    const auth = authorizer();
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => {
        if (path === '.') {
          return '/home/deploy';
        }
        if (path === '/home/deploy') {
          return '/home/deploy';
        }
        throw new Error(`missing path: ${path}`);
      }),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.writeFile({ path: 'new.txt', content: 'hello' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/new.txt',
      bytesWritten: 5,
      overwritten: false
    });
    expect(session.realpath).not.toHaveBeenCalledWith('/home/deploy/new.txt');
    expect(session.writeFile).toHaveBeenCalledWith('/home/deploy/new.txt', Buffer.from('hello', 'utf8'));
  });

  it('does not treat stat permission errors as missing paths before writing', async () => {
    const permissionError = new Error('Permission denied');
    const auth = authorizer();
    const session = makeSession({
      stat: vi.fn(async () => {
        throw permissionError;
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.writeFile({ path: 'locked.txt', content: 'hello' })).rejects.toThrow('Permission denied');
    expect(auth.requireWrite).not.toHaveBeenCalled();
    expect(session.writeFile).not.toHaveBeenCalled();
  });

  it('tells the authorizer which directory the session started in', async () => {
    const auth = authorizer();
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => (path === '.' ? '/home/deploy/app' : path)),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await service.writeFile({ path: 'notes.txt', content: 'hello' });
    await service.createFile({ path: '/etc/cron.d/task' });
    await service.createDirectory({ path: '/var/www/html' });

    expect(auth.requireWrite).toHaveBeenNthCalledWith(1, expect.anything(), {
      operation: 'write_file',
      path: '/home/deploy/app/notes.txt',
      overwrite: false,
      workspaceRoot: '/home/deploy/app'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(2, expect.anything(), {
      operation: 'create_file',
      path: '/etc/cron.d/task',
      overwrite: false,
      workspaceRoot: '/home/deploy/app'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(3, expect.anything(), {
      operation: 'create_directory',
      path: '/var/www/html',
      overwrite: false,
      workspaceRoot: '/home/deploy/app'
    });
  });

  it('creates new directories by resolving the parent directory instead of the leaf path', async () => {
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => {
        if (path === '.' || path === '/var/tmp') {
          return path === '.' ? '/home/deploy' : '/var/tmp';
        }
        throw new Error(`missing path: ${path}`);
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.createDirectory({ path: '/var/tmp/new-dir/' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/var/tmp/new-dir'
    });
    expect(session.realpath).not.toHaveBeenCalledWith('/var/tmp/new-dir');
    expect(session.mkdir).toHaveBeenCalledWith('/var/tmp/new-dir');
  });
});

describe('SftpAgentService rename', () => {
  it('authorizes both the source and the destination before renaming', async () => {
    const auth = authorizer();
    const existing = new Set(['/home/deploy/old.txt']);
    const session = makeSession({
      stat: vi.fn(async (path: string) => {
        if (existing.has(path)) {
          return { size: 4, modifiedAt: 1 };
        }
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.rename({ path: 'old.txt', newPath: 'new.txt' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/old.txt',
      newPath: '/home/deploy/new.txt'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(1, expect.anything(), {
      operation: 'rename',
      path: '/home/deploy/old.txt',
      overwrite: false,
      workspaceRoot: '/home/deploy'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(2, expect.anything(), {
      operation: 'rename',
      path: '/home/deploy/new.txt',
      overwrite: false,
      workspaceRoot: '/home/deploy'
    });
    expect(session.rename).toHaveBeenCalledWith('/home/deploy/old.txt', '/home/deploy/new.txt');
    expect(auth.requireDelete).not.toHaveBeenCalled();
  });

  it('refuses to rename onto an existing destination', async () => {
    const auth = authorizer();
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 }))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.rename({ path: '/a.txt', newPath: '/b.txt' })).rejects.toThrow(
      'Remote destination already exists.'
    );
    expect(auth.requireWrite).not.toHaveBeenCalled();
    expect(session.rename).not.toHaveBeenCalled();
  });

  it('refuses to rename a missing source', async () => {
    const session = makeSession({
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.rename({ path: '/a.txt', newPath: '/b.txt' })).rejects.toThrow(
      'Remote source path was not found.'
    );
    expect(session.rename).not.toHaveBeenCalled();
  });
});

describe('SftpAgentService delete', () => {
  function listing(entries: SftpEntry[]) {
    return vi.fn(async () => entries);
  }

  it('deletes a file after the dedicated delete confirmation, never through requireWrite', async () => {
    const auth = authorizer();
    const session = makeSession({
      listDirectory: listing([
        { name: 'app.log', path: '/home/deploy/app.log', type: 'file', size: 10, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.deleteFile({ path: 'app.log' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/app.log',
      deleted: true
    });
    expect(auth.requireDelete).toHaveBeenCalledWith(expect.anything(), {
      operation: 'delete_file',
      path: '/home/deploy/app.log',
      overwrite: false,
      workspaceRoot: '/home/deploy'
    });
    expect(auth.requireWrite).not.toHaveBeenCalled();
    expect(session.deleteFile).toHaveBeenCalledWith('/home/deploy/app.log');
  });

  it('refuses to delete directories', async () => {
    const auth = authorizer();
    const session = makeSession({
      listDirectory: listing([
        { name: 'logs', path: '/home/deploy/logs', type: 'directory', size: 0, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.deleteFile({ path: 'logs' })).rejects.toThrow(
      'sftp_delete removes single files only. For a directory, use at_terminal_run_remote_command (it goes through the command policy and destructive warnings).'
    );
    expect(auth.requireDelete).not.toHaveBeenCalled();
    expect(session.deleteFile).not.toHaveBeenCalled();
  });

  it('refuses to delete a missing file', async () => {
    const session = makeSession({ listDirectory: listing([]) });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.deleteFile({ path: 'gone.txt' })).rejects.toThrow('Remote file was not found.');
    expect(session.deleteFile).not.toHaveBeenCalled();
  });

  it('does not delete when the user cancels the confirmation', async () => {
    const auth = authorizer();
    auth.requireDelete.mockRejectedValue(new Error('SFTP delete was cancelled.'));
    const session = makeSession({
      listDirectory: listing([
        { name: 'app.log', path: '/home/deploy/app.log', type: 'file', size: 10, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.deleteFile({ path: 'app.log' })).rejects.toThrow('SFTP delete was cancelled.');
    expect(session.deleteFile).not.toHaveBeenCalled();
  });
});

describe('SftpAgentService background sessions', () => {
  it('rejects servers that do not allow background connections when no terminal is connected', async () => {
    const createSession = vi.fn();
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: createSession as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: false })
    });

    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).rejects.toThrow(
      'does not allow background connections'
    );
    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).rejects.toThrow(
      'Allow background connections'
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('serves an authorized server without any connected UI terminal', async () => {
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => (path === '.' ? '/srv/app' : path)),
      listDirectory: vi.fn(async () => [
        { name: 'app.js', path: '/srv/app/app.js', type: 'file' as const, size: 10, modifiedAt: 1 }
      ])
    });
    const createSession = vi.fn(() => session);
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: createSession as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).resolves.toEqual({
      terminalId: undefined,
      serverId: 'server-9',
      resolvedBy: 'explicit',
      path: '/srv/app',
      entries: [{ name: 'app.js', path: '/srv/app/app.js', type: 'file', size: 10, modifiedAt: 1 }],
      truncated: false,
      offset: 0,
      total: 1
    });
    expect(createSession).toHaveBeenCalledWith({
      server: expect.objectContaining({ id: 'server-9', backgroundConnectionAllowed: true })
    });
  });

  it('reports missing servers clearly', async () => {
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: vi.fn() as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async () => undefined
    });

    await expect(service.statPath({ serverId: 'ghost', path: '/etc/hosts' })).rejects.toThrow(
      'SSH server "ghost" was not found.'
    );
  });

  it('keeps the old error when background resolution is not wired', async () => {
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: vi.fn() as never,
      authorizer: authorizer()
    });

    await expect(service.listDirectory({ serverId: 'server-9' })).rejects.toThrow(
      'No matching connected AT Terminal SSH session is available.'
    );
  });

  it('pools background sessions by server and reaps them after five idle minutes', async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession({
        realpath: vi.fn(async () => '/srv/app'),
        listDirectory: vi.fn(async () => [])
      });
      const createSession = vi.fn(() => session);
      const service = new SftpAgentService({
        terminalContext: new TerminalContextRegistry(),
        createSession: createSession as never,
        authorizer: authorizer(),
        resolveBackgroundServer: async (serverId) =>
          server(serverId, { backgroundConnectionAllowed: true })
      });

      await service.listDirectory({ serverId: 'server-9', path: '.' });
      await service.listDirectory({ serverId: 'server-9', path: '.' });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(session.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(session.dispose).toHaveBeenCalledTimes(1);

      // The next call opens a fresh session instead of reusing the reaped one.
      await service.listDirectory({ serverId: 'server-9', path: '.' });
      expect(createSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes a failed background connection and surfaces the error', async () => {
    const session = makeSession({
      connect: vi.fn(async () => {
        throw new Error('auth failed');
      })
    });
    const createSession = vi.fn(() => session);
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: createSession as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).rejects.toThrow('auth failed');
    expect(session.dispose).toHaveBeenCalled();
  });
});

describe('SftpAgentService disposal', () => {
  it('disposeTerminal drops the pooled session for a closed terminal', async () => {
    const session = makeSession();
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await service.listDirectory({ path: '.' });
    expect(session.dispose).not.toHaveBeenCalled();

    service.disposeTerminal('terminal-1');
    await Promise.resolve();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposeServer drops background and terminal sessions for that server', async () => {
    const terminalSession = makeSession();
    const backgroundSession = makeSession();
    const registry = connectedRegistry();
    let calls = 0;
    const service = new SftpAgentService({
      terminalContext: registry,
      createSession: (() => {
        calls += 1;
        return calls === 1 ? terminalSession : backgroundSession;
      }) as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await service.listDirectory({ terminalId: 'terminal-1', path: '.' });
    registry.clearIfActive('terminal-1');
    await service.listDirectory({ serverId: 'server-1', path: '.' });
    expect(calls).toBe(2);

    service.disposeServer('server-1');
    await Promise.resolve();
    expect(terminalSession.dispose).toHaveBeenCalledTimes(1);
    expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose closes every pooled session', async () => {
    const terminalSession = makeSession();
    const backgroundSession = makeSession();
    const registry = connectedRegistry();
    let calls = 0;
    const service = new SftpAgentService({
      terminalContext: registry,
      createSession: (() => {
        calls += 1;
        return calls === 1 ? terminalSession : backgroundSession;
      }) as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await service.listDirectory({ terminalId: 'terminal-1', path: '.' });
    registry.clearIfActive('terminal-1');
    await service.listDirectory({ serverId: 'server-2', path: '.' });

    service.dispose();
    await Promise.resolve();
    expect(terminalSession.dispose).toHaveBeenCalledTimes(1);
    expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('SftpAgentService audit', () => {
  it('records successful reads and refused background calls', async () => {
    const record = vi.fn();
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 1 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: false }),
      audit: { record }
    });

    await service.readFile({ path: '/app.txt', maxBytes: 5 });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'sftp_read_file',
        serverId: 'server-1',
        terminalId: 'terminal-1',
        path: '/app.txt',
        reasonCode: 'ok',
        truncated: true,
        durationMs: expect.any(Number)
      })
    );

    await expect(service.readFile({ serverId: 'server-9', path: '/x', terminalId: undefined })).rejects.toThrow();
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tool: 'sftp_read_file',
        serverId: 'server-9',
        reasonCode: 'background_denied'
      })
    );
  });
});

/**
 * A stalled SFTP channel used to be indistinguishable from an empty file.
 *
 * `readFile` returned whatever the session eventually gave it, so a channel that never
 * answered looked like a zero-byte read to the model — a wrong answer rather than a
 * retryable failure. The write paths always had a deadline; these pin the read side.
 */
describe('SftpAgentService read deadlines', () => {
  /** A promise that never settles, so only the deadline can end the call. */
  function hang(): Promise<never> {
    return new Promise<never>(() => {});
  }

  async function expectTimeout(
    call: (service: SftpAgentService) => Promise<unknown>,
    sessionOverrides: Parameters<typeof makeSession>[0],
    expectedMessage: string,
    auditTool?: string
  ) {
    vi.useFakeTimers();
    try {
      const record = vi.fn();
      const service = new SftpAgentService({
        terminalContext: connectedRegistry(),
        createSession: () => makeSession(sessionOverrides) as never,
        authorizer: authorizer(),
        audit: { record }
      });

      const pending = call(service);
      // Swallow the rejection until the assertion below owns it.
      pending.catch(() => {});
      // Let the async chain reach the timer before moving the clock.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).rejects.toThrow(expectedMessage);
      if (auditTool !== undefined) {
        // A timeout is not a generic `error`: the audit line is how an operator tells a
        // stalled connection from a permission problem.
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ tool: auditTool, reasonCode: 'read_timeout' }));
      }
    } finally {
      vi.useRealTimers();
    }
  }

  it('fails a read whose metadata never arrives', async () => {
    await expectTimeout(
      (service) => service.readFile({ path: '/home/deploy/app.js' }),
      { stat: vi.fn(hang) },
      'Timed out reading metadata for /home/deploy/app.js.',
      'sftp_read_file'
    );
  });

  it('fails a read whose content never arrives, after the metadata did', async () => {
    await expectTimeout(
      (service) => service.readFile({ path: '/home/deploy/app.js' }),
      { stat: vi.fn(async () => ({ size: 10, modifiedAt: 1 })), readFile: vi.fn(hang) },
      'Timed out reading remote file /home/deploy/app.js.',
      'sftp_read_file'
    );
  });

  it('fails a listing that never arrives', async () => {
    await expectTimeout(
      (service) => service.listDirectory({ path: '/home/deploy' }),
      { listDirectory: vi.fn(hang) },
      'Timed out listing remote directory /home/deploy.',
      'sftp_list_directory'
    );
  });

  it('fails a stat that never arrives', async () => {
    await expectTimeout(
      (service) => service.statPath({ path: '/home/deploy/app.js' }),
      { stat: vi.fn(hang) },
      'Timed out reading metadata for /home/deploy/app.js.',
      'sftp_stat_path'
    );
  });
});

/**
 * S5-04 — the same split on the file side.
 *
 * `SftpAgentService` resolved its target independently of `AgentToolService`, so the rule had to
 * be applied twice; these cases prove the second application is real rather than assumed. The
 * write case also asserts the **session was never created**: a refusal that has already opened an
 * SSH connection to the guessed host is not a refusal.
 */
describe('SftpAgentService — an unnamed target with several servers connected (S5-04)', () => {
  function multiServerRegistry(): TerminalContextRegistry {
    const registry = new TerminalContextRegistry();
    for (const id of ['server-1', 'server-2', 'server-3']) {
      registry.setActive({
        terminalId: `terminal-${id}`,
        server: server(id),
        connected: true,
        write: vi.fn()
      });
    }
    return registry;
  }

  it('refuses a write that names no server, before touching any host', async () => {
    const session = makeSession();
    const createSession = vi.fn(() => session as never);
    const service = new SftpAgentService({
      terminalContext: multiServerRegistry(),
      createSession,
      authorizer: authorizer()
    });

    await expect(service.writeFile({ path: 'app.conf', content: 'x' })).rejects.toThrow(
      /3 SSH servers are connected.*Call again with serverId.*server-1 \(server-1\).*server-3 \(server-3\)/s
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(session.writeFile).not.toHaveBeenCalled();
  });

  it('refuses a delete that names no server too — the whole write family, not just the writes', async () => {
    const service = new SftpAgentService({
      terminalContext: multiServerRegistry(),
      createSession: () => makeSession() as never,
      authorizer: authorizer()
    });

    await expect(service.deleteFile({ path: 'app.log' })).rejects.toThrow(/3 SSH servers are connected/);
  });

  it('lets a read infer, and reports the host plus every candidate', async () => {
    const session = makeSession({
      listDirectory: vi.fn(async () => [
        { name: 'app.js', path: '/home/deploy/app.js', type: 'file', size: 1, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: multiServerRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    const listing = await service.listDirectory({ path: '.' });

    expect(listing).toMatchObject({
      serverId: 'server-3',
      resolvedBy: 'implicit',
      total: 1
    });
    expect(listing.candidates?.map((candidate) => candidate.id)).toEqual(['server-1', 'server-2', 'server-3']);
  });

  it('still takes an explicit serverId with three connected', async () => {
    const service = new SftpAgentService({
      terminalContext: multiServerRegistry(),
      createSession: () => makeSession() as never,
      authorizer: authorizer()
    });

    const listing = await service.listDirectory({ serverId: 'server-1', path: '.' });

    expect(listing).toMatchObject({ serverId: 'server-1', resolvedBy: 'explicit' });
    expect(listing.candidates).toBeUndefined();
  });
});

/**
 * `~` is not a shell thing here, and saying "No such file" about it is a lie.
 *
 * S6 real run: `at_terminal_sftp_list_directory { path: "~" }` answered `Error: No such file`
 * on a directory that exists, because the SFTP subsystem does no shell expansion. A model
 * that receives that answer does not conclude "expand it yourself" — it retries with invented
 * paths. These cases pin the expansion, and pin that `~user` is *not* invented into
 * something it cannot resolve.
 */
describe('SftpAgentService — the `~` the model types', () => {
  function service(session: ReturnType<typeof makeSession>, allow = authorizer()) {
    return new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: allow
    });
  }

  it('lists the home directory for "~" instead of asking SFTP about a literal tilde', async () => {
    const session = makeSession();
    const subject = service(session);

    const listing = await subject.listDirectory({ path: '~' });

    expect(session.listDirectory).toHaveBeenCalledWith('/home/deploy');
    expect(listing.path).toBe('/home/deploy');
  });

  it('resolves "~/name" under the home directory for reads', async () => {
    // A non-empty file: with `size: 0` the service reads nothing and never opens the file.
    const session = makeSession({ stat: vi.fn(async () => ({ size: 10, modifiedAt: 1 })) });
    const subject = service(session);

    await subject.readFile({ path: '~/app.conf' });

    // First argument only: the byte window and offset that follow are the service's own
    // arithmetic, and pinning them here would make this case fail for an unrelated reason.
    expect(session.readFile.mock.calls[0]?.[0]).toBe('/home/deploy/app.conf');
  });

  it('resolves "~/name" under the home directory for writes, and authorizes that path', async () => {
    // A fresh path: `stat` must answer "missing", or the service refuses before authorizing.
    const session = makeSession({
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const allow = authorizer();
    const subject = service(session, allow);

    const result = await subject.writeFile({ path: '~/notes.txt', content: 'x' });

    expect(result.path).toBe('/home/deploy/notes.txt');
    expect(session.writeFile).toHaveBeenCalledWith('/home/deploy/notes.txt', expect.any(Buffer));
    // The authorizer sees the *expanded* path — otherwise a grant on "~/notes.txt" and a grant
    // on "/home/deploy/notes.txt" would be two different scopes for the same file.
    expect(allow.requireWrite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-1' }),
      expect.objectContaining({ path: '/home/deploy/notes.txt' })
    );
  });

  it('leaves "~user" alone — another account\'s home is a different question', async () => {
    const session = makeSession();
    const subject = service(session);

    await subject.statPath({ path: '~deploy/x' });

    // Not expanded, and not silently turned into `~/deploy/x` either: it stays one relative
    // segment under the session root, which is what it always was.
    expect(session.realpath).toHaveBeenCalledWith('/home/deploy/~deploy/x');
  });
});

/**
 * The local-source write.
 *
 * `sftp_write_file` accepted only `content`, so a 7.3 MB binary had to be base64'd through the
 * model's context — 10.26 MB of string, about 2.5M tokens, i.e. a call that cannot happen. The
 * fix is a `localPath` source the Host reads and streams. What these cases pin is that the bytes
 * never travel as a string, that the local checks run before anyone is asked to approve anything,
 * and that an upload goes through `requireUpload` rather than borrowing a write grant.
 */
describe('SftpAgentService local file upload', () => {
  const LOCAL_SOURCE = '/Users/clkj/dist/at-pc-server';
  const REMOTE_TARGET = '/opt/at-pc/at-pc-server';

  function uploadService(session: ReturnType<typeof makeSession>, auth = authorizer()) {
    return {
      auth,
      service: new SftpAgentService({
        terminalContext: connectedRegistry(),
        createSession: () => session as never,
        authorizer: auth
      })
    };
  }

  it('streams the local file instead of writing it as content', async () => {
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 7_692_224, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const { service, auth } = uploadService(session);

    await expect(service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: REMOTE_TARGET,
      bytesWritten: 7_692_224,
      overwritten: false,
      localPath: LOCAL_SOURCE
    });

    expect(session.statLocalFile).toHaveBeenCalledWith(LOCAL_SOURCE);
    expect(session.uploadLocalFile).toHaveBeenCalledWith(LOCAL_SOURCE, REMOTE_TARGET, {
      overwrite: false
    });
    // The whole point: no Buffer, no string, no copy in this process that holds the payload.
    expect(session.writeFile).not.toHaveBeenCalled();
    expect(auth.requireWrite).not.toHaveBeenCalled();
  });

  it('uploads the resolved file, so a symlink cannot hide what is being sent', async () => {
    const REAL_SOURCE = '/Users/clkj/.ssh/id_rsa';
    const record = vi.fn();
    const session = makeSession({
      // A symlink called payload.bin pointing at a private key: the name says nothing, the
      // real path says everything.
      statLocalFile: vi.fn(async () => ({ size: 1_675, isFile: true, realPath: REAL_SOURCE })),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const auth = authorizer();
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth,
      audit: { record }
    });

    const result = await service.writeFile({ path: REMOTE_TARGET, localPath: '/tmp/payload.bin' });

    expect(result.localPath).toBe(REAL_SOURCE);
    // Authorization, transfer, result and audit row all name the file that actually moves —
    // otherwise the sensitive-local double check would be looking at a name, not the key.
    expect(auth.requireUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ localPath: REAL_SOURCE })
    );
    expect(session.uploadLocalFile).toHaveBeenCalledWith(REAL_SOURCE, REMOTE_TARGET, {
      overwrite: false
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ command: `upload ${REAL_SOURCE} -> ${REMOTE_TARGET}` })
    );
  });

  it('tells the authorizer which local file, how big, and to where', async () => {
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 7_692_224, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const { service, auth } = uploadService(session);

    await service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE, overwrite: true });

    expect(auth.requireUpload).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }), {
      operation: 'upload_local_file',
      path: REMOTE_TARGET,
      overwrite: false,
      workspaceRoot: '/home/deploy',
      localPath: LOCAL_SOURCE,
      localBytes: 7_692_224
    });
  });

  it('refuses a missing local source before touching the remote or asking anyone', async () => {
    const session = makeSession({
      statLocalFile: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const { service, auth } = uploadService(session);

    await expect(
      service.writeFile({ path: REMOTE_TARGET, localPath: '/Users/clkj/dist/typo' })
    ).rejects.toThrow('Local file was not found: /Users/clkj/dist/typo');
    expect(session.stat).not.toHaveBeenCalled();
    expect(auth.requireUpload).not.toHaveBeenCalled();
    expect(session.uploadLocalFile).not.toHaveBeenCalled();
  });

  it('refuses a directory as the source', async () => {
    const session = makeSession({ statLocalFile: vi.fn(async (path: string) => ({ size: 4_096, isFile: false, realPath: path })) });
    const { service, auth } = uploadService(session);

    await expect(
      service.writeFile({ path: REMOTE_TARGET, localPath: '/Users/clkj/dist' })
    ).rejects.toThrow('Local path is not a regular file: /Users/clkj/dist');
    expect(auth.requireUpload).not.toHaveBeenCalled();
  });

  it('refuses a source above the upload ceiling', async () => {
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: MAX_LOCAL_UPLOAD_BYTES + 1, isFile: true, realPath: path }))
    });
    const { service, auth } = uploadService(session);

    await expect(
      service.writeFile({ path: REMOTE_TARGET, localPath: '/Users/clkj/disk-image.raw' })
    ).rejects.toThrow(
      /Local file is too large to upload: .*; the limit is 1 GB and the upload deadline is 300 s\./
    );
    expect(auth.requireUpload).not.toHaveBeenCalled();
    expect(session.uploadLocalFile).not.toHaveBeenCalled();
  });

  it('requires exactly one source', async () => {
    const session = makeSession();
    const { service } = uploadService(session);

    await expect(
      service.writeFile({ path: REMOTE_TARGET, content: 'x', localPath: LOCAL_SOURCE })
    ).rejects.toThrow('Pass either content or localPath, not both.');
    await expect(service.writeFile({ path: REMOTE_TARGET })).rejects.toThrow(
      'Provide either content (inline text) or localPath (a file on this machine).'
    );
    await expect(service.writeFile({ path: REMOTE_TARGET, localPath: '  ' })).rejects.toThrow(
      'Local path cannot be empty.'
    );
    expect(session.statLocalFile).not.toHaveBeenCalled();
    expect(session.writeFile).not.toHaveBeenCalled();
    expect(session.uploadLocalFile).not.toHaveBeenCalled();
  });

  it('still refuses to replace an existing remote file without the overwrite flag', async () => {
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 10, isFile: true, realPath: path })),
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 }))
    });
    const { service, auth } = uploadService(session);

    await expect(service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE })).rejects.toThrow(
      'Remote file already exists. Pass overwrite: true to replace it.'
    );
    expect(auth.requireUpload).not.toHaveBeenCalled();
    expect(session.uploadLocalFile).not.toHaveBeenCalled();

    await expect(
      service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE, overwrite: true })
    ).resolves.toMatchObject({ bytesWritten: 10, overwritten: true });
    expect(auth.requireUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ overwrite: true })
    );
    expect(session.uploadLocalFile).toHaveBeenCalledWith(LOCAL_SOURCE, REMOTE_TARGET, {
      overwrite: true
    });
  });

  it('refuses a remote file that appeared while the dialog was open', async () => {
    // The exists check said "missing" and the dialog said "Overwrite: no"; by the time the
    // transfer starts something is there. The port carries the flag through, `uploadFile`
    // re-checks, and the conflict is translated instead of clobbering the file.
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 10, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      }),
      uploadLocalFile: vi.fn(async () => {
        const conflict = new Error('Remote path already exists: ' + REMOTE_TARGET) as Error & {
          name: string;
          path: string;
        };
        conflict.name = 'SftpConflictError';
        conflict.path = REMOTE_TARGET;
        throw conflict;
      })
    });
    const { service } = uploadService(session);

    await expect(service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE })).rejects.toThrow(
      'Remote file already exists. Pass overwrite: true to replace it.'
    );
  });

  it('sends the observed existence to the transfer, not the caller overwrite permission', async () => {
    // The dialog was built from `exists === false` ("Overwrite: no"), so the transfer has to be
    // told the same thing even though the caller passed overwrite: true. Passing the permission
    // instead would disable `uploadFile`'s re-check and a file that appeared in between would be
    // replaced with no conflict raised.
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 10, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const { service } = uploadService(session);

    await service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE, overwrite: true });

    expect(session.uploadLocalFile).toHaveBeenCalledWith(LOCAL_SOURCE, REMOTE_TARGET, {
      overwrite: false
    });
  });

  it('forwards upload progress to the caller', async () => {
    const seen: Array<[number, number]> = [];
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 100, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      }),
      uploadLocalFile: vi.fn(
        async (
          _local: string,
          _remote: string,
          options: { overwrite: boolean; progress?: TransferProgress }
        ) => {
          options.progress?.report({ transferredBytes: 40, totalBytes: 100 });
          options.progress?.report({ transferredBytes: 100, totalBytes: 100 });
        }
      )
    });
    const { service } = uploadService(session);

    await service.writeFile({
      path: REMOTE_TARGET,
      localPath: LOCAL_SOURCE,
      onProgress: (transferredBytes, totalBytes) => seen.push([transferredBytes, totalBytes])
    });

    expect(seen).toEqual([
      [40, 100],
      [100, 100]
    ]);
  });

  it('does not upload when the user cancels the confirmation', async () => {
    const auth = authorizer();
    auth.requireUpload.mockRejectedValue(new Error('SFTP upload was cancelled.'));
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 10, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const { service } = uploadService(session, auth);

    await expect(service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE })).rejects.toThrow(
      'SFTP upload was cancelled.'
    );
    expect(session.uploadLocalFile).not.toHaveBeenCalled();
  });

  it('aborts a stalled upload, drops its session, and says the remote file may be incomplete', async () => {
    vi.useFakeTimers();
    let rejectTransfer: (error: Error) => void = () => undefined;
    const transfer = new Promise<void>((_resolve, reject) => {
      rejectTransfer = reject;
    });
    try {
      const record = vi.fn();
      const session = makeSession({
        statLocalFile: vi.fn(async (path: string) => ({ size: 100, isFile: true, realPath: path })),
        stat: vi.fn(async () => {
          throw missingPathError();
        }),
        uploadLocalFile: vi.fn(() => transfer)
      });
      const createSession = vi.fn(() => session);
      const service = new SftpAgentService({
        terminalContext: connectedRegistry(),
        createSession: createSession as never,
        authorizer: authorizer(),
        audit: { record }
      });

      const upload = service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE });
      upload.catch(() => {});
      // Let the async chain reach the transfer before moving the clock.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(300_000);

      await expect(upload).rejects.toThrow(
        `Timed out uploading ${LOCAL_SOURCE} to ${REMOTE_TARGET} after 300 s; ` +
          'the transfer was aborted and the remote file may be incomplete.'
      );
      // Closing the pooled connection *is* the abort — ssh2's fastPut has no cancel — so the
      // session is gone and the next call opens a fresh one instead of writing on a dead channel.
      await vi.advanceTimersByTimeAsync(0);
      expect(session.dispose).toHaveBeenCalledTimes(1);
      await service.listDirectory({ path: '.' });
      expect(createSession).toHaveBeenCalledTimes(2);

      // A slow link is not a permission problem and not a bug: the audit line has to be able
      // to say so without the operator reading the tool result.
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'sftp_write_file', reasonCode: 'upload_timeout' })
      );
    } finally {
      vi.useRealTimers();
    }
    // The transfer the deadline walked away from rejects when the abort closes the connection.
    // Nothing awaits it any more, so if the deadline path ever stops handling that rejection it
    // surfaces as an unhandled rejection — which vitest reports as a failure.
    rejectTransfer(new Error('SFTP connection is not available.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('evicts a background session when its upload times out', async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession({
        realpath: vi.fn(async () => '/srv/app'),
        statLocalFile: vi.fn(async (path: string) => ({ size: 100, isFile: true, realPath: path })),
        stat: vi.fn(async () => {
          throw missingPathError();
        }),
        uploadLocalFile: vi.fn(() => new Promise<void>(() => undefined))
      });
      const service = new SftpAgentService({
        terminalContext: new TerminalContextRegistry(),
        createSession: () => session as never,
        authorizer: authorizer(),
        resolveBackgroundServer: async (serverId) =>
          server(serverId, { backgroundConnectionAllowed: true })
      });

      const upload = service.writeFile({ serverId: 'server-9', path: 'bin', localPath: LOCAL_SOURCE });
      upload.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(300_000);

      await expect(upload).rejects.toThrow('the transfer was aborted');
      expect(session.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records where the uploaded file came from in the durable audit row', async () => {
    const record = vi.fn();
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 10, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer(),
      audit: { record }
    });

    await service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE });

    // `path` alone would say a file appeared on the server and nothing about where it came
    // from; the local end is the half that has to survive in agent-audit.jsonl.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'sftp_write_file',
        path: REMOTE_TARGET,
        command: `upload ${LOCAL_SOURCE} -> ${REMOTE_TARGET}`,
        reasonCode: 'ok'
      })
    );
  });

  it('gives each local pre-flight failure its own audit reason', async () => {
    const cases: Array<{
      override: Parameters<typeof makeSession>[0];
      localPath: string;
      reasonCode: string;
    }> = [
      {
        override: {
          statLocalFile: vi.fn(async () => {
            throw missingPathError();
          })
        },
        localPath: '/tmp/nope',
        reasonCode: 'local_not_found'
      },
      {
        override: {
          statLocalFile: vi.fn(async (path: string) => ({ size: 10, isFile: false, realPath: path }))
        },
        localPath: '/tmp/some-directory',
        reasonCode: 'local_not_regular_file'
      },
      {
        override: {
          statLocalFile: vi.fn(async (path: string) => ({
            size: MAX_LOCAL_UPLOAD_BYTES + 1,
            isFile: true,
            realPath: path
          }))
        },
        localPath: '/tmp/disk-image.raw',
        reasonCode: 'local_too_large'
      }
    ];

    for (const testCase of cases) {
      const record = vi.fn();
      const service = new SftpAgentService({
        terminalContext: connectedRegistry(),
        createSession: () => makeSession(testCase.override) as never,
        authorizer: authorizer(),
        audit: { record }
      });

      await expect(
        service.writeFile({ path: REMOTE_TARGET, localPath: testCase.localPath })
      ).rejects.toThrow();
      // A mistyped path, a directory and an oversized file are three different operator
      // mistakes; "error" for all of them makes the audit trail unreadable.
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ reasonCode: testCase.reasonCode })
      );
    }
  });

  it('names the local source in a refused upload row too', async () => {
    const record = vi.fn();    const auth = authorizer();
    auth.requireUpload.mockRejectedValue(new Error('SFTP upload was cancelled.'));
    const session = makeSession({
      statLocalFile: vi.fn(async (path: string) => ({ size: 10, isFile: true, realPath: path })),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth,
      audit: { record }
    });

    await expect(service.writeFile({ path: REMOTE_TARGET, localPath: LOCAL_SOURCE })).rejects.toThrow(
      'SFTP upload was cancelled.'
    );

    // "The agent tried to send this file and the user said no" is the row an incident review
    // looks for, and this is the only place the attempt is recorded.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'user_cancelled',
        command: `upload ${LOCAL_SOURCE} -> ${REMOTE_TARGET}`
      })
    );
  });

  it('leaves the text-write audit row without a command', async () => {
    const record = vi.fn();
    const session = makeSession({
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer(),
      audit: { record }
    });

    await service.writeFile({ path: REMOTE_TARGET, content: 'next' });

    const [row] = record.mock.calls[0];
    expect(row.path).toBe(REMOTE_TARGET);
    expect(row.command).toBeUndefined();
  });
});
