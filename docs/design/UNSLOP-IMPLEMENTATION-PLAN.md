# Codem Unslop 视觉重构实施计划

> 状态：方向已认可，待执行  
> 方向稿：[unslop-codem-v1.html](unslop-codem-v1.html)  
> 截图：[主界面](unslop-chat.png) · [任务](unslop-tasks.png) · [记忆](unslop-memory.png) · [设置](unslop-settings.png)  
> 本计划面向**新对话执行**。不要在旧对话里继续做实现；旧对话只保留决策与验收结论。

---

## 0. 一句话结论

Codem 不是“改一个页面”，而是：

- **`src/components` 下 201 个 `.tsx`**（含 15 个 task-center、7 个 PPT、8 个 rich-content、14 个 ui 基础件）；
- **25 个 `*Panel.tsx`、12 个 `*Dialog.tsx`**；
- **22 个设置子页**，另有独立设置子面板；**19 个全屏 Modal 页**；
- **10 个 CSS 文件**，主 `src/styles.css` 约 **717 KB / 127 个分区 / 23 个媒体查询**；
- **约 1222 处内联 `style={{...}}`**，708 处 `btn/button/pill/chip/card` 类名；
- 三套皮肤：default / hub / dream。

因此不能“一把 CSS 重写”。正确路线是：

> **先冻结行为 → 建 token + 基础组件 → 按“壳层 → 聊天 → 任务/团队/记忆 → 设置 → 知识/文档/媒体 → 文件/Git/插件 → 三套皮肤 → 手机端 → 插件 UI”分批迁移 → 最后清理旧样式并回归。**

每一批都必须能独立截图、独立回滚、独立跑门禁。

---

## 1. 已认可的方向

### 产品

本地优先的桌面 AI 编程代理，把对话、计划、工具调用、验证串成一条可审计的工作流。

### 性格

精确、技术、克制，有一点温度。不是“电子幽灵”，也不是“赛博管家”。

### 世界

工程工作台、终端、图纸、机房。不是紫色 SaaS 仪表盘，也不是游戏大厅。

### 两个高信息时刻

1. **diff / 验证结果**
2. **上下文时间轴 / 任务图**

### 签名

细绿色状态点 + 等宽元数据（`ctx 68%`、`12 tools`、`2m 14s`）。  
不再用 emoji 当签名。

### 明确不做

- 不把界面变成 landing page；
- 不为了“高级感”降低信息密度；
- 不用新的装饰（噪点、发光边框、玻璃）替代旧装饰；
- 不改业务流程、状态管理、存储、工具调用、权限和事件。

---

## 2. 范围

### 2.1 In scope：桌面 + 全部皮肤 + 手机 + 插件（游戏除外）

| 区域 | 代表组件 | 约数量 |
|---|---|---:|
| 应用外壳 | `TitleBar`、`TopNavbar`、`AppMenuBar`、`Sidebar`、`PanelSidebar`、`RightSidebar`、`Workbench`、`HubLayout`、`DreamLayout`、`BootSplash` | 12 |
| 聊天 / 上下文 | `ChatPanel`、`MessageBubble`、`ToolCallCard`、`InputArea`、`ComposerBadges`、`ContextMonitor`、`WaterLevelBanner`、`StatsLine`、`TurnStatus`、`ContinueBar`、`FullHistoryPanel`、`SegmentDivider`、`ContextBadgeList`、`DiffViewer`、`DiffBlockCard`、`InlineDiffReview` | 30+ |
| 任务 / 团队 | `TaskCenter` + `task-center/*`（15 文件）、`AgentManager`、`AgentDetail`、`AgentPanel`、`AgentTeamsPanel`、`IssueDetailPanel`、`TeamTab` | 25+ |
| 记忆 | `MemoryManager`、`MemoryCheckupView`、`PromptDebugger`、`DecisionTray`、团队记忆面板 | 8 |
| 设置 | `SettingsPanel`、`SettingsParts`、`LayeredSettingsPanel`、`OllamaSettingsPanel`、`VoiceSettingsPanel`、`ModelProfilePanel`、`GitEnvSettings`、`RemoteAccessSettings`、`DeviceSyncSettings`、`TokenPricesPanel`、`ComputerUseSettings`、`SecretStorageSetting`、`WechatSettings`、`PetMarketDialog` | **22 个子页** + 8 子面板 |
| 知识 / 文档 / 媒体 | `NotebookManager`、`NotebookWorkspace`、`NoteEditor`、`NbChatPanel`、`DocxViewer`、`PdfViewer`、`ExcelViewer`、`ImageGallery`、`AudioPlayer`、`VideoPlayer`、`KnowledgeGraphView`、`SourceViewer`、`SourceReferences`、`DocPipeline` 相关 | 30+ |
| 文件 / Git / 终端 | `FileExplorer`、`FileEditor`、`GitInfoPanel`、`GitBranchSelector`、`GitHubCloneDialog`、`TerminalPanel`、`JobsPanel`、`FileLinkContextMenu` | 15+ |
| MCP / 技能 / 插件 | `McpManager`、`McpMarketplace`、`SkillManager`、`PluginManager`、`FreeModelPluginCard`、`StackMarketSection`、`zvec` | 15+ |
| 目标 / 自动化 / CI | `GoalModeBar`、`GoalBar`、`PipelineNextStepDialog`、`CicdPanel`、`TrajectoryPanel`、`PlanApprovalCard`、`ClarificationForm` | 12+ |
| 引导 / 错误 / 恢复 / 宠物 | `BootstrapWizard`、`OnboardingTour`、`AppErrorBoundary`、`RecoveryPanel`、`SessionRecovery`、`PetWindowApp`、`PetSprite`、`PetMarketDialog` | 15+ |
| 共享基础件 | `src/components/ui/*`（dialog、popover、dropdown、badge、card、switch、tooltip、Skeleton…） | 14 |
| PPT 编辑器 | `src/components/ppt/*` 的**编辑器 chrome** | 7 |
| 皮肤 | `skin-hub.css`、`skin-dream.css`、`SkinSelector`、`skin-tokens.ts`；hub/dream 与 default 同一组件体系，仅换世界/表面 | 3 套 |
| 手机端 | `packages/ui/src/*`（mobile-app、shell、chat-platform、session、changes、file-browser、pairing、approval、diff、message、tool-card、ui.css） | 34 文件 / 约 59 KB CSS |
| 插件 UI | `src/plugins/library-ops/*`（20 个 tsx + 69 KB CSS）、plugin-market 卡片；`shell-ops` 无 UI | 插件 1 套 + 市场 |
| Android 宿主 | `android-shell/*` 的 WebView 壳、`packages/host/web/ui.css` | 集成层 |

### 2.2 Out of scope（本轮不做）

