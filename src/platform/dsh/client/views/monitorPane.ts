import React, { useEffect, useState } from 'react';
import type { AgentExecutionSnapshot, HardwareMetrics, ServerView, Translate } from '../models';
import { callRpc, getAgentExecutionStatusRpc, getHardwareMetricsRpc } from '../channel';
import { boltRegular, gaugeRegular, refreshRegular } from '../icons';
import { HardwareMonitorView } from './monitorHardware';
import { AgentMonitorView } from './monitorAgent';
import { h, type El } from './shared';

export interface AtTerminalMonitorBodyProps {
  t: Translate;
  /**
   * The floating window's switch, so the pane can turn it back on.
   *
   * Closing the capsule is remembered (a new connection no longer brings it back), which makes a
   * visible way to reopen it a requirement rather than a nicety: without this the only ways back
   * were a restart or asking the agent. The pane is where a user looking for the monitor already
   * is, so the switch lives in its header next to refresh.
   */
  hud?: {
    isVisible(): boolean;
    subscribe(listener: (visible: boolean) => void): () => void;
    toggle(): void;
  };
  useTabInfo?: () => {
    sidebar?: { expanded: boolean; fullscreen: boolean };
    panel?: { id: string };
    tab?: {
      id: string;
      kind: string;
      navigation?: { params?: { target?: 'hardware' | 'agent_execution'; serverId?: string } };
    };
  };
}

export function AtTerminalMonitorBody(props: AtTerminalMonitorBodyProps): El {
  const { t, useTabInfo } = props;
  const tabInfo = useTabInfo ? useTabInfo() : undefined;
  const initialTarget = tabInfo?.tab?.navigation?.params?.target ?? 'hardware';
  const initialServerId = tabInfo?.tab?.navigation?.params?.serverId ?? '';

  const [activeTab, setActiveTab] = useState<'hardware' | 'agent_execution'>(initialTarget);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>(initialServerId);
  const [metrics, setMetrics] = useState<HardwareMetrics | null>(null);
  const [snapshot, setSnapshot] = useState<AgentExecutionSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const hud = props.hud;
  const [hudVisible, setHudVisible] = useState<boolean>(() => hud?.isVisible() ?? false);
  useEffect(() => {
    if (!hud) return;
    // Read once on mount, then follow the controller: the ✕ in the capsule and this button are two
    // handles on one state, and each has to render what the other did.
    setHudVisible(hud.isVisible());
    return hud.subscribe(setHudVisible);
  }, [hud]);

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

  /**
   * Arrow keys on the tab strip.
   *
   * Two tabs only, so this is a wrap-around between the pair rather than an index walk: Right
   * and Left both move to the other tab, Home/End do the same. `tabIndex` follows the selection
   * (roving), so the whole strip costs one Tab stop and the arrows are the way in — which is
   * what a `role="tablist"` promises a screen reader.
   */
  const onTabKeyDown = (e: { key: string; preventDefault: () => void }) => {
    const total = 2;
    const at = activeTab === 'hardware' ? 0 : 1;
    const next =
      e.key === 'ArrowRight'
        ? (at + 1) % total
        : e.key === 'ArrowLeft'
          ? (at + total - 1) % total
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? total - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setActiveTab(next === 0 ? 'hardware' : 'agent_execution');
    // Focus follows selection, or the roving tabindex and the focus ring point at different tabs.
    const el = document.getElementById(next === 0 ? 'att-monitor-tab-hardware' : 'att-monitor-tab-agent');
    if (el !== null) el.focus();
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
        { className: 'att-monitor-nav', role: 'tablist', 'aria-label': t('monitor.title') },
        h(
          'button',
          {
            id: 'att-monitor-tab-hardware',
            type: 'button',
            className: 'att-monitor-tab-btn',
            role: 'tab',
            'aria-selected': activeTab === 'hardware',
            'aria-controls': 'att-monitor-tabpanel',
            tabIndex: activeTab === 'hardware' ? 0 : -1,
            'data-active': activeTab === 'hardware' ? 'true' : 'false',
            onClick: () => setActiveTab('hardware'),
            onKeyDown: onTabKeyDown
          },
          gaugeRegular({ size: 14 }),
          t('monitor.tab.hardware')
        ),
        h(
          'button',
          {
            id: 'att-monitor-tab-agent',
            type: 'button',
            className: 'att-monitor-tab-btn',
            role: 'tab',
            'aria-selected': activeTab === 'agent_execution',
            'aria-controls': 'att-monitor-tabpanel',
            tabIndex: activeTab === 'agent_execution' ? 0 : -1,
            'data-active': activeTab === 'agent_execution' ? 'true' : 'false',
            onClick: () => setActiveTab('agent_execution'),
            onKeyDown: onTabKeyDown
          },
          boltRegular({ size: 14 }),
          t('monitor.tab.agent')
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
                className: 'att-select',
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
            className: 'att-nav-btn att-icon-btn',
            title: t('monitor.refresh'),
            'aria-label': t('monitor.refresh'),
            onClick: () => void refresh()
          },
          refreshRegular({ size: 16 })
        ),
        /**
         * The floating window, on or off.
         *
         * `aria-pressed` rather than a changing label alone: screen readers announce the state, and
         * the title says what the click will do — both, because a tooltip that only appears on
         * hover is not a state.
         */
        hud &&
          h(
            'button',
            {
              className: `att-nav-btn att-icon-btn${hudVisible ? ' is-active' : ''}`,
              title: hudVisible ? t('monitor.hud.paneHide') : t('monitor.hud.paneShow'),
              'aria-label': hudVisible ? t('monitor.hud.paneHide') : t('monitor.hud.paneShow'),
              'aria-pressed': hudVisible ? 'true' : 'false',
              onClick: () => hud.toggle()
            },
            gaugeRegular({ size: 16 })
          )
      )
    ),
    // Tab Body Content
    h(
      'div',
      {
        id: 'att-monitor-tabpanel',
        role: 'tabpanel',
        'aria-labelledby': activeTab === 'hardware' ? 'att-monitor-tab-hardware' : 'att-monitor-tab-agent'
      },
      activeTab === 'hardware'
        ? h(HardwareMonitorView, { t, metrics, loading, onRefresh: refresh })
        : h(AgentMonitorView, { t, snapshot, loading, onRefresh: refresh })
    )
  );
}

export function AtTerminalMonitorTitle(props: { t: Translate }): El {
  const { t } = props;
  return h(
    'span',
    { className: 'att-tab-title' },
    gaugeRegular({ size: 14 }),
    h('span', { className: 'att-tab-title-text' }, t('monitor.title'))
  );
}
