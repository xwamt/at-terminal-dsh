// @ts-expect-error plain-JS host module
import { startRemoteCommandJob } from '../../dsh/jobs.js';
import { describe, expect, it, vi } from 'vitest';

/** A registry stub that records the spec it was handed and returns a fixed id. */
function makeJobs({ id = 'ssh-command-0123456789abcdef', throws }: { id?: string; throws?: Error } = {}) {
  const specs: any[] = [];
  return {
    specs,
    start(spec: any) {
      if (throws) throw throws;
      specs.push(spec);
      return id;
    }
  };
}

const EXEC = { agent: { id: 'agent-1' }, callId: 'call-1', rootCallId: 'root-1' };

/** The minimum a job body needs from the agent service. */
function makeService(overrides: Record<string, unknown> = {}) {
  return {
    runRemoteCommand: vi.fn(async () => ({
      serverId: 'srv-1',
      exitCode: 0,
      signal: null,
      stdout: 'ok\n',
      stderr: '',
      durationMs: 12,
      timedOut: false,
      truncated: false
    })),
    terminateRemoteCommand: vi.fn(async () => ({
      killed: true,
      pid: '4242',
      detail: 'process group 4242 is gone'
    })),
    ...overrides
  };
}

const BASE = {
  exec: EXEC,
  serverId: 'srv-1',
  command: 'sleep 60',
  cwd: undefined,
  maxOutputBytes: undefined,
  preAuthorized: 'auto-approved'
};

describe('the refusal to start', () => {
  it('says the composition has no job registry rather than throwing', () => {
    const jobs = makeJobs();
    const result = startRemoteCommandJob({ ...BASE, jobs: undefined, service: makeService() } as any);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/jobs service/);
    expect(jobs.specs).toHaveLength(0);
  });

  it('refuses to start before the authorization question is answered', () => {
    // A job runs detached from the call: a dialog raised inside it would arrive with no
    // tool call in flight and nowhere to answer. Refusing is the only safe ordering.
    for (const preAuthorized of [undefined, 'allowed', true]) {
      const jobs = makeJobs();
      const result = startRemoteCommandJob({
        ...BASE,
        preAuthorized,
        jobs,
        service: makeService()
      } as any);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/authorization question/);
      expect(jobs.specs).toHaveLength(0);
    }
  });

  it('refuses when the call has no agent to own the job', () => {
    const jobs = makeJobs();
    for (const exec of [undefined, {}, { agent: 'default' }, { agent: { id: '' } }]) {
      const result = startRemoteCommandJob({ ...BASE, exec, jobs, service: makeService() } as any);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/initiating agent/);
    }
    expect(jobs.specs).toHaveLength(0);
  });

  it('turns a registry refusal into a readable reason instead of an exception', () => {
    // `start()` throws when no controller serves the owner, when the owner has no live
    // agent, and at the concurrency limit. A preset without `dsh-tool-jobs` hits the first.
    const jobs = makeJobs({
      throws: new Error('background jobs unavailable: no job controller serves this agent')
    });
    const result = startRemoteCommandJob({ ...BASE, jobs, service: makeService() } as any);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no job controller serves this agent/);
  });
});

describe('the spec handed to the registry', () => {
  it('names the agent — not the session — as the owner', () => {
    // `dsh-jobs-local` resolves the owner with `agents.get(spec.owner)`; a session id would
    // not resolve, and every background call would fail with "no live agent".
    const jobs = makeJobs();
    startRemoteCommandJob({ ...BASE, jobs, service: makeService() } as any);
    expect(jobs.specs[0].owner).toBe('agent-1');
    expect(jobs.specs[0].kind).toBe('ssh-command');
    expect(jobs.specs[0].toolCall).toEqual({ callId: 'call-1', rootCallId: 'root-1' });
  });

  it('labels the job with the server and the command, bounded', () => {
    const jobs = makeJobs();
    startRemoteCommandJob({ ...BASE, jobs, service: makeService() } as any);
    expect(jobs.specs[0].label).toBe('srv-1: sleep 60');

    const long = makeJobs();
    startRemoteCommandJob(
      { ...BASE, command: 'x'.repeat(400), jobs: long, service: makeService() } as any
    );
    expect(long.specs[0].label.length).toBeLessThanOrEqual(120);
    expect(long.specs[0].label.endsWith('…')).toBe(true);
  });

  it('caps the ring at the same byte count a foreground call would capture', () => {
    const jobs = makeJobs();
    startRemoteCommandJob({ ...BASE, jobs, service: makeService() } as any);
    expect(jobs.specs[0].outputLimitBytes).toBe(64000);

    const explicit = makeJobs();
    startRemoteCommandJob(
      { ...BASE, maxOutputBytes: 4096, jobs: explicit, service: makeService() } as any
    );
    expect(explicit.specs[0].outputLimitBytes).toBe(4096);
  });
});

