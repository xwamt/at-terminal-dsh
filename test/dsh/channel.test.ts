import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The Host half's channel (`dsh/channel.js`) had no test at all. It is the piece the
 * browser half talks to, and it is pure Node plus a `ctx.webServer` — both of which can
 * be stood in for, so there is no reason for it to be the least-covered file in the
 * bundle.
 *
 * The channel is ESM (the package is `"type": "module"`), so it is imported rather than
 * evaluated as a classic script. What is asserted here is the part that a live probe
 * cannot show: the RPC dispatcher's contract, the duplicate-route guard that keeps a
 * second mount from killing activation, and the byte-stream header the browser half and
 * the Node probe both have to agree on.
 */

interface Route {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => void;
}

interface ChannelModule {
  PREFIX: string;
  ROUTES: ReadonlyArray<{ kind: string; path: string; label: string }>;
  registerChannel: (
    ctx: unknown,
    options: {
      version: string;
      resolveAssets?: () => unknown;
      resolveServers?: () => unknown;
      resolveTerminal?: () => unknown;
      resolveSftp?: () => unknown;
      resolveSettings?: () => unknown;
    }
  ) => () => void;
  crc32: (buffer: Buffer) => number;
  buildChunk: (seq: number, payloadBytes: number, chunkSize?: number) => Buffer;
  STREAM_PATTERN_A: number;
  STREAM_PATTERN_B: number;
}

const moduleUrl = pathToFileURL(join(process.cwd(), 'dsh', 'channel.js')).href;

/**
 * Loaded in `beforeAll` rather than by top-level `await`: this repository compiles as
 * CommonJS (`tsconfig.json` with no `"type": "module"` in the package), where a
 * top-level `await` is a compile error even though the test runner tolerates it.
 */
let channel: ChannelModule;
beforeAll(async () => {
  channel = (await import(moduleUrl)) as ChannelModule;
});

interface Harness {
  routes: Map<string, Route>;
  upgrades: Map<string, Route>;
  logs: string[];
  dispose: () => void;
  /** A second mount over the same fake server, to exercise the duplicate guard. */
  mountAgain: () => () => void;
}

/** `%s`/`%d` substitution, the way the Host half's pino logger formats a line. */
function format(parts: unknown[]): string {
  const [first, ...rest] = parts;
  if (typeof first !== 'string') return parts.map(String).join(' ');
  let next = 0;
  const text = first.replace(/%[sd]/g, () => String(rest[next++]));
  return [text, ...rest.slice(next)].map(String).join(' ');
}

