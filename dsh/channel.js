/**
 * AT Terminal — Host↔Client channel over `ctx.webServer` (DSH-21).
 *
 * Why HTTP instead of the typed Typert Remote path: this bundle is installed
 * `link:`-ed into the profile and can never import `@deepseek-ai/*` packages
 * (the verify gate fails on any such specifier), while the Typert Remote path
 * requires generated `./typert` artifacts plus `@Remote` decorators from
 * `dsh-typert-protocol`. The documented alternative the plan chose (DSH-17 /
 * DSH-21) is the plain HTTP carrier that ships in the default composition —
 * `ctx.webServer` (dsh-host-webserver): a `node:http` server where plugins
 * register named exact routes and upgrade routes, both returning disposers.
 *
 * ## Routes
 *
 * | method | path                          | purpose                                    |
 * |--------|-------------------------------|--------------------------------------------|
 * | GET    | `/dsh-at-terminal/health`     | JSON probe (version, host, uptime, routes) |
 * | POST   | `/dsh-at-terminal/rpc`        | unary request/response (`{id, method, params}`) |
 * | GET    | `/dsh-at-terminal/events`     | server-push events (SSE, auto-reconnect)   |
 * | GET    | `/dsh-at-terminal/stream`     | byte stream with **native TCP backpressure** (DSH-25 gauge) |
 * | GET    | `/dsh-at-terminal/ws`         | upgrade route: full-duplex WebSocket (terminal + flow control) |
 *
 * ## RPC methods (`POST /dsh-at-terminal/rpc`, body `{id, method, params}`)
 *
 * | method            | purpose                                                   |
 * |-------------------|-----------------------------------------------------------|
 * | `ping`            | liveness                                                  |
 * | `state.get`       | routes, SSE/WS counts, last stream run, client arrivals    |
 * | `client.hello`    | the browser half announcing itself (see `client.status`)   |
 * | `client.status`   | did the browser half ever load?                            |
 * | `stream.last`     | last `/stream` gauge result                                |
 * | `spike.report` / `spike.reports` | client-submitted spike results                 |
 * | `assets.summary`  | servers / passwords / private-key files on disk            |
 * | `assets.export`   | build an asset package (same format as the VS Code variant)|
 * | `assets.import`   | merge an asset package into this instance                  |
 * | `servers.list`    | server records, **redacted**: no password ever crosses      |
 * | `servers.save`    | create or update a record (and its password, write-only)    |
 * | `servers.remove`  | delete a record and its credentials                         |
 * | `terminal.trustHost` | record a host-key fingerprint the user accepted          |
 * | `sftp.list`       | the file tree's state and one directory's entries          |
 * | `sftp.goUp`       | move the tree's root up one level                          |
 * | `sftp.refresh`    | drop cached listings so the next read reaches the server    |
 * | `sftp.readFile`   | one file's **text**, for the panel's viewer and editor      |
 * | `sftp.writeFile`  | replace one file's text (conflict-checked against a stat)   |
 * | `sftp.download`   | one file's **bytes**, base64, on their way to the browser   |
 * | `sftp.upload`     | write bytes the browser holds to one remote path            |
 * | `settings.get`    | the live `sshManager.*` row config (terminal UI settings) |
 * | `channel.info`    | the channel's real loopback address, for a `dsh-app://` page that cannot derive a WebSocket URL |
 *
 * Terminal bytes do **not** travel over `rpc`: they stream over the WebSocket at
 * `/dsh-at-terminal/ws`, which frames them as JSON messages so the same socket can also
 * carry the flow-control `hold`/`ack` pair. See the message table at the upgrade route.
 *
 * Failures come back as `{ok:false, error:{code, message}}` with a 200 status: an RPC
 * that answered is not a transport failure, and the browser half branches on `code`.
 *
 * ## Stream wire contract (shared with the browser client and the node probe)
 *
 * Every chunk carries a 16-byte header so the receiver can verify integrity
 * and continuity without trusting framing:
 *
 * ```
 *           0         1         2         3
 *   offset  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15
 *           |magic 'ATST'|  seq (u32 BE)  |  crc (u32 BE) | payloadBytes (u32 BE) |
 * ```
 *
 * `payload[i] = (seq * 31 + i * 7) & 0xff`, deterministic for both sides.
 * `crc` covers the whole chunk with its own four bytes read as zero — **including the
 * length field**, which is what frames the stream, so a corrupted length cannot pass.
 * `mode=drain` awaits the socket's
 * `drain` event before the next write (true backpressure); `mode=burst`
 * ignores it (the negative control). Host-side write stalls are counted and
 * exposed through `rpc stream.last`.
 */

import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Prefix for every route this channel pins. */
export const PREFIX = '/dsh-at-terminal'

/**
 * Where browser-side failures are appended, so a blank panel leaves a trace.
 *
 * `client.diagnostic` is the only route out of the renderer for a **non-fatal** error: the
 * desktop shell buffers error-level console output and flushes it only into a crash report,
 * and this plugin's failures are not crashes. `$DSH_HOME/at-terminal` is the same directory
 * that already holds this plugin's state (see `storageDir()` in `index.js`), computed here
 * the same way rather than imported, because `channel.js` is a plain-JS bundle that cannot
 * import the module that owns it.
 */
export const CLIENT_DIAGNOSTIC_FILE = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'at-terminal',
  'client-diagnostics.log'
)

export const ROUTES = Object.freeze([
  { kind: 'exact', path: `${PREFIX}/health`, label: 'JSON probe' },
  { kind: 'exact', path: `${PREFIX}/rpc`, label: 'unary RPC' },
  { kind: 'exact', path: `${PREFIX}/events`, label: 'SSE events' },
  { kind: 'exact', path: `${PREFIX}/stream`, label: 'byte stream gauge' },
  { kind: 'upgrade', path: `${PREFIX}/ws`, label: 'WebSocket echo/flow' }
])

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const STREAM_MAGIC = 0x41545354 // 'ATST'
const STREAM_HEADER_BYTES = 16
/**
 * Largest accepted `rpc` body.
 *
 * 384 MiB comfortably covers base64-encoded file transfers up to 256 MiB
 * (256 MiB * 4/3 ~ 341.3 MiB) plus JSON envelope and metadata, while bounding
 * what can be buffered in memory.
 */
