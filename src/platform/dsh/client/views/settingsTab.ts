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

/**
 * Layout vocabulary for this page.
 *
 * The page had one defect worth stating in code, because it is a *layout* defect and no amount of
 * colour work fixes it: an SSH fingerprint is ~50 characters of base64 with no spaces to break on.
 * Laid out as one flex row (`host` · fingerprint · owner · button) inside a 760px column, it pushed
 * the button past the right edge and the whole panel grew a horizontal scrollbar — you had to drag
 * sideways to reach **Forget**. Two rules follow, and every long string on this page obeys one:
 *
 * 1. A string with no break opportunities wraps (`overflowWrap: 'anywhere'`) rather than expanding
 *    its container — the fingerprint sits on its own line, under the host it belongs to.
 * 2. A string that must stay on one line truncates (`minWidth: 0` + `textOverflow: 'ellipsis'`),
 *    because `min-width: auto` on a flex child is what silently refuses to shrink.
 *
 * Every colour is a `--dsw-*` token: this page is rendered inside the host's settings shell in both
 * light and dark themes, and an inline hex would be correct in exactly one of them.
 */
const pageStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '14px',
  width: '100%',
  maxWidth: '820px',
  boxSizing: 'border-box' as const,
  color: 'var(--dsw-alias-label-primary)'
};
/** One card per section, so four unrelated tables stop reading as one long list. */
const cardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '10px',
  minWidth: 0,
  padding: '12px 14px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  boxSizing: 'border-box' as const
};
const headingStyle = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)'
};
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
  fontSize: '12px'
};
const mutedStyle = { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' };
/** Secondary, not tertiary: an explanation is read, a timestamp is glanced at. */
const captionStyle = {
  color: 'var(--dsw-alias-label-caption)',
  fontSize: '12px',
  lineHeight: '18px'
};
const monoStyle = { fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: '11px' };
/**
 * A fingerprint may not widen the page.
 *
 * `break-all` on top of `anywhere`: the former also breaks between characters mid-"word", which is
 * what a base64 string is.
 */
const fingerprintStyle = {
  ...monoStyle,
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere' as const,
  wordBreak: 'break-all' as const,
  minWidth: 0
};
/** One line, truncated, with the full value available from `title`. */
const ellipsisStyle = {
  minWidth: 0,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const
};
const buttonStyle = {
  flex: 'none' as const,
  padding: '3px 10px',
  fontSize: '12px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--dsw-radius-sm)',
  cursor: 'pointer'
};
const statRowStyle = { display: 'flex', gap: '8px', flexWrap: 'wrap' as const };
const statStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '2px',
  minWidth: '96px',
  padding: '8px 12px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--dsw-radius-sm)',
  background: 'var(--dsw-alias-bg-layer-2)'
};
const statValueStyle = { fontSize: '18px', fontWeight: 600, lineHeight: '22px' };
const listStyle = { display: 'flex', flexDirection: 'column' as const, gap: '6px', minWidth: 0 };
const auditRowStyle = {
  display: 'grid',
  // `minmax(0, 1fr)` on the command column is what lets it shrink: a bare `1fr` keeps the item's
  // min-content width, so one long command would widen the whole card again.
  gridTemplateColumns: '62px minmax(64px, auto) minmax(0, 1fr)',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
  fontSize: '12px'
};
const keyCardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '3px',
  minWidth: 0,
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--dsw-radius-sm)'
};
/** `currentColor` keeps the badge honest: one declaration, three tokens. */
const badgeStyle = {
  justifySelf: 'start' as const,
  padding: '1px 7px',
  fontSize: '11px',
  lineHeight: '16px',
  borderRadius: 'var(--dsw-radius-sm)',
  border: '1px solid currentColor'
};

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

  /** The decision badge: colour carries the verdict, and `currentColor` carries the border. */
  const badge = (decision: AgentAuditSummary['decision']) =>
    h(
      'span',
      {
        style: {
          ...badgeStyle,
          color:
            decision === 'allowed'
              ? 'var(--dsw-alias-state-success-primary)'
              : decision === 'confirmed'
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-state-error-primary)'
        }
      },
      decisionLabel(decision)
    );

  return h(
    'div',
    // No `att-*` class: the gate that every such class is defined in the stylesheet exists to stop
    // unstyled hooks from accumulating, and this page is styled entirely inline from
    // `--dsw-alias-*` tokens so it follows the host's light/dark switch.
    { style: pageStyle },

    /* ------------------------------ decision counts ----------------------------- */
    h(
      'div',
      { style: cardStyle },
      h('h3', { style: headingStyle }, t('settings.decisions.heading')),
      audits === null
        ? h('div', { style: mutedStyle }, t('settings.audit.unreadable'))
        : h(
            'div',
            { style: statRowStyle },
            ...[
              [totals.allowed, t('settings.decisions.allowed.label')],
              [totals.confirmed, t('settings.decisions.confirmed.label')],
              [totals.denied, t('settings.decisions.denied.label')]
            ].map(([count, label]) =>
              h(
                'div',
                { key: String(label), style: statStyle },
                h('span', { style: statValueStyle }, String(count)),
                h('span', { style: mutedStyle }, String(label))
              )
            )
          ),
      audits === null
        ? null
        : h('div', { style: captionStyle }, t('settings.decisions.window', { count: audits.length }))
    ),

    /* --------------------------------- audit tail -------------------------------- */
    h(
      'div',
      { style: cardStyle },
      h('h3', { style: headingStyle }, t('settings.audit.heading')),
      ...(audits === null
        ? [h('div', { key: 'unreadable', style: mutedStyle }, t('settings.audit.unreadable'))]
        : audits.length === 0
          ? [h('div', { key: 'empty', style: mutedStyle }, t('settings.audit.empty'))]
          : audits
              .slice(-10)
              .reverse()
              .map((audit) => {
                // A command is one long line with no break opportunities, so it truncates rather
                // than widening the card; the full text stays reachable through `title`.
                const command = String(audit.command ?? '');
                return h(
                  'div',
                  { key: audit.id, style: auditRowStyle },
                  h('span', { style: { ...monoStyle, color: 'var(--dsw-alias-label-caption)' } }, timeOf(audit.timestamp)),
                  badge(audit.decision),
                  h(
                    'span',
                    { style: { ...monoStyle, color: 'var(--dsw-alias-label-secondary)', ...ellipsisStyle } },
                    command === '' ? '—' : command
                  )
                );
              })),
      audits === null
        ? null
        : h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, alignSelf: 'flex-start' },
              onClick: () => {
                if (typeof navigator === 'undefined') return;
                void navigator.clipboard?.writeText(JSON.stringify(audits, null, 2));
              }
            },
            t('settings.audit.copy')
          )
    ),

    /* ------------------------------- trust library ------------------------------ */
    h(
      'div',
      { style: cardStyle },
      h('h3', { style: headingStyle }, t('settings.trust.heading')),
      h('div', { style: captionStyle }, t('settings.trust.scope')),
      error !== null ? h('div', { style: mutedStyle }, t('settings.trust.failed', { message: error })) : null,
      hostKeys === null
        ? h('div', { style: mutedStyle }, t('settings.trust.unreadable'))
        : hostKeys.length === 0
          ? h('div', { style: mutedStyle }, t('settings.trust.empty'))
          : h(
              'div',
              { style: listStyle },
              ...hostKeys.map((row) => {
                // `forgetHost` bounds host/port to a server's own jump chain, so a key is only
                // actionable when a configured server's address is exactly this key's.
                const owner = servers.find(
                  (server) => server.host === row.host && (server.port ?? 22) === row.port
                );
                /**
                 * Three lines, and the reason is the fingerprint: at ~50 characters it cannot share
                 * a row with a host, an owner and a button inside any panel width worth supporting.
                 * Line 1 is what you scan for (address + the action), line 2 is whose it is, line 3
                 * is what you came to compare — and it is allowed to wrap instead of scrolling.
                 */
                return h(
                  'div',
                  { key: `${row.host}:${row.port}`, style: keyCardStyle },
                  h(
                    'div',
                    { style: { ...rowStyle, justifyContent: 'space-between' } },
                    h(
                      'span',
                      { style: { ...monoStyle, color: 'var(--dsw-alias-label-primary)', ...ellipsisStyle } },
                      `${row.host}:${row.port}`
                    ),
                    owner === undefined
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            disabled: busy,
                            style: buttonStyle,
                            onClick: () => forget(row, owner)
                          },
                          t('settings.trust.forget')
                        )
                  ),
                  h(
                    'div',
                    { style: mutedStyle },
                    owner === undefined
                      ? t('settings.trust.ownerless')
                      : (owner.label ?? owner.id)
                  ),
                  h('div', { style: fingerprintStyle, title: row.fingerprint }, row.fingerprint)
                );
              })
            )
    ),

    /* ------------------------- the optional persistent shell --------------------- */
    h(
      'div',
      { style: cardStyle },
      h('h3', { style: headingStyle }, t('settings.optional.heading')),
      h('div', { style: captionStyle }, t('settings.optional.about')),
      optional === null
        ? // Not read yet is its own state: defaulting it to "not installed" would offer an Install
          // button to someone who already has the bundle.
          h('div', { style: mutedStyle }, t('settings.audit.unreadable'))
        : optional.available === false
          ? h('div', { style: mutedStyle }, optional.reason ?? t('settings.optional.unavailable'))
          : h(
              'div',
              { style: { ...rowStyle, justifyContent: 'space-between', gap: '12px' } },
              h('span', { style: { fontSize: '12px' } }, optionalState(optional)),
              h(
                'button',
                {
                  type: 'button',
                  disabled: optionalBusy,
                  style: buttonStyle,
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
            {
              style: {
                ...monoStyle,
                color: 'var(--dsw-alias-label-tertiary)',
                overflowWrap: 'anywhere' as const
              }
            },
            t('settings.optional.manual', { spec: optional.spec })
          )
        : null
    )
  );
}
