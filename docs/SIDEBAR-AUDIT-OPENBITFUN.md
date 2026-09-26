# 侧栏/外观对标审计（2026-09-26，第 166 轮）

> **为什么要重做一次审计**：前五轮（1.16.155–1.16.165）我一直在比**令牌取值**（颜色、阴影阶梯、
> 圆角刻度、对比度），用户反馈"多轮整改之后没有任何成效，左侧边栏还是不好看"。
> 这句话是对的，而且原因很具体：**决定"好不好看"的是行的几何、状态的表达、表面的分界与信息层级，
> 这些东西一个都不在令牌里**。这一轮换成量**渲染结果**与**交互状态**，结论和上一轮完全不同。
>
> 所有数字都是脚本量出来的（脚本见文末"附：测量方法"），不是看图说话。

---

## 0. 四条结论（第 166 轮自审后修订；第 4 条是这一轮**新发现**、且权重最高）

0. **【新】没有任何一层"浮起来"**：对方的内容区是一块**圆角 24px（左侧两角，token 值）+ 左缘阴影**的"纸面"，
   浮在**整壳一层玻璃**之上（`WorkspaceBody.scss:37–46, 135–153`）；
   我们 `.app` / `.app-content` / `.main-area` / `.chat-panel` **全部圆角 0、阴影 none、零间距**
   —— 四块齐边矩形拼在一起，只有一条 5% 的细线。
   **这一条跟"改什么颜色"无关，所以前五轮改令牌再怎么改都不会有观感变化。**
1. **侧栏的"状态层"是坏的**：在用户机器真正运行的那一档（Mica 材质）里，**会话行与工具簇行的 hover
   背景实测 0% 面积变化**（只有尾部动作按钮淡入，整行约 1% 面积）；鼠标划过**当前会话时选中底被覆盖**
   （**仅材质档**）；工具簇行**常驻**紫底 + inset 阴影 ⇒ 永远像"选中"。侧栏里数量最多的就是会话行。
2. **侧栏没有行节奏**：DOM 真值 **7 种行高**（3 个是小数）、**4 种相邻间距**（对方统一 2px）；
   像素侧 4 个带宽里对方稳定检出 **30.0px**，我们只有 1/4 带宽过线。
3. **侧栏与内容之间没有分界**：ΔL 我们 **0.0172** / 对方 **0.0328**（浅色档；暗色档我们 0.0416 反而够）。
   亮度层级数 220 vs 82 —— 不是层次更丰富，是**碎片噪声**更多。

---

## 1. 关键对照表（全部实测）

| 指标 | OpenBitFun（官方截图 2568×1672 @2×） | 我们（装机版 1.16.165，3840×2016 @3×） |
| --- | --- | --- |
| **内容是不是"浮起的纸面"** | **是**：左侧两角圆角 **24px**（token `layout-split-view-content-panel-radius`）+ 左缘阴影 | **不是**：`.main-area`/`.chat-panel` 圆角 **0px**、阴影 **none**、与侧栏/顶栏**零间距** |
| **玻璃在哪一层** | **整壳一层** `__material`（90% + 模糊 + 内高光），面板透明；原生材质档交给系统 | **糊在面板自己身上**（88% 近白 + 关掉 CSS 模糊），没有独立材质层 |
| 侧栏宽度 | 300px 默认 / 折叠 76px（token 里另有一个 216px，与产品代码不一致） | 260px（DOM 实测），无折叠态 |
| 侧栏宽度（截图检测） | 220 CSS px（窗口 1284 ⇒ 17.1%；与 token 216px 吻合，说明截图那台是窄侧栏） | 260 CSS px（窗口 1280 ⇒ 20.3%） |
| 侧栏 vs 内容 **ΔL** | **0.0328** | **0.0172** |
| 边界台阶强度 | 0.0308 | 0.0314 |
| 侧栏内部最大台阶 | 0.0313（在 x=40） | **0.0357（在 x=68）⇒ 比边界还强** |
| 侧栏边缘密度 | 0.0195 | 0.0179 |
| 侧栏亮度层级数 | **82** | **220** |
| **行距（4 个带宽的检出）** | **四个带宽都是 30.0px**（与 token `layout-navigation-panel-item-height` = 30px 一致 ✅） | 18 / 40.3 / 18 / 18（只有 1/4 过线 ⇒ 无稳定周期） |
| 行高种类（DOM 真值） | **1 种**（30px；分组标题 24px） | **7 种**（22 / 26 / 28.33 / 31.5 / 38 / 40.33 / 59.06，**3 个是小数**） |
| 相邻行间距 | 统一 **2px** | **4 种**：0 / 4 / 8 / 16 |
| 行 hover 反馈 | 底色换令牌（整块）+ 文字/图标升一级 + 尾部动作淡入 | 导航项/项目行整块变（97% 面积）；**会话行/工具簇行背景 0% 变化** |
| 字号档数（侧栏内） | 语义角色（label-md / label-sm / meta / micro）+ 行默认 **次级文字色** | **5 档**（10/11/12/13/14）+ 所有行默认**主文字色** |
| 图标 | 字形统一 **14px**、槽 **22px**、有 stroke 令牌 | **3 种尺寸**（导航项 16px/槽 20px、会话行 12px 无槽、项目行 12px、工具簇 16px、插件按钮 14px）、`stroke-width: 2` |
| 圆角 | 统一 `radius-base`（6px） | 8 / 10 / 6 / 0 混用 |
| 行内边距 | 行 `0 8px`；列表 `2px 6px`；外层 `6px` | 行 10/12、6/8、8/8；容器 4/12、12/16、8/12 |
| 行间 gap | `space-1/2` = 2px | 未设（靠 padding 撑） |
| 行过渡 | 120ms，**background + color + opacity + transform**，`cubic-bezier(0.23,1,0.32,1)` | 0.2s ease，**只有 background** |
| 按下态 | pressed 令牌 + `translateY(1px)` | **全侧栏 `:active` 规则 0 条** |
| 侧栏材质 | **整壳一层玻璃**（`__material` + `sidebar-glass` 90%，面板透明；原生材质档交给系统） | **糊在面板自己身上**（88% 近白 + 关掉 CSS 模糊），没有独立材质层 |
| 分界线 | 全侧栏 **4 条 hairline**（顶动作区底、底栏顶、底动作条顶、吸顶标题） | `border-right: rgba(31,31,30,0.05)`（≈看不见） |
| 搜索入口 | 有（34px 行 + 快捷键提示） | **无** |
| 分组标题 | **sticky 吸顶**，吸住时浮出 hairline；uppercase + tracking-wider | `position: static`（**不吸顶**） |
| 状态点/树导轨/选中指示条 | 有（6px 状态点 + 发光/脉冲；子会话 `1px×50%`+`10px×1px` 导轨；选中 `2px×14px` 指示条） | **都没有** |

---

## 2. 状态层：三个可机证的缺陷（这是"看着死"的主因）

> ⚠️ **本节结论已按第 166 轮自审修正**（见 §9）。第一版有两处说得过头，修正后如下：
> ① 不是"整行一个像素都不变"，而是**行本体的背景 0% 面积变化**、只有尾部动作按钮淡入（整行约 1% 面积）；
> ② "hover 抹掉选中底"**只在材质档成立**（无材质档时选中底保得住）。
> 这两条都是**先量错了指标**（用 maxΔRGB 而不是"变化面积"）造成的，实测数字见下表。

测量方式：派发**真实鼠标事件**（`Input.dispatchMouseEvent`）后截该行**整块矩形**做 diff，
并单独量**行的左半段**（不含尾部动作区）以隔离"背景本身"的变化。
（⚠️ 截图是 device 像素，DPR=3 —— 第一版没换算比例，得到"所有行 hover 都看不见"的**假结论**，已修正。）

