import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import type { ServerConfig } from '../../src/config/schema';
import { buildSshConnectionHandle } from '../../src/ssh/SshConnectionConfig';

const connect = vi.fn();
const end = vi.fn();
const exec = vi.fn();
const disposeHandle = vi.fn();
const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  connect = connect;
  end = end;
  exec = exec;
}

vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  })
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com' },
    dispose: disposeHandle
  }))
}));

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function createExecStream() {
  const stream = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    close(): void;
  };
  stream.stderr = new EventEmitter();
  stream.close = vi.fn();
  return stream;
}

/**
 * Microtask-only so it works under fake timers. Enough turns to let the executor walk
 * from `execute` through connection acquisition to `client.exec`.
 */
async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

const hostKeyVerifier = { verify: async () => true };

beforeEach(() => {
  vi.useRealTimers();
  connect.mockReset();
  end.mockReset();
  exec.mockReset();
  disposeHandle.mockReset();
  vi.mocked(buildSshConnectionHandle).mockClear();
  clients.length = 0;
});

describe('RemoteCommandExecutor', () => {
  it('executes a remote command and returns structured output', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promise = executor.execute(server(), {
      command: 'uname -a',
      timeoutMs: 5_000,
      maxOutputBytes: 1024
    });

    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    stream.emit('data', Buffer.from('Linux\n'));
    stream.stderr.emit('data', Buffer.from('warn\n'));
    stream.emit('close', 0, undefined);

    await expect(promise).resolves.toMatchObject({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'example.com',
      command: 'uname -a',
      exitCode: 0,
      signal: undefined,
      stdout: 'Linux\n',
      stderr: 'warn\n',
      timedOut: false,
      truncated: false
    });
    // The connection outlives the command so the next one can reuse it.
    expect(end).not.toHaveBeenCalled();
    expect(disposeHandle).not.toHaveBeenCalled();
  });

  it('wraps cwd with a POSIX cd before command execution', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promise = executor.execute(server(), {
      command: 'npm test',
      cwd: '/var/www/my app',
      timeoutMs: 5_000,
      maxOutputBytes: 1024
    });

    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    stream.emit('close', 0, undefined);
    await promise;

    expect(exec).toHaveBeenCalledWith("cd '/var/www/my app' && npm test", expect.any(Function));
  });

  it('times out long-running commands and closes the stream', async () => {
    vi.useFakeTimers();
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promise = executor.execute(server(), {
      command: 'sleep 60',
      timeoutMs: 100,
      maxOutputBytes: 1024
    });

    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    vi.advanceTimersByTime(100);

    // A timeout is a failure, not a result: it used to resolve with `exitCode: null`, which every
    // `exitCode`-branching caller reads as "the command ran and was signal-killed".
    await expect(promise).rejects.toThrow('Command timed out after 100ms.');
    await expect(promise).rejects.toMatchObject({ timeoutMs: 100 });
    expect(stream.close).toHaveBeenCalledTimes(1);
    // A command that overran closes its own channel; the connection is still good.
    expect(end).not.toHaveBeenCalled();
  });

  it('keeps captured stderr when a command times out instead of replacing it', async () => {
    vi.useFakeTimers();
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promise = executor.execute(server(), {
      command: 'systemctl restart app',
      timeoutMs: 100,
      maxOutputBytes: 1024
    });

    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    stream.stderr.emit('data', Buffer.from('Job for app.service failed.\n'));
    stream.emit('data', Buffer.from('partial stdout'));
    vi.advanceTimersByTime(100);

    // The captured output is not thrown away with the rejection: it is on the error.
    await expect(promise).rejects.toMatchObject({
      message: 'Command timed out after 100ms.',
      stdout: 'partial stdout',
      stderr: 'Job for app.service failed.\n'
    });
  });

  it('truncates stdout and stderr independently', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promise = executor.execute(server(), {
      command: 'cat big.log',
      timeoutMs: 5_000,
      maxOutputBytes: 4
    });

    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    stream.emit('data', Buffer.from('abcdef'));
    stream.stderr.emit('data', Buffer.from('uvwxyz'));
    stream.emit('close', 0, undefined);

    await expect(promise).resolves.toMatchObject({
      stdout: 'abcd',
      stderr: 'uvwx',
      truncated: true
    });
  });
});

