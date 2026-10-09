import { describe, expect, it, vi } from 'vitest';
import { Emitter, type Platform } from '../../src/core';
import {
  createFakePlatform,
  FakeUri,
  type FakePlatform,
  type FakePlatformOptions
} from './fakes';

/**
 * Port contract tests: every assertion runs against the **in-memory implementations**.
 *
 * This file imports no host module and relies on no vitest host stub -- the fact that it
 * passes means the domain capabilities can be fully assembled and used in a process with
 * no host.
 */

function fake(options: FakePlatformOptions = {}): FakePlatform {
  return createFakePlatform(options);
}

/**
 * Compile-time anchor: the fakes must satisfy Platform as a whole; missing any single port
 * fails compilation here.
 */
const platformShape: Platform = createFakePlatform();

describe('Notifier', () => {
  it('keeps the dual overload semantics of the host show*Message (no options / with options)', async () => {
    const p = fake();
    // Only calls with options show a dialog, so answers are queued for just these two.
    p.notifier.queueAnswer('Copy Fingerprint', 'Delete');

    const plain = await p.notifier.showInformationMessage('No trusted host key is stored.');
    const withAction = await p.notifier.showInformationMessage('Stored fingerprint: ab', 'Copy Fingerprint');
    const modal = await p.notifier.showWarningMessage('Delete SSH server "prod"?', { modal: true }, 'Delete');

    expect(plain).toBeUndefined();
    expect(withAction).toBe('Copy Fingerprint');
    expect(modal).toBe('Delete');
    expect(p.notifier.messages).toEqual([
      { kind: 'info', message: 'No trusted host key is stored.', options: undefined, actions: [] },
      { kind: 'info', message: 'Stored fingerprint: ab', options: undefined, actions: ['Copy Fingerprint'] },
      {
        kind: 'warning',
        message: 'Delete SSH server "prod"?',
        options: { modal: true },
        actions: ['Delete']
      }
    ]);
  });

  it('withProgress wraps the task in a progress bar; each report increment and text is recorded', async () => {
    const p = fake();

    const result = await p.notifier.withProgress(
      { location: 'notification', title: 'Uploading file', cancellable: false },
      async (progress) => {
        progress.report({ increment: 30, message: '1 KiB / 4 KiB' });
        progress.report({ increment: 70, message: '4 KiB / 4 KiB' });
        return 'done';
      }
    );

    expect(result).toBe('done');
    expect(p.notifier.progressCalls).toHaveLength(1);
    expect(p.notifier.progressCalls[0].options).toEqual({
      location: 'notification',
      title: 'Uploading file',
      cancellable: false
    });
    expect(p.notifier.progressCalls[0].reports).toEqual([
      { increment: 30, message: '1 KiB / 4 KiB' },
      { increment: 70, message: '4 KiB / 4 KiB' }
    ]);
  });

  it('withProgress hands the task a usable cancellation token (not cancelled currently)', async () => {
    const p = fake();
    let seen: boolean | undefined;

    await p.notifier.withProgress({ title: 'Sync' }, async (_progress, token) => {
      seen = token.isCancellationRequested;
      return undefined;
    });

    expect(seen).toBe(false);
  });
});

