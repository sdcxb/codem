# 05 · UI/UX：外壳、导航、对话区、设计系统

> 基线：1.16.330 ｜ 2026-10-26
> 代码坐标：`src/App.tsx`（6251 行，外壳/视图状态）、`src/styles.css`（21547 行，令牌/默认皮肤）、`src/components/*`、`src/core/theme/*`、`src/core/ui/*`。
> 设计口径：`docs/UI-DESIGN-SYSTEM.md`（877 行，历史较全但部分计数过时）、`docs/ui-spec.md`（4 KB，当前令牌/交互常数唯一口径）。

---

## 1. 两个窗口入口

| 入口 | HTML | JS | 说明 |
|---|---|---|---|
| 主窗 | `index.html` | `src/main.tsx` | 完整 SPA；1200×800，最小 800×600，`decorations:false`、`transparent:true` |
| 宠物窗 | `pet.html` | `src/pet-main.tsx` | 独立轻量 bundle：React + `PetWindowApp` + `pet-window.css`；透明/无边框/置顶/不入任务栏 |

主窗启动顺序：`main.tsx` 先应用外观镜像 → 探测 `native_material`（≤400ms）→ `AppErrorBoundary` → `App`。材质探测失败就保持不透明，不会出现“透明但没有材质”的空窗。

---

## 2. 三套皮肤与外壳

| 皮肤 | 判定 | 布局 | 样式 | 主题 |
|---|---|---|---|---|
| **default** | 非 hub/dream | `App.tsx` 内直接拼 Sidebar + `.main-area` + RightSidebar | `styles.css` | 跟随 `codem-theme`：light / dark |
| **hub** | `skin === "hub"` | `HubLayout`：TopNavbar + 三栏（sidebar / main / right） | `skin-hub.css`（深色科技 + 橙 `#ff6b00`） | 强制 dark |
| **dream** | `skin === "dream"` | `DreamLayout`：背景图层 + 叠加 + 装饰 + children；右栏另挂 | `skin-dream.css`（浅色梦幻 + `--dream-c*` 调色板） | 按背景图色板 `isDark` 自适应 |

共用外壳：

```text
TooltipProvider
└─ .app
   ├─ BootSplash
   ├─ WorkspaceBackdrop
   ├─ ToastContainer
   ├─ FileLinkContextMenu
   ├─ TitleBar（44px）
   └─ .app-content
      ├─ 皮肤布局（Sidebar + 主区 + 右栏）
      ├─ SettingsPanel（模态）
      ├─ TaskCenter / 各管理器（模态）
      └─ NotebookWorkspace（整屏）
```

**皮肤切换**：`ThemeManager.setSkin()` 会清/加 `data-skin`、清 dream 背景变量、切主题；`useSkin()` 订阅变更。皮肤契约要求插件 UI 只用主题令牌，禁止硬编码色值（`skin-tokens.ts` + `skin-compat-plugin.test.ts`）。

---

## 3. 视图状态（App.tsx 内）

| 状态 | 作用 | 呈现 |
|---|---|---|
| `bottomTab` | `chat` / `terminal` / `perf` / `files` / `jobs` / `cicd`（game 无入口） | 主区内容互斥；perf/files/jobs/cicd 共用 `renderBottomPanelBody()` |
| `showSettings` | 设置 | `SettingsPanel`（`settings-overlay` + `role=dialog`） |
| `showTaskCenter` / `taskCenterTab` | 任务中心 | 8 个 Tab；`codem:open-task-center` 事件可跳转 |
| `notebookWorkspaceId` | 笔记本工作区 | `.nb-workspace-overlay` 全屏 |
| 各管理器 | 项目/技能/插件/MCP/记忆/Agent/笔记本/宠物市场/GitHub 克隆/搜索/恢复 | 模态 `modal-overlay` + `modal-editor` |
| 计划审批 / 决策托盘 / 澄清 / 表单 | 运行中交互 | Portal/模态，Promise 挂起 |

**顶部页签栏已移除**：终端在标题栏、性能在设置、文件/任务/CI-CD 在右侧抽屉；成员与入口唯一登记在 `src/core/ui/bottom-tab-entries.ts`，判据 `BOTTOM-TAB-1..9` 守着“每个成员必须有可达入口”。

---

## 4. 导航与信息架构

### 4.1 标题栏 `TitleBar`