export const RPC_MAX_BODY_BYTES = 384 * 1024 * 1024
export const STREAM_PATTERN_A = 31
export const STREAM_PATTERN_B = 7

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE), exported so the spike probe can verify chunks offline. */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** One deterministic stream chunk: header + payload, CRC included. */
export function buildChunk(seq, payloadBytes, chunkSize) {
  const chunk = Buffer.allocUnsafe(STREAM_HEADER_BYTES + payloadBytes)
  chunk.writeUInt32BE(STREAM_MAGIC, 0)
  chunk.writeUInt32BE(seq, 4)
  // The checksum field must be a known zero when the checksum is computed. `allocUnsafe`
  // leaves it uninitialised, so skipping this makes the CRC depend on whatever the
  // allocator handed back — the same chunk would then checksum differently per run, and
  // the receiver could never reproduce it.
  chunk.writeUInt32BE(0, 8)
  for (let i = 0; i < payloadBytes; i += 1) {
    chunk[STREAM_HEADER_BYTES + i] = (seq * STREAM_PATTERN_A + i * STREAM_PATTERN_B) & 0xff
  }
  // Length BEFORE the checksum, so the checksum covers it. Writing it afterwards left
  // bytes 12..15 zero at checksum time, which meant a flipped length field would pass
  // verification — and the length is what the receiver frames with, so an undetected
  // flip desynchronises the stream permanently. "crc covers header + payload" is only
  // true this way round.
  chunk.writeUInt32BE(payloadBytes, 12)
  chunk.writeUInt32BE(crc32(chunk), 8)
  return chunk
}

const noop = () => {}

/* ----------------------------- request trust fence ---------------------------- */

/**
 * Browser-trust fence for the mutating routes, copied from the Harness's own
 * `dsh-client-connection` (`isTrustedApiRequest` / `isSameAuthorityOrigin`, read out of the
 * installed `app.asar`).
 *
 * It defends the two confused-deputy paths a browser opens against a local HTTP API:
 *
 * - **DNS rebinding** — a page on `evil.example` resolves that name to 127.0.0.1, so its
 *   requests reach this server. Its `Host` header still says `evil.example`, and Host is the
 *   one header rebinding cannot forge. Hence the Host check applies to **every** request,
 *   browser-looking or not: over plain HTTP a browser attaches neither `Origin` nor
 *   Fetch-Metadata to a read, so an unmarked request can still be a rebound read.
 * - **Cross-site writes** — a malicious page firing `fetch('http://127.0.0.1:<port>/…')`.
 *   That request carries `Origin: https://evil.example` and/or `Sec-Fetch-Site: cross-site`,
 *   and both are refused.
 *
 * The official page served from `dsh-app://app` reaches the Host over the shell's IPC
 * carrier, which presents a loopback `Host` like any other client — the Harness's own `/api`
 * fence has exactly these rules and its own UI passes them, which is why copying the rules is
 * safer than inventing a special case for the shell. The one deliberate addition: an
 * `Origin` naming the shell's own scheme (`dsh-app:`) is accepted **only** when `Host` is
 * loopback. A web page cannot forge that Origin, so it grants nothing to an attacker, and it
 * keeps the panel working if a future carrier forwards the page's real Origin instead of
 * stripping it.
 *
 * Two escape hatches, both off by default and both noisy:
 *
 * - `AT_TERMINAL_TRUSTED_HOSTS=a:b,c` — extra non-loopback authorities to accept (a LAN
 *   address, a reverse proxy). Same shape as the Harness's `trustedHosts`.
 * - `AT_TERMINAL_TRUST_ANY_ORIGIN=1` — disables the fence entirely. Only for a deployment
 *   that has its own front door; a warning is logged at mount time.
 */

/** Shell-scheme origins: the Desktop page itself, which no web page can claim. */
const SHELL_ORIGIN_SCHEMES = new Set(['dsh-app:', 'dsh:'])

/**
 * Authorities the shell's IPC carrier may present.
 *
 * The panel is served from `dsh-app://app` and its relative `fetch` is bridged by the shell.
 * Whether that bridge rewrites `Host` to the loopback authority (which is what the Harness's
 * own `/api` fence implies, since `/api` accepts only loopback/trusted/bind) or forwards the
 * URL's `app` host is **not something this repository can observe** — there is no devtools
 * port to read the request from. `app` is accepted because it costs nothing: it does not
 * resolve, so it is no DNS-rebinding target, and a page on another origin still fails the
 * Origin check below.
 */
const SHELL_CARRIER_AUTHORITIES = new Set(['app'])

