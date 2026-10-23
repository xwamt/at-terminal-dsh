/**
 * The AT Terminal settings tab.
 *
 * Registered into `settings.plugins.tab`, the list slot `ui-settings-plugins` owns
 * (`dsh-client-ui-settings-plugins/lib/client.js:201-212`): that package registers the
 * Settings *navigation* entry and the tab chrome, and a feature contributes a tab by
 * `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({name, id, order, label}, Body))`.
 * The section renders the body through the same slot with `only: <id>` (`:68`), so this
 * component *is* the tab.
 *
 * Three sections, each answering a question the panel cannot:
 *
 * 1. **Decisions** (`settings.decisions.*`) — how the recent decisions broke down. Counted from
 *    the same audit rows the agent reads, so the page and the agent cannot disagree. It is
 *    *decisions*, not "connection health": nothing in this bundle reports a connection attempt,
 *    and a page that called these numbers "connection failures" would be inventing a category
 *    it never measured.
 * 2. **Recent audit** (`settings.audit.*`) — the durable trail's tail. Read-only here; the
 *    export is a copy of the JSON.
 * 3. **Trusted hosts** (`settings.trust.*`) — every stored host key. Forgetting reuses
 *    `terminal.forgetHost`, which is deliberately **server-scoped** (it bounds host/port to that
 *    server's jump chain), so a key is only forgettable here when a configured server's own
 *    address matches it. Keys that belong to a jump host or a removed server show the reason
 *    instead of a dead button — a global forget would undo the bounding that exists on purpose.
 *
 * The section names appear only as keys above, never as text: `test/dsh/copy-i18n.test.ts`
 * asserts this file contains no CJK at all, which is the invariant that makes "copy lives in the
 * dictionary" checkable instead of aspirational.
 *
 * Copy comes from the shared dictionary (`i18n.ts`) rather than being written here: the tab is
 * host chrome, and a hard-coded Chinese heading is a page an English user cannot read. The
 * registration wraps this component in `wrapWithLocale`, so `t` arrives through `BodyLocale`.
 *
 * Styling uses `--dsw-alias-*` tokens only, inline, because this page is the host's chrome: a
 * literal colour here would not follow the light/dark switch. `verify.mjs` asserts that.
 */

import React, { useEffect, useState } from 'react';

import { BodyLocale } from '../body';
import { callRpc, getAgentExecutionStatusRpc } from '../channel';
import type { AgentAuditSummary } from '../models';
import { h } from './shared';

interface HostKeyRow {
  host: string;
  port: number;
  fingerprint: string;
  algorithm?: string;
  trustedAt: number;
}

interface ServerRow {
  id: string;
  label?: string;
  host?: string;
  port?: number;
}

/**
 * What the Host reports about the optional composition bundle.
 *
 * Four facts, not one: `available` (is there a plugin manager at all), `installed` (is the package
 * in the profile), `enabled` (does its patch layer contribute) and `rows` (how many components
 * actually mounted). Collapsing them would let the page show "Install" to someone who has it, or
 * "Active" to someone whose three rows failed to mount.
 */
