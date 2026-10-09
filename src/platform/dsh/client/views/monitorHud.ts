import { useEffect, useRef, useState } from 'react';
import type { AgentExecutionSnapshot, HardwareMetrics, Translate } from '../models';
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
  onOpenPane: (target: 'hardware' | 'agent_execution') => void;
  onCloseHud?: () => void;
  activeServerId?: string | null;
  activeLabel?: string | null;
}

export function MonitorHudWidget(props: MonitorHudWidgetProps): El {
  const { t, metrics, snapshot, onOpenPane, onCloseHud, activeServerId, activeLabel } = props;
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
  } | null>(null);

  // Viewport resize boundary adjustment
  useEffect(() => {
    const onResize = () => {
      setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Pointer drag events with Pointer Capture API
  const handlePointerDown = (e: any) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target?.closest && target.closest('button, input, select, textarea, a')) {
      return;
    }

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
      hasMoved: false
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
        280,
        40
      );
      setPos(newPos);
    }
  };

  const handlePointerUp = (e: any) => {
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
    } else {
      // Direct click on pill opens the hardware monitor tab in the sidebar
      onOpenPane('hardware');
    }
  };

  const cpuPercent = metrics?.cpu.usagePercent ?? 0;
  const memUsedBytes = metrics?.memory.usedBytes ?? 0;
  const memTotalBytes = metrics?.memory.totalBytes || 1;
  const memPercent = Math.min(100, Math.round((memUsedBytes / memTotalBytes) * 100));
  const isAgentActive = Boolean(snapshot?.currentAction);
  const agentStatus = snapshot?.currentAction?.status;

  const tooltip = [
    activeLabel || activeServerId ? `[${activeLabel || activeServerId}]` : '',
    t('monitor.hud.openSidebar'),
    t('monitor.hud.dragTip')
  ]
    .filter(Boolean)
    .join(' · ');

  return h(
    'div',
    {
      className: `att-hud-overlay ${isDragging ? 'is-dragging' : ''}`,
      style: {
        left: `${pos.x}px`,
        top: `${pos.y}px`
      }
    },
    h(
      'div',
      {
        className: `att-hud-pill ${isDragging ? 'is-dragging' : ''}`,
        role: 'button',
        tabIndex: 0,
        'aria-label': t('monitor.title'),
        title: tooltip,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerUp,
        onKeyDown: (e: { key: string }) => {
          if (e.key === 'Enter' || e.key === ' ') {
            onOpenPane('hardware');
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
            style: { maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
          },
          `🖥️ ${activeLabel || activeServerId}`
        ),
      h(
        'span',
        {
          className: 'att-hud-pill-chip',
          onClick: (e: any) => {
            e.stopPropagation();
            onOpenPane('hardware');
          }
        },
        `CPU ${cpuPercent}%`
      ),
      h(
        'span',
        {
          className: 'att-hud-pill-chip',
          onClick: (e: any) => {
            e.stopPropagation();
            onOpenPane('hardware');
          }
        },
        `MEM ${memPercent}%`
      ),
      isAgentActive
        ? h(
            'span',
            {
              className: `att-badge ${agentStatus === 'confirmation_waiting' ? 'att-badge-waiting' : 'att-badge-running'}`,
              style: { padding: '1px 6px', fontSize: '10px', cursor: 'pointer' },
              title: `${t('monitor.tab.agent')}: ${agentStatus}`,
              onClick: (e: any) => {
                e.stopPropagation();
                onOpenPane('agent_execution');
              }
            },
            h('span', { className: 'att-badge-pulse-dot' }),
            agentStatus === 'confirmation_waiting' ? 'WAIT' : 'RUN'
          )
        : h('span', {
            className: 'att-badge-pulse-dot',
            style: { color: 'var(--dsw-alias-state-success-primary)' }
          }),
      h(
        'span',
        {
          style: { fontSize: '11px', opacity: 0.7, padding: '0 2px' },
          title: t('monitor.hud.openSidebar')
        },
        '↗'
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
    )
  );
}
