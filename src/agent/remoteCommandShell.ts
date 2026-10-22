import { quotePosixShellPath } from '../sftp/RemotePath';

/**
 * The command line handed to sshd for one `RemoteCommandRequest`.
 *
 * Shared with the background path rather than written twice: a background command that
 * changed directory differently from its foreground twin would make "same command, same
 * output" false, and that equality is the only cheap way to test the background path.
 */
export function wrapCommand(command: string, cwd: string | undefined): string {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) {
    return command;
  }
  return `cd ${quotePosixShellPath(trimmedCwd)} && ${command}`;
}

/**
 * Where a background command records the pid its job will have to kill.
 *
 * In `/tmp` because it must be writable by an account we nothing about, and named after
 * the job id — 16 hex characters the registry generates — so a stale file can never be
 * mistaken for the current job's. The name is the only guard against a local user on the
 * remote host pre-creating it; guessing 64 bits before the job starts is not a threat
 * this feature needs to model, and a "refuse if it exists" flag would break the kill
 * path whenever a previous run left one behind.
 */
export function pidfileFor(jobId: string): string {
  const safe = String(jobId).replace(/[^A-Za-z0-9._-]/g, '');
  return `/tmp/.at-terminal-${safe === '' ? 'job' : safe}.pid`;
}

/**
 * Wrap a command so the job can kill it later, without changing what the command *is*.
 *
 * The pid recorded is `$$` — the shell sshd started for this exec. sshd puts that process
 * in a new session, so the same number is the process-group id that every child of the
 * command inherits, which is what makes `kill -TERM -- -<pid>` reach the whole tree and
 * not just the shell. One builtin is prepended and a `;` separates it; the command line
 * afterwards is byte-identical to the foreground one, so `a && b`, pipelines and `;`
 * keep the meaning they had.
 *
 * Deliberately **not** `exec`: `exec a && b` would replace the shell with `a` and drop
 * `b`, and `exec a | b` puts `exec` on the wrong side of the pipe. Replacing the shell
 * is also unnecessary — the shell keeping its own pid is exactly what we want to record.
 */
export function backgroundScript(
  command: string,
  cwd: string | undefined,
  pidfile: string
): string {
  // `\\n` rather than `\n`: this is a template literal, so a single backslash would put a
  // real newline inside the quoted format string. printf would accept that and print the
  // same bytes, which is exactly why it has to be written deliberately.
  return `printf '%s\\n' "$$" > ${quotePosixShellPath(pidfile)}; ${wrapCommand(command, cwd)}`;
}

/**
 * The command a cancelled job runs to stop the remote process and prove it stopped.
 *
 * SIGTERM on the group first, the pid alone as a fallback (a shell that did *not* become
 * a group leader), then a bounded wait so the answer reported to the model is the truth
 * rather than "a signal was sent". The wait is `sleep 0.1` ten times: fractional sleep is
 * a GNU/BSD extension, not POSIX, but both of the platforms this runs against have it,
 * and one second is long enough for a TERM to land while staying inside a single SSH
 * round trip.
 *
 * The pidfile is removed before the signal, so a concurrent second kill cannot read it
 * and signal a pid that has already been reaped and reused.
 */
export function terminateScript(pidfile: string): string {
  const file = quotePosixShellPath(pidfile);
  return [
    `p=$(cat ${file} 2>/dev/null)`,
    `rm -f ${file}`,
    '[ -n "$p" ] || exit 0',
    `kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null`,
    'i=0',
    'while [ "$i" -lt 10 ] && kill -0 -- -"$p" 2>/dev/null; do sleep 0.1; i=$((i+1)); done',
    `if kill -0 -- -"$p" 2>/dev/null; then printf 'at-terminal-alive:%s\\n' "$p"; else printf 'at-terminal-killed:%s\\n' "$p"; fi`
  ].join('; ');
}

/**
 * Read back what {@link terminateScript} reported.
 *
 * `killed` means the process group is gone; `alive` means it survived a TERM (it may be
 * ignoring it, or wedged in the kernel); `unknown` means there was no pidfile to read —
 * usually the command finished on its own just as the cancel arrived.
 */
export function readTerminateReport(stdout: string): { killed: boolean; pid?: string } {
  const killed = /at-terminal-killed:(\d+)/.exec(stdout);
  if (killed) {
    return { killed: true, pid: killed[1] };
  }
  return { killed: false };
}
