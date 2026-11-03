# 远程文件变更（Host / 桌面网关 → 手机）—— 只读取证与首版边界

> 第 270 波实现 Host 侧；ADR-0005 M3 起桌面网关复用**同一套协议与同一份服务实现**，
> 但数据源换成桌面自己的 `turn_file_changes`（见 §1b）。本文说明**手机看到的到底是
> 哪一份记录**、协议形状、首版明确不做的部分，以及每条判断对应的判据。
> 改这条链路前先读这里，别把"另一个进程的那份库"当成当前宿主的数据源。

## 1. 结论先说（Host）：手机看到的是 **Host 自己跑过的回合**

| 事实 | 证据 |
|---|---|
| 桌面 spawn Host 时给了**独立数据根 + 独立空工作区** | `src-tauri/src/host_cmd.rs`：`--data-home <appData>/com.codem.app/host`、`--workspace <data_home>/workspace` |
| Host 的库在它自己的数据根下 | `packages/host/src/config.ts`：`dbPath = dataHome/codem-db-rust.bin` |
| 桌面自己的库在别处 | `src-tauri/src/storage.rs`：`%APPDATA%\com.codem.app\codem-db-rust.bin` |
| 两端写的是**同一张表结构**、**同一份** `FileChangeTracker` | `src-tauri/codem-db/sql/schema.sql` 的 `turn_file_changes`；`src/core/environment/file-change-tracker.ts` |

因此首版选择的是**组件共享**（同一套追踪器/协议/UI），不是**数据面共享**（同一个 SQLite）。
后果必须如实告诉用户：手机列表里是**经 Host 跑过的回合**的变更；桌面渲染进程直接跑的回合
不会出现在这里。把桌面库存共享给 Host 需要统一数据面（两个长驻进程写同一个 SQLite，
涉及跨进程库锁 / 单写者租约），属于 ADR 级改动，本版不做。

## 1b. 结论（桌面网关 M3）：手机看到的是 **桌面自己那份记录**

ADR-0005 的 M3 变更面不是把 Host 的数据搬到桌面，而是让网关读**桌面渲染进程的
同一份** `turn_file_changes`（`FileChangeStorage` / `queryChangesPage` /
`getByIdAsync`）与**会话自己的工作区**的 git 对象：

- 没有第二份记录、没有网关缓存、没有跨进程共享 SQLite；
- `session.list` 是全项目的，`workspaceFor(sessionId)` 按会话取 cwd
  （worktree 会话取 worktree），不是"桌面当前项目"；
- 服务实现与 Host 共用 `packages/host/src/changes.ts`，差异只在注入的数据源；
- 跨工作区/对象被清理 ⇒ `supported:false + reason`；敏感路径硬拒绝；
- Host 侧 `cat-file -e` 白名单补上（只允许存在性检查），否则"对象缺失"会被误报。

真机用例：`GATEWAY-M2-DEVICE-CASES.md` 的 GWD-12..15；判据：
`src/test/gateway-changes.test.ts`、`src/test/remote-gateway-changes.test.ts`。

## 2. Host 为什么以前一条记录都没有（已修）

Host 里的 `AgenticLoop` 照样 `new FileChangeTracker(...)` + `start()`，但 `start()` 的
`git rev-parse` 走 Tauri `execute_command`；Host 的 Node 兼容层没有这条命令
（`packages/host/src/tauri-compat.ts` 直接抛）⇒ `isGitRepo()` 恒 false ⇒ `finalize()` 恒 null
⇒ 表在库里、行永远为空。

修法：新增**结构化 git 执行口** `src/core/command-api.ts`（`runGit(cwd, args[])`，argv、不经 shell）：

- 桌面：默认实现仍走 Tauri `execute_command`（行为逐字不变；批量仍由一次 PowerShell 完成）；
- Host：`packages/host/src/git-exec.ts` 用 `spawn("git", ["-C", cwd, ...args])`；
- 两侧统一加 `-c core.quotepath=false`（非 ASCII 路径不再被转义成 `"\346…"`）。

Host 侧的安全边界（这条通道**不过审批**）：

- 子命令白名单：`rev-parse` / `stash create` / `ls-files` / `diff` / `cat-file -e`
  （`cat-file` 只允许 `-e <对象名>`，不许读内容/批量）；
  `add` / `commit` / `push` / `apply` / `checkout` / `reset` / `clean` 一律拒绝；
- `diff` 拒绝 `--output`（写文件）、`--ext-diff` / `--textconv`（执行外部程序）、`--no-index`；
  并默认加 `--no-ext-diff --no-textconv`；
- `cwd` 必须在 Host 工作区内；超时杀进程树；stdout/stderr 有上限。

判据：`src/test/host-git-exec.test.ts`（GITP-1..5）、
`src/test/host-turn-file-changes.test.ts`（CHG-H1..5）。

## 3. 协议（只读，两个方法）

```text
session.changes       { sessionId, offset?, limit? }        → { items, hasMore, supported, reason? }
session.change.diff   { sessionId, changeId, path }        → { path, status, patch, truncated, supported, reason? }
```

`TurnChangesView`（`packages/protocol/src/index.ts`）只携带**展示所需**字段：

