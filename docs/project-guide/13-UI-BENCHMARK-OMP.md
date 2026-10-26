# 13 · UI/UX 对标：OMP Studio vs Codem（可验收优化方案）

> 基线：Codem 1.16.330（2026-10-26）｜ OMP Studio 0.1.10（`main` @ `6c82315`）
> 方法：**真实运行 + 源码取样 + computed style + 截图对照**，不是只看参考图。
> 证据目录：[`docs/evidence/ui-benchmark-omp-2026-10-26/`](../evidence/ui-benchmark-omp-2026-10-26/README.md)

---

## 0. 先说结论

OMP Studio 的 UI 之所以“看起来漂亮”，不是因为它用了更多特效，而是因为**一套很克制、贯穿所有元素的视觉语法**：

- **一个强调色**（lilac），**一套中性灰阶**，**一条 2px 间距阶梯**；
- **6 / 9 / 12 / 16 四档圆角**，**1px 边框**，**静态面板不用阴影**；
- **12px 界面字 / 14px 正文 / 16px 标题**，层级靠字重与留白，不靠字号乱跳；
- **44px 顶栏 + 272px 侧栏 + 480px 右栏 + 768px 文档列 + 240px 底栏**，所有屏幕共用同一组布局常量；
- **每个交互只有一个焦点指示**，输入框是柔光、按钮是 2px outline、菜单是边框；
- **所有“操作”都有稳定的位置**：页头导航、右栏页签、底栏页签、Composer 工具栏；
- **细节有物理感**：按钮按下 `translateY(1px)`，菜单从 `-3px` 进入，页切换上浮 12px，树行悬停时文件名渐隐让位给操作按钮。

Codem 的功能比 OMP 多得多（23 个设置分区、任务中心、知识笔记本、记忆、手机/微信、三套皮肤），**不应该照搬 OMP 的页面 IA**。但 Codem 目前的“视觉语法”是**多套并存**的：composer 是透明直角色块 + 重阴影，settings 是 760px 弹窗 + 20% 紫选中（比 OMP 的 14% 更重），消息是 907px 宽文档 + 大号标题，树是 28px 行 + 彩色 pill 徽章，工具是每张都带边框的卡片。每一处单看都还行，合起来就“不够贵”。

**本方案的目标不是变成 OMP，而是把 Codem 收敛成一套自己的、同样克制的语法。** 优先级：

1. **P0（先做，风险低、观感提升最大）**：Composer 卡片化、文档宽度收窄、暗色 token 提亮、静态面去阴影、焦点单环、设置选中态变柔、聊天内标题降级。
2. **P1（组件级）**：命令面板、模型角色菜单、侧栏/文件树密度、工具行、设置分组行、菜单/弹层、空态。
3. **P2（布局级，需产品拍板）**：设置从弹窗改为整页、右侧 Inspector 常驻、底部面板、页面级导航。
4. **P3（持续）**：三皮肤 token 对齐、对比度、动效、截图契约。

### 0.1 如果只做 10 件事

| # | 改动 | 为什么 | 验收 |
|---|---|---|---|
| 1 | Composer 变成 820 宽、14px 圆角、surface 底、无阴影、无内线 | 当前最像“工具条”，不是“输入卡” | 空/运行/焦点三态截图；computed 断言 |
| 2 | 正文列 820，Markdown 标题 16/15/14 | 907px + 20px h1 让聊天像网页 | 长消息截图；行宽/标题对照 |
| 3 | 暗色边框 .14→.09，文字 #d4d4d4→#e6e7ea | 去“黑框套黑框”，提阅读对比 | 对比度脚本 + 主界面截图 |
| 4 | 焦点单环：输入 3px 柔光，其余 2px outline | 现有双环/常亮历史 | Tab 20 控件无“双环” |
| 5 | 设置 active 20%→14%，行组卡片化 | 选中态厚重、内容散 | 设置页截图；行组圆角 |
| 6 | 命令面板改命令中心（分组/导航/快捷键） | 现在只是“项目搜索” | 四组命令截图；键盘可达 |
| 7 | 模型菜单按角色分组 + 选中 check + 隐藏未知 | 现在是 10 行模型名 + `【未知】` | 首屏 ≤9 行；每行三要素 |
| 8 | 侧栏/树密度：260 / 34 / 30 / 26；Git 字母 | 现在偏大、pill 吵 | 40 行滚动；hover 截图 |
| 9 | 工具去“每张卡”边框，改行 + 状态轨 | 连续调用像一叠盒子 | 5 个工具连续截图 |
| 10 | 用户气泡去阴影；实底方案先做对比度审计 | 阴影让静态消息“浮起来” | 暗/亮/三皮肤对比度 |

---

## 1. 证据与方法

### 1.1 OMP Studio

- 仓库：`https://github.com/the-snowpear/omp-studio`，`main` @ `6c823154963451074a36feb4cfd992cb7bf2e021`，`package.json` 0.1.10。
- 技术栈：Electron + React 19 + Vite；renderer 是纯浏览器 surface，仓库自带 `preview-app-harness.html`。
- 运行方式：`npm install` → `npm run build:packages` → `npm run dev -w @omp-studio/renderer -- --port 5174`。
- 截图 URL：`http://[::1]:5174/preview-app-harness.html?preview=1&route=...&theme=...&density=...&lang=zh`。
- **数据是 fixture**（页面有“演示”标记），但 DOM / CSS / 组件是生产 renderer 的真实实现；布局、字号、颜色、圆角、交互都可以作为设计参考。
- 截图环境：Edge headless，1600×1000，DPR 1。

### 1.2 Codem

- 本机安装版 1.16.330，`%LOCALAPPDATA%\Codem\codem.exe`。
- 使用**隔离数据副本** `C:\temp\codem-ui-bench\data`（`CODEM_DATA_HOME`），不写用户真实库。
- WebView2 CDP `9223`，1600×1000，实际 DPR 2（原图 3200×2000，证据图压到 1200 宽）。
- 覆盖：默认皮肤 dark/light、Hub、梦幻、设置弹窗、命令面板、模型菜单、审批菜单。
- computed style 通过 CDP `getComputedStyle` 读取，避免“看图猜数值”。

### 1.3 口径限制

- OMP 的数据是 fixture；**不要**把它截图里的项目名/会话内容当成真实产品数据。
- OMP 原生 Electron 窗口边框/系统菜单与浏览器 harness 不完全一致；本方案只对标 **renderer 内的窗口 chrome / 页面 / 组件**。
- 未做逐帧动效录制；动效结论来自 CSS token 与源码，不声称“手感完全一致”。
- 像素级结论只对同一 DPR、同一视口、同一主题成立；跨 DPR 需要重新截图。

---

## 2. 两套设计语言（一张表看懂）

