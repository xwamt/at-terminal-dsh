import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { en, zh } from '../../src/platform/dsh/client/i18n';

/**
 * UI2-10 — copy, i18n symmetry, and the contrast of the one surface that has to be read.
 *
 * Copy defects do not throw and do not look broken in a screenshot, which is why they survive
 * review: a Chinese string with the English word "plainly" left inside it reads as a machine
 * translation, and a tab labelled 「监控悬浮窗」 describes a window the tab is not. Both shipped.
 *
 * The contrast item is asserted structurally rather than numerically. The 4.4976:1 figure came
 * from measuring `--vscode-errorForeground` against the light theme's panel fill in the 2026-10-07
 * audit; this repo has no theme table to re-measure against, so what can be checked is that the
 * banner stopped using that token **as body text** and kept it on the frame — which is the change
 * that removes the question rather than moving the number.
 */

const SHEET = readFileSync(join(process.cwd(), 'src/platform/dsh/client/styles.ts'), 'utf8');

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...SHEET.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))];
  return matches.length === 0 ? '' : (matches[matches.length - 1][1] as string);
}

describe('zh/en key sets (UI2-10)', () => {
  it('is identical in both directions', () => {
    // A key in one language only renders as its own name — `monitor.hud.pillLabel` on screen.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no empty value in either locale', () => {
    for (const [key, value] of Object.entries(zh)) expect(value.trim(), `zh:${key}`).not.toBe('');
    for (const [key, value] of Object.entries(en)) expect(value.trim(), `en:${key}`).not.toBe('');
  });
});

describe('copy that was wrong (UI2-10)', () => {
  it('does not send the user to another product for a package this plugin imports', () => {
    // 「从 VS Code 变体『导入』资产包」 pointed at a menu that does not exist here, while this
    // panel has its own 导入 button two rows above the sentence.
    const empty = zh['servers.empty'] ?? '';
    expect(empty).not.toContain('VS Code');
    expect(empty).toContain('导入');
  });

  it('keeps the Chinese copy Chinese', () => {
    // `无法 plainly 读取的命令` — an English adverb dropped into a Chinese sentence, which is what
    // a half-finished translation looks like.
    expect(zh['form.trustHelpPolicy']).not.toContain('plainly');
    expect(zh['form.trustHelpPolicy']).toContain('无法直接读取');
  });

  it('calls the sidebar tab a tab, and the floating window a window', () => {
    expect(zh['monitor.title']).toBe('监控');
    expect(en['monitor.title']).toBe('Monitor');
    // The HUD keeps the longer name — it really is a floating window.
    expect(zh['monitor.hud.title']).toBe('监控悬浮窗');
    expect(en['monitor.hud.title']).toBe('Monitor Window');
  });

  it('spells the auth method the same way in the badge and in the help text', () => {
    // `agent` in the row, `SSH Agent` in the form — two names for one method.
    expect(zh['auth.agent']).toBe(zh['auth.agent.title']);
    expect(en['auth.agent']).toBe(en['auth.agent.title']);
  });

  it('keeps the guide description short enough to survive one 11px line', () => {
    // The card truncates; the old sentence named the double-click and was cut mid-clause. The
    // hint still lives in the empty state, where there is room for it.
    expect((zh['guide.description'] ?? '').length).toBeLessThanOrEqual(20);
    expect((en['guide.description'] ?? '').length).toBeLessThanOrEqual(40);
    expect(zh['guide.description']).not.toContain('双击');
  });
});

describe('the failure banner is readable (UI2-10)', () => {
  it('puts the error colour on the frame, not on the body copy', () => {
    const rule = ruleFor('.att-banner');
    // 4.4976:1 was this token as body text on the light panel fill — just under the floor, on the
    // one surface a user has to read to find out what went wrong.
    expect(rule).toContain('border: 1px solid var(--vscode-errorForeground)');
    expect(rule).toContain('color: var(--dsw-alias-label-primary)');
    expect(rule).not.toContain('color: var(--vscode-errorForeground)');
  });

  it('makes the frame thick enough on the leading edge to still read as an error', () => {
    // Border-only at 1px is a hairline; 3px on the left is the same signal at a glance.
    expect(ruleFor('.att-banner')).toContain('border-left-width: 3px');
    expect(ruleFor('.att-banner > div:first-child')).toContain('font-weight: 600');
  });
});
