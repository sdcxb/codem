# zcode 对标分析：与 Codem / DSH 平台逐机制对比

> 对象：`zai-org/ZCode` v3.14.3（commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`）
> 本地检出：`.preview-shot/_zcode-ref`（只读，未修改）
> 我方：本仓库（Codem，Tauri v2 + React + TS，架构基线 DeepSeek Harness）
> 方法：全部结论附 `文件:行号` + 逐字原文；无法从源码证明的一律标 **【推测】**。

---

## 0. 先说清楚：哪些能比，哪些不能比

**不能比的部分（必须诚实）**

「同样的任务 + 同样的大模型，zcode 比 deepseek harness 实现效果好」这句话我**无法验证**。原因不是读取不了代码，而是这句话本身缺少可验证的三要素：

- 谁跑的评测、什么任务集、怎么判分；
- 两边的模型参数（temperature / max_tokens / 系统提示 / 是否关闭思考）是否真的相同；
- 「效果好」是指通过率、token 成本、还是人觉得顺手。

没有这三项，任何「A 比 B 好 X%」的说法都是转述，不是结论。我这一轮**不复述这个说法**。

**能比的部分**

同一个模型在不同 harness 里表现不同，**唯一可能的来源就是 harness 的机制差异**。所以下面的对比全部落在可读、可测、可复现的机制上。我按「会不会改变模型决策」排序，而不是按代码量排序。

**已核对的证据范围**

| 来源 | 规模 | 说明 |
| --- | --- | --- |
| zcode `core/src/runtime/` | 1335.8 KB | 主循环所在，精读约 20 个文件 |
| zcode `core/src/tool/` | 3060.1 KB | 含 1.8 MB 自动生成的 `bash-command-registry.ts`，**未通读** |
| zcode `core/src/compact/` | 32.4 KB | 6 个文件，已全读 |
| zcode `core/src/system-reminder/` | 16.5 KB | 3 个文件，已全读 |
| zcode `core/src/subagent/` + `hooks/` | 145.2 + 95.0 KB | 委派深读 + 关键行本人复核 |
| 我方 `src/core/llm/`、`src/core/prompt/`、`src/core/provider/` | — | 本轮实测 |

未覆盖：zcode 前端展示层、`workflow/`、`browser-client/`、`permission/`、`mcp/`、`telemetry/`。

---

## 1. 总体结论

**架构方向高度收敛，不是两个物种。**

两边独立写下了同一条设计原则——**主循环不用 tool call 次数做硬停止**：

| | zcode | 我方 |
| --- | --- | --- |
| 声明 | `apps/zcode-cli/AGENTS.md`：「长程任务优先：核心 agent loop 默认面向可持续运行的复杂任务设计，**不用 tool call 次数做硬停止**。资源与安全边界应由 token/context limit 自动 compact、用户取消、权限拒绝、工具超时、输出截断、provider retry 上限等明确条件承担。」 | `src/core/llm/index.ts:447`：`maxIterations: 0, // 0 = no cap (DSH-aligned); safety valves handle runaway` |
| 实现 | `runtime/methods/turn-loop.ts:47` `while (true) {`，唯一出口 `:215-218` `if (result === "break") break;` | `src/core/llm/agentic-loop.ts:1065` 硬上限仅在 `maxIterations > 0` 时生效 |

两边也都独立收敛到**「工具结果过大不直接回灌，落盘 + 给预览 + 给定位」**：

| | zcode | 我方 |
| --- | --- | --- |
| 机制 | `<persisted-output>` 信封 + 2000 字符预览（`tool/executor/result-persistence-format.ts:1-5,33`） | `src/core/llm/spill-policy.ts`，`NOTICE_RESERVE_BYTES = 512` |
| 阈值 | 默认 `maxModelBytes: 100_000`；Bash `MAX_INLINE_OUTPUT_BYTES = 30_000` 取**尾部**；Edit 100_000 取头部（`tool/executor/result-serialization.ts:33-40`、`handlers/bash.ts:70,480-492`） | `maxInlineBytes: 32768`（`agentic-loop.ts:1006`） |

**真正的差异集中在三处**，按「对模型下一步决策的影响」排序：

1. **工具返回给模型的错误文本质量**（影响最大 → 见 §2.1）
2. **工具调度的声明化与保序**——`classifyConcurrency(args)` 已建好但没人消费；切调度组时模型给的顺序被重排（见 §2.3.1、§2.6）
3. **系统提示里的行为约束密度**（见 §2.2）

另外发现**我方一个会导致静默损坏文件的确定性 bug**（见 §3.1），这条与对标无关，但比对标结论更紧急——**已修复并带 mutation 自证**。

⚠️ **本节初版还有一条「压缩阈值写死 80K」的结论，复核后是错的**：真实阈值是 `> 0.8` 比值（与 DSH 同口径），80K 属于死代码。误因见 §2.3。这也说明一件事：**我第一遍读代码时，把「定义了某个常量」当成了「这个常量生效」**，两者的区别必须靠查调用点来确认。

---

## 2. 逐机制对比

### 2.1 工具的失败信息质量 —— 差距最大的一处

zcode 的 `edit` 有 **7 级模糊匹配**，`src/core/llm/tools.ts:1339-1340`（我方）：

```ts
if (!content.includes(oldString)) {
  return { title: `edit: ${path}`, output: `Error: oldString not found in ${path}` };
}
```

模型拿到的就是这一句。它不知道自己哪里错了、差多少、该怎么改。

zcode 的对应实现 `tool/handlers/edit-matchers.ts:46-66`：

```ts
// 顺序：quote_normalized → line_number_prefix_stripped → escape_normalized
//      → unicode_escape_normalized → line_trimmed → indentation_flexible → block_anchor
```

且**歧义即拒**（`edit-matchers.ts:132-136`）：归一化候选值不一致就返回 `ambiguous` 而不猜。`replace_all` 禁用模糊层（`BROAD_MATCHERS = line_trimmed | indentation_flexible | block_anchor`，`:25-29`）。`BLOCK_ANCHOR_MIN_SIMILARITY = 0.8`（`:30`），相似度按行 `1 - levenshtein/maxLen`。

它还有 **read-before-edit 门槛**（`handlers/edit.ts:429-431`，partial view 也算没读）和 **stale 检测**（`:444-457`，整数毫秒 + 严格大于 + 内容相同豁免）。我方**两者都没有**——grep `readBeforeEdit|hasBeenRead|mustReadFirst` 在 `src/core` 零命中。

