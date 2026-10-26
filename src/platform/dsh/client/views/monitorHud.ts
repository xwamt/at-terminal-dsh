import { useEffect, useRef, useState } from 'react';
import type { AgentAuditSummary, AgentExecutionSnapshot, HardwareMetrics, Translate } from '../models';
import { formatThroughput } from '../models';
import { formatFileSize } from '../../../../sftp/FileSize';
import { chevronDownRegular, closeRegular, gaugeRegular, gripRegular, serverRegular } from '../icons';
import { HardwareMonitorView } from './monitorHardware';
import { AgentMonitorView } from './monitorAgent';
import { h, type El } from './shared';
import { postDiagnostic } from '../channel';

const STORAGE_KEY = 'dsh.at-terminal.monitor.hud.pos';

/**
 * Keep the HUD inside the viewport.
 *
 * `width`/`height` are the box the caller *believes* it is about to show (400x520 expanded,
 * 280x40 collapsed). The stylesheet already caps the real box with `min(400px, 100vw - 16px)`,
 * so at 360px the caller's 400 is a lie and clamping against it pushed the window off the
 * right edge: `maxX` became a number below `margin`, and the header — the only drag handle —
 * went with it. Shrinking the assumed box to what actually fits is what makes the clamp
 * correct at every viewport instead of only at the ones the fixed size happened to suit.
 */
export function clampPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const margin = 8;
  const winW = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
  const boxW = Math.min(width, Math.max(0, winW - margin * 2));
  const boxH = Math.min(height, Math.max(0, winH - margin * 2));
  const maxX = Math.max(margin, winW - boxW - margin);
  const maxY = Math.max(margin, winH - boxH - margin);
  return {
    x: Math.max(margin, Math.min(maxX, Math.round(x))),
    y: Math.max(margin, Math.min(maxY, Math.round(y)))
  };
}

export function loadSavedPosition(): { x: number; y: number } {
  const storage =
    typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!storage) return { x: 800, y: 56 };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return clampPosition(parsed.x, parsed.y, 280, 40);
      }
    }
  } catch {}
  const fallbackX = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth - 320 : 800;
  return clampPosition(fallbackX, 56, 280, 40);
}

export function savePosition(pos: { x: number; y: number }): void {
  const storage =
    typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {}
}

export interface MonitorHudWidgetProps {
  t: Translate;
  metrics: HardwareMetrics | null;
  snapshot: AgentExecutionSnapshot | null;
  onCloseHud?: () => void;
  forceExpanded?: boolean;
  initialSubtab?: 'overview' | 'hardware' | 'agent';
  activeServerId?: string | null;
  activeLabel?: string | null;
  /** Audits accumulated for the current connection; the agent tab's history view reads this. */
  auditHistory?: AgentAuditSummary[];
}

