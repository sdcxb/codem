# 功能上下文静态审计（fork / compaction / event projection / feedback / presets）

- 仓库：`C:\mimo-gui`（Tauri v2 + React，Codem）
- 方式：**只读**源码与测试（`src/`、`scripts/`、`.preview-shot/` 里的测试输出），只写本报告；未改源码、未提交 git。
- 证据形式：每条结论都给 `文件:行号`。**注释与实现不一致时以实现为准**，并把不一致单独列出。
- 判定"有没有真消费者"时，生产调用者指 `src/` 下非 `src/test/`、非 `*.test.ts(x)` 的调用点；测试调用单独记在"测试"列。
- 说明两处**本次未复核**的东西（不猜）：
  1. 注释里引用的真机库统计（如"生产库 3112 条事件里 `session_snapshot` 0 条"，`src/core/storage/event-types.ts:37`）——本次未访问真机数据库，**未找到独立证据**，只标注为"注释声称"。
  2. Rust 引擎侧 `repo.rs::events_compact` 的实际实现——本次只读渲染侧；引用它的地方均标注为"注释引用引擎"。
- 最近一次全量测试结论（作为"测试是否绿"的依据）：`.preview-shot/r64-vitest9.txt:25913` `Test Files 336 passed (336)`。

---

## 1. 会话分叉（fork）

### 1.1 对账表

| 能力/环节 | 写方（文件:行号） | 读方（文件:行号） | 生产调用者是否存在 | 测试 |
|---|---|---|---|---|
| UI 分叉入口（按钮） | — | `src/components/ChatPanel.tsx:1018-1021`（`onFork(origIndex)`），prop 链 `src/components/ConversationRoot.tsx:22`，接线 `src/App.tsx:4324`、`4427`、`4562` | 存在 | **未找到证据**（按钮本身没有组件级用例；`component-message-bubble.test.tsx` 测的是工具栏显隐，与 fork 无关） |
| 窗口下标 → 会话绝对下标 | —（纯函数） | `src/core/session/fork-index.ts:65-108`（`resolveSessionAbsoluteIndex`）← 别名导入 `src/App.tsx:285`，调用 `src/App.tsx:4001-4015` | 存在 | `src/test/audit47-regressions.test.ts:165-241`（AUD47-1/2/3） |
| 分叉主入口（store） | `src/core/store.ts:285-416` | `src/App.tsx:4017-4030`（`handleFork`） | 存在 | `src/test/feature-context-fixes.test.ts:485,534,591,628,688` |
| 子会话行 + `parent_id` | `src/core/storage/session.ts:447-562`（`parent_id` 在 `:480`，`mode:"replace"` 在 `:524-530`）；列构造 `src/core/storage/session.ts:123` | `src/core/storage/session.ts:63`（`wireToSession.parentId`）；`session_trace` 工具 `src/core/llm/tools/session-search.ts:361-401` | 存在（`store.ts:315` → `session.ts:447`） | `src/test/session-lineage-preserved.test.ts:110,118-142,157-191`；`src/test/message-session-event-fix.test.ts:766-853`（FIXB-7a…d）；`src/test/audit47-regressions.test.ts:333-362`（AUD47-4 upsert）；`src/test/ui-batch-a-d.test.ts:1496-1504`（源码扫描） |
| 消息复制（消息 id / 工具调用 id / 附件 id 换新） | `src/core/storage/message.ts:1292-1316`（`copyMessageToSession`），附件正文解析 `:1319-1330` | `src/core/store.ts:372-377`（复制循环）；`src/App.tsx:4025`（`loadMessages`） | 存在 | `src/test/feature-context-fixes.test.ts:628-645`（附件不搬走 + 正文带过去）；`src/test/fork.test.ts:197-234` |
| 事件日志复制 | `src/core/storage/event-log.ts:626-681`（`EventLog.forkSession`） | —— **无任何读方** | **不存在**（生产侧已刻意不调用：`session.ts:532-554`；调用点仅测试） | `src/test/event-sourcing.test.ts:116-127`、`src/test/event-mirror.test.ts:316-325`（**在测一个零生产调用者的实现**） |
| `session_meta` / 反馈事件是否被带进子会话 | 不复制（`session.ts:532-554`） | — | —— | `src/test/feature-context-fixes.test.ts:686-692`（子会话里不许出现源会话的 `session_meta`） |
| worktree / 执行模式 | `src/core/store.ts:331-355`（`createWorktreeSync`、`updateSession`） | 会话行 `worktree_path`/`execution_mode` | 存在 | `src/test/feature-context-fixes.test.ts:521-541`（必须建在**源项目**仓库） |
| `message_count` 对账 | `src/core/store.ts:399-411`（写复制条数 + 引擎真值复核） | 侧边栏 / `session_trace` | 存在 | `src/test/feature-context-fixes.test.ts:688-720` |
| 「编辑并回退」第二条 fork 路径 | `src/App.tsx:4040-4130`（`createSession` `:4064` → 补谱系 `:4084` → 复制前缀 `:4097-4101` → 写编辑后的消息 `:4104-4110` → 计数复核 `:4127`） | 新会话消息列表 | 存在 | `src/test/message-rewind-fork.test.ts:74-130` |

**分叉到底复制了什么（结论）**：会话行（**带 `parent_id`**，并继承 `model`/`executionMode`/`worktreePath`/`worktreeBranch`/`correctionMode`/`deepThinkingMode`/`preserveExecutor`，`session.ts:480-497`）；`messageIndex` 所在的**整轮**为止的消息（`store.ts:362-379`），消息 id、工具调用 id、附件 id **三者全部换新**（`message.ts:1293-1315`）；worktree 按源项目新建（`store.ts:331-349`）。**不复制**：事件日志（`session.ts:544-551`）、`session_meta` 事件（同前）、源消息的附件行（新 id 复制，源行不动）。

### 1.2 问题清单

1. **【缺口】`EventLog.forkSession` 是一个没有任何生产调用者的完整写实现。**
   - 证据：定义 `src/core/storage/event-log.ts:626-681`；全仓调用点只有 `src/test/event-sourcing.test.ts:120`、`src/test/event-mirror.test.ts:325`（生产侧 `session.ts:535-537` 的注释明确说"不再调它"）。
   - 为什么是缺口而不是（纯粹的）设计：代码里对"不复制事件"给了充分理由（子会话消息是新 id，复制事件会造成孤儿 id，`session.ts:536-551`）——这条**设计决定是对的**；但把整段复制实现（56 行、含镜像/发件箱分支与两种失败上报）留着，同时**两个测试文件仍在跑它**，正是本项目点名的形态："测试在测一个没有生产调用者的实现"。它每被读一次都会让下一个人以为"fork 会复制事件"。

