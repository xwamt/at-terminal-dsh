import { describe, expect, it } from 'vitest';

import { parseServerConfig, type ServerConfig } from '../../../src/config/schema';
import {
  createDshSftpApi,
  SFTP_ERROR_DISCONNECTED,
  SFTP_ERROR_NO_ACTIVE_TERMINAL,
  SFTP_TEXT_MAX_BYTES,
  SFTP_TRANSFER_MAX_BYTES
} from '../../../src/platform/dsh/sftp';
import type { Platform } from '../../../src/core/ports';
import type { HostKeyVerifier } from '../../../src/ssh/SshConnectionConfig';
import type { SftpSessionLike } from '../../../src/sftp/SftpManager';
import type { SftpEntry, SftpFileStat } from '../../../src/sftp/SftpTypes';
import { createFakePlatform } from '../../core/fakes';

/**
 * The dsh SFTP face, driven against a fake SFTP session.
 *
 * The session is the only thing faked: `SftpManager`, the state machine and the refusal
 * recording are the real ones, because those are what this milestone had to get right. A
 * fake session is what makes it possible to assert on **which** terminal the tree followed
 * and what a disconnect leaves behind without needing an SSH server.
 */

function server(id: string, label: string): ServerConfig {
  return parseServerConfig({
    id,
    label,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  });
}

/** A platform whose state already holds the given servers, so `ConfigManager` finds them. */
function platformWith(servers: ServerConfig[]): Platform {
  const platform = createFakePlatform();
  void platform.state.update('sshManager.servers', servers);
  return platform;
}

function entry(name: string, path: string, type: SftpEntry['type'], targetType?: 'file' | 'directory'): SftpEntry {
  return { name, path, type, ...(targetType === undefined ? {} : { targetType }) };
}

/** A tree keyed by absolute path; a path absent from it raises the way a real listing does. */
class FakeSftpWorld {
  readonly listings = new Map<string, SftpEntry[]>();
  realRoot = '/home/root';
  /** Counts `listDirectory` calls, so a cache can be told apart from a real re-read. */
  listCalls = 0;
  /** Invoked inside `connect()`, so a test can drive the verifier the way ssh2 would. */
  onConnect: ((verifier: HostKeyVerifier) => Promise<void>) | undefined;
  /** Thrown from `connect()` after `onConnect`, standing in for ssh2's generic denial. */
  connectError: unknown;
  /** When set, every `listDirectory` throws it — for read-failure cases. */
  listError: unknown;

  /**
   * The remote files this world holds, keyed by absolute path.
   *
   * A second map rather than reusing `listings`, because the two answer different questions:
   * a listing is what a *directory* contains, and this is what a *file* holds. Collapsing
   * them would let a test "read" a directory, which the real face refuses.
   */
  readonly files = new Map<string, Buffer>();
  /** Every `writeFile` this world received, so an upload can be asserted byte-for-byte. */
  readonly writes: Array<{ path: string; content: Buffer }> = [];
  /** When set, every `writeFile` throws it — for permission-denied cases. */
  writeError: unknown;
  /** When set, every `stat` throws it. */
  statError: unknown;
  /**
   * mtimes served in order by successive `stat` calls, so a test can drive the
   * "somebody else changed the file" branch deterministically. Empty means "derive from the
   * file's length", which is stable and therefore never looks like a conflict.
   */
  statSequence: number[] = [];
  fakeStatSize = new Map<string, number>();

  statCalls = 0;

