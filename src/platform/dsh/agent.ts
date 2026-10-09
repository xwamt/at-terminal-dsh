import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentToolService } from '../../agent/AgentToolService';
import type { RemoteCommandPolicyEvaluator } from '../../agent/loadRemoteCommandPolicy';
import { RemoteCommandExecutor } from '../../agent/RemoteCommandExecutor';
import { SftpAgentService } from '../../agent/SftpAgentService';
import { SftpWriteAuthorizer } from '../../agent/SftpWriteAuthorizer';
import { ConfigManager } from '../../config/ConfigManager';
import type { Platform } from '../../core/ports';
import { createTerminalPolicyRuntime } from '../../policy-runtime';
import { SftpSession } from '../../sftp/SftpSession';
import { HostKeyStore } from '../../ssh/HostKeyStore';
import type { HostKeyVerifier } from '../../ssh/SshConnectionConfig';
import { TerminalContextRegistry } from '../../terminal/TerminalContext';
import { DshAgentConfirmation, type DshApprovalService, type DshCallContext } from './confirmation';

export interface DshAgentServiceOptions {
  readonly platform: Platform;
  readonly resolveApproval: () => DshApprovalService | undefined;
  readonly getCurrentCallContext: () => DshCallContext | undefined;
  readonly terminalContext?: TerminalContextRegistry;
  readonly policyEvaluator?: RemoteCommandPolicyEvaluator;
}

export function resolveDshPolicyAssetDirectory(): string | undefined {
  try {
    const here = typeof __filename !== 'undefined'
      ? dirname(__filename)
      : dirname(fileURLToPath(import.meta.url));
    const localAssets = join(here, 'policy-assets');
    if (existsSync(localAssets)) return localAssets;
    const distAssets = join(here, '..', 'dist', 'policy-assets');
    if (existsSync(distAssets)) return distAssets;
  } catch {}

  try {
    const req = typeof __filename !== 'undefined'
      ? createRequire(__filename)
      : createRequire(import.meta.url);
    const pkg = req.resolve('@at-series/command-policy/package.json');
    const moduleAssets = join(dirname(pkg), 'dist', 'assets');
    if (existsSync(moduleAssets)) return moduleAssets;
  } catch {}

  return undefined;
}

export function createDshPolicyEvaluator(): RemoteCommandPolicyEvaluator {
  const assetDirectory = resolveDshPolicyAssetDirectory();
  return createTerminalPolicyRuntime(assetDirectory ? { assetDirectory } : {});
}

export function createDshAgentToolService(options: DshAgentServiceOptions): AgentToolService {
  const { platform } = options;
  const configManager = new ConfigManager(platform.state, platform.secrets);
  const hostKeyStore = new HostKeyStore(platform.state);
  const hostKeyVerifier: HostKeyVerifier = {
    async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
      const status = await hostKeyStore.check(host, port, fingerprint);
      return status === 'trusted';
    }
  };
  const terminalContext = options.terminalContext ?? new TerminalContextRegistry();
  const confirmation = new DshAgentConfirmation({
    resolveApproval: options.resolveApproval,
    getCurrentCallContext: options.getCurrentCallContext
  });
  const executor = new RemoteCommandExecutor(configManager, hostKeyVerifier);
  const writeAuthorizer = new SftpWriteAuthorizer({
    confirm: (req) => confirmation.confirmSftpWrite(req)
  });
  const sftp = new SftpAgentService({
    terminalContext,
    createSession: (target) =>
      new SftpSession(target.server, configManager, hostKeyVerifier, { allowSudoFallback: false }),
    authorizer: writeAuthorizer,
    resolveBackgroundServer: (serverId) => configManager.getServer(serverId)
  });

  const policyEvaluator = options.policyEvaluator ?? createDshPolicyEvaluator();

  return new AgentToolService({
    configManager,
    terminalContext,
    executor,
    sftp,
    confirmation,
    policyEvaluator
  });
}
