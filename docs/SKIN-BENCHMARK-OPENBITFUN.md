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

脚本：`node tools/audit/scan-style-literals.mjs`（口径写在该文件头；**这张表在 2026-09-26 更正过一次，见下面的"⚠️ 口径更正"**）

| | 他们（10 个组件 CSS，829 条声明） | 我们（组件层，去掉令牌块后） |
| --- | --- | --- |
| **裸颜色字面量**（值里没有 `var()` 且含真实颜色） | **0** | **140**：`skin-dream` 72、`skin-hub` 51、`codem-ui` 10、`styles.css` **7** |
| `var(--x, 兜底)` 里的颜色 | 0 | 386（**正当做法**，单独计数：插件/独立面板要能自带兜底渲染） |
| 行高写死 | 12 | **13**（迁移前 **100**，本轮 P0-3 把 87 处换成令牌） |
| 字距写死 | — | 17（迁移前 24） |
| **字重写死** | —（他们全走 `font.weight.*`） | **317**（`600` 181 处、`500` 95 处、`700` 29 处）—— 我们明明有 `--weight-*`（含可变字体的 560/620 细档），却只用上 43 处 |
| 字号写死 | 14 | 45 |
| 圆角写死 | 22 | 43 |
| 阴影写死 | 5 | 31 |
| `z-index` 写死 | 0（全走 `layer.*`） | 25 |
| 动效时长/曲线写死 | — | 61 |
| `var()` 占比 | 50% | 54%（这一项我们不落后：他们的组件 CSS 里结构属性多，不吃令牌） |

> ⚠️ **口径更正（2026-09-26，必须记着，不然会重犯）**
>
> 这份表的第一版把"写死"数成了 **颜色 540 / 圆角 513 / 字号 917 / 间距 1774**，理由是用了一条
> `font-size:\s*(?!var\()` 这样的负向先行断言 —— 而 **`\s*` 可以匹配零个字符**，于是
> `font-size: var(--fs-sm)` 里的空格让断言"成功"，**所有走令牌的声明都被算成了写死**。
> 实测后果：字号写死被报成 **917 处**，真实值只有 **45**。
>
> 现在的判据（三条，写在 `tools/audit/scan-style-literals.mjs` 与 `_color-literal-triage.mjs` 里）：
> ① 一条声明算"写死" ⇔ 它的值里**完全没有 `var(--…)`**；
> ② 颜色再严一层：必须**含真实颜色字面量**（`#hex` / `rgb()` / `hsl()`），且把
>    `var(--x, #兜底)` 的兜底**单独计数**（那是正当做法）；
> ③ 具名族（`border-radius`/`box-shadow`…）必须先于颜色族判定 —— 第一版在颜色族分支里 `continue`，
>    把同时匹配 `border-[a-z-]+` 的 `border-radius` 与 `box-shadow` 整族吃掉了（少报 20 + 6 处）。
>
> **结论也随口径更正而变化**：我们默认皮肤的主样式表其实**很干净**（裸颜色字面量只有 **7 处**，
> 占 11 372 条声明的 0.1%）；真正脏的是**两套皮肤文件**（dream 72 / hub 51）与**字重**（317 处不走令牌）。
> 这两条现在是 P0/P1 的靶子（P0-4 的棘轮已经把它们钉成"只许降"）。


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
| ~~第 1 波~~ ✅ **已做（1.16.155）** | P0-1（`--radius-xs`）+ P0-4（写死值棘轮上线） | 圆角不再被覆盖；棘轮进 `npm run audit`（第 19 道），只许降 |
| ~~第 2 波~~ ✅ **已做（1.16.155）** | P0-2（边框三档 + 输入态） | 输入框能用令牌表达 hover/focus；三档单调、强度在带内（LIGHT-UI-2c） |
| ~~第 3 波~~ ✅ **已做（1.16.155）** | P0-3（行高/字距令牌 + 复合排版角色） | 行高写死 100 → **13**；分组标题走 `.text-overline` |
| 第 4 波 | P1-1（表面提亮）+ P1-2（文字 alpha 化） | 对比度门禁重跑全绿；浅色整屏"灰块感"下降 |
| 第 5 波 | P1-3（阴影统一）+ P1-4（状态四角色 + 禁用令牌 + **字重令牌化 317 处**） | 阴影/状态/字重字面量棘轮下降 |
| 第 6 波 | P2-1（高对比/密度）+ P2-3（皮肤数据化） | hub/dream 只剩令牌块；新增皮肤不改组件 CSS |
| 持续 | P2-4（三道外观审计） | 三道接进 `npm run audit`，各带变异自证 |

---

## 7. 本轮已落地（1.16.155）逐条读数

| 项 | 改之前 | 改之后 | 判据（机器守） |
| --- | --- | --- | --- |
| `--radius-xs` 被重复定义 | 运行时 **8px**（注释写 4px、另一处注释写 6px），与 `--radius` 重复，**81 处**受影响 | 唯一定义 = **4px**；80 处密集控件按文档意图迁到 `--radius-sm`（6px）；两套皮肤补齐全套刻度 | `scan-token-hygiene.mjs`（H1 重复 / H2 成套 / H3 单调 / H4 类型）+ 用例 12 条 + 变异 5/5 |
| 边框阶梯 | 只有 9% / 5%，无强调档、无输入态 | **5% / 9% / 34%** 三档 + `--field-border-hover 20%` + `--field-border-focus`（= strong）并真的接到输入类控件上 | LIGHT-UI-2c（单调 + 带内 + hover 夹在中间 + 消费者存在） |
| 行高 / 字距 | 行高 **100 条全写死**、字距 **24 条全写死** | `--lh-*` 7 档 + `--ls-*` 3 档；**87 处行高、7 处字距**换成令牌（只做精确等值替换 ⇒ 零视觉变化） | 棘轮（`line-height` 13 / `letter-spacing` 17，只许降） |
| 复合排版角色 | 无 | `.text-overline`（侧栏会话分组标题）与 `.text-meta`（文件编辑器路径）**已接真实调用点** | `css-class-unused` / `css-var-unused` 基线 0（写没人用的角色当场红） |
| 写死值棘轮 | 无判据 | `tools/audit/scan-style-literals.mjs` + `style-literals-baseline.json`，9 个族的基线入库 | `npm run audit` 第 19 道；变异 5/5（塞一个裸颜色/一条写死行高都会红） |
| 暗色档不变量 | **一条都没有**（只有亮色有 LIGHT-UI-*） | DARK-UI-0…5 六条（阶梯方向、弱文字四面 ≥4.5、主次文字带、边框阶梯、accent-strong） | `light-theme-contrast.test.ts` 的 DARK-UI 组 |
| 暗色 `--text-muted` | `#888888`：在 `--bg-hover` 上 **3.92:1**（低于 4.5） | `#939393`：**4.52 / 5.09 / 5.57 / 6.25**（四个面全过） | DARK-UI-2 |
| 暗色边框 | 10% / 6% ⇒ 1.35 / 1.19（对方 dark 是 1.78 / 1.43） | **14% / 8%** ⇒ **1.54 / 1.25** | DARK-UI-4（default 必须落在 1.4–1.75） |

