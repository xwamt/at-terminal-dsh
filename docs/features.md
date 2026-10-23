# Features

AT Terminal MCP combines the base AT Terminal SSH/SFTP workspace with agent-facing tools exposed through the shared **AT Series** MCP hub.

## Base AT Terminal Features

The MCP build still includes the base AT Terminal workflow:

- SSH server management.
- Password and private-key authentication.
- Host key verification and changed-host-key blocking.
- SSH terminal tabs.
- SFTP browse, upload, download, and drag upload.
- SFTP create, rename, delete, copy path, and preview.
- Local editing for remote files with upload-on-save.
- Terminal font, scrollback, semantic highlighting, and keep-alive settings.

## SSH Terminal

- Manage SSH server configurations.
- Use password or private-key authentication.
- Confirm unknown host fingerprints.
- Block changed host keys for previously trusted hosts.
- Open each SSH connection in an independent terminal tab.
- Disconnect and reconnect sessions.
- Configure terminal font, scrollback, semantic highlighting, and keep-alive behavior.

## SFTP File Management

The `SFTP Files` view follows the active SSH terminal and loads the remote login directory after connection.

Supported actions:

- Browse remote directories.
- Refresh the current directory.
- Go to the parent directory or jump to a typed remote path.
- Upload files.
- Drag files from VS Code Explorer into the SFTP view.
- Download remote files or folders.
- Create files and folders.
- Rename, delete, and copy remote paths.
- Preview remote files.
- Send `cd` commands from a remote directory to the active SSH terminal.

## Local Editing For Remote Files

Use `SFTP: Edit` to open a remote file in a local editor. The extension downloads the file, detects the language, watches saves, and uploads saved content back to the original remote path.

This workflow is useful for:

- Shell scripts.
- Python and Node.js scripts.
- Configuration files.
- Operations and deployment scripts.
- Remote files that need AI-assisted explanation or refactoring.

## MCP And Agent Tools

AT Terminal MCP publishes tools through the shared **AT Series** hub (`~/.at-series/mcp/hub.js`). The hub connects back to the running AT Terminal MCP extension bridge, so credentials and host trust stay inside the extension host.

| Tool | Type | Description |
| --- | --- | --- |
| `ping` | read-only | Reports readiness, the capabilities this build provides, and the effective settings. Reaches no remote host. |
| `list_ssh_servers` | read-only | Lists SSH servers authorized for background connections without exposing passwords or private keys. |
| `get_terminal_context` | read-only | Returns focused, default connected, connected, and known AT Terminal SSH terminal context. |
| `run_remote_command` | command | Runs a confirmed non-interactive SSH command and returns stdout, stderr, exit code, timeout, duration, and truncation metadata. Every command is confirmed unless the server is trusted and `@at-series/command-policy` proves an ordinary read. stdout/stderr each default to 64000 bytes (hard cap 256000). `run_in_background: true` hands the command to the Host's job registry instead: the call returns a job id, `job_output` reads it, and `job_kill` stops it — on the remote host, not just locally. |
| `sftp_list_directory` | read-only | Lists a remote directory through a connected AT Terminal SFTP session. Returns at most `maxEntries` (default 500, hard cap 5000) plus `truncated`/`total`; `offset` pages through large listings. |
| `sftp_stat_path` | read-only | Returns metadata for a remote file or directory. |
| `sftp_read_file` | read-only | Reads bounded UTF-8 text from a remote file. Default `maxBytes` 65536 (hard cap 262144). `offset` continues a read; a negative `offset` reads the tail of the file. Binary-looking content is rejected. |
| `sftp_write_file` | write | Writes UTF-8 text to a remote file. Existing files require `overwrite: true`. |
| `sftp_create_file` | write | Creates a new remote file, optionally with UTF-8 content. |
| `sftp_create_directory` | write | Creates a new remote directory. |
| `sftp_rename` | write | Renames or moves a remote file or directory. Both the source and destination paths require write authorization. |
| `sftp_delete` | write | Deletes a single remote file (directories are refused — for one, use `run_remote_command` with an explicit `rm`, which goes through the command policy). Always asks the user, even at full trust, and the answer is never remembered. |
| `open_monitor` | ui | Opens the monitor for hardware metrics or agent execution status: `mode: "hud"` (the default) floats it, `mode: "tab"` puts it in the right sidebar. Answers `opened: false, reason: "no-client"` when no browser panel is connected, because nothing would appear. `opened: false` with `mode: "tab"` also means the sidebar had no session to place the pane in. |
| `get_hardware_metrics` | read-only | Reads CPU, memory, disk, network throughput, and top processes for an SSH server. Its probe script is built in and bypasses the command policy engine; the call is still audited. |
| `get_agent_execution_status` | read-only | Reports the live running action, recent audit rows, and active SFTP transfers. `source: file` means the rows came from `agent-audit.jsonl` and outlived a restart; `source: memory` means they did not. |
| `job_output` | read-only | Reads what a background `run_remote_command` printed since the previous read; `wait` blocks until the job settles or the budget expires. Each call consumes what it returns. |
| `job_kill` | command | Stops a background job. For an SSH command that means SIGTERM to the remote process group and up to one second proving it is gone, so `killed` means the process ended rather than that a signal was sent. |