- `src/plugins/monopoly-game/*`：游戏先不做；保留自身视觉，只保证 token 不破坏可读性。
- `src/plugins/shell-ops/*`：无 UI，只做 provider/policy，不在视觉范围。
- PPT/文档的**用户内容**（幻灯片主题、文档内容、代码高亮、图表数据色）：只改编辑器 chrome，不改用户创作内容。
- 模型输出、用户消息、导入的 HTML/Markdown 内容：不做“去 emoji”清理。
- 第三方插件/市场页里由远端提供的图片/描述：保留原文，只改容器。

---

## 3. 优化目标（可验收）

### 3.1 视觉一致性

| 目标 | 验收 |
|---|---|
| 所有页面使用同一中性 surface 阶梯 | 页面/卡片/浮层/输入框无自造灰色；色值来自 token |
| 只有一个 accent | 主操作、当前项、一个关键数字；其他颜色只表意 |
| 无紫色 chrome | 用户气泡、active nav、普通按钮、统计数字不再用紫色 |
| 无 emoji 控件/状态/标题 | 核心 UI/插件 chrome 的 emoji = 0；允许用户内容/游戏内容/远端描述 |
| 一套图标 | lucide 16/18、stroke 1.5；无混用字号/颜色 |
| 一套字体 | UI 系统无衬线 + mono 元数据；标题不超过 500/600 |
| 一套圆角/间距 | 4px 阶梯；按钮 8、卡片 10–12、面板 14 |
| 无 raw Markdown | `**`、`###` 等不出现在渲染文本 |
| 无营销/口语 | 术语表统一；无感叹号、无“一键/开箱即用/放心/电子幽灵” |

### 3.2 可用性

- 正文对比度 ≥ 4.5:1，大字号 ≥ 3:1；muted 只用于 meta。
- 所有图标按钮有 `aria-label`；键盘焦点可见。
- 不改键盘快捷键、焦点顺序、`data-testid`、ARIA role。
- 模态/抽屉/菜单层级符合 `dialog-layer-contract`；不在模态里再开模态。
- 1024 / 1280 / 1440 / 1920 宽度不溢出、不塌陷、不遮挡。

### 3.3 工程

- `tsc` 0；全量测试 0 失败；UI/CSS/对比度/布局门禁全绿。
- UI 一致性基线只降不升。
- 不新增硬编码颜色（数据可视化/用户内容除外）。
- 每批可独立回滚；不修改业务逻辑。

### 3.4 优化项目清单（按优先级）

| 优先级 | 优化项 | 现状/证据 | 目标 | 批次 |
|---|---|---|---|---|
| P0 | 三份主区 | App.tsx 复制 3 次 | 公共 WorkspaceFrame | 1A |
| P0 | 紫色 accent 溢出 | 用户气泡/导航/数字/按钮全是紫；`--accent:#7c6cf0` | 琥珀；accent 只保留主操作/当前项/一个关键数字 | 1B–6A |
| P0 | 彩色渐变/光斑/glow | ambient radial、hub 橙蓝光斑、`--shadow-glow` | 无彩色渐变/glow；depth 用中性 step + hairline | 1B–6A |
| P0 | emoji 控件/状态 | Settings/Git/Diff/Context/反馈等大量 emoji | 核心 UI/插件 chrome emoji=0；lucide + 状态点 | 1B–5B |
| P0 | 字体/圆体 | AlimamaFangYuanTi 圆体 | 系统无衬线 + mono；400/500 | 1B |
| P0 | 口语化人格 | 电子幽灵/赛博管家/数字精灵/“准备好了开始吧” | 研究/运维/文档助手 + 陈述句 | 1B–3 |
| P0 | 营销化中文 | 一键/开箱即用/放心/丝滑/无缝/魔法/神器 | 禁用词表；说清“做什么” | 1B–5 |
| P0 | greeting/感叹号/句号 | 欢迎/！/短标签带句号 | 无 greeting、无感叹号、标签无句号 | 1B–3 |
| P0 | raw Markdown | 记忆面板显示 `**...**` | 正常渲染，0 处 raw markdown | 2 |
| P0 | 弹窗各自为政 | 手写 `.modal-editor`、层级风险 | 统一 Dialog/Drawer + 层级契约 | 0–1B |
| P0 | 手机端旧视觉 | 独立 `packages/ui`，34 文件 | 同 token/组件，完整手机 UI | 6B–6C |
| P1 | 四等统计卡/数字墙 | 任务中心 4 卡、记忆 7 连数字 | 摘要 + 非对称内容 + 3 个关键数字 | 2 |
| P1 | 胶囊海/圆角失控 | 设置/身份/状态大量 pill、9999 | 控件 8、卡片 10–12、面板 14 | 2–3 |
| P1 | 设置 22 页不一致 | 行高/label/选择器各异 | 统一 SettingRow/Select/Segmented | 3 |
| P1 | 图标系统混乱 | emoji + 多尺寸/多颜色 | lucide 16/18、stroke 1.5、一枚状态点 | 1B–5B |
| P1 | 聊天头部图标拥挤 | 图标多、优先级别不清 | 3 个 + overflow | 1B |
| P1 | 空/错/加载状态 | 各页自造 | 统一 EmptyState/ErrorState/Skeleton | 1B–5 |
| P2 | 字体层级/大写标签 | 25 处 uppercase、字号多 | type scale；不用 uppercase 宽字距 | 1B–6A |
| P2 | 数字格式/假数据 | 数字格式不一、`$123,456` 风险 | tabular-nums；一个格式；可信数据 | 2–4 |
| P2 | 图表彩虹/每卡一图 | 彩色统计/图表过多 | 1–2 series，一个主图，muted grid | 4 |
| P2 | 缺少“唯一亮点” | chrome 抢颜色，内容无焦点 | 每个页面只留 1 个 rich moment | 1B–4 |
| P2 | 低频页面模板感 | MCP/技能/市场/PPT/文档 | 统一 chrome，不碰内容 | 4–5 |
| P2 | 动效杂 | pulse/shimmer/transition-all | 一套 ease + 语义动效 | 1B + 7 |
| P2 | 亮色主题 | 仅深色有方向稿 | 亮色同 token 验收 | 6A |
| P2 | 皮肤分裂 | hub/dream 独立布局/独立世界观 | 三套共享 WorkspaceFrame + token，琥珀统一 | 6A |
| P2 | 插件分裂 | library-ops 自有 CSS/emoji/像素世界 | 插件 chrome 统一；内容场景可保留 | 5B |

---

## 4. 设计契约

### 4.1 颜色 token（默认深色）

