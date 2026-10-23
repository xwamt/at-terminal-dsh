import type { Platform } from '../core/ports';

/**
 * One platform per **process**, not per copy of this module.
 *
 * The dsh side ships two bundles (`host.bundle.js` and `terminal.bundle.js`) that the loader
 * mounts in the same Node process but that are built separately, so each carries its own
 * compiled copy of this file. A module-local variable therefore gives each bundle a *different*
 * "current" platform — and on the real Harness that was not a cosmetic difference: the opt-in
 * terminal bundle, unable to see the host bundle's platform, assembled a second one, and the
 * dsh state domain can only be opened once. The first `terminal_open` failed with
 * `domain 'at_terminal_state' is already open`.
 *
 * Keeping the slot on `globalThis` under a registered symbol fixes the seam without merging the
 * bundles: both copies read and write the same slot, which is what "one process, one platform"
 * has to mean. The symbol is registered (`Symbol.for`) rather than unique so a *reload* of
 * either bundle lands on the same key instead of leaving a stale platform behind.
 */
const SLOT = Symbol.for('at-terminal.platform');

interface Slot {
  current?: Platform;
  /**
   * The assembly in flight, if any.
   *
   * Published so a second bundle can wait for the first instead of opening the same storage
   * domain again. It settles to `undefined` either way: a waiter that still finds no platform
   * after this resolves had a failed assembly to begin with, and rethrowing that failure from
   * here would report it twice with the wrong stack.
   */
  pending?: Promise<void>;
}

function slot(): Slot {
  const store = globalThis as unknown as Record<symbol, Slot | undefined>;
  let existing = store[SLOT];
  if (existing === undefined) {
    existing = {};
    store[SLOT] = existing;
  }
  return existing;
}

/**
 * Installs the platform bundle. Called exactly once by the composition root at
 * activation — `src/extension.ts` (`setPlatform(createVscodePlatform(context))`)
 * on the VS Code side, `src/platform/dsh/index.ts` (`createDshPlatform`) on the
 * dsh side. Both hand the same domain layer a different `Platform`.
 */
export function setPlatform(value: Platform): void {
  slot().current = value;
}

/**
 * Removes the installed bundle.
 *
 * The dsh Host half calls this when its assembly is torn down (plugin disabled or
 * reloaded). Without it, domain code running after teardown would keep reading a
 * platform whose state store is already closed — writes that go nowhere look like
 * successes. Clearing turns that into the explicit error above instead: a window
 * where the services are genuinely absent.
 *
 * `expected` guards an unload that races a reload: a teardown may only clear the
 * bundle it installed, never one a newer assembly has already put in its place.
 */
export function clearPlatform(expected?: Platform): void {
  if (expected !== undefined && slot().current !== expected) return;
  slot().current = undefined;
}

/**
 * Returns the installed platform bundle. Throws when the composition root has
 * not run — never silently returns a stub, so a forgotten `setPlatform()` call
 * surfaces as an explicit error instead of a no-op adapter.
 */
export function platform(): Platform {
  const { current } = slot();
  if (current === undefined) {
    throw new Error(
      'AT Terminal: platform not installed; extension activation must call setPlatform()'
    );
  }
  return current;
}

/**
 * Announce that an assembly is running, so another bundle in this process can wait for it.
 *
 * Returns the promise it was given, so a call site reads as if the wrapper were not there.
 */
export function trackPlatformAssembly<T>(assembly: Promise<T>): Promise<T> {
  const settled = assembly.then(
    () => undefined,
    () => undefined
  );
  const state = slot();
  state.pending = settled;
  void settled.then(() => {
    // Only clear our own entry: a reload may already have published a newer assembly.
    if (state.pending === settled) delete state.pending;
  });
  return assembly;
}

/** The assembly another bundle has announced, if one is still running. */
export function pendingPlatformAssembly(): Promise<void> | undefined {
  return slot().pending;
}
