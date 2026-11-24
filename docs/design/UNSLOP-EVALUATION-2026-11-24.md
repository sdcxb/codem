# Codem × unslop 全面评估（2026-11-24）

> 方法：按 Damir Sokolovsky 的 [unslop](https://github.com/heydamir/unslop)（CC BY 4.0）做
> 「audit → direction → 九道 pass → checklist」评审；只评估与建议，本次不改产品代码。
> 对象：`design/unslop-v2` @ `679e02a8`（v1.18.16），1440×900 实机截图 5 张。

## 0. 结论

> 2026-11-24 收口：本轮已把可见 chrome emoji 清零；`ui-no-emoji` 存量从 233 行 / 47 文件收紧到 16 行 / 6 文件，剩余仅为身份/宠物选择器与 emoji→lucide 的兼容 key。


**方向成立，机械门禁是绿的，但设计迁移没有收完。**

Codem 已经不是「紫色 SaaS 仪表盘」：石墨底、黄铜 accent、等宽元数据、diff/工具调用作为主内容，
这些都符合产品自己的世界。剩余问题不是「再换一套皮」，而是三类遗漏：

1. **emoji 债被棘轮合法化了**：门禁基线仍是 233 行 / 47 个文件，自 2026-11-18 建立后没有收紧；
   实机插件页仍有 **57 行可见 emoji**，设置页 **22 行**。
2. **管理型页面退回模板**：任务中心是四张等宽 KPI 卡 + 空热力图；插件页是三列 emoji 卡片；
   技能页是半屏列表 + 大块空拖拽区。这些页面换成任何 Agent 产品都成立。
3. **技术信息直接当 UI**：崩溃恢复提示把进程退出码、host/webview 内存表整段铺在标题栏上，
   而且这条 11/20 的记录在 11/24 仍常驻；记忆页把 batch id 当主文本。

评级：**light-to-medium slop（轻到中度）**。不需要重做方向；需要一次「清理 + 重新分配信息密度」的
polish pass，重点在 emoji、告警、管理页构图、层级，而不是再改 token。

---

## 1. 实测证据

| 项 | 读数 | 说明 |
|---|---|---|
| 全量测试 | 999 文件 / 10425 用例，10407 通过 / 18 skipped / 0 失败 | v1.18.16 后 |
| `scan-ui.mjs` | error 0 / warn 0 | 机械一致性门禁 |
| UI 文案棘轮 | banned 0 / greeting 0 / exclamation 0 / rawMarkdown 0 | 词表规则已清零 |
| emoji 棘轮 | 基线 **233 行 / 47 文件**，`at=2026-11-18` | 只许降，但**没有收紧过** |
| 实机可见 emoji | 聊天 0、任务 0、技能 0、插件 **57**、设置 **22** | `document.body.innerText` 按行统计 |
| CSS 遗留 | 55 处紫色字面量、20 处 radial、22 处 linear、128 处 `backdrop-filter`、11 处 `--shadow-glow`、34 处 `text-transform: uppercase`、79 处 `--radius-full` | 主要在未迁移的 PPT / 笔记 / library-ops / 旧皮肤 |
| 实机截图 | `.preview-shot/eval-main.png`、`eval-tasks.png`、`eval-plugins.png`、`eval-skills.png`、`eval-settings.png`、`eval-memory3.png` | 本地取证，未提交 |

机械门禁为什么没拦住：`scan-ui` 查的是硬编码字号/圆角/颜色/类名，不判断「四张等宽卡是否模板」；
`ui-no-emoji` 是**棘轮**不是清零，且扫描的是 JSX 文本 + 字符串字面量（包含日志字符串），
所以它既允许 233 行存量，也无法区分「按钮上的 emoji」和「console.log 里的 ✅」。

---

## 2. 方向复核（五句话）

- **Product**：本地优先的桌面 AI 编程代理，把对话、计划、工具调用、验证串成可审计的工作流。
- **Character**：精确、技术、克制，有一点温度（现有方向，保留）。
- **World**：工程工作台、终端、图纸、机房的石墨 + 黄铜世界，不是 SaaS 仪表盘。
- **Moments**：diff / 验证结果；上下文时间轴 / 任务图（现有方向，保留）。
- **Signature**：细绿色状态点 + 等宽元数据（`ctx 68%`、`12 tools`、`2m 14s`）；建议再加一个
  **diff 行号轨 / 验证结果轨**，让签名长在内容上，而不是 chrome 上。

方向本身不需要改。需要改的是：**把黄铜和「丰富度」收回给一个内容时刻，把管理页的 chrome 变安静。**

---

## 3. 逐项审计

### 3.1 Emoji / 图标（最明显的遗留）

**实机**：

- 插件管理：57 行可见 emoji。每张插件卡一个 emoji（🧩 / 🤖 / 🔧 / 💬 / 💾 / 🧠 / 🔐 / 🔌 / ⚡ / 👥 / ⚙️ / 🎨 / 📁），
  另有 🔴/⚠️ 风险徽标。
- 设置：`⚙️ 设置` 标题、`🔒 沙箱模式…`、`🔄 会话恢复`、`📊 用量统计`，以及身份头像的 12 个 emoji。
- 代码里还有大量**按钮 emoji**：
  - `src/components/ppt/EditorToolbar.tsx:87` `📝 文本`、`:96` `🖼️ 图片`、`:101` `📋 复制`、`:216` `💾 版本`
  - `src/components/MemoryManager.tsx:2065` `💾 保存`
  - `src/components/FileEditor.tsx:540` `📂 用系统应用打开`
  - `src/components/GoalModeBar.tsx:193` `🧭`
  - `src/components/McpMarketplace.tsx:156` `🏪`
  - `src/components/BootstrapWizard.tsx:251` `🚀 开始`
  - `src/components/GenerateModeSelector.tsx:26-28` `📝 / 🖼️ / 🎬`
  - `src/components/GitInfoPanel.tsx:294-296` `📝 / ✏️ / ❓`
  - `src/components/MultimodalPanel.tsx:318` `🎨 多模态设置`

**判断**：emoji 不是「品牌温度」，是未迁移的图标系统。它们还会进入 accessible name
（读屏会念「软盘 保存」「文件夹 用系统应用打开」），和方向里的 lucide 16/18px、1.5 stroke 冲突。

**建议**：

- chrome（导航、按钮、标题、状态、空状态）emoji 清零；全部换 lucide 16/18。
- 只保留三类例外，且写进 allowlist：
  1. 用户自己选的身份头像 / 宠物表情（`identity.emoji`、Pet 内容）；
  2. 用户内容（笔记标题里的 📓 等）不强制改；
  3. 纯文本符号 ✓ / ✗ 可以保留，但要统一由 `StatusIcons` 输出，不散落。
- 插件 manifest 的 `icon` 若是 emoji，改为 `iconName` 映射到 lucide；没有映射就显示首字母/无图标。
- **门禁改法**：`ui-no-emoji` 拆成 `ui-visible-emoji`（JSX 文本 + `aria-label`/`title`/`placeholder`，
  排除 `console.*`/日志/测试）+ `ui-identity-emoji`（allowlist）。前者目标 0，后者只允许身份/宠物。
  现有 233 行基线要先清零一遍再收紧，不能继续「只许降」但从不降。

### 3.2 崩溃恢复提示（P0，最伤画面）

实机顶部常驻一条 5 行告警，压住标题栏和页面头部：

```text
检测到界面渲染进程崩溃（2026/11/20 08:59:01），已自动重载恢复；会话数据都在本地数据库里，不受影响。判据（反馈问题时请附上这一行）：
kind=GPU_PROCESS_EXITED(6) reason=CRASHED(3) exit_code=34 | host=44MB
webview_total=394MB webview_procs=6 [15112:125MB,...] total=438MB
```

来源：`src/core/diagnostics/renderer-evidence.ts:179-180` 生成整段 message，
`src/App.tsx:2903` 通过 `addPersistAlert({kind:"action"})` 常驻展示；11/20 的记录到 11/24 还在。

**问题**：

- 技术上准确，但不是用户文案；`kind=... exit_code=... host=...` 是日志，不是 UI。
- 告警横跨标题栏，盖住「设置 / 返回工作台 / 页面标题」，破坏所有页面的第一屏。
- 没有「详情 / 复制诊断 / 关闭后不再提示」的层级；用户只能读完整段。
- 过期记录没有 TTL，旧事故永久占据首屏。

**建议**：

- 默认只显示一行：`上次界面意外重启，已恢复；会话数据未丢失。` + `详情` + `关闭`。
- `详情` 展开后才显示 kind/reason/内存表，并提供「复制诊断」。
- 记录带时间戳与 app 版本；超过 24h 或成功运行一段时间后自动降级到「设置 → 诊断」。
- 告警不要覆盖标题栏；放在内容区顶部，或做 toast + 可回看。
- `addPersistAlert` 对 `kind:"action"` 增加“可折叠/可过期”语义，避免永久占位。

### 3.3 任务中心（模板感最强）

实机 `eval-tasks.png`：

- 顶部 4 张等宽卡：收件箱 53、Issues 0/0/0、委派 0/14/0、自动化 0/0/0。
- 第二行 3 张等宽卡：运行状态、最近会话、活动概览。
- 活动概览是 14 天空白热力图 + 大圆环 `0 总计` + `暂无数据`，占掉整块宽度。
- 右下「场景实况」塞了一张 481×191 的像素画办公室，是 library-ops 插件场景的缩略。
- 页签 8 个：概览 / 委派 / 子智能体 / 自动化 / Issues / 看板 / 团队 / 收件箱。

**判断**：等宽 KPI + 空图表 + 装饰插画 = 典型 dashboard 模板；它没有把 Codem 的
「任务 → 工具 → 验证」故事讲出来。`场景实况` 是有产品世界的，但缩到 481×191 后既看不清，
也不承载信息，只是占用一张卡。

**建议**：

- 第一行只留 3 个紧凑数字：未读、运行中、今日完成；不要 4 张同构卡。
- 主视觉改成**一条真实的 14 天活动折线/柱状图**（有数据才显示），没有数据就一行
  `最近 14 天没有活动`，不要空网格 + 大 0 圆环。
- 去掉概览里的场景缩略；把「场景」放回「子智能体 / 团队」页签，作为该页的主角。
- 页签收敛到 5 个以内：概览 / 任务 / 团队 / 自动化 / 设置；其余进「更多」。
- 每张卡只回答一个问题；不要 3 个 0 并排。

### 3.4 插件管理（emoji 最密集）

实机 `eval-plugins.png`：

- 标题下 `198` / `197 启用` 两个 pill；筛选行 6 个 pill（全部/核心/Provider/界面/兼容/工具）。
- 三列卡片：每张卡 emoji + 名称 + 版本 + 一句英文描述 + 2–3 个标签 + 依赖数 + 高风险 pill + 开关。
- 卡片高度不一，英文描述被截断；底部 `再显示 40 个插件（还有 158 个）`。
- 顶部 DSH Ops 大块说明 + 外部运行时；页面信息密度高但没有主次。

**判断**：这是一个「插件清单」，不是展示橱窗。卡片 + emoji + 每卡标签 + 每卡开关，
让 198 个插件变成 198 个视觉噪音；用户真正要的是「找、看依赖、开/关」。

**建议**：

- 改成**密集列表**（行高 36–40）：`名称 · 版本`｜类型｜状态｜依赖｜开关；详情在右侧/展开行。
- 去掉每卡 emoji；只在「类型」列使用一个 lucide 图标，或完全不用图标。
- 顶部筛选收敛为搜索 + 3 个分段（全部/核心/其他）；`198/197` 变成一行 mono meta。
- 「高风险」只出现在真的需要用户决策的行；核心插件不要每张都挂徽标。
- 分页/虚拟滚动，不要「再显示 40 个（还有 158 个）」这种二次计数。
- 插件详情用 drawer / 右侧 panel，保留 README/依赖/权限，而不是塞进卡片。

### 3.5 技能管理

实机 `eval-skills.png`：

- 搜索框 + 大块 dashed 拖拽区（`拖拽 .zip 文件到此处安装技能`）占据首屏近 1/4。
- 列表只占左半，右侧完全空；行内有名称、版本 pill、描述截断、2 个标签、开关。
- tabs `我的技能 12` / `技能市场`；筛选 4 个 pill（全部/内置/用户/外部）。
- 开关是 iOS 式大胶囊，金色高亮。

**建议**：

- 拖拽区收进「安装 ZIP」按钮的 popover/dialog；首屏直接给列表。
- 列表 + 右侧详情双栏（选中行显示 SKILL.md 摘要、触发词、版本），不要半屏空白。
- 行高 56：名称 + 一行描述 + 最多 2 个标签；开关改为紧凑 32×18，不要大胶囊。
- `安装 ZIP` 是唯一主操作；搜索/筛选保持中性。
- 技能市场与本地区用同一列表组件，避免两个页面两套密度。

### 3.6 设置 / 记忆

**设置**（`eval-settings.png`）：

- 页面标题 `⚙️ 设置` 很小，正文 `身份配置` 反而 20px/600，是整页最大字；层级倒置。
  来源：`src/styles/unslop-v2.css:1618` 把 `.settings-section-title` 设为 `--fs-2xl`（20px），
  而页面标题只有 `--fs-lg`/`--fs-xl`。
- 底部 `📊 用量统计`、`保存设置`、`🔄 会话恢复` 三个动作并排；emoji + 不同权重，主次不清。
- 模型下拉显示成 `OpenAI - G`（截断），用户不知道是哪个模型。
- 左栏 23 个子页，图标 + 文本；分组标题与项之间距离接近，扫读成本高。

**建议**：

- 页面标题 20–24/600；section title 16/500；正文 13/400；meta 11–12/400 mono。
- `身份配置` 降到 16/500，不要比页面标题大。
- 底部只保留 `保存设置` 主按钮；`用量统计`/`会话恢复` 移到页面菜单或标题栏工具。
- 模型选择宽度 ≥ 220，显示完整 `provider / model`；截断时 tooltip 给全名。
- 左栏行高 32–36，分组标题与项之间 24/8 节奏；图标统一 16。

**记忆**（`eval-memory3.png`）：

- 顶部一行 8 个数字：`21 21 0 0 0 0 21 129.0 KB`，没有分组；用户不知道先看哪个。
- 自动提取批次显示 `batch-1794301676669-dcnztq` 这类 opaque id 作为主文本。
- 三段并列说明（写入审批 / 自动提取 / 超预算）都是长段落，正文对比度低。
- 工具栏 `+ 新增 / JSON / MD / 导入 / 整合 / ×` 权重相同。

**建议**：

- 顶部只留 3 个指标：待批准 / 已生效 / 体积；其余进「详情」。
- batch id 放 `<code>` 11px muted，前面显示人类可读的「批次 · 时间 · N 条」，id 只用于复制。
- 把政策说明折叠成「如何写入 / 审批规则」两条 disclosure；默认只留一句结果。
- `新增` 主按钮，其余导入/导出进「更多」菜单。

### 3.7 颜色 / 表面 / 组件

- **默认 v2 是干净的**：实机聊天/任务/技能没有紫色渐变、没有 glow；`unslop-v2.css` 里
  `backdrop-filter:none` / `box-shadow:none` 明确压掉了旧装饰。
- 但仓库仍有 **55 处紫色字面量、20 处 radial、22 处 linear、128 处 backdrop-filter、
  11 处 glow、34 处 uppercase、79 处 `--radius-full`**；集中在：
  - `src/styles.css`（52 紫色）
  - `src/components/ppt/ppt-editor.css`（8 紫色 + 渐变）
  - `src/styles/codem-ui.css`、`skin-hub.css`、`skin-dream.css`
  - `notebook-workspace.css`、`library-ops` 插件
- 这些是**未迁移表面**：PPT 编辑器、知识笔记本、library-ops、皮肤。用户一打开就回到旧世界。
- 实机插件/技能页的 accent 使用也偏多：金色同时出现在主按钮、开关、选中 tab、图标、计数；
  方向里「accent 面积 < 5%、只给主操作/选择/一个数字」没有完全执行。

**建议**：

- 给未迁移表面两种选择：彻底迁到 `--ui-*`，或显式 `[data-ui="v1"]` 作用域，禁止在 v2 下混用。
- 删除/迁移紫色字面量；PPT/笔记至少把紫色、glow、radial 三样清零。
- accent 预算：每个屏幕最多 2 处（一个主操作 + 一个当前选择/关键数字）；开关用中性/成功色，
  不要金色胶囊。
- `--radius-full` 只留给真正的状态点/头像；按钮 8–10、卡片 12–16、面板 14–20。
- uppercase 仅留给代码/缩写；中文界面本来没有大小写，旧样式里的 tracked uppercase 直接删。

### 3.8 文案 / 空状态 / 数据

文案扫描器已经清零 banned/greeting/感叹号/raw Markdown，这是实打实的进步。但 unslop 的
copy pass 还包括「短标签、无 trailing ellipsis、change 带参照、mock 数据可信」：

- 20+ 个 placeholder 以 `...` 结尾：`搜索技能...`、`搜索插件...`、`搜索设置...`、
  `CODEM、小助手、或者随便什么...`、`在指定项目里搜索记忆...`。建议全部改成
  `搜索技能`、`搜索插件`、`搜索设置`、`输入名称`。
- 记忆页 opaque id、恢复提示的技术 dump 属于「内部标识当用户文案」。
- 任务中心 `再显示 40 个插件（还有 158 个）` 是二次计数；改成 `加载更多（剩余 158）` 或分页。
- 空状态：任务空热力图 + 大 0 圆环、技能大拖拽区、插件 158 个剩余，都应改成一句
  具体结果 + 一个动作，而不是占位视觉。

### 3.9 间距 / 字体 / 动效

- 间距：`scan-ui` spacing-raw 0，4px 网格基本成立；但同一屏幕的密度不一致
  （设置很松、插件卡很挤、技能列表行高不统一）。需要按「导航 32–36、卡片 20–24、
  页面 24–32」重排，而不是只保证数值合法。
- 字体：字号档位基本收敛；问题是**层级倒置**（section > page title）和少数 20/600 的
  管理标题过重。建议页面 20–24/500，section 16/500，正文 13/400，meta 11–12/400 mono。
- 动效：`animate-pulse`/`animate-ping` 0，没有明显的呼吸 glow；这部分是干净的。
  保留一个 easing，不要新增 spring/overshoot。

---

## 4. 仍然做得好的地方（不要推倒）

- 石墨 + 黄铜的方向和 token 是成立的；聊天/任务/技能主界面已经没有紫色 SaaS 味。
- diff、工具调用、上下文元数据是 Codem 自己的「高信息时刻」；这是产品唯一性所在。
- 文案棘轮四类清零；`scan-ui` error/warn 0；无 pulse/glow 的默认 chrome。
- 键盘焦点、可访问名、图标按钮的 aria 做得比一般项目好；问题在 emoji 进入可访问名。
- 机制（判据、变异、截图）是资产；缺的是**设计验收判据**，不是执行力。

---

## 5. 优先级建议

### P0（先做，1–2 天）

1. **恢复提示降噪**：一行结果 + 详情折叠 + 过期；不再覆盖标题栏（具体见 §3.2）。
2. **可见 emoji 清零**：插件页 57 行、设置页 22 行先清；PPT/记忆/文件/Git/目标模式随后；
   身份/宠物 allowlist 单独登记。
3. **任务中心重构**：4 张等宽卡 → 3 个紧凑数字 + 一张真实活动图；去掉概览场景缩略；
   页签 ≤5。
4. **插件页改列表**：去掉卡片 emoji/每卡徽标，行高 36–40，详情 drawer。
5. **设置层级修正**：section title 16/500，page title 20–24；底部只留一个主操作。

### P1（下一批，2–4 天）

6. **技能页双栏**：拖拽区收进安装 dialog；列表 + 详情；开关紧凑。
7. **记忆页信息重排**：3 个指标、batch id 降级、政策 disclosure。
8. **未迁移表面颜色清理**：PPT/笔记/library-ops/皮肤；v2 下紫色、glow、radial 清零。
9. **accent 预算**：每屏 ≤2 处；开关/标签改中性；圆角从 full 收回到 8–16。
10. **文案清理**：20+ 个 `...` placeholder、技术 id、二次计数、空状态。

### P2（收口）

11. 字体/间距 token 清扫；管理页标题统一。
12. 图标统一 lucide 16/18、1.5 stroke；删除 colored emoji icon 字段。
13. 截图回归：1440 / 1024 / 768 三档，聊天 / 任务 / 插件 / 技能 / 设置 / 记忆六屏。
14. 模板检查：把 Codem 名字换掉，任务/插件/技能页是否仍成立；不成立就继续把内容做得更 Codem。

---

## 6. 门禁改造（这是这次评审最重要的结构性建议）

当前门禁能证明「没有硬编码字号/紫色字面量/新增 emoji」，不能证明「界面不再像 AI 生成」。
建议补四条，且都要能在改坏时变红：

1. **`ui-visible-emoji`**：JSX 文本 + `aria-label`/`title`/`placeholder`，排除 `console.*`、
   日志、测试；chrome 目标 0，身份/宠物 allowlist。把现有 233 行拆成「可见」与「日志」两份，
   先清可见，再收紧。
2. **`ui-accent-budget`**：对六个固定屏幕做像素采样，accent 色面积 > 3% 或主操作 >1 个即红；
   至少要有「每屏一个主操作」的截图证据。
3. **`ui-surface-budget`**：v2 作用域内禁止 `radial-gradient` / `linear-gradient` / `glow` /
   `backdrop-filter`（代码/图表/用户内容除外）；未迁移表面必须显式 `data-ui="v1"`。
4. **`ui-copy-shape`**：在现有词表外加 `placeholder ends with ...`、`technical id as label`、
   `double count` 三条形制规则；不是只查禁用词。

另外：`ui-no-emoji` 的 `at` 仍是 2026-11-18，说明批次结束后没有执行「清掉就收紧」。
建议每批结束必须跑 `UNSLOP_UPDATE_BASELINE=1` 并把新读数写进批次账本，否则「只许降」会变成
「永久允许 233 行」。

---

## 7. 建议的下一批（可直接排期）

| 批次 | 内容 | 验收 |
|---|---|---|
| 8A | 恢复提示 + 设置层级 + 可见 emoji（设置/插件先清） | 首屏无技术 dump；`ui-visible-emoji` chrome 0；设置 section < page title |
| 8B | 任务中心构图 | 3 个数字 + 1 张真实活动图；无空热力图/场景缩略；页签 ≤5 |
| 8C | 插件/技能列表化 | 行高 36–40；无每卡 emoji；详情 drawer；1440/1024 不裁切 |
| 8D | 未迁移表面颜色 + accent 预算 | v2 下紫色/glow/radial 0；每屏 accent ≤2 |
| 8E | 文案/空状态/截图回归 | `...` placeholder 0；六屏三档截图通过 |

---

## 8. 证据索引

- 截图（本地，未提交）：
  - `.preview-shot/eval-main.png`
  - `.preview-shot/eval-tasks.png`
  - `.preview-shot/eval-plugins.png`
  - `.preview-shot/eval-skills.png`
  - `.preview-shot/eval-settings.png`
  - `.preview-shot/eval-memory3.png`
- 代码：
  - `src/core/diagnostics/renderer-evidence.ts:179`
  - `src/App.tsx:2903`
  - `src/components/PluginManager.tsx:132`（`plugin.icon`）、`:162`（risk 徽标）
  - `src/components/ppt/EditorToolbar.tsx:87-216`
  - `src/components/MemoryManager.tsx:2065`
  - `src/components/FileEditor.tsx:540`
  - `src/components/SettingsPanel.tsx:2060`
  - `src/components/McpMarketplace.tsx:156`
  - `src/components/GoalModeBar.tsx:193`
  - `src/styles/unslop-v2.css:1618`（section title 20px）
  - `tools/ui-audit/copy-guard-baseline.json`（emoji 233/47，`at=2026-11-18`）
- 方法：unslop by Damir Sokolovsky，CC BY 4.0，https://github.com/heydamir/unslop
