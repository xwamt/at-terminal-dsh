#!/usr/bin/env node
/**
 * AT Terminal — kernel-seam gate (repository level).
 *
 * `dsh/scripts/verify.mjs` audits the *bundle*: what ships, what it imports at runtime, and
 * whether the installed Harness accepts it. This script audits the *repository's kernel*,
 * which is a different subject and cannot live inside a bundle gate:
 *
 *   1. `src/core/**` is self-contained — it imports nothing above itself, so the port layer
 *      can be compiled (and reasoned about) without the domain or any host adapter. The same
 *      check rejects docblock citations of `path:line` for files this repository does not
 *      contain: those point at the VS Code variant repository, and a reader following one
 *      lands on nothing.
 *   2. No `src/**` file imports `vscode`. The domain layer must be host-agnostic; the one
 *      VS Code adapter lives in another repository, so any `vscode` import here is either a
 *      leak or a file that was never migrated. An allowed exception has to say why on its
 *      own line.
 *   3. No `src/**` file **imports** `@deepseek-ai/*`. Only *statements* count: the tree has
 *      a dozen comments that name those packages to explain why they are not imported, and
 *      a string scan would fail on the explanation. `dsh/tools.js` and `dsh/index.js` may
 *      use the vendored `@deepseek-ai/schemastery`; that rule is the bundle gate's `deps`
 *      check, not this one.
 *   4. The composition root really installs the platform. `src/platform/dsh/index.ts` builds
 *      the dsh `Platform` and must call `setPlatform()`; a root that builds it and forgets
 *      the install leaves every domain call throwing "platform not installed" at runtime,
 *      which no type check can see. (The VS Code root is `src/extension.ts` **in another
 *      repository** — this check can only cover the root that exists here.)
 *
 * Usage: node scripts/verify-kernel-seam.mjs [--json]
 *
 * No install is required beyond the repository's own `node_modules`: the TypeScript parser
 * is used to find module specifiers, so comments and template strings cannot be mistaken
 * for imports. If `typescript` is missing the gate FAILS rather than skipping — a kernel
 * gate that silently passes when it cannot run is the failure mode this file exists to end.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const SRC = path.join(REPO_ROOT, 'src')
const CORE = path.join(SRC, 'core')

/**
 * Exceptions, each of which must carry a reason. Empty by design: the two rules below are
 * the shape of the migrated tree, and the day one needs an exception is the day someone
 * should be asked why. Adding an entry here is a review event, not a config change.
 */
const ALLOWED_VSCODE_IMPORTS = Object.freeze([])
const ALLOWED_DSH_IMPORTS = Object.freeze([])

const results = []

async function check(id, title, run) {
  try {
    const note = await run()
    results.push({ id, title, status: 'pass', note: note ?? '' })
  } catch (error) {
    results.push({ id, title, status: 'fail', note: error?.message ?? String(error) })
  }
}

/** Every TypeScript file under `src/`, as repository-relative POSIX paths. */
function listSources(dir = SRC) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSources(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

const relative = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/')

/** 1-based line number of an offset. */
function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === '\n') line += 1
  return line
}

let ts

/**
 * Load the TypeScript parser, and fail loudly when it is absent.
 *
 * `ts.preProcessFile` is the compiler's own "which modules does this file reference" pass:
 * it reports `import`/`export … from`/`import()` and `require()` specifiers with their
 * offsets, and it ignores comments and ordinary strings. Re-implementing that with a regex
 * is how the previous audit ended up failing on a comment that mentioned `@deepseek-ai`.
 */
async function loadTypeScript() {
  if (ts !== undefined) return ts
  const modulePath = path.join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'typescript.js')
  if (!fs.existsSync(modulePath)) {
    throw new Error(
      'the TypeScript parser is unavailable; run `npm install` in the repository root — ' +
        'this gate reads module specifiers with the compiler, not with a regex'
    )
  }
  const loaded = await import(pathToFileURL(modulePath).href)
  ts = loaded.default ?? loaded
  return ts
}

