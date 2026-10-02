# DSH 对标修复计划（2026-10-02 · 起于 v1.16.221，落地 v1.16.222）

> ⚠️ **历史文档（不再维护）** —— 这是某一轮的记录，**不是当前的缺口清单**。
>
> 当前缺口与状态**只有一份**：[`docs/GAP-LIST.md`](./GAP-LIST.md)（第 72 轮起维护）。
> 本文里的"待办 / 未实现 / 缺口 / 未完成"类结论都是**按当时的事实**写下的，
> 之后可能已经完成、已经改口径、或者已经被别的做法取代 ——
> 引用本文之前，请在 `GAP-LIST.md` 与**代码**里各复核一次。
>
> 保留本文的理由：它是那一轮的取证记录（当时的数字、现场形态、判断依据），
> 删掉就等于把"我们当时为什么这么做"一起删掉。



> 对标对象：**DeepSeek Harness**，参考源 `C:\mimo-gui\.deepseek-harness-ref`
> = **639ed01539**（release `dsh-0.2.0-rc.2`，本轮 §6 任务 0 已从落后 20467 提交拉到 0 落后）。
> 同时交叉核对**用户实际运行的装机版** `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\*`（未混淆 ESM）。
> 本文件是**计划 + 结果**，每条都写：现象 → 证据(file:line) → 影响 → 修法 → 判据 → 变异自证。

---

## §0 取证手段先说清楚（任务 0 的顺手确认）

交接单让我确认「sourcemap 那个技巧对 DSH 自己的包是否适用」。结论分两半：

| 问 | 答 | 证据 |
|---|---|---|
| `@deepseek-ai/*` 有 `.js.map` 吗？ | **没有**。递归扫出的 **204 个 `.js.map` 全部来自它打包的第三方依赖**（`@opentelemetry/*` 等） | `Get-ChildItem node_modules\@deepseek-ai -Recurse -Filter *.js.map`：`dsh-otel\node_modules\@opentelemetry\...` 起头，无一条属于 dsh 包自身 |
| 那读不到真实实现？ | **能读，而且比 sourcemap 更好**。`lib/index.js` 是**未压缩 ESM**，带完整 JSDoc、TS 类型剥离痕迹和 `//#region lib/types/xxx.js` 分区标记 | `dsh-agent-loop\lib\index.js`：1981 行 / 平均行长 35.8 字符 / 无 `sourceMappingURL` |

**真正更强的取证手段是任务 0 本身**：拉新后的 clone 里有 **3754 个 `.ts` 真源码文件**
（`packages/core/agent-loop/src/agent.ts` 653 行等）。本轮全部结论以**真 TS 源**为准，装机版用于核对是否漂移
（核对结果：`dsh-agent-loop` 与 639ed01 源**逐条一致**，未发现漂移）。

---

## §1 验收标准必须先变成可测的（用户已确认走 A 案）

用户口径：**「当前的项目移植到咱们平台开发，同样用 DS 模型的情况下，水平和 token 消耗都不差于 dsh。」**

交接单已指出这条**不可测**。用户本轮选择 **A：先建尺子，再做对标**。所以本文件里有一节专门写尺子（§4），
并且**把"计量本身是不是准的"当成一条对标缺陷来修** —— 因为尺子不准，后面所有数字都是假的。

---

## §2 缺陷清单（按严重度排序）

分类口径：**隐患** = 会让用户受害的真实行为缺陷；**差异** = 与 DSH 不同但两边都说得通；**缺失** = DSH 有、我们没有的机制。

### D1 隐患｜LLM 调用失败（该轮没有成功工具调用）被收尾成 `reason:"completed"`

- **现象**：provider 抛 400/500 或重试耗尽 → `executeIteration` 的 `catch` 把 `consecutiveErrors` 加一、
  吐一句警告文本后 `return` → 回到 `run()`，因为本轮**从未执行过工具**，`toolCallsInIteration` 恒为 0
  → 命中"无工具调用 = 完成"分支 → 产出 `reason:"completed"`。**错误上限判定排在它后面，永远轮不到。**
- **证据（我方）**：
  - `src/core/llm/agentic-loop.ts:1730` — `if (this.state.toolCallsInIteration === 0 && !this.state.compactedThisIteration) {`
  - `src/core/llm/agentic-loop.ts:1865-1868` — `const result: LoopResult = { type: "stop", reason: "completed", usage: this.state.totalUsage };`
  - `src/core/llm/agentic-loop.ts:1878` — `if (this.state.consecutiveErrors >= this.config.maxConsecutiveErrors) {`（在 1865 **之后**）
  - `src/core/llm/agentic-loop.ts:2353` — `this.state.consecutiveErrors++;`（`:2283` 的 catch 内）
  - `src/core/llm/agentic-loop.ts:51-52` — `| { type: "aborted" }` / `| { type: "error"; error: string };`
    —— 全文件搜 `type: "error"` **只有这一处声明，没有任何构造点**
- **证据（DSH）**：`.deepseek-harness-ref/packages/core/agent-loop/src/agent.ts:375` —
  `turnEnds = { kind: 'error', error: error instanceof LlmError ? error.failure : { message: errorChain(error), code: 'UNKNOWN' } }`；
  `:385` — `this.session.append('turn/end', { turn, reason: turnEnds! })`
- **影响**：
  - 委派/后台路径把失败当成功交回父会话：`src/core/session/executor.ts:643` 只在 `!cleanOutput && endReason !== "completed"` 时判失败，
    而这里的 `cleanOutput` 正是那句警告文本（非空）、`endReason === "completed"` ⇒ 直落 `:719 orchestrator.completeTask(...)` 与 `:723 success: true`。
  - 界面路径：`src/App.tsx:3823` 只对 `reason === "too_many_errors" || "error"` 显示错误气泡，其余走 `:3838` 「任务完成」卡片，消息以 `status:"done"` 落库。
  - **这条直接摧毁 Task 2 的验收**：失败的任务被记成成功，任务通过率无法从事件里读出。
- **修法**：新增 `this.state.lastIterationError: string | null`，在 `executeIteration` 的 catch 里（重试**耗尽之后**）置值、
  每轮迭代开头清空；把 `too_many_errors` 判定提到"无工具调用 = 完成"之前；"完成"分支加 `lastIterationError === null` 前提，
  否则产出已经声明却从未使用的 `{ type: "error", error }`。
- **判据**：`src/test/dsh-d1-llm-failure-not-completed.test.ts` —— 假 provider 的 `stream()` 直接抛
  `Object.assign(new Error("API error 400: bad model"), { status: 400 })`，跑一次 `loop.run(...)` 收集事件，
  断言**最后一个 `end` 事件的 `result.reason !== "completed"`**（且 `result.type === "error"`）。
  另加 executor 级断言：同条件下 `success === false` 且 `completeTask` 未被调用。
- **变异自证**：把 `:1730` 的条件加回 `&& this.state.lastIterationError === null` 的反面（即去掉这个前提）⇒ 用例立刻变红。
- **置信度**：高（`toolCallsInIteration` 三个赋值点 `:1108/:2570/:1623` 逐一核对过，失败路径到不了 `:2570`）。
  注：仓库里 `src/test/trigger-call-execute-loop.test.ts:887` 的注释**声称**这条路径会 `too_many_errors`，
  但该用例（`:899`）只是 `expect(loopSrc).toMatch(...)` 的**源码字符串断言**，不含行为断言，构不成反证 —— 见 §5「假绿实例 4」。

### D2 隐患｜`abort()` 之后同批次/后续组的工具照常派发执行

- **现象**：用户点停止 → `abortAll()` 中止在飞调用并 `running.clear()` → 补位循环看到 `running.size(0) < window(10)`，
  **立刻把剩余调用以全新的、未中止的 `AbortController` 起跑**；`executeSingle` 的组循环里**没有任何 aborted 检查**。
