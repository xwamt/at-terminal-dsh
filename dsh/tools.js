/**
 * AT Terminal — tool definitions for DeepSeek Harness.
 *
 * This module is deliberately free of every `@deepseek-ai/*` import: it holds
 * plain data plus a factory, so it loads from anywhere. `index.js` owns the
 * wiring into `ctx.tools.register()`.
 *
 * Registration contract (read from the installed `@deepseek-ai/dsh-tools`,
 * `ToolRuntime.register()`): a definition is `{ name, description,
 * parameters, output: { schema, render } }` where **both** `parameters` and
 * `output.schema` are already normalized JSON Schema — `register()` only
 * asserts the output schema, it does not run the authoring DSL. `defineTool`
 * is a convenience that *produces* that shape; the runtime does not need it.
 *
 * `parameters` is therefore the exact output of the installed
 * `parameterSchemaSpecToJsonSchema({})`, which is `{ type: 'object',
 * properties: {} }` — **not** `{}`. Writing `{}` here would hand `register()`
 * a schema with no `type`, so `scripts/verify.mjs` pins this value against the
 * real package on every run.
 *
 * The explicit output schema is already in the enforced raw-JSON-Schema
 * subset, and `valueSchemaSpecToJsonSchema()` is the identity on it (checked,
 * not assumed): an explicit object node must state `additionalProperties:
 * true | false`, and a bare `{ type: 'object' }` is rejected.
 */

import { SETTINGS_FIELDS, readSettings } from './settings.js'

/** Plugin identity as it appears in the bundle patch row. */
export const AT_TERMINAL_PLUGIN_ID = 'at-terminal'

/** Bundle package name; must equal `package.json` `name`. */
export const AT_TERMINAL_BUNDLE_NAME = '@at-series/dsh-at-terminal'

/**
 * What this build can actually do. Kept honest per milestone: a capability is
 * listed only once its code path exists and has been verified.
 */
export const CAPABILITIES = Object.freeze([
  'plugin-skeleton',
  'direct-agent-tools',
  'monitor-floating-window',
  // Declared because the code paths exist and are covered by the tool tests: the probe is the
  // one place a caller looks to decide what it may attempt, so omitting a working feature made
  // SFTP and remote commands look unavailable even though every tool below was registered.
  'remote-command-execution',
  'sftp-file-operations',
  'hardware-metrics',
  'agent-execution-status'
])

/** JSON-schema type for one settings field, for the probe's output schema. */
const SETTINGS_JSON_TYPES = Object.freeze({
  integer: 'integer',
  string: 'string',
  boolean: 'boolean'
})

/** Output-schema node describing the effective settings, built from one table. */
function settingsOutputSchema() {
  const properties = {}
  for (const field of SETTINGS_FIELDS) {
    const type = SETTINGS_JSON_TYPES[field.type]
    if (type === undefined) throw new TypeError(`unsupported settings field type "${field.type}"`)
    properties[field.key] = { type }
  }
  return { type: 'object', additionalProperties: false, properties }
}

/**
 * Normalized parameter schema for a tool that takes no arguments.
 *
 * Hard-coded because it is data, not logic: it is the literal return of the
 * installed `parameterSchemaSpecToJsonSchema({})`. `scripts/verify.mjs`
 * re-derives it from the real package and fails if the two ever diverge.
 */
export const EMPTY_PARAMETERS = Object.freeze({
  type: 'object',
  properties: Object.freeze({})
})

const SFTP_TARGET_PROPERTIES = Object.freeze({
  terminalId: { type: 'string', description: 'Connected AT Terminal terminal id.' },
  serverId: { type: 'string', description: 'Configured AT Terminal SSH server id.' }
})

/**
 * Validate the argument object before it reaches a service.
 *
 * The Harness does not enforce a tool's `parameters` schema itself, so a call with a missing
 * `path` used to travel all the way into the domain layer and surface as
 * "Cannot read properties of undefined (reading 'trim')" — an error that names neither the
 * tool nor the argument. These guards turn that into a message the model can act on.
 */
function argsOf(toolName, args) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName}: arguments must be an object.`)
  }
  return args
}

function requireNonEmptyString(toolName, input, key) {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${toolName}: "${key}" is required and must be a non-empty string.`)
  }
  return value
}

