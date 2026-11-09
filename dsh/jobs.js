/**
 * Background execution for `at_terminal_run_remote_command`.
 *
 * This bundle is a job **producer**, never a controller: `job_output`, `job_list` and
 * `job_kill` already exist in `@deepseek-ai/dsh-tool-jobs`, and registering our own copies
 * would collide with them by name. What was missing was someone to hand the registry a job
 * for an SSH command, which is all this file does.
 *
 * The shape below is copied from the installed artefacts, not from documentation:
 * `dsh-jobs-local`'s `start()` builds `handle = { id, append, updateProgress }`, calls
 * `spec.run(handle)`, and binds `hooks.cancel` / `hooks.done` onto the record
 * (`lib/index.js:412-477`); `dsh-tool-terminal` is the reference producer for the field
 * list, including `owner: owner.id` — the **agent** id, because `start()` resolves it with
 * `agents.get(spec.owner)` (`lib/index.js:537-543`) and a session id would not resolve.
 *
 * Two things here are not obvious and are the whole point:
 *
 * 1. The question "may this run?" is answered **before** the job is handed over, by the
 *    registry's `tools/pre-execute` stage. If the answer is missing, this degrades to
 *    foreground instead of starting: a job runs detached from the call, so a dialog raised
 *    from inside it would arrive with no tool call in flight and nowhere to answer.
 * 2. Cancelling means sending the signal **and** proving it landed. Aborting the local
 *    AbortSignal ends the SSH channel and leaves the remote process running — which is
 *    exactly the defect this task exists to fix.
 */

import { backgroundScript, pidfileFor } from './host.bundle.js'

/** How much of the command fits in a job label before it stops being a label. */
const LABEL_LIMIT = 120;

/** Same cap a foreground call applies when the caller names none. */
const DEFAULT_MAX_OUTPUT_BYTES = 64000;

/**
 * @param {object} options
 * @param {object|undefined} options.jobs the registry's service (`ctx.get('jobs')`)
 * @param {object|undefined} options.exec the tool execution context
 * @param {object} options.service the agent tool service (`AgentToolService`)
 * @param {string} options.serverId the **resolved** server id the caller authorized
 * @param {string} options.command
 * @param {string|undefined} options.cwd
 * @param {number|undefined} options.maxOutputBytes
 * @param {'auto-approved'|'asked'|undefined} options.preAuthorized
 * @param {object|undefined} options.logger
 * @returns {{ ok: true, jobId: string } | { ok: false, reason: string }}
 */
export function startRemoteCommandJob({
  jobs,
  exec,
  service,
  serverId,
  command,
  cwd,
  maxOutputBytes,
  preAuthorized,
  logger
}) {
  if (!jobs || typeof jobs.start !== 'function') {
    return {
      ok: false,
      reason:
        'background execution needs the jobs service (@deepseek-ai/dsh-jobs with dsh-tool-jobs); this composition does not include it'
    }
  }
  if (preAuthorized !== 'asked' && preAuthorized !== 'auto-approved') {
    return {
      ok: false,
      reason:
        'background execution needs the authorization question answered before the job starts, and no pre-execute verdict was recorded for this call'
    }
  }
  const owner = exec?.agent?.id
  if (typeof owner !== 'string' || owner === '') {
    return {
      ok: false,
      reason:
        'background execution needs an initiating agent to own the job; this call has none'
    }
  }

  const limit = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES
  const toolCall =
    typeof exec?.callId === 'string'
      ? { callId: exec.callId, rootCallId: exec?.rootCallId ?? exec.callId }
      : undefined

  try {
    const jobId = jobs.start({
      kind: 'ssh-command',
      label: labelFor(serverId, command),
      ...(toolCall === undefined ? {} : { toolCall }),
      owner,
      outputLimitBytes: limit,
      run: (handle) => runCommand({ handle, service, serverId, command, cwd, limit, preAuthorized, logger })
    })
    return { ok: true, jobId }
  } catch (error) {
    // `start()` refuses when no controller serves the owner, when the owner has no live
    // agent, and when the owner is at its concurrency limit. All three are the same thing
    // from here: this call cannot be backgrounded, so say why rather than failing it.
    return { ok: false, reason: messageOf(error) }
  }
}

/**
 * The job body: run the command, stream its output into the ring, and settle honestly.
 *
 * `run` is called synchronously from inside `start()`, so `handle.id` already exists — that
 * is what the pidfile is named after, and it is generated before `start()` returns.
 */
