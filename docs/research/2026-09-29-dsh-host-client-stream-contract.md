# DSH Host↔Client 字节流契约（Typert / 远程终端）

- 日期：2026-09-29
- 范围：只读侦察，不改任何产品代码
- 侦察对象（两个缓存，**版本不同，必须区分**）：
  - `$BASE = dsh/.cache/base-recon/node_modules/@deepseek-ai` — 宿主 **已安装版本 0.1.7-rc.2**（全量提取）
  - `$M4   = dsh/.cache/m4-recon/node_modules/@deepseek-ai`   — **0.2.0-rc.1** 快照（部分包）

> **版本校准（先看这条）**：`dsh-api-terminal-controller` 在两个缓存里 `lib/index.js`、`lib/types/stream.js`、`lib/types/terminal.js`、
> `lib/types/retention.js`、`lib/client.js` **字节完全一致**（md5 相同，见 `## 未确定项` 的复验命令）；
> 只有 `lib/typert.host.js` 与 `package.json` 不同，且差异**仅在 FaceModel 的 `SessionEventMap` 文档字符串**（4 行 diff），
> 不涉及任何 terminal invocation/descriptor。因此本文引用的所有行号对**已安装的 0.1.7-rc.2 同样成立**。
> 除特别标注为 `$M4` 的条目外，报告统一引用 `$BASE`（已安装版本）。

---

## 结论摘要

1. **能复用，但不是"照抄终端通道"，而是复用终端通道底下的通用管道。** 官方浏览器终端 = 一个**用户态协议**（`terminal/*` 命名空间 + `TerminalFrame` 结构）架在 **Typert Remote** 通用管道之上；我们要的是后者。
2. **Typert 是通用能力，不是终端专用能力**：任何 cordis 插件都能注册自己的命名空间与流方法（`src/` 源码模式回退，**无需官方代码生成器**）。
3. **但 `ctx.remote.<ns>` 客户端命名空间不会被自动挂载** —— `$BASE/dsh-api-remotes/lib/types/client/index.js:2-24,35-43` 是一份**手维护白名单**。第三方要拿到自己的客户端命名空间，**必须自己写一个 client 插件并调用 `ctx.remote.$mount(我们的贡献)`**（这是公开 API，`README` 明示）。
4. **不需要新开 WebSocket**：官方已经有单条多路复用 WS `/api/remote.mux`（`$BASE/dsh-api-gateway/lib/types/stream-protocol.js:4`）。但 `ctx.webServer.registerUpgrade({path,handler})` 也是公开 seam，本项目 `dsh/channel.js` 已经在用。
5. **背压是"拉取 + 末端 ack + 源端 PTY 暂停 + 中段有界丢弃"**，没有 pause/resume/credit window。**唯一的硬阈值是每 follower 2 MiB**，超限即**杀掉该 follower**（不降速），然后靠**屏幕快照重连**恢复。
6. **所以第三方能不能复用官方终端通道？** —— 复用**管道**：能（有公开 seam）；复用**官方 `terminal` 命名空间本身**：不能，也不该（它是终端专用协议，且客户端白名单写死）。
7. 我们的架构应当是：**自己的 Typert 命名空间（例如 `terminal` 之外的 `atssh`）承载自己的字节帧，客户端自己 `$mount` + 自己的 xterm 面板**；官方 `terminal` kind 完全不动。

---

## 链路还原

### 0. 先纠正一处重要前提（否则整条链路会找错包）

任务描述把两个**互不相干**的子系统当成了一条：

| 子系统 | 包 | 服务 | 面向谁 | 是否本文相关 |
|---|---|---|---|---|
| **Agent/模型侧持久 PTY** | `$BASE/dsh-terminal`（`ctx.terminals`）+ `$BASE/dsh-terminal-bash`（`shell` backend） | `ctx.terminals` | 模型工具调用，**行式** read/send/signal | **无关** |
| **浏览器侧交互终端（xterm）** | `$BASE/dsh-api-terminal-controller`（Host）+ `$BASE/dsh-client-ui-sidebar-terminal`（Client） | `ctx.terminalController` / `ctx.remote.terminal` | 人类用户的侧栏终端，**全屏字节流** | **本文全部** |

证据（可复验）：

```sh
sed -n '12p' BASE/dsh-terminal/README.md
# → "它提供 ctx.terminals 服务"（agent 侧、行式、one-send-at-a-time）
sed -n '1,4p' BASE/dsh-terminal-bash/README.md
sed -n '54p' M4/dsh-api-terminal-controller/README.md
# → "The Host uses ctx.subprocess.spawnTerminal with TERM=xterm-256color"
```

