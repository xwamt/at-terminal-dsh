/**
 * Loading a package-local chunk.
 *
 * The host builds the factory's `require` in `dsh-client-modules` and hangs one extra method
 * on it: `require.async(spec)` (`lib/client.js:842`). A `./`-relative spec is resolved as a
 * **chunk of this package** — the file must sit next to `client.js`, match
 * `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`, and register itself with the same package id
 * plus a `chunk` field (`lib/client.js:606-616`, and the official
 * `dsh-client-ui-sidebar-terminal` chunk does exactly that). Anything else goes through the
 * module table.
 *
 * `require` here is the **factory parameter**, not Node's. It only exists because this module
 * is bundled into the wrapper's `factory: (require) => { … }`, which is why the client build
 * must stay `format: 'cjs'`: in an ESM emit, `require` would be a free identifier esbuild
 * rewrites or drops, and the chunk would never load.
 */

/** The chunks this bundle ships, relative to `client.js`. Must match the build. */
export const TERMINAL_CHUNK = './client.xterm.js';
export const STYLES_CHUNK = './client.styles.js';

/** Shape of what the chunk exports; declared here so the entry needs no static import. */
export interface TerminalChunkModule {
  TerminalView: (props: unknown) => unknown;
}

/** The styles chunk: one function, deliberately. See `stylesChunk.ts`. */
export interface StylesChunkModule {
  ensureStyles(doc: Document): () => void;
}

/**
 * The factory's `require`, as the host hands it over.
 *
 * Declared locally rather than relying on `@types/node`: `require` is not a browser name, and
 * the only reason it resolves at runtime is the wrapper. Typos here fail loudly at the first
 * load — `async` missing means the host build predates chunks, and saying so beats a blank
 * panel.
 */
declare const require: {
  async?: (specifier: string) => Promise<unknown>;
};

/**
 * Fetch and register the terminal chunk.
 *
 * @throws when the host's `require` has no `async`, so the caller can show the reason instead
 * of an empty pane.
 */
export async function loadTerminalChunk(): Promise<TerminalChunkModule> {
  const asyncRequire = require?.async;
  if (typeof asyncRequire !== 'function') {
    throw new Error(
      'the Host module loader has no require.async(); the terminal chunk cannot be fetched (client.js must be loaded through __ModuleLoader__)'
    );
  }
  const loaded = await asyncRequire.call(require, TERMINAL_CHUNK);
  const view = (loaded as Partial<TerminalChunkModule> | undefined)?.TerminalView;
  if (typeof view !== 'function') {
    throw new Error(`the terminal chunk ${TERMINAL_CHUNK} did not export TerminalView`);
  }
  return { TerminalView: view };
}

/**
 * Fetch and register the styles chunk.
 *
 * Same contract as {@link loadTerminalChunk}, with one difference in how the caller treats a
 * failure: a missing terminal view must show the reason (an empty pane is indistinguishable
 * from a slow host), while missing styles must **not** hide the panel — see `stylesGate.ts`,
 * which renders the surface unstyled and records the failure instead.
 */
export async function loadStylesChunk(): Promise<StylesChunkModule> {
  const asyncRequire = require?.async;
  if (typeof asyncRequire !== 'function') {
    throw new Error(
      'the Host module loader has no require.async(); the styles chunk cannot be fetched (client.js must be loaded through __ModuleLoader__)'
    );
  }
  const loaded = await asyncRequire.call(require, STYLES_CHUNK);
  const ensureStyles = (loaded as Partial<StylesChunkModule> | undefined)?.ensureStyles;
  if (typeof ensureStyles !== 'function') {
    throw new Error(`the styles chunk ${STYLES_CHUNK} did not export ensureStyles`);
  }
  return { ensureStyles };
}
