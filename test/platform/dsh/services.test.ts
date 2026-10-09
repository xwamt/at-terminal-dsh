import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../../../src/config/ConfigManager';
import { createDshPlatform } from '../../../src/platform/dsh/entry';
import {
  createDshServerApi,
  createDshTerminalApi,
  type DshServerInput
} from '../../../src/platform/dsh/services';
import { HostKeyStore } from '../../../src/ssh/HostKeyStore';
import {
  createDshHostFacts,
  createResolvedSettings,
  MemoryCredentialProvider,
  MemoryStorageDomain,
  RecordingDshLogger
} from './host-fakes';

/**
 * The two dsh host services the panels drive: `createDshServerApi` (server records) and
 * `createDshTerminalApi` (the terminal + host-key trust).
 *
 * Same discipline as `assets.test.ts`: the `Platform` is **assembled for real** by
 * `createDshPlatform()` — the state domain is the shipping `at_terminal_state` domain, the
 * credential provider is the shipping credentials-local emulation — and only the host
 * facets are fakes. Nothing between the service and `ConfigManager`/`HostKeyStore` is
 * stubbed, because the whole point of these two factories is that they *compose* those
 * classes rather than reimplementing a rule.
 *
 * ## Not covered here (deliberately)
 *
 * - A successful `open()`: the SSH connect path needs a reachable host, so only the
 *   "no such server" refusal is exercised.
 * - Host-key interaction during `connect()` (`createVerifier`'s unknown/changed events)
 *   and keyboard-interactive fallback.
 * - Backpressure (`setPaused` → `pauseOutput`/`resumeOutput`) on a live session.
 */

const PRIVATE_KEY_DIRECTORY = '/home/user/.ssh/at-terminal';

function agentInput(overrides: Partial<DshServerInput> = {}): DshServerInput {
  return {
    label: 'alpha',
    host: 'alpha.example.com',
    port: 22,
    username: 'deploy',
    authType: 'agent',
    ...overrides
  };
}

/** The `code` the channel half would branch on, or a loud failure if nothing threw. */
async function rejectionCode(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  throw new Error('expected the call to reject, but it resolved');
}

interface Assembled {
  handle: Awaited<ReturnType<typeof createDshPlatform>>;
  configManager: ConfigManager;
  platform: Awaited<ReturnType<typeof createDshPlatform>>['platform'];
}

/** A live handle per test, so a failed assertion still releases the storage domain. */
let openHandles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  openHandles = [];
});

afterEach(async () => {
  for (const handle of openHandles) {
    await handle.close();
  }
  openHandles = [];
});

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function assemble(storageDir: string): Promise<Assembled> {
  const handle = await createDshPlatform({
    logger: new RecordingDshLogger(),
    credentials: new MemoryCredentialProvider(),
    storageDomain: new MemoryStorageDomain(),
    settings: createResolvedSettings({}),
    facts: createDshHostFacts({ storageDir })
  });
  openHandles.push(handle);
  return {
    handle,
    platform: handle.platform,
    configManager: new ConfigManager(handle.platform.state, handle.platform.secrets)
  };
}

async function assembleWithServerApi(storageDir: string) {
  const assembled = await assemble(storageDir);
  const api = createDshServerApi({ platform: assembled.platform, privateKeyDirectory: PRIVATE_KEY_DIRECTORY });
  return { ...assembled, api };
}

describe('dsh server api — list', () => {
  it('reports an empty instance and echoes the private-key directory it was given', async () => {
    const { api, handle } = await assembleWithServerApi(await makeDir('at-dsh-srv-empty-'));

    const result = await api.list();

    expect(result).toEqual({
      servers: [],
      groups: [],
      privateKeyDirectory: PRIVATE_KEY_DIRECTORY
    });
    expect(handle.platform.environment.storageDir).toContain('at-dsh-srv-empty-');
  });
});

