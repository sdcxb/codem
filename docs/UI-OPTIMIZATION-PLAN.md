# UI 优化方案（第 166 轮，基于渲染/状态级审计）

> 依据：`docs/SIDEBAR-AUDIT-OPENBITFUN.md`（16 节，全部为实测数据）。
> **为什么前五轮"没有成效"**：前五轮改的是**令牌取值**（颜色、阴影阶梯、圆角刻度、对比度）；
> 而决定观感的是四件**结构**上的事：① 没有"浮起来"的层次 ② 行本体没有状态反馈
> ③ 没有行节奏（7 种行高）④ 侧栏与内容没有分界。这四件都不在令牌里。
>
> **本方案的每一项都给出**：问题（实测证据）→ 改法（`文件:行` + 具体数值）→ **验收指标（可机证）**
> → 门禁 + 变异自证 → 风险。度量脚本都在 `.preview-shot/`，可随时复跑。

---

## 0. 当前基线（改造前必须记下来的数字，后面每项都用它验收）

| # | 指标 | 当前实测 | 复跑脚本 |
| --- | --- | --- | --- |
| B1 | 侧栏 / 内容 **ΔL** | **0.0172**（对方 0.0328） | `_final-compare.mjs` |
| B2 | 会话行 hover **背景变化面积** | **0%**（整行 0.93%，只有尾部动作） | `_verify-area-and-metric.mjs` |
| B3 | 导航项 hover 背景变化面积 | 97%（对照：这才是"看得见"） | 同上 |
| B4 | 行距自相关（4 带宽） | 18/40.3/18/18px，只有 **1/4** 过线（对方 4/4 都是 30.0px） | `_verify-rhythm-robust.mjs` |
| B5 | 侧栏行高集合 | **7 种**：22 / 26 / 28.33 / 31.5 / 38 / 40.33 / 59.06 | 同上 |
| B6 | 相邻行间距取值 | **4 种**：0 / 4 / 8 / 16（对方统一 2px） | 同上 |
| B7 | 图标字形尺寸 | **4 种**：14(49) / 12(36) / 16(20) / 10(6)；`stroke-width: 2` 占 109/112 | `_audit-rest-1.mjs` |
| B8 | 面板 `.chat-panel` | 字号 **7 档**（含 13.3333px、12.25px）、字重 4、文字色 10、圆角 **10 种**（含 3 种逐角）、行高 16、内边距 23 | `_panel-detail.mjs` |
| B9 | 输入卡片 | 圆角 **0px**、阴影 **无**（类名却叫 `input-card-container`） | `_panel-detail.mjs` |
| B10 | 命中区 < 24px 的可交互元素 | **41 / 111**（如会话行 pin/delete **16×19**） | `_audit-rest-1.mjs` |
| B11 | 无名可交互元素 | 2+（标题栏按钮、`.sidebar-project-btn`） | `_audit-rest-4.mjs` |
| B12 | `aria-live` | **0 处**（流式输出没有播报） | `_audit-rest-1.mjs` |
| B13 | z-index 字面量 | **46 处**（`10` 出现 13 次）；令牌 64 处 | `_audit-rest-2.mjs` |
| B14 | 阴影阶梯 | **两套并存**：`--elevation-1/3/4` 仍被用 **8 处**（全在 `codem-ui.css`）+ `--shadow-*` 70 处 | `_audit-rest-3.mjs` |
| B15 | 动效 | 令牌覆盖其实**很好**（300 条 transition 里 289 走令牌）；差的是**属性与曲线**：侧栏 `transition: background var(--duration-fast) ease`（只动 background、用默认 `ease`） | `_audit-rest-3.mjs` |
| B16 | 滑窗（窄窗） | 700px 宽时侧栏自动收起为 0，无横向滚动 ⇒ **响应式基本可用**（这一项不是问题） | `_audit-rest-4.mjs` |
| B17 | 键盘 | 12 跳**全部有可见焦点环**（2px 强调色）⇒ 这一项合格 | `_audit-rest-4.mjs` |
| B18 | 皮肤几何 | 同一行在默认/hub/dream 下圆角是 **8 / 6 / 10**（行高相同）⇒ 皮肤各自重造几何 | `_audit-rest-4.mjs` |
| B19 | 内容态 | 空态 7 条规则 / 加载 8 条 / 错误 6 条 / 离线 2 条，**各自为政**，无共享组件 | `_audit-rest-4.mjs` |
| B20 | 外壳 | `.app`/`.app-content`/`.main-area`/`.chat-panel` **圆角 0、阴影 none、零间距** | `_shell-composition.mjs` |

