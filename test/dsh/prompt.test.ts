import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS host module
import { PROMPT_SECTION_NAME, PROMPT_SECTION_TEXT, PROMPT_SECTION_TEXT_FALLBACK, TRUST_VARIABLE, hasVisibleAtTerminalTool, promptSection, trustFact, updateTrustFact } from '../../dsh/prompt.js';

/**
 * The prompt section.
 *
 * The strictest assertion here is not about wording: it is that the text references exactly
 * one variable and that the exported name matches it. `dsh-system-prompt` interpolates
 * strictly — an unregistered `{{name}}` throws during assembly, which fails every model
 * request rather than one tool call — so a typo in the text is not a cosmetic bug.
 */
describe('the prompt section', () => {
  it('carries the order it is given and the section name the host sorts by', () => {
    const section = promptSection({ order: 1000 });

    expect(section.name).toBe(PROMPT_SECTION_NAME);
    expect(section.order).toBe(1000);
    expect(section.name.startsWith('tool:')).toBe(true);
  });

  it('names exactly one variable, and it is the one this bundle registers', () => {
    const references = PROMPT_SECTION_TEXT.match(/\{\{[^}]*\}\}/g) ?? [];

    expect(references).toEqual([`{{${TRUST_VARIABLE}}}`]);
    // The host's own rule: /^[a-z][a-z0-9_]*$/ in dsh-system-prompt. An invalid name throws
    // at `variable()` registration, before any of this is reachable.
    expect(TRUST_VARIABLE).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('states the rules the tool descriptions no longer repeat', () => {
    // Not a style check: each of these is a decision the model cannot recover from the tool
    // names alone, so losing one silently would be a regression in guidance.
    expect(PROMPT_SECTION_TEXT).toContain('sftp_stat_path');
    expect(PROMPT_SECTION_TEXT).toContain('spillPath');
    expect(PROMPT_SECTION_TEXT).toContain('job_kill');
    expect(PROMPT_SECTION_TEXT).toContain('policy');
    expect(PROMPT_SECTION_TEXT).toContain('full');
    // The fallback wording is the same guidance with the plugin's own control names.
    expect(PROMPT_SECTION_TEXT_FALLBACK).toContain('at_terminal_job_kill');
    expect(PROMPT_SECTION_TEXT_FALLBACK).toContain('at_terminal_job_output');
  });

  it('renders the job-control names the step can actually see', () => {
    const section = promptSection({ order: 1000 });
    const host = {
      view: () =>
        new Map([
          ['at_terminal_run_remote_command', {}],
          ['job_output', {}],
          ['job_kill', {}]
        ])
    };
    const fallback = {
      view: () =>
        new Map([
          ['at_terminal_run_remote_command', {}],
          ['at_terminal_job_output', {}],
          ['at_terminal_job_kill', {}]
        ])
    };

    expect(section.text({ scope: {}, toolSet: host })).toContain(
      'collect it with job_output, end it with job_kill'
    );
    expect(section.text({ scope: {}, toolSet: fallback })).toContain(
      'collect it with at_terminal_job_output, end it with at_terminal_job_kill'
    );
  });

  it('is empty when only resident tools are visible, and fail-open without an admission set', () => {
    const section = promptSection({ order: 1000 });
    const resident = {
      view: () =>
        new Map([
          ['at_terminal_ping', {}],
          ['at_terminal_list_ssh_servers', {}],
          ['at_terminal_get_terminal_context', {}],
          ['at_terminal_get_agent_execution_status', {}]
        ])
    };

    expect(section.text({ scope: {}, toolSet: resident })).toBe('');
    // No toolSet means registration-time inspection or an older host: keep the guidance.
    expect(section.text({})).toContain('AT Terminal acts');
    expect(hasVisibleAtTerminalTool(undefined)).toBe(true);
    expect(hasVisibleAtTerminalTool(resident)).toBe(false);
    // Plain iterables are accepted too; an array must not be read through `.keys()`, which
    // yields indices and makes every tool look invisible.
    expect(hasVisibleAtTerminalTool(['at_terminal_ping'])).toBe(false);
    expect(hasVisibleAtTerminalTool(['at_terminal_ping', 'at_terminal_run_remote_command'])).toBe(true);
  });

  it('sends a local file through localPath, and says an upload asks even at full trust', () => {
    // The door itself. A model that never learns `localPath` exists is back to inlining: a
    // 7.3 MB binary is ~10 MB of base64 in one call, which no context survives.
    expect(PROMPT_SECTION_TEXT).toContain('localPath');
    expect(PROMPT_SECTION_TEXT).toContain('never inlined as content');
    // And the exception to the trust rule above it: an upload pushes a file the model has not
    // read, so "full" must not be read as "no prompt for this one".
    expect(PROMPT_SECTION_TEXT).toContain('A localPath upload asks even on full trust');
  });

  it('stays ASCII, which is the one budget the section is written against', () => {
    // The header claims it and nothing checked it: one curly quote costs three bytes on every
    // request, and the text is assembled into a prompt that is otherwise plain ASCII.
    expect(PROMPT_SECTION_TEXT).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('refuses an order it cannot get from the host, naming the name that failed', () => {
    // `getSectionOrder('TOOL_BASH')` returns undefined for an unknown key rather than
    // throwing, and `section()` would then reject the order with a message that never
    // mentions the name. This check exists to keep that diagnosis.
    expect(() => promptSection({ order: undefined as never })).toThrow(/TOOL_BASH/);
  });
});

describe('the trust fact', () => {
  it('names each server with its trust', () => {
    expect(updateTrustFact([{ label: 'production', agentCommandTrust: 'full' }])).toBe(
      'production (full)'
    );
    expect(trustFact()).toBe('production (full)');
  });

  it('bounds a large inventory to one line', () => {
    const servers = Array.from({ length: 8 }, (_, index) => ({
      label: `srv-${index}`,
      agentCommandTrust: 'policy'
    }));

    const fact = updateTrustFact(servers);

    expect(fact).toContain('srv-4 (policy)');
    expect(fact).not.toContain('srv-5');
    expect(fact.endsWith('+3 more')).toBe(true);
  });

  it('says nothing was found only when something was actually read', () => {
    // The distinction matters: "none configured" is a claim about the user's setup, and
    // before any tool has read the list we have not looked.
    expect(updateTrustFact([])).toBe('no servers are usable by this plugin');
    expect(updateTrustFact(undefined)).toContain('not read yet');
  });

  it('falls back to the id when a server has no label', () => {
    expect(updateTrustFact([{ id: 'srv-9', agentCommandTrust: 'none' }])).toBe('srv-9 (none)');
  });
});
