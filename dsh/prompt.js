/**
 * The prompt section that carries the rules the tool descriptions used to repeat.
 *
 * Every tool used to explain the trust tiers, the "read before write" order and what a
 * `spillPath` means. Seventeen copies of the same three rules is how the definitions reached
 * 7.8 kB, and a rule stated seventeen times is also a rule that can disagree with itself in
 * seventeen places. The section states each once; the descriptions say only what each tool
 * does.
 *
 * Two facts from the installed `dsh-system-prompt` shaped this file:
 *
 * 1. `assemble()` resolves variables with `variables[name] = provider(context)` — **not**
 *    awaited (`lib/index.js:361`). So the trust fact must be ready synchronously; it is a
 *    cached string refreshed whenever a tool actually reads the server list.
 * 2. Interpolation is strict: an unregistered `{{name}}` throws during assembly
 *    (`lib/index.js:174`), which fails *every* model request rather than one tool call. The
 *    registration therefore happens before the section, and the variable name is exported so
 *    the test can assert the two halves agree.
 */

/** Section name. A `tool:` prefix keeps it next to the other tool sections. */
export const PROMPT_SECTION_NAME = 'tool:at-terminal';

/** The one dynamic fact in the section. Must match `/^[a-z][a-z0-9_]*$/`. */
export const TRUST_VARIABLE = 'at_terminal_trust';

/** How many servers the fact names before it stops listing them. */
const TRUST_LIMIT = 5;

/**
 * What the fact says before any tool has read the server list.
 *
 * Deliberately not "none configured": we have not looked, and saying "none" would be a
 * claim about the user's setup that nobody verified.
 */
const TRUST_UNREAD = 'not read yet (call at_terminal_list_ssh_servers)';

let cachedTrust = TRUST_UNREAD;

/**
 * Tools whose usefulness depends on a configured SSH server.
 *
 * This is the single source of truth for the prompt's "is there anything to explain" test
 * and for the host half's `{ when }` conditional registration. Keep the names in sync with
 * `dsh/tools.js`; `test/dsh/index-wiring.test.ts` measures the visible subset against the
 * actual definitions, so a name that drifts out of the list shows up as a size regression.
 */
export const SERVER_TOOL_NAMES = Object.freeze([
  'at_terminal_run_remote_command',
  'at_terminal_sftp_list_directory',
  'at_terminal_sftp_stat_path',
  'at_terminal_sftp_read_file',
  'at_terminal_sftp_edit_file',
  'at_terminal_sftp_write_file',
  'at_terminal_sftp_create_file',
  'at_terminal_sftp_create_directory',
  'at_terminal_sftp_rename',
  'at_terminal_sftp_delete',
  'at_terminal_open_monitor',
  'at_terminal_get_hardware_metrics'
])

/**
 * The section text, written once with the two job-control names as parameters.
 *
 * Written as data, not as prose for humans: the model reads it once per request, so it has
 * to carry the decisions the tool names cannot. ASCII only — a byte budget is a budget.
 * The standard preset uses the host's `job_output` / `job_kill`; a composition without
 * `dsh-tool-jobs` sees the plugin's `at_terminal_job_*` fallback instead, and the section
 * must name whichever pair is actually in the tool set.
 *
 * @param {{ output: string, kill: string }} jobs
 */
function buildSectionText({ output, kill }) {
  return `AT Terminal acts on configured SSH servers through three tool families: commands (at_terminal_run_remote_command), SFTP (at_terminal_sftp_*), and monitoring (at_terminal_open_monitor, at_terminal_get_hardware_metrics). For files prefer SFTP: it is authorized per path and returns structured results. The order that works is sftp_stat_path, then sftp_read_file, then sftp_edit_file for a literal replacement or sftp_write_file with overwrite for a whole-file rewrite. Pass the size/modifiedAt you just read as expectedSize/expectedModifiedAt: a file that changed since the read is refused, so re-read it and retry instead of overwriting blindly. A file that is already on this machine goes up through sftp_write_file localPath: the Host reads it, so a binary or a large file is never inlined as content.

Trust decides who answers: "none" asks before every command, "policy" asks unless the command policy proves the command read-only, "full" runs ordinary commands without asking. SFTP writes, renames and deletes ask at every trust level except "full", and a sensitive path asks even then. A localPath upload asks even on full trust.

A result larger than the inline budget is written to a file and its spillPath is returned: read that path with offset/limit instead of re-running the command. Truncated or spilled is not the same as failed. A background command returns a job id: collect it with ${output}, end it with ${kill}, and a job reported killed means the remote process group is gone.

When several servers are connected, name serverId on every write or execute call (sftp_write_file, sftp_create_file, sftp_create_directory, sftp_rename, sftp_delete, run_remote_command). Those calls refuse to guess rather than act on the wrong host. Read calls and open_monitor may omit it: they use the active terminal and report resolvedBy as "implicit" with the candidate list, or "single-connected" when only one server was connected.

Servers and trust right now: {{${TRUST_VARIABLE}}}`
}

/** The standard-preset text: the host owns `job_output` / `job_kill`. */
export const PROMPT_SECTION_TEXT = buildSectionText({ output: 'job_output', kill: 'job_kill' })

/** The fallback text for a composition where this bundle supplies `at_terminal_job_*`. */
export const PROMPT_SECTION_TEXT_FALLBACK = buildSectionText({
  output: 'at_terminal_job_output',
  kill: 'at_terminal_job_kill'
})

