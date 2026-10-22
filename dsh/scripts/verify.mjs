#!/usr/bin/env node
/**
 * AT Terminal — dsh bundle verification (M0 gate).
 *
 * Runs ten independent checks and exits non-zero if any of them fails:
 *
 *   1. syntax   — every shipped JavaScript file parses
 *   2. manifest — `package.json` satisfies the documented bundle contract
 *   3. patch    — `cordis.patch.yml` really inserts this bundle's row
 *   4. deps     — every bare module specifier in a shipped file resolves for a
 *                 `link:`-installed bundle: `node:` builtins plus the vendored
 *                 allowlist only (see `vendor.mjs`), with the vendored copies
 *                 actually present on disk
 *   5. tools    — every tool definition satisfies `ToolRuntime.register()`'s
 *                 contract against the *installed* `@deepseek-ai/dsh-tools`,
 *                 and `execute()` returns a value that its own declared output
 *                 schema accepts through the real validator
 *   6. settings — the exported `Config` schema builds against the *installed*
 *                 `@deepseek-ai/schemastery`, resolves the documented defaults,
 *                 exposes every field as volatile, and **rejects** illegal
 *                 values through the same `~standard` path dsh validates with
 *   7. client   — the client half satisfies the browser-bundle contract
 *   8. bundle   — both committed artifacts match their sources byte for byte
 *   9. theme-tokens — the token bridge carries no literal colors
 *  10. policy   — every registered tool is classified in `dsh/policy.js`, and
 *                 every row names a tool this bundle registers
 *
 * Check 4 is static and always runs. Checks 5 and 6 extract the real package
 * dependency closures out of the installed DeepSeek Harness archive into
 * `dsh/.cache/dsh-sandbox`. When no installation is found they are reported as
 * SKIPPED — never as passed.
 *
 * Usage: node dsh/scripts/verify.mjs [--no-sandbox] [--json]
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { extractPackages, findDshAsar, openAsar } from './lib/asar.mjs'
import { REPO_RESOLVED, VENDORED } from './vendor.mjs'
import {
  SETTINGS_FIELDS,
  SETTINGS_SECTION_ID,
  createConfigSchema,
  readSettings
} from '../settings.js'
import {
  AT_TERMINAL_BUNDLE_NAME,
  AT_TERMINAL_PLUGIN_ID,
  CAPABILITIES,
  EMPTY_PARAMETERS,
  createPingTool,
  createTools
} from '../tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(HERE, '..')
const SANDBOX_DIR = path.join(BUNDLE_DIR, '.cache', 'dsh-sandbox')
const SANDBOX_MODULES = path.join(SANDBOX_DIR, 'node_modules')

/**
 * Stamp recording *which* Harness the sandbox was extracted from.
 *
 * The cache used to be reused on file existence alone, so after a Harness update the
 * gate kept validating this bundle against the previous release's `dsh-tools` while
 * printing nothing about the drift. A stamp turns the cache from "probably fine" into
 * "matches this install or is discarded".
 */
const SANDBOX_STAMP = path.join(SANDBOX_DIR, 'dsh-version.json')

const argv = process.argv.slice(2)
const skipSandbox = argv.includes('--no-sandbox')
const asJson = argv.includes('--json')

const results = []

async function check(id, title, run) {
  try {
    const note = await run()
    results.push({ id, title, status: 'pass', note: note ?? '' })
  } catch (error) {
    results.push({ id, title, status: 'fail', note: error?.message ?? String(error) })
  }
}

function skip(id, title, note) {
  results.push({ id, title, status: 'skipped', note })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listJsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.cache') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listJsFiles(full))
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every `.ts`/`.js`/`.mjs` file under `dir`, skipping installed and cached trees. */
function listSourceFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.cache' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (/\.(ts|js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/* ------------------------------- 4. deps helpers ------------------------------ */

/**
 * Keywords after which a `/` opens a regular-expression literal rather than a
 * division. Only used by the tokenizer's regex/division disambiguation.
 */
const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'yield', 'await', 'case', 'throw'
])

const MULTI_CHAR_PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '**', '<<',
  '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='
]

/**
 * Split JavaScript into the few token kinds needed to find module specifiers.
 *
 * Not a parser. Comments are dropped; string, template and regex literals each
 * collapse into one token (carrying the literal's *value* for strings, so the
 * specifier is always read from a real string token and never from inside a
 * larger blob of text). Template `${...}` holes are tokenized as normal code
 * via an explicit frame stack, which is what keeps a backtick-quoted message
 * from being mistaken for an import.
 *
 * @returns {{type: string, value?: string, pos: number}[]}
 */
function tokenize(source) {
  const tokens = []
  const stack = [{ kind: 'code', braceDepth: 0 }]
  const length = source.length
  let index = 0

  const isIdentifierStart = (c) => /[A-Za-z_$]/.test(c)
  const isIdentifierPart = (c) => /[A-Za-z0-9_$]/.test(c)

  /** A `/` starts a regex unless the previous token could end an expression. */
  function regexAllowed() {
    const previous = tokens[tokens.length - 1]
    if (previous === undefined) return true
    if (previous.type === 'punct') return !')]}'.includes(previous.value)
    if (previous.type === 'id') return REGEX_PREFIX_KEYWORDS.has(previous.value)
    return false
  }

  while (index < length) {
    const frame = stack[stack.length - 1]
    const char = source[index]

    if (frame.kind === 'template') {
      if (char === '\\') {
        index += 2
      } else if (char === '`') {
        stack.pop()
        tokens.push({ type: 'template', pos: index })
        index += 1
      } else if (char === '$' && source[index + 1] === '{') {
        stack.push({ kind: 'code', braceDepth: 0 })
        index += 2
      } else {
        index += 1
      }
      continue
    }

    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      index = newline === -1 ? length : newline + 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? length : close + 2
      continue
    }
    if (char === '/' && regexAllowed()) {
      const start = index
      index += 1
      let inClass = false
      while (index < length) {
        const c = source[index]
        if (c === '\\') index += 2
        else if (c === '[') { inClass = true; index += 1 }
        else if (c === ']') { inClass = false; index += 1 }
        else if (c === '/' && !inClass) { index += 1; break }
        else if (c === '\n') break
        else index += 1
      }
      while (index < length && /[a-z]/.test(source[index])) index += 1
      tokens.push({ type: 'regex', pos: start })
      continue
    }
    if (char === '"' || char === "'") {
      const start = index
      const quote = char
      index += 1
      let value = ''
      while (index < length) {
        const c = source[index]
        if (c === '\\') { value += source[index + 1] ?? ''; index += 2 }
        else if (c === quote) { index += 1; break }
        else { value += c; index += 1 }
      }
      tokens.push({ type: 'string', value, pos: start })
      continue
    }
    if (char === '`') {
      stack.push({ kind: 'template' })
      index += 1
      continue
    }
    if (char === '{') {
      frame.braceDepth += 1
      tokens.push({ type: 'punct', value: '{', pos: index })
      index += 1
      continue
    }
    if (char === '}') {
      if (frame.braceDepth === 0 && stack.length > 1) {
        stack.pop()
        index += 1
        continue
      }
      frame.braceDepth = Math.max(0, frame.braceDepth - 1)
      tokens.push({ type: 'punct', value: '}', pos: index })
      index += 1
      continue
    }
    if (isIdentifierStart(char)) {
      const start = index
      while (index < length && isIdentifierPart(source[index])) index += 1
      tokens.push({ type: 'id', value: source.slice(start, index), pos: start })
      continue
    }
    if (char >= '0' && char <= '9') {
      const start = index
      while (index < length && /[0-9A-Za-z._]/.test(source[index])) index += 1
      tokens.push({ type: 'number', pos: start })
      continue
    }
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    const punctuator = MULTI_CHAR_PUNCTUATORS.find((candidate) => source.startsWith(candidate, index))
    const value = punctuator ?? char
    tokens.push({ type: 'punct', value, pos: index })
    index += value.length
  }

  return tokens
}

/**
 * Every module specifier the source mentions, via `import`, `export ... from`,
 * a side-effect `import '...'` or a dynamic `import('...')`. Each result keeps
 * the absolute offset of the specifier's opening quote for diagnostics.
 */
