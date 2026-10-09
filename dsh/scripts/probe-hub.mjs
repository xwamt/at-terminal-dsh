#!/usr/bin/env node
/**
 * Is the AT Series Hub actually exposing tools? — the M1 diagnostic.
 *
 * When the Agent in dsh reports no MCP tools (or the first call times out), the
 * question is always one of three, and this script answers all of them without
 * involving dsh:
 *
 *   1. can the Hub be started at all, with the exact `command` the profile row uses?
 *   2. how long does its cold `tools/list` take? (the Hub sweeps every registered
 *      bridge on a cold start, so this is the number that decides `toolCallTimeoutMs`)
 *   3. which providers and tools does it see?
 *
 * It speaks MCP over stdio directly, so it is also the check to run *before*
 * believing a dsh-side error message.
 *
 *   node dsh/scripts/probe-hub.mjs
 *   node dsh/scripts/probe-hub.mjs --hub <path> --node <path>
 *
 * Exit code 0 when the Hub answered, 1 when it did not.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describeBucket, detectLiveHostAppId, listHostBuckets, slugifyHostAppId } from './lib/at-series-registry.mjs';

const REQUEST_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const options = {
    hub: join(homedir(), '.at-series', 'mcp', 'hub.js'),
    node: join(
      homedir(),
      '.dsh',
      'dsh-runtimes',
      'dsh-primary-runtime',
      'dependencies',
      'node',
      'bin',
      'node'
    ),
    hostApp: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--hub') options.hub = argv[++index];
    else if (argv[index] === '--node') options.node = argv[++index];
    else if (argv[index] === '--host-app') options.hostApp = argv[++index];
    else {
      console.error(`unknown argument: ${argv[index]}`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
for (const [label, path] of [
  ['Hub bundle', options.hub],
  ['Harness-managed Node', options.node]
]) {
  if (!existsSync(path)) {
    console.error(`FAIL  ${label} is missing: ${path}`);
    process.exit(1);
  }
  console.log(`OK    ${label}: ${path}`);
}

/**
 * The Hub serves exactly one host bucket, chosen by `AT_SERIES_HOST_APP`, and reports
 * zero healthy bridges for every other bucket. Launching it without the variable is
 * therefore the most common way to conclude "the Hub is broken" when it is not — so
 * this probe resolves the slug the same way `enable-mcp.mjs` does, and says so out
 * loud when it had to fall back.
 */
const override = options.hostApp === undefined ? undefined : slugifyHostAppId(options.hostApp);
const detected = detectLiveHostAppId();
const hostApp = override ?? detected?.hostApp ?? 'unknown';
if (override !== undefined) {
  console.log(`OK    host scope: ${hostApp} (from --host-app)`);
} else if (detected !== undefined) {
  console.log(`OK    host scope: ${hostApp} (detected) — ${describeBucket(detected.bucket)}`);
} else {
  console.log('WARN  host scope: "unknown" — nothing heartbeated recently, so no IDE is publishing.');
  console.log(
    '      Buckets on disk: ' +
      (listHostBuckets()
        .slice(0, 6)
        .map((bucket) => `${bucket.hostApp}(${bucket.records})`)
        .join(', ') || '(none)')
  );
}

const child = spawn(options.node, [options.hub], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AT_SERIES_HOST_APP: hostApp }
});
const pending = new Map();
let buffer = '';
let stderr = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A server that prints non-protocol noise to stdout is itself worth seeing.
      console.error(`[non-JSON stdout] ${line.slice(0, 200)}`);
      continue;
    }
    const resolve = message.id === undefined ? undefined : pending.get(message.id);
    if (resolve !== undefined) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});

function send(method, params, id) {
  if (id === undefined) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const timer = setTimeout(
      () => reject(new Error(`no reply to ${method} within ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS
    );
    timer.unref?.();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  let started = Date.now();
  const init = await send(
    'initialize',
    { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'at-probe', version: '1.0.0' } },
    1
  );
  const info = init.result?.serverInfo ?? {};
  console.log(`OK    initialize -> ${info.name ?? '?'} ${info.version ?? ''}  [${Date.now() - started}ms]`);

  await send('notifications/initialized', undefined, undefined);

  started = Date.now();
  const list = await send('tools/list', {}, 2);
  const elapsed = Date.now() - started;
  if (list.error !== undefined) {
    console.error(`FAIL  tools/list -> ${JSON.stringify(list.error)}`);
    process.exitCode = 1;
  } else {
    const tools = list.result?.tools ?? [];
    console.log(`OK    tools/list -> ${tools.length} tool(s)  [${elapsed}ms]`);
    for (const tool of tools) {
      console.log(`        - ${tool.name}`);
    }
    if (elapsed > 10_000) {
      console.log(
        '      NOTE a cold start sweeps every registered bridge; raise toolCallTimeoutMs ' +
          'above the default 60s if this exceeds it.'
      );
    }
  }

  // The Hub speaks protocol v2: the real tools arrive only after a provider is asked.
  // Reading the registry is the cheapest proof that AT Terminal is in there at all.
  const providers = await send('tools/call', { name: 'at_list_providers', arguments: {} }, 3);
  const text = providers.result?.content?.find((block) => block.type === 'text')?.text;
  if (text !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`\nat_list_providers ->\n${text.slice(0, 2000)}`);
    }
    if (parsed !== undefined) {
      console.log(`\nat_list_providers: host=${parsed.hostApp} hub=${parsed.hubVersion}`);
      for (const provider of parsed.providers ?? []) {
        const healthy = (provider.bridges ?? []).filter((bridge) => bridge.status === 'healthy').length;
        console.log(
          `        ${provider.pluginId}@${provider.pluginVersion}  tools=${provider.tools.length}  healthyBridges=${healthy}`
        );
      }
      const terminal = (parsed.providers ?? []).find((provider) => provider.pluginId === 'at.terminal');
      if (terminal === undefined) {
        console.error(
          '\nFAIL  at.terminal is not registered. Open a VS Code-compatible IDE with the AT Terminal ' +
            'extension active — the Hub only proxies, it does not execute anything itself.'
        );
        process.exitCode = 1;
      } else {
        console.log(`\nOK    at.terminal is registered with ${terminal.tools.length} tool(s).`);
      }
    }
  }
} catch (error) {
  console.error(`FAIL  ${String(error)}`);
  process.exitCode = 1;
}

if (stderr.trim() !== '') {
  console.log(`\n--- Hub stderr (first 800) ---\n${stderr.trim().slice(0, 800)}`);
}

child.kill('SIGTERM');
process.exit(process.exitCode ?? 0);