  session(): SftpSessionLike {
    const world = this;
    const unused = (): never => {
      throw new Error('this surface does not call it');
    };
    return {
      async connect(): Promise<void> {
        if (world.onConnect !== undefined) await world.onConnect(world.currentVerifier!);
        if (world.connectError !== undefined) throw world.connectError;
      },
      async realpath(path?: string): Promise<string> {
        return path === undefined || path === '.' ? world.realRoot : path;
      },
      async listDirectory(path: string): Promise<SftpEntry[]> {
        world.listCalls += 1;
        if (world.listError !== undefined) throw world.listError;
        // `SftpManager` lists `'.'` before a root has been resolved, exactly as the VS Code
        // variant does; a real server resolves it against the login directory.
        const target = path === '.' ? world.realRoot : path;
        const found = world.listings.get(target);
        if (found === undefined) {
          // ssh2's own shape for a protocol status error: a **numeric** `code`
          // (`SFTP.js` compares `er.code === STATUS_CODE.EOF`) and a status message.
          // Modelling it as a Node-style string code is what made a broken directory read
          // look like a missing private key.
          throw Object.assign(new Error('No such file or directory'), { code: 2 });
        }
        return found;
      },
      async stat(path: string): Promise<SftpFileStat> {
        world.statCalls += 1;
        if (world.statError !== undefined) throw world.statError;
        // A directory in `listings` stats as one; anything in `files` as a file. A path in
        // neither is ssh2's own no-such-file status.
        const isDirectory = [...world.listings.keys()].includes(path);
        const content = world.files.get(path);
        if (!isDirectory && content === undefined && !world.fakeStatSize.has(path)) {
          throw Object.assign(new Error('No such file or directory'), { code: 2 });
        }
        const size = world.fakeStatSize.get(path) ?? (isDirectory ? 0 : content!.length);
        const modifiedAt = world.statSequence.length > 0 ? world.statSequence.shift()! : size;
        return { size, modifiedAt, type: isDirectory ? 'directory' : 'file' };
      },
      async readFile(path: string, maxBytes: number, offset = 0): Promise<Buffer> {
        const content = world.files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error('No such file or directory'), { code: 2 });
        }
        const start = offset >= 0 ? offset : Math.max(0, content.length + offset);
        return content.subarray(start, start + Math.max(0, maxBytes));
      },
      async writeFile(path: string, content: Buffer): Promise<void> {
        if (world.writeError !== undefined) throw world.writeError;
        world.writes.push({ path, content: Buffer.from(content) });
        world.files.set(path, Buffer.from(content));
      },
      mkdir: unused,
      rename: unused,
      async deleteFile(path: string): Promise<void> {
        if (world.writeError !== undefined) throw world.writeError;
        world.files.delete(path);
      },
      async deleteDirectory(path: string): Promise<void> {
        if (world.writeError !== undefined) throw world.writeError;
        world.listings.delete(path);
      },
      countDeletableEntries: unused,
      uploadFile: unused,
      downloadFile: unused,
      uploadDirectory: unused,
      downloadDirectory: unused,
      async createFile(path: string): Promise<void> {
        if (world.writeError !== undefined) throw world.writeError;
        world.files.set(path, Buffer.alloc(0));
      },
      dispose(): void {
        /* the manager owns disposal; nothing here holds a resource */
      }
    } as unknown as SftpSessionLike;
  }

  /** Set by the factory below so `connect()` can invoke the face's own verifier. */
  currentVerifier: HostKeyVerifier | undefined;
}

/** Build the face over a world, capturing the verifier each session was handed. */
function build(servers: ServerConfig[], world: FakeSftpWorld) {
  const platform = platformWith(servers);
  const sessions: SftpSessionLike[] = [];
  const api = createDshSftpApi({
    platform,
    createSession: (_context, verifier) => {
      world.currentVerifier = verifier;
      const session = world.session();
      sessions.push(session);
      return session;
    }
  });
  return { api, sessions, platform };
}

function presence(id: string, config: ServerConfig) {
  return { terminalId: id, server: config, write: () => undefined };
}

const FIRST = server('s1', 'First');
const SECOND = server('s2', 'Second');

