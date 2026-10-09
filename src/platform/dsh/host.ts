/**
 * The DeepSeek Harness side of the port layer: a **structural** view of the host
 * facets the dsh adapters consume.
 *
 * Why structural instead of importing `@deepseek-ai/*`:
 *
 * 1. **Module resolution.** dsh installs a local-path bundle as a `link:`
 *    dependency, so Node resolves `dsh/index.js`'s bare specifiers by walking up
 *    from that file and can never reach the packages inside `app.asar`. The first
 *    installed run failed exactly this way (`ERR_MODULE_NOT_FOUND:
 *    @deepseek-ai/schemastery`, see `dsh/README.md`). `scripts/verify-kernel-seam.mjs`
 *    forbids a bare specifier under `src/**`, so nothing here may import one.
 * 2. **Testability.** Every shape below is derived from the *installed* Harness,
 *    read out of `app.asar` (see `dsh/scripts/lib/asar.mjs`), and recorded next to
 *    the declaration with the evidence. A fake that satisfies the interface is
 *    therefore a faithful stand-in for the real service, and the unit tests run
 *    without a dsh installation.
 *
 * Deriving shapes from real code, not from documentation, is the rule this whole
 * milestone follows: the plan's original M2 table assumed `ctx.settings.installSection()`
 * and `ctx.secrets` / `ctx.globalState`, and all three turned out not to exist.
 *
 * ## Where each facet comes from in the default composition
 *
 * Checked against `@deepseek-ai/dsh-base/cordis.patch.yml` (the profile bundles
 * `dsh-base` + `dsh-web-app`), so these services are present by default and this
 * plugin does not have to mount them — which matters, because a cordis bundle patch
 * can only insert its own row (patch semantics are *replace*, not merge):
 *
 * | `ctx.<x>`                            | mounted by                              | row config |
 * |---|---|---|
 * | `ctx.credentials`                    | `@deepseek-ai/dsh-credentials-local`    | (none; `$DSH_HOME/.credentials.yaml`) |
 * | `ctx.storageDomain`                  | `@deepseek-ai/dsh-storage-domain`       | `backend: json` |
 * | `ctx.storage` (the hub)              | `@deepseek-ai/dsh-storage` + `-json`    | `root: $DSH_HOME/storages` |
 * | `ctx.webServer`                      | `@deepseek-ai/dsh-host-webserver`       | mounted by `dsh-web-app` |
 * | `ctx.tools`, `ctx.jobs`, `ctx.settings`, `ctx.logger` | `dsh-base`          | — |
 */

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * dsh's logger is a printf-style logger, not a structured one — the shipped code
 * calls `ctx.logger.warn('credentials: a %s listener for "%s" failed', event, subject)`.
 * The adapter must therefore pass arguments through rather than pre-formatting.
 */
export interface DshLogger {
  info(format: string, ...args: unknown[]): void;
  warn(format: string, ...args: unknown[]): void;
  error(format: string, ...args: unknown[]): void;
}

/** A logger that swallows everything; used where a facet is genuinely optional. */
export const NOOP_DSH_LOGGER: DshLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// ---------------------------------------------------------------------------
// Credentials — `@deepseek-ai/dsh-credentials` (CredentialProvider, ctx.credentials)
// ---------------------------------------------------------------------------

/**
 * A credential *reference*: a POSIX-shell identifier such as
 * `DEEPSEEK_API_KEY`. The real service brands the string, but the brand is
 * compile-time only, so a plain `string` is the whole runtime contract.
 *
 * The grammar enforced by `credentialRef()` is `/^[A-Za-z_][A-Za-z0-9_]*$/`, and
 * **it is enforced** — a name outside it throws `TypeError` rather than returning
 * an unset credential. `credentialRefName()` below reproduces the grammar so the
 * adapter can reject an unmappable id before crossing the seam, instead of letting
 * a `TypeError` escape from deep inside a resolve.
 */
export type DshCredentialRef = string;

/** Where a resolved value came from. `env` is read-only; `file` is the provider's document. */
export type DshCredentialSource = 'env' | 'file' | 'project-env' | 'user-env';

/** What `resolve()` returns. Absent when nothing in any layer supplies the reference. */
export interface DshCredentialResolution {
  readonly value: string;
  readonly source: DshCredentialSource;
}

/**
 * What `describe()` returns. **Never carries the value** — that is the seam's
 * central promise and the reason the "credentials must not appear in any response
 * or log" requirement is checkable at all.
 */