2. **【缺口】分叉复制来的历史工具轮在事件侧没有对应事件，会被不变量审计报成缺口。**
   - 证据：复制只调 `createMessage`（`message.ts:1314`），而 `assistant_text`/`user_message` 事件由 `appendMessageTextEvent` 写（`message.ts:1957-1960`、`2032`）；**纯工具轮的助手消息（正文为空）刻意不写文本事件**（`runtime-invariants.ts:44-50`、`message-session-event-fix.test.ts` 注释在 `:780`），而工具事件由 `tool-pipeline` 在真正执行时写（`session.ts:547-549`）—— 复制来的历史工具调用**不会**执行，所以没有 `tool_call`/`tool_result`。
   - 于是 `checkVisibleRecordedInvariant` 对"无正文 assistant 且事件侧既无文本也无工具事件"的消息报 `VISIBLE_BUT_NOT_RECORDED`（`runtime-invariants.ts:129-141`），而这条检查是**生产路径**：`agentic-loop.ts:833`（dev/`DEBUG_INVARIANTS=1`）与启动维护 `maintenance.ts:1244-1252`（计入 `out.violations`）。
   - 为什么是缺口：分叉是常见操作，而"分叉一次就给自己制造一批不变量缺口"会污染本项目的**唯一自动判据**（`runtime-invariants.ts:53-55` 自己说这条断言是"事件双写到底通没通"的判据）。
   - 测试：**未找到证据**（全仓 grep `VISIBLE_BUT_NOT_RECORDED` 命中的三份测试——`feature-wire-tail-fixes.test.ts:554,570`、`invariant-audit-load-window.test.ts:138-178`、`invariant-watermark.test.ts:68-96`——都不涉及 fork）。

3. **【文档漂移，非功能缺口】两条测试注释声称"fork 会丢工具调用、用例仍红"，与实现和最新测试结果都不符。**
   - 注释：`src/test/fork.test.ts:28-32`（"这条用例在端口模式下仍红…真机上 fork 出来的消息会丢掉工具调用"）、`src/test/encoding-toolcalls.test.ts:42-47`（同）。
   - 实现：`listMessagesMerged` 会用 `toolCallCache` 回填 `toolCalls`（`src/core/storage/message.ts:557-562`），这正是同步读路径拿得到工具调用的机制。
   - 结果：最新全量运行里这两个文件都是绿的（`.preview-shot/r64-vitest9.txt:24198` `✓ src/test/fork.test.ts (10 tests)`、`:24574` `✓ src/test/encoding-toolcalls.test.ts (6 tests)`）。
   - 判定：功能没缺，是**注释过期**——但按本项目规矩，过期注释等于假陈述，应改。

4. **【缺口，跨 fork/feedback】UI 上那个"分支对话"按钮所在的组件永远不会渲染。**
   - 证据：`src/components/MessageActions.tsx:73-78`（`onBranch` 才渲染 GitBranch 按钮）；全仓 **无 `<MessageActions` 渲染点**（grep `<MessageActions` 零命中），`MessageBubble.tsx:28` 只有 `import`。
   - 为什么是缺口：组件自己的文档说"消息悬停时显示…分支对话"（`MessageActions.tsx:4`），而真实的分叉入口只有 `ChatPanel.tsx:1021` 的 `qa-turn-btn`；同一份 UI 里存在两个"看起来能分叉"的位置，只有一个活着，且没有任何测试会因此变红（`component-message-bubble.test.tsx:56` 只是注释里提到它，断言的是 `MessageBubble` 自己的 `message-actions-bar`，见 `MessageBubble.tsx:865`）。

---

## 2. 上下文压缩（compaction）

### 2.1 对账表

| 能力/环节 | 写方（文件:行号） | 读方（文件:行号） | 生产调用者是否存在 | 测试 |
|---|---|---|---|---|
| 自动压缩触发（压力阈值） | — | `src/core/llm/agentic-loop.ts:1290-1304`（`contextPressure > compactionThreshold && enableCompaction`） | 存在 | `src/test/context-consistency.test.ts:526-543`（源码扫描）、`compaction-budget.test.ts` |
| 自动压缩触发（反应式溢出） | — | `src/core/llm/agentic-loop.ts:2159-2191`（`enableReactiveCompaction`） | 存在 | `src/test/database-maintenance-bounds.test.ts` 无关；未找到专门用例 |
| 自动压缩实现（软删 + 标记消息 + `compaction` 事件） | `src/core/llm/agentic-loop.ts:3202-3433`：软删 `:3404`、标记消息 `:3407-3413`、**事件 `:3417-3422`**、并发闸门 `:3401/3428` | 模型侧读的是软删后的可见集（`agentic-loop.ts:2859-2862`） | 存在（`agentic-loop.ts:1303`、`:2176`） | `src/test/feature-context-fixes.test.ts:777-890`（FC-D4e 端到端）、`compaction-budget.test.ts:180-292`（CB-7…CB-11 软删不复活区段） |
| 手动压缩（面板按钮） | `src/components/ContextMonitor.tsx:111-189`（软删 `:160`、标记 `:163-169`、事件 `:173-179`、闸门 `:157/185`）；按钮与守卫 `:354-399`、`:444-453` | 面板展示 `:422-441` | 存在（`ChatPanel.tsx:1147-1149` 挂载 `ContextMonitor`） | `src/test/feature-context-fixes.test.ts:933-1030`（FC-D5a…d）、`renderer-robustness-b.test.ts:573-603`（RB-5 重入守卫） |
| `/compact` 命令 | `src/core/provider/command-compact-provider.ts:13-32`、注册 `builtin-registry.ts:393` | —— **无**（见问题清单 C1） | **不存在** | 未找到证据 |
| 引擎侧快照压缩（`session_snapshot` / `events.compact`） | `src/core/storage/event-log.ts:326-506`（`compactWithSnapshot`） | 投影 `src/core/storage/event-projection.ts:136-138`、`:178-198`（`applySnapshot`） | **不存在**（全仓仅测试调用；`event-types.ts:35-37`、`maintenance.ts:1581-1587` 承认） | `src/test/snapshot-compaction.test.ts:94-266,343`（SNAP-1…8） |
| 压缩事件的消费 | `agentic-loop.ts:3417`、`ContextMonitor.tsx:173` | 投影 `event-projection.ts:154`、`:313-372`（`applyCompaction`）← `projectSurface` ← `surface-manager.ts:48` ← **`agentic-loop.ts:1279`**；校验 `event-projection.ts:458-467` ← **`maintenance.ts:1254`**；复盘 `postmortem.ts:160`（错误路径，`agentic-loop.ts:2228-2229` 调用） | 存在 | `src/test/replay-validation.test.ts`、`feature-context-fixes.test.ts:299-320` |
| 压缩期间并发闸门 | `src/core/storage/compaction-state.ts:19-28` | `src/store.ts:5`（`saveMessages` 据此退让）、`src/core/telemetry/telemetry.ts:10`、`:519-521` | 存在 | `feature-context-fixes.test.ts:973-1008`（FC-D5b） |
| 压缩锁（防并发） | `src/core/llm/compaction-control.ts:26-35` | `agentic-loop.ts:3170-3183` | 存在 | `src/test/dsh-integration-full.test.ts:85-94,211-268` |
| 压缩边界检查（事件侧） | `src/core/llm/compaction-control.ts:73-125`、`:130-140` | —— **无** | **不存在** | `src/test/dsh-integration-full.test.ts:94,122`（**在测零消费者的纯函数**） |
| 崩溃修复（未配对工具调用） | `compaction-control.ts:173-239` | `agentic-loop.ts:819-828` | 存在 | `src/test/dsh-integration-full.test.ts:134-167`、`functional-chain-closed-loop.test.ts:104-123` |
| 回放校验（"压缩后日志还能不能回放"） | — | `src/core/storage/event-projection.ts:409-486`（`validateReplay`）← **`src/core/storage/maintenance.ts:1234-1295`（`:1254` 调用）** | 存在 | `src/test/replay-validation.test.ts`（RV-1…11）、`event-type-set-consistency.test.ts` |

