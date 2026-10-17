# 真机走查：下架的 4 个「假 UI 插件」没有带走任何用户可见能力（2026-10-17）

> 这一轮只做一件事：给 2026-10-16 下架的 4 个插件补**真机走查**证据。
> 结论先说：**四项能力都还在，而且都不是那 4 个插件提供的** —— 它们当年只是注册表里的名字
> （`provide` 出来的服务零消费者、零装配路径），删掉它们对用户可见行为的改动是 **0**。
>
> 新增判据 `src/test/retired-ui-plugins.test.ts`（RUP-1..RUP-5）把这条结论钉住，并做了两处变异自证。

## 0. 走查环境（可复现）

| 项 | 值 |
|---|---|
| 日期 | 2026-10-17（本地） |
| 源码 | 走查① `master` @ `d3bade0d96adc99c077c39e50565adef4ef3f373`（**未改版本号、未发版**）；走查②（复核，见 2.6）`dd7ec24d141289defbb5b3e518e76d7708853f81` |
| 构建 | `TAURI_SIGNING_PRIVATE_KEY=$(cat .tauri/codem-updater.key) TAURI_SIGNING_PRIVATE_KEY_PASSWORD=dummy node node_modules/@tauri-apps/cli/tauri.js build --no-bundle`，两次都 exit 0（`3m24s` / `3m40s`） |
| 可执行文件 | ① `sha256=6f8124531266f25a4cffcb4fb25df9c84b90587366fefba34943bfd974ced67d`（12:54）；② `sha256=29222bfd7b86b51a80f1e76bfde1494638b042c1f95d8a17030db50f706f2746`（13:34，exact HEAD） |
| 实例 | ① `Start-Process -PassThru` → **PID 19692**（前 `tasklist` 里 codem.exe 为 0 个；全程只按 PID 操作，未用 `taskkill /IM`；该实例在收尾前自行消失，故无需 kill）；② → **PID 18760**（收尾 `taskkill /PID 18760 /T /F`） |
| 调试端口 | ① `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`；② 隔离到 `9333`（理由见 2.6 的环境注意） |
| 驱动 | `node .preview-shot/cdp.mjs "<js>" [waitMs] [--click <sel>]`；另写 `_walk-type.mjs`（原生键盘敲入）、`_walk-click.mjs`（滚动+真实鼠标）、`_walk-shot.mjs`（`Page.captureScreenshot`） |
| 数据 | **真实数据根**（未用 `CODEM_DATA_HOME` 隔离）：3 个项目、562 个会话、11 个内置技能、插件目录 204 条 |

为什么强调「真实鼠标/真实键盘」：`element.click()` 会绕过命中测试，`el.value=…` 会绕过 React 的
`onChange` —— 这两条都会造出**假绿**（第 73 波吃过一次亏）。本轮所有交互都走
`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`，截图由 `Page.captureScreenshot` 落盘。

截图：原图在 `.preview-shot/walk-0*.png` / `walk-1*.png`（5328×3189 与 5364×3210，**不进 git**），
本目录下的 `.jpg` 是等比缩到 1600px、质量 85 的副本（不裁剪、不修图），每张附原图 sha256 前缀便于核对同一张图。

## 1. 四项能力的**真实实现落点**（走查落点，全部点名到文件/符号）

> 行号以 `d3bade0d` 为准；`App.tsx` / `Sidebar.tsx` 有另一路并行改动，行号可能漂移 ⇒
> 定位以「文件 + 符号 + 选择器」为准。

