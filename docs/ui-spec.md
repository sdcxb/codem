# Codem UI 规格（唯一口径）

> 这份文档是**给人看的界面契约**，也是机器检查的输入：`tools/audit/check-doc-tokens.mjs`
> 会核对这里引用的每个令牌名是否真的在 CSS 里定义（判据 `UIDOC-1/2`）。
> 改界面时先改这里，再改代码；文档与实现不一致时以**检查脚本**为准。

## 1. 令牌（唯一来源：`src/styles.css` 的 `:root` 与主题档）

### 1.1 面与文字

| 令牌 | 用途 |
|---|---|
| `--bg-primary` | 主内容面（最亮/最暗的那一档） |
| `--bg-secondary` | 面板、侧栏、卡片头 |
| `--bg-tertiary` | 内嵌块、输入底、代码块底 |
| `--surface-raised` | 浮起面（弹层/浮窗的实体底） |
| `--text-primary` / `--text-secondary` / `--text-muted` | 正文 / 次要 / 元信息 |
| `--border-primary` | 常规描边 |
| `--accent` | 品牌色（同一皮肤下所有强调共用） |
| `--success` / `--warning` / `--error` | 状态色（浅底用 `color-mix(... 10%, transparent)`） |

### 1.2 间距、圆角、字号、图标

| 家族 | 刻度 |
|---|---|
| 间距 | `--space-1` … `--space-9`（4px 起步的 2px 网格） |
| 圆角 | `--radius-sm` / `--radius` / `--radius-full` |
| 字号 | `--fs-2xs` / `--fs-sm` / `--fs-base`（跟随 `--ui-font-scale`） |
| 图标 | `--icon-xs` / `--icon-sm` / `--icon-md`（八级刻度：10/12/14/16/20/24/32/48） |
| 字体 | `--font-mono`（代码/路径/行号） |

### 1.3 动效

| 令牌 | 语义 |
|---|---|
| `--duration-fast` / `--duration-normal` / `--duration-slow` | 150 / 200 / 300ms |
| `--duration-press` | 120ms（按钮按下） |
| `--duration-tooltip` / `--duration-dropdown` / `--duration-modal` | 150 / 200 / 300ms（浮层档位） |
| `--ease-out` | 出入场（强 ease-out） |
| `--ease-in-out` | 屏上移动（强 ease-in-out） |
| `--ease-drawer` | 抽屉滑入（iOS 手感） |
| `--ease-swift` | 幽灵按钮 / 高频微交互 |
| `--ease-pop` | 弹窗 / 图标回弹（带过冲） |
| `--ease-standard` | Material 标准 |

**规则**：除 `--ease-*` 的定义处外，CSS 里不许出现裸 `cubic-bezier(...)`
（`tools/audit/scan-motion-tokens.mjs`，判据 `MOTION-1..3`）。

## 2. 交互常数（代码里必须引用同名常量，不许各处写死）

| 常数 | 值 | 出处 |
|---|---|---|
| 滚动贴底容差 | 40px | `SCROLL_PIN_TOLERANCE_PX`（`core/ui/scroll-pinning.ts`） |
| 用户输入冷却 | 150ms | `SCROLL_USER_INPUT_COOLDOWN_MS` |
| 边缘渐隐羽化 | 28px / 7 档 / 贴边容差 2px | `EDGE_FADE_*`（`core/ui/edge-fade.ts`） |
| 分屏 diff 行号列收窄断点 | 480px（容器查询） | `codem-ui.css` 的 `@container toolcard` |
| 工具卡竖排断点 | 420px | `@container toolcard` |
| 设置行换行断点 | 520px | `@container settings` |

## 3. 规则

1. **不许裸值**：字号/圆角/间距/颜色/图标尺寸/动效曲线都有令牌或刻度，门禁在 `tools/ui-audit/scan-ui.mjs`。
2. **窄容器用 `@container`**：同一视口下可用宽度能差 3 倍（对话区 ↔ 抽屉），媒体查询判断不了。
3. **滚动区用边缘渐隐**：纯内容滚动区（设置内容列、引导栏）挂 `useEdgeFade`；有浮层子元素的容器不要挂
   （mask 会裁剪子元素）。
4. **运行中追加的显示口径**：`guidance-display.ts` 是唯一实现（剥附件块 + 剥模板 + id 前缀兜底），
   UI 显示用户原文，模型看模板。
5. **提示音默认关**：`codem-sound-cues` = `"0"`；WebAudio 现场合成，失败静默。

## 4. 组件清单（可视化对照：`docs/component-gallery.html`）

| 组件 | 文件 |
|---|---|
| 工具卡片（含统一/分屏 Diff） | `components/ToolCallCard.tsx`、`components/DiffBlockCard.tsx` |
| 消息气泡（含「运行中追加」徽标） | `components/MessageBubble.tsx` |
| 引导栏（待接收/立刻引导/附件） | `components/ChatPanel.tsx` |
| 设置面板（含提示音开关） | `components/SettingsPanel.tsx` |
| 图片画廊（共享元素转场） | `components/ImageGallery.tsx` |
| 滚动边缘渐隐 | `components/EdgeFade.tsx` |
