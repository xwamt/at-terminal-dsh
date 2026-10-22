/**
 * AT Terminal — settings surface for DeepSeek Harness.
 *
 * dsh has no `ctx.settings.installSection()`. A plugin registers editable
 * configuration by exporting a schemastery `Config` schema; the
 * `@deepseek-ai/dsh-settings` service walks every active plugin entry, keeps
 * the fields marked `.volatile()`, and auto-generates the form
 * (`autoGenerate` defaults to true). Writes go through
 * `configEditor.edit()`, which re-validates the merged config against this
 * same schema — so the constraints below are the write guard, not decoration.
 *
 * Read against the installed Harness (0.1.7-rc.2); `scripts/verify.mjs`
 * re-checks the schema against the installed schemastery on every run:
 *
 *   - `Registry.plugin()` stores `Config: plugin.Config`, so a module that
 *     exports `apply` + `Config` with no `default` export is accepted as a
 *     plugin (`cordis-plugin-loader` normalizes `exports.default ?? exports`,
 *     and `isApplicable()` accepts any object carrying `apply`).
 *   - `SettingsForms.schema(entry)` reads `entry.fiber.runtime?.Config`, so
 *     the schema attached this way is exactly what the panel describes.
 *   - `Fiber._resolveConfig()` -> `resolveConfig(runtime, config)` validates
 *     through `Config['~standard']` and produces the `.get()` accessors that
 *     plugin code reads.
 *
 * Like `tools.js`, this module is deliberately free of `@deepseek-ai/*`
 * imports: `createConfigSchema(z)` takes the real schemastery instance as an
 * argument, so the verifier can hand it the sandbox copy and exercise the
 * real DSL without a dsh checkout.
 */

/** Settings form namespace. dsh keys forms by the profile entry id. */
export const SETTINGS_SECTION_ID = 'at-terminal'

/**
 * The `sshManager.*` contributions this host renders, as the single source of truth for
 * key, type, constraints and default. `vscodeKey` records the original contribution so the
 * two surfaces can be diffed.
 *
 * Two fields were **removed** rather than kept as decoration, because a form input that no
 * code reads is worse than a missing one — it invites the user to change something and take
 * the silence as agreement:
 *
 * - `sessionLogDirectory` needed a whole terminal-output-to-disk pipeline (rotation,
 *   redaction, a path the user can find) that does not exist here; the field was the only
 *   part of that feature that had ever been written.
 * - `keepAliveInterval` had no insertion point: `SshConnectionConfig` builds keep-alive from
 *   the **per-server** `keepAliveInterval`, which every server already carries (schema
 *   default 30), so a global value could only shadow an explicit per-server one.
 *
 * An old profile that still carries either key keeps starting — schemastery preserves
 * unknown keys and `readSettings` ignores them (asserted in `dsh/scripts/verify.mjs`).
 */
export const SETTINGS_FIELDS = Object.freeze([
  Object.freeze({
    key: 'terminalFontSize',
    vscodeKey: 'sshManager.terminalFontSize',
    type: 'integer',
    min: 8,
    max: 200,
    default: 14,
    description: 'Terminal font size in pixels. Between 8 and 200.'
  }),
  Object.freeze({
    key: 'terminalFontFamily',
    vscodeKey: 'sshManager.terminalFontFamily',
    type: 'string',
    minLength: 1,
    default: 'Cascadia Code, Menlo, monospace',
    description: 'CSS font-family list for the terminal. Must not be empty.'
  }),
  Object.freeze({
    key: 'scrollback',
    vscodeKey: 'sshManager.scrollback',
    type: 'integer',
    min: 100,
    max: 1000000,
    default: 10000,
    description: 'Scrollback buffer size in lines. Between 100 and 1,000,000.'
  }),
  Object.freeze({
    key: 'semanticHighlight',
    vscodeKey: 'sshManager.semanticHighlight',
    type: 'boolean',
    default: true,
    description: 'Highlight command output using terminal semantics.'
  }),
  Object.freeze({
    key: 'idleDisconnectMinutes',
    vscodeKey: 'sshManager.idleDisconnectMinutes',
    type: 'integer',
    min: 0,
    max: 10080,
    default: 60,
    description: 'Disconnect an idle SSH session after this many minutes. 0 disables the timeout.'
  }),

  Object.freeze({
    key: 'zebraStripes',
    vscodeKey: 'sshManager.zebraStripes',
    type: 'boolean',
    default: false,
    description: 'Alternate row backgrounds in asset and SFTP lists.'
  })
])

/**
 * Build the plugin's `Config` schema.
 *
 * @param {object} z The real `@deepseek-ai/schemastery` default export.
 * @returns {object} A schemastery object schema whose fields are all volatile.
 */
export function createConfigSchema(z) {
  if (z === undefined || typeof z.object !== 'function') {
    throw new TypeError('createConfigSchema expects the schemastery instance')
  }
  const dict = {}
  for (const field of SETTINGS_FIELDS) dict[field.key] = buildFieldSchema(z, field)
  return z.object(dict)
}

/** One field: constraint first, then default, description and `.volatile()`. */
function buildFieldSchema(z, field) {
  let schema
  switch (field.type) {
    case 'integer':
      schema = z.natural()
      if (field.min !== undefined) schema = schema.min(field.min)
      if (field.max !== undefined) schema = schema.max(field.max)
      break
    case 'string':
      schema = z.string()
      if (field.minLength !== undefined) schema = schema.min(field.minLength)
      break
    case 'boolean':
      schema = z.boolean()
      break
    default:
      throw new TypeError(`unsupported settings field type "${field.type}" for "${field.key}"`)
  }
  return schema.default(field.default).description(field.description).volatile()
}

/**
 * Read the effective settings from a resolved plugin config.
 *
 * dsh hands `apply(ctx, config)` the output of `resolveConfig()`, where every
 * volatile field is a stable accessor. Each call takes a fresh `.get()`
 * snapshot, so a live reload is observed without remounting the plugin.
 *
 * @param {Record<string, { get(): unknown }>} [config] Resolved plugin config.
 * @returns {Record<string, unknown>} Plain values, defaults filled in.
 */
export function readSettings(config = {}) {
  const result = {}
  for (const field of SETTINGS_FIELDS) {
    const reference = config?.[field.key]
    const value = reference !== null && typeof reference?.get === 'function' ? reference.get() : reference
    result[field.key] = value === undefined ? field.default : value
  }
  return result
}