**顺带被自己的新门禁抓出来的三个问题（都已修，如实记）**：
① 我写的 `--border-subtle` 与 `--field-border` 两个令牌**没有消费方** ⇒ 被既有的 LIGHT-UI-5 拦下，已删；
② 我写的 `label/body/heading` 三个排版角色**没有调用点** ⇒ 被 `css-class-unused` / `css-var-unused` 拦下，已删（只留真有调用点的两个）；
③ DARK-UI-1 的"每段亮度差 ≥0.008"是我拍的门槛，实测我方 0.00579、对方 0.00668 ⇒ 按实测把门槛改成 0.005。

## 8. 暗色皮肤对标（用户："暗色已经比较好看了"）

脚本：`node .preview-shot/_contrast-pairs-dark.mjs`（**我方数值现读 `src/styles.css` 的 `[data-theme="dark"]`**，
不是写死在脚本里 —— 第一版写死过，改完令牌就过时了）。

### 8.1 好消息：我们的暗色**基本落在他们同一档**

| 维度 | 我们（dark） | OpenBitFun（dark） | 差 |
| --- | --- | --- | --- |
| 画布/底 | `--bg-primary #0e0f0f`（lum 0.0047） | `canvas = neutral.950 #0e0e10` | **几乎相同** |
| 内容面 | `--bg-secondary #1a1c1c`（0.0113） | `panel/raised/scene = neutral.900 #1c1c1f` | 差 2 个 RGB 点 |
| 面阶梯方向 | 越靠内容越亮（4 级实色） | 同方向，但**只有 2 级实色**，其余用 `rgba(255,255,255,0.06)` 叠 | 我们更细，他们更省 |
| 首段亮度差 | 0.00664 | 0.00668 | 逐位相同 |
| 次文字 | `#b0b0b0` → 7.89（内容面） | `content.secondary #b0b0b0` → 7.84 | **同一个值** |
| 主文字 | `#d4d4d4` → 11.55 | `content.primary #e8e8e8` → 13.87 | **我们偏暗**（见 8.3） |

### 8.2 本轮已经修掉的两条暗色缺口

（见 §7 表最后两行：`--text-muted` 3.92→4.52、边框 1.35→1.54。两条都是先用同一套数学量出来、
再用新增的 DARK-UI 门禁守住，不是"看着调"。）

### 8.3 还没动的暗色优化点（按性价比排序，都带数）

| # | 优化点 | 现状 vs 对方 | 建议 | 风险 |
| --- | --- | --- | --- | --- |
| D1 | **主文字亮度** | 我们 `#d4d4d4`（内容面 11.55）vs 对方 `#e8e8e8`（13.87） | 提到 `#dcdcdc`（14.0/12.48）或 `#e0e0e0`（14.54/12.97） | 暗底亮字会带来眩光争议；**用户明确说过当前暗色好看**，所以只记录不动手 —— 要动请连着 DARK-UI-2/3 一起评估 |
| D2 | **内高光（depth）** | 我们**完全没用**；对方 `shadow.innerHighlight = inset 0 1px rgba(255,255,255,.08)`（hover 升到 .24） | 加 `--shadow-inner-highlight`(+Hover)，用在卡片/浮层/主按钮的顶边 | 暗色里"亮 1px 顶边"是最有效的立体信号；但它会改变大量组件的观感 ⇒ 需要你自己看一眼再定 |
| D3 | **暗色阴影强度** | 我们 sm/md/popover = 黑 0.3/0.35/0.4；对方 xs…xl = **0.9/0.8/0.7/0.6/0.5** | 把暗色高度阶梯整体上调（例如 0.5/0.55/0.6），或只上调浮层档 | 0.9 这种极强阴影在纯黑底上会把"浮起"变成"贴黑块"，建议**先只调浮层/菜单** |
| D4 | **品牌紫阴影** | `--shadow-lg` 在暗色是 `rgba(124,108,240,0.12)`；对方把品牌色只留给 `accentGlow`，其余高度阴影全是中性黑 | 把 `--shadow-lg` 改中性、品牌色单独出 `--shadow-glow` | 低（现在两种语义混在一个令牌里） |
| D5 | **accent 的用途分层** | 我们是"一个紫"（`--accent` 4.81 / 白字压在上面只有 **3.99**）；对方 dark 用 blue.400（7.59）+ 四档浅底（5/9/15%）+ 两档边框（25/40%） | 补 `--accent-surface*`（color-mix 派生）与"浅底用深字"的规则（我们已有 `--accent-strong` 7.19 ✔ 只是用得少） | 低；白字在紫底 3.99 对正文不合格，对 ≥14px 加粗合格（AA-large 3:1） |
| D6 | **选中态与悬停态分开** | 对方有 `color.selection.surface`（持久选中）与 `surfaceHover`（瞬时悬停）两个语义；我们只有 `--bg-hover` 一档 | 加 `--surface-selected` 与 `--surface-pressed` | 低 |
| D7 | **高对比档** | 对方有 `high-contrast-dark`（5.7 KB 令牌）；我们没有 | 加 `[data-contrast="high"]` 覆盖块（约 10 个令牌） | 低（纯新增，不影响默认档） |
| D8 | **暗色专属身份色** | 对方暗色沿用同一套 `identity.*`（粉/紫/蓝/琥珀…），我们有 `--chart-cat-*` 但没"身份"语义 | 加 `--identity-*`（助手/模式/工具族）并在注释里写明"不表状态" | 低 |

---

## 9. 第二轮落地（1.16.156）：玻璃/浮层材质 + 按下态 + 禁用态 + 品牌色阶梯

用户这一轮的输入是一句观感判断 + 一个问题：

> "接着做完吧，我看上去它的背景（**尤其是左侧栏和弹出菜单**）是不是有那种透明过渡或者渐变的效果？"

### 9.1 先回答那个问题：是**半透明 + 模糊**，不是渐变（源码级取证）