| 维度 | OMP Studio | Codem 当前 | 判断 |
|---|---|---|---|
| 气质 | 扁平、轻、文档感、工具感 | 功能密度高，但面板/卡片/阴影并存 | Codem 需要**减层级**，不是加装饰 |
| 底色 | `#121519`（暗）/ `#fbfbfc`（亮），略带蓝的中性 | `#0e0f0f`（暗）/ 纯白（亮），纯中性 | Codem 暗色偏黑、偏硬；可轻微蓝移 |
| 表面 | `#1a1b1f`，与底色差 1 档 | `#1a1c1c` / `#212424`，差 2 档 | OMP 表面更含蓄；Codem 的 `#212424` 容易“块状” |
| 强调 | `#9e8cfc`（暗）/ `#6e56cf`（亮） | `#7c6cf0`（暗）/ `#6555e0`（亮） | 亮色接近但不同；暗色 Codem 更饱和、更暗 |
| 文字 | `#e7e8eb` / `#a7abb4` / `#8b909a` | `#d4d4d4` / 82% / 67% | Codem 暗色文字偏灰，标题不够“亮” |
| 边框 | `rgba(255,255,255,.07)`；浮层 `#46505f` | `rgba(255,255,255,.14)`；分隔 5–6% | **Codem 暗色边框粗一倍**，是“框感”的主要来源 |
| 阴影 | 静态面 `none`；任务 dock / toast 才用 | 设置、气泡、输入卡、菜单都用 | Codem 阴影“到处都是”，失去层级语义 |
| 圆角 | 6 / 9 / 12 / 16 / 999 | 4 / 6 / 8 / 10 / 14 / 20 / 999 | Codem 档位过多；树 4px 太尖，20px 太大 |
| 字号 | 11 / 12 / 14 / 16 / 18 / 22 | 10 / 11 / 12 / 13 / 14 / 16 / 18 / 20 / 24 / 28 / 32 | Codem 梯度过密；13 与 14 几乎不可分 |
| 正文 | 14px / 1.55；聊天正文 1.75 | 13px 基准 / 1.6；消息 14 / 22.4 | Codem 正文其实 14，但界面 13/14 混用 |
| 控件高 | 24 / 28 / 32；icon 22/26/28/32 | 26 / 30 / 34 / 38 / 44 | Codem 普遍大 4–6px，显“松” |
| 布局 | 36 menu + 44 page head；272 / 480 / 768 / 240 | 44 titlebar + 55 chat header；231 / 520 / 907 / 0 | Codem 顶部多 19px、正文多 139px |
| 密度 | `--density-scale` 0.85 / 1 / 1.15，只缩间距 | `data-density` 只改控件高 | OMP 的密度更整体；Codem 只改一半 |
| 焦点 | 2px outline + 2px offset；输入 3px 柔光 | 2px 实色环 + 多层 `:has` 补丁 | Codem 有“双环/常亮”历史，需收成单环 |
| 动效 | 120 / 180 / 250；ease-out；页面 12px 上浮 | 150 / 200 / 300；多段 shadow 过渡 | Codem 略慢、过渡属性过多 |
| 皮肤 | 只有 light/dark | 默认 / Hub / 梦幻 | Codem 更强，但 Hub/Dream 的 token 覆盖不全 |

> **重要纠正**：Codem 不是“缺设计令牌”。实测 Codem 的 `font-size` / `border-radius` 字面量各只有 **1 处**（`styles.css` + `styles/*.css`），OMP 反而有 141 处 font-size px、64 处 radius px。Codem 的问题是**令牌梯度过密、同一语义用了不同档、组合方式不统一**；不要用“再补一套令牌”来解决。

---

## 3. Token 对照（可直接作为改造表）

### 3.1 颜色

| 语义 | OMP Studio | Codem 当前 | 建议目标（默认皮肤） | 优先级 |
|---|---|---|---|---|
| 画布（暗） | `#121519` | `#0e0f0f` | `#101318`（轻微蓝移，不复制） | P0 |
| 侧栏/内嵌（暗） | `#0e1013` | `rgba(26,28,28,.88)` | `#0d0f12`，保持半透明 | P0 |
| 表面（暗） | `#1a1b1f` | `#1a1c1c` | `#17191d` | P0 |
| 主文字（暗） | `#e7e8eb` | `#d4d4d4` | `#e6e7ea` | P0 |
| 次文字（暗） | `#a7abb4` | `82%` 混合 | `#a7abb4` | P0 |
| 弱文字（暗） | `#8b909a` | `67%` 混合 | `#8b909a` | P0 |
| 边框（暗） | `rgba(255,255,255,.07)` | `rgba(255,255,255,.14)` | `.09`（主）/`.05`（次） | **P0** |
| 浮层边框 | `#46505f` | `--border-primary` | `#3a424e`，仅浮层 | P1 |
| 强调（暗） | `#9e8cfc` | `#7c6cf0` | **P0 保持 `#7c6cf0`**；P1 再评估提亮（会牵动 `--text-on-accent`） | P1 |
| 强调（亮） | `#6e56cf` | `#6555e0` | 保持 Codem 品牌蓝紫（不复制 OMP） | — |
| 强调软底 | `rgba(158,140,252,.14)` | `accent-muted`（20%） | 12–14% | P0 |
| 成功/警告/错误 | `#46b983` / `#e0a23c` / `#f06568` | 现有令牌 | 降饱和 8–12%，先测对比度 | P1 |
| 选中文本 | `rgba(158,140,252,.30)` | `accent 32%` | 保持 | — |

> 暗色边框从 14% 降到 9% 是**单项收益最大**的改动：它会把“每个面板都像盒子”变成“面板靠底色分层”。先只改默认皮肤，Hub/Dream 单独验证。

### 3.2 字体

| 角色 | OMP | Codem | 建议 |
|---|---|---|---|
| 界面正文 | 12px | 13px | 保持 13，但**导航/按钮/树**统一用 12 |
| 阅读正文 | 14px / 1.75 | 14px / 22.4（1.6） | 行高 1.7–1.75 |
| 元信息 | 11px | 11px | 保持 |
| 区块标题 | 14px semibold | 14–16px，多个档 | 14 / 16 两档，不再用 20 |
| 页面标题 | 22px | 18–24px | 22px 一档 |
| 字重 | 400/500/600/700 | 400/500/560/620/700 | 保留 Codem 可变字体细档；界面 500/560，标题 620 |
| 聊天 Markdown 标题 | h1/h2/h3 全部 14px semibold | 20 / 18 / 16 / 14 | **h1 16 / h2 15 / h3 14**；聊天里不要 20 |
| 等宽 | JetBrains/Cascadia/Consolas | SF Mono/Fira/Cascadia | 保留 Codem 栈；补 `Cascadia Code` 优先级 |

**Codemarkdown 标题是当前“聊天不像文档”的主要原因之一**：20px 的 h1 在 907px 宽正文里会像网页文章标题，而 OMP 把所有标题压到 14px semibold，只靠字重和间距区分层级。建议先降级到 16/15/14，不要直接全 14（中文 14px 全同号会损失层级）。

### 3.3 圆角 / 边框 / 阴影

| 元素 | OMP | Codem | 建议 |
|---|---|---|---|
| 树行 | 4px | 6px | 6px（Codem 保持） |
| 按钮/菜单项 | 9px | 6–8px | 8px |
| 卡片/设置组 | 12px | 8–10px | 12px |
| Composer | 16px | **0px** | **14–16px** |
| 模态 | 16px | 14px | 16px |
| 用户气泡 | 16/16/6/16 | 14px | 14/14/4/14（保留 Codem 的右下角） |
| 静态面板阴影 | none | 多层 | **none**；只留边框 |
| 浮层阴影 | 大多 none（border-float） | `shadow-raise-3` | 菜单/对话框 none；toast/task dock 保留 |
| 输入卡阴影 | none | `0 2px 4px + 0 4px 12px` | **none**；用 1px 边框 + 柔光焦点 |

> 不要把 `--shadow-*` 全删。OMP 也有 81 处非 none 阴影，但只用在**暂时浮起**的东西（任务 dock、toast）。Codem 的问题是**静态的输入卡、设置弹窗、用户气泡也在投影**，导致“所有东西都在飘”。

### 3.4 布局 / 控件

| 常量 | OMP | Codem | 建议 |
|---|---|---|---|
| 顶部菜单条 | 36px | 44px（含 logo） | 保留 44；内部菜单 30px 已有 |
| 页面头 | 44px | 55px（chat header） | 聊天头降到 48px |
| 侧栏 | 272px | 231px（用户设置） | 默认 260–272；保留可拖 |
| 右栏 | 480px | 520px | 默认 420–460；可拖 |
| 文档列 | 768px | 907px（实测） | **820px**（表格/代码可全宽） |
| Composer | 768px | 1013px | **820px**，与文档列对齐 |
| 底栏 | 240px | 无 | P2 再评估 |
| 按钮 | 28 / 24 / 32 | 34 / 30 / 38 | 28 / 24 / 32（设置行内 28） |
| 输入 | 32px | 34–38px | 32px |
| 树行 | 24px | 28px | 26px（中文 13px 需要 26） |
| 会话行 | 28px | 31.5px | 30px |
| 导航行 | 30px | 40.3px | 34px（不要一步到 30） |
| 触控目标 | 24px | 部分 <24 | 24px 下限 |

---

## 4. 全要素对照（逐项）

> 优先级：**P0** = 不改 IA，1–2 天可完成；**P1** = 组件级，3–5 天；**P2** = 布局/产品级，需拍板。
> “动作”只写**一个**最关键的改动，避免执行时又变成“全都改”。