- 高 44px（`--chrome-height`）；中间有专用拖拽区 `data-tauri-drag-region`。
- 左：Logo（1x/2x/3x srcset）、应用菜单（文件/视图/帮助）、执行模式（本地 ↔ 新工作树）、可选工作区页签。
- 右：搜索、设置、主题切换、终端；Windows 最小化/最大化/关闭；macOS 左红黄绿。
- 快捷键与菜单同源（`core/shortcuts/app-shortcuts.ts`）：`Ctrl/⌘+N` 新对话、`+K` 搜索、`+,` 设置、`+B` 侧栏、`` +` `` 终端。
- 执行模式切换会做脏工作区三态确认（`decideWorktreeDirtyGuard`）。

### 4.2 侧栏 `Sidebar`

```text
折叠 rail（图标 + tooltip + aria-label）
├─ 新建对话 / 知识笔记本 / 任务管理（未读徽章）
├─ 全局对话区（吸顶分组头 + 今天/更早）
├─ 项目区（排序：最近/名称 × 正倒；项目行：箭头/钉住/名称/+ /…）
└─ 会话行（拖拽排序、右键菜单、置顶、删除、未读）
```

- 宽度可拖拽（`codem-sidebar-width`，自实现）。
- 项目名用 `OverflowText` 完整显示；操作按钮收进溢出菜单（1.16.330）。
- 排序按钮是 `role=menu` + `menuitemradio` + `aria-checked`；点外面关闭用 `useDismissableLayer`。

### 4.3 右侧栏 / 抽屉

- `RightSidebar`：只剩 **Files**（文件树 + 预览/编辑）与 **Browser**（内嵌网页）；宽 360–620 可拖，折叠成 36px 细轨。
- `PanelSidebar`：浮动抽屉（portal），页签 **Git / 文件 / 变更 / 工作台 / 任务 / CI-CD**（后两者按插件启用条件）；
- 位置读 `--chat-body-top/bottom`（兜底 48/140），宽 520（`--panel-sidebar-width`）。

### 4.4 任务中心

8 个 Tab：`overview / delegation / subagents / automation / issues / board / teams / inbox`。
看板、子智能体、概览会自动加宽；旧 id `squads → teams`、`library → board` 自动归一。

### 4.5 设置：23 个分区

| # | 分区 | 主要内容 |
|---:|---|---|
| 1 | 通用 general | 运行模式（API/CLI）、Provider/模型、用户身份、语言、沙箱允许目录 |
| 2 | 外观 appearance | 皮肤选择、提示音、语言、字号、对比度、密度、字重、深浅色 |
| 3 | 安全 security | 权限规则、安全模式、允许目录、凭据状态 |
| 4 | Git | 分支前缀、合并方式、force push、commit/PR 文案 |
| 5 | 环境 environment | 环境变量、自定义操作 |
| 6 | 工作树 worktree | worktree 根、自动清理、合并策略 |
| 7 | 知识 knowledge | 笔记本/嵌入/检索设置 |
| 8 | 自动化 automation | **占位**：已移至任务管理面板 |
| 9 | 多模态 multimodal | Embedding/TTS/ImageGen |
| 10 | 语音 voice | STT/TTS 引擎与音色 |
| 11 | Ollama | 本地模型地址/模型 |
| 12 | 工具 tools | 工具启停、终端设置 |
| 13 | 人设 persona | 人设卡/激活 |
| 14 | 电脑操作 computer | 读屏/鼠标键盘 |
| 15 | 微信 wechat | ClawBot 登录/开关 |
| 16 | 连接手机 phone | LAN 配对/设备/中继 |
| 17 | 代码图谱 codegraph | CodeGraph 开关/启动器 |
| 18 | 宠物 pet | 宠物安装/大小/位置/气泡 |
| 19 | 用量统计 usage | token/成本/今日/会话 |
| 20 | 性能 performance | DB/内存/耗时指标 |
| 21 | 记忆体检 memory-checkup | 相似重复/归属失效/迁移回退 |
| 22 | 高级 advanced | 智能体/心跳/重试/提示词/分层设置/纠偏/恢复/缓存统计 |
| 23 | 帮助 help | 快捷键/教程/关于/版本 |

- 结构：`settings-overlay` > `settings-panel`（`role=dialog`）；侧栏 `useRovingFocus`（方向键移动），内容列 `useEdgeFade`（边缘渐隐）。
- 标题栏内嵌搜索框：输入即过滤分区，命中跳转。
- **保存规范路径**：`SettingsPanel.tsx::handleSave()` → `buildSavePayload()`（以保存那刻库值为基座，只覆盖 dirty 字段）→ `beginSettingsWriteProbe()/flushSettingsWrites()` → 凭据封存 → `codem-settings-changed` 事件。裸 `setSettingJSON({...settings})` 是假保存，判据 `SAVE-REFRESH-1/2`。

---

## 5. 对话主区

### 5.1 结构

```text
chat-panel
├─ chat-header
│  ├─ 侧栏开关
│  ├─ 会话标题下拉（≤15 条）
│  ├─ jobs-badge 槽
│  ├─ 模型选择器 + 推理强度
│  ├─ 五个视图开关：推理 / 智能体 / 快照 / 上下文 / 轨迹
│  └─ 侧边面板 + 连接点
├─ 搜索弹窗 / 断连横幅 / WaterLevelBanner
├─ chat-body
│  ├─ messages-container（消息流）
│  │  ├─ 消息（user/assistant/system/机器注入/reasoning/tool/error/stats/turn/plan）
│  │  ├─ 回合末「任务完成」+ fork / regenerate
│  │  ├─ 步进胶囊 + 执行计划 tooltip
│  │  └─ 引导栏（运行中追加）
│  ├─ 消息导航轨 / 到底指示 / 滚动条标记
│  └─ workbench-split-pane（当前不可达）
└─ InputArea + 多个 floating-overlay-panel（上下文/轨迹/智能体/快照/侧会话）
```

### 5.2 消息类型

| 类型 | 呈现 |
|---|---|
| user | 用户气泡 + 头像 + 附件 + 运行中追加徽标 |
| assistant | Markdown（Shiki/KaTeX/Mermaid）、文件路径超链接、富内容卡片 |
| reasoning | 折叠行：首行摘要，流式时跟随，展开灰底缩进 |
| tool | `ToolCallGroup` 合并连续同工具；`ToolCallCard` 变体：Terminal/Diff/Read/Search/Web |
| error | `ErrorCard` + 状态 |
| stats | turns/steps、LLM/工具耗时、TTFT、tok/s、cache |
| turn | 最大 token / 重试倒计时 / 错误 |
| plan | `PlanApprovalCard`（exit_plan_mode；批准 = 真切 default） |
| 机器注入 | 居中的“系统说明”，无用户头像/编辑入口；轮次边界、总览、滚动条都不把它当用户提问 |

**工具卡细节**：

- 折叠行：图标 + 标题 + 摘要 + 状态 + 时长；展开体：IN/OUT gutter 或专用卡。
- 同工具连续合并，阈值 3；只读工具自动折叠。
- 容器查询：宽 < 420px 竖排；< 480px 分屏 diff 收窄行号列。
- 错误行折叠摘要显示错误首行。

### 5.3 滚动与边缘

- 贴底容差 40px；用户上滚 150ms 冷却；流式期间 `behavior:auto`（不追动画）；
- 上滚 200px 触发加载更早消息；
- 边缘渐隐 28px / 7 档 / `y≈x^1.5` / 触边归零；不挂聊天主列表（mask 会裁浮层），只挂设置内容列与引导栏；
- 图片画廊用共享元素转场（View Transitions，失败降级）。

---

## 6. 输入区（Composer）

```text
input-wrapper
├─ 引用上下文条 / 待发附件
├─ textarea 镜像层（高度自适应，展开模式）
├─ 左上：+ 菜单（附件/技能/快捷短语/草稿/自定义操作）
├─ 左下：/ 命令、@ 提及、技能选择、PlanModeChip、审批模式
├─ 右上：语音、展开、模型/推理、发送/停止/引导
└─ 底部：控制条（发送/停止同按钮状态机）
```

- **`/` 命令**：Portal 到 body，`--popover-origin: bottom center`；避免被输入框 `overflow:hidden` 裁掉。
- **`@` 提及**：`MentionMenuPortal`，同样 Portal；修复过“只露 9px”。
- **发送/停止/引导**：执行中同一按钮根据状态切换；`ChatPanel` 播 `sent` 提示音并分流。
- **附件**：拖拽/粘贴/文件选择；小文件内联，大文件外置；同步到工作区 `.attachments/` 供工具读取。
- **审批模式**：`PermissionPresetSelector`（ask/auto/full）。
- **语音**：STT 输入、TTS 朗读（设置 → 语音）。
- **草稿**：`useDraftPersistence` 按会话保存；输入历史/快速短语。

---

## 7. 设计系统（令牌唯一来源：`src/styles.css` `:root` 与主题档）

### 7.1 核心令牌

| 家族 | 令牌 | 说明 |
|---|---|---|
| 字号 | `--fs-2xs` … `--fs-hero` | 10/11/12/13/14/16/18/20/24/28/32，全部乘 `--ui-font-scale`；基准 13px |
| 字重 | `--weight-regular/medium/semibold/bold/heavy` | 400/500/560/620/700（可变字体真档） |
| 字体 | `--font-ui` / `--font-display` / `--font-mono` / `--font-family` | 中文优先、代码等宽 |
| 行高/字距 | `--lh-none` … `--lh-loose`、`--ls-tight/normal/wide` | 第 155 轮收口 |
| 圆角 | `--radius-xs/sm/radius/md/lg/xl/full` | 4/6/8/10/14/20/9999 |
| 间距 | `--space-1` … `--space-15` | 2/4/6/8/10/12/14/16/20/24/28/32/40/48/64（2px 网格） |
| 控件高 | `--control-xs/dense/md/std/form` | 26/30/34/38/44；紧凑档 24/26/30/34/40 |
| 外壳 | `--chrome-height` 44、`--panel-sidebar-width` 520、`--chat-body-top/bottom` | 运行时由 ChatPanel 写 |
| 图标 | `--icon-2xs` … `--icon-3xl` | 10/12/14/16/20/24/32/48 |
| 动效 | `--duration-fast/normal/slow` 150/200/300、`--duration-press` 120、`--ease-out/in-out/drawer/standard/swift/pop` | 禁裸 `cubic-bezier` |
| 层级 | `--z-chrome` 100 … `--z-toast` 20000、`--z-max` | 浮层/模态/通知统一梯子 |
| 颜色 | `--bg-primary/secondary/tertiary/hover`、`--text-primary/secondary/muted`、`--border-primary` 9%/`--border-secondary` 5%、`--accent`/`--success`/`--warning`/`--error`/`--info`、`--chart-cat-1..6` | 语义令牌，禁硬编码 |
| 阴影 | `--shadow-raise-1..4`、`--shadow-bubble`、`--shadow-popover`、`--shadow-glow` | 中性阶梯 |

> 完整值见 `docs/ui-spec.md` 与 `styles.css`。本文只列“名字与用途”，避免文档与实现数值漂移。

### 7.2 三皮肤差异

| 维度 | default | hub | dream |
|---|---|---|---|
| 基调 | 浅色暖中性；深色可选 | 深色科技 + 橙 | 浅色梦幻 + 背景图 |
| 强调 | `#6555e0` 紫 | `#ff6b00` 橙 | `--dream-accent` 注入 |
| 明暗 | 用户可选 | 强制 dark | 按色板自适应 |
| 背景 | 光斑场景层 | `--backdrop-blob-*` 覆盖 | 背景图/视频 + 三 blob |
| 覆盖 | 宿主令牌 | 宿主 + `hub-*` 私有 | 宿主 + `--dream-c*` 编号调色板 |

