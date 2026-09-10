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
| **窗口外壳** | `titlebar` 37 处，无窗口 chrome | **`mac-window` 34 + `workbench-window` 7** | 他们有 mac 风格窗口外壳（红黄绿灯 + 工具条）—— "产品感"最强的信号。**品牌决策，未动** |
| 平均明度 | 0.50（暗冷，默认深色） | 0.60（亮暖，默认浅色） | 他们以浅色暖灰为默认。我们浅色主题已具备，**默认档位是产品决策，未动** |

**结论**：观感差距主要来自 ① 字重层次 ② 控件尺度 ③ 圆角与胶囊 ④ 图标描边一致性
⑤ 窗口外壳 ⑥ 默认主题明度 —— **都不是"令牌化"能自动解决的**，而是每个部件的光学调校 + 品牌选择。
令牌化的价值在于让这些调校能一次改全局（`--control-*` / `--radius-*` / `--weight-*` 一改全动），
但"调到多少"始终是设计判断。**⑤⑥ 需要产品决策，不是技术问题。**

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
| **第 36 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **默认档位改为浅色暖中性 + 首屏不再闪（B 组第 6 项）**。<br>① 问题有两层：**默认档位**（`--bg-primary` 是 `rgba(14,15,15,1)` 近黑）和**散落的默认值**（`|| "dark"` 在 TitleBar / SkinSelector / CodeBlockView / ThemeManager 各写一遍，改默认要同时改五处），外加**首屏闪烁**（`index.html` 里没有 `data-theme`，浏览器先按 `:root` 的暗色渲染一帧再等 JS 切，浅色用户每次启动都闪黑）。<br>② 做法：CSS 侧 `:root, [data-theme="light"]` 变成浅色档、`[data-theme="dark"]` 是显式覆盖（两档令牌从此**完全对称**，此前 light 块只覆盖 49/76 个令牌，`--highlight-top` 等 22 个在浅色下一直沿用的暗色值）；色板从冷蓝灰（GitHub 那套）换成**暖中性**（画布 `#fcfcfb`、卡片 `#f5f5f3`、文字 `#1f1f1e`、线 12%/7% 黑），并补齐浅色档缺失的 `--highlight-top*`（暗色下是"白 5% 透光"，浅色下必须是实白，否则面与面没有厚度差）。<br>③ 代码侧新增唯一真相源 `src/core/theme/theme-default.ts`（`DEFAULT_THEME` / `isThemeMode` / `applyThemeAttribute` / `cacheTheme`），四处 `|| "dark"` 全部改为读它；换档时写 localStorage 镜像，`index.html` 加一段内联脚本在首屏渲染前读镜像设属性 —— **两个方向都不再闪烁**（SQLite 的 `codem-theme` 仍是真相源，镜像只是"首屏预测"）。<br>④ 顺带修掉自己造的两处违规（`--shadow-raise-*` 在重写主题块时被漏掉、注释里写了原始色值触发了颜色规则）——**门禁规则又一次抓住了我自己的手误**。 |
| **第 37 波** | 2026-09-10 | **0** ✅ | **0** ✅ | **grid 对齐原语铺到"重复行"层（225 处）**。先用只读分析把全项目 1184 处 `display: flex` 分级：**第一档 226 处**（子元素数固定 2–4、已有 `gap`、无 `flex-wrap`、无 `space-between` 依赖、无子元素依赖父级 flex 分配），第二档 88 处（子元素数随状态变化或 ≥5），第三档 19 处（`space-between` 语义 / 自身被外部 `flex: 1` 撑宽），**明确不该改** 638 处（315 处 `column` 堆叠 + 75 处 `flex-wrap` + 124 处 TSX 里找不到对应类 + 243 处"行但无 gap"—— 无 gap 的行换成 grid 间距仍是 0，**没有对齐收益**，而且顺手补 `gap` 会叠成双倍间距）。<br>按第一档清单做**成对替换**（`display: flex` → `display: grid` + 一行 `grid-template-columns`，脚本 225 处落地，1 处多选择器规则人工跳过）：列模板按子元素数取 `max-content minmax(0, 1fr)`（2 列）/ `… max-content`（3 列）/ `… max-content max-content`（4 列），动作簇与工具条取 `repeat(N, max-content)` 以保持整簇宽度不变。<br>**结果**：`display: grid` 50 → **275**、`grid-template-columns` 53 → **278**（参考实现分别是 574 / 320，已在同一量级）；`display: flex` 1184 → **959**。收益是**标签、图标、数值跨行对齐成竖线** —— 这正是"精致"最直接来源，而 `flex` 的 `justify-content` 做不到跨行对齐。 |
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

