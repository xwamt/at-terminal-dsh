# AT Terminal (DSH)

> **DeepSeek Harness (DSH) 原生 SSH 终端、SFTP 远程文件工作区与 Agent 直连运维套件。**  
> **Native SSH terminal, SFTP remote file workspace, and direct Agent ops suite for DeepSeek Harness.**

[![DSH Verified](https://img.shields.io/badge/DSH-0.2.1--rc.2_Verified-brightgreen.svg)](#installation--setup--安装与配置)
[![Test Coverage](https://img.shields.io/badge/tests-97%2F97%20passed%20(1312%20tests)-blue.svg)](#build--verification--构建与验证)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Topics](https://img.shields.io/badge/topics-dsh--plugin-purple.svg)](https://github.com/topics/dsh-plugin)

[English](#english) | [中文说明](#中文说明)

> **Release 0.2.0 (2026-10-19)** — floating monitor HUD with per-connection audit history, platform-native copy/paste shortcuts, and stricter direct tools. Full notes: [docs/releases/0.2.0.md](docs/releases/0.2.0.md).

---

<a name="english"></a>
## English

### Project Origins & Upstream Attribution
This project is an independent architecture adaptation of the open-source project [**AT Terminal (at-terminal)**](https://github.com/xwamt/At-Terminal), specifically re-engineered for **DeepSeek Harness (DSH)**.

While retaining the mature SSH terminal session engine, SFTP protocol pipeline, and security policy core from upstream, this repository completely decouples from VS Code-specific shells and redundant dependencies. It is built natively on DSH's **Cordis plugin microkernel architecture**, providing minimal resource overhead and direct Agent invocation.

> [!TIP]
> **Looking for the VS Code / Cursor version?**  
> If you are using VS Code, Cursor, or compatible AI IDEs, please visit the upstream repository:  
> 🔗 **GitHub Repository**: [https://github.com/xwamt/At-Terminal](https://github.com/xwamt/At-Terminal)  
> (Offers both the Base variant and the MCP variant backed by the AT Series Hub).

### Key Features
1. **Native Direct Agent Tools (No MCP Proxy Overhead)**:
   - Registers 15 direct tools into DSH's host context (`ctx.tools`): SSH servers, remote commands, terminal context, 8 SFTP operations, hardware metrics, agent execution status and the monitor HUD. Every tool validates its arguments and answers with an actionable message instead of a raw JavaScript error.
   - Zero-latency tool invocation without external stdio/HTTP MCP proxy processes.
   - Fully responds to `exec.signal` for real-time cancellation when an agent task is aborted.
   - Integrates seamlessly with DSH's `ctx.approval` workflow and provides formatted `output.render` rich outputs.
   - Hardware metrics report CPU, load, memory, per-mount disk usage, network throughput and top processes; the list is bounded (top 5 rows plus a count) so one Docker host cannot flood the transcript.
2. **Robust Asset Management & Encrypted Export**:
   - Supports Password, Private Key (PEM/OpenSSH with Passphrase), and SSH Agent forwarding.
   - Credentials isolation in secure local storage.
   - **AES-256-GCM** password-protected encrypted asset export and import across machines.
3. **Bastion / JumpServer Tunneling**:
   - Built-in `jumpHostId` support for tunneling into private networks through jump hosts.
   - Automated SSH channel port forwarding and strict `HostKeyVerifier` fingerprint checks.
4. **Three-Tier Trust Levels & Background Execution**:
   - **Untrusted (`none`)**: Strict confirmation required for every command and file modification.
   - **Policy-based (`policy`, recommended)**: Evaluated by `@at-series/command-policy`. Safe queries (`uptime`, `df -h`) run smoothly; sensitive/destructive commands trigger approvals; unauthorized escalations are blocked.
   - **Trusted (`full`)**: Auto-approves commands for automated pipelines (destructive warnings still active).
   - **Background Connections (`backgroundConnectionAllowed`)**: Allows agents to spin up headless background SSH/SFTP sessions when no terminal tab is active.
5. **Layered Safety Warnings & Approval Modals**:
   - Standard approvals for policy-gated operations.
   - **Destructive Command Warnings**: Prominent `⚠️ Destructive command warning: this command appears destructive!` badges and risk summaries for commands like `rm -rf` or disk formatting.
   - Sensitive remote write warnings for critical system paths (e.g., `/etc`).
6. **WebGL Accelerated Terminal Frontend**:
   - High-performance xterm 5.5 rendering with WebGL acceleration.
   - Semantic highlighting, zebra stripes, and automated color contrast adjustments.
7. **Floating Monitor HUD**:
   - Connects as a capsule (CPU / memory chips) instead of a window that covers the terminal, then expands into Overview, Hardware and Agent execution tabs.
   - Per-connection audit history: the Agent tab shows the four most recent rows, while **History** reveals everything this connection recorded and resets on disconnect.
   - Long commands and container mount paths clip to one line with an expand control, so the panel never scrolls sideways.
8. **Platform-Native Shortcuts**:
   - Copy, paste and find follow the operating system: `⌘C` / `⌘V` / `⌘F` on macOS, `Ctrl+C` / `Ctrl+V` / `Ctrl+F` on Windows and Linux.
   - On macOS `Ctrl+C` stays a shell interrupt instead of becoming "copy"; the DSH shortcut registry binds `primary`, so new-tab and page switches map the same way.
9. **Optional Persistent SSH Terminals** (second, opt-in bundle — not installed by default):
   - Adds a `type: "ssh"` backend to dsh's own `ctx.terminals`, so the six built-in `terminal_*` tools drive a **remote** shell: `terminal_open({ type: "ssh", name: "payment01" })`, then `terminal_send` / `terminal_read`, and `cd` survives between calls.
   - `name` is the server selector (server id first, then label; an ambiguous label is refused rather than guessed), because the official tool takes no `serverId`.
   - Composed as `cordis:group` + `isolate: { terminals: true }`, so a profile without it is byte-for-byte unaffected, and the right-sidebar terminal (a different subsystem) keeps its own registry.

### Installation & Setup

#### Method 1: Installing via DSH CLI (Recommended)
You can directly install the plugin using DeepSeek Harness's CLI:
```sh
# Install under default/current profile
dsh plugin add github:xwamt/at-terminal-dsh

# Or install explicitly to desktop profile
dsh plugin --profile desktop add github:xwamt/at-terminal-dsh

# Or install explicitly to web profile
dsh plugin --profile web add github:xwamt/at-terminal-dsh
```
*Note: Harness will automatically clone the repository, read the `dsh.bundle` manifest from `package.json`, and insert the `cordis.patch.yml` layer into your profile.*

#### Method 2: Installing via DSH Desktop UI (Local Bundle)
1. Launch DeepSeek Harness Desktop.
2. Open **Settings -> Plugin Manager**.
3. Select **Install Local Bundle** (从本地路径安装).
4. Enter the absolute path to the bundle directory:  
   `/path/to/at-terminal-dsh/dsh`
5. Restart DeepSeek Harness to load the host runtime and tools.

#### Method 3: One-Click Install via dsh-market (Community Marketplace)
This plugin is officially listed in [awesome-dsh-plugin / dsh-market](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):
1. Open the **dsh-market** plugin inside DeepSeek Harness Settings.
2. Navigate to the **Remote** category or search for `at-terminal-dsh`.
3. Click **Install** for one-click installation and automatic configuration.

#### Optional bundle: persistent SSH terminals
The `terminal_*` family is a **separate** package ([`@at-series/dsh-at-terminal-ssh`](https://www.npmjs.com/package/@at-series/dsh-at-terminal-ssh)),
because it changes the composition rather than adding to this one. **Installing this plugin does not
install it** — that is deliberate: it would put six more tools in every user's tool table, and tools
cost prompt tokens on every request.

Two ways to add it:

**From the panel (no terminal needed).** *Settings → Plugins → AT Terminal → 持久终端（可选）*
renders one row: **Install** when the package is missing, **启用 / 停用** once it is there, and the
number of running components when it is active. The install pulls the exact version that pairs with
the running plugin, from npm.

**By hand.** Same two commands as any other bundle:

```sh
npm install --save-exact @at-series/dsh-at-terminal-ssh   # or:
dsh plugin --profile desktop add @at-series/dsh-at-terminal-ssh
```

then add it to your profile's `dsh.profile.bundles` (the plugin manager writes that entry when it
does the install; a manual `npm install` needs it added yourself).

It requires this package (`@at-series/dsh-at-terminal`) at the same minor version — the bundle
references its SSH backend by subpath (`@at-series/dsh-at-terminal/terminal-backend`), so the
backend lives in one place instead of being copied. It borrows this plugin's server list, stored
credentials and SSH layer; it has none of its own, and `terminal_open` says so if you disable AT
Terminal afterwards.

Verify it took: **Settings → Plugins → @at-series/dsh-at-terminal-ssh** should list three running
components (`dsh-terminal` → `…/terminal-backend` → `dsh-tool-terminal`). Turning it off is the same
switch: those three rows move together, which is why the capability is a bundle and not three
independently toggled rows.

### Direct Agent Tools List

| Tool Name | Category | Description |
| :--- | :--- | :--- |
| `at_terminal_ping` | Probe | Report readiness, capabilities, and the effective settings; reaches no remote host |
| `at_terminal_list_ssh_servers` | Assets | List configured SSH hosts, connection status, and trust level |
| `at_terminal_get_terminal_context` | Context | Get the focused, connected, and known terminal sessions |
| `at_terminal_run_remote_command` | Execution | Run a non-interactive command under the server's trust level and the command policy |
| `at_terminal_sftp_list_directory` | SFTP | List a remote directory with pagination (`offset` / `maxEntries`) |
| `at_terminal_sftp_stat_path` | SFTP | Inspect type, size, permissions, and modification time |
| `at_terminal_sftp_read_file` | SFTP | Read bounded UTF-8 text with `offset` and `maxBytes` |
| `at_terminal_sftp_write_file` | SFTP | Write UTF-8 text after write authorization; existing files need `overwrite: true` |
| `at_terminal_sftp_create_file` | SFTP | Create a remote file, optionally with initial content |
| `at_terminal_sftp_create_directory` | SFTP | Create a remote directory after write authorization |
| `at_terminal_sftp_rename` | SFTP | Move or rename a path; source and destination both need write authorization |
| `at_terminal_sftp_delete` | SFTP | Delete a single file. Directories are refused — use `at_terminal_run_remote_command` with an explicit `rm` for one; the user always confirms |
| `at_terminal_open_monitor` | UI | Open the monitor — `mode: "hud"` (default) floats it, `mode: "tab"` puts it in the right sidebar; answers `opened: false, reason: "no-client"` when no panel is connected |
| `at_terminal_get_hardware_metrics` | Metrics | Read CPU, memory, disk, network, and top processes for an SSH server |
| `at_terminal_get_agent_execution_status` | Audit | Report the live action, recent audits (with `source: file \| memory`), and active transfers |
| `at_terminal_job_output` | Reads what a background command has printed since the last read, with `wait` to block until it settles or the budget expires. Each call consumes what it returns |
| `at_terminal_job_kill` | Stops a background command: SIGTERM to the remote process group, then up to a second proving it is gone, so a reported kill means the process ended |

---

<a name="中文说明"></a>
## 中文说明

### 项目渊源与版本指引
本项目脱胎于开源项目 [**AT Terminal (at-terminal)**](https://github.com/xwamt/At-Terminal)，是专为 **DeepSeek Harness (DSH)** 设计的独立架构适配版本。

在保留原项目出色的 SSH 终端会话、SFTP 文件引擎及安全策略内核的基础上，本项目彻底解耦并剥离了 VS Code 专属外壳与无用依赖，深度拥抱 DSH 的 **Cordis 插件微内核体系**，实现了极简的资源开销与更丝滑的 Agent 直连体验。

> [!TIP]
> **需要 VS Code / Cursor 版本的插件？**  
> 如果您是在 VS Code、Cursor 或其他兼容 IDE 中寻找 SSH 终端管理或 MCP 工具扩展，请前往原项目仓库获取：  
> 🔗 **GitHub 仓库**：[https://github.com/xwamt/At-Terminal](https://github.com/xwamt/At-Terminal)  
> 该仓库提供面向 VS Code 的基础版（Base）及通过跨进程 MCP Hub 桥接的增强版（MCP Variant）。

### 核心特色功能

#### 1. DSH Agent 原生直连工具链（无需 MCP 跨进程中转）
传统的 AI IDE 往往依赖独立的 stdio/HTTP MCP Server 进程进行中转，存在进程通信开销大、状态同步复杂、生命周期脱节的问题。
- **Cordis 原生接入**：直接在 DSH 宿主上下文（`ctx.tools`）中注册 17 个直连工具，覆盖 SSH 服务器、远程命令（含后台作业与作业控制）、终端上下文、8 个 SFTP 操作、硬件指标、Agent 执行状态与监控面板，DSH Agent 可零延迟直接调用。每个工具都会校验参数并返回可操作的错误信息，而不是裸的 JavaScript 异常。
- **运行期技能与提示词**：通过 `ctx.inject(['skills'])` 注册三个运行期技能（巡检 / 远端编辑 / 故障记录），工具规则集中在一个提示词段里，工具定义体积比逐条描述小 45%。
- **多服务器不猜目标**：同时连着多台服务器时，写类 / 执行类工具没拿到 `serverId` 会直接报错并列出候选（打错机器的写入会返回看起来成功的 `exitCode: 0`）；读类工具仍跟随活动终端，但结果里带 `resolvedBy` 与 `candidates`，事后能查「这次打到哪台、怎么定的」。
- **全生命周期协同**：
  - **动态取消响应**：完全感知 `exec.signal`，当用户在 DSH 界面点击停止生成或取消任务时，远端 SSH 命令与传输流立即被精确中断。
  - **原生审批通道**：无缝对接 DSH 的 `ctx.approval` 交互机制。
  - **富文本渲染**：每个工具均配套专属的 `output.render` 格式化呈现，在 DSH 对话流中输出清晰美观的状态块与日志。

#### 2. 强大的资产管理与安全加密
- **多认证方式支持**：支持密码认证（Password）、私钥文件认证（PrivateKey，支持 OpenSSH/PEM 及带 Passphrase 加密私钥）和本机 SSH Agent 密钥代理。
- **凭据安全隔离**：敏感凭据通过本地安全存储隔离，杜绝在工作区明文暴露。
- **资产包加密导入/导出**：提供基于 **AES-256-GCM** 加密的资产备份与迁移方案。运维团队可以通过加密密码对资产清单进行导出与跨机器导入，兼顾便捷与资产安全。

#### 3. 跳板机穿透连接（Bastion / JumpServer）
- **多级内网穿透**：针对企业生产环境常见的内外网隔离网络架构，支持为目标服务器绑定跳板机（`jumpHostId`）。
- **原生隧道转发**：通过跳板机节点自动建立 SSH Channel 端口隧道直接连接内网目标服务器，无需手动在终端配置复杂的 `ProxyJump` 或 SSH config。
- **严格的主机密钥校验**：穿透链路同样进行 `HostKeyVerifier` 指纹核对，防范中间人劫持风险。

#### 4. 三级信任体系与后台连接机制
每台服务器均可配置精细的 Agent 访问权限模型，平衡自动化效率与系统安全：
- **三级信任模型（Trust Levels）**：
  - **完全不信任（`none` / Untrusted）**：对 Agent 保持最高警戒，任何命令执行与文件写入均强行拦截，必须由用户弹窗手动确认。
  - **策略访问（`policy` / Policy-based，推荐）**：接入内置的 `@at-series/command-policy` 策略引擎。常规无害的查询命令（如 `uptime`、`df -h`、`cat`、`free` 等）依据策略规则放行；修改配置或危险命令触发审批；高危提权命令直接拦截。
  - **完全信任（`full` / Trusted）**：命令免弹窗直接放行（破坏性命令仍保留危险保护机制），适用于测试沙盒或自动化高频运维场景。
- **允许后台连接（Background Connections）**：
  - 开关属性：`backgroundConnectionAllowed`。
  - 开启后，即便用户当前没有在 DSH 界面中激活或聚焦该主机的终端标签页，Agent 也能在后台自动建立按需 SSH/SFTP 会话执行排查与任务，并在任务完成后妥善回收连接，赋能全自动 Agent 运维。

#### 5. 层次化安全提示与醒目弹窗机制
在调用工具时，插件会向 DSH 界面触发不同安全级别的确认与警告弹窗：

| 场景 | 弹窗展示形态 | 触发条件与防护目的 |
| :--- | :--- | :--- |
| **标准操作确认** | 标题：`Remote command requires confirmation`<br>展示：服务器标签、目标 IP、执行命令文本 | 处于 `none` 信任级别，或处于 `policy` 级别且命中需要人工复核的常规修改命令。 |
| **破坏性命令警告** | 标题带醒目标识：<br>`⚠️ Destructive command warning: this command appears destructive!`<br>附带详细的 `Risk Summaries` 风险分析清单 | Agent 意图执行可能造成系统崩溃、数据丢失的高危命令（如 `rm -rf`、`mkfs`、格式化分区、清空系统目录等），强制醒目提示用户核验参数。 |
| **敏感远程写二次确认** | 标题：<br>`⚠️ Sensitive remote write warning`<br>展示：目标敏感文件路径与修改意图 | 针对敏感配置文件（如 `/etc/`、系统服务 unit 等）的 SFTP 覆盖或修改操作，防止误改关键系统环境。 |

#### 6. 原生 WebGL 加速终端与多会话管理
- **高性能前端渲染**：基于 `@xterm/xterm` 5.5 及 WebGL 插件，在 DSH 客户端界面流畅渲染海量日志与高频输出。
- **增强视觉体验**：集成终端语义高亮（Semantic Highlight）、斑马纹交替行底色（Zebra Stripes）、多配色方案对比度自动校正。
- **多标签会话管理**：原生多会话 Tab 自由切换与断线重连保障。

#### 7. 监控悬浮窗（胶囊 / 总览 / 历史）
- **连接即胶囊**：连接服务器后悬浮窗以胶囊形态出现（CPU / 内存小条），不再默认展开挡住终端；点击展开为「总览 / 硬件指标 / Agent 执行」三页。
- **两种呈现**：`at_terminal_open_monitor` 的 `mode: "hud"` 浮窗、`mode: "tab"` 落到右侧栏页签（页签自带目标服务器，不会被「最近连接的那台」顶掉）。
- **按连接隔离的审计历史**：Agent 执行页默认展示最近 4 条审计，「历史执行」可查看本次连接以来的全部记录，断线或重连后自动重置。
- **长内容折叠**：超长命令与容器挂载路径单行省略并提供展开按钮，面板不再出现横向滚动。

#### 8. 设置页（决策统计 / 审计 / 信任库）
- **宿主原生位置**：设置 → 插件 → **AT Terminal**，是贡献进宿主设置外壳的一个 tab，不另开页面；颜色全部走 `--dsw-*` token，跟随明暗主题，文案中英双字典。
- **决策统计**：最近 50 条授权判定的分布（放行 / 弹窗后确认 / 拒绝），与 Agent 读的是同一批审计行。
- **信任库**：列出每条已保存的 SSH 主机密钥与 `SHA256:` 指纹（与 `ssh-keygen -lf` 同形可直接比对），可按服务器「忘记」；跳板机或被删服务器的残留密钥会写明原因，而不是给一个按下去没反应的按钮。

#### 9. 跟随操作系统的快捷键
- **复制 / 粘贴 / 查找按平台映射**：macOS 为 `⌘C` / `⌘V` / `⌘F`，Windows 与 Linux 为 `Ctrl+C` / `Ctrl+V` / `Ctrl+F`。
- **不抢占终端语义**：macOS 上 `Ctrl+C` 仍是 SIGINT；`⌘V` 走浏览器原生 paste 事件，无需额外的剪贴板读权限。
- **统一的主修饰键**：新建标签与页面切换通过 DSH 快捷键注册表的 `primary` 语义绑定，macOS 自动为 Command、其他平台为 Control。

#### 10. 持久 SSH 终端（可选 bundle，默认不装）
- **跨调用存活的远端 shell**：另装 `@at-series/dsh-at-terminal-ssh` 后，模型可用 `terminal_open({type:'ssh', name:'<服务器 id 或名称>'})` 开一个会话，`terminal_send` / `terminal_read` / `terminal_close` 连续操作——适合需要保持 `cd`、REPL、长任务的场景。`at_terminal_run_remote_command` 做不到这件事，它每条命令一条通道。
- **复用宿主自己的 `ctx.terminals`**：给 DSH 内置的六个 `terminal_*` 工具接一个 `type: "ssh"` 后端，而不是另写一套终端工具——工具的返回形状、截断、`wait` 语义都跟着宿主走，宿主升级我们也跟着走。
- **`name` 就是服务器选择器**：官方工具没有 `serverId` 参数，所以按「id 优先、名称其次」匹配，**同名两台直接报错并列出两个 id**（不替使用者挑一台）。
- **隔离而非侵入**：组合成 `cordis:group` + `isolate: { terminals: true }`，不装它的 profile 完全不受影响，装上也不会和右侧栏终端（另一套子系统）抢同一个注册表。
- **诚实边界**：就绪只认「看到提示符」，否则只能算 `inferred_idle`；`terminal_signal` 直接拒绝（`ssh2` 无 pty 信号通道，改用 `Ctrl+C` 或关闭会话）。
- **怎么装**：**设置 → 插件 → AT Terminal → 持久终端（可选）** 一行搞定（安装 / 启用 / 停用），或自己装：
  `npm install --save-exact @at-series/dsh-at-terminal-ssh`。**装主插件不会自动带上它**——那会给每个用户的工具表平白加 6 个工具，而工具是要按请求付 prompt token 的。

---

### 构建产物与 DSH 插件安装指引

#### 1. 构建产物说明
执行构建后，将在 `dsh/` 目录中生成供 DSH 运行的完整 bundle 产物：
- [`dsh/host.bundle.js`](dsh/host.bundle.js)：宿主端核心 Bundle（汇聚 SSH 会话管理器、SFTP 协议引擎、安全策略评估器等）；
- [`dsh/client.js`](dsh/client.js)：DSH 前端界面 Bundle（侧边栏 Tab 视图、面板与样式），首屏只取这一份；
- [`dsh/client.xterm.js`](dsh/client.xterm.js)：按需加载的终端渲染 chunk（xterm 及其 addon，约 600 KB），首次打开终端面板才拉取；
- [`dsh/policy-assets/`](dsh/policy-assets/)：安全策略规则库与白名单资产包；
- [`cordis.patch.yml`](cordis.patch.yml)：DSH 插件规范清单与 Cordis 注入补丁。

#### 2. 常用构建与验证命令

```bash
# 1. 编译构建宿主与客户端 Bundle
npm run build

# 2. 执行 DSH 官方规范契约校验 (11 项自动化合规规则全部检查)
npm run verify:dsh

# 3. 执行仓库内核隔离校验 (4 项：src/core 自封闭 / 零 vscode / 零 @deepseek-ai 导入 / 组合根调 setPlatform)
npm run verify:kernel

# 4. 运行全量自动化测试套件 (vitest；文件与用例数会随改动增长，故不在此写死)
npm run test

# 5. 执行 TypeScript 静态类型检查 (零报错)
npm run typecheck

# 6. 校验/更新 vendored 依赖 (@deepseek-ai/schemastery 等)
npm run vendor:dsh

# 7. 发布两个包（默认只做配对检查 + 跑四道门禁并打印计划，加 --publish 才真发）
npm run release
npm run release -- --publish --tag
```

> **发布为什么是一个命令**：本仓库发的是**两个** npm 包（插件 + 可选组合包）。组合包按 subpath
> 引用插件的 `terminal-backend`，所以两者版本必须同步——只发插件不算发版。`release` 脚本会先校验
> 「版本一致 + peer 范围接受该版本」，不一致直接拒绝；已在 registry 上的版本会跳过，重复跑是安全的。

#### 3. 安装插件到 DeepSeek Harness

> [!IMPORTANT]
> **三种安装方式**：
>
> **方式一：通过 DSH 命令行一键添加（最推荐，任意设备通用）**
> ```sh
> # 默认/当前配置下安装
> dsh plugin add github:xwamt/at-terminal-dsh
>
> # 或指定 desktop 桌面配置文件安装
> dsh plugin --profile desktop add github:xwamt/at-terminal-dsh
>
> # 或指定 web 配置文件安装
> dsh plugin --profile web add github:xwamt/at-terminal-dsh
> ```
> *说明：Harness 会自动拉取 GitHub 仓库，读取 `package.json` 中的 `dsh.bundle` 清单并自动将 `cordis.patch.yml` 注入到当前 Profile 中。*
>
> **方式二：桌面端本地目录加载（适合本机开发与即时生效）**
> 1. 打开 DeepSeek Harness 客户端；
> 2. 进入 **设置 -> 插件管理 -> 安装本地插件 / 导入本地包**；
> 3. 填写本机的 Bundle 绝对路径：  
>    `/path/to/at-terminal-dsh/dsh`  
> 4. 安装完成后彻底重启 DSH 即可生效。
>
> **方式三：通过 dsh-market 社区插件市场一键安装**  
> 本插件已提交至官方插件索引 [awesome-dsh-plugin (PR #7178)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7178)：
> 1. 在 DeepSeek Harness 中打开 `dsh-market` 插件市场；
> 2. 在 **Remote（远程与运维）** 分类下搜索 `at-terminal-dsh`；
> 3. 点击 **安装** 按钮即可一键完成装载与自动配置。

---

### DSH 创造套件技能体系（Skills）

项目根目录的 [`skills/`](skills/) 文件夹中收录了深度适配的技能集。这些技能文件**完全脱胎于 DeepSeek Harness 官方的「创造模式」（preset id = cordis）规范**：

```text
skills/
├── dsh-creator-skills/            # DSH 创造模式全局指引与架构全景入口
├── cordis-plugin-development/     # Cordis 插件生命周期、UI 装饰与右侧面板开发规范
├── editing-cordis-compositions/   # Preset 编排、Agent 预设配置与分层 patch 机制
├── cordis-composition-reference/  # Loader YAML 方言参考与 Harness 内部核心模块清单
├── agent-experience/              # 面向 AI Agent 的工具 Schema 设计与调用体验规范
└── writing-ops-documents/         # 规范化中文运维记录、巡检排障与 RCA 报告编写技能
```

**跨 Agent 复用价值**：如果在 Claude Code、Codex、Cursor Agent、Antigravity 等其他 Agent 环境中开发任何 DSH 系列插件或扩展，可直接将本目录挂载给 Agent，作为编写 Cordis 插件与设计 Agent 直连工具的权威规范。


---

## License & 致谢

- 本项目基于 [MIT 许可证](LICENSE) 开源发布。
- 特别鸣谢上游开源项目 [AT Terminal (at-terminal)](https://github.com/xwamt/At-Terminal) 提供的坚实 SSH/SFTP 基础！
