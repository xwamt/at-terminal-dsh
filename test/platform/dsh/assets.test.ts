import { createCipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetPrivateKeyDirectory } from '../../../src/assets/AssetCommands';
import { decryptAssetPayload } from '../../../src/assets/AssetCrypto';
import type { AssetConflictStrategy } from '../../../src/assets/AssetImportService';
import {
  ASSET_PACKAGE_FORMAT,
  ASSET_PACKAGE_VERSION,
  parseAssetPackageEnvelope,
  type AssetPackageEnvelope
} from '../../../src/assets/AssetPackage';
import { ConfigManager } from '../../../src/config/ConfigManager';
import type { ServerConfig } from '../../../src/config/schema';
import { createDshAssetApi, createDshPlatform } from '../../../src/platform/dsh/entry';
import {
  createDshHostFacts,
  createResolvedSettings,
  MemoryCredentialProvider,
  MemoryStorageDomain,
  RecordingDshLogger
} from './host-fakes';

/**
 * The dsh asset face against the VS Code one — the M3 gate.
 *
 * The whole reason `src/platform/dsh/entry.ts` exists is that a package exported on
 * one platform must import on the other. So nothing here is mocked: the platform is
 * **assembled** by `createDshPlatform()` (state domain → `ConfigManager`, credentials
 * → `SecretStore`), and every byte-level decision (envelope schema, scrypt +
 * AES-256-GCM, payload shape, conflict strategies, private-key directory) comes from
 * the real `src/assets/**`. A divergence between the two variants has to fail here,
 * because a test that stubbed the crypto or the payload schema would only prove the
 * stub agrees with itself.
 */

const scrypt = promisify(scryptCallback);

const HOST_NAME = 'at-terminal-dsh-test';
const HOST_VERSION = '3.1.4';
const PACKAGE_PASSWORD = 'package-pass';
/** Deliberately unmistakable, so "the secret is absent from the log" cannot pass by luck. */
const SSH_PASSWORD = 'ssh-pass-DO-NOT-LOG-9f3a4c';

function passwordServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-pass',
    label: 'alpha',
    host: 'alpha.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function agentServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-agent',
    label: 'beta',
    host: 'beta.example.com',
    port: 2222,
    username: 'ops',
    authType: 'agent',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 2,
    updatedAt: 2,
    ...overrides
  };
}

function privateKeyServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-key',
    label: 'gamma',
    host: 'gamma.example.com',
    port: 22,
    username: 'root',
    authType: 'privateKey',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 3,
    updatedAt: 3,
    ...overrides
  };
}

/**
 * Encrypts arbitrary JSON with the same scrypt/AES-256-GCM parameters the extension
 * uses, bypassing the payload schema. The only way to build a package whose password
 * is right but whose payload no version can read.
 */
async function encryptRawJson(value: unknown, packagePassword: string): Promise<AssetPackageEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = (await scrypt(packagePassword, salt, 32)) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
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

async function assemble(storageDir: string) {
  const logger = new RecordingDshLogger();
  const facts = createDshHostFacts({ storageDir });
  // Assembled for real: the state domain and the credential provider are the ones the
  // shipping plugin gets, which is the only way the ConfigManager ↔ port seam is exercised.
  const handle = await createDshPlatform({
    logger,
    credentials: new MemoryCredentialProvider(),
    storageDomain: new MemoryStorageDomain(),
    settings: createResolvedSettings({}),
    facts
  });
  const configManager = new ConfigManager(handle.platform.state, handle.platform.secrets);
  let generated = 0;
  const api = createDshAssetApi({
    platform: handle.platform,
    hostName: HOST_NAME,
    hostVersion: HOST_VERSION,
    // Deterministic, only so the rename test can name the id it expects.
    generateId: () => `generated-${++generated}`
  });
  return { handle, logger, facts, configManager, api };
}

/**
 * Temporary storage roots. Every assembled platform gets its own, because
 * `environment.storageDir` is what decides where imported keys land — sharing one
 * directory would let the private-key test see another test's files.
 */
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

