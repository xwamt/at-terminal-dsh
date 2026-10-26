/**
 * Style injection for the dsh Client half.
 *
 * The panel reuses the VS Code variant's stylesheets — `webview/terminal/index.css`
 * and `webview/server-form/index.css`, plus `xterm.css` — because the point of the
 * dsh variant is to look like the plugin users already know, not to invent a second
 * design. Those sheets were written for a webview **document**: they style `html`
 * and `body`, and they read `--vscode-*` theme variables. Injected verbatim into
 * the Harness page they would restyle the whole app and render unthemed.
 *
 * Two transformations make them panel-local, both at build time from the same
 * source files (no copied CSS to drift):
 *
 * 1. `scopeCss` rewrites every top-level selector under `.att-root` — the panel's
 *    own root element — mapping `html`/`body`/`:root` onto it, recursing through
 *    `@media`/`@supports` and leaving `@keyframes` global (their names are).
 * 2. A token bridge maps the `--vscode-*` variables those sheets read onto the
 *    Harness theme tokens (`--dsw-alias-*`), with no literal fallbacks: a
 *    fallback cannot follow the light/dark switch, so a renamed host token
 *    would leave light mode with a dark value. A missing token is left to
 *    show. The bridge lives on `.att-root`, and the xterm theme reader reads
 *    computed styles from that same element, so `applyTerminalTheme` picks the
 *    mapping up unchanged.
 *
 * The layout sheet (`.att-*`) is the only hand-written CSS here: page chrome the
 * VS Code variant got from the workbench itself — toolbar, nav, list rows,
 * context menu, dialogs, status bar.
 */

import xtermCss from '@xterm/xterm/css/xterm.css';

import serverFormCss from '../../../../webview/server-form/index.css';
import terminalCss from '../../../../webview/terminal/index.css';

export const ROOT_SELECTOR = '.att-root';
export const STYLE_ELEMENT_ID = 'at-terminal-client-styles';

/**
 * Rewrite a stylesheet's selectors to live under `root`.
 *
 * Deliberately a small string walk rather than a CSS parser: the inputs are two
 * known, flat stylesheets (no nesting, no selector commas inside attribute
 * values), and the transformation is asserted by unit tests on their real
 * content. Anything it does not understand is passed through prefixed, which
 * fails visible (a rule that matches nothing) rather than invisible.
 */
export function scopeCss(css: string, root: string): string {
  // Comments are stripped first: a `{` inside a comment would desync the walk.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let index = 0;

  while (index < source.length) {
    const brace = source.indexOf('{', index);
    if (brace === -1) break;
    const prelude = source.slice(index, brace).trim();
    const end = matchBlock(source, brace);
    if (end === -1) break; // unbalanced input: stop rather than emit garbage
    const body = source.slice(brace + 1, end);

    if (prelude.startsWith('@')) {
      if (/^@(media|supports|container|layer)\b/.test(prelude)) {
        out += `${prelude}{${scopeCss(body, root)}}`;
      } else {
        // @keyframes / @font-face: the block is not a selector list.
        out += `${prelude}{${body}}`;
      }
    } else if (prelude !== '') {
      out += `${scopeSelectors(prelude, root)}{${body}}`;
    }
    index = end + 1;
  }
  return out;
}

/** Index of the `}` closing the block that opens at `open`, or -1. */
function matchBlock(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scopeSelectors(prelude: string, root: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of prelude.split(',')) {
    const selector = raw.trim();
    if (selector === '') continue;
    let scoped: string;
    if (selector === 'html' || selector === 'body' || selector === ':root') {
      scoped = root;
    } else if (selector.startsWith('body')) {
      // `body.auth-x` → `.att-root.auth-x`: the variant's body-level state class
      // is carried by the panel's own root here.
      scoped = root + selector.slice('body'.length);
    } else if (selector.startsWith('html')) {
      scoped = root + selector.slice('html'.length);
    } else {
      scoped = `${root} ${selector}`;
    }
    if (!seen.has(scoped)) {
      seen.add(scoped);
      parts.push(scoped);
    }
  }
  return parts.join(',');
}

/**
 * The `--vscode-*` -> `--dsw-alias-*` bridge: an explicit design mapping, every
 * entry naming the official token it stands for and what it is for.
 *
 * Two groups, kept apart on purpose:
 *
 * 1. The variables the two reused sheets actually read, plus what this file's
 *    own layout sheet reads (audited with `grep -o 'var(--vscode-[a-zA-Z-]*'`
 *    over `webview/terminal/index.css` and `webview/server-form/index.css`;
 *    the two sets coincide, which is why the count is one number). This group
 *    is load-bearing -- a rename here is a rename in the reused CSS.
 * 2. Reserved entries. Nothing reads these yet; they are here so the mapping
 *    reads as a design system rather than as a punch list, and so the token
 *    that will eventually drive them is decided now, while its light and dark
 *    values are both known. Each one is marked RESERVED. They cost nothing: an
 *    unread custom property on the panel root resolves to nothing and is never
 *    computed.
 *
 * No `var(--token, fallback)` pairs on purpose. A literal fallback cannot follow
 * the light/dark switch, and every dark value that was here before made light
 * mode unreadable the moment a token was renamed. The Harness text is explicit
 * that the token stylesheet is the only authority for a color and that a
 * missing value is deliberately *not* back-filled: if a token disappears, the
 * declaration becomes invalid at computed-value time and the property is
 * visibly wrong, which is the signal we want. A silent dark fallback is the
 * opposite signal. `verify:dsh` check 9 enforces this.
 *
 * `--vscode-button-foreground` reads `--dsw-alias-label-primary-foreground` rather
 * than a literal. It was `#ffffff` on the claim that the token set has no
 * "on-brand" color and that white reads on the brand accent in both themes. Both
 * halves of that were wrong. The token exists — the official Button's `.primary`
 * pairs it with `button-primary-fill` — and `--dsw-alias-brand-primary` is not a
 * fixed dark blue: it is `neutral-bluish-1000` (near black) in light and
 * `neutral-bluish-50` (near white) in dark. A white literal therefore put white
 * text on a near-white fill under the dark theme, 1.05:1, on every button
 * including the selected tab. `label-primary-foreground` tracks the inverse of
 * its own theme's fill: 18.90:1 in light, 18.08:1 in dark.
 *
 * Note the failure was invisible in light mode, which is why it survived four
 * rounds of light-theme review: near-black background with white text is correct
 * there. A theme defect has to be checked in *both* palettes, not the one that
 * looks familiar.
 *
 * One literal remains, and it is not a theme decision: `transparent` is the
 * absence of a color. The `#ffffff` inside `--vscode-button-hoverBackground` is
 * an interpolation target rather than a whole value — it means "tint toward
 * white", which is what a hover should do on a dark fill. In dark mode that fill
 * is near white already, so the tint is subtle there; it follows the theme
 * because the token it mixes with does.
 *
 * NOTE (quoted, not backticked): this whole bridge is a template literal, so a
 * backtick in a comment below would end the string and the CSS after it would
 * be parsed as TypeScript. The same goes for `${`.
 */
