# Phase 0 + Phase 1 验收证据（批次 2026-10-26 · 补测 2026-10-27）

> 本文件补齐 `docs/project-guide/15-VISUAL-REBUILD-PLAN.md` §1（Phase 0 三列表）与 §2（Phase 1 左栏）缺失的验收证据。
> 同批 `html-vs-current-vs-omp.md` 保持原样作为历史记录；本文件用**同一台机、同一个安装版**重新测了一遍，
> 并在 §5 逐条列出与上一版不一致的数字及其依据。
> 纪律：每个数字都带来源标记；测不到的写 **unknown**，不写估算词。

---

## 0. 环境与口径

| 对象 | 标识 | 采集方式 | 视口 | DPR |
|---|---|---|---|---|
| Codem 安装版 | `1.16.330`（`package.json`）；CDP 页面 `document.title = "Codem"` | WebView2 CDP `http://127.0.0.1:9223` | **1280×672**（`screen 1280×720 / avail 1280×672`，窗口最大化） | `3`（截图物理 3840×2016） |
| WebView2 运行时 | `156.0.4314.50`，CDP 协议 `1.3` | `GET /json/version` | — | — |
| HTML mock | `docs/design/ui-benchmark-mock.html`（2026-10-26 12:21，93,930 B） | Edge `156.0.4314.42` `--headless=new`，`Emulation.setDeviceMetricsOverride` | **1400×875** 与 **1280×672** 两档 | `1` |
| OMP Studio 参考图 | `0.1.10`（`main @ 6c82315`，见 `13-UI-BENCHMARK-OMP.md` L3） | 现有 JPG 像素扫描（`omp-workbench-dark.jpg` / `omp-settings-dark.jpg`，均 1200×750） | 1200×750 图像 | 见 §0.2 |

> 测量对象是**安装版 1.16.330 的运行进程**（CDP 9223），不是当前工作树构建。
> 采集期间工作树被本会话之外的改动动过（`git status` 里 `M src/styles.css` 时间戳 11:59:07、`M tools/ui-audit/css-contract.json` 11:59:12），
> 这两处不在本次取证范围内，也未参与任何读数（本会话只写 `C:\temp\visual-gate\` 与本目录两份文档）。

### 0.1 来源标记

| 标记 | 含义 | 落盘文件（`C:\temp\visual-gate\`） |
|---|---|---|
| `H-1400` | HTML mock 渲染实测 @1400×875 | `html-1400x875.json` / `html-1400x875.png` |
| `H-1280` | HTML mock 渲染实测 @1280×672 | `html-1280x672.json` / `html-1280x672.png` |
| `H-set` | HTML mock 设置页渲染实测 @1400×875（临时去掉 `#settingsView[hidden]` 后测） | `html-settings-1400x875.json` / `.png` |
| `H-src` | HTML mock 源码行号（`docs/design/ui-benchmark-mock.html:L…`） | 仓库文件 |
| `C-main` | 安装版 CDP 实测（主工作台） | `measure-main.json` |
| `C-set` | 安装版 CDP 实测（设置页） | `measure-settings.json` / `settings-detail.json` |
| `C-rail` | 安装版 CDP 实测（右栏展开→收起） | `measure-rail.json` |
| `C-scroll` | 安装版 CDP 实测（会话滚动） | `measure-scroll2.json` |
| `C-tab` | 安装版 CDP 实测（Tab 序列） | `measure-taborder.json` / `measure-tabdeep.json` |
| `C-css` | 安装版 CSS 源码行号（`src/styles.css:L…`） | 仓库文件 |
| `O-img` | OMP 参考图像素扫描（原图像素） | `omp-workbench-dark.jpg`（仓库内） |
| `O-set` | OMP 设置参考图像素扫描（原图像素） | `omp-settings-dark.jpg`（仓库内） |
| `O-doc` | `13-UI-BENCHMARK-OMP.md` 的文档记载值（**不是本次实测**） | 仓库文件 |
| `O-css` | OMP 原图像素 ÷ 0.75 换算值（依据 §0.2，量化误差 ±1.3 px） | 由 `O-img` 推导 |

### 0.2 OMP 参考图的尺度：0.75×（这一步决定 OMP 列能否与 CSS px 比较）