```css
--ui-bg: #0e1012;
--ui-sidebar: #111316;
--ui-surface: #15181c;
--ui-surface-raised: #1a1e22;
--ui-surface-active: #20252a;
--ui-line: rgba(233, 230, 223, .09);
--ui-line-strong: rgba(233, 230, 223, .16);
--ui-text: #e9e6df;
--ui-text-secondary: #a8aaa5;
--ui-text-muted: #7c817b;
--ui-text-dim: #5f655f;
--ui-accent: #c6a15b;
--ui-accent-hover: #d2ad66;
--ui-accent-ink: #17130c;
--ui-success: #78b892;
--ui-danger: #d47c74;
--ui-info: #8aa6c8;
```

规则：

- `--ui-accent` 使用面积 **< 5%**；不准用于大面积卡片、背景、用户气泡。
- 绿色/红色只表意；不做装饰。
- 数据图表可用 2–3 个 series 色，但必须走独立 token，不抢 UI accent。
- 不允许径向/线性彩色渐变作背景；中性 surface 可用极轻的 `linear-gradient` 做深度，但不得有 hue 变化。

### 4.2 亮色主题（必须与深色同批验收）

建议初值（执行时用对比度测试校准）：

```css
--ui-bg: #f7f5f0;
--ui-sidebar: #f2efe8;
--ui-surface: #fffdf9;
--ui-surface-raised: #efece5;
--ui-surface-active: #e8e3da;
--ui-line: rgba(29, 27, 23, .10);
--ui-line-strong: rgba(29, 27, 23, .18);
--ui-text: #1d1b17;
--ui-text-secondary: #565a54;
--ui-text-muted: #73776f;
--ui-accent: #8a6a2f;
--ui-accent-ink: #fffdf9;
--ui-success: #2e7d57;
--ui-danger: #b3413b;
--ui-info: #3f6387;
```

### 4.3 字体

```css
--ui-font-ui: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI",
  "Noto Sans SC", sans-serif;
--ui-font-mono: "Cascadia Code", "IBM Plex Mono", "SFMono-Regular",
  ui-monospace, monospace;
```

- 不引入网络字体；不依赖用户安装 IBM Plex。
- UI 字重：400 / 500；页面标题最多 600。
- 字号：meta 11–12，正文 13–14，页面标题 24–28，对话标题 22–24。
- 不使用 uppercase 宽字距标签；代码/缩写除外。
- 数字使用 tabular figures（`font-variant-numeric: tabular-nums`）。

### 4.4 图标

- 统一 `lucide-react`，尺寸 16/18，stroke 1.5。
- 状态用 `StatusDot`（5px 圆点 + 文字）；不用 emoji。
- 图标颜色只用 `text-secondary` / `text-muted`；accent 只用于当前项。
- 所有图标按钮必须有 `aria-label` 和 28/32px 点击区。

### 4.5 间距 / 圆角 / 阴影

- 间距：4 阶梯；控件内 4–12；组间 12–24；区块 32–48。
- 行高：compact 28–32，default 34–36，touch 40–44。
- 圆角：控件 8，卡片 10–12，面板 14；`9999px` 只用于开关、头像、状态点。
- 阴影：深色用 surface step + hairline；浮层最多一档中性阴影；不使用彩色 glow。

### 4.6 动效

- 一条 ease：`cubic-bezier(.22,1,.36,1)`。
- 120–180ms：hover/press；160–220ms：菜单；300–500ms：面板进入。
- 只动 `color/background/border/opacity/transform`；不动 width/height/top/left。
- 删除装饰性 pulse/glow/shimmer；保留“正在生成/在线”这类有语义的 pulse。

### 4.7 浮层层级

必须沿用并测试：

- `--z-modal` < `--z-dialog-overlay` < `--z-dialog`
- `alert-dialog-content` 用 `--z-dialog`，不得回落到 dropdown
- 模态内破坏性操作使用**内联确认**，不嵌套模态
- Radix Dialog / Drawer / Popover 统一走 `src/components/ui/*`
- 不修改现有 `data-testid`、`role`、`aria-*`

---

## 5. 工程策略

### 5.1 分支与开关

- 分支：`design/unslop-v2`，从 `master` 切出。
- 不直接改 `master`；每批一个可回滚 commit。
- 迁移期新增 `src/styles/unslop-v2.css`，在 `main.tsx`/入口最后 import。
- 用 `document.documentElement.dataset.ui = "v2"` 启用；默认可先关闭，验收时打开。
- 旧 `styles.css` 不动大结构；v2 只覆盖 token 和已迁移组件。
- 全部批次完成后，把 v2 合并回 `styles.css`，删除开关和重复层。

> 不推荐一上来改 `styles.css` 的 717KB。先用覆盖层能保证“旧页面仍可回退”，也方便逐页截图对比。

### 5.2 基础组件先行

当前只有 14 个 `components/ui/*`，且缺少 Button/Input/Select/Segmented/Tabs/Table 等。先补齐：

| 新组件 | 替代 |
|---|---|
| `Button` / `IconButton` | 各页 `btn`、`icon-btn`、裸 `<button>` |
| `Input` / `Textarea` | `.input`、`.search`、内联输入 |
| `Select` | 原生 select + 各页自造下拉 |
| `SegmentedControl` | 胶囊选项、主题切换 |
| `Tabs` | 任务中心/设置/详情页 tab |
| `Badge` / `StatusDot` | 彩色 pill、emoji 状态 |
| `Card` / `Panel` | 各页自造卡片 |
| `Dialog` / `Drawer` / `Popover` / `Menu` / `Tooltip` | Radix 裸用、自造 portal |
| `EmptyState` | 各页“暂无数据” |
| `Table` / `ListRow` | 记忆/任务/用量列表 |
| `Toast` | 现有 ToastNotification 统一 |

原则：**先兼容旧 class，再逐页替换**，不要一次删除 `.btn` 等旧类。

### 5.3 先解决三个结构性问题（否则一定不一致）

这次盘点确认了三件必须先处理的事，**不能直接开始逐页换色**：

1. **主区在 `App.tsx` 里被复制了三份。**  
   `skin==="hub"`（约 5634–5765）、`"dream"`（约 5766–5888）、默认（约 5889–6032）各自渲染一遍
   `Sidebar + ChatPanel + 终端抽屉 + 右栏`。如果不先抽公共壳层，任何主界面改动都要改三次，
   而且三份会逐渐漂移。  
   **处理：Batch 1 先做纯结构重构**，把三份抽成 `WorkspaceFrame`（或等价组件），
   三套 skin 只传 token/装饰差异；不改状态、不改事件、不改测试 id；用 DOM/截图对比证明等价。

