import { noopDisposable, toDisposable, type Disposable } from './disposable';

/**
 * The shape of an event subscription function. Field-for-field identical to VS Code's
 * `Event<T>` (the three params `listener` / `thisArgs` / `disposables`, returning a
 * Disposable), so the core layer's Event can be fed directly into positions that require a
 * host `Event`, such as `TreeDataProvider.onDidChangeTreeData`.
 *
 * `listener` returns `unknown` and `thisArgs` is typed `any` so that this stays assignable
 * in both directions against the host type declaration
 * `(listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]) => Disposable`
 * -- narrowing `thisArgs` to `unknown` would make the reverse assignment fail under
 * `strictFunctionTypes`.
 */
export type Event<T> = (
  listener: (event: T) => unknown,
  thisArgs?: any,
  disposables?: Disposable[]
) => Disposable;

export interface EmitterOptions {
  /**
   * Callback invoked when a single listener throws. Defaults to logging to console.error
   * -- matching VS Code, which records via `onUnexpectedError` and **continues** dispatching
   * to the remaining listeners. Silently swallowing a listener exception would hide real
   * defects, so callers are allowed to take over.
   */
  onListenerError?: (error: unknown) => void;
}

interface ListenerEntry<T> {
  readonly listener: (event: T) => unknown;
  readonly thisArgs: any;
}

function defaultListenerErrorHandler(error: unknown): void {
  console.error('[at-terminal] event listener threw', error);
}

/**
 * Platform-agnostic stand-in for the host `EventEmitter`. Behaviour alignment points:
 *
 * - `fire` dispatches **synchronously** to all current listeners (VS Code is synchronous too);
 * - after `dispose`, `fire` becomes a no-op and a later `.event(...)` only returns an empty
 *   Disposable;
 * - `thisArgs` in `event(listener, thisArgs)` becomes `this`;
 * - `event(listener, thisArgs, disposables)` appends the subscription's Disposable to the
 *   `disposables` array (a VS Code convention, handy for disposing many subscriptions at once);
 * - a throwing listener does not affect the others; the error goes to `onListenerError`.
 *
 * One **deliberate deviation**: `fire` iterates over a snapshot, so listeners added during
 * the current dispatch do not receive this event; VS Code iterates a linked list live, so a
 * listener appended at the tail may receive it. The core-layer consumers
 * (TerminalContextRegistry, the two trees) never add listeners during dispatch, and taking
 * a snapshot keeps the dispatch set stable throughout.
 */
export class Emitter<T> implements Disposable {
  private listeners: ListenerEntry<T>[] | undefined = [];
  private readonly onListenerError: (error: unknown) => void;

  constructor(options: EmitterOptions = {}) {
    this.onListenerError = options.onListenerError ?? defaultListenerErrorHandler;
  }

  /**
   * Same as VS Code: returns the same function instance, so it is safe to take/compare
   * repeatedly.
   */
  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const listeners = this.listeners;
    if (listeners === undefined) {
      return noopDisposable;
    }
    const entry: ListenerEntry<T> = { listener, thisArgs };
    listeners.push(entry);
    const subscription = toDisposable(() => {
      const current = this.listeners;
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(entry);
      if (index >= 0) {
        current.splice(index, 1);
      }
    });
    if (disposables) {
      disposables.push(subscription);
    }
    return subscription;
  };

  fire(event: T): void {
    const listeners = this.listeners;
    if (listeners === undefined || listeners.length === 0) {
      return;
    }
    // A listener may unsubscribe during dispatch: the unsubscriber no longer receives the
    // rest of this dispatch.
    for (const entry of listeners.slice()) {
      if (listeners.indexOf(entry) < 0) {
        continue;
      }
      try {
        entry.listener.call(entry.thisArgs, event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  dispose(): void {
    if (this.listeners === undefined) {
      return;
    }
    this.listeners = undefined;
  }
}