**为什么这条影响最大**：整轮任务里失败率最高的动作就是「改文件」。一次 `oldString not found` 意味着模型必须再花一次 `read` + 一次重试，两次额外往返，还可能猜偏。7 级匹配把这三步压成一步。

**zcode 另外三处同类设计**（同样是「失败时给模型可行动信息」）：

- schema 校验失败返回结构化原因，列表截断 20 条，`tool/validation.ts:107` `errors: errors.slice(0, 20)`，文案在 `input-validation-model-content.ts:50-57`：
  `` `The required parameter \`${parameter}\` is missing` `` / `` `An unexpected parameter \`${parameter}\` was provided` `` / `` `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\`` ``
- 工具未注册 → 构造 `<tool_use_error>` 结果喂回模型（`tool/executor/call-runner.ts:138`），而不是抛异常终止 turn。
- 空工具名 → **也抛错但理由写明了**（`adapters/src/model/tool-call-validation.ts:17-20`）：「在 Adapter 直接抛错的话，模型收不到同 id 的 tool error，整个 turn 因而停止。」——即抛错本身是经过权衡的，不是疏忽。

### 2.2 系统提示里的行为约束密度

zcode 有三条**直接改变模型何时收工**的指令，我方**没有对应条目**（grep `Before ending your turn|premature|Do not stop because` 在 `src/core/llm`、`src/core/prompt` 仅命中无关注释）：

`context/dynamic-sections.ts:38`：

> "Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…', 'let me know when…'), do that work now with tool calls. That includes retrying after errors and gathering missing information yourself. Do not stop because the context or session is long. End your turn only when the task is complete or you are blocked on input only the user can provide."

`dynamic-sections.ts:34`：

> "You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work. For reversible actions that follow from the original request, proceed without asking..."

`dynamic-sections.ts:8-20`（输出契约）：

> "Text you write between tool calls may not be shown to the user. Everything the user needs from this turn — answers, summaries, findings, conclusions, deliverables — must be in the final text message of your turn, with no tool calls after it."

我方对应位置 `src/core/prompt/i18n-templates.ts:92-103`（`finalAnswer`）已经有质量要求（"Before declaring done, verify: run the tests"、"Don't end with 'If you want me to...'"），但**缺「最后一段是不是没兑现的承诺」这个自检**，也缺「不要因为上下文长就停」。

**这一条是「同一模型表现差异」最可能的来源**：它不改变任何基础设施，只改变模型决定「现在停还是继续干」。而且便宜——几行文本。

### 2.3 compact：触发精度 + 双熔断

| 维度 | zcode | 我方 |
| --- | --- | --- |
| token 计数来源 | provider 实际 usage 优先，估算兜底（`compact/policy.ts:28-39,103-104`） | 同样优先实际 usage：`token-tracker.ts` 以「上次实际 promptTokens」为基准叠加增量（`estimatePressure`），无实际值时纯估算 |
| 有效窗口 | `contextWindow - reserve`，reserve = `min(32000, 21000) = 21000`（`policy.ts:75-82`） | 直接用完整 `contextWindow` 作分母（`token-tracker.ts:205`） |
| 自动压缩阈值 | 166,000 / 200K = **0.83**（`policy.ts:12,84-88`） | **`contextPressure > 0.8`**（`agentic-loop.ts:1326` + `:260` 默认值）。`estimatePressure` 返回的是 **0–1 比值**（`token-tracker.ts:205` `Math.min(1, estimatedTokens / contextWindow)`） |
| 压缩后保留 | 默认只保最近 1 个 assistant 轮次（`compact-selection.ts:36`）；手动 `/compact` 一组都不保 | 最近 ≤20 条并按**体积收缩**：估算保留集 token 超预算就成半收缩直到进预算（`agentic-loop.ts::doCompactMessages`，第 83 波，源自真实事故「861 条会话压完仍 105 万 token」） |
| 摘要输出上限 | `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` | `maxTokens` 默认 8192 |
| 连续压缩熔断 | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`（`policy.ts:14,136-144`） | `if (this.state.consecutiveCompactions >= 3)` → 可见地结束并提示开新对话（`agentic-loop.ts:1328-1337`） |
| 压缩后快速回填熔断 | `MAX_CONSECUTIVE_RAPID_REFILLS = 3` → 抛错结束 turn（`turn-loop-state.ts:22,154-168`） | 无**同名**机制，但 `consecutiveCompactions` 上限覆盖了「反复压不动」这一失效模式 |
| overflow 反应式压缩 | provider 报错即触发，每 step 限 1 次 | `enableReactiveCompaction: true`（`:261`），**语义匹配**超窗文案（`provider-errors.ts` 覆盖 DeepSeek「maximum context length is …」/ Anthropic「prompt is too long」等），同样计入 `consecutiveCompactions` 上限（`:2239-2256`） |
| microcompact | 默认关闭；开启后阈值 149,400，只清 9 个白名单工具的**非错误**结果 | **默认常开**；`KEEP_RECENT_MESSAGES = 10`、`MIN_RESULT_SIZE_TO_COMPACT = 500`、`HEAD_CHARS = 3000 / TAIL_CHARS = 800`（`micro-compact.ts:66,72,83-84`） |

**⚠️ 本节初版写错了，此处更正。** 初版说「我方阈值写死 80000、是三方里最激进的」——那是我读了 `src/core/provider/compaction-basic-provider.ts:15` 的 `private threshold = 80000` 得出的。**核实后：那份 provider 的 `shouldCompact` 是死代码**——全仓只有 `agentic-loop.ts:504` 一处引用 `ctx.get('compactionBasic')`，且仅用于「检查服务是否存在」，从不调用其 `shouldCompact`。真实的阈值在 `agentic-loop.ts:1326`，是 **0.8 比值**，与 DSH 基线同口径。

教训：**看到一个眼熟的常量就当成生效配置，等于没验证。** 「这个字段有消费者吗」必须单独查一次调用点，而不是从定义处推断。

**核实后仍然成立的差异**（都不大）：

- 我方比值分母是完整 `contextWindow`，DSH/zcode 都先扣掉输出预留再算 → 我方触发点略早（约 4%），差距不大。
- 我方保留策略按「最近 N 条 + 体积收缩」，DSH 按 `retainRatio` 比例保留；两者都解决了「固定条数在超长会话里压不动」的问题，取向一致。
- zcode 的 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` 是**失败**计数（压缩自身报错也计数），我方是**调用**计数。语义更粗，但配合「压缩返回 0 也会 +1」实际能收敛，**不构成真实缺口**。