参考图是 **1600×1000 布局按 0.75 缩放到 1200×750** 后落盘的，四条独立证据：

| 证据 | 原图读数 | 设计值来源 | 比值 |
|---|---:|---|---:|
| 图像尺寸 | 1200×750 | 1600×1000 | 0.750 |
| OMP 左栏 | 边框 `x=203–204`（垂直边框检测 `frac=1.00`）→ 204 px | `O-doc` L592「272px」 | 204/272 = **0.750** |
| OMP 右栏 | 左边框 `x=840` → 360 px | `O-doc` L593「480px 常驻」 | 360/480 = **0.750** |
| Codem 同批参考图 `codem-main-dark.jpg` 左栏 | 边框 `x=172` → 172 px | `O-doc` L592「Codem 231px（本次设置）」 | 172/231 = 0.745（1 px 边框取整误差内） |

反证（排除 1:1）：

- 若参考图是 1:1，则 `O-doc` 记载的两个值（Codem 231、OMP 272）要**同向错 25%** 才成立（172/231 = 0.745、204/272 = 0.750）。
  两张独立截图落进同一个缩放比、且都与文档值自洽，1:1 无法解释。
- 三栏相加自洽：272 + 848 + 480 = **1600** ✓（原图 204 + 636 + 360 = **1200** ✓）。若按 1:1 读，三栏和只有 1200，无法解释 1600 布局。

> 结论：`O-img` / `O-set` 的读数是**图像 px**；本文 OMP 列一律换算成 CSS px（`O-css`，÷0.75），并标注 ±1.3 px 量化误差。
> 不做这一步，OMP 的 204 / 24 / 360 会被误当成 CSS px 去和 Codem 的 240 / 32 / 36 直接比 —— 这正是上一版文档出错的根因（§5）。

---

## 1. Phase 0 三列对照表（必测 7 项）

| 指标 | HTML mock | 当前安装版 1.16.330 | OMP Studio 0.1.10 | 结论 |
|---|---|---|---|---|
| **左栏宽** | **260** `H-1400`／**240** `H-1280` | **240** `C-main` | **272** `O-css`（原图 204 `O-img`） | 当前 = HTML 窄档（1280）；比 OMP 窄 **32** |
| **导航行高** | **32** `H-1400`（`H-src:320`） | **32** `C-main` | **32.0** `O-css`（原图 24.0 `O-img`） | 三列同值 32 |
| **会话行高** | **30** `H-1400`（`H-src:391`） | **30** `C-main` | **30.7** `O-css`（原图 23.0，区间 22–24 `O-img`） | 极差 ≤0.7，落在 OMP 量化误差 ±1.3 内 |
| **正文列宽** | **732** `H-1400`／**780** `H-1280` | **820** `C-main`（`C-css:2688` `--reading-column: 820px`） | **768** `O-doc`（L591）；本次图像只能测到卡片外边界 **748–751** `O-css`（原图 561–563 `O-img`） | 当前比 OMP 宽 **52**（按 768 计）；比 HTML@1280 宽 **40** |
| **Composer 宽** | **732**（高 112）`H-1400`／**780**（高 112）`H-1280` | 外壳 **820**×134.5；内卡 **798**×102 `C-main` | 卡 **748–751** `O-css`（原图 561–563 `O-img`） | 当前外壳比 OMP 宽 **69–72** |
| **右栏折叠宽** | **0**（无折叠态：≤1280 直接 `display:none`）`H-1280`（`H-src:1398-1401`） | 折叠 **36**、展开 **360** `C-main` `C-rail` | **480** 常驻、无折叠态 `O-css`／`O-doc` L593 | 三者形态不同，数值不可直接比拼（见 §3.6） |
| **设置组数** | **8** 导航分区 + **4** 分组 + **5** 子导航 `H-set` | **6** 导航组 + **23** 分区（tab）+ 39 个 `setting-group` 节点 `C-set` | **8** 导航分区 `O-set`；常规页 **3** 个分组标题 `O-set` | 分区层 HTML=OMP=8；当前是「6 组 + 23 tab」两级结构，与两侧都不同构 |

### 1.1 补充几何（同批次实测，供后续 Phase 使用）

