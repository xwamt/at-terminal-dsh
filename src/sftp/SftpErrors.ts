import { t } from '../i18n/t';

/**
 * An upload found an entry already sitting at the remote destination. The UI catches this
 * to offer overwrite / skip / overwrite-all instead of silently clobbering the remote file,
 * so this error must stay identifiable after crossing module boundaries -- hence the stable
 * `name` plus the {@link isSftpConflictError} guard that also matches on it.
 */
export class SftpConflictError extends Error {
  override readonly name = 'SftpConflictError';

  constructor(public readonly path: string) {
    super(t('Remote path already exists: {path}', { path }));
  }
}

export function isSftpConflictError(error: unknown): error is SftpConflictError {
  if (error instanceof SftpConflictError) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'SftpConflictError' &&
    typeof (error as { path?: unknown }).path === 'string'
  );
}

/**
 * A literal string replacement could not be applied exactly once.
 *
 * Two situations share one type because the remedy is the same kind of decision — the model
 * has to change the call, not retry it: zero matches means the text it remembered is not in
 * the file, and several matches means the needle is not specific enough. The message names
 * the fix in both cases; `occurrences` is carried so a caller can tell them apart without
 * parsing English.
 */
export class SftpEditMatchError extends Error {
  override readonly name = 'SftpEditMatchError';
  readonly code = 'sftp-edit-match';

  constructor(
    public readonly path: string,
    public readonly occurrences: number
  ) {
    super(
      occurrences === 0
        ? `Found 0 occurrences of oldString in ${path}. The file may have changed; re-read it and retry with the exact text.`
        : `Found ${occurrences} occurrences; pass replaceAll or provide a longer match (${path}).`
    );
  }
}

/**
 * A write was refused because the file was never read through this connection.
 *
 * The code mirrors the Host's local `FS_NOT_OBSERVED`: `sftpWriteGuard: 'strict'` is an
 * explicit request to require a read first, and the message states the one action that
 * satisfies it. Distinct from {@link SftpStaleVersionError} because the caller has seen no
 * version at all, so "re-read" alone would not explain which read was missing.
 */
export class SftpNotObservedError extends Error {
  override readonly name = 'SftpNotObservedError';
  readonly code = 'sftp-not-observed';

  constructor(public readonly path: string) {
    super(`Cannot modify "${path}": file has not been read — read the file, then retry.`);
  }
}

/**
 * A write was refused because the remote file changed after it was read.
 *
 * The code mirrors the Host's local `FS_STALE_VERSION`. SFTP has no atomic compare-and-swap,
 * so this is a stat-before-write check: it narrows the race window but cannot close it. The
 * message still names the recovery the agent can perform — re-read, merge, retry — because a
 * conflict the caller cannot act on is only a slightly earlier failure.
 */
export class SftpStaleVersionError extends Error {
  override readonly name = 'SftpStaleVersionError';
  readonly code = 'sftp-stale-version';

  constructor(
    public readonly path: string,
    public readonly expected?: { size?: number; modifiedAt?: number },
    public readonly actual?: { size: number; modifiedAt: number }
  ) {
    const expectedText = expectedSummary(expected);
    const actualText = actual === undefined ? '' : `; now ${actual.size} bytes / modifiedAt ${actual.modifiedAt}`;
    super(
      `Remote file changed since it was read (${path})${expectedText === '' ? '' : `: expected ${expectedText}`}${actualText}. ` +
        're-read it, then retry.'
    );
  }
}

function expectedSummary(expected: { size?: number; modifiedAt?: number } | undefined): string {
  if (expected === undefined) return '';
  const parts: string[] = [];
  if (expected.size !== undefined) parts.push(`${expected.size} bytes`);
  if (expected.modifiedAt !== undefined) parts.push(`modifiedAt ${expected.modifiedAt}`);
  return parts.join(' / ');
}

/** One file operation that failed during apply-patch preflight. */
export interface SftpPatchRefusal {
  /** Zero-based position in patch order. */
  index: number;
  kind: 'add' | 'update' | 'delete' | 'move';
  path: string;
  destination?: string;
  /** One-based line of the operation header in the original patch. */
  patchLine: number;
  code: string;
  message: string;
  hunkLine?: number;
}

/** A patch could not be parsed; nothing was read from or written to the server. */
export class SftpPatchSyntaxError extends Error {
  override readonly name = 'SftpPatchSyntaxError';
  readonly code = 'sftp-patch-syntax';

  constructor(
    public readonly lineNumber: number,
    public readonly reason: string
  ) {
    super(`Invalid patch at line ${lineNumber}: ${reason}`);
  }
}

/**
 * A well-formed patch was refused before the commit phase.
 *
 * Every refusal is collected so the model can fix the whole patch in one retry. The error is
 * thrown rather than returned exactly like the Host's local `apply_patch`, whose syntax and
 * preflight failures are tool errors while a stopped commit is a normal result.
 */
export class SftpPatchRejectedError extends Error {
  override readonly name = 'SftpPatchRejectedError';
  readonly code = 'sftp-patch-preflight';

  constructor(public readonly refusals: readonly SftpPatchRefusal[]) {
    super(
      `Patch rejected before any change (${refusals.length} problem${refusals.length === 1 ? '' : 's'}):\n` +
        refusals
          .map(
            (refusal) =>
              `- operation ${refusal.index + 1} (${refusal.kind} ${refusal.path}${
                refusal.destination === undefined ? '' : ` -> ${refusal.destination}`
              }, patch line ${refusal.patchLine}): ${refusal.message}`
          )
          .join('\n')
    );
  }
}
