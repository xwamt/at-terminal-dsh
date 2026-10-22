/**
 * The terminal chunk entry.
 *
 * Compiled separately into `dsh/client.xterm.js`, which is what
 * `require.async('./client.xterm.js')` fetches. Everything reachable from `views/terminal` —
 * xterm, its four addons, the reused `webview/terminal` building blocks — lands here instead
 * of in `client.js`.
 *
 * Two properties this file must keep:
 *
 * 1. It exports the component under the name the entry looks for (`TerminalView`, see
 *    `chunkLoader.ts`). A rename here is a blank pane there.
 * 2. Nothing else in the client may import this module statically, or the split is undone
 *    silently: the bundle would grow back and the chunk would be fetched anyway.
 */

export { TerminalView } from './views/terminal';