| 元素 | HTML mock | 当前安装版 | OMP | 来源 |
|---|---:|---:|---:|---|
| 标题栏高 | 44（`H-src:18` `--titlebar-h`） | 44 | 36（`O-doc` L588） | `H-src` / `C-main` / `O-doc` |
| 项目行高 | 32（`H-src:418`） | 32 | unknown（未测） | `H-1400` / `C-main` |
| 工具格高 | 未测（unknown） | 43（宽 54.25） | unknown（未测） | `C-main` |
| 分组标题高 | 28（`H-src:377`） | 28 | unknown（未测） | `H-1400` / `C-main` |
| 设置侧栏宽 | 220 `H-set` | 220 `C-set` | unknown（未测） | `H-set` / `C-set` |
| 设置内容列 | 900 `H-set` | 900 `C-set` | unknown（未测） | `H-set` / `C-set` |
| 设置导航项高 | 31（`H-src:1135`） | 31 `C-set` | 30.0 `O-set`（原图 22.5） | `H-set` / `C-set` / `O-set` |
| 设置行距（相邻行 label 中心） | 49（行高；min-height 46）`H-set` | unknown（未逐行测） | 43.25 原图 px = **57.7** CSS px `O-set` | `H-set` / `O-set` |
| 设置子导航高 | 26（`H-src:1168`） | 33（宽 876）`C-set` | unknown（未测） | `H-set` / `C-set` |
| 对话头高 | 未测（unknown） | 48 `C-main` | unknown（未测） | `C-main` |
| 消息容器宽 | 未测（unknown） | 916（内边距 20/48）`C-main` | unknown（未测） | `C-main` |
| 横向溢出 | `scrollWidth = 1400`（无溢出）`H-1400` | `scrollWidth = 1280`（无溢出）`C-main` | unknown（未测） | `H-1400` / `C-main` |

---

## 2. 逐项来源明细（每个数字怎么来的）

### 2.1 左栏宽

- **HTML**：`--sidebar-w: 260px`（`H-src:19`），`.sidebar { width: var(--sidebar-w) }`（`H-src:274`）；
  窄档覆盖 `.sidebar { width: 240px }` 在 `@media (max-width: 1280px)`（`H-src:1398-1401`）。
  渲染实测：1400 视口 `.sidebar = 260×831`，1280 视口 `.sidebar = 240×628`（`H-1400` / `H-1280`）。
- **当前**：`.sidebar` 计算尺寸 `240×628`，`x=0 y=44`（`C-main`）。该宽度由运行期持久化宽度决定，非 CSS 常量，故不引 CSS 行号。
- **OMP**：原图左栏右边界是一条贯穿整高的 2 px 竖线，垂直边框检测 `x=203 frac=1.00`、`x=204 frac=1.00`（`O-img`，扫描带 y=90–600，步长 2）。
  取内容宽 204（0–203）→ 204 ÷ 0.75 = **272.0**（`O-css`）。交叉核对：`O-doc` L592 记 272。

### 2.2 导航行高

- **HTML**：`.nav-item { height: 32px }`（`H-src:320`）；渲染实测 3 个 `.nav-item` 高度集合 `{32}`（`H-1400`）。
- **当前**：`.sidebar-nav-item` = `223×32`，`font-size 12px`，`padding 0 8px`（`C-main`）；3 个节点（`settings-detail` 同批 DOM 清点）。
- **OMP**：侧栏文本行中心 72.5 / 96.5 / 120.5（`O-img`，x=10–200 的墨迹行带），两级间距 24.0、24.0 → 24.0 ÷ 0.75 = **32.0**（`O-css`）。
  `O-doc` L602 记「30px 行」，与本次实测差 2 px；两者都是文档/测量口径，未定谁对，故本表用实测值并在此标注分歧。

### 2.3 会话行高

- **HTML**：`.session { height: 30px }`（`H-src:391`）；渲染实测 6 个 `.session` 高度集合 `{30}`（`H-1400`）。
- **当前**：`.sidebar-session` = `223×30`，`font-size 12px`，`line-height 18px`，`padding 0 8px`（`C-main`）；
  全侧栏 43 个 `.sidebar-session` 的高度集合为 `{30}`（`C-main` 与 `C-scroll` 两次独立读数一致）。