| 能力 | 真实实现 | 入口路径 | 数据来源 |
|---|---|---|---|
| 基础 UI 组件（Button/Input/Card/Badge/Switch/Dialog…） | `src/components/ui/*.tsx`（13 个文件，769 行；Radix + 语义类名，如 `badge.tsx` / `switch.tsx`（`@radix-ui/react-switch`）/ `card.tsx` / `dialog.tsx`） | 由具体面板直接 `import`：`SkillManager`（badge/switch/dialog/card/progress/alert-dialog）、`PluginManager`（badge/switch）、`McpManager`、`NotebookManager`、`Tooltip` 等 36 个组件文件 | 组件自身 props（无服务层）；`src/lib/utils.ts` 的 `cn()` 拼类名 |
| 输入触发器（`/` 技能命令、`@` 提及） | `src/components/InputArea.tsx:1423`（`/(?:^|\s)\/([^\s]*)$/`）与 `:1425`（`/(?:^|\s)@([^\s]*)$/`）—— 同一个 `onChange` 里解析两个触发字符；`SlashCommandMenu.tsx`、`MentionAutocomplete.tsx` 负责渲染 | 会话输入框（Composer）；`/` 菜单经 `SlotBridge name="app.ui-commands"` 挂载（Portal 到 `body`） | `/`：`getSkillRegistry().getAll()` 过滤 `codem-disabled-skills`（`SlashCommandMenu.tsx:30-31`）；`@`：`listFilesForMention(currentProject.path)`（`InputArea.tsx:1183`，真实文件系统列举） |
| Agent 预设（内置 build/plan/explore/general/title/summary/verify + 自定义） | `src/core/agent/agent.ts:77`（`BUILTIN_AGENT_IDS`）/`:241`（`id: "build"` 等定义）+ `src/components/AgentManager.tsx`（列表/详情/编辑）；预设的快速切换 UI 是 `src/components/PermissionPresetSelector.tsx`（`SECURITY_MODES` + `setGlobalSecurityMode` / `setProjectSecurityMode`） | 侧边栏「智能体」（`Sidebar.tsx:657`）→ `App.tsx:5733` `<SlotBridge name="app.agent-manager" fallback={AgentManager}>`；权限预设按钮在 Composer 底栏（`InputArea.tsx:1643` `SlotBridge name="app.permission-preset-selector"`） | `getAgentRegistry().getAll()` / `isBuiltin()`（`AgentManager.tsx:107/115`）；安全模式来自 `src/core/permission/security-mode.ts` 的 `codem-security-mode`（真键、真事件） |
| 技能面板（列表/启停/安装/删除/市场） | `src/components/SkillManager.tsx`（1380 行） | 侧边栏「技能」（`Sidebar.tsx:527/642`）→ `App.tsx:5544` `<SlotBridge name="app.skill-manager" fallback={SkillManager}>` | `getSkillRegistry()`（内置 11 条 + 磁盘安装）、`installSkillFromZip` / `uninstallSkill`（`src/core/skill/installer.ts`）、`listMarketSkills`（`src/core/skill/skill-market-client.ts`，远端源 ClawHub / Skills.sh / GitHub / SkillHub） |

## 2. 逐项真机证据

### 2.1 基础 UI 组件：面板真的渲染了这些原语，点击后状态真的变

操作：侧边栏「技能」→ 技能管理（`.modal-overlay` 内），再真实点击筛选按钮、技能条目。

- console 原文（点击前）：`[SkillDiag] skill-manager mounted`；`[App] Loaded 0 installed skills from disk`
- DOM 断言（打开面板后）：
  ```json
  { "modal": true, "card": 0, "badge": 21, "switchEl": 11, "dialog": 1,
    "text": "技能管理\n我的技能\n11\n技能市场\n…\n全部\n11\n内置\n11\n用户\n0\n外部\n0\ncode-review\nv2.0.0\n…" }
  ```
- 真实点击「用户0」筛选按钮 → 状态变化：`activeFilter: "全部11"` → `"用户0"`，`items: 11 → 0`，空态文案 `暂无技能`；再点回「全部」→ `items: 11`
- 真实点击第一条技能 → 详情面板出现（`detailPresent: true`），渲染 `badge` 数从 21 升到 31；详情原文：
  `code-review / 内置 / 版本 2.0.0 / 别名 review, cr / 标签 review, security, quality, audit / 允许的工具 read, grep, glob / 触发条件 …`
- 这些元素就是 `src/components/ui/badge.tsx`、`ui/switch.tsx`、`ui/dialog.tsx` 渲染的：DOM 里的
  `class="badge …"`、`role="switch" class="switch-root" aria-checked="true"` 与组件源码逐字对应
  （`switch.tsx` 里 `SwitchPrimitives.Root className={cn("switch-root", …)}`）。

截图：`walk-01-skill-panel.jpg`（原图 sha256 `82d17677…`）、`walk-02-skill-detail.jpg`（`0faca6e8…`）。

补充：插件管理器（底栏「插件管理」）同样由这些原语构成 —— DOM 计数 `badge: 164, switches: 40`；
搜索框真实键入 `ui-` 后值变为 `"ui-"`（`_walk-type.mjs` 的 input 记录器逐字符 `insertText`）。

### 2.2 输入触发器：`/` 弹出真实候选并可插入；`@` 弹出真实文件候选

操作：把焦点真实点进 `textarea.message-input`（原生 Ctrl+A + Backspace 清空）→ 原生键盘敲 `/`。

- 敲入后 DOM：`value: "/"`、`slashMenuPresent: true`、`.slash-command-item` **13 条**，原文片段：
  `🎯debugHelp debug issues by analyzing code and error message`、`🎯document…`、`🎯test…`、
  `🎯explain…`、`🎯mermaid-diagram…`、`🎯对话转提示词…`、`🎯提示词管理工具…`、`🎯交互式表单提问…`、`🎯技能创建器…`
- 真实鼠标点击第 3 条 → `menu: false`，输入框值变为 **`/debug `**（`textarea.message-input.value === "/debug "`）
- `@`：切换到挂了项目的会话后敲 `@` →
  ```json
  { "text": "提及文件 (65)\nUsersabeeAppDataLocalTempdualdb-d0a99a\nC:\\mimo-gui\\UsersabeeAppDataLocalTempdualdb-d0a99a\nartifacts\nC:\\mimo-gui\\artifacts\n…",
    "count": 20 }
  ```
  即候选是**项目真实目录内容**（`C:\mimo-gui\…`），来自 `listFilesForMention(currentProject.path)`。
