import type { Platform } from '../../core/ports';
import { clearPlatform, setPlatform, trackPlatformAssembly } from '../current';
import { createDshClipboard } from './clipboard';
import { createDshConfigReader } from './config';
import { createDshSecretStore } from './credentials';
import { createDshHostEnvironment } from './environment';
import { NOOP_DSH_LOGGER, type DshPlatformDeps } from './host';
import { createDshLocalization } from './localization';
import { createDshNotifier } from './notifier';
import { createDshPrompter } from './prompter';
import { openDshStateStore } from './state';
import { createDshTransferReporter } from './transfers';
import { createDshUriService } from './uris';

/**
 * The dsh composition root — the counterpart of `src/platform/vscode/platform.ts`.
 *
 * `src/extension.ts` builds the VS Code bundle from an `ExtensionContext`; this builds
 * the dsh bundle from the facets the Host half injects. Both hand the *same*
 * `Platform` to the *same* domain layer, which is the entire point of the W2
 * migration: `ConfigManager`, `HostKeyStore`, `SftpManager`, `SshSession`,
 * `AgentToolService` and the rest neither know nor ask which host they are on.
 *
 * ## Why this function is asynchronous
 *
 * `ctx.storageDomain.open(spec)` resolves the backend route, requires its `kv` facet,
 * loads and validates the whole unit. A failure there has to abort plugin activation
 * — a store that silently loses writes is worse than a plugin that refuses to start —
 * so the rejection propagates out of here and the Host half's `apply()` lets it fail
 * the entry.
 *
 * ## What the assembly deliberately leaves unbuilt
 *
 * - **`keyboardInteractive`** answers `undefined` until a Client half fills the seam.
 *   That is the port's documented choice for a prompt-less path ("a prompt-less
 *   background path must pass `undefined` rather than popping up a dialog"), and it
 *   is what makes a keyboard-interactive *authentication* attempt fail cleanly
 *   instead of hanging on a dialog no one can see. Key- and password-based logins
 *   never touch this port.
 * - **`environment.workspaceFolders`** is `undefined`: dsh has a workspace concept,
 *   but nothing in the M2 path needs it, and `resolveEditStorageUri` falls back to
 *   the extension storage on `undefined`. Inventing a folder would be inventing a
 *   project root the user never chose.
 *
 * Neither is a stub in the "returns something plausible" sense — both are the
 * honest value, recorded here so the Client half knows exactly which two seams it
 * has to fill.
 */
export interface DshPlatformHandle {
  readonly platform: Platform;
  /**
   * Release everything this assembly owns. Idempotent: the state domain's `close()`
   * shares one teardown, so an unmount that races a reload cannot double-close.
   */
  close(): Promise<void>;
}

export async function createDshPlatform(deps: DshPlatformDeps): Promise<DshPlatformHandle> {
  // Published before the first `await`, so a second bundle in the same process (the opt-in
  // terminal bundle) can wait for this assembly instead of building a second platform. Two
  // assemblies are not merely redundant: `ctx.storageDomain.open()` is exclusive, so the loser
  // fails with `domain 'at_terminal_state' is already open` — which is exactly what the first
  // real `terminal_open` hit.
  return trackPlatformAssembly(buildDshPlatform(deps));
}

async function buildDshPlatform(deps: DshPlatformDeps): Promise<DshPlatformHandle> {
  const logger = deps.logger ?? NOOP_DSH_LOGGER;

  // Opened first: if the storage domain is unusable, nothing below it is worth
  // building, and failing here means no partially-constructed platform escapes.
  const state = await openDshStateStore({ storageDomain: deps.storageDomain, logger });

  const notifier = createDshNotifier({ logger });

  const platform: Platform = {
    notifier,
    prompter: createDshPrompter({ logger }),
    uris: createDshUriService(),
    config: createDshConfigReader(deps.settings),
    secrets: createDshSecretStore({ credentials: deps.credentials, logger }),
    state: state.state,
    transfers: createDshTransferReporter(notifier),
    keyboardInteractive: async () => undefined,
    localization: createDshLocalization(deps.messages ?? {}),
    clipboard: createDshClipboard({ logger }),
    environment: createDshHostEnvironment(deps.facts)
  };

  // Install into the registry the domain layer reads through (`src/platform/current.ts`).
  // The VS Code root does this in `src/extension.ts`; this is the dsh counterpart, and it
  // was missing — every domain call that goes through `t()` or a notification, including
  // `SshSession.connect`, threw "platform not installed" until a real terminal connect in
  // the app found it. Installed only once the storage domain is open, so an assembly that
  // fails part-way never becomes visible to the domain layer.
  setPlatform(platform);

  return {
    platform,
    async close() {
      // Guarded: an unload racing a reload must not clear the newer assembly.
      clearPlatform(platform);
      await state.close();
    }
  };
}