function createHarness(  assets?: () => unknown,
  servers?: () => unknown,
  terminal?: () => unknown,
  settings?: () => unknown,
  sftp?: () => unknown
): Harness {
  const routes = new Map<string, Route>();
  const upgrades = new Map<string, Route>();
  const logs: string[] = [];
  const disposers: Array<() => void> = [];

  const server = {
    // `channel.info` reads the listened port off the real webServer; the stand-in
    // carries one so the loopback endpoint it reports is asserted, not assumed.
    port: 4321,
    host: '127.0.0.1',
    register(route: Route) {
      // The real web server throws on a duplicate (kind, path); the channel must catch
      // that, or a second mount would take the whole plugin activation down.
      if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`);
      routes.set(route.path, route);
      const dispose = () => void routes.delete(route.path);
      disposers.push(dispose);
      return dispose;
    },
    registerUpgrade(route: Route) {
      if (upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
      upgrades.set(route.path, route);
      const dispose = () => void upgrades.delete(route.path);
      disposers.push(dispose);
      return dispose;
    }
  };

  const ctx = {
    webServer: server,
    logger: {
      // printf-style substitution, like the pino logger the Host half really gets: without
      // it a `%s` line records the placeholders and the assertion would have to match the
      // argument list instead of the sentence a user would read.
      info: (...parts: unknown[]) => void logs.push(format(parts)),
      warn: (...parts: unknown[]) => void logs.push('warn ' + format(parts)),
      error: (...parts: unknown[]) => void logs.push('error ' + format(parts))
    }
  };

  return {
    routes,
    upgrades,
    logs,
    dispose: channel.registerChannel(ctx, {
      version: '0.1.0',
      resolveAssets: assets,
      resolveServers: servers,
      resolveTerminal: terminal,
      resolveSftp: sftp,
      resolveSettings: settings
    }),
    mountAgain: () =>
      channel.registerChannel(ctx, {
        version: '0.1.0',
        resolveAssets: assets,
        resolveServers: servers,
        resolveTerminal: terminal,
        resolveSftp: sftp,
        resolveSettings: settings
      })
  };
}

interface RpcAnswer {
  status: number;
  json?: {
    ok?: boolean;
    result?: unknown;
    error?: { code?: string; message?: string; fingerprint?: string };
  };
}

/** Let the dispatcher's promise chain settle; it answers asynchronously by design. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Drive the `rpc` route's handler with a fake request/response pair. */
async function callRpc(
  harness: Harness,
  body: unknown,
  method = 'POST',
  headers: Record<string, string> = {}
): Promise<RpcAnswer> {
  const route = harness.routes.get(`${channel.PREFIX}/rpc`);
  if (route === undefined) throw new Error('rpc route is not registered');

  const req = new EventEmitter() as EventEmitter & {
    method: string;
    destroy: () => void;
    headers: Record<string, string>;
  };
  req.method = method;
  req.destroy = () => {};
  // What the browser half actually sends. The fence checks Host and content-type, so a
  // request without them is refused before the dispatcher is reached — which is the point
  // of the check, and why the default here models a real request rather than a bare object.
  req.headers = { host: '127.0.0.1:4321', 'content-type': 'application/json', ...headers };

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
  if (method === 'POST') {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
    // Handlers may be async (the asset methods are), so the reply lands after the
    // dispatcher's promise chain rather than inside the `end` event.
    await flush();
  }
  return { status, json: payload === '' ? undefined : JSON.parse(payload) };
}

describe('dsh Host channel', () => {
  it('pins the route table it advertises', async () => {
    const harness = createHarness();
    expect([...harness.routes.keys()].sort()).toEqual(
      [`${channel.PREFIX}/events`, `${channel.PREFIX}/health`, `${channel.PREFIX}/rpc`, `${channel.PREFIX}/stream`].sort()
    );
    expect([...harness.upgrades.keys()]).toEqual([`${channel.PREFIX}/ws`]);
    expect(harness.routes.size + harness.upgrades.size).toBe(channel.ROUTES.length);
    harness.dispose();
  });

  it('reports the same routes over HTTP as it registers', async () => {
    const harness = createHarness();
    const health = harness.routes.get(`${channel.PREFIX}/health`)!;
    let payload = '';
    health.handler({}, { writeHead() {}, end: (value: unknown) => void (payload = String(value)) });

    const body = JSON.parse(payload);
    expect(body.ok).toBe(true);
    expect(body.service).toBe('at-terminal-channel');
    expect(body.routes.sort()).toEqual(channel.ROUTES.map((route) => route.path).sort());
    harness.dispose();
  });

  it('answers an unknown method as a result, not as a transport failure', async () => {
    const harness = createHarness();
    const answer = await callRpc(harness, { id: 7, method: 'nope' });
    expect(answer.status).toBe(200);
    expect(answer.json?.ok).toBe(false);
    expect(answer.json?.error?.code).toBe('no-such-method');
    harness.dispose();
  });

  it('reads settings.get through the resolver per call, and defaults to an empty object', async () => {
    // The terminal page reads the user's font/scrollback settings through this method,
    // and a settings edit must be visible on the next read — so the value is resolved
    // per call rather than snapshotted, the same contract the service faces have.
    const withoutSettings = createHarness();
    const fallback = await callRpc(withoutSettings, { id: 1, method: 'settings.get' });
    expect(fallback.json?.ok).toBe(true);
    expect(fallback.json?.result).toEqual({});
    withoutSettings.dispose();

    let current: Record<string, unknown> = { terminalFontSize: 14 };
    const harness = createHarness(undefined, undefined, undefined, () => current);
    const first = await callRpc(harness, { id: 2, method: 'settings.get' });
    expect(first.json?.result).toEqual({ terminalFontSize: 14 });
    current = { terminalFontSize: 18, zebraStripes: true };
    const second = await callRpc(harness, { id: 3, method: 'settings.get' });
    expect(second.json?.result).toEqual({ terminalFontSize: 18, zebraStripes: true });
    harness.dispose();
  });

  it('reports its own loopback endpoint so a dsh-app:// page can find the WebSocket', async () => {
    // The Desktop shell serves the panel from `dsh-app://app`, where location.host
    // is a name nothing can connect to and a WebSocket — unlike relative fetch —
    // cannot ride the shell's IPC bridge. Only the Host knows the port it actually
    // listened on, so it reports it here. This is the fix for the `ws://app/...`
    // websocket-error the user hit.
    const harness = createHarness();
    const answer = await callRpc(harness, { id: 1, method: 'channel.info' });
    expect(answer.json?.ok).toBe(true);
    expect(answer.json?.result).toMatchObject({
      host: '127.0.0.1',
      port: 4321,
      wsUrl: `ws://127.0.0.1:4321${channel.PREFIX}/ws`
    });
    harness.dispose();
  });

  it('serves the file tree over RPC: list, goUp and refresh, each against the live face', async () => {
    // The resolver is called **per request**, not once at registration. An earlier version of
    // the wiring snapshotted the face at registration time, when it was still `undefined`,
    // and every service call answered "the services are still starting" forever while `ping`
    // kept working (the `services-unavailable` defect a user found). `sftp.*` is wired the
    // same way as the other faces, and this proves it by swapping the face between calls.
    const calls: string[] = [];
    let face: {
      list(request: { path?: string }): Promise<Record<string, unknown>>;
      goUp(): Promise<Record<string, unknown>>;
      refresh(): Promise<Record<string, unknown>>;
      createFile?(request: { path: string }): Promise<Record<string, unknown>>;
      delete?(request: { path: string }): Promise<Record<string, unknown>>;
    } = {
      list: async (request: { path?: string }) => {
        calls.push(`list:${request.path ?? ''}`);
        return { kind: 'active', rootPath: '/home/root', path: '/home/root', entries: [{ name: 'a', path: '/home/root/a', type: 'file' }] };
      },
      goUp: async () => {
        calls.push('goUp');
        return { kind: 'active', rootPath: '/home', path: '/home', entries: [] };
      },
      refresh: async () => {
        calls.push('refresh');
        return { refreshed: true };
      },
      createFile: async (request: { path: string }) => {
        calls.push(`createFile:${request.path}`);
        return { created: true, path: request.path };
      },
      delete: async (request: { path: string }) => {
        calls.push(`delete:${request.path}`);
        return { deleted: true, path: request.path };
      }
    };
    const harness = createHarness(undefined, undefined, undefined, undefined, () => face);

    const listed = await callRpc(harness, { id: 1, method: 'sftp.list', params: {} });
    expect(listed.json?.ok).toBe(true);
    expect(listed.json?.result).toMatchObject({ kind: 'active', rootPath: '/home/root' });

    const deep = await callRpc(harness, { id: 2, method: 'sftp.list', params: { path: '/home/root/sub' } });
    expect(deep.json?.ok).toBe(true);

    const up = await callRpc(harness, { id: 3, method: 'sftp.goUp', params: {} });
    expect(up.json?.result).toMatchObject({ rootPath: '/home' });

    const refreshed = await callRpc(harness, { id: 4, method: 'sftp.refresh', params: {} });
    expect(refreshed.json?.result).toEqual({ refreshed: true });

    const created = await callRpc(harness, { id: 5, method: 'sftp.createFile', params: { path: '/home/root/new.txt' } });
    expect(created.json?.result).toEqual({ created: true, path: '/home/root/new.txt' });

    const deleted = await callRpc(harness, { id: 6, method: 'sftp.delete', params: { path: '/home/root/a' } });
    expect(deleted.json?.result).toEqual({ deleted: true, path: '/home/root/a' });

    expect(calls).toEqual(['list:', 'list:/home/root/sub', 'goUp', 'refresh', 'createFile:/home/root/new.txt', 'delete:/home/root/a']);

    // Swap the face: the next call must reach the new one, which is only true if the
    // resolver is consulted per call.
    face = { ...face, list: async () => ({ kind: 'none', rootPath: null, path: null, entries: [] }) };
    const after = await callRpc(harness, { id: 7, method: 'sftp.list', params: {} });
    expect(after.json?.result).toMatchObject({ kind: 'none' });
    harness.dispose();
  });

  it('says so, by name, when the SFTP face was never assembled', async () => {
    const harness = createHarness();
    const answer = await callRpc(harness, { id: 1, method: 'sftp.list', params: {} });
    expect(answer.status).toBe(200);
    expect(answer.json?.ok).toBe(false);
    expect(answer.json?.error?.code).toBe('services-unavailable');
    expect(answer.json?.error?.message).toContain('SFTP');
    harness.dispose();
  });

  it('carries a refused host key\u2019s fingerprint through the RPC error envelope', async () => {
    // The terminal path pushes the fingerprint down its WebSocket event stream; a unary RPC
    // has no stream, and `createHostVerifier` turns a rejected `verify()` into
    // `verify(false)` — so without this the refusal would arrive as a code with nothing the
    // user can act on.
    const harness = createHarness(undefined, undefined, undefined, undefined, () => ({
      list: async () => {
        throw Object.assign(new Error('10.0.0.1:22 is not a known host.'), {
          code: 'host-key-unknown',
          fingerprint: 'SHA256:abc'
        });
      }
    }));

    const answer = await callRpc(harness, { id: 1, method: 'sftp.list', params: {} });
    expect(answer.json?.ok).toBe(false);
    expect(answer.json?.error?.code).toBe('host-key-unknown');
    expect(answer.json?.error?.fingerprint).toBe('SHA256:abc');
    harness.dispose();
  });

  it('omits the fingerprint when the failure never had one', async () => {
    const harness = createHarness(undefined, undefined, undefined, undefined, () => ({
      list: async () => {
        throw Object.assign(new Error('nothing is listening'), { code: 'connection-refused' });
      }
    }));

    const answer = await callRpc(harness, { id: 1, method: 'sftp.list', params: {} });
    expect(answer.json?.error?.code).toBe('connection-refused');
    // `undefined` rather than `null` or `''`: the browser half branches on presence.
    expect(answer.json?.error).not.toHaveProperty('fingerprint');
    harness.dispose();
  });

  it('refuses a GET on the RPC route', async () => {
    const harness = createHarness();
    const answer = await callRpc(harness, undefined, 'GET');
    expect(answer.status).toBe(405);
    expect(answer.json?.error?.code).toBe('method-not-allowed');
    harness.dispose();
  });

  it('refuses a body that is not JSON', async () => {
    const harness = createHarness();
    const answer = await callRpc(harness, 'not json at all');
    expect(answer.status).toBe(400);
    expect(answer.json?.error?.code).toBe('bad-json');
    harness.dispose();
  });

  it('records a client-half arrival and exposes it through client.status and state.get', async () => {
    const harness = createHarness();
    const before = await callRpc(harness, { method: 'client.status' });
    expect(before.json?.result).toMatchObject({ count: 0, last: null });

    const hello = await callRpc(harness, {
      method: 'client.hello',
      params: { kind: 'at-terminal', origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/', userAgent: 'probe' }
    });
    expect(hello.json?.result).toMatchObject({ recorded: true, count: 1 });

    const after = await callRpc(harness, { method: 'client.status' });
    expect(after.json?.result).toMatchObject({
      count: 1,
      last: { kind: 'at-terminal', origin: 'http://127.0.0.1:19387', userAgent: 'probe' }
    });

    const state = await callRpc(harness, { method: 'state.get' });
    expect(state.json?.result).toMatchObject({ clientHellos: 1 });

    // The arrival is logged, so a headless run leaves a trace too.
    expect(harness.logs.join('\n')).toContain('client half checked in');
    harness.dispose();
  });

  it('truncates what a client reports instead of trusting its length', async () => {
    const harness = createHarness();
    await callRpc(harness, { method: 'client.hello', params: { origin: 'x'.repeat(5000) } });
    const status = await callRpc(harness, { method: 'client.status' });
    const last = (status.json?.result as { last: { origin: string } }).last;
    expect(last.origin.length).toBe(300);
    harness.dispose();
  });

  it('survives a second mount, which the real server rejects with a throw', async () => {
    const harness = createHarness();
    expect(() => harness.mountAgain()).not.toThrow();
    // The routes are still the first mount's, and the second mount's disposer did not
    // remove them from under it.
    expect(harness.routes.has(`${channel.PREFIX}/health`)).toBe(true);
    expect(harness.logs.join('\n')).toContain('duplicate');
  });

  it('removes every route and upgrade on dispose', async () => {
    const harness = createHarness();
    harness.dispose();
    expect(harness.routes.size).toBe(0);
    expect(harness.upgrades.size).toBe(0);
  });

  it('keeps the byte-stream header the browser and the Node probe both parse', async () => {
    const chunk = channel.buildChunk(3, 16);

    // Layout: magic 'ATST' | seq u32BE | crc u32BE | payloadBytes u32BE | payload
    expect(chunk.readUInt32BE(0)).toBe(0x41545354);
    expect(chunk.readUInt32BE(4)).toBe(3);
    expect(chunk.readUInt32BE(12)).toBe(16);
    expect(chunk.length).toBe(16 + 16);
    for (let i = 0; i < 16; i += 1) {
      expect(chunk[16 + i]).toBe((3 * channel.STREAM_PATTERN_A + i * channel.STREAM_PATTERN_B) & 0xff);
    }

    // The stored CRC must cover the same buffer, or a receiver would reject every chunk.
    const stored = chunk.readUInt32BE(8);
    const zeroed = Buffer.from(chunk);
    zeroed.writeUInt32BE(0, 8);
    expect(channel.crc32(zeroed)).toBe(stored);
  });
});