function findModuleSpecifiers(source) {
  const tokens = tokenize(source)
  const found = []

  /** Index of `from` between `start` and the end of the statement, or -1. */
  const findFrom = (start) => {
    let depth = 0
    for (let k = start; k < tokens.length && k < start + 400; k += 1) {
      const token = tokens[k]
      if (token.type === 'punct') {
        if (token.value === '{' || token.value === '(') depth += 1
        else if (token.value === '}' || token.value === ')') depth -= 1
        else if (token.value === ';' && depth <= 0) return -1
      }
      if (depth <= 0 && token.type === 'id' && token.value === 'from') return k
    }
    return -1
  }

  const record = (token) => {
    found.push({ specifier: token.value, pos: token.pos })
  }

  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k]
    if (token.type !== 'id') continue
    const next = tokens[k + 1]
    if (next === undefined) continue

    if (token.value === 'import') {
      if (next.type === 'punct' && next.value === '.') continue // import.meta
      if (next.type === 'punct' && next.value === '(') {
        if (tokens[k + 2]?.type === 'string') record(tokens[k + 2]) // dynamic
        continue
      }
      if (next.type === 'string') {
        record(next) // side-effect import
        continue
      }
      const from = findFrom(k + 1)
      if (from !== -1 && tokens[from + 1]?.type === 'string') record(tokens[from + 1])
      continue
    }

    if (token.value === 'export') {
      if (next.type === 'punct' && next.value === '*') {
        const from = findFrom(k + 1)
        if (from !== -1 && tokens[from + 1]?.type === 'string') record(tokens[from + 1])
      } else if (next.type === 'punct' && next.value === '{') {
        let depth = 0
        let close = -1
        for (let j = k + 1; j < tokens.length; j += 1) {
          if (tokens[j].type !== 'punct') continue
          if (tokens[j].value === '{') depth += 1
          else if (tokens[j].value === '}') {
            depth -= 1
            if (depth === 0) { close = j; break }
          }
        }
        const after = close === -1 ? undefined : tokens[close + 1]
        if (after?.type === 'id' && after.value === 'from' && tokens[close + 2]?.type === 'string') {
          record(tokens[close + 2])
        }
      }
    }
  }

  return found
}

/** `node:` builtins, relative paths and absolute paths always resolve. */
function isSelfContainedSpecifier(specifier) {
  return (
    specifier.startsWith('node:') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/')
  )
}

/** 1-based line number of an offset, for diagnostics. */
function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === '\n') line += 1
  return line
}

const manifest = readJson(path.join(BUNDLE_DIR, 'package.json'))
const patchFile = path.join(BUNDLE_DIR, manifest.dsh?.bundle?.patch ?? '')

/* ---------------------------------- 1. syntax --------------------------------- */

await check('syntax', 'Shipped JavaScript parses', () => {
  const files = listJsFiles(BUNDLE_DIR)
  assert.ok(files.length >= 2, `expected at least 2 JavaScript files, found ${files.length}`)
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      throw new Error(`${path.relative(BUNDLE_DIR, file)}: ${error.stderr?.toString().trim() || error.message}`)
    }
  }
  return `${files.length} files`
})

/* --------------------------------- 2. manifest -------------------------------- */

await check('manifest', 'Bundle manifest satisfies the dsh contract', () => {
  assert.equal(typeof manifest.name, 'string', 'name must be a string')
  assert.match(manifest.name, /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/, 'name must be a valid package name')
  assert.equal(manifest.name, AT_TERMINAL_BUNDLE_NAME, 'manifest name must match AT_TERMINAL_BUNDLE_NAME')
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'version must be semver')
  assert.equal(manifest.type, 'module', 'type must be "module"')
  assert.equal(typeof manifest.exports?.['.'], 'string', 'exports["."] must be declared')
  assert.equal(
    manifest.exports['.'].replace(/^\.\//, ''),
    'index.js',
    'exports["."] must point at the Host half'
  )
  assert.ok(
    manifest.exports['./package.json'],
    'exports["./package.json"] is required: the Host half reads its own version'
  )

  const patchRel = manifest.dsh?.bundle?.patch
  assert.equal(typeof patchRel, 'string', 'dsh.bundle.patch must be declared')
  assert.ok(!path.isAbsolute(patchRel), 'dsh.bundle.patch must be a relative path')
  assert.ok(fs.existsSync(patchFile), `patch file not found: ${patchRel}`)

  // Runtime files must ship, or an installed copy cannot load.
  const shipped = new Set(manifest.files ?? [])
  for (const required of ['index.js', 'tools.js', 'settings.js', 'cordis.patch.yml']) {
    assert.ok(shipped.has(required), `files must include ${required}`)
  }

  // Icon rules: path relative to the manifest directory, inside it, <= 256 KiB.
  if (manifest.icon !== undefined) {
    assert.ok(!path.isAbsolute(manifest.icon), 'icon must be a relative path')
    assert.ok(!/^[a-z]+:/i.test(manifest.icon), 'icon must not be a URL')
    const iconPath = path.resolve(BUNDLE_DIR, manifest.icon)
    assert.ok(iconPath.startsWith(BUNDLE_DIR + path.sep), 'icon must stay inside the package')
    assert.ok(fs.existsSync(iconPath), `icon not found: ${manifest.icon}`)
    const size = fs.statSync(iconPath).size
    assert.ok(size <= 256 * 1024, `icon is ${size} bytes, limit is 262144`)
  }

  for (const locale of ['locale/en.json', 'locale/zh-CN.json']) {
    const file = path.join(BUNDLE_DIR, locale)
    assert.ok(fs.existsSync(file), `${locale} missing`)
    const meta = readJson(file).meta
    assert.equal(typeof meta?.title, 'string', `${locale} needs meta.title`)
  }

  return `${manifest.name}@${manifest.version}`
})

/* ---------------------------------- 3. patch ---------------------------------- */

await check('patch', 'cordis.patch.yml inserts this bundle row', async () => {
  const source = fs.readFileSync(patchFile, 'utf8')
  let parsed
  try {
    const yaml = await import('js-yaml')
    parsed = yaml.load(source)
  } catch (error) {
    throw new Error(
      `cannot parse YAML (${error.message}). Run \`npm install\` in the repository root so js-yaml resolves.`
    )
  }

  assert.ok(Array.isArray(parsed), 'patch must be a top-level YAML array')
  const rows = parsed.flatMap((entry) => entry?.insert ?? [])
  assert.ok(rows.length > 0, 'patch must contribute at least one insert row')

  const row = rows.find((candidate) => candidate?.name === manifest.name)
  assert.ok(row, `no insert row names ${manifest.name}`)
  assert.equal(typeof row.id, 'string', 'insert row needs a string id')
  assert.match(row.id, /^[a-z0-9][a-z0-9-]*$/, 'row id must be a slug')
  assert.equal(row.id, AT_TERMINAL_PLUGIN_ID, 'row id must match AT_TERMINAL_PLUGIN_ID')

  return `row id=${row.id}`
})

/* ---------------------------------- 4. deps ----------------------------------- */

/**
 * This is the check that would have caught the failure that motivated it: a
 * `link:`-installed bundle is resolved by Node from its own realpath, so a bare
 * specifier is only resolvable when it is a `node:` builtin or physically
 * present under `dsh/node_modules/`. The earlier gate passed while the plugin
 * could not load, because it imported by sandbox *absolute path* — a different
 * resolution route from the one the Harness uses.
 *
 * Anything `@deepseek-ai/dsh-*` is a Host-internal package: the npm preview is
 * an older version, so making it a dependency would silently drift the DSL.
 * It is never allowed, whatever its version.
 */