- 键盘路径同样验证：`@` + `ArrowDown ×2` + `Enter` → `value: "@com.codem.app "`、菜单关闭。

截图：`walk-03-slash-menu.jpg`（`cd581197…`）、`walk-04-mention-menu.jpg`（`258c0599…`）。

> ⚠️ 旁支缺陷（**与插件下架无关**；**本轮已修复**，见第 5 节）：`@` 候选虽然渲染了 20 条真实条目，
> 但在当时的布局里被 `.input-area.input-card-container{overflow:hidden;height:135px}` **裁剪**
> （`elementFromPoint` 在候选位置上命中的是 `.rich-content`，截图上完全看不到候选框）。`/` 菜单没有这个问题
> —— 它显式 Portal 到 `document.body`（`InputArea.tsx` 里有注释「避免被 overflow:hidden 裁剪」），
> 而 `MentionAutocomplete` 当时是直接渲染在 `.input-textarea-row` 里。
> 取证范围：build ① 实测；`InputArea.tsx` / `MentionAutocomplete.tsx` 在两次构建之间未被任何提交改动。

### 2.3 Agent 预设：7 个内置预设 + 详情真实可读；切预设真的改变权限姿态

操作 A：侧边栏「智能体」→ 智能体定义管理 → 真实点击 Plan 卡片。

- 列表原文：`Build 内置 主智能体 / Plan 内置 通用 / Explore 内置 通用 / General 内置 通用 / Title 内置 子智能体 / Summary 内置 子智能体 / Verify 内置 通用`（共 7 条，与 `agent.ts:77` 的 `BUILTIN_AGENT_IDS` 一一对应）
- 点击后详情原文：`Plan (plan) / 描述: Read-only agent for planning and analysis / 模式: 通用 / 协作模式: 规划模式 (只读) / 模型槽位: 子任务 (subagent) / 最大步数: 10 / 工具白名单: read（必需）, glob（必需）, grep（必需）, bash, lsp, tool_search, web_search, zvec_grep_search / 上下文模式: 内联 (inline) / 权限规则 … write [deny]`

操作 B（切预设 → 看行为变化）：Composer 底栏「完全访问」→ 真实点击 → 下拉三项（请求批准/替我审批/完全访问，当前项 `active`）→ 点「替我审批」：

- 按钮文字 `完全访问` → **`替我审批`**，class `security-full` → **`security-auto`**
- 页面事件（我事先在页面里挂的监听器收到的 `codem-security-mode-changed` 原文）：
  ```json
  [ {"mode":"auto","scope":"project","projectPath":"C:\\mimo-gui"}, {"mode":"auto","scope":"project","projectPath":"C:\\mimo-gui"} ]
  ```
- 再切回「完全访问」→ `label: "完全访问"`、`class: security-full`、事件追加 `full/project`
- 这次切换**真的改变了应用的权限姿态**（`security-mode.ts` 写 `codem-security-mode-project:…` 并广播事件；
  `ask/auto/full` 会被审批链路读取），不是「只改了一个本地字段」。

截图：`walk-05-agent-presets.jpg`（`11f68ab2…`）、`walk-06-preset-open.jpg`（`f7116a73…`）、`walk-07-preset-auto.jpg`（`3b97490d…`）。

### 2.4 技能面板：11 条内置技能 + 真实市场 894 条，详情可展开（未卸载任何真实技能）

操作：技能管理 → 「我的技能」11 条 → 展开 `code-review` 详情；切「技能市场」看远端源。

- 「我的技能」：11 条内置（code-review / refactor / debug / document / test / explain / mermaid-diagram / …），
  每条带版本、描述、`内置` 徽标、启停开关（`disabled`，因为内置不可停用）
- 详情（真实点击，见 2.1）：版本/描述/别名/标签/允许的工具/触发条件/提示词全文
- 「技能市场」：console 原文
  `[SkillMarket] Trees API found 19 SKILL.md files in anthropics/skills`、
  `[SkillMarket] SkillHub API: fetched 105 skills`、`[SkillMarket] ClawHub: fetched 296 skills across 4 page(s)`；
  面板计数 `技能市场 894`，分组 `Anthropic Skills 19 / GitHub Agent Skills 30 / GitHub SKILL.md Repos 20 / ClawHub.ai 296 / Skills.sh 412 / SkillHub 106 / Codem 内置技能 11`
- 无害操作只做了「展开详情」与「切筛选」；**没有安装、没有卸载、没有启停任何真实技能**（内置开关本身是 disabled）

### 2.5 反向证据：插件市场里那 4 个条目确实不存在（对照组仍在）

操作：底栏「插件管理」→ 读整页文本（204 条目录）。