function requireEnum(toolName, input, key, allowed) {
  const value = input[key]
  if (value === undefined || value === null) {
    throw new Error(`${toolName}: "${key}" is required and must be one of: ${allowed.join(', ')}.`)
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${toolName}: "${key}" must be one of: ${allowed.join(', ')}.`)
  }
  return value
}

/** Format a Unix epoch in *seconds* (SFTP `mtime`) as an ISO timestamp. */
function formatEpochSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 'unknown'
  return new Date(seconds * 1000).toISOString()
}

/** Compact byte formatting for rendered metrics. */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`
}

/**
 * Keep only mounts a human cares about.
 *
 * `df -P` also reports every container overlay and tmpfs, so a Docker host answers with
 * dozens of identical "43% of 889GB" lines. Those are not disks of their own — they share
 * the host filesystem — and they buried the two real ones.
 */
function isRelevantMount(m) {
  if (!m || typeof m.mount !== 'string') return false
  if (['overlay', 'tmpfs', 'devtmpfs', 'squashfs', 'shm', 'ramfs'].includes(m.fs)) return false
  if (/^\/(var\/lib\/docker|run\/containerd|var\/lib\/kubelet|snap)\//.test(m.mount)) return false
  if (m.mount.startsWith('/sys/') || m.mount.startsWith('/proc/')) return false
  return true
}

/** How many rows each hardware-metrics section may render; the rest is summarized. */
const HARDWARE_RENDER_LIMIT = 5

const TERMINAL_SUMMARY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    terminalId: { type: 'string' },
    serverId: { type: 'string' },
    label: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'integer' },
    username: { type: 'string' },
    connected: { type: 'boolean' },
    focused: { type: 'boolean' },
    default: { type: 'boolean' }
  }
})

function normalizeTerminalSummary(s) {
  if (!s) return null
  return {
    terminalId: s.terminalId,
    serverId: s.serverId,
    label: s.label,
    host: s.host,
    port: s.port,
    username: s.username,
    connected: Boolean(s.connected),
    focused: Boolean(s.focused),
    default: Boolean(s.default)
  }
}

/**
 * Build the readiness probe tool.
 *
 * @param {object} [options]
 * @param {string} [options.version]  Plugin version, reported back to the model.
 * @param {() => Date} [options.now]  Injectable clock, so tests stay deterministic.
 * @param {Record<string, { get(): unknown }>} [options.config] Resolved plugin
 *   config; its volatile accessors are read per call to report the settings the
 *   Host half is actually running with.
 */
export function createPingTool({ version = 'unknown', now = () => new Date(), config = {} } = {}) {
  return {
    name: 'at_terminal_ping',
    description:
      'Report whether the AT Terminal plugin is loaded in DeepSeek Harness, which of its capabilities this build provides, and the effective AT Terminal settings. Call it to confirm the plugin is live and to read its current configuration before depending on AT Terminal features; it reaches no remote host and changes nothing.',
    parameters: EMPTY_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { type: 'string' },
          version: { type: 'string' },
          ready: { type: 'boolean' },
          capabilities: { type: 'array', items: { type: 'string' } },
          settings: settingsOutputSchema(),
          platform: { type: 'string' },
          node: { type: 'string' },
          checkedAt: { type: 'string' }
        }
      },
      render(_args, value) {
        const capabilities = value.capabilities.length > 0 ? value.capabilities.join(', ') : '(none)'
        const settings = SETTINGS_FIELDS.map((field) => `${field.key}=${JSON.stringify(value.settings[field.key])}`)
        return [
          {
            type: 'text',
            text: `AT Terminal ${value.version} is loaded; ready=${value.ready}. Capabilities: ${capabilities}.`
          },
          {
            type: 'text',
            text: `Effective settings: ${settings.join(', ')}.`
          }
        ]
      }
    },
    async execute() {
      return {
        plugin: AT_TERMINAL_PLUGIN_ID,
        version,
        ready: true,
        capabilities: [...CAPABILITIES],
        settings: readSettings(config),
        platform: process.platform,
        node: process.versions.node,
        checkedAt: now().toISOString()
      }
    }
  }
}

