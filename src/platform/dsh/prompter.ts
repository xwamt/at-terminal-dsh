import type { CancellationToken } from '../../core/cancellation';
import type {
  FileDialogOptions,
  InputBoxOptions,
  Prompter,
  QuickPickOptions,
  UriLike
} from '../../core/ports';
import type { DshLogger } from './host';

/**
 * The dsh implementation of the `Prompter` port.
 *
 * Same constraint as `notifier.ts` — the M2 Host half is headless — but the
 * consequence is sharper, because every method here can only ever *ask a question*:
 *
 * - `showInputBox` returning `undefined` means "the user cancelled". That is the safe
 *   branch at every call site: `AssetCommands` aborts the import loop, and
 *   `VscodeKeyboardInteractivePrompt` treats it as a cancelled authentication. The
 *   alternative — returning `''` — would send an empty password to a remote host and
 *   get a real authentication failure blamed on the server.
 * - `showQuickPick` / the file dialogs returning `undefined` likewise means "nobody
 *   chose", which is what a headless host can honestly claim.
 *
 * Every call is logged with its prompt text so a headless run is diagnosable: an
 * operator reading the log can tell that the plugin stopped because it needed input
 * rather than because it hit a bug. Prompt *answers* are never logged — the
 * `password: true` boxes exist precisely because the answer is a secret.
 *
 * `respond` is the seam the M3/M4 Client half fills, exactly like the notifier's. It
 * is deliberately not defaulted, because a default answer is a fabricated user.
 */

export interface DshPromptResponder {
  /** `multi` is true for the `canPickMany` overload, so the answer shape is unambiguous. */
  quickPick?(
    request: { items: readonly string[]; options?: QuickPickOptions },
    multi: boolean
  ): Promise<string | string[] | undefined>;
  inputBox?(request: { options?: InputBoxOptions }): Promise<string | undefined>;
  openDialog?(request: { options: FileDialogOptions }): Promise<UriLike[] | undefined>;
  saveDialog?(request: { options: FileDialogOptions }): Promise<UriLike | undefined>;
}

export interface DshPrompterDeps {
  readonly logger: DshLogger;
  /**
   * Filled by the Client half once a real UI exists. Each method's answer type is the
   * port's own, so a responder cannot answer in a shape the caller does not expect.
   */
  readonly respond?: DshPromptResponder;
}

export function createDshPrompter({ logger, respond }: DshPrompterDeps): Prompter {
  /**
   * The port keeps the host's **dual overloads** on `showQuickPick` — the multi-value
   * form returns `string[] | undefined`, the single form `string | undefined` — because
   * both shapes have real call sites (`AssetCommands` uses both). A single
   * implementation therefore has to be declared as two overloads and then narrowed,
   * which is why this is a standalone function rather than a method in the object
   * literal below.
   */
  function showQuickPick(
    items: readonly string[],
    options: QuickPickOptions & { canPickMany: true },
    token?: CancellationToken
  ): Promise<string[] | undefined>;
  function showQuickPick(
    items: readonly string[],
    options?: QuickPickOptions,
    token?: CancellationToken
  ): Promise<string | undefined>;
  async function showQuickPick(
    items: readonly string[],
    options?: QuickPickOptions,
    _token?: CancellationToken
  ): Promise<string | string[] | undefined> {
    const multi = options?.canPickMany === true;
    logger.info(
      'AT Terminal: quick pick requested (%s) — %s',
      options?.title ?? '(untitled)',
      items.join(' | ')
    );
    const answer = await respond?.quickPick?.({ items, options }, multi);
    if (answer === undefined) {
      return undefined;
    }
    // Narrow rather than trust: a responder that answers a multi-select with one string
    // is a bug, and silently coercing it here would hide one.
    return multi ? (Array.isArray(answer) ? answer : [answer]) : Array.isArray(answer) ? answer[0] : answer;
  }

  return {
    showQuickPick,

    async showInputBox(options?: InputBoxOptions, _token?: CancellationToken): Promise<string | undefined> {
      logger.info('AT Terminal: input requested — %s', options?.prompt ?? options?.title ?? '(untitled)');
      return await respond?.inputBox?.({ options });
    },

    async showOpenDialog(options: FileDialogOptions): Promise<UriLike[] | undefined> {
      logger.info('AT Terminal: open dialog requested — %s', options.title ?? '(untitled)');
      return await respond?.openDialog?.({ options });
    },

    async showSaveDialog(options: FileDialogOptions): Promise<UriLike | undefined> {
      logger.info('AT Terminal: save dialog requested — %s', options.title ?? '(untitled)');
      return await respond?.saveDialog?.({ options });
    }
  };
}