/** One header value as a string, or `undefined`. `req.headers` is lowercased by Node. */
function headerOf(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/** WHATWG URL of a bare authority, or `undefined` when it does not parse. */
function parseAuthority(authority, scheme = 'http:') {
  try {
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

/** `localhost`, `[::1]`, or any `127.x.x.x` literal. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Extra authorities this deployment serves; empty unless configured. */
export function trustedHostAuthorities() {
  return (process.env.AT_TERMINAL_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

/** `true` when the fence is disabled by the explicit escape hatch. */
export function trustAnyOrigin() {
  return process.env.AT_TERMINAL_TRUST_ANY_ORIGIN === '1'
}

/** Hostname-only comparison for a configured authority (`host` or `host:port`). */
function isTrustedAuthority(hostUrl, entries) {
  return entries.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    // A port-less entry matches the hostname on any port; an explicit port must match.
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach a mutating route.
 *
 * @param {Record<string, unknown> | undefined} headers Node's `req.headers`.
 * @returns {boolean}
 */
export function isTrustedRequestHeaders(headers) {
  if (trustAnyOrigin()) return true
  const host = headerOf(headers, 'host')
  // No Host at all is not a browser and not a client this channel serves: HTTP/1.1 requires
  // it, and the shape a proxy or a probe sends without one has no authority to grant.
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const loopback = isLoopbackHostname(hostUrl.hostname)
  const shellCarrier = SHELL_CARRIER_AUTHORITIES.has(hostUrl.hostname)
  if (!loopback && !shellCarrier && !isTrustedAuthority(hostUrl, trustedHostAuthorities())) return false
  if (headerOf(headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(headers, 'origin')
  if (origin === undefined) return true
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  if ((loopback || shellCarrier) && SHELL_ORIGIN_SCHEMES.has(originUrl.protocol)) return true
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
  if (originUrl.protocol === 'https:' && hostUrl.protocol !== 'https:') {
    // The transport may be HTTP behind an HTTPS proxy, so compare under the Origin's scheme
    // — the same normalization the official fence performs.
    const upgraded = parseAuthority(host, 'https:')
    return upgraded !== undefined && originUrl.host === upgraded.host
  }
  return originUrl.host === hostUrl.host
}

/** Default `resolveAssets`: a channel mounted without asset services says exactly that. */
function unavailableAssets() {
  throw Object.assign(new Error('the asset services were not assembled'), {
    code: 'assets-unavailable'
  })
}

/** One message for every missing face: the reason is which resolver threw. */
function serviceUnavailable(what) {
  return () => {
    throw Object.assign(new Error(`the ${what} services were not assembled`), {
      code: 'services-unavailable'
    })
  }
}

const unavailableServers = serviceUnavailable('server')
const unavailableTerminal = serviceUnavailable('terminal')
const unavailableSftp = serviceUnavailable('SFTP')
const unavailableAgent = serviceUnavailable('Agent')

let activeBroadcaster = null

/**
 * Broadcast an SSE event to all connected clients.
 * Used by agent tools or host events to push monitor-control commands.
 */
export function broadcastMonitorEvent(event, data) {
  if (typeof activeBroadcaster === 'function') {
    activeBroadcaster(event, data)
  }
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store'
  })
  res.end(body)
}

/**
 * Mount the channel. Returns a disposer that removes every route, closes the
 * SSE responders and the WebSocket sockets. Every registration is wrapped in
 * the DSH-17 try/catch: a duplicate (kind, path) makes `register()` throw, and
 * that must never kill the plugin activation.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Context with `webServer`
 *   mixed in (callers use `ctx.inject(['webServer'], ...)`).
 * @param {{ version: string, resolveAssets?: () => object, resolveServers?: () => object, resolveTerminal?: () => object, resolveSftp?: () => object, resolveSettings?: () => object }} options
 *   The service resolvers return the faces from `dsh/host.bundle.js`, or throw the
 *   reason they are unusable. They are **functions** rather than the faces themselves
 *   because assembling the platform is asynchronous — the storage domain has to open —
 *   and the channel must be able to mount before that settles. Reading them per call is
 *   what lets the channel come up first and the services arrive afterwards, instead of
 *   either blocking the channel or snapshotting an `undefined` that never updates.
 *   `resolveSettings` reads the live `sshManager.*` row config (synchronous, always
 *   available) so the terminal page can honour the user's font/scrollback/highlight
 *   settings instead of hard-coding defaults.
 * @returns {() => void}
 */
export function registerChannel(ctx, options) {
  const server = ctx.webServer
  const version = options.version
  const resolveAssets = options.resolveAssets ?? unavailableAssets
  const resolveServers = options.resolveServers ?? unavailableServers
  const resolveTerminal = options.resolveTerminal ?? unavailableTerminal
  const resolveSftp = options.resolveSftp ?? unavailableSftp
  const resolveAgent = options.resolveAgent ?? unavailableAgent
  const resolveSettings = options.resolveSettings ?? (() => ({}))
  const startedAt = Date.now()
  const disposers = []
  const sseClients = new Set()

  /**
   * Requests refused by the trust fence since this channel mounted.
   *
   * The counter exists because the fence's failure mode is a **blank panel**: a wrongly
   * rejected request looks exactly like a client that never loaded, and the browser gives the
   * user nothing to read. Exposing the count (with the reason in the log) turns "the panel is
   * empty" into "N requests were refused, here is what they said about themselves".
   */
  let rejected = 0

  if (trustAnyOrigin()) {
    ctx.logger.warn(
      'at-terminal channel: AT_TERMINAL_TRUST_ANY_ORIGIN=1 — the Host/Origin fence is DISABLED; ' +
        'any origin that can reach this port may call it'
    )
  }

  /**
   * Refuse one request, and say why in the log.
   *
   * Only `origin`/`host`/`sec-fetch-site` are logged: the body may carry a password or a
   * private key, and a refusal is not a reason to start recording payloads.
   */
  function rejectRequest(req, res, status, code, message) {
    rejected += 1
    ctx.logger.warn(
      'at-terminal channel: refused %s %s (%s): host=%s origin=%s sec-fetch-site=%s',
      req?.method ?? '?',
      req?.url ?? '?',
      code,
      headerOf(req?.headers, 'host') ?? '(none)',
      headerOf(req?.headers, 'origin') ?? '(none)',
      headerOf(req?.headers, 'sec-fetch-site') ?? '(none)'
    )
    sendJson(res, status, { ok: false, error: { code, message } })
  }

  function broadcastSse(event, data) {    if (sseClients.size === 0) return
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      if (res.destroyed) {
        sseClients.delete(res)
        continue
      }
      try {
        res.write(payload)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  activeBroadcaster = broadcastSse
  disposers.push(() => {
    if (activeBroadcaster === broadcastSse) activeBroadcaster = null
  })

  /** @type {Map<import('node:net').Socket, {pending: Buffer, alive: boolean}>} */
  const wsSockets = new Map()
  let wsSequence = 0
  let eventSequence = 0

  /** Latest stream gauge run, recorded by the `/stream` route. */
  let lastStream = null
  /** Ring of spike reports submitted by clients through `rpc spike.report`. */
  const spikeReports = []
  /**
   * Ring of client-half arrivals, recorded by `rpc client.hello`.
   *
   * The browser half is the one part of this bundle that cannot be observed from
   * outside the shell: the Desktop app delivers client bundles over its own IPC
   * carrier rather than over `/plugins` on this server, and it is not started with a
   * devtools port, so there is no way to read the page's module graph. Without this
   * record, "the tab is not on screen" and "the client half never ran" look identical
   * from here — which is exactly the ambiguity that made the first attempt to see the
   * sidebar tab inconclusive.
   */
  const clientHellos = []

  /**
   * Register one route, absorbing the failure the real server raises on a duplicate
   * (kind, path) — DSH-17: a second mount must not take plugin activation down with it.
   *
   * Absorbing is not the same as ignoring, so the failure is logged. A channel that
   * registered nothing would otherwise be indistinguishable from one that registered
   * everything, which is what lets a misconfigured route survive a whole session
   * unnoticed. Defined here rather than at module scope because the logger lives on
   * `ctx`.
   */
  function tryRegister(register) {
    try {
      return register()
    } catch (error) {
      ctx.logger.warn(
        'at-terminal channel: a route did not register: %s',
        error?.message ?? String(error)
      )
      return noop
    }
  }

  const methods = {
    ping(_params) {
      return {
        pong: true,
        version,
        hostApp: process.env.AT_SERIES_HOST_APP ?? null,
        ts: Date.now()
      }
    },
    'state.get'() {
      return {
        version,
        uptimeMs: Date.now() - startedAt,
        routes: ROUTES.map((route) => route.path),
        wsSockets: wsSockets.size,
        sseClients: sseClients.size,
        stream: lastStream,
        // Requests the trust fence refused; see `rejected` above.
        rejected,
        // Did the browser half ever run? See `clientHellos`.
        clientHellos: clientHellos.length,
        lastClientHello: clientHellos.at(-1) ?? null
      }
    },
    /**
     * Record one client-half arrival. Params are whatever the browser is willing to
     * report about itself; nothing here is trusted, it is only recorded, because the
     * question it answers ("did the client half load at all?") needs no trust.
     */
    /**
     * Append a client-side failure to a file the user can actually hand over.
     *
     * ## Why this exists
     *
     * A blank panel is a **renderer** failure, and the desktop shell only writes a crash
     * report when something is *fatal*:
     * ```js
     * window.webContents.on("console-message", (details) => {
     *   if (details.level !== "error") return
     *   rendererConsole.push(...)      // buffered…
     * });                              // …and flushed only by reportFatal
     * ```
     * A body that throws during render is not fatal — React tears down that subtree, the
     * window stays up, and the buffer is discarded. So the one error that matters is the one
     * the log file cannot hold.
     *
     * The browser also cannot be asked for its console: the built-in toggles are off unless
     * the desktop app is launched with developer tools enabled, so `webContents.openDevTools`
     * is reachable only from a debugger.
     *
     * Hence the browser half posts here instead, and this appends to
     * `<DSH_HOME>/at-terminal/client-diagnostics.log` — the same directory that already
     * holds this plugin's state, so there is nowhere new for a user to look.
     *
     * Nothing here is trusted and nothing here may throw: a diagnostic that breaks the Host
     * would replace a blank panel with a dead one. Every field is coerced and truncated, and
     * the whole body is wrapped.
     */
    'client.diagnostic'(params = {}) {
      const clip = (value, max) => {
        try {
          if (typeof value === 'string') return value.slice(0, max)
          if (value === undefined) return null
          return JSON.stringify(value).slice(0, max)
        } catch {
          return '(unserialisable)'
        }
      }
      const entry = {
        at: new Date().toISOString(),
        level: clip(params.level, 20),
        message: clip(params.message, 4000),
        source: clip(params.source, 500),
        line: typeof params.line === 'number' ? params.line : null,
        stack: clip(params.stack, 8000)
      }
      try {
        const line = `${JSON.stringify(entry)}\n`
        if (entry.level === 'error') {
          ctx.logger.error('at-terminal client diagnostic: %s', entry.message ?? '(no message)')
        } else {
          ctx.logger.info('at-terminal client diagnostic: %s', entry.message ?? '(no message)')
        }
        // Asynchronous non-blocking file append to keep Node main loop free
        appendFile(CLIENT_DIAGNOSTIC_FILE, line, { encoding: 'utf8' }).catch(() => undefined)
        return { recorded: true, file: CLIENT_DIAGNOSTIC_FILE }
      } catch (error) {
        ctx.logger.error('at-terminal: could not record client diagnostic: %s', error?.message)
        return { recorded: false }
      }
    },
    'client.hello'(params = {}) {
      const text = (value) => (typeof value === 'string' ? value.slice(0, 300) : null)
      const entry = {
        at: Date.now(),
        origin: text(params.origin),
        href: text(params.href),
        userAgent: text(params.userAgent),
        kind: text(params.kind)
      }
      clientHellos.push(entry)
      if (clientHellos.length > 8) clientHellos.shift()
      ctx.logger.info(
        'at-terminal client half checked in: origin=%s kind=%s',
        entry.origin ?? '(unknown)',
        entry.kind ?? '(unknown)'
      )
      return { recorded: true, count: clientHellos.length }
    },
    'client.status'() {
      return {
        count: clientHellos.length,
        last: clientHellos.at(-1) ?? null,
        // A client that has announced itself but never completed a stream run is a
        // different state from one that has never been seen, and worth telling apart.
        streamRuns: lastStream === null ? 0 : 1
      }
    },
    'stream.last'() {
      return lastStream
    },
    'spike.report'({ report } = {}) {
      if (report === undefined || typeof report !== 'object') throw Object.assign(new Error('spike.report needs { report }'), { code: 'bad-params' })
      const entry = { at: Date.now(), report }
      spikeReports.push(entry)
      if (spikeReports.length > 8) spikeReports.shift()
      ctx.logger.info('at-terminal spike report stored: %s bytes in %sms (%s mode)', report.bytes ?? '?', report.wallMs ?? '?', report.mode ?? '?')
      return { stored: true, count: spikeReports.length }
    },
    'spike.reports'() {
      return spikeReports
    },

    /* ------------------------------ assets (M3) ------------------------------ */

    /**
     * The asset face, or a failure that says why it is absent.
     *
     * Throwing here rather than returning an empty summary matters: "0 servers" and "the
     * store could not be opened" look identical to a user otherwise, and the second is
     * both the more likely state on a fresh install and the one they can act on.
     */
    'assets.summary'() {
      return requireAssets().summary()
    },

    /**
     * Produce an asset package.
     *
     * The returned envelope is the complete file content — the browser half writes it out
     * verbatim, so the format is the one `src/assets/**` defines, unchanged from the VS
     * Code variant, and a package exported here imports there and vice versa.
     */
    'assets.export'(params = {}) {
      return requireAssets().export({
        includePasswords: params.includePasswords === true,
        includePrivateKeys: params.includePrivateKeys === true,
        packagePassword: params.packagePassword
      })
    },

    /** Merge an asset package into this instance's storage. */
    'assets.import'(params = {}) {
      return requireAssets().importPackage({
        envelope: params.envelope,
        packagePassword: params.packagePassword,
        strategy: params.strategy
      })
    },

    /* ------------------------------ servers (M3) ------------------------------ */

    'servers.list'() {
      return resolveServers().list()
    },

    'servers.save'(params = {}) {
      return resolveServers().save(params.server ?? params)
    },

    'servers.remove'(params = {}) {
      return resolveServers().remove(params.id)
    },

    /* ------------------------------ terminal (M4) ----------------------------- */

    /**
     * Accept a host key the user has just been shown.
     *
     * Trust is a request/response action rather than a stream message because it is a
     * decision, not a byte. The connect that follows is a fresh `terminal.open`, so a
     * failed verification leaves nothing half-open.
     */
    'terminal.trustHost'(params = {}) {
      // `host`/`port` travel when the refusal named them: with a jump host they are the
      // jump host's, and the service needs them to record the acceptance against the host
      // whose key was actually refused rather than against the server the user picked.
      return resolveTerminal().trustHost({
        serverId: params.serverId,
        fingerprint: params.fingerprint,
        host: params.host,
        port: params.port
      })
    },

    /**
     * Drop a stored key so the next connect asks again.
     *
     * The VS Code variant has had this all along (`sshManager.forgetHostKey`, and the
     * "Forget and Reconnect" choice in its host-key-changed prompt). Without it here, an
     * entry that some earlier build wrote under the wrong address can only be cleared by
     * trusting whatever fingerprint shows up next — asking the user to accept a key they
     * have no way to check. `host`/`port` are bounded to the server's own jump chain
     * inside the service, exactly as for `trustHost`.
     */
    'terminal.forgetHost'(params = {}) {
      return resolveTerminal().forgetHost({
        serverId: params.serverId,
        host: params.host,
        port: params.port
      })
    },

    /* -------------------------------- sftp (M3) ------------------------------- */

    /**
     * The file tree's one read: state plus listing.
     *
     * No `path` reports the tree's root — the only read that works without a live
     * connection, because a disconnected tree still shows what it last saw. A path below
     * the root needs a live SSH terminal, and the failure says so by code rather than by
     * returning an empty list: "this directory is empty" and "this directory cannot be
     * read" must not render the same.
     *
     * Note this is a **separate SSH connection** from the terminal's, exactly as in the
     * VS Code variant — `SftpManager` opens its own session per terminal.
     *
     * `terminalId` is the browser's own id for the terminal it means, learned from the
     * `terminal.opened` frame on its socket. It is threaded through because these reads
     * arrive over HTTP: nothing else in the request says which tab is asking, so with more
     * than one terminal open the Host cannot tell whose directory to answer with.
     */
    'sftp.list'(params = {}) {
      return requireSftp().list({ path: params.path, terminalId: params.terminalId })
    },

    /** Move the tree's root up one level (`..`). Needs a live terminal. */
    'sftp.goUp'(params = {}) {
      return requireSftp().goUp({ terminalId: params.terminalId })
    },

    /**
     * Drop every cached listing, so the next read reaches the server instead of the
     * 20-second TTL cache. Cache-only on purpose: a refresh is not a connection attempt.
     */
    'sftp.refresh'(params = {}) {
      return requireSftp().refresh({ terminalId: params.terminalId })
    },

    /**
     * One file's text, for the panel's viewer and editor.
     *
     * A separate method from `sftp.download` on purpose, and not a flag on it: the two
     * answer different questions. This one refuses a binary file (its bytes would decode
     * into replacement characters, and a save would write those back), and reports
     * `truncated` so a viewer may show a cut file while an editor must decline to. A
     * download has no such scruples — it moves bytes as bytes.
     */
    'sftp.readFile'(params = {}) {
      return requireSftp().readFile({
        path: params.path,
        terminalId: params.terminalId,
        maxBytes: params.maxBytes
      })
    },

    /**
     * Replace one file's text.
     *
     * `expectedSize` / `expectedModifiedAt` are what the editor read at open time; the Host
     * refuses the write with `sftp-conflict` when the server disagrees, unless `overwrite`
     * is set. That check lives on the Host deliberately — a browser that skipped it would
     * still be lying about what it saved, while a Host that skipped it would be destroying
     * someone else's edit.
     */
    'sftp.writeFile'(params = {}) {
      return requireSftp().writeFile({
        path: params.path,
        text: params.text,
        eol: params.eol,
        terminalId: params.terminalId,
        expectedSize: params.expectedSize,
        expectedModifiedAt: params.expectedModifiedAt,
        overwrite: params.overwrite
      })
    },

    /** One file's bytes, base64, for the browser to save to disk. */
    'sftp.download'(params = {}) {
      return requireSftp().download({ path: params.path, terminalId: params.terminalId })
    },

    /** Write a browser-held file to one remote path; an existing one needs `overwrite`. */
    'sftp.upload'(params = {}) {
      return requireSftp().upload({
        path: params.path,
        base64: params.base64,
        terminalId: params.terminalId,
        overwrite: params.overwrite
      })
    },

    /** Create an empty file at one remote path. */
    'sftp.createFile'(params = {}) {
      return requireSftp().createFile({
        path: params.path,
        terminalId: params.terminalId
      })
    },

    /** Delete a file or directory at one remote path. */
    'sftp.delete'(params = {}) {
      return requireSftp().delete({
        path: params.path,
        terminalId: params.terminalId
      })
    },

    /* ------------------------------ settings (M4) ----------------------------- */

    /**
     * The live `sshManager.*` settings — the same eight fields the readiness probe
     * reports. The terminal page reads font size/family, scrollback, semantic
     * highlight and zebra stripes from here (DSH-31), so a settings edit shows up on
     * the next connect instead of being frozen at build time. Synchronous and always
     * available: it reads the row config, not the platform services.
     */
    'settings.get'() {
      return resolveSettings()
    },

    /* --------------------------- channel self-description ---------------------- */

    /**
     * The channel's own reachable address, so a browser half that cannot derive one
     * can still open the terminal WebSocket.
     *
     * The Desktop shell serves this panel from `dsh-app://app`: relative `fetch` is
     * carried over an IPC bridge (which is why the RPC-driven lists work), but a
     * `WebSocket` needs a real network address and `location.host` there is `app` —
     * a name nothing can connect to. Only the Host knows the port it actually
     * listened on (`webServer.port`; `0` asks the OS to choose one), so the client
     * asks here instead of guessing. The loopback literal is deliberate: this answer
     * serves the same-machine Desktop page; a LAN browser reaches the panel over
     * http(s), where the client uses the page's own origin and never calls this.
     */
    'channel.info'() {
      const port = Number.isFinite(server.port) ? server.port : null
      return {
        host: '127.0.0.1',
        port,
        wsUrl: port === null ? null : `ws://127.0.0.1:${port}${PREFIX}/ws`,
        rpcUrl: port === null ? null : `http://127.0.0.1:${port}${PREFIX}/rpc`
      }
    },

    /* ----------------------------- monitor (Phase 0/1) -------------------------- */
    async 'monitor.metrics.get'(params = {}) {
      const agent = requireAgent()
      return await agent.getHardwareMetrics(params.serverId)
    },

    async 'monitor.agent.get'(params = {}) {
      const agent = requireAgent()
      return await agent.getAgentExecutionStatus(params.limit)
    },

    async 'monitor.control'(params = {}) {
      try {
        const agent = requireAgent()
        return await agent.openMonitor(params)
      } catch {
        broadcastSse('monitor-control', {
          action: params.action ?? 'open',
          target: params.target ?? 'hardware',
          serverId: params.serverId,
          mode: params.mode ?? 'float'
        })
        return { ok: true }
      }
    }
  }

  /** Resolve the asset face, letting its own error describe why it is unusable. */
  function requireAssets() {
    return resolveAssets()
  }

  /** Resolve the SFTP face the same way — its own error names what is missing. */
  function requireSftp() {
    return resolveSftp()
  }

  /** Resolve the Agent service face. */
  function requireAgent() {
    return resolveAgent()
  }

  /* ------------------------------- exact: health ------------------------------ */

  disposers.push(
    tryRegister(() =>
      server.register({
        kind: 'exact',
        path: `${PREFIX}/health`,
        handler(_req, res) {
          sendJson(res, 200, {
            ok: true,
            service: 'at-terminal-channel',
            version,
            hostApp: process.env.AT_SERIES_HOST_APP ?? null,
            uptimeMs: Date.now() - startedAt,
            routes: ROUTES.map((route) => route.path)
          })
        }
      })
    )
  )

  /* --------------------------------- exact: rpc -------------------------------- */

  disposers.push(
    tryRegister(() =>
      server.register({
        kind: 'exact',
        path: `${PREFIX}/rpc`,
        handler(req, res) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
            return
          }
          if (!isTrustedRequestHeaders(req.headers)) {
            rejectRequest(req, res, 403, 'forbidden', 'request failed the Host/Origin fence')
            return
          }
          // A form post, an `img` request or a `text/plain` "simple request" cannot produce
          // this content type without a CORS preflight, which the fence would already have
          // refused — so requiring it closes the CSRF shape that needs no preflight at all.
          const contentType = headerOf(req.headers, 'content-type') ?? ''
          if (!/^application\/json\b/i.test(contentType)) {
            rejectRequest(req, res, 415, 'unsupported-media-type', 'content-type must be application/json')
            return
          }
          const chunks = []
          let size = 0
          let tooLarge = false
          req.on('data', (chunk) => {
            if (tooLarge) return
            size += chunk.length
            if (size > RPC_MAX_BODY_BYTES) {
              // Answer before tearing the socket down: a silent reset leaves the caller
              // with a transport error where the useful fact is the limit it exceeded.
              tooLarge = true
              sendJson(res, 413, {
                ok: false,
                error: {
                  code: 'body-too-large',
                  message: `request body exceeds ${RPC_MAX_BODY_BYTES} bytes`
                }
              })
              req.destroy()
              return
            }
            chunks.push(chunk)
          })
          req.on('end', () => {
            if (tooLarge) return
            let body
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              sendJson(res, 400, { ok: false, error: { code: 'bad-json', message: 'body must be JSON' } })
              return
            }
            const id = body?.id
            const method = body?.method
            const params = body?.params
            const handler = methods[method]
            if (typeof handler !== 'function') {
              sendJson(res, 200, { id: id ?? null, ok: false, error: { code: 'no-such-method', message: `unknown method: ${method}` } })
              return
            }
            // Handlers may be asynchronous — the asset methods read storage, run scrypt
            // and write private keys — so the reply is awaited rather than assumed to be
            // a plain value. A synchronous throw lands in the same catch either way.
            Promise.resolve()
              .then(() => handler(params))
              .then((result) => sendJson(res, 200, { id: id ?? null, ok: true, result }))
              .catch((error) =>
                sendJson(res, 200, {
                  id: id ?? null,
                  ok: false,
                  error: {
                    // `code` is what the browser half branches on; a handler that sets one
                    // (wrong-password, unreadable-package, assets-unavailable, bad-params)
                    // is telling the user something a generic message would destroy.
                    code: error?.code ?? 'method-error',
                    message: error?.message ?? String(error),
                    // Carried only when the failure has one. A refused host key is the case
                    // that needs it: the terminal path pushes the fingerprint down its event
                    // stream, and the SFTP path has no stream — without this the refusal
                    // would reach the user as an actionable-looking code with nothing to act
                    // on.
                    ...(typeof error?.fingerprint === 'string' && error.fingerprint !== ''
                      ? { fingerprint: error.fingerprint }
                      : {})
                  }
                })
              )
          })
          req.on('error', noop)
        }
      })
    )
  )

  /* -------------------------------- exact: events ------------------------------ */

  disposers.push(
    tryRegister(() =>
      server.register({
        kind: 'exact',
        path: `${PREFIX}/events`,
        handler(req, res) {
          if (!isTrustedRequestHeaders(req?.headers)) {
            rejectRequest(req, res, 403, 'forbidden', 'request failed the Host/Origin fence')
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
          })
          res.write('retry: 1500\n\n')
          res.write(`event: hello\ndata: ${JSON.stringify({ service: 'at-terminal-channel', version, ts: Date.now() })}\n\n`)
          sseClients.add(res)
          res.on('close', () => sseClients.delete(res))
          res.on('error', () => sseClients.delete(res))
        }
      })
    )
  )

  const eventHeartbeat = setInterval(() => {
    if (sseClients.size === 0) return
    const payload = `event: tick\ndata: ${JSON.stringify({ seq: (eventSequence += 1), ts: Date.now() })}\n\n`
    for (const res of sseClients) {
      if (res.destroyed) {
        sseClients.delete(res)
        continue
      }
      res.write(payload)
    }
  }, 5000)
  disposers.push(() => clearInterval(eventHeartbeat))

  /* -------------------------------- exact: stream ------------------------------ */

  disposers.push(
    tryRegister(() =>
      server.register({
        kind: 'exact',
        path: `${PREFIX}/stream`,
        handler(req, res) {
          const url = new URL(req.url ?? '', 'http://localhost')
          // 64 MiB, down from 512: this route is a throughput gauge for the spike probe, not
          // a product surface, and a fixture that can pull half a gigabyte through the Host's
          // event loop is a liability that buys nothing.
          const bytes = Math.max(0, Math.min(64 * 1024 * 1024, Number(url.searchParams.get('bytes') ?? 10 * 1024 * 1024)))
          const chunkBytes = Math.max(1024, Math.min(4 * 1024 * 1024, Number(url.searchParams.get('chunk') ?? 64 * 1024)))
          const mode = url.searchParams.get('mode') === 'drain' ? 'drain' : 'burst'
          const totalChunks = Math.ceil(bytes / chunkBytes)

          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
            'x-at-series-version': version,
            'x-at-series-mode': mode,
            'x-at-series-total': String(totalChunks),
            'x-at-series-bytes': String(bytes)
          })

          const started = Date.now()
          let written = 0
          let drains = 0
          let chunksSent = 0
          let aborted = false
          res.on('close', () => {
            aborted = true
          })

          const run = async () => {
            while (chunksSent < totalChunks && !aborted) {
              const payloadBytes = Math.min(chunkBytes, bytes - chunksSent * chunkBytes)
              const chunk = buildChunk(chunksSent, payloadBytes, chunkBytes)
              if (mode === 'drain' && !res.write(chunk)) {
                // True backpressure: wait until the socket accepts more bytes.
                // This is the pause the echo-terminal gauge is measuring.
                drains += 1
                await new Promise((resolve) => res.once('drain', resolve))
              } else {
                res.write(chunk)
              }
              written += chunk.length
              chunksSent += 1
            }
            if (!aborted) {
              res.end()
              lastStream = { mode, bytes, chunks: totalChunks, wallMs: Date.now() - started, drains }
            }
          }
          run().catch((error) => {
            ctx.logger.warn('at-terminal stream aborted: %s', error?.message ?? error)
            if (!res.destroyed) res.destroy()
          })
        }
      })
    )
  )

  /* ------------------------------ upgrade: websocket --------------------------- */

  disposers.push(
    tryRegister(() =>
      server.registerUpgrade({
        kind: 'exact',
        path: `${PREFIX}/ws`,
        handler(req, socket) {
          // An upgrade has no response object, so a refusal is a hand-written 403 and a
          // closed socket. The terminal WebSocket is the one route that carries keystrokes
          // and remote output, so a page that may not talk to it must be told nothing else.
          if (!isTrustedRequestHeaders(req?.headers)) {
            rejected += 1
            ctx.logger.warn(
              'at-terminal channel: refused WS upgrade (%s): host=%s origin=%s sec-fetch-site=%s',
              'forbidden',
              headerOf(req?.headers, 'host') ?? '(none)',
              headerOf(req?.headers, 'origin') ?? '(none)',
              headerOf(req?.headers, 'sec-fetch-site') ?? '(none)'
            )
            try {
              socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            } catch {
              // peer already gone
            }
            socket.destroy()
            return
          }
          const key = req.headers['sec-websocket-key']
          if (typeof key !== 'string') {
            socket.destroy()
            return
          }
          const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
          )
          const session = { pending: Buffer.alloc(0), alive: true, holding: false, heldCount: 0, holdGate: undefined, ackGate: undefined, ackWatchdog: undefined }
          wsSockets.set(socket, session)
          wsSequence += 1
          const sessionSeq = wsSequence
          session.alive = true
          const releaseGates = () => {
            session.alive = false
            if (session.holdGate !== undefined) {
              const gate = session.holdGate
              session.holdGate = undefined
              gate()
            }
            if (session.ackGate !== undefined) {
              const gate = session.ackGate
              session.ackGate = undefined
              clearTimeout(session.ackWatchdog)
              gate()
            }
          }
          socket.on('data', (data) =>
            onWsData(
              ctx,
              socket,
              session,
              data,
              (message) => dispatchWsMessage(ctx, socket, session, sessionSeq, message, { resolveTerminal }),
              () => {}
            )
          )
          socket.on('error', () => {
            releaseGates()
            closeTerminals(session)
            wsSockets.delete(socket)
          })
          socket.on('close', () => {
            releaseGates()
            closeTerminals(session)
            wsSockets.delete(socket)
          })
          sendWsFrame(socket, 1, JSON.stringify({ type: 'hello', seq: sessionSeq, version, ts: Date.now() }))
        }
      })
    )
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // route already removed by an earlier disposer
      }
    }
    for (const res of sseClients) {
      try {
        res.end()
      } catch {
        // already closed
      }
    }
    sseClients.clear()
    for (const socket of wsSockets.keys()) {
      try {
        socket.destroy()
      } catch {
        // already closed
      }
    }
    wsSockets.clear()
  }
}