export function createListSshServersTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_list_ssh_servers',
    description:
      'List configured AT Terminal SSH servers authorized for direct background commands, including currently connected interactive terminals. Reports server connection status and trust levels.',
    parameters: EMPTY_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                host: { type: 'string' },
                port: { type: 'integer' },
                username: { type: 'string' },
                authType: { type: 'string' },
                connected: { type: 'boolean' },
                agentCommandTrust: { type: 'string' },
                agentCommandAutoApprove: { type: 'boolean' }
              }
            }
          }
        }
      },
      render(_args, val) {
        if (!val.servers || val.servers.length === 0) {
          return [{ type: 'text', text: 'No authorized SSH servers found.' }]
        }
        const lines = val.servers.map(
          (s) =>
            `- ${s.label} (${s.id}) at ${s.username}@${s.host}:${s.port} [connected=${s.connected}, trust=${s.agentCommandTrust}]`
        )
        return [{ type: 'text', text: `Authorized SSH Servers (${val.servers.length}):\n${lines.join('\n')}` }]
      }
    },
    async execute(_args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_c, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.listServers()
        return {
          servers: (res.servers || []).map((s) => ({
            id: s.id,
            label: s.label,
            host: s.host,
            port: s.port,
            username: s.username,
            authType: s.authType,
            connected: Boolean(s.connected),
            agentCommandTrust: s.agentCommandTrust,
            agentCommandAutoApprove: Boolean(s.agentCommandAutoApprove)
          }))
        }
      })
    }
  }
}

export function createGetTerminalContextTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_get_terminal_context',
    description:
      'Get the active SSH terminal session context, connected terminal list, and known terminal history from AT Terminal.',
    parameters: EMPTY_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          focusedTerminal: {
            oneOf: [TERMINAL_SUMMARY_SCHEMA, { type: 'null' }]
          },
          defaultConnectedTerminal: {
            oneOf: [TERMINAL_SUMMARY_SCHEMA, { type: 'null' }]
          },
          connectedTerminals: {
            type: 'array',
            items: TERMINAL_SUMMARY_SCHEMA
          },
          knownTerminals: {
            type: 'array',
            items: TERMINAL_SUMMARY_SCHEMA
          }
        }
      },
      render(_args, val) {
        const focused = val.focusedTerminal
          ? `${val.focusedTerminal.label} (${val.focusedTerminal.terminalId})`
          : 'none'
        const connectedCount = val.connectedTerminals ? val.connectedTerminals.length : 0
        return [{ type: 'text', text: `Terminal Context: focused=${focused}, connectedCount=${connectedCount}` }]
      }
    },
    async execute(_args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_c, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const snapshot = await service.getTerminalContext()
        return {
          focusedTerminal: normalizeTerminalSummary(snapshot.focusedTerminal),
          defaultConnectedTerminal: normalizeTerminalSummary(snapshot.defaultConnectedTerminal),
          connectedTerminals: (snapshot.connectedTerminals || []).map(normalizeTerminalSummary).filter(Boolean),
          knownTerminals: (snapshot.knownTerminals || []).map(normalizeTerminalSummary).filter(Boolean)
        }
      })
    }
  }
}