我方在「按信息增益判定空转」这件事上**比 zcode 更细**：zcode 的 `detectToolCallBudgetWarning` 阈值默认 `undefined`（`runtime/helpers/model-anomaly.ts:70-84`，等于默认关闭），主要靠重复调用提醒（阈値 3，每 turn 最多 3 条）。我方 `loop-guard.ts` 是常开的。

### 2.3.1 三方对比：DSH 基线 vs zcode vs 我方实测

补测了架构基线 DSH 本体（`.deepseek-harness-ref/`，3495 行报告）。**结论变了一个方向**：

| 维度 | DSH 基线 | zcode v3.14.3 | 我方（Codem 现状） |
| --- | --- | --- | --- |
| 压缩触发 | **比例制**：`thresholdRatio = 0.8`、`retainRatio = 0.16`（`compaction-basic/src/config.ts:19-23,144-148`） | 绝对制：`200000 − 21000 − 13000 = 166000`（`compact/policy.ts:12,75-88`），即 0.83 | **比例制 `> 0.8`**（`agentic-loop.ts:1326`）——**同口径，误报已更正，见 §2.3** |
| overflow 路径 | provider 报错即触发，**绕过比例阈值与保留尾部**（`index.ts:179-189,283-291`） | reactive compact，每 step 限 1 次 | 有，且**语义匹配**超窗文案（`provider-errors.ts`），比字符串白名单更耐 provider 换词 |
| 重试预算 | `compactionRetries ?? 1`、`maxOverflowRetries ?? 1`（`config.ts:92-95`） | 连续失败熔断 3 次 | `consecutiveCompactions >= 3` 硬停（含 reactive 路径）——**存在，也是我初版误报为「无」的一项** |
| 工具并发 | `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`，mode 为**每工具声明**；顺序模型：`mode === 'parallel' ? planned.slice(next) : [first]`（`core/agent-loop/src/tool-calls.ts:84-99`），README：「exclusive calls form barriers; parallel-safe calls use a **bounded rolling pool** and are **reclassified before start**… result context remain **model-ordered**」 | 10，`destructive`→false / `readOnly`→true / `sideEffectScope === "none"`（`tool/scheduler.ts:48,98-102`） | 5，硬编码字符串数组（`streaming-executor.ts:122`）；`tool-pipeline.classifyConcurrency(args)` 已计算但**无人消费**——**此项经复核成立** |
| 会话级外置 | 生产 `maxInlineBytes = 50000` 字节（`spill/spill-policy/src/index.ts:66`、`bundle/base/cordis.patch.yml:352`） | 100,000 字节（`result-serialization.ts:33-40`） | `32768`（`agentic-loop.ts:1006` 显式传入；`spill-policy.ts:86` 自身默认是 `0`＝关闭） |
| 工具结果剪枝（无模型调用的前置 pass） | `thresholdChars: 8192, headChars: 4096, tailChars: 1024`（`compaction-tool-result-pruner/src/config.ts:10-14`），**只在压力已达标后才跑，跑完重测量，可能完全跳过摘要**（`compaction-basic/src/index.ts:281,304-312`） | microcompact：清空标记 + 9 工具白名单（默认关闭） | `MIN_RESULT_SIZE_TO_COMPACT = 500`、`HEAD_CHARS = 3000 / TAIL_CHARS = 800`（`micro-compact.ts:72,83-84`）——阈值更松（500 vs 8192），更容易剪到小结果 |
| 被压范围的选取 | **head-anchored span**：压 `[surfaceNodes[0] … keepFromIdx-1]`，保留 token 计价的尾部，边界必须 tool-call/result 配对平衡（`compaction-basic/src/region.ts:98-134`）；README：「**Turn boundaries do not protect old steps inside a runaway turn**」 | 按轮次保留 | 最近 ≤20 条 + 体积收缩 + 轮次边界对齐（`alignKeepBoundary`） |
| 压缩摘要落盘形式 | `compaction/summary` + `surfaceOp:{op:'replace'}` 的 user/message，内容 = `CHECKPOINT_PREAMBLE + <compacted-summary> + 8 个强制段落`（`summarizer.ts:31-70,189-195`）；**后续周期合并前一个 checkpoint 而非嵌套**（`summarizer.ts:65`） | 摘要文本 | 需核对（本轮未查） |
| 取消时未派发的调用 | **合成错误结果**保证 replay 合法（`tool-calls.ts:249-259`：`'Error: tool call aborted before dispatch'`） | — | 需核对（本轮未查） |
| LLM 请求永久失败 | **终止 turn 且对模型不可见**（`agent.ts:354-371,309-314`）——与「工具错误喂回模型」形成刻意的非对称 | 同 —— | 我方失败**对用户可见**（`agentic-loop.ts:2282-2289` 输出带 ⚠️ 的文本 + `tool_error` 事件），取向不同但更透明 |
| 流式中断已产出的 chunk | `llm-retry` 判定在**流结束之后**（`agent.ts:347-371`）；已产出 chunk 留在 log 作 trace 但**不进 `deriveMessages()`**（`core/session/src/surface.ts:109-113`）——即**丢弃部分输出，不续传** | zcode 从安全锚点**重开流**并保留 partial，续写 3 次 | 需核对我方行为 |

**关键翻转**：在工具调度上，**DSH 基线比 zcode 更先进，而我方偏离了 DSH**。DSH 的 `planned.slice(next)` + 分类重判 + 「结果保持模型顺序」正是 §2.6(b) 指出的我方缺陷的**正解**，而且它是我们自己的架构基线，不是外来方案。

所以我方 §2.6 那两条不是「学 zcode」，是**回归 DSH 基线**。zcode 只是恰好也做对了。

**在压缩触发上，我方是三方里最激进的一个**：DSH 按窗口 80% 触发、zcode 按 166K 绝对触发，我方写死 80K。对 200K 窗口的模型来说，我方在 **40% 占用**就开始压缩——比两边都早一倍以上。这会：过早丢失上下文细节、增加压缩本身的 token 成本、且固定的 80K 对 1M 窗口模型完全不适配。**这是三方对比里最该改的一个数字。**