### 2.2 "压缩后历史还能不能完整读出来"——分三层如实回答

1. **事件日志层：完整（消息侧压缩不删事件）。** `agentic-loop.ts:3417` 与 `ContextMonitor.tsx:173` 只 **append** 一条 `compaction` 事件，事件日志没有删除路径被触发（唯一删事件的入口是 `compactWithSnapshot`，见 C2）。因此 `validateReplay` 仍能跑通、`applyCompaction` 仍能读出被移除的 id（`event-projection.ts:352-362`），两处都在生产路径上（`maintenance.ts:1254`、`agentic-loop.ts:1279`）。
2. **消息数据层：没丢（软删 + 权威日志留痕）。** 压缩走 `deleteMessagesByIds`（`message.ts:2463`），引擎侧是 `UPDATE messages SET hidden = 1`（`message.ts:2475-2480`），行仍在库里（外键目标不丢，`message.ts:429-458`）；权威 JSONL 也记录 `hidden`（`session-jsonl.ts:51-66`），重建索引时不会把压缩"复活"（`message.ts:568-576`）。
3. **产品读路径层：读不出来，且没有任何入口能读。**
   - `listMessagesFromIndex` 过滤 `!m.hidden`（`message.ts:865-868`）；`listMessagesMerged` 用 `hiddenMessageIds()` 再排一次（`message.ts:577-592`）；`listMessages` 就是 `listMessagesMerged`（`message.ts:850-852`）；`listVisibleMessages` 再过滤一次（`message.ts:889-893`）。
   - 全仓**没有**"列出隐藏消息"的读函数（grep `listHidden` / `includeHidden` 零命中），UI 侧也没有任何按 `hidden` 取数的入口（`ContextMonitor` 只统计可见条数，`ContextMonitor.tsx:256-257`）。
   - 因此用户/模型能看到的只有**摘要标记那一条真实消息**（`agentic-loop.ts:3407-3413`）+ 一行"上下文已压缩（移除 N 条旧消息）"的 UI 文案（`App.tsx:4300`、`:4403`、`:4529`）。这件事本身是**设计**（压缩就是要让上下文变小，`compaction-budget.test.ts:229-292` 的 CB-7/9/11 正是钉这一点），但值得注意的是：**没有任何"查看被压缩历史"的能力**，也没有任何测试断言"被压缩的消息还能被谁读出来"——数据在盘上，读不出来。

### 2.3 问题清单

**C1【缺口：UI/插件文案承诺了但实现没有】`/compact` 命令是一条声明式死链。**
- 证据：服务实现 `src/core/provider/command-compact-provider.ts:13-32`（`registerHandler` / `execute` / `isCompactCommand`），注册 `builtin-registry.ts:393`、`provider/index.ts:305`；而全仓 grep `commandCompact` / `isCompactCommand` 的命中**全是 import / 注册 / 插件元数据**（`provider/index.ts:122,198,305`、`builtin-registry.ts:118,393`、`command-compact-provider.ts` 自身、`plugin-registry-provider.ts:142` 的展示条目），**零调用者**；`src/App.tsx` 的命令分发里**没有** `/compact` 分支（只有 `/feedback`，`App.tsx:2701-2735`；其余斜杠命令见 `InputArea.tsx:1238` 的命令菜单）。
- 与文案冲突：`src/core/provider/plugin-registry-provider.ts:142` 对用户展示 "Command Compact Provider — /compact 命令，手动触发上下文压缩 … 关闭后 /compact 命令不可用"。
- 为什么是缺口而不是设计：渲染侧确实有"手动压缩"这个能力（`ContextMonitor.tsx:111`），但它挂在**面板按钮**上；`/compact` 既没接 App 的分发，也没人给 `commandCompact` 注册 handler —— 用户按文案在输入框敲 `/compact`，`isCompactCommand` 没有任何调用方去识别它，结果是"这句话被当成普通消息发给模型"。这是文案承诺 > 实现。

**C2【缺口：完整能力零生产调用者】引擎侧快照压缩（`session_snapshot`）没有接线。**
- 证据：写路径 `event-log.ts:326-506`、投影消费 `event-projection.ts:136-138` / `:178-198`、事件类型白名单 `event-types.ts:73`；调用点仅 `src/test/snapshot-compaction.test.ts:95,112,126,144,215,263`。维护刻意不接（`maintenance.ts:1542-1590`：`prunedEvents`/`compactedSessions` 恒为 0，四个入参是"惰性参数"）。
- 为什么是缺口：`event-types.ts:35-37` 与 `maintenance.ts:1581-1587` 都**如实写了**"当前没有生产调用者/刻意不接"——这一点作者是诚实的。但代价是：`session_snapshot` 这条类型、`applySnapshot` 这段替换语义（含 3 处容错）、以及 `compactWithSnapshot` 里那段修过真 bug 的 `cutoff_seq` 逻辑，全部只由测试驱动；而**它一旦被接上就会删事件**（`event-log.ts:487`），属于"高危但未接线"的能力，靠注释而不是靠闸门守着。

