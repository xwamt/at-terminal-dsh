import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { TerminalContextRegistry, TerminalContextSnapshot } from '../terminal/TerminalContext';
import type { AgentAuditRecorder } from './AgentAuditLog';
import type { AgentConfirmationPort } from './AgentConfirmationPort';
import type { RemoteCommandExecutor, RemoteCommandResult } from './RemoteCommandExecutor';
import { authorizeRemoteCommand, resolveAgentCommandTrust } from './agentCommandTrust';
import type { RemoteCommandAuthorization } from './remoteCommandAuthorization';
import type { RemoteCommandPolicyEvaluator } from './loadRemoteCommandPolicy';
import type { SftpAgentService } from './SftpAgentService';
import type { HardwareMetricsCollector } from './HardwareMetricsCollector';
import type { AgentExecutionBridge } from './AgentExecutionBridge';
import type {
  AgentAuditSummary,
  AgentExecutionSnapshot,
  HardwareMetrics,
  MonitorControlMessage
} from '../platform/dsh/client/models';

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
  ): Promise<{ server: ServerConfig; authorization: RemoteCommandAuthorization }> {
    const server = await this.resolveServer(input.serverId);
    const authorization = await authorizeRemoteCommand({
      server,
      command: input.command,
      cwd: input.cwd,
      evaluator: this.dependencies.policyEvaluator
    });
    return { server, authorization };
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
      const { server, authorization } = await this.authorizeCommand({
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
        signal: input.signal
      });
      this.dependencies.audit?.record({
        tool: 'run_remote_command',
        serverId: result.serverId,
        command,
        reasonCode: result.timedOut ? 'command_timeout' : reasonCode,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated
      });
      this.dependencies.executionBridge?.recordAudit({
        tool: 'run_remote_command',
        serverId: result.serverId,
        command,
        reasonCode: result.timedOut ? 'command_timeout' : reasonCode
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

  async getHardwareMetrics(serverId?: string): Promise<HardwareMetrics> {
    const server = await this.resolveServer(serverId);
    if (this.dependencies.metricsCollector) {
      return await this.dependencies.metricsCollector.getMetrics(server);
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
      processes: []
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
    mode?: 'hud';
  }): Promise<{
    opened: boolean;
    target: string;
    serverId?: string;
    mode: string;
    reason?: 'no-client';
  }> {
    // `hud` is the only presentation that exists. The enum used to advertise `float` (a
    // DockKit pane the dsh client never renders) and the client folded both into the HUD
    // silently, so the parameter looked like a choice and was not.
    const mode = input.mode ?? 'hud';
    let targetServerId = input.serverId;
    if (!targetServerId && input.target === 'hardware') {
      try {
        const srv = await this.resolveServer(undefined);
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

  private async resolveServer(serverId: string | undefined): Promise<ServerConfig> {
    if (serverId === 'active' || !serverId) {
      const connected = this.dependencies.terminalContext.getConnectedTerminal();
      if (connected) {
        // Live UI terminal connection is enough; background auth is only for no-UI paths.
        const latest = await this.dependencies.configManager.getServer(connected.server.id);
        if (latest) {
          this.dependencies.terminalContext.updateServer(latest);
          return latest;
        }
        return connected.server;
      }
      if (serverId === 'active') {
        throw new Error('No connected active SSH terminal is available.');
      }
    }

    if (serverId && serverId !== 'active') {
      const connectedByServer = this.dependencies.terminalContext.getConnectedTerminalByServerId(serverId);
      if (connectedByServer) {
        const latest = await this.dependencies.configManager.getServer(connectedByServer.server.id);
        if (latest) {
          this.dependencies.terminalContext.updateServer(latest);
          return latest;
        }
        return connectedByServer.server;
      }
    }

    if (!serverId) {
      throw new Error('serverId is required when there is no connected active SSH terminal.');
    }

    const server = await this.dependencies.configManager.getServer(serverId);
    if (!server) {
      throw new Error(`SSH server "${serverId}" was not found.`);
    }
    return this.requireBackgroundConnectionAllowed(server);
  }

  private requireBackgroundConnectionAllowed(server: ServerConfig): ServerConfig {
    if (server.backgroundConnectionAllowed !== true) {
      throw new Error(
        `SSH server "${server.id}" does not allow background connections. ` +
          'Ask the user to enable "Allow background connections" on the AT Terminal server edit form, ' +
          'or connect an AT Terminal session to that server.'
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
  if (message.includes('does not allow background connections')) {
    return 'background_denied';
  }
  return fallback === 'user_approved' || fallback === 'auto_approved' ? 'error' : fallback;
}
