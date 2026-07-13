# UI/UX 对标分析：Wegent vs Codem

> 创建时间：2026-07-13
> 最后更新：2026-07-13
> 参考项目：[Wegent](https://github.com/wecode-ai/Wegent)（微博开源 AI Agent 操作系统）
> 状态：✅ 全部 4 批次已执行完成

---

## 一、设计体系对比

| 维度 | Wegent | Codem |
|------|--------|-------|
| **主色调** | 紫色系 `#5D5EC9`（柔和、品牌感强） | GitHub蓝 `#2f81f7`（工程感、冷色调） |
| **主题切换** | 完整 light/dark 双主题，CSS变量 + `data-theme` | dark 默认，light 有但配色不统一 |
| **CSS 方案** | Tailwind + shadcn/ui 组件库 | 纯 CSS 变量 + 手写样式（5600+ 行） |
| **字体** | Google Sans（含中文 PingFang/微软雅黑 fallback） | 系统字体栈 |
| **圆角** | 统一 `--radius: 0.5rem`，组件间一致 | 各处硬编码，不统一 |
| **阴影** | 紫色系阴影 `rgba(93,94,201,0.12)`，有层次感 | 无阴影或简单黑色阴影 |
| **颜色透明度** | `rgb(var(--color) / <alpha-value>)` 支持任意透明度 | 硬编码 rgba 值，无法动态调整 |
| **组件库** | shadcn/ui（基于 Radix UI）| 手写组件 |
| **图标库** | Lucide + Heroicons | 无统一图标库 |

### CSS 变量体系对比

**Wegent（globals.css）：**
```css
:root {
  --color-bg-base: 255 255 255;
  --color-bg-surface: 249 249 249;
  --color-primary: 93 94 201;        /* 紫色 */
  --shadow-popover: 0 12px 32px rgba(93, 94, 201, 0.12);
  --radius: 0.5rem;
}
```

**Codem（styles.css）：**
```css
[data-theme="dark"] {
  --bg-primary: rgba(13, 17, 23, 0.85);
  --accent: #2f81f7;                 /* 蓝色，硬编码 */
  /* 无统一 radius / shadow 变量 */
}
```

**关键差异**：Wegent 使用纯 RGB 值（`93 94 201`）配合 Tailwind 的 `<alpha-value>` 机制实现任意透明度；Codem 使用 rgba 硬编码，无法动态调整透明度。

---

## 二、消息气泡对比

### Wegent 的实现

**消息样式分层（messageBubbleStyles.ts）：**
- **用户消息**：`rounded-2xl border bg-surface shadow-sm`，紧凑 `px-4 py-3`
- **AI 消息**：无气泡背景，全宽展示，`px-5 pt-5 pb-10`（底部留工具栏空间）

**浮动工具栏（BubbleTools.tsx）：**
- 位置：气泡左下角 `absolute bottom-2 left-2`
- 按钮：复制、编辑、重新生成（带模型选择 Popover）、点赞/踩、转发
- 统一风格：`h-[30px] w-[30px] rounded-full bg-fill-tert hover:bg-fill-sec`
- 每个按钮都有 Tooltip 提示

**长消息折叠（CollapsibleMessage.tsx）：**
- 超过 10 行自动折叠
- 底部渐变淡出 `bg-gradient-to-t from-base to-transparent`
- "展开/收起"按钮居中

**内联编辑（InlineMessageEdit.tsx）：**
- 点击编辑按钮 → 原位变成可编辑文本框
- 支持取消和保存

### Codem 的实现

- 用户和 AI 都有气泡背景
- 无浮动工具栏（只有复制按钮）
- 长消息不折叠，占满屏幕
- 不支持内联编辑

---

## 三、右键菜单 / 下拉菜单

### Wegent 的实现

**会话菜单（TaskMenu.tsx）：**
- 基于 Radix UI 的 `DropdownMenu`
- 支持**子菜单**展开（如"移动到分组"展开所有项目组）
- 操作项：复制任务ID、移动到分组、重命名、删除
- 触发器：竖三点图标 `HiOutlineEllipsisVertical`

**用户浮动菜单（UserFloatingMenu.tsx）：**
- 点击头像展开浮动菜单
- 包含：设置、语言切换、群组管理、退出
- 点击外部自动关闭（`mousedown` 事件监听）
- ESC 键关闭
- 展开/收起动画

### Codem 的实现

- 侧栏会话只有单独的删除按钮
- 无右键菜单
- 无下拉菜单系统
- 无 Tooltip 系统

---

## 四、文本选区交互

### Wegent 的实现

**选区浮动按钮（SelectionTooltip.tsx）：**
- 用户选中 AI 回复中的文字 → 浮出"引用并提问"按钮
- `createPortal` 渲染到 `document.body`
- 按钮定位：选区上方居中
- 边界检测：防止超出视口
- 动画：`animate-in fade-in-0 zoom-in-95 duration-150`

**引用上下文（QuoteContext.tsx）：**
- 引用内容自动插入输入框
- 带引用标记（QuoteCard 渲染）
- 插入后自动聚焦输入框

**选区 Hook（useTextSelection.ts）：**
- 完整的选区追踪系统
- 支持锁定选区位置（防止滚动时丢失）

### Codem 的实现

- 完全没有此功能

---

## 五、侧栏对比

### Wegent 的实现

**侧栏功能（TaskSidebar.tsx）：**
- `ResizableSidebar`：可拖拽调整宽度
- 分区展示：固定群聊 → 个人任务 → 历史
- 搜索对话框（`SearchDialog`，快捷键触发）
- 折叠/展开模式（`PanelLeftClose / PanelLeftOpen`）
- 每个会话项有 `TaskMenu` 下拉菜单
- `TaskInlineEdit`：双击重命名
- 底部：用户浮动菜单 + 导航按钮
- 导航项：聊天、代码、知识库、设备、收件箱

**折叠侧栏（CollapsedSidebarButtons.tsx）：**
- 折叠时显示图标按钮
- Tooltip 显示完整标题

### Codem 的实现

- 固定宽度
- 简单列表，无分区
- 无搜索功能
- 无折叠模式

---

## 六、动画体系对比

### Wegent 的完整动画系统

| 动画 | 类名 | 用途 |
|------|------|------|
| 小圆点跑动 | `streaming-wait-runner-dot` | AI 思考时左右跑动 |
| 文字渐变流动 | `thinking-text-flow` | 思考文字渐变色循环 |
| 进度条微光 | `progress-bar-shimmer` | 加载进度条光泽 |
| 触摸涟漪 | `ripple-effect` | 按钮触摸反馈 |
| 淡入 | `animate-fade-in` | 元素进入动画 |
| 向下滑入 | `animate-slide-down` | 菜单展开 |
| 未读脉冲 | `animate-pulse-dot` | 未读消息红点 |
| 主题过渡 | `transition-duration: 200ms` | 全局主题切换平滑 |
| 宠物闲置 | `animate-pet-idle` | 桌面宠物呼吸 |

**关键动画细节**：小圆点跑动动画有 squash-and-stretch 变形效果（`scaleX(1.42) scaleY(0.78) skewX(16deg)`），非常精致。

### Codem 的实现

- 基本无动画（只有简单的 CSS `transition`）
- 思考状态只有文字提示
- 无加载动画

---

## 七、输入区对比

### Wegent 的实现

- 展开/收起按钮（`Maximize2 / Minimize2`）
- `@` 提及自动补全（`MentionAutocomplete`）
- `/` 技能选择（`SkillAutocomplete`）
- 文件粘贴上传（`onPasteFile`）
- 附件预览
- 禁用状态提示（如"设备离线"）

### Codem 的实现

- 基本文本输入
- 安全模式切换按钮
- 协作模式切换
- 无提及/技能选择
- 无展开/收起

---

## 八、主题系统对比

### Wegent 的双主题

**Light（默认）：**
- 背景：纯白 `255 255 255`
- 表面：浅灰 `249 249 249`
- 主色：紫色 `93 94 201`
- 文字：深灰 `51 51 51`

**Dark：**
- 背景：近黑 `14 15 15`
- 表面：深灰 `26 28 28`
- 主色：浅紫 `118 119 218`
- 文字：浅灰 `212 212 212`

**特色**：主题切换有全局 200ms 过渡动画，切换时加 `.no-transition` 类防止闪烁。

### Codem 的双主题

**Dark（默认）：**
- 背景：`rgba(13, 17, 23, 0.85)` 半透明
- 主色：蓝色 `#2f81f7`

**Light：**
- 背景：`rgba(255, 255, 255, 0.85)` 半透明
- 主色：`#0969da`

**问题**：Light 主题很多地方颜色不协调（按钮、代码块、工具栏等），实际使用体验差。

---

## 九、对标优化建议方案

### 第一优先级：核心体验提升（建议立即做）

#### 1. 引入 Tailwind + shadcn/ui 组件库
- 替换 5600 行手写 CSS，获得一致的设计 token 系统
- 直接获得 `Tooltip`、`DropdownMenu`、`Popover` 等成熟组件
- 主色调从 GitHub 蓝改为紫色系（更柔和、更有品牌辨识度）
- 统一圆角 `0.5rem`、统一阴影系统

#### 2. 消息气泡浮动工具栏
- AI 消息底部添加：复制、重新生成、点赞/踩
- 悬浮显示，不占空间
- 用户消息添加：编辑、重新发送
- 统一按钮风格：`30x30px rounded-full`

#### 3. 长消息折叠
- AI 回复超过 N 行自动折叠
- 底部渐变淡出 + "展开/收起"按钮
- 参考 Wegent 的 `CollapsibleMessage` 实现

#### 4. 会话右键菜单
- 右键侧栏会话弹出菜单：重命名、复制、删除、导出
- 替代当前的单独删除按钮
- 使用 Radix UI `DropdownMenu`

### 第二优先级：交互增强（建议近期做）

#### 5. 文本选区引用
- 选中 AI 回复文字 → 浮出"引用提问"按钮
- 自动插入输入框
- 参考 Wegent 的 `SelectionTooltip` + `QuoteContext`

#### 6. Tooltip 系统
- 所有图标按钮加悬浮提示
- 统一延迟和样式
- 基于 Radix UI `Tooltip`

#### 7. 流式动画
- AI 思考时：小圆点跑动动画替代当前的"正在连接..."
- 进度条微光效果
- 主题切换过渡动画
- 消息进入动画（fade-in）

### 第三优先级：视觉打磨（建议后续做）

#### 8. 配色统一
- Light 主题全面对齐（当前 light 主题很多颜色不协调）
- 阴影系统：用主色调阴影替代黑色阴影
- 圆角统一：所有组件用 `0.5rem` 基准
- 颜色透明度：改用 `rgb(var(--color) / <alpha>)` 模式

#### 9. 侧栏增强
- 可拖拽调整宽度
- 会话搜索功能
- 分区展示（置顶 / 今天 / 更早）
- 折叠模式

#### 10. 输入区增强
- 展开/收起按钮
- 上下文引用预览
- 禁用状态友好提示

---

## 十、实施建议

### 技术路线

1. **渐进式引入 Tailwind**：不一次性替换所有 CSS，新组件用 Tailwind，旧组件逐步迁移
2. **shadcn/ui 按需引入**：先引入 `Tooltip`、`DropdownMenu`、`Popover` 三个核心组件
3. **设计 token 优先**：先统一 CSS 变量体系（颜色、圆角、阴影），再改组件样式
4. **动画最后做**：动画是锦上添花，核心功能优先

### 风险评估

| 改动 | 风险 | 缓解措施 |
|------|------|----------|
| 引入 Tailwind | 中（构建配置变化） | 保留现有 CSS，Tailwind 共存 |
| 替换主色调 | 低 | CSS 变量只需改值 |
| 消息气泡重构 | 中（影响核心交互） | 保留现有功能，只加工具栏 |
| 侧栏重构 | 高（影响导航） | 单独分支开发，充分测试 |

### 预估工作量

| 优先级 | 内容 | 预估时间 |
|--------|------|----------|
| P1 | Tailwind + shadcn/ui 引入 | 1 天 |
| P1 | 消息气泡工具栏 + 折叠 | 0.5 天 |
| P1 | 会话右键菜单 | 0.5 天 |
| P2 | 文本选区引用 | 0.5 天 |
| P2 | Tooltip 系统 | 0.5 天 |
| P2 | 流式动画 | 0.5 天 |
| P3 | 配色统一 | 1 天 |
| P3 | 侧栏增强 | 1 天 |
| P3 | 输入区增强 | 0.5 天 |
| **合计** | | **约 6 天** |

---

## 十一、渲染链路影响分析

> 在执行优化前，必须确认每项改动是否影响主面板的核心渲染链路。

### 当前渲染链路全景

```
ChatPanel.tsx (主面板容器)
├── chat-header (顶栏)
│   ├── ☰ 侧栏切换
│   ├── model-selector (模型选择器)
│   ├── 💭 思考过程开关 (showReasoning)
│   ├── 🤖 子智能体面板开关 (showAgentPanel) + runningCount 徽章
│   ├── 📸 快照面板开关
│   ├── 📊 上下文监控开关
│   └── ● 连接状态
│
├── chat-body (主体)
│   ├── messages-container (消息列表 — 滚动区域)
│   │   ├── [历史消息加载指示器]
│   │   ├── [空状态欢迎页]
│   │   ├── messages.map(msg => MessageBubble)  ← 核心渲染
│   │   └── StreamingTimer (流式状态指示器)
│   │       ├── spinner (CSS 圆圈)
│   │       ├── status 文字 (connecting/streaming/executing_tools)
│   │       └── elapsed 计时 (requestAnimationFrame)
│   │
│   ├── agent-panel-container (子智能体侧面板 — 条件渲染)
│   │   ├── AgentPanel (任务列表)  ← 500ms 轮询刷新
│   │   └── AgentDetail (任务详情)  ← 点击选中后显示
│   │
│   ├── SnapshotPanel (快照面板 — 条件渲染)
│   └── ContextMonitor (上下文监控 — 条件监控)
│
├── step-progress-container (步骤进度条 — 条件渲染)
│   ├── 步骤圆形指示器 (SVG)
│   ├── "第N/M步" 文字
│   └── hover → step-tooltip (完整执行计划)
│
└── InputArea (输入区)
```

```
MessageBubble.tsx (单条消息渲染)
├── message-avatar (👤/⚙️/🤖)
└── message-body
    ├── message-fork-btn (🔀 fork 按钮)
    ├── message-attachments (附件：图片/文件)
    ├── message-content (核心内容 — ReactMarkdown)
    │   ├── 代码块 (SyntaxHighlighter + 复制按钮)
    │   ├── 链接 (handleLinkClick → Tauri open_file_external)
    │   └── 图片 (inline img 渲染)
    ├── reasoning-block (思考过程 — 可折叠)
    │   ├── reasoning-toggle 按钮
    │   └── reasoning-content (<pre> 纯文本)
    ├── tool-calls (工具调用列表 — 可折叠)
    │   └── toolCalls.map(tc =>
    │       ├── tool-item
    │       │   ├── 工具图标 + 名称 (子智能体有特殊图标映射)
    │       │   ├── 状态指示 (⏳/✅/❌)
    │       │   ├── SubagentStatus (如果是 spawn_subagent)
    │       │   │   └── 2秒轮询 getSubagentManager().getTask(taskId)
    │       │   └── tool-error-detail (错误详情)
    │       └── ...)
    └── generated-files (生成文件清理)
```

### 逐项影响评估

#### 不触碰渲染链路的优化（纯外观 / 独立区域）

| 项 | 改动区域 | 影响主面板渲染 | 影响子智能体面板 | 说明 |
|----|---------|:---:|:---:|------|
| #1 Tailwind+shadcn | CSS 变量 + 构建配置 | ❌ | ❌ | 只改颜色值和构建配置 |
| #4 右键菜单 | `Sidebar.tsx` | ❌ | ❌ | 不触碰 ChatPanel |
| #6 Tooltip 系统 | 各组件加 `title` 属性 | ❌ | ❌ | 只加 hover 提示 |
| #7 流式动画 | CSS keyframes + StreamingTimer 样式 | ❌ 仅外观 | ❌ | 不改状态机逻辑 |
| #8 配色统一 | CSS 变量值 | ❌ | ❌ | 只改颜色 |
| #9 侧栏增强 | `Sidebar.tsx` | ❌ | ❌ | 不触碰 ChatPanel |
| #10 输入区增强 | `InputArea.tsx` | ❌ | ❌ | 不触碰 ChatPanel |

#### 会触碰渲染链路的优化（已分析风险，可控）

| 项 | 改动位置 | 影响范围 | 风险等级 | 保护措施 |
|----|---------|---------|:---:|---------|
| #2 气泡工具栏 | `MessageBubble.tsx` 末尾追加浮动 div | 追加元素，不改已有结构 | 🟢 低 | `position: absolute` + `z-index` 不遮挡已有按钮 |
| #3 长消息折叠 | `MessageBubble.tsx` 包裹 `message-content` | 改变内容区视觉高度 | ⚠️ 中 | `message.status === "streaming"` 时不折叠 |
| #5 选区引用 | 新建 `SelectionTooltip.tsx` + `ChatPanel.tsx` 集成 | overlay 不侵入已有组件 | 🟢 低 | `createPortal` 到 document.body |

### 核心结论

| 维度 | 是否会被影响 | 原因 |
|------|:---:|------|
| **回答展示**（ReactMarkdown 渲染） | ❌ | 不修改 `ReactMarkdown` 组件、不修改 `message.content` 数据流 |
| **思考过程**（reasoning-block） | ❌ | 独立 DOM 节点，无优化项触碰 |
| **工具调用展示**（tool-calls + SubagentStatus） | ❌ | 独立 DOM 节点，优化只在末尾追加元素 |
| **子智能体状态回执**（SubagentStatus 轮询） | ❌ | 组件在 MessageBubble 内部，不触碰 |
| **子智能体面板**（AgentPanel/AgentDetail） | ❌ | 面板在 ChatPanel 的 agent-panel-container 中，不触碰 |
| **流式状态指示器**（StreamingTimer） | ⚠️ 仅外观 | #7 改 spinner 动画样式，不改状态机逻辑 |
| **步骤进度条**（StepProgress） | ❌ | 无优化项触碰 |
| **整体布局**（header + body + input 三段式） | ❌ | 无优化项改 ChatPanel 的布局结构 |

**总结：10 项优化纯粹影响视觉层（CSS 样式 + 外观），不会影响操作逻辑、数据流、渲染结构、子智能体面板。**

---

## 十二、文件级冲突矩阵

### 冲突热点

| 文件 | 行数 | #1 | #2 | #3 | #4 | #5 | #6 | #7 | #8 | #9 | #10 | 总触及次数 |
|------|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **styles.css** | 4859 | ✏️重构 | ✏️+80行 | ✏️+30行 | ✏️+50行 | | | | ✏️全量 | ✏️+100行 | ✏️+40行 | 7 |
| **MessageBubble.tsx** | 286 | | ✏️+90行 | ✏️+60行 | | ✏️选区 | | | | | | 3 |
| **Sidebar.tsx** | 299 | | | | ✏️+80行 | | ✏️Tooltip | | | ✏️+150行 | | 3 |
| **ChatPanel.tsx** | 428 | | | | | ✏️+30行 | | ✏️+20行 | | | | 2 |
| **InputArea.tsx** | 231 | | | | | ✏️+20行 | | | | | ✏️+70行 | 2 |
| **App.tsx** | 1149 | | | | | | | ✏️+10行 | | | | 1 |
| **store.ts** | 219 | | | | | ✏️+字段 | | | | | | 1 |
| **vite.config.ts** | 17 | ✏️PostCSS | | | | | | | | | | 1 |
| **package.json** | 51 | ✏️+deps | | | | | | | | | | 1 |

### 解决策略

- **🔥 `styles.css`（7 项触及）**：#1 + #8 合并为一次全量重构；后续 #2/#3/#4/#7/#9/#10 改为文件末尾追加新 class，不触碰已有代码。或直接用 Tailwind class 写在 .tsx 里。
- **🔥 `MessageBubble.tsx`（3 项触及）**：#2 + #3 合并一次改完；#5 改为新建独立组件，不侵入 MessageBubble 内部。
- **🔥 `Sidebar.tsx`（3 项触及）**：#4 + #9 合并一次改完；#6 只加 `title` 属性，不触碰逻辑。

---

## 十三、批次执行计划

> 原则：同一文件只打开一次，减少反复修改产生的冲突。每个批次完成后提交一次 Git commit。

### 批次 A：基础设施层（一次改完配置 + CSS 变量）

| 字段 | 值 |
|------|------|
| **包含项** | #1 Tailwind+shadcn 引入 + #8 配色统一 |
| **改动文件** | `vite.config.ts`、`package.json`、`styles.css`（全量重构 CSS 变量段）、`tailwind.config.ts`（新建）、`src/components/ui/`（新建 shadcn 组件） |
| **不触碰** | 任何 `.tsx` 业务组件 |
| **目标** | 建立设计 token + 组件库基础设施 |
| **风险** | ⚠️ 高——Vite 构建配置变化 |
| **验证点** | `npm run dev` 能启动 + 现有 UI 不走样 |
| **预估工时** | 1.5 天 |
| **状态** | ✅ 已完成 |

### 批次 B：消息体验层（一次改完 MessageBubble）

| 字段 | 值 |
|------|------|
| **包含项** | #2 气泡工具栏 + #3 长消息折叠 + #7 流式动画 |
| **改动文件** | `MessageBubble.tsx`（一次改完）、`styles.css`（末尾追加动画+工具栏样式）、`ChatPanel.tsx`（状态驱动动画）、`App.tsx`（主题过渡） |
| **不触碰** | Sidebar、InputArea、SettingsPanel |
| **目标** | 消息气泡全套体验提升 |
| **依赖** | 批次 A 完成（有 shadcn Tooltip 可用） |
| **保护规则** | `message.status === "streaming"` 时 `contentCollapsed` 强制为 `false`（流式消息不折叠） |
| **预估工时** | 1 天 |
| **状态** | ✅ 已完成 |

### 批次 C：导航交互层（一次改完 Sidebar + InputArea）

| 字段 | 值 |
|------|------|
| **包含项** | #4 右键菜单 + #9 侧栏增强 + #10 输入区增强 |
| **改动文件** | `Sidebar.tsx`（一次改完）、`InputArea.tsx`（一次改完）、`styles.css`（末尾追加侧栏+输入区样式） |
| **不触碰** | MessageBubble、ChatPanel |
| **目标** | 导航 + 输入全套体验提升 |
| **依赖** | 批次 A 完成（有 shadcn DropdownMenu 可用） |
| **预估工时** | 1.5 天 |
| **状态** | ✅ 已完成 |

### 批次 D：高级交互层（独立组件，低冲突）

| 字段 | 值 |
|------|------|
| **包含项** | #5 选区引用 + #6 Tooltip 全局扫描 |
| **改动文件** | 新建 `SelectionTooltip.tsx`；`ChatPanel.tsx`（集成选区）；`InputArea.tsx`（引用预览）；`store.ts`（+quoteContext）；`Sidebar.tsx`/`SettingsPanel.tsx`（加 title 属性） |
| **目标** | 高级交互功能 |
| **依赖** | 批次 B 完成（消息气泡已稳定） |
| **预估工时** | 1 天 |
| **状态** | ✅ 已完成 |

### 批次执行顺序

```
批次 A (基础设施) → 批次 B (消息体验) → 批次 C (导航交互) → 批次 D (高级交互)
     1.5天              1天                1.5天              1天
```

### 冲突矩阵验证（按批次执行后）

| 文件 | 批次 A | 批次 B | 批次 C | 批次 D | 总修改次数 |
|------|:---:|:---:|:---:|:---:|:---:|
| styles.css | ✏️全量 | ✏️追加 | ✏️追加 | | 2 次（A 全量 + B/C 追加，不冲突） |
| MessageBubble.tsx | | ✏️ | | | **1 次** |
| Sidebar.tsx | | | ✏️ | ✏️+title | 2 次（C 改逻辑 + D 加属性） |
| ChatPanel.tsx | | ✏️ | | ✏️ | 2 次（B 动画 + D 选区） |
| InputArea.tsx | | | ✏️ | ✏️ | 2 次（C 增强 + D 引用） |
| App.tsx | | ✏️ | | | **1 次** |
| store.ts | | | | ✏️ | **1 次** |
| vite.config.ts | ✏️ | | | | **1 次** |

**关键改进**：`styles.css` 从 7 次修改 → 降为 2 次。`MessageBubble.tsx` 从 3 次 → 降为 1 次。

### 风险控制措施

1. **批次 A 完成后立刻验证构建**：`npm run dev` + `npm run tauri:build`，确认 Tailwind + Tauri 打包无冲突后再继续
2. **每个批次完成后提交一次 Git commit**：便于出问题时回滚到上一个稳定批次
3. **批次 B/C 对 `styles.css` 只追加不修改**：在文件末尾新增 class，不触碰批次 A 重构的变量段
4. **批次 D 对 `Sidebar.tsx` 只加 `title` 属性**：不触碰批次 C 的逻辑改动

### 架构安全确认

> 所有 10 项优化均为纯前端改动（`.tsx` + `.css` + 构建配置），不触及：
> - ❌ Rust 后端（`lib.rs`）
> - ❌ Node.js 服务器（`server.ts`）
> - ❌ Tauri IPC 命令层
> - ❌ 构建管线（`build-server.mjs` / `tauri.conf.json`）
> - ❌ Sidecar 二进制
>
> Tailwind CSS 是构建时工具，输出静态 CSS 到 `dist/`，Tauri 打包后与现有架构完全一致。
> **不会破坏独立安装包无需安装依赖的架构。**
