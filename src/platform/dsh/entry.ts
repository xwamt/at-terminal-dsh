import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { assetPrivateKeyDirectory } from '../../assets/AssetCommands';
import { decryptAssetPayload, encryptAssetPayload } from '../../assets/AssetCrypto';
import { createAssetExportPayload } from '../../assets/AssetExportService';
import {
  applyAssetImport,
  type AssetConflictStrategy,
  type AssetImportSummary
} from '../../assets/AssetImportService';
import {
  ASSET_PACKAGE_EXTENSION,
  ASSET_PACKAGE_UNREADABLE_MESSAGE,
  parseAssetPackageEnvelope,
  type AssetPackageEnvelope
} from '../../assets/AssetPackage';
import { ConfigManager } from '../../config/ConfigManager';
import type { Platform } from '../../core/ports';

export { createDshPlatform, type DshPlatformHandle } from './index';
export {
  SFTP_ERROR_BAD_PARAMS,
  SFTP_ERROR_BINARY_FILE,
  SFTP_ERROR_CONFLICT,
  SFTP_ERROR_DISCONNECTED,
  SFTP_ERROR_FILE_TOO_LARGE,
  SFTP_ERROR_NO_ACTIVE_TERMINAL,
  SFTP_ERROR_NO_SUCH_FILE,
  SFTP_ERROR_NOT_A_FILE,
  SFTP_ERROR_PERMISSION_DENIED,
  SFTP_ERROR_READ_FAILED,
  SFTP_ERROR_WRITE_FAILED,
  SFTP_TEXT_MAX_BYTES,
  SFTP_TRANSFER_MAX_BYTES,
  createDshSftpApi,
  type DshSftpApi,
  type DshSftpFileBytes,
  type DshSftpFileText,
  type DshSftpListing,
  type DshSftpWriteResult
} from './sftp';
export { AT_TERMINAL_STATE_DOMAIN, AT_TERMINAL_STATE_TABLE } from './state';
export {
  createDshServerApi,
  createDshTerminalApi,
  type DshServerApi,
  type DshServerInput,
  type DshServerList,
  type DshServerView,
  type DshTerminalApi,
  type DshTerminalEvent,
  type DshTerminalObserver,
  type DshTerminalOpenOptions,
  type DshTerminalPresence,
  type DshTerminalSession
} from './services';
export {
  createDshAgentToolService,
  createDshPolicyEvaluator,
  resolveDshPolicyAssetDirectory,
  type DshAgentServiceOptions
} from './agent';
export {
  DshAgentConfirmation,
  formatSftpWriteConfirmMessage,
  type DshApprovalOutcome,
  type DshApprovalRequest,
  type DshApprovalService,
  type DshCallContext
} from './confirmation';
export { TerminalContextRegistry } from '../../terminal/TerminalContext';
export { HardwareMetricsCollector } from '../../agent/HardwareMetricsCollector';
export { AgentExecutionBridge } from '../../agent/AgentExecutionBridge';

/**
 * The dsh bundle's **single import surface for `src/**`**.
 *
 * `dsh/index.js` and `dsh/channel.js` are plain JavaScript, while the domain layer is
 * TypeScript; this module is the seam. `esbuild.dsh.mjs` bundles it into
 * `dsh/host.bundle.js`, so the plain-JS half never imports a `.ts` file and never
 * reimplements anything the VS Code variant already does.
 *
 * ## Asset transfer exists to make the two platforms interchangeable
 *
 * AT Terminal's asset package format is the user-facing contract that lets someone move
 * their servers from VS Code to dsh (or back) — which is why this file **reuses**
 * `src/assets/**` untouched rather than writing a dsh-flavoured exporter. The storage
 * rules it honours are the ones the VS Code variant already established:
 *
 * | Asset | Where it lives on the VS Code side | Where it lives here |
 * |---|---|---|
 * | Server records | `globalState` key `sshManager.servers` | the `at_terminal_state` domain, same key |
 * | SSH passwords / key passphrases | `SecretStorage`, keyed `sshManager.password.<id>` / `sshManager.passphrase.<id>` | `ctx.credentials` references, same key mapping (`src/platform/dsh/credentials.ts`) |
 * | Imported private keys | `<globalStorage>/imported-private-keys/<serverId>-<basename>`, mode 0600 | the same directory shape under `platform().environment.storageDir` |
 * | Host key trust | **not exported** — `includesHostTrust` is a hard `false` in the payload schema | unchanged; trust is deliberately machine-local |
 *
 * Those are exactly the three seams the port layer already abstracts, so the export
 * payload produced here is byte-compatible with one produced in VS Code: the same
 * envelope, the same scrypt + AES-256-GCM scheme, the same payload schema, and the same
 * migration for servers written by 0.3.x.
 */

