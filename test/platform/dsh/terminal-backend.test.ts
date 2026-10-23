import { describe, expect, it, vi } from 'vitest';

import {
  createSshTerminalBackend,
  looksLikePrompt,
  type SshConnection,
  type SshOutputHandlers
} from '../../../src/platform/dsh/terminalBackend/sshBackend';
import { resolveServerByName } from '../../../src/platform/dsh/terminalEntry';

/**
 * The `ssh` PTY backend and its session adapter (S6-02).
 *
 * The registry contract is fixed by the installed `@deepseek-ai/dsh-terminal` (0.2.1-rc.2,
 * read out of `app.asar`): a backend is `{ type, spawn(spec) }` and a session is
 * `{ motd, startSend, read, signal, close, status }`. What is **not** fixed is how an SSH
 * stream becomes those answers, and that is what these cases pin:
 *
 * - readiness is prompt-text evidence, so a quiet send with no prompt must settle as the
 *   weaker `inferred_idle` rather than claiming `stdin_read`;
 * - a send always settles (timeout and exit included), because the tool awaits `done` and a
 *   promise that never resolves is a hung turn;
 * - `signal` refuses loudly instead of inventing a `delivered: true` the tool would print.
 */

const idle = 20;

function harness(options: { banner?: string | null; pump?: boolean } = {}) {
  const banner = options.banner === undefined ? 'Last login: Fri Oct 23\nroot@v:~# ' : options.banner;
  let handlers: SshOutputHandlers | undefined;
  const writes: string[] = [];
  let closed = 0;
  const connection: SshConnection = {
    write: (data) => void writes.push(data),
    close: () => void (closed += 1)
  };
  const open = vi.fn(async (_serverId: string, next: SshOutputHandlers) => {
    handlers = next;
    // A real SSH channel pushes its banner and prompt as it opens — *before* spawn returns.
    // The harness has to do the same, or `spawn` waits for a prompt that could only be sent
    // after it resolved, and every case deadlocks.
    if (banner !== null) setTimeout(() => next.output(banner), 0);
    // `pump` never goes quiet, so a startup can only end at the deadline.
    if (options.pump === true) setInterval(() => next.output('.'), 5).unref?.();
    return connection;
  });
  const backend = createSshTerminalBackend({
    type: 'ssh',
    idleSilenceMs: idle,
    sendTimeoutMs: 400,
    open
  });
  const feed = (text: string): void => handlers?.output(text);
  const exit = (): void => handlers?.exit({ exitCode: 0, signal: null });
  return {
    backend,
    open,
    writes,
    feed,
    exit,
    closedCount: () => closed,
    ready: () => backend.spawn({ sessionId: 'pty-1', type: 'ssh', name: 'payment01' })
  };
}

describe('ssh backend — spawn', () => {
  it('refuses to spawn without a name, because name is the server selector', async () => {
    const subject = harness();
    await expect(subject.backend.spawn({ sessionId: 'pty-1', type: 'ssh' })).rejects.toThrow(
      /name set to the server id or label/
    );
    expect(subject.open).not.toHaveBeenCalled();
  });

  it('waits for the first prompt and keeps it as the motd', async () => {
    const subject = harness();
    const session = await subject.ready();

    expect(subject.open).toHaveBeenCalledWith('payment01', expect.any(Object));
    expect(session.motd).toContain('root@v:~#');
    // Startup is one empty send: nothing is typed at the shell.
    expect(subject.writes).toEqual([]);
    expect(session.status().kind).toBe('running');
  });

  it('accepts a startup that went quiet without a prompt, with an empty motd', async () => {
    const subject = harness({ banner: null });
    const session = await subject.ready();
    // Silence is not failure: the local backend fails only on timeout or exit. What must not
    // happen is inventing a motd — there was no output to keep.
    expect(session.motd).toBe('');
    expect(session.status().kind).toBe('running');
  });

  it('releases the connection when startup never settles before the deadline', async () => {
    const subject = harness({ banner: null, pump: true });
    await expect(subject.backend.spawn({ sessionId: 'pty-1', type: 'ssh', name: 'silent' })).rejects.toThrow(
      /did not reach a prompt/
    );
    // The registry never published this session, so nothing else would ever close it.
    expect(subject.closedCount()).toBe(1);
  });
});