export function createRunRemoteCommandTool({ resolveAgentService, setCurrentCallContext, runInContext } = {}) {
  return {
    name: 'at_terminal_run_remote_command',
    description:
      'Run a non-interactive shell command on a configured AT Terminal SSH server. Commands are evaluated against the server trust level and command policy. Destructive operations require confirmation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serverId: { type: 'string', description: 'SSH server id, or "active" to use current terminal.' },
        command: { type: 'string', description: 'Shell command line to execute remotely.' },
        cwd: { type: 'string', description: 'Optional POSIX working directory.' },
        timeoutMs: { type: 'integer', description: 'Timeout in ms (capped at 120000).' },
        maxOutputBytes: { type: 'integer', description: 'Max capture bytes (default 64000).' }
      },
      required: ['command']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverId: { type: 'string' },
          serverLabel: { type: 'string' },
          host: { type: 'string' },
          command: { type: 'string' },
          cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          durationMs: { type: 'integer' },
          timedOut: { type: 'boolean' },
          truncated: { type: 'boolean' }
        }
      },
      render(_args, val) {
        const exitText = val.exitCode !== null ? `exit ${val.exitCode}` : `signal ${val.signal ?? 'unknown'}`
        // `timed_out` and `truncated` are part of the header's grammar, not decoration: the
        // conversation card (client/views/toolCall.ts) parses this one line, and a killed or cut
        // command is otherwise indistinguishable from a clean one — the schema carries both flags
        // but a text-only result would not. They read as words to the model as well.
        const flags = `${val.timedOut ? ' timed_out' : ''}${val.truncated ? ' truncated' : ''}`
        return [
          {
            type: 'text',
            text: `[${val.serverId}] ${exitText} (${val.durationMs}ms)${flags}:\n\`\`\`\n${val.stdout}${val.stderr ? '\n[stderr]\n' + val.stderr : ''}\n\`\`\``
          }
        ]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Remote command was aborted.')
      const input = argsOf('at_terminal_run_remote_command', args)
      requireNonEmptyString('at_terminal_run_remote_command', input, 'command')
      const callCtx = {
        agent: exec?.agent ?? 'default',
        callId: exec?.callId ?? exec?.id,
        signal: exec?.signal
      }
      const run =
        runInContext ??
        ((ctx, fn) => {
          setCurrentCallContext?.(ctx)
          return fn()
        })
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const result = await service.runRemoteCommand({
          ...input,
          signal: exec?.signal
        })
        return {
          serverId: result.serverId,
          serverLabel: result.serverLabel,
          host: result.host,
          command: result.command,
          cwd: result.cwd ?? null,
          exitCode: result.exitCode ?? null,
          signal: result.signal ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: Boolean(result.timedOut),
          truncated: Boolean(result.truncated)
        }
      })
    }
  }
}

export function createSftpListDirectoryTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_sftp_list_directory',
    description:
      'List entries in a remote directory through the selected AT Terminal SFTP session with pagination support.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Remote directory POSIX path.' },
        maxEntries: { type: 'integer', description: 'Optional max entries to return (default 500).' },
        offset: { type: 'integer', description: 'Optional paging offset index (default 0).' }
      },
      required: []
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                type: { type: 'string' },
                size: { type: 'integer' },
                modifiedAt: { type: 'integer' },
                permissions: { oneOf: [{ type: 'integer' }, { type: 'null' }] }
              }
            }
          },
          truncated: { type: 'boolean' },
          offset: { type: 'integer' },
          total: { type: 'integer' }
        }
      },
      render(_args, val) {
        return [
          {
            type: 'text',
            text: `SFTP listing for ${val.path} (${val.entries.length}/${val.total} entries${val.truncated ? ', truncated' : ''}):\n${val.entries.map((e) => `  ${e.type === 'directory' ? 'd' : '-'} ${e.name} (${e.size}B)`).join('\n')}`
          }
        ]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_list_directory', args)
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_c, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpListDirectory(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path,
          entries: (res.entries || []).map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type,
            size: typeof e.size === 'number' ? e.size : 0,
            modifiedAt: typeof e.modifiedAt === 'number' ? e.modifiedAt : 0,
            permissions: e.permissions ?? null
          })),
          truncated: Boolean(res.truncated),
          offset: typeof res.offset === 'number' ? res.offset : 0,
          total: typeof res.total === 'number' ? res.total : 0
        }
      })
    }
  }
}

export function createSftpStatPathTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_sftp_stat_path',
    description:
      'Retrieve file or directory metadata (size, type, permissions, modification time) via AT Terminal SFTP.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Remote POSIX path to inspect.' }
      },
      required: ['path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' },
          type: { type: 'string' },
          size: { type: 'integer' },
          modifiedAt: { type: 'integer' },
          permissions: { oneOf: [{ type: 'integer' }, { type: 'null' }] }
        }
      },
      render(_args, val) {
        return [
          {
            type: 'text',
            text: `Stat ${val.path}: type=${val.type}, size=${val.size}B, modifiedAt=${formatEpochSeconds(val.modifiedAt)}`
          }
        ]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_stat_path', args)
      requireNonEmptyString('at_terminal_sftp_stat_path', input, 'path')
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_c, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpStatPath(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path,
          type: res.type ?? 'file',
          size: typeof res.size === 'number' ? res.size : 0,
          modifiedAt: typeof res.modifiedAt === 'number' ? res.modifiedAt : 0,
          permissions: res.permissions ?? null
        }
      })
    }
  }
}

