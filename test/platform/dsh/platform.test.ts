import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../../../src/config/ConfigManager';
import type { ServerConfig } from '../../../src/config/schema';
import { createDshPlatform } from '../../../src/platform/dsh';
import { AT_TERMINAL_STATE_DOMAIN, AT_TERMINAL_STATE_TABLE } from '../../../src/platform/dsh/state';
import { clearPlatform, platform, setPlatform } from '../../../src/platform/current';
import { HostKeyStore } from '../../../src/ssh/HostKeyStore';
import { resolveTerminalSettings } from '../../../src/terminal/terminalSettings';
import { createFakePlatform } from '../../core/fakes';
import {
  createDshHostFacts,
  createResolvedSettings,
  FakeDomainError,
  MemoryCredentialProvider,
  MemoryStorageDomain,
  RecordingDshLogger
} from './host-fakes';

/**
 * Assembly-level evidence for M2 — the dsh half of the milestone gate.
 *
 * Every test here drives a **real domain class** (`ConfigManager`, `HostKeyStore`,
 * `resolveTerminalSettings`) against the assembled dsh `Platform`. Nothing is
 * mocked between the two: the layers under test are the same ones the shipping
 * plugin will use, so a signature drift between the port layer and the domain
 * becomes a failure here rather than a runtime surprise in the installed app.
 *
 * This is the part of DSH-18 that does not need a remote host: the plan's full gate
 * ("新增服务器 → 连接 → 列目录 → 写文件 → 读回 → 删除") needs a reachable SSH
 * server, but "资产持久化闭环" does not, and it is the half DSH-13/DSH-14 are
 * actually responsible for.
 */

async function assemble(overrides: { domain?: MemoryStorageDomain } = {}) {
  const logger = new RecordingDshLogger();
  const credentials = new MemoryCredentialProvider();
  const domain = overrides.domain ?? new MemoryStorageDomain();
  const handle = await createDshPlatform({
    logger,
    credentials,
    storageDomain: domain,
    settings: createResolvedSettings({
      terminalFontSize: 15,
      scrollback: 20_000,
      semanticHighlight: false,
      idleDisconnectMinutes: 0,
      sessionLogDirectory: '',
      terminalFontFamily: 'Menlo, monospace',
      zebraStripes: true
    }),
    facts: createDshHostFacts()
  });
  return { handle, logger, credentials, domain };
}

/**
 * The host's failures carry a machine-readable `code` and a human message, and the two
 * say different things (`DomainError('already-open', "domain 'x' is already open")`).
 * Assertions must name the code, or they end up matching prose.
 */
