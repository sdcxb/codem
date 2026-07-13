# UI/UX 对标分析：Wegent vs Codem

> 创建时间：2026-07-13
> 参考项目：[Wegent](https://github.com/wecode-ai/Wegent)（微博开源 AI Agent 操作系统）
> 状态：分析完成，待评估执行

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
