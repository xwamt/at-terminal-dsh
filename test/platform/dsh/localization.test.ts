import { describe, expect, it } from 'vitest';
import { t } from '../../../src/i18n/t';
import { createDshLocalization } from '../../../src/platform/dsh/localization';

/**
 * `Localization` contract on the dsh side.
 *
 * The last block is the important one: it asserts the dsh adapter against `t()` --
 * the repo's single runtime-copy entry point, whose observable behaviour
 * (`test/i18n/t.test.ts`) is the VS Code host's placeholder algorithm. If the two ever
 * disagree, one platform renders text the other cannot.
 */

describe('createDshLocalization', () => {
  it('resolves a message through the dictionary and falls back to the source text', () => {
    const localization = createDshLocalization({
      'Trust SSH host {host}:{port}?': '信任主机 {host}:{port}？'
    });

    expect(localization.t('Trust SSH host {host}:{port}?', { host: 'example.com', port: 22 })).toBe(
      '信任主机 example.com:22？'
    );
    // An untranslated message stays in its source form, exactly like a missing l10n entry.
    expect(localization.t('No active SSH terminal')).toBe('No active SSH terminal');
  });

  it('defaults to an empty dictionary when the host half passes none', () => {
    const localization = createDshLocalization();

    expect(localization.t('Configure SSH')).toBe('Configure SSH');
    expect(localization.t('Delete {path}?', { path: '/tmp/app.log' })).toBe('Delete /tmp/app.log?');
  });

  it('substitutes every occurrence and renders falsy arguments instead of skipping them', () => {
    const localization = createDshLocalization();

    expect(localization.t('{path} -> {path}', { path: 'file.txt' })).toBe('file.txt -> file.txt');
    expect(
      localization.t('{count} items, rememberPassword: {rememberPassword}', {
        count: 0,
        rememberPassword: false
      })
    ).toBe('0 items, rememberPassword: false');
  });

  it('leaves a placeholder with no matching argument literal', () => {
    const localization = createDshLocalization();

    expect(localization.t('Host at {host} ({port})', { host: '127.0.0.1' })).toBe(
      'Host at 127.0.0.1 ({port})'
    );
  });

  it('treats an inherited dictionary name as a miss, not as a translation', () => {
    const localization = createDshLocalization({});

    // A plain-object lookup (`messages[message] ?? message`) would return the inherited
    // `toString` function here, so `t()` would hand a function to a string consumer.
    expect(localization.t('toString')).toBe('toString');
    expect(localization.t('constructor')).toBe('constructor');
  });

  it('matches src/i18n/t.ts (the VS Code-backed port) character for character', () => {
    const localization = createDshLocalization();

    // Same inputs through both texts: the dsh adapter and the host-backed `t()` must
    // produce identical strings, placeholders and all.
    const cases: Array<[string, Record<string, string | number | boolean> | undefined]> = [
      ['Delete {path}?', { path: '/tmp/app.log' }],
      ['Configure SSH', undefined],
      ['Configure SSH', { unused: 'ignored' }],
      ['{path} -> {path}', { path: 'file.txt' }],
      ['{count} items, rememberPassword: {rememberPassword}', { count: 0, rememberPassword: false }],
      ['Host at {host} ({port})', { host: '127.0.0.1' }],
      ['Configure: {label}', undefined]
    ];

    for (const [message, args] of cases) {
      expect(localization.t(message, args)).toBe(args === undefined ? t(message) : t(message, args));
    }
  });
});
