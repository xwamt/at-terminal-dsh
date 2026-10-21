import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error plain-JS host module
import { createTools } from '../../dsh/tools.js';

describe('dsh/tools.js createTools', () => {
  it('registers ping plus 11 AT Terminal operational tools', () => {
    const mockService = {
      listServers: vi.fn().mockResolvedValue({ servers: [] }),
      getTerminalContext: vi.fn().mockResolvedValue({ focusedTerminal: null, defaultConnectedTerminal: null, connectedTerminals: [], knownTerminals: [] }),
      runRemoteCommand: vi.fn().mockResolvedValue({ serverId: 's1', serverLabel: 'S1', host: '1.2.3.4', command: 'uptime', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, truncated: false }),
      sftpListDirectory: vi.fn().mockResolvedValue({ serverId: 's1', path: '/', entries: [], truncated: false, offset: 0, total: 0 }),
      sftpStatPath: vi.fn().mockResolvedValue({ serverId: 's1', path: '/x', type: 'file', size: 10, modifiedAt: 1, permissions: 0o644 }),
      sftpReadFile: vi.fn().mockResolvedValue({ serverId: 's1', path: '/x', content: 'test', truncated: false, offset: 0, size: 4, modifiedAt: 1 }),
      sftpWriteFile: vi.fn().mockResolvedValue({ serverId: 's1', path: '/x', bytesWritten: 4, overwritten: false }),
      sftpCreateFile: vi.fn().mockResolvedValue({ serverId: 's1', path: '/x' }),
      sftpCreateDirectory: vi.fn().mockResolvedValue({ serverId: 's1', path: '/dir' }),
      sftpRename: vi.fn().mockResolvedValue({ serverId: 's1', path: '/a', newPath: '/b' }),
      sftpDelete: vi.fn().mockResolvedValue({ serverId: 's1', path: '/x', deleted: true }),
      openMonitor: vi.fn().mockResolvedValue({ opened: true, target: 'hardware', serverId: 's1', mode: 'hud' }),
      getHardwareMetrics: vi.fn().mockResolvedValue({
        serverId: 's1',
        timestamp: 1000,
        cpu: { usagePercent: 20, cores: [20], loadAvg: [0.1, 0.2, 0.3] },
        memory: { totalBytes: 8000, usedBytes: 4000, freeBytes: 4000 },
        disk: { mounts: [] },
        network: { rxBytesPerSec: 100, txBytesPerSec: 50 },
        processes: [{ pid: 1, user: 'root', cpuPercent: 1.0, memPercent: 1.0, command: 'test' }]
      }),
      getAgentExecutionStatus: vi.fn().mockResolvedValue({
        timestamp: 1000,
        currentAction: { id: 'act-1', command: 'echo 1', runningTimeMs: 10, status: 'running' },
        recentAudits: [],
        activeTransfers: []
      })
    };

    const tools = createTools({
      version: '0.1.0',
      config: {},
      resolveAgentService: () => mockService
    });

    expect(tools.length).toBe(15);
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual([
      'at_terminal_ping',
      'at_terminal_list_ssh_servers',
      'at_terminal_get_terminal_context',
      'at_terminal_run_remote_command',
      'at_terminal_sftp_list_directory',
      'at_terminal_sftp_stat_path',
      'at_terminal_sftp_read_file',
      'at_terminal_sftp_write_file',
      'at_terminal_sftp_create_file',
      'at_terminal_sftp_create_directory',
      'at_terminal_sftp_rename',
      'at_terminal_sftp_delete',
      'at_terminal_open_monitor',
      'at_terminal_get_hardware_metrics',
      'at_terminal_get_agent_execution_status'
    ]);
  });

  it('enforces schema contract and render function on all tools', () => {
    const tools = createTools({ version: '0.1.0' });
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters).toHaveProperty('properties');
      expect(tool.output).toBeDefined();
      expect(tool.output.schema).toBeDefined();
      expect(tool.output.schema.type).toBe('object');
      expect(tool.output.schema.additionalProperties).toBe(false);
      expect(typeof tool.output.render).toBe('function');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('delegates run_remote_command execution with abort signal', async () => {
    const mockService = {
      runRemoteCommand: vi.fn().mockResolvedValue({
        serverId: 's1',
        serverLabel: 'Server 1',
        host: '1.2.3.4',
        command: 'ls -la',
        cwd: '/home',
        exitCode: 0,
        signal: null,
        stdout: 'total 0',
        stderr: '',
        durationMs: 42,
        timedOut: false,
        truncated: false
      })
    };

    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService
    });
    const runTool = tools.find((t: any) => t.name === 'at_terminal_run_remote_command')!;
    const abortController = new AbortController();

    const result = await runTool.execute(
      { serverId: 's1', command: 'ls -la', cwd: '/home' },
      { signal: abortController.signal }
    );

    expect(mockService.runRemoteCommand).toHaveBeenCalledWith({
      serverId: 's1',
      command: 'ls -la',
      cwd: '/home',
      signal: abortController.signal
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('total 0');

    const rendered = runTool.output.render(
      { serverId: 's1', command: 'ls -la' },
      result
    );
    expect(Array.isArray(rendered)).toBe(true);
    expect(rendered[0].type).toBe('text');
    expect(rendered[0].text).toContain('[s1] exit 0 (42ms)');
  });

  it('delegates sftp tools correctly', async () => {
    const mockService = {
      sftpListDirectory: vi.fn().mockResolvedValue({
        serverId: 's1',
        path: '/tmp',
        entries: [{ name: 'test.txt', path: '/tmp/test.txt', type: 'file', size: 10, modifiedAt: 123 }],
        truncated: false,
        offset: 0,
        total: 1
      }),
      sftpDelete: vi.fn().mockResolvedValue({
        serverId: 's1',
        path: '/tmp/test.txt',
        deleted: true
      })
    };

    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService
    });

    const listTool = tools.find((t: any) => t.name === 'at_terminal_sftp_list_directory')!;
    const listRes = await listTool.execute({ path: '/tmp' });
    expect(mockService.sftpListDirectory).toHaveBeenCalledWith({ path: '/tmp' });
    expect(listRes.entries).toHaveLength(1);

    const deleteTool = tools.find((t: any) => t.name === 'at_terminal_sftp_delete')!;
    const deleteRes = await deleteTool.execute({ path: '/tmp/test.txt' });
    expect(mockService.sftpDelete).toHaveBeenCalledWith({ path: '/tmp/test.txt' });
    expect(deleteRes.deleted).toBe(true);
  });

  it('rejects immediately when exec.signal is pre-aborted across all tools', async () => {
    const mockService = {
      listServers: vi.fn(),
      getTerminalContext: vi.fn(),
      runRemoteCommand: vi.fn(),
      sftpListDirectory: vi.fn(),
      sftpStatPath: vi.fn(),
      sftpReadFile: vi.fn(),
      sftpWriteFile: vi.fn(),
      sftpCreateFile: vi.fn(),
      sftpCreateDirectory: vi.fn(),
      sftpRename: vi.fn(),
      sftpDelete: vi.fn()
    };

    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService
    });

    const abortController = new AbortController();
    abortController.abort();
    const exec = { signal: abortController.signal };

    for (const tool of tools) {
      if (tool.name === 'at_terminal_ping') continue;
      await expect(tool.execute({ command: 'echo 1', path: '/x', newPath: '/y', content: 'c' }, exec)).rejects.toThrow(
        /aborted/i
      );
    }

    expect(mockService.listServers).not.toHaveBeenCalled();
    expect(mockService.getTerminalContext).not.toHaveBeenCalled();
    expect(mockService.runRemoteCommand).not.toHaveBeenCalled();
    expect(mockService.sftpListDirectory).not.toHaveBeenCalled();
  });

  it('handles missing or undefined stat properties safely without violating schema', async () => {
    const mockService = {
      sftpStatPath: vi.fn().mockResolvedValue({
        serverId: 's1',
        path: '/unknown',
        type: undefined,
        size: undefined,
        modifiedAt: undefined,
        permissions: undefined
      }),
      sftpReadFile: vi.fn().mockResolvedValue({
        serverId: 's1',
        path: '/unknown',
        content: 'data',
        truncated: false,
        offset: undefined,
        size: undefined,
        modifiedAt: undefined
      })
    };

    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService
    });

    const statTool = tools.find((t: any) => t.name === 'at_terminal_sftp_stat_path')!;
    const statRes = await statTool.execute({ path: '/unknown' });
    expect(statRes.size).toBe(0);
    expect(statRes.modifiedAt).toBe(0);
    expect(statRes.type).toBe('file');
    expect(statRes.permissions).toBeNull();

    const readTool = tools.find((t: any) => t.name === 'at_terminal_sftp_read_file')!;
    const readRes = await readTool.execute({ path: '/unknown' });
    expect(readRes.offset).toBe(0);
    expect(readRes.size).toBe(0);
    expect(readRes.modifiedAt).toBe(0);
  });

  it('propagates call context via runWithCallContext and respects injected now in ping', async () => {
    const capturedContexts: Array<unknown> = [];
    const fixedDate = new Date('2026-10-08T12:00:00.000Z');

    const tools = createTools({
      version: '0.1.0',
      now: () => fixedDate,
      runWithCallContext: (ctx: any, fn: any) => {
        capturedContexts.push(ctx);
        return fn();
      },
      resolveAgentService: () => ({
        listServers: vi.fn().mockResolvedValue({ servers: [] })
      })
    });

    const pingTool = tools.find((t: any) => t.name === 'at_terminal_ping')!;
    const pingRes = await pingTool.execute();
    expect(pingRes.checkedAt).toBe(fixedDate.toISOString());

    const listTool = tools.find((t: any) => t.name === 'at_terminal_list_ssh_servers')!;
    await listTool.execute({}, { agent: 'agent-custom', callId: 'c-42' });
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toMatchObject({ agent: 'agent-custom', callId: 'c-42' });
  });

  it('opens the monitor through the service, and reports a no-client refusal instead of a false success', async () => {
    // The broadcast moved into the service (it is the only place that knows whether a client
    // is listening); this asserts the tool forwards and renders both outcomes.
    const mockService = {
      openMonitor: vi.fn().mockResolvedValue({ opened: true, target: 'hardware', serverId: 's1', mode: 'hud' })
    };
    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService
    });
    const tool = tools.find((t: any) => t.name === 'at_terminal_open_monitor')!;
    const res = await tool.execute({ target: 'hardware', serverId: 's1', mode: 'hud' });
    expect(res).toEqual({
      opened: true,
      target: 'hardware',
      serverId: 's1',
      mode: 'hud',
      reason: null
    });
    expect(mockService.openMonitor).toHaveBeenCalledWith({ target: 'hardware', serverId: 's1', mode: 'hud' });
    const rendered = tool.output.render({ target: 'hardware' }, res);
    expect(rendered[0].text).toContain('Opened hardware monitor (hud) for server: s1');

    // No panel connected: the model must be able to tell "opened" from "nobody is listening".
    mockService.openMonitor.mockResolvedValueOnce({
      opened: false,
      target: 'hardware',
      serverId: 's1',
      mode: 'hud',
      reason: 'no-client'
    });
    const refused = await tool.execute({ target: 'hardware', serverId: 's1' });
    expect(refused).toMatchObject({ opened: false, reason: 'no-client' });
    expect(tool.output.render({ target: 'hardware' }, refused)[0].text).toContain('no browser panel is connected');

    // `float` is gone: the enum says so, and the message names the surviving value.
    await expect(tool.execute({ target: 'hardware', mode: 'float' })).rejects.toThrow(/must be one of: hud/);
  });

  it('exercises at_terminal_get_hardware_metrics and get_agent_execution_status', async () => {
    const mockService = {
      getHardwareMetrics: vi.fn().mockResolvedValue({
        serverId: 's1',
        timestamp: 1000,
        cpu: { usagePercent: 25, cores: [25], loadAvg: [0.5, 0.6, 0.7] },
        memory: { totalBytes: 8192, usedBytes: 4096, freeBytes: 4096 },
        disk: { mounts: [] },
        network: { rxBytesPerSec: 1000, txBytesPerSec: 500 },
        processes: [{ pid: 123, user: 'root', cpuPercent: 5.5, memPercent: 2.1, command: 'nginx' }]
      }),
      getAgentExecutionStatus: vi.fn().mockResolvedValue({
        timestamp: 2000,
        currentAction: { id: 'act-1', command: 'df -h', runningTimeMs: 40, status: 'running' },
        recentAudits: [{ id: 'a1', timestamp: 1900, command: 'ls', decision: 'allowed', riskLevel: 'low' }],
        activeTransfers: [{ id: 't1', type: 'download', filename: 'file.tar', progressPercent: 50, bytesPerSec: 1024 }]
      })
    };
    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService
    });

    const hwTool = tools.find((t: any) => t.name === 'at_terminal_get_hardware_metrics')!;
    const hwRes = await hwTool.execute({ serverId: 's1' });
    expect(hwRes.cpuUsagePercent).toBe(25);
    expect(hwRes.topProcesses[0].command).toBe('nginx');
    const hwRendered = hwTool.output.render({}, hwRes);
    expect(hwRendered[0].text).toContain('Hardware Metrics (s1): CPU 25%');

    const agentTool = tools.find((t: any) => t.name === 'at_terminal_get_agent_execution_status')!;
    const agentRes = await agentTool.execute({ limit: 5 });
    expect(agentRes.hasActiveAction).toBe(true);
    expect(agentRes.currentCommand).toBe('df -h');
    expect(agentRes.activeTransfersCount).toBe(1);
    const agentRendered = agentTool.output.render({}, agentRes);
    expect(agentRendered[0].text).toContain('Running [df -h]');
  });

  it('reports the capabilities the build actually ships', () => {
    const ping = createTools({ version: '0.1.0' }).find((t: any) => t.name === 'at_terminal_ping')!;
    const res = ping.output.render({}, { version: '0.1.0', ready: true, capabilities: ['sftp-file-operations'], settings: {} });
    expect(res[0].text).toContain('sftp-file-operations');
  });

  it('renders SFTP mtime seconds as an ISO instant, not 1970', async () => {
    const mockService = {
      sftpStatPath: vi.fn().mockResolvedValue({
        serverId: 's1',
        path: '/srv/app.jar',
        type: 'file',
        size: 59,
        modifiedAt: 1792400342, // 2026-10-19T08:59:02Z — seconds, the unit SFTP reports
        permissions: 0o644
      })
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const statTool = tools.find((t: any) => t.name === 'at_terminal_sftp_stat_path')!;
    const statRes = await statTool.execute({ path: '/srv/app.jar' });
    expect(statRes.modifiedAt).toBe(1792400342);
    expect(statTool.output.render({}, statRes)[0].text).toContain('modifiedAt=2026-10-19T08:59:02.000Z');

    // A missing mtime stays "unknown" rather than becoming the epoch.
    const zero = statTool.output.render({}, { ...statRes, modifiedAt: 0 })[0].text;
    expect(zero).toContain('modifiedAt=unknown');
  });

  it('rejects missing arguments with a message that names the tool and the field', async () => {
    const mockService = {
      runRemoteCommand: vi.fn(),
      sftpCreateFile: vi.fn(),
      sftpWriteFile: vi.fn(),
      sftpRename: vi.fn(),
      openMonitor: vi.fn()
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const byName = (name: string) => tools.find((t: any) => t.name === name)!;

    await expect(byName('at_terminal_run_remote_command').execute(undefined)).rejects.toThrow(
      /at_terminal_run_remote_command: "command" is required/
    );
    await expect(byName('at_terminal_sftp_create_file').execute({})).rejects.toThrow(
      /at_terminal_sftp_create_file: "path" is required/
    );
    await expect(byName('at_terminal_sftp_create_file').execute({ path: '   ' })).rejects.toThrow(
      /"path" is required/
    );
    await expect(byName('at_terminal_sftp_write_file').execute({ path: '/x' })).rejects.toThrow(
      /"content" is required/
    );
    await expect(byName('at_terminal_sftp_rename').execute({ path: '/a' })).rejects.toThrow(
      /"newPath" is required/
    );
    await expect(byName('at_terminal_open_monitor').execute({})).rejects.toThrow(
      /"target" is required and must be one of/
    );
    await expect(byName('at_terminal_open_monitor').execute({ target: 'cpu' })).rejects.toThrow(
      /"target" must be one of/
    );

    // Validation happens before any service call, so nothing was attempted remotely.
    expect(mockService.runRemoteCommand).not.toHaveBeenCalled();
    expect(mockService.sftpCreateFile).not.toHaveBeenCalled();
    expect(mockService.sftpWriteFile).not.toHaveBeenCalled();
    expect(mockService.sftpRename).not.toHaveBeenCalled();
    expect(mockService.openMonitor).not.toHaveBeenCalled();
  });

  it('surfaces disk, load, network and top processes in the hardware metrics render', async () => {
    const mockService = {
      getHardwareMetrics: vi.fn().mockResolvedValue({
        serverId: 's1',
        timestamp: 1000,
        cpu: { usagePercent: 25, cores: [25], loadAvg: [0.5, 0.6, 0.7] },
        memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 },
        disk: {
          mounts: [
            { fs: '/dev/vda1', mount: '/', totalBytes: 100 * 1024 ** 3, usedBytes: 40 * 1024 ** 3, usePercent: 40 },
            { fs: '/dev/vdb1', mount: '/data', totalBytes: 200 * 1024 ** 3, usedBytes: 164 * 1024 ** 3, usePercent: 82 }
          ]
        },
        network: { rxBytesPerSec: 1024, txBytesPerSec: 512 },
        processes: [
          { pid: 123, user: 'root', cpuPercent: 5.5, memPercent: 2.1, command: 'nginx' },
          { pid: 456, user: 'app', cpuPercent: 1.2, memPercent: 0.4, command: 'java' }
        ]
      })
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const tool = tools.find((t: any) => t.name === 'at_terminal_get_hardware_metrics')!;
    const res = await tool.execute({ serverId: 's1' });

    expect(res.cpuUsagePercent).toBe(25);
    expect(res.loadAvg).toEqual([0.5, 0.6, 0.7]);
    expect(res.diskMounts).toHaveLength(2);
    expect(res.diskMounts[1]).toEqual({
      fs: '/dev/vdb1',
      mount: '/data',
      totalBytes: 200 * 1024 ** 3,
      usedBytes: 164 * 1024 ** 3,
      usePercent: 82
    });

    const text = tool.output.render({}, res)[0].text;
    expect(text).toContain('Hardware Metrics (s1): CPU 25%');
    expect(text).toContain('Load 0.50 / 0.60 / 0.70');
    expect(text).toContain('Net rx 1.0KB/s, tx 512B/s');
    expect(text).toContain('Disk: / 40% of 100GB, /data 82% of 200GB');
    expect(text).toContain('123 nginx (cpu 5.5%, mem 2.1%)');
  });

  it('degrades the hardware render when the collector returns no disk or processes', async () => {
    const mockService = {
      getHardwareMetrics: vi.fn().mockResolvedValue({
        serverId: 's1',
        timestamp: 1,
        cpu: { usagePercent: 0, cores: [], loadAvg: [0, 0, 0] },
        memory: { totalBytes: 0, usedBytes: 0, freeBytes: 0 },
        disk: undefined,
        network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
        processes: []
      })
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const tool = tools.find((t: any) => t.name === 'at_terminal_get_hardware_metrics')!;
    const res = await tool.execute({});
    expect(res.diskMounts).toEqual([]);
    const text = tool.output.render({}, res)[0].text;
    expect(text).toContain('Disk: n/a');
    expect(text).toContain('Top: n/a');
  });

  it('drops container overlay mounts and caps the rows a metrics render emits', async () => {
    const mounts = [
      { fs: '/dev/mapper/centos-root', mount: '/', totalBytes: 889 * 1024 ** 3, usedBytes: 382 * 1024 ** 3, usePercent: 43 },
      { fs: '/dev/sda', mount: '/data', totalBytes: 3.6 * 1024 ** 4, usedBytes: 1.1 * 1024 ** 4, usePercent: 34 },
      // Every container reports the host filesystem as an overlay: noise, not a disk.
      ...Array.from({ length: 12 }, (_, i) => ({
        fs: 'overlay',
        mount: `/var/lib/docker/overlay2/hash${i}/merged`,
        totalBytes: 889 * 1024 ** 3,
        usedBytes: 382 * 1024 ** 3,
        usePercent: 43
      })),
      { fs: '/dev/sdb2', mount: '/boot', totalBytes: 1014 * 1024 ** 2, usedBytes: 132 * 1024 ** 2, usePercent: 13 },
      { fs: '/dev/sdb1', mount: '/boot/efi', totalBytes: 200 * 1024 ** 2, usedBytes: 12 * 1024 ** 2, usePercent: 6 },
      { fs: 'tmpfs', mount: '/run', totalBytes: 64 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, usePercent: 7 },
      { fs: '/dev/sdc1', mount: '/backup', totalBytes: 500 * 1024 ** 3, usedBytes: 50 * 1024 ** 3, usePercent: 10 }
    ];
    const processes = Array.from({ length: 40 }, (_, i) => ({
      pid: 1000 + i,
      user: 'root',
      cpuPercent: 10 - i * 0.1,
      memPercent: 1,
      command: `proc${i}`
    }));
    const mockService = {
      getHardwareMetrics: vi.fn().mockResolvedValue({
        serverId: 's1',
        timestamp: 1,
        cpu: { usagePercent: 10, cores: [10], loadAvg: [1, 1, 1] },
        memory: { totalBytes: 1024 ** 3, usedBytes: 512 * 1024 ** 2, freeBytes: 512 * 1024 ** 2 },
        disk: { mounts },
        network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
        processes
      })
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const tool = tools.find((t: any) => t.name === 'at_terminal_get_hardware_metrics')!;
    const res = await tool.execute({ serverId: 's1' });

    // Overlay + tmpfs are filtered; four real mounts remain, but only five rows may render.
    expect(res.mountTotal).toBe(5);
    expect(res.diskMounts).toHaveLength(5);
    expect(res.diskMounts.some((m: any) => m.mount.startsWith('/var/lib/docker/'))).toBe(false);
    expect(res.diskMounts.some((m: any) => m.fs === 'tmpfs')).toBe(false);

    expect(res.processTotal).toBe(40);
    expect(res.topProcesses).toHaveLength(5);

    const text = tool.output.render({}, res)[0].text;
    expect(text).toContain('(+35 more)');
    expect(text).not.toContain('overlay2');
  });
});