describe('dsh SFTP face — following the terminal', () => {
  it('reports `none` before any terminal exists, and refuses to go up', async () => {
    const world = new FakeSftpWorld();
    const { api } = build([FIRST], world);

    const listing = await api.list();
    expect(listing.kind).toBe('none');
    expect(listing.rootPath).toBeNull();
    expect(listing.entries).toEqual([]);
    expect(listing.serverId).toBeNull();

    // `..` needs something to go up from, and there is a distinct code for "nothing is
    // connected" — separate from "you asked for a subdirectory of a dead tree".
    await expect(api.goUp()).rejects.toMatchObject({ code: SFTP_ERROR_NO_ACTIVE_TERMINAL });
  });

  it('follows the terminal the Host announced, resolving the root through realpath', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('a.txt', '/home/root/a.txt', 'file'), entry('sub', '/home/root/sub', 'directory')]);
    const { api } = build([FIRST], world);

    api.opened(presence('t1', FIRST));

    const listing = await api.list();
    expect(listing.kind).toBe('active');
    expect(listing.rootPath).toBe('/home/root');
    expect(listing.path).toBe('/home/root');
    expect(listing.serverId).toBe('s1');
    expect(listing.serverLabel).toBe('First');
    // Entries pass through unchanged — the domain's own `SftpEntry`, not a wire copy.
    expect(listing.entries).toEqual([
      { name: 'a.txt', path: '/home/root/a.txt', type: 'file' },
      { name: 'sub', path: '/home/root/sub', type: 'directory' }
    ]);
  });

  it('follows the newest live terminal, not the first one announced', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('from-first', '/home/root/from-first', 'file')]);
    world.realRoot = '/srv/second';
    world.listings.set('/srv/second', [entry('from-second', '/srv/second/from-second', 'file')]);
    const { api } = build([FIRST, SECOND], world);

    api.opened(presence('t1', FIRST));
    api.opened(presence('t2', SECOND));

    const listing = await api.list();
    expect(listing.kind).toBe('active');
    expect(listing.serverId).toBe('s2');
    expect(listing.rootPath).toBe('/srv/second');
    expect(listing.entries.map((item) => item.name)).toEqual(['from-second']);
  });

  /**
   * Two tabs, two file trees — the point of threading `terminalId` through.
   *
   * These reads arrive over HTTP, so nothing in the request identifies the caller. Before
   * `terminalId` existed this face answered with "the newest live session", which with one
   * terminal was a safe default and with two is a coin toss: tab A's tree would show tab B's
   * directory. Each read now names the terminal it means, and the browser learned that id
   * from the `terminal.opened` frame of its own socket. Reverse-tested by ignoring the id.
   */
  it('answers each read with the terminal that asked for it', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('a.txt', '/home/root/a.txt', 'file')]);
    const { api } = build([FIRST, SECOND], world);

    api.opened(presence('t1', FIRST));
    api.opened(presence('t2', SECOND));

    // t2 is the newest, so an unnamed read lands on it either way — the assertion that
    // carries the fix is the *other* one, the read that names the older terminal.
    expect((await api.list({ terminalId: 't2' })).serverId).toBe('s2');
    expect((await api.list({ terminalId: 't1' })).serverId).toBe('s1');
    // And back again, so this is a per-read choice rather than a one-way latch.
    expect((await api.list({ terminalId: 't2' })).serverId).toBe('s2');
  });

  it('still answers an unnamed read with the newest live terminal, for an older caller', async () => {
    const world = new FakeSftpWorld();
    world.realRoot = '/srv/second';
    world.listings.set('/srv/second', [entry('from-second', '/srv/second/from-second', 'file')]);
    const { api } = build([FIRST, SECOND], world);

    api.opened(presence('t1', FIRST));
    api.opened(presence('t2', SECOND));

    const listing = await api.list();
    expect(listing.serverId).toBe('s2');
  });

  it('goes up on the named terminal rather than whichever one it last followed', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('sub', '/home/root/sub', 'directory')]);
    world.listings.set('/home', [entry('root', '/home/root', 'directory')]);
    const { api } = build([FIRST, SECOND], world);

    api.opened(presence('t1', FIRST));
    api.opened(presence('t2', SECOND));

    // Land on t2 first, then walk up on t1. A face that ignored the id would report t2's
    // parent; one that honours it reports t1's, which is the assertion that matters.
    await api.list({ terminalId: 't2' });
    const listing = await api.goUp({ terminalId: 't1' });
    expect(listing.serverId).toBe('s1');
    expect(listing.rootPath).toBe('/home');
  });

  it('falls back to the newest live terminal when the named one is unknown', async () => {
    const world = new FakeSftpWorld();
    world.realRoot = '/srv/second';
    world.listings.set('/srv/second', [entry('from-second', '/srv/second/from-second', 'file')]);
    const { api } = build([FIRST, SECOND], world);

    api.opened(presence('t1', FIRST));
    api.opened(presence('t2', SECOND));

    // A terminalId from a Host that has since restarted names nothing. Refusing would break
    // the read entirely; falling back keeps the single-terminal behaviour intact.
    const listing = await api.list({ terminalId: 'gone-after-restart' });
    expect(listing.kind).toBe('active');
    expect(listing.serverId).toBe('s2');
  });

  it('reads a subdirectory without moving the root', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('sub', '/home/root/sub', 'directory')]);
    world.listings.set('/home/root/sub', [entry('deep.txt', '/home/root/sub/deep.txt', 'file')]);
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));

    const listing = await api.list({ path: '/home/root/sub' });
    expect(listing.kind).toBe('active');
    expect(listing.rootPath).toBe('/home/root');
    expect(listing.path).toBe('/home/root/sub');
    expect(listing.entries.map((item) => item.name)).toEqual(['deep.txt']);
  });

  it('moves the root up with `goUp`', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('sub', '/home/root/sub', 'directory')]);
    world.listings.set('/home', [entry('root', '/home/root', 'directory')]);
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));

    const listing = await api.goUp();
    expect(listing.rootPath).toBe('/home');
    expect(listing.path).toBe('/home');
    expect(listing.entries.map((item) => item.name)).toEqual(['root']);
    // The root moved, so a later bare `list()` reports the new root rather than the old one.
    expect((await api.list()).rootPath).toBe('/home');
  });

  it('keeps the last listing when the terminal disconnects, and says so', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('a.txt', '/home/root/a.txt', 'file')]);
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));
    await api.list();

    api.closed('t1');

    const listing = await api.list();
    expect(listing.kind).toBe('disconnected');
    expect(listing.rootPath).toBe('/home/root');
    expect(listing.entries.map((item) => item.name)).toEqual(['a.txt']);
  });

  it('refuses to read below a disconnected root, instead of reporting an empty directory', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('a.txt', '/home/root/a.txt', 'file')]);
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));
    await api.list();

    api.closed('t1');

    // "This directory is empty" and "nobody can look right now" must not render the same,
    // so this is a coded failure rather than an empty `entries`.
    await expect(api.list({ path: '/home/root/sub' })).rejects.toMatchObject({
      code: SFTP_ERROR_DISCONNECTED
    });
    // The root read itself still works — that is the whole point of the disconnected state.
    await expect(api.list({ path: '/home/root' })).resolves.toMatchObject({ kind: 'disconnected' });
  });

  it('prefers a live terminal over the stale tree of a dead one', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', [entry('stale.txt', '/home/root/stale.txt', 'file')]);
    world.realRoot = '/srv/second';
    world.listings.set('/srv/second', [entry('fresh.txt', '/srv/second/fresh.txt', 'file')]);
    const { api } = build([FIRST, SECOND], world);

    api.opened(presence('t1', FIRST));
    await api.list();
    api.closed('t1');
    expect((await api.list()).kind).toBe('disconnected');

    api.opened(presence('t2', SECOND));

    // Leaving the stale tree up while a live terminal exists is the lie the DoD forbids.
    const listing = await api.list();
    expect(listing.kind).toBe('active');
    expect(listing.serverId).toBe('s2');
    expect(listing.entries.map((item) => item.name)).toEqual(['fresh.txt']);
  });

  it('serves a repeat read from the 20-second cache, and `refresh` drops it', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', []);
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));

    await api.list();
    const afterFirst = world.listCalls;
    await api.list();
    expect(world.listCalls).toBe(afterFirst);

    await api.refresh();
    await api.list();
    expect(world.listCalls).toBeGreaterThan(afterFirst);
  });

  it('works with no terminal at all: `refresh` is cache-only, not a connection attempt', async () => {
    const world = new FakeSftpWorld();
    const { api } = build([FIRST], world);
    await expect(api.refresh()).resolves.toEqual({ refreshed: true });
  });

  it('disposes every session it opened', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', []);
    let disposed = 0;
    const platform = platformWith([FIRST]);
    const api = createDshSftpApi({
      platform,
      createSession: (_context, verifier) => {
        world.currentVerifier = verifier;
        const session = world.session();
        const realDispose = session.dispose.bind(session);
        session.dispose = () => {
          disposed += 1;
          realDispose();
        };
        return session;
      }
    });

    api.opened(presence('t1', FIRST));
    await api.list();
    expect(disposed).toBe(0);

    api.dispose();
    expect(disposed).toBe(1);
  });
});