- **证据（我方）**：
  - `src/core/llm/agentic-loop.ts:3856` — `abort() { this.abortController?.abort(); this.executor.abortAll(); }`
  - `src/core/llm/streaming-executor.ts:680` — `abortAll() { for (const [, tc] of this.running) { ... tc.abortController.abort(); } this.running.clear(); }`
  - `src/core/llm/streaming-executor.ts:410` — `while (next < toolCalls.length && this.running.size < window) {`
  - `src/core/llm/streaming-executor.ts:414` — `tc.abortController = new AbortController();`（新控制器，未中止）
  - `src/core/llm/streaming-executor.ts:456` — `if (ctx.abort?.aborted || tc.abortController?.signal.aborted) {`
  - `src/core/llm/agentic-loop.ts:2592` — `abort: undefined as any,`（注释明写"Don't use ctx.abort"，所以 `ctx.abort` 恒为 undefined，这道守卫只剩 per-call 控制器）
- **证据（DSH）**：`.deepseek-harness-ref/packages/core/agent-loop/src/tool-calls.ts:200` —
  `while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {`；
  `:241` — `for (const call of group.slice(started)) appendSkippedToolCall(session, turn, step, call.block)`（未派发的只写合成结果，**绝不执行**）
- **影响**：**「停止」是安全承诺**。用户发现模型跑偏时按停止，期望"别再动了"；实际同一轮里排队的写操作还能再执行最多 9 个
  （默认 `maxConcurrent: 10`，`streaming-executor.ts:146`）。这是本轮唯一一个**用户按了按钮却仍在破坏工作区**的缺陷。
- **修法**：`StreamingToolExecutorImpl` 加实例级 `abortedAll` 标志（`abortAll()` 置位），在 `execute()` 的组循环与
  `executeBatch` 的补位循环条件里检查；并在事件流里对未派发的调用产出"aborted before dispatch"的合成结果（对齐 DSH）。
- **判据**：`src/test/dsh-d2-abort-stops-dispatch.test.ts` —— 假 provider 一次返回 3 个独占（不可并发）`write` 调用，
  handler 只计数不落盘；在收到第 1 个 `tool_start` 后调用 `loop.abort()`；断言 `handlerInvocations <= 1`。
- **变异自证**：删掉补位循环条件里新加的 `!this.abortedAll` ⇒ 计数回到 3，用例变红。
- **置信度**：高。现存 `src/test/interrupt-behavior-architecture.test.ts:48` 只断言"abortAll 后 getRunning() 为空"，
  **不覆盖"之后还会不会再起新调用"** —— 这又是一条只钉住半条链路的判据（§5 实例 5）。

### D3 隐患｜流阶段的取消被 provider 伪装成"正常结束"，且被取消的半截回复没有 interrupted 标记

- **现象**：取消时若卡在 `reader.read()`，`reader.cancel()` 使读取以 `{done:true}` 兑现 → 落进 `if (!streamEnded)` 兜底
  → **伪造一个 `finishReason:"stop"` 的 `end`** → `executeIteration` 认为本轮正常结束 → `run()` 走 **D1 同一条**路径产出 `completed`。
  `abortController` 的 abort 只在 `:1250`（迭代开头）被检查，而"无工具调用 = 完成"的 return 在它之前。
- **证据（我方）**：
  - `src/core/llm/provider.ts:409` — `const abortHandler = () => { try { reader.cancel(); } catch (e) { console.warn('[provider.ts]', e) } };`
  - `src/core/llm/provider.ts:619` — `if (!streamEnded) {` → `:653` — `yield { type: "end", finishReason: Object.keys(currentToolCalls).length > 0 ? "tool_use" : "stop" };`
  - `src/core/llm/agentic-loop.ts:2285` — `if (error.name === "AbortError") {`（该分支对"流阶段取消"**不生效**，因为不抛异常）
  - `src/core/llm/agentic-loop.ts:1250-1251` — `if (this.abortController.signal.aborted) { return { type: "aborted" }; }`
- **证据（DSH）**：`.deepseek-harness-ref/packages/core/agent-loop/src/agent.ts:462` — `interrupted: true,`；
  `:370` — `turnEnds = { kind: 'aborted', reason: cause }`
- **影响**：循环对取消说谎；被取消的半截正文以普通 `status:"done"` 落库，日志里没有"这轮被打断过"这个事实
  （DSH 的 `interrupted: true` 是 durable 且模型可见）。前台之所以没暴露，只是因为 `src/App.tsx:3387`
  `if (sessionAbort.signal.aborted) break;` 提前跳出了事件流 —— **一旦某条调用路径只 abort 引擎而没有自己的 controller，就会看到"任务完成"。**
- **修法**：provider 兜底路径在 `request.abortSignal?.aborted === true` 时 yield `finishReason: "aborted"`；
  `run()` 在 D1 的"完成"分支之前先查 `this.abortController.signal.aborted` 并返回 `{ type: "aborted" }`。
- **判据**：`src/test/dsh-d3-abort-not-completed.test.ts` —— 假流"吐 1 个 chunk 后保持打开"，中途 `loop.abort()`，
  断言最终 `end` 事件 `result.type === "aborted"`。
- **变异自证**：把 `provider.ts:653` 的 `finishReason` 改回恒 `"stop"` ⇒ 用例变红。
- **置信度**：机制高（逐行可证）；用户可见面中（前台被 `App.tsx:3387` 掩盖），故影响按"循环契约层 + 无自带 abort 标志的调用方 + 缺失 interrupted 标记"限定。

### D4 隐患｜工具调用超时只"放弃等待"，不 abort、不杀进程

- **现象**：超时定时器 `reject` 赢得 race，`finally` 只 `cancel()` 清定时器；**`pipeline.execute(...)` 的 promise 没有任何人 await**，
  `tc.abortController` 从未 `abort()`。工具继续跑，副作用照落，模型只看到"timed out"。
- **证据（我方）**：
  - `src/core/llm/streaming-executor.ts:586-601` — `const result = await Promise.race([ pipelineResult.then(...), useTimeout ? (toolTimer = this.timeoutTimer(timeout.timeoutMs)).promise : ... ]);`
  - `src/core/llm/streaming-executor.ts:662-666` — `const promise = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(\`Tool execution timed out after ${ms}ms\`)), ms); });`
  - `src/core/llm/streaming-executor.ts:583` — `{ ...ctx, abort: tc.abortController.signal, toolCallId: tc.id }`（signal 确实传给了管线）
  - `src/core/llm/tools.ts:1011-1013` —— **本仓自己承认过这个形状，却只修了 bash**：
    `// FIX: 传 timeoutMs 给 Rust — 超时时 Rust 真正杀进程树（之前前端 // Promise.race 只是放弃 Promise，底层命令仍在后台跑）`
- **证据（DSH）**：`dsh-tool-call-timeout-policy/lib/index.js:61-75` — `using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` … `if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) { return toolTimeoutResult(timeoutMs) }`；
  `deadline` 在 `.deepseek-harness-ref/packages/util/timeout/src/index.ts:91-110` 用 `AbortSignal.any([upstream, timer.signal])` —— 到点是真的把信号置于 aborted
- **影响**：合同里的 `timeoutMs` 只约束"等多久"，不约束"跑多久"。`bash/write/edit/multi_edit` 都显式 `timeoutMs: NO_TIMEOUT`
  （`tools.ts:866/1351/1527/1605`），所以缺口落在**未声明 NO_TIMEOUT 的其余工具**（走默认 60000，`streaming-executor.ts:150`）上：
  报"超时失败"之后仍完成写入/删除，模型基于"失败了"的假设去重试或改方案。
