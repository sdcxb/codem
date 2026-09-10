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

## 4. 审计门禁（可重复运行）

```bash
node tools/ui-audit/scan-ui.mjs              # 汇总：每规则计数 + 问题最多的文件
node tools/ui-audit/scan-ui.mjs --verbose    # 附示例
node tools/ui-audit/scan-ui.mjs --census     # 字面量分布（决定下一波映射表）
node tools/ui-audit/scan-ui.mjs --rule=color-hardcoded-tsx
node tools/ui-audit/codemod-tokens.mjs [--write]      # 令牌化改写（默认只预览）
node tools/ui-audit/codemod-icon-scale.mjs [--write]  # 图标工具类 → .icon-* 刻度（默认只预览）
```

规则分层：

| 规则 | 级别 | 含义 |
| --- | --- | --- |
| `fs-hardcoded` | error | 字号硬编码（tsx 内联样式 **与 CSS** 双侧都查；只拦绝对单位 `px`/`rem`/`pt`，见 §2.1 第 2 条） |
| `color-hardcoded-tsx` / `-css` | error | 硬编码颜色（应为语义令牌） |
| `radius-offscale` | error | 圆角离格 |
| `modal-shell-bespoke` | error | 自建浮层外壳，未用统一 `modal-overlay` |
| `spacing-offgrid` | warn | 间距不在 2px 网格 |
| `inline-style-dense` | warn | 单文件内联样式过密（应抽 CSS 类） |
| `legacy-popup-shell` | warn | 历史遗留的自建浮层类名（`popup-*`/`overlay-*`/`modal-box-*`/`dialog-box-*`/`sheet-*`） |
| `css-class-undefined` | warn | **tsx 里用了但没有任何 CSS 定义的类名**（等于没样式；已排除运行时状态类与第三方库类名；模板字面量里的静态类名同样计入） |

**合法例外**（写在 `scan-ui.mjs` 的 `ALLOWLIST`，每条都带理由；`rules` 字段可只豁免某一条规则）：
皮肤令牌定义源、PPT 生成内容配色、大富翁游戏插件（自带美术语言）、图书馆角色调色板注释常量；
以及三条**按规则豁免**的：`AppErrorBoundary`（崩溃兜底页必须在样式表失效时仍可读，刻意全内联样式）、
`ppt/PPTAdapter|PresentationMode`（整屏工作台/演示舞台，不是应用内浮层）、
`src/styles.css` 的 `color-hardcoded-css`（该文件的字号与离格圆角均已令牌化，
色值 231 行是下一波的队列，先按规则豁免以免门禁失真 —— 数字与映射方向记在 §7）。
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

| **第 13 波** | 2026-09-10 | **0** ✅ | **50** | **`styles.css` 的离格圆角清零**：22 处不在刻度上的圆角 → 令牌，`radius-offscale` 对该文件**不再需要豁免**。3px×11（小徽标/关闭按钮）→ `--radius-sm`(4)；5px×9（小按钮/标签）→ `--radius-xs`(6)；11px 开关轨道与 9px 未读徽标 → `--radius-full`（这两个值本来就是"半高 = 胶囊"，换成胶囊令牌后取值完全一致，只是语义变对了）。**色值（231 行字面量）留到下一波** |

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

## 7. 交接快照（2026-09-10 · goal round 11）

### 当前数字（`node tools/ui-audit/scan-ui.mjs`）

| 规则 | 级别 | 起点 | 现在 |
| --- | --- | --- | --- |
| `fs-hardcoded` | error | 78 | **0** ✅（门禁锁定；第 12 波起**同时覆盖 CSS**） |
| `radius-offscale` | error | 38 | **0** ✅（门禁锁定；第 13 波起覆盖 `styles.css` 本体，不需豁免） |
| `color-hardcoded-tsx` | error | 325 | **0** ✅ |
| `color-hardcoded-css` | error | 209 | **0** ✅（`src/styles.css` 本体仍有 239 处待迁移，见下） |
| `modal-shell-bespoke` | error | 15 | **0** ✅ |
| `spacing-offgrid` | warn | 13 | **0** ✅ |
| `css-class-undefined` | warn | — | **0** ✅（第 10 波清零；审计器已扩面到模板字面量） |
| `inline-style-dense` | warn | 58 | 50（仅剩这一类） |
| **error 合计** | | **533** | **0** ✅ |
| **warn 合计** | | 64 | **50** |

> 注：`color-hardcoded-tsx` 中途曾报 53 → 9 —— 不是"改多了"，而是审计器修掉了假阳性（见第 11 波说明）。
> `fs-hardcoded` 第 12 波一度报 590 —— 也不是"变差了"，而是审计器**首次开始扫 CSS 侧**（此前 591 处写死的字号
> 因为 `src/styles.css` 整份被排除而完全不可见）。

### 已完成的波次

