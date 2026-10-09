import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { parseServerConfig, type ServerConfig } from '../../config/schema';
import { ConfigManager } from '../../config/ConfigManager';
import type { Platform } from '../../core/ports';
import { HostKeyStore } from '../../ssh/HostKeyStore';
import type { HostKeyVerifier } from '../../ssh/SshConnectionConfig';
import { SshSession, type SshSessionStatus } from '../../ssh/SshSession';
import { classifySshFailure } from './sshFailure';

/**
 * The domain services the dsh panels drive: server records (the asset-management panel)
 * and SSH terminal sessions (the terminal panel).
 *
 * Both are thin compositions over code the VS Code variant already owns —
 * `ConfigManager` for records and credentials, `HostKeyStore` for trust, `SshSession` for
 * the connection. Nothing here reimplements a rule; what it adds is the *host-shaped*
 * missing pieces: a redacted view for a browser, a verifier that cannot prompt, and a
 * pause/resume hook so the client's flow control reaches the SSH socket.
 */

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

/**
 * A server as the browser is allowed to see it.
 *
 * **No password ever crosses this boundary.** The record itself never holds one — the
 * password lives in the credential store, keyed by server id — and the only thing the
 * view reports is `hasPassword`, which is what the form needs to say "已保存" without
 * being able to hand the secret back out.
 */
export interface DshServerView {
  id: string;
  label: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  authType: ServerConfig['authType'];
  hasPassword: boolean;
  /** The path as recorded, and its basename for display. */
  privateKeyPath?: string;
  privateKeyFileName?: string;
  jumpHostId?: string;
  encoding: ServerConfig['encoding'];
  keepAliveInterval: number;
  agentCommandTrust?: ServerConfig['agentCommandTrust'];
  backgroundConnectionAllowed?: boolean;
}

export interface DshServerList {
  servers: DshServerView[];
  /** Distinct non-empty groups, so the panel can offer existing ones instead of retyping. */
  groups: string[];
  /** Shown next to the import/export controls: where keys from a package land. */
  privateKeyDirectory: string;
}

/** What the form submits. `id` absent means create. */
export interface DshServerInput {
  id?: string;
  label: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  authType: ServerConfig['authType'];
  /** Write-only: sent on save, never returned. */
  password?: string;
  privateKeyPath?: string;
  jumpHostId?: string;
  encoding?: ServerConfig['encoding'];
  keepAliveInterval?: number;
  agentCommandTrust?: ServerConfig['agentCommandTrust'];
  backgroundConnectionAllowed?: boolean;
}

export interface DshServerApi {
  list(): Promise<DshServerList>;
  save(input: DshServerInput): Promise<DshServerView>;
  remove(id: string): Promise<{ removed: boolean }>;
}

function toView(server: ServerConfig, hasPassword: boolean): DshServerView {
  return {
    id: server.id,
    label: server.label,
    ...(server.group === undefined ? {} : { group: server.group }),
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    hasPassword,
    ...(server.privateKeyPath === undefined
      ? {}
      : { privateKeyPath: server.privateKeyPath, privateKeyFileName: basename(server.privateKeyPath) }),
    ...(server.jumpHostId === undefined ? {} : { jumpHostId: server.jumpHostId }),
    encoding: server.encoding,
    keepAliveInterval: server.keepAliveInterval,
    ...(server.agentCommandTrust === undefined ? {} : { agentCommandTrust: server.agentCommandTrust }),
    ...(server.backgroundConnectionAllowed === undefined
      ? {}
      : { backgroundConnectionAllowed: server.backgroundConnectionAllowed })
  };
}

/**
 * Build the record from a form submission.
 *
 * Deliberately explicit rather than spreading the input: `serverConfigSchema` is
 * `.strict()`, so an unexpected key from the browser would be a validation failure rather
 * than a silently ignored extra, and building the candidate field by field is what keeps
 * that contract honest. Defaults match the schema's own, so a form that omits an optional
 * field produces the same record the VS Code form would.
 */