- **修法**：`timeoutTimer` 到点时先 `this.running.get(id)?.abortController?.abort()` 再 reject（顺序有意义：先中止后拒绝）；
  超时结果结构化（`isError: true` + `code: "TOOL_TIMEOUT"`），对齐 DSH 的 `error.code`。
- **判据**：`src/test/dsh-d4-timeout-aborts.test.ts` —— 注册 `timeoutMs: 50` 的工具，实现里 `ctx.abort.addEventListener("abort", ...)` 置位、
  并 `await sleep(200)` 后 push 副作用；断言 `aborted === true`。
- **变异自证**：删掉新加的 `abort()` 调用 ⇒ `aborted` 恒 false，用例变红。
- **置信度**：高。已排除"用户取消路径也漏"——`abortAll()` 确实 abort（`:680-687`），所以缺口**只在执行器超时这一条路径**上。

### D5 隐患｜每轮往 `apiMessages[0]` 追加易变文本 —— **原文描述错了，真相比它更糟：那段代码从来没执行过**

> ⚠️ **本条是本轮第二次自我更正，必须完整记档。** 我（以及本轮取证报告）原先把这条写成
> 「每轮把秒级时间戳追加进 system 消息尾部 ⇒ 主动作废 provider 前缀缓存」。
> **实施时发现前半段的前提就是假的**：`apiMessages[0]` 在真实会话里**从来不是 system 消息**。

- **原始描述（错的那一版）**：`agentic-loop.ts:1350-1357` 把
  `Time sampled while preparing turn N, step 1: <秒级时间戳>` 追加到 `apiMessages[0]`（假定是 system），
  system 是请求前缀第 0 段，前缀任何一字节变化就让其后所有 KV 缓存失效；
  且 `time-context.ts:177 refreshIntervalMs = config.refreshIntervalMs ?? 0` = 不节流 ⇒ 每轮都变 ⇒ 缓存每轮全 miss。