describe('Prompter', () => {
  it('multi-select returns an array and single-select a scalar; password input yields a value', async () => {
    const p = fake();
    p.prompter.quickPickAnswers.push(['Passwords', 'Private key files'], 'Overwrite existing servers');
    p.prompter.inputAnswers.push('s3cret');

    const picked = await p.prompter.showQuickPick(['Server configuration', 'Passwords', 'Private key files'], {
      canPickMany: true,
      title: 'Choose assets to export'
    });
    const strategy = await p.prompter.showQuickPick(['Skip', 'Overwrite', 'Keep both'], {
      title: 'Choose import conflict handling'
    });
    const password = await p.prompter.showInputBox({ prompt: 'Asset package password', password: true });

    expect(picked).toEqual(['Passwords', 'Private key files']);
    expect(strategy).toBe('Overwrite existing servers');
    expect(password).toBe('s3cret');
    expect(p.prompter.calls).toEqual([
      'quickPick:Server configuration|Passwords|Private key files',
      'quickPick:Skip|Overwrite|Keep both',
      'inputBox:Asset package password'
    ]);
  });

  it('file dialogs use the same UriService abstraction for default URI and return values', async () => {
    const p = fake();
    const exported = p.uris.file('/home/user/at-terminal-assets.atpkg');
    p.prompter.saveAnswers.push(exported);
    p.prompter.openAnswers.push([p.uris.file('/tmp/imported.atpkg')]);

    const saved = await p.prompter.showSaveDialog({
      defaultUri: p.uris.file('at-terminal-assets.atpkg'),
      filters: { 'AT Terminal Assets': ['atpkg'] }
    });
    const opened = await p.prompter.showOpenDialog({ canSelectFiles: true, canSelectMany: false });

    expect(saved?.fsPath).toBe('/home/user/at-terminal-assets.atpkg');
    expect(opened?.[0].fsPath).toBe('/tmp/imported.atpkg');
  });
});

describe('StateStore / SecretStore', () => {
  it('state can be overwritten and read back; undefined means delete', async () => {
    const p = fake();
    const servers = [{ id: 'a', label: 'prod' }];

    await p.state.update('sshManager.servers', servers);
    expect(p.state.get('sshManager.trustedHostKeys', {})).toEqual({});
    expect(p.state.get('sshManager.servers', [])).toEqual(servers);
    expect(p.state.updateCalls).toBe(1);

    await p.state.update('sshManager.servers', undefined);
    expect(p.state.get('sshManager.servers', [])).toEqual([]);
  });

  it('credentials round-trip to the stored value and read back undefined after deletion', async () => {
    const p = fake();
    const passwordKey = 'sshManager.password.a1';

    await p.secrets.store(passwordKey, 'hunter2');
    expect(await p.secrets.get(passwordKey)).toBe('hunter2');

    await p.secrets.delete(passwordKey);
    expect(await p.secrets.get(passwordKey)).toBeUndefined();
  });
});

describe('ConfigReader', () => {
  it('reads sshManager settings and falls back to defaults when a key is missing', () => {
    const p = fake({
      config: {
        sshManager: {
          scrollback: 25000,
          terminalFontSize: 18,
          semanticHighlight: false
        }
      }
    });
    const section = p.config.getSection('sshManager');

    // Reads in the same shape as resolveTerminalSettings in src/webview/TerminalPanel.ts:605.
    expect(section.get('scrollback', 10000)).toBe(25000);
    expect(section.get('terminalFontSize', 14)).toBe(18);
    expect(section.get('semanticHighlight', true)).toBe(false);
    expect(section.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace')).toBe(
      'Cascadia Code, Menlo, monospace'
    );
    expect(section.get('sessionLogDirectory', '')).toBe('');
  });

  it('an unknown configuration section returns all defaults without throwing', () => {
    const p = fake();
    expect(p.config.getSection('nothing.here').get('anything', 'fallback')).toBe('fallback');
  });
});

describe('UriService', () => {
  it('file / joinPath / parse / from / isUri cover the existing consumption sites', () => {
    const uris = fake().uris;

    const base = uris.file('/home/user/.fake/storage');
    expect(uris.joinPath(base, 'sftp-edit', 'server-1', 'hash', 'file.txt').fsPath).toBe(
      '/home/user/.fake/storage/sftp-edit/server-1/hash/file.txt'
    );
    expect(uris.joinPath(uris.file('/opt/ext'), 'dist', 'webview', 'terminal.js').fsPath).toBe(
      '/opt/ext/dist/webview/terminal.js'
    );

    const preview = uris.from({ scheme: 'ssh-manager-sftp-preview', path: '/notes.txt', query: 'local' });
    expect(preview.scheme).toBe('ssh-manager-sftp-preview');

    const parsed = uris.parse('file:///tmp/dropped.txt');
    expect(parsed.scheme).toBe('file');
    expect(parsed.fsPath).toBe('/tmp/dropped.txt');
    expect(parsed.toString()).toBe('file:///tmp/dropped.txt');

    expect(uris.isUri(parsed)).toBe(true);
    expect(uris.isUri({ scheme: 'file', fsPath: '/tmp/x', toString: () => 'file:///tmp/x' })).toBe(false);
    expect(uris.isUri(undefined)).toBe(false);
  });

  it('the scheme check distinguishes a preview URI from a plain file', () => {
    const uris = fake().uris;
    const preview = uris.from({ scheme: 'ssh-manager-sftp-preview', path: '/a.txt' });

    expect(preview.scheme === 'ssh-manager-sftp-preview').toBe(true);
    expect(uris.file('/a.txt').scheme === 'ssh-manager-sftp-preview').toBe(false);
  });
});

