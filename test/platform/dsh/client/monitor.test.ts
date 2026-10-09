import { describe, expect, it, vi } from 'vitest';
import { HardwareMetricsCollector } from '../../../../src/agent/HardwareMetricsCollector';
import { AgentExecutionBridge } from '../../../../src/agent/AgentExecutionBridge';
import { formatThroughput, type HardwareMetrics, type AgentExecutionSnapshot } from '../../../../src/platform/dsh/client/models';
import { listenMonitorEvents } from '../../../../src/platform/dsh/client/channel';

describe('DSH Monitor System — Unit Tests', () => {
  describe('formatThroughput', () => {
    it('formats bytes per second with appropriate units', () => {
      expect(formatThroughput(0)).toBe('0 B/s');
      expect(formatThroughput(512)).toBe('512 B/s');
      expect(formatThroughput(1024)).toBe('1.0 KB/s');
      expect(formatThroughput(1536)).toBe('1.5 KB/s');
      expect(formatThroughput(1024 * 1024)).toBe('1.0 MB/s');
      expect(formatThroughput(2.5 * 1024 * 1024)).toBe('2.5 MB/s');
      expect(formatThroughput(1024 * 1024 * 1024)).toBe('1024.0 MB/s');
    });
  });

  describe('HardwareMetricsCollector', () => {
    it('parses valid Linux probe output into structured metrics', () => {
      const collector = new HardwareMetricsCollector({ now: () => 1700000000000 });
      const probeOutput = `===UPTIME===
 14:20:00 up 10 days,  3:45,  1 user,  load average: 0.15, 0.25, 0.35
===MEM===
MemTotal:       16384000 kB
MemFree:         4096000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          3584000 kB
SwapTotal:       2048000 kB
SwapFree:        1024000 kB
===DISK===
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1         50000000  20000000  27000000      43% /
/dev/sdb1        100000000  60000000  35000000      63% /data
===NET===
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000    1000    0    0    0     0          0         0  1000000    1000    0    0    0     0       0          0
  eth0: 50000000   40000    0    0    0     0          0         0 20000000   25000    0    0    0     0       0          0
===PS===
  PID USER     %CPU %MEM COMMAND
 1234 root     12.5  3.2 node
  567 www-data  8.0  2.1 nginx
  890 mysql     5.5  8.4 mysqld
`;
      const metrics = collector.parseProbeOutput('server-1', probeOutput, 1700000000000);

      expect(metrics.serverId).toBe('server-1');
      expect(metrics.cpu.loadAvg).toEqual([0.15, 0.25, 0.35]);
      expect(metrics.memory.totalBytes).toBe(16384000 * 1024);
      expect(metrics.memory.freeBytes).toBe(8192000 * 1024); // Uses MemAvailable
      expect(metrics.memory.usedBytes).toBe((16384000 - 8192000) * 1024);
      expect(metrics.memory.cachedBytes).toBe(3584000 * 1024);
      expect(metrics.disk.mounts).toHaveLength(2);
      expect(metrics.disk.mounts[0]).toEqual({
        fs: '/dev/sda1',
        mount: '/',
        totalBytes: 50000000 * 1024,
        usedBytes: 20000000 * 1024,
        usePercent: 43
      });
      expect(metrics.processes).toHaveLength(3);
      expect(metrics.processes[0]).toEqual({
        pid: 1234,
        user: 'root',
        cpuPercent: 12.5,
        memPercent: 3.2,
        command: 'node'
      });
    });

    it('calculates network throughput delta across successive probes', () => {
      let currentTime = 1000;
      const collector = new HardwareMetricsCollector({ now: () => currentTime });

      const output1 = `===NET===
  eth0: 100000 1 0 0 0 0 0 0 200000 1 0 0 0 0 0 0
`;
      const m1 = collector.parseProbeOutput('s1', output1, 1000);
      expect(m1.network.rxBytesPerSec).toBe(0);
      expect(m1.network.txBytesPerSec).toBe(0);

      currentTime = 2000; // +1000ms
      const output2 = `===NET===
  eth0: 105000 2 0 0 0 0 0 0 202000 2 0 0 0 0 0 0
`;
      const m2 = collector.parseProbeOutput('s1', output2, 2000);
      expect(m2.network.rxBytesPerSec).toBe(5000); // 5000 bytes in 1s
      expect(m2.network.txBytesPerSec).toBe(2000); // 2000 bytes in 1s
    });

    it('returns cached metrics within TTL', async () => {
      const executeMock = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '===UPTIME===\n 10:00:00 up 1 day, load average: 0.1, 0.2, 0.3\n'
      });
      const collector = new HardwareMetricsCollector({
        executor: { execute: executeMock } as any,
        now: () => 1000
      });

      const server: any = { id: 'srv-1', host: '127.0.0.1' };
      const m1 = await collector.getMetrics(server);
      const m2 = await collector.getMetrics(server);

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(m1).toBe(m2);
    });

    it('calculates CPU percentage and per-core distribution from /proc/stat deltas', () => {
      let currentTime = 1000;
      const collector = new HardwareMetricsCollector({ now: () => currentTime });

      const output1 = `===STAT===
cpu  1000 0 200 8800 0 0 0 0 0 0
cpu0 500 0 100 4400 0 0 0 0 0 0
cpu1 500 0 100 4400 0 0 0 0 0 0
===UPTIME===
 10:00:00 up 1 day, load average: 0.1, 0.2, 0.3
`;
      const m1 = collector.parseProbeOutput('s1', output1, 1000);
      expect(m1.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(m1.cpu.cores).toHaveLength(2);

      currentTime = 2000; // 1s later: 400 ticks active, 600 ticks idle (total 1000 delta -> 40% usage)
      const output2 = `===STAT===
cpu  1300 0 300 9400 0 0 0 0 0 0
cpu0 700 0 200 4600 0 0 0 0 0 0
cpu1 600 0 100 4800 0 0 0 0 0 0
===UPTIME===
 10:00:01 up 1 day, load average: 0.4, 0.2, 0.3
`;
      const m2 = collector.parseProbeOutput('s1', output2, 2000);
      expect(m2.cpu.usagePercent).toBe(40);
      expect(m2.cpu.cores).toHaveLength(2);
      expect(m2.cpu.cores[0]).toBe(60); // 300 active / 500 total = 60%
      expect(m2.cpu.cores[1]).toBe(20); // 100 active / 500 total = 20%
    });

    it('parses free -b memory output when /proc/meminfo is not available', () => {
      const collector = new HardwareMetricsCollector();
      const output = `===MEM===
              total        used        free      shared  buff/cache   available
Mem:     16777216000  8388608000  8388608000           0           0  8388608000
Swap:     2147483648           0  2147483648
`;
      const metrics = collector.parseProbeOutput('s-free', output, 1000);
      expect(metrics.memory.totalBytes).toBe(16777216000);
      expect(metrics.memory.freeBytes).toBe(8388608000);
      expect(metrics.memory.usedBytes).toBe(16777216000 - 8388608000);
      expect(metrics.memory.swapTotalBytes).toBe(2147483648);
    });

    it('falls back to synthesized metrics when executor fails', async () => {
      const executeMock = vi.fn().mockRejectedValue(new Error('Connection lost'));
      const collector = new HardwareMetricsCollector({
        executor: { execute: executeMock } as any
      });

      const server: any = { id: 'srv-fail', host: '127.0.0.1' };
      const metrics = await collector.getMetrics(server);

      expect(metrics.serverId).toBe('srv-fail');
      expect(metrics.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(metrics.memory.totalBytes).toBeGreaterThan(0);

      collector.dispose();
    });
  });

  describe('AgentExecutionBridge', () => {
    it('tracks active action lifecycle and redacts sensitive parameters', () => {
      const bridge = new AgentExecutionBridge({ now: () => 5000 });
      const updates: AgentExecutionSnapshot[] = [];
      bridge.subscribe((snap) => updates.push(snap));

      bridge.recordActionStart({
        id: 'act-1',
        command: 'curl -u admin:secret password=hidden https://api.internal',
        serverId: 'srv-1'
      });

      const snap1 = bridge.getSnapshot();
      expect(snap1.currentAction).toBeDefined();
      expect(snap1.currentAction?.id).toBe('act-1');
      expect(snap1.currentAction?.command).not.toContain('password=hidden');
      expect(snap1.currentAction?.command).toContain('password=[REDACTED]');
      expect(snap1.currentAction?.status).toBe('running');

      bridge.recordActionStatus('act-1', 'confirmation_waiting', 'Ready for approval');
      const snap2 = bridge.getSnapshot();
      expect(snap2.currentAction?.status).toBe('confirmation_waiting');
      expect(snap2.currentAction?.outputTail).toBe('Ready for approval');

      bridge.recordActionEnd('act-1', 'success', 'Done in 100ms');
      const snap3 = bridge.getSnapshot();
      expect(snap3.currentAction?.status).toBe('success');
      expect(snap3.currentAction?.outputTail).toBe('Done in 100ms');

      expect(updates.length).toBe(4); // initial + start + status + end
    });

    it('records audit stream items with correct decisions and enforces max buffer size', () => {
      const bridge = new AgentExecutionBridge({ now: () => 1000, maxRecentAudits: 3 });

      bridge.recordAudit({ tool: 'at_terminal_run_remote_command', command: 'ls -la', reasonCode: 'policy_allowed' });
      bridge.recordAudit({ tool: 'at_terminal_run_remote_command', command: 'systemctl restart nginx', reasonCode: 'user_approved' });
      bridge.recordAudit({ tool: 'at_terminal_run_remote_command', command: 'rm -rf /', reasonCode: 'user_cancelled' });
      bridge.recordAudit({ tool: 'at_terminal_sftp_delete', command: 'delete /var/log', reasonCode: 'policy_allowed' });

      const snap = bridge.getSnapshot(10);
      expect(snap.recentAudits).toHaveLength(3); // capped at maxRecentAudits=3
      expect(snap.recentAudits[0].command).toBe('delete /var/log');
      expect(snap.recentAudits[0].decision).toBe('allowed');
      expect(snap.recentAudits[1].command).toBe('rm -rf /');
      expect(snap.recentAudits[1].decision).toBe('denied');
      expect(snap.recentAudits[2].decision).toBe('confirmed');
    });

    it('manages active file transfers tracking', () => {
      const bridge = new AgentExecutionBridge();

      bridge.updateTransfer({
        id: 'tx-1',
        filename: 'package.tar.gz',
        type: 'upload',
        progressPercent: 50,
        bytesPerSec: 100
      });

      let snap = bridge.getSnapshot();
      expect(snap.activeTransfers).toHaveLength(1);
      expect(snap.activeTransfers[0].filename).toBe('package.tar.gz');
      expect(snap.activeTransfers[0].progressPercent).toBe(50);

      bridge.completeTransfer('tx-1');
      snap = bridge.getSnapshot();
      expect(snap.activeTransfers).toHaveLength(0);
    });

    it('calculates elapsed runningTimeMs stopwatch dynamically while running and freezes on completion', () => {
      let currentTime = 1000;
      const bridge = new AgentExecutionBridge({ now: () => currentTime });

      bridge.recordActionStart({ id: 'act-timer', command: 'sleep 5' });
      expect(bridge.getSnapshot().currentAction?.runningTimeMs).toBe(0);

      currentTime = 2500;
      expect(bridge.getSnapshot().currentAction?.runningTimeMs).toBe(1500);

      currentTime = 4000;
      bridge.recordActionEnd('act-timer', 'success');
      expect(bridge.getSnapshot().currentAction?.runningTimeMs).toBe(3000);

      currentTime = 6000; // time advances after completion
      expect(bridge.getSnapshot().currentAction?.runningTimeMs).toBe(3000); // frozen at completion time

      bridge.dispose();
      expect(bridge.getSnapshot().currentAction).toBeUndefined();
    });
  });

  describe('Channel SSE listener', () => {
    it('safely handles environments with or without EventSource', () => {
      const handler = vi.fn();
      const unsubscribe = listenMonitorEvents(handler);
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('Draggable Floating Window Position & Clamping', () => {
    it('clamps coordinates strictly within viewport boundaries', async () => {
      const { clampPosition } = await import('../../../../src/platform/dsh/client/views/monitorHud');

      // Given a 1200x800 viewport and 400x520 window
      // Top-left overflow:
      expect(clampPosition(-100, -50, 400, 520)).toEqual({ x: 8, y: 8 });

      // Bottom-right overflow:
      // maxX = 1200 - 400 - 8 = 792, maxY = 800 - 520 - 8 = 272
      expect(clampPosition(2000, 1500, 400, 520)).toEqual({ x: 792, y: 272 });

      // In-bounds coordinates:
      expect(clampPosition(200, 150, 400, 520)).toEqual({ x: 200, y: 150 });
    });

    it('persists and recovers floating window position from localStorage', async () => {
      const { loadSavedPosition, savePosition } = await import('../../../../src/platform/dsh/client/views/monitorHud');

      const storageMap: Record<string, string> = {};
      const fakeStorage = {
        getItem: (k: string) => storageMap[k] ?? null,
        setItem: (k: string, v: string) => { storageMap[k] = v; },
        removeItem: (k: string) => { delete storageMap[k]; }
      };
      vi.stubGlobal('localStorage', fakeStorage);

      savePosition({ x: 350, y: 120 });
      const loaded = loadSavedPosition();
      expect(loaded.x).toBe(350);
      expect(loaded.y).toBe(120);

      vi.unstubAllGlobals();
    });
  });

  describe('Active Terminal Session Tracking & Dynamic Target Switching', () => {
    it('only activates when connected to a terminal and switches target with active tab', async () => {
      const {
        ensureSession,
        markSessionActive,
        getActiveTerminalState,
        subscribeActiveTerminal,
        notifyActiveTerminal,
        disposeAllSessions
      } = await import('../../../../src/platform/dsh/client/sessions');

      disposeAllSessions('test-reset');

      // 1. Initial boot state: no connected terminal -> hasAnyConnected is false
      expect(getActiveTerminalState().hasAnyConnected).toBe(false);

      const stateUpdates: any[] = [];
      const unsubscribe = subscribeActiveTerminal((st) => stateUpdates.push(st));

      // 2. Open Tab 1 for srv-1
      const sess1 = ensureSession('tab-1');
      sess1.serverId = 'srv-1';
      markSessionActive('tab-1');

      // Not connected yet
      expect(getActiveTerminalState().hasAnyConnected).toBe(false);

      // Tab 1 becomes connected
      sess1.state = { kind: 'connected', text: '' };
      sess1.opened = true;
      notifyActiveTerminal();

      const stateConnected1 = getActiveTerminalState();
      expect(stateConnected1.hasAnyConnected).toBe(true);
      expect(stateConnected1.activeServerId).toBe('srv-1');

      // 3. Open Tab 2 for srv-2 and switch active tab to Tab 2
      const sess2 = ensureSession('tab-2');
      sess2.serverId = 'srv-2';
      sess2.state = { kind: 'connected', text: '' };
      sess2.opened = true;

      // Switch active tab to Tab 2
      markSessionActive('tab-2');
      const stateTab2 = getActiveTerminalState();
      expect(stateTab2.activeKey).toBe('tab-2');
      expect(stateTab2.activeServerId).toBe('srv-2');

      // 4. Switch back to Tab 1
      markSessionActive('tab-1');
      const stateTab1Again = getActiveTerminalState();
      expect(stateTab1Again.activeKey).toBe('tab-1');
      expect(stateTab1Again.activeServerId).toBe('srv-1');

      // 5. When all sessions disconnect
      sess1.state = { kind: 'disconnected', text: '' };
      sess2.state = { kind: 'disconnected', text: '' };
      notifyActiveTerminal();
      expect(getActiveTerminalState().hasAnyConnected).toBe(false);

      unsubscribe();
      disposeAllSessions('test-cleanup');
    });
  });
});
