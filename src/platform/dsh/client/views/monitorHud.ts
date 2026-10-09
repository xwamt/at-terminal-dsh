import React, { useState } from 'react';
import type { AgentExecutionSnapshot, HardwareMetrics, Translate } from '../models';
import { h, type El } from './shared';

export interface MonitorHudWidgetProps {
  t: Translate;
  metrics: HardwareMetrics | null;
  snapshot: AgentExecutionSnapshot | null;
  onOpenPane: (target: 'hardware' | 'agent_execution') => void;
  onCloseHud?: () => void;
  forceExpanded?: boolean;
}

export function MonitorHudWidget(props: MonitorHudWidgetProps): El {
  const { t, metrics, snapshot, onOpenPane, onCloseHud, forceExpanded } = props;
  const [expanded, setExpanded] = useState(Boolean(forceExpanded));

  React.useEffect(() => {
    if (forceExpanded !== undefined) {
      setExpanded(forceExpanded);
    }
  }, [forceExpanded]);

  const cpuPercent = metrics?.cpu.usagePercent ?? 0;
  const memUsedBytes = metrics?.memory.usedBytes ?? 0;
  const memTotalBytes = metrics?.memory.totalBytes || 1;
  const memPercent = Math.min(100, Math.round((memUsedBytes / memTotalBytes) * 100));
  const isAgentActive = Boolean(snapshot?.currentAction);

  return h(
    'div',
    { className: 'att-hud-overlay' },
    // Mini Pill
    h(
      'div',
      {
        className: 'att-hud-pill',
        role: 'button',
        tabIndex: 0,
        'aria-label': t('monitor.hud.toggle'),
        onClick: () => setExpanded(!expanded),
        onKeyDown: (e: { key: string }) => {
          if (e.key === 'Enter' || e.key === ' ') setExpanded(!expanded);
        }
      },
      h('span', null, '📊'),
      h('span', { className: 'att-badge-pulse-dot', style: { color: isAgentActive ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-success-primary)' } }),
      h('span', null, `CPU ${cpuPercent}% | MEM ${memPercent}%`),
      isAgentActive &&
        h(
          'span',
          { style: { color: 'var(--dsw-alias-brand-primary)', fontWeight: 600 } },
          `⚡ ${snapshot?.currentAction?.status === 'confirmation_waiting' ? 'WAIT' : 'RUN'}`
        ),
      onCloseHud &&
        h(
          'button',
          {
            className: 'att-nav-btn',
            style: { marginLeft: '4px', padding: '0 4px', fontSize: '10px', opacity: 0.7 },
            title: t('monitor.hud.close'),
            'aria-label': t('monitor.hud.close'),
            onClick: (e: { stopPropagation(): void }) => {
              e.stopPropagation();
              onCloseHud();
            }
          },
          '✕'
        )
    ),
    // Expanded Card
    expanded &&
      h(
        'div',
        {
          className: 'att-hud-expanded-card',
          role: 'dialog',
          tabIndex: -1,
          'aria-label': t('monitor.title'),
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Escape') setExpanded(false);
          }
        },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '6px' } },
          h('span', { style: { fontWeight: 600, fontSize: '13px' } }, t('monitor.title')),
          h(
            'div',
            { style: { display: 'flex', gap: '4px' } },
            h(
              'button',
              {
                className: 'att-nav-btn',
                onClick: () => setExpanded(false),
                title: t('dialog.close'),
                'aria-label': t('dialog.close'),
                style: { padding: '2px 6px', fontSize: '11px' }
              },
              '—'
            ),
            onCloseHud &&
              h(
                'button',
                {
                  className: 'att-nav-btn',
                  onClick: () => {
                    setExpanded(false);
                    onCloseHud();
                  },
                  title: t('monitor.hud.close'),
                  'aria-label': t('monitor.hud.close'),
                  style: { padding: '2px 6px', fontSize: '11px' }
                },
                '✕'
              )
          )
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' } },
          h('div', null, `CPU: ${cpuPercent}% (Load: ${metrics?.cpu.loadAvg.map((l) => l.toFixed(2)).join(' / ') ?? '0'})`),
          h('div', null, `Memory: ${memPercent}% (${Math.round(memUsedBytes / 1024 / 1024)}MB / ${Math.round(memTotalBytes / 1024 / 1024)}MB)`),
          h('div', null, `Agent: ${isAgentActive ? snapshot?.currentAction?.command : t('monitor.agent.idle')}`),
          snapshot && snapshot.activeTransfers.length > 0 &&
            h('div', null, `${t('monitor.agent.transfersTitle')}: ${snapshot.activeTransfers.length}`)
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
          h(
            'button',
            {
              className: 'att-btn att-btn-primary',
              style: { flex: 1, padding: '4px 8px', fontSize: '11px' },
              onClick: () => {
                setExpanded(false);
                onOpenPane('hardware');
              }
            },
            t('monitor.tab.hardware')
          ),
          h(
            'button',
            {
              className: 'att-btn att-btn-secondary',
              style: { flex: 1, padding: '4px 8px', fontSize: '11px' },
              onClick: () => {
                setExpanded(false);
                onOpenPane('agent_execution');
              }
            },
            t('monitor.tab.agent')
          )
        )
      )
  );
}
