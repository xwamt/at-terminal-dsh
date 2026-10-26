import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { TerminalContext, TerminalContextRegistry, TerminalContextSnapshot } from '../terminal/TerminalContext';
import type { AgentAuditRecorder } from './AgentAuditLog';
import type { AgentConfirmationPort } from './AgentConfirmationPort';
import type {
  RemoteCommandExecutor,
  RemoteCommandOutputChunk,
  RemoteCommandResult
} from './RemoteCommandExecutor';
import { authorizeRemoteCommand, resolveAgentCommandTrust } from './agentCommandTrust';
import { readTerminateReport, terminateScript } from './remoteCommandShell';
import type { RemoteCommandAuthorization } from './remoteCommandAuthorization';
import type { RemoteCommandPolicyEvaluator } from './loadRemoteCommandPolicy';
import type { SftpAgentService } from './SftpAgentService';
import { implicitTarget, type ResolvedBy, type ServerCandidate, type ServerTargetIntent } from './serverTarget';
import type { HardwareMetricsCollector } from './HardwareMetricsCollector';
import type { AgentExecutionBridge } from './AgentExecutionBridge';
import type {
  AgentAuditSummary,
  AgentExecutionSnapshot,
  HardwareMetrics,
  MonitorControlMessage
} from '../platform/dsh/client/models';

/**
 * The "how was this host chosen" half of a read result.
 *
 * Carried separately from `HardwareMetrics` because the collector knows nothing about target
 * resolution and should not have to: the service is the layer that decided.
 */
export interface MetricsResolution {
  resolvedBy: ResolvedBy;
  candidates?: ServerCandidate[];
}

/**
 * The audit trail as a *reader*: newest `limit` rows, or `undefined` when the evidence is
 * unavailable (no file yet, or it cannot be read). `undefined` and `[]` are different
 * answers — "no evidence" versus "nothing happened" — and the status tool reports which.
 */
export interface AgentAuditTail {
  readRecent(limit: number): Promise<AgentAuditSummary[] | undefined>;
}

/** The status snapshot plus where its `recentAudits` came from. */
export interface AgentExecutionStatusView extends AgentExecutionSnapshot {
  /** `file` when the rows were read from `agent-audit.jsonl`, `memory` for the live ring. */
  source: 'file' | 'memory';
}

export interface AgentToolServiceDependencies {
  configManager: ConfigManager;
  terminalContext: TerminalContextRegistry;
  executor: RemoteCommandExecutor;
  confirmation?: AgentConfirmationPort;
  sftp?: SftpAgentService;
  audit?: AgentAuditRecorder;
  /** Durable audit trail; preferred over `executionBridge`'s 50-row ring. */
  auditTail?: AgentAuditTail;
  policyEvaluator?: RemoteCommandPolicyEvaluator;
  metricsCollector?: HardwareMetricsCollector;
  executionBridge?: AgentExecutionBridge;
  broadcastMonitor?: (event: string, data: unknown) => void;
  /**
   * Is the browser half listening? Wired to the channel's own presence (`sseClients`).
   *
   * Absent in unit tests that do not model a client. When absent, `open_monitor` keeps its
   * historical answer (`opened: true`) because the Host genuinely cannot tell — inventing
   * `no-client` there would be a different lie, in the other direction.
   */
  resolveClientPresence?: () => { sseClients: number; clientHellos: number };
}

export interface RunRemoteCommandInput {
  serverId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /**
   * What the registry's `tools/pre-execute` stage already concluded for this execution.
   *
   * `asked` means the Host put the question to the user and this call only reached the body
   * because the answer was `allowed-once`; asking again here would be two dialogs for one
   * command. Absent means no stage ran (a direct service call, or the stage was rolled
   * back), and this method falls back to the 0.2.0 behaviour of deciding and asking itself.
   */
  preAuthorized?: 'auto-approved' | 'asked';
  /**
   * Told about output as it arrives, in addition to the buffered result.
   *
   * The background path forwards this into the job's output ring. A foreground caller
   * leaves it undefined and gets exactly the buffered result it always did.
   */
  onOutput?: (chunk: RemoteCommandOutputChunk) => void;
}

/** What `terminateRemoteCommand` can honestly report. */
export interface RemoteCommandTermination {
  /** The process group is gone — not merely "a signal was sent". */
  killed: boolean;
  /** The pid the pidfile named, when it named one. */
  pid?: string;
  detail: string;
}

