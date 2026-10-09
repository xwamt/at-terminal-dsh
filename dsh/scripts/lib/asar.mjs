/**
 * Minimal reader for Electron `app.asar` archives.
 *
 * DeepSeek Harness Desktop ships every official package inside
 * `Contents/Resources/app.asar`, which ordinary shell tools cannot open. This
 * reader lets the verification scripts resolve the real `@deepseek-ai/*`
 * packages so tool definitions are checked against the installed DSL rather
 * than against a guess.
 *
 * Archive layout: `[u32:4][u32:headerPickleSize]` then a pickle holding
 * `[u32:stringSize][json]`, with file payloads starting right after the header.
 *
 * Two header shapes must both be handled. A packed entry carries a byte
 * `offset` (serialized as a *string* in this archive, so it must be coerced);
 * an entry flagged `"unpacked": true` has **no** `offset` at all and its
 * payload lives beside the archive under `app.asar.unpacked/<same path>`.
 * Naively coercing a missing offset yields `NaN` and makes `readSync` throw,
 * and 754 of this install's unpacked entries sit under `@deepseek-ai/*`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CANDIDATE_ASARS = [
  process.env.DSH_ASAR,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  path.join(os.homedir(), 'AppData/Local/Programs/DeepSeek Harness/resources/app.asar')
].filter(Boolean)

/** Locate the installed DeepSeek Harness archive, or return `null`. */
export function findDshAsar() {
  for (const candidate of CANDIDATE_ASARS) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * @param {string} archivePath
 * @returns {{ list(prefix?: string): {path: string, size: number, offset: number|null, unpacked: boolean}[],
 *             read(archivePath: string): Buffer | null }}
 */
export function openAsar(archivePath) {
  const fd = fs.openSync(archivePath, 'r')
  const sizeBuffer = Buffer.alloc(8)
  fs.readSync(fd, sizeBuffer, 0, 8, 0)
  const headerSize = sizeBuffer.readUInt32LE(4)
  const headerBuffer = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuffer, 0, headerSize, 8)
  const jsonSize = headerBuffer.readUInt32LE(4)
  const header = JSON.parse(headerBuffer.toString('utf8', 8, 8 + jsonSize))
  const dataStart = 8 + headerSize
  /** Sibling directory holding the payloads of `unpacked` entries. */
  const unpackedRoot = archivePath.replace(/app\.asar$/, 'app.asar.unpacked')

  const all = []
  ;(function walk(node, prefix) {
    for (const [name, value] of Object.entries(node.files || {})) {
      const full = `${prefix}/${name}`
      if (value.files) walk(value, full)
      else {
        const unpacked = value.unpacked === true
        all.push({
          path: full,
          size: value.size,
          // An unpacked entry has no `offset` key; `Number(undefined)` is NaN.
          offset: unpacked || value.offset === undefined ? null : Number(value.offset),
          unpacked
        })
      }
    }
  })(header, '')

  const byPath = new Map(all.map((entry) => [entry.path, entry]))

  return {
    list(prefix = '/') {
      return all.filter((entry) => entry.path.startsWith(prefix))
    },
    read(target) {
      const entry = byPath.get(target)
      if (!entry) return null
      if (entry.unpacked) {
        try {
          return fs.readFileSync(path.join(unpackedRoot, entry.path))
        } catch {
          return null
        }
      }
      if (entry.offset === null || !Number.isFinite(entry.offset)) return null
      const buffer = Buffer.alloc(entry.size)
      if (entry.size > 0) fs.readSync(fd, buffer, 0, entry.size, dataStart + entry.offset)
      return buffer
    },
    close() {
      fs.closeSync(fd)
    }
  }
}

/**
 * Resolve the transitive runtime dependency closure of `seeds` from a dsh
 * install, extracted under `destination`. Used to obtain a real
 * `@deepseek-ai/dsh-tools` that the verifier can import by absolute path.
 *
 * @param {{ seeds: string[], destination: string, archivePath: string }} options
 */
export function extractPackages({ seeds, destination, archivePath }) {
  const asar = openAsar(archivePath)
  const extracted = []
  const missing = []
  const skipped = []
  const queue = [...seeds]
  const seen = new Set()

  try {
    while (queue.length > 0) {
      const name = queue.shift()
      if (seen.has(name)) continue
      seen.add(name)

      const root = `/dsh/node_modules/${name}`
      const files = asar.list(`${root}/`)
      const manifestBuffer = asar.read(`${root}/package.json`)
      if (files.length === 0 || !manifestBuffer) {
        missing.push(name)
        continue
      }

      let manifest
      try {
        manifest = JSON.parse(manifestBuffer.toString('utf8'))
      } catch {
        missing.push(`${name} (unparsable manifest)`)
        continue
      }

      for (const file of files) {
        const relative = file.path.slice(root.length + 1)
        const target = path.join(destination, name, relative)
        const payload = asar.read(file.path)
        // A null payload is an unresolvable entry (packed with no usable offset,
        // or an `unpacked` payload missing beside the archive). Never let that
        // pass as success: record it so the caller can fail the gate.
        if (payload === null) {
          skipped.push(file.path)
          continue
        }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, payload)
      }
      extracted.push(name)

      for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
        queue.push(dep)
      }
    }
  } finally {
    asar.close()
  }

  return { extracted, missing, skipped }
}
