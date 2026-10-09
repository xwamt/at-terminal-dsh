import type { ConfigReader, ConfigSection } from '../../core/ports';
import type { DshResolvedSettings } from './host';

/**
 * The dsh implementation of the `ConfigReader` port.
 *
 * ## Why the section name is checked instead of mapped away
 *
 * VS Code has nested configuration namespaces and a single entry point,
 * `workspace.getConfiguration('sshManager')`, which answers for *any* section name
 * (an unknown one just yields all defaults). dsh has neither: `dsh/settings.js`
 * exports one flat schema, and `resolveConfig()` hands the plugin a record of
 * `.volatile()` accessors keyed by the field names -- the `sshManager.` prefix that
 * exists in the extension manifest is gone by the time the values reach here.
 *
 * So there is exactly one section this platform can serve, and the mapping from the
 * core's section name to dsh's flat record is a constant, not a lookup. Returning an
 * empty-defaults section for anything else would be the "pretend it worked" failure
 * the whole milestone is written against: a caller asking for `'sftp'` (or a typo
 * like `'sshmanager'`) would silently get every default and look correct in
 * production while its actual setting was never read. `getSection` therefore throws
 * with the received name in the message.
 */

/** The only configuration section `dsh/settings.js` projects. */
export const SUPPORTED_CONFIG_SECTION = 'sshManager';

/**
 * Build the `ConfigReader` over the resolved dsh settings record.
 *
 * `settings` is the live accessor map from `resolveConfig()`, not a snapshot taken at
 * mount time: dsh's settings form writes through `configEditor.edit()`, which
 * re-validates against the schema and swaps the resolved value behind the same
 * accessor. That is the only reason a settings edit is visible without remounting
 * the plugin, so the reader must resolve the accessor **per call**. Caching either
 * the accessor or its value here would freeze the terminal's font size / scrollback
 * at whatever they were when the plugin started.
 */
export function createDshConfigReader(settings: DshResolvedSettings): ConfigReader {
  return {
    getSection(section: string): ConfigSection {
      if (section !== SUPPORTED_CONFIG_SECTION) {
        throw new Error(
          `AT Terminal on dsh: unsupported configuration section "${section}". ` +
            `This platform exposes only "${SUPPORTED_CONFIG_SECTION}" ` +
            `(the dsh settings schema is flat and drops the "${SUPPORTED_CONFIG_SECTION}." prefix, ` +
            `so the section name here is not a namespace to look up but the single section that exists).`
        );
      }
      return {
        /**
         * `settings[key]` is re-indexed on every call rather than destructured once,
         * because the record is the seam: the tests (and, in principle, a future
         * hot-reload) mutate it in place after the reader is built, and the port's
         * contract is "read the configuration now".
         */
        get<T>(key: string, defaultValue: T): T {
          const value = settings[key]?.get();
          /**
           * `undefined` is the *only* value that means "not configured". That matches
           * the host semantics the port mirrors (`getConfiguration().get(key, def)`
           * substitutes the default only for an unset key, and `false` / `0` / `''`
           * are real configured values), and it matches dsh: an accessor exists for
           * every declared field, but a `.volatile()` field with no default resolves
           * to `undefined` rather than disappearing from the record. Returning the
           * default for `0` or `false` would make `semanticHighlight: false` and
           * `idleDisconnectMinutes: 0` silently unsettable.
           */
          return value === undefined ? defaultValue : (value as T);
        }
      };
    }
  };
}
