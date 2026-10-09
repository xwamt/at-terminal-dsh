import { describe, expect, it, vi } from 'vitest';
import { cancellationTokenNone } from '../../../src/core';
import { createDshTransferReporter } from '../../../src/platform/dsh/transfers';
import { platform } from '../../../src/platform/current';
import { FakeNotifier, type FakePlatform } from '../../core/fakes';

/**
 * The dsh transfer reporter is the **thin** translation layer: it wraps a
 * `TransferProgress` around the notifier's `ProgressReporter` and reuses the shared
 * self-dismissing toasts. The VS Code reporter's percent arithmetic and throttling are
 * deliberately absent, and the first test below is the one that proves the reports go
 * through unfiltered.
 */

describe('createDshTransferReporter', () => {
  it('wraps the job in notifier.withProgress (notification, not cancellable) and forwards every report', async () => {
    const notifier = new FakeNotifier();
    const reporter = createDshTransferReporter(notifier);

    const result = await reporter.withProgress('Upload /etc/nginx/ng.sh', async (progress) => {
      // Two reports at the same integer percent / same millisecond. The VS Code reporter
      // would throttle the second away; the thin adapter must not, so both reach the port.
      progress.report({ transferredBytes: 500, totalBytes: 100_000 });
      progress.report({ transferredBytes: 600, totalBytes: 100_000 });
      return 'saved';
    });

    expect(result).toBe('saved');
    expect(notifier.progressCalls).toHaveLength(1);
    expect(notifier.progressCalls[0].options).toEqual({
      location: 'notification',
      title: 'Upload /etc/nginx/ng.sh',
      cancellable: false
    });
    expect(notifier.progressCalls[0].reports).toEqual([
      { message: '500 / 100000' },
      { message: '600 / 100000' }
    ]);
  });

  it('posts the shared $(info)/$(error) toasts with the standard 3s/8s durations', async () => {
    vi.useFakeTimers();
    try {
      // `notifySuccess`/`notifyFailure` route through `showTimedNotification`, which posts
      // via the installed platform's notifier — the same path `VscodeTransferReporter`
      // uses. The spy therefore lives on the fake platform notifier.
      const notifier = (platform() as FakePlatform).notifier;
      const dismissed: string[] = [];
      const withProgress = vi
        .spyOn(notifier, 'withProgress')
        .mockImplementation(async (options, task) => {
          await task({ report: vi.fn() }, cancellationTokenNone);
          dismissed.push(options.title as string);
          return undefined as never;
        });
      const reporter = createDshTransferReporter(new FakeNotifier());
      let resumed = 0;

      // `notify*` returns as soon as the toast is posted, without holding the transfer.
      void reporter.notifySuccess('Upload /etc/nginx/ng.sh completed.').then(() => {
        resumed += 1;
      });
      void reporter.notifyFailure('Upload /etc/nginx/ng.sh failed.').then(() => {
        resumed += 1;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(resumed).toBe(2);
      expect(dismissed).toEqual([]);

      await vi.advanceTimersByTimeAsync(3000);
      expect(dismissed).toEqual(['$(info) Upload /etc/nginx/ng.sh completed.']);
      await vi.advanceTimersByTimeAsync(5000);
      expect(dismissed).toEqual([
        '$(info) Upload /etc/nginx/ng.sh completed.',
        '$(error) Upload /etc/nginx/ng.sh failed.'
      ]);

      expect(withProgress).toHaveBeenCalledWith(
        {
          location: 'notification',
          title: '$(info) Upload /etc/nginx/ng.sh completed.',
          cancellable: false
        },
        expect.any(Function)
      );
      expect(withProgress).toHaveBeenCalledWith(
        {
          location: 'notification',
          title: '$(error) Upload /etc/nginx/ng.sh failed.',
          cancellable: false
        },
        expect.any(Function)
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
