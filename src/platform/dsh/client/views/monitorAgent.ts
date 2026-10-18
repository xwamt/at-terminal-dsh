import type { AgentExecutionSnapshot, Translate } from '../models';
import { formatFileSize } from '../../../../sftp/FileSize';
import { formatThroughput } from '../models';
import { formatClock } from '../localeFormat';
import { h, type El } from './shared';

/**
 * The audit row's risk column.
 *
 * It used to print `audit.riskLevel ?? 'normal'` with `text-transform: uppercase` — a raw wire
 * value (`low` / `medium` / `high`, from `AgentExecutionBridge`) leaking into the UI, and an
 * English fallback that existed in no dictionary. Both are the same defect: the column showed
 * the transport's vocabulary instead of the panel's. The keys are enumerated rather than
 * interpolated (`monitor.risk.${level}`) because the wire value set is closed, and a key that
 * does not exist renders as its own name — a visible `monitor.risk.` on screen.
 */
function riskLabel(t: Translate, level: string | undefined): string {
  switch (level) {
    case 'high':
      return t('monitor.risk.high');
    case 'medium':
      return t('monitor.risk.medium');
    case 'low':
      return t('monitor.risk.low');
    default:
      return t('monitor.risk.unknown');
  }
}

export interface AgentMonitorViewProps {
  t: Translate;
  snapshot: AgentExecutionSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}

export function AgentMonitorView(props: AgentMonitorViewProps): El {
  const { t, snapshot, loading, onRefresh } = props;

  if (!snapshot && loading) {
    return h(
      'div',
      { className: 'att-monitor-card', role: 'region', 'aria-label': t('monitor.tab.agent') },
      h('div', null, t('servers.pending'))
    );
  }

  const current = snapshot?.currentAction;
  const recentAudits = snapshot?.recentAudits ?? [];
  const activeTransfers = snapshot?.activeTransfers ?? [];

  return h(
    'div',
    { className: 'att-monitor-grid', role: 'region', 'aria-label': t('monitor.tab.agent') },
    // Live Action Card
    h(
      'div',
      { className: 'att-monitor-card', style: { gridColumn: '1 / -1' } },
      h(
        'div',
        { className: 'att-monitor-card-header' },
        h('span', null, t('monitor.agent.actionTitle')),
        current &&
          h(
            'span',
            {
              className: `att-monitor-badge ${
                current.status === 'running'
                  ? 'att-monitor-badge-running'
                  : current.status === 'confirmation_waiting'
                    ? 'att-monitor-badge-waiting'
                    : current.status === 'success'
                      ? 'att-monitor-badge-success'
                      : 'att-monitor-badge-denied'
              }`
            },
            current.status === 'running' && h('span', { className: 'att-monitor-badge-pulse-dot' }),
            t(`monitor.status.${current.status === 'confirmation_waiting' ? 'waiting' : current.status}`)
          )
      ),
      current
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
              h('span', null, `Server: ${current.serverId ?? 'default'}`),
              h('span', null, t('monitor.agent.elapsed', { time: current.runningTimeMs }))
            ),
            h(
              'div',
              { className: 'att-code-preview' },
              current.command
            ),
            current.outputTail &&
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('monitor.agent.output')),
                h('div', { className: 'att-code-preview' }, current.outputTail)
              )
          )
        : h(
            'div',
            { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '12px 0' } },
            t('monitor.agent.idle')
          )
    ),
    // Active Transfers Card
    h(
      'div',
      { className: 'att-monitor-card', style: { gridColumn: '1 / -1' } },
      h('div', { className: 'att-monitor-card-header' }, h('span', null, t('monitor.agent.transfersTitle'))),
      activeTransfers.length === 0
        ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('monitor.agent.transfersEmpty'))
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            ...activeTransfers.map((tx) =>
              h(
                'div',
                { key: tx.id, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
                  h('span', null, `[${tx.type.toUpperCase()}] ${tx.filename}`),
                  h('span', { color: 'var(--dsw-alias-label-secondary)' }, `${tx.progressPercent}% (${formatThroughput(tx.bytesPerSec)})`)
                ),
                h(
                  'div',
                  { className: 'att-monitor-gauge' },
                  h('div', {
                    className: 'att-monitor-gauge-fill',
                    style: { width: `${tx.progressPercent}%` }
                  })
                )
              )
            )
          )
    ),
    // Recent Audits Card
    h(
      'div',
      { className: 'att-monitor-card', style: { gridColumn: '1 / -1' } },
      h('div', { className: 'att-monitor-card-header' }, h('span', null, t('monitor.agent.auditsTitle'))),
      recentAudits.length === 0
        ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('monitor.agent.auditsEmpty'))
        : h(
            'table',
            { className: 'att-monitor-table', 'aria-label': t('monitor.agent.auditsTitle') },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, t('monitor.audit.time')),
                h('th', null, t('monitor.audit.decision')),
                h('th', null, t('monitor.audit.risk')),
                h('th', null, t('monitor.audit.command'))
              )
            ),
            h(
              'tbody',
              null,
              ...recentAudits.map((audit) => {
                const decisionClass =
                  audit.decision === 'denied'
                    ? 'att-monitor-badge-denied'
                    : audit.decision === 'confirmed'
                      ? 'att-monitor-badge-waiting'
                      : 'att-monitor-badge-success';
                return h(
                  'tr',
                  { key: audit.id },
                  h(
                    'td',
                    { style: { whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-caption)' } },
                    formatClock(audit.timestamp)
                  ),
                  h(
                    'td',
                    null,
                    h('span', { className: `att-monitor-badge ${decisionClass}` }, t(`monitor.decision.${audit.decision}`))
                  ),
                  h('td', { style: { fontSize: '11px' } }, riskLabel(t, audit.riskLevel)),
                  h('td', { style: { fontFamily: 'monospace', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, audit.command)
                );
              })
            )
          )
    )
  );
}
