/**
 * AT Terminal's platform-agnostic port layer.
 *
 * Design rule: **every port is derived backwards from a real consumption site**, not
 * declared first and then given a place to be used. The "covered host symbols" and "real
 * consumption sites" recorded in the comments are the evidence; a capability with no
 * consumption site is never included. Host adapters live in `src/platform/**`; this
 * directory never references a host module, nor even its literal name.
 *
 * Reverse constraint: `src/core` may only depend on **standard-library types**
 * (`Thenable`, `Promise`) and the primitives in this directory (`Event` / `Disposable` /
 * `CancellationToken`), and must not import domain directories (`src/sftp`, `src/ssh`,
 * `src/config`, ...). Compatibility with the existing seams is asserted in both
 * directions at compile time by `test/core/domain-seam-compat.test.ts`.
 *
 * Citation rule: this layer was derived from the VS Code variant of the extension, so the
 * "real consumption sites" below name files from **that** repository (`src/extension.ts`,
 * `src/webview/**`, `src/mcp/**`, several `src/sftp/**` sources). Those names stay — they
 * are the evidence for why a port exists — but their **line numbers were removed**: the
 * files are not in this repository, so a `:123` pointer sends a reader nowhere.
 * `scripts/verify-kernel-seam.mjs` fails on any new `path:line` citation of a file that
 * does not exist here.
 */

import type { CancellationToken } from './cancellation';

export type Thenable<T> = PromiseLike<T>;

// ---------------------------------------------------------------------------
// UriService - covers the host Uri
// ---------------------------------------------------------------------------

/**
 * The URI view the domain layer actually reads (the other Uri members are not exposed, to
 * avoid leaking the host shape in).
 */
export interface UriLike {
  readonly scheme: string;
  readonly fsPath: string;
  toString(): string;
}

