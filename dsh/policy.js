/**
 * AT Terminal's tool policy: one table, one guard, one pre-execute stage.
 *
 * Authorization used to live entirely inside `AgentToolService`, which meant every new
 * entry point had to remember to call it. These two stages sit in the *registry*, so a
 * tool that forgets — or a caller that bypasses the tool surface — is still classified,
 * still guarded, and still refused where the answer is not negotiable.
 *
 * The split follows the Host's own semantics, read from the installed
 * `@deepseek-ai/dsh-tools` (`ToolRuntime.prepareExecution`):
 *
 * | stage | shape | what belongs here |
 * |---|---|---|
 * | `tools.guard` | `(exec) => string \| undefined`, **synchronous**, runs *after* an `ask` is granted | denials no human answer can flip: a tool with no classification, a delete of a sensitive path |
 * | `tools/pre-execute` | `async (exec, next)` returning `allow` / `deny` / `ask` / `cancel` | everything negotiable: the per-server trust level and the command policy |
 *
 * A guard that needs I/O would have to be a `pre-execute`, and a `pre-execute` that wanted
 * to overrule a guard could not — the registry applies the guard to the final `allow`,
 * which is why "monotonic" is a property of the runtime rather than a promise here.
 *
 * This module imports nothing. The predicate it needs (`isSensitiveRemotePath`) and the
 * decision it delegates to (`authorizeCommand`) are injected, because both live in the
 * TypeScript half and a second copy of either would be the drift this file exists to stop.
 */

/** Every tool name this bundle registers carries this prefix. */
export const TOOL_PREFIX = 'at_terminal_'

/** The categories a row may declare. Anything else is a table bug, not a new kind of tool. */
export const RISK_CATEGORIES = Object.freeze(['read', 'command', 'write-remote', 'destructive', 'ui'])

/**
 * The coverage table. **Every registered tool has a row, and every row is a registered
 * tool** — `verify.mjs` asserts both directions, so a tool cannot be added without deciding
 * what it is, and a row cannot outlive the tool it describes.
 *
 * | risk | meaning |
 * |---|---|
 * | `read` | reaches a host or the local state and changes neither |
 * | `command` | runs a command line: the per-server trust level decides who asks |
 * | `write-remote` | writes through SFTP: `SftpWriteAuthorizer` owns the prompt |
 * | `destructive` | removes something: never auto-approved, and sensitive paths are refused outright |
 * | `ui` | changes what the user sees, not what a server holds |
 */
export const TOOL_POLICY = Object.freeze({
  at_terminal_ping: Object.freeze({ risk: 'read' }),
  at_terminal_list_ssh_servers: Object.freeze({ risk: 'read' }),
  at_terminal_get_terminal_context: Object.freeze({ risk: 'read' }),
  at_terminal_run_remote_command: Object.freeze({ risk: 'command' }),
  at_terminal_sftp_list_directory: Object.freeze({ risk: 'read' }),
  at_terminal_sftp_stat_path: Object.freeze({ risk: 'read' }),
  at_terminal_sftp_read_file: Object.freeze({ risk: 'read' }),
  at_terminal_sftp_write_file: Object.freeze({ risk: 'write-remote' }),
  at_terminal_sftp_create_file: Object.freeze({ risk: 'write-remote' }),
  at_terminal_sftp_create_directory: Object.freeze({ risk: 'write-remote' }),
  at_terminal_sftp_rename: Object.freeze({ risk: 'write-remote' }),
  at_terminal_sftp_delete: Object.freeze({ risk: 'destructive', guard: 'refuse-sensitive-path' }),
  at_terminal_open_monitor: Object.freeze({ risk: 'ui' }),
  at_terminal_get_hardware_metrics: Object.freeze({ risk: 'read', probe: 'builtin' }),
  at_terminal_get_agent_execution_status: Object.freeze({ risk: 'read' })
})

/** The row for `name`, or `undefined` when this tool is not ours or is unclassified. */
export function classify(name) {
  if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) return undefined
  return Object.prototype.hasOwnProperty.call(TOOL_POLICY, name) ? TOOL_POLICY[name] : undefined
}

/** Whether `name` looks like ours at all, classified or not. */
export function isOwnTool(name) {
  return typeof name === 'string' && name.startsWith(TOOL_PREFIX)
}

/**
 * What `pre-execute` concluded for one execution, so the tool body does not ask again.
 *
 * The registry mints one `exec` object per call and hands the *same* object to
 * `tools/pre-execute` and to `tool.execute(args, exec)`, so a `WeakMap` keyed on it needs
 * no plumbing through arguments and cannot leak between calls. The installed
 * `dsh-tool-present` uses the same shape for the same reason.
 *
 * `asked` means "the Host already put this to the user and the body only runs because the
 * answer was `allowed-once`" — a rejected or cancelled approval never reaches dispatch, so
 * the marker cannot be read as consent it did not get.
 */
const decisions = new WeakMap()

/** @param {object} exec @param {'auto-approved' | 'asked'} decision */
export function recordDecision(exec, decision) {
  if (exec !== null && typeof exec === 'object') decisions.set(exec, decision)
}

