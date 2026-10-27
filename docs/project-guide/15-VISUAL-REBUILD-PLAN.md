# 15 · 视觉重做施工计划（HTML 下限 → OMP 细节）

> 基线：2026-10-26，master @ `5b2050f3`，版本 1.16.330。
> 适用范围：对话工作台、左侧栏、Composer、设置内容。
> **底栏排除**：底部面板/终端高度/折叠条不在本轮计划内，不改。
> 目标不是“测试绿”，而是先达到我们自己 HTML 的视觉下限，再逐项对照 OMP 细节。

---

## 0.0 当前进度（2026-10-26）

| Phase | 状态 | 已做 | 未做 |
|---|---|---|---|
| 0 基线 | 完成 | 安装版 CDP、HTML 1400/1280、OMP 0.75× 换算、三列表落盘 `phase0-phase1.md` | 本机最大化 1280×672，1400×875 真实窗口无法取证（已标 unknown） |
| 1 左栏 | 完成 | 240/32/30/32、工具 45、分组 28、会话图标+时间、项目计数、项目/会话层级、无文件树；43 行滚动不压缩、键盘 focus 已取证；会话行补 `role=button/tabindex=0/Enter/Space` | — |
| 2 对话 | 进行中 | header 48、tool group 32px、StatsLine 元信息、任务完成胶囊（用户确认保留）、左缘 20px 对齐、最新消息不折叠、系统 nudge 及其补验证回合从可见时间线移除；真实样本 14 工具/2 失败 | 工具内部行、运行/失败/停止四态截图 |
| 3 Composer | 进行中 | placeholder、chips 行式、模型+推理等级、整卡焦点柔光、排队卡、底栏已删 | IME 三态截图 |
| 4 设置 | 进行中 | 6 组 IA / 23 tab、运行模式 46px 行式、外观 7 行行式（控件右缘 1183） | 其余 tab 行式化、全部控件右缘验收 |
| 5 双基线 | 进行中 | 1600/1280/1024 + 真实 125%/150% 主界面/设置页、折扣台账 | 剩余状态截图 |
| 6 右栏 Inspector | 未开始（原计划遗漏） | 现有改动/文件/子代理页签、diff 预览 | 宽度 360→400、tab/文件行/检查行/上下文/预览/底部规格对照 |

**仍未完成（不得报完成）**：Phase 2 工具内部行与四态截图；Phase 3 IME 三态截图；Phase 4 其余 tab 行式化；Phase 5 剩余状态截图；Phase 6 右侧 Inspector 全量对标。

---

## 0. 先定三条纪律

1. **HTML 是下限，不是上限。** 当前实现不能比 HTML 更松、更大、更少信息。
2. **每改一个组件，必须先有真实构建截图，再谈完成。** CDP 注入 CSS 只能做探索，不能作为验收。
3. **所有差异进折扣台账。** 没写理由的差异 = 没做完；底栏差异不写，因为明确排除。

---

## 1. 基线工具（Phase 0，不改 UI）

### 1.1 真实构建

- `npm run build` 只产出 `dist/`，不是用户看到的窗口。
- 验收必须用：
  ```powershell
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri\codem-updater.key -Raw).Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
  node node_modules\@tauri-apps\cli\tauri.js build
  ```
- 产物：`src-tauri\target\release\bundle\nsis\Codem_<version>_x64-setup.exe`。
- 安装后再用 WebView2 CDP `9223` 截图；不接受浏览器 Vite 页面冒充 Tauri。

### 1.2 固定截图矩阵

| 场景 | 视口 | DPR | 主题 |
|---|---|---|---|
| HTML 对照 | 1400×875 | 1 | dark |
| OMP 对照 | 1200×750 | 1 | dark |
| 当前主工作台 | 1400×875 / 1280×800 / 1600×1000 | 1 | dark/light |
| 设置 | 1400×875 | 1 | dark |
| 窄窗 | 1024×768 | 1 | dark |
| 缩放 | 1400×875 @125% / @150% | 1 | dark |

### 1.3 固定状态

