# DSH / Pi 有、我们没有的功能与机制 —— 建议清单（2026-10-02）

> **交接单 §6 任务 4 明确要求：先不改，先反馈给用户判断。** 本文件**不含任何代码改动**，只有建议。
> 每条写齐六点：**它是什么 / 它解决什么问题 / 它那边的证据 / 我们复刻的代价 / 不做的后果 / 我的建议**。
>
> **用户口径（原话）**：**「不要太复杂、不要让用户面对看不懂的机制。」**
> 所以本文每条都把 **①用户能感知到的收益** 与 **②我们内部的复杂度** 分开写；
> **「它很好但我们不该做」是合法且常常正确的结论。**
>
> **证据口径**：所有 `file:line` 都是本轮的**真源码**。DSH 侧是 `.deepseek-harness-ref`（639ed01 = release dsh-0.2.0-rc.2）的 TS 源；
> Pi 侧是 `.preview-shot\_pi-repo`（`9b3c19d` = v1.0.0-10）。本文件里每条证据我都**亲自打开核对过**，
> 凡是我没核到的地方都写明"未找到证据"，不用推测填空。

---

## 建议摘要（先给判断，细节在后面）

| # | 机制 | 来源 | 建议 | 一句话理由 |
|---|---|---|---|---|
| 1 | 持久性闸门：模型请求前 / 工具派发前 flush，失败即阻断 | DSH | **做**（下一轮，单独立项） | 决定"崩溃时用户丢多少"，且**不产生新界面** |
| 2 | 读后写 / 版本比对（`FS_NOT_OBSERVED`、`replaceIfVersion`） | DSH | **做**（下一轮，与 edit 那条同批） | 防"基于旧快照改文件"的静默覆盖 |
| 3 | turn/step 生命周期事件（`turn/end.reason` 是持久事实） | DSH | **做**（便宜） | 是 #1 与"失败诊断"的共同前置 |
| 4 | 工具声明硬预算 + 按需查找（Codemode 的**效果**那一半） | Pi | **做**（先做预算，后做按需） | 每轮都在为每个工具的 schema 付钱 |
| 5 | 跨进程写锁 + 符号链接安全 + Windows rename 重试 | DSH | **观察** | 只有多进程真的并发写同一文件时才有意义 |
| 6 | 上下文压力用 provider 实测 token 做分子 + O(1) 位移投影 | DSH | **做**（与压缩那条同批） | 让"该不该压缩"有实测锚点，而不是纯启发式 |
| 7 | 压缩切点的**工具配对不变式** | DSH | **做**（便宜且防 provider 400） | 防"工具调用留着、结果被压掉" |
| 8 | 成对评测 + **成对样本不足就拒绝给结论** | Pi | **做**（开发者侧） | 把用户那条验收标准变成可判真假 |
| 9 | 缓存浪费的**美元口径事后提示** | Pi | **做**（一条信息面） | 用户能懂"我发了会儿呆，钱没了" |
| 10 | `context_edit`：只改**模型上下文**的追加式记录 | Pi | **观察**（下轮评估） | 让"重试一次"不必对用户撒谎说没发生过 |
| 11 | 系统提示/工具装载记为**可重放的段级 diff** | Pi | **观察** | 诊断价值真实，但只在排查时用得上 |
| 12 | MCP OAuth 2.1 + 资源（resources） | Pi / DSH | **观察** | 只在用户真要连需要登录的 MCP 服务时才值 |
| 13 | prompt cache **自动保温** | Pi | **不做** | 在用户空闲时**自主花用户的钱**，收益用户不可见 |
| 14 | 暴露词表（`direct/model-only/codemode/deferred/hidden`）与脚本 API | Pi | **不做** | 正是"用户看不懂的机制"，要效果不要词汇表 |
| 15 | session tree 重写 + `durable`/`protocol` 研究栈 | Pi | **不做** | 我们的存储已更复杂，且它自己标着 Experimental |
| 16 | 加载 TS 扩展（jiti）且与主进程**同权限** | Pi | **不做** | 拿安全换灵活，与我们的权限模型冲突 |

---

## 1. 持久性闸门：模型请求前 / 工具派发前 flush，失败即阻断

