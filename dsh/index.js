/**
 * AT Terminal — DeepSeek Harness Host half.
 *
 * Loaded by dsh inside its own Node process; registers everything through
 * `ctx` so that plugin unload removes it again. The row in
 * `cordis.patch.yml` is what makes dsh load this file.
 *
 * The exported `Config` is this plugin's settings surface. dsh's settings
 * panel discovers it through `entry.fiber.runtime.Config` and auto-generates a
 * form from every `.volatile()` field (`autoGenerate` defaults to true), so
 * this plugin does **not** ship its own page and must not call
 * `settings.configure({ auto: false }, ...)`. Writes made through that form
 * are re-validated against this same schema by `configEditor.edit()`, which is
 * what makes the constraints in `settings.js` a real write guard.
 *
 * dsh hands `apply` the output of `resolveConfig()`, so each settings field is
 * a stable accessor read per call via `settings.js#readSettings`.
 *
 * Dependencies: this file is loaded from a `link:`-ed local bundle directory,
 * so Node resolves every bare specifier by walking up from *this* file — it
 * can never reach the packages the Harness keeps inside its own `app.asar`.
 * The only external dependency here is `@deepseek-ai/schemastery`, which is
 * vendored next to this file by `scripts/vendor.mjs`; `scripts/verify.mjs`
 * fails if any other bare specifier appears. In particular the authoring-only
 * `@deepseek-ai/dsh-tools` helper is **not** imported — `ctx.tools.register()`
 * takes the normalized definition directly (see `tools.js`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'

import { registerChannel } from './channel.js'
import { createConfigSchema, readSettings } from './settings.js'
import { createTools } from './tools.js'
// Compiled from src/platform/dsh/entry.ts by `node dsh/esbuild.dsh.mjs`. The domain
// layer is TypeScript and this file is not, so the bundle is the seam — and it exists as
// a committed artifact because a `link:`-installed package runs no build step.
import {
  TerminalContextRegistry,
  createDshAgentToolService,
  createDshAssetApi,
  createDshPlatform,
  createDshServerApi,
  createDshSftpApi,
  createDshTerminalApi,
  importedPrivateKeyDirectory
} from './host.bundle.js'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const bundlePath = dirname(fileURLToPath(import.meta.url))

/**
 * This plugin's own data directory, alongside the Harness's other per-plugin state.
 *
 * `DSH_HOME` is the documented override (`@deepseek-ai/dsh-home-paths`), defaulting to
 * `~/.dsh`. Keeping imported private keys here rather than inside the bundle directory
 * means uninstalling or re-cloning the bundle cannot take a user's keys with it.
 */
function storageDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'at-terminal')
}

/** `tools` must be ready before `apply` runs, so registration cannot race. */
export const inject = ['tools']

/** Editable configuration, read and written through the dsh settings panel. */
export const Config = createConfigSchema(z)

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, { get(): unknown }>} [config] Row config from the
 *   patch layer, resolved against `Config` into per-field volatile accessors.
 */