1. **规范落地**：按 frakio-work 实测规范写成本文件（令牌契约 + 组件语言 + 门禁 + 例外表）。
2. **机具**：`scan-ui.mjs`（9 条规则 + `--census/--json/--rule/--write-baseline`）、`codemod-tokens.mjs`（令牌化改写，默认 dry-run，只动 `style={{}}` 与 CSS，跳过含 `var(--` 的行与注释）、`codemod-icon-scale.mjs`（图标工具类 → `--icon-*` 刻度）、`codemod-css-fs.mjs`（CSS 字号 → `--fs-*` 刻度）。
3. **第 1 波**：478 处令牌化（色 409 / 圆角 32 / 字号 37）→ `fs-hardcoded`、`radius-offscale` 清零。
4. **第 2 波**：84 处淡色底边 → `color-mix(in srgb, var(--token) N%, transparent)`。
5. **补令牌**：`--fs-2xs`(11) / `--fs-display`(28) / `--fs-hero`(32) / `--overlay-backdrop(-strong)` / `--space-1..12` / `--radius-xs`(6px) / `--shadow-color` / `--presentation-backdrop` / `--icon-2xs..--icon-3xl` / `--pet-*`。
6. **门禁**：`src/test/ui-consistency.test.ts`（逐规则对比基线，只降不升；字号/圆角必须保持 0）。
7. **补样式**：Pipeline 下一步对话框、纠偏结果对比面板（此前类名无 CSS = 没样式）。
8. **间距归一**：`spacing-offgrid` 13 → 0（只对齐离格值，±1px）。
9. **CSS 色令牌化**：31 → 17（遮罩/底色/状态淡色）。
10. **第 10 波**：图标刻度 + 253 处「有类名没样式」清零（详见 §5 表）。
11. **第 11 波**：色值 70 处（CSS 17 + TSX 53）→ 0；15 处自建浮层 → 统一外壳；审计器精度修复（详见 §5 表）。
12. **第 12 波（本轮）**：宿主样式表纳入审计 + 592 处字号令牌化（详见 §5 表）。

### 下一轮的工作队列（按性价比排序）

1. **`src/styles.css` 的色值**（唯一还挂着按规则豁免的地方，数字不是 0 而是"还没量"）：
   实测 **231 行色值字面量**，按属性分布：`background` 97 / `color` 38 / `box-shadow` 36 / 简写与其余 60。
   频率最高的几组已定位好映射方向 ——
   `box-shadow: rgba(0,0,0,0.3)×12 / 0.4×8 / 0.08×3`（→ `--shadow-*` / `--shadow-color`）、
   `background: rgba(0,0,0,0.5)×7 / 0.6×6`（→ `--overlay-backdrop(-strong)`）、
   红系 `#f87171×5 / #ef4444×8 / #ff5050×3 / rgba(239,68,68,*)×11`（→ `var(--error)` + `color-mix`）、
   绿系 `#22c55e / #4ade80 / rgba(34,197,94,*)`（→ `var(--success)`）、
   蓝紫系 `rgba(99,102,241,*)×6 / #6366f1`（→ `var(--accent)` 家族）、
   琥珀系 `#ffa500 / #f59e0b / #e0a91f`（→ `var(--warning)`）、
   以及少数"自带调色板"（`#0d1117/#161b22/#21262d` 的 GitHub 暗色、关闭按钮的 Windows 红 `#e81123`）需要逐个判断是
   收敛到令牌还是写进例外表。做完这一波才能把 `styles.css` 从 ALLOWLIST 里彻底移除；
2. **50 个「内联样式过密」文件**：按钮/输入/卡片/空态/列表行改具名类（`inline-style-dense` 的唯一来源）；
3. **z-index 令牌化**：`modal-overlay`=200 与 `--z-modal`=1300 互相矛盾，`popover-shield` 的层级仍留在调用处（23 个 tsx 数值 + 13 个 CSS 层级）；
4. **重复定义收敛**：`styles.css` 内已有同名类被定义两次且取值不同（如 `.badge` 的圆角 10px vs 4px、
   `.workspace-tab` 的 11px vs 12px 字号 —— 后者已被第 12 波统一到 `--fs-sm`），需要新增一条「重复/冲突定义」审计规则；
5. **收尾**：门禁归零 → `CHANGELOG` / `README` / `PROJECT-GUIDE` / 本文件同步 → 升版本号 → 构建安装包 → 发布 Release。

### 已知例外（都写在 `scan-ui.mjs` 的 ALLOWLIST 里并附理由）

皮肤令牌源（`src/styles.css`、`src/styles/skin-*.css`、`src/core/theme/`）、PPT 生成内容配色（`src/core/knowledge/ppt-*`）、
大富翁游戏插件（自带美术语言）、图书馆角色调色板注释常量；
按规则豁免（带 `rules` 字段）：`AppErrorBoundary`（崩溃兜底页刻意全内联样式）、`ppt/PPTAdapter|PresentationMode`（整屏工作台/演示舞台）。
