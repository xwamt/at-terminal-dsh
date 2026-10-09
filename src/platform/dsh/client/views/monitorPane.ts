import React, { useEffect, useState } from 'react';
import type { AgentExecutionSnapshot, HardwareMetrics, ServerView, Translate } from '../models';
import { callRpc, getAgentExecutionStatusRpc, getHardwareMetricsRpc } from '../channel';
import { HardwareMonitorView } from './monitorHardware';
import { AgentMonitorView } from './monitorAgent';
import { h, type El } from './shared';

export interface AtTerminalMonitorBodyProps {
  t: Translate;
  useTabInfo?: () => {
    sidebar?: { expanded: boolean; fullscreen: boolean };
    panel?: { id: string };
    tab?: {
      id: string;
      kind: string;
      navigation?: { params?: { target?: 'hardware' | 'agent_execution'; serverId?: string } };
    };
  };
  onFloat?: (tabId: string) => void;
}

export function AtTerminalMonitorBody(props: AtTerminalMonitorBodyProps): El {
  const { t, useTabInfo, onFloat } = props;
  const tabInfo = useTabInfo ? useTabInfo() : undefined;
  const initialTarget = tabInfo?.tab?.navigation?.params?.target ?? 'hardware';
  const initialServerId = tabInfo?.tab?.navigation?.params?.serverId ?? '';

  const [activeTab, setActiveTab] = useState<'hardware' | 'agent_execution'>(initialTarget);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>(initialServerId);
  const [metrics, setMetrics] = useState<HardwareMetrics | null>(null);
  const [snapshot, setSnapshot] = useState<AgentExecutionSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Load server list
  useEffect(() => {
    let unmounted = false;
    callRpc('servers.list', {})
      .then((res: any) => {
        if (!unmounted && res?.servers) {
          setServers(res.servers);
          if (!selectedServerId && res.servers.length > 0) {
            setSelectedServerId(res.servers[0].id);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      unmounted = true;
    };
  }, []);

  // Sync navigation params when changed from outside (e.g. Agent openMonitor)
  useEffect(() => {
    const navTarget = tabInfo?.tab?.navigation?.params?.target;
    if (navTarget === 'hardware' || navTarget === 'agent_execution') {
      setActiveTab(navTarget);
    }
    const navServerId = tabInfo?.tab?.navigation?.params?.serverId;
    if (navServerId) {
      setSelectedServerId(navServerId);
    }
  }, [tabInfo?.tab?.navigation?.params?.target, tabInfo?.tab?.navigation?.params?.serverId]);

  // Fetch metrics and snapshot
  const refresh = async () => {
    if (!metrics && !snapshot) {
      setLoading(true);
    }
    try {
      const [m, s] = await Promise.all([
        getHardwareMetricsRpc(selectedServerId || undefined).catch(() => null),
        getAgentExecutionStatusRpc(10).catch(() => null)
      ]);
      setMetrics(m);
      setSnapshot(s);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [selectedServerId]);

  const handleFloatClick = () => {
    if (onFloat && tabInfo?.tab?.id) {
      onFloat(tabInfo.tab.id);
    }
  };

  return h(
    'div',
    {
      className: 'att-monitor-container',
      role: 'region',
      'aria-label': t('monitor.title')
    },
    // Toolbar Header
    h(
      'div',
      { className: 'att-monitor-header' },
      h(
        'div',
        { className: 'att-monitor-nav', role: 'tablist' },
        h(
          'button',
          {
            className: 'att-monitor-tab-btn',
            role: 'tab',
            'aria-selected': activeTab === 'hardware',
            'data-active': activeTab === 'hardware' ? 'true' : 'false',
            onClick: () => setActiveTab('hardware')
          },
          `📊 ${t('monitor.tab.hardware')}`
        ),
        h(
          'button',
          {
            className: 'att-monitor-tab-btn',
            role: 'tab',
            'aria-selected': activeTab === 'agent_execution',
            'data-active': activeTab === 'agent_execution' ? 'true' : 'false',
            onClick: () => setActiveTab('agent_execution')
          },
          `⚡ ${t('monitor.tab.agent')}`
        )
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        activeTab === 'hardware' &&
          servers.length > 0 &&
          h(
            'label',
            { style: { fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' } },
            t('monitor.server'),
            h(
              'select',
              {
                className: 'att-input',
                style: { padding: '2px 6px', fontSize: '12px' },
                value: selectedServerId,
                onChange: (e: { target: { value: string } }) => setSelectedServerId(e.target.value)
              },
              ...servers.map((s) => h('option', { key: s.id, value: s.id }, s.label || s.host))
            )
          ),
        h(
          'button',
          {
            className: 'att-nav-btn',
            title: t('monitor.refresh'),
            'aria-label': t('monitor.refresh'),
            onClick: () => void refresh()
          },
          '🔄'
        ),
        onFloat &&
          h(
            'button',
            {
              className: 'att-nav-btn',
              title: t('monitor.float'),
              'aria-label': t('monitor.float'),
              onClick: handleFloatClick
            },
            '⧉'
          )
      )
    ),
    // Tab Body Content
    activeTab === 'hardware'
      ? h(HardwareMonitorView, { t, metrics, loading, onRefresh: refresh })
      : h(AgentMonitorView, { t, snapshot, loading, onRefresh: refresh })
  );
}

export function AtTerminalMonitorTitle(props: { t: Translate }): El {
  const { t } = props;
  return h(
    'span',
    { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
    h('span', null, '📊'),
    h('span', null, t('monitor.title'))
  );
}
