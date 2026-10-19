/**
 * The conversation card for one remote command (UI2-12).
 *
 * The Host renders every tool call through the keyed slot `tool.call.toolview`, keyed by the
 * **wire** tool name, and falls back to its own `GenericToolCard` when nobody claims the key.
 * Unclaimed, our command arrives in the transcript as the one string `dsh/tools.js` builds —
 * a bracketed header, a fenced block, and the two streams flattened into it. That is readable
 * but it is not scannable: the exit code, the duration, whether the output was cut, and which
 * server answered are all prose in the same paragraph as the payload.
 *
 * So this module claims `at_terminal_run_remote_command` and re-renders the same result as a
 * row that collapses to `server · $ command · exit 0 · 142ms` and opens into the two streams.
 *
 * ## What this card is not
 *
 * It is presentation only. It reads the block the Host already holds; it never runs, approves,
 * cancels or re-runs the command, and it does not add a control that could. Removing the one
 * `ctx.slots.inject` call in `main.ts` returns the tool to the generic card — that is the
 * rollback, and it is why nothing here is load-bearing for the tool itself.
 *
 * ## Why the parser is layered and never throws
 *
 * The block is a **Host contract** this plugin does not own and cannot pin. Three things
 * therefore hold, in this order:
 *
 *  1. a structured result (one JSON object) wins when it is there;
 *  2. otherwise the documented one-line grammar of our own header is parsed;
 *  3. otherwise the row still renders — the command comes from the call's own arguments and
 *     the raw text goes in the body.
 *
 * Every layer returns `null` instead of throwing, because a card that throws takes the whole
 * transcript with it: this component is rendered by the conversation, not by our panel, so a
 * render error here is not contained by anything of ours.
 */

import React, { useState } from 'react';

import type { Translate } from '../models';
import { chevronDownRegular, chevronUpRegular, terminalRegular } from '../icons';
import { h, type El } from './shared';

/**
 * The wire name of the one tool this card claims.
 *
 * Duplicated across the boundary on purpose — `dsh/tools.js` is the Host half's list and cannot
 * be imported from the client bundle. `test/dsh/tool-call.test.ts` asserts the two literals agree,
 * which is what stops a rename on one side from silently unregistering the card.
 */
export const TOOL_RUN_REMOTE_COMMAND = 'at_terminal_run_remote_command';

/* --------------------------------- the model -------------------------------- */

/** One settled remote command, as the card wants it. Unknown halves stay null rather than 0. */
export interface RemoteCommandOutput {
  serverId: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

/** The lifecycle of a call, in the Host's own four words plus the two live ones. */
export type CallState = 'preparing' | 'running' | 'stopped' | 'error' | 'ok';

/** Anything the Host may hand us: read defensively, never by assertion. */
type Loose = Record<string, any>;

function asLoose(value: unknown): Loose | null {
  return typeof value === 'object' && value !== null ? (value as Loose) : null;
}

function readString(source: Loose | null, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The text of a result: every `text` block joined, in order.
 *
 * Mirrors the Host's own `resultText` for the block types this tool emits. Non-text blocks are
 * skipped rather than stringified — a card that rendered `{"type":"image"}` in a terminal font
 * would be answering a question nobody asked.
 */
export function resultText(block: unknown): string {
  const content = asLoose(block)?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const entry of content) {
    const item = asLoose(entry);
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}

/** The first layer: one JSON object carrying the result. */
function parseStructuredResult(text: string): RemoteCommandOutput | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const source = asLoose(value);
  if (source === null) return null;
  // A JSON blob that is not *our* result — an unrelated object that happens to be the payload —
  // must not be read as one: it would produce a card claiming exit 0 on a command we know
  // nothing about. At least one of the fields that only this tool sets has to be present.
  const familiar =
    typeof source.command === 'string' ||
    typeof source.stdout === 'string' ||
    typeof source.exitCode === 'number' ||
    typeof source.durationMs === 'number';
  if (!familiar) return null;
  return {
    serverId: readString(source, 'serverId') || readString(source, 'serverLabel'),
    command: readString(source, 'command'),
    exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
    signal: typeof source.signal === 'string' ? source.signal : null,
    durationMs: typeof source.durationMs === 'number' ? source.durationMs : null,
    timedOut: source.timedOut === true,
    truncated: source.truncated === true,
    stdout: readString(source, 'stdout'),
    stderr: readString(source, 'stderr')
  };
}

/**
 * The second layer: our own header grammar.
 *
 * `[serverId] exit 0 (142ms) truncated:` — the flags are a **deliberate** part of the grammar,
 * because a timeout and a truncation exist nowhere else in a text-only result: a killed command
 * and a completed one differ only in this line, and a card that showed 成功 for the killed one
 * would be worse than no card at all.
 */
const HEADER = /^\[([^\]]*)\]\s+(?:exit\s+(-?\d+)|signal\s+(\S+))\s+\((\d+)ms\)([^:]*)/;

