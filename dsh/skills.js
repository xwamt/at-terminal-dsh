/**
 * Three runtime skills: the procedures that are too long for tool descriptions but too
 * situational to put in the prompt section.
 *
 * What the host actually enforces, read out of `dsh-skill/lib/index.js` rather than assumed:
 *
 * - `register()` validates only `name` (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`), a non-empty
 *   `description`, and `invocation` when given (`validateRuntimeSkill`, :465). `content` is
 *   not type-checked here — it is checked when a skill is loaded.
 * - A duplicate name **logs a warning and returns a no-op disposer** (`:197-199`). That is
 *   the failure this file has to make visible: registration "succeeds" while the skill is
 *   ignored, so `ping` reports how many actually landed.
 * - `list()` returns summaries only; the body is read on invocation. So the content below
 *   costs nothing until someone asks for it.
 *
 * Content is written as procedure, not as prose: each skill says what to look at first, what
 * to do next, and how to prove it happened. The failure mode these exist to prevent is an
 * agent that runs a mutation before it has read the file it is about to change.
 */

/** What the plugin reports as registered, and what it says when it could not. */
let registrationStatus = 'not attempted (plugin not applied)';

/** The skills this bundle contributes. Names are the wire identifiers; keep them stable. */
export const RUNTIME_SKILLS = Object.freeze([
  Object.freeze({
    name: 'at-terminal-inspection',
    description:
      'Inspect a remote host through AT Terminal: read-only first, then targeted commands, with the evidence each step produced.',
    whenToUse:
      'A question about a configured SSH server — what is running, how much disk is left, why something is slow — before anyone changes anything.',
    content: `# Remote inspection through AT Terminal

## Before the first command

1. \`at_terminal_list_ssh_servers\` — confirm the server exists, is reachable, and read its \`agentCommandTrust\`. The trust level tells you whether a command will be asked about, not whether it is safe.
2. Pick the narrowest tool that answers the question. Hardware counters come from \`at_terminal_get_hardware_metrics\` (built-in probe, no shell); a command is for everything else.
3. If a terminal is already open on that host, \`at_terminal_get_terminal_context\` names it, and passing its id keeps the work in the session the user is watching.

## While running commands

- One question per command. \`ps aux | head\` answers "is it running"; \`df -h\` answers "is the disk full". A compound command that answers three things cannot be re-run cheaply and cannot be attributed when it fails.
- Read the exit code on every result. A command that printed nothing and exited 1 is not "no output" — it is a failure, and the stderr says why.
- Long output is spilled, not lost: when a result carries a \`spillPath\`, read that file with offset/limit instead of running the command again. Re-running a probe is not free on a production host.
- A background job (\`run_in_background\`) is for something that outlives the turn. Collect it with \`at_terminal_job_output\`, stop it with \`at_terminal_job_kill\`.

## Reporting

State what you ran, what it returned, and what you did **not** verify. "The service is running" and "the service is healthy" are different claims; only the first follows from \`ps\`.`
  }),
  Object.freeze({
    name: 'at-terminal-remote-edit',
    description:
      'Change a file on a remote host safely: read it first, write once, then read back what is actually there.',
    whenToUse:
      'Editing, replacing or creating a file over SFTP on a configured SSH server, especially a config file whose exact bytes matter.',
    content: `# Editing a remote file

## The order that works

1. \`at_terminal_sftp_stat_path\` — does it exist, how big is it, when did it last change. An edit that assumes the file exists fails at the write, after the user has already approved it.
2. \`at_terminal_sftp_read_file\` — read the whole file (follow \`spillPath\` if it was spilled). You cannot safely rewrite a file you have only partially seen: \`sftp_write_file\` replaces content, it does not patch it.
3. \`at_terminal_sftp_write_file\` with \`overwrite: true\` — the confirmation names the path, so a wrong path is caught by a human before it lands.
4. \`at_terminal_sftp_read_file\` again — read back the region you changed. A write that returned without error is a claim about the connection, not about the file.

## Rules that save an incident

- Never write a file you have not read in this session. "It is probably the same as last time" is how a config loses a day of someone else's changes.
- Keep unrelated content byte-for-byte: trailing newline, indentation, comment style. A diff nobody asked for is a diff someone has to review.
- Prefer a rename to an in-place rewrite when the content changes wholesale: write the new file under a temporary name, then \`at_terminal_sftp_rename\`. The old file survives a partial failure.
- \`at_terminal_sftp_delete\` refuses directories on purpose. Deleting a tree is a command (\`at_terminal_run_remote_command\`), where the policy engine can see it.

## When the write is refused

A refusal is information, not an obstacle: a sensitive path, a trust level that asks, or an overwrite the user declined. Say which one it was and stop. Retrying the same call is how a refusal turns into an argument.`
  }),
  Object.freeze({
    name: 'at-terminal-incident-log',
    description:
      'Write up what happened on a host: a timeline of commands with their exit codes, the evidence each produced, and an explicit list of what was not checked.',
    whenToUse:
      'The end of an investigation or a change on a remote host, when someone else has to be able to audit it without asking you.',
    content: `# Incident write-up

## Structure that survives review

1. **What was asked.** One sentence, the user's own words.
2. **Timeline.** Each line: time, command or tool, exit code, one-line result. The exit code is not decoration — \`0\` and \`1\` are the difference between "checked" and "assumed".
3. **Evidence.** For anything from a spilled result, cite the \`spillPath\` rather than pasting the whole file. A reader who wants the detail can open it.
4. **What changed.** Every write, rename and delete, with the path. If nothing changed, say so explicitly — an empty change list is a finding.
5. **What was not verified.** Leave this section in even when it is short. A report with no gaps claims omniscience, and nobody believes that twice.

## Sourcing the timeline

\`at_terminal_get_agent_execution_status\` reads the durable audit trail (\`agent-audit.jsonl\`): tool, reason code, exit code, duration. Prefer it to memory — it is the only record that was written at the time. Rows without a \`sessionId\` are decisions the service made (an approval, a cancellation, a kill); rows with one are what the tools did.

## Tone

Past tense, no adjectives. "Restarted nginx at 14:02; exit 0; 3 workers after" beats "successfully resolved the outage". If you are unsure whether something recovered, write the measurement, not the verdict.`
  })
]);