**已知缺口**：dream 皮肤没有定义 `--success/--warning/--error/--info/--dropdown-bg/--text-on-accent`，状态色与浮层底实际沿用基础 light/dark 档（`skin-dream.css` 0 处定义）。这是“皮肤覆盖不全”的真实风险，不是文档问题。

### 7.3 外观档与原生材质

- **对比度** `data-contrast="normal|high"`：高对比提高文字/边框对比、焦点环 3px 实色、外壳/浮层回实色；
- **密度** `data-density="comfortable|compact"`：只覆盖 `--control-*`，不动 `--space-*`，下限 24px；
- 真相源 `core/theme/appearance-modes.ts`：DB（真相）→ localStorage 镜像（首屏）→ 默认；`main.tsx` 首帧前应用，`TitleBar` 在 DB 就绪后校正。
- **原生材质**：Win11 Mica → 失败退 Acrylic；macOS vibrancy。后端返回材质类型，前端在首帧前打 `data-native-material`；CSS 只让外壳透明，主内容面保持不透明。

### 7.4 响应式与容器

- 媒体查询：768 / 1024 / 900 / 600；
- 容器查询：`@container settings` 520px（设置行换行）、`@container toolcard` 420px（工具卡竖排）/480px（diff 行号列收窄）；
- 规则：同一视口下可用宽度能差 3 倍（对话区 ↔ 抽屉），所以窄容器必须用 `@container`，不能用媒体查询。