describe('dsh Host channel — asset transfer', () => {
  const face = (calls: unknown[], overrides: Record<string, unknown> = {}) => () => ({
    summary: async () => ({ servers: 2, passwords: 1, privateKeyFiles: 0, privateKeyDirectory: '/home/u/.dsh/at-terminal/imported-private-keys' }),
    export: async (request: unknown) => {
      calls.push(['export', request]);
      return { filename: 'at-terminal-assets.at-terminal-assets', envelope: { format: 'at-terminal-assets' }, omissions: 0 };
    },
    importPackage: async (request: unknown) => {
      calls.push(['import', request]);
      return { summary: { imported: 1, skipped: 0, overwritten: 0, renamed: 0, privateKeysWritten: 0 } };
    },
    ...overrides
  });

  it('says the asset services are unavailable rather than reporting zero servers', async () => {
    // "0 servers" and "the store could not be opened" look identical to a user, and the
    // second is both likelier on a fresh install and the one they can act on.
    const harness = createHarness();
    const answer = await callRpc(harness, { method: 'assets.summary' });
    expect(answer.status).toBe(200);
    expect(answer.json?.error?.code).toBe('assets-unavailable');
    harness.dispose();
  });

  it('resolves the asset face per call, so a late arrival is still picked up', async () => {
    // The channel mounts before the storage domain finishes opening; the face is only
    // assigned once assembly settles, which is why it is resolved per call.
    let available: (() => unknown) | undefined;
    const harness = createHarness(() => {
      if (available === undefined) {
        throw Object.assign(new Error('the asset services are still starting'), { code: 'assets-unavailable' });
      }
      return available();
    });

    const early = await callRpc(harness, { method: 'assets.summary' });
    expect(early.json?.error?.message).toContain('still starting');

    available = () => ({ summary: async () => ({ servers: 7, passwords: 0, privateKeyFiles: 0, privateKeyDirectory: '/x' }) });
    const late = await callRpc(harness, { method: 'assets.summary' });
    expect(late.json?.result).toMatchObject({ servers: 7 });
    harness.dispose();
  });

  it('passes export and import through unchanged', async () => {
    const calls: unknown[] = [];
    const harness = createHarness(face(calls));

    const exported = await callRpc(harness, {
      method: 'assets.export',
      params: { includePasswords: true, includePrivateKeys: false, packagePassword: 'pw' }
    });
    expect(exported.json?.result).toMatchObject({ filename: 'at-terminal-assets.at-terminal-assets' });

    const imported = await callRpc(harness, {
      method: 'assets.import',
      params: { envelope: '{"format":"at-terminal-assets"}', packagePassword: 'pw', strategy: 'rename' }
    });
    expect(imported.json?.result).toMatchObject({ summary: { imported: 1 } });

    expect(calls).toEqual([
      ['export', { includePasswords: true, includePrivateKeys: false, packagePassword: 'pw' }],
      ['import', { envelope: '{"format":"at-terminal-assets"}', packagePassword: 'pw', strategy: 'rename' }]
    ]);
    harness.dispose();
  });

  it('treats missing booleans as false instead of sending undefined through', async () => {
    const calls: unknown[] = [];
    const harness = createHarness(face(calls));
    await callRpc(harness, { method: 'assets.export', params: { packagePassword: 'pw' } });
    expect(calls[0]).toEqual(['export', { includePasswords: false, includePrivateKeys: false, packagePassword: 'pw' }]);
    harness.dispose();
  });

  it('returns a failed asset call as a coded 200, not as a transport failure', async () => {
    const harness = createHarness(
      face([], {
        summary: async () => {
          throw Object.assign(new Error('Invalid package password or corrupted asset package.'), {
            code: 'wrong-password'
          });
        }
      })
    );
    const answer = await callRpc(harness, { method: 'assets.summary' });
    expect(answer.status).toBe(200);
    expect(answer.json?.ok).toBe(false);
    expect(answer.json?.error).toMatchObject({
      code: 'wrong-password',
      message: 'Invalid package password or corrupted asset package.'
    });
    harness.dispose();
  });

  it('answers with 413 instead of resetting the socket when the body exceeds the cap', async () => {
    // An asset package carries base64 private keys, so this route is the one request that
    // is legitimately large — and the old 1 MiB cap destroyed the request silently.
    const harness = createHarness(face([]));
    const cap = (channel as Record<string, any>).RPC_MAX_BODY_BYTES ?? 384 * 1024 * 1024;
    const answer = await callRpc(harness, { method: 'assets.import', params: { filler: 'x'.repeat(cap + 1024) } });
    expect(answer.status).toBe(413);
    expect(answer.json?.error?.code).toBe('body-too-large');
    harness.dispose();
  });
});

