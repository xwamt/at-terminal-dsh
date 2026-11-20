import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus as osCpus, freemem as osFreemem, loadavg as osLoadavg, platform as osPlatform, totalmem as osTotalmem } from 'node:os';

import type {
  CpuMetrics,
  DiskMetrics,
  DiskMountMetrics,
  HardwareMetrics,
  MemoryMetrics,
  NetworkMetrics,
  ProcessMetrics
} from '../platform/dsh/client/models';

/**
 * Hardware metrics for the machine the Host itself runs on.
 *
 * The remote collector runs a POSIX probe over SSH. There is no SSH hop here, and there is no
 * single command that answers on every desktop the Host runs on: macOS reports memory through
 * `vm_stat`/`sysctl`, Windows through PowerShell's CIM cmdlets, and Linux through `/proc`.
 * Pretending otherwise is how a "local monitor" ends up printing the placeholder 8 GB/4 GB
 * fixture that `HardwareMetricsCollector` uses when its probe fails — plausible-looking numbers
 * that are not this machine. So each family has its own reader below and the common class only
 * assembles and rate-limits them.
 *
 * What is deliberately shared with the remote path is the *shape* (`HardwareMetrics`) and the
 * sampling model: CPU and network are deltas between two reads, held per collector instance.
 */

/** The id a local reading carries. `scope` is what the UI keys its "本机" label off. */
export const LOCAL_METRICS_SERVER_ID = 'local';

/** How long one reading is reused. The HUD polls every 4 s; a 1.5 s cache absorbs duplicate asks. */
const CACHE_TTL_MS = 1500;

/** A probe longer than this is a wedged command, not a slow machine. */
const COMMAND_TIMEOUT_MS = 2000;

export type LocalCommandRunner = (command: string, args: string[]) => Promise<string>;

export interface LocalHardwareMetricsCollectorOptions {
  now?: () => number;
  /** Injected by tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injected by tests; defaults to `execFile` with a short timeout. */
  run?: LocalCommandRunner;
  cpus?: () => ReturnType<typeof osCpus>;
  totalmem?: () => number;
  freemem?: () => number;
  loadavg?: () => number[];
}

interface CpuTicks {
  total: number;
  idle: number;
}

interface CpuSample {
  total: number;
  idle: number;
  cores: CpuTicks[];
  ts: number;
}

interface NetworkTotals {
  rx: number;
  tx: number;
}

function defaultRun(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** `df -k -P` → the mounts worth showing. Exported for the parser's own tests. */
export function parseDfOutput(text: string, platform: NodeJS.Platform = osPlatform()): DiskMetrics {
  const mounts: DiskMountMetrics[] = [];
  const lines = text.split('\n');
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const fs = parts[0];
    // Real block devices, plus the root filesystem even when a container reports it as
    // `overlay`. tmpfs/devfs/proc and the autofs placeholder are not storage the user can act
    // on, and showing them pushes the actual root filesystem out of the first card.
    if (!fs.startsWith('/dev/') && parts.slice(5).join(' ') !== '/') continue;
    const totalK = finite(parts[1]);
    const usedK = finite(parts[2]);
    if (totalK <= 0) continue;
    const mount = parts.slice(5).join(' ');
    if (mount === '' || mount === '/dev') continue;
    // macOS exposes the same APFS container twice, once as `/` and once under
    // `/System/Volumes/*`. The first is the one a user recognises; the second would duplicate it.
    if (platform === 'darwin' && mount.startsWith('/System/Volumes/')) continue;
    const capacity = parts[4].replace('%', '');
    const usePercent = Number.isFinite(Number(capacity))
      ? Math.min(100, Math.max(0, Math.round(Number(capacity))))
      : totalK > 0
        ? Math.round((usedK / totalK) * 100)
        : 0;
    mounts.push({
      fs,
      mount,
      totalBytes: Math.round(totalK * 1024),
      usedBytes: Math.round(usedK * 1024),
      usePercent
    });
  }
  return { mounts };
}

/** `/proc/meminfo` → the same fields the remote parser produces. */
export function parseMeminfoOutput(text: string): MemoryMetrics {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s*kB\s*$/.exec(line.trim());
    if (match === null) continue;
    values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get('MemTotal') ?? 0;
  const freeBytes = values.get('MemAvailable') ?? values.get('MemFree') ?? 0;
  const cachedBytes = values.get('Cached');
  const swapTotalBytes = values.get('SwapTotal');
  const swapFreeBytes = values.get('SwapFree');
  return {
    totalBytes,
    freeBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes),
    ...(cachedBytes === undefined ? {} : { cachedBytes }),
    ...(swapTotalBytes === undefined
      ? {}
      : { swapTotalBytes, swapUsedBytes: Math.max(0, swapTotalBytes - (swapFreeBytes ?? 0)) })
  };
}

