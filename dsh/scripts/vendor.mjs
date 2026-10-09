#!/usr/bin/env node
/**
 * AT Terminal — vendor the dsh bundle's runtime dependencies.
 *
 * Why this exists
 * ---------------
 * The Harness installs a local-path bundle by symlinking this directory into
 * its profile (`link:`). Node resolves every bare specifier by walking up from
 * the *realpath* of the importing file, so `dsh/index.js` searches
 * `dsh/node_modules`, then `../node_modules`, and so on — it can never reach
 * the packages the Harness keeps inside its own `app.asar`
 * (`/dsh/node_modules/`). A `link:` install also does not install the linked
 * package's own `dependencies`.
 *
 * The only package the Host half needs at runtime is
 * `@deepseek-ai/schemastery` (the exported `Config` must be a real schemastery
 * schema for `dsh-settings` to introspect `.volatile()`), and schemastery
 * itself imports `@deepseek-ai/cosmokit` as a bare specifier. Both are
 * published on npm at exactly the versions the installed Harness uses, so
 * they are copied into `dsh/node_modules/@deepseek-ai/` — a location Node
 * finds regardless of the installer.
 *
 * Why that is safe
 * ----------------
 * The npm-published copies are byte-identical to the in-asar copies (checked
 * against DeepSeek Harness Desktop 0.1.7-rc.2), and both libraries tag their
 * cross-realm objects with `Symbol.for(...)` (`"schemastery"`,
 * `"ValidationError"`, `"cosmokit.volatile.write"`), so a vendored copy and the
 * Harness's copy agree on identity. The packages are locked to an exact
 * version *and* a sha512 integrity, and both are re-verified on every run.
 *
 * Deliberately dependency-free: Node built-ins only (`fetch`, `node:zlib`,
 * `node:crypto`). Run it with `npm run vendor:dsh`; it is idempotent.
 *
 * Usage: node dsh/scripts/vendor.mjs [--force] [--json]
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(HERE, '..')
const MODULES_DIR = path.join(BUNDLE_DIR, 'node_modules')

/**
 * The vendoring lock. Names double as the runtime allowlist enforced by
 * `scripts/verify.mjs`, so the gate and this script cannot drift apart.
 *
 * `cosmokit` has no transitive dependencies and `schemastery` needs only
 * `cosmokit` (its other npm dependency, `@standard-schema/spec`, is
 * types-only and never imported at runtime).
 */
export const VENDORED = Object.freeze([
  Object.freeze({
    name: '@deepseek-ai/schemastery',
    version: '3.18.4',
    integrity: 'sha512-SSXO6tYuyrIqKVbmOnIq0s+riUywYzouFMcnBluHF9n4KMo2G8HvEzhCYj6pj2617/glOjbJuVInJ9hfONsjkg=='
  }),
  Object.freeze({
    name: '@deepseek-ai/cosmokit',
    version: '1.8.5',
    integrity: 'sha512-LXsrlem9z8dq4sLflj2yuCuYX7KqhdzF5hZly3eZyuTo8d6oDSOXuEgC5DbQWKW+lksm6zmOutQLsP/ma6wR6A=='
  })
])

/**
 * Bare specifiers this bundle leaves `external` and expects **the repository's own
 * `node_modules`** to answer.
 *
 * This is a different category from `VENDORED`, and the difference is the whole reason
 * both lists exist:
 *
 * - a *vendored* package ships inside `dsh/node_modules`, because the Harness keeps its own
 *   copies inside `app.asar` where a `link:`-installed bundle cannot reach them;
 * - a *repo-resolved* package is an ordinary dependency of `at-terminal-series` itself. The
 *   profile links to this directory inside that repository, so Node's own resolution —
 *   walking up from `dsh/host.bundle.js` — finds `../node_modules/<name>` without any
 *   copying. Vendoring it would mean shipping a second copy of a native-assisted library
 *   for no benefit.
 *
 * The gate does not take that on faith: every name here must actually resolve from the
 * bundle directory, so a package that is merely declared but not installed fails.
 */
