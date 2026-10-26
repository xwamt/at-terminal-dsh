import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { clampPosition } from '../../src/platform/dsh/client/views/monitorHud';
import { needsCommandDisclosure, selectAuditRows } from '../../src/platform/dsh/client/views/monitorAgent';
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
const MAIN = read('src/platform/dsh/client/main.ts');
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

/* ------------------------- 5. the floating window's rules ------------------------- */

describe('floating HUD behaviour', () => {
  it('opens as the capsule when a connection appears', () => {
    // `forceExpanded` outlives a disconnect, so the container has to reset it on the transition
    // into "connected"; otherwise the window reopens expanded after any earlier open().
    expect(MAIN).toMatch(/if \(!connectedRef\.current\) \{[\s\S]*?setForceExpanded\(false\)/);
    // And the widget's own initial state is collapsed unless someone explicitly forces it open.
    expect(HUD).toContain('useState(Boolean(forceExpanded))');
  });

  it('does not repeat the tab strip as a second row of buttons under the overview', () => {
    expect(HUD).not.toContain('Quick Action Navigation Buttons');
    const overview = HUD.slice(HUD.indexOf("activeTab === 'overview'"), HUD.indexOf("activeTab === 'hardware' &&"));
    expect(overview.length).toBeGreaterThan(0);
    expect(overview).not.toContain('att-btn');
    expect(overview).not.toContain("t('monitor.hud.minimize')");
  });

  it('defaults to four audit rows and expands to the whole connection history', () => {
    const audits = Array.from({ length: 7 }, (_, i) => ({
      id: `audit-${i}`,
      timestamp: 1000 + i,
      command: `command-${i}`,
      decision: 'allowed' as const
    }));

    const recent = selectAuditRows(audits, audits, false);
    expect(recent).toHaveLength(4);
    expect(recent[0].id).toBe('audit-0');

    expect(selectAuditRows(audits, audits, true)).toHaveLength(7);
    // The sidebar pane passes no history and must keep rendering the snapshot as-is.
    expect(selectAuditRows(audits, undefined, false)).toHaveLength(7);
  });

  it('accumulates one connection of audits and resets on disconnect', () => {
    // The poll asks for more than the four rendered rows, or history could never grow past them.
    expect(MAIN).toContain('getAgentExecutionStatusRpc(50)');
    expect(MAIN).toMatch(/!seen\.has\(audit\.id\) && audit\.timestamp >= startedAt/);
    expect(MAIN).toMatch(/connectionStartedAtRef\.current = 0/);
    expect(HUD).toContain('history: auditHistory');
    expect(AGENT).toContain("t('monitor.agent.history')");
    expect(AGENT).toContain("t('monitor.agent.historyBack')");
  });

  it('clips a long command to one line instead of widening the window', () => {
    // `table-layout: fixed` is what makes the clipped cell possible: under the default auto
    // layout the browser sizes the column from its longest command and the table overflows.
    expect(ruleFor('.att-audit-table')).toContain('table-layout: fixed');
    expect(ruleFor('.att-clip-line')).toContain('text-overflow: ellipsis');
    expect(ruleFor('.att-clip-line')).toContain('overflow: hidden');
    expect(ruleFor('.att-clip-line')).toContain('white-space: nowrap');

    expect(AGENT).toContain('className: \'att-monitor-table att-audit-table\'');
    expect(AGENT).toContain("className: 'att-clip-line'");
    expect(AGENT).toContain("'colgroup'");
    // No leftover hard-coded width that the old cell used to rely on.
    expect(AGENT).not.toContain("maxWidth: '300px'");
  });

  it('offers a disclosure only for commands that cannot fit on one line', () => {
    expect(needsCommandDisclosure('uptime')).toBe(false);
    expect(needsCommandDisclosure('a'.repeat(24))).toBe(false);
    expect(needsCommandDisclosure('a'.repeat(25))).toBe(true);
    expect(needsCommandDisclosure("echo '=== 10s delta ==='; a=$(awk '/MemAvailable/{print $2}'")).toBe(true);
    // A newline can never be shown on a single line, however short the command is.
    expect(needsCommandDisclosure('line1\nline2')).toBe(true);

    expect(AGENT).toContain('needsCommandDisclosure(audit.command)');
    expect(AGENT).toContain("className: 'att-clip-full'");
    expect(AGENT).toContain("t('monitor.agent.expandCommand')");
    expect(AGENT).toContain("t('monitor.agent.collapseCommand')");
    expect(AGENT).toContain("'aria-expanded': expanded");
  });

  it('keeps the decision badge and risk column on one line', () => {
    // A narrow fixed column used to break 策略放行 into four stacked characters.
    expect(ruleFor('.att-monitor-badge')).toContain('white-space: nowrap');
    expect(AGENT).toContain("style: { whiteSpace: 'nowrap' }");
  });

  it('clips long disk mount paths instead of pushing the usage figure off the card', () => {
    // A Docker host answers with /var/lib/docker/overlay2/<64 hex>/merged; the row used to grow
    // past the card because neither flex child was allowed to shrink.
    expect(ruleFor('.att-clip-line')).toContain('text-overflow: ellipsis');
    expect(HARDWARE).toContain("className: 'att-clip-line'");
    expect(HARDWARE).toContain("className: 'att-clip-toggle'");
    expect(HARDWARE).toContain("className: 'att-clip-full'");
    expect(HARDWARE).toContain('needsTextDisclosure(label)');
    expect(HARDWARE).toContain("t('monitor.disk.expand')");
    expect(HARDWARE).toContain("t('monitor.disk.collapse')");
    expect(HARDWARE).toContain('minWidth: 0');
    // The usage figure keeps its width; the label is what shrinks.
    expect(HARDWARE).toContain("flex: '0 0 auto'");
    expect(HARDWARE).not.toContain("justifyContent: 'space-between'");
  });
});

/**
 * The HUD's visibility is the user's decision once they have made one.
 *
 * Reported: closing the capsule with its ✕ and then switching terminal tabs brought it back. The
 * cause was an unconditional `setVisible(true)` in the handler that follows the active terminal —
 * and that handler fires on every tab switch, not only on a new connection. The fix moved the
 * `true` inside the `if (!connectedRef.current)` transition, so "something is connected" no longer
 * means "show the HUD".
 *
 * A closed HUD also stopped polling. Hardware metrics is not a local read — the tool runs commands
 * on the remote host — so a dismissed window that kept its 4-second interval was still holding a
 * pty busy on the server for nobody.
 *
 * Asserted on the source, like the rest of this file: the node-side React stand-in throws on every
 * hook by design, so a render here would prove nothing about either behaviour.
 */
/**
 * The HUD's visibility is the user's decision once they have made one, and its whole surface drags.
 *
 * Two reports, both fixed here:
 *
 * 1. Closing the capsule with its ✕ and switching terminal tabs brought it back — the handler that
 *    follows the active terminal called `setVisible(true)` on every change, not on the 0 → 1
 *    transition.
 * 2. Closing it and then connecting a new terminal brought it back too. That one was *design*: a
 *    new connection always opened the capsule. From the user's side it is the same complaint — "I
 *    closed it, I did not ask for it" — so the dismissal is now persisted and outranks every
 *    automatic show. What remains for reopening is an explicit request: the agent's
 *    `open_monitor`, or the switch the monitor pane now carries.
 * 3. The capsule could not be dragged: `handlePointerDown` refused to start a drag on any
 *    `button`, and a 280px capsule is almost entirely buttons (server chip, CPU, memory, both
 *    chevrons, the ✕). Only the 14px grip and the gauge were draggable.
 *
 * Asserted on the source, like the rest of this file: the node-side React stand-in throws on every
 * hook by design, so a render here would prove nothing about any of the three.
 */
describe('HUD dismissal sticks', () => {
  const sync = MAIN.slice(
    MAIN.indexOf('const handleActiveTerminal'),
    MAIN.indexOf('const unsubscribe = subscribeActiveTerminal')
  );
  const controller = MAIN.slice(
    MAIN.indexOf('onRegisterController({'),
    MAIN.indexOf('  // Synchronize with active connected terminal session')
  );

  it('shows the HUD on the 0 → 1 connection transition only, and only when not dismissed', () => {
    /**
     * Inside the `if`, by brace matching — "before the else" was this assertion's first version and
     * **passed with the bug restored**: a call moved to just above `} else {` is still before the
     * else while no longer inside the guard.
     */
    const marker = 'if (!connectedRef.current) {';
    const guard = sync.indexOf(marker);
    expect(guard).toBeGreaterThan(-1);
    const open = guard + marker.length;
    let depth = 1;
    let close = open;
    while (close < sync.length && depth > 0) {
      const ch = sync[close];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      close += 1;
    }
    const show = sync.indexOf('showHud()');
    expect(show).toBeGreaterThan(open);
    expect(show).toBeLessThan(close - 1);
    // And the dismissal gate is part of the same statement: without it, a persisted ✕ would be
    // ignored the moment a terminal connects.
    expect(sync).toContain('if (!dismissedRef.current) showHud();');
    expect(sync.match(/showHud\(\)/g) ?? []).toHaveLength(1);
  });

  it('hides without dismissing when the last connection goes away', () => {
    const elseBranch = sync.slice(sync.indexOf('} else {'));
    // Hidden, not dismissed: a dropped link must not cancel a preference the user never expressed.
    expect(elseBranch).toContain('publishVisibility(false)');
    expect(elseBranch).not.toContain('hideHud()');
  });

  it('treats ✕ as a decision and open as a request', () => {
    const close = controller.slice(controller.indexOf('close: () =>'));
    expect(close.slice(0, 200)).toContain('hideHud()');
    // The signal the user asked for the window is still `open`, whatever form it takes.
    const open = controller.slice(controller.indexOf('open: (target, serverId, options)'));
    // The explicit request comes first in the body: it must clear the dismissal before anything
    // else decides whether the window is allowed on screen.
    expect(open.slice(0, 700)).toContain('showHud()');
    // `toggle` reads the live state rather than a captured one.
    expect(controller).toContain('if (visibleRef.current) hideHud();');
  });

  it('remembers the dismissal for this session, and never across a restart', () => {
    /**
     * In memory on purpose.
     *
     * Persisting it looked friendlier — "I closed it, keep it closed" — and turned out to be a
     * trap: the state outlives the reason for it, the window stops appearing after a restart, and
     * the only way back is a switch the user has never seen. A restart restoring the capsule is the
     * safety net that makes offering a dismissal safe at all.
     */
    expect(MAIN).toContain('useRef<boolean>(false)');
    expect(MAIN).toContain('dismissedRef.current = true');
    expect(MAIN).toContain('dismissedRef.current = false');
    // No storage key: that is the assertion, not an implementation detail.
    expect(HUD).not.toContain('hud.dismissed');
    expect(MAIN).not.toContain('loadHudDismissed');
  });

  it('offers a way back in the pane, because a persisted ✕ would otherwise be a trap', () => {
    expect(MAIN).toContain('hud: {');
    expect(MAIN).toMatch(/isVisible: \(\) => hudController\?\.isVisible\(\) \?\? false/);
    expect(PANE).toContain("t('monitor.hud.paneShow')");
    expect(PANE).toContain("'aria-pressed': hudVisible ? 'true' : 'false'");
  });
});

/**
 * Clicking the monitor button gives the **capsule**, not the open window.
 *
 * Reported: on a fresh connection, pressing the monitor button dropped a fully expanded panel over
 * the conversation. The behaviour was never chosen — `open()` unconditionally set
 * `forceExpanded = true`, so every entry point (toolbar button, context menu, shortcut, the pane's
 * switch) opened the window. The capsule is what the HUD is *for*: a small always-there readout,
 * expanded only when asked for.
 *
 * The rule is now explicit. `open(target, serverId, { expanded })` carries the form, it defaults to
 * the capsule, and exactly one caller asks for the window: the `monitor-control` channel, which
 * exists for `open_monitor` and the commands — a model opening the window to read a number, or a
 * user running `/ssh-metrics` — and names a sub-tab a capsule cannot show.
 */
describe('the monitor button opens the capsule', () => {
  const controller = MAIN.slice(
    MAIN.indexOf('onRegisterController({'),
    MAIN.indexOf('  // Synchronize with active connected terminal session')
  );

  it('resolves the form from the request, defaulting to the capsule', () => {
    expect(MAIN).toContain('expanded: options?.expanded === true');
    // The controller reads the flag rather than always opening the window — the old line.
    expect(controller).not.toMatch(/showHud\(\);\s*setForceExpanded\(true\);/);
    expect(controller).toContain("const expanded = options?.expanded === true;");
    expect(controller).toMatch(/if \(expanded\) \{\s*setForceExpanded\(true\);/);
  });

  it('re-collapses on a repeated capsule request', () => {
    // `expanded` is the widget's own state, so `forceExpanded = false` twice is a React no-op and
    // the window would stay expanded after collapsing it by hand in between.
    expect(MAIN).toContain('setCapsuleRequest((n) => n + 1)');
    expect(MAIN).toContain('capsuleRequest,');
    expect(HUD).toContain('capsuleRequest?: number');
    expect(HUD).toMatch(/\}, \[forceExpanded, capsuleRequest\]\)/);
    // The instruction is consumed once per value, so a remount cannot re-apply a stale `false`.
    expect(HUD).toContain('const appliedFormRef = useRef<string | null>(null);');
    expect(HUD).toMatch(/if \(appliedFormRef\.current === stamp\) return;/);
    expect(HUD).toMatch(/\} else if \(instruction === 'capsule'[\s\S]{0,120}setExpanded\(false\);/);
  });

  it('keeps the expanded window for the callers that ask for it', () => {
    // The tool/command channel names a sub-tab, so it asks for the window.
    expect(MAIN).toContain('hudController?.open(msg.target, msg.serverId, { expanded: true })');
    // A button that merely reveals the HUD does not.
    expect(MAIN).toContain('() => void openMonitorTab()');
    expect(MAIN).toContain('openMonitorTab({ target: \'hardware\' })');
  });

  it('does not re-open the window through the show/hide switch', () => {
    // Switching the HUD back on is a user-opened path like any other: it lands on the capsule.
    const toggle = controller.slice(controller.indexOf('toggle: () =>'));
    expect(toggle.slice(0, 200)).not.toContain('setForceExpanded(true)');
  });
});