describe('dsh Host channel — terminal over the websocket', () => {
  /** Build one masked client frame, the way a browser sends them. */
  function clientFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : (() => {
      const h = Buffer.alloc(4);
      h[0] = 0x81;
      h[1] = 0x80 | 126;
      h.writeUInt16BE(payload.length, 2);
      return h;
    })();
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    return Buffer.concat([header, mask, masked]);
  }

  /** Parse every complete unmasked text frame the server wrote. */
  function serverMessages(chunks: Buffer[]): unknown[] {
    const buffer = Buffer.concat(chunks);
    const out: unknown[] = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const length = buffer[offset + 1] & 0x7f;
      let headerBytes = 2;
      let payloadLength = length;
      if (length === 126) {
        payloadLength = buffer.readUInt16BE(offset + 2);
        headerBytes = 4;
      }
      const start = offset + headerBytes;
      if (start + payloadLength > buffer.length) break;
      const payload = buffer.subarray(start, start + payloadLength).toString('utf8');
      if ((buffer[offset] & 0x0f) === 1) out.push(JSON.parse(payload));
      offset = start + payloadLength;
    }
    return out;
  }

  function openSocket(harness: Harness) {
    const route = harness.upgrades.get(`${channel.PREFIX}/ws`);
    if (route === undefined) throw new Error('ws route is not registered');
    const socket = new EventEmitter() as EventEmitter & {
      write: (chunk: Buffer) => boolean;
      destroy: () => void;
      end: () => void;
      destroyed: boolean;
    };
    const written: Buffer[] = [];
    socket.write = (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      // The route's first write is the HTTP 101 handshake, not a frame. Feeding it to the
      // frame parser would desynchronise every offset after it and silently yield nothing.
      if (!buffer.toString('utf8').startsWith('HTTP/1.1 101')) written.push(buffer);
      return true;
    };
    socket.destroy = () => {
      socket.destroyed = true;
      socket.emit('close');
    };
    socket.end = () => socket.emit('close');
    socket.destroyed = false;
    route.handler(
      { headers: { host: '127.0.0.1:4321', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } },
      socket
    );
    return {
      socket,
      written,
      send(message: unknown) {
        socket.emit('data', clientFrame(JSON.stringify(message)));
      },
      frames: () => serverMessages(written)
    };
  }

  /** A terminal face that records what the channel asked of it and can emit on demand. */
  function terminalFace() {
    const calls: Array<[string, unknown]> = [];
    let emit: ((event: unknown) => void) | undefined;
    const api = {
      open(options: { emit: (event: unknown) => void }) {
        emit = options.emit;
        calls.push(['open', { serverId: (options as { serverId?: string }).serverId }]);
        return Promise.resolve({
          write: (data: string) => void calls.push(['write', data]),
          resize: (rows: number, cols: number) => void calls.push(['resize', [rows, cols]]),
          setPaused: (paused: boolean) => void calls.push(['setPaused', paused]),
          close: () => void calls.push(['close', null])
        });
      },
      trustHost: async (request: unknown) => {
        calls.push(['trustHost', request]);
        return { trusted: true, host: 'h', port: 22 };
      }
    };
    return { api, calls, emit: (event: unknown) => emit?.(event) };
  }

  const flushTicks = async () => {
    for (let i = 0; i < 4; i += 1) await flush();
  };

  it('opens a terminal, then routes input, resize, pause and close to it', async () => {
    const face = terminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const ws = openSocket(harness);

    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks();

    expect(face.calls[0]).toEqual(['open', { serverId: 'srv-1' }]);
    let frames = ws.frames();
    expect(frames).toContainEqual(expect.objectContaining({ type: 'terminal.opened', id: 'a' }));

    ws.send({ type: 'terminal.input', id: 'a', data: 'ls\r' });
    ws.send({ type: 'terminal.resize', id: 'a', rows: 40, cols: 120 });
    ws.send({ type: 'terminal.pause', id: 'a', paused: true });
    ws.send({ type: 'terminal.close', id: 'a' });
    await flushTicks();

    expect(face.calls.slice(1)).toEqual([
      ['write', 'ls\r'],
      ['resize', [40, 120]],
      ['setPaused', true],
      ['close', null]
    ]);
    harness.dispose();
  });

  it('forwards session events to the socket, carrying output as base64', async () => {
    const face = terminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const ws = openSocket(harness);
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks();
    const before = ws.frames().length;

    // A PTY stream is arbitrary bytes, so the wire carries base64: a split multi-byte
    // sequence would corrupt a plain JSON string.
    face.emit({ type: 'output', data: Buffer.from('héllo').toString('base64') });
    face.emit({ type: 'status', state: 'connected', text: 'ok' });
    face.emit({ type: 'error', code: 'host-key-unknown', message: 'unknown', fingerprint: 'SHA256:abc' });

    const frames = ws.frames().slice(before);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'terminal.output', id: 'a' }));
    const output = frames.find((frame) => (frame as { type?: string }).type === 'terminal.output') as {
      data: string;
    };
    expect(Buffer.from(output.data, 'base64').toString('utf8')).toBe('héllo');
    expect(frames).toContainEqual(expect.objectContaining({ type: 'terminal.status', id: 'a', state: 'connected' }));
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'terminal.error', id: 'a', code: 'host-key-unknown', fingerprint: 'SHA256:abc' })
    );
    harness.dispose();
  });

  it('refuses a second terminal with the same id on one socket', async () => {
    const face = terminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const ws = openSocket(harness);
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks();
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-2', rows: 24, cols: 80 });
    await flushTicks();

    expect(face.calls.filter(([name]) => name === 'open')).toHaveLength(1);
    expect(ws.frames()).toContainEqual(expect.objectContaining({ type: 'terminal.error', id: 'a', code: 'already-open' }));
    harness.dispose();
  });

  it('reports an unknown terminal instead of throwing', async () => {
    const face = terminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const ws = openSocket(harness);
    ws.send({ type: 'terminal.input', id: 'nope', data: 'x' });
    await flushTicks();

    expect(ws.frames()).toContainEqual(
      expect.objectContaining({ type: 'terminal.error', id: 'nope', code: 'no-such-terminal' })
    );
    harness.dispose();
  });

  it('reports a failed connect with the code the service threw', async () => {
    const harness = createHarness(undefined, undefined, () => ({
      open: async () => {
        throw Object.assign(new Error('no server with id "x"'), { code: 'no-such-server' });
      },
      trustHost: async () => ({ trusted: true, host: 'h', port: 22 })
    }));
    const ws = openSocket(harness);
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'x', rows: 24, cols: 80 });
    await flushTicks();

    expect(ws.frames()).toContainEqual(
      expect.objectContaining({ type: 'terminal.error', id: 'a', code: 'no-such-server' })
    );
    harness.dispose();
  });

  it('sends one frame per root failure: a coded report is never trailed by a generic one', async () => {
    // The defect a real connect surfaced: the verifier reports `host-key-unknown` with the
    // fingerprint, then ssh2's refusal rejects `open()` with "Host denied (verification
    // failed)". The channel appended a second, generic `connect-failed` frame — and the
    // panel keeps the LAST error it sees, so the coded refusal and its fingerprint were
    // replaced by a message with no action attached, and "trust this host" never appeared.
    const harness = createHarness(undefined, undefined, () => ({
      open: async (options: { emit: (event: unknown) => void }) => {
        options.emit({
          type: 'error',
          code: 'host-key-unknown',
          message: '10.0.0.1:22 is not a known host.',
          fingerprint: 'SHA256:abc'
        });
        throw new Error('Host denied (verification failed)');
      },
      trustHost: async () => ({ trusted: true, host: 'h', port: 22 })
    }));
    const ws = openSocket(harness);
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks();

    const errors = ws.frames().filter((frame) => (frame as { type?: string }).type === 'terminal.error');
    expect(errors).toEqual([
      expect.objectContaining({
        id: 'a',
        code: 'host-key-unknown',
        fingerprint: 'SHA256:abc'
      })
    ]);
    expect(JSON.stringify(errors)).not.toContain('connect-failed');
    harness.dispose();
  });

  it('disposes every terminal a socket opened when the socket goes away', async () => {
    const face = terminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const ws = openSocket(harness);
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks();

    ws.socket.destroy();

    expect(face.calls.filter(([name]) => name === 'close')).toHaveLength(1);
    harness.dispose();
  });

  it('says the terminal services are unavailable when no face was mounted', async () => {
    const harness = createHarness();
    const ws = openSocket(harness);
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks();

    expect(ws.frames()).toContainEqual(
      expect.objectContaining({ type: 'terminal.error', id: 'a', code: 'services-unavailable' })
    );
    harness.dispose();
  });

  it('exposes trust as a request/response call, not a stream message', async () => {
    const face = terminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const answer = await callRpc(harness, {
      method: 'terminal.trustHost',
      params: { serverId: 'srv-1', fingerprint: 'SHA256:abc' }
    });
    expect(answer.json?.result).toEqual({ trusted: true, host: 'h', port: 22 });
    expect(face.calls).toContainEqual(['trustHost', { serverId: 'srv-1', fingerprint: 'SHA256:abc' }]);
    harness.dispose();
  });

  /** A terminal face whose `open` settles only when the test says so — the race harness. */
  function deferredTerminalFace() {
    const calls: Array<[string, unknown]> = [];
    let release: (() => void) | undefined;
    const api = {
      open() {
        calls.push(['open', null]);
        return new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => ({
          write: (data: string) => void calls.push(['write', data]),
          resize: (rows: number, cols: number) => void calls.push(['resize', [rows, cols]]),
          setPaused: (paused: boolean) => void calls.push(['setPaused', paused]),
          close: () => void calls.push(['close', null])
        }));
      },
      trustHost: async () => ({ trusted: true, host: 'h', port: 22 })
    };
    return { api, calls, release: () => release?.() };
  }

  it('treats frames that race an in-flight open as the race they are, not as errors', async () => {
    // The regression the user hit on the first real connect: the browser terminal
    // fits itself and reports the size the moment the pane turns visible — while
    // the SSH connect is still running. The Host used to answer that resize with
    // `no-such-terminal`, which the panel rendered as an error banner over a
    // perfectly healthy connect.
    const face = deferredTerminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const ws = openSocket(harness);

    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks(); // open in flight; the placeholder exists

    ws.send({ type: 'terminal.resize', id: 'a', rows: 30, cols: 100 });
    ws.send({ type: 'terminal.input', id: 'a', data: 'ls\r' });
    ws.send({ type: 'terminal.pause', id: 'a', paused: true });
    await flushTicks();

    expect(ws.frames().filter((frame) => (frame as { type?: string }).type === 'terminal.error')).toEqual([]);
    // Nothing reached a session that does not exist yet.
    expect(face.calls).toEqual([['open', null]]);

    face.release();
    await flushTicks();
    expect(ws.frames()).toContainEqual(expect.objectContaining({ type: 'terminal.opened', id: 'a' }));

    // Once the open settles, the same frames flow through to the live session.
    ws.send({ type: 'terminal.resize', id: 'a', rows: 30, cols: 100 });
    await flushTicks();
    expect(face.calls).toContainEqual(['resize', [30, 100]]);
    harness.dispose();
  });

  it('cancels an in-flight open when the client closes mid-connect', async () => {
    const face = deferredTerminalFace();
    const harness = createHarness(undefined, undefined, () => face.api);
    const ws = openSocket(harness);

    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    await flushTicks();
    ws.send({ type: 'terminal.close', id: 'a' });
    await flushTicks();

    // A close during connecting is a user changing their mind, not a protocol error.
    expect(ws.frames().filter((frame) => (frame as { type?: string }).type === 'terminal.error')).toEqual([]);

    // When the connect finally settles, the session is disposed, not announced.
    face.release();
    await flushTicks();
    expect(face.calls).toContainEqual(['close', null]);
    expect(ws.frames().some((frame) => (frame as { type?: string }).type === 'terminal.opened')).toBe(false);

    // A fresh open with the same id works: the cancelled placeholder is gone.
    ws.send({ type: 'terminal.open', id: 'a', serverId: 'srv-1', rows: 24, cols: 80 });
    face.release();
    await flushTicks();
    expect(ws.frames()).toContainEqual(expect.objectContaining({ type: 'terminal.opened', id: 'a' }));
    harness.dispose();
  });
});

