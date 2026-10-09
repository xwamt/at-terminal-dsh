import {
  NOOP_DSH_LOGGER,
  type DshCredentialDescription,
  type DshCredentialProvider,
  type DshCredentialRef,
  type DshCredentialResolution,
  type DshDomain,
  type DshDomainSpec,
  type DshDomainTable,
  type DshHostFacts,
  type DshLogger,
  type DshResolvedSettings,
  type DshStorageDomain
} from '../../../src/platform/dsh/host';

/**
 * Fakes for the **dsh host facets**, built from the shapes proven against the
 * installed Harness (`src/platform/dsh/host.ts` records the evidence next to each
 * declaration).
 *
 * The point of these is to be faithful, not convenient: each fake reproduces the
 * failure behaviour of the real service too, because the interesting half of an
 * adapter is what it does when the host says no. `MemoryStorageDomain` therefore
 * rejects a second open of one name (`already-open`), validates every stored record
 * through the spec's schema the way `DomainFacility.open` does, and refuses reads
 * after `close()` — exactly the three rules `DomainImpl` enforces.
 *
 * The name is `host-fakes.ts`, not `fakes.ts`, on purpose: `test/core/fakes.ts`
 * covers the *ports*, this file covers the *host*. Keeping the two apart stops a
 * port fake from quietly standing in for a host service.
 */

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface RecordedLog {
  readonly level: 'info' | 'warn' | 'error';
  /** The raw printf-style format string; arguments are kept separate, as the host does. */
  readonly format: string;
  readonly args: readonly unknown[];
}

export class RecordingDshLogger implements DshLogger {
  readonly entries: RecordedLog[] = [];

  info(format: string, ...args: unknown[]): void {
    this.entries.push({ level: 'info', format, args });
  }

  warn(format: string, ...args: unknown[]): void {
    this.entries.push({ level: 'warn', format, args });
  }

  error(format: string, ...args: unknown[]): void {
    this.entries.push({ level: 'error', format, args });
  }

  /** Every logged line flattened, for "the secret never appears anywhere" assertions. */
  join(): string {
    return this.entries.map((entry) => `${entry.format} ${entry.args.map(String).join(' ')}`).join('\n');
  }
}

export { NOOP_DSH_LOGGER };

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface MemoryCredentialEntry {
  readonly value: string;
  readonly source: DshCredentialResolution['source'];
}

/**
 * Emulates `dsh-credentials-local`: an environment layer over a writable document.
 *
 * `inherited` holds references the launching process supplies; like the real
 * provider, they win over the document **and** make `set`/`unset` throw rather than
 * shadow.
 */
export class MemoryCredentialProvider implements DshCredentialProvider {
  readonly document = new Map<DshCredentialRef, string>();
  readonly inherited = new Map<DshCredentialRef, string>();
  /** Set to make `resolve` reject, to prove the adapter does not swallow host faults. */
  failResolve?: Error;

