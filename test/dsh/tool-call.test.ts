import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TOOL_RUN_REMOTE_COMMAND,
  argsOf,
  commandOf,
  formatDuration,
  parseRemoteCommandOutput,
  resultText,
  serverOf,
  splitOutput,
  stateOf
} from '../../src/platform/dsh/client/views/toolCall';
import { en, zh } from '../../src/platform/dsh/client/i18n';

/**
 * UI2-12 — the remote-command conversation card.
 *
 * The card is claimed through a Host slot, so **nothing here mounts it**: the React stand-in these
 * node-side tests use throws on every hook by design. What is tested instead is the part where the
 * decisions actually live:
 *
 * 1. **The parser is pure**, and the four outcomes the DoD names — success, failure, timeout,
 *    truncation — are four real strings through it, not four branches in a render.
 * 2. **The block is a Host contract**, so every layer returns `null` instead of throwing. That is
 *    asserted per malformed shape, because the one bug that matters here is a card that takes the
 *    transcript down with it.
 * 3. **The wiring** (registered key, chevron/aria, the fallback) is asserted on source text, with
 *    the same honesty limit as the other UI2 tests: it proves the intent, not the browser.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

const CARD = read('src/platform/dsh/client/views/toolCall.ts');
const MAIN = read('src/platform/dsh/client/main.ts');
const SHEET = read('src/platform/dsh/client/styles.ts');
const TOOLS = read('dsh/tools.js');

/** The text one settled call produces, as `dsh/tools.js` renders it. */
function render(args: {
  serverId?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  timedOut?: boolean;
  truncated?: boolean;
  stdout?: string;
  stderr?: string;
}): string {
  const exitText =
    (args.exitCode ?? null) !== null ? `exit ${args.exitCode}` : `signal ${args.signal ?? 'unknown'}`;
  const flags = `${args.timedOut ? ' timed_out' : ''}${args.truncated ? ' truncated' : ''}`;
  const stderr = args.stderr === undefined || args.stderr === '' ? '' : `\n[stderr]\n${args.stderr}`;
  return `[${args.serverId ?? 'nas'}] ${exitText} (${args.durationMs ?? 12}ms)${flags}:\n\`\`\`\n${args.stdout ?? ''}${stderr}\n\`\`\``;
}

/** A settled block: the Host marks one with a `kind` property. */
function settled(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'result', callId: 'c1', content: [{ type: 'text', text }], ...extra };
}

describe('parseRemoteCommandOutput (UI2-12)', () => {
  it('reads a clean success', () => {
    const out = parseRemoteCommandOutput(render({ exitCode: 0, durationMs: 142, stdout: 'total 4\n' }));
    expect(out).not.toBeNull();
    expect(out?.serverId).toBe('nas');
    expect(out?.exitCode).toBe(0);
    expect(out?.signal).toBeNull();
    expect(out?.durationMs).toBe(142);
    expect(out?.stdout).toBe('total 4\n');
    expect(out?.stderr).toBe('');
    expect(out?.timedOut).toBe(false);
    expect(out?.truncated).toBe(false);
  });

  it('reads a failure as a non-zero exit and keeps the two streams apart', () => {
    const out = parseRemoteCommandOutput(
      render({ exitCode: 2, stdout: 'partial', stderr: 'ls: nope: No such file' })
    );
    expect(out?.exitCode).toBe(2);
    expect(out?.stdout).toBe('partial');
    expect(out?.stderr).toBe('ls: nope: No such file');
  });

  it('reads a killed command as a signal with no exit code', () => {
    const out = parseRemoteCommandOutput(render({ exitCode: null, signal: 'SIGKILL' }));
    expect(out?.exitCode).toBeNull();
    expect(out?.signal).toBe('SIGKILL');
  });

  it('sees the timeout flag, which exists nowhere else in a text-only result', () => {
    const out = parseRemoteCommandOutput(render({ exitCode: null, signal: 'SIGKILL', timedOut: true }));
    expect(out?.timedOut).toBe(true);
    expect(out?.truncated).toBe(false);
  });

  it('sees the truncation flag on an otherwise successful command', () => {
    const out = parseRemoteCommandOutput(render({ exitCode: 0, truncated: true }));
    expect(out?.truncated).toBe(true);
    expect(out?.exitCode).toBe(0);
  });

  it('reads a structured JSON result when the Host hands one over', () => {
    const json = JSON.stringify({
      serverId: 'nas',
      command: 'df -h',
      exitCode: 0,
      durationMs: 99,
      timedOut: false,
      truncated: true,
      stdout: 'ok',
      stderr: ''
    });
    const out = parseRemoteCommandOutput(json);
    expect(out?.command).toBe('df -h');
    expect(out?.truncated).toBe(true);
    expect(out?.stdout).toBe('ok');
  });

  it('refuses a JSON object that is not this tool result', () => {
    expect(parseRemoteCommandOutput('{"something":"else"}')).toBeNull();
  });

  /* ---- the null path is the contract, not the exception ---- */

  it('returns null rather than throwing on every malformed shape', () => {
    for (const text of [
      '',
      'not a header at all',
      '[nas] exit 0:\n```\n```',
      '[nas] 12ms (exit 0):',
      '}{',
      '{'
    ]) {
      expect(parseRemoteCommandOutput(text)).toBeNull();
    }
  });

  it('tolerates a header whose trailing colon is missing', () => {
    // Deliberate leniency: the colon is decoration, and a header that is otherwise exactly our
    // grammar still names a server, an exit code and a duration. Falling back to flattened JSON
    // over one missing character would be the worse trade.
    expect(parseRemoteCommandOutput('[nas] exit 0 (12ms)')?.exitCode).toBe(0);
  });

  it('returns null for a non-string, which is what an absent content array yields', () => {
    expect(parseRemoteCommandOutput(undefined as unknown as string)).toBeNull();
  });
});