- **OMP**：侧栏会话文本行中心 206.5 / 228.5 / 252.5 / 276 / 298.5（`O-img`），四段间距 22 / 24 / 23.5 / 22.5，均值 23.0 → 23.0 ÷ 0.75 = **30.7**（`O-css`）。
  `O-doc` L605 记「28px」，与实测差 2.7；同上标注分歧。

### 2.4 正文列宽

- **HTML**：`--doc-w: 820px`（`H-src:21`），`.doc { max-width: var(--doc-w) }`（`H-src:530`）；
  `@media (max-width: 1440px)` 把 `--doc-w` 改为 780（`H-src:1394-1396`），1280 档维持 780。
  渲染实测：1400 视口 `.doc = 732`（受列容器 780 减左右 24 的内边距约束，`max-width` 仍报 780）；
  1280 视口 `.doc = 780`（`H-1400` / `H-1280`）。
- **当前**：`.message-content = 820`（`C-main`）；同值可追溯到 `--reading-column: 820px`（`C-css:2688`）与 `max-width: 820px`（`C-css:14373`）。
- **OMP**：本次图像只能测到**卡片外边界**：`y=459 x=224..775`、`y=485 x=223..779`、`y=492 x=225..785`、`y=563 x=225..786`（`O-img`，水平线端点检测），
  即 552–563 原图 px → **748–751 CSS px**（`O-css`）。列宽本身无可见边界，`O-doc` L591 记「768px 文档列」，本表 OMP 值采用 768 并标注它是文档记载；
  文档值与本测卡片值相差 17–20 px，成因（卡片相对列内缩）未验证 → **unknown**。

### 2.5 Composer 宽

- **HTML**：`.composer { max-width: var(--doc-w) }`（`H-src:791`）；`.composer-region { padding: 8px 24px 10px }`（`H-src:761`）。
  渲染实测：1400 视口 `.composer = 732×112`，1280 视口 `.composer = 780×112`（`H-1400` / `H-1280`）。
- **当前**：外壳 `.input-area = 820×134.5`（`max-width: 820px`）；内卡 `.input-wrapper = 798×102`；
  内部结构 `.input-textarea-row = 798×62`、`.input-action-row = 798×40`、`.composer-foot = 798×16.5`（`C-main`）。
  另测：右栏展开时外壳 `.input-area` 变为 `680`（`C-rail`）—— 该值受可用宽度约束，不是新常量。
- **OMP**：卡外边界 `y=492 x=225..785` 与 `y=563 x=225..786`（`O-img`），合并读作 561–563 原图 px → **748–751 CSS px**（`O-css`）。

### 2.6 右栏折叠宽

- **HTML**：无折叠态。`@media (max-width: 1280px)` 里 `--inspector-w: 0px; .inspector { display: none }`（`H-src:1398-1401`）；
  1400 视口 `.inspector = 360×831`，1280 视口 `.inspector` 计算尺寸 `0×0` 且 `display: none`（`H-1400` / `H-1280`）。
- **当前**：折叠 `.right-sidebar = 36×628`，`x=1244`（`C-main`）；点侧栏自带按钮展开后 `= 360×628`，`x=920`（`C-rail`，截图 `rail-expanded-1280.png`）。
  展开→收起通过 `.right-sidebar-toggle`（`aria-label="收起右侧栏"`）完成，收起后复测回到 36，状态已还原（`C-rail` `after` 段）。
- **OMP**：常驻无折叠态；左边框 `x=840`（`O-img`，`x=840` 处 1 px 亮线在 y=45–560 与其余栏线一致）→ 1200−840 = 360 → **480.0**（`O-css`），交叉核对 `O-doc` L593 的 480。

### 2.7 设置组数

- **HTML**：`H-set`（把 `#settingsView` 的 `hidden` 去掉后渲染 1400×875）：
  8 个 `.set-nav-item`（`H-src:1790-1799`，逐项：通用/外观/模型与 Provider/对话与上下文/工具与权限/知识与记忆/连接与设备/高级）；
  4 个 `.set-group`（应用/编辑器/启动/通知，`H-src:1817/1835/1857/1875`）；5 个 `.settings-subnav button`（全部/应用/编辑器/启动/通知，`H-src:1809-1815`）；
  侧栏 220、内容列 900、导航项高 31。
