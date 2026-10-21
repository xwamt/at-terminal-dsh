# AT Terminal for DeepSeek Harness

This directory holds the **dsh bundle** for AT Terminal — the third build
variant beside `base` and `mcp`. It is a normal npm package that DeepSeek
Harness loads as a plugin; it does **not** touch the VS Code extension code
path, and building or installing it must never change the `base` / `mcp`
variants.

- **Verified against:** DeepSeek Harness Desktop `0.2.1-rc.2` (the version this
  machine has installed; the tool DSL is re-checked against that install on
  every `verify` run, and the sandbox is re-extracted whenever the install
  changes — a cached sandbox from a previous release is discarded, not reused).
- **Current milestone:** M3/M4 — the Host half carries the asset, server and
  terminal services over the `webServer` channel, and the browser half is a
  built bundle reusing the VS Code variant's xterm terminal and server-form
  frontend. `CAPABILITIES` in `tools.js` remains the single source of truth
  for what the *tool* surface exposes.

## Layout

| Path | Role |
|---|---|
| `package.json` | Bundle manifest: `exports`, `dsh.bundle.patch`, `dsh.client`, icon, shipped files |
| `cordis.patch.yml` | The patch dsh applies when the bundle is selected; inserts the `at-terminal` row |
| `index.js` | **Host half** — exports `Config`, `inject` and `apply(ctx, config)`; composes tools, the platform assembly and the channel. The assembly installs itself into the shared platform registry (`src/platform/current.ts`) the domain layer reads through — the dsh counterpart of `setPlatform` in `src/extension.ts`, and the call whose absence made every terminal connect fail with `platform not installed` until a real session found it |
| `channel.js` | Host↔Client channel over `ctx.webServer`: unary RPC, SSE events, the byte-stream gauge and the terminal WebSocket (DSH-21/25). Mutating routes run a Host/Origin/`Sec-Fetch-Site`/content-type fence copied from the Harness's own `dsh-client-connection`; refusals are counted in `state.get().rejected` and logged with the request's own `host`/`origin` (never its body) |
| `tools.js` | Tool definitions as plain data, already normalized for `ctx.tools.register()`. No `@deepseek-ai/*` import, so it loads without a dsh checkout |
| `settings.js` | Settings schema, constraints and defaults. Also free of `@deepseek-ai/*` imports; the schema factory takes the schemastery instance as an argument |
| `host.bundle.js` | **Built** (committed): the TypeScript domain services (`src/platform/dsh/entry.ts`) compiled for the Host half |
| `client.js` | **Built** (committed): the browser half — `src/platform/dsh/client/**` bundled with xterm and the reused webview assets into one ModuleLoader factory |
| `esbuild.dsh.mjs` | Builds both artifacts; `--check` (wired into `verify:dsh`) fails when either is stale |
| `locale/` | Display title and description for the Plugin Manager card |
| `node_modules/` | **Vendored** runtime dependencies (`@deepseek-ai/schemastery`, `@deepseek-ai/cosmokit`), committed so a `link:`-installed bundle resolves them. Regenerate with `npm run vendor:dsh` |
| `scripts/verify.mjs` | The gate (see below) |
| `scripts/vendor.mjs` | Downloads and verifies the vendored dependencies against an exact version + sha512 lock |
| `scripts/enable-mcp.mjs` | Idempotently writes the AT Series Hub MCP row into the dsh profile (M1) |
| `scripts/probe-hub.mjs` | Talks MCP directly to the Hub with the same command/env as the profile row |
| `scripts/probe-channel.mjs` | Asks the running Host whether the channel routes and the browser half are alive |
| `scripts/lib/asar.mjs` | Reads the installed Harness `app.asar` to obtain the real `@deepseek-ai/*` packages |

## Verify

```sh
node dsh/scripts/verify.mjs
```

**Nine** independent checks; a non-zero exit fails the gate:

1. **syntax** — every shipped JavaScript file parses.
2. **manifest** — the documented bundle contract (name/version/`exports`/patch
   path/icon rules/locale), plus runtime files actually listed in `files`.
3. **patch** — `cordis.patch.yml` parses as YAML and really inserts this
   bundle's row with the expected id.
4. **deps** — every module specifier in a shipped file is statically scanned and
   must be a `node:` builtin, a relative path, or a package from the vendoring
   allowlist — and that package must really be present under
   `node_modules/`. **Any `@deepseek-ai/dsh-*` specifier fails**, with file,
   line and specifier printed.
