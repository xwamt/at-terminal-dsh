import type { Platform } from '../core/ports';

let current: Platform | undefined;

/**
 * Installs the platform bundle. Called exactly once by the composition root at
 * activation — `src/extension.ts` (`setPlatform(createVscodePlatform(context))`)
 * on the VS Code side, `src/platform/dsh/index.ts` (`createDshPlatform`) on the
 * dsh side. Both hand the same domain layer a different `Platform`.
 */
export function setPlatform(value: Platform): void {
  current = value;
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
  if (expected !== undefined && current !== expected) return;
  current = undefined;
}

/**
 * Returns the installed platform bundle. Throws when the composition root has
 * not run — never silently returns a stub, so a forgotten `setPlatform()` call
 * surfaces as an explicit error instead of a no-op adapter.
 */
export function platform(): Platform {
  if (current === undefined) {
    throw new Error(
      'AT Terminal: platform not installed; extension activation must call setPlatform()'
    );
  }
  return current;
}