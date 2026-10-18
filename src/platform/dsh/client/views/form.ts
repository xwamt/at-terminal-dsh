/**
 * The server form page, built on the **same markup and stylesheet** as the VS
 * Code variant's `ServerFormPanel` (`webview/server-form/index.css`, scoped to
 * the panel by `styles.ts`): `.server-form-shell` → `.form-header` →
 * `.form-section-grid` with the connection panel left and the auth/jump/summary
 * column right, `.form-footer` with feedback and actions.
 *
 * Two honest deviations from the webview original, both because the Host half
 * has no endpoint for them yet:
 * - no "Test Connection" button (no `testConnection` rpc — a button that cannot
 *   work is worse than no button);
 * - no "Browse…" private-key picker (no host-side file dialog rpc); the path is
 *   typed, which is what the field's placeholder says.
 *
 * The group combobox keeps the webview's behaviour (filter-as-you-type over the
 * existing groups) with the same `.group-combobox*` classes, driven by React
 * state instead of focus/blur DOM juggling.
 */

import {
  summarizeForm,
  text,
  trustHelpKey,
  type FormModel,
  type ServerView,
  type Translate,
  type TrustLevel
} from '../models';
import { h, type El } from './shared';
import { chevronDownRegular } from '../icons';

export interface SaveState {
  kind: 'idle' | 'pending';
}
export interface SaveDone {
  kind: 'ok';
  label: string;
}
export interface SaveFailed {
  kind: 'failed';
  code: string;
  message: string;
}

export interface FormViewProps {
  t: Translate;
  form: FormModel;
  isNew: boolean;
  groups: string[];
  /** Jump-host candidates: every server except the one being edited. */
  servers: ServerView[];
  showPassword: boolean;
  groupMenuOpen: boolean;
  formError: { field: string; message: string } | null;
  saveState: SaveState | SaveDone | SaveFailed;
  onField(field: keyof FormModel, value: string): void;
  onCheck(field: 'backgroundConnectionAllowed', value: boolean): void;
  onAuthType(value: string): void;
  onTogglePassword(): void;
  onToggleGroupMenu(): void;
  onPickGroup(name: string): void;
  onSave(): void;
  onCancel(): void;
  onBack(): void;
}

const ENCodings = ['utf-8', 'gbk', 'big5'];

function fieldStack(label: string, control: El, key: string, wide = false): El {
  return h(
    'label',
    { key, className: wide ? 'field-stack field-wide' : 'field-stack' },
    label,
    control
  );
}

function renderGroupCombobox(t: Translate, props: FormViewProps): El {
  const filter = props.form.group.trim().toLowerCase();
  const suggestions = props.groups.filter(
    (group) => filter === '' || group.toLowerCase().includes(filter)
  );
  return h(
    'div',
    { className: 'group-combobox' },
    h('input', {
      name: 'group',
      value: props.form.group,
      autoComplete: 'off',
      role: 'combobox',
      'aria-expanded': props.groupMenuOpen,
      'aria-controls': 'serverGroupSuggestions',
      onChange: (event: { target?: { value?: unknown } }) =>
        props.onField('group', text(event?.target?.value)),
      onFocus: () => {
        if (!props.groupMenuOpen) props.onToggleGroupMenu();
      },
      'data-at-terminal-action': 'server-form-group'
    }),
    h(
      'button',
      {
        className: 'group-combobox-toggle',
        type: 'button',
        'aria-label': t('form.group'),
        'aria-expanded': props.groupMenuOpen,
        onClick: props.onToggleGroupMenu
      },
      // The icon set's chevron, not a letter: 'v' was drawn by whatever font the platform
      // picked, so its weight and bearing changed with the OS and it never lined up with the
      // disclosure glyphs elsewhere in the panel.
      chevronDownRegular({ size: 14 })
    ),
    h(
      'div',
      {
        id: 'serverGroupSuggestions',
        className: 'group-combobox-menu',
        hidden: !props.groupMenuOpen || suggestions.length === 0,
        role: 'listbox'
      },
      suggestions.map((group) =>
        h(
          'button',
          {
            key: group,
            className: 'group-combobox-option',
            type: 'button',
            role: 'option',
            'aria-selected': group === props.form.group,
            'data-group-option': group,
            onClick: () => props.onPickGroup(group)
          },
          group
        )
      )
    )
  );
}

