# 第三轮深度对标分析：DSH vs Codem 实现机制差距全景

> 生成时间：2026-08-16
> 前置文档：`deepseek-harness-analysis.md`（第一轮）+ `deepseek-harness-round2.md`（第二轮）+ `dsh-gap-coverage-final.md`（覆盖审计）+ `dsh-skill-fusion-plan.md`（Skills 融合计划）
> 方法论：逐包阅读 DSH 50+ 包 README + 关键源码，对比我们的真实实现代码，提取**实现机制级差距**（不只是功能有无）
> 核心目标：**一切皆插件 — 模型、工具、技能、会话、沙箱、存储、循环、调度、UI 等所有 Agent 能力均由插件组合而成**

---

## 一、分析框架

### 1.1 评级标准

| 评级 | 含义 |
|------|------|
| 🟢 **领先** | 我们有，DSH 没有 |
| 🟡 **对等** | 双方都有，实现深度相当 |
| 🔴 **缺失** | DSH 有，我们完全没有 |
| 🟠 **浅实现** | 我们有骨架，但实现深度远不及 DSH |
| ⚫ **无对标** | 架构范式不同，不可直接对标 |

### 1.2 维度划分

| 维度 | DSH 包 | 我们的对标代码 |
|------|--------|--------------|
| 1. 会话日志 | `core/session` + `session/*` | `storage/event-log.ts` + `event-projection.ts` |
| 2. 工具管线 | `core/tools` | `llm/tool-pipeline.ts` |
| 3. 上下文压缩 | `compaction/*` | `llm/micro-compact.ts` |
| 4. 工具输出溢出 | `spill/*` | 无 |
| 5. 循环防护 | `guard/*` | 无 |
| 6. 时间上下文 | `context/time-context` | 无 |
| 7. 令牌计量 | `llm/token-meter` | 内嵌在 `agentic-loop.ts` |
| 8. LLM 适配器 | `llm/*` | `llm/provider.ts` + `replay-adapter.ts` |
| 9. Code Mode | `core/tools` (Code Mode) | `llm/tools/run-code.ts` |
| 10. 子智能体 | `subagent/*` | `agent/agent.ts` (基础) |
| 11. 工作流编排 | `workflow/*` | `llm/workflow-engine.ts` |
| 12. Agent 预设 | `preset/*` | 无独立预设系统 |
| 13. 工作区实体 | `workspace/*` | 无 |
| 14. 会话查询 | `session-query/*` | 无 |
| 15. 反馈机制 | `feedback/*` | 无 |
| 16. 沙箱 | `sandbox/*` | `capabilities/sandbox/local.ts` |
| 17. Shell 能力族 | `shell/*` | 内嵌 bash 工具 |
| 18. 凭证管理 | `credentials/*` | `provider/credentials-provider.ts` |
| 19. 遥测 | `session/session-telemetry*` | `telemetry/telemetry.ts` |
| 20. 钩子桥接 | `hooks/*` | `hooks/hook-manager.ts` |
| 21. Skills 体系 | `skill/*` | `skill/skill.ts` (已大幅改造) |
| 22. 上下文引用 | `context/session-reference` | 无 |
| 23. tmux 上下文 | `context/tmux-context` | 无 |
| 24. 代理指令分层 | `context/agent-instructions` | 系统提示词硬编码 |
| 25. 不变量伴侣 | `runtime-diagnostics/invariants` | 无 |

---

## 二、逐维度深度对比