| 行 | 整行强变化面积 | **左半段（背景本体）** | 左半段平均 Δ | 判定 |
| --- | ---: | ---: | ---: | --- |
| 导航项（新对话/知识笔记本/任务管理） | **97.0%** | **94.6%** | 12.4 | ✅ 整块底色变化，真·可见 |
| 项目行 | **96.7%** | **94.1%** | 13.2 | ✅ 同上 |
| **会话行（未选中）** | 0.93% | **0%** | **0.02** | ❌ **背景完全没反应**，只有尾部动作淡入 |
| **工具簇行（MCP技能记忆智能体）** | 1.23% | **0%** | **0.02** | ❌ 同上（且常态常驻 8% 紫底） |
| 会话行（选中） | 24.9%（平均 Δ 23.3） | — | — | ❌ 紫色选中底**被 hover 覆盖**（见下） |

**去掉 `data-native-material` 再量同一行**：会话行 hover ΔL = **0.0440 ✅ 看得见**（背景整块变 `#eeeeec`）。
⇒ 问题**确定**来自材质档那条覆盖，而不是"整套 hover 都没写"。

> 方法教训：`maxΔRGB` 会骗人 —— 尾部动作按钮淡入只影响约 1% 的像素，却能把 maxΔRGB 顶到 **152**。
> 判断"有没有反馈"必须看**变化面积**；只看 max 会把"局部有个小图标亮了"误判成"整行都变了"。

### 2.1 根因：`src/styles.css:18615-18618`

```css
html[data-native-material="sidebar"] .sidebar-session:is(:hover, :focus-visible),
html[data-native-material="sidebar"] .sidebar-tool-item:is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--sidebar-bg) 18%, transparent);
}
```

三处硬伤，一处比一处严重：

1. **方向错了**：`--sidebar-bg` 是 `#fbfbfa`，而侧栏本身在材质档就是"88% 的 `#fbfbfa`"。
   用**同一个颜色**的 18% 去叠它自己 ⇒ 合成结果与底色差 ≈ 0.001 级，**数学上就看不见**。
   （正确做法是叠"墨色的低α"：`color-mix(in srgb, var(--text-base) 6%, transparent)` —— 亮色变暗、暗色变亮，两档都对。）
2. **优先级压过了选中态**（**仅材质档**，已分档验证）：这条选择器是 `(0,3,1)`，而 `.sidebar-session.active` 是 `(0,2,0)`
   ⇒ 鼠标一碰到当前会话，紫底就被这条"看不见的白纱"顶掉。**"选中态一碰就消失"是个功能级 bug，不只是不好看。**
   分档实测：无材质档时 hover 前后选中背景一致（`color(srgb .396 .333 .878 / .15)` 不变）；
   材质档时被换成 `color(srgb .984 .984 .980 / 0.18)`。
   注：无材质档下两条规则**同优先级**（都是 `(0,2,0)`），靠"`.active` 写在文件更后面"才赢 —— 也就是说
   **这个 bug 不是靠设计避免的，是靠源码顺序侥幸躲过的**；任何人把 `.active` 那条往前挪，非材质档也会中招。
3. **覆盖面不全**：只盖了 `.sidebar-session` 与 `.sidebar-tool-item`，`.sidebar-nav-item` /
   `.sidebar-project-header` / `.sidebar-tool-row` / `.sidebar-user-plugin-btn` 都没被覆盖
   ⇒ 同一个侧栏里，一部分行有 hover、一部分没有（工具簇行还有**常驻** 8% 紫底 + inset 阴影，永远像"选中"）。

### 2.2 状态表达只有"一层"

- 全侧栏 `:active` 规则 **0 条**（脚本在 CSSOM 里全量检索）⇒ 没有任何按下反馈。
- 行的 `transition` 只有 `background 0.2s ease`（对方是 background+color+opacity+transform 120ms）。
- **hover 只改背景，不改文字色/字重/图标色**（实测 color/fw/iconColor 三项全不变）。
  对方是双信号：底色 + 文字/图标从 `content-secondary` 升到 `content-primary`。
- **选中只有"15% 紫底"这一种表达**：没有指示条、没有字重变化、没有图标色变化。
  对方：hover 与选中**是两套不同令牌**（`action-neutral-surface` vs `selection-surface`），
  主航行项选中还额外带一条 **2px × 14px 的指示条**（`left: 3px`，pill 圆角，主色）。
- 我们所有行**默认就是主文字色** `#1f1f1e`（导航/会话/项目全一样）⇒ 状态**没有可提升的余地**；
  对方行默认次级色，hover/选中才升主色 —— 这就是"层次感"的来源。

---

## 3. 行的几何与节奏：一个侧栏五套尺子

| 元素 | 行高 | 内边距 | 圆角 | 字号 | 图标 |
| --- | --- | --- | --- | --- | --- |
| `.sidebar-nav-item` | **40.33** | 10/12 | 8px | 14px | 16px |
| `.sidebar-session` | **31.5** | 6/8 | 6px | 13px | 12px |
| `.sidebar-project-header` | **38** | 8/8 | 6px | 14px | 12px |
| `.sidebar-tool-row` | **59** | 4/4 | 10px | 14px | 16px |
| `.sidebar-user-plugin-btn` | **28.33** | 6/10 | 8px | 12px | 14px |
| `.sidebar-user-area` | **50** | 8/12 | 0 | 14px | ? |
| 分组标题 `.sidebar-section-header` | 22 | 0 | 0 | **14px/400（与行标签同大小同字重）** | — |
| 组小标签 `.sidebar-session-group-label` | 26 | 8/12/4/12 | 0 | **10px/500** | — |

问题不是"某一行难看"，而是：**扫视时眼睛找不到节拍**。DOM 真值（不需要任何统计）：

- 侧栏内**行高共 7 种**：`22 / 26 / 28.33 / 31.5 / 38 / 40.33 / 59.06`（**3 个是小数**）；
- **相邻行间距共 4 种取值**：`0 / 4 / 8 / 16`（对方统一 `2px`）；
- 一屏 628px 里完整可见 **13 行**。

像素侧辅证按**4 个不同带宽各量一次**（避免"一个数字定结论"）：

| 带宽 | OpenBitFun | 我们 |
| --- | --- | --- |
| 0.08–0.92 | **30.0px** r=0.534 | 18px r=0.147 |
| 0.12–0.60 | **30.0px** r=0.564 | 40.3px r=0.121 |
| 0.25–0.95 | **30.0px** r=0.413 | 18px r=0.242 |
| 0.35–0.85 | **30.0px** r=0.245 | 18px r=0.312 |
| 结论 | **四个带宽都检出同一个 30px**（与其源码常量 30px 一致 ⇒ 度量可信） | 检出值在 18/40.3 之间跳，只有 1/4 带宽过线 ⇒ **没有稳定周期** |

（度量灵敏度也验证过：合成"均匀 30/31.5/40px"剖面一律得 r=0.999，合成"我们这种混合节奏"得 r=0.491
⇒ 这个度量不是"天生给低分"，我们在真实截面上更低是真实差异。）

**容器也是三套内边距**：`.sidebar-nav` 4/12、`.sidebar-section` 12/16、`.sidebar-user-area` 8/12
⇒ 左边缘上，导航项、会话行、项目行的文字起点**各不相同**（实测：容器 0 内边距，内容从 12/16 px 起）。

---

## 4. 表面与边界：侧栏没有"读成外壳"

- 材质档侧栏 = `color-mix(in srgb, #fbfbfa 88%, transparent)`（近白、88%）+ **CSS 模糊被关掉**。
  既没有玻璃的通透（88% 基本不透），又丢掉了实色的干净边界。
- `border-right: 1px solid rgba(31,31,30,0.05)` ⇒ 5% 黑的线在近白面上约等于不存在。
- 结果：**ΔL 0.0172**（对方 0.0328），而且**边界台阶（0.0314）弱于侧栏内部最大台阶（0.0357，在 x=68）**
  ⇒ 侧栏和内容之间的分界，**不是这块区域里最显眼的结构**。
- 对方的做法**不是"不用玻璃"，而是"玻璃不在面板上"**（见 §13.1，这一条第一版说错了，已更正）：
  他们有一层**整壳的玻璃材质层**（`__material`，`sidebar-glass` = 90% + 模糊 + 内高光），
  导航面板自己**是透明的**，材质由那一层负责；`data-openbitfun-native-material='sidebar'` 时那层转透明，交给系统材质。
