import type { AgentConfirmationPort, CommandConfirmationRequest } from '../../agent/AgentConfirmationPort';
import type { SftpWriteConfirmation, SftpWriteScope } from '../../agent/SftpWriteAuthorizer';
import { formatRemoteCommandConfirmMessage } from '../../utils/commandPreview';

export interface DshApprovalRequest {
  /**
   * The live Agent the Host handed this tool call. Opaque here on purpose: this layer only
   * passes it back to `ctx.approval` (which reads `agent.session`) and `ctx.userQuestions`
   * (which compares it against the registry's live instance). It was typed `string`, which was
   * simply wrong — the value is an object.
   */
  agent: unknown;
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

/** One option of a question; `label` is what comes back in `selected`. */
export interface DshUserQuestionOption {
  label: string;
  description?: string;
}

export interface DshUserQuestion {
  id: string;
  question: string;
  header?: string;
  options?: readonly DshUserQuestionOption[];
  multiSelect?: boolean;
}

export interface DshUserQuestionAnswer {
  id: string;
  selected: readonly string[];
  custom?: string;
}

/**
 * `ctx.userQuestions`. Only `ask` is used: this plugin never answers someone else's question.
 *
 * `ask` requires the **exact live root agent** when one is supplied (`CALLER_NOT_LIVE` /
 * `DELEGATED_CALLER`), which is why the call context carries the object rather than an id.
 */
export interface DshUserQuestionsService {
  ask(request: {
    questions: readonly DshUserQuestion[];
    agent?: unknown;
    signal?: AbortSignal;
  }): Promise<{ answers: readonly DshUserQuestionAnswer[] }>;
}

export interface DshCallContext {
  /** See `DshApprovalRequest.agent`: the live object, opaque to this layer. */
  agent?: unknown;
  callId?: string;
  signal?: AbortSignal;
}

/**
 * One line for the log: a `UserQuestionError` carries its reason in `code` (`NO_PROVIDER`,
 * `DELEGATED_CALLER`, `CALLER_NOT_LIVE`, `ASK_ABORTED`), and a bare `name` would hide the only
 * part that says *why* the question could not be asked.
 */
function describeAskFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Stable identity of the scope question; the answer batch is matched on it. */
const SCOPE_QUESTION_ID = 'at-terminal-sftp-write-scope';

/**
 * The three grants, in the order they are offered.
 *
 * `allowedScopes` decides which of them appear: a sensitive path offers one, and a path outside
 * the folder the session was opened in never offers `session`. The dialog must not invent an
 * answer the authorizer would reject — it filters this table rather than writing its own.
 */
const SCOPE_CHOICES: ReadonlyArray<{
  scope: SftpWriteScope;
  label: string;
  describe: (confirmation: SftpWriteConfirmation) => string;
}> = [
  {
    scope: 'once',
    label: 'Allow Once',
    describe: () => 'Ask again before the next write.'
  },
  {
    scope: 'directory',
    label: 'Allow This Folder For 15 Minutes',
    describe: (confirmation) =>
      `Any write in ${confirmation.parentDirectory} without asking, for 15 minutes.`
  },
  {
    scope: 'session',
    label: 'Allow This Folder For The Session',
    describe: (confirmation) =>
      `Any write in ${confirmation.parentDirectory} without asking until the session ends.`
  }
];

export class DshAgentConfirmation implements AgentConfirmationPort {
  constructor(
    private readonly options: {
      resolveApproval: () => DshApprovalService | undefined;
      getCurrentCallContext: () => DshCallContext | undefined;
      /**
       * `ctx.userQuestions`, read per call: which preset supplies it is a runtime fact, and its
       * absence must degrade the *question*, not the write.
       */
      resolveUserQuestions?: () => DshUserQuestionsService | undefined;
      logger?: { warn(message: string): void };
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

  /** Set once, so a composition without an answerer does not warn on every write. */
  private scopePromptWarned = false;

  async confirmSftpWrite(confirmation: SftpWriteConfirmation): Promise<SftpWriteScope | undefined> {
    const callCtx = this.options.getCurrentCallContext();

    if (callCtx?.signal?.aborted) {
      return undefined;
    }

    const approval = this.options.resolveApproval();
    if (!approval || !callCtx?.agent) {
      throw new Error(
        `SFTP write to "${confirmation.request.path}" requires approval, but no approval channel is available.`
      );
    }

    // More than one grant on offer means the human is choosing *how long*, not *whether* — a
    // question with options, which `approval` has no vocabulary for. With a single grant (a
    // sensitive path, the double check, a delete) the plain yes/no dialog is the whole
    // question, and adding options would imply a choice that does not exist.
    if (confirmation.allowedScopes.length > 1) {
      const asked = await this.askWriteScope(confirmation, callCtx);
      // `asked` without a scope means the human closed the question: that is a no, and asking
      // the yes/no dialog afterwards would be asking twice for the same decision.
      if (asked.asked) {
        return asked.scope;
      }
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

  /**
   * Ask which grant to use.
   *
   * `asked: false` means the question could not be put to anyone — no `userQuestions` service, a
   * child agent (`DELEGATED_CALLER`), or no answerer registered (`NO_PROVIDER`). The caller then
   * falls back to the yes/no approval, because a missing UI must cost the *remembered grant*
   * and not the write itself.
   */
  private async askWriteScope(
    confirmation: SftpWriteConfirmation,
    callCtx: DshCallContext
  ): Promise<{ asked: true; scope?: SftpWriteScope } | { asked: false }> {
    const questions = this.options.resolveUserQuestions?.();
    if (!questions) {
      this.warnScopeUnavailable('no userQuestions service');
      return { asked: false };
    }

    const offered = SCOPE_CHOICES.filter((choice) =>
      confirmation.allowedScopes.includes(choice.scope)
    );
    try {
      const answer = await questions.ask({
        questions: [
          {
            id: SCOPE_QUESTION_ID,
            header: 'SFTP write',
            question: formatSftpWriteConfirmMessage(confirmation),
            options: offered.map((choice) => ({
              label: choice.label,
              description: choice.describe(confirmation)
            }))
          }
        ],
        agent: callCtx.agent,
        signal: callCtx.signal
      });
      const selected = answer.answers.find((item) => item.id === SCOPE_QUESTION_ID)?.selected?.[0];
      // An option this call did not offer is not a grant: never widen what the authorizer
      // allowed, whatever a UI sends back.
      return { asked: true, scope: offered.find((choice) => choice.label === selected)?.scope };
    } catch (error) {
      this.warnScopeUnavailable(describeAskFailure(error));
      return { asked: false };
    }
  }

  private warnScopeUnavailable(detail: string): void {
    if (this.scopePromptWarned) return;
    this.scopePromptWarned = true;
    this.options.logger?.warn?.(
      `at-terminal: the SFTP write scope question is unavailable (${detail}); falling back to a one-time approval`
    );
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