关键差异：`dsh-terminal` 里**没有任何 Typert / xterm / 字节流代码**；浏览器终端的 PTY 原语是 **`ctx.subprocess.spawnTerminal`**，与 `dsh-terminal-bash` 无关。
所以任务里"Host 半（`dsh-terminal-bash`/`dsh-terminal`/`dsh-api-terminal-controller`）谁的哪个方法推 PTY 字节"这个问题**前两个包不成立**。

### 1. 逐跳链路（Host → Client）

```
                      ┌─────────────────────────── Host (Node 进程) ───────────────────────────┐
node-pty PTY ──onData─▶ LocalTerminalHandle.output (PassThrough, HWM 16KiB)
                          │  write() 返回 false → terminal.pause()   ← 源端背压（真暂停）
                          ▼
                       BrowserTerminal.consume()   for await (chunk of handle.output)
                          │  TextDecoder stream:true（UTF-8 跨包安全）
                          ▼
                       BrowserTerminal.output(data)
                          │  1. await screen.write(data, cb)   ← headless xterm 解析（背压的节流点）
                          │  2. broadcast({type:'output', sequence, data})
                          ▼
                       TerminalFollower.push(frame)          ← 每 follower 有界队列（2 MiB）
                          │  超限 → follower.close() + failure（杀 follower，不降速）
                          ▼
                       TerminalFollower.read(signal)  async*   ← 拉取式（宿主不主动推）
                          ▼
                  TypertGatewayService.openWireStream → RemoteStreamMuxConnection.pump()
                          │  for await (value of source) await this.send({type:'item',...})
                          │  send() await socket.send(text, cb)  ← ws 写回调（TCP 背压向上传播）
                          ▼
                  ══ 单条 WebSocket:  /api/remote.mux  ══
                          ▼
                      ┌─────────────────────────── Client (浏览器) ───────────────────────────┐
                  RemoteStreamMuxClient  →  RemoteStream.read()  async*
                          │  for await (value of options.open(signal)) yield {generation,value,signal,accept}
                          ▼
                  TerminalView.consume(stream)   for await (item of stream)
                          │  校准 sequence / 检测 gap
                          ▼
                  await new Promise(resolve => { pendingRender={revision,resolve}; patch({render:{revision,frame}}) })
                          │  ← 这里 await 阻塞，是客户端 ack 闸门：不 ack 就再也不 pull 下一帧
                          ▼
                  React TerminalScreen  useLayoutEffect(state.render)
                          ▼
                  xterm.write(frame.screen | frame.data, () => model.acknowledge(render.revision))
```

**逐跳证据（全部 `文件:行号`）**

