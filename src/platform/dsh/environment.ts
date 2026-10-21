import type { HostEnvironment } from '../../core/ports';
import type { DshHostFacts } from './host';

/**
 * The dsh implementation of the `HostEnvironment` port — DSH-17.
 *
 * The VS Code adapter reads four live host facets (`env.appName` / `appRoot` /
 * `uriScheme`, `context.extensionUri`, `context.globalStorageUri`) plus the workspace
 * list. dsh cannot be asked for any of them the way VS Code can — `ctx` exposes no
 * `env`, no `extensionUri`, no `globalStorageUri` — so the Host half resolves them
 * once and injects them as `DshHostFacts`. This function is the mapping from those
 * facts to the port, and nothing more.
 *
 * ## Why `workspaceFolders` is `undefined`
 *
 * This is the one field with a real choice, so it is documented rather than defaulted:
 *
 * - The **M2 path does not need a workspace.** The only consumer,
 *   `resolveEditStorageUri` (`src/sftp/SftpEditSessionManager.ts`), treats a missing
 *   workspace as "fall back to extension storage" — which is the correct home for
 *   SFTP edit-session scratch files anyway, and is the branch the VS Code adapter also
 *   takes when no folder is open.
 * - dsh *does* have a workspace concept, but it is not `ctx`-exposed the way a folder
 *   is here, and inventing a synthetic folder would send edit sessions into a directory
 *   that has nothing to do with the user's project. A fabricated workspace is worse than
 *   an honest absence, because the fallback path is safe and the fabricated path is not.
 *
 * So the field is `undefined` — the port's own "no workspace" value, not an empty array
 * and not a guess.
 */
export function createDshHostEnvironment(facts: DshHostFacts): HostEnvironment {
  return {
    appName: facts.appName,
    appRoot: facts.appRoot,
    uriScheme: facts.uriScheme,
    // `context.extensionUri.fsPath`'s counterpart: the bundle directory that holds the
    // packaged webview/hub assets.
    extensionPath: facts.bundlePath,
    // `context.globalStorageUri.fsPath`'s counterpart: the `$DSH_HOME`-based directory
    // that survives a bundle reinstall.
    storageDir: facts.storageDir,
    workspaceFolders: undefined
  };
}
