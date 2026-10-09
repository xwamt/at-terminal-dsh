# AT Terminal → DeepSeek Harness 插件：迁移可行性与难度评估

> 分支：`base-dsh`　|　日期：2026-09-28　|　对象：`at-terminal-series`（v0.3.5，双变体 base / mcp）
> 目标宿主：**DeepSeek Harness（dsh）** 开发者预览版 `0.1.1-rc.2`（2026-08-21 发布，基于 Cordis 插件框架）

---

## 0. 结论速览

| 迁移目标 | 难度 | 一句话判断 |
|---|---|---|
| **变更点 2a：Agent 能力——保留 MCP 模式** | 🟢 **低** | 插件零改动。dsh 内置 MCP 客户端，把 `AT Series` hub 注册为一个 MCP server 即可，11 个工具直接可用（`mcp__*`） |
| **变更点 2b：Agent 能力——改为 dsh 原生工具** | 🟡 **中** | 用 `defineTool` 重写 11 个工具声明；策略/确认从 `vscode.window` 弹窗迁到 dsh 的 policy 扩展点；可**删掉** 1161 行 Bridge/Hub 胶水 |
| **变更点 1：前端 UI 匹配（资产树 + 终端）** | 🟠 **中高** | 本质是「换宿主重写外壳」：21 个文件依赖 `vscode.*`，需改写为 dsh **client 半插件 + Slots** 体系；但 xterm / SFTP / SSH 内核可整体复用 |

**总体判断：不算"大改"，更像"换壳"。** 10,321 行 `src` 中约 **55%–65% 是纯 Node/TS 领域内核（ssh2、SFTP、路径、加密、命令策略）可近乎原样搬运**；真正要重写的是「宿主适配层」——`extension.ts` 入口、TreeDataProvider、WebviewPanel 面板、模态确认弹窗。若只做变更点 2a，**1～2 天**即可跑通；若要做完整 UI 对等，属于**中等偏大的产品化改造**，但风险可控、无架构性阻塞。

---

## 1. DeepSeek Harness 插件模型（研究结论）

### 1.1 一句话架构

dsh 是「**一切皆插件**」的 Agent 运行时：模型适配器、工具注册表、会话日志、乃至 Agent 主循环本身都是插件。插件框架是 **Cordis**（同作者生态），启动时按 `profile`（配置档）+ `bundle`（可安装包）组合出一棵插件树。

### 1.2 插件 = npm 包 + 最多两个"半"

| 半 | 运行位置 | 入口声明 | 职责 |
|---|---|---|---|
| **Host 半**（必有） | dsh 的 Node 进程中 | `apply(ctx, config)`（`exports["."]`） | 注册工具、服务、路由、事件、定时器 |
| **Client 半**（可选） | 浏览器 / Electron 渲染进程 | `dsh.client` + `exports["./client"]` | 注册 UI 到官方 **Slot** 体系 |

```jsonc
// package.json —— 官方"插件契约"全在这
{
  "name": "dsh-at-terminal",
  "exports": { ".": "./bundle/host.js", "./client": "./bundle/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 安装时应用的补丁
    "client": { "platform": "web", "inject": [], "external": [] }
  }
}
```

```yaml
# cordis.patch.yml —— 只"插入一行"，不修改既有行
- insert:
    - id: at-terminal
      name: 'dsh-at-terminal'
```

> 关键约束：**补丁行的插件路径必须是绝对路径或 `file://` URL**；相对路径会静默解析失败。补丁语义是「整体替换该行 config」，不是字段合并。

### 1.3 三种插件形态与 `ctx` 能力面

| 形态 | 写法 | 何时用 |
|---|---|---|
| 函数 | `export const name` + `export function apply(ctx)` | 绝大多数（只注册能力） |
| 对象 | `export default { name, inject, apply }` | 需要在同一对象里带依赖/配置 |
| 类 | `export default class X extends Service` + `static inject` | **向其他插件提供服务**时才用 |

依赖通过 `inject` 声明（如 `inject = ['tools']`），Cordis 会等所有必需服务就绪后才调用 `apply`；通过 `ctx` 注册的一切在插件卸载时**自动清理**，需要显式释放的资源用 `ctx.effect(fn => disposer)`。

常用核心服务：`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.systemPrompt`、`ctx.agents`、`ctx.agentLoop`、`ctx.settings`、`ctx.slots`、`ctx.layout`、`ctx.webServer`、`ctx.jobs`。