5. **tools** — every tool definition satisfies the installed
   `ToolRuntime.register()` contract: `parameters` is exactly the normalized
   `parameterSchemaSpecToJsonSchema({})` (`{ type: 'object', properties: {} }`,
   **not** `{}`), `output.schema` is already raw JSON Schema
   (`valueSchemaSpecToJsonSchema` is the identity on it), `execute()`'s value is
   accepted by the real `validateJsonSchemaValue`, and the renderer is
   exercised.
6. **settings** — the exported `Config` schema is built with the **installed**
   `@deepseek-ai/schemastery`. It must describe exactly the eight documented
   fields, resolve the documented defaults through real `.get()` accessors,
   mark every field `.volatile()` after a JSON round-trip (the projection
   `dsh-settings` performs), and **reject** eleven illegal values — both on
   direct validation and through `~standard.validate`, the path dsh uses when
   persisting a settings edit. Boundary values must stay accepted.
7. **client** — the browser half. `dsh.client` must be declared and well-formed,
   `exports["./client"]` must resolve to a file that is also listed in `files`, the
   loader call's `id` must equal the package name, and no statement other than the
   loader call may run at script execution. The factory contract is asserted by
   **executing the built file in a sandbox**: the module scope must evaluate with
   nothing but a `window.__ModuleLoader__` stub, `navigator` and `self` (xterm's
   platform detection reads those at init; `document` stays absent so any DOM touch
   at load time throws), and the factory must hand back a plugin with `apply()` and
   an `inject` list naming `slots`, `sidebarRightTabs` and `locale`, with `react` as
   the only external it requires. All of these failure modes are silent in a
   browser — a bundle registered under the wrong name is simply never required — so
   they are asserted here rather than reviewed.
8. **bundle** — both committed artifacts (`host.bundle.js` *and* `client.js`) are
   rebuilt in memory and compared byte for byte: a `link:`-installed package runs
   no build step, so a stale artifact is the easiest way to ship code nobody wrote.
9. **theme-tokens** — the `--vscode-*` → `--dsw-alias-*` bridge carries only theme
   references (and `color-mix(...)` that resolves through one), and the whole
   stylesheet is scanned for `rgb()`/`hsl()` forms a `#rrggbb` scan cannot see. A
   literal does not follow the light/dark switch, so it is a silent theme bug.