2. **`src/components/ui/` 的 shadcn 套件基本是死代码。**  
   全仓以 `components/ui/<name>` import 的只有 `tooltip` 和 `portal`，且仅 `App.tsx` 一处；
   `dialog/alert-dialog/card/badge/dropdown-menu/popover/switch/progress` 等零引用。
   实际弹窗几乎都是手写 `.modal-overlay > .modal-editor`。  
   **处理：Batch 0 不假设“已有基础件可用”**；先建立真正被消费的 Button/Input/Dialog 等，
   或把现有 Radix 包装接进页面。不要花时间美化死代码。

3. **UI 可被插件槽整体替换。**  
   `BootstrapWizard`、`NotebookWorkspace`、`OnboardingTour` 等会通过
   `src/core/ui-plugins/ui-panels/index.ts` 重新注册；只写 app 级 CSS 覆盖会漏掉插件贡献的 UI。  
   **处理：所有视觉规则落到组件本体/共享基础件；不依赖页面级全局 CSS 覆盖。**

另外：应用**没有路由**，全部是 `App()` 内的 state 开关 + Slot；唯一“URL”是 `#settings`。
本计划不引入 router，不改变导航方式。

### 5.4 不改变行为

允许：

- 增加 className / 包裹层；
- 替换图标、文案、颜色、间距；
- 用共享组件替换等价 DOM；
- 增加 `aria-label`（不删旧的）。

禁止：

- 改事件处理、状态、store、IPC、存储、工具调用；
- 改 `data-testid`、`role`、键盘快捷键；
- 改 Modal 的 open/close 逻辑和层级；
- 为了样式删功能、删按钮、合并入口；
- 改用户内容渲染（Markdown、代码高亮、文档内容）。

---

## 6. 分批实施

> 每批结束必须：截图 + 目标测试 + 全量 UI 门禁 + 更新 `docs/design/UNSLOP-PROGRESS.md`。  
> 不要求每批跑完整 10168 用例；但 Batch 1A/1B/3/5B/6A/6B/7 必须跑全量。  
> 总工期估算：**27–37 个开发日**（含三皮肤、手机、插件；不含真机排队）。

### Batch 0：基线与护栏（0.5–1 天）

**目标**：不动视觉，建立可回滚、可对比、可审计的底座。

文件：

- `docs/design/DESIGN-DIRECTION.md`（从本计划抽 token/文案/图标规则）
- `docs/design/UNSLOP-PROGRESS.md`（批次、截图、已知差异）
- `src/styles/unslop-v2.css`（空骨架 + token）
- `src/components/ui/` 新增基础件骨架
- `src/test/ui-no-emoji.test.ts`（新增，允许用户内容/插件白名单）
- `src/test/ui-copy-guard.test.ts`（新增，禁用语/raw markdown）

验收：

- `tsc` 0；
- 旧 UI 截图与未改前逐像素一致（开关关闭）；
- `data-ui="v2"` 打开只改 token，不改变布局；
- 记录 6 张基线截图：chat/tasks/memory/settings/light/modal。

### Batch 1A：抽取公共壳层（1 天，纯重构，不换视觉）

**目标**：把 `App.tsx` 里 hub/dream/default 三份主区抽成公共 `WorkspaceFrame`。  
三套 skin 只保留 token/装饰差异，渲染树等价；先证明 DOM/testid/键盘不回归，
再开始换视觉。否则后面每一处主界面改动都要改三遍。

**验收**：

- 三套 skin 切换前后 DOM 结构/`data-testid` 对比（允许相同 class 包裹层）；
- 截图逐像素近似（只允许无意义空白差）；
- 不改变发送、停止、切换会话、终端抽屉、右栏；
- 不允许用“隐藏 hub/dream”规避一致性；若抽取风险超预期，允许 hub/dream 暂时继续走旧渲染，但 Batch 6A 前必须全部接入 `WorkspaceFrame`。

### Batch 1B：壳层 + 聊天视觉（3–4 天）

**目标**：用户 80% 时间看到的界面先统一。

文件：

- Shell：`TitleBar`、`TopNavbar`、`AppMenuBar`、`Sidebar`、`PanelSidebar`、`RightSidebar`、`Workbench`、`HubLayout`、`DreamLayout`、`BootSplash`
- Chat：`ChatPanel`、`MessageBubble`、`ToolCallCard`、`ToolCallGroup`、`InputArea`、`ComposerBadges`、`ContextMonitor`、`WaterLevelBanner`、`StatsLine`、`TurnStatus`、`ContinueBar`、`FullHistoryPanel`、`SegmentDivider`、`ContextBadgeList`、`DiffViewer`、`DiffBlockCard`、`InlineDiffReview`、`FeedbackButtons`、`MessageActions`
- 浮层：`SlashCommandMenu`、`MentionAutocomplete`、`MentionMenuPortal`、`SearchDialog`、`ToastNotification`
- 基础件：Button、IconButton、Input、Textarea、Select、Segmented、Tabs、Badge、StatusDot、Card、EmptyState、Dialog、Drawer、Popover、Menu、Tooltip

**交付**：

- 用户气泡中性化；active nav 中性 + 2px accent；
- 头部图标收敛到 3 个 + overflow；
- 任务完成 pill → 安静状态；
- diff/test row 作为唯一 rich moment；
- 右侧 Context 标尺（可先只做 chat，不强行所有页面）；
- 聊天壳层 emoji 清零。

**验收**：

- 主界面截图（dark + light）；
- `ui-consistency`、`css-integrity`、`dialog-layer-contract`、`layout-contract`、`icon-button-a11y`、`ui-accessible-names`；
- 键盘：Tab/Enter/Escape/焦点环；
- 不改变发送、停止、压缩、切换会话行为。

### Batch 2：任务 / 团队 / 记忆（3–4 天）

文件：

- `TaskCenter.tsx` + `src/components/task-center/*` 15 文件
- `AgentManager`、`AgentDetail`、`AgentPanel`、`AgentTeamsPanel`
- `IssueDetailPanel`、`TeamTab`、`DelegationTab`、`InboxTab`、`BoardTab`、`SquadTab`
- `MemoryManager`、`MemoryCheckupView`、`PromptDebugger`、团队记忆面板、`DecisionTray`
- 相关 CSS：`task-center.css`、`codem-ui.css` 中对应段

**交付**：

- 四张等宽统计卡 → 一条摘要 + 非对称任务列表；
- 任务行统一 checkbox/状态点/进度线；
- 团队/活动放右侧窄栏；
- 记忆七连数字 → 3 个数字；
- 修复 raw Markdown；scope 用 `Team/Project/Conversation/Platform`；
- 空/加载/错误状态统一。

**验收**：

- 任务中心 8 个 tab 全部打开无布局塌陷；
- 记忆审批/撤销/搜索/批量操作不回归；
- 相关测试：`memory-*`、`task-center-*`、`agent-teams-*`、`ui-consistency`。

### Batch 3：设置 + 引导 + 错误恢复（2–3 天）

文件：

