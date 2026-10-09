/**
 * The client end of the Host↔Client channel (DSH-21): one unary RPC over
 * `POST /dsh-at-terminal/rpc`, plus the arrival announcement that makes "the
 * client half never loaded" distinguishable from "the tab never opened" in the
 * Host's own log.
 *
 * URLs are relative on purpose: the Desktop shell serves the page from a custom
 * scheme (`dsh-app://app`) where an absolute origin built from `location` is
 * wrong, and a relative URL is the only form that works on both carriers — and
 * fails diagnosably on neither.
 */

import { rpcError } from './models';

/** The channel's route prefix, mirroring `dsh/channel.js`'s `PREFIX`. */
export const CHANNEL_PREFIX = '/dsh-at-terminal';

/** The tab kind this package owns. A new kind, so the official `terminal` is untouched. */
export const KIND = 'at-terminal';

/**
 * The second tab kind: **one live terminal**, its file tree, and nothing else.
 *
 * Two kinds rather than one kind with a page flag, because the two tabs differ in every
 * property the registry cares about:
 *
 * | | 资产 (`KIND`) | 终端 (`KIND_SESSION`) |
 * |---|---|---|
 * | instances | **one per pane** — it is a manager, and two copies of the same list is a bug a user can see | **one per connection** (`multiple: true`) |
 * | guide entry | yes — it is what the column opens by default | **no** — reached by double-clicking a row, and a nameless entry there would only open an empty tab |
 * | lifetime | the plugin's | tied to a session in `sessions.ts`, with a close handler and a reaper |
 *
 * A single kind could not express the first two at once: `multiple` is per definition, and the
 * guide list is read off the registered types.
 */
export const KIND_SESSION = 'at-terminal-session';

/** This implementation's identity, and the key the tab-type registry holds it under. */
export const ID = '@at-series/dsh-at-terminal';

/**
 * The session kind's registry id, and therefore the slot key its body and chip register under.
 *
 * The key is the definition's `id`, not its kind (`entryKey: definition?.id ?? tab.kind`), so a
 * second type needs a second id or both seats would resolve to whichever registered last.
 */
export const ID_SESSION = '@at-series/dsh-at-terminal/session';

let requestSeq = 0;

export interface RpcProgressInfo {
  loaded: number;
  total: number;
  percent: number;
}

export interface RpcCallOptions {
  onUploadProgress?: (progress: RpcProgressInfo) => void;
  onDownloadProgress?: (progress: RpcProgressInfo) => void;
}

/**
 * One `POST /dsh-at-terminal/rpc`, unwrapped to its `result`.
 *
 * Rejects with an `Error` carrying the Host's `code` so callers can keep
 * `wrong-password` and `unreadable-package` apart — the two answers a user must
 * never see merged, because one means "retype the password" and the other means
 * "this password was already right".
 *
 * Supports optional upload and download progress hooks via `options`.
 */
export async function callRpc(
  method: string,
  params: Record<string, unknown>,
  options?: RpcCallOptions
): Promise<unknown> {
  requestSeq += 1;
  const seq = requestSeq;
  const payload = JSON.stringify({ id: seq, method, params });

  if (typeof XMLHttpRequest !== 'undefined' && (options?.onUploadProgress || options?.onDownloadProgress)) {
    return new Promise<unknown>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${CHANNEL_PREFIX}/rpc`);
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.setRequestHeader('accept', 'application/json');

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && options?.onUploadProgress) {
          const percent = event.total > 0 ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : 0;
          options.onUploadProgress({ loaded: event.loaded, total: event.total, percent });
        }
      };

      if (options?.onDownloadProgress) {
        xhr.onprogress = (event) => {
          if (event.lengthComputable && options.onDownloadProgress) {
            const percent = event.total > 0 ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : 0;
            options.onDownloadProgress({ loaded: event.loaded, total: event.total, percent });
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(rpcError(`http-${xhr.status}`, `HTTP ${xhr.status}`));
          return;
        }
        let body: { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          reject(rpcError('bad-json', 'Invalid JSON response'));
          return;
        }
        if (body === null || body.ok !== true) {
          const detail = body?.error ?? {};
          reject(
            rpcError(
              typeof detail.code === 'string' ? detail.code : undefined,
              typeof detail.message === 'string' ? detail.message : undefined
            )
          );
          return;
        }
        resolve(body.result);
      };

      xhr.onerror = () => reject(rpcError('network-error', 'Network error during RPC'));
      xhr.onabort = () => reject(rpcError('aborted', 'RPC aborted'));
      xhr.send(payload);
    });
  }

  const response = await fetch(`${CHANNEL_PREFIX}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: payload
  });
  if (!response.ok) throw rpcError(`http-${response.status}`, `HTTP ${response.status}`);

  let body:
    | { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    | null = null;

  if (
    options?.onDownloadProgress &&
    response.body &&
    typeof response.body.getReader === 'function' &&
    typeof TextDecoder !== 'undefined'
  ) {
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf8');
    let loaded = 0;
    let accumulated = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        loaded += value.length;
        accumulated += decoder.decode(value, { stream: true });
        const percent = contentLength > 0 ? Math.min(100, Math.round((loaded / contentLength) * 100)) : 0;
        options.onDownloadProgress({ loaded, total: contentLength, percent });
      }
    }
    accumulated += decoder.decode();
    try {
      body = JSON.parse(accumulated);
    } catch {
      throw rpcError('bad-json', 'Invalid JSON response');
    }
  } else {
    body = (await response.json()) as typeof body;
  }
  if (body === null || body.ok !== true) {
    const detail = body?.error ?? {};
    throw rpcError(
      typeof detail.code === 'string' ? detail.code : undefined,
      typeof detail.message === 'string' ? detail.message : undefined
    );
  }
  return body.result;
}

