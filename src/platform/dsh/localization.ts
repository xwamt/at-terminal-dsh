import type { Localization, TranslationArgs } from '../../core/ports';

/**
 * The dsh implementation of the `Localization` port.
 *
 * ## Why the substitution rules are copied from the VS Code side instead of invented
 *
 * `src/i18n/t.ts` is the repo's only runtime-copy entry point, and it forwards
 * straight into this port (`platform().localization.t(...)`). On VS Code that port is
 * backed by `vscode.l10n.t(message, args)`, so `t()`'s observable behaviour *is* the
 * host's placeholder algorithm -- the tests in `test/i18n/t.test.ts` assert it
 * character by character (repeated placeholders all substituted, a supplied `0` /
 * `false` rendered rather than skipped, an unmatched placeholder left literal).
 * dsh has no `l10n` service to delegate to, so this adapter has to *reproduce* that
 * algorithm; approximating it (e.g. skipping falsy values, or treating a missing
 * argument as an empty string) would change what every call site renders on dsh only.
 *
 * The dictionary is keyed by the **English source message**, which is how VS Code's
 * l10n bundles are keyed too (the source string is the key, the `locale/*.json`
 * value is the translation) -- so `dsh/locale/*.json` can be handed to `messages`
 * unchanged.
 */
export function createDshLocalization(
  messages: Readonly<Record<string, string>> = {}
): Localization {
  return {
    t(message: string, args?: TranslationArgs): string {
      /**
       * `hasOwnProperty`, not `messages[message] ?? message`: the dictionary is a
       * plain object built from JSON, so an inherited name (`toString`,
       * `constructor`, ...) would otherwise resolve to a *function* and be returned
       * where a string is promised. The same guard protects a key such as
       * `__proto__`, which an object literal routes to the prototype setter and
       * silently loses -- the identical hazard `buildWebviewStrings` documents in
       * `src/i18n/t.ts`. A miss falls back to the source text, which is what an
       * untranslated locale looks like.
       */
      const template = Object.prototype.hasOwnProperty.call(messages, message)
        ? messages[message]
        : message;
      if (args === undefined) {
        return template;
      }
      /**
       * Every `{name}` occurrence is replaced, and an argument that is present is
       * rendered with `String(...)` -- so `{count}` with `0` and
       * `{rememberPassword}` with `false` come out as `0` / `false`, not as the
       * literal placeholder. An argument that is *absent* leaves the placeholder
       * alone rather than blanking it, matching the host: a missing translation
       * argument must stay visible as `{port}` instead of erasing the text.
       */
      return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
        Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : placeholder
      );
    }
  };
}
