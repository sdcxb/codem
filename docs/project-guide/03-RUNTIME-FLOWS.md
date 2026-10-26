# 03 · 运行时与调用链路：一轮对话到底怎么跑

> 基线：1.16.330 ｜ 2026-10-26
> 这是全系统最关键的文档。改对话、工具、流式、审批、压缩、记忆、子代理、项目、IPC 前，先在这里找到你改的那一段。

---

## 1. 启动链路（从进程到首屏）

```text
codem.exe
 └─ tauri::run()
     ├─ 注册 117 个命令（lib.rs generate_handler!）
     ├─ 创建主窗（1200×800，decorations:false，transparent）
     ├─ 托盘 / 宠物窗 / 运行时日志 / 崩溃标记 / Mica 材质
     └─ WebView2 加载 index.html → dist/assets/main-*.js
          └─ main.tsx
              ├─ process / Buffer polyfill
              ├─ 应用外观镜像（对比度/密度）
              ├─ 探测 native_material（≤400ms，失败保持不透明）
              └─ render(<AppErrorBoundary><App/></AppErrorBoundary>)
```

### 1.1 App.tsx 的 Cordis 启动（160–360 行）

1. `new Context()`；
2. `ctx.plugin(SlotsService)` —— UI 槽位服务；
3. `registerBuiltinPlugins()` —— **只填注册表**；
4. `getLLMEngine(ctx)` → `ctx.provide("llmEngine", engine)` —— 必须在 YAML 之前，否则大量 `inject: [llmEngine]` 的插件永远 PENDING；
5. `mergeYamlEntries(baseYml, desktopYml)` → `loadFromEntries(ctx, entries)` —— **真正装配**（171 条 base + desktop 覆盖层）；
6. 等 microtask / fiber `await`（每个 5 秒超时）；
7. `settleActivation()` + `assertActivated()` —— 把“已装配”结算成“真的 ACTIVE”；
8. `setActiveContext(ctx)` —— 消费者 `tryGetCtx()` 可立即取服务；
9. `loadUIPlugins(ctx)` —— UI 插件（槽位声明必须先于 UI 插件，否则 “slot is not declared”）。

**关键区别**：`ctx.plugin()` 成功只代表“装配调用没抛”；Cordis 激活是异步的。日志里 “assembled ≠ activated” 就是这件事。启动结论必须看 `settleActivation` 的 `activated / notActivated`，不能只看 `loaded.length`。

### 1.2 App.tsx 的存储/配置启动（1814–2138 行）

```text
registerRustStoragePort()                 ← 失败 = 没有存储（没有 WASM 回退）
→ migrateFromLegacyDb()                   ← 首次从旧 WASM 库迁移（幂等）
→ repairSearchIndexOnce()                 ← 中文 FTS bigram 一次性重建
→ importSettingsFromLegacyDb()            ← 旧设置导入
→ verifyUserContentOrRestore()            ← 内容全空时从旧库恢复（自检）
→ warmupEvents/warmupMessages(当前会话)     ← 缩小“镜像未就绪”窗口
→ applyStoredUiFont()
→ migrateFromLocalStorage()
→ ThemeManager.init()
→ 恢复 displayMode
→ prefetchDomainMirrors()                 ← 热表预取；未就绪的域注册一次性重读
→ useProjectStore.loadFromDB()
→ initDefaultSeams()                      ← 文件/Shell 能力 seam
→ configureEngine()                       ← DB 就绪后重新配置 provider/model
→ 恢复语言 / 身份 / 引导
→ startAutomationEngines()                ← 即使没有触发器也装配 handler
→ 宠物 / 技能加载
→ BootSplash → ready
```

**顺序约束**：任何“读会话/消息”的动作都必须在迁移、FTS 修复、域预取之后；否则首屏会显示“暂无项目/暂无对话”，而数据其实在库里。

---

## 2. 插件装配链（注册 ≠ 生效）

