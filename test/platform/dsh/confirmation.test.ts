import { describe, it, expect, vi } from 'vitest';
import { SftpWriteAuthorizer } from '../../../src/agent/SftpWriteAuthorizer';
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

/**
 * A confirmation with every field filled in, so each test states only what it is about.
 *
 * `Object.assign` rather than a spread: spreading `Partial<…>` widens each optional field to
 * `T | undefined`, which the required `sensitiveLocal` rejects, and a cast would hide a real
 * omission the next time the interface grows a field.
 */
function sftpConfirmation(
  overrides: Partial<SftpWriteConfirmation> = {}
): SftpWriteConfirmation {
  return Object.assign(
    {
      server: createDummyServer(),
      request: {
        operation: 'write_file',
        path: '/srv/app/config.yml',
        overwrite: true,
        workspaceRoot: '/srv/app'
      },
      parentDirectory: '/srv/app',
      workspaceRoot: '/srv/app',
      outsideWorkspace: false,
      sensitive: false,
      sensitiveLocal: false,
      allowedScopes: ['once', 'directory', 'session'],
      stage: 'primary'
    } satisfies SftpWriteConfirmation,
    overrides
  );
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
      sensitiveLocal: false,
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
      sensitiveLocal: false,
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
      sensitiveLocal: false,
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
      sensitiveLocal: false,
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
      sensitiveLocal: false,
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

/**
 * The three write grants.
 *
 * `SftpWriteAuthorizer` has always computed which grants are on offer (a sensitive path gets
 * one, a path outside the opened folder never gets `session`) and applied them; what was
 * missing is that `ctx.approval` can only answer yes or no, so every answer collapsed to
 * `once`. These cases cover the seam that turns "how long?" into a question with options —
 * and, just as importantly, what happens when nobody can be asked.
 */
describe('the SFTP write scope question', () => {
  const agent = { id: 'agent-1', session: { id: 'session-1' } };

  it('offers every grant the authorizer allows, and returns the chosen one', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const questions = {
      ask: vi.fn().mockResolvedValue({ answers: [{ id: 'at-terminal-sftp-write-scope', selected: ['Allow This Folder For 15 Minutes'] }] })
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      resolveUserQuestions: () => questions,
      getCurrentCallContext: () => ({ agent, callId: 'call-9' })
    });

    const scope = await confirmation.confirmSftpWrite(sftpConfirmation());

    expect(scope).toBe('directory');
    // The yes/no dialog is not a second step: one question, one answer.
    expect(approval.request).not.toHaveBeenCalled();
    const [request] = questions.ask.mock.calls[0];
    expect(request.questions).toHaveLength(1);
    expect(request.questions[0].options.map((option: { label: string }) => option.label)).toEqual([
      'Allow Once',
      'Allow This Folder For 15 Minutes',
      'Allow This Folder For The Session'
    ]);
    // The live agent object is forwarded unchanged: `userQuestions` compares it against the
    // registry's instance and rejects anything else (CALLER_NOT_LIVE).
    expect(request.agent).toBe(agent);
    expect(request.signal).toBeUndefined();
  });

  it('never offers a session grant outside the folder the session was opened in', async () => {
    const questions = { ask: vi.fn().mockResolvedValue({ answers: [{ id: 'at-terminal-sftp-write-scope', selected: ['Allow This Folder For 15 Minutes'] }] }) };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => ({ request: vi.fn().mockResolvedValue('allowed-once') }),
      resolveUserQuestions: () => questions,
      getCurrentCallContext: () => ({ agent })
    });

    const scope = await confirmation.confirmSftpWrite(
      sftpConfirmation({ outsideWorkspace: true, allowedScopes: ['once', 'directory'] })
    );

    expect(scope).toBe('directory');
    const labels = questions.ask.mock.calls[0][0].questions[0].options.map(
      (option: { label: string }) => option.label
    );
    expect(labels).toEqual(['Allow Once', 'Allow This Folder For 15 Minutes']);
    expect(labels).not.toContain('Allow This Folder For The Session');
  });

  it('asks nothing when only one grant exists, and keeps the plain yes/no dialog', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const questions = { ask: vi.fn() };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      resolveUserQuestions: () => questions,
      getCurrentCallContext: () => ({ agent })
    });

    const scope = await confirmation.confirmSftpWrite(
      sftpConfirmation({ sensitive: true, allowedScopes: ['once'] })
    );

    expect(scope).toBe('once');
    // A sensitive path cannot be remembered, so offering "how long" would offer a lie.
    expect(questions.ask).not.toHaveBeenCalled();
    expect(approval.request).toHaveBeenCalledTimes(1);
  });

  it('treats an answer that names an option it never offered as a no, not as a yes', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const questions = {
      ask: vi.fn().mockResolvedValue({ answers: [{ id: 'at-terminal-sftp-write-scope', selected: ['Allow This Folder For The Session'] }] })
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      resolveUserQuestions: () => questions,
      getCurrentCallContext: () => ({ agent })
    });

    // `session` was not on offer (outside the folder). Whatever a UI sends back must not widen
    // what the authorizer allowed, and an invalid answer is not consent.
    const scope = await confirmation.confirmSftpWrite(
      sftpConfirmation({ outsideWorkspace: true, allowedScopes: ['once', 'directory'] })
    );

    expect(scope).toBeUndefined();
    expect(approval.request).not.toHaveBeenCalled();
  });

  it('falls back to a one-time grant when no answerer exists, and warns only once', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const logger = { warn: vi.fn() };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      // The composition has no `userQuestions`: a missing UI must cost the remembered grant,
      // not the write.
      resolveUserQuestions: () => undefined,
      logger,
      getCurrentCallContext: () => ({ agent })
    });

    expect(await confirmation.confirmSftpWrite(sftpConfirmation())).toBe('once');
    expect(await confirmation.confirmSftpWrite(sftpConfirmation())).toBe('once');

    expect(approval.request).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('scope question is unavailable');
  });

  it('falls back when the service refuses a child agent, and says which refusal it was', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const logger = { warn: vi.fn() };
    const refusal = Object.assign(new Error('human interaction is unavailable for a child agent'), {
      code: 'DELEGATED_CALLER'
    });
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      resolveUserQuestions: () => ({ ask: vi.fn().mockRejectedValue(refusal) }),
      logger,
      getCurrentCallContext: () => ({ agent })
    });

    const scope = await confirmation.confirmSftpWrite(sftpConfirmation());

    expect(scope).toBe('once');
    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('DELEGATED_CALLER');
  });

  it('does not fall back to a second dialog when the question was closed', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      // Answered with nothing: the human dismissed the question. Asking a yes/no dialog after
      // that would be asking twice for one decision.
      resolveUserQuestions: () => ({
        ask: vi.fn().mockResolvedValue({ answers: [{ id: 'at-terminal-sftp-write-scope', selected: [] }] })
      }),
      getCurrentCallContext: () => ({ agent })
    });

    expect(await confirmation.confirmSftpWrite(sftpConfirmation())).toBeUndefined();
    expect(approval.request).not.toHaveBeenCalled();
  });
});

