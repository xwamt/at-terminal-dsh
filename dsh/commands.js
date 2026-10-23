/**
 * Two slash commands, Host side only.
 *
 * Why these two: `/ssh-metrics` and `/ssh-audit` are the two questions a person asks *about*
 * the plugin rather than of a remote host, and both are already answered by code this bundle
 * owns. Running them as a command rather than as a model turn is the point — the session log
 * gets `command/run` + `command/done` and no assistant message, so asking "what is the CPU at"
 * does not spend a turn, a prompt, or a tool call.
 *
 * The contract, read out of `dsh-commands/lib/index.js` rather than assumed:
 *
 * - `register({ name, description, input?: {hint, attachments?}, handler })`, name matching
 *   `/^[a-z][a-z0-9_-]*$/u` (`:78`, `:150`).
 * - the handler receives `{ commandId, agent, rawInput, attachments, signal }` (`:379-388`);
 * - it must return `{ kind: 'success', text? }` or `{ kind: 'error', text }` with a non-empty
 *   text (`normalizeResult`, `:184-203`) — an unknown kind **throws**, it does not degrade;
 * - a duplicate name **throws** at registration (`NamedEntries`, `:89`), which is why
 *   `registerCommands` treats "already registered" as a skip and keeps the first definition.
 *
 * Handlers never throw: they answer with an error result instead, because a throw is logged as
 * a `command/done` failure and leaves the person with a stack trace where a sentence would do.
 */

/** Candidate servers, and how the command names one: by id first, then by label. */
function pickServer(servers, wanted) {
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  const needle = wanted.trim().toLowerCase();
  if (needle !== '') {
    const exact = servers.find(
      (server) => String(server?.id ?? '').toLowerCase() === needle
    );
    if (exact !== undefined) return exact;
    const labelled = servers.find(
      (server) => String(server?.label ?? '').toLowerCase() === needle
    );
    if (labelled !== undefined) return labelled;
    return undefined;
  }
  return servers.find((server) => server?.connected === true) ?? servers[0];
}

function megabytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '?';
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A few lines a person can read at a glance.
 *
 * Deliberately short: the HUD is where live numbers belong, and a command result that dumps
 * every mount and process would be a worse copy of it.
 */
function formatMetrics(server, metrics) {
  const label = `${server.label ?? server.id} (${server.host ?? '?'})`;
  const cpu = typeof metrics?.cpu?.usagePercent === 'number'
    ? `${metrics.cpu.usagePercent.toFixed(1)}%`
    : '?';
  const load = Array.isArray(metrics?.cpu?.loadAvg)
    ? metrics.cpu.loadAvg.map((value) => Number(value).toFixed(2)).join(', ')
    : '?';
  const memory = `${megabytes(metrics?.memory?.usedBytes)} / ${megabytes(metrics?.memory?.totalBytes)}`;
  const mounts = Array.isArray(metrics?.disk?.mounts) ? metrics.disk.mounts : [];
  const fullest = mounts.reduce((worst, mount) => {
    const use = typeof mount?.usePercent === 'number' ? mount.usePercent : -1;
    return use > worst.use ? { use, mount } : worst;
  }, { use: -1, mount: undefined });

  const lines = [
    `${label}`,
    `CPU ${cpu}   load ${load}   memory ${memory}`,
    fullest.mount === undefined
      ? 'disk: ?'
      : `disk ${fullest.mount.mount}: ${fullest.mount.usePercent}% of ${megabytes(fullest.mount.totalBytes)}`
  ];
  const processes = Array.isArray(metrics?.processes) ? metrics.processes.slice(0, 3) : [];
  for (const process of processes) {
    lines.push(
      `  ${String(process.command ?? '?').slice(0, 28)}  cpu ${process.cpuPercent ?? '?'}%  mem ${process.memPercent ?? '?'}%`
    );
  }
  return lines;
}

