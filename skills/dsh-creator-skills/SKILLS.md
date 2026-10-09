# 创造模式技能索引

4 个 skill、17 个文件，全部位于 `skills/` 下，可原样作为 `customSkillDirs` 使用。

## 一、四个 skill

| # | Skill | 体量 | 何时触发（官方 description 精译） |
|---|---|---|---|
| 1 | **`cordis-plugin-development`** | 8,144 字符 | 设计 / 评审 / 新增 / 启用 / 禁用 / 安装 / 配置 / 调试当前 Harness profile 里的**插件、bundle、功能、页面、面板、工具、MCP 连接**时；也包括默认关闭的出货插件。**以及任何"没有指明其他去向"的视觉对象 / 装饰 / 组件请求**——那意味着一个装在 Harness Web UI 里、需要渲染的 UI 插件。 |
| 2 | **`editing-cordis-compositions`** | 5,739 字符 | 创建 / 修改 / 校验本 harness 的 **agent preset 或其他 Cordis composition** 时。含：判断该放 host 侧还是 preset 侧、以及检查自建 preset 能否成功挂载。 |
| 3 | **`cordis-composition-reference`** | 2,806 字符 | 读或写 Cordis bundle patch / agent preset，且需要查 **Loader YAML 方言**（`insert` / 按 id `override` / `group` / `disabled` / `isolate` / `!!js`）或**可安装插件包清单**（每个包提供什么）时。 |
| 4 | **`agent-experience`** | 2,091 字符 | 编写或改动**模型可见的工具定义**（name、description、参数 schema、或其系统提示词段落）时；以及设计 skill、上下文加载、多步工作流时——目标是让信息可被发现、并高效使用上下文。 |

> 这四个 description 就是模型在会话里能看到的**全部**内容（经 `<available_skills>` 注入）。
> 正文只在模型主动调 `skill` 工具时才加载——这是官方刻意的**渐进式披露**：往系统提示里塞创造模式说明每轮都要付费，而 skill 目录本身已能按需路由。
> 硬约束：单个 SKILL.md 正文必须 ≤ **8192 字符**，因为标准 preset 的 `tool-result-pruner` 阈值就是 8192（`headChars: 4096` / `tailChars: 1024`），超了会被裁剪。`cordis-plugin-development` 原本 8.7KB 超限，官方才把配方拆进 `references/`（6 份）与 `templates/`（decoration 4 文件 + mcp 2 文件）。

## 二、附属文件

```
skills/
├── agent-experience/SKILL.md                                   2,091
├── cordis-composition-reference/
│   ├── SKILL.md                                               2,806
│   └── references/packages.md                                38,768   ← 可装载插件包全清单（体量最大）
├── cordis-plugin-development/
│   ├── SKILL.md                                               8,144
│   ├── references/
│   │   ├── host-plugin.md                                     3,280   ← Host 侧插件
│   │   ├── ui-plugin.md                                       1,992   ← UI 侧插件（Web UI 渲染）
│   │   ├── mcp-bundle.md                                        984   ← MCP 连接打包
│   │   ├── practices.md                                       7,631   ← 最佳实践（第二大体量）
│   │   ├── user-actions.md                                    1,375   ← 需要用户操作时的交互
│   │   └── verification.md                                      954   ← 自检清单
│   └── templates/
│       ├── decoration/{package.json,cordis.patch.yml,index.js,client.js}
│       └── mcp/{package.json,cordis.patch.yml}
└── editing-cordis-compositions/SKILL.md                       5,739
```

## 三、四个 skill 之间的关系

```
              ┌──────────────────────────────────────┐
   入口 →     │  cordis-plugin-development           │  主流程（写插件）
              │  · 设计/评审 · 启用出货插件          │
              │  · 交付可运行插件 5 步 · 知识来源顺序 │
              └───────┬──────────────────┬───────────┘
                      │ 需要落盘成 preset │ 需要查方言/包
                      ▼                  ▼
   ┌──────────────────────────┐  ┌──────────────────────────────┐
   │ editing-cordis-          │  │ cordis-composition-reference │
   │ compositions             │  │ · Loader patch 方言          │
   │ · host vs preset 放置    │  │ · 可装载插件包清单           │
   │ · 新建/覆盖/迁移 preset  │  └──────────────────────────────┘
   │ · 挂载校验               │
   └──────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────────┐
   │ agent-experience    横切：怎么写好工具定义/skill │
   │                     怎么用上下文、怎么设计工作流 │
   └──────────────────────────────────────────────────┘
```

## 四、阅读顺序建议

1. `cordis-plugin-development/SKILL.md` —— 先看主流程，知道整体怎么走
2. `editing-cordis-compositions/SKILL.md` —— 知道改动最终要落成什么形态
3. `cordis-composition-reference/SKILL.md` + `references/packages.md` —— 查方言与可用包
4. `agent-experience/SKILL.md` —— 收尾：怎么写才让模型看得懂

一次性通读见同目录 `ALL-SKILLS.md`（79,062 字符，已按上述顺序拼接并加目录锚点）。