- console 原文：`[PluginManager] Initialized with 204 plugins (1 disabled)`
- DOM 断言（整页 `innerText` 包含性）：
  ```json
  { "@codem/ui-game": true, "@codem/ui-pet": true, "@codem/ui-library-ops": true,
    "@codem/ui-primitives": false, "@codem/ui-input-trigger": false,
    "@codem/ui-agent-preset": false, "@codem/ui-skill-panel": false }
  ```
  即：同族的 `ui-*` 条目仍在（对照），4 个已下架条目在**用户能看到的插件目录**里彻底消失。

## 2.6 exact-HEAD 复核（第二次构建，源= `dd7ec24d`）

走查做到一半，仓库另一路把当轮改动提交了（`924673aa` / `e1a03bc5` / `dd7ec24d`，只动
`Sidebar`/`App` 的死 prop 与 `tools/maintenance/*`，**不碰本轮四项能力的任何文件**）。
为了让「证据来自提交后的源码」这件事也成立，我在干净的 `dd7ec24d` 上**重新构建**并快速复核了一遍：

| 项 | 值 |
|---|---|
| 源码 | `dd7ec24d141289defbb5b3e518e76d7708853f81`（工作区仅有本轮新增的两个未跟踪路径） |
| 构建 | 同一条命令，exit 0，`Finished release profile in 3m40s` |
| 可执行文件 | `sha256=29222bfd7b86b51a80f1e76bfde1494638b042c1f95d8a17030db50f706f2746` |
| 实例 | `Start-Process -PassThru` → **PID 18760**（启动前 `tasklist` 无 codem.exe；收尾 `taskkill /PID 18760 /T /F`，未用 `/IM`） |
| 端口 | `--remote-debugging-port=9333`（隔离端口，避开另一路可能占用的 9222） |

复核结果（原文摘要）：

- 技能面板：`{"label":"技能管理","badge":21,"sw":11,"items":11}`；真实点击「用户0」→
  `{"filter":"用户0","items":0,"empty":"暂无技能"}`；点回「全部」→ 11 条；点条目 →
  `{"detail":true,"badge":31}`（详情原文 `code-review / 内置 / 版本 2.0.0 …`）
- 输入触发器：原生清空后 `{"v":"","n":0}`（4 秒空等**零**输入事件，证明没有别的东西在灌字）；
  敲 `/` → `{"v":"/","n":1,"menu":true}`；菜单 `items: 11`，
  `titles: [code-review, refactor, debug, document, test, explain, mermaid-diagram, 对话转提示词, 提示词管理工具, 交互式表单提问, 技能创建器]`；
  真实点击第 3 条 → 输入框 `"/debug "`
- Agent 预设：`{"label":"智能体管理","count":7,"names":[Build,Plan,Explore,General,Title,Summary,Verify]}`；
  点 Plan → 详情同 2.3（`协作模式 规划模式(只读)` / `模型槽位 子任务(subagent)` / `write [deny]`）
- 预设切换：`完全访问` → 点「替我审批」→ `{"label":"替我审批","cls":"… security-auto","events":["auto/project","auto/project"]}`；
  再切回 → `{"label":"完全访问","events":[… ,"full/project","full/project"]}`
- 插件目录（同一 exe，第一次尝试时打开插件管理器的即时日志）：
  `[PluginManager] Initialized with 204 plugins (1 disabled)`、
  `[PluginManager] Disabled (never-loaded): @codem/ui-game —— 本次进程内从未装载该插件（没有卸载对象）…`

截图：`walk-12-head-skill-detail.jpg`（`62c199b0…`）、`walk-13-head-slash.jpg`（`caf8614c…`）、
`walk-14-head-agents.jpg`（`1208c49a…`）、`walk-15-head-preset-auto.jpg`（`470164e2…`）。

> 环境注意：复核期间，9222 端口的那个实例被**另一路驱动**在输入框里灌过一条
> `C:/Users/abee/.dsh/…/bash-win32-x64/`（运行时日志里也有非本路发起的 `exec … cmd=node -v`），
> 随后进程消失 —— 与交接里已定性的「真机回合末进程消失 = 互踩」同形。
> 因此复核改用**独立端口 9333 + 单次受控实验**（见上面的 `{"v":"","n":0}`），证据不受影响。

## 3. 因果依据：为什么可以断定「这些能力不是那 4 个插件提供的」

1. **服务零消费者**：`grep -rn "uiPrimitives|uiInputTrigger|uiAgentPreset|uiSkillPanel" src tools config`
   在 `src/test/` 之外**只有 1 处命中**，而且是 `config/codem.base.yml` 里描述「已下架」的注释。
   代码里没有任何 `ctx.get('uiInputTrigger')` 之类的读取方 —— 触发字符是 `InputArea` 自己的正则解析的。
2. **假实现文件不存在**：`src/core/provider/ui-{primitives,input-trigger,agent-preset,skill-panel}-provider.ts`
   四个文件都已删除（`ls` 报 No such file）。它们当年 `provide` 的只是 `Map` 与占位组件
   （`({children}) => children || null`），没有任何装配路径。