await check('deps', 'Shipped files only import resolvable bare specifiers', () => {
  const shipped = (manifest.files ?? []).filter((file) => /\.(?:js|mjs|cjs)$/.test(file))
  assert.ok(shipped.length > 0, 'package.json files lists no JavaScript to audit')

  const allowed = new Map(VENDORED.map((entry) => [entry.name, entry.version]))
  const problems = []
  const usedVendored = new Map()
  const usedRepoResolved = new Set()
  let specifierCount = 0

  for (const relative of shipped) {
    const file = path.join(BUNDLE_DIR, relative)
    assert.ok(fs.existsSync(file), `shipped file is missing: ${relative}`)
    assert.ok(
      !path.relative(BUNDLE_DIR, file).startsWith('..'),
      `shipped file escapes the package: ${relative}`
    )

    const source = fs.readFileSync(file, 'utf8')
    for (const { specifier, pos } of findModuleSpecifiers(source)) {
      specifierCount += 1
      if (isSelfContainedSpecifier(specifier)) continue
      const at = `${relative}:${lineOf(source, pos)}`
      if (specifier.startsWith('@deepseek-ai/dsh-')) {
        problems.push(
          `${at}  "${specifier}" is a Host-internal package and cannot be imported by an external bundle`
        )
        continue
      }
      if (REPO_RESOLVED.includes(specifier)) {
        usedRepoResolved.add(specifier)
        continue
      }
      if (!allowed.has(specifier)) {
        problems.push(
          `${at}  "${specifier}" is not a node: builtin, not vendored, and not a repository dependency ` +
            `(vendored: ${[...allowed.keys()].join(', ')}; repository: ${REPO_RESOLVED.join(', ')})`
        )
        continue
      }
      usedVendored.set(specifier, allowed.get(specifier))
    }
  }

  // The allowlist is only meaningful if the copies are actually on disk: a
  // clean checkout must be able to load the Host half with no network.
  for (const [name, version] of usedVendored) {
    const manifestFile = path.join(BUNDLE_DIR, 'node_modules', ...name.split('/'), 'package.json')
    assert.ok(
      fs.existsSync(manifestFile),
      `"${name}" is imported but not vendored — run \`npm run vendor:dsh\` (expected ${manifestFile})`
    )
    const vendored = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    assert.equal(
      vendored.version,
      version,
      `vendored ${name} is ${vendored.version}, the lock requires ${version}`
    )
  }

  // A repository dependency is only allowed if it really resolves from the bundle
  // directory — the same walk Node performs at runtime. A name that is declared in
  // package.json but never installed must fail here rather than at plugin activation.
  for (const name of usedRepoResolved) {
    try {
      createRequire(path.join(BUNDLE_DIR, 'index.js')).resolve(name)
    } catch (error) {
      problems.push(
        `${name} is declared as a repository dependency but does not resolve from ${BUNDLE_DIR}: ${error.code ?? error.message}`
      )
    }
  }

  assert.deepEqual(problems, [], `unresolvable imports in shipped files:\n  ${problems.join('\n  ')}`)
  const vendoredNote =
    usedVendored.size === 0
      ? 'no vendored imports'
      : `${usedVendored.size} vendored: ${[...usedVendored].map(([n, v]) => `${n}@${v}`).join(', ')}`
  const repoNote = usedRepoResolved.size === 0 ? '' : `; ${usedRepoResolved.size} from the repository: ${[...usedRepoResolved].join(', ')}`
  return `${shipped.length} file(s), ${specifierCount} specifier(s), ${vendoredNote}${repoNote}`
})

/* ------------------------- sandbox-backed checks 5 and 6 ---------------------- */

/** `@deepseek-ai/dsh-tools` is imported first so its closure lands in the sandbox. */
const archive = skipSandbox ? null : findDshAsar()
const sandboxSkipReason = skipSandbox
  ? '--no-sandbox'
  : archive === null
    ? 'no DeepSeek Harness install found; set DSH_ASAR to its app.asar'
    : null

/**
 * Version of the installed Harness, read from the archive's own `@deepseek-ai/dsh`
 * manifest. That manifest carries `name`/`description`/`version` and **no commit**, so
 * this stamp can only ever be a version plus an extraction timestamp — recording a
 * commit here would be an invention.
 *
 * @returns {string | null} `null` when there is no install or it cannot be read.
 */
function readHostVersion() {
  if (archive === null) return null
  let asar
  try {
    asar = openAsar(archive)
    const buffer = asar.read('/dsh/node_modules/@deepseek-ai/dsh/package.json')
    if (buffer === null) return null
    const version = JSON.parse(buffer.toString('utf8'))?.version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  } finally {
    asar?.close()
  }
}

const HOST_VERSION = readHostVersion()