function formatAuditRow(row) {
  const when = typeof row?.timestamp === 'number' ? new Date(row.timestamp) : undefined;
  const time = when === undefined
    ? '??:??:??'
    : [when.getHours(), when.getMinutes(), when.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
  const decision = String(row?.decision ?? '?').padEnd(9);
  const command = String(row?.command ?? '').replace(/\s+/g, ' ').slice(0, 72);
  return `${time}  ${decision}  ${command}`;
}

/**
 * The command definitions.
 *
 * @param {object} options
 * @param {() => any} [options.resolveAgentService] lazy: the platform assembly mounts later
 * @param {(limit: number) => Promise<any[]>} [options.readAudit] the durable trail's tail
 * @param {{ warn?: (message: string) => void }} [options.logger]
 */
export function createCommands({ resolveAgentService, readAudit, logger } = {}) {
  const service = () => {
    try {
      return resolveAgentService?.()
    } catch {
      return undefined
    }
  }

  return [
    {
      name: 'ssh-metrics',
      description: 'Show CPU, memory, disk and top processes for an AT Terminal SSH server, and open the live HUD.',
      input: { hint: '[server id or label]' },
      async handler({ rawInput }) {
        const agentService = service()
        if (!agentService) {
          return { kind: 'error', text: 'AT Terminal is not ready: its agent service is not mounted in this composition.' }
        }
        const wanted = String(rawInput ?? '').trim()
        try {
          const listed = await agentService.listServers()
          const servers = Array.isArray(listed?.servers) ? listed.servers : []
          const server = pickServer(servers, wanted)
          if (server === undefined) {
            return {
              kind: 'error',
              text: servers.length === 0
                ? 'No SSH server is configured for AT Terminal.'
                : `No server matches "${wanted}". Known servers: ${servers.map((entry) => entry.label ?? entry.id).join(', ')}.`
            }
          }
          const metrics = await agentService.getHardwareMetrics(server.id)
          const lines = formatMetrics(server, metrics)

          // The live view is the part a snapshot cannot do, so the command says out loud
          // whether it opened. Failing to open one is not a failed command.
          try {
            const opened = await agentService.openMonitor({ target: 'hardware', serverId: server.id })
            lines.push(
              '',
              opened?.opened === true
                ? 'HUD: opened'
                : `HUD: not opened (${opened?.reason ?? 'unknown reason'})`
            )
          } catch (error) {
            lines.push('', `HUD: not opened (${describeError(error)})`)
          }
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: `ssh-metrics failed: ${describeError(error)}` }
        }
      }
    },
    {
      name: 'ssh-audit',
      description: 'Show the most recent AT Terminal audit rows: when, what was decided, and the command or path.',
      input: { hint: '[rows, 1-50, default 10]' },
      async handler({ rawInput }) {
        const requested = Number.parseInt(String(rawInput ?? '').trim(), 10)
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 10
        if (typeof readAudit !== 'function') {
          return { kind: 'error', text: 'AT Terminal is not ready: the audit trail is not mounted in this composition.' }
        }
        try {
          const rows = await readAudit(limit)
          if (rows === undefined) {
            // The file is absent until the first tool call; that is a state, not a failure.
            return { kind: 'success', text: 'No audit trail yet: nothing has been recorded in this Host home.' }
          }
          if (rows.length === 0) {
            return { kind: 'success', text: 'The audit trail is empty.' }
          }
          return {
            kind: 'success',
            text: [`AT Terminal audit (last ${rows.length}):`, ...rows.map(formatAuditRow)].join('\n')
          }
        } catch (error) {
          return { kind: 'error', text: `ssh-audit failed: ${describeError(error)}` }
        }
      }
    }
  ]
}

/**
 * Register the definitions, skipping ones that already exist.
 *
 * `commands.register()` throws on a duplicate name, and the same bundle can be applied twice
 * (a reload, a second profile row). Re-registering is not a failure — the first definition is
 * still the one people see — so it is a warning, not an exception, and the returned disposers
 * cover only what this call actually added.
 *
 * @param {{ register: (definition: unknown) => () => void }} commands
 * @param {ReadonlyArray<unknown>} definitions
 * @param {{ logger?: { warn?: (message: string) => void } }} [options]
 * @returns {Array<() => void>}
 */
export function registerCommands(commands, definitions, { logger } = {}) {
  const disposers = []
  for (const definition of definitions) {
    const name = definition?.name ?? '(unnamed)'
    try {
      const dispose = commands.register(definition)
      disposers.push(typeof dispose === 'function' ? dispose : () => undefined)
    } catch (error) {
      const message = describeError(error)
      if (/already registered/.test(message)) {
        logger?.warn?.(`at-terminal: command "/${name}" is already registered; keeping the existing one`)
        continue
      }
      logger?.warn?.(`at-terminal: command "/${name}" was refused by the host: ${message}`)
    }
  }
  return disposers
}