/** macOS `vm_stat` → total/free/used. `free` here means *available* (free + inactive + speculative). */
export function parseVmStatOutput(text: string, totalBytes: number): MemoryMetrics {
  const pageSize = /page size of\s+(\d+)\s+bytes/i.exec(text)?.[1];
  const size = pageSize === undefined ? 4096 : Number(pageSize);
  const pages = new Map<string, number>();
  for (const match of text.matchAll(/^Pages ([a-z ]+):\s+(\d+)\.?\s*$/gim)) {
    pages.set(match[1].trim(), Number(match[2]));
  }
  const free = (pages.get('free') ?? 0) * size;
  const inactive = (pages.get('inactive') ?? 0) * size;
  const speculative = (pages.get('speculative') ?? 0) * size;
  const purgeable = (pages.get('purgeable') ?? 0) * size;
  const available = free + inactive + speculative;
  return {
    totalBytes,
    freeBytes: available,
    usedBytes: Math.max(0, totalBytes - available),
    cachedBytes: inactive + speculative + purgeable
  };
}

/** Linux `/proc/net/dev` → cumulative counters, loopback excluded. */
export function parseLinuxNetDev(text: string): NetworkTotals {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (name === '' || name === 'lo') continue;
    const stats = line.slice(colon + 1).trim().split(/\s+/);
    if (stats.length < 9) continue;
    rx += finite(stats[0]);
    tx += finite(stats[8]);
  }
  return { rx, tx };
}

/**
 * macOS/BSD `netstat -ibn` → cumulative counters.
 *
 * The output has one `<Link#n>` row per interface plus one row per assigned address. Only the
 * link row carries the interface counters for the interface as a whole; summing the address rows
 * too would count the same bytes three or four times. The Address column is present on some link
 * rows and omitted on others, which is why the byte columns are read from the right edge rather
 * than by a fixed left index.
 */
export function parseMacNetstat(text: string): NetworkTotals {
  let rx = 0;
  let tx = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('Name')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    if (parts[0] === 'lo0' || !parts[2]?.startsWith('<Link#')) continue;
    // Read from the right edge: the Address column is present on some link rows and absent on
    // others (a blank column collapses in `split`), so a left-based index would shift by one and
    // read Ierrs as Ibytes. The last six columns are stable: ... Ibytes Opkts Oerrs Obytes Coll.
    rx += finite(parts[parts.length - 5]);
    tx += finite(parts[parts.length - 2]);
  }
  return { rx, tx };
}

/** `ps` text (macOS `-Ao … -r` or Linux `-eo … --sort=-%cpu`) → the first five rows. */
export function parsePsOutput(text: string): ProcessMetrics[] {
  const rows: ProcessMetrics[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      user: match[2],
      cpuPercent: finite(match[3]),
      memPercent: finite(match[4]),
      command: match[5].trim()
    });
    if (rows.length === 5) break;
  }
  return rows;
}

function jsonRows(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return parsed.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
  return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : [];
}

/** PowerShell `Win32_LogicalDisk` JSON → mounts. */
export function parseWindowsDiskJson(text: string): DiskMetrics {
  const mounts: DiskMountMetrics[] = [];
  for (const row of jsonRows(text)) {
    const totalBytes = finite(row.Size);
    if (totalBytes <= 0) continue;
    const freeBytes = finite(row.FreeSpace);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    mounts.push({
      fs: typeof row.FileSystem === 'string' && row.FileSystem !== '' ? row.FileSystem : 'NTFS',
      mount: typeof row.DeviceID === 'string' ? row.DeviceID : '?',
      totalBytes,
      usedBytes,
      usePercent: Math.round((usedBytes / totalBytes) * 100)
    });
  }
  return { mounts };
}

/** PowerShell `Get-NetAdapterStatistics` JSON → cumulative counters. */
export function parseWindowsNetworkJson(text: string): NetworkTotals {
  let rx = 0;
  let tx = 0;
  for (const row of jsonRows(text)) {
    rx += finite(row.ReceivedBytes);
    tx += finite(row.SentBytes);
  }
  return { rx, tx };
}

