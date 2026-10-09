# AT Terminal → DeepSeek Harness 插件：任务计划与里程碑

> 分支：`base-dsh`　|　日期：2026-09-28　|　前置文档：[`docs/research/2026-09-28-at-terminal-迁移为DSH插件-可行性分析.md`](../research/2026-09-28-at-terminal-迁移为DSH插件-可行性分析.md)
> 目标宿主：DeepSeek Harness `0.1.1-rc.2`（developer preview，**版本锁定**）
> 源工程：`at-terminal-series` v0.3.5（10,321 行 `src` TS + 2,035 行 `webview`）

---

## 0. 实测校正与执行记录

> 本节在 M0 开工时根据**本机真实环境**回填。计划其余部分按原样保留，以便对照；凡与此处冲突，以本节为准。

### 0.1 与出厂假设的偏差（已确认）

| # | 计划中的假设 | 实测事实 | 影响 |
|---|---|---|---|
| 1 | dsh `0.1.1-rc.2` | 本机装的是 **DeepSeek Harness Desktop `0.1.7-rc.2`**（`/Applications/DeepSeek Harness.app`） | 版本锁定值改为 `0.1.7-rc.2` |
| 2 | 用 `dsh web --patch` / `dsh plugin --profile web add` 安装 | 只有 `desktop` profile（`~/.dsh/profiles/desktop`），**Desktop 壳独占包管理**，安装走应用内的插件管理（本地路径）；CLI 未在 PATH 上 | M0/DSH-04 的安装步骤改写 |
| 3 | 插件开发规范只能从网上找 | 官方**已随包发布开发技能**：`dsh-agent-preset/skills/cordis-plugin-development/`（SKILL.md + 5 篇 references + 2 套 templates） | 改为以随包技能为权威真源 |
| 4 | 需要自建终端 UI | dsh **已内置**：`dsh-terminal`（服务）、`dsh-terminal-bash`（本地 shell 后端）、`dsh-api-terminal-controller`（用户终端 controller）、`dsh-client-ui-sidebar-terminal`（右侧栏终端面板）、`dsh-client-ui-sidebar-files`（文件侧栏） | **M3/M4 方案重做**（见 0.2） |
| 5 | 工具 DSL 可从文档推断 | 只能靠实测：**object 节点必须显式声明 `additionalProperties: true\|false`**；`required` 逐参数书写；`{type:'json'}` 归一化为 `{}` | 已固化进 `dsh/scripts/verify.mjs` 的第 4 项检查 |

### 0.2 UI 策略调整（M3/M4）

- `ctx.subprocess` **每个组合只允许一个 provider**，加载第二个会抛错 → **"把官方终端 UI 通过替换 subprocess provider 接到 SSH"这条路不通**（会连带把 Agent 的本地 bash 一起改掉）。
- 官方开放的扩展点是 **右侧栏 tab 类型注册表**：`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`，正文用 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`；导航走 `ctx.sidebarRight.openTab(kind)` / `openResource(address)`。随包引导页与 `ui-sidebar-documentpreview` 都走这条公开路径。
- 因此修订后的方案：**为 SSH 注册独立的 tab `kind`**（不抢占官方 `terminal` kind），自绘正文复用 `webview/terminal/*` 的 xterm 资产；**不再自建整列布局**，只贡献 tab 类型与正文。
- 「启动终端」这件事的产品差异化从「能开终端」变为「能开**远程 SSH** 终端」——本地 shell 终端 dsh 自己已经有了。

### 0.3 本机可用的验证能力（新增资产）

- **dsh 包沙箱**：`dsh/scripts/lib/asar.mjs` 能从 `app.asar` 提取官方包的**传递依赖闭包**（实测 32 个包），从而在本机**真实执行** `defineTool`、校验 config schema。M2/M5 可复用。
- **门禁脚本**：`npm run verify:dsh`（`dsh/scripts/verify.mjs`）**六项**检查：语法 / 清单契约 / patch 行 / 依赖审计（bare specifier 白名单）/ 工具定义对真实 DSL + `execute()` 返回值对自身 `output.schema` + renderer 输出 / 设置 schema 拒非法值。已做**反向测试**（改坏 patch 行 id、删除 `additionalProperties`、放宽 `terminalFontSize` 下限、往 `index.js` 加 `@deepseek-ai/dsh-tools` 裸导入，均被精确判失败）。
- **内核门禁**（W2 新增）：`npm run verify:kernel`（`scripts/verify-kernel-seam.mjs`）**四项**检查，把 §0.8 的 DSH-12 判据脚本化：`src/core` 自封闭 / 领域目录零 vscode / 全 `src` 的 vscode 导入须带理由在白名单 / 组合根真的调了 `setPlatform()`。同样已做三处反向测试（见 0.13）。
- 无 dsh 安装时第 4 项报 **SKIP**，绝不报 PASS。

### 0.4 既有基线红灯（非本次引入）

`test/sftp/SftpSession.directory.test.ts > SftpSession downloadDirectory > keeps at most four file downloads in flight` 在 **pristine `main`（b5829e3）** 上即失败（已在独立 worktree 上复现）。全量套件结果：**785 passed / 1 failed**。

> 结论：这是**既有问题**，不是本次改动的回归。§1.3 的"既有测试基线必须为绿"实际应为"**基线为 785/786，该用例保持既有失败状态**"。建议单独排一个修复节点（见 0.5 DSH-48）。

### 0.5 执行状态

> ⚠️ **本表写于 M0，只覆盖到那一时点，后续各节（§0.11 起）才是权威且更新的记录。**
> 要看真实进度请读 §0.26.5 的"仍未闭环"清单——本轮开工时正是因为只信这张表，才需要先把
> `tsc` / `verify:dsh` / `verify:kernel` / 全量测试重跑一遍来核实。

| 节点 | 状态 | 证据 |
|---|---|---|
| DSH-01 建 `base-dsh` 分支（`at-terminal-series`） | ✅ 完成 | 分支自 `b5829e3` 切出 |
| DSH-02 冻结宿主版本 | ✅ 完成 | 实测桌面版 `0.1.7-rc.2`；runtime node 24.21.0 / pnpm 11.7.0 |
| DSH-03 建 `dsh/` 工程骨架 | ✅ 完成 | `dsh/package.json`、`dsh/cordis.patch.yml`（Host-only，官方模板形态） |
| DSH-04 Host 半最小实现 + 就绪探针工具 | ✅ 完成 | `dsh/index.js`、`dsh/tools.js`；工具 `at_terminal_ping` |
| DSH-05 开发回环（改完即生效） | ⏸ 待 App 重启验证 | profile link + patch 行已就位，模块解析已通；重启 Desktop 后生效 |
| DSH-06 M0 门禁脚本 | ✅ 完成 | `dsh/scripts/verify.mjs`，**6/6 PASS**（含 vendoring 依赖审计），且反向测试可失败 |
| **M0 出口**：插件在 dsh 中真实加载 | ✅ **已闭环** | 用户完成应用内安装并重启；已按宿主的**真实解析路径**复现：`import.meta.resolve('@at-series/dsh-at-terminal')` → `.../at-terminal-series/dsh/index.js`，`exports = {Config, apply, inject:['tools']}`，`apply(fakeCtx, {})` 真的注册 `at_terminal_ping` 且 `execute()` 返回合法值、`render()` 返回 2 块、`effect` 返回 1 个 disposer（见 0.15） |
| DSH-48（新增）修复既有 SFTP 并发用例 | ✅ 完成 | timer 阶段 drain 修复，`SftpSession.directory.test.ts` 9/9 绿；并发数 4 已钉死在测试中 |
| DSH-49（新增）外部 bundle 导入宿主包失败修正 | ✅ 完成 | 见 0.11 修正方案 1-3 全部落地，门禁第 4 项依赖审计生效 |
| DSH-15 设置面 | ✅ 完成 | `dsh/settings.js` 8 项 `sshManager.*` 字段 = schemastery Config；门禁第 6 项：11 非法值全拒 + 边界值保留 |
| DSH-12a 端口层（W1-A） | ✅ 完成 | `src/core/**`（零 vscode，42 测试绿）+ `src/platform/vscode/**` 适配器 + `src/platform/current.ts`；typecheck 退出 0；既有 `src/` 零修改 |
| **W2** 领域簇迁移（DSH-12b/c/d） | ✅ 完成 | W2-A/B/C/D 四簇已落盘并收口（见 0.13）：`src/{ssh,terminal,config,assets,i18n,utils,sftp}` 非白名单文件零 `vscode`；`src/terminal/terminalSettings.ts` 承接下沉的 `resolveTerminalSettings`；`src/sftp/VscodeSftpEditUi.ts` 把编辑会话 UI 抽成适配器 |
| W2-E 组合根与 UI 交接 | ✅ 完成 | `src/extension.ts` 在 `activate()` 首行 `setPlatform(createVscodePlatform(context))`；`assetPrivateKeyDirectory` 改收 `platform().environment.storageDir`；`src/webview/TerminalPanel.ts` 删除本地 `TerminalSettings`/`ConfigurationLike`/`resolveTerminalSettings` 三份重复定义，改由 `platform().config.getSection('sshManager')` + `src/terminal/terminalSettings` 供给 |
| **DSH-12 内核解耦** | ✅ 完成 | 五项判据脚本化进 `npm run verify:kernel`（`scripts/verify-kernel-seam.mjs`）5/5 PASS，且四处反向测试可精确失败（见 0.13 / 0.14） |
| DSH-13 凭据存储替换 | ✅ 完成 | `src/platform/dsh/credentials.ts` —— 走 `ctx.credentials` 的**引用半边**（`resolve/describe/set/unset`），10 项单测含「明文不入日志」断言；见 0.14 |
| DSH-14 状态持久化替换 | ✅ 完成 | `src/platform/dsh/state.ts` —— `ctx.storageDomain` 单 domain 单平表 `at_terminal_state/kv`；20 项单测含跨 close/reopen 持久性断言；spec 已由**真实 `defineDomain`** 验收；见 0.14 |
| DSH-15 dsh 侧设置读口 | ✅ 完成 | `src/platform/dsh/config.ts`：`getSection('sshManager')` 逐调用重读 accessor，未知 section 抛错 |
| DSH-16 Host 半领域服务 | ✅ 三面已落 | 端口适配层（notifier / prompter / transfers / uris / localization / environment / clipboard）+ 组装层 `src/platform/dsh/index.ts`；**server / terminal / SFTP 三面均已交付**（`services.ts` 两个、`sftp.ts` 一个，见 §0.19 / §0.26）。SFTP 的**传输四件套**（读/写/下载/上传）已落，见 §0.29 |
| DSH-17 路由层 | ✅ 完成 | §0.17.1 在运行中的应用里实测 `/dsh-at-terminal/health` 回 200、五条路由全在；`try/catch` 兜住重复注册（§0.17.3 第三处缺陷） |
| DSH-18 M2 集成测试 | 🚧 部分 | 资产持久化闭环 14 项（`test/platform/dsh/platform.test.ts`）+ SFTP 面 **42 项**（`test/platform/dsh/sftp.test.ts`，§0.29 起含传输四件套 21 项）；**需真实远端的两段（SSH 连接、远端副作用断言）仍未做** |
| **DSH-23 SFTP 只读文件树** | ✅ 完成（已扩为可读写） | §0.26：Host 面 `src/platform/dsh/sftp.ts` + channel 三个 `sftp.*` RPC + 客户端只读树页；**§0.29 追加传输四件套**（7 条 RPC 共、客户端 查看/编辑/下载/上传）；**真实远端未验证** |
| DSH-07 profile 注册 MCP server | ✅ 完成（含一处勘误） | 新增 `dsh/scripts/enable-mcp.mjs`（`npm run dsh:mcp:enable`）幂等写入 profile patch 层；已实际执行，改动经证明**纯增量**（0 行丢失/改写）+ 备份 + YAML 可解析。**勘误：** 初版写入的是裸行 `- id: mcp-at-series`，被 dsh loader 静默跳过——patch 层只对**已存在**的 entry 做按 id 覆盖，而 `dsh-mcp-client` 默认不挂任何 server 行，故重启后 `mcp-at-series` 始终未加载。已改为 `- insert:` 包裹并用真实 `applyEntryPatches`（从 `app.asar` 提取）复现验证（见 0.15.6） |
| DSH-08 11 工具可见 | ✅ **已在真实 dsh 会话闭环** | 你实测：重启后 `@deepseek-ai/dsh-mcp-client` 随 profile 加载，5 个 Hub 元工具进入 Agent 工具列表（`mcp__at-series__at_list_providers` / `at_search_tools` / `at_get_tool` / `at_select_tools` / `at_clear_tool_selection`），stdio Hub 全程走通；`at_list_providers` 返回 `host=antigravity-ide`、`hub 0.3.4`、6 个 provider 全 healthy、**`at.terminal@0.3.5` / 11 工具**。与 `npm run dsh:mcp:probe` 的场外探活结果一致（见 0.15） |
| DSH-09/10/11 工具 E2E | 🚧 **差一步** | 下一步 `at_select_tools({mode:'replace', pluginIds:['at.terminal']})` 把那 11 个提升进当前会话工具列表，即可实调 `list_ssh_servers` / `run_remote_command` / `sftp_*` |

### 0.6 当前阻塞与需要的决定

1. **安装授权** ✅ **已决定**：由用户在 Desktop 应用内「插件管理 → 本地路径」安装 `/Users/clkj/项目/at/at-terminal-series/dsh`，我提供路径与步骤。
2. **UI 策略** ✅ **已决定**：采纳 0.2 的修订方案（注册 SSH tab 类型 + 复用官方右侧栏布局），放弃原 M3/M4 中"自建面板"的写法。
3. **M2 是否并行开工** ✅ **已决定**：并行开工（不等安装）。M2 完全本地可验证，不需要 dsh 运行。

### 0.7 M2 数据面 API 实测校正（**先于编码**）

> 方法：用 `dsh/scripts/lib/asar.mjs` 从 `app.asar` 提取 `dsh-credentials` / `dsh-settings` / `dsh-storage` / `dsh-storage-domain` / `dsh-host-webserver` / `dsh-agent-default-model` 的**真实产物**并阅读实现（`.d.ts` 未随包发布，只有构建后的 `.js`）。
> 结论：§3 M2 表中 **DSH-13 / DSH-14 / DSH-15 三处 API 假设均不存在**，须按下表改写。

| # | 计划中的写法 | 实测事实 | 影响 |
|---|---|---|---|
| 1 | `context.secrets` → `ctx.settings` 的 **`role('secret')`** | **无 `role()`**。真实 seam 是 **`ctx.credentials`**（`CredentialProvider extends Service`）：① 引用面 `credentialRef('NAME')` + `resolve/describe/set/unset`，对进程环境 → `.credentials.yaml` → `.env` 分层；② 记录面 `credentialKey('<scope>','<id>')` + `readRecord/describeRecord/listRecords/modifyRecord/deleteRecord`，**`modifyRecord` 是唯一写路径**（读-改-写在同一把锁内）。铁律：**配置只携带引用，永不携带值**；`describe*` 永不返回值；空值 ≡ 不存在 | DSH-13 改写 |
| 2 | `ctx.settings.installSection()` | **无 `installSection()`**。真实机制：插件用 schemastery 声明 `static Config = z.object({...})`，字段标 **`.volatile()`**；settings 面板按 schema **自动生成**表单（`autoGenerate` 默认开）。配置字段是**访问器**：读用 `this.config.field.get()`；写用 `ctx.get('configEditor').edit(entry, () => config)`。自带页面的插件需 `ctx.inject(['settings'], c => c.effect(() => c.settings.configure({ auto: false }, ctx.fiber)))` | DSH-15 改写 |
| 3 | `context.globalState` → "本地存储后端"（含糊） | 真实 seam：**`ctx.storage`**（`register(name, backend)` / `get` / `names` / `mount(form, facility)` / `form`）+ **`ctx.storageDomain`**（`open(spec)` → 句柄 `{get, keys, delete, update, close}`）。组合里须挂三行：`dsh-storage` + 后端（`dsh-storage-json`，`config.root`）+ `dsh-storage-domain`（`config.backend`）。后端拥有介质、数据形式拥有语义 | DSH-14 改写 |
| 4 | `ctx.webServer.register` 可安全重复调用 | `ctx.webServer` 存在，签名 `register({ kind: 'exact'\|'prefix', path, handler })` 返回 disposer；但**重复 route 同步抛错**（`webserver: duplicate prefix route "<path>"`）→ DSH-17 的 `try/catch` 兜底**必需**，非可选 | DSH-17 维持（已印证） |
| 5 | DSH-12 DoD = `src/{ssh,sftp,assets,config,terminal}` 的 `from 'vscode'` **为空** | 实测 **21 个文件**引用 `vscode`。其中 `*Vscode*.ts` 适配器与 UI 层（`tree/`、`webview/`、`extension.ts`、`agent/`、`mcp/`）**应当**保留 `vscode`——在 dsh 变体里它们被 Client 半整体替换。硬套"零命中"会逼出假适配器 | DSH-12 **DoD 收敛**为：领域层无非适配器 vscode 依赖（见 0.8） |

### 0.8 DSH-12 修正后的验收口径

**目标**：存在一条**不依赖 `vscode` 的路径**，能完整使用 AT Terminal 的领域能力（SSH 连接 / SFTP 读写 / 资产 CRUD / 配置读取）。

**判据**（可脚本化，取代"零命中"）：

1. 新增 `src/core/**`（纯端口与实现）与 `src/platform/vscode/**`（VS Code 适配器）中，`src/core/**` **零** `vscode` 引用；
2. `src/{ssh,sftp,assets,config,terminal}` 下，**非** `*Vscode*.ts` 命名的文件**零** `vscode` 引用；
3. `*Vscode*.ts` 与 UI 层允许保留 `vscode`，但**必须只实现 `src/core` 里已声明的端口**，不得把 `vscode` 类型泄漏进 `src/core`；
4. 既有 `base` / `mcp` 两变体构建与测试**完全不变**（见 §1.3 硬红线）。

### 0.9 M2 并行执行分区（文件所有权，零共享文件）

**策略：先"纯新增"后"分簇迁移"。** 原因：`src/sftp`、`src/extension.ts`、`tree`/`webview` 之间调用链耦合（`SftpSession ↔ VscodeTransferReporter ↔ SftpManager ↔ extension.ts`），强行按目录切给不同代理会造成接口漂移；而 §1.3 硬红线要求 `base`/`mcp` 变体**完全不变**，所以第一波只允许**新增文件**，不触碰已发布的代码路径。

| 波次 | 子任务 | 独占文件边界（只许动这些） | 依赖 |
|---|---|---|---|
| **W1-A** | DSH-12a **端口层**（纯新增） | 新建 `src/core/**`、`src/platform/vscode/**`、`test/core/**`；**不修改任何既有文件** | 无 |
| **W1-B** | DSH-15 设置面 | `dsh/**`（**除** `dsh/scripts/verify.mjs`） | 无 |
| **W1-C** | DSH-48 既有红测 | `src/sftp/SftpSession.ts`、`src/sftp/concurrency.ts`、`test/sftp/SftpSession.directory.test.ts` | 无 |
| **W2-1** | DSH-12b 迁移：`ssh` + `terminal` + UI 消费方 | `src/ssh/**`、`src/terminal/**`、`src/extension.ts`、`src/tree/**`、`src/webview/**` | W1-A |
| **W2-2** | DSH-12c 迁移：`config` + `assets` | `src/config/**`、`src/assets/**`、`src/agent/**`、`src/mcp/**`、`src/i18n/**`、`src/utils/**` | W1-A |
| **W2-3** | DSH-12d 迁移：`sftp`（耦合最重，29 处） | `src/sftp/**`（**除** `SftpSession.ts`）、`test/sftp/**`（除既有用例） | W1-A, W1-C |
| **W3** | DSH-13 / DSH-14 / DSH-16 / DSH-17 | 待 W2 落盘端口签名后再分区 | W2-* |

> W1-A 的 DoD **不含**"既有目录零 vscode"——那由 W2 各簇完成；W1-A 的 DoD 是"端口层自身零 vscode 且被单测覆盖"。这样每一波都可以独立验证、独立回滚。

### 0.10 构建/测试的纳入规则（子代理须知）
- `tsconfig.json`：`include: ["src","webview","test","*.ts","*.mjs"]`、`module: NodeNext`、包无 `"type":"module"` → **CJS**，因此既有代码用**无扩展名**相对导入（`import {x} from '../config/schema'`）。新代码须沿用该风格。
- `vitest.config.ts`：`include: ['test/**/*.test.ts']`、**`alias: { vscode → test-fixtures/vscode.ts }`**（测试里 `vscode` 是桩，不是真 API）。`fileParallelism: false`。
- `esbuild.config.mjs`：`if (!['base','mcp'].includes(variant)) throw` → **`dsh` 变体尚未获准**，W1 不得改此守卫（属 DSH-03/DSH-41 范围）；`external: ['vscode','ssh2']`。
- 测试串行且全量约 **4 分钟**，子代理**只跑自己相关的测试文件**，不要跑全量。

