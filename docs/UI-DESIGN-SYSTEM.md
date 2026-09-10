# UI 设计系统与一致性门禁（UI-DESIGN-SYSTEM）

> 基准参考：**frakio-work**（`MadsGao/frakio-work`，纯 CSS + CSS 变量，无 Tailwind）。
> 本文件是**唯一真相源**：所有页面/子页面/弹窗/浮层/插件面板都必须按这里的令牌与组件语言实现。
> 配套工具：`tools/ui-audit/scan-ui.mjs`（审计）、`tools/ui-audit/codemod-tokens.mjs`（令牌化改写）。

## 1. 为什么会有这份文档

用户反馈：「很多页面尤其是子页面或弹窗样式和项目风格不一致，有的字体大有的地方小，排版五花八门」。
根因是**历史多代 UI 并存**：不同时期写的页面各自写死字号/色值/圆角/间距，
即使 `src/styles.css` 里已有完整令牌（v0.96 起对标 frakio-work），也没有强制约束。

所以本文件 = **令牌契约** + **可重复运行的审计**，把「风格是否统一」变成数字，直到清零。

## 2. 令牌契约（唯一取值来源）

### 2.1 字号（`src/styles.css` 的 `--fs-*`，随 `--ui-font-scale` 缩放）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--fs-xs` | 10px | 徽标、辅助说明、密集元信息 |
| `--fs-sm` | 12px | 次要文本、按钮、表格、列表副标题 |
| `--fs-base` | 13px | **正文基准**（桌面应用主密度） |
| `--fs-md` | 14px | 主要文本、列表项标题、输入框 |
| `--fs-lg` | 16px | 区块标题、面板标题 |
| `--fs-xl` | 18px | 页面标题、弹窗标题 |
| `--fs-2xl` | 20px | 大标题 |
| `--fs-3xl` | 24px | Hero 标题 |
| `--fs-display` | 28px | 演示模式 / 空态大标题 |
| `--fs-hero` | 32px | 引导页 / 全屏演示主标题 |

**禁止**在 `style` 或 CSS 里写数字字号（含 `32px`）。frakio-work 的密度事实：12px(291 次)、
11px(211)、10px(175)、13px(170) 是主力，最大 UI 文本也只有 24px —— **层级靠字重与颜色，不靠字号**。

### 2.2 圆角（`--radius-*`）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--radius-sm` | 4px | 小控件、标签、滚动条滑块、密集行 |
| `--radius` | 8px | 按钮、输入框、图标按钮（**主力**） |
| `--radius-md` | 10px | 卡片、浮层、下拉菜单 |
| `--radius-lg` | 14px | 弹窗、抽屉、大卡片 |
| `--radius-full` | 9999px | 胶囊、开关、头像 |

**禁止** 3px / 5px / 7px / 9px 这类离格值（审计硬规则）。

### 2.3 颜色（语义令牌，禁止硬编码）

- 文本：`--text-primary` / `--text-secondary` / `--text-muted` / `--text-on-accent`
- 面：`--bg-primary`（页面/卡片底）、`--bg-secondary`、`--bg-tertiary`、`--bg-hover`
- 线：`--border-primary`（10% alpha）、`--border-secondary`（6%）
- 强调/状态：`--accent` / `--accent-hover` / `--accent-muted`、`--success` / `--warning` / `--error` / `--info`
- 浮层：`--overlay-backdrop`（0.5）、`--overlay-backdrop-strong`（0.72）、`--dropdown-bg`、`--tooltip-*`
- 阴影：`--shadow-sm/md/lg/popover`；字体/动效：`--duration-*`、`--ease-*`、`--transition-*`

frakio-work 的两条关键惯例（我们同步遵守）：

1. **状态色不做实心填充**：一律「文字色 + 8–10% 同色底 + 18–22% 同色边」
   （用 `color-mix(in srgb, var(--error) 10%, transparent)` 表达）。
2. **浮层优先用「环」而不是边框**：`box-shadow: 0 0 0 1px var(--border-primary), <投影>`。

