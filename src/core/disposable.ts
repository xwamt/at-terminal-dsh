/**
 * A platform-agnostic disposable-resource primitive.
 *
 * Its shape is exactly VS Code's `Disposable` (`{ dispose(): void }`), so a Disposable
 * produced by the core layer can be handed to a host API as-is, and vice versa (the
 * compatibility is proven at compile time by the host adapter layer).
 */

export interface Disposable {
  dispose(): void;
}

/**
 * A Disposable that does nothing. Semantically the same as VS Code's `Disposable.None`,
 * used for branches like "the emitter is already disposed" where a Disposable must be
 * returned but there is no subscription to cancel.
 */
export const noopDisposable: Disposable = { dispose: () => undefined };

/** Wraps a piece of teardown logic as a Disposable. */
export function toDisposable(dispose: () => void): Disposable {
  return { dispose };
}

/**
 * A collection of disposable resources, semantically aligned with VS Code's
 * `DisposableStore`:
 *
 * - `add` **immediately** disposes the passed item if the store is already disposed
 *   (avoiding a leak), and still returns that item;
 * - `dispose` is idempotent: each item is disposed exactly once;
 * - `clear` disposes every entry but leaves the store usable.
 */
export class DisposableStore implements Disposable {
  private readonly items = new Set<Disposable>();
  private disposed = false;

  get size(): number {
    return this.items.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  delete(item: Disposable): boolean {
    return this.items.delete(item);
  }

  clear(): void {
    // Detach before disposing: if a dispose callback adds again, it will not be disposed
    // a second time by the rest of this round.
    const pending = Array.from(this.items);
    this.items.clear();
    for (const item of pending) {
      item.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear();
  }
}