async function rejection(run: () => Promise<unknown>): Promise<FakeDomainError> {
  try {
    await run();
  } catch (error) {
    return error as FakeDomainError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-1',
    label: 'web-01',
    host: '10.0.0.1',
    port: 22,
    username: 'ops',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe('M2 assembly — createDshPlatform', () => {
  it('builds all eleven ports', async () => {
    const { handle } = await assemble();

    expect(Object.keys(handle.platform).sort()).toEqual(
      [
        'clipboard',
        'config',
        'environment',
        'keyboardInteractive',
        'localization',
        'notifier',
        'prompter',
        'secrets',
        'state',
        'transfers',
        'uris'
      ].sort()
    );
    await handle.close();
  });

  it('opens the state domain during assembly, so a broken medium fails the plugin', async () => {
    const domain = new MemoryStorageDomain();
    await domain.open({
      name: 'someone_else',
      version: 1,
      tables: { kv: { valueSchema: { parse: (value) => value } } }
    });
    domain.failNextOpen = new FakeDomainError('backend-not-found', 'backend "json" is not registered');

    const error = await rejection(() => assemble({ domain }));
    expect(error).toBeInstanceOf(FakeDomainError);
    expect(error.code).toBe('backend-not-found');
  });

  it('closes twice without complaining', async () => {
    const { handle } = await assemble();

    await handle.close();
    await handle.close();
  });
});

describe('M2 assembly — asset persistence through the dsh platform', () => {
  it('saves, lists and deletes a server with no UI and no host object in sight', async () => {
    const { handle } = await assemble();
    // The shipped classes, unchanged: this is the assertion that the port layer really
    // did remove the host from the domain's dependencies.
    const manager = new ConfigManager(handle.platform.state, handle.platform.secrets);

    await manager.saveServer(server(), 'hunter2');
    expect(await manager.listServers()).toEqual([server()]);
    expect(await manager.getPassword('srv-1')).toBe('hunter2');

    await manager.deleteServer('srv-1');
    expect(await manager.listServers()).toEqual([]);
    expect(await manager.getPassword('srv-1')).toBeUndefined();

    await handle.close();
  });

  it('keeps the server list across a close and reopen of the domain', async () => {
    const domain = new MemoryStorageDomain();
    const first = await assemble({ domain });
    await new ConfigManager(first.handle.platform.state, first.handle.platform.secrets).saveServer(
      server({ id: 'srv-keep', label: 'keep' })
    );
    await first.handle.close();

    // A reopen is the closest thing to a restart that runs in-process: the domain is
    // loaded from the medium and every record is re-validated against the spec.
    const second = await assemble({ domain });
    const servers = await new ConfigManager(
      second.handle.platform.state,
      second.handle.platform.secrets
    ).listServers();

    expect(servers.map((entry) => entry.id)).toEqual(['srv-keep']);
    await second.handle.close();
  });

  it('keeps host-key trust across a reopen, so a known host is not re-asked', async () => {
    const domain = new MemoryStorageDomain();
    const first = await assemble({ domain });
    await new HostKeyStore(first.handle.platform.state).trust('10.0.0.1', 22, 'AAAAB3NzaC1yc2E');
    await first.handle.close();

    const second = await assemble({ domain });
    const store = new HostKeyStore(second.handle.platform.state);

    expect(await store.check('10.0.0.1', 22, 'AAAAB3NzaC1yc2E')).toBe('trusted');
    expect(await store.check('10.0.0.1', 22, 'A-rotated-fingerprint')).toBe('changed');
    expect(store.describe('10.0.0.1', 22)).toContain('10.0.0.1:22');
    await second.handle.close();
  });

  it('stores nothing in the medium under a key other than the memento keys', async () => {
    const { domain, handle } = await assemble();
    await new ConfigManager(handle.platform.state, handle.platform.secrets).saveServer(server());

    // The domain declares one flat `kv` table keyed by the original memento keys; there
    // is no parallel re-encoding a later change would have to keep in sync.
    expect([...(domain.dump(AT_TERMINAL_STATE_DOMAIN).get(AT_TERMINAL_STATE_TABLE)?.keys() ?? [])]).toEqual([
      'sshManager.servers'
    ]);
    await handle.close();
  });

  it('never writes a password into the state medium', async () => {
    const { domain, handle } = await assemble();
    await new ConfigManager(handle.platform.state, handle.platform.secrets).saveServer(
      server(),
      'sup3r-s3cret'
    );

    const dumped = JSON.stringify([...(domain.dump(AT_TERMINAL_STATE_DOMAIN).get(AT_TERMINAL_STATE_TABLE) ?? [])]);
    expect(dumped).not.toContain('sup3r-s3cret');
    expect(dumped).toContain('sshManager.servers');
    await handle.close();
  });
});

describe('M2 assembly — settings reach the terminal resolver', () => {
  it('resolves terminal settings from the dsh settings surface', async () => {
    const { handle } = await assemble();

    const settings = resolveTerminalSettings(handle.platform.config.getSection('sshManager'));

    expect(settings.fontSize).toBe(15);
    expect(settings.scrollback).toBe(20_000);
    // `false` and `0` are configured values, not "unset" — a reader that substituted the
    // default for a falsy value would make both of these unsettable.
    expect(settings.semanticHighlight).toBe(false);
    expect(settings.idleDisconnectMinutes).toBe(0);
    expect(settings.zebraStripes).toBe(true);
    await handle.close();
  });

  it('falls back to the resolver defaults for fields dsh has not resolved', async () => {
    const { handle } = await assemble();

    expect(handle.platform.config.getSection('sshManager').get('noSuchSetting', 42)).toBe(42);
    await handle.close();
  });

  it('refuses a section the dsh settings schema cannot serve', async () => {
    const { handle } = await assemble();

    expect(() => handle.platform.config.getSection('sftp')).toThrow(/"sftp"/);
    await handle.close();
  });
});

describe('M2 assembly — the seams the Client half still owns', () => {
  it('reports keyboard-interactive as cancelled instead of hanging on an invisible dialog', async () => {
    const { handle } = await assemble();

    await expect(
      handle.platform.keyboardInteractive({ name: 'x', instructions: '', prompts: [{ prompt: 'code', echo: false }] })
    ).resolves.toBeUndefined();
    await handle.close();
  });

  it('logs a headless notification rather than dropping it', async () => {
    const { handle, logger } = await assemble();

    await handle.platform.notifier.showErrorMessage('disk full', 'Retry');

    // `join()` renders format + arguments. Reading `.format` alone would only see the
    // template (`AT Terminal: %s [Retry]`) and the message would look missing.
    expect(logger.join()).toContain('disk full');
    expect(logger.entries.some((entry) => entry.level === 'error')).toBe(true);
    await handle.close();
  });

  it('leaves workspace folders undefined instead of inventing a project root', async () => {
    const { handle } = await assemble();

    expect(handle.platform.environment.workspaceFolders).toBeUndefined();
    expect(handle.platform.environment.storageDir).toBe('/home/user/.dsh/storages/at-terminal');
    await handle.close();
  });
});

describe('M2 assembly — the registry the domain layer reads through', () => {
  afterEach(() => {
    // `test/setup-platform.ts` installs the fake for the whole file. These tests
    // deliberately remove it, so hand it back for whatever runs next.
    setPlatform(createFakePlatform());
  });

  it('installs itself on assembly and clears itself on close', async () => {
    // The gap a real terminal connect found: `createDshPlatform` built the bundle but
    // never installed it, so every domain call that reads `platform()` — `t()` inside
    // `SshSession.connect` is one — threw "platform not installed" in the app, while
    // every unit test passed because this file's setup pre-installs a stand-in.
    clearPlatform();
    expect(() => platform()).toThrow(/platform not installed/);

    const { handle } = await assemble();
    expect(platform()).toBe(handle.platform);
    expect(platform().environment.storageDir).toBe('/home/user/.dsh/storages/at-terminal');

    await handle.close();
    expect(() => platform()).toThrow(/platform not installed/);
  });

  it('leaves a newer assembly installed when an older one is torn down', async () => {
    // Unload racing a reload: the replaced assembly's teardown must not clear the
    // platform a newer `apply()` already installed.
    const first = await assemble();
    const second = await assemble();
    expect(platform()).toBe(second.handle.platform);

    await first.handle.close();
    expect(platform()).toBe(second.handle.platform);

    await second.handle.close();
    expect(() => platform()).toThrow(/platform not installed/);
  });
});