- **当前**：`.settings-nav-group-label` = **6**（通用与外观/模型与运行/对话与知识/工具与权限/连接与设备/高级与帮助）；
  `.settings-sidebar-item` = **23**（通用/外观/多模态/语音/Ollama/工具/知识/自动化/人设/记忆体检/代码图谱/安全/电脑操作/Git/环境/工作树/微信 ClawBot/连接手机/宠物/用量统计/性能/高级/帮助）；
  `.setting-group` 节点 = **39**（`offsetParent` 非空的也是 39）；`.settings-section-title` 可见 3 个（身份配置/关于你/API 配置）。全部来自 `C-set`。
- **OMP**：`omp-settings-dark.jpg` 左侧导航文本行带 8 条（中心 89 / 112 / 134 / 156.5 / 179.5 / 201.5 / 224 / 246.5，`O-set`），逐项可读为
  常规/对话与交互/权限与安全/上下文与记忆/文件与终端/任务与执行/高级/运行偏好 → **8 个分区**；行距均值 22.5 原图 px → 30.0 CSS px（`O-css`）。
  右侧「常规」页目视可读 3 个分组标题（应用 / 启动 / 通知），行带位置分别在 y=156.5 / 447.5 / 695（`O-set`）；最后一条紧贴图像底缘（y=695，图高 750）。
  设置行距（相邻行 label 中心）43.5 / 43 / 43 / 43 / 44，均值 43.25 原图 px → 57.7 CSS px（`O-set`）。

---

## 3. 差异结论与折扣台账（Phase 0）

| 项 | 结论 | 依据 | 是否记折扣 |
|---|---|---|---|
| 左栏宽 | 当前 240 = HTML 窄档；比 OMP 窄 32；比 HTML 宽档 260 窄 20 | §2.1 | 需记：1280 窗口用 240 属响应式行为，不是“落后于 HTML” |
| 导航行高 | 三列全为 32 | §2.2 | 无差异 |
| 会话行高 | 30 / 30 / 30.7，极差 ≤0.7 | §2.3 | 无差异（OMP 值在量化误差内） |
| 正文列宽 | 当前 820 比 OMP 768 宽 52、比 HTML@1280 780 宽 40 | §2.4 | 需记：HTML 的 820 是 `--doc-w` 变量值，不是 1400 视口下渲染值（732） |
| Composer 宽 | 当前外壳 820 比 OMP 748–751 宽 69–72 | §2.5 | 需记：与正文列同宽 820，属同一套列宽决定 |
| 右栏折叠宽 | 三种形态不可比：HTML 无折叠（≤1280 隐藏）/ 当前 36↔360 / OMP 480 常驻 | §2.6 | 需记：形态差异，不是数值差异 |
| 设置组数 | 分区层 HTML=OMP=8；当前 6 组 + 23 tab | §2.7 | 需记：IA 结构不同构（当前两级） |

---

## 4. Phase 1：左栏验收

### 4.1 几何（当前 1280×672 实测 vs HTML 两档）

| 元素 | HTML@1400 `H-1400` | HTML@1280 `H-1280` | 当前实测 `C-main` | 判定 |
|---|---:|---:|---:|---|
| 侧栏宽 | 260 | 240 | **240** | 命中 HTML@1280 |
| 导航行 | 32 | 32 | **32**（12px，padding 0 8） | 命中 |
| 会话行 | 30 | 30 | **30**（12px，line-height 18，padding 0 8） | 命中 |
| 项目行 | 32 | 32 | **32** | 命中 |
| 工具格 | 未测（unknown） | 未测（unknown） | **43**（宽 54.25，4 格） | 与 `15-VISUAL-REBUILD-PLAN` §2.1「item 43 / row 45」的 item 值一致；HTML 侧未测 |
| 分组标题 | 28 | 28 | **28** | 命中 |
| 左栏文件树 | 有（`H-src:1544-1556` `.file-tree` / 8 个 `.tree-row`） | 有（同源；1280 档未单独截图） | **无**（侧栏 DOM 中 `file/tree/explorer` 类命中 0 个，`C-main`） | 与 HTML 不同，**按用户决定**（`15-VISUAL-REBUILD-PLAN` §2.3「左栏不出现文件树」），属有意差异 |
| 横向溢出 | `scrollWidth=1400`（无） | `scrollWidth=1280`（无） | `scrollWidth=1280`（无） | 命中 |