/** Read the sandbox stamp, or `null` when there is none (or it is unreadable). */
function readSandboxStamp() {
  try {
    return JSON.parse(fs.readFileSync(SANDBOX_STAMP, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Extract a seed package's runtime closure into the sandbox if needed, then
 * import one built file from it by absolute path.
 *
 * The cache is keyed by the *install it came from*: a missing entry **or** a stamp that
 * does not name the current Harness version re-extracts. Without the second half, a
 * Harness upgrade silently kept validating new artifacts against old contracts.
 *
 * @param {string} seed Package name, e.g. `@deepseek-ai/schemastery`.
 * @param {string} entryRelative Path inside the package, e.g. `lib/index.mjs`.
 */
async function loadSandboxPackage(seed, entryRelative) {
  const entry = path.join(SANDBOX_MODULES, ...seed.split('/'), ...entryRelative.split('/'))
  const stamp = readSandboxStamp()
  const stale =
    HOST_VERSION === null
      ? false // no install to compare against: keep whatever is cached rather than churn
      : stamp === null || stamp.hostVersion !== HOST_VERSION
  if (stale || !fs.existsSync(entry)) {
    fs.rmSync(SANDBOX_MODULES, { recursive: true, force: true })
    const { extracted, missing, skipped } = extractPackages({
      seeds: [seed],
      destination: SANDBOX_MODULES,
      archivePath: archive
    })
    assert.ok(extracted.includes(seed), `${seed} was not extractable`)
    if (missing.length > 0) throw new Error(`missing packages in install: ${missing.join(', ')}`)
    if (skipped.length > 0) {
      throw new Error(
        `unreadable archive entries in install (${skipped.length}): ${skipped.slice(0, 5).join(', ')}` +
          (skipped.length > 5 ? ', ...' : '')
      )
    }
    fs.mkdirSync(SANDBOX_DIR, { recursive: true })
    fs.writeFileSync(
      SANDBOX_STAMP,
      `${JSON.stringify({ hostVersion: HOST_VERSION, extractedAt: new Date().toISOString() }, null, 2)}\n`
    )
  }
  return import(pathToFileURL(entry).href)
}

/* ----------------------------------- 5. tools ---------------------------------- */

/**
 * Mirror of `ToolRuntime.register()`'s guards.
 *
 * The real `register()` cannot be called here: it reaches `this.layers` and
 * `this.ctx` on a live service, and `ToolRuntime` injects `systemPrompt`, so it
 * will not start without a full cordis composition. The *substantive* guard —
 * `assertSupportedJsonSchema` — is the installed package's own function; only
 * the cheap shape checks are restated, and they match `register()` line for
 * line (output object, `render` function, optional `presentationMeta`
 * function, positive `timeoutMs`, `run_code` reserved).
 *
 * @param {object} definition A definition exactly as `tools.js` builds it.
 * @param {(schema: object) => void} assertSupportedJsonSchema From dsh-tools.
 */
function assertRegistrable(definition, assertSupportedJsonSchema) {
  const where = `tool "${definition.name}"`
  const output = definition.output
  assert.ok(
    output !== undefined && typeof output === 'object' && typeof output.render === 'function',
    `${where} must declare output { schema, render, presentationMeta? }`
  )
  if (output.presentationMeta !== undefined) {
    assert.equal(typeof output.presentationMeta, 'function', `${where}: output.presentationMeta must be a function`)
  }
  assertSupportedJsonSchema(output.schema)
  if (definition.timeoutMs !== undefined) {
    assert.ok(
      Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0,
      `${where}: timeoutMs must be a positive finite number`
    )
  }
  assert.notEqual(definition.name, 'run_code', `${where}: "run_code" is reserved for the PTC transport`)
}

if (sandboxSkipReason !== null) {
  skip('tools', 'Tool definitions satisfy the installed dsh-tools register() contract', sandboxSkipReason)
} else {
  await check('tools', 'Tool definitions satisfy the installed dsh-tools register() contract', async () => {
    const tools = await loadSandboxPackage('@deepseek-ai/dsh-tools', 'lib/index.js')
    const { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, validateJsonSchemaValue, valueSchemaSpecToJsonSchema } =
      tools

    assert.ok(Array.isArray(CAPABILITIES) && Object.isFrozen(CAPABILITIES), 'CAPABILITIES must be a frozen array')
    assert.ok(CAPABILITIES.includes('plugin-skeleton'), 'CAPABILITIES must list plugin-skeleton')
    assert.ok(CAPABILITIES.includes('direct-agent-tools'), 'CAPABILITIES must list direct-agent-tools')
    assert.ok(CAPABILITIES.includes('tool-timeouts'), 'CAPABILITIES must list tool-timeouts once tools declare them')
    // Announced only while the policy table really exempts the probe from the command
    // engine — a capability that advertises a bypass outliving the bypass would be worse
    // than not advertising it, so both halves are asserted together.
    const { classify } = await import('../policy.js')
    assert.equal(
      classify('at_terminal_get_hardware_metrics')?.probe,
      'builtin',
      'the hardware probe must stay classified as a built-in probe in dsh/policy.js'
    )
    assert.ok(
      CAPABILITIES.includes('builtin-probe'),
      'CAPABILITIES must list builtin-probe while the hardware probe bypasses the policy engine'
    )

    // The bundle hands `register()` a ready definition, so the gate pins the
    // two normalized shapes against the real package instead of re-deriving
    // them through the authoring DSL (`defineTool`). Feeding an already
    // normalized `parameters` back through `defineTool` throws — the shapes are
    // not interchangeable, which is exactly the mistake this guards.
    assert.deepEqual(
      parameterSchemaSpecToJsonSchema({}),
      { type: 'object', properties: {} },
      'EMPTY_PARAMETERS must be the literal output of parameterSchemaSpecToJsonSchema({})'
    )
    assert.deepEqual(
      EMPTY_PARAMETERS,
      parameterSchemaSpecToJsonSchema({}),
      'tools.js EMPTY_PARAMETERS drifted from the installed parameterSchemaSpecToJsonSchema({})'
    )

    const SAMPLE_INPUTS = {
      at_terminal_ping: {},
      at_terminal_list_ssh_servers: {},
      at_terminal_get_terminal_context: {},
      at_terminal_run_remote_command: { command: 'echo test' },
      at_terminal_sftp_list_directory: { path: '/tmp' },
      at_terminal_sftp_stat_path: { path: '/tmp' },
      at_terminal_sftp_read_file: { path: '/tmp/test.txt' },
      at_terminal_sftp_write_file: { path: '/tmp/test.txt', content: 'hello' },
      at_terminal_sftp_create_file: { path: '/tmp/test.txt' },
      at_terminal_sftp_create_directory: { path: '/tmp/testdir' },
      at_terminal_sftp_rename: { path: '/tmp/a', newPath: '/tmp/b' },
      at_terminal_sftp_delete: { path: '/tmp/test.txt' },
      at_terminal_open_monitor: { target: 'hardware', serverId: 'srv-1', mode: 'hud' },
      at_terminal_get_hardware_metrics: { serverId: 'srv-1' },
      at_terminal_get_agent_execution_status: { limit: 5 }
    }

    const terminations = []
    const mockService = {
      async listServers() {
        return {
          servers: [
            {
              id: 'srv-1',
              label: 'Test Server',
              host: '127.0.0.1',
              port: 22,
              username: 'root',
              authType: 'password',
              connected: true,
              agentCommandTrust: 'trusted',
              agentCommandAutoApprove: false
            }
          ]
        }
      },
      async getTerminalContext() {
        return {
          focusedTerminal: {
            terminalId: 'term-1',
            serverId: 'srv-1',
            label: 'Test Server',
            host: '127.0.0.1',
            port: 22,
            username: 'root',
            connected: true,
            focused: true,
            default: true
          },
          defaultConnectedTerminal: null,
          connectedTerminals: [],
          knownTerminals: []
        }
      },
      async runRemoteCommand(input) {
        return {
          serverId: input.serverId || 'srv-1',
          serverLabel: 'Test Server',
          host: '127.0.0.1',
          command: input.command,
          cwd: input.cwd || null,
          exitCode: 0,
          signal: null,
          stdout: 'test output\n',
          stderr: '',
          durationMs: 15,
          timedOut: false,
          truncated: false
        }
      },
      // The background path resolves the server *before* starting a job, so the job and its
      // kill name the same host. Present here so the sample below can reach that branch.
      async authorizeCommand(input) {
        return {
          server: { id: input.serverId || 'srv-1' },
          authorization: { autoApprove: true, destructive: false, riskSummaries: [] }
        }
      },
      async terminateRemoteCommand(serverId, pidfile) {
        terminations.push({ serverId, pidfile })
        return { killed: true, pid: '4242', detail: 'process group 4242 is gone' }
      },
      async sftpListDirectory(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path || '/',
          entries: [
            {
              name: 'test.txt',
              path: '/tmp/test.txt',
              type: 'file',
              size: 100,
              modifiedAt: 1700000000000,
              permissions: 420
            }
          ],
          truncated: false,
          offset: input.offset || 0,
          total: 1
        }
      },
      async sftpStatPath(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path,
          type: 'directory',
          size: 4096,
          modifiedAt: 1700000000000,
          permissions: 493
        }
      },
      async sftpReadFile(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path,
          content: 'hello world',
          truncated: false,
          offset: input.offset || 0,
          size: 11,
          modifiedAt: 1700000000000
        }
      },
      async sftpWriteFile(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path,
          bytesWritten: Buffer.byteLength(input.content || '', 'utf8'),
          overwritten: Boolean(input.overwrite)
        }
      },
      async sftpCreateFile(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path
        }
      },
      async sftpCreateDirectory(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path
        }
      },
      async sftpRename(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path,
          newPath: input.newPath
        }
      },
      async sftpDelete(input) {
        return {
          terminalId: input.terminalId || 'term-1',
          serverId: input.serverId || 'srv-1',
          path: input.path,
          deleted: true
        }
      },
      async openMonitor(input) {
        return {
          opened: true,
          target: input.target,
          serverId: input.serverId || 'srv-1',
          mode: input.mode || 'float'
        }
      },
      async getHardwareMetrics(serverId) {
        return {
          serverId: serverId || 'srv-1',
          timestamp: 1700000000000,
          cpu: { usagePercent: 15, cores: [15], loadAvg: [0.5, 0.4, 0.3] },
          memory: { totalBytes: 8192, usedBytes: 4096, freeBytes: 4096 },
          disk: { mounts: [] },
          network: { rxBytesPerSec: 100, txBytesPerSec: 50 },
          processes: [{ pid: 1, user: 'root', cpuPercent: 1.0, memPercent: 1.0, command: 'init' }]
        }
      },
      async getAgentExecutionStatus(limit) {
        return {
          timestamp: 1700000000000,
          currentAction: { id: 'act-1', command: 'echo test', runningTimeMs: 100, status: 'running' },
          recentAudits: [{ id: 'a1', timestamp: 1700000000000, command: 'echo test', decision: 'allowed', riskLevel: 'low' }],
          activeTransfers: []
        }
      }
    }

    const definitions = createTools({ version: manifest.version, resolveAgentService: () => mockService })
    assert.equal(definitions.length, 15, 'bundle must contribute exactly 15 tools')

    // `register()` accepts a missing `timeoutMs` (it only rejects a non-positive one), so a
    // tool that forgot to declare a bound hangs until the user cancels. Declaring it on every
    // tool — including the ones that cannot block — keeps this one rule instead of an
    // allowlist that would itself need maintaining.
    const undeclared = definitions
      .filter((definition) => !(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0))
      .map((definition) => definition.name)
    assert.equal(
      undeclared.length,
      0,
      `${undeclared.length} tool(s) declare no timeoutMs and would hang until cancelled: ${undeclared.join(', ')}`
    )

    const seen = new Set()
    for (const definition of definitions) {
      assert.match(definition.name, /^[a-z][a-z0-9_]*$/, `tool name is not wire-safe: ${definition.name}`)
      assert.ok(!seen.has(definition.name), `duplicate tool name: ${definition.name}`)
      seen.add(definition.name)
      assert.ok(
        typeof definition.description === 'string' && definition.description.length >= 40,
        `${definition.name}: description is too short to guide the model`
      )
      assert.equal(typeof definition.execute, 'function', `${definition.name}: execute must be a function`)

      assertRegistrable(definition, assertSupportedJsonSchema)

      if (['at_terminal_ping', 'at_terminal_list_ssh_servers', 'at_terminal_get_terminal_context'].includes(definition.name)) {
        assert.deepEqual(
          definition.parameters,
          parameterSchemaSpecToJsonSchema({}),
          `${definition.name}: parameters must be the normalized empty parameter map, not {}`
        )
      } else {
        assert.equal(definition.parameters.type, 'object', `${definition.name}: parameters type must be object`)
        assert.equal(
          definition.parameters.additionalProperties,
          false,
          `${definition.name}: parameters must set additionalProperties: false`
        )
      }

      const sample = SAMPLE_INPUTS[definition.name]
      assert.ok(sample !== undefined, `no sample input configured for ${definition.name}`)
      const inputErrors = validateJsonSchemaValue(definition.parameters, sample, '')
      assert.deepEqual(
        inputErrors,
        [],
        `${definition.name}: the declared parameters reject sample input: ${JSON.stringify(inputErrors)}`
      )

      // The declared output schema is already in the enforced subset, so the
      // normalizer is the identity on it — checked, not assumed.
      assert.deepEqual(
        valueSchemaSpecToJsonSchema(definition.output.schema),
        definition.output.schema,
        `${definition.name}: output.schema is not already normalized JSON Schema`
      )

      // execute() must return a value its own declared schema accepts, through
      // the real validator rather than a hand-rolled walker.
      const value = await definition.execute(sample, { signal: undefined })
      const outputErrors = validateJsonSchemaValue(definition.output.schema, value, '')
      assert.deepEqual(
        outputErrors,
        [],
        `${definition.name}: execute() returned a value its output.schema rejects: ${JSON.stringify(outputErrors)}`
      )

      // The declared renderer must turn that value into model-facing text.
      const content = definition.output.render(sample, value)
      assert.ok(Array.isArray(content) && content.length > 0, `${definition.name}: render() returned no content`)
      assert.equal(content[0].type, 'text', `${definition.name}: render() must produce a text block`)
      assert.ok(
        typeof content[0].text === 'string' && content[0].text.length > 0,
        `${definition.name}: render() produced an empty text block`
      )
    }

    // `run_in_background` is a producer for the Host's job registry, and the two facts
    // that make that work are asserted rather than described:
    //
    //   * the owner handed to `jobs.start()` is the **agent** id — `dsh-jobs-local` resolves
    //     it with `agents.get(spec.owner)` (`lib/index.js:537-543`), so a session id would
    //     not resolve and every background call would fail;
    //   * the tool names this bundle does *not* register — `@deepseek-ai/dsh-tool-jobs`
    //     already owns `job_output` / `job_list` / `job_kill`, and a second registration
    //     under one of those names is a collision, not a feature.
    const reserved = ['job_output', 'job_list', 'job_kill']
    for (const definition of definitions) {
      assert.ok(
        !reserved.includes(definition.name),
        `${definition.name}: @deepseek-ai/dsh-tool-jobs already registers that name; this bundle is a job producer, not a controller`
      )
    }
    const runTool = definitions.find((definition) => definition.name === 'at_terminal_run_remote_command')
    assert.ok(runTool, 'run_remote_command must be registered')
    assert.equal(
      runTool.parameters.properties.run_in_background?.type,
      'boolean',
      'run_remote_command must declare run_in_background as a boolean'
    )

    // Without a job registry the flag must degrade to a foreground run with a readable
    // reason — the plan's DoD, and the reason a preset without `dsh-tool-jobs` still works.
    const degraded = await runTool.execute(
      { command: 'sleep 60', serverId: 'srv-1', run_in_background: true },
      { signal: undefined }
    )
    assert.equal(degraded.kind, 'foreground', 'without a jobs service the call must degrade to foreground')
    assert.equal(
      typeof degraded.notice,
      'string',
      'a degraded background request must say why in `notice` rather than failing silently'
    )

    // With one, the tool must hand over a job — and the spec it builds is checked, because
    // every field in it is a place where the plan's own text was wrong once.
    const started = []
    const fakeJobs = {
      start(spec) {
        started.push(spec)
        return 'ssh-command-0123456789abcdef'
      }
    }
    const withJobs = createTools({
      version: manifest.version,
      resolveAgentService: () => mockService,
      resolveJobs: () => fakeJobs
    }).find((definition) => definition.name === 'at_terminal_run_remote_command')
    const { recordDecision } = await import('../policy.js')
    const backgroundExec = { agent: { id: 'agent-1' }, callId: 'call-1', rootCallId: 'root-1', signal: undefined }
    // No verdict → no job: a dialog raised from inside a detached job has nowhere to be
    // answered, so the tool must refuse to start one (and degrade) instead.
    const unasked = await withJobs.execute(
      { command: 'sleep 60', serverId: 'srv-1', run_in_background: true },
      backgroundExec
    )
    assert.equal(unasked.kind, 'foreground', 'a background job must not start without a pre-execute verdict')
    assert.equal(started.length, 0, 'no job may be registered before the authorization question is answered')

    recordDecision(backgroundExec, 'auto-approved')
    const accepted = await withJobs.execute(
      { command: 'sleep 60', serverId: 'srv-1', run_in_background: true },
      backgroundExec
    )
    assert.deepEqual(
      accepted,
      { kind: 'background', jobId: 'ssh-command-0123456789abcdef' },
      'an accepted background call returns exactly the job id'
    )
    assert.equal(started.length, 1, 'exactly one job must be registered')
    assert.equal(started[0].kind, 'ssh-command', 'the job kind must name what it runs')
    assert.equal(
      started[0].owner,
      'agent-1',
      'the owner must be the agent id: dsh-jobs-local resolves it with agents.get()'
    )
    assert.equal(typeof started[0].run, 'function', 'the spec must carry a run() body')
    assert.ok(CAPABILITIES.includes('background-jobs'), 'CAPABILITIES must list background-jobs')
    // The body must be able to stop the remote process, not just the local wait.
    const hooks = started[0].run({ id: 'ssh-command-0123456789abcdef', append() {} })
    assert.equal(typeof hooks.cancel, 'function', 'cancel must be callable synchronously')
    assert.ok(hooks.done instanceof Promise, 'done must be a promise the registry can await')
    hooks.cancel('test cleanup')
    await hooks.done
    // Cancelling must reach the *remote* kill, through the pidfile the job id names — the
    // whole point of the task is that a cancelled job is not just a closed channel.
    assert.equal(terminations.length, 1, 'cancel must ask the service to terminate the remote process')
    assert.ok(
      terminations[0].pidfile.includes('ssh-command-0123456789abcdef'),
      `cancel must kill the pidfile named after the job, got ${terminations[0].pidfile}`
    )
    assert.equal(terminations[0].serverId, 'srv-1', 'cancel must target the server the job resolved')

    // The readiness probe is this bundle's own contract: it must report the
    // shipped version, the real capability list, and a machine-readable time.
    const probe = createPingTool({ version: manifest.version, now: () => new Date(0) })
    const probeValue = await probe.execute({}, { signal: undefined })
    assert.equal(probeValue.version, manifest.version, 'ping must report the shipped version')
    assert.equal(probeValue.ready, true, 'ping must report readiness')
    assert.deepEqual(probeValue.capabilities, [...CAPABILITIES], 'ping must report the real capabilities')
    assert.equal(probeValue.checkedAt, new Date(0).toISOString(), 'ping must use the injected clock')

    return `${definitions.length} tool(s) against dsh-tools ${readInstalledVersion('dsh-tools')} (harness ${HOST_VERSION ?? 'unknown'})`
  })
}

