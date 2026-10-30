import type { AgentConfirmationPort, CommandConfirmationRequest } from '../../agent/AgentConfirmationPort';
import type {
  SftpWriteConfirmation,
  SftpWriteRequest,
  SftpWriteScope
} from '../../agent/SftpWriteAuthorizer';
import { copy } from '../../i18n/copy';
import { formatFileSize } from '../../sftp/FileSize';
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
    label: copy('Allow Once'),
    describe: () => copy('Ask again before the next write.')
  },
  {
    scope: 'directory',
    label: copy('Allow This Folder For 15 Minutes'),
    describe: (confirmation) =>
      copy('Any write in {directory} without asking, for 15 minutes.', {
        directory: confirmation.parentDirectory
      })
  },
  {
    scope: 'session',
    label: copy('Allow This Folder For The Session'),
    describe: (confirmation) =>
      copy('Any write in {directory} without asking until the session ends.', {
        directory: confirmation.parentDirectory
      })
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

    const reason = sftpWriteApprovalReason(confirmation);

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
    ? copy('⚠️ Destructive command warning: {command}', { command: request.command })
    : copy('Remote command requires confirmation: {command}', { command: request.command });

  const baseMessage = formatRemoteCommandConfirmMessage({
    serverLabel: request.serverLabel,
    host: request.host,
    command: request.command,
    destructive: request.destructive,
    riskSummaries: request.riskSummaries
  });

  const displayReason = request.destructive
    ? `${copy('⚠️ Destructive command warning: this command appears destructive!')}\n\n${baseMessage}`
    : baseMessage;

  return { reason, displayReason };
}

/**
 * The one-line reason an SFTP write approval is titled with.
 *
 * The card body carries the detail; this line is what a log, a notification or a collapsed
 * dialog shows. For an upload that means **both ends**: the remote path alone would let a file
 * leave the machine under a title that never says a local file is involved — and the approval
 * event is the only place the source is recorded when the body is not rendered.
 */
function sftpWriteApprovalReason(confirmation: SftpWriteConfirmation): string {
  const { request } = confirmation;
  if (confirmation.stage === 'sensitive-double-check') {
    return confirmation.sensitive
      ? copy('Double confirmation required for sensitive path: {path}', { path: request.path })
      : copy('Double confirmation required for sensitive local file: {path}', {
          path: request.localPath ?? request.path
        });
  }
  if (request.operation !== 'upload_local_file') {
    return copy('SFTP write requested: {path}', { path: request.path });
  }
  // `localPath` is always set by the service for an upload; the single-ended form is the
  // fallback for a confirmation built by hand (tests, or a future caller that forgets it).
  return request.localPath === undefined
    ? copy('SFTP upload requested: {path}', { path: request.path })
    : copy('SFTP upload requested: {localPath} -> {path}', {
        localPath: request.localPath,
        path: request.path
      });
}

export function formatSftpWriteConfirmMessage(confirmation: SftpWriteConfirmation): string {
  const { server, request } = confirmation;
  const isDelete = request.operation === 'delete_file';
  const isUpload = request.operation === 'upload_local_file';
  const localSource = formatLocalSource(request);
  const warnings: string[] = [];

  if (confirmation.outsideWorkspace) {
    warnings.push(
      copy('WARNING: outside the working directory {root} that this session was opened in.', {
        root: confirmation.workspaceRoot
      })
    );
  }
  if (confirmation.sensitive) {
    warnings.push(
      copy('WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).')
    );
  }
  if (confirmation.sensitiveLocal) {
    warnings.push(
      copy('WARNING: sensitive local file (SSH keys, cloud credentials, or environment secrets).')
    );
  }

  if (confirmation.stage === 'sensitive-double-check') {
    return [
      confirmation.sensitive
        ? copy('Double confirmation required: {path} is a sensitive system path on {server} ({host}).', {
            path: request.path,
            server: server.label,
            host: server.host
          })
        : copy('Double confirmation required for sensitive local file: {path}', {
            path: request.localPath ?? request.path
          }),
      '',
      isDelete
        ? copy('Deleting here can break logins, services, or scheduled jobs on the server.')
        : isUpload
          ? copy(
              'This upload sends the contents of a local file to the server, where the remote account and anything watching it can read them.'
            )
          : copy(
              'Writing here can grant persistent access: authorized keys, sudo rules, cron entries and service units survive without you.'
            ),
      // The double check names both ends for an upload: a human judging "send this file there"
      // needs the source and the destination, and only one of them is a remote path.
      ...(localSource === undefined
        ? []
        : ['', localSource, copy('Path: {path}', { path: request.path })]),
      '',
      copy('Confirm to allow this single operation.')
    ].join('\n');
  }

  return [
    isDelete
      ? copy('Allow AT Terminal agent SFTP deletion on {server} ({host})?', {
          server: server.label,
          host: server.host
        })
      : isUpload
        ? copy('Allow AT Terminal agent SFTP upload on {server} ({host})?', {
            server: server.label,
            host: server.host
          })
        : copy('Allow AT Terminal agent SFTP write on {server} ({host})?', {
            server: server.label,
            host: server.host
          }),
    '',
    copy('Operation: {operation}', { operation: request.operation }),
    copy('Path: {path}', { path: request.path }),
    copy('Folder: {folder}', { folder: confirmation.parentDirectory }),
    ...(localSource === undefined ? [] : [localSource]),
    ...(request.overwrite !== undefined
      ? [copy('Overwrite: {value}', { value: request.overwrite ? copy('yes') : copy('no') })]
      : []),
    ...(warnings.length > 0 ? ['', ...warnings] : [])
  ].join('\n');
}

/** The local side of an upload, sized when the service reported a byte count. */
function formatLocalSource(request: SftpWriteRequest): string | undefined {
  if (request.operation !== 'upload_local_file' || request.localPath === undefined) {
    return undefined;
  }
  if (request.localBytes === undefined) {
    return copy('Local source: {path}', { path: request.localPath });
  }
  return copy('Local source: {path} ({size})', {
    path: request.localPath,
    size: formatFileSize(request.localBytes)
  });
}