export const REPO_RESOLVED = Object.freeze(['ssh2'])


const REGISTRY = (process.env.DSH_VENDOR_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '')
const MARKER = '.dsh-vendor.json'
const PACKAGE_ROOT = 'package/' // every npm tarball puts its payload under this

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const asJson = argv.includes('--json')

/* --------------------------------- helpers --------------------------------- */

/** Verify a tarball against its SRI string; throws with both values on mismatch. */
function assertIntegrity(buffer, expected, where) {
  const algorithm = expected.slice(0, expected.indexOf('-'))
  if (algorithm === '') throw new Error(`${where}: malformed integrity "${expected}"`)
  const actual = `${algorithm}-${createHash(algorithm).update(buffer).digest('base64')}`
  if (actual !== expected) {
    throw new Error(`${where}: integrity mismatch\n  expected ${expected}\n  actual   ${actual}`)
  }
}

/** Read a NUL-padded string field out of a tar header block. */
function readTarString(header, start, length) {
  const field = header.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.toString('utf8', 0, end === -1 ? field.length : end).trim()
}

/**
 * Parse a `size`-style field, which tar writes as NUL/space-padded octal. Some
 * writers use the base-256 GNU encoding for large values; reject those, since
 * nothing in these packages is anywhere near that big.
 */
function readTarSize(header, start, length) {
  const text = readTarString(header, start, length)
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`unsupported tar size field "${text}"`)
  return Number.parseInt(text, 8)
}

/** Decode a pax extended header body (`"%d key=value\n"` records). */
function parsePax(body) {
  const records = {}
  for (const line of body.toString('utf8').split('\n')) {
    if (line === '') continue
    const space = line.indexOf(' ')
    if (space === -1) continue
    const record = line.slice(space + 1)
    const equals = record.indexOf('=')
    if (equals === -1) continue
    records[record.slice(0, equals)] = record.slice(equals + 1)
  }
  return records
}

/** Resolve one tarball entry to a safe path relative to the package root. */
function resolveEntryPath(raw, destination, where) {
  let relative = raw.replace(/^\.\//, '')
  if (relative.startsWith(PACKAGE_ROOT)) relative = relative.slice(PACKAGE_ROOT.length)
  else throw new Error(`${where}: unexpected tar root for "${raw}"`)
  if (relative === '') return null
  const target = path.resolve(destination, relative)
  if (target !== destination && !target.startsWith(destination + path.sep)) {
    throw new Error(`${where}: tar entry escapes the destination: "${raw}"`)
  }
  return { relative, target }
}

/**
 * Extract an npm tarball below `destination`, returning the bytes written.
 * Handles the entry kinds npm actually emits: directories, regular files and
 * pax extended headers; anything else is skipped rather than guessed at.
 */
function extractTarball(buffer, destination, where) {
  let written = 0
  let offset = 0
  let paxPath = null

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      offset += 512
      continue
    }

    const size = readTarSize(header, 124, 12)
    const typeflag = String.fromCharCode(header[156]) || '0'
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const bodyStart = offset + 512
    const body = buffer.subarray(bodyStart, bodyStart + size)
    offset = bodyStart + Math.ceil(size / 512) * 512

    if (typeflag === 'x' || typeflag === 'g') {
      const records = parsePax(body)
      if (typeflag === 'x' && records.path) paxPath = records.path
      continue
    }
    if (typeflag !== '0' && typeflag !== '5') continue // links, devices, ...

    const entryPath = paxPath ?? (prefix === '' ? name : `${prefix}/${name}`)
    paxPath = null
    if (entryPath === '') continue

    const resolved = resolveEntryPath(entryPath, destination, where)
    if (resolved === null) continue
    if (typeflag === '5') {
      fs.mkdirSync(resolved.target, { recursive: true })
      continue
    }

    fs.mkdirSync(path.dirname(resolved.target), { recursive: true })
    fs.writeFileSync(resolved.target, body)
    written += body.length
  }

  return written
}