---

## 1. 三个批次（每批一个版本、一次装机版复核）

| 批次 | 目标 | 版本 | 预期观感变化 |
| --- | --- | --- | --- |
| **P0** | 做出层次 + 修活状态 + 统一节奏 | 1.16.166 | **一眼可见**（"浮起来的纸面" + 行有反馈 + 侧栏变整齐） |
| **P1** | 角色化：文字/图标/动效/输入卡片 | 1.16.167 | 明显（层次清楚、细节不毛糙） |
| **P2** | 内容态 + 无障碍 + 治理（令牌收口、门禁） | 1.16.168 | 质感与稳健性（空/加载/错误态、键盘与读屏、防回归） |

---

## 2. P0：层次 + 状态 + 节奏（1.16.166）

### P0-0 内容做成"浮在 chrome 上的圆角纸面"（权重最高）

**问题**：`B20` —— 四块齐边矩形；对方是"整壳一层玻璃 + 一块左侧圆角 24px、带左缘阴影的纸面"
（`WorkspaceBody.scss:135–153`，圆角 token `layout-split-view-content-panel-radius` = 24px）。

**改法**（`src/styles.css`，`.app`/`.main-area` 附近：`.app` 在 `799`、`.main-area` 在 `1067`）：
1. 给 `.main-area`（或 `.chat-panel`）加：`border-radius: 24px 0 0 24px`；
   `box-shadow: -4px 0 12px -6px color-mix(in srgb, var(--text-muted) 8%, transparent)`；
   **暗色档单独加强**（8% 在暗底看不见）：`-5px 0 16px -7px color-mix(in srgb, #000 30%, transparent)`。
2. 材质档（`html[data-native-material="sidebar"]`，`18487`–`18635` 那一段）：
   **面板保持透明**，玻璃只留在壳那一层（现在是 88% 近白糊在 `.sidebar` 上）。
3. 侧栏与纸面之间补 **1 条 hairline**（`border-right: 1px solid color-mix(in srgb, var(--text-base) 8%, transparent)`），
   替换现在的 `rgba(31,31,30,0.05)`（≈不存在）。
4. 拖拽反馈：把 `.sidebar-resize-handle` 的反馈画成"纸面左缘的那条圆角描边"（hover/拖拽时淡入），
   而不是现在 4px 透明条、零反馈。

**验收**：`B1` ΔL **0.0172 → ≥0.028**；截图能检出纸面左上角曲线；`.main-area` 左两角非 0 且 `box-shadow` 非 none。
**门禁**：新增 **SHELL-1**（内容纸面必须左侧圆角 + 非 none 阴影 + 材质档面板透明）；变异 `SHELL1-去阴影` 必须红。
**风险**：圆角会露出容器底色 —— 所以必须同时把壳底色与纸面底色区分开（用 `--bg-secondary` 做壳、`--bg-primary` 做纸面），
这也是 ΔL 提升的来源。

### P0-1 修状态层（`src/styles.css:18615`）

**问题**：`B2`（背景 0% 面积变化）+ 材质档下 **hover 会把选中底顶掉**（选择器 (0,3,1) > `.active` (0,2,0)）+
工具簇行无 hover 却常驻紫底 + 全侧栏 `:active` 规则 **0 条**。

**改法**：
1. 把 `color-mix(in srgb, var(--sidebar-bg) 18%, transparent)` 换成**墨色遮罩**：
   `color-mix(in srgb, var(--text-base) 6%, transparent)`（hover）/ `10%`（按下）——
   亮色档变暗、暗色档变亮，两档都对（同色低 α 是这次 bug 的根因）。
2. **选中优先于 hover**：把该覆盖限制为 `.sidebar-session:not(.active)`，或把选中规则提到同一优先级之后。
3. **补全覆盖面**：`.sidebar-nav-item` / `.sidebar-project-header` / `.sidebar-tool-row` 一起纳入同一套状态令牌；
   工具簇行去掉**常驻** 8% 紫底（改成 hover/选中才出现）。
4. **加按下态**：全部行 `:active { transform: translateY(1px); background: var(--surface-pressed) }`。
5. **文字与图标跟着状态走**：行默认 `--text-secondary`，hover/选中升 `--text-primary`，图标同步（对方就是这么做的）。
6. 过渡改成 `var(--transition-color)`（我们已有：color/background-color/border-color + `.15s` + `cubic-bezier(.23,1,.32,1)`），
   并补 `transform 120ms`（对应 `--transition-transform`）。