const TOKEN_BRIDGE = `
${ROOT_SELECTOR} {
  /* ---- Type. The host's own UI font, named through its token so a user who set a family sees
     it here too. It used to be a hand-written stack ending in a generic sans-serif fallback, which
     meant the panel disagreed with every other pane the moment the host font was not the platform
     default. A font is not a colour decision, which is why check 9 exempts this one by name; the
     token is still a --dsw-* reference, so the gate is satisfied without needing the exemption. */
  --vscode-font-family: var(--dsw-font-family);

  /* ---- Text. label-primary is the body tier and label-secondary the
     de-emphasized one (hints, field labels, addresses, status bar). The two
     tiers below them are reserved: no rule asks for them yet. */
  --vscode-foreground: var(--dsw-alias-label-primary);
  --vscode-descriptionForeground: var(--dsw-alias-label-secondary);
  --vscode-input-foreground: var(--dsw-alias-label-primary);
  --vscode-dropdown-foreground: var(--dsw-alias-label-primary);
  --vscode-list-hoverForeground: var(--dsw-alias-label-primary);
  --vscode-list-activeSelectionForeground: var(--dsw-alias-label-primary);
  --vscode-button-secondaryForeground: var(--dsw-alias-label-primary);
  /* RESERVED: placeholder copy in an empty field. The 'label-caption' token
     measures 2.13:1 against the light 'bg-base', which is unreadable — so this is reserved
     with the warning attached. Nothing reads it yet; if a placeholder ever ships,
     pair it with a darkened fill or a stronger token rather than accepting the
     caption weight. */
  --vscode-input-placeholderForeground: var(--dsw-alias-label-caption);
  /* RESERVED: a control the user cannot act on. Today the disabled button
     reaches for opacity instead, which fades its border too. 'label-dimmed'
     measures 1.26:1 against the light 'bg-base' — the same warning applies: a
     disabled control still has to be findable. */
  --vscode-disabledForeground: var(--dsw-alias-label-dimmed);

  /* ---- Surfaces, darkest well to most raised. bg-base is the floor (the
     terminal, the text fields); bg-layer-1 is the page chrome that sits on it;
     bg-layer-2 is a step above the page, for anything that floats. */
  --vscode-terminal-background: var(--dsw-alias-bg-base);
  --vscode-input-background: var(--dsw-alias-bg-base);
  --vscode-editor-background: var(--dsw-alias-bg-layer-1);
  --vscode-sideBar-background: var(--dsw-alias-bg-layer-1);
  --vscode-editorGroupHeader-tabsBackground: var(--dsw-alias-bg-layer-1);
  --vscode-dropdown-background: var(--dsw-alias-bg-layer-2);
  --vscode-badge-background: var(--dsw-alias-bg-layer-2);
  --vscode-button-secondaryBackground: var(--dsw-alias-bg-layer-2);
  /* RESERVED: the placeholder blocks a loading list would show per row. */
  --vscode-skeleton-background: var(--dsw-alias-bg-skeleton);

  /* ---- Borders, as a four-step ladder the panel can spend without inventing
     a shade. l1 is the hairline between regions (toolbar, status bar, menu,
     dialog). l2 is one step heavier, because the edge of a control has to read
     as a control and not as a divider. l3 and l4 are the two steps above that,
     reserved. */
  --vscode-panel-border: var(--dsw-alias-border-l1);
  --vscode-input-border: var(--dsw-alias-border-l2);
  --vscode-dropdown-border: var(--dsw-alias-border-l2);
  /* RESERVED: the active tab's underline, which must outrank the strip it
     sits in or it disappears into it. */
  --vscode-editorGroupHeader-tabsBorder: var(--dsw-alias-border-l3);
  /* RESERVED: the outer edge of a floating surface, one step above l3 so a
     dialog separates from the page it covers. */
  --vscode-widget-border: var(--dsw-alias-border-l4);

  /* ---- The brand-filled button. Foreground is tracked rather than literal: the brand fill is
     near-black in light and near-white in dark, so only an inverted token can read on it in both.
     Hover is that same fill tinted toward its own opposite, which is what makes a hover lighten in
     both themes instead of only in the dark one. */
  --vscode-button-background: var(--dsw-alias-brand-primary);
  --vscode-button-foreground: var(--dsw-alias-label-primary-foreground);
  --vscode-button-hoverBackground: color-mix(in srgb, var(--dsw-alias-brand-primary) 82%, #ffffff);
  --vscode-button-secondaryHoverBackground: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, var(--dsw-alias-label-primary));
  /*
   * The focus ring is the **business blue**, not the brand accent.
   *
   * The brand is near-black in light and near-white in dark, so a focus ring drawn in it is a
   * one-pixel shade change on exactly the surfaces it has to be findable on, and it is invisible
   * against a primary button — which is brand-filled. state-business-primary is the token the
   * host paints its own focus rings with, and it is legible against both.
   */
  --vscode-focusBorder: var(--dsw-alias-state-business-primary);
  --vscode-progressBar-background: var(--dsw-alias-brand-primary);

  /* ---- Interactive states. Hover is the official hover token rather than a
     hand-mixed tint: it is exactly this question answered once, for the whole
     product, in both themes. Selection used to be a 32% brand mix; it is now the host's own
     'selected row' overlay, because a brand-tinted row in a list reads as a warning or a badge
     rather than as "this one is selected", and because a brand-selected row is hard to
     distinguish from a brand-filled button in the same column. */
  --vscode-list-hoverBackground: var(--dsw-alias-interactive-bg-hover);
  --vscode-toolbar-hoverBackground: var(--dsw-alias-interactive-bg-hover);
  --vscode-list-activeSelectionBackground: var(--dsw-alias-interactive-bg-active);
  /* RESERVED: hover landing on an already-selected row, so the pointer
     acknowledges a row that is both hovered and chosen. */
  --vscode-list-activeSelectionHoverBackground: var(--dsw-alias-interactive-bg-hover-accent);
  /* RESERVED: a tool button held down. */
  --vscode-toolbar-activeBackground: var(--dsw-alias-interactive-bg-active);

  /* ---- Status. One colour per state, named for the state; the reused sheets
     and the xterm theme reader both resolve these through the same bridge. */
  --vscode-errorForeground: var(--dsw-alias-state-error-primary);
  --vscode-testing-iconFailed: var(--dsw-alias-state-error-primary);
  --vscode-testing-iconPassed: var(--dsw-alias-state-success-primary);
  --vscode-terminal-ansiGreen: var(--dsw-alias-state-success-primary);
  --vscode-charts-yellow: var(--dsw-alias-state-warn-primary);

  /* ---- RESERVED, remaining. A toast, and the thumb of a two-state switch
     (the trust-host and sudo-fallback toggles in the server form). */
  --vscode-notifications-background: var(--dsw-alias-toast-bg);
  --vscode-toggleSwitch-thumbBackground: var(--dsw-alias-switch-thumb);
}
`;

/**
 * Page chrome the workbench used to provide: toolbar, segmented nav, list rows,
 * context menu, dialogs and the status bar. Colours come exclusively from the
 * bridge above, so this sheet has no theme opinions of its own.
 */
