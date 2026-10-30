/**
 * Path rules behind agent SFTP write authorization.
 *
 * Remote paths reaching these helpers have already been resolved server-side by `realpath`, so
 * `..` and symlinks are gone; what is left is deciding whether a resolved path is inside the
 * session's working tree and whether it is one of the places an agent could write to buy
 * itself persistence or privilege.
 *
 * `isSensitiveLocalPath` answers a different question and is deliberately not resolved: an
 * upload reads the *user's* disk, and no filesystem call may happen on a path that has not been
 * authorized yet.
 */

export function normalizeRemoteDirectory(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed || '/';
}

export function isWithinRemoteDirectory(root: string, path: string): boolean {
  const normalizedRoot = normalizeRemoteDirectory(root);
  const normalizedPath = normalizeRemoteDirectory(path);
  if (normalizedPath === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

/** System trees where a write is a privilege or persistence change rather than a file edit. */
const SENSITIVE_PREFIXES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/root',
  '/dev',
  '/proc',
  '/sys',
  '/var/spool/cron'
];

/** A path component that makes everything below it sensitive wherever it lives. */
const SENSITIVE_SEGMENTS = new Set(['.ssh']);

const SENSITIVE_BASENAMES = new Set([
  'authorized_keys',
  'authorized_keys2',
  'crontab',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc'
]);

const SENSITIVE_BASENAME_PREFIXES = ['sudoers'];

/** systemd units and timers are the user-writable half of the persistence surface. */
const SENSITIVE_BASENAME_SUFFIXES = ['.service', '.timer'];

export function isSensitiveRemotePath(path: string): boolean {
  const normalized = normalizeRemoteDirectory(path);
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? '';

  if (SENSITIVE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return true;
  }
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(basename)) {
    return true;
  }
  if (SENSITIVE_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix))) {
    return true;
  }
  return SENSITIVE_BASENAME_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

/**
 * Directories on the *local* disk that hold credentials rather than payload.
 *
 * An upload is the one agent operation that reads the user's own machine, and the interesting
 * failure is not "a wrong file landed on the server" but "a private key left the machine".
 * Every `.ssh`/`.aws`/`.gnupg`/`.dsh` tree is a credential store, so anything inside one is
 * worth a second look in the dialog.
 */
const SENSITIVE_LOCAL_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.dsh']);

/** Credential filenames that are sensitive wherever they live. */
const SENSITIVE_LOCAL_BASENAMES = new Set([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'authorized_keys',
  '.netrc',
  '.credentials',
  '.env'
]);

/**
 * Credential files that only matter in their own directory.
 *
 * `.kube` and `.docker` hold plenty of ordinary configuration; flagging the whole directory
 * would put a warning on files that are not secrets, and a warning that fires on the harmless
 * case is one the reader learns to ignore.
 */
const SENSITIVE_LOCAL_FILES: ReadonlyArray<{ directory: string; name: string }> = [
  { directory: '.kube', name: 'config' },
  { directory: '.docker', name: 'config.json' }
];

/** Suffix of the key material that ships as a PEM file, wherever it was exported to. */
const SENSITIVE_LOCAL_SUFFIXES = ['.pem'];

/**
 * Whether a local upload source looks like a credential.
 *
 * Lexical on purpose: it must not touch the disk to answer a question the dialog has not
 * approved yet. `..` is collapsed textually so `docs/../.ssh/id_rsa` is still seen as the key it
 * is. The caller passes the upload's *resolved* path (`statLocalFile` realpaths first), so a
 * symlink cannot disguise a key any more; a hard link or a bind mount still can, which is why
 * this only decides whether the dialog asks *twice* — it never decides whether the upload is
 * allowed.
 *
 * Segment matching is case-insensitive: on Windows and on macOS's default volume `.SSH` is the
 * same directory as `.ssh`, and a warning that misses the file it was written for is worse than
 * one extra prompt.
 */
export function isSensitiveLocalPath(path: string): boolean {
  const segments = normalizeLocalPath(path).map((segment) => segment.toLowerCase());
  if (segments.length === 0) {
    return false;
  }
  const basename = segments.at(-1) ?? '';

  if (segments.some((segment) => SENSITIVE_LOCAL_SEGMENTS.has(segment))) {
    return true;
  }
  if (SENSITIVE_LOCAL_BASENAMES.has(basename)) {
    return true;
  }
  if (SENSITIVE_LOCAL_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    return true;
  }
  return SENSITIVE_LOCAL_FILES.some(
    ({ directory, name }) => basename === name && segments.includes(directory)
  );
}

/** Path segments of a local path with `.`/`..` resolved lexically, in either separator style. */
function normalizeLocalPath(path: string): string[] {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}
