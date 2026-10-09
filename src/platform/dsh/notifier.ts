import { cancellationTokenNone, type CancellationToken } from '../../core/cancellation';
import type {
  MessageOptions,
  Notifier,
  ProgressOptions,
  ProgressReporter
} from '../../core/ports';
import type { DshLogger } from './host';

/**
 * The dsh implementation of the `Notifier` port — DSH-15.
 *
 * ## The constraint that shapes everything here: the Host half is headless
 *
 * The M2 dsh variant runs with **no UI**. There is no message box, no progress
 * notification, no one to click an action button. The adapter therefore has two
 * honest jobs instead of one:
 *
 * 1. **Nothing may be swallowed.** Every `show*Message` call lands in `ctx.logger`
 *    at the severity that matches the call (`info` → `ctx.logger.info`,
 *    `warning` → `warn`, `error` → `error`). A notification that only reached a
 *    dropped dialog would be a silent failure, so the log line *is* the delivery.
 * 2. **An action prompt with no responder resolves to `undefined`.** Pretending a
 *    user answered would be worse than admitting nobody did: the call sites are
 *    written so `undefined` is the *safe* branch — `confirmAutoSync` treats it as
 *    "do not auto-upload", `promptUnsyncedClose` as "keep the local copy". A
 *    fabricated answer could silently upload or discard a user's file.
 *
 * `respond` is the seam the M3/M4 Client half will fill: once a real UI exists it
 * receives the same request and returns the chosen action title. It is deliberately
 * **not** defaulted to a stub that answers, because a default answer is exactly the
 * dishonesty this design avoids.
 */

/**
 * The dsh logger is printf-style (see `DshLogger`), so the adapter passes the
 * message as an argument instead of pre-formatting it: `ctx.logger.warn('… %s', x)`
 * lets the host's own formatter (and any transport-level redaction) see the value.
 *
 * The call goes through a member expression (`logger.warn(...)`) rather than an
 * extracted function reference: the real `ctx.logger` is a class instance, and
 * detaching its method would drop `this`. Branching is the small price for never
 * shipping an "illegal invocation" on the one host whose logger we cannot unit-test.
 */
function logAt(
  logger: DshLogger,
  kind: 'info' | 'warning' | 'error',
  format: string,
  ...args: unknown[]
): void {
  if (kind === 'info') {
    logger.info(format, ...args);
  } else if (kind === 'warning') {
    logger.warn(format, ...args);
  } else {
    logger.error(format, ...args);
  }
}

/**
 * Split the host's dual call form — `(msg, ...actions)` vs `(msg, options, ...actions)`
 * — by the same rule the host uses: the second argument is options only when it is an
 * object. Keeping the port's dual overloads is what lets an existing call site keep
 * its original shape; the split happens once, here, rather than at every call site.
 */
function splitTrailing(
  rest: readonly unknown[]
): { options?: MessageOptions; actions: string[] } {
  const [head, ...tail] = rest;
  const hasOptions = typeof head === 'object' && head !== null;
  return {
    options: hasOptions ? (head as MessageOptions) : undefined,
    actions: (hasOptions ? tail : rest) as string[]
  };
}

export interface DshNotifierDeps {
  logger: DshLogger;
  /**
   * The injection point the M3/M4 Client half fills. When absent, an action
   * prompt resolves to `undefined` (the safe default) instead of pretending a
   * user answered.
   */
  respond?: (request: {
    kind: 'info' | 'warning' | 'error';
    message: string;
    options?: MessageOptions;
    actions: readonly string[];
  }) => Promise<string | undefined>;
}

/**
 * Build the headless `Notifier`.
 *
 * `withProgress` still runs the task and returns its value, and it hands the task a
 * `ProgressReporter` that really forwards each `report()` — into the logger, one line
 * per report, because a log stream is the only progress display this host has. The
 * reporter is **not** a no-op: dropping `report()` would make progress invisible and
 * would also hide a caller's formatting bugs until the Client half exists.
 */
export function createDshNotifier({ logger, respond }: DshNotifierDeps): Notifier {
  async function dispatch(
    kind: 'info' | 'warning' | 'error',
    message: string,
    rest: readonly unknown[]
  ): Promise<string | undefined> {
    const { options, actions } = splitTrailing(rest);

    // Log first, unconditionally: whether or not anyone can answer, the message is
    // delivered. Offered actions ride along in the same line so an operator reading the
    // log can tell an unanswered prompt apart from a plain notification.
    const suffix = actions.length > 0 ? ` [${actions.join(' | ')}]` : '';
    logAt(logger, kind, `AT Terminal: %s${suffix}`, message);

    // No responder (headless today) or nothing to choose: the host would not have shown
    // a dialog either. `undefined` is the port's "dismissed / nobody chose" value, which
    // every call site already maps to its safe branch.
    if (respond === undefined || actions.length === 0) {
      return undefined;
    }
    return await respond({ kind, message, options, actions });
  }

  return {
    async showInformationMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
      return await dispatch('info', message, rest);
    },
    async showWarningMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
      return await dispatch('warning', message, rest);
    },
    async showErrorMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
      return await dispatch('error', message, rest);
    },

    async withProgress<T>(
      options: ProgressOptions,
      task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>
    ): Promise<T> {
      // A progress title has no notification surface here, so it is logged once at info
      // level: the caller asked for something to be shown, and this is the only channel
      // that can show it. `location` is intentionally ignored — the window/notification
      // distinction is a UI concept that does not exist in a headless host.
      logger.info('AT Terminal: progress — %s', options.title ?? '(untitled)');

      const progress: ProgressReporter = {
        report(value) {
          // `report()` is genuinely forwarded, not dropped. The message is the useful
          // half; bare increments (no text) still get a liveness line so a caller can
          // see progress is moving.
          if (value.message !== undefined) {
            logger.info('AT Terminal: progress — %s', value.message);
          } else if (value.increment !== undefined) {
            logger.info('AT Terminal: progress — +%s', value.increment);
          } else {
            logger.info('AT Terminal: progress — tick');
          }
        }
      };

      // Cancellation is not wired up on the dsh side yet, so the token is the shared
      // non-cancelling one. It is still a real `CancellationToken` (not `undefined`), so
      // a task that reads `token.isCancellationRequested` sees a well-defined `false`
      // rather than crashing. When a cancel path is added it replaces this argument.
      return await task(progress, cancellationTokenNone);
    }
  };
}
