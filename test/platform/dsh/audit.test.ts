import { describe, expect, it, vi } from 'vitest';
import type { AgentAuditEntry } from '../../../src/agent/AgentAuditLog';
import { createDshAuditLog, type DshAuditLogger } from '../../../src/platform/dsh/audit';

/**
 * The dsh face of `AgentAuditLog`: a channel for a host that has no OutputChannel, and the
 * reader that turns the file back into HUD rows.
 *
 * Two answers matter and must not be confused: `[]` (readable, nothing has happened yet)
 * and `undefined` (no evidence available). The status tool reports which one it got, so a
 * silent fallback to the in-memory ring would be a lie about durability.
 */

/** A file system that keeps appends in memory and remembers the order they arrived in. */
function memoryFs() {
  const writes: string[] = [];
  return {
    writes,
    fs: {
      async mkdir() {
        return undefined;
      },
      async appendFile(_path: string, data: string) {
        for (const line of data.split('\n').filter((value) => value !== '')) writes.push(line);
      }
    }
  };
}

function entry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return { tool: 'run_remote_command', command: 'uptime', reasonCode: 'completed', ...overrides };
}

describe('createDshAuditLog', () => {
  it('writes one JSONL line per call, with the command redacted', async () => {
    const sink = memoryFs();
    const log = createDshAuditLog({ storageDir: '/tmp/at-audit', writeFs: sink.fs });

    log.record(entry({ command: 'mysql --password=hunter2 -e "select 1"', serverId: 'srv-1', exitCode: 0 }));
    await log.flush();

    expect(sink.writes).toHaveLength(1);
    const line = JSON.parse(sink.writes[0]);
    expect(line).toMatchObject({
      tool: 'run_remote_command',
      serverId: 'srv-1',
      reasonCode: 'completed',
      exitCode: 0
    });
    expect(line.command).toBe('mysql --password=[REDACTED] -e "select 1"');
    expect(sink.writes[0]).not.toContain('hunter2');
    expect(typeof line.time).toBe('string');
  });

  it('forwards every line to the host logger, and survives a logger that throws', async () => {
    const sink = memoryFs();
    const logged: string[] = [];
    const logger: DshAuditLogger = {
      info(message: string) {
        logged.push(message);
        throw new Error('logger is broken');
      }
    };
    const log = createDshAuditLog({ storageDir: '/tmp/at-audit', writeFs: sink.fs, logger });

    expect(() => log.record(entry())).not.toThrow();
    await log.flush();

    expect(logged).toHaveLength(1);
    expect(sink.writes).toHaveLength(1);
  });

  it('reports an unreadable file as undefined rather than as an empty history', async () => {
    const log = createDshAuditLog({
      storageDir: '/tmp/at-audit',
      writeFs: memoryFs().fs,
      readText: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    });

    expect(await log.readRecent(5)).toBeUndefined();
  });

  it('reports a readable, empty file as an empty history', async () => {
    const log = createDshAuditLog({
      storageDir: '/tmp/at-audit',
      writeFs: memoryFs().fs,
      readText: async () => ''
    });

    expect(await log.readRecent(5)).toEqual([]);
  });

  it('reads the newest N lines, oldest first, projecting decision and risk from the reason code', async () => {
    const lines = [
      { time: '2026-10-21T00:00:00.000Z', tool: 'run_remote_command', command: 'id', reasonCode: 'completed' },
      { time: '2026-10-21T00:00:01.000Z', tool: 'sftp_delete', path: '/etc/passwd', reasonCode: 'user_approved' },
      { time: '2026-10-21T00:00:02.000Z', tool: 'sftp_write_file', path: '/etc/shadow', reasonCode: 'sensitive_path_denied' }
    ];
    const log = createDshAuditLog({
      storageDir: '/tmp/at-audit',
      writeFs: memoryFs().fs,
      readText: async () => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    });

    const recent = await log.readRecent(2);
    expect(recent?.map((row) => row.command)).toEqual(['/etc/passwd', '/etc/shadow']);
    expect(recent?.map((row) => row.decision)).toEqual(['confirmed', 'denied']);
    expect(recent?.map((row) => row.riskLevel)).toEqual(['medium', 'high']);
    expect(recent?.map((row) => row.timestamp)).toEqual([
      Date.parse('2026-10-21T00:00:01.000Z'),
      Date.parse('2026-10-21T00:00:02.000Z')
    ]);
    // Ids are unique and stable: the HUD de-duplicates on them.
    expect(new Set(recent?.map((row) => row.id)).size).toBe(2);
  });

  it('skips a corrupt line instead of failing the whole read', async () => {
    const log = createDshAuditLog({
      storageDir: '/tmp/at-audit',
      writeFs: memoryFs().fs,
      readText: async () =>
        [
          JSON.stringify({ time: '2026-10-21T00:00:00.000Z', tool: 'ping', reasonCode: 'completed' }),
          '{not json',
          JSON.stringify({ tool: 'ping', reasonCode: 'completed' }),
          JSON.stringify({ time: '2026-10-21T00:00:03.000Z', tool: 'list_ssh_servers', reasonCode: 'completed' })
        ].join('\n')
    });

    const recent = await log.readRecent(10);
    expect(recent?.map((row) => row.command)).toEqual(['ping', 'list_ssh_servers']);
  });

  it('flush() waits for the queued appends', async () => {
    const append = vi.fn(async () => undefined);
    const log = createDshAuditLog({
      storageDir: '/tmp/at-audit',
      writeFs: { async mkdir() {}, appendFile: append }
    });

    log.record(entry());
    log.record(entry());
    await log.flush();

    expect(append).toHaveBeenCalledTimes(2);
  });
});