| 跳 | 文件:行号 | 内容 |
|---|---|---|
| PTY onData → PassThrough，满则 `terminal.pause()` | `$BASE/dsh-subprocess-local/lib/index.js:796-801` | `if (!this.output.write(Buffer.from(data,'utf8')) && ... !this.outputPaused) { this.outputPaused = true; terminal.pause(); }` |
| PTY drain → resume | `$BASE/dsh-subprocess-local/lib/index.js:787-795` | `const resume = () => { ... if (!this.exited) terminal.resume(); }; this.output.on("drain", resume);` |
| `output` 是 PassThrough | `$BASE/dsh-subprocess-local/lib/index.js:750` | `output = new PassThrough();` |
| `done` 契约 | `$BASE/dsh-subprocess-local/lib/index.js:786` | `this.done = this.outcome.promise;`（resolve 出 `{exitCode, signal}`） |
| Host 句柄消费者：UTF-8 流式解码 | `$BASE/dsh-api-terminal-controller/lib/index.js:497-505` | `for await (const chunk of this.handle.output) { const data = decoder.decode(chunk,{stream:true}); await this.output(data); }` |
| **PTY 字节 "推" 出去的唯一方法** | `$BASE/dsh-api-terminal-controller/lib/index.js:513-520` | `async output(data){ await this.enqueue(async()=>{ await new Promise(r=>{this.screen.write(data,r)}); this.broadcast({type:'output', sequence:++this.sequence, data}); }) }` |
| Host 广播给所有 follower | `$BASE/dsh-api-terminal-controller/lib/index.js:484-487` | `broadcast(frame){ for (const follower of this.followers) follower.push(frame); }` |
| 有界队列 + 丢弃策略 | `$BASE/dsh-api-terminal-controller/lib/types/stream.js:20-32` | `push(frame){ const bytes = Buffer.byteLength(JSON.stringify(frame),'utf8'); if (this.bytes + bytes > this.maxBytes) { this.failure = new Error('Terminal output consumer exceeded its buffer; reconnect to recover the current screen'); this.close(); return; } ... }` |
| 拉取式消费 | `$BASE/dsh-api-terminal-controller/lib/types/stream.js:50-76` | `async *read(signal){ ... const next = this.queue.popFront(); ... await new Promise(r=>{this.wake=r}); }` |
| Host 流方法 `follow` | `$M4/dsh-api-terminal-controller/lib/typert.host.js:281-331`（descriptor）/ `:654`（签名） | `@Remote({ mode:'stream' }) follow(agent, id, attachmentId, signal): AsyncIterable<TerminalFrame>` |
| Host follower 基线帧（快照） | `$BASE/dsh-api-terminal-controller/lib/index.js:349-379` | `yield baseline`（`{type:'snapshot', sequence, screen, info}`）→ 再 `yield* follower.read(signal)` |
| Gateway mux 泵 | `$BASE/dsh-api-gateway/lib/types/stream-server.js:187-221` | `pump()`：`for await (const value of source) await this.send({type:'item',streamId,value})` |
| Gateway 单 socket 串行写 | `$BASE/dsh-api-gateway/lib/types/stream-server.js:234-256` | `send()`：`this.writes = delivery.catch(...)`，`socket.send(text, cb)` |
| mux 路径常量 | `$BASE/dsh-api-gateway/lib/types/stream-protocol.js:4` | `export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux';` |
| 路由注册点 | `$BASE/dsh-api-gateway/lib/index.js:628-643` | `webCtx.webServer.registerUpgrade({ path: REMOTE_STREAM_MUX_PATH, handler })` |
| Client 流读循环（3 字段 item） | `$BASE/dsh-api-gateway/lib/types/client/remote-stream.js:68-101` | `yield { generation, value, signal, accept: () => { ... } }` |
| Client `$stream` 工厂 | `$BASE/dsh-api-gateway/lib/client.js:1625-1627` | `$stream(options){ return new RemoteStream(this.connection, options); }` |
| 终端 Client 打开流 | `$BASE/dsh-api-terminal-controller/lib/client.js:231-247` | `this.gateway.$stream({ name:'Browser terminal output', open: async function*(signal){ await this.retain?.(signal); ... yield* this.remote.follow(sid, info.id, attachmentId, signal) }, ended, carrierFailed })` |
| 客户端 consume + **ack 闸门** | `$BASE/dsh-api-terminal-controller/lib/client.js:387-426` | 见下行 |
| ack 闸门本体 | `$BASE/dsh-api-terminal-controller/lib/client.js:405-426` | `const revision = ++this.revision; await new Promise(resolve => { this.pendingRender = {revision, resolve}; ... this.patch({render:{revision, frame}}); })` |
| ack 释放 | `$BASE/dsh-api-terminal-controller/lib/client.js:262-266` | `acknowledge(revision){ if (this.pendingRender?.revision !== revision) return; this.pendingRender.resolve(); this.pendingRender = undefined; }` |
| 交给 xterm | `$BASE/dsh-client-ui-sidebar-terminal/lib/client.terminal.js:13442-13454` | `xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => { model.acknowledge(render.revision); })` |
| 输入反向（unary，不是 uplink） | `$BASE/dsh-api-terminal-controller/lib/client.js:271-290` | `this.remote.write(sessionId, id, attachmentId, data)`，经 `this.writes` promise 链串行化 |
| Client unary 走 `/api` RPC | `$BASE/dsh-api-gateway/lib/types/client/index.js:274-278` | `connection.rpc.call('/api', endpoint, { args: prepared.args }, prepared.signal)` |
| xterm onData → model.write | `$BASE/dsh-client-ui-sidebar-terminal/lib/client.terminal.js:13419-13421` | `const input = xterm.onData((data) => { model.write(data); });` |

### 2. 帧结构（wire 上的确切类型）

`TerminalFrame`（`$M4/dsh-api-terminal-controller/lib/types/terminal.js` 的 FaceModel 声明，见 `$M4/.../typert.host.js:1181-1183`）：

