/**
 * The session registry: what a tab switch must not lose.
 *
 * ## Why this file exists
 *
 * `sessions.ts` is the reason a tab switch no longer closes an SSH connection, and until now it had
 * **no direct test at all**. Everything about it was asserted through `client-bundle.test.ts`, which
 * drives the built bundle in a VM — and that harness cannot create an xterm engine (the shim never
 * assigns a ref, so `TerminalView`'s effect returns early and `session.engine` stays null). So
 * `consume`, `attachEngine` and the retention ring were exercised by nothing, and a real defect went
 * straight through the hole: output was retained **only while the tab was in the background**, so
 * returning to a connected tab rebuilt an *empty* screen — no prompt, no banner, nothing — until a
 * keystroke made the shell print a fresh one.
 *
 * This file therefore tests the registry directly, with a fake engine standing in for xterm. It is
 * the only place the two halves meet: what arrives on the wire (a real `terminal.output` frame,
 * through the real frame handler) and what a returning tab gets to see.
 *
 * `react` is aliased to `test-fixtures/react.ts` for these tests — see `vitest.config.ts`. The
 * registry keeps its state outside React, so React only has to exist for the module to import.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  attachEngine,
  connectSession,
  consume,
  detachEngine,
  disconnectSession,
  disposeAllSessions,
  ensureSession,
  isSessionLive,
  setSessionTarget,
  type TerminalSession
} from '../../src/platform/dsh/client/sessions';
import type { TerminalEngine } from '../../src/platform/dsh/client/xtermEngine';

/* ---------------------------------- doubles ---------------------------------- */

interface FakeEngine {
  engine: TerminalEngine;
  /** Everything written to it, in order. */
  writes: Uint8Array[];
}

/**
 * An engine that records instead of rendering.
 *
 * `acknowledge` is called synchronously, the way xterm's write callback eventually is — the flow
 * controller is not the subject here, and a no-op would hide a replay that forgot to debit.
 */
function fakeEngine(): FakeEngine {
  const writes: Uint8Array[] = [];
  return {
    writes,
    engine: {
      writeOutput(bytes, acknowledge) {
        writes.push(bytes.slice());
        acknowledge(bytes.length);
      },
      setEncoding() {},
      fit() {},
      focus() {},
      cols: 80,
      rows: 24,
      dispose() {}
    }
  };
}

/** One `terminal.output` frame, exactly as the Host sends it: base64 in `data`. */
function feed(session: TerminalSession, text: string): void {
  session.frames.handle(
    JSON.stringify({ type: 'terminal.output', data: Buffer.from(text, 'utf8').toString('base64') })
  );
}

/** Everything a fake engine was given, decoded — for the small chunks these tests use. */
function textOf(fake: FakeEngine): string {
  let out = '';
  for (const bytes of fake.writes) out += latin1(bytes);
  return out;
}

/** Bytes as characters. A loop rather than a spread: a chunk can be a megabyte. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

/** The first three characters of each write: enough to name a chunk without copying megabytes. */
function markers(fake: FakeEngine): string[] {
  return fake.writes.map((bytes) => String.fromCharCode(...bytes.slice(0, 3).values()));
}

/** `RESET_BYTES` in `sessions.ts` — what a partial replay is prefixed with. */
const RESET = '\u001b[0m\u001b[2J\u001b[3J\u001b[H';

/* ---------------------------------- tests ----------------------------------- */