### 4.2 40 行会话滚动（已取证 2026-10-27）

| 项 | 实测值 | 来源 |
|---|---|---|
| 会话行总数 | **43**（全部在 `.sidebar-sessions` 内；容器 44 个子节点 = 43 行 + 1 个「更早」分组标签） | `C-scroll` |
| 行高集合 | **{30}**（43 行全部 30.0） | `C-scroll` |
| 滚动容器 | `.sidebar-sessions`：`clientHeight 143`、`scrollHeight 1402`、`maxScroll 1259` | `C-scroll` |
| 实测滚动位置 | 顶 `scrollTop=0`（首行「对话 43」，3 行完整可见）→ 底 `scrollTop=1259`（末行「对话 1」，4 行完整可见） | `C-scroll` |
| 截图 | `sessions-scroll-top.png`（sha256 前 16 位 `78868d061ddfe7a0`）与 `sessions-scroll-bottom.png`（`d391cdb250be0960`）**内容不同**，证明是真的滚动 | `C-scroll` |

判定：**43 ≥ 40，且滚动全程行高不变（无压缩）**。
限制（必须写明）：1280×672 视口下会话区一次只能完整显示 3–4 行，“40 行同屏”在本机窗口尺寸下不可能出现；
本节证明的是计划 §2.4 要求的“40 行滚动不压缩”，不是“40 行同屏”。

### 4.3 键盘 focus（已取证 2026-10-27；判定：部分不达标）

| 项 | 实测 | 来源 |
|---|---|---|
| Tab 序列（从标题栏末尾起） | 标题栏 5 → 导航 3（`sidebar-nav-item`）→ 工具格 4（`sidebar-tool-item`）→ 项目「+」→ `.sidebar-sessions` 容器 → 排序按钮 → 项目行若干 → 用户区/插件入口/侧栏开关 → 聊天区控件 | `C-tab`（60 次采样）、`measure-tabdeep.json`（前 2 次） |
| 导航行焦点环 | `BUTTON.sidebar-nav-item`，`:focus-visible` 命中，`outline: 2px solid` + `outline-offset: 2px`（外扩） | `measure-navfocus.json`，截图 `tabfocus-nav-item.png` / `tabfocus-nav-item-zoom.png` |
| 会话行本体 | `DIV`，`tabindex=-1`，无 `role`、无 `aria-selected`；60 次 Tab 采样中命中 **0** 次 | `C-tab` |
| 会话行内操作 | `button.sidebar-session-pin` / `.sidebar-session-delete` 存在且 `tabindex=0`，但父级 `.sidebar-session-actions` 默认 `display:none`（hover 才显示），键盘不可达 | `C-main` DOM 清点 |
| 会话列表的键盘入口 | 只有滚动容器 `.sidebar-sessions`（`DIV`，可聚焦）进入 Tab 序列，环为 2px 外扩 | `C-tab`，截图 `tabfocus-session-action.png` / `-zoom.png` |
| 项目行 | 外层 `.sidebar-project-header` 是 `DIV[tabindex=-1]`，实际可点的是内层 `BUTTON.sidebar-project-btn`，出现在 Tab 序列里 | `C-tab` |
| HTML 侧对照 | `.session` 与 `.nav-item` 在 mock 里都是 `<button>`（`H-src:1508-1510`、`H-src:1523-1531`）；`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`（`H-src:151`） | `H-src` |

判定（对照 `15-VISUAL-REBUILD-PLAN` §2.4「键盘：行是 button，focus-visible inset」）：

1. **不达标**：会话行不是 button，是 `div[tabindex=-1]`，键盘无法聚焦到行；HTML 下限要求的是 `<button>`。
2. **与 HTML 一致、但与计划不符**：焦点环是 **2px 外扩**（HTML 也是 2px 外扩，`H-src:151`），计划 §2.4 要的「inset」在 HTML 里并没有对应规则。
3. 导航行/工具格/项目行是 button 且有统一 focus-visible 环：60 次采样里 59 次命中 `:focus-visible` 且 `outline` 为 `2px solid` + `offset 2px`；
   唯一未命中的一次是第 21 次落到 `BODY`（文档根，`tabindex=-1`，`outline: 3px none`），不是某个控件。

