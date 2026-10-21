import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS host module
import { createTools } from '../../dsh/tools.js';

/**
 * The tool table is the only place a reader can learn what this plugin exposes, and it
 * had drifted in both directions at once: it listed `at_terminal_sftp_copy`, which has
 * never existed, and omitted four tools that do (`sftp_create_file`, `open_monitor`,
 * `get_hardware_metrics`, `get_agent_execution_status`).
 *
 * So the assertion is **set equality**, not containment. A subset check would have passed
 * on all of that: one wrong name and four missing rows are invisible when the test only
 * asks "is every registered tool mentioned somewhere".
 */

/** A row of the README table: the first cell is a backticked, fully qualified tool name. */
const FULLY_QUALIFIED_ROW = /^\|\s*`(at_terminal_[a-z_]+)`\s*\|/gm;

/** A row of a `docs/features*.md` table: the first cell is a backticked bare tool name. */
const BARE_ROW = /^\|\s*`([a-z_][a-z_0-9]*)`\s*\|/gm;

function registeredToolNames(): string[] {
  return createTools({ version: '0.0.0' }).map((tool: { name: string }) => tool.name);
}

function firstCells(markdown: string, pattern: RegExp): string[] {
  return [...markdown.matchAll(pattern)].map((match) => match[1]);
}

/**
 * Slice out one `## heading` section, so a table elsewhere in the file (assets, settings)
 * cannot be mistaken for the tool table.
 */
function section(markdown: string, heading: RegExp): string {
  const start = markdown.search(heading);
  if (start === -1) {
    throw new Error(`no ${String(heading)} heading in the document under test`);
  }
  const afterHeading = markdown.slice(start).split('\n').slice(1).join('\n');
  const end = afterHeading.search(/^## /m);
  return end === -1 ? afterHeading : afterHeading.slice(0, end);
}

describe('README tool table', () => {
  const readme = readFileSync('README.md', 'utf8');

  it('lists exactly the tools createTools() registers — no extras, no missing rows', () => {
    const documented = firstCells(readme, FULLY_QUALIFIED_ROW);
    const actual = registeredToolNames();

    // Duplicate rows would make the sets equal while still leaving the table wrong.
    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual([...actual].sort());
  });

  it('describes sftp_delete as file-only, and names the way out for a directory', () => {
    const row = readme
      .split('\n')
      .find((line) => line.startsWith('| `at_terminal_sftp_delete`'));
    expect(row).toBeDefined();
    expect(row).toContain('single file');
    expect(row).toContain('at_terminal_run_remote_command');
    expect(row).not.toContain('sftp_copy');
  });
});

describe.each([
  { file: 'docs/features.md', heading: /^## MCP And Agent Tools$/m, language: 'en' },
  { file: 'docs/features.zh-CN.md', heading: /^## MCP 和 Agent 工具$/m, language: 'zh' }
])('$file agent-tool table', ({ file, heading }) => {
  const markdown = readFileSync(file, 'utf8');
  const table = section(markdown, heading);

  it('lists exactly the tools createTools() registers, by bare name', () => {
    const documented = firstCells(table, BARE_ROW);
    const bareRegistered = registeredToolNames().map((name) => name.replace(/^at_terminal_/, ''));

    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual([...bareRegistered].sort());
  });
});