```text
config/codem.base.yml（171 条）
  + config/codem.desktop.yml（禁用 Web 模式插件）
        │ mergeYamlEntries()
        ▼
loadFromEntries(ctx, entries)
  ├─ 按 `when:` 过滤平台（win32 / 非 win32）
  ├─ 按 `inject:` 做拓扑排序
  ├─ 从 builtinPlugins 注册表按 id 找 Plugin 对象
  └─ ctx.plugin(plugin)  ← 真正 apply
        └─ plugin(ctx) = ctx.provide('<service>', {...})
              └─ 消费者：getToolContext()?.get('<service>') / getCtxService()
```

- **唯一真装配入口**：`loadFromEntries`；`registerBuiltinPlugins()` 只是把插件放进 map。
- **YAML 条目字段**：`id`、`name`、`inject`、`disabled`、`when`、`config`、`core`。
- **停用/启用**：`PluginManagerService` 通过 `getActiveFiber(name).dispose()` 真卸载，不是只改 UI 状态。
- **UI 插件**：不走 YAML，由 `loadUIPlugins()` 在槽位声明之后加载。
- **判据**：`SO-6`（清单与注册表双向对账）、`SO-8`（零例外全量对账）、`plugin-assembly-path.test.ts`。

**最容易踩的坑**：只改 `builtin-registry.ts`，单测可能全绿，真机功能永不生效（历史事故 226 波）。

---

## 3. 发送一条消息（主链路）

### 3.1 UI → store

```text
InputArea（输入区）
  ├─ 文本 / 附件 / @提及 / /命令 / 技能选择 / 审批模式 / 推理强度
  └─ onSend(message, attachments, selectedSkills)
        ▼
ChatPanel → App.tsx::handleSend（2931 行）
  ├─ 处理内置 /命令（/clear /compact /export /feedback /agents.md …）
  ├─ 处理附件：syncAttachmentsToWorkspace() → formatAttachmentsInline()
  ├─ deliverToOwningSession(user message)   ← 写进“归属会话”，与当前在看谁无关
  ├─ if (isSessionOnScreen) saveMessages(session.id)
  └─ runAgenticLoop(message, session, selectedSkills)
```

**关键不变量**：用户消息必须在 `runAgenticLoop` 之前落库，且落进**归属会话**。旧实现用 `addMessage` + 无 explicit 的 `saveMessages`，用户切走后会把话写进别人的会话、或本轮用户消息根本没落库。现在由 `deliverToOwningSession` / `loopMessages` 显式完成。

### 3.2 `runAgenticLoop`（App.tsx 3604–4115 行）

```text
startSessionExecution(session.id)          ← 同会话并发守卫（与后台执行器共用一张表）
→ thread 生命周期：updateThreadStatus(working)
→ 初始化 loopMessages（本 loop 自己的消息快照）
→ 工作树准备（如需要）
→ 取 provider/model/securityMode/reasoningEffort
→ 设置 15 分钟事件级 watchdog（30s 检查一次）
→ for await (event of engine.process(session.id, message, cwd, undefined, options))
      ├─ 只跳过“过程性”事件（中止后仍处理终局事件）
      ├─ text_delta / reasoning_delta → 100ms 缓冲后刷 UI
      ├─ tool_start / tool_complete / tool_error → 工具卡 + 落库
      ├─ permission_request → 弹审批，Promise 挂起
      ├─ compaction_start/end → 横幅 + 重载消息
      ├─ guidance_received → 引导气泡
      ├─ needs_you / clarification / plan → 交互面板
      └─ end → 收尾状态、统计、取消 watchdog
→ finally: endSessionExecution(session.id)
```

**为什么 loop 要自己维护 `loopMessages`**：`saveMessages` 默认写“当前加载的会话列表”；用户切走后那份列表属于别的会话。loop 用 explicit 形态写自己那份，才能做到“UI 只更新在屏会话，落库永远写归属会话”。

### 3.3 `LLMEngine.process`（index.ts 1423–1640 行）