describe('HostEnvironment', () => {
  it('exposes the storage dir, extension dir, host identity, and workspace', () => {
    const p = fake();
    const env = p.environment;

    expect(env.storageDir).toBe('/home/user/.fake/storage/at-terminal');
    expect(env.extensionPath).toBe('/home/user/.fake/extensions/at-terminal');
    expect(env.appName).toBe('Fake IDE');
    expect(env.workspaceFolders?.[0].uri.fsPath).toBe('/work/project');
  });

  it('stays undefined with no workspace (original semantics), letting the caller fall back', () => {
    const p = fake({ environment: { workspaceFolders: undefined } });
    const editStorage = p.environment.workspaceFolders ?? [];
    expect(editStorage).toHaveLength(0);
  });
});

describe('KeyboardInteractivePrompter', () => {
  it('returns the answers in prompt order', async () => {
    const p = fake();
    p.keyboardInteractiveRecorder.nextResponses = ['123456'];

    const responses = await p.keyboardInteractive({
      name: 'Two-factor',
      instructions: 'Enter the code',
      prompts: [{ prompt: 'Verification code', echo: false }]
    });

    expect(responses).toEqual(['123456']);
    expect(p.keyboardInteractiveRecorder.requests[0].prompts[0].echo).toBe(false);
  });

  it('a user cancel returns undefined (the caller aborts the handshake on it)', async () => {
    const p = fake();
    p.keyboardInteractiveRecorder.nextResponses = undefined;

    expect(
      await p.keyboardInteractive({ name: '', instructions: '', prompts: [{ prompt: 'x', echo: true }] })
    ).toBeUndefined();
  });
});

describe('TransferReporter', () => {
  it('success and failure each go through their own notification channel', async () => {
    const p = fake();

    await p.transfers.withProgress('Upload file', async () => 'ok');
    await p.transfers.notifySuccess('Upload file completed.');
    await p.transfers.notifyFailure('Download file failed.');

    expect(p.transfers.progressLabels).toEqual(['Upload file']);
    expect(p.transfers.successMessages).toEqual(['Upload file completed.']);
    expect(p.transfers.failureMessages).toEqual(['Download file failed.']);
  });
});

describe('Localization / Clipboard', () => {
  it('both the args and no-args text forms render', () => {
    const p = fake({ dictionary: { 'Trust SSH host {host}:{port}?': '信任主机 {host}:{port}？' } });

    expect(p.localization.t('Trust SSH host {host}:{port}?', { host: 'example.com', port: 22 })).toBe(
      '信任主机 example.com:22？'
    );
    expect(p.localization.t('No active SSH terminal')).toBe('No active SSH terminal');
  });

  it('the clipboard records the written content', async () => {
    const p = fake();

    await p.clipboard.writeText('root@example.com:22');
    await p.clipboard.writeText('SHA256:abc');

    expect(p.clipboard.written).toEqual(['root@example.com:22', 'SHA256:abc']);
  });
});