- 他们的**区块分隔**：全侧栏只有 **4 条 hairline**（顶动作区底、底栏顶、底动作条顶、吸顶标题），行与行之间**没有分隔线**；
  层次靠"行高常量 + 分组呼吸（`margin-bottom: space-3`）"建立，而不是靠加线。
- 容器是 `radius-base`（6px）圆角 —— 与 §13 的"内容纸面"同一套半径。

> 这一条解释了我前几轮"把玻璃做出来"为什么反而更糊：**我们把玻璃糊在面板自己身上（88% 近白），
> 而对方把玻璃放在整个壳的一层里、面板保持透明、再用一块圆角纸面把内容抬起来**。
> 玻璃只有配上"纸面抬升 + 明确边界"才是加分项。

---

## 5. 排版与层次

- **字号 5 档**（10/11/12/13/14），其中 **10px 是组标签**（`--fs-2xs`）—— 低于舒适阅读尺寸。
- **字重 3 档**（400 / 500 / 600），但用得很随意：分组标题 `.sidebar-section-header` 是 **14px/400**，
  与行标签**完全同级**；真正做层级区分的是另一个 10px 的小标签。**两个"分组标题"两种风格。**
- 分组标题**没有 uppercase、没有 letter-spacing、不吸顶** ⇒ 滚下去以后不知道自己在看哪个分组；
  对方是 sticky + 吸顶浮出 hairline + uppercase + tracking-wider + meta 字号。
- 文字色角色：行 = 主文字色、组标签 = 弱文字色 —— 只有两档，且**行本身没有状态色阶**（见 §2.2）。

---

## 6. 信息架构与"结构性装饰"（对方有、我们没有）

| 项 | 对方 | 我们 |
| --- | --- | --- |
| 搜索入口 | 34px 行 + 快捷键提示（`MainNav.tsx:356–382`） | 无 |
| 会话状态点 | 6px 点 + 发光 + 连接中脉冲动画 | 无 |
| 子会话树导轨 | `1px×50%` 竖线 + `10px×1px` 横线 | 无（靠缩进） |
| 选中指示条 | 2×14px，`left:3px`，pill | 无 |
| hover 揭示尾部动作 | 尾部格淡入 + 标题预留 padding 过渡（避免跳动） | 有类似（`.sidebar-session-actions`）但只在 hover 显形，无明显过渡 |
| 图标交叉淡入 | 默认图标↔hover 图标 opacity/scale 交叉 | 无 |
| 弹层进入动效 | 150ms `cubic-bezier(0.23,1,0.32,1)` + `scale(0.98)` | 无统一动效令牌 |
| 滚动条 | 由组件 `ScrollArea` 统一提供 | 侧栏内**没有**自己的滚动条规则（全站 33 条 `scrollbar-*` 都在别处，侧栏 0 条）|

---

## 7. 修复方案（带验收指标）

> 每条都给出**可机证的验收数字**，用本轮这套仪器复测。

### P0（按"用户能看见多少"排序；第 0 条是本轮新发现，权重最高）

0. **做出一层"浮起来的内容纸面"**（§13.3，本轮新增）—— 这是"面板看着廉价"的第一原因：
   - `.main-area` / `.chat-panel`：左侧两角圆角 **24px**（对方 token `layout-split-view-content-panel-radius` 就是 24px；
     我们要更小也必须取**一个现有档**，别现编）、
     `box-shadow: -4px 0 12px -6px color-mix(in srgb, var(--text-muted) 8%, transparent)`（暗色档要加强，8% 在暗底上看不见）；
   - 玻璃层与面板分离：材质档下面板**保持透明**，玻璃只留在壳那一层（我们现在是把 88% 近白糊在 `.sidebar` 上）；
   - 拖拽反馈画在纸面的圆角边上（我们 `.sidebar-resize-handle` 是 4px 透明条，**零反馈**）；
   - **验收**：`.main-area` 左两角非 0 + `box-shadow` 非 none；侧栏/内容 ΔL **0.0172 → ≥0.028**；截图上能检出纸面左缘的阴影剖面。

1. **修状态层**（改 `src/styles.css:18615` 那条覆盖）
   - 把"同色低α"改成"**墨色低α**"：`color-mix(in srgb, var(--text-base) 6%, transparent)`
     （hover）/ `10%`（按下）/ 选中用 `--accent-muted` + 指示条；
   - **让选中态优先于 hover**（用 `:not(.active)` 或提高选中选择器优先级）；
   - 把工具簇行接上 hover（去掉常驻紫底，改成 hover/选中才出现）；
   - 加按下态：全部行 `:active { transform: translateY(1px) }`。
   - **验收**：会话行 hover ΔL **0.0000 → ≥0.035**；"鼠标划过当前会话"后选中底**仍在**（像素差 < 3）；
     全侧栏 `:active` 规则 ≥1 条。
2. **统一行节奏（一个常量贯穿）**
   - 行高统一 **30px**（分组标题 22px）；行内边距 `0 8px`；列表 `2px 6px`；行间 `gap: 2px`；
     圆角统一 **6px**；图标字形统一 **14px**、槽 **22px**（`stroke-width` 收到令牌）。
   - 容器左内边距统一 **6px**（行内再 8px ⇒ 文字起点 14px 一致）。
   - **验收**：行距自相关 **r=0.151 → ≥0.40 且主周期落在 30±2px**；行高去重后只剩 {30, 22}。
3. **把分界做出来**
   - 材质档：侧栏不再用"和内容同色的 88% 玻璃"，改为**接近不透明**（≥96%）或实色；
     并补一条 **1px hairline**（`color-mix(in srgb, var(--text-base) 8%, transparent)`）。
   - **验收**：侧栏/内容 **ΔL 0.0172 → ≥0.028**；边界台阶**强于**侧栏内部最大台阶。

### P1（层次与角色）

4. **文字角色化**：行默认 `--text-secondary`；hover/选中升 `--text-primary`；图标同步（并带 120ms 过渡）。
   验收：hover 时 label 与 icon 的 computed color 必须变化（现在**三项全不变**）。
5. **分组标题**：吸顶（`position: sticky` + 吸住时浮出 hairline）+ uppercase + `letter-spacing: 0.08em` + meta 字号；
   与行标签彻底分开。验收：滚动后分组标题仍在视口内（DOM 计数）。
6. **排版收口**：侧栏字号压到 3 档（12 / 13 / 14），10px 组标签并入 11px overline 角色。

### P2（"精致感"的信号）

7. 搜索行（34px + 快捷键提示）；会话状态点（6px + 发光）；子会话树导轨；选中指示条（2×14px）；
   动效令牌（120ms `cubic-bezier(0.23,1,0.32,1)`）统一到 `--duration-*` / `--ease-*`；
   侧栏滚动条并入统一 `ScrollArea` 样式。

---

## 8. 明确不建议照抄的

- 对方的 `--openbitfun-space-*` / `--type-*` 具体数值**不在我们抓到的文件里**（他们 token 文件未随附），
  所以"8px 就是他们的 space-2"这类只能靠注释锚点推断 —— 我们**只采纳结构关系**（一个 30px 行常量、
  行内 8px、列表 6px），不假装知道他们每个数值。
- 他们的**分区/目录结构**（设备互联、MiniApps、ACP、多端）与我们产品不同，不照搬组成，只借"层次怎么表达"。

---

## 9. 自审：第一版结论哪些站得住、哪些被推翻

