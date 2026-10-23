import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain-JS host module
import { createCommands, registerCommands } from '../../dsh/commands.js';

/**
 * The two Host-side slash commands.
 *
 * The host validates before anything reaches a UI (`dsh-commands/lib/index.js`):
 * `normalizeDefinition` at `:150` (name pattern, non-empty description, handler is a function),
 * `normalizeResult` at `:184` (`kind` must be `success` or `error`, and an `error` must carry a
 * non-empty `text`), and a duplicate name throws at registration (`:89`). Those rules are
 * asserted here rather than trusted, because a command that fails them throws inside the
 * registry instead of showing the person an error.
 */

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

function fakeRegistry() {
  const registered = new Map<string, { name: string }>();
  return {
    registered,
    register: vi.fn((definition: { name: string }) => {
      if (registered.has(definition.name)) {
        // The host throws here; modelling it is what makes the idempotency test real.
        throw new Error(`command "${definition.name}" is already registered (for a per-agent variant, mount a command-injected child)`);
      }
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    })
  };
}

/** What the host would accept as a result, asserted so a handler cannot quietly return junk. */
function expectValidResult(result: unknown): void {
  const value = result as { kind?: string; text?: string };
  expect(['success', 'error']).toContain(value.kind);
  if (value.kind === 'error') {
    expect(typeof value.text).toBe('string');
    expect((value.text ?? '').trim().length).toBeGreaterThan(0);
  }
}