- **它是什么（一句话）**：在"要花用户的钱了"和"要动用户的文件了"这两个动作**之前**，先把会话落盘；
  落盘失败就不许往下走。
- **它解决什么问题（不解决会怎样）**：现在可能出现 **"用户的问题丢了，但工作区已经改了"** ——
  崩溃窗口里用户消息还在 IPC 排队，工具已经把文件写完了；重启后日志和索引都没有这条消息，改动却真实存在，**无法归因**。
- **它那边的证据**：
  - DSH 在**模型请求前**：`.deepseek-harness-ref/packages/session/session-checkpoint-policy/src/index.ts:35` — `await ctx.sessions.flush(session)`
  - DSH 在**工具派发前**，且失败/已中止就**不派发**：同文件 `:70-73` —
    `ctx.on('tools/execute', async (exec, next) => { ... await ctx.sessions.flush(exec.agent.session); if (exec.signal.aborted) return abortedBeforeDispatchResult()`
  - flush 失败**不许静默**：`@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:384-397` — `throw new AggregateError(errors, \`${this.name} flush failed\`)`
  - 我方现状：`src/core/storage/session-jsonl.ts:161-165` 有 `flushSessionLogWrites()`，但**调用点只有** `App.tsx:346/2285/2470`、`session-log-bridge.ts:169`、`message.ts:293-294` ——**没有一处在"模型请求前 / 工具派发前"**；
    且 `src-tauri/src/lib.rs:768-780` 的 `append_file` **没有 `fsync`**（同一个文件里 `write_file` 的 `:732` 有）
- **我们复刻的代价**：**中**。① Rust 侧 `append_file` 加 `file.sync_all()`（一行，与同文件 `:732` 对称）；
  ② 在 `executor.ts` 的用户消息落库之后、`engine.process` 之前插一个 `await flushSessionLogWrites()`；
  ③ 在破坏性工具派发前也插一个，并让失败走 `reportPersistFailure` 在界面上可辨。
  **前置依赖：本条与第 3 条（turn/step 事件）最好同批做**，否则"这一轮没落盘"说不清是哪一轮。
- **不做的后果**：崩溃/强退/断电时**用户的提问会丢，而文件已经改了**。真机已有痕迹：
  `codem-runtime-2026-10-02.log` 里 `unclean_exit=true` / `previous run did not exit cleanly — session may not be saved`。
- **建议**：**做**，下一轮单独立项。
  - **用户能感知的收益**：崩溃后重开，"我问过的和它做过的"能对上号；不会再出现"我没说过这个，但文件被改了"。
  - **内部复杂度**：中，且**零新界面** —— 全部是时序上的加固。**符合用户口径。**

## 2. 读后写 / 版本比对（`FS_NOT_OBSERVED`、`replaceIfVersion`）

- **它是什么（一句话）**：模型要改一个文件，得先**读过**它；而且写下去的时候要确认"我读到的版本还是现在的版本"。
- **它解决什么问题**：现在 `edit` **不要求先读**（只要 `oldString` 命中就写），写之前也不和任何"观察到的版本"比对。
  用户在自己的编辑器里改了同一个文件时，后写者**静默覆盖**先写者，**没有任何冲突提示**。
- **它那边的证据**：`.deepseek-harness-ref/packages/fs/fs-observation-policy/src/index.ts`
  - `:62-70` — `/** Decide the write intent: unseen or confirmed absent ⇒ \`createIfAbsent\`; confirmed present ⇒ \`replaceIfVersion\` at the observed version. */`
    `? { kind: 'replaceIfVersion', version: prior.version } : { kind: 'createIfAbsent' }`
  - `:78-82` — `editIntent(...)` 里 `throw new FsError(\`edit requires reading "${target.displayPath}" first\`, 'FS_NOT_OBSERVED')`
  - `:122` — 挂到 `ctx.on('fs/edit-intent', ...)`，即这是**管道化**的、不是各工具自己记得
  - 我方现状：`src/core/provider/fs-observation-policy-provider.ts` **全文 16 行**，只注册了
    `{ ignoreDotFiles, ignorePatterns, debounceMs, maxWatchers }` —— 是**文件监听器的防抖配置**，
    **没有任何写入前置条件**。名字叫 observation-policy，能力却对不上，容易让人以为已有保护。
