/**
 * The styles gate: load the styles chunk before the first surface paints, not at boot.
 *
 * `styles.ts` is 77 413 B — 18.5% of the client entry — because it carries three stylesheets
 * as strings plus the scoper. The entry used to inject them in `apply()`, which means **every**
 * Harness boot paid for them, including the common session that never opens this panel. They
 * are only needed to *render* a surface, so the fetch is now attached to the first render.
 *
 * ## Why a wrapper and not a call at each mount site
 *
 * There are seven surfaces: the three pane bodies, the monitor HUD, the settings tab, the
 * conversation header button and the tool-call row. A call at each site is seven chances to
 * forget, and the symptom (one surface, unstyled) is not something a gate here could catch.
 * Wrapping makes a new surface inherit the behaviour by construction.
 *
 * ## What happens when the chunk cannot load
 *
 * The surface renders **unstyled** and the failure is kept for the log. Hiding the panel would
 * turn a cosmetic problem into "the plugin is broken", and the panel is usable without CSS:
 * every class is a styling hook, not a behaviour. (The terminal view is the exception, but it
 * carries its own chunk and already reports its own failure.)
 */

import React, { useEffect, useState, type ReactElement } from 'react';
import { loadStylesChunk } from './chunkLoader';
import { h } from './views/shared';

let ready = false;
let pending: Promise<void> | undefined;
let dispose: (() => void) | undefined;
let failure: string | undefined;

/** Whether the stylesheet is in the document. Exported for the gate and for tests. */
export function stylesReady(): boolean {
  return ready;
}

/** The reason the chunk failed, if it did. `undefined` before the first attempt. */
export function stylesFailure(): string | undefined {
  return failure;
}

/**
 * Fetch the styles chunk once and inject it.
 *
 * Single-flight: several surfaces can mount in the same tick (a restored sidebar restores
 * three tabs), and each would otherwise start its own fetch and its own `<style>` element.
 * Resolves even on failure — the caller's job is to render, not to handle a stylesheet.
 */
export function ensureStylesLoaded(): Promise<void> {
  if (ready) return Promise.resolve();
  pending ??= loadStylesChunk()
    .then((module) => {
      dispose = module.ensureStyles(document);
      ready = true;
    })
    .catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      // Rendered unstyled is the honest degrade; a blank panel would look like a crash.
      ready = true;
    });
  return pending;
}

/** Remove the injected stylesheet. Called when the plugin unloads. */
export function disposeStyles(): void {
  dispose?.();
  dispose = undefined;
  ready = false;
  pending = undefined;
}

/**
 * Render `Component` once the stylesheet is in place.
 *
 * The first render of any surface returns `null` for the duration of one chunk fetch (a few
 * milliseconds over the app protocol). Rendering immediately instead would paint the panel
 * unstyled and then restyle it, which reads as a flicker on every open.
 */
export function withStyles<P = any>(
  Component: (props: P) => unknown
): (props: P) => ReactElement | null {
  return function StyledSurface(props: P): ReactElement | null {
    const [settled, setSettled] = useState(ready);
    useEffect(() => {
      if (settled) return undefined;
      let alive = true;
      void ensureStylesLoaded().then(() => {
        if (alive) setSettled(true);
      });
      return () => {
        alive = false;
      };
    }, [settled]);
    if (!settled) return null;
    return h(Component as never, props as never);
  };
}