```text
await whenToolsReady()                    ← 等动态工具注册完成（避免首轮工具表缺项）
loop = getAgenticLoop(agentId, sessionId) ← 按会话池化复用
loop.updateConfig({ permission/writeConfirm/securityMode/... })
memoryProjectId = resolveMemoryProjectId(...)  ← 项目身份，不是 cwd
loop.updateConfig({ memoryEnabled, onTurnComplete, onCompactionComplete })
[notebookId] → 检索知识上下文 + yield knowledge_sources
systemPrompt = buildSystemPromptAsync(...)
yield* runLoopAndRecordUsage({ loop, ... })     ← 手动驱动迭代器，拿 LoopResult 的累计 usage
```

**为什么手动驱动**：`for await` 丢掉生成器的 `return value`，而整轮累计 usage 在 `LoopResult.usage` 里；旧实现只记最后一次迭代的用量。

### 3.4 `AgenticLoop.run`（agentic-loop.ts 1838 行）

```text
run(sessionId, userMessage, cwd, systemPrompt):
  ├─ 新回合初始化：abortController / state / 守卫 / 测试状态 / 注入状态
  ├─ resolveModelContextWindow()           ← 模型真实窗口 → TokenTracker
  ├─ repairCrashedSession()                ← 修复上次未完成的工具调用
  ├─ sandbox init（默认关，设置开启才生效）
  ├─ 消化上一轮遗留 guidance（落库，不静默丢）
  ├─ resetSnapshot / readCache / writeCache
  ├─ initDefaultPipeline(host)              ← 5 层工具管线
  ├─ telemetry turn_start
  ├─ 计划：looksLikeExecutableTask → LLM 生成步骤（30s 超时，失败回退启发式）
  └─ while (true):
       ├─ 每轮重置：iteration、toolCalls、no-progress、lastFinishReason、收尾提醒
       ├─ 关键服务检查 / 上下文窗口解析 / 成本降级
       ├─ buildMessages(sessionId)          ← 历史 + 压缩标记 + 工具结果裁剪
       ├─ normalize tool defs（plan mode 隐藏写工具、无附件隐藏 read_attachment）
       ├─ 构造 extraSystemPrompt（稳定）+ trailingTurnContext（易变）
       ├─ executeIteration(...)             ← 调 provider、流式、执行工具
       ├─ 消费事件、推进 macroStep、检查守卫/收尾
       └─ 无工具调用 → 自然结束；否则进入下一轮
```

**主循环没有 token 上限、没有固定迭代上限**（对标 DSH），只有两个安全阀：

1. `maxIterations > 0`（只给子代理防递归失控）；
2. `MAX_CONSECUTIVE_NO_PROGRESS = 30` 次连续无进展。

**收尾守卫**：本轮把原本正常的测试改红（基线绿 → 现在红）时，界面不显示“任务完成”；提醒最多 2–3 次，仍不修则结果里带 `regressionRedTests`，由 `describeTurnOutcome` 拒绝“完成”。

---

## 4. 一次迭代内部（`executeIteration`，3919 行）

```text
visionProxy.processMessages()              ← 图片块替换成视觉模型描述（如启用）
effectiveSystemPrompt = systemPrompt + extraSystemPrompt（稳定尾部）
request = {
  model, messages: [system, ...apiMessages], tools, temperature,
  maxTokens, stream: true, abortSignal, reasoningEffort
}
跟踪 request header 指纹（前缀缓存 miss 诊断）
for await (event of provider.stream(request)):
  ├─ text_delta → 累积 + yield
  ├─ reasoning_delta → yield
  ├─ tool_use_start/delta/end → 解析参数
  │    └─ JSON 解析失败：标记 argsError，绝不拿空参数执行
  └─ finish / usage / error
```

### 4.1 流式事件（`LoopEvent`，565–601 行）

