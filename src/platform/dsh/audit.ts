import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_AUDIT_FILE_NAME,
  AgentAuditLog,
  type AgentAuditChannel,
  type AgentAuditEntry,
  type AgentAuditFileSystem
} from '../../agent/AgentAuditLog';
import type { AgentAuditSummary } from './client/models';

/**
 * The audit trail, wired for the dsh Host half.
 *
 * `AgentAuditLog` already did the work — redaction, serialized appends, a `flush()`;
 * `test/agent/AgentAuditLog.test.ts` covers it — but nothing in the dsh composition ever
 * constructed it, so `agent-audit.jsonl` was referenced only in a docblock and "history"
 * lived in an in-memory ring capped at 50. This module is the missing half: an
 * `AgentAuditChannel` for a host that has no VS Code `OutputChannel`, plus a reader that
 * turns the file back into the rows the monitor HUD and `at_terminal_get_agent_execution_status`
 * display.
 */

/** The slice of a pino-style logger this module uses. */
export interface DshAuditLogger {
  info(message: string): void;
  warn?(message: string): void;
}

/** Reads the audit file back. Injectable so a test needs no temp directory. */
export type DshAuditTextReader = (filePath: string) => Promise<string>;

export interface DshAuditLogOptions {
  /** `$DSH_HOME/at-terminal`; the file is `agent-audit.jsonl` inside it. */
  readonly storageDir: string;
  readonly logger?: DshAuditLogger;
  readonly now?: () => number;
  readonly writeFs?: AgentAuditFileSystem;
  readonly readText?: DshAuditTextReader;
  /** How many lines the in-memory mirror keeps. The HUD's ring used to be 50. */
  readonly ringSize?: number;
}

/** What the Host half can do with the audit trail. */
export interface DshAuditLog {
  readonly filePath: string;
  record(entry: AgentAuditEntry): void;
  flush(): Promise<void>;
  /**
   * The newest `limit` entries, oldest first (the caller reverses), or `undefined` when
   * the file cannot be read. `undefined` and `[]` mean different things: "no evidence
   * available" versus "nothing has happened yet", and the caller reports which.
   */
  readRecent(limit: number): Promise<AgentAuditSummary[] | undefined>;
  dispose(): void;
}

/**
 * A channel that keeps a bounded in-memory mirror and forwards each line to the host log.
 *
 * The VS Code variant writes to an `OutputChannel` the user can open; dsh has no such
 * surface, so the file is the record and the logger is the live tap. Neither may throw:
 * `AgentAuditLog.record()` calls this synchronously from a `tools/result` observer, and an
 * audit failure must never become a tool failure.
 */
function createRingChannel(ringSize: number, logger?: DshAuditLogger): AgentAuditChannel & {
  lines(): readonly string[];
} {
  const ring: string[] = [];
  return {
    appendLine(line: string): void {
      ring.push(line);
      if (ring.length > ringSize) ring.shift();
      try {
        logger?.info(line);
      } catch {
        /* a logger that throws must not break the audit path */
      }
    },
    lines(): readonly string[] {
      return ring;
    }
  };
}

/**
 * Authorization outcome for one audit reason code.
 *
 * Deliberately the same projection `AgentExecutionBridge.recordAudit` uses, so a row read
 * from the file and a row remembered in memory are indistinguishable in the HUD: the
 * decision column is about *whether the call was allowed*, not whether it then succeeded.
 * A failure keeps its own `reasonCode` in the JSONL line — that is where forensics reads it.
 */
function decisionOf(reasonCode: string): AgentAuditSummary['decision'] {
  if (reasonCode.includes('denied') || reasonCode === 'user_cancelled') return 'denied';
  if (reasonCode === 'user_approved' || reasonCode === 'completed') return 'confirmed';
  return 'allowed';
}

function riskOf(decision: AgentAuditSummary['decision']): string {
  return decision === 'denied' ? 'high' : decision === 'confirmed' ? 'medium' : 'low';
}

/** Project one JSONL line into the row shape the HUD and the status tool render. */
function summaryOfLine(line: string, ordinal: number): AgentAuditSummary | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const parsed = typeof raw.time === 'string' ? Date.parse(raw.time) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const reasonCode = typeof raw.reasonCode === 'string' ? raw.reasonCode : '';
  const decision = decisionOf(reasonCode);
  const text =
    typeof raw.command === 'string'
      ? raw.command
      : typeof raw.path === 'string'
        ? raw.path
        : typeof raw.tool === 'string'
          ? raw.tool
          : 'unknown';
  return {
    // The file carries no id; this one is stable for as long as the line is. The client
    // de-duplicates audits by id, so it must change when the line does — the ordinal is the
    // line's position in the read window, which is why the timestamp comes first.
    id: `audit-${parsed}-${ordinal}`,
    timestamp: parsed,
    command: text,
    decision,
    riskLevel: riskOf(decision),
    ...(typeof raw.serverId === 'string' ? { serverId: raw.serverId } : {})
  };
}

export function createDshAuditLog(options: DshAuditLogOptions): DshAuditLog {
  const channel = createRingChannel(options.ringSize ?? 50, options.logger);
  const log = new AgentAuditLog({
    storageDir: options.storageDir,
    channel,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.writeFs === undefined ? {} : { fs: options.writeFs })
  });
  const filePath = join(options.storageDir, AGENT_AUDIT_FILE_NAME);
  const readText: DshAuditTextReader = options.readText ?? ((file) => readFile(file, 'utf8'));

  return {
    filePath,
    record(entry: AgentAuditEntry): void {
      log.record(entry);
    },
    flush(): Promise<void> {
      return log.flush();
    },

    async readRecent(limit: number): Promise<AgentAuditSummary[] | undefined> {
      const wanted = Math.max(1, Math.trunc(limit));
      try {
        const text = await readText(filePath);
        const lines = text.split('\n').filter((line) => line.trim() !== '');
        const window = lines.slice(-wanted);
        // Oldest first: the caller (and the HUD) wants newest last, exactly like the file.
        const summaries: AgentAuditSummary[] = [];
        for (const [index, line] of window.entries()) {
          const summary = summaryOfLine(line, index);
          if (summary !== undefined) summaries.push(summary);
        }
        return summaries;
      } catch {
        // Absent file is the normal state before the first tool call; the caller decides
        // whether to fall back to the in-memory ring and says so in its output.
        return undefined;
      }
    },

    dispose(): void {
      log.dispose();
    }
  };
}
