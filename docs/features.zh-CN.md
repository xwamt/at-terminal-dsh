# 功能介绍

AT Terminal MCP 将 AT Terminal 基础版的 SSH/SFTP 工作区能力与通过共享 **AT Series** MCP hub 暴露的 Agent 工具结合在一起。

## 基础 AT Terminal 能力

MCP 版仍然包含基础版工作流：

- SSH 服务器管理。
- 密码和私钥认证。
- 主机指纹确认和已信任主机指纹变更阻断。
- SSH 终端标签页。
- SFTP 浏览、上传、下载和拖拽上传。
- SFTP 新建、重命名、删除、复制路径和预览。
- 远程文件本地编辑，并在保存时上传同步。
- 终端字体、滚动缓冲、语义高亮和 keep-alive 设置。

## SSH 终端

- 管理 SSH 服务器配置。
- 使用密码或私钥认证。
- 确认未知主机指纹。
- 阻止已信任主机的指纹变更。
- 每个 SSH 连接以独立终端标签页打开。
- 断开和重连会话。
- 配置终端字体、滚动缓冲、语义高亮和 keep-alive 行为。

## SFTP 文件管理

`SFTP Files` 视图会跟随当前活动 SSH 终端，连接后自动加载远程登录目录。

支持的操作：

- 浏览远程目录。
- 刷新当前目录。
- 跳转到父目录或输入远程路径。
- 上传文件。
- 从 VS Code Explorer 拖拽文件到 SFTP 视图上传。
- 下载远程文件或目录。
- 创建文件和目录。
- 重命名、删除和复制远程路径。
- 预览远程文件。
- 从远程目录向当前 SSH 终端发送 `cd` 命令。
- 路径开头的 `~` 会先展开成会话的登录目录（这里 `~` 与 `.` 是同一处；`~user` 不展开，那要读
  `/etc/passwd`，是另一个问题）。SFTP 没有 shell，不展开的话一个人天天打的路径会回
  `No such file`。

## 远程文件本地编辑

使用 `SFTP: Edit` 可以把远程文件打开到本地编辑器。扩展会下载文件、识别语言、监听保存，并在保存时把内容上传回原远程路径。

这个流程适合：

- Shell 脚本。
- Python 和 Node.js 脚本。
- 配置文件。
- 运维和部署脚本。
- 需要 AI 辅助解释或重构的远程文件。

## MCP 和 Agent 工具

AT Terminal MCP 通过共享 **AT Series** hub（`~/.at-series/mcp/hub.js`）发布工具。hub 会连接回正在运行的 AT Terminal MCP 扩展 bridge，因此凭据和主机信任仍保留在扩展宿主内。

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `ping` | 只读 | 报告插件是否就绪、本构建提供哪些能力，以及当前生效的设置；不触达任何远程主机。 |
| `list_ssh_servers` | 只读 | 列出已允许后台连接的 SSH 服务器，不暴露密码或私钥。 |
| `get_terminal_context` | 只读 | 返回当前聚焦、默认连接、已连接和已知的 AT Terminal SSH 终端上下文。 |
| `run_remote_command` | 命令 | 执行经过确认的非交互 SSH 命令，并返回 stdout、stderr、exit code、timeout、duration 和截断信息。除非服务器已被信任且 `@at-series/command-policy` 能证明这是普通只读，否则每条命令都要确认。stdout/stderr 各默认 64000 字节（硬顶 256000）。`run_in_background: true` 会把命令交给宿主的作业注册表：调用立即返回 job id，用 `job_output` 读取、用 `job_kill` 停止——停的是远端进程，不只是本地等待。 |
| `sftp_list_directory` | 只读 | 通过已连接的 AT Terminal SFTP 会话列出远程目录。最多返回 `maxEntries` 条（默认 500，硬顶 5000），并带 `truncated`/`total`；`offset` 可对大目录分页。 |
| `sftp_stat_path` | 只读 | 返回远程文件或目录的元信息。 |
| `sftp_read_file` | 只读 | 读取有限大小的 UTF-8 远程文本文件；默认 `maxBytes` 65536（硬顶 262144）；`offset` 可续读，负值从文件尾部读取；疑似二进制内容会被拒绝。 |
| `sftp_write_file` | 写入 | 向远程文件写入 UTF-8 文本；覆盖已有文件需要 `overwrite: true`。用 `localPath` 则改为上传「宿主进程所在机器上的文件」，不传 `content`：由宿主读取并流式传输，二进制或大文件不进入模型上下文；这类上传即使完全信任也会询问。 |
| `sftp_create_file` | 写入 | 创建远程文件，可选写入 UTF-8 内容。 |
| `sftp_create_directory` | 写入 | 创建远程目录。 |
| `sftp_rename` | 写入 | 重命名或移动远程文件/目录；源路径与目标路径都需要写授权。 |
| `sftp_delete` | 写入 | 删除单个远程文件（拒绝目录——目录请改用 `run_remote_command` 执行显式 `rm`，该路径走命令策略）；即使完全信任也总是询问用户，且答案永不记住。 |
| `open_monitor` | 界面 | 打开监控（硬件指标或 Agent 执行状态）：`mode: "hud"`（默认）浮窗，`mode: "tab"` 放进右侧栏页签。没有已连接的浏览器面板时返回 `opened: false, reason: "no-client"`，因为此时不会有任何东西显示出来；`mode: "tab"` 下 `opened: false` 也可能表示侧边栏没有可放置页签的会话。 |
| `get_hardware_metrics` | 只读 | 读取 SSH 服务器的 CPU、内存、磁盘、网络吞吐与占用最高的进程。探测脚本是内置的，绕过命令策略引擎；该调用仍然会进审计。 |
| `get_agent_execution_status` | 只读 | 报告正在执行的动作、最近的审计记录与进行中的 SFTP 传输。`source: file` 表示数据来自 `agent-audit.jsonl`（重启后仍在）；`source: memory` 表示不在了。 |
| `job_output` | 只读 | 读取后台 `run_remote_command` 自上次读取以来新产出的内容；`wait` 可阻塞到作业结算或预算用尽。每次调用会消费掉它返回的部分。 |
| `job_kill` | 命令 | 停止后台作业。对 SSH 命令而言是向远端进程组发 SIGTERM 并最多等一秒确认它确实消失，所以「killed」意味着进程已结束，而不只是信号发出去了。 |