describe('dsh asset api — summary', () => {
  it('reports an empty instance with the real imported-private-keys path', async () => {
    const dir = await makeDir('at-dsh-empty-');
    const { api, handle, facts } = await assemble(dir);

    const summary = await api.summary();

    expect(summary).toEqual({
      servers: 0,
      passwords: 0,
      privateKeyFiles: 0,
      // Not a hard-coded string: the panel must show the same directory the importer writes.
      privateKeyDirectory: assetPrivateKeyDirectory(facts.storageDir)
    });
    expect(summary.privateKeyDirectory).toBe(join(dir, 'imported-private-keys'));
    await handle.close();
  });

  it('counts only password-auth servers that actually have a password stored', async () => {
    const dir = await makeDir('at-dsh-count-');
    const { api, configManager, handle } = await assemble(dir);
    await configManager.saveServer(passwordServer(), SSH_PASSWORD);
    await configManager.saveServer(passwordServer({ id: 'srv-nopass', label: 'alpha-two', host: 'two.example.com' }));
    await configManager.saveServer(agentServer());

    expect(await api.summary()).toEqual(
      expect.objectContaining({ servers: 3, passwords: 1, privateKeyFiles: 0 })
    );
    await handle.close();
  });
});

describe('dsh asset api — export', () => {
  it('produces the VS Code filename and a readable envelope carrying both servers', async () => {
    const dir = await makeDir('at-dsh-export-');
    const { api, configManager, handle } = await assemble(dir);
    await configManager.saveServer(passwordServer(), SSH_PASSWORD);
    await configManager.saveServer(agentServer());

    const result = await api.export({
      includePasswords: true,
      includePrivateKeys: false,
      packagePassword: PACKAGE_PASSWORD
    });

    expect(result.filename).toBe('at-terminal-assets.at-terminal-assets');
    expect(result.omissions).toBe(0);

    const envelope = parseAssetPackageEnvelope(result.envelope);
    expect(envelope.format).toBe('at-terminal-assets');
    expect(envelope.version).toBe(1);
    expect(envelope.kdf).toBe('scrypt');
    expect(envelope.cipher).toBe('aes-256-gcm');
    for (const field of ['salt', 'iv', 'authTag', 'ciphertext'] as const) {
      expect(envelope[field].length).toBeGreaterThan(0);
    }
    // The ciphertext is the only thing on disk; the SSH password must not be legible in it.
    expect(Buffer.from(envelope.ciphertext, 'base64').toString('utf8')).not.toContain(SSH_PASSWORD);

    const payload = await decryptAssetPayload(envelope, PACKAGE_PASSWORD);
    expect(payload.source).toEqual({ extensionName: HOST_NAME, extensionVersion: HOST_VERSION });
    expect(payload.options).toEqual({
      includesPasswords: true,
      includesPrivateKeys: false,
      // Trust is machine-local by design and never travels in a package.
      includesHostTrust: false
    });
    expect(payload.servers.map((server) => server.id)).toEqual(['srv-pass', 'srv-agent']);
    expect(payload.servers).toEqual([passwordServer(), agentServer()]);
    expect(payload.passwords).toEqual({ 'srv-pass': SSH_PASSWORD });
    await handle.close();
  });

  it('leaves passwords out of the package and records no omission when not asked for them', async () => {
    const dir = await makeDir('at-dsh-nopw-');
    const { api, configManager, handle } = await assemble(dir);
    await configManager.saveServer(passwordServer(), SSH_PASSWORD);

    const result = await api.export({
      includePasswords: false,
      includePrivateKeys: false,
      packagePassword: PACKAGE_PASSWORD
    });
    const payload = await decryptAssetPayload(result.envelope, PACKAGE_PASSWORD);

    expect(payload.passwords).toEqual({});
    // "Not requested" is not "requested but missing": nothing was attempted, so nothing failed.
    expect(payload.omissions).toEqual([]);
    expect(result.omissions).toBe(0);
    await handle.close();
  });

  it('records one privateKey omission, without throwing, when the key file is gone', async () => {
    const dir = await makeDir('at-dsh-missingkey-');
    const { api, configManager, handle } = await assemble(dir);
    await configManager.saveServer(
      privateKeyServer({ privateKeyPath: join(dir, 'no-such-dir', 'id_ed25519') })
    );

    const result = await api.export({
      includePasswords: false,
      includePrivateKeys: true,
      packagePassword: PACKAGE_PASSWORD
    });

    expect(result.omissions).toBe(1);
    const payload = await decryptAssetPayload(result.envelope, PACKAGE_PASSWORD);
    expect(payload.privateKeys).toEqual([]);
    expect(payload.omissions).toEqual([
      { serverId: 'srv-key', kind: 'privateKey', reason: expect.any(String) }
    ]);
    await handle.close();
  });
});

