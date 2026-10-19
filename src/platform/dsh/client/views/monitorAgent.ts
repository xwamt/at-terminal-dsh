import { useState } from 'react';
import type { AgentAuditSummary, AgentExecutionSnapshot, Translate } from '../models';
import { chevronDownRegular, chevronRightRegular } from '../icons';
import { formatFileSize } from '../../../../sftp/FileSize';
import { formatThroughput } from '../models';
import { formatClock } from '../localeFormat';
import { h, needsTextDisclosure, type El } from './shared';

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
  /**
   * Every audit seen during the current connection, newest first.
   *
   * The snapshot only carries the server's most recent slice, so the HUD accumulates the
   * records it polls into this list and hands it over. Absent in the sidebar pane, which keeps
   * rendering whatever the snapshot gives it.
   */
  history?: AgentAuditSummary[];
}

/** How many audit rows the default (non-history) view shows. */
const RECENT_AUDIT_ROWS = 4;

/**
 * Rows the audit card renders.
 *
 * Pure and exported so the rule can be tested without mounting the component (these node tests
 * have no DOM): the default view is the four newest rows, the history view is everything the
 * current connection produced. With no accumulated history — the sidebar pane — the snapshot's
 * own list passes through unchanged.
 */
export function selectAuditRows(
  recent: AgentAuditSummary[],
  history: AgentAuditSummary[] | undefined,
  showHistory: boolean
): AgentAuditSummary[] {
  if (!history) return recent;
  return showHistory ? history : history.slice(0, RECENT_AUDIT_ROWS);
}

/**
 * Whether a command needs a disclosure control.
 *
 * The cell is a single ellipsized line (`.att-clip-line`), so anything long enough to be
 * clipped — or carrying a newline, which a single line cannot show at all — gets a chevron that
 * reveals the full text underneath. The threshold matches what the command column actually fits
 * in the narrowest floating window (~25 monospace characters), not the 400px default.
 */
export function needsCommandDisclosure(command: string): boolean {
  return needsTextDisclosure(command, 24);
}

export function AgentMonitorView(props: AgentMonitorViewProps): El {
  const { t, snapshot, loading, onRefresh, history } = props;
  const [showHistory, setShowHistory] = useState(false);
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null);

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
  // Default view: the four most recent rows. History: everything this connection produced.
  const audits = selectAuditRows(recentAudits, history, showHistory);
  const hasHistory = Boolean(history && history.length > RECENT_AUDIT_ROWS);

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
      h(
        'div',
        { className: 'att-monitor-card-header' },
        h(
          'span',
          null,
          showHistory ? t('monitor.agent.historyTitle') : t('monitor.agent.auditsTitle')
        ),
        hasHistory &&
          h(
            'button',
            {
              type: 'button',
              className: 'att-btn',
              style: { padding: '2px 8px', fontSize: '11px' },
              'aria-pressed': showHistory,
              onClick: () => setShowHistory((prev) => !prev)
            },
            showHistory
              ? t('monitor.agent.historyBack')
              : `${t('monitor.agent.history')} (${history?.length ?? 0})`
          )
      ),
      showHistory &&
        h(
          'div',
          { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
          t('monitor.agent.historyCount', { count: history?.length ?? 0 })
        ),
      audits.length === 0
        ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('monitor.agent.auditsEmpty'))
        : h(
            'table',
            {
              className: 'att-monitor-table att-audit-table',
              'aria-label': showHistory ? t('monitor.agent.historyTitle') : t('monitor.agent.auditsTitle')
            },
            // Column widths live in the first row for `table-layout: fixed`; the command column
            // takes whatever is left.
            h(
              'colgroup',
              null,
              h('col', { style: { width: '62px' } }),
              h('col', { style: { width: '76px' } }),
              h('col', { style: { width: '38px' } }),
              h('col', null)
            ),
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
              ...audits.map((audit) => {
                const decisionClass =
                  audit.decision === 'denied'
                    ? 'att-monitor-badge-denied'
                    : audit.decision === 'confirmed'
                      ? 'att-monitor-badge-waiting'
                      : 'att-monitor-badge-success';
                const expanded = expandedAuditId === audit.id;
                const canExpand = needsCommandDisclosure(audit.command);
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
                    { style: { whiteSpace: 'nowrap' } },
                    h('span', { className: `att-monitor-badge ${decisionClass}` }, t(`monitor.decision.${audit.decision}`))
                  ),
                  h('td', { style: { fontSize: '11px', whiteSpace: 'nowrap' } }, riskLabel(t, audit.riskLevel)),
                  h(
                    'td',
                    { style: { minWidth: 0 } },
                    // One clipped line plus a disclosure. Without the fixed layout above, the
                    // span's ellipsis never engaged and the table grew wider than the window.
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
                      h(
                        'span',
                        {
                          className: 'att-clip-line',
                          title: audit.command,
                          style: { flex: '1 1 auto', minWidth: 0 }
                        },
                        audit.command
                      ),
                      canExpand &&
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'att-clip-toggle',
                            title: expanded
                              ? t('monitor.agent.collapseCommand')
                              : t('monitor.agent.expandCommand'),
                            'aria-label': expanded
                              ? t('monitor.agent.collapseCommand')
                              : t('monitor.agent.expandCommand'),
                            'aria-expanded': expanded,
                            onClick: () => setExpandedAuditId(expanded ? null : audit.id)
                          },
                          expanded ? chevronDownRegular({ size: 12 }) : chevronRightRegular({ size: 12 })
                        )
                    ),
                    expanded &&
                      h('div', { className: 'att-clip-full' }, audit.command)
                  )
                );
              })
            )
          )
    )
  );
}
