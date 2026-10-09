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

export class AgentExecutionBridge {
  private currentAction?: AgentActionSnapshot;
  private actionStartedAt?: number;
  private actionEndedAt?: number;
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
  }): void {
    const redacted = redactSensitiveText(params.command);
    this.actionStartedAt = this.now();
    this.actionEndedAt = undefined;
    this.currentAction = {
      id: params.id,
      command: redacted,
      runningTimeMs: 0,
      status: params.status ?? 'running',
      serverId: params.serverId,
      outputTail: ''
    };
    this.notify();
  }

  recordActionStatus(id: string, status: AgentActionStatus, outputTail?: string): void {
    if (this.currentAction && this.currentAction.id === id) {
      this.currentAction.status = status;
      if (outputTail !== undefined) {
        this.currentAction.outputTail = outputTail;
      }
      this.notify();
    }
  }

  recordActionEnd(id: string, status: 'success' | 'denied', outputTail?: string): void {
    if (this.currentAction && this.currentAction.id === id) {
      this.actionEndedAt = this.now();
      this.currentAction.status = status;
      if (outputTail !== undefined) {
        this.currentAction.outputTail = outputTail;
      }
      if (this.actionStartedAt !== undefined) {
        this.currentAction.runningTimeMs = Math.max(0, this.actionEndedAt - this.actionStartedAt);
      }
      this.notify();
      // Keep completed state visible briefly, then clear after 3 seconds
      const timer = setTimeout(() => {
        this.clearTimers.delete(timer);
        if (this.currentAction && this.currentAction.id === id) {
          this.currentAction = undefined;
          this.actionStartedAt = undefined;
          this.actionEndedAt = undefined;
          this.notify();
        }
      }, 3000);
      timer.unref?.();
      this.clearTimers.add(timer);
    }
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
    let action = this.currentAction ? { ...this.currentAction } : undefined;
    if (action && this.actionStartedAt !== undefined) {
      const elapsed =
        this.actionEndedAt !== undefined
          ? this.actionEndedAt - this.actionStartedAt
          : this.now() - this.actionStartedAt;
      action.runningTimeMs = Math.max(0, elapsed);
    }
    return {
      timestamp: this.now(),
      currentAction: action,
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
    this.currentAction = undefined;
    this.actionStartedAt = undefined;
    this.actionEndedAt = undefined;
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