| 事件 | 含义 | UI 主要反应 |
|---|---|---|
| `start` | 新迭代 | 迭代 >1 时新建 assistant 消息 |
| `llm_status` | connecting / streaming / executing_tools | 状态条、宠物状态 |
| `step_progress` | 计划步骤进度 | “第 X/X 步”胶囊 + tooltip |
| `text_delta` | 正文增量 | 100ms 缓冲追加 |
| `reasoning_delta` | 推理增量 | 推理行 |
| `knowledge_sources` | 笔记本 RAG 来源 | 引用块 |
| `tool_start` | 工具开始 | 工具卡 status=running |
| `tool_complete` | 工具完成 | 工具卡 + 结果 |
| `tool_error` | 工具错误 | 错误卡/工具卡 error |
| `permission_request` | 需要审批 | PermissionDialog，Promise 挂起 |
| `compaction_start/end` | 压缩开始/结束 | 横幅 + 重载消息 |
| `retry` | LLM 重试 | 倒计时提示 |
| `usage` | 本次迭代用量 | 统计行 |
| `guidance_received` | 运行中追加已消费 | 引导气泡消失/落库 |
| `clarification` | 结构化提问 | ClarificationForm |
| `correction_complete` | 纠偏结果 | 对比面板 |
| `pipeline_step_complete` | 流水线步骤 | 任务卡 |
| `todo_list_created` | Todo 列表 | TodoListDisplay |
| `file_changes_tracked` | 回合文件变更 | 变更列表/工作台 |
| `needs_you` | 主动暂停提问 | NeedsYouPanel |
| `agent_message_received` | 智能体间消息 | 消息面板 |
| `end` | 终局（stop/overflow/aborted/error） | 完成/停止/错误 |

### 4.2 系统提示结构（`buildSystemPrompt`，prompt.ts 186 行）

稳定前缀（缓存边界之前）：

1. 身份 / 语言 / 人格；
2. 人设卡（可选）；
3. Agent 基础 prompt；
4. 格式规则、最终回答、脚本/文件编辑/脏工作树；
5. 工作更新、并行工具；
6. 子代理协作；
7. 跨会话委派/交接；
8. 上下文管理、纠偏、自主性；
9. 记忆指引；
10. 安全规则；
11. 协作模式（plan/default）；
12. 用户信息；
13. 分层指令（global → deploy → project → session）；
14. Git 偏好；
15. 技能 / 知识 / MCP / 多智能体 / 安全 / 语言规则 / 班长名册。

然后 `SYSTEM_PROMPT_CACHE_BOUNDARY` 哨兵；边界之后：

16. 易变记忆（项目级 / 对话级 / 自动提取）；
17. `# Current Date`（分钟精度、本地时区真实偏移）。

**为什么**：服务端前缀缓存（DeepSeek KV cache）按字节匹配；把每分钟变的 date 和易变记忆放最后，稳定前缀才能命中。判据 `MEM-PLACE-*`、`dsh-d5-prefix-cache-stability`。

**易变内容另有一条通道**：时间戳、活跃目标、计划上下文、surface 状态作为**独立的尾部 user 消息**注入，而不是拼进 system；否则同轮跨迭代的前缀会变。

---

## 5. 工具执行（5 层管线）

```text
ToolPipeline（tool-pipeline.ts）
  1. pre-execute（waterfall）
     ├─ HookPreExecute
     ├─ PermissionMiddleware（按安全模式/规则）
     ├─ SecurityScanMiddleware（bash 危险命令分析）
     └─ 可 abort 检查
  2. guard（单调，不可重排）
     ├─ SandboxGuard（工作区/允许目录）
     ├─ PlanModeGuard（plan 模式禁写）
     └─ 受保护路径（.git/.env/node_modules）
  3. execute（waterfall）
     ├─ tool.execute()
     ├─ timeout（按工具契约）
     ├─ retry（可重试错误）
     └─ 指标/事件
  4. post-execute（waterfall）
     └─ HookPostExecute（accept/reject/replace/append）
  5. finalize（freeze）
     ├─ 输出契约校验（outputSchema + renderOutput）
     ├─ 写事件日志
     └─ 返回权威结果
```

### 5.1 工具契约（`tool-contract.ts`）