describe('the job body', () => {
  it('runs with no deadline, so the executor cannot kill a long job at 30 seconds', async () => {
    const jobs = makeJobs();
    const service = makeService();
    startRemoteCommandJob({ ...BASE, jobs, service } as any);
    await jobs.specs[0].run({ id: 'ssh-command-1', append() {} }).done;
    expect(service.runRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 0, serverId: 'srv-1', preAuthorized: 'auto-approved' })
    );
  });

  it('writes the pid into the command it actually sends, and folds cwd in exactly once', async () => {
    // The first version of `dsh/jobs.js` named the pidfile and killed it later, but never
    // put the write into the command — so a real `sleep 120` left no pidfile, `cat` exited
    // 1, and `job_kill` had nothing to signal. Every test passed because they all stopped
    // at "start() was called". This asserts the bytes that reach the host.
    const jobs = makeJobs();
    const service = makeService();
    startRemoteCommandJob({ ...BASE, cwd: '/srv/app', jobs, service } as any);
    await jobs.specs[0].run({ id: 'ssh-command-abc', append() {} }).done;

    const call = (service.runRemoteCommand.mock.calls[0] as any[])[0];
    expect(call.command).toBe(
      `printf '%s\\n' "$$" > '/tmp/.at-terminal-ssh-command-abc.pid'; cd '/srv/app' && sleep 60`
    );
    // Passing `cwd` as well would make the executor wrap this in a second `cd … &&`, and
    // the `;` after the pid write would then cut that chain — a failed `cd` would no
    // longer stop the command.
    expect(call.cwd).toBeUndefined();
  });

  it('streams each chunk into the ring under its own channel', async () => {
    const jobs = makeJobs();
    const service = makeService({
      runRemoteCommand: vi.fn(async (input: any) => {
        input.onOutput?.({ channel: 'stdout', text: 'building…\n' });
        input.onOutput?.({ channel: 'stderr', text: 'warning\n' });
        return { serverId: 'srv-1', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
      })
    });
    const appended: any[] = [];
    startRemoteCommandJob({ ...BASE, jobs, service } as any);
    await jobs.specs[0].run({ id: 'ssh-command-1', append: (t: string, o: any) => appended.push([t, o]) }).done;

    // The channel is the whole reason the ring can render stdout and stderr separately.
    expect(appended).toEqual([
      ['building…\n', { channel: 'stdout' }],
      ['warning\n', { channel: 'stderr' }]
    ]);
  });

  it('settles as completed with the exit line', async () => {
    const jobs = makeJobs();
    startRemoteCommandJob({ ...BASE, jobs, service: makeService() } as any);
    const outcome = await jobs.specs[0].run({ id: 'ssh-command-1', append() {} }).done;
    expect(outcome).toEqual({ status: 'completed', detail: 'exit 0 (12ms)' });
  });

  it('settles as failed with the message when the command itself fails', async () => {
    const jobs = makeJobs();
    const service = makeService({
      runRemoteCommand: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    });
    startRemoteCommandJob({ ...BASE, jobs, service } as any);
    const outcome = await jobs.specs[0].run({ id: 'ssh-command-1', append() {} }).done;
    expect(outcome).toEqual({ status: 'failed', detail: 'connect ECONNREFUSED' });
  });
});

describe('cancel', () => {
  /** A service whose command only ends when the signal aborts — like the real executor. */
  const hangingService = (
    terminate: any = vi.fn(async () => ({ killed: true, pid: '4242', detail: 'gone' }))
  ) =>
    makeService({
      runRemoteCommand: vi.fn(
        (input: any) =>
          new Promise((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('Remote command was aborted.')))
          })
      ),
      terminateRemoteCommand: terminate
    });

  it('kills the remote process through the pidfile named after the job, and settles as killed', async () => {
    const jobs = makeJobs();
    const service = hangingService();
    const { ok } = startRemoteCommandJob({ ...BASE, jobs, service } as any);
    expect(ok).toBe(true);

    const hooks = jobs.specs[0].run({ id: 'ssh-command-0123456789abcdef', append() {} });
    hooks.cancel('user asked')
    const outcome = await hooks.done;

    expect(service.terminateRemoteCommand).toHaveBeenCalledWith(
      'srv-1',
      '/tmp/.at-terminal-ssh-command-0123456789abcdef.pid'
    );
    expect(outcome).toEqual({ status: 'killed', detail: 'user asked' });
    // The local abort exists so the promise settles even when the remote kill cannot land.
    expect(service.terminateRemoteCommand).toHaveBeenCalledTimes(1);
  });

  it('aborts the local wait, so a dead connection cannot leave the job stopping forever', async () => {
    const jobs = makeJobs();
    const service = hangingService();
    startRemoteCommandJob({ ...BASE, jobs, service } as any);
    const hooks = jobs.specs[0].run({ id: 'ssh-command-2', append() {} });
    hooks.cancel('teardown');
    await hooks.done;
    expect(service.runRemoteCommand).toHaveBeenCalledTimes(1);
    expect((service.runRemoteCommand.mock.calls[0] as any[])[0].signal.aborted).toBe(true);
  });

  it('still settles as killed, and warns, when the kill itself fails', async () => {
    const jobs = makeJobs();
    const logger = { warn: vi.fn() };
    const service = hangingService(vi.fn(async () => {
      throw new Error('connection closed');
    }));
    startRemoteCommandJob({ ...BASE, jobs, service, logger } as any);
    const hooks = jobs.specs[0].run({ id: 'ssh-command-3', append() {} });
    hooks.cancel('user asked');
    const outcome = await hooks.done;
    expect(outcome).toEqual({ status: 'killed', detail: 'user asked' });
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection closed'));
  });

  it('warns when the process survived the signal', async () => {
    const jobs = makeJobs();
    const logger = { warn: vi.fn() };
    const service = hangingService(vi.fn(async () => ({
      killed: false,
      detail: 'the process did not exit after SIGTERM'
    })));
    startRemoteCommandJob({ ...BASE, jobs, service, logger } as any);
    const hooks = jobs.specs[0].run({ id: 'ssh-command-4', append() {} });
    hooks.cancel('user asked');
    await hooks.done;
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not exit'));
  });

  it('defaults the reason when the registry passes none', async () => {
    const jobs = makeJobs();
    const service = hangingService();
    startRemoteCommandJob({ ...BASE, jobs, service } as any);
    const hooks = jobs.specs[0].run({ id: 'ssh-command-5', append() {} });
    hooks.cancel(undefined);
    expect(await hooks.done).toEqual({ status: 'killed', detail: 'cancelled' });
  });
});