### 4.4 Phase 1 未取证

- **1400×875 真实窗口几何**：当前窗口最大化为 1280×672（`screen 1280×720`），本机无 1400 宽窗口态；1400 档只有 HTML 渲染值。状态：**未取证**。
- **深色以外主题下的左栏几何**（亮色/Hub/Dream）：**未取证**。
- **真实鼠标悬停时“时间让位、操作出现”的截图**：只有 DOM 规则读数，**未取证**。

---

## 5. 与上一版 `html-vs-current-vs-omp.md` 的差异（有据更正）

> 下表「」内是上一版原文（含其估算措辞），只为对照保留；本文件不采用这些写法。

| 上一版写法 | 本次实测 | 依据 |
|---|---|---|
| 「左栏宽：HTML 240 / 当前 240 / OMP 240」 | HTML **260**（1400 档，CSS 变量 `--sidebar-w: 260px`）；240 只在 ≤1280 档成立；OMP **272** | `H-1400`、`H-src:19`、`H-src:1398-1401`、`O-css` |
| 「正文列：HTML 820」 | HTML@1400 **732**、HTML@1280 **780**；**820 是 Codem 的 `--reading-column`**（`C-css:2688`），不是 HTML 的值 | `H-1400`、`H-1280`、`C-css` |
| 「OMP 导航行 约 30 / 会话行 约 29 / 正文列 约 780」 | 原图读数为 24.0 / 23.0 / 卡片 561–563；换算 32.0 / 30.7 / 748–751；`O-doc` 另记 30 / 28 / 768 | `O-img`、`O-css`、`O-doc` |
| 「右栏：HTML 400（1440）/隐藏（1280）、OMP 360、当前 360」 | HTML@1400 **360**（`--inspector-w` 在 ≤1440 已降到 360，400 只在 >1440 成立）；OMP **480**（360 是原图 px）；当前折叠 **36**、展开 **360** | `H-1400`、`H-src:1394-1396`、`O-css`、`C-rail` |
| 「Composer 宽 798（右栏展开时）」 | **798 是内卡 `.input-wrapper`**，与右栏无关：右栏收起时外壳 820 / 内卡 798；右栏展开时外壳 680 | `C-main`、`C-rail` |
| 「设置组数 6 组 / 23 tab」 | 当前确实是 6 组 + 23 tab，但 HTML 不是 6（8 分区 + 4 组 + 5 子导航），OMP 是 8 分区 | `H-set`、`C-set`、`O-set` |
| 「40 行滚动与键盘 focus 截图」列在“未完成” | 本次已取证：43 行滚动无压缩（§4.2）、键盘 Tab 序列与焦点环（§4.3） | `C-scroll`、`C-tab` |

上一版把 **OMP 的图像 px 和 Codem 的 CSS px 放在同一列比较**（OMP 240 / 约 30 / 约 29 / 约 780 / 360 都是原图读数），
在 0.75 缩放下这些数字整体偏小，导致多处「持平」结论站不住。本文件不再用 OMP 数字下「持平/更优」判断，只列可复核的数值与分歧。

---

## 6. 复现命令

全部脚本在 `C:\temp\visual-gate\`（不入库），依赖仓库内 `ws`：

```powershell
# 1) HTML mock 渲染实测（Edge headless + CDP 精确视口）
node C:\temp\visual-gate\vg-html.mjs 1400 875 1400x875
node C:\temp\visual-gate\vg-html.mjs 1280 672 1280x672
node C:\temp\visual-gate\vg-html-settings.mjs        # 设置页（临时去掉 hidden）

# 2) 安装版 CDP 实测（WebView2 9223）
node C:\temp\visual-gate\vg-measure.mjs main
node C:\temp\visual-gate\vg-measure.mjs settings
node C:\temp\visual-gate\vg-scroll2.mjs              # 43 行滚动（顶/底 + 哈希）
node C:\temp\visual-gate\vg-taborder.mjs             # 60 次 Tab 采样
node C:\temp\visual-gate\vg-navfocus.mjs             # 导航行焦点环截图
node C:\temp\visual-gate\vg-rail.mjs                 # 右栏 36↔360

