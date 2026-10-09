import { describe, expect, it, vi } from 'vitest';

/**
 * A crash that took the whole IDE down, reproduced.
 *
 * `~/Library/Logs/DeepSeek Harness/crash-2026-10-07T05-30-05-568Z-host.log`:
 *
 * ```text
 * dsh: fatal uncaught exception: Error: Connection lost before handshake
 *     at makeError (ssh2/lib/protocol/utils.js:142:15)
 *     at ssh2/lib/client.js:753:13
 *   { level: 'protocol', fatal: true }
 * ```
 *
 * ssh2 emits `'error'` again when the socket closes before the handshake completed, and a
 * Node `EventEmitter` **throws** on an `'error'` that has no listener. Both SSH paths used
 * `client.once('error', reject)`, which is consumed by the *first* error — so every error
 * after the connect settled had nobody to land on and escalated into an uncaught exception
 * in the dsh host process.
 *
 * The mock here is a real `EventEmitter` rather than the single-slot stub the neighbouring
 * suite uses, because the whole point is what happens when a **second** `'error'` fires
 * after the first listener has been consumed — a stub that keeps one handler per event name
 * cannot represent that at all.
 */
const clients = vi.hoisted(() => [] as Array<{ emitCount(event: string): number }>);

vi.mock('ssh2', () => {
  // Built lazily inside the factory: `EventEmitter` must come from the mocked module's
  // world, and vitest hoists this call above the imports. Typed as an instance because
  // the class value is only in scope inside this factory.
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  type Emitter = InstanceType<typeof EventEmitter>;
  return {
    Client: vi.fn(() => {
      const client = new EventEmitter() as Emitter & {
        connect: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        forwardOut: ReturnType<typeof vi.fn>;
        shell: ReturnType<typeof vi.fn>;
        emitCount(event: string): number;
      };
      client.connect = vi.fn((config: { host?: string }) => {
        // Reproduce the crash sequence: the handshake starts, the socket dies before the
        // banner arrives, and ssh2 emits `error` **twice** — the second one is the killer.
        void config;
        setImmediate(() => {
          client.emit('error', Object.assign(new Error('Connection lost before handshake'), { level: 'protocol', fatal: true }));
          client.emit('error', Object.assign(new Error('Connection lost before handshake'), { level: 'protocol', fatal: true }));
        });
      });
      client.end = vi.fn();
      client.forwardOut = vi.fn();
      client.shell = vi.fn();
      client.emitCount = (event: string) => client.listenerCount(event as never);
      clients.push(client);
      return client;
    })
  };
});

import { SshSession } from '../../src/ssh/SshSession';
import { buildSshConnectionHandle } from '../../src/ssh/SshConnectionConfig';
import type { ServerConfig } from '../../src/config/schema';

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
    host: '10.0.133.11',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

/** An error that would be thrown by a bare `EventEmitter` — the crash, reproduced. */
function emitUnguarded(client: { emit(event: string, error: unknown): boolean }): boolean {
  return client.emit('error', new Error('Connection lost before handshake'));
}

describe('ssh2 client error handling — the fatal-error crash', () => {
  it('keeps a permanent error listener on the session client after connect fails', async () => {
    clients.length = 0;
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true }
    );

    // The connect itself fails (the mocked client never reaches `ready`).
    await expect(session.connect()).rejects.toBeDefined();

    const client = clients.at(-1);
    expect(client).toBeDefined();
    // The guard is `on`, so it survives the `once('error', reject)` above it being consumed.
    // A second `error` therefore lands on the guard instead of throwing.
    expect(client?.emitCount('error')).toBeGreaterThan(0);
    expect(() => emitUnguarded(client as never)).not.toThrow();
  });

  it('keeps a permanent error listener on the jump-host client for its whole life', async () => {
    clients.length = 0;
    const handle = await buildSshConnectionHandle(
      server({ jumpHostId: 'bastion-1' }),
      {
        getPassword: async () => 'secret',
        getServer: async (id: string) =>
          id === 'bastion-1' ? server({ id, host: '18.199.246.45', jumpHostId: undefined }) : undefined
      },
      { verify: async () => true }
    ).catch(() => undefined);

    // The jump client is created before the target connect, so it is the first one pushed.
    const jump = clients.at(0);
    expect(jump).toBeDefined();
    expect(jump?.emitCount('error')).toBeGreaterThan(0);
    // `dispose()` ends the jump client; a host hanging up during teardown must not throw.
    expect(() => emitUnguarded(jump as never)).not.toThrow();
    handle?.dispose();
  });
});