### 4.1 外壳 / 窗口

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 顶部菜单条 | 36px，左侧折叠/后退/前进 + 文件/编辑/视图/帮助；右侧只有预览开关 | 44px，logo + 文件/视图/帮助 + 执行模式 + 搜索/设置/主题/终端/窗口按钮 | OMP 更轻；Codem 信息更密但 logo 重 | P1：logo 20px、菜单 30px、菜单项 12px；不缩 44 |
| 页面头 | 44px，返回 + 固定 186px 标题槽 + 图标导航 pills + 主题 | 聊天头 54.7px；设置/任务中心是弹窗 | Codem 没有统一页面头 | P1：先给设置/任务中心加 44px 页头；聊天头降 48 |
| 窗口控制 | 原生 Electron 边框 | 自绘最小化/最大化/关闭 | 两者都可；Codem 自绘需保证拖拽区 | 保持 |
| 内容宽度 | 768px 文档列，1080px 页面 | 907px 正文，1013px composer | Codem 过宽 | **P0：820px** |
| 侧栏 | 272px，可拖 200–400 | 231px（本次设置），可拖 | Codem 偏窄，导致标题截断 | P1：默认 260，最小 220 |
| 右栏 | 480px 常驻，可拖到 640 | 520px 抽屉，默认收起 | OMP 常驻更有“工作台”感 | P2：项目会话默认展开 420；非项目保持收起 |
| 底栏 | 240px，可折 36 | 无统一底栏 | Codem 终端/日志分散 | P2：复用 PanelSidebar 做底栏 |
| 页切换 | 内容 12px 上浮 + 淡入 250ms | 弹窗/页面混用，无统一转场 | Codem 切换感弱 | P1：统一 `page-in` 12px |

### 4.2 导航 / 侧栏 / 树

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 品牌 | 22px logo + 14px semibold，44px 顶栏 | 24px logo + 18px 标题，44px | Codem 品牌更重 | P1：标题 16px，logo 20px |
| 主导航 | 12px，30px 行，图标 16px，间距 6px | 14px，40px 行，图标 20px，间距 12px | Codem 大 1/3 | P1：14→13、行高 40→34、图标 20→18 |
| 工具入口 | 一行 4 个 icon+label，紧凑 | 4 个 48px 方块，51px 高 | Codem 更占空间 | P1：改成 40px 方块或单行 pill |
| 项目行 | 28px，hover 文件夹→chevron，右侧 +/… 浮层 | 37px，文件夹 + 名称 + +/… 常显 | Codem 行高、按钮常显 | P1：32px；按钮 hover/focus 才显 |
| 会话行 | 28px；active 12% 底，标题 accent；hover 时间戳→操作 | 31.5px；active 20% 底 + 全文字紫；操作常显 | Codem 选中过重、字号大 | P0：active 底 12%，正文保持主文字色，仅标题 accent |
| 分组头 | 11px uppercase，letter-spacing .04em，semibold | 11px uppercase，但层级弱 | 接近 | P1：统一 11/600/.04em |
| 文件树行 | 24px，12px，缩进 6px，radix 4px | 28px，13px，缩进 3px，6px | Codem 行高、字号大 | P1：26px / 12px / 6px |
| 文件/文件夹图标 | 14px；文件夹 accent，文件中性 | 16px；目录 accent，文件中性 | 接近 | P1：14px |
| Git 状态 | 行尾字母 M/A/D/R/U/! + 文件名着色；无 pill 底 | 彩色 pill 徽章（M/A/D/U 背景） | Codem 更吵 | **P1：字母+着色，去掉 pill 底** |
| 悬停操作 | 绝对定位浮层，opacity/visibility 交叉淡入；文件名 mask 渐隐 | 操作常显或 display 切换 | Codem 缺“让位”手感 | P1：统一 hover 浮层 + mask |
| 树键盘 | 行是 button，`aria-selected`，focus-visible inset 1px | 有 `file-entry` focus，但 ring 2px 外扩 | OMP 更稳 | P1：inset 环，避免被滚动裁 |
| 排序/更多 | 图标按钮 28px，菜单 240px | 40px 按钮 + 菜单 | Codem 偏大 | P1：28px |

### 4.2b 控件（按钮 / 输入 / 开关 / 标签）

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 主按钮 | `.btn.primary` 28px / 9px；accent 实底；`--text-on-accent`（暗色是深色） | `.save-btn` 无固定高、6px、白字；`.send-btn` 32px/8px；设置按钮 34px | **没有统一按钮组件** | P1：建 `.btn` 基类，28/8，primary/secondary/outline/danger/ghost 五变体 |
| 次按钮 | `.btn.outline` 28/9，1px `border-strong`，透明底 | 部分 2px 边框（`.project-action-btn`），部分玻璃底 | Codem 边框偏重 | P1：统一 1px，hover 只换 surface |
| 图标按钮 | 28×28，9px；small 22；lg 32；hover 软底 | 30–34，圆角 6–8；部分无 hover 底 | Codem 偏大 | P1：28、radius 8、hover `surface-hover` |
| 危险按钮 | `.btn.danger` 红色实底/软底；确认弹窗用明确动词 | 有红色，但常与普通按钮同权重 | Codem 危险感弱 | P1：danger 用红底/红字，不与 primary 并排同高亮 |
| 禁用 | `opacity:.45; pointer-events:none` | 部分 opacity，部分仍可点 | Codem 不一致 | P1：统一 `aria-disabled` + pointer-events |
| 按下 | `transform: translateY(1px)`；图标 `scale(.92)` | 多数无 press 反馈 | Codem 缺物理感 | P1：全局 1px press，reduced-motion 下关闭 |
| 输入/选择 | 32px / 9px / 1px；focus 3px 柔光 | 34–38px / 8px；focus 2px 实环 | Codem 偏大、焦点硬 | P1：32/8；输入用柔光，按钮用 outline |
| 开关 | 34×20；accent on；无阴影 | 有 switch，尺寸略不同 | 接近 | P1：统一 34×20 |
| 标签/徽章 | 20px  pill，10.5–11px；soft 底 | 20–24px，多种底/边 | Codem 不统一 | P1：统一 20px / 11px / soft |
| Kbd | 11px mono，1px 边，3/6 padding | 有 shortcut 文本，无统一 kbd | Codem 弱 | P1：统一 kbd |

### 4.2c 页签 / 分段器 / 页面导航

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 页面导航 | 30px 高，12px，5px gap，9px 圆角；active 14% 软底 + accent；**滑动气泡 + 镜像克隆** 230ms；标题槽固定 186px 防跳动 | 无页面级导航；入口在侧栏/弹窗 | Codem 缺“同一层页面”的稳定导航 | P2：只给设置/任务中心/知识/用量加，不动聊天 |
| 面板页签 | 30px 高，12px；active 下划线/软底；hover surface | 面板页签 36–40px；active 实底/下划线混用 | Codem 偏大 | P1：32px，active 软底，不用实心 |
| 分段器 | 22px 内高，6px 圆角，选中 surface + 1px 边 | 30px，圆角 8，选中 accent | Codem 偏大 | P1：26px，选中 surface + 边 |
| 设置左侧导航 | 30px，12px，软底 | 34px，13px，20% 软底 | 接近 | P0：34→30，20%→14% |