注：`context.ts:90` 的 `outputReserve: 4096` 也偏小——zcode 用 21K，DSH 用比例。reserve 太小会让「有效窗口」算得过大，与实际可生成空间不符。

---

### 2.4 system-reminder 的全生命周期分类

zcode 把它做成了**声明式 28 源分类表**（`system-reminder/source.ts`，237 行）：

```ts
type SystemReminderDeliveryChannel =
  | "request_prefix" | "current_turn" | "tool_result"
  | "history_continuity" | "mid_turn_event" | "real_user";
```

三组源被显式分桶：

- `SYSTEM_REMINDER_PREFIX_SOURCES = ["context_prefix", "skills_listing"]`（缓存前缀里）
- `SYSTEM_REMINDER_PERSISTED_SOURCES`（15 个：`todo_reminder`、`goal_state_change`、`resume_goal_state`、`goal_completion_verification`、`tool_result_warning`、`rewind_notice`、`conversation_fork`…）（进历史）
- `SYSTEM_REMINDER_PER_REQUEST_SOURCES`（10 个：`incoming_message`、`model_anomaly`、`date_change`、`plan_mode_exit`…）（只在本次请求）

包装器有**硬约束**（`source.ts`）：空正文抛错；**拒绝嵌套 `<system-reminder>` 标签**，命中 `/<\/?system-reminder\b/i` 就转义成 `&lt;`；非 `provider_visible` 源直接抛错。还有 `NON_MID_CONVERSATION_SYSTEM_SOURCES` 控制「哪些提醒必须排到用户问题之前」——顺序是刻意设计的。

**我方的差距不是「有没有 system-reminder」**（我方 `<system-reminder>` 已在多处使用），而是**「注入位置 / 是否持久化」这件事没有被分类管理**。zcode 的分类带来两个直接好处：

1. **缓存命中有保证**：前缀类源必须原文重建，冷恢复时按原文重放，不会因为重新生成而打掉 prompt cache 前缀。
2. **可控性**：一个提醒是「进历史」还是「只这一次」是显式决定的，不是各调用点自己决定的。

**而且它还跟 provider 能力联动**（这条是我之前没料到的）：是否把提醒提升为对话中间的真正 system role，取决于该模型 `supportsMidConversationSystem`（`runtime/methods/microcompact.ts:48-50`）——**同一份对话换 provider，reminder 的 role 与位置都会变**。这就是「同一模型在不同 harness 里表现不同」的一个具体机制：不是模型变了，是喂给它的消息形状变了。

分级注入也做得更节制：`runtime_mode` 每 5 个人类轮注入一次，每第 5 次才给完整版（`runtime/helpers/runtime-reminders.ts:18-21,198-203`）；`todo_reminder` 需「距上次 TodoWrite ≥10 轮 **且** 距上次提醒 ≥10 轮」双条件才发（`:163-169`）。

这条改造量中等，但收益是结构性的——它决定了加新提醒时会不会破坏缓存。

### 2.4.1 「text-only 响应不等于 turn 结束」——两边都做了

zcode 在「模型不再调用工具」之后还有两道闸（`runtime/methods/turn-stop.ts:195-236`）：

1. 是否有用户中途插话（inline guide）待消费；
2. Stop hook 是否要求继续。

**都通过才 `complete()` 并 `return "break"`**（`turn-loop.ts:215-217`）。

我方**有等价机制，且实现位置不同**——插话队列在**迭代起点**消费（`agentic-loop.ts:1373`），在**停止决策处**也做了待处理检查（`:1657-1664`）：

```ts
if (this.state.toolCallsInIteration === 0 && !this.state.compactedThisIteration) {
  // === Guidance pending check ===
  // If there are pending guidance messages (e.g., from immediate injection),
  // continue the loop to let them be consumed at the next iteration boundary.
  if (this.guidanceQueue && this.guidanceQueue.hasPending(sessionId)) {
    console.log(`[AgenticLoop] Pending guidance detected — continuing loop instead of stopping`);
    continue;
  }
```

**结论：这一条不是差距，是对齐。** 我方用 `guidanceQueue.hasPending()` 覆盖了同类失效模式；`guidance-queue.ts:125,136,144` 还额外提供 `peek` / `pendingCount`。真正差别只在 zcode 多接了 Stop hook（我方若做 hook 再补）。

### 2.5 工具契约的显式程度

> DSH 基线用的是 `executionMode`（每工具声明），同样不是「只有 zcode 这么做」——见 §2.3.1。

zcode `apps/zcode-cli/AGENTS.md` 要求每个 tool 声明：

> `inputSchema`、`outputSchema`、是否只读、是否破坏性、是否并发安全、最大输出大小、超时、取消语义和权限需求；副作用范围显式声明（`none`/`workspace`/`git`/`network`/`system`）。

实际落地（`tool/handlers/agent.ts:224-236` 为例）：

```ts
export const agentToolEntry: ToolEntry = {
  capability: "Launch a profile-backed subagent; background execution is runtime-configured",
  metadata: {
    name: "Agent", description: AGENT_PROVIDER_DESCRIPTION,
    readOnly: true, destructive: false, concurrentSafe: true,
    maxOutputBytes: MAX_AGENT_MODEL_BYTES,
    sideEffectScope: "session", riskLevel: "low", needsApproval: false,
  },
```

我方 `ToolDef`（`src/core/llm/tools.ts`）只有：

```ts
export interface ToolDef {
  id: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(...): Promise<ToolExecuteResult>;
  maxResultSizeChars?: number;
  shouldDefer?: boolean;
  searchHint?: string;
  guidance?: string;
  // …展示层字段
}
```

**没有** `outputSchema`、`readOnly`、`destructive`、`concurrentSafe`、`sideEffectScope`、`timeout`、`cancel`。有 `maxResultSizeChars`。

**这条导致的直接后果已经能量化**（下一节）。

### 2.6 工具并发：声明式 vs 硬编码名单

> **先看 §2.3.1**：这一节的两个缺陷，DSH 基线**都没有**。所以下面不是「zcode 有、我们没有」，而是「我们偏离了 DSH，zcode 恰好也做对了」。

zcode（`tool/scheduler.ts:48`）：

```ts
const DEFAULT_MAX_CONCURRENCY = 10;
```
判据 `scheduler.ts:98-102`：
```ts
if (tool.destructive) return false;
if (readOnly) return true;
return tool.sideEffectScope === "none";
```
`Bash`/`Edit` 各自 `concurrentSafe: false`（`handlers/bash.ts:453`、`handlers/edit.ts:261`），独占调度组。执行 `batch-runner.ts:32-34` 是 `Promise.all(toolCalls.map(...))`，**非 fail-fast**。