  async resolve(ref: DshCredentialRef): Promise<DshCredentialResolution | undefined> {
    if (this.failResolve !== undefined) {
      throw this.failResolve;
    }
    const fromEnv = this.inherited.get(ref);
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return { value: fromEnv, source: 'env' };
    }
    const stored = this.document.get(ref);
    // The seam-wide rule: an empty stored value is absent everywhere.
    return stored !== undefined && stored.length > 0 ? { value: stored, source: 'file' } : undefined;
  }

  async describe(ref: DshCredentialRef): Promise<DshCredentialDescription> {
    const inherited = this.inherited.get(ref);
    if (inherited !== undefined && inherited.length > 0) {
      return { configured: true, source: 'env', writable: false };
    }
    const stored = this.document.get(ref);
    return stored !== undefined && stored.length > 0
      ? { configured: true, source: 'file', writable: true }
      : { configured: false, writable: true };
  }

  async set(ref: DshCredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`);
    }
    this.assertUnshadowed(ref, 'set');
    this.document.set(ref, value);
  }

  async unset(ref: DshCredentialRef): Promise<void> {
    this.assertUnshadowed(ref, 'unset');
    this.document.delete(ref);
  }

  private assertUnshadowed(ref: DshCredentialRef, verb: string): void {
    const inherited = this.inherited.get(ref);
    if (inherited !== undefined && inherited.length > 0) {
      throw new Error(
        `credentials-local: "${ref}" is supplied read-only by the launching environment, so ${verb} would be shadowed`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Storage domain
// ---------------------------------------------------------------------------

/** Mirrors the real `DomainError` codes the facility can raise. */
export class FakeDomainError extends Error {
  constructor(
    readonly code: 'already-open' | 'invalid-record' | 'closed' | 'backend-not-found' | 'facet-unsupported',
    message: string
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

class MemoryDomainTable implements DshDomainTable {
  constructor(
    private readonly owner: MemoryDomain,
    private readonly records: Map<string, unknown>
  ) {}

  private assertReadable(): void {
    if (this.owner.closed) {
      throw new FakeDomainError('closed', `domain '${this.owner.name}' is closed`);
    }
  }

  get(key: string): unknown {
    this.assertReadable();
    return this.records.get(key);
  }

  keys(): Iterable<string> {
    this.assertReadable();
    return [...this.records.keys()];
  }

  async put(key: string, value: unknown): Promise<void> {
    this.assertReadable();
    this.records.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    this.assertReadable();
    return this.records.delete(key);
  }

  /** Direct view for assertions; bypasses the domain's write chain like a medium dump would. */
  snapshot(): ReadonlyMap<string, unknown> {
    return this.records;
  }
}

class MemoryDomain implements DshDomain {
  closed = false;
  private readonly tables = new Map<string, MemoryDomainTable>();

  constructor(
    readonly name: string,
    private readonly onClosed: () => void,
    spec: DshDomainSpec,
    /** The medium's own maps; the tables write through, so a reopened domain sees every write. */
    records: Map<string, Map<string, unknown>>
  ) {
    for (const [table, stored] of records) {
      this.tables.set(table, new MemoryDomainTable(this, stored));
    }
    void spec;
  }

  table(name: string): DshDomainTable {
    const found = this.tables.get(name);
    if (found === undefined) {
      throw new Error(`domain '${this.name}' declares no table '${name}'`);
    }
    return found;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClosed();
  }
}

/**
 * Emulates `DomainFacility` on top of `defineDomain`'s validation rules.
 *
 * The medium is the source of truth and the open domains' tables write straight into
 * it, so closing and reopening a domain is a real restart: whatever a `put` left
 * behind is what the next `open` validates and loads.
 */
export class MemoryStorageDomain implements DshStorageDomain {
  private readonly media = new Map<string, Map<string, Map<string, unknown>>>();
  private readonly openDomains = new Map<string, MemoryDomain>();
  readonly openCalls: string[] = [];
  failNextOpen?: Error;

  async open<T = unknown>(spec: DshDomainSpec): Promise<DshDomain<T>> {
    this.openCalls.push(spec.name);
    if (this.failNextOpen !== undefined) {
      const error = this.failNextOpen;
      this.failNextOpen = undefined;
      throw error;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(spec.name)) {
      throw new Error(`domain name '${spec.name}' must match /^[a-z][a-z0-9_]*$/`);
    }
    if (!Number.isInteger(spec.version) || spec.version < 0) {
      throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
    }
    if (this.openDomains.has(spec.name)) {
      throw new FakeDomainError('already-open', `domain '${spec.name}' is already open`);
    }
    for (const table of Object.keys(spec.tables)) {
      if (!/^[a-z][a-z0-9_]*$/.test(table)) {
        throw new Error(`domain '${spec.name}' table name '${table}' must match /^[a-z][a-z0-9_]*$/`);
      }
    }

    // Reload from the medium, validating every record the way DomainFacility does.
    // The validated maps replace the medium's, so what the domain holds is what a
    // real reopen would load rather than the pre-validation input.
    const unit = new Map<string, Map<string, unknown>>();
    for (const [table, tableSpec] of Object.entries(spec.tables)) {
      const stored = new Map<string, unknown>();
      for (const [key, raw] of this.media.get(spec.name)?.get(table) ?? []) {
        try {
          stored.set(key, tableSpec.valueSchema.parse(raw));
        } catch {
          throw new FakeDomainError(
            'invalid-record',
            `domain '${spec.name}': stored record '${key}' in table '${table}' does not match its schema`
          );
        }
      }
      unit.set(table, stored);
    }
    this.media.set(spec.name, unit);

    const domain = new MemoryDomain(spec.name, () => this.openDomains.delete(spec.name), spec, unit);
    this.openDomains.set(spec.name, domain);
    return domain as DshDomain<T>;
  }

  /** The raw medium, for "what would a restart load" assertions. */
  dump(name: string): Map<string, Map<string, unknown>> {
    return this.media.get(name) ?? new Map();
  }

  /**
   * Write a record straight into the medium, bypassing every write-path check — the
   * test-side equivalent of hand-editing the JSON document. Used to prove that an
   * `invalid-record` really aborts `open()`.
   */
  seedRaw(name: string, table: string, key: string, value: unknown): void {
    const unit = this.media.get(name) ?? new Map<string, Map<string, unknown>>();
    const records = unit.get(table) ?? new Map<string, unknown>();
    records.set(key, value);
    unit.set(table, records);
    this.media.set(name, unit);
  }
}

// ---------------------------------------------------------------------------
// Settings and host facts
// ---------------------------------------------------------------------------

/**
 * A live settings bundle: `read()` is consulted on every access, so a test can
 * change a value mid-flight and prove the adapter re-reads instead of caching.
 */
export function createResolvedSettings(values: Record<string, unknown>): DshResolvedSettings {
  const result: Record<string, { get(): unknown }> = {};
  for (const key of Object.keys(values)) {
    result[key] = { get: () => values[key] };
  }
  return result;
}

export function createDshHostFacts(overrides: Partial<DshHostFacts> = {}): DshHostFacts {
  return {
    pluginName: '@at-series/dsh-at-terminal',
    pluginVersion: '0.1.0',
    bundlePath: '/home/user/.dsh/bundles/at-terminal',
    storageDir: '/home/user/.dsh/storages/at-terminal',
    appName: 'DeepSeek Harness',
    appRoot: '/Applications/DeepSeek Harness.app',
    uriScheme: 'dsh',
    ...overrides
  };
}