| # | 第一版结论 | 复核结果 | 修正后的准确说法 |
| --- | --- | --- | --- |
| 1 | "会话行 hover **一个像素都不变**" | **推翻（措辞）** | 背景本体 **0% 面积变化**，但整行有 **0.93%** 面积变化 = **尾部动作按钮淡入**。准确说法：**行本体没有反馈，只有行的右端多出一小簇图标** |
| 2 | "工具簇行没有任何 hover" | **部分推翻** | 行背景 0% 变化；整行 1.23%（内部有元素响应）。准确说法：**行本体无反馈** |
| 3 | "hover 抹掉选中底" | **成立但要分档** | **只在材质档成立**；无材质档时选中底保得住（靠"写在文件更后面"侥幸赢，不是设计保证） |
| 4 | "侧栏没有稳定行节奏（r=0.151）" | **成立且加强** | 4 个带宽里对方稳定检出 30.0px、我们只有 1/4 过线；DOM 真值更硬：**7 种行高 + 4 种行间距** |
| 5 | "ΔL 0.0172 vs 0.0328" | **成立** | 但需补一句：**这是"我们的浅色档 vs 他们的浅色档"**；我们的**暗色档 ΔL = 0.0416（反而够）** —— 见 §12 |
| 6 | "对方侧栏不用玻璃" | 成立（本批 13 个文件内 `sidebar-glass`/`sidebar-overlay` 零引用） | 已单独再全仓检索一次，见 §13.2 |
| 7 | 侧栏宽度 260 vs 220 | 成立 | 我们是 DOM 实测；对方是从截图检出的台阶（x≈218–222，左右 100px 均值 0.968 vs 1.000） |

**两处方法错误（已修正，写在这里防止复发）**：

1. **用 `maxΔRGB` 判断"有没有反馈"是错的** —— 尾部动作淡入只影响约 1% 像素，却能把 maxΔRGB 顶到 152。
   判断可见性要量**变化面积**（≥8 灰阶的像素占比）。
2. **统计量必须做稳健性检查再做结论** —— 行距只量一个带宽就下结论，风险很高；这次 4 个带宽一起量，
   并且先用合成剖面（已知节奏）验证度量灵敏度，才敢说"我们确实没有稳定周期"。

---

## 10. 覆盖度矩阵（第 166 轮两阶段：先审侧栏/面板，再补齐其余）

| 维度 | 状态 | 在哪一节 |
| --- | --- | --- |
| 侧栏：几何一致性（行高/圆角/内边距/字号档数） | ✅ 深（DOM 真值 + 像素辅证） | §3 |
| 侧栏：状态覆盖（hover/按下/focus/选中） | ✅ 深（真实指针 + 像素**面积** + 分档 A/B） | §2 |
| 表面与边界（ΔL、台阶强度、亮度层级） | ✅ 浅色 + 暗色 | §4、§12 |
| **外壳构图**（纸面/材质层/拖拽反馈/折叠） | ✅ 源码 + 截图剖面 | §13 |
| 令牌体系（规模/排版角色/动效/阴影/间距/控件） | ✅ 对方 token 全量 + 我方实测 | §14 |
| 图标系统（尺寸/描边/颜色/统一入口） | ✅ 活体实测（112 个 svg） | §15 |
| 动效（覆盖率/曲线/属性/减少动效） | ✅ 活体实测（300 条 transition） | §16 |
| 弹层（模态/浮层/菜单/提示/Toast + z-index/阴影阶梯） | ✅ 真实点开 + CSSOM | §17 |
| 键盘与无障碍（焦点顺序/焦点环/命中区/可访问名/ARIA） | ✅ 12 跳实测 + 属性计数 | §18 |
| 响应式/窄窗 | ✅ 三档视口实测 | §19 |
| 皮肤几何（hub/dream） | ✅ 三套对比实测 | §20 |
| 内容态（空/加载/错误/离线）与长文本截断 | ✅ 规则盘点 + 注入实测 | §21 |
| 面板/内容区一致性 + 输入区解剖 | ✅ 计数 + DOM 链 | §11 |
| 读屏软件真实走查 | ❌ **未做**（只有属性计数） | §22 |
| 触屏/触摸手势、高 DPI 缩放（125%/150%） | ❌ **未做** | §22 |
| 多语言文案长度压测（只有中文界面） | ❌ **未做** | §22 |
| 第三方嵌入（编辑器/终端）观感、窗口外壳深层 | ❌ **未做** | §22 |
| 动态内容态（流式输出时的行高抖动、长任务下的侧栏状态） | ❌ **未做** | §22 |

---

## 11. 面板/内容区：同样的病，而且更重

用同一套"一致性计数"量（不需要对标截图就能看出问题）：

| 区域 | 元素 | 字号档数 | 字重 | 文字色 | 圆角种数 | 行高种数 | 内边距种数 | 阴影种数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 侧栏 `.sidebar` | 143 | 5 | 3 | 4 | 4 | 13 | 13 | 2 |
| 对话面板 `.chat-panel` | 648 | **7** | 4 | **10** | **10** | **16** | **23** | 2 |
| 右侧面板 `.panel-right` | 651 | **7** | 4 | **10** | **10** | **16** | **23** | 2 |
| 消息容器 `.messages-container` | 538 | 6 | 4 | 8 | 8 | 16 | 17 | 2 |
| 消息气泡 `.message-bubble` | 34 | 3 | 1 | 3 | 4 | 4 | 4 | 2 |
| 顶栏 `.titlebar` | 45 | 2 | 2 | 2 | 2 | 4 | 3 | 0 |

三个具体问题（都能一眼在 `chat-panel` 那一行看出来）：

1. **字号里有两个"非整数"**：`13.3333px` 与 `12.25px` —— 这是 `rem`/`em` 换算的产物（16px 基准的 0.8333rem / 0.7656rem），
   说明字号不是从一套刻度里挑的，而是"某处用了相对单位、某处用了 px"混出来的。
   一个面板里 **7 档字号 + 4 档字重 + 10 种文字色** ⇒ 层级不靠角色，靠手工挑。
2. **圆角 10 种**，其中三种是**逐角写法**（`0 0 8px 8px` / `8px 0 0 8px` / `0 8px 8px 0`）
   —— 这些是"气泡/卡片按位置改角"的补丁，说明圆角没有角色（该用 `--radius-*` + 方向语义）。
3. **16 种行高 + 23 种内边距**：面板里几乎每个组件自带一套间距，没有共同的节奏。

### 11.1 输入区（composer）：一个"叫 card 但不像 card"的方块

实测输入框的 DOM 链（自内向外）：

| 层 | 类名 | 尺寸 | 圆角 | 边框 | 内边距 | 阴影 |
| --- | --- | --- | --- | --- | --- | --- |
| textarea | `.message-input` | 916×56 | **0px** | 0 | `4px 0` | 无 |
| 父1 | `.input-backdrop-wrapper` | 916×56 | **0px** | 0 | 0 | 无 |
| 父2 | `.input-textarea-row` | 944×69 | **0px** | `1px rgba(31,31,30,0.09)` | `10px 14px 2px` | 无 |
| 父4 | `.input-area.input-card-container` | 984×135 | **0px** | 0 | `8px 20px 12px` | **无** |

⇒ 类名里写着 `input-card-container`，实际渲染是**直角 + 9% 灰细边 + 零阴影**：
既没有"卡片"的圆角与投影，也没有"输入框"的聚焦面。
对照对方：容器用 `radius-base`（6px）、行内 `0 8px`、卡片类元素带 `shadow-xs/sm` 与 `surface-raised`。
**这是"面板看着廉价"最直接的一条**（一块直角灰框贴在近白面上）。

---

## 12. 暗色档（第一版完全没测，这一次补上）

| 指标 | 浅色档 | 暗色档 |
| --- | --- | --- |
| 侧栏 / 内容 均值亮度 | 0.9571 / 0.9743 | 0.130 / 0.089（换算：33.18 / 22.58 灰阶） |
| **ΔL** | **+0.0172**（偏弱） | **−0.0416**（够用，但**符号相反**：暗色下侧栏比内容**更亮**） |
| 会话行 hover 背景 | 0% 面积变化 | **同样 0% 面积变化**（同一根因） |
| 导航项 hover | 97% 面积变化 | 可见（背景 `rgb(42,45,45)`） |

