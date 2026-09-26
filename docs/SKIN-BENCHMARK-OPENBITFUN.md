# 皮肤对标：OpenBitFun（亮色）vs 我们默认皮肤（亮色）

> 对标对象：[`GCWing/OpenBitFun`](https://github.com/GCWing/OpenBitFun)（MIT，Rust + 桌面应用，2329 star），
> 取 `main` 的 **`ded818312a39`**（2026-09-25 04:45Z）。用户点名"它的皮肤很漂亮"，
> 所以这份文档只回答一件事：**它的亮色皮肤凭什么好看、我们差在哪、按什么顺序补**。
>
> **如实标注（先说清这份分析没做什么）**：
> ① 本会话的模型**读不了图片**，所以**没有做像素级并排比对**。下面每一个结论都来自
> 两边的**源码数值**（他们的 DTCG 令牌 / CSS module；我们的 `src/styles.css` 与运行中装机版的计算值）
> 与我写的对账脚本 —— 不是"看起来更高级"这种判断。
> ② 他们的 README 桌面截图**本身就是浅色的**（程序化量：平均亮度 **0.986**、近白像素 **96.2%**），
> 所以我还做了一版**统计量对比**（§3.1b，平均亮度 / 近白占比 / 主色分布）；
> 但两张图的**内容不同**（他们是带内容的宣传图，我们是一屏近空的会话），所以那组数字只当参考，
> **不算视觉评审**。要真看观感，请自己对一眼：我们的浅色截图在 `.preview-shot/_shot-light-154.png`，
> 他们的在 `%TEMP%\obf\openbitfun-desktop.png`。
> ③ 我们的数值取自**运行中的装机版 1.16.154**（CDP 读 `getComputedStyle`），不是只读 CSS 文件。

---

## 1. 先看结构：它的"漂亮"是长在一条流水线上的

| 维度 | OpenBitFun | 我们 |
| --- | --- | --- |
| 令牌形态 | DTCG（`$type`/`$value`）JSON + **token-engine 构建期解析**，生成 CSS 变量（`--openbitfun-*`） | 手写在 `src/styles.css` 的 CSS 自定义属性（`:root` / `[data-theme]` / `[data-skin]`） |
| 令牌规模 | `system.tokens.json` **669** 条 + `light.tokens.json` **150** 条 + `reference.tokens.json` **139** 条 | 浅色合计 **184** 条（其中颜色 **73** 条） |
| 分层 | `reference`（数学刻度）→ `system`（刻度/解剖）→ `theme-*`（明暗/高对比）→ `ui`（组件，**不依赖具体主题**） | `:root`（刻度）→ `[data-theme]`（明暗）→ `[data-skin]`（皮肤，直接压组件样式） |
| 组件样式 | **91 个 CSS module，457 107 字节（≈446 KB）**，一个组件一个文件 | `src/styles.css` **18 063 行 / 507 541 字节（≈496 KB）** + 4 个附属 CSS |
| 明暗/高对比/密度 | `light` / `dark` / `high-contrast-light` / `high-contrast-dark` 四套 + `density-compact` / `density-touch` | `light` / `dark` + 两套皮肤（hub / dream）；**无高对比档、无密度档** |
| 配套工具 | `design-lab`（令牌工作台：改令牌→预览→写回源文件，校验失败自动回滚）、组件 registry（唯一真相）、皮肤市场、`create-openbitfun-skin` 内置技能 | 无令牌编排工具；皮肤靠人写 CSS + 对比度测试守 |
| 外观治理 | `audit-theme-colors` **86 KB**、`audit-frontend-colors` **40 KB**、`audit-appearance-contracts` **41 KB**、`audit-typography-tokens` **34 KB**、`audit-web-motion` **5 KB** + 每个应用一份**颜色基线 JSON** + `theme-visual-governance-contract.json`（13 KB） | `light-theme-contrast.test.ts`（28 KB）、`skin-contrast.test.ts`、`skin-system.test.ts`、`contrast-checker.ts`、`tools/ui-audit/*`（图标/命中区/间距例外/标注输入） |

**一句话**：它的好看来自"**组件只消费语义令牌 + 令牌有完整刻度 + 有机器守着**"这三件事的组合；
我们今天有**刻度**和**部分守门**，缺的是**语义完整性**和**覆盖组件层的门禁**。

---

## 2. 硬数字对账（同样是"绕过令牌写死的量"，两边同一个脚本数出来的）

脚本：`node .preview-shot/_css-token-discipline.mjs <文件...>`

| | 他们（10 个组件 CSS，829 条声明） | 我们（组件层，去掉令牌块后） |
| --- | --- | --- |
| **颜色字面量（hex + rgba）** | **0** | **540**：`styles.css` 256（242 hex + 14 rgba）、`skin-dream` 179、`skin-hub` 80、`codem-ui` 23、`notebook-workspace` 2、`task-center` 0 |
| 圆角写死 | 22 | **513（14 种取值）** |
| 字号写死 | 14 | **917** |
| 行高写死 | 12 | 73 |
| 间距写死 | 36 | **1774** |
| 阴影写死 | 5 | 64 |
| `z-index` 写死 | 0（全走 `layer.*`） | 54（17 种取值） |
| `var()` 占比 | 50% | 54%（这一项我们不落后：他们的组件 CSS 里结构属性多，不吃令牌） |

**能一句话说清差距的只有第一条**：他们的组件层**一个颜色字面量都没有**，我们有 **540 处**
（把令牌块里的定义也算上是 910）。颜色一旦散落在组件里，皮肤/明暗档就永远只能"改一处、漏三处"——
这也正是我们为什么每加一套皮肤都要新写一大坨 CSS（hub 475 条声明、dream 458 条）。

---

## 3. 亮色皮肤的逐维度差距（带两边的原始值）

### 3.1 表面阶梯：他们更"纸白"，我们更"灰板"

| 角色 | OpenBitFun（light） | 我们（light，装机版实测） |
| --- | --- | --- |
| 内容面 | `panel = #ffffff`、`scene = #ffffff` | `--bg-primary = #ffffff`、`--surface-content = #ffffff` |
| 画布/底 | `canvas = #fdfdfd` | —（没有这一档） |
| 次级容器 | `tertiary = #f7f7f7`、`workbench = #f3f3f5` | `--bg-tertiary = #f2f2f0` |
| 结构外壳 | `chrome = #f8f8f9` | `--sidebar-bg = #f4f4f2` |
| 悬停/按下 | `action.neutral.surface 5%` / `surfaceHover 8%` / `surfacePressed 10%` | `--bg-hover = #eeeeec`（**只有一档**） |
| 局部着色 | `surface.subtle = rgba(16,26,39,0.03)` | — |

他们的"灰"全部 ≥ `#f3f3f5`，而且**每一档都有语义名字**（谁在编辑器后面、谁在导航后面）；
我们最深的持久面是 `#eeeeec`，比他们的任何一档都深，且**只有 `--bg-hover` 一个交互面**。
观感差别就在这：他们的界面读起来像"**纸上的墨**"，我们的像"**白底上贴了几块灰卡**"。
（`#f4f4f2` → `#f2f2f0` 之间的 4 档灰，在我们这边是同一种"更深一点的灰"，没有角色区分。）

### 3.1b 截图统计量（客观代理指标，非视觉评审）

脚本：`node .preview-shot/_palette-stats.mjs <png>`（统计，不"看图"）

| 指标 | 我们（装机版浅色档，`_shot-light-154.png`） | 他们（README 桌面图，浅色） |
| --- | --- | --- |
| 平均亮度（0=黑 1=白） | 0.968 | **0.986** |
| 近白像素（>0.93） | 90.4% | **96.2%** |
| 落在 `#f0f0f0` 档的像素（即"灰面"占比） | **32.8%** | **5.5%** |
| 有彩度像素（sat>0.18） | 0.5% | 0.1% |
| 彩色像素的色相分布 | **240° = 90%**（几乎只有品牌紫/蓝一色） | 120° 33% / 150° 26% / 0° 21% / 30° 21%（青绿 + 暖色多色并存） |

两点值得记下：
1. **"灰面占屏比"差了 6 倍**（32.8% vs 5.5%）—— 这是 §3.1 那个"灰板感"的量化形态：
   我们大面积铺灰（侧栏 + 内嵌块 + 悬停），他们用白面 + 少量灰点缀。
2. **我们的彩色几乎全部来自同一个品牌色**（240° 一侧 90%），他们的彩色来自状态/身份色的多种色相。
   这对应 §3.8 那层缺失的"身份色"。（⚠️ 两张图内容不同，尤其我们那屏几乎是空会话，
   所以这两个数字只作方向性参考。）

### 3.2 文字：我们是 16.5:1，他们是 12.6:1 —— 这是"精致"与"工程感"的分水岭

脚本：`node .preview-shot/_contrast-pairs.mjs`（先按 alpha 合成再算 WCAG）

| 文本角色 | 我们的对白底对比度 | 他们的对白底对比度 |
| --- | --- | --- |
| 正文/主文本 | `#1f1f1e` **16.50** | `rgba(0,0,0,.80)` **12.63** |
| 次级文本 | `#57564f` **7.37** | `rgba(0,0,0,.60)` **5.74** |
| 弱级/元信息 | `#6e6c66` **5.25** | `#6a6a6a` **5.41** |
| 分组标题 | —（用弱级 11px） | `rgba(0,0,0,.40)` **2.85** + `overline` 排版（8–9px / 字距 0.08–0.1em / 大写） |
| 禁用 | 100 处写死 `opacity: .4/.5/.55` | `opacity.disabled = 0.55`（一个令牌） |

两点结论：
1. **我们的正文对比度比他们高 30%**（16.5 vs 12.6）。中文小字下这是可读性优势，**不建议照抄他们的 12.6**；
   但"纯黑级"的正文（`#1f1f1e` ≈ 近黑）确实比"80% 黑"更硬、更工程。**建议取中间值**（例如正文落到 13–14:1、
   次级 6.5–7:1），并把它变成门禁的**区间**（下限守可读、上限守观感），而不是只守下限。
2. 他们的文字是**alpha 黑**：底色一变（皮肤、彩色卡、图片底），文字自动跟着变。
   我们是**写死的暖灰 hex**，所以皮肤一换就得手工重调文字色（`skin-hub.css` 里就重调了三个）——
   这是"每套皮肤都要重写一遍"的结构性原因之一。

### 3.3 边框：他们有 3 档 + 输入态，我们只有 1 档

| | OpenBitFun | 我们 |
| --- | --- | --- |
| 结构分隔 | `border.subtle 8%`（对白底 **1.17**） | `--border-secondary 5%`（**1.10**） |
| 控件边界 | `border.default 15%`（**1.36**） | `--border-primary 9%`（**1.19**） |
| 强调/强边界 | `border.strong 34%`（**2.15**） | **没有这一档** |
| 输入框 | `field.border 8%` → `borderHover 20%`（**1.61**）→ `borderFocus` 实色 `#858585` | **没有 hover/focus 档**（组件里各写各的 rgba） |
| 状态边框 | `status.*.border = 30% of emphasis` | 没有 |

"精致"的一半来自**克制的层次**：他们用 8/15/34% 三档就把"分区 / 控件 / 强调"分清楚，
且 hover 时输入框边界从 1.19 抬到 1.61（**看得出来、又不吵**）。我们只有 9% 和 5%，
于是"想强调"的地方只能去写死一个 `rgba(...)` —— 这就是 910 处颜色字面量里占比最大的一类。

### 3.4 圆角：发现一个**真 bug**（不是审美问题）

| | 值 | 说明 |
| --- | --- | --- |
| 文档/注释 | `--radius-xs: 0.25rem` 注释写"4px：细条、滚动条滑块、极密集内联块" | 第 34 波定的 |
| 另一处 `:root`（第 15495 行） | `--radius-xs: 8px;` 注释写"小圆角（补齐 6px 这一档）" | 注释说 6px、写的是 8px |
| **装机版运行时的实际值** | **8px** | 后定义覆盖前面（同优先级、后者胜） |
| 影响面 | 组件层 **81 处** `var(--radius-xs)` | 全部比设计意图圆 → 且与 `--radius`（也是 8px）**完全重复**，`xs` 这一档等于消失 |

他们的圆角是 **9 档单调刻度**：`4 / 6 / 8 / 12 / 16 / 20 / 24 / 32 / pill`（另有大卡片 28px）；
我们是 `4(→实际 8) / 6 / 8 / 10 / 14 / 20 / pill`，**且组件层还冒出 14 种写死取值**（`50%` 13 处、
`2px 2px 0 0`、`0 var(--radius) var(--radius) 0` 这类混写）。
→ 差距不是"他们圆角更好看"，而是**我们的圆角刻度被自己覆盖坏了**，且组件层不受刻度约束。

### 3.5 排版：他们有 246 条"复合角色"，我们连行高都没有令牌

| | OpenBitFun | 我们 |
| --- | --- | --- |
| 字号刻度 | 21 档（7px → 64px，含 `micro/meta/xs/sm/base…`） | 11 档（10–32px，随 `--ui-font-scale` 缩放，**这一项我们有优势**：全局可缩放） |
| 行高 | **16 个** `lineHeight.*`（1.1–1.8，含 `code 1.52` / `ui 1.4` / `reading 1.58`） | **0 个令牌**，73 处写死 |
| 字距 | **10 个** `letterSpacing.*`（-0.04em → 0.26em） | 0 个令牌 |
| 复合排版风格 | **246** 条 `type.*`（`body.xs/sm/md/lg`、`label.*`、`heading.*`、`meta`、`micro`、`overline.*`）＝ family+size+weight+lineHeight+letterSpacing 一体 | 无（只有 `--fs-*` 与 `--weight-*` 两个独立轴） |
| 组件里怎么用 | `var(--openbitfun-type-body-sm-font-size)` / `type-body-md-line-height` / `type-label-selected-font-weight` | 直接写 `font-size: 11px`（**917 处**） |

顺带记一个口径不一致（不严重，但会让后来人猜）：我们的令牌 `--fs-base` 是 **13px**，
而 `body` 实际用的是 `--fs-md`（**14px**，装机版实测 `font-size: 14px`）——
也就是"叫 base 的那一档不是基准"。他们那边基准是 `type.body.md = font.size.base = 14px`，名实一致。

他们那条 **`overline`** 风格（8–9px + 大写 + 字距 0.08–0.1em）是"分组标题看起来像设计过"的直接来源：
我们对应位置是"11px 弱级灰字"（`--fs-2xs` + `--text-muted`）。
→ **可动的最小一步**：补 `--lh-*` 令牌 + 4–6 个复合角色类（`text-meta` / `text-label` / `text-body` /
`text-overline` / `text-heading`），先把新代码用上，再按棘轮把老代码搬过来。

### 3.6 阴影/高度：我们有两套互相竞争的阶梯，还带一个紫色阴影

| | OpenBitFun（light） | 我们 |
| --- | --- | --- |
| 高度阶梯 | `xs 0 1px 2px 4%` / `sm 0 2px 4px 5.5%` / `base 0 4px 8px 7%` / `lg 0 8px 16px 9%` / `xl 0 12px 24px 11%`（**单调、中性 navy 着色**） | `--shadow-sm 0 1px 2px 6%`、`--shadow-md 0 4px 12px 8%`、`--shadow-lg 0 12px 32px rgb(107 92 231 / 10%)`（**品牌紫**） |
| 另一套 | — | `--shadow-raise-1/2/3`（双层，`--shadow-color 14%` / `-soft 6%`） |
| 语义阴影 | `composer` / `menu` / `overlay` / `accentGlow`（由 accent 派生）/ `innerHighlight`（暗色用） | `--shadow-popover` |
| 使用分布 | 全部走令牌 | `raise-*` 6 处 vs `sm/md/lg/popover` 8 处 vs **写死 64 处** |

→ 我们等于有**两套半**阶梯（raise-* / sm-md-lg / popover），团队每次都要猜"这次该用哪个"，
所以 64 处干脆自己写。他们的做法是**一条单调阶梯 + 少数语义阴影**（弹出的 composer、菜单、遮罩、发光）。
另外 `--shadow-lg` 用品牌紫当阴影色，在浅色底上会让"弹窗"泛紫 —— 他们把所有高度阴影统一成中性色，
只把品牌色留给 `accentGlow` 这一条明确的语义阴影。

### 3.7 状态与交互态：他们是"四角色"，我们是"四个平色"

| | OpenBitFun | 我们 |
| --- | --- | --- |
| 状态色 | 每种状态 **emphasis / content / surface / border** 四角色（`content` 用 `color-mix(emphasis 76%, 黑)` 压深，`surface` 10%、`border` 30%） | `--success/--warning/--error/--info` **各一个值** |
| 中性动作面 | `action.neutral.surface / surfaceHover / surfacePressed / border / content（含 Disabled）` | `--bg-hover` + 组件里各写各的 |
| 禁用 | `opacity.disabled = 0.55`（+ 专用内容色） | **100 处**写死 `opacity: .4/.5/.55` |
| 焦点 | `focus.width 2px` / `offset 2px` + 主题里的 ring 令牌 | `--focus-ring-*`（**我们有，且更细**：颜色由 accent 派生） |
| 选中 | `control.highlight.*`（accent 底 + `onLight` 内容色） | `--accent-muted` + 各处写死 rgba |

→ 我们是"够用"的水平：状态色有，但只有一种强度，所以任何"浅底状态条"都得现写 rgba；
禁用只有 opacity 一个自由度，取值还散成 4 种。

### 3.8 身份色：他们有一层"不是状态的颜色"，我们没有

他们明确区分三类：**强调色**（cyan，产品主操作）、**状态色**（info/success/warning/danger）、
**身份色**（`identity.assistant` 粉、四种 Harness 模式各一色、六个全局搜索动作各一色），
并在令牌注释里写死了一句契约：*"these colors do not imply status"*。
我们有 `--chart-cat-1..6`（图表用）与状态色，但**没有"身份"这一层** ——
所以"哪个模式 / 哪个助手 / 哪个动作"在界面上只能靠图标和文字区分。

### 3.9 组件解剖令牌：他们把"菜单行高"也令牌化了

他们的 `system.tokens.json` 里有 **155 条 `control.*` + 99 条 `layout.*`**，细到
`overlay.menu.itemHeight = 30px`、`itemPaddingInline = {space.2}`、`itemRadius = {radius.base}`、
`headingHeight = 24px`、`overlay.dialog.maxInlineSizeXlarge`、`layout.field.labelWidthMd = 200px`、
`layout.empty.mediaSizeLg`……
我们这一层是**写死在组件 CSS 里的**（`--panel-sidebar-width 520px` 是少数例外）。
→ 这就是"同一类控件在不同面板里长得不一样"的根因：尺寸没有共享契约。

### 3.10 密度与高对比：他们是四套令牌，我们是两套

- 他们：`light` / `dark` / `high-contrast-light` / `high-contrast-dark` + `density-compact` / `density-touch`
  （密度只改 600 字节的令牌覆盖，不动组件 CSS）。
- 我们：`light` / `dark` + 皮肤 hub / dream；**没有高对比档、没有密度档**；
  有的只是"字号滑杆"（`--ui-font-scale`，这一项我们做得比他们细）。

### 3.11 皮肤/主题：他们是"数据 + 工具 + 市场"，我们是"手写 CSS"

- 他们：`theme-openbitfun` 包（三套主题值）+ `design-lab` 的 Colors/Token 工作台（改令牌→实时预览→
  **写回令牌源文件**，校验失败自动回滚）+ `skin-market` 应用 + `create-openbitfun-skin` 内置技能
  ⇒ 新增一套皮肤 = 产出一份令牌 JSON，**组件 CSS 一行不改**。
- 我们：`skin-hub.css`（475 条声明 / 22 KB）、`skin-dream.css`（458 条 / 31 KB）
  既覆盖令牌**又重写组件样式**（hub 里 92 个颜色字面量），新增皮肤的成本是"再抄一遍 CSS"。

### 3.12 我们**已经领先/不落后**的地方（别为了对标丢掉）

1. **正文可读性**：16.5:1（我们）vs 12.6:1（他们）；我们弱级灰也守住了 4.5:1（他们 caption 只有 2.85）。
2. **全局字号缩放**：`--ui-font-scale` 驱动全部 `--fs-*` 刻度（他们的 21 档字号是定值，没看到等价的可调入口）。
3. **层级链**：16 条 `--z-*` 有序 + 有回归测试（他们的 `layer.*` 同样是 16 条，两边平手）。
4. **减动效**：57 条循环动画**逐条**有显式关停 + JS 侧 `matchMedia` 兜底（`motion-uncovered` 门禁）——
   这一项我们比他们"按小块拆分写法"更严格（数字取自我们第 40 波同口径实测）。
5. **命中区/可访问性门禁**：24×24 下限、WCAG 2.5.8 间距例外实测、图标按钮命名、标注输入 —— 成体系的机器判据。
6. **焦点环**：`:focus-visible` 规则 **490** 条（他们 57 条，我方第 39 波同口径实测），
   且 `:focus { outline: none }` 抑制已清理干净（我们 5 处 vs 他们 19 处）。

---

## 4. 优化意见（按"投入产出 / 风险"排序，每条都给判据）

> 原则：**先修坏掉的与能机器守住的，再动审美**。每条都写清"改哪里 + 为什么 + 怎么验"。

### P0（本周就能做完，且都有明确判据）

**P0-1 修 `--radius-xs` 被覆盖，并禁止主题/皮肤块重定义几何令牌**
- 现状：`src/styles.css:79` 定义 4px，`:15495` 又定义 8px（注释说 6px）⇒ 运行时 8px，
  **81 处**受影响，且 `--radius-xs === --radius`（重复档）。
- 做法：① 决定 xs 到底是 4px 还是 6px（我建议 **6px**：注释本意就是 6px，且 `--radius-sm` 是 6px
  ——那不如把 xs 定为 4px、sm 保持 6px，两档都真实存在）；② 只在一处定义；③ 加门禁：
  `[data-theme]` / `[data-skin]` 块内**不得**出现 `--radius-* / --space-* / --control-* / --z-*` 覆盖。
- 判据：`skin-system.test.ts` 增一条"几何令牌唯一来源"；运行时装机版读 `--radius-xs` 不再是 8px。
- 影响面：81 处圆角，全是密集控件/菜单/滚动条 —— 这是"细节变精致"的最低成本一步。

**P0-2 补边框阶梯 + 输入框交互态**
- 现状：只有 `--border-primary 9%` / `--border-secondary 5%` / `--border-separator 5%`，
  输入框 hover/focus 边框在各组件里写死（颜色字面量的主要来源）。
- 做法：按他们的三档 + 输入态补令牌（数值可按我们的色相折算）：
  `--border-subtle 8%`（1.17）/ `--border-default 15%`（1.36）/ `--border-strong 34%`（2.15）/
  `--field-border` / `--field-border-hover 20%`（1.61）/ `--field-border-focus`（实色）。
  迁移顺序：输入框 → 卡片 → 表格/列表分隔 → 浮层。
- 判据：新增 `--border-*` 全覆盖；`light-theme-contrast.test.ts` 加"三档强度单调且落在 1.15–2.3 区间"；
  颜色字面量棘轮下降（见 P0-4）。

**P0-3 行高令牌 + 复合排版角色（这是"排版像设计过"的关键）**
- 现状：**0 个行高令牌 / 73 处写死**；字号写死 **917 处**；没有复合角色，组件靠 `font-size: 11px` 拼。
- 做法：① 补 `--lh-tight 1.2` / `--lh-ui 1.4` / `--lh-base 1.5` / `--lh-reading 1.58` / `--lh-code 1.52`；
  ② 出 5 个角色工具类：`.text-overline`（大写 + 字距 0.08em + `--fs-xs`）、`.text-meta`（11px/1.4）、
  `.text-label`（12px/1.2 + medium）、`.text-body`（13px/1.5）、`.text-heading`（16px/1.3 + semibold）；
  ③ 把分组标题（侧栏分组、设置分组、工具卡标题）先换成 `.text-overline`。
- 判据：`tools/ui-audit` 增一条"排版令牌门禁"：新增/改动的 `line-height`/`font-size` 字面量只许降
  （棘轮基线 = 今天的 73 / 917），并在 `scan-ui.mjs` 的口径里逐波记录。

**P0-4 颜色字面量棘轮（把"910 处"变成只许降的数字）**
- 做法：写 `tools/audit/scan-css-color-literals.mjs`（可直接用我已经写好的
  `.preview-shot/_css-token-discipline.mjs` 的统计口径），对组件层（排除令牌块）的
  `hex` / `rgba()` / `named color` 计数，写进 `tools/audit/color-literal-baseline.json`，
  在 `npm run audit` 里跑（我们已有 17 道门禁，这是第 18 道）。
- 判据：基线只许降；每个 PR 新增字面量会红。**他们那侧同一个口径是 0**，所以这条门禁的上限很清楚。

### P1（一轮一波，观感提升明显）

**P1-1 表面阶梯"提亮一档"并补齐角色**
- 现状 vs 他们：`bg-tertiary #f2f2f0` / `sidebar #f4f4f2` / `bg-hover #eeeeec`（最深）
  vs 他们 `tertiary #f7f7f7` / `chrome #f8f8f9` / `workbench #f3f3f5`（最浅）；
  截图统计里"灰面占屏比"我们 **32.8%**、他们 **5.5%**（§3.1b）。
- 做法：把"次级容器"整体提亮 4–6 个亮度点（≈ `#f7f7f6` / `#f5f5f4`），保留**一档**明显更深的
  悬停色（`#ececea`）；补 `--surface-raised`（白卡浮在灰底上）与 `--surface-subtle`（3% 局部着色）。
- 风险控制：我们文字对比度是按 `--bg-tertiary` 算的（`--text-muted` 4.68），底色变亮后**只会更安全**；
  但"灰块区分度"会下降，所以需要一档更深的 `--border`（配合 P0-2）来补结构。
- 判据：`light-theme-contrast.test.ts` 重跑（阈值不降）；`.preview-shot/audit-light-ui-*.json` 复量一轮。

**P1-2 文字令牌 alpha 化（为皮肤解耦）**
- 做法：`--text-primary/secondary/muted` 改为"由 `--text-base-color` + alpha 派生"（`color-mix(in srgb, var(--text-base) 88%, transparent)` 这类），
  皮肤只改 `--text-base-color` 一个值；并给对比度门禁加**上限**（正文 ≤ 15:1，避免再次回到"纯黑硬字"）。
- 为什么值得：现在每套皮肤都要手工重调三个文字色（`skin-hub.css` 就是这么干的），这是"皮肤一多就失控"的根源。

**P1-3 阴影阶梯统一**
- 做法：保留一条单调阶梯（`xs/sm/base/lg/xl`），把 `--shadow-raise-*` 的语义并入
  `--shadow-menu / --shadow-composer / --shadow-overlay`；`--shadow-lg` 的**品牌紫**改成中性色，
  品牌色只留给 `--shadow-glow`（对应他们的 `accentGlow`）。
- 判据：阴影写死计数棘轮（今天 64）；`--shadow-*` 用量统计里不再出现两套阶梯并存。

**P1-4 状态色四角色 + 禁用令牌**
- 做法：每种状态生成 `--{status}-emphasis / -content / -surface / -border`（`surface` 10%、`border` 30%、
  `content` = emphasis 与黑混合 68–80%，与我们现有色相的实测对比度对齐）；补 `--opacity-disabled 0.55`。
- 判据：状态相关颜色字面量棘轮下降；`opacity: 0.4/0.5` 这类写死替换成令牌（100 处 → 目标 < 20）。

**P1-5 浮层/组件解剖令牌（首批 6 个就够）**
- 做法：把 `overlay.menu.itemHeight / itemRadius / surfacePadding / itemPaddingInline`、
  `dialog.maxInlineSizeSm/Md/Lg`、`field.labelWidthMd`、`empty.mediaSize*` 令牌化，并从组件 CSS 引用。
- 判据：这几处不再有写死尺寸；`scan-ui.mjs` 增加"解剖令牌覆盖率"一栏。

### P2（结构性，需要产品决策或较多工时）

**P2-1 高对比 + 密度两档**
- `[data-contrast="high"]`（约 10 个令牌：文字更黑、边框更实、焦点环更粗）与
  `[data-density="compact"]`（约 6 个令牌：`--control-*` / `--space-*` 覆盖）——**只加令牌块，不改组件 CSS**。
- 这一条直接借用他们的做法，成本低、收益是"可访问性 + 专业感"。

**P2-2 身份色一层**
- 给"助手 / 用户 / 四种执行模式 / 工具族"各一个身份色（与状态色、图表色分开命名，并在令牌注释里
  写清"不表状态"），用于头像、模式徽标、工具卡左侧标记。

**P2-3 皮肤数据化 + 皮肤预览页**
- 把皮肤从"手写 CSS"改成"令牌 JSON/TS 对象 → 运行时注入 CSS 变量"，
  组件样式**一行不改**（现在 hub/dream 各 400+ 条声明里，绝大多数应该只是在补令牌覆盖）。
- 收益：① 新增皮肤成本从"抄 500 行 CSS"降到"填 40 个令牌"；
  ② **所有对比度门禁可以自动覆盖每一套皮肤**（现在 `skin-contrast.test.ts` 只能盯已经写好的那几处）；
  ③ 可以做"皮肤预览网格"（他们有 design-lab，我们退一步也可以做一个只读预览页）。
- 判据：hub/dream 迁移后，`skin-*.css` 里只剩令牌块（颜色字面量 0）；`npm run verify` 全绿。

**P2-4 外观治理补齐（三道）**
1. **颜色用量审计**：按"语义角色 × 表面"注册可用组合（他们用 `frontend-color-surface-registry.json` + 每应用基线），
   禁止未注册的配对；
2. **排版审计**：所有 `font-size/line-height/letter-spacing` 必须来自令牌（棘轮）；
3. **动效审计**：动效时长/缓动必须来自 `--duration-*` / `--ease-*`（我们已有令牌，但没有门禁）。
- 我们已有 `npm run audit` 17 道，这三道可以按现有规矩接进去（含变异自证）。

---

## 5. 怎么复核（命令级）

```powershell
# 1) 我方令牌清单（按类别）
node .preview-shot/_our-tokens.mjs [关键词]          # 例：node .preview-shot/_our-tokens.mjs radius

# 2) 我方"绕过令牌写死"的量 + 皮肤文件体量
node .preview-shot/_skin-inventory.mjs

# 3) 两边同一个口径的纪律对比（可传任意 CSS 文件）
node .preview-shot/_css-token-discipline.mjs src\styles.css $env:TEMP\obf\ui\Button.module.css

# 4) 对比度对账（我方浅色 vs 对方 light 令牌）
node .preview-shot/_contrast-pairs.mjs

# 5) 对方的令牌汇总（下载的 json 在 %TEMP%\obf）
node .preview-shot/_obf-tokens.mjs $env:TEMP\obf\light.tokens.json shadow

# 6) 装机版亮色档的**真实计算值**（只切 DOM 属性、不写设置项）
node .preview-shot/cdp.mjs "@.preview-shot/_light-mode-probe.js" 500

# 7) 浅色截图 + 调色板统计（客观代理指标；截图只是给人看的）
node .preview-shot/_light-shot.mjs .preview-shot/_shot-light-154.png
node .preview-shot/_palette-stats.mjs .preview-shot/_shot-light-154.png
```

对方文件下载（已存在 `%TEMP%\obf`）：`gh api repos/GCWing/OpenBitFun/contents/<path> -H "Accept: application/vnd.github.raw"`；
或 `Invoke-WebRequest https://raw.githubusercontent.com/GCWing/OpenBitFun/main/<path> -OutFile ...`。
**注意**：`web_fetch(github.com)` 在本机被 DNS 策略挡下（"resolves to a non-public IP"），要用 `gh api` / `raw.githubusercontent.com`。

---

## 6. 建议的落地顺序（把上面的意见压成一条时间线）

| 波次 | 做什么 | 一句话判据 |
| --- | --- | --- |
| 第 1 波 | P0-1（`--radius-xs`）+ P0-4（颜色字面量棘轮上线） | 圆角不再被覆盖；字面量计数进 `npm run audit`，只许降 |
| 第 2 波 | P0-2（边框三档 + 输入态） | 输入框能用令牌表达 hover/focus；边框强度 1.15–2.3 单调 |
| 第 3 波 | P0-3（行高 + 复合排版角色） | 分组标题走 `.text-overline`；排版字面量棘轮下降 |
| 第 4 波 | P1-1（表面提亮）+ P1-2（文字 alpha 化） | 对比度门禁重跑全绿；浅色整屏"灰块感"下降 |
| 第 5 波 | P1-3（阴影统一）+ P1-4（状态四角色 + 禁用令牌） | 阴影/状态字面量棘轮下降 |
| 第 6 波 | P2-1（高对比/密度）+ P2-3（皮肤数据化） | hub/dream 只剩令牌块；新增皮肤不改组件 CSS |
| 持续 | P2-4（三道外观审计） | 三道接进 `npm run audit`，各带变异自证 |