- **我们复刻的代价**：**中**。工具层维护 per-session `Map<absPath, { version | contentHash, kind }>`：
  `read` 成功时写入；`write` 走 `createIfAbsent` / `replaceIfVersion`；`edit` 要求存在观察记录。
  需要定"版本"用什么表示（内容哈希比 mtime 稳）。
- **不做的后果**：并发/交错编辑下**丢失更新**的窗口一直存在，且工具无法区分
  "模型依据的是旧快照"与"模型依据的是刚读到的内容"。
- **建议**：**做**，下一轮，**与 `docs/DSH-ALIGNMENT-FIX-PLAN.md` 的 D8（edit 二义拒绝）同批**。
  单独做会和 D8/D9/D10 的语义打架（都是"工具写盘前的判定"）。
  - **用户能感知的收益**：不会再有"我在编辑器里改的东西被它盖掉了"。
  - **内部复杂度**：中，**零新界面**。

## 3. turn/step 生命周期事件（`turn/end.reason` 是持久事实）

- **它是什么（一句话）**：把"这一回合是怎么结束的"（正常完成 / 出错 / 被用户中止）**写进日志**，而不是只留在内存里。
- **它解决什么问题**：现在回合的终态只是一个内存对象 `LoopResult`。
  所以"这一轮被打断过"这件事在日志里**不存在**，事后无法审计、无法统计、也无法据此做 #1 的持久化闸门。
- **它那边的证据**：`.deepseek-harness-ref/packages/core/agent-loop/src/agent.ts`
  - `:370` — `turnEnds = { kind: 'aborted', reason: cause }`
  - `:376` — `kind: 'error',`（错误是显式终态）
  - `:385` — `this.session.append('turn/end', { turn, reason: turnEnds! })`（**durable**）
  - 我方现状：`src/core/storage/event-types.ts:65` 里 `turn_start`/`turn_end` **只有类型声明，没有任何写入者**
- **我们复刻的代价**：**低**。在回合终态路径（已存在的 `end` 产出点）追加一次 `eventLog.append(sessionId, "turn_end", {...})`，
  带上 `reason` / `error` / 是否中断。类型已声明，无需扩展。
- **不做的后果**：**"失败被记成完成"这类缺陷无法在事后被发现**（详见 DSH 计划的 D1）；
  也无法回答"这个会话里有多少轮是被中止的"。
- **建议**：**做**，与 #1 同批。**用户能感知的收益**：几乎没有直接的，但它是
  "任务通过率"这个验收指标能被**事后统计**的前提。**内部复杂度**：低。

## 4. 工具声明硬预算 + 按需查找（Codemode 的**效果**那一半）

- **它是什么（一句话）**：每个工具的**名字 + 说明 + 参数 schema** 都要在**每一次**请求里重新付费；
  所以只把一部分工具的说明直接给模型，其余让它在需要时**自己查**。
- **它解决什么问题**：接了几个 MCP 服务之后，每轮请求的提示里可能先花掉几万 token 在"工具目录"上，
  还没开始干活。用户只觉得"Codem 好贵"，看不出原因。
- **它那边的证据**：`.preview-shot\_pi-repo/packages/coding-agent/src/extensions/codemode/tool.ts`
  - `:153-154` — `/** Default for {@link CodemodeDescriptionOptions.inlineBudget}, in estimated tokens. */` / `export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;`
  - `:256` — `const shown = selectCatalog(ordered, options.inlineBudget);`（按预算裁声明）
  - `packages/coding-agent/src/core/mcp-servers.ts:25` — `/** Default: \`codemode\`. */`（**MCP 工具默认不声明给模型**）
  - 未声明的工具用 BM25 的 `searchTools()` 在运行时找（`extensions/tool-search/tool.ts`）
- **我们复刻的代价**：**分两半**。
  - **便宜的那半（建议先做）**：给工具声明设**硬预算**，按命名空间分组、按"最便宜的优先、轮转"打包。
    不需要新工具、不需要新运行时，只改提示组装。
  - **贵的那半（后做）**：`deferred` 暴露 + 按需声明（`tool_search` 我们**已经有** `tool_search` 工具，
    见 `tool-result-status.ts:33` 的白名单）—— 需要工具注册表带暴露元数据，且**装载变化必须落进记录**，
    否则 resume/fork 之后"当时到底声明了哪些工具"就说不清（Pi 用 `declareToolChanges` 解决）。