function runCommand({ handle, service, serverId, command, cwd, limit, preAuthorized, logger }) {
  const pidfile = pidfileFor(handle.id)
  // A local abort is the only way to make the promise below settle when the remote kill
  // cannot land (dead connection, no pid recorded). Without it a cancelled job would stay
  // `stopping` until the session is archived.
  const controller = new AbortController()
  let cancelReason
  /** The remote kill started by `cancel()`; `done` waits for its report before settling. */
  let killPromise

  /**
   * Wait for the remote kill and report what it proved.
   *
   * `killed` is a claim about the remote process group, so it may only be settled from
   * `report.killed === true`. A failed or unconfirmed kill is a **failed** job with the
   * reason in `detail` — calling it killed would tell the operator a process is gone when
   * nothing verified that.
   */
  const settleKill = async () => {
    if (killPromise === undefined) {
      return { killed: false, detail: 'cancel was requested but no remote kill was sent' }
    }
    try {
      const report = await killPromise
      if (report?.killed === true) {
        return { killed: true, detail: cancelReason }
      }
      const detail =
        typeof report?.detail === 'string' && report.detail !== ''
          ? report.detail
          : 'the remote process was not confirmed gone'
      logger?.warn?.(`at-terminal: job ${handle.id} cancel: ${detail}`)
      return { killed: false, detail }
    } catch (error) {
      const detail = `remote kill failed: ${messageOf(error)}`
      logger?.warn?.(`at-terminal: job ${handle.id} cancel failed: ${messageOf(error)}`)
      return { killed: false, detail }
    }
  }

  /** Turn the reconciled kill outcome into the job's final status. */
  const settleCancelled = async () => {
    const outcome = await settleKill()
    return outcome.killed
      ? { status: 'killed', detail: outcome.detail }
      : { status: 'failed', detail: outcome.detail }
  }

  const done = (async () => {
    try {
      const result = await service.runRemoteCommand({
        serverId,
        // The pid write is part of the *command*, not something the executor adds: the
        // first version of this file named the pidfile and killed it later but never
        // wrote it, so `cat /tmp/.at-terminal-<job>.pid` returned exit 1 and the cancel
        // had nothing to signal. Every unit test passed, because they all stopped at
        // "start() was called"; only a real host showed the gap.
        command: backgroundScript(command, cwd, pidfile),
        // Deliberately no `cwd`: `backgroundScript` already folded it in *after* the pid
        // write. Passing it again would make the executor wrap the whole thing in another
        // `cd … &&`, and the `;` before the command would then break that `&&` chain —
        // a failed `cd` would no longer stop the command.
        maxOutputBytes: limit,
        // `0` = no deadline. A background command's lifetime belongs to the job; the
        // executor's 30 s default exists to bound a call that blocks a turn, and this one
        // blocks nothing.
        timeoutMs: 0,
        preAuthorized,
        signal: controller.signal,
        onOutput: (chunk) => handle.append(chunk.text, { channel: chunk.channel })
      })
      return cancelReason === undefined
        ? { status: 'completed', detail: exitText(result) }
        : await settleCancelled()
    } catch (error) {
      // A cancelled job's executor rejects with its own abort message; reporting that as a
      // raw failure would blame the command for the kill. But the kill itself still has to
      // prove the remote process is gone before this may call the job killed.
      return cancelReason === undefined
        ? { status: 'failed', detail: messageOf(error) }
        : await settleCancelled()
    }
  })()

  return {
    cancel: (reason) => {
      cancelReason = typeof reason === 'string' && reason !== '' ? reason : 'cancelled'
      // Start the remote kill first, exactly once: `cancel` must return synchronously (the
      // registry calls it from `killJob`), but the channel it depends on must still be open,
      // so the abort below happens after the SSH round trip is already in flight. The
      // promise is retained because `done` must wait for the report rather than assume it.
      if (killPromise === undefined) {
        try {
          killPromise = Promise.resolve(service.terminateRemoteCommand(serverId, pidfile))
        } catch (error) {
          // Keep `cancel` synchronous even if the service throws before returning a promise;
          // `settleKill` will report it as a failed kill, not as a successful one.
          killPromise = Promise.reject(error)
        }
      }
      controller.abort()
    },
    done
  }
}

/** `exit 0 (1234ms)`, or the signal that ended it. */
function exitText(result) {
  const outcome = result?.exitCode === null || result?.exitCode === undefined
    ? `signal ${result?.signal ?? 'unknown'}`
    : `exit ${result.exitCode}`
  return `${outcome} (${result?.durationMs ?? 0}ms)`
}

/** `server: command`, bounded — the bound applies to the whole label, prefix included. */
function labelFor(serverId, command) {
  const line = command.replace(/\s+/g, ' ').trim()
  const full = serverId ? `${serverId}: ${line}` : line
  return full.length > LABEL_LIMIT ? `${full.slice(0, LABEL_LIMIT - 1)}…` : full
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
