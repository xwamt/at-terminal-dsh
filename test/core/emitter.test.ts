import { describe, expect, it, vi } from 'vitest';
import { Emitter, type Disposable, type Event } from '../../src/core';

describe('Emitter', () => {
  it('dispatches synchronously to all listeners, preserving registration order', () => {
    const emitter = new Emitter<number>();
    const calls: string[] = [];
    emitter.event((value) => calls.push(`first:${value}`));
    emitter.event((value) => calls.push(`second:${value}`));

    emitter.fire(7);

    // Synchronous: when fire returns the listeners have already run; no await / microtask needed.
    expect(calls).toEqual(['first:7', 'second:7']);
  });

  it('after the event-returned Disposable is disposed, no more events are received', () => {
    const emitter = new Emitter<string>();
    const listener = vi.fn();
    const subscription = emitter.event(listener);

    emitter.fire('a');
    subscription.dispose();
    emitter.fire('b');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('a');
  });

  it('disposing the same subscription repeatedly is idempotent', () => {
    const emitter = new Emitter<number>();
    const listener = vi.fn();
    const subscription = emitter.event(listener);

    subscription.dispose();
    subscription.dispose();
    emitter.fire(1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('thisArgs is bound as the listener this', () => {
    const emitter = new Emitter<number>();
    const receiver = { seen: 0, record(value: number): void { this.seen = value; } };
    emitter.event(receiver.record, receiver);

    emitter.fire(42);

    expect(receiver.seen).toBe(42);
  });

  it('pushes the subscription into the passed disposables array for bulk disposal', () => {
    const emitter = new Emitter<number>();
    const first = vi.fn();
    const second = vi.fn();
    const bag: Disposable[] = [];

    emitter.event(first, undefined, bag);
    emitter.event(second, undefined, bag);
    expect(bag).toHaveLength(2);

    for (const subscription of bag) {
      subscription.dispose();
    }
    emitter.fire(1);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('after dispose, fire no longer delivers and event only returns an empty subscription', () => {
    const emitter = new Emitter<number>();
    const listener = vi.fn();
    emitter.event(listener);

    emitter.dispose();
    emitter.fire(1);

    expect(listener).not.toHaveBeenCalled();

    const late = emitter.event(listener);
    emitter.fire(2);
    expect(listener).not.toHaveBeenCalled();
    // The empty subscription can still be disposed without throwing.
    expect(() => late.dispose()).not.toThrow();
  });

  it('disposing the same Emitter repeatedly is idempotent', () => {
    const emitter = new Emitter<number>();
    emitter.dispose();
    expect(() => emitter.dispose()).not.toThrow();
  });

  it('one throwing listener does not affect the others; the error goes to onListenerError', () => {
    const failure = new Error('boom');
    const onListenerError = vi.fn();
    const emitter = new Emitter<number>({ onListenerError });
    const after = vi.fn();
    emitter.event(() => {
      throw failure;
    });
    emitter.event(after);

    expect(() => emitter.fire(3)).not.toThrow();

    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledWith(failure);
    expect(after).toHaveBeenCalledWith(3);
  });

  it('a listener that unsubscribes during dispatch no longer receives this event', () => {
    const emitter = new Emitter<number>();
    const second = vi.fn();
    let secondSubscription: Disposable | undefined;
    emitter.event(() => secondSubscription?.dispose());
    secondSubscription = emitter.event(second);

    emitter.fire(1);

    expect(second).not.toHaveBeenCalled();
  });

  it('a listener added during dispatch does not receive this event (snapshot dispatch, a documented deviation)', () => {
    const emitter = new Emitter<number>();
    const late = vi.fn();
    emitter.event(() => emitter.event(late));

    emitter.fire(1);

    expect(late).not.toHaveBeenCalled();
    // The next dispatch will cover it.
    emitter.fire(2);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('event returns the same stable function instance', () => {
    const emitter = new Emitter<number>();
    const first: Event<number> = emitter.event;
    const second: Event<number> = emitter.event;

    expect(first).toBe(second);
  });
});