```ts
type TerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: WebTerminalInfo }
  | { readonly type: 'output';   readonly sequence: number; readonly data: string }
  | { readonly type: 'state';    readonly info: WebTerminalInfo };
```

- **`output.data` 是 `string`（UTF-8 文本），不是 `Uint8Array`。** 由 Host 侧 `TextDecoder(..., {stream:true})` 解码后放入（`lib/index.js:497-505`）。
- Zod 严格 codec 定义：`$BASE/dsh-api-terminal-controller/lib/typert.host.js:52-95`（`follow_result` 的三个 union 分支）。
- `sequence` 单调递增、客户端**校验连续性**，gap 即判协议违规：`$BASE/dsh-api-terminal-controller/lib/client.js:395-398`。
- 只有 **第一帧是 `snapshot`**，其后每次重连的第一帧又是新的 `snapshot`（`lib/index.js:349-355`）。

---

## 背压实现

### 1. 四层，各管一段（**没有一层叫 pause/resume/credit**）

| # | 位置 | 机制 | 阈值/常量 | 溢出行为 |
|---|---|---|---|---|
| **L1** | PTY 原语 `LocalTerminalHandle.output` | Node `PassThrough` 的 `write()` 返回 false → **`terminal.pause()`**，`'drain'` → `terminal.resume()` | `PassThrough` 默认 highWaterMark = **16384 B (16 KiB)** | **真暂停 PTY**（无丢弃） |
| **L2** | Host `BrowserTerminal.output()` | `await this.enqueue(...)` 串行队列；`await screen.write(data, cb)`（headless xterm 解析完成才继续）；`consume()` 是 **`for await`**，即**拉取** | 无字节上限，靠 headless xterm 解析速度节流 | 解析慢 → 消费慢 → `handle.output` 不被 pull → **L1 反向暂停 PTY** |
| **L3** | Host `TerminalFollower` | 每 follower 一个 `Deque` + 字节记账（按 `JSON.stringify(frame)` 的 UTF-8 字节数） | **`maxBufferedBytes` = 2097152 (2 MiB)** `$BASE/dsh-api-terminal-controller/lib/index.js:745` | **`follower.close()` + 设 `failure`** → 该流终止（客户端收到 error → `phase:'disconnected'` → 重连拿到新 snapshot）。**不降速、不丢帧、直接断流** |
| **L4** | Gateway mux | `pump()` 的 `await this.send()` → `await socket.send(text, cb)`；`send` 串在同一连接的 `this.writes` 链上 | 无显式上限；`ws` 内部 + TCP 背压 | TCP 写阻塞 → `pump` 停 → 不再 pull → 反压回 L3/L2/L1 |
| **L4b** | Gateway mux **上行** 队列（与本链路方向相反） | `UplinkInbox` | **`streamInboxBytes` = 262144 (256 KiB)** `$BASE/dsh-api-gateway/lib/index.js:552,598` | `RemoteError('gateway/uplink-overflow')` 失败整条逻辑流 |
| **L5** | Client `TerminalView.consume` | 每帧 `await` 一个 Promise，只有 `xterm.write(..., cb)` 回调里 `acknowledge(revision)` 才 resolve | 无字节上限 | 不 ack → 不 pull → 反压回 L4 |

关键负数证据（**确认不存在** pause/resume/credit/watermark）：

```sh
grep -rn "backpressure\|watermark\|highWater\|flowControl\|credit" \
  BASE/dsh-api-gateway/lib/ BASE/dsh-api-terminal-controller/lib/
# → 仅命中注释 "no longer owns are dropped" / "unread uplink items are dropped"，
#   即 Gateway 层的策略就是 drop，不是 pause。
```

`UplinkInbox` 的 drop 语义明写在注释里：`$BASE/dsh-api-gateway/lib/types/stream-server.js:336`（`/** Consumer stopped reading: later items are dropped, a pending read ends. */`）。

### 2. 为什么"看起来像无损"—— 其实靠 **snapshot 重连补偿**

L3 一旦溢出，不重传、不续传，而是**整条流失败**；客户端 `fail()` 把 `phase` 置为 `disconnected`（`remote-stream` 若能重连则由 `RemoteStream.read()` 自动重开），重开时 Host 的 `follow()` 先吐一个新的 `{type:'snapshot', screen: serializer.serialize()}`（`lib/index.js:349-355`），**用当前屏幕状态覆盖丢失的历史**。

