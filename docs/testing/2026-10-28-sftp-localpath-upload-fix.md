# SFTP 大文件下发：`localPath` 修复记录（2026-10-28）

> 对应缺陷报告：`at-pc/docs/testing/2026-10-27-sftp-large-binary-upload-gap.md`
> 结论：`at_terminal_sftp_write_file` 增加 `localPath`，由宿主进程读本机文件并流式上传。
> 7 696 320 B 的 Linux ELF 实测 **470 ms** 完成，远端 `sha256` 与本地逐字节一致，**零模型上下文成本**。
> 本文经过一轮独立对抗审查（task-3），第二轮补强（task-4/task-5）后再由同一审查者复核（task-6）。

---

## 0. 修的是什么

缺陷报告里的差别不是 SFTP 通道，而是「谁来读源文件」：

| | 源文件在哪 | 谁读它 | 数据流 |
|---|---|---|---|
| 用户手工上传（插件面板） | 本机磁盘 | 宿主进程 | 文件 → 网络 → 远端，不进上下文 |
| 修复前的 `sftp_write_file` | 本机磁盘 | **模型** | 文件 → 读进上下文 → `content` 字符串 → 网络 |

7.3 MB 二进制 → base64 10.26 MB → 约 250 万 token，这条路上没有一次调用能成立。
修复前实测（本机 DSH 宿主、99.94）：

```
at_terminal_sftp_write_file(path="/tmp/...", localPath="/etc/hostname")
  → Error: at_terminal_sftp_write_file: "content" is required and must be a string.
```

## 1. 改了什么

### 1.1 工具面（`dsh/tools.js`、`dsh/prompt.js`、`dsh/skills.js`）

`at_terminal_sftp_write_file` 现在接受两种互斥的来源：

```jsonc
{"path": "/opt/at-pc/at-pc-server", "localPath": "/Users/clkj/项目/at-pc/target/.../at-pc-server", "overwrite": true}
{"path": "/etc/app.conf", "content": "key = value\n"}
```

- `content` 不再是必填；`required` 只剩 `path`，两源互斥在 `execute()` 里判定（都不给、都给都拒绝，且发生在任何服务调用之前）。
- 输出新增 `localPath`（文本写入为 `null`），上传的渲染行是 `Uploaded N bytes from <localPath> to <path>`，不是 `Wrote ...`——模型读这一行当作事实，两种来源必须能分辨。
- `timeoutMs` 120 s → **480 s**：服务自身最坏情况已经是 60 s 授权 + 300 s 传输（还没算连接/realpath/stat），外层上限必须落在这些预算之外，否则慢链路会被截成笼统的 `TOOL_TIMEOUT`，而服务已经准备好的「哪一段超时、远端文件可能不完整」信息就永远发不出来。
- 系统提示词与 `at-terminal-remote-edit` 技能各加一句：**本机已有的文件走 `localPath`，二进制/大文件不要内联成 `content`**；上传即使完全信任也会询问。
- 工具定义投影 5370 B（上限 5400）——新增一个参数的同时把 4 条啰嗦描述压掉，没有抬上限。

### 1.2 服务层（`src/agent/SftpAgentService.ts`、`src/sftp/SftpSession.ts`）