- **不做的后果**：提示成本随每接一个 MCP 服务**单调且不可见地**上涨。
- **建议**：**做，但先只做便宜的那半**。
  - **用户能感知的收益**：同样的活，每轮请求更便宜 —— 直接落在"token 消耗不差于 dsh"上。
  - **内部复杂度**：便宜那半低。**贵的那半我没建议本轮做**。
  - **明确不抄**：五值暴露词表 `direct / model-only / codemode / deferred / hidden`、`store()`/`load()`、
    `models.classify()`、`describeNamespace()`、207 行的脚本 API。**那是 Pi 内部最聪明的部分，也最违反用户口径。**

## 5. 跨进程写锁 + 符号链接安全 + Windows rename 重试

- **它是什么（一句话）**：多个人/多个进程同时改同一个文件时，排个队；并且别被符号链接骗着写到别处去。
- **它解决什么问题**：并发写同一个文件时，两个写入方可能各自基于陈旧状态互相覆盖。
- **它那边的证据**：`.deepseek-harness-ref/packages/util/atomic-write`
  - `README.md:12` — 「Its **writer lock serializes read-modify-write cycles across processes** so concurrent writers cannot overwrite one another with stale state.」
  - `src/index.ts:86-89` — `const temp = \`${filename}.${randomBytes(6).toString('hex')}.tmp\`` … `await writeFile(temp, content, { mode: options.mode, flag: 'wx' })` … `await renameAtomicTemp(temp, filename)`
  - `src/index.ts:235` — `export async function withFileLock<T>(...)`
  - 测试里还专门覆盖了 Windows rename 干扰重试与"符号链接目标替换而不穿透到 referent"（`tests/atomic-write.spec.ts:136-216`）
- **⚠️ 必须说清的一条**：**DSH 的 atomic-write 在耐久性上比我们弱。** 它自己的 README `:125` 写着
  「**Atomic, not durable** — no `fsync` of the file or its directory, so after a crash the rename may be observed unwound」，
  `:136` 还把"带 fsync 的持久性替换"列为**未实现**。
  我们的 `src-tauri/src/lib.rs:732` 的 `write_file` **是** `file.sync_all()` 的。
  **所以这条不要照抄结论"DSH 比我方强"** —— 我们缺的是**写锁与符号链接安全**，不是 fsync。
- **我们复刻的代价**：**中**。写锁要跨进程（我们桌面侧有 Rust 与 WebView 两侧），
  还要处理"持锁进程已退出"的接管（DSH 的实现里有 `takeOverExitedLock`，`src/index.ts:149`）。
- **不做的后果**：**只有真的出现"两个写入方并发改同一文件"时才有后果**。单窗口单人使用时几乎无感。
- **建议**：**观察**。目前没有证据表明用户实际遇到并发写冲突（我们的 `append_file` 走的是追加，
  冲突面比"整文件重写"小）。**先把 #1 的 fsync 与闸门做了**，它覆盖的是更常见的崩溃场景。
  - **用户能感知的收益**：低（多数场景无感）。
  - **内部复杂度**：中高。**按"不要让用户面对看不懂的机制"的口径，这条的性价比目前最低。**

## 6. 上下文压力用 provider **实测 token** 做分子 + O(1) 位移投影

- **它是什么（一句话）**：判断"该不该压缩上下文"时，用**服务端真实报回来的 token 数**当尺子，
  而不是本地按字符数猜。
- **它解决什么问题**：我们现在的压力估计是**纯本地启发式**，且无基线时**连系统提示都不计入分子**；
  同时"触发压缩"（占窗口 80%）与"发送预算"（窗口 90%）是**两套口径**，中间只剩 10% 给系统提示 + 工具 schema + 输出预留。
  方向不确定地双向出错：低估 ⇒ 请求体超窗口被 provider 拒（白烧一次），首次请求路径则可能永不触发压缩。