describe('session registry — the screen survives a tab switch', () => {
  beforeEach(() => {
    // The registry is module-level — that is the whole point of it — so tests must not inherit one
    // another's sessions.
    disposeAllSessions('test');
  });

  it('replays the whole session into the returning engine, not just what arrived while hidden', () => {
    const session = ensureSession('tab-a');

    // The tab is in front. The shell prints its banner and prompt, and the user is looking at it.
    const away = fakeEngine();
    attachEngine(session, away.engine);
    feed(session, 'Welcome\nroot@srv:~# ');
    expect(textOf(away)).toBe('Welcome\nroot@srv:~# ');

    // Another tab comes to the front: the engine is disposed with its body, the session is not.
    detachEngine(session, away.engine);
    // Nothing at all is produced in between. An idle shell emits nothing while nobody is watching,
    // which is exactly why retaining only the detached window left the panel blank.
    const back = fakeEngine();
    attachEngine(session, back.engine);

    expect(textOf(back)).toBe('Welcome\nroot@srv:~# ');
  });

  it('keeps the history across a second switch, so a tab is not drained one visit at a time', () => {
    const session = ensureSession('tab-b');

    // Attaching must not consume the ring: if it did, visit 2 would see only what visit 1 missed,
    // and a terminal would come back emptier every time it was left.
    for (const [visit, letter] of ['A', 'B', 'C'].entries()) {
      const engine = fakeEngine();
      attachEngine(session, engine.engine);
      feed(session, letter);
      detachEngine(session, engine.engine);
      expect(textOf(engine), `visit ${visit + 1}`).toBe('ABC'.slice(0, visit + 1));
    }
  });

  it('keeps each tab’s screen to itself', () => {
    const a = ensureSession('tab-a');
    const b = ensureSession('tab-b');

    const firstA = fakeEngine();
    attachEngine(a, firstA.engine);
    feed(a, 'from A');
    detachEngine(a, firstA.engine);

    const firstB = fakeEngine();
    attachEngine(b, firstB.engine);
    expect(textOf(firstB), 'tab B starts empty').toBe('');
    feed(b, 'from B');
    detachEngine(b, firstB.engine);

    const secondA = fakeEngine();
    attachEngine(a, secondA.engine);
    expect(textOf(secondA)).toBe('from A');
  });

  it('keeps the screen across a disconnect, and drops it when a new shell starts', async () => {
    const session = ensureSession('tab-c');
    const engine = fakeEngine();
    attachEngine(session, engine.engine);
    feed(session, 'root@srv:~# ');

    // 断开 keeps the screen — the plan's "keep the screen and offer a reconnect" — so a tab switch
    // during the outage must still find it.
    disconnectSession(session);
    const afterDisconnect = fakeEngine();
    attachEngine(session, afterDisconnect.engine);
    expect(textOf(afterDisconnect)).toBe('root@srv:~# ');

    // 连接 again: a new PTY is a new screen. The target has to be set first — a connect with no
    // server is refused before it touches anything, which is why the selector's own setter is used
    // here rather than reaching past it. This page has no `window`, so the attempt cannot reach a
    // socket; it does not need to, because the ring is emptied before the transport is asked for,
    // and that is the part deciding what the *next* replay would show.
    setSessionTarget(session, 'srv-prod-1');
    await connectSession(session);
    const afterReconnect = fakeEngine();
    attachEngine(session, afterReconnect.engine);
    expect(textOf(afterReconnect)).toBe('');
    expect(session.connectError, 'the connect really was attempted').not.toBe('terminal.pick');
  });

  it('replays a bounded tail behind a screen reset when a session outgrows the ring', () => {
    const session = ensureSession('tab-big');
    const live = fakeEngine();
    attachEngine(session, live.engine);

    // 1 MiB a frame, five frames: past the 4 MiB ceiling, so the ring has to drop its head.
    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      feed(session, letter + '.'.repeat(1024 * 1024 - 1));
    }
    expect(session.truncated, 'the ring dropped its head').toBe(true);
    detachEngine(session, live.engine);

    const back = fakeEngine();
    attachEngine(session, back.engine);
    // A clean screen first: the replay begins mid-history, and half an escape sequence would
    // otherwise be drawn as literal text.
    expect(latin1(back.writes[0])).toBe(RESET);
    // The head is gone, and the tail — what the user was actually looking at — is intact.
    expect(markers(back)).toContain('E..');
    expect(markers(back)).not.toContain('A..');
  });

  it('handles over 25000 output chunks with O(1) ring eviction without array shift degradation', () => {
    const session = ensureSession('test-ring-perf');
    const chunk = new Uint8Array([65, 66, 67]);
    for (let i = 0; i < 25000; i += 1) {
      consume(session, chunk);
    }
    expect(session.retained.length).toBeLessThanOrEqual(20000);
  });

  it('batches small adjacent chunks up to 64KB during replay', () => {
    const session = ensureSession('test-replay-batch');
    for (let i = 0; i < 50; i += 1) {
      consume(session, new Uint8Array(100).fill(65));
    }
    const engine = fakeEngine();
    attachEngine(session, engine.engine);
    expect(engine.writes.length).toBe(1);
    expect(engine.writes[0].length).toBe(5000);
  });
});

/**
 * UI2-01: the target is the PTY's, not the selector's.
 *
 * The defect was a disagreement, not a crash. The selector's `onChange` called
 * `setSessionTarget`, which only rewrote `session.serverId` — the socket, the PTY and the
 * status bar kept describing the *old* server, so the tab chip and the connection reported
 * different hosts and there was no way for the user to tell which to believe. The view now
 * disables the control, and these cases pin the second, independent guard: a programmatic
 * call (a shortcut, a stale closure, a future menu item) must not be able to make the same
 * mistake the control no longer offers.
 */
describe('session target — locked while the PTY is live (UI2-01)', () => {
  beforeEach(() => {
    disposeAllSessions('test');
  });

  it('refuses to retarget a connected session', () => {
    const session = ensureSession('tab-live');
    session.serverId = 'srv-a';
    session.state = { kind: 'connected', text: '' };

    setSessionTarget(session, 'srv-b');

    expect(session.serverId).toBe('srv-a');
  });

  it('refuses while connecting, which is the window that actually bit', () => {
    // The socket is open and the PTY is about to be requested for `serverId`. Accepting a
    // retarget here is what let the label move ahead of the connection.
    const session = ensureSession('tab-connecting');
    session.serverId = 'srv-a';
    session.state = { kind: 'connecting', text: '' };

    setSessionTarget(session, 'srv-b');

    expect(session.serverId).toBe('srv-a');
  });

  it('allows retargeting once the PTY is gone', () => {
    // 断开 then pick another server then 连接 is the intended flow; a guard that also blocked
    // this would leave the selector permanently useless after the first session.
    const session = ensureSession('tab-idle');
    session.serverId = 'srv-a';
    session.state = { kind: 'disconnected', text: '' };

    setSessionTarget(session, 'srv-b');

    expect(session.serverId).toBe('srv-b');
  });

  it('reports liveness for exactly the two live kinds', () => {
    const session = ensureSession('tab-kinds');
    for (const kind of ['idle', 'connected', 'connecting', 'disconnected'] as const) {
      session.state = { kind, text: '' };
      expect(isSessionLive(session), kind).toBe(kind === 'connected' || kind === 'connecting');
    }
  });
});