/** What an authorization asks about, before anything runs. */
export interface RemoteCommandAuthorizationInput {
  serverId?: string;
  command: string;
  cwd?: string;
}

export class AgentToolService {
  constructor(private readonly dependencies: AgentToolServiceDependencies) {}

  async listServers() {
    const servers = await this.dependencies.configManager.listServers();
    // A live UI terminal is as good as background authorization: the user connected it
    // themselves, so the agent must be able to discover and target that server.
    const connectedServerIds = new Set(
      this.dependencies.terminalContext
        .getSnapshot()
        .connectedTerminals.map((terminal) => terminal.serverId)
    );
    return {
      servers: servers
        .filter(
          (server) =>
            server.backgroundConnectionAllowed === true || connectedServerIds.has(server.id)
        )
        .map((server) => ({
          id: server.id,
          label: server.label,
          host: server.host,
          port: server.port,
          username: server.username,
          authType: server.authType,
          connected: connectedServerIds.has(server.id),
          agentCommandTrust: resolveAgentCommandTrust(server),
          agentCommandAutoApprove: resolveAgentCommandTrust(server) !== 'none'
        }))
    };
  }

  async getTerminalContext(): Promise<TerminalContextSnapshot> {
    return this.dependencies.terminalContext.getSnapshot();
  }

  /**
   * Resolve the server and decide whether this command needs a human, without running it.
   *
   * Exposed so `dsh/policy.js` can ask the registry-layer question at `tools/pre-execute`
   * by calling **this** method rather than re-deriving trust and policy on its own: two
   * implementations of "does this need approval" is precisely how a prompt and a gate
   * start disagreeing. `runRemoteCommand` calls it too, so the tool body and the gate share
   * one answer.
   */
  async authorizeCommand(
    input: RemoteCommandAuthorizationInput
  ): Promise<{
    server: ServerConfig;
    authorization: RemoteCommandAuthorization;
    resolvedBy: ResolvedBy;
    candidates?: ServerCandidate[];
  }> {
    // Write intent: a command can change the host, so an unnamed target with several servers
    // connected must fail rather than pick the most recent one. This is also the path
    // `dsh/policy.js` calls from `tools/pre-execute`, so the gate and the body agree on it.
    const target = await this.resolveTarget(input.serverId, 'write');
    const authorization = await authorizeRemoteCommand({
      server: target.server,
      command: input.command,
      cwd: input.cwd,
      evaluator: this.dependencies.policyEvaluator
    });
    return {
      server: target.server,
      authorization,
      resolvedBy: target.resolvedBy,
      ...(target.candidates === undefined ? {} : { candidates: target.candidates })
    };
  }