我方 `src/core/llm/streaming-executor.ts:113-122`：

```ts
maxConcurrent: 5,
// E5: Extended concurrency-safe tools — all read-only tools can run in parallel
concurrencySafeTools: ["read", "glob", "grep", "codebase_search", "file_search",
                        "list_directory", "web_fetch", "lsp", "zvec_grep_search"],
```

**问题不在 5 比 10 小，而在两处更实质的偏差**：

**(a) 声明通道已建好但没接线。** `src/core/llm/tool-pipeline.ts:182-189` 提供了 `registerConcurrency(toolName, classifier)`，`:239` 计算 `const concurrencySafe = this.classifyConcurrency(currentName, currentArgs);`，`:395` 返回 `{ result, events, concurrencySafe }`——但全仓 grep `concurrencySafe` 只有 6 处命中，**没有任何调度点消费这个返回值**。实际调度读的是上面那份硬编码字符串数组。

后果：任何没被写进名单的工具一律串行，且**同一工具的不同调用无法区分**。zcode 的 `classifyConcurrency(args)` 是带参数的——它可以让「读不同文件的两个 read 并发、读同一文件的两个 read 串行」。

**(b) 执行顺序被重排。** `streaming-executor.ts:179-195`：

```ts
for (const tc of toolCalls) {
  if (this.config.concurrencySafeTools.includes(tc.name)) concurrentBatch.push(tc);
  else sequentialQueue.push(tc);
}
if (concurrentBatch.length > 0) yield* this.executeBatch(concurrentBatch, ...);
for (const tc of sequentialQueue) yield* this.executeSingle(tc, ...);
```

**所有并发安全工具先全部跑完，然后才跑非并发安全工具。** 模型给的顺序被忽略。具体失效场景：模型发出 `read(a.ts)` → `edit(a.ts)`（顺序正确），实际执行变成 `edit(a.ts)` 先跑、`read(a.ts)` 后跑。zcode 用「调度组 + 组内 `Promise.all`」（`batch-runner.ts:32-34`）保序，只在组内并行。

注：`streaming-executor.ts:212-218` 在批次内**保证了结果按模型顺序提交**（`slots` 按 idx 回填），注释写明是为前缀缓存稳定——这一层是对的，缺的是**跨批次的顺序**。

### 2.7 其他已核对的差异（简表）

| 项 | zcode | 我方 | 判断 |
| --- | --- | --- | --- |
| 输出被 `length` 截断 | 自动续写 3 次，**有工具调用时永不续写**（`turn-output-token-continuation.ts:18,27-38`）；续写提示 `queryScope: "output_token_continuation"` **不持久化**（`:59-76`） | 已实现自动续写（`agentic-loop.ts:1717-1749`） | 对齐，无需改 |
| 流中断/网络抖动 | 从安全锚点重开流，上限 **10 次**（`streaming-recovery.ts:14`），注释说明理由：「只恢复 1 次会让连续短暂抖动直接失败，和模型默认 10 次 retry 的用户预期差距过大」 | 有 retry 层 | 可核对次数 |
| 「可疑空响应」 | 空输出 + 非 stop finish reason 也当错误处理（`turn-model-step.ts:525-547`） | **未找到对应机制** | 值得补 |
| 工具超时 | **可暂停 deadline**：模型准入排队时间不计入超时（`executor/timeout.ts:13-15,89-90`），注释：「超时守的是『provider 挂了』，不是『我们自己的队列长』」；Bash 120s/上限 600s + `cleanupGraceMs: 6_000` 加在上限**之外** | 有 `toolTimeout`（`streaming-executor.ts`） | 思路值得学 |
| 工具失败是否级联 | **不级联**——旧策略被整段注释废止，`batch-runner.ts:130-132`：「旧策略会在前序非 concurrentSafe 工具失败后，跳过所有后续调度组。连续 subagent 场景里，TodoWrite 这类本地失败会误截断后续 Agent」 | 不级联（grep `skipRemaining|abortOnError|stopOnError` 零命中） | 对齐 |
| 重复工具调用提醒 | 签名 = 对象 key 排序后 JSON（`model-anomaly.ts:111-127`），阈值 3，每 turn 最多 3 条提醒 | 同样做深排序 + `JSON.stringify`（`repeat-tool-reminder.ts:51-64`），**且额外有 loop-guard 信息增益判据** | 我方更强 |
| 子智能体嵌套 | 二元禁止，深度恒为 1（`subagent.ts:284-287`）；`maxTurns` 默认 4 但**核心 turn loop 不消费它**，真正硬边界是 **600,000 ms 静默看门狗**（`subagent/runner.ts:214`） | 子智能体 `maxIterations: 15`（`index.ts:1116`） | 取向不同，各有权衡 |
| hook 语义 | `exit 1` = **fail-open**，只有 `exit 2` 阻断；超时 60s 不阻断；默认 `enabled: false`；只能收紧权限不能放宽（`tool/executor/hook-flow.ts:200-217`） | — | 若做 hook，照这套语义 |
| traceId | 所有执行携带可传播 `traceId`，`sessionId/turnId/messageId/toolCallId/spanId/parentSpanId` 为其子标识；**无法关联到 traceId 的异步任务视为不可观测行为**（`AGENTS.md`） | — | 可观测性差距 |

---

## 3. 顺带发现：我方一个确定性 bug（与本对标无关，但更紧急）

### 3.1 `edit` / `multi_edit` 会用 `$` 记号静默损坏文件

`src/core/llm/tools.ts:1343`：

```ts
const newContent = content.replace(oldString, newString);
```

`multi_edit` 同样（`:1415`）。`String.prototype.replace` 的**字符串**第二参数会把 `$&`、`$$`、`` $` ``、`$'` 当替换记号。

实测（`.preview-shot/_repro-edit-dollar.cjs`，`oldString = "const b = 2;"`，文件为 `const a = 1;\nconst b = 2;\nconst c = 3;\n`）：

```
[损坏] $&  匹配本身         期望="const b = $&;"        实得="const b = const b = 2;;"
[损坏] $$  字面美元         期望="const b = \"$$\";"    实得="const b = \"$\";"
[损坏] $`  匹配前全部        期望="const b = $`;"        实得="const b = const a = 1;"
[损坏] $'  匹配后全部        期望="const b = $';"        实得="const b = "
[正常] ${x} 模板串          期望="const b = `v=${x}`;"  实得="const b = `v=${x}`;"

