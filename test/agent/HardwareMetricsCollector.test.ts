import { describe, expect, it, vi } from 'vitest';

import { HardwareMetricsCollector } from '../../src/agent/HardwareMetricsCollector';
import type { ServerConfig } from '../../src/config/schema';
import type { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';

function server(id = 'server-1'): ServerConfig {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
    port: 22,
    username: 'root',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function probe(disk: string, memory = 'MemTotal: 1000 kB\nMemFree: 400 kB\n'): string {
  return [
    '===UPTIME===',
    ' 10:00 up 1 day, load average: 0.10, 0.20, 0.30',
    '===STAT===',
    'cpu  100 0 100 800 0 0 0 0',
    '===MEM===',
    memory.trim(),
    '===DISK===',
    disk.trim(),
    '===NET===',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '  eth0: 500 1 0 0 0 0 0 0 300 1 0 0 0 0 0 0',
    '===PS===',
    ' 1234 root 1.0 1.0 node'
  ].join('\n');
}

describe('HardwareMetricsCollector', () => {
  it('coalesces concurrent getMetrics() calls for one server behind one probe', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return { exitCode: 0, stdout: probe('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 104857600 52428800 52428800 50% /mnt/storage'), stderr: '' };
    });
    const collector = new HardwareMetricsCollector({
      executor: { execute } as unknown as RemoteCommandExecutor,
      now: () => 1000
    });

    const first = collector.getMetrics(server());
    const second = collector.getMetrics(server());
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('recognises a real block device mounted below /mnt instead of discarding it', () => {
    const collector = new HardwareMetricsCollector({ now: () => 1000 });
    const parsed = collector.parseProbeOutput(
      'server-1',
      probe('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 104857600 52428800 52428800 50% /mnt/storage'),
      1000
    );

    expect(parsed.disk.mounts).toEqual([
      {
        fs: '/dev/sdb1',
        mount: '/mnt/storage',
        totalBytes: 104857600 * 1024,
        usedBytes: 52428800 * 1024,
        usePercent: 50
      }
    ]);
  });

  it('returns no mounts instead of fabricating a 50 GiB /dev/root disk', () => {
    const collector = new HardwareMetricsCollector({ now: () => 1000 });
    const parsed = collector.parseProbeOutput(
      'server-1',
      probe('Filesystem 1024-blocks Used Available Capacity Mounted on'),
      1000
    );

    expect(parsed.disk.mounts).toEqual([]);
  });

  it('reports zero memory instead of inventing 8 GiB total / 4 GiB free', () => {
    const collector = new HardwareMetricsCollector({ now: () => 1000 });
    const parsed = collector.parseProbeOutput('server-1', probe('', ''), 1000);

    expect(parsed.memory).toMatchObject({ totalBytes: 0, usedBytes: 0, freeBytes: 0 });
  });
});
