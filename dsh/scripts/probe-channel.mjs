#!/usr/bin/env node
/**
 * Ask the running Harness what the AT Terminal channel is actually doing.
 *
 * This is the outside-in check for M3/M4, and it exists because the browser half is
 * otherwise unobservable: the Desktop shell delivers client bundles over its own IPC
 * carrier rather than over `/plugins` on the web server, and it is not started with a
 * devtools port, so nothing outside the page can read its module graph. Two questions
 * therefore have to be asked of the Host half instead:
 *
 *   1. did the Host half's routes register? (the port scan + `state.get`)
 *   2. did the browser half run at all? (`client.status` — the browser half announces
 *      itself with `rpc client.hello` on activation)
 *
 * Without (2), "the sidebar tab is not on screen" and "the client half never loaded"
 * look identical from here — which is exactly the ambiguity that made the first attempt
 * to see the tab inconclusive.
 *
 *   node dsh/scripts/probe-channel.mjs            # scan every listening port
 *   node dsh/scripts/probe-channel.mjs --port 19387
 *
 * Exit code 0 when a channel answered, 1 when none did.
 */

import { execSync } from 'node:child_process';

const PREFIX = '/dsh-at-terminal';

function parseArgs(argv) {
  const options = { port: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') options.port = Number(argv[++index]);
    else {
      console.error(`unknown argument: ${argv[index]}`);
      process.exit(2);
    }
  }
  return options;
}

/** Every port something is listening on. The Desktop shell picks its web port at startup. */
function listeningPorts() {
  const raw = execSync('netstat -an -p tcp', { encoding: 'utf8' });
  const ports = new Set();
  for (const line of raw.split('\n')) {
    const match = line.match(/^\S+\s+\d+\s+\d+\s+(?:127\.0\.0\.1|::1|\*)\.(\d+)\s+.*LISTEN/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports].filter((port) => port > 1024 && port < 65000).sort((a, b) => a - b);
}

async function request(port, path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { status: 0, text: String(error?.name ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(port, method) {
  const answer = await request(port, `${PREFIX}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: method, method, params: {} })
  });
  if (answer.status !== 200) return undefined;
  try {
    return JSON.parse(answer.text);
  } catch {
    return undefined;
  }
}

const options = parseArgs(process.argv.slice(2));
const candidates = options.port === undefined ? listeningPorts() : [options.port];

let found;
for (const port of candidates) {
  const health = await request(port, `${PREFIX}/health`);
  if (health.status !== 200) continue;
  try {
    if (JSON.parse(health.text).service !== 'at-terminal-channel') continue;
  } catch {
    continue;
  }
  found = { port, health: JSON.parse(health.text) };
  break;
}

if (found === undefined) {
  console.error(`FAIL  no AT Terminal channel answered on ${candidates.length} listening port(s).`);
  console.error('      The Harness has to be (re)started after the bundle changes: the Host half');
  console.error('      registers its routes during activation, and the Desktop shell keeps running');
  console.error('      the composition it booted with.');
  process.exit(1);
}

const { port, health } = found;
console.log(`OK    channel on 127.0.0.1:${port}  version=${health.version}  uptime=${Math.round(health.uptimeMs / 1000)}s`);
console.log(`      routes: ${health.routes.join(', ')}`);

const state = await rpc(port, 'state.get');
if (state?.ok === true) {
  const result = state.result;
  console.log(
    `OK    state: sseClients=${result.sseClients} wsSockets=${result.wsSockets} ` +
      `clientHellos=${result.clientHellos} streamRun=${result.stream === null ? 'no' : 'yes'}`
  );
}

const clients = await rpc(port, 'client.status');
if (clients?.ok === true) {
  const { count, last } = clients.result;
  if (count === 0) {
    console.error('FAIL  the browser half has never announced itself.');
    console.error('      Every route works but nothing loaded the client bundle, so no sidebar tab');
    console.error('      can exist. Check `dsh.client` and `exports["./client"]` in dsh/package.json,');
    console.error('      then restart the Harness.');
    process.exit(1);
  }
  console.log(`OK    browser half arrived ${count} time(s); last at ${new Date(last.at).toISOString()}`);
  console.log(`      origin=${last.origin ?? '(unknown)'} kind=${last.kind ?? '(unknown)'}`);
  console.log('      A side-panel tab of that kind should now be reachable in a Session’s right sidebar.');
} else {
  // Distinguishing this from "count is 0" matters: an older Host half simply has no
  // such method, and reporting that as "the client never loaded" would send someone
  // hunting for a client-side bug that does not exist.
  console.error('FAIL  rpc client.status is not available on this channel.');
  console.error('      The running Host half predates the self-announcement, so it cannot report');
  console.error('      whether the browser half loaded. Restart the Harness to load the current');
  console.error('      dsh/channel.js and re-run this probe.');
  process.exit(1);
}

process.exit(0);