### 4.3 对话 / 消息

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 用户气泡 | 暗色**实底 accent** + 深色字；亮色 `#eee9ff` + 主文字；圆角 16/16/6/16；无阴影；max 78% | accent 15% 底 + 1px 边 + 阴影；圆角 14px；max 75%；有头像 | Codem 更“软”，但不够聚焦 | P1：先去掉阴影；实底需成对改 `--text-on-accent` |
| 助手正文 | 14px / 1.75；无气泡；768 列 | 14px / 22.4；无气泡；907 列 | Codem 过宽、行高略紧 | **P0：820 列 + 1.7 行高** |
| 消息头 | 11px 元信息；角色 badge 18px；名字 12px | 13px，opacity .8；约 24px 头像 | Codem 头重 | P1：元信息 11、名字 12、头像 20 |
| Markdown 标题 | h1/h2/h3 全 14 semibold | 20/18/16/14 | Codem 标题过大 | **P0：16/15/14** |
| 段落间距 | 6px（`--sp-6`） | 12px（`--space-3`） | Codem 段落更散 | P1：8px |
| 代码块 | 12px，1px 边框，圆角 9，复制按钮 26 | 12.8/13，圆角 8，头部栏 | 接近 | P1：统一 12px / 8px |
| 表格 | 12px，无外框，行线 7% | 13px，有外框/斑马纹 | Codem 更重 | P1：12px、去斑马、只留行线 |
| 链接/文件 chip | accent 软底 20px pill，12px | 多种 chip 尺寸/底色 | Codem 不统一 | P1：统一 `chip` 20px |
| 工具展示 | **行 + 展开面板**，不是每张卡都带框；左侧状态轨 | 每张 `.tool-card` 都有 1px 边框 + 头部底色 | Codem 框太多 | P1：去外框，保留左侧 2px 状态轨；头部透明 |
| 工具状态 | 11px 文字 + 颜色 + 图标 | 11px + 颜色 | 接近 | 保持，补 `aria-live` |
| 工具折叠 | 0fr→1fr 高度动画 250ms；chevron 旋转 | 高度/透明度过渡 | OMP 更顺 | P1：统一 250ms ease-out |
| Diff | 行号 + 行内容，新增/删除底色；无外框 | 有外框、行号列、双视图 | Codem 功能更强 | 保留功能，去外框/降对比 |
| 回合状态 | 居中“第 5/7 步”胶囊 + working 行 | 右下“任务完成”胶囊 + 大段空白 | Codem 状态游离 | P1：状态条贴正文底部，不 floating |
| 系统消息 | 紧凑行（图标 + 12px 文本） | 90% 宽 system 气泡，像大警告 | Codem 过重 | **P0：改紧凑行，去掉大底** |
| 复制/操作 | hover 才显，11px | hover 才显，13px | Codem 偏大 | P1：11px / 26px 按钮 |

### 4.4 Composer

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 容器 | 768px，16px 圆角，1px 边，surface 底，无阴影；运行中蓝边 | 1013px，0 圆角，透明底，重阴影；顶部 1px 内线 | **最大单项差距** | **P0：820px / 14px / surface / 无 shadow / 去内线** |
| 上下文 chips | 22px，accent 软底，mono 11px，可删 | 多种 badge，尺寸/底色不一 | 不统一 | P1：22px 统一 |
| 输入区 | 14px / 1.6，min 44，max 200 | 16px / 24，min 56 | Codem 过大 | P0：15px / min 48；中文 16 也可，但需配 820 宽 |
| 底部栏 | 42px，pill 按钮 24–28px | 46px，按钮 30–34px | Codem 偏大 | P1：40px / 28px |
| 模型 pill | 角色名 + 模型 + effort + 下拉 | 模型名 + 下拉；免费模型多时列表长 | Codem 信息少、列表乱 | **P1：角色菜单（见 4.5）** |
| 审批 pill | 盾牌 + 三档，选中项有描述 | 盾牌 + 三档，选中紫色 | Codem 缺少描述/危险提示 | P1：加描述、Full Access 用 amber |
| 模式/强度 | `标准` 下拉 + `Off` | 模式按钮 + 推理强度 | 接近 | P1：统一 pill 高 24 |
| 发送按钮 | 32px 方形，右圆角 | 32px 分裂按钮（发送/取消） | Codem 功能更强 | 保留分裂，视觉改 8px |
| 队列 / 草稿 | Composer 上方 floating task dock + queue cards | 队列卡在消息流里 | Codem 更分散 | P1：队列贴 Composer 上方 |
| 拖拽/粘贴 | 全卡 droppable，缩略图 64 | 支持，但提示在 placeholder | 接近 | 保持 |
| 焦点 | `:focus-within` 3px 柔光 + 18px 弥散 | `:has(textarea:focus-visible)` 2px 实环 | Codem 更硬、曾有双环 | **P0：改 3px 柔光，单环** |

### 4.5 菜单 / 命令面板 / 弹窗

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 应用菜单 | 240px，12px，item 28px，分组分隔 | 菜单宽度不定，item 30–34 | Codem 偏大 | P1：min 240，item 28 |
| 上下文菜单 | 边框 + 无阴影，右侧快捷键 | 有玻璃/阴影，尺寸不一 | Codem 更“浮” | P1：去阴影，统一 240 |
| 模型菜单 | **按角色分组**：Default/Fast/Thinking/Vision/Architect/Commit/Subtask/Advisor/Review；每项 icon + @tag + 模型 + effort；选中 check | 免费模型平铺列表，10+ 行 `【未知】`；无分组/选中/描述 | **差距最大** | **P1：角色分组 + 选中 check + 隐藏未知** |
| 审批菜单 | 3 项，标题 + 描述，Full Access 橙色危险 | 3 项，标题 + 选中紫 | Codem 描述弱 | P1：加描述/危险色 |
| 命令面板 | 670px，分组：最近会话/推荐操作/页面导航/面板/配置/项目；快捷键右对齐；backdrop +  glow | 680px，只有项目 + 少量操作；无分组/导航 | Codem 像搜索框 | **P1：改命令中心** |
| 弹窗 | 480px，16px 圆角，1px 浮层边，无阴影；头/体/脚 | 设置 760px，14px，阴影；其他 560px | Codem 弹窗更重 | P1：去阴影、16px；设置单独议 |
| Tooltip | 11px，深底，3/8 padding，500ms delay | 有 tooltip，但尺寸/延迟不一 | 接近 | P1：统一 |
| Toast | 底部居中，320px 进入，1px 边 | 有 toast，但位置/阴影不一 | 接近 | P2：统一 |
| Select | 32px，9px，1px 边 | 34/38px，8px | Codem 偏大 | P1：32px |
| 危险确认 | 红色实底按钮 + 明确动词 | 有确认，但按钮层级弱 | Codem 可加强 | P1 |

### 4.6 设置 / 表单 / 卡片

| 元素 | OMP | Codem 当前 | 差距 | 动作 |
|---|---|---|---|---|
| 设置壳 | **整页**，1080 内容，左 200 导航 + 右内容 | 760px 弹窗，左侧 23 项 | Codem 窄、像工具窗 | P2：整页（或 900px 弹窗过渡） |
| 导航选中 | accent 软底 14% + accent 文字，30px | 20% accent 软底 + accent 文字，34px（`codem-ui.css` 已覆盖；`styles.css` 旧实心规则仍在，靠后加载压住） | Codem 略重、偏高 | **P0：20%→14%、34→30、删旧规则** |
| 分组 | 每组一张 12px 卡片，行间 1px 分隔，无行底 | 行直接铺在白底上，组间无卡 | Codem 散 | P1：组卡 + 分隔 |
| 行 | padding 10/14，label 12，desc 11，control 200px | 行高 40–48，label 13–14，control 不定 | Codem 偏大、控制宽度不齐 | P1：12/11，control 200 |
| 开关 | 34×20，accent on，无阴影 | 有 switch，尺寸/颜色略不同 | 接近 | P1：统一 34×20 |
| 输入/选择 | 32px，9px | 34/38px，8px | Codem 偏大 | P1：32px |
| 卡片 | 12px 圆角，1px 边，无阴影 | 8–10px，部分阴影 | Codem 更碎 | P1：12px + 无阴影 |
| 恢复默认 | 右上小按钮 28px | 有“恢复默认值”但位置/尺寸不一 | 接近 | P1：右上 28px |
| 保存 | 底部固定栏，主按钮 28px | 底部 3 按钮（会话恢复/用量/保存），38px | Codem 按钮大、语义混 | P1：保存主按钮 30；其它次按钮 |
| 来源徽标 | 11px pill，default/user/project/runtime 四色 | Codem 有“用户/默认值”标签，但样式不一 | 接近 | P1：统一 11px pill |
| 未保存态 | 顶部提示 + 保存禁用/高亮 | 有 dirty 逻辑，但视觉弱 | Codem 可加强 | P1：脏标记 + 保存按钮高亮 |

### 4.7 页面（Home / History / Agent Hub / Capabilities / Models / Diagnostics）