| 问 | 答（对方源码 `shared/styles/_surface-recipes.scss`，`main@ded818312a39`） |
| --- | --- |
| 侧栏背景 | `@mixin sidebar-glass`：先给**不透明** `--color-surface-chrome`，`@supports` 里换成 `color-mix(chrome 90%, transparent)` + `backdrop-filter: var(--effect-blur-medium)` + `box-shadow: var(--shadow-inner-highlight)` |
| 弹出菜单 | `@mixin floating`：`surface-raised 94%` + **同一档**模糊（`blur(12px) saturate(1.2)`） |
| 有没有渐变 | **没有**。`linear-gradient` 全仓只出现在卡片装饰（`cardGradients`）、场景背景与 thinking 蒙版上；侧栏/菜单/对话框的规则里**一条渐变都没有** |
| 那"过渡感"从哪来 | ① 半透明底 ⇒ 背后的内容隐约透出；② `saturate(1.2)` ⇒ 透出来的颜色更艳；③ 顶边 1px 内高光 `inset 0 1px rgba(255,255,255,.08)` ⇒ 像一块有厚度的玻璃；④ 三档模糊（4/8/12）按浮层大小配 |
| 降级 | `prefers-reduced-transparency: reduce`、`prefers-contrast: more`、`[data-contrast='high']` 三种情况一律回到不透明 + 去掉模糊 |

**结论：它是"玻璃"（材质），不是"渐变"（颜色）。** 我们之前只有 `.popover-shell` 一处写了 `blur(12px)`，
而底色是 **98% 不透明** —— 模糊几乎等于没生效；侧栏则是纯实色 `--sidebar-bg`，一点玻璃都没有。

### 9.2 这一轮改了什么（每条都有判据）

| 项 | 改之前 | 改之后 | 判据（机器守） |
| --- | --- | --- | --- |
| 侧栏玻璃 | 纯实色（`--sidebar-bg`），无模糊 | `@supports` 里 90% + `var(--blur-medium)`（= `blur(12px) saturate(1.2)`）+ 顶边内高光；浅色侧栏底 `#f4f4f2`→`#f8f8f7` | LIGHT-UI-10 / DARK-UI-6（不透明度下限 90%/94% + 回退面必须不透明 + 三条降级条件必须在**去注释后**的源码里真的存在） |
| 浮层玻璃 | `--dropdown-bg` 98% 不透明；`.model-picker` 用的是实色 `--bg-secondary` | `--dropdown-bg` = 94% 玻璃；`.app-menu-surface` / `.slash-command-menu` / `.popover-shell` / `.model-picker` 四处**基础规则**里就是玻璃 + 令牌模糊（不再各写 `blur(12px)`） | 同上 + `css-contract` 快照（取值变了要显式 `--write`） |
| 模糊字面量 | **5 条规则、9 处声明**裸写 `blur(12px)` / `blur(4px)`（`.app-menu-surface` / `.popover-shell` / `.slash-command-menu` / `.petm-overlay` / `.file-editor-floating-overlay`） | 全部走 `--blur-subtle` / `--blur-medium`；**删掉**没人用的 `--blur-base`（照抄三档会变成"体系很全"的假象） | `css-var-unused`（零消费方当场红） |
| 按下态 | `.press-layer-host:active` 用的是**悬停**档底色 ⇒ 按下去和悬停一样 | 新增 `--surface-pressed`（浅色 10% 黑 / 暗色 **14% 白**），按下比悬停再远画布一步 | LIGHT-UI-11 / DARK-UI-7：按下是半透明的，**必须先合成到三种面上**再比；暗色最小成立 α 是 **13%**（10% 时在画布上比悬停还暗 ⇒ 方向反了） |
| 禁用态不透明度 | **0.3/0.4/0.45/0.5/0.55/0.6 六个数**（styles.css 31 处 + codem-ui.css 4 处） | 全部 `var(--opacity-disabled)` = 0.5 | 令牌卫生新增 **H5**（禁用族选择器上写裸数值就红；`:hover:not(:disabled)` 不误伤）+ DIS-1…4 |
| 品牌色浅底/描边 | **64 处**手写 `color-mix(… var(--accent) N%, transparent)`，一共 **20 种百分比** | 四档令牌（`--accent-surface` 8% / `-strong` 15% / `--accent-border` 30% / `-strong` 45%，全部派生自 `var(--accent)`），**28 处等值迁移**（零视觉变化）；剩余 43 处由**新棘轮族 `accent-tint`** 盯着只许降 | LIT-6（阶梯必须存在且不许写死 rgba）+ LIT-7 + 棘轮 `accent-tint` |
| 高对比档 | 无 | `[data-contrast="high"]`：外壳/浮层回实色 + 去掉模糊 + 侧栏描边提到 `--border-primary` | 与玻璃降级同一组断言（D7 落地） |

**顺带做的口径修正（如实记，且**不是为了让自己变绿**）**：棘轮把 `box-shadow: none` 这种**取消**也算成"写死了一个阴影"——
玻璃降级块必须写 `box-shadow: none`，于是"正确做法"反而把棘轮推高 2 处。
现在 `none`/`inherit`/`initial`/`unset`/`revert` 单独计入 `keyword`（报告里可见）、不再进 `raw`；
`bold`（真实字重 700）、`auto`、`normal` 照旧算写死。按新口径重读并**收紧**了 5 个族的基线
（box-shadow 31→29、animation/transition 61→56、font-size 45→42、font-weight 317→315、border-radius 43→42）。

### 9.3 变异自证（门禁"能报错"的证据）

- `node .preview-shot/mutate-glass-gates.mjs`：**9/9 红**（含"侧栏透明度调过头""暗色按下态抄浅色档=10%""漏写降级条件"）；
- `node .preview-shot/mutate-style-gates.mjs`：**10/10 红**（含 H5 两条：写死 0.5、令牌被删；`accent-tint` 自编 37%；阶梯令牌被写死）；
- 两条脚本都会在末尾**逐字节还原**并确认回绿。

### 9.4 还没做的（如实列，别把"没做"说成"做了"）

| 项 | 现状 | 为什么这一轮没做 |
| --- | --- | --- |
| P1-2 文字令牌 alpha 化 | `--text-secondary/muted` 仍是实色；`--accent-muted` 仍是**写死 rgba**（不跟皮肤的 `--accent`） | 文字改 alpha 后，对比度门禁必须按"合成到各个面"重算（现在的 LIGHT-UI-3 是拿实色比的），是一次独立的门禁改造 |
| P1-3 阴影阶梯统一 | 只把 `.model-picker` 并进了 `--shadow-raise-3`；两套阶梯仍并存 | `--shadow-lg`（品牌紫）被 `src/test/ui-batch-a-d.test.ts` 明确钉住（"阴影最大档使用主色调阴影"）—— 改它要连那条产品决策一起推翻，不能悄悄改 |
| P2-2 / D8 身份色 | 仍只有 `--chart-cat-*` | 需要产品决策（"助手/用户/四种模式/工具族"配色表） |
| P2-3 皮肤数据化 | hub 51 / dream 72 个裸颜色字面量仍在 | 结构性改造（皮肤 → 令牌对象 → 运行时注入），工时最大的一项 |
| D1 暗色主文字亮度 | 仍 `#d4d4d4`（11.55，参考 13.87） | **用户明确说过当前暗色好看** ⇒ 只记录不动手 |
| D3 暗色阴影强度 | 未调整 | 需要人眼确认（0.9 这种强阴影在纯黑底上会把"浮起"变成"贴黑块"） |
| P2-1 密度档 `[data-density]` | 未做 | 只加令牌块没人消费会被 `css-var-unused` 拦下 ⇒ 得先有设置入口（产品决策） |
| P2-4 三道外观审计 | 排版/动效两条已由棘轮族覆盖（`font-size`/`line-height`/`letter-spacing`/`animation-transition`）；**颜色用量注册表**未做 | 需要一张"角色 × 表面"的注册表（他们用 JSON + 每应用基线） |