结果：4/5 种输入会被 String.replace 替换记号语义损坏
```

四个记号的确切语义：`$$` 变成一个字面 `$`（**静默改内容**）；`$&` 展开成被匹配的原文（**重复插入**）；`` $` `` 展开成匹配点**之前**的全部内容；`$'` 展开成匹配点**之后**的全部内容（**重复/错位插入**）。四者都照样返回「Successfully edited」。

修法（zcode 也这么做，`handlers/edit.ts:631-634`）：

```ts
content.replace(oldString, () => newString)
```

函数形式没有替换记号语义。

**这条独立于任何对标结论**：它直接影响改文件成功率，且是静默的。

---

## 4. 值得学的清单（按性价比排序）

### P0 — 已完成的（本次，1.16.201）

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | **修 `$` 记号损坏**：`edit`/`multi_edit`/`str-replace-editor` 三处调用点改用字面替换 | ✅ 带 mutation 自证（还原 bug → 集成测试 5 项失败） |
| 2 | **`edit` 失败时给可行动信息**：5 级归一化候选 + 行号 + 「按原文复制」指令 | ✅ 已完成（`src/core/llm/edit-matchers.ts`） |
| 3 | **参数名写错给可行动提示**（而非 `Cannot read properties`） | ✅ 已完成（`validateEditParams`） |
| 4 | **系统提示补自检**：「最后一段是不是没兑现的承诺 → 现在就做」；「不要因为上下文长而收工」 | ✅ 已完成（中英双语） |
| 5 | **删掉那个误导人的死阈值**（`compaction-basic-provider.ts` 的 `80000`） | ✅ 已完成 |

### P1 — 已完成

| # | 事项 | 状态 |
| --- | --- | --- |
| 6 | **并发名单收敛为单一来源** + 补上真实缺席的 `web_search` + 清掉幽灵名 | ✅ `concurrency-policy.ts`，8 条门禁 |
| 7 | **工具调度保序**：按模型顺序切调度组，连续只读仍并行 | ✅ 7 条门禁，mutation 2/2 |
| 8 | **修 `lsp_tool` 错名**（7 处，权限规则从未生效） | ✅ 5 条门禁 |

### P1 — 经复核仍然成立、尚未做的

| # | 事项 | 依据 |
| --- | --- | --- |
| 9 | **给 `ToolDef` 补契约字段**：`readOnly` / `destructive` / `sideEffectScope` / `outputSchema` / `timeout`，让权限与调度**读声明**而不是各自硬编码 | §2.5。本轮只做了「名单单一来源」，没做「让工具自己声明」 |
| 10 | **组内并发仍是固定分块，不是真正的 rolling pool**：`executeBatch` 按 `maxConcurrent` 把组切成定长块，块间是屏障（12 个并发读 = 5 + 5 + 2 三块依次跑）。DSH 是「有界 rolling pool」—— 一个完成就补一个。本轮**保住了顺序，没做滚动补位**，所以吞吐仍略低于 DSH | §2.3.1、§2.6。**已如实记录，未修**（属优化而非缺陷） |
| 11 | **`SandboxGuard` 的读工具名单仍是幽灵名**（`read_file` / `cat` / `head` / `tail` / `find` / `list_dir` 都不存在）；`read_attachment` / `lsp` 不在里面，实际不受沙箱路径约束 | §2.6。**未修**：需要先确认沙箱对这两个工具的预期行为，不能靠猜 |

### P2 — 长期结构

| # | 事项 | 依据 |
| --- | --- | --- |
| 7 | **system-reminder 声明式分桶**：给每个提醒源标 `request_prefix` / `persisted` / `per_request`，前缀类冷恢复按原文重建以保缓存 | §2.4 |
| 8 | **`traceId` 贯通**：所有异步任务/工具/子 session 必须可关联，否则视为不可观测 | §2.7 |
| 9 | **`tool_result_warning` 通道**：工具结果出问题时在**结果内**联一条提醒，而不是只改状态 | §2.7 |

### 已从清单中删除的（初版误判，复核后不成立）

| 初版声称 | 复核结果 |
| --- | --- |
| 「压缩阈值写死 80K，是三方里最激进」 | ❌ 错。真实阈值是 `> 0.8` 比值，与 DSH 同口径；80K 属于死代码。**误因：把定义处当成了生效处** |
| 「compact 连续失败熔断：无」 | ❌ 已有 `consecutiveCompactions >= 3` 硬停，且 reactive 路径也计入 |
| 「压缩后快速回填熔断：无」 | ❌ 同名机制确实没有，但 `consecutiveCompactions` 已覆盖「反复压不动」这一失效模式，非真实缺口 |
| 「取消时未派发调用合成错误结果：无」 | ⬜ 本轮未核实，不作为结论 |
| 「工具失败级联跳过：已对齐」 | ✅ 该结论成立（grep `skipRemaining\|abortOnError\|stopOnError` 零命中） |

---

## 3.5 修复落地记录（1.16.201）

P0/P1 已在同轮修完并发布，逐项判据与**变异自证**：

| # | 修复 | 判据 | 变异自证 |
| --- | --- | --- | --- |
| 1 | `$` 记号损坏 → `replaceLiteral()`（`edit` / `multi_edit` / `str-replace-editor` 三处） | `edit-dollar-token.test.ts` 22 条 + `edit-tool-integration.test.ts` 13 条（走**真实 `execute()`**，Tauri IPC 桩到 Node fs） | 改回裸 replace → 7 条红；只改 `tools.ts` 的 `edit` → 5 条红；只改 `multi_edit` → 1 条红 |
| 2 | `edit` 未命中 → 5 级归一化候选 + 行号 + 相似度 | 同上（`suggestEditCandidates` 单测 + 集成） | 归一层顺序与「只报告不替换」各有断言 |
| 3 | 参数名写错 → 可行动提示（点名缺哪个参数 + 驼峰提示） | `core-tool-execution.test.ts` TOOL-004b/004c | 断言「不得出现 `Cannot read properties`」 |
| 4 | 工具调度保序（连续只读仍并行） | `tool-scheduling-order.test.ts` 7 条 | 还原旧的「二队列先并行」→ 2 条红 |
| 5 | 并发名单收敛为单一来源 `concurrency-policy.ts` | `tool-concurrency-list.test.ts` 8 条 | 幽灵名塞回名单 → 2 条红 |
| 6 | `lsp_tool` → `lsp`（7 处） | `agent-tool-name-integrity.test.ts` 5 条 | 断言 `lsp_tool` 不得回归 |