结论：**暗色档的分界反而比浅色档好**（0.0416 > 对方浅色 0.0328），但两档**方向不一致**
（浅色：侧栏更暗；暗色：侧栏更亮）—— 这本身不是错（macOS 暗色就是侧栏更亮），
但意味着**"提亮/压暗"这类统一动作在暗色档会反向**，改的时候必须分档验证。
hover 的缺陷**两档都有** ⇒ 修那一条覆盖就等于同时修好两档。

---

## 13. 外壳构图：**这一条比"行高"更能解释"看着廉价"**（第一版完全漏掉了）

### 13.1 对方的壳是"一整层玻璃 + 一块圆角纸面"（源码取证）

`src/web-ui/src/app/layout/WorkspaceBody.scss`（第一版没抓到，这次专门抓了）：

| 机制 | 实现 | 行号 |
| --- | --- | --- |
| 侧栏宽度 | `$_nav-width: 300px`，折叠态 `$_nav-collapsed-width: 76px`，拖拽命中区 `6px`（居中压在边界上） | `:8–11, 110–121` |
| **整壳玻璃层** | `__material`：`position:absolute; inset:0; z-index:-1; pointer-events:none` + `@include sidebar-glass`（**90% + blur-medium + 内高光**） | `:37–46` |
| 原生材质档 | `:root[data-openbitfun-native-material='sidebar'] & { background: transparent }` ⇒ 玻璃层让位，交给系统材质 | `:18–21` |
| 面板自己 | 背景**透明**（nav-bar / nav-panel / 吸顶标题 / 场景层一律 `background: transparent`）——材质由上面那层负责 | `:60–67` |
| **内容纸面** | `__scene-surface`：`border-radius: R 0 0 R`（**左侧两角**，R = `--layout-split-view-content-panel-radius`）、`background: surface-scene`、`box-shadow: -4px 0 12px -6px <muted 8%>`；**暗色档加强**为 `-5px 0 16px -7px <on-light 30%>` | `:135–153` |
| 拖拽反馈 | 反馈画在纸面的**圆角边**上（`::after` 跟随同一个 R 的描边，平时 `opacity:0`，hover 分隔条 / 拖拽中 → `opacity:1`），而不是给整块画个框 | `:155–186` |
| 折叠 | 导航区 `width: 0` + 另有一个 76px 宽的浮动导航条（macOS 下 `left: 72px`） | `:93–108, 195–200` |
| 搜索框 | 用 `sidebar-overlay(field-background)`；hover/focus-within → `sidebar-overlay(field-background-hover, 28%)` —— **在共享材质上"上色"，不是盖一块不透明面板** | `:70–77` |
| 底栏图标按钮 | 即使 hover/active 也 `background: transparent` —— 反馈交给**图标颜色 + 焦点环** | `:79–91` |

**从官方截图量出来的纸面几何**：跨越左缘的亮度剖面 `0.9689 → 0.9571 → 1.0000` ——
**左侧有一小段渐变（= 那道左缘阴影），右侧直接跳到纸面亮度**，与源码 `box-shadow: -4px 0 12px -6px` 吻合。

> ⚠️ **半径不要用这张截图量**：我先后量到 "6.0" 与 "11.5 CSS px" 两个值，都**不可信** ——
> 这张官方营销截图**顶部被裁过**（纸面上边缘出现在 y=2 CSS px，比任何工具条都靠上），圆角曲线被切掉上半段，
> 量出来必然偏小。**以 token 为准：`layout-split-view-content-panel-radius` = 24px**
> （`system.tokens.json:840-845`）。这也是"能用 token 就别拿像素反推"的一个例子。

### 13.2 我们的壳：四块齐边矩形叠在一起

实测（DOM 计算值）：

| 元素 | 矩形 | 圆角 | 阴影 | 边距 |
| --- | --- | --- | --- | --- |
| `.app` | 0,0 1280×672 | **0px** | 无 | 0 |
| `.app-content` | 0,44 1280×628 | **0px** | 无 | 0 |
| `.main-area` | 260,44 984×628 | **0px** | 无 | 0 |
| `.chat-panel` | 260,44 984×628 | **0px** | 无 | 0 |
| `.titlebar` | 0,0 1280×44 | 0px | 无 | 0 |

⇒ **内容区与侧栏、顶栏之间"零间距、零圆角、零阴影"**（内容区左边距 0、上边距 0）。
也就是说：对方是"**chrome 底 + 浮起一块圆角纸面**"，我们是"**四块齐边矩形拼在一起**"。

> 这一条（连同 §4 的 ΔL 0.0172）才是"面板看着廉价"的主因：
> **没有任何一层"浮起来"** —— 没有圆角、没有投影、没有内缩留白，只有一条 5% 的细线。
> 它跟"改什么颜色"没关系，所以前五轮改令牌再怎么改都不会有观感变化。

### 13.3 修复方案补一条 P0-0（优先级最高）

**把内容做成"浮在 chrome 上的圆角纸面"**：

- `.main-area` / `.chat-panel`：`border-radius: 24px 0 0 24px`（左侧两角；对方 token 就是 24px，我们要更小也得取**一个明确的档**，不要现编），
  `box-shadow: -4px 0 12px -6px color-mix(in srgb, var(--text-muted) 8%, transparent)`
  （暗色档加强，不能用同一档，因为暗底上 8% 看不见）；
- 给纸面留出内缩：右侧/下方各留 **var(--space-2)**，让"纸面"真的浮起来（对方 `padding: 0 space-4` 是横向内边距，纸面本身贴边但**左侧圆角 + 阴影**已足够形成"纸面"感）；
- 玻璃层与面板分离：材质档下**面板保持透明**，玻璃只留在壳那一层（我们目前是把 88% 近白糊在 `.sidebar` 上）；
- 拖拽反馈画在纸面圆角边上（我们目前 `.sidebar-resize-handle` 是 4px 透明条，**没有任何视觉反馈**）。
- **验收**：`.main-area` 的 `border-radius` 左两角非 0、`box-shadow` 非 none；
  截图上"内容纸面左上角曲线"可被检出；侧栏/内容 ΔL **≥0.028**。

---

## 14. 令牌级对照：对方是"生成式设计系统"，我们是"一个 18.6k 行的大文件"

> 数据来源：对方仓库 `design-system/`（token 全部是 **JSON 源 → 构建生成 CSS**，见
> `design-system/packages/design-tokens/src/system.tokens.json`：system 669 条 + theme 289 条）。
> 这一节的每个数字都有出处；抓取口径见文末脚本表。

### 14.1 规模对照

| | OpenBitFun | 我们 |
| --- | --- | --- |
| 令牌来源 | `system.tokens.json`（669 条）+ `theme-openbitfun/{light,dark,high-contrast-*}.tokens.json`（289 条） | `src/styles.css` 里的 `--*` 声明（**与规则混在同一个文件**） |
| 主样式表规模 | 组件级：43 个组件各自 `X.module.css` + `X.tsx` + `X.meta.ts` + `index.ts`；侧栏 = `NavPanel.scss`(2938) + `SessionsSection.scss`(927) + `WorkspaceListSection.scss`(1516) + `WorkspaceBody.scss`(225) | `src/styles.css` **18649 行**单文件 + 5 个附加表；侧栏规则散在其中，材质档覆盖写在**第 18615 行**（越靠后优先级越高 ⇒ 层叠事故的温床） |
| 组件契约测试 | `design-system/packages/ui/tests/` **52 个 .test.mjs** | 我们有 `css-integrity` / `style-token-gates` / `color-roles` 等门禁（22 道 audit + 403 个测试文件），但**没有"组件级"契约** |
| 可视化/工作台 | `design-system/apps/design-lab`（11 个页面，含**可编辑 token 的 TokenWorkbench**、颜色页、组件页、移动页、模式页、FlowChat 页） | 无（我们只有 audit 脚本与截图脚本） |
| 组件清单 | **43 个**（ActionCard / Alert / Avatar / Button / Card / Composer / Dialog / Field / Icon / IconButton / KeyHint / Menu / NavigationPanel / RollingText / ScrollArea / SearchField / SegmentedControl / StatusPill / Switch / TabGroup / Toolbar / Tooltip …）+ 23 个移动端组件 | 组件散在 `src/components/`，**没有登记表**（哪个组件有哪些变体/状态，只能读代码） |