export function apply(ctx, config = {}) {
  const callContextStorage = new AsyncLocalStorage()
  let currentCallContextFallback = undefined
  let agentService = undefined
  let agentError = undefined

  const resolveAgentService = () => {
    if (agentService !== undefined) return agentService
    const detail =
      agentError === undefined
        ? 'the services are still starting'
        : String(agentError?.message ?? agentError)
    throw Object.assign(new Error(detail), { code: 'services-unavailable' })
  }

  ctx.effect(() => {
    const disposers = createTools({
      version: pkg.version,
      config,
      resolveAgentService,
      runWithCallContext: (callCtx, fn) => callContextStorage.run(callCtx, fn),
      setCurrentCallContext: (callCtx) => {
        currentCallContextFallback = callCtx
      }
    }).map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  })

  // Host↔Client channel (DSH-21) plus the asset services (M3) over the web carrier.
  //
  // `storageDomain`, `credentials` and `webServer` all come from the default
  // composition, and `ctx.inject` waits for them: when any is absent the callback never
  // runs and the plugin stays fully functional without its browser half, which is what
  // makes it installable into a profile that composes differently.
  ctx.inject(['webServer', 'storageDomain', 'credentials'], (scoped) => {
    let assets
    let servers
    let terminal
    let sftp
    let assetsError
    const assembled = createDshPlatform({
      logger: scoped.logger,
      credentials: scoped.credentials,
      storageDomain: scoped.storageDomain,
      // The resolved row config: `apply` receives `resolveConfig()`'s output, where each
      // `.volatile()` field is a per-call accessor.
      settings: config,
      facts: {
        pluginName: pkg.name,
        pluginVersion: pkg.version,
        bundlePath,
        storageDir: storageDir(),
        // Display-only facets with no dsh counterpart; kept honest rather than invented
        // as a host-root path that does not exist.
        appName: 'DeepSeek Harness',
        appRoot: '',
        uriScheme: 'dsh'
      }
    })
      .then((handle) => {
        // One platform, four faces. The asset face is the VS Code variant's own services;
        // the server, terminal and SFTP faces compose the same `ConfigManager`,
        // `HostKeyStore`, `SshSession` and `SftpManager` the extension uses, so a record
        // saved here is the record VS Code would have written and a terminal here is the
        // same connection it would have made.
        const shared = { platform: handle.platform, hostName: pkg.name, hostVersion: pkg.version }
        assets = createDshAssetApi(shared)
        servers = createDshServerApi({
          platform: handle.platform,
          privateKeyDirectory: importedPrivateKeyDirectory(handle.platform)
        })
        const terminalContext = new TerminalContextRegistry()
        // SFTP before the terminal: the terminal announces its sessions to this face, which
        // is how the file tree knows which terminal to follow. Constructing them the other
        // way round would need a wiring step that could be forgotten.
        sftp = createDshSftpApi({ platform: handle.platform })
        const terminalObserver = {
          opened(presence) {
            sftp.opened(presence)
            terminalContext.setActive({
              terminalId: presence.terminalId,
              server: presence.server,
              connected: true,
              write: (data) => presence.write(data)
            })
          },
          closed(terminalId) {
            sftp.closed(terminalId)
            terminalContext.markDisconnected(terminalId)
          }
        }
        terminal = createDshTerminalApi({ platform: handle.platform, observer: terminalObserver })
        const resolveApproval = () => {
          try {
            return scoped?.get?.('approval') ?? ctx?.get?.('approval')
          } catch {
            return undefined
          }
        }
        agentService = createDshAgentToolService({
          platform: handle.platform,
          terminalContext,
          resolveApproval,
          getCurrentCallContext: () => callContextStorage.getStore() ?? currentCallContextFallback
        })

        scoped.effect(() => () => {
          // Order matters: the SFTP manager holds connections whose disposal emits through
          // the platform's notifier, so it goes before the platform closes.
          sftp.dispose()
          void handle.close()
        }, 'at-terminal: platform lifetime')
      })
      .catch((error) => {
        // Not fatal, and deliberately so: the channel is how anyone finds out *why* the
        // services are missing, so it is mounted either way and reports the reason
        // through `assets.summary`.
        assetsError = error
        agentError = error
        scoped.logger.error(
          'at-terminal: asset services unavailable: %s',
          error?.message ?? String(error)
        )
      })

    /**
     * Turn a lazily-assigned face into a resolver.
     *
     * `read` is a **function**, and that is the whole point: an earlier version took the
     * value itself (`resolve(assets)`) and therefore captured `undefined` at registration
     * time, so every service call answered "the services are still starting" forever while
     * `ping` — which needs no service — kept working. Reading through a closure means each
     * call sees whatever the assembly has assigned by then.
     */
    const resolve = (read) => () => {
      const value = read()
      if (value !== undefined) return value
      const detail =
        assetsError === undefined
          ? 'the services are still starting'
          : String(assetsError?.message ?? assetsError)
      throw Object.assign(new Error(detail), { code: 'services-unavailable' })
    }

    scoped.effect(() =>
      registerChannel(scoped, {
        version: pkg.version,
        // Resolved per call, so the channel can mount before the platform finishes opening
        // the storage domain — and so a failed assembly keeps explaining itself instead of
        // being frozen into whatever these held at registration time.
        resolveAssets: resolve(() => assets),
        resolveServers: resolve(() => servers),
        resolveTerminal: resolve(() => terminal),
        resolveSftp: resolve(() => sftp),
        // Synchronous and always available: `config` is the resolved row itself, so the
        // terminal page can read the user's font/scrollback/highlight settings (DSH-31)
        // without waiting on — or depending on — the platform assembly.
        resolveSettings: () => readSettings(config)
      })
    )

    // Keep the promise observable: an unhandled rejection here would be invisible.
    void assembled
  })
}