**C3【缺口：测试在测零消费者的实现】压缩边界检查函数无生产消费者。**
- 证据：`isCompactionBoundarySafe`（`compaction-control.ts:73`）、`findSafeCompactionBoundary`（`:130`）全仓只有 `src/test/dsh-integration-full.test.ts:94,122` 调用；`compaction-control.ts:57` 自己列表写明"**无**（只有用例）"。
- 为什么是缺口：作者已给理由（消息与事件之间没有 seq 映射，硬接等于猜，`compaction-control.ts:63-71`），因此**"不接"可以接受**；但函数仍在并被测试覆盖，等于维持一份"看起来在检查压缩安全边界"的能力，而生产压缩路径的真实边界对齐靠的是另一个函数（`alignKeepToRoundBoundary`，`agentic-loop.ts:3190-3192`）。

**C4【缺口：注释与实现相反】"`listMessages` 会把压缩隐藏的历史带回来"是假的。**
- 注释：`src/components/ContextMonitor.tsx:113-117`（"`listMessages` 会把软删（压缩隐藏）的历史也带回来…"）、`:243`。
- 实现：`listMessages` → `listMessagesMerged` **显式排除** `hidden`（`message.ts:577-592`），索引读也先过滤（`message.ts:865-868`）。
- 为什么算问题：这条注释是某次修复的**理由陈述**（P2-D12），读者会据此推断"产品里能读到被压缩的历史"；实际相反（见 2.2 第 3 点）。同一段里的结论（面板要用 `listVisibleMessages`）仍然正确，但理由是错的——属于"注释比实现说得多/说反了"。

**C5【缺口：静默失败】压缩事件的写入失败只 `console.warn`，而投影/世代追踪完全依赖它。**
- 证据：自动路径 `agentic-loop.ts:3423-3425`（`console.warn("[compactMessages] Event log compaction write failed (non-critical)")`）、手动路径 `ContextMonitor.tsx:180-183`。
- 为什么是缺口而不是设计：本项目对失败的要求是"必须可见"（统一的 `reportPersistFailure`/`reportActionFailure` 通道，见 `feedback.ts:474-484`、`store.ts:899-908` 的写法）。这里恰恰相反：消息侧已经软删并插了标记，**事件侧可以完全没有记录**，于是 `compaction` 事件缺失 ⇒ `applyCompaction` 不会把那些 id 记为删过 ⇒ 表面投影与真实可见集不一致，而用户与维护都看不到任何痕迹。

**C6【如实记录，不算缺口】手动压缩**不调 LLM**。**
- 证据：`ContextMonitor.tsx:106-109` 自己交代；摘要用确定性渲染器 `renderStructuredHistorySummary`（定义 `compaction-budget.ts:461`，段注释 `:414`；调用点 `ContextMonitor.tsx:134`）。
- 判定：这是刻意取舍（同步动作不该等模型调用），且契约（段名/上限/不丢路径）已与自动路径统一（`compaction-budget.ts:126-131` 的 `COMPACTION_MARKER_PREFIXES`）。不计缺口，但"两种压缩的摘要质量不可比"是产品事实。

---

## 3. 事件投影（event projection）

模块：`src/core/storage/event-projection.ts`（641 行）。投影目标类型是 `LLMMessage[]`（`event-projection.ts:14`）。

### 3.1 对账表

| 投影产物 | 写方（文件:行号） | 读方（文件:行号） | 生产调用者是否存在 | 测试 |
|---|---|---|---|---|
| `projectAll` / `deriveMessagesFromEvents` | `event-projection.ts:52-55`、`:639-641` | —— **无生产读方** | **不存在**（`agentic-loop.ts:31` 注释："deriveMessagesFromEvents removed"） | `src/test/event-sourcing.test.ts:168-241`、`dsh-integration-full.test.ts:593`、`extended-test-methods.test.ts:402`、`functional-chain-closed-loop.test.ts:88,123` |
| `projectSurface` | `event-projection.ts:496-532` | `src/core/llm/surface-manager.ts:48`（`getSurfaceState`）← `buildSurfaceNotice` `:82-100` ← **`agentic-loop.ts:1277-1285`**（注入系统提示词） | **存在**（唯一"活"的投影消费方） | `src/test/feature-context-fixes.test.ts:249-320`（FC-D0b/c/D1a/b） |
| `projectIncremental` | `event-projection.ts:64-92` | —— **无** | **不存在** | `src/test/event-sourcing.test.ts:249,277` |
| `validateReplay` | `event-projection.ts:409-486` | `src/core/storage/maintenance.ts:1254`（会话级结构自检，**生产**） | 存在 | `src/test/replay-validation.test.ts:79-309`、`event-type-set-consistency.test.ts` |
| `getActiveGenerations` | `event-projection.ts:545-599` | —— **无** | **不存在**（`maintenance.ts:1566` 自认） | `src/test/replay-validation.test.ts:307`（只断言"不抛"） |
| `replaceGeneration` | `event-projection.ts:608-619`（副作用：append 一条 `compaction`） | —— **无** | **不存在**（全仓仅定义） | **未找到证据**（无任何测试） |
| `applySnapshot`（消费 `session_snapshot`） | —— 生产无写方（见 C2） | `event-projection.ts:136-138` → `:178-198` | 写方不存在；读方只在"有快照时"生效 | `src/test/snapshot-compaction.test.ts` |
| `applyCompaction`（消费 `compaction`） | `agentic-loop.ts:3417`、`ContextMonitor.tsx:173` | `event-projection.ts:154`、`:313-372`（经 `projectSurface` 进系统提示词；经 `validateReplay` 进维护） | 存在 | `src/test/replay-validation.test.ts:291-309`、`feature-context-fixes.test.ts:299-320` |
| `session_meta` 分支 | `feedback.ts:78`（唯一生产写方） | `event-projection.ts:160`（**no-op `break`**） | 读方"存在"但**零效果** | `src/test/replay-validation.test.ts:72`、`snapshot-compaction.test.ts:73` |

### 3.2 谁是谁的权威（结论）

- **LLM 实际看到的消息**：来自 `messages` 表（`src/core/llm/agentic-loop.ts:2853-2862`，注释原文："DB CRUD is the single source of truth for LLM messages. The event log … is used for telemetry and audit only, **NOT** for message projection"）；消息行的**权威副本是 JSONL 追加日志**，SQLite 索引可重建（`src/core/storage/session-jsonl.ts:10-19`、`:17-18`；`src/core/storage/message.ts:841-852`）。
- **事件**：`session_events` 是**唯一没有等价物**的存储（`maintenance.ts:1223`），它自己是自身事件的权威（append-only，`event-log.ts:1-14` 的设计意图与 `:592-620` 的更正）。
- **投影**：纯粹的**派生读**，不写任何权威；它的唯一生产用途是（a）给系统提示词拼一行上下文状态（`surface-manager.ts:82-100`），（b）维护里的结构自检（`validateReplay`）。它**不是**消息的权威，也不是"会话状态的真相"。
- 因此：`src/core/storage/event-types.ts:6`（"Events are the source of truth; messages are derived projections"）与 `src/core/storage/event-log.ts:7`（"Source of truth for session state"）**与实现相反**；`event-log.ts:10-13` 的 "Phase 2: buildMessages() reads from event projection" 从未发生。

