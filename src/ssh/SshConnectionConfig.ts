import { readFile } from 'node:fs/promises';
import type { ConnectConfig, VerifyCallback } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import { attachKeyboardInteractive, type KeyboardInteractivePrompt } from './KeyboardInteractive';
import { getSsh2 } from './ssh2Loader';

export interface PasswordProvider {
  getPassword(id: string): Promise<string | undefined>;
  /**
   * Optional so pre-passphrase implementers (e.g. SftpTypes' PasswordSource) still
   * satisfy the interface; absent means "no stored passphrase". An encrypted key
   * without a passphrase fails ssh2's key parse with its own clear error.
   */
  getPassphrase?(id: string): Promise<string | undefined>;
}

export interface ServerLookup {
  getServer(id: string): Promise<ServerConfig | undefined>;
}

export type SshConnectionProvider = PasswordProvider & Partial<ServerLookup>;

export interface SshConnectOptions {
  /**
   * Answers keyboard-interactive rounds (2FA, PAM). When absent, a server that asks
   * for one gets its connection aborted with a clear error instead of hanging --
   * background paths (agent SFTP, pooled command executors) have no UI to prompt.
   */
  keyboardInteractivePrompt?: KeyboardInteractivePrompt;
}

export interface SshConnectionHandle {
  config: ConnectConfig;
  dispose(): void;
}

export interface HostKeyVerifier {
  verify(host: string, port: number, hashedKey: string): Promise<boolean>;
}

const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/**
 * ssh2 accepts any host key when `hostVerifier` is absent, so a missing verifier is a silent
 * MITM opening rather than a degraded mode. Callers are typed to always supply one; this guards
 * the untyped edges (JS callers, structurally-typed injection) by failing closed.
 */
export function requireHostKeyVerifier(hostKeyVerifier: HostKeyVerifier | undefined): HostKeyVerifier {
  if (!hostKeyVerifier) {
    throw new Error(
      'A host key verifier is required. Refusing to open an SSH connection that would accept any host key.'
    );
  }
  return hostKeyVerifier;
}

/**
 * Where ssh2 should reach the SSH agent. Parameters exist for tests; production callers
 * use the process defaults.
 */
export function resolveAgentSocket(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.SSH_AUTH_SOCK) {
    return env.SSH_AUTH_SOCK;
  }
  if (platform === 'win32') {
    return WINDOWS_OPENSSH_AGENT_PIPE;
  }
  throw new Error(
    'Missing SSH agent socket. Set the SSH_AUTH_SOCK environment variable or start an SSH agent.'
  );
}

export async function buildSshConnectConfig(
  server: ServerConfig,
  passwordProvider: PasswordProvider,
  hostKeyVerifier: HostKeyVerifier
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    keepaliveInterval: server.keepAliveInterval * 1000,
    // 2FA-style prompts arrive as keyboard-interactive requests. Opting in is harmless
    // for servers that never send one, and every connect path attaches
    // attachKeyboardInteractive so an unanswerable request fails fast instead of hanging.
    tryKeyboard: true,
    hostHash: 'sha256',
    hostVerifier: createHostVerifier(server, requireHostKeyVerifier(hostKeyVerifier))
  };

  if (server.authType === 'password') {
    const password = await passwordProvider.getPassword(server.id);
    if (!password) {
      // The `code` is what a host without a dialog renders as actionable copy; the
      // message is unchanged for the VS Code variant, which shows it verbatim.
      throw Object.assign(
        new Error('Missing password. Edit the server configuration and enter a password.'),
        { code: 'password-missing' }
      );
    }
    return { ...base, password };
  }

  if (server.authType === 'agent') {
    return { ...base, agent: resolveAgentSocket() };
  }

  if (!server.privateKeyPath) {
    throw Object.assign(new Error('Missing private key path.'), { code: 'private-key-path-missing' });
  }

  const passphrase = await passwordProvider.getPassphrase?.(server.id);
  return {
    ...base,
    privateKey: await readFile(server.privateKeyPath, 'utf8'),
    ...(passphrase === undefined ? {} : { passphrase })
  };
}

/** Hard ceiling on a jump chain, so a hand-edited store cannot build an unbounded tunnel. */
const MAX_JUMP_DEPTH = 5;