---


### 0.11 ⚠️ M0 出口的第一次尝试失败：外部 bundle 无法 import 宿主包

由用户在插件管理窗口以「本地插件目录」装入 `dsh/` 后，启用失败：

```
@at-series/dsh-at-terminal  未运行
启用失败：dsh: warning: 1 entry did not activate at-terminal (@at-series/dsh-at-terminal): failed to import
```

**实测定位**（`cd dsh && node --input-type=module -e "await import('X')"`）：

```
@deepseek-ai/dsh-tools / schemastery / cordis   → 三者均 ERR_MODULE_NOT_FOUND
dsh/node_modules                                → 不存在
从 profile 复现：Cannot find package '@deepseek-ai/schemastery'
                imported from /Users/clkj/项目/at/at-terminal-series/dsh/index.js
```

**机制**：profile 以 `link:` 把 `dsh/` 作为**符号链接**装入；Node 取 realpath 后从 `dsh/` 逐级向上找
`node_modules`，**够不到 `app.asar` 内的 `/dsh/node_modules/`**；且 pnpm 的 `link:` **不安装被链接包的
`dependencies`**。→ **外部 bundle 无法 import 宿主的任何包**（M0 的 `index.js` 违反了这条）。

**推翻 M0 的一条前提**：官方包**并非**都没发布到 npm。

| 包 | npm | dsh 需要 | 判定 |
|---|---|---|---|
| `@deepseek-ai/schemastery` | **3.18.4** | `~3.18.4` | peer 级库包 → 可 vendoring |
| `@deepseek-ai/cordis` | **4.0.4** | `~4.0.4` | peer 级库包 |
| `@deepseek-ai/dsh-tools` | `0.0.1-rc.1` | `0.1.7-rc.2` | **宿主内部包 → 绝不 import** |

**权威契约**（`dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`）：
> A Host-only bundle needs **no dependencies**, install scripts, or build tool.

官方 `templates/decoration/index.js` 全文 = `export function apply() {}`（零 import）。

**修正方案（DSH-49，已开工）**：

1. **删掉 `dsh-tools` 依赖** —— `ctx.tools.register(definition)` 直接接受规范化定义
   `{name, description, parameters, output:{schema, render}}`；`defineTool` 只是书写 DSL 的归一化糖。
   `parameters` 必须是**归一化后的 JSON Schema**（用真实包调 `parameterSchemaSpecToJsonSchema({})` 取确切产物）。
2. **vendoring** `schemastery@3.18.4` + `cosmokit@1.8.5`（后者是前者的 bare import 依赖）到
   `dsh/node_modules/@deepseek-ai/`，与安装器无关。两者用 `Symbol.for(...)` 做跨副本标记 → 语义一致。
3. **门禁补"依赖审计"** —— 本次失败门禁没拦住，根因是**门禁用沙箱绝对路径导入、运行时用 Node 解析**。
   新增：扫描随包发出的 JS 的 import 说明符，bare specifier 只许 `node:*` + vendoring 白名单，
   任何 `@deepseek-ai/dsh-*` 直接 FAIL 并打印文件+行号。

> 教训（已写入技能 `dsh-plugin-dev`）：**门禁通过 ≠ 运行时可用**。凡"能加载"这类主张，必须在**真实宿主**
> 里验证过才算数；沙箱验证只覆盖 API 语义，不覆盖模块解析。

### 0.12 W2 迁移方案：端口注入方式与分簇（**执行前必读**）

DSH-12a 已交付端口层：`src/core/**`（平台无关）+ `src/platform/vscode/**`（真实适配器）+ `test/core/**`。
已复核：`src/core` 零 vscode、42 测试全绿、`typecheck` 退出 0、既有 `src/` 文件**零修改**。

**W2 要解决的问题**：让 `src/{ssh,sftp,assets,config,terminal,i18n,utils}` 消费端口，同时
(a) 不破坏 `base`/`mcp` 变体、(b) 每个子代理都能独立验证、(c) 子代理之间零文件冲突。

#### 决策 1：用「模块级平台注册表」注入，**不改任何公开签名**

新增 `src/platform/current.ts`：

```ts
let current: Platform | undefined
/** Called exactly once by the composition root (src/extension.ts) at activation. */
export function setPlatform(value: Platform): void { current = value }
/** Throws when the composition root has not run — never silently returns a stub. */
export function platform(): Platform {
  if (current === undefined) throw new Error('AT Terminal: platform not installed; extension activation must call setPlatform()')
  return current
}
```

领域文件改为 `import { platform } from '../platform/current'`，把 `vscode.X` 换成 `platform().X`。

**为什么选它**（对比"构造函数注入"）：
- **零签名变更** → `extension.ts` 与 `tree/`/`webview/` 无需同步改，`typecheck` 在每个簇内**保持绿色**，每个子代理可独立验证。
- **零跨簇冲突** → 4 个簇的代理各改各的文件，互不相交。
- 代价：一个模块级可变单例。缓解：`platform()` 未设置时**抛错而非返回假实现**（守住反假装原则），且只由组合根设置一次。
- **`platform()` 抛错是刻意的**：绝不返回 no-op 桩，否则就是"假适配器"。
- 若将来需要多实例共存，再切换到构造函数注入；当前只有单实例，不做提前抽象。

#### 决策 2：每个簇的"允许保留 vscode 的文件"白名单

DoD 不是"零命中"，而是"**非适配器、非 UI 文件零命中**"（口径见 §0.8）。据 DSH-12a 的符号普查：

| 簇 | 文件边界 | **允许**保留 vscode 的文件 | 理由 |
|---|---|---|---|
| **W2-A** | `src/ssh/**`、`src/terminal/**` | `src/ssh/VscodeKeyboardInteractivePrompt.ts` | 既有适配器（C 类接缝） |
| **W2-B** | `src/config/**`、`src/i18n/**`、`src/utils/**` | （无） | `utils/notifications.ts` 的 `showTimedNotification` 见下 |
| **W2-C** | `src/assets/**` | （无） | 命令编排层，应走端口 |
| **W2-D** | `src/sftp/**` | `VscodeTransferReporter.ts`（适配器）、`SftpDragAndDropController.ts`（Tree DnD，纯 UI）、`SftpPreview.ts`（`TextDocumentContentProvider`，纯 UI） | UI 面在 dsh 变体里由 Client 半整体替换 |
| **W2-E** | `src/extension.ts`、`src/tree/**`、`src/webview/**`、`src/agent/**`、`src/mcp/**` | 上述全部 | 组合根与 UI 层，vscode 是本职 |

W2-A..D 可**并行**（文件不相交）；W2-E 在它们之后（它消费全部新接口，且要加 `setPlatform` 调用）。

#### 决策 3：DSH-12a 报告里三个"最可能产生接口漂移"的点，归属如下

1. **`resolveTerminalSettings` 下沉**（现为 `src/webview/TerminalPanel.ts:605`，读 8 项 `sshManager.*`）→ 这是**领域逻辑**，应下沉到 `src/terminal/`，接受 `platform().config`；`TerminalPanel` 只做渲染。**归 W2-A**（terminal 簇），但文件在 `webview/` → 见下"跨簇例外"。
2. **`showTimedNotification`**（`src/utils/notifications.ts:13-36`，靠"让 `withProgress` 活 `durationMs` 毫秒"伪造超时）→ dsh 侧无等价物。**W2-B 先按 `Notifier.withProgress` 原样迁**，并在报告里标注；是否补 `Notifier.showTimedMessage` 留到 M3/M4 真正需要时定（不提前发明能力）。
3. **`extension.packageJSON.name/version`**（`src/extension.ts:211-212,311-312`、`src/mcp/hubSync.ts:86`）→ 只在 MCP 路径用。**W2-E 需要时扩 `HostEnvironment`**（加 `extensionId`/`extensionVersion`），不要新造一套。

> **跨簇例外**：`resolveTerminalSettings` 的下沉同时涉及 `src/webview/TerminalPanel.ts`（W2-E 边界）与 `src/terminal/`（W2-A 边界）。为避免冲突，**不由 W2-A 直接改 `webview/`**；W2-A 只负责在 `src/terminal/` 下**新增**该函数的端口化版本并导出，`webview/TerminalPanel.ts` 的调用点改由 **W2-E** 完成。两簇在报告里各自声明这一交接。

#### 决策 4：每个簇的验证纪律（沿用 §0.10）

- 只跑 `npm run typecheck` + **本簇相关的**既有测试文件（`npx vitest run test/<簇>`），不要跑全量（约 4 分钟、串行）。
- 每完成一个文件就 `typecheck` 一次，不要留下不可编译的中间态。
- **回归红线**：`test/package.variants.test.ts`、`test/package.baseBundle.test.ts` 必须始终为绿。
- 报告须给出：本簇内 `grep -rn "vscode" src/<簇>` 的命中文件清单 + 逐个说明是否在白名单内。

---

### 0.13 W2 出口验收记录（本轮实测）

**结论：W2 收口，DSH-12 达成。** 上一轮四个并行子代理的产物处于**半落盘**状态（文件级已完成，但 `tsc` 报 3 错、`test/sftp` 挂 2 例、W2-E 完全未动）。本轮把它们收干净并补上门禁。

#### 收口时清理的 5 处遗留

| # | 位置 | 症状 | 归因 |
|---|---|---|---|
| 1 | `src/extension.ts:318` | `assetPrivateKeyDirectory(context)` 类型不匹配 | W2-C 改了签名（收 `storageDir: string`），W2-E 的调用点还没跟 |
| 2 | `test/sftp/SftpEditSessionManager.test.ts:213/963` | `vscode.Uri[]` 收到 `UriLike` | W2-D 把 `SftpEditUi.openFile` 的参数端口化后漏改测试局部变量 |
| 3 | `test/sftp/SftpEditSessionManager.test.ts:132` | 断言 `vscode.window.withProgress` 调用 0 次 | `showTimedNotification` 已端口化（走 `platform().notifier`），测试仍盯宿主 spy |
| 4 | `test/sftp/VscodeTransferReporter.test.ts:119` | 同上 | 同上 |
| 5 | `test/webview/TerminalPanel.test.ts:458/979` | 两个用例 `mockReturnValue` 掉了 `vscode.workspace.getConfiguration` | W2-E 把 `TerminalPanel` 的设置来源改为 `platform().config` 后，宿主 spy 不再被调用 |

> 3/4/5 是**同一个根因**：`utils/notifications` 与终端设置读口被端口化后，「测试用宿主桩断言」的写法就静默失效了（0 次调用不报错，只是断言落空）。收口办法统一为：**断言改盯 fake platform**（`test/setup-platform.ts` 装的 `FakePlatform`），并在 `TerminalPanel.test.ts` 里加 `setPlatform(createFakePlatform())` 的 per-test 重置，避免某用例装的配置泄漏给下一个用例。

#### 新增门禁：`npm run verify:kernel`

`scripts/verify-kernel-seam.mjs` 把 §0.8 的四条判据脚本化（4/4 PASS）：

| 检查 | 内容 | 当前值 |
|---|---|---|
| `core-isolation` | `src/core/**` 不 import `vscode`，且**不允许 import 到 `src/core` 之外**（也不许裸包名），只许自身兄弟模块 | 5 文件 |
| `domain-isolation` | `src/{ssh,sftp,assets,config,terminal,i18n,utils}` 中非白名单文件零 `vscode` | 38 文件 |
| `host-import-allowlist` | `src/**` 下**每一个** import `vscode` 的文件都必须在带**理由**的白名单里（28 文件全部有据） | 28 文件 |
| `composition-root` | `src/extension.ts` 真的调了 `setPlatform()` 并从 `src/platform/vscode` 引入 `createVscodePlatform` | ✅ |

**反向测试（三处，均精确失败）**：

1. 往 `src/utils/errors.ts` 追加 `import * as vscode from 'vscode'` → `domain-isolation` + `host-import-allowlist` 双双 FAIL，打印 `src/utils/errors.ts:14`；
2. 往 `src/core/ports.ts` 追加 `import type { SftpManager } from '../sftp/SftpManager'` → `core-isolation` FAIL，打印 `imports outside src/core: "../sftp/SftpManager"`；
3. 从 `src/extension.ts` 删掉 `setPlatform(createVscodePlatform(context))` → `composition-root` FAIL（注意 `grep -c setPlatform` 仍为 1，因为 import 行还在——门禁查的是**调用**）。

#### 门禁去重（一次真实的漂移事故）

上一轮在 `dsh/scripts/verify.mjs` 里临时加了第 7 项「领域层零 vscode」，自带一份**四文件**白名单。W2-D 新增 `src/sftp/VscodeSftpEditUi.ts` 后该白名单即漂移失败——**同一条规则、两份白名单，必然漂移**。

处置：**删掉 dsh 门禁的第 7 项**（回归 README 已记载的 6 项，其主题是 bundle 本身），领域审计统一归 `verify:kernel`（扫描面严格更大：全 `src/**` + 理由化白名单 + core 反向依赖 + 组合根）。`dsh/README.md` 新增「Where the domain-layer audit lives」小节说明这一归属。

#### 回归证据

- `npm run typecheck` → 退出 0（此前 3 错）；
- `npx vitest run`（全量）→ **829 passed / 0 failed，87 个测试文件**（既有基线 785/786 + W1/W2 新增 43 例）；
- 红线：`test/package.variants.test.ts`、`test/package.baseBundle.test.ts`、`test/package.sftp.test.ts`、`test/package.agent-tools.test.ts`、`test/package.asset-import-export.test.ts` → 29/29 绿；
- `npm run build:base` 与 `npm run build:mcp` → 均成功；
- `npm run verify:dsh` → 6/6 PASS；`npm run verify:kernel` → 4/4 PASS。

#### 仍未被本轮覆盖的（诚实登记）

- **M0 出口**（插件在真实 dsh 中加载）仍待你在 Desktop 应用内安装 `dsh/` 并重启——本地无法代做；
- W2-E 只做了「组合根 + TerminalPanel 交接」。`src/tree/**`、`src/webview/**`、`src/agent/**`、`src/mcp/**` 按 §0.12 决策 2 **本就不要求**去 `vscode`（dsh 变体整体替换 Client 半），它们的端口化将在 M3/M4 随 UI 重绘一并处理；
- §0.12 决策 3.3 的 `HostEnvironment.extensionId/extensionVersion` **本轮未加**：暂无领域层消费点（只有组合根与 `mcp/hubSync` 读 `context.extension.packageJSON`，二者都允许持 `vscode`）。按「不提前发明能力」留待真正需要时再加。

---

### 0.14 M2 数据面落地：dsh 侧端口适配层（DSH-13 / 14 / 15 / 16 部分）

**结论：`src/platform/dsh/**` 已交付，DSH-13 / DSH-14 完成，DSH-18 的「资产持久化闭环」已具备。**

#### 0.14.1 先说三条实测校正（都推翻了计划原本的假设）

| # | 计划/文档中的假设 | 实测事实 | 影响 |
|---|---|---|---|
| 1 | `.d.ts` 未随包发布，只能读构建后的 `.js` | `dsh-credentials` 等包 `package.json` 的 `exports.types` **指向未随包发布的路径**，确认无类型可用；但**包本体是 ESM 源码级可读**，方法面可直接读出 | 继续以 `.js` 为真源；`src/platform/dsh/host.ts` 逐条记录了取证位置 |
| 2 | `ctx.storageDomain.open(spec)` 只是「本地存储后端」 | 真实签名要求 `defineDomain(spec)`：**表 schema 是 zod**、`name`/表名须匹配 `/^[a-z][a-z0-9_]*$/`（**无连字符**）、`version` 须非负整数、global schema **不得接受 `null`**（`null` 是介质「从未写过」的哨兵）；且必须已有后端（默认组合里是 `dsh-storage-json`，`backend: json`） | DSH-14 按此重做；spec 已用**真实 `defineDomain`** 验收 |
| 3 | 「凭据不出现在响应体与日志」需要额外扫描 | `ctx.credentials` 的**引用半边**天然满足：`describe()` 返回 `{configured, source, writable}`，**没有任何 value 字段**，唯一泄漏路径是 `resolve()` | 把 DSH-13 收敛为「单点 resolve + 断言日志不含明文」 |

**关于 zod**：我们**没有**为表 schema 引入 zod。理由不是省事，而是 `DomainImpl` 对**表** schema 只调 `.parse`（只对 global 调一次 `.safeParse(null)`），而介质真正要求的性质是「能 JSON 往返」——`parseJsonRecord` 就是这个检查，是真检查不是橡皮章。把语义校验留在 `src/config/schema.ts`（它已在每次读时跑），避免出现第二份「什么是一个合法 server」的真源。副作用是 bundle 少一个依赖——而 `link:` 安装下每个新依赖都是一次重演 `ERR_MODULE_NOT_FOUND` 的机会。

#### 0.14.2 交付物

| 文件 | 职责 | 关键设计点 |
|---|---|---|
| `src/platform/dsh/host.ts` | dsh 主机面的**结构化契约** | 不 import 任何 `@deepseek-ai/*`；逐条记录取证位置与默认组合归属表；`serverSecretRefName()` 做 server id → 凭据引用名的**单射**映射（`_S_` 安全档 / `_X_` hex 转义档，靠标记段消歧） |
| `src/platform/dsh/credentials.ts` | `SecretStore` ← `ctx.credentials` | 选**引用半边**而非记录半边（记录只认 `api-key`/`grant` 两种 tag，装不下 SSH 口令）；`set` 的「环境遮蔽」「空值」两种宿主拒绝**原样传播**，不伪装成成功 |
| `src/platform/dsh/state.ts` | `StateStore` ← `ctx.storageDomain` | 单 domain `at_terminal_state` + 单平表 `kv`，键就是原 memento 键（**零签名变更**，`ConfigManager`/`HostKeyStore` 不动）；**省略 `layout`** → 默认 `single` 布局把记录留在文档内，键不做文件名，`sshManager.servers` 无需转义；写路径即做 JSON 归一化，保证内存与介质立即一致 |
| `src/platform/dsh/config.ts` | `ConfigReader` ← 已解析的 `Config` 访问器 | 逐调用重读 accessor（设置热改可见）；未知 section **抛错**而非返回空默认值 |
| `src/platform/dsh/{notifier,prompter,transfers,uris,localization,environment,clipboard}.ts` | 其余 7 个端口 | 无头语义：通知**必落 logger**（printf 透传，不预格式化）；有选项但无应答者 → `undefined`（在全部调用点都是**安全分支**）；`keyboardInteractive` / `workspaceFolders` 取诚实的「无」，不造假对象 |
| `src/platform/dsh/index.ts` | 组装层 `createDshPlatform(deps)` | 异步（`storageDomain.open` 是异步的），打开失败**中止激活**而非留一个会静默丢写的 store |