### 3.3 问题清单

**P1【缺口：注释不实 + 零生产调用者】`deriveMessagesFromEvents` 自称是 `buildMessages` 用的主函数。**
- 证据：`event-projection.ts:635-641`（"This is the primary function used by buildMessages() in agentic-loop."）对照 `agentic-loop.ts:31`（"removed"）与 `:2853-2862`（读 `listMessages`）。
- 为什么是缺口：这是**引用关系上的假陈述**，而且是"上游说有人用、下游说不用了"的形态；`scripts/verify-package-invariants.ts:62-72` 还把该导出列进 `core/storage` 的期望导出清单，等于给这条假关系加了第二处背书。

**P2【缺口：零生产调用者】`projectIncremental` 只被测试驱动。**
- 证据：定义 `event-projection.ts:64-92`；调用点 `event-sourcing.test.ts:249,277`。
- 为什么是缺口：它的存在理由是"增量投影"（注释 `:57-63`），而唯一可能用到增量的 `buildMessages` 早已改为基于消息表的指纹缓存（`agentic-loop.ts:2864-2932`）——增量投影这套机制在生产里被另一条（无关的）机制取代了。

**P3【缺口：零调用者】`getActiveGenerations` 全仓零调用者（含测试只断言"不抛"）。**
- 证据：`event-projection.ts:545-599`；`replay-validation.test.ts:307`；`maintenance.ts:1566` 自己承认"零生产调用者"。
- 为什么是缺口：它是"世代追踪 + 压缩取代"这套 R3-3.2 设计的一半，而另一半 `replaceGeneration` 也没人用（见 P4）。

**P4【缺口：零调用者且带写副作用】`replaceGeneration` 是**没有任何调用点、但会写事件**的函数。**
- 证据：`event-projection.ts:601-619`（内部 `getEventLog().append(sessionId, "compaction", …)`）；全仓 grep 只命中定义行 `:608`，连测试都没有。
- 为什么是缺口：一个"只读投影模块"里挂着一条**写路径**，且无人调用、无测试覆盖。它比单纯的死代码更值得点名——下一个实现"重新生成/替换某代回答"的人很可能会找到它并直接调用，从而在没有软删消息、没有闸门（`compaction-state`）、没有标记消息的情况下写出一条 `compaction` 事件，把投影与真实消息集**永久性劈开**（投影会永久隐藏那些 id，而消息行仍然是可见的）。

**P5【缺口：注释方向相反】模块头/类型头的"事件是真相之源"与实现相反。**
- 证据：`event-types.ts:5-7`、`event-log.ts:4-13`、`event-projection.ts:1-12`（"Design (对标 DeepSeek Harness projection)"）对照 `agentic-loop.ts:2854-2857` 与 `session-jsonl.ts:10-19`。
- 为什么是缺口：这不是措辞问题——它决定了读者对"投影坏了要不要紧""日志丢了能不能重建"的判断。真正的不变量是：消息可由 JSONL 重建（`session-log-bridge.ts:222`、`recovery-restore.ts:9`），事件**不可**由任何东西重建（`maintenance.ts:1223`）。

**P6【缺口：读了但没人用】`session_meta` 在投影里唯一的读取分支是 no-op。**
- 证据：`event-projection.ts:157-167`（`turn_start`/`turn_end`/`memory_update`/`session_meta`/`permission_*`/`error`/`abort` → `break`）。
- 为什么是缺口：`session_meta` 的两个生产写方之一（`recordSessionFeedback`，`feedback.ts:78`）与另一个零调用写方（`selectPresetForSession`，`preset-discovery.ts:323`）写进去的东西，在投影这条读路上**被读到但什么都不产生**；而它真正的两个读函数（`listSessionFeedback`、`getSessionPreset`）都零调用者（见第 4、5 节）。也就是 `session_meta` 今天是一条"只写不读"的通道。

**P7【缺口：注释声称的消费者与实现不符】`maintenance.ts` 说 `runtime-invariants` 读 `compaction` 事件。**
- 注释：`maintenance.ts:1563`（"`runtime-invariants` 也读它（`abort` / `compaction` 会改变它判定的口径）"）。
- 实现：`src/core/llm/runtime-invariants.ts` 全文**没有** `compaction` / `abort` 字样（已通读 229 行）；它只按 `user_message` / `assistant_text` / `assistant_reasoning` / `tool_call` / `tool_result` 过滤事件（`:105-112`），机制上不会"读 compaction 的载荷"。
- 为什么是缺口：这段注释是"为什么事件表不能被投影快照替换"的论据清单之一（`maintenance.ts:1549-1589`），论据里混了一条与实现不符的消费者。**注意**：这条论据的**结论仍然成立**——若真接上快照压缩，旧事件被删后 `runtime-invariants` 会把仍可见的旧消息报成 `VISIBLE_BUT_NOT_RECORDED`（`:129-141`），只是机制是"间接误报"，而不是注释说的"它会读 compaction 事件"。

---

## 4. 反馈（feedback）

### 4.1 对账表

| 通道/环节 | 写方（文件:行号） | 读方（文件:行号） | 生产调用者是否存在 | 测试 |
|---|---|---|---|---|
| 会话级反馈 `/feedback` 命令 | `src/App.tsx:2701-2735`（`/feedback` 分支 `:2702`，调用 `:2715-2716`） | —（UI 只回一条系统消息 `:2717-2724`） | 存在（写方） | **未找到证据**（无 `/feedback` 命令本身的用例） |
| 会话级反馈落库（事件） | `src/core/llm/feedback.ts:72-82`（`session_meta` + `action:"feedback_record"`） | `src/core/llm/feedback.ts:88-101`（`listSessionFeedback`） | **读方不存在**（全仓调用点只有 `dsh-integration-full.test.ts:249-251`、`functional-chain-closed-loop.test.ts:132-135`） | 同上两处 |
| 消息级反馈（赞/踩）UI | `src/components/FeedbackButtons.tsx:32-36` ← 挂载点 `src/components/MessageBubble.tsx:981-983`（`SlotBridge name="app.message-feedback"`）；槽位声明 `src/core/slots/declare-slots.ts:103`；注册 `src/core/ui-plugins/ui-panels/index.ts:115` | 同文件 `:21`、`:26-30`（读内存态 + `loadFeedback`） | 存在 | `src/test/core-guidance-pause-resume.test.ts:415-426`、`core-message-chain-storage.test.ts:675-684` |
| 消息级反馈写入 | `src/store.ts:872-920`（`setFeedback` → `putMessageFeedback`）；`src/core/llm/feedback.ts:222-348`（域写 `message_feedback`，`:306-341`） | `src/core/llm/feedback.ts:417-419`、`:509-520` | 存在 | `src/test/domain-mirror.test.ts:1657-1741`、`persist-domain-fixes.test.ts:650-660`、`task-y-feedback-cache-telemetry.test.ts` |
| 消息级反馈读取（历史消息的赞/踩） | — | `src/store.ts:922-931` ← `src/core/storage/message.ts:2926`（`loadFeedback`，域镜像）← `FeedbackButtons.tsx:26-30` | 存在 | `src/test/message-port-coverage.test.ts:186-200`、`feature-wire-tail-fixes.test.ts:677-720` |
| 遗留写路径 `feedback.set`（5 列） | `src/core/storage/message.ts:2886-2905`（`saveFeedback`） | 无（`store.setFeedback` 已不再调它，`store.ts:874-891`） | **不存在**（生产零调用者） | `feature-wire-tail-fixes.test.ts:683`、`core-worktree-notebook-impact.test.ts:577`、`message-session-event-fix.test.ts:394` |
| 第二套反馈服务 `uiMessageFeedback`（内存 Map） | `src/core/provider/ui-message-feedback-provider.ts:13-55` | —— **无** | **不存在** | 未找到证据 |
| `MessageActions` 里的赞/踩按钮 | `src/components/MessageActions.tsx:53-70` | —— **无渲染点**（全仓无 `<MessageActions`） | **不存在** | 未找到证据 |