- `SettingsPanel.tsx`、`SettingsParts.tsx`、`LayeredSettingsPanel.tsx`
- `OllamaSettingsPanel`、`VoiceSettingsPanel`、`ModelProfilePanel`、`GitEnvSettings`、`RemoteAccessSettings`、`DeviceSyncSettings`、`TokenPricesPanel`、`ComputerUseSettings`、`SecretStorageSetting`、`WechatSettings`
- `BootstrapWizard`、`OnboardingTour`、`BootSplash`
- `AppErrorBoundary`、`RecoveryPanel`、`SessionRecovery`、`ConfirmDialog`、`CloseConfirmDialog`、`PermissionDialog`

**交付**：

- 22 个设置子页统一：section 标题、row 高度、label 宽度、select/segmented；
- `我是什么/叫我什么` → `助手身份/称呼/回复风格`；
- 去掉身份 emoji 选择器、底栏 emoji；
- 主题切换/语言切换保留；
- 引导页只保留 3–5 个命名角色，不用 emoji。

**验收**：

- 设置每个 tab 截图；无重叠（当前方向稿曾出现 nav/content 重叠，必须防）；
- 所有开关/保存/取消/返回可用；
- 浅色主题；
- `settings-*`、`theme-*`、`skin-*`、`layout-contract`。

### Batch 4：知识 / 文档 / 媒体 / 目标（4–5 天）

文件：

- `NotebookManager`、`NotebookWorkspace`、`NoteEditor`、`NbChatPanel`、`notebook-workspace.css`
- 文档流水线：`doc-pipeline` 相关组件、`SourceViewer`、`SourceReferences`、`DeliverableFiles`
- 媒体：`DocxViewer`、`PdfViewer`、`ExcelViewer`、`ImageGallery`、`AudioPlayer`、`VideoPlayer`、`ShikiCodeBlock`（只改容器/工具条）
- 目标：`GoalModeBar`、`GoalBar`、`PipelineNextStepDialog`、`PlanApprovalCard`、`ClarificationForm`
- `CicdPanel`、`TrajectoryPanel`、`UsageStats`、`UsageVisuals`
- PPT：`ppt/EditorToolbar`、`PPTEditor`、`PresentationMode`、`PropertyPanel`、`SlideCanvas` 的**chrome**；不覆盖用户幻灯片主题。

**交付**：

- 文档/媒体查看器的工具栏、侧栏、空状态、错误状态统一；
- 富内容不强制改成 UI 配色；
- 目标条从彩色 chip 改为安静状态 + 进度；
- 图表/用量保留数据色，但限制 series 数量。

**验收**：

- PDF/DOCX/Excel/图片/视频至少各打开一个 fixture；
- 知识图谱/文档流水线 tab 不塌；
- PPT 编辑器可打开/切页/编辑文字，内容颜色不被覆盖；
- `doc-*`、`library-*`、`ui-*`。

### Batch 5A：文件 / Git / 终端 / MCP / 技能 / 插件市场（3–4 天）

文件：

- `FileExplorer`、`FileEditor`、`DiffViewer` 旁支、`FileChangesList`、`FileLinkContextMenu`
- `GitInfoPanel`、`GitBranchSelector`、`GitHubCloneDialog`、`GitEnvSettings`（已含设置）
- `TerminalPanel`、`JobsPanel`、`JobsBadge`
- `McpManager`、`McpMarketplace`、`SkillManager`、`PluginManager`、`FreeModelPluginCard`、`StackMarketSection`、`zvec` 卡片
- `src/core/icons/icon-map.ts` 补 ActionIcons

**交付**：

- 文件树/差异/终端统一行高和 mono；
- Git 状态从 emoji 改图标/状态点；
- 市场卡片从“icon + 夸张标题 + pill”改为紧凑列表/卡片；
- 插件市场保留内容，但去掉霓虹/emoji。

**验收**：

- 文件树展开/打开/右键菜单；
- diff accept/reject 不回归；
- 终端/任务面板可开合；
- `ui-shared-file-diff-wiring`、`layout-contract`、`icon-button-a11y`。

### Batch 5B：插件 UI 统一（library-ops，2–3 天）

> 游戏 `monopoly-game` 不做；`shell-ops` 无 UI，不在范围。`library-ops` 是插件，也要统一。

文件：

- `src/plugins/library-ops/components/*`：`LibraryPanel`、`OverviewPanel`、`CostPanel`、`ErrorsPanel`、`EventList`、`TimelinePanel`、`ToolsPanel`、`SettingsPanel`、`charts`、`common`、`icons`
- 场景内容：`LibraryScene`、`PixelLibraryScene`、`SceneFurniture`、`CharacterActor`、`SceneImageCard`、`LibraryOpsBoardView`、`LibraryOpsSceneView`、`LibraryOpsUsageEmbed`、`LibraryOpsViewShell`
- `src/plugins/library-ops/styles/library-ops.css`（约 69 KB）

**规则**：

- 插件壳层、面板、表格、按钮、弹窗、空状态全部用共享组件/token；
- 插件自有的“像素图书馆”属于内容时刻，可以保留，但降低饱和度、去掉霓虹/emoji，不能抢主界面；
- 不改插件业务逻辑/数据/路由；
- 插件 CSS 必须被作用域隔离，不能污染主 UI/手机 UI。

**验收**：

- 插件打开/关闭/切换 tab；
- 插件面板在 1024/1440 不溢出；
- 主 UI 不被插件 CSS 污染；
- `library-ops-*`、`plugin-ui-state-refresh`、`ui-consistency`。

### Batch 6A：三套皮肤全部迁移（2–3 天）

**目标**：default / hub / dream **全部**使用同一组件体系、同一 amber accent、同一文案/图标规则；只保留各自的世界观与表面差异。

文件：

- `src/styles/skin-hub.css`、`skin-dream.css`、`SkinSelector`、`src/core/theme/skin-tokens.ts`
- `src/App.tsx` 的 skin 分支（Batch 1A 已抽公共壳层，这里只接 token）
- `src/test/skin-*`、`dream-skin-tokens*`、`skin-contrast`、`skin-backdrop-vs-native-material`

**具体替换锚点**：

- hub 的 `--hub-color-primary: #ff6b00` / `--accent: #ff6b00` → `var(--ui-accent)`；
  `--backdrop-blob-1/2`（橙/蓝光斑）删除或降到无 hue 的中性层。
- dream 的 `--dream-accent`（从背景图提取）不再参与 UI 取色；
  `--dream-c5/c9/c10/c13/c14` 等粉色派生改为 `--ui-surface-*` / `--ui-accent-soft`；
  背景图可保留，但面板必须回到可读的中性 surface。