/* --------------------------------- 6. settings -------------------------------- */

/**
 * One illegal value per settings field, plus boundary cases. Each must be
 * rejected by the real schemastery — if the constraints are ever dropped from
 * `settings.js`, the schema accepts these and this check fails.
 */
const ILLEGAL_SETTINGS = [
  { field: 'terminalFontSize', value: -1, why: 'below the minimum of 8' },
  { field: 'terminalFontSize', value: 4.5, why: 'not an integer' },
  { field: 'terminalFontSize', value: 5000, why: 'above the maximum of 200' },
  { field: 'terminalFontFamily', value: '', why: 'empty string, shorter than the minimum of 1' },
  { field: 'scrollback', value: 'abc', why: 'not a number' },
  { field: 'scrollback', value: 10, why: 'below the minimum of 100' },
  { field: 'semanticHighlight', value: 1, why: 'not a boolean' },
  { field: 'idleDisconnectMinutes', value: -5, why: 'below the minimum of 0' },
  { field: 'zebraStripes', value: 'yes', why: 'not a boolean' },
]

/** Inclusive boundaries and documented defaults must stay accepted. */
const LEGAL_SETTINGS = [
  {},
  { terminalFontSize: 8 },
  { terminalFontSize: 200 },
  { scrollback: 100 },
  { idleDisconnectMinutes: 0 },
  { terminalFontFamily: 'Menlo, monospace' }
]

