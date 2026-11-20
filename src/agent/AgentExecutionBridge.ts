import type {
  AgentActionSnapshot,
  AgentActionStatus,
  AgentAuditSummary,
  AgentExecutionSnapshot,
  TransferProgressSnapshot
} from '../platform/dsh/client/models';
import { redactSensitiveText } from '../utils/redaction';

export interface AgentExecutionBridgeOptions {
  now?: () => number;
  maxRecentAudits?: number;
}

/** One live or recently settled action, retained briefly so the monitor can show its ending. */
interface TrackedAction {
  snapshot: AgentActionSnapshot;
  startedAt: number;
  endedAt?: number;
}

/** How long a settled action stays visible after it ends. */
const SETTLED_VISIBLE_MS = 3000;

export class AgentExecutionBridge {
  /**
   * Every action in the retention window, keyed by the action id the service minted.
   *
   * A single `currentAction` was a real bug under DSH 0.2.2's concurrent SubAgent/AgentTeam
   * scheduling: a second remote command overwrote the first, so the monitor reported only the
   * newest one and the older work became invisible. The map keeps sibling actions independent;
   * `currentAction` remains as a backward-compatible projection of the newest one.
   */
  private readonly actions = new Map<string, TrackedAction>();
  private readonly recentAudits: AgentAuditSummary[] = [];
  private readonly activeTransfers = new Map<string, TransferProgressSnapshot>();
  private readonly listeners = new Set<(snapshot: AgentExecutionSnapshot) => void>();
  private readonly clearTimers = new Set<NodeJS.Timeout | number>();
  private readonly now: () => number;
  private readonly maxRecentAudits: number;

  constructor(options: AgentExecutionBridgeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRecentAudits = options.maxRecentAudits ?? 50;
  }

  recordActionStart(params: {
    id: string;
    command: string;
    serverId?: string;
    status?: AgentActionStatus;
    agentId?: string;
    sessionId?: string;
  }): void {
    const redacted = redactSensitiveText(params.command);
    const snapshot: AgentActionSnapshot = {
      id: params.id,
      command: redacted,
      runningTimeMs: 0,
      status: params.status ?? 'running',
      ...(params.serverId === undefined ? {} : { serverId: params.serverId }),
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
      outputTail: ''
    };
    this.actions.set(params.id, { snapshot, startedAt: this.now() });
    this.notify();
  }

  recordActionStatus(id: string, status: AgentActionStatus, outputTail?: string): void {
    const tracked = this.actions.get(id);
    if (tracked === undefined) return;
    tracked.snapshot.status = status;
    if (outputTail !== undefined) {
      tracked.snapshot.outputTail = outputTail;
    }
    this.notify();
  }

  recordActionEnd(id: string, status: 'success' | 'denied', outputTail?: string): void {
    const tracked = this.actions.get(id);
    if (tracked === undefined) return;
    if (tracked.endedAt !== undefined) {
      // A duplicate end (for example an error path after a settle) must not restart the
      // retention timer or freeze a later duration under the first ending.
      tracked.snapshot.status = status;
      if (outputTail !== undefined) tracked.snapshot.outputTail = outputTail;
      this.notify();
      return;
    }
    tracked.endedAt = this.now();
    tracked.snapshot.status = status;
    if (outputTail !== undefined) {
      tracked.snapshot.outputTail = outputTail;
    }
    tracked.snapshot.runningTimeMs = Math.max(0, tracked.endedAt - tracked.startedAt);
    this.notify();
    // Keep completed state visible briefly, then clear only this action after 3 seconds.
    const timer = setTimeout(() => {
      this.clearTimers.delete(timer);
      const current = this.actions.get(id);
      if (current !== undefined && current.endedAt !== undefined) {
        this.actions.delete(id);
        this.notify();
      }
    }, SETTLED_VISIBLE_MS);
    timer.unref?.();
    this.clearTimers.add(timer);
  }

  recordAudit(entry: {
    tool: string;
    command?: string;
    reasonCode: string;
    serverId?: string;
  }): void {
    const decision: 'allowed' | 'confirmed' | 'denied' =
      entry.reasonCode === 'user_cancelled' || entry.reasonCode.includes('denied')
        ? 'denied'
        : entry.reasonCode === 'user_approved'
          ? 'confirmed'
          : 'allowed';

    const item: AgentAuditSummary = {
      id: `audit-${this.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: this.now(),
      command: entry.command ? redactSensitiveText(entry.command) : entry.tool,
      decision,
      riskLevel: decision === 'denied' ? 'high' : decision === 'confirmed' ? 'medium' : 'low',
      serverId: entry.serverId
    };

    this.recentAudits.unshift(item);
    if (this.recentAudits.length > this.maxRecentAudits) {
      this.recentAudits.pop();
    }
    this.notify();
  }

  updateTransfer(transfer: TransferProgressSnapshot): void {
    this.activeTransfers.set(transfer.id, transfer);
    this.notify();
  }

  completeTransfer(id: string): void {
    if (this.activeTransfers.delete(id)) {
      this.notify();
    }
  }

  getSnapshot(limit: number = 10): AgentExecutionSnapshot {
    const now = this.now();
    const tracked = [...this.actions.values()].sort((left, right) => right.startedAt - left.startedAt);
    const activeActions = tracked
      .filter((action) => action.endedAt === undefined)
      .map((action) => this.project(action, now));
    // Newest unfinished action first; when every action has ended but one is still inside the
    // 3-second retention window, fall back to the newest settled one so the live card does not
    // blank out immediately at completion.
    const current = tracked.find((action) => action.endedAt === undefined) ?? tracked[0];
    const currentAction = current === undefined ? undefined : this.project(current, now);

    return {
      timestamp: now,
      ...(currentAction === undefined ? {} : { currentAction }),
      activeActions,
      recentAudits: this.recentAudits.slice(0, Math.max(1, limit)),
      activeTransfers: Array.from(this.activeTransfers.values())
    };
  }

  subscribe(listener: (snapshot: AgentExecutionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const timer of this.clearTimers) {
      clearTimeout(timer as any);
    }
    this.clearTimers.clear();
    this.listeners.clear();
    this.activeTransfers.clear();
    this.actions.clear();
  }

  private project(tracked: TrackedAction, now: number): AgentActionSnapshot {
    const elapsed =
      tracked.endedAt !== undefined ? tracked.endedAt - tracked.startedAt : now - tracked.startedAt;
    return { ...tracked.snapshot, runningTimeMs: Math.max(0, elapsed) };
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {}
    }
  }
}