- `skin-tokens.ts` 的 `var(--accent, #7c6cf0)` 紫色兜底改为 `var(--ui-accent, #c6a15b)`；
  所有 `#7c6cf0/#8b5cf6/#a78bfa` 只允许出现在历史迁移映射或数据色白名单。

**硬规则**：

- **不再有独立布局/独立组件**；三套 skin 共享 `WorkspaceFrame`，只换 `--ui-*` token 和背景层。
- hub：深黑表面 + amber accent；删除橙/蓝双色光斑、彩色 glow；保留 hub 的深色氛围。
- dream：暖纸/浅色表面 + amber accent；删除粉色 accent/彩色 blob；用户背景图可以保留，但降低存在感，不参与 UI 取色。
- default：石墨 + amber；深/亮双模式。
- 三套皮肤中 **emoji、胶囊、彩色数字规则完全一致**。
- 若某 skin 原本只有单模式（hub 深色、dream 浅色），不强行新造另一模式；但必须在该模式下完整验收。

**验收**：

- default / hub / dream 各一组核心页面截图：chat、tasks、memory、settings；
- 三套不互相污染；切换后无残留颜色/布局；
- `skin-*`、`light-theme-contrast`、`theme-*` 全绿；
- 皮肤选择器自身也使用新 token。

### Batch 6B：手机端完整迁移（3–4 天）

**目标**：手机端不是“共享组件兼容”，而是完整 unslop 视觉；不另立计划。

文件（`packages/ui/src`，34 文件）：

- `mobile-app.tsx`、`shell.tsx`、`chat-platform.tsx`、`components.tsx`
- `session-view.ts`、`create-session-sheet.tsx`、`pairing-gate.tsx`
- `message-bubble.tsx`、`tool-card.tsx`、`markdown.tsx`、`mermaid-diagram.tsx`
- `changes-pane.tsx`、`changes-list.tsx`、`diff-view.tsx`、`patch-diff-view.tsx`
- `file-browser.tsx`、`file-tree-view.tsx`、`detail-pane.tsx`、`info-panel.tsx`
- `approval-card.tsx`、`browser.tsx`
- `ui.css`（约 59 KB）、`packages/host/web/ui.css`、`android-shell` WebView 壳

**移动端规则**：

- 同一套 `--ui-*` 色/字/图标/文案；移动端只改布局与触控尺寸。
- 触控目标 ≥ 44px；安全区；底部 sheet 替代桌面浮层；无 hover-only 操作。
- 手机键盘弹出、返回键、滚动嵌套、横屏、深色/浅色都要验收。
- 桌面与手机 token 必须同源：在 `docs/design/tokens.json` 存 canonical 值，
  用脚本生成 `src/styles/_ui-tokens.css` 与 `packages/ui/src/ui-tokens.css`，
  或至少加 parity test 逐值比对；不允许两套色值漂移。
- 优先覆盖：配对页、会话列表、聊天、输入、审批、变更、文件浏览、Diff、详情、信息面板、内置浏览器。

**验收**：

- `node android-shell/build.mjs --abi x86_64` 构建成功；
- Android 模拟器/真机截图（至少 390×844 + 横屏）；
- `android-shell/spike-ui-shots.mjs` 或 `run-device-cases.mjs`；
- 无设备时只能标 `blocked`，不能写“手机通过”；但代码/模拟器验收必须完成。

### Batch 6C：共享 UI / 宿主 / 集成（1–2 天）

- `packages/host/web/ui.css` 与桌面共享 token 的 parity；
- `android-shell` 启动背景、状态栏、键盘避让；
- 插件 UI 与手机 WebView 的 CSS 隔离；
- 最终三端截图矩阵。

### Batch 7：清理与发布（2–3 天）

- 删除 `unslop-v2.css` 中已合并的临时覆盖；
- 删除废弃 `--shadow-glow`、旧紫色 surface、旧 emoji 映射；
- 更新 `tools/ui-audit/baseline.json`、`css-contract.json`（只降不升）；
- 更新 `docs/UI-DESIGN-SYSTEM.md`、`docs/design/DESIGN-DIRECTION.md`；
- 全量 `tsc` / vitest / cargo / P0 / docs；
- 安装版真机逐页截图；
- 发版（patch 版本；不要和功能改动混在一起）。

---

## 7. 文案与图标清理矩阵

**规模口径（只读 AST 扫描，排除测试/注释）：**

- 1,017 个 `.ts/.tsx`；
- 约 **12,755** 条含 CJK/emoji 的字符串/模板/JSX 文本；
- 其中 `ui + maybe + lang` ≈ **7,272 条用户可见文案**，分布在 **435 个文件**；
- 其余是日志/内部错误/测试。

**结论：不要试图一次重写 7,272 条文案。** 只做三类：

1. **emoji/图标**：全量替换（机械、可扫描）；
2. **禁用词/口语句式**：按词表精确替换（有限）；
3. **高频页面文案**：人工重写 P0/P1 的空状态、错误、引导、设置标签。

### P0：高频壳层（Batch 1）

- 头部/侧栏/输入栏/任务完成/上下文提示/错误提示
- 目标：无 emoji、无感叹号、无“请立即”，状态用短句。

### P1：任务/记忆/设置（Batch 2–3）

- 角色名：`电子幽灵 → 研究助手`、`赛博管家 → 运维助手`、`数字精灵 → 文档助手`；
- `准备好了，开始吧。 → 开始使用`；
- `去市场看看吧~ → 暂无已安装的宠物。打开市场`；
- `一键安装 → 安装`、`开箱即用 → 已内置`、`放心重试 → 可以重试`；
- raw `**...**` 修复；
- 术语表：统一“会话/任务/团队/记忆/上下文/压缩/换段”，见 `DESIGN-DIRECTION.md`。

### P2：低频/编辑器/市场（Batch 4–5）

- PPT/CI/CD/媒体/插件市场；
- 只改 chrome 文案，不改用户内容/第三方描述。

### 机械替换 vs 人工重写

- 机械：emoji → `ActionIcons.*`；`一键安装`、`开箱即用` 等固定词；
- 人工：带语气的句子、错误说明、空状态、引导文案；
- 禁止：用正则全库替换中文，容易破坏代码注释/测试。

---

## 8. 一致性与禁止事项

### 必须

- 所有颜色走 `--ui-*` 或现有语义 token；
- 所有图标走 `ActionIcons/PanelIcons`；
- 所有弹窗/菜单走 `components/ui`；
- 所有按钮/输入/选择器走基础件；
- 所有状态用 `StatusDot` + 文字；
- 所有页面在 1024/1280/1440/1920 与 dark/light 下截图；
- 每批先跑目标测试，再全量。

### 禁止