- 主工作台：有会话、有 assistant 正文、有工具调用、有运行中状态。
- 设置：打开设置，默认“通用”，搜索框空。
- 左栏：有项目、有今天/更早会话、有文件树。
- 每次截图同时记录：URL/路由、viewport、theme、density、lang、session/project。

### 1.4 computed 清单

- 左栏：`.sidebar` 宽；`.sidebar-nav-item` 高/padding/font；`.sidebar-session` 高/padding/font；`.sidebar-project-header` 高；`.sidebar-tool-item` 高；`.file-entry` 高/font。
- 对话：`.chat-header` 高/padding；`.message-content` 宽/font/line-height；`.bubble` padding/radius；`.tool-row/.tool-card` 高；`.status-line` 高。
- Composer：`.input-wrapper` 宽/高/radius/shadow；`.input-textarea-row` 高；`.input-action-row` 高；chips 高；model chip 位置。
- 设置：`.settings-page`、`.settings-sidebar`、`.settings-content` 宽；`.settings-subnav` 高；设置行 min-height；控件宽。

### 1.5 交付物

- `docs/evidence/visual-gate/<date>/html-vs-current-vs-omp.md`：三列表。
- 每行：元素 / HTML / 当前 / OMP / 结论 / 折扣理由。
- `computed.json` + 截图。
- 没有三列表，不进入下一阶段。

---

## 2. Phase 1：左栏（先做，因为它影响整页比例）

### 2.1 目标值（来自 HTML）

| 元素 | HTML | 当前 | 动作 |
|---|---:|---:|---|
| 侧栏宽 | 240 | **240（含 min-width）** | 持久化宽度低于 240 时按 240 渲染 |
| 导航行 | 32 | **32；12px；padding 0 8** | 完成 |
| 会话行 | 30 | **30；12px；图标 + 时间；时间距右缘 8px** | 完成 |
| 项目行 | 32 | **32；folder accent + count（hover 让位）** | 完成 |
| 工具格 | 43 | **item 43 / row 45（含上下 1px 分隔线）** | 还差 2px 行高 |
| 分组标题 | 28 | **28；11px/600/.04em** | 完成 |
| 文件树 | 左栏，24px，11.5px | 右栏，26px，14px | **用户澄清：左栏不要出现文件树；项目/会话改成文件树那种紧凑、缩进、层级感样式** |
| 会话元信息 | `now/2h` + 消息图标 | 无 | 从 `updatedAt`/时间源补；无值不伪造 |
| hover | 时间让位、操作出现 | 只有操作 | 补让位 |
| 选中 | accent-soft + accent 字 | accent-muted + accent-strong | 对齐 token |

### 2.2 冲突处理

- `RHYTHM-1/2` 当前钉住旧值（项目头 32、分组 24、导航/会话 padding 原值）。
- 达到 HTML 的 32/30 必须改这两个判据的**验收基线**；这不是“绕过测试”，是产品决定。
- 在改判据前先记录：旧基线来自 v1.16.165 用户验收；新基线来自 HTML + 本轮截图。
- 改判据必须同时补新几何判据，不能只删旧断言。

### 2.3 文件树决策（用户已澄清）

- **左栏不出现文件树**；真正的文件树仍属于右栏/PanelSidebar。
- 用户要的是“项目/会话像文件树那样排”：紧凑行、缩进、层级线、项目是目录/会话是子项。
- 已移除左栏 `FileExplorer`；项目列表下只保留项目/会话，项目展开的会话用左侧层级线 + 缩进。
- 右栏 Files 保持原入口，不重复。

### 2.4 验收

- 1400×875 截图：左栏 240/32/30/32/43/28 全部命中；
- 40 行滚动不压缩；
- 无左栏文件树（用户已澄清，文件树 hover 项不再适用）；
- 键盘：行是 button，focus-visible inset；
- RHYTHM 新判据绿、旧判据明确替换；
- 与 HTML 三列表无“更松/更大”项。

---

## 3. Phase 2：对话区

### 3.1 目标