- **更正后的真相（由实施者在真实循环上打探针实测）**：
  - system 消息是在 `executeIteration` 里**单独构造**的（`messages: [{ role: "system", content: effectiveSystemPrompt }, ...processedMessages]`），
    而 `messagesToLLMMessages` **显式丢弃 system 行**（注释：「Skip system messages (they're handled separately)」）。
  - 因此 `apiMessages[0]` 是**第一条 user 消息**，`if (apiMessages[0].role === "system")` **恒为假**。
  - 探针证据（改动前，真循环 + 假 provider）：请求的 roles 是 `["system","user"]`，
    请求里出现 `Time sampled` 的次数 = **0**。
  - **所以：时间上下文从来没有到达模型。** 它是一个**死功能**，而不是一个缓存杀手。
- **同一段代码里还有一批同形的死注入**（同一条 `apiMessages[0].role === "system"` 守卫）：
  Active Goals、surface 水位、deferred 工具提示、待处理/活跃 skill 提示、skill 目录。
  **它们的共同后果是"写了但从未生效"**，而不是"破坏了缓存"。
- **仍然真实存在的一条**：`effectiveSystemPrompt = systemPrompt + "\n\n" + planContext` 是在 `executeIteration` 里拼的，
  而 `macroStep` 会在一个回合内推进 ⇒ **`planContext` 才是真正活着的那个前缀变动源**。本轮未改（挪动它会改变模型可见行为、牵动步骤计划语义），**列为下一轮**。
- **修法（本轮已做）**：把易变内容从"改 `apiMessages[0]`"改成**追加一条尾部独立 user 消息**（与 DSH 的
  `[...decision.messages, createUserMessage(...)]` 同形），并给时间上下文加 10 分钟节流（DSH 默认 `refreshIntervalMs = 600_000`）。
  结果是**两件事同时成立**：① 稳定前缀（system + 历史）逐字节不变；② 时间上下文/surface 水位**真的到达了模型**。
- **证据（DSH）**：`.deepseek-harness-ref/packages/context/time-context/src/index.ts:134` — `const refreshIntervalMs = config.refreshIntervalMs ?? 600_000`（默认 10 分钟）；`:193-224` 注入形态是往 messages 追加，**绝不改系统提示**。
- **判据**：`src/test/dsh-d5-prefix-cache-stability.test.ts`（5 条）——
  (A) 同会话跑两次（间隔 1.2 秒，跨秒边界），拦截 provider 收到的请求，断言两次 `messages[0]` **逐字节相同**且都不含 `Time sampled`；
  (B) 易变上下文**确实**以最后一条消息到达模型（否则就是"干脆不注入"的假修）；
  (C) 第二次运行因节流不再注入时间上下文；
  (D) 第二次运行的消息数组是第一次的**逐字节前缀**。
- **变异自证**：5a 把 `trailingTurnContext` 整个丢掉 ⇒ (B) 变红（`expected '...当前执行计划...' to contain 'Time sampled'`）；
  5b 把未节流的时间上下文追加回 system 消息 ⇒ (A) 变红（`两轮请求的 system 消息必须逐字节相同`）。
- **置信度**：修法高（探针实测）；**原描述低 —— 已作废**。这条记档的价值在于：
  **"这段代码会导致 X" 的推理，必须先证明这段代码真的会执行。** 我原先把「守卫看起来是对的」当成了「守卫会通过」。

### D6 隐患｜token 计量只记"最后一轮最后一次调用"，且只在整轮无异常结束时写

- **现象**：一次 `process()`（一整轮）里 N 次 LLM 调用的用量确实累积在 `state.totalUsage`，
  但 `for await` **丢掉了生成器的返回值**，而 `usage` 事件每轮只带**本轮**用量并被覆盖 ⇒ CostTracker 只拿到最后一次调用。
  若该轮以 abort / 重试耗尽 / 任何异常结束，`process` 提前退出 ⇒ **一条记录都不留**（且 `success` 恒为 `true`）。
- **证据（我方）**：
  - `src/core/llm/index.ts:1065-1073` — `for await (const event of loop.run(sessionId, message, cwd, systemPrompt)) { if (event.type === "usage") { lastUsage = event.usage; } ... }`
  - `src/core/llm/index.ts:1076-1085` — `if (lastUsage.totalTokens > 0) { this.costTracker.recordUsage({ ... success: true }); }`（在 for-await **之后**，异常路径不执行）
  - `src/core/llm/agentic-loop.ts:2486-2488` — `this.state.totalUsage.promptTokens += usage.promptTokens; this.state.totalUsage.completionTokens += usage.completionTokens;`（累计量**算了但被丢弃**）
  - `src/core/llm/agentic-loop.ts:2532` — `yield { type: "usage", usage };`（全仓**唯一**的 usage 事件产出点，带的是本轮值）
- **证据（DSH）**：`.deepseek-harness-ref/packages/llm/token-meter/src/usage-projection.ts:117-150` ——
  `apply: (state, event) => { ... return { totals: addReplacing(state.totals, previous, buckets), last: {...} } }`，
  并用 `llm/retry-started` 显式"关掉替换槽"，让**重试的尝试也各计一份**
- **影响**：**用户要验收的"token 消耗不高于 DSH"在当前埋点下无法度量。** cost-tracker 的 input/output 总量是
  "每轮最后一次调用 × 成功轮数"，会被系统性低估数倍（一次 15 次工具调用的任务 ≈ 只记 1/15 的输入）；
  失败与中止轮次完全无记录。`src/components/UsageStats.tsx:82-87` 的"缓存命中率"分子分母都来自这批记录，
  因而不是会话命中率，而是"最后一次调用的命中率"。
- **修法**：① 用 `yield*` 或手工 `iter.next()` 取 `LoopResult.usage`（累计值）传给 `recordUsage`；
  ② 把 `recordUsage` 放进 `try/finally`，异常/中止路径落一条 `success: false`（`agenticLoop.getState()` 已存在，无需新接口）。
- **判据**：`src/test/dsh-d6-usage-accounting.test.ts` —— 假 provider 使一次 `process()` 产生 3 次迭代、每次 usage 固定
  `{promptTokens: 1000, completionTokens: 10}`；断言 cost-tracker 恰好 1 条记录且 `inputTokens === 3000`、`outputTokens === 30`（而非 1000/10）。
  第二段：让第 2 次迭代抛 `AbortError`，断言仍存在 1 条 `success: false` 记录。
- **变异自证**：把 `index.ts:1067` 改回 `lastUsage = event.usage;` 的覆盖语义 ⇒ 第一条断言回到 1000/10，用例变红。
- **置信度**：高（`yield { type: "usage" }` 全仓唯一、`for await` 取不到返回值、`recordUsage` 全仓仅 2 个调用点且都在成功路径，三条都是可复核的结构事实）。

### D7 隐患｜`complete()` 的 usage 不解析缓存字段；`TokenTracker` 又用"30% 命中"凭猜填充

- **现象**：`complete()`（压缩摘要与所有非流式调用的唯一出口）返回的 usage **永远不带缓存桶**；
  `TokenTracker` 在 provider 未报命中时，用"上一次 header 指纹相同"推断出 `promptTokens × 0.3` 这个**凭空数字**。
- **证据（我方）**：
  - `src/core/llm/provider.ts:290-294` — `usage: { promptTokens: data.usage?.prompt_tokens || 0, completionTokens: data.usage?.completion_tokens || 0, totalTokens: data.usage?.total_tokens || 0 },`
  - 对照流式路径 `src/core/llm/provider.ts:587-601` —— `const nu = parseProviderUsage(usage);` 并透出 `cacheHitTokens/uncachedInputTokens`
  - `src/core/llm/token-tracker.ts:141-149` — `if (cacheHitTokens === undefined && this.lastHeaderFingerprint === headerFingerprint) { cacheHitTokens = Math.floor(usage.promptTokens * 0.3); }`
  - 可达路径：`src/core/llm/ollama-provider.ts:289-298` 的 usage 就没有缓存字段
- **证据（DSH）**：`dsh-llm-pi-ai/lib/index.js:1371-1379` — `...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}`，
  注释 `:1368-1369` 明说"缺省就是**确实为 0**"，不需要也不允许猜；`.deepseek-harness-ref/packages/llm/token-meter/src/turn-usage.ts:133-137` ——
  `const cacheReadTokens = cacheRead.every(isCount) ? safeSum(cacheRead) : undefined`（每个 attempt 都报了才给总计）
- **影响**：拿**猜测**去对比 DSH 的**实测**，任何"命中率对比"都不成立；压缩开销对成本/命中率分母不可见，命中率会偏高。
  已核查消费方 —— `estimatePressure`/`projectedTokens` 只读 `h.isActual` 与 `h.promptTokens`，**不读该字段**，
  所以它目前未污染压缩决策，严重度限定在"记账不可信"。
- **修法**：① `complete()` 复用 `parseProviderUsage`（与 `:587-601` 同构，可抽私有方法）；② 删掉 30% 分支，
  保持 `undefined`，让"未上报"与"上报 0"在类型上可区分。
- **判据**：`src/test/dsh-d7-usage-cache-buckets.test.ts` —— 给 `complete()` 喂
  `{prompt_tokens: 1000, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300}` 的假响应，
  断言返回 `usage.cacheHitTokens === 700 && usage.uncachedInputTokens === 300`；第二段：连续两次相同 headerFingerprint
  且 `cacheHitTokens` 缺省 ⇒ 两次结果都是 `undefined`（不是 300）。
- **变异自证**：删掉新加的归一化调用 ⇒ 第一条断言变红（`undefined !== 700`）。
- **置信度**：高（`complete()` 与 `stream()` 的 usage 构造是两段独立代码，已逐行读完）。

### D8 隐患｜`edit` 的 `oldString` 多处命中时静默取第一处（DSH 直接拒绝）

- **现象**：`replaceLiteral` 只做一次 `indexOf`，不判唯一性；命中即写盘并返回 `Successfully edited`。
  模型改 `return null;` 这类重复片段时**改错位置且收到成功信号**。
- **证据（我方）**：
  - `src/core/llm/edit-matchers.ts:55` — `const idx = content.indexOf(search);`
  - `src/core/llm/edit-matchers.ts:59` — `return content.slice(0, idx) + replacement + content.slice(idx + search.length);`
  - 调用点 `src/core/llm/tools.ts:1573` — `const newContent = replaceLiteral(content, oldString, newString);`，非 null 即 `:1592` 返回成功
  - **本仓自相矛盾**：`edit-matchers.ts:229` 注释自称「候选值不唯一时明确说『有 N 处』，而不是挑一个」，而 `replaceLiteral` 恰恰挑了一个
- **证据（DSH）**：`dsh-tool-str-replace-editor/lib/index.js:171` —
  `if (offsets.length > 1) throw new FsError(\`No replacement was performed. Multiple occurrences of old_str ... Please ensure it is unique\`, "FS_AMBIGUOUS_EDIT");`；
  工具描述 `:23` 明写 "If the `old_str` parameter is not unique in the file, the replacement will not be performed."
- **影响**：静默改错文件内容；用户要等构建/测试失败才发现。
- **修法**：`replaceLiteral` 先判二义（`content.indexOf(search, idx + search.length)`），命中则返回二义标记（含行号）；
  `edit` 工具据此返回 `Error: oldString appears N times (lines ...) — include more context`，**不写盘**。`multi_edit` 同一路径复用。
- **判据**：`src/test/dsh-d8-edit-ambiguity.test.ts` —— 文件含两处相同片段，执行 `edit`，
  断言结果 `status === "error"` 且 `output` 含处数，且**磁盘内容逐字节未变**。
- **变异自证**：把新加的唯一性分支改成 `if (false)` ⇒ 用例变红。
- **置信度**：高（两侧逐行读过，且我方注释与实现自相矛盾）。

### D9 隐患｜`multi_edit` 部分失败仍报 `completed`（结构化 payload 说谎）

- **现象**：3 条 edits 里第 2 条未命中 ⇒ 提示塞进 `errors` 并 `continue`，其余两条应用成功 ⇒
  写下一个"两条已改、一条未改"的文件，`output` 首行是 `Applied 2/3 edits to …`，**无 `isError`、无 `Error:` 前缀** ⇒ 判为 `completed`。
- **证据（我方）**：
  - `src/core/llm/tools.ts:1702-1705` — `const msg = errors.length > 0 ? \`Applied ${appliedCount}/${edits.length} edits to ${path}. Errors: ${errors.join("; ")}\` : ...`
  - `src/core/llm/tool-result-status.ts:75` — `if (!ERROR_PREFIX_RE.test(line)) return { status: "completed" };`
  - `src/core/llm/tool-result-status.ts:40` — `const ERROR_PREFIX_RE = /^(?:error|错误|失败)\s*[:：-]/i;`（`Applied 2/3 edits` 不匹配）
- **证据（DSH）**：无对应 —— `replaceInFile` 任一失败即 `throw`，**不存在"部分成功"这一状态**。
  本仓自相矛盾之处在 `tools.ts:1702`：同一函数已算出"有失败"，却不把它映射到 `status`。
- **影响**：只读 `status === "error"` 的下游（交付物收集 `src/core/session/ui-handoff.ts:175-178`、委派上报、推进判定）
  把半成品当成品；`agentic-loop.ts:2960-2963` 的 `consecutiveErrors = 0` 让"连错 3 次终止"这条保险不生效。
- **修法**：`errors.length > 0` 时返回 `isError: true`（经 `classifyToolResult` 落到 `status:"error"` + `errorSource:"tool"`）。
- **判据**：`src/test/dsh-d9-multi-edit-partial-failure.test.ts` —— 3 条 edits 第 2 条 `oldString` 不存在，
  断言 `status === "error"` 且 `error` 非空；**同时保留"磁盘上第 1、3 条确实已改"的断言**，证明它确实是部分成功而不是整体拒绝。
- **变异自证**：删掉新加的 `isError: true` ⇒ 变红。
- **置信度**：高（控制流逐行走过）。

### D10 隐患｜`write` 的 "Write not executed" 被判为成功（真·假成功）

- **现象**：用户在写确认框选 `custom` 并给一次性指令 ⇒ 工具返回 `Write not executed. …`，**文件没被写**，
  但该分支**没有 `isError`**，且 `write` 不在 `CONTENT_TOOLS` 白名单里，只能靠首行正则判 ⇒ 不匹配 ⇒ `status:"completed"`。
- **证据（我方）**：
  - `src/core/llm/tools.ts:1439-1442` — `return { title: \`write: ${path}\`, output: \`Write not executed. User gave a ONE-TIME custom instruction ...\`, };`（无 `isError`）
  - `src/core/llm/tool-result-status.ts:73-75` — 非内容型工具走首行正则
  - `src/core/llm/tool-result-status.ts:2-10` —— **文件头把这条缺陷列为第 84 波要消灭的 B 类**，说明那次修复只覆盖了"首行恰好是 `Error:`"的子集
- **证据（DSH）**：无对应（其 write 路径失败一律 `isError`）。
- **影响**：模型宣布任务完成、用户看到绿色成功卡片，而磁盘未变；
  `agentic-loop.ts:2927-2930` 的写入后收尾指引也不会触发（它要求 `output.includes("Successfully wrote")`）。
- **修法**：该分支返回加 `isError: true`；并顺带清点 `tools.ts` 中所有"失败但输出不以 `Error:` 起首"的返回统一补。
- **判据**：`src/test/dsh-d10-write-not-executed-is-error.test.ts` —— 桩 `onWriteConfirm` 返回 `{ action: "custom", instruction: ... }`，
  断言 `status === "error"` 且**磁盘内容逐字节未变**。
- **变异自证**：删掉该分支新加的 `isError: true` ⇒ 状态断言变红（磁盘断言仍绿，证明测的是状态而非路径）。
- **置信度**：高（判定函数与正则逐字核；该分支确实无 `isError`）。

### D11 隐患｜`updateMessage` 拿**日志的旧镜像**当基线做读改写 → `attachments`/`metadata` 被抹掉

- **现象**：`updateMessage` 的 `base` 优先取启动时 hydrate 出来的 `cachedLogMessages` 镜像，而 `logMirrorMessage`
  把记录**收窄成 8 个字段**（丢掉 `attachments`/`metadata`/`hidden`）；`{...base, ...update}` 于是用旧值/缺失去拼新版本，
  而读路径又是"日志覆盖索引" ⇒ 附件与元数据被抹成 `undefined`，且该行成为该 id 的**最后一行**（后写者胜）⇒ 索引重建会把它固化。
- **证据（我方）**：
  - `src/core/storage/message.ts:2362-2371` — `const base = logMirrorMessage(sessionId, id) ?? (storageUnavailable() ? null : safeGetMessage(id));`
  - `src/core/storage/message.ts:786-801` — `return { id, role, content, timestamp, ...(reasoning), ...(model), ...(status), ...(toolCalls) } as Message;`（无 `attachments`/`metadata`）
  - `src/core/storage/message.ts:596-604` — 读合并：`merged.set(rec.id, { ...(existing ?? {}), ...content: rec.content, ... })`（**日志覆盖索引**）
  - `src/core/storage/message.ts:837` — `cachedLogMessages.set(sessionId, messages);`（镜像**唯一**写入方是 hydrate，写路径从不回写）
  - 仓库自己记过同族事实：`message.ts:2437-2441`
- **证据（DSH）**：`dsh-session-persistence-jsonl/lib/index.js:186-192` `enqueueLive`（`structuredClone(event)` + 200ms 批）
  + `:237 this.state.cursor += batch.length` —— 权威状态由事件对象承载并在内存前移，**没有"从磁盘读回一份裁剪副本当下一版基线"这种形状**，DSH 侧无同形物。
- **影响**：`Message.attachments` 是 `src/store.ts:69` 的正式字段；会话 hydrate 过之后附件在日志侧**永久缺席**，
  索引裁剪/损坏重建后就真丢了。`status` 被冻在 hydrate 时的值（不进 JSONL 白名单）⇒ 重建后助手消息可能停在"进行中"。
- **修法**：基线取用顺序改成活的在前 —— `safeGetMessage(id) ?? logMirrorMessage(sessionId, id)`；
  `logMirrorMessage` 不再手工白名单化，与写侧共用同一份字段定义。
- **判据**：`src/test/dsh-d11-update-message-preserves-fields.test.ts` —— 带 `attachments` 的消息 → flush → hydrate（制造冻结点）
  → `updateMessage(id, { content: "v2" })` → flush → 清缓存 + 重新 hydrate，断言记录仍为 `{ content: "v2", attachments: [a1] }`。
- **变异自证**：把 `:2368` 改回 `logMirrorMessage(...) ?? safeGetMessage(id)` ⇒ `attachments` 缺失，用例变红。
- **置信度**：高（三处静态事实互咬：基线只可能来自被收窄的镜像、镜像无写回、合并方向是日志覆盖索引）。

### D12 隐患｜会话文件格式**写了版本号但从不校验**，未知/更新格式被"最宽容地"读成空会话

- **现象**：写侧每条记录都写 `v: 1`，读侧**从不读它**；缺 `content` 就落空串。将来某版把字段改名并把 `v` 提到 2，
  旧构建打开会记为"有效消息但正文为空"，而读合并让空正文**赢过**索引 ⇒ 界面显示空正文，然后被索引重建固化 —— 一次成功的静默降级。
- **证据（我方）**：
  - `src/core/storage/session-jsonl.ts:26` — `const LINE_VERSION = 1;`（用于 `:193/:419/:512` 写入）
  - `src/core/storage/session-jsonl.ts:361-378` — 消费时只检查 `if (!parsed || typeof parsed.id !== "string") throw new Error("bad record");`，**`parsed.v` 在 `src/` 全域无读取点**
  - `src/core/storage/session-jsonl.ts:197` — `content: typeof message.content === "string" ? message.content : "",`
  - 同类先例：`src/core/recovery/recovery.ts:54-78` —— `if (parsed.version === 1) { return parsed; } } catch {} // Return default data`
- **证据（DSH）**：`dsh-session-format/lib/index.js:133-134` —
  `if (from > this.currentVersion) throw new SessionFormatUnsupportedMigrationError(\`stored Session uses newer format v${from}; this build writes v${this.currentVersion}\`);`；
  `:302-310` 目录里显式列 `status: "unsupported"` + reason
- **影响**：格式演进没有安全网；日志是权威副本 ⇒ 损失被固化；运维无法回答"这份日志是哪个版本写的、能不能读"。
- **修法**：读侧先做版本分派，`v > LINE_VERSION` 时**抛错**（经 `message.ts:948-958` 现成的三态机制变成"读不到 + 重试"），**绝不当成空会话**。
- **判据**：`src/test/dsh-d12-session-log-version.test.ts` —— 手写一行 `{"v":2,"id":"m1","role":"assistant","body":"新格式正文","timestamp":1}`，
  断言读取**抛出**（或 `sessionLogReadState === "failed"`），且结果里**不得**出现 `content === ""` 的 `m1`。
- **变异自证**：删掉新加的版本校验 ⇒ 用例变红。
- **置信度**：高（"`v` 从不被读"是可穷举的静态事实）。

### D13 差异（偏隐患）｜引导消息在 `run()` 开头被 `expire()` 静默丢弃

- **现象**：回合尾段输入的引导仍会入队成功、UI 气泡照常显示，但在**下一次** `run()` 的第一件事被 `expire()` 清掉，
  用户得不到任何"你的引导被丢弃"的信号。
- **证据（我方）**：`src/core/llm/agentic-loop.ts:906` — `this.guidanceQueue.expire(sessionId);`（唯一调用点，在 run 开头）；
  `src/core/llm/guidance-queue.ts:149` 注释写 "Called when the agentic loop finishes"，**与唯一调用点不符**；引导正文不落库（`guidance-queue.ts:9`）
- **证据（DSH）**：`.deepseek-harness-ref/packages/core/agent-loop/src/inbox.ts:226/237` —— 丢弃会 emit `agent/inbox/discarded`；inbox 是**持久投影**
- **修法**：把 `expire()` 挪到回合终态路径；或把未消费引导降级为真实 user 消息落库；至少发一条可见通知。
- **判据**：`src/test/dsh-d13-guidance-not-silently-dropped.test.ts` —— 无活动 run 时 `sendGuidance("不要动 X")`，
  再发起 `run()`，抓第 1 次请求的 messages，断言其中包含引导正文；或断言被丢弃时产生了可见通知。
- **变异自证**：删掉 `:906` 的 `expire()` ⇒ 断言按当前设计变绿，从而证明它测的正是这条路径（本条的判据形态取决于最终选哪种修法）。
- **置信度**：中（可达性依赖"上一回合已判定结束、下一回合 run() 开始之前"这个窄窗口；机制本身逐行确认）。

---

### D10b 隐患｜同一"假成功"类别的**其余实例**（本轮一并收口）

- **现象**：D10 修好之后，按同一形状清点全仓，又找到三处"失败但既不以 `Error:` 起首、也没设 `isError`"的返回。
  其中一处**必然**是假成功，因为它的工具被 `CONTENT_TOOLS` 豁免了文本推断：
  `read_attachment` 在 `src/core/llm/tool-result-status.ts:21-37` 的白名单里，而 `:72` 对白名单工具**直接返回 completed**
  —— 也就是说 `read_attachment` 的失败**只能**靠显式 `isError` 表达，否则**永远**报成功。
- **证据（我方）**：
  - `src/core/llm/tools/read-attachment.ts:258` — `Failed to resolve workspace path...`；`:282` — `Failed to read file...`
  - `src/core/llm/tools/zvec-tool.ts:53,56` — `[zvec-grep error]…`（首字符是 `[`，**永远**匹配不上 `/^(?:error|错误|失败)\s*[:：-]/i`）
  - `src/core/llm/dynamic-plugin-tools.ts:57,152,194,235` — `Failed to define/run/stop/undefine plugin: …`
- **为什么这条要单独列**：D10 只修了 `write` 一条路径，而文件头（`tool-result-status.ts:2-10`）把这类缺陷描述为**一个类别**。
  按"一个实例 = 一类问题"来收口，才能避免下一次又从另一个工具漏出来。**这正是 Pi 用显式契约、不用文本启发式的原因**（见 `docs/PI-ALIGNMENT-FIX-PLAN.md` P-3）。
- **修法**：逐个判定"是否真的是失败"，是则补 `isError: true`；**判定为信息性/正常结果的（如 `bash` 非零退出码）不许改** ——
  非零退出常常是正常结果（`grep` 没匹配到、`git diff --exit-code`、`test -f`），
  这一点 DSH 与 Pi 的做法一致（Pi 只在 spawn 失败/abort 时算 error，非零退出与超时都**不是** error）。
- **判据**：`src/test/dsh-d10b-tool-failure-class.test.ts` —— 每条被修的路径：构造失败，断言 `status === "error"` 且 `error` 非空；
  并要求**反向对照**证明用例真的走到了失败分支（防止"输入本身就不合法，所以删掉校验也没变"这种假绿）。
- **变异自证**：逐条去掉新加的 `isError: true` ⇒ 对应用例变红。
- **置信度**：高（三处路径都是静态可穷举的；`read_attachment` 被 `CONTENT_TOOLS` 豁免这一条已按代码核对）。

---

## §3 本轮不做但已取证的项（写清理由，不算"已完成"）

| 项 | 为什么这轮不做 |
|---|---|
| **DSH 的 `fs-observation-policy`（读后写 / `replaceIfVersion` CAS）** | 是真缺失（我方 `fs-observation-policy-provider.ts` 全文 16 行，只有监听防抖配置，**没有任何写入前置条件**；DSH 的 `editIntent` 会抛 `FS_NOT_OBSERVED`）。但它需要在工具层引入 per-session 观察表 + 版本基准，属于**新的正确性契约**，要和 D8/D9/D10 的语义一起设计，单独塞进本轮会和这三条互相打架。**列入下一轮，且建议与 D8 同批做。** |
| **DSH 的 `dsh-atomic-write` 设施语义、`append_file` 无 fsync、torn-tail 修复、写前 flush 闸门** | 都是真实的耐久性差距（`append_file`（`src-tauri/src/lib.rs:768-780`）无 `fsync`，而 `write_file`（`:732`）有）。但涉及 Rust 侧新命令（`truncate_file` / `read_text_window` 增 `completeTail`）与"副作用前必须落盘"的**策略决定**（会改变每轮的 IPC 形状与失败语义），不宜与 D1–D12 混在一批里改。**单独立项。**<br>⚠️ **本轮在核查 D12 时新发现并实测到一条更重的形态，必须记档**：Rust `append_file` 用 `OpenOptions::append(true)` + `writeln!`，**从不检查文件是否以换行结尾**；于是崩溃留下的半截尾行会让**下一条记录被粘在同一行上**（`<半截 JSON><合法 JSON>`）→ 整行 `JSON.parse` 失败 → 那条**本来合法**的记录对所有读者都不可见；而 `compactSessionLog` 把解析不了的行**直接丢掉**（`session-jsonl.ts:868`），它的安全闸门只比行数（`:909-911` `linesAfter < linesBefore`），**看不见"一行坏行里裹着一条合法记录"** ⇒ **合法记录被永久删除**，而压缩又是权威日志唯一的瘦身手段。<br>同时确认：`skippedLines`（`session-jsonl.ts:348/376/403-406`）**在生产代码里没有任何消费者**（只在定义与 3 个测试文件里出现），所以"半截行"事实上是**不可见**的 —— 那句 `@returns … 用于诊断「日志是否被截断过」`是做不到的承诺（本轮已把该 doc 改成写明这一点）。**这两条都比原 §3 里写的更该优先，建议下一轮第一条就做。** |
| **压缩摘要调用的缓存复用名不副实**（`agentic-loop.ts:3636-3708` 把消息截成 500/200 字字符串、换掉 system、不传 tools，却自称 "cache-aware"，DSH 用 `deriveEventMessage` 原样重放） | 现象已核实，但正确修法要重排 `messagesToRemove` ↔ 原始消息的映射并重建请求体，是**中等规模改动**；且它只在触发压缩时发生（D5 是每轮都发生）。**先修 D5，再评估它。** |
| **压缩压力估计不含 system 提示**（`token-tracker.ts:186-206` 无基线分支只累加消息正文；阈值 0.8 与发送预算 0.9 是两套口径） | 方向正确但需要确定"system + 工具 schema 的估算口径"统一到哪一层，属设计决定。**列入下一轮。** |
| **工具结果 head/tail 按 UTF-16 code unit 切**（`context-fold.ts:89-94`、`micro-compact.ts:189-191`；DSH 明写按码点切，`compaction-tool-result-pruner/src/index.ts:99-109`） | 真实但危害小（孤立代理项 → `U+FFFD`，只在裁剪点砸到非 BMP 字符时可见），且同一功能有正例可参照（`src/core/storage/spill.ts:70-77` 已做正确的字节边界修剪）。**低优先，随手可修。** |
| **上下文配置面板的"压缩阈值/上下文窗口/保留条数"不驱动真实循环**（`ContextMonitor.tsx:554-556` 写 `codem-context-config`，`agentic-loop.ts:1399` 读 `LoopConfig.compactionThreshold`，两者无桥接） | 是"UI 承诺了它做不到的事"。但修法有两条互斥路线（桥接 vs 移除控件），**属于产品决定**，且本轮已占用同一文件的改动。**列入下一轮并请在 §7 里挑一条。** |

---

## §4 尺子：把"水平和 token 消耗不差于 dsh"变成可判真假

用户本轮选择 A 案（先建尺子）。尺子由三块组成，**前两块是本轮交付**：

### 4.1 计量先要准（D6/D7 的直接产物）

没有 D6/D7，任何 token 数字都是假的。所以要能回答：**一次任务一共花了多少 input/output/缓存命中**，
且在**失败与中止**的轮次上也有记录。验收形态：`token-accounting` 判据（见 D6）能变红也能变绿。

### 4.2 成对对照跑法（方法学取自 Pi 的 `packages/evals`，见 `docs/PI-ALIGNMENT-FIX-PLAN.md`）

固定任务集 + 同模型 + 每任务两侧各跑 N 次，逐项报 **成对均值差**：

| 指标 | 我方来源 | DSH 来源 |
|---|---|---|
| input / output / cacheRead / cacheWrite tokens | cost-tracker（D6/D7 修好之后） | DSH 的 token 用量上报 |
| 任务是否完成 | **D1 修好之后**事件里的 `end.reason` | DSH 的 `turn/end.reason` |
| 是否需要人工纠偏 | 会话里是否有用户打断/追问 | 同 |
| 工具调用次数、总耗时、估算成本 | toolCalls / duration / cost | 同 |

**关键纪律（照抄 Pi，见其 `packages/evals/src/report.ts:249-281`）**：成对样本只要有一侧缺数据，
**该对被"阻塞"并拒绝给出头部结论**，而不是当作 0；"一次重复不足以说明稳定性"。
这条纪律正是为了不让尺子本身产生假绿。

### 4.3 明确还没做到的部分（不许含糊）

- **任务集尚未冻结**。本轮只交付"怎么测"与"计量已可信"，**没有**产出任何"我方优于/等于 DSH"的数字。
- DSH 那一侧的对照数据需要另一次专门跑（两条产品线的任务集要能同构喂进去）。
- **所以本文件不主张"已经不差于 dsh"** —— 那需要 4.1+4.2 实际跑出数字之后才能说。

---

## §5 假绿实例（本轮新增的记录，接续交接单 §5.1 的三种）

1. **`cache-prefix-stability.test.ts` 测的是纯函数，而真实链路上那段代码根本没执行。**
   它断言 `buildSystemPrompt({date:"10:00"})` 与 `{date:"10:01"}` 的公共前缀 > 95%，并有一条**命名为**
   「同会话连续请求 prompt 完全一致 → 前缀 100% 稳定（API 命中前提）」的用例 —— 但两次都调用同一个纯函数、传同一份 config。
   **它比"漏测"更糟**：真实链路里 `if (apiMessages[0].role === "system")` **恒为假**（详见 D5 的更正），
   所以那条注入是死代码。**一条判据可以在一个根本不执行的链路上，长期稳定地绿着，并让所有人以为这条性质被守住了。**
   → D5 的判据改为在 `run()` 的真实请求上断言（`dsh-d5-prefix-cache-stability.test.ts`）。
2. **`interrupt-behavior-architecture.test.ts:48` 只钉了"abortAll 后 running 为空"，没钉"之后不再起新调用"。**
   于是 D2 那个"按了停止还在写"的缺陷可以在一条名叫"中断行为架构"的判据下全绿。→ D2 的判据改为数 handler 调用次数。
3. **`trigger-call-execute-loop.test.ts:887` 用源码字符串断言伪装成行为断言。**
   它的注释声称覆盖「LLM 连续失败 → too_many_errors」，实际只是 `expect(loopSrc).toMatch(...)`。
   **读源码文本的断言不能证明运行时会走那条分支。**
4. **`goal-injection.test.ts` 同理，而且它掩盖的是一个真功能失效。**
   它断言 `# Active Goals` 前后约 400 字符窗口里存在 `content +=` —— 于是它在
   **「活跃目标从来没有到达过模型」**（D5 更正里那条死守卫）的状态下**一直是绿的**。
   → 本轮改成行为判据：驱动循环、断言 provider 实际收到的请求里有目标内容。
   **教训：源码文本断言不只是"覆盖弱"，它会把"功能根本没生效"固化成绿灯。**
5. **我自己的一次误报（必须记档）**：某轮取证报告称 `compactSessionLog` 的 `.tmp` + rename 在真机上必然失败
   （理由：Rust `write_file` 自己会用 `.<name>.codem-tmp` 中转，导致 `rename_file` 的源不存在）。
   **我核对了实现，这条是错的**：`write_file("X.jsonl.tmp", …)` 的中转文件被 rename 成 **`X.jsonl.tmp` 本身**，
   所以源是存在的，`rename_file` 会成功；而 `session-jsonl.ts:478` 又用 `e.name.endsWith(".jsonl")` 过滤会话文件，
   `.jsonl.tmp` 也不会被当成会话读进来。**结论：这条不成立，未列入 §2。**
6. **我自己的一次误判（D5，见 §2 的完整更正）**：我把「守卫看起来是对的」当成了「守卫会通过」。
   原描述是"每轮把时间戳写进 system ⇒ 摧毁前缀缓存"，实测是**那段代码从未执行**（功能失效，不是缓存失效）。
   **两次都是同一个错误形状：中间那一步（守卫是否成立 / 临时文件叫什么名）没有走到底。**

---

## §6 实施顺序与结果

**判据总数：13 个新测试文件 / 约 60 条行为用例**（`src/test/dsh-*.test.ts`），**每条都做了「变异 ⇒ 变红 ⇒ 还原 ⇒ 变绿」**。

| 序 | 项 | 状态 | 判据文件 | 变异自证（实际执行） |
|---|---|---|---|---|
| 1 | D1 失败不当成功 | ✅ | `dsh-d1-llm-failure-not-completed.test.ts`（4 条） | ①`if (false && lastIterationError !== null)` ⇒ `expected 'stop' to be 'error'`；②去掉逐轮清标志 ⇒ 第 2 轮出现跨轮泄漏（`expected 'error' to be 'stop'`） |
| 2 | D2 abort 停止派发 | ✅ | `dsh-d2-abort-stops-dispatch.test.ts` | 去掉 `abortAll()` 里的置位 ⇒ `实际执行了: file-1,file-2,file-3: expected 3 to be less than or equal to 1`；**并额外证明了 brief 建议的复位点（`execute()` 入口）会让这个修复失效** ⇒ 复位改到回合边界 `run()` 的 `clearAbort()` |
| 3 | D3 取消不伪装完成 | ✅ | `dsh-d3-abort-not-completed.test.ts`（2 条） | ①provider 兜底恒 `stop` ⇒ `expected 'stop' to be 'aborted'`；②`if (false && lastFinishReason === "aborted")` ⇒ 同上 |
| 4 | D4 超时真 abort | ✅ | `dsh-d4-timeout-aborts.test.ts` | 去掉 `controller?.abort()` ⇒ 工具观察不到 abort（`expected false to be true`） |
| 5 | D5 易变文本出前缀（**描述已更正**） | ✅ | `dsh-d5-prefix-cache-stability.test.ts`（5 条） | ①丢掉尾部消息 ⇒ 「时间上下文必须真的注入…」变红（防"干脆不注入"的假修）；②把未节流时间上下文追加回 system ⇒ 「两轮 system 必须逐字节相同」变红 |
| 6 | D6 token 计量 | ✅ | `dsh-d6-usage-accounting.test.ts`（3 条） | ①回到"最后一次 usage 覆盖" ⇒ `expected 1000 to be 3000`（**这就是那个 15× 低估的字面演示**）；②`recordUsage` 放在循环之后 ⇒ `实际 2 条: expected 2 to be 1`；③`success` 恒 true ⇒ `expected true to be false`；④忽略 `type:"error"` ⇒ 变红 |
| 7 | D7 usage 缓存桶 | ✅ | `dsh-d7-usage-cache-buckets.test.ts`（5 条） | ①恢复 30% 编造 ⇒ `expected 300 to be undefined`；②让 normalize 强制补 0 ⇒ `expected true to be false` |
| 8 | D8 edit 二义拒绝 | ✅ | `dsh-d8-edit-ambiguity.test.ts`（7 条） | `if (ambiguous)` → `&& false` ⇒ `expected 'completed' to be 'error'`（3 条红）；磁盘断言也证明变异真的写了盘 |
| 9 | D9 multi_edit 部分失败 | ✅ | `dsh-d9-multi-edit-partial-failure.test.ts`（3 条） | 去掉 `isError` ⇒ `expected 'completed' to be 'error'` |
| 10 | D10 write 未执行 | ✅ | `dsh-d10-write-not-executed-is-error.test.ts`（3 条） | 去掉 `isError` ⇒ `expected 'completed' to be 'error'` |
| 10b | D10b 同类其余实例（8 处路径） | ✅ | `dsh-d10b-tool-failure-class.test.ts`（13 条） | 3 组变异，每组红点与所修路径 1:1 对应（4 cordis / 2 read_attachment / 2 zvec） |
| 11 | D11 更新保字段 | ✅ | `dsh-d11-update-message-preserves-fields.test.ts`（4 条） | ①旧优先级 ⇒ 附件 `expected undefined to deeply equal [...]`；②**brief 里给的字面量反转 ⇒ `metadata` 断言变红**（证明那个修法不充分，实施者改成"索引按字段为主 + 镜像补缺"）；③serializer 不写附件 ⇒ 红；④镜像退回手挑字段 ⇒ 红 |
| 12 | D12 格式版本校验 | ✅ | `dsh-d12-session-log-version.test.ts`（5 条） | 去掉版本校验 ⇒ ①`expected {resolved} to be an instance of Error`；②`expected 1 to be +0`（**真的把未来格式读成了 1 条消息 —— 静默降级的实证**）；③`promise resolved instead of rejecting` |
| 13 | D13 引导不静默丢弃 | ⬜ **未做** | — | 本轮未实施（见 §3 的口径：它的可达窗口窄，且判据形态取决于最终选哪种修法）。**不算已完成。** |

**未做但已取证**：见 §3。**另有两处本轮发现、已记入 §3 的加重项**：`planContext` 才是真正活着的那个前缀变动源；
以及 `append_file` 不检查尾换行导致"半截行裹住下一条合法记录、并在压缩时被永久删除"。

**新增的工程产物**：`tools/eval/paired-report.mjs`（尺子，方法学取自 Pi 的 `report.ts`/`plan.ts`）+
`paired-report.selftest.mjs`（19 条）+ `paired-report.mutation.mjs`（**5/5 咬住**），并已挂进 `npm run audit` 链（`eval:selftest`），
所以尺子本身也被门禁保护。

---

## §6b 发版与装机验证结果（v1.16.222）

**门禁（全部 exit 0）**：

| 门禁 | 结果 | 与基线对比 |
|---|---|---|
| `npx vitest run` | **469 套件 / 6852 通过 / 16 跳过**，exit 0 | 基线 451 / 6770 / 16；**+18 套件 / +82 用例，0 失败** |
| `cargo test --lib` | **130 通过 / 0 失败 / 2 ignored**，exit 0 | 与基线**完全一致** |
| `npm run audit` | exit 0（含可达性：生产文件 840 / 可达 801 / 不可达 39 **全在白名单且无过期条目**） | 基线 exit 0 |
| `verify-update-manifest.mjs 1.16.222`（本地 5 项） | **5/5 通过** | — |

**注意**：审计的**可达性扫描用 `git ls-files`**（交接单 §4.10）——
所以本轮是在 `git add` **之后**才跑的，否则新文件根本不在扫描集合里，那条"通过"没有意义。

**发版**：`bump 1.16.221 → 1.16.222`（package.json / tauri.conf.json / Cargo.toml / Cargo.lock 四处）→
`tauri:build`（MSI 44.64 MB + NSIS 41.02 MB + 两个 `.sig`）→ `make-latest-json` → 本地 5 项验证通过 →
提交 `190bb62`（55 个文件，工作区干净）。**未 push、未打 tag、未 `gh release create`**（见下"未做"）。

**装机验证**（NSIS `/S` 静默安装 → 注册表 → CDP 探针）：

| 判据 | 结果 |
|---|---|
| V1 注册表 `DisplayVersion` | ✅ `1.16.222` |
| V2 界面就绪（设置按钮在 = 前置条件成立） | ✅ |
| V3 界面显示的版本文本 | ✅ `Codem (mimo-gui) v1.16.222`（在「帮助」页） |
| V4 设置面板正常渲染（侧栏 22 项） | ✅ |
| V5 渲染进程没有未捕获异常 | ✅ |

**装机验证能验什么、不能验什么**（必须说清，否则会被读成"那些修复在真机上生效了"）：
- **能验**：装出来的产物对不对（版本、能否启动、界面不崩）。
- **不能验**：D1–D12 / P-1 / P-2 这些**行为**修复 —— 它们全在引擎/工具/存储内部，界面没有对应物；
  要验就得真跑一轮 LLM 任务（需要 key 与额度）。**它们由 `src/test/dsh-*.test.ts`、`pi-p1/p2/p2b-*.test.ts` 的
  行为判据 + 变异自证覆盖。所以「装机 5/5 通过」不等于「那些修复在真机上生效」。**

**我自己在这一步犯的错（记档）**：第一版探针在**默认设置页**上读 `body.innerText` 找版本号 ⇒ 报红。
原因是版本号**只在那一个设置页被挂载时才在 DOM 里**（React 条件渲染），默认页上根本没有这段文本。
**是判据写错了，不是应用的问题** —— 与交接单 §5.3「断言『不存在』之前必须先建立前置条件」同一条教训，
也是本轮我第三次踩到"中间那一步没走到底"。

**未做（明确声明，不是"已完成"）**：
- **未 push、未打 tag、未创建 GitHub Release、未上传产物、未跑 `--remote` 的 7 项验证**。
  这些都是对外且不可逆的动作，用户的口径是「bump + build + 装机 + 真机验证」，所以停在这一步。**要发出去请明确说一声。**
- 因此 `latest.json` 目前只通过**本地** 5 项；远端 7 项要等 `gh release upload` 之后才有意义。

---

## §7 需要用户决定的（先不改）

1. **上下文配置面板那两个滑杆**（压缩阈值 / 上下文窗口）：**桥接到真实循环**，还是**从界面上移除**？
   当前状态最糟 —— 看起来生效、实际不生效。我倾向**桥接**（用户能感知的收益是"我调了它就真的按我的意思压缩"），
   但移除更简单、更符合"不要让用户面对看不懂的机制"。
2. **`fs-observation-policy`（读后写 / 版本比对）要不要做**？不做则"模型基于旧快照改文件"没有冲突提示；
   做则要给工具层加一层 per-session 观察表。见 §3。
3. **耐久性那批**（`append_file` 加 fsync、torn-tail 截断修复、工具副作用前 flush 闸门）要不要单独立项？
   它们不产生新功能，但决定"崩溃时用户丢多少"。见 §3。