**这一轮改动也暴露了三个「名字写错 → 规则静默失效」的同形态问题**，都已修：

- 并发名单三份互不一致，且多为幽灵名；真实只读的 `web_search` 反而**一直被串行**。
- `agent.ts` / `AgentManager.tsx` 共 7 处写 `lsp_tool`，而 `permission.ts:176` 是**精确匹配** ⇒ 三个只读子智能体的 LSP allow 规则**从未生效过**。
- `compaction-basic-provider.ts` 的 `threshold = 80000` 没有任何读取方 —— 就是它误导了我第一版对标报告。

### 门禁口径的两次自我修正（方法论，比结论更重要）

1. **扫描 `id:` 只收双引号** ⇒ 漏掉 `subagent-tools.ts` / `note-operations.ts` 的**单引号**写法，于是把 `create_note` / `subagent` / `send_message` 等**真实工具**误报成幽灵名。改成两种引号都收后，真实 id 从 129 → **156**；幽灵名结论经复核**全部成立**（`read_file`、`list_directory`、`codebase_search`、`file_search`、`web_fetch`、`delete_file`、`cat`、`head`、`tail`、`find` 都不存在）。
2. **`zvec_grep_search` / `zvec_grep_rg` 由 MCP 运行时注册**，静态扫描**天然看不到**。我第一版据此把它们当幽灵名删掉，`zvec-tool-sync.test.ts` 当场变红 —— 那两条用例是对的，它们守的正是「zvec 搜索工具必须可并发」。现改为显式 `DYNAMIC_TOOL_ID_ALLOWLIST`。

**结论：扫不到 ≠ 不存在。用扫描结果去删东西之前，必须先证明扫描口径是对的。** 这与 §2.3 那条（「定义了常量」≠「常量生效」）是同一类错误的两种表现。

---

## 3.6 第二轮审计：逐条核证「机制到底有没有消费者」

用户要求「做完后再次对标分析审计」。这一轮不再看「两边各自写了什么」，而是**逐条核证我方每个机制是否真的接线**——因为第一轮的教训正是「看起来在工作、其实没接线」。

方法：对每个声称存在的机制，查它的**调用方**（不是定义处）。

### 本轮查出的第 7 处静默失效：目标从没交给过模型

| 声称 | 实际 |
| --- | --- |
| `create_goal` 的 guidance：「Goals help track progress and **enable automatic continuation**」 | — |
| `goal-round-driver-provider.ts` 文件头：「AgenticLoop 每轮迭代后检查目标完成状态」 | 该 provider 的 `advanceRound` / `isGoalComplete` **无任何调用方** |
| `agentic-loop.ts` 注释：「Inject goal status into the system prompt for LLM awareness」 | 代码只有 `console.log(...)`，`goalSummary` 算完就丢 |

**模型从头到尾没看到过目标。** 目标建了、`update_goal` 也改了状态，但循环里没有任何一处把它回灌——「自动续做」无从谈起。

**为什么现有测试抓不到**：没有任何东西崩，日志里反而能看到 `[AgenticLoop] Active goals: …` 这种「看起来一切正常」的输出。**只有断言「有没有真的进 prompt」才能发现它。**

已在 1.16.202 修复（`# Active Goals` 段注入，措辞刻意要求「不要重复已完成的工作」——模型可能已做完只是状态没更新，硬命令会让它重复劳动）。门禁 `goal-injection.test.ts` 6 条，变异自证 3/3（换回只打日志 ⇒ 3 条红）。

### 同一轮核证过、确认**不是**缺口的

| 机制 | 核证结果 |
| --- | --- |
| 停止条件下的「用户插话闸」 | ✅ `agentic-loop.ts:1661` 已有 `guidanceQueue.hasPending()` |
| 停止条件下的「后台子智能体闸」 | ✅ `:1669` `pendingBackgroundSubagents.size > 0` |
| 停止条件下的「未取回的委派闸」 | ✅ `:1697` `delegatedTasks.size > 0` 并注入 `wait_for_delegation` 提醒 |
| 工具结果 id 与调用配对 | ✅ 处理器返回空 id，但 `streaming-executor` 在 `:327/:446` 用 `id: tc.id` 覆盖 ⇒ API 契约成立 |
| 压缩的连续失败熔断 | ✅ `consecutiveCompactions >= 3`（含 reactive 路径） |
| 长度截断自动续写 | ✅ `agentic-loop.ts:1723`，上限 3 次 |
| 空响应视为错误 | ✅ `EMPTY_RESPONSE` 抛错 + 重试路径（`:2142-2152`） |
| reactive compact on overflow | ✅ `enableReactiveCompaction: true` + **语义匹配**超窗文案（`provider-errors.ts`，覆盖 DeepSeek「maximum context length is…」/ Anthropic「prompt is too long」） |

### 仍然成立的、未修的差距

| # | 差距 | 性质 |
| --- | --- | --- |
| 1 | **工具名错误的提示质量**：我们回 `Tool "X" not found`；zcode 回 `<tool_use_error>Error: No such tool available: X</tool_use_error>`，且**流式组装期**就能修掉坏调用（`streaming-tool-call-assembler` + `strict-tool-schema` + `tool-input-normalization` 三件套） | 提示质量 + 早期修复，非崩溃 |
| 2 | **`ToolDef` 缺契约字段**（`readOnly`/`destructive`/`sideEffectScope`/`outputSchema`/`timeout`）：调度与权限各自硬编码名单 | 结构性，本轮只做了「名单单一来源」 |
| 3 | **组内并发是固定分块**，不是 rolling pool（12 个读 = 5+5+2 三块依次） | 属优化 |
| 4 | **`SandboxGuard` 读工具名单仍是幽灵名**，且 `read_attachment`/`lsp` 不在其中 | **未修**：需先确认沙箱对这两个工具的预期行为，不能靠猜 |
| 5 | **子智能体无独立墙钟超时**（zcode 有 600,000 ms 静默看门狗；DSH 无 per-driver 超时） | 需评估 |
| 6 | **`traceId` 贯通**：zcode 要求所有异步任务可关联到统一 traceId | 可观测性 |

