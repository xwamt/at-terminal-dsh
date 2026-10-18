import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { clampPosition } from '../../src/platform/dsh/client/views/monitorHud';
import { en, zh } from '../../src/platform/dsh/client/i18n';

/**
 * UI2-08 — the monitor page and the HUD.
 *
 * Three things are checked here, and it is worth being explicit about which one proves what:
 *
 * 1. **`clampPosition` is a pure function**, so it is tested as one, by stubbing the viewport.
 *    This is the only part of the HUD whose behaviour can be reproduced without a browser.
 * 2. **The rendered structure** (a group with real buttons, not a button with clickable spans)
 *    is asserted on the **source**, not on a render. The React stand-in these node-side tests
 *    use throws on every hook by design — components are exercised through the built bundle in
 *    `client-bundle.test.ts`, and pretending otherwise here would be a test that passes without
 *    ever mounting anything. What a source assertion can prove honestly is that the shape is the
 *    one we intend; it cannot prove the browser agrees.
 * 3. **The stylesheet** is read as text and matched per rule, the same technique (and the same
 *    last-match rule lookup) `client-models.test.ts` uses for the UI2-05/06 geometry.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

const HUD = read('src/platform/dsh/client/views/monitorHud.ts');
const PANE = read('src/platform/dsh/client/views/monitorPane.ts');
const AGENT = read('src/platform/dsh/client/views/monitorAgent.ts');
const HARDWARE = read('src/platform/dsh/client/views/monitorHardware.ts');
const SHEET = read('src/platform/dsh/client/styles.ts');

/** Body of the **last** rule for a selector — `.att-root` is declared more than once. */
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchored at the start of a line, so `button.att-hud-pill-chip` is not mistaken for
  // `.att-hud-pill-chip` — the unanchored form returned the reset rule, and a test that reads the
  // wrong rule passes for the wrong reason.
  const matches = [...SHEET.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))];
  return matches.length === 0 ? '' : (matches[matches.length - 1][1] as string);
}

/* ------------------------------- 1. the geometry ------------------------------ */

describe('clampPosition (UI2-08)', () => {
  const original = globalThis.window;

  function viewport(width: number, height: number): void {
    (globalThis as { window?: unknown }).window = { innerWidth: width, innerHeight: height };
  }

  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  it('keeps a 400x520 window inside a 360px-wide viewport', () => {
    viewport(360, 600);
    const pos = clampPosition(1200, 900, 400, 520);
    // The window the stylesheet will actually draw is min(400, 100vw - 16) = 344, so a box that
    // claimed 400 would have been clamped to x=8 and still hung 40px off the right edge.
    expect(pos.x + Math.min(400, 360 - 16)).toBeLessThanOrEqual(360);
    expect(pos.y + Math.min(520, 600 - 16)).toBeLessThanOrEqual(600);
    expect(pos.x).toBeGreaterThanOrEqual(8);
    expect(pos.y).toBeGreaterThanOrEqual(8);
  });

  it('clamps to the far corner on a roomy viewport instead of pinning to the margin', () => {
    viewport(1200, 800);
    // 1200 - 400 - 8 = 792 and 800 - 520 - 8 = 272: the corner, not the minimum.
    expect(clampPosition(5000, 5000, 400, 520)).toEqual({ x: 792, y: 272 });
  });

  it('never returns a negative or sub-margin coordinate', () => {
    viewport(1200, 800);
    expect(clampPosition(-500, -500, 400, 520)).toEqual({ x: 8, y: 8 });
  });

  it('survives a viewport narrower than the window itself', () => {
    viewport(200, 200);
    const pos = clampPosition(1000, 1000, 400, 520);
    // Both axes bottom out at the margin rather than going negative.
    expect(pos).toEqual({ x: 8, y: 8 });
  });
});

/* ---------------------------- 2. the HUD semantics ---------------------------- */

