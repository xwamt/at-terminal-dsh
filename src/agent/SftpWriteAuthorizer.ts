import type { ServerConfig } from '../config/schema';
import { dirname } from '../sftp/RemotePath';
import { shouldAutoApproveSftpWrite } from './agentCommandTrust';
import { isSensitiveRemotePath, isWithinRemoteDirectory, normalizeRemoteDirectory } from './remoteWritePolicy';

export type SftpWriteScope = 'once' | 'directory' | 'session';

export interface SftpWriteRequest {
  operation: 'write_file' | 'create_file' | 'create_directory' | 'rename' | 'delete_file';
  path: string;
  overwrite: boolean;
  /** `realpath('.')` of the SFTP session, i.e. the directory the user actually opened. */
  workspaceRoot: string;
}

export interface SftpWriteConfirmation {
  server: ServerConfig;
  request: SftpWriteRequest;
  parentDirectory: string;
  workspaceRoot: string;
  outsideWorkspace: boolean;
  sensitive: boolean;
  allowedScopes: readonly SftpWriteScope[];
  stage: 'primary' | 'sensitive-double-check';
}

export type ConfirmSftpWrite = (confirmation: SftpWriteConfirmation) => Promise<SftpWriteScope | undefined>;

export const DIRECTORY_GRANT_TTL_MS = 15 * 60 * 1000;

export interface SftpWriteAuthorizerOptions {
  confirm?: ConfirmSftpWrite;
  now?: () => number;
}

/**
 * Decides whether an agent-initiated SFTP write may proceed.
 *
 * A grant is keyed on `(serverId, parent directory)` and carries an expiry. Nothing is keyed
 * on the server alone: the caller may be an agent following injected instructions, and under
 * that threat model "the user allowed one write to this box" cannot mean "this box is now
 * writable". Sensitive paths never produce a grant at all, and full trust does not cover
 * them either — a fully trusted server still asks twice before `~/.ssh/authorized_keys`.
 */
export class SftpWriteAuthorizer {
  /** grant key -> expiry timestamp; Infinity for session-lifetime grants. */
  private readonly grants = new Map<string, number>();
  private readonly confirm: ConfirmSftpWrite;
  private readonly now: () => number;

  constructor(options: SftpWriteAuthorizerOptions = {}) {
    this.confirm = options.confirm ?? defaultNoConfirmation;
    this.now = options.now ?? Date.now;
  }

  async requireWrite(server: ServerConfig, request: SftpWriteRequest): Promise<void> {
    const parentDirectory = normalizeRemoteDirectory(dirname(request.path));
    const sensitive = isSensitiveRemotePath(request.path);
    // Full trust is the one place where "no prompt" is the answer, and it stops here:
    // sensitive paths are where an agent following injected instructions does the most
    // damage, and trust is granted to a server, not to `~/.ssh/authorized_keys` on it.
    if (!sensitive && shouldAutoApproveSftpWrite(server)) {
      return;
    }
    const outsideWorkspace = !isWithinRemoteDirectory(request.workspaceRoot, request.path);
    const grantKey = `${server.id}\n${parentDirectory}`;

    if (!sensitive && this.hasLiveGrant(grantKey)) {
      return;
    }

    const allowedScopes = resolveAllowedScopes(sensitive, outsideWorkspace);
    const base = {
      server,
      request,
      parentDirectory,
      workspaceRoot: normalizeRemoteDirectory(request.workspaceRoot),
      outsideWorkspace,
      sensitive
    };

    const scope = await this.confirm({ ...base, allowedScopes, stage: 'primary' });
    if (!scope || !allowedScopes.includes(scope)) {
      throw new Error('SFTP write was cancelled.');
    }

    if (sensitive) {
      const confirmed = await this.confirm({
        ...base,
        allowedScopes: ['once'],
        stage: 'sensitive-double-check'
      });
      if (confirmed !== 'once') {
        throw new Error('SFTP write was cancelled.');
      }
      return;
    }

    if (scope === 'directory') {
      this.grants.set(grantKey, this.now() + DIRECTORY_GRANT_TTL_MS);
    } else if (scope === 'session') {
      this.grants.set(grantKey, Number.POSITIVE_INFINITY);
    }
  }

  /**
   * Deletion is never auto-approved and never remembered: full trust covers write
   * prompts but not deletes, and no directory or session grant may ever cover a
   * delete. Every call asks the user; sensitive paths ask twice.
   */
  async requireDelete(server: ServerConfig, request: SftpWriteRequest): Promise<void> {
    const parentDirectory = normalizeRemoteDirectory(dirname(request.path));
    const sensitive = isSensitiveRemotePath(request.path);
    const outsideWorkspace = !isWithinRemoteDirectory(request.workspaceRoot, request.path);
    const base = {
      server,
      request,
      parentDirectory,
      workspaceRoot: normalizeRemoteDirectory(request.workspaceRoot),
      outsideWorkspace,
      sensitive
    };

    const scope = await this.confirm({ ...base, allowedScopes: ['once'], stage: 'primary' });
    if (scope !== 'once') {
      throw new Error('SFTP delete was cancelled.');
    }
    if (sensitive) {
      const confirmed = await this.confirm({
        ...base,
        allowedScopes: ['once'],
        stage: 'sensitive-double-check'
      });
      if (confirmed !== 'once') {
        throw new Error('SFTP delete was cancelled.');
      }
    }
  }

  private hasLiveGrant(grantKey: string): boolean {
    const expiresAt = this.grants.get(grantKey);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= this.now()) {
      this.grants.delete(grantKey);
      return false;
    }
    return true;
  }
}

function resolveAllowedScopes(sensitive: boolean, outsideWorkspace: boolean): readonly SftpWriteScope[] {
  if (sensitive) {
    return ['once'];
  }
  // A grant that never expires is only on offer inside the directory the user opened.
  return outsideWorkspace ? ['once', 'directory'] : ['once', 'directory', 'session'];
}

function defaultNoConfirmation(): Promise<SftpWriteScope | undefined> {
  return Promise.reject(
    new Error('SFTP write requires human confirmation, but no confirmation channel is available.')
  );
}

