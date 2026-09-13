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
| `--fs-2xs` | 11px | 密集元信息：时间戳、路径、状态行、侧栏副标题 |
| `--fs-xs` | 10px | 徽标、辅助说明、上标 |
| `--fs-sm` | 12px | 次要文本、按钮、表格、列表副标题 |
| `--fs-base` | 13px | **正文基准**（桌面应用主密度） |
| `--fs-md` | 14px | 主要文本、列表项标题、输入框、消息正文 |
| `--fs-lg` | 16px | 区块标题、面板标题 |
| `--fs-xl` | 18px | 页面标题、弹窗标题 |
| `--fs-2xl` | 20px | 大标题 |
| `--fs-3xl` | 24px | Hero 标题 |
| `--fs-display` | 28px | 演示模式 / 空态大标题 |
| `--fs-hero` | 32px | 引导页 / 全屏演示主标题 |
| `--icon-3xl` | 48px | 空态/欢迎页的大号字形（`font-size` 也用它） |

**禁止**在 `style` 或 CSS 里写数字字号（含 `32px`）。frakio-work 的密度事实：12px(291 次)、
11px(211)、10px(175)、13px(170) 是主力，最大 UI 文本也只有 24px —— **层级靠字重与颜色，不靠字号**。

两条补充规则（第 12 波落地时确定）：

1. **11px 保留为独立档**（`--fs-2xs`）：项目里 11px 是使用第二多的小字号（styles.css 里 121 处，
   与参考实现的 211 次同源）。补成令牌而不是并进 10/12，是为了保住既有排版密度；关键是这些文字
   此前写死 px、**不吃字号滑杆**，令牌化后才会跟着 `--ui-font-scale` 走。
2. **相对单位 `em`/`%` 允许保留**：内容排版里的相对层级（markdown 的 `h1>h2>正文`、行内代码
   比正文小一档）本来就该跟随父级，父级是令牌，缩放链没有断 —— 审计只拦绝对单位 `px`/`rem`/`pt`。

### 2.1b 字重（`--weight-*`，第 33 波新增）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--weight-regular` | 400 | 正文、**数值与表格单元格**（值不该和标题一样粗） |
| `--weight-medium` | 500 | 次级标签、meta、列表项副标题 |
| `--weight-semibold` | 560 | 列表项名、chip 值、卡片名、**选中态** |
| `--weight-bold` | 620 | 区块标题、面板标题 |
| `--weight-heavy` | 700 | 只留极少数强调（徽标、Hero） |

**诊断事实（第 33 波，§2.8）**：整改前 `font-weight: 600` 用了 **235 次** —— "哪里都半粗"等于没有层次；
参考实现用 650/720/620/560 这种**细档**建层次、400 只出现 11 次。补出细档令牌后，规则是
**三档收口**：标题 620、列表项 560、正文/值 400–500，扫视时先看到标题、再看到项、最后才是数据。
> **第 35 波更正**：此前这里写着"我们是静态字重、细档会被浏览器就近取整"—— **这是错的**。
> `public/fonts/AlimamaFangYuanTiVF-Thin.ttf` 经 `fvar` 表核验是**真可变字体**：
> 轴 `wght` 200–700 + `BEVL` 1–100，18 个具名实例。所以 560/620 是真实字重。
> 同时把 `@font-face` 的 `font-weight` 声明从 `100 900` 收窄成真实的 `200 700` ——
> 声明超出轴范围会让浏览器在 700 以上**合成伪粗体**（中文界面会糊），收窄即禁止合成。

### 2.1c 字体栈（第 35 波收敛）

| 令牌 | 用途 |
| --- | --- |
| `--font-ui` | UI 正文/控件：`'AlimamaFangYuanTi'`（可变字体）+ 系统 UI 栈兜底 |
| `--font-mono` | 代码/路径/ID：`'SF Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace` |
| `--font-display` | 展示档（标题/引导页），当前与 `--font-ui` 同源，留给将来换标题字体 |
| `--font-family` | **兼容别名** = `var(--font-ui)`，只为历史代码与插件保留 |

**实测起点**：全项目 **31 种**不同的 `font-family` 取值、**192 处**声明 —— 其中**等宽栈就有 14 种写法**
（`"SF Mono", "Fira Code", monospace`×15、`'SF Mono', Consolas, monospace`×9、
`'SF Mono', Consolas, 'Liberation Mono', monospace`…），同一段代码在不同组件里可能落到不同字体上；
参考实现只有 15 处声明，全部走令牌栈。第 35 波把 **50 处等宽栈 + 6 处 UI 栈**收回令牌，
不同取值降到 **7 种**（其余是 `inherit`、PPT 生成内容、HTML 预览内容与插件兜底）。
硬规则 `font-stack-raw` 锁住；插件 CSS 用 `var(--font-mono, ui-monospace, monospace)` 带兜底写法（插件须能独立渲染）。

### 2.2 圆角（`--radius-*`）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--radius-xs` | 4px | 细条、滚动条滑块、极密集的内联小块 |
| `--radius-sm` | 6px | 小控件、标签、密集行（第 33 波由 4px 软化上来） |
| `--radius` | 8px | 按钮、输入框、图标按钮（**主力**，与参考实现同值） |
| `--radius-md` | 10px | 卡片、浮层、下拉菜单 |
| `--radius-lg` | 14px | 弹窗、抽屉、大卡片 |
| `--radius-xl` | 20px | 全屏面板、大卡片、引导页插图（第 34 波新增） |
| `--radius-full` | 9999px | 胶囊、开关、头像 —— **标签/徽标/计数一律走这档**（第 33 波起） |

**禁止** 3px / 5px / 7px / 9px 这类离格值（审计硬规则 `radius-offscale`）；
**也禁止在刻度上却写死的字面量**（硬规则 `radius-raw`，第 34 波起）—— 允许 `0`、`2px`（细条端头）、
`50%`（圆形）、`inherit`。第 34 波把 381 处 CSS + 208 处 TSX 字面量收回令牌，同时修掉了
**倒置的阶梯**：此前 `--radius-xs` 是 8px、比 `--radius-sm` 的 4px 还大，命名与实际大小相反。
参考实现的圆角分布是「8px 主力 ×172 + 999 胶囊 ×96 + 6px ×73」——**短文本小块用胶囊**是它看起来
"像产品"的细节之一（方角小块更像数据表）。

### 2.3 颜色（语义令牌，禁止硬编码）

- 文本：`--text-primary` / `--text-secondary` / `--text-muted` / `--text-on-accent`
- 面：`--bg-primary`（页面/卡片底）、`--bg-secondary`、`--bg-tertiary`、`--bg-hover`
- 线：`--border-primary`（10% alpha）、`--border-secondary`（6%）
- 强调/状态：`--accent` / `--accent-hover` / `--accent-muted`、`--success` / `--warning` / `--error` / `--info`
- **分类色板**：`--chart-cat-1..6` —— 只用于「类别」着色（知识图谱的实体类型、图表的多序列），
  **不是状态色**。单列一套的理由：语义色只有 5 个，且浅色主题里 `--info` 与 `--accent` 同值，
  类别一多就会撞色；它同时是唯一允许出现在内联样式里的「成组色值」（配合 `currentColor` 派生淡底淡边）。
- 浮层：`--overlay-backdrop`（0.5）、`--overlay-backdrop-strong`（0.72）、`--dropdown-bg`、`--tooltip-*`
- 阴影：`--shadow-sm/md/lg/popover`；字体/动效：`--duration-*`、`--ease-*`、`--transition-*`

frakio-work 的两条关键惯例（我们同步遵守）：

1. **状态色不做实心填充**：一律「文字色 + 8–10% 同色底 + 18–22% 同色边」
   （用 `color-mix(in srgb, var(--error) 10%, transparent)` 表达）。
   第 34 波实测这条**此前只做到一半**：47 处状态小块里只有 26 处真的带淡底，
   `running` / `done` / `exit 1` / `已安装` 这些只是"一行有颜色的字"，在深色主题里读不出"这是个状态"。
   已补统一形状（`.tool-card-status` / `.agent-detail-status` / `.mcp-catalog-installed-badge`）：
   淡底与淡边都用 **`currentColor` 派生**，于是各状态修饰类只需要给 `color` 一个值，
   不需要为每个状态再抄一遍 `color-mix` —— 这是"加状态色不用加代码"的关键。
2. **浮层优先用「环」而不是边框**：`box-shadow: 0 0 0 1px var(--border-primary), <投影>`。

**默认档位与两档对称（第 36 波）**

| 项 | 值 |
| --- | --- |
| 默认档位 | **浅色暖中性**（`DEFAULT_THEME = 'light'`，唯一真相源在 `src/core/theme/theme-default.ts`） |
| CSS 契约 | `:root, [data-theme="light"]` = 浅色；`[data-theme="dark"]` = 显式覆盖 |
| 首屏不闪 | 换档时往 localStorage 写镜像（`codem-theme-cache`），`index.html` 的内联脚本在首屏渲染前读它并设 `data-theme`；SQLite 的 `codem-theme` 仍是真相源，镜像只是"首屏预测" |
| 浅色色板 | 暖中性：画布 `#fcfcfb`、卡片 `#f5f5f3`、内嵌 `#ededea`、悬停 `#e3e3df`；文字 `#1f1f1e` / `#5d5c58` / `#8a8880`；线一律"文字色 + alpha"（12% / 7%） |
| 深色色板 | 保持中性偏冷（大面积暖灰在深色下会显脏） |

改成浅色默认的两个理由：① 此前 `:root` 是暗色，而 `index.html` 里没有 `data-theme`，
浏览器先按 `:root` 渲染一帧再等 JS 切换 —— 浅色用户每次启动都闪一下黑；
② 参考实现就是"浅色暖中性"的第一印象，冷蓝灰（GitHub 那套）会显得"工程感"。
**刻意不随主题走的令牌**（终端面板、窗口控件红黄绿、皮肤色卡、外来内容面、搜索高亮、纯黑底）
现在在浅色块里也写明并注明理由，避免读者以为"漏了"。

### 2.4 间距与尺寸

- 间距走 **2px 网格**（1px 仅用于细线）；常用 4/6/8/10/12/14/16/20/24。
- **控件高度走尺度令牌**：`--control-xs` **26** / `--control-dense` **30** / `--control-md` **34** /
  `--control-std` **38** / `--control-form` **44**（第 33 波整体上抬 2–4px，对齐参考实现"以 34 为主"）。
  密集工具条用 30、图标按钮 34、表单控件 38、大表单 44。
  此前控件高度全靠 padding + 字号"推"（28.4 / 34.8 / 26 …），同一行里能差 1–6px —— 这是"行不齐"的根因。
- **第 28 波起：CSS 间距属性一律用 `--space-*`**（`--space-1..15`：2/4/6/8/10/12/14/16/20/24/28/32/40/48/64），
  实测 2906 处数值间距里 2414 处做了令牌化或 2px 网格归并（3→4、5→6、7→8、13→14、18→20、22→24、36→40），
  只剩 1px/0.5px 细线、负值（光学微调）与 `%`/`calc()`/`var()` 动态值保留字面量。
  门禁新增 `spacing-raw`（error）。
- 尺寸（`width` / `height` / `top` 这类几何）**不**用间距令牌 —— 它们是布局坐标，不是节奏。
- 控件高度：密集 30px、标准 34px、表单 38–44px；图标按钮 30–38px（见上面的 `--control-*` 令牌）。
- 图标与文字：**14px 图标 ↔ 13px 标签**，`gap: 8px`；描边统一 **1.75**（小徽标 2、大空态图标 1.5）。
- 对齐原语（第 32 波起）：设置/表单行用 **grid 两列模板**（标签列 `minmax(88px, max-content)` + 内容列
  `minmax(0, 1fr)`），而不是 flex + margin —— 参考实现用了 574 处 grid，标签因此对齐成一条竖线。
  **第 37 波把这件事推到了"重复行"层**：225 处「重复行」成对替换（`display: flex` → `display: grid`
  + 一行 `grid-template-columns`），列模板按子元素数确定：

  | 形态 | 模板 | 说明 |
  | --- | --- | --- |
  | 2 列（图标 + 文本） | `max-content minmax(0, 1fr)` | 图标只吃自身宽度 → **跨行对齐成竖线** |
  | 3 列（图标 + 文本 + 尾部值） | `max-content minmax(0, 1fr) max-content` | 尾部数值贴右且不被压缩 |
  | 4 列 | `max-content minmax(0, 1fr) max-content max-content` | 尾部操作簇逐个成列 |
  | 动作簇 / 工具条（本身要右对齐或等宽） | `repeat(N, max-content)` | 保持整簇宽度不变；配 `justify-content: flex-end` 仍然生效 |

  为什么必须**成对**替换：`display: flex` 单独换成 `display: grid` 会让所有子元素落到单列里（纵向堆叠），
  布局直接崩 —— 这是这一层唯一不可省的约束。**不动的**：`flex-direction: column` 的纵向堆叠（315 处，
  没有列可对齐）、`flex-wrap` 换行行（75 处，要换列模板才行）、以及"行但无 gap"的 243 处（换成 grid
  间距仍是 0，没有对齐收益，且顺手补 `gap` 会叠成双倍间距）。
- 图标尺寸**只用 `.icon-*` 一档 8 级**（`--icon-2xs` 10 / `--icon-xs` 12 / `--icon-sm` 14 /
  `--icon-md` 16 / `--icon-lg` 20 / `--icon-xl` 24 / `--icon-2xl` 32 / `--icon-3xl` 48），
  装饰性图标加 `.icon-dim`。**TSX 里的 `size={n}` 也必须落在这八级上**（硬规则 `icon-size-offscale`，第 34 波起）——
  此前散着 13/15/18/11/9/8/26/28 共 149 处，同一行 13px 与 14px 图标并排就是"节奏被打散"的来源；
  对应关系：13/15→14、11→12、17/18→16、19/21→20、22/25/26→24、28→32、8/9→10。
  **禁止**写 `w-3 h-3` / `animate-spin` / `opacity-40` 这类
  Tailwind 风格类名 —— 本项目是纯 CSS，没有 Tailwind，写了也等于没样式。
- 内容宽度：工作区 1180px、表单/设置 880px；页面 gutter `clamp(24px, 3.2vw, 48px)`。
- 区块标题上间距 26px、下 10px；页面头行 `margin-bottom: 20px`。

### 2.5 动效与交互

- 时长 120ms（浮层入场）/ 140ms（颜色）/ 160ms（默认）/ 200ms（抽屉）；曲线 `--ease-out`（本项目 `cubic-bezier(.23,1,.32,1)`，与 frakio 的 `(.2,.8,.2,1)` 同族）。
- 位移极小：≤2px 位移 + ≤2% 缩放；**hover 只换底色**（`--bg-hover`），不做位移/边框互换。
- `:focus-visible` 必须有可见焦点环；弹窗必须支持 Esc 关闭 + 点击遮罩关闭（统一走 `modal-overlay`）。
- 尊重 `prefers-reduced-motion`。

### 2.6 层级（z-index 梯子，第 27 波统一）

浮层的层叠顺序是**全局耦合**的：任何一处随手写个 `9999` 都可能盖住别人的浮层，
而单看那一行完全看不出问题。实测（第 27 波）205 处写死 z-index 散在 40 多个文件里，
同一个"模态层"有两套互相矛盾的值（`.modal-overlay`=200 与 `--z-modal`=1300）。

现在只有一条链，**全局层级（>= 100）一律用令牌**：

| 令牌 | 值 | 谁用 |
| --- | --- | --- |
| `--z-chrome` | 100 | 页面级 chrome：侧栏、随页面走的内联下拉 |
| `--z-floating` | 900 | 浮动面板/工具条：滚动条标记、内联 diff、侧会话面板 |
| `--z-dropdown` | 1000 | 下拉菜单 |
| `--z-tooltip` | 1100 | 工具提示 |
| `--z-popover` | 1200 | popover（选区工具条等） |
| `--z-modal` | 1300 | 模态遮罩 + 面板（`.modal-overlay`/`.settings-overlay` 归位到此） |
| `--z-modal-stacked` | 2000 | 模态之上的模态 / 工作台内部浮层（级联确认、笔记本弹窗、PPT 全屏编辑） |
| `--z-present` | 3000 | 演示模式舞台 |
| `--z-present-ui` | 3001 | 演示模式的导航/备注（要压在舞台之上） |
| `--z-context-menu` | 9000 | portal 右键菜单的点击盾 |
| `--z-context-menu-top` | 9999 | 右键菜单本体 |
| `--z-top` | 10000 | 窗口级整屏浮层（宠物市场、PPT Studio 这类"盖住一切"的工作台） |
| `--z-toast` | 20000 | 提示条 —— **比所有交互浮层都高**（原来 1400，盖不住 9999 的 portal 菜单，提示会被吃掉） |
| `--z-max` | 2147483647 | 必须永远最上（拖拽预览等） |

**组件内部的局部层叠（0/1/2/10 这类 < 100）仍写普通数字**：幻灯片元素层序、棋盘格子、
图标叠层这些都是"局部坐标"，全局化反而更难读。审计规则 `zindex-raw` 就是按这条线切的。

### 2.7 交互状态与细节（第 29–31 波，对照参考实现逐项补齐）

**参考实现的本地副本**：`C:\talkandstory\talkandstory\_research\frakio-work`（v1.3.0，含 `.git`）。
对照方式固定为**同一套度量脚本双向跑**：`node .preview-shot/compare-refs.mjs <我们的 src> <对方的 apps/web/src>`
—— 不靠印象，每次改完都能量出位移。第 29–31 波实测：

| 指标 | 改前 | 改后 | 参考 |
| --- | --- | --- | --- |
| `:focus-visible` | 19 | **531** | 63 |
| `:is()/:where()` | 3 | **511** | 233 |
| transition 用字面量时长 | 194 | **8** | 58 |
| `transition: all` | 49 | **1** | 0 |
| `dvh` / `overscroll-behavior` / `color-scheme` / `::selection` | 0 | 8 / 1 / 2 / 4 | 22 / 5 / 4 / 0 |
| 分层阴影令牌 / 动效令牌 | 6 / 17 | **9 / 19** | 2 / 0 |

从参考实现学到并已落地的四条**具体**做法：

1. **一条规则服务三种状态**：`.x:is(:hover, :focus-visible, [aria-expanded='true'])`。
   鼠标、键盘、展开态共用一份样式，键盘焦点覆盖"顺手就有了"（我们 508 处 `:hover` 一次提升完，
   特异度与 `:hover` 相同，层叠不变）。
2. **控件写死高度**：它所有控件都是 34/36/38/40px；我们此前全靠 padding 撑，同行控件差 1–6px。
   现在有 `--control-xs/dense/md/std/form`（24/28/32/36/40）并落到 13 个共享控件类上。
3. **分层阴影**：大范围低透明度 + 近距轻投影两层（`--shadow-raise-1/2/3`），比单层投影"有厚度"。
4. **原生控件跟随主题**：`color-scheme` / `accent-color` / `::placeholder` / `::selection` /
   细档滚动条（含 hover 加深）—— 这些不做，暗色主题里总有一块"亮着的角"。

**我们反而更强、别倒退**：字号/圆角/间距/层级/动效**全部令牌化**（参考实现这几类 0 令牌、全字面量），
`tabular-nums` 58 vs 8、`color-mix()` 362 vs 108、`::selection`、`contain`。

**还没追平、按性价比排队**（都是结构性的，不是"改几个值"）：
`:is()` 已追平，但 **grid 布局 49 vs 583**（参考实现用 grid 做对齐原语，我们仍以 flex 为主）、
`:has()` 1 vs 41（父级状态选择器，可用于外壳/主题变体）、`aria/[data-state]` 15 vs 34（状态驱动样式）、
`prefers-reduced-motion` 7 vs 27（逐组件减动效）。`rgb(x x x / a)` 的 762 处我们**刻意不追** ——
`color-mix()` 是本项目的 alpha 表达法，两种写法等价，混用只会更乱。

### 2.8 为什么"像产品"而不是"像项目"（第 33 波诊断，带数据）

用户反馈"感觉精细化比不上参考实现"。用 `.preview-shot/product-feel.mjs` 把决定观感的底层量了一遍
（两边同指标，参考实现 = `frakio-work` v1.3.0 本地副本）：

| 维度 | 我们（诊断时） | 参考 | 处理 |
| --- | --- | --- | --- |
| **字重档位** | 600×235、500×104、**400 只有 9** | 650×68、700×30、**720/620/560** 细档、400×11 | **最大差异**：他们用细档字重建层次（可变字体的 560/620/650/720），我们"哪里都半粗"→ 没有层次感。已补 `--weight-*` 细档令牌，并把 34 处 meta/值类 600 降到 500 |
| **控件高度** | 24/28 为主 | **34 为主**（43 处） | 我们控件偏紧。已整体上抬 2–4px → 26/30/34/38/44 |
| **圆角** | 4×125、6×115（小、硬） | **8×173 + 999 胶囊×96** | 他们更圆、胶囊用得多。已把 `--radius-sm` 4→6、`--radius-xs` 6→8，标签/徽标类统一走胶囊 |
| **图标描边** | 0.6/1/1.2/1.5/2/2.5 混用 | 统一 ~2，尺寸以 15px 为主 | 细线在 12–14px 上"发虚"。已统一 `stroke-width: 1.75`（小徽标 2、大空态图标 1.5） |
| **窗口外壳** | `titlebar` 37 处，无应用菜单 | **`mac-window` 34 + `workbench-window` 7 + `topbar` 22 + `app-menu` 16** | 他们有 mac 风格外壳（50px 工具条 + 专门拖拽区 + 独立动作栏 + 带遮罩渐隐的标签条）与一套应用菜单。**第 41 波补齐**：外壳高度令牌 44px、标签条两端渐隐、应用菜单栏（文件/视图/帮助） |
| 平均明度 | 0.50（暗冷，默认深色） | 0.60（亮暖，默认浅色） | 他们以浅色暖灰为默认。**第 36 波已改为浅色暖中性**（画布 `#fcfcfb`） |

**结论**：观感差距主要来自 ① 字重层次 ② 控件尺度 ③ 圆角与胶囊 ④ 图标描边一致性
⑤ 窗口外壳 ⑥ 默认主题明度 —— **都不是"令牌化"能自动解决的**，而是每个部件的光学调校 + 品牌选择。
令牌化的价值在于让这些调校能一次改全局（`--control-*` / `--radius-*` / `--weight-*` / `--chrome-height` 一改全动），
但"调到多少"始终是设计判断。六项现已全部落地（第 33–41 波）。

## 3. 组件语言（统一外壳）
**外壳类清单（浮层只允许这四种，审计规则 `modal-shell-bespoke` 认的就是它们）**：

| 外壳 | 用途 | 做法 |
| --- | --- | --- |
| `modal-overlay` + `modal-panel` | 弹窗 / 对话框 | 遮罩负责定位与背景（`--overlay-backdrop` 家族），面板负责「面」：`--bg-secondary` + `--border-primary` + `--radius-lg` + `--shadow-popover`；内边距交给各自内容区（这类对话框都有通栏头栏/底栏） |
| `floating-overlay-panel` | 聊天区浮动侧面板 | 位置与尺寸仍由调用处的内联样式决定（`--chat-body-top/bottom`），外壳只统一底/边 |
| `popover-shell` + `popover-shield` | 菜单 / 下拉 / 右键菜单 | 外壳统一 `--dropdown-bg` + 环状边（`0 0 0 1px`）+ `--shadow-popover` + 120ms 入场；`popover-shield` 是那层吃掉外部点击的透明盾 |
| `drawer-*` | 抽屉 | 圆角 `--radius-lg`，入场 200ms |

| 组件 | 统一做法 |
| --- | --- |
| 弹窗 / 对话框 | 见上表；标题 `--fs-xl`，正文 `--fs-base`，内边距 20–22px |
| 卡片 | 圆角 `--radius-md`，底 `--bg-secondary`，边 `--border-primary`，hover 只换边色 |
| 按钮 | 主按钮 `--accent` 底 + `--text-on-accent` 字；次按钮透明底 + `--border-primary` 边；禁用 `opacity: .58` + `cursor: not-allowed` |
| 输入 / 下拉 | 高 32–36px，圆角 `--radius`，底 `--input-bg`，边 `--border-primary`，聚焦换 `--accent` 边 |
| 徽标 / 胶囊 | 圆角 `--radius-full`，`--fs-xs`，语义色按 §2.3 的「文字+淡底+淡边」 |
| 图标 | 只用 `.icon-2xs … .icon-3xl` 一档 8 级（§2.4），装饰性加 `.icon-dim`；旋转用 `.spin` |
| 空态 | 居中、`--fs-base`、`--text-muted`，配 1px 虚线或 `0 0 0 1px` 环，最小高度 130px |
| 列表行 | 32–36px 行高，hover `--bg-hover`，分隔线 `--border-secondary` 且不顶到边 |

**共享具名类（闭集，第 14 波起）**——各面板里反复内联的形态收口到这里，**新增必须写进本表**：

