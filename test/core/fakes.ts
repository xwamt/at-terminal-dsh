import { join as joinPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cancellationTokenNone,
  type CancellationToken,
  type Clipboard,
  type ConfigReader,
  type ConfigSection,
  type FileDialogOptions,
  type HostEnvironment,
  type InputBoxOptions,
  type KeyboardInteractivePrompter,
  type KeyboardInteractiveRequest,
  type Localization,
  type MessageOptions,
  type Notifier,
  type Platform,
  type ProgressOptions,
  type ProgressReporter,
  type Prompter,
  type QuickPickOptions,
  type SecretStore,
  type StateStore,
  type TransferProgress,
  type TransferReporter,
  type TranslationArgs,
  type UriComponents,
  type UriLike,
  type UriService,
  type WorkspaceFolderLike
} from '../../src/core';

/**
 * Pure in-memory port implementations, so `test/core/**` can verify the port contracts
 * **without touching the host at all**.
 *
 * This only imports `src/core` and node's standard library; if the core layer ever
 * secretly depends on a host module, this file will fail to compile first -- it therefore
 * doubles as one of the gatekeepers for "zero host imports in the core layer" (the other
 * being the grep in the DoD).
 */

// ---------------------------------------------------------------------------
// State / credentials
// ---------------------------------------------------------------------------

export class FakeStateStore implements StateStore {
  private readonly data = new Map<string, unknown>();
  updateCalls = 0;

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updateCalls += 1;
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }

  /** Test helper: inspect the stored value directly, bypassing update. */
  raw(key: string): unknown {
    return this.data.get(key);
  }
}

export class FakeSecretStore implements SecretStore {
  readonly data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export class FakeConfigReader implements ConfigReader {
  constructor(private readonly sections: Record<string, Record<string, unknown>> = {}) {}

  getSection(section: string): ConfigSection {
    const values = this.sections[section] ?? {};
    return {
      get: <T>(key: string, defaultValue: T): T =>
        (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue) as T
    };
  }
}

// ---------------------------------------------------------------------------
// Notification / progress
// ---------------------------------------------------------------------------

export interface RecordedMessage {
  readonly kind: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly options?: MessageOptions;
  readonly actions: string[];
}

export interface RecordedProgress {
  readonly options: ProgressOptions;
  readonly reports: Array<{ increment?: number; message?: string }>;
}

export class FakeNotifier implements Notifier {
  readonly messages: RecordedMessage[] = [];
  readonly progressCalls: RecordedProgress[] = [];
  private readonly answers: Array<string | undefined> = [];

  /**
   * Decides the return value of each show*Message in order (undefined means the user
   * dismissed the dialog).
   */
  queueAnswer(...answers: Array<string | undefined>): void {
    this.answers.push(...answers);
  }

  showInformationMessage(message: string, ...rest: unknown[]): Promise<string | undefined>;
  showInformationMessage(
    message: string,
    options: MessageOptions,
    ...actions: string[]
  ): Promise<string | undefined>;
  async showInformationMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.record('info', message, rest);
  }

  showWarningMessage(message: string, ...rest: unknown[]): Promise<string | undefined>;
  showWarningMessage(
    message: string,
    options: MessageOptions,
    ...actions: string[]
  ): Promise<string | undefined>;
  async showWarningMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.record('warning', message, rest);
  }

  showErrorMessage(message: string, ...rest: unknown[]): Promise<string | undefined>;
  showErrorMessage(
    message: string,
    options: MessageOptions,
    ...actions: string[]
  ): Promise<string | undefined>;
  async showErrorMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.record('error', message, rest);
  }

  async withProgress<T>(
    options: ProgressOptions,
    task: (progress: ProgressReporter, token: CancellationToken) => Promise<T>
  ): Promise<T> {
    const call: RecordedProgress = { options, reports: [] };
    this.progressCalls.push(call);
    return await task({ report: (value) => call.reports.push(value) }, cancellationTokenNone);
  }

  private record(kind: RecordedMessage['kind'], message: string, rest: unknown[]): string | undefined {
    const [head, ...tail] = rest;
    const hasOptions = typeof head === 'object' && head !== null;
    const actions = (hasOptions ? tail : rest) as string[];
    this.messages.push({
      kind,
      message,
      options: hasOptions ? (head as MessageOptions) : undefined,
      actions
    });
    // Matching the host: with no selectable option it does not show a dialog and ends with
    // undefined, without consuming a queued answer.
    if (actions.length === 0) {
      return undefined;
    }
    return this.answers.shift();
  }
}

// ---------------------------------------------------------------------------
// Input / dialogs
// ---------------------------------------------------------------------------

export class FakePrompter implements Prompter {
  readonly calls: string[] = [];
  readonly quickPickAnswers: Array<string | string[] | undefined> = [];
  readonly inputAnswers: Array<string | undefined> = [];
  readonly openAnswers: Array<UriLike[] | undefined> = [];
  readonly saveAnswers: Array<UriLike | undefined> = [];

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
  async showQuickPick(
    items: readonly string[],
    _options?: QuickPickOptions,
    _token?: CancellationToken
  ): Promise<string[] | string | undefined> {
    this.calls.push(`quickPick:${items.join('|')}`);
    return this.quickPickAnswers.shift();
  }

  async showInputBox(
    options?: InputBoxOptions,
    _token?: CancellationToken
  ): Promise<string | undefined> {
    this.calls.push(`inputBox:${options?.prompt ?? ''}`);
    return this.inputAnswers.shift();
  }

  async showOpenDialog(options: FileDialogOptions): Promise<UriLike[] | undefined> {
    this.calls.push(`openDialog:${options.title ?? ''}`);
    return this.openAnswers.shift();
  }