| 字段 | 含义 | 默认 |
|---|---|---|
| `readOnly` | 只读 | 按工具名兜底 |
| `sideEffectScope` | 改了什么（none/session/workspace/system） | 只读 → none，否则 workspace |
| `accessScope` | 访问了什么（none/workspace/system） | workspace |
| `concurrencySafe` | 可并发 | 只读 ⇒ 可并发 |
| `destructive` | 破坏性 | false |
| `persistResult` | 大结果是否落盘 | true |
| `timeoutMs` | 超时 | 按工具 |

**并发**：`CONCURRENCY_SAFE_TOOL_IDS` = `read/grep/glob/lsp/web_search/web_fetch/zvec_grep_*`。其余工具串行；未知/抛错一律独占。

**重复调用守卫**：同一轮内精确指纹 + 只读枚举意图指纹；先提醒、再抑制、再停。它返回 `status: completed`（不是 error），否则会先把“连续错误”上限打满。

**状态去重**：
- `read` 命中同 path/offset/limit/line_numbers 的缓存 → 直接返回旧内容；
- `write` 相同内容重复写 → `[NO-OP]`；
- `wait_for_delegation` 已取过 → 缓存结果。

### 5.2 工具结果预算

- 单条 assistant 消息的所有工具结果合计 > 200,000 字符：按大小从大到小落盘，换成预览；
- 单条工具输出 > 8192 字符：折叠头尾（4096 + 1024）；
- 大结果落 `spill/<sid>/`，默认保留 14 天；
- 错误消息 > 10,000 字符：头尾各 5000，中间标注截断。

### 5.3 工具清单

**核心（`createDefaultToolRegistry`）**：`bash/read/write/edit/multi_edit/glob/grep/tts/image_gen/load_skill/web_search/web_fetch/read_attachment/search_notebook/note_* /generate_ppt/ask_clarification/fact_check/show_todo/browser_automate/figma_fetch/github_tool/lsp/tool_search/exit_plan_mode/run_code/session_search/session_event_search/session_trace/session_event_read/project_report/create_goal/get_goal/update_goal/workflow/job_*/terminal_* /cordis_* /update_plan`。

**动态注册**：`subagent/send_message/interrupt_agent/list_agents`、`delegate_to_session/handoff_to_new_session/wait_for_delegation/query_session_result/list_sessions/cancel_delegation/set_session_internal`、`squad_*`、`issue_*`、`agent-teams`、`computer-use`、MCP/CodeGraph/zvec 工具。

**延迟加载（deferred）**：`generate_ppt/browser_automate/figma_fetch/github_tool/workflow/image_gen/tts`——不注入全 schema，模型用 `tool_search` 按需加载。目的：省每轮约 10.6k token。

---

## 6. 审批与安全模式

### 6.1 三档

| 模式 | 写入覆盖 | 危险命令 | 普通工具 | 适用 |
|---|---|---|---|---|
| `ask`（默认） | Diff 确认 | 询问 | 询问/按规则 | 日常 |
| `auto` | 自动通过 | 询问 | 自动 | 信任工作区 |
| `full` | 自动 | 自动 | 自动 | 完全访问（慎用） |

优先级：**项目覆盖 > 全局 > 默认 ask**。项目键 `codem-security-mode-project:<path>`；全局 `codem-security-mode`。

### 6.2 审批通道

```text
ToolPipeline.PermissionMiddleware
  → PermissionManager.requestPermission()
  → AgenticLoop 注入 onPermissionRequest
  → App.tsx setPendingPermissions(session.id, {request, resolve})
  → PermissionDialog
  → resolve(result)
  → 管线继续/拒绝
```

写入覆盖另走 `onWriteConfirm` → `pendingWriteConfirms` → 内联 Diff 审查（`InlineDiffReview`）；同一会话可“自动批准”。

### 6.3 沙箱

- 设置 `codem-sandbox-enabled` 控制 `SandboxGuard`；**默认关闭**。
- 允许目录 `codem-sandbox-allowed-dirs`；交接正文里的工作区外路径会弹 `SandboxAllowPrompt`，只提示不自动放行。
- 写文件另有 Rust 侧 `resolve_sandbox_path` + `path_within_workspace`；**`execute_command` 目前没有工作区校验**（见 `07` 风险）。
- 受保护路径：`.git/.env/node_modules` 等。