---

## 10. 第三轮落地（1.16.157）：**玻璃终于看得见**了 + 阴影阶梯统一 + 状态色四角色

### 10.1 用户反馈是第一手证据："侧栏还是没有玻璃材质的效果，而且还是比较深的灰色"

第 156 轮我按参考实现的 90% 抄了不透明度，但**只抄了"数"，没抄"条件"**。
诊断脚本（`.preview-shot/_diag-sidebar-glass.mjs`，读运行中装机版的父链与计算样式）给出真因：

| 事实 | 读数 |
| --- | --- |
| 侧栏在布局里是什么 | `.app > .app-content > .sidebar`（**flex 里的一列**），右边是 `.main-area` |
| 它**背后**是什么 | `.app` 的纯色底 `rgb(255,255,255)`；body/html 也是纯色，没有任何图案或渐变 |
| 于是玻璃的实际效果 | 90% 的 `--sidebar-bg` 压在纯色上 ⇒ 模糊前后**逐位相同**，视觉上就是一块实色面板 |
| "比较深的灰色"从哪来 | 内容面纯白 `#ffffff` + 侧栏 `#f8f8f7` ⇒ 侧栏是唯一偏灰的那块；而参考实现的**工作区更灰**（`workbench #f3f3f5`），外壳（`chrome #f8f8f9`）反而最亮 |

**结论（写进口径）**：玻璃能不能看见**不取决于不透明度，取决于背后有没有东西可透**。

### 10.2 这一版做了什么

| 项 | 做法 | 判据 |
| --- | --- | --- |
| **场景层** `--scene-layer` | 外壳铺一层**有界**的场景：两个径向薄雾（品牌色 / 信息色）+ 一条 168° 渐变底；`.app` 用它当 `background-image`（画在子元素之下 ⇒ 透明标题栏透出、内容面照旧盖住、玻璃面模糊后透出） | `--scene-layer` 必须**引用** `--scene-veil`/`--scene-veil-alt`（声明的着色就是画出来的着色；变异 M1c 会红） |
| 玻璃 α 90% → **62%** | 可见度 = (1−α) × 场景着色强度 ⇒ 着色与 α 是**一对**参数，一起调 | **判据换成它本来想守的东西**：把三档文字放在「最坏场景像素 + 玻璃」的**合成**上量 ≥4.5/≥6/≥10（比"α ≥ 90%"这条抄来的代理指标严格得多）；α 只留一条 ≥0.6 的硬下限 |
| 场景着色强度 | 浅色 `--scene-veil` 16% / `--scene-veil-alt` 10%；暗色 20% / 12%（暗底要更强才看得见） | 实测（`.preview-shot/_glass-alpha-budget.mjs`）：浅色档着色 16% 时最小可行 α = **0.53**（26% 时要 0.72）⇒ 取 0.62 有余量；暗色档最小可行 ≤0.50 |
| 浅色外壳底色 | `#f8f8f7` → **`#fbfbfa`**（近白，"纸白外壳"） | 让它不再读成"灰板"；整体翻工作区底色是**另一件事**，要用户看过再定（已写进"还没做"） |
| 阴影阶梯统一（P1-3/D4） | 一条中性阶梯 `--shadow-raise-1…4`；`--shadow-md/popover/lg` 变成**阶梯的别名**；品牌色从高度里拿掉，只留 `--shadow-glow`（消费点：发送按钮悬停、选中的项目 chip）；`--shadow-sm` 并入第 1 档 | 新用例：阶梯必须中性 + 语义名必须是别名 + 发光必须派生自 `--accent`；变异 M10 |
| 暗色阴影强度（D3） | 暗色档**显式**定义阶梯（浅色档仍派生自 `--shadow-color*`）：浮层档从黑 0.30/0.40 提到 **0.42/0.55** | **DARK-UI-8**：阶梯必须单调递增 + 浮层档峰值 α ≥0.5（参考实现最低档就是 0.5） |
| 状态色四角色（P1-4） | `--<status>-surface` 10% / `-surface-strong` 20% / `-border` 30% / `-content`（浅色档往 `--text-primary` 压深 86%，暗色档=原色）；**75 处等值替换** + **7 处修可读性** | **LIT-8/LIT-9** + **LIGHT-UI-12 / DARK-UI-9**：`-content` 在 10/15/18/20% 四档自色浅底上都要 ≥4.5；新棘轮族 `status-tint`（79 处只许降） |

### 10.3 状态色那条**实测可读性缺口**（不只是"整理令牌"）

全项目 **57 处**"状态色文字压在同色浅底上"（`.git-status-*` 四个标签、`.reverted-tag`、`.terminal-tab-close`、
`.badge-info/-warning`…）。把原色放在自己的浅底上量一遍：

| 浅底 | success | warning | error | info |
| --- | --- | --- | --- | --- |
| 10% | 5.35 | 5.06 | 4.57 | 4.66 |
| 15% | 4.96 | 4.71 | **4.20** | **4.35** |
| 18% | 4.74 | **4.50** | **4.00** | **4.16** |
| 20% | 4.59 | **4.37** | **3.87** | **4.04** |

（浅色档实测；这些都是 10–12px 的小标签）⇒ 给文字一档 `-content`（往 `--text-primary` 压深到 86%
是**算出来的最小可行值**：error 需 88%、info 90%、warning 96%、success 100%），四档浅底全部过 4.5。

### 10.4 玻璃"看得见"的**客观读数**（读不了图，就量像素）

`.preview-shot/_glass-region-stats.mjs`：把侧栏矩形切成上/下两段取平均色。
⚠️ **跨图比较会被内容污染**（不同时间截的图里会话列表行数不同 —— 第一版就量出"改前上下差 13.2、改后 7.5"这种反直觉数），
所以改成**同一次会话内、同一主题下、注入前后各截一张**的 A/B：

| | 侧栏上段 | 侧栏下段 |
| --- | --- | --- |
| 浅色 改前 → 改后 | rgb(243,242,244) → **rgb(229,226,246)**（Δ**21.5**） | rgb(234,233,241) → rgb(233,232,244)（Δ3.2） |
| 暗色 改前 → 改后 | rgb(25,27,29) → **rgb(42,41,67)**（Δ**43.9**） | rgb(35,36,45) → rgb(38,38,52)（Δ7.8） |

