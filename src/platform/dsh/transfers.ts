import type { Notifier, TransferProgress, TransferReporter } from '../../core/ports';
import {
  FAILED_NOTIFICATION_MS,
  showTimedNotification,
  TIMED_NOTIFICATION_MS
} from '../../utils/notifications';

/**
 * The dsh implementation of the `TransferReporter` port — DSH-16.
 *
 * This is the **thin** adapter, and it is worth saying what it is *not*:
 * `src/sftp/VscodeTransferReporter.ts` is a different thing despite the similar name.
 * That class owns transfer-specific presentation — it computes the integer percent,
 * formats byte counts with `formatFileSize`, and throttles reports to one per
 * `PROGRESS_REPORT_MIN_INTERVAL_MS`/percent step because SFTP fires a callback every
 * 32 KiB. None of that is a host-adaptation concern, so none of it is repeated here.
 *
 * This file only performs the **shape translation** the two layers disagree on:
 *
 * - `TransferReporter.withProgress(label, job)` wraps a `TransferProgress` (bytes,
 *   bytes) around the notifier's `ProgressReporter` (`{increment?, message?}`).
 * - `notifySuccess` / `notifyFailure` are the same self-dismissing toasts the VS Code
 *   adapter reuses, so a success/failure of an SFTP transfer reads identically on
 *   both hosts. `showTimedNotification` posts through the installed platform's
 *   notifier (`src/utils/notifications.ts`), which on this host is `createDshNotifier`
 *   — the toast therefore becomes a log line plus a live progress task.
 *
 * If dsh ever needs to throttle, that decision belongs to the caller (or to the notifier
 * that renders the reports), not to this translation layer.
 */
export function createDshTransferReporter(notifier: Notifier): TransferReporter {
  return {
    async withProgress<T>(
      label: string,
      job: (progress: TransferProgress) => Promise<T>
    ): Promise<T> {
      return await notifier.withProgress(
        // `cancellable: false` mirrors the VS Code reporter: an SFTP byte transfer is not
        // interrupted from the progress surface, so offering a cancel affordance that the
        // adapter cannot honour would be a lie on either host.
        { location: 'notification', title: label, cancellable: false },
        async (progress) => {
          return await job({
            report: ({ transferredBytes, totalBytes }) => {
              // The port carries raw byte counts; the progress reporter carries text.
              // Rendering that text is the display layer's job, so this stays a one-line
              // mapping rather than re-deriving the VS Code percent/increment arithmetic.
              progress.report({ message: `${transferredBytes} / ${totalBytes}` });
            }
          });
        }
      );
    },

    async notifySuccess(message: string): Promise<void> {
      showTimedNotification(message, 'info', TIMED_NOTIFICATION_MS);
    },

    async notifyFailure(message: string): Promise<void> {
      showTimedNotification(message, 'error', FAILED_NOTIFICATION_MS);
    }
  };
}