3. **注册表/目录/装配清单零残留**：`builtin-registry.ts`、`plugin-registry-provider.ts`、
   `config/codem.base.yml`、`config/codem.desktop.yml` 里这 4 个插件 id 的计数均为 **0**。
4. **渲染链是直接 import，不经过服务**：`App.tsx:275/287` 直接 `import { SkillManager }` /
   `import { AgentManager }`，并在 `:5544` / `:5733` 作为 `SlotBridge` 的 `fallback` 渲染；
   `SkillManager` 自己 `import { Badge } from "./ui/badge"`、`{ Switch } from "./ui/switch"`；
   `InputArea` 自己 `import { SlashCommandMenu }` / `{ MentionAutocomplete }`。
   —— 也就是说：**即使在下架之前**，这四项能力也从不读那 4 个服务；删掉它们，这条链一个字节都没变。
5. **历史事实**：下架前它们就已经在 `plugin-assembly-path.test.ts`（SO-8）的
   `KNOWN_REGISTRY_ONLY` 例外表里 —— 「注册了但永远不 apply」。所以真机上它们**从未参与渲染**。

## 4. 新判据与变异自证

判据文件：`src/test/retired-ui-plugins.test.ts`（5 条，全绿）。

| # | 内容 |
|---|---|
| RUP-1 | 注册表不许再 `registerBuiltinPlugin('@codem/ui-…')`、不许再 import 那 4 个 provider 文件；provider 文件本身也不许回来 |
| RUP-2 | 市场目录 `KNOWN_PLUGINS` 不许再出现这 4 个名字（并要求目录仍 >10000 字符、仍含 `@codem/ui-game`，防止读空文件恒真） |
| RUP-3 | 装配清单不许**未注释**地启用这 4 个 id（注释里写名字允许，且反向对照证明注释不误报） |
| RUP-4 | 四项能力的真实实现必须在位且被接线：`ui/badge.tsx` `ui/switch.tsx` `ui/card.tsx` `ui/dialog.tsx`、`InputArea` 的两个触发正则 + `SlashCommandMenu`/`MentionAutocomplete`/`listFilesForMention`、`agent.ts` 的 `BUILTIN_AGENT_IDS` + `AgentManager` + `App.tsx` 的 fallback、`SkillManager` 的注册表/安装/市场/卸载四处 |
| RUP-5 | 那 4 个假服务不许出现任何读取方（`.get('…')` / `.inject(['…'])`） |

每条都有**反向对照**（把合成样本喂给同一个检查函数必须判红），另外做了两次**真变异**：

| 变异 | 手法 | 结果 |
|---|---|---|
| A：注册表回潮 | 在 `builtin-registry.ts` 的 `// P2-7.14` 段加回 `registerBuiltinPlugin('@codem/ui-primitives', { provides: ['uiPrimitives'] … })` | **RUP-1 红**：`注册表出现了已下架插件的重新登记：registerBuiltinPlugin：@codem/ui-primitives`（其余 4 条仍绿）；`git checkout --` 还原后 5/5 绿 |
| B：真实实现断线 | 把 `SkillManager.tsx` 的 `import { Badge } from "./ui/badge"` 删掉 | **RUP-4 红**：`真实实现断线：基础 UI 组件（…）→ src/components/SkillManager.tsx 缺 /from "\.\/ui\/badge"/…`；还原后 5/5 绿 |

## 5. 本轮修复：`@` 候选被裁剪（Portal 化）+ 权限预设重复派发

### 5.1 复现（修复前，exe `29222bfd…`、PID 38128、端口 9333）

操作：真实项目会话（`对话 2` / 项目 `mimo-gui`）里原生清空输入框 → 敲 `@` → 1.2s 后量测。

| 量测项 | 值 |
|---|---|
| 候选面板 rect | `top 718 / bottom 958 / height 240 / width 318.2` |
| 是否在 `.input-area` 内 | `true`（链条：`input-textarea-row` → `input-wrapper` → `.input-area.input-card-container`） |
| 裁剪祖先 | `.input-area.input-card-container`（`overflow: hidden`、`height: 135px`）等 5 层 |
| 可见高度 / 被裁掉 | **9px / 231px**（共 240px） |
| `elementFromPoint` | 面板中心 → `.qa-turn-footer`；首条候选 → `.messages-container`（都不是候选） |
| 候选内容 | header `提及文件 (65)`、`itemCount 20` —— 数据与渲染都正常，纯粹「看不见 / 点不到」 |

截图：`mention-fix-00-before.jpg`（原图 sha256 `8a38f060…`）。

### 5.2 修法（与 `/` 对齐，不动输入区布局）

- **采用**：候选经新组件 `MentionMenuPortal`（共享入口 `ui/portal`）**Portal 到 `document.body`**；
  `InputArea` 量输入行 rect 算出 `{left, bottom, width}`（与 `/` 菜单同一口径：贴在输入行上方 4px），
  `resize` 与**捕获阶段 scroll** 时重算；包裹层 `.mention-menu-portal{position:fixed; z-index:var(--z-top)}`，
  内层 `.mention-autocomplete{position:static; width:100%; z-index:auto}`。