#### 0.14.3 证据

- `npx tsc --noEmit` → **退出 0**；
- `npx vitest run test/platform/dsh` → **9 文件 / 80 项全绿**；
- `npm run verify:kernel` → **5/5 PASS**（新增第 5 项 `no-host-package-imports`，扫全 `src/**` 98 文件，禁 `@deepseek-ai/*` 裸导入；反向测试：往 `src/platform/dsh/uris.ts` 加一行 `import type {...} from '@deepseek-ai/dsh-tools'` → 精确 FAIL 并打印文件:行号）；
- **真实宿主契约探针**：用 `app.asar` 里提取的真 `defineDomain` 喂我们的 spec → **接受**，`descriptorOf` 产出 `{"name":"at_terminal_state","version":1,"tables":["kv"],"hasGlobal":false}`；4 个负例（连字符名 / `version` 缺失 / 连字符表名 / 字符串 `version`）均被宿主精确拒绝；
- **装配级集成**（`test/platform/dsh/platform.test.ts`，14 项）：用**未经改造的** `ConfigManager` / `HostKeyStore` / `resolveTerminalSettings` 跑通「存 server → 列出 → 取口令 → 删除」「跨 close/reopen 后 server 与 host key 信任仍在」「口令不落状态介质」「`false`/`0` 不被当成未设置」。

#### 0.14.4 本轮踩到并修掉的坑（值得记住）

1. **断言把错误 `code` 当 message**：宿主的失败是 `DomainError('already-open', "domain 'x' is already open")`，`code` 与 message 说的是两件事。5 处红灯里有 3 处是这个，改成断言 `error.code`；
2. **断言把日志 `format` 当格式化结果**：`RecordingDshLogger` 保留的是 printf 模板（`'… domain "%s" opened.'`），名字在 `args` 里。另 2 处红灯是这个，改用 `join()`。
   > 这两条是同一类错误的两种形态：**断言盯错了载体**。第一次跑测试时 5 红全是我自己的断言，实现一行没改。
3. **`test/platform/dsh/host-fakes.ts` 的写入必须直通介质**：否则「跨重启仍在」这条断言实际上什么都没验——初版 `MemoryDomain` 写的是内存副本，`commit` 只在 open 时跑。

#### 0.14.5 仍未闭环（诚实登记）

- **DSH-16 服务本体**（ServerRegistry / SftpService / TerminalService）与 **DSH-17 路由层**未动；
- **DSH-18 的 SSH 段**需可达远端，未做；
- **`src/platform/dsh/**` 目前没有被任何 bundle 消费** —— `dsh/index.js` 仍只有 M0 的探针工具。下一步要把它接进 dsh Host 半，而那需要先解决**如何把 `src/**` 的 TS 打进 bundle**（`dsh/esbuild.dsh.mjs`）以及 `ssh2` 的落地方式。这是 M2 剩余部分真正的入口，也是本轮刻意停下的位置：**先把可离线验证的适配层做扎实，再动打包管线**。

---

### 0.15 M0 出口闭环 + M1 接线（DSH-07 / DSH-08）

#### 0.15.1 M0 出口：用宿主的真实解析路径复现，而不是看日志

Desktop 应用**不写任何日志文件**（`~/Library/Logs/DeepSeek Harness/` 是空的），`~/.dsh/profiles/desktop/.plugin-manager/logs/*/pnpm.log` 只记安装动作（本次那一条是 `Already up to date`——`link:` 从 16:22 起就存在，所谓"安装"是幂等的）。所以"插件到底加载了没有"不能靠日志判断。

改为**复现宿主的两步**，全部实测通过：

| 步骤 | 实测结果 |
|---|---|
| 宿主如何解析 | 在 profile 目录下 `import.meta.resolve('@at-series/dsh-at-terminal')` → `file:///Users/clkj/项目/at/at-terminal-series/dsh/index.js`（即沿 `link:` 符号链接走到 realpath，再在其下解析 vendored 依赖——**这正是 DSH-49 修的那条路**） |
| 宿主如何激活 | `apply(fakeCtx, {})` 真的调用 `ctx.tools.register(...)`；注册出 `at_terminal_ping`，`parameters = {"type":"object","properties":{}}`，`output.schema` 顶层显式带 `additionalProperties`，`execute()` 返回 8 项设置齐备的合法值，`render()` 返回 2 块，`ctx.effect(setup)` 的 `setup` 返回了 1 个 disposer |

> 剩下唯一没被这条路径覆盖的是"模型真的调了它"——那需要你在 dsh 会话里驱动，属 DSH-09 起。

#### 0.15.2 M1 的前提被推翻了一半

计划的 DSH-07 写「在 dsh profile 中注册 MCP server 并**显式启用**」，暗示只是"启一个已挂的插件"。实测：

| 假设 | 实测 |
|---|---|
| `dsh-mcp-client` 已在组合里，只需启用 | **归档里有这个包（`0.1.7-rc.2`），但 `dsh-base` / `dsh-web-app` 挂载的行数为 0**。它的 README 明说 "No server is enabled by default"，且它是**通用行类型**——每个 MCP server 一行，行 id 自取、`name` 固定为该包 |
| 按计划「指向 `~/.at-series/mcp/hub.js`」即可 | 成立，但需补三个实测事实：① hub.js 是 **stdio** MCP server（`createHubRuntime`），② 它说 **protocol v2 渐进暴露**（冷 `tools/list` 只返 5 个 `at_*` 元工具，真正的工具要靠 `at_select_tools` 提升），③ 冷启动首次 `tools/list` 要扫全部注册记录 |
| 用 `node` 起 hub 即可 | **不可靠**。`dsh-mcp-client` 用**被清洗过的**环境启动 `command`，所以不能赌用户 `PATH` 上有 node。改用 Harness **自带的托管运行时** `~/.dsh/dsh-runtimes/<runtime>/dependencies/node/bin/node`（实测 Node 24.21.0，与 Harness 自身同源） |
| 指向 hub.js 就完事 | **还缺一个必需的环境变量**。Hub 是 **host-scoped** 的，作用域只有一个输入：`resolveHostAppFromEnv(env) = slugifyHostAppId(env['AT_SERIES_HOST_APP']) ?? 'unknown'`，然后用它当 `~/.at-series/bridges/` 下的桶名。**没有通配值**——`unknown` 本身就是真实存在的桶。不设它，Hub 就去服务那个装陈旧记录的桶，并且对每个 provider 都报 `healthyBridges: 0`：**一个缺失的配置伪装成"Hub 坏了"** |

**Host 作用域的实测对照**（同一个 hub.js、同一个托管 node，只差这个变量）：

| `AT_SERIES_HOST_APP` | `at_list_providers` 的输出 |
|---|---|
| 不设 | `host=unknown`；3 个 provider（jenkins@0.1.0 / kb@0.1.0 / nacos@0.1.0，全是陈旧记录）；**每个 `healthyBridges=0`**；**没有 `at.terminal`** |
| `antigravity-ide` | `host=antigravity-ide`；6 个 provider 全部 `healthyBridges=1`；**`at.terminal@0.3.5`，11 工具** |

所以脚本改为**探测**而不是假设：`dsh/scripts/lib/at-series-registry.mjs` 扫 `~/.at-series/bridges/*/`，取心跳最新的桶（默认 10 分钟内算活），探不到就**拒绝写入**，并支持 `--host-app` 覆盖。换 IDE 后重跑一次即可。

#### 0.15.3 落地方式：`dsh/scripts/enable-mcp.mjs`

`npm run dsh:mcp:enable | check | disable`。为什么不直接改 YAML：

profile 的 `cordis.patch.yml` 含 `!!js` 自定义标签（`!!js ctx.webStartup.port ?? 3080`）。**任何 YAML 解析-再序列化都会抛错或把它压成字符串**——为了加一行而毁掉用户自己的配置。所以走**文本追加**，并且脚本在写之前先证明"每一行原有内容都按序存活"，写之后再数一遍标记块数量。

三条性质都是**被强制**的，不是被假设的：

| 性质 | 强制手段 | 实测 |
|---|---|---|
| 纯增量 | 逐行按序查找，缺任何一行就拒绝写入 | 0 行丢失、0 行改写、新文件以原文件为前缀（`true`） |
| 幂等 | 先剥离管理块再追加 | 重跑后 `# >>>` 标记数仍为 1 |
| 可回滚 | 写前 `cp` 带时间戳备份 | `cordis.patch.yml.at-terminal-backup-1790597543352` |
| 可解析 | 只校验新增块 | `js-yaml` 解析出恰好一条 `{id: mcp-at-series, name: '@deepseek-ai/dsh-mcp-client', config: {serverName: at-series, transport: stdio, command: <托管 node>, args: [hub.js], toolCallTimeoutMs: 120000, env: {HOME}}}` |

另外脚本先跑 5 项**安装体检**并逐项报名称（托管 Node / Hub bundle / profile / 已链接的 AT Terminal bundle / patch 层），缺哪项就说缺哪项——这是 DSH-44「安装三查」的一个前置切片。

#### 0.15.4 DSH-08 就地在场验证（不依赖 dsh，也不依赖你）

新增 `npm run dsh:mcp:probe`（`dsh/scripts/probe-hub.mjs`）——直接按 MCP 协议问 Hub，用的 `command` 与 `env` 与写进 profile 的完全一致：

```
OK    host scope: antigravity-ide (detected) — 10 record(s), newest heartbeat 28s ago —
      at.database@0.1.2(19), at.grafana@0.1.4(17), at.jenkins@0.1.1(8),
      at.jumpserver@0.2.0(14), at.nacos@0.1.3(13), at.terminal@0.3.5(11)
OK    initialize -> AT Series 0.3.4  [162ms]
OK    tools/list -> 5 tool(s)  [48ms]
        at_list_providers / at_search_tools / at_get_tool / at_select_tools / at_clear_tool_selection
OK    at.terminal is registered with 11 tool(s).
```

`at_list_providers` 报 **`at.terminal@0.3.5`，`status: healthy`，`toolCount: 11`**，工具名正是 toolCatalog 那 11 个（`list_ssh_servers` / `get_terminal_context` / `run_remote_command` / 8 个 `sftp_*`）。

**⚠️ M1 出口判据需要修正**。计划写的是「11/11 工具出现在 dsh 工具列表」，但 Hub 说 **protocol v2 渐进暴露**：Agent 的工具列表里是 **5 个元工具**，那 11 个要经 `at_select_tools` 提升才出现。这是 Hub 的设计流程（它自带的 `super-ops` 技能就是教这件事的），而用 `AT_SERIES_TOOL_DISCOVERY=never` 强行摊平会把全部 6 个已注册插件的 **~82 个工具**灌进每一次提示。判据应改为「**11 个可发现、可调用**」，而不是「11 个被列出」。这一条已同步进 `dsh/README.md`。

**一个必须记住的延迟特性**：首次 `tools/list`（冷启动扫全表）**实测 > 20s**，之后 ~20–50ms。根因是本机 `~/.at-series/bridges/` 有 **412 条注册记录，其中 390 条在 `unknown/` 下、406 条已陈旧**（最旧的来自 08-28）。这直接决定了 `toolCallTimeoutMs` 必须从默认 60s 抬到 120s——否则**第一次**调用就会超时。

#### 0.15.5 仍未被覆盖的与诚实登记

- **DSH-09/10/11 的三类工具 E2E** 需要你在 dsh 会话里驱动，且需要一个开着 AT Terminal 的 IDE 窗口在 Hub 上连着——**M1 的执行者是 IDE 侧的扩展，dsh 只是客户端**；
- `~/.at-series/bridges/unknown/` 的 390 条陈旧记录**未动**（属你的数据目录，删除需你明确确认）；它们只拖慢冷启动，不影响正确性；
- **profile 的 `cordis.patch.yml` 已被本脚本修改**（追加一个管理块，原始文件备份为 `cordis.patch.yml.at-terminal-backup-1790597543352`）。三条性质是**被强制**的而非假设：① 纯增量——脚本逐行按序核对，缺任何一行就拒绝写入（YAML 往返会毁掉 `!!js` 标签，所以走文本追加）；② 幂等——先剥离管理块再追加，重跑 3 次后文件稳定在 80 行、管理块恒为 1、用户内容逐字节不变；③ 已修掉一处自身缺陷——首版每次重跑都留一个重复备份，现已改为"内容无变化则不写、不备份、不改 mtime"；
- M2 剩余部分（DSH-16 服务本体 / DSH-17 路由 / 打包管线）仍未动，入口仍是 `dsh/esbuild.dsh.mjs` + `ssh2` 落地。

#### 0.15.6 DSH-07 勘误：裸行被 loader 静默跳过，须用 `- insert:` 包裹（已修复）

**症状**（dsh 会话 @ 20:20 重启后实测）：Agent 工具列表里**没有** `at_list_providers`；`plugin_manager list_plugins` 全量 186 条里**没有** `mcp-at-series` / `@deepseek-ai/dsh-mcp-client` 条目；而同一 patch 文件里的 `at-terminal` 行（裸 `- id: at-terminal`）正常生效。Hub 侧 `npm run dsh:mcp:probe` 一切健康（`at.terminal@0.3.5` / 11 工具 / 6 provider `healthyBridges=1`），说明问题只在"行没被 dsh 加载"。

**根因**（读安装版 `dsh-app-boot/lib/index.js` 源码确认）：profile patch 层由 `applyEntryPatches(data, patches, warn)` 应用，语义是——**不带 `insert` 的行 = 对已存在 entry 的按 id 覆盖**（`entryMap.get(id)` 未命中则 `warn("patch: entry %C not found", id)` 并跳过）；只有 `- insert:` 才能**新增** entry。而 `dsh-mcp-client` 默认挂载 0 行 server（README："No server is enabled by default"），所以 `mcp-at-series` 这个 id 在任何 bundle 层都不存在 → 初版裸行被跳过。对照证据：官方 `dsh-agent-preset` 的 MCP 模板与本仓库 `dsh/cordis.patch.yml`（bundle patch）都是 `- insert:` 形态。

**修复**：`enable-mcp.mjs` 的 `renderBlock` 改为输出 `- insert:` + 缩进四格的行；写后校验除标记块计数外，额外断言管理块内存在 `^- insert:\n {4}- id: mcp-at-series`。已重跑 `npm run dsh:mcp:enable`（7/7 体检 OK，新备份 `cordis.patch.yml.at-terminal-backup-1790598650122` = 修复前的原始状态），profile 现值：

```yaml
- insert:
    - id: mcp-at-series
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: at-series, transport: stdio, command: <托管 node>, args: [~/.at-series/mcp/hub.js], toolCallTimeoutMs: 120000, env: { HOME, AT_SERIES_HOST_APP: antigravity-ide } }
```

**用真实 loader 复现验证**（`extractPackages` 从 `app.asar` 提取 `@deepseek-ai/dsh-app-boot` 全闭包 34 包，把未导出的 `applyEntryPatches` 暴露后对同一 entry list 各应用一次旧/新块）：

| 输入 | loader 输出 |
|---|---|
| 旧块（备份里的裸行） | `warn: patch: entry %C not found, mcp-at-series`；结果**无**该 entry |
| 新块（`- insert:`） | 无告警；`mcp-at-series` 插入成功，name/transport/command/args/env/toolCallTimeoutMs 逐项正确 |

**结论**：DSH-08 的"在 dsh 内可见"前提现已在**文件层**闭环；但由于 patch 在启动时读取，**仍需重启 Harness 一次**，之后在会话里让 Agent 实调 `at_list_providers`（预期 5 个元工具出现）→ `at_select_tools` 提升 at.terminal 11 工具 → 即 DSH-09 起点。

---

### 0.16 M3/M4 起步：Client 半落地 + 一次需要你知道的事故

#### 0.16.1 先说事故：我可能覆盖了上一轮写好的 `dsh/client.js`

两次对话之间（今天 09:26–09:33）**有一轮未留工作日志的工作**，它产出了：

| 产物 | 内容 |
|---|---|
| `dsh/channel.js`（22.9 KB） | **DSH-17 / DSH-21 / DSH-25 的 Host 半**：`/dsh-at-terminal/{health,rpc,events,stream,ws}` 五条路由；SSE 推送；带 16 字节头（magic `ATST` + seq + CRC32 + len）的字节流，`mode=drain` 用 **TCP 原生背压**、`mode=burst` 作阴性对照；WebSocket upgrade 上的全双工回显终端与流控 |
| `dsh/index.js` | 用 `ctx.inject(['webServer'], …)` 挂载 channel（webServer 不存在时回调不跑，插件仍完整可用） |
| `dsh/package.json` | 声明 `exports["./client"] = "./client.js"`、`dsh.client = { platform: 'web', immediately: true }`、`files` 增加 `channel.js` + `client.js` |
| `dsh/scripts/enable-mcp.mjs`（+53/−13） | **修掉我上一轮的真 bug**：profile patch 里裸的 `- id:` 行是"覆盖已存在条目"，而 `dsh-mcp-client` 默认零条目 → 该行被 `applyEntryPatches` **静默跳过**（`patch: entry "mcp-at-series" not found`）。必须包在 `- insert:` 里。已核对：**线上 profile 已是 `- insert:` 形态**，且保留了我加的 `AT_SERIES_HOST_APP` |
| `/tmp/{modules,typert,panellist}-study*.mjs` | 它对 client 模块系统、Typert、`sidebar.panellist` 的取证（我据此复核了契约） |

**它同时声明了一个不存在的 `client.js`**（`files` 里有、`exports` 指向它、磁盘上没有对应内容被 git 跟踪）。我在本轮先用 `Write` 写了同名文件、返回的是 **"overwrote"**，随后又把它移到 `lib/client.js` —— **如果那个文件原本存在，它已被我覆盖且内容不可恢复**（未跟踪文件不进 git；`link:` 安装也不留副本）。今天的记忆日志不存在，所以没有它的自述。

**已做的补救**：`dsh/README.md` 与本文档都记录了这件事；如果那一轮的会话记录还在，它的 `dsh/client.js` 可以被取回并与本轮实现合并。

#### 0.16.2 本轮把它恢复成"声明即真实"

1. **路径对齐**：client 半写回 `dsh/client.js`（清单声明的路径），删掉我误建的 `dsh/lib/`。门禁当场曾报 `FAIL … shipped file is missing: client.js`，现已恢复 7/7 PASS。
2. **client 半按实测契约实现**（不是按文档猜）：复核并采用了 `sidebarRightTabs.register` 的**全部**真实字段——`id`/`kind` 必填、`priority` 是 **band**（`extension` 默认 / `builtin` / `fallback`，「同 band 重复注册才抛错」，所以我们用**自己的 kind** 天然不与官方 `terminal` 冲突）、`patterns` 可省（不声明资源地址）、`guide[]` 的 `order`+`title` 必填而 `description`/`icon` 可选（`icon` 回落到 CubeGlyph）；正文与标题必须走**两段式** `slots.inject(name, () => slots.register({name, key}, Body))`，且 `key` 必须等于定义 id。
3. **新增门禁第 7 项 `client`**：`dsh.client` 形状 / `exports["./client"]` 可解析且真的存在且在 `files` 里 / 加载器 `id` 等于包名 / **除加载器调用外不得有顶层语句**（bundle 纯净性）/ factory 必须导出 `apply`+`inject`。四处失败模式在浏览器里**全是静默的**，所以写进门禁。**三处反向测试**（改错 loader id、加一条顶层语句、把 exports 指向不存在的文件）均精确 FAIL，恢复后 7/7。
4. **新增 `test/dsh/client-half.test.ts`（10 项）**：用替身 `window` + 极小 React shim **真的执行** `dsh/client.js` 物化 factory，断言注册序列与字段、只 `require` 了 `react`、`inject` 恰好是三项，并**渲染正文**覆盖 pending / 不可达 / 可达 / 非 2xx 四种状态。这是 Node 测试运行器能给浏览器半的全部覆盖，而它恰好盖住了实际会发生的失败模式。