const LAYOUT_CSS = `
${ROOT_SELECTOR} {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  box-sizing: border-box;
  padding: 0;
  margin: 0;
  /*
   * The sidebar surface, not the editor's.
   *
   * This panel lives *in* the right column, so the honest background is the column's own fill
   * (--dsw-specific-sidebar-fill) rather than a page colour one step lighter: with bg-layer-1 the
   * panel read as a card laid over the column, with a visible seam at both edges and one more
   * shade than the host's own panes.
   *
   * 'transparent' was the other candidate the plan named, and it is deliberately NOT used. It
   * looks identical when docked and is wrong in the two other carriers this panel supports: a
   * floated tab and the full-screen right bar both put the panel over a *different* surface, so
   * an inherited background would show whatever happens to be behind it. An opaque token cannot
   * be wrong in any of the three.
   */
  background: var(--dsw-specific-sidebar-fill);
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  /*
   * The host's secondary content size. Named through the token so a user who changed the
   * Harness font size gets a panel that matches instead of a 13px island.
   */
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}
${ROOT_SELECTOR} *, ${ROOT_SELECTOR} *::before, ${ROOT_SELECTOR} *::after { box-sizing: border-box; }
/*
 * The per-page query container.
 *
 * 'inline-size' and not 'size': the panel's height is whatever the host gives it,
 * and the only dimension a user resizes by dragging is the width, so pinning the
 * height as well would make the container report a box the page does not have.
 *
 * On the PAGE and not on the panel root, which is the load-bearing choice here.
 * Layout containment -- which 'container-type' implies -- makes the element a
 * containing block for positioned descendants, and the root has two descendants
 * that must NOT be re-anchored: the context menu is 'position: fixed' with
 * left/top computed from viewport coordinates (and clamped against
 * window.innerWidth), and the dialog overlay is 'position: absolute; inset: 0'
 * covering the whole panel. Both are siblings of the pages, so neither is inside
 * this container, and both keep the containing block they have today. Promoting
 * the root to a container would move the menu by the panel's own offset and
 * visibly displace the overlay.
 *
 * Nothing in the reused sheets breaks under it either: the two absolutely
 * positioned rules in there (.xterm at inset 0, and the server form's combobox
 * menu) each sit inside their own 'position: relative' parent, which stays the
 * nearest positioned ancestor, so containment above them changes nothing they
 * can observe.
 */
/*
 * The panel's own header and footer.
 *
 * 38px is the host's pane-header height, and it is a consequence rather than a number: a 28px
 * control plus 5px above and below. Both bars are transparent on purpose — the root already
 * carries the surface, and repeating it here made three visible bands out of one panel.
 *
 * The hairline is .5px at border-l3 rather than 1px at l1: a full CSS pixel is twice the weight
 * of the separator the host draws between its own regions, and l1 is the divider step, not the
 * one that separates a region from its body.
 */
.att-page {
  display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0;
  container: att-panel / inline-size;
}
.att-page[hidden] { display: none; }
.att-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  min-height: 38px;
  padding: 5px 10px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  background: transparent;
}
.att-nav {
  display: flex; align-items: center; gap: 2px; padding: 2px;
  height: 32px;
  border-radius: var(--dsw-radius-md);
  background: var(--vscode-input-background);
}
/*
 * The file-action bar, which appears only while a file is selected.
 *
 * A second row rather than a floating popover: the tree below it must not be covered, and a bar
 * that pushes the list down by 34px is a change the user caused and can undo by clicking elsewhere.
 * The name sits on the left so the bar answers "which file" before offering what to do with it.
 */
.att-contextbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  min-height: 34px;
  padding: 3px 10px;
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
}
.att-contextbar-name {
  min-width: 0; max-width: 45%;
  font-size: 12px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.att-nav-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 10px;
  border: none; background: transparent; color: var(--vscode-descriptionForeground);
  border-radius: var(--dsw-radius-sm);
  cursor: pointer; font: inherit; font-size: 12px;
}
.att-nav-btn:hover:not([aria-selected="true"]):not(:disabled) { background: var(--vscode-list-hoverBackground); }
/*
 * The selected segment is a **neutral** raise, not the brand accent.
 *
 * A brand-filled chip in a three-item switch claims the same visual weight as the primary
 * action beside it, so a 资产/文件 switch and a 保存 looked equally important. The host reserves
 * the accent fill for actions and marks a selected item with a 10% neutral overlay; matching
 * that is what makes the switch read as navigation.
 */
.att-nav-btn[aria-selected="true"] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--vscode-list-activeSelectionForeground);
  font-weight: 500;
}
.att-spacer { flex: 1 1 auto; }
/*
 * Buttons are 28px / 8px / 0 10px — the host's Button sm, measured (see the plan's appendix).
 * The old 24px / 4px control was a webview control: it reads as a desktop-dense widget next to
 * a sidebar whose own rows are 13px type with 12px corners.
 */
.att-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 10px;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border-radius: var(--dsw-radius-sm);
  cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap;
}
.att-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.att-btn:disabled { opacity: 0.5; cursor: default; }
.att-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.att-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.att-btn.danger { color: var(--vscode-errorForeground); }
/*
 * An icon-only button: same 28px box, no horizontal padding, and a square hit area.
 *
 * The width is stated rather than derived from the glyph, because an SVG icon and a text glyph
 * have different intrinsic widths and a toolbar that shifts by a pixel per icon looks broken.
 */
.att-icon-btn { width: 28px; padding: 0; }
/* Icons inherit the label colour, so a disabled or danger button colours them for free. */
.att-icon { display: block; width: 16px; height: 16px; flex: none; }
.att-content {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: 8px 0 8px 8px;
  /* Reserve the scrollbar's width even when the list is short, so switching between a long
     and a short list does not shift every row sideways by 8px. */
  scrollbar-gutter: stable;
}
/*
 * The group header is a real <button> now (it was a div with aria-expanded and no role), so the
 * rule that draws it also has to undo the native control: the platform's border, background and
 * centred text would otherwise reappear under a label that is meant to read as a heading.
 */
.att-group-name {
  display: flex; align-items: center; gap: 6px;
  width: 100%;
  height: 28px; padding: 0 8px;
  appearance: none; -webkit-appearance: none;
  background: transparent; border: none; text-align: left;
  font: inherit;
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
  border-radius: var(--dsw-radius-sm);
  cursor: pointer; user-select: none;
}
/* The wrapper carries no chrome of its own — it exists to name the group for assistive tech, and
   its children lay out exactly as they did when the header and rows were siblings. */
.att-group { display: block; min-width: 0; }
.att-group-name:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}
.att-group-disclosure {
  display: inline-flex; align-items: center; justify-content: center;
  width: 12px; height: 12px; flex: none; opacity: 0.8;
}
.att-group-count {
  margin-left: auto;
  font-size: 11px; font-weight: normal; opacity: 0.7;
}
/*
 * A list row: the host's list geometry — 12px corners, 5px 10px padding.
 *
 * The radius is what separates "a row in a list" from "a table cell": the host's own file list
 * rounds every row, and a square row beside a rounded one reads as two different controls.
 */
.att-row {
  display: flex; align-items: center; gap: 8px;
  /*
   * The right padding is the actions' seat, reserved unconditionally.
   *
   * They used to be absolutely positioned over the row with only a gradient behind them, which
   * looked fine over the flexible address and then **covered the 已存口令 badge** — the badges are
   * flex:0 0 auto at the end of the row, so they sit exactly where the buttons land. Reserving
   * 58px costs the address some width and costs nothing else: it already truncates.
   */
  padding: 5px 58px 5px 10px;
  border-radius: var(--dsw-radius-md);
  user-select: none;
  /* The anchor for .att-row-actions, which is taken out of the flow so it can appear on hover
     without the address column re-wrapping every time the pointer crosses a row. */
  position: relative;
}
.att-row:hover { background: var(--vscode-list-hoverBackground); }
/*
 * Selection carries a marker, not just a fill.
 *
 * The selected fill and the hover fill are two greys from the same family (interactive-bg-active
 * vs interactive-bg-hover), close enough that a selected row under a resting pointer and a
 * hovered row look the same. That ambiguity cost a walkthrough round: a row with the pointer on
 * it was read as "still selected" while the real selection had moved, and it became a bug report
 * about keyboard navigation that the state never had. A 2px inset bar is a claim hover cannot
 * make, so "which row is selected" no longer depends on comparing two shades.
 */
.att-row[aria-selected="true"] {
  background: var(--vscode-list-activeSelectionBackground);
  box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
}
/* flex: 0 0 auto is the part that matters: without it the label is a shrinkable flex item,
   and at 385px the address plus two badges squeezed it to about fifty pixels — the row read
   「99....」. A ceiling on its width still applies, so a long label cannot eat the address. */
.att-row-label { flex: 0 0 auto; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 32%; }
.att-row-addr {
  flex: 1 1 auto; min-width: 0;
  color: var(--vscode-descriptionForeground);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.att-row[aria-selected="true"] .att-row-addr { color: inherit; }
/*
 * The row's hover/focus actions: 连接 and the menu.
 *
 * Out of the flow, inside the 58px the row reserves for them (see .att-row). No backdrop any
 * more: the first version faded a gradient behind the buttons, which only works while whatever is
 * underneath is the plain row — over a badge it did nothing, and the buttons sat on top of it.
 *
 * opacity and not display: the buttons stay in the accessibility tree and in the tab order,
 * which is what makes the '⋯' reachable by keyboard at all. :focus-within is what reveals them
 * for that keyboard user — without it, tabbing into an invisible button would land on nothing.
 */
.att-row-actions {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; gap: 2px;
  opacity: 0;
  pointer-events: none;
}
.att-row:hover .att-row-actions,
.att-row:focus-within .att-row-actions,
.att-row[aria-selected="true"] .att-row-actions {
  opacity: 1;
  pointer-events: auto;
}
.att-row-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0;
  border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--vscode-foreground);
  cursor: pointer;
}
.att-row-action:hover { background: var(--dsw-alias-interactive-bg-hover); }
.att-row-action:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--vscode-focusBorder); }
.att-badge {
  flex: 0 0 auto; font-size: 11px; padding: 0 7px; border-radius: 999px;
  background: var(--vscode-badge-background); border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-foreground);
}
.att-hint { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 6px; }
/*
 * The list filter.
 *
 * A type="search" input, so the browser supplies the clear button and Escape for free. It takes
 * the free width up to 240px: narrower than that and the toolbar still wraps at 380, wider and it
 * starts competing with the 新增 button for the row.
 */
.att-search {
  flex: 1 1 120px; min-width: 88px; max-width: 240px;
  height: 28px; padding: 0 8px;
  font: inherit; font-size: 12px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--dsw-radius-sm);
}
.att-search::placeholder { color: var(--vscode-descriptionForeground); }
.att-search:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
/*
 * The empty / no-match state: an answer, not a sentence.
 *
 * Centred in the space the list would have occupied, so the eye lands on it instead of on the
 * toolbar above. padding rather than height: 100% because the parent is a scroll container
 * whose content height is what it is; the block simply sits at the top with breathing room.
 */
.att-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 40px 16px 32px;
  text-align: center;
}
.att-empty-icon { color: var(--vscode-descriptionForeground); opacity: 0.55; }
.att-empty-title { font-size: 13px; font-weight: 600; color: var(--vscode-foreground); }
.att-empty-text {
  font-size: 12px; line-height: 1.6; max-width: 30ch;
  color: var(--vscode-descriptionForeground);
}
.att-empty-actions { display: flex; gap: 8px; margin-top: 6px; }
.att-empty-hint {
  margin-top: 10px; font-size: 11px; line-height: 1.6; max-width: 34ch;
  color: var(--vscode-descriptionForeground); opacity: 0.8;
}
.att-statusbar {
  display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
  min-height: 28px;
  padding: 4px 10px;
  border-top: .5px solid var(--dsw-alias-border-l3);
  background: transparent;
  color: var(--vscode-descriptionForeground); font-size: 11px;
}
/*
 * The status bar's path, shaped like the official PathLabel: dimmed directory,
 * primary-coloured last segment, and on overflow the tail is what survives.
 *
 * Keeping the tail is the whole problem, and text-overflow cannot do it. 'ellipsis'
 * cuts the END of the line, which for a path throws away the part that says where
 * you are (/root, /home/user) and keeps the part the filename already states. The
 * tail survives only if the content is pushed against the right edge, so that the
 * overflow falls off the LEFT where overflow:hidden clips it. 'justify-content:
 * flex-end' on a nowrap flex row is what does that. The 'direction: rtl' trick
 * reaches the same result and is deliberately not used: it flips bidi resolution
 * for the whole run, so a CJK (or Arabic) directory name in the path would lay out
 * backwards. Plain 'flex-end' rather than the 'safe' variant on purpose — safe
 * alignment silently falls back to flex-start exactly when the content overflows,
 * which is the one case this rule exists for.
 *
 * The head is then faded with a mask rather than with a colour that fades toward the
 * background, because a background-coloured fade is only correct while whatever sits
 * behind the label happens to be exactly that colour — and this bar is one
 * declaration away from not being (a translucent panel, a future tint on the row).
 * Fading to fully transparent is also the honest signal: those glyphs are not in the
 * visible window, which is the only thing 'there is more to the left' can mean. What
 * it costs is that they are no longer painted while staying selectable and staying in
 * the accessibility tree — right here, because the DOM keeps the full path for the
 * tooltip and for copy.
 *
 * The ramp ends on 'currentColor' because a mask reads only the alpha channel and
 * throws the colour away, so naming a colour here would be a theme decision with no
 * visible effect while adding a literal this sheet does not otherwise carry; it says
 * 'opaque as painted' instead, the same trade the spinner ring already makes. It
 * inherits one assumption from that: the colour in effect must be fully opaque, or
 * the ramp's far end lands short of opaque and dims the whole label. The bridge
 * guarantees that here — the status bar's own colour resolves to label-secondary.
 *
 * The attribute hook is not decoration: CSS cannot tell an overflowing line from a
 * short one, so an unconditional ramp would also fade the left edge of a path that
 * fits and is entirely visible — the one case that must look untouched. Whoever owns
 * the DOM sets data-at-terminal-path-truncated='true' while the segments are wider
 * than the box and removes it when they are not, re-checking on resize and on every
 * path change. 'scrollWidth' is NOT that test: overflow past the START edge is not
 * scrollable overflow in LTR, so it can report equal to clientWidth while the text is
 * visibly clipped. Sum the segments' offsetWidth and compare with clientWidth.
 *
 * 'title' belongs on this element carrying the whole path, and on no segment: a
 * title on a segment the clip has cut in half would report half a path. Neither
 * overflow nor mask suppresses native tooltips, so nothing has to move for hover to
 * reveal the full value.
 *
 * (Quoted, not backticked, and no dollar-brace: this whole sheet is a template
 * literal, so either would end the string and the CSS after it would be parsed as
 * TypeScript.)
 */
.att-dir {
  display: flex;
  /* Basis auto with shrink: the label takes the room it needs and gives the rest
     back to the row. The old fixed max-width both wasted the row on a short path
     and forced a long one to wrap early; here the status bar's own flex-wrap is
     the only line-breaking rule, and a path that ends up alone on a line gets the
     whole width and shows in full. */
  flex: 0 1 auto;
  min-width: 0;
  justify-content: flex-start;
  overflow: hidden;
  white-space: nowrap;
}
/* Natural width, never shrunk: a segment that could be squeezed would stop the row
   from overflowing at all, and the clip — and therefore the fade — would land in the
   wrong place. A raw text node (a label with no path in it) is an anonymous flex item
   and is floored by its own min-content width, so it needs no rule here. */
.att-dir > * { flex: 0 0 auto; }
.att-dir-base { color: var(--vscode-descriptionForeground); }
.att-dir-leaf { color: var(--vscode-foreground); }
.att-dir[data-at-terminal-path-truncated="true"] {
  justify-content: flex-end;
  /* A share of the box, bounded at both ends: a fixed ramp width swallows half the
     label once the panel is narrow, and a pure share fades a long path away almost
     entirely. The prefixed twin is deliberate: mask-image only lost its prefix in
     Chromium 120, and where it is still prefixed the whole fade silently drops,
     leaving a hard clip with no left-hand ramp — the label would look broken rather
     than truncated. Last declaration wins and the two are identical, so a current
     host is unaffected. */
  -webkit-mask-image: linear-gradient(to right, transparent 0, currentColor clamp(16px, 30%, 36px));
  mask-image: linear-gradient(to right, transparent 0, currentColor clamp(16px, 30%, 36px));
}
.att-menu {
  position: fixed; z-index: 1000; min-width: 156px; padding: 4px;
  /*
   * The scrollbar thumb, re-bound one step up from the l1 the panel inherits.
   *
   * These are not this sheet's variables: the Harness theme defines
   * --dsh-scrollbar-thumb / -thumb-hover on body and paints every scrollbar from
   * them, so the panel would otherwise draw its menu's thumb in the same l1 grey
   * as the page behind it. The host's own high-level surfaces (its menu surface,
   * modal media pane, dock pane body) re-bind exactly this pair to l2 on their own
   * container, and that is the convention being followed here rather than a local
   * preference: the higher a surface sits, the more its edge has to separate from
   * whatever it covers, and a menu floating over text needs a visibly stronger
   * thumb than the page it floats on. l2 is the step the token set already has,
   * so this costs no opinion of its own.
   *
   * The thumb-border and track-margin pair the host sets on body are deliberately
   * NOT repeated: they are 0px there to sit the thumb flush in a borderless
   * surface, which is exactly what this menu is (see its 1px border). The width
   * is left alone too -- it is the host's, and the point of this rule is the
   * colour step, not a second scrollbar design.
   */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  /* The overlay surface, not the dropdown's: a menu drawn in the page colour reads as part of
     the page it is covering, which is the one thing a menu must not look like. */
  background: var(--dsw-alias-bg-overlay); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-panel-border); border-radius: var(--dsw-radius-md);
  box-shadow: var(--dsw-shadow-lv2);
}
.att-menu-item {
  display: flex; align-items: center;
  width: 100%; height: 28px; text-align: left;
  border: none; background: transparent; color: inherit;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer; font: inherit; font-size: 12px;
}
.att-menu-item:hover, .att-menu-item:focus-visible { background: var(--vscode-list-hoverBackground); }
.att-menu-item.danger { color: var(--vscode-errorForeground); }
.att-overlay {
  position: absolute; inset: 0; z-index: 900;
  background: var(--dsw-alias-bg-mask-1);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 36px 16px; overflow: auto;
}
.att-dialog {
  width: min(520px, 100%);
  display: flex; flex-direction: column; gap: 12px;
  padding: 16px 18px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--vscode-panel-border); border-radius: var(--dsw-radius-lg);
  box-shadow: var(--dsw-shadow-lv3);
}
.att-dialog-title { margin: 0; font-size: 14px; font-weight: 650; }
/* The confirm box's one sentence. Body size, secondary weight: it explains a decision the title
   has already named, so it must not compete with it. */
.att-dialog-message { margin: 0; font-size: 12px; line-height: 1.6; color: var(--vscode-descriptionForeground); }
.att-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.att-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.att-field input[type="text"], .att-field input[type="password"], .att-field select {
  height: 28px; padding: 0 8px; font: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border); border-radius: var(--dsw-radius-sm);
}
/*
 * Focus is a **ring**, and only for keyboard focus.
 *
 * ':focus' painted an outline on every mouse click into a text field, which is the visual noise
 * the host does not have; ':focus-visible' is the browser's own answer to "was this focus worth
 * announcing". The ring is the theme's width token rather than a hand-picked 1px, so it matches
 * the host's own focus treatment at any zoom.
 */
.att-field input:focus-visible,
.att-field select:focus-visible,
.att-file-editor:focus-visible,
.att-file-text:focus-visible,
.att-upload:focus-within {
  outline: var(--dsw-focus-ring-width) solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.att-check { display: flex; align-items: center; gap: 7px; font-size: 12px; }
/*
 * A failure banner: the state is carried by the **frame**, the words are carried by plain text.
 *
 * It used to paint the whole banner in --vscode-errorForeground, which measured 4.4976:1 on the
 * light theme's panel fill — under the 4.5 floor, and under it *on the one surface a user has to
 * read to understand what went wrong*. Red body copy is also the harder-to-read option at 12px.
 *
 * So the error colour moves to where it costs nothing to read: a 3px left edge and the 1px frame.
 * The heading keeps the weight, the copy keeps label-primary, and nothing in the banner is
 * below the contrast floor in either theme. Colour-blind users lose nothing: the heading says
 * 操作失败 / Operation failed in words.
 */
.att-banner {
  display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--vscode-errorForeground);
  border-left-width: 3px;
  border-radius: var(--dsw-radius-sm);
  padding: 8px 10px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
}
.att-banner > div:first-child { font-weight: 600; }
.att-banner.info { border-color: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.att-banner .att-banner-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.att-progress-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  background: var(--vscode-editor-background);
}
.att-progress-header {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; color: var(--vscode-foreground); gap: 8px;
}
.att-progress-title {
  font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.att-progress-meta {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; color: var(--vscode-descriptionForeground);
}
.att-progress-track {
  width: 100%; height: 6px; border-radius: 3px;
  background: var(--vscode-input-background);
  overflow: hidden; position: relative;
}
.att-progress-fill {
  height: 100%; border-radius: 3px;
  background: var(--vscode-progressBar-background);
  transition: width 0.15s ease-out;
}
.att-line { padding: 2px 4px; color: var(--vscode-descriptionForeground); font-size: 12px; }
/*
 * The loading state, as one class for the ring and one for the line that carries it.
 *
 * 'currentColor' rather than a named token, which is not laziness: the pending line is
 * already --vscode-descriptionForeground — label-secondary, the tertiary grey the
 * official StateDot uses for its ongoing state — so the ring inherits the colour of the
 * text it labels and this sheet grows no theme opinion of its own. That is also what
 * keeps the invariant 'verify:dsh' check 9 is written around, namely that everything
 * outside the bridge reads --vscode-* only. The track is 'currentColor' mixed down to
 * 30% because one declaration can then carry both steps of the ring: a fully opaque
 * track would read as a static grey circle and the eye would stop seeing motion.
 *
 * (Quoted, not backticked: this whole sheet is a template literal, so a backtick in a
 * comment here would end the string and the CSS after it would be parsed as TypeScript.)
 */
.att-spinner {
  display: inline-block;
  /* The ring is a flex item inside '.att-pending', and a long localized line in a narrow
     panel would otherwise squash it into an ellipse. */
  flex: 0 0 auto;
  box-sizing: border-box;
  width: 14px; height: 14px;
  border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: att-spin 1s linear infinite;
  /*
   * A negative offset so a spinner that mounts into an already-running cycle never shows
   * its 12-o'clock start frame: the arc is already mid-turn when it appears. It does not
   * phase-lock spinners mounted at *different* moments — no pure-CSS way reads the
   * document timeline — but every spinner committed in one render shares one animation
   * start time, and both pages emit their whole pending subtree in a single commit.
   */
  animation-delay: -0.2s;
}
@keyframes att-spin { to { transform: rotate(360deg); } }
.att-pending {
  display: inline-flex; align-items: center; gap: 6px;
  animation: att-pending-in 1ms linear 300ms both;
}
/*
 * The 300ms fast-read threshold, in CSS rather than in a timer.
 *
 * A setTimeout in the component would put a clock between the state and what the user
 * sees, and would have to be torn down on every re-render to avoid announcing a read
 * that already finished. The 'both' fill mode holds the 'from' frame through the delay,
 * so the line is simply absent for 300ms and then present — the spinner keeps turning
 * underneath meanwhile, which is why it appears mid-turn instead of snapping to 12.
 *
 * The threshold is deliberately visual-only. Opacity does not remove the line from the
 * accessibility tree, so assistive technology hears about the read immediately; holding
 * the announcement back for the same 300ms would make the panel slower for a screen
 * reader, not calmer.
 */
@keyframes att-pending-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  /*
   * Rotation is the only motion here, so it is the only thing that goes. What replaces it
   * is a solid 6px dot rather than a dimmer ring: at that size a ring is
   * indistinguishable from a speck, while a filled dot still reads as "in progress" —
   * the static base the official reduced-motion convention keeps.
   *
   * --dsw-alias-state-warn-primary is named directly rather than through the bridge,
   * which is the one place this sheet stops reading --vscode-* only. The alternative was
   * 'currentColor', i.e. the same tertiary grey as the text it sits next to — at 6px that
   * is a speck, not a state. Bridging it properly would mean a --vscode-loading-indicator
   * in the bridge, which this task does not own; the nearest existing entry,
   * --vscode-charts-yellow, is named for charts and would misreport the dot everywhere.
   *
   * The opacity threshold above stays: a fade is not motion, and dropping it would
   * restore the flash this class exists to suppress.
   */
  .att-spinner {
    width: 6px; height: 6px;
    border: none;
    background: var(--dsw-alias-state-warn-primary);
    animation: none;
  }
  /*
   * The HUD and the monitor page are the only places that animate while the user is reading
   * them: a pulsing badge dot, a gauge bar that slides to its new width, and the floating
   * window's own 0.15s border/box-shadow transitions. All of them are decoration — the number
   * next to them is the information — so under reduce they stop dead rather than slow down:
   * a slower slide is still a slide.
   *
   * The gauge keeps its width (that is the data) and only loses the transition, so the bar
   * still reports the same value; it just arrives instead of travelling there.
   */
  .att-monitor-badge-pulse-dot,
  .att-monitor-gauge-fill,
  .att-hud-pill,
  .att-floating-window,
  .att-monitor-tab-btn,
  .att-floating-tab-btn {
    animation: none;
    transition: none;
  }
}
.att-banners { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; }
.att-select {
  height: 28px; padding: 0 8px; font: inherit; font-size: 12px;
  /* Bounded so the toolbar cannot be pushed wider than the panel by a long server name; the
     native control truncates its own label. */
  max-width: 220px;
  color: var(--vscode-dropdown-foreground);
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border); border-radius: var(--dsw-radius-sm);
}
.att-select:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--vscode-focusBorder); outline-offset: -1px; }
.att-chip { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
/*
 * Visible to a screen reader, invisible to the eye.
 *
 * The standard clip-and-shrink recipe rather than 'display: none' or 'visibility: hidden':
 * both of those remove the node from the accessibility tree, which would make an
 * 'aria-describedby' pointing at it describe nothing at all — the failure mode looks like
 * "the hint is redundant" while it is really "the hint does not exist". 1px rather than 0 is
 * deliberate for the same reason: a genuinely zero-sized box is skipped by some readers.
 */
.att-sr-only {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip: rect(0 0 0 0); clip-path: inset(50%);
  overflow: hidden; white-space: nowrap;
}

/* Tab chip badge — which server this tab is on, and whether it is up.
   Rendered inside the frame's own tab strip, so it owns no box of its own beyond the
   dot: the strip already draws the capsule, and a second background would read as a
   second chip. Colours come from the same three state tokens the status dot uses, so a
   green tab means exactly what a green status line means. */
.att-tab-title {
  display: inline-flex; align-items: center; gap: 6px;
  min-width: 0;
  /*
   * max-width: 100% is what makes the ellipsis below reachable.
   *
   * The chip this sits in is the host's, and the host clips overflow — so with only
   * overflow: hidden on the text span, the span still laid out at its max-content width and
   * the **chip** did the cutting. The user saw 家用n, i.e. a hard cut mid-word that reads as
   * a different server name, rather than 家用… which says "there is more".
   *
   * Constraining the title to its container gives the text span something to shrink
   * against, so the truncation happens in our own element and carries the ellipsis.
   */
  max-width: 100%;
  overflow: hidden;
}
/*
 * The instance's own name, and the only part allowed to shrink.
 *
 * The strip gives each chip a fixed share, so exactly one child has to be able to truncate or the
 * chip overflows and the title's tail — the part that names the server — is the piece that leaves.
 */
.att-tab-title-text {
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.att-tab-badge {
  display: inline-flex; align-items: center; gap: 5px;
  min-width: 0; font-size: 12px; white-space: nowrap;
}
.att-tab-badge-dot {
  flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: var(--vscode-descriptionForeground);
}
.att-tab-badge[data-at-terminal-tab-state='connected'] .att-tab-badge-dot {
  background: var(--vscode-testing-iconPassed);
}
.att-tab-badge[data-at-terminal-tab-state='problem'] .att-tab-badge-dot {
  background: var(--vscode-errorForeground);
}
.att-tab-badge[data-at-terminal-tab-state='connecting'] .att-tab-badge-dot {
  background: var(--vscode-charts-yellow);
}

.att-terminal-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}
.att-terminal-page .terminal-shell { flex: 1 1 auto; min-height: 0; }
.att-form-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.att-copied { font-size: 12px; color: var(--vscode-descriptionForeground); }
.att-tree-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px;
  border-radius: var(--dsw-radius-md);
  user-select: none;
  white-space: nowrap;
}
.att-tree-row:hover { background: var(--vscode-list-hoverBackground); }
.att-tree-parent { color: var(--vscode-descriptionForeground); cursor: pointer; }
.att-tree-disclosure {
  width: 16px; height: 16px; padding: 0; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer;
  color: var(--vscode-foreground);
  font-family: inherit; font-size: 11px;
}
.att-tree-disclosure:hover { background: var(--vscode-toolbar-hoverBackground); border-radius: 3px; }
.att-tree-glyph {
  width: 14px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--vscode-descriptionForeground);
}
.att-tree-name { overflow: hidden; text-overflow: ellipsis; }
.att-tree-meta {
  margin-left: auto; font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
/* The disconnected listing is the last one the server gave us: readable, never editable. */
.att-sftp-page .att-banner[data-at-terminal-sftp="disconnected"] { margin: 6px 0; }

/*
 * The file pane's box.
 *
 * .att-file-content is a plain flex column with no sizing of its own, so without this it
 * sizes to its content and the *page* scrolls — while a viewer and an editor both want their
 * own scroll region inside a fixed-height pane (the textarea especially: its 'overflow: auto'
 * can never engage if its box is as tall as the file). The client renders this class on the
 * pane root; it had no rule at all until the UI2-00 className audit caught it.
 *
 * (No backticks above: this whole sheet is a template literal, so one would end the string.)
 */
.att-sftp-file-page > .att-file-content { flex: 1 1 auto; min-height: 0; }
.att-sftp-file-page { overflow: hidden; }

/*
 * The selected **file** row. A background rather than a border, because a border would shift
 * every row's text by a pixel the moment the selection moved, and the same
 * '--vscode-list-activeSelectionBackground' the workbench uses means a user who knows that
 * colour does not have to learn a second one.
 */
.att-tree-row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.att-tree-row.selected .att-tree-glyph,
.att-tree-row.selected .att-tree-meta {
  /* The meta column keeps its own colour on a selected row in the workbench, where it reads
   * as secondary information rather than as selected text. */
  color: var(--vscode-list-activeSelectionForeground);
}

/*
 * The upload control: a '<label>' dressed as a button, wrapping an input that is hidden from
 * sight but not from the tab ring.
 *
 * 'display: none' would be the obvious way to hide the input and is the wrong one: it removes
 * the control from the tab order, which would leave uploading reachable only by mouse. The
 * clip-and-shrink pair below is the standard visually-hidden recipe, and the focus ring is
 * drawn on the label so a keyboard user can still see where they are.
 */
.att-upload { position: relative; cursor: pointer; }
.att-file-input {
  position: absolute; width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip: rect(0 0 0 0); overflow: hidden; white-space: nowrap;
}
/* The ring itself is drawn by the shared focus-visible rule above, on '.att-upload:focus-within'. */

/*
 * The file pane. 'att-file-content' overrides the page's own padding because a viewer and an
 * editor both want the whole box: a '<pre>' with padding reads as an inset panel rather than
 * as the file, and the textarea's own padding is where its gutter-less look comes from.
 */
.att-file-content { display: flex; flex-direction: column; gap: 6px; padding: 6px 10px 0; }
/*
 * The code font, overridden here rather than bridged.
 *
 * '--vscode-editor-font-family' is not in the bridge, and deliberately so: check 9 requires every
 * bridged value to reference a --dsw-* token, while the host's code font is --ds-font-family-code
 * — a different family of variables. Bridging it would either fail the gate or force a token that
 * does not exist. Overriding the three code surfaces directly is the honest way to read it, and it
 * costs nothing: nothing else in the sheet wants a code font.
 *
 * The fallbacks are font stacks, not colours: they carry no theme decision, and without them a
 * host that renamed the token would render code in the UI font (the one outcome that makes a
 * diff unreadable).
 */
.att-file-text, .att-file-editor, .att-code-preview {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.att-file-text {
  flex: 1 1 auto; min-height: 0; margin: 0; overflow: auto;
  padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--dsw-radius-sm);
  font-size: 12px; line-height: 1.45;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  /* Wrapped in the *viewer* and not in the editor, and the two really do want opposite
   * things: reading prose wants the column, editing code wants the columns it was written in. */
  white-space: pre-wrap; word-break: break-word;
}
.att-file-editor {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: var(--dsw-radius-sm);
  font-size: 12px; line-height: 1.45;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  resize: none; tab-size: 4;
}

/* ---------------------------- the reused form's geometry --------------------------- */

/*
 * Geometry overrides for the server form (UI2-05).
 *
 * The reused sheet was written for a VS Code webview, where a 4px corner and a 7px-padded input
 * were the platform's own look. In this sidebar they sit next to 12px rows and 8px buttons, so the
 * form read as a different application embedded in the panel. Every rule below is the same
 * *pairing* the host uses — 28px control, --dsw-radius-sm, 12px type — applied to the classes the
 * reused markup already carries.
 *
 * Each selector is spelled with the root prefix because the reused sheet was scoped to the panel
 * root on the way in: a bare .primary-action here is a *weaker* selector than the rule it is meant
 * to replace, and would silently lose.
 */
${ROOT_SELECTOR} .form-panel { border-radius: var(--dsw-radius-md); }
${ROOT_SELECTOR} .auth-card { border-radius: var(--dsw-radius-md); }
${ROOT_SELECTOR} input,
${ROOT_SELECTOR} select {
  height: 28px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm);
}
${ROOT_SELECTOR} .field-stack select { min-height: 28px; }
/* Hover is a stronger border, not a focus-coloured one: the old rule turned the border the same
   blue as the focus ring on mere hover, which is the one signal a ring must keep for itself. */
${ROOT_SELECTOR} input:hover,
${ROOT_SELECTOR} select:hover { border-color: var(--dsw-alias-border-l4); }
/* Focus is keyboard-only here too, and the always-on outline from the reused sheet is retired. */
${ROOT_SELECTOR} input:focus,
${ROOT_SELECTOR} select:focus { outline: none; }
${ROOT_SELECTOR} input:focus-visible,
${ROOT_SELECTOR} select:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
${ROOT_SELECTOR} .primary-action,
${ROOT_SELECTOR} .secondary-action {
  display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 12px;
  border-radius: var(--dsw-radius-sm);
  font-size: 12px; line-height: 1;
}
${ROOT_SELECTOR} .primary-action:focus { outline: none; }
${ROOT_SELECTOR} .primary-action:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--vscode-focusBorder);
  outline-offset: 2px;
}

/*
 * The narrow-panel rules, as one container query on the page box.
 *
 * A container query and not a media query, and that is a correctness point rather
 * than a preference. The panel is a sidebar the user drags narrower inside a
 * window that does not change width, so a media query here would answer a
 * question nobody asked ('is the window narrow?') and stay silent through the
 * exact case this block exists for. The parser above already accepts @container
 * as an at-rule, and the container it needs is declared above on .att-page, so
 * this costs no markup change and no HTML structure edit.
 *
 * THE NUMBER IS THIS PLUGIN'S OWN CALL, NOT AN OFFICIAL ONE. The Harness ships no
 * breakpoint for third-party panels -- its styling guide for this surface was not
 * published in the package -- so there is no official figure to match and none is
 * invented here. What follows is derived from the panel's own contents instead:
 * the widest toolbar is the server list's (nav + four labelled buttons), which
 * measures roughly 470px at these paddings and font sizes, so below that the
 * toolbar can no longer hold one row and has to be allowed to use two. Treat it
 * as a measured first guess to be adjusted once the real panel has been watched
 * while dragging, not as a spec.
 *
 * What the narrow case actually needs is room, not a smaller font. Text stays at
 * 12px and the buttons keep their labels, because the labels are the only thing
 * telling two adjacent buttons apart -- shrinking them would trade a wrapping
 * problem for a readability one. So the pressure is taken out of the horizontal
 * padding, the gaps, and the one element that was actively holding the row open.
 */
@container att-panel (max-width: 480px) {
  /*
   * The spacer is what makes a toolbar NOT wrap: 'flex: 1 1 auto' with no content
   * still reports a zero basis, so it only takes leftover room -- but its flex
   * GROWS, and a growing item pushes the following buttons onto the next line
   * even where they would have fitted. Dropping it to zero basis in the narrow
   * case is what lets the row wrap by its own content rather than by the spacer
   * claiming the tail of the line first. It is 'flex-basis: 0' rather than
   * 'display: none' so the toolbar keeps exactly the same children either way;
   * only who takes the slack changes.
   */
  .att-toolbar, .att-terminal-toolbar { gap: 4px; padding: 8px; }
  .att-spacer { flex: 0 0 0; }
  .att-nav-btn { padding: 3px 8px; }
  /*
   * The status bar's path yields to the counts. '.att-dir' is already
   * 'flex: 0 1 auto' with 'min-width: 0', so it is the only thing in the row that
   * CAN shrink, and the chips around it are 'nowrap' -- which means the old
   * failure mode was never really the chip being crushed (it cannot be, its
   * min-content width floors it) but the row overflowing while the path held on
   * to the tail. Pinning the chip's flex-basis to its content is the belt to
   * that braces: it now wins the shrink contest outright instead of merely
   * refusing to be the only thing that gives.
   */
  .att-statusbar { gap: 8px; padding: 5px 8px; }
  .att-chip { flex: 0 0 auto; }
  /* A short path should not pay for a fade it does not need; see .att-dir above. */
  .att-dir[data-at-terminal-path-truncated="true"] {
    -webkit-mask-image: linear-gradient(to right, transparent 0, currentColor 16px);
    mask-image: linear-gradient(to right, transparent 0, currentColor 16px);
  }
}

/*
 * The server form in a narrow panel (UI2-02).
 *
 * The reused sheet already collapses this grid to one column, but inside
 * '@media (max-width: 760px)' — a question about the **window**, not about this panel. A
 * 1024px window gives the right bar roughly 460px, so the two-column grid stays and its left
 * column ('minmax(0, 1.1fr)') is squeezed to ~110px: the form was unusable at the default
 * width while the rule that fixes it sat there being true only for windows nobody drags.
 *
 * Same declarations, asked of the container that actually resizes. 680px is where the right
 * column's own minimum ('minmax(280px, .9fr)') plus a usable left column stops fitting; 520px
 * is where the field pairs inside each column stop fitting too. Specificity is spelled out
 * with the root prefix because the reused rules are already scoped to '.att-root' and a bare
 * '.form-section-grid' here would lose to them rather than override.
 *
 * (No backticks in this block: the sheet is a template literal.)
 */
@container att-panel (max-width: 680px) {
  ${ROOT_SELECTOR} .form-section-grid { grid-template-columns: minmax(0, 1fr); }
  ${ROOT_SELECTOR} .form-right-col { grid-template-columns: minmax(0, 1fr); }
}
/*
 * The group combobox's toggle (UI2-00 walkthrough, D3).
 *
 * The reused sheet fills it with the button background, and in this bridge that token IS the
 * brand fill — which in this theme is near-white. A 48px slab of it beside a 28px input reads as
 * a rendering fault, not as an affordance, and the literal 'v' inside it is a letter pretending
 * to be a chevron. So: transparent, no leading border (it abuts the input), and the glyph comes
 * from the icon set like every other disclosure in the panel.
 */
${ROOT_SELECTOR} .group-combobox-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border: 1px solid var(--vscode-input-border);
  border-left: 0;
  border-radius: 0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0;
  cursor: pointer;
}
${ROOT_SELECTOR} .group-combobox-toggle:hover {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground);
}
@container att-panel (max-width: 520px) {
  ${ROOT_SELECTOR} .field-grid,
  ${ROOT_SELECTOR} .auth-card-grid { grid-template-columns: minmax(0, 1fr); }
  ${ROOT_SELECTOR} .server-form-shell { padding: 16px; }
  ${ROOT_SELECTOR} .form-header,
  ${ROOT_SELECTOR} .form-footer { display: grid; gap: 8px; }
  ${ROOT_SELECTOR} .form-actions { display: grid; justify-content: stretch; }
  /* Full-width actions in a narrow panel: two 28px buttons side by side at 380px would each
     be ~half of a 348px content box, which is fine — but 保存 is the primary act and the
     footer already wraps, so stacking is the readable arrangement rather than a compromise. */
  ${ROOT_SELECTOR} .secondary-action,
  ${ROOT_SELECTOR} .primary-action { width: 100%; }
  /* The row's second badge is the first thing to go when the panel is this narrow: 口令 says
     how the server authenticates, 已存口令 only says a password is on file. Two badges plus an
     address left the name column with nothing, so the optional one loses its seat. */
  ${ROOT_SELECTOR} .att-row [data-at-terminal-badge="has-password"] { display: none; }
}

/* --------------------------- Monitor & HUD Styles -------------------------- */
.att-monitor-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow-y: auto;
  padding: 12px;
  box-sizing: border-box;
  gap: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}

.att-monitor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  padding-bottom: 8px;
}

.att-monitor-nav {
  display: flex;
  gap: 6px;
  align-items: center;
}

.att-monitor-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--dsw-radius-sm) var(--dsw-radius-sm) 0 0;
  transition: color 0.15s ease, background 0.15s ease;
}

.att-monitor-tab-btn:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

.att-monitor-tab-btn[data-active="true"] {
  color: var(--dsw-alias-brand-primary);
  border-bottom-color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}

.att-monitor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.att-monitor-card {
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.att-monitor-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  padding-bottom: 4px;
}

.att-monitor-gauge {
  height: 8px;
  width: 100%;
  background: var(--dsw-alias-bg-base);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}

.att-monitor-gauge-fill {
  height: 100%;
  background: var(--dsw-alias-brand-primary);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.att-monitor-gauge-fill[data-level="warn"] {
  background: var(--dsw-alias-state-warn-primary);
}

.att-monitor-gauge-fill[data-level="error"] {
  background: var(--dsw-alias-state-error-primary);
}

.att-monitor-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.att-monitor-table th {
  text-align: left;
  color: var(--dsw-alias-label-secondary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  padding: 4px 6px;
  white-space: nowrap;
}

.att-monitor-table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

/*
 * The audit table.
 *
 * table-layout: fixed is the load-bearing part: with the default auto layout the browser sizes
 * columns from their content, so one long command widened the table past the floating window and
 * the user had to drag the body sideways to read it. Fixed layout honours the colgroup widths,
 * which is what lets the command cell clip and ellipsize instead of pushing the window open.
 */
.att-audit-table {
  table-layout: fixed;
  width: 100%;
}

.att-clip-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
}

.att-clip-full {
  margin-top: 4px;
  padding: 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-base);
  font-family: monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 140px;
  overflow: auto;
}

.att-clip-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.att-clip-toggle:hover {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}

/*
 * The monitor/HUD status pill.
 *
 * Renamed from '.att-badge', which was already the **asset row's** auth badge 600 lines above —
 * two rules with one name, the later one winning, so the asset badge silently picked up this
 * pill's padding, weight and radius. That is the class of defect a stylesheet cannot warn about:
 * both rules are valid, both are wanted, and the bug is that they agree on a name. The att-monitor-
 * prefix is the scope this file actually has (a plain prefix rather than a nested selector, because
 * the pills are rendered inside both the docked pane and the floating HUD, which share no ancestor
 * below .att-root).
 */
.att-monitor-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  /* One line, always: a narrow column used to break 策略放行 into four stacked characters. */
  white-space: nowrap;
}

.att-monitor-badge-running {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
  color: var(--dsw-alias-brand-primary);
}

.att-monitor-badge-pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: att-pulse 1.5s infinite ease-in-out;
}

.att-monitor-badge-waiting {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}

.att-monitor-badge-success {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

.att-monitor-badge-denied {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

.att-code-preview {
  /* Font comes from the shared code-surface rule above ('--ds-font-family-code'). */
  font-size: 11px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  padding: 8px;
  max-height: 140px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--dsw-alias-label-secondary);
}

/* Global Floating HUD & Window Overlay */
.att-hud-overlay {
  position: fixed;
  z-index: 1000;
  pointer-events: auto;
  font-family: inherit;
  transition: opacity 0.15s ease;
}

.att-hud-overlay.is-dragging {
  user-select: none;
}

/* Draggable Mini Pill */
.att-hud-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 20px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: grab;
  box-shadow: var(--dsw-shadow-lv2);
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
  user-select: none;
  touch-action: none;
}

.att-hud-pill:hover {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 85%, transparent);
  box-shadow: var(--dsw-shadow-lv3);
}

.att-hud-pill:active,
.att-hud-pill.is-dragging {
  cursor: grabbing;
  border-color: var(--dsw-alias-brand-primary);
}

/*
 * The chip is a **button** whenever it does something (CPU/MEM/agent open a sub-tab), so the
 * rule that draws it has to reset the native control or the platform's own border and
 * background reappear inside the pill. appearance: none plus an explicit font: inherit is the
 * whole reset — the rest of the geometry is the shared chip shape.
 */
.att-hud-pill-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 10px;
  border: none;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 80%, transparent);
  font: inherit;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
button.att-hud-pill-chip {
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
}
button.att-hud-pill-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
/* The chevron that expands the pill is a button of its own: it used to be a decorative span
   inside a role="button" container, i.e. an action with no name a screen reader could
   announce. It inherits the pill's surface rather than drawing a second one. */
.att-hud-pill-expand {
  display: inline-flex; align-items: center; justify-content: center;
  appearance: none; -webkit-appearance: none;
  border: none; background: transparent; padding: 0;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.8; cursor: pointer;
}
.att-hud-pill-expand:hover {
  opacity: 1;
  color: var(--dsw-alias-label-primary);
}

/* Draggable Floating Window */
.att-floating-window {
  /*
   * min() rather than a media query: the floating window is positioned in viewport
   * coordinates, so what matters is the viewport, not the panel the button was pressed in.
   * At 360px wide the old fixed 400px hung 40px off the right edge and clampPosition could
   * not pull it back — it clamped against a box that did not fit.
   */
  width: min(400px, calc(100vw - 16px));
  max-height: min(540px, calc(100vh - 16px));
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 92%, transparent);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  box-shadow: var(--dsw-shadow-lv3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  touch-action: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.att-floating-window.is-dragging {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: var(--dsw-shadow-lv3);
}

.att-floating-window-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: grab;
  user-select: none;
}

.att-floating-window-header:active,
.att-floating-window-header.is-dragging {
  cursor: grabbing;
}

.att-floating-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.att-floating-drag-grip {
  display: inline-flex; align-items: center;
  color: var(--dsw-alias-label-dimmed);
  line-height: 1;
  cursor: grab;
  user-select: none;
  /*
   * The handle is the only draggable spot on the capsule, so its *hit* area must be bigger than its
   * glyph. A 14px icon meant the press had to land within a few pixels and the report was exactly
   * that — "a little higher drags, a little lower does not". The box now spans the pill's full
   * height (negative vertical margins cancel the pill's padding) instead of just the dots, and the
   * glyph inside it is transparent to the pointer so the target is always this element.
   */
  align-self: stretch;
  padding: 0 6px;
  margin: -5px -2px -5px -6px;
}
.att-floating-drag-grip svg {
  pointer-events: none;
}
.att-hud-pill.is-dragging .att-floating-drag-grip {
  cursor: grabbing;
}

.att-floating-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.att-floating-subtabs {
  display: flex;
  gap: 4px;
  padding: 6px 12px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.att-floating-tab-btn {
  flex: 1;
  text-align: center;
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  transition: all 0.15s ease;
}

.att-floating-tab-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.att-floating-tab-btn.is-active {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}

.att-floating-window-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 420px;
  user-select: text;
}

.att-floating-window-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 40%, transparent);
}

/* Floating Overview Grid & Cards */
.att-overview-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.att-overview-metric-card {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.att-overview-metric-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.att-overview-metric-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.att-overview-agent-card {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

@keyframes att-pulse {
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(1.15); }
  100% { opacity: 1; transform: scale(1); }
}

/* ---- UI2-12: the remote-command card ----
   Deliberately NOT scoped under .att-root. This row is rendered by the conversation through the
   keyed slot, not by our panel, so a scoped rule would never match and the card would land with
   no geometry at all. The geometry below is the Host's own tool-row geometry (24px row, 16px
   leading slot, 2px separator dot) so the card sits in a transcript of official rows without
   reading as a foreign object.
*/
.att-tool-card {
  box-sizing: border-box;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.att-tool-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  min-width: 0;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  font-size: var(--dsh-content-font-size-secondary, 13px);
  color: var(--dsw-alias-label-tertiary);
  transition: color .1s;
}
.att-tool-row[data-expandable='true'] { cursor: pointer; }
.att-tool-row[data-expandable='true']:hover { color: var(--dsw-alias-label-secondary); }
.att-tool-row[data-expandable='true']:focus-visible {
  outline: 1px solid var(--dsw-alias-border-l4);
  outline-offset: 2px;
  border-radius: var(--dsw-radius-sm, 4px);
}
.att-tool-leading {
  flex: none;
  width: 16px;
  height: 16px;
  margin-right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}
.att-tool-leading svg { width: 14px; height: 14px; }
.att-tool-icon, .att-tool-chevron { color: inherit; }
.att-tool-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
/* The server is the row's anchor, not its subject: it gets a ceiling so a long label cannot
   push the command — the only part worth reading — off the right edge. */
.att-tool-server {
  flex: none;
  /* Narrow on purpose: the server is an identifier, the command is the content. A wide
     server column clipped the command to $... on a real transcript, which is the one
     field worth reading. */
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-tool-sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
  border-radius: 1px;
  background: var(--dsw-alias-label-caption);
}
.att-tool-summary {
  flex: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
}
.att-tool-badge {
  flex: none;
  margin-left: 8px;
  padding: 0 6px;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.att-tool-badge[data-error='true'] { color: var(--dsw-alias-state-error-primary); }
.att-tool-duration {
  flex: none;
  margin-left: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
}
.att-tool-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 4px 0 4px 22px;
}
.att-tool-flags { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.att-tool-flag { font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-warn-label); }
.att-tool-section {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: baseline;
  column-gap: 14px;
  margin-bottom: 4px;
  padding: 8px 12px;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg, 8px);
  background: var(--dsw-alias-markdown-code-block);
}
.att-tool-label { font-size: 11px; color: var(--dsw-alias-label-caption); }
.att-tool-out {
  margin: 0;
  min-width: 0;
  max-height: 224px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.att-tool-out[data-error='true'] { color: var(--dsw-alias-state-error-primary); }
.att-tool-actions { display: flex; margin-top: 2px; }
.att-tool-copy { font-size: 11px; line-height: 16px; }

@media (prefers-reduced-motion: reduce) {
  .att-tool-row { transition: none; }
}
`;

