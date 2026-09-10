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
- **分类色板**：`--chart-cat-1..6` —— 只用于「类别」着色（知识图谱的实体类型、图表的多序列），
  **不是状态色**。单列一套的理由：语义色只有 5 个，且浅色主题里 `--info` 与 `--accent` 同值，
  类别一多就会撞色；它同时是唯一允许出现在内联样式里的「成组色值」（配合 `currentColor` 派生淡底淡边）。
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
- 图标尺寸**只用 `.icon-*` 一档 8 级**（`--icon-2xs` 10 / `--icon-xs` 12 / `--icon-sm` 14 /
  `--icon-md` 16 / `--icon-lg` 20 / `--icon-xl` 24 / `--icon-2xl` 32 / `--icon-3xl` 48），
  装饰性图标加 `.icon-dim`。**禁止**写 `w-3 h-3` / `animate-spin` / `opacity-40` 这类
  Tailwind 风格类名 —— 本项目是纯 CSS，没有 Tailwind，写了也等于没样式。
- 内容宽度：工作区 1180px、表单/设置 880px；页面 gutter `clamp(24px, 3.2vw, 48px)`。
- 区块标题上间距 26px、下 10px；页面头行 `margin-bottom: 20px`。

### 2.5 动效与交互

- 时长 120ms（浮层入场）/ 140ms（颜色）/ 160ms（默认）/ 200ms（抽屉）；曲线 `--ease-out`（本项目 `cubic-bezier(.23,1,.32,1)`，与 frakio 的 `(.2,.8,.2,1)` 同族）。
- 位移极小：≤2px 位移 + ≤2% 缩放；**hover 只换底色**（`--bg-hover`），不做位移/边框互换。
- `:focus-visible` 必须有可见焦点环；弹窗必须支持 Esc 关闭 + 点击遮罩关闭（统一走 `modal-overlay`）。
- 尊重 `prefers-reduced-motion`。

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
| `css-class-undefined` | warn | **tsx 里用了但没有任何 CSS 定义的类名**（等于没样式；已排除运行时状态类与第三方库类名；模板字面量里的静态类名同样计入） |

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

| **第 24 波** | 2026-09-10 | **0** ✅ | **1** | **内联样式收口（工具调用卡片 / PPT Studio）+ 审计器第五处盲区**：① `ToolCallCard`（257 → 0，样式落在 `codem-ui.css`）—— `.tool-card` / `.tool-io-card` / `.tool-io-section` / `.tool-io-label` / `.tool-io-text` 这五个类**在 CSS 里完全不存在**，外观 100% 靠内联样式撑着（内联样式正好挡住了类名审计），连 `terminal-block` / `diff-block` / `read-block` / `search-block` 四个变体钩子也是空壳；diff 行的加减色从两段内联三元（同时给 `color` 与 `background`）改成 `.diff-line--add/--del`。② `ppt/PPTAdapter`（281 → 0）—— 整屏 PPT 工作台按例外表不套 `modal-overlay`，但同样不该写 59 处内联样式：收成 `.ppt-studio-*`；顺带把**每次渲染注入一份的 `@keyframes`**（`ppt-pulse`/`ppt-dots`）搬回样式表；又发现 `--text-faded` 这个令牌**不存在**（"未到达阶段"的灰一直在吃 fallback），改用 `--text-muted` 的 60% 表达同一层"更淡"，否则会与"已完成"阶段撞色。③ **审计器第五处盲区：匹配到 ≠ 报警过。** 此前用「本行有没有属性级匹配」决定要不要走兜底，于是一行里只要出现一个**无害**匹配（典型 `background: "transparent"`），后面几条兜底全部跳过 —— `border: "1px solid #e74c3c", background: "transparent"` 里的硬编码红就这么藏了不知多久。改成「本行是否已经报过」后立刻报出 2 处。④ `SettingsPanel` 开工（999 → 727）：新建 `.sp-*` 设置面板零件类（行/列、卡片、按钮族、输入框、提示文案、头像、开关、状态色图标），并补上 4 个"只在 tsx 里出现、CSS 里没有"的类（`.settings-search-box` / `.settings-row` / `.user-avatar-preview` / `.preset-avatar-grid`）；**该文件是本项目最后一块 `inline-style-dense`**（255 个样式对象、密度全项目最高），收口仍在进行中 |- 挂载层：64 个 `SlotBridge` 渲染点 + 54 处 `slots.register` + 44 处 `createPortal`（另 51 个 SlotBridge 在 `App.tsx`）。
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

## 7. 交接快照（2026-09-10 · 第 23 波后）

### 当前数字（`node tools/ui-audit/scan-ui.mjs`）