describe('RemoteCommandExecutor connection pool', () => {
  async function runCommand(
    executor: RemoteCommandExecutor,
    command: string,
    onReady?: () => void
  ): Promise<void> {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const promise = executor.execute(server(), { command, timeoutMs: 5_000, maxOutputBytes: 1024 });
    await flushPromises();
    onReady?.();
    await flushPromises();
    stream.emit('close', 0, undefined);
    await promise;
  }

  it('reuses one SSH connection for consecutive commands on the same server', async () => {
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    await runCommand(executor, 'pwd', () => clients[0].emit('ready'));
    await runCommand(executor, 'whoami');

    expect(clients).toHaveLength(1);
    expect(vi.mocked(buildSshConnectionHandle)).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('keeps a separate connection per server', async () => {
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);
    const other = { ...server(), id: 'server-2', host: 'other.example.com' };

    await runCommand(executor, 'pwd', () => clients[0].emit('ready'));
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const promise = executor.execute(other, { command: 'pwd', timeoutMs: 5_000, maxOutputBytes: 1024 });
    await flushPromises();
    clients[1].emit('ready');
    await flushPromises();
    stream.emit('close', 0, undefined);
    await promise;
    await runCommand(executor, 'whoami');

    expect(clients).toHaveLength(2);
  });

  it('opens a fresh connection after the pooled one drops', async () => {
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    await runCommand(executor, 'pwd', () => clients[0].emit('ready'));
    clients[0].emit('close');
    await runCommand(executor, 'whoami', () => clients[1].emit('ready'));
    await runCommand(executor, 'uptime');

    expect(clients).toHaveLength(2);
    expect(vi.mocked(buildSshConnectionHandle)).toHaveBeenCalledTimes(2);
  });

  it('shares one connection between concurrent commands on the same server', async () => {
    const first = createExecStream();
    const second = createExecStream();
    const pending = [first, second];
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, pending.shift()));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promises = [
      executor.execute(server(), { command: 'pwd', timeoutMs: 5_000, maxOutputBytes: 1024 }),
      executor.execute(server(), { command: 'whoami', timeoutMs: 5_000, maxOutputBytes: 1024 })
    ];
    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    first.emit('close', 0, undefined);
    second.emit('close', 0, undefined);
    await Promise.all(promises);

    expect(clients).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('closes a pooled connection once it has sat idle', async () => {
    vi.useFakeTimers();
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    await runCommand(executor, 'pwd', () => clients[0].emit('ready'));
    expect(end).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60_000);

    expect(end).toHaveBeenCalledTimes(1);
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });

  it('applies the caller timeout to a connection that never becomes ready', async () => {
    vi.useFakeTimers();
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promise = executor.execute(server(), { command: 'pwd', timeoutMs: 100, maxOutputBytes: 1024 });
    await flushPromises();
    vi.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow('Command timed out after 100ms.');
    expect(exec).not.toHaveBeenCalled();
  });

  it('closes pooled connections on dispose so deactivate leaves nothing dangling', async () => {
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    await runCommand(executor, 'pwd', () => clients[0].emit('ready'));
    expect(end).not.toHaveBeenCalled();

    executor.dispose();

    expect(end).toHaveBeenCalledTimes(1);
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately without connecting when signal is pre-aborted', async () => {
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      executor.execute(server(), {
        command: 'pwd',
        signal: abortController.signal
      })
    ).rejects.toThrow('Remote command was aborted.');
    expect(connect).not.toHaveBeenCalled();
  });

  it('aborts mid-flight execution and closes stream when signal triggers', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);
    const abortController = new AbortController();

    const promise = executor.execute(server(), {
      command: 'sleep 10',
      signal: abortController.signal
    });

    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();

    abortController.abort();

    await expect(promise).rejects.toThrow('Remote command was aborted.');
    expect(stream.close).toHaveBeenCalled();
  });

  it('treats timeoutMs 0 as no deadline at all, so a background command is not killed', async () => {
    // `0` is how the background path says "the job owns the lifetime". Reading it through
    // the same clamp that turns `undefined` into 30 s would silently cap every background
    // command at half a minute — the exact defect the task exists to remove.
    vi.useFakeTimers();
    try {
      const stream = createExecStream();
      exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
      const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

      const promise = executor.execute(server(), { command: 'sleep 3600', timeoutMs: 0 });
      await flushPromises();
      clients[0].emit('ready');
      await flushPromises();

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // Ten minutes in, the deadline that would have fired twice is not there.
      expect(stream.close).not.toHaveBeenCalled();

      stream.emit('close', 0, undefined);
      await expect(promise).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('streams decoded output as it arrives and stitches a character split across reads', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const chunks: Array<{ channel: string; text: string }> = [];
    const promise = executor.execute(server(), {
      command: 'printf …',
      onOutput: (chunk) => chunks.push(chunk)
    });

    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();

    // A three-byte character delivered as 2 + 1: without a streaming decoder this becomes
    // two replacement characters, and nobody reading the job's ring would know why.
    const ellipsis = Buffer.from('…', 'utf8');
    stream.emit('data', ellipsis.subarray(0, 2));
    stream.emit('data', ellipsis.subarray(2));
    stream.stderr.emit('data', Buffer.from('oops\n'));
    stream.emit('close', 0, undefined);

    const result = await promise;
    expect(chunks).toEqual([
      { channel: 'stdout', text: '…' },
      { channel: 'stderr', text: 'oops\n' }
    ]);
    // The buffered result is unchanged: the hook is in addition to it, not instead of it.
    expect(result.stdout).toBe('…');
    expect(result.stderr).toBe('oops\n');
  });
});