/**
 * The tool names visible to the step being assembled, or `undefined` when the host did not
 * pass an admission set (registration-time inspection, older host). `undefined` means "do
 * not hide anything": the section is guidance, and losing it is worse than an unused line.
 *
 * @param {{ view?: (scope: unknown) => Map<string, unknown> } | Iterable<string> | undefined} toolSet
 * @param {unknown} [scope]
 * @returns {string[] | undefined}
 */
function visibleToolNames(toolSet, scope) {
  if (toolSet === undefined || toolSet === null) return undefined
  try {
    const view = typeof toolSet.view === 'function' ? toolSet.view(scope) : toolSet
    if (view === undefined || view === null) return undefined
    // Arrays have `.keys()` too, so the array branch must come first: reading an array of
    // tool names through `.keys()` yields indices, and the section would treat every name as
    // invisible. A real ToolSet has `.view(scope)` returning a Map, which is the host path.
    if (Array.isArray(view)) return view
    if (typeof view.keys === 'function') return [...view.keys()]
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the step can see any tool that acts on a server.
 *
 * The four resident tools (`ping`, `list_ssh_servers`, `get_terminal_context`,
 * `get_agent_execution_status`) are deliberately not enough: with no server configured the
 * section would describe capabilities the model cannot use. This is what makes the section
 * empty in the no-server profile.
 *
 * @param {unknown} toolSet
 * @param {unknown} [scope]
 */
export function hasVisibleAtTerminalTool(toolSet, scope) {
  const names = visibleToolNames(toolSet, scope)
  if (names === undefined) return true
  return SERVER_TOOL_NAMES.some((name) => names.includes(name))
}

/** The job pair visible to this step; the host pair is the default because it is the standard preset. */
function visibleJobToolNames(toolSet, scope) {
  const names = visibleToolNames(toolSet, scope)
  if (names !== undefined && names.includes('at_terminal_job_output')) {
    return { output: 'at_terminal_job_output', kill: 'at_terminal_job_kill' }
  }
  return { output: 'job_output', kill: 'job_kill' }
}

/** One line naming each server and its trust, bounded so a big inventory stays one line. */
function describe(servers) {
  if (!Array.isArray(servers)) {
    return TRUST_UNREAD;
  }
  if (servers.length === 0) {
    return 'no servers are usable by this plugin';
  }
  const named = servers.slice(0, TRUST_LIMIT).map((server) => {
    const name = server?.label ?? server?.id ?? 'unnamed';
    const trust = server?.agentCommandTrust ?? 'none';
    return `${name} (${trust})`;
  });
  const rest = servers.length - named.length;
  return rest > 0 ? `${named.join(', ')}, +${rest} more` : named.join(', ');
}

/**
 * Refresh the fact from a server list that a tool just read.
 *
 * Called from `at_terminal_list_ssh_servers` rather than on a timer: the only moment the
 * plugin knows the truth is when it has just fetched it, and a background poll would keep
 * opening the state store for a string nobody asked for.
 *
 * @param {Array<{label?: string, id?: string, agentCommandTrust?: string}>} servers
 */
export function updateTrustFact(servers) {
  cachedTrust = describe(servers);
  return cachedTrust;
}

/** The current fact. Synchronous by contract — see the note about `assemble()`. */
export function trustFact() {
  return cachedTrust;
}

/**
 * Whether the section actually reached the host's registry, as one line.
 *
 * This exists because "the section is live" is otherwise unverifiable from the outside: the
 * assembled prompt is not written to the session record, and a model cannot be asked to
 * quote its own system prompt. A claim nobody can check is how a plugin ends up shipping a
 * section that silently never registers, so `ping` reports it.
 */
let sectionStatus = 'not attempted (plugin not applied)';

/** @param {string} outcome */
export function recordSectionRegistration(outcome) {
  sectionStatus = outcome;
  return sectionStatus;
}

/** @returns {string} */
export function sectionStatusText() {
  return sectionStatus;
}

/**
 * The section registration.
 *
 * `order` comes from the caller, which reads it from `ctx.systemPrompt.getSectionOrder()`:
 * the order table is owned by the host (`SECTION_ORDERS` in `dsh-system-prompt`), and a
 * literal here would be a copy that drifts. `section()` itself rejects a non-finite order,
 * so the check here only exists to fail with a message that names the cause.
 *
 * The text is a function, not a string: the host resolves it per model step against the
 * step's admitted `toolSet`. When no server-facing tool is visible the section returns empty
 * and `dsh-system-prompt` drops it, so a no-server session pays neither schemas nor guidance.
 * With no `toolSet` (registration-time inspection, older host) it stays visible — fail-open.
 *
 * @param {{ order: number }} options
 */
export function promptSection({ order }) {
  if (!Number.isFinite(order)) {
    throw new TypeError(
      'at-terminal: the prompt section needs a finite order; ctx.systemPrompt.getSectionOrder("TOOL_BASH") returned nothing'
    );
  }
  return {
    name: PROMPT_SECTION_NAME,
    order,
    text: ({ scope, toolSet } = {}) => {
      if (!hasVisibleAtTerminalTool(toolSet, scope)) return ''
      const jobs = visibleJobToolNames(toolSet, scope)
      return jobs.output === 'at_terminal_job_output' ? PROMPT_SECTION_TEXT_FALLBACK : PROMPT_SECTION_TEXT
    }
  };
}