if (sandboxSkipReason !== null) {
  skip('settings', 'Settings Config accepted by the installed schemastery', sandboxSkipReason)
} else {
  await check('settings', 'Settings Config accepted by the installed schemastery', async () => {
    // dsh keys a settings form by the profile entry id, so the namespace the
    // form is addressed by must be the row this bundle inserts.
    assert.equal(SETTINGS_SECTION_ID, AT_TERMINAL_PLUGIN_ID, 'SETTINGS_SECTION_ID must match the patch row id')
    assert.ok(Object.isFrozen(SETTINGS_FIELDS), 'SETTINGS_FIELDS must be frozen')
    assert.equal(SETTINGS_FIELDS.length, 6, 'the bundle documents six settings fields')
    for (const field of SETTINGS_FIELDS) {
      assert.equal(field.vscodeKey, `sshManager.${field.key}`, `${field.key}: vscodeKey must mirror the manifest`)
    }

    // No dead switches. A settings field the form renders but no code reads is worse than a
    // missing one: it invites a change and answers it with silence. Three fields had drifted
    // into exactly that state (`sessionLogDirectory`, `idleDisconnectMinutes`,
    // `keepAliveInterval`) while the gate was busy checking their types.
    //
    // The signal is a read *through the settings port* — `get('<key>'` — rather than the key
    // appearing anywhere. Mere appearance is what let `keepAliveInterval` hide: the name is
    // also the per-server field in `src/config/schema.ts`, so a substring search found
    // consumers that had nothing to do with this setting.
    const repoRoot = path.resolve(HERE, '..', '..')
    const consumerSources = [
      ...listSourceFiles(path.join(repoRoot, 'src')),
      // The bundle's own JavaScript, minus the file that *declares* the fields and the two
      // generated artifacts (`client.js`, `host.bundle.js`) that would match by construction.
      ...listSourceFiles(BUNDLE_DIR).filter(
        (file) =>
          !file.startsWith(path.join(BUNDLE_DIR, 'scripts')) &&
          path.basename(file) !== 'settings.js' &&
          !file.endsWith('.bundle.js') &&
          path.basename(file) !== 'client.js'
      )
    ]
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n')

    const unread = SETTINGS_FIELDS.map((field) => field.key).filter(
      (key) => !new RegExp(`get\\(\\s*['"]${key}['"]`).test(consumerSources)
    )
    assert.equal(
      unread.length,
      0,
      `${unread.length} settings field(s) are rendered but never read: ${unread.join(', ')} — ` +
        'either read them through ConfigSection#get() or remove the field'
    )

    // The vendored copies must be the versions the install actually runs. This used to be
    // an invisible drift (vendored 3.18.4, host 3.18.5): the schema still validated, so
    // nothing failed, and the next divergence would have been a validation difference
    // nobody could attribute. The pin lives in `vendor.mjs`, so re-vendor is the fix.
    for (const name of ['schemastery', 'cosmokit']) {
      const pinned = VENDORED.find((entry) => entry.name === `@deepseek-ai/${name}`)
      assert.ok(pinned !== undefined, `vendor.mjs must pin @deepseek-ai/${name}`)
      assert.equal(
        readInstalledVersion(name),
        pinned.version,
        `vendored ${name} is ${pinned.version} but the harness ships ${readInstalledVersion(name)}; run \`npm run vendor:dsh\``
      )
    }

    const schemastery = await loadSandboxPackage('@deepseek-ai/schemastery', 'lib/index.mjs')
    const z = schemastery.default
    const schema = createConfigSchema(z)

    // The schema must describe exactly the documented fields, nothing more.
    assert.deepEqual(
      Object.keys(schema.dict ?? {}),
      SETTINGS_FIELDS.map((field) => field.key),
      'schema fields must match SETTINGS_FIELDS'
    )

    // Every field is volatile, which is what makes the panel render a form:
    // dsh-settings keeps only fields whose nearest volatile ancestor is
    // volatile. Rebuild through a JSON round-trip the way `plainSchema()` does,
    // so a field that only looks volatile on the live object would not pass.
    const projection = new z(schema.toJSON())
    assert.equal(projection.meta?.volatile, undefined, 'the root must not be volatile, or no per-field form is built')
    for (const field of SETTINGS_FIELDS) {
      assert.equal(
        projection.dict?.[field.key]?.meta?.volatile,
        true,
        `${field.key} must be .volatile() or the settings form stays empty`
      )
    }

    // An empty row resolves to the documented defaults, through real accessors.
    const resolved = schema({})
    const defaults = {}
    for (const field of SETTINGS_FIELDS) {
      const reference = resolved[field.key]
      assert.equal(typeof reference?.get, 'function', `${field.key} must resolve to a .get() accessor`)
      assert.deepEqual(reference.get(), field.default, `${field.key} must resolve to its documented default`)
      defaults[field.key] = field.default
    }
    assert.deepEqual(readSettings(resolved), defaults, 'readSettings must reproduce the resolved defaults')

    // A full override round-trips through the accessors and the probe.
    const overrides = {
      terminalFontSize: 18,
      terminalFontFamily: 'Fira Code, monospace',
      scrollback: 250000,
      semanticHighlight: false,
      idleDisconnectMinutes: 0,
      zebraStripes: true
    }
    const custom = schema(overrides)
    assert.deepEqual(readSettings(custom), overrides, 'valid overrides must round-trip through readSettings')

    // A profile written before `sessionLogDirectory` was removed still carries the key.
    // That must not stop the plugin from starting: schemastery keeps the unknown key and
    // `readSettings` ignores it, so the upgrade is a leftover line rather than a crash.
    const legacy = schema({ ...overrides, sessionLogDirectory: '/tmp/at-terminal-logs' })
    assert.equal(
      Object.prototype.hasOwnProperty.call(readSettings(legacy), 'sessionLogDirectory'),
      false,
      'a leftover sessionLogDirectory must not reach the read settings'
    )

    const { validateJsonSchemaValue } = await loadSandboxPackage('@deepseek-ai/dsh-tools', 'lib/index.js')
    const probe = createPingTool({ version: manifest.version, now: () => new Date(0), config: custom })
    const probeValue = await probe.execute({}, { signal: undefined })
    assert.deepEqual(probeValue.settings, overrides, 'the readiness probe must report the effective settings')
    assert.deepEqual(
      validateJsonSchemaValue(probe.output.schema, probeValue, ''),
      [],
      'the readiness probe value must satisfy its declared output schema'
    )

    // Legal values, including both inclusive boundaries, must stay accepted.
    for (const value of LEGAL_SETTINGS) {
      schema(value)
    }

    // Reverse test: each illegal value must be rejected, both through a direct
    // call and through `~standard.validate` — the path `resolveConfig()` uses
    // when dsh persists a settings edit.
    const accepted = []
    for (const { field, value, why } of ILLEGAL_SETTINGS) {
      const input = { [field]: value }
      try {
        schema(input)
        accepted.push(`${field}=${JSON.stringify(value)} (${why})`)
      } catch {
        // expected
      }
      const issue = schema['~standard'].validate(input)
      assert.ok(
        issue?.issues?.length > 0,
        `${field}=${JSON.stringify(value)} must also fail the ~standard validation path`
      )
    }
    assert.deepEqual(accepted, [], `schema accepted illegal values: ${accepted.join('; ')}`)

    return `${SETTINGS_FIELDS.length} fields, ${ILLEGAL_SETTINGS.length} illegal values rejected against schemastery ${readInstalledVersion('schemastery')} (harness ${HOST_VERSION ?? 'unknown'})`
  })
}