function buildServerConfig(input: DshServerInput, existing: ServerConfig | undefined, now: number): ServerConfig {
  const candidate: Record<string, unknown> = {
    id: existing?.id ?? input.id ?? randomUUID(),
    label: input.label,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    encoding: input.encoding ?? existing?.encoding ?? 'utf-8',
    keepAliveInterval: input.keepAliveInterval ?? existing?.keepAliveInterval ?? 30,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const optional: Array<[keyof DshServerInput, string]> = [
    ['group', 'group'],
    ['privateKeyPath', 'privateKeyPath'],
    ['jumpHostId', 'jumpHostId'],
    ['agentCommandTrust', 'agentCommandTrust'],
    ['backgroundConnectionAllowed', 'backgroundConnectionAllowed']
  ];
  for (const [from, to] of optional) {
    const value = input[from];
    if (value !== undefined && value !== '') candidate[to] = value;
  }
  return parseServerConfig(candidate);
}

export interface DshServerApiOptions {
  readonly platform: Platform;
  readonly privateKeyDirectory: string;
}

export function createDshServerApi({ platform, privateKeyDirectory }: DshServerApiOptions): DshServerApi {
  const configManager = new ConfigManager(platform.state, platform.secrets);

  return {
    async list(): Promise<DshServerList> {
      const servers = await configManager.listServers();
      const views: DshServerView[] = [];
      for (const server of servers) {
        // Reported, never returned: the form needs to say "a password is stored" and that
        // is the entire extent of what leaves the credential store.
        const hasPassword =
          server.authType === 'password' && (await configManager.getPassword(server.id)) !== undefined;
        views.push(toView(server, hasPassword));
      }
      const groups = [...new Set(views.map((view) => view.group).filter((group): group is string => group !== undefined))];
      return { servers: views, groups: groups.sort((a, b) => a.localeCompare(b)), privateKeyDirectory };
    },

    async save(input: DshServerInput): Promise<DshServerView> {
      const existing = input.id === undefined ? undefined : await configManager.getServer(input.id);
      const server = buildServerConfig(input, existing, Date.now());
      /**
       * A blank password means "leave the stored one alone".
       *
       * That is what the form tells the user, and it is what every other optional field
       * already does — `buildServerConfig` drops `''` for `group`, `privateKeyPath` and the
       * rest. Passing a blank through instead would reach `ctx.credentials.set`, which
       * refuses an empty value, and it would refuse it **after** the record had been
       * written: a save that reports failure while the row is already in the list, with an
       * error that carries no code and leaks the internal reference name.
       */
      const password = input.password === undefined || input.password === '' ? undefined : input.password;
      // `ConfigManager.saveServer` writes the record and, when a password is supplied,
      // stores it under `sshManager.password.<id>` — the same key the VS Code variant uses,
      // so an asset package exported from either side carries it.
      await configManager.saveServer(server, password);
      const hasPassword =
        server.authType === 'password' && (await configManager.getPassword(server.id)) !== undefined;
      return toView(server, hasPassword);
    },

    async remove(id: string): Promise<{ removed: boolean }> {
      const existing = await configManager.getServer(id);
      if (existing === undefined) return { removed: false };
      // Removes the record and both credential entries. Deliberately **not** the private
      // key file: `ConfigManager.deleteServer` does not do that on the VS Code side
      // either, and deleting a user's key material as a side effect of removing a row is
      // the kind of surprise that is worth a separate, explicit action.
      await configManager.deleteServer(id);
      return { removed: true };
    }
  };
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/** Events the terminal session pushes to the browser. `output` is base64. */
export type DshTerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'status'; state: string; text: string }
  /**
   * A coded failure. `host`/`port` name **the host whose key was refused**, which is not
   * always the server the user picked: a jump-host connect verifies the jump host's key
   * first. They travel with the fingerprint so `trustHost` can record the acceptance
   * against the host it was actually given for.
   */
  | { type: 'error'; code: string; message: string; fingerprint?: string; host?: string; port?: number }
  | { type: 'closed'; reason: string };

export interface DshTerminalSession {
  write(data: string): void;
  resize(rows: number, cols: number): void;
  /**
   * Flow control from the browser.
   *
   * `SshSession` exposes `pauseOutput`/`resumeOutput`, which pause the underlying channel,
   * so a slow renderer applies real backpressure to the remote host instead of forcing us
   * to drop bytes. That is the difference between a terminal that can survive `yes` and
   * one that quietly loses output.
   */
  setPaused(paused: boolean): void;
  close(): void;
  /**
   * This session's Host-side id — the same `terminalId` the observer announced.
   *
   * Handed back so the browser can scope its SFTP reads to **this** terminal. It has to be
   * the Host's id and not the browser's own `TERMINAL_ID`: the file tree is read over HTTP
   * (`POST /rpc`), which has no WebSocket and therefore no way to tell which tab asked, so
   * the only way to keep two tabs' file trees apart is for the caller to name the terminal it
   * means. With one terminal the Host could pick "the live one"; with several there is no
   * such thing.
   */
  readonly terminalId: string;
}

export interface DshTerminalOpenOptions {
  serverId: string;
  rows: number;
  cols: number;
  emit(event: DshTerminalEvent): void;
}

export interface DshTerminalApi {
  open(options: DshTerminalOpenOptions): Promise<DshTerminalSession>;
  /**
   * Record a fingerprint the user accepted, so the next connect succeeds.
   *
   * `host`/`port` are the host the refusal was actually about. They are **not** always the
   * server's own address — a jump-host connect verifies the jump host's key first — so
   * when they are supplied they decide what gets recorded. Omitting them keeps the old
   * behaviour (record against the server itself), which is what a client that never
   * received a host on the event still does.
   */
  trustHost(request: {
    serverId: string;
    fingerprint: string;
    host?: string;
    port?: number;
  }): Promise<{ trusted: true; host: string; port: number }>;
  /**
   * Drop a stored key so the next connect asks again.
   *
   * The VS Code variant has always had this (`sshManager.forgetHostKey`, plus the
   * "Forget and Reconnect" choice in its host-key-changed prompt) and the dsh port had
   * **no** equivalent — `HostKeyStore.forget` was unreachable from this surface. That is not
   * cosmetic: an entry written under the wrong address by an older build can only be
   * cleared by trusting whatever key shows up next, which asks the user to accept a
   * fingerprint they have no way to check. Forgetting puts the decision back on real
   * evidence.
   *
   * `host`/`port` follow the same rule as `trustHost` — the refused host, not necessarily
   * the server — and are bounded to the server's own jump chain for the same reason.
   */
  forgetHost(request: { serverId: string; host?: string; port?: number }): Promise<{
    forgot: boolean;
    host: string;
    port: number;
  }>;
}

/**
 * A terminal session the Host half owns, announced to whoever has to follow it.
 *
 * The SFTP tree is the reason this exists: it follows the active terminal, and this host has
 * no terminal registry to ask (the VS Code variant's `TerminalContextRegistry` is fed by
 * editor events that do not exist here — the Host half *is* the only owner of its
 * terminals). `terminalId` is drawn here rather than taken from the browser, because the
 * browser's id is per-WebSocket and two open panels would collide on it.
 */
export interface DshTerminalPresence {
  readonly terminalId: string;
  readonly server: ServerConfig;
  /** The live session's own writer — the same one `SshSession.write` is behind. */
  write(data: string): void;
}

/**
 * Told when a session goes live and when it ends.
 *
 * Deliberately not an event emitter: a dead terminal leaves the tree that followed it, and
 * "the thing you were following is gone" has to reach that tree. Synchronous and unguarded
 * by design — see `createDshTerminalApi` for why a throwing observer cannot break a connect.
 */
export interface DshTerminalObserver {
  opened(presence: DshTerminalPresence): void;
  closed(terminalId: string): void;
}

export interface DshTerminalApiOptions {
  readonly platform: Platform;
  /** Notified when a session becomes live, and when one ends. */
  readonly observer?: DshTerminalObserver;
}

/**
 * Host key policy for a headless host.
 *
 * The VS Code variant can pop a modal on an unknown key. dsh's Host half cannot, so the
 * choice is between trusting silently — which would be a MITM opening presented as
 * convenience — and refusing with enough information for the user to decide. This refuses,
 * and hands the fingerprint back through a coded event so the panel can offer
 * "trust this host" as an explicit click.
 */
function createVerifier(
  store: HostKeyStore,
  emit: (event: DshTerminalEvent) => void
): HostKeyVerifier {
  return {
    async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
      const status = await store.check(host, port, fingerprint);
      if (status === 'trusted') return true;
      emit({
        type: 'error',
        code: status === 'changed' ? 'host-key-changed' : 'host-key-unknown',
        message:
          status === 'changed'
            ? `The host key for ${host}:${port} does not match the one recorded earlier.`
            : `${host}:${port} is not a known host.`,
        fingerprint,
        // Which host refused, so the panel's trust button records the acceptance against
        // this host rather than against the server the user happened to pick. With a jump
        // host these differ, and recording the jump host's key under the target's address
        // is what made "trust, then reconnect" fail forever.
        host,
        port
      });
      return false;
    }
  };
}