## 斜杠命令

两个 Host 侧命令回答「关于插件本身」的问题，且**不占用模型回合**：会话日志只写 `command/run` 与
`command/done`，不追加任何 assistant 消息。

| 命令 | 作用 |
|---|---|
| `/ssh-metrics [服务器 id 或名称]` | 打印一台服务器（默认当前活动服务器）的 CPU、负载、内存与最满的分区，然后**在该服务器上**打开监控 HUD。没有浏览器面板时明确写 `HUD: not opened (原因)`，不谎称打开了窗口。 |
| `/ssh-audit [行数]` | 打印持久审计尾部——时间、判定、命令或路径——最多 50 行。审计为空或不存在时如实说明，而不是报错。 |

缺 agent 服务、缺审计、或组合里没有命令注册表时，两者都用一句话说清缺什么。

## 设置页

设置 → 插件 → **AT Terminal** 是本插件贡献到宿主设置外壳里的一个 tab（`settings.plugins.tab`），
外壳、导航与分页由 `ui-settings-plugins` 拥有。页面所有颜色都是 `--dsw-*` token，因此跟随明暗主题；
文案走本插件的中英双字典，不写死在组件里。

**审批弹窗跟随系统语言。** 弹窗是在 Host 侧拼出来的，所以语言取的是**操作系统**的（macOS 读
`AppleLocale`，否则用 `Intl`，再否则 `LC_ALL`/`LANG`），而不是应用的界面语言——后者存在渲染进程里，
Host 侧插件看不到。系统判断不准时，把设置项 **`dialogLanguage`** 钉成 `zh-CN` 或 `en` 即可；
默认 `auto` 跟随系统。实际生效的选择可以从插件通道的 `state.get` 读到
（`dialogLanguage: {setting, system, language, strings}`），所以语言不对时不用花一次模型回合去排查。

| 分区 | 内容 |
|---|---|
| 决策统计 | 最近 50 条授权判定怎么分布——放行、弹窗后确认、拒绝。数据来自 Agent 读的同一批审计行，页面与 Agent 不会各说一套。 |
| 最近审计 | 持久审计的最后 10 条：时间、判定、命令或路径。**复制 JSON** 把整批复制到剪贴板。 |
| 持久终端（可选） | 可选包 `@at-series/dsh-at-terminal-ssh` 装了没有、开着没有，带**安装** / **启用** / **停用**按钮与运行中的组件数。 |
| 信任库 | 已保存的每一条 SSH 主机密钥，带 `SHA256:` 指纹（与 `ssh-keygen -lf` 输出同形，才能真拿去比对）与所属服务器。**忘记** 走的是连接流程用的那条「按服务器限定」的路由。 |