### 4.2 `session_meta` 通道的现实状态（直接回答）

- **生产写方只有一个**：`recordSessionFeedback`（`feedback.ts:78`，由 `App.tsx:2716` 调用）。另一个写方 `selectPresetForSession`（`preset-discovery.ts:323`）零调用者。
- **生产读方一个都没有**：`listSessionFeedback`（`feedback.ts:88`）零生产调用者；`getSessionPreset`（`preset-discovery.ts:333`）零生产调用者；投影里对应的 `case "session_meta"` 是 no-op（`event-projection.ts:160`）；历史上那个读 `session_meta` 的"会话级指令"分支已被删除并留证（`src/core/project/files.ts:204-232`，删它的三条理由写在注释里）。
- 维护侧刻意不裁它（`maintenance.ts:1506-1510`、`:1552-1560`），并**如实写着**"今天没有任何生产读取者"。也就是：`session_meta` 是一条**只写不读**的通道，而项目已经知道这件事。
- **UI 展示：没有。** 全仓 `.tsx` 里搜"反馈"的命中里，只有 `App.tsx:2708`、`:2720`、`:2729` 三条是**该命令本身的回执文本**；其余命中都与本功能无关（`MessageActions.tsx:4` 的注释、`PlanApprovalCard.tsx:5` 的"填写反馈"、`SettingsPanel.tsx:417` 的"即时反馈"、`SkillManager.tsx:87/263` 的删除反馈等）。**没有任何面板/列表展示 `feedback_record`**（`FeedbackButtons` 是消息级赞/踩，与会话级反馈无关）。

### 4.3 问题清单

**B1【缺口：只有写方没有读方】会话级 `/feedback` 的读路径不存在于产品中。**
- 证据：写 `App.tsx:2716` → `feedback.ts:78`；读函数 `feedback.ts:88-101` 的调用点只有测试（`dsh-integration-full.test.ts:249-251`、`functional-chain-closed-loop.test.ts:132-135`）。
- 为什么是缺口而不是设计：命令回执**自己**说"当前没有任何自动流程读取它 —— 它只是留档"（`App.tsx:2720-2721`）。作者是诚实的，但功能上"反馈"这个名字承诺的"能被看到/被用上"两件事都没有实现：既没有展示入口，也没有任何自动流程消费它（没有喂给提示词、没有进遥测、没有导出）。**它是一条只写不读的存档。**

**B2【缺口：假成功】`/feedback` 无条件显示"✅ 反馈已留档"，即使事件根本没落库。**
- 证据：`recordSessionFeedback` 返回 `void` 且不检查 `append` 的返回值（`feedback.ts:72-82`）；`EventLog.append` 在端口未接手/未就绪时**不抛**，而是返回 `seq: 0` 并走上报通道（`event-log.ts:207-229`）；`App.tsx:2714-2724` 的 `try/catch` 只可能在 `text` 为空（`feedback.ts:74-76` 抛 `TypeError`）时进 catch。
- 为什么是缺口：这违反本项目反复强调的"不许静默假成功"（对照 `session.ts:517-519`、`feedback.ts:259-264` 对同类问题的处置）。今天有 `reportPersistFailure` 横幅兜底（`event-log.ts:220-224`），但用户眼前那条 ✅ 是**不成立的**。

**B3【缺口：第二套死实现 + 文案与真实注册点不符】`uiMessageFeedback` 服务零读方。**
- 证据：`ui-message-feedback-provider.ts:13-55`（内存 `Map` + listeners，`record/get/getAll/subscribe`），全仓无 `ctx.get('uiMessageFeedback')`；而真实的消息反馈 UI 由**另一个插件**注册（`src/core/ui-plugins/ui-panels/index.ts:115` 注册 `app.message-feedback`，`MessageBubble.tsx:982` 消费）。
- 与文案冲突：`plugin-registry-provider.ts:185` 声称 "@codem/ui-message-feedback — 消息反馈组件，点赞/点踩/评论 … 关闭后消息反馈 UI 不可用"（`uiImpact.panels:["message-feedback"]`，会被 `PluginManager.tsx:239-243` 渲染给用户看）。实际关掉它，赞/踩**完全不受影响**（走的是 ui-panels）；反过来它的 `record()` 也永远不会被 UI 调用。
- 为什么是缺口：这既是"死实现"，也是**用户可见的错误承诺**（还会污染插件依赖图：`dependency-graph.ts:275-292` 从这里算 UI 影响面）。

**B4【缺口：遗留第二写者】`MessageStorage.saveFeedback`（5 列 `feedback.set`）零生产调用者，但仍是一个可被误用的写路径，且要别人给它擦屁股。**
- 证据：实现 `message.ts:2886-2905`；生产调用者零（`store.ts:874-891` 明确说明"收敛成单一写者"，只留域写 9 列）；它污染 `feedbackCache` 的问题由 `putMessageFeedback`/`deleteMessageFeedback` 事后 `invalidateFeedbackCache` 补救（`feedback.ts:323-332`、`:498-503`，测试 FWT-D9a/b）。
- 为什么是缺口：一个"5 列 INSERT 会抹掉 9 列域写"的旧实现保留在存储层，靠另一处的缓存失效来兜（`message.ts:2850-2872` 自己也承认这套缓存是历史包袱）。它今天不产生用户可见故障，但它是"同一个事实两个写者"的活样本。

