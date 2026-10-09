import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config/schema';
import {
  AT_TERMINAL_STATE_DOMAIN,
  AT_TERMINAL_STATE_TABLE,
  AT_TERMINAL_STATE_VERSION,
  createStateDomainSpec,
  openDshStateStore,
  parseJsonRecord
} from '../../../src/platform/dsh/state';
import { RecordingDshLogger, MemoryStorageDomain, FakeDomainError } from './host-fakes';

/**
 * DSH-14 — `context.globalState` → `ctx.storageDomain`.
 *
 * The assertions that carry weight here are the ones about what happens on the
 * boundaries: what the medium holds after a write, what a *reopen* loads, and what
 * an unusable record does to `open()` (abort, not degrade). A test that only proved
 * "set then get" would pass against a `Map`, which is exactly what must not be
 * mistaken for this node being done.
 */

async function open(domain = new MemoryStorageDomain()) {
  const logger = new RecordingDshLogger();
  const handle = await openDshStateStore({ storageDomain: domain, logger });
  return { domain, logger, handle };
}

/**
 * The host's failures carry a machine-readable `code` alongside a human message, and
 * the two say different things (`DomainError('already-open', "domain 'x' is already
 * open")`). Assertions name the code, so they cannot end up matching prose.
 */
async function rejection(run: () => Promise<unknown>): Promise<FakeDomainError> {
  try {
    await run();
  } catch (error) {
    return error as FakeDomainError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('DSH-14 state domain declaration', () => {
  it('uses names the host grammar accepts', () => {
    // `defineDomain` throws on anything outside these grammars at module load.
    expect(AT_TERMINAL_STATE_DOMAIN).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(AT_TERMINAL_STATE_TABLE).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(Number.isInteger(AT_TERMINAL_STATE_VERSION)).toBe(true);
    expect(AT_TERMINAL_STATE_VERSION).toBeGreaterThanOrEqual(0);
  });

  it('declares exactly one table and no global', () => {
    const spec = createStateDomainSpec();
    // No global: a global schema that accepts `null` is rejected by `defineDomain`, and
    // this plugin has no unit-wide value to persist. Checked structurally because the
    // contract deliberately does not model `global` — this plugin never declares one.
    expect(Object.keys(spec.tables)).toEqual([AT_TERMINAL_STATE_TABLE]);
    expect('global' in spec).toBe(false);
    // No `layout`: the default `single` keeps record keys inside one document rather
    // than turning them into path segments, which is what lets the memento keys
    // (`sshManager.servers`) pass through unescaped.
    expect(spec.layout).toBeUndefined();
  });
});

describe('DSH-14 parseJsonRecord', () => {
  it('returns the round-tripped value, not the input', () => {
    const input = { a: [1, 2, { b: 'c' }] };
    const parsed = parseJsonRecord(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  it('rejects undefined, pointing at the real delete path', () => {
    expect(() => parseJsonRecord(undefined)).toThrow(/undefined/);
  });

  it.each([
    ['a function', () => undefined],
    ['a symbol', Symbol('x')],
    ['a BigInt', 1n]
  ])('rejects %s', (_label, value) => {
    expect(() => parseJsonRecord(value)).toThrow(/JSON-serializable/);
  });

  it('rejects a cyclic object', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseJsonRecord(cyclic)).toThrow(/JSON-serializable/);
  });
});

describe('DSH-14 openDshStateStore', () => {
  it('opens the declared domain and table', async () => {
    const { domain, handle } = await open();

    expect(domain.openCalls).toEqual([AT_TERMINAL_STATE_DOMAIN]);
    expect(handle.state).toBeDefined();
    await handle.close();
  });

  it('round-trips a server list', async () => {
    const { handle } = await open();
    const servers: ServerConfig[] = [
      {
        id: 'srv-1',
        label: 'web',
        host: '10.0.0.1',
        port: 22,
        username: 'ops',
        authType: 'agent',
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 1
      }
    ];

    await handle.state.update('sshManager.servers', servers);

    expect(handle.state.get('sshManager.servers', [])).toEqual(servers);
    await handle.close();
  });

  it('returns the caller default for a key that was never written', async () => {
    const { handle } = await open();

    expect(handle.state.get('sshManager.trustedHostKeys', {})).toEqual({});
    await handle.close();
  });

  it('deletes the key when updated with undefined, matching the memento contract', async () => {
    const { domain, handle } = await open();

    await handle.state.update('sshManager.servers', [{ id: 'a' }]);
    await handle.state.update('sshManager.servers', undefined);

    expect(handle.state.get('sshManager.servers', 'default')).toBe('default');
    expect(domain.dump(AT_TERMINAL_STATE_DOMAIN).get(AT_TERMINAL_STATE_TABLE)?.has('sshManager.servers')).toBe(
      false
    );
    await handle.close();
  });

  it('leaves the previous value untouched when a write is rejected', async () => {
    const { handle } = await open();

    await handle.state.update('k', { ok: true });
    await expect(handle.state.update('k', 1n)).rejects.toThrow(/JSON-serializable/);

    expect(handle.state.get('k', 'gone')).toEqual({ ok: true });
    await handle.close();
  });

  it('normalizes on write so memory and medium agree before any restart', async () => {
    const { domain, handle } = await open();
    const written = new Date('2026-09-28T00:00:00.000Z');

    await handle.state.update('lastWrite', written);

    // A JSON medium cannot hold a Date; normalizing on the write path is what stops the
    // in-memory value from disagreeing with the document until a reopen.
    const stored = domain.dump(AT_TERMINAL_STATE_DOMAIN).get(AT_TERMINAL_STATE_TABLE)?.get('lastWrite');
    expect(stored).toBe('2026-09-28T00:00:00.000Z');
    expect(handle.state.get('lastWrite', null)).toBe('2026-09-28T00:00:00.000Z');
    await handle.close();
  });

  it('keeps the data across a close and reopen, the way a restart does', async () => {
    const domain = new MemoryStorageDomain();
    const first = await open(domain);
    await first.handle.state.update('sshManager.servers', [{ id: 'srv-1' }]);
    await first.handle.close();

    const second = await open(domain);
    expect(second.handle.state.get('sshManager.servers', [])).toEqual([{ id: 'srv-1' }]);
    await second.handle.close();
  });

  it('aborts the open when a stored record does not match the schema', async () => {
    const domain = new MemoryStorageDomain();
    // A hand-edited document holding a function — no JSON medium could have written it,
    // and loading it must fail rather than degrade into "the plugin has no state".
    domain.seedRaw(AT_TERMINAL_STATE_DOMAIN, AT_TERMINAL_STATE_TABLE, 'corrupt', () => undefined);

    const error = await rejection(() => openDshStateStore({ storageDomain: domain }));
    expect(error).toBeInstanceOf(FakeDomainError);
    expect(error.code).toBe('invalid-record');
    // The offending table and key must be in the message, or the failure is unactionable.
    expect(error.message).toContain('corrupt');
  });

  it('surfaces an already-open domain instead of quietly sharing one', async () => {
    const domain = new MemoryStorageDomain();
    const { handle } = await open(domain);

    const error = await rejection(() => openDshStateStore({ storageDomain: domain }));
    expect(error.code).toBe('already-open');
    await handle.close();
  });

  it('tolerates being closed twice', async () => {
    const { handle } = await open();

    await handle.close();
    await handle.close();
  });

  it('rejects reads after close rather than serving a stale snapshot', async () => {
    const { handle } = await open();
    await handle.state.update('k', 1);
    await handle.close();

    expect(() => handle.state.get('k', 0)).toThrow(/closed/);
  });

  it('logs the open so a headless run is diagnosable', async () => {
    const { logger, handle } = await open();

    // `join()` renders format + arguments; `.format` alone is only the template.
    expect(logger.join()).toContain(AT_TERMINAL_STATE_DOMAIN);
    await handle.close();
  });
});
