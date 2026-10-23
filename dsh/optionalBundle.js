/**
 * The one optional bundle this plugin can install for the user.
 *
 * `@at-series/dsh-at-terminal-ssh` is a **composition bundle**: it contributes no code, it mounts
 * three rows (the host's terminal registry, our SSH backend, the host's terminal tools) inside an
 * isolated group. Everything a user gains from it — six `terminal_*` tools on a shell that survives
 * between calls — exists only because those rows are in the composition, which is why it cannot be
 * folded into this package: a plugin cannot import a package that lives inside `app.asar`, and
 * adding the rows unconditionally would put six tools in every user's tool table.
 *
 * Installing it is a `pnpm add` in the profile, which only the Host's plugin manager can do. This
 * module is the narrow, testable seam over that service: the **name is fixed here**, never taken
 * from a request, so the settings page cannot be turned into "install anything".
 */

/** The package name. Fixed: see the note above about not accepting a caller's spec. */
export const OPTIONAL_BUNDLE_NAME = '@at-series/dsh-at-terminal-ssh'

/**
 * The install spec for the version that pairs with this build.
 *
 * Lockstep on purpose: the bundle references `@at-series/dsh-at-terminal/terminal-backend` by
 * subpath, so a mismatched pair would resolve a backend that does not exist. Exact rather than a
 * range, because "which version of the optional half am I running" should have one answer.
 *
 * @param {string} version This package's version.
 */
export function optionalBundleSpec(version) {
  return `${OPTIONAL_BUNDLE_NAME}@${version}`
}

/**
 * Describe the optional bundle's state, from the plugin manager's own view.
 *
 * `listBundles()` is the only source: it reconciles the profile's dependencies, the patch
 * selections and the rows actually mounted, so a second opinion computed here would be a second
 * answer to the same question.
 *
 * @param {{ manager: { listBundles(): unknown }, version: string }} input
 * @returns {{
 *   available: boolean, name: string, spec: string, installed: boolean,
 *   enabled: boolean, rows: number, reason?: string
 * }}
 */
export async function describeOptionalBundle({ manager, version }) {
  const spec = optionalBundleSpec(version)
  const absent = (reason) => ({
    available: false,
    name: OPTIONAL_BUNDLE_NAME,
    spec,
    installed: false,
    enabled: false,
    rows: 0,
    reason
  })
  if (manager === undefined || manager === null || typeof manager.listBundles !== 'function') {
    // A composition without the plugin manager (a preset-only assembly) can still use every tool
    // this package provides; only the switch is missing, and it has to say so rather than throw.
    return absent('this Harness has no plugin manager, so bundles cannot be installed from here')
  }
  let bundles
  try {
    // **Awaited**: the manager answers with a promise (measured, 0.2.1-rc.2). Treating it as an
    // array made every state read "not installed" while the bundle was installed and running.
    bundles = await manager.listBundles()
  } catch (error) {
    return absent(`the plugin manager could not list bundles: ${error?.message ?? String(error)}`)
  }
  const list = Array.isArray(bundles) ? bundles : []
  const entry = list.find((candidate) => candidate?.name === OPTIONAL_BUNDLE_NAME)
  if (entry === undefined) {
    // Not installed and not even offered: the release that pairs with this build may not have
    // been published yet, which is worth distinguishing from "installed and switched off".
    return { available: true, name: OPTIONAL_BUNDLE_NAME, spec, installed: false, enabled: false, rows: 0 }
  }
  return {
    available: true,
    name: OPTIONAL_BUNDLE_NAME,
    spec,
    installed: entry.installed === true,
    enabled: entry.enabled === true,
    rows: Array.isArray(entry.rows) ? entry.rows.length : 0
  }
}