### 维度 1：会话日志（Event Sourcing）

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| 事件类型体系 | 14+ 类型，支持 `SessionEventMap` 声明合并扩展 | 14 类型 `SessionEventType`，**固定枚举，不可扩展** | 🟠 |
| Append-only 日志 | `session.append()` 快照+冻结+验证+通知 | `EventLog.append()` SQLite INSERT | 🟡 |
| `deriveMessages()` 投影 | 增量投影，surface 层管理，replace 操作 | `EventProjection.projectAll/Incremental` 有基础实现 | 🟠 |
| Surface 层 | `SessionSurface` 有序投影，`replaceGeneration` 追踪 | 无 surface 层概念，用 `removedMessageIds` Set | 🔴 |
| Fork | `ctx.sessions.fork(source, boundary?, childSessionId?)` 边界选择 | `EventLog.forkSession()` 全量复制，无边界选择 | 🟠 |
| Replay | 事件日志可重放重建完整状态 | 有 `readAll` 但无完整 replay 引擎 | 🟠 |
| 运行时不变量 | `@deepseek-ai/dsh-session/invariant` companion | 无 | 🔴 |
| 请求头重建 | `request/header` 事件记录完整请求快照 | `TurnEndPayload` 记录 usage 但无完整请求头 | 🔴 |
| 崩溃修复 | `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 合成结果 | 无 | 🔴 |
| 会话标题 | `session-title` + LLM provider 注册 | `session_meta` 事件，无 LLM provider | 🟠 |
| 会话投影 | `session-projection` + cache + stats | 无独立投影系统 | 🔴 |
| 会话遥测 | `session-telemetry` + OTel 导出 | `telemetry/telemetry.ts` 基础实现 | 🟠 |
| 持久化后端 | JSONL + SQLite 热切换 | 仅 SQLite | 🟠 |
| 检查点策略 | `session-checkpoint-policy` 语义检查点 | 无 | 🔴 |

**差距分析**：
- 我们已实现事件溯源的**骨架**（事件类型、append、投影、fork），但缺少 DSH 的**深度语义**：Surface 层管理、replaceGeneration、运行时不变量、崩溃修复、请求头重建。
- DSH 的 `SessionEventMap` 通过 TypeScript 声明合并让插件可以注册自己的事件类型（如 `compaction/*`、`llm/retry`、`hook/*`），我们的 `SessionEventType` 是固定枚举，**插件无法扩展事件类型**——这直接违背"一切皆插件"目标。
- DSH 的 Fork 支持边界选择（在任意已完成 turn 后切分），我们是全量复制。

---

### 维度 2：工具执行管线

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| 管线层数 | 5 层（pre-execute → guards → execute → post-execute → finalize + tools/result） | 5 层（完全对齐） | 🟡 |
| pre-execute | waterfall，可 allow/deny/ask | waterfall，可 proceed/deny/modify | 🟡 |
| monotonic guards | `ctx.tools.guard()` 注册不可重排序守卫 | `GuardMiddleware` 固定顺序 | 🟡 |
| execute waterfall | 超时/重试/metrics 包装 | 由 `toolHandler` 处理 | 🟠 |
| post-execute | accept/reject/replace/attach contexts | keep/replace/append/reject | 🟡 |
| finalizeContent | 定义拥有的最终内容冻结 | `FinalizeMiddleware` 已实现 | 🟡 |
| tools/result 观察 | 只读最终结果通知 | `PipelineEvent` 记录 | 🟡 |
| 并行执行 | `isConcurrencySafe(args)` 分类 + bounded pool | 无并行分类 | 🔴 |
| 工具注册 scope | 全局 + agent scope shadow | 全局单例 | 🟠 |
| `ctx.tools.restrict` | agent-scoped allow/deny mask | 无 | 🔴 |
| `ctx.tools.presentAs` | per-agent 工具展示模式 | 无 | 🔴 |
| 工具 owned UI | `presentCall/presentResult` 卡片渲染 | `tool-renderer.ts` 基础渲染 | 🟠 |
| 规范化输出 | `output { schema, render }` 强制声明 | 无规范化输出声明 | 🔴 |
| 取消语义 | `AbortSignal` 贯穿，`ABORTED_BEFORE_DISPATCH` | 无取消语义 | 🔴 |
| Code Mode | `run_code` 保留传输 + 生成 SDK + 子调用管道 | `run-code.ts` 有基础实现 | 🟠 |

**差距分析**：
- 管线骨架已完全对齐 5 层结构，这是之前整改的成果。
- 但 DSH 的管线有**三个深度差距**：
  1. **并行执行分类**：DSH 通过 `isConcurrencySafe(args)` 判定工具是否可并行，bounded pool 调度。我们完全没有。
  2. **规范化输出契约**：DSH 每个工具必须声明 `output { schema, render }`，返回值经 JSON 验证+冻结+渲染分离。我们工具直接返回字符串。
  3. **取消语义**：DSH 的 `AbortSignal` 贯穿整个管线，有 `ABORTED_BEFORE_DISPATCH` 和 `ABORTED` 精确状态。我们完全没有。

---

### 维度 3：上下文压缩（Compaction）

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| Capability Seam | `ctx.compaction` Service Definition + Provider + Consumer | `micro-compact.ts` 内嵌函数 | 🟠 |
| 触发策略 | token 压力 + context-overflow + 手动 `/compact` | 轮次/消息数阈值 | 🟠 |
| 摘要后端 | `ctx.llm.stream()` 直接调用（非 loop step） | 内嵌在 loop 中 | 🟠 |
| Surface 操作 | `surfaceOp: { op: 'replace', start, end }` | `removedMessageIds` Set | 🔴 |
| 工具配对边界 | `toolPairingBalancedBefore/After` | 无 | 🔴 |
| 锁机制 | 日志记录的 `compaction/start` → `compaction/end` | 无 | 🔴 |
| 工具结果裁剪 | `compaction-tool-result-pruner` 独立插件 | 无 | 🔴 |
| 重放一致性 | replay-aware compaction | 无重放保证 | 🔴 |
| 人类命令 | `/compact` 通过 `ctx.commands` | 无 | 🔴 |

**差距分析**：
- 我们有基础的上下文压缩（轮次阈值 + 摘要），但缺少 DSH 的**精度控制**：工具配对边界（不在 tool call/result 中间切分）、锁机制（防并发 compaction）、surface replace 操作。
- DSH 的 compaction 是一个完整的 capability seam（Service Definition + Provider + Consumer 三角色独立），可替换摘要后端。我们是硬编码函数。

---

### 维度 4：工具输出溢出（Spill）

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| SpillStore 服务 | `ctx.spillStore` 定义 WHAT（持久化大文本 + 返回定位器） | 无 | 🔴 |
| Spill 本地后端 | `spill-local` 会话级私有文件 | 无 | 🔴 |
| Spill 策略 | `spill-policy` post-execute 转换器 | 无 | 🔴 |
| 输出保留 | `output-retention` TextRetainer head/tail 预览 | 无 | 🔴 |
| 模型体验 | 预览 + 定位器 + 检索提示 | 工具直接返回大文本 | 🔴 |

**差距分析**：
- **完全缺失**。DSH 的 spill 机制是模型可感知的重要功能：当工具输出超过 `maxInlineBytes` 时，全文存储到会话级私有文件，模型只看到 head/tail 预览 + 定位器 + 检索提示。这直接影响模型在处理大文件、长命令输出时的效率。

---

### 维度 5：循环防护（Guard）

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| repeat-tool-reminder | 连续相同调用检测 + 升级提醒 | 无 | 🔴 |
| 链键 | `(tool name, canonical arguments)` 深排序 | 无 | 🔴 |
| 阈值配置 | `thresholds: [3, 5, 8]` 升级 | 无 | 🔴 |
| per-agent 隔离 | `WeakMap<Agent, Chain>` | 无 | 🔴 |
| include/exclude | 工具名模式过滤 | 无 | 🔴 |
| 提醒投递 | `additionalContexts` 注入 | 无 | 🔴 |

**差距分析**：
- **完全缺失**。DSH 的 `repeat-tool-reminder` 是一个非侵入式循环断路器：它不阻止调用，而是在连续相同调用达到阈值时注入提醒。这对防止模型陷入循环非常有价值。

---

### 维度 6：时间上下文（Time Context）

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| 时区注入 | 浏览器时区 + 进程时区回退 | 无 | 🔴 |
| 时间戳格式 | ISO + IANA zone + 经过时间 | 无 | 🔴 |
| 刷新间隔 | `refreshIntervalMs` 配置 | 无 | 🔴 |
| 请求区域所有权 | 每请求绑定浏览器时区 | 无 | 🔴 |
| pre-step 注入 | `agent/pre-step` 监听器 | 无 | 🔴 |

**差距分析**：
- **完全缺失**。DSH 在每轮准备时注入时间上下文（当前时间、时区、距上次消息经过时间），让模型能正确解释无限定时间。我们完全没有这个机制。

---

### 维度 7：令牌计量（Token Meter）

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| 独立服务 | `ctx.tokenMeter` 单例服务 | 内嵌在 `agentic-loop.ts` | 🟠 |
| 重放感知 | 从事件日志 fold，compaction 后自动调整 | 直接计数消息 | 🔴 |
| provider usage 复用 | 请求信封匹配时复用 provider 报告 | 无 | 🔴 |
| 投影 token | `projectedTokens` 下一次请求预估 | 无 | 🔴 |
| 上下文分解 | system/tools/messages 分项 | 无 | 🔴 |
| 上下文窗口 | `contextWindow` 从 adapter 解析 | 从配置读取 | 🟠 |
| 占用率显示 | pressure/capacity 百分比 | 无 | 🔴 |

**差距分析**：
- 我们有基础的 token 计数（字符数估算），但缺少 DSH 的**重放感知**：DSH 的 token meter 从事件日志 fold，compaction 后自动调整，provider usage 匹配时复用精确值。
- DSH 的 `projectedTokens` 是"下一次请求会花多少 token"的实时预估，直接驱动 UI 占用率显示和 compaction 决策。

---

### 维度 8：LLM 适配器

| 子能力 | DSH | Codem | 评级 |
|--------|-----|-------|------|
| 适配器注册 | `ctx.llm.registerAdapter(providers, adapter)` | `provider.ts` 多 provider | 🟡 |
| 路由替换 | `replace(providers)` 原子路由集更新 | 无热替换 | 🔴 |
| 可配置 provider | `registerConfigurableProviders` | 无 | 🔴 |
| 模型发现 | `discoverModels` 端点查询 | 无 | 🔴 |
| 模型解析 | `resolveModelInfo` 精确身份 + 容量 + 输出默认 | 从配置读取 | 🟠 |
| 调用准备 | `prepareCall` 验证 + 物化默认 + 捕获重试策略 | 无 | 🔴 |
| 流式协议 | `StreamChunk` block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish | 基础流式 | 🟠 |
| BlockAssembler | 统一 chunk → block 装配器 | 内嵌在 streaming-executor | 🟠 |
| 重试策略 | `providerRetryPolicy` provider 拥有 | 无 | 🔴 |
| 适配器事件 | `llm/adapters-updated` 拓扑变更通知 | 无 | 🔴 |
| app 归因 | `attributionHeaders` User-Agent | 无 | 🔴 |
| API key 验证 | `normalizeApiKey` 统一验证 | 无 | 🔴 |
| 错误分类法 | `HarnessError` + `LlmError` 稳定 code | 基础 Error | 🟠 |
| replay 适配器 | 内嵌在 dsh-llm-retry | `replay-adapter.ts` 已有 | 🟢 |

**差距分析**：
- 我们有基础的多 provider 适配（DeepSeek/OpenAI/Ollama）和 replay 适配器（这是我们的优势）。
- 但 DSH 的 LLM 服务有**深度差距**：`prepareCall` 的完整调用准备流程（验证 → 物化默认 → 捕获重试策略 → 请求头记录）、provider 路由热替换、模型发现端点查询、稳定错误分类法。

---

### 维度 9-25 汇总（简表）

| 维度 | DSH | Codem | 评级 |
|------|-----|-------|------|
| **9. Code Mode** | `run_code` + 生成 SDK + 子调度管道 + 并行分类 | `run-code.ts` 基础实现，无 SDK 生成 | 🟠 |
| **10. 子智能体** | `ctx.subagents` 多 provider + spawn/fork/ACP/Codex/Claude + continuable + 控制工具 | `agent.ts` 基础 spawn | 🟠 |
| **11. 工作流编排** | `workflow-engine` worker-thread + fan-out | `workflow-engine.ts` 基础实现 | 🟠 |
| **12. Agent 预设** | `agent-presets` 目录发现 + per-session 挂载 + persona 组合 | 无 | 🔴 |
| **13. 工作区实体** | `ctx.workspaceRegistry` 持久化目录 + 有序会话成员 | 无 | 🔴 |
| **14. 会话查询** | `ctx.sessionQuery` + SQLite FTS5 + trace + 模型工具 | 无 | 🔴 |
| **15. 反馈机制** | `command-feedback` 日志事件 + `message-feedback` sidecar | 无 | 🔴 |
| **16. 沙箱** | `ctx.sandbox` + local Landlock/ACL + policy + escalation | `local.ts` 空壳（rootPath 配置，无真实隔离） | 🟠 |
| **17. Shell 能力族** | `ctx.shell` seam + local/sandbox/pwsh + env + 后台 + PTY | bash 工具内嵌 | 🟠 |
| **18. 凭证管理** | `ctx.credentials` seam + local 存储 | `credentials-provider.ts` 基础 | 🟡 |
| **19. 遥测** | `session-telemetry` + OTel + feedback-gated | `telemetry.ts` 基础 | 🟠 |
| **20. 钩子桥接** | `hooks-claude-code` + `hooks-codex` 桥接插件 | `hook-manager.ts` 基础 | 🟡 |
| **21. Skills 体系** | `SkillRegistry` Service + Provider + filesystem + tool-skill | 已大幅改造，基本对齐 | 🟡 |
| **22. 上下文引用** | `session-reference` 跨会话引用 | 无 | 🔴 |
| **23. tmux 上下文** | `tmux-context` 终端会话上下文 | 无 | 🔴 |
| **24. 代理指令分层** | `agent-instructions` 分层加载 | 系统提示词硬编码 | 🟠 |
| **25. 不变量伴侣** | `runtime-diagnostics/invariants` 运行时断言 | 无 | 🔴 |

---

## 三、模型可感知度排序

> **关键洞察**：不是所有差距都影响模型体验。按"模型是否能直接感知到差距"排序，可以精准投入。

### Tier 1：模型直接感知（每轮对话都在影响）

| # | 差距 | 模型感知 | 影响 |
|---|------|---------|------|
| **T1-1** | **工具输出溢出（Spill）** | 大输出被截断为预览 + 定位器 | 高 — 模型处理大文件/长输出时效率提升 |
| **T1-2** | **循环防护（repeat-tool-reminder）** | 连续相同调用后收到提醒 | 高 — 防止模型陷入循环 |
| **T1-3** | **时间上下文** | 每轮看到时间戳 + 时区 + 经过时间 | 中 — 时间相关推理准确度 |
| **T1-4** | **令牌计量精度** | compaction 基于精确 token 压力 | 中 — 影响上下文管理决策 |
| **T1-5** | **工具并行执行** | 独立调用可并行 | 中 — 多工具调用效率 |
| **T1-6** | **工具取消语义** | ABORTED_BEFORE_DISPATCH 精确状态 | 中 — 取消后恢复行为 |

### Tier 2：模型间接感知（影响交互质量）

| # | 差距 | 模型间接感知 | 影响 |
|---|------|------------|------|
| **T2-1** | **会话查询** | 模型可搜索历史会话 | 高 — 跨会话知识复用 |
| **T2-2** | **反馈机制** | 模型知道反馈被记录 | 中 — 改进激励 |
| **T2-3** | **Agent 预设** | 不同 session 有不同工具/prompt | 中 — 角色定制化 |
| **T2-4** | **代理指令分层** | 系统提示词分层组合 | 中 — prompt 质量 |
| **T2-5** | **工作区实体** | 工作区 → 会话归属 | 低 — 组织性 |

### Tier 3：架构基础设施（模型不直接感知，但影响可扩展性）

| # | 差距 | 影响范围 | 影响 |
|---|------|---------|------|
| **T3-1** | **SessionEventMap 声明合并** | 插件无法注册自定义事件类型 | 高 — 违背"一切皆插件" |
| **T3-2** | **Surface 层 + replaceGeneration** | compaction 精度 | 中 |
| **T3-3** | **运行时不变量** | 数据一致性保证 | 中 |
| **T3-4** | **崩溃修复** | 中断后恢复体验 | 中 |
| **T3-5** | **请求头重建** | 请求可审计性 | 低 |
| **T3-6** | **Capability Seam 广度** | 可替换性 | 高 — 但是长期目标 |
| **T3-7** | **工作区实体** | 多项目管理 | 低 |
| **T3-8** | **tmux 上下文** | 终端会话感知 | 低 |

### Tier 4：工程治理（模型完全无感知）

| # | 差距 | 影响 |
|---|------|------|
| **T4-1** | 不变量伴侣 | 代码质量 |
| **T4-2** | 包不变量检查 | 代码质量 |
| **T4-3** | Postmortem | 工程文化 |
| **T4-4** | Cookbook | 文档 |
| **T4-5** | 测试分层 | 测试质量 |
| **T4-6** | 类型安全增强 | 代码质量 |

---

## 四、已完成的整改对齐

> 在前两轮整改中已完成的 DSH 对齐工作：

| 整改项 | 对齐的 DSH 能力 | 状态 |
|--------|----------------|------|
| 事件溯源骨架 | `SessionEvent` + `EventLog` + `EventProjection` | ✅ 已实现 |
| 工具管线 5 层 | pre-execute → guards → execute → post-execute → finalize | ✅ 已实现 |
| SkillRegistry Provider 接口 | `SkillDiscoveryProvider` + `SkillProviderControl` | ✅ 已实现 |
| FileSkillProvider | `file-skill-provider.ts` 多 root + mtime 缓存 | ✅ 已实现 |
| `load_skill` catalog 模式 | `<available_skills>` + digest 去重 + 替换消息 | ✅ 已实现 |
| `<skill_content>` 结构化输出 | `<skill_resources>` + `<skill_instructions>` | ✅ 已实现 |
| `/skill-name` 用户手势 | 正则匹配 + 自动注入 | ✅ 已实现 |
| Catalog 每轮刷新 | digest 对比 + 替换/首次注入 | ✅ 已实现 |
| Agent 声明 | `agent-declaration.ts` YAML 解析 | ✅ 已实现 |
| Bundled scripts | `bundled-scripts.ts` 通用注册 | ✅ 已实现 |
| 新增 skills | `prose-standard` + `trim-cot-leakage` + `find-simplifications` + `pre-push-checks` | ✅ 已实现 |
| 升级现有 skills | `code-review` + `refactor` + `document` + `test` | ✅ 已实现 |
| Skill 交叉引用网络 | skill 间引用注释 | ✅ 已实现 |
| Code Mode 基础 | `run-code.ts` 工具 | ✅ 已实现（浅） |
| 工作流引擎基础 | `workflow-engine.ts` | ✅ 已实现（浅） |
| 遥测基础 | `telemetry.ts` | ✅ 已实现（浅） |
| 凭证 provider | `credentials-provider.ts` | ✅ 已实现 |
| Replay 适配器 | `replay-adapter.ts` | ✅ 已实现（领先） |

---

## 五、关键差距的根因分析

### 5.1 为什么有骨架但深度不够？

| 骨架 | 缺失的深度 | 根因 |
|------|----------|------|
| 事件溯源 | Surface 层 + 不变量 + 崩溃修复 | 设计时只对齐了"事件追加"，没对齐"投影管理" |
| 工具管线 | 并行分类 + 取消语义 + 规范化输出 | 设计时只对齐了"5 层结构"，没对齐"执行语义" |
| 压缩 | 边界选择 + 锁 + surface replace | 设计时只对齐了"摘要生成"，没对齐"精度控制" |
| Code Mode | SDK 生成 + 子调用管道 | 设计时只对齐了"代码执行"，没对齐"类型安全管道" |
| 子智能体 | continuable + 控制工具 + 多 provider | 设计时只对齐了"spawn"，没对齐"委托延续" |

**根因总结**：每一项骨架都对齐了 DSH 的"名词"（有什么），但没对齐"动词"（怎么运作）。这是因为之前两轮分析主要看 README 标题和功能列表，没有深入到**实现机制级别**。

### 5.2 哪些差距是架构范式差异（不可对齐）？

| 差距 | 为什么不可对齐 | 替代方案 |
|------|--------------|---------|
| `SessionEventMap` 声明合并 | 需要 TypeScript declaration merging + Cordis Events 系统 | 改为运行时事件注册表 |
| `ctx.tools.guard()` | 需要 Cordis Service 注入 | 改为管线注册 API |
| `ctx.compaction` seam 三角色 | 需要 Cordis DI 容器 | 改为插件接口 |
| `replaceGeneration` surface | 需要 Session 对象封装 | 改为 projection 状态 |

---

## 六、我们独有的优势（DSH 没有）

| 优势 | 描述 | 保持策略 |
|------|------|---------|
| **Skill 市场** | 6 源聚合 + 安装 + 发布 | 保持，DSH 无对标 |
| **Skill 安全沙箱** | 23 模式检测 + 审计日志 | 保持，DSH 无对标 |
| **Skill 创建器** | 创建→eval→迭代→打包 | 保持，DSH 无对标 |
| **Skill 携带工具** | Provider 接口 + 动态工具注册 | 保持，DSH 无对标 |
| **交互式表单** | 携带工具 + UI 多选 | 保持，DSH 无对标 |
| **Mermaid 图表** | 10 种图表类型 | 保持，DSH 无对标 |
| **对话转提示词** | 多阶段评估流程 | 保持，DSH 无对标 |
| **Prompt 优化** | diff 审查流程 | 保持，DSH 无对标 |
| **Replay 适配器** | 离线回放 API 响应 | 保持，DSH 有但不如我们完整 |
| **桌面端体验** | Tauri + Rust 代理 | 保持，DSH 是 CLI/Web |
| **MCP 客户端** | 内置 MCP 支持 | 保持，DSH 也有但实现不同 |

---

## 七、整改计划

> 按 **模型可感知度** 从高到低排序，每个 Tier 内部按 **实现难度** 从低到高排序。

### Phase R3-1：模型直接感知差距（Tier 1）

> 目标：补齐模型每轮对话都能感知到的差距。

| # | 任务 | 对齐 DSH | 工作量 | 优先级 |
|---|------|---------|--------|--------|
| **R3-1.1** | **工具输出溢出（Spill）** | `spill/*` | 3 天 | **P0** |
| | 实现 `SpillStore` + `spill-local` + `spill-policy` | | | |
| | 工具输出超过 `maxInlineBytes` 时存储全文 + 返回预览 | | | |
| | 在 post-execute 管线层实现 | | | |
| **R3-1.2** | **循环防护（repeat-tool-reminder）** | `guard/repeat-tool-reminder` | 1 天 | **P0** |
| | 在 post-execute 层注入连续相同调用检测 | | | |
| | 阈值 [3, 5, 8] 升级提醒 | | | |
| | per-agent 隔离 + include/exclude | | | |
| **R3-1.3** | **时间上下文（time-context）** | `context/time-context` | 1 天 | **P0** |
| | 在 pre-step 注入时间戳 + 时区 + 经过时间 | | | |
| **R3-1.4** | **工具取消语义** | `core/tools` 取消 | 2 天 | **P1** |
| | `AbortSignal` 贯穿管线 | | | |
| | `ABORTED_BEFORE_DISPATCH` 合成结果 | | | |
| **R3-1.5** | **工具并行执行分类** | `core/tools` 并行 | 2 天 | **P1** |
| | `isConcurrencySafe(args)` 分类器 | | | |
| | bounded rolling pool 调度 | | | |
| **R3-1.6** | **令牌计量精度提升** | `llm/token-meter` | 2 天 | **P1** |
| | 从事件日志 fold + provider usage 复用 | | | |
| | `projectedTokens` 下一次请求预估 | | | |

**Phase R3-1 小计**：约 11 天

### Phase R3-2：模型间接感知差距（Tier 2）

| # | 任务 | 对齐 DSH | 工作量 | 优先级 |
|---|------|---------|--------|--------|
| **R3-2.1** | **会话查询工具** | `session-query/*` | 3 天 | **P1** |
| | SQLite FTS5 全文搜索 | | | |
| | 模型可调用 `session_search` 工具 | | | |
| **R3-2.2** | **反馈机制** | `feedback/*` | 2 天 | **P2** |
| | `feedback/record` 日志事件 + `/feedback` 命令 | | | |
| | per-message rating sidecar | | | |
| **R3-2.3** | **Agent 预设系统** | `preset/*` | 3 天 | **P2** |
| | 目录发现 `agent.cordis.yml` | | | |
| | per-session 挂载 + persona 组合 | | | |
| **R3-2.4** | **代理指令分层** | `context/agent-instructions` | 2 天 | **P2** |
| | 分层加载系统提示词 | | | |
| | 全局 → 部署 → 项目 → 会话 | | | |

**Phase R3-2 小计**：约 10 天

### Phase R3-3：架构基础设施差距（Tier 3）

| # | 任务 | 对齐 DSH | 工作量 | 优先级 |
|---|------|---------|--------|--------|
| **R3-3.1** | **SessionEvent 运行时扩展** | `SessionEventMap` 声明合并 | 2 天 | **P1** |
| | 将固定枚举改为运行时注册表 | | | |
| | 插件可注册自定义事件类型 | | | |
| **R3-3.2** | **Surface 层 + replaceGeneration** | `core/session` surface | 3 天 | **P2** |
| | 有序投影 + replace 操作 + generation 追踪 | | | |
| **R3-3.3** | **压缩精度控制** | `compaction/*` | 2 天 | **P2** |
| | 工具配对边界 + 锁机制 | | | |
| **R3-3.4** | **崩溃修复** | `core/session` crash repair | 1 天 | **P2** |
| | `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` | | | |
| **R3-3.5** | **规范化输出契约** | `core/tools` output | 2 天 | **P2** |
| | `output { schema, render }` 声明 + JSON 验证 | | | |
| **R3-3.6** | **运行时不变量** | `runtime-diagnostics/invariants` | 2 天 | **P3** |
| | "模型可见即已记录" 断言 | | | |
| **R3-3.7** | **请求头重建** | `core/session` request-header | 1 天 | **P3** |
| **R3-3.8** | **持久化多后端** | `session-persistence-*` | 2 天 | **P3** |

**Phase R3-3 小计**：约 15 天

### Phase R3-4：工程治理差距（Tier 4）

| # | 任务 | 对齐 DSH | 工作量 | 优先级 |
|---|------|---------|--------|--------|
| **R3-4.1** | **测试分层补齐** | 6 层 → 5+ 层 | 2 天 | **P2** |
| | 新增 snapshot 层 + real-API e2e 层 | | | |
| **R3-4.2** | **Postmortem 机制** | `docs/postmortem/` | 1 天 | **P2** |
| **R3-4.3** | **Cookbook 扩展指南** | `docs/cookbook/` | 2 天 | **P3** |
| **R3-4.4** | **类型安全增强** | assertNever + Branded\<B\> | 1 天 | **P3** |
| **R3-4.5** | **包不变量检查** | verify-package-invariants | 1 天 | **P3** |
| **R3-4.6** | **事件系统严格化** | 类型化事件 + 作用域过滤 | 2 天 | **P3** |

**Phase R3-4 小计**：约 9 天

---

## 八、实施路线图

### 总览

| Phase | 内容 | 工时 | 优先级 |
|-------|------|------|--------|
| **R3-1** | 模型直接感知差距 | 11 天 | P0-P1 |
| **R3-2** | 模型间接感知差距 | 10 天 | P1-P2 |
| **R3-3** | 架构基础设施差距 | 15 天 | P1-P3 |
| **R3-4** | 工程治理差距 | 9 天 | P2-P3 |
| **总计** | | **45 天** | |

### 推荐执行顺序

```
R3-1.1 Spill ──→ R3-1.2 repeat-reminder ──→ R3-1.3 time-context
                                                    │
R3-1.4 取消语义 ──→ R3-1.5 并行执行 ──→ R3-1.6 token meter
                                                    │
R3-2.1 会话查询 ───────────────────────→ R3-2.2 反馈
                                                    │
R3-3.1 SessionEvent 扩展 ──→ R3-3.2 Surface ──→ R3-3.3 压缩精度
                                                    │
R3-3.4 崩溃修复 ──→ R3-3.5 规范化输出 ──→ R3-3.6 不变量
                                                    │
R3-2.3 Agent 预设 ──→ R3-2.4 指令分层 ──→ R3-4.* 工程治理
```

### 里程碑

| 里程碑 | 完成标志 | 模型可感知度提升 |
|--------|---------|----------------|
| **M1** (R3-1.1-1.3) | Spill + repeat-reminder + time-context | **高** — 模型每轮都能感知 |
| **M2** (R3-1.4-1.6) | 取消 + 并行 + token meter | **中** — 影响执行效率 |
| **M3** (R3-2.1-2.4) | 会话查询 + 反馈 + 预设 + 指令 | **中** — 影响交互质量 |
| **M4** (R3-3.1-3.5) | 事件扩展 + surface + 压缩 + 崩溃 + 输出 | **低** — 架构可扩展性 |
| **M5** (R3-3.6-4.6) | 不变量 + 工程 | **无** — 纯架构/工程 |

---

## 九、与"一切皆插件"目标的对齐评估

### 9.1 整改后的插件化程度

| 能力维度 | 当前 | R3 整改后 | 插件化目标 |
|---------|------|----------|-----------|
| 会话日志 | 固定枚举事件 | 运行时注册事件类型 | ✅ 可扩展 |
| 工具管线 | 5 层骨架 | 5 层 + 并行 + 取消 + 规范输出 | ✅ 完整 |
| 压缩 | 硬编码函数 | seam + 边界 + 锁 | ✅ 可替换 |
| Spill | 无 | SpillStore + policy | ✅ 可替换 |
| 循环防护 | 无 | post-execute 插件 | ✅ 可插拔 |
| 时间上下文 | 无 | pre-step 插件 | ✅ 可插拔 |
| 令牌计量 | 内嵌 | 独立服务 | ✅ 可替换 |
| 会话查询 | 无 | SQLite FTS5 工具 | ✅ 可替换 |
| Agent 预设 | 无 | 目录发现 + 挂载 | ✅ 可声明 |
| Skills | ✅ 已改造 | ✅ 保持 | ✅ 已达标 |
| 沙箱 | 空壳 | 有待加强 | 🟠 待加强 |

### 9.2 仍不可插件化的能力

| 能力 | 原因 | 缓解方案 |
|------|------|---------|
| `SessionEventMap` 声明合并 | 需要 TypeScript declaration merging | 运行时事件注册表（R3-3.1 已覆盖） |
| Cordis Service 注入 | 需要 Cordis DI 容器 | 插件接口 + 管线注册 API |
| `ctx.tools.guard()` | 需要 Cordis Service | 管线注册 API（已有） |
| `ctx.compaction` 三角色 | 需要 Cordis DI | 接口 + Provider 模式 |

**结论**：R3 整改计划在**不引入 Cordis DI 框架**的前提下，通过**运行时注册表 + 管线注册 API + 插件接口模式**，最大化实现对齐"一切皆插件"目标。剩余不可插件化项是 TypeScript 语言级限制，通过运行时机制绕过。

---

## 十、总结

### 10.1 核心发现

1. **骨架已建，深度不足**：前两轮整改建好了事件溯源、工具管线、Skills 体系的骨架，但每一项都缺少 DSH 的**实现机制深度**（Surface 层、并行分类、Spill、精度控制等）。

2. **6 个完全缺失的能力**直接影响模型体验：Spill（工具输出溢出）、repeat-tool-reminder（循环防护）、time-context（时间上下文）、session-query（会话查询）、feedback（反馈）、agent-presets（Agent 预设）。

3. **45 天可追平 80%+ 差距**：按模型可感知度排序实施，前 11 天（R3-1）就能让模型每轮都感知到改进。

4. **我们的独有优势保持不变**：Skill 市场/安全/创建器/携带工具、交互式表单、Mermaid、对话转提示词、桌面端体验——这些 DSH 完全没有。

### 10.2 与前两轮的关系

| 轮次 | 焦点 | 产出 |
|------|------|------|
| 第一轮 | 功能有无 | 18 项差距清单 |
| 第二轮 | 覆盖审计 | 30 项改进建议 |
| **第三轮** | **实现机制深度** | **25 维度逐层对比 + 45 天计划** |

第三轮的核心价值在于：不再停留在"DSH 有什么功能我们没有"，而是深入到"DSH 的功能怎么运作，我们的骨架差在哪一层"。

---

*文档完成。25 个维度逐层对比，45 天整改计划，按模型可感知度 4 Tier 排序。*