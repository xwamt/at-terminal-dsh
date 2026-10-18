import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { createFlowController, PAUSE_BYTES, RESUME_BYTES } from '../../src/platform/dsh/client/flow';
import { createTerminalFrameHandler, type TerminalFrameDeps } from '../../src/platform/dsh/client/frames';
import { en, zh } from '../../src/platform/dsh/client/i18n';
import {
  asFailure,
  authLabel,
  buildServerInput,
  count,
  decodeBase64Frame,
  emptyForm,
  errorKey,
  flattenSftpTree,
  formFromServer,
  groupServers,
  parentRemotePath,
  resolveSocketUrl,
  rpcError,
  saveBytes,
  serverViews,
  sftpEntrySize,
  sftpExpandable,
  sftpFileText,
  sftpListing,
  sftpRowA11y,
  sftpRowFocusable,
  sftpTreeFocusKey,
  sftpTreeKeyAction,
  sftpWriteResult,
  summarizeForm,
  terminalSocketUrl,
  text,
  trustHelpKey,
  uploadTargetPath,
  validateForm,
  type FormModel,
  type ServerView,
  type SftpChildState,
  type SftpEntryView,
  type SftpRow
} from '../../src/platform/dsh/client/models';
import { buildStyleSheet, scopeCss } from '../../src/platform/dsh/client/styles';
import { moveTreeFocus } from '../../src/platform/dsh/client/views/sftp';
import { lineCount } from '../../src/platform/dsh/client/views/sftpFile';

/**
 * The Client half's logic, tested as the pure modules it is now built from.
 *
 * The previous suite drove one 2,400-line handwritten file through a React shim; the
 * client is compiled now, so the split is: **logic** (forms, lists, protocol frames,
 * backpressure, CSS scoping) is unit-tested here against the TypeScript sources, and
 * the **bundle contract** (loader registration, apply() wiring, rendered tree) is
 * asserted in `client-bundle.test.ts` against the built artifact.
 */

const t = (key: string, args?: Record<string, unknown>): string => {
  const template = zh[key] ?? key;
  if (args === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(args[name] ?? ''));
};

function server(overrides: Partial<ServerView> = {}): ServerView {
  return {
    id: 'srv-1',
    label: 'web-01',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    hasPassword: true,
    encoding: 'utf-8',
    keepAliveInterval: 30,
    ...overrides
  };
}