- **它那边的证据**：`.deepseek-harness-ref/packages/llm/token-meter/src/usage-projection.ts`
  - `:78-79` — `const pressureFrom = (usage: TokenUsage): number => usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)`
  - `:194` — `const pressureTokens = pressureFrom(usage)`（用实测值做压力）
  - `:215` — `: { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) }`（按 surface 位移做 O(1) 投影，不必重新数一遍）
  - 我方现状：`src/core/llm/token-tracker.ts:186-206`（无基线分支只累加消息正文，不含 system；有基线时上限被钉在 1.5× 启发式值）
- **我们复刻的代价**：**中**。需要把"压力分子"的口径统一到**实测 + 位移**，
  并把触发阈值与发送预算**合并成同一个口径**（不能一边 80% 一边 90%）。
- **不做的后果**：压缩时机由启发式误差决定 —— 要么白烧被拒的请求，要么长会话首轮直接撞墙。
- **建议**：**做**，与压缩相关的改动同批。
  - **用户能感知的收益**：更少"上下文装不下"的报错，更少无谓的压缩（压缩会丢信息、会让模型重复劳动）。
  - **内部复杂度**：中，零新界面。

## 7. 压缩切点的**工具配对不变式**

- **它是什么（一句话）**：压缩上下文时，切点绝不允许落在"工具调用"和"它的结果"之间。
- **它解决什么问题**：如果把一个 `tool_call` 留着、把它的 `tool_result` 压掉（或反之），
  请求体里就会出现**悬空的工具调用 id** —— 多数 provider 会直接返回 400，用户看到的是"莫名其妙的报错 + 重试"。
- **它那边的证据**：`.deepseek-harness-ref/packages/compaction/compaction-basic/src/region.ts`
  - `:14-15` — `import { toolPairingBalancedAfter, toolPairingBalancedBefore } from ...`
  - `:145` — `if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break`
  - `:349` / `:353` — `if (!toolPairingBalancedBefore(...))` / `if (!toolPairingBalancedAfter(...))`（切点两侧都要检查）
  - 我方现状：`src/core/llm/compaction-budget.ts` 是**预算启发式**（`planCompactionKeep` / `alignKeepToRoundBoundary` / `selectMessagesByPriority`），
    是否保证工具配对**我没有证据说它不保证，也没有证据说它保证** —— 这一条应当先写成判据再改。
- **我们复刻的代价**：**低**。在切点选择处加一个"配对平衡"检查（两行 + 一次遍历）。
- **不做的后果**：压缩触发时的 400 报错，且原因极难定位（表象是"网络/服务端问题"）。
- **建议**：**做**（便宜且直接防一类难查故障）。**但第一步是写判据**：
  构造一个"工具调用与其结果跨越切点"的输入，断言选出的保留区间**不会**把这一对拆开。
  - **用户能感知的收益**：压缩不再引发无解报错。
  - **内部复杂度**：低。

## 8. 成对评测 + **成对样本不足就拒绝给结论**

- **它是什么（一句话）**：同一批任务、同一个模型，两边各跑一遍，
  只报"**成对**的差值"（token / 工具调用次数 / 耗时 / 估算成本 / 通过率），
  而且**只要有一对缺数据，就不给头部结论**。
- **它解决什么问题**：用户口径「同样用 DS 模型，水平和 token 消耗都不差于 dsh」**目前无法证伪**。
- **它那边的证据**：`.preview-shot\_pi-repo/packages/evals/src/report.ts`
  - `:22` — `inputTokens?: number;`（`EvalMetrics` 的四个 token 桶之一）
  - `:37` / `:40` — `eligiblePairs: number;` / `meanDelta: number | null;`（成对结构）
  - `:249` — `function resolvePair(group: PairGroup): { pair?: Pair; blocked?: BlockedPair }`
  - `:379` — `const publishHeadline = blockedPairCount === 0 && pairs.length > 0;`（**有阻塞就不发布头部通过率**）
  - `:445` — `"     Pass rate  withheld because pairs are blocked"`
  - `:474-478` — 逐条打印被阻塞的对及原因
  - ⚠️ **同时要说清**：`packages/evals` **本身不是代码质量 benchmark** —— 它只做"文档 lift"对照实验；
    仓库里**没有任何 SWE-bench 式任务集**，也**没有任何"Pi 更省 token"的实测数字**（我未找到证据）。
    我们要的是它的**方法学**，不是它的用例。