| 页面 | OMP | Codem | 可借鉴 | 不照搬 |
|---|---|---|---|---|
| Home | 问候 + 3 张项目卡 + Token 折线/热力图 | 无首页；用量统计在设置 | 项目卡、用量可视化 | Token 图表依赖 OMP 数据模型 |
| History | 左会话列表 + 右 Time Travel 时间线/Checkpoint | 会话列表在侧栏；无时间线页 | 时间线/恢复点 | Checkpoint 语义不同 |
| Agent Hub | 主会话卡 + 子代理列表 + 右侧详情 + 统计 | AgentPanel/子代理列表 | 列表/详情分栏、状态/成本/上下文 | 不能直接套 OMP 的 Agent 概念 |
| Capabilities | 左 Skills/Plugins/MCP/Slash，右卡片 + 状态 chips + toggle | 设置里的插件/技能/MCP 分散 | 统一能力中心页 | 入口/权限模型不同 |
| Models | 供应商卡 + 开关 + 模型数；角色页 | 设置里的模型/Provider | 供应商卡、角色分组 | Codem 的 Provider 结构不同 |
| Diagnostics | 状态卡 + 检查行 + 维护按钮 | 设置里的性能/诊断 | 检查行/状态卡 | 诊断项不同 |

> 这些页面是 **P2**，先把聊天/设置/命令面板做好；不要一开始就重做整站 IA。

### 4.8 可访问性 / 动效 / 状态

| 项 | OMP | Codem | 动作 |
|---|---|---|---|
| 焦点环 | 2px accent + 2px offset；输入 3px 柔光；树 inset 1px | 2px 实环 + 多个 `:has` 特例；曾有双环/常亮 | **P0：单环 + 输入柔光** |
| Skip link | 有 `.skip-link` | 未发现 | P1：加 skip link |
| 目标尺寸 | `--tap-min:24px`，小图标用伪元素扩热区 | 部分 18–22px | P1：24px 下限 |
| 对比度 | 文档写明 4.5:1（dark text-3 5.37 / faint 4.55） | 无对照表；muted 用 mix | P1：补 token 对比表 |
| 减弱动效 | 全局 0.01ms + 显式停 pulse/skeleton | 有显式清单 | 保持，补新组件 |
| 键盘 | 页签 roving、菜单方向键、树方向键 | 部分有；设置侧栏 roving | P1：统一 |
| ARIA | 页签 `aria-current`、开关 `aria-checked`、树 `aria-selected` | 部分有；26 对话框补过 | P1：组件契约 |
| 滚动条 | 8px，thin，主题色 | 8px，主题色 | 接近 |
| 空态 | 居中 icon 28 + 12px 文案 | 多种 empty-hint | P1：统一 |
| 骨架 | `skeleton` 动画 + reduced motion 静态 | 有 loading | 保持 |
| 错误 | 行内错误 + 重试；不假装成功 | StatusBanner/错误卡 | 保持 |

---

## 5. 屏幕级对照

### 5.1 工作台

| OMP | Codem |
|---|---|
| ![OMP workbench](../evidence/ui-benchmark-omp-2026-10-26/omp-workbench-dark.jpg) | ![Codem workbench](../evidence/ui-benchmark-omp-2026-10-26/codem-main-dark.jpg) |

**读图结论**：

1. OMP 的三栏（272 / 768 / 480）把“对话、改动、日志”放在同一视平线；Codem 是一栏对话 + 折叠右栏，信息密度低但视觉更空。
2. OMP 的 Composer 是**一张圆角卡**，与文档列同宽；Codem 的 Composer 是一条**通栏透明工具条**，顶部有 1px 内线，视觉上不像“输入卡”。
3. OMP 的正文列 768，Codem 907；同样 14px 中文，Codem 行更长、更难读。
4. OMP 的页头是面包屑 + 遥测，Codem 是标题 + 一排图标；Codem 的图标按钮更大、更散。
5. OMP 右栏 Changes 的文件行有 +/− 数字和目录副标题；Codem 的右栏默认收起，用户看不到“这一轮改了什么”。

### 5.2 设置

| OMP | Codem |
|---|---|
| ![OMP settings](../evidence/ui-benchmark-omp-2026-10-26/omp-settings-dark.jpg) | ![Codem settings](../evidence/ui-benchmark-omp-2026-10-26/codem-settings-dark.jpg) |

**读图结论**：

- OMP 是**整页**：1080 内容，左 200 导航，右内容；行是**分组卡片**，label/desc 在左，control 固定 200 在右。
- Codem 是**760px 弹窗**：左 23 项，选中项是 **20% 紫底 + 紫字**（`codem-ui.css` 覆盖；`styles.css` 里还留着一条被压住的实心规则），行直接铺在面板上；内容窄，频繁滚动。
- OMP 的“用户/默认值”来源徽标是 11px 小 pill；Codem 的“用户/默认值”标签更随意。
- OMP 的保存是底部固定栏；Codem 的底部有“会话恢复 / 用量统计 / 保存设置”三个同权重按钮，主次不清。

### 5.3 命令面板

| OMP | Codem |
|---|---|
| ![OMP command palette](../evidence/ui-benchmark-omp-2026-10-26/omp-cmdk.jpg) | ![Codem command palette](../evidence/ui-benchmark-omp-2026-10-26/codem-cmdk.jpg) |

**读图结论**：

- OMP 是**命令中心**：最近会话 / 推荐操作 / 页面导航 / 面板与视图 / 配置与设置 / 项目，每项有图标、副标题、快捷键；搜索框在顶部，Esc 提示在右。
- Codem 是**搜索弹窗**：只有“项目 + 操作”两组，项目列表占满，缺少页面导航、面板、配置命令。
- OMP 的背景有 backdrop + 轻 glow；Codem 的背景几乎无遮罩，像普通下拉。

### 5.4 模型菜单

| OMP | Codem |
|---|---|
| ![OMP model menu](../evidence/ui-benchmark-omp-2026-10-26/omp-model-menu.jpg) | ![Codem model menu](../evidence/ui-benchmark-omp-2026-10-26/codem-model-menu.jpg) |

**读图结论**：

- OMP 的菜单是**任务角色**（Default/Fast/Thinking/Vision/Architect/Commit/Subtask/Advisor/Review），每项有 icon、`@tag`、模型 + effort、选中 check。
- Codem 是**免费模型平铺**：10 行模型名 + 10 个 `【未知】`，无分组、无选中、无描述；用户不知道“这个模型适合干什么”。
- 这不是“美化”，是**信息架构**问题。P1 必须先做角色/分组，而不是只调颜色。

### 5.5 亮色 / 皮肤

| Codem 亮色 | Codem Hub | Codem 梦幻 |
|---|---|---|
| ![Codem light](../evidence/ui-benchmark-omp-2026-10-26/codem-light.jpg) | ![Codem hub](../evidence/ui-benchmark-omp-2026-10-26/codem-hub.jpg) | ![Codem dream](../evidence/ui-benchmark-omp-2026-10-26/codem-dream.jpg) |

**读图结论**：

- Codem 的三皮肤差异很大，这是资产，不要为了“统一”把它们抹平。
- Hub 的橙色（`#ff6b00`）和 Dream 的粉色是强身份；但 Hub/Dream 的**组件形状**仍沿用默认皮肤，导致“换色不换骨”。
- OMP 只有 light/dark，但每个组件在两档下都成立；Codem 的 Dream 缺 6 个语义 token（`--success/--warning/--error/--info/--dropdown-bg/--text-on-accent`），状态色和浮层底会落回默认档。
- **P3**：三皮肤共享同一套**形状/间距/层级**，只换颜色/背景/字体气质；不要把 Hub/Dream 做成另一套组件。

---

## 6. 优化方案（按阶段执行）

### 6.1 P0：视觉地基（1–2 天，不改 IA）

目标：只改“看起来贵不贵”的底层，不动功能结构；每一步可单独回滚。

#### P0-1 Composer 卡片化

**文件**：`src/styles.css`（`.input-area` / `.input-card-container` / `.input-textarea-row` / `.input-action-row`）。

**改成**：

```css
.input-area > .input-card-container {
  max-width: 820px;
}

.input-card-container {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 14px;
  box-shadow: none;
  overflow: hidden;
}

.input-textarea-row {
  border-top: none;          /* 去掉那条“通栏内线” */
  padding: 10px 16px 2px;
}

.input-card-container:has(.message-input:focus-visible) {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border-primary));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}
```