/* --------------------------- websocket frame plumbing -------------------------- */

function sendWsFrame(socket, opcode, payloadString) {
  const payload = Buffer.from(payloadString, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

function sendWsJson(socket, message) {
  sendWsFrame(socket, 1, JSON.stringify(message))
}

/**
 * Incremental RFC 6455 parser: accumulates raw bytes, emits one parsed text
 * frame per call into `dispatch`. Frames may split across `data` events and
 * several frames may arrive in one event; control frames (ping/pong/close) are
 * answered inline. Binary frames are decoded and forwarded to `dispatchBinary`.
 */
function onWsData(_ctx, socket, session, data, dispatchText, dispatchBinary) {
  session.pending = Buffer.concat([session.pending, data])
  while (session.pending.length >= 2) {
    const first = session.pending[0]
    const second = session.pending[1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (session.pending.length < offset + 2) break
      length = session.pending.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (session.pending.length < offset + 8) break
      const big = session.pending.readBigUInt64BE(offset)
      if (big > 64 * 1024 * 1024) {
        session.alive = false
        socket.destroy()
        return
      }
      length = Number(big)
      offset += 8
    }
    const maskKey = masked ? session.pending.subarray(offset, offset + 4) : null
    if (maskKey !== null) offset += 4
    if (session.pending.length < offset + length) break
    let payload = session.pending.subarray(offset, offset + length)
    session.pending = session.pending.subarray(offset + length)
    if (maskKey !== null) {
      const unmasked = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i & 3]
      payload = unmasked
    }

    if (opcode === 0x9) {
      if (fin) sendWsFrame(socket, 0xa, payload.toString('utf8')) // ping → pong
      continue
    }
    if (opcode === 0xa) continue // pong: peer alive
    if (opcode === 0x8) {
      if (fin) {
        sendWsFrame(socket, 0x8, '\u0003\xe8')
        socket.end()
      }
      continue
    }
    if (opcode === 0x1 && fin) {
      dispatchText(payload.toString('utf8'))
      continue
    }
    if (opcode === 0x2 && fin) {
      dispatchBinary(payload)
      continue
    }
    // continuation frames and fragments: not used by this protocol
  }
}

/**
 * Echo-terminal protocol (also the flow-control gauge for DSH-25):
 *
 * - `{type:'echo', text}`   → answered `{type:'echo', seq, ts, text}` with the
 *   session's monotonic seq (round-trip time is measured by the client).
 * - `{type:'hold', on}`     → the binary spike loop suspends (counted) until
 *   `{type:'hold', on:false}`; the release carries the number of frames the
 *   hold skipped. This is the pause/resume semantics DSH-28 will apply.
 * - `{type:'spike', bytes, chunk, ackEvery}` → binary push with the same ATST
 *   layout as `/stream`; every `ackEvery` frames the host waits for
 *   `{type:'ack', seq}` — application-level flow control with a watchdog.
 * - `{type:'bye'}`          → server closes the socket.
 */
/**
 * Terminal messages on the same socket as the flow-control pair.
 *
 * `terminal.*` is the only place the wire carries remote output, and it carries it as
 * **base64**: a PTY stream is arbitrary bytes, and a JSON string would corrupt anything
 * that is not valid UTF-8 on its own — a split multi-byte sequence being the obvious
 * case. Keystrokes travel the other way as plain text, because a keyboard always produces
 * a JavaScript string.
 *
 * `terminal.pause` is what lets the terminal survive `yes`: it calls through to the SSH
 * session's own `pauseOutput`/`resumeOutput`, so a renderer that cannot keep up applies
 * real backpressure to the remote host instead of silently losing bytes.
 */
function handleTerminalMessage(ctx, socket, session, sessionSeq, message, env) {
  const id = typeof message.id === 'string' && message.id.length > 0 ? message.id : 'default'
  if (session.terminals === undefined) session.terminals = new Map()

  const fail = (code, error) =>
    sendWsJson(socket, { type: 'terminal.error', id, seq: sessionSeq, code, message: error?.message ?? String(error) })

  if (message.type === 'terminal.open') {
    if (session.terminals.has(id)) {
      fail('already-open', 'a terminal with this id is already open on this socket')
      return
    }
    let api
    try {
      api = env.resolveTerminal()
    } catch (error) {
      fail(error?.code ?? 'services-unavailable', error)
      return
    }
    // A failure the service already reported through `emit` must not be followed by a
    // second, generic frame. The host-key refusal is the case that matters: the panel
    // keeps the **last** error it receives, so a trailing `connect-failed` replaced the
    // coded refusal and took its fingerprint with it — leaving the user staring at
    // "Host denied (verification failed)" with no way to accept the key.
    let reportedCodedError = false
    const emit = (event) => {
      // The namespace is added here, not by the service: the generic frames on this socket
      // already use `error`, so a bare terminal `error` would be indistinguishable from a
      // protocol-level one. Prefixing keeps both readable off one socket.
      // The socket can go away mid-connect; dropping is correct here because the close
      // handler disposes the session either way.
      if (socket.destroyed) return
      if (event.type === 'error') reportedCodedError = true
      sendWsJson(socket, { ...event, type: `terminal.${event.type}`, id, seq: sessionSeq })
    }
    // Placeholder so a second `terminal.open` with the same id cannot race this one.
    session.terminals.set(id, { opening: true })
    api
      .open({ serverId: message.serverId, rows: message.rows, cols: message.cols, emit })
      .then((terminal) => {
        const existing = session.terminals.get(id)
        if (existing === undefined || socket.destroyed) {
          terminal.close()
          return
        }
        session.terminals.set(id, terminal)
        // `terminalId` is the Host's own id for this session, not the browser's per-socket
        // `id`. The browser needs it because the file tree is read over HTTP, which cannot
        // tell which tab is asking — so two tabs' trees stay separate only if the caller can
        // name the terminal it means.
        sendWsJson(socket, { type: 'terminal.opened', id, terminalId: terminal.terminalId, seq: sessionSeq })
      })
      .catch((error) => {
        session.terminals.delete(id)
        if (reportedCodedError) {
          // One root failure, one frame — the informative one. Logged, not sent.
          ctx.logger.info(
            'at-terminal terminal open failed after a coded report (%s): %s',
            error?.code ?? 'connect-failed',
            error?.message ?? error
          )
          return
        }
        fail(error?.code ?? 'connect-failed', error)
      })
    return
  }

  const terminal = session.terminals.get(id)
  if (terminal === undefined) {
    fail('no-such-terminal', `no terminal "${id}" is open on this socket`)
    return
  }
  if (terminal.opening === true) {
    // Lifecycle frames while `open` is in flight are an expected race, not a
    // protocol violation: the WebSocket is asynchronous and the browser-side
    // terminal reports its fitted size the moment the pane becomes visible —
    // which is while the SSH connect is still running. The `open` frame already
    // carried the initial rows/cols and the client re-reports after
    // `terminal.opened`, so dropping resize/input/pause here loses nothing.
    // Answering with an error instead is what a user's first connect surfaced:
    // a spurious `no-such-terminal` banner over a healthy connection.
    if (message.type === 'terminal.close') {
      // Cancel: removing the placeholder makes the open resolver dispose the
      // session as soon as the connect settles (it re-checks the entry).
      session.terminals.delete(id)
    }
    return
  }

  if (message.type === 'terminal.input') {
    if (typeof message.data === 'string') terminal.write(message.data)
    return
  }
  if (message.type === 'terminal.resize') {
    terminal.resize(Number(message.rows), Number(message.cols))
    return
  }
  if (message.type === 'terminal.pause') {
    terminal.setPaused(message.paused === true)
    return
  }
  if (message.type === 'terminal.close') {
    session.terminals.delete(id)
    terminal.close()
    return
  }
  fail('unknown-message', `unknown terminal message: ${String(message.type)}`)
}

/** Dispose every terminal a socket opened. Called from its close and error handlers. */
function closeTerminals(session) {
  if (session.terminals === undefined) return
  for (const terminal of session.terminals.values()) {
    try {
      if (terminal.opening !== true) terminal.close()
    } catch {
      // already gone
    }
  }
  session.terminals.clear()
}

function dispatchWsMessage(ctx, socket, session, sessionSeq, text, env) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    sendWsJson(socket, { type: 'error', seq: sessionSeq, message: 'frames must be JSON' })
    return
  }
  if (typeof message?.type === 'string' && message.type.startsWith('terminal.')) {
    handleTerminalMessage(ctx, socket, session, sessionSeq, message, env)
    return
  }
  if (message?.type === 'echo') {
    sessionSeq += 1
    sendWsJson(socket, { type: 'echo', seq: sessionSeq, ts: Date.now(), text: String(message.text ?? '') })
    return
  }
  if (message?.type === 'hold') {
    if (message.on === true) {
      session.holding = true
      session.heldCount = 0
      sendWsJson(socket, { type: 'hold', on: true, seq: sessionSeq })
      return
    }
    session.holding = false
    if (session.holdGate !== undefined) {
      const gate = session.holdGate
      session.holdGate = undefined
      gate()
    }
    sendWsJson(socket, { type: 'held', count: session.heldCount ?? 0, seq: sessionSeq })
    return
  }
  if (message?.type === 'spike') {
    void runWsSpike(ctx, socket, session, message)
    return
  }
  if (message?.type === 'ack') {
    if (session.ackGate !== undefined) {
      const gate = session.ackGate
      session.ackGate = undefined
      clearTimeout(session.ackWatchdog)
      session.ackWatchdog = undefined
      gate()
    }
    return
  }
  if (message?.type === 'bye') {
    closeTerminals(session)
    sendWsJson(socket, { type: 'bye', seq: sessionSeq })
    socket.end()
    return
  }
  sendWsJson(socket, { type: 'error', seq: sessionSeq, message: `unknown message type: ${String(message?.type)}` })
}