describe('dsh server api — save', () => {
  it('creates a record with a generated id whose createdAt equals updatedAt, and lists it', async () => {
    const { api, configManager } = await assembleWithServerApi(await makeDir('at-dsh-srv-create-'));

    const view = await api.save(agentInput({ group: 'prod' }));

    expect(view.id.length).toBeGreaterThan(0);
    expect(view).toMatchObject({
      label: 'alpha',
      group: 'prod',
      host: 'alpha.example.com',
      port: 22,
      username: 'deploy',
      authType: 'agent',
      encoding: 'utf-8',
      keepAliveInterval: 30
    });

    // `DshServerView` carries no timestamps (the browser has no use for them), so the
    // stored record is where createdAt/updatedAt can be checked.
    const [stored] = await configManager.listServers();
    expect(stored.createdAt).toBe(stored.updatedAt);

    const list = await api.list();
    expect(list.servers).toEqual([view]);
    expect(list.groups).toEqual(['prod']);
  });

  it('stores a password write-only: never in the view or the list, but readable via ConfigManager', async () => {
    const { api, configManager } = await assembleWithServerApi(await makeDir('at-dsh-srv-pw-'));

    const view = await api.save(
      agentInput({ authType: 'password', password: 'pw-1' })
    );

    expect(JSON.stringify(view)).not.toContain('pw-1');
    expect(view.hasPassword).toBe(true);
    expect(await configManager.getPassword(view.id)).toBe('pw-1');

    const { servers } = await api.list();
    expect(servers).toHaveLength(1);
    expect(servers[0].hasPassword).toBe(true);
    expect(JSON.stringify(servers)).not.toContain('pw-1');
  });

  it('reports hasPassword false for a password-auth server saved without a password', async () => {
    const { api, configManager } = await assembleWithServerApi(await makeDir('at-dsh-srv-nopw-'));

    const view = await api.save(agentInput({ authType: 'password' }));

    expect(view.hasPassword).toBe(false);
    expect(await configManager.getPassword(view.id)).toBeUndefined();
  });

  it('updates in place: one entry stays, createdAt is preserved and updatedAt advances', async () => {
    const { api, configManager } = await assembleWithServerApi(await makeDir('at-dsh-srv-update-'));
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const created = await api.save(agentInput({ label: 'before' }));
      nowSpy.mockReturnValue(2_000);
      const updated = await api.save(agentInput({ id: created.id, label: 'after' }));

      expect(updated.id).toBe(created.id);
      expect(updated.label).toBe('after');

      const stored = await configManager.listServers();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: created.id, label: 'after', createdAt: 1_000, updatedAt: 2_000 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('treats an unknown id as a create, because the form may submit one it already holds', async () => {
    const { api } = await assembleWithServerApi(await makeDir('at-dsh-srv-newid-'));

    const view = await api.save(agentInput({ id: 'client-chosen-id', label: 'client' }));

    expect(view.id).toBe('client-chosen-id');
    const { servers } = await api.list();
    expect(servers.map((server) => server.id)).toEqual(['client-chosen-id']);
  });

  it('rejects invalid records before writing anything', async () => {
    const { api } = await assembleWithServerApi(await makeDir('at-dsh-srv-invalid-'));

    await expect(api.save(agentInput({ port: 0 }))).rejects.toThrow();
    await expect(api.save(agentInput({ username: '' }))).rejects.toThrow();
    await expect(api.save(agentInput({ authType: 'privateKey' }))).rejects.toThrow();

    // Validation runs inside buildServerConfig, i.e. before ConfigManager.saveServer.
    expect((await api.list()).servers).toEqual([]);
  });

  it('exposes the basename of a private-key path without rewriting the path', async () => {
    const { api } = await assembleWithServerApi(await makeDir('at-dsh-srv-key-'));

    const view = await api.save(
      agentInput({ authType: 'privateKey', privateKeyPath: '/home/u/.ssh/id_ed25519' })
    );

    expect(view.privateKeyPath).toBe('/home/u/.ssh/id_ed25519');
    expect(view.privateKeyFileName).toBe('id_ed25519');
  });

  it('deduplicates and sorts groups, and leaves them alone for an ungrouped server', async () => {
    const { api } = await assembleWithServerApi(await makeDir('at-dsh-srv-groups-'));

    await api.save(agentInput({ label: 'one', group: 'b' }));
    await api.save(agentInput({ label: 'two', group: 'a' }));
    await api.save(agentInput({ label: 'three', group: 'a' }));

    expect((await api.list()).groups).toEqual(['a', 'b']);

    await api.save(agentInput({ label: 'four' }));

    expect((await api.list()).groups).toEqual(['a', 'b']);
  });

  it('omits jumpHostId entirely when the form does not supply one', async () => {
    const { api } = await assembleWithServerApi(await makeDir('at-dsh-srv-jump-'));

    const view = await api.save(agentInput());

    expect(Object.prototype.hasOwnProperty.call(view, 'jumpHostId')).toBe(false);

    const linked = await api.save(agentInput({ label: 'linked', jumpHostId: view.id }));
    expect(Object.prototype.hasOwnProperty.call(linked, 'jumpHostId')).toBe(true);
    expect(linked.jumpHostId).toBe(view.id);
  });
});

describe('dsh server api — remove', () => {
  it('removes an existing record and its stored password', async () => {
    const { api, configManager } = await assembleWithServerApi(await makeDir('at-dsh-srv-remove-'));
    const view = await api.save(agentInput({ authType: 'password', password: 'pw-1' }));
    expect(await configManager.getPassword(view.id)).toBe('pw-1');

    await expect(api.remove(view.id)).resolves.toEqual({ removed: true });

    expect((await api.list()).servers).toEqual([]);
    expect(await configManager.getPassword(view.id)).toBeUndefined();
  });

  it('reports removed:false for an id that does not exist, without throwing', async () => {
    const { api } = await assembleWithServerApi(await makeDir('at-dsh-srv-remove-miss-'));

    await expect(api.remove('nope')).resolves.toEqual({ removed: false });
  });
});

describe('dsh terminal api — refusals', () => {
  it('refuses open() for an unknown server with code no-such-server', async () => {
    const { platform } = await assemble(await makeDir('at-dsh-term-open-'));
    const terminal = createDshTerminalApi({ platform });

    const code = await rejectionCode(() =>
      terminal.open({ serverId: 'nope', rows: 24, cols: 80, emit: () => undefined })
    );

    expect(code).toBe('no-such-server');
  });

  it('refuses trustHost() for an unknown server with code no-such-server', async () => {
    const { platform } = await assemble(await makeDir('at-dsh-term-trust-miss-'));
    const terminal = createDshTerminalApi({ platform });

    const code = await rejectionCode(() =>
      terminal.trustHost({ serverId: 'nope', fingerprint: 'SHA256:abc' })
    );

    expect(code).toBe('no-such-server');
  });
});

describe('dsh terminal api — trustHost', () => {
  it('records the fingerprint in the state store so a later check sees it as trusted', async () => {
    const { platform, configManager } = await assemble(await makeDir('at-dsh-term-trust-'));
    const terminal = createDshTerminalApi({ platform });
    await configManager.saveServer({
      id: 'srv-trust',
      label: 'trust',
      host: 'trust.example.com',
      port: 2222,
      username: 'ops',
      authType: 'agent',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    });

    await expect(
      terminal.trustHost({ serverId: 'srv-trust', fingerprint: 'SHA256:abc' })
    ).resolves.toEqual({ trusted: true, host: 'trust.example.com', port: 2222 });

    // The store reads the same `HostKeyMemento` the platform's state port exposes, so this
    // is the same document `SshSession`'s verifier would consult.
    const store = new HostKeyStore(platform.state);
    await expect(store.check('trust.example.com', 2222, 'SHA256:abc')).resolves.toBe('trusted');
    await expect(store.check('trust.example.com', 2222, 'SHA256:other')).resolves.toBe('changed');
    expect(store.describe('trust.example.com', 2222)).toContain('SHA256:abc');
  });

  /**
   * The jump-host bug, as the user hit it.
   *
   * A connect through a bastion verifies the **bastion's** key before the target's, so the
   * refusal names the bastion. Recording that acceptance against the server the user picked
   * satisfies nothing: the next connect verifies the bastion again and is refused again,
   * which is exactly the "I trusted it and it still fails" report. Reverse-tested by
   * reverting `trustHost` to `hostKeyStore.trust(server.host, server.port, …)`.
   */
  it('records an accepted fingerprint against the refused jump host, not the target server', async () => {
    const { platform, configManager } = await assemble(await makeDir('at-dsh-term-trust-jump-'));
    const terminal = createDshTerminalApi({ platform });
    const base = {
      authType: 'agent' as const,
      keepAliveInterval: 30,
      encoding: 'utf-8' as const,
      createdAt: 1,
      updatedAt: 1
    };
    await configManager.saveServer({
      ...base,
      id: 'srv-bastion',
      label: 'prod-vpn',
      host: '18.199.246.45',
      port: 22,
      username: 'ubuntu'
    });
    await configManager.saveServer({
      ...base,
      id: 'srv-target',
      label: 'payment01',
      host: '10.0.133.11',
      port: 22,
      username: 'ubuntu',
      jumpHostId: 'srv-bastion'
    });

    // What the panel sends after the user accepts: the bastion's address and key.
    await expect(
      terminal.trustHost({
        serverId: 'srv-target',
        fingerprint: 'SHA256:bastion',
        host: '18.199.246.45',
        port: 22
      })
    ).resolves.toEqual({ trusted: true, host: '18.199.246.45', port: 22 });

    const store = new HostKeyStore(platform.state);
    // The bastion is now trusted — this is what the retry actually consults.
    await expect(store.check('18.199.246.45', 22, 'SHA256:bastion')).resolves.toBe('trusted');
    // And nothing was written under the target's address, which is what used to leave the
    // real bastion permanently unknown while looking like a successful trust.
    expect(store.getTrusted('10.0.133.11', 22)).toBeUndefined();
  });

  it('still honours a plain host with no jump chain, and falls back to the server when none is named', async () => {
    const { platform, configManager } = await assemble(await makeDir('at-dsh-term-trust-direct-'));
    const terminal = createDshTerminalApi({ platform });
    await configManager.saveServer({
      id: 'srv-plain',
      label: 'direct',
      host: '203.0.113.9',
      port: 2222,
      username: 'ops',
      authType: 'agent',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    });

    await expect(
      terminal.trustHost({ serverId: 'srv-plain', fingerprint: 'SHA256:a', host: '203.0.113.9', port: 2222 })
    ).resolves.toEqual({ trusted: true, host: '203.0.113.9', port: 2222 });

    // A client that sends no host at all keeps the original behaviour.
    await expect(terminal.trustHost({ serverId: 'srv-plain', fingerprint: 'SHA256:b' })).resolves.toEqual({
      trusted: true,
      host: '203.0.113.9',
      port: 2222
    });
    await expect(new HostKeyStore(platform.state).check('203.0.113.9', 2222, 'SHA256:b')).resolves.toBe('trusted');
  });

  /**
   * The guard that keeps the fix from becoming a bigger hole.
   *
   * Accepting a caller-named host is only safe because the name must be one this server
   * would actually connect to. Without the check, `terminal.trustHost` would write a
   * trusted key for **any** host in the store — trusting a machine the user never reached.
   */
  it('refuses to record a host that is not on the server or its jump chain', async () => {
    const { platform, configManager } = await assemble(await makeDir('at-dsh-term-trust-foreign-'));
    const terminal = createDshTerminalApi({ platform });
    await configManager.saveServer({
      id: 'srv-isolated',
      label: 'isolated',
      host: '198.51.100.7',
      port: 22,
      username: 'ops',
      authType: 'agent',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    });

    // Silently redirected to the server itself rather than writing the stranger's key.
    await expect(
      terminal.trustHost({ serverId: 'srv-isolated', fingerprint: 'SHA256:evil', host: '10.9.9.9', port: 22 })
    ).resolves.toEqual({ trusted: true, host: '198.51.100.7', port: 22 });

    const store = new HostKeyStore(platform.state);
    expect(store.getTrusted('10.9.9.9', 22)).toBeUndefined();
    await expect(store.check('198.51.100.7', 22, 'SHA256:evil')).resolves.toBe('trusted');
  });

  it('follows a multi-hop chain, trusting the host named even when it is two jumps away', async () => {
    const { platform, configManager } = await assemble(await makeDir('at-dsh-term-trust-chain-'));
    const terminal = createDshTerminalApi({ platform });
    const base = {
      authType: 'agent' as const,
      keepAliveInterval: 30,
      encoding: 'utf-8' as const,
      createdAt: 1,
      updatedAt: 1,
      username: 'ops'
    };
    await configManager.saveServer({ ...base, id: 'hop-1', label: 'hop1', host: 'jump1.example', port: 22 });
    await configManager.saveServer({
      ...base,
      id: 'hop-2',
      label: 'hop2',
      host: 'jump2.example',
      port: 22,
      jumpHostId: 'hop-1'
    });
    await configManager.saveServer({
      ...base,
      id: 'chain-target',
      label: 'target',
      host: 'final.example',
      port: 22,
      jumpHostId: 'hop-2'
    });

    await expect(
      terminal.trustHost({ serverId: 'chain-target', fingerprint: 'SHA256:hop1', host: 'jump1.example', port: 22 })
    ).resolves.toEqual({ trusted: true, host: 'jump1.example', port: 22 });
    await expect(new HostKeyStore(platform.state).check('jump1.example', 22, 'SHA256:hop1')).resolves.toBe('trusted');
  });

  /**
   * A `jumpHostId` cycle is reachable input — server records are hand-editable and the form
   * accepts any id — so the chain walk has to terminate on one instead of spinning.
   */
  it('terminates on a jumpHostId cycle', async () => {    const { platform, configManager } = await assemble(await makeDir('at-dsh-term-trust-cycle-'));
    const terminal = createDshTerminalApi({ platform });
    const base = {
      authType: 'agent' as const,
      keepAliveInterval: 30,
      encoding: 'utf-8' as const,
      createdAt: 1,
      updatedAt: 1,
      username: 'ops',
      port: 22
    };
    await configManager.saveServer({ ...base, id: 'cyc-a', label: 'a', host: 'a.example', jumpHostId: 'cyc-b' });
    await configManager.saveServer({ ...base, id: 'cyc-b', label: 'b', host: 'b.example', jumpHostId: 'cyc-a' });

    // Resolves rather than hanging; `a.example` is still reachable, so the cycle's members
    // stay usable instead of being treated as strangers.
    await expect(
      terminal.trustHost({ serverId: 'cyc-a', fingerprint: 'SHA256:a', host: 'a.example', port: 22 })
    ).resolves.toEqual({ trusted: true, host: 'a.example', port: 22 });
    await expect(
      terminal.trustHost({ serverId: 'cyc-a', fingerprint: 'SHA256:b', host: 'b.example', port: 22 })
    ).resolves.toEqual({ trusted: true, host: 'b.example', port: 22 });
  });
});

describe('dsh server api — a blank password means "leave it alone"', () => {
  /**
   * Regression guard. Passing a blank through reached `ctx.credentials.set`, which refuses
   * an empty value, and it refused it **after** the record had been written — so the form
   * reported failure while the server was already in the list, carrying an uncoded error
   * that also leaked the internal credential reference name. The form's own wording is
   * "leave blank to keep the stored password", so a blank has to mean exactly that.
   */
  const PASSWORD = 'ssh-pass-blank-guard';

  it('keeps the stored password when the edit form sends an empty string', async () => {
    const { api, configManager } = await assembleWithServerApi(await makeDir('at-dsh-blank-pw-'));

    const saved = await api.save(agentInput({ authType: 'password', password: PASSWORD }));
    expect(saved.hasPassword).toBe(true);

    const updated = await api.save({
      id: saved.id,
      label: 'renamed through the edit form',
      host: saved.host,
      port: saved.port,
      username: saved.username,
      authType: 'password',
      password: ''
    });

    expect(updated.label).toBe('renamed through the edit form');
    expect(updated.hasPassword).toBe(true);
    expect(await configManager.getPassword(saved.id)).toBe(PASSWORD);
    expect(await configManager.listServers()).toHaveLength(1);
  });

  it('creates a password-auth server with no stored password rather than failing halfway', async () => {
    const { api, configManager } = await assembleWithServerApi(await makeDir('at-dsh-blank-new-'));

    const saved = await api.save(agentInput({ authType: 'password', password: '' }));

    expect(saved.hasPassword).toBe(false);
    // The record exists, so what the form reports and what the list shows cannot disagree.
    expect(await configManager.listServers()).toHaveLength(1);
    expect(await configManager.getPassword(saved.id)).toBeUndefined();
  });
});

/**
 * `forgetHost` — the escape hatch the VS Code variant has had all along
 * (`sshManager.forgetHostKey`) and the dsh port never got.
 *
 * It matters because of the failure the previous fix made possible to *diagnose* but not
 * to clear: an entry recorded under the wrong address reports `host-key-changed` forever,
 * and the only way out was to accept whatever fingerprint appeared next — asking the user
 * to trust a key they have no way to check. Forgetting returns the decision to evidence.
 */
describe('dsh terminal api — forgetHost', () => {
  async function jumpChain(prefix: string) {
    const { platform, configManager } = await assemble(await makeDir(prefix));
    const base = {
      authType: 'agent' as const,
      keepAliveInterval: 30,
      encoding: 'utf-8' as const,
      createdAt: 1,
      updatedAt: 1,
      username: 'ubuntu',
      port: 22
    };
    await configManager.saveServer({ ...base, id: 'bastion', label: 'vpn', host: '18.199.246.45' });
    await configManager.saveServer({
      ...base,
      id: 'target',
      label: 'payment01',
      host: '10.0.133.11',
      jumpHostId: 'bastion'
    });
    return { platform, configManager, api: createDshTerminalApi({ platform }) };
  }

  it('clears a poisoned entry so the host is asked again instead of reporting a change', async () => {
    const { platform, api } = await jumpChain('at-dsh-term-forget-');
    const store = new HostKeyStore(platform.state);

    // The exact shape the old bug produced: the bastion's key filed under the target.
    await store.trust('10.0.133.11', 22, 'SHA256:bastion-key');
    await expect(store.check('10.0.133.11', 22, 'SHA256:real-target-key')).resolves.toBe('changed');

    await expect(api.forgetHost({ serverId: 'target', host: '10.0.133.11', port: 22 })).resolves.toEqual({
      forgot: true,
      host: '10.0.133.11',
      port: 22
    });

    // Unknown, not "changed" — the next connect asks, which is the whole point.
    await expect(store.check('10.0.133.11', 22, 'SHA256:real-target-key')).resolves.toBe('unknown');
  });

  it('reports forgot:false when nothing was stored, rather than claiming it cleared one', async () => {
    const { api } = await jumpChain('at-dsh-term-forget-none-');
    await expect(api.forgetHost({ serverId: 'target', host: '10.0.133.11', port: 22 })).resolves.toEqual({
      forgot: false,
      host: '10.0.133.11',
      port: 22
    });
  });

  it('falls back to the server itself when no host is named, and refuses an unknown server', async () => {
    const { platform, api } = await jumpChain('at-dsh-term-forget-fallback-');
    await new HostKeyStore(platform.state).trust('10.0.133.11', 22, 'SHA256:a');
    await expect(api.forgetHost({ serverId: 'target' })).resolves.toEqual({
      forgot: true,
      host: '10.0.133.11',
      port: 22
    });

    const code = await rejectionCode(() => api.forgetHost({ serverId: 'nope' }));
    expect(code).toBe('no-such-server');
  });

  /** The same bound as `trustHost`: forgetting is not a licence to clear an unrelated host. */
  it('refuses to clear a host that is not on the server or its jump chain', async () => {
    const { platform, api } = await jumpChain('at-dsh-term-forget-foreign-');
    const store = new HostKeyStore(platform.state);
    await store.trust('203.0.113.50', 22, 'SHA256:stranger');

    // Redirected to the server itself — the stranger's record is untouched.
    await expect(api.forgetHost({ serverId: 'target', host: '203.0.113.50', port: 22 })).resolves.toEqual({
      forgot: false,
      host: '10.0.133.11',
      port: 22
    });
    expect(store.getTrusted('203.0.113.50', 22)).toBeDefined();
  });

  it('clears the bastion entry when the bastion is the host named', async () => {
    const { platform, api } = await jumpChain('at-dsh-term-forget-bastion-');
    const store = new HostKeyStore(platform.state);
    await store.trust('18.199.246.45', 22, 'SHA256:vpn');

    await expect(api.forgetHost({ serverId: 'target', host: '18.199.246.45', port: 22 })).resolves.toEqual({
      forgot: true,
      host: '18.199.246.45',
      port: 22
    });
    expect(store.getTrusted('18.199.246.45', 22)).toBeUndefined();
  });
});
