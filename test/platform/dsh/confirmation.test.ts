import { describe, it, expect, vi } from 'vitest';
import { DshAgentConfirmation, buildCommandApprovalCopy } from '../../../src/platform/dsh/confirmation';
import type { ServerConfig } from '../../../src/config/schema';
import type { SftpWriteConfirmation } from '../../../src/agent/SftpWriteAuthorizer';

function createDummyServer(): ServerConfig {
  return {
    id: 'prod-srv',
    label: 'Production Server',
    host: '1.2.3.4',
    port: 22,
    username: 'admin',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('DshAgentConfirmation', () => {
  it('delegates command confirmation to dsh approval provider when present', async () => {
    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once')
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'agent-1', callId: 'call-1' })
    });

    const approved = await confirmation.confirmCommand({
      serverLabel: 'prod-srv',
      host: '1.2.3.4',
      command: 'rm -rf /tmp/data',
      destructive: true,
      riskSummaries: ['destroys files']
    });

    expect(approved).toBe(true);
    expect(mockApproval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'run_remote_command',
        agent: 'agent-1',
        callId: 'call-1',
        reason: '⚠️ Destructive command warning: rm -rf /tmp/data',
        displayReason: expect.stringContaining('⚠️ Destructive command warning: this command appears destructive!')
      })
    );
  });

  it('rejects command when user rejects dsh approval', async () => {
    const mockApproval = {
      request: vi.fn().mockResolvedValue('rejected')
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'agent-1', callId: 'call-1' })
    });

    const approved = await confirmation.confirmCommand({
      serverLabel: 'srv',
      host: '1.2.3.4',
      command: 'systemctl restart nginx',
      destructive: false,
      riskSummaries: []
    });

    expect(approved).toBe(false);
  });

  it('fails safely when approval channel is absent', async () => {
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => undefined,
      getCurrentCallContext: () => undefined
    });

    await expect(
      confirmation.confirmCommand({
        serverLabel: 'srv',
        host: '1.2.3.4',
        command: 'systemctl stop app',
        destructive: false,
        riskSummaries: []
      })
    ).rejects.toThrow(/no.*approval channel/i);
  });

  it('delegates sftp write confirmation to dsh approval provider', async () => {
    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once')
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'agent-1', callId: 'call-sftp' })
    });

    const sftpReq: SftpWriteConfirmation = {
      server: createDummyServer(),
      request: {
        operation: 'write_file',
        path: '/tmp/test.txt',
        overwrite: true,
        workspaceRoot: '/tmp'
      },
      parentDirectory: '/tmp',
      workspaceRoot: '/tmp',
      outsideWorkspace: false,
      sensitive: false,
      allowedScopes: ['once', 'directory', 'session'],
      stage: 'primary'
    };

    const scope = await confirmation.confirmSftpWrite(sftpReq);
    expect(scope).toBe('once');
    expect(mockApproval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'write_file',
        agent: 'agent-1'
      })
    );
  });

  it('rejects sftp write when user rejects approval', async () => {
    const mockApproval = {
      request: vi.fn().mockResolvedValue('rejected')
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'agent-1', callId: 'call-sftp' })
    });

    const sftpReq: SftpWriteConfirmation = {
      server: createDummyServer(),
      request: {
        operation: 'delete_file',
        path: '/tmp/test.txt',
        overwrite: false,
        workspaceRoot: '/tmp'
      },
      parentDirectory: '/tmp',
      workspaceRoot: '/tmp',
      outsideWorkspace: false,
      sensitive: false,
      allowedScopes: ['once'],
      stage: 'primary'
    };

    const scope = await confirmation.confirmSftpWrite(sftpReq);
    expect(scope).toBeUndefined();
  });

  it('fails safely when approval channel is absent for sftp write', async () => {
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => undefined,
      getCurrentCallContext: () => undefined
    });

    const sftpReq: SftpWriteConfirmation = {
      server: createDummyServer(),
      request: {
        operation: 'write_file',
        path: '/tmp/test.txt',
        overwrite: true,
        workspaceRoot: '/tmp'
      },
      parentDirectory: '/tmp',
      workspaceRoot: '/tmp',
      outsideWorkspace: false,
      sensitive: false,
      allowedScopes: ['once'],
      stage: 'primary'
    };

    await expect(confirmation.confirmSftpWrite(sftpReq)).rejects.toThrow(/no approval channel/i);
  });

  it('returns false immediately when command confirmation is pre-aborted', async () => {
    const mockApproval = { request: vi.fn() };
    const abortController = new AbortController();
    abortController.abort();

    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'agent-1' })
    });

    const approved = await confirmation.confirmCommand({
      serverLabel: 'srv',
      host: '1.2.3.4',
      command: 'echo pre-aborted',
      destructive: false,
      riskSummaries: [],
      signal: abortController.signal
    });

    expect(approved).toBe(false);
    expect(mockApproval.request).not.toHaveBeenCalled();
  });

  it('returns undefined immediately when sftp write confirmation is pre-aborted', async () => {
    const mockApproval = { request: vi.fn() };
    const abortController = new AbortController();
    abortController.abort();

    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'agent-1', signal: abortController.signal })
    });

    const sftpReq: SftpWriteConfirmation = {
      server: createDummyServer(),
      request: {
        operation: 'write_file',
        path: '/tmp/test.txt',
        overwrite: true,
        workspaceRoot: '/tmp'
      },
      parentDirectory: '/tmp',
      workspaceRoot: '/tmp',
      outsideWorkspace: false,
      sensitive: false,
      allowedScopes: ['once'],
      stage: 'primary'
    };

    const scope = await confirmation.confirmSftpWrite(sftpReq);
    expect(scope).toBeUndefined();
    expect(mockApproval.request).not.toHaveBeenCalled();
  });

  it('includes rich displayReason for sensitive double-check in sftp write', async () => {
    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once')
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'agent-1' })
    });

    const sftpReq: SftpWriteConfirmation = {
      server: createDummyServer(),
      request: {
        operation: 'write_file',
        path: '/root/.ssh/authorized_keys',
        overwrite: true,
        workspaceRoot: '/home/user'
      },
      parentDirectory: '/root/.ssh',
      workspaceRoot: '/home/user',
      outsideWorkspace: true,
      sensitive: true,
      allowedScopes: ['once'],
      stage: 'sensitive-double-check'
    };

    const scope = await confirmation.confirmSftpWrite(sftpReq);
    expect(scope).toBe('once');
    expect(mockApproval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        displayReason: expect.stringContaining('Double confirmation required')
      })
    );
  });
});

