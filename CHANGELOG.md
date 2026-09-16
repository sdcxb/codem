# Changelog

All notable changes to Codem will be documented in this file.

## [1.16.43] - 2026-09-15 — 架构级：让"权威日志"真的权威（写入顺序 / 索引自愈 / 存储压力）（第 91 波）

用户追问"内存访问越界出现很多次了，**数据库有问题吗？** 别只掩盖表象，实在不行升级架构"。
先把"是不是数据库坏了"回答清楚，再动手。

### 一、结论：**数据库文件没坏，坏的是分层名不副实**

这个项目的存储分层是第 78 波定下的：**追加日志（每会话一个 JSONL）= 权威存储，
SQLite = 可重建的查询索引**。这句话写在注释里、也写进了 CHANGELOG，但代码里：

1. **写入顺序是反的**（最致命）。`createMessage` 是
   `getDatabase()` → INSERT/UPDATE × N → `persistDatabase()` → **最后**才 `appendSessionMessage()`。
   索引一出问题（WASM 陷阱 / 致命闩锁 / SQL 报错）**第一行就抛掉，权威日志那一步根本没执行** ——
   号称最权威的那份副本，被挂在最脆弱路径的最后一道。用户那 113 条消息的危险就来自这里。
2. **读路径也挂在索引上**：`listMessagesFromIndex` 直接 `getDatabase()`，索引一崩连历史都读不出来
   （而日志里明明什么都在）。
3. **索引重建方向从未实现**：只有"索引 → 日志"的回填（`backfillAllSessions`），
   没有"日志 → 索引"。崩了只能重启撞运气、而且重建会因外键失败（`messages.session_id → sessions(id)`）。
4. **存储压力没有上限**：`saveMessages` 每次把**整份消息列表**逐条写（长会话下上百条 UPDATE +
   每条工具调用先删后插）；`saveDatabase` 每次 `db.export()` **整库**
   （单次 O(库大小) 的 WASM 分配 + 复制）—— 这就是"内存访问越界"最现实的触发点。

**所以：不需要"换掉数据库"，需要的是让索引真的可丢。**

### 二、本轮改动

- **写入顺序翻过来（权威优先）**：`createMessage` / `updateMessage` 现在**先把完整记录追加进 JSONL**，
  再尽力更新索引；索引失败只上报（走第 87 波的统一通道），**不再让调用方失败、更不会丢消息**。
  更新路径的快照来源优先用日志镜像/索引现存消息，索引不可用时也不影响落盘。
- **读路径不再被索引拖死**：`listMessagesFromIndex` 索引不可用时返回空表，
  `listMessages` 用权威日志合并出完整历史（另加一次性的可见告警）。
- **实现索引自愈**：新增 `rebuildIndexFromSessionLogs()`（幂等，含工具调用重建；
  会先补齐缺失的 `sessions` 行，避免外键失败）+ **崩溃标记**：
  致命闩锁时写一个**不依赖数据库**的标记文件（`codem-index-rebuild-needed.json`），
  下次启动维护时先"从权威日志重建索引"再回填/裁剪，成功后删除标记。
  于是"数据库崩了"从"重启后索引空空如也"变成"重启后自动重建，消息一条不少"。
- **存储压力上界**：`saveMessages` 改为**只写变化过的消息**（内容指纹：长度 + 首尾采样 + 字符码累加，
  比一次 SQL 写入便宜两个数量级；长会话下跳过的是绝大多数）；`saveDatabase` 加**整库导出硬上限**
  （256 MB），超限即暂停整库落盘并明确提示，改为"只写权威日志 + 下次启动重建索引"——
  宁可暂时不落盘索引，也不把 WASM 堆撞死。

### 三、验证

- 新增 `authority-first-storage.test.ts` **AR-1~7**：索引致命时 create/update **照样进权威日志**、
  历史**照样读得出来**、**索引可从日志重建**（含工具调用）、崩溃留标记且维护路径真的消费它
  （含"先重建再回填"的顺序契约）、`saveMessages` 首轮写 40 条 / 二轮 0 条 / 改一条只写一条、
  整库导出上限存在且超限停写。
- 全量 **256 文件 / 5007 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 0 error / 0 warn、
  css-contract 2745 个类无变化、`npm run audit` 三类门禁全绿。
- 真机（打包版本）：手工放置崩溃标记后重启，维护日志出现"从权威日志重建索引"、标记被消费（详见发布说明）。

### 四、仍然建议做的（架构升级项，等你拍板）

本轮把"索引可丢"做成了真的；**崩溃本身**（WASM 堆压力）只是被**限幅**（不再整库导出、
不再全量重写），没有根除。要根除有两条路，代价不同：

1. **把 SQLite 移出渲染进程**（Rust 侧 `rusqlite`/sqlx）：渲染进程不再持有 WASM 堆，
   写入变成增量 SQL over IPC —— 这是最彻底的方案；代价是**本仓库 200+ 处同步 DB 调用要改成异步**
   （工程量最大，但方向最正）。
2. **保持 sql.js，但彻底不做整库导出**：把持久化改成"JSONL 权威 + 定期/退出时导出索引"，
   索引即使长时间不落盘也能重建（本轮已具备重建能力）。代价小、收益大，是①的过渡形态。

我的建议：**先走②**（本轮已铺好地基），把索引落盘频率降到"分钟级/退出时"，观察是否还会触发；
若仍触发，再评估①。

## [1.16.42] - 2026-09-15 — 用户现场：数据库 WASM 崩溃后**没有人发现**（错误刷屏、抢救流程从未执行）（第 90 波）

用户跑"生成 2．主要研究内容 文档"这类长会话时，控制台开始刷同一条错误：

```
[Store] saveMessages failed: RuntimeError: memory access out of bounds
[EventLogFinalize] Failed to write tool events (non-critical): RuntimeError: memory access out of bounds
[loadFeedback] Failed: RuntimeError: memory access out of bounds
[Telemetry] Flush failed, keeping events for retry: RuntimeError: memory access out of bounds   ← 还带层层嵌套的 setTimeout
```

同一条错误出现几十次，而且**没有任何提示告诉用户"数据库已经死了"**。

### 根因（三个，都在同一个断点上）

1. **不认识这类错误**：`isFatalDbError()` 的名单里只有 `out of memory` / `malformed database schema` /
   `bad parameter…`；WASM 陷阱（`memory access out of bounds`、`RuntimeError: unreachable`、
   `Cannot enlarge memory`、`null function or function signature mismatch`、`table index is out of bounds`）
   **一条都不在** → 致命状态从未闩锁。
2. **抢救流程从未执行**：`codem:db-fatal` 从未派发 → App 里那段"把当前会话写成 JSON 抢救到磁盘 +
   提示用户重启"的处理函数（一直存在）**根本没跑**。那一刻会话的 113 条消息只存在于内存里，
   用户只看到日志刷屏。
3. **无限重试 + 刷屏**：查询路径（`saveMessages` / `EventLog.append` / `loadFeedback` / 遥测 flush）
   各自 `catch` 一下就过去了，**每次都往已经崩掉的 WASM 堆上再撞一次**；遥测还会无限重排定时器。

### 修复

- `isFatalDbError()` 补齐 WASM 陷阱家族（并保持保守：`UNIQUE constraint failed` / `no such column` /
  `FOREIGN KEY constraint failed` 等普通错误**不**判致命，避免误触发抢救）。
- 新增 `DatabaseFatalError`（可读中文说明 + "请重启应用"）+ `noteDatabaseError()`（查询路径的统一上报入口）
  + `installFatalGuard()`：**装在 `db.exec/run/prepare` 上**，任何 WASM 陷阱就地闩锁并派发 `codem:db-fatal`；
  闩锁后再调用**直接抛错、不再进入底层**（止血：既不再刷屏，也不白烧 CPU）。
- 调用点改为致命状态下跳过 + **一次性**上报（第 87 波建的统一失败通道）：
  `store.saveMessages`（原来每几秒一条）、遥测 `flush`（原来无限重排定时器）、
  `EventLogFinalize`（原来每次工具调用一条）、`loadFeedback`、`recovery.multiLayer` 的定时写。
- 用户可见：数据库一崩，界面就会出现一条可执行说明（"已停止写入 + 当前会话已抢救到 <路径>，
  请关闭并重新打开应用"），不再是一屏谁也看不懂的 WASM 报错。

### 验证

- 新增 `db-fatal-cascade.test.ts` **DBF-1~7**：致命错误识别（含 7 种 WASM/内存/Schema 文案）、
  普通错误不误判、查询路径上报即闩锁且**事件只派发一次**、闩锁后 `getDatabase()` 抛可读错误、
  `exec/run` 上的护栏"第一次进入底层、之后不再进入"、`saveMessages` 只上报一次、
  遥测致命状态下不再重排定时器。撤掉修复（去掉 WASM 文案）**6 条立刻变红**。
- 全量 **255 文件 / 5000 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 0 error / 0 warn、
  css-contract 2745 个类无变化、`npm run audit` 三类门禁全绿。

## [1.16.41] - 2026-09-15 — C 类（守卫被绕过）也成了门禁；三类问题现在全部机器把关（第 89 波）

A 类（静默空写）与 B 类（假成功）在第 88 波已经是测试门禁，但 C 类（**安全阀自己失效时往哪边倒**）
还只有手工 grep。这一轮补齐，并当场修掉门禁抓出的问题。

### 一、新门禁：`tools/audit/scan-guard-bypass.mjs`

三类判据（只报可证明的结构，不猜语义）：

- **C1 fail-open 返回**：`catch` 里返回放行语义（`true` / `"allow"` / `{ allowed: true }` /
  `{ action: "allow" }` / `proceed`）。只报**无条件**放行，或"有放行返回但整块没有任何拒绝路径"的；
  形如 `if (hook.allowOnError) { … return allow } return deny…` 这种**显式选择的** fail-open 开关
  只记为"需人工确认"的信息项（不当缺陷）。
- **C2 守卫调用被吞**：`catch` 里调用了守卫/权限类函数（`analyzeBashCommand` / `isAutoApprovable` /
  `checkPermission` / `modeGate` / `getEffectiveSecurityMode` / `isProtectedPath` /
  `isPathWithinWorkspace` / `isSandboxAclEnabled` / `PlanModeGuard` / `SandboxGuard` / `shouldFireHook` …）
  而块内既没有 `throw`、也没有拒绝路径、也没有走统一失败上报 —— 判定失败被静默忽略。
- **C3 审批缺省放行**：**空 catch** 且紧邻 `"ask"` 审批判断（前 25 行内）或位于权限/守卫语义的函数里。

调优过程本身也留了记录：第一版把 `mode` / `allow` 放进函数名匹配，于是 `getMode`、
`saveCustomModels`（"Model" 含 "mode"）被误报 —— 收紧为
`permission|approve|guard|security|sandbox|consent|deny|hook`；C3 也从"整个函数体里出现过 ask"
收紧为"catch 前 25 行内出现 ask"（否则三五百行的大函数里出现一次 `"ask"` 会把无关的 `catch {}` 全拖进来）。

### 二、门禁当场抓出的问题（已修）

- `AgentRegistry.loadPresets`：预设发现失败原来只写一行 warn，构造函数里更是 `.catch(() => {})` 全吞 ——
  用户放在 preset 目录里的 `agent.cordis.yml` **静默不生效**（只在"我的自定义智能体怎么不见了"里体现）。
  现在走统一失败上报（`agentRegistry.loadPresets`）。
- 两处豁免写进了 `allowlist.json` 的 `guardBypass`（都附理由）：`isCodeGraphEnabled()` 与设置面板里同名
  的"读不到设置时按默认开启"——它们是**读取开关**的函数，不是守门人，真正的门禁在
  `AgenticLoop` / `HookManager` / 权限层。

### 三、门禁套件现状

| 门禁 | 扫描对象 | 违规数 |
|---|---|---|
| A 类 `scan-silent-write.mjs` | `db.run(UPDATE … WHERE id = ?)` 未走 `runGuarded` | **0** |
| B 类 `scan-false-success.mjs` | catch 里 `return true`；写/动作类函数的 catch 只有日志 | **0**（4 条豁免均写明理由） |
| C 类 `scan-guard-bypass.mjs` | fail-open 返回、守卫调用被吞、审批缺省放行 | **0**（2 条豁免均写明理由） |

- `npm run audit` 一次跑完三类；`audit:silent-write` / `audit:false-success` / `audit:guard-bypass` /
  `audit:json` 可单独用。
- `src/test/audit-gates.test.ts` 扩到 **GATE-1~5**（含 GATE-3"豁免必须写理由"、GATE-5 C 类零未豁免），
  自检样本也扩到三类（catch 里 `return true` + 只有日志的 catch + 未接 `runGuarded` 的 UPDATE +
  守卫失败 `return { action: 'allow' }`）—— 门禁本身必须会咬。

### 四、验证

全量 **254 文件 / 4993 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 0 error / 0 warn、
css-contract 2745 个类无变化；`npm run audit` 三类扫描全部 exit 0。

## [1.16.40] - 2026-09-15 — 两个审计扫描器变成**测试门禁**；门禁上线当场又抓出 15 处 A 类（第 88 波）

第 86/87 波的扫描器是一次性脚本 —— 结论会随时间失效：新写的代码可以再次引入同样的模式。
这一轮把它们做成**每次跑测试都会执行的门禁**，并且上线当天就证明了价值。

### 一、门禁落地

- `tools/audit/scan-false-success.mjs`（B 类）：P1 = `catch` 里 `return true`/`success:true`；
  P2 = 写/动作类函数的 `catch` **只有日志**。匹配前**先剥注释**（本仓库注释里就写着这些模式，
  不剥会把文档当代码报出来 —— 上一版的一处误报正是这么来的）。
- `tools/audit/scan-silent-write.mjs`（A 类）：`db.run(UPDATE … WHERE id = ?)` 未走 `runGuarded`。
  `DELETE` 只列出不计违规（"删一个不存在的行"是正常语义），避免训练出"看什么都像 bug"的噪声。
- `tools/audit/allowlist.json`：豁免必须写在清单里**并写明理由**（由 GATE-3 断言强制，
  不允许无理由豁免；新增条目要在 CHANGELOG 说明为什么安全）。
- `src/test/audit-gates.test.ts`：**GATE-1~4** —— 两条扫描零未豁免命中、豁免必须写理由、
  以及**扫描器自检**（用临时样本证明它真的会报警，避免"门禁永远绿"这种更隐蔽的失效）。
- `npm run audit` / `audit:false-success` / `audit:silent-write` / `audit:json`
  （`npm run verify` 之外单独可用；测试套件里也已经是强制项）。

### 二、门禁上线当场抓出 15 处此前漏掉的 A 类

原因是**引用风格**：旧 grep 只认模板串（`` db.run(`UPDATE …`) ``），而项目里还有一批
`db.run("UPDATE …")`。改成兼容三种引号后，立刻扫出 **15 处**未接 `runGuarded` 的按 id 更新：

- `storage/message.ts` ×7：`hidden = 1`（**墓碑路径** —— 正是 v1.16.33「假压缩」事故的观测点）、
  `generated_files` / `retrieved_sources`（create 与 update 两条路径）、`content = content || ?`（追加）、
  `attachments` 外置写回；
- `knowledge/storage.ts` ×3：`graph_nodes` 的 community_id / weight / source_ids+chunk_ids；
- `squad/squad-storage.ts` ×2：归档、成员角色；
- `accounts` 激活 ×2（auth/storage、storage/account）；
- `sessions` 排序（`sort_order`）。

全部接入探测器（影响 0 行时记账 + 告警一次，行为不变）。**这一步让"墓碑写了 0 行"这类事故
从"只能靠旁证推断"变成"运行期直接响"**。

### 三、门禁还当场抓出 1 处 B 类

`LLMEngine.setupSubagentSpawner` 里 `SubagentRuntime` 初始化失败原来只有一行 warn ——
后果是 subagent/委派能力整体不可用、依赖它的插件停在 PENDING，而用户只看到"某些功能不见了"。
现在走统一失败上报（`llmEngine.subagentRuntimeInit`）。

### 四、验证

- 全量 **254 文件 / 4992 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 0 error / 0 warn、
  css-contract 2745 个类无变化；`npm run audit` 两类扫描均 exit 0（A 类未接 runGuarded = 0）。
- 门禁自检（GATE-4）实测会咬：故意写坏的样本（catch 里 `return true` + 只有日志的 catch +
  未接 `runGuarded` 的 `UPDATE`）全部被报出。

## [1.16.39] - 2026-09-15 — B 类机器扫描（31 → 2）+「沙箱模式」开关真的接线（第 87 波）

按三类问题继续延伸审计，这一轮做的是**机器扫描 + 接线校验**，不是抽查。

### 一、B 类（假成功）机器扫描：31 处 → 2 处

写了扫描器（`.preview-shot/scan-false-success-87.mjs`，两级判据，只报"可证明"的）：
- **P1**：`catch` 块里直接 `return true` / `success: true`（吞异常报成功）；
- **P2**：`catch` 块**只有日志**，且所在函数名属于写/动作类（update/save/create/delete/set/send/
  write/apply/install/enable/disable/commit/run/start/stop/retry/cancel/persist/register/add/remove/clear/reset/import/export）。

结果：**31 处 P2**（P1 的 3 处复核后全是误报：`isCodeGraphEnabled` 的"读不到设置时默认开"是既有语义，
不是动作假成功）。这 31 处包括：
`updateSession` / `deleteProject` / `updateProject` / `createProject`（写库失败 → store 照常更新）、
`createWorktree`（创建失败静默回退主工作区 —— 用户以为在隔离分支里改代码）、
`removeWorktree`、`createDelegationTask` / `deleteDelegationTask` / `clearCompletedDelegations`、
`recovery.save` / `multiLayer.saveState` / `multiLayer.saveSessions`、
`permission.saveCustomRules`（**安全相关**：用户以为加的拒绝规则生效了）、`settings.saveFile`（导出其实没写）、
`costTracker.setLimits`、`modelProfile.save`、`mcp.saveConfigs`、`mcp.setCodeGraphEnabled`、
`sessionRecovery.clearSnapshot`、`storage.deleteQuickPhrase`、`syncEngine.autoSync`、
`worktree.setExecutionMode`、`noteManager.deleteNoteLinksBySource`、`message.setMessageReasoning`、
`saveFeedback`、`libraryOps.persistSettings` / `persistLayoutOverrides`、`retry.setConfig`、
`delegationTools.agentTeams` / `delegationTools.computerUse`（工具注册失败 = 模型根本没这些工具）、
`uiPlugins.load`（界面区域凭空消失）。

新增统一上报通道 `src/core/storage/persist-failure.ts`：
**error 级日志 + 按区域计数 + 窗口事件**（`codem:persist-failed`，带 `kind: persist|action`），
App 侧转成**一次性可见提示**（同一区域不重复弹，避免磁盘满时刷屏）：
落盘失败说"重启后会丢失"，动作失败说"该功能本次没有生效"。**不改控制流**（这些是高频 UI 路径，
抛错会打断交互），但从此不再静默。

扫描器复跑：**P2 = 2**（`persist-failure.ts` 自己的文档注释、`createSession` 里"读会话数失败就用内存计数"
这一处**读**操作）—— 两者都是误报，等价于扫干净了。

### 二、「🔒 沙箱模式」开关以前是装饰品

事实：设置面板早就有"🔒 沙箱模式（限制写入范围到工作目录）"的勾选框（写 `codem-sandbox-enabled`），
文案承诺"AI 只能在当前工作目录及其子目录中写入文件"；而 `AgenticLoop` 传给工具管线的
`isSandboxEnabled` 是**硬编码 `() => false`** —— 用户打开开关、界面显示已开启，
`SandboxGuard` 从未启用，模型照样写工作区外的文件。

修复：`sandbox-acl.ts` 导出 `SANDBOX_SETTING_KEY` / `isSandboxAclEnabled()` / `setSandboxAclEnabled()`
（与面板同一个键），`AgenticLoop` 改为跟随设置；面板改用统一入口 + 独立 state（原来勾选后不重渲染，
要重开面板才看到状态）+ 写入失败弹提示；启动日志按真实状态说明"已启用/未启用 + 生效的是哪些防线"。

### 三、验证

- 新增 `persist-failure-reporting.test.ts` **PF-1~4**（含"关键路径必须接线"的契约断言）、
  `sandbox-wiring-87.test.ts` **SBW-1~5**（含"面板不得再裸写该键"、"AgenticLoop 不得硬编码 false"、
  以及真实管线行为：开关打开后工作区外写入被拒、关闭时放行）。
- 全量 **253 文件 / 4988 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 0 error / 0 warn、
  css-contract 2745 个类无变化、全量跑完零 `[WriteGuard]` 空写告警。
- 真机（打包版本）抽验见下一条目的说明（启动日志、沙箱开关可勾选且落库、无新增控制台报错）。

## [1.16.38] - 2026-09-15 — 延伸审计（A 类）：剩余 10 处"按 id 更新"接入静默空写探测器（第 86 波续）

按同一套三类问题继续扫（"有问题不论是新旧都修"），这次针对 **A 类：静默空写**做机器扫描：
`db.run(\`UPDATE … WHERE id = ?\`)` 全项目还有哪些没走 `runGuarded`。结果是 **10 处**（分布在 6 个存储模块）：

- `auth/storage.ts` → `updateAccount`
- `knowledge/storage.ts` → `updateNotebook` / `updateSource` / `updateNote` / `updateGroup` / `updateGraphNode`
- `knowledge/flashcard-store.ts` → `updateFlashcard`
- `squad/squad-storage.ts` → `updateSquad`
- `storage/account.ts` → `updateAccount`
- `storage/project.ts` → `updateProject`

这些写入全部是"目标行应该存在"的 UPDATE。改动只有一件事：**接入探测器**（`runGuarded`），
影响 0 行时记一笔并告警一次（行为不变、不改控制流）。另外这 10 个函数里都有
`if (fields.length === 0) return;` 的**空更新静默返回** —— 调用方以为"更新成功"、实际一个字段都没写，
现在同样会写一条带函数名的告警（例如 `updateNote 调用未提供任何可更新字段`）。

**有意不动**的两处 DELETE（`agent_profiles.delete(id)`、`turn_file_changes.deleteBySession`）：
"删一个本来就不存在的行"是正常语义，不该被当成空写告警。

### 验证

- 全量 **251 文件 / 4979 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 0 error / 0 warn、
  css-contract 2745 个类无变化；**全量跑完零 `[WriteGuard]` 空写告警**（说明这次接入后，
  被测试覆盖的所有更新路径都真的写到了行 —— 没有新的隐藏空写）。

## [1.16.37] - 2026-09-15 — 把"看起来有、实际没有"的服务面修成真的（第 86 波）

继续上一轮列出的未修项。这一批的共同特征是：**服务/接口存在、文档承诺了能力，底层却没有实现**
（调用即报错、或更糟：返回值看起来成功）。

### 插件服务面

- **`ctx.get('hooks')` 是个空壳** —— `hooks-provider` 把它暴露成有
  `register` / `unregister` / `executeHooks` / `listHooks` / `clearAllHooks` 的服务，
  并声称"第三方插件通过 `ctx.hooks.register()` 注册自定义钩子"、"ToolPipeline 会调用
  `ctx.hooks.executeHooks(...)`"—— 而 `HookManager` **根本没有这四个方法**（只有基于 settings
  的配置钩子）。后果：任何插件调用立即 TypeError；`clearAllHooks()` 是空函数（注释还写着
  "Map 会自动回收"，但那个 manager 一直被 service 引用着），禁用插件不会清掉任何钩子。
  现在 `HookManager` 补齐**运行时钩子**（内存、按事件、带超时）并接进 Pre/PostToolUse 执行链：
  返回 `{action:"deny"|"modify"}` 真的能拦下/改参数，写错 action 名字按 fail-closed 拦下，
  返回 `undefined` 视为"没有意见"；`hooks-provider` 改为直接转发真实方法。
- **`uiJobs.cancelJob` / `retryJob` 在 automation 服务缺失时 `return true`** —— 调用方以为
  "已取消/已重试"，实际什么都没发生。现在明确抛错。
- **`uiGoal.setGoal` 在 driver 缺失时凭空造一个目标对象返回** —— 调用方以为目标已建立并持久化，
  实际没有任何地方存过它（下一次 `getGoals()` 仍是空）。现在明确抛错。
- **`sessionCheckpoint.saveCheckpoint` 返回 void** —— 调用方没在 state 里带 `id` 时，这个检查点
  永远无法被 `restore(sessionId, id)` 取回。现在缺 id 自动生成并返回；并把"检查点是**进程内**的、
  重启后不保留"写进文档与一次性日志（此前文案容易让人以为启用后崩溃也能回滚）。
- **`schedule.addReminder` 到点但没有任何通知通道时静默丢弃** —— 用户永远收不到提醒且无告警。
  现在明确告警；`addRecurring(0)` 会创建"能多快就多快"的紧循环定时器（打满主线程），现在直接拒绝。
- **`computer.setMode` 写库失败不报** —— 设置界面显示"已切换"，重启后模式又变回去。
  现在返回写入结果并在失败时弹提示（顺带去掉同一值的重复写入）。

### 工具与循环

- **`browser_automate` 从不读 MCP 的 `result.isError`** —— Playwright 报错（选择器找不到等）
  会被当成普通文本成功返回；且单个动作失败只在下文里写一行 "ERROR -"，整次调用仍是成功。
  现在 `isError` 会被转成异常，任一动作失败即整次调用标记失败并给出 `n/m 个动作失败`。
- **`github_tool` 的漏洞扫描会把"扫描没做成"报成"没有漏洞"** —— GraphQL 报错 / 响应缺少
  `data.repository`（token 缺 `security_events` 权限、仓库不存在、Dependabot 未开启）时，
  原来一律走到 "✅ No open vulnerability alerts"。现在区分并明确说明"这不代表没有漏洞"。
- **AgenticLoop 关闭"反应式压缩"后上下文溢出是静默终止** —— 既无文本也无事件，用户只看到
  "助手突然不说话了"。现在与"压缩次数用尽"走同一套可见路径（说明 + `context_overflow` 停止原因）。
- **工具管线的 `SandboxGuard` 恒为关闭却没人说明** —— `isSandboxEnabled: () => false` 属于既有
  产品取舍（默认拦工作区外写入会打断很多合法流程），但接线读起来像"沙箱开着"。
  现在进程内提醒一次，写清"生效的是工具级受保护路径 + 权限层"。

### 技能安装

- **`installSkill` 会静默跳过文件却仍返回 `success: true`** —— 路径不安全 / 扩展名不在白名单 /
  文件过大 / 超出单技能上限的文件只写一行 `console.warn`，技能可能只装了一半（SKILL.md 装上了、
  脚本没装上）。现在跳过项随结果返回（`skipped` / `warning`），**全部被跳过即判为安装失败**。

### 验证

- 新增 `provider-honesty-86.test.ts` **HK2-1~11**（逐条覆盖上面每个服务面；撤掉修复必红验过三处：
  `clearAllHooks` 恢复为空函数、`uiJobs` 恢复返回 true、`addRecurring` 去掉校验）；
  全量 **251 文件 / 4979 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 **0 error / 0 warn**、
  css-contract 2745 个类无变化、全量跑完零 `[WriteGuard]` 空写告警。

## [1.16.36] - 2026-09-15 — 「全修」：上一轮审计列出的**每一处**都修掉（第 85 波）

用户要求：「全修！然后再审计。我们的目标是消灭所有问题。」
于是把 v1.16.35 里逐条列出的"仍存在未修的"**全部**修掉，每条都先复核原文、再修、再补一条
**会红的**回归用例（撤掉修复必红），最后按同一套三类问题（静默空写 / 假成功 / 守卫被绕过）
重新跑一遍全量审计。

### 类别一：守卫被绕过 / 缺省放行（安全阀形同虚设）

- **hooks 的退出码从来没被读**（`hook-manager.ts`）—— 只解析 stdout，`exit 1` / `exit 7` 的守卫钩子
  等于什么都没做（用户以为能拦、实际全放行）。现在：退出码 2 → 拦下；其它非 0 / 超时 / 抛错
  → **默认拦下（fail-closed）**，仅当钩子显式 `allowOnError: true` 才放行；声明了 `MODIFY:` 但 JSON
  非法、或函数钩子返回未识别的 action、或 `modify` 却没给 `modifiedInput` → 一律拦下（原来静默放行）。
- **`exit_plan_mode` 审批通过后并没有真的切模式** —— 工具宣称 "You are now in Default mode"，
  而 UI 只 `resolve({approved:true})`：计划模式仍在，同一回合里所有写操作继续被 `PlanModeGuard` 拦下。
  现在批准 = 真的切（`handleModeChange` 同时改 UI 状态与**正在运行的 loop**），并把切换结果如实回报给
  工具（失败/未确认时不再宣称已进入 Default 模式）。模式切换也统一走同一个入口（手动切换同样立即生效）。
- **`SecurityScanMiddleware` 是空的** —— 匹配到明文凭据后直接 `proceed`，注释却写着"在 post-execute 追加"，
  而根本没有那个实现。现在真正记录（工具名 + 模式名，不放回显）；
  面向用户的提示仍由 `streaming-executor` 的 `scanParametersForSecrets` 追加。
- **`grepSearch` 把"搜索失败"当成"没有匹配"** —— 路径不存在时 `Get-ChildItem -ErrorAction SilentlyContinue`
  吞掉错误、管道成功、stdout 为空 → `lsp` 工具给出**假否定**（"No definition found"）。
  现在路径不存在或命令非零退出都抛明确错误。

### 类别二：假成功（失败被当成成功）

- **工具把失败写成文本，状态却永远是 `completed`** —— 本仓库 100+ 处失败路径写 `output: "Error: ..."`，
  而 `ToolRegistry.execute` 与 `AgenticLoop` 的内联 handler 都无条件标完成：界面显示绿色成功、
  交付物判定把"报错的写操作"算成"写下来了"。
  新增 `llm/tool-result-status.ts`：显式 `isError` 优先、**内容型工具（read/grep/web_fetch…）不推断**、
  其余按首行失败前缀判定；`errorSource: "tool"` 让执行器区分"工具自报失败"（模型可自行纠正，不累加
  `consecutiveErrors`）与"执行层异常"（权限拒绝/守卫拦截仍按原路径抛错）。顺带修好 `metadata` 被丢弃
  （`subagentId` 到不了上层，后台子智能体的 settlement 登记因此失效）。
- **MCP 的"连上了"是假的** —— stdio 传输连 `initialize` 都不发就写 `connected`；`tools/list` 的任何异常
  都被吞成 `[]`；`autoDetectCodeGraph` 无脑返回 true。现在：连接 = 握手成功 + 工具清单真的是数组，
  失败时 `status: "error"` + 原因，`autoDetectCodeGraph` 只在真的连上时返回 true；
  `isCodeGraphInstalled` 改看退出码（原来只看 stderr 里有没有 "not recognized"）。
- **agent-teams 三处永久卡死** —— ①重启零对账：`working` 成员让 `kick()` 永远跳过、`reassigning` 任务让
  `nextReadyTask`/`claimTask` 永远拒绝、带 attemptId 的 claimed 任务指向已不存在的执行 → 现在重启即对账
  （逐条写清原因 + 状态告警，`status` 工具会列出来）。②转派给普通成员后任务永久停在静默期（只有
  captain 分支会 `finishReassign`）→ 现在两种目标都结束静默，开不出新领取时也会清掉标记并报出原因。
  ③先 `claimTask` 再唤醒 = 幽灵占用 → 现在**先确认成员子会话存在**再领取，不存在就标离线并给出
  "重新添加成员 / 转派给队长"的可执行建议。
- **可持续子智能体没有阀门** —— ①缺空闲看门狗（LLM 流挂死就永远 running；而且子智能体的 scoped loop
  不进 loopPool，`abortSession` 找不到它 → 连中断的句柄都没有）→ 新增看门狗 + `scopedLoopPool` 让中断真的
  生效；②缺轮次预算（可无限唤醒、无限烧 token）→ 用尽后 followup 明确报错；③续聊轮被中止/判挂死时
  仍结算成 `completed` → 现在如实标 `cancelled` 并写明原因。
- **`generate_ppt` 汇报"要求的页数"而不是实际页数** —— 模型只产出 5 页时工具宣称"8 页演示文稿已生成"。
  现在按 `deck.slides.length` 汇报，并在不一致时说明差异。
- **`ask_clarification` 在没有交互通道时假装"用户未回答"** —— 问题根本没送达用户，模型却以为问过了。
  现在明确报错并让模型改用普通文本提问；有通道但用户没作答时也写明"不要自行假设"。
- **`read_attachment` 的偏移被应用了两次** —— 走磁盘分页读取时 `att.content` 已是窗口内容，接着又按
  char offset 二次切分：实际起点约为请求值的 2 倍，且头部把窗口长度写成"文件总长"。
  现在窗口路径不再二次切分，并明确标注"按行读取的近似窗口、前后都可能有内容"。
- **`load_skill` 工具加载失败只写 console** —— 模型照着技能正文去调用不存在的工具。现在把失败写进工具结果。
- **`terminal_send run_in_background` 在写入失败时照样回"已启动"** —— 现在按 job 实际状态汇报（error 即报错）。
- **笔记图谱部分批次失败看不出来** —— `extractKnowledgeGraph` 某批失败只 `console.error`，返回的图谱看起来
  是完整的。现在返回 `warnings`（超过 60 个分块的截断也如实说明），界面标注"图谱不完整"。
- **`memory` / `heartbeat` / `store.createSession` 的乐观返回** —— 记忆写库失败会静默丢失、心跳配置写失败
  看不见、会话创建写失败后仍把该会话设为当前会话（重启后整段对话消失）。
  现在写入结果可查、界面当场提示、会话持久化失败会发事件让 App 弹出可执行说明。

### 类别三：静默空写 / 静默无效

- **`FileChangeStorage.updateStatus` 写 0 行没有任何痕迹** → 接入 `runGuarded`，并让 `revert()` 检查行数。
- **`IssueStorage.update` 空更新照样"成功"** —— 调用方继续加"状态已变更"系统评论并通知。现在返回真实行数，
  0 行时跳过评论与通知。
- **`addNoteLink` 的 `INSERT OR IGNORE` 被忽略时仍按"已创建"计数** → 返回是否真的插入。
- **`generateSourceSummary` 四处静默 return**（来源不存在 / 无分块 / 未配置 API Key / 模型返回空）
  → 全部改为写明原因并返回布尔值（"摘要卡片永远空着"从此可诊断）。
- **`idle-tracker` 的 0 语义反了** —— 传 0 本意是"关闭看门狗"，实际 `expired()` 恒为 true（立刻超时）。
  现在 `<= 0` = 不设上限（与 `session/idle-watchdog.ts` 对齐）。
- **`micro-compact` 的"已压缩过"闸门语义错误** —— 只要列表里出现过占位符就整体跳过，之后新积累的工具结果
  再也不会被压。改为让 `microCompact` 自己判断（它本来就是幂等的）。
- **`retry.ts` 的"总超时"只统计 sleep** —— 请求本身的耗时不计入，重试总墙钟可以远超预算。
  现在按真实墙钟核算，并在"下一次等待就会超预算"时直接抛出最后的错误。
- **沙箱 ACL 的黑名单在 Windows 上几乎全部失效** —— 条目不规范化（`C:\Windows` 进正则变成 `^C:\W…`）、
  `~/.ssh` 从不展开（死规则）、前缀匹配误伤 `.environment.ts`。现在条目与输入同一套规范化（含 `~` 展开）、
  正确的 glob 语义 + 尾部边界；顺带把 `checkPath` 的判定与测试补齐（正/反斜杠、真实主目录、任意深度）。

### 验证方式

- 新增回归用例（**撤掉修复必红**，逐条验过；8 个文件 **68 条**）：`hook-fail-closed` HK-1~12、
  `exit-plan-mode-switch` EPM-1~8、`tool-result-status` TRS-1~12、`agent-teams-restart` TEAMR-1~9、
  `mcp-connection-honesty` MCP-H1~6、`subagent-turn-valves` SUBV-1~5、`sandbox-glob-hardening` SBX-1~8、
  `honest-contracts-84` HC-1~8。
- 真机（打包版本）冒烟：exe 版本号 1.16.36、应用正常启动（DB 加载 / 引擎配置 / 技能与宠物加载 / 数据库维护均正常）、
  经 IPC 实测 `path_exists` 对不存在/存在的路径分别返回 false/true（grepSearch 的"路径不存在即报错"依赖这一原语）；
  冒烟后数据库已用备份恢复、探针文件已清理。
- 全量 **250 文件 / 4968 用例通过 / 15 跳过**、`tsc --noEmit` 0 错、UI 审计 27 条规则 **0 error / 0 warn**、
  css-contract 2745 个类无变化；全量跑完**零 `[WriteGuard]` 空写告警**。

## [1.16.35] - 2026-09-15 — 按「问题类型」全项目延伸审计：又抓到 11 处同类缺陷（第 84 波）

用户要求：「审计一下还有没有类似的潜在问题，尤其是任务管理链路；有问题不论是新旧都修复，然后按问题类型做延伸审计，直到没有问题为止。」
于是按**三类问题**（静默空写 / 假成功 / 守卫被绕过）做了全项目审计（三路只读审计 + 本地代码复核），
下面每一条都**先复核原文**再修，且都补了会红的回归用例。

### 类别一：静默空写（写了不存在的行，无报错无日志）

1. **`deleteMessagesAfter` 是唯一不写墓碑的删除路径**（编辑并重发会用到它）—— 用户"编辑并重发"后，
   被删的旧回复会在下一次 `listMessages` 合并时**从权威日志复活**，而函数仍返回"删了 N 条"。
   修复：与其它删除路径对齐（写墓碑 + 清内存镜像）。
2. **新增静默空写探测器**（`src/core/storage/write-guard.ts`）：任何 id 定向的写操作只要
   影响 0 行就记账 + 告警一次（按"表+操作"去重，不刷屏），并暴露 `getSilentWriteReport()`。
   已接入 message / session / delegation / issue / inbox / squad / goal / agent-profile / file-change
   共 9 个存储模块。**兜底不变量**：`SWG-5` 断言"跑完一整轮后台执行不允许出现任何静默空写"。
3. **三个存储模块从不 `persistDatabase()`**（issues / squads / inbox 的大部分写入 +
   agent-profile / file-change）—— 写入只留在内存，**强杀进程即丢数据**。已补齐落盘。

### 类别二：假成功 / 永久卡住（对外报成功但实际没发生）

4. **委派链的四个"不执行"分支只打日志不写失败**（`App.tsx`）：目标会话正在执行 / 引擎未就绪 /
   抛异常 —— 任务在 `delegate()` 里已是 running，于是**永久停在"执行中"**，父会话干等。
   修复：全部走 `failHonestly()` 如实写回失败与原因。
5. **`executeSessionTurn` 重复执行保护只返回 success:false 不通知编排器** → 同样永久 running。已修。
6. **被中止的回合对调用方报成功**（取消后没有 `end` 事件 → 三处失败分支全跳过 → `success: true`）
   → 微信/手机桥收到"处理完成（无文本输出）"。修复：中止路径如实返回失败 + 落 system 说明。
7. **重启后被中断的委派任务只 warn、不置失败**（注释宣称 interrupted，状态机里根本没这个状态）
   → 永远 running，并且继续占并发额度（攒够 5 条后**任何新委派都被拒绝**）。修复：如实置失败并写清原因。
8. **`agent-teams` 唤醒成员的 `followup` 参数位置全错**（3 参 vs 签名 4 参 `(parentSessionId, childId, message, options)`）
   → `childId` 变成正文 → **每次都抛错并被 catch 吞掉**，成员永远收不到任务/消息，任务永远 pending，
   而工具文案写着"消息已投递/调度器将唤醒成员"。修复：用 `team.captainSessionId` 传对参数 + 失败必须打日志。
9. **`squad_dispatch` 的 `spawnFailures` 只声明、只 push、从不读取** → 成员根本没起来，
   文案照样"成员已按角色就绪"。修复：如实报出失败成员与已就绪成员，并提示先补齐 provider。
10. **子智能体中断后父会话永久阻塞**：abort 分支提前 `return`，跳过 `executionResolver()`/`poke.resolve()`
    → settlement watcher 永不推进 → 父循环 `await Promise.race(...)` **永久卡住**（无超时）。
    修复：中止走统一收尾（并如实把该轮标为 cancelled）。
11. **子智能体自报失败被当成"已完成"**：`parseTaskResult` 解析出的 failed/blocked 被丢弃、
    `stopReason` 硬编码 `'completed'` → 父会话收到"已完成"通知拿半成品继续。修复：按自报状态结算。
12. **笔记 `[[WikiLink]]` 保存后必被删空**：删除旧链接被排进**微任务**，必然排在同步插入之后
    → 反向链接面板永远是空的（函数却返回"创建了 N 条"）。修复：改为同步删除（删旧在前、插新在后）。
13. **`list_sessions` 用一个永远为空的 Set 判"执行中"** → 模型永远看不到"执行中"状态，
    会把任务委派给正在跑的会话（随后被拒、任务卡死）。修复：接真实执行态。

### 类别三：守卫被"分类/缺省分支"绕过（本次已修两处，延伸审计又抓到三处）

14. **停滞守卫的"交付物"判定把"可能写"的命令（python/node/npm/git…）当成真的写了** →
    "用脚本当读手段"的会话每轮清零停滞计数，停滞守卫形同虚设。
    修复：新增 `src/core/llm/artifact-tracker.ts` 分级判定 —— 可证明的写算交付物；
    "可能写"的命令在同一条反复出现（默认 3 次）后不再算推进；只读查询永不计算（含 `git status`）。
15. **重复守卫的"写后宽容"可被幂等写无限重新武装**（每轮 `mkdir` 一个已存在的目录即可）→
    零增益判据永不成立。修复：同一（签名+结果）组合只宽容 3 次；同一条幂等写重复出现不再清空证据。
16. **PowerShell 危险命令整段跳过分析**（平台默认 shell 就是 PowerShell！）→
    "替我审批"模式下 `Remove-Item -Recurse -Force …` / `Invoke-Expression …` **被自动放行**。
    修复：PowerShell 侧危险/只读清单 + `isAutoApprovable` 改为先问分析器（旧 unix 清单留兜底，异常一律 fail-closed）。
17. **计划模式（只读契约）的写名单里没有 shell** → 计划模式下 `Set-Content …` 照样执行。
    修复：按命令意图判定，非只读一律拒绝并说明。
18. **权限层 `ask` 但没有审批回调时默认放行**（落到 `return { allowed: true }`）→
    "ask"模式在没接回调的调用方那里**等于 full**。修复：fail-closed + 明确原因。
19. **`echo x > file` 被判成只读**（重定向没算写）→ 自动放行/计划模式放行。修复：有输出重定向即非只读。

### 验证

- 新增/加强用例：`silent-write-guard.test.ts`（SWG-1~6，含系统级不变量）、`artifact-tracker`（STALL-10~12）、
  `loop-guard.test.ts` GUARD-20（幂等写重新武装）、`note-links-order.test.ts`（NL-1~2，**修复前必红**）、
  `powershell-danger-gate.test.ts`（17 条：危险必须拦、只读不许误判）、
  `plan-mode-readonly-gate.test.ts`（PLAN-1~5）、`delegated-turn-persistence.test.ts` EXEC-1~3 + DELE-X1~2。
- **审计仪器**：全量用例跑完**没有任何 `[WriteGuard] 空写` 告警**（说明被测路径没有空写）。
- 全量 **242 文件 / 4900 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 27 条规则 0/0 · css-contract 无变化。

### 仍然存在、这版没修的问题（如实列出，附证据位置）

按严重度（都已复核，不是猜测）：

- **`phone-link` 先回 202 再干活，且失败只进 console**（`core/phone-link/phone-link.ts`）：手机端会看到
  "已发送、处理中"然后永远没有回复；非法 sessionId 也是这样。需要把回合结果写回对端。
- **`wechat-bridge` 出站失败被吞**（`core/wechat-bridge/wechat-bridge.ts`）：`ilink_send_text` 的
  Err/`partial` 不回流 → 对端零回复或半截回复。
- **关闭 UI 插件其实没有卸载，却报"已关闭"**（`core/plugin-loader/plugin-manager-service.ts`）：
  只翻状态位、无 dispose，重启仍加载；需要真实卸载或如实告知"重启后生效"。
- **文件变更面板恒空**（`core/environment/file-change-tracker.ts`）：before/after 都取 `HEAD^{tree}`，
  未提交改动不改变它 → `finalize()` 恒返回 null（`turn_file_changes` 无新行、无法回滚）。
- **Hooks 的退出码从未被读取**（`core/hooks/hook-manager.ts`）：PreToolUse 钩子非零退出=放行，
  用户以为"钩子能拦"，实际拦不住。
- **`exit_plan_mode` 批准后没有真的切回默认模式**（`core/llm/tools/exit-plan-mode.ts` + `App.tsx`）：
  文案说"You are now in Default mode"，但下一轮 write 仍被过滤。
- **`ToolRegistry.execute` 把"以文本返回错误"的工具一律标成 completed**（`core/llm/tools.ts`）：
  框架级放大器，会让所有 `return { output: "Error: …" }` 的工具在 UI/事件里显示成功。
- **团队链路仍有三处未闭环**（`core/provider/agent-teams-service.ts`）：成员从 localStorage 恢复时零对账
  （working 成员永远跳过）、转派给成员后 `reassigning` 永为 true、`claimTask` 先于唤醒写入。
- **子智能体没有空闲/预算上限**（`core/subagent/runtime.ts`）：对照后台回合的两道看门狗，子智能体只有 abort 检查。
- **若干乐观返回**：`memory.ts`/`core/store.ts`/`heartbeat.ts` 的落库失败只 warn 而 UI 报成功；
  `knowledge/importer.ts` 的 `indexSource` 吞异常仍计"已导入"。

## [1.16.34] - 2026-09-15 — 跨会话委派：b 会话原地打转、a 会话干等（第 83 波续）

### 用户现场

「a 对话把当前情况交给 b 对话，让 b 建立认知后继续同一主题」——a 侧正常（总结落文件），
**b 侧卡住**：控制台反复刷

```
[AgenticLoop] Single-response dedup: 1 tool calls in this response: [bash("python \"…\_tmp_extract.py\"")]
[AgenticLoop] Tool executed: bash, path: python "…\_tmp_extract.py", output length: 358     ← 每次都是 358
[SessionJSONL] 更新消息 assistant-1789451758233-2 时找不到所属会话，日志未更新（索引仍是最新）
```

同一个脚本跑了几十遍、a 一直等不到反馈，最后 a 自己结束了。

### 根因①（主因）：后台执行的**第 2 轮之后整轮历史都写不进库**

`executeSessionTurn`（委派/后台执行走这条路，**不碰 React store**）在 `start`（iteration > 1）里
**只换了 `currentAssistantMsgId`、没有建行**，而之后所有事件用的都是"更新"：

```ts
MessageStorage.updateMessage(currentAssistantMsgId, { content });      // UPDATE … WHERE id=? → 影响 0 行
MessageStorage.addToolCall(currentAssistantMsgId, { … });              // tool_calls 挂在一条不存在的消息上
```

于是第 2 轮起的**正文、工具调用、工具结果全部丢失**（权威日志同步时也查不到所属会话 —— 就是那行刷屏告警）。
而 `AgenticLoop` **每轮都从库里重建上下文**（`buildMessages` → `listMessages`）：
模型看不到自己上一轮发出过什么调用、拿到了什么结果 → **一遍遍重发同一个工具调用** → 死循环。
（用户交互路径 App.tsx 没这个问题：那边每轮 `saveMessages` 会把消息 upsert 进库。）

**修复**：抽出 `ensureAssistantMessage()` —— 任何需要写"当前助手消息"的地方（delta / 工具开始 / 工具完成 /
工具报错 / 新一轮）都先确保**这一行真实存在**。顺带修掉同一类的第二种丢法：
模型「一句话不说直接调工具」时 `currentAssistantMsgId` 还是空的，以前 `if (tc && currentAssistantMsgId)`
直接跳过 → 调用与结果凭空消失（同一个死循环）。

### 根因②：重复调用守卫给解释器命令发了"永久免死金牌"

用户现场的命令是 `python _tmp_extract.py`，而 `python` 在守卫的 `MUTATE_CMDS`（会改盘）清单里 →
`inspect()` 判定 "mutate" 后**直接 return allow**，把零增益判定整段短路：

- 每轮都清空"零信息增益"证据（世界可能变了）；
- 结果相同也无所谓 → 守卫一次都没拦。

第 62 波那次的现场是 `Get-ChildItem`（枚举类）所以拦住了；这次换成"用脚本当读手段"就绕过去了。
**修复**：把清单拆成

- `MUTATE_CMDS`（**可证明**会写：Set-Content/Remove-Item/重定向/新建/复制…）→ 仍然清零证据并放行；
- `SPECULATIVE_MUTATE_CMDS`（**可能**写：python/node/npm/git/cargo/docker/curl/start-process…）→
  **不清零、也不短路**，必须靠"结果是否真的变了"证明进展（`bashIntent` 增加 `provable` 字段，
  `kind` 保持 `mutate` 不变，其它调用方不受影响）；
- 另外把"写操作之后宽容一次"的豁免留给**紧随其后的那次重看**，而不是被写操作自己的结果消耗掉
  （`noteResult` 里 `isProvableMutation` 判定）。

### 验证

- `delegated-turn-persistence.test.ts` EXEC-1~3：两轮脚本化引擎跑 `executeSessionTurn`，
  断言第 2 轮的助手消息/正文/工具调用/工具结果都在库里、`tool_calls` 不挂在幽灵消息上、
  「不说话直接调工具」也不丢。**先证明用例会红**：撤掉修复后 EXEC-1 失败
  （实际 id 只剩 `assistant-…`、`err-…`）。
- `loop-guard.test.ts` GUARD-17~19：复刻用户现场（同一脚本、输出恒为 358）**必须在有限次内被停**
  （真实执行次数 ≤ 8，用户现场是几十次不停）；产出真在变时照常放行（不许误杀长任务）；
  可证明的写操作才清零证据（GUARD-5 的语义不许丢）。
- 全量 **238 文件 / 4864 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 27 条规则 0/0 · css-contract 无变化

## [1.16.33] - 2026-09-15 — 上下文压缩是**假压缩**：删了 840 条，上下文一条没少（第 83 波）

### 用户现场（控制台日志，v1.16.32 真机）

```
Iteration 1: API error 400 … requested 1050027 tokens
[compactMessages] Removed 840 old messages, kept 20, inserted LLM compaction marker (summary length: 2803)
Iteration 2: … requested 1051664 tokens          ← 比上一轮**还多**
[compactMessages] Removed 841 old messages, kept 20 …
Iteration 3: … requested 1051741 tokens
Iteration 4: … requested 1051655 tokens
```

压缩每轮都"移除 840 条"，请求却始终 ~105 万 token，迭代 1→2→3→4 一路白烧 LLM 摘要，
最后硬停"请开启新对话"——**一整场长会话就此报废**。

### 根因①（致命）：压缩的删除被**权威日志合并**复活

`doCompactMessages` 走 `deleteMessagesByIds`，而它只做索引侧的软删除：

```ts
db.run("UPDATE messages SET hidden = 1 WHERE id = ?", [id]);   // 只有索引，没有日志
```

而读路径（第 79 波把合并收进 `listMessages` 的那次改动）是：

```
listMessages = 索引(WHERE hidden = 0)  ∪  追加日志（权威，按 id 后写者胜）
```

日志里**根本没有 hidden 语义**（删除只写了索引）→ 被"移除"的消息被日志**整批加回来，而且不带 hidden** →
压缩声称删了 840 条，下一次读又回来 840 条 → 上下文一点没小 → 循环 1→2→3→4。

**复现（用例先红后绿）**：30 条消息，软删除 25 条 → `listMessages` 仍返回 **30** 条、其中带 hidden 的 **0** 条。

**修复**（与既有删除路径对齐，`deleteMessage`/`deleteMessagesBefore` 早就这么做了）：

- `deleteMessagesByIds` 除了标记索引，还**逐条写权威日志墓碑**（后写者胜），并**同步剔除内存镜像**
  （镜像不刷新，本进程内照样复活）；
- 墓碑写入纳入 `flushSessionLogWrites()` 的在途集合（原来墓碑没登记，"删完立刻 flush 再读"会读到旧内容）；
- 读路径加**两道防御**：日志记录带 deleted/hidden 一律不进读集合；**索引里的 hidden 集合也参与判定**
  —— 这样**老版本已经踩坑的会话**（索引 hidden=1、日志里没有墓碑）也能立刻恢复。

### 根因②：压缩只看条数、不看体积（"保留最近 20 条"能自己顶满窗口）

用户现场里 `kept 20` 之后请求仍 ~105 万 token —— 因为那 20 条本身就可能很大（一条大文件读取、
一段大粘贴）。固定条数的压缩**永远压不进窗口**，只能反复重试。

**修复**：抽出 `src/core/llm/compaction-budget.ts`（纯逻辑 + 独立用例），压缩时：
估算保留集 token（窗口的一半为预算，另一半留给系统提示/工具/输出）→ 超预算就**成半收缩**
（仍对齐轮次边界，避免出现"没有 tool_use 的 tool_result"）→ 直到进预算或触到下限（4 条）；
连下限都装不下时**明确判定 overBudget**：直接顶满连压计数，让循环立刻给出"开新对话/改用附件"的
可执行结论，而不是再白烧两次摘要调用。

### 验证（真机 + 用例，两侧都有数据）

**真机（打包版本 v1.16.33，同一现场：10 条大消息 ≈ 100 万 token，窗口 1M）**：

```
修复前（v1.16.32）：[AgenticLoop] Too many consecutive compactions, forcing stop
                   —— 没有任何 [compactMessages] 日志（messagesToRemove = 0，压缩空转）
修复后（v1.16.33）：[compactMessages] 保留集按体积收缩：11 → 5 条（估算 199976 tokens，预算 500000，窗口 1000000）
                   [compactMessages] Removed 6 old messages, kept 5, inserted LLM compaction marker
                   → 本轮正常回复结束；库内 6 条 hidden=1、权威日志写入 6 条墓碑、压缩标记就位
```

**用例**：`compaction-budget.test.ts` CB-1~12（预算规划成半收缩/下限/恶意对齐不死循环、
轮次边界对齐、压缩后读路径只剩保留集、**模拟重启后仍不复活**、老版本现场恢复、
硬删除可复活而软删除不许复活、复刻用户的"保留集自身超预算"链条并打印实测 token）、
`compact-resurrect-repro.test.ts` REPRO-1~2（先红后绿的复现）。
全量 **237 文件 / 4858 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 27 条规则 0/0 · css-contract 无变化

## [1.16.32] - 2026-09-15 — 用户报的「推理强度点不动」+ 发布后自查的同源一致性（第 82 波）

### 用户报的 bug（先修这个）：主对话区域顶部的模型列表里，点「推理强度」闪烁、选不中

**复现与测量**（打包版本 + CDP 真实鼠标事件，不是看代码猜的）：

```
点开模型下拉 → 在 (494,242) 按「推理强度」行：
  pointerdown / mousedown 命中 → new-chat-page        ← 浮层不见了
  mouseup                 命中 → chat-effort-row      ← 松手又回来了
  期间 DOM **零变更**（MutationObserver 全程无记录）
```

**根因**：全局按压反馈给通用可点元素加了几何 transform ——

```css
button:not(:disabled):active, .clickable:active, [role="button"]:active { transform: scale(0.97); }
button:active, [role="button"]:active, summary:active, .sp-btn:active { transform: translateY(var(--press-shift)); }
```

而聊天栏顶部的模型下拉正是 `<div class="model-selector" role="button">` **内部**渲染 `.model-picker`
（推理强度行同理：`.chat-effort-row[role=button]` 内部渲染 `.chat-effort-menu`）。
按住时 `:active` 的 transform **创建层叠上下文** → 浮层的 `z-index: 1300` 退化成"局部"的 →
整个浮层被后面的兄弟节点（`.chat-body` / 空态页）盖住：

- **视觉**：按下的一瞬间浮层被盖住 = 用户看到的"闪烁"；
- **交互**：`mousedown` 命中浮层、`mouseup` 命中被盖住之后的正文 → 浏览器把 `click`
  派发到两者的**共同祖先**（`.chat-panel`）→ 选项的 `onClick` 根本不执行 = "选不中"。

**修复**（治本，且让这一类问题以后自己暴露）：

- 新增宿主标记 `.press-layer-host`：**内部渲染浮层的可点元素**用它退出几何按压反馈
  （`transform` 换成背景色反馈，手感仍在、层叠不再被破坏）；
- 两条全局按压规则加 `:not(.press-layer-host)`；
- ChatPanel 的两处宿主（`.model-selector`、`.chat-effort-row`）标上该类；
- **审计门禁新增两条规则**（`tools/ui-audit/scan-ui.mjs`）：
  `press-feedback-layer-host`（CSS 侧：通用按压规则必须排除浮层宿主）
  + `press-transform-hosts-layer`（TSX 侧：用 TypeScript 编译器 API 精确遍历 JSX，
  发现"内部有浮层却没标宿主类"就报错）。**规则自检过**：去掉标记 → 报 5 + 1 条，恢复 → 0。
- 顺带排查了全项目同类结构（TS 遍历 JSX 全量扫描）：命中就是这两处，其余 5 处是误报
  （菜单项自身类名里含 menu/dropdown），已排除。

**顺带修掉的同类"点了没反应"**：`ModelSelector` 的推理强度只写存储、不进 state，
写入后不触发重渲染 → 值变了界面不动；现在进 state，点了立刻回显。

### 发布后自查：把「内置目录」的同源一致性补齐

v1.16.31 发布后回头审计自己刚写的代码，抓到三处**同源不一致**，都属于"规则对了但没接到所有地方"。

#### ① 引擎侧的注入范围漏了「配了 key 但没刷新过」的 provider（`LLMEngine.loadDynamicModels`）

`loadDynamicModels()` 原来只遍历 `codem-dynamic-models` 缓存里的键 —— 而缓存是**用户点刷新**时才写入的。
配好 key 却一次没刷新的机器上，缓存里连 `deepseek` 这个键都没有 → 目录模型一个都注入不进去：

```
界面（getMergedDynamicModels）：能看到 deepseek-v4-flash-vision-exp
引擎（provider.dynamicModels）：没有它 → 选中后按默认窗口/默认能力跑
```

**修复**：注入范围改成 缓存里的 provider ∪ `BUILTIN_MODEL_CATALOG` 里的 provider。
（`ENG-1~4` 守住：缓存为空也要注入、旧名不重复、contextWindow 迁移照旧、未注册 provider 不受影响）

#### ② 方案面板（视觉/STT/嵌入槽位）根本选不到目录模型（`ModelProfilePanel`）

它用的是 `mergeCustomModels(codem-dynamic-models 缓存)` —— **缓存里从来不含内置目录条目**
（刷新时只落服务器事实），于是"主设置里能看到、方案面板里看不到"，全看缓存里恰好有没有它。
更糟的是**内置方案的视觉槽位正指向** `deepseek-v4-flash-vision-exp`。

**修复**：改走 `getMergedDynamicModels()`（`model-catalog.ts` 注释写的就是"界面与引擎统一走这里"），
并把纯函数部分抽成 `buildAvailableProviders()` 以便用例守住（`MPS-1~4`）。

#### ③ 错误识别收得太宽：`Invalid model input` 会被当成"名字不对"

`isUnknownModelError` 原来只要含 `invalid model` 就成立 —— 而有些 provider 对**参数**问题也说
"Invalid model input"（跟名字无关），那样会把一个能用的模型标成「服务器已拒绝此名字」。

**修复**：`invalid model` 必须带 `name` / `id` / 冒号才算（`CH-1b` 守住两种措辞的分界）。

#### ④ 记录条数上限在"同一毫秒"下会丢错人（全量跑用例才暴露）

`capBucket`（单 provider 上限 80 条）只按 `at` 排序 —— 而 `at` 精度是毫秒，
**同一毫秒内写入的多条时间戳完全相同**，稳定排序下被丢掉的恰恰是**最新写的那些**（与"保留最近的"语义相反）。
单跑该文件时不复现、全量跑时复现。修复：先按写入顺序反转，再按 `at` 降序稳定排序，
时间戳打平时保留的就是最近写入的；用例连跑 5 次稳定。

### 验证（v1.16.32）

- 真机（打包版本 + CDP 真实鼠标事件）：按下「推理强度」时浮层仍在命中栈顶、选项可点中、值即时回显
- `engine-catalog-injection.test.ts` ENG-1~4（界面与引擎同源、旧名不重复、迁移不丢、未注册安全）
- `model-profile-providers.test.ts` MPS-1~4（目录条目必须可选、无 key 不列、静态兜底、手动添加不被吃掉）
- `catalog-health.test.ts` CH-1b（参数类措辞不算名字问题）
- `press-layer-host.test.ts` PLH-1~5（CSS 契约必须排除宿主 + 宿主有非几何反馈 + 全项目扫描无漏标 + 审计规则存在 + 事故现场结构回归提醒）
- 全量 **235 文件 / 4844 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 **27 条规则** 0/0 · css-contract 无变化

## [1.16.31] - 2026-09-14 — 用户追问「内置目录」三连：旧名重复列出（修复）+ 供应商改名了怎么办（实证标记）

### 用户的疑问（问得对）

设置里填完 API Key 抓模型，DeepSeek 出来 4 条，其中两条写着「（内置目录，服务器未列出）」。
服务器没有的模型，Codem 凭什么内置？既然都从服务器取，内置还有什么用？内置的话供应商改名了怎么办？

### 事实（都实测过）

| 来源 | 条目 |
| --- | --- |
| 服务器 `/models` 实际返回 | `deepseek-flash`、`deepseek-v4-pro` |
| Codem **源码写死**的内置目录（`src/core/llm/model-catalog.ts`） | `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp` |
| 合并 = 用户看到的 4 条 | 服务器 2 条 + 目录独有 2 条 |

目录的来源：v1.16.24 那次排查发现 **服务器的 `/models` 不是"可调用模型"的完整真相** ——
`GET /v1/models` 只有 2 条，但 `POST /v1/chat/completions model=deepseek-v4-flash-vision-exp`
实测 **HTTP 200 可以正常调用**；DSH 里能看到它，是因为 DSH 把模型当**静态目录**（`listModels()` 根本不请求服务器）。
Codem 当时只信服务器列表，于是这个"能调用但未列出"的视觉模型在界面上消失了（而内置方案的视觉槽位正指向它）。
所以加了内置目录做**兜底并集**，并明确标注来源。

### 但用户这一问暴露了一个真缺陷：旧名被当成独立条目

目录里的 `deepseek-v4-flash` 其实是**服务器当前 `deepseek-flash` 的旧名**（改名后旧名仍可调用）。
并集一趟就把同一个模型列成了两条，其中一条还挂着"服务器未列出"——看起来就像凭空多出来的。

**修复**：目录条目支持 `aliases`，**服务器已列出等价 id 时该目录条目不再补入**：

- `deepseek-v4-flash` 声明 `aliases: ["deepseek-flash"]` → 服务器列出 `deepseek-flash` 时不再重复；
- 服务器两条都不列时，旧名**仍作为兜底出现**（不能因为去重把能力弄丢）；
- 仅剩的目录条目就是那条真正"服务器不列但可调用"的视觉实验模型；
- 设置里给目录条目加了 `title` 说明："Codem 内置目录条目：服务器 /models 没有列出它，但它确实可以调用……服务器的当前列表优先。"

修复后用户在设置里看到的是 **3 条**：`deepseek-flash`、`deepseek-v4-pro`（服务器）+ `deepseek-v4-flash-vision-exp`（内置目录，标注来源）。

### 追问：内置的话，供应商改名了怎么办？（这一问逼出了第二个真缺陷）

先看"标准答案"（DSH，第三方客户端）到底怎么做 —— 读它的源码（`node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`）：

| 问题 | DSH 的做法 | 位置 |
| --- | --- | --- |
| 模型表从哪来 | **纯静态目录** `DEFAULT_MODELS`（就那 3 条），`listModels()` 直接返回配置里的目录 | `:1825`、`:1558` |
| 会不会查服务器 | **完全不查** —— 整个适配器唯一的网络调用是 `/chat/completions` | `:1754` |
| 目录过期（改名/下线）怎么办 | **不处理**，但目录只是"建议"：`listModels` 文档写明 "an adapter may accept unlisted model ids, and consumers must not turn absence into request rejection"；`modelInfoFor` 对**不在目录里的 id 照样放行**，用 `defaultContextWindow` + 中性默认值补元数据 | `:169`、`:1563` |
| 目录能不能改 | 能 —— `models` 是配置项（`z.array(catalogModel).default(DEFAULT_MODELS)`），改配置即可，不用改代码 | `:1870` |

所以"凭什么内置"这个问题，DSH 的答案是：**它整个表都是内置的**。而"改名了怎么办"它的答案是：目录里的死条目**一直挂着**，但因为目录不参与校验，**调用不会因此失败**。

Codem 的取舍不同 —— 服务器列表本来就是事实来源（改名、新增、下线它永远最新），内置目录只补服务器不列的空档；缺的是**目录条目失效时没人知道**。这次补上：

**新增 `src/core/llm/catalog-health.ts` —— 只记实证，不猜**：

- **触发极窄**：只有服务器**明确说"不认识这个模型名"**才记账（`isUnknownModelError`：
  `supported api model names are` / `model_not_found` / `model ... does not exist` /
  `try pulling it first` …），并且**先排除上下文超限的措辞**（它句子里也带 "model"）；
  **网络失败、401、429、5xx、上下文超限一律不记** —— 记错会把一个能用的模型冤枉成失效。
- **接线在三条真实错误路径**：`OpenAICompatibleProvider.stream()`、`.complete()`、
  以及 `vision-proxy`（视觉槽位正指向目录里那条模型，它的失败最该被看见）。
- **证据会翻转**：任何一次调用**成功**即撤销标记；记录带 **30 天有效期**（供应商可能早改回来了），
  单 provider **上限 80 条**，坏数据 / localStorage 读不到都静默降级。
- **界面如实说话**：被拒绝过的条目**沉到列表末尾**并标注「（内置目录，服务器已拒绝此名字）」，
  悬停给出**时间 + 服务器原话**。**不删除** —— 供应商可能改回来，删了用户就再也看不到它。
- **顺手堵上同一类谎话**：设置里还有一份"服务器列表还没取到时"用的写死名单（openai/anthropic/
  moonshot/gemini），它过去**不带任何来源标注**，用户会当成"服务器给的"。现在同样标注
  「（内置目录，服务器列表未获取）」并提示点『刷新』；其中 deepseek 那两行是内置目录的**旧副本**
  （里面 `deepseek-v4-flash` 已是旧名）—— 删掉，有内置目录的 provider 一律走目录，
  **一个名单只能有一个来源**。

### 验证

- `model-catalog.test.ts` 新增 CAT-8（服务器列出等价 id 时不重复；只有视觉那条标 `catalogOnly`）、
  CAT-9（服务器两条都不列时旧名仍兜底）
- `catalog-health.test.ts` 新增 CH-1~14：认得各家"模型名不对"的措辞、**上下文超限/401/429/网络失败
  一律不记**、大小写归一、成功即撤销、常态不写盘（20 次成功调用写入次数不增）、坏数据与过期记录被丢弃、
  读存储抛异常时静默降级、单 provider 上限、失效条目沉底且**不就地改动传入数组**、来源后缀措辞（服务器列出的模型被拒不许说"内置目录"）
- `catalog-health-wiring.test.ts` 新增 CH-15~18：**接线**验证 —— 规则对但没接上等于没做，
  用真实 `Response` 打三条错误路径（stream 400 记账 / 上下文超限不记 / 成功后撤销 / complete 同样记账）
- 全量 **232 文件 / 4830 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 25 条规则 0/0 · css-contract 无变化

## [1.16.30] - 2026-09-14 — 路线收尾两项：附件外置 + 全文索引一致性（并修掉一处我自己接错线的维护开关）

### ① 附件外置（`src/core/storage/attachment-files.ts`）

`attachments.content` 过去把**文档全文**存在 SQLite 里（长文档几十 MB），而本地库整库常驻内存、
sql.js 只能整库导出 —— 一条大附件就能把每次保存的内存峰值顶上去（与前几波治的是同一个根；
代码里早有注释指出 `listAllAttachments` 曾因此把每行全文读进内存）。

设计（**不改 schema、不改常见场景行为**）：

- **小内容保持内联**（图片 data URL、短文本，默认 ≤64 KB）—— 不做任何文件 I/O；
- 大内容写入 `<appData>/attachments/<附件id>-<安全文件名>`，库里 `content` 存标记 `file:<路径>`，
  `preview` 保留开头供列表显示；写盘**原子**（`.tmp` → rename）；
- **同步读取路径透明命中**：附件读取（`getAttachmentContent`、`loadAttachmentsForMessage`）是同步的，
  而文件读取是异步 IPC → 采用**预取 + 同步命中**：启动维护/进入会话时 `hydrateAttachmentsForSession()`
  把外置内容读进内存缓存，之后同步路径直接命中；未预热时返回 `undefined` 并**补一次异步预取**，
  **绝不把 `file:` 标记当正文返回**（有专门用例守这条）；
- 外置是**异步排队**完成的（`createMessage` 保持同步 —— 几十处调用点依赖它同步），
  失败保留内联（宁可库大一点，也不丢附件）；
- 孤儿附件文件随维护清理（磁盘不能只涨不降）。

### ② 全文索引一致性（`rebuildSessionFts`）

`session_fts` 没有外键级联，索引裁剪后会留下**孤儿行**（真机实测 112 条）。上一波靠 `getMessage`
回退兜住了读取，这一版把一致性做正：删除"既不在索引也不在日志镜像"的行（消息已被墓碑删除），
为"在日志镜像里但不在 FTS 里"的消息补行（被裁掉但读者仍能看到的历史，搜索也应该搜得到）。
**断言口径**：FTS 的内容 == 读者能看到的消息集合。

### ③ 审计修正：一处我自己接错线的维护开关

写 ① 的测试时发现（ATT-4）：我把"回填日志 / 附件预热 / 日志压缩"和"是否裁剪索引"塞进了同一个
`if (keepIndexedMessages > 0)` —— 于是关掉索引裁剪时，**附件不预热（同步读取拿不到外置内容）、
日志也不压缩**。现在只有"裁剪索引"这一步受该开关控制，其余是常规维护。这类"开关串线"的坑，
正是把维护拆成多条用例（而不是一条大用例）才抓得到的。

### 验证

- 新增 `attachment-externalization.test.ts` ATT-1~4 + FTS-1：小附件内联零 I/O、大附件落文件且库里留标记、
  **未预热绝不返回标记**、维护预热并清理孤儿文件与崩溃残留、FTS 对齐后与"读者可见集合"一致
- `session-jsonl-index.test.ts` SLOG-1~10 仍全绿（含耐久性不变量、墓碑防复活、日志压缩语义不变）
- 全量 **230 文件 / 4810 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 25 条规则 0/0 · css-contract 无变化

### 至此路线全部完成

```
① 削峰+节流 ② 原子写 ③ 致命错误停止重试+会话抢救 ④ WASM 引擎 ⑤ 工具结果溢出
⑥ 事件快照压缩 ⑦ JSONL 权威存储+SQLite 可重建 ⑧ 日志压缩 ⑨ 附件外置 ⑩ 全文索引一致性
```

## [1.16.29] - 2026-09-14 — 上一波存储改造的审计修正（读路径没接上＝静默丢历史）+ 日志压缩

### 审计发现三处真 bug（都是上一波我自己引入的）

1. **读路径没接上（严重，会静默丢历史）**：上一波实现了"索引可被有界裁剪" + "日志是权威"，
   但 `listMessages` 仍然**只读索引** —— 而全平台有几十处调用它：UI 的 `store.loadMessages`、
   agentic loop 的上下文、fork、导出、上下文监控、不变量检查。于是被裁掉的历史会**凭空消失**
   （真机迁移时已经裁掉 112 条）。现在把合并收进 `listMessages` 本身（`listMessagesFromIndex` 保留给
   内部/诊断），**所有调用点自动拿到完整历史** —— 少一处漏改就少一次静默丢数据。
   回归用例 SLOG-8 现在同时断言两件事：`listMessagesFromIndex` 只剩 3 条（索引确实有界），
   而 `listMessages` 仍返回 8 条（读者看到完整历史）。
2. **更新路径从未写进日志**：`appendUpdatedMessageToLog` 靠 `getMessage(id)` 拿 sessionId，
   但 `getMessage` 返回的 Message **不含 session id** → sessionId 恒为 undefined → 更新**从未落日志**。
   后果：日志里只有初版内容，流式回复/工具结果的最新版本只在索引里，一旦索引被裁或重建，
   **内容会回退**。现在直接查库拿 `session_id`（与删除路径同源），查不到时明确告警。
3. **按 id 读取在裁剪后失效**：全文搜索命中、跨会话引用、fork 的按 id 读取走 `getMessage`，
   而索引里已经没有那条消息 → "搜索得到、点开却没有"。现在 `getMessage` 查不到索引时**回退到日志镜像**。
   （实测 `session_fts` 里有 **112 条**指向被裁消息的行 —— 正是这条路径暴露出来的。）

### 收尾项：追加日志压缩（路线里最后一项）

日志是 append-only，同一条消息被反复更新（流式回复、工具结果）就会多行 —— 长会话下持续膨胀
（真机单会话 2.8 MB）。新增 `compactSessionLog()`：把日志**重写**成"每个 id 只留最新一行"
（后写者胜 + 墓碑语义不变），并保证：
- **原子替换**（先写 `.tmp` 再 rename）—— 压缩中崩掉不能毁掉日志；
- **安全性检查**：压缩后的行数必须等于唯一 id 数且严格少于原行数，否则放弃；
- 压缩前等齐在途追加写；压缩后重新 hydrate 内存镜像。
维护里对行数 ≥200 的会话自动执行。

### 全平台存储隐患审计（本轮快查，均已在真机 DB 上量过）

| 检查项 | 结果 |
| --- | --- |
| 附件内容体积 | 0 行 / 0 字节（本机无附件；**附件外置**仍是待做项：`attachments.content` 会把文档全文存进库） |
| `session_fts` 孤儿行 | **112 条**（裁剪造成）→ 已用 `getMessage` 回退修复读取路径；FTS 行本身保留（搜索结果仍能指向日志里的历史） |
| `memory` / `recovery_data` / `notebook_chunks` | 6 KB / 0 / 43 KB —— 量级很小，不构成本轮风险 |

### 验证

- `session-jsonl-index.test.ts` SLOG-1~10（新增 SLOG-10：日志压缩后语义不变、行数下降、原子替换、
  重新 hydrate 后读路径仍完整）
- 全量 **229 文件 / 4805 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 25 条规则 0/0

### 仍未做（诚实标注，不影响当前正确性）

- **附件外置**：`attachments.content` 仍存在库里（会把长文档全文塞进整库导出）；需要改上传/读取
  与气泡渲染三处，属于独立一波。
- 全文检索索引目前**不随裁剪清理**（有意保留：指向日志里的历史仍可读，读取靠 `getMessage` 回退）。

## [1.16.28] - 2026-09-14 — 治本（三）：会话落成 append-only JSONL，SQLite 降级为可重建索引

### 这一步要解决的"根"

前六波把风险压到最低，但**"整库导出"这个动作本身还在**：只要会话历史住在 SQLite 里，
库就随对话无限增长，而 sql.js 只能整库 `export()` → 每次保存的峰值随库增长 → 最终 out of memory。
DSH 的做法是会话权威存储 = **append-only JSONL**（增量追加、没有整库导出），SQLite 只是**可重建的查询索引**。
本波把这套搬了过来：

```
<appData>/sessions/<sessionId>.jsonl   ← 权威存储：一行一条消息，追加即持久
codem-db.bin                            ← 查询索引：可被有界裁剪、可从日志重建
```

### 实现（`src/core/storage/session-jsonl.ts` + `session-log-bridge.ts`）

- **追加即持久**：`createMessage` / `updateMessage` / `appendToMessage` 之后追加一行 JSON
  （Rust `append_file`，天然按行），**不需要任何整库导出**；同 id 多行 = **后写者胜**
  （流式回复与工具结果更新天然幂等）。
- **损坏行只计数不致命**：崩在写入中途最多丢最后一行；读取时跳过坏行并报告 `skippedLines`。
- **迁移**：启动维护时把老会话的索引历史**回填**进日志（幂等，按 id 去重），然后才允许裁剪索引。
- **索引可被有界裁剪**（`trimIndexedMessages`）：每会话至少保留最新 500 条，超出的部分
  只有在**日志里确实存在**、且**该消息没有附件**时才删除 —— 这就是"索引可重建"的落地。
- **读路径合并**（`listMessagesMerged` + `hydrateSessionLog`）：进入会话时把日志读进内存镜像，
  被索引裁掉的历史照样读得到。

### 自查审计（本波自己的代码）发现并修掉两处

1. **删除会"复活"**：日志成了权威之后，`deleteMessage` 只删索引的话，下次从日志合并/重建时
   被删消息会**回来**。→ 删除追加**墓碑记录**（`deleted: true`，后写者胜），读取时跳过；
   所有真删除路径（`deleteMessage` / `deleteMessagesBefore`）都补墓碑。
2. **耐久性检查读到旧日志**：追加是 fire-and-forget，裁剪前若没等齐在途写入，会读到一个偏旧的日志 →
   虽然只会"该裁的没裁"（安全方向），但结果是裁剪时灵时不灵。→ 新增 `flushSessionLogWrites()`，
   裁剪与回填前先等齐（SLOG-4 正是暴露这条的用例）。

另外，多行 PowerShell 替换两次静默没生效，导致**双写根本没接上**（日志一直是空的）——
是 SLOG-5/6 把它抓出来的。教训写在用例注释里：**新增一条关键路径，必须有一条用例从"用户动作"这一端验证它真的接通了**。

### 验证

`src/test/session-jsonl-index.test.ts` SLOG-1~9：追加即持久且无整库导出、同 id 后写者胜、
损坏行容忍、**耐久性不变量**（日志为空时索引一条不许删）、只裁日志覆盖的且跳过附件消息、
裁剪后读路径仍拿得到完整历史、回填幂等、维护"先回填再裁剪"、**墓碑防复活**。

全量 **229 文件 / 4804 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 0/0 · css-contract 无变化。

### 路线收尾

```
① 削峰 + 节流   ② 原子写   ③ 致命错误停止重试 + 会话抢救   ④ WASM 引擎
⑤ 工具结果溢出   ⑥ 事件快照压缩   ⑦ 会话落 JSONL、SQLite 降为可重建索引  ← 本波（完成）
```

至此 DSH 那套"权威存储在追加日志、SQLite 可重建"的结构在 Codem 里落地：**新消息不再依赖整库导出**，
索引可以随体积增长被安全裁剪。(后续仍可做的：FTS 索引重建、附件外置、把旧会话一次性迁移压缩。)

## [1.16.27] - 2026-09-14 — 治本（二）：事件日志快照式压缩 —— 让"只增不减"的表第一次可以安全变小

### 上一步留下的死结

上一波审计发现：`session_events` 只增不减（本机实测 2130 行 / 3.8 MB），但**不能按 seq 截断** ——
事件日志被当作**状态**读取：`event-projection` 从事件重建投影、`runtime-invariants` 靠回放查不变量，
`preset-discovery` / `feedback` / `postmortem` / `time-context` / `session-search` / `ui-trajectory` /
`sync-engine` 都在 `readAll`。截断 = 悄悄改数据。于是上一波只能把裁剪默认关掉，
留下"表还在长、但谁都不敢删"的死结。

### 本波：先固化状态，再丢事件（DSH 的 projection-cache 思路）

新增 `session_snapshot` 事件类型 + `EventLog.compactWithSnapshot()`：

1. 把**截至锚点的投影结果**写成一个 `session_snapshot` 事件；
2. 删掉锚点之前的事件（`session_meta` 永不删 —— 预设归属/反馈状态靠它）；
3. 回放 = 快照 + 其后事件，与完整回放**逐条等价**。

三个实现要点（都是我自己踩出来的）：

- **快照必须占据锚点自己的 `seq`**（`INSERT OR REPLACE`），不能用新的最大 seq。否则快照会排到
  "要保留的尾部事件"之后，而 `applySnapshot` 是**替换**语义 —— 回放时尾部事件先被应用、再被快照
  覆盖掉，等于把刚发生的对话弄丢。我第一次就是这么写的，SNAP-4 当场抓住。
- **`applySnapshot` 是替换而不是合并**：快照出现就意味着它之前的事件已被删除，合并会让残留叠加成重复消息。
- **维护默认按阈值压缩（>5000 条事件的会话）并保留最近 8 条事件**：既回收绝大部分体积，
  又保留最近细节供排查；阈值内的小会话完全不碰。

### 验证（核心是那条等价性）

`src/test/snapshot-compaction.test.ts`：

- **SNAP-2 回放等价性**：压缩前后的投影逐条一致（id / role / content 全比）—— **这条不成立，
  "裁剪"就变成"改数据"**；它是本波敢默认开启压缩的唯一理由。
- SNAP-1 写入快照并删除旧事件且保留 `session_meta`；SNAP-3 压缩后新增事件照样接得上（快照不吞后续消息）；
  SNAP-4 `keepEvents` 保留尾部细节（这条正是抓出上面第一个坑的用例）；
  SNAP-5 维护只压缩超阈值会话且压缩后仍可读；SNAP-6 压缩失败不影响使用。

全量 **228 文件 / 4795 用例通过**（15 skipped）· tsc 0 错误 · UI 审计 25 条规则 0/0 ·
css-contract 2745 类无变化。

### 这一步在整条"治本"路线里的位置

```
已做：① 保存削峰 + 2 秒节流（整库导出次数 ↓）
      ② 原子写（先 .tmp 再 rename，杜绝对半截 DB）
      ③ 致命错误识别 + 停止重试 + 会话抢救
      ④ 换 WASM 引擎（堆扩容不再整块复制）
      ⑤ 工具结果溢出到文件（大文本不进库）+ 溢出文件保留期
      ⑥ 事件日志快照式压缩（只增不减的表第一次能安全变小）  ← 本波
待做：⑦ 会话持久化改 append-only JSONL、SQLite 降级为**可重建索引**
        （做完这一步，"整库导出"这个动作才会从架构里消失；
          ⑥ 的快照机制正是 ⑦ 的前置：JSONL 重建索引时同样靠快照 + 增量事件）
```

## [1.16.26] - 2026-09-14 — 数据库治本：换 WASM 引擎 + 对齐 DSH 的溢出（spill）与保留策略

### 先看 DSH 是怎么做的（本机 `app.asar.unpacked/node_modules/@deepseek-ai/`）

| 包 | 做法 |
| --- | --- |
| `dsh-session-persistence-jsonl` | 会话的**权威存储是 append-only JSONL**（增量追加落盘，不存在"整库导出"这一步） |
| `dsh-session-query-sqlite` | SQLite **只是可重建的查询索引**（FTS5 检索），不是主存储 |
| `dsh-spill` / `dsh-spill-local` / `dsh-spill-policy` | 工具结果超过 `maxInlineBytes` → **全文写会话私有文件**，模型侧只留 head/tail 预览 + 定位符 + 说明行 |
| `dsh-output-retention` | `ItemRetainer`/`TextRetainer`：按**字节**计预算、head/tail/headTail、**UTF-8 边界修剪**、"保留了什么/省略了什么"的 notice |
| `dsh-atomic-write` | 独占创建随机后缀临时文件 + `rename` 落盘 |
| `dsh-session-projection-cache` | 投影缓存节流 write-behind 检查点 |
| `dsh-compaction-tool-result-pruner` | replay-safe 的 head/middle/tail 修剪 |

一句话：**DSH 不让"一次性大文本"进主存储，也不做整库导出；SQLite 在那个架构里是可丢的索引。**
Codem 的本地库是整库常驻内存 + 只能整库 `export()`，所以要把这三条策略搬过来。

### 本波做了两条（用户要求的"两条都做"）

1. **换 WASM 引擎**（`src/core/storage/database.ts`）
   - asm.js 的堆是 JS 里的定型数组，**扩容只能整块复制**：库越大越慢、越可能分配失败，失败即
     abort 整个模块（那屏 `xe[…] is not a function` + `out of memory` 刷屏）。WASM 版走
     `memory.grow`（页级、引擎负责），没有"复制整个堆"这一步，占用也更省。
   - 打包：`sql.js/dist/sql-wasm.wasm` 经 Vite（已 `assetsInclude **/*.wasm`）随包发出，
     `locateFile` 指过去；**万一资源缺失自动回退 asm.js 并明确告警**（宁可慢，不能打不开应用）。
   - 测试环境仍用 asm（wasm 在 Node 下要读磁盘文件，没必要拖慢测试）。
2. **溢出（spill）+ 保留策略**（对齐 `dsh-spill-policy` / `dsh-output-retention`）
   - 新增 `src/core/storage/spill.ts`：工具结果超过 **64 KB**（`DEFAULT_MAX_INLINE_BYTES`）时，
     把**全文**写入 `<appData>/spill/<sessionId>/<tool>-<callId>.txt`（**原子写**：`.tmp` → `rename`），
     入库与进入上下文的是 **head 8 KB + tail 8 KB 预览**（按字节、UTF-8 边界修剪，不会切出半个
     中文/emoji）+ 一行说明：`（已省略 N 字节；完整结果保存在：<路径>）`。
     未超限时**零 I/O**；溢出失败回退原文（宁可库大一点，也不能把结果变成"保存失败"）。
   - 拦截点选在 `executor.ts` 的 `tool_complete` —— 工具结果**进库、进上下文的唯一入口**：
     在这里拦一次，库体积、后续每轮上下文、以及每次整库导出的峰值一起受控。
   - 启动后台跑一次 `runDatabaseMaintenance()`：清理 `telemetry_events`（保留 7 天）+ 按需 `VACUUM`，
     并打印前后占用。**审计修正：默认不再裁剪 `session_events`** —— 见下一节。

### 实测（不是估算）

- 维护在**真实库副本**上（`.preview-shot/measure-db-maintenance.mjs`）：
  `10.62 MB → 10.34 MB`（事件裁剪 0 行 / 遥测 960 行 / VACUUM 回收 **0.29 MB = 2.7%**）。
  结论照实说：**本机这个 10 MB 库还不到维护能显著受益的规模** —— 说明把内存推爆的主因是
  "每次保存整库导出 + asm.js 堆"，而不是这 10 MB 本身；维护的收益随库体积增长
  （本机实测同库里 `session_events` 已 3.8 MB、`tool_calls.result` 2.1 MB，都是只增不减的）。
- 溢出：200 KB 工具结果 → 入库文本 < 20 KB（省略约 197 KB），全文在溢出文件里（测试断言）。

### 验证

- 新增 `src/test/spill-retention.test.ts`（SPILL-1~5）：未超限零 I/O、超限后"预览 + 说明 + 全文落盘"
  且原子写、UTF-8 边界安全（多字节 + emoji）、说明措辞、上限可配置
- 全量 226 文件 / 4783 用例通过 · tsc 0 错误 · UI 审计 25 条规则 0/0 · css-contract 2745 类无变化
- 真实应用（构建产物）启动日志确认：`[Database] sql.js 引擎：wasm` + 维护前后占用 + 保存往返成功

### 本波自查（审计）修掉的三处

1. **默认不再裁剪 `session_events`**（最重要的一条）。最初按"每会话保留最新 2000 条"实现，
   审计发现事件日志**被当作状态读取**：`event-projection.ts`（4 处）从事件重建投影、
   `runtime-invariants.ts` 靠回放检查不变量、`preset-discovery` / `feedback` / `postmortem` /
   `time-context` / `session-search` / `ui-trajectory` / `sync-engine` 都在 `readAll`。
   按 seq 截断尾部会让投影缺段、让不变量检查看到"事件序列不完整" —— 那是**悄悄改数据**。
   正确处理是**写快照事件**（把投影固化成 `session_snapshot`）后再丢快照之前的事件，那需要设计。
   现在默认 `keepEventsPerSession = 0`（不裁剪），参数保留给快照式压缩落地后开启；
   显式开启时 `session_meta` 仍永不裁剪。
2. **溢出文件必须有保留策略**：溢出把大文本从数据库搬到磁盘，只写不删等于把"库无限增长"换成
   "溢出处无限增长"。新增 `pruneSpillFiles()`（保留 14 天、清掉崩溃残留的 `.tmp`、
   认不出来历的文件不碰），时间戳写在文件名里（`list_directory` 不回传 mtime）。
3. **VACUUM 加护栏**：VACUUM 会把整库在内存里重写一遍，库大时它自己就是卡顿源。
   现在只在"确有可回收空间（空闲页 ≥5%）"且"库 < 256 MB"时执行，否则跳过并打印理由。

### 与 DSH 的差距（诚实留给下一波）

DSH 的权威存储是 **append-only JSONL**，SQLite 只是索引 —— 那才是"整库导出"这个动作从根上消失的
做法。Codem 现在是"整库导出 + 削峰 + 节流 + 溢出 + 维护"，属于把同一条路上的风险压到最低，
但**要彻底对齐需要把会话持久化换成 JSONL 追加 + SQLite 只做可重建索引**（并配套上面的
快照式事件压缩），那是一次存储层重构，不在这一波里假装做完了。

## [1.16.25] - 2026-09-14 — 本地数据库内存耗尽（out of memory 刷屏）：三条防线 —— 降峰值、原子写、认出致命错误后停止重试并抢救会话

### 现象（用户控制台）

```
[loadAttachmentsForMessage] Failed: TypeError: xe[e[((s + 12) >> 2)]] is not a function
[listMessages] Failed to convert row: Error: malformed database schema (sqlite_master) - table x already exists
[cost-tracker.ts] / [Store] saveMessages / [loadFeedback] / [Telemetry] / [store.ts] …: Error: out of memory   ← 同一条刷屏几十次
[extractMemories] Extracted 0 memories …          ← 功能静默失效
```

### 这是什么：一次 abort 之后的级联

`sql-asm-memory-growth.js`（asm.js 版 sql.js）在堆扩展失败时会 **abort 整个模块**；abort 之后
每一次调用都报同样的错 —— 那句 `xe[…] is not a function`（函数指针读成非法值）就是模块已死的
典型签名，紧随其后的 OOM 与 `malformed database schema` 都是它的余波。真正的问题是**级联**：
调用方仍在无限重试（日志里同一条 OOM 出现几十次），而**写入永远不成功** —— 消息写不进库。

### 三条防线（层层都不需要"运气"）

1. **削掉保存的尖峰内存 + 合并高频写入**（`src/core/storage/database.ts`）
   - 旧实现每次保存都：`db.export()`（整库一份）→ 拼一个**与库等大的二进制字符串** → `btoa`
     再出 1.33 倍的第二份 —— 峰值约 2.3× 库大小；现在改成分块编码后一次 join，峰值降到约 1.33×。
   - 整库 `export()` 是 sql.js 唯一的落盘方式，那就**别那么频繁地做**：新增脏标记（没有变化
     不导出）+ **2 秒节流窗口**（telemetry / cost-tracker / autosave / 设置写入在一次对话里
     会轮番触发几十次，过去就是几十次全库导出）。
2. **原子写盘**：先写 `codem-db.bin.tmp` 再 `rename` 覆盖。整库 base64 写到一半被杀进程/断电，
   磁盘上就是"半截 DB"，下次启动直接 `malformed database schema`（仓库里那个
   `codem-db-broken.bin` 就是这么来的）。
3. **认出致命错误后停止重试 + 抢救会话**：新增 `isFatalDbError()`（OOM / malformed schema /
   database disk image is malformed / bad parameter or other API misuse）与 `DB_FATAL_EVENT`：
   - **只报一次**（不再刷屏），并**停止一切后续写入与重试**（重试一个已死的模块毫无意义）；
   - App 收到事件后**不经过 sql.js** 把当前会话写入
     `%APPDATA%\com.codem.app\codem-session-rescue-<时间戳>.json`，并提示用户"关闭重开应用 +
     把 rescue 文件发我" —— 数据库这条路已经断了，只有直写 JSON 还能保住用户的消息。
   - 顺带修掉 `importDatabase()`：旧实现 `const SQL = initSqlJs(); new SQL.Database(data)` 把
     **Promise** 当构造函数用，一调用必抛 `TypeError: SQL.Database is not a constructor` ——
     也就是说"导入恢复"这条路以前根本走不通。现在复用已解析的模块并复位致命状态。

### 验证

- 新增 `src/test/database-oom-defense.test.ts`（DB-OOM-1~6）：致命错误识别、脏标记 + 节流窗口
  （**800ms 间隔的连续写入只导出一次**）、原子写（**绝不直接写目标文件**）、致命错误只报一次且
  停止后续写入、分块 base64 严格无损（含 24576 边界与 100000 字节）、`importDatabase` 可用
- **双向验证**：把三处修复临时改回旧行为 → DB-OOM-2 / DB-OOM-3 **立刻失败**；恢复后全绿
- 全量用例、tsc、UI 审计、css-contract 见 PROJECT-GUIDE 版本表

### 还没做完的（下一波，先记下来）

- **换引擎**：asm.js 版堆扩展只能"拷贝整个堆"，大库下既慢又容易失败；`sql-wasm.js` 的线性内存
  更省更好扩。
- **控库体积**：本机实测 `session_events` 3.8 MB（2130 行，只增不减）、`tool_calls.result` 2.6 MB；
  长会话应当有保留策略（事件裁剪 / 大工具结果落盘只存引用 / 定期 VACUUM）。

## [1.16.24] - 2026-09-13 — 为什么模型下拉只有 2 个 DeepSeek 模型：服务器 /models 不是「可调用模型」的完整真相

### 用户提问

「之前改成从服务商获取模型列表，为什么 DeepSeek 只获取到两个模型、没有
`deepseek-v4-flash-vision-exp`，而 DSH 能获取到？」

### 实测（同一把 key 直连官方接口，脚本留在 `.preview-shot/probe-deepseek-*.mjs`）

```
GET  https://api.deepseek.com/v1/models
     → 2 个：deepseek-flash, deepseek-v4-pro

POST https://api.deepseek.com/v1/chat/completions  model=deepseek-v4-flash-vision-exp
     → HTTP 200 ✅ 可正常调用
POST https://api.deepseek.com/v1/chat/completions  model=DeepSeek-V4-Flash-Vision-Exp
     → HTTP 400 ❌ "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed …"
```

三条结论：

1. **服务器 `/models` 不是「可调用模型」的完整真相。** 视觉实验模型不在列表里，却能正常调用；
   而且列表还会变 —— 这一侧实测已经从 `deepseek-v4-flash` 改名成 `deepseek-flash`。
2. **DSH 之所以「能获取到」，是因为它的 DeepSeek 模型是静态目录**：
   `dsh-llm-deepseek/lib/index.js` 的 `DEFAULT_MODELS` 里写死了
   `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`，
   而它的 `listModels()` **根本不请求服务器**。Codem 之前只信服务器列表，于是这类
   「能调用但未列出」的模型就消失了。
3. **模型 id 大小写敏感**（实测 200 vs 400）。而 Codem 的内置方案
   （`model-profile.ts`）把**显示名** `DeepSeek-V4-Flash-Vision-Exp` 当 id 用了 ——
   视觉代理一旦走这个槽位，请求必然 400。

### 修复

- **新增内置模型目录 `src/core/llm/model-catalog.ts`**：`BUILTIN_MODEL_CATALOG`
  （deepseek 三项，与 DSH 的 `DEFAULT_MODELS` 对齐）+ `mergeModelsWithCatalog()`
  —— **服务器列表仍为事实来源**（它给出的模型全部保留，含改名后的新 id 与未来新模型），
  目录只做并集兜底，补进来的条目标记 `catalogOnly: true`，界面如实标注
  「（内置目录，服务器未列出）」，不假装是服务器给的。
- **读取处统一走并集**：`LLMEngine.loadDynamicModels`（**升级后即使用户从不点刷新，
  视觉模型也会出现在下拉里** —— 缓存本身仍只保存服务器事实，不被目录污染）、
  `model-config.ts` 的模型列表/默认模型解析、设置页的动态模型视图与刷新结果
  （刷新状态显示「服务器 N + 内置目录 M」）。
- **id 大小写纠正**：`normalizeModelId()` + `resolveSlot()` 归一化，把历史上保存的
  显示名当 id 的槽位纠正成可调用的小写 id（用户方案无需手动改）；内置方案的 vision 槽位
  直接改成小写；`vision-proxy` 与 `capability-detector` 把该模型登记为支持视觉。
- **退役两条把这个 bug 写进断言的用例**（`v1.5.2-full-regression`、`vision-proxy-media`
  里断言 `DeepSeek-V4-Flash-Vision-Exp` 的地方），改为断言实测可调用的小写 id。

### 验证

- 新增 `src/test/model-catalog.test.ts` CAT-1~7：并集语义（服务器优先、目录独有才标记、
  大小写去重、未知新模型不丢）、**用户场景回归**（缓存只有那两个模型时视觉模型必须出现）、
  id 归一化（显示名→可用 id，自定义模型不被改写）、内置方案槽位与目录一致
- 实测数据写进模块注释与 CHANGELOG，脚本可复跑（`node .preview-shot/probe-deepseek-models.mjs`）

## [1.16.23] - 2026-09-13 — 「删除技能卡死」真正根因：确认弹窗被压在模态窗口后面（看不见、点不到），而 Radix 已锁死 body

### 用户提供的落盘轨迹给出了决定性证据

```
+15065ms delete button clicked {"name":"skills","source":"user","path":"…\\.codem\\skills\\SKILL.md"}
+15091ms confirm dialog opened {"targetName":"skills"}
+15744ms heartbeat {"label":"skill-manager","driftMs":-7}     ← 之后 30 秒只有心跳，drift ±10ms
+41750ms heartbeat {"label":"skill-manager","driftMs":3}
```

两条结论直接落地：

1. **窗口没有卡死，主线程完全正常** —— 心跳每 2 秒一行、漂移只有 ±10 毫秒。所谓"整个窗口点不动"
   不是渲染/主线程冻结，而是**交互被挡住了**。
2. **`confirm action fired` 一次都没有** —— 用户点不到那个"删除"按钮：它根本没被点到，
   所以 `[SkillInstaller]` 一行都没有。

### 根因（层叠顺序）

| 元素 | 取值 |
| --- | --- |
| `.modal-overlay`（技能管理器本身是模态） | `z-index: var(--z-modal)` = **1300** |
| `.alert-dialog-content`（"确认删除"弹窗） | `z-index: var(--z-dropdown)` = **1000** |

确认弹窗通过 Portal 渲染在 `document.body` 下，与模态**不在同一个层叠上下文**里比较 ——
只要模态落在一个"自带层叠上下文"的祖先里（皮肤、插件、祖先样式都可能造成），
1300 的模态就会把 1000 的确认框整个压在下面：**看不见、点不到**。
而 Radix 打开模态时已给 `body` 加了 `pointer-events: none`，此时点哪里都没反应 ——
用户看到的就是"整个窗口卡死"，而主线程、日志、性能全都正常。这类事故**没有任何控制台线索**，
这正是它查了三轮的原因。

### 修复（两层，都不再依赖层叠运气）

1. **层叠令牌：新增 `--z-dialog-overlay: 1400` / `--z-dialog: 1410`**（严格高于 `--z-modal: 1300`），
   并让 `.alert-dialog-content`、`.dialog-content`、`.dialog-overlay` 使用它们 ——
   对话框高于模态从此是**明文约束**，不再是"恰好没被压住"。
2. **删除确认不再用嵌套模态弹窗**：改成**详情面板内联确认**（「确定要删除「X」吗？」+
   「确认删除 / 取消」）。根因是"模态里再套一个模态"，那就让它不再套模态 ——
   确认按钮永远渲染在用户刚点过的按钮下方，不可能被谁压住。
   新增 `.skill-delete-confirm` / `.skill-delete-confirm-actions` 样式；CSS 契约快照同步更新
   （2743 → 2745 个类，含三处 z-index 取值变化，diff 可见）。

### 顺带修掉用户日志里的另一个问题：幽灵技能 "skills"

轨迹里的删除目标名叫 `skills`、`filePath` 指向 `<技能根目录>\SKILL.md` ——
即技能根目录下存在一个**名为 `SKILL.md` 的目录**，其内部 SKILL.md 没有 `name` 字段，
于是被兜底成"父目录名"注册成了一个技能。现在加载时会**跳过结构异常的目录并给出明确警告**
（正确结构是 `skills\<技能名>\SKILL.md`），不再把它变成"删一个根本不该存在的技能"。

### 验证

- 新增 `src/test/dialog-layer-contract.test.ts` LAYER-1~4：对话框令牌严格高于模态令牌、
  三处规则确实使用它们、技能管理不再使用嵌套模态删除确认（**这正是本轮事故的机器约束**）
- `skill-uninstall-safety.test.ts` UNINST-9：幽灵技能目录不再注册
- 真实界面验证改用**真实鼠标事件**（CDP `Input.dispatchMouseEvent`）而不是 `element.click()` ——
  上一轮我用 JS 点击"验证通过"属于**假绿**：JS 点击绕过命中测试，恰好绕过了这次的 bug
- 全量用例、tsc、UI 审计、css-contract 见 PROJECT-GUIDE 版本表

## [1.16.22] - 2026-09-13 — 「删除技能卡死」第二轮：把不可复现的冻结变成可取证（落盘轨迹 + 心跳 + 渲染风暴检测）

### 这一轮先说清楚查到了什么

v1.16.21 修掉的是"删除链路可能永远等一个没人能点的系统对话框"。用户复测后仍然卡死，
并给出三条关键信息：**删的是「用户」来源的技能**、**整个窗口都点不动（切侧边栏也没反应）**、
**控制台连一条 `[SkillInstaller]` 都没有**。

第三条把范围完全改了：连删除逻辑的入口都没进去，说明卡点在「点击 → 进入删除逻辑」之间，
而不是原生删除。为了不再靠猜，这一版做了两件事：

1. **在本机把「修复后的删除」跑通并证明**：用 WebView2 远程调试（CDP）驱动真实界面 ——
   建一个探针技能 → 打开技能管理 → 选中 → 删除技能 → 确认。结果：控制台出现
   `[SkillInstaller] uninstall "zz-delete-probe" → 永久删除 …`，弹窗关闭、列表用户数 1 → 0、
   磁盘上目录消失、无错误。同一构建（与用户日志逐行对得上：`main-IHu-_uUa.js:9571` / `:8813`）
   在这一侧是正常的 —— 所以他的卡死是**数据/状态相关**的，不是那条代码路径本身。
2. **给这条路径装上"黑匣子"**：窗口冻结时控制台什么都不会留下，唯一能事后取证的是落盘轨迹。

### 新增：技能删除落盘轨迹（`src/core/skill/skill-delete-diag.ts`）

写到 `<appData>/.codem/skills-delete-diag.log`（每次启动重写，单文件约 256 KB 上限），回答四个问题：

- **点击有没有到达处理函数**：`delete button clicked`（含技能名/来源/路径）、`confirm action fired`、
  `confirm dialog opened`。若日志停在 `confirm dialog opened` 而没有 `confirm action fired`，
  说明卡在"弹窗打开"这一侧；若两条都没有，说明点击根本没进到组件（另一类问题）。
- **目标是哪个技能/哪条路径**：每次都带 `name` / `source` / `path`，事后不必猜。
- **每步花了多久**：每行带 `+Nms` 相对时间戳。
- **主线程还在跑吗**：`heartbeat` 每 2 秒一行并报告 `driftMs`；漂移远大于间隔会附
  `suspicion: "main-thread block"` —— 这就是"整个窗口点不动"的机器可读证据。
- **是不是渲染风暴**：`render burst`（1 秒内渲染次数超阈值，每个窗口只报一次）。
  无限渲染循环会把主线程钉死且**不产生任何控制台输出**，只有渲染函数自己看得见。

轨迹的所有写盘都是 `fire-and-forget` + `try/catch`：**诊断失败绝不影响删除**（有专门用例守）。

### 同时补上的三处体验/安全

- **慢删除给出进度**：详情面板显示「正在删除「X」… 已用 N 秒」，超过 5 秒补一句说明 ——
  慢（大目录、网络盘）不该看起来像卡死。
- **删除失败就地显示**：错误同时出现在详情面板按钮下方，不再只依赖顶部横幅是否在视野内。
- **目标护栏**：若记录的路径其实是技能根目录本身或它的上级（说明记录被写坏），
  **直接拒绝删除**并说明原因 —— 否则"删一个技能"会变成"删掉全部技能"，
  而且这种目标体积不可控、耗时不可预测。
- 另外把 `handleDelete` 的"目标为空"分支从静默 `return` 改成可见错误 + 落盘记录。

### 验证

- 本机端到端（CDP 驱动真实界面）：探针技能删除成功，且 `skills-delete-diag.log` 落盘完整
  （mounted → delete button clicked → confirm dialog opened → confirm action fired →
  uninstallSkill deleting → directory removed → delete flow finished）
- 新增 `src/test/skill-delete-diag.test.ts`（DIAG-1~4：落盘/失败不影响功能/心跳漂移/渲染风暴）
  与 `skill-uninstall-safety.test.ts` 的 UNINST-6~7（轨迹先于原生调用、越界目标拒绝）
- 全量用例、tsc、UI 审计、css-contract 结果见 PROJECT-GUIDE 版本表

### 请用户配合的一步

复测时若仍卡死，把 `<appData>\.codem\skills-delete-diag.log` 发我（Windows 上即
`%APPDATA%\com.codem.app\.codem\skills-delete-diag.log`）。这份轨迹会直接指出卡在哪一步 ——
包括"窗口冻结期间主线程停了多久"。

## [1.16.21] - 2026-09-13 — 修复：技能管理「删除技能」卡死（删除链路可能永远等一个没人能点的系统对话框）

### 现象（用户反馈）

技能管理里点「删除技能」卡死。控制台只有启动日志、没有任何错误 —— 因为卡住的不是 JavaScript，
而是**一个永不完结的原生调用**：前端 `await` 永不返回，界面就停在那里。

### 旧链路与根因

```
SkillManager.handleDelete → uninstallSkill → deletePath(技能目录)
  └ delete_file(目录) 必然失败 → delete_directory
      └ Rust: powershell -Command "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
                 '<目录>', 'OnlyErrorDialogs', 'SendToRecycleBin')"
         且用 Command::output() 等它退出
```

`UIOption.OnlyErrorDialogs` 的语义就是「出错时弹对话框，并等用户确认」；而这个 PowerShell 是
**隐藏子进程**（没有可见窗口）。于是只要删除失败一次 —— 目录被其他程序占用、回收站不可用、
目录大于回收站配额 —— 对话框就弹在用户看不见也点不到的地方，PowerShell 永不退出，
Tauri 命令永不返回，前端的 `await` 永不结束。这就是「卡死」：不是慢，是没有终点的等待。
同一条命令还被项目删除（`App.tsx`）与宠物卸载复用，属于同一类风险。

### 修复（三层，逐层都不再可能无限等待）

1. **新增 Rust 命令 `delete_directory_permanent`**：应用自管目录（技能、宠物、zvec-grep 运行时/模型、
   快照）改用 `remove_dir_all` 永久删除 —— 无 shell、无对话框、无回收站。首次失败会清掉整棵树的
   只读位再重试一次（Windows 上最常见的拦路虎）。理由很直接：这些目录删掉只是重新下载，
   回收站不提供额外安全价值，却带来"对话框等待"这一整类风险。
2. **`delete_directory`（回收站，保留给项目文件夹等用户内容）改为直接调用 `SHFileOperationW`**，
   标志 `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI`：确认、进度、错误
   三类界面全部抑制，函数只可能返回。实测同机：新路径 **130 ms** 返回（旧 PowerShell 路径 473 ms）。
3. **前端不再谎报成功、且删除有界**：
   - `uninstallSkill` / `uninstallPet` 删除失败时返回失败并**保留注册表记录**。旧代码 `catch` 后
     照样 `return { success: true }`：界面上技能消失了、磁盘上的文件夹还在，下次启动又被扫描回来
     （"删了又回来"）。
   - 删除原语加 30 秒兜底超时：超时按失败报错并给出目录路径与下一步，界面不会永久停在"删除中"。
   - 删除期间显示「删除中…」，失败在界面上可见（技能管理器的错误条 / 设置里的卸载提示）。

### 验证（数据）

- **Rust**：`cargo test --lib` **42 通过**，含 4 条新用例 —— 嵌套目录 + 只读文件的整树删除、
  缺失路径幂等、拒绝空路径与盘符根、**回收站路径必须返回**（实测 `Ok` 且 130 ms）。
- **前端**：新增 `src/test/skill-uninstall-safety.test.ts`（UNINST-1~5：永久删除且不经回收站命令、
  失败不谎报且保留注册表、provider 单文件回退、内置/不存在拒绝、超时有界）；并**把组件换回修复前
  的 installer 跑了一遍 —— 4 条失败**，证明用例确实能抓住这个 bug。
- 全量：221 文件 / 4754 用例通过（15 skipped）；`tsc --noEmit` 0 错误；UI 审计 25 条规则
  error 0 / warn 0；css-contract 2743 个类无变化。

### 诚实交代

未能在这台机器上"亲眼复现"卡死那一刻：触发它需要一个失败场景（文件被占用 / 回收站不可用），
而旧实现一旦进入那个场景就会弹出系统对话框，我不想在你的桌面上弹一个来验证。
根因判定依据是 API 语义（`OnlyErrorDialogs` = 弹对话框并等待）+ 你的症状（无错误、无返回、永久卡住）；
而无论具体触发点是哪个，新链路都不再存在"等待对话框"这条路。

### 同类清查

`delete_directory` 的其它调用方一并确认：`deletePath` 剩余用途都是临时文件（computer-use 临时文件、
工具临时文件、市场下载的临时 zip），不会再对应用自管目录做回收站删除。

## [1.16.20] - 2026-09-13 — 修复：上传附件后「上下文」标签不消失；兼容第三方 Agent Skills（AREX-Skill）

### 现象一（用户反馈）：上传 a.md 后，编辑框里的「上下文：a.md」标签发送后不消失

标签在对话结束后依然挂着。排查发现根因不是「忘了清空」，而是**同一份状态被手工复制成两份**：
附件存在 `pendingAttachments`，而编辑框里的徽章行存在另一份 `contextBadges`，后者只在
textarea 的 `onChange` 里重算一次。于是这一类"徽章说谎"的路径全都在：

| 路径 | 旧行为 |
| --- | --- |
| 发送消息 | `pendingAttachments` 清空，徽章**留下**（用户报的这条） |
| 点附件的 × 移除 | 附件移除，徽章**仍声称会发送它** |
| 切换会话 / 新建对话 | 附件清空，徽章**跨会话残留** |
| 粘贴图片、拖拽文件进来 | 附件已入列，徽章行**看不到**（要再敲一个字才出现） |

**修复**：徽章行改为从 `pendingAttachments` 派生（`src/components/InputArea.tsx`），
删除 `contextBadges` 状态与 `onChange` 里的手工同步 —— 徽章行永远等于"这条消息真的要带的附件"，
四条路径一次性同生共死。

**测试**（`src/test/component-input-area.test.tsx`，ATTC-1~4）：四条路径各一条用例。
并已用「换回修复前的组件」验证过这 4 条用例确实会失败（不是假通过）。

### 现象二：想装 AREX-Skill 时暴露 —— 技能名/描述被引号与块标量破坏

AREX-Skill 把 1000 个 ML 仓库蒸馏成 5000+ 个技能，全部使用标准 Agent Skills 写法。
把上游真实的 `SKILL.md` 喂给 Codem 的解析器（实测，非推断）：

```
name: vllm                                     → "vllm"            ✅
description: "Route vLLM tasks across …         → 截断: 「"Route vLLM tasks across offline inference, OpenAI-compatible」 (61 字符，且带一个多余引号)
name: "repo-skills-router"                     → 「"repo-skills-router"」(技能名里连引号一起注册 → load_skill("repo-skills-router") 查不到)
description: >-  …                             → 描述字面变成 ">-"   (描述整段丢失)
description: |   …                             → 描述字面变成 "|"
正文没有 `# ` 一级标题                          → 整份 SKILL.md 被判定非法，静默丢弃
```

即：**第三方技能能装上，但技能名、技能描述、甚至整份技能都可能已经损坏** —— 技能描述正是
Codem 用来判断「该不该加载这个技能」的唯一依据，被截断就等于路由失效。

### 修复（`src/core/skill/skill.ts`）

- **标量去引号 + 反转义**：`name` / `description` / `version` / `whenToUse` 等字符串字段统一走
  `unquoteScalar`（双引号内 `\"` `\\` `\n` `\t` 反转义，单引号 `''` 还原）。
- **跨行双引号标量折行拼接**：YAML 允许长描述换行书写，解析器现在会一直读到闭合引号并按 YAML
  规则折叠为空格，不再截断到第一行。
- **块标量 `>` / `>-` / `>+` / `|` / `|-` / `|+`**：折叠式（换行转空格、空行转换行）与字面式
  （保留换行）都按 YAML 语义解析，并正确处理 chomping。
- **正文没有一级标题的技能不再被丢弃**：frontmatter 之后的内容作为技能正文（此前必须出现
  `# ` 标题，否则整份返回 null）；没有 frontmatter 的纯文本仍然不是技能。
- **市场安装保留 `.jsonl` / `.csv` 资源**：AREX 路由器的索引文件是 JSON Lines，此前会被扩展名
  白名单拦掉，装出来的路由器缺索引。

### 附带确认（不是修复，是核对过的事实，写进文档避免踩坑）

- Codem **只加载技能目录的一层子目录**里的 `SKILL.md`；AREX「路由器 + `repo-skills/<id>/` 兄弟目录」
  的原始形状正好契合：只有 `repo-skills-router` 进入技能目录，1000 个仓库根技能由路由器按需
  `read` 展开（渐进式展开，不挤占上下文）。
- 技能加载时 `<skill_resources>` 会给出技能目录绝对路径，`SKILL.md` 里的相对路径可直接解析。
- `disable-model-invocation: true` 被忽略（Codem 无「仅用户可调用」技能类别）。
- 项目根 `.codem\skills\` 只在项目管理器里展示，不注册成 `load_skill` 可调用的技能。

### 文档与测试

- 新增 `docs/AREX-SKILL-INTEGRATION.md`：三种安装方式（单技能 / 整库+路由器 / DisCo 官方导出）
  的可执行命令、实测体积（vllm 35 文件 217 KB、router 204 文件 1.6 MB）、验证清单与边界。
- 新增 `src/test/agent-skills-compat.test.ts`：16 个用例，含上游真实 `SKILL.md` 片段、
  块标量五种写法、跨行标量后继续解析后续键、目录布局契约（只有 router 可注册）。
- 全量校验：tsc 0 错误 / 220 文件 4749 用例通过（15 skipped）/ 审计 25 条规则 0/0 /
  css-contract 2743 类无变化。

## [1.16.19] - 2026-09-13 — 修复：上下文超限后的「白重试 + 假续写」；思考模型被输出上限掐断

### 现象（用户控制台，这次给了完整真相）

```
[AgenticLoop] 本轮结束原因 finish_reason=length（达到单次输出上限，回复被截断） — iteration 1, text 0 chars, tool calls 0
[AgenticLoop] Response was truncated (finish_reason=length) — auto-continuing (1/3)
[Provider] API error: 400 {"error":{"message":"This model's maximum context length is 1048576 tokens.
  However, you requested 1048735 tokens ... Please reduce the length of the messages or completion."}}
[AgenticLoop] Iteration 2: LLM stream error (attempt 1/3 / 2/3 / 3/3)   ← 同一个必然失败的请求重试三次
… 1048992 … 1049249 …                                                    ← 而且上下文还在变大
```

三件事同时发生，互相放大：**思考吃光了输出预算**、**上下文已超上限**、**续写让上下文继续变大**。

### 三个根因（含一个是我上一波引入的）

1. **反应式压缩的判定字符串不匹配 → 本该救场的压缩从未触发。**
   代码只认 `prompt_too_long` 与 `context_length_exceeded`，而 DeepSeek 的措辞是
   `This model's maximum context length is 1048576 tokens` —— **一个都不含**。
   于是循环把同一个必然失败的请求重试 3 次，然后整轮死掉。
2. **确定性错误被白重试**：4xx（非 429）重试毫无意义；而且 `classifyError` 也判不出来 ——
   因为 provider 抛出的错误**没有把 HTTP 状态挂到错误对象上**，它只看得到 message。
3. **我上一波引入的 bug**：`lastFinishReason` **跨迭代不重置** —— 某轮失败（没有任何 `finish_reason`）
   时会沿用上一轮的 `length`，触发一次毫无意义的"续写"，把已经超限的上下文又撑大
   （日志里 1048735 → 1048992 → 1049249 正是这么来的）。

### 修复

- **溢出识别改成语义匹配**（新增 `src/core/llm/provider-errors.ts`）：覆盖 `maximum context length` /
  `context_length_exceeded` / `prompt_too_long` / `prompt is too long` /
  `reduce the length of the messages` / `too many tokens` / `input is too long` 等各家措辞，
  并能解析出「上限 / 实际请求」两个数字。
- **溢出 ⇒ 走压缩（不再白重试）**：溢出错误**立即**抛给"反应式压缩"路径，压缩后继续；
  压缩 3 次仍放不下 → 明确停下（reason `context_overflow`）并给用户一句可执行说明：
  本次请求约多少 token、上限多少、超出多少，以及"开新对话 / 收敛与会话内容 / 换大上下文模型"。
- **确定性错误快速失败**：`classifyError` 结果为不可重试（非 429 的 4xx）→ 立即抛出，
  不再耗 3 次重试；provider 现在把 **HTTP 状态挂到错误对象**上（这样 500 该重试、400 不该重试才分得清），
  并把错误体给足 2000 字符（超限的关键数字不会被 200 字符截掉）。
- **结束原因每轮重置**，并且**只有本轮真的结束过**才允许续写；同时记录本轮**正文长度**，
  区分两种截断：**「正文 0 字符」= 思考把预算吃光** → 续写提示改为"少想、直接产出"，
  而不是「从断点继续」（没有断点可续）。
- **按模型族给输出上限**（第 67 波动态解析的补强）：`deepseek-flash` 这类模型**目录里查不到**
  （目录只有 `deepseek-v4-flash`），以前一律落到保守的 8192 —— 对**带思考的模型明显偏小**
  （思考 token 与正文共享预算，正是"正文 0 字符"的直接原因）。现在按族推断：
  DeepSeek 系 / 推理系 → 65536（天花板），Claude 4 → 32000，Gemini 2.5+ → 65536；
  未知型号仍走保守兜底。

### 校验

`tsc` 0 错误；**219 个测试文件 / 4729 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
新增契约 `context-overflow-handling.test.ts`（OFLOW-1~7）：**用事故现场那条真实报错体**做样本，
覆盖识别、数字解析、语义匹配替换、压缩救不回来时的说明、确定性错误不重试、状态码挂载、
结束原因每轮重置、按族推断上限。

### 教训

**错误分类不能只匹配「自家见过的措辞」**：这次就是因为只认两个字符串，一个本来能自动救场的
压缩路径形同虚设 —— 而日志里那句 `maximum context length is ...` 一直在明明白白地说清原因。

## [1.16.18] - 2026-09-13 — 修复：回复被输出上限截断时「任务又中断了」

### 现象（用户控制台）

用户说"继续之前没完成的任务"，然后**一轮就结束了**：

```
[AgenticLoop.run] sessionId: 1787630173686-ogk8e1sw4, userMessage: 继续之前没完成的任务...
[AgenticLoop] Single-response dedup: 0 tool calls in this response: []
[LLMEngine.resolveSlot] slot=memory → ...
[extractMemories] Extracted 15 memories from session ...
```

没有报错、没有重试，直接进入记忆抽取 —— 表现就是"任务又中断了"。

### 根因

**`finish_reason === "length"`（达到单次输出上限、回复被截断）此前只用于"内容型工具"的提示，
从不参与"要不要停"的判断。** 于是被截断的回复（尤其是**纯文本、没有工具调用**的那种）
被当成"写完了"，循环以 `completed` 收尾。控制台里连 `finish_reason` 都看不到（它写在
默认静默的 `debugLog` 里），所以只剩"莫名其妙断了"这一种观感。

### 修复

- **截断 ⇒ 自动续写**：`finish_reason=length` 时注入一条"**从断点继续**"的提示并继续循环 ——
  明确要求：不要重复已输出内容、长文件改用 `write` + `append: true` 分块落盘、已写完就直接说明。
  界面上会显示"⏩ 上一条回复因达到输出上限被截断，正在自动续写…"。
- **续写有预算**（3 次）：用完则**明确停下**并给出下一步（分块写入 / 调大 `maxTokens`），
  停止原因是 `output_truncated`（结构化事件 + 用户可见说明），而不是静默结束。
- **结束原因进入循环状态**：provider 的 `end` 事件不会向上游 yield，所以把它写进 `LoopState.lastFinishReason`
  —— 主循环的停止判断这才看得见它。
- **非正常结束原因默认可见**：`finish_reason` 不是 `stop`/`tool_use` 时打一条 `console.warn`
  （例如 `length（达到单次输出上限，回复被截断）`），下次一眼能看出是哪种结束。

### 校验

`tsc` 0 错误；**218 个测试文件 / 4722 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
新增契约：`output-truncation-continue.test.ts`（TRUNC-1~5 源级 + **行为测试**）
与 `output-truncation-behavior.test.ts`（TRUNC-B1~B3：用脚本化 provider 真跑循环 ——
截断后**必须再请求一次**、连续截断到预算用完以 `output_truncated` 停止、正常回复不受影响）。

## [1.16.17] - 2026-09-13 — 输出上限按模型动态解析（被拒自动降档）+ 同类问题清查

### 起因（用户追问）

上一版我说"若某个模型拒绝 8192，把设置里的 maxTokens 调小即可"。用户指出这不对：
**maxTokens 应该按模型上限动态取，或者在被拒绝时临时调整**。这个批评是对的 ——
而且查下去发现**模型目录里本来就有**每个模型的 `maxOutputTokens`，我那个常量只是兜底：

| 模型 | 目录里的 maxOutputTokens |
| --- | --- |
| `deepseek-v4-flash` / `deepseek-v4-pro` | 384000 |
| `gpt-4o` / `gpt-4o-mini` | 16384 |
| `claude-sonnet-4` | 64000 |
| `moonshot-v1-8k` | 4096 |

写死一个常量的后果**两头都错**：比模型能力小 → 大文件的工具参数被截断（就是用户遇到的报错）；
比模型能力大 → 请求被 API 直接拒绝，任务当场失败。

### 改动

- **新增 `src/core/llm/model-output-limit.ts`：按模型动态解析输出上限**，优先级为
  **显式配置（智能体/槽位/设置）→ 被拒绝后学到的值 → 模型目录 `maxOutputTokens`（夹在 65536 天花板内）→ 兜底 8192**。
  目录里查不到（自定义模型）才用兜底值。
- **被 API 拒绝就自动降档并记住**（`noteOutputLimitRejection`）：折半、下限 1024、
  进程内按模型记住，**并自动重试一次**请求 —— 用户不需要去设置里手调，也不会有第二次同样的失败。
  判定刻意保守：只有 **400/422 + 明确提到 max_tokens + 像「值不合法/超限」** 才算，
  避免把内容审核之类无关的 400 当成上限问题反复重试。
- **顺带修掉另一处同类硬编码**：ultra 模式原本 `Math.max(config || 4096, 16384)`，
  对 `moonshot-v1-8k`（上限 4096）会直接把请求打挂 —— 现在同样按模型目录夹住。

### 同类问题清查（"静默丢数据"这一族）

修完第一个问题后按同一根因把同类地方都查了一遍：

| 位置 | 结论 |
| --- | --- |
| `provider.ts` 的 SSE 坏行 catch | **真问题**：以前只 `console.warn` 就把整行丢掉 —— 若丢的是 `tool_calls` 参数增量，累积出的 JSON 就是残缺的（**与「截断」完全同一现象**）。现在**计数**，并在 `tool_use_end` 上标注"参数可能不完整"，由循环拒绝执行并引导重试 |
| 回复因输出上限结束（`finish_reason=length`）+ 跑了内容型工具 | **真问题**：参数 JSON 可能「恰好」完整而内容被切在合法边界上。现在追加"请核对文件完整性并用 append 补齐"的提示，并落结构化事件 `output_truncated` |
| `write` 把**已有非空文件**写成空 | **真问题（静默破坏）**：现在结果里明确警告并带上原文件大小，让模型有机会发现是自己搞错了 |
| `read` 截断 | ✅ 已有明确提示（`… (showing lines X-Y of Z total lines; use offset to continue reading)`） |
| 工具结果过大落盘失败 | ✅ 有明确提示（`... (truncated, output too large, disk persistence failed)`） |
| 上下文预算内截断工具结果 | ✅ 有明确提示（`...(truncated for context budget)`） |
| 终端/附件/记忆压缩 | ✅ 分别是 `[output truncated]` / `[Preview truncated…]` / 显式占位符 |

### 校验

`tsc` 0 错误；**216 个测试文件 / 4714 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
新增契约 `model-output-limit.test.ts`（OUTLIM-1~7 动态解析与降档、SAMECLASS-1~3 静默丢数据清查）：
按模型取值不同、显式配置优先、自定义模型兜底、被拒折半并记住、拒绝判定保守、
主链路真的接上、目录查找兼容三种形状。

## [1.16.16] - 2026-09-13 — 修复：大文件写入时「工具参数被截断」，以及一个数据安全级隐患

### 现象（用户控制台截图）

用户让模型用技能生成科研绘图，模型选择"先写一个 Python 脚本再跑它"（脚本约 6–10KB），
控制台反复出现：

```
SyntaxError: Unterminated string in JSON at position 6648
SyntaxError: Unterminated string in JSON at position 6348
SyntaxError: Unterminated string in JSON at position 2080
[Provider] Failed to parse tool args: {"content": "# -*- coding: utf-8 -*- ..."}
[AgenticLoop] Failed to parse tool args: {"content": ...}
Single-response dedup: 1 tool calls in this response: [write("")]
```

即**工具参数的 JSON 在字符串中间被切断**，同一个 `write` 反复失败、任务卡住。

### 根因（两层）

1. **单次输出上限被写死成 4096**（`index.ts` 的默认值 + `processor.ts` 的 `?? 4096`）。
   一个 6–10KB 的脚本连同 JSON 转义正好在这个量级 —— 流在字符串中间被 cap 掉，
   于是参数 JSON 天生不完整。
2. **参数解析失败时的处理是"静默降级 + 正则兜底"，而且兜底比不兜底更危险**：
   provider 解析失败只打一行日志，然后照旧返回 `input: {}`；
   循环再用正则从残缺 JSON 里抽 `path`/`content` —— 而截断时**结尾引号还没生成**，
   正则匹配不到 → `content` 取空串 → `write` 拿着**空内容**执行。
   对已存在的文件，这就是**把文件清空**（覆盖保护在 auto/full 模式下不拦）。

### 修复

- **输出上限**：新增常量 `DEFAULT_MAX_OUTPUT_TOKENS = 8192` 并统一使用（原 4096），
  仍然可配置（`codem-settings.maxTokens` / 智能体级 / 槽位级都可覆盖）；
  `processor` 不再硬编码 —— 未配置时不发 `max_tokens`，由 provider 用自己的上限。
- **参数不可用 ⇒ 一律拒绝执行**（`src/core/llm/tool-args-guard.ts`）：
  删掉了"正则抽 path/content"的兜底，改为把原因与长度带出来，并给模型一句**可操作**的指引：
  「这次调用没有执行；原因是单次输出过长被截断（如果结束原因是 `length` 会明确写"已确认"）；
  请分块写入：先 write 第一段（≤~200 行），后续用 `write` + `append: true` 追加；不要原样重发」。
- **`write` 支持 `append: true`**（生成大文件的分块落点），并在 `content` 不是字符串时直接报错 ——
  绝不用空值覆盖文件。指导语也写清了"大文件要分块"。
- **provider 不再静默降级**：解析失败会把 `argsParseError` + `rawLength` 带到事件里
  （正常结束与"无 finish_reason 兜底"两条路径都带）。
- **可观测**：这类拒绝执行会落一条结构化事件（`loop_stopped` + reason `args_truncated`，
  含工具名与原始参数长度），便于统计"到底多常见"。

### 本轮审计还修掉的（同一波内自查）

- **provider 报错但没有 rawArgs 可重试时，仍可能带着空参数执行** → 已补上这条分支，同样拒绝执行。
- 提示里补上**结束原因**：`length` 时明确写"已确认是达到输出上限"，不让用户猜。
- 另一处残留的硬编码 4096（`getLLMEngine` 的默认配置）一并收口到常量。

### 校验

`tsc` 0 错误；**215 个测试文件 / 4704 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
新增契约 `tool-args-truncation.test.ts`（ARGS-1~7）：内容型工具识别、提示三要素、`length` 确认、
"不允许再从残缺 JSON 里抽 content"、provider 必须带错误与长度、上限不再是 4096、append 分块可用。

## [1.16.15] - 2026-09-13 — 把「卡住」治理从止损补齐到五层（预防 / 收敛 / 止损 / 恢复 / 可见）

### 背景

上一版（1.16.14）把判据从"时钟与次数"换成了"沉默与信息增益"，但仍留着我自己指出的两个洞：
**①每次输出都略有不同的空转抓不住**（内容确实变了）；**②检测到之后只会"停"，不会"救"**。
这一版按"让目标可判定 → 让状态可观测 → 让成本有界 → 让干预便宜且能恢复"补齐。

### L1 新增：计划停滞检测（补上"输出一直在变、任务一步没走"）

- 新增 `src/core/llm/stall-guard.ts`：判据**与内容无关** ——
  「模型没有修订计划（`update_plan`）+ 没有产出任何交付物（写入/编辑/会改盘的命令）」。
  连续 12 个迭代 → **先"问"**（注入一个聚焦问题：卡在哪、下一步做什么、要不要改计划）；
  再连续到 24 → 才停（reason `plan_stale`）。
- **审计修正**：一开始用「计划标题 + `macroStep`」当推进指纹，但 `macroStep` 是 **UI 启发式步进**
  （每个迭代首次出现"非侦察类工具"就 +1），会让停滞检测被不断清零、等于失效。
  改成只认**真正的计划修订**（`update_plan` 成功时 `planRevision++`）。
- **审计修正**：`git status` 这类**只读查询**不再算"产出交付物"（否则反复查 git 的会话永远判不出停滞）。

### L3 新增：先"问"再"停"（恢复，而不是只止损）

- 停滞提醒会作为一条系统提醒注入对话（要求：一句话说清卡点 + `update_plan` 或直接报告缺什么），
  **不打断、不杀**。只有提醒之后仍然毫无推进才停。
- **审计修正**：停滞检测排在"重复调用守卫停止"**之后** —— 否则两者同时成立时会先注入一条
  "进度自查"消息、紧接着循环就停了，留下一条没有下文的孤儿消息。

### L2 修正：长工具不再被当成"沉默"

- **审计发现**：一个跑了 10 分钟的构建/测试**期间本来就没有事件** —— 空闲看门狗会把它当卡死砍掉，
  父会话也会看到"安静 3 分钟"而误判。现在按 DSH 的思路把两种语义拆开：
  · **空闲**（`idle`）：**既没有事件、也没有工具在跑**，连续 5 分钟才判停摆；
  · **工具挂死**（`tool_hung`）：单个工具**在飞**超过 20 分钟（`toolFlightMs`）才算挂死
    （正常情况下工具自带超时会更早触发）。
- 工具在飞期间每 30 秒心跳：给看门狗续命 **并上报进度**，于是父会话的"它还在干活"判定也正确。
- **资源预算修正**：原来只统计模型吐出的文本，**严重低估**（真正吃上下文的是工具入参/结果）——
  现在把工具入参 + 工具结果一起计入；默认预算从 `0（不限）` 改为 **200k 估算 token**
  （第三类打转只有资源上限兜得住）。

### L0 升级：交接判据必须**可判定**

- 原来只校验有没有"完成判据"字样，于是「完成判据：全部完成」这种空话也能过 ——
  接收方拿不到任何可检查的东西，继续瞎找。现在要求判据句里出现**可检查的对象**之一：
  一个会存在的文件（带扩展名）/ 一条反引号包起来的命令 / 一个可比的量（2900–3100 字、≥3 个章节、100%）。
- 模板同步更新；校验仍然**会放手**（连续被拒 2 次后放宽），不会把委派功能锁死。

### L4：四类停止原因结构化落库

- 新增 `src/core/llm/loop-stop-log.ts`：`no_gain` / `idle` / `tool_hung` / `plan_stale`（含 `_ask`）/ `budget`
  统一写入 EventLog 的 `loop_stopped` —— 这样才能统计"到底哪种卡法最多"、据此决定下一步优化哪个。
- **审计发现**：循环因停滞/打转停止时，即使模型吐了文字，也**不能当成"任务完成"上报给父会话**
  （父会话会拿着半成品继续往下走）。现在按**失败**交回，并把已产出内容一起附上。

### 校验

`tsc` 0 错误；**214 个测试文件 / 4696 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
新增契约：`stall-guard.test.ts`（STALL-1~9）、`idle-watchdog.test.ts`（IDLE-1~6）、
`loop-guard.test.ts`（GUARD-1~16）、`handover-protocol.test.ts`（HANDOVER-1~10）、
`core-delegation-orchestration.test.ts`（DELE-030~048）。

## [1.16.14] - 2026-09-13 — 用「信息增益」和「沉默」替代时钟与次数（对齐 DSH 的实现）

### 背景

用户质疑：`15 分钟墙钟 / 3 分钟单次等待 / 8 分钟累计 / 第 10 次就停` —— **拿时间和次数做可靠性有问题吧？**
**这个质疑是对的**，我上一版那套是错的：

- 合法的长任务（装依赖、跑全量测试、编译）很容易超过 15 分钟 → **会被误杀**；
- 而"还在产出废话"的死循环在到点前谁也拦不住 → **该拦的拦不住**；
- "同一目标枚举到第 10 次就停"是**拿次数当可靠性**：正常的"列目录 → 读文件 → 再列目录"会被误杀，
  而"换十几种写法拿到同一份内容"这种真打转反而要数到 10 次。

于是去读 DSH 的真实实现（本机 `app.asar.unpacked/node_modules/@deepseek-ai/`，未打包），
结论很清楚 —— **DSH 根本不用这两个轴**：

| 轴 | DSH 的做法（可核对的文件） | 说明 |
| --- | --- | --- |
| 时间 | `dsh-timeout/lib/index.js` 的 **`idleWatchdog`**（LLM 流默认 300s） | **只测"沉默"**：定时器只在"等下一个 chunk 期间"存在，有进展就 `pulse()` 重新上弦；文档明确写"消费者的思考时间不算 provider 空闲"。`<=0` = 不设上限 |
| 时间 | 同文件的 **`deadline`**（文件 API 60s；bash/pwsh 默认 120s、上限 600s，且**每次调用可自带**并用 `clampTimeout` 夹住） | 绝对截止只用在**单次能力调用**上，**不是**"整轮任务" |
| 次数 | `dsh-agent/lib/index.js`、`dsh-agent-loop/lib/index.js` | agent 循环里**没有迭代上限、没有"无进展"计数器、没有重复调用守卫** —— 它不做次数治理 |
| 上限 | `AGENT_LOOP_SETTINGS_SCHEMA`（`maxParallelToolCalls` / `maxTokens` / `streamIdleTimeoutMs`） | 上限是**用户可配的设置项**，不是散落的魔法数字 |
| 中止 | 全链路 `AbortSignal`（可 fusion） | 而不是"到点抛异常" |

### 改动

- **新增 `src/core/session/idle-watchdog.ts`（对齐 DSH 语义）**：`idleWatchdog(upstream, idleMs, code)`
  + `pulse()` 重新上弦 + `idleTimeoutOf()` 取回能力自己的错误码 + `idleMs <= 0` = 不设上限。
- **后台/委派会话：删掉「15 分钟墙钟」，改用它** —— 每收到一个事件就 `pulse()` 一次，
  只有**连续 `turnIdleMs`（默认 5 分钟，对齐 DSH 的流空闲默认值）一个事件都没有**才中止。
  **合法长任务只要还在产出就永远不会被杀**；上限另外用**资源**表达（`turnTokenBudget`，估算 token，0=不限）
  —— 上限用资源不用时钟。
- **重复调用守卫：判据从「次数」换成「信息增益」** —— `noteResult()` 比较**结果内容**：
  「连续 N 次拿到**已经见过的内容**、且期间没有任何写操作」= **可证明的零进展**，才升级到
  提醒(2) → 跳过(4) → 停(6)。**结果一变就是有进展，永远不拦**（哪怕同一个命令跑 30 次）。
  旧的「枚举到第 10 次就停」已删除；枚举计数只留作文案提醒（"你在反复看同一个目录"），**不作为拦截依据**。
  另外：被判定零增益的只是**那一个签名**，**换新手段一律放行**（否则模型永远没法改策略 —— 这正是旧版的毛病）。
- **委派等待：删掉「单次 3 分钟 / 累计 8 分钟」，按活动返回** —— 任务结束就返回结果；
  子会话**连续 `waitIdleMs` 没有任何进度上报**（= 它安静了）才带进度返回；**一直在产出就一直等**。
  「反复查看」的判据也换成"两次查看之间有没有新进展"，不再数次数。
- 三个窗口（`waitIdleMs` / `turnIdleMs` / `turnTokenBudget`）都是**配置项**，写清了每个数字的语义与来源。

### 校验

`tsc` 0 错误；**213 个测试文件 / 4680 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
新增契约：`idle-watchdog.test.ts` IDLE-1~6（含"干一小时也不被杀""`<=0` 不设上限""上游取消不算空闲超时"）、
`loop-guard.test.ts` GUARD-1~16（含"30 次调用但结果一直不同 → 永远不拦"）。

## [1.16.13] - 2026-09-13 — 审计收尾：把「子会话卡住」变成界面上可见、可终止

### 修复

- **任务中心（委派页签）现在显示子会话进度**：`已调用工具 N 次 · 最近：<某个工具/命令>`。
  第 62 波起子会话就会定期上报进度，但**界面一直没有消费** —— 等于"上报了但用户看不到"，
  用户仍然只能看着"执行中"三个字干等。
- **运行中的委派任务多了「终止」按钮**：点击后**先掐掉子会话的后台循环**（`cancelSessionExecution`），
  再置任务为已取消。顺序不能反 —— 反了的话子会话的收尾回调可能把它改回"已完成"
  （服务端的同名修复见 1.16.12 的 `completeTask` / `failTask` 守卫）。
- 至此「子会话原地打转」三处都能停：**模型**（重复调用守卫自动停）、**父会话**（`cancel_delegation` 工具）、
  **用户**（任务中心按钮）。

### 校验

`tsc` 0 错误；**212 个测试文件 / 4674 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
新增契约 `DELE-044`（进度必须可见、终止必须先掐循环再置状态）。

## [1.16.12] - 2026-09-13 — 自我审计：给上一版的「原地打转」修复找茬，并补上治本的那一半

### 背景

用户要求审计 v1.16.11 里那套「重复调用守卫 + 等待预算」：**它算不算好方案？有没有治标不治本？**
审计做了三轮（第一轮查自己刚写的东西，第二轮查修复引入的新路径，第三轮查整体一致性），
**查出 11 个真问题，全部修掉**。其中 5 个是上一版**我自己引入**的缺陷。

### 修复（上一版修复自身的缺陷）

- **拦截结果曾经返回 `status:"error"`** —— executor 会把 error 结果抛成 `tool_error`，而
  `tool_error` 会累加 `consecutiveErrors`（上限只有 **3**）。于是「第 7 次抑制 / 第 10 次停」
  **根本走不到**：循环先以「连续错误过多」停掉，用户看到的是"出错了"，而不是"你在原地打转"。
  现在拦截结果返回 `completed`，阶梯照设计生效，停止理由也对了。
- **守卫状态按「会话」累积而不是按「轮次」** —— `AgenticLoop` 是按会话缓存复用的，我最初把重置写在
  构造函数里，于是几轮之后第一次读同一个文件就会莫名收到「重复调用被跳过」。现在在 `run()` 开头重置。
- **精确指纹曾经整体转小写** —— 在**大小写敏感**的文件系统（macOS / Linux）上会把 `a.txt` 与 `A.txt`
  当成同一次调用，**误拦一次合法读取**；而且截断到 400 字符会让两条长命令只要前缀相同就相撞。
  现在只压缩空白、键保留全文（大小写合并交给"枚举意图指纹"，那里只影响循环判定）。
- **精确重复没有「停」档** —— 抑制只是"不给执行"，模型可以原样再叫一次，而每次被抑制的调用仍然走一遍
  工具事件 → 无进展阀门永远不触发 → **抑制本身变成新的死循环**。现在精确档也有停档（第 8 次）。
- **被拦下的调用仍被算作"有效工具调用"** —— 于是"这一轮有进展"，runaway 阀门同样不触发。
  现在从有效调用数里扣掉被拦截的部分。

### 修复（修复引入的新路径 + 第二轮发现）

- **取消会被悄悄改回"已完成"**：取消是异步的（abort 信号），子会话的循环往往还会跑到收尾逻辑，
  而 `completeTask` / `failTask` 会无条件覆盖状态 —— 用户点了"终止"却看到任务变成已完成。
  现在 `completeTask` / `failTask` 不再覆盖 `cancelled`，executor 在被 abort 时也不上报完成。
- **等待不再阻塞之后，出现了新的空转路径**：总预算用完后每次查看都是**秒回**，模型可以「查一下、再查一下」。
  现在同一个委派任务一轮内最多查看 3 次，超过就抑制并要求"要么报告、要么取消"。
- **交接校验不能把功能锁死**：如果模型始终写不出合规交接，硬拦等于让"委派"彻底不可用。
  现在连续被拒 2 次后**放宽放行**（把缺什么写在返回里），并给接收方注入兜底提示：
  **缺信息就报告缺什么，不要靠反复枚举/递归扫描去猜**。
- **守卫抢了更友好的缓存回复**：守卫原先排在 `read`/`write` 缓存之前，会把"这就是你之前读到的内容、
  直接用"这种更有用的回复顶掉。现在 `read`/`read_file`/`write` 交给各自缓存（`wait_for_delegation`
  同理），守卫只管其余工具。
- **枚举历史的清零判据曾经按"指纹是否见过"** —— 而事故里那 17 条命令**每一条都是新的精确指纹**
  （开关不同），按指纹判会把计数一路清零、反而永远抓不到打转。现在按**分类**判：
  「干了别的事（非枚举调用）」才算有进展，纯枚举序列依旧会被拦。
- **交接的路径要求放宽一档**：绝对路径仍是首选，但指向具体文件（相对路径 / 带扩展名的文件名）也算合格 ——
  减少误拒；只有「纯意图、没有任何具体对象」的交接才拒绝。

### 治本的那一半（第 62 波只是安全网）

- **新增 `src/core/session/handover.ts`：交接协议 + 机械校验**。交接必须是「**状态 + 指针 + 完成判据**」，
  不是「意图复述」：缺产物绝对路径/具体目标、缺完成判据、或超过 12000 字硬上限 → **拒绝并给出改写模板**；
  超过 4000 字软上限 → 放行 + 提醒（把细节写文件、正文只留摘要 + 路径）。
- **`delegate_to_session` 接上校验**（合规才创建任务），并新增 **`cancel_delegation`** 工具：
  父会话发现子会话打转后可以**终止**它，而不是只能干等或等墙钟上限。
- **系统提示词新增「Writing a Handover」章节**：给出填写模板，并明确写出
  "接收方没有你的对话历史，交接要交状态与指针"、"必须给完成判据"、"不要重新扫描目录"。
- **等待的**累计**预算**（默认 8 分钟）：单次 3 分钟预算不够 —— 「等一轮再等一轮」照样能黑等半小时。
  累计用完后等待**立即返回进度**（只查看、不阻塞），但任务完成时仍立刻返回结果（不会漏掉结果）。

### 审计方法（这套做法本身值得复用）

1. **先怀疑仪器**：上一波写检测器时 12 个"发现"全是仪器坏了 —— 所以每写一个检测器/守卫，
   都要有"它自己会不会错"的用例（本波 `GUARD-0` / `SKEY-0` 就是干这个的）。
2. **把自己的修复当别人的代码再审一遍**，重点查三件事：**新的循环路径**（不阻塞之后会不会空转）、
   **状态机的覆盖关系**（取消会不会被完成覆盖）、**误杀面**（大小写、长参数、正常迭代工作）。
3. **每条阈值都要能对上现实机制**：这次"第 7 次抑制"之所以走不到，是因为 executor 把 error 当
   `tool_error` 累加、上限只有 3 —— 阈值写在守卫里，机制却在 executor 里，**必须真的走一遍事件流**。

### 校验

`tsc` 0 错误；**212 个测试文件 / 4673 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。
**新增契约**：`loop-guard.test.ts` GUARD-1~17（含事故现场 17 条真实命令）、
`handover-protocol.test.ts` HANDOVER-1~10、`core-delegation-orchestration.test.ts` DELE-030~043。

## [1.16.11] - 2026-09-13 — 死字段排查 + 智能体「原地打转」与交接「黑等」修复

### 修复（智能体原地打转：十几分钟不出结果）

- **交接出去的新会话连续几十次枚举同一个目录**（只换 `-Force` / `-LiteralPath` / `Out-String -Width`
  这类装饰性开关），一路转到**父会话等待超时**，十几分钟没有任何产出。两道既有阀门都看不见这种打转：
  ①「连续无进展」阀门把「有工具调用」一律算作**有进展**（每次枚举都成功返回内容，计数器每次被清零）；
  ② 同轮次去重只覆盖 `read`（同 path+range）与 `wait_for_delegation`（同 task_id），**bash 换个写法就绕过去**。
- **新增重复调用守卫 `src/core/llm/loop-guard.ts`**，两把尺子：
  · **精确指纹**（工具 + 归一化参数）反复调用 → 第 3 次提醒、第 5 次抑制；
  · **意图指纹**（只读目录枚举按目标路径归并，忽略装饰性开关）→ 第 4 次提醒、第 7 次抑制、
    **第 10 次直接停下整个循环**并说明「别再枚举，去读文件或直接报告缺什么」。
  任何写操作都会重置计数（世界变了，重新枚举是合理的），认不出来的命令只参与精确指纹
  —— 宁可漏判，也不误杀正常的构建/测试命令。
- **`wait_for_delegation` 不再无限期阻塞**：单次等待有预算（默认 3 分钟），到点**带着进度返回**
  （已跑多久、调了多少次工具、最近一次工具是什么、子会话最新输出），父会话可以再等一轮、先看
  `query_session_result`、或先做别的事。任务本身仍不设超时，取消仍走 abort。
- **后台/委派会话加墙钟上限**（默认 15 分钟）：到点强制中止，并按「**部分完成**」把已有产出交回去
  （原实现会把打转十几分钟的结果当成正常结束回传）。
- **日志修好了**：`Single-response dedup` 那行原先只打印 `task_id` / `path`，于是 bash 一律显示成
  `bash("")` —— 恰恰在最需要看命令的时候看不见命令。现在带出命令本身（截断）。

### 修复（死字段：设置项「存了不生效」「读了没人写」）

- **「对话显示模式」改了不生效**：`codem-display-mode` **只写不读** —— 设置页能改、值也真存进了数据库，
  但全项目没有任何一处读回来，重启后永远回到默认值。现在启动时（数据库就绪后）读回并应用。
- **「代码图谱索引检测」永远检不到**：它读 `codem-current-project-path`，而**全项目没有写入方**，
  拿到的永远是空串。改为读项目 store 的 `currentProject.path`。
- **两处 `getSetting(键, 默认值)` 多传了一个参数**（`system-prompt-instructions`、`ui-language`）：
  `getSetting` 只接受一个参数，第二个实参被**静默忽略** —— 而这两个文件带 `// @ts-nocheck`，
  类型检查也拦不住。已改为单参数调用。
- **删掉 3 个零读取方的死配置字段**：`defaultSettings.theme` / `mimoPath` / `autoApprove`。
  其中 `theme: "dark"` 与真实默认档 `DEFAULT_THEME = "light"` **互相矛盾**：旧版保存任意设置都会把
  整份默认对象写进 `codem-settings`，于是"从设置对象读主题"的路径会把默认档变成暗色。
- **删掉 7 个死 CSS 令牌**（22 行定义）：`--elevation-2`、`--composer-*`、`--surface-3`、
  `--message-bubble-*`、`--composer-bg`/`--composer-border`、`--titlebar-bg` —— 全项目零引用。

### 工程

- **新增契约测试 `src/test/settings-keys-symmetry.test.ts`（SKEY-0~4）**：机械对账「每个设置键都必须
  既有写入方、又有读取方」，扫到 **810 个文件 / 251 个取键调用点 / 70 个键**；真正的"只读旋钮"
  （手工配置的高级项）必须写进白名单**并附理由**，白名单里的键消失也会报红，防止清单长草。
- **顺带修好了这个检测器自己的 4 类误报/漏报**（第一版报了 12 个键，**全是仪器坏了、不是代码有病**）：
  ① 把 `key.startsWith("codem-")`、`addEventListener("codem-open-file")`、`new CustomEvent(…)`
  里的字符串当成了设置键（事件名与前缀判断同样以 `codem-` 开头）；
  ② 把读取别名 `settings(...)`（= `__codemSettings.getSettingJSON`，恰好以 `set` 开头）判成写入；
  ③ 6 个模块各自声明的 `SETTINGS_KEY` 在全局「常量名→键值」表里互相覆盖，**6 个键被悄悄并成 1 个**
  （改为按文件隔离 + 全局兜底）；
  ④ 泛型组写得过宽，`getSettingJSON<Record<string, any>>(KEY, …)` 的匹配从**类型名 `Record`** 起头、
  跨行吃到下一行的键，把真正的调用点整个吞掉。
  现在 SKEY-0 会把上面每一种形状都钉成断言 —— **仪器也要被自检**。
- **新增契约测试 `src/test/settings-effect.test.ts`**：对称性只能证明"有人读、有人写"，
  证明不了**读到的值被用上**。这三条接线断言补的正是这一格 —— 启动路径必须读回并应用显示模式、
  索引检测不得再读没有写入方的键、设置页能改的键应用侧必须有人读（判定复用同一个扫描器，
  扫描器本体提取到 `src/test/helpers/settings-key-scan.ts`，避免"从测试文件 import 测试文件"
  把对方的用例重复注册）。
- **新增审计规则 `css-var-unused`**（warn，带豁免清单与理由），锁住"定义了但没人引用"的令牌。
  首跑同时报出 9 个由 JS 注入、CSS 里从未消费的皮肤令牌（`DREAM_CSS_VARS`），已连同理由写进豁免清单
  （删它们属于皮肤重设计的决定，不在本轮）。
- **新增契约测试 `src/test/loop-guard.test.ts`（GUARD-1~12）+ `DELE-030~035`**：守卫的断言直接用
  **事故现场那 17 条真实命令**（原样抄自控制台日志）—— 要求它们全部被识别为「只读目录枚举」、
  并且**塌缩成两个意图指纹**（项目根目录 / 课题2 子目录）。这是"守卫真的能拦住这次事故"的唯一可信证明，
  远强于我构造几条漂亮样例。另含：不同目录互不牵连（不会因为"总次数"提前拦）、中途写过文件即重置、
  写入类命令（含重定向 / git / npm / 解释器）不被误判成枚举、自带缓存的工具不再叠一层。

### 排查方法（可复用于同类"卡住"问题）

1. **先看是不是"有进展但没意义"**：把日志按工具名分类，统计**同一目标的调用次数**。
   本次一跑出来就是 30+ 次 `Get-ChildItem` 打在两个目录上。
2. **再确认阀门为什么没拦住**：读「无进展」判据的**进展定义**——如果"成功返回内容"就算进展，
   那任何"反复读同一个地方"的循环都拦不住。
3. **最后看权限/上限**：后台会话有没有迭代上限、父会话等待有没有预算。
   本次两处都是"设计上不设上限"（`maxIterations: 0`、等待"不设超时"），于是没人喊停。

### 排查结论（未修，需要产品决定）

- `codem-figma-token` **只读、且没有设置界面**，但 `figma-fetch.ts` 的报错文案仍在提示用户"去设置里配置"
  —— 文案指向一个不存在的入口。要么补设置项，要么改走环境变量。
- `agentsMdMaxBytes`（AGENTS.md 读取上限）是只读旋钮，无写入方，只能手工改库 —— 已登记白名单。
- 9 个皮肤令牌由 JS 注入但 CSS 从未消费（同上）。
- `ConversationComposer.tsx` / `ConversationSession.tsx` 全项目零引用，但它们是
  `conversation.composer.bar` / `conversation.composer.dock` / `conversation.session.header.actions`
  三个插槽**唯一**的消费者 —— 删除会连带作废这三个扩展点，属架构决定，本轮不动。
- 262 个源文件带 `// @ts-nocheck`（其中 196 个在 `src/core/provider/`）—— 这是上面「多传参数」类
  静默 bug 能潜伏至今的原因。

### 校验

`tsc` 0 错误；**211 个测试文件 / 4650 条用例通过**（+15 skipped）；UI 审计 **25 条规则 error 0 / warn 0**；
CSS 生效取值快照（2743 个类）**无变化**；打包成功。

## [1.16.10] - 2026-09-11 — 修复：启动时先闪一下「相反的主题」

### 修复

- **启动加载期间的底色不再与当前主题相反**（老问题）：暗色主题的用户启动时先看到白色、浅色主题的用户
  先看到黑色，偶尔还会出现「黑 → 亮 → 黑」三段跳。现在启动第一帧就是当前主题的底色。
- **根因**：主题存在「真相源（数据库）」与「首屏镜像（localStorage）」两份，**但两者从不校准**；
  而标题栏的主题初值写的是「数据库 → **默认档**」——启动早期数据库还没就绪，于是它用默认档
  **覆盖**了首屏已经渲染好的正确主题，`data-theme` 抖动一次（这就是那三段跳），
  **同时把镜像也改成了默认档** —— 镜像因此长期停在错的档位，导致**每次启动都闪**。
- **修复**：统一成一个启动期解析器「数据库（就绪后）→ 镜像（首屏预测）→ 默认档」，
  标题栏 / 外观设置 / 皮肤管理器全部走它，不再各自兜默认档；应用主题改为**幂等**
  （档位没变就不碰 DOM、不重写镜像），启动期间不再有任何主题抖动。
- **顺带补一层首屏画布底色**：`html` / `body` / 根节点此前全是透明，窗口本身也是透明的，
  第一帧底色只能靠浏览器默认处理；现在显式给主窗口一层跟随主题的画布底色（宠物窗口刻意排除）。
- 实测（无头浏览器 + 真实 CSS）：镜像为暗色时首帧画布与启动页都是 `rgb(14,15,15)`，
  浅色时为 `rgb(252,252,251)`，无镜像时走默认档 —— **首帧与"上次实际生效的档位"一致**。

### 工程

- 新增 `src/test/theme-boot.test.ts`（8 条契约）：解析器优先级（含垃圾值回落）、
  应用主题的幂等性（同档位不写 DOM / 不写镜像）、**复现用户场景**（预渲染暗色后启动路径不得改成浅色；
  数据库纠正后镜像必须跟着校准，否则下次启动还会闪）、真执行 `index.html` 内联脚本验证首屏属性、
  启动路径源码不得再各自拼默认档、首屏画布规则存在，外加两条真浏览器首帧渲染断言。
- 反验：把标题栏的主题初值改回旧写法，契约立刻变红。
- 说明：升级到本版的**第一次**启动仍可能切换一次（旧版本写坏的镜像要等数据库就绪后才能纠正），
  之后每次启动都不再闪 —— 这是「镜像只能预测、不能替代真相源」的固有限制。

## [1.16.9] - 2026-09-11 — 光标看不清 + 控制台噪声：两处「可见性」修复

### 修复

- **对话编辑区打字的输入光标不再看不清**（默认皮肤暗色主题）：光标此前用的是品牌紫
  （`#7c6cf0`），落在近黑背景上对比度只有 **4.33:1**，而同一处的正文文字是 **11.67:1** ——
  一根 1px 的闪烁竖线只有文字三分之一的可见度，等于"找不到光标在哪"。
  现在光标跟随**可见文字颜色**（新增 `--caret-color` 令牌，取 `var(--text-primary)`）：
  暗色 **11.67:1**、浅色 **16.50:1**，与它旁边的文字完全一致；皮肤也可以覆盖这个令牌。
- **`Service "snapshot" not available, falling back to singleton` 不再刷屏**：这条警告此前**每次工具调用
  都会打一遍（还带调用栈）** —— 一次 `write` 就打两遍。根因是快照服务本来就是**按工作目录单例**的
  （`getSnapshotService(cwd)`，文件面板和测试都这么取），**没有任何 Provider 注册过这个名字**，
  所以那句"优先从 ctx 取"必然落空。现在这一处直接走它真正的入口，不再产生任何警告。
- **其它容错回退告警改成"只报一次"**（权限、遥测、转录缓存、消息存储、视觉代理、事件日志、文件变更追踪）：
  回退本身就是设计好的容错（功能不受影响），但"服务没接上"值得知道一次，而不是每个工具调用一次。

### 改进

- **迭代级诊断日志默认静默**：把「每轮迭代 / 每次请求 / 每次工具调用 / 每次自动保存」的十余条日志
  收进新的调试开关，默认不再输出。需要排查时在控制台执行
  `localStorage.setItem('codem-debug', 'agent-loop,provider')` 后重载即可恢复
  （也可以设 `window.__CODEM_DEBUG__`）。收口的包括 `Iteration N: calling LLM`、
  `LLM stream ended`、`buildMessages raw`、`[Provider] stream:`、`[AutoSave] Debounce save`，
  以及 **`[Provider] Tool call end:` —— 它原来会把工具参数（含生成的文件内容）打进控制台**。
- **真信号一个都没动**：所有报错（`console.error`）、跑飞检测、崩溃修复、工具执行失败、成本降级等
  仍然照常输出。

### 工程

- 新增 `src/test/console-noise.test.ts`（LOG-1~5）：回退告警每服务只报一次（5 次调用 → 1 条）、
  快照服务不再向 ctx 索取且零告警、诊断日志默认静默（开启后才输出）、
  源码层面禁止这些文案回到裸 `console.log`、关键告警没有被误静默。
- 新增 CSS-INTEGRITY-8：光标必须走 `--caret-color`（跟随正文色、禁止用品牌色），
  并按令牌实算两档主题的对比度，**要求 ≥7:1**。
- 复用脚本思路：按「日志前缀 → 级别 → 调用点」分类，再用「是否位于循环/catch + 是否热路径文件」
  筛出可能高频的告警 —— 全项目 606 处 warn/error 中，热路径循环内的 48 处都在失败分支（真出错才打），
  只有服务回退那一处在正常路径上每次都打。


## [1.16.8] - 2026-09-11 — 修复：打开设置后全部文字变大（关了也不回退）+ 工具行没撑开/没靠右

### 修复

- **右侧栏 →【文件】→【筛选文件】搜索框里的【刷新】按钮不再偏左**：此前刷新按钮没有贴住右边缘、
  右边空了一大片（实测 724px 宽的行里差了 **527px**）。原因是这行的容器用的是「三列都按内容宽度排」的
  网格，而输入框上写的「撑满剩余空间」在网格里**根本不生效**，于是整行内容只能按内容宽度靠左排。
  现在搜索框真正撑开（占行宽约 90%），刷新按钮贴住右边缘。
- **同类问题一并修掉 4 处**（你还没遇到）：视频播放器的进度条（右侧空 **485px**）、笔记本管理工具栏的
  搜索框（空 **444px**）、MCP 市场卡片的提示文本（空 **424px**，窄卡片下还会整行溢出）、
  多模态面板页脚的「保存」按钮（空 **616px** —— 它的「靠右」写法在网格里也不生效）。
  做法同上：让该撑开的元素真正撑开、行尾按钮贴右；极窄时允许整行换行，而不是挤压变形。
- **打开「设置」不再让整个界面的文字变大**：此前点开设置，主页（左侧面板、会话标题等）的文字会突然
  放大 **7.7%**（会话标题 13 → 14.0px、项目名 14 → 15.08px），关掉设置也不复原，重启才回到原样。
- **根因**：界面字号这个设置存在**两个键**里，而且两处各带一个不同的默认值 ——
  启动时读的是「只有拖过字号滑杆才会写入」的旧键（读不到就用基准 13px），
  而打开设置时应用的是设置对象里的字号（默认 **14**）→ 于是打开设置就跳一下。
- **现在只有一个来源**：启动（数据库就绪后）、侧栏挂载、设置页打开与拖动，全部走同一个解析器，
  打开设置不再产生任何视觉变化；字号改动立即生效并**跨重启保持**。
- **兼容处理**：旧版本保存任何设置时都会把默认字号 14 一并写进设置对象，所以「14」无法区分
  「用户选的」与「从没动过」。判定为：只有**确实拖过滑杆**（存在旧键记录）时 14 才算用户选择，
  否则按未设置处理、归一为 13px —— 避免"从没动过字号"的用户被永久放大。
  设置页滑杆显示的值也同步归一，不会出现"显示 14、实际 13"。
- 顺带排查：字体粗细 `--font-weight`、字体 `--font-family` 读写的是同一个键，不存在同类跳变。

### 工程

- 新增 `src/test/ui-font-scale.test.ts`（6 条契约）：默认回落基准且缩放系数恰为 `1.000`、
  解析优先级（含"14 且无滑杆记录 = 未设置"）、越界钳制不出 NaN、
  **设置页默认字号必须等于缩放基准**（两边默认值不同正是本次 bug 的根）、
  **启动路径必须在数据库就绪后应用字号**、设置页不得再直接应用设置对象里的字号。
- 新增**真实渲染的「撑开与靠右」契约**（`fixtures/toolbar-rows-probe.html` + LAYOUT-10）：
  无头浏览器在 7 种宽度下测量「可伸缩元素是否占到 ≥25%」「未换行时行尾控件是否贴住右边缘」「是否溢出」——
  **修复前 35 个测量点全部不合格，修复后 0 个**。
- 顺带修掉测试自身的隐患：无头浏览器冷启动偶发超过默认 5s 超时，已把测量提前到只跑一次并放宽到 30s。
- 记录规范：`flex` 只对 flex 容器生效；容器改成 grid 时必须迁移子元素的 `flex` 写法
  （注意 `margin-left: auto` 在 grid 里**不**吸收行尾空白）。


## [1.16.7] - 2026-09-11 — 修复：设置里的选项标签被压成竖排 / 性能面板页签变形

### 修复

- **设置 →「通用」里的「我是什么 / 什么风格」选项不再竖着排**：这些标签按钮此前被压成 42px 宽、
  中文逐字换行，看起来是竖着的一条。根因是这些「标签墙」被改成了固定小轨道的网格布局，
  轨道比文字还窄。现在标签保持自然宽度，一行放不下就**整块换行**。
- **性能面板的【总览】【会话】【时延】不再被挤压变形**：面板一窄，页签行不再压缩按钮，
  而是把放不下的控件整块移到下一行；数据行也从固定四列改为可换行（长名字会省略号显示，
  不再把整行撑爆）；内容区横向也可以滑动，**宁可滑动也不会「溢出窗口看不到」**。
- **连同排查出的同类问题一起修（用户还没遇到的 12 处）**：MCP 工具/标签、技能标签、记忆标签、
  微信状态与操作按钮、闪卡工具栏、待发送附件、子智能体选项、工具调用组、澄清选项、
  笔记本主题标签与标签筛选、任务详情元信息 —— 这些地方此前都会被压成竖排。
  共修复 17 个容器，并给 11 类文字标签补上「不逐字换行」的保护。

### 工程

- **新增真实渲染门禁**：用无头浏览器把 17 个标签墙/工具行按真实 CSS 渲染，在 9 种宽度下
  逐元素测量**真实文字行数**与溢出，判定「短标签不得排成 ≥3 行（竖排）」与「不得溢出容器」，
  当前 153 个测量点全部正常。
- **新增静态门禁**：禁止「最小轨道 < 64px 的 auto-fill 网格」——正是本次事故的写法。
- 反验：用修复前的 CSS 跑同一探针 → **55 处异常、10 个容器中招**；修复后 → **0 处**。
- 记录一条教训：上一轮为对齐「grid 处数」这个指标而把标签墙改成网格，是把指标当成了目标；
  标签墙的正确原语是 `flex-wrap`。

## [1.16.6] - 2026-09-11 — 紧急修复：设置窗口塌成一条窄缝（内容看不到）

### 修复

- **设置窗口不再是一条 160px 的窄缝**：打开「设置」时弹窗被压缩成一条竖条、内容区只剩约 40px 宽，
  完全无法使用。原因是设置弹窗的类名被并进了「设置侧栏」那条规则里，于是弹窗继承了侧栏的
  `width: 160px`（以及纵向排列、毛玻璃底色）。已把两者分开，弹窗恢复设计宽度 760px、内容区约 598px。
- **不再依赖分辨率**：现在竖向空间不足时弹窗内容**可滚动**、不会溢出屏幕；横向空间不足时弹窗按可用
  宽度收窄，窄于 768px 时铺满窗口。已用真实浏览器在 13 种可用区域 ×（DPR 1/1.25/1.5/2）下实测确认。
- **顺带修复区块标题字重被压平**：上一轮批量合并把「区块标题（620）」和「列表项（560）」两组
  `font-weight` 并成了一条，标题层次被悄悄降了一档。已按原设计拆回两档（620 / 560）。

### 工程

- **新增「CSS 生效取值」门禁**：把每个类**生效后**的样式存成快照（2743 个类），取值一旦变化测试即失败，
  必须显式更新快照并提交 —— 这类「类名没错、取值被偷偷改掉」的问题此前 tsc、单测、审计全都看不见。
- **新增「真实布局几何」门禁**：用无头 Edge 真渲染弹窗，断言它在各种分辨率下都够宽、内容区不塌、
  窄屏走整宽（jsdom 没有布局引擎，这类问题只能这么测；无 Edge 的机器自动跳过）。
- **新增「外壳类不得与兄弟部件写进同一规则」静态检查**：正是本次事故的签名，防止同类合并事故复发。
- 排查确认：全项目仅此一处选择器列表被误改（另一处是上述字重组），其余 17 处「列表规则覆盖专属规则」
  经逐条判读均为有意的响应式/减动效覆盖。

## [1.16.5] - 2026-09-11 — 修复：「分层配置管理」弹窗的后半页签点不到；界面图标继续收口

### 修复

- **「分层配置管理」（设置里的配置弹窗）后几个页签不再消失**：这个弹窗有 7 个页签
  （AGENTS / SOUL / IDENTITY / USER / TOOLS / HEARTBEAT / 层级结构），而弹窗宽度只有 560px ——
  页签行此前是「不换行 + 裁切」，于是**后半页签被直接裁掉，既看不见也点不到**。
  现在页签行可以换行（弹窗高度自适应，永远不会藏内容），文字过窄时变省略号。
- **右侧栏（文件 / 浏览器）标签区不再出现滚动条**：标签容器在两个样式表里各写了一遍
  （一处横向滚动、一处折行），两个属性同时生效。已合并成一处权威定义。
- **配置弹窗整体改用线性图标**：标题、关闭按钮、7 个页签、层级按钮、结构清单、保存按钮
  此前用的是 emoji（📋 💎 🪪 👤 🔧 💓 🌳 ⚙️ 💾 ✅ ⬜ ✕），现在全部换成统一图标集
  （icon-map / lucide），与其它管理面板一致；emoji 去掉后页签也变窄了。
- **13 处「文字 ✕」按钮换成图标**：图片查看器、模型配置方案、草稿对比、快捷短语、技能管理、
  会话列表、音频播放器、笔记标签、会话恢复、设置面板、多模态设置、PPT 编辑器、插件降级提示。
  其中 4 处其实是**删除**动作（删除环境脚本行、删除恢复会话、删除幻灯片、删除列表项），
  已改用垃圾桶图标；所有按钮补上可读名称（读屏）。
- **子智能体面板的状态图标**（🔄 ✅ ❌ ⏹️ ⏳ ❓）改为统一状态图标集，👥/🔧/💭/📁 也换成线性图标。

### 工程

- **图标门禁从「逐文件白名单」改成「全仓库扫描 + 显式豁免」**：此前是点名一批文件来检查，
  于是没被点到的文件（例如配置弹窗）可以长期带着 emoji 和文字 ✕ 而不被发现。
  现在：全仓库禁止文字 ✕/× 当按钮图标；迁移过的 17 个文件必须真正引用图标集（校验产物本身）；
  已迁移组件不得再出现「当图标用的 emoji」（用户数据里的 emoji 仍允许）。
- **新增两条 CSS 布局契约**：flex 行容器不得同时「不换行 + 裁切」（除非逐个说明理由）；
  配置弹窗页签行必须允许换行且标签能省略号。
- 盘点出**剩余 16 个组件**仍在用 emoji 当图标（多数是 `✅/❌` 出现在结果文案里，属内容而非图标），
  已按文件列出清单，留给下一轮逐个映射（不能用正则批量替换）。

## [1.16.4] - 2026-09-10 — 修复：上一轮「跨文件去重」脚本留下的三处 CSS 残骸 + 编码损坏门禁

### 修复

- **浅色主题下标题栏按钮的悬停底色不再发黑**：标题栏按钮的 `:hover` 在两个样式表里各写了一遍，
  后加载的那份用的是深色半透明变量（`rgba(56,62,70,.80)`），于是浅色主题里鼠标划过按钮会
  变成一块深色。现在由 `styles.css` 权威定义。
- **系统「减少动效」对 15 个浮层重新生效**：上一轮的批量去重脚本吃掉了减动效媒体块的
  **整个声明体**，只剩一串没有声明的选择器 —— 页面照常渲染，所以这个无障碍承诺失效了
  却谁也没发现。现已恢复（动画/过渡/变换全部关停）。
- **修复 PPT 放映模式规则残骸**：同一脚本留下的裸声明，现已由权威定义接管。
- **修掉 3 个样式表里 87 处编码损坏（U+FFFD）**：注释里的中文在过去某次「用字符串改写文件」时
  被截断（例如 `深色科技风` 变成 `深色科技�?`）。全部在注释里、不影响渲染，
  但已从 git 历史里逐个还原，并统一了换行符。

### 工程

- **新增 CSS 结构完整性测试**（`src/test/css-integrity.test.ts`，不依赖 postcss）：
  括号平衡、选择器悬挂逗号、顶层裸声明、空规则体 —— 上一轮的三处残骸都是
  `tsc`、单测、UI 审计全都看不见、只有打包时才炸的类型，现在单测就能拦住。
- **UI 门禁新增 `encoding-replacement-char`**（规则 23 → 24 条）：源码里出现 U+FFFD 直接报错。
- **修正 `css-class-cross-file` 的一处误报**：条件覆盖块（`@media` 等）是有意的分层覆盖，
  不再被当成「后加载者静默覆盖」。

## [1.16.3] - 2026-09-10 — 修复：右侧面板标签行只显示前两个 / 无会话时的两个按钮状态

### 修复

- **右侧面板（Git / 文件 / 变更 / 工作台 / CI·CD）标签行恢复为一行**：
  此前只看得见 `Git`、`文件`，其余标签"换行后消失"。
  根因：标签容器的布局是 `repeat(2, max-content)` 的**固定两列网格**，五个标签被排成三行，
  而容器高度只有 38px 且不滚动，多出来的两行被直接裁掉。
  现在容器是**不换行的 flex 行**：始终一行；宽度不够时标签文字变省略号，而不是折行被裁。
- **没有会话时禁用「搜索」「临时会话」**：刚打开应用停在主页、还没有对话时，
  这两个动作无处可施（会话内搜索没有内容、临时会话要挂在主会话上）。
  现在它们用原生 `disabled`（鼠标、键盘、读屏同时失效），标题改为说明原因；
  禁用态同时**复位悬停反馈**（否则鼠标划过还会亮底，看着像能点）。
  另外，会话消失时会把这两个面板一并收起，不再留一个浮在主页上的空面板。

### 顺带

- 这两处其实是**同一个错误的两个实例**：把「容器的排列方式」和「元素内部的排列方式」
  混用了同一套网格模板（按钮内部"图标 + 文字"两列是对的，容器用固定列数就错了）。
- 新增契约测试锁住：`panel-sidebar-tabs`（容器必须 flex + nowrap、宽度令牌 ≥480px）、
  `InputArea` 工具行（必须 flex + nowrap）、无会话时两个按钮 `disabled` 且回调不触发。

## [1.16.2] - 2026-09-10 — 修复：对话编辑器底部工具行被折成三行

### 修复

- **编辑器底部工具行不再折行**：此前被折成三行（`【＋】` / `【执行模式】【安全策略】` /
  `【搜索】【临时会话】`）。现在 `【＋】【执行模式】【安全策略】【搜索】【临时会话】`
  **始终在同一行**。

### 根因

上一轮把一批"标签墙"（`flex-wrap` 的标签/选项墙）改成 `repeat(auto-fill, minmax(…, max-content))`
网格时，**顺手把编辑器工具行也一起改了** —— 但那不是标签墙：auto-fill 的列数由
「容器宽度 ÷ 最小列宽（40px）」推出，而带文字的 chip（执行模式 / 安全策略 / 临时会话）
远比 40px 宽，轨道被撑大后，后面的 chip 就被挤到下一行。

### 做法

- 工具行改回**不换行的 flex 行**（`display: flex` + `flex-wrap: nowrap`）
- 图标型按钮与浮层锚点固定尺寸（压缩它们只会把图标裁掉）
- 带文字的 chip 允许压缩（`min-width: 0` + 文字省略号）——
  窗口很窄时是"文字变省略号"，而**不是**折行
- 整行 `overflow: hidden` 会裁掉外扩的焦点环，所以行内控件的键盘焦点改走内嵌环
  （延续之前处理"会裁切容器"的做法，键盘用户仍能看清焦点）
- 新增一条 CSS 契约测试断言这条行是 flex + nowrap、且不再是自动填充网格，
  防止它被再次"顺手改回"会折行的写法

## [1.16.1] - 2026-09-10 — 修复三处界面问题（标题栏拖不动 / 右侧栏滚动条 / 菜单 emoji 图标）

### 修复

- **顶部状态栏中段拖不动窗口**：「执行模型（本地处理）」按钮右侧到中间那段空白无法拖动窗口。
  根因是上一版把拖拽交给一条专用拖拽区时，顺手把 `.titlebar` 的**整组容器**都抬到了拖拽区之上，
  而左侧组与右侧动作组都是 `flex: 1`、会撑满中段 —— 于是盖住空白的是容器，不是按钮。
  现在只把**真正可交互的元素**（按钮 / 链接 / 输入框 / 菜单栏 / 标签条 / 窗口按钮）抬上去，
  容器保持静态，**空白处重新可以拖窗口**。
- **右侧栏（Git / 文件 / 变更 / 工作台 / CI·CD）标签区出现滚动条**：按钮区不该滚动。
  面板宽度 **420 → 520px**（一行放得下 5 个标签 + 关闭按钮），标签栏改为不滚动、
  按钮可压缩、文字过长省略；窗口很小时优雅收窄而不是出现滚动条。
- **左侧栏「项目 → 更多操作」菜单是 emoji 图标**（📌 / 📂 / 📁 / 🗑️），与项目其它图标的
  线性风格不符。图标其实藏在**文案字符串**里，所以组件里只看到纯文本。
  现在文案去掉 emoji，菜单项改成「线性图标 + 文字」两列（图标列定宽，跨行对齐），
  「移除项目」使用错误色，与别处危险操作一致。

### 顺带

- 清掉同一类 emoji 图标：子智能体类型图标（🔧🔍🤖📌 → 线性图标）、必需工具的锁形标记与说明文案、
  消息里「清理过程文件」按钮、「仅移除项目」确认按钮。
  （聊天**内容**里的 ✅/❌/⚠️ 属于模型输出，不在清理范围。）
- 新增 3 条图标规范测试（ICON-053~055）锁住：侧栏菜单必须用线性图标且文案不含 emoji、
  子智能体图标函数必须返回图标组件、必需工具标记必须用图标。

## [1.16.0] - 2026-09-10 — UI 设计体系统一：从「项目级」到「产品级」的 44 波整改

> 起因：用户反馈"感觉我们的精细度比不上参考实现（frakio-work）—— 它像产品级，我们像项目级"。
> 这轮没有靠感觉改配色，而是把决定观感的量**逐项量化对比**（两侧同一脚本、同一口径），
> 再按"可感知收益"排序动手 —— 每一波都跑 `tsc` / 全量 `vitest` / `vite build` / 22 条 UI 门禁并留档。

### 用户能直接看到的改变

- **默认主题改为浅色暖中性**：画布 `#fcfcfb` / 卡片 `#f5f5f3` / 文字 `#1f1f1e`，
  取代此前的深色默认。同时修掉了**启动时闪一下黑**的问题（首屏镜像脚本在渲染前设好主题），
  并把浅色档补齐到与深色档完全对称（此前浅色只覆盖 49/76 个主题令牌，`--highlight-top`
  等 22 个在浅色下一直沿用深色值）。设置里的深色主题仍在，随时可切。
- **新增应用级菜单栏**（文件 / 视图 / 帮助）：新建对话、搜索、设置、关闭窗口、切换侧边栏、
  切换终端、切换主题，带快捷键提示。只放**真实可用**的命令，不放灰掉的假项。
  键盘完整可用：↓ 打开、↑↓ 选项、←→ 换菜单、Home/End 跳首尾、Esc 关闭并把焦点交回。
- **窗口外壳对齐 mac 风格工具条**：外壳高度 36 → 44px（原来 36px 里塞 26px 控件只剩 5px 余量）、
  标签条滚动到边缘两端渐隐、**专用拖拽区 + 左右安全区**（不再"整条标题栏可拖 + 每个按钮单独
  声明不可拖"，漏一个就按钮点不动）、标签条末尾补"新建对话"按钮。
- **尺度校正**（这些是"看着不精致"的直接来源）：
  字重启用细档（区块标题 620 / 列表项 560 / 数值回到 400，此前"哪里都半粗"用了 235 次 600）；
  控件高度统一到 26/30/34/38/44（此前靠 padding 撑，同一行两个控件能差 1–6px）；
  圆角阶梯修正为严格单调（`--radius-xs` 此前竟比 `--radius-sm` 大）；
  149 处 13px/15px/18px 这类离刻度图标尺寸吸附回八级刻度（同行图标不再高低不一）；
  圆角/间距/字号/颜色/字体栈全部收敛到令牌（改一处全局生效）。
- **可访问性**（此前键盘用户基本用不了）：焦点环此前被 21 条组件规则 + 14 处内联样式抑制，
  现在全部交回统一的焦点环令牌；57 条循环动画在系统"减少动效"下全部停下（此前只是"加速"），
  宠物精灵与图书馆场景的逐帧动画也尊重该偏好（此前全仓库没有一处读这个系统设置）；
  文件树条目与知识图谱节点从**键盘到不了**改成可聚焦。

### 工程侧（不直接可见，但决定后续能不能持续做对）

- **UI 门禁从 9 条扩到 22 条**，当前 error 0 / warn 0：新增 z-index 层级、重复类定义、
  间距令牌、圆角令牌、图标尺寸刻度、字体栈、焦点抑制（CSS 与内联各一条）、
  减动效覆盖、死类名等规则 —— 每条规则都来自一次真实事故，并配了"允许的例外"说明。
- **对齐原语**：`display: grid` 50 → **302** 处、`:has()` 父级状态 7 → **41** 处，
  标签/选项墙改 auto-fill 网格（flex 换行会让最后一行参差不齐）。
- **删掉 223 条从未被使用的 CSS 规则**（未使用类名 258 → 110），整族清理了
  `composer-*`、`code-block-*`、`native-title-bar-*`、`right-rail-*`、`hub-*` 等历史遗留。
- **新增版本号一致性测试**：`package.json` / `tauri.conf.json` / `Cargo.toml` 三处版本 +
  CHANGELOG 顶部条目 + PROJECT-GUIDE 版本表，任何一处漏改都会在测试阶段失败
  （此前只有人工纪律，而漏改的后果是安装包版本与前端版本不一致）。
- 全量测试 **201 文件 / 4566 用例通过（+15 跳过）**，`tsc --noEmit` 零错误，`vite build` 通过。

### 已知取舍（写下来免得后人重复劳动）

- 参考实现的 `display: grid` 有 574 处，我们 302 处：差额来自"我们仍有大量单行布局用 flex 表达"，
  不是缺对齐；继续硬凑数字没有可感知收益。
- 参考实现的 `prefers-reduced-motion` 出现 27 次、我们 12 次：差别是"它把兜底拆成更多小块"，
  而我们的判定标准更严 —— **每条循环动画都必须有显式关停**，并由此新增了门禁规则锁住。
- 动画总量仍比参考实现多（`@keyframes` 83 vs 41）：其中 25 个属于像素美术插件（自带一套动画语言），
  其余多为有信息量的状态指示（加载中/流式中/进行中）。

## [1.15.2] - 2026-09-10 — 修复：有对话但「看板 → 时间线」是空的

> 用户反馈：有项目有对话，但时间线里什么都没有。

### 根因

时间线的**事件来源太窄**：以前只有「工具调用 / 团队任务 / 角色焦点 / 宿主遥测」会变成事件，
**对话消息本身不算事件**。所以：
- 只问答、没调工具的会话 → 时间线恒为空；
- 一次性问答（工具调用为空或已被截断）→ 同样是空白页；
- 而且空态只有一句「暂无事件」，用户无法判断是「真没数据」还是「数据源没接上」。

（顺带验证：列表渲染本身没问题 —— 用 60 条事件跑版面审计，0 裁切 / 0 重叠。）

### 修复

- **对话消息也进时间线**：取最近 30 条消息，用户发言 → `session`/active，助手回复（有正文）→
  `session`/ok，失败消息 → `error`/bad；纯工具调用消息不重复出条目（工具调用本来就有专门条目）。
- **空态自解释**：时间线为空时不再只显示「暂无事件」，而是列出**采样实际看到了什么** ——
  会话 / 消息 / 工具调用 / 子智能体 / 运行时团队 / 遥测事件 六项计数、采集失败的来源，
  以及「事件来自哪里」的说明；类别筛选下为空时文案区分「该类别下暂无事件」。
- 预览夹具的事件数从 4 条改为 **60 条**（线上上限 120 条），让列表裁切/滚动问题也能被审计覆盖。

### 验证

- `npx tsc --noEmit` 零错误；全量 `npx vitest run` **199 文件 / 4554 用例通过（+15 跳过）**
- 新增 `library-ops-events.test.tsx`（LO-EVT-1~5：纯聊天也有事件 / 工具条目独立 / 失败消息 →
  error / 空态诊断 / 类别为空文案）
- 版面审计：`--host=board` 含「时间线」视图，60 条事件下 0 裁切 / 0 重叠 / 样式生效

## [1.15.1] - 2026-09-10 — 修复：任务管理「概览」没有滚动条，下面的内容看不到

> v1.15.0 把「用量」迁进概览后，概览内容变高了，但**内容区被裁掉且没有滚动条**，
> 下面的用量面板完全看不到。

### 修复

- **根因**：v1.15.0 把「概览」加进 `wide`（面板加宽）时，内容区的 `overflow` 也跟着
  用了 `wide ? "hidden" : "auto"` —— 于是一起变成了 `hidden`。而「概览」是**普通文档流页面**，
  必须由内容区滚动；只有看板 / 子智能体（`.lo-task` 外壳自己管滚动）才需要 `hidden`。
- **修法**：把「面板宽度」与「是否铺满一屏」拆成两个判断 ——
  `wide = board | subagents | overview`（宽度）、`fillsViewport = board | subagents`（滚动归属），
  内容区用后者决定 `overflow`；并加 `data-task-center-content="<tab>"` 便于断言与排查。

### 回归测试

- `task-center-dedup.test.tsx` 新增 DEDUP-7（源码契约：两个判断必须分离、不得再用 `overflow: wide ? …`）
  与 DEDUP-8（真实渲染：概览 / 收件箱等普通页签 `overflow: auto`，看板 / 子智能体 `hidden`）。

### 验证

- `npx tsc --noEmit` 零错误；全量 `npx vitest run` **198 文件 / 4549 用例通过（+15 跳过）**

## [1.15.0] - 2026-09-10 — 任务管理再收敛：用量迁进概览 + 场景归「子智能体」+ 角色只绑定团队/子智能体 + 结构树去重

> 用户反馈三件事：①看板/子智能体页面样式与自适应坏了；②「用量」应当是**迁移**到概览并删掉原视图，
> 而不是加一个指回去的引用；③拉一份任务管理功能结构树，对比树上的重复功能做精简。
> 本版按这三条整改，并附完整结构树文档 `docs/TASK-CENTER-MAP.md`。

### 修复 1：看板 / 子智能体页面样式丢失（P0）

- 根因：重写视图外壳时漏掉了插件样式表 `styles/library-ops.css` 的 import，
  整片页面变成无样式（页面不自适应、内容显示不全）。现在由 `LibraryOpsViewShell` **统一导入**，
  并新增「样式入口」守卫测试（`library-ops-style-entry.test.ts`）把入口钉死；
- 版面审计升级为**双保险**：除几何检查外，新增 **`stylesApplied` 断言**（
  `.lo-task` display 必须是 flex、`.lo-task__rail` 必须是 column 等），
  样式表缺失/规则未生效会被审计直接判失败（此前只看几何，完全看不出来）；
- 审计按宿主位置分别跑：`--host=board`（4 视图）/ `--host=scene`（2 视图）/
  `--host=overview`（概览里的用量嵌入），各 7 种窗口宽度。

### 变更 2：「用量」迁移进「概览」（删掉看板里的用量视图）

- 新增宿主扩展点 `task-center.overview`：插件把 `OverviewPanel + CostPanel` 整块贡献到概览；
- 插件「看板」页签的视图从 5 个收敛为 **看板 | 工具 | 错误 | 时间线**（不再有「用量」）；
- 用量块自带容器查询上下文（`.lo-embed`）与采样，不渲染 `.lo-task` 外壳（那是宿主页签外壳）；
- 原先那个「KPI/健康度/…都在看板里 →」的跳转卡片**已删除**（那是指回原处，不是替代）；
- 插件禁用时概览回退显示宿主自带的「最近活动」预览，信息不丢。

### 变更 3：任务管理功能结构树 + 去重（详见 `docs/TASK-CENTER-MAP.md`）

结构树覆盖 8 个页签 + 三个接管点，落到最小叶子（每个按钮/筛选/定时器/空态/数据源），并给出 25 项重叠判定。
本版修掉其中 13 项：

| 重复 / 坏点 | 处理 |
| --- | --- |
| 概览与错误面板的「定位 / 点角色」是**死按钮**（场景不在这两个页签，点了看不到反应） | 改为「选中角色 + `requestView("scene")`」 |
| 插件接管子智能体页签后，宿主「点条目打开父会话」链路断裂 | 场景角色详情新增「打开父会话」→ 宿主事件 `codem:open-session`（App 切会话并关面板） |
| 概览里 token/成本同屏出现 3 次 | 删掉状态卡里的 token/成本两行（KPI 卡 + CostPanel 保留） |
| 概览手写了一份与 `EventList` 同构的事件列表 | 改为复用 `EventList`（limit 8）并补空态 |
| Issue 状态标签/颜色在 5 处各自维护（自动化甚至漏了 backlog/todo） | 新增唯一元数据表 `issue-status-meta.ts`，看板列/筛选/详情/自动化全部取自它 |
| 概览内嵌用量与页签外壳**各起一条轮询** | `useLibraryOpsSampling` 改为**引用计数的共享定时器**（最后一个使用者卸载才停） |
| `SquadsTab` 不随项目切换重查（与 P2-12 项目边界约定不一致） | 依赖数组加入 `projectId` |
| 底栏写死「委派深度限制: 2 · 最大并发: 5」 | 读 `getDelegationOrchestrator().getLimits()` |
| 死代码 `src/components/DelegationPanel.tsx` | 删除 |
| `ErrorsPanel` 自带一份与 `labels.clockOf` 等价的时钟函数 | 删本地实现 |
| 自动化「监听状态」只有 5 个状态 | 表驱动补齐 7 态 |
| 概览「任务总数」易被误读成 Issue/委派数 | 文案改为「团队任务总数」、「工具调用（按事件流）」 |
| 团队模板角色占位入馆（没建队却满馆人） | v1.15.0 已随角色绑定规则移除 |

**登记为待办/待确认**（见结构树文档）：收件箱未读两个口径（侧边栏全局 vs 概览按项目）、
看板视图清单 3 份、`openLibraryView` 与 `requestView` 两套同义导航、「等待采样」6 种措辞、
工具调用两套定义（metrics vs 事件流聚合）。

### 变更 4（上一轮已实施，此处归档）：场景归「子智能体」+ 角色绑定规则

- 场景 + 设置移到「子智能体」页签（新扩展点 `task-center.subagents`）；看板只留看板类视图；
- 跨页签跳转统一走 `requestView(view)`；`Ctrl/Cmd+Shift+L` 打开「子智能体 → 场景」；
- 场景角色 = **队长**（当前会话 + 各运行时团队队长）+ **团队成员** + **子智能体**（有/无团队）
  + **仅在途委派**的目标会话；普通闲置会话与团队模板角色不再入馆；
- ⇒ 没有团队、没有子智能体、没有在途委派时，馆内只有**队长**一人待命。

### 验证

- `npx tsc --noEmit` 零错误；全量 `npx vitest run` **198 文件 / 4547 用例通过（+15 跳过）**
- 版面审计：三个宿主位置 × 7 种窗口宽度 × 各自子视图，全部 **0 裁切 / 0 重叠 / 样式已生效**
- headless DOM 审计 `issues: []`

## [1.14.1] - 2026-09-10 — 修复：看板子视图被「实时事件」挤占/遮挡

> v1.14.0 把图书馆并进「看板」页签后，右侧的「实时事件」事件流会一直占着
> 200–280px 宽度，导致看板的 7 列被挤出可视区（用户反馈「看板内容被实时事件遮挡」）。

### 修复

- **看板子视图默认不再渲染实时事件流**：看板 7 列本身就需要横向空间，
  事件流再占一条栏位会把右侧列挤到可视区之外；状态条新增「实时事件」开关
  （`layout-panel-left` 图标，带 `aria-pressed`），需要时可以临时打开。
  其它监控视图（场景 / 用量 / 工具 / 错误 / 设置）行为不变，仍按设置显示事件流。
- **看板视图改为铺满内容区**：新增 `.lo-board-host` 包裹宿主 `IssueBoard`，
  用 `flex: 1 1 auto + min-height: 0` 保证看板正好填满内容区高度，
  横向滚动条不再被挤到可视区之外（原先会多出 24px，滚动条落在折叠线以下）。
- **7 列一屏排完**：宿主列最小宽度改走变量 `--issue-col-min`（默认 180px 不变），
  插件在看板宿主上收紧到 128px —— 宽面板（≥1280 窗口）下内容区 1089px 足够放下
  `7×128 + 6×12 + 24 ≈ 1020px`，不再需要横向滚动；窄面板仍由看板自身滚动兜底。

### 验证工具改进（这次漏检的根因）

用户反馈的这类问题此前**审计不到**——旧版面审计只渲染了插件自己的子视图，
既没有渲染左侧导航/右侧事件流，也没有渲染宿主看板：

- `tools/preview` 现在渲染**真实的** `LibraryOpsBoardView`（含导航栏 + 事件流），
  并在 `?audit=1` 模式下把**宿主 `IssueBoard` 真组件**纳入审计
  （新增 `issue-stub.ts` / `store-stub.ts` 两个桩，避免把 sql.js / node 内建模块拉进浏览器构建）；
- 预览页现在同时加载**宿主全局样式**（`src/styles.css`：reset + 皮肤令牌），
  否则 `box-sizing` 差异会让审计几何值与真实应用不一致（正是本次 24px 高度的来源）；
- 版面审计的子视图从 6 个增加到 **7 个（含「看板」）**；
- 新增 `tools/preview/probe-layout.mjs`：打印关键容器（body / 导航 / 内容区 / 事件流 /
  看板宿主）的矩形与溢出量，便于定位「被遮挡 / 被裁切」类问题，并支持
  `?audit=1&view=<子视图>` 停在指定视图做目视检查。

### 验证

- `npx tsc --noEmit` 零错误；全量 `npx vitest run` 通过（新增 LO-UI-13 回归用例：
  看板默认无事件流、开关可切换、其它视图仍有事件流）
- 版面审计：7 种窗口宽度 × 7 个子视图，全部 0 裁切 / 0 重叠；
  探针确认看板视图内容区宽度 1089px（此前 808px）、看板高度正好等于内容区高度、
  看板 `scrollWidth == clientWidth`（7 列一屏排完，无横向溢出）
- DOM 审计 `issues: []`

## [1.14.0] - 2026-09-10 — 图书馆并入「看板」+ 场景图可上传/自动对位 + 界面自适应与图标统一

> 「图书馆」与「任务管理」在入口层大量重叠：两处都能看到同一批团队 / 会话 / 任务，
> 图书馆只多了一层动画场景。本版把它收敛成任务管理里的一部分（**并入「看板」页签**），
> 并解决换图与版面两件麻烦事：**场景图可上传替换**、**自动对位（不用手工拖）**、
> **容器查询自适应**、**图标统一到 lucide**。

### 重构：图书馆并入「看板」页签（不再有独立面板）

- **合并理由**：图书馆场景的初衷就是「谁在做什么、在哪做」的可视化看板，与宿主
  「看板」页签（Issues 按状态分列）是同一类信息的不同表达
- **新结构**：看板页签 = 宿主 Issues 看板（默认视图）+ 插件追加
  **场景 / 用量 / 工具 / 错误 / 时间线 / 设置** 六个视图
- **去掉重复入口**：原「总览」→「用量」（并合并原「成本」视图）；
  原「团队」→ 任务管理「团队」；原「会话」→ 任务管理「委派 / 子智能体」+ 场景花名册
- **宿主扩展点**：新增 `task-center.board` slot，`BoardTab` 用 `SlotBridge` 渲染，
  插件禁用时回退到自带 Issues 看板；`TaskCenter` 固定 8 个页签（旧 `library` tab id 自动归一为 `board`）
- **删除**：`components/LibraryOpsPanel.tsx`（全屏外壳）、`components/LibraryOpsLauncher.tsx`
  （悬浮圆钮 + 徽标）、store 的 `open/openPanel/closePanel/togglePanel`、`SessionsPanel`
- `Ctrl/Cmd+Shift+L` 与 `codem:open-library-ops` 改为打开「任务管理 → 看板」

### 新增：场景图可上传替换

- 设置 →「场景图片」：内置像素画 / 内置 AI 场景图一键切换；点「选择图片」或
  **把图片直接拖到场景上**即可上传（PNG/JPG/WebP/AVIF/GIF/BMP，≤32MB、≥640×360）
- 图片以 Blob 存浏览器 IndexedDB（`codem-library-ops` / `scene-images`，不写宿主数据）；
  环境不支持时降级为「本次会话有效」并明确提示
- `scripts/build-library-ops-scene-preset.mjs`：任意图 → 2752×1536 WebP 预设 + 480×268 缩略图
- `public/library-ops/scenes/`：本项目自有素材（AI 生成，可商用）+ `SOURCE.md`

### 新增：场景自动对位（纯像素统计，不用手工拖拽）

- `core/scene-align.ts`：地面掩码（亮度 + 3×3 局部方差）vs 内置房间掩码，
  在「缩放 × 平移」粗到细网格上最大化 IoU；输出 `{scale,x,y}` + 置信度
- 上传后自动跑一次，置信度 ≥ 0.42 自动应用并显示百分比；不满意可点
  「手动对位编辑器」再微调（房间框 / 走道节点拖拽，按图分别保存）
- 7 个纯函数单测（含「已知变换能否反解回来」与噪声图低置信度）

### 改造：界面自适应（容器查询）

- `.lo-task` 设为容器（`container-type: inline-size`），按**面板实际宽度**分档：
  ≥1080 三栏 / 980–1080 收事件流 / <980 单列 / ≤820 导航图标条；按容器高度压缩场景
- 固定死值全部换弹性值（`236px` 列 → `minmax(180px,236px)`、`min-height:460px` → 0、
  事件流 `280px` → `clamp(200px,24cqw,280px)`）；**子视图改为自然高度 + 内容区滚动**，
  修掉「用量 / 设置 / 错误」等视图在窄窗口下元素重叠、内容被裁切
- 新增 `tools/preview/audit-layout.mjs`：7 种窗口宽度 × 每个子视图检查
  横向/纵向裁切与兄弟元素重叠（全部 0）

### 审计与修复：任务管理（宿主，8 个页签）

对「任务管理」做了一轮逐页签审计（含插件接管后的看板页签），修掉下列问题：

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P0 | 「子智能体」页签列表恒空：`App.tsx` 在 render 里 `require()` 取运行时，ESM 下必然抛错被 catch 吞掉 | 改为顶层 `import` + 事件驱动订阅 `getSubagentRuntime().subscribe()` |
| P1 | `codem:open-task-center` 只认 `tab: "teams"`，其它页签请求被忽略 | 透传任意合法 tab id（旧 id 由 `normalizeTab()` 归一） |
| P1 | 点「子智能体」条目不切会话 | 切到 `task.parentId` 对应会话再关面板 |
| P1 | 看板拖拽在部分浏览器不生效 / 离开子元素误判为离开列 / 同列拖动仍写库 | `setData("text/plain")`、用 `relatedTarget` 判断、同列 no-op |
| P1 | 看板缺 `blocked` / `cancelled` 列，这两个状态的 Issue 在「看板」上直接消失 | 补齐 7 列（与 `IssueStatus` 全集对齐） |
| P1 | 看板内容区 `overflow: hidden` 导致列多时无法滚动 | 恢复内容区滚动 |
| P1 | 「委派」统计走全局 `orch.getStats()`，列表按项目过滤 → 「统计 5 条、列表 0 条」 | 新增 `getAllDelegations()`，统计与列表同口径（概览页同步） |
| P1 | 面板已打开时再派发 `codem:open-task-center` 不切页签（只认挂载时 `initialTab`） | 面板内监听事件 + `initialTab` 变化同步 |
| P2 | 自动化「停止所有」点了就再也恢复不了（3 秒后按钮复位，引擎仍是停的） | 改为「停止所有 / 恢复运行」真开关（`refreshAutomationEngines()`） |
| P2 | Issues 筛选器缺 `backlog` / `cancelled` 两项 | 补齐 8 个状态筛选 |
| P2 | 收件箱未读徽标随分类筛选变化；点通知只是标已读，不跳转 | 徽标改「项目整体未读」；点击穿透到对应页签（Issue 直达详情） |
| P2 | 无当前项目时各页签直接传 `undefined` 查库 → **跨项目串数据**，新建 Issue 还会产生孤儿记录 | 新增 `use-current-project.ts`：无项目不查库、不建记录、给出提示 |
| P2 | `IssueCard` hover 覆盖左侧状态色条 | hover 只改上/右/下边框 |
| P2 | 详情面板切换 Issue 时右侧内容不刷新 | `useEffect` 同步 `currentIssue` |

- 新增 `src/test/task-center-audit-fixes.test.tsx`（12 用例）钉住上述行为。

### 审计与修复：任务管理（第二轮，独立复审）

第二轮由独立审计（只读复审 + 代码级验证）发现 14 项（P1×2 / P2×8 / P3×4，无 P0），全部修复：

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | `issue_create` / `issue_list` **工具路径**没有项目边界：无当前项目时 `listAll` 退化成全库查询（把别的项目 Issue 喂给模型），`create` 写入 `project_id = NULL` 的孤儿 Issue（UI 按项目过滤 → 永远看不到） | 两个工具都加前置判断：无项目直接拒绝并给出提示 |
| P1 | `STATUS_CONFIG[issue.status].Icon` 无回退：非法 status（旧数据 / 手工改库 / 工具写入）会让渲染抛错冒到顶层错误边界，**整个应用变崩溃卡片** | `IssueCard` / `IssueDetailPanel` 均回退 `todo`；`issue_update` 增加 status / priority 枚举校验 |
| P2 | 详情面板点「当前状态」也会写一条假的状态变更评论 + 收件箱通知（看板已守卫，面板漏了） | `handleStatusChange` 同值直接 return |
| P2 | 自动化「停止所有」是组件局部状态：编辑触发器会静默重启引擎、切页签后按钮复位且**无法恢复** | 暂停状态提到模块级（`isAutomationStopped` / `resumeAutomationEngines`），暂停期间 `refreshAutomationEngines()` 为 no-op |
| P2 | cron 步长 `*/0` → `Array.from({length: Infinity})` 抛 `RangeError`，每 30 秒重复抛且**后续 cron 触发器全部失效** | 步长校验（非有限/≤0 返回空集）+ `checkAll` 单个触发器 try/catch |
| P2 | 概览的委派统计在无项目时统计全部项目（与委派页签 0 条自相矛盾） | 过滤条件与「委派」页签统一 |
| P2 | 重启后委派历史与「已完成/失败」统计全丢（`restoreFromDB` 只恢复 pending/running，历史恢复是空循环） | 新增 `getRecentDelegations(limit)`，启动时一并恢复到内存（依赖图仍只按未完成任务重建） |
| P2 | Issues / 看板 / 收件箱的加载函数依赖数组缺 `projectId` → 面板打开期间切项目仍显示上一个项目的数据 | 三处都把 `projectId` 放进依赖 |
| P2 | `single` 槽位「**最低**优先级胜出」（`entriesOfSlot` 升序 + 取首元素），与注释/接管语义相反 | `entriesOfSlot` 对 single/keyed 反向遍历；`SlotBridge` 改为按 priority 取最大（顺序无关） |
| P3 | 「查看完整时间线」只切宿主页签，不会切插件的「时间线」子视图 | 宿主事件 detail 增加 `view`，插件监听 `codem:open-task-center` 消费它 |
| P3 | 新建 Issue 会被当前状态筛选藏起来（新 Issue 固定 `todo`） | 创建成功后若筛选非「全部」则切回全部 |
| P3 | 详情面板每次渲染都 `listSquads()`（每个 squad 读成员 + 查 AgentRegistry）→ 评论输入每击键一次 N+1 查询 | 改为 `useMemo`，只在打开选择器时查询 |
| P3 | 收件箱只增不减（`deleteOlderThan` 无调用者），定时触发器每天插入上千行 | 写入时顺带裁剪 30 天前的旧通知 |
| — | 死代码：`monitor/TeamsPanel.tsx`（团队视图已删除后无人引用）+ 其 CSS（`.lo-teams*` / `.lo-members__*` / `.lo-sessions*`） | 删除组件与样式，只保留概览页用到的 `.lo-members__dot` |

- 新增 `src/test/task-center-audit-fixes-2.test.tsx`（14 用例）钉住以上行为。

### 去重：任务管理内不再有「相似功能」

| 重叠 | 处理 |
| --- | --- |
| 图书馆「团队」↔ 任务管理「团队」 | 删掉插件侧 Teams 视图入口，数据只有一份（`AgentTeamsService`） |
| 图书馆「会话」↔ 委派 / 子智能体 | 删掉 `SessionsPanel`，会话信息由「委派 / 子智能体」+ 场景花名册承担 |
| 图书馆「总览」↔「成本」↔ 任务管理「概览」 | 插件侧合并为「用量」一个视图；任务管理「概览」只放统计卡 + 最近 5 条活动，并给「查看完整时间线」入口（仅在插件启用时出现） |
| 场景 ↔「子智能体 / 团队」 | 场景只是同一份数据的**可视化表达**，面板里明确标注，不再重复提供明细列表 |
| 自动化触发器 ↔ 设置面板里的自动化设置 | 唯一入口是「任务管理 → 自动化」，设置面板只保留跳转提示 |

### 改造：图标与样式统一

- 新增 `components/icons.tsx`（`LoIcon` + `LO_ICONS`，49 个语义名 → **lucide-react**）；
  `types.ts` 新增 `LoIconName`，数据层只存语义名；全部 emoji（工作状态 / 角色来源 /
  岗位 / 卡片 / HUD / 导航 / 趋势箭头）替换为图标组件
- 卡片 / 标签 / 圆角 / 底色对齐宿主 `.card` / `.badge`（10px 圆角 + `--bg-secondary` +
  `--border-primary` + hover 边框）；删除独立面板遗留死样式

### 修复

- **dev 模式白屏**：`src/core/zvec-grep/types.ts` 顶层 `process.env` 在 Vite dev 下抛
  `ReferenceError: process is not defined` → 新增 dev-only `src/stubs/process-polyfill.ts`
  （与生产构建的静态替换语义一致），`main.tsx` / `pet-main.tsx` 首行导入；该文件同时加
  `typeof process` 保护
- **`tauri dev` 直接退出**：编辑器原子写入的 `*.tmpdir` 触发 Vite 文件监听 EBUSY →
  `vite.config.ts` 忽略 `*.tmpdir` / `*.tmp` / 构建产物目录
- 子视图被强行塞进固定高度导致的挤压 / 重叠（见上「界面自适应」）

### 验证

- 全量 `npx vitest run`：**196 文件 / 4533 用例通过 + 15 跳过（共 4548）**（新增 `library-ops-align`、
  `library-ops-icons`、`library-ops-scene-image*`、`library-ops-layout-override`、
  `library-ops-task-center`、`task-center-audit-fixes`、`task-center-audit-fixes-2` 等）
- `npx tsc --noEmit` 零错误；`npx vite build` 成功
- headless DOM 审计 `issues: []`（4 像素场景 / 48 房间 / 48 角色 / 等距 12/12 在岗 / 0 NaN）
- 版面审计：7 种窗口宽度（1600→760）× 6 个插件视图全部 0 裁切 / 0 重叠

## [1.13.0] - 2026-09-10 — 图书馆插件集成手绘像素美术（场景直接用参考项目的场景）+ 监控面板对标 lobster-pet

> 上一版图书馆插件的场景是程序化矢量绘制，质感不如参考项目。本版把**美观提到第一位**：
> 直接集成 [ClawLibrary](https://github.com/shengyu-meng/ClawLibrary) /
> [Star-Office-UI](https://github.com/ringhyacinth/Star-Office-UI) 的**手绘像素美术资源**，
> **场景直接用参考项目的场景**；监控面板布局对标 lobster-pet 重排，
> 把图书馆作为**监控界面内的一张卡**嵌入。全部第三方资源已在项目内声明许可与义务。

### 新增：像素美术场景（默认场景）

- **直接使用 ClawLibrary 的图书馆场景**：`scene-floor` + `scene-objects`（2752×1536 手绘像素画）
  + `walkGraph`（20 节点 / 19 边）+ 12 个资源分区坐标 + 可行走掩码
- **角色用其 Capy-Claw / Cat-Claw 精灵表**：128×128 帧 @6fps，各 12 套动作
  （work / read / idea / repair / error / sleep / coffee / rest / walk / stand_front / stand_back /
  lie_flat / lie_side / front / game），按角色 id 稳定分配变体
- **11 种工作状态 → 上游动作**：待命→stand_front、行走→walk、思考→idea、阅读→read、
  撰写/执行→work、检索→read、等待授权→rest、完成→coffee、出错→error、休眠→sleep
- **寻路**：上游手工标注的 walkGraph 图最短路（BFS）+ 末端直连工作锚点；
  房间内多角色按黄金角环形排布，不叠人
- **相机**：滚轮缩放（0.3×–3.2×，指针锚点）/ 拖拽平移 / 双击复位 / 选中角色平滑居中 / HUD 统计
- **降级**：资源缺失时提示并可切到「等距矢量」场景（本项目自绘，无第三方约束）
- 原程序化等距矢量场景保留为**可选风格**（设置 →「场景风格」）

### 新增：资源管道与许可合规

- **`scripts/sync-library-ops-assets.mjs`**：从上游仓库 PNG → WebP 重压缩
  （**30.1MB → 5.1MB**，视觉无损）+ 为每个来源写出 `SOURCE.md`（出处 / 逐文件改动 / 义务）
  + 复制上游 LICENSE 原文 + 生成 `public/library-ops/README.md` 总索引
- **许可声明**：新增 [`docs/ASSET-LICENSES.md`](docs/ASSET-LICENSES.md)（逐项义务与商用替代方案）
  + `THIRD_PARTY_NOTICES.md` 新增三个项目条目 + 插件设置页新增「美术资源许可」卡（运行时可见）
- **刻意排除**：Star-Office-UI 内的 `guest_role_*` / `guest_anim_*` 来自 LimeZu，
  其许可禁止再分发（"You may not redistribute it or resell it"），脚本显式跳过
- **商用替代**：像素美术资源**仅限非商业**；商用请切到「等距矢量」场景或替换资源

### 改造：监控面板对标 lobster-pet

- **总览页重排为 lobster-pet 的 `DetailPanel` 单屏卡片网格**：
  行 1 = 状态卡(236px) + 最近会话卡网格 + 活动概览（14 天热力图 / 会话类型环形图 / 小时柱状图）；
  行 2 = 左栈（团队卡 + 任务与工具卡 + 数据源与健康度卡）与**图书馆场景大卡**；
  行 3 = 6 张紧凑 KPI 卡（含迷你折线）
- **场景从「一个页签」变成「监控界面里的一张卡」**（对标 lobster-pet `MiniOffice`），
  与其它监控卡共享同一份快照；全屏「图书馆」页签保留供放大观察
- 新增状态卡、会话卡片网格、团队迷你卡、活动概览两列布局等样式（全部皮肤令牌化）

### 修复

- **两套场景引擎共享一个 store 槽位**：像素场景态被喂给等距引擎导致
  `Cannot read properties of undefined (reading 'col')` 崩溃；改为 `isoScene` / `pixelScene` 两个槽位
- **上游 workZone 锚点越界**：mcp / images / log / schedule 四个房间的工作锚点落在房间矩形之外
  （上游数据不一致），按 28px 边距夹回房间内
- 场景根节点加 `data-scene` 标记，DOM 审计按场景分别校验

### 验证

- `npx tsc --noEmit` 零错误；`npx vitest run` **186 文件 / 4432 用例通过**；`npx vite build` 成功
  （插件 chunk 126KB JS + 39KB CSS，美术资源 5.17MB 随包）
- 新增 2 个测试文件 / 18 用例：像素场景数据（12 例，含**资源文件真实存在**与许可声明齐备）
  + 像素场景渲染（6 例，含精灵 URL/帧偏移、角色落在自己房间、资源缺失降级）
- headless 浏览器 DOM 审计：像素场景 2 图层 / 12 房间 / 精灵表接线正确，
  等距场景 12/12 角色落在自己岗位包围盒内，0 处 NaN

## [1.12.0] - 2026-09-10 — 图书馆运营监控插件（团队/子智能体可视化）+ 全面审计修复

> 本版新增一个**完全独立、可启停的大插件** `@codem/ui-library-ops`：把 Codem 的团队角色与
> 子智能体变成各自不同的动画角色，在 ClawLibrary 风格的等距图书馆里各自的岗位上工作；
> 监控界面完全对标 lobster-pet，并把图书馆作为监控界面内的「场景」页签。
> 随后对该插件做了四轮全面审计（真实服务联动 / 代码级 / 渲染几何 / 回归），
> 修复 28 项问题（含 1 项宿主 Bug），并新增 4 个测试文件把每类问题变成门禁。
> 审计全过程与证据见 `docs/LIBRARY-OPS-AUDIT.md`。

### 新增：图书馆运营监控插件（@codem/ui-library-ops）

- **团队角色 → 动画角色**：`data/characters.ts` 由角色 id 确定性生成外观
  （12 套调色板 × 4 种身形 × 5 种发型 × 6 种头饰 × 6 种道具 × 4 种表情 = **34,560 种组合**），
  岗位反向影响头饰与道具（队长礼帽 / 运维工帽 / 研究学者帽 / 编码耳机 / 写作贝雷帽）；
  **11 种工作动画**（待命 / 行走 / 思考 / 阅读 / 撰写 / 执行 / 检索 / 等待授权 / 完成 / 出错 / 休眠）
  由**真实工具调用与任务状态**驱动（`read`→阅读、`write`→撰写、`bash`→执行、
  `web_search`→检索、`ask_user_question`→等待授权…）。
- **ClawLibrary 式图书馆**：等距 2.5D 场景（SVG 地板 / 网格 / 背墙 / 窗 / 区域 / 8 类矢量家具 +
  DOM 角色层），**10 个职能岗位**（前台 · 调度台 / 阅览大厅 / 编目室 / 代码工坊 / 写作工坊 /
  档案室 / 机房 · 后台 / 会议厅 / 借还台 · 交付 / 静思角）；按角色标签关键词自动分配岗位与
  工位槽位（同岗位不叠格、不越出区域），可通行网格 + 网格 BFS 寻路，到岗停驻 + 头顶名牌 +
  工作气泡 + 等距深度排序。
- **lobster-pet 式监控界面**：标题栏（实时状态 / 时钟 / 刷新 / 关闭）+ 左侧 9 页签 +
  右侧实时事件流；总览（6 张 KPI 卡 + 健康度环 + 14 天热力图 + 会话类型环形图 +
  24 小时活跃柱状图 + 数据源健康）、图书馆、团队（成员 + 任务看板 + 完成率环）、会话、
  工具（频次排行 + 调用流水）、成本（token 构成 + 成本趋势）、错误（阻塞/出错角色 +
  失败任务 + 来源健康）、时间线（按类别过滤）、设置（采样间隔 / 动画速度 / 显示开关 /
  默认页签 / 自动打开）。**图书馆即监控界面内的「场景」页签**，与其它监控卡共享同一份快照。
- **相机可交互**：滚轮缩放（以指针为锚点，0.3×–3×）、拖拽平移、双击复位、
  HUD 缩放按钮与在馆统计、选中角色时镜头平滑居中（「在场景中查看」）。
- **真实数据只读接入**：会话 / 运行时团队（AgentTeamsService）/ 子智能体（SubagentRuntime）/
  团队模板（SquadManager）/ 智能体定义（AgentRegistry）/ 工具调用（消息流）/
  token 与成本（CostTracker）/ 遥测（TelemetryCollector）；逐源 try-catch +
  `sources.failed` 可见性；**零写入宿主**（LO-INT-7 禁止词表门禁）。
- **集成零侵入**：挂宿主已有的 `app.overlay` slot → **App.tsx 零改动**；插件管理可禁用
  （provider 不装配 → 入口与面板都不存在）；面板关闭即停止采样（无后台轮询）；
  入口为可拖拽圆钮（位置持久化 / 双击复位）+ `Ctrl+Shift+L` + `codem:open-library-ops` 事件。
- **皮肤契约**：全插件零硬编码色值（角色调色板也是 `var(--token)`），
  default（亮/暗）/ dream / hub 四套皮肤自动适配，尊重 `prefers-reduced-motion`。

### 修复：全面审计发现的 28 项问题（详见 docs/LIBRARY-OPS-AUDIT.md）

- **P0-1（宿主 Bug）团队运行状态永不回落**：`AgentTeamsService` 的 `kick()` 跳过 `working`
  成员，而任务进入终态时没人把成员置回 `idle` → 成员永久卡在「工作中」，调度器再也不派活，
  监控视图也一直显示执行中。新增 `releaseAssigneeIfIdle()`：任务进终态 / 转派后，
  若该成员名下再无未完成（非终态）任务则释放为 `idle`。
- **P0-2 活跃会话识别失效**：适配层按 `Set.has()` 判活跃，宿主 `activeSessions` 实为
  `Map<string, boolean>` → 所有会话永远不「活跃」。改为同时支持 Map / Set。
- **P0-3 角色气泡永不消失** / **P0-4 到岗瞬间动画不切换**：气泡与动画态改为在 rAF 里
  直接写 DOM（`data-bubble` / `svg[data-anim]`），不再依赖 1.5s 一次的快照重渲染。
- **P0-5 `done` 动画永久定格**：超过保持期回落 `idle`。
- **P0-6 角色站到岗位外**：工位槽位只取落在本区域矩形内的瓦片，场景引擎再吸附到
  「区域内 + 可通行」格。
- **P0-7 等距几何双重偏移**：区域高亮 / 地板 / 背墙在投影之上又加了半瓦片偏移导致整体
  放大错位，网格图案原点也与地板不对齐。抽出 `components/library/iso.ts` 固化
  「瓦片角点 / 瓦片中心」两套约定，网格改为 44 条精确直线。
- **P0-8 道具换手**：角色 SVG 已按朝向镜像，道具又按朝向交换 x → 转向时道具换手；
  改为固定同一只手。
- **P1（11 项）**：场景缩放/平移/定位（画布 1408×768 塞进面板后角色只有 20 多像素）；
  采样超时兜底（一次挂住会永久锁死刷新）；岗位详情卡与超容告警；家具从文字字形
  升级为 8 类等距矢量家具（书架带书脊 / 长桌 / 终端带屏与键盘 / 柜台 / 绿植 /
  台灯带光晕 / 地毯 / 台阶）；背墙加窗；入口圆钮状态徽标；耳机横梁被 `fill` 覆盖成
  实心块与帽带色失效的 CSS 特异性修复；角色定位锚点从硬编码像素偏移改为
  「脚下（瓦片中心）」；选中角色镜头平滑居中；面板切走再切回保留馆内状态。
- **P2（10 项）**：新增 4 个测试文件（真实联动 / 几何不变量 / 渲染几何 / 门控）；
  抽出 `monitor/labels.ts` 消除四处重复文案；删除同名不同义的 `shortId` 与
  无调用方的 `formatDuration` / `formatDay` / `clampTile` / `zoneTooltip` 死代码；
  禁用门控抽到 `src/core/ui-plugins/gating.ts`（原先埋在会 import 全部 UI 插件的
  文件里，测试拉起要 5s+）；区域组与角色 wrap 加 `data-zone-id` 便于 DOM 审计；
  岗位区域支持键盘访问；新增 `tools/preview/` 视觉预览页与 DOM 结构审计脚本；
  修复新增真实联动测试导致的 vitest worker 收尾竞态（写内存 DB 触发 500ms 防抖
  持久化，文件结束时定时器在途 → 偶发 `Worker exited unexpectedly`）。

### 验证

- `npx tsc --noEmit` 零错误；`npx vitest run` **184 文件 / 4414 用例通过**（连续 4 次复跑稳定）；
  `npx vite build` 成功（插件独立懒加载 chunk）。
- 真实服务联动 8 例（真 `AgentTeamsService` 建队派活 → 快照出现工作中成员；任务完成 →
  成员释放；团队模板入馆；成本进入指标；`loadDefaultDeps` 无断链；子智能体入馆；归档不残留）。
- 渲染几何 7 例 + headless 浏览器 DOM 审计：**12/12 角色落在自己岗位的等距包围盒内**，
  84 件家具、88 条网格线、5 扇窗、0 处 NaN/undefined。

## [1.11.2] - 2026-09-09 — zg 在线安装 Node 源根治 + 审计四坑修复（真 PPTX / 纠偏接线 / Whisper 入口 / 会话内搜索）+ 功能文档体系

> 本版 = v1.11.1 覆盖版之后全部改动（13a6fb6 / 1644cca / 50010f3）：在线一键安装彻底不再访问
> nodejs.org/npmmirror；四处审计发现的功能"占位/死代码"全部修复为真实可用；
> 末尾覆盖包新增「手动添加模型名」（服务器列表外的内测/测试模型）。

### 修复：zvec-grep 在线安装 Node 源（根治）

- **便携 Node 并入 zg 单包**：`codem-zvec-win-x64.zip` 现内含隔离的便携 Node v24.19.0
  （162MB，不注册 PATH、与系统已装 Node 零冲突）；打包脚本升级（build-zvec-runtime.ps1
  六步：Node+裁剪 zg+模型 → 冒烟 → 单包）
- **安装链改为只从 GitHub Release 取包**：安装流程先备包 → node 解析 = 系统 Node≥22 →
  包内便携 Node → 网络兜底（旧包）；全程不再请求 nodejs.org / npmmirror（这些源在部分
  用户网络被拦截返回 404 是此前一键安装失败的根因，且与本机实测 URL 200 不符 → 判定为
  网络层差异，改从 GitHub 分发根治）；彻底离线可走「离线 zip」导入（同包含 Node）
- 错误信息带每源失败明细与可执行指引（自行装 Node / 导入离线包）

### 修复：审计四坑（宣传与可用性诚实化）

- **PPT「导出 PPTX」占位 → 真 OOXML**：新增 `buildPptxFromImages`（jszip 构造合法
  PPTX：ContentTypes/rels/presentation/master/layout/theme/逐页 slide+media，16:9 EMU，
  图片 contain 居中、PNG/JPEG、IHDR 尺寸回退）；PPTEditor 导出逐页截图生成**可被
  PowerPoint/WPS 打开的真实 .pptx**；OPC 结构完整性单测（模拟打开前包校验）5 例
- **纠偏模型配置面板占位 → 真实接线**：面板读写 `codem-correction-model`
  （provider/model/apiKey/baseUrl），保存即时生效；`fact_check` 工具每次调用实时决策：
  有专属配置用它（key/baseUrl 逐级补齐），无配置回退主模型并**诚实标注**
  「未配置专属纠偏模型，本次使用主模型核查」；移除从未注入的
  `ctx.correctionProvider/correctionModel` 假默认契约；14 单测
- **Whisper 语音输入无入口 → 双引擎闭环**：设置→语音新增「语音输入引擎」
  （浏览器识别 / 云端 Whisper·OpenAI）；输入区麦克风按引擎分流——Whisper 走
  MediaRecorder 录音 → `/audio/transcriptions`（whisper-1）转写回填；含引擎切换释放
  麦克风、未配置引导、无 SpeechRecognition 降级提示；公开 `transcribeAudioFile` 并让
  vision-proxy 委托同一实现；20 单测 + vision-proxy 102 回归
- **会话内搜索死代码 → 激活可用**：会话头部新增「搜索当前会话」入口；结果点击平滑
  滚动定位（处理 unified 合并气泡回溯）；修掉旧内联过滤在弹窗关闭后残留残缺视图的
  隐藏 bug；tsc + ChatPanel 相关 14 用例

### 附带

- 清理 InputArea 重复 `isDragOver`/`zh` 声明（并发修复中发现的既有 bug）
- **功能文档体系**：`项目功能说明介绍.md`（20 大域 152 亮点，宣传向，梦幻皮肤独立域
  13 项细粒度）+ `项目功能树-全量.md`（18 路并行只读审计，**2779 项叶子功能点**，
  每条含证据路径与宣传句，占位/未接线不收录）+ 分层检索索引（附录 A）

### 新增：手动添加自定义模型名（服务器列表外的内测/测试模型，覆盖包）

- 服务商 /models 返回不了内测/灰度模型（如 `deepseek-v4.1-flash-expires-on-0910`，
  调用方式与同 provider 其它模型完全一致、仅模型名不同）——现在可在
  **设置 → 模型与 API Key → 对应 Provider 卡片**直接输入模型名「添加模型」，
  以 chips 展示、可逐个移除
- 存储独立（`codem-custom-models`，不入服务器缓存）：引擎加载 / 设置页 /
  聊天头部模型下拉 / 模型方案面板四处读取统一合并（mergeCustomModels），
  自定义模型与服务器模型同路径进入模型选择器并可用，删除即移除
- 12 单测（custom-models.test.ts）

- 全量 vitest 175 文件 / 4314 用例通过 + tsc 零错误 + cargo check 通过

## [1.11.1] - 2026-09-09 — zvec-grep（zg）语义检索集成 + archify 图表技能 + UI/体验修复打包

> 本版 = v1.11.0 同版本覆盖包（标题栏/Git 分支/导航轨等体验修复）+ v1.11.0 之后新增
> （zg 语义检索集成 c200ec9→264ead0 + archify 技能与 Codem 架构图 f4b6470）。
> 主安装包自 v1.11.0 首次包含这些代码：**必须升级本版**，插件市场的
> 「本地语义检索」卡片 / Rust 新命令 / 内置 archify 技能才会出现在应用内。

### UI / 体验修复（v1.11.0 覆盖包内容，随本版首次打包）

- **标题栏可拖拽修复**：删除历史遗留的 `.titlebar-center`（absolute+no-drag 规则）与
  nav-actions 容器 no-drag 空白区——标题栏自 logo 到右侧按钮整条可拖，按钮仍可点击
- **标题栏 Logo**：`◆` 菱形占位替换为当前品牌（自 `icos/codem.ico` 提取 256px PNG）
- **左下角用户头像**：读取 `codem-user.avatar`，设置保存后即时刷新（聊天头像同源）
- **右侧栏磨砂玻璃**：面板改 88% 玻璃底 + 强模糊，z-index 提至 920 盖过消息导航轨
- **消息导航轨（执行轨迹/历史滑轨）**：点位置改「全内容比例」铺轨（修一屏仅 1-2 点的
  视口坐标 bug）；隐藏灰线、点统一紫色系；相邻点最小间距 10px 避让；悬停预览跟随节点
- **Git 分支控件收敛**：标题栏 GitBranchSelector 并入右侧栏 Git 面板（GitInfoPanel 内嵌，
  切换/新建分支后 onBranchChange 联动刷新）
- **右侧栏「智能体」tab 删除**：与顶部「智能体与团队」按钮（AgentPanel 双维度）功能重复，
  移除 AgentRoster 组件及样式

### 新功能：zvec-grep（zg）语义检索（可选增强，不改架构）

- **能力**：本地「语义向量 + BM25 + 精确 rg」统一检索；与内置 grep 双轨并行、模型按
  工具描述智能路由（精确锚点→grep；措辞未知/语义/跨文件→zvec_grep_search）
- **形态**：运行时按用户主动安装于 `<appData>/.codem/zvec-grep/`，不进安装包；经 MCP
  stdio（`zg server --stdio` 自动起/复用 daemon）接入现有 MCPRegistry
- **Rust 新命令**：`http_download_ext`（长超时大文件下载）+ `extract_zip`（zip-slip 安全解压）
- **编排服务** `src/core/zvec-grep/`：node 检测/便携下载决策、在线一键安装（复用系统
  node ≥22，否则下载 portable）、离线单包导入、卸载、索引重建与模型切换
- **工具接入**：`syncZvecTools` 把 `zvec_grep_search` 注册进共享工具表（仿 codegraph）；
  grep 描述双向路由提示；只读/并发/权限集合加白
- **插件市场卡片**：插件管理→插件市场→「本地语义检索（可选增强）」——一键安装 /
  导入离线包(.zip) / 为当前项目建索引 / Embedding 模型切换（potion-code-16m-v2 默认
  ~33MB，MIT；可选 multilingual-e5-small 等）
- **发布产物**：`scripts/build-zvec-runtime.ps1` → `codem-zvec-win-x64.zip`（单合并包
  ~125MB = 裁剪运行时 + code-16m 模型；剔除 llama-cpp/onnx-web，保留 *.wasm 供
  tree-sitter 解析），随 Release 提供；全离线端到端验证通过（解压→索引→中文语义查询）

### 新功能：archify 图表技能（内置）

- **内置技能** `src/core/skills/archify/`（v2.17，tt-a1i，MIT）：架构/工作流/时序/
  数据流/生命周期图——JSON-IR 规格 → `validate`（showcase 9 项构图/可读性）→ `deliver`
  渲染自包含交互 HTML（暗/亮主题、缩放、视图章节、导出）
- **Codem 架构图 / 功能结构图**已用本技能产出（`artifacts/archify/html/`，9/9 校验、
  0 错误，组件带源码证据 `evidence.verified`）

- 全量 vitest 171 文件 / 4260 用例通过 + tsc 零错误 + cargo check 通过

## [1.11.0] - 2026-09-08 — 团队体系深合并（B）+ 智能体双维度面板 + 审计修复

> 本版自 v1.10.0 后的全部改动：持续审计第 1 轮修复（dde3620）→ 子智能体/团队体系盘点（07dd260）
> → B 方案深合并 Phase1-3（614de0d/dab14c5/6585c9d/abfec90）→ 深合并后审计修复（a5b4e1e）
> → 「智能体与团队」双维度面板与行内预览（86646ac/60b89aa/120ae66）。

- **持续审计修复（第 1 轮，dde3620）**：executor end 失败判据补全（非 completed 即落库失败，覆盖 safety_valve 等）；宠物卡轻量推送误清修复（emitPetStateLight 缺省跟随 store 当前 card）；runPs 默认超时 30s→60s
- **子智能体/团队体系盘点（07dd260）**：docs/AGENT-SYSTEMS-MATRIX.md——厘清 5 套体系（Agent 定义/子智能体运行时/委派/Squad/agent-teams）入口与能力矩阵；确认 EAC 上游 dsh-agent-teams 实为会话旁浮动面板
- **B 方案深合并（docs/TEAM-CONSOLIDATION-PLAN.md）**：把两套"团队"（静态 Squad 模板 + agent-teams 运行时 DAG）合并为单一「团队 = 角色模板 + 运行时编排」。

- **Phase1（dab14c5）**：Squad 升级为「团队模板」——新增 TeamTemplate/toTeamTemplate；`squad_list`=模板列表、`squad_dispatch` 桥接 agent-teams（按模板建运行时团队：当前会话=队长、按角色 spawn 可续聊成员、任务入共享池调度；删除旧 CustomEvent 派发）、`squad_status`=模板+派生运行时团队摘要（team_id 可选）；App `codem-squad-dispatch` 事件路由删除；测试适配 + team-consolidation 5 例
- **Phase2（6585c9d）**：TaskCenter tab `squads`→`teams`（TeamTab：说明 + 运行时团队活动（嵌入 AgentTeamsPanel，订阅自动刷新）+ 团队模板管理（复用 SquadsTab））；对话旁「团队活动」按钮收敛为快捷入口（→ 任务管理「团队」Tab，App 监听 codem:open-task-center）；旧 id 归一兼容
- **Phase3**：清理死码 `generateSquadRoster`/`SquadDispatchResult`（旧 Leader-roster 路径已无消费者）；相关测试对齐 toTeamTemplate
- **深合并后审计修复（a5b4e1e）**：`squad_dispatch` 模板无 agent 角色时前置拒绝（不建空转团队）
- **「智能体与团队」双维度面板（86646ac/60b89aa/120ae66）**：顶部「子智能体」页面升级——当前会话有活动团队时首部渲染团队卡片（成员=角色+状态点，订阅实时刷新），点成员行内展开该成员个体动态预览（最近工具/思考活动+结果摘要，不跳页；「完整详情 →」按需进入 AgentDetail）；团队成员从平铺列表去重；修复 engine `snapshot()` 丢失成员 id 导致下钻失效/去重失灵的 bug；团队变化/切会话自动清理展开态；离线成员不可展开提示
- 全量 vitest 168 文件 / 4239 用例通过 + tsc 零错误

## [1.10.0] - 2026-09-07 — EAC 对标 第①②③④项（DSH-Desktop-EAC）+ 全量审计修复

> 第④项宠物状态卡 + 第③项 computer-use + 第②项微信 ClawBot 桥 + 第①项手机连接
> （顺序按工作量递增）。四项全部落地后做了全量审计（注册/桥/工具链/引擎侧四路只读子代理
> + 手工核验），发现并修复断链与孤儿（见下「审计修复」小节——无论是否本次对标引入，遇 bug 即修）。

### 审计修复（4 项功能完整性 / 孤儿功能 / 上下游数据流）

> 审计方式：4 路只读子代理（注册一致性 / Rust↔TS 桥 / computer-use 工具链 / 引擎侧接线）+ 手工交叉核验，
> 产出缺陷清单（P0×1 + 高×2 + 中×9 + 低若干）。

### P0/P1/高

- **A1 computer-use 全工具断链修复（P0）**：runPs 以 `powershell -NoProfile -ExecutionPolicy Bypass -File ...` 调用，
  与 Rust `execute_command`（恒以 `-Command` 执行并剥 powershell 前缀）约定断裂，`-NoProfile` 被当命令名、实测全挂。
  改为内置 ExecutionPolicy bypass + 调用运算符 `& '<ps1>' -Json '<b64>'`（与 grepSearch 同款约定）。新增契约回归测试。
- **A2 动作名/载荷失配修复（高）**：wait（PS 补分支）、get_cursor_position→getpos、move_mouse→move、
  click 右键/双击 button→action2、drag start/end→from/to——此前恒 unknown action / 静默降级左键 / 恒 (0,0) 拖动。
- **P1 宠物状态卡"隐藏"断链修复（高）**：`updateCard(null)` 时 pet-state-update 省略 card 键 → 宠物窗永远保留旧卡。
  emitPetStateLight/sendFullStateToPet 现恒发 `card`（null=显式清除），窗口能收到清除信号，2.5s 归位真正生效。

### 中

- **D2/B3/P5 插件"禁用=关闭"真实生效（安全语义）**：App 依据插件禁用清单联动——禁用 @codem/wechat-bridge 停消息监听、
  @codem/phone-link 停 Rust LAN 服务（外部可达面关闭）、@codem/computer-use 置门禁标志（modeGate 全拒含 auto）；
  重启后禁用即生效；UI 文案与 KNOWN riskDescription 同步为真实表述。
- **P6 executor end 级失败落库**：too_many_errors/max_iterations/no_progress/overflow 且无文本产出时写 system error
  并返回 success:false（微信/手机端不再静默无回复）。
- **F1 手机 /api/chat 语义修复**：先回 202（已接受）再后台执行回合——不再等完整 agent 回合（>15s 必 504）后才回执，
  避免"失败提示 + 实际已执行"与重复发送。
- **F2 配对 cookie 可重放**：approved 响应重复轮询时重发同一 session secret（弱网丢首条响应不再永久 401）。
- **F3/P9 /status 配额取错 peer**：describeStatus 按当前 peer 过滤（原取 HashMap 首元素）。
- **B2 computer_see 对 vision 主模型失效**：vision-proxy 新增公开 describeImagePublic/getVisionConfig；computer_see
  强制走独立视觉模型（vision slot → 多模态设置），未配置时回退主 chat provider 带图直连，再无可回退则给出配置引导。
- **D1 @codem/ui-pet 元数据对齐 + 可禁用**：KNOWN 元数据改真实（provides pet、去 slots 覆盖层残留）；builtin 注册
  使 PM-4 防回归覆盖；loadUIPlugins 对禁用 @codem/ui-pet 不装配（下次启动生效）。
- **D3 mimo-auth 反向孤儿**：KNOWN 补条目（builtin+yml 有而清单无 → 插件管理器不可见/不可关）。
- **D4 hot 漂移**：KNOWN 中 agent-teams/computer-use/wechat-bridge/phone-link 移除与 builtin 不一致的 hot:true。

### 低

- F4 启动期二次 ilink_status drain 竞态（删第二次调用）；F5 ilink fetch_qr/换代窗口期旧循环写状态（epoch 校验）；
  F6 phone_start 并发双监听（bind 后二次互斥检查）；P2 finally 归位集合扩大（英文/工具阶段残留也清）；
  P4 宠物停用清卡；P8 executor 回合 race 兜底超时（队列不被卡死不产事件的回合挂死）；P10 wechat cwd 空守卫；
  P11 wx-workspace 内部项目过滤（SpaceSwitcher/Sidebar/手机会话列表）；C2 searchHint 双语含英文关键词；
  C3 临时目录经新 Rust 命令 get_system_temp_dir（webview 无 process.env，旧硬编码 C:\Windows\Temp 非管理员写失败）；
  b64 改 TextEncoder+btoa（webview 无 Buffer）；孤儿清理（sendTestMessage 接入 provider 服务面、provider 死 import 移除）。

### 未改（记录在案，安全/范围决策）

- P7 微信/手机回合无桌面批准通道：保持 executor 缺省保守策略（非 full 自动拒绝写/执行）——远程触发不越权，
  被拒信息经 tool result 可见；桌面批准通道接入列为后续体验项。
- B1 awaitingApproval 无 UI 弹窗联动：文案已修正（仅 /computer 生效），UX 联动后续做。
- P12 runAgenticLoop 与 executor 跨路径互斥、C4 read_file_base64 无大小上限、P3 归位定时器不可取消：
  低频/边界，记录不修。
- db-save-failure-alert 偶发 flaky（磁盘满模拟时序，单跑即绿）：历史问题，非本次对标引入。

### 审计修复测试

- 新增 computer-use-contract.test（A1/A2 契约 + 插件门禁 + temp 兜底 4 例）；全量 vitest 167 文件 / 4231 用例通过
  + tsc 零错误；Rust `cargo test --lib` 38 通过。



### 第①项 @codem/phone-link 手机连接（LAN 扫码配对 + 手机浏览器访问桌面会话，对标 dsh-phone）

- **Rust LAN HTTP 地基**（`src-tauri/src/phone/`，零新依赖，手写极简 HTTP/1.1 on tokio）：
  - `http.rs` 解析/响应 + `lan.rs` UDP-connect 取默认路由 IP；0.0.0.0 随机端口监听
  - **配对门卫对标 EAC phone-bridge**：token URL（随机 32B、5min TTL、轮换）→ 手机开 `/pair?token` 等待页轮询 `/api/pair-state` → 桌面批准 → `Set-Cookie codem_phone=<secret>; HttpOnly; SameSite=Strict; 1y`；secret 仅存 sha256（app-data/phone/devices.json，重启保配对，≤8 设备）
  - 手机页（内嵌 pair.html/app.html）+ /api/* 全部 cookie 鉴权后**代理到 WebView TS**（phone-request 事件 + phone_respond 应答，reqId 关联 15s 超时 504）
  - 6 个 commands（phone_start/stop/status/decide/unpair/respond）+ 事件 phone-state/paired/request；启动自动续连（TS autoStart）
  - 12 Rust 单测（解析/URL 解码/cookie/配对 token 生命周期/常数时间比较/sha256 落盘鉴权）
- **TS 引擎半层**（`src/core/phone-link/`）：路由 phone-request → `GET /api/status`（桌面当前项目/会话）· `GET /api/sessions`（全部项目会话真实拍平倒序）· `GET /api/sessions/<id>/messages`（MessageStorage）· `POST /api/chat`（executeSessionTurn 续聊桌面会话，busy 409）· `POST /api/chat/new`（开新会话）——**不编造：手机与桌面看到同一会话/同一历史**
- **桌面设置卡「连接手机」**：启停 + 配对二维码/链接复制 + 批准/拒绝 + 设备列表/解除 + autoStart + 合规提示（同 Wi-Fi/防火墙/明文 HTTP/二维码勿外传）
- 注册 runtimePluginList/builtin-registry/codem.base.yml（默认开启可禁用，risk danger）；6 TS 单测

### 第④项 宠物大肥鱼式状态卡（commit 929a0f3，对标 dsh-dafeiyu）

- **真实 Agent 事件驱动工作状态卡**：项目名/阶段/步骤进度/消息，在桌宠气泡上方状态卡展示（透明无边框置顶窗 + 锚点 resize 并入）
- 事件流接入 llm_status/step_progress/tool_start/tool_complete/tool_error/end——**进度只显示 agent 真实上报的宏步（total 可 null 时只显当前步，不编造完成百分比）**
- PetCard 类型 + pet-store updateCard + PetWindowApp 卡 UI；77→3 新增测试（含"total null 不编造"）

### 第③项 @codem/computer-use 电脑操作插件（commit c7ad786，对标 dsh computer-user / Codex computer use）

- 10 个 computer_* 工具（screenshot/click/type/keypress/scroll/drag/move_mouse/wait/get_cursor_position/set_mode），PowerShell 零依赖后端（capture.ps1/input.ps1 已内联，EAC MIT 声明）
- 模式 disabled/readonly/manual/auto，**默认 manual 手动批准**（/computer 会话批准 + 批准集）；`computer_see` 视觉理解走 Codem vision-proxy（无本地 OCR，提示词引导坐标）
- Rust `read_file_base64` + 设置卡「电脑操作」+ 插件默认开启可禁用

### 第②项 @codem/wechat-bridge 微信 ClawBot 桥（iLink 直连，对标 EAC/OpenClaw 微信通道）

- **Rust iLink 传输层**（`src-tauri/src/ilink/`，零新依赖）：官方 @tencent-weixin/openclaw-weixin 2.4.6 协议
  - 登录 8 态状态机（get_bot_qrcode POST + local_token_list 多端互认 → get_qrcode_status 长轮询 + 配对码 verify_code + scaned_but_redirect 切 baseurl）【官方 + 社区】
  - getupdates 长轮询单循环（epoch 代际作废 + poke 即时唤醒、游标每轮落盘续拉、401/403/-14 → Expired 弹重扫、2s→30s 退避）
  - sendmessage 文本（≤2000 切块、context_token 原样回传、run_id/client_id）+ best-effort notifystop
  - 会话文件 app-data/ilink/session.json（0600、损坏即未登录、23h 判活）+ 历史 token ≤10；**每 peer 配额软记账（10条/24h 社区实测，非官方承诺，明示不编造）**
  - 6 个 tauri commands + 5 类事件（ilink-status/qr/need-verify/inbound/expired 命名 ilink-*）；启动自动续连（未过期会话）
- **TS 引擎桥**（`src/core/wechat-bridge/`）：peer→Codem 持久会话映射（sessions 行先行避 FK，历史仅依赖 messages 表，跨轮记忆连续）→ `executeSessionTurn` 驱动 agent 回合 → 取回最终文本回复；每 peer 串行队列 + message_id 去重 + 挂载前缓冲兜底
- **准入安全**：Bot 主人（ilink_user_id）自动放行；陌生 peer 首条 → 「待批准」卡片（批准/拉黑）+ 引导回复；命令短路 /help /status /new /model /clear /attach /reconnect /allow /ignore（主人权限门禁）；主开关停用即完全不响应
- **UI 设置卡「微信 ClawBot」**：状态徽章、SVG 二维码（qrcode-generator 依赖，链接复制兜底）、配对码输入、24h 过期软提醒、默认模型/工作区、待批准/白名单/黑名单管理、合规提示（媒体/群聊二期不支持）
- 注册 runtimePluginList/builtin-registry/codem.base.yml（默认开启可禁用，risk danger）
- 测试：Rust ilink 13 单测（client-version/uin/headers/文本提取/切块 UTF-8/会话存取/token 历史/配额窗口/过期）；TS 7（净化/命令/准入/截断/持久化/初始态）

### 测试与质量

- 全量 166 文件 / 4227 用例通过（+6）+ tsc 零错误；Rust `cargo test --lib` 38 通过（ilink 13 + phone 12 + 既有 13）

## [1.9.9] - 2026-09-07 — EAC 对标（DSH-Desktop-EAC 差距分析与仿照实施）

> 对标仓库 github.com/zouyuxuan122/DSH-Desktop-EAC（dsh 桌面发行版，47 内置插件）：
> 分析 → 差距矩阵 docs/EAC-GAP-ANALYSIS.md + 机制笔记 docs/EAC-BENCHMARK-NOTES.md（皮肤不对标，用户决定）。

### 重叠部分 UI 交互改进（对标 message-rewind / navbar / meow-smooth 等）

- **A1 编辑并回退（fork 保留原会话，对标 dsh-message-rewind / Trae）**：user 消息 hover 新增「编辑并回退」（Undo2）——编辑后复制此前缀到新会话重放，原会话保留不动（原地「编辑并重发」保留为 Pencil）。数据层测试 message-rewind-fork（4 例：前缀复制/原会话不动/编辑消息入新会话/全新 id）
- **A2 节点导航升级（对标 dsh-navbar）**：ScrollbarMarkers v2 —— 修复几何绑定 bug（旧版监听不滚动的 .messages-container，现绑定父级 .chat-body 真滚动容器）+ portal 到 body 规避 transform + hover 预览卡（244px/4 行）+ 滚轮循环切换 user 消息 + **📌 消息精选 pin**（assistant 消息可精选为金色盘，按会话 localStorage 持久化，nav-pins 模块 4 测试）
- **A3 输入框失焦折叠（对标 meow-smooth）**：多行草稿失焦自动收成单行胶囊（150ms 过渡），点击/聚焦即时展开恢复
- **D1 字号设置真正生效**：旧字号滑杆只写 JSON 无消费方——新增 --ui-font-scale 缩放全部 --fs-* 刻度 + 启动恢复 + 滑杆即改即生效（core/ui-font.ts）
- **D2 设置搜索可用**：占位搜索框 → 键入自动跳转匹配设置分组 + 匹配提示/无匹配反馈

### 新增可启停插件（Codem 原本没有，剥离为内置插件注册）

- **B1 临时会话 side-session（对标 dsh-side-session / Codex side session）**：页内可拖拽悬浮窗，基于当前会话最近消息 + 项目目录独立流式问答，**不写回主会话**（store/DB 零污染）；ChatPanel header 入口按钮。core/side-session 上下文窗口纯逻辑 5 测试
- **B2 persona 人设卡（对标 dsh-soul-md）**：持久化多张人设卡 + 设置「人设」tab 管理 UI（新建/编辑/文件路径模式/设为激活/删除）+ `# Persona` 段注入主 prompt（紧随身份段）+ 外部文件热重载。**修复历史缺陷**：旧 persona-provider 仅内存 Map 且从未接入主 prompt（SOUL 孤儿代码）。7 测试
- **B3 @codem/agent-teams 团队编排插件（对标 dsh-agent-teams，完整差距项）**：队长/可续聊成员/依赖任务 DAG 状态机（pending→claimed→in_progress→terminal，依赖全完成才可领取）+ **attempt 令牌防覆盖**（转派撤销旧代、迟到结果 stale 拒绝）+ 成员直达邮箱（60s 租赁投递）+ 共享调度（任务图变更 kick 空闲成员自动领取、投递失败精确回滚）+ 10 个 `agent_teams_*` 工具（队长专属工具按会话授权）+ ChatPanel 团队活动面板（成员/任务/依赖/未读）+ 注册 runtimePluginList/builtin-registry/codem.base.yml（可启停）。引擎 16 + 服务 6 测试

### 测试与质量

- 全量 163 文件 / 4202 用例通过 + tsc 零错误；修复 architecture-changes 测试正则误匹配（后代选择器 .message-input 需行首锚定）

## [1.9.8] - 2026-09-07

### 对话用量统计 + 缓存命中率真实化（对标 anywhere-labs/dsh-desktop）

- **对标调查**：本地参考仓库即 anywhere-labs/dsh-desktop；dsh 的每轮用量/缓存统计 = adapter 精确上报 cacheRead/cacheWrite（TokenUsage inputTokens 为 uncached 口径）+ 每轮折叠 UI + 诚实精度命中率（99.97% 不圆成 100）
- **Codem 现状**：StatsLine/每轮 usage 已有（历史对标），但 **provider 归一化丢弃了 DeepSeek prompt_cache_hit_tokens**，命中率用 `promptTokens × 0.3` 假估算 → 显示失真
- **修复（真实数据链路）**：
  - `TokenUsage` 扩展 `cacheHitTokens` / `uncachedInputTokens`
  - `provider.ts` 归一化透传 `prompt_cache_hit_tokens`（兼容 OpenAI `cache_read_input_tokens`），uncached = prompt − hit
  - agentic-loop 每轮累计真实 cacheHitTokens（随 turnMetadata 到该轮助手消息）
  - token-tracker 真实 cache 优先，未上报回退估算
  - StatsLine：inputTokens 改 uncached 口径（不重复计）+ 高精度命中率显示
  - 新增 `cache-percent.ts`（移植 dsh 诚实精度算法）+ `cache-prefix-stability.test.ts`

### 缓存命中率差距分析 + 稳定前缀优化（dsh 达 99.97%）

- **差距一（数据层，已修）**：从未采集真实命中数据（假 0.3 估算）→ 无从谈命中率
- **差距二（前缀工程，本轮修复一项关键破坏点）**：DeepSeek 前缀缓存按"请求前缀到首个差异点"命中——**date（每分钟变化）原位于系统提示中段的 # Environment**，其后所有稳定内容（工具指引/MCP/语言规则等）每轮被切断缓存。修复：date 独立段**尾置**到系统提示最末（# Current Date）——不同分钟的两份 prompt 公共前缀覆盖 >95% 内容（测试断言防回退）
- **其余稳定面核验**：工具 guidance/deferred hints 均拼接在 prompt 尾部；core tools 列表稳定（defer 工具 tool_search 加载不改 core 集）；消息历史追加式稳定；压缩摘要/新会话首轮 miss 为 DeepSeek 机制固有（dsh 同样，其 99.97% 是长会话稳态统计值）
- **审计续核（无新缺陷）**：request-header 模块为纯诊断用途（getCacheStats 无 UI 消费，无假命中率显示）；消息 metadata（turnMetadata.usage）已持久化到 messages 表（重启后 StatsLine 每轮用量仍显示）；同配置连续请求 prompt 100% 一致（新增断言：前缀稳定 = API 命中前提）
- **usage 归一化口径精确化**（`usage-normalize.ts`）：uncached 优先用 DeepSeek 显式 `prompt_cache_miss_tokens`（此前用 prompt−hit 减法，对不含 cache 的 OpenAI 口径会误扣）；OpenAI cache_read 无 miss 时取 max(0, prompt−cache) 折中；异常口径 clamp 防负数（4 用例）
- **StatsLine 显示正确性**：provider 未上报缓存字段（非 DeepSeek 系/Ollama 等）时不显示误导性的"缓存命中 0%"（cacheReported 门控——与 dsh 一致：cacheRead 未上报即不展示命中率）
- **端到端集成测试**（`cache-loop-accumulation.test.ts`）：脚本化 provider 回放带 cache 的 usage 事件 → 真实 AgenticLoop → result.usage 正确累计 cacheHitTokens/uncached/成本（含缓存价差计价）——StatsLine/每轮用量 UI 的采集→汇总数据源闭环验证（不依赖真实 API）
- **用量统计面板缓存命中卡**：CostTracker.recordUsage 落盘真实 cacheReadTokens；设置→用量统计概览新增「缓存命中率」卡（近 7 天 provider 上报调用聚合，诚实精度格式；未上报不显示）——用户跑任务后打开用量统计即可验证整体命中率（无需逐轮盯 StatsLine）

### 缓存命中率真实请求实证（受控探测，结论已修正）

- **方法**：经授权用运行实例配置的 DeepSeek key 发受控请求——短前缀（~100 tokens）与长前缀（3259 tokens）两轮，以及多轮序列模拟与超长前缀稳态探测（A/B/C/D 四组）
- **实证结果（结论修正）**：短请求恒 miss（~100 tokens 前缀低于缓存阈值）曾误判"通道无缓存"；**长前缀探测修正**——首次写入 miss 全量 → **完全相同重复请求 hit=3200/3259（98.2%）** → 前缀+追加 hit=3200（前缀全命中）——**deepseek-v4-flash 支持前缀缓存，但缓存需足够大的前缀才建立/命中，短请求低于阈值恒 miss**
- **命中率规律（实测拟合 1 − δ/N）**：多轮序列模拟（5.6K 前缀逐轮追加）第 2 轮即 97.6%、末轮 99.67%；37.7K 前缀稳态轮 99.6~99.8%；**96K token 前缀完全相同重复请求稳定命中 99.947%**（δ≈51 固定尾巴随前缀增长占比趋零）——dsh 的 99.97% 为数十万 token 前缀稳态，同 key 同形态表现一致
- **结论（回答"为何同 key 与 dsh 表现不同"）**：Codem 与 dsh **同 key 效果一致**——dsh 的 99.97% 是数万 token 长会话前缀的自然稳态；真实对话前缀随轮次增长（几千→几万 token）后 DeepSeek 自动建立前缀缓存并返回 hit，**Codem 同 key 长会话同样可达 dsh 量级命中率**（实现零改动即如实显示；date 尾置等前缀稳定优化保证前缀尽量不被切断）。此前"通道无缓存 / 需换模型"判断系短请求探测误导，已更正
- 全量 157 文件 / 4159 用例通过 + tsc 零错误

## [1.9.7] - 2026-09-04

### v1.9.7 补丁（同版本覆盖发布：commit 7d1f329 / 88b49f2）

> v1.9.7 发布后以同版本补丁追加覆盖 release 资产，以下 5 项随补丁发布：

#### 技能市场联网搜索卡死修复（"正在联网搜索…"无限 loading）

- **用户报告**：搜索无本地结果的关键词（如 diagram-design）后，一直显示"正在联网搜索"数分钟，无结果也无失败提示
- **根因（UI effect 竞态，`SkillManager.tsx`）**：搜索 effect 的 cleanup 只清防抖 timer + 设 `cancelled`，而搜索完成回调只在 `!cancelled` 时复位 loading；一旦 effect 因输入变化/结果渐进合并被 cleanup 取消，旧搜索被取消后**不再复位**，而新 effect 若走"空查询/本地已有结果"提前返回分支也**不复位** → `onlineSearching` 残留 true 永久显示
- **修复**：①**搜索代次机制**（searchSeqRef）——只有最新一次搜索能合并结果/报错/复位 loading，旧搜索后台完成不碰 UI；②effect cleanup 与提前返回分支直接复位 loading；③**30s watchdog 兜底**——即便再漏网，超时强制结束并提示"联网搜索超时，请检查网络或换关键词"（用户永远拿到明确反馈）；④搜索异常（catch）向用户显示失败原因（原仅 console.warn）
- **源层核验**：联网搜索（searchMarketSkillsOnline）与检查更新（listMarketSkills）两路径的每个源都有 12s `Promise.race` 超时兜底（有界，非源层挂起）；核验无其它同类残留 loading 模式（loadMarketSkills finally 无条件复位）
- 全量 152 文件 / 4140 用例通过 + tsc 零错误

#### GitHub URL 标签重复生成修复（输入每字符加一个标签）

- **用户报告**：在对话编辑框手打 GitHub 开源项目 URL 时，每输入一个字符就生成一个仓库标签，不停堆积
- **根因**（`InputArea.tsx`）：onChange 逐字符调用 `detectGithubUrls`，把"未输完的 URL 前缀"（https://github.com/c → /ca → /cat …）都当作完整 URL 添加 badge——每个前缀是不同的 badge id，原有按 url 去重失效 → 标签堆积
- **修复**：改为**防抖 + 同步式 reconcile**——①输入停顿 500ms 后才检测当前文本（粘贴/快速手打都只出 1 个标签）；②每次检测同步差集：旧"过渡前缀"标签被更长 URL 取代时自动移除（始终 ≤ 实际 URL 数）；③用户手动删除过的 GitHub URL 本会话内不再自动加回（removedGithubUrlsRef）；④组件卸载清理防抖定时器
- 全量 152 文件 / 4140 用例通过 + tsc 零错误

#### 输入框光标视觉错位修复（长 URL 粘贴时 caret 偏 1 格）

- **用户报告**：粘贴/输入长 URL（如 https://github.com/cathrynlavery/diagram-design）后，光标视觉位置比实际插入点靠前 1 个字符（实际在末尾、显示在倒数两字符之间）；已确认**纯视觉错位**（文本与实际插入点正确）
- **根因**：输入框采用"透明 textarea + backdrop 镜像层"架构（textarea 文字透明只显示 caret，可见文字由 backdrop 层渲染）——两套排版一旦有细微字体/断行差异，caret（textarea 原生）与可见文字（backdrop）就会视觉错位
- **修复（根治）**：改为**条件镜像**——仅在文本含 `/xxx` 技能模式（需要 pill 高亮）时才启用透明+backdrop；普通文本（含 URL）时 textarea **直接显示文字**，caret 与文字同源渲染，物理上不可能错位；同时 backdrop/textarea 强制同一显式字体栈（var(--font-family)）+ 关闭字体连字（font-variant-ligatures: none），消除排版差来源
- 全量测试通过 + tsc 零错误

#### CodeGraph 工具真正接入 LLM（defer 按需加载，修复"指导有、工具不可调"）

- **问题**：codegraph_explore 此前只在 systemPrompt 手写指导（"优先使用 codegraph_explore"）+ MCP 工具文本清单里出现，但 LLM 的 function-calling schema（ToolDef 表）里**没有该工具**——模型照指导调用会报工具不存在，指导落空且浪费 token
- **整改**（`llm/tools/codegraph-tool.ts` 新增）：
  - 已连接的 codegraph MCP 工具包装为**可调用 defer ToolDef**（`shouldDefer: true`）：完整 schema 默认不进请求，model 需要时经 `tool_search` 拉取（该轮才计 schema 成本）——schema token 按需出现
  - `searchHint` 写明触发场景（调用链/谁调用/改动影响范围；普通读写仍走 read/grep/glob）——场景由模型按任务判断，不做强制门控
  - `syncCodeGraphTools`（engine 每次构建系统提示、autoDetect 后调用）：连接→注册；断开/禁用→移除残留——**提示与可调用集合严格一致**
  - 删除 prompt.ts 手写 CodeGraph 指导段与 `codeGraphEnabled` 配置字段；CodeGraph 提示改由 agentic-loop 的 "Deferred Tools" 段自动呈现（工具注册才出现）
  - execute 转发 `getMCPRegistry().callTool` 并展平 MCP content 文本
  - 测试：codegraph-integration.test.ts 重构为新契约（无手写段 / 注册即 defer schema 可经 tool_search 拉取 / 断连移除 / e2e 注册-可调闭环）

#### CodeGraph 应用内一键安装（方案 B：用户零命令行）

- **背景**：CodeGraph 是外部 CLI（vendored Node 自包含 zip ~52MB），原需用户自行下载安装（不符合"一个安装包"目标）
- **Rust `codegraph_install` 命令**（`lib.rs`，新增 zip 依赖）：GitHub API 解析最新 tag → 下载 codegraph-win32-x64.zip → 解压到 `%LOCALAPPDATA%\codegraph\current`（路径穿越防护）→ 返回启动器绝对路径（`bin/codegraph.cmd`）
- **设置页「⬇️ 一键安装 CodeGraph」按钮**：点击即在应用内完成下载/解压并把启动器路径存入设置（`codem-codegraph-launcher`）——不再要求用户敲命令/改 PATH
- **MCP spawn 支持 .cmd**（`mcp_stdio_connect`）：Windows 下 command 以 .cmd/.bat 结尾时用 `cmd.exe /c` 包装（codegraph 官方发布入口是 bin/codegraph.cmd，CreateProcess 无法直接执行——修复后连接才真正可 spawn）
- **连接与检测联动**：`autoDetectCodeGraph` 连接命令优先用已存 launcher 绝对路径（fallback PATH 'codegraph'）；设置页 CLI 检测优先检查 launcher 存在
- **检测逻辑修复**：exitCode/stdout 三重兜底 +「🔄 重新检测」按钮（此前只看 stderr 两种英文文案，其余一律误判"已安装"）
- 测试：launcher 路径连接/回退（codegraph-integration 48 用例）+ 全量 152 文件 / 4140 用例通过 + tsc/cargo 零错误

### dsh 插件市场与插件架构全面改造（对标 deepseek-harness）

> 分析 harness 插件生态机制（npm 包 + cordis.patch.yml 分层装配 + Loader 激活 + plugin-inventory UI）后评估：Codem 装配/管理框架已同构，但**无法加载任意 npm 插件**（运行时鸿沟），dsh-compat 桥此前 deprecated 未接入。本轮落地：

- **插件市场目录**（`plugin-market/dsh-market-catalog.ts`，50 条真实官方 @deepseek-ai/dsh-* 包，与 harness packages 全量核对存在性）：三类兼容性评估——bundled 37（Codem 内置等价，codemAnchor 指向真实插件且**一对一唯一**，DM-2/DM-4 校验）/ adaptable 9（dsh 协议、无第三方依赖，可经 dsh-compat 桥接）/ unsupported 4（依赖 Node/npm 运行时或 zod 等 npm 依赖，诚实标注）；附 npm registry 在线检索（15s 超时）
- **插件管理弹窗新增「插件市场」Tab**（`components/plugin-market/PluginMarketTab.tsx` + PluginManager Tab 切换）：浏览/搜索/分类（能力/工具/界面/基础设施）、兼容徽标、bundled 条目一键"安装并启用"对应内置插件（**三态按钮**：未启用→安装 / 可安全卸载→禁用 / 核心恒启（llm/fs-local/session/shell-local/tools/credentials 等 6 锚）→只读"已启用（核心）"，杜绝把核心插件当卸载目标）、在线检索**跟随搜索框输入**、小窗自适应（maxHeight 滚动、manager 未就绪禁用安装）
- **dsh-compat 接入运行**：`dsh-compat/index.ts` 由"注册时同步取服务（时序竞态→别名缺失）"重写为**懒解析代理别名**（dshLlm/dshShell/dshFs/dshTools/dshSessions/dshEvents/dshCredentials 恒注册、方法调用时现取真实服务并做接口转换）；`builtin-registry` 注册 @codem/dsh-compat + `codem.base.yml` 装配行——"可适配"类插件有了真实承载
- **服务名对齐矩阵审计**（对 harness packages 全量插件 inject 服务名 78 项 vs Codem provides 203 项逐项比对）：核心 seam（fs/shell/tools/llm/session/credentials/sandboxPolicy/slots/commands/compaction/systemPrompt/userQuestions/subagent 等）**同名直通**；复数/命名差异（sessions/sessionProjections/sessionQuery/sessionTitle/goals/bash 等）由 dsh-compat 别名承接；约 30 项 harness 宿主装配名（remote.*/ui*/typert/webServer 等）属宿主层、超出纯协议插件范围——结论固化于 dsh-compat 头注释（后续审计基准）
- 测试：`dsh-plugin-market.test.ts`（DM-1~5：三类覆盖 + bundled 必有 anchor + anchor 全部存在于 runtimePluginList + fetch 失败返回 [] + bundled 锚**一对一唯一** + **真实依赖图下全部 bundled 锚安装级联可达、无缺失依赖**——市场"安装并启用"路径的自动化验收证据）+ `dsh-compat-lazy.test.ts`（DC-1~4 懒解析/转换）+ `dsh-plugin-market-wiring.test.ts`（PM-1~3 YAML↔builtin 装配一致性，防 terminal-bash 式断链）+ `plugin-market-tab.test.tsx`（MT-1~5：渲染/安装/禁用/**核心条目只读**）
- **插件皮肤兼容契约（Skin Token Contract）**：插件（UI/UX 类）与三套皮肤（default 亮/暗、dream、hub 恒暗）兼容机制化——`core/theme/skin-tokens.ts` 登记令牌表 + `auditPluginStyle` 源码级硬编码色审计；新测试 `skin-compat-plugin.test.ts`（SC-1~5：审计函数行为 / 市场 Tab+插件管理零硬编码色 / 令牌在 styles.css 均有定义 / 目录分类受支持 / **共享 Badge 语义变体规则体无裸露色**）；修复市场 Tab 安装按钮文字色 `#fff`→`var(--text-on-accent)`；**共享组件层修复**：styles.css 两组 `.badge-success/warning/danger/info` 从硬编码暗色系（rgba(34,197,94)/#4ade80 等）与未定义变量（--info-bg/--warning-bg）改为语义令牌 + color-mix 半透明（亮/暗/梦幻/Hub 自动适配）；市场分类改为**动态派生**（harness 无 UI 类核心插件，"界面"空分类不再渲染）；完整契约见 `docs/SKIN-PLUGIN-CONTRACT.md`
- **全面审计第二轮（Bug/可应用性/稳定性/UI-UX 交互）修复**：
  - **稳定性 P1**：`enable()` 级联启用**部分失败仍返回 success:true**（UI 假"已启用"）→ 任一失败即 `success:false` + 失败明细（`Failed to enable: <name>: <error>`）
  - **稳定性 P2**：**error 状态未持久化**（重启后 initialize 误判 enabled、无 fiber 假启用）→ `saveDisabledList` 将 error 计入未启用列表，重启后保持 disabled 可重试
  - **稳定性 P3**：**loading 态连点并发竞态**（同插件二次 ctx.plugin 加载）→ `enable/disable` 对 loading 状态拒绝（"being enabled/loaded, please wait"）
  - **架构 V1（重要）**：插件管理弹窗**每次打开都重建 PluginManagerService 并覆盖全局单例** → 旧实例加载进 ctx 的插件 fiber 追踪丢失，新实例 disable 找不到 fiber → **假禁用（插件实际仍在 ctx 运行）** + 每次 initialize 重复 doDisable/notify 副作用。修复：`initPluginManager` **ctx-ready 单例幂等**（已建直接返回，不再重建/不重复 initialize）；ctx 未就绪仅返回临时渲染实例（不缓存）；组件 ctx-null fallback 首次建临时实例后不再重复创建（retryCount===0 门控）
  - **UX P4**：插件管理 `handleToggle` 对 error/loading 静默无操作 → error 点击 = **重试启用**（toast 反馈）；loading 点击提示；级联确认 disable 失败补 error toast
  - **UI U1**：市场 Tab 安装进行中无视觉反馈、可连点 → 按钮 loading 态只读"启用中…"（+handleInstallBundled 防御）
  - **UI U6**：市场 Tab 布局链断（根容器无 flex:1 → 固定 maxHeight 网格在 80vh 弹窗内**裁掉底部在线检索结果区**）→ 根 div flex:1 + 网格 flex 滚动
  - **契约核对 P5（通过，无改动）**：dsh-compat 7 别名逐一对照真实服务源码——llm.complete/`stream`（async function*）/listModels、shell.execute(command,cwd,timeoutMs)、fs readFile/writeFile/listDirectory/deleteFile/exists、session create/get/list/delete、ctx emit/on/waterfall/serial/bail/parallel 全部匹配（buildFs.stat 以 exists 近似标注局限）
  - 新测试：`plugin-manager-robustness.test.ts`（R-1~R-5：级联全成功/部分失败必报错/error 持久化/error 重试恢复/幂等拒绝）+ `plugin-market-tab.test.tsx` MT-6（loading 只读态）
  - **真实 Cordis 装配集成测试**（`dsh-compat-live-cordis.test.ts`，LC-1~6）：用真实 Cordis Context + 真实 provider 插件（llmProvider/shellProvider/sessionProvider 经 `await ctx.plugin` 激活）+ dshCompatPlugin 验证——7 个 dsh 别名经 active fiber 注册可被 `ctx.get` 解析；dshLlm 懒解析全链路（→真实 llmProvider→llmEngine）可用；dshSessions 驱动真实 sessionProvider；dshEvents 走真实事件系统；服务未就绪**同步抛可诊断错误**（`[dsh-compat] service "session" not ready`）；fiber.dispose 后别名从 ctx 移除（市场"禁用 @codem/dsh-compat"真实卸载语义）。目标②（dsh 插件可应用性）由静态服务名核对 + 动态真实装配双向实证
  - **元数据漂移 V2（全量诊断 199 处差异收敛）**：runtimePluginList（静态清单）与 builtin-registry（激活同源）的 provides/inject 曾大幅 drift——dsh-compat 在清单里写成**大写 dshLLM/dshFS 且仅 4 个别名**（实际注册小写驼峰 7 个）→ 依赖 dshSessions 的插件被依赖图误判缺依赖、UI"提供的服务"徽章错误；另有 ~15 插件清单缺 llmEngine 等 inject（llm/tools/mcp/skill/subagent/settings/retry…）、sandbox-local 反向多 shell、host-client 缺 hostClient。修复：①清单 dsh-compat 条目改小写 7 别名 + builtin 注册补 category 'compat'；②**pluginRegistryProvider.apply 时以 builtinPlugins 覆盖 pluginMeta 的拓扑字段**（provides/inject/priority/core）——插件管理依赖图与 Cordis 激活**运行时同源**，静态清单 drift 免疫（UI 展示字段保留静态描述）；③PM-4 重写为真实装配驱动（registerBuiltinPlugins + ctx.plugin(pluginRegistryProvider)）后全量对比 100+ 插件拓扑一致 + dsh-compat 特判（防大写变体回归）
  - **UI/UX 细节（U3/无障碍）**：①installed Tab 分类改**动态过滤**（只显示实际存在插件的分类 + 全部——原硬编码 'tool' 分类恒 0 空按钮，与市场侧 'ui' 空分类同类问题）②PluginCard 开关补 aria-label（读屏语义）③市场卡片 note 截断加 title 全文 tooltip（adaptable/unsupported 适配说明不被截断丢失）④installed 展开的依赖/被依赖列表加滚动上限（120px），高扇出插件（tools 等 20+ 依赖）不再撑爆卡片
  - **卸载语义 P6（对标 dsh 的核心改造）**：审计发现生产代码**从不注册 loader**（仅测试）→ manager 的 enable/disable 只改状态、**从不真正加载/卸载 Cordis ctx 里的插件**——codem.base.yml 装配 203/202 全量插件，用户"禁用"tool-fs-search/mcp/schedule 等**实际无效**（工具/服务仍在 ctx 运行 = 假禁用），"启用"ui-game 也永不真加载。修复：①**装配 fiber 登记**：yaml-loader（loadFromYaml/loadFromEntries）每 `ctx.plugin` 即把 name→fiber 登记（`registerActiveFiber/getActiveFiber/unregisterActiveFiber`）②**自动 loader 填充**：PluginManagerService.initialize 从 builtinPlugins 为全量内置插件登记 loader（enable = `ctx.plugin` 真加载）③**doDisable 真卸载**：同时 dispose 动态 fiber（this.fibers）与 YAML 装配 fiber（activeFibers）并注销——禁用 = 插件/服务/工具真正从 ctx 移除；重启后 initialize 对持久化禁用列表执行真卸载。测试 R-9（真实 ctx 装配 @codem/session → disable 后 `ctx.get('session')` 消失 + activeFibers 清空 → enable 后服务重新注册）
  - **入口死锁 P7**：插件管理按钮 `pluginMgrEnabled` 依赖 @codem/plugin-registry 与 @codem/ui-slots——两者原可禁用（registry 仅有 category: core 分组无 core:true 保护）→ 禁用后插件管理入口消失且无恢复路径。修复：两插件在 runtimePluginList 与 builtin-registry 均标记 `core: true`（disable 被 lock 拒绝，PluginCard 开关禁用）；PM-5 断言保护（防未来移除）

### 功能修复与体验（v1.9.6 后工作区）

- **执行轨迹完整修复与持久化**：数据源修复（sessionId 显式传入 + fallback 适配真实消息结构——assistant.toolCalls 驼峰 {tool,args,result,status} → tool_call/tool_result/error，兼容 tool_calls/role=tool）+ llm_call 行内 usage（⇣/⇡ tokens）+ **事件日志批量持久化**（TrajectoryService 2s 周期 flush 到 session_events type 'trajectory_step'，dispose/退出前 flush——重启后历史轨迹全量回放）+ 小窗自适应（执行轨迹/浮层宽 `min(380px, calc(100vw - 24px))`）
- **首页无会话直接可用**：无会话时输入框不再禁用——输入回车自动创建全局对话（projectId=""），占位提示"输入消息，回车将自动新建全局对话"
- **托盘退出数据安全**：quit-requested（托盘"退出"）→ 前端 flush 数据库后退出（兜底 Rust 2.5s）
- 全量测试终态：152 文件 / 4141 用例通过 + tsc 零错误

## [1.9.6] - 2026-09-02

### 打包版运行问题修复（CSP / 插件加载 / 解析降噪 / subagent 激活）

> 用户报告知识笔记本导入 docx 报错与启动控制台告警，逐项定位修复：

- **CSP 允许 blob:（修复导入 docx 嵌入后端不可用）** — 打包版在 tauri.localhost 下，transformers.js/onnxruntime 用 `URL.createObjectURL` 动态 import WASM 被 CSP `script-src` 拦截（`no available backend found`，索引全部失败）；`script-src` / `worker-src` 增加 `blob:`
- **CSP 允许 tauri IPC 协议** — `connect-src` 增加 `ipc: http://ipc.localhost`（Tauri v2 自定义 IPC 不再回退 postMessage，消除 `Refused to connect … violates CSP` 告警）
- **移除 YAML 中已删除插件引用** — `config/codem.base.yml` 删除 `@codem/terminal-bash`（v1.9.3 已移除该 provider 但 YAML 残留 → 每次启动 `YamlLoader failed 1`）
- **extractJSON 失败降噪** — 6 步容错修复尝试间静默，全部失败后仅单次 warn（附输入预览）；此前每次失败逐条打印 SyntaxError（导入多个来源时控制台刷屏）
- **知识摘要解析失败降级为文本摘要** — `generateSourceSummary` 在模型未返回严格 JSON 时把输出清理后取前 200 字作摘要存入（此前仅 warn 留空，笔记本卡片无内容）
- **SubagentRuntime 同步初始化（修复 subagent 服务激活竞态）** — runtime 创建由动态 import 异步改为静态 import 同步（import 链无值依赖循环），`subagentProvider` 不再拿到空 runtime → 9 个 `inject: ['subagent']` 的插件不再 PENDING（消除 `assertActivated FAILED`）

## [1.9.5] - 2026-09-02

### 对话步骤语义化 + update_plan 动态插入（对标 dsh 客户端 todo 语义列表）

> 用户反馈：对话中【第X/X步】是"回答问题/执行命令"式无意义通用步骤，而 dsh 客户端是"分析卡死原因→诊断链路→修复→测试"式的语义步骤，且执行中发现新问题时可在当前位置插入步骤（编号顺延）。根因：LLM 语义计划只在启发式估步 ≥3 时调用（"修复卡死的问题"被判纯问答 → 显示"回答问题"），且无任何插入通道（计划耗尽后只按执行工具类别追加泛化标题）。

- **任务语义计划（引擎层）**：执行型任务（新增中英文任务意图检测 `looksLikeExecutableTask`：修复/排查/分析/为什么/卡死…）**总是**让 LLM 生成面向具体任务的语义步骤（分析原因→定位诊断→修复→验证），30s 超时回退启发式（任务句兜底首步含任务摘要，不再"回答问题"）；`planSteps` 提示词强化（含"分析卡死原因/诊断链路/修复卡死/测试"好例与"回答问题/执行命令"坏例 + 空白标题清洗回退）
- **update_plan 工具（动态插入）**：新增 LLM 工具支持 `insert_before / insert_after / append` 三种插入——执行到第 N 步发现必须先处理的新问题时把步骤插到当前进行中步骤之前，**编号顺延、total 自动更新**、UI"第X/X步"即时刷新；只允许插入"当前或更后"位置（不可改写已完成步骤）、空标题/重复/12 步上限校验；成功回执携带插入后完整计划（模型感知新编号）；属计划元操作不推进 X/X
- **计划上下文注入**：每次 LLM 请求的 systemPrompt 附带"当前执行计划（第 X/Y 步）+ [完成/进行中/待办] 状态列表 + update_plan 使用指引"，模型每轮可见剩余步骤（对标 dsh todo 每轮可见）
- **语义计划不再混入泛化步骤**：`fromLlm` 标志——LLM 语义计划耗尽后引擎**不再**自动追加"执行命令"式泛化标题步骤（启发式计划保留旧兜底）
- 新增测试：`step-plan-semantic.test.ts`（STEP-P1~P8，11 用例：意图边界/插入语义/已完成区拒绝/工具契约/计划渲染）+ `step-plan-dynamic-insert-loop.test.ts`（STEP-L1~L9，6 用例：驱动真实 loop 复现"第 3 步前插入修复调用链路 → 3/5 刷新 → 继续推进进入顺延步骤"）

### token 消耗审计与修复（对标 dsh-desktop / deepseek-harness）

> 用户报告：相同模型下用 Codem 修 bug 比 dsh 第三方客户端消耗大数倍。逐项对照 harness 源码参数审计并修复 6 项结构性差异：

- **read 单次结果上限 100k→50k 字符**（对齐 dsh `READ_MAX_BYTES≈50KB`；此前中文内容 ≈300KB 字节 = dsh 6 倍）
- **上下文折叠（新增 `context-fold.ts`）**：`selectMessagesByPriority` 截断丢弃早期消息时插入零成本紧凑摘要（`[上下文精简] 较早 N 条消息（read×2…）请重新调用工具`，不调 LLM），打断"失忆→重复读取/执行"的 token 恶性循环；防每轮重复累积
- **陈旧大工具结果 head+tail 裁剪**：对齐 dsh `compaction-tool-result-pruner`（8192/4096/1024）——保留最近 2 条工具结果完整，更早 >8KB 结果裁为 head+marker+tail（含错误尾部），历史 read/bash 大结果单条从 12-25k token 降到 ~1.3k
- **7 个低频大 schema 工具延迟加载**：`generate_ppt / browser_automate / figma_fetch / github_tool / workflow / image_gen / tts` 设 `shouldDefer`（每轮全 schema 10.6k→~7.5k token，模型可经 tool_search 按需加载）
- **systemPrompt 工具信息三重复裁剪**：`tools:catalog`（Available Tools 全列表）文本置空、工具 guidance 仅注入核心工具、collectToolGuidance fallback 去重列表（核心工具 description 已在请求 tools 数组；defer 工具已有 Deferred Tools hints）
- **上下文选择预算对齐真实窗口**：select 预算从固定 100000 伪 token（=400k 字符，中文可超真实窗口致服务端截断/400）改为 `tracker.getContextWindow()×90%` + 共享 CJK 感知 `estimateTokens` 估算；`token-tracker` 新增 `getContextWindow()`
- 新增测试：`context-fold.test.ts`（TOK-F1~F7：折叠统计/文案/裁剪 head+tail/保留最近 N 条）；更新 v1.5.2 H4（read 上限 50k）

### 全面功能审计修复（断点/错误/不稳定）

- **PTY 关闭/退出杀进程树**：`close_pty` 与 `quit_app` 从单 kill 改 `kill_process_tree`（`taskkill /T /F`）——cmd.exe 的孙进程（长命令 node/npm/test）此前残留为孤儿进程占用资源/端口
- **TerminalPanel spawn 失败残留**：失败路径补 `term.dispose()` + 移除临时 DOM（此前空终端 div 永久残留且无法关闭）
- **4 处裸 fetch 补超时**：`web-provider` 兜底抓取 20s、`knowledge/extractor` 浏览器抓取 15s、`remote-client-provider` 能力发现 10s、`search-deepseek` 搜索/抓取 15s/20s（此前网络黑洞永久挂起，相关工具卡到 15 分钟看门狗）
- **托盘"退出"菜单先 flush 再退出**：不再直接 `app.exit`（绕过前端 DB flush 丢最近防抖窗口写入）——emit `quit-requested` → 前端 `await flushDatabase()` → `quit_app`，Rust 2.5s 兜底强退（先检查主窗口仍在，防二次 exit）

## [1.9.4] - 2026-09-02

### dsh-desktop 全面对标 — 稳健性审计修复（15 轮迭代，bug 级清零收敛）

对标 [dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)（crash-evidence / renderer-health / log-files / shutdown 等机制）审计 Codem 共有的功能，逐项修复并回归，共 42+ 项。

#### 崩溃检测与恢复链路（对标 dsh crash-evidence）

- **active-run.json 崩溃标记** — Rust 启动时写入（pid + 启动时间），正常退出（quit_app / 托盘退出 / ExitRequested）三重清理；上次进程异常终止（崩溃/强杀/断电）下次启动检测到标记 → `previous-run-unclean` 事件 → 界面提示"上次未正常退出，可前往设置 → 会话恢复查看快照"
- **panic 信息落盘** — panic hook 追加写 `codem-crash.log`（打包版 stderr 不可见，panic 信息此前完全丢失）
- **渲染崩溃恢复边界（对标 dsh renderer-health / startup-recovery）** — 新增 `AppErrorBoundary` 顶层错误边界：React 渲染崩溃不再白屏，显示恢复卡片（重试渲染 / 重新加载应用 / 重置界面设置并重新加载，后者仅清 `codem-*` 本地界面设置、不动 SQLite 会话数据）；崩溃证据（错误消息 + 组件栈，经 redactSecrets 脱敏）写入 localStorage，下次启动提示已自动恢复。测试 REC-R1~R6

#### 运行时文件日志（对标 dsh log-files.ts，新增）

- 新增 `src-tauri/src/runtime_log.rs` — 按日文件 `codem-runtime-YYYY-MM-DD.log`（位于 `%APPDATA%\com.codem.app\`）+ 段轮转（单文件 4MB，最多 3 段）+ 目录上限（24MB，删最旧）+ 启动清理超 14 天 + 单行截断 8KB（UTF-8 边界安全）+ **统一脱敏**（sk-/pk- 前缀需 token≥10 防误伤、ghp_/AKIA/Bearer/Authorization/password= 等贪婪型、重叠区间合并）
- 落盘事件：启动（含 pid / 上次是否异常退出）/ 崩溃检测 / 命令执行开始/结束/超时杀树 / PTY 创建与清理 / 退出 / 托盘构建失败，全部 best-effort 不影响主流程
- 13 个 Rust 单测（脱敏形态/误伤防护/轮转/保留判定/目录上限）

#### 持久化失败可见性（DB 写盘失败不再静默）

- `saveDatabase` 写盘失败（磁盘满/文件被占用）此前仅在 console 记录、调用方与退出前 `flushDatabase` 完全无感知 → 静默丢数据；现在首次失败 dispatch `codem:db-save-failed` 事件 → 界面 guidance 提示，连续失败限流不刷屏，3s 后自动重试一次（临时故障自愈），任何一次成功复位失败状态并 dispatch 恢复事件。测试 DBSAVE-F1~F4

#### 命令执行与 PowerShell 安全

- **execute_command 超时杀进程树** — spawn + 轮询 + timeout_ms（默认 600s，clamp 1s~1h）；超时 `taskkill /PID /T /F` 杀整树（Unix 杀负 PGID），修复此前 `cmd.output()` 同步阻塞、前端 Promise.race 超时后 PowerShell/子进程仍在后台运行堆积僵尸进程
- **PowerShell 安全转义** — 新增 `ps-command.ts`（psQuote / maybePsQuote / buildGitCommand）：git `HEAD^{tree}` 等含 `{}` 的命令此前触发 PowerShell `ScriptBlock should only be specified as a value of the Command parameter` 崩溃；统一单引号包裹修复
- 命令开始/结束（exit code + 耗时）/ 超时杀树记录进运行时日志（脱敏）

#### 网络与 API 稳健性

- **统一超时工具 `fetchWithTimeout`**（默认 20s，AbortController）覆盖：github-tool / figma-fetch / run-code（SDK fetch 15s + bash/exec timeout）/ web-search / job-manager / workflow-engine / pipeline / sync-engine（4 处）/ skill-market（install 120s、git 60s、gh 120s）
- **错误体统一脱敏** — 新增 `redact.ts`（redactSecrets / redactSecretsDeep）：LLM provider / vision-proxy / ollama / multimodal / bash 工具等 API 错误信息中的 sk-、Bearer、password 等密钥不再泄漏到界面/日志
- 远程 Provider WebSocket 连接 onopen/onerror 时 clearTimeout（修复定时器泄漏）
- multimodal / vision-proxy / skill-market-client 等模块错误路径脱敏 + 超时

#### 前端渲染与交互稳健性

- 全局 error / unhandledrejection 从 `alert()` 弹窗改为记录（此前任何未捕获错误弹原生对话框阻塞打断，多次弹窗体验极差）；过滤 ResizeObserver 良性警告
- **6 处 JSX 运算符优先级 Bug 修复**（FileChangesList / NeedsYouPanel / Workbench 等：`&&` 与三元混用导致条件渲染异常）
- TerminalPanel：className 括号错误修复 + `closeSession` 函数式 setActiveId + 监听 `pty-exit`（会话进程退出通知，`_closing` 标记防竞争，修复僵尸会话挂到 TTL 才回收）
- Mermaid `securityLevel` loose → strict（3 处：MessageBubble / NoteEditor / MermaidCanvasView，收敛 XSS 面）
- 新增 `useWindowState` — 窗口大小/位置/maximize 状态持久化（防抖 500ms，恢复时校验宽 ≥400/高 ≥300），重启保持布局
- tools.ts bash 工具外部取消（ctx.abort 监听 + finally 清理 timeoutAbortFn/externalAbortFn）；agentic-loop buildMessages 逐条 dump 日志改 `DEBUG_BUILD_MESSAGES=1` 门控
- telemetry flush：`isCompactionInProgress` 保护 + 失败保留 events 下次重试
- 配置文件 mkdir 改 Rust `make_directory` 命令（修复 fs 权限差异）；git-commit-service / file-change-tracker 走 buildGitCommand + timeout_ms

#### 会话 / 数据

- messagesToLLMMessages 保留 `msg.reasoning` + provider 双分支输出 `reasoning_content`（thinking mode 回传）
- buildMessages 按 toolCallId 精确配对（声明/存活结果 M<N 时只保留被满足的 M 个）
- 全局崩溃提示 guidance 事件监听（App.tsx）

#### 测试

- 新增 repro 测试：repro-ps-command（PowerShell 转义）/ repro-exec-timeout（超时杀树）/ repro-bash-abort（外部取消）/ repro-jsx-classname / repro-redact（脱敏）/ app-error-boundary（REC-R1~R6）/ db-save-failure-alert（DBSAVE-F1~F4）；适配 git-env-config / s0-seam-integration / regression-coding-p0 / regression-knowledge-full（KM-074 动态导入 flaky 30s 超时）
- 全量 141 文件 / 4079 用例通过 + `tsc --noEmit` 零错误 + cargo check 零警告 + cargo test 13/13

## [1.9.3] - 2026-09-02

### 终端功能全面对标 dsh-desktop（审计修复）

- **UI 入口打通** — TitleBar 状态栏终端按钮此前未接线（terminalOpen/onToggleTerminal 未传 props，按钮不渲染；bottomTab 永不为 "terminal"，终端抽屉不可达）。现在按钮点击切换终端抽屉，三个皮肤布局全部可达
- **LLM 终端工具 → 真实 PTY 链路打通** — 重写 terminal-tools.ts：terminal_open→spawn_pty、terminal_send→write_pty、terminal_close→close_pty，会话 ID 即真实 pty-uuid，与 UI 面板共享 Rust portable-pty 后端；删除原内存模拟 + codem-terminal-input 幽灵事件
- **补齐 dsh 六工具语义** — 新增 terminal_read（scrollback 分页，10000 行上限）、terminal_list；terminal_send 支持 submit 参数 + 静默窗口就绪等待（inferred_idle/timeout/session_exit）+ run_in_background（返回 pty-job-*，job_output/job_kill/job_list 集成管理）；terminal_signal 支持 SIGINT/SIGTSTP/Ctrl+D
- **清理死代码** — 删除 terminal-bash-provider.ts（spawn /bin/bash，Windows 不可用，无任何消费方）及 builtin-registry/provider/plugin-registry 3 处注册
- **UI 卡片渲染补强** — ToolCallCard 的 6 个 terminal_* 工具映射到 bash 变体（此前专用卡片不渲染），tryTerminalModel 读 metadata 渲染 viewport/sessionStatus，TerminalBlock 补复制按钮 + 16 行折叠（对标 dsh headTailCap）
- **键位逻辑提取为纯函数** — 新增 terminal-key-handler.ts（保持 P0 约定：Ctrl+C 仅复制、Ctrl+Shift+C 才发 \x03）
- **假测试重写为行为测试** — regression-coding-p0.test.ts P0-1 从源码字符串匹配改为 16 个行为测试（PTY 调用链 + 键位语义 + run_in_background + job 集成），全量 135 文件 / 4051 用例通过


### 顶部状态栏 UI 调整（对标 dsh-desktop 收敛侧栏入口）

- **终端按钮移至主题切换右侧** — TitleBar 顶部状态栏的终端（Terminal）按钮从导航区最左移到暗色/亮色切换按钮右边，贴近 dsh-desktop 的状态栏入口布局
- **隐藏左右侧栏切换按钮** — 隐藏 TitleBar 最左侧（LOGO 旁）的侧边栏收起/展开按钮 + 导航区搜索旁的右侧栏收起/展开按钮；侧边栏仍可通过主对话区 ChatPanel 顶栏按钮切换
- **ChatPanel 顶栏侧边栏按钮图标联动修复** — 收起/展开图标此前硬编码 PanelLeftClose，收起侧边栏后图标不切换；现在新增 sidebarOpen prop 条件渲染（展开=PanelLeftClose / 收起=PanelLeftOpen），三处皮肤布局统一传入状态

### 安全模式（完全访问）修复 — dbReady 时序导致重启后失效

- **修复：选择"完全访问"后重启仍弹审批** — `App.tsx` 的 `securityMode` state 初始化时 DB 尚未就绪（`getDatabase()` 抛错 → 回退默认 `ask`），而 `dbReady` 同步 effect 只同步了 model/mode/provider，漏掉 securityMode。现在 DB 就绪后重新同步，且依赖数组加入 `currentProject?.path`（切换项目按新项目重新解析，项目级 > 全局）
- **委派/后台任务遵循用户安全模式** — `executor.ts` 不再硬编码 `securityMode: "auto"`，改为 `getEffectiveSecurityMode(cwd)`：用户选"完全访问"后跨会话委派任务同样放行；非 full 模式后台自动拒绝需权限操作
- **修复 write 拒绝误判** — `agentic-loop.ts` 的 write 拒绝检测限定为 `name === "write"`：此前任何工具输出含 "User rejected the overwrite" 字面量（如读取本项目源码 tools.ts）都会被误判为用户拒绝写入，导致循环提前停止并输出"写入已被拒绝"（ask/auto/full 全部失效、无审批弹窗）
- 新增回归测试：`repro-security-mode-full`（REPRO-001/002/003）+ `repro-security-mode-engine-link`（ENGINE-001~004）+ `repro-security-mode-project-link` + `repro-security-mode-ui-sync` + `repro-security-mode-db-reset` + `repro-security-mode-ctx`（CTX2-001/002 完整 Cordis ctx 委托路径）+ `repro-write-rejected-false-positive`

### 工具调用配对修复 — API 400 "insufficient tool messages"

- **修复 DeepSeek/OpenAI 严格配对要求** — `buildMessages` 在上下文选择截断部分工具结果时，此前只检查"是否有任何工具结果跟随"，部分截断的配对会溜过 → API 400。现在按 `tool_call_id` 精确配对：声明 N 个 tool_calls 但只有 M<N 个结果存活时，只保留被满足的 M 个（孤儿 tool 结果丢弃）
- 新增回归测试：`repro-tool-pairing-400`

### 输入框历史浏览修复 — wrap 折行误触发

- **修复：多行输入时光标在第二行按 ↑ 直接填充历史** — `.message-input` 是 `pre-wrap` 软换行，旧 guard 只检查 `indexOf("\n")`，wrap 折行（无换行符但视觉两行）时 guard 失效。改为镜像测量（复制 textarea 字体/宽度/行高）判断视觉行：↑ 仅在视觉第一行触发历史，↓ 仅在视觉最后一行触发
- 新增回归测试：`repro-input-history-wrap-guard`（5 用例）

### 记忆检索正则元字符转义

- **修复记忆内容含 `+`/`*`/`(` 等元字符时 `SyntaxError: Invalid regular expression`** — `memory.ts` 内容匹配对用户查询词做 `RegExp` 转义
- 新增回归测试：`repro-memory-regex`

### 引导栏按钮 UI 对标 wecode 优化

- **引导栏从单气泡 + 单按钮改为卡片式三操作**（对标 `.wecode-ref` ChatInputCard）：每条引导显示"待接收/已接收"状态胶囊 + **立刻引导**（主色描边，中断当前回复立即注入）+ **编辑**（取消引导并回填输入框复用 suggestionPrompt 机制）+ **取消**（X 圆形幽灵按钮）
- **样式改为圆角浮卡**：12px 圆角 + 边框 + 阴影 + 居中 max-width 820px + 2 行截断，清理旧 `.guidance-bubble*` 样式

### 思考过程紫色样式恢复（对标 v0.96.0）

- **思考/推理过程改回紫色样式** — `ReasoningRow` 折叠行文字 + Brain 图标改回紫色 `#9333ea`，展开体从灰底灰边框改为淡紫底 + 紫色左边框（与 v0.96.0 视觉一致）

### 其他

- 新增回归测试共 10 个 repro 文件（34 用例），全量测试通过，`tsc --noEmit` 零错误

## [1.9.2] - 2026-09-01

### LLM 请求级超时加固（对标 DSH request_timeout_seconds）

- **complete()（非流式）总超时 120s** — planSteps / compaction 等非流式调用不再可能永久挂起
- **stream()（流式）连接阶段超时 60s** — fetch 到 response headers 阶段有独立超时预算；首字节之后的流式阶段沿用现有 120s idle timeout（SSE 心跳重置）
- **修复关键漏洞：fetch 本身无超时** — 此前服务端接受连接但不返回数据时 fetch 永久挂起，主循环卡死、App 的 finally 不执行、activeSessions 残留 → 会话永久无响应
- **`withRequestTimeout` 合并外部 abort signal 与超时预算** — 任一触发即 abort（对标 DSH request deadline）；`cleanup()` 解除连接阶段超时定时器，避免误杀已开始的正常流
- **`rethrowIfRequestTimeout` 将超时 AbortError 转为带诊断的请求超时错误**（对标 DSH TimeoutError）
- 新增 `llm-timeout-hardening.test.ts`（200 行）

### 安全模式按钮选中态颜色反馈

- **当前生效模式一眼可见** — 编辑框底部安全模式按钮按 ask/auto/full 显示蓝/紫/绿（修复选中后无变色）：`PermissionPresetSelector` 按钮按当前模式附加 `security-ask`/`security-auto`/`security-full` class，`codem-ui.css` 添加对应颜色 + 暗色主题适配

### 引导消息注入体验改造（对标 wecode markGuidanceApplied / Codex steering 消失）

- **注入成功后消息从状态栏移除** — store 新增 `removeGuidanceMessage`：引导消息注入 loop 后立即从 guidance 状态栏移除（不再残留 consumed 标记），状态栏自动消失；`App.tsx` 两处调用点（立即中断注入 + guidance_received 事件）统一改为移除
- **移除 ChatPanel 独立引导输入框** — 删除 GuidanceBlock 渲染 + guidance-input-container，改为 InputArea 复用主输入框：流式期间 `onSendGuidance` 将输入框消息作为引导消息注入（placeholder 提示"回车发送将作为引导消息注入当前任务"），发送按钮变为"停止 + 引导发送"双按钮
- 新增测试 GUIDE-061/062（removeGuidanceMessage 行为）

### LLM 失败可见性（对标 DSH 结构化失败上报，绝不静默结束 turn）

- **移除任务完整性猜测机制** — 删除 `checkTaskCompleteness`/`taskReminderSent`/`toolsCalledInRun`：不再通过正则猜测用户意图注入"任务未完成提醒"伪造 user 消息 + 双写。回归背景：用户引用 "write / App.tsx" 报错文本被误判为"要求保存文件"，注入伪造消息导致莫名其妙的问题。循环防护只由 repeat-tool-reminder 承担（检测真实重复调用链）
- **EMPTY_RESPONSE 空响应检测** — 模型以 stop 结束但无文本/无推理/无工具调用是退化完成，抛错走既有重试路径，重试耗尽后结构化失败上报，绝不猜测用户意图或伪造 user 消息
- **失败必须对用户可见** — ① agentic-loop 失败路径 yield `text_delta`（用户看到 LLM 调用失败 + 自动重试提示，而非"发消息不回复"）② App.tsx `end` 事件对 `too_many_errors`/`error` 显示明确错误消息（不只 overflow）③ App.tsx `tool_error` 对空 toolCall（executeIteration 级错误）上报错误消息
- 新增测试 LOOP-051/052/053（防回归：任务完整性语义 + 失败可见性）

### 其他

- `App.tsx` 移除 BOM 头（文件开头多余 BOM 清理）
- 新增回归测试：`llm-timeout-hardening.test.ts`（200 行）+ `core-guidance-pause-resume` GUIDE-061/062 + `trigger-call-execute-loop` LOOP-051~053
- 全量 119 文件 / 3985 用例通过，`tsc --noEmit` 零错误，`cargo check` 通过

## [1.9.1] - 2026-09-01

### 对话任务步数计算对标改造（Codex 风格宏观计划步）

- **总量固定为计划步数，不再随执行膨胀** — 此前 `第X/X步` 的 total 会随 iteration 无限增长（读文件 → 搜索 → 改文件每一步都算新步骤），现在 total 固定为任务计划步数（分析/读取/修改/验证/总结），中间侦查类小步骤不再改变总量
- **侦查类工具不推进步骤** — `read`/`glob`/`grep`/`tool_search`/`web_search`/`list_directory`/`lsp` 等只读侦查工具归类为 `RECON_TOOL_NAMES`，执行任务时这些小步骤不会让用户看到步数跳动；只有 `write`/`edit`/`bash`/`run_test` 等执行类工具**首次出现**才推进到下一宏步骤
- **步骤标题语义化（中文）** — `getToolTitle` 全量中文化（读取文件/写入文件/修改文件/执行命令/运行测试/委派子智能体等），每个步骤名让用户一眼知道正在解决什么问题
- **追加步骤仅在新执行阶段出现时发生** — 计划步骤全部完成后，若模型仍在执行新操作（发现严重问题/新增任务方向），追加一步并给出语义化标题，而非每 iteration +1

### 文件树显示隐藏文件夹

- **Rust `list_directory` 新增 `show_hidden` 参数** — 默认 false 保持原有隐藏过滤（LLM 工具调用不受影响），传 true 时显示 `.wecode-ref`、`.git`、`.deepseek-harness-ref` 等点开头目录
- **FileExplorer 组件传递 `showHidden: true`** — 右侧边栏文件树、左侧 PanelSidebar 文件树、主面板文件 Tab 统一生效（全部复用 FileExplorer 组件）
- `node_modules` 仍始终过滤（性能考虑）

### 其他修复

- **输入框高度收缩修复** — textarea 是 absolute+inset:0，删除多行内容后高度卡在旧值不恢复；测量前先重置 wrapper/textarea 到 minH，让 scrollHeight 反映真实内容高度
- **安全模式切换按钮修复** — 编辑框底部「请求批准/替我审批/完全访问」点击不生效：compact 模式下拉菜单经 createPortal 渲染到 document.body，外部点击关闭逻辑误判 portal 内容为外部点击，先卸载菜单吞掉后续 click；新增 dropdownRef 排除判定

### 数据库持久化加固（损坏恢复 + 原子写入 + 退出前 flush）

- **损坏数据库自动备份重建** — `initDatabase` 加载后执行 `PRAGMA quick_check` 完整性校验，非 ok 时先把损坏文件备份为 `.corrupt-<timestamp>` 再删除重建，避免带着 "database disk image is malformed" 运行
- **Rust `write_file` 原子写入** — 先写同目录临时文件 + `sync_all`，再 `rename` 覆盖目标；崩溃/并发中途写入不再留下截断的数据库文件
- **DB 保存链串行化** — `enqueueSave` 把写入串在 Promise 链后，并发保存不再重叠写同一文件
- **退出前 flush 等待** — `flushDatabase` 改为返回 Promise；`close-requested` 且行为为「退出」时先 `await flushDatabase()` 再 `quit_app`，避免 fire-and-forget 写一半被杀掉

### PowerShell 命令修复

- **grepSearch 去掉外层 `powershell -Command "..."` 包裹** — 外层双引号让 PowerShell 把整段命令当字符串字面量解析，管道中 `$_` 无管道上下文展开为 $null，grep 静默返回空输出；改传裸命令（Rust 端统一执行）
- **autoLint 路径改单引号包裹** — PowerShell 双引号内 `$` 会做变量展开，含 `#` 的路径（如 `C:\my$dir\file.ts`）被展开为空；单引号内 `$`/反引号不做展开，内部单引号转义为双单引号
- **Rust `execute_command` 防御性剥外层双引号** — 若剩余命令体被一对双引号包裹则剥离，杜绝上述字符串字面量陷阱

### 新增回归测试

- `step-progress-macro.test.ts` — 宏步骤推进 6 例（侦查/执行分类、RECON 集合、中文标题、总量固定语义）
- `file-tree-hidden.test.ts` — 文件树显示隐藏文件夹 4 例（前端传参、Rust 签名、入口复用）
- 全量 118 文件 / 3970 用例通过，`tsc --noEmit` 零错误，`cargo check` 通过

## [1.9.0] - 2026-08-31

### 上下文压缩过早触发治根修复（模型感知窗口 + 压力驱动）

- **TokenTracker.estimateMessagesTokens 永不回落修复** — baseline 仅为下限，不再忽略消息实际增长，压缩后 prompt 从 ~103k 稳定回落到 39k/47k
- **模型真实 contextWindow 同步** — AgenticLoop.run() 从 provider.listModels() 解析模型真实窗口并同步到 tracker，1M 窗口模型（DeepSeek/Gemini/MiMo）此前按 128k 估算导致压力放大 ~8 倍、3 轮即触发压缩
- **micro-compact 压力驱动** — 由纯条数触发改为「条数 > 12 且压力 >= 0.5」，避免长会话过早压缩
- **inferContextWindow 启发式窗口推断** — provider.ts 新增按模型 id 推断窗口（deepseek/gemini/mimo→1M、claude→200k、qwen→32k 等），Server /models 未返回 context_window 时不再一律回退 128k
- **getAgenticLoop 构造时同步 contextWindow** — loop 创建时从 provider 静态/动态模型列表解析窗口，避免构造期回退 128k 直到 run() 才修正

### 通用协议 API 配置（OpenAI 兼容）

- 设置页支持手动输入 Base URL + API key，自动拉取模型列表并持久化
- **刷新模型列表不再丢弃 contextWindow 字段** — SettingsPanel 动态模型 state 类型补全窗口字段，刷新时通过 inferContextWindow 写入，运行时窗口解析不再回退 128k
- 新增 `getFirstConfiguredModel()` 初始模型 fallback：自定义 provider 优先返回其第一个动态模型
- 新增 `resolveProviderForModel()`：支持自定义 provider 的模型 id 路由（不匹配内置前缀时扫描动态模型列表）

### 工具执行正确性修复

- **read 单响应去重键含 offset/limit** — 去重键由裸 path 改为 `path|offset|limit`，模型先读全文再读特定片段时不再被误判为重复调用跳过（此前 readCache 已区分范围但去重层未区分，语义不一致）
- **DecisionTray 审批内容空白修复** — App.tsx 读 `req.args` 改为 `req.input`（PermissionRequest 字段实为 input），bash 显示命令本身、其他工具显示完整参数 JSON，复用 getToolDescription 生成可读描述
- **长命令审批 UI** — 审批参数代码块 max-height + overflow-y 滚动，长命令不再把按钮挤出屏幕

### 其他修复

- Guidance 注入增强：sendGuidance 返回 GuidanceItem、新增 interruptForGuidance 立即中断当前流消费已排队 guidance
- 多行输入历史导航边界处理：上箭头仅首行拦截、下箭头仅末行拦截（doskey 终端行为移植）
- 新增回归测试：context-window-regression.test.ts（8 例）+ custom-provider-config.test.ts + s0-regression-full read 去重范围键用例

## [1.8.0] - 2026-08-31

### 知识图谱 React Flow 重构

- 引入 @xyflow/react (React Flow) 库，替代自研 Canvas 力导向图实现
- 自定义节点组件：按实体类型着色 + 图标 + 径向渐变 + 选中高亮
- 自定义贝塞尔曲线边 + 关系标签
- 内置 MiniMap / Controls / Background
- 保留所有编辑功能：节点编辑/删除、边删除、右键菜单、PNG/JSON 导出

### DSH 框架穿透性修复

- vision-proxy.ts 的 resolveVisionConfig/resolveSTTConfig 统一使用 engine.getConfiguredProvider()

### UI 设计规范化（对标 apple-design）

- 50+ 组件批量 fontSize 数字→CSS 变量替换
- 硬编码颜色→CSS 语义化变量

### 笔记本功能审计（对标 lumina-note）

- 功能完整无断点：Markdown编辑器/WikiLinks/闪卡/知识图谱/标签/版本历史/导出/学习路径

### 依赖更新

- 新增 @xyflow/react ^12.11.5

## [1.7.0] - 2026-08-31

### PPT 生成质量大幅提升 — oh-my-ppt 风格技能集成 + Cordis SkillRegistry 渐进式加载 + 生成链路断点修复

- 集成 oh-my-ppt 项目 74 种风格 SKILL.md + 9 种产品技能（布局/图表/动画等），通过 Vite `import.meta.glob` 构建时收集，运行时注册到 Cordis SkillRegistry
- 修复 PPT 生成两条通路（Studio 一键生成 + 对话中 generate_ppt 工具调用）均经过单次 LLM 调用、AI 无法使用 load_skill 的问题：调用 LLM 前主动从 SkillRegistry 加载当前选中风格的 SKILL.md 注入 systemPrompt，只加载当前 1 个风格 + 产品技能，避免 token 爆炸
- 新增 `ppt-skill-registry.ts` + `skills/` 资源目录，删除旧 `ppt-skill-loader.ts`

## [1.6.2] - 2026-08-29

### 大富翁嵌入式游戏全量交付（Phase 1-10） + 三轮审计 Bug 修复

#### 1. 大富翁桌面游戏 — 完整版（Phase 1-10）

在 Codem 中嵌入完整的大富翁4风格桌面游戏，作为用户等待 LLM 执行任务时的休闲娱乐。游戏作为完全独立的大插件运行，零侵入主项目代码。

**Phase 1-6（基础设施 + 核心玩法）：**
- **棋盘渲染**：Phaser 3 2D 俯视棋盘，36 节点环形布局 + 中心区域信息展示
- **动态骰子**：3D 骰子动画，交通方式决定骰子数（步行1/机车2/汽车3）
- **地产系统**：等级 0-3，地价/建造费/各等级过路费，连锁店标记
- **角色系统**：8 个可选角色，各自不同初始资金/移动/投资能力
- **命运/新闻事件**：40+ 种事件卡，包括移动/金钱/状态/股票效果
- **股票系统**：6 支股票，价格波动 + 买卖 + 分红
- **卡片系统**：10 种卡片，停留/免停留/送人/抢夺/升级/降级/查地图
- **道具系统**：6 种道具，遥控骰子/飞弹/路障/机车/汽车/航母
- **AI 策略**：地产购买评估 + 升级评估 + 股票投资 + 卡牌使用 + 道具使用
- **存档/读档**：完整序列化/反序列化，支持中途保存和恢复

**Phase 7-9（视觉交互 + 核心机制对齐）：**
- **地块图标映射**：每个地块类型对应独特图标
- **角色精灵动画**：移动 Tween 动画 + 跳跃效果
- **消息条系统**：游戏事件实时消息提示
- **物价指数**：全局经济波动机制
- **住院/监狱/酒店/沉睡状态**：完整状态机
- **连锁奖励/税收**：连锁地产过路费翻倍

**Phase 10（G20-G36 开局设置 + 机制补全 + 体验补全）：**

| 编号 | 功能 | 说明 |
|------|------|------|
| G20 | 游戏天数选择 | 开始界面可选 15/30/50/100 天 |
| G21 | 玩家数量选择 | 热座模式 1-4 人 + AI 1-3 个 |
| G22 | 初始资金选择 | 可选 10000/15000/20000/30000 |
| G23 | 胜利条件实现 | 可选 2x/3x/5x/10x 倍率或仅比天数 |
| G24 | 机场/传送点 | 付费传送至任意位置 |
| G25 | 商业地块 | 保险购买 + 建筑公司购买/交费 |
| G26 | 地产主动出售 | 卖地面板列出所有地产，半价出售 |
| G27 | 股票分红 | 每回合自动发放 10% 分红 |
| G28 | 银行拒绝机制 | 5% 概率审查高负债玩家 3 天禁贷 |
| G29 | 多人热座 | 多人类玩家轮流操作 |
| G30 | 帮助/规则 | 完整规则面板含地块/操作/经济说明 |
| G31 | 财富面板 | 资产面板显示地产/股票/卡牌/道具 |
| G32 | 资产清单 | 含在财富面板中 |
| G33 | 日志增强 | 日志颜色 + 物价指数 + 胜利条件显示 |
| G34 | 投降功能 | 确认后没收地产退出 |
| G35 | 音量控制 | 滑块控制 0-100% |
| G36 | 速度调节 | 1x/2x/4x 速度选择 |

#### 2. 三轮审计 Bug 修复

1. **破产清算逻辑** — 修复 `BankruptcySystem.ts` 中现金重复计算 Bug，变卖所得（地产/股票）先累加到 `raised`，然后统一加到玩家 `cash` 中，最后再扣除债务
2. **玩家状态检查** — `GameEngine.ts` 的 `rollDice()` 添加住院/监狱/酒店/沉睡/停留状态检查，无法行动时直接跳过回合
3. **全部破产保护** — 防止 `endTurn()` 中 `do...while` 循环在所有玩家破产时死循环
4. **命运事件前后移动** — 修复 `FortuneSystem.ts` 中 fortune_move 事件（ID 20/21）未实际移动玩家的问题，改为直接移动并发出 `player_teleported` 事件
5. **初始资金应用** — 修复 `setInitCash()` 不追溯应用已有玩家的问题，在 `initGame` 后遍历所有玩家根据角色属性重新计算现金
6. **AI 循环优化** — 游戏结束时停止 AI 轮询，添加 `phase === "ended"` 检查
7. **掷骰跳过检查** — 添加 `phase` 非 `moving` 时跳过自动移动间隔

#### 3. 构建验证
- TypeScript 编译 0 错误
- Vite 构建成功

## [1.6.1] - 2026-08-28

### 桌面宠物独立窗口改造 + 文件输出标识增强 + 设置版本号动态化

#### 1. 桌面宠物单一独立窗口改造（Cordis 插件化架构）
- **移除主窗口内 PetOverlay**：`@codem/ui-pet` 插件改为空壳（`PetOverlayDisabled`），不再在主窗口内渲染宠物覆盖层
- **独立窗口宠物**：宠物窗口作为独立的 Tauri 窗口运行（`PetWindowApp.tsx`），与主窗口共享 WebView2 进程组（实际内存增量仅 ~108MB，全部来自 1 个 renderer 进程）
- **Cordis Provider 封装**：新增 `ui-pet-provider.ts`，通过 `ctx.provide('pet', service)` 注册宠物服务，统一 `App.tsx` 中 `getPet()` 获取入口（优先 Cordis ctx，回退 `usePetStore`）
- **右键菜单合并**：Rust `show_pet_menu` 接收宠物列表参数，构建切换宠物样式子菜单（`SubmenuBuilder`），支持 `pet-switch:{slug}` 事件
- **窗口状态同步**：`emitToPetWindow` 传递 `installedPets` 和 `activeSlug`，`setActivePet(null)` 正确发送完整状态

#### 2. 文件输出标识增强（DSH 风格文件提及）
- **FileMentions 解析器**：新增 `src/utils/file-mentions.ts`，从 `message.toolCalls` 提取 LLM 产出文件路径，构建 `FileMentions` resolver
- **RichContent 集成**：`RichContent` 组件新增 `fileMentions` 属性，inline code 渲染器优先使用 `fileMentions.resolve()` 解析文件路径为可点击按钮，兜底正则扩展名匹配
- **MessageBubble 集成**：从 `message.toolCalls` 构建 `FileMentions` resolver 并传递给 `RichContent`
- **工具提示词强化**：`write`/`edit`/`multi_edit` 工具 `guidance` 字段要求 LLM 在提及文件时使用 Markdown 链接格式
- **i18n-templates 强化**：系统提示词模板强化文件路径引用要求使用 Markdown 链接格式

#### 3. 设置版本号动态化
- `SettingsPanel.tsx` 关于页面版本号从 `package.json` 动态导入（`import { version } from "../../package.json"`），不再需要手动同步

#### 4. 其他
- `pet-store.ts` 新增 `pet-switch-request` 事件监听
- `src/core/pet/index.ts` 注释更新
- 测试文件 `icon-standardization.test.ts` 中 `PetOverlay.tsx` 引用替换为 `PetWindowApp.tsx`
- `src/core/ui-plugins/index.ts` 移除 `@codem/ui-pet` 插件加载，添加 `uiPetProvider`
- `ui-pet-provider.ts` 导入路径修复（`../pet/pet-store`）

## [1.6.0] - 2026-08-27

### SubagentRuntime 架构重构（对标 DSH） + 技能市场 Trees API 改造 + GitHub Token 修复

#### 1. SubagentRuntime 全面重构（对标 DSH `SubagentRuntime` + `spawn` 模式）
- **旧架构删除**：移除 `SubagentManager`（+642 行删除）和 `LLMSubagentSpawner`（-338 行），删除 `spawn_subagent` / `wait_for_subagent` 旧工具
- **新架构**：新增 `SubagentRuntime`（对标 DSH）— 持续后台子智能体运行时
  - `InProcessSpawnProvider` 替代旧 `LLMSubagentSpawner`，支持后台运行 + 自动通知 + 消息延续
  - 4 个新 DSH 风格工具：`subagent`（启动后台子智能体）、`send_message`（向运行中子智能体发消息）、`interrupt_agent`（请求中断）、`list_agents`（列出后台子智能体）
  - `ToolRegistry.createScope()` 隔离工具作用域（对标 Cordis `ctx.isolate('tools')`），子智能体可安全注册专属工具（如 `report`）而不泄漏到主智能体
  - `setGlobalSubagentRuntime` / `getSubagentRuntime` 全局访问（对标 DSH `ctx.provide('subagents', runtime)`）
- **系统提示词改造**：sub-agent collaboration 部分对标 DSH 重写 — 后台默认运行 + 自动通知模式，无需显式 `wait_for`
- **文件**：`src/core/subagent/`（删 spawner.ts -338 行、重构 subagent.ts -309 行、新增 index.ts 全局 runtime）、`src/core/llm/index.ts`、`src/core/llm/tools.ts`、`src/core/prompt/prompt.ts`

#### 2. 技能市场 GitHub Trees API 改造（移植 vercel-labs/skills 官方 CLI 逻辑）
- **核心改造**：将 Contents API 逐层遍历（O(N×M) 次调用）替换为 Trees API 一次性获取全量文件树（1 次调用），在内存中搜索 SKILL.md
- **30+ 前缀支持**：移植官方 `PRIORITY_PREFIXES`，覆盖 Claude / Cline / Goose / Codex / Continue 等 30+ 种 Agent 目录约定（之前仅 4 个硬编码前缀）
- **三大函数改造**：
  - `fetchGitHubRepoSkills`：Trees API 全量搜索 + 优先级排序 + Legacy fallback
  - `fetchGitHubSearchSkills`：每个仓库用 Trees API 搜索任意位置的 SKILL.md（之前仅尝试根目录）
  - `installSkillFromGitHubDir`：Trees API 获取全量树 → 内存筛选目录文件 → 精确下载（不再逐层遍历 + 前缀探测）
- **修复问题**：`dreambigou/eli5`（SKILL.md 在 `skills/eli5/` 子目录）、`cloudflare/cloudflare-docs`（15296 个文件的大仓库）等之前安装失败的技能现在可正常安装
- **文件**：`src/core/skill/skill-market-client.ts`（+551 行重构）

#### 3. GitHub Token 配置链路修复
- **根因**：github-tool / cicd / clone 命令均未从 `codem-git-config` 读取 Token，导致认证缺失
- **修复**：统一 Token 读取链路，所有 GitHub 操作共享 `githubApiHeaders()`
- **文件**：`src/App.tsx`、`src/core/skill/skill-market-client.ts`

#### 4. 其他改动
- i18n-templates 新增子智能体协作提示词模板（+138 行）
- workflow-engine 增强子智能体运行时集成
- 测试文件适配新架构：core-subagent-lifecycle / cordis-functional-loop / full-regression-smoke / regression-coding-p1 等全量适配
- `tsc --noEmit` 零错误

## [1.5.5] - 2026-08-26

### Compaction 并发写入治根修复 + Bash 缓存失效修复

#### 1. compactMessages 数据库并发写入治根修复（对标 DSH `compactSurfaceRegion`）
- **根因**：`compactMessages` 中 DB 操作被 `await`（LLM summarization）拆成两段，`await` 间隙 UI auto-save（`setTimeout` → `saveMessages` → `createMessage` → `db.run`）插入执行，导致 sql.js 单实例被并发操作污染，产生 `bad parameter or other API misuse` 错误
- **DSH 参考**：`compactSurfaceRegion` 将所有异步工作（LLM summarization）前置完成，然后在 `commitCompactionBody` 中同步一次性提交所有 DB 变更（`compaction/summary` + `user/message(replace)` + `compaction/end`），中间无 `await`
- **治根修复**：
  - 将所有 DB 写入集中到 `await` 之后的同步段——先 `await import` 预加载模块，然后同步执行 `deleteMessagesByIds` → `createMessage` → `EventLog.append`，中间无 `await` 间隙
  - 新增 `setCompactionInProgress` / `isCompactionInProgress` 互斥标志（defense-in-depth），`saveMessages` 在 compaction 期间跳过
  - 移除 `compaction_end` 事件中的 `saveMessages` 调用——compaction 后 DB 是唯一真相源，不应把过时的 UI store 状态写回 DB
- **文件**：`src/core/llm/agentic-loop.ts`、`src/store.ts`、`src/core/storage/database.ts`、`src/App.tsx`

#### 2. Bash 工具执行后 readCache 失效修复
- **根因**：`readCache` 在 `read` 工具执行后缓存内容，`write`/`edit` 工具写入时清除对应路径缓存，但 `bash` 工具执行脚本修改文件后不清除 `readCache`——导致 LLM 脚本写入文件后 `read` 仍命中旧缓存（45 行旧内容覆盖 227 行新内容）
- **修复**：bash/execute_command/shell/run_command 工具执行成功后，清除整个 `readCache`（无法知道 bash 命令修改了哪些文件，保守清除是唯一安全做法）
- **文件**：`src/core/llm/agentic-loop.ts`

### v1.5.3-v1.5.4 累积修复

#### 3. 引导消息立即注入（对标 DSH `inject()`）
- `GuidanceQueue` 新增 `unshift` 操作实现高优先级注入
- 通过 `AbortController` 中断当前 LLM 流，配合 `guidanceInterrupt` 标志位引导循环进入下一轮迭代
- 引导消息在下一轮迭代边界注入，不持久化到消息数据库

#### 4. Markdown 文件路径超链接
- `react-markdown` 的 `code` 渲染器中通过正则白名单识别文件路径（`.md|.ts|.json` 等已知扩展名）并转换为可点击的 `<a>` 链接
- 修复正则误匹配问题（改用已知文件扩展名白名单，避免匹配 `obj.prop`）

#### 5. 任务完成标签稳定显示 + 滚动锚定
- 修复 `isTurnEnd` 逻辑，增加滚动重试次数（10次/150ms）确保锚定到任务完成标签
- 禁止自动弹窗干扰

#### 6. 技能市场优化
- 修复搜索时数据源清零及无结果提示问题（保留旧数据的增量更新）
- 新增 `installSkillFromGitHubDir`，利用 GitHub Contents API 递归下载特定目录，规避 1.4GB 仓库整包下载
- 动态获取仓库 `default_branch`，解决 `production` vs `main` 的 404 问题
- SkillHub 市场源加载优化（串行请求改并行 + 12s 超时保护）
- 技能市场搜索超时保护（20s per-source）

#### 7. 其他修复
- micro-compact CACHE HIT wrapper skip
- block-code 单词渲染修复
- file-link cwd 路径解析修复
- 发送按钮图标居中
- sidebar tooltip + context menu
- step plan 动态命名 + click-lock tooltip
- notebook-workspace CSS 语法错误修复
- 知识笔记本面板被标题栏遮挡修复
- dialog 权限修复文件选择器
- 滚动加载历史消息 scroll 监听绑定错误容器修复

## [1.5.2] - 2026-08-24

### 大文件性能修复 + Agent Loop 无上限改造 + 模型系统动态化 + Skills 增量搜索

#### 1. 大文件流式分页读取（对标 DSH TextRetainer）
- Rust 新增 `read_file_lines` 命令：使用 `BufReader` 逐行扫描，内存占用 O(limit) 而非 O(file_size)
- 前端 `read` 工具优先调用分页 API：有 offset/limit 参数时走 `readFileLines`，避免大字符串跨进程传输
- `read_attachment` 工具改用 `readFileLines`：磁盘读取不再全量加载 content
- `listAllAttachments` 查询排除 `content` 大字段，仅在读取时按 ID 获取（懒加载）
- 全量读取 50MB 上限保护：超过则返回错误引导使用分页路径
- **彻底解决**数百 MB 文件分析时前后台卡死问题

#### 2. Agentic Loop 无上限改造（对标 DSH）
- 移除硬编码 `maxIterations` 上限（原 20 轮），改为 `while(true)` 无限循环
- 新增三重安全阀：
  - **连续无进展检测**（MAX_CONSECUTIVE_NO_PROGRESS = 10）：连续 10 次迭代有工具调用但无文本输出且无新工具结果时停止
  - **Token 消耗安全阀**（MAX_TOTAL_TOKENS_PER_RUN = 2,000,000）：总 Token 消耗超过 2M 时停止
  - **子智能体有限迭代**：子智能体仍保留有限 maxIterations 防止递归失控
- 根据触发原因（迭代上限/Token 限制/无进展）输出不同停止提示

#### 3. 记忆提取 API 400 修复
- **根因**：`spawnForked` 深拷贝消息时丢失 `tool_calls`（assistant 消息）和 `toolCallId`（tool 消息）字段
- **修复**：深拷贝逻辑保留 `tool_calls`（JSON.parse/stringify）、`toolCallId`、`name` 字段
- 截断消息列表后清理孤儿 `tool` 消息：检查 `toolCallId` 是否在已知 `tool_calls` ID 集合中

#### 4. 模型系统动态化
- `getConfiguredApiModels` 改为优先读取 `codem-dynamic-models` 存储（设置页面 API 刷新时写入）
- 回退到静态 `API_MODELS` 列表（兼容旧配置）
- `ModelProfilePanel` 移除写死的 `AVAILABLE_PROVIDERS`，改为动态获取
- 更新内置方案：
  - "经济模式"重命名为"常规模式"，主对话用 DeepSeek Pro，子任务用 Flash
  - 新增"经济模式"（全部使用 Flash 模型）
  - "默认模式"和"常规模式"添加视觉理解 slot（DeepSeek-V4-Flash-Vision-Exp）
  - 删除旧的"DeepSeek +视觉代理"和"DeepSeek +视觉代理(MIMO)"模式

#### 5. Skills 市场增量搜索
- 搜索优先查本地缓存（`codem-market-skills-cache`，TTL 30 分钟）
- 本地无结果时自动触发增量联网搜索（600ms 防抖）
- 新增 `searchMarketSkillsOnline` 函数：SkillHub 使用服务端搜索 API（`GET /api/skills?q=`），其他源全量拉取后本地过滤
- 搜索结果合并到本地缓存（去重），下次搜索同一关键词直接命中本地
- `tags` 字段全面规范化防御（`Array.isArray()` 检查）
- 渐进式更新回调中添加 `Array.isArray(sourceSkills)` 检查

#### 6. 终端切换崩溃修复
- **根因**：`TerminalPanel.tsx` 中 `listen` 函数从 `__TAURI__.core` 获取（错误）
- **修复**：改为从 `__TAURI__.event` 获取

#### 7. 权限弹窗位置修复
- `DecisionTray` 从普通块级元素改为 `position: fixed` 定位（bottom: 80px, 居中）
- 不再挤压主对话布局，新增 `slideUp` 动画
- `z-index: 9000` 确保覆盖在对话区域上方

#### 8. 技能市场搜索崩溃修复
- **根因**：`s.tags?.some()` 调用失败，因为 `s.tags` 可能不是数组
- **修复**：`SkillManager.tsx` 过滤逻辑中添加 `Array.isArray(s.tags)` 检查
- `skill-market-client.ts` 中所有 `tags` 字段规范化为 `Array.isArray() ? tags : []`

#### 测试
- 修复 `attachment-system.test.ts`：mock 添加 `readFileLines` 导出
- 修复 `vision-proxy-media.test.ts`：更新内置 profile 模型名称断言
- 新增 `v1.5.2-full-regression.test.ts`：100 个测试用例，覆盖 19 个测试维度
- 全量 113 套件 3947 测试全部通过

## [1.5.1] - 2026-08-23

### DSH 架构对标深度整改 + 严重 Bug 修复 + YAML 声明式插件加载

#### 1. YAML 声明式插件加载器（对标 DSH cordis.patch.yml）
- 新增 `yaml-loader.ts`：解析 YAML 声明（id, name, inject, disabled, when, config, core），按条件过滤平台、通过 id 查找 Plugin 对象、拓扑排序后加载到 Cordis Context
- 新增 `config/codem.base.yml`：所有运行模式共享的核心插件清单（80+ 插件声明，对标 DSH base bundle）
- 新增 `config/codem.desktop.yml`：桌面应用（Tauri）覆盖层（UI 插件 + 桌面专用配置）
- `App.tsx` 启动流程重构：对标 DSH `boot()` → `loadFromEntries(ctx, mergedEntries)` → `assertActivated(ctx, 'codem')` 流程
- `provider/index.ts` 改造：从 `export` 改为 `import + re-export`，确保所有 Provider 在 YAML 加载前完成静态导入

#### 2. 严重 Bug — LLM 回答重复问题（根因修复）
- **根因**：`saveMessages` 函数全量遍历所有消息并无去重地追加到事件日志，导致事件日志中存在大量重复的 `user_message` 和 `assistant_text` 事件。`buildMessages` 优先使用 `deriveMessagesFromEvents`（事件投影），导致重复消息被传给 LLM
- **修复**：
  - 移除 `saveMessages` 中对事件日志的全量重复追加逻辑，现在只负责 DB CRUD
  - `buildMessages` 移除事件投影路径，强制只从 DB 读取消息（DB 为单一读取源）
  - `applyUserMessage` 和 `applyToolResult` 添加去重检查，防止重复事件在投影时产生重复消息
  - 流式助手消息保存逻辑优化：仅在 `text_delta` 或 `tool_start` 时才调用 `saveMessages`

#### 3. 严重 Bug — llmEngine 未注册为 Cordis 服务
- **根因**：`getCtxService('llmEngine')` 永远返回 null，因为 `llmEngine` 从未通过 `ctx.provide()` 注册
- **修复**：在 `getLLMEngine(ctx)` 后调用 `ctx.provide('llmEngine', engine)` 注册为 Cordis 服务，在 YAML 加载之前完成注册

#### 4. 严重 Bug — mimoAuth 服务未注册 + PluginLoader.load() 未调用
- **根因**：`mimoAuth` 从未通过 `ctx.provide()` 注册；`PluginLoader.scan()` 后未调用 `loader.load()`
- **修复**：新增 `mimo-auth-provider.ts` 并通过 YAML 声明注册；所有插件改由 YAML 加载器加载，PluginLoader 只做元数据发现

#### 5. SlotBridge / SlotRenderer 对标 DSH 重构
- `SlotBridge` 对标 DSH `scoped-slots.tsx` 的 `SlotOutlet` + `renderOutletContent` 模式重写
- `SlotRenderer` 对标 DSH：`useSyncExternalStore` 仅用于版本通知，`entries` 在渲染体中读取，`WeakMap` 缓存 subscribe/getVersion 闭包
- 新增 `SlotErrorBoundary` 错误边界：插件组件渲染崩溃时自动回退到 fallback
- fiber `await()` 添加超时保护（5s/10s），避免单个 fiber 永不 resolve 导致启动卡死
- `useCtxReady` hook 优化：Cordis Context 就绪后立即触发重渲染

#### 6. Provider 架构全面整改
- 30+ 个 Provider 文件统一改造：从 `export const xxxProvider` 改为 `import` 后在 `provider/index.ts` 中集中 re-export
- `squadProvider` 拆分为 `squadProvider` + `squadManagerProvider`（消除别名混乱）
- `llm/index.ts` 中 `_getOrThrow` 改为 `_getOrFallback`：ctx.get() 返回 undefined 时回退到模块级单例（容错）
- 所有 Provider 的 `inject` 声明对齐 DSH 模式

#### 7. LLMEngine Provider 增强
- `provider.ts` 新增 `toAPIMessage` 的完整 ContentBlock 处理（tool_use/tool_result）
- `agentic-loop.ts` 精简：移除事件投影路径，消息构建只依赖 DB
- `ollama-provider.ts` 新增本地 LLM 支持
- `replay-adapter.ts` 增强：回放测试支持

#### 8. 其他改进
- `vite.config.ts` 优化构建配置
- `node-crypto-stub.ts` 增强浏览器环境兼容性
- `buffer-polyfill.ts` 新增 Buffer polyfill
- `vite-env.d.ts` 新增类型声明
- 新增 `cordis-architecture-guard.test.ts` / `cordis-extended-methods.test.ts` / `cordis-functional-loop.test.ts` 测试文件

## [1.5.0] - 2026-08-21

### 架构升级 — Cordis "一切插件化" 工具发现机制

对标 DSH (DeepSeek Harness) 的 `ctx.systemPrompt.section()` + `ctx.tools.schemas()` 模式，彻底解决 LLM 工具发现断档问题。工具注册时自带使用引导（guidance），自动注册到 systemPrompt 服务，系统提示词动态收集这些引导来生成工具列表 — 不再硬编码。

#### 1. ToolDef 增加 guidance 字段
- 在 `ToolDef` 接口中新增 `guidance?: string` 字段
- 每个工具自带使用引导，告诉 LLM **何时**和**如何**使用该工具
- 遵循 DSH `defineTool` 的设计理念：工具自描述，而非系统提示词硬编码

#### 2. toolsProvider 改造 — 自动注册工具引导到 systemPrompt
- 对标 DSH `ToolsService` 构造函数中的 `ctx.systemPrompt.tools(provider)` 调用
- **工具注册时**：自动将 `guidance` 注册为 `systemPrompt` 的 prompt section（name: `tool:<id>`, order: 110）
- **工具卸载时**：自动移除对应 prompt section，遵循 Cordis fiber 生命周期
- **动态工具目录**：注册 `tools:catalog` section（order: 100），实时收集所有注册工具的名称和描述
- **延迟注册**：`systemPrompt` 服务尚未可用时，通过 `ctx.effect` 延迟重试

#### 3. buildSystemPrompt 改造 — 工具列表动态生成
- 删除 `prompt.ts` 中硬编码的 "Available Tools" 段（仅列 8 个工具 + 多模态工具说明）
- 新增 `toolGuidance` 配置字段，由 `LLMEngine.collectToolGuidance()` 动态注入
- 回退路径：当 `toolGuidance` 为空时使用最小化 fallback
- 文件附件规则保留为独立段（非工具特定引导）

#### 4. LLMEngine 新增工具引导收集方法
- `collectToolGuidance()`（异步）：优先从 `systemPrompt.assemble()` 收集所有 `tool:*` 和 `tools:*` 段
- `collectToolGuidanceSync()`（同步）：从 `ToolRegistry.getAll()` 直接收集 `guidance` 字段
- 两条路径都有完整的工具列表 + 使用引导输出

#### 5. 全部 31 个工具补充 guidance 文案
- **核心工具**（11 个）：bash, read, write, edit, multi_edit, glob, grep, tts, image_gen, spawn_subagent, wait_for_subagent
- **能力工具**（8 个）：load_skill, web_search, read_attachment, search_notebook, ask_clarification, fact_check, show_todo, exit_plan_mode
- **高级工具**（6 个）：lsp, run_code, tool_search, browser_automate, figma_fetch, github_tool
- **笔记工具**（4 个）：create_note, edit_note, link_notes, delete_note
- **会话工具**（4 个）：session_search, session_event_search, session_trace, session_event_read
- **目标工具**（3 个）：create_goal, get_goal, update_goal
- **终端工具**（4 个）：terminal_open, terminal_send, terminal_signal, terminal_close
- **任务工具**（2 个）：job_list, job_output
- **协同工具**（4 个）：delegate_to_session, wait_for_delegation, query_session_result, list_sessions
- **小队工具**（3 个）：squad_list, squad_dispatch, squad_status
- **Issue 工具**（4 个）：issue_create, issue_update, issue_comment, issue_list
- **工作流工具**（1 个）：workflow
- **动态插件工具**（5 个）：cordis_define, cordis_inspect, cordis_run, cordis_stop, cordis_undefine

#### 6. skill-creator 技能增强
- 更新 `SKILL.md`，增加详细的技能安装指令
- 指导 LLM 使用 `write`/`bash` 工具从 URL 或 ZIP 安装技能到 `~/.codem/skills/`
- 在 `load_skill` 工具中增加文件系统回退机制，自动扫描 `~/.codem/skills/` 发现新创建的技能

## [1.4.2] - 2026-08-20

### Bug 修复 + 架构增强（14 项）

#### Bug 1 — 默认模型显示错误（彻底修复）
- **根因**：`App.tsx` 中 `_initialModel` 计算和 `configureEngine` 逻辑在 DB 未就绪时无法正确读取已保存的模型配置，导致启动时始终显示 CLI 默认模型 `mimo-v2.5-pro` 而非上次保存的 API 模型
- **修复**：`dbReady` 时同步读取 settings 更新 model/mode/provider；`engineRef` 的 `useEffect` 在 DB 就绪后重新调用 `configureEngine`；`model-badge` 显示友好名称；`getConfiguredApiModels` 中 `name` 属性从 `m.id` 改为 `m.name`

#### Bug 2 — 右侧边栏 CI/CD 面板被外窗口遮挡（彻底修复）
- **根因**：`PanelSidebar` 使用常规 DOM 渲染，被主对话框的滚动条和层级遮挡；且 `right` 和 `maxWidth` 计算不准确
- **修复**：`PanelSidebar` 使用 `createPortal` 渲染到 `document.body`，提升 `z-index`；调整 `right` 和 `maxWidth` 确保 CI/CD 面板完整可见

#### Bug 3 — 默认皮肤底部栏 UI 不一致 + 多余模型选择器
- **根因**：`InputArea` 底部栏有独立的 `ModelSelector`，与顶部模型选择器重复且样式不一致
- **修复**：删除 `InputArea` 底部栏的 `ModelSelector` 渲染逻辑；调整 `.input-control-bar` 样式

#### Bug 4 — 输入框聚焦时出现紫色边框
- **根因**：`.composer-inner:focus-within` 的 `border-color` 使用了紫色主题色
- **修复**：`.composer-inner:focus-within` 的 `border-color` 改为 `transparent`

#### Bug 5 — 技能市场加载慢（缓存机制）
- **根因**：每次进入技能市场都从三大源（ClawHub/Skills.sh/SkillHub）实时请求，无缓存
- **修复**：实现技能市场缓存机制 — 首次加载后缓存列表信息，再次进入时先加载缓存快速显示；刷新按钮改名为"检查更新"，点击时更新列表并覆盖缓存

#### Bug 6 — Git 分支按钮未居中 + 一直刷新
- **根因**：`.titlebar-center` 缺少居中样式；`GitBranchSelector` 的 `refreshInterval` 逻辑有 bug，且未检查是否为 git 仓库
- **修复**：为 `.titlebar-center` 添加居中样式；修复 `GitBranchSelector` 的 `refreshInterval` 逻辑，添加是否为 git 仓库的检查；`!workDir` 时返回占位按钮而非 `null`

#### Bug 7 — 右侧边栏边缘白色背景 + 拖拽影响左侧边栏
- **根因**：`.app-content` 有 `padding-right` 导致右侧露出白色背景；`.sidebar` 缺少 `position: relative` 导致拖拽事件冒泡影响左侧边栏宽度
- **修复**：移除 `.app-content` 的 `padding-right`；给 `.sidebar` 添加 `position: relative`

#### Bug 8 — 顶部栏左侧和左侧边栏之间空白区域
- **根因**：`.sidebar-header` 占据空间但在新版布局中已不需要
- **修复**：删除 `.sidebar-header`，将收起按钮移入 `.sidebar-nav`；恢复 `.titlebar-icon` 和 `.titlebar-title` 的显示

#### Bug 9 — CicdPanel 白色背景
- **根因**：`CicdPanel` 有硬编码的白色背景
- **修复**：`CicdPanel` 背景改为 `transparent`

#### Bug 10 — 顶部栏右侧按钮被居中（Bug 6 修复副作用）
- **根因**：修复 Git 分支按钮居中时，`.titlebar-left` 和 `.titlebar-nav-actions` 缺少 `flex-shrink: 0`，导致右侧按钮也被居中
- **修复**：为 `.titlebar-left` 和 `.titlebar-nav-actions` 添加 `flex-shrink: 0`；修改 `.titlebar` flex 布局使 Git 分支按钮居中、右侧按钮靠右

#### 增强 1 — Cordis 插件系统时序改进（三步方案）
- **第一步**：`getCordisContext()` 中将 `setTimeout(0)` 替换为显式等待所有 fiber 就绪 (`fibers.map(f => f.await())`)，并添加 fiber 状态日志
- **第二步**：`consumer/index.ts` 中为关键服务获取函数（`callLLM`、`callTool`）添加重试等待机制 (`getServiceAsync`)，`_ctxReady` 状态追踪
- **第三步**：`loadDefaultProviders()` 中添加 `internal/status` 事件监听器，记录 fiber 状态变更日志，便于诊断时序问题

#### 增强 2 — SlotBridge 降级机制健壮性增强
- 新增 `SlotErrorBoundary` 包裹插件组件，崩溃时自动回退到 fallback
- `renderFallback` 函数统一处理 fallback 逻辑，`fallback={null}` 时输出诊断日志而非静默失败
- 为关键 slot（`app.sidebar`、`app.conversation`、`app.titlebar`、`app.boot-splash`、Hub 皮肤 `app.skin-layout`）添加 `showDegraded` prop，异常时显示降级提示
- `SlotListBridge` 在 slots 服务不可用时输出警告日志

#### 增强 3 — 头像系统升级
- 从 Multiavatar 切换回 DiceBear API（URL 生成方式，无需 npm 依赖）
- 预设头像从 12 个扩展到 50 个，混合多种 DiceBear 风格（adventurer/avataaars/big-ears/big-smile/bottts/croodles/fun-emoji/lorelei/micah/miniavs/open-peeps/personas/pixel-art）

## [1.4.1] - 2026-08-19

### Bug 修复（9 项）

#### Bug 1 — 插件管理页面"Cordis Context 尚未初始化"彻底修复
- **根因**：`getCordisContext()` 中 `loadDefaultProviders(ctx)` 同步注册 Provider 插件后立即 `setActiveContext(ctx)`，但 fiber 的激活是异步的（需要微任务）。`ctx.get('pluginRegistry')` 在 strict 模式下要求 fiber 状态为 ACTIVE，否则返回 undefined，导致 PluginManager 重试 50 次后放弃
- **修复**：`App.tsx` 在 `loadDefaultProviders(ctx)` 后加 `await new Promise(resolve => setTimeout(resolve, 0))` 等待 fiber 激活；`PluginManager.tsx` 重试次数从 50 增到 100（10 秒），最终失败时用 `ctx.get('pluginRegistry', false)` non-strict 模式作为 fallback

#### Bug 2 — 技能市场 ClawHub/Skills.sh/SkillHub 加载很慢
- **根因**：三大市场源多页串行分页请求，每页一个 `httpGet`，代理慢时累积延迟很长（ClawHub 20 页、Skills.sh 10 页、SkillHub 20 页）
- **修复**：ClawHub MAX_PAGES 20→3（300 条）、Skills.sh 10→2（1000 条）、SkillHub 20→3（300 条）

#### Bug 3 — 启动后默认模型显示 mimo-v2.5-pro 而非上次保存的 deepseek
- **根因**：`configureEngine` 在 DB 未就绪时 `getSettingJSON("codem-settings", null)` 返回 null，直接 return 不重试，导致初始渲染的 `mimo-v2.5-pro` 默认值一直保持
- **修复**：`configureEngine` 中 `saved` 为 null 时也重试（200ms 间隔），确保 DB 就绪后重新加载已保存的模型配置

#### Bug 4 — CI/CD 面板太靠右被遮挡 + 界面元素太大有关闭按钮
- **根因**：`CicdPanel` 有自己的 header 和关闭按钮，与 `PanelSidebar` 的 tab 系统重复，且 header 元素字体过大
- **修复**：去掉 `CicdPanel` 的 header 和关闭按钮，`onClose` 改为可选 prop，`PanelSidebar` 中 `<CicdPanel onClose={onClose} />` 改为 `<CicdPanel />`

#### Bug 5 — 对话框编辑框圆角太大 + 梦幻皮肤毛玻璃未适配
- **根因**：`.input-card-container` 基础圆角 20px、梦幻皮肤 16px、Hub 皮肤 16px，圆角过大不美观
- **修复**：三套皮肤统一为 12px — 基础样式 20px→12px、梦幻皮肤 16px→12px、Hub 皮肤 16px→12px，`input-wrapper` 圆角同步调整

#### Bug 6 — 首页区域未自适应窗口分辨率（修复后遮挡更严重）
- **根因**：`.empty-state` 和 `.new-chat-page` 都使用 `justify-content: center` + `height: 100%`，内容超出容器时 `justify-content: center` 把内容顶部挤出可视区域且无法滚动
- **修复**：`justify-content: center`→`flex-start`，去掉 `height: 100%`，加 `padding: 40px 20px` 和 `width: 100%`

#### Bug 7 — 首页 Write Code 显示不全 + Tips 消失
- **根因**：`"Help me write a "` / `"帮我编写一个 "` 是半句提示，用户看到后觉得不完整；Tips 消失因 CSS 布局问题（Bug 6 修复已解决）
- **修复**：将 prompt 改为完整提示语 `"Help me write code: "` / `"帮我编写代码："`

#### Bug 8 — 顶部对话/终端/性能区域多了 CI/CD 按钮
- **根因**：底部面板 tab 栏中有 CI/CD 按钮，与右侧边栏的 CI/CD tab 重复
- **修复**：从底部面板 tab 栏移除 CI/CD 按钮和面板渲染（CI/CD 保留在右侧边栏 PanelSidebar 中）

#### Bug 9 — 对话区域不按窗口大小自适应
- **根因**：`.messages-container` 和 `.input-area > .input-card-container` 有 `max-width: clamp(100%, 75vw, 1100px)` 限制，大屏时上限仅 1100px 右侧大片空白；`.chat-body` 缺少 `flex-direction: column` 导致 `margin: 0 auto` 居中不稳定
- **修复**：`.chat-body` 添加 `flex-direction: column`；`.messages-container` 和 `.input-area > .input-card-container` 的 `max-width` 从 `clamp(100%, 75vw, 1100px)` 改为 `clamp(100%, 90vw, 1400px)`，拖拽缩放窗口时动态跟随

## [1.4.0] - 2026-08-19

### Bug 修复（11 项）

#### Bug 1 — 技能市场 skill.sh 插件内容显示乱码
- **根因**：Skills.sh HTML 爬取正则匹配范围过宽，会匹配到 HTML 标签属性（如 `<link rel=...>`）
- **修复**：收紧正则为只匹配字母数字和连字符组成的路径段 + 增加二次清洗过滤残留非法字符

#### Bug 2 — 技能市场外部技能加载很慢
- **根因**：Rust 层 `http_get` 超时时间过长（30s），导致并行请求时等待时间长
- **修复**：`http_get` 超时从 30s 降至 15s，`http_download` 从 120s 降至 60s

#### Bug 3 — 智能体定义管理窗口点击新建后视觉锚点未滚动
- **根因**：点击"新建"后编辑区域出现在窗口下方，但视图未自动滚动
- **修复**：增加 `editorRef`，在 `handleNew`/`handleEdit` 中调用 `scrollIntoView({ behavior: "smooth", block: "start" })` 滚动到编辑区域

#### Bug 4 — 启动后模型选择默认显示 mimo-v2.5-pro
- **根因**：`configureEngine` 在 engine 未就绪时直接 return，不更新已保存的模型配置
- **修复**：增加 200ms 自动重试逻辑，确保 engine 初始化完成后重新加载已保存的模型配置

#### Bug 5 — 右侧栏 CI/CD 管理面板太靠右被遮挡且弹窗改为面板切换
- **根因**：CI/CD 面板使用弹窗模式，与用户期望的面板切换不符
- **修复**：`BottomTab` 类型增加 `"cicd"`，所有 `onCicd` 从弹窗改为 `setBottomTab("cicd")` 面板切换。`CicdPanel` 从 `createPortal` 弹窗模式改为内嵌面板模式

#### Bug 6 — 梦幻皮肤下对话编辑框区域透明度未适配毛玻璃
- **根因**：`.input-card-container` 的 `backdrop-filter` 未加 `!important`，被其他样式覆盖
- **修复**：`backdrop-filter` 加上 `!important` 和 `saturate(1.4)`，增加深色模式背景色覆盖

#### Bug 7 — 梦幻皮肤下主对话框圆角与边栏直角风格不一致
- **根因**：`.sidebar` 和 `.right-sidebar` 没有圆角和 margin，与 `.panel-right` 风格不统一
- **修复**：`.sidebar` 增加 `border-radius: 16px` 和 `margin: 8px`，`.right-sidebar` 增加毛玻璃背景、圆角和 margin

#### Bug 8 — 首页区域未自适应窗口分辨率
- **根因**：`.new-chat-page` 和 `.empty-state` 使用 `height: 100%`，窗口小时内容溢出被截断
- **修复**：添加 `min-height: 100%` 和 `overflow-y: auto` 使其可滚动

#### Bug 9 — 首页点击 write code 等按钮编辑框内容未清理和显示不全
- **根因**：建议卡片通过 `quoteContext` 机制传递，会追加而非替换内容，且 `quoteContext` 显示截断
- **修复**：新增 `suggestionPrompt` + `onSuggestionConsumed` prop 机制，建议卡片点击时直接替换输入框内容

#### Bug 10 — 深色模式下安全策略按钮白色底色突兀
- **根因**：Compact 模式下按钮缺少样式，深色模式下继承了白色背景
- **修复**：给按钮加上 `security-mode-btn` class，深色模式下使用紫色边框透明背景样式

#### Bug 11 — 性能面板应改为面板切换而非弹窗
- **根因**：性能面板使用弹窗模式，与对话/终端面板切换逻辑不一致
- **修复**：`PerformanceDashboard` 从 `createPortal` 弹窗模式改为内嵌面板模式，移除 `showPerfDashboard` 弹窗渲染

### 编译 Warnings 清零（4 项）
- 多余分号 `;;` → `;`（lib.rs）
- 未使用变量 `window` → `_window`（lib.rs）
- 未读取字段 `id` → `_id`（lib.rs PtySession 结构体）
- `Cargo.toml` 添加 `[lints.rust]` 配置 `linker_messages = "allow"` 抑制 linker stdout 消息

## [1.3.0] - 2026-08-19

### Cordis 插件系统对标 DSH 全面整改 + Slot 消费闭环 + inject 依赖对齐
- 死 slot 从 29 个降至 0 个
- 7 个 UI provider 添加 `inject` 声明依赖，移除全部 null 检查
- 创建 ConversationRoot/Session/Composer 对标 DSH conversation slot 层级
- 新增 `slots.inject()` 消费声明方法
- 移除 11 个重复/无消费点 slot 注册
- MessageBubble/InputArea/ChatPanel/Sidebar 全面接入 SlotBridge/SlotListBridge 消费 conversation 子 slot
- 30+ 文件修改，10 个新组件

## [1.2.0] - 2026-08-18

### Cordis 架构全面对齐 DSH + 安全加固 + 全量测试重构
- 移除核心文件 `@ts-nocheck`，`declare module` 类型声明全面生效
- `ctx.get()` 返回强类型（对齐 DSH `ReflectService.get` keyof 推断模式）
- 安全加固（AST 代码验证 + Worker 隔离 + XOR 密钥混淆 + SandboxGuard 覆盖读操作）
- 生命周期管理（复合 Dispose + LRU 淘汰 + 异步 I/O）
- 全量测试重构 109 套件 3690 测试通过

## [1.1.1] - 2026-08-17

### UI 布局优化 + 插件条件渲染 + 宠物窗口 Bug 修复
- 插件管理移至左下角 + CI/CD 移至右侧边栏 + 性能移至主对话框顶端
- 插件启用/禁用与按钮/面板联动显示
- 宠物窗口关闭 Bug 修复
- 全工具 execute 回调 null 检查防御

## [1.1.0] - 2026-08-16

### DSH 对标全面整改 + 测试体系深化 + Bug 修复
- 孤岛模块接入 10 项 + 重复实现统一 4 项 + 缺失功能补齐 5 项
- 5 个 Bug 修复 + 4 个新测试文件 / 118 用例

## [1.0.0] - 2026-08-15

### UI/UX 标准化 + 插件系统架构 + 测试体系全面升级
- P4 Cordis DI + Slot Registry + Plugin Loader + 18 Capability Seams
- P5 全能力族拆分
- P6 UI 插件包化
- 全弹窗 UI/UX 标准化
- 67 文件修改（+1112/-641 行），全量 3552 用例通过