### 2.4 间距与尺寸

- 间距走 **2px 网格**（1px 仅用于细线）；常用 4/6/8/10/12/14/16/20/24。
- 控件高度：密集 28–32px、标准 36px、表单 40–42px；图标按钮 30–38px。
- 图标与文字：**14px 图标 ↔ 13px 标签**，`gap: 8px`；描边 1.8。
- 内容宽度：工作区 1180px、表单/设置 880px；页面 gutter `clamp(24px, 3.2vw, 48px)`。
- 区块标题上间距 26px、下 10px；页面头行 `margin-bottom: 20px`。

### 2.5 动效与交互

- 时长 120ms（浮层入场）/ 140ms（颜色）/ 160ms（默认）/ 200ms（抽屉）；曲线 `--ease-out`（本项目 `cubic-bezier(.23,1,.32,1)`，与 frakio 的 `(.2,.8,.2,1)` 同族）。
- 位移极小：≤2px 位移 + ≤2% 缩放；**hover 只换底色**（`--bg-hover`），不做位移/边框互换。
- `:focus-visible` 必须有可见焦点环；弹窗必须支持 Esc 关闭 + 点击遮罩关闭（统一走 `modal-overlay`）。
- 尊重 `prefers-reduced-motion`。

## 3. 组件语言（统一外壳）

| 组件 | 统一做法 |
| --- | --- |
| 弹窗 / 对话框 | `className="modal-overlay"`（遮罩）+ 内层面板；标题 `--fs-xl`，正文 `--fs-base`，圆角 `--radius-lg`，内边距 20–22px |
| 抽屉 / 侧面板 | 同上外壳，圆角 `--radius-lg`，入场 200ms |
| 卡片 | 圆角 `--radius-md`，底 `--bg-secondary`，边 `--border-primary`，hover 只换边色 |
| 按钮 | 主按钮 `--accent` 底 + `--text-on-accent` 字；次按钮透明底 + `--border-primary` 边；禁用 `opacity: .58` + `cursor: not-allowed` |
| 输入 / 下拉 | 高 32–36px，圆角 `--radius`，底 `--input-bg`，边 `--border-primary`，聚焦换 `--accent` 边 |
| 徽标 / 胶囊 | 圆角 `--radius-full`，`--fs-xs`，语义色按 §2.3 的「文字+淡底+淡边」 |
| 空态 | 居中、`--fs-base`、`--text-muted`，配 1px 虚线或 `0 0 0 1px` 环，最小高度 130px |
| 列表行 | 32–36px 行高，hover `--bg-hover`，分隔线 `--border-secondary` 且不顶到边 |

## 4. 审计门禁（可重复运行）

```bash
node tools/ui-audit/scan-ui.mjs              # 汇总：每规则计数 + 问题最多的文件
node tools/ui-audit/scan-ui.mjs --verbose    # 附示例
node tools/ui-audit/scan-ui.mjs --census     # 字面量分布（决定下一波映射表）
node tools/ui-audit/scan-ui.mjs --rule=color-hardcoded-tsx
node tools/ui-audit/codemod-tokens.mjs [--write]   # 令牌化改写（默认只预览）
```

规则分层：

| 规则 | 级别 | 含义 |
| --- | --- | --- |
| `fs-hardcoded` | error | 字号硬编码（应为 `var(--fs-*)`） |
| `color-hardcoded-tsx` / `-css` | error | 硬编码颜色（应为语义令牌） |
| `radius-offscale` | error | 圆角离格 |
| `modal-shell-bespoke` | error | 自建浮层外壳，未用统一 `modal-overlay` |
| `spacing-offgrid` | warn | 间距不在 2px 网格 |
| `inline-style-dense` | warn | 单文件内联样式过密（应抽 CSS 类） |
| `css-class-undefined` | warn | **tsx 里用了但没有任何 CSS 定义的类名**（等于没样式；已排除运行时状态类与第三方库类名） |