export function MonitorHudWidget(props: MonitorHudWidgetProps): El {
  const { t, metrics, snapshot, onCloseHud, forceExpanded, initialSubtab, activeServerId, activeLabel, auditHistory } = props;
  const [expanded, setExpanded] = useState(Boolean(forceExpanded));
  const [activeTab, setActiveTab] = useState<'overview' | 'hardware' | 'agent'>(initialSubtab ?? 'overview');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => loadSavedPosition());
  const [isDragging, setIsDragging] = useState(false);
  /** Armed by a press, disarmed on release. Drives the window-level listeners below. */
  const [armed, setArmed] = useState(false);

  /** Set when a gesture turned out to be a drag; cleared by the click it has to swallow. */
  const suppressClickRef = useRef(false);
  /** Latest position, so the drag effect does not have to re-subscribe on every move. */
  const posRef = useRef(pos);
  posRef.current = pos;
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    hasMoved: boolean;
    width: number;
    height: number;
    isPill: boolean;
  } | null>(null);

  /**
   * Listen on `window` for the duration of a drag, not on the element.
   *
   * This is the fix for "the capsule cannot be dragged", and the measurement is worth recording
   * because the code looked right twice before it was: a press on the pill reached
   * `handlePointerDown` (`hud down isPill=true`), the threshold branch ran (`hud move captured`),
   * and the window still never moved. Element-level `pointermove` simply does not arrive once the
   * pointer leaves a 40px-tall pill — and in this renderer it barely arrives even before that, so
   * `Math.hypot(dx, dy) >= 3` never crossed and `setPointerCapture` was never reached. The expanded
   * window felt draggable only because its header is big enough to keep the pointer inside it.
   *
   * A window listener is what every drag implementation uses, and it makes the capture call
   * unnecessary: the events arrive regardless of what is under the pointer.
   */
  useEffect(() => {
    if (!armed) return;
    const finish = (moved: boolean, pill: boolean): void => {
      setIsDragging(false);
      if (moved) {
        savePosition(posRef.current);
        suppressClickRef.current = true;
      } else if (pill) {
        // A tap on the handle opens the window: the same gesture as a drag, without the movement.
        setExpanded(true);
        setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
      }
      dragStateRef.current = null;
      setArmed(false);
    };
    const onMove = (e: PointerEvent): void => {
      const state = dragStateRef.current;
      if (state === null || e.pointerId !== state.pointerId) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (!state.hasMoved) {
        if (Math.hypot(dx, dy) < 3) return;
        state.hasMoved = true;
        setIsDragging(true);
      }
      setPos(clampPosition(state.initialX + dx, state.initialY + dy, state.width, state.height));
    };
    const onUp = (e: PointerEvent): void => {
      const state = dragStateRef.current;
      if (state === null || e.pointerId !== state.pointerId) return;
      finish(state.hasMoved, state.isPill);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [armed]);

  /**
   * One line per mount: where the floating window actually is.
   *
   * The position lives in localStorage and is clamped to the viewport, so "the HUD is missing" can
   * mean three different things — it is behind something, it is off the edge, or nobody asked for
   * it — and no screenshot distinguishes them. One line makes it diagnosable from the log.
   */
  useEffect(() => {
    requestAnimationFrame(() => {
      const element = typeof document !== 'undefined' ? document.querySelector('.att-hud-overlay') : null;
      const box = element ? element.getBoundingClientRect() : null;
      const rect = box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}` : 'none';
      postDiagnostic('info', `hud shown pos=${JSON.stringify(pos)} vw=${window.innerWidth} rect=${rect}`, 'hud', null, null);
    });
    // Mount-only on purpose: a line per render would fire on every metrics poll.
  }, []);

  // Sync forceExpanded prop
  useEffect(() => {
    if (forceExpanded !== undefined) {
      setExpanded(forceExpanded);
      if (forceExpanded) {
        setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
      }
    }
  }, [forceExpanded]);

  // Sync initialSubtab prop
  useEffect(() => {
    if (initialSubtab) {
      setActiveTab(initialSubtab);
    }
  }, [initialSubtab]);

  // Viewport resize boundary adjustment
  useEffect(() => {
    const onResize = () => {
      const width = expanded ? 400 : 280;
      const height = expanded ? 520 : 40;
      setPos((prev) => clampPosition(prev.x, prev.y, width, height));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded]);

  /**
   * Arm a drag from the six-dot handle. That handle is the **only** place a drag starts.
   *
   * Two attempts before this one got it wrong in opposite directions, and the user's report is the
   * design brief: the capsule has a grip for exactly this, so dragging was never supposed to work
   * from anywhere. Making the whole pill draggable also made the chips unreliable — a press that
   * landed a few pixels lower turned into a drag instead of the click it was meant to be.
   *
   * So: the grip arms a drag, the chips keep their clicks, and nothing else takes the pointer. The
   * **moving** still happens on window (see the effect above), because element-level pointermove
   * does not reliably arrive once the pointer leaves a 40px-tall pill — which is what made an armed
   * drag stand still even when the press was recognised.
   */
  const handlePointerDown = (e: any, isPill: boolean) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // In the expanded window the whole header drags, so its own buttons must be excluded; the
    // capsule's handle is a plain span and never needs the exemption.
    if (!isPill && target?.closest && target.closest('button')) return;
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialX: pos.x,
      initialY: pos.y,
      hasMoved: false,
      width: isPill ? 280 : 400,
      height: isPill ? 40 : 520,
      isPill
    };
    suppressClickRef.current = false;
    setArmed(true);
  };

  /**
   * The handle listens **natively**, in the capture phase.
   *
   * React's delegated `pointerdown` runs at the renderer's root container, which is *inside* the
   * host app: any document-level handler the host installs for its own focus/drag management runs
   * first, and one `stopPropagation()` there means the plugin never sees the press at all. A
   * listener bound to the node itself with `capture: true` is the first thing to run and cannot be
   * preempted, which is the difference between "the handle works" and "the handle does nothing
   * while everything else does".
   *
   * `preventDefault` is part of the deal: without it the press starts a text selection / native
   * drag from the SVG, and the selection is what the pointer then moves.
   */
  const gripRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = gripRef.current;
    if (node === null) return;
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      handlePointerDown(event, true);
    };
    node.addEventListener('pointerdown', onDown, { capture: true });
    return () => node.removeEventListener('pointerdown', onDown, { capture: true });
  }, [expanded]);

  const handleHeaderDoubleClick = (e: any) => {
    const target = e.target as HTMLElement;
    if (target?.closest && target.closest('button')) return;
    setExpanded(false);
    setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
  };
  const cpuPercent = metrics?.cpu.usagePercent ?? 0;
  const cpuLevel = cpuPercent > 85 ? 'error' : cpuPercent > 70 ? 'warn' : 'normal';
  const memUsedBytes = metrics?.memory.usedBytes ?? 0;
  const memTotalBytes = metrics?.memory.totalBytes || 1;
  const memPercent = Math.min(100, Math.round((memUsedBytes / memTotalBytes) * 100));
  const memLevel = memPercent > 85 ? 'error' : memPercent > 70 ? 'warn' : 'normal';
  const primaryDisk = metrics?.disk.mounts?.[0];
  // TEMPORARY instrument: rendered position, so an off-screen window is observable.
  // TEMPORARY: the on-screen rectangle in CSS px, plus the viewport, so a synthetic drag can
  // target the pill instead of guessing from a screenshot.
  requestAnimationFrame(() => {
    const el = typeof document !== 'undefined' ? document.querySelector('.att-hud-pill') : null;
    const r = el ? el.getBoundingClientRect() : null;
  });

  const diskLevel = (primaryDisk?.usePercent ?? 0) > 85 ? 'error' : (primaryDisk?.usePercent ?? 0) > 70 ? 'warn' : 'normal';
  const rxStr = formatThroughput(metrics?.network?.rxBytesPerSec ?? 0);
  const txStr = formatThroughput(metrics?.network?.txBytesPerSec ?? 0);
  const isAgentActive = Boolean(snapshot?.currentAction);
  const agentStatus = snapshot?.currentAction?.status;

  /** Expand into a named sub-tab. Every pill control routes through this one transition. */
  const openExpanded = (tab: 'overview' | 'hardware' | 'agent') => {
    setExpanded(true);
    setActiveTab(tab);
    setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
  };
  const collapse = () => {
    setExpanded(false);
    setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
  };
  const agentShort = isAgentActive
    ? agentStatus === 'confirmation_waiting'
      ? t('monitor.status.waitingShort')
      : t('monitor.status.runningShort')
    : '';

  return h(
    'div',
    {
      className: `att-hud-overlay ${isDragging ? 'is-dragging' : ''}`,
      style: {
        left: `${pos.x}px`,
        top: `${pos.y}px`
      }
    },
    // Mini Draggable Pill
    !expanded &&
      h(
        'div',
        {
          /*
           * `role="group"`, not `role="button"`.
           *
           * It used to be one button whose children were `<span onClick>` — an interactive
           * element nested inside an interactive element, which both ARIA and every screen
           * reader reject: the outer role swallows the children, so "CPU 12%" announced as
           * part of one long button label with no way to reach the third of it that does
           * something. The container is a group; each chip that acts is its own button.
           */
          className: `att-hud-pill ${isDragging ? 'is-dragging' : ''}`,
          role: 'group',
          'aria-label': t('monitor.hud.pillLabel'),
          title: t('monitor.hud.dragTip'),
          /**
           * Swallow the click a drag leaves behind.
           *
           * Capture phase, so it runs before the chip's own handler: releasing a drag over a chip
           * must not also fire that chip.
           */
          onClickCapture: (e: any) => {
            if (!suppressClickRef.current) return;
            suppressClickRef.current = false;
            e.stopPropagation();
            e.preventDefault();
          }
        },
        /**
         * The six-dot handle — the one and only place the capsule drags from.
         *
         * It carries the pointerdown itself rather than the pill doing it: a 350px capsule is made
         * of chips, and a press a few pixels below the handle belongs to the chip under it.
         */
        h(
          'span',
          {
            className: 'att-floating-drag-grip',
            'aria-hidden': true,
            ref: gripRef
          },
          gripRegular({ size: 14 })
        ),
        h('span', { 'aria-hidden': true }, gaugeRegular({ size: 14 })),
        (activeLabel || activeServerId) &&
          h(
            'span',
            {
              className: 'att-hud-pill-chip',
              title: `${t('monitor.server')}${activeLabel || activeServerId}`,
              style: { maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            },
            serverRegular({ size: 12 }),
            ` ${activeLabel || activeServerId}`
          ),
        h(
          'button',
          {
            type: 'button',
            className: 'att-hud-pill-chip',
            title: t('monitor.tab.hardware'),
            'aria-label': t('monitor.hud.cpuChip', { percent: `${cpuPercent}%` }),
            onClick: () => openExpanded('hardware')
          },
          `CPU ${cpuPercent}%`
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'att-hud-pill-chip',
            title: t('monitor.tab.hardware'),
            'aria-label': t('monitor.hud.memChip', { percent: `${memPercent}%` }),
            onClick: () => openExpanded('hardware')
          },
          `MEM ${memPercent}%`
        ),
        isAgentActive
          ? h(
              'button',
              {
                type: 'button',
                className: `att-monitor-badge ${agentStatus === 'confirmation_waiting' ? 'att-monitor-badge-waiting' : 'att-monitor-badge-running'}`,
                style: { padding: '1px 6px', fontSize: '11px', cursor: 'pointer' },
                title: `${t('monitor.tab.agent')}: ${agentShort}`,
                'aria-label': t('monitor.hud.agentChip', { status: agentShort }),
                onClick: () => openExpanded('agent')
              },
              h('span', { className: 'att-monitor-badge-pulse-dot', 'aria-hidden': true }),
              agentShort
            )
          : h('span', {
              className: 'att-monitor-badge-pulse-dot',
              'aria-hidden': true,
              style: { color: 'var(--dsw-alias-state-success-primary)' }
            }),
        h(
          'button',
          {
            type: 'button',
            className: 'att-hud-pill-expand',
            title: t('monitor.hud.expand'),
            'aria-label': t('monitor.hud.expand'),
            onClick: () => openExpanded(activeTab)
          },
          chevronDownRegular({ size: 14 })
        ),
        onCloseHud &&
          h(
            'button',
            {
              type: 'button',
              className: 'att-nav-btn att-icon-btn',
              style: { marginLeft: '2px', opacity: 0.7 },
              title: t('monitor.hud.close'),
              'aria-label': t('monitor.hud.close'),
              onClick: (e: { stopPropagation: () => void }) => {
                e.stopPropagation();
                onCloseHud();
              }
            },
            closeRegular({ size: 14 })
          )
      ),

    // Expanded Draggable Floating Window
    expanded &&
      h(
        'div',
        {
          className: `att-floating-window ${isDragging ? 'is-dragging' : ''}`,
          role: 'dialog',
          'aria-label': t('monitor.hud.title'),
          tabIndex: -1,
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Escape') {
              collapse();
            }
          }
        },
        // Header / Drag Handle
        h(
          'div',
          {
            className: `att-floating-window-header ${isDragging ? 'is-dragging' : ''}`,
            title: t('monitor.hud.dragTip'),
            onPointerDown: (e: any) => handlePointerDown(e, false),
            onDoubleClick: handleHeaderDoubleClick
          },
          h(
            'div',
            { className: 'att-floating-header-left' },
            h('span', { className: 'att-floating-drag-grip', 'aria-hidden': true }, gripRegular({ size: 14 })),
            h('span', { 'aria-hidden': true }, gaugeRegular({ size: 14 })),
            h('span', { style: { fontWeight: 600, fontSize: '12px' } }, t('monitor.hud.title'))
          ),
          h(
            'div',
            { className: 'att-floating-header-actions' },
            h(
              'button',
              {
                className: 'att-nav-btn att-icon-btn',
                title: t('monitor.hud.minimize'),
                'aria-label': t('monitor.hud.minimize'),
                onClick: (e: { stopPropagation: () => void }) => {
                  e.stopPropagation();
                  collapse();
                }
              },
              // A chevron rather than the `—` it used to draw: the action **collapses the window
              // into the pill**, which is what a downward chevron means, while an em dash is the
              // typographic mark for a range and says nothing about the result.
              chevronDownRegular({ size: 14 })
            ),
            onCloseHud &&
              h(
                'button',
                {
                  className: 'att-nav-btn att-icon-btn',
                  title: t('monitor.hud.close'),
                  'aria-label': t('monitor.hud.close'),
                  onClick: (e: { stopPropagation: () => void }) => {
                    e.stopPropagation();
                    onCloseHud();
                  }
                },
                closeRegular({ size: 14 })
              )
          )
        ),

        // Server Sub-bar
        h(
          'div',
          {
            style: {
              padding: '4px 12px',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)'
            }
          },
          h('span', { 'aria-hidden': true }, serverRegular({ size: 14 })),
          h('span', null, t('monitor.server')),
          h(
            'span',
            {
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }
            },
            activeLabel || activeServerId || metrics?.serverId || t('monitor.hud.noServer')
          )
        ),

        // Subtabs Navigation Bar
        h(
          'div',
          { className: 'att-floating-subtabs', role: 'tablist', 'aria-label': t('monitor.hud.title') },
          ...(
            [
              ['overview', t('monitor.tab.overview')],
              ['hardware', t('monitor.tab.hardware')],
              ['agent', t('monitor.tab.agent')]
            ] as const
          ).map(([key, label]) =>
            h(
              'button',
              {
                key,
                id: `att-hud-tab-${key}`,
                type: 'button',
                role: 'tab',
                className: `att-floating-tab-btn ${activeTab === key ? 'is-active' : ''}`,
                'aria-selected': activeTab === key,
                'aria-controls': 'att-hud-tabpanel',
                // Roving tabindex: one stop for the whole strip, arrows move within it. Three
                // tabs in a floating window should not cost three Tab presses on the way to
                // the content behind them.
                tabIndex: activeTab === key ? 0 : -1,
                onClick: () => setActiveTab(key),
                onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                  const order = ['overview', 'hardware', 'agent'] as const;
                  const at = order.indexOf(activeTab);
                  const next =
                    e.key === 'ArrowRight'
                      ? order[(at + 1) % order.length]
                      : e.key === 'ArrowLeft'
                        ? order[(at + order.length - 1) % order.length]
                        : e.key === 'Home'
                          ? order[0]
                          : e.key === 'End'
                            ? order[order.length - 1]
                            : null;
                  if (next === null) return;
                  e.preventDefault();
                  setActiveTab(next);
                  /*
                   * Selection and focus have to move together.
                   *
                   * The tabindex is roving — the strip is meant to be a single Tab stop — so the
                   * newly selected tab becomes tabIndex 0 while the one the user's focus is
                   * physically on becomes -1. Without this line the two disagree: the panel
                   * switches, the focus ring stays behind on a button that is no longer a stop, and
                   * the next Tab press leaves the strip entirely from a tab that looks unselected.
                   */
                  const el = document.getElementById(`att-hud-tab-${next}`);
                  if (el !== null) el.focus();
                }
              },
              label
            )
          )
        ),

        // Body Content
        h(
          'div',
          {
            className: 'att-floating-window-body',
            id: 'att-hud-tabpanel',
            role: 'tabpanel',
            'aria-labelledby': `att-hud-tab-${activeTab}`
          },
          activeTab === 'overview' &&
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              // Overview 2x2 Grid
              h(
                'div',
                { className: 'att-overview-grid' },
                // CPU Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.cpu.title')),
                    h('span', { className: 'att-overview-metric-value' }, `${cpuPercent}%`)
                  ),
                  h(
                    'div',
                    { className: 'att-monitor-gauge' },
                    h('div', {
                      className: 'att-monitor-gauge-fill',
                      'data-level': cpuLevel,
                      style: { width: `${cpuPercent}%` }
                    })
                  ),
                  h(
                    'div',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                    t('monitor.cpu.load', {
                      l1: (metrics?.cpu.loadAvg?.[0] ?? 0).toFixed(2),
                      l5: (metrics?.cpu.loadAvg?.[1] ?? 0).toFixed(2),
                      l15: (metrics?.cpu.loadAvg?.[2] ?? 0).toFixed(2)
                    })
                  )
                ),
                // Memory Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.mem.title')),
                    h('span', { className: 'att-overview-metric-value' }, `${memPercent}%`)
                  ),
                  h(
                    'div',
                    { className: 'att-monitor-gauge' },
                    h('div', {
                      className: 'att-monitor-gauge-fill',
                      'data-level': memLevel,
                      style: { width: `${memPercent}%` }
                    })
                  ),
                  h(
                    'div',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                    t('monitor.mem.detail', {
                      used: formatFileSize(memUsedBytes),
                      total: formatFileSize(memTotalBytes)
                    })
                  )
                ),
                // Disk Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.disk.title')),
                    h('span', { className: 'att-overview-metric-value' }, primaryDisk ? `${primaryDisk.usePercent}%` : '-')
                  ),
                  h(
                    'div',
                    { className: 'att-monitor-gauge' },
                    h('div', {
                      className: 'att-monitor-gauge-fill',
                      'data-level': diskLevel,
                      style: { width: `${primaryDisk?.usePercent ?? 0}%` }
                    })
                  ),
                  h(
                    'div',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                    primaryDisk ? `${primaryDisk.mount} (${formatFileSize(primaryDisk.usedBytes)})` : '-'
                  )
                ),
                // Network Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.net.title'))
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } },
                    h('span', null, t('monitor.net.rx', { speed: rxStr })),
                    h('span', null, t('monitor.net.tx', { speed: txStr }))
                  )
                )
              ),

              // Agent Execution Status Card
              h(
                'div',
                { className: 'att-overview-agent-card' },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('span', { style: { fontWeight: 600, fontSize: '12px' } }, t('monitor.agent.actionTitle')),
                  isAgentActive
                    ? h(
                        'span',
                        {
                          className: `att-monitor-badge ${agentStatus === 'confirmation_waiting' ? 'att-monitor-badge-waiting' : 'att-monitor-badge-running'}`,
                          style: { fontSize: '11px' }
                        },
                        agentStatus === 'confirmation_waiting' ? t('monitor.status.waiting') : t('monitor.status.running')
                      )
                    : h(
                        'span',
                        { style: { fontSize: '11px', color: 'var(--dsw-alias-state-success-primary)' } },
                        h('span', { className: 'att-monitor-badge-pulse-dot', 'aria-hidden': true, style: { marginRight: '4px' } }),
                        t('monitor.agent.ready')
                      )
                ),
                isAgentActive
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                      h(
                        'div',
                        { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                        t('monitor.agent.elapsed', { time: snapshot?.currentAction?.runningTimeMs ?? 0 })
                      ),
                      h('div', { className: 'att-code-preview', style: { maxHeight: '70px' } }, snapshot?.currentAction?.command),
                      snapshot && snapshot.activeTransfers.length > 0 &&
                        h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-brand-primary)' } }, `${t('monitor.agent.transfersTitle')}: ${snapshot.activeTransfers.length}`)
                    )
                  : h(
                      'div',
                      { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', padding: '4px 0' } },
                      t('monitor.agent.idle')
                    )
              )
            ),

          activeTab === 'hardware' &&
            h(HardwareMonitorView, {
              t,
              metrics,
              loading: false,
              onRefresh: () => {}
            }),

          activeTab === 'agent' &&
            h(AgentMonitorView, {
              t,
              snapshot,
              loading: false,
              onRefresh: () => {},
              history: auditHistory
            })
        ),

        // Footer status bar
        h(
          'div',
          { className: 'att-floating-window-footer' },
          h('span', null, t('monitor.hud.dragTip')),
          h('span', { style: { opacity: 0.8 } }, 'AT Terminal')
        )
      )
  );
}
