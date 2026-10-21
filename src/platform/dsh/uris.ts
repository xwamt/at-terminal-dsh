import { join as joinFsPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { UriComponents, UriLike, UriService } from '../../core/ports';

/**
 * The dsh implementation of the `UriService` port.
 *
 * ## Why an own URI type instead of a host one
 *
 * The VS Code adapter is a thin forward: `vscode.Uri` already is a `UriLike`, so
 * `file` / `joinPath` / `parse` / `from` just return host objects and `isUri` is an
 * `instanceof` check. dsh exposes no URI type at all -- its plugin surface is plain
 * JavaScript over Node -- so the port has to be *implemented*, not adapted. Node's
 * own `path` + `url` are the right substrate: they are the platform's real answer for
 * "what does a filesystem path look like" and "what does a `file:` URL look like",
 * so the dsh and VS Code adapters agree on both without either one re-deriving them.
 *
 * The class stays private to the module on purpose: handing it out would invite
 * callers to depend on members beyond `scheme` / `fsPath` / `toString`, which is
 * exactly the host-shape leak the port exists to prevent.
 */
class DshUri implements UriLike {
  constructor(
    readonly scheme: string,
    readonly fsPath: string,
    private readonly authority?: string,
    private readonly query?: string,
    private readonly fragment?: string
  ) {}

  /**
   * `file:` URIs go through `pathToFileURL` so the result is a URL a browser or an
   * `import()` can actually consume: it percent-encodes what a raw
   * `file://${fsPath}` concatenation would corrupt (spaces, `#`, `?`, non-ASCII) and
   * supplies the third slash for an absolute POSIX path. A non-`file` scheme has no
   * such encoder, so it is reassembled from its parts.
   *
   * Query and fragment are appended for both. That is not decoration: the SFTP
   * preview encodes the *local* backing file into `query` and keys its document map
   * by `uri.toString()` (`src/sftp/SftpPreview.ts`), so dropping the query here
   * would make two previews collide on one map entry.
   */
  toString(): string {
    let result =
      this.scheme === 'file'
        ? pathToFileURL(this.fsPath).toString()
        : `${this.scheme}:${this.authority === undefined ? '' : `//${this.authority}`}${this.fsPath}`;
    if (this.query !== undefined) {
      result += `?${this.query}`;
    }
    if (this.fragment !== undefined) {
      result += `#${this.fragment}`;
    }
    return result;
  }
}

/** A scheme prefix as the URI RFC defines it: a letter, then letters/digits/`+`/`-`/`.`. */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/**
 * Split a non-`file` URI's remainder into authority / path / query / fragment.
 *
 * Kept separate from `parse` because the `file` branch must *not* use it --
 * `fileURLToPath` is the only correct decoder for a filesystem path (it undoes
 * percent-encoding and normalises the exotic authority forms), and hand-splitting a
 * `file:` URL would reintroduce the encoding bugs described in `toString`.
 */
function splitNonFileParts(rest: string): {
  path: string;
  authority?: string;
  query?: string;
  fragment?: string;
} {
  const hashIndex = rest.indexOf('#');
  const fragment = hashIndex < 0 ? undefined : rest.slice(hashIndex + 1);
  const withoutFragment = hashIndex < 0 ? rest : rest.slice(0, hashIndex);

  const queryIndex = withoutFragment.indexOf('?');
  const query = queryIndex < 0 ? undefined : withoutFragment.slice(queryIndex + 1);
  let path = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex);

  let authority: string | undefined;
  if (path.startsWith('//')) {
    const slashIndex = path.indexOf('/', 2);
    authority = slashIndex < 0 ? path.slice(2) : path.slice(2, slashIndex);
    path = slashIndex < 0 ? '' : path.slice(slashIndex);
  }
  return { path, authority, query, fragment };
}

export function createDshUriService(): UriService {
  return {
    /** `Uri.file`: a local filesystem path in the `file` scheme, never a remote one. */
    file: (fsPath) => new DshUri('file', fsPath),

    joinPath: (base, ...segments) => {
      /**
       * No segments is a **no-op that returns the base unchanged**, matching the host
       * `Uri.joinPath` (which returns `this` for zero paths). Rebuilding a bare
       * `DshUri(base.scheme, base.fsPath)` instead would quietly drop a base URI's
       * query/fragment -- the preview URI is exactly the kind that carries one.
       */
      if (segments.length === 0) {
        return base;
      }
      return new DshUri(base.scheme, joinFsPath(base.fsPath, ...segments));
    },

    parse: (value) => {
      const scheme = SCHEME_PREFIX.exec(value);
      if (scheme === null) {
        /**
         * A bare path (`/tmp/a.txt`, or a relative `notes.txt`) -- which is what a
         * path round-trip through a plain string yields. The host treats it as a
         * `file` URI too, and the alternative (throwing) would turn a caller's
         * slightly-loose input into a crash inside an upload loop.
         */
        return new DshUri('file', value);
      }
      const rest = value.slice(scheme[0].length);
      if (scheme[1] === 'file') {
        try {
          return new DshUri('file', fileURLToPath(value));
        } catch {
          /**
           * A relative `file:` URL (`file:notes.txt`) is not a valid *absolute* file
           * URL, so `fileURLToPath` refuses it rather than inventing a directory.
           * Keeping the remainder verbatim is the honest degradation: the scheme is
           * still known and the caller still gets a usable `fsPath`.
           */
          return new DshUri('file', rest);
        }
      }
      const parts = splitNonFileParts(rest);
      return new DshUri(scheme[1], parts.path, parts.authority, parts.query, parts.fragment);
    },

    /**
     * `authority` / `query` / `fragment` are part of the port's `UriComponents`, so
     * they are carried instead of dropped: silently discarding a field the caller
     * filled in is the kind of "looks fine, is wrong" behaviour this codebase bans.
     * They are not exposed on `UriLike`, only folded into `toString()`.
     */
    from: (components: UriComponents) =>
      new DshUri(
        components.scheme,
        components.path ?? '',
        components.authority,
        components.query,
        components.fragment
      ),

    /**
     * A genuine narrowing: only objects this module built are accepted. The check is
     * deliberately *not* structural (`'scheme' in value && 'fsPath' in value`),
     * because the port's other consumer of it is `SftpEditSessionManager`'s
     * "is this a URI I own" test, and a random `{scheme, fsPath}` bag from somewhere
     * else is not one.
     */
    isUri: (value): value is UriLike => value instanceof DshUri
  };
}