- `AgentSftpSession` 端口新增 `statLocalFile()`（只取元数据，不读字节）与 `uploadLocalFile()`；后者落到既有的 `SftpSession.uploadFile()` → ssh2 `fastPut`，**整条链路没有一次把文件读成 string/Buffer**（ssh2 自己按 32 KiB × 64 窗口流式读盘）。
- 上传分支：解析远端路径 → 本机 stat → 远端是否存在 → `overwrite` 拒绝 → 写授权 → 流式上传（300 s 预算）→ 返回 `bytesWritten`（本机真实字节数）、`overwritten`、`localPath`。
- **`~` 展开 + `realpath`**：`statLocalFile` 先用 `os.homedir()` 展开 `~/`，再 `realpath`，再 stat 真实文件，返回 `realPath`。授权判断、确认框、真正上传的源、审计行、返回的 `localPath` 全部用 `realPath`——软链不能用「无辜的名字」把敏感文件送出去（见 §2.2 真机验证）。
- **超时是真的中止**：ssh2 的 `fastPut` 没有 abort API，所以 `SessionLease.abort()` 在截止时关掉这条池化连接（终端目标 → `disposeTerminal`，后台目标 → `evictBackgroundSession`），错误文案写明「传输已中止、远端文件可能不完整、依赖前先检查、需要替换请带 `overwrite: true`」。不再出现「报超时但字节还在继续写」。
- **覆盖的 TOCTOU**：`exists` 在弹窗之前查，传给传输层的是**弹窗时观测到的存在状态**（`overwrite: Boolean(exists)`），不是调用方那句 `overwrite: true`——否则弹窗写「Overwrite: no」而链路却被告知「可以替换」，弹窗期间冒出来的文件就被静默覆盖了。`uploadFile` 按这个状态再查一次，冲突翻译回既有的 `Remote file already exists. Pass overwrite: true to replace it.`（这条是第二轮复核抓出来的：第一版传的是调用方权限，回归用例先红后绿。）
- 失败原因码分开：`upload_timeout` / `local_not_found` / `local_not_regular_file` / `local_too_large` 与 `error` 不再混为一谈；`agent-audit.jsonl` 的落盘行额外带 `command: "upload <本地真实路径> -> <远端>"`，`dsh/index.js` 的通用 `tools/result` 行优先用服务回报的真实路径（失败早于解析时退回调用方写法）——事后能回答「谁把哪个本机文件放到了哪台机器」。
- 1 GiB 上限与 300 s 期限写在同一句错误里：上限约束「一次确认承诺多少」，期限约束「链路要多快」，两者都不假装对方不存在。

### 1.3 授权（`src/agent/SftpWriteAuthorizer.ts`、`src/agent/remoteWritePolicy.ts`、`src/platform/dsh/confirmation.ts`）

`localPath` 打开的是**一条新的出站通道**：宿主进程以用户身份读本机磁盘。所以它不复用普通写授权：

- `requireUpload()` **任何信任档都要询问**（`full` 也不例外，真机验证见 §2.2），**不存任何授权记忆**（只有 `once`），目录/会话授权都不覆盖上传。
- 本机来源或远端目标任一端命中敏感路径（`~/.ssh`、`id_*`、`*.pem`、`~/.aws`、`~/.gnupg`、`~/.dsh`、`~/.kube/config`、`~/.docker/config.json`、`.netrc`、`.credentials`、`.env`、`authorized_keys`）→ **二次确认**。判断的是 `realpath` 之后的路径，不是调用方写的字符串。
- 确认框写出两端：`Local source: <真实路径> (7.3 MB)` + 远端路径 + 覆盖标记，并说明「上传会把本地文件内容发到服务器，远端账号与任何监控方都能读到」；宿主侧审批事件的 `reason` 也带两端（`SFTP upload requested: <local> -> <remote>`），不只留在展示文本里。

### 1.4 构建产物

`dsh/host.bundle.js` 由 `src/**` 重新构建（19 715 行 / 1 170 154 B），`node dsh/esbuild.dsh.mjs --check` 与 `npm run verify:dsh` 全绿。

## 2. 证据

### 2.1 单元与契约

```
$ npm run typecheck                          → tsc --noEmit, exit 0
$ npx vitest run                             → 101 files / 1437 tests passed
$ npm run verify:dsh                         → verify: OK (11 passed, 0 skipped)
   包括 Tool definitions … 17 tool(s)、Compiled Host services match their sources
$ 工具定义投影字节数（{name,description,parameters}）→ 5370（上限 5400）
```

新增用例覆盖：上传不调用 `writeFile`、缺文件/目录/超限来源、两源都给/都不给、覆盖拒绝、授权请求形状、完全信任仍询问、两端敏感二次确认、上传不继承授权记忆、超时中止（终端与后台两种目标）、覆盖 TOCTOU、审计行与原因码、HUD 真实百分比，以及 `test/sftp/SftpSession.localUpload.test.ts` 用真实文件系统覆盖 `statLocalFile` 的 `~` 展开 / 软链 realpath / ENOENT / 目录判断。

### 2.2 真机上传（99.94，`root`，`agentCommandTrust = "full"`）