- **我们复刻的代价**：**中，且全部在开发者侧**。`report.ts`/`plan.ts` 的消费边界不依赖 Pi；
  需要写一个 Codem 适配器返回同样形状的 `usage`/`timings`/`events`，并且臂要能**无头驱动**（我们的引擎在桌面进程里，这是主要工作量）。
  **前置依赖：`docs/DSH-ALIGNMENT-FIX-PLAN.md` 的 D6/D7**（计量先要准，否则尺子本身在骗人）。
- **不做的后果**：token/质量的主张永远没有数字支撑，每一次"压缩改好了"都无法验证。
- **建议**：**做**。**用户能感知的收益**：零（纯内部工具）；
  **但它是用户那条验收标准唯一现成的落地方法**，而且**用户侧零可见面**，完全符合"不要太复杂"。
  见 `docs/DSH-ALIGNMENT-FIX-PLAN.md` §4。

## 9. 缓存浪费的**美元口径事后提示**

- **它是什么（一句话）**：告诉用户"这几轮因为缓存过期，本来能半价的那部分按全价重算了，约多花了多少钱"。
- **它解决什么问题**：长思考或离开一会儿之后，整段提示按全价重算，用户只在账单上感到"这次怎么这么贵"。
- **它那边的证据**：`.preview-shot\_pi-repo/packages/coding-agent/src/core/cache-stats.ts`
  - `:11` — `const NOISE_FLOOR_TOKENS = 1024;`（噪声地板，避免误报）
  - `:70-71` — `const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;` / `if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;`
  - `:85-86` — `missedTokens,` / `missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),`（折算成钱）
- **我们复刻的代价**：**低**。是对我们已经记录的 usage 做一次算术 + 一行信息面。
  （**注意**：它依赖 D7 —— 现在 `cacheHitTokens` 有一条"凭空按 30% 猜"的逻辑，必须先删掉，否则这个提示算的是假数。）
- **不做的后果**：用户不知道"发呆也花钱"，我们自己也诊断不了。
- **建议**：**做**（只做提示）。
  - **用户能感知的收益**：高 —— 这是**用户唯一能自己看懂的成本信息**。
  - **内部复杂度**：低。
  - **明确不做**：Pi 的**自动保温**（见 #13）。

## 10. `context_edit`：只改**模型上下文**的追加式记录

- **它是什么（一句话）**：可以"让某条历史消息不再出现在模型的上下文里"，但**原始历史、界面显示、导出、账单都不动**，
  而且这个编辑是**相对分支**的 —— 退回到编辑之前，原文就回来了。
- **它解决什么问题**：一次失败的尝试（比如撞到输出上限的那次）想重来，现在只能靠删历史或用别的手段腾空间，
  而"删历史"对用户就是在**撒谎说那件事没发生过**。有了它就能"重试一次"而不篡改历史。
- **它那边的证据**：`.preview-shot\_pi-repo/packages/coding-agent/docs/session-format.md`
  - `:144` — `{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9",...,"targetId":"c3d4e5f6","replacement":null}`
  - `:235` — 「`buildSessionProjection()` then applies the latest `context_edit` for each selected target. ... **The raw selected entries are not modified.**」
- **我们复刻的代价**：**中**。需要一份"上下文投影"层（把日志 → 模型可见消息的过程做成可施加编辑的投影），
  并且编辑要能随分支解析。我们已有 `event-projection.ts` / `session-projection` 相关的底子，但要加"编辑"这一层语义。
- **不做的后果**：**诚实性**上的缺口 —— 要么不重试，要么靠删历史（用户看到的东西和他实际经历的不一致）。
- **建议**：**观察**，下一轮评估。它的收益用户在**道理上**能理解（"它重试了一次，但没抹掉走错的那一步"），
  但**界面上没有对应物**，用户不会主动感知。**在没有明确的"重试一次"需求之前不做。**

## 11. 系统提示 / 工具装载记为**可重放的段级 diff**