### 1.4 工具定义 DSL（变更点 2b 的落点）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'run_remote_command',
    description: '在 AT Terminal SSH 主机上执行非交互命令。',   // 写给模型看，决定它何时调用
    parameters: {
      serverId: { type: 'string', description: '服务器 id，或 active 表示当前活动终端' },
      command:  { type: 'string', required: true },
      cwd:      { type: 'string' },
      timeoutMs:{ type: 'number' },
    },
    output: {
      schema: { type: 'object' },                       // 单一 canonical value
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) { /* 返回 canonical value；抛错 = isError */ },
  }))
}
```

**`execute` 四条硬规则**：① args 由 DSL 自动校验（非空/正数/跨字段仍需手写）；② 返回**恰好一个** canonical JSON 值，不返回内容块、不让调用方解析散文；③ 基础设施失败**抛错**，业务上的非理想结果用返回值表达；④ 遵守 `exec.signal`。

### 1.5 策略与 UI 卡片（对比现有实现的直接映射）

| dsh 扩展点 | 用途 | 在 AT Terminal 里的对应物 |
|---|---|---|
| `tools/pre-execute` | allow/deny/**ask** 策略 | `agentCommandTrust` + `remoteCommandAuthorization` |
| `ctx.tools.guard()` | 最终不可撤销的 deny | 「敏感路径永不放行」硬红线 |
| `tools/execute` / `post-execute` / `result` | 包裹 dispatch、改写呈现、观察结果 | `AgentAuditLog` 审计 |
| `ctx.jobs.start({kind,label,owner,run})` | 长任务后台化 | 长耗时 SSH/SFTP 传输 |
| `presentCall` → `{card:'terminal'}` | 终端风格调用卡片 | `formatRemoteCommandConfirmMessage` 预览 |
| `presentCall/Result` → `{card:'diff'}` | 文件变更卡片 | SFTP 写文件的 diff 展示 |

> ⚠️ **重要**：内置 Web Client **不消费** Host 的 `presentCall/presentResult`。若要自定义卡片外观，需要 client 半把工具名注册到 `tool.call.toolview` 键控槽。仅写 Host 侧 presenter **不会**自动出现专用 Web 卡片。

### 1.6 UI：Slot 是唯一的官方扩展点

- 布局由官方 `dsh-client-ui-layout` 提供，声明四个子槽：`sidebar`（左，264–420px）、`conversation`（中）、`details`（右，默认关闭）、`shell.overlay`（浮层）。
- 槽有种类（`single` / `keyed` / `list` / `chain`）与作用域（`root` / `session` / `session-maybe`）。
- 侧边栏面板行注册到 `sidebar.panellist`；主区面板注册到 `main`（keyed slot）；由 `ctx.layout.selectPanel` 切换主区。
- 官方 SKILL 明确警告：**不要**默认整区占用 `root` / `sidebar` / `conversation` / `details`。

### 1.7 MCP 在 dsh 中的位置（变更点 2a 的落点）

| 维度 | 结论 |
|---|---|
| 支持方式 | dsh 有 MCP 客户端插件，MCP server 作为**外部进程**经 stdio/http 桥接 |
| 工具暴露 | 桥接后工具名形如 `mcp__<server>__<tool>`，模型可直接调用 |
| 能力边界 | **仅 Tools**；MCP 的 **resources / prompts 不支持** |
| 默认状态 | **任何 MCP server 默认都不启用**（启动命令属于可信可执行代码） |
| 与 Plugin 差异 | Plugin 是**进程内**、可替换核心行为（含 agent loop）、默认运行在可信域；MCP 只能加工具，不能改核心 |

**这意味着变更点 2a 在 dsh 里是"一等公民但需显式启用"**：不需要改 dsh 源码，也不需要改 AT Terminal 代码。

---

## 2. at-terminal 插件现状解剖

### 2.1 形态与体量

- 形态：**VS Code 兼容扩展**（`engines.vscode ^1.85.0`），`main: ./dist/extension.js`，`l10n` 本地化。
- 双构建变体（ADR-001）：`AT Terminal`（base）与 `AT Terminal MCP`，靠 esbuild `define` 注入 `MCP_ENABLED` 折叠分支。
- 源码体量：`src/` **10,321 行 TS**（21 个文件 `import 'vscode'`）+ `webview/` **2,035 行**前端资源。

### 2.2 声明式贡献点（这些在 dsh 中**没有等价物**，必须自建）

| `contributes` | 数量 | dsh 中的对应做法 |
|---|---|---|
| `viewsContainers.activitybar` | 1（`sshManager`） | 无 —— 改用 `sidebar.panellist` 注册面板行 |
| `views` | 2（`servers` / `sftpFiles`） | 无 —— client 半自绘树组件 |
| `commands` | ~35 | 无 —— client 半事件 + Host 半 `ctx` 交互 |
| `menus`（`view/title`、`view/item/context`、`commandPalette`） | 多组 | 无 —— client 半自绘右键菜单 |
| `configuration` | 8 项 | `ctx.settings.installSection()` + schemastery schema |
| `viewsWelcome` | 2 | client 半空状态组件 |

### 2.3 模块清单与「可搬运度」

| 模块 | 行数 | 宿主耦合 | 搬运判断 |
|---|---|---|---|
| `src/ssh` | 1,028 | 低（仅 `VscodeKeyboardInteractivePrompt`） | ✅ **近乎原样**（ssh2 + host key store + port forward） |
| `src/sftp` | 2,321 | 中（`VscodeTransferReporter` / `SftpDragAndDropController` / `SftpPreview` / `SftpEditSessionManager`） | 🟡 内核可搬，4 个 VS Code 适配件需重写 |
| `src/agent` | 1,974 | 中（`AgentToolService` 用 `vscode.window.showWarningMessage` 做模态确认） | 🟡 策略内核可搬，确认/弹窗改走 dsh policy |
| `src/assets` | 543 | 低（`AssetCrypto`/`AssetPackage` 纯；`AssetCommands` 用 `vscode`） | ✅ 加密/打包内核原样 |
| `src/terminal` | 190 | 低 | ✅ `TerminalContextRegistry` 几乎原样 |
| `src/config` | 195 | 中（`globalState` / `secrets`） | 🟡 存储后端替换（见 3.3） |
| `src/mcp` | 1,161 | 中 | ❌ 走原生路线时可**整体删除**；走 MCP 路线时**零改动** |
| `src/tree` | 295 | **高**（`TreeDataProvider`/`TreeItem`/`ThemeIcon`） | 🔴 重写为「数据 → client 渲染」 |
| `src/webview` | 1,323 | **高**（`WebviewPanel`/`asWebviewUri`/`cspSource`/`postMessage`） | 🔴 重写为 Slot 面板组件 |
| `src/utils` / `i18n` / `policy-runtime` | 181 | 低 | ✅ 原样 |
| `webview/`（终端 & 表单前端） | 2,035 | **面向 DOM，无 vscode 依赖** | ✅ **最有价值的复用资产**：xterm 渲染、语义高亮、zebra、搜索、剪贴板可直接迁入 client 半 |

### 2.4 耦合热点（`vscode.*` 调用次数）

`extension.ts` **87** » `SftpEditSessionManager` 21 » `AssetCommands` 16 » `SftpPreview` 10 » `TerminalPanel` 9 » `ServerFormPanel` 9 » `SftpTreeItems` 8 » `TreeItems` 7 …
→ 重写预算的 **80% 集中在这 8 个文件（约 1,700 行）**。

### 2.5 现有 MCP 模式的结构（变更点 2a 的现成资产）

```
IDE MCP Client ──stdio──▶ ~/.at-series/mcp/hub.js  (AT Series Hub, 渐进暴露 v2)
                                │ 读 registry + HTTP
                                ▼
        ~/.at-series/bridges/<hostApp>/<bridgeId>.json
                                │
                                ▼
   插件内 BridgeServer  127.0.0.1:<port>   GET /health · GET /tools · POST /invoke
                                │
                                ▼
     插件域服务（SSH / SFTP）+ 确认弹窗 + 凭据（凭据永不出扩展宿主）