describe('dsh SFTP face — host-key refusals', () => {
  /**
   * `createHostVerifier` turns a **rejected** `verify()` into `verify(false)`, so ssh2
   * reports a refusal as the generic `Host denied (verification failed)` and the code and
   * fingerprint would be gone. These two cases pin the recording that closes that hole —
   * and the second proves the record cannot outlive the attempt that made it.
   */
  it('reports a refused host key with its code and fingerprint', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', []);
    world.onConnect = async (verifier) => {
      // ssh2's own handshake, reduced to the one call that matters.
      await verifier.verify('10.0.0.1', 22, 'SHA256:abcdef');
    };
    world.connectError = new Error('Host denied (verification failed)');
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));

    await expect(api.list()).rejects.toMatchObject({
      code: 'host-key-unknown',
      fingerprint: 'SHA256:abcdef'
    });
  });

  it('does not let a refusal leak into the next, unrelated failure', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', []);
    let refuse = true;
    world.onConnect = async (verifier) => {
      if (!refuse) return;
      await verifier.verify('10.0.0.1', 22, 'SHA256:abcdef');
    };
    world.connectError = new Error('Host denied (verification failed)');
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));

    await expect(api.list()).rejects.toMatchObject({ code: 'host-key-unknown' });

    // The user accepted the key; the next attempt gets past verification and fails for a
    // reason of its own. Reporting the stale `host-key-unknown` here would send them back
    // to a trust prompt that is already satisfied.
    refuse = false;
    world.connectError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), {
      code: 'ECONNREFUSED'
    });
    await expect(api.list()).rejects.toMatchObject({ code: 'connection-refused' });
  });

  it('does not offer a fingerprint on a failure that never had one', async () => {
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', []);
    world.connectError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), {
      code: 'ECONNREFUSED'
    });
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));

    const failure = await api.list().catch((error: unknown) => error as { fingerprint?: string });
    expect(failure).toMatchObject({ code: 'connection-refused' });
    expect((failure as { fingerprint?: string }).fingerprint).toBeUndefined();
  });
});