- **它是什么（一句话）**：把系统提示和"这一轮声明了哪些工具"本身也当成记录写进会话，
  之后的变化只记**差异**（哪个段被换了、哪个工具被加了/去掉了），重放即可还原当时的提示。
- **它解决什么问题**：我们的系统提示是**每一轮从头组装**的，所以答不了
  "第 40 轮它实际收到的提示到底是什么" —— 这是排查"模型为什么不按规则做"时最想知道的第一个问题。
- **它那边的证据**：`.preview-shot\_pi-repo/packages/coding-agent/docs/session-format.md:80` —
  「System messages carry the prompt and tool loadout: the first request of a session persists one with every prompt section and tool declaration, and later changes persist as system messages that patch `sections` by name (`null` removes one) and list `toolsAdded`/`toolsRemoved`. Replaying them in order yields the current prompt and tools; **there is no separate prompt state entry**.」（示例见 `:84`）
- **我们复刻的代价**：**中低**。不需要重做存储，只需要在组装提示时把**段级差异**追加成记录，
  并提供一个"重放到第 N 轮"的只读函数（给诊断用）。
- **不做的后果**：诊断能力缺口 —— 每次怀疑"提示里到底写了什么"都只能靠读代码推断。
- **建议**：**观察**。诊断价值真实，但只在排查时用得上；
  而且**本轮 D5 正在改提示组装**（把易变内容移出前缀），等那个稳定下来再做更省事。

## 12. MCP OAuth 2.1 + 资源（resources）

- **它是什么（一句话）**：连需要登录的 MCP 服务时不用手工贴 token；并且能读 MCP 的"资源"，而不只是调它的工具。
- **它解决什么问题**：需要 OAuth 的远程 MCP 服务现在接不上；MCP 服务暴露的资源（文档、数据集）现在也读不到。
- **它那边的证据**：
  - Pi：`packages/coding-agent/src/extensions/mcp/resources.ts:34-36`（`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`）；
    OAuth 实现在 `packages/mcp/src/oauth/`（`flow.ts` 17.8 KB、`discovery.ts`、`callback.ts`）
  - DSH：有独立的 `@deepseek-ai/dsh-mcp-resources` 包（`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-mcp-resources`）
  - 我方现状：`src/core/mcp/mcp.ts` 已有 stdio 与 HTTP/SSE 传输、bearer/自定义头、`initialize` 握手校验、`tools/list` 失败上报；
    CodeGraph 自动检测（`:500-542`）。**没有 OAuth，也没有 resources 工具。**
- **我们复刻的代价**：**中**（OAuth 流程 + 令牌刷新 + 回环回调；resources 只要加三个工具）。
- **不做的后果**：**只有在用户实际要连需要 OAuth 的 MCP 服务时才有后果。**
- **建议**：**观察**。先确认用户要连的 MCP 服务里有没有需要 OAuth 的；
  如果只有本地 stdio 服务，这个成本换不来可感知收益。**resources 那三个工具可以先做**（便宜、清晰）。
  - **我们有而 Pi 没有的**：**权限层**（`src/core/permission/`）—— Pi 的 README 明确说它没有内置权限系统。**这一点不能拿去交换。**

## 13. prompt cache **自动保温** —— 建议**不做**

- **它是什么（一句话）**：在你空闲的时候，它用 `maxTokens: 1` **悄悄重发一次整个上次请求**，
  好让服务端的缓存不过期。
- **它那边的证据**：`packages/coding-agent/src/core/cache-warmer.ts`
  - `:398` — `action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop"`
  - `:20` — `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05`（门槛是期望节省 5 美分）
  - `:21-26` — 空闲继续概率**硬编码 0.15**
  - `:29-32` — TTL 的 90% 时刷新
  - `:284-298` / `:357-361` — 错过截止就 abort，**免得晚刷新反而变成一次全价写入**
  - 默认**开启**：`settings-manager.ts:1023-1026`