| 规则 | 级别 | 起点 | 现在 |
| --- | --- | --- | --- |
| `fs-hardcoded` | error | 78 | **0** ✅（门禁锁定；第 12 波起**同时覆盖 CSS**） |
| `radius-offscale` | error | 38 | **0** ✅（门禁锁定；第 13 波起覆盖 `styles.css` 本体，不需豁免） |
| `color-hardcoded-tsx` | error | 325 | **0** ✅（第 17 波起与 CSS 侧同款精度：按字面量位置排除 `var()` 兜底值） |
| `color-hardcoded-css` | error | 209 | **0** ✅（第 13 波起**连 `src/styles.css` 本体一起覆盖**，无豁免） |
| `modal-shell-bespoke` | error | 15 | **0** ✅ |
| `spacing-offgrid` | warn | 13 | **0** ✅ |
| `css-class-undefined` | warn | — | **0** ✅（第 10 波清零；审计器已扩面到模板字面量） |
| `inline-style-dense` | warn | 58 | 1（唯一剩下的 warn；第 14 波先修正了度量口径 50 → 25，再累计收口 24 个文件；最后一块是 `SettingsPanel` 999 → 727，收口中） |
| **error 合计** | | **533** | **0** ✅ |
| **warn 合计** | | 64 | **1** |

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
24. **第 24 波（本轮）**：`ToolCallCard`（257 → 0）、`ppt/PPTAdapter`（281 → 0）收口；
    审计器补掉「无害匹配把整行兜底短路」这处盲区（报出 2 处藏在 `background: transparent` 旁边的硬编码红）；
    `SettingsPanel`（999 → 727）开工，新建 `.sp-*` 设置面板零件类（详见 §5 表）。

### 下一轮的工作队列（按性价比排序）

1. **收掉最后一块 `inline-style-dense`：`SettingsPanel`（999 → 727，仍在进行）**。
   该文件 3100 行、255 个内联样式对象，形态分布（用 `.preview-shot/style-buckets.mjs` 量的）：
   纯文字 223 属性 / 78 处、按钮状 188 / 25、布局 119 / 36、面状 119 / 21、其余 183 / 62。
   `.sp-*` 零件类已就位（行/列、卡片、按钮族、输入框、提示文案、头像、开关、状态色图标），
   剩下的就是把剩下的内联样式逐个换上（阈值 120，需要降到 120 以下才算清零）。
   配套工具：`style-hotspots.mjs`（哪几段最肥）、`style-signature-census.mjs`（哪些形态在重复，
   决定要不要提升成类）、`style-buckets.mjs`（属性质量分布）、`undefined-classes.mjs`
   （收口过程中新冒出来的空壳类名）。
   实用手法：用 `pwsh` 的 `Select-String -Context` 或按行号区间 dump（只打印 `style={{` 前后几行），
   比整窗读文件省得多；改动用 `.preview-shot/apply-edits.mjs` 那种「精确串 → 替换」批量脚本，
   一次提交十几处，跑完 `npx tsc --noEmit` + `--inline-counts` 核对再继续。
2. **z-index 令牌化**：`modal-overlay`=200 与 `--z-modal`=1300 互相矛盾，`popover-shield` 的层级仍留在调用处（23 个 tsx 数值 + 13 个 CSS 层级）；
3. **重复定义收敛**：`styles.css` 内已有同名类被定义两次且取值不同（如 `.badge` 的圆角 10px vs 4px、
   `.workspace-tab` 的 11px vs 12px 字号 —— 后者已被第 12 波统一到 `--fs-sm`），需要新增一条「重复/冲突定义」审计规则；
4. **间距令牌化**：`--space-*` 已补齐但 CSS 里 2482 个数值间距还在用字面量（第 8 波只对齐了离格值），
   可以再走一遍与字号同款的做法（codemod + 刻度映射）；
5. **收尾**：门禁归零 → `CHANGELOG` / `README` / `PROJECT-GUIDE` / 本文件同步 → 升版本号 → 构建安装包 → 发布 Release。

### 已知例外（都写在 `scan-ui.mjs` 的 ALLOWLIST 里并附理由）

皮肤令牌源（`src/styles.css`、`src/styles/skin-*.css`、`src/core/theme/`）、PPT 生成内容配色（`src/core/knowledge/ppt-*`）、
大富翁游戏插件（自带美术语言）、图书馆角色调色板注释常量；
按规则豁免（带 `rules` 字段）：`AppErrorBoundary`（崩溃兜底页刻意全内联样式）、`ppt/PPTAdapter|PresentationMode`（整屏工作台/演示舞台）。