/** Matches a subset of the host's `UriComponents` fields. */
export interface UriComponents {
  scheme: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

/**
 * Covers the host `Uri` static usages:
 * `Uri.file` (src/assets/AssetCommands.ts:31, src/extension.ts),
 * `Uri.joinPath` (src/mcp/hubSync.ts, src/sftp/SftpEditSessionManager.ts,
 * src/webview/TerminalPanel.ts), `Uri.parse`
 * (src/sftp/SftpDragAndDropController.ts), `Uri.from` (src/sftp/SftpPreview.ts),
 * plus `instanceof Uri` (src/sftp/SftpEditSessionManager.ts) and the `uri.scheme`
 * check (src/extension.ts, src/sftp/SftpEditSessionManager.ts).
 */
export interface UriService {
  file(fsPath: string): UriLike;
  joinPath(base: UriLike, ...segments: string[]): UriLike;
  parse(value: string): UriLike;
  from(components: UriComponents): UriLike;
  isUri(value: unknown): value is UriLike;
}

// ---------------------------------------------------------------------------
// Notifier - covers window's notification and progress parts + ProgressLocation
// ---------------------------------------------------------------------------

/** Matches a subset of the host's `MessageOptions` fields. */
export interface MessageOptions {
  modal?: boolean;
  detail?: string;
}

/**
 * Matches a subset of the host's `ProgressOptions` fields; `location` is narrowed to the
 * two values actually used.
 */
export interface ProgressOptions {
  location?: 'notification' | 'window';
  title?: string;
  cancellable?: boolean;
}

/** Matches a subset of the host's `Progress<{increment?, message?}>` fields. */
export interface ProgressReporter {
  report(value: { increment?: number; message?: string }): void;
}

/**
 * Covers the following real consumption sites:
 * - `window.showInformationMessage` (src/extension.ts,
 *   src/agent/AgentToolService.ts:111, src/assets/AssetCommands.ts:65,135 -- 14 sites in total)
 * - `window.showWarningMessage` (src/extension.ts,
 *   src/sftp/SftpDragAndDropController.ts, src/sftp/SftpEditSessionManager.ts,
 *   src/agent/SftpWriteAuthorizer.ts:171,181,187, src/agent/AgentToolService.ts:87 -- 15 sites in total)
 * - `window.showErrorMessage` (src/extension.ts,
 *   src/utils/notifications.ts:48, src/assets/AssetCommands.ts:69,89,105,141,182 -- 12 sites in total)
 * - `window.withProgress` + `ProgressLocation.Notification`
 *   (src/utils/notifications.ts:20-31, src/sftp/VscodeTransferReporter.ts,
 *   src/sftp/SftpEditSessionManager.ts)
 *
 * The three show*Message methods keep their **dual overloads** (`(msg, ...actions)` and
 * `(msg, options, ...actions)`) because both forms have real call sites; collapsing them
 * into one would force callers to change semantics.
 */
export interface Notifier {
  showInformationMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showInformationMessage(
    message: string,
    options: MessageOptions,
    ...actions: string[]
  ): Promise<string | undefined>;
  showWarningMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showWarningMessage(
    message: string,
    options: MessageOptions,
    ...actions: string[]
  ): Promise<string | undefined>;
  showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showErrorMessage(
    message: string,
    options: MessageOptions,
    ...actions: string[]
  ): Promise<string | undefined>;
  withProgress<T>(
    options: ProgressOptions,
    task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Prompter - covers window's input/selection/file-dialog parts
// ---------------------------------------------------------------------------

export interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
  canPickMany?: boolean;
  ignoreFocusOut?: boolean;
}

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
}

/** The shared options shape for `showOpenDialog` / `showSaveDialog`. */
export interface FileDialogOptions {
  title?: string;
  defaultUri?: UriLike;
  canSelectFiles?: boolean;
  canSelectFolders?: boolean;
  canSelectMany?: boolean;
  openLabel?: string;
  filters?: Record<string, string[]>;
}

/**
 * Covers the following real consumption sites:
 * - `window.showInputBox` (src/extension.ts,
 *   src/ssh/VscodeKeyboardInteractivePrompt.ts, src/assets/AssetCommands.ts:96,169,173
 *   -- 11 sites in total)
 * - `window.showQuickPick` (single value src/extension.ts,
 *   src/assets/AssetCommands.ts:115; multi-value `canPickMany: true`
 *   src/assets/AssetCommands.ts:41)
 * - `window.showOpenDialog` (src/extension.ts, src/webview/ServerFormPanel.ts,
 *   src/assets/AssetCommands.ts:74 -- 6 sites in total)
 * - `window.showSaveDialog` (src/assets/AssetCommands.ts:30, src/extension.ts)
 */
export interface Prompter {
  showQuickPick(
    items: readonly string[],
    options: QuickPickOptions & { canPickMany: true },
    token?: CancellationToken
  ): Promise<string[] | undefined>;
  showQuickPick(
    items: readonly string[],
    options?: QuickPickOptions,
    token?: CancellationToken
  ): Promise<string | undefined>;
  showInputBox(options?: InputBoxOptions, token?: CancellationToken): Promise<string | undefined>;
  /**
   * The file dialogs **do not** take a token parameter: in the host 1.125 type
   * declarations `showOpenDialog(options?)` / `showSaveDialog(options?)` have no
   * cancellation-token argument, and a port never declares a capability the host cannot
   * fulfil.
   */
  showOpenDialog(options: FileDialogOptions): Promise<UriLike[] | undefined>;
  showSaveDialog(options: FileDialogOptions): Promise<UriLike | undefined>;
}

// ---------------------------------------------------------------------------
// ConfigReader - covers workspace.getConfiguration
// ---------------------------------------------------------------------------

/**
 * A readable view of one configuration section. Same shape as `ConfigurationLike`
 * (src/webview/TerminalPanel.ts).
 */
export interface ConfigSection {
  get<T>(key: string, defaultValue: T): T;
}

/**
 * Covers `workspace.getConfiguration('sshManager')`
 * (src/webview/TerminalPanel.ts, which via resolveTerminalSettings:605 reads 8
 * `sshManager.*` settings). Deliberately kept "thin": the real default-value/valid-value
 * logic stays on the domain side; the port only abstracts away "some configuration
 * section".
 */
export interface ConfigReader {
  getSection(section: string): ConfigSection;
}

// ---------------------------------------------------------------------------
// StateStore / SecretStore - covers the host context's globalState / secrets
// ---------------------------------------------------------------------------

/**
 * Key-value state store. Field-for-field identical to the existing `ExtensionMemento`
 * (src/config/ConfigManager.ts:7) and `HostKeyMemento` (src/ssh/HostKeyStore.ts:13), and an
 * assignable subset of the host Memento; will later correspond to dsh's
 * `ctx.storageDomain`.
 *
 * Real consumption sites: the server list (src/config/ConfigManager.ts:25,34,53,64) and
 * the host key trust records (src/ssh/HostKeyStore.ts:50,60,77).
 */
export interface StateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Credential store. Field-for-field identical to the existing `SecretStore`
 * (src/config/ConfigManager.ts:12) -- **the method is named `store`, not `set`**, because
 * the real contract is `store` (src/config/ConfigManager.ts:55,58). Will later correspond
 * to dsh's `ctx.credentials`.
 *
 * Real consumption sites: server passwords / private-key passphrases
 * (src/config/ConfigManager.ts:55-58,68-69,73,77).
 */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

// ---------------------------------------------------------------------------
// Portification of existing seams (reused, not re-invented)
// ---------------------------------------------------------------------------

/** Same shape as the existing `TransferProgress` (src/sftp/TransferService.ts:3). */
export interface TransferProgress {
  report(event: { transferredBytes: number; totalBytes: number }): void;
}

/**
 * Field-for-field identical to the existing `TransferReporter`
 * (src/sftp/TransferService.ts:9). The existing implementation
 * `src/sftp/VscodeTransferReporter.ts` satisfies this port directly.
 *
 * Real consumption sites: src/sftp/TransferService.ts:37-58 (every SFTP transfer) and the
 * reporter injection in src/sftp/SftpManager.ts.
 */
export interface TransferReporter {
  withProgress<T>(label: string, job: (progress: TransferProgress) => Promise<T>): Promise<T>;
  notifySuccess(message: string): Promise<void>;
  notifyFailure(message: string): Promise<void>;
}

/** Same shape as the existing `KeyboardInteractivePromptField` (src/ssh/KeyboardInteractive.ts:1). */
export interface KeyboardInteractiveField {
  prompt: string;
  /** false means a password-like field; the UI must mask the input. */
  echo: boolean;
}

/** Same shape as the existing `KeyboardInteractiveRequest` (src/ssh/KeyboardInteractive.ts:7). */
export interface KeyboardInteractiveRequest {
  name: string;
  instructions: string;
  prompts: KeyboardInteractiveField[];
}

/**
 * Same shape as the existing `KeyboardInteractivePrompt`
 * (src/ssh/KeyboardInteractive.ts:19): returns the answers in prompt order, or
 * `undefined` if the user cancels. The existing implementation
 * `src/ssh/VscodeKeyboardInteractivePrompt.ts` satisfies this port directly.
 *
 * Real consumption sites: src/ssh/KeyboardInteractive.ts:50-89 (attachKeyboardInteractive
 * is wired on every connection path); a prompt-less background path must pass `undefined`
 * rather than popping up a dialog.
 */
export type KeyboardInteractivePrompter = (
  request: KeyboardInteractiveRequest
) => Promise<string[] | undefined>;

// ---------------------------------------------------------------------------
// Localization - covers the localized-text entry point
// ---------------------------------------------------------------------------

/** Identical to `TranslationArgs` in `src/i18n/t.ts:10`. */
export type TranslationArgs = Record<string, string | number | boolean>;

/**
 * Covers the host runtime text entry point (src/i18n/t.ts:19 -- the only runtime text
 * entry point in the whole repo, backed by the host's localization API). Narrowed to a
 * single call form, `t(message, args?)`, exactly matching the existing `t()`.
 */
export interface Localization {
  t(message: string, args?: TranslationArgs): string;
}

// ---------------------------------------------------------------------------
// Clipboard - covers the host clipboard
// ---------------------------------------------------------------------------

/**
 * Declares only the `writeText` that is actually used; `readText` currently has no
 * consumption site at all.
 *
 * Real consumption sites: copying the host address (src/extension.ts), copying a
 * fingerprint (src/extension.ts), copying a remote path (src/extension.ts).
 */
export interface Clipboard {
  writeText(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// HostEnvironment - covers the host env identity and the path/workspace facets of the context
// ---------------------------------------------------------------------------

/** Matches an assignable subset of the host `WorkspaceFolder`. */
export interface WorkspaceFolderLike {
  readonly uri: UriLike;
}

/**
 * Host environment info. Covers:
 * - `env.appName` / `env.appRoot` / `env.uriScheme` (src/extension.ts -> hostEnv)
 * - `context.extensionUri.fsPath` (src/extension.ts)
 * - `context.globalStorageUri.fsPath` (src/extension.ts passes it to the audit log,
 *   src/mcp/hubSync.ts, src/assets/AssetCommands.ts:164)
 * - `workspace.workspaceFolders` (resolveEditStorageUri at src/extension.ts,
 *   currentWorkspaceFolder at src/extension.ts)
 *
 * The host context object itself (the `ExtensionContext` family) is a pure host object and
 * does not enter the port layer; only these facets that are actually read on the domain
 * side are taken here.
 */
export interface HostEnvironment {
  readonly appName: string;
  readonly appRoot: string;
  readonly uriScheme: string;
  /**
   * `context.extensionUri.fsPath`: the directory holding packaged assets (dist/webview,
   * dist/hub.js).
   */
  readonly extensionPath: string;
  /**
   * `context.globalStorageUri.fsPath`: the on-disk directory for the audit log, hub sync
   * state, and imported private keys.
   */
  readonly storageDir: string;
  readonly workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
}

// ---------------------------------------------------------------------------
// Platform bundle
// ---------------------------------------------------------------------------

/**
 * The combination of all the ports above. There is exactly one injection point (on the
 * VS Code side the adapter layer builds it once from the activation context; on the dsh
 * side one will later be built from `ctx.credentials` / `ctx.storageDomain` /
 * `ctx.settings`), so domain services no longer touch any host global directly.
 */
export interface Platform {
  readonly notifier: Notifier;
  readonly prompter: Prompter;
  readonly uris: UriService;
  readonly config: ConfigReader;
  readonly secrets: SecretStore;
  readonly state: StateStore;
  readonly transfers: TransferReporter;
  readonly keyboardInteractive: KeyboardInteractivePrompter;
  readonly localization: Localization;
  readonly clipboard: Clipboard;
  readonly environment: HostEnvironment;
}
