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
| `sftp_write_file` | 写入 | 向远程文件写入 UTF-8 文本；覆盖已有文件需要 `overwrite: true`。 |
| `sftp_create_file` | 写入 | 创建远程文件，可选写入 UTF-8 内容。 |
| `sftp_create_directory` | 写入 | 创建远程目录。 |
| `sftp_rename` | 写入 | 重命名或移动远程文件/目录；源路径与目标路径都需要写授权。 |
| `sftp_delete` | 写入 | 删除单个远程文件（拒绝目录——目录请改用 `run_remote_command` 执行显式 `rm`，该路径走命令策略）；即使完全信任也总是询问用户，且答案永不记住。 |
| `open_monitor` | 界面 | 打开监控 HUD（硬件指标或 Agent 执行状态）。没有已连接的浏览器面板时返回 `opened: false, reason: "no-client"`，因为此时不会有任何东西显示出来。 |
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

## 安全行为

- `run_remote_command` 确认跟随服务器信任下拉（`Trust agent remote commands`）。**不信任**每条都弹窗。**有限信任**会加载 npm 精确依赖 `@at-series/command-policy@0.1.0`（禁止 `^`），对管道/链式命令的每一段检查变更状态黑名单：命中黑名单的阶段（写文件、改权限、装包、服务控制、`docker exec`、`iptables -F`）仍会弹窗；无法安全解析的命令（命令替换、文件重定向、未闭合引号）总是弹窗。**不在黑名单中的命令（包括未知命令）在有限信任下不弹窗直接运行。**`# Purpose:` 注释不授予权限；带引号的多行脚本以及静态 `sudo` / `python3 -c` / `sqlite3` 载荷会进入分析，而不是按包装命令名一刀切拦截。**完全信任**远程命令与 SFTP 写入都不弹窗。
- 有限信任不会跳过 SFTP 写入授权。完全信任会跳过普通的远程命令确认与 SFTP 写入确认；敏感路径是例外——完全信任下仍然会询问。任何信任档都不会跳过 SSH 主机指纹信任。
- Bridge 发布到 AT Series 注册表 `~/.at-series/bridges/<hostApp>/`。
- SFTP 写入按「目录」授权：弹窗提供 `Allow Once`（默认）、`Allow This Folder For 15 Minutes`、`Allow This Folder For The Session` 三档，任何一档都只覆盖用户当时看到的那个目录，不会覆盖整台服务器。
- 写入目标越出 SFTP 会话初始工作目录时，弹窗会明确高亮，并且不提供「本会话」这一档。
- 敏感路径（`~/.ssh`、`/etc`、`/usr`、`/root`、`*.service`、`authorized_keys`、`sudoers*`、`crontab`）一律二次确认，且永不记忆。
- Agent 的 SFTP 会话不做提权：权限不足即失败，`sudo -n` 回退只存在于用户手动操作的 SFTP 视图。
- 只读工具不会返回密码、私钥或 SecretStorage 内容。
- 后台命令的确认在**作业启动之前**完成，绝不在作业内部发起：作业已脱离这次调用，此时弹窗会出现在没有工具调用在飞的状态下，用户无处回答。若当前组合没有作业注册表，该调用会降级为前台执行，并在 `notice` 里说明原因。
- 取消后台命令会向远端**进程组**发 `SIGTERM`，并等到它真正消失才把作业结算为 killed——只关闭本地 SSH 通道会让进程继续跑。被信号的 pid 来自作业在远端写下的文件（以 job id 命名），发送信号前先删除该文件。
- SFTP 读取有大小限制，避免把大文件直接灌入 Agent 上下文。
- SFTP 的读取、列目录与 stat 有 30 秒上限：通道卡住时会以带路径的超时失败，而不是返回一个看起来像空文件的结果；写入与删除的确认另有 60 秒预算。
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