describe('splitOutput (UI2-12)', () => {
  it('drops both fences and keeps stdout whole when there is no marker', () => {
    expect(splitOutput('```\na\nb\n```')).toEqual({ stdout: 'a\nb', stderr: '' });
  });

  it('splits on the marker line', () => {
    expect(splitOutput('```\na\n[stderr]\nb\n```')).toEqual({ stdout: 'a', stderr: 'b' });
  });

  it('reads a stderr-only result as an empty stdout, not as no output at all', () => {
    expect(splitOutput('```\n[stderr]\nboom\n```')).toEqual({ stdout: '', stderr: 'boom' });
  });
});

describe('resultText (UI2-12)', () => {
  it('joins the text blocks and skips the rest', () => {
    expect(
      resultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', src: 'x' },
          { type: 'text', text: 'b' }
        ]
      })
    ).toBe('a\nb');
  });

  it('is empty for a block with no content array, which is the preparing phase', () => {
    expect(resultText({ phase: 'preparing' })).toBe('');
    expect(resultText(null)).toBe('');
  });
});

describe('stateOf (UI2-12)', () => {
  it('names the two live phases before a result exists', () => {
    expect(stateOf({ phase: 'preparing' })).toBe('preparing');
    expect(stateOf({ phase: 'start', argsRaw: '{}' })).toBe('running');
  });

  it('separates an interrupted call from a failed one', () => {
    expect(stateOf(settled('x', { isError: true, error: { code: 'interrupted' } }))).toBe('stopped');
    expect(stateOf(settled('x', { isError: true, error: { code: 'other' } }))).toBe('error');
    expect(stateOf(settled('x'))).toBe('ok');
  });

  it('does not throw on nothing at all', () => {
    expect(stateOf(null)).toBe('preparing');
  });
});

describe('args, command and server (UI2-12)', () => {
  it('reads the command off the settled block call and off a live one', () => {
    expect(argsOf(settled('x', { call: { name: 't', argsRaw: '{"command":"df -h"}' } }))).toEqual({
      command: 'df -h'
    });
    expect(argsOf({ phase: 'start', argsRaw: '{"command":"uptime"}' })).toEqual({ command: 'uptime' });
  });

  it('yields null for absent or unparseable arguments instead of throwing', () => {
    expect(argsOf(settled('x'))).toBeNull();
    expect(argsOf({ phase: 'start', argsRaw: '{oops' })).toBeNull();
    expect(argsOf({ phase: 'start', argsRaw: '[1]' })).toBeNull();
  });

  it('prefers the requested command and the server that answered', () => {
    const out = parseRemoteCommandOutput(render({ serverId: 'resolved' }));
    expect(commandOf({ command: 'df -h' }, out)).toBe('df -h');
    expect(commandOf(null, { ...out!, command: 'echo hi' })).toBe('echo hi');
    expect(serverOf({ serverId: 'active' }, out)).toBe('resolved');
    expect(serverOf({ serverId: 'active' }, null)).toBe('active');
  });
});