- 运行中：`border-color: var(--info)`（或 `--accent`），不要整卡发光。
- 发送按钮保持分裂；只把左半圆角改 8px。
- 去掉 `--shadow-raise-2`，不要用阴影表达“卡片”。

**验收**：

- computed：`border-radius: 14px`、`background-color != transparent`、`box-shadow: none`、`max-width: 820px`。
- 截图：空态 / 运行中 / 焦点三态；320/768/1024 宽不溢出。
- 键盘：Tab 进输入框只出现一圈柔光；点工具条按钮不亮整卡。

#### P0-2 文档列收窄 + 系统消息降级

**文件**：`src/styles.css`（`.messages-container`、`.assistant .message-content`、`.system .message-content`、`.message-content h1/h2/h3`）。

- `.messages-container { max-width: 820px; padding-inline: 24px; }`（`box-sizing: border-box`，820 是外框；正文内容约 772）
- `.assistant .message-content { padding-bottom: 16px; }`
- `.message.system { max-width: 100%; }`
- `.system .message-content`：`max-width: 100%; background: transparent; border: none; border-left: 2px solid var(--border-primary); border-radius: 0; padding: 4px 0 4px 10px; font-size: 12px; color: var(--text-secondary);`
- Markdown 标题：`h1 16 / h2 15 / h3 14`，字重 600，间距 12/6。
- 表格允许横向滚动，不强行 820。

**验收**：

- 1600 宽下正文列**外框** = 820 ± 2px；composer 与正文左缘对齐。
- 系统消息不再出现 90% 宽大色块；截图对照。
- 20 条长消息滚动无横向溢出；表格可横滚。

#### P0-3 暗色 token 提亮 / 边框减淡

**文件**：`src/styles.css` 的 dark 档 token（`:root[data-theme="dark"]` 或等价块）。

只改默认皮肤，不动 Hub/Dream：

- `--bg-primary: #101318`
- `--bg-secondary: #17191d`
- `--bg-tertiary: #1d2025`
- `--text-primary: #e6e7ea`
- `--text-secondary: #a7abb4`
- `--text-muted: #8b909a`
- `--border-primary: rgba(255,255,255,.09)`
- **不要在这一步改 `--accent`**：Codem 的 `--text-on-accent` 是白色，提亮 accent 会让主按钮白字掉对比度。accent 与 on-accent 必须成对改，放 P1 并做全量按钮审计。
- **不要全局改 `--accent-muted`**：它同时用于 hover/徽章/软底；P0 只在设置选中态用 14%（见 P0-5）。

**验收**：

- 对比度：主文字 ≥12:1、次文字 ≥7:1、弱文字 ≥4.5:1（用脚本算，不靠眼）。
- 截图：主界面/设置/命令面板三张，确认不再“黑框套黑框”。
- Hub/Dream 不受影响（它们有自己的 token 覆盖）。

#### P0-4 焦点单环

**文件**：`src/styles.css` 全局 focus 段 + `.input-textarea-row` / `.message-input`。

- 删除 textarea 的 `box-shadow` 环；只保留 `.input-card-container:has(...)` 的 3px 柔光。
- 按钮/树/菜单统一 `outline: 2px solid var(--accent); outline-offset: 2px;`。
- 树/滚动容器用 `box-shadow: inset 0 0 0 2px`，避免被裁。
- 禁止一个控件同时出现 outline + box-shadow 两圈。

**验收**：

- 真机探针：Tab 遍历 20 个控件，截图无“双环”。
- `rg -n "outline:\\s*none" src/styles.css` 每一处都要有替代环。

#### P0-5 设置选中态收敛 + 行组卡片

**文件**：`src/styles/codem-ui.css`（`.settings-sidebar-item.active`）、`src/styles.css`（旧 `.settings-sidebar-item.active` 规则）、`src/styles.css`（`.settings-content` 行样式）。

- active：`background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent);`；高度 34→30。
- **删掉 `styles.css` 里被后加载压住的实心 `.settings-sidebar-item.active` 规则**；不要依赖加载顺序，否则一次 import 调整就会复活。
- 设置内容行：每组用 12px 卡片，行间 1px 分隔；label 13/500，desc 11/ muted，control 固定 200。
- 设置弹窗先保留 760，P2 再议整页；P0 只改选中态和行组。

**验收**：

- active 对比度 ≥4.5:1；截图中不再显得“整块厚重”。
- 设置内容不出现双边框/双底；行组首尾圆角正确。

#### P0-6 聊天标题降级

**文件**：`src/styles.css` `.message-content h1/h2/h3`。

- 20/18/16/14 → 16/15/14/13。
- 字重 600；顶部间距 12，底部 6。

**验收**：

- 一条含 h1/h2/h3 的消息截图；标题不再抢正文。
- 与 OMP 的“文档式标题”对照，但不强求全 14。

### 6.2 P1：关键组件（3–5 天）

#### P1-1 命令面板改成“命令中心”

**文件**：`src/components/SearchDialog.tsx`（或现有命令面板组件）、`src/core/...` 的命令目录。

结构：

```text
搜索框（自动聚焦，Esc 提示）
最近会话（最多 6）
推荐操作（新建对话/打开文件夹/会话历史）
页面导航（工作台/首页/任务中心/知识/设置/…）
面板与视图（侧栏/底栏/右栏/终端/日志）
配置与设置（通用/外观/安全/…）
项目（最近项目）
```

- 宽 640–680；`border-radius: 16px`；backdrop 40% + blur 4px；无阴影，1px `--border-float`。
- 分组标题 11px uppercase；item 32px；右侧 `Ctrl+...` 11px mono。
- 选中项 accent 软底，不实心。
- 键盘：↑/↓/Enter/Esc；Home/End；输入过滤；空结果。

**验收**：

- 打开后 300ms 内可键盘选择；分组完整；无项目时仍显示“页面/面板/设置”命令。
- 截图与 OMP 对照；记录“最近会话/导航/面板/配置”四组。

#### P1-2 模型菜单按角色分组

**文件**：`src/components/ModelSelector` / `InputArea` 的模型菜单、`src/core/llm/model-index.ts`。

- 顶部“任务角色”分组：`Default / Fast / Thinking / Vision / Architect / Commit / Subtask / Advisor / Review`（按 Codem 实际角色裁剪）。
- 每项：icon + 角色名 + `@tag` + 模型名 + reasoning effort + 选中 check。
- 免费模型单独“更多模型”分组；`【未知】` 只在展开后显示，不铺满首屏。
- 选中项用 check（不是整行紫底）；hover 用 surface-hover。
- 菜单 320–360 宽，max-height 420，内部滚动。

**验收**：

- 首屏不超过 9 行；每行有“角色/模型/强度”三要素；当前模型有 check。
- 免费模型不再出现 10 个连续 `【未知】`。
- 键盘可达，Esc 关闭。

#### P1-3 侧栏 / 文件树密度

**文件**：`src/styles.css` `.sidebar-nav-item`、`.sidebar-session`、`.file-entry`、`.sidebar-tool-item`。

- 侧栏默认 260（不是 231）；最小 220。
- 导航行 34px，字号 13，图标 18，gap 10。
- 会话行 30px；active 底 12%，正文主色，只有标题 accent；hover 时间戳淡出、操作淡入。
- 树行 26px，字号 12，缩进 6；目录 icon accent，文件中性；选中 accent 12%。
- Git 状态改“字母 + 文件名着色”，去掉彩色 pill 底；字母 11px mono。
- 操作按钮 22px，绝对定位右侧，hover/focus 才显；文件名 mask 渐隐让位。

**验收**：

- 40 个项目/会话滚动不卡；窄侧栏 220 不截断标题到不可读。
- 树行 hover 截图：文件名渐隐、操作出现、状态字母让位。
- 键盘：方向键展开/收起，Enter 打开，focus-visible 不被裁。

#### P1-4 工具行化（去“每张卡”）

**文件**：`src/styles/codem-ui.css` `.tool-card`、`.tool-card-head`、`src/components/ToolCallCard.tsx`。