/**
 * The three reused sheets, as text. Injectable so the tests can drive
 * 'buildStyleSheet' with the real file contents read from disk — the vitest
 * pipeline stubs CSS imports to empty strings, and the assertions that matter
 * ("every class the reused sheets define ends up scoped under the panel root",
 * "every variable they read is bridged") need the real text.
 */
export interface StyleSheetSources {
  xterm: string;
  terminal: string;
  serverForm: string;
}

const DEFAULT_SOURCES: StyleSheetSources = {
  xterm: xtermCss,
  terminal: terminalCss,
  serverForm: serverFormCss
};

/** The full sheet: reused stylesheets (scoped), the token bridge, then the layout. */
export function buildStyleSheet(sources: StyleSheetSources = DEFAULT_SOURCES): string {
  return [
    scopeCss(sources.xterm, ROOT_SELECTOR),
    scopeCss(sources.terminal, ROOT_SELECTOR),
    scopeCss(sources.serverForm, ROOT_SELECTOR),
    TOKEN_BRIDGE,
    LAYOUT_CSS
  ].join('\n');
}

/**
 * Inject the sheet once per page. The id guard makes re-activation idempotent;
 * the caller owns removal (the returned disposer) so unloading the plugin takes
 * its CSS with it.
 */
export function ensureStyles(doc: Document): () => void {
  const existing = doc.getElementById(STYLE_ELEMENT_ID);
  if (existing !== null) {
    return () => {
      existing.remove();
    };
  }
  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = buildStyleSheet();
  (doc.head ?? doc.documentElement).appendChild(style);
  return () => {
    style.remove();
  };
}