---

## 7. 上下文管理与压缩

### 7.1 水位

- 压力 = 估算 token / 模型窗口；`estimateRawContextTokens` 用“选择前原始量”，避免折叠后不降反升；
- 提示条阈值 **90%**（critical）；70–90% 交给自动压缩静默处理；
- 提示条防抖：连续 2 拍 ≥ 阈值才显示，连续 2 拍低于才隐藏；
- 手动关闭后再涨 5 个百分点重现；
- 两个出口：**压缩**（保留摘要、同会话继续）/ **开启新对话（交接）**。

### 7.2 折叠（只读，不改历史原文）

```text
shouldFoldToolOutputs(pressure)
  → foldToolOutputsUnderTarget()
      ├─ 保护最近 2 条工具结果
      ├─ 旧结果 >8192 → 头尾
      ├─ 1–2K 可重放结果 → 240 字存根
      ├─ 重复读取同一路径 → 只留最新
      └─ 旧 write/edit/multi_edit 参数 → 只留 path（正文可用 read 重读）
```

折叠不删历史，只改“发给模型的形态”；面板会显示折叠了几条、最近几轮未动。

### 7.3 压缩（三档，`doCompactMessages`）

| 档 | 范围 | 做法 |
|---|---|---|
| 近端 | 最近 **3 轮** | 逐字保留，**绝不切断**；极端超长轮次按 60 条上限截断并记日志 |
| 中间 | 再往前 **20 条** | 确定性结构化要点（不调 LLM）：用户要求、AI 结论、工具名→参数→结果、文件、错误、待办 |
| 远端 | 更早 | LLM 生成结构化检查点，分块滚动全覆盖（最多 3 次调用）；装不下的最老部分降级为最低保真清单并明写 |

**预算**：压缩阈值 **70%**（`compactionThreshold: 0.7`）；保留预算 = 窗口 **40%** ⇒ 压完留约 **30%** 余量（128K ≈ 38K token）。

**顺序**：先写摘要标记，再删旧消息；摘要调用失败保留已累积摘要；手动与自动共用同一把按会话锁；保留集按体积收缩时按轮次边界向下对齐。

**返回码**：`-1` 锁被占、`-2` 无可移除、`-3` 保留 0 条、`-4` 消息太少；用于 UI 说清“为什么没压”。

---

## 8. 记忆管线

```text
回合结束（onTurnComplete）或压缩后（onCompactionComplete, force）
  → extractMemoriesFromSession(sessionId, projectId)
      ├─ 限频：可见消息数增长足够才再提取
      ├─ LLM 提取候选（JSON）
      ├─ 同批同主题合并（scope 取组内最严，记录 scopePromoted）
      ├─ 查重：同桶 / 平台已有 / 同项目待批准（相似度）
      ├─ 拒绝记录：拒绝过的同类不再写入、不再询问
      ├─ 名额：每轮待批准上限 2；重复/已拒绝不占名额
      └─ 写入：
          ├─ conversation → 直接生效
          ├─ project / platform → 待批准（除非用户消息明确要求记住）
          └─ 积压 > 5 → 降级 conversation 并留 demotedFrom
  → 注入：buildSystemPrompt 的“易变记忆”段（缓存边界之后）
```

**作用域**：平台级（处处生效）/ 项目级（该项目所有会话）/ 对话级（当前会话）。
**明确要求**：只有**用户消息里真的有**“记住”类请求才算 `explicit`；子代理汇报、文件正文里的“请记住”不算（防注入）。
**面板**：待批准列表、双击展开全文、作用域徽标、批量批准/拒绝、一键关闭项目级逐条审批、记忆体检（相似重复、归属失效、迁移回退）。
**判据**：`MEMP-*`、`MEMC-*`、`MEM-DEMOTE-*`、`MPS-231-*`、`MB-UI-*`、`MOP-*`。

---

## 9. 子代理、委派、项目

### 9.1 子代理（同进程）