export async function buildSshConnectionHandle(
  server: ServerConfig,
  provider: SshConnectionProvider,
  hostKeyVerifier: HostKeyVerifier,
  options: SshConnectOptions = {}
): Promise<SshConnectionHandle> {
  return buildSshConnectionHandleRecursive(server, provider, hostKeyVerifier, options, [server.id]);
}

/**
 * Build one connection to `server`, recursively building the tunnel through its jump host.
 *
 * The first version called `buildSshConnectConfig({ ...jumpHost, jumpHostId: undefined })`,
 * which flattened a chain: for `Local -> Bastion A -> Bastion B -> Target`, the hop through
 * Bastion A vanished and Bastion B was dialled directly. Recursing on the jump host returns a
 * config that already carries the upstream `sock`; this level then opens one client to that
 * jump host and forwards the target's `host:port` through it.
 *
 * `chain` is ordered from the original target to the current server and exists to detect a
 * cycle (`a -> b -> a`) before a hand-edited store turns into an infinite connect loop.
 */
async function buildSshConnectionHandleRecursive(
  server: ServerConfig,
  provider: SshConnectionProvider,
  hostKeyVerifier: HostKeyVerifier,
  options: SshConnectOptions,
  chain: string[]
): Promise<SshConnectionHandle> {
  requireHostKeyVerifier(hostKeyVerifier);
  if (!server.jumpHostId) {
    return {
      config: await buildSshConnectConfig(server, provider, hostKeyVerifier),
      dispose: () => undefined
    };
  }

  if (!provider.getServer) {
    throw new Error('Jump host lookup is not available.');
  }

  const jumpHost = await provider.getServer(server.jumpHostId);
  if (!jumpHost) {
    throw new Error(`Jump host "${server.jumpHostId}" was not found.`);
  }
  if (chain.includes(jumpHost.id)) {
    throw new Error(`Jump host cycle detected: ${[...chain, jumpHost.id].join(' -> ')}`);
  }
  if (chain.length >= MAX_JUMP_DEPTH + 1) {
    throw new Error(
      `Jump host chain exceeds ${MAX_JUMP_DEPTH} hops: ${[...chain, jumpHost.id].join(' -> ')}`
    );
  }

  const upstreamHandle = await buildSshConnectionHandleRecursive(
    jumpHost,
    provider,
    hostKeyVerifier,
    options,
    [...chain, jumpHost.id]
  );
  const { Client } = await getSsh2();
  const jumpClient = new Client();
  /**
   * A permanent `error` listener, for the same reason as `SshSession#guardFatalErrors`.
   *
   * The `once('error', reject)` below is consumed by the first error, and ssh2 emits
   * `'error'` again when the socket dies before the handshake completed — `fatal: true`, and
   * an unhandled `'error'` **throws** in Node. `dispose()` calls `jumpClient.end()`, and a
   * jump host that hangs up during teardown is enough to escalate a closed connection into
   * an uncaught exception that kills the whole dsh host.
   */
  jumpClient.on('error', () => undefined);
  try {
    // `upstreamHandle.config` is the config for *this* jump host with its own upstream
    // `sock` already attached, so connecting through a two-level chain is the same code as
    // a direct one.
    await new Promise<void>((resolve, reject) => {
      jumpClient.once('ready', resolve);
      jumpClient.once('error', reject);
      attachKeyboardInteractive(jumpClient, options.keyboardInteractivePrompt, reject);
      jumpClient.connect(upstreamHandle.config);
    });

    const sock = await new Promise<ConnectConfig['sock']>((resolve, reject) => {
      jumpClient.forwardOut('127.0.0.1', 0, server.host, server.port, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(channel);
      });
    });

    return {
      config: {
        ...(await buildSshConnectConfig(server, provider, hostKeyVerifier)),
        sock
      },
      dispose: () => {
        // Nearest layer first: close the client using this tunnel before releasing the
        // upstream tunnel it is riding on.
        jumpClient.end();
        upstreamHandle.dispose();
      }
    };
  } catch (error) {
    jumpClient.end();
    upstreamHandle.dispose();
    throw error;
  }
}

function createHostVerifier(
  server: ServerConfig,
  hostKeyVerifier: HostKeyVerifier
): ConnectConfig['hostVerifier'] {
  const verifyHost = (fingerprint: string, verify: VerifyCallback): void => {
    void hostKeyVerifier.verify(server.host, server.port, fingerprint).then(
      verify,
      () => verify(false)
    );
  };

  return verifyHost as ConnectConfig['hostVerifier'];
}
