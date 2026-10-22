import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshSession, type SshSessionStatus } from '../../src/ssh/SshSession';
import type { ServerConfig } from '../../src/config/schema';

/**
 * `idleDisconnectMinutes` was a settings field with no consumer: it reached
 * `TerminalSettings` and stopped, so the form offered a timeout the session never applied.
 * These cases pin the behaviour the field always claimed — and the one it must *not* have,
 * because counting only keystrokes would kill `tail -f` after the configured hour.
 */

type MockShell = EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  setWindow: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  disposeHandle: vi.fn(),
  connect: vi.fn(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  }),
  end: vi.fn(),
  shells: [] as unknown[]
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com', port: 22 },
    dispose: mocks.disposeHandle
  }))
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const shell = new EventEmitter() as MockShell;
    shell.end = vi.fn();
    shell.write = vi.fn();
    shell.setWindow = vi.fn();
    shell.pause = vi.fn();
    shell.resume = vi.fn();
    mocks.shells.push(shell);
    const client = {
      handlers: {} as Record<string, (...args: never[]) => void>,
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        client.handlers[event] = handler;
        return client;
      }),
      once: vi.fn((event: string, handler: (...args: never[]) => void) => {
        client.handlers[event] = handler;
        return client;
      }),
      connect: mocks.connect,
      end: mocks.end,
      shell: vi.fn((_options, _extraOptions, callback) => callback(undefined, shell))
    };
    return client;
  })
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

function latestShell(): MockShell {
  return mocks.shells[mocks.shells.length - 1] as MockShell;
}

async function connectWith(idleDisconnectMinutes: number) {
  const statuses: SshSessionStatus[] = [];
  const session = new SshSession(
    server(),
    { getPassword: async () => 'secret' } as never,
    { output: vi.fn(), status: (status) => statuses.push(status), error: vi.fn() },
    { verify: async () => true } as never,
    undefined,
    { idleDisconnectMinutes }
  );
  await session.connect();
  return { session, statuses };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.disposeHandle.mockClear();
  mocks.connect.mockClear();
  mocks.end.mockClear();
  mocks.shells.length = 0;
  mocks.connect.mockImplementation(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SshSession idle disconnect', () => {
  it('disconnects a silent session and says why, instead of going blank', async () => {
    const { session, statuses } = await connectWith(1);
    expect(statuses.at(-1)?.state).toBe('connected');

    // One minute of nothing, then the next tick past the deadline.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(statuses.at(-1)).toEqual({
      state: 'disconnected',
      text: 'Disconnected after 1 min of inactivity'
    });
    expect(session.isConnected()).toBe(false);
    // The session is really torn down, not just relabelled: a live ssh2 client holding the
    // connection would make the disconnect cosmetic.
    expect(latestShell().end).toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalled();
  });

  it('keeps a session alive that is still producing output', async () => {
    const { session, statuses } = await connectWith(1);

    // A `tail -f`: nothing typed, but bytes keep arriving. Counting input alone would kill
    // this every hour, which is the failure mode the field's description does not mention.
    await vi.advanceTimersByTimeAsync(50_000);
    latestShell().emit('data', Buffer.from('a line of log'));
    await vi.advanceTimersByTimeAsync(50_000);
    latestShell().emit('data', Buffer.from('another line'));
    await vi.advanceTimersByTimeAsync(50_000);

    expect(session.isConnected()).toBe(true);
    expect(statuses.at(-1)?.state).toBe('connected');
  });

  it('treats a keystroke as activity too, even when the remote side is silent', async () => {
    const { session } = await connectWith(1);

    await vi.advanceTimersByTimeAsync(50_000);
    session.write('l');
    await vi.advanceTimersByTimeAsync(50_000);

    expect(session.isConnected()).toBe(true);
  });

  it('disables the timeout when the setting is 0, and arms no timer at all', async () => {
    const { session, statuses } = await connectWith(0);

    await vi.advanceTimersByTimeAsync(10 * 60 * 60 * 1000);

    expect(session.isConnected()).toBe(true);
    expect(statuses.at(-1)?.state).toBe('connected');
    // Not "the timer ran and decided not to fire": there is no timer. A disabled timeout
    // that still ticks is a timer per session for nothing.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the timer when the session is disposed, so nothing outlives it', async () => {
    const { session } = await connectWith(1);
    session.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