describe('HUD semantics (UI2-08)', () => {
  it('makes the pill a group, not a button wrapping other controls', () => {
    expect(HUD).toContain("role: 'group'");
    // The regression: `role="button"` on the container swallowed the three chips inside it, so a
    // screen reader heard one long button label and could not reach the parts that act.
    expect(HUD).not.toContain("role: 'button'");
  });

  it('gives every acting chip its own button and its own name', () => {
    // Two pill chips (CPU, MEM) draw the same class; the agent badge is drawn separately.
    const chips = [...HUD.matchAll(/type: 'button',\s*\n\s*className: 'att-hud-pill-chip'/g)];
    expect(chips).toHaveLength(2);
    expect(HUD).toContain("'aria-label': t('monitor.hud.cpuChip'");
    expect(HUD).toContain("'aria-label': t('monitor.hud.memChip'");
    expect(HUD).toContain("'aria-label': t('monitor.hud.agentChip'");
    // The expand chevron was a decorative span with a title and nothing else.
    expect(HUD).toContain("className: 'att-hud-pill-expand'");
    expect(HUD).toContain("'aria-label': t('monitor.hud.expand')");
  });

  it('titles the HUD with its own key instead of the tab label', () => {
    expect(HUD).toContain("t('monitor.hud.title')");
    // `monitor.title` names the sidebar tab now; a floating window called the same thing is the
    // ambiguity UI2-10 removes.
    expect(HUD).not.toContain("'aria-label': t('monitor.title')");
  });

  it('carries the monitor page tabs as a real tablist with a tabpanel', () => {
    expect(PANE).toContain("role: 'tablist'");
    expect(PANE).toContain("'aria-controls': 'att-monitor-tabpanel'");
    expect(PANE).toContain("id: 'att-monitor-tab-hardware'");
    expect(PANE).toContain("role: 'tabpanel'");
    expect(PANE).toContain("'aria-labelledby':");
    // Roving tabindex: two Tab stops for two tabs would be two too many.
    expect(PANE).toContain('tabIndex: activeTab ===');
  });
});

/* ------------------------------ 3. no dev residue ----------------------------- */

describe('no hardcoded wire strings or sub-11px text (UI2-08)', () => {
  const monitorSources: Array<[string, string]> = [
    ['monitorHud.ts', HUD],
    ['monitorPane.ts', PANE],
    ['monitorAgent.ts', AGENT],
    ['monitorHardware.ts', HARDWARE]
  ];

  it('leaves no English state word or field label in the markup', () => {
    for (const [name, source] of monitorSources) {
      expect(source, name).not.toMatch(/'WAIT'/);
      expect(source, name).not.toMatch(/'RUN'/);
      expect(source, name).not.toContain('Load: ');
    }
    // `Default` was the server-name fallback for a HUD with no session behind it.
    expect(HUD).not.toContain("|| 'Default'");
    /*
     * The audit row printed the wire value (`low`/`medium`/`high` from
     * `AgentExecutionBridge`) straight into a cell, uppercased to look like a badge. The
     * `'error' | 'warn' | 'normal'` tokens elsewhere in these files are a different thing —
     * they are `data-level` keys the stylesheet switches on, never text — so the assertion is
     * about the presentation that made a wire value look like copy.
     */
    expect(AGENT).not.toContain("textTransform: 'uppercase'");
    expect(AGENT).toContain('riskLabel(t, audit.riskLevel)');
  });

  it('uses no 10px text — 11px is the host floor', () => {
    for (const [name, source] of monitorSources) {
      expect(source, name).not.toContain("fontSize: '10px'");
    }
  });

  it('formats the audit clock in the host locale, not the renderer default', () => {
    expect(AGENT).not.toContain('toLocaleTimeString');
    expect(AGENT).toContain('formatClock(');
  });

  it('keeps zh/en key sets identical', () => {
    // A key present in one language only renders as its own name — a visible defect, and the one
    // this file's new keys could most easily introduce.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
});

/* -------------------------------- 4. the styles ------------------------------- */

describe('HUD styles (UI2-08)', () => {
  it('caps the floating window with min() so it cannot leave the viewport', () => {
    const rule = ruleFor('.att-floating-window');
    expect(rule).toContain('width: min(400px, calc(100vw - 16px))');
    expect(rule).toContain('max-height: min(540px, calc(100vh - 16px))');
  });

  it('resets the native button the pill chips now are', () => {
    const rule = ruleFor('.att-hud-pill-chip');
    expect(rule).toContain('border: none');
    expect(rule).toContain('font: inherit');
    expect(SHEET).toContain('button.att-hud-pill-chip');
  });

  it('stops the decoration moving under reduce', () => {
    const reduce = SHEET.slice(SHEET.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const selector of [
      '.att-monitor-badge-pulse-dot',
      '.att-monitor-gauge-fill',
      '.att-hud-pill',
      '.att-floating-window',
      '.att-monitor-tab-btn',
      '.att-floating-tab-btn'
    ]) {
      expect(reduce.slice(0, reduce.indexOf('}\n.att-banners')), selector).toContain(selector);
    }
  });

  it('gives the tab title something to shrink against (D5)', () => {
    // Without this the host chip clipped the span's overflow and the title read `家用n` — a hard
    // cut that looks like a different server, not a truncation.
    expect(ruleFor('.att-tab-title')).toContain('max-width: 100%');
    expect(ruleFor('.att-tab-title-text')).toContain('text-overflow: ellipsis');
  });
});