  async runRemoteCommand(input: RunRemoteCommandInput): Promise<RemoteCommandResult> {
    const command = input.command?.trim();
    if (!command) {
      throw new Error('Remote command cannot be empty.');
    }
    const started = Date.now();
    let reasonCode = 'auto_approved';
    const actionId = `action-${started}-${Math.random().toString(36).slice(2, 6)}`;
    this.dependencies.executionBridge?.recordActionStart({
      id: actionId,
      command,
      serverId: input.serverId,
      status: 'running'
    });
    try {
      const { server, authorization, resolvedBy } = await this.authorizeCommand({
        serverId: input.serverId,
        command,
        cwd: input.cwd
      });
      // `pre-execute` either proved the server trusts this command (`auto-approved`) or put
      // the question to the user (`asked`). In both cases the answer is already in, and the
      // check below only decides whether *this* layer has to open a dialog — the
      // authorization itself is never skipped.
      const settled =
        input.preAuthorized === 'asked' ||
        (input.preAuthorized === 'auto-approved' && authorization.autoApprove);
      if (!authorization.autoApprove) {
        if (settled) {
          reasonCode = 'user_approved';
        } else {
          this.dependencies.executionBridge?.recordActionStatus(actionId, 'confirmation_waiting');
          if (!this.dependencies.confirmation) {
            throw new Error('Command requires human confirmation, but no confirmation channel is available.');
          }
          const approved = await this.dependencies.confirmation.confirmCommand({
            serverLabel: server.label,
            host: server.host,
            command,
            destructive: authorization.destructive,
            riskSummaries: authorization.riskSummaries,
            signal: input.signal
          });
          if (!approved) {
            reasonCode = 'user_cancelled';
            throw new Error('Remote command was cancelled.');
          }
          reasonCode = 'user_approved';
          this.dependencies.executionBridge?.recordActionStatus(actionId, 'running');
        }
      }
      const result = await this.dependencies.executor.execute(server, {
        command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        signal: input.signal,
        onOutput: input.onOutput
      });
      this.dependencies.audit?.record({
        tool: 'run_remote_command',
        serverId: result.serverId,
        command,
        reasonCode,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        // How this host was chosen. `single-connected` is the useful one to have in writing:
        // it says the caller named nothing and there was only one answer at the time.
        resolvedBy
      });
      this.dependencies.executionBridge?.recordAudit({
        tool: 'run_remote_command',
        serverId: result.serverId,
        command,
        reasonCode
      });
      this.dependencies.executionBridge?.recordActionEnd(
        actionId,
        'success',
        result.stdout ? result.stdout.slice(-500) : ''
      );
      return result;
    } catch (error) {
      const recordedReason = auditReasonForError(error, reasonCode);
      this.dependencies.audit?.record({
        tool: 'run_remote_command',
        serverId: input.serverId,
        command,
        reasonCode: recordedReason,
        durationMs: Date.now() - started
      });
      this.dependencies.executionBridge?.recordAudit({
        tool: 'run_remote_command',
        serverId: input.serverId,
        command,
        reasonCode: recordedReason
      });
      this.dependencies.executionBridge?.recordActionEnd(
        actionId,
        'denied',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Stop a background command's remote process and report whether it actually stopped.
   *
   * **Not** routed through {@link authorizeCommand}, deliberately: the command line here is
   * generated by {@link terminateScript} and contains `kill`, so running it through the
   * policy engine would either refuse it as destructive or put a dialog in front of the
   * user for a signal they already asked for by calling `job_kill`. The safety comes from
   * the input instead — the only thing this can signal is the pid the named pidfile holds,
   * and the only pidfiles that exist are the ones this process wrote for its own jobs.
   *
   * It is still audited: a kill that removes a process from a production host is exactly
   * the kind of thing a later "who ran what" question needs to answer.
   */
  async terminateRemoteCommand(serverId: string | undefined, pidfile: string): Promise<RemoteCommandTermination> {
    try {
      const server = await this.resolveServer(serverId, 'write');
      const result = await this.dependencies.executor.execute(server, {
        command: terminateScript(pidfile),
        // Bounded and short: this runs while a job is already settling, and a kill that hangs
        // must not outlive the thing it was meant to end.
        timeoutMs: 15_000
      });
      const report = readTerminateReport(result.stdout);
      const detail = report.killed
        ? `process group ${report.pid} is gone`
        : result.stdout.trim() === ''
          ? 'no pid was recorded: the command had already finished'
          : `the process did not exit after SIGTERM (${result.stdout.trim().split('\n').pop() ?? 'no output'})`;
      this.dependencies.audit?.record({
        tool: 'run_remote_command',
        serverId: server.id,
        command: `kill ${pidfile}`,
        reasonCode: report.killed ? 'job_killed' : 'job_kill_unconfirmed',
        exitCode: result.exitCode,
        durationMs: result.durationMs
      });
      this.dependencies.executionBridge?.recordAudit({
        tool: 'run_remote_command',
        serverId: server.id,
        command: `kill ${pidfile}`,
        reasonCode: report.killed ? 'job_killed' : 'job_kill_unconfirmed'
      });
      return {
        killed: report.killed,
        ...(report.pid === undefined ? {} : { pid: report.pid }),
        detail
      };
    } catch (error) {
      // A kill that fails must leave a row of its own. The first real-machine run of this
      // path produced *no* audit line at all — the throw happened before the success row —
      // and the absence of evidence was indistinguishable from a kill that simply worked
      // through some other mechanism. That ambiguity is the bug this catch removes.
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.audit?.record({
        tool: 'run_remote_command',
        serverId: serverId ?? 'unknown',
        command: `kill ${pidfile}`,
        reasonCode: 'job_kill_failed'
      });
      this.dependencies.executionBridge?.recordAudit({
        tool: 'run_remote_command',
        serverId: serverId ?? 'unknown',
        command: `kill ${pidfile}`,
        reasonCode: 'job_kill_failed'
      });
      return { killed: false, detail: `the kill could not be sent: ${message}` };
    }
  }

  async getHardwareMetrics(serverId?: string): Promise<HardwareMetrics & MetricsResolution> {
    // Read intent: metrics can be inferred when only one server is connected, and when several
    // are, the numbers are still worth having as long as they say which host they describe.
    const target = await this.resolveTarget(serverId, 'read');
    const resolution: MetricsResolution = {
      resolvedBy: target.resolvedBy,
      ...(target.candidates === undefined ? {} : { candidates: target.candidates })
    };
    const server = target.server;
    if (this.dependencies.metricsCollector) {
      return { ...(await this.dependencies.metricsCollector.getMetrics(server)), ...resolution };
    }
    return {
      serverId: server.id,
      timestamp: Date.now(),
      cpu: { usagePercent: 12, cores: [12], loadAvg: [0.4, 0.5, 0.45] },
      memory: {
        totalBytes: 8 * 1024 * 1024 * 1024,
        usedBytes: 3 * 1024 * 1024 * 1024,
        freeBytes: 5 * 1024 * 1024 * 1024
      },
      disk: {
        mounts: [
          {
            fs: '/dev/root',
            mount: '/',
            totalBytes: 50 * 1024 * 1024 * 1024,
            usedBytes: 15 * 1024 * 1024 * 1024,
            usePercent: 30
          }
        ]
      },
      network: { rxBytesPerSec: 1024 * 20, txBytesPerSec: 1024 * 5 },
      processes: [],
      ...resolution
    };
  }

  async getAgentExecutionStatus(limit?: number): Promise<AgentExecutionStatusView> {
    const wanted = Math.max(1, Math.trunc(limit ?? 5));
    const bridge = this.dependencies.executionBridge;
    const tail = this.dependencies.auditTail;
    if (tail !== undefined) {
      // The durable trail first: the ring is capped at 50 and dies with the process, so a
      // session that has restarted has no history at all without this read.
      const fromFile = await tail.readRecent(wanted).catch(() => undefined);
      if (fromFile !== undefined && fromFile.length > 0) {
        const snapshot = bridge?.getSnapshot(wanted) ?? {
          timestamp: Date.now(),
          recentAudits: [],
          activeTransfers: []
        };
        return {
          ...snapshot,
          // Oldest first in the file; the HUD renders newest first, exactly like the ring.
          recentAudits: [...fromFile].reverse(),
          source: 'file'
        };
      }
    }
    if (bridge !== undefined) {
      return { ...bridge.getSnapshot(wanted), source: 'memory' };
    }
    return {
      timestamp: Date.now(),
      recentAudits: [],
      activeTransfers: [],
      source: 'memory'
    };
  }

  async openMonitor(input: {
    target: 'hardware' | 'agent_execution';
    serverId?: string;
    mode?: 'hud' | 'tab';
  }): Promise<{
    opened: boolean;
    target: string;
    serverId?: string;
    mode: string;
    reason?: 'no-client';
  }> {
    // Two presentations now, and both are real: `hud` is the floating overlay, `tab` is the
    // right-sidebar pane (whose body already reads `navigation.params.target/serverId`). The
    // enum used to advertise `float` — a DockKit pane this client never renders — while the
    // client folded everything into the HUD, so the parameter looked like a choice and was not.
    // `float` stays out: there is still nothing behind it.
    const mode = input.mode ?? 'hud';
    let targetServerId = input.serverId;
    if (!targetServerId && input.target === 'hardware') {
      try {
        // Read intent, on purpose, and this is the one place the plan and the code disagree.
        // §S5-04 groups `open_monitor` with the write/execute tools, but opening a monitor
        // changes nothing on the remote host — and with several servers connected the useful
        // answer is "show me the one I am looking at", which is what the HUD and the pane both
        // already do when no server is named. Throwing here would turn a UI pivot into an error
        // the model has to retry, for a call that cannot harm anything.
        const srv = await this.resolveServer(undefined, 'read');
        targetServerId = srv.id;
      } catch {}
    }
    // With no SSE client there is nobody to receive `monitor-control`. Broadcasting into the
    // void and answering `opened: true` is exactly the false success this reports instead:
    // the model reads `opened` to decide whether the user can see the window.
    const presence = this.dependencies.resolveClientPresence?.();
    if (presence !== undefined && presence.sseClients === 0) {
      return {
        opened: false,
        target: input.target,
        serverId: targetServerId,
        mode,
        reason: 'no-client'
      };
    }
    if (this.dependencies.broadcastMonitor) {
      this.dependencies.broadcastMonitor('monitor-control', {
        action: 'open',
        target: input.target,
        serverId: targetServerId,
        mode
      });
    }
    return {
      opened: true,
      target: input.target,
      serverId: targetServerId,
      mode
    };
  }

  async sftpListDirectory(input: {
    terminalId?: string;
    serverId?: string;
    path?: string;
    maxEntries?: number;
    offset?: number;
  }) {
    return await this.requireSftp().listDirectory(input);
  }

  async sftpStatPath(input: { terminalId?: string; serverId?: string; path: string }) {
    return await this.requireSftp().statPath(input);
  }

  async sftpReadFile(input: {
    terminalId?: string;
    serverId?: string;
    path: string;
    maxBytes?: number;
    offset?: number;
  }) {
    const transferId = `read-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const filename = input.path.split('/').pop() || input.path;
    this.dependencies.executionBridge?.updateTransfer({
      id: transferId,
      filename,
      type: 'download',
      progressPercent: 30,
      bytesPerSec: 1024 * 50
    });
    try {
      const res = await this.requireSftp().readFile(input);
      this.dependencies.executionBridge?.completeTransfer(transferId);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_read_file',
        command: `read ${input.path}`,
        reasonCode: 'policy_allowed',
        serverId: input.serverId
      });
      return res;
    } catch (error) {
      this.dependencies.executionBridge?.completeTransfer(transferId);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_read_file',
        command: `read ${input.path}`,
        reasonCode: 'denied',
        serverId: input.serverId
      });
      throw error;
    }
  }

  async sftpWriteFile(input: {
    terminalId?: string;
    serverId?: string;
    path: string;
    content: string;
    overwrite?: boolean;
  }) {
    const transferId = `write-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const filename = input.path.split('/').pop() || input.path;
    this.dependencies.executionBridge?.updateTransfer({
      id: transferId,
      filename,
      type: 'upload',
      progressPercent: 50,
      bytesPerSec: 1024 * 50
    });
    try {
      const res = await this.requireSftp().writeFile(input);
      this.dependencies.executionBridge?.completeTransfer(transferId);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_write_file',
        command: `write ${input.path}`,
        reasonCode: 'policy_allowed',
        serverId: input.serverId
      });
      return res;
    } catch (error) {
      this.dependencies.executionBridge?.completeTransfer(transferId);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_write_file',
        command: `write ${input.path}`,
        reasonCode: 'denied',
        serverId: input.serverId
      });
      throw error;
    }
  }

  async sftpCreateFile(input: { terminalId?: string; serverId?: string; path: string; content?: string }) {
    try {
      const res = await this.requireSftp().createFile(input);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_create_file',
        command: `create ${input.path}`,
        reasonCode: 'policy_allowed',
        serverId: input.serverId
      });
      return res;
    } catch (error) {
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_create_file',
        command: `create ${input.path}`,
        reasonCode: 'denied',
        serverId: input.serverId
      });
      throw error;
    }
  }

  async sftpCreateDirectory(input: { terminalId?: string; serverId?: string; path: string }) {
    try {
      const res = await this.requireSftp().createDirectory(input);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_create_directory',
        command: `mkdir ${input.path}`,
        reasonCode: 'policy_allowed',
        serverId: input.serverId
      });
      return res;
    } catch (error) {
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_create_directory',
        command: `mkdir ${input.path}`,
        reasonCode: 'denied',
        serverId: input.serverId
      });
      throw error;
    }
  }

  async sftpRename(input: { terminalId?: string; serverId?: string; path: string; newPath: string }) {
    try {
      const res = await this.requireSftp().rename(input);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_rename',
        command: `rename ${input.path} -> ${input.newPath}`,
        reasonCode: 'policy_allowed',
        serverId: input.serverId
      });
      return res;
    } catch (error) {
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_rename',
        command: `rename ${input.path} -> ${input.newPath}`,
        reasonCode: 'denied',
        serverId: input.serverId
      });
      throw error;
    }
  }

  async sftpDelete(input: { terminalId?: string; serverId?: string; path: string }) {
    try {
      const res = await this.requireSftp().deleteFile(input);
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_delete',
        command: `delete ${input.path}`,
        reasonCode: 'policy_allowed',
        serverId: input.serverId
      });
      return res;
    } catch (error) {
      this.dependencies.executionBridge?.recordAudit({
        tool: 'at_terminal_sftp_delete',
        command: `delete ${input.path}`,
        reasonCode: 'denied',
        serverId: input.serverId
      });
      throw error;
    }
  }

  /**
   * Resolve the target **and say how**, because "which host answered" is part of the answer.
   *
   * The old version returned a `ServerConfig` and nothing else, which made the implicit
   * branch indistinguishable from an explicit one: with three servers connected, a call that
   * named none silently used the most recent terminal and looked identical to a call that
   * named it. `intent` decides what may be inferred — see `serverTarget.ts`.
   */
  private async resolveTarget(
    serverId: string | undefined,
    intent: ServerTargetIntent
  ): Promise<{ server: ServerConfig; resolvedBy: ResolvedBy; candidates?: ServerCandidate[] }> {
    if (serverId === 'active') {
      const connected = this.dependencies.terminalContext.getConnectedTerminal();
      if (!connected) {
        throw new Error('No connected active SSH terminal is available.');
      }
      return { server: await this.refreshConnected(connected), resolvedBy: 'explicit' };
    }

    if (serverId) {
      const connectedByServer = this.dependencies.terminalContext.getConnectedTerminalByServerId(serverId);
      if (connectedByServer) {
        return { server: await this.refreshConnected(connectedByServer), resolvedBy: 'explicit' };
      }
      const server = await this.dependencies.configManager.getServer(serverId);
      if (!server) {
        throw new Error(`SSH server "${serverId}" was not found.`);
      }
      return { server: this.requireBackgroundConnectionAllowed(server), resolvedBy: 'explicit' };
    }

    const choice = implicitTarget(this.dependencies.terminalContext, intent);
    if (!choice.context) {
      throw new Error('serverId is required when there is no connected active SSH terminal.');
    }
    return {
      server: await this.refreshConnected(choice.context),
      resolvedBy: choice.resolvedBy,
      ...(choice.candidates === undefined ? {} : { candidates: choice.candidates })
    };
  }

  /** Re-read the config so an edit made after connect is not lost, then hand back the server. */
  private async refreshConnected(context: TerminalContext): Promise<ServerConfig> {
    const latest = await this.dependencies.configManager.getServer(context.server.id);
    if (latest) {
      this.dependencies.terminalContext.updateServer(latest);
      return latest;
    }
    return context.server;
  }

  private async resolveServer(serverId: string | undefined, intent: ServerTargetIntent = 'read'): Promise<ServerConfig> {
    return (await this.resolveTarget(serverId, intent)).server;
  }

  private requireBackgroundConnectionAllowed(server: ServerConfig): ServerConfig {
    if (server.backgroundConnectionAllowed !== true) {
      throw new Error(
        `SSH server "${server.id}" does not allow background connections. ` +
          'Ask the user to enable "Allow background connections" on the AT Terminal server edit form, ' +
          'or open a terminal tab for that server in the AT Terminal panel. ' +
          'A `terminal_*` session does not count: the check reads the panel\'s own terminal tabs.'
      );
    }
    return server;
  }

  private requireSftp(): SftpAgentService {
    if (!this.dependencies.sftp) {
      throw new Error('AT Terminal SFTP agent service is not available.');
    }
    return this.dependencies.sftp;
  }
}

function auditReasonForError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('was cancelled') || message.includes('was aborted')) {
    return 'user_cancelled';
  }
  if (message.startsWith('Confirmation timed out')) {
    return 'confirmation_timeout';
  }
  // A command that overran its deadline used to be audited as a **success** (`exitCode: null`,
  // resolved by the executor). It now rejects, and this is the reason code it records.
  if (message.startsWith('Command timed out after')) {
    return 'command_timeout';
  }
  if (message.includes('does not allow background connections')) {
    return 'background_denied';
  }
  return fallback === 'user_approved' || fallback === 'auto_approved' ? 'error' : fallback;
}