- **不做的后果**：短暂空闲后，用户可能多付一次全价前缀。
- **建议**：**不做**。
  - **用户能感知的收益**：**低** —— 用户看不见它，只会在账单上偶发地少一点。
  - **内部复杂度**：**高** —— 一个定时器 + "这份记录还是上次请求的前缀吗"的判定 + 花费闸门 + 开关；
    作者自己把继续概率硬编码成常数（注释说 per-session 估计并不比常数好），还要加安全视界与截止 abort。
  - **理由**：它**在用户空闲时自主花用户的钱**。**改为做事后提示（见 #9）** —— 用户看得懂、我们不自作主张。

## 14. 暴露词表与脚本 API —— 建议**不做**

- **它是什么**：`direct / model-only / codemode / deferred / hidden` 五个暴露值 + `store()`/`load()`/
  `models.classify()`/`models.generateImages()`/`describeNamespace()` 等脚本 API + 207 行的 codemode 文档。
- **它那边的证据**：`packages/coding-agent/docs/extensions.md:154-160`；`extensions/codemode/tool.ts:154`（预算）、`:205-228`（轮转打包）
- **建议**：**不做词汇表，只做效果**（见 #4）。**理由**：这正是用户口径说的"用户看不懂的机制"。
  Pi 对外最多只暴露一个字符串配置（`"exposure": "codemode"`），**那就是可接受的上限**。

## 15. session tree 重写 + `durable`/`protocol` 研究栈 —— 建议**不做**

- **它是什么**：把会话存储整个换成"条目按 `id`/`parentId` 组成树、提示以 diff 重放"的模型；
  以及 `packages/durable`（事务化运行时）与 `packages/protocol`（CBOR 成帧，v8）。
- **它那边的证据**：`packages/durable/README.md:3-5` —— 「**Experimental.** The API changes without notice between releases.」；
  `packages/protocol/README.md:39-41` —— 「Peer authentication and authenticated service contexts are **not implemented** by the experimental transport. ... The protocol is experimental and has **no compatibility guarantees**.」
  并且**它不是 `pi` CLI 实际运行的那套**（CLI 走 JSONL tree，durable 只在 `src/experimental/durable/` 接线）。
- **我们复刻的代价**：**极高** —— 我们的 `src/core/storage/`（`session-jsonl.ts` 38 KB、`event-log.ts` 48 KB、
  `event-projection.ts` 35 KB、`message.ts` 176 KB）**已经比 Pi 的发布版存储复杂**，换成 tree 是**重写存储契约**，不是加功能。
- **建议**：**不做架构**。但**偷两个便宜的点子**：#10（`context_edit`）与 #11（提示段级 diff）。
  `durable` 里**有**我们真缺的耐久性思想（多条目原子提交、按步检查点的任务状态机、`requestId` 幂等）——
  **借思想，不搬实现**（部分已体现在 #1）。

## 16. 加载 TS 扩展（jiti）且与主进程**同权限** —— 建议**不做**

- **它是什么**：把 TypeScript 文件直接加载进 Pi 进程（无需构建），扩展可以注册工具/命令/快捷键/provider/MCP/渲染器。
- **它那边的证据**：`packages/coding-agent/docs/extensions.md:38`（jiti，无构建步骤）；
  `:34-48`（加载位置）；`:73-86`（能力面）；
  以及**尖锐的边界** `:5` —— 「An extension runs inside the Pi process with the **same operating-system permissions** as Pi.」
- **不做的后果**：用户不能"让 agent 给自己写扩展"。
- **建议**：**不做**。我们已有 `src/core/plugin-loader/`、插件市场与皮肤契约，能力面不弱；
  Pi 这套是**用安全换灵活**（扩展能看到提示、工具调用、文件、**凭据**与会话历史），与我们的权限模型冲突。

---

## 需要用户判断的三件事

1. **#1（持久性闸门）与 #3（turn/step 事件）要不要下一轮做？** 它们不产生任何新界面，
   但决定"崩溃时用户丢多少"，也是"任务通过率"能被事后统计的前提。我建议做。
2. **#2（读后写 / 版本比对）要不要做？** 它防的是"我在编辑器里改的被人盖掉"。
   代价是给工具层加一层 per-session 观察表。我建议与 D8 同批做。
3. **#4 的工具声明预算要不要先做**（只做便宜的"预算 + 命名空间分组"那半）？
   它是本轮清单里**最直接压低每轮 token**的一项，且用户侧零可见面。