**这一条解释了"为什么我们的侧栏调不动"**：他们的侧栏是**自包含、BEM 作用域、有 52 个契约测试**的组件；
我们的侧栏是**一个 18.6k 行文件里的几百行**，且被文件末尾的"材质档/高对比档"覆盖层按优先级改写 ——
本轮找到的那个 hover bug（`18615` 覆盖掉 `.active`）就是这种结构的必然产物。

### 14.2 排版：21 档原语 / 66 个语义角色 vs 我们的"12 档 + 混用"

| | OpenBitFun | 我们 |
| --- | --- | --- |
| 字号原语 | **21 档**：7/8/9/10/11/12/13/14/15/16/17/18/20/22/24/26/32/40/48/56/64 | `--fs-*` **11 档**：xs 10 / 2xs 11 / sm 12 / base 13 / md 14 / lg 16 / xl 18 / 2xl 20 / 3xl 24 / display 28 / hero 32 |
| 字重 | 4（400/500/600/700） | 我们侧栏实测出现 3 档（400/500/600），面板里 4 档 |
| 行高 | 16 个原语 + 14 个角色专用；**无单位数值** | `--lh-*` 7 档（第 155 轮补的） |
| 字距 | 10 档（含 -0.04em…0.26em） | `--ls-*` 3 档 |
| 语义角色 | **66 个**（display.* / heading.* / label.* / body.* / meta / micro / overline.* / code.* / flow.* + 修饰符） | **没有角色层**：组件直接写 `var(--fs-md)`，于是"这个字号是什么语义"只存在于作者记忆里 |
| 行默认文字色 | `content-secondary`（rgba(0,0,0,.6)），hover/选中升 `content-primary`（.8） | 行默认 `--text-primary`（#1f1f1e）——**一上来就是主色，没有可提升的余地** |

⚠️ **顺带发现我们自己刻度里的一个命名 bug**：`--fs-xs: 10px` 而 `--fs-2xs: 11px` ——
**"2xs" 比 "xs" 还大**（名字与数值反了）。这条与第 155 轮修掉的 `--radius-xs` 重复定义是同一类问题
（刻度自身的语义错误），建议下一轮顺手改掉（改名前先数消费方）。

### 14.3 动效：他们有语义时长/曲线并被大量消费

| | OpenBitFun | 我们 |
| --- | --- | --- |
| 时长令牌 | instant 80 / **fast 140**（web-ui 引用 **473** 次）/ base 220（143 次）/ content-swap 320 / slow 420 / lazy 1s / loop 720 | `--duration-*` 存在（本轮之前已建），但侧栏行的实测过渡是 **0.2s ease**、**只过渡 background** |
| 缓动 | `motion-easing-standard` = `cubic-bezier(0.23, 1, 0.32, 1)` —— web-ui 引用 **618** 次 | 侧栏行用的是浏览器默认 `ease` |
| 减少动效 | `prefers-reduced-motion` 覆盖 **169 个文件** | **15 个文件**（含 `src/styles` 下 3 个）——只有对方的约 1/11 |
| 减少透明 | `prefers-reduced-transparency` **10 个文件** | **3 个文件** |
| 高对比媒体查询 | `prefers-contrast` **12 个文件** | **2 个文件**（我们高对比主要走 `data-contrast` 属性，不全是媒体查询，但 2 个文件仍然偏少） |

对方有一个**已知缺口**也值得记：`prefers-reduced-motion` 只把 `{fast, normal, content-swap, slow, loop}` 归零，
**被引用第二多的 `duration-base`（143 次）没有归零** ⇒ 开了"减少动效"仍有 220ms 过渡。这一条我们**不必照抄**。

### 14.4 阴影 / 模糊 / 圆角 / 间距

| 族 | OpenBitFun | 我们 |
| --- | --- | --- |
| 高度阴影 | xs/sm/base/lg/xl 五档 + `shadow-composer`（`0 2px 12px rgba(0,0,0,.08)`）+ `shadow-menu` / `shadow-overlay` / `shadow-accent-glow` / 两档内高光（8% / 24%） | `--shadow-raise-1…4` + `--shadow-glow` + 一档内高光（8%）——**没有 composer 档**（我们的输入卡片零阴影，见 §11.1） |
| 暗色档阴影 | **明显更强**：xs 0.9 / sm 0.8 / base 0.7 / lg 0.6 / xl 0.5（近黑高 α） | 第 157 轮 D3 已加强（浮层档 0.42/0.55），方向一致 |
| 模糊 | subtle 4 / base 8 / medium 12（+ 弹层 20 / 页脚 10），每档带 `saturate` | `--blur-subtle`(4/1.02) / `--blur-medium`(12/1.2) —— 两档，与对方一致 |
| 圆角 | 10 个 token / 9 个数值：4/6/**8(base)**/12/16/20/24/32/9999 | 7 个：4/6/**8(base)**/10/14/20/9999（rem 定义） |
| 间距 | 13 个：0/4/8/12/16/20/24/32/40/48/64 + component-inline(12) / component-block(8) | `--space-*`（定义在样式表后段，非第一个 `:root`）；侧栏实测用到 6/8/10/12/16 |
| 控件高度 | sm 32 / md 40 / lg 48（compact 28/36/44，touch 40/48/56）；命中区 40 | `--control-*` 五档 + compact 档（第 159 轮 P2-1） |
| 图标 | 6 档尺寸（8/12/14/16/24）+ **描边令牌 1.6 / 2**；导航行字形 **14px / 槽 22px** | `--fs-icon-sm`12 / `--fs-icon`16 / `--fs-icon-lg`20；侧栏实测 **12/14/16 三种字形 + 硬编码 `stroke-width: 2`** |
| 焦点环 | focus-width 2 / offset 2 | `--focus-ring-width` 2 / `--focus-ring-offset` 2 ✅ 一致 |
| 禁用不透明度 | `opacity-disabled` 0.55（暗 0.60） | `--opacity-disabled` 0.5 |

### 14.5 从对方**可以直接借**的具体数值（都是 token 级、可核对）

| 借什么 | 值 | 出处 |
| --- | --- | --- |
| 侧栏行高（一个常量） | **30px** | `layout-navigation-panel-item-height` |
| 分组标题高度 | 24px（他们 SCSS 另有 22px 常量） | `layout-navigation-panel-heading-height` |
| 面板表面内边距 | 8px | `layout-navigation-panel-surface-padding` |
| 行内图标字形 / 槽 | 14px / 22px | `layout-navigation-panel-item-icon-size` / `control-icon-button-xs-size` |
| 图标描边 | 1.6（strong 2） | `control-icon-stroke-width` |
| 侧栏底栏高度 | 40px（他们 SCSS 写成 50px） | `layout-navigation-panel-footer-height` |
| 内容纸面圆角 | 24px | `layout-split-view-content-panel-radius` |
| 输入卡片圆角 | 16px（+ `shadow-composer`） | `control-composer-radius` / `shadow-composer` |
| 状态色四角色 | `surface` 10% / `border` 30% / `content` = emphasis 混黑 68–80%（暗档混白） | `status-*-surface/border/content`（与我们第 157 轮的口径**同源**，数值也接近 ✅） |
| 选中 vs 悬停 | **两套不同令牌**：`selection-surface`（rgba(0,0,0,.08)）/ `action-neutral-surface`（rgba(0,0,0,.05)） | `light.tokens.json:167,190` |

> 注意：他们的**中性文字/表面阶不是"墨纸二元派生"**，而是"参考色板 → 语义别名 → 少量 color-mix 透明层"；
> 我们是"墨+纸派生"。两套都成立，**不要为了对标把自己的派生体系改掉**（§8 已列）。

---

## 15. 图标系统（本轮补齐）

