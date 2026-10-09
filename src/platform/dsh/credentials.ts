import type { SecretStore } from '../../core/ports';
import { serverSecretRefName, type DshCredentialProvider, type DshLogger, type ServerSecretKind } from './host';

/**
 * The dsh implementation of the `SecretStore` port — DSH-13.
 *
 * ## Which half of the credential seam, and why
 *
 * `ctx.credentials` has two halves. The **record** half
 * (`credentialKey(scope, id)` + `readRecord`/`modifyRecord`/`deleteRecord`)
 * addresses "what credential does this plugin hold for this id", but its stored
 * records only admit two tags — `{kind: 'api-key', key?, env?}` and
 * `{kind: 'grant', payload}`. Neither represents an SSH password, and inventing a
 * third tag would fight the provider's own `parseRecord`, which rejects an unknown
 * tag rather than dropping it.
 *
 * The **reference** half is the right seam: a `CredentialRef` is "a secret the user
 * configured, addressed by a name", layered over the process environment, the
 * provider-managed document (`$DSH_HOME/.credentials.yaml`) and project/user
 * `.env`. `set`/`unset` write the managed document. It also gives the
 * "credentials must never appear in a response or a log" requirement for free:
 * `describe()` returns `{configured, source, writable}` and has no value field at
 * all, so the only way to leak a secret is to call `resolve()` — which this adapter
 * does in exactly one place.
 *
 * ## What this adapter deliberately does *not* smooth over
 *
 * - `set()` throws when the launching environment already supplies the reference
 *   (`"... is supplied read-only by the launching environment, so set would be
 *   shadowed"`). That is a real conflict between the user's shell and the stored
 *   value; the port has no way to report it, and silently succeeding would make a
 *   saved password look applied when it is not. It propagates.
 * - `set()` also throws on an empty value. `ConfigManager` only stores a password
 *   when it is `!== undefined`, so an empty string is a caller bug, not a way to
 *   unset — `delete()` is.
 */

/** Prefixes owned by `src/config/ConfigManager.ts`. Kept in sync by the test. */
const PASSWORD_PREFIX = 'sshManager.password.';
const PASSPHRASE_PREFIX = 'sshManager.passphrase.';

export interface DshSecretStoreDeps {
  readonly credentials: DshCredentialProvider;
  readonly logger: DshLogger;
}

/**
 * Split one `ConfigManager` secret key into the kind and server id it addresses.
 *
 * Returns `undefined` for a key outside the two prefixes. The callers
 * (`getPassword` / `getPassphrase` / `saveServer` / `deleteServer`) only ever build
 * those two, so an unmappable key means a bug somewhere upstream — see the adapter
 * below for why that must not degrade into "no secret stored".
 */
export function parseSecretKey(key: string): { kind: ServerSecretKind; serverId: string } | undefined {
  for (const [prefix, kind] of [
    [PASSWORD_PREFIX, 'password'],
    [PASSPHRASE_PREFIX, 'passphrase']
  ] as const) {
    if (key.startsWith(prefix)) {
      return { kind, serverId: key.slice(prefix.length) };
    }
  }
  return undefined;
}

/** Rebuild the reference name for a key, or throw when the key addresses nothing. */
function refFor(key: string): string {
  const parsed = parseSecretKey(key);
  if (parsed === undefined) {
    throw new Error(
      `AT Terminal on dsh: "${key}" is not a credential key this plugin owns ` +
        `(expected a "${PASSWORD_PREFIX}" or "${PASSPHRASE_PREFIX}" prefix)`
    );
  }
  return serverSecretRefName(parsed.kind, parsed.serverId);
}

export function createDshSecretStore({ credentials, logger }: DshSecretStoreDeps): SecretStore {
  return {
    async get(key) {
      const ref = refFor(key);
      const resolved = await credentials.resolve(ref);
      // An empty stored value reads as absent on the dsh side ("a blank never
      // masquerades as a configured secret"), so an empty string here is reported
      // the way the rest of the platform reports it: as nothing stored.
      if (resolved === undefined || resolved.value.length === 0) {
        return undefined;
      }
      logger.info('AT Terminal: resolved SSH secret from the "%s" layer.', resolved.source);
      return resolved.value;
    },

    async store(key, value) {
      const ref = refFor(key);
      await credentials.set(ref, value);
    },

    async delete(key) {
      const ref = refFor(key);
      await credentials.unset(ref);
    }
  };
}