export function createSftpReadFileTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_sftp_read_file',
    description:
      'Read bounded UTF-8 text from a remote file through AT Terminal SFTP with offset and length limits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Remote POSIX file path.' },
        maxBytes: { type: 'integer', description: 'Max bytes to read (default 65536, max 262144).' },
        offset: { type: 'integer', description: 'Byte offset to start reading from. Negative offsets read from tail.' }
      },
      required: ['path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
          offset: { type: 'integer' },
          size: { type: 'integer' },
          modifiedAt: { type: 'integer' }
        }
      },
      render(_args, val) {
        return [
          {
            type: 'text',
            text: `Read ${val.path} (${val.content.length} chars, total size ${val.size}B${val.truncated ? ', truncated' : ''}):\n\`\`\`\n${val.content}\n\`\`\``
          }
        ]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_read_file', args)
      requireNonEmptyString('at_terminal_sftp_read_file', input, 'path')
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_c, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpReadFile(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path,
          content: res.content,
          truncated: Boolean(res.truncated),
          offset: typeof res.offset === 'number' ? res.offset : 0,
          size: typeof res.size === 'number' ? res.size : 0,
          modifiedAt: typeof res.modifiedAt === 'number' ? res.modifiedAt : 0
        }
      })
    }
  }
}

export function createSftpWriteFileTool({ resolveAgentService, runInContext, setCurrentCallContext } = {}) {
  return {
    name: 'at_terminal_sftp_write_file',
    description:
      'Write UTF-8 text to a remote file after AT Terminal write authorization and confirmation checks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Remote POSIX file path.' },
        content: { type: 'string', description: 'UTF-8 file content to write.' },
        overwrite: { type: 'boolean', description: 'Set true to replace an existing file.' }
      },
      required: ['path', 'content']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' },
          bytesWritten: { type: 'integer' },
          overwritten: { type: 'boolean' }
        }
      },
      render(_args, val) {
        return [
          {
            type: 'text',
            text: `Wrote ${val.bytesWritten} bytes to ${val.path} (overwritten=${val.overwritten})`
          }
        ]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_write_file', args)
      requireNonEmptyString('at_terminal_sftp_write_file', input, 'path')
      if (typeof input.content !== 'string') {
        throw new Error('at_terminal_sftp_write_file: "content" is required and must be a string.')
      }
      const callCtx = {
        agent: exec?.agent ?? 'default',
        callId: exec?.callId ?? exec?.id,
        signal: exec?.signal
      }
      const run =
        runInContext ??
        ((ctx, fn) => {
          setCurrentCallContext?.(ctx)
          return fn()
        })
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpWriteFile(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path,
          bytesWritten: typeof res.bytesWritten === 'number' ? res.bytesWritten : 0,
          overwritten: Boolean(res.overwritten)
        }
      })
    }
  }
}

export function createSftpCreateFileTool({ resolveAgentService, runInContext, setCurrentCallContext } = {}) {
  return {
    name: 'at_terminal_sftp_create_file',
    description:
      'Create an empty or initialized remote file via AT Terminal SFTP with authorization checks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Remote POSIX file path to create.' },
        content: { type: 'string', description: 'Optional initial UTF-8 content.' }
      },
      required: ['path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' }
        }
      },
      render(_args, val) {
        return [{ type: 'text', text: `Created remote file: ${val.path}` }]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_create_file', args)
      requireNonEmptyString('at_terminal_sftp_create_file', input, 'path')
      if (input.content !== undefined && typeof input.content !== 'string') {
        throw new Error('at_terminal_sftp_create_file: "content" must be a string when provided.')
      }
      const callCtx = {
        agent: exec?.agent ?? 'default',
        callId: exec?.callId ?? exec?.id,
        signal: exec?.signal
      }
      const run =
        runInContext ??
        ((ctx, fn) => {
          setCurrentCallContext?.(ctx)
          return fn()
        })
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpCreateFile(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path
        }
      })
    }
  }
}

export function createSftpCreateDirectoryTool({ resolveAgentService, runInContext, setCurrentCallContext } = {}) {
  return {
    name: 'at_terminal_sftp_create_directory',
    description:
      'Create a new remote directory through AT Terminal SFTP after write authorization.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Remote POSIX directory path to create.' }
      },
      required: ['path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' }
        }
      },
      render(_args, val) {
        return [{ type: 'text', text: `Created remote directory: ${val.path}` }]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_create_directory', args)
      requireNonEmptyString('at_terminal_sftp_create_directory', input, 'path')
      const callCtx = {
        agent: exec?.agent ?? 'default',
        callId: exec?.callId ?? exec?.id,
        signal: exec?.signal
      }
      const run =
        runInContext ??
        ((ctx, fn) => {
          setCurrentCallContext?.(ctx)
          return fn()
        })
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpCreateDirectory(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path
        }
      })
    }
  }
}

