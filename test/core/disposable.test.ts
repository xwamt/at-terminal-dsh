import { describe, expect, it, vi } from 'vitest';
import { DisposableStore, noopDisposable, toDisposable } from '../../src/core';

describe('toDisposable', () => {
  it('runs the wrapped callback on dispose', () => {
    const dispose = vi.fn();
    const disposable = toDisposable(dispose);

    expect(dispose).not.toHaveBeenCalled();
    disposable.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('noopDisposable', () => {
  it('dispose neither throws nor does anything', () => {
    expect(() => noopDisposable.dispose()).not.toThrow();
  });
});

describe('DisposableStore', () => {
  it('dispose releases every entry and is idempotent (each disposed once)', () => {
    const store = new DisposableStore();
    const first = vi.fn();
    const second = vi.fn();
    store.add(toDisposable(first));
    store.add(toDisposable(second));

    store.dispose();
    store.dispose();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(store.isDisposed).toBe(true);
    expect(store.size).toBe(0);
  });

  it('after disposal, add immediately disposes the item and returns it unchanged, avoiding a leak', () => {
    const store = new DisposableStore();
    store.dispose();
    const dispose = vi.fn();
    const item = toDisposable(dispose);

    const added = store.add(item);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(added).toBe(item);
    expect(store.size).toBe(0);
  });

  it('delete releases only the given entry and removes it from the set', () => {
    const store = new DisposableStore();
    const kept = vi.fn();
    const removed = vi.fn();
    store.add(toDisposable(kept));
    const removedDisposable = store.add(toDisposable(removed));

    expect(store.delete(removedDisposable)).toBe(true);
    expect(store.delete(removedDisposable)).toBe(false);
    expect(store.size).toBe(1);

    store.dispose();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('clear releases every entry but leaves the store usable', () => {
    const store = new DisposableStore();
    const first = vi.fn();
    const second = vi.fn();
    store.add(toDisposable(first));

    store.clear();
    expect(first).toHaveBeenCalledTimes(1);
    expect(store.isDisposed).toBe(false);
    expect(store.size).toBe(0);

    store.add(toDisposable(second));
    store.dispose();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
