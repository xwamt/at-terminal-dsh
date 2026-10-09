import { describe, expect, it, vi } from 'vitest';
import { createDshNotifier, type DshNotifierDeps } from '../../../src/platform/dsh/notifier';
import type { DshLogger } from '../../../src/platform/dsh/host';

/**
 * `createDshNotifier` is the headless `Notifier`. The two properties worth pinning down
 * are the ones the design turns on:
 *
 * 1. every show*Message reaches the logger at the matching severity — nothing is dropped;
 * 2. an action prompt with no responder returns `undefined` rather than a fabricated
 *    answer, and only asks the injected `respond` when one exists.
 */

interface RecordedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly format: string;
  readonly args: unknown[];
}

function recordingLogger(): { logger: DshLogger; calls: RecordedLog[] } {
  const calls: RecordedLog[] = [];
  return {
    calls,
    logger: {
      info: (format, ...args) => calls.push({ level: 'info', format, args }),
      warn: (format, ...args) => calls.push({ level: 'warn', format, args }),
      error: (format, ...args) => calls.push({ level: 'error', format, args })
    }
  };
}

describe('createDshNotifier', () => {
  it('routes info / warning / error to the matching logger severity, and logs the message', async () => {
    const { logger, calls } = recordingLogger();
    const notifier = createDshNotifier({ logger });

    const info = await notifier.showInformationMessage('No trusted host key is stored.');
    const warning = await notifier.showWarningMessage('Delete SSH server "prod"?');
    const error = await notifier.showErrorMessage('Hub sync failed.');

    // With no actions the host shows no dialog, so all three resolve to undefined.
    expect([info, warning, error]).toEqual([undefined, undefined, undefined]);
    expect(calls).toEqual([
      { level: 'info', format: 'AT Terminal: %s', args: ['No trusted host key is stored.'] },
      { level: 'warn', format: 'AT Terminal: %s', args: ['Delete SSH server "prod"?'] },
      { level: 'error', format: 'AT Terminal: %s', args: ['Hub sync failed.'] }
    ]);
  });

  it('returns undefined for an action prompt when no responder is installed (the safe default)', async () => {
    const { logger, calls } = recordingLogger();
    const notifier = createDshNotifier({ logger });

    const choice = await notifier.showWarningMessage('Delete SSH server "prod"?', { modal: true }, 'Delete');

    // This is exactly the value the VS Code host returns when the user dismisses the box:
    // `confirmAutoSync` -> false and `promptUnsyncedClose` -> 'keep'. No answer was invented.
    expect(choice).toBeUndefined();
    // The offered action still shows up in the log, so a headless reader can see that the
    // prompt existed — the message was not silently swallowed.
    expect(calls).toEqual([
      { level: 'warn', format: 'AT Terminal: %s [Delete]', args: ['Delete SSH server "prod"?'] }
    ]);
  });

  it('asks the injected responder and returns its value when one is installed', async () => {
    const { logger } = recordingLogger();
    const respond = vi.fn<NonNullable<DshNotifierDeps['respond']>>().mockResolvedValue('Copy Fingerprint');
    const notifier = createDshNotifier({ logger, respond });

    const choice = await notifier.showInformationMessage('Stored fingerprint: ab', 'Copy Fingerprint');

    expect(choice).toBe('Copy Fingerprint');
    expect(respond).toHaveBeenCalledWith({
      kind: 'info',
      message: 'Stored fingerprint: ab',
      options: undefined,
      actions: ['Copy Fingerprint']
    });
  });

  it('parses the dual overloads: options are not mistaken for an action', async () => {
    const { logger } = recordingLogger();
    const requests: Array<Parameters<NonNullable<DshNotifierDeps['respond']>>[0]> = [];
    const notifier = createDshNotifier({
      logger,
      respond: async (request) => {
        requests.push(request);
        return request.actions[0];
      }
    });

    // (msg, options, ...actions)
    const modal = await notifier.showErrorMessage(
      'Hub sync failed',
      { modal: true, detail: 'The remote returned 500.' },
      'Repair',
      'Retry'
    );
    // (msg, ...actions) — no options object, so the actions start at the first argument.
    const plain = await notifier.showWarningMessage('Overwrite "a.txt"?', 'Overwrite', 'Skip');

    expect(modal).toBe('Repair');
    expect(plain).toBe('Overwrite');
    expect(requests).toEqual([
      {
        kind: 'error',
        message: 'Hub sync failed',
        options: { modal: true, detail: 'The remote returned 500.' },
        actions: ['Repair', 'Retry']
      },
      {
        kind: 'warning',
        message: 'Overwrite "a.txt"?',
        options: undefined,
        actions: ['Overwrite', 'Skip']
      }
    ]);
  });

  it('withProgress returns the task value, logs the title once, and really forwards report()', async () => {
    const { logger, calls } = recordingLogger();
    const notifier = createDshNotifier({ logger });

    const result = await notifier.withProgress(
      { location: 'notification', title: 'Uploading file', cancellable: false },
      async (progress) => {
        progress.report({ increment: 30, message: '1 KiB / 4 KiB' });
        progress.report({ increment: 70, message: '4 KiB / 4 KiB' });
        return 'done';
      }
    );

    expect(result).toBe('done');
    expect(calls).toEqual([
      { level: 'info', format: 'AT Terminal: progress — %s', args: ['Uploading file'] },
      { level: 'info', format: 'AT Terminal: progress — %s', args: ['1 KiB / 4 KiB'] },
      { level: 'info', format: 'AT Terminal: progress — %s', args: ['4 KiB / 4 KiB'] }
    ]);
  });

  it('hands a cancellable task a real token (not cancelled — dsh has no cancel path yet)', async () => {
    const { logger } = recordingLogger();
    const notifier = createDshNotifier({ logger });
    let seen: boolean | undefined;

    await notifier.withProgress({ title: 'Sync', cancellable: true }, async (_progress, token) => {
      seen = token.isCancellationRequested;
      return undefined;
    });

    expect(seen).toBe(false);
  });
});
