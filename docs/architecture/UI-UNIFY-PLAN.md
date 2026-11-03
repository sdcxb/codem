# UI 统一方案（A：一套组件 + 手机/平板适配）

> 决策：**选 A** —— 桌面与 Android 最终共用同一套聊天/工具/审批组件；
> 同时布局按设备形态适配（手机单列、平板双列、宽屏三列）。本文是可执行的分阶段计划。

## 现状基线

| | 桌面 | Android 共享 UI |
|---|---|---|
| 组件 | 206 文件 / 58k 行（聊天相关 ~15–20 个 / 8–10k 行） | 9 文件 / ~1.3k 行 |
| 渲染 | react-markdown + Shiki + Mermaid/KaTeX | 纯文本（**本轮已接 Markdown**） |
| 工具卡 | 参数/diff/文件变更/折叠 | 名称 + 输出 + 展开 |

## 阶段

### Phase 1（本轮，已完成）

- `packages/ui/src/markdown.tsx`：GFM + PrismLight（js/ts/tsx/py/bash/json/md），
  危险协议过滤、不开 `rehype-raw`（XSS）；
- 布局断点改为 **手机 <600 / 平板 600–999 / 宽屏 ≥1000**；
- 触控目标 ≥44px、输入 16px 防缩放、底部 `safe-area-inset-bottom`；
- 判据：`MD-1..3`、`LAYOUT-1..3`、`ui-session-chat` 工具名恢复；
- 真机截图：`evidence/ui-chat.png`（Markdown 列表）、`ui-wide-1200-physical.png`（三列）。

### Phase 2（已完成，2026-11）

- 新增 `packages/ui/src/tool-card.tsx`（`ToolCardView`，对齐桌面 `ToolCallCard` 的信息结构）：
  名称、参数摘要、状态、耗时、参数区、结果、折叠、diff 增删着色；
- 移动端接入；数据从 `tool.start` 的 args 与持久化 `assistant.toolCalls` 恢复；
- 判据：`TOOLCARD-1..4`（截断/展开、参数、错误态、diff 着色）；真机截图 `ui-chat.png`。
- 说明：桌面专用卡（Terminal/Read/Diff metadata）仍留在桌面，Phase 4 再统一。

### Phase 3：Composer / 附件 / 只读连接信息

- 已完成：只读「信息」面板（hostId / 能力清单 / 事件水位 / 运行数 / 工作区），`INFO-1..2` + 真机 `ui-info.png`；
- 已完成：附件 `attachment.put`（数据根 attachments/，随 prompt 复制到工作区 `.codem-attachments/` 并写入引用）+ Composer「附件」按钮/待发 chips；
- 已完成：插件列表只读（Host `plugins.list` + 信息面板）；Android `adjustResize` + 输入框 focus 滚动；附件真机 DC-14 通过。
- Phase 4/5 待做。

### Phase 4（已完成主体，2026-11）

- 桌面默认聊天已切到共享实现：`packages/ui/src/message-bubble.tsx` + `tool-card.tsx`；桌面仅保留平台适配器与专用卡注入；
- `ChatPlatform` 13 个槽位全部必填（缺 Provider 直接抛错），无第二条渲染路径；
- 判据：`WIRE-1..6`、`WIRE-5`（桌面/共享同一棵 DOM）、全量 8976 用例；
- 未统一：CSS 归属、专用工具卡（Terminal/Diff/Read/Search/Web 由桌面注入）；
- 只读预览页：`?ui=shared` 已删除（B 项；判据改钉真实 `ChatPanel`，不再用预览页证明）；
- 这是风险最高的一步：桌面 store/事件耦合需要适配层；
- 判据：桌面既有聊天判据全绿 + 真机桌面截图对比。

### Phase 4.5（已完成：审批统一，2026-11）

- 新增 `packages/ui/src/approval-card.tsx`：**一份**决策卡，三个分支 `approval`（放行/拒绝 + 命令或参数明细 + 风险/资源/来源）、
  `plan`（计划全文 + 两步拒绝）、`clarification`（单选/多选/文本 + 必填门控）；
- 五个入口全部映射到它：桌面 `DecisionTray`（前台托盘）、`PermissionDialog`（权限弹窗）、`PlanApprovalCard`、
  `ClarificationForm`，以及手机 `ApprovalCard`（旧的 `.approval*` 实现与 `.permission-*` 整族 DOM/CSS 已删）；
- 差异只来自**数据**与**能力位**（`alwaysAllow` / `rejectReason`），没有 `isMobile`/`variant` 开关；
  不支持的能力**不出现**（例如远端审批与手机端的「始终允许」「拒绝理由」）；
- 外壳留在各端：桌面托盘是 `position: fixed` 浮层、权限弹窗由 `.permission-overlay .decision-tray` 把定位收回、
  计划弹窗的「点遮罩 = 拒绝」留在 `PlanApprovalCard`；
- 判据：`AU-1..AU-11`（`src/test/approval-unify.test.tsx`）、`DEAD-2`（两步拒绝仍在）、`ui-session-chat` 审批用例；
- 已完成（A 项）：引擎侧兑现 `PermissionResult.reason` / `alwaysAllow`（会话级 + 精确资源的「始终允许」，
  桌面托盘才印该控件；拒绝理由经 `PermissionResult.reason` 进入模型可见的拒绝文案）；
- 剩余（不在这一步）：CSS 归属（`ui.css` 一份、两端加载）、真机复跑 DC-5a/5b/5c。

### Phase 5：文件/差异/平板形态