「忘记」是**故意有限制**的：路由把 host/port 解析到某台服务器的跳板链内，所以只有当某台已配置服务器
自己的地址与该密钥一致时，这里才能忘记它。跳板机的密钥、或已被删除服务器留下的密钥，页面会写明原因，
而不是给一个按下去什么也不发生的按钮。

## 持久 SSH 终端（可选）

第二个**可选** bundle（`dsh-terminal-ssh/`）给模型提供跨工具调用存活的远端 shell：
`terminal_open`、`terminal_send`、`terminal_read`、`terminal_signal`、`terminal_close`。
主 bundle 不依赖它，没装这个 bundle 的 profile 里这些工具根本不存在。

```text
terminal_open({ type: 'ssh', name: 'payment01' })   # name = 服务器 id 或名称
terminal_send({ sessionId, text: 'cd /srv', submit: true })
terminal_read({ sessionId, count: 50 })
terminal_close({ sessionId })
```

- **靠 `name` 选服务器**：官方的 `terminal_open` 没有 `serverId` 参数。id 与名称都接受；
  两台服务器同名时**报错并列出两个 id**，不会替你选一个。
- **就绪判断是「看到提示符」这种文本证据**：只有当输出尾部确实像提示符时才结算成 `stdin_read`；
  否则静默结算为 `inferred_idle`，超过期限结算为 `timeout`。`inferred_idle` **不等于**命令已结束
  —— 这与宿主自带终端工具的告警一致。
- **信号一律拒绝**：`ssh2` 没有 pty 信号通道，所以 `terminal_signal` 直接报错，并给出两条可行路径：
  用 `terminal_send` 发 `Ctrl+C`（`\u0003`），或 `terminal_close`。报一个编造的进程组
  `delivered: true` 属于伪造证据。
- 会话用的是与面板同一套服务器记录、凭据与主机密钥库，所以在 AT Terminal 面板里改过的服务器，
  就是 Agent 连上的那台。
- **它借用主 bundle 的 platform，绝不自己再装一个。** 两个 bundle 装在同一个 Node 进程里但是
  分别构建的，各自带一份 platform 注册表；第二份装配必然失败，因为 `storageDomain.open()` 是独占的，
  会直接回 `domain 'at_terminal_state' is already open`。所以这个入口只读取已安装的 platform
  （宿主还在装配时先等它），没有就报「请启用 AT Terminal 并重启」——这也是本包把 AT Terminal
  声明为 peer 的原因。

- **模型读到的是纯文本。** 远端 pty 流是**终端**流——每个提示符都带一个窗口标题和一串颜色。
  两者都在字节进入处（`feed()`）就剥掉，于是视口与分页里是「纯文本终端会打印的东西」，
  而不是让模型掏 token 买的转义码。颜色是有意丢的：这个后端没有 xterm 渲染器去还原它。

真机验证（DSH 0.2.1-rc.2，macOS）：`terminal_open({type:'ssh', name:'99.90'})` 返回
`started terminal session pty-1 (99.90) [type: ssh]`；`terminal_send` 发 `cd /tmp` 结算为
`stdin_read` / `running`；下一次 `terminal_send` 发 `pwd` 打印 `/tmp`，`terminal_read` 里两条
命令在同一条 shell 历史里——这就是这个 bundle 存在的意义（会话保持）。

## 安全行为