/** PowerShell process JSON → top rows. */
export function parseWindowsProcessJson(text: string): ProcessMetrics[] {
  return jsonRows(text)
    .slice(0, 5)
    .map((row) => ({
      pid: Number(finite(row.Id)),
      user: typeof row.User === 'string' && row.User !== '' ? row.User : '-',
      cpuPercent: finite(row.CpuPercent),
      memPercent: finite(row.MemPercent),
      command: typeof row.Command === 'string' ? row.Command : String(row.ProcessName ?? '')
    }));
}

const WINDOWS_DISK_SCRIPT =
  "$items = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FileSystem,Size,FreeSpace; " +
  '@($items) | ConvertTo-Json -Compress';
const WINDOWS_NET_SCRIPT =
  "$items = Get-NetAdapterStatistics | Where-Object { $_.Name -notlike '*Loopback*' } | Select-Object Name,ReceivedBytes,SentBytes; " +
  '@($items) | ConvertTo-Json -Compress';
const WINDOWS_PS_SCRIPT =
  '$now = Get-Date; ' +
  '$total = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; ' +
  '$items = Get-Process | Where-Object { $_.CPU -ne $null } | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { ' +
  '$age = 1; try { $age = [math]::Max(1, ($now - $_.StartTime).TotalSeconds) } catch {}; ' +
  '[pscustomobject]@{ Id = $_.Id; User = ""; CpuPercent = [math]::Round(([double]$_.CPU / $age) * 100 / [Environment]::ProcessorCount, 1); ' +
  'MemPercent = [math]::Round(([double]$_.WorkingSet64 / [math]::Max(1, $total)) * 100, 1); Command = $_.ProcessName } }; ' +
  '@($items) | ConvertTo-Json -Compress';

/**
 * The local collector. One instance per Host; `getMetrics()` is safe to call concurrently and
 * caches for {@link CACHE_TTL_MS} the same way the remote collector does.
 */
export class LocalHardwareMetricsCollector {
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly run: LocalCommandRunner;
  private readonly readCpus: () => ReturnType<typeof osCpus>;
  private readonly readTotalmem: () => number;
  private readonly readFreemem: () => number;
  private readonly readLoadavg: () => number[];
  private previousCpu?: CpuSample;
  private previousNetwork?: NetworkTotals & { ts: number };
  private cache?: { metrics: HardwareMetrics; fetchedAt: number };
  /**
   * One probe at a time. The HUD polls every 4 s while the sidebar pane and an Agent tool can
   * ask at the same instant; two overlapping probes each snapshot `previousCpu` /
   * `previousNetwork`, so the second computes its delta against the first probe's *new*
   * sample and reports `0` CPU or `0 B/s` — a measurement error that looks like an idle host.
   */
  private inFlight?: Promise<HardwareMetrics>;

  constructor(options: LocalHardwareMetricsCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? osPlatform();
    this.run = options.run ?? defaultRun;
    this.readCpus = options.cpus ?? osCpus;
    this.readTotalmem = options.totalmem ?? osTotalmem;
    this.readFreemem = options.freemem ?? osFreemem;
    this.readLoadavg = options.loadavg ?? osLoadavg;
  }