即：外壳顶部现在有一层**看得出走向的薄雾**（浅色偏紫、暗色偏蓝紫），往下渐隐 —— 这就是"玻璃里有东西"的客观代理。

### 10.5 还剩什么（如实列）

P1-1 表面角色收口（`--surface-raised` / `--surface-subtle` 与"灰工作区 + 白卡"这层结构）、
P1-2 文字令牌 alpha/单一来源化（`--text-*` 三档仍各自写死、`--accent-muted` 仍是写死 rgba）、
P2-1 高对比 + 密度档**接进设置页**（现在 `[data-contrast="high"]` / 密度档没有任何写入方 ⇒ D7 是"有规则没人触发"）、
P2-2/D8 身份色一层、P2-3 皮肤数据化（hub / dream 的裸颜色字面量）、P2-4 颜色用量注册表。

---

## 11. 第四轮（1.16.158）：**对方"看上去不是实色"的机制查清了，而且我们也早就有一半**

用户追问：**"对标项目是怎么做的呢？看上去不是实色，学习借鉴一下"**。

### 11.1 对方源码里的机制（三件配套，缺一不可）

取对方 `main@ded818312a39` 的两个文件：`src/apps/desktop/src/appearance.rs` 与
`src/webUI/…/shared/styles/_workspace-shell-surfaces.scss`（以及 `AppLayout.scss`）：

| # | 在哪 | 原文/关键行 | 作用 |
| --- | --- | --- | --- |
| ① | `appearance.rs` | `let native_sidebar_material = cfg!(any(target_os = "windows", target_os = "macos"));` + 窗口 `.transparent(true)` + `tauri::window::Effect::Acrylic` | **系统窗口材质**（Windows Acrylic / macOS vibrancy）：由**操作系统**把窗口背后的桌面糊掉 |
| ② | 启动注入 | `root.setAttribute('data-openbitfun-native-material', 'sidebar');` + `root.style.backgroundColor = 'transparent'`（body 同样） | **网页把底色让出来** —— 材质才透得出来 |
| ③ | `_workspace-shell-surfaces.scss` | `:root[data-openbitfun-native-material='sidebar'] & { background: color-mix(chrome 90%, transparent); backdrop-filter: none; }`，注释原文：**"The OS blurs desktop pixels; a CSS backdrop only sees the webview."** | 这一档里**关掉自己的 CSS 模糊**（系统已经糊过桌面了，CSS 只能糊到空 webview） |
| ④ | 同文件 | `@mixin sidebar-overlay($surface, $opacity: 18%)` —— "Controls tint the shared material instead of covering it with another panel." | 侧栏里的**控件给材质上色**（18% 半透明），而不是盖一块不透明面板 |

另外 `AppLayout.scss` 里 `html[data-openbitfun-native-material='sidebar'], … body { background: transparent }`、
以及 `&[data-openbitfun-background-media='video'] { background: transparent }`（他们还有"背景媒体"档）。

### 11.2 我们的差距：**这四件里我们只有第 ① 件**

- 我们的 Rust 侧**早就 apply 了材质**：`window_vibrancy::apply_mica(&window, Some(true))`，失败退
  `apply_acrylic(&window, Some((18,18,18,100)))`，macOS 走 `apply_vibrancy(HudWindow)`，窗口也是 `transparent: true`；
- 但前端从来不知道这件事，`html/body/.app` 一路不透明底色 + 我们自己的场景层
  ⇒ **材质被网页整块盖住，等于白开**。这正是用户两次说"看上去还是实色"的根因，也是 1.16.157 那个
  "场景层"只解决了一半的原因（那一轮把"背后有东西"换成了我们自己的渐变，没换系统材质）。

### 11.3 本轮落地（严格照抄对方的三件配套）

| 件 | 我们的实现 |
| --- | --- |
| ① 材质 | 已有（未改）；但把"**材质到底应用成功没有**"记进 `static NATIVE_MATERIAL` 并用 `native_material` 命令暴露出去 —— 前端**猜不出来**（系统版本、用户「透明效果」开关、DWM 状态都会让 apply 失败，而失败时把底色设成 transparent 会得到"没有材质的透明窗口"，比实色更糟） |
| ② 让出底色 | `src/main.tsx` 在**首次渲染前**（`bootstrap()` 里 `await Promise.race([applyNativeMaterialHint(), 400ms 超时])` 之后才 `renderApp()`）打上 `data-native-material="sidebar"` + `data-native-material-kind=<mica/acrylic/vibrancy>`；CSS 里 `html/body/.app/标题栏/侧栏` 这一档透明，**内容面（聊天/笔记/编辑器）照旧不透明** ⇒ 桌面壁纸透不进正文 |
| ③ 关掉自己的模糊 | 这一档 `.sidebar` 与 `.titlebar` 都是 `backdrop-filter: none` |
| ④ 控件给材质上色 | `.sidebar-session`/`.sidebar-tool-item` 的 hover 改成 `color-mix(in srgb, var(--sidebar-bg) 18%, transparent)` |
| 降级 | 材质档同样受 `prefers-reduced-transparency` / `prefers-contrast: more` / `[data-contrast="high"]` 三条约束（回到不透明 + 场景层） |
| α 取值 | 材质档单独一个令牌 `--surface-glass-chrome-native` = **88%**（对方 90%）。理由：这一档背后是**无界的桌面壁纸**，对比度**算不出来也没法保证** ⇒ 用高 α 压风险；只有"有界场景层"那一档才敢用 62% |

**装机版实测（1.16.158）**：`data-native-material=sidebar`、`data-native-material-kind=**mica**`；
`html/.app/标题栏` 背景 `rgba(0,0,0,0)`，侧栏 `color(srgb .984 .984 .980 / **0.88**)` + `backdrop-filter: none`；
主内容面仍是 `rgb(255,255,255)` 不透明。A/B（同会话摘掉属性再截一张）：
标题栏中段 rgb(238,239,241) → rgb(234,231,255)（**Δ16.6**）、侧栏空白带 Δ7.1、主内容面 Δ1.4（≈0）⇒
**外壳确实换成了系统材质，正文一点没被波及**。

### 11.4 一个反直觉但重要的实测：**对方也没有"很透明"**

把对方的官方截图和我们的截图用**同一套像素统计**量（`.preview-shot/_obf-screenshot-stats.mjs`，同尺寸归一）：

| | 侧栏区平均色 | 内容区平均色 | 侧栏比内容 |
| --- | --- | --- | --- |
| 对方 `openbitfun-desktop.png` | rgb(242,242,243) | rgb(249,249,249) | 暗 **7** |
| 我们 1.16.158（材质档） | rgb(242,241,243) | rgb(246,246,246) | 暗 **4** |

也就是说：**对方侧栏也不是"看穿"的，它只比内容面暗 7 个色阶** —— "不是实色"是
「系统材质 + 内高光 + 发丝线 + 控件半透明叠色」共同给出的**细微**印象，而不是大面积透明。
我们现在这一档的读数与它**基本逐位一致**（242,241,243 vs 242,242,243）。

