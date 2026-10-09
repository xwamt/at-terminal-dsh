# DSH 右侧栏插件注册契约（只读取证）

- 日期：2026-09-29
- 宿主：DeepSeek Harness Desktop `0.1.7-rc.2`（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`）
- 取证对象：`@deepseek-ai/dsh-client-ui-sidebar-right@0.2.0-rc.1`（+ `-terminal` / `-files` / `-slots` / `-renderer`）
- 代码位置：`dsh/.cache/m4-recon/node_modules/@deepseek-ai/<pkg>/`
- 方法：只读。官方包只发 `lib/*.js`（无 `.d.ts`，`exports.types` 指向未随包发布的路径），故全部结论来自打包后的 JS + README，均给出可复验行号。
- 本次额外从 `app.asar` 只读提取了 `dsh-client-ui-slots` 与 `dsh-client-ui-renderer` 到同一缓存目录（原提取清单里没有），用于确认 `ctx.slots` 的 `register`/`inject` 语义。

---

## 结论摘要

能直接用的签名（逐条证据见下一节）：

```ts
// 服务（ctx.reflect.provide 出来的两个实例，非单例对象字面量）
ctx.sidebarRightTabs : SidebarRightTabRegistry   // class 实例
ctx.sidebarRight     : SidebarRightController    // class 实例

// 阶段 1：注册 tab 类型。返回 disposer（幂等）。
ctx.sidebarRightTabs.register({
  id,                      // string，必填。全注册表唯一，等于正文/title slot 的 key。重复 → throw
  kind,                    // string，必填。同类 kind 的共存规则见下
  patterns?,               // string[]。仅资源类型需要（glob over dsh-resource:// 地址）
  priority?,               // 'extension' | 'builtin' | 'fallback'，默认 'extension'
  canOpen?,                // (address: string) => boolean，否决一次命中
  title,                   // (address: string) => string，必填，tab chip 文本，开 tab 时冻结
  guide?,                  // { id, order, title(), description?(), icon?, commandId? }[]
  keepMounted?,            // boolean，默认 false
  multiple?                // boolean，默认 false（计划文档漏了这个字段；官方 terminal 用它）
}) => () => void

// 阶段 2：挂正文（keyed slot，key 必须是 definition.id）。
// 必须包在 ctx.slots.inject(name, ...) 里：slot 由 sidebar-right 的 seat 声明，早于/晚于本插件都可能。
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Body))  // 返回 disposer
// Body 是 React 组件；props 由框架注入，含 useTabInfo() 钩子。

// 阶段 3：打开
ctx.sidebarRight.openTab(kind, options?)              // 页类型
ctx.sidebarRight.openResource(address, options?)      // dsh-resource:// 资源
// options: { paneId?, replaceTab?, revealIfOpened?, preferNewPane?, params?, kind? }

// 插件声明（本地 dsh/client.js 既有约定）
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale']  // 官方 terminal 是 ['slots','locale','sidebarRight','sidebarRightTabs','webTerminals','theme','shortcuts']
```

---

## 逐项取证

### 0. 包与服务的真实身份

- 主对象包：`dsh-client-ui-sidebar-right`，`lib/index.js` 是**空宿主半**（`function apply() {}`）——右侧栏**全部在浏览器侧** `lib/client.js`。复验：`Read dsh-client-ui-sidebar-right/lib/index.js`（6 行）。
- 服务提供方式（**不是** companion 包）：
  - `dsh-client-ui-sidebar-right/lib/client.js:9050-9051`
    ```js
    const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);
    const disposeService  = ctx.reflect.provide("sidebarRight", controller);
    ```
  - `client.js:8666` `var SidebarRightTabRegistry = class {...}`（registry 是 class 实例）
  - `client.js:6329` `var SidebarRightController = class {...}`（controller 是 class 实例）
  - README.md:159「这两个服务在同一个 effect 内经 `ctx.reflect.provide` 提供并随之拆除」。
- 所以 `ctx.sidebarRightTabs` **不是** `ctx.sidebarRight.tabs`，是**两个平级的独立服务**，两者都要进插件的 `inject` 数组。
- 复验命令：
  - `Read dsh/.cache/m4-recon/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`（offset 9049, limit 8）
  - 或用 Grep 工具搜 `reflect.provide`（路径同上）。

### 1. `ctx.sidebarRightTabs.register(...)`

`client.js:8691-8722` 是完整实现（逐字段核实）：

```js
register(definition) {
  const { id, kind } = definition;
  const entries = definition.guide ?? [];
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
      throw new Error(`sidebarRight: duplicate guide entry id in "${id}"`);      // 8694
  const band = definition.priority ?? DEFAULT_BAND;                              // 8695
  if (this.ids.has(id)) throw ... `tab type id "${id}" is already registered`;    // 8696
  const held = this.kinds.get(kind);
  if (held !== void 0 && !coexists(held, band)) throw ... `tab kind "${kind}" is already registered (${held.inForce.band})`;  // 8698
  this.registrations += 1;
  const entry = { definition, band,
    matchers: (definition.patterns ?? []).map((p) => ({ pattern: p, test: matcherFor(p) })),  // 8703
    order: this.registrations };
  const dispose = this.ctx.effect(() => { ... }, `sidebarRight.tabs.register(...)`);
  return () => { dispose(); };                                                  // 8719-8721
}
```

| 字段 | 类型 | 必填 | 默认 | 语义（证据） |
|---|---|---|---|---|
| `id` | string | **是** | — | 实现身份，全注册表唯一；**同时是正文/标题 slot 的 `key`**（README.md:83；`client.js:5583` `entryKey: definition?.id ?? tab.kind`）。重复 → throw（8696） |
| `kind` | string | **是** | — | tab 类型判别符；打开时用 `openTab(kind)` |
| `patterns` | string[] | 否 | `[]`（8703） | 资源 glob，只对 `dsh-resource://` 有意义。含 `:` → 匹配整个地址（`dsh-resource://file/**`）；不含 `:` → 匹配 URI path（`basename:true`，忽略大小写，`*.md`）；非 URI 地址一律不匹配。见 `matcherFor` `client.js:8647-8659` |
| `priority` | `'extension'\|'builtin'\|'fallback'` | 否 | `'extension'`（`DEFAULT_BAND`，`client.js:8626`） | 档位，`RANKS = { extension:3, builtin:2, fallback:1 }`（8620-8624） |
| `canOpen` | `(address)=>boolean` | 否 | — | 否决一次命中：rank 时过滤（8789），显式 `kind` 时仍生效（8817） |
| `title` | `(address)=>string` | **是**（运行期必调） | — | tab chip 文本，**开 tab 时捕获冻结**（`claim` 8821/8829；`placeTab` 6474；`defaultSeed` 591）。即使页类型也会被传 `sidebar://<kind>` |
| `guide` | entry[] | 否 | `[]` | 引导页入口框。entry 内 id 必须互不重复（8694）。字段见下 |
| `keepMounted` | boolean | 否 | `false` | 已访问正文跨 tab/会话/收起/停靠保留（`client.js:5554`；README.md:106） |
| `multiple` | boolean | 否 | `false` | **计划文档缺失的字段**。独立实例（如终端）：每次打开铸独立 contentId（`6470` `${pageAddress(kind)}/${randomUUID()}`；README.md:117） |

`guide` entry 字段（三处真实用法 + 渲染代码）：
- `id: string`（provider 内唯一）
- `order: number`（**实际必填**：`client.js:8849` 用 `left.order - right.order` 排序，缺省即 NaN）
- `title: () => string`（`client.js:483` `entry.title()`）
- `description?: () => string`（`client.js:462`；条目 >4 时全部丢弃，`MAX_DESCRIBED_ENTRIES=4` 行 458）
- `icon?: ReactComponent`（`client.js:461,474`，以 `<Icon size={22|26} className=.../>` 渲染）
- `commandId?: string`（`client.js:528`，只用于在卡片上显示快捷键提示）
- 证据用法：terminal `lib/client.js:444-450`；files `lib/client.js:28-35`。

**返回值**：`() => void` 幂等 disposer（8719-8721 的包裹；内层是 `ctx.effect` 的 disposer）。必须由调用方持有（常规做法是塞进自己的 `ctx.effect`），否则不会自动回收。

**重复注册同一 `id`**：**throw** `sidebarRight: tab type id "..." is already registered`（8696）。**不替换、不静默。**

**kind 撞名**：`coexists`（`client.js:8631-8632`）：
```js
return band !== "fallback" && slot.inForce.band !== "fallback" && slot.inForce.band !== band && slot.shadowed === void 0;
```
即：同一 kind 最多一份 `builtin` + 一份 `extension`（extension 生效，builtin 被 shadow，extension 卸载后 builtin 复活，`leave` 8741-8748）；`fallback` 不与任何档共存；同档第二份、或第三份 → throw（8698）。

**注册表读面**（注册时顺带提供的，便于复核）：`get(kind)` 8772、`entries()` 8757（引用稳定）、`guide()` 8764、`candidates(address)` 8783、`claim(address, kind?)` 8813、`active()` 8750、`subscribe(listener)` 8837。

### 2. 正文怎么挂：slot 名与 Body 签名

**slot 名确认**：`'sidebar.right.pane.tab'` **正确**。三处官方注册点：
- `dsh-client-ui-sidebar-terminal/lib/client.js:475-483`
- `dsh-client-ui-sidebar-files/lib/client.js:1002-1008`
- `dsh-client-ui-sidebar-right/lib/client.js:9173-9189`（官方 guide 自己）

**声明来源**（谁声明的 → 决定了 `inject` 的必要性）：`sidebar-right` 的 seat 注册 `rightbar.session` 时把子 slot 表声明为
```js
// client.js:9126-9144
yield ctx.slots.register({
  name: "rightbar.session", locale: NS,
  children: {
    "sidebar.right.pane.tab":       { kind: "keyed", scope: "session", inject: { hooks: { tabInfo: tabInfoFactory } } },
    "sidebar.right.pane.tab.title": { kind: "keyed", scope: "session", inject: { hooks: { tabInfo: tabInfoFactory } } },
    "sidebar.right.tab.menu.item":  { kind: "list",  scope: "session" }
  },
  store, inject: (sessionId) => ({...})
}, RightbarSeat);
```
所以 `sidebar.right.pane.tab` 是 **keyed / session 作用域**，且 seat **自带** `tabInfo` hook 注入 —— 这就是 `useTabInfo()` 的来源，扩展插件**不需要**自己声明 hook。

**`key` 的含义与取值**：keyed slot 的分派键，取 **tab 类型的 `definition.id`**（不是 `kind`）。
- 官方 terminal：`key: id`，`id = "@deepseek-ai/dsh-client-ui-sidebar-terminal"`（`terminal/lib/client.js:386, 439, 477`）
- 官方 files：`key: FILES_ID = "@deepseek-ai/dsh-client-ui-sidebar-files"`（`files/lib/client.js:16, 1004`）
- 官方 guide：`key: GUIDE_ID = "@deepseek-ai/dsh-client-ui-sidebar-right/guide"`（`sidebar-right/lib/client.js:8939, 9175`）
- 分派处：`client.js:5583` `entryKey: definition?.id ?? tab.kind`。
- 复验：README.md:83 末「`id` 同时也是该类型正文与标题注册时用的 key」。

**`register` 的确切形状**（来自 `dsh-client-ui-renderer`，它才是 `ctx.slots` 的实现方；`dsh-client-ui-slots` 是纯核心）：
```js
// dsh-client-ui-renderer/lib/client.js:1788-1791
SlotRegistry.prototype.register = function register(rawOptions, component) {
  const options = rawOptions;
  return this.ctx.effect(() => this["_register"](options, component), "slots.register()");
};
```
即 `ctx.slots.register(options, Component)`，返回 **Cordis effect disposer**（幂等）。
options 里被核心读取的键：`name`（必填）、`key`（keyed 必填）、`id`（list 必填）、`order`、`label`、`priority`、`select`（chain 必填）、`inject`、`children`、`store`、`locale`、`registrant`（`dsh-client-ui-slots/lib/index.js:163-219`）。
核心校验（`ui-slots/lib/index.js`）：
- 163-165 未声明的 slot → `slot "X" is not declared (a parent entry's children table must declare it)`
- 175-179 keyed：缺 `key` → `keyed slot "X" requires options.key`；同 key 同 priority 已占用 → `keyed slot "X" already has an entry for key "Y" at priority 0 — register at a different priority to shadow it (lowest renders)`
- 即：**同一 key 重复注册（同 priority）会 throw**；想在运行时替换同一 key 需用不同 priority 遮蔽（lower priority 渲染 — 注释原文 so）。

**为什么必须包 `ctx.slots.inject`**：`ctx.slots.inject(key, callback)` 的契约（`ui-renderer/lib/client.js:1343-1402`，JSDoc 1328-1342）：
> 申明已存在时同步执行 callback；否则等该 slot 被声明后、在声明方 `register()` 里执行。collapse 会 dispose 并允许后续重新声明时再跑一次。返回**幂等的 wait+active effect disposer**。callback 可返回单个 disposer，或**可迭代的 disposer 集合**（事务性安装、逆序拆除）。

所以「等 sidebar-right 的 seat 声明完 `sidebar.right.pane.tab` 再注册」这件事由 `inject` 负责，扩展插件不控制顺序也能挂上。若只用 `ctx.slots.register` 而 slot 尚未声明 → 直接 throw。

**`Body` 的签名**：React 组件函数，props 由框架按「五份 share」组装（`dsh-client-ui-slots/README.md:38`）：runtime share（`owner`、session standard kit、global seat）、child-render share（`renderSlot`）、factory share、store share、business share（由 `inject` 推出）。
对本 slot，关键注入物是 **`useTabInfo`**（seat 的 `children.inject.hooks.tabInfo`）。真实用例：
- `terminal/lib/client.js:173` `function LazyTerminalBody(props)`（props 全量透传）
- `terminal/lib/client.js:224` `function TerminalTitle({ useTabInfo, useTerminal, view, t })`
- `client.js:432` `function GuideTitle({ useTabInfo })`
- `client.js:506` `function GuideBody({ useTabInfo, useGuideEntries, renderSlot, renderSlotChain, useShortcuts })`

**`useTabInfo()` 返回值**（`client.js:8965-9002`，确切形状）：
```js
{
  sidebar: { expanded: boolean, fullscreen: boolean },
  panel:   { id: <paneId> },
  tab: {
    ...tabRecord,           // id, kind, contentId, title, ...
    visible: boolean,       // active && (float || expanded && (title-seat || pane.activeTabId === tabId))
    navigation,             // TabDomain occurrence 的导航（含 params / revision）
    signal,                 // AbortSignal：记录被移除或插件卸载时 abort
    actions,                // 绑定到本 Session + 本 tab 的动作面
    refreshShortcut
  }
}
```
- `client.js:8973` 未提交时会 throw `sidebarRight: tab "..." is not committed in session "..."` —— 所以只能在已提交的 body 内调用。
- `navigation.params` 来自 `openTab/openResource` 的 `options.params`（`place` 6493-6496；README.md:93）。
- 可选 `sidebar.right.pane.tab.title` 席位（key 同样 = `id`）用于**活的** chip 文本；不注册则用 `title(address)` 打开时冻结的文本（`client.js:5620-5626`）。
- `keepMounted` 的读点在 `client.js:5554`，且**只对 `sidebar.right.pane.tab` 生效**（title 席位不保留）。

**`ctx.slots` 来自哪个包**：服务名是 `slots`，实现方是 `@deepseek-ai/dsh-client-ui-renderer`（安装 `createSlotRenderer()` 后 reflect 出 `uiRenderer`，`ui-renderer/README.md:50`），纯核心是 `@deepseek-ai/dsh-client-ui-slots`。本地既有插件 `dsh/client.js:645` 已经用 `inject: ['slots','layout','locale']` —— 该服务在客户端 cordis 容器里，**插件只需在 `inject` 里声明**。

### 3. `kind` 与官方 `terminal` kind 的关系

- 官方 terminal 注册：`terminal/lib/client.js:438-451`
  ```js
  ctx.sidebarRightTabs.register({ id, kind: "terminal", multiple: true, priority: "builtin",
    title: () => t("title"),
    guide: [{ id: "new", order: 20, title: () => t("new"), description: () => t("description"), icon: PluginArtworkTerminal }] })
  ```
  即 **kind = `"terminal"`，priority = `"builtin"`，`multiple: true`**。
- 官方 files：`kind: "files"`、`priority: "builtin"`（`files/lib/client.js:14-16, 22-36`）。
- 官方 guide：`kind: "guide"`、`priority: "builtin"`（`sidebar-right/lib/client.js:595, 8949-8955`）。

**我们要注册自己的 kind 以免抢占它**：
- 若用 kind `"terminal"` 且 priority `"extension"` → `coexists` **允许**，但会**shadow 官方 builtin 终端**（我们卸载后它才复活），且标题/图标都不是我们要的。**不推荐。**
- 正确做法：**另取一个不冲突的 kind**（如 `"at-terminal"`），`priority` 留空（=`"extension"`）或显式 `"extension"`。此时与任何内置类型都无碰撞；`openTab('at-terminal')` 只开我们的。
- 注意 `id`（不是 kind）才是唯一性主键 —— 用包名/项目名，如 `"@at-series/dsh-at-terminal"`。

**`patterns` 是干嘛的**：只用于「资源类型」——匹配 `dsh-resource://<type>/…` 地址，决定「哪个类型来打开这个资源」，遵循编辑器解析器惯例（README.md:86）。**我们是页类型（按 kind 打开，不认资源），因此不写 `patterns`** —— 与官方 terminal / files / guide 一致（三者都没有 `patterns`；files 的树是页类型，靠 `kind: 'files'` 打开）。
- 排序细节（若要写 glob）：档位 → 命中模式长度 → 注册顺序（`candidates` 8797）。
- 复验：`Read .../dsh-client-ui-sidebar-right/lib/client.js` offset 8646 limit 15（`matcherFor`）；offset 8783 limit 20（`candidates`）。

### 4. 打开一个 tab 的确切姿势

```js
// client.js:6403-6406
openResource(address, options = {}) { const { sessionId, actions } = this.require(); this.placeResource(...); }
// client.js:6412-6415
openTab(kind, options = {})        { const { sessionId, actions } = this.require(); this.placeTab(...); }
```
- `openTab(kind, options?)`：`kind` 必须已注册，否则 `placeTab` 6469 throw `sidebarRight: no tab type is registered as "..."`。
- `openResource(address, options?)`：`address` 必须以 `dsh-resource://` 开头（`RESOURCE_SCHEME`，6327；校验 6463），否则 throw；无人认领也 throw（8825）。`options.kind` 可指定类型（跳过 glob，但保留 `canOpen`，8813-8822）。
- `options` 实际被读取的字段（`place` 6478-6507 + `placeTab` 6467-6476）：
  | 字段 | 语义 |
  |---|---|
  | `paneId?` | 目标停靠格；缺省用 active dock pane（6480） |
  | `replaceTab?` | 用新 tab 替换该 tab 所在的格与位置（并触发其 close handler）；**优先于 `preferNewPane`**（6500-6506） |
  | `revealIfOpened?` | `false` 时即使已有同 `(kind, contentId)` 也不聚焦，直接新开；页类型始终**只在目标格内**去重（6501，README.md:93） |
  | `preferNewPane?` | `true` 先尝试按两格上限与空间规则分栏，失败回退目标格（6482） |
  | `params?` | 导航参数，经 `tabDomain.navigate` 落到 `tab.navigation.params`（6493-6496） |
  | `kind?` | **仅 `openResource` 用**，指定认领类型 |
- 打开一定会**展开面板**（README.md:93「面板展开，因为用户看不到的内容不算打开」）。
- `require()`（6750-6751）：**无已挂载会话停靠面就 throw** `sidebarRight: no session surface is mounted` —— 所以**不能在 `apply` 阶段直接 `openTab`**，必须等用户动作 / `ctx.sidebarRight.mounted` 有值之后再调。
- 相关配套：`openTabFromTarget(kind, target)`（6593-6606，命令/快捷键用，带 guide 替换与浮窗规则）、`registerCloseHandler(kind, handler)`（6345-6351，同 kind 二次注册 throw 6346）、`close(tabId)` 6512、`active()` 6524、`isExpanded()` 6534、`toggleExpanded()` 6538、`split/float/dock` 6679/6701/6712、`focusedTarget/commandTarget` 6560/6570。

**「用户在右栏看到我的入口」最少需要**：
1. `ctx.sidebarRightTabs.register({ id, kind, title, guide: [{ id, order, title }] })` —— 这一步就产生了**引导页入口胶囊**（`guide` 数组 → `guideEntries`，`refresh` 8845-8849）。
2. `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key: id }, Body))` —— 正文本体。
3. 入口出现后有两种触达：
   - **用户点引导页胶囊**：`tab.actions.openTab(entry.kind, { replaceTab: true })`（`client.js:513-527` 附近的 onPick；证据 README.md:121）；
   - **代码主动打开**：`ctx.sidebarRight.openTab(kind)`（需已挂载会话）。
   > 补充：默认页只看**引导入口数**——0 或多个入口 → 打开引导页；恰好 1 个 → 直接开那一个页（`defaultSeed` 584-593）。当前宿主已有 terminal/new + files/workspace（+ guide 自身无 guide 数组）→ 已有 2 个入口，所以右栏默认就是引导页，我们的胶囊会直接出现在里面。

---

## 最小骨架

以下 ~30 行可直接接到现有 `dsh/client.js` 的 `factory` 返回值里（第 644-695 行的 `{ inject, apply }` 处）。**产品代码本报告未改动**（本段只是草稿）。

```js
// —— 追加到 dsh/client.js 的 factory 内（示意；未落地，未验证运行）——
const ID   = '@at-series/dsh-at-terminal'   // [证据] register 的 id 必须全系统唯一，且正文 key 用它：sidebar-right client.js:8696 / 5583
const KIND = 'at-terminal'                  // [证据] 自取 kind，避开官方 'terminal'：terminal client.js:440；共存规则 client.js:8631

function AtTabIcon({ size = 22 }) {         // [证据] guide entry 的 icon 以 <Icon size/className/> 渲染：client.js:461,474
  return h('span', { style: { fontSize: size } }, '⬢')
}

function AtTabBody({ useTabInfo }) {        // [证据] Body 的 useTabInfo 由 seat 的 children.inject.hooks.tabInfo 注入：client.js:9130-9134, 8965-9002
  const { tab, panel, sidebar } = useTabInfo()
  // tab: { id, kind, contentId, title, visible, navigation, signal, actions, ... }；navigation.params 来自 openTab 的 options.params
  return h('div', { style: { padding: 12 } },
    h('div', null, `AT Terminal · ${tab.title}`),
    h('div', { style: { opacity: .6, fontSize: 12 } }, `${KIND}@${panel.id} expanded=${String(sidebar.expanded)}`))
}

// —— apply(ctx) 内 —— [证据] 官方 terminal 的 inject：terminal client.js:350-358
// inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale']

ctx.effect(() => ctx.sidebarRightTabs.register({        // 阶段 1：类型  [证据] terminal client.js:438-451
  id: ID, kind: KIND,
  // priority 不写 → 默认 'extension'（client.js:8626）；页类型不写 patterns；单实例不写 multiple
  title: () => t('panel.title'),                        // [证据] title 必填且开 tab 时冻结：client.js:8821, 6474
  guide: [{ id: 'at-terminal', order: 30, title: () => t('panel.title'), icon: AtTabIcon }]  // [证据] order 参与排序：8849
}), 'at-terminal: sidebar-right type')

ctx.effect(() => ctx.slots.inject(                       // 阶段 2：正文  [证据] terminal client.js:475-483
  'sidebar.right.pane.tab',                              // [证据] slot 名：client.js:9126-9143
  () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ID,                                             // [证据] keyed slot 必填 key，且必须 = definition.id：ui-slots lib/index.js:176；client.js:5583
    locale: NS,
    inject: () => ({})                                   // 业务 share（可放自己的 store / t）
  }, AtTabBody),
  'at-terminal: sidebar-right body'
))

// 打开（可选；用户点击引导页胶囊也会走同一条路）： [证据] client.js:6412-6415, 6750-6751
// 必须已挂载会话（mounted 有值）后调用，否则 throw：
// ctx.sidebarRight.openTab(KIND)
```

对照的真实证据（可直接读）：
- terminal：`Read dsh/.cache/m4-recon/node_modules/@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.js` offset 350 limit 145
- files：`Read .../dsh-client-ui-sidebar-files/lib/client.js` offset 995 limit 20
- 官方 guide（同一个公开两阶段路径）：`Read .../dsh-client-ui-sidebar-right/lib/client.js` offset 8949 limit 10，offset 9173 limit 22

---

## 未确定项

1. **`ctx.slots.register` 的 options 是否还有未列出的必填项** —— 已确认核心只读 `name/key/id/order/label/priority/select/inject/children/store/locale/registrant`（`ui-slots/lib/index.js:163-219`）。但 `inject` / `children` 的**结构化契约**（如 `{ hooks: {...} }` 包裹）在 `ui-renderer` 的装配代码里（`client.js:708-740`），本次未逐行读完。结论：**直接照抄 terminal 的用法（`inject: (sessionId) => ({ hooks: {...} })`）即可**；自己发明的 shape 未验证。
2. **`inject` 回调参数 `sessionId` 的来源与调用时机** —— 证据是 terminal 的 `inject: (sessionId) => ({ view: (key) => view(sessionId, key), keyedHooks: {...} })`（terminal client.js:455-458, 479-482）。`keyedHooks` 的语义（按键给 hook）**未确定**，我们首发不需要它。
3. **`definition.title` 对页类型的入参** —— 已确认会被传 `sidebar://<kind>`（`pageAddress` 603-605；`placeTab` 6474、`defaultSeed` 591）。但 README 描述为 `title(address)`「资源类型用地址」；页类型的 arg 是内部簿记地址，**不要依赖它的值**。
4. **官方 `dsh-client-ui-sidebar-terminal` 是否有可复用的终端实现** —— `lib/client.terminal.js`（13493 行）是其页面私有的动态 chunk，`client.js:177` 用 `Suspense` 懒加载，**未见公开的 require/import 路径**。要复用官方终端渲染器需另做侦察（未做）。本次只确认了「类型注册契约」，未确认「终端 xterm 组件能否被第三方插件直接引用」。
5. **宿主实际加载我们插件的机制** —— 本报告只确认了 `window.__ModuleLoader__.load({id, factory})` 是本仓库既有约定（`dsh/client.js:24-30`），未在官方 `client-modules` / `client-hmr` 包内逐行核实该全局对象与 `dsh.client` 清单字段（`package.json` → `dsh.client.{inject,platform}`）的装配细节。
6. **`sidebar.right.tab.menu.item`（list）与 `sidebar.right.tab.guide`（chain）两个额外席位** 本次未取证（README.md:88 有描述，未读实现）。若要给 tab 右键菜单加项，需要补 `id`/`order` 的用法（list slot 必填 `id`，`ui-slots/index.js:182`）。
7. **`sidebar.right.pane.tab.title` 是否必须注册** —— 不必需：不注册时 chip 用 `title(address)` 打开时冻结的文本，fallback 即 `tab.title`（`client.js:5620-5626`）。但要「活的标题」就必须注册。

### 复验索引（命令）

所有 `Read` 都相对 `dsh/.cache/m4-recon/node_modules/@deepseek-ai/`：

| 结论 | 文件 | 行 |
|---|---|---|
| 服务 provide | `dsh-client-ui-sidebar-right/lib/client.js` | 9050-9051 |
| registry = class | 同上 | 8666 |
| controller = class | 同上 | 6329 |
| `register` 全实现 | 同上 | 8691-8722 |
| duplicate id throw | 同上 | 8696 |
| kind 撞名 throw | 同上 | 8698 |
| coexists | 同上 | 8631-8632 |
| RANKS / DEFAULT_BAND | 同上 | 8620-8626 |
| matcherFor（patterns 语义） | 同上 | 8646-8659 |
| candidates 排序 | 同上 | 8783-8799 |
| claim / title(address) | 同上 | 8813-8831 |
| pageAddress `sidebar://<kind>` | 同上 | 603-605 |
| `multiple` → uuid contentId | 同上 | 6470 |
| `openResource` / `openTab` | 同上 | 6403-6415 |
| `place` options 全字段 | 同上 | 6478-6507 |
| `require` 无挂载即 throw | 同上 | 6750-6751 |
| `openTabFromTarget` | 同上 | 6593-6606 |
| `registerCloseHandler` | 同上 | 6345-6351 |
| seat children 声明（keyed/session） | 同上 | 9126-9144 |
| `useTabInfo` 返回形状 | 同上 | 8965-9002 |
| TabSlot 分派（entryKey=id） | 同上 | 5551-5597 |
| `keepMounted` 只对 pane.tab | 同上 | 5554 |
| guide 定义（kind/priority） | 同上 | 8949-8955 |
| defaultSeed 入口数规则 | 同上 | 584-593 |
| guide entry 渲染（icon/title/desc） | 同上 | 459-492 |
| 官方 guide 两阶段注册 | 同上 | 9173-9193 |
| 官方 terminal 类型注册 | `dsh-client-ui-sidebar-terminal/lib/client.js` | 438-451 |
| 官方 terminal id / inject | 同上 | 386, 350-358 |
| 官方 terminal slot 注册 | 同上 | 475-489 |
| 官方 files 定义 / slot | `dsh-client-ui-sidebar-files/lib/client.js` | 14-37, 995, 1002-1012 |
| slots.register 契约 | `dsh-client-ui-renderer/lib/client.js` | 1788-1791 |
| slots.inject 契约 | 同上 | 1328-1402 |
| keyed 必填 key / 重复 key throw | `dsh-client-ui-slots/lib/index.js` | 175-179 |
| register options 字段全集 | 同上 | 163-219 |