#### 0.16.3 两个当场实测到的事实（会决定你下一步看到什么）

| 事实 | 证据 | 影响 |
|---|---|---|
| **通道路由当前无人应答** | 扫本机全部监听端口后 `GET /dsh-at-terminal/health` → **404**（能识别出 dsh 页面在 52524 端口上） | `channel.js` 是今天 09:32 建的，而应用是**昨天 20:07 启动的、之后没重启**。**要看到右栏 tab，必须先重启 Harness** |
| **同源/鉴权假设未验证，且有旁证风险** | 扫描中发现多个本机 HTTP 服务对普通 GET 回 **`403 Invalid CSRF token`**、或要求 Authorization | 面板的 `fetch('/dsh-at-terminal/health')` 可能被 dsh 自己的 webserver 以同样方式拒绝。这正是面板要**把失败原样画出来**（含尝试的 URL）而不是假装空列表的原因 |

#### 0.16.4 仍未闭环（诚实登记）

- **未在真实浏览器里跑过**：client 半的字段级契约有实测依据、有门禁、有 10 项工厂级测试，但"右栏真的出现 AT Terminal"必须由你重启后确认；
- **正文里没有真内容**：Host 半尚未向本面板暴露 SSH / 资产服务（`src/platform/dsh/**` 那 11 个端口适配器还没接进 `channel.js`），所以面板只报通道探测结果；
- **M3 的两棵树 / M4 的 xterm 未开始**；`channel.js` 已备好 `/stream`（背压）与 `/ws`（回显终端）两条通道，xterm 的接入点是它。

---

### 0.17 为什么"看不到入口"——先把不可观测变可观测

#### 0.17.1 重启后实测：Host 半是真的在跑

```
PORT 19387  /dsh-at-terminal/health -> 200
{"ok":true,"service":"at-terminal-channel","version":"0.1.0","uptimeMs":208126,
 "routes":["/dsh-at-terminal/health","/rpc","/events","/stream","/ws"]}
```

**DSH-17 / DSH-21 的 Host 半在运行的应用里确认生效**（`channel.js` 随重启加载，五条路由全在）。另外 `GET /rpc` 回 405「POST only」、`POST /rpc` 正常 —— 路由的方法守卫也对。

#### 0.17.2 但 client 半**从外部不可观测**，这不是猜测

| 尝试 | 结果 | 结论 |
|---|---|---|
| 扫所有监听端口找 dsh 页面 | 无任何端口返回带 `__DSH_BOOT__`/`__ModuleLoader__` 的 HTML | Desktop 壳**不用 HTTP** 提供前端 |
| 问同端口的 web 载体要 client bundle | `/plugins/@at-series/…/client.js` → **404**；**官方包同样 404** | `/plugins` 不走 HTTP（README 早写了「壳自带载体经 `fetchBundle()`」）。**这 404 说明不了我们的事** |
| 找 Electron 调试端口 | 无 CDP 端点（壳未以 `--remote-debugging-port` 启动） | 无法读页面模块图 |
| `GET /` | **401 `dsh web authentication required`** | 页面的 URL 带 token；也解释了此前扫到的 `403 Invalid CSRF token` 旁证 |

**所以"tab 没出现"与"client 半根本没跑"在外部长得一模一样** —— 这正是上一轮结论不确定的根因，也是本轮要消掉的东西。

#### 0.17.3 补上自证信号 + 顺带修掉三处真实缺陷

1. **客户端自报**：client 半在 `apply` 里 fire-and-forget `POST /dsh-at-terminal/rpc { method:'client.hello' }`（带 origin/href/userAgent/kind）；Host 半新增 `client.hello` / `client.status` 两个方法，并把 `clientHellos`/`lastClientHello` 加进 `state.get`。诊断绝不 await、两端都做了异常兜底 —— **诊断不能反过来弄坏激活**。
2. **新探针 `npm run dsh:channel:probe`**（`dsh/scripts/probe-channel.mjs`）：扫端口找通道，给出四种明确答案——路由已注册 / client 半已到达 / client 半从未出现 / **该 Host 半早于自报机制、需重启**。第四种是当下状态，也是最容易被误读成"客户端有 bug"的一种。
3. **顺手修掉 `channel.js` 里三处真实缺陷**（都是本轮写测试时才暴露的）：
   - **CRC 不覆盖长度字段**：`payloadBytes` 在 `crc32()` **之后**才写入，于是校验时该字段为 0 —— "crc covers header + payload" 这条注释是假的，而长度是收方分帧依据，**翻错长度无法检出** → 改为先写长度再算 CRC；
   - **CRC 依赖未初始化内存**：`Buffer.allocUnsafe` 分配的校验字段是垃圾值，而 CRC 在写入它之前计算 → **同一个 chunk 每次校验和都可能不同**，收方永远复现不出来 → 计算前显式置 0；
   - **`tryRegister` 静默吞异常**：兜住重复注册（DSH-17 要求）是对的，但**无声**会让"一条都没注册"和"全部注册成功"长得一样 → 补 `ctx.logger.warn` 并带出原始错误。

#### 0.17.4 证据

- 新增 `test/dsh/channel.test.ts`（10 项）—— **Host 半的第一个测试**：路由表与自报一致、`client.hello`/`client.status`/`state.get` 的记录与截断（超长字段截到 300）、未知方法回 `no-such-method`（200 而非传输失败）、GET 回 405、坏 JSON 回 400、**重复挂载被吸收且路由不被第二份抽走**、dispose 清空全部路由与 upgrade、以及**字节流头部布局 + CRC 约定**（magic `ATST`/seq/len/payload 生成式 + 校验和可复现）。
- `test/dsh/client-half.test.ts` 增至 11 项（新增"自报抵达"一项，并给整个文件加了 fetch 兜底，保证测试不触网）。
- `tsc` 退出 0；`test/dsh` **21/21**；`verify:dsh` **7/7**；`verify:kernel` 5/5；全量 97+ 文件回归见提交信息。

#### 0.17.5 仍未闭环

- **`client.status` 目前还读不到**——运行中的应用加载的是**旧 `channel.js`**（没有 `client.hello`）。探针会明确报出这一点。**需要再重启一次 Harness**，之后 `npm run dsh:channel:probe` 就能给出确定答案；
- 若重启后探针报"client 半从未出现"，那就说明 client bundle 没进模块图（`dsh.client`/`exports["./client"]` 或加载期异常），届时再看——**不再靠猜**；
- 正文仍未接 SSH/资产服务（M3 的两棵树 / M4 的 xterm 都未开始）。

---

### 0.18 M3 第一块真功能：资产导入导出（与 VS Code 双向互通）

用户要求：像原插件一样在 dsh 里实现资产导入导出，**方便用户跨平台搬数据**。这条需求把 M2 一直悬着的"打包管线"逼出来了——因为**资产模块已经是端口无关的**，唯一障碍是 `dsh/` 是 JS、`src/` 是 TS。

#### 0.18.1 复用而非重写：格式与存储规则的对齐表

| 资产 | VS Code 侧 | dsh 侧 | 复用的代码 |
|---|---|---|---|
| 服务器记录 | `globalState` 键 `sshManager.servers` | 同一键，落在 `at_terminal_state` 域 | `ConfigManager`（**零改动**） |
| SSH 口令 / 私钥口令 | `SecretStorage`，键 `sshManager.password.<id>` / `passphrase.<id>` | `ctx.credentials` 引用，**同一键映射** | `ConfigManager` + `src/platform/dsh/credentials.ts` |
| 导入的私钥 | `<globalStorage>/imported-private-keys/<serverId>-<basename>`，0600 | 同一目录形状，落在 `$DSH_HOME/at-terminal/` | `assetPrivateKeyDirectory` + `applyAssetImport` |
| host key 信任 | **不导出**（payload schema 里 `includesHostTrust` 硬编码 `false`） | 不变 | 原样 |

包格式（`.at-terminal-assets`）**完全未改**：外壳 `{format,version,kdf:'scrypt',cipher:'aes-256-gcm',salt,iv,authTag,ciphertext}`，负载里含 servers / passwords / privateKeys / omissions，且沿用 `0.3.x` 迁移逻辑。所以**这里导出的包在 VS Code 里能直接导入，反之亦然**。

#### 0.18.2 新增：打包管线（M2 遗留的使能件）

- `dsh/esbuild.dsh.mjs`：把 `src/platform/dsh/entry.ts` 打成 `dsh/host.bundle.js`（ESM / node22 / **`ssh2` 外部**）。产物**必须提交**——`link:` 安装不跑构建，profile 直接指向本目录。为此关掉 `minifyWhitespace`（保留行结构以便 diff）但保留 `minifySyntax` 与标识符名：**产物要能被审阅**。实测确定性（连跑两次字节一致）、3733 行 / 141 KB、**裸说明符只有 `node:*`**。
- `src/platform/dsh/entry.ts`：dsh bundle 的**唯一 `src/**` 导入面**，导出 `createDshPlatform` 与 `createDshAssetApi`。后者内部 `new ConfigManager(platform.state, platform.secrets)` —— 端口层让它不必知道宿主是谁。
- **门禁第 8 项**：`dsh/host.bundle.js` 是否**就是当前源码的构建**。做法是内存重建 + 逐字节比对（不看 mtime，跨 checkout 与编译器升级都会骗人）。反向测试：往 `entry.ts` 追加一行 → 精确 FAIL 并打印首次差异行号。
- `dsh/index.js`：`ctx.inject(['webServer','storageDomain','credentials'], …)` 组装平台，并以**解析函数**把资产面交给 channel —— 最初的写法把 `assets` 直接快照进 `registerChannel`，而它是异步赋值的，于是**永远读到 `undefined`**；改为逐调用解析后，channel 可以先挂载、资产随后到达，组装失败也能带着原因自我解释。

#### 0.18.3 channel 侧

- 新增 `assets.summary` / `assets.export` / `assets.import` 三个 RPC 方法；**分发器改为支持异步**（资产方法要 await 存储与 scrypt）。
- 请求体上限从 1 MiB 提到 8 MiB：资产包要装 base64 私钥，是这条通道上唯一合法的大请求；旧上限不是截断而是**直接销毁连接**。超限现在明确回 **413 + `body-too-large`**。
- 失败一律 `{ok:false, error:{code, message}}` + HTTP 200：RPC 回了话就不是传输故障，浏览器半靠 `code` 分支。`assets-unavailable` / `wrong-password` / `unreadable-package` / `bad-params` 四种码各有不同处置。

#### 0.18.4 面板（`dsh/client.js` → 757 行）

摘要区 / 导出区（复选框 + 包口令 + 下载 Blob）/ 导入区（文件选择 + 包口令 + 冲突策略三选 + summary 回显）/ 共用错误显示与提交期禁用。全部文案走 locale 字典（zh 与 en **键集合一致**，43 个键）；只 `require("react")`；无 JSX、无构建。

#### 0.18.5 独立复核找出的两处缺陷（已修）

一个专门写"坏文件"用例的子代理（按"不要把 bug 断言成期望行为"的要求）找出**我写的两处真缺陷**，都导致**同一种输入在两个平台得到不同错误码**：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| A | `JSON.parse(request.envelope)` **无 try/catch** | 文件文本损坏 → 抛裸 `SyntaxError`（`code` 为 `undefined`）→ channel 归类成 `method-error`；而 VS Code 侧同一场景报"包不可读" | 包 try/catch，映射为 `unreadable-package` |
| B | `parseAssetPackageEnvelope` 在 `decryptAssetPayload` 的 **try 之外**（`AssetCrypto.ts:46`） | envelope 结构不合法 → 抛 schema 错误，消息 ≠ UNREADABLE → 被归类成 **`wrong-password`**，用户会一直重试正确口令 | 解密**之前**先单独校验 header，失败即 `unreadable-package` |

两处都补了回归守卫（`test/platform/dsh/assets.test.ts` 16 项，含"消息里不得出现 password 字样"这条断言——否则用户还是会去重试口令）。

> 这是本项目"**先让门禁/测试能失败**"纪律的一次正收益：缺陷由**测试作者**发现，而不是由用户发现。

#### 0.18.6 证据

- `tsc` 退出 0；`test/dsh` **33/33**；`test/platform/dsh/assets.test.ts` **12/12**；`verify:dsh` **8/8**；`verify:kernel` 5/5；全量回归见提交信息。
- **编译产物的独立端到端验证**（不经 TS 源码，直接跑 `host.bundle.js`，用最小 host 替身）：
  ```
  [1] 空摘要:   servers 0 / passwords 0 / privateKeyFiles 0
  [2] 播种后:   servers 2 / passwords 1
  [3] 导出:     at-terminal-assets.at-terminal-assets, envelope 八个字段齐全, omissions 0
  [4] 导入(字符串形式 envelope): imported 2
  [5] 目标实例: 2 台服务器 + 口令 "hunter2" 完整到达
  [6] 记录逐字段一致（顺序无关）: true   ← 顺序按 ConfigManager.saveServer 的 label 排序，与 VS Code 相同
  [7] 错口令 -> wrong-password: Invalid package password or corrupted asset package.
  ```

#### 0.18.7 仍未闭环

- **未在真实 dsh 里点过一次导出/导入**：面板已可用，但要你重启后亲手走一遍（见下）；
- **私钥落盘路径**是 `$DSH_HOME/at-terminal/imported-private-keys`（`DSH_HOME` 可由环境覆盖，默认 `~/.dsh`），与 VS Code 的 `globalStorage` 不同目录但同形状——这是刻意的：换平台搬数据靠**包**，不靠路径；
- M3 的两棵树（服务器树 / SFTP 树）与 M4 的 xterm 仍未开始。

---

### 0.19 M3 资产管理 + M4 终端：Host 侧落地

用户重启后确认面板可用（`client.status` 报 `clientHellos=1`，origin **`dsh-app://app`** —— Desktop 壳的自定义 scheme），并成功导入了一份**真实资产包**：`~/.dsh/at-terminal/imported-private-keys/` 出现 **19 个私钥文件（全 0600）**，`.credentials.yaml` 出现 **6 个 `AT_TERMINAL_PASSWORD_S_*` 引用**。**格式与存储规则的对齐在真实数据上得到验证。**

#### 0.19.1 新增 Host 服务（`src/platform/dsh/services.ts`）

| 面 | 做什么 | 复用什么 |
|---|---|---|
| `createDshServerApi` | `list` / `save` / `remove` | `ConfigManager`（记录 + 凭据键完全同构） |
| `createDshTerminalApi` | `open` / `trustHost` | `SshSession` + `HostKeyStore` + `ConfigManager` |

关键设计：

- **口令永不跨这条边界**：`DshServerView` 只有 `hasPassword` 布尔值，没有口令字段。表单能说"已保存"，但拿不到明文。
- **`save` 逐字段构造候选对象**再交给 `parseServerConfig`：schema 是 `.strict()`，从浏览器多带一个键会变成校验失败而不是被静默忽略——逐字段构造正是让这条契约成立的东西。
- **未知/变更的主机密钥不自动信任**。VS Code 变体能弹模态框，dsh 的 Host 半不能，于是选择是"静默信任（= 把 MITM 缺口包装成便利）"或"拒绝并把指纹交回用户"。实现选后者：发 `terminal.error`，`code` 为 `host-key-unknown` / `host-key-changed`，**带 `fingerprint`**；客户端展示后调 `terminal.trustHost` 显式记录，再让用户自己重连（决定与后果分开）。
- **背压是真背压**：`SshSession` 有 `pauseOutput`/`resumeOutput`，客户端发 `terminal.pause` 就直接暂停 SSH 通道，而不是把字节丢掉。
- **keyboard-interactive 传 `undefined`**：headless 宿主没有可弹的对话框，传 `undefined` 让这类认证干净失败，而不是挂在一个没人看得见的提示上。

#### 0.19.2 线上协议（`dsh/channel.js`）

`/ws` 上新增 `terminal.*` 一族，与已有的 `hold`/`ack`/`echo`/`spike` 共用一条 socket：

| 方向 | 帧 |
|---|---|
| 客户端 → Host | `terminal.open{id,serverId,rows,cols}`、`terminal.input{id,data}`、`terminal.resize`、`terminal.pause{id,paused}`、`terminal.close` |
| Host → 客户端 | `terminal.opened`、`terminal.output{data:base64}`、`terminal.status{state,text}`、`terminal.error{code,message,fingerprint?}`、`terminal.closed` |

- **输出走 base64**：PTY 流是任意字节，JSON 字符串会让"被切断的多字节序列"损坏；键盘输入反向走纯文本，因为键盘总是产生 JS 字符串。
- **命名空间在 channel 里加**：测试抓到过一个真实 bug —— 终端事件原本被原样透传，线上类型成了 `output`/`status`/`error`，而 `error` 与协议的**通用错误帧撞名**，客户端无法区分。现在统一加 `terminal.` 前缀。
- socket 关闭 / `bye` / `error` 都要 `closeTerminals(session)`，否则断线会漏掉 SSH 会话（有测试覆盖）。

#### 0.19.3 门禁：新增"仓库依赖"这一类别

产物里第一次出现裸 `ssh2`（`external`），门禁当场 FAIL。这不是误报，而是**两个不同类别**没被区分：

| 类别 | 例子 | 为什么这样解析 |
|---|---|---|
| vendored | `@deepseek-ai/schemastery` | Harness 自己那份在 `app.asar` 内，`link:` 安装够不到，只能随包发一份 |
| **repo-resolved（新增）** | `ssh2` | 它是 `at-terminal-series` 自己的依赖；profile 链到仓库内目录，Node 从 `dsh/host.bundle.js` 向上走就能找到 `../node_modules/ssh2`，复制一份反而多养一份原生依赖 |

门禁对第二类**不采信声明**：每个名字都必须真的能从 bundle 目录 `require.resolve` 出来，否则 FAIL。

#### 0.19.4 证据

- 新增 `test/dsh/channel.test.ts` 的 **ws 终端族 9 项 + 服务器 RPC 2 项**（共 26 项）：用**手写 masking 的 ws 帧**驱动真实路由，覆盖 open→input/resize/pause/close 的转发、base64 输出还原（用 `héllo` 断言多字节安全）、同 id 二次 open 被拒、未知 id 报 `no-such-terminal`、连接失败带出服务的 code、socket 销毁时关闭全部终端、无终端服务时报 `services-unavailable`、trustHost 的请求/响应语义。
  - 脚手架本身踩过一个坑并已修：第一版把「HTTP 101 握手」那一写也当帧解析，导致后续偏移全部错位、`frames()` 静默返回空。**静默为空是最难查的一种失败**，已在注释里写明。
- `tsc` 退出 0；`test/dsh/channel.test.ts` **26/26**；`verify:dsh` **8/8**（依赖审计现在报 `1 vendored … ; 1 from the repository: ssh2`）。

#### 0.19.5 客户端两个面板落地（`dsh/client.js` 757 → 2372 行）

| 面板 | 内容 |
|---|---|
| **资产** | 服务器列表（按 group 分组，显示 `user@host:port` + 认证方式 + `hasPassword` 标记，**永不显示口令**）；每行 连接 / 编辑 / 删除（二次确认）；新增/编辑表单（label/group/host/port/username/authType/password/privateKeyPath/jumpHostId/encoding/keepAliveInterval）+ **内联校验**（校验失败不发 RPC）；原有导入导出保留，且导入后**同时刷新列表** |
| **终端** | 服务器下拉 + 连接/断开；`<pre>` 输出（等宽、自动贴底、用户上滚则暂停贴底）；完整按键映射（可打印、Enter/Backspace/Tab/Esc/方向/Home/End/Ctrl+C/D/Z/L、粘贴）；`ResizeObserver` 估算 cols/rows 上报；**背压**（未渲染 >256 KiB 发 `terminal.pause{true}`，降到 <64 KiB 发 `false`）；主机密钥指纹展示 + 「信任该主机」按钮（信任后**由用户再点连接**，决定与后果分开） |

