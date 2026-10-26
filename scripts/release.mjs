#!/usr/bin/env node
/**
 * Release both packages of this project together.
 *
 * AT Terminal ships as **two** npm packages that must go out in lockstep:
 *
 *   @at-series/dsh-at-terminal       the plugin (Host services, 17 tools, three panes)
 *   @at-series/dsh-at-terminal-ssh   the optional composition bundle
 *
 * They are not independent: the bundle references the plugin's SSH backend **by subpath**
 * (`@at-series/dsh-at-terminal/terminal-backend`), so publishing 0.3.0 of one against 0.2.0 of the
 * other resolves a backend that does not exist. That is the invariant this script exists to hold,
 * and it is why "I published the plugin" is not a release.
 *
 * Default run is **dry**: it verifies the pairing and the gates, then prints the plan. Publishing
 * needs `--publish`, because a release script that publishes when you forget a flag is a footgun.
 *
 *   node scripts/release.mjs                # check + plan
 *   node scripts/release.mjs --publish      # check + publish what is missing
 *   node scripts/release.mjs --publish --tag
 *   node scripts/release.mjs --skip-checks  # not recommended; says so
 *
 * Re-running after a partial failure is safe: a version already on the registry is skipped, not
 * republished.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const PACKAGES = [
  { dir: join(REPO, 'dsh'), role: 'plugin' },
  { dir: join(REPO, 'dsh-terminal-ssh'), role: 'optional bundle' }
]

const args = new Set(process.argv.slice(2))
const publish = args.has('--publish')
const tag = args.has('--tag')
const skipChecks = args.has('--skip-checks')

const say = (message) => process.stdout.write(`${message}\n`)
const fail = (message) => {
  process.stderr.write(`release: ${message}\n`)
  process.exit(1)
}

/** Read a package manifest. */
function manifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

/** `^1.2.3` accepts `1.2.9` but not `1.3.0`; enough for the one range this repo uses. */
function caretAccepts(range, version) {
  if (typeof range !== 'string' || !range.startsWith('^')) return false
  const [wantMajor, wantMinor] = range.slice(1).split('.')
  const [haveMajor, haveMinor] = version.split('.')
  return wantMajor === haveMajor && wantMinor === haveMinor
}

/** Run a command, streaming its output. */
function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? REPO,
    stdio: options.capture === true ? 'pipe' : 'inherit',
    encoding: 'utf8'
  })
}

/** Is this exact version already on the registry? */
function onRegistry(name, version) {
  try {
    const out = run('npm', ['view', `${name}@${version}`, 'version', '--json'], { capture: true })
    return out.trim() !== '' && out.trim() !== 'null'
  } catch {
    return false
  }
}

/* --------------------------------- checks ---------------------------------- */

say('release: reading both manifests')
const [plugin, bundle] = PACKAGES.map((entry) => manifest(entry.dir))

if (plugin.name === undefined || bundle.name === undefined) fail('a manifest has no name')
if (plugin.version !== bundle.version) {
  fail(
    `versions must match: ${plugin.name}@${plugin.version} vs ${bundle.name}@${bundle.version}.\n` +
      '         They ship together on purpose — the bundle resolves the plugin by subpath, so a\n' +
      '         mismatched pair can reference a backend that does not exist.'
  )
}
const peerRange = bundle.peerDependencies?.[plugin.name]
if (!caretAccepts(peerRange, plugin.version)) {
  fail(
    `${bundle.name} declares peerDependencies["${plugin.name}"] = ${peerRange}, which does not accept ` +
      `${plugin.version}. Update the range in the same commit as the version bump.`
  )
}

say(`release: ${plugin.name}@${plugin.version} + ${bundle.name}@${bundle.version} (peer ${peerRange})`)

/* -------------------------------- the plan --------------------------------- */

const plan = []
for (const [index, entry] of PACKAGES.entries()) {
  const name = index === 0 ? plugin.name : bundle.name
  plan.push({ name, version: plugin.version, dir: entry.dir, published: onRegistry(name, plugin.version) })
}

for (const item of plan) {
  say(`  ${item.published ? 'on registry ' : 'to publish  '} ${item.name}@${item.version}`)
}

/**
 * Is the release tag already there?
 *
 * Shared by the plan and the tag step so the dry run cannot describe a tag the real run would
 * skip — the whole point of printing a plan is that the plan is what happens.
 */
function tagExists(name) {
  try {
    run('git', ['rev-parse', '--verify', `refs/tags/${name}`], { capture: true })
    return true
  } catch {
    return false
  }
}

if (!publish) {
  /*
   * The tag is part of the plan, so the dry run has to print it.
   *
   * `--tag` used to be invisible here: this branch exits before the tag step, so a user reading
   * the plan saw two packages and no mention of the tag they asked for. Saying it up front is
   * what makes `--tag --dry-run` answerable — "would tag v0.2.0" or "tag exists".
   */
  if (tag) {
    const name = `v${plugin.version}`
    say(tagExists(name) ? `  tag exists    ${name}` : `  would tag     ${name}`)
  }
  say('release: dry run — nothing was published. Re-run with --publish when the plan looks right.')
  process.exit(0)
}

/* --------------------------------- checks ---------------------------------- */

if (skipChecks) {
  say('release: --skip-checks: gates were NOT run. A release without gates is a guess.')
} else {
  for (const [label, command, commandArgs] of [
    ['typecheck', 'npm', ['run', 'typecheck']],
    ['verify:kernel', 'npm', ['run', 'verify:kernel']],
    ['verify:dsh', 'npm', ['run', 'verify:dsh']],
    ['test', 'npm', ['test']]
  ]) {
    say(`release: ${label}`)
    try {
      run(command, commandArgs)
    } catch {
      fail(`${label} failed; nothing was published`)
    }
  }
}

/* --------------------------------- publish --------------------------------- */

for (const item of plan) {
  if (item.published) {
    say(`release: ${item.name}@${item.version} is already on the registry, skipping`)
    continue
  }
  say(`release: publishing ${item.name}@${item.version}`)
  try {
    run('npm', ['publish', '--access', 'public'], { cwd: item.dir })
  } catch {
    fail(`${item.name}@${item.version} failed to publish; re-run to continue from here`)
  }
}

/* ----------------------------------- tag ----------------------------------- */

if (tag) {
  const name = `v${plugin.version}`
  if (tagExists(name)) {
    say(`release: tag ${name} already exists, leaving it alone`)
  } else {
    run('git', ['tag', '-a', name, '-m', `AT Terminal ${plugin.version}`])
    say(`release: tagged ${name} (push it with: git push origin ${name})`)
  }
}

say('release: done')