| | OpenBitFun | 我们（活体实测） |
| --- | --- | --- |
| 尺寸 | 令牌 6 档：`control-icon-size` 2xs 8 / xs 12 / **sm 14** / md 16 / lg 24；导航行字形 14px、槽 22px | **4 种混用**：14px(49 个) / 12px(36) / 16px(20) / 10px(6) |
| 描边 | `control-icon-stroke-width` = **1.6**，strong = 2 | **硬编码 `stroke-width: 2`：109/112**（另 3 个继承） |
| 颜色 | 由 `currentColor` 继承 + hover/选中升 `content-primary` | `currentColor` **109 / 字面色 0** ✅（颜色这层是干净的） |
| 统一入口 | `Icon` 组件（`size="xs|sm|md|lg"`）+ `icon-slots` 契约测试 + `IconButton` 尺寸映射表 | DOM 里 112 个内联 `<svg>`（React 内联正常，但**没有尺寸/描边的统一封装**，每个调用点自己写 width/height） |
| viewBox | 约定统一 | 2 种（24×24 109 个 + 10×10 3 个）|

**缺口**：字形尺寸 4 → 1（14px）、槽统一 22px、描边走令牌 1.6。
**不变**：颜色继承已经是 `currentColor`，不需要动。

---

## 16. 动效（本轮补齐；并修正上一版的判断）

⚠️ **修正**：上一版说"我们的动效都是字面量"——**不准确**。实测（CSSOM 声明）：

| 指标 | 我们 | OpenBitFun |
| --- | --- | --- |
| 带 `transition` 的规则 | **300 条** | — |
| 其中走令牌 | **289 条**（var(--duration/--ease/--transition)）| — |
| 其中字面时长 | **11 条**（5 条是 `none`/`0ms` 的降级，属正常；其余是 xterm/步骤环等第三方或局部） | — |
| 曲线令牌 | `--ease-out: cubic-bezier(.23, 1, .32, 1)` ← **与对方 `motion-easing-standard` 完全同值** | `motion-easing-standard` 同一条曲线，web-ui 引用 **618** 次 |
| 时长令牌 | `--duration-press .12s` / `--duration-fast .15s` / `--duration-slow .3s` | instant 80 / **fast 140** / base 220 / content-swap 320 / slow 420 |
| 复合令牌 | 有：`--transition-color` = color+background-color+border-color `.15s` + 那条曲线；`--transition-transform` | 无（他们用时长+曲线组合） |
| **侧栏行实际用的** | `styles.css:1314` `transition: background var(--duration-fast) ease` ⇒ **只动 background + 默认 ease 曲线**（`--transition-color` 就在手边却没用） | 行过渡 = background + **color** + opacity + transform，120ms + 标准曲线 |
| `animation` 规则 | 92 条，其中 13 条走令牌（其余多为 FontAwesome 自带） | — |
| 减少动效覆盖 | **15 个文件** | **169 个文件** |

**缺口**：① 侧栏行换用 `--transition-color` 并补 `transform`；② 行的文字色/图标色要跟着状态过渡（现在只动背景）；
③ `prefers-reduced-motion` 覆盖面从 15 个文件往上提（至少覆盖所有自定义 `@keyframes`）。

---

## 17. 弹层（本轮补齐；结论比预期好）

**活体实测（真实点开一个下拉菜单）**：`.bottom-bar-dropdown.popover-shell.chat-dropdown` ——
240×66、圆角 **10px**、内边距 4px、背景 `color(srgb 1 1 1 / 0.94)`、
**`backdrop-filter: blur(12px) saturate(1.2)`**（与对方 `effect-blur-medium` 同值）、
阴影 = 1px 环 + 柔和投影、**入场动画 `0.15s cubic-bezier(0.23, 1, 0.32, 1)`**（正好是我们的 `--duration-fast` + `--ease-out`）。

| 类 | 我们（CSSOM + 活体） | OpenBitFun（token） |
| --- | --- | --- |
| 浮层/菜单 | 圆角 `--radius-md`(10px)、阴影 `--shadow-raise-3`/`--shadow-popover`、`--blur-medium`、z 走令牌 | `overlay-menu-inline-size` 220px、`shadow-menu`、`layer-dropdown/popover` |
| 模态 | `.modal-panel` 圆角 `--radius-lg` + `--shadow-popover`；但 `.modal-editor` 用**字面阴影** `0 8px 32px var(--shadow-color…)` | `overlay-dialog-max-inline-size` 420–1200px、`overlay-dialog-footer-height` 68px、backdrop blur 20px |
| 提示 | `.tooltip-content` `--radius-sm` + `--shadow-md` + `tooltip-fade-in var(--…) ` ✅ | `overlay-tooltip-max-inline-size` 280px |
| Toast | `.plugin-mgr-toast` 走 `--z-toast`/`--shadow-popover`；但 `.snapshot-toast`/`.toast-item` 的动画是**字面 `0.3s ease`** | — |
| z-index | **令牌 64 / 字面量 46**；且 `--z-top: 10000`、`--z-toast: 20000`、`--z-dialog: 1410` 是"临时数字" | `layer-*` 16 档具名层级（base 0 → contextMenu 500） |
| 阴影阶梯 | **两套并存**：`--elevation-1/3/4`（8 处，全在 `codem-ui.css`）+ `--shadow-*`（70 处） | 一套：`shadow-xs/sm/base/lg/xl` + 3 个功能阴影 + 2 个内高光 |

**缺口**：① `--elevation-*` 并入 `--shadow-*`；② z-index 字面量棘轮；③ `--z-top` 这类"临时数字"归到 8 档层级；
④ 模态/Toast 里残留的字面阴影与字面动画时长。
**合格项**：浮层的玻璃配方、圆角、入场曲线都与对方同级——**这块不用重做**。

---

## 18. 键盘与无障碍（本轮补齐）

| 指标 | 我们（实测） | OpenBitFun |
| --- | --- | --- |
| 焦点环 | **12 跳全部有可见焦点环**（2px 强调色）✅ | `focus-width` 2 / `focus-offset` 2；各行/按钮普遍有 `:focus-visible` |
| 焦点顺序 | 顶栏 → 侧栏导航 → 侧栏分组按钮 → 用户区 → 收起 → 对话标题，**顺序合理** ✅ | — |
| **命中区 < 24px 的可交互元素** | **41 / 111**（会话行 pin/delete **16×19**、分组按钮 22×22、收起 32×28…） | `control-hit-target` = **40px**（compact 36 / touch 48） |
| 无可访问名 | 标题栏按钮、`.sidebar-project-btn` 等（≥2 处） | `aria-label` 惯例 + 契约测试 |
| `aria-live` | **0 处**（流式输出/状态变化无播报） | 有（Alert / 状态组件） |
| `role` / `tabindex` | 5 / 1（极少） | roving tabindex 工具 + 语义角色 |

**缺口**：① 命中区 41 → 0（用 `::before` 扩大点击面，图标不用变大）；② 补 `aria-label`；
③ `aria-live` 至少给流式输出区加一个。

---

## 19. 响应式 / 窄窗（本轮补齐；这一项基本合格）

| 视口宽 | 侧栏宽 | 内容区宽 | 横向滚动 | 命中区 <24px | 被裁剪元素 |
| --- | --- | --- | --- | --- | --- |
| 1000 | 200 | 764 | 无 | 41 | 3 |
| 820 | 200 | 584 | 无 | 40 | 5 |
| **700** | **0（自动收起）** | 664 | 无 | 32 | 3 |

⇒ 我们有自动收起、没有横向滚动；**这一块不用改**（对方是 `width:0` + 76px 浮动条 + 顶部栏里放收起控件，形态不同但效果等价）。

---

## 20. 皮肤（hub / dream）的几何（本轮补齐）

| 皮肤 | 侧栏底 | 导航行 | 会话行 |
| --- | --- | --- | --- |
| 默认 | 88% 近白玻璃 | 40.3px / **radius 8px** / 14px | 31.5px / **radius 6px** / 13px |
| hub | `rgb(18,18,18)` | 40.3px / **radius 6px** / 14px | 31.5px / **radius 4px** / 13px |
| dream | `rgba(255,255,255,0.65)` | 40.3px / **radius 10px** / 14px | 31.5px / **radius 6px** / 13px |

