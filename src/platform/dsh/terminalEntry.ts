/**
 * The opt-in bundle's plugin: register the `ssh` PTY backend.
 *
 * This is a **separate cordis row** from `dsh/index.js`, loaded inside a group that isolates
 * `terminals` (see `terminal-ssh/cordis.patch.yml`). The isolation is what makes the feature
 * opt-in and additive: that group gets its own `@deepseek-ai/dsh-terminal` registry and its own
 * copy of `dsh-tool-terminal`, so a profile without this bundle behaves exactly as before, and
 * one with it gains `terminal_*` tools that speak SSH — without touching the right-sidebar
 * terminal, which is a different subsystem (`api-terminal-controller` does not consume
 * `ctx.terminals`).
 *
 * ## Where the server comes from
 *
 * `terminal_open` takes `{ type, name?, cwd? }` — verified in `dsh-tool-terminal` 0.2.1-rc.2,
 * there is **no** `serverId` parameter. So `name` is the selector, and this entry resolves it
 * against the configured servers by **id first, then label**. Labels are accepted because a
 * model reading `at_terminal_list_ssh_servers` sees labels and ids, and forcing it to copy an id
 * it was never shown would be a coin flip per call. Ambiguity is refused, never resolved: two
 * servers can share a label, and silently picking one is exactly the bug S5-04 removed from the
 * tool layer.
 *
 * ## The platform, and why this reuses before it builds
 *
 * `src/platform/current.ts` holds one process-wide `Platform`, and `createDshPlatform()`
 * installs it. Building a second one unconditionally would **replace** the main bundle's, and
 * every domain call (`SshSession`, credentials, notifications) reads whichever is current — so
 * a second assembly is a hazard, not a detail. Normal case: the main bundle applied first, its
 * platform is installed, and this entry borrows it. The fallback exists only for a profile that
 * enables this group first, and it is a real assembly rather than a stub.
 */

import { createDshPlatform } from './index';
import { createDshServerApi, createDshTerminalApi } from './services';
import type { Platform } from '../../core/ports';
import { platform } from '../../platform/current';
import { createSshTerminalBackend, type SshConnection } from './terminalBackend/sshBackend';

/** Plugin name, as it appears in the loader tree. */
export const name = 'at-terminal-ssh-backend';

/** Without the registry there is nothing to register into. */
export const inject = ['terminals'];

/** Geometry requested when the SSH session opens a pty. */
const ROWS = 40;
const COLS = 120;

interface ServerRow {
  id: string;
  label: string;
}

interface TerminalEvent {
  type: string;
  data?: string;
  state?: string;
}

interface TerminalApi {
  open(options: {
    serverId: string;
    rows: number;
    cols: number;
    emit(event: TerminalEvent): void;
  }): Promise<{ write(data: string): void; close(): void; terminalId: string }>;
}

/**
 * Turn the model-supplied `name` into a server id.
 *
 * Exported for the test: the three outcomes (id hit, unique label, ambiguous/unknown) are the
 * whole contract of the selector, and they are cheaper to assert here than through a live
 * `terminal_open`.
 */
export function resolveServerByName(servers: ServerRow[], name: string): ServerRow {
  const exactId = servers.find((server) => server.id === name);
  if (exactId !== undefined) return exactId;
  const byLabel = servers.filter((server) => server.label === name);
  if (byLabel.length === 1) return byLabel[0] as ServerRow;
  if (byLabel.length > 1) {
    throw new Error(
      `at-terminal: ${byLabel.length} servers are labelled "${name}" (${byLabel
        .map((server) => server.id)
        .join(', ')}); pass the server id instead.`
    );
  }
  const known = servers.slice(0, 8).map((server) => `${server.id} (${server.label})`);
  throw new Error(
    `at-terminal: no SSH server matches "${name}". Known servers: ${known.join(', ')}${
      servers.length > known.length ? `, +${servers.length - known.length} more` : ''
    }.`
  );
}