- **否决**：调 `.input-area` 的 `height`/`overflow` 把候选「挤出来」—— 那个高度是折叠/展开/多行共用的有意固定值，
  改它会牵动整个 Composer；而且只是把裁剪口子开大，换个高度/滚动位置还会再犯。
- Portal 之后补的两件交互：
  ① **点外面关闭**（候选已不在输入卡子树里）→ `document` 捕获 `pointerdown`，排除 `.mention-menu-portal`
  与 `.input-card-container`；
  ② 候选 `<li>` 上 `onMouseDown={e => e.preventDefault()}` —— 否则按下候选会让 textarea 失焦，
  输入卡的 `onBlurCapture` 会把多行输入折叠（Portal 之前它被 `card.contains(relatedTarget)` 排除了）。
- `Escape` / `ArrowUp` / `ArrowDown` / `Enter` 仍由 `MentionAutocomplete` 的 document 键盘监听处理
  （Portal 不改变事件路径），真机复验见 5.4。

### 5.3 判据与变异（`src/test/mention-menu-portal.test.tsx`，6 条全绿）

| # | 守什么 |
|---|---|
| MP-1 | InputArea 必须经 `MentionMenuPortal` 渲染候选（源码形态 + 位置计算/滚动监听存在）；反向对照：就地渲染样本必须判红 |
| MP-2 | Portal 宿主确实挂在 `document.body` 下、不在 `.input-card-container` 裁剪链里；定位由 fixed 包裹层给 |
| MP-3 | CSS：包裹层 fixed、内层 static；且**没有**靠放宽 `.input-card-container` 的 `overflow` 来「挤出来」 |
| MP-4 | InputArea 真组件：`@` → 候选 → `ArrowDown` + `Enter` → `"@beta.ts "`、候选关闭（真实链路不回退） |
| MP-5 | 权限预设一次点击**只派发一次** `codem-security-mode-changed`（旧写法两次） |
| MP-6 | `MentionAutocomplete` 自身键盘语义：`ArrowDown×2 + Enter` 选第 3 条、`Escape` 关闭 |

变异自证（先红后绿）：

| 变异 | 结果 |
|---|---|
| A 把 `<MentionMenuPortal pos={mentionMenuPos}>` 改回就地 `<MentionAutocomplete>` | **MP-1 红**（形态判为 inline）、**MP-4 红**（DOM 里没有 `.mention-menu-portal`）；还原后 6/6 绿 |
| B 把 `handleSelect` 改回「自己写 + 再调 `onModeChange`」 | **MP-5 红**：`一次点击派发了 2 次同值事件（应恰好 1 次）`；还原后 6/6 绿 |

### 5.4 真机复核（修复后，exe `d9dab7b4…`、PID 2352 / 32540、端口 9444）

- 构建：标准命令 `… tauri.js build --no-bundle`，exit 0，`Finished release profile in 3m37s`。
  ⚠️ 期间另一路实例（PID 31212，**不是本路**）占着 `target/release/codem.exe`，cargo 报
  `failed to remove file … (os error 5)`。处置：把被占用的 exe **重命名**为 `codem-held-by-31212.exe`
  （Windows 允许重命名运行中的镜像；**没有 kill 别人的进程**）→ 重新构建成功 → 收尾删除该重命名文件。
  另：两个实例共用 WebView2 用户数据目录时第二个起不来，本路用
  `WEBVIEW2_USER_DATA_FOLDER=.preview-shot/wv2-mentionfix` 隔离（**数据根仍是真实数据根**）。
- 量测（原文）：`panelRect {top 356, bottom 596, height 240, left 251, width 893}`、`insideInputArea false`、
  祖先链只有 `mention-menu-portal` + `body`、`visibleHeightPx 240 / clippedByPx 0`、
  首条候选命中 `mention-label`、`header 提及文件 (65)`、20 条。
- 截图：`mention-fix-01-open.jpg`（完整候选列表，带图标/文件名/路径）、`mention-fix-02-keyboard.jpg`（键盘插入后）、
  `mention-fix-03-mouse.jpg`（真实鼠标点选后）。
- 键盘：`ArrowDown ×2 + Enter` → 输入框 `"@com.codem.app "`、菜单关闭。
- 鼠标：真实点击第 2 条 → `reachable=true top=mention-label`，输入框 `"@artifacts "`、菜单关闭。
- 点外面：点 `.chat-header` → 菜单关闭、输入框值不变（仍 `@`）。
- resize 重定位：视口宽 1200→900，面板 `left 251→220`、`width 893→624`（inline style 同步改变），证明重算生效。
  （诚实说明：`bottom` 是视口相对量，单纯改高度不会改变它，所以用**宽度变化**做判据更准。）
- 未单独观测：滚动重算 —— 本布局消息区自滚、输入行不动，造不出可见位移；该路径由 MP-1 的监听断言守。

