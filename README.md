# AT Terminal (DSH)

> **DeepSeek Harness (DSH) 原生 SSH 终端、SFTP 远程文件工作区与 Agent 直连运维套件。**  
> **Native SSH terminal, SFTP remote file workspace, and direct Agent ops suite for DeepSeek Harness.**

[![DSH Verified](https://img.shields.io/badge/DSH-0.1.7--rc.2_Verified-brightgreen.svg)](#installation--setup--安装与配置)
[![Test Coverage](https://img.shields.io/badge/tests-75%2F75%20passed%20(923%20tests)-blue.svg)](#build--verification--构建与验证)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Topics](https://img.shields.io/badge/topics-dsh--plugin-purple.svg)](https://github.com/topics/dsh-plugin)

[English](#english) | [中文说明](#中文说明)

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
   - Registers 12 operations tools directly into DSH's host context (`ctx.tools`).
   - Zero-latency tool invocation without external stdio/HTTP MCP proxy processes.
   - Fully responds to `exec.signal` for real-time cancellation when an agent task is aborted.
   - Integrates seamlessly with DSH's `ctx.approval` workflow and provides formatted `output.render` rich outputs.
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

### Installation & Setup

#### Installing via DSH CLI
```sh
dsh plugin add github:<owner>/at-terminal-dsh
```

#### Installing via DSH Desktop UI
1. Launch DeepSeek Harness Desktop.
2. Open **Settings -> Plugin Manager**.
3. Select **Install Local Bundle** (从本地路径安装).
4. Enter the absolute path to the bundle directory:  
   `/path/to/at-terminal-dsh/dsh`
5. Restart DeepSeek Harness to load the host runtime.

### Direct Agent Tools List

| Tool Name | Category | Description |
| :--- | :--- | :--- |
| `at_terminal_ping` | Probe | Check plugin readiness, version, and effective settings |
| `at_terminal_list_ssh_servers` | Assets | List configured SSH hosts and connection status |
| `at_terminal_get_terminal_context` | Context | Get active focused terminal session and window info |
| `at_terminal_run_remote_command` | Execution | Safely run remote commands under policy and approval |
| `at_terminal_sftp_list_directory` | SFTP | List remote directory tree with metadata |
| `at_terminal_sftp_read_file` | SFTP | Read remote file content with offset and truncation |
| `at_terminal_sftp_write_file` | SFTP | Write or append remote file protected by authorizer |
| `at_terminal_sftp_stat_path` | SFTP | Inspect path existence, permissions, and stats |
| `at_terminal_sftp_create_directory` | SFTP | Create remote directory structures recursively |
| `at_terminal_sftp_delete` | SFTP | Delete remote files or empty directories |
| `at_terminal_sftp_rename` | SFTP | Move or rename remote files and folders |
| `at_terminal_sftp_copy` | SFTP | Copy files or directories on remote host |

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
- **Cordis 原生接入**：直接在 DSH 宿主上下文（`ctx.tools`）中注册 12 个运维工具，DSH Agent 可零延迟直接调用。
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

---

### 构建产物与 DSH 插件安装指引

#### 1. 构建产物说明
执行构建后，将在 `dsh/` 目录中生成供 DSH 运行的完整 bundle 产物：
- [`dsh/host.bundle.js`](dsh/host.bundle.js)：宿主端核心 Bundle（汇聚 SSH 会话管理器、SFTP 协议引擎、安全策略评估器等）；
- [`dsh/client.js`](dsh/client.js)：DSH 前端界面 Bundle（包含 xterm 终端渲染组件、侧边栏 Tab 视图及样式）；
- [`dsh/policy-assets/`](dsh/policy-assets/)：安全策略规则库与白名单资产包；
- [`cordis.patch.yml`](cordis.patch.yml)：DSH 插件规范清单与 Cordis 注入补丁。

#### 2. 常用构建与验证命令

```bash
# 1. 编译构建宿主与客户端 Bundle
npm run build

# 2. 执行 DSH 官方规范契约校验 (9 项自动化合规规则全部检查)
npm run verify:dsh

# 3. 运行全量自动化测试套件 (75 个测试文件，923 个用例)
npm run test

# 4. 执行 TypeScript 静态类型检查 (零报错)
npm run typecheck

# 5. 校验/更新 vendored 依赖 (@deepseek-ai/schemastery 等)
npm run vendor:dsh
```

#### 3. 安装插件到 DeepSeek Harness

> [!IMPORTANT]
> **安装方式**：
> 1. **命令行直接添加**：
>    ```sh
>    dsh plugin add github:<owner>/at-terminal-dsh
>    ```
> 2. **桌面端本地安装**：打开 **设置 -> 插件管理 -> 安装本地插件**，输入绝对路径：  
>    `/path/to/at-terminal-dsh/dsh`  
>    *(安装完成后重启 DSH 即可生效)*

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

### Agent Skills

- [skills/at-terminal-mcp/SKILL.md](skills/at-terminal-mcp/SKILL.md): `$at-terminal-mcp`
- [skills/writing-ops-documents/SKILL.md](skills/writing-ops-documents/SKILL.md): `$writing-ops-documents`

```bash
npx skills add xwamt/At-Terminal
```
注：Skills 不复制进 VSIX。


---

## License & 致谢

- 本项目基于 [MIT 许可证](LICENSE) 开源发布。
- 特别鸣谢上游开源项目 [AT Terminal (at-terminal)](https://github.com/xwamt/At-Terminal) 提供的坚实 SSH/SFTP 基础！
