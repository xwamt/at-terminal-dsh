import type { Event } from './emitter';
import { noopDisposable } from './disposable';

/**
 * A platform-agnostic cancellation token, shaped to match VS Code's `CancellationToken`.
 *
 * Its only real consumption site so far is `src/sftp/SftpDragAndDropController.ts`
 * (`handleDrop(..., _token: CancellationToken)`, currently unused). It is still kept in
 * the port vocabulary because `Notifier.withProgress`'s task callback receives a token on
 * the VS Code side (`window.withProgress(options, (progress, token) => ...)`); declaring
 * it here keeps Progress's cancellation semantics from being lost during the migration.
 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

/** A token that never cancels, used as the default for optional token parameters. */
export const cancellationTokenNone: CancellationToken = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => noopDisposable
});
