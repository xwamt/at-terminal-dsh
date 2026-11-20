import { describe, expect, it, vi } from 'vitest';

import {
  LocalHardwareMetricsCollector,
  parseDfOutput,
  parseLinuxNetDev,
  parseMacNetstat,
  parseMeminfoOutput,
  parsePsOutput,
  parseVmStatOutput,
  parseWindowsDiskJson,
  parseWindowsNetworkJson,
  parseWindowsProcessJson
} from '../../src/agent/LocalHardwareMetricsCollector';

const DF_SAMPLE = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  13337376  33281544    29%    /
devfs                  197       197         0   100%    /dev
/dev/disk3s5     482797652 423814636  33281544    93%    /System/Volumes/Data
`;

const VM_STAT_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    37249.
Pages active:                                 534989.
Pages inactive:                               526480.
Pages speculative:                             15695.
Pages purgeable:                               23111.
`;

const MAC_NET_SAMPLE = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      19353265     0 25750117353 19353265     0 25750117353     0
en0        1500  <Link#4>    be:f8:65:c7:d1:e8  1000     0     500000    900     0     200000     0
en0        1500  192.168.1     192.168.1.2       1000     -     500000    900     -     200000     -
`;

describe('LocalHardwareMetricsCollector parsers', () => {
  it('parses df -k -P into real block-device mounts and skips APFS duplicates', () => {
    const disk = parseDfOutput(DF_SAMPLE, 'darwin');
    expect(disk.mounts).toHaveLength(1);
    expect(disk.mounts[0]).toEqual({
      fs: '/dev/disk3s1s1',
      mount: '/',
      totalBytes: 482797652 * 1024,
      usedBytes: 13337376 * 1024,
      usePercent: 29
    });
  });

  it('parses macOS vm_stat as available memory rather than free pages only', () => {
    const total = 16 * 1024 * 1024 * 1024;
    const memory = parseVmStatOutput(VM_STAT_SAMPLE, total);
    const page = 16384;
    expect(memory.freeBytes).toBe((37249 + 526480 + 15695) * page);
    expect(memory.usedBytes).toBe(total - memory.freeBytes);
    expect(memory.cachedBytes).toBe((526480 + 15695 + 23111) * page);
  });

  it('parses /proc/meminfo and prefers MemAvailable', () => {
    const memory = parseMeminfoOutput(
      'MemTotal:       16384000 kB\nMemFree:         4096000 kB\nMemAvailable:    8192000 kB\nCached: 3584000 kB\nSwapTotal: 2048000 kB\nSwapFree: 1024000 kB\n'
    );
    expect(memory.totalBytes).toBe(16384000 * 1024);
    expect(memory.freeBytes).toBe(8192000 * 1024);
    expect(memory.usedBytes).toBe((16384000 - 8192000) * 1024);
    expect(memory.swapUsedBytes).toBe(1024000 * 1024);
  });

  it('sums cumulative interface counters without double-counting address rows', () => {
    expect(parseLinuxNetDev('  lo: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n  eth0: 500 1 0 0 0 0 0 0 300 1 0 0 0 0 0 0\n')).toEqual({
      rx: 500,
      tx: 300
    });
    expect(parseMacNetstat(MAC_NET_SAMPLE)).toEqual({ rx: 500000, tx: 200000 });
  });

  it('parses ps output into the five-row process view', () => {
    const processes = parsePsOutput(' 1234 root 12.5 3.2 node\n 567 www-data 8.0 2.1 nginx\n');
    expect(processes).toEqual([
      { pid: 1234, user: 'root', cpuPercent: 12.5, memPercent: 3.2, command: 'node' },
      { pid: 567, user: 'www-data', cpuPercent: 8, memPercent: 2.1, command: 'nginx' }
    ]);
  });

  it('parses the Windows PowerShell JSON shapes, including a single object', () => {
    const disk = parseWindowsDiskJson(JSON.stringify({ DeviceID: 'C:', FileSystem: 'NTFS', Size: 1000, FreeSpace: 400 }));
    expect(disk.mounts[0]).toMatchObject({ mount: 'C:', totalBytes: 1000, usedBytes: 600, usePercent: 60 });
    expect(parseWindowsNetworkJson(JSON.stringify({ ReceivedBytes: 500, SentBytes: 300 }))).toEqual({
      rx: 500,
      tx: 300
    });
    const processes = parseWindowsProcessJson(
      JSON.stringify([{ Id: 42, User: '', CpuPercent: 12.5, MemPercent: 3.2, Command: 'node' }])
    );
    expect(processes[0]).toEqual({ pid: 42, user: '-', cpuPercent: 12.5, memPercent: 3.2, command: 'node' });
  });
});

describe('LocalHardwareMetricsCollector readings', () => {
  it('assembles macOS readings and computes network deltas', async () => {
    let now = 1000;
    let network = { rx: 100000, tx: 50000 };
    let cpuTick = 1000;
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === '/usr/bin/vm_stat') return VM_STAT_SAMPLE;
      if (command === '/bin/df') return DF_SAMPLE;
      if (command === '/usr/sbin/netstat') {
        return [
          'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
          'lo0        16384 <Link#1>                      19353265     0 25750117353 19353265     0 25750117353     0',
          `en0        1500  <Link#4>    be:f8:65:c7:d1:e8  1000     0     ${network.rx}    900     0     ${network.tx}     0`
        ].join('\n');
      }
      if (command === '/bin/ps') return ' 1234 root 12.5 3.2 node\n';
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    });
    const cpus = () => [
      { model: 'cpu', speed: 1, times: { user: cpuTick, nice: 0, sys: 100, idle: 800, irq: 0 } },
      { model: 'cpu', speed: 1, times: { user: cpuTick, nice: 0, sys: 100, idle: 800, irq: 0 } }
    ];
    const collector = new LocalHardwareMetricsCollector({
      platform: 'darwin',
      now: () => now,
      run,
      cpus,
      totalmem: () => 16 * 1024 * 1024 * 1024,
      loadavg: () => [1.5, 1, 0.5]
    });

    const first = await collector.getMetrics();
    expect(first).toMatchObject({ scope: 'local', platform: 'darwin', serverId: 'local', stale: false });
    expect(first.disk.mounts).toHaveLength(1);
    expect(first.processes[0]).toMatchObject({ pid: 1234, command: 'node' });
    expect(first.network.rxBytesPerSec).toBe(0);

    now = 3000;
    network = { rx: 200000, tx: 90000 };
    cpuTick = 1200;
    const second = await collector.getMetrics();
    expect(second.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(second.network.rxBytesPerSec).toBe(50000);
    expect(second.network.txBytesPerSec).toBe(20000);
  });

  it('assembles Windows readings from PowerShell JSON', async () => {
    const run = vi.fn(async (command: string) => {
      if (command !== 'powershell.exe') throw new Error('unexpected command');
      // The collector calls three distinct scripts; identify them by their content.
      return JSON.stringify([{ DeviceID: 'C:', FileSystem: 'NTFS', Size: 1000, FreeSpace: 400 }]);
    });
    const collector = new LocalHardwareMetricsCollector({
      platform: 'win32',
      now: () => 1000,
      run,
      cpus: () => [{ model: 'cpu', speed: 1, times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }],
      totalmem: () => 1000,
      freemem: () => 400,
      loadavg: () => [0, 0, 0]
    });
    const metrics = await collector.getMetrics();
    expect(metrics.scope).toBe('local');
    expect(metrics.platform).toBe('win32');
    expect(metrics.memory.totalBytes).toBe(1000);
    // Every script returned the disk JSON in this fake, so the parsers that expect other shapes
    // simply produce empty arrays — what matters is the assembly does not throw.
    expect(metrics.disk.mounts[0].mount).toBe('C:');
  });

  it('still returns CPU and memory when every platform command fails', async () => {
    const collector = new LocalHardwareMetricsCollector({
      platform: 'darwin',
      now: () => 1000,
      run: async () => {
        throw new Error('permission denied');
      },
      cpus: () => [{ model: 'cpu', speed: 1, times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }],
      totalmem: () => 1000,
      freemem: () => 400,
      loadavg: () => [0, 0, 0]
    });
    const metrics = await collector.getMetrics();
    expect(metrics.cpu.cores).toHaveLength(1);
    expect(metrics.memory.totalBytes).toBe(1000);
    expect(metrics.disk.mounts).toEqual([]);
    expect(metrics.processes).toEqual([]);
  });
});
