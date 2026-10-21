import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain-JS host modules
import { TOOL_POLICY, RISK_CATEGORIES, classify, createGuard, createPreExecute, readPreExecuteDecision, recordDecision } from '../../dsh/policy.js';
// @ts-expect-error plain-JS host module
import { createTools } from '../../dsh/tools.js';
import { isSensitiveRemotePath } from '../../src/agent/remoteWritePolicy';

const guard = createGuard({ isSensitiveRemotePath });

describe('the coverage table', () => {
  it('classifies exactly the tools createTools() registers — both directions', () => {
    const registered = createTools({ version: '0.0.0' }).map((tool: { name: string }) => tool.name);
    expect(Object.keys(TOOL_POLICY).sort()).toEqual([...registered].sort());
  });

  it('only uses declared risk categories', () => {
    for (const [name, entry] of Object.entries(TOOL_POLICY)) {
      expect({ name, risk: (entry as { risk: string }).risk, ok: RISK_CATEGORIES.includes((entry as { risk: string }).risk) }).toEqual({
        name,
        risk: (entry as { risk: string }).risk,
        ok: true
      });
    }
  });

  it('ignores tools that are not ours, and unregistered names in our namespace', () => {
    expect(classify('read_file')).toBeUndefined();
    expect(classify('at_terminal_nope')).toBeUndefined();
    expect(classify(undefined)).toBeUndefined();
    expect(classify('at_terminal_ping')).toEqual({ risk: 'read' });
  });
});

describe('the guard', () => {
  it('refuses to be built without the sensitive-path predicate', () => {
    // A guard is the one stage nobody can overrule; one that guessed at sensitivity would
    // refuse the wrong paths and, worse, look like it had checked.
    expect(() => createGuard({})).toThrow(TypeError);
  });

  it('lets ordinary reads and writes through', () => {
    expect(guard({ name: 'at_terminal_sftp_read_file', arguments: { path: '/etc/passwd' } })).toBeUndefined();
    expect(guard({ name: 'at_terminal_sftp_write_file', arguments: { path: '/etc/hosts' } })).toBeUndefined();
    expect(guard({ name: 'at_terminal_sftp_delete', arguments: { path: '/srv/app/old.log' } })).toBeUndefined();
  });

  it('refuses a delete of a sensitive path, and names the way out', () => {
    for (const path of ['/etc/cron.d/backup', '/home/deploy/.ssh/authorized_keys', '/etc/systemd/system/x.service']) {
      const reason = guard({ name: 'at_terminal_sftp_delete', arguments: { path } });
      expect(reason).toContain('sensitive system path');
      expect(reason).toContain('at_terminal_run_remote_command');
    }
  });

  it('refuses an AT Terminal tool that has no classification', () => {
    // Fail closed: registering a tool and forgetting the row is how an unguarded entry point
    // would appear, and a guard that shrugged would be the wrong default.
    expect(guard({ name: 'at_terminal_sftp_copy', arguments: {} })).toContain('no row in dsh/policy.js');
  });

  it('does not throw on missing or non-string arguments', () => {
    expect(guard({ name: 'at_terminal_sftp_delete' })).toBeUndefined();
    expect(guard({ name: 'at_terminal_sftp_delete', arguments: { path: 42 } })).toBeUndefined();
    expect(guard({})).toBeUndefined();
  });
});