**B5【缺口：零渲染点】UI 里的第二套赞/踩按钮永远不会出现。**
- 证据：`MessageActions.tsx:53-70`（`onFeedback` 才渲染）；全仓无 `<MessageActions`（`MessageBubble.tsx:28` 只有 import）；无测试渲染它。
- 判定：与第 1 节第 4 条同源（同一组件里的"分支对话"按钮）。按本节口径记一次，不重复计数。

---

## 5. 预设（presets）

仓里有**三套互不相干、都叫 preset** 的东西，必须分开对账：

### 5.1 对账表

| 子系统/环节 | 写方/来源（文件:行号） | 读方（文件:行号） | 生产调用者是否存在 | 测试 |
|---|---|---|---|---|
| A. agent 预设**目录发现** | 来源 `preset-discovery.ts:299-314`（`~/.agent-presets` = user、`{appDir}/presets` = shipped）；扫描 `:215-288` | `src/core/agent/agent.ts:95-127`（`loadPresets` → `AgentRegistry.agents`，构造函数 `:88` 触发）→ UI `ChatPanel.tsx:813`（`getAgentRegistry().getPrimary()` → `AgentPanel`）、`AgentManager.tsx:104,137`、`SquatsTab.tsx:40`、`PromptDebugger.tsx:12` | **存在** | **零测试**（见 R3） |
| A'. agent 预设的**会话级挂载** | 写 `preset-discovery.ts:322-327`（`selectPresetForSession` → `session_meta{preset_selected}`） | 读 `preset-discovery.ts:333-345`（`getSessionPreset`） | **两侧都不存在**（全仓仅定义 + `maintenance.ts:1553-1555` 的注释） | **零测试** |
| B. **配置预设**服务（安全模式批设） | 内置 `preset-provider.ts:55-68`（strict_security / development / relaxed）+ 用户预设 settings 键 `user-presets`（`:106`、`:126-135`） | 服务接口 `preset-provider.ts:116-190`（`load/save/delete/list/apply/getActivePreset`） | **不存在**（全仓无 `ctx.get('preset')`；`src/components/**` 里除了头像 preset、权限 preset 之外**没有配置预设入口**） | `src/test/settings-dead-keys.test.ts:346-379`（直接驱动 provider） |
| C. **UI agent 预设面板**服务 | 内存 `Map` `ui-agent-preset-provider.ts:24-50` | —— **无** | **不存在** | `src/test/permission-presets-view.test.ts` 只覆盖**权限**预设，未覆盖它 |

### 5.2 问题清单

**R1【缺口：写了没人读，且两侧都零调用者】会话级 preset 挂载完全没接线。**
- 证据：`selectPresetForSession`（`preset-discovery.ts:322-327`）与 `getSessionPreset`（`:333-345`）在全仓（**含测试**）除定义外零命中（`maintenance.ts:1553-1555` 也这么记着）。
- 为什么是缺口而不是设计：`preset-discovery.ts:18-21` 把"per-session 挂载 + 通过 `session_meta` 事件记录"写成这个模块的**功能之一**；而这条链上**写方和读方都没人调**，所以它连"只写不读"都算不上，是"两端皆空"。同时它也是 `session_meta` 通道里唯一另一类载荷（第 4.2 节）。

**R2【缺口：内置预设源永远不生效】`getDefaultRoots()` 的生产调用不传 `appDir`。**
- 证据：`getDefaultRoots(appDir?: string)`（`preset-discovery.ts:299-314`）里 shipped 根是 `roots.push({ path: `${appDir}/presets`, trust: "shipped" })`（`:309-311`）；唯一生产调用是 `agent.ts:98` 的 `getDefaultRoots()`（**无参**）。
- 补充证据：仓库里没有任何 shipped 预设目录——全仓 `agent.cordis.yml` 只存在于参考目录（`.deepseek-harness-ref/`、`.dsh-desktop-ref/`、`.eac-ref/` 各若干），`src/`、`public/`、`src-tauri/` 下都没有。
- 为什么是缺口：函数参数与代码路径明明写着"应用内置预设目录"是这个能力的第二来源（注释 `:295-297` 也把它列为优先级第 2），生产调用把它整个丢掉了——这是"实现里有、接线时漏了"的形态，而不是"产品不做内置预设"的声明。

**R3【缺口：注释声称有测试，实际零测试】`preset-discovery` 没有任何用例。**
- 证据：`src/test/dsh-integration-full.test.ts:16` 的头部清单写着 "B9: preset-discovery (预设发现)"，但该文件里**没有任何** preset 相关用例（grep `preset` 仅命中该注释行）；全仓 grep `discoverPresets` / `preset-discovery` 只命中实现与 `agent.ts`、以及两份**别处**的注释（`snapshot-compaction.test.ts:10`、`database-maintenance-bounds.test.ts:11`，都是"谁在 `readAll`"的历史清单）。
- 为什么是缺口：模块有 345 行、有自己的 YAML 子解析器（`:77-146`）、有信任级别与排序语义、有一个 fire-and-forget 的失败上报路径（`agent.ts:117-126`），却没有一条判据。特别地，`:309-311` 那个 shipped 根（R2）正是因为零测试才没人发现它没被传参。

**R4【缺口：服务无消费者 + 文案承诺】配置预设服务 `preset` 没有生产读取方。**
- 证据：`preset-provider.ts:116-190` 提供完整 API；全仓无 `ctx.get('preset')`（grep 零命中），`src/components/**` 里没有配置预设入口（grep `preset` 仅命中权限预设选择器 `InputArea.tsx:1523-1525`、`PermissionPresetSelector.tsx` 与头像预设 `SettingsPanel.tsx:1550`）。
- 与文案冲突：`plugin-registry-provider.ts:67` 对用户展示 "Preset Provider — **配置预设管理，批量设置加载/保存**"。
- 为什么是缺口：`apply()` 写入的键是**有真实读取方**的（`codem-security-mode` ← `security-mode.ts` 的 `getGlobalSecurityMode`，测试 `settings-dead-keys.test.ts:362-378` 专门守着这一点），也就是说这个服务"写得对、写得有用"，只是**没有任何 UI 能触发它**。测试在测一个没有生产调用者的实现。