describe('formatDuration (UI2-12)', () => {
  it('keeps milliseconds under a second and switches to seconds above it', () => {
    expect(formatDuration(142)).toBe('142ms');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(30000)).toBe('30s');
  });

  it('is empty rather than NaN when the result has no timing', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

/* --------------------------------- the wiring -------------------------------- */

describe('the card wiring (UI2-12)', () => {
  it('registers under the same wire name the Host half declares', () => {
    // The two literals cannot share a constant across the boundary, so this is the pin: a rename
    // on either side would silently unregister the card and fall back to the generic row.
    expect(TOOLS).toContain(`name: '${TOOL_RUN_REMOTE_COMMAND}'`);
    expect(MAIN).toContain(`key: TOOL_RUN_REMOTE_COMMAND`);
    expect(MAIN).toContain(`ctx.slots.inject('tool.call.toolview'`);
  });

  it('keeps the header grammar the parser reads', () => {
    // The `render()` helper above re-creates the format, so a parser test alone would stay green
    // against a string the Host half no longer emits. This pins the producer.
    expect(TOOLS).toMatch(/\(\$\{val\.durationMs\}ms\)/);
    expect(TOOLS).toContain("' timed_out'");
    expect(TOOLS).toContain("' truncated'");
    expect(TOOLS).toContain('\\n[stderr]\\n');
  });

  it('opens on Enter and Space, not on the mouse alone', () => {
    expect(CARD).toMatch(/onKeyDown/);
    expect(CARD).toMatch(/event\.key !== 'Enter' && event\.key !== ' ' && event\.key !== 'Spacebar'/);
    expect(CARD).toMatch(/aria-expanded/);
    expect(CARD).toMatch(/role: expandable \? 'button'/);
  });

  it('renders a body even when the result does not parse', () => {
    // The fallback is the whole risk of this task: a card that opens onto nothing is worse than
    // the flattened JSON it replaced.
    expect(CARD).toMatch(/output === null\s*\?\s*stream\('raw'/);
  });

  it('never throws on a block it does not recognise', () => {
    // No `throw` anywhere in the card: it is rendered by the conversation, so an exception here is
    // not contained by anything of ours. Both parsers answer null from their catch instead.
    expect(CARD).not.toMatch(/^\s*throw /m);
    expect([...CARD.matchAll(/catch \{\s*return null;?\s*\}/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('carries the state as a hidden word, not as a colour', () => {
    expect(CARD).toMatch(/className: 'att-tool-sr'/);
  });
});

/* -------------------------------- the stylesheet ----------------------------- */

describe('the tool card geometry (UI2-12)', () => {
  /**
   * The **first** rule for a selector, not the last.
   *
   * The other UI2 suites take the last match because `.att-root` is declared three times and the
   * final one wins. Here the opposite holds: `.att-tool-row` is declared once and then *overridden*
   * inside the reduced-motion block, so the last match is the override and reading it would make
   * this suite assert against its own degradation rule.
   */
  function ruleFor(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...SHEET.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))];
    return matches.length === 0 ? '' : (matches[0][1] as string);
  }

  it('borrows the Host row height so the card sits in a transcript of official rows', () => {
    expect(ruleFor('.att-tool-row')).toContain('calc(24px + var(--dsh-content-font-delta, 0px))');
    expect(ruleFor('.att-tool-leading')).toContain('16px');
  });

  it('is not scoped under the panel root, because it renders in the conversation', () => {
    // A rule written as `${ROOT_SELECTOR} .att-tool-card` would never match: the slot renders
    // outside .att-root entirely.
    expect(SHEET).not.toMatch(/\$\{ROOT_SELECTOR\}\s+\.att-tool-/);
  });

  it('caps the output so a runaway command cannot take over the transcript', () => {
    expect(ruleFor('.att-tool-out')).toContain('max-height: 224px');
    expect(ruleFor('.att-tool-server')).toContain('max-width: 160px');
  });

  it('drops the transition under reduced motion', () => {
    const reduced = SHEET.slice(SHEET.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.att-tool-row { transition: none; }');
  });
});

describe('tool card copy (UI2-12)', () => {
  it('carries one key per state in both locales', () => {
    for (const key of [
      'tool.command.noServer',
      'tool.command.noCommand',
      'tool.command.preparing',
      'tool.command.running',
      'tool.command.statusPreparing',
      'tool.command.statusRunning',
      'tool.command.statusOk',
      'tool.command.statusError',
      'tool.command.statusStopped',
      'tool.command.exit',
      'tool.command.signal',
      'tool.command.stdout',
      'tool.command.stderr',
      'tool.command.raw',
      'tool.command.noOutput',
      'tool.command.timedOut',
      'tool.command.truncated',
      'tool.command.copy',
      'tool.command.copied'
    ]) {
      expect(zh[key], `zh ${key}`).toBeTruthy();
      expect(en[key], `en ${key}`).toBeTruthy();
    }
  });
});