describe('ssh backend — send', () => {
  it('settles as stdin_read when a prompt came back', async () => {
    const subject = harness();
    const session = await subject.ready();

    const operation = session.startSend({ text: 'ls', submit: true });
    expect(subject.writes).toEqual(['ls\r']);
    subject.feed('app.js\nroot@v:~# ');

    const outcome = await operation.done;
    expect(outcome.waitReason).toBe('stdin_read');
    expect(outcome.viewport).toContain('app.js');
    expect(outcome.sessionStatus).toEqual({ kind: 'running' });
  });

  it('settles as inferred_idle when output stopped without a prompt', async () => {
    const subject = harness();
    const session = await subject.ready();

    const operation = session.startSend({ text: 'tail -f app.log', submit: true });
    subject.feed('line 1\nline 2\n');

    const outcome = await operation.done;
    // The weaker claim on purpose: silence is not a prompt, and `stdin_read` here would be
    // evidence this backend does not have.
    expect(outcome.waitReason).toBe('inferred_idle');
    expect(outcome.viewport).toContain('line 1');
  });

  it('settles as timeout when output keeps arriving past the deadline', async () => {
    const subject = harness();
    const session = await subject.ready();

    const operation = session.startSend({ text: 'yes', submit: true });
    // Never quiet long enough to infer anything: the deadline is the only way out.
    const pump = setInterval(() => subject.feed('y\n'), 5);
    const outcome = await Promise.race([
      operation.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('send never settled')), 2000))
    ]);
    clearInterval(pump);

    expect(outcome.waitReason).toBe('timeout');
  });

  it('settles as session_exit when the remote side ends mid-send', async () => {
    const subject = harness();
    const session = await subject.ready();

    const operation = session.startSend({ text: 'exit', submit: true });
    subject.exit();

    const outcome = await operation.done;
    expect(outcome.waitReason).toBe('session_exit');
    expect(outcome.sessionStatus).toMatchObject({ kind: 'exited', exitCode: 0 });
    expect(session.status().kind).toBe('exited');
  });

  it('refuses a second concurrent send', async () => {
    const subject = harness();
    const session = await subject.ready();
    const first = session.startSend({ text: 'a', submit: true });
    expect(() => session.startSend({ text: 'b', submit: true })).toThrow(/active send/);
    subject.feed('root@v:~# ');
    await first.done;
  });
});

describe('ssh backend — read, signal, close', () => {
  it('pages scrollback newest-relative, like the local backend', async () => {
    const subject = harness();
    const session = await subject.ready();
    const operation = session.startSend({ text: 'seq 1 5', submit: true });
    subject.feed('1\n2\n3\n4\n5\nroot@v:~# ');
    await operation.done;

    const all = session.read();
    const page = session.read({ count: 2 });

    // Offset 0 is the newest page, so a page has to end at the newest line and the total has
    // to be the whole retained buffer.
    expect(page.text.endsWith('root@v:~# ')).toBe(true);
    expect(page.totalLines).toBe(all.totalLines);
    expect(session.read({ offset: all.totalLines }).text).toBe('');
    expect(() => session.read({ offset: -1 })).toThrow(/non-negative/);
    expect(() => session.read({ count: 0 })).toThrow(/positive/);
  });

  it('refuses named signals with the two things that do work', async () => {
    const subject = harness();
    const session = await subject.ready();
    expect(() => session.signal('SIGINT')).toThrow(/no signal channel[\s\S]*Ctrl\+C[\s\S]*terminal_close/);
  });

  it('closes the connection and reports the session exited', async () => {
    const subject = harness();
    const session = await subject.ready();
    await session.close('model request');
    expect(subject.closedCount()).toBe(1);
    expect(session.status().kind).toBe('exited');
    // A closed session refuses further sends instead of writing into a dead channel.
    expect(() => session.startSend({ text: 'ls' })).toThrow();
  });
});

describe('looksLikePrompt', () => {
  it('reads the shell prompt through escape codes', () => {
    expect(looksLikePrompt('root@v:~# ')).toBe(true);
    expect(looksLikePrompt('\u001b[32muser@host\u001b[0m$ ')).toBe(true);
    expect(looksLikePrompt('line 1\nline 2\n')).toBe(false);
    // A dollar sign mid-line is not a prompt tail.
    expect(looksLikePrompt('total $5 spent')).toBe(false);
  });
});

describe('resolveServerByName', () => {
  const servers = [
    { id: 'server-1', label: 'Production' },
    { id: 'server-2', label: 'Staging' },
    { id: 'server-3', label: 'Staging' }
  ];

  it('takes an id first', () => {
    expect(resolveServerByName(servers, 'server-3')).toEqual({ id: 'server-3', label: 'Staging' });
  });

  it('takes a unique label', () => {
    expect(resolveServerByName(servers, 'Production')).toEqual({ id: 'server-1', label: 'Production' });
  });

  it('refuses an ambiguous label and names the ids', () => {
    expect(() => resolveServerByName(servers, 'Staging')).toThrow(
      /2 servers are labelled "Staging" \(server-2, server-3\)/
    );
  });

  it('lists what it knows when nothing matches', () => {
    expect(() => resolveServerByName(servers, 'nope')).toThrow(
      /no SSH server matches "nope"[\s\S]*server-1 \(Production\)/
    );
  });
});
