/**
 * The Client half may not call a hook from inside another hook's callback.
 *
 * ## What this prevents
 *
 * `useState(() => readTabId(props))` looked correct and passed `tsc`, the bundle harness and
 * 1143 tests. It shipped, and the panel flashed once and went blank in the real app:
 *
 * ```
 * Error: Minified React error #311   →  "Should have a queue"
 *   at be.useState (dsh-app://app/assets/index-…js:25:…)
 *   at AtTerminalBody (plugins/??@at-series/dsh-at-terminal/client.js, …)
 * ```
 *
 * A lazy initialiser runs **inside `mountState`**, so the framework's own `useMemo` — reached
 * through `props.useTabInfo()` — was dispatched in the middle of `useState`'s hook entry and
 * left the fiber's hook list inconsistent. Nothing threw at that moment; the first render even
 * committed. The **next** hook on the **next** render found no queue, React tore the subtree
 * down, and the sidebar rendered its slot `fallback` — an empty panel.
 *
 * Nothing in the suite could see it, because every test double implements hooks as slot
 * lookups: a nested hook is just another lookup. The failure only exists in real React.
 *
 * So it is checked here, structurally, over the sources rather than over a rendered tree.
 * The official `terminal` type shows the intended shape — `const { tab } = useTabInfo();`
 * directly in the component body, every render.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = join(__dirname, '..', '..', 'src', 'platform', 'dsh', 'client');

/** Recursively every `.ts`/`.tsx` under the client half. */
function clientSources(directory: string = CLIENT_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...clientSources(path));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(path);
    }
  }
  return found;
}

/** `React.useX(` / `useX(` where `useX` is a hook name. */
const HOOK_CALL = /\b(?:React\.)?(use[A-Z]\w*)\s*\(/g;

/** A hook whose callback must stay pure: `useState(`, `useMemo(`, `useReducer(`, `useCallback(`. */
const NESTING_HOOK = /\b(?:React\.)?(useState|useMemo|useReducer|useCallback)\s*\(/;

/** A hook name anywhere — a call (`useMemo(`) or a reference (`props.useTabInfo`). */
const HOOK_REFERENCE = /\buse[A-Z]\w*/g;

/**
 * Local function names that touch a hook at all.
 *
 * Without this the gate is blind to the exact shape that caused the outage:
 * `useState(() => readTabId(props))` contains no hook call *syntactically* — the hook is two
 * steps deeper, reached as `props?.useTabInfo` inside `readTabId`. The first version of this
 * gate passed on the real defect, and a corrected version that only looked for a hook **call**
 * still passed, because the reference is not a call.
 *
 * So the test is deliberately generous: any mention of a hook name inside the helper's body
 * marks it as hook-touching. A false positive costs a line of code to unpick; a false negative
 * ships a blank panel. One level of indirection is the stated limit — deeper chains are not
 * followed, and that is recorded rather than papered over.
 */
function hookCallingHelpers(code: string): Set<string> {
  const names = new Set<string>();
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/.exec(lines[i]);
    if (declaration === null) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length && j < i + 60; j += 1) {
      for (const character of lines[j]) {
        if (character === '{') {
          depth += 1;
          started = true;
        } else if (character === '}') depth -= 1;
      }
      if (!started) continue;
      if (depth <= 0) break;
      if (HOOK_REFERENCE.test(lines[j])) {
        names.add(declaration[1]);
        break;
      }
      HOOK_REFERENCE.lastIndex = 0;
    }
    HOOK_REFERENCE.lastIndex = 0;
  }
  return names;
}

