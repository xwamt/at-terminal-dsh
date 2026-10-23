/**
 * Which language the approval dialogs speak.
 *
 * The dialogs are built on the **Host** side (`confirmation.ts` composes the reason and the
 * body of every approval card), so the client's UI language is not visible here — it lives in
 * the renderer's local storage. What *is* visible is the operating system's language, which is
 * what "跟随系统语言" means: a Chinese macOS shows Chinese dialogs without the user having to
 * find a setting.
 *
 * Three sources, in order, each with a reason to exist:
 *
 * 1. `AT_TERMINAL_LANG` / `DSH_LANG` — an explicit override, so a test or a support case can
 *    force a language without changing the machine.
 * 2. `defaults read -g AppleLocale` on macOS — the authoritative system preference. `Intl` in
 *    the Host process reports whatever ICU was initialised with, and an Electron app started
 *    from a shell that exports `LANG=C.UTF-8` reports `en-US` while the system is `zh_CN`
 *    (measured on this machine: `Intl` said `en-US`, `AppleLocale` said `zh_CN`).
 * 3. `Intl.DateTimeFormat().resolvedOptions().locale`, then `LC_ALL` / `LANG` — the portable
 *    fallbacks for Linux, and for a macOS where `defaults` is unavailable.
 *
 * Nothing here throws: an approval dialog in the wrong language is a nuisance, an approval
 * dialog that fails to render is a broken plugin.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The values the `dialogLanguage` setting accepts. `auto` follows the system. */
export const DIALOG_LANGUAGES = Object.freeze(['auto', 'zh-CN', 'en'])

/** Language tag → the dictionary file shipped in `locale/`. */
const DICTIONARIES = Object.freeze({
  'zh-CN': 'zh-CN.json',
  en: 'en.json'
})

/**
 * The operating system's language tag, best effort.
 *
 * @returns {string} Something like `zh-CN`, `zh-Hans-CN` or `en-US`; `en` when nothing answers.
 */
export function systemLanguageTag() {
  // Both names, first non-empty: `??` alone would stop at an `AT_TERMINAL_LANG` that a shell
  // exported as `""` and never consider `DSH_LANG`.
  for (const name of ['AT_TERMINAL_LANG', 'DSH_LANG']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }

  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      // `AppleLocale` uses underscores (`zh_CN`); every other source uses hyphens.
      if (raw !== '') return raw.replace(/_/g, '-')
    } catch {
      // `defaults` missing or refused: fall through to the portable sources.
    }
  }

  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale
    if (typeof tag === 'string' && tag !== '') return tag
  } catch {
    // A runtime without ICU: fall through.
  }

  const env = process.env.LC_ALL ?? process.env.LANG ?? ''
  return env.trim() === '' ? 'en' : env.trim()
}

/**
 * The language to render dialogs in.
 *
 * @param {unknown} setting The `dialogLanguage` setting (`auto` / `zh-CN` / `en`).
 * @param {string} [tag] The system tag; injected by tests.
 * @returns {'zh-CN' | 'en'} A language that has a dictionary.
 */
export function resolveDialogLanguage(setting, tag = systemLanguageTag()) {
  if (setting === 'zh-CN' || setting === 'en') return setting
  // `zh`, `zh-CN`, `zh-Hans-CN`, `zh_CN` all mean "the user reads Chinese". The dictionary is
  // Simplified, which is the safer wrong guess for a zh reader than English is.
  // `\b` would miss `zh_CN` (`_` is a word character), hence the explicit separators.
  return /^zh(?:[-_]|$)/i.test(tag) ? 'zh-CN' : 'en'
}

/**
 * Load the dictionary for one language.
 *
 * The dictionary is keyed by the **English source string** — the same convention as VS Code's
 * l10n bundles, so `dsh/locale/*.json` can be handed to the localization port unchanged. A
 * missing or unreadable file yields `{}`, which makes `t()` the identity: English.
 *
 * @param {string} bundlePath The bundle directory (holds `locale/`).
 * @param {'zh-CN' | 'en'} language
 * @returns {Record<string, string>}
 */
export function loadDialogMessages(bundlePath, language) {
  const file = join(bundlePath, 'locale', DICTIONARIES[language] ?? DICTIONARIES.en)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    /** Only string values are copy; `meta` carries the market listing's title and description. */
    const messages = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') messages[key] = value
    }
    return messages
  } catch {
    return {}
  }
}
