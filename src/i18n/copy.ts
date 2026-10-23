import type { TranslationArgs } from '../core';
import { t } from './t';

/**
 * `t()` for copy that is composed **outside** a platform callback — approval cards, log lines,
 * anything a test may call on its own.
 *
 * `t()` reads `platform().localization`, which throws until `setPlatform()` has run. That is the
 * right contract for the extension host (a missing platform is a wiring bug worth hearing
 * about), but it is the wrong failure for dialog copy: an approval card is drawn precisely when
 * something is about to happen, so a throw there reads as "the write was refused" with no
 * reason shown. A missing platform therefore degrades to the English source string, which is
 * also the dictionary key — so "not translated" and "no platform" look the same, and neither
 * one loses the dialog.
 *
 * The fallback repeats the port's placeholder algorithm (`{name}` replaced only when the
 * argument is present) rather than blanking unknown placeholders: a card that says `{port}`
 * still tells the reader what is missing, where an empty string would hide it.
 */
export function copy(message: string, args?: TranslationArgs): string {
  try {
    return args === undefined ? t(message) : t(message, args);
  } catch {
    if (args === undefined) return message;
    return message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
      Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : placeholder
    );
  }
}