**验收**：`B2` 会话行 hover **背景变化面积 0% → ≥35%**（导航项 97% 是参照）；
划过当前会话后选中背景**不变**；工具簇行 hover 可见；全侧栏 `:active` 规则 ≥1 条；
hover 时 label 与 icon 的计算色**必须变化**（现在三项全不变）。
**门禁**：新增 **STATE-1**（每条行类：hover/active/selected 至少改变一个可测信号；且**禁止"同色低 α 覆盖"**写法）；
变异 `STATE1-同色低α覆盖`、`STATE1-选中被hover顶掉`、`STATE1-无按下态` 必须红。
**风险**：低（都在材质/状态覆盖层里，不动组件结构）。

### P0-2 统一行节奏（一个 30px 常量）

**问题**：`B5`/`B6`/`B4` —— 7 种行高（3 个小数）、4 种行间距、4 个带宽里只有 1/4 检出周期。

**改法**（全部在 `src/styles.css` 的侧栏段）：
| 元素 | 现在 | 改成 |
| --- | --- | --- |
| `.sidebar-nav-item`（`1301`） | 40.33px / padding 10/12 | **height 30px** / `padding: 0 8px` |
| `.sidebar-session`（`1629`） | 31.5px / padding 6/8 | **height 30px** / `padding: 0 8px` |
| `.sidebar-project-header`（`1422`） | 38px / padding 8/8 | **height 30px** / `padding: 0 8px` |
| `.sidebar-tool-row`（`1322`） | 59px / padding 4/4 | **height 30px**（工具项改横向排布或收进二级） |
| `.sidebar-user-plugin-btn` | 28.33px | **height 30px** |
| `.sidebar-section-header` | 22px | **height 24px**（对方 token 就是 24） |
| 行间距 | 0/4/8/16 混用 | 统一 **2px**（列表 `gap: 2px`） |
| 行内边距 | 10/12、6/8、8/8 | 统一 `0 8px`；列表容器 `2px 6px` |
| 圆角 | 8/10/6 | 统一 `--radius-sm`(6px)，选中/hover 不换半径 |

**验收**：`B5` 行高集合 **7 → 2**（{30, 24}）；`B6` 行间距 **4 → 1**（2px）；
`B4` 行距自相关 **≥0.40 且主周期 30±2px，且 4/4 带宽都过线**。
**门禁**：新增 **RHYTHM-1**（侧栏行高集合 ⊆ {30,24}、行间距 ⊆ {2px}）；变异 `RHYTHM1-某个行高改回38` 必须红。
**风险**：行高从 40 → 30 会让侧栏一屏多出约 3 行（13 → 16 行），这是**加分**（对方 30px 就是更密）；
    但 30px 行里的 14px 文字要跟着降到 13px（见 P1-1），否则垂直居中会挤。

---

## 3. P1：角色化（1.16.167）

### P1-1 文字与图标角色化
- 侧栏字号 **5 档 → 3 档**（12 / 13 / 14），10px 的组标签并入 11px overline 角色（`--fs-2xs`）。
  顺带修掉刻度命名 bug：**`--fs-xs`(10) 比 `--fs-2xs`(11) 小**（名字与数值反了）——改名前先数消费方。
- 图标：字形 **4 种 → 1 种（14px）**，槽统一 **22px**（对方 `control-icon-button-xs-size`）；
  `stroke-width` 从硬编码 `2` 改成令牌 **1.6**（对方 `control-icon-stroke-width`）。
- 行默认文字色 `--text-secondary` → hover/选中 `--text-primary`（P0-1 已含）。
**验收**：`B7` 字形尺寸种类 **4 → 1**；`stroke-width` 取值集合 = {令牌}；侧栏字号档数 5 → 3。
**门禁**：新增 **ICON-1**（侧栏/面板内图标字形尺寸集合 ⊆ {14px}，描边走令牌）；变异 `ICON1-塞一个16px图标` 必须红。

### P1-2 输入卡片（composer）
- `B9`：`.input-area.input-card-container` 圆角 0 → **16px**（对方 `control-composer-radius`），
  补 `box-shadow`（对方有 `shadow-composer: 0 2px 12px rgba(0,0,0,.08)`）——我们可用 `--shadow-raise-2` 起步。
- 聚焦态：`.input-textarea-row:focus-within` 加**可见焦点面**（现在只有 border-color 过渡）。
**验收**：composer 圆角非 0、`box-shadow` 非 none；聚焦时边框色/阴影可测变化。