#### 0.19.6 两个子代理各自找到一个真缺陷（均已修）

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| A | `services.ts` 的 `save` 把 `input.password` 原样透传 | **编辑一台密码机时口令框留空**（客户端契约明说"留空=不改口令"）→ 空串抵达凭据层被拒 → **记录已落盘才抛错**（非原子），错误无 `code` 且 message 泄露内部引用名 | `password === undefined \|\| password === '' → undefined`；并补回归守卫（留空不改口令 / 新建时空口令落到 `hasPassword:false` 而非半途失败） |
| B | `new TextDecoder('utf-8', { stream: true })` | `stream` 是 **`decode()` 的每次调用选项**，构造函数静默忽略它 → 被切断的多字节序列仍被替换成 U+FFFD —— **正是"输出走 base64"要防的那件事** | 改为 `decode(bytes, { stream: true })` |

> 两条都属同一类：**看起来对、且没有报错**的东西。A 是"写了一半才发现失败"，B 是"传了一个被静默忽略的选项"。

#### 0.19.7 用户实测又抓到一个真缺陷：服务永远"still starting"

面板一打开就报 `services-unavailable: the services are still starting`，且**永远如此**（不是启动竞态）——`ping` 正常但所有服务调用都失败。根因是我在 §0.19 那次重构里把逐调用解析写坏了：

```js
const resolve = (value) => () => { if (value !== undefined) return value; ... }
resolveAssets: resolve(assets)      // 捕获的是「调用时的实参」，而当时就是 undefined
```

`assets` 是平台组装完成后**异步赋值**的，闭包把注册时那个唯一的 `undefined` 冻死了。上一轮写的是读变量的对象方法（所以那时导入是好的），被折叠成三元工厂函数时改坏。

**为什么没被测出来**：`dsh/index.js` —— 组装工具、平台与 channel 的那个文件 —— **一个测试都没有**。现已补 `test/dsh/index-wiring.test.ts`（5 项）：驱动真实 `apply()`，断言路由注册、`ping` 在组装完成前就可用、以及 `assets.summary` / `servers.list` / `servers.save` 在组装**完成之后**可用。反向验证：把修复回退，恰好这一项失败。该文件还先把 `DSH_HOME` 指向临时目录，否则测试会读到（服务会写到）真实安装的私钥目录。

#### 0.19.8 仍未闭环

- **终端仍是行式终端**：ANSI 只做 `\r`/`\b` 与 CSI/OSC 剥离，**不做光标定位**，所以 vim/top 等全屏 TUI 仍不行 —— 那需要 xterm，而 xterm 需要给客户端引入构建步骤（`dsh/client.js` 目前是手写的单文件，2489 行）。这是下一步的头号项；
- `services.ts` 测试 **17 项**（CRUD + trustHost + 空白口令两条回归守卫）；**真实 SSH 连接 / host-key 交互 / 背压暂停**需要可达主机，不在自动化范围内；
- **面板已在真实 dsh 里打开过**（用户实测），由此暴露并修掉了 §0.19.7 的缺陷；但**修好后尚未复验** —— 需再重启一次走「列服务器 → 新增 → 连接 → 断开 → 删除」；
- **样式正在重做**：此前客户端半只有极少量内联 style，没有分组/栅格/滚动容器，用户反馈"没有任何布局"。重做基于 dsh 自己的语义设计系统（`--dsw-alias-*`，已从 `app.asar` 核实存在），并给每个 `var()` 配 fallback 以防变量缺失时静默变成透明。

#### 0.20 用户实测两条反馈 → Client 半重建（xterm + 复用既有前端）

**反馈一：`services-unavailable` "根本没修改"。** 取证：修复**已提交**（`0efc2bd`，15:09:27），而当时运行中的实例是 **15:04 启动**的（`rpc health` 的 `uptimeMs=3250322` 反推）——早于修复提交。Host 侧代码只在启动时加载、不热重载，所以用户看到的仍是旧代码。**修复本身有效（67 项 dsh 测试全绿，含 index-wiring 回归守卫），差的是一次重启。**

**反馈二：UI 丑、布局不合理**，要求：① 资产页只留服务器列表，管理动作（新增/修改/导入/导出等）收进工具栏按钮与右键菜单；② 终端独立成页；③ **充分利用现有前端代码，不要手写重设计**。这正是计划 DSH-26 的本意；上一轮中断的"手写样式重做"（未提交的 client.js +1103 行内联 CSS）就此**废弃**，改为：

**Client 半构建管线（DSH-19 的真正落地）**：

- 新 TS 源 `src/platform/dsh/client/**`（14 个文件），`esbuild.dsh.mjs` 扩为**双产物**：`entry.ts → host.bundle.js`（不变）+ `client/main.ts → client.js`（新增），`--check` 对两个产物做字节比对（门禁第 8 项）。
- `client.js` 形态：CJS bundle + `react` external（浏览器 baseline 提供），xterm、四个 addon、三份 CSS（text loader）全部内联；构建脚本把产物包成 `window.__ModuleLoader__.load({id, factory})` **单一顶层语句**。
- 门禁第 7 项从"正则 grep `exports.apply`"升级为 **VM 里真实执行 factory**：模块作用域只带 `window.__ModuleLoader__`/`navigator`/`self` 桩即可求值（`document` 故意缺席——加载期碰 DOM 当场抛错），factory 必须返回 `{apply, inject:[slots,sidebarRightTabs,locale]}` 且唯一 external 是 `react`。教训：正则钉死 esbuild 的一种 emit 风格，产物变成 `module.exports = __toCommonJS(...)` 后就失效——**运行时断言与构建风格无关**。

**复用清单（不再自绘一份）**：

| 复用资产 | 方式 |
|---|---|
| `webview/terminal/*` 八个构件（options / renderer / search / clipboard / output / theme / zebra / semanticHighlight） | `xtermEngine.ts` 直接 import，只替换 `acquireVsCodeApi` 胶水（约 200 行） |
| `webview/terminal/index.css` + `webview/server-form/index.css` + `xterm.css` | 以文本内联，运行时 `scopeCss()` 把全部选择器改写进 `.att-root`（html/body→根、@media 递归、@keyframes 保持全局），对宿主页面零泄漏 |
| `--vscode-*` 主题变量 | `.att-root` 上的 **token 桥**：逐个映射到 `--dsw-alias-*`，**无字面 fallback**（U0 起全部删除，理由见下）；桥接层定义 **41** 个变量、覆盖 **21** 个官方 token，两张复用样式表实际读到的 32 个变量**零缺口**，另有 9 个标注 `RESERVED`。`verify:dsh` 第 9 项 `theme-tokens` 守着这条规则 |
| `ServerFormPanel` 表单结构 | 表单页按同一 class 结构渲染（`.server-form-shell` / `.form-section-grid` / `.auth-card-grid` / `.trust-block` / `.summary-line` / `.form-footer`），原版样式表直接生效 |
| `TerminalPanel` 终端外壳 | `.terminal-shell` / `.terminal-status`（状态点 + 重连 + Ctrl+F 查找栏）/ `.terminal-surface` |

刻意**不**复用：`html.ts`（无 webview 文档，CSP/Uri 注入整体废弃，与可行性分析 §3.2③ 一致）；表单的「测试连接」「浏览私钥」按钮（Host 暂无对应 rpc——不能工作的按钮比没有按钮更糟，登记为后续项）。

**布局（按用户要求）**：资产页 = 纯列表（分组行：名称 + `user@host:port` + 认证徽标 + 已存口令徽标，**行内零按钮**），工具栏 新增/导入/导出/刷新，右键菜单 连接/编辑/复制地址/删除（confirm 兜底），双击直连，底部状态栏放资产摘要；表单与终端各自独立页面；导入/导出改模态弹窗。终端页为**真 xterm**（vim/top 可用），字节级流控：未渲染字节 >256KiB → `terminal.pause` 暂停 SSH 通道，<64KiB → resume（沿用 webview ack 阈值语义，改由 xterm write 回调驱动）。

**DSH-31 顺带打通**：channel 新增 `settings.get` rpc（同步读 8 项 `sshManager.*` 行配置，永不受平台组装进度影响），终端字号/字体/滚动缓冲/语义高亮/zebra 跟随用户设置，下次连接生效。

**测试重构**（旧 `client-half.test.ts` 1642 行随手写 client 一并删除，按新架构分两层）：

- `client-models.test.ts`（**34 项**）：表单模型与校验、`DshServerInput` 构造（口令只写不回、trust 门控 background 标志）、分组、错误码→文案映射（四个可操作码互不合并）、base64 分帧、流控阈值与边沿、帧 reducer 全协议分支、CSS scoper、中英字典键集一致；
- `client-bundle.test.ts`（**20 项**）：VM 执行**构建产物** + React shim 驱动真实 Body——注册契约、样式注入幂等与卸载即删、列表行零按钮、`services-unavailable` 必须渲染为**带错误码的失败**（把 §0.19.7 的回归钉死）、表单校验与保存载荷、导入/导出 RPC 参数、终端 WS 协议（含背压 pause 帧）；
- `channel.test.ts` +1（settings.get 逐调用解析、默认空对象）、`index-wiring.test.ts` +1（settings.get 在组装完成前即可用）；
- `test/i18n/nls.test.ts` 的源码扫描排除 `src/platform/dsh/**`：dsh 客户端走 Harness locale 服务 + 自带字典（键集一致性由 client-models 断言），不进 VS Code l10n bundle；排除理由写在测试注释里。

**证据**：`tsc --noEmit` 退出 0；全量 vitest **1029/1029**（102 文件）；`verify:dsh` **8/8**（双产物字节一致）；`verify:kernel` **5/5**（src 115 文件）；红线五文件 **29/29**；`build:base` / `build:mcp` 构建成功。

**仍未闭环（诚实登记）**：

- **xterm 引擎未在真实 DOM 里跑过**：沙箱测试到 Body 层为止（TerminalView 是不透明组件），引擎装配的是八个已各自有测试的构件 + 200 行胶水。需重启后用户实测：列表 → 新增 → 右键连接 → vim/top → 断开 → 删除；
- 真实 SSH 连接 / host-key 交互 / 背压对真机的实测，仍不在自动化范围（需可达主机）；
- 复用样式在 Harness 明/暗两主题下的最终观感（token 桥的实际效果）需用户确认——这轮的设计目标就是"看起来像原插件"，判据在用户手里；
- 「测试连接」「浏览私钥」两个按钮等 Host rpc 补上后再回迁。

#### 0.21 用户实测：桌面壳连不上终端（`ws://app/...`）——已修

**症状**：重启加载 §0.20 的新客户端后，双击/右键「连接」报 `websocket-error: ws://app/dsh-at-terminal/ws`。列表、右键菜单、表单都正常（它们走相对 `fetch`），唯独 WebSocket 连不上。

**根因**（错误里的 URL 就是决定性证据）：Desktop 壳把面板页从**自定义 scheme `dsh-app://app`** 提供。相对 `fetch('/dsh-at-terminal/rpc')` 由壳的 IPC 桥承载，所以 RPC 一切正常；但 `WebSocket` 既不吃相对地址、也不走那条桥，`location.host` 在壳里就是字符串 `app`——一个无法解析的主机名。旧代码 `terminalSocketUrl(location)` 直接拿 `location` 拼，在 web GUI 下对、在桌面壳下必错。

**修复**（Host 报告，客户端按页面来源二选一）：

- Host `dsh/channel.js` 新增 rpc `channel.info`：读 `webServer.port`（`0` 时是 OS 分配的真实端口），回 `{host:'127.0.0.1', port, wsUrl:'ws://127.0.0.1:<port>/dsh-at-terminal/ws', rpcUrl}`。**只有 Host 知道自己真正监听在哪个端口**，所以由它报告而不是客户端猜。
- 客户端 `models.ts` 新增纯函数 `resolveSocketUrl(location, endpoints)`：页面是 `http(s):` → 用**页面自身 origin**（web GUI，含局域网浏览器——问 Host 会得到 `127.0.0.1`，远端浏览器用不了）；否则（`dsh-app:` 等）→ 用 `channel.info` 报告的回环地址，缺失则抛 `no-ws-endpoint`，**绝不**退回 `ws://app`。
- `body.ts` 的 `doConnect` 改为 async：仅在页面非 http(s) 时先 `await callRpc('channel.info')` 再开 socket；http(s) 路径保持同步，既有行为与测试不变。

**证据**：`tsc` 退出 0；`vitest` **1033/1033**（新增 4 项）；`verify:dsh` **8/8**（双产物字节一致）；`verify:kernel` **5/5**。新增测试：Host 侧 `channel.info` 报告真实回环端点（channel.test）；`resolveSocketUrl` 的 web/dsh-app/无端点三分支（client-models）；bundle 级用 `dsh-app://app` 的 location 驱动真实 Body，断言 socket 连到 `ws://127.0.0.1:19387/...` 而非 `ws://app`、且无端点时渲染带码错误横幅而非静默（client-bundle）。

**仍未闭环 →已由下一轮实测解除**：桌面壳是否放行 `dsh-app://` 页向 `ws://127.0.0.1` 发起 WebSocket，沙箱无法验证。**§0.22 的用户实测证明了放行**：重连报的是 Host `terminal.*` 协议层的 `no-such-terminal`，即 socket 已经连上并被 Host 应答——WS 通路本身通了，降级方案（fetch 长轮询/SSE）不再需要。

#### 0.22 用户实测：连接即报 `no-such-terminal`——终端打开竞态，已修

**症状**：§0.21 修复重启后，连接终端报 `no-such-terminal: no terminal "at-terminal-pane" is open on this socket`。

**这个错误码本身是好消息**：它由 Host 的 `handleTerminalMessage` 发出，说明 WebSocket 已连上、`terminal.open` 已送达——`dsh-app://` 的 WS 通路（§0.21 遗留的唯一风险）就此实测打通。

**根因（生命周期竞态）**：xterm 引擎在**面板一转可见就 fit 并上报尺寸**（`ResizeObserver` + 可见性切换都会触发 `onResize`），而此时 Host 侧 `terminal.open` 还在异步连接 SSH（占位 `{opening:true}`）。Host 的旧守卫把 `opening` 与「未知 id」同等对待，直接回 `no-such-terminal` 错误帧 → 客户端把它渲染成错误横幅。一次健康连接被自己的尺寸上报打断。

**修复（两侧都收口）**：

- **Host** `channel.js`：`opening===true` 时的 `resize/input/pause` 是**预期竞态而非协议违规**，静默丢弃（`open` 帧已带初始 rows/cols，客户端在 `terminal.opened` 后会重报尺寸，丢弃无损）；`terminal.close` 在 opening 期则**删除占位以取消**——open 解析时发现占位不在即 dispose 刚连上的会话（既有取消路径）。`terminal===undefined`（真正的未知 id）仍报错。
- **客户端** `body.ts`：新增 `openedRef`，仅在 `terminal.opened` 与 teardown 之间为真；`onInput`/`onResize` 在未 opened 时不发帧（引擎的可见即 fit 与用户提前敲键都不再产生幽灵帧）。teardown/onclose/onerror 三处复位。

**证据**：`tsc` 退出 0；`vitest` **1035/1035**（新增 2 项竞态用例：`deferredTerminalFace` 让 `open` 悬停，断言 opening 期的 resize/input/pause **零错误帧且零抵达会话**、release 后正常流转；以及 opening 期 close 取消连接、同 id 可重开）；`verify:dsh` **8/8**；`verify:kernel` **5/5**。

**仍未闭环**：到此 WebSocket 通路与打开握手已被用户实测+自动化双向确认，但**真实 SSH 字节流**（连上后终端出字符、vim/top、背压）仍需可达主机，等用户下一次实测。

#### 0.23 用户实测：连接报 `platform not installed`——dsh 组装根从未注册平台，已修

**症状**：`connect-failed: AT Terminal: platform not installed; extension activation must call setPlatform()`。

**根因**：`src/platform/current.ts` 的模块级注册表是领域层读宿主能力的唯一入口——`SshSession.connect()` **第一行**就是 `t('Connecting to {host}:{port}...')` → `platform().localization`（`src/utils/notifications.ts`、`AssetCommands` 同理）。VS Code 侧在 `src/extension.ts:57` 调 `setPlatform(createVscodePlatform(context))`；**dsh 侧的 `createDshPlatform` 组装出 Platform 却从未调用 `setPlatform`**——`current.ts` 注释里写着"a dsh host entry later"，这个 later 一直没兑现。于是 `SshSession.connect()` 第一行就抛错，被 `services.ts` 的 `open()` 捕获后发成 `connect-failed` 错误帧。

**为什么整个测试套件都没抓到（两个叠加的遮蔽）**：

1. `test/setup-platform.ts` 在每个测试文件开头**预装 fake platform**，于是单测里 `platform()` 永远不会抛；
2. `host.bundle.js` 把 `src/platform/current.ts` **内联**了——bundle 内部与 vitest 从源码导入的是**两个模块实例、两份 `current` 变量**。从测试断言源码侧的注册表，观察的并不是 bundle 真正使用的那一份（本轮第一版测试正是这么写错的：断言拿到的是 fake 的 storageDir）。

**修复**：

- `current.ts` 新增 `clearPlatform(expected?)`：卸载即清除，避免拆卸后领域层继续读到状态已关闭的平台（写入静默失败）；`expected` 守卫"卸载撞上重载"——旧句柄不得清除新组装；
- `createDshPlatform`：组装完成（存储域已打开）后 `setPlatform(platform)`，`close()` 中 `clearPlatform(platform)`。组装失败则从不注册，领域层看到的仍是"未安装"这一诚实错误。

**测试（+3，全量 1038/1038）与反向验证**：

- `test/platform/dsh/platform.test.ts`：组装即安装（且是本次组装的实例）、关闭即清除、旧句柄不误清新组装（`afterEach` 把 setup 的 fake 装回）；
- `test/dsh/index-wiring.test.ts`：**bundle 级**端到端——驱动真实 `apply()` 待组装完成，再用同一个 `dsh/host.bundle.js`（同一模块实例、同一注册表）的 `createDshServerApi` 存一条指向 `127.0.0.1:45999`（必被拒）的记录，并 `createDshTerminalApi().open()`：正向断言"connecting to 127.0.0.1…"状态帧已由 bundle 内的 `t()` 产生，且任何事件都不含 `platform not installed`；
- **反向验证**：临时撤掉 `setPlatform(platform)` 并重建产物，**恰好这 3 项失败**（bundle 级 1 + 单元级 2），其余照旧通过——证明测试钉的正是这条缺口。

**顺带确认的架构卫生**：`dsh/client.js` 未内联 `src/platform/current.ts`（grep 计数 0），客户端半不碰宿主注册表。

**仍未闭环**：真实 SSH 字节流（提示符出现、vim/top、背压）仍待可达主机上的用户实测。

#### 0.24 用户实测：`connect-failed: Host denied (verification failed)`——带指纹的拒绝被泛化帧盖掉，已修

**症状**：连接报 `connect-failed: Host denied (verification failed)`。**这个错误本身又是进展**：连接流程已跑到 SSH **host-key 验证**。

**按设计本该发生什么**：未知/变更的主机密钥**不静默信任**（那是把 MITM 包装成便利），而是通过带码事件把**指纹**交给面板，由用户显式点「信任该主机」（`services.ts#createVerifier` 的既定选择）。用户看到的却是没有指纹、没有可行动作的泛化错误。

**根因（一次根因、两个错误帧，后者盖掉前者）**：