describe('the slash commands', () => {
  it('uses names and fields the host accepts', () => {
    const definitions = createCommands({});

    expect(definitions.map((definition: { name: string }) => definition.name)).toEqual(['ssh-metrics', 'ssh-audit']);
    for (const definition of definitions) {
      expect(definition.name).toMatch(COMMAND_NAME);
      expect(definition.description.trim().length).toBeGreaterThan(0);
      expect(typeof definition.handler).toBe('function');
      // \`input.hint\` is validated too (\`:157\`): present or absent, never empty.
      if (definition.input !== undefined) {
        expect(definition.input.hint.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('registers both, and treats a duplicate as a skip rather than a crash', () => {
    const registry = fakeRegistry();
    const logger = { warn: vi.fn() };
    const definitions = createCommands({});

    const first = registerCommands(registry, definitions, { logger });
    expect(first).toHaveLength(2);
    expect([...registry.registered.keys()]).toEqual(['ssh-metrics', 'ssh-audit']);
    expect(logger.warn).not.toHaveBeenCalled();

    // A reload applies the same bundle again: the host throws, and the second attempt must
    // leave the first registration in place and keep the plugin alive.
    const second = registerCommands(registry, definitions, { logger });
    expect(second).toHaveLength(0);
    expect([...registry.registered.keys()]).toEqual(['ssh-metrics', 'ssh-audit']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toContain('already registered');
  });

  it('surfaces an unrelated registration refusal without throwing', () => {
    const registry = {
      register: vi.fn(() => {
        throw new Error('command name "ssh-metrics" must match /^[a-z][a-z0-9_-]*$/u');
      })
    };
    const logger = { warn: vi.fn() };

    expect(() => registerCommands(registry, createCommands({}), { logger })).not.toThrow();
    expect(logger.warn.mock.calls[0][0]).toContain('was refused by the host');
  });
});

describe('/ssh-audit', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'audit-1',
    timestamp: Date.parse('2026-10-23T09:05:03Z'),
    command: 'uptime',
    decision: 'allowed' as const,
    ...overrides
  });

  async function run(rawInput: string | undefined, rows: unknown[] | undefined) {
    const readAudit = vi.fn().mockResolvedValue(rows);
    const [, audit] = createCommands({ readAudit });
    const result = await audit.handler({ rawInput });
    expectValidResult(result);
    return { result, readAudit };
  }

  it('lists the rows it read, newest last, with the decision and the command', async () => {
    const { result } = await run('', [
      row(),
      row({ id: 'audit-2', command: 'rm -rf /tmp/x', decision: 'denied' })
    ]);

    const result2 = result as { kind: string; text: string };
    expect(result2.kind).toBe('success');
    expect(result2.text).toContain('AT Terminal audit (last 2)');
    expect(result2.text).toContain('uptime');
    expect(result2.text).toContain('denied');
    expect(result2.text).toContain('rm -rf /tmp/x');
  });

  it('clamps the count, because a command is not a place to dump a 100 000-line file', async () => {
    await run('999', []);
    expect((await run('999', [])).readAudit).toHaveBeenCalledWith(50);
    expect((await run('0', [])).readAudit).toHaveBeenCalledWith(1);
    expect((await run('nonsense', [])).readAudit).toHaveBeenCalledWith(10);
  });

  it('says the trail is absent instead of failing', async () => {
    // `readRecent` answers `undefined` when the file does not exist yet, which is the normal
    // state before the first tool call.
    const { result } = await run('', undefined);
    expect((result as { kind: string }).kind).toBe('success');
    expect((result as { text: string }).text).toContain('No audit trail yet');
  });

  it('answers with an error result, not a throw, when the read rejects', async () => {
    const [, audit] = createCommands({ readAudit: vi.fn().mockRejectedValue(new Error('EACCES')) });
    const result = await audit.handler({ rawInput: '' });
    expectValidResult(result);
    expect((result as { kind: string }).kind).toBe('error');
    expect((result as { text: string }).text).toContain('EACCES');
  });

  it('says so when no audit trail is wired at all', async () => {
    const [, audit] = createCommands({});
    const result = await audit.handler({ rawInput: '' });
    expectValidResult(result);
    expect((result as { text: string }).text).toContain('not mounted');
  });
});

describe('/ssh-metrics', () => {
  function service(overrides: Record<string, unknown> = {}) {
    return {
      listServers: vi.fn().mockResolvedValue({
        servers: [
          { id: 's1', label: 'web-01', host: '10.0.0.1', connected: false },
          { id: 's2', label: 'db-01', host: '10.0.0.2', connected: true }
        ]
      }),
      getHardwareMetrics: vi.fn().mockResolvedValue({
        serverId: 's2',
        timestamp: 1,
        cpu: { usagePercent: 41.5, cores: [], loadAvg: [0.5, 0.6, 0.7] },
        memory: { totalBytes: 2 * 1024 ** 3, usedBytes: 1024 ** 3, freeBytes: 1024 ** 3 },
        disk: {
          mounts: [
            { fs: '/dev/sda1', mount: '/', totalBytes: 100 * 1024 ** 3, usedBytes: 10, usePercent: 12 },
            { fs: '/dev/sdb1', mount: '/data', totalBytes: 200 * 1024 ** 3, usedBytes: 20, usePercent: 91 }
          ]
        },
        network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
        processes: [{ pid: 1, user: 'root', cpuPercent: 12, memPercent: 3, command: 'java' }]
      }),
      openMonitor: vi.fn().mockResolvedValue({ opened: true, target: 'hardware', mode: 'hud' }),
      ...overrides
    };
  }

  it('defaults to a connected server and reports the numbers a person asked for', async () => {
    const agentService = service();
    const [metrics] = createCommands({ resolveAgentService: () => agentService });

    const result = await metrics.handler({ rawInput: '' });

    expectValidResult(result);
    expect(agentService.getHardwareMetrics).toHaveBeenCalledWith('s2');
    const text = (result as { text: string }).text;
    expect(text).toContain('db-01 (10.0.0.2)');
    expect(text).toContain('CPU 41.5%');
    expect(text).toContain('1024 MB / 2048 MB');
    // The fullest mount is the one worth showing; listing all of them is the HUD's job.
    expect(text).toContain('/data: 91%');
    expect(text).toContain('java');
    expect(text).toContain('HUD: opened');
  });

  it('accepts a server by id or by label, and explains an unknown one', async () => {
    const agentService = service();
    const [metrics] = createCommands({ resolveAgentService: () => agentService });

    await metrics.handler({ rawInput: 'web-01' });
    expect(agentService.getHardwareMetrics).toHaveBeenLastCalledWith('s1');

    await metrics.handler({ rawInput: 's2' });
    expect(agentService.getHardwareMetrics).toHaveBeenLastCalledWith('s2');

    const unknown = await metrics.handler({ rawInput: 'nope' });
    expectValidResult(unknown);
    expect((unknown as { kind: string }).kind).toBe('error');
    // The way out is the list of names that do exist.
    expect((unknown as { text: string }).text).toContain('web-01');
  });

  it('still succeeds when the HUD cannot open, and says why', async () => {
    const agentService = service({
      openMonitor: vi.fn().mockResolvedValue({ opened: false, target: 'hardware', mode: 'hud', reason: 'no-client' })
    });
    const [metrics] = createCommands({ resolveAgentService: () => agentService });

    const result = await metrics.handler({ rawInput: '' });

    expect((result as { kind: string }).kind).toBe('success');
    expect((result as { text: string }).text).toContain('HUD: not opened (no-client)');
  });

  it('turns a metrics failure into a readable result instead of a stack trace', async () => {
    const agentService = service({
      getHardwareMetrics: vi.fn().mockRejectedValue(new Error('ssh: connect to host failed'))
    });
    const [metrics] = createCommands({ resolveAgentService: () => agentService });

    const result = await metrics.handler({ rawInput: '' });

    expectValidResult(result);
    expect((result as { kind: string }).kind).toBe('error');
    expect((result as { text: string }).text).toContain('ssh: connect to host failed');
  });

  it('says the plugin is not ready when the service is not mounted', async () => {
    const [metrics] = createCommands({});
    const result = await metrics.handler({ rawInput: '' });
    expectValidResult(result);
    expect((result as { text: string }).text).toContain('not ready');
  });
});