### P1-3 分组标题吸顶 + 排版角色
- `.sidebar-section-header`：`position: sticky; top: 0` + 吸住时浮出 hairline（对方 `is-stuck` 做法）；
  uppercase + `letter-spacing: .08em` + meta 字号，与行标签**明确区分**（现在两者同为 14px/400）。
**验收**：滚动后分组标题仍在视口内（DOM 断言）；分组标题与行标签的字号/字重/字距三者不全等。

### P1-4 面板一致性（把"几套尺子"收口）
- `B8`：面板字号 **7 → ≤4 档**（干掉 13.3333px、12.25px 这两个非整数值）；
  圆角 **10 → ≤4 种**（三种逐角写法改用"方向性圆角令牌"：如 `--radius-sheet-left`）；
  行高 16 → 收敛到间距刻度；内边距 23 → 收敛到 `--space-*`。
**验收**：`.chat-panel` 字号档数 ≤4、非整数字号 **0 个**、圆角种数 ≤4、逐角写法 0 处。
**门禁**：新增 **CONSISTENCY-1**（区域级档数棘轮，只许降）；变异 `CONSISTENCY1-塞第5档字号` 必须红。

### P1-5 阴影阶梯收口 + z-index 令牌化
- `B14`：`--elevation-1/3/4`（8 处，全在 `codem-ui.css:185,199,211,512,1122,1611,1864,2597`）并入 `--shadow-*` 阶梯。
- `B13`：z-index 字面量 **46 处**（`10`×13）改走 `--z-*`；`--z-top: 10000`、`--z-dialog: 1410`
  这种"临时数字"要收敛到 8 档层级（对方 `--openbitfun-layer-*` 就是 16 档具名层级）。
**验收**：`var(--elevation-` 用法 **8 → 0**；z-index 字面量 **46 → ≤10**（棘轮只许降）。

---

## 4. P2：内容态 + 无障碍 + 治理（1.16.168）

### P2-1 内容态共享组件
- `B19`：空态 7 / 加载 8 / 错误 6 / 离线 2 条规则，各自为政。
  做三个共享组件（或共享类）：`Empty`（图标 + 主文案 + 次文案 + 可选行动）、
  `Skeleton`（骨架行，`--duration-slow` 呼吸）、`StatusBanner`（错误/离线/重连，含 retry 槽），
  然后逐处替换（`.empty-state` / `.mp-empty-hint` / `.notebook-empty-state` / 各 spinner / 各 retry 按钮）。
**验收**：空态/加载/错误三类各只保留 **一个** 共享实现（门禁统计各实现的出现次数：新增只许用共享类）；
三类各自的 `min-height`/`padding`/字号统一（值为同一令牌）。

### P2-2 无障碍
- `B10`：命中区 < 24px 的可交互元素 **41 → 0**（会话行 pin/delete 16×19 → 至少 24×24；
  用 `::before` 扩大命中区而不是把图标画大，对方就是这么做的：图标小、命中区大）。
- `B11`：给无名可交互元素补 `aria-label`（标题栏按钮、`.sidebar-project-btn`）。
- `B12`：`aria-live` **0 → ≥1**（流式输出/状态变化区）；给侧栏会话列表加 `role="list"`/`listitem` 语义。
- 保持 `B17` 的合格项（焦点环全覆盖）——**已有门禁不要放松**。
**验收**：命中区 < 24px 计数 **41 → 0**；无名可交互元素 **2 → 0**；`aria-live` ≥1。
**门禁**：扩充 `min-hit-area` 用例覆盖全站可交互元素；新增 **A11Y-NAME-1**；变异 `A11Y1-删掉一个aria-label` 必须红。

### P2-3 皮肤几何收口（`B18`）
- 把"行高/内边距/圆角"从皮肤文件里拿掉（皮肤只覆盖**颜色与阴影**，几何一律继承主样式表），
  这样同一行在默认/hub/dream 下半径一致（现在 8/6/10）。
**验收**：三个皮肤下行高/圆角/内边距**完全相同**；皮肤文件里 geometry 声明数 **→ 0**（颜色声明保留）。
**门禁**：**SKIN-3**（皮肤文件不得声明 height/padding/gap/border-radius/font-size）；变异 `SKIN3-皮肤里改行高` 必须红。

### P2-4 动效属性收口（`B15`）
- 把 `transition: background var(--duration-fast) ease`（`styles.css:1314` 等 4 处侧栏行）换成
  `var(--transition-color)`（我们**已有** color/background/border + `.15s` + `cubic-bezier(.23,1,.32,1)`），
  并给行列补 `transform 120ms`（按下位移）。**全站字面量只剩 11 条，其中 5 条是 `none`/`0ms` 的降级，属正常**。