Check 4 is static and always runs. Checks 5 and 6 extract the real
`@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` dependency closures out of
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` into
`dsh/.cache/dsh-sandbox` (git-ignored). Point `DSH_ASAR` at another archive to
verify against a different install. If no installation is found the check is
reported as **SKIP**, never as PASS.

Useful flags:

```sh
node dsh/scripts/verify.mjs --no-sandbox   # checks 1–4, 7 and 8 (5–6 need the installed Harness)
node dsh/scripts/verify.mjs --json         # machine-readable report
```

### Where the domain-layer audit lives

An earlier revision of this file carried a seventh check that swept `src/{ssh,sftp,…}`
for direct `vscode` imports. It has been **removed**, not because the rule went away but
because the rule is a property of the *repository's* kernel, not of this bundle — and
having two allowlists for one rule already caused a real drift (the list still named four
files when a fifth adapter had been added).

That audit now lives at the repository level:

```sh
npm run verify:kernel     # scripts/verify-kernel-seam.mjs, 4 checks
```

It is strictly wider than the check it replaced: the old one scanned the seven domain
directories against a hard-coded four-file list, while the new one scans **every** `.ts`
file under `src/`. Its four checks:

1. `src/core/**` imports nothing above itself — and no source file cites a `path:line`
   whose file this repository does not contain (the port layer was derived from the VS
   Code variant, so a dozen citations named `src/extension.ts:456`; the names stay as
   evidence, the dead line numbers were dropped).
2. No `src/**` file imports `vscode`, unless the importing line carries a documented
   `kernel-allow:` reason.
3. No `src/**` file **imports** `@deepseek-ai/*`. Only import statements count: the tree
   has fourteen *comments* naming those packages to explain why they are not imported, and
   a string scan would fail on the explanation.
4. The dsh composition root (`src/platform/dsh/index.ts`, which builds `createDshPlatform`)
   calls `setPlatform()`. The VS Code root is `src/extension.ts` in **another** repository,
   so it is not — and cannot be — in scope here.

Specifiers are read with the TypeScript compiler's own `preProcessFile`, not a regex, so a
comment or a template string cannot be mistaken for an import. Each check has been
negative-tested: a stray `import '../ssh/SshSession'` **and** a dead `src/extension.ts:12`
citation in `src/core`, an `import * as vscode` in `src/utils/**`, an
`import '@deepseek-ai/dsh-tools'` in `src/utils/**`, and a commented-out `setPlatform()`
call each fail it with the offending file and line. (That last one is why the check reads
the AST: a regexp matched the commented-out call and reported PASS.)

This gate keeps its subject: the bundle. Keep it that way.

The gate has been negative-tested: corrupting the patch row id, dropping
`additionalProperties` from an object output schema, loosening a settings
constraint (widening `terminalFontSize`'s `min`), adding a bare import of
`@deepseek-ai/dsh-tools` to `index.js`, and handing `register()` a `{}`
parameter schema each fail it with a precise message.

### Why check 4 exists

The first installed run of this bundle failed to load with

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
  imported from .../dsh/index.js
```

The Harness installs a local-path bundle as a `link:` dependency, so Node
resolves `dsh/index.js`'s bare specifiers by walking up from that file and can
never reach the packages inside `app.asar`. The gate did not catch it because
checks 5 and 6 import the real packages by *sandbox absolute path* — a different
resolution route from the one the Harness uses. Check 4 closes that gap, and
`@deepseek-ai/dsh-tools` is now imported nowhere in the shipped code:
`ctx.tools.register()` accepts the normalized definition directly, and the
authoring helper `defineTool` is not required at runtime.

## Vendored dependencies

The Host half needs a real schemastery schema for `Config`, and the Harness's
copy is unreachable from a `link:` install, so `npm run vendor:dsh` copies
`@deepseek-ai/schemastery@3.18.5` and its only runtime dependency
`@deepseek-ai/cosmokit@1.8.6` into `dsh/node_modules/@deepseek-ai/`. The
versions match the installed Harness exactly, the npm tarballs are
byte-identical to the in-`app.asar` copies, and both libraries tag cross-realm
objects with `Symbol.for(...)` (`"schemastery"`, `"ValidationError"`,
`"cosmokit.volatile.write"`), so a vendored schema is recognized as volatile by
the Harness's own schemastery. The script is idempotent: it verifies the
registry's `dist.integrity` against its own lock, and re-runs skip the network
when `node_modules/` already matches.

The pin is a gate, not a comment: the settings check compares the vendored
versions against the sandbox's (the install's own) and fails with
"run `npm run vendor:dsh`" when they differ, so a Harness update cannot leave a
stale copy silently validating new artifacts.

`dsh/package.json` deliberately declares **no** `dependencies`: a `link:`
install does not install them, and declaring them would misrepresent how the
bundle resolves.

### Why the sandbox exists

The official packages ship only built `lib/*.js` and are not published to npm
under this preview, so the runtime contract cannot be assumed from the
documentation. Two findings from running the real packages, both now enforced
by the gate:

- `output.schema` must be raw JSON Schema: an explicit object node must state
  `additionalProperties: true | false`, and a bare `{ type: 'object' }` is
  rejected by `assertSupportedJsonSchema` — the guard `register()` runs;
- the authoring `parameters` DSL (per-parameter `required`) is *input* to
  `defineTool`, not to `register()`. `register()` wants the compiled result, so
  `tools.js` stores normalized JSON Schema and check 5 pins it against the real
  `parameterSchemaSpecToJsonSchema`.

## Settings

The eight `sshManager.*` contributions from the extension manifest are
registered as editable dsh settings. The mechanism is **not**
`ctx.settings.installSection()` — that method does not exist (the plan
document assumed it; it was disproved against the installed Harness). What
dsh actually does:

- a plugin exports a schemastery `Config` schema; `dsh-settings` reads it from
  `entry.fiber.runtime.Config` and keeps only the fields marked `.volatile()`,
  then auto-generates the form (`autoGenerate` defaults to `true`);
- writes made through that form are re-validated against the same schema by
  `configEditor.edit()`, so the constraints in `settings.js` are a real write
  guard;
- `resolveConfig()` turns each volatile field into a stable accessor, which
  plugin code reads per call via `settings.js#readSettings` (the probe tool
  reports the effective values this way).

Because this plugin relies on the generated form, it does **not** call
`settings.configure({ auto: false }, ...)` — that is only for plugins shipping
their own page.

| Field | Schema | Rejected input |
|---|---|---|
| `terminalFontSize` | `z.natural().min(8).max(200)` | `-1`, `4.5`, `5000` |
| `terminalFontFamily` | `z.string().min(1)` | `""` |
| `scrollback` | `z.natural().min(100).max(1000000)` | `"abc"`, `10` |
| `semanticHighlight` | `z.boolean()` | `1` |
| `idleDisconnectMinutes` | `z.natural().max(10080)` (0 disables) | `-5` |
| `keepAliveInterval` | `z.natural().max(3600)` (0 disables) | `1.5` |
| `zebraStripes` | `z.boolean()` | `"yes"` |
| `sessionLogDirectory` | `z.string()` (empty disables) | `42` |

Every field also carries `.default(...)` and `.volatile()`; the defaults and the
field table live in `settings.js`, which is the single source of truth. Check 5
enforces both directions — the illegal values above must be rejected and the
inclusive boundaries (`terminalFontSize` 8 and 200, `scrollback` 100,
`idleDisconnectMinutes` 0, `keepAliveInterval` 0, `sessionLogDirectory` `""`)
must stay accepted.

## Install (Desktop)

The Desktop shell owns package management for its own profile
(`~/.dsh/profiles/desktop`); hand-editing that profile is not supported. Install
this directory as a local-path bundle through the app's Plugin Manager, then
restart the Harness so the Host half loads. `dsh/node_modules/` is committed, so
a fresh checkout needs no install step; if it is ever missing, restore it with
`npm run vendor:dsh` before installing.

Do not create preview HTML or mock shells for this plugin: the installed
plugin *is* the preview. After installing, confirm the row with the Harness's
own config dump rather than inferring success from logs.

## MCP bridge (M1)

The second thing this project needs from dsh is the Agent actually reaching AT
Terminal's remote operations. Until the Host half carries the domain itself, that
goes through the **AT Series Hub**, which is a stdio MCP server fronting every AT
Series plugin bridge registered under `~/.at-series/bridges/`.

`@deepseek-ai/dsh-mcp-client` is what mounts such a server, and it is **not part of
the default composition** — the package ships inside the Harness, and `dsh-base` and
`dsh-web-app` mount zero rows of it ("No server is enabled by default"). So the row
has to be added, once:

```sh
npm run dsh:mcp:enable     # add/refresh the row in ~/.dsh/profiles/desktop
npm run dsh:mcp:check      # same checks, print the block, change nothing
npm run dsh:mcp:disable    # remove it again
```

The script edits `~/.dsh/profiles/desktop/cordis.patch.yml` — the file whose own
header calls itself "your patch layer for this dsh profile" — by appending a block
between marker comments. Three properties are enforced rather than assumed:

- **purely additive**: the existing rows carry `!!js` expressions
  (`!!js ctx.webStartup.port ?? 3080`). A YAML round-trip would either throw on the
  custom tag or flatten it to a string, so the edit is textual, and the script
  refuses to write unless every original line survives in order. A timestamped
  `.at-terminal-backup-*` copy is written first.
- **additive in the loader's sense**: the row is wrapped in `- insert:`. The patch
  layer (`dsh-app-boot`'s `applyEntryPatches`) treats a bare `- id:` row as an
  override of an entry that must already exist — and `dsh-mcp-client` mounts zero
  servers by default, so the first version of this block (a bare row) was silently
  skipped with `patch: entry "mcp-at-series" not found` and the bridge never
  registered, no matter how often the Harness restarted. The fix is verified against
  the real `applyEntryPatches` extracted from `app.asar`: the skipped row and the
  inserted row reproduce exactly.
- **idempotent**: the managed block is stripped before being re-added, so re-running
  cannot accumulate duplicates (verified by counting the begin markers after write).
- **verified**: five install checks run first (managed Node, Hub bundle, profile,
  linked AT Terminal bundle, patch layer) and each is reported by name.

`command` is the **Harness's own managed Node**
(`~/.dsh/dsh-runtimes/<runtime>/dependencies/node/bin/node`), not a `node` from
`PATH`. `dsh-mcp-client` spawns `command` with a *scrubbed* ambient environment, so
depending on the user's `PATH` would be a guess about how the Desktop app was
launched. `HOME` is passed explicitly for the same reason.

`toolCallTimeoutMs` is raised to 120 s because the Hub sweeps **every** registered
bridge on its first cold `tools/list`: that measured over 20 s here, against 412
registry records of which 390 are abandoned; the same call answers in ~20–50 ms
afterwards. The 60 s default would have made the very first call fail. (That first
sweep is also why a naive `tools/list` probe can look like a hang.)

### The setting that is easy to get wrong

`AT_SERIES_HOST_APP` is **required, not optional**. The Hub resolves its scope with

```js
function resolveHostAppFromEnv(env) { return slugifyHostAppId(env['AT_SERIES_HOST_APP']) ?? 'unknown' }
```

and then serves exactly that bucket under `~/.at-series/bridges/`. There is **no
wildcard** — `unknown` is itself a real bucket. A Hub started without the variable
therefore serves the abandoned `unknown` records and reports `healthyBridges: 0` for
every provider, which reads as "the Hub is broken" while actually being "the setting
is missing". Measured directly:

| `AT_SERIES_HOST_APP` | what `at_list_providers` said |
|---|---|
| unset | `host=unknown`, 3 providers, `healthyBridges=0`, **no `at.terminal`** |
| `antigravity-ide` | `host=antigravity-ide`, 6 providers, each `healthyBridges=1`, **`at.terminal@0.3.5` with 11 tools** |

So `enable-mcp.mjs` **discovers** the slug — the bucket with the newest heartbeat,
via `dsh/scripts/lib/at-series-registry.mjs` — rather than assuming it, refuses to
write when nothing has heartbeated recently, and takes `--host-app <slug>` to
override. Re-run it after moving AT Terminal to a different IDE.

### What the Agent sees

The Hub speaks **protocol v2 (progressive discovery)**, so a cold `tools/list`
returns five meta-tools — `at_list_providers`, `at_search_tools`, `at_get_tool`,
`at_select_tools`, `at_clear_tool_selection` — and the Agent promotes real tools with
`at_select_tools`. Verified against the live Hub with the same command and environment
this row uses:

```
OK    host scope: antigravity-ide (detected) — 10 record(s), newest heartbeat 28s ago
      at.terminal@0.3.5(11), at.nacos@0.1.3(13), at.jumpserver@0.2.0(14), …
OK    initialize -> AT Series 0.3.4  [162ms]
OK    tools/list -> 5 tool(s)  [48ms]
```

**This corrects the plan's M1 exit criterion**, which says "11/11 工具出现在 dsh 工具
列表". With progressive discovery the Agent's tool list holds the five meta-tools; the
eleven arrive after `at_select_tools`. That is the Hub's designed flow (its own
`super-ops` skill teaches it), and forcing it flat with `AT_SERIES_TOOL_DISCOVERY=never`
would dump ~82 tools from all six registered plugins into every prompt. The criterion
should read "the eleven are reachable and callable", not "the eleven are listed".

Run `npm run dsh:mcp:probe` (or `node dsh/scripts/probe-hub.mjs`) to ask all of this
without involving dsh — it is the first thing to run when a dsh session reports no MCP
tools.

Two consequences worth knowing:

- the work is done by **the VS Code-side extension**, so an IDE window with AT
  Terminal active must be connected to the Hub — dsh is a client here, not the
  executor. That is exactly what M1 is for (a deliverable intermediate), and it is
  also why the Host-half tool port (M5) remains the real destination;
- `failOnStartupError` stays at its `false` default: a missing or empty Hub must
  degrade to "no MCP tools plus a log line", never reject activation of the profile.

## Client half (M3/M4 pipeline)

`dsh/client.js` is the browser half, declared with `"dsh": { "client": { "platform": "web", "immediately": true } }`
and shipped through `exports["./client"]`. It registers **one right-sidebar tab type** —
kind `at-terminal`, its guide entry, the pane body and the chip title — and injects the
panel's stylesheet once. Nothing else.

It is a **built artifact, not hand-written**: `node dsh/esbuild.dsh.mjs` bundles
`src/platform/dsh/client/**` — plus xterm and its addons, the reused `webview/terminal/*`
building blocks, and the three stylesheets inlined as text — into the single ModuleLoader
factory, with `react` as the only external (the browser baseline provides it). The
committed artifact is byte-checked by the gate's eighth check, same as `host.bundle.js`,
and the seventh check executes the factory in a sandbox to pin the registration shape.

The build pipeline exists for **reuse**: the panel is supposed to look and behave like the
VS Code variant, and the honest way to get there is to ship that variant's own frontend
code instead of a second, drifting imitation.

| Reused from the VS Code variant | How |
|---|---|
| `webview/terminal/*` — options, WebGL renderer with DOM fallback, search, clipboard and Ctrl+C/V semantics, focus recovery, zebra stripes, semantic highlight, theme, byte decoder + output writer with acknowledge | imported directly by `src/platform/dsh/client/xtermEngine.ts`; the engine is the ~200-line glue replacing `acquireVsCodeApi().postMessage` with the channel |
| `webview/terminal/index.css`, `webview/server-form/index.css`, `xterm.css` | imported as text and **scoped at runtime** under `.att-root` (`scopeCss()` in `styles.ts`), so no `html`/`body` rule or bare class name leaks into the Harness page |
| the `--vscode-*` theme variables those sheets read | a token bridge on `.att-root` maps each one onto its `--dsw-alias-*` Harness counterpart with a literal fallback, so the reused sheets follow the host theme (light/dark) unchanged — and the xterm theme reader reads computed styles from that same root |
| the server-form markup | the form page renders `ServerFormPanel`'s structure (`.server-form-shell` → `.form-section-grid` → auth cards → jump host → summary → `.form-footer`), styled by the original sheet |

Deliberately **not** reused: `src/webview/html.ts` (CSP/Uri injection — there is no
webview document here) and the form's "Test Connection" / "Browse…" buttons (no Host rpc
for either yet; a button that cannot work is worse than no button).

### Page layout

Four surfaces, routed inside the pane body — the assets page is a **list and nothing
else**, with management where the original plugin puts it:

- **资产 (default)** — the grouped server list. Rows carry label, `user@host:port`, the
  auth badge and the stored-password badge; no inline buttons. Toolbar: 新增 / 导入 /
  导出 / 刷新. Right-click a row: 连接 / 编辑 / 复制地址 / 删除 (behind a confirm);
  double-click connects. The status bar carries the asset summary and the real
  private-key directory.
- **表单页** — opened by 新增/编辑 in the reused markup above. Inline validation refuses
  the save before any RPC; the password field stays write-only; the trust select gates
  the background-connection checkbox exactly like the VS Code form.
- **文件** — the read-only remote file tree, following the active SSH terminal. See
  [File tree](#file-tree-dsh-23) below.
- **终端** — a real xterm terminal in the `TerminalPanel` chrome (status header with the
  state dot, reconnect button, Ctrl+F find bar). Flow control is byte-based: when
  produced-but-unrendered bytes cross 256 KiB the panel sends `terminal.pause` and the
  Host pauses the SSH channel itself (`SshSession.pauseOutput`); draining below 64 KiB
  resumes — the webview's ack semantics, now driven by xterm's write callbacks. Font,
  scrollback and highlight settings come from the live `sshManager.*` row config via
  `rpc settings.get` (the DSH-31 seam), so a settings edit applies on the next connect.
  The WebSocket address is resolved per carrier (`resolveSocketUrl`): an http(s) page
  (web GUI, LAN browser) uses its own origin; the Desktop shell serves the panel from
  `dsh-app://app` — where relative fetch is IPC-bridged but a WebSocket is not, and
  `location.host` is the unconnectable name `app` — so there the client asks the Host
  via `rpc channel.info`, which reports the real loopback port it listened on.

Field-level details, each read out of the installed Harness rather than inferred:

| Fact | Value | Where it comes from |
|---|---|---|
| loader entry | `window.__ModuleLoader__.load({ id, factory })`, `id` = package name | every official `lib/client.js`; `dsh-client-modules` keys factories by it |
| `exports["./client"]` | the authoritative resolution point; accepts a string or a one-level `{ default }` | `clientExportOf()` in `dsh-client-modules/lib/index.js` |
| `priority` | a **band**: `extension` (default) / `builtin` / `fallback` — not a sort key | `SidebarRightTabRegistry`'s `RANKS` / `coexists()` |
| coexistence | one `builtin` and one `extension` may hold the same kind; a second registration in the *same* band throws | `coexists()` in `dsh-client-ui-sidebar-right/lib/client.js` |
| `guide[]` | `order` and `title` required; `description` and `icon` optional (`icon` falls back to a cube glyph) | `EntryBox` reads `entry.icon ?? CubeGlyph` |
| body seat | `ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name, key }, Body))`, `key` = the definition `id` | `dsh-client-ui-sidebar-files/lib/client.js` |
| chip seat | `sidebar.right.pane.tab.title`, same key | same |

### Testing the browser half

`test/dsh/client-models.test.ts` unit-tests the pure modules the client is built from:
the form model and its validation, the `DshServerInput` builder (write-only password,
trust-gated background flag), list grouping, the error-code → copy mapping, base64
framing, the flow controller's thresholds and edges, the terminal frame reducer (every
protocol branch), the CSS scoper and the zh/en dictionary parity.

`test/dsh/client-bundle.test.ts` executes the **built** `dsh/client.js` in a sandbox and
drives the real Body through a small React shim: the loader registration, `apply()`'s
five registrations, idempotent style injection (and its removal on dispose), the
list-only rows with toolbar and context menu, a failed Host read rendering **as a
failure with its code** (the `services-unavailable` regression, pinned), form validation
and the exact save payload, the import/export dialog RPCs, and the terminal websocket
protocol including the pause frame at the backpressure threshold.

The file tree is covered on both sides of the wire. `test/platform/dsh/sftp.test.ts` drives
the Host face against a fake `SftpSession`: which terminal is followed, what a disconnect
leaves behind, that a live terminal beats a stale tree, that a refused host key is reported
with its code **and fingerprint** and that the record does not outlive its attempt, and that
a read failure is never reported as a connect failure. The tree's own logic is unit-tested in
`client-models.test.ts` (`flattenSftpTree`'s recursion, the `..` rules, the disconnected
collapse), and rendered end-to-end in `client-bundle.test.ts` — including that nothing is
read until the page is opened, and that a directory that cannot be read shows a coded failure
under itself while its siblings survive.

What neither can cover, honestly: the xterm engine against a real DOM (its building
blocks have their own webview tests; the assembled engine is the user's in-app
walkthrough) and real SSH bytes (needs a reachable host).

### Asset transfer — the panel's real job

The panel is an **asset import/export surface**, so a user can move their servers between
VS Code and dsh instead of rebuilding them. The Host half exposes three RPC methods on the
channel and the browser half renders them:

| method | purpose |
|---|---|
| `assets.summary` | servers, stored passwords, private-key files, and the real private-key directory |
| `assets.export` | build a package (`{filename, envelope, omissions}`); the browser writes `envelope` out verbatim |
| `assets.import` | merge a package (`{envelope, packagePassword, strategy}` → `{summary}`) |

**The format is the VS Code variant's own**, reused rather than reimplemented: `src/assets/**`
is unchanged, so a package exported here imports there and vice versa. The same goes for the
storage rules, which is what makes a transfer meaningful:

| Asset | On the VS Code side | Here |
|---|---|---|
| Server records | `globalState` key `sshManager.servers` | same key, in the `at_terminal_state` domain |
| SSH passwords / key passphrases | `SecretStorage`, `sshManager.password.<id>` / `sshManager.passphrase.<id>` | `ctx.credentials` references, same key mapping |
| Imported private keys | `<globalStorage>/imported-private-keys/<serverId>-<basename>`, mode 0600 | same directory shape under `$DSH_HOME/at-terminal/` |
| Host-key trust | **not exported** (`includesHostTrust` is a hard `false`) | unchanged — trust stays machine-local on purpose |

Because the domain layer is TypeScript and this bundle is not, the Host services are
compiled: `dsh/esbuild.dsh.mjs` bundles `src/platform/dsh/entry.ts` into the committed
`dsh/host.bundle.js`, and the gate's eighth check fails if that artifact is not the current
build of its sources. Hand-porting the format was rejected — two implementations of one
format diverge, and the whole point of the feature is that one file works on both sides.

Two failure codes exist because their remedies differ: `wrong-password` (retry with the
right password) and `unreadable-package` (the password was right and the payload is from a
format this build cannot read — retyping will not help).

End-to-end, through the compiled artifact: export two seeded servers → import into an empty
instance → both records and the SSH password arrive intact, and a wrong password answers
`wrong-password`. Record order follows `ConfigManager.saveServer`'s label sort, exactly as
in VS Code.

### File tree (DSH-23)

The 文件 page is a **read-only** tree of the followed SSH terminal's remote filesystem, and
read-only is the whole of it: no rename, no delete, no upload, no drag and drop. Those exist
in the VS Code variant and will arrive when the Host half grows the RPCs for them — a control
that cannot work is worse than no control, which is the same reason the server form ships
without its "Test Connection" button.

Three RPC methods carry it, and each maps onto exactly one `SftpManager` call:

| method | purpose |
|---|---|
| `sftp.list` | the tree's state plus one directory's entries (`path` omitted = the root) |
| `sftp.goUp` | move the tree's root up one level |
| `sftp.refresh` | drop cached listings so the next read reaches the server, not the 20s TTL cache |

`src/platform/dsh/sftp.ts` composes `SftpManager` — the same manager, listing cache and
`none | active | disconnected` state machine the VS Code tree runs — rather than deriving a
second one. Two facts it exists to absorb are worth stating, because both are invisible from
outside:

- **A rejected `verify()` loses its reason.** `createHostVerifier`
  (`src/ssh/SshConnectionConfig.ts:187-192`) does `.then(verify, () => verify(false))`, so a
  verifier that throws arrives at ssh2 as a bare `Host denied (verification failed)`. The
  terminal path reports a refusal by pushing an event frame; a unary RPC has no frame to
  push, so the refusal is **recorded** and consulted when the operation fails. It is cleared
  at the start of every operation that can open a connection, so what is read back is always
  this attempt's — a stale refusal would send the user back to a trust prompt that is already
  satisfied.
- **A read failure is not a connect failure.** `classifySshFailure` speaks about connects
  only: to it, `ENOENT` means "the private key file is missing". SFTP operations fail with a
  protocol status instead, which ssh2 gives a **numeric** `code` (`SFTP.js` tests
  `er.code === STATUS_CODE.EOF`) and renders as `No such file or directory` /
  `Permission denied`. Classifying a read through the connect path reported an unreadable
  directory as a missing private key — the classifier runs only when the failure is
  connect-shaped (a string `code` or a string `level`), and reads get their own codes
  (`sftp-no-such-file`, `sftp-permission-denied`, `sftp-read-failed`).

Which terminal the tree follows, and what a disconnect leaves behind — the two rules DSH-23's
DoD is really about:

- The tree follows the **newest live** terminal, announced to this face by
  `createDshTerminalApi`'s observer. The VS Code variant follows the *focused* terminal and
  re-syncs from a registry fed by editor events; dsh has one panel and no such events, so the
  Host half, which owns the terminals, tells this face directly. A live terminal always wins
  over a dead one: leaving a stale tree up while a live terminal exists is precisely the lie
  the DoD forbids.
- When **no** terminal is live the tree keeps showing the last listing, marked as
  disconnected, and refuses to read below the root (`sftp-disconnected`) instead of returning
  an empty list — "this directory is empty" and "nobody can look right now" must not render
  the same. A tree that never listed anything reports `none` and says "no active SSH
  terminal", which is the honest answer rather than a claim about a directory.

The client reads the Host **only once the page is visited**. `sftp.list` is the one Host read
that can open an SSH connection, and opening one because the *panel* mounted — while the user
is looking at the server list — would be a side effect nobody asked for. All the recursion
lives in `flattenSftpTree` (`src/platform/dsh/client/models.ts`), which is pure and
unit-tested without a DOM or a socket; the view maps its rows one-to-one.

Not covered by automation, honestly: a real remote filesystem. The tree is exercised against
a fake `SftpSession` (Host half) and a scripted RPC (browser half), so what is proven is the
state machine, the wiring and the rendering — not what a live server returns.

### Is the client half actually running? — `npm run dsh:channel:probe`

The browser half is the one part of this bundle that cannot be observed from outside.
The Desktop shell delivers client bundles through its own IPC carrier rather than over
`/plugins` on the web server — verified: **every** `/plugins/<pkg>/...` request returns
404 here, official packages included — and the app is not started with a
`--remote-debugging-port`, so there is no CDP endpoint to read the page's module graph
from either.

So "the sidebar tab did not appear" and "the client half never loaded" used to look
identical. They no longer do: the client half announces itself on activation with
`POST /dsh-at-terminal/rpc { method: 'client.hello' }`, the Host half records the
arrival (`rpc client.status`, and `clientHellos`/`lastClientHello` in `rpc state.get`),
and the probe script asks from outside:

```
npm run dsh:channel:probe
```

It scans every listening port for a channel, then reports one of three answers — routes
registered / browser half arrived / browser half never seen — plus the fourth case that
matters for diagnosis, "this Host half predates the announcement, restart it". The
announcement is fire-and-forget and guarded on both ends: a diagnostic must never be
able to break activation.

Run `npm run dsh:channel:probe` before believing any claim about the client half,
including one from this document.

## Roadmap

Milestones and task nodes live in the AT repository:
`docs/plans/2026-09-28-at-terminal-dsh-迁移任务计划.md`, and the feasibility
analysis in `docs/research/2026-09-28-at-terminal-迁移为DSH插件-可行性分析.md`.

Corrections that plan made on contact with the installed Harness (it assumed
`0.1.1-rc.2` and a `dsh web` CLI):

- the installed product is the **Desktop** app (`0.2.1-rc.2` as of this revision; it was
  an earlier `rc` when the plan was written), and installs go
  through the Desktop Plugin Manager, not `dsh plugin --profile web add`;
- the settings API is a schemastery `Config` export plus `.volatile()` fields,
  not `ctx.settings.installSection()` — see [Settings](#settings);
- dsh **already ships** a local-shell terminal (`dsh-terminal` +
  `dsh-api-terminal-controller` + `dsh-client-ui-sidebar-terminal`) and a file
  sidebar. AT Terminal's differentiated value is the *remote SSH* terminal and
  its asset/host-trust model, so the UI work should extend the official
  right-sidebar tab registry (`ctx.sidebarRightTabs`) instead of shipping a
  parallel terminal UI. `ctx.subprocess` accepts only one provider per
  composition, so replacing the subprocess provider to route the shipped
  terminal over SSH is not an option.