describe('dsh SFTP face — read failures are not connect failures', () => {
  /**
   * The connect classifier treats `ENOENT` as "the private key file is missing". An SFTP
   * operation reports a **protocol status** instead — ssh2 gives those a numeric `code` —
   * and running one through the connect classifier produced "the private key could not be
   * read" for a directory that simply was not there. These cases pin the separation.
   */
  const cases: Array<[string, unknown, string]> = [
    ['a missing path', Object.assign(new Error('No such file or directory'), { code: 2 }), 'sftp-no-such-file'],
    ['a denied path', Object.assign(new Error('Permission denied'), { code: 3 }), 'sftp-permission-denied'],
    ['an unrecognised status', Object.assign(new Error('Operation unsupported'), { code: 8 }), 'sftp-read-failed'],
    ['a status-less failure', new Error('the server hung up'), 'sftp-read-failed']
  ];

  for (const [name, error, code] of cases) {
    it(`reports ${name} as ${code}`, async () => {
      const world = new FakeSftpWorld();
      world.listings.set('/home/root', []);
      const { api } = build([FIRST], world);
      api.opened(presence('t1', FIRST));
      world.listError = error;

      await expect(api.list()).rejects.toMatchObject({ code });
    });
  }

  it('never reports a directory read failure as a missing private key', async () => {
    // The regression itself: before the connect/read split, `ENOENT`-shaped read failures
    // were classified through the **connect** path, where that code means the key file is
    // gone — so a directory that could not be read told the user to edit their key path.
    const world = new FakeSftpWorld();
    world.listings.set('/home/root', []);
    const { api } = build([FIRST], world);
    api.opened(presence('t1', FIRST));
    world.listError = Object.assign(new Error('No such file or directory'), { code: 2 });

    let failure: { code: string; message: string } | undefined;
    try {
      await api.list();
    } catch (error) {
      failure = error as { code: string; message: string };
    }
    expect(failure?.code).toBe('sftp-no-such-file');
    expect(failure?.message).not.toMatch(/private key/i);
  });
});

/**
 * The four transfer operations.
 *
 * Every case here is driven through the real `SftpManager` over a fake session, so what is
 * being asserted is the **face's** decisions — which code a refusal carries, what is checked
 * before bytes move, what the caller is told about a conflict — rather than a reimplementation
 * of them. The fake session is the only stand-in.
 */