/**
 * Where imported private keys live, derived from the platform rather than from a caller's
 * own guess.
 *
 * Exported so the plain-JS Host half does not reconstruct the path itself: two places
 * computing `<storageDir>/imported-private-keys` is exactly how the export/import path and
 * the private-key path drift apart, and they have to agree or an imported key is written
 * somewhere the connection will not look.
 */
export function importedPrivateKeyDirectory(platform: Platform): string {
  return assetPrivateKeyDirectory(platform.environment.storageDir);
}

/** What the panel shows before the user exports or imports anything. */
export interface DshAssetSummary {
  /** Servers currently stored. */
  servers: number;
  /** How many of the password-auth servers actually have a password stored. */
  passwords: number;
  /** Files present in the imported-private-keys directory. */
  privateKeyFiles: number;
  /** Where imported private keys are written, so the panel can show the real path. */
  privateKeyDirectory: string;
}

export interface DshAssetExportRequest {
  includePasswords: boolean;
  includePrivateKeys: boolean;
  /** Password protecting the produced package; separate from any SSH password. */
  packagePassword: string;
}

export interface DshAssetExportResult {
  /** Mirrors the VS Code variant's default filename so the two are recognisably the same file. */
  filename: string;
  envelope: AssetPackageEnvelope;
  omissions: number;
}

export interface DshAssetImportRequest {
  /** An envelope object, or the raw file text. Both arrive from a browser file picker. */
  envelope: unknown;
  packagePassword: string;
  strategy: AssetConflictStrategy;
}

export interface DshAssetImportResult {
  summary: AssetImportSummary;
}

export interface DshAssetApi {
  summary(): Promise<DshAssetSummary>;
  export(request: DshAssetExportRequest): Promise<DshAssetExportResult>;
  importPackage(request: DshAssetImportRequest): Promise<DshAssetImportResult>;
}

export interface DshAssetApiOptions {
  /** The assembled platform: only `state`, `secrets` and `environment` are read here. */
  readonly platform: Platform;
  /**
   * Recorded in the payload's `source` block exactly as the VS Code variant records the
   * extension name and version, so an imported package shows where it came from.
   */
  readonly hostName: string;
  readonly hostVersion: string;
  /** Injectable so tests can make a rename deterministic. */
  readonly generateId?: () => string;
}

/** Error codes the channel turns into `{code, message}` for the browser half. */
export const ASSET_ERROR_WRONG_PASSWORD = 'wrong-password';
export const ASSET_ERROR_UNREADABLE_PACKAGE = 'unreadable-package';

/**
 * Build the asset face over an assembled platform.
 *
 * Everything below is the VS Code variant's own code path: `createAssetExportPayload`
 * reads passwords through a callback, `encryptAssetPayload` produces the envelope, and
 * `applyAssetImport` consumes a two-method `store` — which `ConfigManager` already is.
 * The dsh side contributes no format of its own on purpose: a second definition of what
 * an asset package is would be the end of "move your data between platforms".
 */