/* ---------------------------- 1. core self-containment ---------------------------- */

/**
 * Docblock citations of the form `src/foo/bar.ts:12` (or `:12,14`, `:12-14`) are only
 * useful while the file is in this repository. The port layer was derived from the VS Code
 * variant and named its consumption sites by line, so a dozen of those citations point at
 * `src/extension.ts` — a file that has never existed here. The names stay as evidence; the
 * line numbers were dropped, and this check keeps them from coming back.
 */
function findDeadCitations(source, file) {
  const problems = []
  const pattern = /\b((?:src|test|dsh)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs)):(\d+(?:[-,]\d+)*)/g
  for (const match of source.matchAll(pattern)) {
    const cited = match[1]
    if (fs.existsSync(path.join(REPO_ROOT, cited))) continue
    problems.push(`${relative(file)}:${lineOf(source, match.index)} cites ${cited}:${match[2]}, which is not in this repository`)
  }
  return problems
}

await check('core-self-contained', 'src/core imports nothing above itself and cites only files that exist', async () => {
  const parser = await loadTypeScript()
  const problems = []
  let importCount = 0

  for (const file of listSources(CORE)) {
    const source = fs.readFileSync(file, 'utf8')
    const { importedFiles } = parser.preProcessFile(source, true, true)
    for (const imported of importedFiles) {
      if (!imported.fileName.startsWith('.')) {
        // A bare specifier from the kernel would mean the port layer depends on a package
        // the composition root has to satisfy — the one thing the layer exists to avoid.
        problems.push(`${relative(file)}:${lineOf(source, imported.pos)} imports bare specifier "${imported.fileName}"`)
        continue
      }
      importCount += 1
      const target = path.resolve(path.dirname(file), imported.fileName)
      const inside = target === path.dirname(target) || target.startsWith(CORE + path.sep)
      if (!inside) {
        problems.push(
          `${relative(file)}:${lineOf(source, imported.pos)} imports "${imported.fileName}", which resolves outside src/core`
        )
      }
    }
    problems.push(...findDeadCitations(source, file))
  }

  // The remaining dead citations (if any) live outside the kernel, but they are the same
  // defect and the same fix, so they are reported by this check rather than a fifth one.
  for (const file of listSources(SRC)) {
    if (file.startsWith(CORE + path.sep)) continue
    problems.push(...findDeadCitations(fs.readFileSync(file, 'utf8'), file))
  }

  if (problems.length > 0) {
    throw new Error(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`)
  }
  return `${listSources(CORE).length} kernel file(s), ${importCount} intra-kernel import(s), no dead citations`
})

/* ------------------------------- 2. no vscode -------------------------------- */

await check('no-vscode', 'No src file imports vscode', async () => {
  const parser = await loadTypeScript()
  const problems = []
  let scanned = 0

  for (const file of listSources(SRC)) {
    const source = fs.readFileSync(file, 'utf8')
    scanned += 1
    for (const imported of parser.preProcessFile(source, true, true).importedFiles) {
      if (imported.fileName !== 'vscode') continue
      const line = lineOf(source, imported.pos)
      const text = source.split('\n')[line - 1] ?? ''
      if (ALLOWED_VSCODE_IMPORTS.some((entry) => entry.file === relative(file)) && /kernel-allow:\s*\S+/.test(text)) {
        continue
      }
      problems.push(`${relative(file)}:${line} imports "vscode" without a documented kernel-allow reason`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`${problems.length} host import(s):\n  - ${problems.join('\n  - ')}`)
  }
  return `${scanned} file(s) scanned, 0 vscode import(s)`
})

/* ---------------------------- 3. no @deepseek-ai imports ---------------------------- */

await check('no-dsh-imports', 'No src file imports @deepseek-ai/* (comments may name them)', async () => {
  const parser = await loadTypeScript()
  const problems = []
  const mentions = []

  for (const file of listSources(SRC)) {
    const source = fs.readFileSync(file, 'utf8')
    const { importedFiles } = parser.preProcessFile(source, true, true)
    const importedNames = new Set(importedFiles.map((entry) => entry.fileName))
    for (const imported of importedFiles) {
      if (!imported.fileName.startsWith('@deepseek-ai/')) continue
      const line = lineOf(source, imported.pos)
      const text = source.split('\n')[line - 1] ?? ''
      if (ALLOWED_DSH_IMPORTS.some((entry) => entry.specifier === imported.fileName) && /kernel-allow:\s*\S+/.test(text)) {
        continue
      }
      problems.push(`${relative(file)}:${line} imports "${imported.fileName}" — host packages are reached through ctx, never imported`)
    }
    // Comments naming a host package are the explanation, not the violation; count them so
    // the note shows the distinction was actually exercised.
    for (const match of source.matchAll(/@deepseek-ai\/[a-z0-9-]+/g)) {
      if (!importedNames.has(match[0])) mentions.push(match[0])
    }
  }

  if (problems.length > 0) {
    throw new Error(`${problems.length} host import(s):\n  - ${problems.join('\n  - ')}`)
  }
  return `0 import statement(s); ${mentions.length} comment mention(s) ignored`
})

/* ---------------------------- 4. composition root installs ---------------------------- */

await check('composition-root', 'The dsh composition root calls setPlatform()', async () => {
  const parser = await loadTypeScript()
  const roots = []
  for (const file of listSources(SRC)) {
    const source = fs.readFileSync(file, 'utf8')
    const builder = /export\s+(?:async\s+)?function\s+(create[A-Za-z]*Platform)\s*\(/.exec(source)
    if (builder !== null) roots.push({ file, source, builder: builder[1] })
  }

  if (roots.length === 0) {
    throw new Error(
      'no composition root found: expected an exported createXxxPlatform() under src/platform — ' +
        'a gate that finds nothing to check must not report success'
    )
  }

  /**
   * `setPlatform(...)` as a **call expression**, found through the AST.
   *
   * A text search is not enough, and the reverse test proved it: commenting the call out
   * left `// setPlatform(platform);` in the file and a plain regexp still matched it — the
   * gate would have passed on the exact defect it exists to catch.
   */
  const callsSetPlatform = (source, file) => {
    const ast = parser.createSourceFile(file, source, parser.ScriptTarget.Latest, true)
    let found = false
    const visit = (node) => {
      if (found) return
      if (
        parser.isCallExpression(node) &&
        parser.isIdentifier(node.expression) &&
        node.expression.text === 'setPlatform'
      ) {
        found = true
        return
      }
      parser.forEachChild(node, visit)
    }
    visit(ast)
    return found
  }

  const problems = []
  for (const root of roots) {
    if (!callsSetPlatform(root.source, root.file)) {
      problems.push(`${relative(root.file)}: ${root.builder}() builds a Platform but never calls setPlatform()`)
    }
  }
  if (problems.length > 0) throw new Error(`${problems.join('; ')}`)

  return roots.map((root) => `${relative(root.file)} -> ${root.builder}() + setPlatform()`).join(', ')
})

/* ----------------------------------- report ----------------------------------- */

const asJson = process.argv.includes('--json')
const failed = results.filter((result) => result.status === 'fail')

if (asJson) {
  console.log(JSON.stringify({ gate: 'kernel-seam', results }, null, 2))
} else {
  const width = Math.max(...results.map((result) => result.title.length))
  for (const result of results) {
    const tag = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' }[result.status]
    console.log(`${tag}  ${result.title.padEnd(width)}  ${result.note}`)
  }
  console.log('')
  console.log(failed.length === 0 ? `verify:kernel: OK (${results.length} passed)` : `verify:kernel: FAILED (${failed.length} of ${results.length})`)
}

process.exit(failed.length === 0 ? 0 : 1)