## Slash Commands

Two Host-side commands answer questions about the plugin itself. They run outside a model turn:
the session log records `command/run` and `command/done` and appends no assistant message, so
asking does not spend a prompt, a tool call, or a turn.

| Command | What it does |
|---|---|
| `/ssh-metrics [server id or label]` | Prints CPU, load, memory and the fullest disk for one server (the active one by default), then opens the monitoring HUD **on that server**. Says `HUD: not opened (<reason>)` when no browser panel is listening, instead of claiming a window nobody sees. |
| `/ssh-audit [rows]` | Prints the tail of the durable audit trail — time, decision, and the command or path — clamped to 50 rows. Says the trail is empty or absent rather than failing. |

Both degrade honestly: without the agent service, the audit trail, or the command registry they
answer with a sentence naming what is missing.

## Settings Page

Settings → Plugins → **AT Terminal** is a tab this plugin contributes into the host's own settings
shell (`settings.plugins.tab`); the page follows the light/dark theme because every colour on it is
a `--dsw-*` token, and its copy comes from this plugin's dictionary in both languages.

| Section | What it shows |
|---|---|
| Decisions | How the last 50 authorization decisions broke down — allowed, confirmed after a prompt, denied. Read from the same audit rows the agent reads, so the page and the agent cannot disagree. |
| Recent audit | The last ten rows of the durable trail: time, decision, and the command or path. **Copy JSON** puts the whole set on the clipboard. |
| Trusted hosts | Every stored SSH host key with its `SHA256:` fingerprint (the form `ssh-keygen -lf` prints, so it can actually be compared) and the server it belongs to. **Forget** drops it through the same server-scoped route the connection flow uses. |

Forgetting is deliberately bounded: the route resolves host and port inside one server's jump
chain, so a key is only forgettable from this page when a configured server's own address matches
it. A jump-host key, or one left behind by a removed server, says so instead of showing a button
that would silently do nothing.

## Persistent SSH Terminal (opt-in)

A second, **optional** bundle (`dsh-terminal-ssh/`) gives the model remote shells that survive
across tool calls: `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`,
`terminal_close`. Nothing in the base bundle depends on it, and a profile that does not install
it has none of these tools.

```text
terminal_open({ type: 'ssh', name: 'payment01' })   # name = server id or label
terminal_send({ sessionId, text: 'cd /srv', submit: true })
terminal_read({ sessionId, count: 50 })
terminal_close({ sessionId })
```

- **The server is chosen by `name`**, because `terminal_open` has no `serverId` parameter. An id
  or a label is accepted; a label shared by two servers is refused with both ids named, rather
  than resolved to one of them.
- **Readiness is prompt evidence.** A send settles as `stdin_read` only when the tail of the
  output actually looks like a prompt; otherwise silence settles it as `inferred_idle`, and the
  deadline as `timeout`. `inferred_idle` does not prove the command finished — the same warning
  the host's own terminal tools print.
- **Signals are refused.** `ssh2` has no pty-signal channel, so `terminal_signal` throws and
  names the two things that work: send `Ctrl+C` (`\u0003`) through `terminal_send`, or close the
  session. Reporting `delivered: true` with a made-up process group would be fabricated evidence.