---

## 8. 可访问性

| 项 | 现状 |
|---|---|
| 快捷键 | 全局表 `app-shortcuts.ts`；输入框内默认不抢键；close 不接管 |
| 焦点 | `:focus-visible` 333 处；一规则三态（hover/focus/expanded）；高对比焦点环 3px |
| Roving focus | 纯函数回绕/Home-End/步长 5/RTL 镜像；**只接入设置侧栏一处** |
| 浮层关闭 | `useDismissableLayer` 22 个非测试文件 |
| 可访问名 | 设置关闭、皮肤卡 `aria-pressed`、设置页签 `aria-current`、排序 `menuitemradio`、标题栏图标按钮均有 `aria-label` |
| 对话框 | 26 个对话框补 `role=dialog`/`alertdialog` + `aria-modal` + 可访问名；扫描量 ≥20 防空集 |
| 播报 | `aria-live` 少数；`StatusBanner` error assertive，其余 polite；流式正文故意不加 |
| RTL | 只实现 roving 的 rtl 参数，全仓无 `dir="rtl"` ⇒ **未接入** |
| 真渲染探针 | 无头 Edge 测弹窗几何/标签墙行数/窄容器/主题首帧；夹具在 `src/test/fixtures/*-probe.html` |
| 声音 | WebAudio 合成三音（sent/done/error），默认关，失败静默 |

