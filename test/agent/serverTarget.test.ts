import { describe, expect, it, vi } from 'vitest';

import {
  connectedServerCandidates,
  implicitTarget,
  ServerTargetError
} from '../../src/agent/serverTarget';
import type { ServerConfig } from '../../src/config/schema';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

/**
 * Which host did the call mean — the rule itself.
 *
 * This used to have no home: both agent services repeated `getConnectedTerminal()` as the
 * fallback, so "no serverId" meant "the most recent terminal" in two places and was **written
 * down in none of them**. With one server connected that is the right answer and invisible;
 * with three it is a guess that returns a successful-looking result about the wrong machine.
 */

function server(id: string): ServerConfig {
  return {
    id,
    label: `${id}-label`,
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function terminal(terminalId: string, serverId: string) {
  return { terminalId, server: server(serverId), connected: true, write: vi.fn() };
}

/** A registry with one connected terminal per entry, in the order given. */
function registryWith(...entries: Array<[string, string]>): TerminalContextRegistry {
  const registry = new TerminalContextRegistry();
  for (const [terminalId, serverId] of entries) {
    registry.setActive(terminal(terminalId, serverId));
  }
  return registry;
}

describe('connectedServerCandidates', () => {
  it('counts servers, not terminals, and keeps the registry order', () => {
    const registry = registryWith(
      ['terminal-1', 'alpha'],
      ['terminal-2', 'beta'],
      // A second tab on alpha is the same answer to "which server".
      ['terminal-3', 'alpha']
    );

    expect(connectedServerCandidates(registry)).toEqual([
      { id: 'alpha', label: 'alpha-label' },
      { id: 'beta', label: 'beta-label' }
    ]);
  });

  it('drops disconnected terminals', () => {
    const registry = registryWith(['terminal-1', 'alpha'], ['terminal-2', 'beta']);
    registry.markDisconnected('terminal-2');

    expect(connectedServerCandidates(registry)).toEqual([{ id: 'alpha', label: 'alpha-label' }]);
  });
});

describe('implicitTarget', () => {
  it('reports single-connected without a candidate list when one server is up', () => {
    const registry = registryWith(['terminal-1', 'alpha']);
    const choice = implicitTarget(registry, 'read');

    expect(choice.resolvedBy).toBe('single-connected');
    expect(choice.context?.server.id).toBe('alpha');
    // No list: there was nothing to choose between, and a one-item "candidates" would imply
    // there had been.
    expect(choice.candidates).toBeUndefined();
  });

  it('lets a read infer, and names every candidate so the answer is auditable', () => {
    const registry = registryWith(['terminal-1', 'alpha'], ['terminal-2', 'beta'], ['terminal-3', 'gamma']);
    const choice = implicitTarget(registry, 'read');

    expect(choice.resolvedBy).toBe('implicit');
    // The most recently connected terminal still wins — the convenience is kept.
    expect(choice.context?.terminalId).toBe('terminal-3');
    expect(choice.candidates?.map((candidate) => candidate.id)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('refuses to infer for a write, and says what to pass instead', () => {
    const registry = registryWith(['terminal-1', 'alpha'], ['terminal-2', 'beta']);

    expect(() => implicitTarget(registry, 'write')).toThrow(ServerTargetError);
    try {
      implicitTarget(registry, 'write');
    } catch (error) {
      const refusal = error as ServerTargetError;
      expect(refusal.code).toBe('server-required');
      expect(refusal.candidates.map((candidate) => candidate.id)).toEqual(['alpha', 'beta']);
      // Both halves matter: the ids *and* the labels, because a model retry needs the id and a
      // human reading the transcript needs to recognise the host.
      expect(refusal.message).toContain('alpha (alpha-label)');
      expect(refusal.message).toContain('beta (beta-label)');
      expect(refusal.message).toContain('Call again with serverId');
    }
  });

  it('allows a write when only one server is connected', () => {
    const registry = registryWith(['terminal-1', 'alpha'], ['terminal-2', 'alpha']);

    const choice = implicitTarget(registry, 'write');
    expect(choice.resolvedBy).toBe('single-connected');
    expect(choice.context?.server.id).toBe('alpha');
  });

  it('returns no context when nothing is connected, leaving the message to the caller', () => {
    const choice = implicitTarget(new TerminalContextRegistry(), 'read');

    expect(choice.context).toBeUndefined();
    expect(choice.resolvedBy).toBe('single-connected');
  });
});