**验收**：侧栏行的 transition 必须包含 `color`（不只 background）且曲线 = `var(--ease-out)`；
字面量曲线（`ease`）在侧栏段归零。

---

## 5. 落地顺序与节奏

1. **1.16.166 = P0-0 + P0-1 + P0-2**（一次性出包，观感变化最大；三项互相依赖：
   纸面要配 30px 行节奏才不空，状态层要在材质档统一口径才能一次修好两档）。
2. **1.16.167 = P1 五项**（角色化与收口）。
3. **1.16.168 = P2 四项**（内容态、无障碍、皮肤几何、动效属性）。
每批都跑：`npm run verify` + `npm run audit` + 五个变异脚本 + `npm run tauri:build` + 静默安装 + **装机版复核**
（用 `_verify-1163-installed.mjs` 那套 + 本方案新增的度量脚本），并把 **B1–B20 的前后对照**写进 CHANGELOG。

---

## 6. 明确**不**照抄对方的（避免为了对标而破坏自己）

| 不抄 | 理由 |
| --- | --- |
| 把中性色阶从"墨+纸派生"改成"参考色板 + 语义别名" | 我们的派生体系是第 159 轮 P1-2 的解耦成果，换成色板反而回到"每套皮肤手工挑三档" |
| `duration-base`(220ms) 在减少动效下不归零 | 那是对方的已知缺口（143 次引用），不是优点 |
| 侧栏 300px 默认宽 | 我们 260px 与内容比例已经合适；对方截图里实际也是 220px |
| 他们的分区/目录（设备互联、MiniApps、ACP） | 产品结构不同，只借"层次怎么表达" |
| 一次性把 43 个组件重写成 CSS Modules | 成本极高；本方案走"**先修结构与状态、再逐项收口**"的路线，不重写架构 |

---

## 6.5 **已经合格、本轮不要动的**（这一节同样重要：避免把力气花在已经对的地方）

| 项 | 实测结论 | 出处 |
| --- | --- | --- |
| 浮层（菜单/下拉/提示/Toast） | 玻璃配方 `blur(12px) saturate(1.2)`、圆角 10px、1px 环 + 柔和投影、入场 `0.15s cubic-bezier(.23,1,.32,1)` —— **与对方同级** | §17 |
| 焦点环 | 12 跳 Tab **全部**有可见焦点环（2px 强调色），顺序合理 | §18 |
| 长文本截断 | 会话标题 `ellipsis + nowrap`，注入 3 倍长文本后**行高不变、无溢出** | §21 |
| 响应式收起 | 700px 视口下侧栏自动收起为 0，无横向滚动，被裁剪元素 ≤5 | §19 |
| 动效令牌覆盖率 | 300 条 transition 里 **289 条走令牌**；`--ease-out` 与对方标准曲线**同值** | §16 |
| 图标颜色 | 109/112 用 `currentColor`，**字面色 0** | §15 |
| 高对比/密度两档 | 1.16.165 已补全（含令牌级覆盖与实测对比度） | CHANGELOG 1.16.165 |

> **换句话说**：问题**集中在"外壳层次 + 侧栏/面板的几何与状态 + 缺少共享内容态组件 + 少量治理债"**，
> 不是"到处都差"。这也解释了为什么前几轮"改令牌"看不到变化——令牌层本来就大体健康。

---

## 7. 度量仪表盘（每批出包后复跑这 6 个脚本，和基线逐项对照）

| 脚本 | 盯的指标 |
| --- | --- |
| `_final-compare.mjs` | B1 ΔL、边界台阶、边缘密度、行距 |
| `_verify-area-and-metric.mjs` | B2/B3 hover **变化面积**（不是 maxΔRGB） |
| `_verify-rhythm-robust.mjs` | B4/B5/B6 行距 4 带宽 + 行高/间距集合 |
| `_panel-detail.mjs` | B8/B9 面板档数与 composer 几何 |
| `_audit-rest-1.mjs` | B7 图标、B10 命中区、B11/B12 无障碍 |
| `_shell-composition.mjs` | B20 外壳圆角/阴影 |

> 判据口径（避免又量错）：**可见性用"变化面积占比"**，**节奏用"多带宽一致性"**，
> **几何用 DOM 真值**（统计只做辅证），**对标值优先用 token**（拿像素反推必须记录不确定性）。