⇒ **行高一致、圆角三套**（8 / 6 / 10）。也就是说皮肤作者在**各自重造几何**，而几何本该继承主样式表。
**缺口**：皮肤只许覆盖颜色/阴影，几何一律继承（门禁 SKIN-3：皮肤文件不得出现 height/padding/gap/border-radius/font-size）。

---

## 21. 内容态与长文本（本轮补齐）

| 指标 | 我们 | OpenBitFun |
| --- | --- | --- |
| 空态 | **7 条规则**、各功能各自实现：`.empty-state` / `.mp-empty-hint` / `.notebook-empty-state` / `.notebook-empty-hint` … | `Empty` 组件（design-system 43 个组件之一，带契约测试） |
| 加载 | **8 条**：`.subagent-elapsed-spinner` / `.compaction-spinner` / `.streaming-timer-spinner` / `.boot-splash-spinner` …（**没有骨架屏**） | `Spinner` 组件；（对方另有骨架/呼吸动效） |
| 错误 | **6 条**，且只有 retry 按钮：`.project-retry-btn` / `.pm-retry-btn` / `.kg-retry-btn` | `Alert` 组件（4 级）+ `StatusPill` |
| 离线/重连 | **2 条**：`.status-dot.disconnected` / `.mcp-status-dot.disconnected` | 有专门的重连/设备状态组件 |
| 长文本截断 | **正常**：会话标题 `text-overflow: ellipsis` + `nowrap`，注入 3 倍长文本后**行高不变、无溢出** ✅ | `OverflowText` / `RollingText` 原语 + `text-clipping.test.mjs` |
| 输入框聚焦态 | **弱**：聚焦时只有 textarea 上的 2px 焦点环；承载视觉的 `.input-textarea-row`（1px 9% 边框）**完全没变** | `field-border-focus` + 焦点面 |

**缺口**：① 三类内容态各收成一个共享实现；② 输入卡片聚焦要有可见变化（border + shadow）；
③ 骨架屏目前**完全没有**（长任务只有转圈）。
**合格项**：长文本截断已经做对了。

---

## 22. 本轮覆盖度小结

**已审**：侧栏（深）、面板/内容区、外壳构图、暗色档、图标、动效、弹层、键盘与无障碍、响应式、皮肤几何、内容态与截断、令牌/排版体系、设计系统组织方式。
**仍未审（明确列出）**：① 读屏软件实测（只有属性计数，没有真实 SR 走查）；② 触屏/触摸手势；③ 多语言文案长度（我们只有中文界面，未做英文长度压测）；④ 高 DPI 缩放（125%/150% 下的布局）；⑤ 窗口外壳（标题栏按钮、圆角、系统材质在深色下的表现）；⑥ 第三方嵌入（编辑器/终端）的观感；⑦ 动态内容态（流式输出进行中的行高抖动、长任务下的侧栏状态）。

---

## 附：测量方法（脚本都在 `.preview-shot/`，可复跑）

| 脚本 | 量什么 |
| --- | --- |
| `_sidebar-anatomy.mjs` | 侧栏容器/分组/23 个行类元素的真实几何、字号、圆角、图标尺寸分布 |
| `_sidebar-states.mjs` + `_sidebar-cascade.mjs` | 用 CDP 强伪类 + `CSS.getMatchedStylesForNode` 查"哪条规则赢了" |
| `_sidebar-hover-rows2.mjs` | **真实鼠标事件 + 截图像素 diff**（含 DPR 换算；含"去掉材质档"的 A/B） |
| `_sidebar-structure.mjs` | transition / sticky / `:active` 规则数 / 滚动条 / 文字色角色 |
| `_verify-claims.mjs` | 自审：整行像素复核、选中态分档验证、**暗色档复核** |
| `_verify-area-and-metric.mjs` | 自审：**变化面积**指标 + 自相关度量的灵敏度（合成剖面） |
| `_verify-rhythm-robust.mjs` | 自审：行距的 4 带宽稳健性 + DOM 真值（行高/间距集合） |
| `_panel-audit.mjs` / `_panel-detail.mjs` | 面板/内容区一致性计数、输入区解剖、状态规则数 |
| `_scan-same-surface-hover.mjs` | 全站扫"同色低α覆盖"这一写法（命中 1 处 = 上面那条） |
| `_final-compare.mjs` | 双方截图同一口径：边界台阶、ΔL、边缘密度、亮度层级、行距自相关 |
| `_obf-fetch.mjs` | 抓对方侧栏真实源码（`NavPanel.scss` 等 13 个文件 → `.preview-shot/_obf/`） |
| `_verify-radius-and-scales.mjs` | 自审：纸面圆角曲线 + 我们的 space/radius/fs 刻度 + **媒体查询覆盖计数** |
| `_region-names.mjs` | 找出真实区域类名（chat-panel / messages-container / panel-right …） |
| `_shell-composition.mjs` | **外壳构图**：对方纸面圆角/左缘阴影剖面 vs 我们四块齐边矩形 |

### 本轮自审：5 条被修正的说法

| # | 第一版说法 | 修正后 |
| --- | --- | --- |
| 1 | 会话行 hover"一个像素都不变" | 背景 **0% 面积**变化、整行 **0.93%**（尾部动作淡入）；导航项/项目行是 97% 面积变化 |
| 2 | "hover 抹掉选中底"（未分档） | **仅材质档**成立；无材质档下靠"写在文件更后面"侥幸赢 |
| 3 | "行距 r=0.151 ⇒ 没有节奏"（单带宽下定论） | 4 带宽 + 合成剖面验证后**结论仍成立**，但改为"只有 1/4 带宽过线" |
| 4 | "对方侧栏不用玻璃（零引用）" | **错**：玻璃在**整壳材质层**（`WorkspaceBody.scss:38`，全仓仅此一处引用），面板自己透明 |
| 5 | 纸面圆角"实测 6.0px" | **不可信**（官方营销截图顶部被裁，曲线量不全）⇒ 以 token **24px** 为准 |

### 另外 3 处测量工具本身的错（与结论无关，但会伪造结论）

| # | 错法 | 后果 |
| --- | --- | --- |
| A | 像素采样没做 DPR 换算（截图是 3× device 像素） | 得到"所有 hover 都看不见"的**假结论** |
| B | 侧栏边界/行距检测器窗口太小（40 device px），把图标列当边界 | 测出"侧栏宽 2px""行距 198px"这类荒谬值 ⇒ 现在先在我们这边复现已知真值再用它量对方 |
| C | CSSOM 遍历没递归（只 `for (const r of sheet.cssRules)`） | 漏掉 95 个嵌套容器里的规则；"侧栏滚动条规则 33 条"是错的（真值 0 条，33 是全局） |

### 抓取的对方文件（本轮，都在 `.preview-shot/_obf/`）

| 文件 | 用途 |
| --- | --- |
| `NavPanel.scss`（2938 行）、`MainNav.tsx`、`NavItem.tsx`、`SectionHeader.tsx`、`StickySectionHeader.tsx`、`PersistentFooterActions.tsx` | 侧栏解剖（行高/状态/分组/粘性） |
| `SessionsSection.scss/.tsx`、`WorkspaceListSection.scss`、`WorkspaceItem.tsx` | 会话行与工作区行（缩进树、尾部动作） |
| `_workspace-shell-surfaces.scss`、`NavBar.scss`、**`WorkspaceBody.scss`**（UTF-16，需转码） | 壳层表面配方 + **外壳构图**（整壳材质层、内容纸面、拖拽反馈、折叠） |
| `openbitfun-desktop.png`（官方截图 2568×1672） | 渲染结果对照（ΔL / 边缘密度 / 行距 / 纸面阴影剖面） |
| `design-system/packages/design-tokens/src/system.tokens.json` + theme `light/dark/high-contrast-*.tokens.json` | 令牌规模与取值（§14） |
| `design-system/packages/ui/*`（43 组件 + 52 个契约测试）+ `apps/design-lab` | 设计系统组织方式（§14.1） |
