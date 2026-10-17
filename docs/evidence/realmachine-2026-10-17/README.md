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

> ⚠️ 旁支缺陷（**与插件下架无关，本轮未修**）：`@` 候选虽然渲染了 20 条真实条目，但在当前布局里被
> `.input-area.input-card-container{overflow:hidden;height:135px}` **裁剪**（`elementFromPoint` 在候选位置上
> 命中的是 `.rich-content`，截图上完全看不到候选框）。`/` 菜单没有这个问题 —— 它显式 Portal 到 `document.body`
> （`InputArea.tsx` 里有注释「避免被 overflow:hidden 裁剪」），而 `MentionAutocomplete` 是直接渲染在
> `.input-textarea-row` 里。下一步：把提及面板也改成 Portal（或把它的锚点移出裁剪容器）。
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

## 5. 门禁（本轮实测）

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run`（全量） | **695 文件 / 8283 通过 + 17 skipped**（基线 693 / 8267 + 17：+本判据 1 文件 5 例，+ 另一路并行改动 1 文件 11 例） |
| `npm run audit` | exit 0（末段：`分诊闸门通过：登记波次 44 个…`、`✅ 语法门禁通过`、`probe-guard 自证 26/26`、`✅ 可达性门禁通过`） |
| `npm run audit:knip`（knip-gate） | `✅ 没有增长`（exports 49/49、types 21/21、duplicates 10/10；entry 20 = 可达性白名单 20） |
| `node tools/audit/scan-report-sites.mjs --check` | `扫描命中 268 处 = 登记表 268 条（triaged 268 / pending 0）`，漂移/过期/缓存漂移均为 0 |
| `node tools/mutate/check-artifacts.mjs`（check-artifacts） | `分诊闸门通过：登记波次 44 个，全部有可用且未过期的变异证据` |

## 6. 未做 / 未验（如实）

1. **`@` 提及候选项被裁剪**（2.2 的旁支缺陷）—— 只做了取证，没有修；它**不是**插件下架引入的
   （渲染链在 `InputArea` 里，与那 4 个服务无关）。
2. **技能安装/卸载/启停没有真做**：安装要写用户真实技能目录、卸载会删用户文件；内置技能的开关本身
   `disabled`，因此「启停」只验证了开关原语渲染，没有验证停用效果。
3. **预设切换只验证了「切换生效 + 事件 + 持久化键」**，没有跑一次带工具调用的回合去观察审批弹窗差异
   （`ask` vs `full` 的差异在工具审批链路上；本轮不发版、不跑模型回合）。
4. 预设切换在**项目维度**写了一次 override：`codem-security-mode-project:C:\mimo-gui = full`
   （与全局 `full` 同值，行为不变；这是 `PermissionPresetSelector` 在有 `projectPath` 时的正常写路径）。
   另外观察到该组件一次点击会派发**两次**同值事件（`handleSelect` 与 `onModeChange` 各写一次），
   本轮未改，登记为旁支问题。
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