describe('dsh asset api — import', () => {
  /** A real export of one password-auth server, for the import-path cases. */
  async function singleServerPackage(): Promise<AssetPackageEnvelope> {
    const from = await assemble(await makeDir('at-dsh-one-src-'));
    await from.configManager.saveServer(passwordServer(), SSH_PASSWORD);
    const { envelope } = await from.api.export({
      includePasswords: true,
      includePrivateKeys: false,
      packagePassword: PACKAGE_PASSWORD
    });
    await from.handle.close();
    return envelope;
  }

  /** A package holding the alpha/beta pair, produced by a real export. */
  async function twoServerPackage(): Promise<AssetPackageEnvelope> {
    const from = await assemble(await makeDir('at-dsh-src-'));
    await from.configManager.saveServer(passwordServer(), SSH_PASSWORD);
    await from.configManager.saveServer(agentServer());
    const { envelope } = await from.api.export({
      includePasswords: true,
      includePrivateKeys: false,
      packagePassword: PACKAGE_PASSWORD
    });
    await from.handle.close();
    return envelope;
  }

  it('round-trips records and passwords into an empty instance, from an object and from raw text', async () => {
    const envelope = await twoServerPackage();

    const objectTarget = await assemble(await makeDir('at-dsh-dst-'));
    const objectResult = await objectTarget.api.importPackage({
      envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'rename'
    });

    expect(objectResult.summary).toEqual({
      imported: 2,
      skipped: 0,
      overwritten: 0,
      renamed: 0,
      privateKeysWritten: 0
    });
    // Same ids, same fields: the round trip is not a re-interpretation.
    expect(await objectTarget.configManager.listServers()).toEqual([passwordServer(), agentServer()]);
    expect(await objectTarget.configManager.getPassword('srv-pass')).toBe(SSH_PASSWORD);
    expect(await objectTarget.configManager.getPassword('srv-agent')).toBeUndefined();
    await objectTarget.handle.close();

    // The browser file picker hands over either shape; a raw string must work too.
    const textTarget = await assemble(await makeDir('at-dsh-dst-'));
    const textResult = await textTarget.api.importPackage({
      envelope: JSON.stringify(envelope),
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'skip'
    });

    expect(textResult.summary.imported).toBe(2);
    expect(await textTarget.configManager.getPassword('srv-pass')).toBe(SSH_PASSWORD);
    await textTarget.handle.close();
  });

  it('maps a wrong package password to wrong-password', async () => {
    const envelope = await twoServerPackage();
    const target = await assemble(await makeDir('at-dsh-badpw-'));

    const code = await rejectionCode(() =>
      target.api.importPackage({ envelope, packagePassword: 'not-the-password', strategy: 'skip' })
    );

    expect(code).toBe('wrong-password');
    // Nothing was written on the failure path.
    expect(await target.configManager.listServers()).toEqual([]);
    await target.handle.close();
  });

  it('maps a right-password but unreadable payload to unreadable-package, not wrong-password', async () => {
    const target = await assemble(await makeDir('at-dsh-unreadable-'));
    const envelope = await encryptRawJson(
      { format: ASSET_PACKAGE_FORMAT, version: ASSET_PACKAGE_VERSION },
      PACKAGE_PASSWORD
    );
    // Sanity: the envelope itself is well formed; only the decrypted payload is not.
    expect(() => parseAssetPackageEnvelope(envelope)).not.toThrow();

    const code = await rejectionCode(() =>
      target.api.importPackage({ envelope, packagePassword: PACKAGE_PASSWORD, strategy: 'skip' })
    );

    expect(code).toBe('unreadable-package');
    expect(code).not.toBe('wrong-password');
    await target.handle.close();
  });

  it('rejects missing parameters with bad-params and a non-object envelope with unreadable-package', async () => {
    const target = await assemble(await makeDir('at-dsh-params-'));
    const envelope = await twoServerPackage();

    expect(
      await rejectionCode(() =>
        target.api.export({ includePasswords: true, includePrivateKeys: false, packagePassword: '' })
      )
    ).toBe('bad-params');

    expect(
      await rejectionCode(() =>
        target.api.importPackage({ envelope, packagePassword: '', strategy: 'skip' })
      )
    ).toBe('bad-params');

    expect(
      await rejectionCode(() =>
        target.api.importPackage({
          envelope,
          packagePassword: PACKAGE_PASSWORD,
          strategy: 'merge' as AssetConflictStrategy
        })
      )
    ).toBe('bad-params');

    expect(
      await rejectionCode(() =>
        target.api.importPackage({ envelope: null, packagePassword: PACKAGE_PASSWORD, strategy: 'skip' })
      )
    ).toBe('unreadable-package');

    await target.handle.close();
  });

  it('applies skip, overwrite and rename to a second import of the same server', async () => {
    const envelope = await singleServerPackage();

    // skip: the first import lands, the second is refused and nothing is written.
    const skipTarget = await assemble(await makeDir('at-dsh-skip-'));
    const firstSkip = await skipTarget.api.importPackage({
      envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'skip'
    });
    expect(firstSkip.summary.imported).toBe(1);
    const skip = await skipTarget.api.importPackage({
      envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'skip'
    });
    expect(skip.summary).toEqual({
      imported: 0,
      skipped: 1,
      overwritten: 0,
      renamed: 0,
      privateKeysWritten: 0
    });
    expect(await skipTarget.configManager.listServers()).toEqual([passwordServer()]);
    expect(await skipTarget.configManager.getPassword('srv-pass')).toBe(SSH_PASSWORD);
    await skipTarget.handle.close();

    // overwrite: the record is replaced in place, so the entry count stays put.
    const overwriteTarget = await assemble(await makeDir('at-dsh-overwrite-'));
    await overwriteTarget.api.importPackage({
      envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'overwrite'
    });
    const overwrite = await overwriteTarget.api.importPackage({
      envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'overwrite'
    });
    expect(overwrite.summary).toEqual({
      imported: 0,
      skipped: 0,
      overwritten: 1,
      renamed: 0,
      privateKeysWritten: 0
    });
    const overwritten = await overwriteTarget.configManager.listServers();
    expect(overwritten).toHaveLength(1);
    expect(overwritten[0]).toEqual(passwordServer());
    expect(await overwriteTarget.configManager.getPassword('srv-pass')).toBe(SSH_PASSWORD);
    await overwriteTarget.handle.close();

    // rename: keep both, with the label suffix the VS Code command also produces.
    const renameTarget = await assemble(await makeDir('at-dsh-rename-'));
    await renameTarget.api.importPackage({
      envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'rename'
    });
    const rename = await renameTarget.api.importPackage({
      envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'rename'
    });
    expect(rename.summary).toEqual({
      imported: 0,
      skipped: 0,
      overwritten: 0,
      renamed: 1,
      privateKeysWritten: 0
    });
    const renamed = await renameTarget.configManager.listServers();
    expect(renamed).toHaveLength(2);
    expect(renamed.find((server) => server.id === 'srv-pass')).toEqual(passwordServer());
    expect(renamed.find((server) => server.id === 'generated-1')).toEqual(
      passwordServer({ id: 'generated-1', label: 'alpha (imported)' })
    );
    expect(await renameTarget.configManager.getPassword('generated-1')).toBe(SSH_PASSWORD);
    await renameTarget.handle.close();
  });

  it('writes an imported private key under the storage directory with mode 0600', async () => {
    const sourceDir = await makeDir('at-dsh-pk-src-');
    const targetDir = await makeDir('at-dsh-pk-dst-');
    const keyDir = await makeDir('at-dsh-pk-file-');
    const keyPath = join(keyDir, 'id_ed25519');
    const keyContent = '-----BEGIN OPENSSH PRIVATE KEY-----\nkey-material\n-----END OPENSSH PRIVATE KEY-----\n';
    await writeFile(keyPath, keyContent, { mode: 0o600 });

    const from = await assemble(sourceDir);
    await from.configManager.saveServer(privateKeyServer({ privateKeyPath: keyPath }));
    const exported = await from.api.export({
      includePasswords: false,
      includePrivateKeys: true,
      packagePassword: PACKAGE_PASSWORD
    });
    expect(exported.omissions).toBe(0);
    await from.handle.close();

    const target = await assemble(targetDir);
    const { summary } = await target.api.importPackage({
      envelope: exported.envelope,
      packagePassword: PACKAGE_PASSWORD,
      strategy: 'skip'
    });

    expect(summary).toEqual({
      imported: 1,
      skipped: 0,
      overwritten: 0,
      renamed: 0,
      privateKeysWritten: 1
    });
    const privateKeyDirectory = assetPrivateKeyDirectory(targetDir);
    const landingPath = join(privateKeyDirectory, `srv-key-${basename(keyPath)}`);
    await expect(readFile(landingPath, 'utf8')).resolves.toBe(keyContent);
    // The key is a secret: the VS Code variant writes 0600 and this must match.
    expect((await stat(landingPath)).mode & 0o777).toBe(0o600);
    const [server] = await target.configManager.listServers();
    expect(server.privateKeyPath).toBe(landingPath);
    await target.handle.close();
  });
});