---

## 9. 最近的重要 UI 变化（1–2 个月）

| 日期 | 变化 |
|---|---|
| 2026-10-23 | 侧栏项目名完整显示；操作按钮收进溢出菜单；修 BOM 与 CSS 快照 |
| 2026-10-18 | UI 工艺 P2 七项：边缘渐隐 / Diff 双视图 / 共享元素转场 / UI 文档与目录 / roving focus / 合成提示音 / 动效棘轮 |
| 2026-10-18 | 运行中追加可见 + 附件到模型；窄容器 `@container`；流式滚动图钉 |
| 2026-10-17 | 隐藏顶部页签栏（三皮肤），11 项成员补其它入口 |
| 2026-10-17 | 底部四页签恢复入口（性能/文件/任务/CI-CD）；Sidebar 死 prop 收尾 |
| 2026-10-08 | 梦幻皮肤毛玻璃被原生材质压掉、代码块双边框、侧栏配色语义 |
| 第 183 轮 | 撤销“圆角纸面 + 左缘阴影”（用户否决），回齐边矩形 |
| 第 159 轮 | 补 `data-contrast` / `data-density` 写入方（此前 CSS 写了无人触发） |
| 第 158 轮 | 原生材质档：把“是否生效”交前端，首帧前打属性 |
| 2026-09-26 | 26 个对话框补语义；皮肤几何 34 条规则体收进令牌块 |

---

## 10. UI 风险与“看起来有、其实没有”

1. **单文件巨型化**：`styles.css` 21547 行 / 671 KB、`App.tsx` 6251、`SettingsPanel` 3989。改 CSS 前先跑 `node tools/ui-audit/css-contract.mjs`。
2. **双基础样式表 + 加载顺序**：`main.tsx` 顺序为 `styles.css → skin-hub → skin-dream → notebook → codem-ui → task-center`；`codem-ui` 在皮肤之后加载，同特异度可覆盖皮肤。
3. **皮肤靠 `!important`**：skin-dream 105 处、skin-hub 24 处、codem-ui 29 处；级联难推理。
4. **dream 缺 6 个语义令牌**（见 §7.2）。
5. **`ChatPanel.showWorkbench` 不可达**：只有 `setShowWorkbench(false)`，从未置 true ⇒ 分屏 Workbench 永不出现。
6. **`SpaceSwitcher` 孤儿**：组件完整但侧栏无挂载点 ⇒ 当前没有“工作空间切换”UI。
7. **设置分区口径**：代码是 **23** 个（`SettingsPanel.tsx:646`），旧文档说 22；`automation` 已是占位。
8. **内联样式未清零**：侧栏未读徽章、项目更多菜单 `backdropFilter: blur(20px)`、抽屉几何、TitleBar opacity ⇒ 不随皮肤/主题切换。
9. **视觉回归资产在仓库外**：`.preview-shot/` 被 gitignore；干净 clone 上无法复跑像素 diff/CDP 取证。
10. **文档陈旧**：`UI-DESIGN-SYSTEM.md` 至少 3 处计数（1.4 万行、22 分区）与现状不符；以本文件 + `ui-spec.md` 为准。

---

## 11. 改 UI 的最小流程

1. 先看 `docs/ui-spec.md` 的令牌/交互常数；不要新增裸值。
2. 改 CSS 后：`node tools/ui-audit/css-contract.mjs --write`（刷新契约），再跑 `--check`。
3. 跑 `node tools/ui-audit/scan-ui.mjs`（未定义类名应为 0）、`node tools/audit/scan-style-literals.mjs --check`。
4. 涉及三皮肤：default/hub/dream 都走一遍；涉及窄容器：320/384/480/576/760 五档。
5. 涉及交互：补真渲染探针或 `@testing-library` 用例；不要只写源码级断言。
6. 涉及删除/隐藏入口：同步 `bottom-tab-entries.ts` 与 `bottom-tab-entry-ratchet` 判据。
