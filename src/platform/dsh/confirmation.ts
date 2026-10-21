import type { AgentConfirmationPort, CommandConfirmationRequest } from '../../agent/AgentConfirmationPort';
import type { SftpWriteConfirmation, SftpWriteScope } from '../../agent/SftpWriteAuthorizer';
import { formatRemoteCommandConfirmMessage } from '../../utils/commandPreview';

export interface DshApprovalRequest {
  agent: string;
  toolName: string;
  callId?: string;
  reason: string;
  displayReason?: string;
  signal?: AbortSignal;
}

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface DshApprovalService {
  request(req: DshApprovalRequest): Promise<DshApprovalOutcome>;
}

export interface DshCallContext {
  agent?: string;
  callId?: string;
  signal?: AbortSignal;
}

export class DshAgentConfirmation implements AgentConfirmationPort {
  constructor(
    private readonly options: {
      resolveApproval: () => DshApprovalService | undefined;
      getCurrentCallContext: () => DshCallContext | undefined;
    }
  ) {}

  async confirmCommand(request: CommandConfirmationRequest): Promise<boolean> {
    if (request.signal?.aborted) {
      return false;
    }

    const approval = this.options.resolveApproval();
    const callCtx = this.options.getCurrentCallContext();

    if (callCtx?.signal?.aborted) {
      return false;
    }

    if (!approval || !callCtx?.agent) {
      throw new Error(
        `Command "${request.command}" requires approval, but no human approval channel is available.`
      );
    }

    const { reason, displayReason } = buildCommandApprovalCopy({
      serverLabel: request.serverLabel,
      host: request.host,
      command: request.command,
      destructive: request.destructive,
      riskSummaries: request.riskSummaries
    });

    const outcome = await approval.request({
      agent: callCtx.agent,
      toolName: 'run_remote_command',
      callId: callCtx.callId,
      reason,
      displayReason,
      signal: request.signal ?? callCtx.signal
    });

    return outcome === 'allowed-once';
  }

  async confirmSftpWrite(confirmation: SftpWriteConfirmation): Promise<SftpWriteScope | undefined> {
    const approval = this.options.resolveApproval();
    const callCtx = this.options.getCurrentCallContext();

    if (callCtx?.signal?.aborted) {
      return undefined;
    }

    if (!approval || !callCtx?.agent) {
      throw new Error(
        `SFTP write to "${confirmation.request.path}" requires approval, but no approval channel is available.`
      );
    }

    const reason =
      confirmation.stage === 'sensitive-double-check'
        ? `Double confirmation required for sensitive path: ${confirmation.request.path}`
        : `SFTP write requested: ${confirmation.request.path}`;

    const displayReason = formatSftpWriteConfirmMessage(confirmation);

    const outcome = await approval.request({
      agent: callCtx.agent,
      toolName: confirmation.request.operation,
      callId: callCtx.callId,
      reason,
      displayReason,
      signal: callCtx.signal
    });

    return outcome === 'allowed-once' ? 'once' : undefined;
  }
}

/**
 * The two strings a remote-command approval is made of.
 *
 * Extracted because the same question is now asked from two places: this class (the tool
 * body, when the registry stage did not run) and `dsh/policy.js` (the registry's
 * `tools/pre-execute` stage). Two builders would drift on the first wording change, and the
 * plan's acceptance criterion for 0.2.1 is that the dialog text is unchanged — which is only
 * structural if there is one builder.
 */
export function buildCommandApprovalCopy(request: {
  serverLabel: string;
  host: string;
  command: string;
  destructive: boolean;
  riskSummaries?: readonly string[];
}): { reason: string; displayReason: string } {
  const reason = request.destructive
    ? `⚠️ Destructive command warning: ${request.command}`
    : `Remote command requires confirmation: ${request.command}`;

  const baseMessage = formatRemoteCommandConfirmMessage({
    serverLabel: request.serverLabel,
    host: request.host,
    command: request.command,
    destructive: request.destructive,
    riskSummaries: request.riskSummaries
  });

  const displayReason = request.destructive
    ? `⚠️ Destructive command warning: this command appears destructive!\n\n${baseMessage}`
    : baseMessage;

  return { reason, displayReason };
}

export function formatSftpWriteConfirmMessage(confirmation: SftpWriteConfirmation): string {
  const { server, request } = confirmation;
  const isDelete = request.operation === 'delete_file';
  const warnings: string[] = [];

  if (confirmation.outsideWorkspace) {
    warnings.push(
      `WARNING: outside the working directory ${confirmation.workspaceRoot} that this session was opened in.`
    );
  }
  if (confirmation.sensitive) {
    warnings.push('WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).');
  }

  if (confirmation.stage === 'sensitive-double-check') {
    return [
      `Double confirmation required: ${request.path} is a sensitive system path on ${server.label} (${server.host}).`,
      '',
      isDelete
        ? 'Deleting here can break logins, services, or scheduled jobs on the server.'
        : 'Writing here can grant persistent access: authorized keys, sudo rules, cron entries and service units survive without you.',
      '',
      'Confirm to allow this single operation.'
    ].join('\n');
  }

  return [
    `Allow AT Terminal agent SFTP ${isDelete ? 'deletion' : 'write'} on ${server.label} (${server.host})?`,
    '',
    `Operation: ${request.operation}`,
    `Path: ${request.path}`,
    `Folder: ${confirmation.parentDirectory}`,
    ...(request.overwrite !== undefined ? [`Overwrite: ${request.overwrite ? 'yes' : 'no'}`] : []),
    ...(warnings.length > 0 ? ['', ...warnings] : [])
  ].join('\n');
}