```

- **11 个工具**已在 `toolCatalog.ts` 单点声明：`list_ssh_servers`、`get_terminal_context`、`run_remote_command`、`sftp_list_directory`、`sftp_stat_path`、`sftp_read_file`、`sftp_write_file`、`sftp_create_file`、`sftp_create_directory`、`sftp_rename`、`sftp_delete`。
- 已内置分级信任（`none` / `limited` / `full`）+ 命令黑名单策略（`@at-series/command-policy`）+ 写授权（一次一目录）+ 审计日志。
- **这套设计恰好与 dsh 的 policy 扩展点同构** —— 迁移时不是"推翻重来"，而是"换个扩展点挂载"。

---

## 3. 变更点 1：前端 UI 匹配（在 dsh 内管理资产、启动终端）

### 3.1 目标形态

在 dsh 侧边栏出现「AT Terminal」入口，点击后主区呈现：
- **资产树**：SSH 服务器分组树（取代 `ServerTreeProvider`）；
- **SFTP 文件树**：跟随活动终端（取代 `SftpTreeProvider`）；
- **终端面板**：xterm 全功能终端（取代 `TerminalPanel` + `webview/terminal/*`）；
- **服务器表单**：新增/编辑（取代 `ServerFormPanel` + `webview/server-form/*`）。

### 3.2 需要新写的三件事

**① Host 半：领域服务化**
把现在挂在 `extension.ts`（1,100 行）上的门面拆成 Host 半里的服务/处理器：
- `ctx.settings`：注册 8 项配置（`role('secret')` 字段避免明文回传）；
- `ctx.webServer.register({kind:'prefix', path:'/dsh-at-terminal', handler})`：暴露树数据 / SFTP 操作 / 终端流的 HTTP 或消息路由（**注意：重的 handler 必须用 `try/catch` 包，重复的 (kind,path) 会抛错**）；
- 终端 I/O：Host 半持有 `ssh2` 会话，向 client 半推送字节流；client 半渲染。

**② Client 半：三套组件 + 一个消息通道**
- `sidebar.panellist` 注册面板行 → `main`（keyed）注册主区组件 → `ctx.layout.selectPanel` 切换；
- 服务器树 / SFTP 树 / xterm 终端 / 服务器表单，全部用 DOM 自绘；
- 打包约束：client 半必须是 **lazy CJS factory**（`window.__ModuleLoader__.load({id, factory})`），执行文件只能注册 factory，副作用放进 factory 内；**运行时不保证任意 npm 包可用**，所以 xterm.js 等依赖必须**编译期打进 client bundle**（这正是 `webview/` 那 2,035 行资产的去路）。

**③ 消息桥替换**
现有 webview 用 `postMessage` + `asWebviewUri` + 自签 CSP nonce；dsh 里这些都消失，改为 Host↔Client 的 cordis 通道 + `/plugins` 静态服务。`src/webview/html.ts`（CSP/Uri 注入）**整体废弃**。

### 3.3 三个具体的"坑"

| 坑 | 说明 | 对策 |
|---|---|---|
| **凭据存储** | `context.secrets`（OS 钥匙串）在 dsh 中不存在 | 改用 `ctx.settings` 的 `role('secret')` 字段，或接入 dsh 的 credentials 域；私钥文件仍存本地目录（现有 `assetPrivateKeyDirectory` 逻辑可留） |
| **状态持久化** | `context.globalState` 不存在 | 落到本地 JSON/SQLite（可复用 `AssetPackage` 思路），或 dsh 的 storage 服务（需核实版本是否提供） |
| **模态确认** | `vscode.window.showWarningMessage({modal:true})` 是**阻塞式原生弹窗**，且有 120s 超时防挂起逻辑 | 改为 `tools/pre-execute` 返回 **ask**，或 client 半自绘确认卡片；`CONFIRMATION_TIMEOUT_MS` 那套"迟到点击不算生效"的补丁逻辑可删 |

### 3.4 生态先例（可行性背书）

社区已有同类插件证明「dsh 内嵌 IDE 式三件套」可行：
- `dsh-better-sidebar`（684+ stars）：文件树 + **终端** + Git + 可扩展标签页；
- `dsh-web-ui`：任务看板 + Git 图 + 侧边栏 + 移动端 UI；
- `dsh-TUI`：全屏终端界面。
> 说明：dsh 本身不提供文件树/终端，这些都是插件补的 —— 与 AT Terminal 的定位**完全同频**。

---

## 4. 变更点 2：Agent 模式的两条路线

### 4.1 路线 A（2a）：保留 MCP 模式 —— 🟢 低难度，推荐先做

**做法**：dsh 侧把一个 MCP server 注册为 `AT Series`（命令指向 `~/.at-series/mcp/hub.js`），显式启用。

- **插件代码改动：0 行。** AT Terminal 的 Bridge + Hub + 11 工具原样工作。
- 收益：立刻获得 Agent 远程运维能力（`mcp__...`），风险最低。
- 代价：
  1. **必须显式启用**（dsh 默认不启用任何 MCP server）；
  2. 只暴露 Tools，**resources / prompts 不可用**（现有实现未用到，无影响）；
  3. 工具呈现为通用卡片，享受不到 `{card:'terminal'}` / `{card:'diff'}`、PTC、`tools/*` policy 钩子；
  4. 仍然是"扩展宿主内 Bridge + 外部 Hub"的双进程链路，dsh 语境下略显迂回。

**适用**：想在一两天内验证「AT Terminal 能力 + dsh Agent」这条主线。

### 4.2 路线 B（2b）：改为 dsh 原生工具插件 —— 🟡 中难度，长期正确

**做法**：Host 半里用 `defineTool` 重新声明 11 个工具，直接调用搬过来的领域内核。

| 工作项 | 说明 | 量级 |
|---|---|---|
| 工具声明迁移 | `toolCatalog.ts`（230 行，含详细 description）→ `defineTool` 的 `parameters` + `output.schema` + `render` | 中，机械但需逐条对齐 |
| description 重写 | 现有描述里大量「确认弹窗行为」的描述要删（确认改由 policy 承担），保留能力与边界说明 | 中 |
| 策略迁移 | `agentCommandTrust` / `remoteCommandAuthorization` → `tools/pre-execute` 的 allow/deny/ask；`ctx.tools.guard()` 承载敏感路径硬红线 | 中 |
| 确认交互 | `vscode.window.showWarningMessage` → **ask**；一步一目录的写授权 → policy 状态机 | 中 |
| 审计 | `AgentAuditLog` → `tools/result` 观察者 | 小 |
| 长任务 | 大文件传输 → `ctx.jobs.start`，返回 `{kind:'background', jobId}` | 小 |
| 卡片 | `presentCall` → `{card:'terminal'}`（命令）、`{card:'diff'}`（写文件） | 小 |
| **删除** | `src/mcp/*`（1,161 行）+ `@at-series/mcp-hub` 依赖 + `MCP_ENABLED` 双变体机制 | 净减 |

**收益**：单进程、无外部 Hub、工具卡片原生、享受 PTC（每个工具自动成为 `await tools.xxx()`）、策略钩子统一、与 dsh 生态一致。

**代价**：AT Series MCP Hub 这条"多插件共用入口"的战略资产会被旁路（若目标是全系列插件都进 dsh，应重新评估 Hub 是否还有存在价值 —— 建议**同时保留 MCP 变体**给 VS Code 阵营，dsh 走原生，即 ADR-001 的双变体思路延伸到第三变体 `dsh`）。

### 4.3 建议：A → B 分两步，不要一开始就做 B

先用 **A** 打通端到端（验证 dsh 能连上 hub、模型能调 `run_remote_command`），再在同一 Host 半里把工具换成原生实现，MCP 路线作为兜底并行保留。两条路线**互不冲突**，因为领域内核是同一份。

---

## 5. 工作量拆解

| 阶段 | 内容 | 产出 | 难度 |
|---|---|---|---|
| **P0** | 建 `base-dsh` 分支；搭 dsh plugin 骨架（`package.json` + `cordis.patch.yml` + Host 半 `apply`）；跑通"hello 工具" | 可加载的空壳插件 | 🟢 低 |
| **P1** | 路线 A：注册 AT Series MCP server，验证 11 工具在 dsh 中可调 | Agent 能力可用 | 🟢 低 |
| **P2** | Host 半：搬迁 `ssh` / `sftp` / `assets` / `config` 内核 + `ctx.settings` 配置面 | 无 UI 的完整领域服务 | 🟡 中（工作量最大但风险最低，纯搬运） |
| **P3** | Client 半：Slots 注册 + 服务器树 + SFTP 树（先只读列表） | 资产可管理 | 🟠 中高 |
| **P4** | Client 半：xterm 终端面板 + Host↔Client 字节流通道（复用 `webview/terminal/*`） | 终端可启动 | 🟠 中高（流控/背压需重做） |
| **P5** | 原生工具化（路线 B）：`defineTool` × 11 + policy 迁移 + 卡片 + 后台任务 | 与 dsh 生态对齐 | 🟡 中 |
| **P6** | 打磨：i18n、主题适配、错误呈现、安装与验证三查 | 可发布 bundle | 🟡 中 |

> 第 P4 项的**唯一技术不确定点**：现有 `TerminalOutputBatcher` + `TERMINAL_FLOW_PAUSE_BYTES/RESUME_BYTES`（Webview-ack 背压）在 dsh 的 Host↔Client 通道上需要重新设计（不能照搬 `postMessage` ack 语义）。**建议在 P0/P1 阶段就用一个 30 行的"echo 终端"验证 dsh 的流式通道吞吐与背压能力**，这是整个迁移里最该先做技术验证的点。

---

## 6. 风险与不确定项

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | dsh 处于 **developer preview**，官方明确声明会有破坏性变更 | 迁移成果可能随版本失效 | 锁定 `0.1.1-rc.2`；在 bundle 里声明"已验证版本"；核心内核与宿主适配严格分层，便于跟随升级 |
| 2 | Client 半**运行时依赖受限**（只保证共享平台模块底座） | xterm 等依赖引入方式受限 | 编译期全量打进 client bundle；先做最小 xterm spike |
| 3 | Slot 生态仍在演化，官方警告勿整区占用 | 侧边栏/主区可能与他插件冲突 | 只用 `sidebar.panellist` + `main` keyed 槽，作用域取 `session`，不碰 `details` |
| 4 | 终端流的背压/流控需重做 | 大输出可能卡死或丢字节 | P0 阶段先 spike；沿用暂停阈值思路但换通道 |
| 5 | 凭据迁移（`SecretStorage` → dsh 体系） | 安全语义变化 | 用 `role('secret')` 字段；私钥保持"不出宿主进程"原则 |
| 6 | AT Series MCP Hub 战略被旁路 | 全系列插件的统一入口价值下降 | 保留 MCP 变体；dsh 作为**第三变体**并行，而非替换 |

---

## 7. 最终回答：难度大不大？

**不大，但也不是"改个清单就行"。**

- 如果只想要**"dsh 的 Agent 能调用 AT Terminal 的运维工具"** → **几乎零成本**（路线 A：注册 MCP server）。这是本次迁移的 80% 价值、20% 的成本部分。
- 如果还想要**"在 dsh 界面里管理资产、启动终端"** → 属于**换宿主重写外壳**：`tree` / `webview` / `extension` 三个目录（约 1,700 行热点）需重写为 Slots + client 半，但 `ssh` / `sftp` / `assets` / `terminal` 内核（约 4,100 行）**可近原样复用**，另有 2,035 行前端资源可直接迁入 client 半。
- **架构上没有阻塞点**：dsh 的 `defineTool` + policy 扩展点 + slots，与 AT Terminal 现有的「工具目录 + 分级信任 + 一目录一授权」设计**高度同构**，是少见的"映射顺畅"的迁移场景。真正的硬骨头只有两处：**终端流的背压通道**、**凭据/状态存储的宿主替换**。

> 建议落地顺序：**P0（骨架）→ P1（MCP 打通，立刻可用）→ P2（内核搬迁）→ P4 的 xterm spike（先验证最大不确定点）→ P3/P4（UI 对等）→ P5（原生工具化）**。

---

### 附录 A：研究来源

- DeepSeek Harness 官方文档（`deepseek-harness.github.io/deepseek-harness/en/develop/*`）：Your first plugin / Build a tool / Tool authoring reference
- `dsh-plugin.org` 教程：develop-plugin-guide / develop-tool-plugin / develop-plugin-ui
- 社区实例：`RUO-MO/DSH-Plugin`（host 半 + client 半 + Slots 实战）、`NekoHome-Studio/dsh-plugin-dev`（SKILL.md：契约、三查验证、client 打包约束）
- AT 侧：`at-terminal-series/package.json`、`src/**`、`docs/features.md`、`docs/decisions/ADR-001~005`、`at-series-mcp-hub/README.md`

### 附录 B：本次涉及的关键数字

| 指标 | 值 |
|---|---|
| dsh 版本 | `0.1.1-rc.2`（developer preview） |
| at-terminal 版本 | `0.3.5` |
| `src/` TS 行数 | 10,321（21 文件依赖 `vscode`） |
| `webview/` 前端资源行数 | 2,035 |
| 可复用领域内核 | ~4,100 行（ssh 1,028 + sftp 2,321 + assets 543 + terminal 190） |
| 需重写的宿主耦合热点 | ~1,700 行（8 个文件） |
| dsh 原生路线可删除 | ~1,161 行（`src/mcp/*`） |
| 现有 MCP 工具数 | 11 |
| 声明式贡献点 | 1 activitybar 容器 / 2 视图 / ~35 命令 / 8 配置项 |