/**
 * The capsule drags by its six-dot handle — and only from there.
 *
 * Two earlier attempts are worth recording, because both looked reasonable and both were wrong:
 *
 * 1. The handle alone, with element-level `pointermove`. The press was recognised, the threshold
 *    branch ran, and the window still never moved: `pointermove` does not reliably arrive once the
 *    pointer leaves a 40px-tall pill.
 * 2. "Drag from anywhere", to compensate. That made the chips unreliable — a press a few pixels
 *    below the handle became a drag instead of the click it was meant to be — and the report was
 *    precise: "a little higher drags, a little lower does not".
 *
 * Which is why the pill's padding then *did* drag while the handle did not: `closest('button')`
 * refused every chip, and the grip — the one element the design names — had no pointer handler of
 * its own wired to a working sequence.
 *
 * What is asserted here is therefore the *design*: the handle carries the pointerdown, the pill
 * does not; the moving happens on `window` while a drag is armed; and the handle's hit area is
 * larger than its glyph, because a 14px icon is not a target.
 */
describe('the capsule drags by its handle', () => {
  const pillStart = HUD.indexOf('className: `att-hud-pill');
  // The pill's *own* props only: the handle lives among its children, so a slice that ran to the
  // first child would contain the very call this test says must not be there.
  const pill = HUD.slice(pillStart, HUD.indexOf('onClickCapture', pillStart));
  const grip = HUD.slice(HUD.indexOf("className: 'att-floating-drag-grip'"));
  const armEffect = HUD.slice(HUD.indexOf('if (!armed) return;'), HUD.indexOf('  // Sync forceExpanded prop'));
  const pressEffect = HUD.slice(HUD.indexOf('const onDown = (event: PointerEvent): void => {'), HUD.indexOf('  const handleHeaderDoubleClick'));

  it('takes the press from a window-level capture listener, not from React', () => {
    /**
     * The regression this pins down: a **node** listener depends on nothing else having claimed the
     * press first, and React's delegation — which listens at the renderer's root container inside
     * the host page — plus the host's own capture listeners do exactly that. The press has to be
     * captured at `window`, before anything else in the page.
     */
    expect(pressEffect).toContain("window.addEventListener('pointerdown', onDown, true)");
    // A ref attached during render is `null` when a mount effect runs, which is how the handle
    // silently ended up with no handler at all. The node is resolved from the document instead.
    expect(HUD).not.toContain('gripRef');
    expect(HUD).toContain("target.closest('[data-hud-drag]')");
    // The overlay scope and the capture target both hang off a callback ref, which is assigned
    // with the node at attach time.
    expect(HUD).toMatch(/ref: \(node: HTMLElement \| null\) => \{\s*overlayRef\.current = node;/);
  });

  it('makes only the handle start a capsule drag', () => {
    // The window branch of the press handler arms a drag only for the grip...
    expect(HUD).toContain("'data-hud-drag': 'pill'");
    expect(pressEffect).toContain('if (gripPointerDown(event)) return;');
    // ...and the capsule branch below it is gated on `expanded`, so a press on the pill's padding
    // arms nothing at all.
    expect(pressEffect).toContain('if (expandedRef.current) {');
    expect(pressEffect.indexOf('if (expandedRef.current) {')).toBeGreaterThan(
      pressEffect.indexOf('if (gripPointerDown(event)) return;')
    );
    // The pill's props start no drag either: that was attempt 2, and it is what broke the chips.
    expect(pill).not.toContain('onPointerDown');
    // Nor does the pill advertise a drag it no longer starts.
    expect(pill).not.toContain("title: t('monitor.hud.dragTip')");
    expect(grip.slice(0, 500)).toContain("title: t('monitor.hud.gripTip')");
    // The pill keeps the click-swallowing capture handler that goes with a drag.
    expect(HUD).toContain('onClickCapture');
  });

  it('binds the press once per mount and reads the live state through refs', () => {
    // A `[pos.x, pos.y]` dependency tore the listener down and rebuilt it on every move.
    expect(pressEffect).toMatch(/\}, \[\]\);\s*\n/);
    expect(HUD).toContain('const expandedRef = useRef(expanded);');
    expect(HUD).toMatch(/expandedRef\.current = expanded;/);
  });

  it('moves the window on window-level listeners while a drag is armed', () => {
    expect(armEffect).toContain("window.addEventListener('pointermove', onMove, true)");
    // The release is listened for on `document` in the capture phase: a chip under the pointer
    // handles pointerup first when the gesture ends over one, and may stop it there.
    expect(armEffect).toContain("document.addEventListener('pointerup', onUp, true)");
    expect(armEffect).toContain("document.addEventListener('pointercancel', onUp, true)");
  });

  it('captures the pointer for the gesture and releases it on every exit', () => {
    // Capturing at the press is what keeps a host `setPointerCapture` from retargeting the
    // gesture; releasing is what keeps the capture from swallowing the next press on a chip.
    expect(HUD).toMatch(/const capturePointer = \(pointerId: number\): void => \{/);
    expect(HUD).toContain('capturePointer(e.pointerId);');
    // The gesture owns its pointer id: it is captured in the effect and passed to the release, so a
    // second press cannot strand the capture by overwriting the ref the release used to read.
    expect(HUD).toMatch(/const gesturePointerId = dragStateRef\.current\?\.pointerId \?\? -1;/);
    expect(HUD).toMatch(/const finish = \(moved: boolean\): void => \{\s*setIsDragging\(false\);\s*releasePointerCapture\(gesturePointerId\);/);
    expect(HUD).toContain('if (dragStateRef.current !== null) return;');
  });

  it('gives the handle a hit area larger than its glyph', () => {
    // This is the half of the complaint that a source assertion can hold: the press has to be
    // forgiving. 14px of icon is not; the padded box is.
    expect(HUD).toContain("className: 'att-floating-drag-grip'");
    expect(SHEET).toMatch(/\.att-floating-drag-grip \{[\s\S]{0,700}?align-self: stretch/);
    // The glyph must not become the target, or the handler and the dots disagree about hit area.
    expect(SHEET).toMatch(/\.att-floating-drag-grip svg \{[^}]*pointer-events: none/);
    expect(SHEET).toMatch(/\.att-floating-drag-grip \{[\s\S]{0,600}?cursor: grab/);
  });

  it('keeps the expanded window draggable by its header', () => {
    // Unchanged behaviour, asserted so a future edit to the pill path does not quietly take it.
    expect(HUD).toContain('handlePointerDown(event, false)');
    expect(HUD).toMatch(/const handlePointerDown = \(e: \{[^}]*\}, isPill: boolean\)/);
    // Its own buttons must not start a drag, or pressing ✕ would move the window instead.
    expect(HUD).toContain("if (!target?.closest || target.closest('button') === null) {");
  });

  /**
   * Exactly one thing may arm a drag, and it must never arm one from a button.
   *
   * The regression: the header kept a React `onPointerDown` *next to* the window-level press
   * listener. That listener exempts `button`, the React one did not — so pressing ✕ or the collapse
   * chevron armed a drag, and `handlePointerDown` captured the pointer on the overlay. A captured
   * press retargets the release, and the browser then delivers the `click` to the common ancestor
   * of the press and release targets — the overlay, not the button. Both buttons went dead, and so
   * did the capsule's chips, because the stale `suppressClickRef` guard swallowed the next click.
   */
  it('arms a drag from exactly one place, and never from a button', () => {
    // The header carries no pointer handler of its own any more (the comment explaining why is
    // not a handler, so the check is for a *property*, not for the word).
    const header = HUD.slice(HUD.indexOf('att-floating-window-header'), HUD.indexOf('// Server Sub-bar'));
    expect(header).not.toMatch(/^\s*onPointerDown:/m);
    // Only the window-level listener calls handlePointerDown, and it is the only place that does.
    expect(HUD.match(/handlePointerDown\(/g) ?? []).toHaveLength(2);
    const pressEffect = HUD.slice(
      HUD.indexOf('const onDown = (event: PointerEvent): void => {'),
      HUD.indexOf('  const handleHeaderDoubleClick')
    );
    // A press on any button of the overlay arms nothing: the exemption is checked there, once.
    expect(pressEffect).toContain("if (!target?.closest || target.closest('button') === null) {");
    // And the click guard can never lock in: every press clears it, and it is consumed once.
    expect(HUD).toContain('suppressClickRef.current = false;');
  });
});