- 直接改 717KB `styles.css` 全局重写；
- 用新的紫色/渐变/发光替代旧的；
- 为了“统一”删功能、合并入口、改交互；
- 改 `data-testid` / `aria` / 键盘行为；
- 在模态里再开模态；
- 用 emoji 作为图标/状态；
- 在 UI 文案里写 `**` 或 Markdown；
- 直接覆盖用户 PPT/文档内容配色；
- 把游戏/用户内容/插件像素场景本身强行改成工作台风格（插件 chrome 要统一，内容可保留）。

---

## 9. 测试与验收

### 每批必跑

```powershell
npx tsc --noEmit
npx vitest run src/test/ui-consistency.test.ts `
  src/test/css-integrity.test.ts `
  src/test/layout-contract.test.ts `
  src/test/dialog-layer-contract.test.ts `
  src/test/contrast-alpha.test.ts `
  src/test/contrast-luminance-single-source.test.ts `
  src/test/light-theme-contrast.test.ts `
  src/test/icon-button-a11y.test.ts `
  src/test/ui-accessible-names.test.tsx `
  src/test/ui-shared-file-diff-wiring.test.tsx
node tools/ui-audit/scan-ui.mjs --json
node tools/audit/scan-report-sites.mjs --check
npm run audit:style-literals
npm run audit:color-roles
npm run audit:token-hygiene
npm run audit:motion
npm run audit:doc-tokens
```

> `style-literals` / `color-roles` / `token-hygiene` 很可能在迁移时按预期变红。
> **只允许在“确实把硬编码迁进 token”时更新基线，并记录在 progress 文档；禁止用 allowlist 压红。**

### 全量里程碑

- Batch 1A / 1B / 3 / 5B / 6A / 6B / 7：

```powershell
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml --quiet
cargo test --manifest-path src-tauri/codem-db/Cargo.toml --quiet
node tools/marketing/verify-context-os-claims.mjs --mode gate --tier P0
npm run audit:docs
```

手机/共享：

```powershell
npm run typecheck:ui
node android-shell/build.mjs --abi x86_64
node android-shell/spike-ui-shots.mjs
node android-shell/run-device-cases.mjs
```

> 真机不可用时可把真机项标 `blocked`，但模拟器构建/截图/布局验收不能跳过。

### 视觉验收

- 用现有 Edge headless 方式（`layout-contract` 的 helper）或 `docs/design` 的静态截图脚本。
- 桌面：default dark/light、hub、dream 各核心页面截图；关键弹窗加 1024×768。
- 手机：390×844、横屏、深/浅色；配对/会话/聊天/审批/变更/文件/Diff 至少各一张。
- 必须检查：长中文、长英文路径、空状态、加载、错误、滚动条、焦点、安全区、键盘。
- 截图存 `docs/design/audit/<batch>/`，不提交到代码包时可放 `.preview-shot`。

### 通过标准

- 0 失败；UI 一致性 warn/error 不高于基线；
- 无新 `css-class-unused` / `css-var-undefined` / `css-class-cross-file`；
- 无新 hardcoded 颜色（数据可视化白名单除外）；
- 无 emoji 控件；
- 所有弹窗层级正确；
- 无布局塌陷/遮挡/横向滚动。

---

## 10. 风险与决策

| 风险 | 处理 |
|---|---|
| 717KB CSS 改坏全局布局 | v2 覆盖层 + 逐批截图 + layout-contract |
| 200+ 组件无法一次完成 | 12 个工作单元，先壳层/聊天，后低频 |
| 去 emoji 后显得冷/丑 | 保留密度、暖石墨/琥珀；先在真实页面截图评审 |
| 紫色品牌资产丢失 | 已拍板改琥珀；紫色只允许留在 logo 图形，不进 chrome |
| 三套皮肤冲突 | 三套全做；共享 WorkspaceFrame + 同一 `--ui-*` 语义，skin 只换表面/世界 |
| 手机端工作量被低估 | 手机是完整 34 文件 UI，单独 Batch 6B/6C，不按“共享组件兼容”处理 |
| 插件 CSS 污染主 UI | Batch 5B 作用域隔离 + 插件回归 |
| 测试锁 DOM/类名 | 保留 class/testid/aria；新增包裹层；不重命名 |
| 内联 style 1222 处 | 不追求全清；先 token/组件覆盖，后逐页替换 |
| PPT/文档内容配色被覆盖 | 只改 chrome，内容 token 隔离 |
| 文案替换破坏代码/测试 | 只改用户可见字符串；先建词表 + 人工审核 |

### 已拍板（不再询问）

1. **Accent**：琥珀 `#C6A15B`；紫色不进 UI chrome，最多保留 logo 图形。
2. **皮肤**：default / hub / dream **全部做**，不允许隐藏或冻结；共享组件，只换世界/表面。
3. **手机端**：完整做，不另立计划；`packages/ui` + Android WebView 一起验收。
4. **插件**：除 `monopoly-game` 游戏外，插件统一；`library-ops` 纳入 Batch 5B，`shell-ops` 无 UI。

> 新对话不需要再问这 4 项；按已拍板执行。若执行中发现技术不可行，必须先报告再降级，不能自行隐藏页面。

---

## 11. Definition of Done

- [ ] default 深色/亮色、hub、dream **三套皮肤**全部核心表面使用 v2 token；
- [ ] 手机端完整 UI 使用同一套 token/组件规则，不是“只兼容”；
- [ ] `library-ops` 插件统一；`monopoly-game` 游戏按约定不动；
- [ ] 所有用户可见 emoji 清零（用户内容/游戏/远端描述除外）；
- [ ] 所有按钮/输入/选择器/弹窗/菜单走共享组件；
- [ ] 无 raw Markdown、无营销/口语化高频文案；
- [ ] 任务/记忆/设置不再有数字墙、四等卡、胶囊海；
- [ ] 所有弹窗在 1024/1440 不塌、不遮挡、层级正确；
- [ ] 桌面/手机/三皮肤截图矩阵通过；
- [ ] `tsc` 0；全量 vitest 0 失败；cargo 0 失败；UI/CSS/对比度门禁全绿；
- [ ] UI 基线只降不升；
- [ ] 安装版真机逐页截图通过；手机真机无设备时明确 `blocked`，模拟器结果不能写成真机；
- [ ] 文档 `DESIGN-DIRECTION.md` / `UI-DESIGN-SYSTEM.md` 更新；
- [ ] 独立 release commit；不与功能改动混合。

---

## 12. 给新对话的启动提示（可直接粘贴）

