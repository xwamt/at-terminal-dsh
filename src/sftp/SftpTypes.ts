import type { ServerConfig } from '../config/schema';

export type SftpEntryType = 'file' | 'directory' | 'symlink';

export interface SftpEntry {
  name: string;
  path: string;
  type: SftpEntryType;
  /**
   * What a symlink resolves to, so a symlinked directory stays expandable in the tree.
   * Only populated for `type === 'symlink'`; undefined when the target could not be
   * stat-ed (dangling link).
   */
  targetType?: 'file' | 'directory';
  size?: number;
  modifiedAt?: number;
}

export interface SftpFileStat {
  size: number;
  modifiedAt: number;
  /**
   * What sits at the path, when the stat resolved one.
   *
   * Optional, and deliberately so: every existing consumer (`remoteStatsMatch`, the edit
   * session's conflict check, the agent service) reads only `size`/`modifiedAt`, and a
   * caller that fakes a stat should not have to invent a type it never uses. It exists
   * because a file-transfer surface has to tell "a file" from "a directory" **before** it
   * tries to read bytes: `open(dir, 'r')` fails with a protocol status that carries no
   * remedy, while "that path is a directory" is a sentence a user can act on.
   *
   * `stat` follows symlinks, so this is `file` or `directory` for a resolved path.
   */
  type?: SftpEntryType;
}

export interface SftpSnapshot {
  server: ServerConfig;
  rootPath: string;
  entriesByPath: Map<string, SftpEntry[]>;
  connected: boolean;
}

export interface PasswordSource {
  getPassword(serverId: string): Promise<string | undefined>;
  getServer?(serverId: string): Promise<ServerConfig | undefined>;
}

export type SftpTreeState =
  | { kind: 'none' }
  | { kind: 'disconnected'; rootPath: string; entries: SftpEntry[] }
  | { kind: 'active'; rootPath: string };

export interface SftpViewDescriptor {
  terminalId: string;
  rootPath?: string;
  connected: boolean;
}