export function createDshAssetApi(options: DshAssetApiOptions): DshAssetApi {
  const { platform } = options;
  const configManager = new ConfigManager(platform.state, platform.secrets);
  const privateKeyDirectory = assetPrivateKeyDirectory(platform.environment.storageDir);
  const generateId = options.generateId ?? (() => randomUUID());

  async function listPrivateKeyFiles(): Promise<string[]> {
    try {
      return await readdir(privateKeyDirectory);
    } catch {
      // Absent directory is the normal state before the first import, not an error.
      return [];
    }
  }

  return {
    async summary(): Promise<DshAssetSummary> {
      const servers = await configManager.listServers();
      let passwords = 0;
      for (const server of servers) {
        if (server.authType !== 'password') continue;
        if ((await configManager.getPassword(server.id)) !== undefined) passwords += 1;
      }
      const files = await listPrivateKeyFiles();
      return {
        servers: servers.length,
        passwords,
        privateKeyFiles: files.length,
        privateKeyDirectory
      };
    },

    async export(request: DshAssetExportRequest): Promise<DshAssetExportResult> {
      if (typeof request?.packagePassword !== 'string' || request.packagePassword.length === 0) {
        throw Object.assign(new Error('a package password is required'), { code: 'bad-params' });
      }
      const payload = await createAssetExportPayload({
        servers: await configManager.listServers(),
        includePasswords: request.includePasswords === true,
        includePrivateKeys: request.includePrivateKeys === true,
        extensionName: options.hostName,
        extensionVersion: options.hostVersion,
        getPassword: (id) => configManager.getPassword(id)
      });
      return {
        // Same default name as the VS Code command, so a user comparing the two sees
        // the same file rather than wondering whether they are different formats.
        filename: `at-terminal-assets${ASSET_PACKAGE_EXTENSION}`,
        envelope: await encryptAssetPayload(payload, request.packagePassword),
        omissions: payload.omissions.length
      };
    },

    async importPackage(request: DshAssetImportRequest): Promise<DshAssetImportResult> {
      if (typeof request?.packagePassword !== 'string' || request.packagePassword.length === 0) {
        throw Object.assign(new Error('the package password is required'), { code: 'bad-params' });
      }
      const strategy: AssetConflictStrategy = request.strategy ?? 'skip';
      if (strategy !== 'skip' && strategy !== 'overwrite' && strategy !== 'rename') {
        throw Object.assign(new Error(`unknown conflict strategy "${String(request.strategy)}"`), {
          code: 'bad-params'
        });
      }

      // The browser hands over either the parsed envelope or the file's raw text; both
      // are legal inputs to `parseAssetPackageEnvelope`, so accept both rather than
      // making the client guess which one this half wants.
      //
      // The parse is guarded because an unguarded one throws a bare `SyntaxError` with no
      // `code`, which the channel would surface as `method-error` — while the VS Code
      // variant reports the same broken file as an unreadable package. One bad file must
      // not produce two different platforms' worth of advice.
      let envelope: unknown;
      if (typeof request.envelope === 'string') {
        try {
          envelope = JSON.parse(request.envelope);
        } catch {
          throw Object.assign(
            new Error('the chosen file is not an AT Terminal asset package: its contents are not JSON'),
            { code: ASSET_ERROR_UNREADABLE_PACKAGE }
          );
        }
      } else {
        envelope = request.envelope;
      }
      if (envelope === null || typeof envelope !== 'object') {
        throw Object.assign(new Error('the chosen file is not an AT Terminal asset package'), {
          code: ASSET_ERROR_UNREADABLE_PACKAGE
        });
      }

      // Validate the header **before** decrypting. `decryptAssetPayload` parses the
      // envelope inside itself but outside its own try (src/assets/AssetCrypto.ts:46), so
      // a structurally wrong header escapes as a schema error and anything mapping "not
      // the wrong-password message" would report it as a wrong password — sending the
      // user to retype a password that was never the problem.
      try {
        parseAssetPackageEnvelope(envelope);
      } catch {
        throw Object.assign(
          new Error('the chosen file is not an AT Terminal asset package: its header is missing or from another format'),
          { code: ASSET_ERROR_UNREADABLE_PACKAGE }
        );
      }

      let payload;
      try {
        payload = await decryptAssetPayload(envelope as AssetPackageEnvelope, request.packagePassword);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The asset layer deliberately distinguishes "wrong password" from "right
        // password, unreadable payload"; the second must not send the user back to
        // retype a password that was correct.
        throw Object.assign(new Error(message), {
          code: message === ASSET_PACKAGE_UNREADABLE_MESSAGE ? ASSET_ERROR_UNREADABLE_PACKAGE : ASSET_ERROR_WRONG_PASSWORD
        });
      }

      const summary = await applyAssetImport({
        payload,
        conflictStrategy: strategy,
        privateKeyDirectory,
        // `ConfigManager.saveServer(server, password)` is the same two-method store the
        // VS Code variant passes, so an import here and an import there leave the same
        // state behind: records in the keyed store, passwords in the credential store,
        // key files in the directory above.
        store: configManager,
        generateId
      });
      return { summary };
    }
  };
}