async function runWsSpike(ctx, socket, session, message) {
  const bytes = Math.max(0, Math.min(512 * 1024 * 1024, Number(message.bytes ?? 10 * 1024 * 1024)))
  const chunkBytes = Math.max(1024, Math.min(4 * 1024 * 1024, Number(message.chunk ?? 64 * 1024)))
  const ackEvery = Math.max(1, Math.min(1024, Number(message.ackEvery ?? 128)))
  const started = Date.now()
  const totalChunks = Math.ceil(bytes / chunkBytes)
  let held = 0
  let sent = 0
  let stalls = 0
  let stallMs = 0
  session.holding = false

  const waitForAck = async () => {
    if (session.ackGate !== undefined) return // a previous wait is still pending
    const gate = new Promise((resolve) => {
      session.ackGate = resolve
      session.ackWatchdog = setTimeout(() => {
        session.ackGate = undefined
        session.ackWatchdog = undefined
        resolve()
      }, 30000)
    })
    await gate
  }

  for (let seq = 0; seq < totalChunks && session.alive && !socket.destroyed; seq += 1) {
    if (session.holding) {
      held += 1
      session.heldCount = (session.heldCount ?? 0) + 1
      const gate = new Promise((resolve) => {
        session.holdGate = resolve
      })
      await gate
      if (!session.holding) {
        session.holdGate = undefined
      }
    }
    if (sent > 0 && sent % ackEvery === 0) {
      stalls += 1
      const before = Date.now()
      await waitForAck()
      stallMs += Date.now() - before
    }
    const payloadBytes = Math.min(chunkBytes, bytes - seq * chunkBytes)
    const chunk = buildChunk(seq, payloadBytes, chunkBytes)
    const header = Buffer.from([0x82])
    header.set(lengthHeader(chunk.length))
    socket.write(Buffer.concat([header, chunk]))
    sent += 1
    if (sent % 512 === 0 && !socket.destroyed) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  if (!socket.destroyed) {
    sendWsJson(socket, {
      type: 'spike.done',
      bytes,
      chunks: totalChunks,
      wallMs: Date.now() - started,
      held,
      sent,
      stalls,
      stallMs
    })
  }
  ctx.logger.info(
    'at-terminal ws spike done: %s bytes, %s chunks, %s held, %s stalls (%sms) in %sms',
    bytes,
    totalChunks,
    held,
    stalls,
    stallMs,
    Date.now() - started
  )
}

function lengthHeader(length) {
  if (length < 126) return Buffer.from([length])
  if (length < 65536) {
    const header = Buffer.alloc(3)
    header[0] = 126
    header.writeUInt16BE(length, 1)
    return header
  }
  const header = Buffer.alloc(9)
  header[0] = 127
  header.writeBigUInt64BE(BigInt(length), 1)
  return header
}