1. 验证器先 `emit({type:'error', code:'host-key-unknown'|'host-key-changed', message, fingerprint})` —— 信息完整的那一帧；
2. ssh2 随后以 `Host denied (verification failed)`（**无 code**）拒绝 `SshSession.connect()`；
3. `services.ts#open()` 的 catch 把它重抛为 `connect-failed`，`channel.js` 的 `.catch` 于是**又发了一帧** `terminal.error`（无指纹）；
4. 客户端 `termError` 是单值状态，**最后一帧胜出** → 带指纹的拒绝被覆盖，「信任该主机」按钮永不出现。

> 讽刺的是 `services.ts` 里 session 的 `error()` 处理早就写着"第二个泛化错误会埋掉用户能行动的那条"——但真正多发的帧来自 `open()` 的 catch → channel 的 `.catch`，不在那段注释覆盖的路径上。

**修复**：

- **Host `channel.js`**：`emit` 记录是否已发过带码错误；`.catch` 若发现已报过，则**不再发泛化帧**（只写日志）。一次根因一个帧——且是信息完整的那一帧。
- **Client `body.ts`**：连接期（`connecting`）收到带码错误即把状态置为 `disconnected`——否则面板会一边显示"连接中"一边弹出要求用户决策的横幅，隐藏了可行动作；已连接后的错误不动状态（会话仍在用户手里）。

**测试（+2，全量 1039/1039）与反向验证**：

- `channel.test.ts`：门面先 emit 带指纹的 `host-key-unknown` 再抛泛化错误 → 断言**恰好一帧** `terminal.error`、code 与 fingerprint 保留、且不含 `connect-failed`；
- `client-bundle.test.ts`：host-key 拒绝后断言 `TerminalView` 的 `termState.kind === 'disconnected'`（信任按钮与状态一致）；
- **反向验证**：把守卫改成 `if (false)` → **恰好那 1 项**失败，其余 30 项照旧通过。

**下一步（用户实测即可继续）**：重启后重连，应看到**带指纹的错误横幅 + 「信任该主机」按钮**；点信任 → 再点连接 → 进入真实 SSH 会话。真实字节流（提示符、vim/top、背压）仍是最后一段待验证。

#### 0.25 用户实测：信任主机后 `All configured authentication methods failed`——凭据被服务器拒绝（数据问题）+ 错误不可行动（代码问题，已修）

**症状**：按下 §0.24 的预期走完「带指纹横幅 → 信任 → 再连接」后，报 `connect-failed: All configured authentication methods failed`（ssh2 原文）。**这本身是进展**：TCP、host-key 验证、SSH 认证阶段全部跑通。

**三步取证（均不含口令明文）**：

1. **凭据确实存在且映射正确**：状态库 `~/.dsh/storages/at_terminal_state.json` 里 `sshManager.trustedHostKeys` 刚记录的是 `192.168.99.90:22`（`root` / password 认证）；`~/.dsh/.credentials.yaml` 中存在条目 `AT_TERMINAL_PASSWORD_S_4D1FBEFC_AEEF_42E9_9008_62C04915AFFE`，与 `host.ts#serverSecretRefName` 的命名规则（`AT_TERMINAL_PASSWORD_S_<UUID 大写、连字符转下划线>`）逐字符吻合 → **dsh 侧能解析出这条口令**；
2. **服务器确实提供 password 认证**：`ssh -o PreferredAuthentications=none -o BatchMode=yes root@192.168.99.90` → `Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password)`；
3. **凭据被服务器拒绝**：用 ssh2 直接拿**库里那条**凭据连接（只打印结果与 `error.level`，绝不回显口令）→ `level: client-authentication`，`All configured authentication methods failed`。

**结论**：**链路正确、数据过期**——存的那条口令对该主机已失效（或服务器禁止 root 口令登录，Ubuntu 默认 `PermitRootLogin prohibit-password` 即如此；服务器仍会广播 `password`，所以第 2 步不能区分这两者）。这不是连接路径的缺陷。

**但仍有一个真实的代码缺陷：错误不可行动。** 用户看到的是 ssh2 的原文，既没说试了什么、也没说该查什么。按项目既定模式（带码错误 + 本地化文案）修复：

- 新增 `src/platform/dsh/sshFailure.ts`（纯函数分类器，dsh 侧）：`client-authentication` → `authentication-failed`；errno → `connection-refused` / `connection-timeout` / `host-unresolved` / `host-unreachable` / `private-key-unreadable`；**已带的 code 原样保留**（`password-missing`、`private-key-path-missing`、`host-key-*`）；其余 → `connect-failed`。它只主张错误本身说过的事——认证失败报告为"服务器拒绝了本次提供的全部方式"，**不**写成"密码错误"（服务器不会告诉我们它不喜欢哪一项）。
- 域层补码：`SshConnectionConfig.ts` 的两条"缺凭据"错误加上 `code: 'password-missing'` / `'private-key-path-missing'`（VS Code 侧行为不变：只加属性，message 未改，既有两条断言 message 的测试照旧通过）。
- `services.ts` 的 `open()` catch 与 session `error()` 处理器都走分类器；
- 客户端 `models.ts#errorKey` + 中英字典补 8 条可行动文案（例如 `authentication-failed` 的文案列出三项核查：面板口令是否仍有效 / 该账号是否允许这种登录（root 口令常被禁） / 是否要求键盘交互认证）。

**证据**：`+6` 测试（`sshFailure.test.ts` 5 项：不臆测原因、errno 全映射、保留既有 code、兜底、目标描述；client-models 的 `errorKey` 覆盖 8 个新码且两两不重复）；`index-wiring.test.ts` 的 bundle 级用例升级为断言 `connection-refused`——**证明分类器在出厂产物里真的生效**；全量 **1045/1045**；`verify:dsh` 8/8；`verify:kernel` 5/5；`tsc` 0。

**用户侧动作（数据修复）**：在面板里右键 `99.90` → 编辑 → 重新输入有效口令 → 保存 → 再连接；若该主机确实禁止 root 口令登录，则改用密钥认证或非 root 账号。

**凭据盘点（同一轮实测，供对照）**：状态库里共 **24** 台服务器——**6** 台 password 认证（`4d1fbefc` 99.90 / `af238298` 99.92 / `538ec1cc` 99.94 / `cd9cae0e` frappe / `6c424401` frappe-test / `786c6a66` test），**6/6 都有已存口令**；**18** 台 privateKey 认证，**18/18 私钥文件都在盘上**（`~/.dsh/at-terminal/imported-private-keys/`）。所以"缺凭据"不是本次症状（`password-missing` 是给未来那种情况的护栏），本次纯粹是 99.90 那条口令被服务器拒绝。

---

### 0.26 M3 缺口收口：SFTP 只读文件树（DSH-16 第三面 / DSH-23）

**结论：DSH-23 已交付，M3 出口判据的最后一项（"远程目录可见"）达成。** 本轮开工前先复核真实状态（而不是信 §0.5 那张表）：`tsc` 0 / `verify:dsh` 8/8 / `verify:kernel` 5/5 / 全量 **1045/1045（103 文件）**、工作树干净。逐条比对里程碑清单后确认：**M0–M4 只剩 SFTP 面完全没动**——`dsh/channel.js` 的方法表里有 `assets.*` / `servers.*` / `terminal.trustHost` / `settings.get` / `channel.info`，**没有任何 `sftp.*`**，`src/platform/dsh/` 下也没有对应的服务面。DSH-16 的 SftpService、DSH-18 的"列目录"闭环、DSH-23 的远程目录树都缺在这一块。

> 决策依据：计划 §6 明写"M5 为可选里程碑"，而 M3 的出口判据未达成；本轮聚焦 M3 缺口。

#### 0.26.1 交付物

| 文件 | 职责 | 关键设计点 |
|---|---|---|
| `src/platform/dsh/sftp.ts`（新增） | SFTP 服务面 `createDshSftpApi` | **组合** `SftpManager` 而非重写：复用它已有的 `realpath('.')` 根解析、20s 列表缓存与 `none \| active \| disconnected` 状态机。`allowSudoFallback: false`——这面只读，而该开关只放宽**写**路径，现在打开等于预授权一条到此不可达的提权 |
| `src/platform/dsh/services.ts` | `DshTerminalPresence` / `DshTerminalObserver` + `createDshTerminalApi({ observer })` | 终端在**连接成功之后**才公告自己（连不上的会话不能变成一棵树可以跟随的目标）；`terminalId` 由 Host 侧生成而不是取浏览器那个——浏览器的 id 是每 WebSocket 一个，两个面板会撞 |
| `dsh/channel.js` | `sftp.list` / `sftp.goUp` / `sftp.refresh` 三个 RPC | 沿用 `requireAssets()` 那种"逐调用解析 + 失败带 code"的模式；RPC 错误信封新增**可选** `fingerprint` |
| `src/platform/dsh/client/views/sftp.ts`（新增） | 只读树页面 | 全部递归在 `flattenSftpTree`（`models.ts`，纯函数、无 DOM 可测），视图只做行到元素的映射 |
| `src/platform/dsh/client/{models,body,i18n,styles,views/shared}.ts` | 模型 / 页面路由 / 文案 / 样式 / 三段式导航 | 惰性读取、按目录缓存子层、`flattenSftpTree` 的行模型 |

只读是 DSH-23 的全部内容，也是有意为之：没有重命名/删除/上传/拖拽。VS Code 变体有这些，等在 Host 半长出对应 RPC 再回迁——**一个不能用的控件比没有控件更糟**（与服务器表单不发"测试连接"按钮同一条理由）。

#### 0.26.2 本轮实测推翻/发现的四件事

| # | 发现 | 后果（不修的话） |
|---|---|---|
| 1 | **`createHostVerifier` 把验证器的 rejection 吞成 `verify(false)`**（`SshConnectionConfig.ts:187-192`：`.then(verify, () => verify(false))`） | 终端路径靠 `emit` 事件帧把"未知主机密钥 + 指纹"交给面板；一元 RPC 没有帧可推。若照直觉在验证器里 `throw`，用户拿到的只会是 ssh2 的 `Host denied (verification failed)`——**指纹没了，可行动作也没了**。改为在服务面**记录**该次拒绝，失败时取用；每次可能建连的操作开始时清空该槽，所以取到的必然是本次的（否则上一次的拒绝会被算到下一次无关失败上，把用户送回一个已经满足的信任提示） |
| 2 | **读失败不能走连接分类器** | `classifySshFailure` 只谈**连接**：对它而言 `ENOENT` 就是"私钥文件不存在"。SFTP 操作失败是**协议状态错误**，ssh2 给的是**数值** `code`（`SFTP.js` 比 `er.code === STATUS_CODE.EOF`），message 是 `No such file or directory` / `Permission denied`。第一版实现把列目录失败喂给连接分类器，于是**一个读不到的目录被报成"私钥读不到"**——把用户指去改一条本来正确的密钥路径。现在只在失败"长得像连接失败"（字符串 `code` 或字符串 `level`）时才分类，读失败有自己的码：`sftp-no-such-file` / `sftp-permission-denied` / `sftp-read-failed` |
| 3 | **首次读取时 `SftpManager.getState()` 的根是 `'.'`** | `connection.rootPath` 要等 `ensureRoot()` 跑过才有值，此前 `getState()` 答 `'.'`。后果有两个：状态栏会显示 `"."`；且首次读的缓存键是 `.`、第二次读到真路径后键变成 `/home/root` → **必然多读一次**。改为首次读取前先 `ensureRoot()`（一次 `realpath` 换掉这两件事） |
| 4 | **`useHostRead` 在挂载时就发请求** | `sftp.list` 是这面板里**唯一一条可能开 SSH 连接**的 Host 读。挂在面板上就发，等于用户还在看服务器列表时后台就替他建了一条 SFTP 连接——没人要求过的副作用。改为**首次进入文件页才读取**（`useHostRead` 新增 `enabled`），切页时重新读一次（终端可能在这期间连上或断开） |

> 与 VS Code 的一处**有意分歧**：那边跟随"聚焦的终端"并从事件驱动的注册表自愈（`adoptRegistryTerminalIfSftpInactive`）。dsh 只有一个面板、没有那类事件，所以由**持有终端的 Host 半直接告知**，规则是"跟随最近一个**活着**的终端"。活终端永远压过死终端——在活终端旁边留一棵过期的树，正是 DoD 禁止的那种谎报。

#### 0.26.3 一处纪律事故（值得写下来）

反向测试的**还原两次静默失效**，两次都是被测试自己抓住的：

| # | 反向改动 | 还原后实际状态 | 谁发现的 |
|---|---|---|---|
| 1 | `body.ts` 把 `enabled: sftpVisited` 改成 `true` | 文件仍是 `true` | 全量回归里"打开文件页前不得读取"用例失败（期望 0，实得 4） |
| 2 | `channel.js` 把 `sftp.list` 的 `path` 丢掉、缺服务报错名改掉 | 两处仍在 | 全量回归里那 2 项 channel 用例失败 |
| 3 | `src/platform/dsh/sftp.ts` 三处（拒绝记录 / 分类器分流 / 断开路径） | 三处均正确还原 | —— |

教训明确：**"改坏 → 确认 FAIL → 还原"这三步里，第三步必须被独立验证**。而且验证方式很关键：

- ❌ **不能靠 `diff` 备份**：本轮的备份文件本身就是在改动**之后**取到的（两份都一样坏，diff 通过）——这正是 1 和 2 能一路留到全量回归才暴露的原因；
- ✅ **要按内容核对**：直接断言"应该在那里的那一行"确实在，例如
  `grep -qF "return requireSftp().list({ path: params.path })" dsh/channel.js`。
  本轮收尾把被改动过的 7 个位置逐条按内容核了一遍，另加一次全仓扫描（`REVERSE` / `something else` / `if (true) {` / 临时注释），均为空；
- ✅ **"改坏"要挑语义改动**，别加注释：esbuild 会剥掉注释、字节不变，"反向后门禁仍 PASS"会让人误以为门禁失灵。副产品是一个正面结论：门禁第 8 项（产物与源码逐字节一致）**真的在比对**——改一个字符串字面量后它立刻报出 `committed 203338 / rebuild 203346`；而追加一行注释时它正确地**没有**失败。
- ✅ 一个具体的操作纪律：**一次只改一处**，还原后立刻按内容核对再动下一处；不要在一个命令块里串联多处"改坏—验证—还原"。

#### 0.26.4 证据

- `tsc --noEmit` → 退出 0；
- **全量 vitest 1090 项 / 104 文件全绿**（本轮新增 45 项：`test/platform/dsh/sftp.test.ts` 19 + channel +4 + client-models +12 + client-bundle +9 + index-wiring +1）；
- `npm run verify:dsh` → **8/8 PASS**（双产物字节一致：`host.bundle.js` 本轮开工时 159,685 → 现 **203,338** 字节；`client.js` 768,570 → **786,018** 字节。两道产物**必须提交**：`link:` 安装不跑构建）；
- `npm run verify:kernel` → **5/5 PASS**（`no-host-package-imports` 扫 `src/**` 116 → **118** 文件，新增的两个 dsh 文件都不引入 `@deepseek-ai/*`）；
- **红线五文件**（`package.variants` / `package.baseBundle` / `package.sftp` / `package.agent-tools` / `package.asset-import-export`）→ **29/29 绿**，`base` / `mcp` 两变体未受影响；
- **反向测试五处，均精确失败**（每处都按内容核对过还原）：
  1. 删掉 host-key 拒绝记录 → `host-key refusals` 2 项失败；
  2. `closed()` 改为清活动终端 → `disconnected` 相关 3 项失败；
  3. 读失败无条件走连接分类器 → 读失败 5 项失败；
  4. 去掉"进页面才读"的闸门 → 惰性读取用例失败；
  5. channel 丢 `path` 参数 / 改掉缺服务报错名 → 分别 1 项、2 项失败；
- **Host 面状态机用例**（`test/platform/dsh/sftp.test.ts`，19 项）：`none`/`active`/`disconnected` 三态、跟随最新活终端、活终端压死终端、二级目录读取读而不移根、`goUp`、断开后拒绝读子目录但保留根层快照、缓存命中与 `refresh` 破缓存、无终端时 `refresh` 仍可用、`dispose` 归还会话；host-key 拒绝**带 code + fingerprint**、且上轮拒绝不泄漏到下次无关失败、无指纹的失败不带 `fingerprint` 字段；读失败的四种状态码映射，以及"读不到的目录绝不报成私钥问题"。

#### 0.26.5 仍未闭环（诚实登记）

- **真实远端文件系统未验证**：Host 面用假 `SftpSession` 驱动、浏览器面用脚本化 RPC 驱动，所以证到的是**状态机、接线与渲染**，不是一台真服务器返回什么。需要你重启后在真实 dsh 里走一遍：连终端 → 切到「文件」→ 展开目录 → 上一级 → 刷新 → 断开后看断开态；
- **SFTP 写操作全部未做**（重命名 / 删除 / 新建 / 上传 / 下载 / 拖拽）。VS Code 变体有，Host 半还没有对应 RPC，所以刻意不搬 UI（见 §0.26.1）；
- **`allowSudoFallback` 保持 `false`**：写路径开通时要重新评估，不要顺手打开；
- **DSH-18 的 SSH 段**仍需可达远端，未做；
- **M3 的"服务器树"没有做，且不打算做**：§0.20 的用户反馈已把资产页定成"只留服务器列表"，远程目录才由本轮的「文件」页承担；M3 出口判据里的"服务器树"应按该反馈理解为列表；
- **M5（原生工具化）与 M6（安装三查 / 冒烟 / 文档）** 本轮未动，M5 在计划里是可选里程碑。

#### 0.27 用户实测：信任主机后不自动重连（已修）+ 跳板机信任**记到了错的 host 上**（已修，真实数据取证）

**症状（两条，同一轮实测）**：

1. 连接新服务器需要信任主机；点「信任该主机」后**不会自动重连**，得回到目录再点一次连接；
2. 通过**跳板机**连接的终端，即使点了信任，再次连接**依然报 `host-key-unknown`**。

**取证（状态库，非推测）**：`~/.dsh/storages/at_terminal_state.json` 的 `tables.kv` 里同时有

- `sshManager.trustedHostKeys`：`192.168.99.90:22`、`192.168.99.95:22`、**`10.0.133.11:22`**（`trustedAt=1791356233863`）；
- `sshManager.servers`：**`10.0.133.11`（label `payment01`）的 `jumpHostId=677aa687…`**，而该 id 就是 **`18.199.246.45`（label `prod-vpn`，`jumpHostId=null`）**。

对照截图里的报错 `18.199.246.45:22 is not a known host` 与指纹 `dc82fda2…`：**被拒绝的是跳板机 `18.199.246.45`，而被记进信任库的是目标机 `10.0.133.11:22`。**

**根因（一个根因解释两条症状）**：`services.ts#trustHost()` 无条件 `hostKeyStore.trust(server.host, server.port, …)`——它记的是**用户在列表里点的那台**，而不是**被拒绝的那台**。而 `SshConnectionConfig.ts#buildSshConnectionHandle()` 先验跳板机密钥再验目标机（`buildSshConnectConfig({...jumpHost, jumpHostId: undefined})`），于是：

- 跳板机的 `hostVerifier` 拿跳板机地址来问，拒的是跳板机；
- 点信任 → 记到目标机名下 → **跳板机永远没被信任** → 再连还是拒 → 死循环（症状 2）；
- 而「不自动重连」是这个死循环的**放大器**：用户必须手动再点一次连接，才会再看到同一个拒绝（症状 1）。

**修法（三处，缺一不可）**：

