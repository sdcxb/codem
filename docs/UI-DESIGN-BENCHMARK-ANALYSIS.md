# Codem UI 对标分析：emilkowalski/skills + apple-design

> 创建时间：2026-08-01
> 对标对象：[emilkowalski/skills](https://github.com/emilkowalski/skills)（含 apple-design skill）
> 分析目标：找出 Codem 桌面应用界面设计的优化项

---

## 一、对标项目概述

emilkowalski/skills 是 Vercel/Linear 前设计工程师 Emil Kowalski 的设计工程知识库，包含 8 个技能：

| 技能 | 核心价值 |
|------|---------|
| **apple-design** | Apple WWDC 设计演讲的 Web 翻译——流体界面、弹簧动画、手势交互、半透明材质、排版规则 |
| **emil-design-eng** | UI 打磨哲学——动画决策框架、缓动曲线、组件构建原则、性能规则、可访问性 |
| **review-animations** | 10 条不可商量标准 + 激进阻断触发器 + 修复优先级 |
| **improve-animations** | 审计→排序→自包含计划的代码库动画改进工作流 |
| **find-animation-opportunities** | 克制原则——大部分候选应拒绝，最高 5-7 个建议 |
| **animation-vocabulary** | 动画术语反查词典 |
| **pick-ui-library** | 让 Agent 选择正确库而非手搓 |
| **prototype** | 多版本 UI 原型 + 切换器 |

---

## 二、Codem 现状审计

### 设计令牌（Design Tokens）

**现有：**
```css
:root {
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --transition-color: color 150ms ease, ...;
  --transition-all: all 200ms ease;
}
```

**问题：**
1. ❌ **无自定义缓动曲线** — 全程使用 `ease`，没有 `cubic-bezier()` 强曲线
2. ❌ **无 `--ease-out` / `--ease-in-out` / `--ease-drawer` 令牌** — 无法区分进入/退出/移动场景
3. ❌ **`--transition-all: all 200ms ease` 是反模式** — `transition: all` 是 review-animations 的硬阻断触发器
4. ⚠️ **duration 令牌未按组件分类** — 缺 `--duration-press` (100-160ms)、`--duration-tooltip` (125-200ms) 等

### 过渡/动画使用统计

从 `styles.css`（10,251 行）扫描结果：

| 问题 | 出现次数 | 严重度 |
|------|---------|--------|
| `transition: all ...` | **15+ 处** | 🔴 高 — 每处都是性能隐患 |
| `ease` / `ease-in-out` 内置缓动 | **40+ 处** | 🟡 中 — 缺乏"冲击力" |
| `ease-in` | 未发现 | ✅ 好 |
| `cubic-bezier()` 自定义曲线 | **0 处** | 🔴 高 — 完全缺失 |
| `@keyframes` | **3 处** | 🟡 — 需检查是否用于动态 UI |
| `transform-origin` 显式设置 | **1 处**（宠物精灵） | 🔴 高 — 弹窗/下拉菜单未设 |
| `backdrop-filter` | **5 处** | ✅ 已有磨砂玻璃 |
| `prefers-reduced-motion` | **1 处** | 🟡 — 覆盖不足 |
| `:active` 按压反馈 | **1 处**（toolbar-btn） | 🔴 高 — 大量按钮无按压反馈 |
| `will-change` | **1 处**（宠物精灵） | 🟡 — 仅宠物使用 |
| `@starting-style` | **0 处** | 🟡 — 未使用现代入场动画 |

### Apple Design 原则对照

| Apple 原则 | Codem 现状 | 差距 |
|-----------|-----------|------|
| **Response — 消灭延迟** | 按钮无 `:active` 反馈，用户按下无视觉响应 | 🔴 关键缺失 |
| **Direct manipulation — 1:1 追踪** | 无手势拖拽场景（桌面应用合理） | ✅ 不适用 |
| **Interruptibility — 可中断性** | 3 处 `@keyframes` 不可中断 | 🟡 低风险 |
| **Springs over duration** | 无弹簧动画，全部 CSS transition | 🟡 缺少物理感 |
| **Spatial consistency — 对称路径** | 弹窗用 `createPortal` 渲染到 body，无入/出路径对称性 | 🟡 中风险 |
| **Materials & depth** | 已有 `backdrop-filter: blur(12px)` | ✅ 较好 |
| **Typography — 光学排版** | 单一 `letter-spacing` 未按字号调整 | 🟡 低风险 |
| **Reduced motion** | 仅 1 处 `@media` 声明 | 🔴 覆盖不足 |

---

## 三、优化项清单

按 review-animations 的 10 条不可商量标准 + apple-design 原则分类：

### P0 — 感觉破坏级回归（必须修复）

| # | 问题 | 现状 | 目标 | 影响范围 |
|---|------|------|------|---------|
| 1 | **`transition: all` 泛滥** | 15+ 处 `transition: all 0.15s ease` | 指定具体属性：`transition: transform 150ms ease-out, background 150ms ease-out` | 全局 `styles.css` |
| 2 | **按钮无按压反馈** | 仅 `.toolbar-btn:active` 有；其他按钮、卡片、可点击元素均无 | 所有 `button`/`.clickable` 元素加 `:active { transform: scale(0.97) }` + `transition: transform 160ms ease-out` | `styles.css` 全局按钮样式 |
| 3 | **无自定义缓动曲线** | 0 处 `cubic-bezier()` | 新增 `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` 等令牌，全局替换 | `:root` 令牌 + 全局引用 |

### P1 — 明显可感知的改进

| # | 问题 | 现状 | 目标 | 影响范围 |
|---|------|------|------|---------|
| 4 | **弹窗无 `transform-origin`** | 下拉菜单/弹出菜单默认 `center` | 设置 `transform-origin` 为触发源位置，模态框例外（保持 center） | `.context-menu`、`.dropdown`、`.popover` 系列 |
| 5 | **入场动画从 `scale(0.96)` 偏大** | `context-menu-in` keyframe 从 `scale(0.96)` → 可接受但 `opacity` 同步 | 确保所有入场都 `scale(0.95)` + `opacity: 0`，从非零 scale 开始 | `@keyframes context-menu-in`、`@keyframes fadeIn` |
| 6 | **`@keyframes` 用于可快速触发的 UI** | `fadeIn` keyframe 用于 `animation: fadeIn 0.15s ease` | 改用 CSS transition（可中断+可重定向）或 `@starting-style` | `.fadeIn` 类的使用处 |
| 7 | **弹窗入/出路径不对称** | `createPortal` 渲染的 Dialog 无入/出对称动画 | 进入从右滑入 → 退出右滑出；模态框淡入 → 淡出对称 | `Dialog`、`Modal`、`SettingsPanel` |

### P2 — 性能优化

| # | 问题 | 现状 | 目标 | 影响范围 |
|---|------|------|------|---------|
| 8 | **`transition: all` 触发非 GPU 属性** | `all` 可能动画化 `width`/`height`/`padding` 等触发布局的属性 | 仅动画 `transform` 和 `opacity`（GPU 合成属性） | 全局 |
| 9 | **`will-change` 不足** | 仅宠物精灵使用 | 为频繁动画元素添加 `will-change: transform` | 下拉菜单、弹出面板、消息列表 |
| 10 | **CSS 变量驱动的子元素 transform** | 未检查但需审计 | 避免在父元素上改 CSS 变量来驱动子元素 transform（触发样式重算风暴） | 组件代码审计 |

### P3 — 可访问性

| # | 问题 | 现状 | 目标 | 影响范围 |
|---|------|------|------|---------|
| 11 | **`prefers-reduced-motion` 覆盖不足** | 仅 1 处全局声明 | 为所有 transform 动画提供降级：改为 opacity cross-fade；保留颜色/透明度变化 | `styles.css` 全局 `@media` 块 |
| 12 | **无 `prefers-reduced-transparency`** | 无 | 半透明面板（`backdrop-filter`）提供更不透明/纯色降级 | `@media (prefers-reduced-transparency: reduce)` |
| 13 | **悬停动画未门控** | 无 `@media (hover: hover) and (pointer: fine)` | 触摸设备 tap 会触发 false hover | `.:hover` 类的元素 |

### P4 — Apple Design 精细化

| # | 问题 | 现状 | 目标 | 影响范围 |
|---|------|------|------|---------|
| 14 | **无弹簧动画** | 全部 CSS transition，无物理感 | 为可中断/手势驱动的交互引入弹簧（如 `agent-message-queue` 通知、`NeedsYouPanel` 弹出） | `framer-motion` 或 `motion` 库引入 |
| 15 | **排版未按字号调整 letter-spacing** | 全局单一 `letter-spacing` | 大标题 `letter-spacing: -0.02em`，正文 `0`，小字 `+0.01em` | `styles.css` 排版规则 |
| 16 | **材质分层不够** | `backdrop-filter: blur(12px)` 统一值 | 大表面更厚（`blur(20px) saturate(180%)`），小元素更薄；不叠放半透明层 | 导航栏/工具栏 vs 弹出面板 |
| 17 | **滚动边缘效果** | 无 | 在浮动 chrome 与内容交界处加渐变遮罩，替代硬边框线 | `.messages-container` 顶部/底部 |
| 18 | **材质入场动画** | 半透明面板仅 `opacity` 淡入 | 同时动画 `blur` 半径和 `scale`，让材质像真实物质一样"抵达" | 磨砂玻璃面板入场 |

### P5 — 动画机会发现（find-animation-opportunities）

基于频率门控原则，这些是**值得添加**动画的场景：

| # | 场景 | 频率 | 建议动画 | 说明 |
|---|------|------|---------|------|
| 19 | **消息列表入场** | 偶尔 | `scale(0.97)` + `opacity: 0` → `ease-out` 200ms | 新 AI 回复消息从下方微缩放淡入 |
| 20 | **文件变更追踪面板展开** | 偶尔 | `clip-path: inset(0 0 100% 0)` → `inset(0 0 0 0)` 200ms | FileChangesList 展开时从上到下揭示 |
| 21 | **Settings 子标签切换** | 偶尔 | `clip-path` 重复标签列表技巧 | 实现完美颜色过渡 |
| 22 | **空状态首次展示** | 稀有/首次 | 30-80ms stagger 卡片入场 | QuickAccessCards 首次显示时级联入场 |

**不应动画的场景（明确拒绝）：**

| 场景 | 原因 |
|------|------|
| 斜杠命令菜单 `/` 开关 | 键盘触发，100+次/天 → 永不动画 |
| 会话切换 | 高频操作 → 不动画 |
| 模型选择器切换 | 高频操作 → 不动画 |
| 消息流式打字 | 功能性内容展示 → 装饰妨碍阅读 |

---

## 四、修复优先级与工作量

### Phase D-1: 设计令牌基础（1 天）

```css
:root {
  /* Easing curves — strong, not built-in */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);

  /* Duration by component type */
  --duration-press: 120ms;
  --duration-tooltip: 150ms;
  --duration-dropdown: 200ms;
  --duration-modal: 300ms;

  /* Transition presets — specific properties, never "all" */
  --transition-transform: transform var(--duration-press) var(--ease-out);
  --transition-opacity: opacity var(--duration-fast) var(--ease-out);
  --transition-color: color var(--duration-fast) ease, background-color var(--duration-fast) ease, border-color var(--duration-fast) ease;
}
```

### Phase D-2: 全局 `transition: all` 清除（1 天）

- 批量替换 `transition: all 0.15s ease` → `transition: var(--transition-color)` 或指定具体属性
- 批量替换 `transition: all 0.2s ease` → `transition: transform var(--duration-normal) var(--ease-out), opacity var(--duration-normal) var(--ease-out)`

### Phase D-3: 按钮按压反馈（0.5 天）

```css
/* Global press feedback */
button:active,
.clickable:active {
  transform: scale(0.97);
  transition: transform 120ms var(--ease-out);
}
```

### Phase D-4: 弹窗 transform-origin + 入场优化（0.5 天）

```css
.context-menu,
.dropdown-menu,
.popover {
  transform-origin: var(--transform-origin, center top);
  transition: transform var(--duration-dropdown) var(--ease-out),
              opacity var(--duration-dropdown) var(--ease-out);
}

/* Modal stays centered — exempt */
.modal {
  transform-origin: center;
}
```

### Phase D-5: 可访问性全覆盖（0.5 天）

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
  /* Keep opacity/color transitions for comprehension */
  .fade-in { transition: opacity 200ms ease !important; }
}