const FENCE_LINE = /^\s*```[^\n]*$/;

/** Split the fenced body into the two streams on the marker line, dropping both fences. */
export function splitOutput(body: string): { stdout: string; stderr: string } {
  const lines = body.split('\n');
  if (lines.length > 0 && FENCE_LINE.test(lines[0])) lines.shift();
  if (lines.length > 0 && FENCE_LINE.test(lines[lines.length - 1])) lines.pop();
  const at = lines.indexOf('[stderr]');
  if (at === -1) return { stdout: lines.join('\n'), stderr: '' };
  return { stdout: lines.slice(0, at).join('\n'), stderr: lines.slice(at + 1).join('\n') };
}

/**
 * Read a settled command out of a result's text, or `null`.
 *
 * `null` is a normal answer, not an error: it means "this is not the shape this card knows",
 * and the caller falls back to the raw text. Nothing in here throws.
 */
export function parseRemoteCommandOutput(text: string): RemoteCommandOutput | null {
  // The type check is first, not last: `text` arrives from a Host block, and a card that threw
  // a TypeError on an absent content array would take the transcript with it.
  if (typeof text !== 'string' || text === '') return null;
  const structured = parseStructuredResult(text);
  if (structured !== null) return structured;
  const nl = text.indexOf('\n');
  const head = (nl === -1 ? text : text.slice(0, nl)).trim();
  const body = nl === -1 ? '' : text.slice(nl + 1);
  const matched = HEADER.exec(head);
  if (matched === null) return null;
  const flags = matched[5] ?? '';
  return {
    serverId: matched[1] ?? '',
    command: '',
    exitCode: matched[2] === undefined ? null : Number(matched[2]),
    signal: matched[3] === undefined ? null : matched[3],
    durationMs: matched[4] === undefined ? null : Number(matched[4]),
    timedOut: /\btimed_out\b/.test(flags),
    truncated: /\btruncated\b/.test(flags),
    ...splitOutput(body)
  };
}

/** The call's raw argument text: on the settled block it lives under `call`, before that on the block. */
function rawArgs(block: unknown): string | null {
  const source = asLoose(block);
  if (source === null) return null;
  const raw = 'kind' in source ? source.call?.argsRaw : source.argsRaw;
  return typeof raw === 'string' ? raw : null;
}

/** The parsed argument object, or null when the Host has not settled on one yet. */
export function argsOf(block: unknown): Loose | null {
  const raw = rawArgs(block);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const source = asLoose(value);
  return source === null || Array.isArray(value) ? null : source;
}

/**
 * The command line, from the arguments in preference to the result.
 *
 * The arguments are the request and are available while the call is still running, so a row for
 * an in-flight command can say what it is running. The result's own `command` is the echo and is
 * only reached when the arguments were never parsed.
 */
export function commandOf(args: Loose | null, output: RemoteCommandOutput | null): string {
  const fromArgs = args === null ? '' : readString(args, 'command');
  if (fromArgs !== '') return fromArgs;
  return output === null ? '' : output.command;
}

/**
 * Which server the row names, preferring the one that answered.
 *
 * A result's `serverId` is the resolved target; the argument's is the request, which for this
 * tool may be the literal `active`. Naming the request when the result is present would print
 * `active` on a settled row forever.
 */
export function serverOf(args: Loose | null, output: RemoteCommandOutput | null): string {
  if (output !== null && output.serverId !== '') return output.serverId;
  return args === null ? '' : readString(args, 'serverId');
}

/** The Host's own state derivation, which decides the row's tone and whether it can open. */
export function stateOf(block: unknown): CallState {
  const source = asLoose(block);
  if (source === null) return 'preparing';
  if (!('kind' in source)) return source.phase === 'preparing' ? 'preparing' : 'running';
  if (source.error?.code === 'interrupted') return 'stopped';
  return source.isError === true ? 'error' : 'ok';
}

/** `142ms` / `1.4s` — one number a folded row can afford next to the command. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/* -------------------------------- the component ------------------------------ */

/**
 * The slice of the Host's `tool.call.toolview` owner this card reads.
 *
 * Every field is optional except `t`: the owner is assembled by the Host and its shape is not
 * ours to pin, so an absent `useDisclosure` or `inspect` degrades instead of throwing.
 */
export interface ToolCallOwnerProps {
  t: Translate;
  block?: unknown;
  phase?: string;
  toolName?: string;
  callId?: string;
  cwd?: string;
  home?: string;
  useDisclosure?: () => { expanded: boolean; toggle: () => void };
  inspect?: () => void;
}

/** The visually hidden word that carries what the row's colour and chevron alone would say. */
function statusText(t: Translate, state: CallState): string {
  if (state === 'preparing') return t('tool.command.statusPreparing');
  if (state === 'running') return t('tool.command.statusRunning');
  if (state === 'error') return t('tool.command.statusError');
  if (state === 'stopped') return t('tool.command.statusStopped');
  return t('tool.command.statusOk');
}

/** `exit 0`, or the signal when the process never chose one. Both are a badge, never prose. */
function exitLabel(t: Translate, output: RemoteCommandOutput | null): string {
  if (output === null) return '';
  if (output.exitCode !== null) return t('tool.command.exit', { code: String(output.exitCode) });
  if (output.signal !== null) return t('tool.command.signal', { signal: output.signal });
  return '';
}

/**
 * The remote-command row.
 *
 * Collapsed by default and keyed to open on Enter as well as Space, which is what the Host's own
 * tool rows do — a row that looks like a button and answers only the mouse is a row a keyboard
 * user cannot read. `aria-expanded` rather than a bare `data-` attribute for the same reason.
 */
export function AtTerminalCommandRow(props: ToolCallOwnerProps): El {
  const { t } = props;
  const block = props.block ?? null;
  const state = stateOf(block);
  const text = resultText(block);
  const output = parseRemoteCommandOutput(text);
  const args = argsOf(block);
  const command = commandOf(args, output);
  const server = serverOf(args, output) || t('tool.command.noServer');

  const live = state === 'preparing' || state === 'running';
  const expandable = !live && (output !== null || text !== '' || command !== '');
  // A hook either way: the Host always supplies `useDisclosure`, but a card rendered anywhere
  // else must still call exactly one hook per render rather than conditionally none.
  const useDisclosure = props.useDisclosure ?? (() => ({ expanded: false, toggle: () => {} }));
  const { expanded, toggle } = useDisclosure();
  const [copied, setCopied] = useState(false);
  const open = expandable && expanded;

  const onKeyDown = (event: { key?: string; preventDefault?: () => void }): void => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault?.();
    toggle();
  };

  const leading = open
    ? chevronUpRegular({ className: 'att-tool-chevron', size: 14 })
    : expandable
      ? chevronDownRegular({ className: 'att-tool-chevron', size: 14 })
      : terminalRegular({ className: 'att-tool-icon', size: 14 });

  const summary = live
    ? state === 'preparing'
      ? t('tool.command.preparing')
      : t('tool.command.running')
    : command === ''
      ? t('tool.command.noCommand')
      : `$ ${command}`;

  const label = exitLabel(t, output);
  const duration = formatDuration(output === null ? null : output.durationMs);
  const stdout = output === null ? '' : output.stdout;
  const stderr = output === null ? '' : output.stderr;

  const onCopy = (): void => {
    const payload = [stdout, stderr].filter((part) => part !== '').join('\n');
    const clipboard = (globalThis.navigator as { clipboard?: { writeText?: (v: string) => unknown } })
      ?.clipboard;
    if (typeof clipboard?.writeText !== 'function') return;
    clipboard.writeText(payload);
    setCopied(true);
    if (typeof window !== 'undefined') window.setTimeout(() => setCopied(false), 1200);
  };

  const flags: El[] = [];
  if (output !== null && output.timedOut) {
    flags.push(h('div', { key: 'timedOut', className: 'att-tool-flag' }, t('tool.command.timedOut')));
  }
  if (output !== null && output.truncated) {
    flags.push(h('div', { key: 'truncated', className: 'att-tool-flag' }, t('tool.command.truncated')));
  }

  const stream = (key: string, name: string, body: string, isError: boolean): El =>
    h(
      'div',
      { key, className: 'att-tool-section' },
      h('span', { className: 'att-tool-label' }, t(name)),
      h(
        'pre',
        { className: 'att-tool-out', 'data-error': isError ? 'true' : 'false' },
        body === '' ? t('tool.command.noOutput') : body
      )
    );

  return h(
    'div',
    { className: 'att-tool-card', 'data-at-terminal-tool': TOOL_RUN_REMOTE_COMMAND, 'data-state': state },
    h(
      'div',
      {
        className: 'att-tool-row',
        'data-expandable': expandable ? 'true' : 'false',
        role: expandable ? 'button' : undefined,
        tabIndex: expandable ? 0 : undefined,
        'aria-expanded': expandable ? open : undefined,
        onClick: expandable ? toggle : undefined,
        onKeyDown: expandable ? onKeyDown : undefined
      },
      h('span', { className: 'att-tool-leading' }, leading),
      // The colour and the chevron are the only other carriers of this, and both are decorative
      // to a screen reader — so the state is a real, hidden word rather than a title attribute.
      h('span', { className: 'att-tool-sr' }, statusText(t, state)),
      h('span', { className: 'att-tool-server' }, server),
      h('span', { className: 'att-tool-sep', 'aria-hidden': 'true' }),
      h('span', { className: 'att-tool-summary' }, summary),
      label === '' ? null : h('span', { className: 'att-tool-badge', 'data-error': state === 'error' || state === 'stopped' ? 'true' : 'false' }, label),
      duration === '' ? null : h('span', { className: 'att-tool-duration' }, duration)
    ),
    open
      ? h(
          'div',
          { className: 'att-tool-body' },
          flags.length === 0 ? null : h('div', { className: 'att-tool-flags' }, ...flags),
          // A result that parsed is shown as its two streams. One that did not is shown as the
          // text the Host holds — the fallback is never a blank body, because a card that opens
          // onto nothing is more alarming than the flattened JSON it replaced.
          output === null
            ? stream('raw', 'tool.command.raw', text, state === 'error')
            : [
                stream('stdout', 'tool.command.stdout', stdout, false),
                ...(stderr === '' ? [] : [stream('stderr', 'tool.command.stderr', stderr, true)])
              ],
          h(
            'div',
            { className: 'att-tool-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'att-btn att-tool-copy',
                onClick: onCopy,
                'data-at-terminal-action': 'tool-copy'
              },
              copied ? t('tool.command.copied') : t('tool.command.copy')
            )
          )
        )
      : null
  );
}