两个可选方案，选一个：

- **A（保守）**：保留卡片，但去外框/头部底色，只留 `border-left: 2px` 状态轨；头部透明，展开内容用 surface-2；卡片之间 8px 间距。
- **B（更接近 OMP）**：工具变成一行（icon + 名称 + 摘要 + 状态 + diff 统计 + chevron），展开面板在行下方，不再有独立卡片外框。

建议先 A，风险低；B 需要改组件结构。

**验收**：

- 连续 5 个工具调用截图：不再出现 5 个并排边框；状态轨颜色正确；展开/收起 250ms。
- 错误/运行中状态仍一眼可见（左侧轨 + 状态文字）。
- Diff/终端仍可读，不因去框丢对比。

#### P1-5 用户气泡 / 消息头

- 暗色**不要直接** `background: var(--accent); color: var(--text-on-accent);`：Codem 的 `--text-on-accent` 是白色，实底会掉对比度。
- 方案 A（低风险）：保持 15% 淡紫底 + 主文字色，**只去掉 `--shadow-bubble`**，边框降到 20%。
- 方案 B（更接近 OMP，需成对改）：暗色 `--text-on-accent: #121316` + accent 提亮；必须全量审计主按钮/保存按钮/发送按钮的对比度，不能只改气泡。
- 亮色：保持 `#eee9ff` 淡紫（OMP 同款思路），主文字色。
- 消息头：11px 元信息，名字 12，头像 20；不要 13px + 24px 头像。

**验收**：

- 暗色气泡白字对比度 ≥4.5:1；亮色气泡主文字 ≥7:1。
- 气泡宽度 78%，不与正文列冲突。

#### P1-6 设置行组 + 菜单/弹层

- 设置行按 `group card + divider` 重排；label 13/desc 11/control 200。
- 菜单统一 240 宽、item 28、radius 9、border-float、无 shadow；选中 accent 软底。
- 模态 16px、border-float、无 shadow；footer 右对齐，主按钮 28。
- Tooltip 11px / 500ms / 深底。

**验收**：

- 设置页 1080 宽（或 900 弹窗）下行不折行；控件右缘对齐。
- 菜单在 320 宽窗口不溢出；Esc/外点关闭。
- 模态在 760 高窗口内 footer 可见（不滚动到底才能保存）。

#### P1-7 空态 / 加载 / 错误统一

- 新建 `EmptyState` 组件：icon 28、标题 14/600、描述 12/muted、动作 28 按钮；居中，最大宽 360。
- 替换 `empty-hint` 的 19 种 padding / 7 种字号（历史债）。
- 错误：行内 `StatusBanner` + 重试；不要用大 system 气泡。

**验收**：

- 空会话/空项目/空技能/空 MCP 四张截图一致；无“不同页面不同空态”。
- 错误横幅不遮 Composer；可关闭/重试。

### 6.3 P2：布局与页面（5–8 天，需产品拍板）

1. **设置整页化**：新增 `SettingsPage` 路由/视图，复用现有 23 分区；页头 44 + 左 200 导航 + 内容 1080；保留弹窗作为快速入口或删除。风险：状态/快捷键/测试；先做 A/B 截图。
2. **右侧 Inspector 常驻**：项目会话默认展开 420px，复用 `PanelSidebar` 的 Files/Git/Changes；非项目保持收起；Composer/正文列仍 820。
3. **底部面板**：可选 Terminal/Problems/Logs，240px，可折 36；与右侧 Inspector 不重复。
4. **页面级导航**：仅对设置/任务中心/知识/用量等“全屏页”加 44px 页头 + 图标 nav；不要动聊天主区。
5. **Home/Agent Hub/Capabilities/Models**：按 OMP 的“列表 + 详情/卡片”重构；这是产品功能，不是纯 UI，需单独立项。

### 6.4 P3：皮肤与持续治理

- **Dream 补 token**：`--success/--warning/--error/--info/--dropdown-bg/--text-on-accent`；否则状态色落回默认档。
- **Hub 形状统一**：橙色只换颜色，不换圆角/间距；Hub 的 active 底色也按“14% 软底”收敛，先截图评估。
- **对比度表**：为三皮肤 × 明暗 × 文字档生成对照表；低于 4.5:1 的 token 修正。
- **动效**：统一 120/180/250；禁止 `transition: all`；`prefers-reduced-motion` 覆盖新组件。
- **密度**：`data-density` 同时缩间距和控件高（OMP 的 `--density-scale` 只缩间距，Codem 只缩控件；两者都不完整）。建议 `compact` 时 `--space-* ×0.9` + 控件 -4px，且字号不变。

---

## 7. 执行与验收（防止“规划很好，执行走样”）

> 这一节是给执行者的**合同**。每阶段开工前先读本节 + 对应 P 段 + `05-UI-UX.md` 的 token 表；不要凭记忆改。

### 7.1 先做“测量工具”，再改 UI（Phase 0）

在改任何视觉之前，先加一个**可重复的对照/验收脚手架**：

1. **固定状态**：`workbench-dark`、`workbench-light`、`settings-dark`、`settings-light`、`cmd-k`、`model-menu`、`empty`、`running`、`error`。
2. **固定视口/DPR**：1600×1000 @1x（WebView2 用 CDP `Emulation.setDeviceMetricsOverride` 强制 1x，避免 DPR 2 原图）。
3. **固定数据**：用隔离数据副本 + 固定会话；不要用用户当前会话（会变）。
4. **固定操作序列**：启动 → 等待 `#root`/首屏 → 关闭引导 → 打开目标 → 截图。
5. **产出**：
   - `before/` 与 `after/` 同名 PNG；
   - `computed.json`（关键选择器的 computed style）；
   - `contact-sheet.jpg`（before/after/OMP 三列）。
6. **不引入重依赖**：用 Edge CDP + Node 24 的 WebSocket；截图用 `Page.captureScreenshot`，不要为截图引入 Playwright 到产品依赖。

**Phase 0 的验收**：同一状态连拍 3 次，像素差 <0.1%；computed.json 稳定；这才说明工具可信。

### 7.2 机器契约（比“看着像”可靠）

新增 `tools/ui-audit/ui-benchmark-contract.json`（示意）：

```json
{
  "version": 1,
  "viewports": [{ "width": 1600, "height": 1000, "dpr": 1 }],
  "states": ["workbench-dark", "workbench-light", "settings-dark", "cmd-k"],
  "selectors": {
    ".input-card-container": {
      "maxWidth": "820px",
      "borderRadius": "14px",
      "backgroundColor": "var(--bg-secondary)",
      "boxShadow": "none"
    },
    ".settings-sidebar-item.active": {
      "backgroundColor": "var(--accent-muted)",
      "color": "var(--accent)"
    },
    ".message.assistant .message-content": {
      "maxWidth": "820px",
      "fontSize": "14px"
    },
    ".message-content h1": { "fontSize": "16px" }
  }
}
```

脚本 `tools/ui-audit/ui-benchmark-check.mjs`：

- `--write`：启动 Codem、按状态截图、写 `computed.json` 与 `baseline/`；
- `--check`：逐选择器比对 computed；差异打印 `expected / actual / selector`；
- `--diff`：对稳定区域做像素差（动态文本区域 mask）；阈值：单组件 ≤0.8%，整屏 ≤1.5%；
- 失败时输出“哪一项、哪个状态、哪张图”，不要只输出“UI 不一致”。

> 这套脚本不需要进入产品依赖；`playwright-core` 只在 `tools/` 的 devDependency 或临时目录使用。若不想加依赖，CDP 原生 WebSocket 足够。

### 7.3 每阶段的“交付包”

每个 P 阶段必须交：

1. **代码**：只改该阶段列出的文件；不顺手重构无关组件。
2. **token/契约**：更新 `ui-benchmark-contract.json` 与 `docs/ui-spec.md`（如涉及新 token）。
3. **截图**：`before/` + `after/` + `contact-sheet`；放 `docs/evidence/ui-benchmark-<phase>-<date>/`，附 README（来源/操作/读数）。
4. **机器结果**：`npm run audit:docs`、`npx tsc --noEmit`、相关判据；CSS 改动跑 `css-contract.mjs --check`。
5. **人工签字**：12 项检查表（见 7.4）逐项打勾；不签不合并。
6. **回滚点**：一个阶段一个 commit；出问题 `git revert` 该 commit，不要手删半套 CSS。