```text
你在 C:\mimo-gui（Codem）执行一次全产品 UI unslop 重构。
先读：
1. docs/design/UNSLOP-IMPLEMENTATION-PLAN.md
2. docs/design/DESIGN-DIRECTION.md
3. docs/design/unslop-codem-v1.html + 四张截图
4. docs/project-guide/00-AGENT-HANDBOOK.md、08-ENGINEERING-GATES.md、09-CURRENT-STATE.md
5. docs/UI-DESIGN-SYSTEM.md
6. src/styles.css 的 Design Tokens 段、src/styles/codem-ui.css、src/components/ui/*

整改必须逐项覆盖（不是只换主界面颜色）：
emoji 控件/状态、口语化人格文案、营销化/夸张中文、greeting/感叹号/句号、
紫色 accent 溢出、彩色渐变/光斑/glow、圆体字体/层级/大写标签、
raw Markdown、图标系统/尺寸/stroke、四等统计卡/数字墙、胶囊海/圆角、
间距/行高、数字格式/假数据、图表 series/彩虹、唯一 rich moment、
空/错/加载状态、弹窗层级、亮色、default/hub/dream 三皮肤、手机端完整 UI、
library-ops 插件统一（monopoly 游戏除外）、PPT/用户内容例外。

规则：
- 不改业务逻辑、store、IPC、工具调用、权限、事件、data-testid、aria、键盘行为。
- 先做 Batch 0（token + 基础件 + 截图基线），不要直接改 200 个组件。
- 用 v2 覆盖层，逐批迁移；每批截图 + 目标测试；Batch 1A/1B/3/5B/6A/6B/7 跑全量。
- 禁止 git add -A；每批独立 commit；不混功能改动。
- 已拍板：琥珀 accent；default/hub/dream 全做；手机端完整做；插件统一（游戏 monopoly 除外）。
  不要再问这 4 项，也不要自行隐藏皮肤/手机/插件页面。

先输出 Batch 0 的具体 diff 计划和基线截图，不要开始大规模改页面。
```

---

## 附录 A：表面清单（用于分批，不要求一次全改）

> 计数口径：`src/components` 下 `.tsx` 201 个；`*Panel.tsx` 25 个；`*Dialog.tsx` 12 个；task-center 15；PPT 7；shared ui 14；CSS 10；packages/ui/src 22。

### 外壳 / 导航

`TitleBar`、`TopNavbar`、`AppMenuBar`、`Sidebar`、`PanelSidebar`、`RightSidebar`、`Workbench`、`HubLayout`、`DreamLayout`、`BootSplash`、`WorkspaceBackdrop`、`SkinSelector`

### 聊天 / 上下文 / 工具

`ChatPanel`、`ConversationRoot`、`MessageBubble`、`MessageActions`、`ToolCallCard`、`ToolCallGroup`、`InputArea`、`ComposerBadges`、`ContextMonitor`、`ContextBadgeList`、`WaterLevelBanner`、`StatsLine`、`TurnStatus`、`ContinueBar`、`FullHistoryPanel`、`SegmentDivider`、`DecisionTray`、`PlanApprovalCard`、`ClarificationForm`、`PermissionDialog`、`SandboxAllowPrompt`、`DiffViewer`、`DiffBlockCard`、`InlineDiffReview`、`FeedbackButtons`、`SlashCommandMenu`、`MentionAutocomplete`、`MentionMenuPortal`、`SearchDialog`

### 任务 / 团队 / 记忆

`TaskCenter`、`task-center/OverviewTab`、`DelegationTab`、`SubagentsTab`、`AutomationTab`、`IssuesTab`、`BoardTab`、`TeamTab`、`InboxTab`、`IssueDetailPanel`、`AgentManager`、`AgentDetail`、`AgentPanel`、`AgentTeamsPanel`、`MemoryManager`、`MemoryCheckupView`、`PromptDebugger`

### 设置

`SettingsPanel`、`SettingsParts`、`LayeredSettingsPanel`、`OllamaSettingsPanel`、`VoiceSettingsPanel`、`ModelProfilePanel`、`GitEnvSettings`、`RemoteAccessSettings`、`DeviceSyncSettings`、`TokenPricesPanel`、`ComputerUseSettings`、`SecretStorageSetting`、`WechatSettings`、`PetMarketDialog`

### 知识 / 文档 / 媒体

`NotebookManager`、`NotebookWorkspace`、`NoteEditor`、`NbChatPanel`、`DocxViewer`、`PdfViewer`、`ExcelViewer`、`ImageGallery`、`AudioPlayer`、`VideoPlayer`、`KnowledgeGraphView`、`SourceViewer`、`SourceReferences`、`DeliverableFiles`、`PipelineNextStepDialog`、`GoalModeBar`、`GoalBar`、`CicdPanel`、`TrajectoryPanel`、`UsageStats`、`UsageVisuals`、`ppt/*`

### 文件 / Git / 终端 / 市场

`FileExplorer`、`FileEditor`、`FileChangesList`、`FileLinkContextMenu`、`GitInfoPanel`、`GitBranchSelector`、`GitHubCloneDialog`、`TerminalPanel`、`JobsPanel`、`JobsBadge`、`McpManager`、`McpMarketplace`、`SkillManager`、`PluginManager`、`FreeModelPluginCard`、`StackMarketSection`、`zvec/*`

### 引导 / 错误 / 恢复 / 宠物

`BootstrapWizard`、`OnboardingTour`、`AppErrorBoundary`、`RecoveryPanel`、`SessionRecovery`、`ConfirmDialog`、`CloseConfirmDialog`、`PetWindowApp`、`PetSprite`、`PetMarketDialog`

### 手机端（packages/ui/src）

`mobile-app`、`shell`、`chat-platform`、`components`、`session-view`、`create-session-sheet`、`pairing-gate`、`message-bubble`、`tool-card`、`markdown`、`mermaid-diagram`、`changes-pane`、`changes-list`、`diff-view`、`patch-diff-view`、`file-browser`、`file-tree-view`、`detail-pane`、`info-panel`、`approval-card`、`browser`、`ui.css`

### 插件

`src/plugins/library-ops/components/*`（20 个 tsx）、`src/plugins/library-ops/styles/library-ops.css`；`monopoly-game` 不做，`shell-ops` 无 UI。

---

## 附录 B：优先看的 12 个文件

1. `src/styles.css`（token + 基础类）
2. `src/styles/codem-ui.css`
3. `src/components/ui/dialog.tsx` / `popover.tsx` / `dropdown-menu.tsx`
4. `src/core/icons/icon-map.ts`
5. `src/components/Sidebar.tsx`
6. `src/components/ChatPanel.tsx`
7. `src/components/InputArea.tsx`
8. `src/components/TaskCenter.tsx`
9. `src/components/MemoryManager.tsx`
10. `src/components/SettingsPanel.tsx`
11. `src/components/ppt/PPTEditor.tsx`
12. `src/test/layout-contract.test.ts` / `dialog-layer-contract.test.ts`

---

*本计划只定义方向、边界与批次，不包含实现代码。执行前先完成 Batch 0 和 4 个决策确认。*
