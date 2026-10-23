/**
 * The styles chunk: three stylesheets and the scoper that makes them safe to inject.
 *
 * `styles.ts` is the single largest module in the client half (77 413 B, 18.5% of the entry)
 * because it carries the terminal, panel and shared stylesheets as strings and rewrites every
 * selector under `.att-root`. None of that is needed to *register* the tab types — only to
 * render a surface — so it lives here and is fetched by `require.async('./client.styles.js')`
 * the first time one of our surfaces mounts.
 *
 * Only `ensureStyles` is re-exported: the entry has no other reason to reach into this module,
 * and a second export would be a second way to drag the stylesheets back into the entry.
 */
export { ensureStyles } from './styles';
