import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain-JS host module
import { INLINE_BUDGET, INLINE_HEAD, INLINE_TAIL, spillIfOverBudget, splitForSpill } from '../../dsh/spill.js';

/**
 * `ctx.spillStore` is the Host's answer to "the cap cut it off and there is no way back".
 * The contract used here is the installed one, read from
 * `/dsh/node_modules/@deepseek-ai/dsh-spill-local/lib/index.js` (`saveText` →
 * `{ locator, bytes, retrievalHint }`) and copied from the official caller
 * (`dsh-tool-fs-search`: `owner.sessionId` from `exec.agent.session.header.id`).
 *
 * The rule that matters most in these cases: **failing to save is not failing the call.**
 * A missing session, a missing backend and a throwing write all have to end in the same
 * place — a truncated result that says so — because the alternative is a successful remote
 * command reported as an error.
 */

function exec(sessionId?: string) {
  return sessionId === undefined ? {} : { agent: { session: { id: sessionId } }, callId: 'call-1' };
}

function store() {
  return { saveText: vi.fn(async () => ({ locator: '/tmp/spill/abc123-run.txt', bytes: 1, retrievalHint: 'read it' })) };
}

const LONG = 'H'.repeat(INLINE_HEAD) + 'M'.repeat(50_000) + 'T'.repeat(INLINE_TAIL);