export interface DshCredentialDescription {
  readonly configured: boolean;
  readonly source?: DshCredentialSource;
  /** false when the value is supplied by the launching environment (read-only). */
  readonly writable: boolean;
}

/**
 * The reference half of the credential seam — the part this plugin uses.
 *
 * Layering is `process environment` → the provider-managed document
 * (`$DSH_HOME/.credentials.yaml`) → project/user `.env`. One seam-wide rule binds
 * it: **an empty stored value is absent everywhere**, so a blank never
 * masquerades as a configured secret.
 *
 * `set()` on a reference the launching environment already supplies **throws**
 * (`"... is supplied read-only by the launching environment, so set would be
 * shadowed"`). That is a real conflict the caller must see, so the adapter lets it
 * propagate rather than swallowing it.
 *
 * Not used by this plugin: the *record* half (`credentialKey` +
 * `readRecord`/`modifyRecord`/…). Records only admit the tags `api-key`
 * (`{kind, key?, env?}`) and `grant` (`{kind, payload}`) — neither is an SSH
 * password, and `modifyRecord` is the only write path. The reference half is the
 * one that means "a secret the user configured, addressed by a name".
 */
export interface DshCredentialProvider {
  resolve(ref: DshCredentialRef): Promise<DshCredentialResolution | undefined>;
  describe(ref: DshCredentialRef): Promise<DshCredentialDescription>;
  set(ref: DshCredentialRef, value: string): Promise<void>;
  unset(ref: DshCredentialRef): Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage domain — `@deepseek-ai/dsh-storage-domain` (DomainFacility, ctx.storageDomain)
// ---------------------------------------------------------------------------

/**
 * The only member of a table's `valueSchema` the runtime actually calls.
 *
 * The package documents record schemas as zod, and its `DomainImpl` does call
 * `tableSpec.valueSchema.parse(raw)` for every stored record on open (and
 * `global.schema.safeParse(null)` once, to reject a nullable global). Nothing
 * touches a table schema beyond `.parse`, so the declaration below states the
 * runtime requirement honestly rather than pretending to re-type zod here.
 */
export interface DshValueSchema<T = unknown> {
  parse(value: unknown): T;
}

/** One entry of `spec.tables`; `domainTable(schema)` in the real package. */
export interface DshDomainTableSpec<T = unknown> {
  readonly valueSchema: DshValueSchema<T>;
}

/**
 * A domain declaration, as accepted by `defineDomain`.
 *
 * `defineDomain` validates this eagerly at module load and throws on: a `name` or
 * table name outside `/^[a-z][a-z0-9_]*$/` (note: underscores, **no** hyphens), a
 * non-integer or negative `version`, a `compatibleVersions` entry that is not a
 * non-negative integer below `version`, a `layout` other than `'single'` /
 * `'per-record'`, an `invalidRecords` other than `'backup-and-skip'`, and a
 * global schema that accepts `null` (`null` is the medium's "never written"
 * sentinel, so a stored `null` could not round-trip).
 */
export interface DshDomainSpec {
  readonly name: string;
  readonly version: number;
  readonly tables: Readonly<Record<string, DshDomainTableSpec>>;
  readonly layout?: 'single' | 'per-record';
  readonly compatibleVersions?: readonly number[];
  readonly invalidRecords?: 'backup-and-skip';
}

/**
 * A table handle. **Reads are synchronous and served from memory**; every write
 * queues on the domain's single write chain, awaits backend durability first, then
 * mutates memory — a rejected backend write therefore leaves memory untouched.
 *
 * `get` returns `undefined` for an absent key. `delete` returns whether a record
 * was actually removed. There is no `has`; use `get(...) !== undefined`.
 */
export interface DshDomainTable<T = unknown> {
  get(key: string): T | undefined;
  keys(): Iterable<string>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** An opened domain. The **caller owns it** and must `close()` it. */
export interface DshDomain<T = unknown> {
  readonly name: string;
  table(name: string): DshDomainTable<T>;
  close(): Promise<void>;
}

/**
 * `ctx.storageDomain`. `open()` fails loud rather than degrading:
 * `already-open` (the name is reserved by an in-flight or completed open),
 * `backend-not-found`, `facet-unsupported` (the routed backend has no `kv` facet),
 * or `invalid-record` (a stored record failed its schema).
 */
export interface DshStorageDomain {
  open<T = unknown>(spec: DshDomainSpec): Promise<DshDomain<T>>;
}

// ---------------------------------------------------------------------------
// Settings — `@deepseek-ai/dsh-settings` + `@deepseek-ai/dsh-config-editor`
// ---------------------------------------------------------------------------

/**
 * One resolved config field. `ctx` hands `apply()` the output of `resolveConfig()`,
 * where every `.volatile()` field is a stable accessor; reading it per call is what
 * makes a live settings edit observable without remounting the plugin.
 */
export interface DshSettingAccessor {
  get(): unknown;
}

/**
 * Resolved plugin config, keyed by the field names this bundle declares in
 * `dsh/settings.js`. The keys there drop the VS Code `sshManager.` prefix, so the
 * mapping to the `sshManager` config section is a plain rename — see
 * `src/platform/dsh/config.ts`.
 */
export type DshResolvedSettings = Readonly<Record<string, DshSettingAccessor | undefined>>;

// ---------------------------------------------------------------------------
// Plugin identity and host facts
// ---------------------------------------------------------------------------

/**
 * Facts the assembly injects because dsh cannot be asked for them the way VS Code
 * can. `id`/`version` come from the bundle's own `package.json`; the directories are
 * resolved by the Host half (`$DSH_HOME`, the bundle directory).
 */
export interface DshHostFacts {
  /** Bundle package name, e.g. `@at-series/dsh-at-terminal`. */
  readonly pluginName: string;
  readonly pluginVersion: string;
  /** Directory holding the bundle (`context.extensionPath`'s counterpart). */
  readonly bundlePath: string;
  /**
   * On-disk directory for plugin data — `context.globalStorageUri.fsPath`'s
   * counterpart. `$DSH_HOME` based, so it survives a bundle reinstall.
   */
  readonly storageDir: string;
  /** `appName` / `appRoot` / `uriScheme` counterparts, for the audit banner and MCP legacy paths. */
  readonly appName: string;
  readonly appRoot: string;
  readonly uriScheme: string;
}

// ---------------------------------------------------------------------------
// The bundle the assembly hands to `createDshPlatform()`
// ---------------------------------------------------------------------------

/**
 * Everything `createDshPlatform()` needs. The Host half builds this from `ctx`
 * plus the injected facts; nothing here is optional-by-convention — a missing
 * facet is a composition error and must fail at assembly, not on first use.
 */
export interface DshPlatformDeps {
  readonly logger: DshLogger;
  readonly credentials: DshCredentialProvider;
  readonly storageDomain: DshStorageDomain;
  readonly settings: DshResolvedSettings;
  readonly facts: DshHostFacts;
  /**
   * Locale dictionaries, keyed by the bundle's `locale/*.json` names. Defaults to
   * the English document; the Host half loads files and passes them in so this
   * module stays free of filesystem concerns.
   */
  readonly messages?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Shared key mapping
// ---------------------------------------------------------------------------

/** The credential-reference namespace this plugin owns. */
export const AT_TERMINAL_CREDENTIAL_NAMESPACE = 'AT_TERMINAL';

/**
 * Reproduces the grammar `credentialRef()` enforces, so a caller can tell whether
 * a name it built is acceptable *before* the seam throws.
 */
export function isCredentialRefName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** The kinds of stored secret AT Terminal owns for one server. */
export type ServerSecretKind = 'password' | 'passphrase';

/**
 * Map a server id — which is deliberately `z.string().min(1)`, i.e. any non-empty
 * string — onto a credential-reference name.
 *
 * Two encodings, made unambiguous by a marker segment:
 *
 * - `…_S_<ID>` when the id already consists only of `[a-z0-9-]`. Hyphens become
 *   underscores; since an id in this branch contains no underscore, the mapping is
 *   injective.
 * - `…_X_<HEX>` otherwise, where `HEX` is the id's UTF-8 bytes as uppercase hex.
 *   Lossless and injective for every possible id.
 *
 * Callers never decode a name back into an id — only injectivity is required — but
 * the marker keeps a human reading `~/.dsh/.credentials.yaml` able to tell which
 * encoding they are looking at.
 */
export function serverSecretRefName(kind: ServerSecretKind, serverId: string): string {
  const prefix = `${AT_TERMINAL_CREDENTIAL_NAMESPACE}_${kind.toUpperCase()}`;
  if (/^[a-z0-9-]+$/.test(serverId)) {
    const name = `${prefix}_S_${serverId.toUpperCase().replace(/-/g, '_')}`;
    if (isCredentialRefName(name)) {
      return name;
    }
  }
  return `${prefix}_X_${Buffer.from(serverId, 'utf8').toString('hex').toUpperCase()}`;
}
