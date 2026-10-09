import type { StateStore } from '../../core/ports';
import {
  NOOP_DSH_LOGGER,
  type DshDomain,
  type DshDomainSpec,
  type DshDomainTable,
  type DshLogger,
  type DshStorageDomain
} from './host';

/**
 * The dsh implementation of the `StateStore` port — DSH-14.
 *
 * Replaces `context.globalState` with `ctx.storageDomain` (the real seam; the plan
 * originally said "a local storage backend", which does not exist under that name).
 *
 * ## Shape: one domain, one flat table
 *
 * The port is a flat memento — `get(key, defaultValue)` / `update(key, value)` with
 * arbitrary keys — and §0.12 decision 1 requires **zero signature changes** to its
 * consumers. `ConfigManager` in particular reads and writes the whole server list
 * as a single value (`listServers()` → `globalState.get('sshManager.servers', [])`),
 * and `HostKeyStore.read()` is **synchronous**.
 *
 * So the domain is declared as one table `kv`, keyed by the original memento key,
 * rather than as typed `servers` / `host_keys` tables. A typed layout would have
 * forced both classes to change, and would have re-encoded data whose canonical
 * validation already exists and runs on every read — `ConfigManager.listServers`
 * parses each record through `parseServerConfigList`, dropping corrupt entries
 * instead of deleting them. Duplicating that in a second schema would create two
 * sources of truth for what a server is.
 *
 * Two host facts make this mapping sound:
 *
 * 1. **Reads are synchronous.** `DomainImpl.table(name).get(key)` is served from
 *    the domain's in-memory state, which is exactly what `HostKeyStore` needs.
 * 2. **Record keys are not filenames.** The JSON backend only turns keys into path
 *    segments in `per-record` layout; the default (`single`) keeps the whole unit in
 *    one document with the records as plain object keys. The spec therefore omits
 *    `layout`, so `sshManager.servers` and `sshManager.trustedHostKeys` need no
 *    escaping.
 *
 * ## Why the table schema is not zod
 *
 * `dsh-storage-domain` documents record schemas as zod, but the only member the
 * runtime calls on a **table** schema is `.parse` (it calls `.safeParse(null)` once,
 * on the *global* schema, to reject a nullable global). What the medium requires of
 * a record is that it survives a JSON round-trip, and that is what
 * `parseJsonRecord` checks — a real check, not a rubber stamp. Semantic validation
 * of a server record stays in `src/config/schema.ts` where it already is.
 *
 * Keeping a second schema library out of the bundle is a deliberate consequence:
 * the Host half ships through a `link:` install, where no dependency the plugin
 * declares is installed, so every new library is another chance to reproduce the
 * `ERR_MODULE_NOT_FOUND` failure that cost this milestone a full round.
 */

/** Domain name. Must match the host's `UNIT_NAME_RE` — `/^[a-z][a-z0-9_]*$/`, no hyphens. */
export const AT_TERMINAL_STATE_DOMAIN = 'at_terminal_state';

/** The single table. A flat memento needs exactly one. */
export const AT_TERMINAL_STATE_TABLE = 'kv';

export const AT_TERMINAL_STATE_VERSION = 1;

/**
 * Validate one record against what the medium can actually hold: a value that
 * survives `JSON.stringify` → `JSON.parse` unchanged.
 *
 * Returns the round-tripped value rather than the input, so what the domain keeps
 * in memory is byte-identical to what a later reopen will load. That matters
 * because the domain calls this only on **open**; without normalizing on the write
 * path too, a `Date` written here would come back as a string and memory and medium
 * would disagree until a restart.
 */
export function parseJsonRecord(value: unknown): unknown {
  if (value === undefined) {
    throw new TypeError(
      'AT Terminal: a state record cannot be undefined — call update(key, undefined) to delete it'
    );
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`AT Terminal: a state record must be JSON-serializable (${String(error)})`);
  }
  if (text === undefined) {
    throw new TypeError('AT Terminal: a state record must be JSON-serializable (JSON.stringify produced no text)');
  }
  return JSON.parse(text);
}

/**
 * The domain declaration. Exported so the dsh gate can hand it to the **installed**
 * `defineDomain` and fail if the host ever rejects it — the eager validation there
 * (`name` grammar, integer version, non-null accepting schemas) is the contract, and
 * asserting it against a real install is the only way to know it still holds.
 */
export function createStateDomainSpec(): DshDomainSpec {
  return {
    name: AT_TERMINAL_STATE_DOMAIN,
    version: AT_TERMINAL_STATE_VERSION,
    tables: {
      [AT_TERMINAL_STATE_TABLE]: { valueSchema: { parse: parseJsonRecord } }
    }
  };
}

export interface DshStateStoreDeps {
  readonly storageDomain: DshStorageDomain;
  readonly logger?: DshLogger;
}

/** An opened store plus the disposer the composition root must run. */
export interface DshStateStoreHandle {
  readonly state: StateStore;
  /**
   * Release the domain. The facility docs are explicit that the **caller** owns the
   * handle and closes it (typically from its own `ctx.effect` disposer); the
   * facility only closes what is still open when the plugin unmounts. Closing twice
   * is harmless — the domain's `close()` shares one teardown.
   */
  close(): Promise<void>;
}

/**
 * Open the state domain and wrap it as a `StateStore`.
 *
 * Asynchronous because `ctx.storageDomain.open(spec)` is: it resolves the backend
 * route, requires its `kv` facet, loads the whole unit and validates every stored
 * record. A failure here (`backend-not-found`, `facet-unsupported`,
 * `invalid-record`) must abort plugin activation rather than leave a store that
 * silently loses writes — so it propagates.
 */
export async function openDshStateStore({
  storageDomain,
  logger = NOOP_DSH_LOGGER
}: DshStateStoreDeps): Promise<DshStateStoreHandle> {
  const domain: DshDomain = await storageDomain.open(createStateDomainSpec());
  if (domain.name !== AT_TERMINAL_STATE_DOMAIN) {
    // The facility keys domains by name and reserves the name during an open, so a
    // different `name` back means someone else's handle was handed over.
    await domain.close();
    throw new Error(
      `AT Terminal: storageDomain.open() returned domain "${domain.name}" instead of "${AT_TERMINAL_STATE_DOMAIN}"`
    );
  }
  const table: DshDomainTable = domain.table(AT_TERMINAL_STATE_TABLE);
  logger.info('AT Terminal: state domain "%s" opened.', AT_TERMINAL_STATE_DOMAIN);

  return {
    state: {
      get<T>(key: string, defaultValue: T): T {
        const stored = table.get(key);
        return stored === undefined ? defaultValue : (stored as T);
      },

      async update(key: string, value: unknown): Promise<void> {
        // Memento semantics, matching `vscode.ExtensionContext.globalState` and the
        // fake in `test/core/fakes.ts`: `undefined` removes the key instead of
        // storing a value that a JSON medium could not represent anyway.
        if (value === undefined) {
          await table.delete(key);
          return;
        }
        // Normalize on write so memory and medium agree immediately — the domain only
        // consults the schema when it loads an existing document.
        await table.put(key, parseJsonRecord(value));
      }
    },
    close: () => domain.close()
  };
}