| 类名 | 用途 |
| --- | --- |
| `.mono` | 等宽文本（ID / 路径 / 时间戳） |
| `.icon-inline` / `.icon-inline-gap` | 行内图标与文字同基线（带/不带 4px 右间距） |
| `.hint-sm` | 次要说明文字（`--fs-sm` + `--text-muted`） |
| `.panel-section-title` | 面板内小节标题（`--fs-sm` + 600 + `--text-secondary`） |
| `.panel-empty` | 面板内空态块（虚边 + `--bg-tertiary` + 居中） |
| `.panel-btn` / `--danger` / `--sm` | 面板内次级按钮；危险态换 `--error` 边与字；`--sm` 用于浮层里的迷你按钮 |
| `.stat-cards` / `.stat-card` / `.stat-card-value` / `.stat-card-label` | 统计卡片行与卡片 |
| `.tc-tab` | 任务管理面板的内容区（`padding` 与页面 gutter 一致） |
| `.app-menubar` / `.app-menu-trigger` / `.app-menu-surface` / `.app-menu-item` / `.app-menu-shortcut` / `.app-menu-separator` | 应用级菜单栏（第 41 波）。触发器展开态由 `[aria-expanded="true"]` 驱动；菜单面板复用 `--dropdown-bg` / `--radius-md` / `--shadow-raise-3` / `--z-dropdown`；菜单项 30px 高 + 快捷键右对齐等宽提示 |
| `.tc-empty` | 面板内空态文案 |
| `.tc-label` / `.tc-field` / `.tc-field--area` | 面板内表单的标签与输入框（含下拉/多行） |
| `.tc-field-row` / `.tc-editor` / `.tc-editor-title` / `.tc-editor-actions` | 面板内联编辑器的行、外壳、标题、按钮行 |
| `.tc-btn` / `--primary` / `--lg` / `--sm` / `--resume` / `--stop` | 任务管理面板的按钮族（含"开始/暂停"这类语义修饰） |

> 这一层刻意**保持极小**：它只收口"到处重复写了 5 遍以上、且与业务无关"的形态。
> 组件自己的结构（`.recovery-item-*` 之类）仍留在组件命名空间里；
> 任务管理面板另有一层 `tc-*`（上表末三行），放在 `src/styles/task-center.css`。

## 4. 审计门禁（可重复运行）

```bash
node tools/ui-audit/scan-ui.mjs              # 汇总：每规则计数 + 问题最多的文件
node tools/ui-audit/scan-ui.mjs --verbose    # 附示例
node tools/ui-audit/scan-ui.mjs --census     # 字面量分布（决定下一波映射表）
node tools/ui-audit/scan-ui.mjs --inline-counts --top=30   # 每文件内联样式属性数（收口进度/排队）
node tools/ui-audit/scan-ui.mjs --dense-threshold=60       # 用更严的阈值看「已经很密」的文件
node tools/ui-audit/scan-ui.mjs --rule=color-hardcoded-tsx
node tools/ui-audit/codemod-tokens.mjs [--write]      # 令牌化改写（默认只预览）
node tools/ui-audit/codemod-icon-scale.mjs [--write]  # 图标工具类 → .icon-* 刻度（默认只预览）
```

规则分层：

| 规则 | 级别 | 含义 |
| --- | --- | --- |
| `fs-hardcoded` | error | 字号硬编码（tsx 内联样式 **与 CSS** 双侧都查；只拦绝对单位 `px`/`rem`/`pt`，见 §2.1 第 2 条） |
| `color-hardcoded-tsx` / `-css` | error | 硬编码颜色（应为语义令牌）；TSX 侧按**字面量位置**逐个判定，复合值里的 hex（`border: "1px solid #ef444455"`）同样计入 |
| `radius-offscale` | error | 圆角离格 |
| `modal-shell-bespoke` | error | 自建浮层外壳，未用统一 `modal-overlay` |
| `spacing-offgrid` | warn | 间距不在 2px 网格 |
| `inline-style-dense` | warn | 单文件内联样式过密（只数**样式对象内部**的属性；第 14 波修正前会把普通 TS 对象字面量也数进去） |
| `legacy-popup-shell` | warn | 历史遗留的自建浮层类名（`popup-*`/`overlay-*`/`modal-box-*`/`dialog-box-*`/`sheet-*`） |
| `css-class-undefined` | warn | **tsx 里用了但没有任何 CSS 定义的类名**（等于没样式；已排除运行时状态类与第三方库类名；模板字面量里的静态类名同样计入）。**第 26 波起不再豁免「同行有内联样式」的元素** —— 那条豁免让一整批"类名没定义、外观全靠内联撑着"的空壳长期不可见 |
| `css-var-undefined` | error | **`var(--x)` 引用了全项目从未定义的令牌**（第 26 波新增）。无兜底时整条声明失效（`font-family: var(--font-mono)` 让等宽字体从未生效、`border: 1px solid var(--border)` 让边框整条消失），有兜底时则永远吃写死的深色、不跟随主题/皮肤 |
| `color-hardcoded-ts` | error | **`style={{}}` 之外的 TS 里写死颜色**（第 26 波新增）：状态色表（`{ failed: "#ef4444" }`）、主题常量、`el.style.background = "#..."`。此前只有内联样式对象区间内的色值被检查 |
| `svg-attr-var` | error | **把 `var()` 写在原生 SVG 表现属性里**（第 26 波新增）：`stroke="var(--accent)"` 这类属性**不吃** CSS 变量，浏览器判非法后整条属性失效（stroke 默认 `none` → 图形不画）。颜色要走 CSS 类 |
| `zindex-raw` | error | **全局层级的 z-index 写了裸数字**（第 27 波新增）：`>= 100` 一律用 `--z-*` 令牌（§2.6 的层级梯子）；`< 100` 视为组件内部的局部层叠（幻灯片元素、棋盘格子、图标叠层），允许裸数字。TSX 只在 `style={{}}` 区间内判定 —— `createTextElement({ zIndex: 100 })` 是**数据字段**不是 CSS |
| `css-class-duplicate` | error | **同一个类在顶层被定义多次且属性取值冲突**（第 27 波新增）：同特异度时后者静默覆盖前者，于是"改了没生效 / 某处样式和设计不符"极难排查。只认纯顶层选择器 —— 伪类、后代选择器、`[data-skin]` / `[data-theme]` 这些**有意的分层覆盖**不算 |
| `spacing-raw` | error | **CSS 间距属性写了裸数字**（第 28 波新增）：间距属性（padding/margin/gap 及各向 longhand）必须用 `var(--space-*)`。例外：`0`/`auto`、`1px`/`0.5px` 细线、负值（光学微调）、`%`/`calc()`/`clamp()`/`var()` 动态值 |
| `radius-raw` | error | **圆角写了裸长度**（第 34 波新增）：**在刻度上**的字面量也要拦 —— 它们能通过 `radius-offscale`，却让「改一个令牌、全局圆角一起动」失效（当时 styles.css 里躺着 `4px`×124 / `6px`×113 / `8px`×76，TSX 内联样式里另有 208 处）。例外：`0`、`2px`（细条端头）、`50%`（圆形）、`inherit`、`var()`/`calc()`。插件 CSS 用 `var(--radius-md, 10px)` 这种**带兜底**写法不触发（插件必须能脱离宿主独立渲染） |
| `icon-size-offscale` | error | **图标尺寸不在 `--icon-*` 八级刻度上**（第 34 波新增）：刻度为 10/12/14/16/20/24/32/48。实测曾散着 `13`×46、`18`×45、`11`×26、`15`×23、`9`/`8`/`26`/`28` 共 149 处，同一行 13px 与 14px 图标并排会把视觉节奏打散。`size` 不是图标刻度的组件（画布、图表、头像、抽屉宽度）在规则里显式排除 |
| `font-stack-raw` | error | **CSS 里写死了字体栈**（第 35 波新增）：必须走 `var(--font-ui)` / `var(--font-mono)` / `var(--font-display)`。例外：`inherit`（继承父级是刻意的）、`var(--font-*, 兜底)`（插件须能独立渲染）、`@font-face` 里的字体**名字**声明。起点是 31 种取值 / 192 处声明 |
| `focus-outline-none` | error | **焦点规则里 `outline: none` 却没有替代环**（第 39 波新增）：焦点样式是唯一"失效了也没人发现"的东西 —— 鼠标用户完全不受影响，只有键盘/读屏用户感觉得到。例外：`:not(:focus-visible)`（刻意的鼠标抑制）、规则体内自带 `box-shadow` 环（"改用内嵌环"） |
| `inline-outline-none` | error | **TSX 内联 `outline: 'none'`**（第 39 波新增）：内联优先级高于所有非 `!important` 规则，**一处内联就能吃掉全局焦点环**（实测 14 处，含幻灯片画布的 `div[tabindex=0]`）。想抑制鼠标焦点请用 CSS 的 `:not(:focus-visible)` |
| `motion-uncovered` | error | **循环动画没有在 `prefers-reduced-motion` 下显式关停**（第 40 波新增）：全局兜底只把动画"加速到 0.01ms"，对 `infinite` 循环**没有意义**（它仍会跳到最后一个关键帧）。判定方式是跨文件比对：把每条 `animation: … infinite` 的选择器与全项目所有关停块里 `animation: none` 的选择器比成类名集合，前者必须被某个后者覆盖（`.lo-sprite[data-fallback]` 覆盖 `.lo-sprite[data-fallback="walk"]`） |
| `css-class-cross-file` | error | **同一个类在两个基础样式表里定义了不同取值**（第 51 波新增）：`css-class-duplicate` 只在**单个文件内**比对，于是"同一个类在 `styles.css` 与 `codem-ui.css` 里各写一遍、后加载者静默覆盖前者"这类问题一直看不见 —— 第 51 波用户反馈的右侧边栏滚动条正是它：`.right-sidebar-tabs` 在 `styles.css` 是 `overflow-x: auto`（横向滚动），在 `codem-ui.css` 又写了 `flex-wrap: wrap`（折行），`codem-ui.css` 后加载 → **两个属性同时生效**（既折行又有滚动条）。判定只在"基础样式表"之间比对（`skin-*.css` 是有意的分层覆盖，排除），并要求同类在同一属性上取值不同才报。第 51 波从 29 处收敛到 **0**。 |
| `encoding-replacement-char` | error | **源码里出现 U+FFFD 替换字符**（第 52 波新增）：修 CSS 结构残骸时发现 3 个样式表共 **87 处** U+FFFD（`styles.css` 17 / `skin-hub.css` 32 / `skin-dream.css` 38），成因是过去某次「用字符串改写文件」把 UTF-8 多字节汉字截断（2 字节 → U+FFFD、1 字节 → `?`，所以现场常是 `�?`）。它们全部落在注释里，于是**页面照常渲染、`tsc`/单测/其他 23 条规则全都看不见**。这类损坏**不可逆**（原始字节已丢），修复只能回到 git 历史里每个文件的最新干净版本、按「ASCII 骨架对齐 + 损坏位通配正则」逐行还原，再用「剥离注释后的代码逐行不变」证明只动了注释文本。 |
| `css-class-unused` | warn | **CSS 里定义了但 TSX/TS 从未使用的类名**（第 44 波新增）—— `css-class-undefined` 的**镜像**：那边查"用了没定义"，这边查"定义了没人用"。判定刻意保守：只认"纯类名选择器"（含后代与伪类）；带 `[属性]` 的一律不判（属性驱动可能配合运行时 `data-*`）；**减动效 / 减透明媒体块整块跳过**（那是无障碍安全网）；类名的任一前缀后跟 `${` 或 `+`（`` `nb-${x}` ``、`"lo-" + name`）视为"可能被拼出来"不判。起点 258 个 → 第 44 波清到 110 个 → **第 46 波清到 79 个（2.4%）**（残下的都在"与活类共存的选择器"里，例如 `.run-status-bar.phase-thinking` 这种**修饰类** —— 删整条会连带删掉活类的样式，故不判）。<br>**第 46 波修的两处假阳性**：① 动态守卫缺左边界（`sp-${` 命中 `resp-${Date.now()}`）；② 语料范围错了 —— 原来用带 `EXCLUDE_DIRS`/`EXCLUDE_FILE_RE` 的文件清单，于是**测试里断言过的类名**（`.no-transition`）被误报为死类名，现在语料由 `readClassCorpus()` 独立读取（只跳过 node_modules/dist/target/.git）。<br>**规则注册事故（第 46 波发现并修复）**：这条规则第 44 波只在扫描器里写了 `add()` 调用，`RULES` 表里的登记漏了 —— 而接线脚本的自检用 `includes("css-class-unused")`，恰好命中同一文件里的注释文字，于是"自检通过、规则没生效"（发现既不算 error 也不算 warn）。**教训：自检必须校验"那个具体的产物"（RULES 里的一行），不能用可能出现在注释里的字符串。** |

**合法例外**（写在 `scan-ui.mjs` 的 `ALLOWLIST`，每条都带理由；`rules` 字段可只豁免某一条规则）：
皮肤令牌定义源（`src/core/theme/`、`src/styles/skin-*.css`）、PPT 生成内容配色、大富翁游戏插件（自带美术语言）、
图书馆角色调色板注释常量；
以及两条**按规则豁免**的：`AppErrorBoundary`（崩溃兜底页必须在样式表失效时仍可读，刻意全内联样式）、
`ppt/PPTAdapter|PresentationMode`（整屏工作台/演示舞台，不是应用内浮层）。
**`src/styles.css` 不再有任何豁免** —— 字号、色值、圆角三样都已令牌化并被门禁覆盖。
例外不是后门 —— 新增例外必须在文档里说明理由。

## 5. 进度（迭代记录）

| 轮次 | 日期 | error | warn | 做了什么 |
| --- | --- | --- | --- | --- |
| 基线 | 2026-09-10 | 533 | 64 | 建立审计工具与例外表；确定现场：字号/色值/圆角/间距/弹窗外壳五类漂移 |
| 第 1 波 | 2026-09-10 | 144 | 63 | 令牌化 codemod：478 处替换（色 409 / 圆角 32 / 字号 37）＋新增 `--fs-display`/`--fs-hero`/`--overlay-backdrop(-strong)` 令牌；`fs-hardcoded` 与 `radius-offscale` 已清零 |
| 第 2 波 | 2026-09-10 | **102** | 63 | 淡色底/边按规范改写：`rgba(状态色, α)` → `color-mix(in srgb, var(--token) N%, transparent)`，84 处；新增 `css-class-undefined` 规则（tsx 用了但 CSS 里没定义的类名）—— 首次运行即暴露 **409 处"等于没样式"**，成为下一波最高性价比的工作队列 |
| 第 3 波 | 2026-09-10 | 85 | 303 | ~~清单化的"未定义类名"~~：当波只清了 Pipeline 下一步对话框与纠偏结果对比面板两处；其余 253 处留到第 10 波一次清完 |
| 第 4 波 | 2026-09-10 | **0** | 50 | 15 处自建浮层外壳收口到统一外壳（详见第 11 波） |
| 第 5 波 | 待做 | — | — | 组件语言收口：按钮/输入/卡片/空态/列表行改具名类，压缩 50 个「内联样式过密」文件 |
| 第 6 波 | 待做 | — | — | 门禁归零（只剩 warn）+ 文档 + 发布 |
| **第 10 波** | 2026-09-10 | 85 | **50** | **`css-class-undefined` 253 → 0**：① 新增 `--icon-2xs..--icon-3xl` 图标刻度与 `.icon-*` 工具类（tsx 里 ~100 处 `w-3 h-3` / `animate-spin` / `opacity-40` 全是无效类名，图标实际渲染成 lucide 默认 24px —— 比 13px 标签大一倍）；② 补 ConfigEditor(24 类) / ClarificationForm(11) / CorrectionResultPanel(11) / NotebookManager 分组视图 / plugin-market 等全部缺失样式，一律只用令牌；③ **审计器扩面**：模板字面量 `` className={`a ${x}`} `` 里的静态类名此前被整段跳过（工具漏检），现在纳入并过滤 `status-` 这类残片；④ 死类名清理：`titlebar-btn-minimize` / `video-btn play` / `font-semibold` 之类"写了但既不匹配 CSS、也无 JS 查询"的修饰类直接删掉 |
| **第 11 波** | 2026-09-10 | **0** ✅ | **50** | **error 级全线归零**：① 色值：CSS 17 处 + TSX 53 处 → 0（`--overlay-backdrop` / `--shadow-*` / 新增 `--shadow-color` 与 `--presentation-backdrop` / `color-mix` / 语义状态色；宠物窗口是独立 WebView 拿不到主令牌，自带 `--pet-*` 最小令牌表）；② 浮层：15 处自建外壳 → `modal-overlay`+`modal-panel`（对话框）/ `popover-shell`+`popover-shield`（菜单）/ `floating-overlay-panel`（浮动面板），并把 4 个菜单类（skill-picker-popup / bottom-bar-dropdown / file-link-context-menu / sidebar-project-more-menu）各写一套的外观收口到 `.popover-shell`；③ **审计器精度修复**：原来用「行内花括号平衡」推算 `style={{}}` 深度，单行样式对象会算错并越算越漏，把整份文件都当成样式上下文 —— `MEMBER_DOT = { done: "#22c55e" }`、cytoscape 图表入参这类非样式色值被算成违规（虚高的 53 条里相当一部分是假阳性），而真正的「样式在行中间」反而漏检；改为按字符扫描 + 行区间求交后收敛到 9 条真问题并全部修掉；④ 例外表支持 `rules` 字段（崩溃兜底页 / PPT 演示舞台只豁免 `modal-shell-bespoke`） |

| **第 12 波** | 2026-09-10 | **0** ✅ | **50** | **字号令牌化（宿主样式表纳入审计）**：① 审计器新增 **CSS 侧 `fs-hardcoded` 规则**（此前只查 tsx 内联样式，而 `styles.css` 整份被排除在扫描外 —— 最大的现场反而没人看）；② 592 处 `font-size` 写死像素/rem → `var(--fs-*)`，实测**只有 11 处发生 ±1px 变化**（9 处 15px 标题 → `--fs-lg`、1 处 17px 弹窗标题 → `--fs-xl`、2 处输入框镜像层统一到 `--fs-md`），其余 578 处取值不变；③ 补 `--fs-2xs`(11px) 令牌：11px 是项目第二多的小字号（121 处），补档而不是并进 10/12，既保住排版密度，又让它**跟着字号滑杆缩放** —— 这正是「设置里调字号没反应」的根因（滑杆只影响 `var(--fs-*)`）；④ 明确 `em`/`%` 是允许的相对层级（markdown 标题、行内代码）；⑤ 顺带把输入框/镜像层/消息正文统一到 `--fs-md`（此前 15px/15px/14px 三档，发送前后字号会跳变） |

| **第 13 波** | 2026-09-10 | **0** ✅ | **50** | **`styles.css` 的色值与圆角全部令牌化，该文件的例外彻底删除**：① 圆角 22 处（3px×11 → `--radius-sm`；5px×9 → `--radius-xs`；11px 开关轨道/9px 未读徽标 → `--radius-full`，本来就是"半高 = 胶囊"）；② 色值 249 处 → 语义令牌：状态色按色系归位（红→`--error`、绿→`--success`、琥珀→`--warning`、蓝→`--info`、紫蓝→`--accent`），带 alpha 的一律 `color-mix(in srgb, var(--token) N%, transparent)`；投影里的黑 → `--shadow-color`/`--shadow-color-soft`；遮罩黑 → `--overlay-backdrop(-strong)`；`color: white` → `--text-on-accent`、`background: white` → `--surface-content`；③ **新增一批"语义身份"令牌**：`--terminal-bg/-fg`、`--backdrop-black`、`--surface-content`、`--mac-btn-*`、`--window-close-*`、`--skin-preview-*` —— 这些是"外来内容/平台惯例/皮肤数据"，不该硬塞进主题令牌里，但也不该散在规则中；④ **审计器补两处盲区**：命名色（`color: white` 此前完全看不见）现在纳入；`var(--token, #fallback)` 的兜底值按**字面量位置**排除而不是"整行有 var(-- 就放过"—— 后者让 12 行混写（`box-shadow: … var(--border-primary), 0 1px 2px rgba(0,0,0,.04)`）长期漏检，修好后立刻又暴露出 library-ops.css 里 4 处被同一原因藏起来的离格圆角 |

| **第 14 波** | 2026-09-10 | **0** ✅ | **23** | **内联样式收口（开工）**：① **先修工具**：`inline-style-dense` 此前按行统计 `xxx: value` 形态，把普通 TS 对象字面量、函数入参也数进去了 —— 改成只统计 `style={{}}` 真实区间内的属性，文件数 50 → 25（这不是"改好了"，是"量对了"）；② 定义**闭集共享具名类**（`.mono` / `.panel-section-title` / `.panel-empty` / `.panel-btn(--danger/--sm)` / `.stat-cards` / `.stat-card*`），后续文件复用而不是各写一套；③ 两个文件完成收口：`RecoveryPanel`（149 个内联属性 → 0，只留统计卡颜色这一处真动态值）、`FlashcardViewer`（139 → 0，评分按钮的四色改成内联 `color` + `currentColor` 派生底边，一个动态属性顶掉原来四个） |

| **第 15 波** | 2026-09-10 | **0** ✅ | **20** | **内联样式收口（任务管理面板）**：新建 `src/styles/task-center.css`（首个按"面板"拆分的样式文件，之前所有样式都堆在 1.4 万行的 styles.css 里），把任务管理三个组件全部收口 —— `SquadsTab`（176 → 0）、`IssueDetailPanel`（133 → 0）、`AutomationTab`（134 → 0），并抽出 `tc-*` 通用族（表单/编辑器/按钮族）。**顺带修掉三处真实 bug**：`background: "var(--accent)22"`（在 `var()` 后面拼十六进制 alpha 是无效 CSS，Squad 成员徽标与「已分配 Squad」按钮其实一直没有底色）、`IssueDetailPanel` 里 `authorType === "agent" ? accent : accent` 的死三元、以及用 JS 的 `onMouseEnter` 直接改 `style.background` 做 hover（改成 CSS `:hover`） |

| **第 16 波** | 2026-09-10 | **0** ✅ | **19** | **内联样式收口（设置类面板）**：`LayeredSettingsPanel`（141 → 0）改 `.layered-*` 具名类并复用共享 `.panel-btn`；优先级圆形徽标、策略限制的 ok/warn/bad 三态都收成类。顺手修掉一处重复求值：`mgr.getBlockedModels()` / `getBlockedProviders()` 原在渲染里被调了两遍，改成先取值（这两个 getter 每次都会走一遍策略计算） |

| **第 17 波** | 2026-09-10 | **0** ✅ | **17** | **内联样式收口 + 又一处工具盲区**：① `UsageStats`（128 → 0）、`GitEnvSettings`（172 → 0，两个重复了 20 多次的「标签+输入+说明」表单收成 `.git-env-*`，保存按钮复用共享 `.panel-btn--primary`）；② **TSX 侧色值判定也改成逐字面量**：此前它和 CSS 侧犯同一个错 —— 「这行有 `var(--` 就整行放过」，于是 `color: cond ? "#22c55e" : "var(--text-primary)"` 这类混写一直漏检；修好后立刻报出 **18 处**藏在条件分支里的硬编码色（红/绿/琥珀/紫各有，含 `#e55` 这种缩写），已全部换成语义令牌；`ppt/SlideCanvas` 的幻灯片占位块按「白纸内容」单列 `--ppt-placeholder-*` 令牌（不随主题走）；③ 顺手删掉一处自己引入的重复定义（`.panel-btn` 在第 14 波提升为共享类时留下了两份） |


| **第 18 波** | 2026-09-10 | **0** ✅ | **16** | **内联样式收口（微信桥设置）**：`WechatSettings`（141 → 0）改 `.wx-*` 具名类，连二维码容器（190×190 白底 + 内边距 + 居中）也收成类。**又修掉一处真实 bug**：该组件原来用的边框色是 `var(--border-color)` —— 这个令牌在项目里**根本不存在**，所有边框一直在吃 fallback 值；统一改回 `--border-primary` 后边框才真正跟随主题 |

| **第 19 波** | 2026-09-10 | **0** ✅ | **14** | **内联样式收口 + 重复形态变成工具**：① 新增 `codemod-inline-to-class.mjs`：把**完全相同的**内联样式对象批量换成共享类，首轮扫出 64 处 —— `display:inline + verticalAlign:middle`（31）、`fs-sm + text-muted`（27）、带 4px 间距的图标（6），这些形态此前在每个文件里手写一遍；为此补 `.icon-inline` / `.icon-inline-gap` / `.hint-sm` 三个共享类（写进 §3 闭集表）。② `AgentManager`（170 → 0）与 `CicdPanel`（176 → 0）收口；`CicdPanel` 的状态色表从写死的十六进制改成语义令牌字符串（`success: "var(--success)"` …），徽标颜色从此跟着主题走；又发现两个"从没定义过"的类名（`.cicd-panel-inline`）。③ codemod 第一版曾把整行缩进压成一个空格（用了全局空白压缩），已修成"只清理被删属性留下的空白"，并把超范围替换改为逐行全局替换 |

| **第 20 波** | 2026-09-10 | **0** ✅ | **12** | **内联样式收口（性能面板 + 多模态设置）**：`PerformanceDashboard`（151 → 0）与 `MultimodalPanel`（121 → 0）。① 统计卡改成「内联只给 `color`，淡底淡边由 `currentColor` 派生」，调用处也从写死的十六进制改成语义令牌（`#3b82f6`→`var(--info)`、`#a855f7`→`var(--accent)`、`#22c55e`→`var(--success)`）；② 趋势图与占比条的蓝色渐变从写死色值改成 `--info` 派生；③ `MultimodalPanel` 的"内嵌 / 浮动"两态原本是一段三元内联样式，改成 `.mm-panel-inline` / `.mm-panel-floating` 两个类；④ 又发现两个"从没定义过"的类名（`.perf-dashboard*`、`.multimodal-inline-panel`）—— 这些组件此前**完全靠内联样式撑着**，类名只是空壳 |

| **第 21 波** | 2026-09-10 | **0** ✅ | **9** | **内联样式收口（项目/插件/轨迹三个面板，524 个属性 → 0）**：① `ProjectManager`（173 → 0，`.pm-*`）；② `PluginManager`（141 → 0，`.plugin-mgr-*`）—— 卡片外壳继续复用 `.market-skill-*`，把插件特有的风险框/依赖列表/UI 影响声明/级联确认对话框/标签页/toast 收成具名类，风险色按「红=`--error`、琥珀=`--warning`」两态各一个修饰类（原来是四个内联 `color-mix` 三元）；③ `TrajectoryPanel`（225 → 0，`.tj-*`）—— 摘要区三段（content/error/result）原本把同一份 9 行样式对象抄了三遍，收成 `.tj-summary` + `--muted/--error` 修饰类后三处共用；三步都重复的内联折叠箭头抽成 `SummaryChevron` 子组件（`.tj-chevron`）；类型图标七种颜色的内联 `style` 换成 `.tj-tone-*` 色调类。④ **顺带统一了一处浮层**：轨迹过滤下拉原来是自建外观（自带 background/border/shadow），改成 `.popover-shell` 外壳——§3 的浮层闭集又多一个真实使用者；⑤ 发现 `.trajectory-panel` 是"写了但没定义"的假钩子（它平时被同行内联样式挡着，所以从未被 `css-class-undefined` 报出来——**内联样式正好是类名审计的遮羞布**），本次补上真实定义 |

