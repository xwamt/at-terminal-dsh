/**
 * The lazy shell around the terminal pane.
 *
 * `views/terminal.ts` is the only module in this client that pulls xterm and its addons at
 * runtime, and xterm is ~410 kB of the 1 022 198 B entry. Loading it with the entry means every
 * page load pays for a panel that may never be opened — measured: the client applies 1.9 s after
 * process start whether or not anyone opens the tab.
 *
 * So the entry keeps this module, which imports **nothing** from `views/terminal` except the
 * prop type (erased at build time), and asks the chunk for the component on first render. The
 * public name and props are identical, which keeps the call site's change to one import line.
 *
 * Why not `React.lazy`: this codebase renders through `h = React.createElement` and has no
 * `Suspense` boundary anywhere, while the local `react.d.ts` declares neither `lazy` nor
 * `Suspense`. An effect that swaps in the resolved component needs neither.
 *
 * The three-state machine below is not decoration. The first version kept only the component
 * plus a bare `failure` string, and a failed chunk load rendered **null forever**: the catch set
 * the component back to the value it already had, React bailed out on the identical state, and
 * no re-render ever showed the reason. A blank pane with no message is the worst outcome
 * available here, so the state itself carries what happened.
 */

import { useEffect, useState } from 'react';

import { loadTerminalChunk } from '../chunkLoader';
import type { TerminalViewProps } from './terminal';
import { h } from './shared';

/** The resolved component, once the chunk has been fetched. */
type ViewComponent = (props: TerminalViewProps) => unknown;

interface PaneState {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly view?: ViewComponent;
  readonly message?: string;
}

/** Module-level cache: the chunk is fetched once per page, not once per session tab. */
let settled: PaneState = { status: 'loading' };
let pending: Promise<PaneState> | undefined;

function load(): Promise<PaneState> {
  if (settled.status !== 'loading') return Promise.resolve(settled);
  pending ??= loadTerminalChunk().then(
    (chunk) => {
      settled = { status: 'ready', view: chunk.TerminalView as ViewComponent };
      return settled;
    },
    (error: unknown) => {
      // Cached, not retried: one broken deploy must not turn into a fetch loop.
      settled = {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      };
      return settled;
    }
  );
  return pending;
}

/** The terminal pane; renders the real view once its chunk has loaded. */
export function TerminalView(props: TerminalViewProps): unknown {
  const [state, setState] = useState<PaneState>(settled);

  useEffect(() => {
    if (state.status !== 'loading') return;
    let cancelled = false;
    void load().then((next) => {
      // Always a **new** object: an identical state would let React bail out on a failure and
      // leave the pane blank instead of showing the reason.
      if (!cancelled) setState({ ...next });
    });
    return () => {
      cancelled = true;
    };
  }, [state.status]);

  if (state.status === 'ready' && state.view !== undefined) {
    return h(state.view, props as unknown as Record<string, unknown>);
  }
  if (state.status === 'failed') {
    return h(
      'div',
      { className: 'at-terminal-chunk-error', role: 'alert' },
      `终端组件加载失败：${state.message ?? 'unknown error'}`
    );
  }
  // Still fetching: a local file, so this is a frame or two, and a spinner would flash more
  // than it explains.
  return null;
}
