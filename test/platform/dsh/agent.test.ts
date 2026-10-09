import { describe, it, expect, vi } from 'vitest';
import { createDshAgentToolService } from '../../../src/platform/dsh/agent';
import { TerminalContextRegistry } from '../../../src/terminal/TerminalContext';
import { createFakePlatform } from '../../core/fakes';

describe('createDshAgentToolService', () => {
  it('instantiates AgentToolService with all SSH/SFTP and security dependencies', async () => {
    const platform = createFakePlatform();
    const service = createDshAgentToolService({
      platform,
      resolveApproval: () => undefined,
      getCurrentCallContext: () => undefined
    });

    expect(service).toBeDefined();
    const servers = await service.listServers();
    expect(Array.isArray(servers.servers)).toBe(true);

    const context = await service.getTerminalContext();
    expect(context).toHaveProperty('connectedTerminals');
    expect(context).toHaveProperty('knownTerminals');
  });

  it('wires approval and confirmation into agent execution flow', async () => {
    const platform = createFakePlatform();
    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once')
    };

    const service = createDshAgentToolService({
      platform,
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'test-agent', callId: 'call-1' })
    });

    // Save a server into platform state
    const serverConfig = {
      id: 'srv-1',
      label: 'Test Server',
      host: '127.0.0.1',
      port: 22,
      username: 'user',
      authType: 'password',
      backgroundConnectionAllowed: true,
      agentCommandTrust: 'none' as const,
      agentCommandAutoApprove: false,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    };
    await platform.state.update('sshManager.servers', [serverConfig]);

    // runRemoteCommand will check authorization -> needs approval -> asks mockApproval
    // executor will fail connecting to 127.0.0.1, but approval is triggered before executor.execute
    await expect(
      service.runRemoteCommand({ serverId: 'srv-1', command: 'uptime' })
    ).rejects.toThrow();

    expect(mockApproval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'run_remote_command',
        agent: 'test-agent'
      })
    );
  });

  it('auto-approves read-only commands under policy trust without triggering approval', async () => {
    const platform = createFakePlatform();
    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once')
    };

    const service = createDshAgentToolService({
      platform,
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'test-agent', callId: 'call-read' })
    });

    const serverConfig = {
      id: 'srv-policy',
      label: 'Policy Server',
      host: '127.0.0.1',
      port: 22,
      username: 'user',
      authType: 'password' as const,
      backgroundConnectionAllowed: true,
      agentCommandTrust: 'policy' as const,
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    };
    await platform.state.update('sshManager.servers', [serverConfig]);

    // uptime is evaluated as allow by policy runtime -> autoApprove: true -> no approval dialog
    // execution fails at SSH connection (127.0.0.1 not listening), which proves approval was skipped!
    await expect(
      service.runRemoteCommand({ serverId: 'srv-policy', command: 'uptime' })
    ).rejects.toThrow();

    expect(mockApproval.request).not.toHaveBeenCalled();
  });

  it('triggers destructive approval for state-changing commands under policy trust', async () => {
    const platform = createFakePlatform();
    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once')
    };

    const service = createDshAgentToolService({
      platform,
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'test-agent', callId: 'call-write' })
    });

    const serverConfig = {
      id: 'srv-policy-write',
      label: 'Policy Server',
      host: '127.0.0.1',
      port: 22,
      username: 'user',
      authType: 'password' as const,
      backgroundConnectionAllowed: true,
      agentCommandTrust: 'policy' as const,
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    };
    await platform.state.update('sshManager.servers', [serverConfig]);

    await expect(
      service.runRemoteCommand({ serverId: 'srv-policy-write', command: 'rm -rf /tmp/test-folder' })
    ).rejects.toThrow();

    expect(mockApproval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'run_remote_command',
        agent: 'test-agent',
        reason: '⚠️ Destructive command warning: rm -rf /tmp/test-folder',
        displayReason: expect.stringContaining('⚠️ Destructive command warning: this command appears destructive!')
      })
    );
  });

  it('auto-approves destructive commands under full trust', async () => {
    const platform = createFakePlatform();
    const mockApproval = {
      request: vi.fn().mockResolvedValue('allowed-once')
    };

    const service = createDshAgentToolService({
      platform,
      resolveApproval: () => mockApproval,
      getCurrentCallContext: () => ({ agent: 'test-agent', callId: 'call-full' })
    });

    const serverConfig = {
      id: 'srv-full',
      label: 'Full Trust Server',
      host: '127.0.0.1',
      port: 22,
      username: 'user',
      authType: 'password' as const,
      backgroundConnectionAllowed: true,
      agentCommandTrust: 'full' as const,
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    };
    await platform.state.update('sshManager.servers', [serverConfig]);

    await expect(
      service.runRemoteCommand({ serverId: 'srv-full', command: 'rm -rf /tmp/test-folder' })
    ).rejects.toThrow();

    expect(mockApproval.request).not.toHaveBeenCalled();
  });

  it('synchronizes terminal context and marks servers connected in listServers', async () => {
    const platform = createFakePlatform();
    const terminalContext = new TerminalContextRegistry();

    const serverConfig = {
      id: 'srv-interactive',
      label: 'Interactive Server',
      host: '192.168.1.10',
      port: 22,
      username: 'ops',
      authType: 'password' as const,
      backgroundConnectionAllowed: false,
      agentCommandTrust: 'policy' as const,
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8' as const,
      createdAt: 1,
      updatedAt: 1
    };
    await platform.state.update('sshManager.servers', [serverConfig]);

    const service = createDshAgentToolService({
      platform,
      terminalContext,
      resolveApproval: () => undefined,
      getCurrentCallContext: () => undefined
    });

    const beforeServers = await service.listServers();
    expect(beforeServers.servers).toHaveLength(0);

    terminalContext.setActive({
      terminalId: 'term-1',
      server: serverConfig,
      connected: true,
      write: () => {}
    });

    const afterServers = await service.listServers();
    expect(afterServers.servers).toHaveLength(1);
    expect(afterServers.servers[0]).toMatchObject({
      id: 'srv-interactive',
      connected: true
    });

    const context = await service.getTerminalContext();
    expect(context.focusedTerminal).toMatchObject({
      terminalId: 'term-1',
      serverId: 'srv-interactive'
    });
  });

  it('correctly provides hostKeyVerifier with verify method to executor and sftp', async () => {
    const platform = createFakePlatform();
    // Pre-trust a host in state
    await platform.state.update('sshManager.trustedHostKeys', {
      '127.0.0.1:22': {
        host: '127.0.0.1',
        port: 22,
        fingerprint: 'test-fingerprint',
        trustedAt: Date.now()
      }
    });

    const service = createDshAgentToolService({
      platform,
      resolveApproval: () => undefined,
      getCurrentCallContext: () => undefined
    });

    // Directly assert that executor's hostKeyVerifier has verify function
    const executor = (service as any).dependencies.executor;
    expect(executor).toBeDefined();
    const verifier = (executor as any).hostKeyVerifier;
    expect(verifier).toBeDefined();
    expect(typeof verifier.verify).toBe('function');

    const trusted = await verifier.verify('127.0.0.1', 22, 'test-fingerprint');
    expect(trusted).toBe(true);

    const untrusted = await verifier.verify('127.0.0.1', 22, 'different-fingerprint');
    expect(untrusted).toBe(false);
  });
});
