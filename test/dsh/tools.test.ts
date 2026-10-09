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
      sftpDelete: vi.fn().mockResolvedValue({ serverId: 's1', path: '/x', deleted: true })
    };

    const tools = createTools({
      version: '0.1.0',
      config: {},
      resolveAgentService: () => mockService
    });

    expect(tools.length).toBe(12);
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
      'at_terminal_sftp_delete'
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
});