describe('choosing a write grant', () => {
  it('stops asking inside the folder for the chosen window, and asks again elsewhere', async () => {
    const agent = { id: 'agent-1', session: { id: 'session-1' } };
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const questions = {
      ask: vi.fn().mockResolvedValue({
        answers: [{ id: 'at-terminal-sftp-write-scope', selected: ['Allow This Folder For 15 Minutes'] }]
      })
    };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      resolveUserQuestions: () => questions,
      getCurrentCallContext: () => ({ agent })
    });
    let now = 1_000;
    const authorizer = new SftpWriteAuthorizer({
      confirm: (request) => confirmation.confirmSftpWrite(request),
      now: () => now
    });
    const server = createDummyServer();
    const write = (path: string) => ({
      operation: 'write_file' as const,
      path,
      overwrite: true,
      workspaceRoot: '/srv/app'
    });

    await authorizer.requireWrite(server, write('/srv/app/a.yml'));
    expect(questions.ask).toHaveBeenCalledTimes(1);

    // Same folder, still inside the window: no dialog at all.
    now += 60_000;
    await authorizer.requireWrite(server, write('/srv/app/b.yml'));
    expect(questions.ask).toHaveBeenCalledTimes(1);

    // A different folder was never granted.
    await authorizer.requireWrite(server, write('/srv/other/c.yml'));
    expect(questions.ask).toHaveBeenCalledTimes(2);

    // Past the window the first folder asks again, which is the whole point of "15 minutes".
    now += 16 * 60_000;
    await authorizer.requireWrite(server, write('/srv/app/d.yml'));
    expect(questions.ask).toHaveBeenCalledTimes(3);
  });
});

/**
 * The upload dialog.
 *
 * A write confirmation names the remote path, and until now that was the whole question. An
 * upload has two ends, and the interesting one is the *local* end: a human approving "send this
 * to the server" has to be able to see which file on their own machine is about to leave it, and
 * a credential on either side has to ask twice. These cases pin the copy, not just the presence
 * of a warning.
 */