describe('the core Emitter can drive a UI-less change event', () => {
  it('replicates the TerminalContextRegistry "active terminal changed" notification with an Emitter', () => {
    // Same usage shape as src/terminal/TerminalContext.ts:31-36: a private Emitter plus a
    // read-only event.
    class FakeTerminalRegistry {
      private readonly activeChanged = new Emitter<string | undefined>();
      readonly onDidChangeActive = this.activeChanged.event;
      private active: string | undefined;

      setActive(terminalId: string): void {
        this.active = terminalId;
        this.activeChanged.fire(terminalId);
      }

      getActive(): string | undefined {
        return this.active;
      }

      dispose(): void {
        this.activeChanged.dispose();
      }
    }

    const registry = new FakeTerminalRegistry();
    const listener = vi.fn();
    const bag = registry.onDidChangeActive(listener);

    registry.setActive('t-1');
    expect(listener).toHaveBeenCalledWith('t-1');
    expect(registry.getActive()).toBe('t-1');

    bag.dispose();
    registry.setActive('t-2');
    expect(listener).toHaveBeenCalledTimes(1);

    registry.dispose();
    registry.setActive('t-3');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('end to end: a full ops loop completes with no host', () => {
  it('read config -> fetch credential -> prompt -> progress transfer -> notify -> copy -> persist state', async () => {
    const p = fake({
      config: { sshManager: { keepAliveInterval: 45, sessionLogDirectory: '/tmp/logs' } },
      dictionary: { 'Transferring {path}': '正在传输 {path}' }
    });

    // 1) Read configuration (falling back to defaults)
    const section = p.config.getSection('sshManager');
    const keepAlive = section.get('keepAliveInterval', 30);
    const logDir = section.get('sessionLogDirectory', '');

    // 2) Read an already-stored credential
    await p.secrets.store('sshManager.password.prod', 'pw-1');
    const password = await p.secrets.get('sshManager.password.prod');

    // 3) Fill in a one-time code via keyboard-interactive
    p.keyboardInteractiveRecorder.nextResponses = ['654321'];
    const otp = await p.keyboardInteractive({
      name: 'PAM',
      instructions: '',
      prompts: [{ prompt: 'One-time code', echo: true }]
    });

    // 4) A transfer with progress (the text goes through the localization port)
    const progress = await p.notifier.withProgress(
      { title: p.localization.t('Transferring {path}', { path: '/var/log/app.log' }), cancellable: false },
      async (reporter) => {
        reporter.report({ increment: 50, message: '2 MiB / 4 MiB' });
        return await p.transfers.withProgress('Download file', async () => 'bytes');
      }
    );

    // 5) Failure notification + copy + persist state
    await p.transfers.notifySuccess('Download file completed.');
    await p.clipboard.writeText('root@prod:22');
    await p.state.update('sshManager.servers', [{ id: 'prod', label: 'prod' }]);

    // 6) Confirm the failure path can also surface the error to the user (with an action)
    p.notifier.queueAnswer('Repair');
    const choice = await p.notifier.showErrorMessage('Hub sync failed', 'Repair');

    expect(keepAlive).toBe(45);
    expect(logDir).toBe('/tmp/logs');
    expect(password).toBe('pw-1');
    expect(otp).toEqual(['654321']);
    expect(p.notifier.progressCalls[0].options.title).toBe('正在传输 /var/log/app.log');
    expect(progress).toBe('bytes');
    expect(p.transfers.progressLabels).toEqual(['Download file']);
    expect(p.clipboard.written).toEqual(['root@prod:22']);
    expect(p.state.get('sshManager.servers', [])).toEqual([{ id: 'prod', label: 'prod' }]);
    expect(choice).toBe('Repair');
  });
});

describe('Platform assembly', () => {
  it('the whole port bundle is injected at once, and each port is the same instance (replaceable)', () => {
    const p = fake();
    const typed: Platform = p;

    expect(typed.notifier).toBe(p.notifier);
    expect(typed.uris).toBe(p.uris);
    expect(typed.secrets).toBe(p.secrets);
    expect(platformShape.environment.appName).toBe('Fake IDE');
    expect(new FakeUri('file', '/a').fsPath).toBe('/a');
  });
});