describe('dsh Host channel — server records', () => {
  it('passes list, save and remove straight through', async () => {
    const calls: unknown[] = [];
    const face = {
      list: async () => {
        calls.push(['list', null]);
        return { servers: [], groups: [], privateKeyDirectory: '/keys' };
      },
      save: async (input: unknown) => {
        calls.push(['save', input]);
        return { id: 'srv-1' };
      },
      remove: async (id: string) => {
        calls.push(['remove', id]);
        return { removed: true };
      }
    };
    const harness = createHarness(undefined, () => face);

    expect((await callRpc(harness, { method: 'servers.list' })).json?.result).toMatchObject({
      privateKeyDirectory: '/keys'
    });
    await callRpc(harness, { method: 'servers.save', params: { server: { label: 'a' } } });
    await callRpc(harness, { method: 'servers.remove', params: { id: 'srv-1' } });

    expect(calls).toEqual([['list', null], ['save', { label: 'a' }], ['remove', 'srv-1']]);
    harness.dispose();
  });

  it('reports missing server services as a coded failure', async () => {
    const harness = createHarness();
    const answer = await callRpc(harness, { method: 'servers.list' });
    expect(answer.status).toBe(200);
    expect(answer.json?.error?.code).toBe('services-unavailable');
    harness.dispose();
  });

  it('refuses a forged Origin, a rebound Host, a cross-site request and a non-JSON body', async () => {
    // The fence's failure mode is silent: a wrongly refused request leaves the panel blank,
    // which is indistinguishable from a client that never loaded. Each refusal therefore has
    // to be asserted here, and every one of them is counted in `state.get().rejected`.
    const harness = createHarness();

    // Same-origin, no Origin at all: a non-browser client on loopback (the probe script).
    expect((await callRpc(harness, { method: 'ping' })).status).toBe(200);
    // Same-origin, Origin present and matching the Host authority.
    const same = await callRpc(harness, { method: 'ping' }, 'POST', {
      origin: 'http://127.0.0.1:4321'
    });
    expect(same.status).toBe(200);
    // The Desktop shell's own page: a `dsh-app:` origin may not be forged by a web page.
    const shell = await callRpc(harness, { method: 'ping' }, 'POST', { origin: 'dsh-app://app' });
    expect(shell.status).toBe(200);
    // …and the same page if the IPC carrier forwards the URL's `app` authority as Host.
    const carrier = await callRpc(harness, { method: 'ping' }, 'POST', {
      host: 'app',
      origin: 'dsh-app://app'
    });
    expect(carrier.status).toBe(200);

    // A page on another origin.
    const forged = await callRpc(harness, { method: 'ping' }, 'POST', {
      origin: 'https://evil.example'
    });
    expect(forged.status).toBe(403);
    expect(forged.json?.error?.code).toBe('forbidden');

    // DNS rebinding: the socket reaches loopback but Host names the attacker.
    const rebound = await callRpc(harness, { method: 'ping' }, 'POST', {
      host: 'evil.example:4321'
    });
    expect(rebound.status).toBe(403);

    // A browser that tells us it is cross-site, even without an Origin (some GET-shaped
    // requests carry no Origin at all).
    const crossSite = await callRpc(harness, { method: 'ping' }, 'POST', {
      'sec-fetch-site': 'cross-site'
    });
    expect(crossSite.status).toBe(403);

    // No Host header at all: nothing to trust.
    const noHost = await callRpc(harness, { method: 'ping' }, 'POST', { host: '' });
    expect(noHost.status).toBe(403);

    // A "simple request" a form or an <img> can make without a preflight.
    const textPlain = await callRpc(harness, { method: 'ping' }, 'POST', {
      'content-type': 'text/plain'
    });
    expect(textPlain.status).toBe(415);
    expect(textPlain.json?.error?.code).toBe('unsupported-media-type');

    const state = await callRpc(harness, { method: 'state.get' });
    expect(state.json?.result).toMatchObject({ rejected: 5 });
    // Nothing refuses silently: the reason names the request's own claims.
    expect(harness.logs.join('\n')).toContain('origin=https://evil.example');
    harness.dispose();
  });

  it('refuses the SSE and WebSocket routes with the same fence', async () => {
    const harness = createHarness();

    const events = harness.routes.get(`${channel.PREFIX}/events`)!;
    let sseStatus = 0;
    events.handler(
      { method: 'GET', url: `${channel.PREFIX}/events`, headers: { host: '127.0.0.1:4321', origin: 'https://evil.example' } },
      { writeHead: (code: number) => void (sseStatus = code), end: () => {}, write: () => true, on: () => {} }
    );
    expect(sseStatus).toBe(403);

    const ws = harness.upgrades.get(`${channel.PREFIX}/ws`)!;
    const written: string[] = [];
    let destroyed = false;
    ws.handler(
      { headers: { host: '127.0.0.1:4321', origin: 'https://evil.example', 'sec-websocket-key': 'x' } },
      { write: (chunk: Buffer) => void written.push(String(chunk)), destroy: () => void (destroyed = true) }
    );
    expect(written.join('')).toContain('403 Forbidden');
    expect(destroyed).toBe(true);

    harness.dispose();
  });
});