所以：**丢的是"滚动历史"，不是"当前画面"**。`scrollback` 配置（默认 1000 行 `lib/index.js:744`）决定一次 snapshot 能带回多少行。
这条设计对我们是**可复制的**，也是最值得抄的一点：与其做复杂的流控，不如做「有界 + 一次性失败 + 快照重连」。

### 3. 官方没有告诉我们的一件事：**单连接队头阻塞**

`RemoteStreamMuxConnection.writes` 是**每 WebSocket 一条链**（`stream-server.js:102`），所有逻辑流共用。一个终端狂吐字节，会阻塞**同一浏览器连接上其它所有 Typert 流**。这是 spike 必须量的一个风险面（见下）。

---

## 第三方可复用性判定

### A. Typert 到底是什么

**Typert = dsh 的 Host↔Client 类型化 RPC 与多路复用流机制**（"Remote 调用"）。三个面：

| 面 | 产物 | 导出约定 | 注册方 | 消费者 |
|---|---|---|---|---|
| **Host face** | `TYPERT`（`face:'host'`，含 `invocations[]` + FaceModel） | `package.json` → `exports["./typert"]` | `dsh-typert-loader` 自动扫 Loader entry，或 `ctx.typert.register(manifest)` | `TypertGatewayService` |
| **Remote-client face** | `TYPERT_REMOTE`（含 `descriptors[]`） | `package.json` → `exports["./remote"]` | **无自动加载器**：由 `dsh-api-remotes` 手工 import + `ctx.remote.$mount()` | `ClientRemoteService` |
| **Runtime registry** | `ctx.typert` 服务 | — | `dsh-typert-registry` | 上面两者 |

证据：

```sh
sed -n '39,46p;56,67p;237,269p;296,307p' BASE/dsh-typert-loader/lib/index.js
# → TYPERT_HOST_EXPORT = "./typert"；resolveArtifact 读 exports["./typert"]；
#    processOne → ctx.typert.register(manifest)
sed -n '162,165p' M4/dsh-api-terminal-controller/lib/typert.host.js
# → export const TYPERT = { package, face: 'host', schemas, invocations, model }
sed -n '162,163p;605p' M4/dsh-api-terminal-controller/lib/typert.remote-client.js
# → export const TYPERT_REMOTE = {...}; export default TYPERT_REMOTE
```

**传输**：unary 走 `connection.rpc.call('/api', endpoint, {args})`（`$BASE/dsh-api-gateway/lib/types/client/index.js:278`）；
stream 走 `connection.rpc.open?.('/api', ...)`，否则回落到**单条多路复用 WS** `/api/remote.mux`（`$BASE/dsh-api-gateway/lib/client.js:1650-1656`、`stream-protocol.js:4`）。

**Host 半与 Client 半各自需要什么（最小集）**

- **Host 半**（任选其一）：
  1. **源码模式（SRC）—— 不需要生成器**：Service 继承 `TypertRemoteService`（或调 `bindTypertRemote()`）→ 得到 `typertRemote` 绑定；方法加 `@Remote` / `@Remote({mode:'stream'})`（`TypertRemoteService` 在 `M4/dsh-typert-protocol/lib/index.js:159-172`；`Remote` 在 `:183-194`；`remoteMethods` 在 `:223-227`）。
     网关会在**没有 strict descriptor 时**自动走 SRC 回退：`$BASE/dsh-api-gateway/lib/index.js:989-993`（`resolveDescriptor`）→ `:995-1066`（`resolveSrcDescriptor`）。
     SRC 的参数 wire 名 = **方法形参名**，codec `{mode:'src-json'}`，`result: {mode:'src-json'}`（`:1030`、`:1064`），并且**参数不能解构/默认值/rest**（`:1486` 抛 `gateway/signature-invalid`）。
  2. strict 生成物：`exports["./typert"]` + Loader 自动挂载。
- **Client 半**：**只能 strict** —— `$mount` 会校验每个 parameter/uplink/context codec 必须 `mode === 'strict'`
  （`$BASE/dsh-api-gateway/lib/client.js:2067-2075`）。没有客户端 SRC 回退（客户端命名空间是**按 descriptor 逐个方法安装成 Service 的真实属性**，不是 Proxy，见 `:1572-1575`）。

### B. 判定表：三种"复用"分别能不能做