describe('spillIfOverBudget', () => {
  it('leaves a result that already fits completely alone, and never calls the store', async () => {
    const spillStore = store();
    const short = 'x'.repeat(INLINE_BUDGET);

    const result = await spillIfOverBudget({
      text: short,
      exec: exec('sess-1'),
      toolName: 'at_terminal_run_remote_command',
      suggestedName: 'out.txt',
      resolveSpillStore: () => spillStore
    });

    expect(result).toMatchObject({ text: short, spillPath: null, saved: false });
    expect(spillStore.saveText).not.toHaveBeenCalled();
  });

  it('saves the complete text and keeps head and tail inline with the path', async () => {
    const spillStore = store();

    const result = await spillIfOverBudget({
      text: LONG,
      exec: exec('sess-1'),
      toolName: 'at_terminal_run_remote_command',
      suggestedName: 'out.txt',
      resolveSpillStore: () => spillStore
    });

    expect(result.saved).toBe(true);
    expect(result.spillPath).toBe('/tmp/spill/abc123-run.txt');
    // The model must be able to act on it without a second call to find out where it went.
    expect(result.text).toContain('/tmp/spill/abc123-run.txt');
    // Head *and* tail: a stack trace or a compiler error lives at the end.
    expect(result.text.startsWith('H'.repeat(64))).toBe(true);
    expect(result.text.endsWith('T'.repeat(100))).toBe(true);
    expect(result.text.length).toBeLessThan(LONG.length);
    expect(result.text).toContain('omitted');

    // The file gets the *whole* text, not the inline slice: otherwise the spill would be a
    // second copy of what was already shown.
    expect(spillStore.saveText).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { sessionId: 'sess-1' },
        suggestedName: 'out.txt',
        content: LONG,
        source: expect.objectContaining({ kind: 'tool', toolName: 'at_terminal_run_remote_command' })
      })
    );
  });

  it('accepts the session.header.id shape the official caller uses', async () => {
    const spillStore = store();

    const result = await spillIfOverBudget({
      text: LONG,
      exec: { agent: { session: { header: { id: 'sess-2' } } } },
      toolName: 'at_terminal_sftp_read_file',
      suggestedName: 'file.txt',
      resolveSpillStore: () => spillStore
    });

    expect(result.saved).toBe(true);
    expect(spillStore.saveText).toHaveBeenCalledWith(expect.objectContaining({ owner: { sessionId: 'sess-2' } }));
  });

  it('degrades to truncation when the call has no session to own the file', async () => {
    const warn = vi.fn();
    const spillStore = store();

    const result = await spillIfOverBudget({
      text: LONG,
      exec: {},
      toolName: 'at_terminal_ping',
      suggestedName: 'out.txt',
      resolveSpillStore: () => spillStore,
      logger: { warn }
    });

    expect(result).toMatchObject({ saved: false, spillPath: null });
    expect(result.text).toContain('could not be saved');
    expect(spillStore.saveText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('degrades when the preset composes no spill store', async () => {
    const warn = vi.fn();

    const result = await spillIfOverBudget({
      text: LONG,
      exec: exec('sess-1'),
      toolName: 'at_terminal_ping',
      suggestedName: 'out.txt',
      resolveSpillStore: () => undefined,
      logger: { warn }
    });

    expect(result).toMatchObject({ saved: false, spillPath: null });
    // Not an error: the tool result is a fact about the remote host, not about this host's
    // optional plumbing.
    expect(result.text).toContain('could not be saved');
    expect(warn.mock.calls[0][0]).toContain('no ctx.spillStore');
  });

  it('degrades when saveText throws, rather than failing the tool call', async () => {
    const warn = vi.fn();
    const spillStore = { saveText: vi.fn(async () => Promise.reject(new Error('EACCES'))) };

    const result = await spillIfOverBudget({
      text: LONG,
      exec: exec('sess-1'),
      toolName: 'at_terminal_ping',
      suggestedName: 'out.txt',
      resolveSpillStore: () => spillStore,
      logger: { warn }
    });

    expect(result.saved).toBe(false);
    expect(warn.mock.calls[0][0]).toContain('EACCES');
  });

  it('treats a missing locator as "not saved" instead of printing undefined', async () => {
    const spillStore = { saveText: vi.fn(async () => ({})) };

    const result = await spillIfOverBudget({
      text: LONG,
      exec: exec('sess-1'),
      toolName: 'at_terminal_ping',
      suggestedName: 'out.txt',
      resolveSpillStore: () => spillStore,
      logger: { warn: vi.fn() }
    });

    expect(result.spillPath).toBeNull();
    expect(result.text).not.toContain('undefined');
  });

  it('stringifies a non-string locator, because the store owns that type', async () => {
    const spillStore = { saveText: vi.fn(async () => ({ locator: { path: '/tmp/x' } })) };

    const result = await spillIfOverBudget({
      text: LONG,
      exec: exec('sess-1'),
      toolName: 'at_terminal_ping',
      suggestedName: 'out.txt',
      resolveSpillStore: () => spillStore
    });

    expect(result.spillPath).toBe('[object Object]');
    expect(result.saved).toBe(true);
  });
});

describe('splitForSpill', () => {
  it('keeps the configured head and tail and counts what fell between them', () => {
    const text = 'a'.repeat(INLINE_HEAD) + 'b'.repeat(1000) + 'c'.repeat(INLINE_TAIL);
    const { head, tail, omitted } = splitForSpill(text);

    expect(head).toHaveLength(INLINE_HEAD);
    expect(tail).toHaveLength(INLINE_TAIL);
    expect(omitted).toBe(text.length - INLINE_HEAD - INLINE_TAIL);
    // Head and tail are disjoint and together with the middle they are the original text:
    // a spill that dropped or duplicated bytes would make the file and the inline view
    // disagree about what the command actually printed.
    expect(head + text.slice(INLINE_HEAD, text.length - INLINE_TAIL) + tail).toBe(text);
    expect(omitted).toBeGreaterThan(0);
  });

  it('reports nothing omitted for a string shorter than the head window', () => {
    // The tail is empty rather than a second copy of the same bytes: `head + tail` has to be
    // the original text, so an overlapping tail would duplicate the start of every short file.
    const { head, tail, omitted } = splitForSpill('abc');
    expect(head).toBe('abc');
    expect(tail).toBe('');
    expect(omitted).toBe(0);
  });
});
