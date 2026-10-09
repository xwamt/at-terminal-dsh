import { describe, expect, it } from 'vitest';
import type {
  KeyboardInteractivePrompter,
  SecretStore,
  StateStore,
  TransferReporter
} from '../../src/core';
import type { ExtensionMemento, SecretStore as ConfigSecretStore } from '../../src/config/ConfigManager';
import type { HostKeyMemento } from '../../src/ssh/HostKeyStore';
import type { KeyboardInteractivePrompt } from '../../src/ssh/KeyboardInteractive';
import type { TransferReporter as SftpTransferReporter } from '../../src/sftp/TransferService';

/**
 * **Compile-time** two-way compatibility proof between the existing domain seams and the
 * core ports.
 *
 * Everything here uses `import type`, which is fully erased at runtime -- so this file
 * loads no domain module (`src/sftp`, `src/config`, `src/i18n`, ...) and therefore does
 * not depend on vitest's host alias stubs.
 *
 * Why it matters: during the W2 migration, existing signatures such as
 * `ConfigManager(globalState, secrets)`, `HostKeyStore(memento)`,
 * `SftpManager({ reporter })` and `attachKeyboardInteractive(client, prompt, ...)` can
 * accept port objects injected from a `Platform` **without any change**; conversely, the
 * core ports can also accept the existing test doubles (e.g. `MemoryMemento` in
 * `test/config/ConfigManager.test.ts`).
 */

function coreFromDomainTransfer(reporter: SftpTransferReporter): TransferReporter {
  return reporter;
}

function domainFromCoreTransfer(reporter: TransferReporter): SftpTransferReporter {
  return reporter;
}

function coreFromDomainKeyboard(prompt: KeyboardInteractivePrompt): KeyboardInteractivePrompter {
  return prompt;
}

function domainFromCoreKeyboard(prompt: KeyboardInteractivePrompter): KeyboardInteractivePrompt {
  return prompt;
}

function coreFromExtensionMemento(memento: ExtensionMemento): StateStore {
  return memento;
}

function coreFromHostKeyMemento(memento: HostKeyMemento): StateStore {
  return memento;
}

function domainFromStateStore(store: StateStore): ExtensionMemento {
  return store;
}

function coreFromConfigSecretStore(store: ConfigSecretStore): SecretStore {
  return store;
}

function domainFromSecretStore(store: SecretStore): ConfigSecretStore {
  return store;
}

describe('core ports <-> existing domain seams', () => {
  it('TransferReporter round-trips losslessly across the two namespaces (same object at type and runtime)', async () => {
    const calls: string[] = [];
    const domainReporter: SftpTransferReporter = {
      async withProgress(label, job) {
        calls.push(`progress:${label}`);
        return await job({ report: () => undefined });
      },
      async notifySuccess(message) {
        calls.push(`success:${message}`);
      },
      async notifyFailure(message) {
        calls.push(`failure:${message}`);
      }
    };

    const coreReporter = coreFromDomainTransfer(domainReporter);
    await coreReporter.withProgress('Upload file', async () => 'bytes');
    await coreReporter.notifySuccess('Upload file completed.');

    const roundTripped = domainFromCoreTransfer(coreReporter);
    expect(roundTripped).toBe(domainReporter);
    expect(calls).toEqual(['progress:Upload file', 'success:Upload file completed.']);
  });

  it('KeyboardInteractivePrompt matches the port function shape (cancellation semantics preserved)', async () => {
    const prompt: KeyboardInteractivePrompt = async (request) =>
      request.prompts.map((field) => (field.echo ? 'visible' : 'secret'));

    const prompter = coreFromDomainKeyboard(prompt);
    expect(await prompter({ name: '', instructions: '', prompts: [{ prompt: 'code', echo: false }] })).toEqual([
      'secret'
    ]);

    const cancelled: KeyboardInteractivePrompter = async () => undefined;
    expect(await domainFromCoreKeyboard(cancelled)({ name: '', instructions: '', prompts: [] })).toBeUndefined();
  });

  it('StateStore matches the memento contract of ConfigManager / HostKeyStore', async () => {
    const data = new Map<string, unknown>();
    const memento: ExtensionMemento = {
      get: <T>(key: string, defaultValue: T): T =>
        (data.has(key) ? data.get(key) : defaultValue) as T,
      update: async (key, value) => {
        data.set(key, value);
      }
    };

    const state = coreFromExtensionMemento(memento);
    await state.update('sshManager.servers', [{ id: 'a' }]);
    expect(state.get('sshManager.servers', [])).toEqual([{ id: 'a' }]);
    expect(domainFromStateStore(state)).toBe(memento);

    const hostKeyMemento: HostKeyMemento = memento;
    expect(coreFromHostKeyMemento(hostKeyMemento).get('sshManager.trustedHostKeys', {})).toEqual({});
  });

  it('SecretStore matches the ConfigManager credential contract (method named store, not set)', async () => {
    const data = new Map<string, string>();
    const configSecrets: ConfigSecretStore = {
      get: async (key) => data.get(key),
      store: async (key, value) => {
        data.set(key, value);
      },
      delete: async (key) => {
        data.delete(key);
      }
    };

    const secrets = coreFromConfigSecretStore(configSecrets);
    await secrets.store('sshManager.password.a', 'pw');
    expect(await secrets.get('sshManager.password.a')).toBe('pw');
    expect(domainFromSecretStore(secrets)).toBe(configSecrets);
  });
});