### 5.5 顺带修掉的重复派发

- 现象（真机）：一次点击收到两条 `codem-security-mode-changed`（`auto/project` ×2）。
- 根因：`PermissionPresetSelector.handleSelect` 先自己 `setGlobal/setProjectSecurityMode`，再 `onModeChange?.(mode)`；
  而 `InputArea` 的 `onModeChange` 做的就是同一件事。
- 修法：给了 `onModeChange` 就由它全权写（否则组件自己写）—— 判据 MP-5。
- 修复后真机：四次点击 → 恰好四条事件 `auto → full → auto → full`（每次一条），按钮文字/class 同步，
  最后切回 `完全访问` 收尾。截图 `mention-fix-04-preset-single.jpg`。

### 5.6 锚定复验（面板滚动 / 窗口缩放）与两条样式门禁

**锚定**（同一 exe，口径 = 候选底边到输入行顶边恒为 4px）：

| 场景 | 结果 |
|---|---|
| 候选列表自身滚动 | `scrollTop 0 → 140`（`scrollHeight 930 / clientHeight 238`），面板 `top 356 / bottom 596` **不变**、gap 4px（截图 `mention-fix-05-scroll.jpg`） |
| 视口宽度 1200 → 900 | 面板 `left 251 → 220`、`width 893 → 624`（inline style 同步变），gap 4px；还原后回 251/893 |
| 视口高度 727 → 527 | 面板随输入行上移 `top 356 → 156`，gap **恒 4px**；还原后回 356 |
| 消息面板滚动 | **未观测到**：`.messages-container` 的 `scrollTop` 恒为 0（该会话内容不足一屏，没有可滚动溢出）；候选锚的是输入行，输入行不随消息区滚动 ⇒ 这一条如实记为未验 |

**两条样式门禁**（新增浮层会踩到的两处，均已按仓库既有机制修绿）：

- **CSS 契约快照**：新增 `.mention-menu-portal` 必须登记进 `tools/ui-audit/css-contract.json`。
  用仓库工具生成（**没有手改快照**）：`node tools/ui-audit/css-contract.mjs --write` → `快照已写入 …（2886 个类）`；
  再跑一次 `node tools/ui-audit/css-contract.mjs` → `✅ 无变化`；`npx vitest run src/test/css-integrity.test.ts` → **10/10 绿**。
- **写死值棘轮**：第一版内层覆盖写了 `z-index: auto`（裸 z-index 字面量）⇒ `scan-style-literals --check` 红（`z-index` 族 25→26）。
  改法是不写那一行 —— 内层保留 `.mention-autocomplete` 自带的 `z-index: var(--z-chrome)`，包裹层 `z-index: var(--z-top)`
  已建立层叠上下文；**没有**改阈值、没有加白名单。复核：`node tools/audit/scan-style-literals.mjs --check` →
  `✅ 棘轮通过：11 个族全部不超过基线`；`npx vitest run src/test/style-token-gates.test.ts` → **40/40 绿**。

### 5.7 A4：鼠标点「发送」不收起候选（Portal 化把它从不可见变成可见）

- **缺陷**：`mentionQuery` 的唯一重算点是 `onChange`；候选打开时键盘 Enter 被拦截，
  但**鼠标点发送按钮**会走 `handleSubmit` —— 它只清输入、不收候选 ⇒ 浮层留在原地。
  Portal 之前它被输入卡裁到 9px 看不见；Portal 之后就成了「点了发送还挂着一个空候选框」的可见回归。
- **修法**：`handleSubmit` 里与 `setSlashFilter(null)` 同一处补 `setMentionQuery(null)`；
  切会话的重置处（`setSlashFilter(null)` 的同一段）也补一处 —— 两条浮层收尾口径一致。
  键盘 Enter 路径不受影响（候选打开时它根本到不了 `handleSubmit`，由候选自己处理）。
- **判据（新 3 条，共 9 条全绿）**：
  | # | 守什么 |
  |---|---|
  | MP-7 | 候选打开 + **鼠标点发送** ⇒ 真的发出（`onSend` 收到 `"@"`）、候选消失、输入清空；清空后能再次敲 `@` 打开（证明是收尾不是禁用） |
  | MP-8 | `Escape` 后候选消失、值不变，且 **Enter 不再被候选拦截**（会真的发送）—— 这是「`mentionQuery` 归零」最硬的可见证据 |
  | MP-9 | 切会话（`sessionKey` 变化）时候选随输入一起清空 |
  变异自证：**A4a** 去掉发送处的 `setMentionQuery(null)` ⇒ **MP-7 红**
  （`发送后 @ 候选必须消失: expected <div …> to be null`），其余 8 条仍绿；**A4b** 去掉切会话处那一行 ⇒ **MP-9 红**
  （`切会话后候选必须消失: expected <div …> to be null`）；两次均还原后 9/9 绿。