export function createSftpRenameTool({ resolveAgentService, runInContext, setCurrentCallContext } = {}) {
  return {
    name: 'at_terminal_sftp_rename',
    description:
      'Rename or move a remote file or directory through AT Terminal SFTP with write authorization on both paths.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Source remote POSIX path.' },
        newPath: { type: 'string', description: 'Destination remote POSIX path.' }
      },
      required: ['path', 'newPath']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' },
          newPath: { type: 'string' }
        }
      },
      render(_args, val) {
        return [{ type: 'text', text: `Renamed remote path: ${val.path} -> ${val.newPath}` }]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_rename', args)
      requireNonEmptyString('at_terminal_sftp_rename', input, 'path')
      requireNonEmptyString('at_terminal_sftp_rename', input, 'newPath')
      const callCtx = {
        agent: exec?.agent ?? 'default',
        callId: exec?.callId ?? exec?.id,
        signal: exec?.signal
      }
      const run =
        runInContext ??
        ((ctx, fn) => {
          setCurrentCallContext?.(ctx)
          return fn()
        })
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpRename(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path,
          newPath: res.newPath
        }
      })
    }
  }
}

export function createSftpDeleteTool({ resolveAgentService, runInContext, setCurrentCallContext } = {}) {
  return {
    name: 'at_terminal_sftp_delete',
    description:
      'Delete a single remote file via AT Terminal SFTP. Always requires explicit user confirmation dialog.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...SFTP_TARGET_PROPERTIES,
        path: { type: 'string', description: 'Remote POSIX file path to delete.' }
      },
      required: ['path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          terminalId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          serverId: { type: 'string' },
          path: { type: 'string' },
          deleted: { type: 'boolean' }
        }
      },
      render(_args, val) {
        return [{ type: 'text', text: `Deleted remote file: ${val.path}` }]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_sftp_delete', args)
      requireNonEmptyString('at_terminal_sftp_delete', input, 'path')
      const callCtx = {
        agent: exec?.agent ?? 'default',
        callId: exec?.callId ?? exec?.id,
        signal: exec?.signal
      }
      const run =
        runInContext ??
        ((ctx, fn) => {
          setCurrentCallContext?.(ctx)
          return fn()
        })
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.sftpDelete(input)
        return {
          terminalId: res.terminalId ?? null,
          serverId: res.serverId,
          path: res.path,
          deleted: Boolean(res.deleted)
        }
      })
    }
  }
}

export function createOpenMonitorTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_open_monitor',
    description:
      'Open the AT Terminal monitoring HUD for asset hardware metrics or live agent execution status. Returns opened=false with reason="no-client" when no browser panel is connected, because nothing would appear.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['hardware', 'agent_execution'],
          description: 'Monitor target: "hardware" for CPU/memory/disk/network/processes, "agent_execution" for live commands, audits and SFTP transfers.'
        },
        serverId: {
          type: 'string',
          description: 'SSH server id to monitor (optional; defaults to the active server).'
        },
        mode: {
          type: 'string',
          enum: ['hud'],
          description: 'Display mode. Only "hud" (the global overlay) is implemented; the former "float" option never rendered in this host.'
        }
      },
      required: ['target']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          opened: { type: 'boolean' },
          target: { type: 'string' },
          serverId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          mode: { type: 'string' },
          reason: { oneOf: [{ type: 'string', enum: ['no-client'] }, { type: 'null' }] }
        }
      },
      render(_args, val) {
        return [
          {
            type: 'text',
            text: val.opened
              ? `Opened ${val.target} monitor (${val.mode}) for server: ${val.serverId ?? 'active'}`
              : `Monitor not opened for ${val.target}: no browser panel is connected (reason: ${val.reason ?? 'unknown'}), so nothing would appear.`
          }
        ]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_open_monitor', args)
      requireEnum('at_terminal_open_monitor', input, 'target', ['hardware', 'agent_execution'])
      if (input.mode !== undefined) {
        // Narrowed to `hud` in 0.2.1. The message says so and says what to do, because the
        // model may still be carrying `float` from an earlier prompt.
        requireEnum('at_terminal_open_monitor', input, 'mode', ['hud'])
      }
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_ctx, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        // The service owns the broadcast: it is the one place that knows whether a client is
        // listening. Broadcasting here as well sent every open twice.
        const res = await service.openMonitor({
          target: input.target,
          serverId: input.serverId,
          mode: input.mode
        })
        return {
          opened: Boolean(res.opened),
          target: res.target,
          serverId: res.serverId ?? null,
          mode: res.mode,
          reason: res.reason ?? null
        }
      })
    }
  }
}