如实标注一处**仍然不同**的地方：对方侧栏区"有色像素占比 **0.0%**"（它的选中态是中性色），
我们是 **20.7%**（主色相 240°，即品牌紫）—— 这是我们自己"选中态用品牌色"的设计，不是本轮引入的问题；
要不要改成对方那种中性选中底，属于产品选择，已记在此处。

### 11.5 如果还想更"透"，只有两条路（都摆在桌面上）

1. 调低 `--surface-glass-chrome-native`（现在 88%）：**代价**是背后变成无界壁纸后，弱文字对比度无法保证
   （我们现在的门禁只能守住"有界场景"那一档）；
2. 加一层**背景媒体/壁纸**（对方有 `data-openbitfun-background-media='video'` 这一档）：
   那才是"一眼就不是实色"的做法，但它会把整个工作区的观感主动权交给一张图，需要产品决定。






---

## 12. 第五轮（1.16.161）：把「颜色用量」变成注册表门禁（P2-4）——第一次跑就抓出 9 处真实违规

### 12.1 为什么做这个（对标文档 §4 P2-4 的第 1 条）

对方有 `theme-color-governance-baseline.json`（budgets + allowlists，各类 max 0）与
`theme-visual-governance-contract.json`（按 surface 声明 token 家族与覆盖契约）。
我们的对应物在此之前**不存在**：第 157 轮那 57 处"状态色文字压在同色浅底上"是**人肉数出来**的
（其中浅色档 error 在 20% 浅底上只有 3.87:1），也就是说同一类问题下次还会漏。

现在 `tools/audit/scan-color-roles.mjs` 是常设门禁（audit 第 20 道），三层判据：
**登记制**（角色 × 表面必须登记）+ **实算对比度**（按两档解析 `var()`/`color-mix()` 后算，低于角色下限就红）
+ **预算棘轮**（解析不了的记 `unresolved`，只许降）。
对方用 allowlist 把"可算的东西"也放进名单里；我们把可算的部分改成**实算** —— 算得出来的不该靠名单。

### 12.2 它第一次跑就抓出来的（全部已修）

| 违规 | 实测 | 修法 |
| --- | --- | --- |
| 白字压暗色状态色块（success 5 + warning 1 + codem-ui 2） | **2.54 / 2.52** | 新增 `--text-on-status`（暗色 = 深墨水 `#101314`：四色 5.5–8.3；浅色 = 白：5.34–6.19），按**规则**迁移 22 处 |
| `--error` 文字压暗色悬停面（2 处） | **4.14** | 改用 `--error-content`，暗色那一档提到 72% 混白 |
| `--accent` 文字压暗色内嵌块/悬停面（5 处） | **3.92 / 3.48** | 改用 `--accent-strong`（#a99bff 就是"浅底上的品牌色文字"） |
| `.quote-context-banner` 次级文字压 15% 品牌浅底 | **5.99** | 换正文色（≈13:1） |
| `.sp-toggle` 白字压浅灰底 | **1.16** | **删掉那句死声明**：整条规则没人用 `currentColor` |

### 12.3 门禁自己踩的三个坑（如实记，都进了变异自证）

1. **亮色档整档没被检查**：选择器整串转义后，`:root, [data-theme="light"]` 里那个空格要求文件里也恰好是空格，
   而文件里是换行 ⇒ 亮色档令牌一个都取不到，门禁**只在暗色档上跑还报"全部通过"**。
   （变异 C5 现在钉住它：把提取改回整串转义就红。）
2. **报出的行号是错的**：去注释用"直接删"会让后面所有偏移前移，报告里
   `src/styles.css:11265 .quote-context-banner` 实际指向一个 `@keyframes`（差几百行）。
   现在改成"注释换成等长空格"，偏移与原文一致（CR-7 + 变异 C6）。
3. **半透明表面的对比度算错**：`color-mix(色 20%, transparent)` 漏了"先预乘、再除以 alpha 还原"，
   于是 `--error-surface` 被读成 rgb(41,7,9) 而不是 rgb(207,34,46)（CR-3 + 变异 C4）。
   —— 这个坑在本仓库是**第三次**（探针 / 测试助手 / 门禁），已写进工具注释。

### 12.4 一处**有意放宽并登记**的偏差

暗色档白字压品牌紫 `--accent` 实测 **3.99:1**（D5 早就量到同一条），注册表里按 **AA-large 的 3** 登记。
要过 4.5 只有两条路：把紫调深、或按钮改用深色字 —— 两者都会明显改变暗色观感，属产品决策；
门禁**不偷偷放过**，而是把这条写进注册表与文档（D5 仍挂在 O-30 里）。

### 12.5 这一步之后 P2-4 还剩什么

P2-4 原本三条：颜色用量（**本轮完成**）、排版审计（已由棘轮族 `font-size`/`line-height`/`letter-spacing` 覆盖）、
动效审计（已由 `animation/transition` 族覆盖）。也就是说 P2-4 **可以收口**了。


---

## 13. 第六轮（1.16.162）：P1-1 表面角色 + D8 身份色 —— 两项都做了「有消费方的那一半」

### 13.1 P1-1：卡片面解耦（做了），浅面阶梯（**没做，且写明理由**）

| 对标提的角色 | 我们的处置 | 理由 |
| --- | --- | --- |
| `--surface-raised`（白卡浮在灰底上） | **做了**：`--surface-raised: var(--bg-primary)`（取值刻意等于现状 ⇒ 零视觉变化），接上 4 处真卡片/面板（市场技能卡 / 多模态内嵌面板 / 自定义 diff 面板 / 性能面板） | 现状是"卡片与画布同色"，要翻成对标那种结构得先有"卡片面"这个可命名的东西，否则只能去翻几百条 `--bg-primary`（其中大部分是画布不是卡片） |
| `--surface-subtle`（3% 局部着色） | **没做** | 我们已经有 `--surface-1` / `--surface-2` 两档局部浅面（**被引用 19 次**），再加一个同义名正是这份文档一直在批的"两套阶梯并存"。门禁 LIT-12 把这条取舍钉住：两者不许同时存在 |
| 「灰工作区 + 白卡」的**结构翻转** | **没做**（等用户点头） | 它会改主界面底色（内容区由白变浅灰），属于产品观感决策 |

**门槛是实测逼出来的**：LIT-12 一开始写"消费方 ≥3"，而"删掉一个消费方"的变异**不会红** ⇒ 改成 ≥4（当前实测 4 个）。

### 13.2 D8：身份色 —— 先盘消费方，再决定做几个

对标说身份色用于「头像 / 模式徽标 / 工具族标记」。我们的实际情况：

