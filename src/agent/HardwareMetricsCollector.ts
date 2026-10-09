import type { ServerConfig } from '../config/schema';
import type { RemoteCommandExecutor } from './RemoteCommandExecutor';
import type {
  CpuMetrics,
  DiskMetrics,
  DiskMountMetrics,
  HardwareMetrics,
  MemoryMetrics,
  NetworkMetrics,
  ProcessMetrics
} from '../platform/dsh/client/models';

export interface HardwareMetricsCollectorOptions {
  executor?: RemoteCommandExecutor;
  now?: () => number;
}

const METRICS_PROBE_SCRIPT = `sh -c '
echo "===UPTIME==="
uptime 2>/dev/null || true
echo "===STAT==="
cat /proc/stat 2>/dev/null || true
echo "===MEM==="
cat /proc/meminfo 2>/dev/null || free -b 2>/dev/null || sysctl -n hw.memsize 2>/dev/null || true
echo "===DISK==="
df -k -P 2>/dev/null || true
echo "===NET==="
cat /proc/net/dev 2>/dev/null || netstat -ibn 2>/dev/null || true
echo "===PS==="
ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu 2>/dev/null || ps -eo pid,user,%cpu,%mem,comm -r 2>/dev/null | head -n 6 || true
'`;

interface CpuTicksSample {
  total: number;
  idle: number;
  cores: Array<{ total: number; idle: number }>;
  ts: number;
}

