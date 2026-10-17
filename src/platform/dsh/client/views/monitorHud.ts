import { useEffect, useRef, useState } from 'react';
import type { AgentExecutionSnapshot, HardwareMetrics, Translate } from '../models';
import { formatThroughput } from '../models';
import { formatFileSize } from '../../../../sftp/FileSize';
import { HardwareMonitorView } from './monitorHardware';
import { AgentMonitorView } from './monitorAgent';
import { h, type El } from './shared';

const STORAGE_KEY = 'dsh.at-terminal.monitor.hud.pos';

export function clampPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const margin = 8;
  const winW = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
  const maxX = Math.max(margin, winW - width - margin);
  const maxY = Math.max(margin, winH - height - margin);
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
}

export function MonitorHudWidget(props: MonitorHudWidgetProps): El {
  const { t, metrics, snapshot, onCloseHud, forceExpanded, initialSubtab, activeServerId, activeLabel } = props;
  const [expanded, setExpanded] = useState(Boolean(forceExpanded));
  const [activeTab, setActiveTab] = useState<'overview' | 'hardware' | 'agent'>(initialSubtab ?? 'overview');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => loadSavedPosition());
  const [isDragging, setIsDragging] = useState(false);

  const isDraggingRef = useRef(false);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    hasMoved: boolean;
    currentWidth: number;
    currentHeight: number;
  } | null>(null);

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

  // Pointer drag events with Pointer Capture API
  const handlePointerDown = (e: any, isPill: boolean) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target?.closest && target.closest('button, input, select, textarea, a, .att-floating-subtabs')) {
      return;
    }

    const currentWidth = isPill ? 280 : 400;
    const currentHeight = isPill ? 40 : 520;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}

    isDraggingRef.current = true;
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialX: pos.x,
      initialY: pos.y,
      hasMoved: false,
      currentWidth,
      currentHeight
    };
    setIsDragging(true);
  };

  const handlePointerMove = (e: any) => {
    if (!isDraggingRef.current || !dragStateRef.current || dragStateRef.current.pointerId !== e.pointerId) {
      return;
    }
    const dx = e.clientX - dragStateRef.current.startX;
    const dy = e.clientY - dragStateRef.current.startY;
    if (!dragStateRef.current.hasMoved && Math.hypot(dx, dy) >= 3) {
      dragStateRef.current.hasMoved = true;
    }
    if (dragStateRef.current.hasMoved) {
      const newPos = clampPosition(
        dragStateRef.current.initialX + dx,
        dragStateRef.current.initialY + dy,
        dragStateRef.current.currentWidth,
        dragStateRef.current.currentHeight
      );
      setPos(newPos);
    }
  };

  const handlePointerUp = (e: any, isPill: boolean) => {
    if (!isDraggingRef.current || !dragStateRef.current || dragStateRef.current.pointerId !== e.pointerId) {
      return;
    }
    const hadMoved = dragStateRef.current.hasMoved;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    isDraggingRef.current = false;
    dragStateRef.current = null;
    setIsDragging(false);

    if (hadMoved) {
      savePosition(pos);
    } else if (isPill) {
      // Direct click on pill toggles expanded
      const nextExpanded = !expanded;
      setExpanded(nextExpanded);
      if (nextExpanded) {
        setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
      }
    }
  };

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
  const diskLevel = (primaryDisk?.usePercent ?? 0) > 85 ? 'error' : (primaryDisk?.usePercent ?? 0) > 70 ? 'warn' : 'normal';
  const rxStr = formatThroughput(metrics?.network?.rxBytesPerSec ?? 0);
  const txStr = formatThroughput(metrics?.network?.txBytesPerSec ?? 0);
  const isAgentActive = Boolean(snapshot?.currentAction);
  const agentStatus = snapshot?.currentAction?.status;

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
          className: `att-hud-pill ${isDragging ? 'is-dragging' : ''}`,
          role: 'button',
          tabIndex: 0,
          'aria-label': t('monitor.title'),
          title: t('monitor.hud.dragTip'),
          onPointerDown: (e: any) => handlePointerDown(e, true),
          onPointerMove: handlePointerMove,
          onPointerUp: (e: any) => handlePointerUp(e, true),
          onPointerCancel: (e: any) => handlePointerUp(e, true),
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setExpanded(true);
              setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
            }
          }
        },
        h('span', { className: 'att-floating-drag-grip', 'aria-hidden': true }, '⠿'),
        h('span', { 'aria-hidden': true }, '📊'),
        (activeLabel || activeServerId) &&
          h(
            'span',
            {
              className: 'att-hud-pill-chip',
              title: `${t('monitor.server')}${activeLabel || activeServerId}`,
              style: { maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            },
            `🖥️ ${activeLabel || activeServerId}`
          ),
        h(
          'span',
          {
            className: 'att-hud-pill-chip',
            title: t('monitor.tab.hardware'),
            onClick: (e: any) => {
              e.stopPropagation();
              setExpanded(true);
              setActiveTab('hardware');
              setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
            }
          },
          `CPU ${cpuPercent}%`
        ),
        h(
          'span',
          {
            className: 'att-hud-pill-chip',
            title: t('monitor.tab.hardware'),
            onClick: (e: any) => {
              e.stopPropagation();
              setExpanded(true);
              setActiveTab('hardware');
              setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
            }
          },
          `MEM ${memPercent}%`
        ),
        isAgentActive
          ? h(
              'span',
              {
                className: `att-monitor-badge ${agentStatus === 'confirmation_waiting' ? 'att-monitor-badge-waiting' : 'att-monitor-badge-running'}`,
                style: { padding: '1px 6px', fontSize: '10px', cursor: 'pointer' },
                title: `${t('monitor.tab.agent')}: ${agentStatus}`,
                onClick: (e: any) => {
                  e.stopPropagation();
                  setExpanded(true);
                  setActiveTab('agent');
                  setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
                }
              },
              h('span', { className: 'att-monitor-badge-pulse-dot' }),
              agentStatus === 'confirmation_waiting' ? 'WAIT' : 'RUN'
            )
          : h('span', {
              className: 'att-monitor-badge-pulse-dot',
              style: { color: 'var(--dsw-alias-state-success-primary)' }
            }),
        h(
          'span',
          {
            title: t('monitor.hud.expand'),
            style: { fontSize: '10px', opacity: 0.8, cursor: 'pointer', padding: '0 2px' }
          },
          '▼'
        ),
        onCloseHud &&
          h(
            'button',
            {
              className: 'att-nav-btn',
              style: { marginLeft: '2px', padding: '0 4px', fontSize: '11px', opacity: 0.7 },
              title: t('monitor.hud.close'),
              'aria-label': t('monitor.hud.close'),
              onClick: (e: { stopPropagation: () => void }) => {
                e.stopPropagation();
                onCloseHud();
              }
            },
            '✕'
          )
      ),

    // Expanded Draggable Floating Window
    expanded &&
      h(
        'div',
        {
          className: `att-floating-window ${isDragging ? 'is-dragging' : ''}`,
          role: 'dialog',
          tabIndex: -1,
          'aria-label': t('monitor.title'),
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Escape') {
              setExpanded(false);
              setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
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
            onPointerMove: handlePointerMove,
            onPointerUp: (e: any) => handlePointerUp(e, false),
            onPointerCancel: (e: any) => handlePointerUp(e, false),
            onDoubleClick: handleHeaderDoubleClick
          },
          h(
            'div',
            { className: 'att-floating-header-left' },
            h('span', { className: 'att-floating-drag-grip', 'aria-hidden': true }, '⠿'),
            h('span', { 'aria-hidden': true }, '📊'),
            h('span', { style: { fontWeight: 600, fontSize: '12px' } }, t('monitor.title'))
          ),
          h(
            'div',
            { className: 'att-floating-header-actions' },
            h(
              'button',
              {
                className: 'att-nav-btn',
                title: t('monitor.hud.minimize'),
                'aria-label': t('monitor.hud.minimize'),
                onClick: (e: { stopPropagation: () => void }) => {
                  e.stopPropagation();
                  setExpanded(false);
                  setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
                }
              },
              '—'
            ),
            onCloseHud &&
              h(
                'button',
                {
                  className: 'att-nav-btn',
                  title: t('monitor.hud.close'),
                  'aria-label': t('monitor.hud.close'),
                  onClick: (e: { stopPropagation: () => void }) => {
                    e.stopPropagation();
                    onCloseHud();
                  }
                },
                '✕'
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
          h('span', { 'aria-hidden': true }, '🖥️'),
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
            activeLabel || activeServerId || metrics?.serverId || 'Default'
          )
        ),

        // Subtabs Navigation Bar
        h(
          'div',
          { className: 'att-floating-subtabs' },
          h(
            'button',
            {
              className: `att-floating-tab-btn ${activeTab === 'overview' ? 'is-active' : ''}`,
              onClick: () => setActiveTab('overview')
            },
            t('monitor.tab.overview')
          ),
          h(
            'button',
            {
              className: `att-floating-tab-btn ${activeTab === 'hardware' ? 'is-active' : ''}`,
              onClick: () => setActiveTab('hardware')
            },
            t('monitor.tab.hardware')
          ),
          h(
            'button',
            {
              className: `att-floating-tab-btn ${activeTab === 'agent' ? 'is-active' : ''}`,
              onClick: () => setActiveTab('agent')
            },
            t('monitor.tab.agent')
          )
        ),

        // Body Content
        h(
          'div',
          { className: 'att-floating-window-body' },
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
                    { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } },
                    `Load: ${metrics?.cpu.loadAvg.map((l) => l.toFixed(2)).join('/') ?? '0/0/0'}`
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
                    { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } },
                    `${formatFileSize(memUsedBytes)} / ${formatFileSize(memTotalBytes)}`
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
                    { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } },
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
                    { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } },
                    h('span', null, `↓ Rx: ${rxStr}`),
                    h('span', null, `↑ Tx: ${txStr}`)
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
                          style: { fontSize: '10px' }
                        },
                        agentStatus === 'confirmation_waiting' ? t('monitor.status.waiting') : t('monitor.status.running')
                      )
                    : h(
                        'span',
                        { style: { fontSize: '11px', color: 'var(--dsw-alias-state-success-primary)' } },
                        `● ${t('monitor.agent.ready')}`
                      )
                ),
                isAgentActive
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                      h(
                        'div',
                        { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } },
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
              ),

              // Quick Action Navigation Buttons (ONLY tab switching and minimize, NO openSidebar!)
              h(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
                h(
                  'button',
                  {
                    className: 'att-btn',
                    style: { flex: 1, padding: '4px 8px', fontSize: '11px' },
                    onClick: () => setActiveTab('hardware')
                  },
                  t('monitor.tab.hardware')
                ),
                h(
                  'button',
                  {
                    className: 'att-btn',
                    style: { flex: 1, padding: '4px 8px', fontSize: '11px' },
                    onClick: () => setActiveTab('agent')
                  },
                  t('monitor.tab.agent')
                ),
                h(
                  'button',
                  {
                    className: 'att-btn',
                    style: { flex: 1, padding: '4px 8px', fontSize: '11px' },
                    onClick: () => {
                      setExpanded(false);
                      setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
                    }
                  },
                  t('monitor.hud.minimize')
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
              onRefresh: () => {}
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