describe('client models — errors and scalars', () => {
  it('keeps the Host error code on the thrown Error', () => {
    const error = rpcError('wrong-password', 'bad package password');
    expect(error.code).toBe('wrong-password');
    expect(error.message).toBe('bad package password');
    expect(rpcError(undefined, undefined).code).toBe('rpc-error');
  });

  it('normalizes anything thrown into { code, message }', () => {
    expect(asFailure(rpcError('host-key-changed', 'nope'))).toEqual({
      code: 'host-key-changed',
      message: 'nope'
    });
    expect(asFailure(new Error('plain')).code).toBe('client-error');
    expect(asFailure('str').message).toBe('str');
  });

  it('never lets NaN or null reach a label', () => {
    expect(count(undefined)).toBe(0);
    expect(count('12')).toBe(12);
    expect(count(Number.NaN)).toBe(0);
    expect(text(null)).toBe('');
    expect(text(7)).toBe('7');
  });

  it('maps each actionable code to its own copy, and never merges the two pairs', () => {
    expect(errorKey('wrong-password')).toBe('error.wrongPassword');
    expect(errorKey('unreadable-package')).toBe('error.unreadablePackage');
    expect(errorKey('host-key-unknown')).toBe('error.hostKeyUnknown');
    expect(errorKey('host-key-changed')).toBe('error.hostKeyChanged');
    expect(errorKey('bad-params')).toBe('error.badParams');
    expect(errorKey('whatever')).toBe('error.generic');
    // The four actionable codes must not collapse onto one key.
    const keys = [
      errorKey('wrong-password'),
      errorKey('unreadable-package'),
      errorKey('host-key-unknown'),
      errorKey('host-key-changed')
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('gives every SSH failure code its own actionable copy', () => {
    // These codes come from src/platform/dsh/sshFailure.ts — the answer to a real
    // connect showing ssh2's "All configured authentication methods failed" verbatim.
    const codes = [
      'authentication-failed',
      'password-missing',
      'private-key-path-missing',
      'private-key-unreadable',
      'connection-refused',
      'connection-timeout',
      'host-unresolved',
      'host-unreachable'
    ];
    const keys = codes.map(errorKey);
    expect(new Set(keys).size).toBe(codes.length);
    for (const [index, code] of codes.entries()) {
      expect(errorKey(code), code).toBe(keys[index]);
      expect(zh[keys[index]], code).toBeDefined();
      expect(en[keys[index]], code).toBeDefined();
    }
  });

  it('labels auth types, showing an unknown one as it came', () => {
    expect(authLabel(t, 'password')).toBe(zh['auth.password']);
    expect(authLabel(t, 'privateKey')).toBe(zh['auth.privateKey']);
    expect(authLabel(t, 'agent')).toBe(zh['auth.agent']);
    expect(authLabel(t, 'magic')).toBe('magic');
  });
});

describe('client models — server list', () => {
  it('tolerates any shape an unrelated reply might have', () => {
    expect(serverViews(undefined)).toEqual([]);
    expect(serverViews({ servers: 'nope' })).toEqual([]);
    expect(serverViews({ servers: [server(), null, 3] })).toHaveLength(1);
  });

  it('groups by name in Host order and puts the ungrouped last', () => {
    const grouped = groupServers([
      server({ id: 'a', group: 'prod' }),
      server({ id: 'b' }),
      server({ id: 'c', group: 'dev' }),
      server({ id: 'd', group: 'prod' })
    ]);
    expect(grouped.map((group) => group.name)).toEqual(['prod', 'dev', null]);
    expect(grouped[0].servers.map((entry) => entry.id)).toEqual(['a', 'd']);
  });
});

describe('client models — form', () => {
  it('starts blank with the schema defaults', () => {
    expect(emptyForm()).toMatchObject({
      id: '',
      port: '22',
      authType: 'password',
      encoding: 'utf-8',
      keepAliveInterval: '30',
      agentCommandTrust: 'none',
      backgroundConnectionAllowed: false
    });
  });

  it('never carries a password into the edit form, and normalizes trust', () => {
    const form = formFromServer(
      server({ authType: 'privateKey', privateKeyPath: '/keys/id_ed25519', agentCommandTrust: 'policy' })
    );
    expect(form.password).toBe('');
    expect(form.privateKeyPath).toBe('/keys/id_ed25519');
    expect(form.agentCommandTrust).toBe('policy');
    expect(formFromServer(server({ agentCommandTrust: 'bogus' })).agentCommandTrust).toBe('none');
    // Only a literal `true` enables background connections.
    expect(formFromServer(server({ backgroundConnectionAllowed: true })).backgroundConnectionAllowed).toBe(true);
    expect(formFromServer(server()).backgroundConnectionAllowed).toBe(false);
  });

  it('validates inline, before any RPC, field by field', () => {
    const base: FormModel = { ...emptyForm(), label: 'l', host: 'h', username: 'u', password: 'p' };
    expect(validateForm(t, base, true)).toBeNull();
    expect(validateForm(t, { ...base, label: '  ' }, true)?.field).toBe('label');
    expect(validateForm(t, { ...base, host: '' }, true)?.field).toBe('host');
    expect(validateForm(t, { ...base, username: '' }, true)?.field).toBe('username');
    expect(validateForm(t, { ...base, port: '0' }, true)?.field).toBe('port');
    expect(validateForm(t, { ...base, port: '65536' }, true)?.field).toBe('port');
    expect(validateForm(t, { ...base, port: 'ssh' }, true)?.field).toBe('port');
    expect(validateForm(t, { ...base, keepAliveInterval: '-1' }, true)?.field).toBe('keepAliveInterval');
    // A NEW password-auth server needs a password; an edit may leave it blank.
    expect(validateForm(t, { ...base, password: '' }, true)?.field).toBe('password');
    expect(validateForm(t, { ...base, password: '' }, false)).toBeNull();
    expect(
      validateForm(t, { ...base, authType: 'privateKey', privateKeyPath: ' ' }, true)?.field
    ).toBe('privateKeyPath');
  });

  it('builds the DshServerInput the Host expects — write-only password, trust-gated background', () => {
    const fresh = buildServerInput(
      { ...emptyForm(), label: ' web ', host: ' h ', username: ' u ', password: 'secret', group: ' prod ' },
      true
    );
    expect(fresh).toEqual({
      label: 'web',
      host: 'h',
      username: 'u',
      port: 22,
      authType: 'password',
      encoding: 'utf-8',
      keepAliveInterval: 30,
      agentCommandTrust: 'none',
      group: 'prod',
      password: 'secret'
    });
    expect('id' in fresh).toBe(false);

    // An edit with a blank password omits it: an empty string would clear the stored one.
    const edit = buildServerInput({ ...emptyForm(), id: 'srv-1', label: 'l', host: 'h', username: 'u' }, false);
    expect(edit.id).toBe('srv-1');
    expect('password' in edit).toBe(false);
    expect('group' in edit).toBe(false);

    // backgroundConnectionAllowed is excluded while untrusted (the disabled-checkbox rule)
    // and included, as set, once trust is raised.
    const untrusted = buildServerInput(
      { ...emptyForm(), label: 'l', host: 'h', username: 'u', password: 'p', backgroundConnectionAllowed: true },
      true
    );
    expect('backgroundConnectionAllowed' in untrusted).toBe(false);
    const trusted = buildServerInput(
      {
        ...emptyForm(),
        label: 'l',
        host: 'h',
        username: 'u',
        password: 'p',
        agentCommandTrust: 'full',
        backgroundConnectionAllowed: true
      },
      true
    );
    expect(trusted.agentCommandTrust).toBe('full');
    expect(trusted.backgroundConnectionAllowed).toBe(true);

    const key = buildServerInput(
      { ...emptyForm(), label: 'l', host: 'h', username: 'u', authType: 'privateKey', privateKeyPath: '/k', jumpHostId: 'j' },
      true
    );
    expect(key.privateKeyPath).toBe('/k');
    expect(key.jumpHostId).toBe('j');
  });

  it('summarizes the form the way the VS Code summary panel does', () => {
    const summary = summarizeForm(t, { ...emptyForm(), username: 'root', host: '10.0.0.1', port: '2222' }, []);
    expect(summary.target).toBe('root@10.0.0.1:2222');
    expect(summary.group).toContain(zh['form.defaultGroup']);
    expect(summary.route).toBe(zh['form.summaryRouteDirect']);
    expect(summary.agent).toBe(zh['form.summaryAgentManual']);

    const withJump = summarizeForm(
      t,
      { ...emptyForm(), username: 'u', host: 'h', jumpHostId: 'j1', agentCommandTrust: 'policy' },
      [server({ id: 'j1', label: 'bastion', host: '10.0.0.9' })]
    );
    expect(withJump.route).toContain('bastion');
    expect(withJump.agent).toBe(zh['form.summaryAgentPolicy']);

    expect(summarizeForm(t, emptyForm(), []).target).toBe(zh['form.summaryEnterHostUser']);
  });

  it('maps trust levels to their three distinct help texts', () => {
    expect(trustHelpKey('none')).toBe('form.trustHelpNone');
    expect(trustHelpKey('policy')).toBe('form.trustHelpPolicy');
    expect(trustHelpKey('full')).toBe('form.trustHelpFull');
  });
});

describe('client models — wire helpers', () => {
  it('round-trips base64 frames as exact bytes, including split multi-byte content', () => {
    const bytes = new TextEncoder().encode('héllo 世界');
    const round = decodeBase64Frame(Buffer.from(bytes).toString('base64'));
    expect(Array.from(round)).toEqual(Array.from(bytes));
    expect(decodeBase64Frame('').length).toBe(0);
  });

  it('derives the socket URL from the page origin, and refuses to guess', () => {
    expect(terminalSocketUrl({ protocol: 'http:', host: 'h:1' })).toBe('ws://h:1/dsh-at-terminal/ws');
    expect(terminalSocketUrl({ protocol: 'https:', host: 'h:1' })).toBe('wss://h:1/dsh-at-terminal/ws');
    expect(() => terminalSocketUrl(undefined)).toThrow(/no-origin|host/);
    try {
      terminalSocketUrl({ host: '' });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('no-origin');
    }
  });

  it('picks the socket address by page origin: web page → own host, dsh-app → Host-reported endpoint', () => {
    // The web GUI (including a LAN browser) must use the page's own origin —
    // asking the Host there would answer 127.0.0.1, unreachable from another machine.
    expect(resolveSocketUrl({ protocol: 'http:', host: '192.168.1.9:19387' }, null)).toBe(
      'ws://192.168.1.9:19387/dsh-at-terminal/ws'
    );
    // The reported endpoint is ignored on an http(s) page even when present.
    expect(
      resolveSocketUrl({ protocol: 'https:', host: 'h:1' }, { wsUrl: 'ws://127.0.0.1:9/x' })
    ).toBe('wss://h:1/dsh-at-terminal/ws');

    // The Desktop shell's dsh-app://app page: location.host is unconnectable, so
    // the Host's channel.info answer is the only authority.
    expect(
      resolveSocketUrl(
        { protocol: 'dsh-app:', host: 'app' },
        { wsUrl: 'ws://127.0.0.1:19387/dsh-at-terminal/ws' }
      )
    ).toBe('ws://127.0.0.1:19387/dsh-at-terminal/ws');

    // No web origin and no reported endpoint: a coded refusal, never ws://app/...
    for (const endpoints of [null, {}, { wsUrl: null }, { wsUrl: '  ' }]) {
      try {
        resolveSocketUrl({ protocol: 'dsh-app:', host: 'app' }, endpoints);
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as { code?: string }).code).toBe('no-ws-endpoint');
      }
    }
  });
});

describe('client flow control', () => {
  it('pauses above the threshold and resumes below it, once per edge', () => {
    const edges: boolean[] = [];
    const flow = createFlowController({ onPauseChange: (paused) => edges.push(paused) });

    flow.produced(PAUSE_BYTES); // at the threshold: not over yet
    expect(edges).toEqual([]);
    flow.produced(1);
    expect(edges).toEqual([true]);
    flow.produced(1024); // no repeat while paused
    expect(edges).toEqual([true]);

    flow.rendered(flow.outstanding - RESUME_BYTES); // exactly at resume: still paused
    expect(edges).toEqual([true]);
    expect(flow.paused).toBe(true);
    flow.rendered(1);
    expect(edges).toEqual([true, false]);
    expect(flow.paused).toBe(false);
  });

  it('clamps at zero and ignores non-positive deltas', () => {
    const edges: boolean[] = [];
    const flow = createFlowController({ onPauseChange: (paused) => edges.push(paused) });
    flow.rendered(100);
    expect(flow.outstanding).toBe(0);
    flow.produced(0);
    flow.produced(-5);
    expect(flow.outstanding).toBe(0);
    expect(edges).toEqual([]);
  });

  it('reset() drops the counter without emitting a resume for a replaced socket', () => {
    const edges: boolean[] = [];
    const flow = createFlowController({ onPauseChange: (paused) => edges.push(paused) });
    flow.produced(PAUSE_BYTES + 1);
    expect(edges).toEqual([true]);
    flow.reset();
    expect(flow.paused).toBe(false);
    expect(flow.outstanding).toBe(0);
    expect(edges).toEqual([true]); // a fresh connection opens unpaused on the Host
  });

  it('keeps the documented thresholds', () => {
    expect(PAUSE_BYTES).toBe(256 * 1024);
    expect(RESUME_BYTES).toBe(64 * 1024);
  });
});

describe('client terminal frames', () => {
  interface Recorded extends TerminalFrameDeps {
    calls: string[];
    output: Uint8Array[];
    states: Array<{ kind: string; text: string }>;
    errors: Array<{ code: string; message: string; fingerprint: string }>;
    closed: string[];
  }

  function recorder(): Recorded {
    const base = {
      calls: [] as string[],
      output: [] as Uint8Array[],
      states: [] as Array<{ kind: string; text: string }>,
      errors: [] as Array<{ code: string; message: string; fingerprint: string }>,
      closed: [] as string[]
    };
    return Object.assign(base, {
      requestOpen: () => void base.calls.push('open'),
      onOpened: () => void base.calls.push('opened'),
      onState: (state: { kind: string; text: string }) => void base.states.push(state),
      onOutput: (bytes: Uint8Array) => void base.output.push(bytes),
      onError: (failure: { code: string; message: string; fingerprint: string }) => void base.errors.push(failure),
      onClosed: (reason: string) => void base.closed.push(reason)
    }) as Recorded;
  }

  const frame = (message: unknown): string => JSON.stringify(message);

  it('opens only after the Host handshake greeting', () => {
    const deps = recorder();
    const handler = createTerminalFrameHandler(deps);
    handler.handle(frame({ type: 'hello', seq: 1 }));
    expect(deps.calls).toEqual(['open']);
  });

  it('reports the opened PTY', () => {
    const deps = recorder();
    createTerminalFrameHandler(deps).handle(frame({ type: 'terminal.opened', id: 'x' }));
    expect(deps.calls).toEqual(['opened']);
  });

  it('decodes base64 output into exact bytes', () => {
    const deps = recorder();
    const bytes = new TextEncoder().encode('héllo');
    createTerminalFrameHandler(deps).handle(
      frame({ type: 'terminal.output', data: Buffer.from(bytes).toString('base64') })
    );
    expect(deps.output).toHaveLength(1);
    expect(Array.from(deps.output[0])).toEqual(Array.from(bytes));
  });

  it('ignores output frames with no usable payload', () => {
    const deps = recorder();
    const handler = createTerminalFrameHandler(deps);
    handler.handle(frame({ type: 'terminal.output' }));
    handler.handle(frame({ type: 'terminal.output', data: '' }));
    handler.handle(frame({ type: 'terminal.output', data: 42 }));
    expect(deps.output).toEqual([]);
    expect(deps.errors).toEqual([]);
  });

  it('turns an undecodable frame into a coded error instead of mojibake', () => {
    const deps = recorder();
    createTerminalFrameHandler(deps).handle(frame({ type: 'terminal.output', data: '!!!not-base64!!!' }));
    expect(deps.output).toEqual([]);
    expect(deps.errors).toHaveLength(1);
    expect(deps.errors[0].message.length).toBeGreaterThan(0);
  });

  it('maps status states, defaulting an unknown one to disconnected', () => {
    const deps = recorder();
    const handler = createTerminalFrameHandler(deps);
    handler.handle(frame({ type: 'terminal.status', state: 'connected', text: 'ok' }));
    handler.handle(frame({ type: 'terminal.status', state: 'weird' }));
    handler.handle(frame({ type: 'terminal.status' }));
    expect(deps.states).toEqual([
      { kind: 'connected', text: 'ok' },
      { kind: 'disconnected', text: '' },
      { kind: 'disconnected', text: '' }
    ]);
  });

  it('carries the host-key error code and fingerprint through untouched', () => {
    const deps = recorder();
    createTerminalFrameHandler(deps).handle(
      frame({ type: 'terminal.error', code: 'host-key-changed', message: 'differs', fingerprint: 'SHA256:abc' })
    );
    expect(deps.errors).toEqual([{ code: 'host-key-changed', message: 'differs', fingerprint: 'SHA256:abc' }]);
  });

  it('reports close with its reason, protocol errors as frame-error, and bye as disconnected', () => {
    const deps = recorder();
    const handler = createTerminalFrameHandler(deps);
    handler.handle(frame({ type: 'terminal.closed', reason: 'requested' }));
    expect(deps.closed).toEqual(['requested']);
    expect(deps.states.at(-1)).toEqual({ kind: 'disconnected', text: '' });
    handler.handle(frame({ type: 'error', message: 'frames must be JSON' }));
    expect(deps.errors.at(-1)?.code).toBe('frame-error');
    handler.handle(frame({ type: 'bye' }));
    expect(deps.states.at(-1)).toEqual({ kind: 'disconnected', text: '' });
  });

  it('ignores garbage and unknown frames rather than guessing', () => {
    const deps = recorder();
    const handler = createTerminalFrameHandler(deps);
    handler.handle('not json');
    handler.handle(undefined);
    handler.handle(frame({ type: 'whatever' }));
    handler.handle(frame(null));
    expect(deps.calls).toEqual([]);
    expect(deps.errors).toEqual([]);
    expect(deps.states).toEqual([]);
  });
});

describe('client i18n', () => {
  it('keeps the zh and en key sets identical', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zh).length).toBeGreaterThan(80);
  });
});