```text
subagent 工具
  → SubagentRuntime.startContinuable(spec)
      ├─ 创建内部会话（sessions.is_internal=1）
      ├─ 继承工具/安全模式/模型（可覆盖）
      ├─ 后台跑 AgenticLoop
      ├─ activity → UI 面板（当前工具/状态）
      └─ 结算 → settlement notice 投递给父会话（无需 wait）
send_message  → 同一子会话的后续回合
interrupt_agent → 请求取消当前回合
list_agents → 列出 id/label/status
```

默认后台、不阻塞父循环；父循环在“自然结束”前会等待未结算的子代理（settlement gate），但不需要模型显式 `wait`。

### 9.2 跨会话委派/交接

| 工具 | 语义 |
|---|---|
| `delegate_to_session(target_session_id, task)` | 把任务发给**已存在**会话；非阻塞，返回 task id |
| `handoff_to_new_session(task)` | **新建**会话并交接；标题带时间戳，禁止按标题相似度挑老会话 |
| `wait_for_delegation(task_id)` | 有时间预算地等待；返回进度而不是无限阻塞；不能在 delegate 的同一响应里调用 |
| `query_session_result` | 窥视目标会话最新输出 |
| `cancel_delegation` | 取消卡住的任务 |
| `list_sessions` | 列出会话；同名会标 `⚠同名N` |

**约束**：委派深度最大 2（A→B→C 可以，A→B→C→D 不行）；循环依赖 A→B→A 拒绝；目标会话后台执行，输出落库；权限请求仍会问用户。
**执行器**：`core/session/executor.ts::executeSessionTurn` 直接调 `engine.process`，不碰 React 状态；与前台共用 `activeExecutions` 并发登记表。

### 9.3 项目工作台

```text
项目根/.codem/project/
  ├─ state.json         项目 + thread 注册表（唯一真相，不要手改）
  ├─ brief.md           目标/约束/验收
  ├─ MEMORY.md          跨会话项目记忆索引（≤2000 字符进协调者上下文）
  ├─ gates.json         gate 定义
  ├─ events.jsonl       项目事件
  ├─ reports/           每个 thread 的 project_report
  ├─ gate-checks.json   gate 重跑结果
  └─ decisions.jsonl    审批拍板记录
```

- **协调者**：可选创建；只读项目状态（brief/MEMORY/thread registry/reports/gates），不读 thread 聊天正文；上下文项目段 ≤9000 字符。
- **thread**：普通会话 + 可选 worktree；开跑 `working`、报告更新、删除移除。
- **`project_report` v3.1**：status/summary/changes/evidence/gates；坏报告拒绝且可见。
- **gate 重验**：对最新报告里 `passed` 的 gate 重跑 `command`；没有 command = `no-command`，不算 done；证据缺失把 done 降为 review。
- **Overview 四态**：待你 / 运行中 / 待评审 / 已完成；可展开 thread、打开会话、审批 blocked。
- **并发上限**：按机器内存/核心 1–3 个回合；超限拒绝并提示。
- **PR/CI**：`gh` 只读同步；不创建/合并/修 CI。

---

## 10. 持久化链路（双写）

```text
createMessage(message, sessionId)
  ├─ appendSessionMessage() → sessions/<sid>.jsonl（权威，fire-and-forget）
  └─ writeMessageIndex()   → messages.upsert_index（SQLite，最佳努力）
        └─ 一事务写主行 + JSON 列 + 整批替换 tool_calls

updateMessage(id, patch)
  ├─ 现存快照 + 改动 → 追加整行 JSONL
  ├─ upsert_index
  ├─ 仅正文变化 → 重写 FTS
  └─ status → done/error 时补 assistant_text 事件

deleteMessage(id)
  ├─ 删索引（>50 行需 confirm_bulk）
  ├─ 删镜像 / FTS
  ├─ 追加墓碑
  └─ 清日志镜像
```