export function createGetHardwareMetricsTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_get_hardware_metrics',
    description: 'Retrieve real-time hardware metrics (CPU, memory, disk, network throughput, top processes) for an SSH server.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serverId: {
          type: 'string',
          description: 'Configured AT Terminal SSH server id (optional; defaults to the active server).'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverId: { type: 'string' },
          timestamp: { type: 'integer' },
          cpuUsagePercent: { type: 'number' },
          loadAvg: {
            type: 'array',
            items: { type: 'number' }
          },
          memoryTotalBytes: { type: 'integer' },
          memoryUsedBytes: { type: 'integer' },
          memoryFreeBytes: { type: 'integer' },
          diskMounts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fs: { type: 'string' },
                mount: { type: 'string' },
                totalBytes: { type: 'integer' },
                usedBytes: { type: 'integer' },
                usePercent: { type: 'number' }
              }
            }
          },
          netRxBytesPerSec: { type: 'integer' },
          netTxBytesPerSec: { type: 'integer' },
          mountTotal: { type: 'integer' },
          processTotal: { type: 'integer' },
          topProcesses: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pid: { type: 'integer' },
                user: { type: 'string' },
                cpu: { type: 'number' },
                mem: { type: 'number' },
                command: { type: 'string' }
              }
            }
          }
        }
      },
      render(_args, val) {
        const load = Array.isArray(val.loadAvg) ? val.loadAvg.map((n) => Number(n).toFixed(2)).join(' / ') : 'n/a'
        const mounts = Array.isArray(val.diskMounts) ? val.diskMounts : []
        const processes = Array.isArray(val.topProcesses) ? val.topProcesses : []
        const moreMounts = Number(val.mountTotal) - mounts.length
        const moreProcesses = Number(val.processTotal) - processes.length
        const lines = [
          `Hardware Metrics (${val.serverId}): CPU ${val.cpuUsagePercent}%, Mem ${formatBytes(val.memoryUsedBytes)} / ${formatBytes(val.memoryTotalBytes)} (${formatBytes(val.memoryFreeBytes)} free)`,
          `Load ${load} · Net rx ${formatBytes(val.netRxBytesPerSec)}/s, tx ${formatBytes(val.netTxBytesPerSec)}/s`,
          mounts.length > 0
            ? `Disk: ${mounts.map((m) => `${m.mount} ${m.usePercent}% of ${formatBytes(m.totalBytes)}`).join(', ')}${moreMounts > 0 ? ` (+${moreMounts} more)` : ''}`
            : 'Disk: n/a',
          processes.length > 0
            ? `Top: ${processes.map((p) => `${p.pid} ${p.command} (cpu ${p.cpu}%, mem ${p.mem}%)`).join('; ')}${moreProcesses > 0 ? ` (+${moreProcesses} more)` : ''}`
            : 'Top: n/a'
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_get_hardware_metrics', args)
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_ctx, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.getHardwareMetrics(input.serverId)
        const mounts = (res.disk?.mounts || []).filter(isRelevantMount)
        const processes = res.processes || []
        return {
          serverId: res.serverId,
          timestamp: res.timestamp,
          cpuUsagePercent: res.cpu.usagePercent,
          loadAvg: res.cpu.loadAvg,
          memoryTotalBytes: res.memory.totalBytes,
          memoryUsedBytes: res.memory.usedBytes,
          memoryFreeBytes: res.memory.freeBytes,
          mountTotal: mounts.length,
          diskMounts: mounts.slice(0, HARDWARE_RENDER_LIMIT).map((m) => ({
            fs: m.fs,
            mount: m.mount,
            totalBytes: typeof m.totalBytes === 'number' ? m.totalBytes : 0,
            usedBytes: typeof m.usedBytes === 'number' ? m.usedBytes : 0,
            usePercent: typeof m.usePercent === 'number' ? m.usePercent : 0
          })),
          netRxBytesPerSec: res.network.rxBytesPerSec,
          netTxBytesPerSec: res.network.txBytesPerSec,
          processTotal: processes.length,
          topProcesses: processes.slice(0, HARDWARE_RENDER_LIMIT).map((p) => ({
            pid: p.pid,
            user: p.user,
            cpu: p.cpuPercent,
            mem: p.memPercent,
            command: p.command
          }))
        }
      })
    }
  }
}