| **第 22 波** | 2026-09-10 | **0** ✅ | **6** | **内联样式收口（模型方案 / 宠物市场 / 知识图谱）+ 抓出 12 处藏在复合值里的硬编码色**：① `ModelProfilePanel`（179 → 0，`.mp-*`）、`PetMarketDialog`（159 → 0，`.petm-*`）、`KnowledgeGraphView`（174 → 0，样式落在 `src/styles/notebook-workspace.css` 的 `.kg-*` 段）。② **审计器又补掉一处 error 级盲区**：色值兜底只认「整个字符串就是一个 hex」（`color: "#ef4444"`），于是 `border: "1px solid #ef444455"`、`linear-gradient(135deg,#6366f1,#8b5cf6)` 这类**复合值里的 hex 长期看不见**；改成在样式对象区间内按字面量位置逐个找 hex 后，立刻报出 **12 处**真硬编码（App.tsx 与 HeartbeatMonitor 的红色描边、PhoneLinkSettings 的批准/拒绝按钮、ppt/SlideCanvas 的 7 处选中描边 `#7c6cf0`、zvec 市场卡片的紫色渐变），已全部换成语义令牌 —— 其中 `#7c6cf0` 正好就是默认皮肤的 `--accent`，写着硬编码的后果是换皮肤时选中框不跟着变。③ **宠物市场修掉两处"一直没生效的令牌"**：`--border-color` / `--accent-color` 在项目里**根本不存在**（与第 18 波 WechatSettings 同一类问题、同一批人写的），所有边框与安装按钮底色一直在吃 fallback 里的深色硬编码 —— 统一到 `--border-primary` / `--accent` 后浅色主题才正常；卡片悬停原来靠 JS 改 `style.transform/borderColor`，收回 CSS `:hover`。④ **知识图谱不再在 JS 里重抄皮肤表**：原组件按皮肤 id 三分支算出一整套颜色（bg/bg2/bg3/text/text2/border/accent）再塞进内联样式，而 hub 那套值与 `skin-hub.css` 一字不差 —— 代价是皮肤改了图谱不跟、**浅色主题完全没被考虑**（永远渲染成深色 GitHub 配色）。现在颜色全走语义令牌，节点类别色新增 `--chart-cat-1..6` 分类色板令牌（类别色是数据不是状态色；浅色主题里 `--info` 与 `--accent` 同值，直接复用会撞色）；节点圆形的动态半径/类别色用 `currentColor` + 派生渐变表达，选中态进 `.is-selected`。⑤ 顺带修掉一个**脆弱的测试断言**：`ICON-051` 用「文本里不许出现 `--accent-color`」判定，导致文档/注释里点名这个坏令牌都会失败；改成判定真实违规形态（`--accent-color:` 定义或 `var(--accent-color` 取用） |

| **第 23 波** | 2026-09-10 | **0** ✅ | **3** | **内联样式收口（笔记本工作台 / 输入区 / 会话区）+ 全项目「根本不存在的令牌」大扫除**：① `NotebookWorkspace`（134 → 0，样式落在 `src/styles/notebook-workspace.css`）、`InputArea`（182 → 12）、`ChatPanel`（163 → 5）。三处的共同形态是「同一个内联样式对象在同一个文件里抄 5 遍」：`.more-action-item`（+ 菜单里 5 个按钮各抄一遍 9 个属性）、`.chat-float-panel`（右侧 6 个浮动面板的几何完全一样，只有宽度与滚动方式不同）。② **128 处引用了不存在的令牌**：`--border-color`（105）、`--danger`（14）、`--accent-color`（6）、`--danger-muted/bg/border`（3），横跨 22 个文件（含 `styles.css` 自己）—— `styles.css`、皮肤文件、`ThemeManager` 里**都从未定义过**它们，所以全部一直在吃 fallback 里的硬编码深色：**浅色与 dream 皮肤下这些边框/错误色一直是错的**（第 18 波在 WechatSettings 里发现的是同一问题的单个实例，这次是全项目普查）。统一到 `--border-primary` / `--error` / `--accent`，并在 `.preview-shot/fix-missing-tokens.mjs` 留下可复跑的脚本（按 `var(` 配对扫描，能正确处理 fallback 里嵌套的 `color-mix()`）。③ **审计器补完色值规则的最后两处盲区**：条件表达式里的**命名色**（`color: disabled ? "var(--text-muted)" : "white"` → 4 处 `"white"`）与复合值里的 **`rgba()`**（投影里的黑 → 16 处，`boxShadow: "0 4px 12px rgba(0,0,0,0.2)"` 这类）。投影黑统一到 `--shadow-color(-soft)`；搜索命中高亮在 5 个文件里各写一份同一段黄，收成 `--match-highlight(-strong)` 令牌；宠物窗口的玻璃底用回了它自己的 `--pet-glass-bg`。④ **新增 `--inline-counts` 与 `--dense-threshold=N`**：门禁只看「>120 属性」这一条线，排队时却需要知道每个文件离阈值多远、收口后还剩多少 —— 现在能直接列出全项目属性数排序（本轮就是靠它确认「每个文件都真的降到 0 附近」而不是「刚好压到 119」）。⑤ 顺带修掉两处「JS 改样式盖住 CSS」的老写法（学习路径条目的 hover、技能选项的 hover），它们此前让 CSS `:hover` 永远不生效 |

| **第 24 波** | 2026-09-10 | **0** ✅ | **1** | **内联样式收口（工具调用卡片 / PPT Studio）+ 审计器第五处盲区**：① `ToolCallCard`（257 → 0，样式落在 `codem-ui.css`）—— `.tool-card` / `.tool-io-card` / `.tool-io-section` / `.tool-io-label` / `.tool-io-text` 这五个类**在 CSS 里完全不存在**，外观 100% 靠内联样式撑着（内联样式正好挡住了类名审计），连 `terminal-block` / `diff-block` / `read-block` / `search-block` 四个变体钩子也是空壳；diff 行的加减色从两段内联三元（同时给 `color` 与 `background`）改成 `.diff-line--add/--del`。② `ppt/PPTAdapter`（281 → 0）—— 整屏 PPT 工作台按例外表不套 `modal-overlay`，但同样不该写 59 处内联样式：收成 `.ppt-studio-*`；顺带把**每次渲染注入一份的 `@keyframes`**（`ppt-pulse`/`ppt-dots`）搬回样式表；又发现 `--text-faded` 这个令牌**不存在**（"未到达阶段"的灰一直在吃 fallback），改用 `--text-muted` 的 60% 表达同一层"更淡"，否则会与"已完成"阶段撞色。③ **审计器第五处盲区：匹配到 ≠ 报警过。** 此前用「本行有没有属性级匹配」决定要不要走兜底，于是一行里只要出现一个**无害**匹配（典型 `background: "transparent"`），后面几条兜底全部跳过 —— `border: "1px solid #e74c3c", background: "transparent"` 里的硬编码红就这么藏了不知多久。改成「本行是否已经报过」后立刻报出 2 处。④ `SettingsPanel` 开工（999 → 673）：新建 `.sp-*` 设置面板零件类（行/列、卡片、按钮族、输入框、提示文案、头像、开关、状态色图标、标签页），并补上 4 个"只在 tsx 里出现、CSS 里没有"的类（`.settings-search-box` / `.settings-row` / `.user-avatar-preview` / `.preset-avatar-grid`）；**该文件是本项目最后一块 `inline-style-dense`**（255 个样式对象、密度全项目最高），收口仍在进行中 |

| **第 25 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **门禁归零（error 0 / warn 0）**：最后一块 `SettingsPanel`（999 → 0）收口完成 —— 全项目最大的一块内联样式（255 个样式对象、3200 行）终于拆完，只留 3 个**真动态值**内联（字体粗细 `fontWeight`、权限动作色 `actionColors[action]`、进度条宽度 `${pct}%`），其余全部换成 `.sp-*` 具名类（行/列、卡片、按钮族 12 个修饰、输入框、提示文案、头像、开关、状态色图标、标签页、规则行、滑块行、进度条、模式选择器）。本轮把第 19 波的 codemod 升级成「**空白与引号都不敏感**的批量替换」（`.preview-shot/apply-edits2.mjs`）：签名从 `style-signature-census.mjs` 导出，一次提交 30–50 处，收尾再把 `style={{ className=… }}` 这类残留统一拆平。两个坑都记在 §7：批量替换必须**全局替换**（`String.replace` 只换第一处，会留下"同签名只改了一半"的残迹），元素已有 `className` 时要**合并**而不是新增（否则 TS17001）。<br>**门禁终局**：5 条 error（`fs-hardcoded` / `color-hardcoded-tsx` / `color-hardcoded-css` / `radius-offscale` / `modal-shell-bespoke`）与 4 条 warn（`spacing-offgrid` / `inline-style-dense` / `legacy-popup-shell` / `css-class-undefined`）**全部 0** |

| **第 26 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **"归零"之后再核查一遍：三处此前没查干净的地方，全部补掉并做成规则**。起因是自问"这些发现真的解决了吗"，于是写了三个独立核查脚本（不看审计结论、直接自己对账）：<br>① **未定义令牌**：把全项目 `var(--x)` 引用与所有定义（CSS 声明 / `setProperty` / 内联就地定义）对账，**96 处引用 10 个从未定义的令牌**仍然存在（第 23 波清掉的只是"当时人工发现的那几个"）—— 其中三类是真 bug：`--font-mono`（24 处，绝大多数**没兜底** → `font-family` 整条失效、连 §3 的共享类 `.mono` 从来没真正等宽过）、`--border`（7 处无兜底 → 边框整条不画）、`--bg-active`（1 处，JS hover 静默失效）；其余 `--destructive` / `--accent-primary` / `--accent-alpha` / `--bg-elevated` / `--border-hover` / `--bg-base` / `--accent-light` / `--success-bg` / `--surface` / `--hub-accent` / `--transform-origin` / `--text-tertiary` 都在吃写死的深色。全部改成真令牌 / 语义令牌，`--font-mono` 补成正式令牌。<br>② **空壳类名**：`css-class-undefined` 规则有一条"元素自己有内联样式就不算没样式"的豁免 —— 去掉豁免再查，**29 个类名 / 35 处**在 CSS 里一条定义都没有（`turn-status-row`、`agent-teams-panel`、`settings-section(-header/-field)`、`excel-viewer*`、`reasoning-summary/-body`、`deliverable-files*`、`stats-line`、`task-center-panel`、`side-session-panel`、`audio-player`、`drawer-body`、`nb-msg-sources*`、`note-op-notifications`、`sidebar-user-plugin-btn`、`persona-manager`、`tool-collapse-toggle`、`file-mention-btn`、`inline-file-link`、`lo-card--tools`），逐个补上真实定义（同行内联样式同时搬进类里），并**永久去掉那条豁免**。<br>③ **`style={{}}` 之外的色值**：新增规则后一次报出 **29 处**真硬编码 —— AgentTeamsPanel 的 10 个状态色、ToolManager 的 4 个分类色、ChatPanel 提示环里的 6 个 SVG 色值、lucide 图标的 `color="white"`/`#2ecc71`/`#22c55e`/`#ef4444`、游戏加载占位、崩溃兜底页（保留字面量兜底）等，全部改成语义令牌或 CSS 类；xterm 主题与 PPT 内容配色按规则写入例外表并附理由。<br>④ **顺手挖出第七类盲区（`svg-attr-var`）**：`stroke="var(--accent)"` 写在**原生 SVG 表现属性**里是无效的 —— 属性不吃 CSS 变量，React 原样输出后浏览器判非法、整条属性失效（stroke 默认 `none`，**图形根本不画**）；全项目 5 处（步骤进度环、子智能体完成勾）已改用 CSS 类，并新增规则拦住。<br>**首尾同框**：门禁规则 9 条 → **12 条**，依然 **error 0 / warn 0**；三处"已归零"经独立对账后各自又清出 96 / 29 / 29 处真问题 —— 结论写进 §7：**"计数为 0" 只代表"当前这把尺子量不到"，换一把尺子还要再量一次** |

| **第 27 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **两把新尺子：z-index 与重复类定义**（文档 §7 队列里早就记着这两项"还没有规则覆盖"，规则数 12 → **14**）。<br>**① z-index 层级**：先做层级地图（`list-zindex-sites.mjs` 把每一处写死值连同它所属选择器列出来），量出 **205 处写死值散在 40 多个文件**里，而同一个模态层有**两套互相矛盾的值**：`.modal-overlay`=200 与 `--z-modal`=1300；提示条 `--z-toast`=1400 却盖不住 9999 的 portal 菜单（提示会被吃掉）；菜单散在 100、模态散在 200/1000/2000 三档。修法：把梯子补成一条链（§2.6，14 个令牌：chrome → 浮动面板 → 下拉 → tooltip → popover → 模态 → 模态之上 → 演示舞台 → portal 菜单 → 提示条 → 整屏浮层 → 永远最上），**97 处写死值按"保持原有先后"的映射归位到令牌**，模态层统一到 `--z-modal`、提示条提到 20000（高于所有交互浮层）。剩下 149 处 <100 的是组件内部局部层叠（幻灯片元素 96 处、棋盘格子、图标叠层），规则**明确允许**裸数字 —— 它们是"局部坐标"，全局化反而更难读。<br>**② 重复/冲突类定义**：按"纯顶层选择器 + 同属性不同值"写了个 CSS 解析器，量出 **18 个类 / 35 条属性冲突**（`.badge` 圆角 10px vs 4px、`.workspace-tab` 字号 11px vs 12px、`.skill-item` 内边距两套、`.badge-muted` 底色两套、`.streaming-timer-spinner` 尺寸 12px vs 14px…），全部按"后者胜出 = 生效值"合并回一处，并保留声明顺序（避免 shorthand/longhand 关系被改坏），规则 `css-class-duplicate` 入门禁。<br>**踩坑**：合并脚本第一版"先删块、再重新解析定位首块"，偏移量全错、把 `styles.css` 改坏（审计瞬间报 890 处），已回滚改成**所有编辑用原始坐标一次算好、按起点从后往前应用**。教训：动 1.7 万行样式表的脚本，先把文件复制一份再动。 |

| **第 28 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **间距令牌化（规则 14 → 15 条）**：先普查再动手 —— CSS 里 **2906 处数值间距**（padding 1200 / gap 886 / margin 各向 778），其中 **2390 处正好落在 `--space-*` 刻度上**、116 处离格、1076 处是 `var()/%/calc/auto` 动态值。做法：① 刻度值 2354 处纯重命名成 `var(--space-*)`（零视觉变化）；② 离格小值按 2px 网格**向上归并** 60 处（3→4、5→6、7→8、13→14、18→20、22→24、36→40，与第 8 波 `spacing-offgrid` 同一政策：±1px 对齐网格）；③ 补 `--space-13/14/15`（40/48/64）作为**大留白档**（空态、引导页、页面级 padding）；④ 明确**不**动的东西：`1px`/`0.5px` 细线（核心 41 处）、负值 5 处（光学微调）、动态值、以及 `monopoly-game` 插件（整份文件豁免、自带美术语言，仍是它自己的像素间距）。<br>新增规则 `spacing-raw`（error）锁住：间距属性必须走令牌，`0`/`auto`/细线/负值/动态值放行；**几何尺寸（width/height/top…）不在规则内** —— 它们是布局坐标而不是节奏。<br>**测试抓到一处真契约**：`LO-SKIN-2` 断言插件 CSS「只使用已登记的皮肤令牌前缀」，而插件此前用自己的像素间距、白名单里没有 `--space-`。判断：间距令牌与 `--fs-*`/`--radius` 同性质（宿主提供、与皮肤无关），于是**扩契约**而不是回退 —— 测试白名单加 `--space-`，插件 README 的皮肤兼容章节同步（顺带写清"全局密度改档时插件一起跟随"）。 |

| **第 29–30 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **对照参考实现补齐交互反馈与细节层**（参考实现整份 checkout 在 `C:\talkandstory\talkandstory\_research\frakio-work`，用 `.preview-shot/compare-refs.mjs` 双向度量，不靠印象）：① `:hover` → `:is(:hover, :focus-visible)` **508 处**（同一习语：一条规则服务鼠标/键盘/展开态，特异度不变），`:focus-visible` 19 → **531**；② 全局焦点环令牌 + 兜底规则（此前 `outline: none` 74 处而 `:focus-visible` 只有 19 处）、全局按下反馈（`--press-shift` 1px，开关/滑块除外）；③ 6 处菜单触发器补 `aria-expanded`/`aria-haspopup`，并让 `[aria-expanded="true"]` 驱动背景与箭头旋转；④ 动效令牌化：字面量时长 194 → **8**，`transition: all` 49 → **1**（换成颜色/变换/阴影/透明度四段显式过渡，新增 `--transition-shadow`/`--transition-fade`，不再动画化 layout 属性）；⑤ 文字渲染 `-webkit-font-smoothing`/`text-rendering: optimizeLegibility`/`font-synthesis: none`；⑥ **分层阴影** `--shadow-raise-1/2/3` + 顶部 1px 高光 `--highlight-top`，就地升级浮层/模态/toast/统计卡；卡片悬停上浮 1px；⑦ 图标光学对齐、`dvh`（8 处）、`overscroll-behavior: contain`、`color-scheme`、`accent-color`、`::selection`、细档滚动条、标题 `text-wrap: balance`；⑧ 系统「减少动效」全局兜底 + 逐组件关停循环动画 |

| **第 31 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **控件高度尺度（对齐是"精致"的底座）**：从参考实现扒出的关键差异 —— 它所有控件都**写死高度**（34/36/38/40），我们全靠 padding + 字号推（实测 28.4 / 34.8 / 26 …），同一行两个控件能差 1–6px，视觉上就是"没对齐"。按文档 §2.4 早就写好、却没人执行的档位补成令牌（`--control-xs/dense/md/std/form` = 24/28/32/36/40）并落到 13 个共享控件类；另补 `::placeholder` 统一到 `--text-muted`（此前吃浏览器默认灰）、`input/select/textarea { min-width: 0 }`（flex 行里不再撑破容器）。只补 `height`、不动 padding/display，尺寸变化 ≤2px |