describe('dsh asset api — secrets stay out of the log', () => {
  it('never logs the SSH password while exporting and importing it', async () => {
    const from = await assemble(await makeDir('at-dsh-log-src-'));
    await from.configManager.saveServer(passwordServer(), SSH_PASSWORD);
    const { envelope } = await from.api.export({
      includePasswords: true,
      includePrivateKeys: false,
      packagePassword: PACKAGE_PASSWORD
    });

    const target = await assemble(await makeDir('at-dsh-log-dst-'));
    await target.api.importPackage({ envelope, packagePassword: PACKAGE_PASSWORD, strategy: 'rename' });

    // The credential adapter logs which layer answered, never the value.
    expect(target.logger.join()).not.toContain(SSH_PASSWORD);
    expect(from.logger.join()).not.toContain(SSH_PASSWORD);
    // And the password really did travel, so the assertion above is not vacuous.
    expect(await target.configManager.getPassword('srv-pass')).toBe(SSH_PASSWORD);
    await from.handle.close();
    await target.handle.close();
  });
});

describe('dsh asset import — files that are not packages', () => {
  /**
   * These paths must all report `unreadable-package`, the same remedy: choose a different
   * file. Keeping them out of `wrong-password` is the point — a header that is not a
   * package cannot be fixed by retyping a password, and saying otherwise sends the user
   * round a loop they cannot exit.
   *
   * The first two are regression guards. An unguarded `JSON.parse` threw a bare
   * `SyntaxError` (no `code`, surfaced as `method-error`), and a structurally invalid
   * header escaped `decryptAssetPayload` as a schema error which the mapping then
   * classified as a wrong password.
   */
  async function importFailure(envelope: unknown) {
    const { handle, api } = await assemble(await makeDir('at-dsh-notapackage-'));
    try {
      const code = await rejectionCode(() =>
        api.importPackage({ envelope, packagePassword: PACKAGE_PASSWORD, strategy: 'skip' })
      );
      let message = '';
      await api
        .importPackage({ envelope, packagePassword: PACKAGE_PASSWORD, strategy: 'skip' })
        .catch((error: { message?: string }) => {
          message = error.message ?? '';
        });
      return { code, message };
    } finally {
      await handle.close();
    }
  }

  it('reports truncated file text as unreadable rather than as a method error', async () => {
    const { code, message } = await importFailure(`{"format":"${ASSET_PACKAGE_FORMAT}","version":1,"kdf":"scr`);
    expect(code).toBe('unreadable-package');
    expect(message).toMatch(/not JSON/);
  });

  it('reports JSON that is not a package object as unreadable', async () => {
    expect((await importFailure('42')).code).toBe('unreadable-package');
    expect((await importFailure(null)).code).toBe('unreadable-package');
  });

  it('reports a header from another format as unreadable, never as a password problem', async () => {
    const { code, message } = await importFailure({ format: 'some-other-tool', version: 1 });
    expect(code).toBe('unreadable-package');
    // The message must not mention the password, or a correct one gets retyped.
    expect(message).not.toMatch(/password/i);
  });

  it('still reports a genuine password failure as wrong-password', async () => {
    const { handle, api, configManager } = await assemble(await makeDir('at-dsh-wrongpw-'));
    try {
      await configManager.saveServer(agentServer());
      const exported = await api.export({
        includePasswords: false,
        includePrivateKeys: false,
        packagePassword: PACKAGE_PASSWORD
      });
      const code = await rejectionCode(() =>
        api.importPackage({ envelope: exported.envelope, packagePassword: 'not-the-password', strategy: 'skip' })
      );
      expect(code).toBe('wrong-password');
    } finally {
      await handle.close();
    }
  });
});