## 7. 交接快照（2026-09-10 · 第 34 波后）

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
| `spacing-offgrid` | warn | 13 | **0** ✅ |
| `css-class-undefined` | warn | — | **0** ✅（第 10 波清零、审计器扩面到模板字面量；**第 26 波起去掉「同行有内联样式」的豁免**，去掉后又清出 29 个空壳类名） |
| `inline-style-dense` | warn | 58 | **0** ✅（第 14 波先修正了度量口径 50 → 25，再累计收口 25 个文件；最后一块 `SettingsPanel` 999 → 0） |
| **error 合计** | | **533** | **0** ✅（17 条规则） |
| **warn 合计** | | 64 | **0** ✅ |

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

### 尚未追平参考实现的部分（第 34 波诊断后剩下的，按"要不要动"分类）

**A. 技术性差距，还能继续追（不需要产品决策）**
1. `display: grid` **275** → 参考 **574**（第 37 波从 50 铺到 275，已在同一量级）：下一步是第二档
   （88 处"子元素数随状态变化"的行，需要按最大子元素数设计模板或改用
   `grid-auto-flow: column` + `grid-auto-columns: max-content`），以及 `flex-wrap` 标签墙改
   `repeat(auto-fill, minmax(Npx, 1fr))`。
2. `:has()` 7 → 参考 **41**：已用两个真实场景（卡片聚焦、字段非法）。可继续用于「卡片内有选中项」
   「行内有禁用控件」「有错误时整块标红」这类**父级状态**。
3. `prefers-reduced-motion` 8 → 参考 **27**：审计结论是**兜底覆盖得很宽、显式关停不够** ——
   60 条循环动画里 35 条已显式关停、**25 条只靠兜底冻结**；更关键的两个盲区：
   ① 全仓库 **0 处** `matchMedia('(prefers-reduced-motion…)')`，宠物精灵的 rAF 逐帧切换
   （`PetSprite.tsx`）与图书馆场景的相机缓动（`LibraryScene.tsx` / `PixelLibraryScene.tsx`）完全无视该偏好；
   ② `pet-main.tsx` 只加载 `pet-window.css`，**宠物窗口既没有减动效兜底也没有焦点环**。
4. `focus-visible` 带环 21 → 参考 43：审计发现焦点环其实由 3 条全局规则兜住（`a/button/[tabindex]` 走
   (0,3,0) 的令牌环），所以**真正的洞只有 6 处**：4 条 `select:focus { outline: none }`
   （`styles.css` 的 `.resolution-select` / `.plugin-market__search select` / `.mcp-form-row select` /
   `.memory-edit-field select`）+ `task-center.css` 的 select 分支 + `SlideCanvas.tsx` 的**内联**
   `outline:'none'`（内联优先级压过所有非 `!important` 规则，连 `div[tabindex=0]` 的环也吃掉了）；
   另有 19 条规则把输入控件的实色 2px 环降级成 22% 软环，值得一并提回 `--focus-ring-color`（75%）。

**B. 需要产品/品牌决策，第 33–34 波刻意没动**
5. **窗口外壳**：参考实现有 mac 风格窗口（`mac-window` 34 处 + `workbench-window` 7 处 + `topbar` 22 +
   `app-menu` 16：红黄绿灯、一体化工具条、应用级菜单），我们只有 `titlebar` 37 处、`-webkit-app-region: drag`
   3 处 —— 这是"产品感"最强的单一信号（它 56 个 menu 类名 vs 我们 39），但改的是应用外框，属于品牌决策。
6. **默认主题明度**：✅ **第 36 波完成** —— 默认档位改为**浅色暖中性**（画布 `#fcfcfb`、
   卡片 `#f5f5f3`、文字 `#1f1f1e`、线 12%/7% 黑），`:root` 即默认档、暗色改为显式覆盖，
   两档令牌完全对称（此前浅色块只覆盖 49/76 个令牌），并加首屏镜像脚本消除启动闪烁。
7. **UI 字体**：✅ **第 35 波完成（比预想更好）** —— 自查发现自带的 `AlimamaFangYuanTiVF-Thin.ttf`
   本身就是**可变字体**（`wght` 200–700），第 33 波的 560/620 细档一直真实生效（此前文档里的
   "静态字重"判断是错的，已更正）；本轮把 31 种散写法收成 `--font-ui` / `--font-mono` / `--font-display`
   三档令牌栈并加门禁。**剩余可选项**：`--font-display` 目前与 UI 同源，若要更强的"产品感"
   可以给标题档换一个独立展示字体（参考实现用 `"Space Grotesk", Inter`）。

### 发布收尾队列

- `CHANGELOG` / `README` / `PROJECT-GUIDE` / 本文件同步 → 升版本号 → 构建安装包 → 发布 Release。

### 明确保留、不再动的（避免下一轮重复劳动）

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