/** @param {object} exec @returns {'auto-approved' | 'asked' | undefined} */
export function readPreExecuteDecision(exec) {
  if (exec === null || typeof exec !== 'object') return undefined
  return decisions.get(exec)
}

/**
 * Build the monotonic guard.
 *
 * Two denials live here and only two, because a guard is the one stage nobody can overrule:
 *
 * 1. **A tool with no row.** Registering a new tool without classifying it would otherwise
 *    be the quiet way to add an unguarded entry point. Failing closed is the point.
 * 2. **Deleting a sensitive path through the SFTP tool.** Sensitive paths are where an
 *    agent that is following injected instructions buys persistence, and a delete is the
 *    one operation with nothing to inspect afterwards. The refusal names the way out
 *    (`run_remote_command` with an explicit `rm`), which puts the same intent through the
 *    command policy, the destructive-command warning and the audit trail.
 *
 * The path here is the argument the model wrote, not the `realpath`-resolved path the
 * authorizer sees, so a `..`-laden argument can pass this check — and is then resolved and
 * refused twice by `SftpWriteAuthorizer`. This refuses the obvious form; it does not claim
 * to be the only check.
 *
 * @param {{ isSensitiveRemotePath: (path: string) => boolean }} dependencies
 * @returns {(exec: object) => string | undefined}
 */
export function createGuard({ isSensitiveRemotePath } = {}) {
  if (typeof isSensitiveRemotePath !== 'function') {
    throw new TypeError('createGuard() needs isSensitiveRemotePath: a guard must not guess')
  }
  return function guardReason(exec) {
    const name = exec?.name
    if (!isOwnTool(name)) return undefined
    const entry = classify(name)
    if (entry === undefined) {
      return (
        `AT Terminal tool "${name}" has no row in dsh/policy.js, so this build cannot say what it is ` +
        'allowed to do. Add a classification before shipping it.'
      )
    }
    if (entry.guard !== 'refuse-sensitive-path') return undefined
    const path = exec?.arguments?.path
    if (typeof path !== 'string' || path === '') return undefined
    if (!isSensitiveRemotePath(path)) return undefined
    return (
      `Refusing to delete "${path}" through ${name}: it is a sensitive system path, and this tool ` +
      'never auto-approves one. Use at_terminal_run_remote_command with an explicit rm if the ' +
      'deletion is really intended — that path goes through the command policy, the destructive ' +
      'warning and the audit trail.'
    )
  }
}

/**
 * Build the `tools/pre-execute` stage.
 *
 * Only `command` tools are decided here. SFTP writes keep their prompt inside
 * `SftpWriteAuthorizer`, which is keyed on `(server, directory)` and cannot be expressed as
 * a single allow/deny — replacing it with a per-call `ask` would silently drop the
 * directory grants the UI offers, which is a worse prompt, not a stricter one.
 *
 * Everything that cannot be decided falls through with `next()`: an empty command, a
 * service that is still starting, a server id that does not resolve. The body then runs its
 * own authorization exactly as it did in 0.2.0, so a failure here degrades the *prompting*
 * to the old behaviour rather than removing the check.
 *
 * @param {{
 *   authorize: (input: { serverId?: string, command: string, cwd?: string }) =>
 *     Promise<{ serverLabel: string, host: string, autoApprove: boolean,
 *               destructive: boolean, riskSummaries?: readonly string[] }>,
 *   formatApprovalCopy: (request: { serverLabel: string, host: string, command: string,
 *     destructive: boolean, riskSummaries?: readonly string[] }) =>
 *     { reason: string, displayReason: string }
 * }} dependencies
 */
export function createPreExecute({ authorize, formatApprovalCopy } = {}) {
  if (typeof authorize !== 'function' || typeof formatApprovalCopy !== 'function') {
    throw new TypeError('createPreExecute() needs authorize() and formatApprovalCopy()')
  }

  return async function preExecute(exec, next) {
    const entry = classify(exec?.name)
    if (entry === undefined) return next()
    // The built-in probe asks nobody: it runs a fixed script that only reads, and making the
    // user approve `uptime` on every call would train them to approve without reading.
    if (entry.probe === 'builtin') return { kind: 'allow' }
    if (entry.risk !== 'command') return next()

    const args = exec?.arguments ?? {}
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (command === '') return next()

    let verdict
    try {
      verdict = await authorize({
        serverId: typeof args.serverId === 'string' && args.serverId !== '' ? args.serverId : undefined,
        command,
        cwd: typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
      })
    } catch {
      return next()
    }

    if (verdict?.autoApprove === true) {
      recordDecision(exec, 'auto-approved')
      return { kind: 'allow' }
    }

    const copy = formatApprovalCopy({
      serverLabel: verdict?.serverLabel ?? 'the selected server',
      host: verdict?.host ?? '',
      command,
      destructive: verdict?.destructive === true,
      riskSummaries: verdict?.riskSummaries
    })
    // Recorded *before* the prompt: dispatch only happens after `allowed-once`, so a marker
    // that survives to the body is proof the question was asked and answered.
    recordDecision(exec, 'asked')
    return { kind: 'ask', reason: copy.reason, displayReason: copy.displayReason }
  }
}