function renderTrustBlock(t: Translate, props: FormViewProps): El {
  const trust: TrustLevel = props.form.agentCommandTrust;
  const trusted = trust !== 'none';
  return h(
    'div',
    { key: 'trust', className: 'trust-block field-wide' },
    h(
      'label',
      { className: 'trust-toggle-row', for: 'agentCommandTrust' },
      h(
        'span',
        { className: 'trust-toggle-copy' },
        h('span', { className: 'trust-toggle-title' }, t('form.trust'))
      ),
      h(
        'select',
        {
          id: 'agentCommandTrust',
          name: 'agentCommandTrust',
          value: trust,
          onChange: (event: { target?: { value?: unknown } }) =>
            props.onField('agentCommandTrust', text(event?.target?.value) || 'none'),
          'data-at-terminal-action': 'server-form-trust'
        },
        h('option', { value: 'none' }, t('form.trust.none')),
        h('option', { value: 'policy' }, t('form.trust.policy')),
        h('option', { value: 'full' }, t('form.trust.full'))
      )
    ),
    h('p', { id: 'agentCommandTrustHelp', className: 'field-help' }, t(trustHelpKey(trust))),
    h(
      'div',
      { className: 'trust-sub', id: 'backgroundConnectionSub', hidden: !trusted },
      h(
        'div',
        { className: 'trust-sub-inner' },
        h(
          'label',
          { className: 'trust-toggle-row', for: 'backgroundConnectionAllowed' },
          h(
            'span',
            { className: 'trust-toggle-copy' },
            h('span', { className: 'trust-toggle-title' }, t('form.background'))
          ),
          h('input', {
            id: 'backgroundConnectionAllowed',
            name: 'backgroundConnectionAllowed',
            type: 'checkbox',
            checked: trusted && props.form.backgroundConnectionAllowed,
            disabled: !trusted,
            // This is an enable/disable for a capability, not a selection among
            // items, so it is announced as a switch (on/off) rather than as a
            // checkbox. `aria-checked` is derived from the same expression as
            // `checked` — a disabled switch reads "off", matching what a click
            // would actually do.
            role: 'switch',
            'aria-checked': trusted && props.form.backgroundConnectionAllowed,
            onChange: (event: { target?: { checked?: unknown } }) =>
              props.onCheck('backgroundConnectionAllowed', event?.target?.checked === true),
            'data-at-terminal-action': 'server-form-background'
          })
        )
      )
    )
  );
}

function renderAuthCards(t: Translate, props: FormViewProps): El {
  const card = (value: string, titleKey: string, copyKey: string): El => {
    const selected = props.form.authType === value;
    return h(
      'button',
      {
        key: value,
        type: 'button',
        className: selected ? 'auth-card is-selected' : 'auth-card',
        'data-auth-option': value,
        role: 'radio',
        'aria-checked': selected,
        onClick: () => props.onAuthType(value),
        'data-at-terminal-action': `server-form-auth-${value}`
      },
      h('span', { className: 'auth-card-title' }, t(titleKey)),
      h('span', { className: 'auth-card-copy' }, t(copyKey))
    );
  };
  return h(
    'div',
    { className: 'auth-card-grid', role: 'radiogroup', 'aria-label': t('form.authType') },
    card('password', 'auth.password.title', 'auth.password.copy'),
    card('privateKey', 'auth.privateKey.title', 'auth.privateKey.copy'),
    card('agent', 'auth.agent.title', 'auth.agent.copy')
  );
}

