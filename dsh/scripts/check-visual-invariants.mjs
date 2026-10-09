#!/usr/bin/env node
/**
 * AT Terminal — dsh client visual invariants.
 *
 * `verify.mjs` answers "does this bundle load and does its contract hold". It does not
 * answer "does the panel still *look* right", because almost every visual regression here
 * is silent: nothing throws, no test turns red, the plugin loads fine — a glyph loses
 * `aria-hidden`, a status-bar path stops splitting into two halves, an empty state loses
 * its only button, and the only symptom is that the panel reads wrong to somebody looking
 * at it. Those were found by eye across U0–U4, which does not scale: the next edit has no
 * way to know which eyes were run.
 *
 * So this script pins the invariants that are *statically* decidable. It is deliberately
 * small and deliberately dumb — no parser, no bundler, no rendering. Everything below is a
 * property of the source text.
 *
 *   1. icons-aria   — every exported glyph reaches an `<svg>` carrying `aria-hidden`
 *   2. icons-color  — no literal color anywhere under `icons/`
 *   3. statusbar-path — `.att-dir-base` / `.att-dir-leaf` are defined, used, and are
 *                     **direct children** of `.att-dir` (the flex rule depends on it)
 *   4. empty-state-exits — `sftp.noTerminal` and `sftp.disconnected` each keep a button
 *   5. panel-ids    — all three `navPanelId()` panels exist, so no `aria-controls` dangles
 *   6. reduced-motion — the degradation block exists and actually stops the animation
 *   7. bridge-gate  — `verify.mjs` still carries its `theme-tokens` check
 *
 * ## What this script is NOT
 *
 * It checks *structure*, never *appearance*. Six of the ten items in
 * `docs/research/2026-10-07-dsh-视觉回归清单.md` are `[需真机]`: contrast ratios as
 * rendered, whether the 16px rack glyph still reads as two bays, whether the light-theme
 * fade looks natural. A passing run here is a floor, not a sign-off — read the note on each
 * PASS line before treating it as evidence.
 *
 * ## On check 7 and the token bridge
 *
 * The "no literal fallback in the token bridge" rule already exists, as `verify.mjs`'s
 * ninth check (`theme-tokens`). It is **referenced, not duplicated**, on purpose: a second
 * implementation of the same rule would be a second opinion that can drift, and the two
 * would then disagree about what a fallback is. Check 7 therefore does not re-scan the
 * bridge — it asserts `verify.mjs` still declares the check, so the gate cannot be deleted
 * silently while this file keeps citing it. The rule itself runs in `verify:dsh`.
 *
 * ## On SKIP (铁律三)
 *
 * Every check here is pure static analysis over files in this repository. **None of them
 * read `app.asar` or any installed dsh package**, so there is no environment in which they
 * cannot answer, and none of them can report SKIP. That is a property of the design, not
 * an omission: if a future check needs the Harness install, it must report SKIP on a
 * missing install rather than PASS — see `verify.mjs` checks 5 and 6 for the pattern.
 *
 * ## Reverse testing (铁律二)
 *
 * A gate that has never failed is not a gate. Each check below was verified by breaking the
 * thing it watches, confirming a FAIL naming the real cause, then restoring **by reading the
 * content back** — not by restoring a diff. See the reverse-test log in the checklist doc.
 *
 * Usage: node dsh/scripts/check-visual-invariants.mjs [--json]
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const CLIENT = path.join(REPO_ROOT, 'src/platform/dsh/client')
const ICONS_DIR = path.join(CLIENT, 'icons')

const argv = process.argv.slice(2)
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

function read(file) {
  assert.ok(fs.existsSync(file), `file not found: ${path.relative(REPO_ROOT, file)}`)
  return fs.readFileSync(file, 'utf8')
}

/** 1-based line number of an offset, for diagnostics. */
function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === '\n') line += 1
  return line
}

/**
 * Drop `//` and block comments, preserving offsets by replacing them with spaces.
 *
 * Needed because a *comment* naming a color (`#ff0000 does not follow the switch`) is
 * documentation, whereas the same literal in code is a bug. Scanning raw text would fail
 * the build for the sentence explaining the rule.
 */
function stripComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      const end = nl === -1 ? source.length : nl
      out += ' '.repeat(end - i)
      i = end
    } else if (source[i] === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? source.length : close + 2
      out += source.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
    } else {
      out += source[i]
      i += 1
    }
  }
  return out
}

/**
 * Index just past the `)` closing the parameter list that starts at `open` (the `(`),
 * skipping over nested parens, braces, brackets and string/template literals.
 *
 * Needed because a parameter list can contain an inline object *type*
 * (`options: { name: string }`), whose braces would otherwise be mistaken for a body.
 */
function pastParameterList(source, open) {
  let i = open
  let d = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '(' || c === '{' || c === '[') d += 1
    else if (c === ')' || c === '}' || c === ']') {
      d -= 1
      if (d === 0) return i
    } else if (c === "'" || c === '"' || c === '`') {
      i = skipLiteral(source, i) - 1
    } else if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      i = close === -1 ? source.length : close + 1
    }
    i += 1
  }
  throw new Error('unbalanced parameter list')
}

/**
 * Index just past the literal (string or template) starting at `open`. Template `${}` holes
 * are stepped over as code so a `)` inside one cannot close an enclosing call early.
 */
function skipLiteral(source, open) {
  const quote = source[open]
  let i = open + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') i += 2
    else if (quote === '`' && c === '$' && source[i + 1] === '{') {
      let d = 0
      i += 1
      while (i < source.length) {
        const inner = source[i]
        if (inner === '{') d += 1
        else if (inner === '}') {
          d -= 1
          if (d === 0) break
        } else if (inner === "'" || inner === '"' || inner === '`') i = skipLiteral(source, i) - 1
        i += 1
      }
      i += 1
    } else if (c === quote) return i + 1
    else if (quote !== '`' && c === '\n') return i
    else i += 1
  }
  return i
}

/**
 * The `call(` invocation whose argument list encloses `anchor`, as `{ start, end, text }`.
 *
 * Candidates are tried from the nearest `name(` before the anchor outwards, and the first
 * one whose balanced argument list actually spans the anchor wins — so a `h(` inside the
 * same expression cannot shadow the real enclosing call.
 */
function enclosingCall(source, anchor, name = 'h') {
  const opener = new RegExp(`\\b${name}\\(`, 'g')
  const candidates = []
  for (let m = opener.exec(source); m !== null && m.index < anchor; m = opener.exec(source)) {
    candidates.push(m.index)
  }

  for (let k = candidates.length - 1; k >= 0; k -= 1) {
    const start = candidates[k]
    let d = 0
    let i = start + name.length
    while (i < source.length) {
      const c = source[i]
      if (c === '(' || c === '{' || c === '[') d += 1
      else if (c === ')' || c === '}' || c === ']') {
        d -= 1
        if (d === 0) {
          if (i > anchor) return { start, end: i, text: source.slice(start, i + 1) }
          break
        }
      } else if (c === "'" || c === '"' || c === '`') {
        i = skipLiteral(source, i) - 1
      } else if (c === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i)
        i = nl === -1 ? source.length : nl
      } else if (c === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2)
        i = close === -1 ? source.length : close + 1
      }
      i += 1
    }
  }
  throw new Error(`could not find the enclosing ${name}( call before offset ${anchor}`)
}

/**
 * The top-level arguments of a call's text, i.e. the ones a call site passes directly.
 *
 * This is what makes "direct child" checkable: a `.att-dir-base` nested inside another
 * element's props would sit at depth 2 and not appear as its own argument.
 */
function splitArguments(text) {
  const open = text.indexOf('(')
  const args = []
  let depth = 0
  let start = open + 1
  let i = open + 1
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipLiteral(text, i)
      continue
    }
    if (c === '(' || c === '{' || c === '[') depth += 1
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) {
        args.push(text.slice(start, i))
        return args
      }
      depth -= 1
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  return args
}

