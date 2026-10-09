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
  /* ---- Type. A font stack, not a colour decision: it carries no theme
     meaning, which is why check 9 exempts this one by name. The panel sets
     font-family once at the root and every descendant inherits it. */
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans", sans-serif;

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

  /* ---- The brand-filled button. Foreground is the one literal colour in the
     bridge; hover is the same brand tinted toward white, so the fill lightens
     in both themes instead of only in the dark one. */
  --vscode-button-background: var(--dsw-alias-brand-primary);
  --vscode-button-foreground: var(--dsw-alias-label-primary-foreground);
  --vscode-button-hoverBackground: color-mix(in srgb, var(--dsw-alias-brand-primary) 82%, #ffffff);
  --vscode-button-secondaryHoverBackground: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, var(--dsw-alias-label-primary));
  --vscode-focusBorder: var(--dsw-alias-brand-primary);
  --vscode-progressBar-background: var(--dsw-alias-brand-primary);

  /* ---- Interactive states. Hover is the official hover token rather than a
     hand-mixed tint: it is exactly this question answered once, for the whole
     product, in both themes. Selection stays a brand mix on purpose -- it is
     the one state that has to read as "chosen", so it must outrank the neutral
     hover rather than reuse it. */
  --vscode-list-hoverBackground: var(--dsw-alias-interactive-bg-hover);
  --vscode-toolbar-hoverBackground: var(--dsw-alias-interactive-bg-hover);
  --vscode-list-activeSelectionBackground: color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent);
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
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: 13px;
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
.att-page {
  display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0;
  container: att-panel / inline-size;
}
.att-page[hidden] { display: none; }
.att-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}
.att-nav { display: flex; gap: 2px; padding: 2px; border-radius: 6px; background: var(--vscode-input-background); }
.att-nav-btn {
  border: none; background: transparent; color: var(--vscode-descriptionForeground);
  padding: 3px 14px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 12px;
}
.att-nav-btn[aria-selected="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.att-spacer { flex: 1 1 auto; }
.att-btn {
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  padding: 3px 12px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 12px;
}
.att-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.att-btn:disabled { opacity: 0.5; cursor: default; }
.att-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.att-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.att-btn.danger { color: var(--vscode-errorForeground); }
.att-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 10px 12px; }
.att-group-name {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
  padding: 6px 8px; border-radius: 4px;
  cursor: pointer; user-select: none;
}
.att-group-name:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}
.att-group-disclosure {
  display: inline-flex; align-items: center; justify-content: center;
  width: 12px; height: 12px; font-size: 9px; opacity: 0.8;
}
.att-group-count {
  margin-left: auto;
  font-size: 11px; font-weight: normal; opacity: 0.7;
}
.att-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; user-select: none; }
.att-row:hover { background: var(--vscode-list-hoverBackground); }
.att-row[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground); }
.att-row-label { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 32%; }
.att-row-addr {
  flex: 1 1 auto; min-width: 0;
  color: var(--vscode-descriptionForeground);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.att-row[aria-selected="true"] .att-row-addr { color: inherit; }
.att-badge {
  flex: 0 0 auto; font-size: 11px; padding: 0 7px; border-radius: 999px;
  background: var(--vscode-badge-background); border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-foreground);
}
.att-hint { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 6px; }
.att-statusbar {
  display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
  padding: 5px 12px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
  color: var(--vscode-descriptionForeground); font-size: 12px;
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
  background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  box-shadow: var(--dsw-shadow-lv2);
}
.att-menu-item {
  display: block; width: 100%; text-align: left;
  border: none; background: transparent; color: inherit;
  padding: 5px 10px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 12px;
}
.att-menu-item:hover { background: var(--vscode-list-hoverBackground); }
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
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  box-shadow: var(--dsw-shadow-lv3);
}
.att-dialog-title { margin: 0; font-size: 14px; font-weight: 650; }
.att-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.att-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.att-field input[type="text"], .att-field input[type="password"], .att-field select {
  padding: 4px 8px; font: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border); border-radius: 4px;
}
.att-field input:focus, .att-field select:focus { outline: 1px solid var(--vscode-focusBorder); }
.att-check { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.att-banner {
  display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--vscode-errorForeground); border-radius: 6px;
  padding: 8px 10px; font-size: 12px; color: var(--vscode-errorForeground);
}
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
}
.att-banners { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; }
.att-select {
  padding: 3px 8px; font: inherit; font-size: 12px; max-width: 280px;
  color: var(--vscode-dropdown-foreground);
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border); border-radius: 4px;
}
.att-chip { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

/* Tab chip badge — which server this tab is on, and whether it is up.
   Rendered inside the frame's own tab strip, so it owns no box of its own beyond the
   dot: the strip already draws the capsule, and a second background would read as a
   second chip. Colours come from the same three state tokens the status dot uses, so a
   green tab means exactly what a green status line means. */
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
  padding: 4px 8px; border-radius: 4px; user-select: none;
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
.att-tree-glyph { width: 12px; text-align: center; color: var(--vscode-descriptionForeground); }
.att-tree-name { overflow: hidden; text-overflow: ellipsis; }
.att-tree-meta {
  margin-left: auto; font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
/* The disconnected listing is the last one the server gave us: readable, never editable. */
.att-sftp-page .att-banner[data-at-terminal-sftp="disconnected"] { margin: 6px 0; }

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
.att-upload:focus-within {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

/*
 * The file pane. 'att-file-content' overrides the page's own padding because a viewer and an
 * editor both want the whole box: a '<pre>' with padding reads as an inset panel rather than
 * as the file, and the textarea's own padding is where its gutter-less look comes from.
 */
.att-file-content { display: flex; flex-direction: column; gap: 6px; padding: 6px 10px 0; }
.att-file-text {
  flex: 1 1 auto; min-height: 0; margin: 0; overflow: auto;
  padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px; line-height: 1.45;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  /* Wrapped in the *viewer* and not in the editor, and the two really do want opposite
   * things: reading prose wants the column, editing code wants the columns it was written in. */
  white-space: pre-wrap; word-break: break-word;
}
.att-file-editor {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px; line-height: 1.45;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  resize: none; tab-size: 4;
}
.att-file-editor:focus-visible,
.att-file-text:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
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