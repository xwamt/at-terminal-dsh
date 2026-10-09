# AT Terminal (DSH)

> **DeepSeek Harness (DSH) 原生 SSH 终端、SFTP 远程文件工作区与 Agent 直连运维套件。**

[![DSH Verified](https://img.shields.io/badge/DSH-0.1.7--rc.2_Verified-brightgreen.svg)](#常用构建与验证命令)
[![Test Coverage](https://img.shields.io/badge/tests-75%2F75%20passed%20(923%20tests)-blue.svg)](#常用构建与验证命令)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 项目渊源与版本指引

本项目脱胎于开源项目 [**AT Terminal (at-terminal)**](https://github.com/xwamt/At-Terminal)，是专为 **DeepSeek Harness (DSH)** 设计的独立架构适配版本。

在保留原项目出色的 SSH 终端会话、SFTP 文件引擎及安全策略内核的基础上，本项目彻底解耦并剥离了 VS Code 专属外壳与无用依赖，深度拥抱 DSH 的 **Cordis 插件微内核体系**，实现了极简的资源开销与更丝滑的 Agent 直连体验。

> [!TIP]
> **需要 VS Code / Cursor 版本的插件？**  
> 如果您是在 VS Code、Cursor 或其他兼容 IDE 中寻找 SSH 终端管理或 MCP 工具扩展，请前往原项目仓库获取：  
> 🔗 **GitHub 仓库**：[https://github.com/xwamt/At-Terminal](https://github.com/xwamt/At-Terminal)  
> 该仓库提供面向 VS Code 的基础版（Base）及通过跨进程 MCP Hub 桥接的增强版（MCP Variant）。

---

## 核心特色功能

### 1. DSH Agent 原生直连工具链（无需 MCP 跨进程中转）
传统的 AI IDE 往往依赖独立的 stdio/HTTP MCP Server 进程进行中转，存在进程通信开销大、状态同步复杂、生命周期脱节的问题。
- **Cordis 原生接入**：直接在 DSH 宿主上下文（`ctx.tools`）中注册 12 个运维工具，DSH Agent 可零延迟直接调用。
- **全生命周期协同**：
  - **动态取消响应**：完全感知 `exec.signal`，当用户在 DSH 界面点击停止生成或取消任务时，远端 SSH 命令与传输流立即被精确中断。
  - **原生审批通道**：无缝对接 DSH 的 `ctx.approval` 交互机制。
  - **富文本渲染**：每个工具均配套专属的 `output.render` 格式化呈现，在 DSH 对话流中输出清晰美观的状态块与日志。

### 2. 强大的资产管理与安全加密
- **多认证方式支持**：支持密码认证（Password）、私钥文件认证（PrivateKey，支持 OpenSSH/PEM 及带 Passphrase 加密私钥）和本机 SSH Agent 密钥代理。
- **凭据安全隔离**：敏感凭据通过本地安全存储隔离，杜绝在工作区明文暴露。
- **资产包加密导入/导出**：提供基于 **AES-256-GCM** 加密的资产备份与迁移方案。运维团队可以通过加密密码对资产清单进行导出与跨机器导入，兼顾便捷与资产安全。

### 3. 跳板机穿透连接（Bastion / JumpServer）
- **多级内网穿透**：针对企业生产环境常见的内外网隔离网络架构，支持为目标服务器绑定跳板机（`jumpHostId`）。
- **原生隧道转发**：通过跳板机节点自动建立 SSH Channel 端口隧道直接连接内网目标服务器，无需手动在终端配置复杂的 `ProxyJump` 或 SSH config。
- **严格的主机密钥校验**：穿透链路同样进行 `HostKeyVerifier` 指纹核对，防范中间人劫持风险。

### 4. 三级信任体系与后台连接机制
每台服务器均可配置精细的 Agent 访问权限模型，平衡自动化效率与系统安全：
- **三级信任模型（Trust Levels）**：
  - **完全不信任（`none` / Untrusted）**：对 Agent 保持最高警戒，任何命令执行与文件写入均强行拦截，必须由用户弹窗手动确认。
  - **策略访问（`policy` / Policy-based，推荐）**：接入内置的 `@at-series/command-policy` 策略引擎。常规无害的查询命令（如 `uptime`、`df -h`、`cat`、`free` 等）依据策略规则放行；修改配置或危险命令触发审批；高危提权命令直接拦截。
  - **完全信任（`full` / Trusted）**：命令免弹窗直接放行（破坏性命令仍保留危险保护机制），适用于测试沙盒或自动化高频运维场景。
- **允许后台连接（Background Connections）**：
  - 开关属性：`backgroundConnectionAllowed`。
  - 开启后，即便用户当前没有在 DSH 界面中激活或聚焦该主机的终端标签页，Agent 也能在后台自动建立按需 SSH/SFTP 会话执行排查与任务，并在任务完成后妥善回收连接，赋能全自动 Agent 运维。

### 5. 层次化安全提示与醒目弹窗机制
在调用工具时，插件会向 DSH 界面触发不同安全级别的确认与警告弹窗：

| 场景 | 弹窗展示形态 | 触发条件与防护目的 |
| :--- | :--- | :--- |
| **标准操作确认** | 标题：`Remote command requires confirmation`<br>展示：服务器标签、目标 IP、执行命令文本 | 处于 `none` 信任级别，或处于 `policy` 级别且命中需要人工复核的常规修改命令。 |
| **破坏性命令警告** | 标题带醒目标识：<br>`⚠️ Destructive command warning: this command appears destructive!`<br>附带详细的 `Risk Summaries` 风险分析清单 | Agent 意图执行可能造成系统崩溃、数据丢失的高危命令（如 `rm -rf`、`mkfs`、格式化分区、清空系统目录等），强制醒目提示用户核验参数。 |
| **敏感远程写二次确认** | 标题：<br>`⚠️ Sensitive remote write warning`<br>展示：目标敏感文件路径与修改意图 | 针对敏感配置文件（如 `/etc/`、系统服务 unit 等）的 SFTP 覆盖或修改操作，防止误改关键系统环境。 |

### 6. 原生 WebGL 加速终端与多会话管理
- **高性能前端渲染**：基于 `@xterm/xterm` 5.5 及 WebGL 插件，在 DSH 客户端界面流畅渲染海量日志与高频输出。
- **增强视觉体验**：集成终端语义高亮（Semantic Highlight）、斑马纹交替行底色（Zebra Stripes）、多配色方案对比度自动校正。
- **多标签会话管理**：原生多会话 Tab 自由切换与断线重连保障。

---

## 构建产物与 DSH 插件安装指引

### 1. 构建产物说明
执行构建后，将在 `dsh/` 目录中生成供 DSH 运行的完整 bundle 产物：
- [`dsh/host.bundle.js`](dsh/host.bundle.js)：宿主端核心 Bundle（汇聚 SSH 会话管理器、SFTP 协议引擎、安全策略评估器等）；
- [`dsh/client.js`](dsh/client.js)：DSH 前端界面 Bundle（包含 xterm 终端渲染组件、侧边栏 Tab 视图及样式）；
- [`dsh/policy-assets/`](dsh/policy-assets/)：安全策略规则库与白名单资产包；
- [`dsh/package.json`](dsh/package.json) 与 [`dsh/cordis.patch.yml`](dsh/cordis.patch.yml)：DSH 插件规范清单与 Cordis 注入补丁。

### 2. 常用构建与验证命令

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

### 3. 安装插件到 DeepSeek Harness

> [!IMPORTANT]
> **安装路径填什么？**  
> 请填写项目下 **`dsh` 子目录的绝对路径**，例如：  
> ```text
> /Users/clkj/项目/at/at-terminal-dsh/dsh
> ```
> *（请将前缀替换为您机器上该项目的实际存放路径）*

#### 为什么必须填写 `dsh` 子目录而非项目根目录？
- **根目录** 是包含源代码、构建脚本、测试套件的开发工程；
- **`dsh/` 子目录** 才是严格遵循 DSH 插件发布规范的独立 Bundle 目录。该目录下声明了包名 `@at-series/dsh-at-terminal` 的清单文件 [`dsh/package.json`](dsh/package.json)、插件补丁 [`dsh/cordis.patch.yml`](dsh/cordis.patch.yml) 以及构建好的运行文件。DSH 会以 `link:<绝对路径>/dsh` 的形式将其链接到当前 Desktop Profile 中。

#### 详细安装步骤：
1. **启动 DeepSeek Harness** 桌面应用；
2. 在界面中打开 **设置 -> 插件管理（Plugin Manager）**；
3. 点击 **「从本地路径安装」** 或 **「导入本地插件包 (Install Local Bundle)」**；
4. 在弹出的路径输入框中粘贴填入绝对路径：  
   `.../at-terminal-dsh/dsh`
5. 安装完成后，**彻底重启一次 DeepSeek Harness**，使宿主进程完整加载新版 `host.bundle.js` 及 12 个直连工具。

---

## DSH 创造套件技能体系（Skills）

项目根目录的 [`skills/`](skills/) 文件夹中收录了深度适配的技能集。这些技能文件**完全脱胎于 DeepSeek Harness 官方的「创造模式」（preset id = cordis）规范**，经过实践淬炼与整理：

```text
skills/
├── dsh-creator-skills/            # DSH 创造模式全局指引与架构全景入口
├── cordis-plugin-development/     # Cordis 插件生命周期、UI 装饰与右侧面板开发规范
├── editing-cordis-compositions/   # Preset 编排、Agent 预设配置与分层 patch 机制
├── cordis-composition-reference/  # Loader YAML 方言参考与 Harness 内部核心模块清单
├── agent-experience/              # 面向 AI Agent 的工具 Schema 设计与调用体验规范
└── writing-ops-documents/         # 规范化中文运维记录、巡检排障与 RCA 报告编写技能
```

### 跨 Agent 开发的复用价值
如果您正在使用其他 AI 辅助工具（如 **Claude Code**、**Codex**、**Cursor Agent**、**Google Antigravity** 等）进行任何与 DeepSeek Harness 相关的插件定制、面板扩展或 Cordis 模块开发：
- 您可以直接将本项目的 `skills/` 目录挂载给对应的 Agent；
- Agent 可依据这些标准化技能准确理解 DSH 的沙盒限制、`ctx.tools` 注册机制、`~standard.validate` 校验规则及 UI Slot 注入规范，大幅提升开发成功率并避免踩坑。

---

## Agent 工具清单（直连 DSH）

插件向 DSH Agent 暴露了 12 个直连运维工具：

| 工具名称 | 类别 | 功能描述 |
| :--- | :--- | :--- |
| `at_terminal_ping` | 探活 | 检查插件状态、就绪标识、版本号及当前生效的终端设置 |
| `at_terminal_list_ssh_servers` | 资产 | 查询已配置的 SSH 服务器列表、网络目标及在线状态 |
| `at_terminal_get_terminal_context` | 上下文 | 获取当前用户活跃聚焦的终端会话信息与窗口状态 |
| `at_terminal_run_remote_command` | 命令 | 在目标服务器上安全执行非交互命令（支持策略拦截与审批） |
| `at_terminal_sftp_list_directory` | 文件浏览 | 列出远程目录文件树，包含权限、修改时间与文件大小 |
| `at_terminal_sftp_read_file` | 文件读取 | 读取远程文本文件内容（支持偏移量与最大读取长度截断） |
| `at_terminal_sftp_write_file` | 文件写入 | 写入或追加远程文件（受信任策略与写审批双重保护） |
| `at_terminal_sftp_stat_path` | 文件元数据 | 检查远程路径是否存在并获取详细属性与权限信息 |
| `at_terminal_sftp_create_directory`| 目录操作 | 递归创建远程目录结构 |
| `at_terminal_sftp_delete` | 文件删除 | 删除远程文件或空目录（受破坏性策略与审批保护） |
| `at_terminal_sftp_rename` | 文件操作 | 远程文件或目录的移动与重命名 |
| `at_terminal_sftp_copy` | 文件拷贝 | 在远程服务器内部执行文件或目录的复制操作 |

---

## 项目工程结构

```text
at-terminal-dsh/
├── dsh/                      # DSH 独立 Bundle 交付目录（安装至 DSH 的目录）
│   ├── index.js              # Cordis 插件入口（注册 service、tools、webServer 资源）
│   ├── client.js             # DSH 客户端 bundle（xterm 前端渲染引擎）
│   ├── host.bundle.js        # DSH 宿主 bundle（TypeScript 核心业务编译产物）
│   ├── tools.js              # 12 个 Agent 原生直连运维工具定义与渲染器
│   ├── settings.js           # 终端偏好设置与 Schemastery 配置模型
│   ├── cordis.patch.yml      # Cordis 补丁配置（注入 at-terminal 运行时行）
│   ├── esbuild.dsh.mjs       # 打包编译脚本
│   └── scripts/verify.mjs    # DSH 规范合规门禁校验器
├── src/                      # 核心业务领域层与 DSH 平台适配层
│   ├── agent/                # 命令策略评估、SFTP 授权、Agent 工具服务
│   ├── assets/               # 资产配置管理、密码学存储与导入导出
│   ├── config/               # 配置管理与 Zod Schema 校验
│   ├── platform/dsh/         # DSH 平台接口适配（Approval、Credentials、Channel 等）
│   ├── sftp/                 # SFTP 协议会话、批量传输与错误处理
│   ├── ssh/                  # SSH 会话连接、HostKey 验证、跳板机与端口转发
│   └── terminal/             # 终端会话上下文与设置管理
├── skills/                   # DSH 创造模式套件与规范化运维技能
├── test/                     # Vitest 自动化单元测试与契约测试套件
└── webview/terminal/         # 终端前端基础样式、色彩对比度与交互逻辑
```

---

## License

本项目基于 [MIT 许可证](LICENSE) 开源发布。
欢迎提交 Issue 和 Pull Request，共同建设更完善的 DeepSeek Harness 终端生态！