  async getMetrics(): Promise<HardwareMetrics> {
    const now = this.now();
    const cached = this.cache;
    if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.metrics;
    }
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    this.inFlight = this.collectMetrics(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async collectMetrics(now: number): Promise<HardwareMetrics> {
    const [memory, disk, networkTotals, processes] = await Promise.all([
      this.readMemory().catch(() => null),
      this.readDisk().catch(() => null),
      this.readNetworkTotals().catch(() => null),
      this.readProcesses().catch(() => null)
    ]);

    const memoryMetrics = memory ?? this.fallbackMemory();
    const metrics: HardwareMetrics = {
      serverId: LOCAL_METRICS_SERVER_ID,
      scope: 'local',
      platform: this.platform,
      timestamp: now,
      cpu: this.readCpu(now),
      memory: memoryMetrics,
      disk: disk ?? { mounts: [] },
      network: this.rateNetwork(networkTotals, now),
      processes: processes ?? [],
      stale: false,
      fetchedAt: now
    };
    this.cache = { metrics, fetchedAt: now };
    return metrics;
  }

  private fallbackMemory(): MemoryMetrics {
    const totalBytes = this.readTotalmem();
    const freeBytes = this.readFreemem();
    return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
  }

  private readCpu(now: number): CpuMetrics {
    const entries = this.readCpus().map((cpu) => {
      const times = cpu.times;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { total, idle: times.idle };
    });
    const total = entries.reduce((sum, entry) => sum + entry.total, 0);
    const idle = entries.reduce((sum, entry) => sum + entry.idle, 0);
    const previous = this.previousCpu;
    let usagePercent = 0;
    const cores: number[] = [];

    if (previous !== undefined && now > previous.ts && total >= previous.total) {
      const deltaTotal = total - previous.total;
      const deltaIdle = idle - previous.idle;
      if (deltaTotal > 0) usagePercent = roundPercent(100 * (1 - deltaIdle / deltaTotal));
      for (let index = 0; index < entries.length; index += 1) {
        const before = previous.cores[index];
        if (before === undefined || entries[index].total < before.total) {
          cores.push(usagePercent);
          continue;
        }
        const coreTotal = entries[index].total - before.total;
        const coreIdle = entries[index].idle - before.idle;
        cores.push(coreTotal > 0 ? roundPercent(100 * (1 - coreIdle / coreTotal)) : 0);
      }
    } else {
      // First sample: the average since boot is the only honest figure, and it is a real reading
      // rather than the all-zero placeholder a missing delta would produce.
      usagePercent = total > 0 ? roundPercent(100 * (1 - idle / total)) : 0;
      for (let index = 0; index < entries.length; index += 1) cores.push(usagePercent);
    }

    this.previousCpu = { total, idle, cores: entries, ts: now };
    const loads = this.readLoadavg();
    return {
      usagePercent,
      cores: cores.length > 0 ? cores : [usagePercent],
      loadAvg: [finite(loads[0]), finite(loads[1]), finite(loads[2])]
    };
  }

  private rateNetwork(totals: NetworkTotals | null, now: number): NetworkMetrics {
    if (totals === null) {
      return { rxBytesPerSec: 0, txBytesPerSec: 0 };
    }
    const previous = this.previousNetwork;
    this.previousNetwork = { ...totals, ts: now };
    if (previous === undefined || now <= previous.ts) return { rxBytesPerSec: 0, txBytesPerSec: 0 };
    const seconds = (now - previous.ts) / 1000;
    return {
      rxBytesPerSec: Math.max(0, Math.round((totals.rx - previous.rx) / seconds)),
      txBytesPerSec: Math.max(0, Math.round((totals.tx - previous.tx) / seconds))
    };
  }

  private async readMemory(): Promise<MemoryMetrics> {
    if (this.platform === 'darwin') {
      const text = await this.run('/usr/bin/vm_stat', []);
      return parseVmStatOutput(text, this.readTotalmem());
    }
    if (this.platform === 'linux') {
      const text = await readFile('/proc/meminfo', 'utf8');
      return parseMeminfoOutput(text);
    }
    return this.fallbackMemory();
  }

  private async readDisk(): Promise<DiskMetrics> {
    if (this.platform === 'win32') {
      const text = await this.run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_DISK_SCRIPT
      ]);
      return parseWindowsDiskJson(text);
    }
    const command = this.platform === 'darwin' ? '/bin/df' : 'df';
    const text = await this.run(command, ['-k', '-P']);
    return parseDfOutput(text, this.platform);
  }

  private async readNetworkTotals(): Promise<NetworkTotals> {
    if (this.platform === 'win32') {
      const text = await this.run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_NET_SCRIPT
      ]);
      return parseWindowsNetworkJson(text);
    }
    if (this.platform === 'linux') {
      const text = await readFile('/proc/net/dev', 'utf8');
      return parseLinuxNetDev(text);
    }
    const text = await this.run('/usr/sbin/netstat', ['-ibn']);
    return parseMacNetstat(text);
  }

  private async readProcesses(): Promise<ProcessMetrics[]> {
    if (this.platform === 'win32') {
      const text = await this.run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_PS_SCRIPT
      ]);
      return parseWindowsProcessJson(text);
    }
    const text =
      this.platform === 'darwin'
        ? await this.run('/bin/ps', ['-Ao', 'pid=,user=,%cpu=,%mem=,comm=', '-r'])
        : await this.run('ps', ['-eo', 'pid=,user=,%cpu=,%mem=,comm=', '--sort=-%cpu']);
    return parsePsOutput(text);
  }
}