export function renderFormView(props: FormViewProps): El {
  const { t, form, isNew } = props;
  const authClass =
    form.authType === 'privateKey'
      ? 'auth-private-key'
      : form.authType === 'agent'
        ? 'auth-agent'
        : 'auth-password';
  const summary = summarizeForm(t, form, props.servers);
  const saving = props.saveState.kind === 'pending';
  const jumpCandidates = props.servers.filter((server) => server.id !== form.id);

  return h(
    'div',
    { className: 'att-page', key: 'form' },
    h(
      'div',
      { className: 'att-toolbar' },
      h(
        'button',
        {
          type: 'button',
          className: 'att-btn',
          onClick: props.onBack,
          'data-at-terminal-action': 'form-back'
        },
        '← ',
        t('toolbar.back')
      ),
      h('div', { className: 'att-spacer' }),
      h('span', { className: 'att-chip' }, isNew ? t('form.new') : t('form.edit'))
    ),
    h(
      'div',
      { className: 'att-form-scroll' },
      h(
        'main',
        { className: 'server-form-shell' },
        h(
          'header',
          { className: 'form-header' },
          h(
            'div',
            null,
            h('h1', null, isNew ? t('form.new') : t('form.edit')),
            h('p', null, t('form.subtitle'))
          ),
          h('div', { className: 'form-status', id: 'form-status' }, t('form.manual'))
        ),
        h(
          'form',
          {
            className: `server-form ${authClass}`,
            id: 'server-form',
            'data-mode': isNew ? 'create' : 'edit',
            onSubmit: (event: { preventDefault(): void }) => {
              event.preventDefault();
              props.onSave();
            }
          },
          h(
            'div',
            { className: 'form-section-grid' },
            /* ---- left column: connection ---- */
            h(
              'section',
              { className: 'form-panel', key: 'connection' },
              h(
                'div',
                { className: 'form-panel-header' },
                h('h2', null, t('form.section.connection')),
                h('span', null, 'SSH')
              ),
              h(
                'div',
                { className: 'field-grid' },
                fieldStack(
                  t('form.label'),
                  h('input', {
                    name: 'label',
                    value: form.label,
                    required: true,
                    autoComplete: 'off',
                    onChange: (event: { target?: { value?: unknown } }) =>
                      props.onField('label', text(event?.target?.value)),
                    'data-at-terminal-action': 'server-form-label'
                  }),
                  'label'
                ),
                fieldStack(t('form.group'), renderGroupCombobox(t, props), 'group'),
                fieldStack(
                  t('form.host'),
                  h('input', {
                    name: 'host',
                    value: form.host,
                    required: true,
                    autoComplete: 'off',
                    onChange: (event: { target?: { value?: unknown } }) =>
                      props.onField('host', text(event?.target?.value)),
                    'data-at-terminal-action': 'server-form-host'
                  }),
                  'host',
                  true
                ),
                fieldStack(
                  t('form.port'),
                  h('input', {
                    name: 'port',
                    type: 'number',
                    min: 1,
                    max: 65535,
                    value: form.port,
                    required: true,
                    onChange: (event: { target?: { value?: unknown } }) =>
                      props.onField('port', text(event?.target?.value)),
                    'data-at-terminal-action': 'server-form-port'
                  }),
                  'port'
                ),
                fieldStack(
                  t('form.username'),
                  h('input', {
                    name: 'username',
                    value: form.username,
                    required: true,
                    autoComplete: 'off',
                    onChange: (event: { target?: { value?: unknown } }) =>
                      props.onField('username', text(event?.target?.value)),
                    'data-at-terminal-action': 'server-form-username'
                  }),
                  'username'
                ),
                fieldStack(
                  t('form.keepAlive'),
                  h('input', {
                    name: 'keepAliveInterval',
                    type: 'number',
                    min: 0,
                    value: form.keepAliveInterval,
                    required: true,
                    onChange: (event: { target?: { value?: unknown } }) =>
                      props.onField('keepAliveInterval', text(event?.target?.value)),
                    'data-at-terminal-action': 'server-form-keep-alive'
                  }),
                  'keepAlive'
                ),
                fieldStack(
                  t('form.encoding'),
                  h(
                    'select',
                    {
                      name: 'encoding',
                      value: form.encoding,
                      onChange: (event: { target?: { value?: unknown } }) =>
                        props.onField('encoding', text(event?.target?.value) || 'utf-8'),
                      'data-at-terminal-action': 'server-form-encoding'
                    },
                    ENCodings.map((encoding) => h('option', { key: encoding, value: encoding }, encoding))
                  ),
                  'encoding'
                ),
                renderTrustBlock(t, props)
              )
            ),
            /* ---- right column: auth, jump, summary ---- */
            h(
              'div',
              { className: 'form-right-col', key: 'right' },
              h(
                'section',
                { className: 'form-panel form-panel-auth' },
                h(
                  'div',
                  { className: 'form-panel-header' },
                  h('h2', null, t('form.section.auth')),
                  h('span', null, t('form.authType'))
                ),
                h('input', { id: 'authType', name: 'authType', type: 'hidden', value: form.authType }),
                renderAuthCards(t, props),
                h(
                  'div',
                  { className: 'auth-fields' },
                  h(
                    'label',
                    { className: 'field-stack auth-password-field' },
                    t('form.password'),
                    h(
                      'div',
                      { className: 'password-input-row' },
                      h('input', {
                        id: 'password',
                        name: 'password',
                        type: props.showPassword ? 'text' : 'password',
                        autoComplete: 'new-password',
                        value: form.password,
                        placeholder: isNew ? '' : t('form.passwordKeep'),
                        onChange: (event: { target?: { value?: unknown } }) =>
                          props.onField('password', text(event?.target?.value)),
                        'data-at-terminal-action': 'server-form-password'
                      }),
                      h(
                        'button',
                        {
                          id: 'passwordToggle',
                          className: 'secondary-action password-toggle',
                          type: 'button',
                          'aria-pressed': props.showPassword,
                          onClick: props.onTogglePassword
                        },
                        props.showPassword ? t('form.hide') : t('form.show')
                      )
                    ),
                    !isNew
                      ? h('p', { className: 'field-help' }, t('form.passwordKeep'))
                      : null
                  ),
                  h(
                    'label',
                    { className: 'field-stack auth-key-field' },
                    t('form.privateKeyPath'),
                    h(
                      'div',
                      { className: 'file-picker-row' },
                      h('input', {
                        id: 'privateKeyPath',
                        name: 'privateKeyPath',
                        value: form.privateKeyPath,
                        placeholder: t('form.privateKeyPlaceholder'),
                        onChange: (event: { target?: { value?: unknown } }) =>
                          props.onField('privateKeyPath', text(event?.target?.value)),
                        'data-at-terminal-action': 'server-form-private-key-path'
                      })
                    )
                  )
                )
              ),
              h(
                'section',
                { className: 'form-panel' },
                h(
                  'div',
                  { className: 'form-panel-header' },
                  h('h2', null, t('form.section.jump')),
                  h('span', null, 'SSH')
                ),
                h(
                  'div',
                  { className: 'field-grid' },
                  fieldStack(
                    t('form.jumpHost'),
                    h(
                      'select',
                      {
                        name: 'jumpHostId',
                        value: form.jumpHostId,
                        onChange: (event: { target?: { value?: unknown } }) =>
                          props.onField('jumpHostId', text(event?.target?.value)),
                        'data-at-terminal-action': 'server-form-jump-host'
                      },
                      h('option', { value: '' }, t('form.jumpHostNone')),
                      jumpCandidates.map((server) =>
                        h(
                          'option',
                          { key: server.id, value: server.id },
                          `${server.label} - ${server.username}@${server.host}:${server.port}`
                        )
                      )
                    ),
                    'jumpHost',
                    true
                  )
                )
              ),
              h(
                'section',
                { className: 'form-panel form-panel-summary' },
                h(
                  'div',
                  { className: 'form-panel-header' },
                  h('h2', null, t('form.section.summary')),
                  h('span', null, '')
                ),
                h('div', { className: 'summary-line', 'data-summary': 'target' }, summary.target),
                h('div', { className: 'summary-line', 'data-summary': 'auth' }, summary.auth),
                h('div', { className: 'summary-line', 'data-summary': 'group' }, summary.group),
                h('div', { className: 'summary-line', 'data-summary': 'route' }, summary.route),
                h('div', { className: 'summary-line', 'data-summary': 'agentCommands' }, summary.agent)
              )
            )
          ),
          h(
            'footer',
            { className: 'form-footer' },
            h(
              'div',
              { className: 'form-feedback' },
              h(
                'div',
                {
                  id: 'form-error',
                  className: 'form-error',
                  role: 'status',
                  'aria-live': 'polite',
                  'data-at-terminal-validation': props.formError?.field ?? ''
                },
                props.formError?.message ?? ''
              ),
              props.saveState.kind === 'failed'
                ? h(
                    'div',
                    { className: 'form-error', 'data-at-terminal-error': props.saveState.code },
                    `${t('error.title')} — ${t('error.detail', {
                      code: props.saveState.code,
                      message: props.saveState.message
                    })}`
                  )
                : null,
              props.saveState.kind === 'ok'
                ? h(
                    'div',
                    { className: 'test-status is-success', 'data-at-terminal-save': 'ok' },
                    t('form.saved', { label: props.saveState.label })
                  )
                : null
            ),
            h(
              'div',
              { className: 'form-actions' },
              h(
                'button',
                {
                  className: 'secondary-action',
                  type: 'button',
                  disabled: saving,
                  onClick: props.onCancel,
                  'data-at-terminal-action': 'server-form-cancel'
                },
                t('form.cancel')
              ),
              h(
                'button',
                {
                  id: 'submitButton',
                  className: saving ? 'primary-action is-loading' : 'primary-action',
                  type: 'submit',
                  disabled: saving,
                  'data-at-terminal-action': 'server-form-submit'
                },
                h('span', { className: 'submit-spinner', id: 'submitSpinner', 'aria-hidden': true }),
                h('span', { id: 'submitLabel' }, saving ? t('form.saving') : t('form.save'))
              )
            )
          )
        )
      )
    )
  );
}