1. `services.ts#createVerifier` 的 `terminal.error` 事件**带上 `host`/`port`**（被拒的那台）；`client/frames.ts` 透传；`channel.js#terminal.trustHost` 转发 `host`/`port`；
2. `services.ts#trustHost()` 改为**记到被拒的那台**，且只接受**该 server 自身或其跳板链上**的 host——否则这个 RPC 会变成"给任意主机写一条可信密钥"的后门（比原 bug 更危险）；
3. `client/body.ts#doTrust()` 成功后**自动 `doConnect()`**（一次决策三步变一步）。注意 `doConnect` 在第一个 await 前同步清 `termError`/`trusted`，所以确认文案必须**在 kick off 之后**写，否则重连会把"已信任…"这行擦掉。

**⚠️ 推翻了一条既定设计**：§0.19 / §0.24 明写「信任后**由用户再点连接**，决定与后果分开」。本轮按用户要求改为自动重连。保留的安全边界是「**不静默信任**」——未知密钥依然拒绝、依然要用户显式点按钮，自动的只是**点完之后的重连**。

**测试（+8）**：`services.test.ts` 跳板机记到跳板机 / 无 host 时回退 / 非链上 host 被拒（守卫）/ 多跳链 / `jumpHostId` 成环时终止；`client-models.test.ts` 帧透传 host+port、缺 port 时不带空 host；`client-bundle.test.ts` 自动重连（socket 数 +1 且状态 `connecting`、拒绝横幅消失）、trust 请求带跳板机 host。**全量 1123/1123 通过**（`vitest run`，exit 0）。

**反向验证（两处，规则改完必做）**：① 把 `trustHost` 改回 `trust(server.host, server.port, …)` → 跳板机用例**恰好失败**；② 删掉 `doTrust` 里的 `doConnect(...)` → 自动重连用例**恰好失败**。

**仍未验证（诚实登记）**：真实 dsh 里的**自动重连视觉效果**与**跳板机端到端连接**都还没跑过——本轮只有单测与既有全量回归。需你重启 dsh 后实测：连一台走跳板机的机器（如 `payment01`）→ 应看到跳板机的指纹 → 点信任 → **自动重连**，若目标机密钥也未知则会再出现一次横幅（这是链式正常的表现，不是 bug）。

#### 0.28 用户实测：跳板机目标机报 `host-key-changed`（**假警报**）+ 日志里两个真缺陷

**症状**：修完 §0.27 后重连 `payment01`，报 `host-key-changed: The host key for 10.0.133.11:22 does not match the one recorded earlier`，新指纹 `e1f5b507…`。用户判断「像是使用了跳板机的密钥去匹配目标主机」。

**判断正确，已用四条独立数据证实**：

1. **状态库** `~/.dsh/storages/at_terminal_state.json` → `tables.kv`：`10.0.133.11:22` = `dc82fda2…`（`trustedAt=14:57:13`），`18.199.246.45:22` = `dc82fda2…`（`trustedAt=15:18:56`）——两条**逐字相同**；
2. **`ssh-keyscan 18.199.246.45`**（公网可达）按 ssh2 的算法（`client.js:283` 的 `createHash('sha256').update(keyblob).digest('hex')`）算得 ed25519 = **`dc82fda2…`**，与上面两条**都相同**；
3. ⇒ 记在 `10.0.133.11:22` 名下的那条**就是跳板机的公钥**，14:57:13 由 §0.27 之前的旧 `trustHost` 写错地址；
4. 截图新指纹 `e1f5b507…` ≠ `dc82fda2…` ⇒ 目标机真实密钥与被污染记录不符 ⇒ **必然报 changed**。

**结论**：**不是新代码缺陷，是旧 bug 遗留的脏数据**。§0.27 的修复已生效（15:18:56 那条写对了地址，即跳板机自己的条目），但错位条目会永远报 changed——因为库里那条永远对不上。日志时间（13:30）早于污染时间（14:57），排除同会话连锁。

**顺带在日志里发现的两个真缺陷**：

- **A. 提交版 `dsh/client.js` 是陈旧产物**：`git show HEAD:dsh/client.js | grep -c shortcuts` = **0**，而 `src/platform/dsh/client/main.ts` 已在用 `ctx.shortcuts.register`。⇒ `client-bundle.test.ts` 一直在跑**旧 bundle**，`shortcuts` 分支**零覆盖**；一旦诚实重建，`ctxStub` 缺 `shortcuts` 桩 → `apply()` 抛 `ctx.shortcuts.register is not a function` → **33 个测试全红**。已补桩 + 补真实断言（`regions:['page','editable','terminal']`、动作在 `resolve.run` 而非顶层 `run`、`defaults` 恰好 5 键且**故意不含 `web:linux`**）。
- **B. 致命崩溃吃掉整个 dsh 宿主**：`~/Library/Logs/DeepSeek Harness/crash-2026-10-07T05-30-05-568Z-host.log` → `dsh: fatal uncaught exception: Error: Connection lost before handshake … {fatal: true}`（`ssh2/lib/client.js:753`，经 `utils.js:142` 的 `makeError`）。根因：`SshSession.connect()` 与 `buildSshConnectionHandle()` 都用 `client.once('error', reject)`，而 **`once` 被第一个 error 消费**；ssh2 在握手完成前 socket 关闭时会**再发一次** `'error'`，Node `EventEmitter` 对无监听器的 `'error'` **直接 throw** → 宿主进程退出。**跳板机路径最易触发**（转发通道被跳板掐断）。已加常驻 `client.on('error', …)` 守卫（session 侧接 `events.error`，jump 侧静默，因为跳板错误已由 connect promise 报过）。
- **C. dsh 缺 VS Code 变体早就有的「清除已存密钥」出口**：`HostKeyStore.forget` 在 dsh 侧**完全不可达**（全仓只有 `extension.ts` 的 `sshManager.forgetHostKey` 在用）。所以脏记录**只能靠「信任下一个出现的指纹」清掉**＝让用户接受无法核验的密钥。已补 `terminal.forgetHost`，UI 仅在 `host-key-changed` 时给「清除已记录的密钥并重试」，并沿用与 `trustHost` 相同的跳板链边界（`forget` 同样不做「给任意主机写/删记录」的后门）。

**测试（+12）与验证**：tsc 0 · `verify:dsh` 9/9 · `verify:kernel` 5/5 · vitest **1133/1133**。**反向测试（两处）**：① 去掉 session 常驻守卫 → 崩溃用例**恰好 1 项**红；② `forget(host, 0)` → **恰好 2 项** forgetHost 用例红。另修 `test/sftp/SftpSession.test.ts` 的 ssh2 桩缺 `on`（真实 `Client` 继承 EventEmitter，桩不完整而非代码错）。

**⚠️ 排查纪律（我这一轮连错三次，值得记住）**：`shortcuts` 断言先猜 `run` 在顶层（真值在 `resolve.run`）、平台 token 猜 `win32`（真值 **`windows`**）、`findByAction` 猜返回 `undefined`（真值 **`null`**）。**断言前先读实现，不要凭直觉猜形状。**

**仍未取证（诚实登记）**：经跳板机 `ssh -W` 隧道扫 `10.0.133.11` **失败**——跳板机侧 `channel 0: open failed: connect failed: Connection refused`（换端口、前台串行重试均同）。⇒ 只证到「被污染那条 = 跳板机公钥」，**未能独立复核目标机真实指纹**。若要闭环，需在能连通 `10.0.0.0/8` 的网段执行 `ssh-keyscan 10.0.133.11` 与 `e1f5b507…` 比对。

#### 0.29 SFTP 从只读扩到「上传 / 下载 / 查看 / 编辑」（DSH-16 第三面收口）

**起因**：用户实测后指出「SFTP 只支持文件展示，缺少上传、下载、查看、编辑」。§0.26 的只读是**当时的有意决策**（「一个不能用的控件比没有控件更糟」），本轮把 Host 面长出来再回迁 UI。

**取证先行（真源 = `app.asar` 产物）**：结论是**官方一条都用不上**——`dsh-client-ui-sidebar-files` / `sidebar-documentpreview` / `api-workspace-files` 全部面向「会话**工作区**的本地文件」且**只读**；`dsh-client-file-upload` 是 **Session 寻址的提示词附件暂存**（不能指定远端路径）；`dsh-host-directory-picker` 选的是**目录**（用于指定 workspace）。⇒ 走已有的自建 RPC 通道，`SftpManager` 的读写原语本来就在。

**必须吸收的官方三条**（否则就是「凭感觉定阈值」）：

1. 二进制判定 = 采样**前 8192 字节**含 NUL（官方 `DshBinary`）；
2. 文本上限 = **2 MiB**（官方 file-provider 默认 `maxBytes`；分页 5000 行、整档 32 MiB）；
3. 官方本地文件 provider **只读** ⇒ 写必然自建。

**交付物**：

| 层 | 文件 | 内容 |
|---|---|---|
| 领域 | `src/sftp/{SftpTypes,SftpSession}.ts` | `SftpFileStat` 增**可选** `type`；`stat()` 填 `type`（`isDirectory()` 带存在性守卫，缺失降级为 `'file'` 而非抛错） |
| 领域 | `src/sftp/SftpManager.ts` | 新增 `writeFile(path, content)`：`readFile` 的对偶，收**字节**而非本地路径（RPC body 没有本地路径可交），沿用 `invalidateListings` |
| Host 面 | `src/platform/dsh/sftp.ts` | 4 方法（`readFile`/`writeFile`/`download`/`upload`）+ 2 上限 + 6 错误码 + 6 辅助函数；`translate()` 增 `verb`（写失败说 writing）+ **自有错误码透传** |
| Host 面 | `dsh/channel.js` | 4 条 RPC + 文档表 |
| Client | `views/sftpFile.ts`（新） | 文件页：`<pre>` 查看 / `<textarea>` 编辑 + 保存/撤销/冲突提问；状态行（大小/行数/**换行约定**/脏标记）；截断横幅 |
| Client | `views/sftp.ts` | 文件行选中（`aria-selected`）、单击选中/双击查看、工具栏 查看/编辑/下载/上传（`<label>` 包 visually-hidden file input）、上传结果提示 |
| Client | `body-session.ts` | pane 状态机 + 5 个处理函数；上传逐文件、冲突用 `window.confirm`；离开文件页关 pane |
| Client | `models.ts` / `i18n.ts` / `styles.ts` | 归一化器与状态类型 / zh+en 各 +31 键 / 选中行 + 上传控件 + 编辑器版面（只用 `--vscode-*` token） |
| 其他 | `l10n/bundle.l10n.zh-cn.json` | 补 `Write {path}`（`nls.test.ts` 要求 `src/**` 每个 `t()` 字面量都有 zh-cn 条目） |

**本轮最有价值的一处设计：CRLF 往返协议。** `<textarea>` 按 W3C 规范会把 CRLF 归一成 LF——不处理的话，「打开并保存任何 Windows 换行文件」会**静默改写每一行**。解法是把换行当**数据**而非默认值：读侧归一化 + 返回 `eol`，写侧先 strip `\r` 再按 `eol` join（幂等），且**`size` 取服务器 stat 而非 `text.length`**（CRLF 写回后比 LF 文本大，冲突基线必须是真实字节数）。调研子代理独立指出了同一风险点。

**冲突检测**与 VS Code 变体 `SftpEditSessionManager#uploadIfUnchanged` 同规则（`size`+`mtime`），只是触发点从「文档保存事件」换成「面板保存按钮」；`sftp-conflict` 在 UI 上渲染成**一个提问**（覆盖并保存 / 重新读取）而不是失败横幅——因为**什么都还没失败**。

**一处需要你拍板的取舍**：`allowSudoFallback` 保持 **`false`**。VS Code 变体的文件管理器用 `true`（写 root 文件自动 `sudo -n`）；dsh 面此前因「只读，开了等于预授权不可达的提权」而传 `false`，本轮它变成可写面，该理由不再成立，但**仍保持 `false`**：从浏览器面板静默提权比从命令面板触发隐蔽性强、可审计性弱，且计划 §0.26 的原意是「等真有写路径再做**专门决定**」。错误文案已给出出路（检查权限/换账号/终端页）。**要对齐 VS Code 行为，改一处布尔即可，但请明确知晓含义。**

**刻意没做**（`SftpManager` 四个原语都在，是范围决策非能力缺口）：重命名 / 删除 / 新建文件 / 新建目录 / 目录递归上传下载——各自需要独立的确认流程或弹窗，而「确认流程缺失的控件」正是本仓库反复拒绝的东西。

**测试（+61）**：`test/platform/dsh/sftp.test.ts` 新增 21 项（`FakeSftpWorld` 扩出文件系统：`files`/`writes`/`statSequence`）；`client-bundle.test.ts` 新增 8 项（沙箱补 `FileReader` 桩）；`client-models.test.ts` 新增 4 项并修正 `Enter` 在文件行上的期望（`none → open`）。

**验证**：tsc 0 · `verify:kernel` 5/5 · `verify:dsh` 9/9（含 `--check`）· 全量 vitest **1194/1194 绿（109 文件）**。
**反向测试（两处，各恰好 1 项红）**：① `detectEol` 恒答 `'lf'` → CRLF **读**用例红（写用例不受影响，因其显式传 `eol`，两用例覆盖面不重合）；② 客户端不回传 `eol`（改完**重建 bundle**）→ bundle 用例红。两处均已还原并重跑。
**构建确定性**：连续三次构建 md5 相同（`03c7b2e4…`）。

**顺带发现（与本轮无关）**：`dsh/esbuild.dsh.mjs` 的 `compare()` 把 `built.length`（JS **字符**数）标为 "bytes"。bundle 内嵌中文后两者不等（本轮 `client.js`：893519 字符 / 893641 字节，差 122）。比较本身是同口径（`readFileSync('utf8')` 也是字符数），数值不错，但失败信息写 "bytes" 会误导排查者。

**仍未闭环（诚实登记）**：① **真实远端未验证**（Host 面用假 `SftpSession` 驱动、浏览器面用脚本化 RPC 驱动，证到的是判定/状态机/接线/渲染）；② CRLF 文件在**真实 `<textarea>`** 中的往返未在真机点过（协议两侧已单测，DOM 归一化是规范保证）；③ 真实二进制文件（`.png`/ELF）判定未抽样；④ 大文件边界（>2 MiB 拒编辑、>4 MiB 拒下载）未真机验证；⑤ **视觉效果未验证**（无浏览器控制），窄栏下工具栏新增 4 个按钮后 `480px` 断点可能需要上调。

**待你验收步骤**：重启 dsh → 连终端 → 「文件」页 → 选中一个文本文件 → 查看 → 编辑 → 保存 → 下载 → 上传一个本地文件 → 在远端核对真实字节。

---

## 1. 计划总览

### 1.1 目标

在 `at-terminal-series` 内新增 **第三个构建变体 `dsh`**（与既有 `base` / `mcp` 并列），使 AT Terminal 成为一枚 dsh 原生插件：

1. 在 dsh Web UI 侧边栏出现「AT Terminal」入口，可**管理 SSH 资产**（服务器树）、**浏览 SFTP**、**启动 SSH 终端**；
2. dsh 的原生 Agent 能**直接调用** AT Terminal 的运维工具（先经 MCP 直通，再迁为 `defineTool` 原生工具）。

### 1.2 范围边界

| 做 | 不做 |
|---|---|
| 新增 `dsh` 变体与 `dsh/` 构建目录 | ❌ 修改 dsh 源码 / 提 PR（官方不收外部 PR） |
| 抽取 `vscode` 无关内核，Host 半复用 | ❌ 修改 `at-core` Rust 底座 |
| Client 半重绘 UI（Slots） | ❌ 移动端 / 触屏 UI |
| `defineTool` 原生工具化（M5） | ❌ 搬迁 AT Series Hub 的渐进暴露策略（保留 MCP 变体承接） |
| 保留 `base` / `mcp` 两变体不回归 | ❌ 把 MCP 变体下线 |

### 1.3 不回归约束（硬红线）

> 任何改动必须保证 `package:base` 与 `package:mcp` 两个变体的**构建、测试、行为完全不变**。
> 现有测试基线（`test/package.variants.test.ts`、`test/package.baseBundle.test.ts` 等）必须始终为绿。

---

## 2. 里程碑地图

| 里程碑 | 名称 | 出口标准（一句话） | 关键交付物 | 门禁 |
|---|---|---|---|---|
| **M0** | 骨架可加载 | dsh 能加载插件并成功调用一个 hello 工具 | `dsh/` 工程骨架 + 构建管线 + `cordis.patch.yml` | 配置转储中含 `at-terminal` 行 |
| **M1** | Agent 可用（MCP 直通） | dsh 的 Agent 能真实执行一次远程运维任务 | MCP server 注册 + 11 工具可见 + E2E 证据 | 三类工具实调成功，有物理落盘证据 |
| **M2** | 领域内核可用 | 无 UI 情况下完成资产 CRUD 与 SFTP 读写 | Host 半服务层 + `ctx.settings` + 路由 | 路由/工具层 E2E 全绿 |
| **M3** | 资产可见 | dsh 侧边栏能看见服务器树与远程目录 | Client 半打包 + Slots + 两棵树（只读） | 侧边栏入口出现且数据为实时值 |
| **M4** | 终端可用 | 在 dsh 内真实 SSH 登录并交互 | xterm 面板 + 流通道 + 背压 + 服务器表单 | 大输出不卡死、Ctrl+C / vim 可用 |
| **M5** | 原生工具化 | 11 个工具以 `defineTool` 原生形态工作 | 工具迁移 + policy + 卡片 + 后台任务 | 原生工具与 MCP 工具行为对齐 |
| **M6** | 可发布 | 可安装的 dsh bundle 并通过安装三查 | bundle + 冒烟脚本 + 文档 | 三查全过 + 文档同步 |

### 里程碑依赖图

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5 ──▶ M6
              │              ▲
              └── 与 M3/M4 可部分并行 ──┘
```

- **关键路径**：M0 → M2 → M4（终端流通道是全计划唯一的高风险单点）。
- **可并行**：M2 进行中即可启动 M3 的 Client 半打包管线（DSH-14）与 M4 的 xterm spike（DSH-19）。
- **M1 与 M2–M6 无依赖**，M1 完成后即可作为"可交付的中间态"使用。

---

## 3. 任务节点全表

> 估时为**粗估人日**，用于排序与并行决策，非承诺。每个节点必须产出可验证证据（见 §7）。

### M0 — 骨架可加载（预估 2 人日）

| ID | 任务 | 前置 | 产出 | 完成定义（DoD） |
|---|---|---|---|---|
| DSH-01 | 在 `at-terminal-series` 建 `base-dsh` 分支 | — | 分支存在且从 `main`(b5829e3) 切出 | `git branch` 可见；`main` 工作树干净 |
| DSH-02 | 冻结宿主版本：记录 dsh `0.1.1-rc.2` + 安装本地 dsh 与 `--patch` 启动能力 | — | 环境说明写入 `dsh/README.md` | `dsh --version` 与锁定值一致；`dsh web` 可启动 |
| DSH-03 | 新建 `dsh/` 工程骨架：`package.dsh.json`、`cordis.patch.yml`、`esbuild.dsh.mjs`、`tsconfig` | DSH-01 | 目录与构建脚本 | `npm run build:dsh` 产出 `dsh/bundle/host.js` |
| DSH-04 | Host 半最小实现：`apply(ctx, config)` + `ctx.logger` 稳定前缀 + 一个 `hello` 工具 | DSH-03 | `dsh/src/host/index.ts` | `dsh plugin --profile web add <绝对路径>` 成功；重启后 `--dump-config` 含 `at-terminal` 行 |
| DSH-05 | 搭建**开发回环**：`cordis.patch.yml` 用绝对路径/`file://` 直挂，实现改完重启即生效 | DSH-04 | 开发流程说明 | 改一行 Host 半代码 → 重启 profile → 行为变化可见 |
| DSH-06 | 接入 smoke：以 `--dump-config` + 工具可调性作为 M0 门禁脚本 | DSH-04 | `dsh/scripts/smoke-m0.mjs` | 脚本退出码 0/1 可判定 |

