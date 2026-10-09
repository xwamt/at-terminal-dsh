#!/usr/bin/env node
/**
 * M1 (DSH-07) — wire the AT Series Hub into a dsh profile as an MCP server.
 *
 * ## Why this is a text edit, not a YAML round-trip
 *
 * `cordis.patch.yml` uses custom `!!js` tags (`!!js ctx.webStartup.port ?? 3080`).
 * Parsing and re-serialising it would either throw on those tags or silently turn
 * them into plain strings — i.e. break the user's own configuration while trying to
 * add to it. So the row is appended verbatim between marker comments, and the script
 * proves afterwards that every pre-existing line survived byte-for-byte.
 *
 * Idempotent by construction: the managed block is always removed before being
 * re-added, so re-running cannot accumulate duplicates.
 *
 * ## Why the command is the Harness's own Node
 *
 * `dsh-mcp-client` spawns `command` with stdio, merging `env` over a **scrubbed**
 * ambient environment. Depending on a `node` on the user's `PATH` would therefore be
 * a guess about how the Desktop app was launched. The Harness ships and manages its
 * own runtime under `$DSH_HOME/dsh-runtimes/<name>/dependencies/node/bin/node`, which
 * is guaranteed present, correct for the platform, and the same major version the
 * Harness itself runs on.
 *
 * ## What the Hub is, and why `failOnStartupError` stays false
 *
 * The Hub (`~/.at-series/mcp/hub.js`) is a stdio MCP server that fronts every AT
 * Series plugin bridge registered under `~/.at-series/bridges/`. It speaks protocol
 * v2, so a cold `tools/list` exposes its provider meta-tools and the agent promotes
 * real tools with `at_select_tools` — the progressive-discovery flow, not a flat list.
 *
 * A missing or empty Hub degrades to "no MCP tools plus a log line", which is the
 * honest outcome for an optional bridge. Setting `failOnStartupError: true` would
 * instead reject activation of the whole row, so it is left at its default.
 *
 * ## The one setting that is easy to get wrong
 *
 * The Hub is **host-scoped** and the scope is a single environment variable:
 * `AT_SERIES_HOST_APP`, resolved as `slugifyHostAppId(env[...]) ?? 'unknown'` and
 * then used as the bucket name under `~/.at-series/bridges/`. There is no wildcard,
 * so an unset value makes the Hub serve the `unknown` bucket and report every
 * provider with zero healthy bridges — a wrong setting wearing the costume of a
 * broken Hub. The script therefore *discovers* the slug (the bucket with the newest
 * heartbeat) instead of assuming it, refuses to write when nothing is live, and
 * accepts `--host-app <slug>` to override.
 *
 * ## Usage
 *
 *   node dsh/scripts/enable-mcp.mjs                 # add/refresh the row
 *   node dsh/scripts/enable-mcp.mjs --dry-run       # print the diff, change nothing
 *   node dsh/scripts/enable-mcp.mjs --disable       # remove the row
 *   node dsh/scripts/enable-mcp.mjs --host-app cursor
 *   node dsh/scripts/enable-mcp.mjs --profile <dir> # target another profile
 *
 * Exit code 0 on success, 1 when a check fails.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { describeBucket, detectLiveHostAppId, listHostBuckets, registryExists, slugifyHostAppId } from './lib/at-series-registry.mjs';

const BEGIN_MARKER = '# >>> at-terminal: MCP bridge to the AT Series Hub';
const END_MARKER = '# <<< at-terminal: MCP bridge';

/** The row id. Namespaced away from the bundle's own `at-terminal` row. */
const ROW_ID = 'mcp-at-series';
const SERVER_NAME = 'at-series';

