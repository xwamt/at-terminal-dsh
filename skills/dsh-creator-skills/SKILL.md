---
name: dsh-creator-skills
description: DeepSeek Harness (DSH) 创造模式（preset id = cordis）官方技能套件总览与入口。当涉及 DeepSeek Harness 的插件体系、Cordis 组合/preset 配置、Loader YAML 方言、UI 装饰/面板扩展、MCP 打包、以及 Agent 体验与工具定义规范时使用。
---

# DeepSeek Harness · 创造模式技能套件

本套件提取自 DeepSeek Harness 官方创造模式（preset id = `cordis`），包含 4 个核心技能及其配套参考规范与模板：

## 核心子技能

1. **[`cordis-plugin-development`](file:///Users/clkj/.gemini/config/skills/cordis-plugin-development/SKILL.md)**:
   - 设计、评审、新增、启用、禁用、安装、配置或调试 Harness profile 插件（Host 侧与 UI 侧）。
   - Web UI 装饰组件、面板、工具、MCP 连接打包装载。

2. **[`editing-cordis-compositions`](file:///Users/clkj/.gemini/config/skills/editing-cordis-compositions/SKILL.md)**:
   - 创建、修改、校验 Agent preset (`preset-<id>`) 或 Cordis composition。
   - 确定插件配置应置于 Host 侧还是 Preset 侧，校验自建 preset 挂载情况。

3. **[`cordis-composition-reference`](file:///Users/clkj/.gemini/config/skills/cordis-composition-reference/SKILL.md)**:
   - 查阅 Cordis Loader YAML 方言规范（`insert`, `override`, `group`, `disabled`, `isolate`, `!!js`）。
   - 查阅 DSH 可装载插件清单 [`packages.md`](file:///Users/clkj/.gemini/config/skills/cordis-composition-reference/references/packages.md)。

4. **[`agent-experience`](file:///Users/clkj/.gemini/config/skills/agent-experience/SKILL.md)**:
   - 编写与优化模型可见的工具定义（Tool definition: name, description, parameters schema, prompt rules）。
   - 规范 Agent Skill 设计、上下文加载（渐进式披露）与多步工作流。

## 参考资料与索引

- [技能详细索引与关系图](file:///Users/clkj/.gemini/config/skills/dsh-creator-skills/SKILLS.md)
- [套件 README 与版本说明](file:///Users/clkj/.gemini/config/skills/dsh-creator-skills/README.md)
- [17 个文件全量合集](file:///Users/clkj/.gemini/config/skills/dsh-creator-skills/ALL-SKILLS.md)
