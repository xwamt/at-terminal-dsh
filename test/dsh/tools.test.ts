import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error plain-JS host module
import { createTools } from '../../dsh/tools.js';
// @ts-expect-error plain-JS host module
import { recordDecision } from '../../dsh/policy.js';
// @ts-expect-error plain-JS host module
import { trustFact } from '../../dsh/prompt.js';

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

    expect(tools.length).toBe(17);
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
      'at_terminal_get_agent_execution_status',
      'at_terminal_job_output',
      'at_terminal_job_kill'
    ]);

    // Every tool declares a bound, because the Host's timeout policy is what enforces it and
    // a missing declaration means "hang until the user cancels". The five values below are
    // the plan's numbers; the rest are the same rule applied to tools that cannot block.
    for (const tool of tools as Array<{ name: string; timeoutMs?: number }>) {
      expect({ name: tool.name, bounded: Number.isFinite(tool.timeoutMs) && (tool.timeoutMs ?? 0) > 0 }).toEqual({
        name: tool.name,
        bounded: true
      });
    }
    const timeouts = Object.fromEntries((tools as Array<{ name: string; timeoutMs?: number }>).map((t) => [t.name, t.timeoutMs]));
    expect(timeouts).toMatchObject({
      at_terminal_run_remote_command: 120_000,
      at_terminal_sftp_read_file: 20_000,
      at_terminal_sftp_list_directory: 30_000,
      at_terminal_sftp_stat_path: 10_000,
      at_terminal_get_hardware_metrics: 8_000,
      at_terminal_job_output: 90_000,
      at_terminal_job_kill: 60_000
    });
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

  it('hands the pre-execute conclusion to the service, so one command gets one dialog', async () => {
    // The registry mints one `exec` object per call and passes the same object to
    // `tools/pre-execute` and to `execute(args, exec)`; `policy.js` keys its WeakMap on it.
    // This test stands in for that: record a decision on the exec, then check the tool
    // forwards it rather than dropping it.
    const mockService = { runRemoteCommand: vi.fn().mockResolvedValue({ serverId: 's1', stdout: '', stderr: '' }) };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const runTool = tools.find((t: any) => t.name === 'at_terminal_run_remote_command')!;
    const exec: Record<string, unknown> = { signal: undefined };
    recordDecision(exec, 'asked');

    await runTool.execute({ serverId: 's1', command: 'uptime' }, exec);

    expect(mockService.runRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'uptime', preAuthorized: 'asked' })
    );
  });

  it('does not invent a pre-authorization for an exec nobody decided', async () => {
    const mockService = { runRemoteCommand: vi.fn().mockResolvedValue({ serverId: 's1', stdout: '', stderr: '' }) };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const runTool = tools.find((t: any) => t.name === 'at_terminal_run_remote_command')!;

    await runTool.execute({ serverId: 's1', command: 'uptime' }, { signal: undefined });

    expect(mockService.runRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ preAuthorized: undefined })
    );
  });

  it('hands a background command to the job registry without running it in this turn', async () => {
    const started: any[] = [];
    const mockService = {
      authorizeCommand: vi.fn().mockResolvedValue({ server: { id: 's1' } }),
      runRemoteCommand: vi.fn().mockResolvedValue({ serverId: 's1', stdout: '', stderr: '' })
    };
    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService,
      resolveJobs: () => ({ start: (spec: any) => (started.push(spec), 'ssh-command-abc') })
    });
    const runTool = tools.find((t: any) => t.name === 'at_terminal_run_remote_command')!;
    const exec: Record<string, unknown> = { signal: undefined, agent: { id: 'agent-1' }, callId: 'c1' };
    recordDecision(exec, 'auto-approved');

    const value = await runTool.execute(
      { serverId: 's1', command: 'sleep 60', run_in_background: true },
      exec
    );

    expect(value).toEqual({ kind: 'background', jobId: 'ssh-command-abc' });
    // The command belongs to the job now: running it here as well would start it twice.
    expect(mockService.runRemoteCommand).not.toHaveBeenCalled();
    expect(started).toHaveLength(1);
  });

  it('degrades to a foreground run with a stated reason when jobs are unavailable', async () => {
    const mockService = {
      authorizeCommand: vi.fn().mockResolvedValue({ server: { id: 's1' } }),
      runRemoteCommand: vi.fn().mockResolvedValue({
        serverId: 's1',
        serverLabel: 'S1',
        host: '1.2.3.4',
        command: 'sleep 60',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false
      })
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const runTool = tools.find((t: any) => t.name === 'at_terminal_run_remote_command')!;
    const exec: Record<string, unknown> = { signal: undefined, agent: { id: 'agent-1' }, callId: 'c1' };
    recordDecision(exec, 'auto-approved');

    const value = await runTool.execute(
      { serverId: 's1', command: 'sleep 60', run_in_background: true },
      exec
    );

    expect(value.kind).toBe('foreground');
    // Silently ignoring the flag would leave the caller with a 120 s timeout it did not
    // expect; the reason has to reach the model.
    expect(value.notice).toMatch(/run_in_background was not honoured/);
    expect(value.notice).toMatch(/jobs service/);
  });

  it('says out loud that the hardware probe skips the policy engine, and that it is still audited', async () => {
    // The probe runs a fixed script through the executor, so it never meets
    // `authorizeRemoteCommand`. A model reading "get hardware metrics" would reasonably
    // assume the same rules applied; the description is where that assumption is corrected.
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => ({}) });
    const metrics = tools.find((t: any) => t.name === 'at_terminal_get_hardware_metrics')!;
    expect(metrics.description).toContain('bypasses the command policy engine');
    expect(metrics.description).toContain('still audited');
    // And the capability list a caller uses to decide what it may attempt says the same.
    const ping = tools.find((t: any) => t.name === 'at_terminal_ping')!;
    const value = await ping.execute({});
    expect(value.capabilities).toContain('builtin-probe');
  });

  it('spills an over-budget command result and names the file in the output', async () => {
    // The wiring, not just the helper: `run_remote_command` has to hand the *rendered* text
    // to the spill store and put the head/tail back where the render reads from.
    const long = `${'a'.repeat(40_000)}TAIL-MARKER`;
    const saveText = vi.fn(async () => ({ locator: '/tmp/spill/run.txt', bytes: long.length }));
    const mockService = {
      runRemoteCommand: vi.fn().mockResolvedValue({
        serverId: 's1',
        serverLabel: 'S1',
        host: '1.2.3.4',
        command: 'ps aux',
        exitCode: 0,
        stdout: long,
        stderr: '',
        durationMs: 5,
        timedOut: false,
        truncated: false
      })
    };
    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService,
      resolveSpillStore: () => ({ saveText }),
      logger: { warn: vi.fn() }
    });
    const runTool = tools.find((t: any) => t.name === 'at_terminal_run_remote_command')!;

    const result = await runTool.execute(
      { serverId: 's1', command: 'ps aux' },
      { agent: { session: { id: 'sess-1' } } }
    );

    expect(result.spillPath).toBe('/tmp/spill/run.txt');
    expect(saveText).toHaveBeenCalledWith(expect.objectContaining({ content: long, owner: { sessionId: 'sess-1' } }));
    // Head and tail survive; the middle is what got replaced by the pointer.
    expect(result.stdout.startsWith('aaaa')).toBe(true);
    expect(result.stdout.endsWith('TAIL-MARKER')).toBe(true);
    expect(result.stdout).toContain('/tmp/spill/run.txt');
    expect(result.stdout.length).toBeLessThan(long.length);
  });

  it('leaves a short result untouched and reports no spill path', async () => {
    const saveText = vi.fn();
    const mockService = {
      runRemoteCommand: vi.fn().mockResolvedValue({
        serverId: 's1', serverLabel: 'S1', host: '1.2.3.4', command: 'uptime',
        exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, truncated: false
      })
    };
    const tools = createTools({
      version: '0.1.0',
      resolveAgentService: () => mockService,
      resolveSpillStore: () => ({ saveText }),
      logger: { warn: vi.fn() }
    });
    const runTool = tools.find((t: any) => t.name === 'at_terminal_run_remote_command')!;

    const result = await runTool.execute({ serverId: 's1', command: 'uptime' }, { agent: { session: { id: 's' } } });

    expect(result.spillPath).toBeNull();
    expect(result.stdout).toBe('ok');
    expect(saveText).not.toHaveBeenCalled();
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
      signal: abortController.signal,
      // No `tools/pre-execute` ran for this direct call, so there is nothing to hand over —
      // and the service falls back to deciding and asking itself.
      preAuthorized: undefined
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

  it('tells the model where a directory delete has to go, in the description itself', () => {
    // Agent-side `sftp_delete` refuses directories on purpose and the UI deletes them
    // recursively; a model that only reads the tool list has no way to learn that. The
    // description carries the way out, so the refusal is actionable before the call.
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => ({}) });
    const remove = tools.find((t: any) => t.name === 'at_terminal_sftp_delete')!;
    expect(remove.description).toContain('at_terminal_run_remote_command');
    expect(remove.description).toContain('Directories are refused');
    // The parameter schema still says "file": nothing here quietly grew a recursive mode.
    expect(remove.parameters.properties).not.toHaveProperty('recursive');
  });

  /**
   * P0 from `at-pc/docs/testing/2026-10-27-sftp-large-binary-upload-gap.md`: `content` was the
   * only source, so a 7.3 MB binary meant ~10 MB of base64 through the model's context (~2.5M
   * tokens) — a call that cannot happen, no matter what SFTP can do. `localPath` moves the read
   * to the Host: the model names a file, the Host streams it, and its bytes never enter a prompt.
   * The panel upload always worked for exactly this reason.
   */
  describe('at_terminal_sftp_write_file takes a local file instead of inlining it', () => {
    const UPLOAD = {
      serverId: 's1',
      path: '/opt/at-pc/at-pc-server',
      bytesWritten: 7_692_224,
      overwritten: false,
      localPath: '/Users/clkj/at-pc/target/at-pc-server'
    };
    const writeTool = (service: Record<string, unknown> = {}) =>
      createTools({ version: '0.1.0', resolveAgentService: () => service }).find(
        (t: any) => t.name === 'at_terminal_sftp_write_file'
      )!;

    it('declares localPath and stops requiring content', () => {
      const write = writeTool();
      expect(write.parameters.properties.localPath.type).toBe('string');
      // The description is the only place a model learns this door exists for binaries; "streamed,
      // never enters context" is the fact that makes it different from a second way to inline.
      expect(write.parameters.properties.localPath.description).toMatch(/streamed/i);
      expect(write.parameters.properties.localPath.description).toMatch(/never enters context/i);
      expect(write.parameters.required).toEqual(['path']);
      // A `oneOf` on the pair would be a host-side schema experiment; the rule lives in execute()
      // where the message can say what to do about it.
      expect(write.parameters).not.toHaveProperty('oneOf');
    });

    it('asks for exactly one source, before any service call', async () => {
      const sftpWriteFile = vi.fn();
      const write = writeTool({ sftpWriteFile });

      await expect(write.execute({ path: '/x' })).rejects.toThrow(/provide either "content"/);
      await expect(write.execute({ path: '/x', content: 'a', localPath: '/tmp/a' })).rejects.toThrow(
        /pass either "content" or "localPath", not both/
      );
      await expect(write.execute({ path: '/x', localPath: '   ' })).rejects.toThrow(
        /"localPath" is required/
      );
      await expect(write.execute({ path: '/x', content: 42 })).rejects.toThrow(/"content" must be a string/);
      // Every one of those is the caller's mistake; none of them may reach a host.
      expect(sftpWriteFile).not.toHaveBeenCalled();
    });

    it('forwards localPath untouched and renders the upload as an upload', async () => {
      const sftpWriteFile = vi.fn().mockResolvedValue(UPLOAD);
      const write = writeTool({ sftpWriteFile });
      const call = { serverId: 's1', path: UPLOAD.path, localPath: UPLOAD.localPath };

      const result = await write.execute(call);

      // Untouched: the service decides how to read the file, and a field rewritten here would be
      // a second source of truth that disagrees with the one the confirmation names.
      expect(sftpWriteFile).toHaveBeenCalledWith(call);
      expect(result).toMatchObject({ localPath: UPLOAD.localPath, bytesWritten: 7_692_224 });
      // "Wrote N bytes" would hide that a local file was the source; the render is the model's
      // evidence of what happened, so an upload has to say so.
      expect(write.output.render({}, result)[0].text).toBe(
        'Uploaded 7692224 bytes from /Users/clkj/at-pc/target/at-pc-server to /opt/at-pc/at-pc-server (overwritten=false)'
      );
    });

    it('keeps the text-write wording and reports a null localPath for it', async () => {
      const sftpWriteFile = vi
        .fn()
        .mockResolvedValue({ serverId: 's1', path: '/x', bytesWritten: 4, overwritten: true });
      const write = writeTool({ sftpWriteFile });

      const result = await write.execute({ path: '/x', content: 'test', overwrite: true });

      expect(result.localPath).toBeNull();
      expect(write.output.render({}, result)[0].text).toBe('Wrote 4 bytes to /x (overwritten=true)');
      // Both shapes have to satisfy the declared schema: a text write returns null here.
      expect(write.output.schema.properties.localPath).toEqual({
        oneOf: [{ type: 'string' }, { type: 'null' }]
      });
    });

    it('bounds the call outside the service timers, so a slow upload is never cut short', () => {
      // The service's own worst case is ~360 s before connect, realpath and stat are counted
      // (60 s for the authorization, 300 s for the transfer). A tool bound equal to that sum
      // would fire first on a slow link and turn the service's "transfer aborted, the file may
      // be incomplete" into a generic TOOL_TIMEOUT — the message the operator cannot act on.
      expect(writeTool().timeoutMs).toBe(480_000);
    });
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
    await expect(tool.execute({ target: 'hardware', mode: 'float' })).rejects.toThrow(/must be one of: hud, tab/);
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
      /provide either "content" \(text\) or "localPath"/
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


describe('job control', () => {
  /** The registry as the tool sees it: a delta read, a kill, and a projection. */
  function fakeJobs(overrides: Record<string, unknown> = {}) {
    const calls: Array<[string, ...unknown[]]> = [];
    return {
      calls,
      read: vi.fn((id: string, caller: string) => {
        calls.push(['read', id, caller]);
        return {
          chunks: [{ text: 'line one\n' }, { text: 'line two\n' }],
          lossy: false,
          job: { id, status: 'running' }
        };
      }),
      kill: vi.fn((id: string, caller: string, reason: string) => {
        calls.push(['kill', id, caller, reason]);
        return 'requested';
      }),
      get: vi.fn((id: string) => ({ id, status: 'stopping', detail: 'requested by the agent' })),
      wait: vi.fn(async () => undefined),
      ...overrides
    };
  }

  const JOBS = { agent: { id: 'agent-1' }, signal: undefined };

  it('returns what arrived since the last read, under the job status', async () => {
    const jobs = fakeJobs();
    const tool = createTools({ version: '0.1.0', resolveJobs: () => jobs }).find(
      (t: any) => t.name === 'at_terminal_job_output'
    )!;

    const value = await tool.execute({ jobId: 'ssh-command-1' }, JOBS);

    expect(value).toEqual({
      jobId: 'ssh-command-1',
      status: 'running',
      text: 'line one\nline two\n',
      lossy: false,
      waitTimedOut: false
    });
    // The caller id must be the agent id: the registry fences access by it.
    expect(jobs.read).toHaveBeenCalledWith('ssh-command-1', 'agent-1');
    // No wait unless asked: polling must not block.
    expect(jobs.wait).not.toHaveBeenCalled();
  });

  it('treats an expired wait as a live job, not as an error', async () => {
    const jobs = fakeJobs({ wait: vi.fn(async () => Promise.reject(new Error('wait timed out'))) });
    const tool = createTools({ version: '0.1.0', resolveJobs: () => jobs }).find(
      (t: any) => t.name === 'at_terminal_job_output'
    )!;

    const value = await tool.execute({ jobId: 'ssh-command-1', wait: true, timeoutMs: 5 }, JOBS);

    expect(value.waitTimedOut).toBe(true);
    // Whatever arrived before the deadline is still returned.
    expect(value.text).toBe('line one\nline two\n');
  });

  it('names the missing piece instead of failing obscurely', async () => {
    const noJobs = createTools({ version: '0.1.0' }).find((t: any) => t.name === 'at_terminal_job_kill')!;
    await expect(noJobs.execute({ jobId: 'x' }, JOBS)).rejects.toThrow(/jobs service/);

    const jobs = fakeJobs();
    const tool = createTools({ version: '0.1.0', resolveJobs: () => jobs }).find(
      (t: any) => t.name === 'at_terminal_job_kill'
    )!;
    // Without an agent there is no owner to fence by; reaching for a default would let one
    // session kill another's job.
    await expect(tool.execute({ jobId: 'x' }, { signal: undefined })).rejects.toThrow(/initiating agent/);
    expect(jobs.kill).not.toHaveBeenCalled();
  });

  it('reports a kill it requested, and does not pretend an already-finished job failed', async () => {
    const requested = fakeJobs();
    const kill = createTools({ version: '0.1.0', resolveJobs: () => requested }).find(
      (t: any) => t.name === 'at_terminal_job_kill'
    )!;

    expect(await kill.execute({ jobId: 'ssh-command-1', reason: 'verification' }, JOBS)).toEqual({
      jobId: 'ssh-command-1',
      outcome: 'requested',
      status: 'stopping',
      detail: 'requested by the agent'
    });
    expect(requested.kill).toHaveBeenCalledWith('ssh-command-1', 'agent-1', 'verification');

    const finished = fakeJobs({
      kill: vi.fn(() => 'already-finished'),
      get: vi.fn((id: string) => ({ id, status: 'completed' }))
    });
    const kill2 = createTools({ version: '0.1.0', resolveJobs: () => finished }).find(
      (t: any) => t.name === 'at_terminal_job_kill'
    )!;
    expect(await kill2.execute({ jobId: 'ssh-command-1' }, JOBS)).toMatchObject({
      outcome: 'already-finished',
      status: 'completed'
    });
  });
});

/**
 * The budget and the fact feed.
 *
 * The size ceiling is a requirement, not a preference (§0.6 of the plan): every byte here is
 * paid on every request, and the guidance that used to be duplicated into these strings now
 * lives once in `dsh/prompt.js`.
 */
describe('the tool definitions', () => {
  it('fit the prompt budget, measured the way the host sends them', () => {
    const tools = createTools({ version: '0.1.0' });
    const serialized = JSON.stringify(
      tools.map(({ name, description, parameters }: any) => ({ name, description, parameters }))
    );

    // Long keys on purpose: `{n,d,p}` measures ~4% smaller and would hide a regression.
    expect(serialized.length).toBeLessThanOrEqual(5400);
  });

  it('refresh the prompt fact from the server list they just read', async () => {
    const mockService = {
      listServers: vi.fn().mockResolvedValue({
        servers: [
          {
            id: 's1',
            label: 'production',
            host: '10.0.0.1',
            port: 22,
            username: 'ops',
            authType: 'key',
            connected: true,
            agentCommandTrust: 'full'
          }
        ]
      })
    };
    const tool = createTools({ version: '0.1.0', resolveAgentService: () => mockService }).find(
      (t: any) => t.name === 'at_terminal_list_ssh_servers'
    );

    await tool.execute({}, { signal: undefined });

    // This is what makes the section's dynamic fact true rather than decorative.
    expect(trustFact()).toBe('production (full)');
  });
});

/**
 * S5-04 — the read tools' half of the target-resolution contract.
 *
 * The service decides (see `src/agent/serverTarget.ts`); the tool is where that decision either
 * reaches the model or is lost. Two things have to survive the trip: the machine-readable
 * `resolvedBy`/`candidates` in the result, and one readable line in `render` — because a model
 * that only reads the rendered text would otherwise never learn the host was inferred.
 */
describe('dsh/tools.js — read tools report how the host was chosen (S5-04)', () => {
  const READ_TOOLS = [
    'at_terminal_sftp_list_directory',
    'at_terminal_sftp_stat_path',
    'at_terminal_sftp_read_file',
    'at_terminal_get_hardware_metrics'
  ];

  it('declares resolvedBy and candidates on every read tool, and on no write tool', () => {
    const tools = createTools({ version: '0.0.0' });
    for (const name of READ_TOOLS) {
      const tool = tools.find((t: any) => t.name === name)!;
      const properties = tool.output.schema.properties;
      expect(Object.keys(properties), name).toEqual(expect.arrayContaining(['resolvedBy', 'candidates']));
    }
    // A write tool that inferred its host would be the bug this whole card is about, so it must
    // not advertise the field: the absence is the assertion.
    const write = tools.find((t: any) => t.name === 'at_terminal_sftp_write_file')!;
    expect(write.output.schema.properties.resolvedBy).toBeUndefined();
  });

  it('passes resolvedBy and candidates through from the service', async () => {
    const candidates = [
      { id: 'server-1', label: 'Production' },
      { id: 'server-2', label: 'Staging' }
    ];
    const mockService = {
      sftpListDirectory: vi.fn().mockResolvedValue({
        terminalId: 'terminal-2',
        serverId: 'server-2',
        resolvedBy: 'implicit',
        candidates,
        path: '/srv',
        entries: [],
        truncated: false,
        offset: 0,
        total: 0
      })
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const tool = tools.find((t: any) => t.name === 'at_terminal_sftp_list_directory')!;

    const result = await tool.execute({ path: '/srv' }, {});
    expect(result).toMatchObject({ resolvedBy: 'implicit', candidates });

    const rendered = tool.output.render({ path: '/srv' }, result);
    expect(rendered[0].text).toContain('Resolved implicitly to server-2');
    expect(rendered[0].text).toContain('server-1 (Production)');
    expect(rendered[0].text).toContain('Pass serverId to name one.');
  });

  it('says nothing extra when the call named its server', async () => {
    const mockService = {
      sftpListDirectory: vi.fn().mockResolvedValue({
        terminalId: 'terminal-1',
        serverId: 'server-1',
        resolvedBy: 'explicit',
        path: '/srv',
        entries: [],
        truncated: false,
        offset: 0,
        total: 0
      })
    };
    const tools = createTools({ version: '0.1.0', resolveAgentService: () => mockService });
    const tool = tools.find((t: any) => t.name === 'at_terminal_sftp_list_directory')!;

    const result = await tool.execute({ serverId: 'server-1', path: '/srv' }, {});
    // No note, no candidate list: there was nothing to explain, and an "explicit" note on every
    // listing is noise the model pays for with every call.
    expect(tool.output.render({ path: '/srv' }, result)[0].text).not.toContain('Resolved implicitly');
    expect(result.candidates).toBeUndefined();
  });
});