- **已完成（第 5 步 · 文件/差异组件共享，2026-11）**：
  - 差异视图：算法 `packages/ui/src/lcs-diff.ts`（`computeDiff` / 渲染上限），
    骨架 `packages/ui/src/diff-view.tsx`（`DiffView`，文案由 `strings` **必填注入**）；
    桌面 `src/components/DiffViewer.tsx` 只剩平台注入（桌面文案 + 原样 re-export 算法）。
  - 文件树：纯数据层 `packages/ui/src/file-tree.ts`（图标/排序/过滤/徽章/尺寸），
    行与搜索栏 `packages/ui/src/file-tree-view.tsx`（`FileTree`）；
    桌面 `src/components/FileExplorer.tsx` 只剩 Tauri 取数 + 目录/Git 缓存 + 事件失效 + 展开态，
    **手机 `FileBrowser` 复用同一个行组件**（单层目录、无 Git 状态 = 数据源差异，不是第二套行）。
  - 样式归属：`.file-entry`/`.file-children`/搜索栏随组件进 `packages/ui/src/ui.css` §3b；
    `.empty-hint` 原语（含四个修饰）进 §3a —— 手机不加载 `styles.css`，空态必须两端同一份；
    手机壳 `web/index.html` 补了令牌桥（`--duration-press` / `--success-surface-strong` /
    `--warning-surface-strong` / `--info-*` / `--focus-ring-*` / `--shadow-color-soft` / `--empty-hint-*`）。
  - 判据：`FD-WIRE-1..5`、`FT-WIRE-1..4`（`src/test/ui-shared-file-diff-wiring.test.tsx`）、
    既有 `DV-BIG-*`/`DV-CAP-1`/`FB-1..4`/`FILE-TREE-*`/`INV-1..4` 全绿。
  - 未完成（精确阻塞，见下）：`FileChangesList` 仍是桌面实现；手机端差异视图仍显示 patch 文本。

- **`FileChangesList` 抽共享的阻塞点（不含糊其辞）**：
  1. 数据在桌面 SQLite（`FileChangeStorage.loadBySession`，按需查询、不含 patch 正文）与
     `git show <before_tree|after_tree>:<path>`（`execute_command`）；
  2. 回滚走 `FileChangeTracker.revert` + `confirmDialog`（原生异步确认），
     无 `SessionTransport` 通道（`transport.ts` 没有 `session.changes`）；
  3. ⇒ 手机侧**零消费者**：搬过去只会得到一份没人用的共享实现；
     要搬必须先加 `session.changes` RPC（含 changed_files/numstat/checks），那是独立一步。

- **手机端差异视图的阻塞点**：`SessionTransport.diffWorkspace` 只回统一 patch 文本，
  而 `DiffView` 吃 `before`/`after`（桌面三个入口都是这个形状）。给共享层加"第二种输入"
  就是两份 diff 渲染 —— 真要做，应搬桌面 patch 文本渲染器（`src/core/ui/diff-view.ts` +
  `DiffBlockCard`），而不是把 patch 文本假装成 before/after。

- **已完成（B/C · 平板与宽屏形态，2026-11）**：
  - 列表可折叠：骨架 `packages/ui/src/shell.tsx`（`SplitLayout`，只负责 `in-session` / `sidebar-collapsed`
    两个类名开关，不改 DOM）；折叠按钮在共享 `Header`（只在选中会话时渲染，
    `aria-controls="session-sidebar"` / `aria-expanded`，收起后把"已经丢掉的焦点"交给按钮）；
    折叠规则**只写在 `@media (min-width: 600px)` 内**且带 `in-session` 前置
    （手机 <600 结构上不受影响；没选会话时列表永远显示）。
  - 宽屏第三列可切换：`packages/ui/src/detail-pane.tsx`（`WorkspaceDetail`：文件 / 差异两个 `role=tab`）；
    两个面板**常驻**、`hidden` 切换（所以 `ui.css` 里显式写了 `.detail-body[hidden]` ——
    作者 `display:flex` 会压过 UA 规则，漏了就是两块叠着显示）；差异面板 `WorkspaceDiffPane`
    与预览里的 `Diff` 按钮共用 `loadWorkspaceDiff`，空态矩阵（未选文件 / 连接不支持 / 读取中 /
    不是 git 仓库 / 没有改动 / 出错）**各不相同**；"当前选中文件"由 `FileBrowser.onSelectFile` 上抛，
    切页签不丢文件树的目录与滚动位置。
  - 判据：`LAYOUT-4..7`（`src/test/ui-layout.test.tsx`）、`DT-1..6`（`src/test/ui-detail-tabs.test.tsx`）、
    `FB-5`（`src/test/ui-file-browser.test.tsx`），并逐条做过变异自证；
    真机用例 **DC-15/16/17** 已写入 `android-shell/run-device-cases.mjs`
    （**本轮未在真机执行**；需 `npm run android:build` + `npm run android:test:device`），
    截图脚本新增 `ui-wide-900-collapsed.png` / `ui-wide-1200-diff.png`（`android-shell/spike-ui-shots.mjs`）。
  - 仍未做：第三列差异仍是 patch 文本 `<pre>`（与上面「手机端差异视图的阻塞点」同一条）；
    要统一渲染须先搬桌面 patch 渲染器（`src/core/ui/diff-view.ts` + `DiffBlockCard`）。

## 边界与风险

- 不把桌面 58k 行全部搬走：只抽**展示组件**，store/命令仍留在各端适配；
- Shiki/Mermaid/KaTeX 桌面保留；移动端用 Prism light，避免 WASM/包体；
- 每阶段都必须有可红判据 + 真机截图，不允许“看起来像”。