/**
 * `terminal.hostKeys` — the route the settings tab reads the trust library through.
 *
 * Asserted rather than assumed because the route name is the only contract between the two
 * halves: a typo here is a page that silently shows "nothing trusted" forever, which reads
 * exactly like an empty library.
 */
describe('dsh Host channel — trust library', () => {
  it('passes the whole library through the terminal service', async () => {
    const rows = [
      { host: '10.0.133.11', port: 22, fingerprint: 'SHA256:aaa', trustedAt: 2 },
      { host: '18.199.246.45', port: 2222, fingerprint: 'SHA256:bbb', trustedAt: 1 }
    ];
    let asked = 0;
    const face = {
      listHostKeys: async () => {
        asked += 1;
        return rows;
      }
    };
    const harness = createHarness(undefined, undefined, () => face);

    const answer = await callRpc(harness, { method: 'terminal.hostKeys' });

    expect(answer.status).toBe(200);
    expect(answer.json?.result).toEqual(rows);
    expect(asked).toBe(1);
    harness.dispose();
  });

  it('reports a missing terminal service instead of answering with an empty library', async () => {
    const harness = createHarness();
    const answer = await callRpc(harness, { method: 'terminal.hostKeys' });
    expect(answer.json?.error?.code).toBe('services-unavailable');
    harness.dispose();
  });
});
