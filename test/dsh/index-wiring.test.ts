import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../core/fakes';
import {
  FakeDomainError,
  MemoryCredentialProvider,
  MemoryStorageDomain,
  RecordingDshLogger
} from '../platform/dsh/host-fakes';

/**
 * The Host half's wiring, driven for real.
 *
 * `dsh/index.js` is the file that composes everything — tools, the platform assembly and the
 * channel — and it had no test at all, which is how a resolver that captured `undefined` at
 * registration time shipped: every service call answered "the services are still starting"
 * forever while `ping`, which needs no service, kept working. Reading the source would not
 * have shown it; only calling a service after the assembly settles does.
 *
 * So this asserts the seam rather than the shape: the routes register, the assembly is
 * allowed to finish, and the services answer **afterwards** — the exact sequence the panel
 * performs.
 */

interface Route {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => void;
}

const moduleUrl = pathToFileURL(join(process.cwd(), 'dsh', 'index.js')).href;

let hostHalf: {
  apply: (ctx: unknown, config?: unknown) => void;
  Config: unknown;
  inject: string[];
};
beforeAll(async () => {
  hostHalf = (await import(moduleUrl)) as typeof hostHalf;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Point `DSH_HOME` at a throwaway directory.
 *
 * `dsh/index.js` derives its own data directory from that variable (defaulting to
 * `~/.dsh`) and hands it to the platform as `storageDir`, so without this the test would
 * read — and the services would write — the real installation's imported-private-keys
 * directory. The Host half reads the variable when `apply` runs, not at import, which is
 * what makes redirecting it here effective.
 */
let home: string | undefined;
let previousHome: string | undefined;
beforeEach(async () => {
  previousHome = process.env.DSH_HOME;
  home = await mkdtemp(joinPath(tmpdir(), 'at-dsh-home-'));
  process.env.DSH_HOME = home;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});


/**
 * Poll until the assembly has settled, instead of waiting a fixed number of ticks.
 *
 * The storage-domain open is a real async operation whose duration depends on the machine:
 * under load it outran a fixed budget and this test failed for a reason that had nothing to do
 * with the code under test. Polling asserts the *outcome* — the services answer — rather than
 * timing, and it still fails loudly when the resolver is broken, because the answer never
 * becomes ok and the deadline expires with the last failure in hand.
 */
async function waitForServices(
  harness: ReturnType<typeof createHarness>,
  deadlineMs = 5000
) {
  const started = Date.now();
  let last = await callRpc(harness, 'assets.summary');
  while (Date.now() - started < deadlineMs) {
    if (last.json?.ok === true) return last;
    // A rejected assembly stops saying "still starting" and starts giving the real reason;
    // returning on that keeps the failure case fast instead of burning the deadline.
    const message = (last.json?.error as { message?: string } | undefined)?.message;
    if (message !== undefined && message !== 'the services are still starting') return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
    last = await callRpc(harness, 'assets.summary');
  }
  return last;
}

/** @param options.storageDomain lets a test hand in a domain that refuses to open. */
function createHarness(options: { storageDomain?: MemoryStorageDomain } = {}) {
  const routes = new Map<string, Route>();
  const upgrades = new Map<string, Route>();
  const tools: Array<{ name?: string; execute?: (...args: any[]) => Promise<any> }> = [];
  const logger = new RecordingDshLogger();
  const disposers: Array<() => void> = [];
  const injections: string[][] = [];
  // Event listeners, so `tools/result` can be delivered the way the registry delivers it:
  // every observer is called, and whatever one throws is the registry's to swallow.
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>();

  const webServer = {
    register(route: Route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
    registerUpgrade(route: Route) {
      if (upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
      upgrades.set(route.path, route);
      return () => upgrades.delete(route.path);
    }
  };

  const storageDomain = options.storageDomain ?? new MemoryStorageDomain();
  const credentials = new MemoryCredentialProvider();

  const makeCtx = (extra: Record<string, unknown>): Record<string, unknown> => {
    const raw: Record<string, unknown> = {
      effect(run: () => unknown) {
        const dispose = run();
        if (typeof dispose === 'function') disposers.push(dispose as () => void);
        return () => {};
      },
      inject(names: string[], callback: (scoped: unknown) => unknown) {
        injections.push(names);
        // The real container waits for these services; here they are all present, so the
        // callback runs immediately with a context carrying them.
        callback(makeCtx({ ...extra, ...present }));
        return () => {};
      },
      get(name: string) {
        return (raw as any)[name];
      },
      on(event: string, listener: (...args: any[]) => unknown) {
        const set = listeners.get(event) ?? new Set<(...args: any[]) => unknown>();
        set.add(listener);
        listeners.set(event, set);
        return () => set.delete(listener);
      },
      logger,
      ...extra
    };

    return new Proxy(raw, {
      get(target, prop, receiver) {
        if (
          typeof prop === 'string' &&
          !(prop in target) &&
          !prop.startsWith('then') &&
          prop !== 'constructor' &&
          prop !== 'inspect' &&
          prop !== 'valueOf' &&
          prop !== 'toString'
        ) {
          throw new Error(`cannot get property "${prop}" without inject`);
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  };

  // `storageDomain` and `credentials` stand in for the Harness's own services, which the
  // default composition mounts. `webServer` is what makes the channel reachable.
  const present: Record<string, unknown> = { webServer, storageDomain, credentials };

  const ctx = makeCtx({
    tools: {
      register(definition: { name?: string; execute?: (...args: any[]) => Promise<any> }) {
        tools.push(definition);
        return () => {
          const index = tools.indexOf(definition);
          if (index !== -1) tools.splice(index, 1);
        };
      }
    }
  });

  return { ctx, routes, upgrades, tools, logger, disposers, injections, listeners };
}

/** Drive the `/rpc` route the way the browser half does. */
async function callRpc(harness: ReturnType<typeof createHarness>, method: string, params: unknown = {}) {
  const route = harness.routes.get('/dsh-at-terminal/rpc');
  if (route === undefined) throw new Error('the rpc route is not registered');

  const req = new EventEmitter() as EventEmitter & { method: string; destroy: () => void };
  req.method = 'POST';
  req.destroy = () => {};

  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(value?: unknown) {
      payload = value === undefined ? '' : String(value);
    }
  };

  route.handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ id: method, method, params })));
  req.emit('end');
  await flush();
  return { status, json: payload === '' ? undefined : JSON.parse(payload) };
}

/** Deliver one registry event the way `ctx.events.dispatch('emit', …)` does. */
function fire(harness: ReturnType<typeof createHarness>, event: string, ...args: unknown[]) {
  for (const listener of harness.listeners.get(event) ?? []) listener(...args);
}

/** Poll for a file, because the audit append is deliberately not awaited by the observer. */
async function readWhenReady(file: string, deadlineMs = 2000): Promise<string[]> {
  const started = Date.now();
  for (;;) {
    try {
      const text = await readFile(file, 'utf8');
      if (text.trim() !== '') return text.trim().split('\n');
    } catch {
      // not there yet
    }
    if (Date.now() - started > deadlineMs) throw new Error(`no audit content at ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('dsh Host half — wiring', () => {
  it('registers the readiness tool and direct ops tools, and the whole route table', () => {
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      'at_terminal_ping',
      'at_terminal_list_ssh_servers',
      'at_terminal_get_terminal_context',
      'at_terminal_run_remote_command',
      'at_terminal_sftp_list_directory',
      'at_terminal_sftp_stat_path',
      'at_terminal_sftp_read_file',
      'at_terminal_sftp_write_file',
      'at_terminal_sftp_create_file',
      'at_terminal_sftp_create_directory',
      'at_terminal_sftp_rename',
      'at_terminal_sftp_delete',
      'at_terminal_open_monitor',
      'at_terminal_get_hardware_metrics',
      'at_terminal_get_agent_execution_status'
    ]);
    expect([...harness.routes.keys()].sort()).toEqual(
      [
        '/dsh-at-terminal/events',
        '/dsh-at-terminal/health',
        '/dsh-at-terminal/rpc',
        '/dsh-at-terminal/stream'
      ].sort()
    );
    expect([...harness.upgrades.keys()]).toEqual(['/dsh-at-terminal/ws']);
    // The channel must not mount until the services it needs exist.
    expect(harness.injections).toContainEqual(['webServer', 'storageDomain', 'credentials']);
  });

  it('answers ping before the platform has finished assembling', async () => {
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});

    const answer = await callRpc(harness, 'ping');
    expect(answer.json?.result).toMatchObject({ pong: true });
  });

  it('reaches the terminal connect path through the bundle without "platform not installed"', async () => {
    // The user-visible failure, pinned at the boundary it happened on. The built
    // bundle's `SshSession.connect()` opens with `t('Connecting to …')`, and `t()`
    // reads the process-wide registry (`src/platform/current.ts`). The dsh root built
    // its bundle without installing it, so every connect died with "platform not
    // installed" — while the whole suite stayed green, because the test setup installs
    // a stand-in in the *source* module graph, which is a different module instance
    // from the copy esbuild inlines into the bundle. That is precisely what hid this.
    //
    // The target port below refuses the connection, so the assertions can be about the
    // registry and the coded failure — not about a reachable SSH host. The code is
    // `connection-refused` (not `connect-failed`) because `sshFailure.ts` classifies what
    // ssh2/Node report; that mapping being live in the shipped bundle is part of the pin.
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});
    await waitForServices(harness);

    // Same file `dsh/index.js` imports, so this is the very module whose registry
    // `apply()` just installed into.
    const bundle = (await import(pathToFileURL(join(process.cwd(), 'dsh', 'host.bundle.js')).href)) as {
      createDshServerApi(options: { platform: unknown }): {
        save(input: Record<string, unknown>): Promise<{ id: string }>;
      };
      createDshTerminalApi(options: { platform: unknown }): {
        open(options: {
          serverId: string;
          rows: number;
          cols: number;
          emit(event: Record<string, unknown>): void;
        }): Promise<unknown>;
      };
    };

    // The port bundle the domain classes read their storage/credentials from. `t()` is
    // what is under test here, and it reads the bundle's registry — not these.
    const ports = createFakePlatform();
    const saved = await bundle.createDshServerApi({ platform: ports }).save({
      label: 'refused',
      host: '127.0.0.1',
      port: 45999,
      username: 'nobody',
      authType: 'agent'
    });

    const events: Array<Record<string, unknown>> = [];
    await expect(
      bundle.createDshTerminalApi({ platform: ports }).open({
        serverId: saved.id,
        rows: 24,
        cols: 80,
        emit: (event) => events.push(event)
      })
    ).rejects.toMatchObject({ code: 'connection-refused' });

    // Positive proof the registry is installed: this status line is produced by `t()`
    // inside the bundle, before a socket is even attempted.
    const status = events.find((event) => event.type === 'status');
    expect(status).toBeDefined();
    expect(status).toMatchObject({ state: 'connecting' });
    expect(String(status?.text)).toContain('127.0.0.1');
    expect(JSON.stringify(events)).not.toContain('platform not installed');
  });

  it('answers settings.get from the row config — synchronously, without the assembly', async () => {
    // The terminal page reads font size / scrollback / highlight flags through this
    // method. Unlike the service faces it must never say "still starting": the row
    // config is what `apply` was handed, available from the first moment the channel
    // is mounted, and each read goes through the live accessors.
    const harness = createHarness();
    hostHalf.apply(harness.ctx, { terminalFontSize: { get: () => 18 } });

    const answer = await callRpc(harness, 'settings.get');
    expect(answer.json?.ok).toBe(true);
    expect(answer.json?.result).toMatchObject({
      terminalFontSize: 18,
      // Untouched fields fall back to the documented defaults.
      scrollback: 10000,
      semanticHighlight: true,
      zebraStripes: false
    });
  });

  it('serves the services once the assembly settles, rather than reporting "still starting"', async () => {
    // The regression guard. The resolver used to capture the face's value at registration
    // time — which is `undefined` — so every service call failed forever with
    // "the services are still starting" while `ping` kept working.
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});

    const summary = await waitForServices(harness);
    expect(summary.json?.ok).toBe(true);
    expect(summary.json?.result).toMatchObject({ servers: 0, passwords: 0, privateKeyFiles: 0 });

    const servers = await callRpc(harness, 'servers.list');
    expect(servers.json?.ok).toBe(true);
    expect(servers.json?.result).toMatchObject({ servers: [], groups: [] });
    expect((servers.json?.result as { privateKeyDirectory: string }).privateKeyDirectory).toMatch(
      /imported-private-keys$/
    );

    const saved = await callRpc(harness, 'servers.save', {
      server: {
        label: 'wired',
        host: 'wired.example.com',
        port: 22,
        username: 'ops',
        authType: 'agent',
        keepAliveInterval: 30,
        encoding: 'utf-8'
      }
    });
    expect(saved.json?.ok).toBe(true);

    const after = await callRpc(harness, 'servers.list');
    expect((after.json?.result as { servers: unknown[] }).servers).toHaveLength(1);
  });

  it('serves the SFTP face too, and says `none` rather than failing when no terminal is connected', async () => {
    // The file tree's read is wired like the other faces — resolved per call, from the same
    // assembly — and its "nothing is connected" answer is a **state**, not an error: a panel
    // that received a failure here would render a banner for the ordinary case of opening
    // the page before connecting anything.
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});
    await waitForServices(harness);

    const answer = await callRpc(harness, 'sftp.list');
    expect(answer.json?.ok).toBe(true);
    expect(answer.json?.result).toMatchObject({ kind: 'none', rootPath: null, entries: [] });

    // `goUp` is the opposite case: there is nowhere to go, and it says so by code.
    const up = await callRpc(harness, 'sftp.goUp');
    expect(up.json?.ok).toBe(false);
    expect(up.json?.error?.code).toBe('no-active-terminal');

    // Cache-only, so it works with nothing connected.
    const refreshed = await callRpc(harness, 'sftp.refresh');
    expect(refreshed.json?.result).toEqual({ refreshed: true });
  });

  it('keeps the channel up and reports the real reason when the assembly fails', async () => {
    // A rejected assembly must not take the channel down with it — the channel is how anyone
    // finds out what went wrong — and the resolver has to stop saying "still starting" and
    // start giving the reason the services will never arrive.
    const broken = new MemoryStorageDomain();
    broken.failNextOpen = new FakeDomainError('backend-not-found', 'backend "json" is not registered');

    const harness = createHarness({ storageDomain: broken });
    hostHalf.apply(harness.ctx, {});

    // The routes exist regardless: that is the whole point of mounting the channel anyway.
    expect(harness.routes.has('/dsh-at-terminal/health')).toBe(true);

    const answer = await waitForServices(harness);
    expect(answer.json?.ok).toBe(false);
    expect(answer.json?.error?.message).toMatch(/json/);
    expect(answer.json?.error?.message).not.toBe('the services are still starting');
  });

  it('renders a disposer that releases the routes', () => {
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});
    expect(harness.routes.size).toBeGreaterThan(0);
    for (const dispose of harness.disposers) dispose();
    expect(harness.routes.size).toBe(0);
  });

  it('registers all 12 operational tools and resolves them once assembly settles', async () => {
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});

    expect(harness.tools).toHaveLength(15);
    const pingTool = harness.tools.find((t) => t.name === 'at_terminal_ping');
    expect(pingTool).toBeDefined();

    // Ping works immediately before assembly settles
    const pingRes = await pingTool?.execute?.();
    expect(pingRes).toMatchObject({ plugin: 'at-terminal', ready: true });

    // Operational tools report services are still starting before assembly settles
    const listTool = harness.tools.find((t) => t.name === 'at_terminal_list_ssh_servers');
    expect(listTool).toBeDefined();
    await expect(listTool?.execute?.({}, {})).rejects.toThrow('the services are still starting');

    // Wait for assembly to settle
    await waitForServices(harness);

    // Now list_ssh_servers answers cleanly
    const listRes = await listTool?.execute?.({}, {});
    expect(listRes).toMatchObject({ servers: [] });

    // Add a server via RPC and verify it is visible via the direct agent tool
    await callRpc(harness, 'servers.save', {
      server: {
        label: 'agent-target',
        host: '10.0.0.1',
        port: 22,
        username: 'admin',
        authType: 'agent',
        backgroundConnectionAllowed: true,
        keepAliveInterval: 30,
        encoding: 'utf-8'
      }
    });

    const listResAfter = await listTool?.execute?.({}, {});
    expect(listResAfter.servers).toHaveLength(1);
    expect(listResAfter.servers[0]).toMatchObject({ label: 'agent-target', host: '10.0.0.1' });

    // Terminal context tool answers cleanly
    const contextTool = harness.tools.find((t) => t.name === 'at_terminal_get_terminal_context');
    const contextRes = await contextTool?.execute?.({}, {});
    expect(contextRes).toMatchObject({
      focusedTerminal: null,
      defaultConnectedTerminal: null,
      connectedTerminals: [],
      knownTerminals: []
    });

    // Monitor tools answer cleanly
    const openMonitorTool = harness.tools.find((t) => t.name === 'at_terminal_open_monitor');
    expect(openMonitorTool).toBeDefined();
    const openRes = await openMonitorTool?.execute?.({ target: 'hardware', mode: 'float' }, {});
    expect(openRes).toMatchObject({ opened: true, target: 'hardware', mode: 'float' });

    const metricsTool = harness.tools.find((t) => t.name === 'at_terminal_get_hardware_metrics');
    expect(metricsTool).toBeDefined();
    const metricsRes = await metricsTool?.execute?.({ serverId: listResAfter.servers[0].id }, {});
    expect(metricsRes).toMatchObject({ cpuUsagePercent: expect.any(Number), memoryTotalBytes: expect.any(Number) });

    const agentStatusTool = harness.tools.find((t) => t.name === 'at_terminal_get_agent_execution_status');
    expect(agentStatusTool).toBeDefined();
    const statusRes = await agentStatusTool?.execute?.({ limit: 5 }, {});
    expect(statusRes).toMatchObject({ recentAudits: expect.any(Array) });

    // Disposing releases both routes and registered tools
    for (const dispose of harness.disposers) dispose();
    expect(harness.tools).toHaveLength(0);
  });

  it('lands one audit line per at_terminal_* call, and reports `file` as the status source', async () => {
    // The regression this pins: `AgentAuditLog` was written, tested, and never constructed —
    // `agent-audit.jsonl` appeared nowhere in `host.bundle.js`, so "history" was the 50-row
    // in-memory ring and nothing survived a restart.
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});
    await waitForServices(harness);

    const agent = { session: { id: 'sess-1' } };
    fire(
      harness,
      'tools/result',
      {
        name: 'at_terminal_run_remote_command',
        callId: 'call-1',
        arguments: { command: 'mysql --password=hunter2 -e "select 1"', serverId: 'srv-1' },
        agent
      },
      { isError: false, value: { serverId: 'srv-1', exitCode: 0, durationMs: 42, truncated: false } }
    );

    // An agent-less call is a PTC sub-call: it belongs to no session, so it must not be
    // written into the user's trail.
    fire(
      harness,
      'tools/result',
      {
        name: 'at_terminal_run_remote_command',
        callId: 'call-2',
        arguments: { command: 'rm -rf /', serverId: 'srv-1' }
      },
      { isError: false, value: { serverId: 'srv-1', exitCode: 0, durationMs: 1, truncated: false } }
    );

    // A tool that is not ours must not be audited, even with an agent attached.
    fire(
      harness,
      'tools/result',
      { name: 'bash_run', callId: 'call-3', arguments: {}, agent },
      { isError: false, value: {} }
    );

    const lines = await readWhenReady(joinPath(process.env.DSH_HOME as string, 'at-terminal', 'agent-audit.jsonl'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      tool: 'run_remote_command',
      serverId: 'srv-1',
      sessionId: 'sess-1',
      reasonCode: 'completed',
      exitCode: 0,
      durationMs: 42
    });
    // Redaction happens before the line is written, not in the reader.
    expect(lines[0]).not.toContain('hunter2');

    const statusTool = harness.tools.find((tool) => tool.name === 'at_terminal_get_agent_execution_status');
    const status = await statusTool?.execute?.({ limit: 5 }, {});
    expect(status).toMatchObject({ source: 'file' });
    expect(status.recentAudits).toHaveLength(1);
    expect(status.recentAudits[0].command).toContain('mysql');
  });

  it('records a failed call as runtime_error, and keeps the tool result untouched when the audit fails', async () => {
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});
    await waitForServices(harness);

    fire(
      harness,
      'tools/result',
      {
        name: 'at_terminal_sftp_read_file',
        callId: 'call-4',
        arguments: { path: '/etc/shadow', serverId: 'srv-1' },
        agent: { session: { id: 'sess-1' } }
      },
      { isError: true, error: { message: 'permission denied' }, content: [] }
    );

    const lines = await readWhenReady(joinPath(process.env.DSH_HOME as string, 'at-terminal', 'agent-audit.jsonl'));
    expect(JSON.parse(lines[0])).toMatchObject({
      tool: 'sftp_read_file',
      path: '/etc/shadow',
      serverId: 'srv-1',
      reasonCode: 'runtime_error'
    });

    // An observer that throws is the registry's business (`notifyResult` catches and logs).
    // What this pins is narrower and more important: a broken audit must not break the call.
    expect(() =>
      fire(harness, 'tools/result', { name: 'at_terminal_ping', get arguments() { throw new Error('boom'); }, agent: {} }, { isError: false, value: {} })
    ).not.toThrow();
    expect(harness.logger.join()).toContain('audit observer failed');
  });

  it('reports `memory` when the audit file has nothing in it yet', async () => {
    const harness = createHarness();
    hostHalf.apply(harness.ctx, {});
    await waitForServices(harness);

    const statusTool = harness.tools.find((tool) => tool.name === 'at_terminal_get_agent_execution_status');
    const status = await statusTool?.execute?.({ limit: 5 }, {});
    // No calls yet: the file does not exist, so the answer is the live ring — and it says so
    // rather than presenting an empty history as evidence.
    expect(status).toMatchObject({ source: 'memory', recentAudits: [] });
  });
});