harness 直接走 `SftpAgentService.writeFile({ localPath })` + 真实 `SftpSession` + **真实 `SftpWriteAuthorizer`**（confirm 桩只记录 stage 并放行），源文件是报告里那只 7.69 MB ELF：

```
本地：7 696 320 B  sha256 2802fc30dbb75d66744a168fef3282b7647a713e1d2d9e908e67c97097996815

直接上传 : bytesWritten=7696320  overwritten=false  470 ms  stages=['primary']
           （服务器是 full 信任，仍然询问了一次）
不传 overwrite: "Remote file already exists. Pass overwrite: true to replace it."
再传 overwrite: true → overwritten=true
本机缺失 : "Local file was not found: /no/such/file"
目录来源 : "Local path is not a regular file: /Users/clkj"
软链来源 : 传 /tmp/at-e2e-link-to-artifact → 结果与授权里的 localPath 都是
           /Users/clkj/.../at-pc-server（realpath），stages=['primary']
敏感软链 : /tmp/at-e2e-innocent.bin → /tmp/at-e2e-sensitive/.ssh/id_rsa（假文件，15 B）
           localPath=/private/tmp/at-e2e-sensitive/.ssh/id_rsa
           stages=['primary','sensitive-double-check']  ← 二次确认真的触发
progress : 235 次回调，最后一次 transferredBytes=7696320 / totalBytes=7696320
```

远端验收（直接上传与软链上传两条路径都验）：

```
$ ls -l /tmp/at-sftp-localpath-probe/
-rw-r--r-- 1 root root 7696320 at-pc-server
-rw-r--r-- 1 root root 7696320 at-pc-server-via-link
-rw-r--r-- 1 root root      15 innocent.bin
$ sha256sum at-pc-server at-pc-server-via-link
2802fc30dbb75d66744a168fef3282b7647a713e1d2d9e908e67c97097996815  at-pc-server
2802fc30dbb75d66744a168fef3282b7647a713e1d2d9e908e67c97097996815  at-pc-server-via-link
```

即缺陷报告 §1.3 的「反向拉取」结果，现在由插件自己的通道完成，不需要临时 HTTP 服务。

## 3. 没有验证 / 已知边界（说清楚）

1. **正在运行的 DSH 宿主仍是旧代码。** 插件以 `link:` 安装（`~/.dsh/profiles/desktop` → 本仓库 `dsh/`），宿主启动时加载 `host.bundle.js`，所以新工具要**重启 DSH 宿主**后才在模型侧出现。本文的真机证据走的是同一份 `src/**` 的服务层，工具层由单测覆盖；「模型一次工具调用把 7.3 MB 推上去」这一步要等重启后再走一遍。
2. 重启后建议的验收：`at_terminal_sftp_write_file({ path: "/tmp/x", localPath: "<本机文件>", overwrite: true })`，确认弹窗显示 `Local source: …`，然后远端 `sha256sum` 对比。
3. **超时中止会留下被截断的远端文件。** ssh2 打开目标时就用 `'w'` 截断，所以「中止」只能保证不再继续写，不能保证远端还是旧内容；文案已经写明这一点。要彻底避免需要「临时文件 + rename」，本次没做（agent 会话不能走远端 `mv`，而 SFTP v3 的 rename 覆盖在部分服务端不可靠）。
4. HUD 没有「failed」这个状态，所以 `upload_timeout` / `local_*` 的精确原因码只落在 `agent-audit.jsonl`；HUD 上显示的是「非 denied」。补一个 failed 状态要改客户端模型与监控视图，不在本次范围。
5. 面板里的手工上传/下载路径没有改动，也没有回归。

## 4. 顺带说明

- `scp`/`rsync` 走不通仍是凭据边界（私钥在插件手里），不是 bug；现在不需要绕行方案了。
- 反向拉取（`python3 -m http.server` + 远端 `curl`）仍可作为插件之外的最后手段，但不再是推荐路径。
- 1 GiB 上限与「任何信任档都询问」是有意为之：一次确认承诺的是「搬这一个制品」，不是「搬这个路径上碰巧存在的任何东西」，更不是「这台笔记本以后都可以往外发文件」。