### 方法论收获（比结论更值钱）

这一轮一共查出 **7 处**「看起来在工作、其实没接线」：`$` 记号替换（静默改坏文件）、`oldString not found`（无可行动信息）、调度顺序被打乱、并发名单幽灵名、`lsp_tool` 错名、永不适用的 `threshold = 80000`、目标只打日志不注入。

它们的**共同形态**是：**代码存在、注释声称在工作、日志看起来正常、测试全绿**。四种检查都过不了这一关，只有两种方法能发现：

1. **查调用方**：断言「这个东西有消费者」，而不是「这个东西存在」。
2. **查输出流向**：断言「数据真的到了该去的地方」，而不是「数据被算出来了」。

本轮新增的门禁全部按这两条写：`tool-concurrency-list`（名字有没有真实对应）、`agent-tool-name-integrity`（规则会不会命中）、`goal-injection`（变量有没有被读用）、`tool-scheduling-order`（执行顺序对不对）、`edit-tool-integration`（走真实 `execute()` 而不只是测 helper）。

### 不建议照搬的

- **`maxTurns: 4`** 用在子智能体上：zcode 自己的核心 turn loop 都不消费它（§2.7）。我方子智能体 `maxIterations: 15` 更符合「长程任务优先」。
- **`bash-command-registry.ts`（1.8 MB 生成表）**：zcode 自己也只用在 2 处——算权限稳定前缀（`bash-command-permission-policy.ts:203`）和遥测基数折叠（`tool-perf.ts:78`）。**不参与安全判定**（安全判定是 `unbash` 解析 + 只读策略表 + `HIGH_RISK_ROOT_COMMANDS`）。要学的是「解析式权限判定」，不是那张表。
- **子智能体硬性禁止写报告文件**（`subagent/system-prompt.ts:17`）：与我方「子智能体用 `report` 工具回传」的取向相反，各有权衡，不动。

---

## 5. 我方比 zcode 更强的地方（避免只看到差距）

1. **空转判定按信息增益，不按计数**：`loop-guard.ts` 的 `DEFAULT_GUARD_LIMITS`（`noGainWarn: 2 / noGainSuppress: 4 / noGainStop: 6`）+ `exactSignature` 稳定序列化 + `mutationExcusesPerPair: 3`。zcode 的对应机制（`detectToolCallBudgetWarning`）阈值默认 `undefined`，等于默认关闭；DSH 的 `repeat-tool-reminder` 也只是「顾问式提醒，不否决、不改写调用」（`src/index.ts:1-7`）。**这条我方确实领先两边。**
2. **`stall-guard` / `micro-compact` / `artifact-tracker` / `spill-policy` 已是完整链路**，不是零散补丁。
3. **子智能体能力面更宽**：in-process / spawn / ACP / claude-code / codex / dsh-sdk / fork-in-process 七种 driver；zcode 子智能体嵌套被二元禁止。
4. **`output-retention` 独立成包**，zcode 的对应逻辑散在 `result-serialization` + `result-persistence-format` 两处。
5. **工具结果按模型顺序提交**（`streaming-executor.ts:212-218` 的 `slots`）——与 DSH README 的「results remain model-ordered」是同一认识。

**但要注意**：第 5 条只对了一半。我方保住了**提交顺序**，丢掉了**执行顺序**（§2.6(b)），而 DSH 两者都保住了。

---

## 6. 对「谁效果更好」的最终回答

**我没法回答这个问题，也不打算替别人的评测背结论。** 我能说的是：

- 两边的**架构哲学已经收敛**（无硬停止、结果落盘、长程优先），不存在「一边有、一边没有」的代差。
- zcode 在**「失败时给模型多少可行动信息」**上明显更细（7 级编辑匹配、结构化 schema 错误、可暂停超时）。
- 我方在**「空转检测」**上确实领先两边。
- **最重要的发现不是「该学 zcode 什么」，而是两条**：
  1. **我方在工具调度上偏离了自己的架构基线 DSH**：DSH 是「每工具声明 mode + 有界 rolling pool + 结果保持模型顺序」，我方 `classifyConcurrency(args)` 算完没人用，判据退回硬编码数组；DSH 的 `planned.slice(next)` 保序，我方把并行工具全部提到前面跑。**zcode 恰好也做对了，但正解来自我们自己的基线。**
  2. **我第一次审计时的两处「差距」是我读代码不严造成的**（压缩阈值、compact 熔断）。真实阈值本就是 0.8 比值，compact 也本就有 3 次硬停。**误因是「看到常量定义就当成生效配置」。** 已在 §2.3 与 §4 更正，并把「删掉那个死阈值」列入待办——一个永久不生效的「阈值」字段会持续误导后来者（包括我）。
- 我方还有一个**确定性文件损坏 bug**（§3.1），无论对标结论如何都该先修——**已修复**。

**所以「zcode 比 deepseek harness 好」这个说法**：按源码看，两边核心机制高度同构，我找不到「一边有、一边没有」的代差。在工具调度这一处，**DSH 基线的设计比 zcode 更完整**（有界 rolling pool + 分类重判 + 模型顺序），问题出在我方没有按 DSH 走。如果那位比较的是「zcode vs 我方当前实现」，在编辑工具容错和调度保序上**有可能成立**；如果是「zcode vs DSH」，按源码看方向是反的。

要真正验证，需要任务集 + 判分方式 + 两边模型参数——**那才是能判定的唯一路径**。我没法替别人的结论背书。

---

## 附：证据可回溯

| 报告 | 位置 | 规模 |
| --- | --- | --- |
| zcode agent 主循环 | `.preview-shot/_zcode-agent-report.md` | 3112 行 / 138 KB |
| zcode 工具层 | `.preview-shot/_zcode-tool-report.md` | 83 KB |
| zcode 子智能体笔记 | `.preview-shot/_zcode-subagent-notes.md` | 2116 行 |
| zcode hooks 笔记 | `.preview-shot/_zcode-hooks-notes.md` | 2480 行 |
| **DSH 基线** | `.preview-shot/_dsh-agent-report.md` | 3495 行 / 166 KB |
| `$` 记号损坏复现脚本 | `.preview-shot/_repro-edit-dollar.cjs` | 可重跑 |
| zcode 源码检出 | `.preview-shot/_zcode-ref`（commit `29628c9a`） | 7060 文件 / 70.9 MB |

本轮**未修改仓库任何源码文件**，仅新增本文档。