| **第 32 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **对齐原语与状态语义（补参考实现的结构性差距）**：把参考实现整份 checkout 拉下来后逐项度量，发现三处**结构性**差距（不是配色问题）：参考实现用 `display: grid` **583 处**做对齐、`:has()` **41 处**做父级状态、`prefers-reduced-motion` **27 处**；我们分别是 50 / 7 / 8。<br>① **设置/表单行改用 grid 对齐**：`.setting-group` / `.mp-form-row` / `.sp-field-row` / `.agent-input-row` / `.git-env-row` 收成「标签列 `minmax(88px, max-content)` + 内容列 `minmax(0,1fr)`」两列模板（三列行用 `--3` 修饰、堆叠行用 `--stack`），标签从此对齐成一条竖线（此前标签宽度不一、输入框左边缘参差，这正是"没对齐=不精致"的主因之一）；单列内容（说明文字、卡片、表格、模板列表）用 `grid-column: 1/-1` 跨列，避免被塞进两列网格。<br>② **`:has()` 做父级状态**：卡片里任意子元素获得键盘焦点时整张卡片给出描边（`.sp-card` / `.tool-card` / `.market-skill-card`），字段行内输入非法时整行标红（`input:user-invalid`）—— 焦点在子元素、反馈在父级。<br>③ **状态属性驱动样式**：设置侧栏 tab、笔记本视图 tab、设置面板 tab、任务中心 tab、工具 pill 补 `aria-current="page"` / `aria-selected` / `aria-expanded`（`SettingsPanel` 内 24 个 tab 按钮），并让属性选择器与 `.active` 类**同源驱动**样式 —— 此前是"类名说选中、ARIA 说没选中"，读屏用户完全得不到切换反馈。<br>④ **逐组件减动效**：浮层/抽屉/面板/toast/卡片的**入场位移动画**在 `prefers-reduced-motion` 下直接取消（`animation/transition/transform: none`），而非只停循环动画。 |
| **第 33 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **"为什么我们像项目、他们像产品"—— 带数据的诊断与底层修正**（详见 §2.8）。用户反馈"精细度比不上"，于是不再猜、把决定观感的量全部量化对比，再逐项动手：<br>① **字重是最大差异**：我们用 600 **235 次**（"哪里都半粗"），参考实现用 **650/720/620/560** 细档建层次、400 只有 11 处。新增 `--weight-regular/medium/semibold(560)/bold(620)/heavy` 五档令牌，把 34 处 meta/值类从 600 降到 500/560，并在末尾补「层次收口」规则：区块标题 620、列表项 560、**值与数字回到 400**（表格里全粗体会让数字互相打架）。<br>② **控件高度整体上抬**：24/28 为主 → `--control-*` 改为 **26/30/34/38/44**（参考实现以 34 为主），小控件不再"挤"。<br>③ **圆角软化 + 胶囊化**：`--radius-sm` 4→**6px**、`--radius-xs` 6→**8px**；10 个标签/徽标/计数类（`.market-skill-tag` / `.petm-tag` / `.sp-chip` / `.model-badge` / `.nb-count-badge` …）统一 `--radius-full` —— 方角小块像"数据表"，胶囊像"产品"。<br>④ **图标描边统一**：此前 `<svg strokeWidth>` 在 0.6/1/1.2/1.5/2/2.5 之间抖动，12–14px 上的细线发虚；统一 `1.75`，并按尺寸反向补偿（`.icon-2xs/-xs` → 2，`.icon-2xl/-3xl` → 1.5）。<br>**结论**：观感差距主要来自 ①字重层次 ②控件尺度 ③圆角与胶囊 ④图标描边一致性 ⑤窗口外壳 ⑥默认主题明度 —— **都不是"令牌化"能自动解决的**，而是逐部件的光学调校 + 品牌选择；令牌化的价值是让这些调校**一次改全局**。⑤⑥（mac 风格窗口外壳、默认浅色暖灰）需要产品决策，本轮未动。 |
| **第 35 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **字体栈收敛 + 一处自我更正（门禁规则 17 → 18 条）**。<br>① 用户点名怀疑"字体"，于是先做体检：`font-face` 用的是 `public/fonts/AlimamaFangYuanTiVF-Thin.ttf`，我用 `fvar` 表核验它**确实是可变字体**（`wght` 200–700 + `BEVL` 1–100，18 个具名实例）—— 于是**第 33 波写在 §2.1b 的"我们是静态字重、细档会被取整"是错的**，560/620 一直真实生效；同时把 `@font-face` 的 `font-weight` 从 `100 900` 收窄到真实的 `200 700`（声明超出轴范围会让浏览器在 700 以上合成伪粗体，中文界面会糊）。<br>② 真正的字体问题是**栈太散**：31 种不同 `font-family` 取值 / 192 处声明，其中**等宽栈 14 种写法**（`"SF Mono", "Fira Code", monospace`×15、`'SF Mono', Consolas, monospace`×9、`'SF Mono', Consolas, 'Liberation Mono', monospace`…），同一段代码在不同组件可能落到不同字体上；参考实现只有 15 处声明且全走令牌栈。收敛成 `--font-ui` / `--font-mono` / `--font-display` 三档（`--font-family` 降为兼容别名），**50 处等宽栈 + 6 处 UI 栈**收回令牌，不同取值 31 → **7 种**。新增规则 `font-stack-raw`。插件 CSS 保留 `var(--font-mono, ui-monospace, monospace)` 带兜底写法。 |
| **第 64 波** | 2026-09-13 | **0** ✅ | **0** ✅ | **把可靠性从「时钟与次数」换成「沉默与信息增益」（用户质疑：拿时间或次数做可靠性有问题吧？你（DSH）是怎么做的？）** —— 质疑成立，于是先读 DSH 的实现再动手（本机 `app.asar.unpacked/node_modules/@deepseek-ai/`，未打包，可逐行核对）。<br>① **DSH 的三个事实**：`dsh-timeout` 提供**两种完全不同**的机制 —— `deadline`（**单次能力调用**的绝对截止：文件 API 60s、bash/pwsh 默认 120s 上限 600s，每次可自带并用 `clampTimeout` 夹住）与 **`idleWatchdog`**（LLM 流默认 300s，**只测「沉默」**：定时器只在等下一个 chunk 期间存在，有进展 `pulse()` 重新上弦，文档明写「消费者思考时间不算 provider 空闲」，`<=0` 表示不设上限）；**agent 循环里没有迭代上限、没有「无进展」计数器、没有重复调用守卫**；上限一律是 **settings schema** 里的可配项（`maxParallelToolCalls` / `maxTokens` / `streamIdleTimeoutMs`），中止全链路走 `AbortSignal`。<br>② **我上一版的错误**：`15 分钟墙钟`会误杀合法长任务、却拦不住「还在产出废话」的循环；`第 10 次枚举就停`是**拿次数当可靠性** —— 正常的「列目录 → 读文件 → 再列目录」会被误杀，而「换十几种写法拿到同一份内容」这种真打转要数到 10 次。<br>③ **重做 1：时间只测沉默**。新增 `src/core/session/idle-watchdog.ts`（语义对齐 DSH：`pulse()` 重新上弦 / `<=0` 不设上限 / 能力错误码可取回 / 上游取消可 fusion）；后台会话**删除墙钟**，改为「连续 `turnIdleMs`（默认 5 分钟）一个事件都没有」才中止 —— **还在干活就永远不会被杀**；上限改用**资源**表达（`turnTokenBudget`，估算 token，0=不限）。<br>④ **重做 2：次数换成信息增益**。守卫新增 `noteResult()`：比较**结果内容**，「连续 N 次拿到**已经见过的内容**、且期间没有任何写操作」= **可证明的零进展**，才升级提醒(2) → 跳过(4) → 停(6)；**结果一变就是有进展，永远不拦**（有契约用例：同一命令跑 30 次、每次输出不同 → 全部放行）。旧的「枚举到第 10 次就停」删除，枚举计数降级为**纯文案提醒**。<br>⑤ **重做 3：黑名单只针对那一个签名**。被判定零增益的只是「这一个具体调用」，**换新手段一律放行** —— 否则模型永远没法改策略（这正是旧版的毛病，也是本轮自查抓出来的）。<br>⑥ **重做 4：委派等待按活动返回**。任务结束即返回；子会话**连续 `waitIdleMs` 没有任何进度上报**（安静了）才带进度返回；**一直在产出就一直等**；「反复查看」的判据也换成「两次查看之间有没有新进展」，不再数次数。<br>⑦ 三个窗口（`waitIdleMs` / `turnIdleMs` / `turnTokenBudget`）全部是配置项，每个数字都写清语义与来源。<br>校验：`tsc` 0 错误 / 213 文件 4680 用例通过 / 审计 25 条规则 0/0 / css-contract（2743 类）无变化 / 打包成功。 |
| **第 63 波** | 2026-09-13 | **0** ✅ | **0** ✅ | **自我审计：给上一版「原地打转」修复找茬（用户要求：这算好方案吗？有没有治标不治本？）—— 三轮审计查出 11 个真问题，其中 5 个是上一版自己引入的**。<br>① **拦截结果返回 `status:"error"`** → executor 把它抛成 `tool_error` → 累加 `consecutiveErrors`（**上限只有 3**）→ 「第 7 次抑制 / 第 10 次停」**根本走不到**：循环先以「连续错误过多」停掉，用户看到的是"出错了"而不是"你在原地打转"。改成 `completed`，阶梯与停止理由才对齐。**教训：阈值写在守卫里、机制却在 executor 里 —— 必须真的走一遍事件流**。<br>② **守卫按「会话」累积而非「轮次」**：重置写在了构造函数里，而 `AgenticLoop` 是按会话缓存复用的 → 几轮之后第一次读同一个文件就收到「重复调用被跳过」。挪到 `run()` 开头。<br>③ **精确指纹整体转小写 + 截断 400 字符**：大小写敏感的文件系统（macOS/Linux）上会把 `a.txt`/`A.txt` 判成同一次调用（**误拦合法读取**），长命令前缀相同会相撞。改为只压缩空白、键保留全文。<br>④ **精确重复没有「停」档** → 抑制只是"不给执行"，模型可以原样再叫；而每次被抑制的调用**仍走一遍工具事件** → 无进展阀门不触发 → **抑制本身变成新的死循环**。补精确档停档（第 8 次）。<br>⑤ **被拦下的调用仍算「有效工具调用」** → 从有效调用数里扣掉，抑制才真的等于"这一步没有进展"。<br>⑥ **取消会被悄悄改回「已完成」**：取消是异步的（abort 信号），子会话的循环往往还会跑到收尾逻辑，而 `completeTask`/`failTask` 会无条件覆盖状态 —— 用户点了"终止"却看到任务变成已完成。现在二者都不覆盖 `cancelled`，executor 被 abort 时也不上报完成。<br>⑦ **等待改成不阻塞后出现了新的空转路径**：总预算用完后每次查看都是**秒回**，模型可以「查一下、再查一下」。现在同一任务一轮内最多查看 3 次，超过即抑制并要求"报告或取消"。<br>⑧ **交接校验不能把功能锁死**：连续被拒 2 次后**放宽放行**（把缺什么写在返回里），并给接收方注入兜底提示：**缺信息就报告缺什么，不要靠反复枚举/递归扫描去猜**。<br>⑨ **守卫抢了更友好的缓存回复**：守卫原先排在 `read`/`write` 缓存之前，会把"这就是你之前读到的内容、直接用"顶掉 → `read`/`read_file`/`write`（及 `wait_for_delegation`）交回各自缓存。另外枚举历史的清零判据从「指纹是否见过」改成**按分类**（"干了别的事"才算进展）—— 否则事故里那 17 条**开关各不相同**的命令会把计数一路清零，反而永远抓不到打转。<br>⑩ **补上治本的另一半**：新增 `src/core/session/handover.ts`（交接协议 + 机械校验：缺产物绝对路径/具体目标、缺完成判据、超 12000 字 → **拒绝并给模板**；超 4000 字 → 放行 + 提醒），`delegate_to_session` 接上校验（合规才建任务，且会放手），新增 **`cancel_delegation`** 工具，系统提示词新增「Writing a Handover」章节，等待再加**累计**预算（默认 8 分钟，用完后只查看不阻塞、但完成时立刻返回结果）。<br>⑪ **审计方法（写进流程）**：**先怀疑仪器**（上一波 12 个"发现"全是仪器坏了）→ **把自己的修复当别人的代码再审一遍**，重点查三类：新的循环路径、状态覆盖关系、误杀面 → **每条阈值都要能对上现实机制**。<br>校验：`tsc` 0 错误 / 212 文件 4673 用例通过 / 审计 25 条规则 0/0 / css-contract（2743 类）无变化 / 打包成功。新增契约 `loop-guard.test.ts`（GUARD-1~17）、`handover-protocol.test.ts`（HANDOVER-1~10）、`DELE-030~043`。 |
| **第 62 波** | 2026-09-13 | **0** ✅ | **0** ✅ | **修复「交接出去的新会话原地打转十几分钟」（用户报：交接后仍在交接、原对话等待超时、感觉新对话把所有内容遍历了一遍）**。<br>① **现象（用户控制台日志）**：父会话 `list_sessions` → 写交接总结 → `delegate_to_session` → `wait_for_delegation` 阻塞；子会话读完工交接文件后，**连续三十多次执行几乎一样的目录枚举**，只换 `-Force` / `-LiteralPath` / `Out-String -Width 200` / `Sort-Object` 这些装饰性开关，两个目录来回打转，直到超时。<br>② **为什么两道阀门都拦不住**：`AgenticLoop` 的「连续无进展」判据是 `iterationHadText \|\| toolCallsInIteration > 0` —— **每次枚举都成功返回了内容**，于是计数器每轮清零，`MAX_CONSECUTIVE_NO_PROGRESS = 30` 永远到不了；同轮次去重只覆盖 `read`（同 path+range）与 `wait_for_delegation`（同 task_id），**bash 换个写法就绕过去了**。<br>③ **新增 `src/core/llm/loop-guard.ts`（纯状态机，可单测）+ 接进 agentic-loop**：<br>  · **精确指纹**（工具 + 归一化参数，递归排序键、小写、压缩空白）：第 3 次提醒 → 第 5 次抑制；<br>  · **意图指纹**：只读目录枚举按**目标路径**归并（忽略装饰性开关），第 4 次提醒 → 第 7 次抑制 → **第 10 次直接停整个循环**并给出三条出路（用 read 读已知文件 / 直接报告"未找到 + 已试过的路径" / 说明需要调用方补什么）；<br>  · **写操作重置计数**（世界变了，重新枚举合理）、**认不出的命令只参与精确指纹**（宁可漏判不误杀）、会话 cwd 参与指纹（裸 `Get-ChildItem` 与写全路径的其实是同一目标）。<br>④ **`wait_for_delegation` 不再无限期阻塞**：单次等待 3 分钟预算，到点**带进度返回**（已跑多久 / 工具调用次数 / 最近一次工具 / 子会话最新输出 + 三个可选动作）；后台会话另加 15 分钟**墙钟上限**，到点按「部分完成」把已有产出一并交回（原实现把打转十几分钟当**正常结束**回传）。<br>⑤ **顺带修好一处"看不见证据"的日志**：`Single-response dedup` 那行只打印 `task_id`/`path`，于是 bash 一律显示成 `bash("")` —— 恰恰在最需要看命令的时候看不见命令，这也是用户和我一开始都判断不出"是不是同样的命令"的原因。现在带出命令（截断）。<br>⑥ **测试用事故现场的原话**：`GUARD-1/2` 直接拿日志里那 **17 条真实命令**当样本，要求全部识别为只读枚举、且**塌缩成两个意图指纹**；另含"不同目录互不牵连（不会因为总次数提前拦）"、"写过文件即重置"、"git/npm/解释器不被误判"、"自带缓存的工具不再叠一层"。`DELE-030~035` 锁住等待预算、进度可见、墙钟上限与"部分完成"语义。<br>⑦ **写进规范的判据**：**「成功返回内容」不等于「有进展」** —— 判断循环停滞不能只看"有没有工具调用成功"，要看"是不是在同一个目标上重复同一类只读操作"；后台/委派会话是无人盯守的执行路径，必须有**明确的预算**（迭代、墙钟、等待）而不是靠模型自觉。 |
| **第 61 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **死字段排查（用户问"项目里还有没有类似死字段的情况"）—— 结论：有，而且分三类**。<br>① **"存了不生效"**：`codem-display-mode` **只写不读** —— 设置页能改、值也真写进了库，但全项目没有一处读回来，重启永远回默认（`App.tsx` 现在在 DB 就绪后读回并应用）。<br>② **"读了没人写"**：`codem-current-project-path` 全项目**没有写入方**，于是 codegraph 的「索引检测」一直拿到空串（改为读项目 store 的 `currentProject.path`）。<br>③ **"多传参数被静默忽略"**：`getSetting(键, 默认值)` 多传了第二个实参（`system-prompt-instructions` / `ui-language`），而 `getSetting` 只接受一个参数 —— 这两个文件带 `// @ts-nocheck`，类型检查也拦不住。<br>④ **零读取方的死配置字段**：`defaultSettings.theme` / `mimoPath` / `autoApprove` 已删；其中 `theme: "dark"` 与真实默认档 `DEFAULT_THEME = "light"` **互相矛盾**，而旧版保存任意设置都会把整份默认对象写进 `codem-settings` —— 于是"从设置对象读主题"的路径会把默认档变成暗色。<br>⑤ **7 个死 CSS 令牌**（22 行定义，零引用）删除：`--elevation-2` / `--composer-*` / `--surface-3` / `--message-bubble-*` / `--composer-bg` / `--composer-border` / `--titlebar-bg`；新增审计规则 **`css-var-unused`**（warn，带豁免清单 + 理由）。<br>⑥ **新增契约测试 `settings-keys-symmetry.test.ts`（SKEY-0~4）**：每个设置键必须**既有写入方、又有读取方** —— 扫 810 个文件 / 251 个取键调用点 / **70 个键**；"只读旋钮"必须登记白名单并附理由（白名单里的键消失也会报红，防止清单长草）。<br>⑦ **最值得记的一段：这个检测器第一版报了 12 个键，全是"仪器坏了"而不是"代码有病"** —— ①把 `key.startsWith("codem-")`、`addEventListener("codem-open-file")`、`new CustomEvent("codem-env-script-result")` 里的**事件名/前缀判断**当成设置键（它们同样以 `codem-` 开头）；②把**读取别名** `settings(...)`（= `__codemSettings.getSettingJSON`，恰好以 `set` 开头）判成写入；③6 个模块各自声明的 `SETTINGS_KEY` 在全局「常量名→键值」表里互相覆盖，**6 个键被悄悄并成 1 个**（改成按文件隔离 + 全局兜底）；④泛型组过度贪婪 —— `getSettingJSON<Record<string, any>>(KEY, …)` 的匹配从**类型名 `Record`** 起头、跨行吃到下一行的键，把真正的调用点整个吞掉（改成 `[^()=]*`：禁 `(` `)` 定位到正确的 `>`，**禁 `=` 把"类型实参"和"代码"分开**，允许换行与 `{};` 以支持多行对象字面量泛型）。四种形状现在都是 SKEY-0 里的断言 —— **仪器也要被自检**。<br>⑧ **遗留（写进 §7 清单，未修）**：`codem-figma-token` **只读且没有设置界面**，而 `figma-fetch.ts` 的报错文案还在让用户"去设置里配"（文案指向不存在的入口）；`agentsMdMaxBytes` 只读、无写入方；9 个 `DREAM_CSS_VARS` 注入的令牌 CSS 从未消费；`ConversationComposer.tsx` / `ConversationSession.tsx` 零引用、但它们是 3 个插槽的唯一消费者（删除会作废扩展点，属架构决定）；**262 个文件带 `// @ts-nocheck`**（196 个在 `src/core/provider/`）是"多传参数"类 bug 能潜伏至今的原因。<br>校验：`tsc` 0 错误 / 209 文件 4629 用例通过 / 审计 25 条规则 0/0 / CSS 生效取值快照（2743 类）无变化 / 打包成功。 |
| **第 60 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **修复「启动时先闪一下相反主题」（用户报的老问题：暗色先白后暗、浅色先黑后亮、偶尔还黑→亮→黑）**。<br>① **三个现象一个根因**：主题有「真相源（SQLite 的 `codem-theme`）」与「首屏镜像（localStorage 的 `codem-theme-cache`）」两份，**但两者从不校准**；而 `TitleBar` 的 `theme` 初值写的是 `DB → **默认档**` —— 启动早期 DB 还没就绪，于是**挂载时用默认档应用了一次主题**：<br>  · 它把 `index.html` 预渲染好的正确档位**覆盖**掉 → 暗色用户先白一帧、浅色用户先黑一帧；<br>  · 它同时把**镜像也改成默认档**（`applyThemeAttribute` 会写镜像）→ 镜像长期停在错的档位，于是**每次启动都闪**（这正是"很久就有的问题"的成因）；<br>  · DB 就绪后再改回真实档位 → 于是出现"黑→亮→黑"三段跳。<br>② **修复：统一启动期解析器 + 幂等应用**。`theme-default.ts` 新增 `resolveEffectiveTheme(readSetting)`：**DB（就绪后）→ 镜像（首屏预测）→ 默认档**；启动路径（`TitleBar` / `SkinSelector` / `ThemeManager` ×2 处）全部改用它，不再各自 `isThemeMode(saved) ? saved : DEFAULT_THEME`。`applyThemeAttribute()` 改为**幂等**：档位没变时不碰 DOM、不重写镜像（只补一次缺失的镜像），于是启动期间不再产生任何 `data-theme` 抖动。<br>③ **顺带补一层首屏画布底色**：`html`/`body`/`#root` 此前全是 `transparent`，窗口又是 `transparent: true` —— 首帧底色只能靠浏览器对 `color-scheme` 的默认处理。现在显式给 `html:not(.pet-window-mode) { background-color: var(--bg-primary) }`（宠物窗口刻意排除，它本就该浮在桌面上）。<br>④ **实测（无头浏览器 + 源码 CSS，三种镜像状态）**：镜像=暗色 → `data-theme=dark`、`color-scheme: dark`、画布与启动页都是 `rgb(14,15,15)`；镜像=浅色 → `rgb(252,252,251)`；无镜像 → 不设属性、走 `:root` 默认档 `rgb(252,252,251)`。即**首帧底色与"上次实际生效的档位"一致**。<br>⑤ **新增 8 条契约测试**（`src/test/theme-boot.test.ts`）：`resolveEffectiveTheme` 的优先级（DB→镜像→默认，含垃圾值回落）、`applyThemeAttribute` 幂等（同档位不写 DOM/不写镜像）、**复现用户场景**（预渲染暗色后启动路径不得改成浅色；DB 纠正后镜像必须跟着校准，否则下次还会闪）、真执行 `index.html` 的内联脚本验证首屏属性、启动路径源码不得再各自拼默认档、首屏画布规则存在；另加两条真浏览器首帧渲染断言（THEME-BOOT-7/8）。<br>⑥ **反验**：把 `TitleBar` 的主题初值改回旧的「DB → 默认档」写法 → THEME-BOOT-5 立刻变红。<br>**遗留说明**：升级到本版的**第一次**启动仍可能切换一次（旧版本写坏的镜像要等 DB 就绪才能纠正），之后每次启动都不再闪 —— 这是"镜像只能预测、不能替代真相源"的固有限制。 |
| **第 59 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **修复「对话编辑区光标看不清」（用户报：默认皮肤暗色下光标是紫的、在深底上看不清）**。<br>① **根因**：编辑区光标被写成了**品牌色** —— `.message-input` 与 `.message-input.mirror-mode` 都是 `caret-color: var(--accent, #6b46c1)`。暗色主题的 `--accent` 是紫色 `#7c6cf0`，落在近黑背景（`--bg-primary` = `rgba(14,15,15,1)`）上对比度只有 **4.33:1**，而**同一处的正文文字是 11.67:1** —— 一根 1px 的闪烁竖线只有文字三分之一的可见度，实际感受就是「找不到光标在哪」。浅色主题同理（4.87:1）。<br>② **修复**：新增令牌 `--caret-color: var(--text-primary)`（**引用**正文色而不是抄色值：两档主题各自解析，皮肤也能覆盖），两处光标都改走它。效果：暗色 **11.67:1**、浅色 **16.50:1** —— 光标与它旁边的文字**完全同色**，"光标在哪"不再取决于品牌色够不够亮。<br>③ **规律（写进规范）**：**文字类可见性（光标、文本装饰）跟随"文字色"，只有装饰性元素才用品牌色**。品牌色的职责是"表达身份"，不是"保证可读"；一旦把品牌色用在 1px 级细元素上，就必须单独做对比度验收。<br>④ **新增门禁 CSS-INTEGRITY-8**：①两处光标规则必须走 `var(--caret-color)` 且不得再用 `--accent`；②令牌必须定义为 `var(--text-primary)`；③**按令牌实算对比度**（暗/浅各算一次，要求 ≥7:1）。这条门禁不依赖浏览器，纯计算即可拦住"换了个更暗的品牌色又把光标埋了"。<br>⑤ **顺带排查**：全项目只有这两处显式声明 `caret-color`；其余输入框（含消息行内编辑框）都没写该属性，光标默认跟随 `currentColor`（各自文字色）—— 修好这两处后，界面上所有输入光标都与文字同色。 |
| **第 58 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **治理控制台噪声（用户贴出运行日志："后台控制台报警告"）——真正的警告只有一处，但它每次工具调用都刷**。<br>① **定位**：把用户日志逐行分类后，**warn 级别只有一条** —— `[AgenticLoop] Service "snapshot" not available, falling back to singleton`（一次 `write` 调用出现**两遍**，还带调用栈）；其余十几条都是 `console.log` 的迭代/请求级诊断。<br>② **警告的根因**：快照服务是**按 cwd 单例**的（`getSnapshotService(cwd)`，`SnapshotPanel` 与测试都这么取），**没有任何 Provider 注册过 `ctx.provide('snapshot', …)`** —— 于是 `ctx.get('snapshot')` 必然落空，容错分支里的 `console.warn` 就变成了"每次工具调用打一遍"。修法：这一处不再走 ctx（按 cwd 取单例才是它真正的入口），并在代码里写清为什么它和其它服务不一样。<br>③ **回退告警改成只报一次**：其余 7 处（permission / telemetry / transcriptCache / messageStorage / visionProxy / eventLog / fileChangeTracker）保留告警，但走新增的 `warnOnce(key, …)` —— 回退本身是设计好的容错（功能不受影响），"服务没接上"值得知道**一次**，而不是每个工具调用一次。<br>④ **热路径诊断日志默认静默**（`src/core/debug.ts` 的 `debugLog(ns, …)`）：把 13 条"每轮迭代 / 每次请求 / 每次工具调用 / 每次自动保存"的日志收口，默认不输出；排查时在控制台执行 `localStorage.setItem('codem-debug', 'agent-loop,provider')` 后重载（或设 `window.__CODEM_DEBUG__`）即可恢复。**收口的清单**：`Iteration N: calling LLM` / `LLM stream ended` / `Iteration N completed` / `buildMessages raw` / `collaborationMode=…` / `Injected skill catalog` / `Request header changed` / `Plan N steps` / 两处 `LLM plan` / `[Provider] stream:` / `[Provider] Tool call end:`（原来会把工具参数——含生成的文件内容——打进控制台）/ `[AutoSave] Debounce save`。**保持不变**：所有 `console.error`、`Runaway detected`、`Crash repair`、工具执行失败、成本降级等**真信号**。<br>⑤ **排查方法（可复用）**：写脚本按「前缀 → 日志级别 → 调用点」把日志分类，再用「是否位于循环 / catch 内 + 是否在热路径文件里」筛出可能高频的告警。全项目 606 处 `warn/error` 里，热路径循环内的 48 处**都在失败分支**（真出错才打），只有服务回退那一处在"正常路径上每次都打"。<br>⑥ **新增契约测试**（`src/test/console-noise.test.ts`，LOG-1~5）：回退告警每服务只报一次（5 次调用 → 1 条）、快照服务不再向 ctx 索取 `'snapshot'` 且零告警、诊断日志默认静默（开启 `codem-debug` 后才输出）、**源码层面禁止这些文案回到裸 `console.log`**、以及"关键告警没有被误静默"（`console.error` 仍在、EXT-048 依赖的文案仍在）。 |
| **第 57 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **修复「工具行没撑开、行尾控件没靠右」（用户报：右侧栏【文件】的【筛选文件】搜索框里【刷新】按钮没居右、右边空了一片）**。<br>① **根因（一类"失效属性"）**：`.file-explorer-search-bar` 写的是 `grid-template-columns: repeat(3, max-content)` 的三列网格，而输入框上写着 `flex: 1` —— **`flex` 在 grid 容器里完全无效**，三列都按内容宽度排，于是整行靠左、右侧空一片。实测：724px 宽的行里，刷新按钮距右边缘还差 **527px**。<br>② **系统性排查（找到同类 4 处）**：写脚本按「声明了 `flex` 增长的元素，其父容器是不是 grid」逐个核对（并用无头浏览器实测）。判据分两族：<br>  · 父容器有 `minmax(0, 1fr)` 轨道 → 元素已被轨道撑开，`flex` 只是死代码，**无视觉问题**（`.quote-context-left`、`.snapshot-file-path`、`.turn-label`、`.project-item-info`、`.space-switcher-item-name`、`.attachment-name`、`.kg-weight-track`、`.ppt-studio-range`、`.wx-input--grow`、`.agent-input--w2` 等 10 处）；<br>  · 父容器**全是 max-content 轨道** → 元素撑不开、行尾控件被顶在左边，**真 bug**：`.video-controls`（进度条卡在 129px，右侧空 485px）、`.notebook-manager-toolbar`（搜索框卡在 194px，空 444px）、`.mcp-catalog-actions`（提示文本卡在 220px，空 424px，且 320px 窄卡片下**整行溢出 16px**）、`.mm-footer`（保存按钮的 `margin-left: auto` 在 grid 里**不吸收行尾空白**，实测右边空 616px）。<br>③ **修复**：这 4 处 + 报告项统一从「全 max-content 轨道的网格」改成 flex（子元素原有的 `flex: 1` 立刻生效）—— 输入框/滑杆/提示文本真正撑开、行尾按钮贴住右边缘；`.notebook-manager-toolbar` / `.mcp-catalog-actions` 允许换行（极窄时整块换到下一行，而不是挤压变形）；提示文本补 `min-width: 0` + 省略号（长错误信息不再把行撑爆）；`.notebook-search-box` / `.video-progress` 补 `min-width: 0`。<br>④ **新增门禁：真实渲染的「撑开与靠右」契约**（`fixtures/toolbar-rows-probe.html` + `layout-contract.test.ts` 的 LAYOUT-10）。用无头 Edge 把 5 个行按真实 CSS 渲染，在 **7 种可用宽度（320→760）** 下逐行测量：①可伸缩元素必须占到行内宽度的 **≥25%**；②未换行时行尾控件的右边缘必须贴住行的右边缘（偏差 ≤2px）；③不得溢出。**修复前 35 个测量点全部不合格，修复后 0 个不合格**。<br>⑤ **顺带修掉测试自身的隐患**：无头浏览器冷启动偶尔超过 vitest 默认的 5s 超时，会把门禁变成"偶发红"。已把测量提到 describe 级（只跑一次）并显式放宽到 30s。<br>⑥ **写进规范**：`flex` 只对 flex 容器的子元素生效；把容器从 flex 改成 grid 时，**必须同时把子元素上的 `flex` 迁移成 grid 写法**（`minmax(0, 1fr)` 轨道、`justify-content`、或 `margin-left: auto` —— 注意 auto 外边距在 grid 里**不会**吸收行尾空白）。这一条已加进 §7 的"明确保留/注意事项"。 |
| **第 56 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **修复「打开设置后主页文字突然变大、关了也不回退」（用户报的"奇怪的 bug"）**。<br>① **机制**：界面字号存在**两个键**里，而且两处各带一个**不同的默认值** —— 启动路径（`Sidebar` 挂载时）读旧扁平键 `codem-font-size`，而它**只由字号滑杆写入**，所以没拖过滑杆的用户读到空值 → 回落到基准 **13px（scale 1.0）**；设置页**打开时**应用的却是另一个来源 `codem-settings.fontSize`，其默认值是 **14** → 全站瞬间放大 **14/13 ≈ 7.7%**。变量写在 `<html>` 的行内样式上，关掉设置不会复原（本会话一直放大），重启又回到 13 —— 于是表现为"跳一下、而且关不掉"。<br>② **实测幅度**（无头浏览器 + 真实 CSS）：会话标题 `13px → 14.0px`、项目名 `14px → 15.08px`、标签 `11px → 11.85px`、按钮 `12px → 12.92px`，整体 **+7.7%**。<br>③ **修复：单一来源 + 启动就应用**。`core/ui-font.ts` 收敛成一个解析器 `resolveUiFontPx`，优先级为：**旧扁平键（只由滑杆写入 ⇒ 用户明确选择）→ 设置对象里的 `fontSize` → 基准 13**；应用点统一为「数据库就绪后（`App.tsx`）+ 侧栏挂载 + 设置页打开/改动」，全部走同一个解析器，因此打开设置**不再产生任何视觉变化**。设置页的默认值也从 14 改为 `FONT_BASE_PX`（与 `--fs-*` 的缩放基准一致）。<br>④ **兼容处理（这里有个必须写下来的细节）**：旧代码保存任何设置时，都会把 `defaultSettings.fontSize = 14` 一起写进 `codem-settings` —— 于是「14」既可能是用户自己选的，也可能只是默认值。判定规则：**旧扁平键存在**（= 真的拖过滑杆）时 14 是明确选择，照用；**不存在**时把 14 视为"未设置"归一为基准 13。否则那批"从没动过字号"的用户会在修复后被**永久**放大 7.7%。滑杆显示值也同步归一，避免"显示 14、渲染 13"的新不一致。<br>⑤ **同类排查**：写脚本扫描「只在打开设置时才写到 `documentElement` 的全局值」，另有 `--font-weight` 与 `--font-family` —— 它们读写**同一个键**（`Sidebar` 启动时也用同一键恢复），不存在跳变；其余 `documentElement` 写入是运行时测量（聊天区高度）。<br>⑥ **新增 6 条契约测试**（`src/test/ui-font-scale.test.ts`）：默认回落基准且 scale 恰为 `1.000`、优先级（含"14 且无滑杆记录 = 未设置"/"14 且有记录 = 用户选择"）、越界钳制不出 NaN、**设置页默认值必须等于缩放基准**（两边默认值不同就是本次 bug 的根）、**启动路径必须在 `initDatabase()` 之后应用**、设置页不得再直接应用 `parsed.fontSize`。 |
| **第 55 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **修复「标签被压成竖排」与「性能面板页签变形」+ 把这类挤压变形做成真实渲染门禁**。<br>① **现象与根因（用户报的两处，同一病根）**：设置 →「通用」里「我是什么 / 什么风格」的选项按钮变成**竖着的一条**（4 个字排成 4 行、按钮只有 42px 宽）；性能面板的【总览】【会话】【时延】被压变形。根因是我在第 42/51 波做的两次「批量统一」：<br>  · 第 42 波把一批 `flex-wrap: wrap` 的**标签墙**改成 `grid-template-columns: repeat(auto-fill, minmax(<32/40px>, max-content))` —— **auto-fill 的空轨道不会折叠**，轨道数按最小轨道算满一整行，于是文字芯片被塞进 32/40px 宽的轨道，中文**逐字换行**（看起来就是"竖着的"）。实测：`.identity-option` 在 1200px 宽下也是 4 字 4 行。<br>  · 第 51 波把所有「按钮行」统一成 `flex-wrap: nowrap`，其中包括 `.perf-tabs` —— 页签行放不下时不再换行，而是**压缩子元素**，中文立刻逐字换行。<br>② **修复**：**17 个标签墙/工具行**恢复为 `display: flex; flex-wrap: wrap`（芯片保持自然宽度，放不下就整块换行，绝不压缩变形），并给 11 个文字芯片/选项按钮补 `white-space: nowrap`。清单：`.identity-options` / `.bootstrap-options` / `.agent-checks` / `.pending-attachments` / `.flashcard-toolbar` / `.wx-status-row` / `.wx-actions` / `.mcp-server-tools` / `.mcp-catalog-tags` / `.mcp-detail-tags` / `.skill-detail-tags` / `.memory-detail-tags`（以上 `styles.css`）、`.tool-group-body-inline` / `.decision-tray-options`（`codem-ui.css`）、`.nb-source-topics` / `.nb-tag-filter`（`notebook-workspace.css`）、`.issue-detail-meta`（`task-center.css`）。其中 12 个是本波排查出来的、用户还没遇到的同类问题。<br>③ **性能面板重新设计（用户要求"任何分辨率都不变形、又不溢出看不到"）**：`.perf-tabs` 允许换行（`flex-wrap: wrap`）；`.perf-tab-group` / `.perf-controls` 同样可换行（`.perf-controls` 从 `repeat(4, max-content)` 网格改成 flex，网格的 max-content 轨道无法收缩、窄面板下会溢出）；页签与标题补 `nowrap`；`.perf-type-row` 从固定四列网格改成 flex-wrap，`.perf-type-name` 从 `min-width: 200px`（窄面板下撑爆整行）改成可压缩 + 省略号；`.perf-content` 横向也给 `overflow: auto` 兜底 —— **宁可滑动，也不要"溢出窗口看不到"**。<br>④ **新增门禁 A：真实渲染的挤压变形检测**（`src/test/fixtures/chip-rows-probe.html` + `layout-contract.test.ts` 的 LAYOUT-8/9）。用无头 Edge 把 17 个标签墙/工具行按真实 CSS 渲染，在 **320/360/420/480/560/640/760/900/1200 九种宽度**下，逐元素用 `Range.getClientRects()` 数**真实文字行数**，判定：①短标签（≤14 字）不得排成 ≥3 行（即"竖排"）；②容器 `scrollWidth` 不得超过 `clientWidth`（即不得溢出）。当前 **153 个测量点全部正常**。<br>⑤ **新增门禁 B：静态禁用「小轨道 auto-fill 网格」**（LAYOUT-7）：凡是 `repeat(auto-fill 或 auto-fit, minmax(<64px>, max-content))` 一律报错（豁免两个 emoji 按钮网格，其内容是单个 emoji、不会换行）。这条规则写下来就是防止"为了把 grid 数量做大"再把标签墙改回去。<br>⑥ **反验（门禁确实会红）**：用第 42/51 波那版 CSS 跑同一个探针 → **55 处异常、10 个容器中招**（`identity-option` 「AI 助手」4 字 → 4 行、宽 42px；`perf-tabs` 页签同样变形）；换成修复版 → **0 处异常**。<br>⑦ **反思（写进 §7）**：第 42 波的改动是**为指标而改**（"grid 处数 275 → 305 对齐参考实现"），代价是把「标签墙」这一语义正确的原语换成了语义错误的网格 —— **指标是结果，不是目标**；用 `auto-fill` 表达"排满一行"时，`minmax(小值, max-content)` 是最坏组合（空轨道不折叠 + 轨道比内容还窄）。 |
| **第 54 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **紧急修复：设置弹窗塌成 160px 窄条（用户报「设置窗口很狭长的一条，内容都看不到」）+ 补两道「生效取值」门禁**。<br>① **现象与根因**：设置弹窗（`.settings-panel`）只剩下一条 160px 宽的竖条，内容区被挤到 **40px**。根因是 `codem-ui.css` 里残留着一个**悬空的 `.settings-panel,`**（第 51 波跨文件合并脚本的残骸，后面空一行接 `.settings-sidebar {`）—— 选择器列表因此变成 `.settings-panel, .settings-sidebar`，**弹窗继承了侧栏的 `width: 160px` / `flex-shrink: 0` / 纵向 flex / 毛玻璃底**。删掉多余成员即恢复：弹窗回到设计宽度 760px、内容区 598px。<br>② **为什么一路绿灯**（这是本波最重要的部分）：那是**完全合法的 CSS**（选择器列表允许跨行、允许任意组合），所以打包不报错；`tsc` 看不见样式；`css-class-duplicate` / `css-class-cross-file` 只比对**单类选择器**，选择器列表整条被跳过；`css-integrity` 查的是括号/悬挂逗号/空规则体这类**语法**问题；目录里已有的 CSS 契约测试都是「某个属性等于某个值」，**没有任何门禁在看"渲染出来的几何"**。<br>③ **同类残骸的独立排查**：写了三个脚本 —— ①对比合并前后的**选择器列表成员集合**（`diff-selector-lists.mjs`，全项目只有 1 条规则成员集合变化，就是字重那组）；②找「同类名从列表规则拿到与自身专属规则冲突的取值」（`scan-listed-vs-dedicated.mjs`，17 处，逐个判读后确认都是**有意的**减动效覆盖/变体覆盖）；③用无头 Edge 真实渲染测几何（见下）。<br>④ **顺带查出并修复第二处同源回归**：第 51 波把**两个 `font-weight` 组并成了一条**（都取 `--weight-semibold`），于是「区块标题 620（`--weight-bold`）」被悄悄降成 560 —— 正好破坏了 §2.1b / 文件里那条注释写明的字重层次。已拆回两组，并用脚本逐类核对与合并前**完全一致**。<br>⑤ **新增门禁 A：真实布局契约**（`src/test/layout-contract.test.ts` + `src/test/fixtures/settings-modal-probe.html`）。jsdom 没有布局引擎，所以这类问题必须用**真浏览器**测：用无头 Edge 加载 fixture（直接引用源码 CSS、与应用相同加载顺序，因此不需要先构建），一次加载在 13 种可用区域下测量弹窗/内容区几何，断言：面板宽 ≥480px、内容区 ≥320px、宽屏下等于设计宽度 760px、窄屏（≤768px）走整宽。**没有 Edge 的机器自动跳过**（并打印原因）。<br>⑥ **新增门禁 B：CSS 有效声明快照**（`tools/ui-audit/css-contract.mjs` + `tools/ui-audit/css-contract.json`）：把基础样式表**顶层规则**解析成「每个类 → 生效后的声明集合」（按加载顺序 + 单类特异度，后写者胜；条件块不参与，因为那是有意的分层覆盖），共 **2743 个类**。取值一旦变化测试就红，必须显式 `--write` 更新快照 —— 于是每次改动都会在 diff 里写清「哪个类的哪个属性从什么变成了什么」。这一道正好补上前面三次事故都漏掉的**生效取值**维度。<br>⑦ **反验（两条门禁都确认会红）**：把 `.settings-panel,` 悬空注入回去 → 布局契约与快照门禁**都报红**（快照精确打印 `width: 760px → 160px`）；把标题档字重改回 560 → 快照门禁报出三个类的 `font-weight` 变化。<br>⑧ **分辨率自适应的实测数据**（修复后）：1920×1080 / 1366×768 / 1280×720 下弹窗 760×656～440px、内容区 598×587～371px；1024×600（很矮的窗口）下 760×368、内容区 299px 且**可滚动**；800×600 及更窄时媒体查询接管、弹窗铺满可用区域；DPR 1 / 1.25 / 1.5 / 2 几何一致（CSS 像素）—— 即纵向不足时内容可滚动、横向不足时收窄或整宽，**任何分辨率下都不会再出现窄条**。 |
| **第 53 波** | 2026-09-11 | **0** ✅ | **0** ✅ | **用户报的「另一个右侧边栏标签区有滚动条」→ 系统排查 → 挖出配置弹窗 7 个页签被裁掉 + ConfigEditor 从未迁到图标体系**。<br>① **报告项**：`.right-sidebar-tabs`（文件 / 浏览器）在两个基础样式表里各写了一遍 —— `styles.css` 写 `overflow-x: auto`（横向滚动）、`codem-ui.css` 写 `flex-wrap: wrap`（折行），**两个属性同时生效**（既折行又有滚动条）。合并成一处权威定义（不换行 flex + `overflow: hidden`，页签可压缩成省略号）。<br>② **系统排查**：用 `.preview-shot/audit-button-rows.mjs` 按三类问题（A 横向滚动 / B 固定列数网格 / C `flex-wrap` 折行）扫**所有按钮行与标签行**，命中 36 处，逐条判定后修掉 6 处**容器级**问题：`.right-sidebar-tabs`（两个文件）、`.nb-panel-tabs`（3 个标签塞进 2 列网格必然折行）、`.kg-toolbar`（6 个控件塞进 2 列网格折成三行）、`.perf-tabs`、`.config-tabs`。**保留不动**：元素内部「图标 + 文字」的 `repeat(2, max-content)`（那是对的）、动态数量的长列表（工作区标签 / Excel 工作表 / 标签墙 —— 滚动或折行是合理意图）。<br>③ **同类问题的第二个实例（比报告的更严重）**：`.config-tabs`（「分层配置管理」弹窗）有 **7 个页签**，而弹窗只有 560px 宽 —— 第 51 波把它改成 `flex-wrap: nowrap` + `overflow: hidden` 之后，**后半页签直接消失、既看不见也点不到**。修法：容器允许换行（高度自适应 → 永远不会裁掉），页签本身 `min-width: 0`、标签文字走 `.config-tab-label` 省略号。新增两条 CSS 契约：**CSS-INTEGRITY-5**「flex 行容器不得同时 nowrap + overflow:hidden，除非逐个说明理由」（豁免清单 6 项，每项都写清为什么不会被裁）与 **CSS-INTEGRITY-6**「`.config-tabs` 必须允许换行且标签能省略号」。<br>④ **ConfigEditor 整个组件从未迁到图标体系**：标题是 `⚙️`、关闭按钮是文字 `✕`、7 个页签 + 2 个层级按钮 + 结构页 + 保存按钮全是 emoji（共 11 处）。全部换成 lucide + `ActionIcons.close`；顺带给 `ActionIcons` 补了 `save`。**副作用是页签变窄了** —— 单个 emoji 就要 ~20px 宽，去掉后 7 个页签的宽度压力小了一截。<br>⑤ **文字 `✕`/`×` 当按钮图标的还有 13 处**（ImageGallery / ModelProfilePanel / PromptDraftPicker ×2 / QuickPhraseSelector / SkillManager ×2 / Sidebar / AudioPlayer / NoteEditor / RecoveryPanel / SettingsPanel / MultimodalPanel / SlotBridge / PPTEditor ×2 / PropertyPanel）。逐个按**语义**换成 `ActionIcons.close` 或 `ActionIcons.delete` —— 其中 4 处其实是**删除**动作（删除环境脚本行、删除恢复会话、删除幻灯片、删除列表项），显示垃圾桶比显示 ✕ 更准确；统一补 `aria-label`；AudioPlayer 的内联样式收口成 `.audio-player-close`。<br>⑥ **AgentPanel 的状态图标**从 emoji（`🔄✅❌⏹️⏳❓`）改为 icon-map 的 `StatusIcons`，`👥/🔧/💭/📁` 也换成 lucide —— 这是右侧栏里用户天天看的面板，emoji 与旁边的线性图标混在一起像「贴纸」。<br>⑦ **门禁从「逐文件白名单」改成「全仓库扫描 + 显式豁免」**（ICON-062~065）：原来 A~D 段都是点名的文件清单，所以 ConfigEditor 带着 11 处 emoji 和文字 ✕ **一直没人管**（清单里没有它）。新增：**全仓库**不得用文字 ✕/× 当按钮图标（插件除外）；迁移过的 17 个文件必须真的引入 icon-map 并调用 `ActionIcons.close/delete`（**校验产物**，不看清单）；ConfigEditor / AgentPanel 不得再有「当图标用的 emoji」（**用户数据**里的 emoji 仍允许 —— 例如 Emoji 输入框的 placeholder）。两条新门禁都用「注入回归 → 单测变红 → 还原」反验过。<br>⑧ **盘点出的待迁移清单（留给第 54 波）**：仍有 16 个组件用 emoji 当图标 —— SettingsPanel 41 处、EditorToolbar 16、GitInfoPanel 14、MultimodalPanel 13、NotebookWorkspace 11、PPTEditor 11、PPTAdapter 10、CicdPanel 8、GitEnvSettings 8、SkillManager 7、ContextMonitor 6、RecoveryPanel 6、DiffViewer 5、LayeredSettingsPanel 5、PermissionPresetSelector 5、PetMarketDialog 5。其中**大部分是 `✅/❌` 出现在结果文案里**（那是内容、不是图标），真正要换的是「独占一个文本节点的 emoji」（如 `<span>📤</span>`）与 `icon: 🎯` 这类图标数据字段 —— 这批必须逐个映射到 lucide，**不能靠正则批量替换**，所以刻意不在本波硬塞。 |
| **第 52 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **修第 51 波批量合并留下的三处 CSS 结构残骸，并把这类损坏锁进单测（规则 23 → 24 条，新增 5 条测试）**。<br>**怎么发现的**：第 51 波收尾跑 `npx vite build`，postcss 直接报 `src/styles/codem-ui.css:1466:1: Unexpected }` —— 而当时 `tsc`、4581 条单测、UI 审计（23 条规则）**全是绿的**，CSS 语法错误一条都没拦住。这也是本次的教训：**类型检查与类名审计都看不见 CSS 语法**。<br>① **三处残骸**（同一根因：合并脚本按字节偏移删块时把相邻代码一起吃掉了）：`.titlebar-action-btn` 在 `codem-ui.css` 里只剩裸声明（选择器行被吃掉）；`styles.css` 的 `@media (prefers-reduced-motion: reduce)` 浮层减动效块**声明体整块消失**，只剩 15 个以逗号结尾的选择器 —— 这意味着「减少动效」这条无障碍承诺对 15 个浮层**全部失效**（比语法错误更隐蔽，因为页面照常渲染）；`ppt-editor.css` 的 `.ppt-present-mode` 同样只剩裸声明。<br>**顺带修掉一处真实的观感 bug**：`codem-ui.css` 里那份 `.titlebar-action-btn:hover` 用的是该文件自己的 `--surface-hover`（深色半透明 `rgba(56,62,70,.80)`），而 `styles.css` 想要的是 `--bg-hover`（浅色主题暖灰）—— 后加载者胜，于是**浅色主题下标题栏按钮 hover 会变成一块深色半透明**。删掉重复定义，由 `styles.css` 权威接管。<br>② **补上能拦住这类损坏的门禁**：新增 `src/test/css-integrity.test.ts`（CSS-INTEGRITY-0~4，**不依赖 postcss**，用「注释/字符串感知的花括号深度 + 选择器形态」校验）：括号平衡、选择器列表悬挂逗号、顶层裸声明、空规则体（文档化占位与 `.lo-card--memo` 占位除外），外加一条「减动效块声明体必须还在」的定向断言。已用 4 个坏样本（正是本轮修掉的三类 + 多一个右括号）验证它会红，用 4 个合法写法（含注释占位块、跨行选择器、`repeat(2, max-content)`）验证零误报。<br>③ **修正第 51 波新规则 `css-class-cross-file` 的一处误报**：减动效块里的 `.tool-call-pill { transition: none !important }` 被算成「跨文件冲突」。条件覆盖块（`@media`/`@supports`/`@container`/`@layer`/`@scope`）是**有意的分层覆盖**，不参与「同特异度、后加载者胜」，因此规则改为只在条件块之外比对；并用注入探针反验它仍然抓得到真实冲突（注入顶层冲突 → +1 条；同一条声明放进 `@media` → 不报）。这正是第 51 波学到的「门禁必须反向验证自己会红」。<br>④ **对合并结果做独立复核**：写 `.preview-shot/lost-declarations.mjs` 对比 HEAD 与工作区，逐类核对「属性是否变少 / 整个类是否消失」。结论：11 个类的跨文件合并中，9 个「整块消失」的类都在目标文件里保留了**属性超集**（`.dialog-content`、`.popover-content`、`.settings-sidebar-item`、`.nb-dialog-close` … 用 `.preview-shot/verify-merges.mjs` 逐属性验证），两处 `grid-template-columns` 变少正是本波有意改成的 flex 行（`.nb-panel-tabs` / `.kg-toolbar`），14 个 `font-weight` 组的类也仍然声明字重 —— **没有静默丢失**。<br>⑤ **顺带查出一类更隐蔽的损坏：编码损坏（3 个样式表 87 处 U+FFFD）**。修 CSS 时发现 `skin-hub.css` 的注释读起来是 `/* 深色科技�?Hub 界面 */`，于是全量扫了一遍：`styles.css` 17 处、`skin-hub.css` 32 处、`skin-dream.css` 38 处，**全部在注释里**（无一是 `content` 字符串或选择器，所以页面照常渲染、此前谁都没发现）。成因是过去某次「用字符串改写文件」把 UTF-8 多字节汉字截断（2 字节 → U+FFFD、1 字节 → `?`）。损坏不可逆，修法是回到 git 历史里每个文件的**最新干净版本**，按「ASCII 骨架对齐 + 损坏位通配正则」逐行还原（第一批骨架对齐还原 25 行，第二批通配正则 38 行，剩 2 行英文注释按上下文补回长破折号）；还原后两道验证：① 剥离注释后**代码内容逐行不变**（只动注释）；② **换行符归一**（还原行来自 LF 的历史版本，混进 CRLF 文件会留下混合换行）。<br>⑥ **门禁 23 → 24 条**：新增 `encoding-replacement-char`（error）—— 源码里出现 U+FFFD 直接报。这类损坏 tsc、单测、其他规则都看不见，只能靠一条最朴素的规则守住；并用注入探针反验「注入 1 处 → 报 1 条」（**第一次探针报 2 条**，正好抓出我自己加规则时把调用写了两遍 —— 又一次印证「改完必须看产物，不能只看编辑器的成功回显」）。 |
| **第 51 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **排查"同类情况的第二个实例"+ 新增跨文件重复定义规则（规则 22 → 23 条）**。<br>① **用户报告的第二个实例**：另一个右侧边栏（`RightSidebar`：文件 / 浏览器）标签区同样出现滚动条。查下去发现根因和上一个不完全一样：`.right-sidebar-tabs` **在两个基础样式表里各写了一遍** —— `styles.css` 是 `overflow-x: auto`（横向滚动），`codem-ui.css` 又写了 `flex-wrap: wrap`（折行），而 `codem-ui.css` 后加载 → **两个属性同时生效**（既折行又滚动）。修法：合并成一处权威定义（不换行 flex + `overflow: hidden`），并把 `.right-sidebar-tab` 的两份定义也合并（`display: grid` vs `inline-flex` 等 6 个属性打架）。<br>② **系统排查（用户要求"排查类似的情况"）**：写了 `.preview-shot/audit-button-rows.mjs`，按三类问题扫描**所有"按钮行/标签行"**：A 横向滚动、B 固定列数网格、C `flex-wrap` 折行 —— 命中 36 处，逐条判定后修掉 6 处**容器级**问题：`.right-sidebar-tabs`（两个文件）、`.nb-panel-tabs`（3 个标签放进 2 列网格 → 必然折行）、`.kg-toolbar`（6 个控件放进 2 列网格 → 折成三行）、`.perf-tabs`、`.config-tabs`（wrap 折行）。**保留不动的**：元素内部"图标 + 文字"的 `repeat(2, max-content)`（那是对的）、动态数量的长列表（工作区标签 / Excel 工作表 / 标签墙 —— 滚动或折行是合理意图）。<br>③ **新增门禁规则 `css-class-cross-file`**：`css-class-duplicate` 只在单文件内比对，所以"同一个类在两个基础样式表里各写一遍、后加载者静默覆盖前者"一直看不见 —— 这正是本轮两个 bug 的共同根因。新规则只在基础样式表之间比对（skins 是有意的分层覆盖，排除），要求同类在同一属性上取值不同才报：**首跑 29 处，全部收敛到 0**（11 个类做了跨文件合并，另外 3 处手工对齐到设计意图：`.titlebar-action-btn` 宽高 28px → `var(--control-dense)`、`.kg-legend` 网格模板统一、`.ppt-present-mode` 层级统一到 `--z-present`）。<br>④ **又踩了一次同一个坑（值得记下来）**：跨文件合并脚本第一版"用最初解析的偏移逐个改字符串"，前面一次改写让后面全部错位 —— 一次删掉 36 个无关类、还把一个规则体写进了错误位置。改成"**先把所有替换/删除算好，再按起点降序应用**"才对（第 27 波踩过同款）。另外 `.replace(from, to)` 这种**盲串替换**又打到过别的类两次（`width/height: 28px` 与 `z-index: var(--z-top)` 在文件里不止一处）—— 教训：改 CSS 必须**按选择器定位规则块**再替换，不能用裸字符串。 |
| **第 50 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **右侧面板标签行只显示前两个（用户反馈）**。<br>现象：去掉滚动条之后，右侧面板（Git / 文件 / 变更 / 工作台 / CI·CD）只看得见 `Git`、`文件`，其余标签"换行后看不到了"。<br>**根因**：那个容器的布局是 `display: grid; grid-template-columns: repeat(2, max-content)` —— 也就是**固定两列网格**，五个标签被排成三行；过去靠横向滚动条"能滚到"，第 46 波把滚动去掉、改成 `overflow: hidden` 之后，**多出来的两行直接被裁掉**（容器高度只有 38px）。<br>**修法**：容器改成**不换行的 flex 行**（`display: flex` + `flex-wrap: nowrap`），标签按钮 `flex-shrink: 1` + `min-width: 0`（宽度不够时文字变省略号），关闭按钮 `flex-shrink: 0` 并 `margin-left: auto` 顶到最右。注意"两列网格"本身在**按钮内部**是对的（图标 + 文字两列），错的是把它用在**容器**上。<br>新增 `src/test/panel-sidebar-tabs.test.ts`（PANEL-TAB-1~3）把"标签行必须一行放完"锁成契约，断言前会先剥离 CSS 注释（否则注释里解释"曾经是两列网格"的文字会把断言自己绊倒）。<br>**顺带**：这一波和上一波（编辑器工具行折三行）是**同一个错误的两个实例** —— 把"容器排列"和"元素内部排列"混用了同一套网格模板。为此新增 `src/test/panel-sidebar-tabs.test.ts`（PANEL-TAB-1~3）把"标签行必须一行放完"锁成契约，断言前会先剥离 CSS 注释（否则注释里解释"曾经是两列网格"的文字会把断言自己绊倒）。 |
| **第 49 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **没有会话时禁用「搜索」「临时会话」（用户反馈）**：刚打开应用停在主页、还没有任何对话时，这两个动作无处可施 —— 会话内搜索没有内容可搜、临时会话也要挂在一个主会话上。<br>做法：用 `InputArea` 已有的 `noSession` 属性（由 `ChatPanel` 传 `!currentSessionId`）给两个按钮加**原生 `disabled`**（不是只把透明度调低 —— 这样点击、键盘 Enter/Space、读屏三处同时失效）；标题改成**说明原因**（"先开始一个对话才能搜索会话内容"）而不是继续显示功能名。<br>**视觉上要"看起来就是不能点"**：`.input-control-item:disabled` 降透明度 + `cursor: not-allowed`，并且**复位悬停反馈**（否则鼠标划过还会亮底，用户会以为能点）；复位规则排在 `:hover` 之后（同特异度由顺序决定胜负）。<br>**顺带修一处状态残留**：会话消失（切回主页/新建会话）时，如果搜索面板或临时会话面板还开着，会留下一个浮在主页上的空面板 —— `ChatPanel` 增加一个 effect，`currentSessionId` 为空时把两者一并收起。<br>新增 2 条测试：`noSession` 时两个按钮 `disabled` 为真、鼠标点击与键盘 Enter 都不触发回调、标题说明原因、有会话时恢复可点；外加一条 CSS 契约断言"禁用态必须复位悬停反馈 + 给 not-allowed 光标"。 |
| **第 48 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **编辑器工具行必须"一行放完"（用户反馈：被折成了三行）**。<br>现象：`【＋】` 一行、`【执行模式】【安全策略】` 一行、`【搜索】【临时会话】` 一行。<br>**根因是第 42 波改错了对象**：那一波把 72 处 `flex-wrap` 的**标签墙**改成 `repeat(auto-fill, minmax(…, max-content))` 网格，其中顺手把 `.input-tools-left` 也一起改了 —— 但那是"工具行"而不是"标签墙"：auto-fill 的**列数**由"容器宽度 ÷ 最小列宽（40px）"推出来，而带文字的 chip（执行模式 / 安全策略 / 临时会话）远比 40px 宽，轨道被撑大后，后面的 chip 就被挤到下一行。<br>**修法**：这条行改回**不换行的 flex 行**（`display: flex` + `flex-wrap: nowrap`），并且：① 图标型按钮与浮层锚点 `flex: 0 0 auto`（压它们只会把图标裁掉）；② 带文字的 chip 允许压缩（`min-width: 0` + 省略号），窄窗口下是"文字变省略号"而不是"折行"；③ 计划模式 chip 加具名类 `.plan-mode-chip` 以获得同一个压缩钩子；④ 因为整行 `overflow: hidden` 会裁掉外扩焦点环，行内控件的键盘焦点改走 **inset 环**（沿用第 39 波处理"会裁切容器"的同一套做法）。<br>**教训**：批量改造（第 42 波那种"按选择器形状批量替换"）必须**按语义分组复核** —— 同一段 CSS 形状（flex + wrap）里，"标签墙"和"工具行"的意图相反：前者希望折行均匀，后者必须始终一行。新增 CSS 契约测试断言这条行是 `flex + nowrap`、且不再是 auto-fill 网格。 |
| **第 47 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **三处用户反馈的修复**。<br>① **顶部状态栏空白区拖不动窗口**：第 43 波把拖拽交给专用 `.titlebar-drag-region` 时，用了一条 `.titlebar > * { position: relative; z-index: 1 }` 把**整组容器**抬到拖拽区之上 —— 而 `.titlebar-left` 与 `.titlebar-nav-actions` 都是 `flex: 1`，会撑满中段，于是"执行模式按钮右边到中间那段空白"被容器盖住、拖不动。改成只抬**真正可交互的元素**（`button` / `a` / `input` / `[role]` / 菜单栏 / 标签条 / 窗口按钮），容器保持 static，空白处重新落回拖拽区；同时去掉 `.titlebar-nav-actions` 上遗留的 `-webkit-app-region: drag`（容器整段可拖会把两件事搅在一起）。<br>② **右侧栏 tab 区出现滚动条**：那个面板是 `PanelSidebar`（Git / 文件 / 变更 / 工作台 / CI·CD），标签栏此前是 `overflow-x: auto` + 3px 滚动条 —— **按钮区不该有滚动条**。新增 `--panel-sidebar-width` 令牌并把面板 **420 → 520px**（一行放得下 5 个 tab + 关闭按钮），标签栏改 `overflow: hidden`、按钮允许压缩（`flex-shrink: 1` + `min-width: 0`）、标签文字带省略号，并删掉滚动条样式。<br>③ **侧栏「项目 → 更多操作」菜单是 emoji 图标**：图标其实藏在 **i18n 文案**里（`"📌 置顶项目"` / `"📂 文件浏览器"` / `"📁 在文件管理器中打开"` / `"🗑️ 移除项目"`），所以组件里只看到纯文本。做法：文案去 emoji，组件改渲染 lucide 图标 + 文字的**两列 grid**（图标列定宽 → 跨行对齐），"移除项目"用 `--error` 色（与别处危险项同一语言）。<br>④ **顺带清掉同类问题**（同一轮发现的 emoji 图标）：子智能体类型图标（`AgentDetail` / `AgentPanel` 的 `getAgentIcon` 返回 emoji → 改为返回 lucide 组件，容器从 `font-size` 改成定宽居中盒）、必需工具的 🔒 标记与说明文案、消息里「清理过程文件」按钮与「仅移除项目」对话框按钮；聊天**内容**里的 ✅/❌ 属于模型输出，不在清理范围。<br>⑤ 新增 3 条测试锁住（`ICON-053~055`：侧栏菜单用 lucide + i18n 文案不含 emoji、子智能体图标返回组件、必需工具用 `Lock`）。 |
| **第 46 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **① 按钮搬家（用户直接提的）**：「搜索当前会话」「临时会话」从**会话头部**移到**编辑器底部工具行**（与执行模式 / 安全策略同一行）的最右边。理由不是"腾地方"，而是**分类**：头部那一排是会话级状态与视图切换（标题 / 模型 / 智能体 / 快照 / 上下文 / 轨迹），而这两个是**输入辅助动作**（在输入区里找东西、开一个不污染主会话的侧会话），与同一行的执行模式、安全策略是同一类。做法：`ChatPanel` 不再渲染这两个头部按钮，改把 `onToggleSearch` / `searchOpen` / `onToggleSideSession` / `sideSessionOpen` 传给 `InputArea`，由它在 `.input-tools-left` 末尾渲染两个 chip —— **样式直接复用该行的 `.input-control-item`**（与安全策略同一个类，所以"看起来就是这一行的东西"），按压态由 `aria-pressed` 驱动（第 32 波「状态属性驱动样式」的约定，不另造 `.active` 类），并给 `[aria-pressed="true"]` 补了一层 accent 淡底（原来只有描边变色，面板打开时不够显眼）。**新增 2 条渲染测试**断言"在底部工具行里且用同一个类"——只测"能点"的话，把它们挪回头部测试依然全绿。<br>② **补上第 44 波的门禁规则注册事故**：`css-class-unused` 第 44 波只在扫描器里写了函数与 `add()` 调用，**`RULES` 表里那条登记没写进去**（接线脚本用 `includes("css-class-unused")` 自检，而新加的注释里就有这个词 → 自检通过、实际没登记）——后果是这条规则的发现既不算 error 也不算 warn，等于**没生效**。现已登记，并把这轮发现的 42 条死规则一并删除。<br>③ **修掉两处假阳性**（都是这轮才暴露出来的）：**动态拼接守卫缺少左边界** —— 前缀 `sp-` 会命中 `resp-${Date.now()}` 里的 `sp-${`，导致所有 `.sp-*` 类都被当成"可能动态拼接"而不敢删；**语料范围搞错** —— 规则用 `listFiles(src)` 读语料，而它带着 `EXCLUDE_DIRS`（跳过 `test/`）与 `EXCLUDE_FILE_RE`（跳过 `*.test.ts`），于是"只在测试里被断言过的类名"被误报成死类名（`.no-transition` 就是这么被报出来的）；`readClassCorpus()` 现在只跳过 node_modules/dist/target/.git，把测试也算作使用证据。<br>④ 结果：死类名 **110 → 79（2.4%）**，`tsc` / 202 文件 4572 测试 / build / 22 条门禁规则全绿。 |
| **第 44 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **死类名清理（258 → 110）+ 新门禁规则 `css-class-unused`**。<br>① **规模**：`.preview-shot/dead-classes.mjs` 早在第 38 波就量出「3396 个顶层类名里 258 个（7.6%）从未被 TSX/TS 使用」，当时不敢批量删（怕是动态拼接）。第 44 波把判定做严后两趟删除 **223 条规则**：整族死掉的有 `composer-*`（22）、`code-block-*`、`native-title-bar-*`（13）、`right-rail-*`（10）、`hub-*`、`fullscreen-viewer-*`、`nb-guided-questions` 族、`lo-mini-scene` 族等。<br>② **两个教训（都值得写进流程）**：**"动态拼接"守卫不能只看前缀本身** —— 第一版用 `code` / `hub` / `tool` / `table` 这类短词做前缀匹配，撞上语料里的普通文本（`code + 1`、`tool" + ...`），于是成片真死类名被误判成"活的"，第一趟只删掉一半；改成"前缀必须以 `-` 结尾"（只认 `` `nb-${x}` `` 与 `"lo-" + name` 这两种真正的类名拼接）后才准。**减动效媒体块是"安全网"，清理脚本必须认得出** —— 第一趟误删了 library-ops 的减动效规则（那些类名是 SVG 子部件、不在 TSX 里），当场被 `motion-uncovered` 抓住并回滚：**门禁不只管别人，也管清理脚本**。<br>③ **门禁**：新增 `css-class-unused`（warn，只降不升的棘轮）。它刻意保守：带 `[属性]` 的规则不判、减动效/减透明媒体块跳过、动态前缀不判、**要求整条规则的所有类名都死**才报 —— 因此残下的 110 个（都在"与活类共存的选择器"里，如 `.run-status-bar.phase-thinking` 这类修饰类）它不报：删那些要人工逐个确认，收益小风险大，暂不再动。<br>④ 验证：`tsc` / 201 文件 4566 测试 / build / 22 条门禁规则（error 0 / warn 0）全绿。 |
| **第 43 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **工具条拖拽安全区（对齐参考实现的外壳结构）**。<br>此前是"整条 `.titlebar` 可拖 + 每个交互元素各自 `no-drag`"：漏一个就按钮点不动、多一个就没地方拖窗口。参考实现反过来 —— 容器不拖，中间放一条**专用拖拽区**，左右各留安全区。<br>① 容器改 `-webkit-app-region: no-drag`；新增 `.titlebar-drag-region`（绝对定位、`z-index: 0`），左右 inset 由安全区令牌决定：`--chrome-safe-left`（mac 76px 给红黄绿灯；Windows/Linux 只留一点边距）、`--chrome-safe-right`（Windows 三个窗口按钮宽度；mac 由系统控件自己占），mac 平台加 `.titlebar--mac` 切换。<br>② 拖拽区是绝对定位元素、会盖住静态兄弟节点 —— 因此补 `.titlebar > * { position: relative; z-index: 1 }`：**内容点得动、它们之间的空白仍然拖得动**。<br>③ 去掉子元素上多余的 `data-tauri-drag-region`（父级已 no-drag，留着会让标题文字区变成可拖）。<br>④ 标签条末尾补"新建对话"按钮（`.titlebar-add-tab`，参考实现 `.mac-window-add-tab` 同构）：标签条正是用户"想再开一个"时视线所在处，虚线边表示"还能加"、悬停转实线 + 强调色 —— 加它时门禁 `css-class-undefined` 先报了"类名没样式"，规则在正常工作。<br>⑤ **踩坑**：脚本的守卫写错了 —— 注释里先出现了 `.titlebar-drag-region` 字样，`if (!s.includes(...))` 直接为假，规则被静默跳过；改成按"是否存在真正的规则块"判断。 |
| **第 42 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **标签墙/选项墙改 auto-fill 网格（grid 275 → 305，原始目标达成）**。第 37 波铺完第一档（子元素数固定的行）后，`display: grid` 停在 275、离参考实现（574）还有一段。这一轮挑的是**另一类真实收益**：`flex-wrap` 的标签/选项/状态墙（全项目 72 处）—— flex 换行会让**最后一行宽度参差、标签左右边缘对不齐**，而 `repeat(auto-fill, minmax(<min>, max-content))` 让标签按列对齐、换行后依然整齐；用 `max-content` 而不是 `1fr` 是关键，否则短标签会被拉宽变形。<br>落地 29 处：`mcp-catalog-tags` / `mcp-detail-tags` / `skill-detail-tags` / `memory-detail-tags` / `mcp-server-tools` / `identity-emoji-grid` / `bootstrap-emoji-grid` / `identity-options` / `bootstrap-options` / `pending-attachments` / `issue-detail-meta` / `nb-tag-filter` / `nb-note-tags` / `nb-source-topics` / `kg-legend` / `ppt-studio-filters` / `ppt-studio-stages` / `decision-tray-options` / `wx-status-row` / `wx-actions` / `agent-checks` / `flashcard-toolbar` / `input-tools-left` / `tool-group-body-inline` / `lo-chip-row` / `lo-filter` / `lo-task__bar` / `lo-zone-occupants` / `lo-align`。<br>**结果**：`display: grid` **275 → 305**（`grid-template-columns` 276 → **301**），`display: flex` 959 → **932**；`tsc` / 201 文件 4566 测试 / build / 21 条门禁规则全部通过。<br>**顺带**：把上一步脚本插到 `display` 之前的 `grid-template-columns` 声明顺序整理回"显示 → 模板"（声明顺序不影响生效，但读起来应该按语义顺序）。 |
| **第 41 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **应用外壳：应用级菜单栏 + 窗口 chrome（B 组第 5 项，A/B 两组到此全部落地）**。<br>① **诊断**：参考实现的"产品感"有很大一部分来自窗口外壳 —— mac 风格工具条（50px + 专门的拖拽安全区 + 独立动作栏 + 带遮罩渐隐的标签条）加一套**应用菜单**（`.app-menu-surface` 10px 圆角 / 30px 菜单项 / 14px 图标 1.8 描边）。我们此前只有一排图标按钮 —— 能点，但**没有可读的命令名**：用户不知道有哪些功能、也看不到快捷键。这正是"项目级 vs 产品级"最直观的差别之一。<br>② **新增 `AppMenuBar`**（纯自研，不引第三方菜单原语）：文件 / 视图 / 帮助三组，只放**真实可用**的命令（新建对话 / 搜索 / 设置 / 关闭窗口 / 切换侧边栏 / 切换终端 / 切换主题），**不放灰掉的假项**。ARIA 与样式同源（`role="menubar"/"menu"/"menuitem"` + `aria-haspopup` + `aria-expanded` + `aria-keyshortcuts`，展开态样式挂在 `[aria-expanded="true"]` 上）；键盘完整可用：↓/Enter 打开并聚焦首项、↑↓ 项间循环、←→ 换菜单（展开态）、Home/End 跳首尾、Tab/Esc 关闭且 Esc 把焦点交回触发器、点击别处关闭。**8 条行为测试**（`src/test/app-menu-bar.test.tsx`）—— 菜单栏的价值一半在键盘，而键盘回归肉眼看不出来。<br>③ **chrome 尺寸与细节**：新增 `--chrome-height` 令牌并把外壳从 36px 提到 **44px**（36px 里塞 26px 控件，上下只剩 5px 余量 —— 这是"贴边感"的来源）；动作栏按钮统一 30px 固定高度（原为 padding 撑出）；标签条加**两端渐隐** `mask-image`（参考实现的同一细节，滚动内容不再硬切）。<br>④ 写遮罩时直接写了 `#000` 被颜色规则拦下 —— 新增 `--mask-opaque` 令牌（mask 只看 alpha，颜色本身无意义，令牌化顺便把这件事写清楚）。<br>⑤ **踩坑记录**：焦点进菜单不能靠 `requestAnimationFrame`（菜单是条件渲染的，DOM 时序不可控，在测试与慢机器上会闪失）—— 改成"记一个待聚焦项 + 用 `useEffect` 在渲染完成后聚焦"。 |
| **第 40 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **减动效覆盖 + 动效降噪（门禁规则 20 → 21 条）**。<br>① **起点**：60 条 `infinite` 动画里只有 35 条被显式关停，而且关停清单是**类名模式匹配**（`[class*="-spin"]`、`[class*="-pulse"]`）—— `.spinning` / `.thinking-text` / `.activity-dot.active` / `.session-running-dot` / `.boot-splash-logo-icon.pulsing` / `.ppt-studio-orb` / `.lo-icon-btn.is-busy` 这些名字里不含这两个片段的全部漏网；更强的漏洞是**全局兜底对它没有意义**：`animation-duration: 0.01ms` 只会让循环动画瞬间跳到最后一个关键帧。<br>② **做法**：先把 60 条 infinite 逐条列出来核对，关停清单改成**显式选择器清单**；每个自带动画的样式表**自己兜底**（`codem-ui.css` / `notebook-workspace.css` / `game.css` / `pet-window.css` / `library-ops.css`）—— 组件级 CSS 可能被单独加载，不能假设 `styles.css` 一定在；全局兜底补上 `animation-delay` / `transition-delay` 归零，并删掉与文件末尾**逐字重复**的那份兜底块。<br>③ **宠物窗口是独立入口**（`pet-main.tsx` 只加载 `pet-window.css`）：此前它既没有减动效兜底、也没有焦点环，现已补上（焦点环带令牌兜底，因为这个入口下令牌可能未定义）。<br>④ **CSS 管不到的那一半**：新增 `src/hooks/useReducedMotion.ts`，让宠物精灵的 rAF 逐帧切换与图书馆场景的相机缓动/逐帧推进在该偏好下短路 —— 这是全仓库**第一处** `matchMedia('(prefers-reduced-motion…)')`。<br>⑤ **降噪**：删掉背景光斑的无限漂移（25s/30s/20s 交替，纯装饰、零信息量，却让界面永远在动）与死掉的 `@keyframes streaming-dots`；游戏插件的 `pulse` 改名 `mnp-pulse`（此前与 `styles.css` 同名 kf 冲突，插件 CSS 最后加载会**静默顶掉**宿主定义）。<br>⑥ 新增门禁规则 `motion-uncovered`：跨文件比对"每条循环动画是否都有显式关停"，现在 57 条全部覆盖。 |
| **第 39 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **焦点可见性收口（把"焦点"当独立课题查一遍，门禁规则 18 → 20 条）**。<br>① **根因不是"缺环"，而是"有环却被抑制"**：项目其实有 3 条全局焦点环规则（`codem-ui.css` 的 `*:focus-visible` 与原生控件规则、`styles.css` 里 (0,3,0) 的 `:is(a,button,[role=button],summary,[tabindex]):focus-visible`），但 **21 条组件规则写了 `:focus { outline: none }`**，特异度高于全局规则 —— 其中 4 条是 `<select>`，而全局规则里恰好没有覆盖 select，于是这些控件的键盘焦点**彻底不可见**；另有 **14 处 TSX 内联 `outline: 'none'`**，内联优先级高于所有非 `!important` 规则，连 `[tabindex]:focus-visible` 的 (0,3,0) 环都被吃掉（幻灯片画布 `div[tabindex=0]` 正是如此）。两类全部删除。<br>② 全局输入控件的焦点环从 `color-mix(accent 22%)` 的软环提到令牌强度（`--focus-ring-color`，75%）；会给容器裁切的场景改用 **inset 环**（工作区标签栏 / PPT 缩略图栏 / 面板侧栏标签 / 幻灯片画布 / 文件树 / 图谱节点）—— `overflow` 非 visible 的那一侧会**双向**裁切，外扩环必然被切掉。<br>③ **两处"键盘根本到不了"**（比"焦点看不见"更严重）：文件树条目 `.file-entry` 与图谱节点 `.kg-node` 都是不可聚焦的 `div` —— 补 `role`/`tabIndex`/`aria-selected`/Enter-Space（图谱节点用"派发一次 click"复用鼠标路径，不必给节点 data 加字段）。<br>④ 新增门禁规则 `focus-outline-none`（焦点规则里 `outline: none` 且无替代环）与 `inline-outline-none`（TSX 内联抑制）；写规则时又把**文档里的反例**当成真规则误报了一次 —— 已让规则解析先剥离注释（保留换行以免行号错位）。<br>⑤ **同口径实测已超过参考实现**：`:focus-visible` 规则 490 vs 57、带环规则 22 vs 21、`outline:none` 抑制 5 vs 19（详见 §5 后的对照表）。 |
| **第 36 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **默认档位改为浅色暖中性 + 首屏不再闪（B 组第 6 项）**。<br>① 问题有两层：**默认档位**（`--bg-primary` 是 `rgba(14,15,15,1)` 近黑）和**散落的默认值**（`|| "dark"` 在 TitleBar / SkinSelector / CodeBlockView / ThemeManager 各写一遍，改默认要同时改五处），外加**首屏闪烁**（`index.html` 里没有 `data-theme`，浏览器先按 `:root` 的暗色渲染一帧再等 JS 切，浅色用户每次启动都闪黑）。<br>② 做法：CSS 侧 `:root, [data-theme="light"]` 变成浅色档、`[data-theme="dark"]` 是显式覆盖（两档令牌从此**完全对称**，此前 light 块只覆盖 49/76 个令牌，`--highlight-top` 等 22 个在浅色下一直沿用的暗色值）；色板从冷蓝灰（GitHub 那套）换成**暖中性**（画布 `#fcfcfb`、卡片 `#f5f5f3`、文字 `#1f1f1e`、线 12%/7% 黑），并补齐浅色档缺失的 `--highlight-top*`（暗色下是"白 5% 透光"，浅色下必须是实白，否则面与面没有厚度差）。<br>③ 代码侧新增唯一真相源 `src/core/theme/theme-default.ts`（`DEFAULT_THEME` / `isThemeMode` / `applyThemeAttribute` / `cacheTheme`），四处 `|| "dark"` 全部改为读它；换档时写 localStorage 镜像，`index.html` 加一段内联脚本在首屏渲染前读镜像设属性 —— **两个方向都不再闪烁**（SQLite 的 `codem-theme` 仍是真相源，镜像只是"首屏预测"）。<br>④ 顺带修掉自己造的两处违规（`--shadow-raise-*` 在重写主题块时被漏掉、注释里写了原始色值触发了颜色规则）——**门禁规则又一次抓住了我自己的手误**。 |
| **第 37 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **grid 对齐原语铺到"重复行"层（225 处）**。先用只读分析把全项目 1184 处 `display: flex` 分级：**第一档 226 处**（子元素数固定 2–4、已有 `gap`、无 `flex-wrap`、无 `space-between` 依赖、无子元素依赖父级 flex 分配），第二档 88 处（子元素数随状态变化或 ≥5），第三档 19 处（`space-between` 语义 / 自身被外部 `flex: 1` 撑宽），**明确不该改** 638 处（315 处 `column` 堆叠 + 75 处 `flex-wrap` + 124 处 TSX 里找不到对应类 + 243 处"行但无 gap"—— 无 gap 的行换成 grid 间距仍是 0，**没有对齐收益**，而且顺手补 `gap` 会叠成双倍间距）。<br>按第一档清单做**成对替换**（`display: flex` → `display: grid` + 一行 `grid-template-columns`，脚本 225 处落地，1 处多选择器规则人工跳过）：列模板按子元素数取 `max-content minmax(0, 1fr)`（2 列）/ `… max-content`（3 列）/ `… max-content max-content`（4 列），动作簇与工具条取 `repeat(N, max-content)` 以保持整簇宽度不变。<br>**结果**：`display: grid` 50 → **275**、`grid-template-columns` 53 → **278**（参考实现分别是 574 / 320，已在同一量级）；`display: flex` 1184 → **959**。收益是**标签、图标、数值跨行对齐成竖线** —— 这正是"精致"最直接来源，而 `flex` 的 `justify-content` 做不到跨行对齐。 |
| **第 38 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **`:has()` 父级状态铺开（7 → 41 处，与参考实现持平）+ 死类名普查**。<br>① **每条 `:has()` 都先核对 TSX**：写了 `.preview-shot/verify-has.mjs`（把「祖先类名 → 后代特征」在 TSX 里逐条验证），一次就把两条**本来会写成死代码**的规则拦下来 —— 容器类名写成不存在的 `.tool-pill`（真实类名是 `.tool-call-pill`）、以及第 32 波文档里点名的 `.sp-field-row` **全项目没有任何 TSX 使用**。核对通过后落地 34 条规则：选中态外显（`.sp-check` / `.sp-row` / `.git-env-field` / `.agent-check-label` / `.wx-list-row` / `.mode-option` / `.pm-radio` / `.todo-item` 的"勾选→整行高亮"）、禁用态整行淡化（`.mcp-form-row:has(:disabled)`）、运行/失败竖条（`.tool-call-pill:has(.tool-pill-icon-spin)`、`.tool-card:has(.tool-card-status--error)`）、焦点父级环（焦点在子控件、环画在整行上）、已完成项淡化 + 删除线。<br>② **顺手修掉两处"写了但没作用"**：`.tool-card` / `.tool-call-pill` 都没有 `position: relative`，状态竖条用 `::before` 绝对定位会锚到更外层容器；另外 `.tool-call-pill` 的展开态此前**没有 `aria-expanded`**，于是第 32 波写的 `[aria-expanded="true"]` 样式永远是死的 —— 补上属性（连同 `tabIndex` 与 Enter/Space 键盘展开），样式与读屏语义同时到位。<br>③ **死类名普查（新维度：`css-class-undefined` 的镜像）**：那边查"用了没定义"，这边查"定义了没人用"。`.preview-shot/dead-classes.mjs` 量出 **3396 个顶层类名里 258 个（7.6%）在 TSX/TS 里从未出现**（`composer-*` 整族、`nb-guided-questions` 族、`ppt-*` 族、`sidebar-*` 若干）。本轮**不批量删除**（部分可能是动态拼接的前缀，误删风险大于收益），但把脚本与数字记进 §7：这是一个"该有但没量过"的队列。 |
| **第 34 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **"局部细节"三件事：图标刻度 / 圆角令牌 / 状态小块（门禁规则 15 → 17 条）**。用户点名怀疑"是菜单栏、字体、间距、状态背景色、图标？"—— 于是把这五项**各自量化**（`.preview-shot/five-dims.mjs`，两侧同口径）。结论：间距与状态色**我们的做法不比它差**（间距全部令牌化、状态色有语义淡底；它反而是 8px/10px/12px 写死 + `rgb(x x x / a)` 中性 alpha），真正拉开差距的是 **图标与圆角这两处"局部细节"**。<br>① **图标尺寸不在刻度上（149 处）**：实测 `size={14}`×270、`12`×204、`16`×172 是主力，但旁边还散着 `13`×46、`18`×45、`11`×26、`15`×23、`9`×3、`8`×3、`26`×1、`28`×2 —— 同一行里 13px 与 14px 图标并排、18px 关掉按钮挤着 16px 图标，**视觉节奏被这些 ±1~2px 打散**。全部按 13/15→14、11→12、17/18→16、19/21→20、22/25/26→24、28→32、8/9→10 吸附（参考实现的图标尺寸集中在 15px 一档，同样只用一个刻度）。新增规则 `icon-size-offscale` 锁住（排除画布/图表/头像/抽屉这类"size 不是图标刻度"的组件）。<br>② **圆角阶梯是倒的，且 700 处绕过令牌**：`--radius-xs` 竟是 8px、比 `--radius-sm` 的 4px 还大（命名与大小相反），而 CSS 里躺着 `4px`×124 / `6px`×113 / `8px`×76 / `12px`×24 / `10px`×18 字面量、TSX 内联样式里另有 `4/6/8/10/12/14` 共 208 处 —— 它们**都能通过 `radius-offscale`**，却让"改一个令牌、全局圆角一起动"彻底失效。本轮：阶梯改成严格单调（xs 4 / sm 6 / radius 8 / md 10 / lg 14 / **新增 xl 20** / full 9999），**381 处 CSS + 208 处 TSX 字面量收回令牌**（映射到同值或最近档，视觉变化 ≤2px），原本 84 处 `var(--radius-xs)`（当时=8px）迁到 `var(--radius)`（零变化），并去掉 88 处**过时/写错的兜底**（`var(--radius-sm, 4px)` 已经是旧值、`var(--radius-md, 8px)` 干脆是错的）。新增规则 `radius-raw`。**插件侧例外**：插件 CSS 保留 `var(--radius-md, 10px)` 带兜底写法（插件必须能脱离宿主独立渲染，`LO-ICON-5` 测试正是这条契约，本轮被它当场抓住一次）。<br>③ **状态小块只做了一半**：§2.3 早写明"文字色 + 同色淡底 + 同色淡边"，实测 47 处里只有 26 处带淡底 —— `running`/`done`/`exit 1`/`已安装` 只是一行有颜色的字。补统一形状，且淡底淡边全部 **`currentColor` 派生**：状态修饰类只给 `color`，底与边自动同源，以后新增状态不用再抄 `color-mix`。<br>**下一步结构性差距**（已量、未做）：`display: grid` 50 vs 参考 574、`:has()` 7 vs 41、`prefers-reduced-motion` 8 vs 27 —— 这三项是"对齐原语"层面的差距，见 §7 A 组。 |

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