/** Body of `function <name>(...) { ... }` (exported or not), by brace matching. */
function functionBody(source, name) {
  const sig = new RegExp(`(?:^|[\\n;}])\\s*(?:export\\s+)?(?:async\\s+)?function \\*?${name}\\s*\\(`).exec(source)
  assert.ok(sig !== null, `function ${name}() was not found`)
  const parenOpen = sig.index + sig[0].length - 1
  const open = source.indexOf('{', pastParameterList(source, parenOpen))
  assert.ok(open !== -1, `${name}(): no body`)
  let d = 0
  for (let i = open; i < source.length; i += 1) {
    const c = source[i]
    if (c === '{') d += 1
    else if (c === '}') {
      d -= 1
      if (d === 0) return { body: source.slice(open + 1, i), start: open }
    } else if (c === "'" || c === '"' || c === '`') {
      i = skipLiteral(source, i) - 1
    }
  }
  throw new Error(`${name}(): unbalanced braces`)
}

/* ------------------------------- 1 & 2. icons -------------------------------- */

/**
 * Check 1 — every glyph is `aria-hidden`, and check 2 — no literal color.
 *
 * These are one walk over one directory because the same file supplies the evidence for
 * both, and because the two defects have the same shape: a glyph is correct only if its
 * `<svg>` frame is built by `frame.ts`, which is where `aria-hidden`, `currentColor` and
 * the `--dsw-*` fills are decided. A glyph that built its own `<svg>` would escape both.
 *
 * Why `aria-hidden` at all: every glyph in this panel sits beside a label that already
 * names it, so exposing the glyph makes a screen reader say the same thing twice. The
 * corollary the panel relies on is that an icon-only control supplies its own name — which
 * is why this check asserts the *glyph* is hidden rather than that every icon has a label.
 *
 * Why no literal color: a hardcoded hex cannot follow the light/dark switch. This is the
 * same rule `verify.mjs` enforces on the token bridge (its `theme-tokens` check), applied
 * to the artwork — a glyph that paints itself `#808080` is a fixed color in both themes,
 * and the panel's icons are the one thing a user cannot restyle.
 */