- `run_remote_command` 确认跟随服务器信任下拉（`Trust agent remote commands`）。**不信任**每条都弹窗。**有限信任**会加载 npm 精确依赖 `@at-series/command-policy@0.1.0`（禁止 `^`），对管道/链式命令的每一段检查变更状态黑名单：命中黑名单的阶段（写文件、改权限、装包、服务控制、`docker exec`、`iptables -F`）仍会弹窗；无法安全解析的命令（命令替换、文件重定向、未闭合引号）总是弹窗。**不在黑名单中的命令（包括未知命令）在有限信任下不弹窗直接运行。**`# Purpose:` 注释不授予权限；带引号的多行脚本以及静态 `sudo` / `python3 -c` / `sqlite3` 载荷会进入分析，而不是按包装命令名一刀切拦截。**完全信任**远程命令与 SFTP 写入都不弹窗。
- 有限信任不会跳过 SFTP 写入授权。完全信任会跳过普通的远程命令确认与 SFTP 写入确认；敏感路径是例外——完全信任下仍然会询问。任何信任档都不会跳过 SSH 主机指纹信任。
- `localPath` 上传单独授权：它读的是宿主进程所在的本机，而任何服务器信任档都没覆盖过这台机器。因此它在任何信任档都会询问（完全信任也不例外），不存储授权记忆；本机源文件或远端目标任一端属于敏感路径时，仍然二次确认。
- Bridge 发布到 AT Series 注册表 `~/.at-series/bridges/<hostApp>/`。
- SFTP 写入按「目录」授权：弹窗提供 `Allow Once`（默认）、`Allow This Folder For 15 Minutes`、`Allow This Folder For The Session` 三档，任何一档都只覆盖用户当时看到的那个目录，不会覆盖整台服务器。
- 写入目标越出 SFTP 会话初始工作目录时，弹窗会明确高亮，并且不提供「本会话」这一档。
- 敏感路径（`~/.ssh`、`/etc`、`/usr`、`/root`、`*.service`、`authorized_keys`、`sudoers*`、`crontab`）一律二次确认，且永不记忆。
- Agent 的 SFTP 会话不做提权：权限不足即失败，`sudo -n` 回退只存在于用户手动操作的 SFTP 视图。
- 只读工具不会返回密码、私钥或 SecretStorage 内容。
- 后台命令的确认在**作业启动之前**完成，绝不在作业内部发起：作业已脱离这次调用，此时弹窗会出现在没有工具调用在飞的状态下，用户无处回答。若当前组合没有作业注册表，该调用会降级为前台执行，并在 `notice` 里说明原因。
- 取消后台命令会向远端**进程组**发 `SIGTERM`，并等到它真正消失才把作业结算为 killed——只关闭本地 SSH 通道会让进程继续跑。被信号的 pid 来自作业在远端写下的文件（以 job id 命名），发送信号前先删除该文件。
- 同时连着多台服务器时，「没有指定 serverId」的调用按它能不能改远端来区别对待。**写类与执行类**（`sftp_write_file`、`sftp_create_file`、`sftp_create_directory`、`sftp_rename`、`sftp_delete`、`run_remote_command`）直接报错并列出所有已连接服务器，**一个字都不会发到任何主机**——打错机器的写入会返回一个看起来像成功的 `exitCode: 0`，比失败更危险。**读类**（`sftp_list_directory`、`sftp_stat_path`、`sftp_read_file`、`get_hardware_metrics`）仍跟随当前活动终端，但结果里写 `resolvedBy: "implicit"` 并附候选列表；只连一台时写 `"single-connected"`。`open_monitor` 按读类处理：它只切换面板，不改远端。
- SFTP 读取有大小限制，避免把大文件直接灌入 Agent 上下文。
- SFTP 的读取、列目录与 stat 有 30 秒上限：通道卡住时会以带路径的超时失败，而不是返回一个看起来像空文件的结果；写入与删除的确认另有 60 秒预算。`localPath` 上传有自己的 300 秒预算：超时会中止这次传输并断开它所在的 SSH 连接，错误里说明远端文件可能不完整、依赖它之前先检查一遍——传输开始时目标文件就已经被截断，所以这个期限无法只停止写入而不关连接；要替换它需要 `overwrite: true`。外层工具调用上限为 480 秒，位于这两个预算之外，只用来兜住服务自身计时器之外的卡死。
- 写入工具会解析远程路径，不允许修改远程根路径。

## 资产导入导出

运行 `AT Terminal: Export Assets` 可创建加密的 `.at-terminal-assets` 包，包含 SSH 服务器配置。密码和私钥文件是可选导出项，只有勾选后才会包含。

在另一台支持的 IDE 或设备上运行 `AT Terminal: Import Assets` 可解密并导入所选资产。导入的私钥会存放到扩展的全局存储区，服务器配置会更新为新的本地路径。SSH 主机信任记录不会迁移，因此导入后首次连接仍会请求主机信任确认。

## UI 与主题适配

- 用于添加和编辑服务器的 Webview 表单。
- 清晰的密码与私钥认证分区。
- 通过文件选择器选择私钥。
- 内联校验与保存状态。
- 图标、侧边栏和表单会适配当前 IDE 主题。
- 面板样式表是**独立 chunk**：插件任一界面首次渲染时才取，不是 Harness 启动时——从不打开面板的
  会话不会下载它（客户端入口 422 909 B → 329 332 B）。
