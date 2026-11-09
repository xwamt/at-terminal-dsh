import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS host module
import { SETTINGS_FIELDS, createConfigSchema, readSettings } from '../../../dsh/settings.js';
// @ts-expect-error vendored plain-JS package with no type declarations
import schemastery from '../../../dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
import { createDshConfigReader } from '../../../src/platform/dsh/config';
import type { DshResolvedSettings, DshSettingAccessor } from '../../../src/platform/dsh/host';
import { resolveTerminalSettings } from '../../../src/terminal/terminalSettings';

/**
 * `ConfigReader` contract on the dsh side.
 *
 * The evidence a dsh config adapter is correct is not "it returns what we put in" but
 * "the domain consumer that reads it gets the same result as on VS Code". So the first
 * block drives the *real* consumer (`resolveTerminalSettings`, the only reader of the
 * `sshManager` section) rather than the section itself.
 */

function accessor(get: () => unknown): DshSettingAccessor {
  return { get };
}

function settingsOf(values: Record<string, unknown>): DshResolvedSettings {
  const record: Record<string, DshSettingAccessor | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    record[key] = accessor(() => value);
  }
  return record;
}

describe('createDshConfigReader', () => {
  it('feeds the real sshManager consumer, with defaults for every absent field', () => {
    const section = createDshConfigReader(
      settingsOf({ scrollback: 25000, terminalFontSize: 18, semanticHighlight: false })
    ).getSection('sshManager');

    // The exact reads `resolveTerminalSettings` performs, one per field it resolves.
    expect(section.get('scrollback', 10000)).toBe(25000);
    expect(section.get('terminalFontSize', 14)).toBe(18);
    expect(section.get('semanticHighlight', true)).toBe(false);
    expect(section.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace')).toBe(
      'Cascadia Code, Menlo, monospace'
    );
    expect(section.get('idleDisconnectMinutes', 60)).toBe(60);
    expect(section.get('zebraStripes', false)).toBe(false);

    // And the same section through the consumer itself: the resolved shape the terminal
    // is built from must match the VS Code path field for field.
    expect(resolveTerminalSettings(section)).toEqual({
      scrollback: 25000,
      fontSize: 18,
      fontFamily: 'Cascadia Code, Menlo, monospace',
      semanticHighlight: false,
      idleDisconnectMinutes: 60,
      zebraStripes: false,
      encoding: 'utf-8'
    });
  });

  it('a configured false / 0 is a value, not an absent setting', () => {
    const section = createDshConfigReader(
      settingsOf({ semanticHighlight: false, idleDisconnectMinutes: 0 })
    ).getSection('sshManager');

    // `false` and `0` must survive the `undefined` check; returning the default for them
    // would make the settings form's own toggles impossible to persist.
    expect(section.get('semanticHighlight', true)).toBe(false);
    expect(section.get('idleDisconnectMinutes', 60)).toBe(0);
  });

  it('an accessor whose get() resolves to undefined falls back to the default', () => {
    const section = createDshConfigReader({
      // A `.volatile()` field declared with no default resolves this way.
      scrollback: accessor(() => undefined)
    }).getSection('sshManager');

    expect(section.get('scrollback', 10000)).toBe(10000);
  });

  it('re-reads the accessor on every get, so a live settings edit is visible immediately', () => {
    let value: unknown = 10000;
    const section = createDshConfigReader({
      scrollback: accessor(() => value)
    }).getSection('sshManager');

    expect(section.get('scrollback', 1000)).toBe(10000);

    // Same section object, no rebuild: dsh swaps the resolved value behind the stable
    // accessor, and the terminal must see the new value on its next read.
    value = 5000;
    expect(section.get('scrollback', 1000)).toBe(5000);
  });

  it('re-indexes the settings record on every get, so an accessor added later is honoured', () => {
    const settings: Record<string, DshSettingAccessor | undefined> = {};
    const section = createDshConfigReader(settings).getSection('sshManager');

    expect(section.get('terminalFontSize', 14)).toBe(14);

    settings.terminalFontSize = accessor(() => 22);
    expect(section.get('terminalFontSize', 14)).toBe(22);
  });

  it('rejects any section other than sshManager, naming the section it received', () => {
    const reader = createDshConfigReader({});

    // Not a silent empty section: a wrong/typo'd section must fail loudly rather than
    // hand back all-defaults that look correct.
    expect(() => reader.getSection('sftp')).toThrow(/sftp/);
    expect(() => reader.getSection('sshmanager')).toThrow(/sshmanager/);
    expect(() => reader.getSection('')).toThrow(/unsupported configuration section/);
  });

  it('renders no settings field that nothing reads', () => {
    // Three fields had drifted into "editable but inert". Two are gone rather than kept as
    // decoration: a form input that no code reads takes a change and answers with silence.
    // `keepAliveInterval` is the one that hid from a substring search, because the same name
    // is also the per-server field in src/config/schema.ts.
    const keys = SETTINGS_FIELDS.map((field: { key: string }) => field.key);
    expect(keys).not.toContain('sessionLogDirectory');
    expect(keys).not.toContain('keepAliveInterval');
    // The one that stayed got wired instead: SshSession applies it (test/ssh/SshSession.idle.test.ts).
    expect(keys).toContain('idleDisconnectMinutes');
  });
});

/**
 * R2's settings surface.
 *
 * `sftpWriteGuard` is not a UI preference like the terminal fields: it decides whether an
 * agent write is refused. The closed-set pattern is the write guard, so it is exercised
 * through the real schemastery instance rather than only inspected as metadata.
 */
describe('the agent SFTP write guard setting', () => {
  it('is a closed set of three modes with observe as the default', () => {
    const field = SETTINGS_FIELDS.find((entry: { key: string }) => entry.key === 'sftpWriteGuard') as
      | { type: string; pattern?: string; default: unknown }
      | undefined;
    expect(field).toMatchObject({
      type: 'string',
      pattern: '^(off|observe|strict)$',
      default: 'observe'
    });
    // `observe` must be the default: `strict` would break every existing agent write that
    // never read first, and `off` would silently drop the protection this release adds.
    expect(readSettings({}).sftpWriteGuard).toBe('observe');
    expect(readSettings({ sftpWriteGuard: accessor(() => 'strict') }).sftpWriteGuard).toBe('strict');

    // A1's opt-in is off by default: enabling multi-file patch must be a deliberate action.
    expect(readSettings({}).enableApplyPatch).toBe(false);
    expect(readSettings({ enableApplyPatch: accessor(() => true) }).enableApplyPatch).toBe(true);
  });

  it('accepts exactly off/observe/strict through the real schema', () => {
    const schema = createConfigSchema(schemastery);

    for (const value of ['off', 'observe', 'strict']) {
      expect(schema({ sftpWriteGuard: value }).sftpWriteGuard.get()).toBe(value);
    }
    // A typo like "sometimes" must be rejected at edit() time, not silently normalised.
    expect(() => schema({ sftpWriteGuard: 'sometimes' })).toThrow();
  });
});
