/**
 * Which server did a call mean?
 *
 * The two agent-facing services (`AgentToolService` for commands and metrics,
 * `SftpAgentService` for files) each resolve a target from the same two optional ids, and
 * each used to fall back to "the most recently connected terminal" when neither was given.
 * With one server connected that fallback is the whole answer and nobody notices. With
 * three connected it is a **guess**: the call succeeds, against a host the caller never
 * named, and the result looks like evidence about the host they were reasoning about.
 *
 * So the rule lives here once, and it differs by what the call can do:
 *
 * - **explicit** — `serverId` (or `terminalId`) was given. Nothing to decide.
 * - **single-connected** — nothing was given and exactly one server is connected. The
 *   implicit choice is not a guess, and the result says how it was made.
 * - **implicit** — nothing was given, several are connected, and the call only **reads**.
 *   Allowed for convenience, but the result carries `resolvedBy: 'implicit'` plus the
 *   candidate list, so "which host did this come from" is answerable afterwards.
 * - several connected and the call **writes or executes** — there is no safe guess, so it
 *   throws {@link ServerTargetError} naming every candidate. The model can fix this itself
 *   by passing `serverId`; interrupting the user is the fallback, not the first move.
 *
 * A count of **servers**, not terminals: two tabs on the same host are one answer. The
 * order is the registry's own (most recently connected first), so the candidate list a
 * model reads is the same order it would see from `get_terminal_context`.
 */

import type { TerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';

/** What a call may do to the target. Write intent needs a name; read intent may infer one. */
export type ServerTargetIntent = 'read' | 'write';

/** How the target was decided. Recorded in results and in the audit trail. */
export type ResolvedBy = 'explicit' | 'single-connected' | 'implicit';

/** One connected server, as the error and the result describe it. */
export interface ServerCandidate {
  id: string;
  label: string;
}

/**
 * Raised instead of guessing, when a write call names no server and several are connected.
 *
 * `code` is carried as a property as well as in the message because the Host half has no
 * single error class to switch on: `dsh/tools.js` renders readable messages out of the
 * shape, and a future caller may want to branch on it.
 */
export class ServerTargetError extends Error {
  readonly code = 'server-required';
  readonly candidates: ServerCandidate[];

  constructor(candidates: ServerCandidate[], intent: ServerTargetIntent) {
    const verb = intent === 'write' ? 'This call can modify the remote host' : 'This call could not pick a server';
    super(
      `${verb}, and ${candidates.length} SSH servers are connected, so the target is ambiguous. ` +
        'Call again with serverId. Connected servers: ' +
        candidates.map((candidate) => `${candidate.id} (${candidate.label})`).join(', ') +
        '.'
    );
    this.name = 'ServerTargetError';
    this.candidates = candidates;
  }
}

/**
 * Every connected server, de-duplicated, in the registry's order.
 *
 * Exported because the same list is what a model needs to retry with, and deriving it in
 * two places is how the error message and the result's `candidates` start to disagree.
 */
export function connectedServerCandidates(registry: TerminalContextRegistry): ServerCandidate[] {
  const seen = new Map<string, ServerCandidate>();
  for (const terminal of registry.getSnapshot().connectedTerminals) {
    if (!seen.has(terminal.serverId)) {
      seen.set(terminal.serverId, { id: terminal.serverId, label: terminal.label });
    }
  }
  return [...seen.values()];
}

export interface ImplicitTarget {
  /** Absent when nothing is connected at all; the caller owns that error message. */
  context?: TerminalContext;
  resolvedBy: ResolvedBy;
  /** Present only when the choice was ambiguous and therefore had to be stated. */
  candidates?: ServerCandidate[];
}

/**
 * Resolve a call that named no server.
 *
 * `context` is `undefined` when nothing is connected: the callers already have a message
 * for that case ("connect an AT Terminal session first"), and inventing a second one here
 * would give the same situation two descriptions.
 */
export function implicitTarget(
  registry: TerminalContextRegistry,
  intent: ServerTargetIntent
): ImplicitTarget {
  const candidates = connectedServerCandidates(registry);
  if (candidates.length > 1) {
    if (intent === 'write') {
      throw new ServerTargetError(candidates, intent);
    }
    return {
      context: registry.getConnectedTerminal(),
      resolvedBy: 'implicit',
      candidates
    };
  }
  return { context: registry.getConnectedTerminal(), resolvedBy: 'single-connected' };
}
