import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The directive belongs on the line TS reports, which for a multi-line import is the
// `from '…'` line — not the statement's first line.
import {
  DIALOG_LANGUAGES,
  loadDialogMessages,
  resolveDialogLanguage,
  systemLanguageTag
  // @ts-expect-error plain-JS host modules
} from '../../dsh/locale.js';

/**
 * The dialog language: which language an approval card is written in, and the guard that the
 * dictionary actually covers what the code asks for.
 *
 * The dialogs are composed on the Host, so the UI language the renderer knows is invisible here.
 * What is available is the operating system's language, and that distinction is the whole design
 * — a Chinese macOS shows Chinese approval cards without the user finding a setting.
 *
 * The last test is the one that will earn its keep: it reads every `copy('…')` literal out of the
 * source and requires the Chinese dictionary to have a line for it. Copy drifts silently — that is
 * the entire reason `test/dsh/copy-i18n.test.ts` exists — and a new approval string added without
 * a translation would otherwise surface as English inside an otherwise Chinese dialog, months later.
 */

const HERE = process.cwd();
const BUNDLE = join(HERE, 'dsh');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolving the dialog language', () => {
  it('follows the system tag when the setting is auto', () => {
    expect(resolveDialogLanguage('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveDialogLanguage('auto', 'zh_CN')).toBe('zh-CN');
    expect(resolveDialogLanguage('auto', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveDialogLanguage('auto', 'en-US')).toBe('en');
    expect(resolveDialogLanguage('auto', 'de-DE')).toBe('en');
  });

  it('lets the setting win over the system', () => {
    expect(resolveDialogLanguage('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveDialogLanguage('en', 'zh-CN')).toBe('en');
  });

  it('treats anything unrecognised as auto rather than failing', () => {
    // The schema rejects these at write time; a value that got in another way (a hand-edited
    // profile) must still produce a dialog.
    for (const value of ['fr', '', undefined, null, 42, {}]) {
      expect(resolveDialogLanguage(value, 'zh-CN')).toBe('zh-CN');
    }
  });

  it('reads the environment override before asking the system', () => {
    vi.stubEnv('AT_TERMINAL_LANG', 'zh-CN');
    expect(systemLanguageTag()).toBe('zh-CN');
    vi.stubEnv('AT_TERMINAL_LANG', '');
    vi.stubEnv('DSH_LANG', 'en-GB');
    expect(systemLanguageTag()).toBe('en-GB');
  });

  it('accepts exactly the three documented values', () => {
    expect([...DIALOG_LANGUAGES]).toEqual(['auto', 'zh-CN', 'en']);
  });
});

describe('loading the dictionary', () => {
  it('translates an approval string', () => {
    const messages = loadDialogMessages(BUNDLE, 'zh-CN');
    expect(messages['Allow Once']).toBe('仅允许本次');
    expect(messages['Run remote command on {server} ({host})?']).toContain('{server}');
  });

  it('keeps the market metadata out of the copy table', () => {
    const messages = loadDialogMessages(BUNDLE, 'zh-CN');
    // `meta` is an object, not a string: a `t('meta')` must fall back to English rather than
    // render `[object Object]` inside a dialog.
    expect(Object.values(messages).every((value) => typeof value === 'string')).toBe(true);
    expect(messages.meta).toBeUndefined();
  });

  it('answers an empty dictionary rather than throwing when the file is missing', () => {
    expect(loadDialogMessages(join(HERE, 'no-such-bundle'), 'zh-CN')).toEqual({});
  });
});

describe('dictionary coverage', () => {
  /** Every `copy('literal')` / `copy(\n  'literal')` in the sources this bundle ships. */
  function copyLiterals(sources: string[]): Set<string> {
    const literals = new Set<string>();
    const pattern = /copy\(\s*'((?:[^'\\]|\\.)*)'/g;
    for (const source of sources) {
      for (const match of source.matchAll(pattern)) {
        // `\\'` never appears in this copy; unescaping backslashes would corrupt `\n` inside a
        // two-line key, and nothing here has one.
        if (!match[1].includes('\\')) literals.add(match[1]);
      }
    }
    return literals;
  }

  function sourceFiles(directory: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full));
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('has a Chinese line for every copy(...) literal', () => {
    const sources = [
      ...sourceFiles(join(HERE, 'src/platform/dsh')),
      ...sourceFiles(join(HERE, 'src/utils')),
      join(HERE, 'src/i18n/copy.ts')
    ].map((file) => readFileSync(file, 'utf8'));

    const literals = copyLiterals(sources);
    expect(literals.size, 'the scan found no copy() literals at all').toBeGreaterThan(10);

    const messages = loadDialogMessages(BUNDLE, 'zh-CN');
    const missing = [...literals].filter((literal) => !(literal in messages));
    expect(missing, `untranslated dialog copy: ${missing.join(' | ')}`).toEqual([]);
  });

  it('has no Chinese line that nothing asks for', () => {
    // The other direction: a key nobody uses is dead copy that will drift out of date. `meta` and
    // the `yes` / `no` pair are composed at runtime, so they are excluded by name.
    const sources = [
      ...sourceFiles(join(HERE, 'src/platform/dsh')),
      ...sourceFiles(join(HERE, 'src/utils')),
      join(HERE, 'src/i18n/copy.ts')
    ].map((file) => readFileSync(file, 'utf8'));
    const literals = copyLiterals(sources);

    const messages = loadDialogMessages(BUNDLE, 'zh-CN');
    const composed = new Set(['yes', 'no']);
    const unused = Object.keys(messages).filter((key) => !literals.has(key) && !composed.has(key));
    expect(unused, `dictionary lines nothing reads: ${unused.join(' | ')}`).toEqual([]);
  });
});