/** Everything a spawn needs, assembled once on first use. */
interface Prepared {
  api: TerminalApi;
  servers: () => Promise<ServerRow[]>;
}

/** Reuse the installed platform when there is one; otherwise assemble and keep it. */
async function assemble(scoped: {
  logger?: unknown;
  storageDomain?: unknown;
  credentials?: unknown;
}): Promise<Prepared> {
  let resolved: Platform;
  try {
    resolved = platform();
  } catch {
    const handle = await createDshPlatform({
      // No settings row: this entry has no form of its own, so the platform takes its
      // documented defaults instead of inventing values the main bundle does not use.
      logger: scoped.logger as never,
      credentials: scoped.credentials as never,
      storageDomain: scoped.storageDomain as never,
      // No settings row of its own; an empty object is the documented "all defaults" case.
      settings: {},
      facts: {
        pluginName: '@at-series/dsh-at-terminal-ssh',
        pluginVersion: '0.1.0',
        bundlePath: '',
        storageDir: '',
        appName: 'DeepSeek Harness',
        appRoot: '',
        uriScheme: 'dsh'
      }
    });
    resolved = handle.platform;
  }
  const serverApi = createDshServerApi({ platform: resolved, privateKeyDirectory: '' });
  return {
    api: createDshTerminalApi({ platform: resolved }) as unknown as TerminalApi,
    servers: async () => {
      const listed = (await serverApi.list()) as { servers?: ServerRow[] };
      return listed.servers ?? [];
    }
  };
}

/** One connect, forwarding bytes and end-of-session to the session adapter. */
async function connect(
  prepared: Prepared,
  name: string,
  handlers: { output(text: string): void; exit(info: { exitCode: number | null; signal: string | null }): void }
): Promise<SshConnection> {
  const server = resolveServerByName(await prepared.servers(), name);
  const session = await prepared.api.open({
    serverId: server.id,
    rows: ROWS,
    cols: COLS,
    emit(event) {
      if (event.type === 'output' && typeof event.data === 'string') {
        // The terminal face base64-encodes output so a byte stream survives JSON; the
        // registry's `read`/`viewport` contract is text, so decode once, here.
        handlers.output(Buffer.from(event.data, 'base64').toString('utf8'));
        return;
      }
      if (event.type === 'status' && event.state === 'closed') {
        handlers.exit({ exitCode: null, signal: null });
        return;
      }
      if (event.type === 'error') {
        // A connect failure must reach the spawn caller as a rejection: `start()` waits for a
        // prompt, and an error nobody forwards becomes a 30-second hang that reads exactly
        // like a slow host.
        handlers.exit({ exitCode: null, signal: null });
      }
    }
  });
  return { write: (data: string) => session.write(data), close: () => session.close() };
}

/**
 * Register the backend once `terminals`, storage and credentials are all present.
 *
 * The assembly is lazy: `terminal_open` is rare, and opening the state store at plugin load
 * would add a disk read to every Harness start for a feature most profiles never use.
 */
export function apply(ctx: {
  inject(names: string[], callback: (scoped: Record<string, unknown>) => void): unknown;
}): void {
  ctx.inject(['terminals', 'storageDomain', 'credentials'], (scoped) => {
    const terminals = scoped.terminals as { registerBackend(backend: unknown): () => void } | undefined;
    if (terminals === undefined) return;
    let prepared: Promise<Prepared> | undefined;
    const prepare = (): Promise<Prepared> => {
      prepared ??= assemble(scoped);
      return prepared;
    };
    terminals.registerBackend(
      createSshTerminalBackend({
        type: 'ssh',
        rows: ROWS,
        cols: COLS,
        open: async (
          name: string,
          handlers: { output(text: string): void; exit(info: { exitCode: number | null; signal: string | null }): void }
        ) => connect(await prepare(), name, handlers)
      })
    );
  });
}