await check('icons-aria', 'Every glyph reaches an aria-hidden, token-colored <svg>', () => {
  assert.ok(fs.existsSync(ICONS_DIR), `icon directory not found: ${ICONS_DIR}`)
  const frameSource = stripComments(read(path.join(ICONS_DIR, 'frame.ts')))

  // The frame is the single place the two attributes are set, so it is checked as such:
  // both builders must exist and both must set aria-hidden. Missing either is the defect.
  const builders = ['lineIcon', 'plateIcon']
  for (const name of builders) {
    const { body } = functionBody(frameSource, name)
    assert.ok(
      body.includes("'aria-hidden'") || body.includes('"aria-hidden"'),
      `frame.ts ${name}(): the <svg> it builds has no aria-hidden — every glyph routed through it ` +
        'would be announced twice by a screen reader'
    )
  }

  // Every glyph module: each exported function must reach one of the frame builders,
  // directly or through a file-local helper. Delegation is what makes check 1 meaningful —
  // a glyph that assembled its own `<svg>` would still have no aria-hidden, and would be
  // invisible to the loop above.
  //
  // The indirection is real and deliberate: `file.ts` routes both weights through one
  // `filePlate()`, and `server.ts` through `serverLine(strokeWidth, options)`, because
  // `Medium` is defined as *the same geometry* at a different width. So the walk follows
  // local calls rather than demanding the frame builder appear in the exported body.
  const files = fs
    .readdirSync(ICONS_DIR)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts' && name !== 'frame.ts')
    .sort()

  const glyphs = []
  const escaped = []
  for (const file of files) {
    const raw = read(path.join(ICONS_DIR, file))
    const source = stripComments(raw)
    const exported = [...source.matchAll(/export function (\w+)\s*\(/g)].map((m) => m[1])
    assert.ok(exported.length > 0, `icons/${file} exports no glyph function`)

    // Every function defined in this file, exported or not: the delegation chain.
    const local = new Map()
    for (const m of source.matchAll(/(?:^|\n)(?:export )?function (\w+)\s*\(/g)) {
      local.set(m[1], functionBody(source, m[1]).body)
    }

    const reachesFrame = (name, seen = new Set()) => {
      if (seen.has(name)) return false
      seen.add(name)
      const body = local.get(name)
      if (body === undefined) return false
      if (/\b(?:line|plate)Icon\s*\(/.test(body)) return true
      for (const m of body.matchAll(/\b(\w+)\s*\(/g)) {
        if (local.has(m[1]) && reachesFrame(m[1], seen)) return true
      }
      return false
    }

    for (const name of exported) {
      glyphs.push(`${file}:${name}`)
      if (!reachesFrame(name)) {
        escaped.push(`${file}:${name} (line ${lineOf(source, source.indexOf(name))})`)
      }
    }
  }

  assert.ok(glyphs.length >= 12, `expected at least 12 exported glyphs, found ${glyphs.length}`)
  assert.deepEqual(
    escaped,
    [],
    `these glyphs do not go through frame.ts's lineIcon()/plateIcon(), so nothing forces ` +
      `aria-hidden or currentColor on them:\n  ${escaped.join('\n  ')}`
  )

  return `${glyphs.length} glyphs via ${builders.length} frame builders, all aria-hidden`
})

await check('icons-color', 'No literal color under icons/', () => {
  const files = fs
    .readdirSync(ICONS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()

  const problems = []
  let scanned = 0
  for (const file of files) {
    const source = stripComments(read(path.join(ICONS_DIR, file)))
    scanned += 1
    // Hex first. `{3,8}` covers #abc and #aabbccdd; a word boundary keeps `#fff` from
    // matching inside a longer identifier.
    for (const m of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      problems.push(`${file}:${lineOf(source, m.index)}  ${m[0]} is a literal color`)
    }
    // rgb()/hsl() are the same defect spelled differently, and an artist reaching for
    // `rgb(0 0 0 / 50%)` instead of a hex would otherwise walk straight past.
    for (const m of source.matchAll(/\b(?:rgba?|hsla?)\s*\(/g)) {
      problems.push(`${file}:${lineOf(source, m.index)}  ${m[0]} is a literal color`)
    }
  }

  assert.equal(
    problems.length,
    0,
    `icons/ carries ${problems.length} literal color(s); artwork must use currentColor or a ` +
      `--dsw-alias-* token so it follows the light/dark switch:\n  ${problems.join('\n  ')}`
  )
  return `${scanned} file(s), no literal color`
})

/* ------------------------------ 3. status bar path --------------------------- */

/**
 * Check 3 — the status bar's path really splits into two halves, at the right depth.
 *
 * The visible bug this prevents: a long path gets its **head** cut off (`ellipsis` at the
 * end drops `/root/…` and keeps a long file name — information value exactly inverted),
 * fixed in U3 by splitting the label into a dimmed base and a foreground leaf and fading
 * the base out on the left.
 *
 * The non-obvious half of the invariant is *directness*. `.att-dir > * { flex: 0 0 auto; }`
 * is what makes the row overflow so the clip happens at all; the comment in `styles.ts`
 * says a segment that could be squeezed would stop the row overflowing, putting the fade in
 * the wrong place. A child selector only reaches **direct** children — wrap the two spans
 * in a plain `<div>` to group them and the rule silently stops matching, nothing throws,
 * and the fade quietly dies. So this checks the DOM shape in `pathLabel()`, not merely
 * that the class names appear somewhere in the file.
 */
await check('statusbar-path', 'The status-bar path label splits into base + leaf under .att-dir', () => {
  const styles = stripComments(read(path.join(CLIENT, 'styles.ts')))
  const sharedPath = path.join(CLIENT, 'views/shared.ts')
  const shared = stripComments(read(sharedPath))

  for (const className of ['att-dir-base', 'att-dir-leaf']) {
    assert.ok(
      new RegExp(`\\.${className}\\s*\\{`).test(styles),
      `styles.ts defines no .${className} rule — the half it styles would render unstyled`
    )
  }
  // The `> *` rule is what the directness requirement exists to protect.
  assert.ok(
    /\.att-dir\s*>\s*\*\s*\{/.test(styles),
    'styles.ts has no `.att-dir > *` rule; the segments have no floor, so a long path would ' +
      'compress the row instead of overflowing it and the left-hand fade would never appear'
  )

  const anchor = shared.indexOf('function pathLabel')
  assert.ok(anchor !== -1, 'pathLabel() was not found in shared.ts — if it was renamed, update this check')
  const dirAt = shared.indexOf("'att-dir'", anchor)
  assert.ok(dirAt !== -1, "pathLabel() no longer renders a .att-dir element")
  const { text: call } = enclosingCall(shared, dirAt)

  const halves = ['att-dir-base', 'att-dir-leaf']
  // Direct children are exactly the call's own arguments: a half nested one element deeper
  // would be text inside another argument, not an argument itself.
  const args = splitArguments(call)
  const direct = args.filter((arg) => halves.some((className) => arg.includes(`'${className}'`)))
  const missing = halves.filter(
    (className) => !direct.some((arg) => arg.includes(`'${className}'`))
  )

  assert.deepEqual(
    missing,
    [],
    `pathLabel() does not render ${missing.join(' and ')} as a direct child of .att-dir; a missing ` +
      'half means the path is one undifferentiated string again'
  )
  assert.equal(
    direct.length,
    halves.length,
    `.att-dir renders only ${direct.length} of its ${halves.length} halves as direct children; a half ` +
      'nested inside another element is unreachable by the `.att-dir > *` flex floor'
  )

  return `2 halves as direct children of .att-dir, both styled, > * floor present`
})

/* ----------------------------- 4. empty-state exits --------------------------- */

/**
 * Check 4 — the two empty states keep a way out.
 *
 * U4 added these buttons, and the reason they exist is the point: an empty state that names
 * a fix the user cannot reach is an explanation with no exit. `sftp.noTerminal` says
 * "connect a server on the Terminal page" — so it must carry a button that goes there;
 * `sftp.disconnected` says reconnection is needed — so it must carry one too.
 *
 * Scope is deliberately just *a button exists inside the node that renders this string*.
 * What the button does, and whether the action works, is a `[需真机]` item in the checklist;
 * this only keeps the affordance from being deleted in a refactor that only looks like
 * copyediting.
 */
await check('empty-state-exits', 'Both sftp empty states keep an action button', () => {
  const sftpPath = path.join(CLIENT, 'views/sftp.ts')
  const sftp = stripComments(read(sftpPath))

  const states = [
    { key: 'sftp.noTerminal', node: 'att-hint' },
    { key: 'sftp.disconnected', node: 'att-banner info' }
  ]

  const found = []
  const problems = []
  for (const { key, node } of states) {
    const at = sftp.indexOf(`t('${key}')`)
    if (at === -1) {
      problems.push(`${key} is never rendered — the empty state it names is gone`)
      continue
    }
    // The node is the `h(` call wrapping this string; walk out to it and look inside.
    const { text } = enclosingCall(sftp, at)
    if (!/['"]button['"]/.test(text)) {
      problems.push(
        `${key} renders with no <button> (line ${lineOf(sftp, at)}): it tells the user what to ` +
          'fix but offers no way to do it'
      )
      continue
    }
    if (!text.includes(node)) {
      problems.push(`${key} no longer renders through .${node.split(' ')[0]}; check it is still the same state`)
      continue
    }
    found.push(`${key} → button`)
  }

  assert.deepEqual(problems, [], problems.join('\n'))
  return found.join(', ')
})

/* ------------------------------- 5. panel ids -------------------------------- */

/**
 * Check 5 — every `navPanelId()` a nav points at actually exists.
 *
 * This one is here because it already happened. In U1 the tablist was given
 * `role="tab"` and `aria-controls="at-panel-terminal"`, and `terminal.ts` had never been
 * given a matching `id` — a real dangling reference, found by grep rather than by review.
 * Nothing about it is visible on screen; it only misreports the panel to assistive
 * technology.
 *
 * The same U1 round found the reason a naive check would be wrong: all three pages stay
 * mounted at once (an inactive page is `hidden`, not unmounted) and each renders its own
 * nav. So **tab** ids must be scoped per page — `navTabId(scope, mode)` — while **panel**
 * ids must not be, because there is genuinely one panel per mode. This check pins the
 * panel side: three `navPanelId()` call sites, exactly one definition each, and the mode
 * union has to be exactly those three, or a fourth page would point at nothing.
 */
await check('panel-ids', 'All three navPanelId panels are defined exactly once', () => {
  const viewsDir = path.join(CLIENT, 'views')
  const shared = stripComments(read(path.join(viewsDir, 'shared.ts')))

  const union = /export type PanelMode\s*=\s*([^;]+);/.exec(shared)
  assert.ok(union !== null, 'PanelMode was not found in shared.ts — if it moved, update this check')
  const modes = [...union[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    modes,
    ['assets', 'sftp', 'terminal'],
    `PanelMode must be exactly assets|sftp|terminal, got: ${modes.join('|')}`
  )

  const duplicates = []
  const missing = []
  let definitions = 0
  for (const mode of modes) {
    const hits = []
    for (const file of fs.readdirSync(viewsDir).filter((n) => n.endsWith('.ts'))) {
      const source = stripComments(read(path.join(viewsDir, file)))
      for (const m of source.matchAll(new RegExp(`id:\\s*navPanelId\\(\\s*'${mode}'\\s*\\)`, 'g'))) {
        hits.push(`${file}:${lineOf(source, m.index)}`)
      }
    }
    if (hits.length === 0) missing.push(`at-panel-${mode} (nothing renders id: navPanelId('${mode}'))`)
    else if (hits.length > 1) duplicates.push(`at-panel-${mode} defined ${hits.length}×: ${hits.join(', ')}`);
    definitions += hits.length
  }

  assert.deepEqual(missing, [], `these panels are never rendered, so aria-controls dangles:\n  ${missing.join('\n  ')}`)
  assert.deepEqual(
    duplicates,
    [],
    `a duplicated id makes aria-controls resolve to whichever copy mounts first:\n  ${duplicates.join('\n  ')}`
  )

  // And the nav must actually point at them, or the definition is decoration.
  const navAt = shared.indexOf('export function renderNav')
  assert.ok(navAt !== -1, 'renderNav() was not found in shared.ts')
  assert.ok(
    shared.includes("'aria-controls': navPanelId(value)"),
    'renderNav() no longer sets aria-controls from navPanelId(); the tabs would name nothing'
  )

  return `${modes.length} panels (${modes.map((m) => `at-panel-${m}`).join(', ')}), each defined once`
})

/* ------------------------------ 6. reduced motion ---------------------------- */

/**
 * Check 6 — the reduced-motion degradation exists *and does something*.
 *
 * Two failure modes, and the second is the one worth guarding: a `@media
 * (prefers-reduced-motion: reduce)` block can exist, look deliberate, and contain nothing
 * that stops motion — so the check requires a declaration that actually halts an animation
 * rather than merely the presence of the block.
 *
 * What it must produce, per the plan and the official convention: the spinner stops being a
 * spinner and becomes a **static 6px dot**, not a dimmer ring. At 6px a ring is
 * indistinguishable from a speck, so a "reduced" ring would still be an animation cue that
 * happens to be less obvious. The opacity fade is deliberately left alone — a fade is not
 * motion, and dropping it would restore the flash the pending class exists to suppress.
 */
await check('reduced-motion', 'prefers-reduced-motion stops the spinner', () => {
  const stylesPath = path.join(CLIENT, 'styles.ts')
  const raw = read(stylesPath)
  const styles = stripComments(raw)

  const at = styles.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.ok(at !== -1, 'styles.ts has no @media (prefers-reduced-motion: reduce) block at all')

  const open = styles.indexOf('{', at)
  assert.ok(open !== -1, 'the reduced-motion block is unterminated')
  let d = 0
  let end = -1
  for (let i = open; i < styles.length; i += 1) {
    if (styles[i] === '{') d += 1
    else if (styles[i] === '}') {
      d -= 1
      if (d === 0) {
        end = i
        break
      }
    }
  }
  assert.ok(end !== -1, 'the reduced-motion block is unbalanced')
  const block = styles.slice(open, end + 1)

  const halts = [
    /animation\s*:\s*none/,
    /animation-name\s*:\s*none/,
    /animation-duration\s*:\s*0(?:s|ms)?\b/,
    /animation\s*:\s*0(?:s|ms)\b/,
    /transition\s*:\s*none/,
    /transition-duration\s*:\s*0(?:s|ms)?\b/
  ]
  assert.ok(
    halts.some((re) => re.test(block)),
    'the reduced-motion block exists but declares nothing that stops an animation — it would ' +
      'document the intent while leaving the spinner turning'
  )

  assert.ok(
    /\.att-spinner\b/.test(block),
    'the reduced-motion block does not mention .att-spinner, which is the only rotating ' +
      'element in this panel'
  )
  assert.ok(
    /animation\s*:\s*none/.test(block),
    '.att-spinner is not given `animation: none` under reduced motion'
  )

  return `block at styles.ts:${lineOf(styles, at)}, spinner animation halted`
})

/* ------------------------------ 7. bridge gate ------------------------------- */

/**
 * Check 7 — `verify.mjs` still carries its `theme-tokens` check.
 *
 * The bridge rule (no literal color or `var()` fallback in `--vscode-*`) is **not repeated
 * here on purpose**: two implementations of one rule drift, and then disagree about what a
 * fallback is. This file cites it, so this file asserts it is still there — a citation that
 * outlives its referent is worse than no gate, because it reads as coverage.
 *
 * The rule itself is not the concern of this script's other six checks: it is about the
 * token bridge in `styles.ts`, not about markup, and `verify:dsh` already runs it.
 */
await check('bridge-gate', 'verify.mjs still declares the theme-tokens check', () => {
  const verifyPath = path.join(HERE, 'verify.mjs')
  assert.ok(fs.existsSync(verifyPath), `verify.mjs not found at ${verifyPath}`)
  const verify = read(verifyPath)

  const decl = /check\(\s*'theme-tokens'/.exec(verify)
  assert.ok(decl !== null, "verify.mjs no longer declares a 'theme-tokens' check")

  assert.ok(
    verify.includes('const TOKEN_BRIDGE'),
    "verify.mjs's bridge check no longer reads TOKEN_BRIDGE; it may be auditing nothing"
  )

  // A check whose body was emptied would still match the declaration above.
  const start = verify.indexOf(decl[0])
  const nextCheck = verify.indexOf("\nawait check('", start + 1)
  const body = verify.slice(start, nextCheck === -1 ? undefined : nextCheck)
  assert.ok(
    body.includes('declarations') && body.includes('problems'),
    "verify.mjs's theme-tokens check has no declaration scan in it — it passes vacuously"
  )

  return `declared at verify.mjs:${lineOf(verify, start)} (rule itself runs in verify:dsh)`
})

/* ---------------------------------- report ----------------------------------- */

const failed = results.filter((result) => result.status === 'fail')

if (asJson) {
  console.log(JSON.stringify({ script: 'check-visual-invariants', results }, null, 2))
} else {
  const width = Math.max(...results.map((result) => result.title.length))
  for (const result of results) {
    const tag = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' }[result.status]
    console.log(`${tag}  ${result.title.padEnd(width)}  ${result.note}`)
  }
  console.log('')
  if (failed.length === 0) {
    console.log(`visual-invariants: OK (${results.length} passed)`)
    console.log('note: structure only — the [需真机] items in the checklist still need eyes on them.')
  } else {
    console.log(`visual-invariants: FAILED (${failed.length} of ${results.length})`)
  }
}

process.exit(failed.length === 0 ? 0 : 1)