| 想做 | 判定 | 证据 / 理由 |
|---|---|---|
| 复用官方 `terminal` 命名空间，把字节塞进去 | ❌ **不能** | `terminal/*` 的方法集与 `TerminalFrame` 是**终端专用**：`$M4/dsh-api-terminal-controller/lib/typert.host.js:613-686` 固定 10 个方法；`create` 只接受 `shellPath`（走 `subprocess.resolveExecutable`），`write` 是 unary，`follow` 的 result codec 是固定 union。没有任何"注入自定义 PTY/通道"的扩展点。 |
| 复用 Typert **通用**能力，开自己的命名空间（如 `atssh`） | ✅ **能** | Host：SRC 回退，无需生成器（`$BASE/dsh-api-gateway/lib/index.js:989-1066`）。Client：自己写 `TYPERT_REMOTE` 形状的 strict 贡献并 `ctx.remote.$mount(contribution)`（`$BASE/dsh-api-gateway/lib/client.js:1636-1646` 是公开 API；`$BASE/dsh-api-remotes/lib/types/client/index.js:42` 就是官方自己的用法）。 |
| 复用 Typert 的**流管道**（`$stream` / mux / 自动重连 / generation / ack） | ✅ **能，且这是最有价值的一层** | `ctx.remote.$stream({ name, open, ended, carrierFailed })` 是**契约化公开 API**（`$BASE/dsh-api-gateway/lib/client.js:1625-1627`，类型 `RemoteStream` 在 `lib/types/client/index.js:13`）。`open` 可以是**任意 async generator**，官方自己就用它包了一个非 Remote 的 `retain` 握手（`dsh-api-terminal-controller/lib/client.js:231-247`）。重连/去重/取消由 `RemoteStream.read()` 统一处理（`remote-stream.js:68-145`）。 |
| 自己开 WS/SSE 路由 | ✅ **能（备选）** | `ctx.webServer.registerUpgrade({path, handler})` / `register({kind:'exact', path, handler})`（`$BASE/dsh-host-webserver/lib/index.js:177-195`）。本项目 `dsh/channel.js:38-44` 已经注册了 `/dsh-at-terminal/ws` 等 5 条路由。**代价**：自己实现重连、背压、鉴权、peer 绑定，且脱离 dsh 的 connection 生命周期。 |

### C. 结论：**建议走"B. 自有命名空间 + 复用 Typert 流管道"**

对"不替换官方 `terminal` kind、用 ssh2 驱动自己的 xterm 面板"这个目标：

- **有公开 seam**：`ctx.remote.$mount()` + `ctx.remote.$stream()` + `ctx.typert.register()` / `TypertRemoteService` + `@Remote`。
- **官方通道是终端专用的**，但**底下的 Typert 是通用的**；所以不是"第三方只能自己另开一条"，而是"第三方可以复用同一条管道，换一层自己的帧协议"。
- **必须自己写的两样东西**：
  1. Host 半：一个 `TypertRemoteService` 子类，持 ssh2 会话，把 `session.on('data')` 变成 `@Remote({mode:'stream'})` 的 downlink；暴露 `write`/`resize`/`close` 等 unary。
  2. Client 半：自己的 client 插件 → `ctx.remote.$mount(<自己的 TYPERT_REMOTE>)` + 自己的 xterm 面板（可照抄 `client.terminal.js:13442-13454` 的 `xterm.write + acknowledge` 模式）。
- **`package.json` 需要声明什么**：
  ```jsonc
  {
    "exports": {
      "./client": "./client.js",          // 浏览器 bundle（必需，dsh.client 依赖它）
      "./typert": "./lib/typert.host.js", // Host face（若走 Loader 自动注册）
      "./remote": "./lib/typert.remote-client.js" // Remote-client face（自己 import）
    },
    "dsh": {
      "client": {
        "platform": "web",
        "inject": ["@deepseek-ai/dsh-api-gateway"],  // 或你的宿主包名
        "external": ["@deepseek-ai/dsh-api-gateway/client"]
      }
    }
  }
  ```
  依据：`$BASE/dsh-api-terminal-controller/package.json`（`exports` 四键 + `dsh.client.inject/external/platform`）、`$BASE/dsh-client-modules/README.md:30-34`
  （`platform:'web'` + `./client` + `external` 的规则）、`$BASE/dsh-api-gateway/lib/client.js:2040-2041`（`remoteServiceKey = 'remote.' + namespace`，所以客户端注入名是 `remote.atssh`）。

> ⚠️ **一个必须先确认的前提**：`dsh-typert-generator` **在宿主里不存在**（`find` 无结果）。
> 意味着 strict 双侧生成物**只能手写**。Host 可以靠 SRC 回退省掉；Client **省不掉**（`$mount` 强制 strict）。
> 手写 strict codec 只需要 zod 工厂 + `typeSymbol` 字符串，**不需要 `.d.ts`** —— 但这是本方案的主要工程量与主要出错点。