export function createDshTerminalApi({ platform, observer }: DshTerminalApiOptions): DshTerminalApi {
  const configManager = new ConfigManager(platform.state, platform.secrets);
  const hostKeyStore = new HostKeyStore(platform.state);
  const live = new Set<SshSession>();

  /**
   * Decide **which** `host:port` a trust/forget request is about.
   *
   * A refusal names the host whose key was actually refused, and with a jump host that is
   * the bastion rather than the server the user picked — `buildSshConnectionHandle`
   * verifies the jump host's key first. Recording against the picked server instead is what
   * left the bastion permanently untrusted while the store *looked* updated.
   *
   * A caller-named host is honoured only when it is one this server would actually connect
   * to: itself, or a host on its jump chain. Without that bound, `terminal.trustHost` would
   * write a "trusted" key for **any** host in the store — a quieter version of the bug it
   * is fixing, and one that silently defeats host-key verification.
   *
   * `seen` alongside the loop condition because server records are hand-editable, so a
   * cycle (A jumps to B, B jumps to A) is reachable input and this walk must terminate.
   */
  async function resolveHost(
    serverId: string,
    requestedHost?: string,
    requestedPort?: number
  ): Promise<{ server: ServerConfig; host: string; port: number }> {
    const server = await configManager.getServer(serverId);
    if (server === undefined) {
      throw Object.assign(new Error(`no server with id "${serverId}"`), { code: 'no-such-server' });
    }
    const reachable = new Set<string>([`${server.host}:${server.port}`]);
    const seen = new Set<string>();
    for (let id = server.jumpHostId; id !== undefined && !seen.has(id); ) {
      seen.add(id);
      const jump = await configManager.getServer(id);
      if (jump === undefined) break;
      reachable.add(`${jump.host}:${jump.port}`);
      id = jump.jumpHostId;
    }
    const asked =
      typeof requestedHost === 'string' && requestedHost !== ''
        ? `${requestedHost}:${typeof requestedPort === 'number' ? requestedPort : ''}`
        : undefined;
    const useServer = asked === undefined || !reachable.has(asked);
    return {
      server,
      host: useServer ? server.host : (requestedHost as string),
      port: useServer ? server.port : (requestedPort as number)
    };
  }

  return {
    async open(options: DshTerminalOpenOptions): Promise<DshTerminalSession> {
      const server = await configManager.getServer(options.serverId);
      if (server === undefined) {
        throw Object.assign(new Error(`no server with id "${options.serverId}"`), { code: 'no-such-server' });
      }

      const emit = options.emit;
      const session = new SshSession(
        server,
        configManager,
        {
          output(data: Buffer): void {
            emit({ type: 'output', data: data.toString('base64') });
          },
          status(status: SshSessionStatus): void {
            emit({ type: 'status', state: status.state, text: status.text });
          },
          error(error: unknown): void {
            // A refusal from the verifier has already been reported with its code; a second
            // generic error line would bury the one the user can act on. The classifier
            // preserves an existing code and only names what the error itself says.
            const failure = classifySshFailure(error, { host: server.host, port: server.port });
            emit({ type: 'error', code: failure.code, message: failure.message });
          }
        },
        createVerifier(hostKeyStore, emit),
        // Keyboard-interactive authentication needs a prompt, and this host has no dialog.
        // Leaving it undefined makes such an attempt fail cleanly instead of hanging on a
        // prompt nobody can see — the same choice the platform's port makes.
        undefined
      );

      live.add(session);
      try {
        session.resize(options.rows, options.cols);
        await session.connect();
      } catch (error) {
        live.delete(session);
        session.dispose();
        // Coded, so the panel can say what to check instead of echoing ssh2's
        // "All configured authentication methods failed" at the user.
        const failure = classifySshFailure(error, { host: server.host, port: server.port });
        throw Object.assign(new Error(failure.message), { code: failure.code });
      }

      let closed = false;
      // Announced only after the connect succeeded: a session that never opened must not
      // become a terminal the SFTP tree can choose to follow.
      const terminalId = randomUUID();
      observer?.opened({ terminalId, server, write: (data: string) => session.write(data) });
      return {
        terminalId,
        write(data: string): void {
          session.write(data);
        },
        resize(rows: number, cols: number): void {
          session.resize(rows, cols);
        },
        setPaused(paused: boolean): void {
          if (paused) session.pauseOutput();
          else session.resumeOutput();
        },
        close(): void {
          if (closed) return;
          closed = true;
          live.delete(session);
          session.dispose();
          observer?.closed(terminalId);
          emit({ type: 'closed', reason: 'requested' });
        }
      };
    },

    async trustHost(request: {
      serverId: string;
      fingerprint: string;
      host?: string;
      port?: number;
    }): Promise<{ trusted: true; host: string; port: number }> {
      const { host, port } = await resolveHost(request.serverId, request.host, request.port);
      await hostKeyStore.trust(host, port, request.fingerprint);
      return { trusted: true, host, port };
    },

    async forgetHost(request: {
      serverId: string;
      host?: string;
      port?: number;
    }): Promise<{ forgot: boolean; host: string; port: number }> {
      const { host, port } = await resolveHost(request.serverId, request.host, request.port);
      // Reported, never assumed: forgetting a host that has no stored key is a no-op the
      // caller should be able to see, because "I cleared it" and "there was nothing to clear"
      // mean different things when the next refusal does not go away.
      const forgot = hostKeyStore.getTrusted(host, port) !== undefined;
      if (forgot) await hostKeyStore.forget(host, port);
      return { forgot, host, port };
    }
  };
}