- **真机复核：本条如实记为「未做真机」**。理由：真机点发送会**真的发起一次模型回合**（花钱、且污染会话），
  而这条是纯前端状态收尾，`jsdom` 判据已覆盖「发送真的发生 + 浮层消失 + 输入清空 + 可再次打开」四个事实；
  同一浮层的 `Escape` / 点外面 / 键盘插入 / 锚定在上一轮已做真机（5.4），本轮只新增这一条收尾路径。
  未做的事不假装做过。

## 6. 门禁（本轮实测）

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run`（全量） | **698 文件 / 8305 通过 + 17 skipped**；1 条红**不在本修复面**（单跑确认：`update-manifest-generator` 报入库 `latest.json` 仍是 `1.16.321` 而 `package.json` 已是 `1.16.322` —— 发版台账，属另一面；本目录只记录，不改别人的面） |
| `npm run audit` | exit 0（末段：`上报点分诊闸门通过：扫描命中 268 处 = 登记表 268 条`、`✅ 语法门禁通过`、`probe-guard 自证 26/26`、`✅ 可达性门禁通过`） |
| `npm run audit:knip`（knip-gate） | `✅ 没有增长`（exports 49/49、types 21/21、duplicates 10/10；entry 20 = 可达性白名单 20） |
| `node tools/audit/scan-report-sites.mjs --check` | `扫描命中 268 处 = 登记表 268 条（triaged 268 / pending 0）`，漂移/过期/缓存漂移均为 0 |
| `node tools/mutate/check-artifacts.mjs`（check-artifacts） | `分诊闸门通过：登记波次 46 个，全部有可用且未过期的变异证据` |
| `npx vitest run src/test/mention-menu-portal.test.tsx` | **9/9 绿**（MP-1..9） |
| `node tools/audit/scan-style-literals.mjs --check` | `✅ 棘轮通过：11 个族全部不超过基线` |
| `node tools/ui-audit/css-contract.mjs`（快照核对） | `CSS 有效声明快照 —— 比对 2886 个类` → `✅ 无变化` |
| `npx vitest run src/test/css-integrity.test.ts` | **10/10 绿**（含 `CSS-INTEGRITY-7`） |
| `npx vitest run src/test/style-token-gates.test.ts` | **40/40 绿**（含 `LIT-5`） |

## 7. 未做 / 未验（如实）

1. **`@` 提及候选被裁剪**（2.2 的旁支缺陷）—— **本轮已修**（见第 5 节：Portal 化 + 6 条判据 + 两次变异 +
   修复后真机量测/截图/键盘/鼠标/resize 复验）。它**不是**插件下架引入的（渲染链在 `InputArea` 里，
   与那 4 个服务无关），是按「发现问题就修」的纪律顺手收掉的。
2. **技能安装/卸载/启停没有真做**：安装要写用户真实技能目录、卸载会删用户文件；内置技能的开关本身
   `disabled`，因此「启停」只验证了开关原语渲染，没有验证停用效果。
3. **预设切换只验证了「切换生效 + 事件 + 持久化键」**，没有跑一次带工具调用的回合去观察审批弹窗差异
   （`ask` vs `full` 的差异在工具审批链路上；本轮不发版、不跑模型回合）。
4. 预设切换在**项目维度**写了一次 override：`codem-security-mode-project:C:\mimo-gui = full`
   （与全局 `full` 同值，行为不变；这是 `PermissionPresetSelector` 在有 `projectPath` 时的正常写路径）。
   ~~另外观察到该组件一次点击会派发**两次**同值事件~~ —— **本轮已修**（见 5.5），修复后每次点击恰好一条事件。
5. **走查①的实例在收尾前自行退出**（PID 19692 在最后一次点击后消失，`tasklist` 为空，因此没有 `taskkill`）；
   走查②（exact HEAD，PID 18760）是**按 PID 显式 kill**的（`taskkill /PID 18760 /T /F`），全程未用 `/IM`；
   收尾后还起过一次**只为清理输入框残留草稿**的实例（PID 25204，同样按 PID kill，`security-mode` 复核仍为
   `完全访问`）。前者的形态与交接里已记录的「真机回合末进程消失（未定性 → 后定性为互踩）」一致。
6. **同一实例上出现过另一路驱动**：运行时日志有非本路发起的
   `exec start … cmd=node -v`、`cmd=git -C 'C:\mimo-gui' rev-parse --is-inside-work-tree`，
   9222 那个实例的输入框里还出现过一条 `C:/Users/abee/.dsh/…/bash-win32-x64/`（我清空时被草稿回填干扰过一次）。
   处置：改用**独立端口 9333 + 单次受控实验**（清空后 4 秒零输入事件、敲 `/` 只产生 1 条 `insertText`），
   本报告的每条断言都取自我自己那次 CDP 调用的返回值。
7. **没有把新判据登记进 `docs/HANDOFF-NEXT-SESSION.md`**：该文件本轮由另一路并行追加，逐行 `git add`
   无法只挑自己的段落，为避免把对方的未完成内容带进提交，本轮只写在本目录与本判据文件头里。