---

## 7. 交接快照（2026-09-10 · 第 45 波后）

### 当前数字（`node tools/ui-audit/scan-ui.mjs`）

| 规则 | 级别 | 起点 | 现在 |
| --- | --- | --- | --- |
| `fs-hardcoded` | error | 78 | **0** ✅（门禁锁定；第 12 波起**同时覆盖 CSS**） |
| `zindex-raw` | error | 205 处写死值（第 27 波首次量） | **0** ✅（97 处归位到 14 个 `--z-*` 令牌；余下 <100 的是组件内局部层叠，规则明确允许） |
| `spacing-raw` | error | 2906 处数值间距（第 28 波首次量） | **0** ✅（2354 处令牌化 + 60 处 2px 网格归并；余下仅 1px/0.5px 细线与动态值） |
| `radius-raw` | error | 589 处圆角字面量（第 34 波首次量：CSS 381 + TSX 208） | **0** ✅（全部收回 `--radius-*`；插件 CSS 的带兜底写法按契约放行） |
| `icon-size-offscale` | error | 149 处离刻度图标尺寸（第 34 波首次量） | **0** ✅（吸附回 10/12/14/16/20/24/32/48 八级） |
| `css-class-duplicate` | error | 18 类 / 35 条冲突（第 27 波首次量） | **0** ✅（按"后者胜出"合并回一处，保留声明顺序） |
| `css-var-undefined` | error | 96（第 26 波首次对账） | **0** ✅（第 26 波新增规则；含 `--font-mono` 24 处无兜底这类"声明整条失效"） |
| `color-hardcoded-ts` | error | 29（第 26 波首次对账） | **0** ✅（第 26 波新增规则：`style={{}}` 之外的状态色表/主题常量/JS 改样式） |
| `svg-attr-var` | error | 5（第 26 波首次对账） | **0** ✅（第 26 波新增规则：`stroke="var(--x)"` 在属性位置无效，图形会不画） |
| `radius-offscale` | error | 38 | **0** ✅（门禁锁定；第 13 波起覆盖 `styles.css` 本体，不需豁免） |
| `color-hardcoded-tsx` | error | 325 | **0** ✅（第 17 波起与 CSS 侧同款精度：按字面量位置排除 `var()` 兜底值） |
| `color-hardcoded-css` | error | 209 | **0** ✅（第 13 波起**连 `src/styles.css` 本体一起覆盖**，无豁免） |
| `modal-shell-bespoke` | error | 15 | **0** ✅ |
| `font-stack-raw` | error | 31 种字体栈写法 / 192 处声明（第 35 波首次量） | **0** ✅（收敛成 `--font-ui` / `--font-mono` / `--font-display` 三档） |
| `focus-outline-none` | error | 21 处「`outline: none` 却没有替代环」（第 39 波首次量） | **0** ✅（全部交回统一焦点环令牌） |
| `inline-outline-none` | error | 14 处内联 `outline:'none'`（第 39 波首次量） | **0** ✅（内联会吃掉全局焦点环） |
| `motion-uncovered` | error | 60 条 `infinite` 动画里 25 条没有显式关停（第 40 波首次量） | **0** ✅（跨文件比对，每条循环动画都有 `animation: none` 关停） |
| `css-class-cross-file` | error | 29 处跨文件取值冲突（第 51 波首次量） | **0** ✅（合并成一处权威定义；条件覆盖块不算冲突） |
| `encoding-replacement-char` | error | 87 处 U+FFFD 编码损坏（第 52 波首次量） | **0** ✅（从 git 历史还原注释文本，并加规则防复发） |
| `spacing-offgrid` | warn | 13 | **0** ✅ |
| `legacy-popup-shell` | warn | — | **0** ✅ |
| `css-class-unused` | warn | 258（第 44 波首次量） | **0** ✅（两趟共删 223 条规则 + 后续收尾） |
| `css-class-undefined` | warn | — | **0** ✅（第 10 波清零、审计器扩面到模板字面量；**第 26 波起去掉「同行有内联样式」的豁免**，去掉后又清出 29 个空壳类名） |
| `inline-style-dense` | warn | 58 | **0** ✅（第 14 波先修正了度量口径 50 → 25，再累计收口 25 个文件；最后一块 `SettingsPanel` 999 → 0） |
| **error 合计** | | **533+** | **0** ✅（19 条规则） |
| **warn 合计** | | 64 | **0** ✅（5 条规则） |