describe('the upload confirmation', () => {
  const agent = { id: 'agent-1', session: { id: 'session-1' } };

  function uploadConfirmation(
    overrides: Partial<SftpWriteConfirmation> = {}
  ): SftpWriteConfirmation {
    return sftpConfirmation({
      request: {
        operation: 'upload_local_file',
        path: '/opt/at-pc/at-pc-server',
        overwrite: true,
        workspaceRoot: '/opt/at-pc',
        localPath: '/Users/clkj/dist/at-pc-server',
        localBytes: 7_692_224
      },
      parentDirectory: '/opt/at-pc',
      workspaceRoot: '/opt/at-pc',
      allowedScopes: ['once'],
      ...overrides
    });
  }

  it('names the local source and its size, and never asks how long the grant lasts', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const questions = { ask: vi.fn() };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      resolveUserQuestions: () => questions,
      getCurrentCallContext: () => ({ agent, callId: 'call-upload' })
    });

    const scope = await confirmation.confirmSftpWrite(uploadConfirmation());

    expect(scope).toBe('once');
    // An upload cannot be remembered, so offering "15 minutes" or "this session" would offer a
    // grant the authorizer refuses to honor.
    expect(questions.ask).not.toHaveBeenCalled();
    const [request] = approval.request.mock.calls[0];
    expect(request.toolName).toBe('upload_local_file');
    // The reason is the half of the approval event a log or a notification keeps — the body is
    // not rendered everywhere — so it has to name both ends on its own.
    expect(request.reason).toBe(
      'SFTP upload requested: /Users/clkj/dist/at-pc-server -> /opt/at-pc/at-pc-server'
    );
    expect(request.displayReason).toBe(
      [
        'Allow AT Terminal agent SFTP upload on Production Server (1.2.3.4)?',
        '',
        'Operation: upload_local_file',
        'Path: /opt/at-pc/at-pc-server',
        'Folder: /opt/at-pc',
        'Local source: /Users/clkj/dist/at-pc-server (7.3 MB)',
        'Overwrite: yes'
      ].join('\n')
    );
  });

  it('warns when the local source is a credential', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      getCurrentCallContext: () => ({ agent })
    });

    await confirmation.confirmSftpWrite(
      uploadConfirmation({
        request: {
          operation: 'upload_local_file',
          path: '/opt/app/key',
          overwrite: true,
          workspaceRoot: '/opt/app',
          localPath: '/Users/clkj/.ssh/id_rsa',
          localBytes: 1_675
        },
        sensitiveLocal: true
      })
    );

    expect(approval.request.mock.calls[0][0].displayReason).toContain(
      'WARNING: sensitive local file (SSH keys, cloud credentials, or environment secrets).'
    );
  });

  it('double-checks a sensitive local source on its own, naming the file that would leave', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      getCurrentCallContext: () => ({ agent })
    });

    await confirmation.confirmSftpWrite(
      uploadConfirmation({
        request: {
          operation: 'upload_local_file',
          path: '/opt/app/key',
          overwrite: true,
          workspaceRoot: '/opt/app',
          localPath: '/Users/clkj/.ssh/id_rsa',
          localBytes: 1_675
        },
        sensitive: false,
        sensitiveLocal: true,
        stage: 'sensitive-double-check'
      })
    );

    const [request] = approval.request.mock.calls[0];
    // The remote path is ordinary here; a dialog that only names it would describe a harmless
    // write while a private key is what actually moves.
    expect(request.reason).toBe(
      'Double confirmation required for sensitive local file: /Users/clkj/.ssh/id_rsa'
    );
    expect(request.displayReason).toBe(
      [
        'Double confirmation required for sensitive local file: /Users/clkj/.ssh/id_rsa',
        '',
        'This upload sends the contents of a local file to the server, where the remote account and anything watching it can read them.',
        '',
        'Local source: /Users/clkj/.ssh/id_rsa (1.6 KB)',
        'Path: /opt/app/key',
        '',
        'Confirm to allow this single operation.'
      ].join('\n')
    );
  });

  it('shows both ends when the remote path is the sensitive one', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      getCurrentCallContext: () => ({ agent })
    });

    await confirmation.confirmSftpWrite(
      uploadConfirmation({
        request: {
          operation: 'upload_local_file',
          path: '/root/.ssh/authorized_keys',
          overwrite: true,
          workspaceRoot: '/root/.ssh',
          localPath: '/Users/clkj/.ssh/id_rsa.pub',
          localBytes: 400
        },
        parentDirectory: '/root/.ssh',
        workspaceRoot: '/root/.ssh',
        outsideWorkspace: true,
        sensitive: true,
        sensitiveLocal: true,
        stage: 'sensitive-double-check'
      })
    );

    const [request] = approval.request.mock.calls[0];
    expect(request.reason).toBe(
      'Double confirmation required for sensitive path: /root/.ssh/authorized_keys'
    );
    const lines = request.displayReason.split('\n');
    expect(lines[0]).toBe(
      'Double confirmation required: /root/.ssh/authorized_keys is a sensitive system path on Production Server (1.2.3.4).'
    );
    expect(request.displayReason).toContain('Local source: /Users/clkj/.ssh/id_rsa.pub (400 B)');
    expect(request.displayReason).toContain('Path: /root/.ssh/authorized_keys');
  });

  it('leaves the text-write dialog exactly as it was', async () => {
    const approval = { request: vi.fn().mockResolvedValue('allowed-once') };
    const confirmation = new DshAgentConfirmation({
      resolveApproval: () => approval,
      getCurrentCallContext: () => ({ agent })
    });

    await confirmation.confirmSftpWrite(sftpConfirmation());

    const [request] = approval.request.mock.calls[0];
    expect(request.reason).toBe('SFTP write requested: /srv/app/config.yml');
    expect(request.displayReason).toBe(
      [
        'Allow AT Terminal agent SFTP write on Production Server (1.2.3.4)?',
        '',
        'Operation: write_file',
        'Path: /srv/app/config.yml',
        'Folder: /srv/app',
        'Overwrite: yes'
      ].join('\n')
    );
    expect(request.displayReason).not.toContain('Local source');
  });
});