interface OptionalBundleState {
  available: boolean;
  name: string;
  spec: string;
  installed: boolean;
  enabled: boolean;
  rows: number;
  reason?: string;
}

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '10px',
  maxWidth: '760px',
  color: 'var(--dsw-alias-label-primary)'
};
const headingStyle = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)'
};
const rowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '10px',
  fontSize: '12px',
  padding: '4px 0',
  borderBottom: '0.5px solid var(--dsw-alias-border-l3)'
};
const mutedStyle = { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' };
const monoStyle = { fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: '11px' };

function timeOf(timestamp: number): string {
  const when = new Date(timestamp);
  return [when.getHours(), when.getMinutes(), when.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function AtTerminalSettingsTab(): unknown {
  const t = React.useContext(BodyLocale);
  /**
   * One decision, one name — the same three words the monitor uses.
   *
   * Written as three literal `t('…')` calls rather than `t(\`monitor.decision.${decision}\`)`
   * because `test/dsh/copy-i18n.test.ts` finds keys by matching literal call sites: a template
   * key would be invisible to it, so a renamed dictionary entry would ship as a raw key on
   * screen with every test green.
   */
  const decisionLabel = (decision: AgentAuditSummary['decision']): string =>
    decision === 'allowed'
      ? t('monitor.decision.allowed')
      : decision === 'confirmed'
        ? t('monitor.decision.confirmed')
        : t('monitor.decision.denied');
  /**
   * One sentence per state, and the three states are genuinely different facts.
   *
   * Same reason as `decisionLabel`: literal `t('…')` calls, so the copy test can find them.
   */
  const optionalState = (state: OptionalBundleState): string =>
    !state.installed
      ? t('settings.optional.state.missing')
      : state.enabled
        ? t('settings.optional.state.enabled', { count: state.rows })
        : t('settings.optional.state.disabled');
  const [audits, setAudits] = useState<AgentAuditSummary[] | null>(null);
  const [hostKeys, setHostKeys] = useState<HostKeyRow[] | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  /**
   * The optional composition bundle, as the Host's plugin manager describes it.
   *
   * `null` means "not read yet", which is different from every state the Host can report: the
   * three real states are not installed / installed but switched off / active, and rendering an
   * unread page as "not installed" would show an Install button to someone who already has it.
   */
  const [optional, setOptional] = useState<OptionalBundleState | null>(null);
  const [optionalBusy, setOptionalBusy] = useState(false);
  const [optionalError, setOptionalError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped after a forget to re-read the three sources; the local React typings have no
   *  `useCallback`, and a counter is the smaller change than widening them. */
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([
      getAgentExecutionStatusRpc(50).catch(() => null),
      callRpc('terminal.hostKeys', {}).catch(() => null),
      callRpc('servers.list', {}).catch(() => null),
      callRpc('terminal.optionalBundle.get', {}).catch(() => null)
    ]).then(([snapshot, keys, listed, bundle]) => {
      if (cancelled) return;
      if (snapshot !== null) setAudits(snapshot.recentAudits ?? []);
      // A failed read is said out loud: an empty trust library and an unreadable one look
      // identical otherwise, and only one of them is good news.
      setHostKeys(Array.isArray(keys) ? (keys as HostKeyRow[]) : null);
      const rows = (listed as { servers?: ServerRow[] } | null)?.servers;
      setServers(Array.isArray(rows) ? rows : []);
      setOptional(
        bundle !== null && typeof bundle === 'object' ? (bundle as OptionalBundleState) : null
      );
    });
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  const forget = (row: HostKeyRow, server: ServerRow): void => {    setBusy(true);
    void callRpc('terminal.forgetHost', {
      serverId: server.id,
      host: row.host,
      port: row.port
    })
      .then(() => setReloadCount((count) => count + 1))
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure))
      )
      .finally(() => setBusy(false));
  };

  /**
   * Install, enable or disable the optional bundle.
   *
   * All three go through the Host: installing is a `pnpm add` in the profile and switching is a
   * composition reload, so neither can happen in the page. `reloadCount` re-reads afterwards —
   * when the switch succeeds the page usually unmounts first, and when it fails the row has to
   * show the state that actually survived.
   */
  const runOptional = (method: string, params: Record<string, unknown> = {}): void => {
    setOptionalBusy(true);
    setOptionalError(null);
    void callRpc(method, params)
      .then(() => setReloadCount((count) => count + 1))
      .catch((failure: unknown) =>
        setOptionalError(failure instanceof Error ? failure.message : String(failure))
      )
      .finally(() => setOptionalBusy(false));
  };

  const totals = { allowed: 0, confirmed: 0, denied: 0 };
  for (const audit of audits ?? []) {
    if (audit.decision === 'allowed') totals.allowed += 1;
    else if (audit.decision === 'confirmed') totals.confirmed += 1;
    else totals.denied += 1;
  }

  return h(
    'div',
    // No `att-*` class: the audit that every such class is defined in the stylesheet exists to
    // stop unstyled hooks from accumulating, and this page is styled entirely inline from
    // `--dsw-alias-*` tokens so it follows the host's light/dark switch.
    { style: sectionStyle },
    // 1. decision counts
    h('h3', { style: headingStyle }, t('settings.decisions.heading')),
    audits === null
      ? h('div', { style: mutedStyle }, t('settings.audit.unreadable'))
      : h(
          'div',
          { style: rowStyle },
          h('span', {}, t('settings.decisions.window', { count: audits.length })),
          h('span', { style: mutedStyle }, t('settings.decisions.allowed', { count: totals.allowed })),
          h('span', { style: mutedStyle }, t('settings.decisions.confirmed', { count: totals.confirmed })),
          h('span', { style: mutedStyle }, t('settings.decisions.denied', { count: totals.denied }))
        ),

    // 2. audit tail
    h('h3', { style: headingStyle }, t('settings.audit.heading')),
    ...(audits === null
      ? []
      : audits.length === 0
        ? [h('div', { key: 'empty', style: mutedStyle }, t('settings.audit.empty'))]
        : audits
            .slice(-10)
            .reverse()
            .map((audit) =>
              h(
                'div',
                { key: audit.id, style: rowStyle },
                h('span', { style: monoStyle }, timeOf(audit.timestamp)),
                h(
                  'span',
                  { style: mutedStyle },
                  decisionLabel(audit.decision)
                ),
                h('span', {}, String(audit.command ?? '').slice(0, 90))
              )
            )),
    audits === null
      ? null
      : h(
          'button',
          {
            type: 'button',
            style: { alignSelf: 'flex-start', fontSize: '12px' },
            onClick: () => {
              if (typeof navigator === 'undefined') return;
              void navigator.clipboard?.writeText(JSON.stringify(audits, null, 2));
            }
          },
          t('settings.audit.copy')
        ),

    // 3. trust library
    h('h3', { style: headingStyle }, t('settings.trust.heading')),
    h('div', { style: mutedStyle }, t('settings.trust.scope')),
    error !== null ? h('div', { style: mutedStyle }, t('settings.trust.failed', { message: error })) : null,
    hostKeys === null
      ? h('div', { style: mutedStyle }, t('settings.trust.unreadable'))
      : hostKeys.length === 0
        ? h('div', { style: mutedStyle }, t('settings.trust.empty'))
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column' } },
            ...hostKeys.map((row) => {
              // `forgetHost` bounds host/port to a server's own jump chain, so a key is only
              // actionable when a configured server's address is exactly this key's.
              const owner = servers.find(
                (server) => server.host === row.host && (server.port ?? 22) === row.port
              );
              return h(
                'div',
                { key: `${row.host}:${row.port}`, style: rowStyle },
                h('span', { style: monoStyle }, `${row.host}:${row.port}`),
                h('span', { style: monoStyle }, row.fingerprint),
                h(
                  'span',
                  { style: { ...mutedStyle, flex: 1 } },
                  owner === undefined
                    ? t('settings.trust.ownerless')
                    : (owner.label ?? owner.id)
                ),
                owner === undefined
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        disabled: busy,
                        style: { fontSize: '12px' },
                        onClick: () => forget(row, owner)
                      },
                      t('settings.trust.forget')
                    )
              );
            })
          ),

    // 4. the optional persistent shell
    h('h3', { style: headingStyle }, t('settings.optional.heading')),
    h('div', { style: mutedStyle }, t('settings.optional.about')),
    optional === null
      ? // Not read yet is its own state: defaulting it to "not installed" would offer an Install
        // button to someone who already has the bundle.
        h('div', { style: mutedStyle }, t('settings.audit.unreadable'))
      : optional.available === false
        ? h('div', { style: mutedStyle }, optional.reason ?? t('settings.optional.unavailable'))
        : h(
            'div',
            { style: rowStyle },
            h('span', {}, optionalState(optional)),
            h(
              'button',
              {
                type: 'button',
                disabled: optionalBusy,
                style: { fontSize: '12px' },
                onClick: () =>
                  optional.installed
                    ? runOptional('terminal.optionalBundle.setEnabled', {
                        enabled: !optional.enabled
                      })
                    : runOptional('terminal.optionalBundle.install')
              },
              optional.installed
                ? optional.enabled
                  ? t('settings.optional.disable')
                  : t('settings.optional.enable')
                : t('settings.optional.install')
            )
          ),
    optionalError !== null
      ? h('div', { style: mutedStyle }, t('settings.optional.failed', { message: optionalError }))
      : null,
    optionalBusy ? h('div', { style: mutedStyle }, t('settings.optional.busy')) : null,
    optional?.available === true
      ? h(
          'div',
          { style: { ...mutedStyle, fontSize: '11px' } },
          t('settings.optional.manual', { spec: optional.spec })
        )
      : null
  );
}