- **权威 = JSONL**；SQLite 索引允许丢，可由日志重建。
- **事件日志 `session_events`**：append-only；含 JSONL 没有的压缩/工具配对/turn 时间线；**不可从 JSONL 重建**，维护刻意不压缩。
- **会话删除**：先 `abortSessionLoop(sessionId)`，再删；`session-tombstones` 让后续写入短路，避免 FK / 归属不一致。
- **flush**：退出时 `append.flush → events.flush → config.flush → wal_checkpoint(TRUNCATE)`。
- **崩溃自愈**：损坏库三件套改名备份 → 建新库 → 写重建标记 → 维护从 JSONL 重建 + 对账。

---

## 11. IPC 路径

```text
renderer
  ├─ invoke("read_file" / "write_file" / "execute_command" / "spawn_pty" …)
  ├─ invoke("storage_invoke", { command, params })   ← 类型化仓储，不是 SQL
  └─ invoke("storage_batch", { ops })
        ▼
Tauri command（117）
  ├─ 参数解码 / 路径/大小校验
  ├─ storage → codem-db engine（Mutex<Connection>，WAL，authorizer）
  └─ 结果编码为 JSON
```

- **存储命令 7 个**：`storage_invoke/batch/health/integrity_check/checkpoint/capabilities/info`。
- **仓储命令 78 条白名单**（`codem-db/lib.rs`）；未登记 = UNSUPPORTED。
- **分页**：5000 行 / 16 MiB；超出截断并带 `has_more`。
- **错误码**：BUSY/LOCKED/NOMEM/CORRUPT/IO/CONSTRAINT/UNSUPPORTED/…；4 个可重试。
- **前端重试**：幂等命令最多 3 次（50/150/400ms）；`crud.delete` / `events.append` / `messages.create` 不重试。

---

## 12. 中止、错误、结束

### 12.1 中止

- 用户点停止 → `sessionAbort.abort()` + `loop.abort()`；
- 执行器 `abortAll()` 清空排队工具；正在跑的工具收到 abort signal；
- 中止后**过程性事件跳过**，但 `end` 等终局事件仍处理（否则工具卡永久 running）；
- 若模型正在流式输出，中止在下一事件点生效；本轮已产生的 token 仍计入成本。

### 12.2 错误分类

| 类型 | 处理 |
|---|---|
| provider 连接失败 | 重试（按配置）；超时给出可读原因 |
| 上下文溢出 | `overflow` 出口；提示压缩/新对话 |
| 工具参数 JSON 截断 | 拒绝执行，返回“分块重试”指引 |
| 工具超时 | `TOOL_TIMEOUT`，杀进程树，结果标错误 |
| 工具中止 | `TOOL_ABORTED_BEFORE_DISPATCH` / aborted |
| 存储写失败 | 上报 `PersistFailure` 横幅；可重试命令自动重试 |
| 渲染崩溃 | `AppErrorBoundary` 恢复卡片 + 崩溃标记 |

### 12.3 结束原因

`stop`（自然/关键服务/成本/停滞）、`overflow`、`aborted`、`error`。结果对象可带：
`regressionRedTests`、`completionNudges`、`exitReason`、`detail`。

---

## 13. 关键不变量（改代码时守住）

1. **归属**：消息写入必须显式声明 sessionId；不要用“当前加载的列表”推断。
2. **单一写入者**：`message_count` 只由引擎维护；渲染侧不回写。
3. **先日志后索引**：JSONL 是权威；索引失败只上报，不阻断。
4. **不静默丢**：引导、失败、压缩、恢复都必须有可见信号或日志。
5. **前缀稳定**：稳定内容进 system 前缀，易变内容进尾部 user 消息。
6. **压缩不切最近 3 轮**；保留集按轮次边界对齐。
7. **审批与沙箱分离**：审批是“用户是否同意”，沙箱是“路径是否允许”；两层都要过。
8. **同会话不并发**：前台/后台共用 `activeExecutions` 登记表。
9. **结束要收尾**：工具卡、消息状态、watchdog、执行登记都必须在 `finally` 收掉。
10. **能力可降级但不可伪装**：provider 失败、插件未激活、存储不可用都要如实报，不假装成功。
