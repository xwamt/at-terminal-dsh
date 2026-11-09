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
import { createCommands, registerCommands } from './commands.js'
import { classify, createGuard, createPreExecute } from './policy.js'
import { SERVER_TOOL_NAMES, TRUST_VARIABLE, promptSection, recordSectionRegistration, trustFact } from './prompt.js'
import { RUNTIME_SKILLS, recordSkillStatus, registerRuntimeSkills, verifyRegisteredSkills } from './skills.js'
import { createConfigSchema, readSettings } from './settings.js'
import { loadDialogMessages, resolveDialogLanguage, systemLanguageTag } from './locale.js'
import { createTools } from './tools.js'
// Compiled from src/platform/dsh/entry.ts by `node dsh/esbuild.dsh.mjs`. The domain
// layer is TypeScript and this file is not, so the bundle is the seam — and it exists as
// a committed artifact because a `link:`-installed package runs no build step.
import {
  TerminalContextRegistry,
  buildCommandApprovalCopy,
  createDshAgentToolService,
  createDshAssetApi,
  createDshConfigReader,
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
 * The local end of an upload, as the row's `command`, or `undefined` for every other call.
 *
 * An upload has two ends and `path` names only one: without this, the row says a file appeared
 * on the server and nothing about which file on the operator's own machine was sent — the half
 * an incident review asks about first. The wording is `SftpAgentService`'s own
 * (`upload <local> -> <remote>`) because one trail carrying two spellings of the same transfer
 * reads like two different events. It goes in `command`, not a field of its own: that field
 * already means "what the call tried to do" to the Settings page and to
 * `get_agent_execution_status`, and a new field would be one more thing every reader has to
 * learn before the row makes sense.
 */
function uploadSource(name, args, value) {
  if (name !== 'at_terminal_sftp_write_file') return undefined
  // The service reports the resolved source (realpath), which is the file that actually left the
  // machine; `args.localPath` is the caller's spelling and is only the fallback for a call that
  // failed before resolving. Two spellings of one transfer in one trail read as two events.
  const resolved = value?.localPath
  const localPath =
    typeof resolved === 'string' && resolved !== '' ? resolved : args?.localPath
  if (typeof localPath !== 'string' || localPath === '') return undefined
  return `upload ${localPath} -> ${args?.path ?? value?.path ?? ''}`
}

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
  const command = args.command ?? value?.command ?? uploadSource(name, args, value)
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
  // How the host was decided, when the call named none. `serverId` says *which*; this says
  // *on what grounds*, which is the question that matters once several servers are connected
  // — and the one a later reader cannot reconstruct from the row alone.
  if (value?.resolvedBy === 'explicit' || value?.resolvedBy === 'single-connected' || value?.resolvedBy === 'implicit') {
    entry.resolvedBy = value.resolvedBy
  }
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

  /**
   * Tool visibility facts for R3/R4.
   *
   * `knownServerCount` starts `undefined`, not 0: "not read yet" must keep every tool
   * visible. It is primed once per activation and refreshed from successful inventory reads;
   * `{ when }` itself does no I/O — it runs once per model step and only compares a number.
   */
  let knownServerCount
  const serverToolNames = new Set(SERVER_TOOL_NAMES)
  const jobToolControlNames = new Set(['at_terminal_job_output', 'at_terminal_job_kill'])
  /** The job pair the current step can see; feeds the background-result wording. */
  let resolvedJobToolNames = { output: 'job_output', kill: 'job_kill' }

  const resolveJobs = () => {
    try {
      return ctx.get?.('jobs')
    } catch {
      return undefined
    }
  }

  /** Resolve one tool through the host registry, or `undefined` when it cannot answer. */
  const visibleTool = (name, { scope, toolSet } = {}) => {
    try {
      if (typeof ctx.tools?.get !== 'function') return undefined
      return ctx.tools.get(name, scope, toolSet)
    } catch {
      return undefined
    }
  }

  /**
   * R3: hide the plugin's job tools where the host already supplies the pair.
   *
   * No job registry means this composition cannot start a background job at all, so the
   * controls have nothing to control. If `ctx.tools.get` is unavailable we keep the fallback
   * visible (fail-open): an older host must not lose the only way to collect a job.
   */
  const jobToolsWhen = async ({ agent, signal } = {}) => {
    signal?.throwIfAborted?.()
    try {
      if (resolveJobs() === undefined) return false
      const hostToolsVisible =
        visibleTool('job_output', { scope: agent }) !== undefined &&
        visibleTool('job_kill', { scope: agent }) !== undefined
      resolvedJobToolNames = hostToolsVisible
        ? { output: 'job_output', kill: 'job_kill' }
        : { output: 'at_terminal_job_output', kill: 'at_terminal_job_kill' }
      return !hostToolsVisible
    } catch {
      // A throwing condition fails the whole step as TOOL_ACTIVATION_FAILED; visibility is
      // an optimisation, so an evaluation failure keeps the fallback tools.
      return true
    }
  }

  /**
   * R4: hide the server-facing tools when the last successful read says there are none.
   *
   * `undefined` means "unread" and stays visible (fail-open). Hiding tools on the first turn
   * of a real session would be worse than paying their schemas for one step.
   */
  const needsServerWhen = async ({ signal } = {}) => {
    signal?.throwIfAborted?.()
    try {
      return knownServerCount === undefined ? true : knownServerCount > 0
    } catch {
      return true
    }
  }

  /**
   * A1: the multi-file patch tool is opt-in, and also server-facing.
   *
   * `readSettings(config)` is a live accessor read, so the setting is honoured on each model
   * step without re-registering the plugin. A settings read that throws keeps the tool
   * hidden: this tool can mutate several files through one call, so an unreadable opt-in is
   * not permission to enable it.
   */
  const readEnableApplyPatch = () => {
    const fallback = readSettings(config).enableApplyPatch
    if (config !== null && typeof config === 'object' && typeof config.get === 'function') {
      const value = config.get('enableApplyPatch', fallback)
      return value === undefined ? fallback : value
    }
    return fallback
  }
  const applyPatchWhen = async ({ signal } = {}) => {
    signal?.throwIfAborted?.()
    try {
      if (readEnableApplyPatch() !== true) return false
      return knownServerCount === undefined ? true : knownServerCount > 0
    } catch {
      return false
    }
  }

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
      resolveJobs,
      // The current step's job-tool pair, for `run_remote_command`'s background render.
      resolveJobToolNames: () => resolvedJobToolNames,
      // One successful server read is the only moment the count cache changes.
      onServersListed: (servers) => {
        knownServerCount = Array.isArray(servers) ? servers.length : 0
      },
      runWithCallContext: (callCtx, fn) => callContextStorage.run(callCtx, fn),
      setCurrentCallContext: (callCtx) => {
        currentCallContextFallback = callCtx
      }
    }).map((definition) => {
      const when =
        definition.name === 'at_terminal_sftp_apply_patch'
          ? applyPatchWhen
          : serverToolNames.has(definition.name)
            ? needsServerWhen
            : jobToolControlNames.has(definition.name)
              ? jobToolsWhen
              : undefined
      return ctx.tools.register(definition, when === undefined ? undefined : { when })
    })
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  })

  /**
   * Two Host-side slash commands. `/ssh-metrics` and `/ssh-audit` answer questions about the
   * plugin itself, and running them as commands is the point: the session gets
   * `command/run` + `command/done` and no assistant message, so asking "what is the CPU at"
   * does not spend a turn.
   *
   * `ctx.inject` as elsewhere: a composition without `dsh-commands` loses the two commands and
   * keeps the tools. The duplicate-name case is handled inside `registerCommands` because
   * `commands.register()` throws on it and a reload would otherwise take the bundle down.
   */
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(() => {
      const disposers = registerCommands(
        scoped.commands,
        createCommands({
          resolveAgentService,
          readAudit: (limit) => auditLog?.readRecent(limit),
          logger: scoped.logger
        }),
        { logger: scoped.logger }
      )
      return () => {
        for (const dispose of disposers) dispose?.()
      }
    }, 'at-terminal: commands')
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
    /**
     * Settings are read through the documented port, not off the raw accessor map:
     * `getSection('sshManager').get(key, default)` is the one section this platform serves, and
     * the gate that rejects an unsupported section is what keeps a typo from silently reading
     * defaults.
     */
    const settingsSection = createDshConfigReader(config).getSection('sshManager')

    /**
     * The language the approval dialogs are written in.
     *
     * `auto` follows the **operating system** — see `locale.js` for why not the app's UI
     * language (that one lives in the renderer, where a Host plugin cannot see it).
     *
     * These are `let`, not `const`: every setting field is `.volatile()`, so DSH's Loader
     * commits a settings edit into the running accessors and emits `loader/volatile-update`
     * instead of restarting the plugin. Reading only at activation would leave the approval
     * cards — and `state.get` — reporting the old language until DSH restarted.
     */
    let dialogLanguageSetting = settingsSection.get('dialogLanguage', 'auto')
    const languageTag = systemLanguageTag()
    let dialogLanguage = resolveDialogLanguage(dialogLanguageSetting, languageTag)
    const dialogMessages = loadDialogMessages(bundlePath, dialogLanguage)
    scoped.logger?.info?.(
      `at-terminal: approval dialogs in ${dialogLanguage} ` +
        `(setting ${dialogLanguageSetting}, system ${languageTag}, ${Object.keys(dialogMessages).length} strings)`
    )

    /**
     * Apply a volatile-only settings edit to the dialog language.
     *
     * `createDshLocalization(messages)` captured the **dictionary object** when the platform
     * was assembled, so a refresh must mutate that object (`Object.assign`) instead of
     * replacing it: a new object would leave the running platform translating from the old
     * dictionary.
     *
     * Registered on the **outer** `ctx`, not on the `scoped` context injected below: Loader
     * dispatches `loader/volatile-update` to the entry's own fiber with a filter
     * (`owner.fiber === fiber`), and a listener on an `ctx.inject` child fiber — which is a
     * separate fiber — would never receive it. The `scoped.effect` only owns the disposer so
     * the listener dies with the injection that created it.
     *
     * Feature-detected: `loader/volatile-update` belongs to Loader 1.1. An older host never
     * emits it, and the plugin must keep working exactly as before — so registration is
     * guarded by `typeof`, not assumed.
     */
    if (typeof ctx.on === 'function') {
      scoped.effect(
        () =>
          ctx.on('loader/volatile-update', (paths) => {
            const changed = Array.isArray(paths)
              ? paths.some(
                  (path) =>
                    path === 'dialogLanguage' ||
                    (Array.isArray(path) && path.includes('dialogLanguage'))
                )
              : false
            if (!changed) return
            try {
              const nextSetting = settingsSection.get('dialogLanguage', 'auto')
              const nextLanguage = resolveDialogLanguage(nextSetting, languageTag)
              dialogLanguageSetting = nextSetting
              if (nextLanguage === dialogLanguage) return
              dialogLanguage = nextLanguage
              // `Object.assign` alone only overlays keys: switching zh-CN -> en (whose
              // dictionary is empty because English is the source language) would keep every
              // Chinese string. Delete what the next dictionary does not carry, then overlay
              // in place — the object identity is what the captured localization reads.
              const nextMessages = loadDialogMessages(bundlePath, nextLanguage)
              for (const key of Object.keys(dialogMessages)) {
                if (!Object.prototype.hasOwnProperty.call(nextMessages, key)) delete dialogMessages[key]
              }
              Object.assign(dialogMessages, nextMessages)
              scoped.logger?.info?.(
                `at-terminal: approval dialogs in ${dialogLanguage} ` +
                  `(setting ${dialogLanguageSetting}, system ${languageTag}, ${Object.keys(dialogMessages).length} strings)`
              )
            } catch (error) {
              // The Loader logs a throwing listener and keeps the (already committed) values;
              // a dictionary that cannot be read must not take the plugin down with it.
              scoped.logger?.warn?.(
                'at-terminal: dialog language update failed: %s',
                error?.message ?? String(error)
              )
            }
          }),
        'at-terminal: dialog language'
      )
    }
    let assets
    let servers
    let terminal
    let sftp
    let assetsError
    /**
     * The Host's plugin manager, when this composition has one.
     *
     * Injected separately from the block above: it owns bundle installation and switching, which
     * only the optional SSH bundle needs. A preset-only composition without it keeps all direct
     * tools and three panes; the settings page then says the switch is unavailable instead of the
     * plugin failing to activate.
     */
    let pluginManager
    /**
     * Lifetime teardown, registered **before** the assembly starts.
     *
     * A `scoped.effect` inside `.then` is too late: when the plugin is disposed while
     * `createDshPlatform` is still opening `at_terminal_state`, the `.then` never runs on a
     * live scope, so the handle it would have closed leaks and the storage domain stays
     * reserved for the next instance (`already-open`). Registering the disposer first gives
     * Cordis a promise to wait on in both orders.
     */
    let disposed = false
    /** Set only once a handle exists and its faces are wired; owns the normal-path teardown. */
    let teardown
    /** The close started because disposal preceded assembly; awaited by the disposer above. */
    let closingEarly
    let settleTeardown
    let rejectTeardown
    const pendingTeardown = new Promise((resolve, reject) => {
      settleTeardown = resolve
      rejectTeardown = reject
    })
    scoped.effect(
      () => () => {
        disposed = true
        // No handle yet: wait for the in-flight assembly to produce one and close it. That is
        // what keeps the old instance's teardown pending until `at_terminal_state` is actually
        // released, instead of letting the next instance race it with `already-open`.
        return teardown === undefined ? pendingTeardown : teardown()
      },
      'at-terminal: platform lifetime'
    )
    const assembled = createDshPlatform({
      logger: scoped.logger,
      credentials: scoped.credentials,
      storageDomain: scoped.storageDomain,
      // The resolved row config: `apply` receives `resolveConfig()`'s output, where each
      // `.volatile()` field is a per-call accessor.
      settings: config,
      /**
       * The dictionary the approval dialogs are rendered through.
       *
       * The language has to exist before the first card is drawn; `createDshLocalization`
       * captures this object, so a volatile settings update mutates it in place instead of
       * rebuilding the platform. `auto` follows the operating system (see `locale.js` for why
       * the system and not the app's UI language: the UI language lives in the renderer and a
       * Host plugin cannot see it).
       */
      messages: dialogMessages,
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
      .then(async (handle) => {
        if (disposed) {
          // Disposed while assembling: no faces exist and the lifetime effect above is the
          // only owner of this handle. Settle its promise from the close itself, so a close
          // failure reaches Cordis as a rejection instead of being swallowed here.
          closingEarly = handle.close()
          closingEarly.then(settleTeardown, rejectTeardown)
          return
        }
        try {
          // One platform, four faces. The asset face is the VS Code variant's own services;
          // the server, terminal and SFTP faces compose the same `ConfigManager`,
          // `HostKeyStore`, `SshSession` and `SftpManager` the extension uses, so a record
          // saved here is the record VS Code would have written and a terminal here is the
          // same connection it would have made.
          const shared = { platform: handle.platform, hostName: pkg.name, hostVersion: pkg.version }
          assets = createDshAssetApi(shared)
          const serverApi = createDshServerApi({
            platform: handle.platform,
            privateKeyDirectory: importedPrivateKeyDirectory(handle.platform)
          })
          /**
           * The server face plus a count cache.
           *
           * `knownServerCount` decides whether the server-facing tools are registered as
           * visible in the next model step. Every successful inventory read updates it, and
           * so do save/remove: a panel that adds a server must make the tools appear without
           * requiring the model to call `list_ssh_servers` first. The count is only a cache —
           * `{ when }` never reads storage itself.
           */
          servers = {
            ...serverApi,
            async list() {
              const result = await serverApi.list()
              knownServerCount = Array.isArray(result?.servers) ? result.servers.length : 0
              return result
            },
            async save(input) {
              const created = input?.id === undefined
              const result = await serverApi.save(input)
              if (created && knownServerCount !== undefined) knownServerCount += 1
              return result
            },
            async remove(id) {
              const result = await serverApi.remove(id)
              if (result?.removed === true && knownServerCount !== undefined) {
                knownServerCount = Math.max(0, knownServerCount - 1)
              }
              return result
            }
          }
          // Prime the cache once per activation. A failed read is not fatal: the count stays
          // undefined and every tool remains visible (fail-open) rather than hiding a real
          // server behind a storage hiccup.
          void servers.list().catch((error) => {
            scoped.logger?.warn?.(
              'at-terminal: server inventory read failed; keeping all tools visible: %s',
              error?.message ?? String(error)
            )
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

          /**
           * Normal-path teardown, read by the lifetime effect registered before assembly.
           *
           * Order matters: the SFTP manager holds connections whose disposal emits through
           * the platform's notifier, so it goes before the platform closes. The promise is
           * returned rather than voided, because Cordis only waits for a disposer that
           * returns its cleanup — and `at_terminal_state` must be closed before a new
           * instance can open it.
           */
          teardown = () => {
            sftp.dispose()
            return handle.close()
          }
        } catch (error) {
          // A setup failure after the domain opened must not leak the handle: close it here,
          // before the failure is reported, so a retry can open the domain again.
          try {
            sftp?.dispose()
          } catch (cleanupError) {
            scoped.logger?.warn?.(
              'at-terminal: SFTP disposal after a failed assembly failed: %s',
              cleanupError?.message ?? String(cleanupError)
            )
          }
          try {
            await handle.close()
          } catch (closeError) {
            scoped.logger?.error?.(
              'at-terminal: platform close after a failed assembly failed: %s',
              closeError?.message ?? String(closeError)
            )
          }
          throw error
        }
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
      .finally(() => {
        // A failed assembly produces no handle; an early close settles this promise itself.
        // Either way the lifetime disposer must not be left waiting forever.
        if (closingEarly === undefined) settleTeardown()
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

    /**
     * The plugin manager, if this composition has one.
     *
     * `disabled: !!js "!ctx.get('profileContext')"` guards the row in `dsh-base`, so a profile
     * assembly always has it and a bare composition may not — which is why this is a separate
     * inject instead of a member of the list above: the tools must not depend on it.
     */
    ctx.inject(['pluginManager'], (manager) => {
      pluginManager = manager.pluginManager
      manager.effect(() => () => {
        pluginManager = undefined
      })
    })

    scoped.effect(() =>
      registerChannel(scoped, {
        version: pkg.version,
        resolvePluginManager: () => pluginManager,        // Resolved per call, so the channel can mount before the platform finishes opening
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
        resolveSettings: () => readSettings(config),
        // Readable through `state.get` without spending a model turn: the language the dialogs
        // will use, why, and how many strings the dictionary carries.
        dialogLanguage: () => ({
          setting: dialogLanguageSetting,
          system: languageTag,
          language: dialogLanguage,
          strings: Object.keys(dialogMessages).length
        })
      })
    )

    // Keep the promise observable: an unhandled rejection here would be invisible.
    void assembled
  })
}