- `changeId` / `messageId` / `turnIndex` / `createdAt` / `status` / `brief`；
- `treesAvailable`（before/after 快照都在 ⇒ 才能取 diff）；
- `files[]`：`path`（posix）/ `status` / `additions?` / `deletions?`（**缺席 = 不知道，客户端显示 `—`**）；
- `totals?`：只对**有 numstat** 的文件求和；一个都没有则整个字段缺席；
- `filesParseError?`：`changed_files` JSON 损坏（不是"没有改动"）。

**不下发**：`before_tree` / `after_tree`（PC 侧 git 坐标）、`patch` 列（单行上限 500KB，
且可能是占位串）、`patchTruncated`（没有落库，下发就是编造）、`checks`
（按会话的设置面记录，不绑定这一轮）。

排序：Host 统一 `created_at DESC`。**不要用 `turn_index` 当"最新"的键** —— 它每个 prompt
从 1 重开，会让一个跑了很多迭代的旧 prompt 永久压住刚发生的新 prompt。
桌面 `FileChangeStorage.loadBySession()` 也已改成同一口径（`TFC-3c`）。

判据：`src/test/host-session-changes.test.ts`（CHG-P1..8）、
`src/test/host-capability-honesty.test.ts`（CAP-H1/H1b/H2）、
`src/test/host-protocol.test.ts`（PROTO-4）。

## 4. 首版明确不做（UI 必须如实表达，不许画禁用按钮/空块）

| 不做 | 手机端表现 | 判据 |
|---|---|---|
| 回滚 | 不出现回滚按钮；`status === "reverted"` 只显示"已回滚"标签 | `CHG-UI-3` |
| checks（最近检查） | 整个区块不出现（`capabilities.checks=false`） | `CHG-UI-5` |
| 实时事件 | 打开页签取一次 + `run.finished` 后刷新 + 手动「刷新」；文案不写"实时" | `CHG-UI-10` |
| 大 diff 完整查看 | 200KB 封顶，`truncated=true` 时明说"已截断" | `CHG-P7` / `CHG-UI-9` |
| 按用户回合分组 | 标签写"第 N 轮 · HH:MM"（迭代号会重开，不写"第 N 个对话回合"） | `CHG-UI-4` |

Host 没有按轮次的检查数据，所以手机端 `capabilities.checks=false`；桌面仍由
`listVerificationChecks(sessionId)` 注入「最近检查」（标题不写"本轮"）。

## 5. 空态矩阵（四种，互不冒充）

| 状态 | 文案 |
|---|---|
| 读取中 | `读取中…` |
| 读取失败 | `文件变更记录读取失败` + 错误原文 |
| Host 不支持 | `此 Host 不记录文件变更` + 原因（非 git 仓库 / 机器没有 git） |
| 真的没有记录 | `暂无文件变更记录` + `Agent 执行修改后会自动记录` |

`session.changes` 的 `supported=false` 只在"工作区不是 git 仓库且没有任何历史记录"时出现；
若已有历史记录，即使当前工作区不再是仓库也照常返回（记录是真的，不能藏）。

## 6. 已知限制（说清楚，不猜）

1. **未跟踪的新文件没有逐行 diff**：`stash create` 不包含 untracked 文件，tree-to-tree diff
   为空。服务端会返回 `supported=false + reason`，而不是画一个空 diff。
2. **Android PRoot 可能没有 git**：Host 仍能启动，`supported=false` 如实降级；
   不因缺少 git 让 Host 起不来。
3. **Host 默认工作区是空的**（桌面 sidecar 给的是 `<data_home>/workspace`）：在没有把它指向
   一个 git 项目之前，手机看到的就是"此 Host 不记录文件变更"。这是产品选择（数据面隔离），
   不是缺陷掩盖。
4. **回滚数据已够、动作未做**：`turn_file_changes` 有 tree + patch，但回滚需要审批、
   残留上报与写租约，单独一步。
5. **`.codem-snapshots/*.json` 可能出现在列表里**：快照机制把内部文件写在工作区；
   工作区若没有把该目录放进 `.gitignore`，它会像普通新增文件一样被 `git ls-files --others`
   收进来（桌面同形）。这是追踪器与快照机制的既有边界，不是 Host 特有的编造数据。

## 7. 共享展示层

- 组件：`packages/ui/src/changes-list.tsx`（`ChangesList` + 手机 `SessionChangesPane` 用的
  `ChangeDiffOverlay`）、`packages/ui/src/changes-model.ts`（最近一轮/统计/空态纯函数）；
- 桌面适配器：`src/components/FileChangesList.tsx`（取数 + `git show` + 回滚 + checks）；
- 手机接线：`packages/ui/src/changes-pane.tsx`、`packages/ui/src/mobile-app.tsx`
  （第三列「变更」页签，`WorkspaceDetail` 的 `changes` 可选注入）。

判据：`src/test/ui-changes-list.test.tsx`（CHG-UI-*）、
`src/test/ui-detail-tabs.test.tsx`（DT-7）、
`src/test/file-changes-list-diff.test.tsx`（CHG-D1/2，桌面 `git show` 适配器）、
`src/test/inspector-turn-summary.test.tsx`（INV-1..4，桌面真实路径仍绿）。
