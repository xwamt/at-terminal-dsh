import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS host module
import { PROMPT_SECTION_NAME, PROMPT_SECTION_TEXT, TRUST_VARIABLE, promptSection, trustFact, updateTrustFact } from '../../dsh/prompt.js';

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
    expect(PROMPT_SECTION_TEXT).toContain('at_terminal_job_kill');
    expect(PROMPT_SECTION_TEXT).toContain('policy');
    expect(PROMPT_SECTION_TEXT).toContain('full');
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