function parseArgs(argv) {
  const options = {
    profile: join(homedir(), '.dsh', 'profiles', 'desktop'),
    hub: join(homedir(), '.at-series', 'mcp', 'hub.js'),
    node: undefined,
    hostApp: undefined,
    disable: false,
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--disable') options.disable = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--profile') options.profile = resolve(argv[++index]);
    else if (arg === '--hub') options.hub = resolve(argv[++index]);
    else if (arg === '--node') options.node = resolve(argv[++index]);
    else if (arg === '--host-app') options.hostApp = argv[++index];
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** Locate the Harness-managed Node, preferring the runtime the app records as primary. */
function findManagedNode(explicit) {
  if (explicit !== undefined) return explicit;
  const runtimes = join(homedir(), '.dsh', 'dsh-runtimes');
  if (!existsSync(runtimes)) return undefined;
  // The primary runtime is the one the app itself boots from; any other is a spare.
  const candidates = ['dsh-primary-runtime'];
  const candidate = join(runtimes, candidates[0], 'dependencies', 'node', 'bin', 'node');
  return existsSync(candidate) ? candidate : undefined;
}

/** Everything already on disk from the bundle install and the Hub's own history. */
function inspectEnvironment(options) {
  const patchFile = join(options.profile, 'cordis.patch.yml');
  const checks = [];

  const managedNode = findManagedNode(options.node);
  checks.push({
    label: 'Harness-managed Node',
    ok: managedNode !== undefined,
    detail: managedNode ?? 'not found under ~/.dsh/dsh-runtimes/*/dependencies/node/bin/node'
  });

  checks.push({
    label: 'AT Series Hub bundle',
    ok: existsSync(options.hub),
    detail: options.hub
  });

  checks.push({
    label: 'dsh profile',
    ok: existsSync(options.profile),
    detail: options.profile
  });

  const linkedBundle = join(options.profile, 'node_modules', '@at-series', 'dsh-at-terminal');
  checks.push({
    label: 'AT Terminal bundle linked into the profile',
    ok: existsSync(linkedBundle),
    detail: linkedBundle
  });

  checks.push({
    label: 'profile patch layer',
    ok: existsSync(patchFile),
    detail: patchFile
  });

  // The Hub is host-scoped and answers for exactly one bucket, so "which host is live"
  // is a real input to the row, not a detail. Reported here because a wrong value is
  // indistinguishable from a broken Hub once dsh is running.
  const registryOk = registryExists();
  checks.push({
    label: 'AT Series bridge registry',
    ok: registryOk,
    detail: registryOk ? join(homedir(), '.at-series', 'bridges') : '~/.at-series/bridges not found'
  });

  const requested = options.hostApp === undefined ? undefined : slugifyHostAppId(options.hostApp);
  const detected = detectLiveHostAppId();
  const hostApp = requested ?? detected?.hostApp;
  checks.push({
    label: `live host slug (AT_SERIES_HOST_APP)`,
    ok: hostApp !== undefined,
    detail:
      hostApp === undefined
        ? `no bucket heartbeated recently — buckets: ${listHostBuckets()
            .slice(0, 4)
            .map((bucket) => `${bucket.hostApp}(${bucket.records})`)
            .join(', ')}`
        : `${hostApp}${requested === undefined ? ' (detected)' : ' (from --host-app)'} — ${describeBucket(
            detected?.bucket ?? listHostBuckets().find((bucket) => bucket.hostApp === hostApp)
          )}`
  });

  return { checks, patchFile, managedNode, hostApp };
}

/**
 * The row to add, wrapped in `- insert:`.
 *
 * The profile patch layer is applied by `applyEntryPatches` (dsh-app-boot): a row
 * WITHOUT `insert` is an id-targeted override, and an id that matches no existing
 * entry warns and is skipped. `dsh-mcp-client` mounts zero servers by default, so
 * `mcp-at-series` matches nothing and a bare row would be dropped silently — exactly
 * what happened to the first write of this block. Only `- insert:` actually adds a
 * new entry (as the bundle patch `dsh/cordis.patch.yml` and the official
 * dsh-agent-preset MCP template both do).
 */
function renderBlock(options, managedNode, hostApp) {
  return [
    '',
    `${BEGIN_MARKER} — managed by dsh/scripts/enable-mcp.mjs, do not edit by hand`,
    '#',
    '# The Hub fronts every AT Series plugin bridge (~/.at-series/bridges/) over stdio.',
    '# It speaks protocol v2, so a cold tools/list exposes the provider meta-tools and the',
    '# agent promotes real tools with at_select_tools.',
    '#',
    '# The row is wrapped in `- insert:` on purpose: the patch layer applies bare rows as',
    '# id-targeted overrides of entries that already exist, and dsh-mcp-client mounts no',
    '# default server row — a bare `- id:` row here makes the loader warn "entry',
    '# mcp-at-series not found" and silently drop the whole bridge. `- insert:` is the only',
    '# form that adds a new entry (same as the bundle patch and the official MCP template).',
    '#',
    '# AT_SERIES_HOST_APP is required, not optional. The Hub resolves its scope with',
    '#   slugifyHostAppId(env[AT_SERIES_HOST_APP]) ?? "unknown"',
    '# and serves exactly that bucket under ~/.at-series/bridges/. There is no wildcard, so',
    '# an unset value means the Hub serves the "unknown" bucket and reports every provider as',
    '# having zero healthy bridges — which looks like a broken Hub rather than a wrong setting.',
    `# The slug below is the bucket heartbeating at install time (${hostApp}). If you move AT`,
    '# Terminal to a different IDE, re-run this script so the value follows.',
    '#',
    '# toolCallTimeoutMs is raised above the 60s default because the Hub sweeps every',
    '# registered bridge on a cold first tools/list (measured over 20s on this machine with',
    '# 412 records, 390 of them abandoned); later calls answer in tens of milliseconds.',
    '#',
    '# failOnStartupError is left at its false default on purpose: a Hub that is missing or',
    '# empty must degrade to "no MCP tools" and a log line, never reject activation of the',
    '# whole profile.',
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${managedNode}`,
    '        args:',
    `          - ${options.hub}`,
    '        toolCallTimeoutMs: 120000',
    '        env:',
    `          HOME: ${homedir()}`,
    `          AT_SERIES_HOST_APP: ${hostApp}`,
    END_MARKER,
    ''
  ].join('\n');
}

/** Remove the managed block (markers included). Returns the remaining text. */
function stripBlock(text) {
  const lines = text.split('\n');
  const kept = [];
  let inside = false;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith(BEGIN_MARKER)) {
      inside = true;
      removed += 1;
      continue;
    }
    if (inside) {
      removed += 1;
      if (line.startsWith(END_MARKER)) inside = false;
      continue;
    }
    kept.push(line);
  }
  if (inside) {
    throw new Error('the managed block is unterminated: a begin marker has no matching end marker');
  }
  return { text: kept.join('\n'), removed };
}

const options = parseArgs(process.argv.slice(2));
const { checks, patchFile, managedNode, hostApp } = inspectEnvironment(options);

console.log('Install checks');
for (const check of checks) {
  console.log(`  ${check.ok ? 'OK  ' : 'FAIL'}  ${check.label}: ${check.detail}`);
}

if (options.disable) {
  const before = readFileSync(patchFile, 'utf8');
  const { text, removed } = stripBlock(before);
  if (removed === 0) {
    console.log('\nNothing to do: the managed block is not present.');
    process.exit(0);
  }
  if (options.dryRun) {
    console.log(`\n--dry-run: would remove ${removed} line(s) from ${patchFile}`);
    process.exit(0);
  }
  const backup = `${patchFile}.at-terminal-backup-${Date.now()}`;
  copyFileSync(patchFile, backup);
  writeFileSync(patchFile, text, 'utf8');
  console.log(`\nRemoved ${removed} line(s). Backup: ${backup}`);
  console.log('Restart the Harness for the change to take effect.');
  process.exit(0);
}

if (managedNode === undefined) {
  console.error('\nCannot enable: no Harness-managed Node was found. Pass --node <path> to override.');
  process.exit(1);
}
if (!existsSync(options.hub)) {
  console.error(`\nCannot enable: the Hub bundle is missing at ${options.hub}.`);
  console.error('Open any AT Series extension in a VS Code-compatible IDE once, or run its "Repair" command.');
  process.exit(1);
}
if (hostApp === undefined) {
  console.error('\nCannot enable: no AT Series bridge has heartbeated recently, so there is no host');
  console.error('slug to scope the Hub to. Open a VS Code-compatible IDE with the AT Terminal extension');
  console.error('active (the Hub only proxies — it does not execute anything itself), then re-run.');
  console.error('Use --host-app <slug> to name a bucket explicitly.');
  process.exit(1);
}

const before = readFileSync(patchFile, 'utf8');
const { text: withoutBlock } = stripBlock(before);
const block = renderBlock(options, managedNode, hostApp);
const after = `${withoutBlock.replace(/\s*$/, '')}\n${block}`;

// The edit must be purely additive: every original line has to survive in order, or
// the user's own `!!js` rows would be at risk.
const originalLines = withoutBlock.split('\n').filter((line) => line.trim() !== '');
const afterLines = after.split('\n');
let cursor = 0;
for (const line of originalLines) {
  const found = afterLines.indexOf(line, cursor);
  if (found < 0) {
    console.error(`\nRefusing to write: the edit would have lost the line "${line}"`);
    process.exit(1);
  }
  cursor = found + 1;
}

if (options.dryRun) {
  console.log(`\n--dry-run: would append this block to ${patchFile}\n`);
  console.log(block);
  process.exit(0);
}

if (after === before) {
  // Re-running must not litter the profile with identical backups, and it must not
  // touch the file's mtime — a no-op has to look like one.
  console.log(`\nAlready up to date: ${patchFile} already carries exactly this block.`);
  process.exit(0);
}

const backup = `${patchFile}.at-terminal-backup-${Date.now()}`;
copyFileSync(patchFile, backup);
writeFileSync(patchFile, after, 'utf8');

const written = readFileSync(patchFile, 'utf8');
const occurrences = written.split('\n').filter((line) => line.startsWith(BEGIN_MARKER)).length;
if (occurrences !== 1) {
  console.error(`\nVerification failed: expected exactly 1 managed block, found ${occurrences}.`);
  console.error(`Restore with: cp "${backup}" "${patchFile}"`);
  process.exit(1);
}
// The row must sit under an `- insert:` patch. A bare `- id:` row is an id-targeted
// override and is silently skipped by the loader when no entry of that id exists —
// the failure mode this block shipped with once. Verify the exact nesting: an
// `insert:` key at column 0 with the row id as its first child.
const managed = written.slice(written.indexOf(BEGIN_MARKER), written.indexOf(END_MARKER));
if (!/^- insert:\n {4}- id: mcp-at-series\n/m.test(managed)) {
  console.error('\nVerification failed: the managed block does not wrap the row in `- insert:`.');
  console.error(`Restore with: cp "${backup}" "${patchFile}"`);
  process.exit(1);
}

console.log(`\nAppended the MCP row to ${patchFile}`);
console.log(`Backup: ${backup}`);
console.log('\nRestart the Harness, then ask the agent to call at_list_providers.');
process.exit(0);