/**
 * Strip comments and string literals so a hook name inside prose or a CSS string cannot be
 * mistaken for a call. Comment stripping is deliberately simple: this is a lint, not a parser,
 * and the sources it reads contain no block comment that ends mid-line.
 */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('client half — hook discipline', () => {
  const sources = clientSources();
  it('finds the client sources it is meant to check', () => {
    // A glob that silently matches nothing would make every assertion below vacuously true.
    expect(sources.length).toBeGreaterThan(8);
  });

  it('never calls a hook from inside another hook\'s callback', () => {
    const offences: string[] = [];
    for (const file of sources) {
      const code = stripNoise(readFileSync(file, 'utf8'));
      // Helpers that touch a hook themselves: the indirection the first version missed.
      const helpers = hookCallingHelpers(code);
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const opening = NESTING_HOOK.exec(lines[i]);
        if (opening === null) continue;

        // Collect the whole callback as one string, tracking paren depth from the hook's own
        // `(`. Line-by-line inspection is not enough: the commonest shape is a **single-line**
        // callback (`useState(() => readTabId(props))`), where depth returns to 0 on the very
        // same line — an earlier version broke out before ever looking, and passed on the real
        // defect.
        let depth = 0;
        let body = '';
        let endedAt = i;
        for (let j = i; j < lines.length && j < i + 40; j += 1) {
          for (const character of lines[j]) {
            if (character === '(') depth += 1;
            else if (character === ')') depth -= 1;
          }
          // Skip the opening hook's own name, then keep everything up to its closing paren.
          body += `${j === i ? lines[j].slice(lines[j].indexOf('(') + 1) : lines[j]}\n`;
          endedAt = j;
          if (depth <= 0 && j > i) break;
          if (depth <= 0 && lines[j].trimEnd().endsWith(');')) break;
        }

        const inner = body.slice(0, body.lastIndexOf(')'));
        // A direct hook call, or a call to a helper that touches one.
        const direct = HOOK_REFERENCE.exec(inner);
        HOOK_REFERENCE.lastIndex = 0;
        const indirect = direct === null ? [...helpers].find((name) => inner.includes(`${name}(`)) : undefined;
        if (direct === null && indirect === undefined) continue;
        offences.push(
          `${file.slice(CLIENT_ROOT.length + 1)}:${i + 1} — ${direct?.[0] ?? `${indirect}(`} inside a ${
            opening[1]
          } callback: ${lines[i].trim().slice(0, 90)}`
        );
        void endedAt;
      }
    }
    expect(offences).toEqual([]);
  });

  it('reads the tab identity at the top level, not from a state initialiser', () => {
    // The specific shape that caused the outage, named so the fix cannot be quietly reverted
    // into a different component. Matched against comment-stripped code, because the
    // explanation of the bug necessarily contains the pattern it forbids.
    const body = stripNoise(readFileSync(join(CLIENT_ROOT, 'body.ts'), 'utf8'));
    expect(body).not.toMatch(/useState\(\(\)\s*=>\s*readTabId/);
    expect(body).toMatch(/const tabId = readTabId\(props\);/);
  });

  it('does not trigger diagnostic RPC when props and state have not changed', () => {
    // 验证 title 和 body 的 useEffect 具有严格的 deps 列表，而不是缺少 deps 导致每次 render 均发送
    const body = readFileSync(join(CLIENT_ROOT, 'body.ts'), 'utf8');
    const sessionBody = readFileSync(join(CLIENT_ROOT, 'body-session.ts'), 'utf8');

    expect(body).toMatch(/postDiagnostic\([\s\S]*?title rendered[\s\S]*?\);\s*},\s*\[key,\s*badge\?\.kind\]\);/);
    expect(body).toMatch(/postDiagnostic\([\s\S]*?body rendered[\s\S]*?\);\s*},\s*\[tabId,\s*formOpen\]\);/);
    expect(sessionBody).toMatch(/postBodyRendered\(key,\s*session\.page\);\s*},\s*\[key,\s*session\.page\]\);/);
  });
});

describe('optional host UI services stay optional', () => {
  it('never imports a @deepseek-ai client-ui implementation', () => {
    // The browser module table is frozen: only `dsh.client.inject` + ctx services are
    // available, and a direct import would fail at load (or, worse, silently duplicate the
    // host's component). This covers every client source, including the new menu/file code.
    const offenders: string[] = [];
    for (const file of clientSources()) {
      const code = readFileSync(file, 'utf8');
      // Only real import statements count: the comments in body.ts and icons/ name these
      // packages precisely to explain why they are *not* imported.
      const match = /(?:^|\n)\s*import[^\n]*@deepseek-ai\/dsh-client-ui-[A-Za-z0-9-]+/.exec(code);
      if (match !== null) offenders.push(`${file.slice(CLIENT_ROOT.length + 1)}: ${match[0].trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it('probes contextMenus/fileActions with ctx.get and keeps the old fallback', () => {
    const main = readFileSync(join(CLIENT_ROOT, 'main.ts'), 'utf8');
    // Feature detection, not a required inject entry: a 0.2.1 host has neither service and
    // must keep the local menus and the saveBytes download.
    expect(main).toContain("optionalService<ContextMenuService>(ctx, 'contextMenus')");
    expect(main).toContain("optionalService(ctx, 'fileActions')");
    expect(main).toContain("typeof ctx.inject === 'function'");
    expect(main).toMatch(/export const inject = \['slots', 'sidebarRightTabs', 'locale', 'shortcuts', 'sidebarRight'\]/);
    // The package manifest still asks the loader for the optional plugins, so a 0.2.2 host
    // mounts them; the service probes above decide whether this build uses them.
    const pkg = JSON.parse(readFileSync(join(CLIENT_ROOT, '..', '..', '..', '..', 'dsh', 'package.json'), 'utf8')) as {
      dsh?: { client?: { inject?: string[] } };
    };
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-context-menu');
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-file-actions');
  });

  it('keeps both bodies on the local menu when the host service is absent', () => {
    const body = readFileSync(join(CLIENT_ROOT, 'body.ts'), 'utf8');
    const sessionBody = readFileSync(join(CLIENT_ROOT, 'body-session.ts'), 'utf8');
    // The fallback render is guarded, not deleted: menu !== null && !hostMenu.
    expect(body).toContain('if (menu !== null && !hostMenu)');
    expect(sessionBody).toContain('if (sftpMenu !== null && !hostMenu)');
    expect(body).toContain('useMenuFocus(menu !== null');
    expect(sessionBody).toContain('useMenuFocus(sftpMenu !== null');
  });
});