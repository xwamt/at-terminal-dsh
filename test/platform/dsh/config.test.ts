import { describe, expect, it } from 'vitest';
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

    // The exact eight reads `resolveTerminalSettings` performs (src/terminal/terminalSettings.ts:30-37).
    expect(section.get('scrollback', 10000)).toBe(25000);
    expect(section.get('terminalFontSize', 14)).toBe(18);
    expect(section.get('semanticHighlight', true)).toBe(false);
    expect(section.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace')).toBe(
      'Cascadia Code, Menlo, monospace'
    );
    expect(section.get('idleDisconnectMinutes', 60)).toBe(60);
    expect(section.get('zebraStripes', false)).toBe(false);
    expect(section.get('sessionLogDirectory', '')).toBe('');

    // And the same section through the consumer itself: the resolved shape the terminal
    // is built from must match the VS Code path field for field.
    expect(resolveTerminalSettings(section)).toEqual({
      scrollback: 25000,
      fontSize: 18,
      fontFamily: 'Cascadia Code, Menlo, monospace',
      semanticHighlight: false,
      idleDisconnectMinutes: 60,
      zebraStripes: false,
      sessionLogDirectory: '',
      encoding: 'utf-8'
    });
  });

  it('a configured false / 0 is a value, not an absent setting', () => {
    const section = createDshConfigReader(
      settingsOf({ semanticHighlight: false, idleDisconnectMinutes: 0, sessionLogDirectory: '' })
    ).getSection('sshManager');

    // `false` and `0` must survive the `undefined` check; returning the default for them
    // would make the settings form's own toggles impossible to persist.
    expect(section.get('semanticHighlight', true)).toBe(false);
    expect(section.get('idleDisconnectMinutes', 60)).toBe(0);
    expect(section.get('sessionLogDirectory', '/var/log')).toBe('');
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
});
