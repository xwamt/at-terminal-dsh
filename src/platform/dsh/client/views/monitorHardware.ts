import { useState } from 'react';
import type { HardwareMetrics, Translate } from '../models';
import { formatFileSize } from '../../../../sftp/FileSize';
import { formatThroughput } from '../models';
import { chevronDownRegular, chevronRightRegular } from '../icons';
import { h, needsTextDisclosure, type El } from './shared';

export interface HardwareMonitorViewProps {
  t: Translate;
  metrics: HardwareMetrics | null;
  loading: boolean;
  onRefresh: () => void;
}

export function HardwareMonitorView(props: HardwareMonitorViewProps): El {
  const { t, metrics, loading, onRefresh } = props;
  // Which mount's full path is expanded; one at a time, same rule as the audit table.
  const [expandedMount, setExpandedMount] = useState<string | null>(null);

  if (!metrics && loading) {
    return h(
      'div',
      { className: 'att-monitor-card', role: 'region', 'aria-label': t('monitor.tab.hardware') },
      h('div', null, t('servers.pending'))
    );
  }

  const cpu = metrics?.cpu ?? { usagePercent: 0, cores: [0], loadAvg: [0, 0, 0] };
  const memory = metrics?.memory ?? { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  const disk = metrics?.disk ?? { mounts: [] };
  const network = metrics?.network ?? { rxBytesPerSec: 0, txBytesPerSec: 0 };
  const processes = metrics?.processes ?? [];

  const memUsedPercent =
    memory.totalBytes > 0 ? Math.min(100, Math.round((memory.usedBytes / memory.totalBytes) * 100)) : 0;
  const cpuWarnLevel = cpu.usagePercent > 85 ? 'error' : cpu.usagePercent > 70 ? 'warn' : 'normal';
  const memWarnLevel = memUsedPercent > 85 ? 'error' : memUsedPercent > 70 ? 'warn' : 'normal';
  /*
   * The probe failed, and these numbers are the last ones that worked.
   *
   * Without this line the page is indistinguishable from a healthy idle host — same flat memory,
   * same low CPU — which is the exact misreading the collector's `stale` bit exists to prevent.
   * `fetchedAt === 0` is a different sentence: nothing was ever collected, so the zeros below are
   * placeholders rather than a reading.
   */
  const staleNote =
    metrics?.stale === true
      ? h(
          'div',
          { className: 'att-monitor-stale', role: 'status' },
          metrics.fetchedAt > 0
            ? t('monitor.hardware.stale', { time: new Date(metrics.fetchedAt).toLocaleTimeString() })
            : t('monitor.hardware.never')
        )
      : null;

  return h(
    'div',
    { className: 'att-monitor-grid', role: 'region', 'aria-label': t('monitor.tab.hardware') },
    staleNote,
    // CPU Card
    h(
      'div',
      { className: 'att-monitor-card' },
      h(
        'div',
        { className: 'att-monitor-card-header' },
        h('span', null, t('monitor.cpu.title')),
        h('span', null, `${cpu.usagePercent}%`)
      ),
      h(
        'div',
        { className: 'att-monitor-gauge' },
        h('div', {
          className: 'att-monitor-gauge-fill',
          'data-level': cpuWarnLevel,
          style: { width: `${cpu.usagePercent}%` }
        })
      ),
      h(
        'div',
        { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
        t('monitor.cpu.load', {
          l1: cpu.loadAvg[0]?.toFixed(2) ?? '0.00',
          l5: cpu.loadAvg[1]?.toFixed(2) ?? '0.00',
          l15: cpu.loadAvg[2]?.toFixed(2) ?? '0.00'
        })
      )
    ),
    // Memory Card
    h(
      'div',
      { className: 'att-monitor-card' },
      h(
        'div',
        { className: 'att-monitor-card-header' },
        h('span', null, t('monitor.mem.title')),
        h('span', null, `${memUsedPercent}%`)
      ),
      h(
        'div',
        { className: 'att-monitor-gauge' },
        h('div', {
          className: 'att-monitor-gauge-fill',
          'data-level': memWarnLevel,
          style: { width: `${memUsedPercent}%` }
        })
      ),
      h(
        'div',
        { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
        t('monitor.mem.detail', {
          used: formatFileSize(memory.usedBytes),
          total: formatFileSize(memory.totalBytes)
        })
      ),
      memory.cachedBytes !== undefined &&
        h(
          'div',
          { style: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)' } },
          t('monitor.mem.cached', { cached: formatFileSize(memory.cachedBytes) })
        )
    ),
    // Network Card
    h(
      'div',
      { className: 'att-monitor-card' },
      h('div', { className: 'att-monitor-card-header' }, h('span', null, t('monitor.net.title'))),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
        h(
          'div',
          null,
          t('monitor.net.rx', { speed: formatThroughput(network.rxBytesPerSec) })
        ),
        h(
          'div',
          null,
          t('monitor.net.tx', { speed: formatThroughput(network.txBytesPerSec) })
        )
      )
    ),
    // Disk Partitions Card
    h(
      'div',
      { className: 'att-monitor-card', style: { gridColumn: '1 / -1' } },
      h('div', { className: 'att-monitor-card-header' }, h('span', null, t('monitor.disk.title'))),
      disk.mounts.length === 0
        ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('monitor.disk.empty'))
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            ...disk.mounts.map((mount) => {
              const diskLevel = mount.usePercent > 90 ? 'error' : mount.usePercent > 75 ? 'warn' : 'normal';
              const label = `${mount.mount} (${mount.fs})`;
              const expanded = expandedMount === mount.mount;
              const canExpand = needsTextDisclosure(label);
              return h(
                'div',
                { key: mount.mount, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                // The left side carries the path, which on a Docker host is long enough to push the
                // usage figure off the card. `minWidth: 0` on both the row and the label is what
                // lets the ellipsis engage instead of the flex item refusing to shrink.
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', minWidth: 0 } },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '4px', flex: '1 1 auto', minWidth: 0 } },
                    h(
                      'span',
                      {
                        className: 'att-clip-line',
                        title: label,
                        style: { minWidth: 0, fontWeight: 500 }
                      },
                      label
                    ),
                    canExpand &&
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'att-clip-toggle',
                          title: expanded ? t('monitor.disk.collapse') : t('monitor.disk.expand'),
                          'aria-label': expanded ? t('monitor.disk.collapse') : t('monitor.disk.expand'),
                          'aria-expanded': expanded,
                          onClick: () => setExpandedMount(expanded ? null : mount.mount)
                        },
                        expanded ? chevronDownRegular({ size: 12 }) : chevronRightRegular({ size: 12 })
                      )
                  ),
                  h(
                    'span',
                    { style: { flex: '0 0 auto', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' } },
                    `${mount.usePercent}% (${formatFileSize(mount.usedBytes)} / ${formatFileSize(mount.totalBytes)})`
                  )
                ),
                expanded && h('div', { className: 'att-clip-full' }, label),
                h(
                  'div',
                  { className: 'att-monitor-gauge' },
                  h('div', {
                    className: 'att-monitor-gauge-fill',
                    'data-level': diskLevel,
                    style: { width: `${mount.usePercent}%` }
                  })
                )
              );
            })
          )
    ),
    // Top 5 Processes Card
    h(
      'div',
      { className: 'att-monitor-card', style: { gridColumn: '1 / -1' } },
      h('div', { className: 'att-monitor-card-header' }, h('span', null, t('monitor.ps.title'))),
      h(
        'table',
        { className: 'att-monitor-table', 'aria-label': t('monitor.ps.title') },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, t('monitor.ps.pid')),
            h('th', null, t('monitor.ps.user')),
            h('th', null, t('monitor.ps.cpu')),
            h('th', null, t('monitor.ps.mem')),
            h('th', null, t('monitor.ps.command'))
          )
        ),
        h(
          'tbody',
          null,
          ...processes.slice(0, 5).map((proc) =>
            h(
              'tr',
              { key: `${proc.pid}-${proc.command}` },
              h('td', null, String(proc.pid)),
              h('td', null, proc.user),
              h('td', null, `${proc.cpuPercent.toFixed(1)}%`),
              h('td', null, `${proc.memPercent.toFixed(1)}%`),
              h('td', { style: { fontFamily: 'monospace' } }, proc.command)
            )
          )
        )
      )
    )
  );
}