- The session opens with the same server record, credentials and host-key store the panel uses,
  so a server edited in the AT Terminal tab is the server the agent connects to.

## Safety Behavior

- SFTP agent writes are authorized one directory at a time. The prompt offers `Allow Once` (the default), `Allow This Folder For 15 Minutes`, and `Allow This Folder For The Session`; no answer ever covers a directory the user was not shown.
- All SSH and SFTP connect paths verify host keys (unknown hosts prompt; changed hosts are blocked).
- Bridges publish into the AT Series registry under `~/.at-series/bridges/<hostApp>/`.
- Bridge requests validate JSON schemas and enforce a maximum body size (2 MiB).
- `run_remote_command` confirmation follows the server trust dropdown (`Trust agent remote commands`). Untrusted always asks. Limited trust loads `@at-series/command-policy@0.1.0` (pinned exact npm version, no `^`) and checks every stage of a pipeline or chain against a blocklist of state-changing programs: blocklisted stages (file writes, permissions, packages, services, `docker exec`, `iptables -F`) still ask, and a command whose name cannot be read plainly (command substitution, file redirects, unclosed quotes) always asks. Commands that miss the blocklist — including unknown commands — run without a prompt under limited trust. `# Purpose:` comments never grant authority; quoted multiline scripts and static `sudo` / `python3 -c` / `sqlite3` payloads are analyzed instead of blocked by name. Full trust never asks.
- Limited trust does not bypass SFTP write authorization. Full trust skips ordinary remote-command and SFTP write confirmation; sensitive paths are the exception — full trust still asks for those. No trust level bypasses SSH host key trust.
- A background command is confirmed **before** the job starts, never from inside it: a job runs detached from the call, so a dialog raised there would arrive with no tool call in flight and nowhere to answer. A composition without the job registry degrades the call to a foreground run and says so in `notice`.
- When more than one SSH server is connected, a call that names no server is resolved by what it can do. **Write and execute** tools (`sftp_write_file`, `sftp_create_file`, `sftp_create_directory`, `sftp_rename`, `sftp_delete`, `run_remote_command`) refuse with an error that lists every connected server, and nothing reaches any host — acting on the wrong machine returns a success that looks like evidence about the right one. **Read** tools (`sftp_list_directory`, `sftp_stat_path`, `sftp_read_file`, `get_hardware_metrics`) may still use the active terminal, and their result says `resolvedBy: "implicit"` with the candidate list; with one server connected they say `"single-connected"`. `open_monitor` is treated as a read: it pivots the panel, it does not modify anything.
- Cancelling a background command sends `SIGTERM` to the remote process group and waits for it to disappear before reporting the job as killed — closing the local SSH channel alone would leave the process running. The pid it signals comes from a file the job wrote on the remote host, named after the job id, removed before the signal is sent.
- Writes outside the directory the SFTP session was opened in are highlighted in the prompt and cannot be granted for the whole session.
- Sensitive paths (`~/.ssh`, `/etc`, `/usr`, `/root`, `*.service`, `authorized_keys`, `sudoers*`, `crontab`) always require a second confirmation and are never remembered.
- Agent SFTP sessions never escalate. A permission-denied write fails; the `sudo -n` fallback exists only in the user-driven SFTP view.
- Read tools do not return passwords, private keys, or SecretStorage values.
- SFTP reads are bounded to avoid flooding agent context with large files.
- SFTP reads, listings and stats have a 30-second deadline. A stalled channel fails with a timeout naming the path instead of returning an empty-looking result; write and delete prompts have their own 60-second budget.
- Write tools resolve remote paths and do not allow modifying the remote root path.

## Asset Import And Export

Run `AT Terminal: Export Assets` to create an encrypted `.at-terminal-assets` package containing SSH server configuration. Passwords and private key files are optional export choices and are included only when selected.

Run `AT Terminal: Import Assets` in another supported IDE or device to decrypt the package and import the selected assets. Imported private keys are stored in the extension's global storage area and server configs are updated to use those new local paths. SSH host trust records are not migrated, so the first connection after import still asks for host trust confirmation.

## UI And Theme Adaptation

- Webview form for adding and editing servers.
- Clear password and private-key authentication sections.
- Private-key selection through the file picker.
- Inline validation and saving state.
- Icons, sidebars, and forms adapt to the active IDE theme.
