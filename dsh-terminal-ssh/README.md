# @at-series/dsh-at-terminal-ssh

The **optional composition bundle** for [`@at-series/dsh-at-terminal`](https://www.npmjs.com/package/@at-series/dsh-at-terminal).
It adds nothing to the panel and contains no code of its own: it composes three rows so the model
can keep **one SSH shell alive across tool calls**.

```
npm install --save-exact @at-series/dsh-at-terminal-ssh
```

Normally you do not install this by hand — AT Terminal's own settings page has a switch for it, and
that switch installs exactly this package.

---

## What it gives you

Six tools, over SSH, on a shell that survives between calls:

| Tool | What it does |
|---|---|
| `terminal_open({ type: 'ssh', name: '<server>' })` | start a session on a configured AT Terminal server |
| `terminal_send` | write to it |
| `terminal_read` | read what came back (incremental, with a line range) |
| `terminal_signal` | **always errors** — `ssh2` has no pty signal channel; the message names the two workarounds |
| `terminal_close` | end it |
| `terminal_list` | what is running |

The point is state: `terminal_send { text: 'cd /tmp' }` followed by a later
`terminal_send { text: 'pwd' }` answers `/tmp`. A one-shot remote command cannot do that — each call
is a new connection with a new working directory.

## Why it is a separate package

Two of the three rows it mounts belong to the Harness, not to us
(`@deepseek-ai/dsh-terminal`, `@deepseek-ai/dsh-tool-terminal`). A dsh plugin runs from
`link:`/`node_modules` and **cannot import** a package that lives inside the app's `app.asar`; only a
composition layer can name those rows, because it is the loader — running inside the app — that
resolves them.

Splitting it out also buys two things that would be lost inside the main package:

- **Opt-in.** Installing the panel does not silently add six tools to the model's tool table. Tools
  cost prompt tokens on every request, and a user who never wants a persistent shell should not pay
  for one.
- **Atomic.** The three rows are one isolated group (`isolate.terminals`), so enabling or disabling
  it moves them together. Toggling them row by row would let a user enable the tools without the
  backend, and the resulting error is noise, not information.

## What it needs

- `@at-series/dsh-at-terminal` `^0.3.0` (declared as a peer; it exports the SSH backend this bundle
  references by subpath, so the backend lives in one place instead of being copied here)
- A DeepSeek Harness desktop build that composes `@deepseek-ai/dsh-terminal` — every 0.2.x does
- A configured server with **Allow background connections** enabled, if you want the agent's
  one-shot tools to reach it too. The persistent shell does not need that flag; the one-shot
  command and SFTP tools do.

## Enabling and disabling

The package being installed is not the same as it being active. A profile only loads the bundles
listed in `dsh.profile.bundles`, and the installer adds a newly installed bundle there automatically.
To turn it off without uninstalling, use the switch on AT Terminal's settings page (or the host's own
plugin list) — that writes the selection and reloads the composition.

Check it is running: **Settings → Plugins → `@at-series/dsh-at-terminal-ssh`** should report
**3 components running** (registry → backend → tools). Fewer than three means one of the rows did not
mount; the loader's log names which.

## What it is not

- Not a terminal multiplexer: the session belongs to the agent that opened it, and it ends with that
  session's lifetime.
- Not a replacement for `at_terminal_run_remote_command`. That tool runs one command and returns its
  output; this one keeps a shell. Use the command tool for anything that finishes, and this one when
  the point is the state between steps.

## License

MIT