/**
 * Post one browser-side failure to the Host, which appends it to
 * `$DSH_HOME/at-terminal/client-diagnostics.log`.
 *
 * ## Why this has to exist
 *
 * A blank panel is a **renderer** failure, and the desktop shell keeps renderer console
 * output in a buffer that is flushed **only** into a crash report — which is written only for
 * a *fatal* error. React tearing down one subtree is not fatal, so the one error worth reading
 * is the one the log file structurally cannot hold. DevTools is not an escape hatch either:
 * the desktop app enables its toggles only when launched with developer tools, so
 * `openDevTools` is unreachable without a debugger attached.
 *
 * Three sources are covered, because React uses different ones:
 * - `error` — thrown during render/commit.
 * - `unhandledrejection` — an async failure with nothing to catch it.
 * - `console.error` — React 18 reports a caught render error here in production when
 *   `reportError` is absent, so wrapping it catches what the two events above miss.
 *
 * Fire-and-forget throughout: a diagnostic must never be able to cause the failure it is
 * reporting, so every path is wrapped and no promise is awaited.
 */
export function postDiagnostic(
  level: string,
  message: string,
  source: string,
  line: number | null,
  stack: unknown
): void {
  try {
    void fetch(`${CHANNEL_PREFIX}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `client.diagnostic.${Date.now()}`,
        method: 'client.diagnostic',
        params: { level, message, source, line, stack: typeof stack === 'string' ? stack : null }
      }),
      keepalive: true
    }).catch(() => undefined);
  } catch {
    /* never fail over a diagnostic */
  }
}

/** Render a caught value into something a log line can carry. */
function describeThrown(value: unknown): string {
  // Duck-typed, **not** `instanceof Error`: a throw can cross a realm boundary — an error
  // raised inside an iframe, or one that arrived from another bundle — and `instanceof` is
  // false for those even though they are perfectly good errors. `JSON.stringify(new Error())`
  // is `{}` because every own property is non-enumerable, so the naive fallback would silently
  // reduce the one message worth reading to `{}`.
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const name = (value as { name?: unknown }).name;
    const message = (value as { message?: unknown }).message;
    if (typeof name === 'string' && typeof message === 'string') return `${name}: ${message}`;
    if (typeof message === 'string') return message;
  }
  try {
    const rendered = JSON.stringify(value);
    // An object with no enumerable own properties renders as `{}`, which tells nobody anything.
    return rendered === '{}' || rendered === undefined ? String(value) : rendered;
  } catch {
    return String(value);
  }
}

/** The stack of a thrown value, when it has one — same cross-realm caution as `describeThrown`. */
function stackOfThrown(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const stack = (value as { stack?: unknown }).stack;
  return typeof stack === 'string' ? stack : null;
}

/**
 * Install the browser-failure trap. Idempotent, and safe to call on a page with no `window`.
 *
 * Returns nothing on purpose: a disposer would have to be owned by an effect, and this is a
 * diagnostic that should outlive the plugin's own lifecycle rather than disappear when the
 * tab type unregisters.
 */
export function installDiagnostics(): void {
  // Guarded on the method, not just on `window`: this runs during `apply`, and a diagnostic
  // that throws while installing would abort activation and replace a blank panel with a
  // plugin that never loads. A page without `addEventListener` gets no diagnostics, which is
  // strictly better than getting none *and* a broken plugin.
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const target = window as Window & { __atTerminalDiagnostics?: boolean };
  if (target.__atTerminalDiagnostics === true) return;
  target.__atTerminalDiagnostics = true;

  window.addEventListener('error', (event: Event) => {
    const error = (event as ErrorEvent).error;
    postDiagnostic(
      'error',
      describeThrown(error ?? (event as ErrorEvent).message ?? 'unknown error'),
      typeof location === 'undefined' ? '' : location.href,
      (event as ErrorEvent).lineno ?? null,
      stackOfThrown(error)
    );
  });

  window.addEventListener('unhandledrejection', (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    postDiagnostic(
      'unhandledrejection',
      describeThrown(reason),
      typeof location === 'undefined' ? '' : location.href,
      null,
      stackOfThrown(reason)
    );
  });

  // React 18 reports a render error it has already caught through `console.error` (or
  // `reportError`, which routes to `error` above). Wrapped rather than replaced: the original
  // still runs, so the desktop shell's own buffer sees it too if this ever becomes fatal.
  const original = console.error;
  console.error = (...args: unknown[]) => {
    // React logs `console.error(formatted, error)` — the **component stack lives on the Error
    // argument**, not in the formatted text. Posting only the text is what made this blind
    // spot in the first place: a minified `#311` names neither the component nor the file.
    // Every argument is examined, because which one holds the Error is React's business, not
    // ours.
    let stack: string | null = null;
    for (const arg of args) {
      stack = stackOfThrown(arg);
      if (stack !== null) break;
    }
    postDiagnostic(
      'console.error',
      args.map((value) => describeThrown(value)).join(' '),
      typeof location === 'undefined' ? '' : location.href,
      null,
      stack
    );
    original.apply(console, args as []);
  };
}

/**
 * Tell the Host half that this half ran — fire-and-forget by construction: a
 * diagnostic must never be able to break activation, so the promise is not
 * awaited and both the fetch and the encoding are guarded.
 */
export function announceToHost(): void {
  try {
    const params = {
      kind: KIND,
      origin: typeof location === 'undefined' ? null : location.origin,
      href: typeof location === 'undefined' ? null : location.href,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent
    };
    void fetch(`${CHANNEL_PREFIX}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'client.hello', method: 'client.hello', params }),
      keepalive: true
    }).catch(() => undefined);
  } catch {
    /* never fail activation over a diagnostic */
  }
}