/**
 * The dialog text, verbatim.
 *
 * `tools/pre-execute` now asks the same question from the registry layer, and the acceptance
 * criterion for this change was "the copy does not move". That is only checkable literally:
 * the two tests above use `stringContaining`, which would keep passing while the sentence a
 * user actually reads drifted. These two pin the whole string, so a rewording is a decision
 * rather than an accident.
 */
describe('buildCommandApprovalCopy', () => {
  it('produces the 0.2.0 dialog for an ordinary command', () => {
    expect(
      buildCommandApprovalCopy({
        serverLabel: 'Production Server',
        host: '1.2.3.4',
        command: 'uptime',
        destructive: false
      })
    ).toEqual({
      reason: 'Remote command requires confirmation: uptime',
      displayReason: 'Run remote command on Production Server (1.2.3.4)?\n\nuptime'
    });
  });

  it('produces the 0.2.0 dialog for a destructive command, risk summaries included', () => {
    expect(
      buildCommandApprovalCopy({
        serverLabel: 'Production Server',
        host: '1.2.3.4',
        command: 'rm -rf /tmp/app',
        destructive: true,
        riskSummaries: ['deletes files', 'deletes files', 'recursive']
      })
    ).toEqual({
      reason: '⚠️ Destructive command warning: rm -rf /tmp/app',
      displayReason:
        '⚠️ Destructive command warning: this command appears destructive!\n\n' +
        'Run remote command on Production Server (1.2.3.4)?\n\n' +
        'rm -rf /tmp/app\n\n' +
        'Warning: this command appears destructive.\n\n' +
        '- deletes files\n' +
        '- recursive'
    });
  });

  it('is the only builder: the tool body sends exactly what it returns', async () => {
    // The strings above are only authoritative while `DshAgentConfirmation` uses the same
    // function. Comparing its approval request against this function's own output catches a
    // re-inlined copy without reaching for a module spy (which an intra-module call would
    // not go through anyway).
    const approval = { request: vi.fn().mockResolvedValue('rejected') };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      getCurrentCallContext: () => ({ agent: 'default' })
    });
    const request = {
      serverLabel: 'Production Server',
      host: '1.2.3.4',
      command: 'rm -rf /tmp/app',
      destructive: true,
      riskSummaries: ['deletes files']
    };

    expect(await confirmation.confirmCommand(request)).toBe(false);
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: buildCommandApprovalCopy(request).reason,
        displayReason: buildCommandApprovalCopy(request).displayReason
      })
    );
  });
});
