import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assetPrivateKeyDirectory,
  exportAssetsCommand,
  importAssetsCommand,
  localizeAssetImportError
} from '../../src/assets/AssetCommands';
import { encryptAssetPayload } from '../../src/assets/AssetCrypto';
import {
  ASSET_PACKAGE_FORMAT,
  ASSET_PACKAGE_UNREADABLE_MESSAGE,
  ASSET_PACKAGE_VERSION
} from '../../src/assets/AssetPackage';
import type { ConfigManager } from '../../src/config/ConfigManager';
import type { ServerConfig } from '../../src/config/schema';
import { setPlatform } from '../../src/platform/current';
import { createFakePlatform, FakeUri, type FakePlatform } from '../core/fakes';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Prod',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('AssetCommands', () => {
  let dir: string;
  let fake: FakePlatform;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'at-commands-'));
    fake = createFakePlatform();
    setPlatform(fake);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports encrypted assets to the selected file', async () => {
    const output = join(dir, 'assets.at-terminal-assets');
    fake.prompter.saveAnswers.push(new FakeUri('file', output));
    fake.prompter.quickPickAnswers.push(['Server configuration', 'Passwords']);
    fake.prompter.inputAnswers.push('package-pass', 'package-pass');
    const configManager = {
      listServers: async () => [server()],
      getPassword: async () => 'secret'
    } as Pick<ConfigManager, 'listServers' | 'getPassword'>;

    await exportAssetsCommand({ configManager, extensionName: 'at-terminal', extensionVersion: '2.10.2' });

    const raw = await readFile(output, 'utf8');
    expect(raw).toContain('"format"');
    expect(raw).not.toContain('secret');
  });

  it('imports assets and refreshes the server tree', async () => {
    const input = join(dir, 'assets.at-terminal-assets');
    const envelope = await encryptAssetPayload(
      {
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.2' },
        options: { includesPasswords: true, includesPrivateKeys: false, includesHostTrust: false },
        servers: [server()],
        passwords: { 'server-1': 'secret' },
        privateKeys: [],
        omissions: []
      },
      'package-pass'
    );
    await writeFile(input, JSON.stringify(envelope), 'utf8');
    fake.prompter.openAnswers.push([new FakeUri('file', input)]);
    fake.prompter.inputAnswers.push('package-pass');
    fake.prompter.quickPickAnswers.push('Skip existing servers');
    const saveServer = vi.fn();

    await importAssetsCommand({
      configManager: { listServers: async () => [], saveServer } as unknown as ConfigManager,
      privateKeyDirectory: join(dir, 'keys'),
      refreshServers: vi.fn()
    });

    expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }), 'secret');
  });

  it('reports a password mismatch during export and retries when the user asks to', async () => {
    const output = join(dir, 'assets.at-terminal-assets');
    fake.prompter.saveAnswers.push(new FakeUri('file', output));
    fake.prompter.quickPickAnswers.push(['Server configuration']);
    // First attempt mismatches, second attempt matches.
    fake.prompter.inputAnswers.push('first-pass', 'typo-pass', 'second-pass', 'second-pass');
    fake.notifier.queueAnswer('Try Again');
    const configManager = {
      listServers: async () => [server()],
      getPassword: async () => 'secret'
    } as Pick<ConfigManager, 'listServers' | 'getPassword'>;

    await exportAssetsCommand({ configManager, extensionName: 'at-terminal', extensionVersion: '0.3.4' });

    const mismatch = fake.notifier.messages.find((m) => m.message === 'The passwords do not match.');
    expect(mismatch).toMatchObject({ kind: 'error', actions: ['Try Again'] });
    const raw = await readFile(output, 'utf8');
    expect(raw).toContain('"format"');
  });

  it('aborts the export when the user declines to retry after a password mismatch', async () => {
    const output = join(dir, 'assets.at-terminal-assets');
    fake.prompter.saveAnswers.push(new FakeUri('file', output));
    fake.prompter.quickPickAnswers.push(['Server configuration']);
    fake.prompter.inputAnswers.push('first-pass', 'typo-pass');
    fake.notifier.queueAnswer(undefined);
    const listServers = vi.fn(async () => [server()]);

    await exportAssetsCommand({
      configManager: { listServers, getPassword: async () => 'secret' } as Pick<
        ConfigManager,
        'listServers' | 'getPassword'
      >,
      extensionName: 'at-terminal',
      extensionVersion: '0.3.4'
    });

    expect(listServers).not.toHaveBeenCalled();
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shows a localized error for a wrong import password and lets the user retry', async () => {
    const input = join(dir, 'assets.at-terminal-assets');
    const envelope = await encryptAssetPayload(
      {
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '0.3.4' },
        options: { includesPasswords: true, includesPrivateKeys: false, includesHostTrust: false },
        servers: [server()],
        passwords: { 'server-1': 'secret' },
        privateKeys: [],
        omissions: []
      },
      'package-pass'
    );
    await writeFile(input, JSON.stringify(envelope), 'utf8');
    fake.prompter.openAnswers.push([new FakeUri('file', input)]);
    fake.prompter.inputAnswers.push('wrong-pass', 'package-pass');
    fake.prompter.quickPickAnswers.push('Skip existing servers');
    fake.notifier.queueAnswer('Try Again');
    const saveServer = vi.fn();

    await importAssetsCommand({
      configManager: { listServers: async () => [], saveServer } as unknown as ConfigManager,
      privateKeyDirectory: join(dir, 'keys'),
      refreshServers: vi.fn()
    });

    const retryPrompt = fake.notifier.messages.find((m) =>
      m.message.startsWith('Import failed: the package password is wrong')
    );
    expect(retryPrompt).toMatchObject({ kind: 'error', actions: ['Try Again'] });
    expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }), 'secret');
  });

  it('localizes known and unknown import errors', () => {
    expect(localizeAssetImportError(new Error('Invalid package password or corrupted asset package.'))).toBe(
      'Import failed: the package password is wrong or the package file is corrupted.'
    );
    expect(localizeAssetImportError(new Error('boom'))).toBe('Import failed: boom');
  });

  it('distinguishes an unreadable old-format package from a wrong password', () => {
    const formatMessage = localizeAssetImportError(new Error(ASSET_PACKAGE_UNREADABLE_MESSAGE));

    expect(formatMessage).toBe('Import failed: the asset package is from an older format and could not be read.');
    expect(formatMessage).not.toContain('password');
    expect(localizeAssetImportError(new Error('Invalid package password or corrupted asset package.'))).not.toBe(
      formatMessage
    );
  });

  it('places imported private keys under the platform storage directory', () => {
    expect(assetPrivateKeyDirectory('/x/y')).toBe(join('/x/y', 'imported-private-keys'));
    expect(assetPrivateKeyDirectory(fake.environment.storageDir)).toBe(
      join(fake.environment.storageDir, 'imported-private-keys')
    );
  });
});