### 7.4 人工验收 12 项（每阶段都看）

- [ ] 边框只有一种浓度（主/次/分隔），没有“边框 + 阴影 + 内线”三层。
- [ ] 同一屏只有一种焦点环；输入框、按钮、树、菜单各自只有一圈。
- [ ] 圆角不是“随机档”：树 6 / 控件 8 / 卡片 12 / Composer 14 / 模态 16。
- [ ] 字号层级 ≤4 档（元信息 11 / 界面 12–13 / 正文 14 / 标题 16–22）。
- [ ] 同一类按钮高度一致；同一行控件底边对齐。
- [ ] 文本在 320/768/1024/1600 四档不溢出、不裁切、不出现横向滚动（表格除外）。
- [ ] 暗色下没有“纯黑 + 14% 白框”的硬边；亮色下没有“纯白 + 灰块”。
- [ ] 选中态是**软底 + 主文字/强调文字**，不是整块实心紫。
- [ ] 菜单/弹窗没有重阴影；需要浮起的只有 toast/任务 dock。
- [ ] 空态/加载/错误有统一形态，不是每个页面一套。
- [ ] 键盘 Tab 一圈走完，焦点始终可见；Esc 能关浮层。
- [ ] 三皮肤（默认/Hub/梦幻）都看一遍；Dream 的状态色/浮层底没有落回默认档。

### 7.5 建议的提交粒度

| 阶段 | 建议 commit | 内容 |
|---|---|---|
| Phase 0 | `test(ui): add benchmark capture + contract` | 只加工具/基线，不改视觉 |
| P0-1 | `style(composer): card surface + 820 width` | 只改 Composer |
| P0-2 | `style(chat): 820 doc width + compact system rows` | 只改正文/系统消息 |
| P0-3 | `style(theme): lift dark text + soften borders` | 只改 dark token |
| P0-4 | `fix(a11y): single focus ring` | 只改焦点 |
| P0-5 | `style(settings): soft active + grouped rows` | 只改设置 |
| P1-1 | `feat(cmdk): grouped command center` | 只改命令面板 |
| P1-2 | `feat(model): role-based picker` | 只改模型菜单 |
| P1-3 | `style(sidebar): density + tree status` | 只改侧栏/树 |
| P1-4 | `style(tools): row-first tool surface` | 只改工具 |

> 不要一个 commit 同时改 token + 布局 + 组件；否则截图差异无法归因，回滚也会带走别的改动。

### 7.6 如果执行到一半上下文丢了

1. 打开本文件对应 P 段 + `05-UI-UX.md` 的 token 表；
2. 打开该阶段的 `before/` 与 `after/` 截图，确认“现在改到哪一步”；
3. 跑 `ui-benchmark-check --check`，看哪些契约已过/未过；
4. 若工作区有半套 CSS：`git status` + `git diff`，**只保留该阶段列出的文件**；其余 `git checkout -- <file>`；
5. 不要凭记忆补设计；以 contract + 截图为唯一真相；
6. 下一阶段从 `P0-1` 重新开始，不要跳步。

---

## 8. 不要照搬 OMP 的地方

| OMP 的做法 | 为什么不能直接搬 |
|---|---|
| 36px 菜单条 + 44px 页面头 | Codem 的 logo/执行模式/窗口按钮都在 44px 里；硬缩会挤爆拖拽区和窗口控制 |
| 10 个页面的一级导航 | Codem 的功能入口在侧栏/任务中心/设置，直接搬会变成第二套 IA |
| 24px 文件树行 | 中文 12px 在 24px 行里可读，但 Codem 树有 git 徽章/操作按钮；26px 更稳 |
| 768px 硬文档列 | Codem 有表格/PPT/代码 diff；820 更合适，且表格允许全宽 |
| 用户气泡实底 accent | 只在暗色成立；亮色要淡紫；三皮肤都要测对比度 |
| 所有静态面去阴影 | OMP 的 toast/task dock 仍有阴影；Codem 要保留“浮起”语义，只去掉静态面的 |
| 模型角色 `@default/@plan/...` | 这是 OMP Runtime 的概念；Codem 的角色要按自己的 provider/agent 模型映射 |
| 页面级 Time Travel | 依赖 OMP checkpoint 语义；Codem 有 session_events/恢复，但不等价 |

**Codem 应该保留的资产**：

- 三皮肤（尤其 Hub 橙 / Dream 粉）的强身份；
- 阿里巴巴方圆体（中文品牌感）；
- 功能密度：23 设置分区、任务中心、知识、记忆、手机/微信；
- 判据/审计体系（CSS contract、scan-ui、token hygiene）。

---

## 9. 附录：关键文件与当前读数

### 9.1 文件地图

| 要改什么 | 文件 |
|---|---|
| 全局 token / 暗色档 | `src/styles.css`（`:root` 与主题档） |
| Composer | `src/styles.css` `.input-area` / `.input-card-container` / `.input-textarea-row` / `.input-action-row` |
| 消息 / 用户气泡 / 系统消息 | `src/styles.css` `.messages-container` / `.message` / `.user .message-content` / `.system .message-content` |
| 设置 | `src/styles.css` `.settings-panel` / `.settings-sidebar-item` / `.settings-content`；`src/components/SettingsPanel.tsx` |
| 侧栏 / 树 | `src/styles.css` `.sidebar-*` / `.file-entry`；`src/components/Sidebar.tsx`、`FileTree` |
| 工具卡 | `src/styles/codem-ui.css` `.tool-card*`；`src/components/ToolCallCard.tsx` |
| 菜单/弹窗 | `src/styles.css` `.popover-shell` / `.model-picker` / `.modal-*`；`src/components/ui/*` |
| 命令面板 | `src/components/SearchDialog.tsx`（或现有 cmdk 组件） |
| 皮肤 | `src/styles/skin-hub.css` / `skin-dream.css`；`src/core/theme/*` |
| 契约/截图 | `tools/ui-audit/` + `docs/evidence/ui-benchmark-*` |

### 9.2 当前实测读数（1600×1000，默认 dark）

| 项 | Codem | OMP |
|---|---|---|
| `--bg-primary` | `#0e0f0f` | `#121519` |
| `--text-primary` | `#d4d4d4` | `#e7e8eb` |
| `--border-primary` | `rgba(255,255,255,.14)` | `rgba(255,255,255,.07)` |
| `--accent` | `#7c6cf0` | `#9e8cfc` |
| `--radius` | 8px | 9 / 12 / 16 |
| titlebar | 44px | 36px menu + 44px page head |
| chat header | 54.7px | 44px topbar |
| sidebar | 231px（用户设置） | 272px |
| assistant content | 907px | 768px |
| composer | 1013×135，0 圆角，透明，重阴影 | 768×96，16 圆角，surface，无阴影 |
| settings | 760px 弹窗，14px，20% 紫软底选中 | 1080 页，12px 行组，14% 软底选中 |
| file tree row | 28px / 13px / 6px | 24px / 12px / 4px |
| session row | 31.5px / 20% 底 | 28px / 14% 底 |
| model menu | 320–560 宽，平铺 10+ `【未知】` | 240–320 宽，9 个角色，选中 check |
| modal | 560 / 760，14px，阴影 | 480，16px，边框，无阴影 |

> 读数来自 2026-10-26 的安装版 / harness；后续版本变化时，用 `ui-benchmark-check --write` 重新采集，不要手抄旧数字。

### 9.3 参考截图

全部在 [`docs/evidence/ui-benchmark-omp-2026-10-26/`](../evidence/ui-benchmark-omp-2026-10-26/README.md)：

- OMP：workbench / settings / cmdk / model menu；
- Codem：main dark / settings dark / cmdk / model menu / hub / dream。

---

## 10. 一句话给执行者

**先做 Phase 0 的截图/契约，再按 P0-1→P0-6 一次只改一件事；每改完一项，用 `before/after/OMP` 三列截图 + computed contract 验收。不要凭“感觉像 OMP”就继续加特效——OMP 的高级感来自克制，不是来自更多。**