describe('the pre-execute stage', () => {
  const copy = { reason: 'Remote command requires confirmation: uptime', displayReason: 'THE DIALOG' };

  function stage(overrides: Partial<{ authorize: (input: unknown) => Promise<unknown> }> = {}) {
    const authorize = vi.fn(
      overrides.authorize ??
        (async () => ({
          serverLabel: 'Production',
          host: 'prod.example.com',
          autoApprove: false,
          destructive: false,
          riskSummaries: []
        }))
    );
    const formatApprovalCopy = vi.fn(() => copy);
    const preExecute = createPreExecute({ authorize, formatApprovalCopy });
    return { preExecute, authorize, formatApprovalCopy };
  }

  const next = () => Promise.resolve({ kind: 'allow', viaNext: true });

  it('refuses to be built without both collaborators', () => {
    expect(() => createPreExecute({})).toThrow(TypeError);
    expect(() => createPreExecute({ authorize: async () => ({}) })).toThrow(TypeError);
  });

  it('lets the built-in probe through without asking anybody', async () => {
    const { preExecute, authorize } = stage();
    const decision = await preExecute({ name: 'at_terminal_get_hardware_metrics', arguments: {} }, next);
    expect(decision).toEqual({ kind: 'allow' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('leaves SFTP writes to the authorizer that already owns them', async () => {
    // A per-call ask here would replace the directory-scoped grants the UI offers with a
    // weaker prompt, so this stage does not touch write tools at all.
    const { preExecute, authorize } = stage();
    for (const name of [
      'at_terminal_sftp_write_file',
      'at_terminal_sftp_delete',
      'at_terminal_sftp_rename',
      'at_terminal_ping'
    ]) {
      const decision = await preExecute({ name, arguments: { path: '/srv/a' } }, next);
      expect(decision).toEqual({ kind: 'allow', viaNext: true });
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it('falls through for an empty command, letting the tool report it', async () => {
    const { preExecute, authorize } = stage();
    const decision = await preExecute({ name: 'at_terminal_run_remote_command', arguments: { command: '   ' } }, next);
    expect(decision).toEqual({ kind: 'allow', viaNext: true });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('falls through when it cannot decide, instead of denying', async () => {
    // A failed authorization is not an approval. Falling through leaves the tool body's own
    // check — and its own error message — in charge, which is exactly the 0.2.0 behaviour.
    const { preExecute } = stage({
      authorize: async () => {
        throw new Error('the services are still starting');
      }
    });
    const decision = await preExecute({ name: 'at_terminal_run_remote_command', arguments: { command: 'uptime' } }, next);
    expect(decision).toEqual({ kind: 'allow', viaNext: true });
  });

  it('allows a command the server trusts, and records that nobody was asked', async () => {
    const { preExecute } = stage({
      authorize: async () => ({
        serverLabel: 'Production',
        host: 'prod.example.com',
        autoApprove: true,
        destructive: false,
        riskSummaries: []
      })
    });
    const exec: Record<string, unknown> = { name: 'at_terminal_run_remote_command', arguments: { command: 'uptime' } };
    expect(await preExecute(exec, next)).toEqual({ kind: 'allow' });
    expect(readPreExecuteDecision(exec)).toBe('auto-approved');
  });

  it('asks for a command the policy does not clear, using the one dialog builder', async () => {
    const { preExecute, formatApprovalCopy } = stage();
    const exec: Record<string, unknown> = {
      name: 'at_terminal_run_remote_command',
      arguments: { command: 'systemctl restart nginx', cwd: '/srv' }
    };
    const decision = await preExecute(exec, next);
    expect(decision).toEqual({ kind: 'ask', reason: copy.reason, displayReason: copy.displayReason });
    expect(formatApprovalCopy).toHaveBeenCalledWith({
      serverLabel: 'Production',
      host: 'prod.example.com',
      command: 'systemctl restart nginx',
      destructive: false,
      riskSummaries: []
    });
    expect(readPreExecuteDecision(exec)).toBe('asked');
  });

  it('normalises the target so the body is not asked twice for the same command', async () => {
    const { preExecute, authorize } = stage();
    const exec = { name: 'at_terminal_run_remote_command', arguments: { command: '  uptime ', serverId: 'srv-1' } };
    await preExecute(exec, next);
    expect(authorize).toHaveBeenCalledWith({ serverId: 'srv-1', command: 'uptime', cwd: undefined });
    expect(readPreExecuteDecision(exec)).toBe('asked');
  });
});

describe('the pre-execute hand-off', () => {
  it("is per execution, so one call cannot inherit another call's answer", () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    recordDecision(first, 'asked');
    expect(readPreExecuteDecision(first)).toBe('asked');
    expect(readPreExecuteDecision(second)).toBeUndefined();
    // A non-object must be ignored rather than throw: `exec` is the registry's, but a
    // direct service call has none.
    expect(() => recordDecision(undefined, 'asked')).not.toThrow();
    expect(readPreExecuteDecision('not an object')).toBeUndefined();
  });
});