- `.chat-header` 48，含标题、模型 chip、`轮数 · 上下文% · main`、状态点（完成）；
- 系统压缩提示从“大 SYSTEM 卡”改为 **30px 紧凑状态行**（完成；摘要一行，点开全文）；
- 消息区按 mock：assistant 头 `Codem + 时间`、用户气泡 78% max、status line、summary card、turn foot；
- tool group 标题行 **32px surface**（完成）；元信息由 StatsLine 输出（完成）；summary card 因与正文重复已移除（用户确认无意义）；任务完成胶囊经用户确认保留（优于 mock，记入折扣台账）；tool 卡片内部仍待重做；
- 自建文件验收样本已跑通：14 个工具、2 个失败，报告含 H1/表格/7 个代码块/引用/链接；
- 运行中状态不伪装成完成；审批/失败/停止各有文案。

### 3.2 数据前提

- 轮数、上下文百分比、压缩阈值：读现有 session/context 数据；读不到显示“—”，不伪造。
- tool diff +/−：读 file change tracker；无数据显示空。
- summary：只在存在真实摘要时显示；没有就不渲染。
- 状态行：只从 run status/tool pipeline 读取。

### 3.3 验收

- HTML 同视口：header 48、tool row 32、bubble 14/1.65、正文 14/1.7；
- 系统提示不再是大色块；
- 运行中/完成/失败/停止四态截图；
- 长消息 60k 字符滚动 p95 ≤16.7ms；
- 不引入 per-delta 写库。

---

## 4. Phase 3：Composer

- 保持 820×116 外壳（已对）；
- 输入框 placeholder 改回“输入消息… @提及文件 /命令”（完成）；
- 补上下文 chips（文件/引用/附件）在输入框上方，22px；
- 工具栏收敛为 `+ / @ / /` 三类主操作，其他放进“更多”；
- 模型选择移到 Composer 右下（复用 ModelSelector，不复制数据）；
- 补底栏“本地处理 · 数据不出设备 / Enter 发送 · Shift+Enter 换行”（完成）；
- 运行中边框只换 info 边，不加阴影；
- 焦点环仍只在 `.input-textarea-row` 单环。

验收：HTML 同视口三态（空/运行/焦点）；IME 中文组合 Enter 不发送；320/768/1024 不溢出。

---

## 5. Phase 4：设置内容

- 壳已完成：全屏、220 侧栏、900 内容列、22px 页级标题、26px 子导航、无内容卡片、28px footer、滚动条贴窗口右缘；本轮只重排内容：
  - 6 组 IA：通用与外观 / 模型与运行 / 对话与知识 / 工具与权限 / 连接与设备 / 高级与帮助（完成，23 tab 全保留）；
  - 行式设置：`set-row` 最小 46、label 12.5、desc 10.5、control 右侧 200；
  - 通用首屏去掉“运行模式”双大卡，改成行（完成：876×46 行）；
  - 控件右缘对齐；footer 固定；
  - 23 个 tab 的内容分批迁移，不能一次全套。
- 保留显式保存/`saveFailure`/搜索/快捷键。

验收：1400×875 设置截图；HTML 行式对照；控件右缘误差 ≤2px；footer 不裁；23 tab 无内容丢失。

---

## 6. Phase 5：全量双基线验收

- 真实安装版截图矩阵；
- 三列表 + 折扣台账；
- `tsc/build/full` 全绿；
- `scan-ui/css-contract` 只允许预期变化；
- 1600/1280/1024/125%/150%；
- 不通过就回退该组件，不带病报完成。

---

## 7. 明确不做

- 底栏（用户明确排除）。
- 独立 Home/Agent Hub/Capabilities/Models 页面（P2-6 已撤回）。
- 不改数据模型/不引入 per-delta 写库。
- 不为了“像 OMP”改用户气泡为实底。

---

## 8. 执行顺序

```text
Phase 0 真实构建 + 基线截图 + 三列表
  ↓
Phase 1 左栏（含文件树位置）
  ↓
Phase 2 对话区
  ↓
Phase 3 Composer
  ↓
Phase 4 设置内容
  ↓
Phase 5 双基线验收
```

每个 Phase 结束必须停下来交截图/三列表，不允许连续“顺手改”到下一 Phase。