@media (prefers-reduced-transparency: reduce) {
  .floating-overlay-panel,
  .skill-picker-popup {
    backdrop-filter: none;
    background: var(--bg-secondary);
  }
}

@media (hover: hover) and (pointer: fine) {
  .clickable:hover { /* hover styles only here */ }
}
```

### Phase D-6: 材质分层 + 滚动边缘（1 天）

```css
/* Thicker material for nav/toolbars */
.nav-bar, .toolbar {
  backdrop-filter: blur(20px) saturate(180%);
  background: rgba(255, 255, 255, 0.6);
}

/* Lighter material for small popups */
.popover, .dropdown {
  backdrop-filter: blur(12px) saturate(140%);
  background: rgba(255, 255, 255, 0.8);
}

/* Scroll edge effect — fade where content meets chrome */
.messages-container::before {
  content: '';
  position: sticky;
  top: 0;
  height: 12px;
  background: linear-gradient(to bottom, var(--bg-primary), transparent);
  z-index: 10;
  pointer-events: none;
}
```

### Phase D-7: 入场动画现代化（1 天）

```css
/* Replace keyframes with @starting-style */
.fade-in-element {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out);

  @starting-style {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

### 总工作量

| 阶段 | 内容 | 天数 | 优先级 |
|------|------|------|--------|
| D-1 | 设计令牌（缓动曲线+duration+transition预设） | 1 | P0 |
| D-2 | 全局 `transition: all` 清除 | 1 | P0 |
| D-3 | 按钮按压反馈 | 0.5 | P0 |
| D-4 | 弹窗 transform-origin + 入场 | 0.5 | P1 |
| D-5 | 可访问性全覆盖 | 0.5 | P1 |
| D-6 | 材质分层 + 滚动边缘 | 1 | P2 |
| D-7 | 入场动画现代化 | 1 | P2 |
| **合计** | | **5.5 天** | |

---

## 五、潜在隐患

### 1. `transition: all` 批量替换的回归风险 — ⚠️ 中

**问题**：`transition: all` 虽然是反模式，但它确保了所有属性变化都有过渡。替换为具体属性后，可能遗漏某些属性的过渡。

**缓解**：逐个审查每处 `transition: all` 的上下文，确定该元素实际会变化哪些属性。

### 2. `:active` 全局样式的副作用 — 🟡 低

**问题**：全局 `button:active { transform: scale(0.97) }` 可能影响某些不需要按压反馈的元素（如禁用状态的按钮）。

**缓解**：加 `button:not(:disabled):active` 选择器。

### 3. `@starting-style` 浏览器兼容性 — 🟡 低

**问题**：`@starting-style` 是较新的 CSS 特性，旧版 WebView2 可能不支持。

**缓解**：提供 `data-mounted` 属性 fallback，或使用 CSS transition + JavaScript `requestAnimationFrame` 双保险。

### 4. 弹簧动画引入成本 — 🟢 已有方案

**问题**：引入弹簧动画需要 `framer-motion` 或 `motion` 库。

**缓解**：Codem 前端已有 React 生态，`motion` 库轻量（~30KB gzipped）。仅用于少量场景（NeedsYouPanel、agent-message-queue 通知），不影响整体包大小。

### 5. 磨砂玻璃性能 — ⚠️ 中

**问题**：`backdrop-filter: blur(20px) saturate(180%)` 在大面积使用时可能影响渲染性能，尤其是在 Tauri WebView 中。

**缓解**：限制 `blur(20px)` 仅用于导航栏/工具栏；弹出面板保持 `blur(12px)`；监控帧率。

---

## 六、结论

Codem 的 UI 基础已有一定水准（磨砂玻璃、CSS 变量系统、统一 duration 令牌），但对照 emilkowalski/skills 和 apple-design 标准，存在 **3 个 P0 级问题**和 **18 个可优化项**：

### 最高杠杆修复（做完感觉质变）

1. **消灭所有 `transition: all`** — 改为具体属性，性能+正确性双赢
2. **全局按钮 `:active { scale(0.97) }`** — 每个交互都有即时物理反馈
3. **引入自定义缓动曲线** — `cubic-bezier(0.23, 1, 0.32, 1)` 取代 `ease`，让每个动画"有冲击力"

这三项改完，用户会**感受到**界面变好了，但说不出具体哪里——这就是"看不见的细节复合"。

### 完整修复需 5.5 天，最小可行版（D-1 + D-2 + D-3）仅 2.5 天

---

## 七、三套皮肤适配分析

### 皮肤架构概述

Codem 有三套独立皮肤，通过 `data-skin` 属性切换：

| 皮肤 | CSS 文件 | 行数 | 变量前缀 | 明暗模式 | 材质 |
|------|---------|------|---------|---------|------|
| **default** | `styles.css` | 10,251 | `--bg-*` / `--accent` | ✅ light + dark | `backdrop-filter: blur(12px)` |
| **hub** | `skin-hub.css` | 681 | `--hub-*` + 覆盖默认变量 | 仅深色 | 无磨砂玻璃 |
| **dream** | `skin-dream.css` | 580 | `--dream-*` + 覆盖默认变量 | light + dark | `backdrop-filter: blur(var(--dream-blur-px))` |

**关键架构设计：**
- `ThemeManager` 在切到 hub/dream 时设置 `data-skin` 属性，切回 default 时清除
- Hub 皮肤用 `--hub-*` 前缀独立变量 + 覆盖 `--bg-*` / `--accent` 等默认变量
- Dream 皮肤注入 `--dream-*` 变量 + 覆盖默认变量 + 透明覆盖层

### 每套皮肤的现状审计

#### Default 皮肤（`styles.css`）

| 指标 | 数量 | 说明 |
|------|------|------|
| `transition: all` | **15+ 处** | 全局反模式 |
| 自定义 `cubic-bezier()` | **0 处** | 完全缺失 |
| `:active` 按压反馈 | **1 处** | 仅 toolbar-btn |
| `backdrop-filter` | **5 处** | 统一 `blur(12px)` |
| `transform-origin` | **1 处** | 仅宠物精灵 |
| `prefers-reduced-motion` | **1 处** | 覆盖不足 |

#### Hub 皮肤（`skin-hub.css`）

| 指标 | 数量 | 说明 |
|------|------|------|
| `transition: all` | **1 处** | 第 554 行 |
| 自定义 `cubic-bezier()` | **0 处** | 同样缺失 |
| `:active` 按压反馈 | **0 处** | 无 |
| `backdrop-filter` | **0 处** | 无磨砂玻璃（深色实心） |
| `transform-origin` | **0 处** | 无 |
| `prefers-reduced-motion` | **0 处** | 无声明 |
| `ease-in` | **0 处** | ✅ 好 |
| `transition` 使用 | **8 处** | 均用 `0.2s` + 内置 `ease`/`ease-in-out` |

**Hub 评估**：问题最少，因为它更简洁（681 行 vs 10,251 行）且无磨砂玻璃。但缺缓动曲线和按压反馈。

#### Dream 皮肤（`skin-dream.css`）

| 指标 | 数量 | 说明 |
|------|------|------|
| `transition: all` | **1 处** | 发送按钮 `transition: all 0.2s` |
| 自定义 `cubic-bezier()` | **0 处** | 缺失 |
| `:active` 按压反馈 | **0 处** | 无 |
| `backdrop-filter` | **15+ 处** | 大量使用 `blur(var(--dream-blur-px))` |
| `transform-origin` | **0 处** | 弹窗未设 |
| `prefers-reduced-motion` | **0 处** | 无声明 |
| `saturate()` | **1 处** | 浮动面板 `saturate(1.2)` |

**Dream 评估**：磨砂玻璃使用最丰富，但完全没有缓动曲线、按压反馈和可访问性降级。

### 三皮肤改动矩阵

#### MVP 版（D-1 + D-2 + D-3，2.5 天基础 → 三皮肤适配后）

| 改动 | Default | Hub | Dream | 说明 |
|------|---------|-----|-------|------|
| **D-1 缓动曲线令牌** | `:root` 新增 `--ease-out` 等 | 无需改（用默认 `:root` 令牌） | 无需改（用默认 `:root` 令牌） | ✅ **改 1 处即三皮肤生效** |
| **D-2 清除 `transition: all`** | 15+ 处批量替换 | 1 处替换 | 1 处替换 | 各自独立修改 |
| **D-3 按钮按压反馈** | `styles.css` 全局 `button:active` | 无需额外改（继承默认） | 无需额外改（继承默认） | ✅ **改 1 处即三皮肤生效** |

**MVP 三皮肤总改动量：**
- `styles.css`：15+ 处 `transition: all` 替换 + `:root` 令牌 + 全局 `:active` = **约 1.5 天**
- `skin-hub.css`：1 处 `transition: all` 替换 = **0.5 小时**
- `skin-dream.css`：1 处 `transition: all` 替换 = **0.5 小时**
- **三皮肤 MVP 总计：2.5 天**（与基础版相同，因为缓动令牌和按压反馈是全局的）

#### 完全版（D-1 ~ D-7，5.5 天基础 → 三皮肤适配后）

| 改动 | Default | Hub | Dream | 额外工作量 |
|------|---------|-----|-------|-----------|
| **D-1 缓动曲线令牌** | `:root` 新增 | 继承 | 继承 | 0 |
| **D-2 清除 `transition: all`** | 15+ 处 | 1 处 | 1 处 | +1h |
| **D-3 按钮按压反馈** | 全局 `:active` | 继承 | 继承 | 0 |
| **D-4 弹窗 transform-origin** | `.context-menu` 等 | 无弹窗样式（继承默认） | `.dropdown-menu` / `.popover` / `.context-menu` 需追加 | +2h |
| **D-5 可访问性** | 全局 `@media` 块 | 继承 | Dream 需追加 `@media (prefers-reduced-transparency)` 降低 blur | +1h |
| **D-6 材质分层** | 导航/工具栏 `blur(20px)` | 无磨砂（实心深色） | 已有 `blur(var(--dream-blur-px))` 但需检查分层 | +1h |
| **D-7 入场动画现代化** | `@keyframes` → `@starting-style` | 无 keyframe | 无 keyframe | 0 |

**完全版三皮肤总改动量：**

| 文件 | 改动内容 | 工作量 |
|------|---------|--------|
| `styles.css` | D-1~D-7 全部 | 4.5 天 |
| `skin-hub.css` | 1 处 `transition: all` + 检查继承 | 0.5h |
| `skin-dream.css` | 1 处 `transition: all` + transform-origin + reduced-transparency 降级 + 材质分层检查 | 4h |
| **三皮肤完全版总计** | | **~5.5 天**（额外仅 +4h） |

### 关键发现：三皮肤改动的"免费午餐"

1. **缓动曲线令牌（D-1）**：在 `:root` 定义一次，三套皮肤**自动继承** — Hub 和 Dream 都覆盖了 `--bg-*` 等颜色变量，但**不覆盖 `--ease-*` 和 `--duration-*`**，所以全局令牌直接生效。

2. **按钮按压反馈（D-3）**：在 `styles.css` 的全局 `button:active` 声明一次，三套皮肤**自动继承** — Hub 和 Dream 的 CSS 没有覆盖 `:active` 伪类。

3. **`transition: all` 清除（D-2）**：需要**逐文件修改**，但 Hub（1处）和 Dream（1处）改动量极小。

4. **可访问性（D-5）**：`@media (prefers-reduced-motion)` 在 `styles.css` 全局声明一次即三皮肤生效。但 Dream 需要额外加 `@media (prefers-reduced-transparency: reduce)` 来降低 blur 效果。

5. **材质分层（D-6）**：Default 和 Dream 已有 `backdrop-filter`，可以调整分层。Hub 是实心深色背景，**不需要磨砂玻璃分层**，自动跳过。

### 结论

**三皮肤不会显著增加工作量**，因为：
- 全局令牌（缓动曲线、duration、按压反馈）定义在 `:root`，三皮肤自动继承
- Hub 和 Dream 皮肤各自只有 **1 处** `transition: all` 需要修改
- Dream 皮肤需要额外处理 `transform-origin` 和 `prefers-reduced-transparency`，但工作量约 4 小时

| 方案 | 基础工作量 | 三皮肤额外 | 总计 |
|------|-----------|-----------|------|
| **MVP 版** | 2.5 天 | +1h | **~2.5 天** |
| **完全版** | 5.5 天 | +4h | **~6 天** |