describe('dsh SFTP face — transferring files', () => {
  /** A world with one file already on the server and a live terminal following it. */
  function worldWithFile(name = 'app.js', content = 'const a = 1;\n') {
    const world = new FakeSftpWorld();
    const path = `/home/root/${name}`;
    world.listings.set('/home/root', [entry(name, path, 'file')]);
    world.files.set(path, Buffer.from(content, 'utf8'));
    const built = build([FIRST], world);
    built.api.opened(presence('t1', FIRST));
    return { world, path, ...built };
  }

  describe('readFile', () => {
    it('reads a text file and reports its stat, its line ending and that it is whole', async () => {
      const { api, path } = worldWithFile('notes.txt', 'alpha\nbeta\n');
      const file = await api.readFile({ path });

      expect(file.path).toBe(path);
      expect(file.text).toBe('alpha\nbeta\n');
      expect(file.eol).toBe('lf');
      expect(file.size).toBe(11);
      expect(file.truncated).toBe(false);
    });

    it('normalises CRLF on the wire and reports it, so the save can put it back', async () => {
      // The reason this matters is `HTMLTextAreaElement`: it rewrites every line ending to
      // `\n` by specification, so a `\r\n` file edited in the panel would come back as LF on
      // every line unless the convention travels as data.
      const { api, path } = worldWithFile('win.ini', '[core]\r\nname=x\r\n');
      const file = await api.readFile({ path });

      expect(file.text).toBe('[core]\nname=x\n');
      expect(file.text).not.toContain('\r');
      expect(file.eol).toBe('crlf');
      // The size the *server* reported, not the normalised text's length — the editor's
      // conflict baseline has to be the real file: 16 bytes carrying 14 visible characters,
      // and the two `\r`s are exactly what the save has to put back.
      expect(file.text.length).toBe(14);
      expect(file.size).toBe(16);
    });

    it('reports a file longer than the cap as truncated, and only fetches the window', async () => {
      const big = 'x'.repeat(50);
      const { api, path } = worldWithFile('big.txt', big);
      const file = await api.readFile({ path, maxBytes: 10 });

      expect(file.truncated).toBe(true);
      expect(file.text).toBe('x'.repeat(10));
      // The full size, so the pane can say how much is missing rather than making the user
      // guess from a cut string.
      expect(file.size).toBe(50);
    });

    it('refuses a binary file with its own code rather than returning mojibake', async () => {
      const { api, path } = worldWithFile('logo.png', 'PNG\u0000\u0001\u0002binary');
      await expect(api.readFile({ path })).rejects.toMatchObject({ code: 'sftp-binary-file' });
    });

    it('refuses a directory with a code that names the actual situation', async () => {
      const world = new FakeSftpWorld();
      world.listings.set('/home/root', [entry('sub', '/home/root/sub', 'directory')]);
      world.listings.set('/home/root/sub', []);
      const { api } = build([FIRST], world);
      api.opened(presence('t1', FIRST));

      // `open(dir, 'r')` would fail with a bare protocol status; the face stats first so the
      // sentence can say what the path is.
      await expect(api.readFile({ path: '/home/root/sub' })).rejects.toMatchObject({
        code: 'sftp-not-a-file'
      });
    });

    it('refuses without a live terminal, keeping the two dead states apart', async () => {
      const world = new FakeSftpWorld();
      world.listings.set('/home/root', []);
      world.files.set('/home/root/a.txt', Buffer.from('x'));
      const { api } = build([FIRST], world);

      // Never connected at all.
      await expect(api.readFile({ path: '/home/root/a.txt' })).rejects.toMatchObject({
        code: SFTP_ERROR_NO_ACTIVE_TERMINAL
      });

      // Connected, then dropped: a different remedy, so a different code.
      api.opened(presence('t1', FIRST));
      await api.list();
      api.closed('t1');
      await expect(api.readFile({ path: '/home/root/a.txt' })).rejects.toMatchObject({
        code: SFTP_ERROR_DISCONNECTED
      });
    });

    it('rejects an empty path before touching the connection', async () => {
      const world = new FakeSftpWorld();
      const { api } = build([FIRST], world);
      await expect(api.readFile({ path: '  ' })).rejects.toMatchObject({ code: 'sftp-bad-params' });
      // No terminal was announced, so a face that checked the connection first would have
      // reported `no-active-terminal` — the parameter is the more specific fact.
      expect(world.statCalls).toBe(0);
    });
  });

  describe('writeFile', () => {
    it('writes the text and answers with the stat the server now reports', async () => {
      const { api, path, world } = worldWithFile('app.js', 'old\n');
      // The first stat is the conflict baseline; the second is the post-write read, which the
      // fake derives from what was actually written (`size`) plus the scripted mtime.
      world.statSequence = [4, 9];
      const written = await api.writeFile({ path, text: 'new content\n', expectedSize: 4, expectedModifiedAt: 4 });

      expect(world.writes).toHaveLength(1);
      expect(world.writes[0].path).toBe(path);
      expect(world.writes[0].content.toString('utf8')).toBe('new content\n');
      // Re-statted, not assumed: the reply is the baseline the *next* save will be checked
      // against, so it has to be the server's answer and not the buffer's length.
      expect(written).toEqual({ path, size: 12, modifiedAt: 9 });
    });

    it('restores the line ending the read reported', async () => {
      const { api, path, world } = worldWithFile('win.ini', 'a\r\nb\r\n');
      await api.writeFile({ path, text: 'a\nb\nc\n', eol: 'crlf', overwrite: true });

      // LF-only in, CRLF out: the whole point of carrying `eol` across the wire.
      expect(world.writes[0].content.toString('utf8')).toBe('a\r\nb\r\nc\r\n');
    });

    it('does not double the carriage returns when a caller sends CRLF by hand', async () => {
      const { api, path, world } = worldWithFile('win.ini', 'a\r\n');
      await api.writeFile({ path, text: 'x\r\ny\r\n', eol: 'crlf', overwrite: true });
      // Stripping `\r` first is what makes the conversion idempotent instead of producing
      // `\r\r\n` on every line.
      expect(world.writes[0].content.toString('utf8')).toBe('x\r\ny\r\n');
    });

    it('refuses a write when the server moved on, unless the caller insists', async () => {
      const { api, path, world } = worldWithFile('app.js', 'old\n');
      // The editor opened it at 4/4; the server now reports 5/5.
      world.statSequence = [5, 5];
      await expect(
        api.writeFile({ path, text: 'mine\n', expectedSize: 4, expectedModifiedAt: 4 })
      ).rejects.toMatchObject({ code: 'sftp-conflict' });
      // Nothing was written: a refused save must not be a half-done one.
      expect(world.writes).toHaveLength(0);

      // And the same call with `overwrite` goes through — the question the UI asks has an
      // answer that works.
      world.statSequence = [5, 5];
      await api.writeFile({ path, text: 'mine\n', expectedSize: 4, expectedModifiedAt: 4, overwrite: true });
      expect(world.writes).toHaveLength(1);
    });

    it('says `writing` when the server refuses the write, not `reading`', async () => {
      const { api, path, world } = worldWithFile('app.js', 'old\n');
      world.writeError = Object.assign(new Error('Permission denied'), { code: 3 });
      let failure: { code: string; message: string } | undefined;
      try {
        await api.writeFile({ path, text: 'x\n', overwrite: true });
      } catch (error) {
        failure = error as { code: string; message: string };
      }
      expect(failure?.code).toBe('sftp-permission-denied');
      expect(failure?.message).toMatch(/writing/);
      expect(failure?.message).not.toMatch(/reading/);
    });

    it('refuses text past the panel cap without attempting the write', async () => {
      const { api, path, world } = worldWithFile('app.js', 'old\n');
      await expect(
        api.writeFile({ path, text: 'x'.repeat(SFTP_TEXT_MAX_BYTES + 1), overwrite: true })
      ).rejects.toMatchObject({ code: 'sftp-file-too-large' });
      expect(world.writes).toHaveLength(0);
    });
  });

  describe('download', () => {
    it('returns the bytes base64 and a name usable as a local filename', async () => {
      const { api, path } = worldWithFile('app.js', 'hello');
      const payload = await api.download({ path });

      expect(payload.path).toBe(path);
      expect(payload.name).toBe('app.js');
      expect(payload.size).toBe(5);
      expect(Buffer.from(payload.base64, 'base64').toString('utf8')).toBe('hello');
    });

    it('sanitises a name the local filesystem could not hold', async () => {
      const world = new FakeSftpWorld();
      const path = '/home/root/we:ird*name.txt';
      world.listings.set('/home/root', []);
      world.files.set(path, Buffer.from('x'));
      const { api } = build([FIRST], world);
      api.opened(presence('t1', FIRST));

      // The same sanitiser the VS Code preview path uses, so both platforms name it alike.
      expect((await api.download({ path })).name).toBe('we_ird_name.txt');
    });

    it('refuses a file over the transfer limit, naming the limit and the way out', async () => {
      const { api, path, world } = worldWithFile('huge.bin', '');
      world.fakeStatSize.set(path, SFTP_TRANSFER_MAX_BYTES + 1);
      let failure: { code: string; message: string } | undefined;
      try {
        await api.download({ path });
      } catch (error) {
        failure = error as { code: string; message: string };
      }
      expect(failure?.code).toBe('sftp-file-too-large');
      expect(failure?.message).toContain(String(SFTP_TRANSFER_MAX_BYTES));
      expect(failure?.message).toMatch(/Terminal page/);
    });

    it('refuses a directory and points at the terminal instead of pretending', async () => {
      const world = new FakeSftpWorld();
      world.listings.set('/home/root', [entry('sub', '/home/root/sub', 'directory')]);
      world.listings.set('/home/root/sub', []);
      const { api } = build([FIRST], world);
      api.opened(presence('t1', FIRST));

      await expect(api.download({ path: '/home/root/sub' })).rejects.toMatchObject({
        code: 'sftp-not-a-file'
      });
    });
  });

  describe('upload', () => {
    it('writes the bytes to a free path', async () => {
      const world = new FakeSftpWorld();
      world.listings.set('/home/root', []);
      const { api } = build([FIRST], world);
      api.opened(presence('t1', FIRST));
      // The stat that answers "is it there?" is a no-such-file, which is a *free* path.
      world.statSequence = [7];

      const result = await api.upload({
        path: '/home/root/new.txt',
        base64: Buffer.from('fresh\n').toString('base64')
      });

      expect(world.writes[0].content.toString('utf8')).toBe('fresh\n');
      // The server's own stat after the write (6 bytes of content, the scripted mtime), not
      // the length of the payload that was sent.
      expect(result).toEqual({ path: '/home/root/new.txt', size: 6, modifiedAt: 7 });
    });

    it('refuses to clobber without `overwrite`, and allows it with', async () => {
      const { api, world } = worldWithFile('app.js', 'old\n');
      const base64 = Buffer.from('new\n').toString('base64');

      await expect(api.upload({ path: '/home/root/app.js', base64 })).rejects.toMatchObject({
        code: 'sftp-conflict'
      });
      expect(world.writes).toHaveLength(0);

      await api.upload({ path: '/home/root/app.js', base64, overwrite: true });
      expect(world.writes[0].content.toString('utf8')).toBe('new\n');
    });

    it('refuses to write a file over a directory', async () => {
      const world = new FakeSftpWorld();
      world.listings.set('/home/root', [entry('sub', '/home/root/sub', 'directory')]);
      world.listings.set('/home/root/sub', []);
      const { api } = build([FIRST], world);
      api.opened(presence('t1', FIRST));

      await expect(
        api.upload({ path: '/home/root/sub', base64: Buffer.from('x').toString('base64') })
      ).rejects.toMatchObject({ code: 'sftp-not-a-file' });
    });

    it('refuses an empty payload as bad parameters, before allocating anything', async () => {
      const { api, world } = worldWithFile();
      await expect(api.upload({ path: '/home/root/x.txt', base64: '' })).rejects.toMatchObject({
        code: 'sftp-bad-params'
      });
      expect(world.writes).toHaveLength(0);
    });

    it('refuses an oversized payload on its *encoded* length', async () => {
      const { api, world } = worldWithFile();
      // 4/3 of the cap, plus room for the envelope — one byte past what the check allows.
      const tooLong = 'A'.repeat(Math.ceil(SFTP_TRANSFER_MAX_BYTES / 3) * 4 + 9);
      await expect(api.upload({ path: '/home/root/x.txt', base64: tooLong })).rejects.toMatchObject({
        code: 'sftp-file-too-large'
      });
      // The point of checking the encoded length: nothing was decoded, so nothing was
      // allocated for a body the Host would have refused anyway.
      expect(world.writes).toHaveLength(0);
    });

    it('creates an empty file and refuses when it already exists', async () => {
      const { api, world } = worldWithFile();
      await expect(api.createFile({ path: '/home/root/app.js' })).rejects.toMatchObject({
        code: 'sftp-conflict'
      });

      const res = await api.createFile({ path: '/home/root/new-file.txt' });
      expect(res).toEqual({ created: true, path: '/home/root/new-file.txt' });
      expect(world.files.has('/home/root/new-file.txt')).toBe(true);
    });

    it('deletes a file or directory and refuses non-existent paths', async () => {
      const { api, world } = worldWithFile();
      await expect(api.delete({ path: '/home/root/non-existent.txt' })).rejects.toMatchObject({
        code: 'sftp-no-such-file'
      });

      const res = await api.delete({ path: '/home/root/app.js' });
      expect(res).toEqual({ deleted: true, path: '/home/root/app.js' });
      expect(world.files.has('/home/root/app.js')).toBe(false);
    });
  });
});