/** Read the vendoring marker for an installed package, or `null`. */
function readMarker(destination) {
  try {
    return JSON.parse(fs.readFileSync(path.join(destination, MARKER), 'utf8'))
  } catch {
    return null
  }
}

/* ---------------------------------- main ----------------------------------- */

/**
 * True only when this file is the process entry point. `scripts/verify.mjs`
 * imports `VENDORED` from here to keep the runtime allowlist in sync with the
 * lock, and that import must not trigger a download.
 */
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

/** Fetch one JSON document from the registry. */
async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`)
  return response.json()
}

async function fetchBuffer(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Fetch, verify and unpack one locked package. */
async function vendorPackage(entry) {
  const destination = path.join(MODULES_DIR, ...entry.name.split('/'))
  const where = `${entry.name}@${entry.version}`

  const marker = readMarker(destination)
  if (
    !force &&
    marker !== null &&
    marker.name === entry.name &&
    marker.version === entry.version &&
    marker.integrity === entry.integrity
  ) {
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'))
    if (manifest.name !== entry.name || manifest.version !== entry.version) {
      throw new Error(
        `${where}: ${destination} is marked as vendored but its package.json says ` +
          `${manifest.name}@${manifest.version}`
      )
    }
    return { name: entry.name, version: entry.version, destination, bytes: 0, status: 'up-to-date' }
  }

  const encoded = entry.name.startsWith('@') ? entry.name.replace('/', '%2F') : entry.name
  const packument = await fetchJson(`${REGISTRY}/${encoded}`)
  const published = packument?.versions?.[entry.version]
  if (published === undefined) throw new Error(`${where}: not found on ${REGISTRY}`)
  if (published.name !== entry.name) {
    throw new Error(`${where}: registry returned "${published.name}"`)
  }
  if (published.version !== entry.version) {
    throw new Error(`${where}: registry returned version "${published.version}"`)
  }
  if (published.dist?.integrity !== entry.integrity) {
    throw new Error(
      `${where}: registry integrity changed\n  locked  ${entry.integrity}\n  current ${published.dist?.integrity}`
    )
  }

  const tarball = await fetchBuffer(published.dist.tarball)
  assertIntegrity(tarball, entry.integrity, where)

  const staging = `${destination}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const bytes = extractTarball(zlib.gunzipSync(tarball), staging, where)

  // The extracted manifest is the authority on what actually landed.
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'))
  if (manifest.name !== entry.name || manifest.version !== entry.version) {
    throw new Error(
      `${where}: extracted package.json says ${manifest.name}@${manifest.version}, refusing to install`
    )
  }
  for (const required of ['package.json', 'LICENSE']) {
    fs.accessSync(path.join(staging, required), fs.constants.R_OK)
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.renameSync(staging, destination)
  fs.writeFileSync(
    path.join(destination, MARKER),
    `${JSON.stringify({ name: entry.name, version: entry.version, integrity: entry.integrity }, null, 2)}\n`
  )

  return { name: entry.name, version: entry.version, destination, bytes, status: 'vendored' }
}

async function main() {
  const installed = []
  for (const entry of VENDORED) installed.push(await vendorPackage(entry))

  const totalBytes = installed.reduce((sum, result) => sum + result.bytes, 0)
  if (asJson) {
    console.log(JSON.stringify({ registry: REGISTRY, installed, totalBytes }, null, 2))
    return
  }
  const width = Math.max(...installed.map((result) => `${result.name}@${result.version}`.length))
  for (const result of installed) {
    const label = `${result.name}@${result.version}`.padEnd(width)
    const detail = result.status === 'vendored' ? `${result.bytes} bytes written` : 'already up-to-date'
    console.log(`${label}  ${detail}`)
  }
  console.log(
    `vendor: OK (${installed.length} package(s), ${totalBytes} bytes written, ${path.relative(process.cwd(), MODULES_DIR) || MODULES_DIR})`
  )
}

if (invokedDirectly) await main()
