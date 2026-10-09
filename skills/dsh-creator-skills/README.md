# DeepSeek Harness · 创造模式技能完整包

从本机安装的 DeepSeek Harness 里**完整取出**的创造模式（preset id = `cordis`）技能集：
**4 个 skill / 17 个文件**，全部原文，未做任何删改。

## 已校验：三方逐字节一致

| 来源 | 版本 / 引用 | 结果 |
|---|---|---|
| 本机运行时 | `/Applications/DeepSeek Harness.app` → `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/` | **0.2.0-rc.2** |
| 上游仓库 | `deepseek-ai/deepseek-harness@master` → `packages/preset/agent-preset/skills/` | master HEAD |
| 导出物 | 本目录 `skills/` | — |

对全部 17 个文件做 SHA-256 比对：**17/17 完全一致**。逐文件哈希见 `manifest.txt`。

## 边界说明：什么算"创造模式的 skill"

创造模式通过 `skill-filesystem` 插件的 `customSkillDirs` 只额外挂载一个目录：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(
            process.getBuiltinModule('node:path').dirname(
              process.getBuiltinModule('node:module').createRequire(baseUrl)
                .resolve('@deepseek-ai/dsh-agent-preset/package.json')),
            'skills')
```

即 `@deepseek-ai/dsh-agent-preset/skills/` —— 就是本目录的 `skills/`。

**不包含**（属于其他包，不挂进 cordis preset）：

| 包 | 内容 | 说明 |
|---|---|---|
| `dsh-skill-office` | `assets/{office-docx,office-pptx,office-xlsx}/SKILL.md` | 办公文档技能，独立包，cordis preset 未引用 |
| `dsh-skill-badge` | `assets/dsh-badge.md` | 徽章资源 |
| `dsh-sandbox-windows-acl` | `assets/diagnose-windows-sandbox-acl/` | Windows ACL 诊断（含 45KB ps1 脚本） |

另外，创造模式运行时还会扫用户 / 项目自建目录（见下节），那些是**你本地的 skill**，不属于"官方创造模式技能集"。

## 技能目录扫描顺序（源码实测常量）

来自 `@deepseek-ai/dsh-skill-filesystem` 的 `skill-filesystem.ts`，rank 数值越小优先级越高：

| 顺序 | 路径 | source | rank |
|---|---|---|---|
| 1 | `{项目根}/.dsh/skills` | `project-dsh` | 100 |
| 2 | `{项目根}/.agents/skills` | `project-agents` | 200 |
| 3 | **`@deepseek-ai/dsh-agent-preset/skills`**（创造模式挂载点） | `custom` | **300** |
| 4 | `~/.dsh/skills`（`$DSH_HOME`，`skipSystem: true`） | `user-dsh` | 400 |
| 5 | `~/.agents/skills`（`$DSH_AGENTS_HOME`） | `user-agents` | 500 |
| 6 | `$DSH_BUNDLED_SKILL_DIR` | `bundled` | 末尾 |

两个有用的推论：

- 想让自己写的 skill **在所有 preset 里都生效**，放 `~/.dsh/skills/`。但若与内置的 4 个 skill **同名**，创造模式下内置版（rank 300）仍会压过它（rank 400）——要覆盖就得放项目根 `.dsh/skills/`（rank 100），或改 preset。
- 创造模式里那份内置副本**不可写**（在 `app.asar` 内），要改只能覆盖或另起名字。

## 怎么用

**A. 只想读**：翻 `ALL-SKILLS.md`（全部 17 个文件拼成一份，带目录锚点），或 `SKILLS.md`（索引 + 关系图）。

**B. 想直接当 `customSkillDirs` 用**：把 `skills/` 整个目录指过去即可，结构原样兼容。

**C. 想挂到你自己的 DSH（任意 preset 可用）**：

```bash
mkdir -p ~/.dsh/skills
cp -R skills/* ~/.dsh/skills/
```

> 注意上节的同名优先级：创造模式里内置副本仍会胜出。若要强制用自己这份，改放项目根的 `.dsh/skills/`。

## 目录结构

```
dsh-creator-skills/
├── README.md              ← 本文件
├── SKILLS.md              ← 索引：4 个 skill 的触发场景、体量、关系图
├── ALL-SKILLS.md          ← 17 个文件全文合集（79,062 字符）
├── manifest.txt           ← 逐文件 bytes / chars / SHA-256（前 16 位）
├── skills/                ← 原始树，可原样使用（17 文件）
│   ├── agent-experience/
│   ├── cordis-composition-reference/{SKILL.md, references/packages.md}
│   ├── cordis-plugin-development/{SKILL.md, references/*6, templates/*6}
│   └── editing-cordis-compositions/
├── mount/cordis.patch.yml ← 定义挂载点的 preset 原文（创造模式全量配置）
└── verify/
    ├── check.sh           ← 一致性校验（可执行，零依赖）
    └── extract-asar.js    ← 零依赖 asar 提取器
```

## 复现校验

已内置可直接运行的脚本（不依赖外部 npm 包，自带 asar 解析器）：

```bash
./verify/check.sh
```

实测输出：

```
app version : 0.2.0-rc.2
asar        : /Applications/DeepSeek Harness.app/Contents/Resources/app.asar
  IDENTICAL agent-experience/SKILL.md
  ... (共 17 行)
PASS: 17/17 文件与本机运行时逐字节一致
```

环境变量可覆盖：`DSH_APP`（app 路径）、`NODE_BIN`（node 可执行文件）。

### 附带：asar 解析器

DSH 桌面版没有 `asar` CLI，`verify/extract-asar.js` 是一个零依赖的提取器，可抽出 `app.asar` 内任意子树：

```bash
node verify/extract-asar.js \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" \
  "dsh/node_modules/@deepseek-ai/" /tmp/dsh_mods
```

## 版本说明

本机桌面版为 **0.2.0-rc.2**（此前记录为 0.1.7-rc.2，已升级）。0.2.0 新增了 `dsh-agent-preset-registry` 包（preset 注册表，含 `composition-inventory` 等类型定义），但 `agent-preset/skills/` 的 17 个文件与上游 `master` **一字未变**。

仓库 `master` 可能比本机产物新；两者冲突时**以本机 `app.asar` 内产物为准**。
