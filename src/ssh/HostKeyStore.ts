import type { Thenable } from '../core/ports';

const HOST_KEYS_KEY = 'sshManager.trustedHostKeys';

export type HostKeyStatus = 'unknown' | 'trusted' | 'changed';

export interface TrustedHostKey {
  host: string;
  port: number;
  fingerprint: string;
  algorithm?: string;
  trustedAt: number;
}

export interface HostKeyMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Fingerprints are stored as the bare sha256 digest ssh2 hands to `hostVerifier`
 * (`hostHash: 'sha256'` in SshConnectionConfig). Prefix it OpenSSH-style for display
 * so users can compare against `ssh-keygen -lf` output; values that already carry a
 * hash label pass through unchanged.
 */
export function formatFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim();
  return /^(sha256|md5):/i.test(trimmed) ? trimmed : `SHA256:${trimmed}`;
}

export class HostKeyStore {
  constructor(private readonly globalState: HostKeyMemento) {}

  async check(host: string, port: number, fingerprint: string): Promise<HostKeyStatus> {
    const keys = this.read();
    const existing = keys[this.key(host, port)];
    if (!existing) {
      return 'unknown';
    }
    return existing.fingerprint === fingerprint ? 'trusted' : 'changed';
  }

  async trust(host: string, port: number, fingerprint: string, algorithm?: string): Promise<void> {
    const keys = this.read();
    keys[this.key(host, port)] = {
      host,
      port,
      fingerprint,
      algorithm,
      trustedAt: Date.now()
    };
    await this.globalState.update(HOST_KEYS_KEY, keys);
  }

  getTrusted(host: string, port: number): TrustedHostKey | undefined {
    return this.read()[this.key(host, port)];
  }

  /**
   * Every trusted key, newest first.
   *
   * The store was write-and-ask-one-host only (`check`, `getTrusted`, `describe`, `forget`),
   * because the connect prompts never needed to look at the set. A trust library the user can
   * review — and prune — needs the set, and reading it here keeps the storage key private.
   *
   * `trustedAt` has millisecond resolution, so a burst of accepts can tie; the address breaks
   * the tie, because a page whose rows swap places between two identical reads looks like it
   * is reordering itself for no reason.
   */
  list(): TrustedHostKey[] {
    return Object.values(this.read()).sort(
      (a, b) => b.trustedAt - a.trustedAt || this.key(a.host, a.port).localeCompare(this.key(b.host, b.port))
    );
  }

  async forget(host: string, port: number): Promise<void> {
    const keys = this.read();
    delete keys[this.key(host, port)];
    await this.globalState.update(HOST_KEYS_KEY, keys);
  }

  /**
   * One-line human summary of the trusted key for a host, or undefined when none is
   * stored. Command handlers (View fingerprint / Forget) render this directly.
   */
  describe(host: string, port: number): string | undefined {
    const entry = this.getTrusted(host, port);
    if (!entry) {
      return undefined;
    }
    const algorithm = entry.algorithm ? ` (${entry.algorithm})` : '';
    return `${entry.host}:${entry.port} ${formatFingerprint(entry.fingerprint)}${algorithm}, trusted ${new Date(entry.trustedAt).toISOString()}`;
  }

  private read(): Record<string, TrustedHostKey> {
    return this.globalState.get<Record<string, TrustedHostKey>>(HOST_KEYS_KEY, {});
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }
}