# 3) OMP 参考图像素扫描（PowerShell + System.Drawing）
& C:\temp\visual-gate\omp-measure.ps1 -Path <jpg> -Mode vlines|hlines|bands|lineextent|rowedges
```

采集期间对应用做过的状态改动只有四类：打开/关闭设置页、展开右栏后立即收起、滚动会话列表、发送 Tab。
结束时已复核还原：`.sidebar=240`、`.right-sidebar=36`（折叠）、`.input-area=820`、`scrollWidth=1280`。

---

## 7. 证据文件清单（`C:\temp\visual-gate\`，按批次约定不入库）

| 文件 | 字节 | sha256 前 16 位 |
|---|---:|---|
| `html-1400x875.png` | 151,915 | `1e49cb4ee5a7e9dd` |
| `html-1400x875.json` | 2,779 | `0c7340b386a98b61` |
| `html-1280x672.png` | 89,307 | `205d6dcd01418701` |
| `html-1280x672.json` | 2,770 | `1fd253d446d35c0a` |
| `html-settings-1400x875.png` | 89,392 | `ab1002e3b7d18038` |
| `html-settings-1400x875.json` | 1,266 | `6cfbfd549900d0b8` |
| `cur-main-1280.png` | 447,973 | `fff32c82dcc3414d` |
| `cur-settings-1280.png` | 266,198 | `acb80f0f346b4845` |
| `rail-expanded-1280.png` | 477,053 | `2a8039da351bc080` |
| `sessions-scroll-top.png` | 447,973 | `78868d061ddfe7a0` |
| `sessions-scroll-bottom.png` | 454,711 | `d391cdb250be0960` |
| `tabfocus-nav-item.png` | 470,623 | `b99fae3eba9a7186` |
| `tabfocus-nav-item-zoom.png` | 34,898 | `941f3f30252c155a` |
| `tabfocus-session-action.png` | 455,908 | `1ae3949b5d42c971` |
| `tabfocus-session-action-zoom.png` | 83,221 | `2791385d02ddeb23` |
| `measure-main.json` | 5,093 | `d40a6c1a470d5c6c` |
| `measure-settings.json` | 2,284 | `f7d145d077de386d` |
| `settings-detail.json` | 2,186 | `42923f9f549eb288` |
| `measure-rail.json` | 1,237 | `6251d5911f512098` |
| `measure-scroll2.json` | 856 | `d35d157b492f40de` |
| `measure-taborder.json` | 19,050 | `acd25ee75c406773` |
| `measure-tabdeep.json` | 884 | `b76bf947c3825abd` |
| `measure-navfocus.json` | 212 | `d5126e247933e15a` |
| `omp-crop-rail.png` | 20,391 | `1216371473601dcd` |
| `omp-crop-nav.png` | 95,494 | `6fa98fd0de003b3d` |

OMP 原图（在仓库内，未复制）：`docs/evidence/ui-benchmark-omp-2026-10-26/omp-workbench-dark.jpg`（60,729 B）、`omp-settings-dark.jpg`（38,924 B）、
`codem-main-dark.jpg`（60,835 B，用于 §0.2 尺度校准）。

---

## 8. 未取证 / unknown 汇总

| 项 | 状态 | 原因 |
|---|---|---|
| 当前安装版 1400×875 真实窗口几何 | **未取证** | 本机窗口最大化为 1280×672 |
| OMP 项目行高 / 工具格高 / 分组标题高 | **unknown** | 参考图里这些元素没有可判定的独立边界 |
| OMP 正文列 768 | **文档记载**（`O-doc` L591），非本次实测 | 图像里只有卡片外边界（748–751），列宽本身无可见边界 |
| OMP 设置「常规」以外分区的分组数 | **未取证** | 只有一张设置参考图，且只显示常规页 |
| OMP 亮色主题 / 命令面板 / 模型菜单几何 | **未取证** | 本轮只做工作台与设置 |
| HTML mock 40 行滚动 | **不适用** | mock 只有 6 个 `.session`（`H-src:1523-1531`），无法做 40 行压测；40 行证据只来自安装版 |
| 当前设置页真实行高（`set-row` 最小高度/控件宽） | **未取证** | 本轮 `C-set` 只测容器与计数，未逐行测 |
| 亮色/Hub/Dream 下的同一组几何 | **未取证** | 本轮固定 dark + default 皮肤 |