---

## spike 可测点

### 1. 测什么（三个独立问题，别混在一个实验里）

| # | 问题 | 做法 | 单位 |
|---|---|---|---|
| **S1** | Host→Client 单向吞吐上限（管道本身有多快） | Host 侧生成确定性字节流（可复用 `dsh/channel.js` 的 `buildChunk(seq, payloadBytes, chunkSize)` + CRC），经 `follow` 类流方法下发；浏览器用**哑消费者**（不渲染，只 `acknowledge`） | **MB/s**、**帧/s** |
| **S2** | 真 xterm 渲染能否跟上（端到端） | 同上，但消费者换成真 xterm（`TerminalScreen`） | MB/s、**ack RTT (ms)**、掉线次数 |
| **S3** | 慢消费者触发溢出的**确切阈值**与**恢复行为** | 人工延迟 ack（客户端加 `setTimeout(ack, Xms)`），扫 X；记录 follower 被杀的时刻与重连快照恢复耗时 | **阈值字节数**、恢复时延 (ms) |

### 2. 在哪一层插计数器（**逐层**，否则归因不了）

| 层 | 插桩点（对照本文行号） | 计什么 |
|---|---|---|
| L1 | Host：`LocalTerminalHandle` 的 `terminal.pause()` 调用次数 / `'drain'` 次数 | **PTY 暂停次数**（源端是否被迫降速） |
| L2 | Host：`BrowserTerminal.output()` 的 `screen.write` 回调耗时 | **headless xterm 解析耗时**（Host 侧 CPU 天花板） |
| L3 | Host：`TerminalFollower` 的 `this.bytes` 采样（`stream.js:30`） | **follower 队列水位曲线** + **溢出事件计数** |
| L4 | Gateway：`pump()` 循环计数 + `this.writes` 链长度；Host 事件循环 lag | **mux 串行化延迟**、队头阻塞 |
| L5 | Client：`acknowledge(revision)` 与 `patch({render})` 的时间差 | **ack RTT**、xterm 渲染耗时 |
| 端到端 | 每帧埋 `seq` + 发送时间戳 | **端到端延迟分位数 p50/p95/p99** |

单位约定：字节用 **UTF-8 字节**（与官方 `Buffer.byteLength(JSON.stringify(frame))` 一致，`stream.js:23` —— 注意官方算的是**含 JSON 转义开销**的字节，不是裸 payload，所以 `binary:true` 与否会显著改变有效载荷率，**必须测**）；时间用 **ms**；吞吐用 **MB/s**。

### 3. 我认为最关键的两个数字

1. **`maxBufferedBytes` = 2 097 152 (2 MiB)** —— `$BASE/dsh-api-terminal-controller/lib/index.js:745`。
   这是整条链路上**唯一的硬阈值**，也是**"能用/不能用"的分界**：超过它 follower 直接被杀。
   对 SSH 场景的含义：`cat` 一个大文件、或 `top`/`dmesg -w` 这类持续输出，只要客户端 ack 循环跟不上，就会命中这条线并被断开。
   **spike 必须量出：在目标帧大小下，客户端 ack 的可持续速率（MB/s），以及它与 2 MiB 的安全裕度。**

2. **PTY `PassThrough` 的 highWaterMark = 16 384 (16 KiB)** —— `$BASE/dsh-subprocess-local/lib/index.js:750`（Node 默认值，代码未覆盖）。
   这是**源端唯一能真正"刹车"的地方**：只有它会把 `node-pty` 暂停，其余各层都只是"少拉一点"或"直接断"。
   16 KiB 相对 2 MiB 是 **128×** 的差距 —— 说明这套设计**赌的是"下游总能跟上"**，缓冲只是兜底。
   **spike 必须量出：`drain` → `resume` 的实际往返延迟，以及它是否成为吞吐上限的决定项。**

（这两个数字的比值 2 MiB / 16 KiB = 128，本身就是一张诊断表：如果实测吞吐远低于理论值，问题几乎一定在 **L5 的 ack RTT**，而不是缓冲区大小。）

### 4. 复验命令