function readInstalledVersion(name) {
  try {
    return readJson(path.join(SANDBOX_MODULES, '@deepseek-ai', name, 'package.json')).version
  } catch {
    return 'unknown'
  }
}

/* ---------------------------------- 7. client --------------------------------- */

/**
 * The browser half is the one part of this bundle the gate previously ignored, and it
 * fails in ways that produce no error anywhere: a wrong loader `id` registers the
 * factory under a name nothing can require, and top-level code outside the factory
 * runs at page load instead of at first use. Both are silent, so both are asserted
 * here rather than trusted to review.
 */
await check('client', 'Client half satisfies the browser-bundle contract', async () => {
  const decl = manifest.dsh?.client
  assert.ok(decl !== undefined, 'dsh.client must be declared, or no browser half loads')
  assert.equal(typeof decl.platform, 'string', 'dsh.client.platform must be a string')
  assert.equal(decl.platform, 'web', 'dsh.client.platform must be "web"')
  if (decl.immediately !== undefined) {
    assert.equal(typeof decl.immediately, 'boolean', 'dsh.client.immediately must be a boolean')
  }
  for (const key of ['inject', 'external']) {
    if (decl[key] === undefined) continue
    assert.ok(Array.isArray(decl[key]), `dsh.client.${key} must be an array`)
    for (const item of decl[key]) assert.equal(typeof item, 'string', `dsh.client.${key} entries must be strings`)
  }

  // `exports["./client"]` is the authoritative resolution point: client-modules'
  // `clientExportOf` accepts a bare string or a one-level conditional object.
  const raw = manifest.exports?.['./client']
  const rel = typeof raw === 'string' ? raw : raw?.default
  assert.equal(typeof rel, 'string', 'exports["./client"] must be a string or { default: string }')
  assert.ok(rel.startsWith('./'), 'exports["./client"] must be a relative path')
  const entryPath = path.resolve(BUNDLE_DIR, rel)
  assert.ok(entryPath.startsWith(BUNDLE_DIR + path.sep), 'exports["./client"] must stay inside the package')
  assert.ok(fs.existsSync(entryPath), `client entry not found: ${rel}`)
  assert.ok(
    new Set(manifest.files ?? []).has(rel.replace(/^\.\//, '')),
    `files must list ${rel}, or an installed copy cannot serve it`
  )

  const source = fs.readFileSync(entryPath, 'utf8')

  // 1. The loader call exists and is keyed by the package name.
  assert.ok(
    source.includes('window.__ModuleLoader__.load({'),
    'the client entry must register through window.__ModuleLoader__.load({...})'
  )
  const idMatch = source.match(/\bid:\s*["']([^"']+)["']/)
  assert.ok(idMatch !== null, 'the loader call must declare an id')
  assert.equal(
    idMatch[1],
    manifest.name,
    `the loader id must equal the package name (${manifest.name}), or nothing can require this bundle`
  )

  // 2. Bundle purity: executing the file may only register the factory.
  //
  //    This used to be a per-line scan for anything at column zero, which forced the build
  //    to indent every line of the bundle — and indenting a template literal rewrites its
  //    value (esbuild prints `"\n"` as a two-line literal). That silently corrupted a dozen
  //    strings, including the split separator in the remote-command tool card. A line scan
  //    cannot tell a statement from string content without parsing the file, so the shape
  //    is asserted structurally here and **the purity claim is proven behaviourally by
  //    check 3**: the artifact is executed in a VM that provides only a
  //    `window.__ModuleLoader__` stub, and every module-scope side effect that could
  //    matter (a DOM touch, a network call, a throw) fails there.
  const withoutLeadingDoc = source.replace(/^\/\*[\s\S]*?\*\/\s*/, '')
  assert.ok(
    withoutLeadingDoc.startsWith('window.__ModuleLoader__.load({'),
    `the loader call must be the file's first statement, got: ${withoutLeadingDoc.slice(0, 60)}`
  )
  assert.equal(
    source.split('window.__ModuleLoader__.load(').length - 1,
    1,
    'the client entry must register exactly once'
  )
  assert.ok(
    withoutLeadingDoc.trimEnd().endsWith('});'),
    'the loader call must close the file, or the factory body is not the whole bundle'
  )

  // 3. The factory hands back a cordis plugin — asserted by **executing** the file in a
  // sandbox rather than grepping it, because the artifact is compiled output: the export
  // shape is whatever esbuild emits today (`module.exports = __toCommonJS(...)` with
  // getters), and a regex pinned to one emit style would pass a broken bundle that
  // happens to contain the string, or fail a correct one after a bundler upgrade. The
  // execution also proves the module scope is browser-free: evaluating the bundle with
  // nothing but a `window.__ModuleLoader__` stub and a React stand-in must not throw,
  // which is the "no side effects outside the factory" property a text scan cannot see.
  const vm = await import('node:vm')
  const registrations = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    // xterm's platform module reads `navigator.userAgent`/`navigator.platform` while it
    // initializes — environment detection every browser bundle does, not a side effect.
    // `document` stays absent on purpose: any DOM touch at module scope must throw.
    navigator: { userAgent: 'dsh-verify', platform: 'node' },
    // Browser UMD wrappers in xterm's addons call their factory with `self` as the
    // global; in a real page that is the window. Pointing it at the sandbox keeps
    // those exports contained here rather than leaking into the Host process.
    self: null,
    console
  }
  sandbox.self = sandbox
  vm.runInNewContext(source, sandbox, { filename: rel })
  assert.equal(registrations.length, 1, `expected exactly one loader registration, got ${registrations.length}`)
  const [registration] = registrations
  assert.equal(registration.id, manifest.name, 'the registration id must equal the package name')
  assert.equal(typeof registration.factory, 'function', 'the registration must carry a factory')

  const reactStub = {
    createElement: () => ({}),
    createContext: (defaultValue) => ({ Provider: () => ({}), defaultValue, current: defaultValue }),
    useState: () => [undefined, () => undefined],
    useEffect: () => undefined,
    useRef: (initial) => ({ current: initial }),
    useContext: (context) => context?.current ?? context?.defaultValue
  }
  const required = []
  const plugin = registration.factory((id) => {
    required.push(id)
    if (id === 'react') return reactStub
    throw new Error(`unexpected external require: ${id}`)
  })
  // The factory resolves every external its module body names, and the same id may be
  // required more than once (esbuild emits one `require("react")` per importing module),
  // so the contract is on the SET of externals, not the call list.
  const externals = [...new Set(required)]
  assert.deepEqual(
    externals,
    ['react'],
    `react is the only external the factory may require, got: ${externals.join(', ')}`
  )
  assert.equal(typeof plugin.apply, 'function', 'the factory must return a plugin with apply()')
  assert.ok(Array.isArray(plugin.inject), 'the factory must return a plugin with an inject list')
  for (const service of ['slots', 'sidebarRightTabs', 'locale']) {
    assert.ok(plugin.inject.includes(service), `inject must list "${service}"`)
  }

  return `${manifest.name} -> ${rel}, factory executes (apply + inject[${plugin.inject.length}])`
})

/* --------------------------------- 8. build artifact -------------------------- */

/**
 * `dsh/host.bundle.js` is compiled from `src/platform/dsh/entry.ts` and committed,
 * because a `link:`-installed bundle runs no build step — the profile points at this
 * directory and the Harness loads whatever is there. That makes a stale artifact the
 * easiest way for the installed plugin to run code nobody wrote.
 *
 * The check rebuilds in memory and compares bytes rather than trusting timestamps:
 * mtimes lie across checkouts, and a compiler upgrade would move them without changing
 * what the source means.
 */
await check('bundle', 'Compiled Host services match their sources', () => {
  const relay = spawnSync(process.execPath, [path.join(BUNDLE_DIR, 'esbuild.dsh.mjs'), '--check'], {
    cwd: path.resolve(BUNDLE_DIR, '..'),
    encoding: 'utf8'
  })
  if (relay.status !== 0) {
    const detail = `${relay.stdout ?? ''}${relay.stderr ?? ''}`.trim()
    throw new Error(detail.split('\n').slice(0, 4).join(' '))
  }
  const artifact = path.join(BUNDLE_DIR, 'host.bundle.js')
  assert.ok(fs.existsSync(artifact), 'host.bundle.js must be committed and listed in `files`')
  assert.ok(
    new Set(manifest.files ?? []).has('host.bundle.js'),
    'files must list host.bundle.js, or an installed copy cannot import it'
  )
  return `${fs.statSync(artifact).size} bytes, current`
})

/* -------------------------------- 9. theme tokens -------------------------------- */

/**
 * The `--vscode-*` → `--dsw-alias-*` bridge may only carry theme references.
 *
 * The official rule (`dsh-agent-preset/skills/cordis-plugin-development/
 * references/practices.md`, UI section) is that literal colors are for artwork
 * only: a literal does not follow the light/dark switch, so it is a silent
 * theme bug. Every bridge value must therefore be a `var(--dsw-*)` reference
 * or a `color-mix(...)` that resolves through one.
 *
 * The check covers two scopes, because a token reference is a legal reference
 * that still has to name a color that exists:
 *
 *   1. the bridge — a literal here is the historic failure mode, and the bridge
 *      is hand-written so it is where one comes back.
 *   2. the whole stylesheet — `rgba()`/`hsl()` forms, which a `#rrggbb` scan
 *      cannot see. A shadow or a scrim carrying its own alpha was exactly how
 *      the modal overlay stayed at 24% black in a theme that darkens it to 50%,
 *      so the rule has to reach those too rather than assume they are shadowed
 *      by the bridge.
 */
await check('theme-tokens', 'The token bridge carries no literal colors', () => {
  const repoRoot = path.resolve(HERE, '..', '..')
  const stylesPath = path.join(repoRoot, 'src/platform/dsh/client/styles.ts')
  assert.ok(fs.existsSync(stylesPath), `client styles are missing: ${stylesPath}`)
  const source = fs.readFileSync(stylesPath, 'utf8')

  const bridgeStart = source.indexOf('const TOKEN_BRIDGE')
  const bridgeEnd = source.indexOf('`;', bridgeStart)
  assert.ok(
    bridgeStart !== -1 && bridgeEnd > bridgeStart,
    'TOKEN_BRIDGE was not found in styles.ts — if it was renamed, update this check'
  )
  const bridge = source.slice(bridgeStart, bridgeEnd)

  const declarations = [...bridge.matchAll(/(--vscode-[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)]
  assert.ok(
    declarations.length >= 30,
    `expected the bridge to still declare its variables, found ${declarations.length}`
  )

  const problems = []
  for (const [, name, rawValue] of declarations) {
    const value = rawValue.trim()
    if (value === 'transparent') continue
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) {
      // A bare literal as the whole value is a fixed color. `#ffffff` is the
      // one exception, and it is deliberate: there is no "on-brand" token, and
      // white is the legible foreground on the brand accent in both themes.
      if (value.toLowerCase() === '#ffffff') continue
      problems.push(`${name}: literal color ${value} does not follow the light/dark switch`)
      continue
    }
    // A font stack is not a color and carries no theme decision.
    if (name === '--vscode-font-family') continue
    if (!value.includes('var(--dsw-')) {
      problems.push(`${name}: "${value}" references no --dsw-* token`)
      continue
    }
    // Inside `var()`, a literal is a fallback: it only takes effect once the
    // token is renamed, which is exactly the case the official text says must
    // degrade rather than break. Report it, and the fix is to drop it.
    //
    // Inside `color-mix()` with a token, a literal is an interpolation target
    // rather than a fallback — `#ffffff` there means "tint toward white", which
    // follows the theme because the token it mixes with does. Those are kept,
    // and only a *dark* literal in a mix would be worth a look, which the
    // token-reference requirement above already rules out.
    const inVar = /var\(\s*--dsw-[a-z0-9-]+\s*,/.test(value)
    if (inVar && /#[0-9a-fA-F]{3,8}\b/.test(value)) {
      const fallbacks = [...value.matchAll(/#([0-9a-fA-F]{3,8})\b/g)].map((m) => `#${m[1]}`)
      problems.push(
        `${name}: var() carries the literal ${fallbacks.join(', ')} as a fallback; ` +
          'a renamed token would leave light mode with a dark value — drop the fallback'
      )
    }
  }

  assert.equal(problems.length, 0, `the token bridge has ${problems.length} literal color(s):\n  - ${problems.join('\n  - ')}`)

  // The second scope: functional notation anywhere in the stylesheet. `rgb(0 0 0 / 38%)`
  // and friends resolve against nothing, so they cannot follow the theme, and a
  // `#rrggbb` scan is blind to every one of them.
  const functional = [...source.matchAll(/(?:rgba?|hsla?|oklch|color)\(([^)]*)\)/g)]
    .filter((match) => !/var\(\s*--dsw-/.test(match[1]))
    .map((match) => {
      const at = lineOf(source, match.index)
      return `${at}: ${match[0]} carries its own alpha and cannot follow the theme`
    })
  assert.equal(
    functional.length,
    0,
    `styles.ts has ${functional.length} functional color(s) outside a token:\n  - ${functional.join('\n  - ')}`
  )

  return `${declarations.length} bridge variables, all theme references; no functional colors`
})

/* ------------------------------- 10. policy -------------------------------- */

/**
 * Every registered tool is classified, and every classification is a registered tool.
 *
 * `dsh/policy.js` is what makes the registry-layer guard possible: a tool with no row is
 * denied outright (`createGuard`), so a row that goes missing is an outage and a tool that
 * ship without one is an unguarded entry point. Both directions are asserted because both
 * mistakes are silent — a stale row would let `verify` pass while the table lies about what
 * this bundle can do.
 *
 * The categories are checked too: a typo like `write_remote` would otherwise sit in the table
 * looking classified while no stage recognised it.
 */
await check('policy', 'Every tool is classified, and every classification is a tool', async () => {
  const { TOOL_POLICY, RISK_CATEGORIES } = await import('../policy.js')
  const registered = createTools({ version: manifest.version }).map((tool) => tool.name)
  const classified = Object.keys(TOOL_POLICY)

  const unclassified = registered.filter((name) => !classified.includes(name))
  const stale = classified.filter((name) => !registered.includes(name))
  assert.equal(
    unclassified.length,
    0,
    `${unclassified.length} tool(s) have no row in dsh/policy.js and would be denied at runtime: ${unclassified.join(', ')}`
  )
  assert.equal(
    stale.length,
    0,
    `${stale.length} row(s) describe tools this bundle does not register: ${stale.join(', ')}`
  )

  for (const [name, entry] of Object.entries(TOOL_POLICY)) {
    assert.ok(
      RISK_CATEGORIES.includes(entry.risk),
      `${name}: "${entry.risk}" is not one of ${RISK_CATEGORIES.join(', ')}`
    )
  }

  // The one row whose guard behaviour is load-bearing gets its flag pinned: without it,
  // `at_terminal_sftp_delete` would accept sensitive paths and the guard would be decorative.
  assert.equal(TOOL_POLICY.at_terminal_sftp_delete.guard, 'refuse-sensitive-path')
  assert.equal(TOOL_POLICY.at_terminal_get_hardware_metrics.probe, 'builtin')

  return `${classified.length} classified tool(s), ${RISK_CATEGORIES.length} risk categories`
})

/* ----------------------------------- report ----------------------------------- */

const failed = results.filter((result) => result.status === 'fail')

if (asJson) {
  console.log(JSON.stringify({ bundle: manifest.name, version: manifest.version, results }, null, 2))
} else {
  const width = Math.max(...results.map((result) => result.title.length))
  for (const result of results) {
    const tag = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' }[result.status]
    console.log(`${tag}  ${result.title.padEnd(width)}  ${result.note}`)
  }
  console.log('')
  if (failed.length === 0) {
    const skippedCount = results.filter((result) => result.status === 'skipped').length
    console.log(`verify: OK (${results.length - skippedCount} passed, ${skippedCount} skipped)`)
  } else {
    console.log(`verify: FAILED (${failed.length} of ${results.length})`)
  }
}

process.exit(failed.length === 0 ? 0 : 1)
