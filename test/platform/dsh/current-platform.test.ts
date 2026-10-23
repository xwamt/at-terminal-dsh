import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../core/fakes';
import {
  createDshHostFacts,
  createResolvedSettings,
  MemoryCredentialProvider,
  MemoryStorageDomain
} from './host-fakes';

/**
 * One platform per **process**, not per copy of the module.
 *
 * The dsh side loads two separately-built bundles (`host.bundle.js`, `terminal.bundle.js`) in
 * the same Node process, so each carries its own compiled copy of `src/platform/current.ts`.
 * On the real Harness that made the opt-in terminal bundle assemble a *second* platform, and
 * since `storageDomain.open()` is exclusive it died with `domain 'at_terminal_state' is already
 * open` before the first `terminal_open` could even resolve a server.
 *
 * `vi.resetModules()` reproduces exactly that topology: the second import evaluates a fresh
 * copy of the module, with its own top-level bindings — which is what a second bundle is. A
 * module-local variable would therefore be invisible across the boundary while the
 * `globalThis` slot is shared, and only the latter is correct.
 */
describe('platform registry across two module instances (S6 real-machine fix)', () => {
  it('hands the platform the first copy installed to the second copy', async () => {
    const first = await import('../../../src/platform/current');
    const installed = createFakePlatform();
    first.setPlatform(installed);

    vi.resetModules();
    const second = await import('../../../src/platform/current');

    // The assertion that failed on the real Harness: a second copy must still see one platform.
    expect(second.platform()).toBe(installed);
  });

  it('clears through either copy, and only for the platform it installed', async () => {
    const first = await import('../../../src/platform/current');
    const installed = createFakePlatform();
    first.setPlatform(installed);

    vi.resetModules();
    const second = await import('../../../src/platform/current');

    // A stale teardown (an unload racing a reload) must not clear someone else's platform.
    second.clearPlatform(createFakePlatform());
    expect(second.platform()).toBe(installed);

    second.clearPlatform(installed);
    expect(() => first.platform()).toThrow(/platform not installed/);
  });

  it('lets the second copy wait for an assembly the first copy announced', async () => {
    const first = await import('../../../src/platform/current');
    let finish!: () => void;
    const assembly = new Promise<void>((resolve) => {
      finish = resolve;
    });
    first.trackPlatformAssembly(assembly);

    vi.resetModules();
    const second = await import('../../../src/platform/current');
    // The waiter has to *see* the assembly: without this the rest of the case would pass even
    // if nothing were shared, because a resolved promise also sets `settled`.
    expect(second.pendingPlatformAssembly()).toBeDefined();
    let settled = false;
    const waited = (second.pendingPlatformAssembly() ?? Promise.resolve()).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish();
    await waited;
    expect(settled).toBe(true);
    // Cleared afterwards: a waiter that arrives later must not await a finished assembly.
    expect(second.pendingPlatformAssembly()).toBeUndefined();
  });

  it('does not make a second open of the state domain succeed — which is why we borrow', async () => {
    // The failure this whole design avoids, pinned so the reason survives a refactor: two
    // assemblies in one process cannot coexist, no matter how they are built.
    const host = new MemoryStorageDomain();
    const { createDshPlatform } = await import('../../../src/platform/dsh/index');
    const deps = {
      credentials: new MemoryCredentialProvider(),
      storageDomain: host as never,
      settings: createResolvedSettings({}),
      facts: createDshHostFacts({ storageDir: '/tmp/at-terminal-test' })
    };
    const first = await createDshPlatform({ ...deps } as never);
    await expect(createDshPlatform({ ...deps } as never)).rejects.toThrow(/already open/);
    await first.close();
  });
});