  async showSaveDialog(options: FileDialogOptions): Promise<UriLike | undefined> {
    this.calls.push(`saveDialog:${options.title ?? ''}`);
    return this.saveAnswers.shift();
  }
}

// ---------------------------------------------------------------------------
// URI
// ---------------------------------------------------------------------------

export class FakeUri implements UriLike {
  constructor(
    readonly scheme: string,
    readonly fsPath: string
  ) {}

  toString(): string {
    return this.scheme === 'file' ? pathToFileURL(this.fsPath).toString() : `${this.scheme}:${this.fsPath}`;
  }
}

export class FakeUriService implements UriService {
  file(fsPath: string): UriLike {
    return new FakeUri('file', fsPath);
  }

  joinPath(base: UriLike, ...segments: string[]): UriLike {
    return new FakeUri(base.scheme, joinPath(base.fsPath, ...segments));
  }

  parse(value: string): UriLike {
    if (value.startsWith('file://')) {
      return new FakeUri('file', fileURLToPath(value));
    }
    const separator = value.indexOf(':');
    return separator < 0 ? new FakeUri('file', value) : new FakeUri(value.slice(0, separator), value.slice(separator + 1));
  }

  from(components: UriComponents): UriLike {
    return new FakeUri(components.scheme, components.path ?? '');
  }

  isUri(value: unknown): value is UriLike {
    return value instanceof FakeUri;
  }
}

// ---------------------------------------------------------------------------
// Transfers / keyboard-interactive / localization / clipboard / environment
// ---------------------------------------------------------------------------

export class FakeTransferReporter implements TransferReporter {
  readonly progressLabels: string[] = [];
  readonly successMessages: string[] = [];
  readonly failureMessages: string[] = [];

  async withProgress<T>(
    label: string,
    job: (progress: TransferProgress) => Promise<T>
  ): Promise<T> {
    this.progressLabels.push(label);
    return await job({ report: () => undefined });
  }

  async notifySuccess(message: string): Promise<void> {
    this.successMessages.push(message);
  }

  async notifyFailure(message: string): Promise<void> {
    this.failureMessages.push(message);
  }
}

/**
 * The `KeyboardInteractivePrompter` port is a **function type alias** (reusing the seam
 * shape from the existing `src/ssh/KeyboardInteractive.ts:19`), so the recorder and the
 * port itself are kept separate: a class instance is not callable and cannot satisfy a
 * function alias directly.
 */
export class FakeKeyboardInteractiveRecorder {
  readonly requests: KeyboardInteractiveRequest[] = [];
  nextResponses: string[] | undefined = undefined;

  /**
   * The port itself: it always reads this instance's field, so changing `nextResponses`
   * takes effect immediately.
   */
  readonly prompter: KeyboardInteractivePrompter = async (request) => {
    this.requests.push(request);
    return this.nextResponses;
  };
}

export class FakeLocalization implements Localization {
  constructor(private readonly dictionary: Record<string, string> = {}) {}

  t(message: string, args?: TranslationArgs): string {
    const template = this.dictionary[message] ?? message;
    if (args === undefined) {
      return template;
    }
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
      Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : match
    );
  }
}

export class FakeClipboard implements Clipboard {
  readonly written: string[] = [];

  async writeText(text: string): Promise<void> {
    this.written.push(text);
  }
}

export function createFakeHostEnvironment(
  overrides: Partial<HostEnvironment> = {}
): HostEnvironment {
  const folders: readonly WorkspaceFolderLike[] = [{ uri: new FakeUri('file', '/work/project') }];
  return {
    appName: 'Fake IDE',
    appRoot: '/opt/fake-ide',
    uriScheme: 'fake',
    extensionPath: '/home/user/.fake/extensions/at-terminal',
    storageDir: '/home/user/.fake/storage/at-terminal',
    workspaceFolders: folders,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Platform bundle
// ---------------------------------------------------------------------------

export interface FakePlatform extends Platform {
  readonly notifier: FakeNotifier;
  readonly prompter: FakePrompter;
  readonly uris: FakeUriService;
  readonly config: FakeConfigReader;
  readonly secrets: FakeSecretStore;
  readonly state: FakeStateStore;
  readonly transfers: FakeTransferReporter;
  readonly keyboardInteractive: KeyboardInteractivePrompter;
  /**
   * The recorder for the keyboard-interactive port (the port itself is a function, so
   * recording needs a separate handle).
   */
  readonly keyboardInteractiveRecorder: FakeKeyboardInteractiveRecorder;
  readonly localization: FakeLocalization;
  readonly clipboard: FakeClipboard;
  readonly environment: HostEnvironment;
}

export interface FakePlatformOptions {
  readonly config?: Record<string, Record<string, unknown>>;
  readonly dictionary?: Record<string, string>;
  readonly environment?: Partial<HostEnvironment>;
}

/**
 * In-memory implementations that assemble all 11 ports at once -- the evidence that "it
 * runs without a host".
 */
export function createFakePlatform(options: FakePlatformOptions = {}): FakePlatform {
  const keyboardInteractiveRecorder = new FakeKeyboardInteractiveRecorder();
  return {
    notifier: new FakeNotifier(),
    prompter: new FakePrompter(),
    uris: new FakeUriService(),
    config: new FakeConfigReader(options.config),
    secrets: new FakeSecretStore(),
    state: new FakeStateStore(),
    transfers: new FakeTransferReporter(),
    keyboardInteractive: keyboardInteractiveRecorder.prompter,
    keyboardInteractiveRecorder,
    localization: new FakeLocalization(options.dictionary),
    clipboard: new FakeClipboard(),
    environment: createFakeHostEnvironment(options.environment)
  };
}