**R5【缺口：用户可见的假承诺】`ui-agent-preset` 声明了一个不存在的面板。**
- 证据：`plugin-registry-provider.ts:166`（`provides:['uiAgentPreset']`，`uiImpact.panels:["agent-preset"]`，`degradedTo:'Agent 预设面板不可用'`）；`PluginManager.tsx:239-243` 会把 `panels` 渲染给用户；实现侧 `src/core/provider/ui-agent-preset-provider.ts:53-84` 只 `ctx.provide('uiAgentPreset', …)`，全仓无 `ctx.get('uiAgentPreset')`，也没有名为 `agent-preset` 的槽位/面板（`slots/declare-slots.ts` 里没有，注册表 `ui-plugins/index.ts` 里也没有）。
- 为什么是缺口：用户会在插件管理里读到"关闭后 Agent 预设面板不可用"，但那个面板从来不存在。这与本项目在别处对 `uiImpact` 的谨慎形成反差（例如同一文件里 UI 面板类插件都给了真实的 `slots` 名）。

---

## 总结

**5 个功能里，2 个的主链路算"完整接线"（fork、消息级反馈），4 个有明确缺口（上下文压缩、事件投影、会话级/插件侧反馈、预设）。**

**完整接线（写方→读方→生产调用者→测试都齐）**：
- **会话分叉（fork）的主路径**：UI 按钮（`ChatPanel.tsx:1021`）→ 下标换算（`fork-index.ts:65`）→ `store.forkSession`（`store.ts:285`）→ 会话行带 `parent_id`（`session.ts:480`）→ 消息/工具调用/附件 id 换新复制（`message.ts:1292`）→ 读方 `session_trace`（`session-search.ts:361-401`）；测试覆盖充分（含真实 store 路径 `feature-context-fixes.test.ts:485-720` 与谱系回归 `session-lineage-preserved.test.ts`）。
- **消息级反馈（赞/踩）**：`MessageBubble.tsx:982` → `FeedbackButtons.tsx:35` → `store.ts:872` → `feedback.ts:222`（9 列域写）；读回 `FeedbackButtons.tsx:26` → `store.ts:922` → `message.ts:2926`。写读两侧都有生产调用者与用例。

**有明确缺口的（4 个功能，共 24 条）**：
- **会话分叉：2 条**（F1 `EventLog.forkSession` 是完整实现但零生产调用者、却被两个测试文件驱动；F2 分叉复制来的历史工具轮在事件侧没有事件，会被生产路径上的不变量审计报成 `VISIBLE_BUT_NOT_RECORDED`）。另有 1 条**文档漂移**（F3：`fork.test.ts:28-32` 与 `encoding-toolcalls.test.ts:42-47` 声称用例仍红/真机丢工具调用，而最新全量运行两者皆绿）与 1 条与反馈共享的死组件（F4/B5：`MessageActions` 零渲染点）。也就是说：**fork 的主链路是完整接线的，缺口都在周边**。
- **上下文压缩：6 条**（C1 `/compact` 是声明式死链且插件文案承诺可用；C2 引擎侧快照压缩能力完整但零生产调用者；C3 压缩边界检查函数只被测试驱动；C4 `ContextMonitor` 注释把 `listMessages` 的行为说反；C5 压缩事件写失败只 `console.warn` 的静默失败；第 6 条是 2.2 里如实回答的能力缺失——**被压缩的历史在产品里没有任何读路径**。C6 见 2.3 末尾，明确不计入缺口）。
  - 说明：压缩的**主路径本身是接线的**（触发 `agentic-loop.ts:1290`/`:2174` → 实现 `:3202-3433` → 事件 `:3417` → 消费 `surface-manager.ts:48`/`maintenance.ts:1254`），缺口集中在"周边能力未接线 / 注释不实 / 失败不可见 / 历史读不回"。
- **事件投影：7 条**（P1 `deriveMessagesFromEvents` 注释宣称被 `buildMessages` 使用而实现已移除且零调用者；P2 `projectIncremental` 零生产调用者；P3 `getActiveGenerations` 零调用者；P4 `replaceGeneration` 零调用者且带写副作用；P5 模块/类型头"事件是真相之源"与实现相反；P6 `session_meta` 的唯一读取分支是 no-op；P7 `maintenance.ts:1563` 声称 `runtime-invariants` 读 compaction 事件而实现里没有这条读）。**注意**：投影本身并非全死——`projectSurface`（进系统提示词）与 `validateReplay`（进维护自检）两条是活的，但它们都不承载"消息的权威"，投影的自我描述（"primary function used by buildMessages"）才是最大的假陈述。
- **反馈：4 条**（B1 会话级 `/feedback` 只有写方、无任何读方/展示入口；B2 `/feedback` 回执无条件报"✅ 已留档"而事件可能根本没落库；B3 `uiMessageFeedback` 死服务 + 插件文案与真实 UI 注册点不符；B4 遗留 5 列写路径 `saveFeedback` 零生产调用者、仍需别人为它清缓存）。`session_meta` 通道的现实状态：**只写不读**（唯一生产写方 `feedback.ts:78`，零生产读方，投影里是 no-op）。
- **预设：5 条**（R1 会话级挂载写读两侧皆零调用者；R2 内置预设根因生产调用不传 `appDir` 而永不生效；R3 `preset-discovery` 零测试而测试文件头声称覆盖它；R4 配置预设服务零消费者而文案承诺有管理 UI；R5 `ui-agent-preset` 声明了不存在的面板）。唯一活的是"目录发现 → AgentRegistry → Agent 列表/面板"这条链，而它恰恰是零测试覆盖的那一段。

**一句话结论**：按"写方—读方—生产调用者"三件套对账，**只有 fork 主链路与消息级赞/踩是完整接线的**；**上下文压缩、事件投影、反馈（会话级与插件侧）、预设四个功能都有明确缺口**（24 条，其中"能力已实现但零生产调用者"这一类有 10 处：`EventLog.forkSession`、`compactWithSnapshot`/`session_snapshot`、`isCompactionBoundarySafe`+`findSafeCompactionBoundary`、`projectIncremental`、`getActiveGenerations`、`replaceGeneration`、`selectPresetForSession`+`getSessionPreset`、`saveFeedback`、`uiMessageFeedback`、`commandCompact`），另有 3 条是**用户可见的假承诺**（`/compact` 可用、消息反馈 UI 由该插件提供、Agent 预设面板存在）与 3 条**注释与实现相反**（`deriveMessagesFromEvents` 的消费者、`listMessages` 是否带回压缩历史、`runtime-invariants` 是否读 compaction 事件）。

**未找到证据的地方（不猜）**：
- 注释里引用的真机统计（`event-types.ts:37` "生产库 3112 条事件里 `session_snapshot` 0 条"）未复核——本次未访问真机库。
- Rust 侧 `repo.rs::events_compact` 的实际 SQL 与 `compact_requires_real_anchor_and_removes_old_events` 用例未打开核对，本报告只把它作为"注释引用引擎"记录。
- `/feedback` 命令本身没有专门用例；`replaceGeneration`、`uiMessageFeedback`、`MessageActions`、`/compact` 四条路径**全仓零测试**。