**合法例外**（写在 `scan-ui.mjs` 的 `ALLOWLIST`，每条都带理由）：皮肤令牌定义源、
PPT 生成内容配色、大富翁游戏插件（自带美术语言）、图书馆角色调色板注释常量。
例外不是后门 —— 新增例外必须在文档里说明理由。

## 5. 进度（迭代记录）

| 轮次 | 日期 | error | warn | 做了什么 |
| --- | --- | --- | --- | --- |
| 基线 | 2026-09-10 | 533 | 64 | 建立审计工具与例外表；确定现场：字号/色值/圆角/间距/弹窗外壳五类漂移 |
| 第 1 波 | 2026-09-10 | 144 | 63 | 令牌化 codemod：478 处替换（色 409 / 圆角 32 / 字号 37）＋新增 `--fs-display`/`--fs-hero`/`--overlay-backdrop(-strong)` 令牌；`fs-hardcoded` 与 `radius-offscale` 已清零 |
| 第 2 波 | 2026-09-10 | **102** | 63 | 淡色底/边按规范改写：`rgba(状态色, α)` → `color-mix(in srgb, var(--token) N%, transparent)`，84 处；新增 `css-class-undefined` 规则（tsx 用了但 CSS 里没定义的类名）—— 首次运行即暴露 **409 处"等于没样式"**，成为下一波最高性价比的工作队列 |
| 第 3 波 | 待做 | — | — | 清单化的"未定义类名"：NotebookWorkspace(105) / NoteEditor(50) / ConfigEditor(33) / CorrectionResultPanel(23) / PipelineNextStepDialog(19) / ToolCallCard(19)…，补 CSS 或改用既有基元 |
| 第 4 波 | 待做 | — | — | 15 个自建浮层外壳统一到 `modal-overlay`/`modal-editor`（含 z-index 令牌化：现在有 23 个 tsx 数值 + 13 个 CSS 层级） |
| 第 5 波 | 待做 | — | — | 组件语言收口：按钮/输入/卡片/空态/列表行改用具名类，压缩 50 个「内联样式过密」文件；补 `--radius-xs: 6px`（259 处用到 6px 却无令牌）与 `--space-*` 刻度 |
| 第 6 波 | 待做 | — | — | 门禁回归测试（计数 ≤ 基线并持续下降，直至 0）+ 文档 + 发布 |

### 全项目现场事实（来自 UI 交互界面清单，作为工作队列）

- 挂载层：64 个 `SlotBridge` 渲染点 + 54 处 `slots.register` + 44 处 `createPortal`（另 51 个 SlotBridge 在 `App.tsx`）。
- 浮层：205 个 overlay 类名实例散在 60 个 tsx 里，约 35 种外壳；`var(--z-*)` 只被用了 9 次，
  而有 23 个 tsx 数值 z-index + 13 个 CSS 层级（`modal-overlay` 是 200，`--z-modal` 是 1300，互相矛盾）。
- 令牌缺口：`--space-*` **完全不存在**（CSS 2482 + tsx 1389 个数值间距）；6px 圆角被用 259 次却没有令牌
  （`--radius-sm` 是 4px，`--radius` 是 8px）；`11px`/`9px` 也没有对应字号令牌。
- 参考实现：`src/plugins/library-ops/styles/library-ops.css`（399 处 `var(--…)`，仅 1 处字面色）
  与本文件的令牌契约一致，**后续迁移以它为形状标准**。
- 例外（已在 `scan-ui.mjs` 写理由）：皮肤令牌源、PPT 生成内容配色、大富翁游戏插件、图书馆角色调色板。

## 6. 工作方式（每一波都跑同一套）

1. `scan-ui.mjs --census` 看字面量分布 → 决定这一波的映射表；
2. `codemod-tokens.mjs`（先 `--dry-run` 看清单，再 `--write`）；
3. 人工处理 codemod 不敢猜的（渐变、动态拼接、图表入参、自建外壳）；
4. `npx tsc --noEmit` + `npx vitest run` + `--host=` 版面审计；
5. 更新 §5 表格，直到 error/warn 全部为 0。