| 对象 | 现状 | 处置 |
| --- | --- | --- |
| 头像 | **不存在**（消息用气泡，没有 avatar 元素） | 不做（造了就是零消费方令牌） |
| 工具卡 | 用**状态**色（running/done/error = info/success/error） | 不做（那是状态不是身份） |
| 执行模式徽标 | `titlebar-action-btn execution-mode-toggle` 只有图标+文字，`.active`（新工作树）**没有任何视觉区分** | **做**：`--identity-mode-workspace`（别名、中性）/ `--identity-mode-worktree`（亮 #7c3aed、暗提亮），激活态叠 14% 同色浅底 |

判据：两档都有定义、都有消费方、**命名里不含状态词**（IDENTITY-1）；身份色压在内容面/悬停面/自己的 14% 浅底上都 ≥4.5:1（IDENTITY-2，11px 小徽标）。

### 13.3 剩下的

P2-3 **皮肤数据化**（hub / dream 的裸颜色字面量 → 令牌）是最后一项；P1-1 的**结构翻转**在等用户点头。


---

## 14. 第七轮（1.16.163）：P2-3 皮肤数据化 —— 规则体里的颜色字面量归零

### 14.1 迁移前后（同一套口径量出来的）

| | 规则体里的裸颜色 | 不同取值 | 处置 |
| --- | ---: | ---: | --- |
| `skin-hub.css` | **89** | 68 | 收进顶部调色板：新增 `--hub-cN` **63** 个、复用既有令牌 38 处 |
| `skin-dream.css` | **112** | 60 | 收进顶部调色板：新增 `--dream-cN` **81** 个 |
| 迁移后 | **0** | 0 | 门禁 **SKIN-1** 守住（注释里解释颜色不算、`var()` 兜底不算） |

棘轮随之收紧：`color` 族 **140 → 17**（剩的全在 codem-ui / 主样式表里）、`box-shadow` **29 → 8**。

### 14.2 **零视觉变化是机证的**（这一条比"我觉得没变"重要）

`css-integrity.test.ts` 的 **CSS-INTEGRITY-7** 会把 2733 个类的**生效取值**与入库快照逐条比对：
迁移后**不加 `--write` 直接通过**，`node tools/ui-audit/css-contract.mjs --check` 输出 **"✅ 无变化"**
⇒ 所有类的计算值逐位不变。这也顺带证明了"把字面量换成等值令牌"这条迁移是安全的。

### 14.3 如实记两个坑

1. **迁移脚本第一版会删光注释**：为了跳过"注释里的颜色"，我拿**去注释后的文本**做替换，写回去等于删掉全部注释
   ⇒ 改成「在原文上替换 + 先算注释区间、落在注释 / var() / 令牌块里的匹配一律跳过」。
2. **SKIN-1 报了 4 处假红**：算行首偏移时用"每行长度 + 1"累加，而文件是 **CRLF**（每行 2 个换行字符）
   ⇒ 130 行后偏移少了约 130 字符，**令牌块内的字面量被误判成规则体里的**。现在按 `\n` 的真实位置建偏移表。
   （本仓库混用行尾，这已经是第二次被它咬：上一次是变异脚本的判据匹配。）

### 14.4 这一项之后，O-30 的对标清单还剩什么

| 项 | 状态 |
| --- | --- |
| P0 四条 / P1-2 / P1-3 / P1-4 / P2-1 / P2-2 / P2-4 | **已落地**（各轮见 §7、§9–§13） |
| P2-3 皮肤数据化 | **本轮落地**（规则体字面量 0）—— 语义命名（`--hub-ink` 之类）与"皮肤 JSON/TS 对象 + 运行时注入"仍是可选的下一步 |
| P1-1 的**结构翻转**（灰工作区 + 白卡） | 接口已留好（`--surface-raised`），**在等用户看过再定** |
| D1 暗色主文字亮度 | 只记录不动手（用户说当前暗色好看） |
| D3 暗色阴影强度 | **已落地**（§10.3：浮层档 0.30/0.40 → 0.42/0.55） |
| D5 白字压紫底 3.99 | 按 AA-large 3 登记（要过 4.5 得改紫或改深色字，属产品决策） |


---

## 15. 第八轮（1.16.164）：把"产物口径"和"源码口径"对齐（SKIN-2）

### 15.1 P2-3 的判据在**产物**这一层没成立

P2-3 的判据写的是"hub/dream 迁移后，`skin-*.css` 里只剩令牌块（颜色字面量 0）"。
1.16.163 把**源码**做到了（SKIN-1 全绿），但装机版复核（CDP 读运行中的 CSSOM，再拉服务端那份 CSS 文本）
实测产物里 Dream 皮肤的规则体里仍有 **2 处**颜色字面量：

| 产物里的选择器 | 命中 | 源码写法 |
| --- | --- | --- |
| `[data-skin="dream"] .btn-send, .send-button` | `color:#fff!important` | `color: white !important` |
| `[data-skin="dream"] .inline-diff-btn.accept` | `color:#fff` | `color: white` |

原因很朴素：**压缩器（lightningcss）会把命名色改写成 hex**。SKIN-1 的口径是 `hex | rgb() | rgba()`
（与全项目"算写死值"的口径一致），命名色两种都不匹配。

> 这条值得单独记一笔：门禁"绿"只在**它量的那一层**成立。源码层的门禁管不到压缩器，
> 而用户手里跑的是压缩后的产物 —— 所以**产物这一层必须单独量一次**。

### 15.2 处置与口径

- 2 处改用同值令牌 `var(--dream-c7)`（`#ffffff`，逐通道相同 ⇒ 零视觉变化）。
- 新增门禁 **SKIN-2**：皮肤规则体里不许出现命名色（内置 CSS Color 4 的 148 个命名色全表）；
  豁免 `transparent` / `currentColor`（压缩器对它们逐字保留，产物里实测 `background:transparent` 原样在）。
- SKIN-1 与 SKIN-2 的"可扫描区间"（注释 / `var()` / 顶部令牌块）合并成**一个共用函数** ——
  两个门禁各写一份正则迟早会不一样，而"两套口径"是这个仓库反复踩的坑。

### 15.3 实测（两个口径都是 0）

| | 源码（门禁） | 产物（`dist/assets/main-Cucc8UK7.css`，696958 字符） |
| --- | ---: | ---: |
| 颜色字面量（hex/rgb/rgba） | hub 0 / dream 0 | hub 0 / dream 0 |
| 命名色 | hub 0 / dream 0 | hub 0 / dream 0 |
| 令牌 | `--hub-c*` 63 / `--dream-c*` 81 | `--hub-c*` 63 / `--dream-c*` 81 |

变异自证：`SKIN2-命名色 white` 红；样式门禁 23 条变异全部被抓 + 还原后逐字节回绿。

### 15.4 O-30 对标清单的剩余项（不变）