> 注：`color-hardcoded-tsx` 中途曾报 53 → 9 —— 不是"改多了"，而是审计器修掉了假阳性（见第 11 波说明）。
> `fs-hardcoded` 第 12 波一度报 590 —— 也不是"变差了"，而是审计器**首次开始扫 CSS 侧**（此前 591 处写死的字号
> 因为 `src/styles.css` 整份被排除而完全不可见）。
> 第 13 波把 CSS 侧判定从「整行」改到「逐字面量」后，又冒出 12 行混写色值与 4 处离格圆角 —— 同样是
> **工具看不见**而不是"新问题"，修完才真正归零。
> `inline-style-dense` 第 14 波 50 → 24 是**度量口径修正**（只数样式对象内部），不是重构成果；
> 重构成果是那之后的 8 个文件（RecoveryPanel 149 → 0、FlashcardViewer 139 → 0、SquadsTab 176 → 0、
> IssueDetailPanel 133 → 0、AutomationTab 134 → 0、LayeredSettingsPanel 141 → 0、UsageStats 128 → 0、GitEnvSettings 172 → 0）。
> 第 17 波同理：`color-hardcoded-tsx` 0 → 18 → 0 不是"改坏了又改回来"，而是**审计器终于能看见条件分支里的色值**。
> 第 21 波又发现一类同类盲区：**同行有内联样式的元素，其类名不会被 `css-class-undefined` 判定**
> （规则本意是"有内联样式就不算没样式"）—— 于是 `.trajectory-panel` 这种"写了但 CSS 里根本没有"的假钩子
> 一直藏在审计视野外；把内联样式搬进 CSS 后，它才浮出水面。收口内联样式的过程会持续暴露这类空壳类名，
> 每波都要顺手补定义（或删掉死类名）。
> 第 22 波补掉的是色值规则的最后一处：兜底只认「整个字符串就是一个 hex」。`border: "1px solid #ef444455"`
> 与 `linear-gradient(135deg,#6366f1,#8b5cf6)` 这类**复合值里的 hex** 因此长期不可见（改完立刻报出 12 处）。
> 三次修复（第 11 波行→字符、第 17 波整行→逐字面量、第 22 波单值→复合值）说明同一件事：
> **"计数为 0"要先能证明"工具看得见"，否则只是没看见。**
> 第 24 波补掉的是最后一处同类盲区：**匹配到 ≠ 报警过** —— 用"本行有没有属性级匹配"决定要不要走兜底，
> 于是一行里只要出现一个无害匹配（`background: "transparent"`），后面的兜底全部跳过。
> 至此色值规则的判定链才完整：行区间 → 逐字面量 → 复合值 → 命名色 → rgb() → 短路修复。
> 第 25 波把计数打到 0 之前，用 `--inline-counts` 逐个文件确认过「每个文件都真的降到 0 附近」，
> 而不是"刚好压到 119"。
> **第 26 波是这句话的续集**：门禁 9 条规则全绿之后，用三个**独立对账脚本**
> （`.preview-shot/check-missing-vars.mjs`、`check-empty-classes.mjs`、`check-outside-style.mjs`，
> 都不看审计结论、直接自己对账）重新核了一遍，又清出 96 处未定义令牌引用、29 个空壳类名、
> 29 处 `style={{}}` 之外的硬编码色，外加一类新盲区（`var()` 写在 SVG 表现属性里 → 属性失效、图形不画）。
> 规则数 9 → 12。**教训写死在这里：计数为 0 只说明"当前这把尺子量不到"，换一把尺子还得再量。**