describe('client styles — scopeCss', () => {
  it('maps html/body/:root onto the panel root and prefixes everything else', () => {
    expect(scopeCss('body { margin: 0 }', '.r')).toBe('.r{ margin: 0 }');
    expect(scopeCss('html,\nbody { height: 100% }', '.r')).toBe('.r{ height: 100% }');
    expect(scopeCss('.a .b { color: red }', '.r')).toBe('.r .a .b{ color: red }');
    expect(scopeCss('body.auth-password .f { display: none }', '.r')).toBe(
      '.r.auth-password .f{ display: none }'
    );
  });

  it('recurses through @media and leaves @keyframes global', () => {
    const scoped = scopeCss('@media (max-width: 760px) { .a { display: block } }', '.r');
    expect(scoped).toBe('@media (max-width: 760px){.r .a{ display: block }}');
    const keyframes = scopeCss('@keyframes spin { from { x: 0 } to { x: 1 } }', '.r');
    expect(keyframes).toContain('@keyframes spin');
    expect(keyframes).not.toContain('.r from');
  });

  it('strips comments, so a brace inside one cannot desync the walk', () => {
    expect(scopeCss('/* } { */ .a { color: red }', '.r')).toBe('.r .a{ color: red }');
  });

  it('scopes the two reused stylesheets with no bare body/html selector left', () => {
    const sheet = buildStyleSheet(readRealSources());
    // Every rule selector must live under the panel root.
    expect(sheet).not.toMatch(/(^|\})\s*body\s*\{/);
    expect(sheet).not.toMatch(/(^|\})\s*html\s*,/);
    // The reused classes and the token bridge are all present.
    for (const marker of [
      '.att-root .terminal-shell',
      '.att-root .server-form',
      '.att-root .auth-card.is-selected',
      '.att-root .xterm',
      '--vscode-terminal-background: var(--dsw-alias-bg-base'
    ]) {
      expect(sheet).toContain(marker);
    }
  });

  it('bridges every --vscode-* variable the reused sheets read', () => {
    const sources = readRealSources();
    const used = new Set(
      [...`${sources.terminal}\n${sources.serverForm}`.matchAll(/var\((--vscode-[A-Za-z-]+)/g)].map(
        (match) => match[1]
      )
    );
    expect(used.size).toBeGreaterThan(10);
    const sheet = buildStyleSheet(sources);
    const missing = [...used].filter((name) => !sheet.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});

/**
 * UI2-05: the panel reads the host's geometry tokens instead of VS Code's control sizes.
 *
 * These assertions are about **declarations**, not about looks. A text assertion can prove a rule
 * exists and names a token; only the walkthrough in a real dsh can prove the result is right, and
 * that is recorded as unverified in the plan rather than claimed here.
 */
describe('client styles — geometry and surface tokens (UI2-05)', () => {
  /**
   * The declaration block for one selector, or '' when there is none.
   *
   * The **last** match, not the first: `.att-root` is declared three times in the assembled sheet
   * (the scoped xterm sheet, the token bridge, and this file's own layout block), and the one that
   * decides how the panel looks is the one that comes last. A first-match helper would silently
   * assert against the scoped xterm reset and pass for the wrong reason.
   */
  function ruleFor(sheet: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...sheet.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
    return matches.length === 0 ? '' : (matches[matches.length - 1][1] as string);
  }

  const sheet = buildStyleSheet(readRealSources());

  it('takes the host content size and font', () => {
    expect(ruleFor(sheet, '.att-root')).toContain('var(--dsh-content-font-size-secondary');
    // A token, not a hand-written stack: the panel used to disagree with every other pane the
    // moment the host font was not the platform default.
    expect(sheet).toContain('--vscode-font-family: var(--dsw-font-family)');
  });

  it('sizes controls the way the host sizes its buttons and rows', () => {
    const button = ruleFor(sheet, '.att-btn');
    expect(button).toContain('height: 28px');
    expect(button).toContain('var(--dsw-radius-sm)');
    // 24px / 4px was the webview control: dense beside 12px rows.
    expect(button).not.toContain('border-radius: 4px');

    const row = ruleFor(sheet, '.att-row');
    expect(row).toContain('var(--dsw-radius-md)');
    /*
     * 5/10 on the left and top, 58 on the right — and the asymmetry is the fix, not an accident.
     *
     * The row's 连接/⋯ buttons are absolutely positioned, so they need a seat that the flex
     * content does not use; with a symmetric 5/10 they landed on top of the 已存口令 badge and
     * covered it. Asserted as the literal string because "the badge is visible" is not something
     * a text test can see, while "the seat is reserved" is exactly what prevents it.
     */
    expect(row).toContain('padding: 5px 58px 5px 10px');

    expect(ruleFor(sheet, '.att-menu')).toContain('var(--dsw-radius-md)');
    expect(ruleFor(sheet, '.att-dialog')).toContain('var(--dsw-radius-lg)');
  });

  it('marks a selected segment with the neutral overlay rather than the brand fill', () => {
    const selected = ruleFor(sheet, '.att-nav-btn[aria-selected="true"]');
    expect(selected).toContain('var(--dsw-alias-interactive-bg-active)');
    // The brand fill belongs to the primary action beside the switch, not to the switch.
    expect(selected).not.toContain('--vscode-button-background');
  });

  it('paints focus with the business token, so the ring is not the brand fill', () => {
    expect(sheet).toContain('--vscode-focusBorder: var(--dsw-alias-state-business-primary)');
    expect(sheet).toContain('--vscode-list-activeSelectionBackground: var(--dsw-alias-interactive-bg-active)');
  });

  it('gives code its own font instead of a monospace fallback that never resolved', () => {
    const rule = ruleFor(
      sheet,
      '.att-file-text, .att-file-editor, .att-code-preview'
    );
    expect(rule).toContain('var(--ds-font-family-code');
    // The old declarations read a variable nothing defined, so every code surface silently fell
    // back to the generic family.
    expect(sheet).not.toContain('var(--vscode-editor-font-family');
  });

  it('keeps the panel surface a sidebar fill, not a page colour', () => {
    // 'transparent' would be identical when docked and wrong when floated or full-screen, so the
    // choice is the column's own opaque fill.
    expect(ruleFor(sheet, '.att-root')).toContain('var(--dsw-specific-sidebar-fill)');
  });

  it('declares the container query the narrow layout depends on (UI2-02)', () => {
    expect(sheet).toContain('container: att-panel / inline-size');
    // Both thresholds: one column for the section grid, then stacked fields and full-width
    // actions. A window media query cannot answer either question for a 460px sidebar.
    expect(sheet).toContain('@container att-panel (max-width: 680px)');
    expect(sheet).toContain('@container att-panel (max-width: 520px)');
  });
});

/**
 * `.att-*` classes the client renders but the sheet never defines — the audit behind UI2-00.
 *
 * Four of these shipped in the monitor/HUD work (`att-input`, `att-hud-pill-expand-arrow`,
 * `att-btn-secondary`, `att-sftp-file-page`), and nothing caught them: an undefined class is
 * not a syntax error, a type error or a failed assertion — it is a control that silently falls
 * back to the browser's own chrome, which looks *plausible* in a screenshot and wrong only
 * next to the real thing. A text assertion is the only kind of test that can see it.
 *
 * What this proves and does not: every literal still currently resolves. It cannot prove the
 * rule says anything useful, and it deliberately does not try — a class defined as `{}` passes,
 * because "defined but faint" is a design review, not a gate.
 */
describe('client styles — className audit (UI2-00)', () => {
  /**
   * Every `className` literal in one source file, tokenised.
   *
   * Only literals: a `className` built from a variable is not auditable here, and inferring one
   * would mean running the component. A template literal contributes its **static** prefix —
   * `att-badge ${kind}` yields `att-badge` — which is the honest reading of "this class is
   * rendered": the interpolated half is another branch of code this test does not execute.
   */
  function classNameTokens(source: string): string[] {
    const tokens: string[] = [];
    for (const statement of source.matchAll(/className:\s*([^\n]*)/g)) {
      const line = statement[1];
      for (const literal of line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
        const value = literal[1] ?? literal[2] ?? literal[3] ?? '';
        for (const token of value.split(/[\s${}]+/)) {
          if (/^att-[A-Za-z0-9_-]+$/.test(token)) tokens.push(token);
        }
      }
    }
    return tokens;
  }

  function clientSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) out.push(...clientSources(path));
      else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
  }

  it('defines every att-* class the client renders', () => {
    const dir = join(process.cwd(), 'src', 'platform', 'dsh', 'client');
    const sheet = buildStyleSheet(readRealSources());

    /** `.att-x` as a whole class, not the prefix of `.att-x-y`. */
    const isDefined = (className: string): boolean =>
      new RegExp(`\\.${className}(?![A-Za-z0-9_-])`).test(sheet);

    const missing: string[] = [];
    let seen = 0;
    for (const file of clientSources(dir)) {
      for (const token of new Set(classNameTokens(readFileSync(file, 'utf8')))) {
        seen += 1;
        if (!isDefined(token)) missing.push(`${token} (${file.slice(dir.length + 1)})`);
      }
    }

    // A regex that stopped matching would make this suite vacuously green.
    expect(seen).toBeGreaterThan(80);
    expect(missing).toEqual([]);
  });

  it('reads a template literal as its static prefix only', () => {
    expect(classNameTokens("className: `att-badge ${kind === 'a' ? 'x' : 'y'}`")).toEqual(['att-badge']);
    // Both arms of a ternary are literals, so both are audited; `primary` is not an att- class.
    expect(classNameTokens("className: primary ? 'att-btn primary' : 'att-btn'")).toEqual([
      'att-btn',
      'att-btn'
    ]);
    // A class built from a variable is not a literal and is not audited.
    expect(classNameTokens('className: dynamic')).toEqual([]);
  });

  /**
   * UI2-04: no destructive question goes to the browser any more.
   *
   * A call, not a mention: the two comments that explain *why* `window.confirm` is gone name it,
   * and deleting those would cost more than this assertion buys. `window.confirm(` with the
   * parenthesis is the only thing that can actually open a dialog.
   */
  it('never asks a question through window.confirm', () => {
    const dir = join(process.cwd(), 'src', 'platform', 'dsh', 'client');
    const offenders = clientSources(dir).filter((file) =>
      /window\.confirm\s*\(/.test(readFileSync(file, 'utf8'))
    );

    expect(offenders.map((file) => file.slice(dir.length + 1))).toEqual([]);
  });

  /**
   * UI2-06 step 7: no emoji, and no text glyph standing in for an icon.
   *
   * The unit of the assertion is *what the code can render*, so comments are stripped first. That
   * is not leniency — three of these files document the exact character they replaced, and
   * 「`▣` is a box, it says checkbox before it says folder」 is the sentence that stops the next
   * person from putting it back. Comments cannot reach the screen; strings and literals can.
   *
   * `·` is deliberately absent from the forbidden set: it survives as a *separator* between a
   * server label and its state in the tab title, which is typography rather than an icon. `▣ ▶ ▼
   * ↪ ✕` are the five that were standing in for folder / chevron / symlink / close.
   */
  it('draws no emoji and no text glyph in place of an icon', () => {
    const dir = join(process.cwd(), 'src', 'platform', 'dsh', 'client');
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    const GLYPH = /[▣▶▼▸▾↪✕⠿]/u;

    /** Source with comments removed, by the compiler rather than by a regex. */
    function stripComments(source: string): string {
      return ts.transpileModule(source, {
        reportDiagnostics: false,
        compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022 }
      }).outputText;
    }

    const offenders: string[] = [];
    for (const file of clientSources(dir)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const line of code.split('\n')) {
        if (EMOJI.test(line) || GLYPH.test(line)) {
          offenders.push(`${file.slice(dir.length + 1)}: ${line.trim().slice(0, 80)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('client models — the file tree (DSH-23)', () => {
  const file = (name: string, path: string): SftpEntryView => ({ name, path, type: 'file', size: 2048 });
  const dir = (name: string, path: string): SftpEntryView => ({ name, path, type: 'directory' });
  const link = (name: string, path: string, targetType: 'file' | 'directory'): SftpEntryView => ({
    name,
    path,
    type: 'symlink',
    targetType
  });

  const treeOf = (overrides: Partial<Parameters<typeof flattenSftpTree>[0]> = {}) =>
    flattenSftpTree({
      rootPath: '/home/root',
      entries: [],
      expanded: [],
      children: {},
      disconnected: false,
      ...overrides
    });

  it('reads a Host answer tolerantly, and treats an unknown state as "none"', () => {
    expect(sftpListing(undefined)).toMatchObject({ kind: 'none', rootPath: '', entries: [] });
    expect(sftpListing({ kind: 'weird', entries: 'nope' })).toMatchObject({ kind: 'none', entries: [] });
    // An unrecognised state must not render as a **live** tree: a live tree claims its
    // contents are current, and that is the one claim this page must never make falsely.
    expect(sftpListing({ kind: 'active' }).kind).toBe('active');

    const listing = sftpListing({
      kind: 'disconnected',
      rootPath: '/home/root',
      path: '/home/root',
      serverLabel: 'web-01',
      entries: [{ name: 'a', path: '/home/root/a', type: 'file' }, { name: 'broken' }]
    });
    expect(listing.kind).toBe('disconnected');
    expect(listing.serverLabel).toBe('web-01');
    // An entry without a `path` cannot be rendered or expanded, so it is dropped rather
    // than drawn as a row that would do nothing.
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a']);
  });

  it('keeps a symlink to a directory expandable, and a file symlink closed', () => {
    expect(sftpExpandable(dir('d', '/d'))).toBe(true);
    expect(sftpExpandable(link('l', '/l', 'directory'))).toBe(true);
    // A link whose target could not be stat-ed is not offered as a directory: asking the
    // server to list through a dangling link is a read that cannot succeed.
    expect(sftpExpandable(link('l', '/l', 'file'))).toBe(false);
    expect(sftpExpandable({ name: 'l', path: '/l', type: 'symlink' })).toBe(false);
    expect(sftpExpandable(file('f', '/f'))).toBe(false);
  });

  it('shows a size for files only', () => {
    expect(sftpEntrySize(file('f', '/f'))).toBe('2 KB');
    expect(sftpEntrySize(dir('d', '/d'))).toBe('');
    expect(sftpEntrySize({ name: 'f', path: '/f', type: 'file' })).toBe('');
  });

  it('renders nothing at all when no root is known', () => {
    expect(treeOf({ rootPath: '' })).toEqual([]);
  });

  it('puts a `..` row at the top, and omits it at the filesystem root', () => {
    const rows = treeOf({ entries: [file('a.txt', '/home/root/a.txt')] });
    expect(rows.map((row) => row.kind)).toEqual(['parent', 'entry']);

    // At `/` there is nowhere to go; a `..` there would reload the same directory.
    const atRoot = treeOf({ rootPath: '/', entries: [file('a.txt', '/a.txt')] });
    expect(atRoot.map((row) => row.kind)).toEqual(['entry']);
  });

  it('nests an expanded directory one level, and only fetches what was opened', () => {
    const rows = treeOf({
      entries: [dir('sub', '/home/root/sub'), file('a.txt', '/home/root/a.txt')],
      expanded: ['/home/root/sub'],
      children: { '/home/root/sub': { kind: 'ok', entries: [file('deep.txt', '/home/root/sub/deep.txt')] } }
    });

    expect(rows.map((row) => [row.kind, row.depth, row.entry?.name ?? ''])).toEqual([
      ['parent', 0, ''],
      ['entry', 0, 'sub'],
      ['entry', 1, 'deep.txt'],
      ['entry', 0, 'a.txt']
    ]);
    // A collapsed directory has no children rows, so the tree costs one read per open.
    expect(rows.find((row) => row.entry?.name === 'sub')?.expanded).toBe(true);
    expect(rows.find((row) => row.entry?.name === 'a.txt')?.expandable).toBe(false);
  });

  it('expands a symlinked directory through the link path', () => {
    const rows = treeOf({
      entries: [link('link', '/home/root/link', 'directory')],
      expanded: ['/home/root/link'],
      children: { '/home/root/link': { kind: 'ok', entries: [file('target.txt', '/home/root/link/target.txt')] } }
    });
    expect(rows.map((row) => row.entry?.name)).toEqual([undefined, 'link', 'target.txt']);
    expect(rows[2].depth).toBe(1);
  });

  it('shows a directory still being read as pending, not as empty', () => {
    const rows = treeOf({
      entries: [dir('sub', '/home/root/sub')],
      expanded: ['/home/root/sub'],
      children: { '/home/root/sub': { kind: 'pending' } }
    });
    expect(rows.map((row) => row.kind)).toEqual(['parent', 'entry', 'pending']);

    // A directory that was expanded before its state existed is the same thing: the
    // alternative — drawing no rows — claims the directory is empty.
    const unrecorded = treeOf({ entries: [dir('sub', '/home/root/sub')], expanded: ['/home/root/sub'] });
    expect(unrecorded[unrecorded.length - 1].kind).toBe('pending');
  });

  it('renders a failed child read under that directory, with its code', () => {
    const failure: SftpChildState = {
      kind: 'failed',
      code: 'sftp-permission-denied',
      message: 'Permission denied reading /home/root/sub.'
    };
    const rows = treeOf({
      entries: [dir('sub', '/home/root/sub')],
      expanded: ['/home/root/sub'],
      children: { '/home/root/sub': failure }
    });

    expect(rows.map((row) => row.kind)).toEqual(['parent', 'entry', 'failed']);
    expect(rows[2]).toMatchObject({ code: 'sftp-permission-denied', depth: 1 });
    // The directory row itself survives: one unreadable subdirectory must not wipe the
    // siblings that were read successfully.
    expect(rows[1].kind).toBe('entry');
  });

  it('collapses the whole tree to one level when the listing is the last one', () => {
    const rows = treeOf({
      entries: [dir('sub', '/home/root/sub')],
      expanded: ['/home/root/sub'],
      children: { '/home/root/sub': { kind: 'ok', entries: [file('deep.txt', '/home/root/sub/deep.txt')] } },
      disconnected: true
    });

    // No `..`: moving the root needs a live connection. No nest: the server cannot be
    // asked. What is shown is exactly what was read before the terminal dropped.
    expect(rows.map((row) => [row.kind, row.entry?.name ?? ''])).toEqual([
      ['entry', 'sub']
    ]);
    expect(rows[0].expandable).toBe(false);
  });

  it('resolves the parent directory with the domain\'s own POSIX rules', () => {
    expect(parentRemotePath('/home/root/sub')).toBe('/home/root');
    expect(parentRemotePath('/home')).toBe('/');
    expect(parentRemotePath('/')).toBe('/');
    expect(parentRemotePath('/home/root/')).toBe('/home');
  });

  it('maps the file-tree codes to distinct copy, and leaves connect copy alone', () => {
    // Two states without a live terminal, two read failures, and the two the terminal page
    // already owned — none of them may fall through to the generic line, and none may
    // share a key with another.
    const keys = [
      'no-active-terminal',
      'sftp-disconnected',
      'sftp-no-such-file',
      'sftp-permission-denied',
      'sftp-read-failed',
      'host-key-unknown',
      'connection-refused'
    ].map(errorKey);
    expect(keys.every((key) => key !== 'error.generic')).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(t(key)).not.toBe(key);
  });
});

/**
 * The tree's accessibility surface (UI-02).
 *
 * Asserted here rather than through the rendered bundle because the two halves of this
 * feature are separable and only one needs a document: the attributes a row carries and
 * the meaning of each key are pure functions of the row list, while moving the caret is
 * DOM work with nothing to assert beyond "it called `focus()`". Testing the pure half
 * directly is also what makes the awkward cases reachable at all — a leaf claiming
 * `aria-expanded`, or `→` stepping onto a `pending` placeholder, are two lines each in a
 * pure function and a real screen-reader session to reproduce in a bundle.
 */
describe('client models — the file tree\'s keyboard and ARIA (UI-02)', () => {
  const file = (name: string, path: string): SftpEntryView => ({ name, path, type: 'file', size: 2048 });
  const dir = (name: string, path: string): SftpEntryView => ({ name, path, type: 'directory' });

  const treeOf = (overrides: Partial<Parameters<typeof flattenSftpTree>[0]> = {}) =>
    flattenSftpTree({
      rootPath: '/home/root',
      entries: [],
      expanded: [],
      children: {},
      disconnected: false,
      ...overrides
    });

  /** A directory open one level, with a file beside it and one inside it. */
  const openTree = (): SftpRow[] =>
    treeOf({
      entries: [dir('sub', '/home/root/sub'), file('a.txt', '/home/root/a.txt')],
      expanded: ['/home/root/sub'],
      children: {
        '/home/root/sub': { kind: 'ok', entries: [file('deep.txt', '/home/root/sub/deep.txt')] }
      }
    });

  const rowFor = (rows: SftpRow[], key: string): SftpRow => {
    const row = rows.find((candidate) => candidate.key === key);
    expect(row, `a row for ${key}`).toBeDefined();
    return row as SftpRow;
  };

  it('gives the row a treeitem role, a level, and a tab stop — and a leaf no aria-expanded', () => {
    const rows = openTree();
    const sub = rowFor(rows, '/home/root/sub');
    const a11y = sftpRowA11y(sub, false);

    expect(a11y.role).toBe('treeitem');
    // The DOM is flat — depth is padding, not nesting — so without aria-level a screen
    // reader announces deep.txt as a sibling of sub rather than its child.
    expect(a11y['aria-level']).toBe(sub.depth + 1);
    expect(a11y['data-at-terminal-sftp-row']).toBe('/home/root/sub');

    // A leaf must not claim it can expand. `aria-expanded` on a node with no disclosure
    // is announced as "collapsed" and then there is nothing to open.
    const leaf = sftpRowA11y(rowFor(rows, '/home/root/a.txt'), false);
    expect('aria-expanded' in leaf).toBe(false);
    // The attribute is absent, not `undefined` — a test that only checked the value
    // would pass on a row that still renders the attribute in the DOM.
    expect(leaf['aria-expanded']).toBeUndefined();
    expect(Object.keys(leaf)).not.toContain('aria-expanded');

    // A directory carries it, and it tracks the real expansion state.
    expect(sftpRowA11y(sub, false)['aria-expanded']).toBe(true);
    const collapsed = sftpRowA11y(rowFor(treeOf({ entries: [dir('sub', '/home/root/sub')] }), '/home/root/sub'), false);
    expect(collapsed['aria-expanded']).toBe(false);
  });

  it('makes the tree one tab stop, and marks the row that owns it', () => {
    const rows = openTree();

    // Roving, not `tabIndex=0` on everything: a tree where every row is its own tab
    // stop is the thing role="tree" exists to undo.
    expect(sftpRowA11y(rowFor(rows, '/home/root/sub'), false).tabIndex).toBe(-1);
    const focused = sftpRowA11y(rowFor(rows, '/home/root/sub'), true);
    expect(focused.tabIndex).toBe(0);
    expect(focused['data-at-terminal-sftp-focus']).toBe('true');
    // Exactly one row is marked, and the marker is the roving row, not decoration.
    expect(sftpRowA11y(rowFor(rows, '/home/root/a.txt'), false)['data-at-terminal-sftp-focus']).toBeUndefined();

    // The `..` row is a real destination (sftp.goUp), so it is a treeitem too.
    const parent = sftpRowA11y(rowFor(rows, 'parent'), false);
    expect(parent.role).toBe('treeitem');
    expect(parent['aria-expanded']).toBeUndefined();

    // A placeholder is a treeitem — a role="tree" may only own treeitems, and a screen
    // reader walking the listing has to meet "reading this directory" — but it is
    // deliberately outside the tab ring, so `Enter` on it is never a dead key.
    const pending = sftpRowA11y(
      { kind: 'pending', key: '/home/root/sub#pending', depth: 1, expandable: false, expanded: false },
      false
    );
    expect(pending.role).toBe('treeitem');
    expect(pending.tabIndex).toBeUndefined();
    expect(pending['data-at-terminal-sftp-focus']).toBeUndefined();
    expect(pending['aria-expanded']).toBeUndefined();
    // And it stays out of the arrow-key ring, so ↓ steps over it.
    expect(
      sftpRowFocusable({ kind: 'pending', key: 'k', depth: 1, expandable: false, expanded: false })
    ).toBe(false);
    expect(
      sftpRowFocusable({ kind: 'failed', key: 'k', depth: 1, expandable: false, expanded: false })
    ).toBe(false);
    expect(sftpRowFocusable(rowFor(rows, 'parent'))).toBe(true);
  });

  it('reaches the first row by Tab, and keeps the stop on a row that still exists', () => {
    const rows = openTree();

    // A tree with no tab stop is invisible to the keyboard, so the first row takes it.
    expect(sftpTreeFocusKey(rows, null)).toBe('parent');
    expect(sftpTreeFocusKey(rows, '/home/root/sub/deep.txt')).toBe('/home/root/sub/deep.txt');

    // A remembered row that a `..` or a collapse removed must not leave the tree
    // unfocusable: the preference is dropped and the first row takes over.
    const afterGoUp = treeOf({ entries: [file('a.txt', '/home/a.txt')] });
    expect(sftpTreeFocusKey(afterGoUp, '/home/root/sub/deep.txt')).toBe('parent');

    // Nothing to focus in an empty tree, which is honest — there is no row to stop on.
    expect(sftpTreeFocusKey(treeOf({ rootPath: '' }), null)).toBeNull();
    // A pending-only listing is not focusable either: the placeholder is not a row.
    const placeholder = treeOf({
      entries: [dir('sub', '/home/root/sub')],
      expanded: ['/home/root/sub'],
      children: { '/home/root/sub': { kind: 'pending' } }
    });
    expect(sftpTreeFocusKey(placeholder, null)).toBe('parent');
  });

  it('expands on Enter exactly as clicking the disclosure does', () => {
    const rows = openTree();

    // The disclosure button calls onToggle(row.entry.path); the key must name the same
    // path, or the keyboard and the mouse would be operating on different directories.
    for (const key of ['Enter', ' ']) {
      expect(sftpTreeKeyAction(rows, '/home/root/sub', key)).toEqual({
        kind: 'toggle',
        path: '/home/root/sub'
      });
    }
    // And on a collapsed directory, `→` means the same thing — open it.
    const collapsed = treeOf({ entries: [dir('sub', '/home/root/sub')] });
    expect(sftpTreeKeyAction(collapsed, '/home/root/sub', 'ArrowRight')).toEqual({
      kind: 'toggle',
      path: '/home/root/sub'
    });

    // A file has no disclosure to stand in for, so activation means the one thing a file
    // can be opened as: the viewer.
    expect(sftpTreeKeyAction(rows, '/home/root/a.txt', 'Enter')).toEqual({ kind: 'open', path: '/home/root/a.txt' });
    // Enter on `..` is its own action: it moves the root, it does not toggle anything.
    expect(sftpTreeKeyAction(rows, 'parent', 'Enter')).toEqual({ kind: 'go-up' });
  });

  it('moves the caret to the row the key names, and the row keeps the tab stop', () => {
    const rows = openTree();
    // parent, sub, sub/deep.txt, a.txt
    expect(rows.map((row) => row.key)).toEqual([
      'parent',
      '/home/root/sub',
      '/home/root/sub/deep.txt',
      '/home/root/a.txt'
    ]);

    // ↓ then ↑, the round trip a user actually makes.
    expect(sftpTreeKeyAction(rows, 'parent', 'ArrowDown')).toEqual({ kind: 'focus', key: '/home/root/sub' });
    expect(sftpTreeKeyAction(rows, '/home/root/sub/deep.txt', 'ArrowUp')).toEqual({
      kind: 'focus',
      key: '/home/root/sub'
    });

    // The whole chain the handler drives, end to end: key → action → the row that owns
    // the tab stop → that row's rendered attributes. The caret move and the tab stop are
    // separate mechanisms (a re-render writes the attributes, `focus()` moves the caret),
    // so a test that only checked one would pass while the other was broken.
    const moved = sftpTreeKeyAction(rows, 'parent', 'ArrowDown');
    expect(moved.kind).toBe('focus');
    const landedKey = sftpTreeFocusKey(rows, moved.kind === 'focus' ? moved.key : null);
    expect(landedKey).toBe('/home/root/sub');

    const landed = sftpRowA11y(rowFor(rows, landedKey as string), landedKey === '/home/root/sub');
    expect(landed.tabIndex).toBe(0);
    expect(landed['data-at-terminal-sftp-focus']).toBe('true');
    // The row the caret left is no longer a tab stop, so Tab cannot jump back to it.
    expect(sftpRowA11y(rowFor(rows, 'parent'), false).tabIndex).toBe(-1);
    expect(sftpRowA11y(rowFor(rows, 'parent'), false)['data-at-terminal-sftp-focus']).toBeUndefined();
  });

  it('stops at the ends instead of wrapping, and steps over placeholders', () => {
    const rows = openTree();

    // A file listing is not a carousel: wrapping makes "the last row" unlandable.
    expect(sftpTreeKeyAction(rows, 'parent', 'ArrowUp')).toEqual({ kind: 'none' });
    expect(sftpTreeKeyAction(rows, '/home/root/a.txt', 'ArrowDown')).toEqual({ kind: 'none' });

    // The pending line occupies a slot in the list but is not a row, so ↓ steps over it
    // to the next real entry instead of stopping where nothing can be opened.
    const pending = treeOf({
      entries: [dir('sub', '/home/root/sub'), file('a.txt', '/home/root/a.txt')],
      expanded: ['/home/root/sub'],
      children: { '/home/root/sub': { kind: 'pending' } }
    });
    expect(pending.map((row) => row.kind)).toEqual(['parent', 'entry', 'pending', 'entry']);
    expect(sftpTreeKeyAction(pending, '/home/root/sub', 'ArrowDown')).toEqual({
      kind: 'focus',
      key: '/home/root/a.txt'
    });
  });

  it('→ enters the first child of an open directory, and ← comes back out to the parent', () => {
    const rows = openTree();

    // `→` on an open directory descends rather than re-expanding it.
    expect(sftpTreeKeyAction(rows, '/home/root/sub', 'ArrowRight')).toEqual({
      kind: 'focus',
      key: '/home/root/sub/deep.txt'
    });
    // `←` on that child finds its container.
    expect(sftpTreeKeyAction(rows, '/home/root/sub/deep.txt', 'ArrowLeft')).toEqual({
      kind: 'focus',
      key: '/home/root/sub'
    });
    // `←` on an open directory collapses it instead.
    expect(sftpTreeKeyAction(rows, '/home/root/sub', 'ArrowLeft')).toEqual({
      kind: 'toggle',
      path: '/home/root/sub'
    });

    // An open directory whose listing is still pending has no focusable child, so `→`
    // must not claim one — the placeholder is not somewhere the caret can go.
    const pending = treeOf({
      entries: [dir('sub', '/home/root/sub')],
      expanded: ['/home/root/sub'],
      children: { '/home/root/sub': { kind: 'pending' } }
    });
    expect(sftpTreeKeyAction(pending, '/home/root/sub', 'ArrowRight')).toEqual({ kind: 'none' });

    // `←` on a depth-0 row has nowhere to go: `..` is a sibling of the entries, not
    // their parent, so the walk must not land on it.
    expect(sftpTreeKeyAction(rows, '/home/root/a.txt', 'ArrowLeft')).toEqual({ kind: 'none' });
    expect(sftpTreeKeyAction(rows, 'parent', 'ArrowLeft')).toEqual({ kind: 'none' });
  });

  it('leaves Tab, Escape and unknown keys to the browser and the panel\'s own shortcuts', () => {
    const rows = openTree();

    // A tree that swallows Tab or Escape is a panel the user cannot leave.
    for (const key of ['Tab', 'Escape', 'a', 'F5', 'Home', 'End', 'PageDown']) {
      expect(sftpTreeKeyAction(rows, '/home/root/sub', key), key).toEqual({ kind: 'none' });
    }
    // A caret on a row that is not in the list cannot be moved relative to that list.
    expect(sftpTreeKeyAction(rows, '/gone', 'ArrowDown')).toEqual({ kind: 'none' });
  });

  it('keeps a disconnected tree honest: every row is a leaf, so nothing claims to expand', () => {
    // The whole point of the disconnected collapse is that the server cannot be asked
    // again. A row still advertising aria-expanded would be offering a control that
    // cannot work — the same reasoning that keeps the rename button off the page.
    const rows = treeOf({
      entries: [dir('sub', '/home/root/sub')],
      expanded: ['/home/root/sub'],
      children: {
        '/home/root/sub': { kind: 'ok', entries: [file('deep.txt', '/home/root/sub/deep.txt')] }
      },
      disconnected: true
    });

    for (const row of rows) {
      expect(sftpRowA11y(row, false)['aria-expanded'], row.key).toBeUndefined();
    }
    // And there is nothing to toggle, by key or by arrow.
    expect(sftpTreeKeyAction(rows, '/home/root/sub', 'Enter')).toEqual({ kind: 'none' });
    expect(sftpTreeKeyAction(rows, '/home/root/sub', 'ArrowRight')).toEqual({ kind: 'none' });
  });
});

/**
 * The transfer half of the file feature (DSH-23's read/write half).
 *
 * Only the **pure** parts are asserted here — the wire normalisers and the path composition.
 * `saveBytes` and `readFileAsBase64` touch `Blob`/`FileReader` and belong to the bundle test,
 * which is where a page-like environment exists.
 */
describe('client models — one remote file', () => {
  it('reads the Host answer tolerantly, and never guesses the line ending', () => {
    expect(sftpFileText({ path: '/a.txt', text: 'x\n', eol: 'crlf', size: 3, modifiedAt: 7, truncated: true })).toEqual({
      path: '/a.txt',
      text: 'x\n',
      eol: 'crlf',
      size: 3,
      modifiedAt: 7,
      truncated: true
    });
    // Defaults when fields are absent or wrong
    expect(sftpFileText(null)).toEqual({
      path: '',
      text: '',
      eol: 'lf',
      size: 0,
      modifiedAt: 0,
      truncated: false
    });
  });

  it('reads a write reply as numbers, so a missing field cannot become NaN in a label', () => {
    expect(sftpWriteResult({ size: 12, modifiedAt: 34 })).toEqual({ size: 12, modifiedAt: 34 });
    expect(sftpWriteResult(undefined)).toEqual({ size: 0, modifiedAt: 0 });
  });

  it('joins an uploaded file onto the directory being shown, by the domain own rules', () => {
    expect(uploadTargetPath('/home/root', 'local.txt')).toBe('/home/root/local.txt');
    expect(uploadTargetPath('/', 'local.txt')).toBe('/local.txt');
  });

  it('carries the new failure codes to their own copy, none falling through to the generic line', () => {
    const codes = [
      'sftp-not-a-file',
      'sftp-file-too-large',
      'sftp-binary-file',
      'sftp-conflict',
      'sftp-write-failed',
      'no-file-reader'
    ];
    for (const code of codes) {
      expect(errorKey(code), code).not.toBe('error.generic');
    }
    // And each is a *different* sentence: two codes that render the same copy are one code
    // wearing two names, which is how a remedy gets lost.
    const keys = codes.map((code) => errorKey(code));
    expect(new Set(keys).size).toBe(codes.length);
  });

  it('saveBytes decodes base64 into a Blob without charCodeAt loop bottleneck', async () => {
    const sample = 'Hello, World!'.repeat(100);
    const base64 = Buffer.from(sample, 'utf8').toString('base64');
    let clicked = false;
    let downloadedName = '';
    let capturedBlob: Blob | null = null;
    const originalDocument = (globalThis as any).document;
    const originalUrl = (globalThis as any).URL;
    (globalThis as any).URL = {
      createObjectURL: (blob: Blob) => {
        capturedBlob = blob;
        return 'blob:mock';
      },
      revokeObjectURL: () => undefined
    };
    (globalThis as any).document = {
      createElement: (tag: string) => {
        const el: any = { tag, click: () => {}, remove: () => {} };
        if (tag === 'a') {
          el.click = () => {
            clicked = true;
            downloadedName = el.download;
          };
        }
        return el;
      },
      body: {
        appendChild: () => undefined
      }
    };
    try {
      saveBytes('test.txt', base64, 'text/plain');
      expect(clicked).toBe(true);
      expect(downloadedName).toBe('test.txt');
      expect(capturedBlob).not.toBeNull();
      const text = await (capturedBlob as unknown as Blob).text();
      expect(text).toBe(sample);
    } finally {
      (globalThis as any).document = originalDocument;
      (globalThis as any).URL = originalUrl;
    }
  });

  it('lineCount counts newlines correctly and handles empty/large strings', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('single line')).toBe(1);
    expect(lineCount('a\nb\nc\n')).toBe(4);
    expect(lineCount('a\r\nb\r\n')).toBe(3);
    expect(lineCount('line 1\nline 2')).toBe(2);
    const big = 'x\n'.repeat(1000);
    expect(lineCount(big)).toBe(1001);
  });

  it('moveTreeFocus performs roving tabindex update and handles special path characters safely', () => {
    const createRow = (key: string, tabindex = '-1') => {
      const attributes = new Map<string, string>([
        ['data-at-terminal-sftp-row', key],
        ['tabindex', tabindex]
      ]);
      const el: any = {
        getAttribute(name: string) {
          return attributes.get(name) ?? null;
        },
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
        },
        removeAttribute(name: string) {
          attributes.delete(name);
        },
        focused: false,
        focus() {
          this.focused = true;
        }
      };
      return el;
    };

    const row1 = createRow('/home/user/a.txt', '0');
    const row2 = createRow('/home/user/b.txt', '-1');
    const rowSpecial = createRow('/home/user/weird "quotes" [brackets].txt', '-1');

    const allRows = [row1, row2, rowSpecial];
    const tree: any = {
      getAttribute: (k: string) => (k === 'role' ? 'tree' : null),
      closest: (sel: string) => (sel === '[role="tree"]' ? tree : null),
      querySelector: (selector: string) => {
        if (selector === '[tabindex="0"]') {
          return allRows.find((r) => r.getAttribute('tabindex') === '0') ?? null;
        }
        const match = /^\[data-at-terminal-sftp-row="([\s\S]*)"\]$/.exec(selector);
        if (match) {
          const rawKey = match[1].replace(/\\(["\\])/g, '$1');
          return allRows.find((r) => r.getAttribute('data-at-terminal-sftp-row') === rawKey) ?? null;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector === '[data-at-terminal-sftp-row]') return allRows;
        return [];
      }
    };

    moveTreeFocus(tree, '/home/user/b.txt');
    expect(row1.getAttribute('tabindex')).toBe('-1');
    expect(row1.getAttribute('data-at-terminal-sftp-focus')).toBeNull();
    expect(row2.getAttribute('tabindex')).toBe('0');
    expect(row2.getAttribute('data-at-terminal-sftp-focus')).toBe('true');
    expect(row2.focused).toBe(true);

    moveTreeFocus(tree, '/home/user/weird "quotes" [brackets].txt');
    expect(row2.getAttribute('tabindex')).toBe('-1');
    expect(rowSpecial.getAttribute('tabindex')).toBe('0');
    expect(rowSpecial.focused).toBe(true);

    // Test querySelector syntax error recovery: querySelector throws, fallback kicks in
    const throwingTree = {
      ...tree,
      querySelector: (selector: string) => {
        if (selector === '[tabindex="0"]') return rowSpecial;
        throw new Error('Invalid selector syntax');
      }
    };
    moveTreeFocus(throwingTree, '/home/user/a.txt');
    expect(rowSpecial.getAttribute('tabindex')).toBe('-1');
    expect(row1.getAttribute('tabindex')).toBe('0');
    expect(row1.focused).toBe(true);
  });
});

/**
 * The real stylesheet bytes, read from disk: vitest stubs CSS imports to empty
 * strings, and these assertions are about the reused sheets' actual content.
 */
function readRealSources(): { xterm: string; terminal: string; serverForm: string } {
  const repoRoot = process.cwd();
  return {
    xterm: readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8'),
    terminal: readFileSync(join(repoRoot, 'webview', 'terminal', 'index.css'), 'utf8'),
    serverForm: readFileSync(join(repoRoot, 'webview', 'server-form', 'index.css'), 'utf8')
  };
}