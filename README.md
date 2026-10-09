# AT Terminal (DSH)

DeepSeek Harness (DSH) 原生 SSH 终端与 SFTP 远程文件管理插件。

---

## 概述

**AT Terminal (DSH)** 是为 DeepSeek Harness 深度适配的终端扩展。它直接运行在 Harness 的 Cordis 运行时环境中，提供全功能的 SSH 终端连接、SFTP 目录浏览/文件编辑，以及与 DSH AI Agent 无缝集成的直连运维工具集。

### 核心特性

1. **DSH 原生直连 Agent 工具**
   - 不再依赖外部跨进程 MCP Server，直接通过 DSH 原生 `dsh-tools`（Cordis `ctx.tools`）注册 12 个运维工具。
   - 工具调用链原生对接 DSH `ctx.approval` 审批流、`exec.signal` 任务取消信号和 `output.render` 格式化渲染。
2. **三级命令安全评估体系**
   - 包含命令安全策略评估器（基于 `@at-series/command-policy`），支持白名单模式、交互确认、危险阻断。
   - 细粒度信任级别：`untrusted`（完全不信任）、`policy`（策略评估）、`trusted`（完全信任）。
   - 严格阻断高危提权/破坏性命令，破坏性命令弹窗醒目标注警告。
3. **内置 xterm 终端渲染与多会话管理**
   - 基于 `@xterm/xterm` 5.5 提供原生 WebGL 加速渲染、语义高亮、斑马纹模式、自动重连。
   - 支持多服务器配置与多标签并发终端会话。
4. **轻量与纯净**
   - 已彻底剥离 VS Code 相关依赖与适配代码，结构纯粹，启动开销小。

---

## 项目结构

```text
at-terminal-dsh/
├── dsh/                      # DSH 插件规范实现
│   ├── index.js              # Cordis 插件入口（注册 service、tools、client 资源）
│   ├── client.js             # DSH 客户端 bundle（基于 xterm 的前端渲染）
│   ├── host.bundle.js        # DSH 宿主 bundle（聚合核心 SSH/SFTP/Policy 逻辑）
│   ├── tools.js              # 12 个 Agent 原生直连运维工具定义
│   ├── cordis.patch.yml      # Cordis bundle patch 配置
│   ├── esbuild.dsh.mjs       # 打包构建脚本
│   └── scripts/verify.mjs    # DSH 规范契约校验脚本
├── src/                      # 核心领域逻辑与 DSH 平台适配层
│   ├── agent/                # Agent 服务、命令策略评估、SFTP 授权
│   ├── assets/               # 资产管理、加密存储与导出导入
│   ├── config/               # 配置管理与 Schema 验证
│   ├── platform/dsh/         # DSH 运行时适配实现（Approval、State、Credentials 等）
│   ├── sftp/                 # SFTP 协议会话与文件传输
│   ├── ssh/                  # SSH 会话、HostKey 验证与端口转发
│   └── terminal/             # 终端会话上下文与设置
├── skills/                   # DSH 创造套件与运维技能
│   ├── agent-experience/
│   ├── cordis-composition-reference/
│   ├── cordis-plugin-development/
│   ├── dsh-creator-skills/
│   ├── editing-cordis-compositions/
│   └── writing-ops-documents/
├── test/                     # 自动化单测与契约测试（Vitest）
└── webview/terminal/         # 终端前端基础样式与交互逻辑
```

---

## Agent 工具列表（直连 DSH）

插件提供 12 个面向 DSH Agent 的工具：

| 工具名称 | 功能描述 |
| :--- | :--- |
| `at_terminal_ping` | 检查插件状态、加载就绪状态、版本及生效设置 |
| `at_terminal_list_ssh_servers` | 获取已配置的 SSH 服务器列表与在线状态 |
| `at_terminal_get_terminal_context` | 获取当前活动聚焦的终端上下文信息 |
| `at_terminal_run_remote_command` | 在目标或活动服务器上执行远程命令（支持策略拦截与审批） |
| `at_terminal_sftp_list_directory` | 列出远程 SFTP 目录内容与文件元数据 |
| `at_terminal_sftp_read_file` | 读取远程文件内容（支持偏移量与上限截断） |
| `at_terminal_sftp_write_file` | 写入或追加远程文件（受写策略及审批保护） |
| `at_terminal_sftp_stat_path` | 获取远程文件或目录详细属性与权限 |
| `at_terminal_sftp_create_directory`| 创建远程多级目录 |
| `at_terminal_sftp_delete` | 删除远程文件或目录（受写策略及审批保护） |
| `at_terminal_sftp_rename` | 远程文件或目录移动与重命名 |
| `at_terminal_sftp_copy` | 远程文件或目录拷贝 |

---

## 常用脚本与命令

```bash
# 构建宿主与客户端产物 (dsh/host.bundle.js, dsh/client.js)
npm run build

# DSH 规范契约校验 (9 项自动化合规规则)
npm run verify:dsh

# 运行全量自动化测试套件 (Vitest)
npm run test

# 执行 TypeScript 静态类型检查
npm run typecheck
```

---

## 技能支持

项目内集成了 DSH 官方与创作者相关的技能套件（位于 `skills/` 目录）：
- `dsh-creator-skills`：DeepSeek Harness 创造模式全景指南与入口
- `cordis-plugin-development`：Cordis 插件与 UI 面板开发规范
- `cordis-composition-reference`：Cordis 组合方言与 Harness 模块参考
- `editing-cordis-compositions`：Preset 与组合配置编排
- `agent-experience`：Agent 工具设计与发现性规范
- `writing-ops-documents`：标准化运维记录与 RCA 报告编写指南