| 项 | 状态 |
| --- | --- |
| P0 四条 / P1-2 / P1-3 / P1-4 / P2-1 / P2-2 / P2-3 / P2-4 | **已落地**（§7–§15；P2-3 现在源码与产物两个口径都是 0） |
| P1-1 的**结构翻转**（灰工作区 + 白卡） | 接口已留好（`--surface-raised`），**在等用户看过再定** |
| D1 暗色主文字亮度 | 只记录不动手（用户说当前暗色好看） |
| D3 暗色阴影强度 | **已落地**（§10.3） |
| D5 白字压紫底 3.99 | 按 AA-large 3 登记（属产品决策） |


---

## 16. 第九轮（1.16.165）：高对比档补全 + 对标清单的**门禁/变异覆盖矩阵**

### 16.1 P2-1 此前只做了一半

`data-contrast="high"` 的写入方在 1.16.159 就接好了，但 CSS 侧 6 处规则**全是**"玻璃降级成实色"，
**没有任何令牌级覆盖块** —— 对标文档 P2-1 承诺的"文字更黑、边框更实、焦点环更粗"一件都没做。
当时唯一相关的 APPEARANCE-5 只断言 `[data-contrast="high"] .sidebar` **存在**，所以这种半成品全绿通过。

> 记一条方法论：**门禁的量程决定了它能看见什么。** "规则存在"与"规则有效"是两件事，
> 这一轮把断言从"存在"换成了"量出来的对比度必须更高"。

### 16.2 补法与实测

一套值同时管两档：文字三档是 `color-mix(in srgb, var(--text-base) N%, var(--text-ramp-paper))`，
混合两端是**墨**与**纸**（两档相反）⇒ 调大 N 在亮色档是"更黑"、在暗色档是"更亮"。

| 令牌 | 常态 | 高对比 | 亮色（对主内容面） | 暗色 |
| --- | --- | --- | --- | --- |
| `--text-secondary` | 75% / 82% | **墨 90%** | 7.37 → **12.30:1** | 8.93 → **10.55:1** |
| `--text-muted` | 65% / 67% | **墨 80%** | 5.28 → **8.75:1** | 6.25 → **8.53:1** |
| `--border-primary` | α9% / 14% | **墨 α26%** | 1.19 → **1.73:1** | 1.47 → **1.90:1** |
| `--focus-ring-width` | 2px | **3px** | — | — |
| `--focus-ring-color` | accent 75% | **var(--accent)** | — | — |

`--text-base` **不动**（D1 是用户明确说"当前暗色好看、别动"的那一项）。

### 16.3 测量能力：α 感知的对比度

"边框更实"必须量**半透明边框压在面上之后**的可见度。而项目原有的 `parseRgba` 只认逗号写法，
`rgb(31 31 30 / 9%)`（`--border-primary` 亮色档的真实写法）直接返回 `null` ——
**半透明边框的可见度此前从来没有被量过**。

给 `contrast-checker.ts` 新增（不动老函数，老口径被别的门禁钉着）：
`resolveRgba` / `compositeOver` / `contrastOfRgba` / `visibleContrastOver`，加门禁 **ALPHA-1…4**。
其中 ALPHA-1 用**规范参照值**：`color-mix(in srgb, #ff0000 50%, transparent)` ⇒ 红本身 + α0.5（压白底 `#ff8080`），
不是"暗一半的红"。这个坑在本仓库出现过三次，现在被钉死。

### 16.4 覆盖矩阵（每一项：门禁 → 变异自证）

| 对标项 | 落地版本 | 门禁 | 变异自证 |
| --- | --- | --- | --- |
| 玻璃材质（侧栏/浮层/系统材质） | 1.16.158 | LIGHT-UI-10 / NATIVE-1…3 | `mutate-glass-gates` **15** 条 |
| P1-1 表面角色 | 1.16.162 | LIT-12（别名 + ≥4 消费方 + 不与 `--surface-1` 并存） | `mutate-style-gates` M17/M18/M21 |
| P1-2 文字/品牌解耦 | 1.16.159/160 | LIT-10 / LIT-11 | M14 / M15 |
| P1-3 阴影阶梯统一（含 D4 品牌紫） | 1.16.157 | 阴影阶梯必须中性 + 语义阴影是阶梯的别名 | `mutate-shadow-gates` **S1–S3** |
| P1-4 状态色四角色 | 1.16.157 | LIT-8 / LIGHT-UI-12 / H5 | M6/M7/M11/M12/M13 |
| P2-1 密度 | 1.16.159 | APPEARANCE-4 | A3/A4/A5/A6 |
| P2-1 高对比 | **1.16.165** | **APPEARANCE-7** + ALPHA-1…4 | **A7–A11** |
| P2-2 / D8 身份色 | 1.16.162 | IDENTITY-1/2 | M19/M20 |
| P2-3 皮肤数据化 | 1.16.163/164 | SKIN-1 / SKIN-2 | SKIN1 / SKIN2 |
| P2-4 颜色用量审计 | 1.16.161 | CR-1…7 | `mutate-color-role-gates` **7** 条 |
| D3 暗色阴影强度 | 1.16.157 | DARK-UI-8 | **S4 / S5** |

合计变异自证 **62 条**（玻璃 15 / 样式 23 / 外观 12 / 颜色角色 7 / 阴影 5），全部"注入即红 + 还原回绿"。

**这一节在出包后又被复核了一遍**（本轮改过 `styles.css`，改了被测文件就得重证）：五套脚本在最终树上重跑，
玻璃/样式/外观/阴影四套仍全红 + 还原回绿；颜色角色那套里 **C7 未红** —— 查下来是**变异自己写错了**：
C7 删的是块内**最后一条**声明的分号，而 CSS 允许最后一条不带分号 ⇒ postcss 照样解析通过、门禁保持绿是对的
（用 postcss 实验确认：只有删**中间**声明的分号才报 `Missed semicolon`）。改成中间声明后 **红 ✓**。

教训值得单独记一句：**`CSS-INTEGRITY-9` 这道门禁此前从未被真正自证过** —— 变异一直是"绿"的，
因为它注入的压根不是缺陷。**"变异全红"这个结论必须建立在"变异真的注入了缺陷"之上，而后者也要能被证伪。**

### 16.5 不做的一项（如实标注）

**P1-1 的"结构翻转（灰工作区 + 白卡）"不做。** 它是本清单里唯一一个我自己加的加分项，理由是**实测方向相反**：
§3.1b 的像素统计是"灰面占屏比：我们 **32.8%** / 参考实现 **5.5%**" —— 对方几乎整屏浅色，
把工作区整片改灰会让我们**更灰**，与 P1-1"次级容器提亮、灰块占比下降"的判据相反。
P1-1 按清单原文收口（提亮受 LIGHT-UI-1 约束、角色由 `--surface-raised` + LIT-12 收口）。

至此 O-30 的对标清单**全部落地或明确标注不做**；剩余未关闭项是别的问题域（O-1 渲染进程崩溃根因、O-29 重载重复落库）。