/**
 * Register the catalog on the host's skill service.
 *
 * @param {object} skills the `skills` service (`ctx.inject(['skills'])`)
 * @returns {{ registered: number, status: string }}
 */
export function registerRuntimeSkills(skills) {
  if (!skills || typeof skills.register !== 'function') {
    registrationStatus = 'not registered: skills service lacks register()';
    return { registered: 0, status: registrationStatus };
  }
  let registered = 0;
  for (const skill of RUNTIME_SKILLS) {
    try {
      skills.register({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        content: skill.content
      });
      registered += 1;
    } catch (error) {
      // `register()` throws on a bad name or an empty description, and *silently ignores* a
      // duplicate — so counting is the only honest answer to "did they land". The count is
      // compared against the catalog in `ping`, which is where a partial registration shows.
      registrationStatus = `registered ${registered}/${RUNTIME_SKILLS.length}: ${error instanceof Error ? error.message : String(error)}`;
      return { registered, status: registrationStatus };
    }
  }
  registrationStatus = `registered ${registered}/${RUNTIME_SKILLS.length}`;
  return { registered, status: registrationStatus };
}

/**
 * Ask the catalog whether the three names now resolve.
 *
 * `register()` returns a no-op disposer for a duplicate instead of throwing (:197-199), so a
 * successful call is not evidence that the skill landed. `list()` is the evidence: it is what
 * the tool and the prompt actually read. Reported, not thrown — a missing skill must not take
 * the plugin down with it.
 *
 * @param {object} skills
 */
export async function verifyRegisteredSkills(skills) {
  if (!skills || typeof skills.list !== "function") {
    registrationStatus = "registered; catalog unreadable (no list())";
    return registrationStatus;
  }
  try {
    const catalog = await skills.list({});
    const names = new Set((Array.isArray(catalog) ? catalog : []).map((entry) => entry?.name));
    const missing = RUNTIME_SKILLS.filter((skill) => !names.has(skill.name)).map((skill) => skill.name);
    registrationStatus =
      missing.length === 0
        ? `registered ${RUNTIME_SKILLS.length}/${RUNTIME_SKILLS.length} (catalog confirms)`
        : `registered ${RUNTIME_SKILLS.length - missing.length}/${RUNTIME_SKILLS.length}; not in catalog: ${missing.join(", ")}`;
  } catch (error) {
    registrationStatus = `registered; catalog threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  return registrationStatus;
}

/** Overwrite the status, for teardown and for the wiring to report a failed injection. */
export function recordSkillStatus(text) {
  registrationStatus = text
  return registrationStatus
}

/** @returns {string} One line for `ping`: how many skills this build actually registered. */
export function skillStatusText() {
  return registrationStatus;
}