export class HardwareMetricsCollector {
  private readonly executor?: RemoteCommandExecutor;
  private readonly now: () => number;
  private readonly cache = new Map<string, { metrics: HardwareMetrics; fetchedAt: number }>();
  private readonly prevNetBytes = new Map<string, { rx: number; tx: number; ts: number }>();
  private readonly prevCpuTicks = new Map<string, CpuTicksSample>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: HardwareMetricsCollectorOptions = {}) {
    this.executor = options.executor;
    this.now = options.now ?? Date.now;
  }

  async getMetrics(server: ServerConfig): Promise<HardwareMetrics> {
    const cached = this.cache.get(server.id);
    const now = this.now();
    if (cached && now - cached.fetchedAt < 1500) {
      return cached.metrics;
    }

    if (!this.executor) {
      return this.createFallbackMetrics(server.id);
    }

    try {
      const result = await this.executor.execute(server, {
        command: METRICS_PROBE_SCRIPT,
        timeoutMs: 4000,
        maxOutputBytes: 64 * 1024
      });

      if (result.exitCode === 0 && result.stdout) {
        const parsed = this.parseProbeOutput(server.id, result.stdout, now);
        this.cache.set(server.id, { metrics: parsed, fetchedAt: now });
        return parsed;
      }
    } catch {
      // Degrade gracefully on execution failure
    }

    const fallback = cached ? cached.metrics : this.createFallbackMetrics(server.id);
    return fallback;
  }

  parseProbeOutput(serverId: string, output: string, ts: number): HardwareMetrics {
    const sections: Record<string, string> = {};
    const regex = /===([A-Z]+)===\n([\s\S]*?)(?=(?:===[A-Z]+===|$))/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
      sections[match[1]] = match[2].trim();
    }

    const cpu = this.parseCpu(serverId, sections['STAT'] ?? '', sections['UPTIME'] ?? '', ts);
    const memory = this.parseMemory(sections['MEM'] ?? '');
    const disk = this.parseDisk(sections['DISK'] ?? '');
    const network = this.parseNetwork(serverId, sections['NET'] ?? '', ts);
    const processes = this.parseProcesses(sections['PS'] ?? '');

    return {
      serverId,
      timestamp: ts,
      cpu,
      memory,
      disk,
      network,
      processes
    };
  }

  private parseCpu(
    serverId: string,
    statStr: string,
    uptimeStr: string,
    ts: number
  ): CpuMetrics {
    let loadAvg: [number, number, number] = [0, 0, 0];
    const loadMatch = /load averages?:?\s+([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i.exec(uptimeStr);
    if (loadMatch) {
      loadAvg = [parseFloat(loadMatch[1]) || 0, parseFloat(loadMatch[2]) || 0, parseFloat(loadMatch[3]) || 0];
    }

    // Try parsing /proc/stat lines
    const statLines = statStr.split('\n');
    let overallTicks: { total: number; idle: number } | null = null;
    const coreTicks: Array<{ total: number; idle: number }> = [];

    for (const line of statLines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'cpu') {
        const nums = parts.slice(1).map((n) => parseInt(n, 10) || 0);
        if (nums.length >= 4) {
          const total = nums.reduce((a, b) => a + b, 0);
          const idle = nums[3] + (nums[4] || 0);
          overallTicks = { total, idle };
        }
      } else if (/^cpu\d+$/.test(parts[0])) {
        const nums = parts.slice(1).map((n) => parseInt(n, 10) || 0);
        if (nums.length >= 4) {
          const total = nums.reduce((a, b) => a + b, 0);
          const idle = nums[3] + (nums[4] || 0);
          coreTicks.push({ total, idle });
        }
      }
    }

    if (overallTicks) {
      const prev = this.prevCpuTicks.get(serverId);
      let usagePercent = 0;
      const cores: number[] = [];

      if (prev && ts > prev.ts) {
        const deltaTotal = overallTicks.total - prev.total;
        const deltaIdle = overallTicks.idle - prev.idle;
        if (deltaTotal > 0) {
          usagePercent = Math.min(100, Math.max(0, Math.round(100 * (1 - deltaIdle / deltaTotal))));
        }

        for (let i = 0; i < coreTicks.length; i++) {
          const prevCore = prev.cores[i];
          if (prevCore) {
            const cDeltaTotal = coreTicks[i].total - prevCore.total;
            const cDeltaIdle = coreTicks[i].idle - prevCore.idle;
            const cPct =
              cDeltaTotal > 0
                ? Math.min(100, Math.max(0, Math.round(100 * (1 - cDeltaIdle / cDeltaTotal))))
                : 0;
            cores.push(cPct);
          } else {
            cores.push(usagePercent);
          }
        }
      } else {
        usagePercent = Math.min(100, Math.max(0, Math.round(loadAvg[0] * 25)));
        for (let i = 0; i < (coreTicks.length || 1); i++) {
          cores.push(usagePercent);
        }
      }

      this.prevCpuTicks.set(serverId, {
        total: overallTicks.total,
        idle: overallTicks.idle,
        cores: coreTicks,
        ts
      });

      return {
        usagePercent,
        cores: cores.length > 0 ? cores : [usagePercent],
        loadAvg
      };
    }

    // Fallback if /proc/stat is absent
    const usagePercent = Math.min(100, Math.max(0, Math.round(loadAvg[0] * 25)));
    return {
      usagePercent,
      cores: [usagePercent],
      loadAvg
    };
  }

  private parseMemory(memStr: string): MemoryMetrics {
    let totalBytes = 0;
    let freeBytes = 0;
    let availableBytes = 0;
    let cachedBytes = 0;
    let swapTotal = 0;
    let swapFree = 0;

    const lines = memStr.split('\n');
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parseInt(parts[1].trim(), 10);
        if (!isNaN(val)) {
          const bytes = val * 1024; // /proc/meminfo is in kB
          if (key === 'MemTotal') totalBytes = bytes;
          else if (key === 'MemFree') freeBytes = bytes;
          else if (key === 'MemAvailable') availableBytes = bytes;
          else if (key === 'Cached') cachedBytes = bytes;
          else if (key === 'SwapTotal') swapTotal = bytes;
          else if (key === 'SwapFree') swapFree = bytes;
        }
      }
    }

    // Fallback: parse `free -b` or `free` output
    if (totalBytes === 0) {
      const memLine = lines.find((l) => /^\s*Mem:\s+/i.test(l));
      if (memLine) {
        const nums = memLine.replace(/^\s*Mem:\s+/i, '').trim().split(/\s+/).map((n) => parseInt(n, 10));
        if (nums.length >= 3 && !isNaN(nums[0])) {
          totalBytes = nums[0];
          freeBytes = nums[2] || 0;
          availableBytes = nums[5] !== undefined && !isNaN(nums[5]) ? nums[5] : freeBytes;
        }
      }
      const swapLine = lines.find((l) => /^\s*Swap:\s+/i.test(l));
      if (swapLine) {
        const snums = swapLine.replace(/^\s*Swap:\s+/i, '').trim().split(/\s+/).map((n) => parseInt(n, 10));
        if (snums.length >= 3 && !isNaN(snums[0])) {
          swapTotal = snums[0];
          swapFree = snums[2] || 0;
        }
      }
    }

    // Fallback: parse single integer from macOS sysctl -n hw.memsize
    if (totalBytes === 0) {
      for (const line of lines) {
        const val = parseInt(line.trim(), 10);
        if (!isNaN(val) && val > 1024 * 1024 * 1024) {
          totalBytes = val;
          freeBytes = Math.round(val * 0.4);
          availableBytes = freeBytes;
          break;
        }
      }
    }

    if (totalBytes === 0) {
      totalBytes = 8 * 1024 * 1024 * 1024;
      freeBytes = 4 * 1024 * 1024 * 1024;
    }

    const effectiveFree = availableBytes > 0 ? availableBytes : freeBytes;
    const usedBytes = Math.max(0, totalBytes - effectiveFree);
    const swapUsed = Math.max(0, swapTotal - swapFree);

    return {
      totalBytes,
      usedBytes,
      freeBytes: effectiveFree,
      cachedBytes: cachedBytes > 0 ? cachedBytes : undefined,
      swapTotalBytes: swapTotal > 0 ? swapTotal : undefined,
      swapUsedBytes: swapTotal > 0 ? swapUsed : undefined
    };
  }

  private parseDisk(diskStr: string): DiskMetrics {
    const mounts: DiskMountMetrics[] = [];
    const lines = diskStr.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        const fs = parts[0];
        const total1K = parseInt(parts[1], 10);
        const used1K = parseInt(parts[2], 10);
        const pctStr = parts[4].replace('%', '');
        const usePercent = parseInt(pctStr, 10) || 0;
        const mount = parts[5];

        if (total1K > 0 && (mount === '/' || mount.startsWith('/data') || mount.startsWith('/home') || mount.startsWith('/var'))) {
          mounts.push({
            fs,
            mount,
            totalBytes: total1K * 1024,
            usedBytes: used1K * 1024,
            usePercent
          });
        }
      }
    }

    if (mounts.length === 0) {
      mounts.push({
        fs: '/dev/root',
        mount: '/',
        totalBytes: 50 * 1024 * 1024 * 1024,
        usedBytes: 15 * 1024 * 1024 * 1024,
        usePercent: 30
      });
    }

    return { mounts };
  }

  private parseNetwork(serverId: string, netStr: string, ts: number): NetworkMetrics {
    let rxBytesTotal = 0;
    let txBytesTotal = 0;

    const lines = netStr.split('\n');
    for (const line of lines) {
      if (!line.includes(':')) continue;
      const parts = line.split(':');
      const dev = parts[0].trim();
      if (dev === 'lo') continue; // Skip loopback

      const stats = parts[1].trim().split(/\s+/);
      if (stats.length >= 9) {
        const rx = parseInt(stats[0], 10);
        const tx = parseInt(stats[8], 10);
        if (!isNaN(rx)) rxBytesTotal += rx;
        if (!isNaN(tx)) txBytesTotal += tx;
      }
    }

    if (rxBytesTotal === 0 && txBytesTotal === 0) {
      // Fallback: parse netstat -ibn on macOS / BSD
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 9 && parts[0] !== 'lo0' && parts[0] !== 'Name' && parts[2]?.startsWith('<Link#')) {
          const rx = parseInt(parts[5], 10);
          const tx = parseInt(parts[8], 10);
          if (!isNaN(rx)) rxBytesTotal += rx;
          if (!isNaN(tx)) txBytesTotal += tx;
        }
      }
    }

    const prev = this.prevNetBytes.get(serverId);
    let rxBytesPerSec = 0;
    let txBytesPerSec = 0;

    if (prev && ts > prev.ts) {
      const elapsedSec = (ts - prev.ts) / 1000;
      if (elapsedSec > 0 && elapsedSec < 30) {
        rxBytesPerSec = Math.max(0, Math.round((rxBytesTotal - prev.rx) / elapsedSec));
        txBytesPerSec = Math.max(0, Math.round((txBytesTotal - prev.tx) / elapsedSec));
      }
    }

    this.prevNetBytes.set(serverId, { rx: rxBytesTotal, tx: txBytesTotal, ts });
    return { rxBytesPerSec, txBytesPerSec };
  }

  private parseProcesses(psStr: string): ProcessMetrics[] {
    const list: ProcessMetrics[] = [];
    const lines = psStr.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('PID') || trimmed.startsWith('USER')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 5) {
        const pid = parseInt(parts[0], 10);
        const user = parts[1];
        const cpuPercent = parseFloat(parts[2]) || 0;
        const memPercent = parseFloat(parts[3]) || 0;
        const command = parts.slice(4).join(' ');

        if (!isNaN(pid)) {
          list.push({ pid, user, cpuPercent, memPercent, command });
        }
      }
    }
    return list;
  }

  createFallbackMetrics(serverId: string): HardwareMetrics {
    return {
      serverId,
      timestamp: this.now(),
      cpu: {
        usagePercent: 0,
        cores: [0],
        loadAvg: [0, 0, 0]
      },
      memory: {
        totalBytes: 8 * 1024 * 1024 * 1024,
        usedBytes: 0,
        freeBytes: 8 * 1024 * 1024 * 1024
      },
      disk: {
        mounts: []
      },
      network: {
        rxBytesPerSec: 0,
        txBytesPerSec: 0
      },
      processes: []
    };
  }

  dispose(): void {
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
    this.cache.clear();
    this.prevNetBytes.clear();
    this.prevCpuTicks.clear();
  }
}