### 已完成的波次

1. **规范落地**：按 frakio-work 实测规范写成本文件（令牌契约 + 组件语言 + 门禁 + 例外表）。
2. **机具**：`scan-ui.mjs`（9 条规则 + `--census/--json/--rule/--write-baseline`）、`codemod-tokens.mjs`（令牌化改写，默认 dry-run，只动 `style={{}}` 与 CSS）、`codemod-icon-scale.mjs`（图标工具类 → `--icon-*` 刻度）、`codemod-css-fs.mjs`（CSS 字号 → `--fs-*`）、`codemod-css-colors.mjs`（CSS 色值 → 语义令牌，含命名色与 `var()` 兜底值按位置排除）。
3. **第 1 波**：478 处令牌化（色 409 / 圆角 32 / 字号 37）→ `fs-hardcoded`、`radius-offscale` 清零。
4. **第 2 波**：84 处淡色底边 → `color-mix(in srgb, var(--token) N%, transparent)`。
5. **补令牌**：`--fs-2xs`(11) / `--fs-display`(28) / `--fs-hero`(32) / `--overlay-backdrop(-strong)` / `--space-1..12` / `--radius-xs`(6px) / `--shadow-color(-soft)` / `--backdrop-black` / `--surface-content` / `--terminal-bg/-fg` / `--window-close-*` / `--mac-btn-*` / `--skin-preview-*` / `--icon-2xs..--icon-3xl` / `--pet-*`。
6. **门禁**：`src/test/ui-consistency.test.ts`（逐规则对比基线，只降不升；字号/圆角必须保持 0）。
7. **补样式**：Pipeline 下一步对话框、纠偏结果对比面板（此前类名无 CSS = 没样式）。
8. **间距归一**：`spacing-offgrid` 13 → 0（只对齐离格值，±1px）。
9. **CSS 色令牌化**：31 → 17（遮罩/底色/状态淡色）。
10. **第 10 波**：图标刻度 + 253 处「有类名没样式」清零（详见 §5 表）。
11. **第 11 波**：色值 70 处（CSS 17 + TSX 53）→ 0；15 处自建浮层 → 统一外壳；审计器精度修复（详见 §5 表）。
12. **第 12 波**：宿主样式表纳入审计 + 592 处字号令牌化（详见 §5 表）。
13. **第 13 波**：`styles.css` 的 249 处色值 + 22 处离格圆角 → 令牌，该文件的例外彻底删除；审计器补掉命名色与"整行放过"两处盲区（详见 §5 表）。
14. **第 14 波**：内联样式收口开工 —— 修正 `inline-style-dense` 的度量口径（50 → 25 个文件）、定义闭集共享具名类、`RecoveryPanel` 149 → 0、`FlashcardViewer` 139 → 0（详见 §5 表）。
15. **第 15 波**：新建 `src/styles/task-center.css`，任务管理面板三个组件（SquadsTab 176、IssueDetailPanel 133、AutomationTab 134）内联样式全部收口并抽出 `tc-*` 通用族；顺带修掉 `var(--accent)22` 这类无效 CSS（详见 §5 表）。
16. **第 16 波**：设置类面板 `LayeredSettingsPanel`（141 → 0）收口（详见 §5 表）。
17. **第 17 波**：`UsageStats`（128 → 0）、`GitEnvSettings`（172 → 0）收口；TSX 侧色值判定改为逐字面量，暴露并修掉 18 处藏在条件分支里的硬编码色（详见 §5 表）。
18. **第 18 波**：`WechatSettings`（141 → 0）收口，顺带修掉 `var(--border-color)` 这个不存在的令牌（详见 §5 表）。
19. **第 19 波**：新增 `codemod-inline-to-class.mjs`（重复内联形态 → 共享类，首轮 64 处）；`AgentManager`（170 → 0）与 `CicdPanel`（176 → 0）收口（详见 §5 表）。
20. **第 20 波**：`PerformanceDashboard`（151 → 0）、`MultimodalPanel`（121 → 0）收口（详见 §5 表）。
21. **第 21 波**：`ProjectManager`（173 → 0）、`PluginManager`（141 → 0）、`TrajectoryPanel`（225 → 0）收口；
    轨迹过滤下拉改用 `.popover-shell` 外壳；补上 `.trajectory-panel` 这个从未定义的假钩子（详见 §5 表）。
22. **第 22 波**：`ModelProfilePanel`（179 → 0）、`PetMarketDialog`（159 → 0）、`KnowledgeGraphView`（174 → 0）收口；
    审计器补掉「复合值字符串里的 hex」这处 error 级盲区并修掉暴露出的 12 处硬编码色；
    新增 `--chart-cat-1..6` 分类色板令牌，知识图谱不再在 JS 里重抄皮肤表（详见 §5 表）。
23. **第 23 波**：`NotebookWorkspace`（134 → 0）、`InputArea`（182 → 12）、`ChatPanel`（163 → 5）收口；
    全项目扫掉 **128 处引用不存在的令牌**（`--border-color` / `--danger` / `--accent-color`，横跨 22 个文件，
    浅色与 dream 皮肤下这些边框/错误色一直是错的）；审计器补完色值规则的命名色与 `rgba()` 两处盲区；
    新增 `--inline-counts` / `--dense-threshold=N` 查看收口进度（详见 §5 表）。
24. **第 24 波**：`ToolCallCard`（257 → 0）、`ppt/PPTAdapter`（281 → 0）收口；
    审计器补掉「无害匹配把整行兜底短路」这处盲区（报出 2 处藏在 `background: transparent` 旁边的硬编码红）；
    `SettingsPanel`（999 → 673）开工，新建 `.sp-*` 设置面板零件类（详见 §5 表）。
25. **第 25 波**：`SettingsPanel`（999 → 0）收口完成 —— **门禁归零：error 0 / warn 0**（详见 §5 表）。
26. **第 26 波**：门禁 9 条 → **12 条规则全绿**。用三个独立对账脚本重核"已归零"的三项：
    补掉 96 处未定义令牌引用（含 `--font-mono` 24 处无兜底、`--border` 7 处、`--bg-active` 静默失效）、
    29 个空壳类名（并永久去掉 `css-class-undefined` 的内联样式豁免）、29 处 `style={{}}` 之外的硬编码色，
    外加新发现的一类盲区 `svg-attr-var`（`stroke="var(--x)"` 在属性位置无效 → 图形不画，5 处）（详见 §5 表）。
27. **第 27 波**：量并修掉 z-index 与重复类定义两项（门禁规则 12 → 14 条）：205 处写死 z-index 里
    97 处归位到层级梯子（并修掉"模态层 200/1300 两套值"与"提示条盖不住 portal 菜单"），
    18 个重复定义类按"后者胜出"合并回一处（详见 §5 表）。
28. **第 28 波（本轮）**：间距令牌化 —— 2906 处数值间距里 2354 处令牌化 + 60 处 2px 网格归并
    （3→4、5→6、7→8、13→14、18→20、22→24、36→40），补齐 `--space-13/14/15`（40/48/64）大留白档，
    新增门禁规则 `spacing-raw`；顺带把 library-ops 插件的「可消费令牌前缀」契约扩到 `--space-`
    （间距令牌与 `--fs-*`/`--radius` 同性质：宿主提供、与皮肤无关）（详见 §5 表）。

29. **第 29–30 波**：对照参考实现补齐交互反馈与细节层 —— `:focus-visible` 19 → 531、
    动效字面量 194 → 8、`transition: all` 49 → 1；焦点环/按下反馈/分层阴影/文字渲染/减动效/滚动条等（详见 §2.7 与 §5 表）。
30. **第 31 波**：控件高度尺度（`--control-*` 24/28/32/36/40）落到 13 个共享控件类，
    另补 `::placeholder` 与 `input/select/textarea { min-width: 0 }`（详见 §5 表）。
31. **第 32 波**：对齐原语与状态语义 —— 设置/表单行改 grid 两列模板（标签对齐成一条竖线）、
    `:has()` 做父级状态（卡片聚焦描边、字段行整行标红）、tab 补 `aria-current`/`aria-selected` 并与
    `.active` 同源驱动样式、浮层入场动画在 `prefers-reduced-motion` 下取消（详见 §5 表）。
32. **第 33 波**：**"为什么像项目不像产品"的带数据诊断**（§2.8）与其对应的底层修正 ——
    字重细档令牌（560/620/650 档位补出）+ 34 处 meta/值类降权 + 层次收口（值与数字回到 400）、
    控件高度 24/28 → 26/30/34/38/44、`--radius-sm` 4→6px/`--radius-xs` 6→8px + 10 个标签徽标胶囊化、
    图标描边统一 1.75 并按尺寸反向补偿（详见 §2.8 与 §5 表）。
33. **第 34 波（本轮）**：**局部细节三件事**（门禁规则 15 → 17 条）——
    ① 149 处离刻度图标尺寸吸附回八级（`icon-size-offscale`）；
    ② 圆角阶梯修正为严格单调 + 新增 `--radius-xl`，381 处 CSS + 208 处 TSX 字面量收回令牌、
    去掉 88 处过时兜底（`radius-raw`）；
    ③ 状态小块统一为 `currentColor` 派生的"淡底 + 淡边"胶囊（此前 47 处里只有 26 处带淡底）。
    五项维度（菜单栏/字体/间距/状态色/图标）两侧同口径量化见 §5 第 34 波与 `.preview-shot/five-dims.mjs`。
34. **第 35 波**：字体栈收敛（31 种写法 → 7 种）+ 自我更正（自带字体本来就是可变字体，
    `wght` 200–700，细档字重一直真实生效），新增门禁规则 `font-stack-raw`（详见 §2.1c 与 §5 表）。
35. **第 36 波**：默认档位改为**浅色暖中性**（`:root` 即默认、暗色显式覆盖、两档令牌完全对称），
    新增唯一真相源 `src/core/theme/theme-default.ts` 与首屏镜像脚本（详见 §2.3 与 §5 表）。
36. **第 37 波**：grid 对齐原语铺到重复行（225 处成对替换）—— `display: grid` 50 → **275**、
    `grid-template-columns` 53 → **278**（详见 §2.4 与 §5 表）。
37. **第 38 波**：`:has()` 父级状态 7 → **41 处**（每条都先用 `verify-has.mjs` 核对 TSX）；
    顺带修掉"`::before` 竖条没有定位上下文"与"展开态没有 `aria-expanded`"两处写了不生效的样式；
    新增**死类名普查**维度（3396 个类名里 258 个从未被 TSX 使用，7.6%）（详见 §5 表与下方队列）。
38. **第 39 波（本轮）**：**焦点可见性收口**（门禁规则 18 → 20 条）—— 删掉 21 处 `:focus { outline: none }`
    抑制与 14 处内联 `outline: 'none'`，全局输入环提到令牌强度，裁切容器改 inset 环，
    文件树/图谱节点从"不可聚焦的 div"改成键盘可达；同口径实测已超过参考实现（详见 §7 A4）。
39. **第 40 波（本轮）**：**减动效覆盖 + 动效降噪**（门禁规则 20 → 21 条）——
    57 条循环动画全部有显式关停（清单从"类名模式匹配"改成显式选择器）、每个自带动画的样式表自己兜底、
    宠物窗口补齐兜底与焦点环、新增 `useReducedMotion` 让 rAF 逐帧动画也尊重该偏好，
    删掉背景光斑漂移与死 kf，游戏插件 kf 改名避免静默覆盖；新增规则 `motion-uncovered`（详见 §7 A3）。
40. **第 41 波（本轮）**：**应用外壳：应用级菜单栏 + 窗口 chrome**（B 组第 5 项）——
    新增 `AppMenuBar`（文件/视图/帮助，纯自研、完整键盘可达 + ARIA，8 条行为测试）、
    外壳高度令牌 `--chrome-height` 44px（原 36px 里塞 26px 控件只剩 5px 余量）、
    标签条两端渐隐遮罩、动作栏按钮统一 30px 固定高度、`--mask-opaque` 令牌（详见 §2.8 与 §5 表）。
41. **第 42 波（本轮）**：**标签墙/选项墙改 auto-fill 网格**（把 grid 推到 **305** 处 / `grid-template-columns` **301** 处，
    两项原始目标 300/250 均达成）—— 19 + 10 处 `flex-wrap` 的标签/选项/状态墙改成
    `repeat(auto-fill, minmax(<min>, max-content))`：flex-wrap 的最后一行宽度参差、标签左右边缘对不齐，
    网格让标签**按列对齐**且换行后依然整齐；用 `max-content` 而不是 `1fr`，短标签不会被拉宽变形。
42. **第 43 波**：**工具条拖拽安全区**（对齐参考实现的外壳结构）—— 容器不再整条可拖，
    新增 `.titlebar-drag-region` 专用拖拽区，左右安全区令牌（mac 红黄绿灯 76px / Windows 三按钮宽度），
    内容统一 `z-index: 1` 保证"内容点得动、空白拖得动"；标签条末尾补"新建对话"按钮。
43. **第 44 波**：**死类名清理 + 新门禁规则 `css-class-unused`**（规则 21 → 22 条）——
    两趟共删 **223 条规则**，未使用类名 258 → **110**（3.4%）；两个教训见 §7 队列。
44. **第 46 波（本轮）**：**把「搜索当前会话」「临时会话」从会话头部移到编辑器底部工具行**
    （与执行模式 / 安全策略同一行、这一行的最右边），样式直接复用该行的 `.input-control-item`，
    按压态由 `aria-pressed` 驱动；顺带**补上第 44 波漏注册的门禁规则**（见下条“规则注册事故”），
    并把"动态拼接守卫"与"语料范围"两处假阳性修掉，再清 **42 条死规则**（未使用类名 110 → **79**，2.4%）。

### 同口径对照（`.preview-shot/focus-compare.mjs`，第 39 波实测）

| 指标 | 我们 | 参考实现 | 结论 |
| --- | ---: | ---: | --- |
| `:focus-visible` 规则 | **490** | 57 | ✅ 远超（第 29–30 波把 `:hover` 统一改成 `:is(:hover, :focus-visible)`） |
| 带令牌环的规则 | 22 | 21 | ✅ 持平 |
| `:focus { outline: none }` 抑制 | **5** | 19 | ✅ 更少（第 39 波清掉 21 处）；**注意此前文档里"21 vs 43"是错的**，那是不同口径 |
| `display: grid` | **305** | 574 | ⚠️ 同一量级；差额是"我们仍用 flex 表达大量单行/无间隙布局"，不是缺对齐（第 37 + 42 波共铺 254 处） |
| `grid-template-columns` | **301** | 320 | ✅ 基本持平 |
| `display: flex` | 932 | 245 | ⚠️ 我们仍大量用 flex（这是 grid 差距的另一面） |
| `:has()` | 41 | 41 | ✅ 持平 |
| `prefers-reduced-motion` | 12 | **27** | ✅ 第 40 波已达成实质覆盖（每条循环动画都有显式关停，`motion-uncovered` 锁住）；处数差别是"参考实现拆成更多小块"的写法差异 |
| `@keyframes` / `infinite` 动画 | 83 / 57（**排除像素美术插件 56 / 27**） | 41 / 16 | ⚠️ 我们动得仍偏多 —— 已删掉纯装饰的背景光斑漂移；剩余大多是有信息量的状态指示（加载/流式中/进行中） |

