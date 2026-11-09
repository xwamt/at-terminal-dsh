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
 * Whether the bundle is actually running, as opposed to merely selected.
 *
 * `active` means every row the bundle declares is mounted and its plugin fiber is active.
 * `failed` means the manager or a row reported an error. `unknown` is the honest answer for
 * every other state — not installed, switched off, still loading, or a Harness whose plugin
 * manager cannot report row activation.
 *
 * @typedef {'active' | 'failed' | 'unknown'} OptionalBundleActivation
 */

/** Package names the host's build-approval service may accept; never a spec or a path. */
function approvedBuildNames(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const names = value.filter((name) => typeof name === 'string' && name.trim() !== '')
  return names.length === 0 ? undefined : names
}

/** The diagnostic a 0.2.2 `ChangeResult` carries, whichever shape the manager answered with. */
function changeDiagnostic(change) {
  const diagnostic = change?.error?.diagnostic ?? change?.diagnostic
  return typeof diagnostic === 'string' && diagnostic !== '' ? diagnostic : undefined
}

/**
 * Describe the optional bundle's state, from the plugin manager's own view.
 *
 * `listBundles()` and `listPlugins()` reconcile the profile's dependencies, the patch selection
 * and the live plugin fibers. A second opinion computed here would be a second answer to the
 * same question, so both reads are delegated to the manager.
 *
 * `install` is the latest 0.2.2 change result (`installBundle` or `setBundleEnabled`), when the
 * channel still holds one. It is needed because `listBundles().enabled` is only the **saved
 * selection**: a bundle can be selected and still fail to activate, and the failure exists only
 * in the change result (`error.diagnostic`, `pendingBuilds`, `restoring`). Without it the page
 * would paint a failed bundle as "Active".
 *
 * @param {{
 *   manager: { listBundles(): unknown, listPlugins?(): unknown },
 *   version: string,
 *   install?: object | null,
 *   outcome?: object | null,
 *   installResult?: object | null
 * }} input
 * @returns {{
 *   available: boolean, name: string, spec: string, installed: boolean,
 *   enabled: boolean, rows: number, activation: OptionalBundleActivation,
 *   reason?: string, diagnostic?: string, pendingBuilds?: string[], restoring?: boolean
 * }}
 */
export async function describeOptionalBundle({ manager, version, install, outcome, installResult }) {
  const spec = optionalBundleSpec(version)
  const absent = (reason) => ({
    available: false,
    name: OPTIONAL_BUNDLE_NAME,
    spec,
    installed: false,
    enabled: false,
    rows: 0,
    activation: /** @type {OptionalBundleActivation} */ ('unknown'),
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
    return {
      available: true,
      name: OPTIONAL_BUNDLE_NAME,
      spec,
      installed: false,
      enabled: false,
      rows: 0,
      activation: /** @type {OptionalBundleActivation} */ ('unknown')
    }
  }

  const rows = Array.isArray(entry.rows) ? entry.rows : []
  /** @type {{
   *   available: boolean, name: string, spec: string, installed: boolean,
   *   enabled: boolean, rows: number, activation: OptionalBundleActivation,
   *   diagnostic?: string, pendingBuilds?: string[], restoring?: boolean
   * }} */
  const state = {
    available: true,
    name: OPTIONAL_BUNDLE_NAME,
    spec,
    installed: entry.installed === true,
    enabled: entry.enabled === true,
    rows: rows.length,
    activation: 'unknown'
  }

  // Diagnostics from the last change result travel even when the bundle did not install (a
  // blocked build script is exactly that case): the page needs them to offer the retry.
  const supplied = [install, outcome, installResult].find(
    (candidate) => candidate !== undefined && candidate !== null && typeof candidate === 'object'
  )
  const change = supplied ?? null
  const pendingBuilds = approvedBuildNames(change?.pendingBuilds)
  if (pendingBuilds !== undefined) state.pendingBuilds = pendingBuilds
  const restoringMarker = change?.restoring
  if (
    restoringMarker === true ||
    (restoringMarker !== undefined && restoringMarker !== null && restoringMarker !== false) ||
    (change?.restore !== undefined && change?.restore !== null)
  ) {
    state.restoring = true
  }
  const observed = changeDiagnostic(change)
  if (observed !== undefined) state.diagnostic = observed
  const restoreDiagnostic = changeDiagnostic(change?.restore)
  if (state.diagnostic === undefined && restoreDiagnostic !== undefined) state.diagnostic = restoreDiagnostic

  // A failed or incomplete change is a fact about this bundle whatever `listBundles` says: a
  // failed install leaves the package absent, so waiting for `installed` before reporting the
  // failure would hide the build-script prompt behind "not installed". A cancelled run has no
  // activation outcome to report, so it stays `unknown` with its reason rather than "failed".
  if (state.restoring === true) return state
  if (change?.application === 'cancelled') {
    if (state.diagnostic === undefined) state.diagnostic = 'the installation was cancelled'
    return state
  }
  if (change?.application === 'failed' || pendingBuilds !== undefined) {
    state.activation = 'failed'
    if (state.diagnostic === undefined) state.diagnostic = pendingBuilds !== undefined ? 'dependency build scripts are waiting for approval' : 'the installation did not complete'
    return state
  }
  if (!state.installed || !state.enabled) return state

  // A bundle-level problem is the manager's own answer: unreadable patch, not a bundle, an
  // incompatible version, or an unsupported platform. `enabled` cannot override any of them.
  if (typeof entry.error === 'string' && entry.error !== '') {
    state.activation = 'failed'
    state.diagnostic = state.diagnostic ?? entry.error
    return state
  }
  if (entry.error !== undefined && entry.error !== null && typeof entry.error === 'object') {
    state.activation = 'failed'
    const bundleDiagnostic = typeof entry.error.diagnostic === 'string' ? entry.error.diagnostic : ''
    state.diagnostic = bundleDiagnostic !== '' ? bundleDiagnostic : (state.diagnostic ?? String(entry.error.code ?? 'bundle error'))
    return state
  }

  // `enabled: true` is a saved selection; only the live fibers prove the rows came up. When the
  // manager cannot report them (older manager: only `listBundles` is available), fall back to the
  // declared row count rather than leaving a working bundle permanently "unconfirmed"; a
  // manager that can report fibers is never overridden by the fallback.
  if (typeof manager.listPlugins !== 'function') {
    if (rows.length > 0) state.activation = 'active'
    return state
  }
  let plugins
  try {
    plugins = await manager.listPlugins()
  } catch (error) {
    state.diagnostic = `the plugin manager could not read row activation: ${error?.message ?? String(error)}`
    return state
  }
  const inventory = Array.isArray(plugins) ? plugins : []
  const entryIds = rows
    .map((row) => (row !== null && typeof row === 'object' ? row.entryId : undefined))
    .filter((entryId) => typeof entryId === 'string' && entryId !== '')
  // Declared rows without a live Loader entry are not mounted; there is nothing to call active.
  if (entryIds.length === 0) return state
  const live = entryIds.map((entryId) => inventory.find((candidate) => candidate?.entryId === entryId))
  const failedRow = live.find((candidate) => candidate?.fiberPhase === 'failed')
  if (failedRow !== undefined) {
    state.activation = 'failed'
    if (typeof failedRow.diagnostic === 'string' && failedRow.diagnostic !== '') state.diagnostic = failedRow.diagnostic
    return state
  }
  if (live.every((candidate) => candidate !== undefined && candidate.fiberPhase === 'active')) {
    state.activation = 'active'
  }
  return state
}
