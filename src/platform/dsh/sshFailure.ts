/**
 * Turn a failed SSH connect into a **coded** failure the panel can act on.
 *
 * A user's first real connect surfaced this gap: the stored credential no longer
 * worked, and the panel showed `connect-failed: All configured authentication methods
 * failed` — ssh2's wording, which names neither what was tried nor what to do. The
 * domain layer already throws coded errors for the cases it knows (`password-missing`,
 * `private-key-path-missing`, the verifier's `host-key-*`); this maps what ssh2 and
 * Node report onto the same vocabulary, so the Client half can render actionable copy
 * by code instead of passing a raw library string through.
 *
 * Deliberately only claims what the error itself says — a classification, not a
 * diagnosis: an authentication failure is reported as *rejected*, not as "wrong
 * password", because the server does not tell us which part it disliked.
 */

export interface CodedSshFailure {
  code: string;
  message: string;
}

interface SshErrorLike {
  code?: unknown;
  level?: unknown;
  message?: unknown;
}

/** Node/`ssh2` transport codes this vocabulary recognises. */
const TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENOENT', 'EHOSTUNREACH', 'ENETUNREACH']);

function target(context: { host?: string; port?: number }): string {
  if (context.host === undefined) return 'the server';
  return context.port === undefined ? context.host : `${context.host}:${context.port}`;
}

export function classifySshFailure(
  error: unknown,
  context: { host?: string; port?: number } = {}
): CodedSshFailure {
  const candidate = (error ?? undefined) as SshErrorLike | undefined;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof candidate?.code === 'string' ? candidate.code : undefined;
  const level = typeof candidate?.level === 'string' ? candidate.level : undefined;
  const where = target(context);

  // ssh2's own classification. `client-authentication` is what a rejected password or
  // key looks like; the server lists the methods it accepts, not the one it disliked.
  if (level === 'client-authentication') {
    return {
      code: 'authentication-failed',
      message: `${where} rejected every authentication method this connection offered (${message}).`
    };
  }
  if (level === 'client-timeout') {
    return { code: 'connection-timeout', message: `Timed out connecting to ${where}.` };
  }

  if (code !== undefined && TRANSPORT_CODES.has(code)) {
    if (code === 'ECONNREFUSED') {
      return { code: 'connection-refused', message: `Nothing is listening on ${where}.` };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { code: 'host-unresolved', message: `${where} could not be resolved.` };
    }
    if (code === 'ENOENT') {
      // The only file this path reads is the private key, so a missing file here is a
      // missing key, not a generic I/O failure.
      return {
        code: 'private-key-unreadable',
        message: `The private key for ${where} could not be read: ${message}`
      };
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return { code: 'host-unreachable', message: `${where} is unreachable.` };
    }
    return { code: 'connection-timeout', message: `Connecting to ${where} timed out.` };
  }

  // A failure the domain already classified keeps its identity — the panel has copy
  // for those (`password-missing`, `private-key-path-missing`, `host-key-*`, …).
  if (code !== undefined) return { code, message };

  return { code: 'connect-failed', message };
}