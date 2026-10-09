import { describe, expect, it } from 'vitest';
import { ConfigManager } from '../../../src/config/ConfigManager';
import { createDshSecretStore, parseSecretKey } from '../../../src/platform/dsh/credentials';
import { serverSecretRefName } from '../../../src/platform/dsh/host';
import { MemoryCredentialProvider, RecordingDshLogger } from './host-fakes';

/**
 * DSH-13 — `context.secrets` → `ctx.credentials`.
 *
 * Two things are asserted that a "it round-trips" test would miss:
 *
 * 1. **the key grammar is real**, not assumed: `serverSecretRefName` feeds names to
 *    a seam that *throws* on a name outside `/^[A-Za-z_][A-Za-z0-9_]*$/`, so the
 *    tests walk server ids that the domain layer permits (`z.string().min(1)`, i.e.
 *    anything) through the mapping and check the result against the grammar;
 * 2. **the secret never reaches a log**, which is the plan's stated acceptance
 *    criterion for this node and cannot be checked by reading the adapter alone.
 */

function build() {
  const credentials = new MemoryCredentialProvider();
  const logger = new RecordingDshLogger();
  return { credentials, logger, store: createDshSecretStore({ credentials, logger }) };
}

describe('DSH-13 parseSecretKey', () => {
  it('splits the two prefixes ConfigManager owns', () => {
    expect(parseSecretKey('sshManager.password.srv-1')).toEqual({ kind: 'password', serverId: 'srv-1' });
    expect(parseSecretKey('sshManager.passphrase.srv-1')).toEqual({
      kind: 'passphrase',
      serverId: 'srv-1'
    });
  });

  it('keeps the server id intact, including dots inside it', () => {
    // The id is `z.string().min(1)` upstream, so it may contain the separator character.
    expect(parseSecretKey('sshManager.password.a.b.c')).toEqual({ kind: 'password', serverId: 'a.b.c' });
  });

  it('reports an unowned key instead of guessing', () => {
    expect(parseSecretKey('sshManager.servers')).toBeUndefined();
    expect(parseSecretKey('something.else')).toBeUndefined();
  });

  it('stays in sync with the prefix ConfigManager actually builds', () => {
    // The adapter hard-codes the prefixes; this is the assertion that keeps them honest.
    const manager = new ConfigManager(
      {
        get: <T>(_key: string, defaultValue: T): T => defaultValue,
        async update() {}
      },
      { get: async () => undefined, store: async () => {}, delete: async () => {} }
    );
    expect(parseSecretKey(manager.passwordKey('abc'))).toEqual({ kind: 'password', serverId: 'abc' });
    expect(parseSecretKey(manager.passphraseKey('abc'))).toEqual({ kind: 'passphrase', serverId: 'abc' });
  });
});

describe('DSH-13 serverSecretRefName', () => {
  it('produces a name the credential seam accepts for UUID-shaped ids', () => {
    const name = serverSecretRefName('password', '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071');
    expect(name).toBe('AT_TERMINAL_PASSWORD_S_3F2A1B4C_5D6E_7F80_9A1B_2C3D4E5F6071');
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('escapes every id the simple form cannot represent, losslessly', () => {
    // Each of these would break `credentialRef()`'s grammar or the injectivity of the
    // hyphen rewrite: uppercase, a dot, an underscore, a space, non-ASCII, and an id
    // that would collide with another id's rewritten form.
    const ids = [
      'Server-1',
      'srv.prod',
      'srv_prod',
      'srv prod',
      '服务器-1',
      'srv-prod'
    ];
    const names = ids.map((id) => serverSecretRefName('password', id));
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(new Set(names).size).toBe(ids.length);
  });

  it('separates the two kinds', () => {
    expect(serverSecretRefName('password', 'srv')).not.toBe(serverSecretRefName('passphrase', 'srv'));
  });
});

describe('DSH-13 createDshSecretStore', () => {
  it('round-trips a password through the credential document', async () => {
    const { credentials, store } = build();

    await store.store('sshManager.password.srv-1', 'hunter2');
    expect(await store.get('sshManager.password.srv-1')).toBe('hunter2');
    expect(credentials.document.get('AT_TERMINAL_PASSWORD_S_SRV_1')).toBe('hunter2');
  });

  it('keeps passwords and passphrases in separate records', async () => {
    const { store } = build();

    await store.store('sshManager.password.srv-1', 'pw');
    await store.store('sshManager.passphrase.srv-1', 'phrase');

    expect(await store.get('sshManager.password.srv-1')).toBe('pw');
    expect(await store.get('sshManager.passphrase.srv-1')).toBe('phrase');
  });

  it('reports an absent secret as undefined rather than as an empty string', async () => {
    const { store } = build();

    expect(await store.get('sshManager.password.never-stored')).toBeUndefined();
  });

  it('treats an empty stored value as absent, matching the seam-wide rule', async () => {
    const { credentials, store } = build();
    // Written directly to the medium: `set` refuses an empty value, but a hand-edited
    // `$DSH_HOME/.credentials.yaml` can still hold one.
    credentials.document.set('AT_TERMINAL_PASSWORD_S_SRV', '');

    expect(await store.get('sshManager.password.srv')).toBeUndefined();
  });

  it('deletes the stored secret', async () => {
    const { credentials, store } = build();

    await store.store('sshManager.password.srv-1', 'pw');
    await store.delete('sshManager.password.srv-1');

    expect(await store.get('sshManager.password.srv-1')).toBeUndefined();
    expect(credentials.document.size).toBe(0);
  });

  it('refuses a key it does not own, on every operation', async () => {
    const { store } = build();

    await expect(store.get('sshManager.servers')).rejects.toThrow(/sshManager\.servers/);
    await expect(store.store('sshManager.servers', 'x')).rejects.toThrow(/sshManager\.servers/);
    await expect(store.delete('sshManager.servers')).rejects.toThrow(/sshManager\.servers/);
  });

  it('propagates the read-only-environment conflict instead of pretending the write applied', async () => {
    const { credentials, store } = build();
    credentials.inherited.set('AT_TERMINAL_PASSWORD_S_SRV', 'from-shell');

    await expect(store.store('sshManager.password.srv', 'from-dialog')).rejects.toThrow(/read-only/);
    // The inherited value still wins on read, which is what the user sees in the shell.
    expect(await store.get('sshManager.password.srv')).toBe('from-shell');
  });

  it('propagates a host failure instead of reporting "no secret stored"', async () => {
    const { credentials, store } = build();
    credentials.failResolve = new Error('credentials-local is disposed');

    await expect(store.get('sshManager.password.srv')).rejects.toThrow(/disposed/);
  });

  it('never writes the secret to the log', async () => {
    const { logger, store } = build();

    await store.store('sshManager.password.srv-1', 'sup3r-s3cret');
    expect(await store.get('sshManager.password.srv-1')).toBe('sup3r-s3cret');

    expect(logger.join()).not.toContain('sup3r-s3cret');
    expect(logger.entries.some((entry) => entry.format.includes('resolved SSH secret'))).toBe(true);
  });
});