### 尚未追平参考实现的部分（第 38 波后剩下的，按"要不要动"分类）

**A. 技术性差距，还能继续追（不需要产品决策）**
1. `display: grid` **275** → 参考 **574**（第 37 波从 50 铺到 275，已在同一量级）：下一步是第二档
   （88 处"子元素数随状态变化"的行，需要按最大子元素数设计模板或改用
   `grid-auto-flow: column` + `grid-auto-columns: max-content`），以及 `flex-wrap` 标签墙改
   `repeat(auto-fill, minmax(Npx, 1fr))`。
2. `:has()` ✅ **第 38 波完成（41 处，与参考实现持平）**：从 7 处铺到 41 处，全部落在
   **TSX 已核对的父子关系**上（选中态外显、禁用态整行淡化、错误/运行态竖条、焦点父级环、完成态淡化）。
   **一条铁律**：写 `:has()` 之前必须用 `.preview-shot/verify-has.mjs` 核对"祖先类名 → 后代特征"
   在 TSX 里真的成立 —— 写错的 `:has()` 不报错也不生效，只是悄悄变成死代码（本轮就靠这道核对
   拦下了两条：容器类名写成了不存在的 `.tool-pill`，以及 `.sp-field-row` 根本没有 TSX 使用）。
3. `prefers-reduced-motion` ✅ **第 40 波完成（覆盖层面比参考实现更彻底）**：实测起点是
   **60 条 infinite 动画里只有 35 条被显式关停**，而且关停清单用**类名模式匹配**
   （`[class*="-spin"]`、`[class*="-pulse"]`）—— `.spinning` / `.thinking-text` / `.activity-dot.active` /
   `.session-running-dot` / `.boot-splash-logo-icon.pulsing` / `.ppt-studio-orb` / `.lo-icon-btn.is-busy`
   这些名字里不含 `-spin`/`-pulse` 的全部漏网。第 40 波的动作：
   ① 用脚本把 **60 条 infinite 动画逐条列出来**，关停清单改成**显式选择器清单**（可读、可数、不会因改名静默失效）；
   ② 每个自带动画的样式表**自己兜底**（`codem-ui.css` / `notebook-workspace.css` / `game.css` /
   `pet-window.css` / `library-ops.css`），因为组件级 CSS 可能被单独加载，不能假设 `styles.css` 一定在；
   ③ 全局兜底补上 `animation-delay` / `transition-delay` 归零，并删掉与文件末尾**逐字重复**的那一份兜底块；
   ④ **宠物窗口是独立入口**（`pet-main.tsx` 只加载 `pet-window.css`）→ 此前它既没有减动效兜底、
   也没有焦点环，现已补上；
   ⑤ **JS 逐帧动画**（CSS 管不到的那一半）：新增 `src/hooks/useReducedMotion.ts`，
   让宠物精灵的 rAF 逐帧切换（`PetSprite`）与图书馆场景的相机缓动 / 逐帧推进
   （`LibraryScene` / `PixelLibraryScene`）在该偏好下短路 —— 这是全仓库**第一处** `matchMedia`
   `(prefers-reduced-motion)`；
   ⑥ 新增门禁规则 `motion-uncovered`：**每条循环动画都必须有显式关停**，跨文件比对，
   现在全项目 57 条 infinite 全部覆盖；
   ⑦ **降噪**：删掉背景光斑的无限漂移动画（25s/30s/20s 交替）与死掉的 `@keyframes streaming-dots`，
   并把游戏插件的 `pulse` 改名 `mnp-pulse`（此前它与 `styles.css` 同名 kf 冲突、按加载顺序静默顶掉宿主定义）。
   **同口径规模**：`@keyframes` 83 / infinite 57（**排除像素美术插件后是 56 / 27**）vs 参考 41 / 16；
   `prefers-reduced-motion` 12 处 vs 27 处 —— 差别主要是**写法**（参考实现拆成更多小块），
   而非覆盖缺口：我们的判定标准是"每条循环动画都有显式关停"，现在达成。
4. `focus-visible` ✅ **第 39 波完成（同口径实测已超过参考实现）**：用同一个脚本量两边 ——
   我们 `:focus-visible` 规则 **490** 条 vs 参考 **57** 条；带令牌环的规则 **22** vs **21**；
   `:focus { outline: none }` 抑制 **5** 处 vs 参考 **19** 处。第 39 波的动作：
   ① 删掉 21 处 `:focus { outline: none }` 抑制（其中 4 条是 `<select>`，而全局环规则恰好没覆盖
   select → 这些控件的键盘焦点**完全不可见**）；② 删掉 14 处 TSX **内联** `outline: 'none'`
   （内联优先级压过所有非 `!important` 规则，连 `[tabindex]:focus-visible` 的 (0,3,0) 环都被吃掉）；
   ③ 全局输入控件的软环从 22% 提到令牌强度 75%；④ 会给容器裁切的场景（工作区标签栏、PPT 缩略图栏、
   面板侧栏标签、幻灯片画布、文件树、图谱节点）改用 inset 环；⑤ 文件树条目与图谱节点此前是
   **不可聚焦的 div**（键盘根本到不了），补 `role`/`tabIndex`/Enter-Space；
   ⑥ 新增门禁规则 `focus-outline-none` 与 `inline-outline-none`。

**B. 需要产品/品牌决策**（第 39 波起逐项落地 —— 用户已确认"A 和 B 都做，一切以追平甚至超越它为目标"）

5. **窗口外壳** ✅ **第 41 波完成（应用级菜单栏 + chrome 尺寸/细节）**：加了一条**应用级菜单栏**
   （文件 / 视图 / 帮助，纯自研组件 `AppMenuBar`，`role="menubar"/"menu"/"menuitem"` +
   `aria-haspopup`/`aria-expanded`/`aria-keyshortcuts`，键盘完整可用：↓ 打开、↑↓ 选项、
   ←→ 换菜单、Home/End 跳首尾、Esc 关闭并把焦点交回触发器；8 条行为测试锁住）。
   **只放真实可用的命令**（新建对话 / 搜索 / 设置 / 关闭窗口 / 切换侧边栏 / 切换终端 / 切换主题），
   不放灰掉的假项。外壳本身：`--chrome-height` 44px（原 36px 里塞 26px 控件，上下只剩 5px 余量）、
   动作栏按钮统一 30px 固定高度、标签条两端渐隐（`mask-image`，遮罩色用 `--mask-opaque` 令牌）。
   **还差一步（未做，属可选）**：参考实现的工具条有**独立拖拽安全区**（`--mac-window-chrome-left/right-safe-area`
   + 一条专门的 `.mac-window-drag-region`）与"新建标签"下拉；我们目前是整条 `-webkit-app-region: drag`
   加逐个 `no-drag`，功能等价但不如它的结构清晰。
6. **默认主题明度**：✅ **第 36 波完成** —— 默认档位改为**浅色暖中性**（画布 `#fcfcfb`、
   卡片 `#f5f5f3`、文字 `#1f1f1e`、线 12%/7% 黑），`:root` 即默认档、暗色改为显式覆盖，
   两档令牌完全对称（此前浅色块只覆盖 49/76 个令牌），并加首屏镜像脚本消除启动闪烁。
7. **UI 字体**：✅ **第 35 波完成（比预想更好）** —— 自查发现自带的 `AlimamaFangYuanTiVF-Thin.ttf`
   本身就是**可变字体**（`wght` 200–700），第 33 波的 560/620 细档一直真实生效（此前文档里的
   "静态字重"判断是错的，已更正）；本轮把 31 种散写法收成 `--font-ui` / `--font-mono` / `--font-display`
   三档令牌栈并加门禁。**剩余可选项**：`--font-display` 目前与 UI 同源，若要更强的"产品感"
   可以给标题档换一个独立展示字体（参考实现用 `"Space Grotesk", Inter`）。

### 还没量、但该量的队列（第 38 波新开的一维）✅ 第 44 波完成

- **死类名**：`.preview-shot/dead-classes.mjs` 量出 **3396 个 CSS 顶层类名里 258 个（7.6%）**
  在 TSX/TS 里从未出现（`composer-*` 整族、`code-block-*`、`native-title-bar-*`、`hub-*`、
  `nb-guided-questions` 族、`right-rail-*`…）。第 44 波两趟删除 **223 条规则**，
  未使用类名 258 → **110（3.4%）**，并新增门禁规则 `css-class-unused` 作为只降不升的棘轮。
  **两个教训值得记下来**：
  ① **"动态拼接"守卫不能只看前缀本身**：第一版用 `code`/`hub`/`tool` 这类短词做前缀匹配，
     撞上语料里的普通文本（`code + 1`、`tool" + ...`），把成片真死类名误判成"活的" ——
     第一趟只删掉一半。改成"前缀必须以 `-` 结尾"后就准了。
  ② **减动效媒体块是"安全网"，清理脚本要认得出**：第一趟误删了 library-ops 的减动效规则
     （那些类名是 SVG 子部件，不在 TSX 里），当场被 `motion-uncovered` 抓住并回滚 ——
     门禁不只用来管别人，也用来管清理脚本。
  残留的 110 个都在"与活类共存的选择器"里（如 `.run-status-bar.phase-thinking` 这类**修饰类**）：
  删整条会连带删掉活类的样式，所以规则刻意不判 —— 这一层要人工逐个确认，收益不大，暂不再动。

### 发布收尾队列 ✅ 第 45 波完成

- **v1.16.0 已发布**：`CHANGELOG.md`（顶部新增 `[1.16.0]` 条目，按「用户能直接看到的改变 / 工程侧 /
  已知取舍」三段写）、`README.md`（「作者的话」追加 v1.16.0 段落）、`docs/PROJECT-GUIDE.md`
  （6.1 已发布版本表新增一行）三处同步；版本号在 `package.json` / `src-tauri/tauri.conf.json` /
  `src-tauri/Cargo.toml` 三处一起改。
  产物与地址：`https://github.com/sdcxb/codem/releases/tag/v1.16.0`
  —— `Codem_1.16.0_x64-setup.exe`（39.7MB）+ `.sig`、`Codem_1.16.0_x64_en-US.msi`（42.0MB）+ `.sig`、
  `latest.json`（updater 清单）共 5 个资产；构建日志显示 Rust `release` profile 编译 2m23s、
  前端 `vite build` 37s、NSIS 与 MSI 两套包与 updater 签名全部生成。
- **新增 `src/test/version-consistency.test.ts`**（VERSION-1~4）把「三处版本一致 + 语义化三段式 +
  CHANGELOG 顶部有当前版本条目 + PROJECT-GUIDE 版本表已登记」变成机器约束 ——
  此前只有"三处一起改"的人工纪律，而漏改的后果是**安装包版本与前端版本不一致**，开发环境里看不出来。
- **安装包构建**按 `docs/RELEASE-GUIDE.md` 的流程执行：必须先设签名环境变量
  （`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=dummy`），否则 tauri CLI
  会卡在交互式密码输入（密钥是 `rsign encrypted secret key`）。

### 图标体系迁移的剩余队列（第 53 波盘点，留给第 54 波）
**背景**：`icon-map.ts` 的既定政策是「管理界面用 Lucide、只有聊天消息里保留 emoji」。
第 53 波把 **ConfigEditor**（11 处 emoji + 文字 ✕）和 **AgentPanel**（状态符 + 👥/🔧/💭/📁）迁完，
并把门禁从「逐文件白名单」改成「全仓库扫描 + 显式豁免」（ICON-062~065）。

**还剩 16 个组件**（按"当图标用"的处数排序）：

| 文件 | 处数 | 主要形态 | 备注 |
| --- | --- | --- | --- |
| `SettingsPanel.tsx` | 41 | `icon: '🔧'` 数据字段、`✅/❌` 结果文案 | 数据字段要逐个映射到 lucide |
| `ppt/EditorToolbar.tsx` | 16 | 工具按钮 emoji | 工具栏，替换直接 |
| `GitInfoPanel.tsx` | 14 | `setActionResult(\`✅ …\`)` | **多为结果文案**，属"内容" |
| `MultimodalPanel.tsx` | 13 | `🖥️/📷/🎤/🔍` 选项与标题 | 有 emoji 选择器（数据，保留） |
| `NotebookWorkspace.tsx` | 11 | `icon: '📋'` 摘要类型字段 | 与 PPT 模板图标同类 |
| `ppt/PPTEditor.tsx` | 11 | `icon: '🎯'` 模板图标、`📚 版本历史` | 模板图标可映射 |
| `ppt/PPTAdapter.tsx` | 10 | 阶段 `icon: '📚'` | 同上 |
| `CicdPanel.tsx` | 8 | `✅/❌/⚠` 结果文案、`✓/✗/○` 状态符 | 状态符建议换 `StatusIcons` |
| `GitEnvSettings.tsx` | 8 | `🌿/🔄/✅` 标题前缀 | 标题前缀直接换图标 |
| `SkillManager.tsx` | 7 | `<span>📤</span>`、`⚡/📦` | 独占节点的要换 |
| `ContextMonitor.tsx` | 6 | `📊` 图标 + `✅/⚠️` 文案 | 混合 |
| `RecoveryPanel.tsx` | 6 | `🔄/💾/📤/🗑️` 按钮 | 按钮直接换 |
| `DiffViewer.tsx` | 5 | `📄` + `✅ Accept` | Accept/Reject 建议用 `Check/X` |
| `LayeredSettingsPanel.tsx` | 5 | `🏗️/🛡️/✅/❌` | 标题 + 布尔值文案 |
| `PermissionPresetSelector.tsx` | 5 | `'🛡️': Shield` 映射表 | **本身就是 emoji→图标的过渡垫片**，可整段删除 |
| `PetMarketDialog.tsx` | 5 | `🐾` 商标 + `🔄` 状态 | 宠物 emoji 属品牌资产，需先决策 |

**做法提醒（别用正则批量替换）**：本波的教训是"**✅/❌ 出现在结果文案里**"与"emoji 单独占一个
文本节点"是两件事，前者是内容、后者才是图标；正则分不清，必须逐个看上下文再改。
`PermissionPresetSelector` 的映射表说明项目里已经有人走过一次这个迁移，可以照它的方式收尾。
### 门禁清单（第 61 波后的全貌：25 条审计规则 + 6 组契约测试）

| 层 | 位置 | 看什么 | 拦得住什么 |
| --- | --- | --- | --- |
| 审计规则 25 条 | `tools/ui-audit/scan-ui.mjs` + `baseline.json` | 令牌化、类名、层级、焦点、减动效、跨文件冲突、编码损坏、死令牌 | 「用了错的写法」（数量只降不升） |
| CSS 语法完整性 | `src/test/css-integrity.test.ts` | 括号平衡、悬挂逗号、顶层裸声明、空规则体、行容器裁切 | 批量改写留下的**残骸**（第 52 波事故） |
| CSS 生效取值 | `tools/ui-audit/css-contract.mjs` + `css-contract.json` | 每个类**生效后**的声明集合（2743 个类） | 「类名没错、取值被悄悄改了」（第 51/54 波三次事故都属这类） |
| 真实布局几何 | `src/test/layout-contract.test.ts` + `fixtures/settings-modal-probe.html` | 用无头 Edge 真渲染，测弹窗在各分辨率下的宽高与自适应 | 「窗口塌成窄条 / 放不下被裁掉」（第 54 波用户报的 bug） |
| 标签墙/工具的挤压变形 | `src/test/layout-contract.test.ts` + `fixtures/chip-rows-probe.html` | 真实渲染下数**文字行数**与 `scrollWidth`（9 种宽度 × 17 个容器） | 文字被压成竖排、内容溢出看不到（第 55 波用户报的 bug） |
| 图标一致性 | `src/test/icon-standardization.test.ts` | 图标集完整性、**全仓库**扫描 emoji/文字 ✕、迁移文件是否真用图标集 | 管理界面用 emoji 当图标、字形关闭按钮（第 53 波） |
| 设置键读写对称 | `src/test/settings-keys-symmetry.test.ts` + `helpers/settings-key-scan.ts` | 每个设置键**是否既有写入方、又有读取方**（810 文件 / 251 调用点 / 70 键）+ 检测器自检 | 「设置项存了不生效 / 读了没人写 / 多传参数被静默忽略」（第 61 波） |
| 设置项是否真的落地 | `src/test/settings-effect.test.ts` | 读到的值**有没有被用上**：启动路径必须读回并应用、索引检测不得再读无写入方的键、设置页能改的键应用侧必须有人读 | 「有读取方但值没用上」（`codem-display-mode` 正是这种；SKEY 系列看不出来） |
| 智能体是否在原地打转 | `src/test/loop-guard.test.ts`（GUARD-1~12） | 重复调用的识别（**用事故现场 17 条真实命令**做样本）、阈值阶梯、写操作重置、不误杀 | 「十几分钟反复枚举同一个目录，父会话还在无限期等待」（第 62 波用户报的问题） |
| 委派等待是否有预算 | `core-delegation-orchestration.test.ts`（DELE-030~043） | 等待到预算带进度返回、**累计**预算、取消不被完成覆盖、后台墙钟上限按「部分完成」回传 | 「父会话黑等十几分钟、既没产出也不知道子会话在干什么」「点了终止却显示已完成」（第 62/63 波） |
| 交接协议是否成立 | `handover-protocol.test.ts`（HANDOVER-1~10） | 交接必须含**具体目标 + 完成判据**、有长度上限、校验会放手、模板与提示词一致 | 「交接只写意图不写状态 → 接收方从零遍历文件系统」（第 62 波事故的**根因**，第 63 波补上） |

> **为什么要有「生效取值」这一层**：前三层分别看「写法」「语法」「几何」，而「同一个类被别的规则偷偷改了取值」正好落在它们的缝里 ——
> 第 51 波的跨文件合并连续造成三次这种事故：设置弹窗宽 760→160px、浅色主题标题栏悬停发黑、区块标题字重 620→560。
> 三次都是 `tsc` 通过、单测通过、审计 0/0。用法：**有意改动 → 跑 `node tools/ui-audit/css-contract.mjs --write` 更新快照并与改动一起提交**（diff 里会写清改了什么）。
> 排查几何类问题可直接复用 `.preview-shot/measure-settings-modal.mjs`（无头 Edge 多分辨率扫描）与 `.preview-shot/verify-css-contract.mjs`（注入事故反验门禁）。

### 死字段/不对称键清单（第 61 波盘点，`SKEY-2` 守住）

判据不是"猜有没有人用"，而是**机械对账**：`settings-keys-symmetry.test.ts` 扫全项目取键调用点，
每个键必须**既有写入方、又有读取方**。第 61 波清了 5 类，剩下列 4 项登记在白名单里（每项附理由），
另有 3 项属架构/产品决定，本轮**刻意不动**：

**已修**：`codem-display-mode`（只写不读 → 显示模式永不生效）、`codem-current-project-path`
（只读不写 → 索引检测恒为空串）、`getSetting(键, 默认值)` 两处多传参数（静默忽略）、
`defaultSettings` 的 `theme`/`mimoPath`/`autoApprove`（零读取方；`theme: "dark"` 还与
`DEFAULT_THEME = "light"` 矛盾）、7 个死 CSS 令牌（22 行定义）。

**登记白名单（真·单向，且有正当理由）**：

| 键 | 方向 | 理由 |
| --- | --- | --- |
| `codem-figma-token` | 只读 | **没有设置界面**，但 `figma-fetch.ts` 的报错文案让用户"去设置里配" —— 文案指向不存在的入口，**属待补缺口**（补设置项 or 改环境变量） |
| `agentsMdMaxBytes` | 只读 | 高级旋钮（AGENTS.md 读取上限），默认 32KB 已生效，供手工/脚本写库 |
| `system-prompt-instructions` | 只读 | 高级旋钮：系统提示词覆盖，供手工配置 |
| `ui-language` | 只读 | 语言由另一条通道（`codem-language`）写入，此处只是兼容读取 |

**刻意不动（需要人做决定）**：

1. **9 个 `DREAM_CSS_VARS` 令牌由 JS 注入、CSS 从未消费** —— 删它们等于动皮肤设计意图，留给皮肤重构。
2. **`ConversationComposer.tsx` / `ConversationSession.tsx` 全项目零引用**，但它们是
   `conversation.composer.bar` / `conversation.composer.dock` / `conversation.session.header.actions`
   三个插槽**唯一**的消费者 —— 删组件会连带作废这三个扩展点。
3. **262 个源文件带 `// @ts-nocheck`**（196 个在 `src/core/provider/`）：类型检查在这些文件里等于关闭，
   这正是"多传参数被静默忽略"能潜伏至今的原因。要减这层债得逐文件摘掉并修错，属于独立课题。

**教训（写进流程）**：写"死字段检测器"时，**先怀疑仪器**。第 61 波第一版报了 12 个键，逐个人工核对后
**全部是检测器自身的误报/漏报**（事件名与前缀判断被当成键、读取别名 `settings(...)` 被当成写入、
同名常量跨文件串味、泛型组贪婪吞掉调用点）。因此本波把检测器拆成纯函数并加了 `SKEY-0` 自检：
真键、对象字面量泛型（单行/多行）、`Record<…>` 泛型、读取别名、事件名、前缀判断、跨文件同名常量 ——
每种形状都是一条断言。**没有自检的检测器，产出的"发现"不可信。**

### 明确保留、不再动的（避免下一轮重复劳动）
0. **`flex` 只对 flex 容器生效**：把容器从 flex 改成 grid 时，**必须同时迁移子元素上的 `flex` 写法** ——
   要么用 `minmax(0, 1fr)` 轨道（元素自动撑开，原 `flex` 变成无害死代码），要么改用 `justify-content`；
   特别注意 **`margin-left: auto` 在 grid 里不会吸收行尾空白**（第 57 波实测：`.mm-footer` 的保存按钮右边空了 616px）。
   判定由 `LAYOUT-10`（真实渲染：可伸缩元素是否撑开、行尾控件是否贴右）守住。
0b. **页签/按钮行容器的「单行」原则有边界**：容器高度**固定**时（左右侧栏的标签条）必须单行 + 文字省略号（不换行、不滚动）；
   容器高度**自适应**时（弹窗里的页签行，如 `.config-tabs`）应当**允许换行** —— 那里换行不会裁掉任何东西，
   而 `nowrap + overflow: hidden` 会让放不下的页签彻底消失（第 53 波的实际 bug：560px 弹窗里的 7 个页签）。判定由 `CSS-INTEGRITY-5/6` 锁住。
1. **`z-index` 的局部层叠（<100）**：目前 149 处写死值按规则**允许保留**（幻灯片元素 96 处、棋盘格子、图标叠层）。
   它们是局部坐标而不是全局层级，全局化反而更难读；若将来要动，只做"同一容器内的一致性归并"。
2. **`rgb(x x x / a)` 写法**：参考实现用了 762 处，我们用 `color-mix()`（362 处）表达同一件事。
   两种写法等价，本项目**统一走 `color-mix()`**，不追平这一项。
3. **1px/0.5px 细线与负间距**：`spacing-raw` 明确放行 —— 细线是"精度"、负值是光学微调。
4. **`monopoly-game` 插件与 PPT 生成内容**：自带美术语言 / 生成内容配色，按例外表整份豁免。
5. ~~**z-index 令牌化**~~ ✅ 第 27 波；~~**重复定义收敛**~~ ✅ 第 27 波；~~**间距令牌化**~~ ✅ 第 28 波。

### 收口这一层用到的工具与手法（下一批文件可直接复用）

- `node tools/ui-audit/scan-ui.mjs --inline-counts --top=30`：每个文件的内联样式属性数（排队、验收）。
- `.preview-shot/style-hotspots.mjs <file>`：该文件里最肥的几段内联样式（先改哪几段）。
- `.preview-shot/style-signature-census.mjs <file>`：归一化后的签名与重复次数（决定要不要提升成共享类）。
- `.preview-shot/style-buckets.mjs <file>`：属性质量分布（文字/布局/面/按钮各占多少）。
- `.preview-shot/undefined-classes.mjs <file>`：收口过程中新冒出来的空壳类名（内联样式原来挡着它们）。
- `.preview-shot/apply-edits2.mjs`：空白与引号都不敏感的批量替换，签名从 census 直接粘过来即可。
  **两个坑**：必须用全局正则（`String.replace` 只换第一处，会留下"同签名只改了一半"的残迹）；
  元素已有 `className` 时要合并而不是新增（否则 TS17001）。
- 读文件省 token 的手法：用 `pwsh` 按行号区间 dump（只打印 `style={{` 前后几行），不要整窗读。
- `.preview-shot/five-dims.mjs`：**与参考实现的五维同口径度量**（菜单栏/字体/间距/状态背景色/图标）——
  回答"为什么感觉不如它精致"时必须先跑这个，再决定改什么；凭印象排优先级必错。
- `.preview-shot/icon-detail.mjs` / `offscale-icons.mjs`：图标尺寸与描边取值的分布 + 离刻度 site 明细。
- `.preview-shot/radius-status.mjs`：圆角字面量/令牌兜底分布 + "状态小块有没有淡底"的对账。
- 动样式表的脚本铁律：**先 `Copy-Item` 备份**；所有替换一次性算好后单次写回（不要"先删再重新定位"）。

### 已知例外（都写在 `scan-ui.mjs` 的 ALLOWLIST 里并附理由）

皮肤令牌源（`src/styles.css`、`src/styles/skin-*.css`、`src/core/theme/`）、PPT 生成内容配色（`src/core/knowledge/ppt-*`）、
大富翁游戏插件（自带美术语言）、图书馆角色调色板注释常量；
按规则豁免（带 `rules` 字段）：`AppErrorBoundary`（崩溃兜底页刻意全内联样式）、`ppt/PPTAdapter|PresentationMode`（整屏工作台/演示舞台）。
