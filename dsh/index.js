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

import { broadcastMonitorEvent, getChannelPresence, registerChannel } from './channel.js'
import { classify, createGuard, createPreExecute } from './policy.js'
import { TRUST_VARIABLE, promptSection, recordSectionRegistration, trustFact } from './prompt.js'
import { RUNTIME_SKILLS, recordSkillStatus, registerRuntimeSkills, verifyRegisteredSkills } from './skills.js'
import { createConfigSchema, readSettings } from './settings.js'
import { createTools } from './tools.js'
// Compiled from src/platform/dsh/entry.ts by `node dsh/esbuild.dsh.mjs`. The domain
// layer is TypeScript and this file is not, so the bundle is the seam — and it exists as
// a committed artifact because a `link:`-installed package runs no build step.
import {
  TerminalContextRegistry,
  buildCommandApprovalCopy,
  createDshAgentToolService,
  createDshAssetApi,
  createDshAuditLog,
  createDshPlatform,
  createDshServerApi,
  createDshSftpApi,
  createDshTerminalApi,
  importedPrivateKeyDirectory,
  isSensitiveRemotePath
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

/** Every direct tool this bundle registers is named with this prefix. */
const AUDIT_TOOL_PREFIX = 'at_terminal_'

/**
 * Project one completed tool call into an audit entry, or `undefined` when the call is not
 * ours.
 *
 * The reason code is read from the result's own structure — never by matching message text,
 * which would break the first time an error is reworded: `result.error.info.reasonCode`
 * when a service supplied one, otherwise `runtime_error` for a failed call and `completed`
 * for a successful one — except for the built-in hardware probe, which never meets the
 * command policy and is recorded as `builtin_probe` so the trail does not imply it did.
 *
 * A call with no `exec.agent` is a programmatic (PTC) sub-call: it belongs to no session
 * and has no audit trail to join, so it is skipped rather than written into the user's.
 */
function auditEntryFrom(exec, result) {
  const name = exec?.name
  if (typeof name !== 'string' || !name.startsWith(AUDIT_TOOL_PREFIX)) return undefined
  if (exec?.agent === undefined || exec.agent === null) return undefined

  const args = exec?.arguments ?? {}
  const failed = result?.isError === true
  const value = failed ? undefined : result?.value
  const reasonCode =
    (typeof result?.error?.info?.reasonCode === 'string' && result.error.info.reasonCode) ||
    // A built-in probe never meets the command policy, so `completed` would read as "the
    // policy allowed it". The distinction comes from the policy table rather than from the
    // tool minting a reason code of its own: one table, one answer, and the tool's output
    // schema stays exactly what the Host validated.
    (failed ? 'runtime_error' : classify(name)?.probe === 'builtin' ? 'builtin_probe' : 'completed')

  /** @type {Record<string, unknown>} */
  const entry = {
    // The prefix is the namespace, not part of the tool's name: the file records what the
    // model called, and `at_terminal_` is on every line of it.
    tool: name.slice(AUDIT_TOOL_PREFIX.length),
    reasonCode
  }
  const serverId = args.serverId ?? value?.serverId
  if (typeof serverId === 'string' && serverId !== '') entry.serverId = serverId
  // The command is what an operator actually needs to read back, and it is the field
  // `AgentAuditLog` redacts before writing — recording only `path` would leave
  // `run_remote_command` rows saying nothing about what ran.
  const command = args.command ?? value?.command
  if (typeof command === 'string' && command !== '') entry.command = command
  const path = args.path ?? value?.path
  if (typeof path === 'string' && path !== '') entry.path = path
  const terminalId = args.terminalId ?? value?.terminalId
  if (typeof terminalId === 'string' && terminalId !== '') entry.terminalId = terminalId
  const sessionId = exec?.agent?.session?.id
  if (typeof sessionId === 'string' && sessionId !== '') entry.sessionId = sessionId
  if (typeof value?.exitCode === 'number') entry.exitCode = value.exitCode
  if (typeof value?.durationMs === 'number') entry.durationMs = value.durationMs
  if (typeof value?.truncated === 'boolean') entry.truncated = value.truncated
  return entry
}

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
  let auditLog = undefined

  const resolveAgentService = () => {
    if (agentService !== undefined) return agentService
    const detail =
      agentError === undefined
        ? 'the services are still starting'
        : String(agentError?.message ?? agentError)
    throw Object.assign(new Error(detail), { code: 'services-unavailable' })
  }

  /**
   * Authorization at the registry layer, not inside each tool.
   *
   * A tool that forgets to check — or a caller that reaches the service another way — now
   * still meets a classification (`dsh/policy.js`), a monotonic guard, and a `pre-execute`
   * stage that asks through the Host's own approval channel. Registered outside the platform
   * assembly on purpose: `ping` and the guard's "no row" denial must work in a profile whose
   * storage or web carrier failed to open.
   *
   * The authorizer is `resolveAgentService().authorizeCommand()`, i.e. the same code the tool
   * body runs, so the gate and the prompt cannot disagree about what needs approval.
   */
  ctx.effect(() => {
    const releaseGuard = ctx.tools.guard(createGuard({ isSensitiveRemotePath }))
    const off = ctx.on(
      'tools/pre-execute',
      createPreExecute({
        authorize: async (input) => {
          const { server, authorization } = await resolveAgentService().authorizeCommand(input)
          return {
            serverLabel: server.label,
            host: server.host,
            autoApprove: authorization.autoApprove,
            destructive: authorization.destructive,
            riskSummaries: authorization.riskSummaries
          }
        },
        formatApprovalCopy: buildCommandApprovalCopy
      })
    )
    return () => {
      try {
        off?.()
      } catch {}
      try {
        releaseGuard?.()
      } catch {}
    }
  }, 'at-terminal: tool policy')

  /**
   * The audit trail, mounted before anything else and outside the platform assembly.
   *
   * It must not depend on `webServer`/`storageDomain`: a profile that composes differently
   * still gets tool calls, and evidence about them is the one thing that has to survive the
   * panel being absent. `tools/result` is an **emit** event — the registry calls every
   * observer and swallows what they throw — so this observes, never intercepts.
   */
  ctx.effect(() => {
    const log = createDshAuditLog({ storageDir: storageDir(), logger: ctx.logger })
    auditLog = log
    const off = ctx.on('tools/result', (exec, result) => {
      try {
        const entry = auditEntryFrom(exec, result)
        if (entry !== undefined) log.record(entry)
      } catch (error) {
        // The registry would log this too, but only after it swallowed it; a warning here
        // names the audit path, which is the part that went wrong.
        ctx.logger?.warn?.('at-terminal: audit observer failed: %s', error?.message ?? String(error))
      }
    })
    return () => {
      try {
        off?.()
      } catch {}
      log.dispose()
      auditLog = undefined
    }
  }, 'at-terminal: audit trail')

  ctx.effect(() => {
    const disposers = createTools({
      version: pkg.version,
      config,
      resolveAgentService,
      // `ctx.get('spillStore')` is read per call, not captured at registration: a preset
      // that composes the store later (or never) must not be frozen into whatever was
      // present when tools were registered. Absence degrades to truncation, never an error.
      resolveSpillStore: () => {
        try {
          return ctx.get?.('spillStore')
        } catch {
          return undefined
        }
      },
      logger: ctx.logger,
      // Same lazy read as `spillStore`, for the same reason: which preset supplies the job
      // registry is a runtime fact, not a registration-time one. Absence degrades the
      // tool to foreground with a stated reason instead of failing it.
      resolveJobs: () => {
        try {
          return ctx.get?.('jobs')
        } catch {
          return undefined
        }
      },
      runWithCallContext: (callCtx, fn) => callContextStorage.run(callCtx, fn),
      setCurrentCallContext: (callCtx) => {
        currentCallContextFallback = callCtx
      }
    }).map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  })

  /**
   * The prompt section: what the three tool families are for, what the trust tiers mean, and
   * how to read a spilled result. Those rules used to sit in every tool description; stating
   * them once is what let the definitions get small.
   *
   * The variable is registered before the section: interpolation is strict, and a `{{name}}
   * with no registration throws during assembly — which fails every model request rather
   * than one tool call.
   */
  // `systemPrompt` is reached through `ctx.inject`, not through the module-level `inject`
  // list: that list is a **requirement**, and a composition without `dsh-system-prompt`
  // would then refuse to load this plugin entirely. `ctx.inject` waits instead — the same
  // arrangement the browser half uses below, so a missing service costs the guidance section
  // and nothing else.
  //
  // This was wrong the first time in a way the real host made visible: the bundle declared
  // only `['tools']`, so `ctx.systemPrompt` was simply absent, the registration was skipped,
  // and everything still "worked". The unit harness said the same thing by throwing on the
  // property, and a `try/catch` there turned that hard signal into a silent no-op.
  ctx.inject(['systemPrompt'], (scoped) => {
    const prompt = scoped.systemPrompt
    if (typeof prompt?.section !== 'function' || typeof prompt?.variable !== 'function') {
      recordSectionRegistration('not registered: systemPrompt lacks section()/variable()')
      return
    }
    // `getSectionOrder` is the host's own placement table; a literal here would be a copy
    // that drifts, and `section()` rejects a missing order with a TypeError that says nothing
    // about which name was wrong.
    const order = prompt.getSectionOrder?.('TOOL_BASH')
    if (!Number.isFinite(order)) {
      recordSectionRegistration('not registered: TOOL_BASH has no section order')
      scoped.logger?.warn?.('at-terminal: TOOL_BASH has no section order; the tool guidance section is not registered')
      return
    }
    scoped.effect(() => {
      const disposers = [
        prompt.variable(TRUST_VARIABLE, () => trustFact()),
        prompt.section(promptSection({ order }))
      ]
      recordSectionRegistration(`registered (order ${order})`)
      return () => {
        recordSectionRegistration('not registered: disposed with the plugin')
        for (const dispose of disposers) dispose?.()
      }
    }, 'at-terminal: prompt section')
  })


  /**
   * Runtime skills: the three procedures that are too long for a tool description and too
   * situational for the prompt section.
   *
   * Same arrangement as the section above, and for the same reason — a composition without
   * `dsh-skill` loses the catalog and keeps the tools. Worth knowing when reading the
   * result: this desktop build **disables `tool-skill` at the base layer** and enables it
   * again only for preset-run agents (`dsh-web-app/cordis.patch.yml` vs
   * `dsh-web-app/presets/cordis.patch.yml`). So "registered on the host" and "visible to the
   * model" are two different questions; `ping` answers the first, and the plan records that
   * the second depends on the preset.
   */
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(() => {
      const outcome = registerRuntimeSkills(scoped.skills)
      if (outcome.registered !== RUNTIME_SKILLS.length) {
        scoped.logger?.warn?.(`at-terminal: ${outcome.status}`)
      }
      // Read back what the catalog actually offers: `register()` answers a duplicate with a
      // no-op disposer, so the call succeeding proves nothing on its own.
      void verifyRegisteredSkills(scoped.skills).then((status) => {
        if (!status.startsWith('registered 3/3')) scoped.logger?.warn?.(`at-terminal: ${status}`)
      })
      return () => {
        recordSkillStatus('not registered: disposed with the plugin')
      }
    }, 'at-terminal: runtime skills')
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
        // `ctx.userQuestions` is what can ask "how long?" instead of "yes or no?". Read per
        // call, and absent means the write still happens — just with a one-time grant.
        const resolveUserQuestions = () => {
          try {
            return scoped?.get?.('userQuestions') ?? ctx?.get?.('userQuestions')
          } catch {
            return undefined
          }
        }
        agentService = createDshAgentToolService({
          platform: handle.platform,
          terminalContext,
          resolveApproval,
          resolveUserQuestions,
          logger: scoped?.logger ?? ctx.logger,
          broadcastMonitor: (ev, data) => broadcastMonitorEvent(ev, data),
          getCurrentCallContext: () => callContextStorage.getStore() ?? currentCallContextFallback,
          // Whether a browser panel is listening, so `open_monitor` can answer honestly
          // instead of claiming a window nobody will see. `null` before the channel mounts.
          resolveClientPresence: () => getChannelPresence() ?? { sseClients: 0, clientHellos: 0 },
          // Read through a closure: the status tool is constructed here but asked later,
          // and the audit log belongs to the plugin's lifetime, not the assembly's.
          readAuditTail: (limit) => auditLog?.readRecent(limit),
          // The writing half. Without this the services' own `audit?.record()` calls were
          // no-ops — only the tool-level observer below ever landed a row, which is why
          // `user_approved` / `user_cancelled` / `job_killed` never appeared in the file.
          ...(auditLog === undefined ? {} : { audit: auditLog })
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
        resolveAgent: resolve(() => agentService),
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