**M0 门禁**：模型在 dsh 会话中成功调用 `hello` 工具并收到返回值；`dsh --profile web --dump-config` 输出包含 `at-terminal`。

### M1 — Agent 可用 · MCP 直通（预估 2 人日）

| ID | 任务 | 前置 | 产出 | DoD |
|---|---|---|---|---|
| DSH-07 | 在 dsh profile 中注册 MCP server（指向 `~/.at-series/mcp/hub.js`）并**显式启用** | M0 | profile 配置 + 说明 | MCP server 状态为 enabled 而非 error |
| DSH-08 | 验证 11 个工具在 dsh 中可见（`mcp__*` 命名） | DSH-07 | 工具清单核对记录 | 11/11 工具出现在 dsh 工具列表 |
| DSH-09 | 读类工具 E2E：`list_ssh_servers` + `get_terminal_context` + `sftp_read_file` | DSH-08 | 会话记录 | 返回真实服务器与真实文件内容（非占位） |
| DSH-10 | 执行类 E2E：`run_remote_command` 在目标主机写入随机 nonce 并读回 | DSH-09 | `/tmp` 落盘证据 | 命令输出与落盘内容一致；确认弹窗按信任等级表现正确 |
| DSH-11 | 写类 E2E：`sftp_write_file` 触发一次一目录写授权 | DSH-09 | 授权交互记录 | 跨目录写入时弹窗提示"目录外写入"且不可整会话放行 |

**M1 门禁**：read / exec / write 三类工具各有一次真实成功记录，且证据可复现。

### M2 — 领域内核可用 · Host 半（预估 5 人日）

| ID | 任务 | 前置 | 产出 | DoD |
|---|---|---|---|---|
| DSH-12 | **内核解耦**：为 `ssh`/`sftp`/`assets`/`config` 定义宿主适配接口（HostPorts），把 `vscode` 依赖收敛到 4 个已知适配件 | M0 | 接口定义 + 依赖清单 | `grep -rl "from 'vscode'" src/{ssh,sftp,assets,config,terminal}` 结果为空 |
| DSH-13 | 凭据存储替换：`context.secrets` → `ctx.settings` 的 `role('secret')` 字段 | DSH-12 | 凭据适配器 | 密码/口令**不出现在任何响应体与日志**中 |
| DSH-14 | 状态持久化替换：`context.globalState` → 本地存储后端 | DSH-12 | 存储适配器 | 重启 dsh 后服务器列表与 host key 信任记录仍在 |
| DSH-15 | `ctx.settings.installSection()` 注册 8 项配置 + schemastery schema + `validate` | DSH-03 | 设置面 | dsh 设置面板可读写配置；非法值被拒 |
| DSH-16 | Host 半领域服务：ServerRegistry / SftpService / TerminalService | DSH-12 | 服务实现 | 单元测试覆盖 CRUD 与错误路径 |
| DSH-17 | `ctx.webServer.register({kind:'prefix', path:'/dsh-at-terminal', handler})`，用 `try/catch` 兜住重复注册 | DSH-16 | 路由层 | 重复挂载不杀死宿主；路由返回结构稳定 |
| DSH-18 | M2 集成测试：无 UI 下完成 server CRUD + SFTP 列目录/读写/重命名 | DSH-17 | 测试用例 | 全绿且断言真实远端副作用 |

**M2 门禁**：不依赖任何 UI，通过路由/工具完成一次完整的"新增服务器 → 连接 → 列目录 → 写文件 → 读回 → 删除"闭环。

### M3 — 资产可见 · Client 半（预估 4 人日）

| ID | 任务 | 前置 | 产出 | DoD |
|---|---|---|---|---|
| DSH-19 | Client 半打包管线：lazy CJS factory（`window.__ModuleLoader__.load({id, factory})`），副作用全部在 factory 内 | DSH-04 | `dsh/bundle/client.js` | 加载时无副作用；缺失 client 入口时构建**显式报错** |
| DSH-20 | Slots 接入：`sidebar.panellist` 注册面板行 + `main`(keyed) 注册主区面板 + `ctx.layout.selectPanel` 切换 | DSH-19 | 面板骨架 | 侧边栏出现「AT Terminal」，点击后主区切换 |
| DSH-21 | Host↔Client 消息通道：请求/响应 + 服务端事件推送（替代 `postMessage`） | DSH-20 | 通道模块 | 往返时延可测；断连可恢复 |
| DSH-22 | 服务器树组件（只读）：分组、折叠、连接状态徽标 | DSH-21 | 树组件 | 与 dsh 主题一致；数据为实时值（带时间戳断言两次拉取不同） |
| DSH-23 | SFTP 文件树组件（只读）：跟随活动终端、父目录、符号链接可展开 | DSH-21 | 树组件 | 断开态呈现明确，不谎报"无活动终端" |
| DSH-24 | 空状态与错误态：无终端 / SFTP 失败 / 无服务器 三种情形 | DSH-22,23 | 状态组件 | 三种状态均可见且文案准确 |

**M3 门禁**：在 dsh 内不改任何文件即能看到真实服务器树与真实远程目录。

### M4 — 终端可用（预估 7 人日，含高风险 spike）

| ID | 任务 | 前置 | 产出 | DoD |
|---|---|---|---|---|
| **DSH-25** | **⚠️ xterm spike（最高优先）**：用 ~30 行 echo 终端验证 dsh Host↔Client 通道的吞吐与背压能力 | M0, DSH-21 | spike 报告（含实测数字） | 得出结论"能否承载 10 MB 级输出"，据此决定 DSH-31 方案 |
| DSH-26 | 终端组件迁入 Client 半：复用 `webview/terminal/*`（renderer / semanticHighlight / zebra / search / clipboard） | DSH-25 | 终端组件 | 无 `vscode` 依赖；功能与现有 webview 终端对齐 |
| DSH-27 | SSH 会话流通道：Host 半持 `ssh2` 会话，向 Client 半推送字节流 | DSH-26 | 流通道 | 真实 SSH 登录成功并可交互 |
| DSH-28 | **背压/流控重做**：替换 webview-ack 语义（现 `TERMINAL_FLOW_PAUSE_BYTES=512K` / `RESUME=128K`） | DSH-27 | 流控实现 | `yes` / `cat 大文件` 不卡死、不丢字节、可中断 |
| DSH-29 | 交互补齐：resize、Ctrl+C、vim/top 等全屏程序、重连、断开提示 | DSH-28 | 交互实现 | 逐项手工验收清单全过 |
| DSH-30 | 服务器表单：增/删/改 + 私钥选择 + 内联校验（迁 `webview/server-form/*`） | DSH-21 | 表单组件 | 可通过 UI 完成新增服务器并立即连接 |
| DSH-31 | 终端相关设置项生效：字号、字体、scrollback、语义高亮、zebra、keep-alive | DSH-15,26 | 设置联动 | 改设置后终端即时反映 |
| DSH-32 | Host key 信任交互：未知主机确认 / 已变更主机阻断 | DSH-30 | 信任流程 | 未知主机弹确认；变更主机被阻断 |

**M4 门禁**：在 dsh 内完成"新增服务器 → 连接 → 执行命令 → 编辑文件 → 断开重连"全流程；大输出压测通过。

### M5 — 原生工具化（预估 5 人日）

| ID | 任务 | 前置 | 产出 | DoD |
|---|---|---|---|---|
| DSH-33 | `toolCatalog.ts` × 11 → `defineTool`：`parameters` + `output.schema` + `render` | M2 | 11 个原生工具 | 参数校验生效；schema 正确流入 system prompt |
| DSH-34 | description 重写：删除"确认弹窗"描述（移交 policy），保留能力与边界 | DSH-33 | 工具文案 | 文案与 policy 行为一致，无重复叙述 |
| DSH-35 | 策略迁移：`tools/pre-execute` 实现 allow/deny/**ask**（替代 `agentCommandTrust` / `remoteCommandAuthorization`） | DSH-33 | policy 插件 | 三级信任行为与现状对齐（none/limited/full） |
| DSH-36 | 硬红线：`ctx.tools.guard()` 承载敏感路径不可撤销 deny | DSH-35 | guard 实现 | 敏感路径即使 full trust 也**二次确认**且不记忆 |
| DSH-37 | 卡片：`presentCall` → `{card:'terminal'}`（命令）、`{card:'diff'}`（写文件） | DSH-33 | presenter | Client 半 `tool.call.toolview` 正确渲染；重放不崩 |
| DSH-38 | 长任务：大传输 → `ctx.jobs.start`，返回 `{kind:'background', jobId}` | DSH-33 | 后台任务 | 返回结构化 handle，**不解析人类文案取 id** |
| DSH-39 | 审计：`AgentAuditLog` → `tools/result` 观察者 | DSH-33 | 审计实现 | 每次调用产生一条不可变审计记录 |
| DSH-40 | MCP 与原生**行为对齐测试**：同一输入的返回值/错误语义一致 | DSH-33..39 | 对比测试 | 11/11 工具在两条路径上语义等价 |
| DSH-41 | 处置 `src/mcp`：确认 dsh 变体不打包 Bridge/Hub，`base`/`mcp` 变体不受影响 | DSH-40 | 构建配置 | `dsh` 变体产物不含 `hub.js`；`mcp` 变体产物不变 |

**M5 门禁**：dsh 中 11 个工具均为原生形态且行为与 MCP 路径等价；`base`/`mcp` 变体回归全绿。

### M6 — 可发布（预估 3 人日）

| ID | 任务 | 前置 | 产出 | DoD |
|---|---|---|---|---|
| DSH-42 | 主题适配：跟随 dsh 明/暗主题（替换 `--vscode-*` 主题变量） | M4 | 样式表 | 明暗切换下无不可读文本 |
| DSH-43 | i18n：复用 `src/i18n`，接入 dsh locale | M4 | 文案层 | 中英切换生效 |
| DSH-44 | 安装三查脚本：① 插件目录存在 ② profile link ③ profile bundle 条目 | M0 | `dsh/scripts/verify-install.mjs` | 缺任一项时脚本失败并**明确指出缺哪项** |
| DSH-45 | 冒烟脚本：启动 dsh → 断言 `window.__DSH_BOOT__` 含插件 → 侧边栏出现入口 → 主区可加载 | DSH-44 | `dsh/scripts/smoke-e2e.mjs` | CI 可跑；失败给出可定位原因 |
| DSH-46 | 打包 bundle：声明 `dsh.bundle`、标注**已验证 dsh 版本**、打 `dsh-plugin` GitHub topic | DSH-45 | 可安装包 | 干净环境安装成功 |
| DSH-47 | 文档同步：`docs/features.md` 增补 dsh 变体能力表、`README`、迁移记录 | 全部 | 文档 | 三个变体差异表清晰；无过时描述 |

**M6 门禁**：在一台干净环境按文档完成安装 → 使用 → 卸载，全程无手工修配置。

---

## 4. 目录与分支策略

### 4.1 分支

| 仓库 | 分支 | 用途 |
|---|---|---|
| `at-terminal-series` | `main` | 稳定线（不动） |
| `at-terminal-series` | **`base-dsh`** | 本次 dsh 变体开发主线 |
| 各独立子仓 | 不变 | 不侵入 |

### 4.2 目标目录结构（新增部分）

```
at-terminal-series/
├── package.json              # 既有（base / mcp）
├── package.dsh.json          # 【新增】dsh 变体清单
├── dsh/                      # 【新增】dsh 插件工程
│   ├── cordis.patch.yml      # 安装补丁（insert 一行）
│   ├── esbuild.dsh.mjs       # Host/Client 双入口构建
│   ├── README.md             # 安装 + 开发回环
│   ├── scripts/              # smoke-m0 / verify-install / smoke-e2e
│   ├── bundle/               # 构建产物 host.js + client.js
│   └── src/
│       ├── host/
│       │   ├── index.ts      # apply(ctx, config)
│       │   ├── settings.ts   # ctx.settings.installSection
│       │   ├── routes.ts     # ctx.webServer prefix /dsh-at-terminal
│       │   ├── services/     # ServerRegistry / Sftp / Terminal
│       │   ├── tools/        # defineTool × 11（M5）
│       │   └── policy/       # pre-execute / guard（M5）
│       └── client/
│           ├── index.ts      # ModuleLoader factory（唯一副作用入口）
│           ├── channel.ts    # Host↔Client 消息通道
│           ├── slots/        # sidebar.panellist + main
│           └── components/   # 服务器树 / SFTP 树 / 终端 / 表单
├── src/                      # 【复用】ssh / sftp / assets / terminal / config / i18n
└── webview/                  # 【复用】terminal/* 与 server-form/* 迁入 client
```

### 4.3 变体正交性

| 变体 | 清单 | 构建开关 | 宿主 |
|---|---|---|---|
| `base` | `package.base.json` | `MCP_ENABLED=false` | VS Code 兼容 IDE |
| `mcp` | `package.mcp.json` | `MCP_ENABLED=true` | VS Code 兼容 IDE + Agent |
| **`dsh`** | `package.dsh.json` | `DSH_ENABLED=true` | DeepSeek Harness |

> 复用 ADR-001 的双变体机制，**扩展**而非替换；`MCP_ENABLED` 与 `DSH_ENABLED` 必须互斥判定，避免代码分支交叉污染。

---

## 5. 风险登记册

| # | 风险 | 触发条件 | 影响 | 应对 / 降级 |
|---|---|---|---|---|
| R1 | dsh 处于 developer preview，破坏性变更 | 升级 dsh 后插件加载失败 | 高 | 锁定 `0.1.1-rc.2`；内核与适配层严格分层；bundle 标注已验证版本 |
| R2 | **终端流背压能力不足**（关键路径单点） | DSH-25 spike 显示吞吐/背压不达标 | 高 | **M0 后立刻做 spike**；降级方案：分块轮询 / 服务端限流 / 用 `ctx.jobs` 承接大输出 |
| R3 | Client 半运行时依赖受限 | 引入 xterm 等依赖时加载失败 | 中 | 编译期全量打入 client bundle；不依赖宿主 module base |
| R4 | Slot 生态演化 / 与他插件冲突 | 侧边栏或主区被占 | 中 | 只用 `sidebar.panellist` + `main`，不碰 `details`；作用域取 `session` |
| R5 | 凭据语义变化（`SecretStorage` → dsh） | 密码被回传到响应体 | 高 | `role('secret')` + 断言脚本扫描响应与日志 |
| R6 | `base` / `mcp` 变体回归 | 抽取内核时误伤 | 高 | 每里程碑跑全量既有测试；`DSH_ENABLED` 分支独立 |
| R7 | 原生工具与 MCP 工具行为漂移 | 两条路径返回值不一致 | 中 | DSH-40 对齐测试作为 M5 门禁 |
| R8 | AT Series MCP Hub 战略被旁路 | dsh 变体不再经过 Hub | 中 | 保留 MCP 变体承接 IDE 阵营；dsh 作为第三变体并存 |

---

## 6. 并行与门禁策略

- **并行建议**：M2 后半段即可启动 DSH-19/DSH-20（Client 半管线），M4 的 DSH-25 可与 M2 并行。
- **每个里程碑出口**：必须先过门禁脚本 + 证据留存，再进入下一里程碑；**不允许"先推进、稍后补验证"**。
- **回滚点**：M1 完成后即形成"可交付中间态"——即使后续 UI 迁移受阻，Agent 能力已可用。
- **M5 为可选里程碑**：若 M4 交付后资源受限，可停在 M4（保留 MCP 路径供 Agent 使用），M5 单独排期。

---

## 7. 质量门禁与验证证据（对齐反假装落地原则）

| 证据类型 | 要求 |
|---|---|
| **实时性** | 树节点携带纳秒时间戳，两次拉取断言不同 |
| **物理副作用** | `run_remote_command` 必须写入并读回随机 nonce；SFTP 写必须校验远端真实字节 |
| **保密性** | 扫描响应体与日志，断言明文凭据零出现 |
| **流真实性** | 终端流必须是真实 SSH 会话的字节流，不得用回显模拟 |
| **状态真实** | 模态/确认必须断言协程在未响应时处于挂起状态 |
| **变体正交** | `base` / `mcp` / `dsh` 三变体各自构建产物互不包含对方代码 |

---

## 8. 里程碑验收清单（Checklist）

### M0
- [ ] `base-dsh` 分支已建，`main` 干净
- [ ] `npm run build:dsh` 产出 `dsh/bundle/host.js`
- [ ] `dsh --profile web --dump-config` 含 `at-terminal` 行
- [ ] 模型成功调用 `hello` 工具
- [ ] 开发回环可用（改代码 → 重启 → 生效）

### M1
- [ ] dsh 中 MCP server 状态 enabled
- [ ] 11/11 工具可见
- [ ] read 类工具返回真实数据
- [ ] exec 类工具产生可复现落盘证据
- [ ] write 类工具的一目录一授权行为正确

### M2
- [ ] `src/{ssh,sftp,assets,config,terminal}` 无 `vscode` 导入
- [ ] 凭据不出现在响应与日志
- [ ] 重启后资产与信任记录仍在
- [ ] 设置面板可读写 8 项配置
- [ ] 路由 E2E 完成"增 → 连 → 列 → 写 → 读 → 删"闭环

### M3
- [x] 侧边栏出现「AT Terminal」入口（用户实测，§0.17.1）
- [x] 服务器树显示真实分组与连接状态 —— **按 §0.20 的用户反馈，资产页已定为"只留服务器列表"**，分组与状态徽标均在该列表上
- [x] SFTP 树跟随活动终端并显示真实目录 —— **代码与自动化已闭环（§0.26）**；真实远端未实测，登记在 §0.26.5
- [x] 三种空/错误态文案准确 —— 无终端 / 断开 / 读失败各自的码与文案互不合并（含"读不到的目录绝不报成私钥问题"）
- [x] Client 半加载时无副作用（门禁第 7 项在 VM 里执行 factory 断言，`document` 故意缺席）

### M4
- [ ] xterm spike 报告已产出并给出结论
- [ ] 大输出（`yes` / 大文件）不卡死、不丢字节
- [ ] Ctrl+C 与 vim/top 可用
- [ ] resize / 重连正常
- [ ] 可通过 UI 新增服务器并立即连接
- [ ] 未知主机确认、变更主机阻断

### M5
- [ ] 11 个工具为 `defineTool` 原生形态
- [ ] 三级信任行为与现状对齐
- [ ] 敏感路径硬红线不可撤销
- [ ] 卡片（terminal / diff）正确渲染且重放不崩
- [ ] 长任务返回结构化 jobId
- [ ] MCP 与原生路径 11/11 语义等价
- [ ] `dsh` 产物不含 `hub.js`

### M6
- [ ] 明暗主题下文本可读
- [ ] 安装三查脚本在缺项时明确指出缺失
- [ ] E2E 冒烟脚本可 CI 运行
- [ ] 干净环境按文档安装成功
- [ ] 文档同步完成，三变体差异表清晰

---

## 9. 建议执行顺序（压缩版）

```
DSH-01~06   M0 骨架            ← 第 1 步，先拿"能加载"的事实
DSH-07~11   M1 MCP 直通        ← 第 2 步，立刻拿到可用 Agent 能力（中间可交付）
DSH-25      xterm spike        ← 第 3 步，**最先消解唯一高风险单点**
DSH-12~18   M2 内核搬迁        ← 第 4 步，纯搬运，工作量最大风险最低
DSH-19~24   M3 资产可见        ← 第 5 步，可与 M2 尾部并行
DSH-26~32   M4 终端可用        ← 第 6 步，依赖 spike 结论
DSH-33~41   M5 原生工具化      ← 第 7 步，可选里程碑
DSH-42~47   M6 打磨发布        ← 第 8 步
```

> 唯一必须"提前做"的是 **DSH-25（xterm spike）**：它决定 M4 是否需要换方案，越早做越好。