```sh
BASE=dsh/.cache/base-recon/node_modules/@deepseek-ai

# 两个关键常量
sed -n '741,751p' $BASE/dsh-api-terminal-controller/lib/index.js   # Config: maxBufferedBytes=2*1024*1024
sed -n '750p'      $BASE/dsh-subprocess-local/lib/index.js          # output = new PassThrough()
sed -n '551,552p'  $BASE/dsh-api-gateway/lib/index.js               # DEFAULT_STREAM_INBOX_BYTES=262144

# 溢出即断流（不是降速）
sed -n '20,32p' $BASE/dsh-api-terminal-controller/lib/types/stream.js

# 客户端 ack 闸门
sed -n '405,426p' $BASE/dsh-api-terminal-controller/lib/client.js
sed -n '13451,13453p' $BASE/dsh-client-ui-sidebar-terminal/lib/client.terminal.js

# 源端 PTY 暂停/恢复
sed -n '787,801p' $BASE/dsh-subprocess-local/lib/index.js
```

---

## 未确定项

以下是我**没有**证实的，明确列为不确定，不要当成结论使用：

1. **`maxBufferedBytes` 在真实 SSH 场景下的裕度**：2 MiB 是 Host 侧终端的默认值，但我们的 SSH 面板是否需要调整、SSH 链路的 RTT 是否会把 ack 周期拉长到必然溢出 —— **未测**。这是 DSH-25 的核心待验证项。
2. **client→Host 的 uplink（`RemoteStreamHandle.send`）在 SRC 回退下能否工作**：
   `srcDescriptor()`（`$BASE/dsh-api-gateway/lib/index.js:1014-1066`）**不产出 `uplink` 字段**；官方 `follow` 也没有 `In` 泛型（用 unary `write` 代替）。
   结论：**SRC + uplink 的组合未验证**，建议 spike 避开（照官方用 downlink + unary write）。
3. **浏览器 → Host 的 origin/CORS 可达性**：本项目 `dsh/client.js` 的探针注释已指出 Desktop shell 的 UI origin 与 `ctx.webServer` origin 可能不同。Typert 的 `/api/remote.mux` 是**同 WS 宿主**提供的，但 `connection` 服务如何构造 base URL（`$BASE/dsh-client-connection`）**未通读**，所以"我们的 `$mount`/`$stream` 在 Desktop shell 里能否连上"**未验证** —— 这是**前置阻塞项**，应当排在性能 spike 之前。
4. **鉴权/Peer 绑定语义**：mux 在 upgrade 时绑定 `Peer`（`$BASE/dsh-api-gateway/lib/types/stream-server.js:38-55, 359-367`）。第三方自己的 `$mount` 流是否自动获得同样的 Peer 绑定与鉴权，**未确认**。
5. **手写 strict `TYPERT_REMOTE` 的可行性边界**：`validateContribution` 只校验 codec 形状与重复（`$BASE/dsh-api-gateway/lib/client.js:1684-1698`），看起来**结构上可手写**；
   但 Host/Client 两侧的 JSON 形状是否必须"逐字段对齐生成器的产物"（尤其 `Uint8Array` 结果需要 `encode/decode`，见 `$M4/dsh-typert-protocol/README.md:47`），**未验证**。
6. **版本风险**：本文的行号对 `dsh-api-terminal-controller` 的 0.1.7-rc.2 与 0.2.0-rc.1 都成立（已用 md5 对齐），
   但 `$BASE/dsh-api-gateway` 只有 0.1.7-rc.2 一份，且**桌面版 `app.asar` 的实际字节未直接核对过**（只有两个 `.cache` 提取结果）。
   上线前应在真实 `app.asar` 上重跑本文的复验命令。
7. **`typert.host.js` 的两版差异**仅为 FaceModel 的 `SessionEventMap` 文档字符串（4 行 diff），
   **不代表**其它包（如 `dsh-api-gateway`）在两个版本间也无差异 —— 那些包只有一个版本可比，无法判断。

### 复验版本一致性的命令

```sh
cd dsh/.cache
BASE=base-recon/node_modules/@deepseek-ai; M4=m4-recon/node_modules/@deepseek-ai
md5 $BASE/dsh-api-terminal-controller/lib/index.js $M4/dsh-api-terminal-controller/lib/index.js
md5 $BASE/dsh-api-terminal-controller/lib/types/stream.js $M4/dsh-api-terminal-controller/lib/types/stream.js
diff $BASE/dsh-api-terminal-controller/lib/typert.host.js $M4/dsh-api-terminal-controller/lib/typert.host.js | wc -l
# → 4（仅 SessionEventMap 声明字符串）
```