export function createGetAgentExecutionStatusTool({ resolveAgentService, runInContext } = {}) {
  return {
    name: 'at_terminal_get_agent_execution_status',
    description: 'Retrieve current agent execution status snapshot, including live running action, recent audit entries, and active SFTP file transfers.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of recent audit records to retrieve (default: 5).'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timestamp: { type: 'integer' },
          hasActiveAction: { type: 'boolean' },
          currentCommand: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          currentStatus: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          activeTransfersCount: { type: 'integer' },
          source: { type: 'string', enum: ['file', 'memory'] },
          recentAudits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                timestamp: { type: 'integer' },
                command: { type: 'string' },
                decision: { type: 'string' },
                riskLevel: { oneOf: [{ type: 'string' }, { type: 'null' }] }
              }
            }
          }
        }
      },
      render(_args, val) {
        return [
          {
            type: 'text',
            text: `Agent Status: ${val.hasActiveAction ? `Running [${val.currentCommand}]` : 'Idle'}, ${val.activeTransfersCount} transfers, ${val.recentAudits.length} recent audits (source: ${val.source})`
          }
        ]
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('Operation was aborted.')
      const input = argsOf('at_terminal_get_agent_execution_status', args)
      const callCtx = { agent: exec?.agent ?? 'default', callId: exec?.callId ?? exec?.id, signal: exec?.signal }
      const run = runInContext ?? ((_ctx, fn) => fn())
      return run(callCtx, async () => {
        const service = resolveAgentService()
        const res = await service.getAgentExecutionStatus(input.limit ?? 5)
        return {
          timestamp: res.timestamp,
          hasActiveAction: Boolean(res.currentAction),
          currentCommand: res.currentAction ? res.currentAction.command : null,
          currentStatus: res.currentAction ? res.currentAction.status : null,
          activeTransfersCount: res.activeTransfers ? res.activeTransfers.length : 0,
          // `file` means the rows came from agent-audit.jsonl and survive a restart;
          // `memory` means the live ring, which is capped and dies with the process.
          source: res.source === 'file' ? 'file' : 'memory',
          recentAudits: (res.recentAudits || []).map((a) => ({
            id: a.id,
            timestamp: a.timestamp,
            command: a.command,
            decision: a.decision,
            riskLevel: a.riskLevel ?? null
          }))
        }
      })
    }
  }
}

/** Every tool this bundle contributes, in registration order. */
export function createTools({
  version,
  config,
  resolveAgentService,
  setCurrentCallContext,
  runWithCallContext,
  now
} = {}) {
  const runInContext = runWithCallContext
    ? (ctx, fn) => runWithCallContext(ctx, fn)
    : (ctx, fn) => {
        setCurrentCallContext?.(ctx)
        return fn()
      }
  const shared = { version, config, resolveAgentService, setCurrentCallContext, runInContext }
  return [
    createPingTool({ version, config, now }),
    createListSshServersTool(shared),
    createGetTerminalContextTool(shared),
    createRunRemoteCommandTool(shared),
    createSftpListDirectoryTool(shared),
    createSftpStatPathTool(shared),
    createSftpReadFileTool(shared),
    createSftpWriteFileTool(shared),
    createSftpCreateFileTool(shared),
    createSftpCreateDirectoryTool(shared),
    createSftpRenameTool(shared),
    createSftpDeleteTool(shared),
    createOpenMonitorTool(shared),
    createGetHardwareMetricsTool(shared),
    createGetAgentExecutionStatusTool(shared)
  ]
}



