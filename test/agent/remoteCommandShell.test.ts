import { describe, expect, it } from 'vitest';
import {
  backgroundScript,
  pidfileFor,
  readTerminateReport,
  terminateScript,
  wrapCommand
} from '../../src/agent/remoteCommandShell';

describe('wrapCommand', () => {
  it('leaves the command untouched when there is no working directory', () => {
    expect(wrapCommand('uptime', undefined)).toBe('uptime');
    // Whitespace-only is the same absence, not a `cd ''`.
    expect(wrapCommand('uptime', '   ')).toBe('uptime');
  });

  it('prefixes a quoted cd, so a path with a space stays one argument', () => {
    expect(wrapCommand('ls', '/var/log/nginx')).toBe("cd '/var/log/nginx' && ls");
    expect(wrapCommand('ls', '/tmp/a b')).toBe("cd '/tmp/a b' && ls");
    expect(wrapCommand('ls', "/tmp/it's")).toBe(`cd '/tmp/it'"'"'s' && ls`);
  });
});

describe('pidfileFor', () => {
  it('names the file after the job id, which is what makes it unique', () => {
    expect(pidfileFor('ssh-command-0123456789abcdef')).toBe(
      '/tmp/.at-terminal-ssh-command-0123456789abcdef.pid'
    );
  });

  it('strips anything a shell would treat as syntax, and still yields a path', () => {
    expect(pidfileFor('a/../../etc/passwd')).toBe('/tmp/.at-terminal-a....etcpasswd.pid');
    // A registry id is never empty or all-punctuation, but a path that hinges on that
    // being true is a path that breaks silently the day it is not.
    expect(pidfileFor('---')).toBe('/tmp/.at-terminal----.pid');
    expect(pidfileFor('')).toBe('/tmp/.at-terminal-job.pid');
  });
});

describe('backgroundScript', () => {
  it('records the pid and then runs the command byte-identically', () => {
    const script = backgroundScript('ps aux | head', undefined, pidfileFor('job-1'));
    // The recorded pid is the shell sshd started, which setsid() makes the process-group
    // id every child inherits — that is what the group kill needs.
    expect(script).toBe(`printf '%s\\n' "$$" > '/tmp/.at-terminal-job-1.pid'; ps aux | head`);
  });

  it('keeps the working directory exactly as the foreground path does', () => {
    const script = backgroundScript('ls', '/srv/app', pidfileFor('job-2'));
    expect(script.endsWith("; cd '/srv/app' && ls")).toBe(true);
  });

  it('never rewrites the command with exec, which would change what it means', () => {
    // `exec a && b` would replace the shell with `a` and drop `b`; the wrapper must not
    // introduce one, however convenient it looks.
    for (const command of ['a && b', 'a | b', 'a; b', 'a & b']) {
      const script = backgroundScript(command, undefined, pidfileFor('job-3'));
      expect(script.includes('exec ')).toBe(false);
      expect(script.endsWith(`; ${command}`)).toBe(true);
    }
  });
});

describe('terminateScript', () => {
  it('reads the pidfile, deletes it before signalling, then signals the group', () => {
    const script = terminateScript('/tmp/.at-terminal-job-4.pid');
    const read = script.indexOf("cat '/tmp/.at-terminal-job-4.pid'");
    const remove = script.indexOf("rm -f '/tmp/.at-terminal-job-4.pid'");
    const signal = script.indexOf('kill -TERM');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(read);
    // Removing first is what stops a second concurrent kill from reading the number and
    // signalling a pid that has since been reaped and reused.
    expect(signal).toBeGreaterThan(remove);
    expect(script).toContain('kill -TERM -- -"$p"');
    // The single-pid fallback covers a shell that never became a group leader.
    expect(script).toContain('|| kill -TERM "$p"');
  });

  it('waits a bounded time instead of reporting a signal as a death', () => {
    const script = terminateScript('/tmp/.at-terminal-job-5.pid');
    expect(script).toContain('sleep 0.1');
    expect(script).toContain('kill -0 -- -"$p"');
    expect(script).toContain("printf 'at-terminal-alive:%s");
    expect(script).toContain("printf 'at-terminal-killed:%s");
  });

  it('never signals anything when the pidfile is missing', () => {
    const script = terminateScript('/tmp/.at-terminal-job-6.pid');
    // The guard sits between the read and the signal, so an empty pid can never reach
    // `kill -- -""`.
    expect(script.indexOf('[ -n "$p" ] || exit 0')).toBeLessThan(script.indexOf('kill -TERM'));
  });
});

describe('readTerminateReport', () => {
  it('reports a kill only when the group is gone', () => {
    expect(readTerminateReport('at-terminal-killed:4242\n')).toEqual({ killed: true, pid: '4242' });
    expect(readTerminateReport('at-terminal-alive:4242\n')).toEqual({ killed: false });
    // An empty answer means there was no pidfile: the command had already finished.
    expect(readTerminateReport('')).toEqual({ killed: false });
    expect(readTerminateReport('some other output')).toEqual({ killed: false });
  });
});
