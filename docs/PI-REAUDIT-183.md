> ⚠️ **历史文档（不再维护）** —— 这是某一轮的记录，**不是当前的缺口清单**。
>
> 当前缺口与状态**只有一份**：[`docs/GAP-LIST.md`](./GAP-LIST.md)（第 72 轮起维护）。
> 本文里的"待办 / 未实现 / 差距"类结论都是**按当时的事实**写下的，
> 之后可能已经完成、已经改口径、或者已经被别的做法取代 ——
> 引用本文之前，请在 `GAP-LIST.md` 与**代码**里各复核一次。
>
> 保留本文的理由：它是那一轮的取证记录（当时的数字、现场形态、判断依据），
> 删掉就等于把"我们当时为什么这么做"一起删掉。

---

# 再审计：Codem vs Pi Agent Harness（第 183 波末 · 基于 **v1.1.0**）

> **为什么再审计**：上一轮（第 182 波）全部对标基于 Pi **v1.0.4**；上游随后发布了 **v1.1.0**
> （2026-10-07，`abe508e1`，相对 v1.0.4 **242 文件 / +7728 / -2176**）。
> 本文是**独立重取证**（不复用旧结论），口径：上游用 `git show/grep v1.1.0`（**行号是 v1.1.0 内的真实行号**），
> 我们这边用本仓 `文件:行` + 真机库读数。
> 分工：上游增量由两个只读审计分头取证（`coding-agent/tui/codemode` 与 `ai/mcp/agent/durable`），
> 我们这侧由第三个审计逐条核实，关键条目我**自己复核过**（下文标注「自核」）。

---

## §0 一句话结论

上游 v1.1.0 的增量集中在**三件事**：**终端可观测性**（OSC 7501，GUI 项目不适用）、
**生命周期竞态**（MCP 代际/会话取消）、**模型可见输出契约**（codemode 输出排歧义、
`server_busy` 可重试、工具耗时入档、分档定价）。
**我们这侧本轮查出 9 条真实差距，其中 1 条属"假成功"级**（SSE 里的 error 载荷被吞成正常结束）；
另有 3 条是**我上一轮刚做的 MCP resources 与 v1.1.0 的形状差**（分页 / 二进制落盘 / 多段 URI 标注）。

---

## §1 上一轮结论的再验证（v1.1.0 上仍成立）

| 上轮结论 | v1.1.0 复核 | 证据 |
|---|---|---|
| 远端执行环境（`packages/env`）**上游自己没接** ⇒ 我们不做 | **仍成立** | `git grep -l pi-env v1.1.0` 只命中 `packages/env/*`（自身）+ 测试 + `package-lock` + `tsconfig`；`packages/durable` 用的是自己的 `ExecutionEnv` 接口（`durable/src/env/index.ts:324`）+ `NodeExecutionEnv`，**不是** `RemoteExecutionEnv` |
| `FileSystem.watch` **上游自己不用** ⇒ 我们不做 | **仍成立** | `git grep -n "\.watch(" v1.1.0 -- packages/durable/src` 只命中 `testing/env-conformance.ts`（一致性测试）与 `harness.ts` 的 `views.watch`/`taskGraph.watch`（**不是** FileSystem.watch） |
| 结构化诊断 `<harness>` 块形状 | **逐字一致** | `packages/durable/src/harness/tool.ts:484`：`` `<harness>\n${diagnostics.map(d => `[${d.severity}] ${d.message}`).join("\n")}\n</harness>` `` —— 与我第 183 波的 `tool-diagnostics.ts` 实现同形（**自核**） |
| MCP resources 工具**命名** | **一致** | `coding-agent/src/core/mcp-servers.ts:28-30`：`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`（**自核**） |
| 上游 `ToolExecuteResult.isError` 是否必填 | 上游**仍是可选** | `durable/src/harness/types.ts`：`readonly isError?: boolean;`。我们第 183 波把它改成**必填**（TRS-4 钉住）⇒ 这是**有意偏离**，理由是我们实测到的静默缺口，不是落后 |

---

## §2 我们**领先或已对齐**的（不要再当差距看）

| 项 | 我们的证据 | 与 v1.1.0 的关系 |
|---|---|---|
| **头+尾（中间挖空）截断 + 全文落盘可回读** | `tool-result-storage.ts:100-121`（preview 保留 head+tail，注明"结论通常在尾部"）、`context-fold.ts:79`、`agentic-loop.ts:423-434`、`core/storage/spill.ts`（预览 + 定位符） | Pi 的截断策略是"中间挖空 + 全文落临时文件"（`coding-agent/src/extensions/mcp/tools.ts:5-6`）—— 我们**同形** |
| **压缩基线领前 / system 领首** | `event-projection.ts:165-172`（摘要 prepend）、`agentic-loop.ts:3671-3677`（system 恒为 `messages[0]`）、易变上下文走**尾部**临时 user 消息（`:2497-2518`） | 正是 v1.1.0 修的 `#10542`（`durable/src/harness/context.ts:176-180` `leadWithSystem`）—— 我们**已经是对的**（自核） |
| **CJK 感知的 token 估算在主路径** | `token-tracker.ts:31-68`（CJK 0.6 token/char、Latin 0.25、数字 0.33）+ `agentic-loop.ts:5314-5322` 走它 | Pi 只有"3.5 字符/token"一个常数（`ai/src/utils/estimate.ts:15`）—— 主路径上我们**更细** |
| **输出上限不用 chars/4 推算** | `model-output-limit.ts:122-152`（explicit → learned → catalog → family → 默认），且带"API 拒绝 max_tokens ⇒ 自动降档并记住"（`:155-176`、`provider.ts:397-409`） | Pi 的 `#10497` 是"用 chars/4 估输入 ⇒ 输出上限高估"；我们的形状不同，**该 bug 不直接适用** |
| **跨 chunk 的 ANSI 断裂** | 我们用 `@xterm/xterm`（带状态机的终端模拟器，跨 chunk 缓冲未完成序列）；模型侧输出另有一层剥色（`agentic-loop.ts:935`） | Pi `#10504` 修的是自制流式渲染 —— 我们**不适用** |
| **worker 通道收到非本协议消息** | 产品路径**没有** JS worker（`worker_threads` 只出现在已标注死代码的演示 provider：`validate-dynamic-code.ts:17`）；脚本沙箱在 Rust boa（`js_sandbox.rs`），第 181 波已加 16 MiB 输出上限 | Pi `#10527` 修的是 Node worker 通道 —— 我们**不适用** |
| **从启动目录吸收 `.env`** | 无 dotenv 依赖、vite 无 `loadEnv`、Rust 不读 `.env`；只给子进程注入自带键（`lib.rs:1558-1560`、`:2097-2101`） | Pi `#10473` 的安全问题 —— 我们**不适用**（自核） |

---

## §3 实测差距清单（按严重度）

### G1 ★★★ **SSE 里的 error 载荷被吞 ⇒ 假成功**（自核）

- **形态**：`provider.ts:565-599` 解析 SSE 时**完全不看 `parsed.error`**。供应商用
  **HTTP 200 + `{"error":{"message":"server_busy"}}`** 报错时，`finish_reason` 永远不出现 ⇒
  落到 `:700-745` 兜底：只 `console.warn("Stream ended without finish_reason")`、
  发 `usage` 全 0（`:737`）、发 `finishReason: "stop"`（`:738-744`）。
- **用户可见后果**：模型"什么都没说就结束了"，界面显示正常收尾，**不重试、成本记 0**。
- **与重试的关系**：`retry.ts` 的文案表本来能救（它只在"错误对象被抛出"时才有机会跑）——
  这条错误**从来没变成错误**，所以文案表再全也没用。
- **修法代价**：小（解析 `parsed.error` → 抛/标记为 provider 错误 ⇒ 交给既有重试分诊）。

### G2 ★★★ 重试表**匹配不到** Pi 的那两个原文案（自核）

- **形态**：`retry.ts:51` 是 `/\b(server|service)\s+(is\s+)?busy\b/i`。
  - `server_busy`（**下划线**）：`\s+` 匹配不了 ⇒ **不重试**；
  - `servers are currently busy`：`server` 后面是 `s`+` are currently` ⇒ **不重试**；
  - 且 `:112-117` 只要错误带 `status` 就**先于文案表** return（4xx ⇒ 不重试），文案表只在"无 status"时生效。
- **默认分支**：`:166` `{type:null, isRetryable:false}` ⇒ 这两种写法会**直接结束回合**。
- **上游对照**：Pi `ai/src/utils/retry.ts:30-34` 把 `overloaded` / `server_busy` /
  `servers are currently busy` 一起放进可重试正则（`#10543`）。
- **修法代价**：小（补 2 条正则 + 判据；我们第 181 波的 `retry-classification-capacity.test.ts` 就是现成挂点）。

### G3 ★★ **工具耗时没有写入端** —— UI 读一个永远为空的字段（自核）

- **形态**：读端齐全 —— `StatsLine.tsx:122-130`（累加 `tc.metadata.duration` → 显示"工具 Xs"）、
  `MessageBubble.tsx:866`、`ToolCallCard.tsx:698-699`；**全仓没有任何地方写 `tc.metadata.duration`**
  （`duration:` 的赋值点只有 cost-tracker 的**整轮**耗时、环境运行器、遥测 span、宠物动画）。
  `streaming-executor.ts` 无计时（`Date.now()` 零命中）；Rust 只把 elapsed 写日志（`lib.rs:1663`）。
- **后果**：界面上工具耗时**永远不显示**；重载后当然也没有（从来没落库）。
- **上游对照**：Pi v1.1.0 给 tool result/事件加了 `durationMs`（**单调钟、排除 hooks、未执行则连键都没有**），
  并修了"重载后 `Took` 丢失"（`agent-loop.ts:826-846`、`event-stream.ts:95-130`）。
- **修法代价**：小-中（执行处记单调钟 → 写进 tool_call metadata → 进 JSONL 白名单）。

### G4 ★★ **成本核算：无长度分档 + 表外模型恒 $0**

- **形态**：`cost-tracker.ts:7-13` 只有三条单价（input/output/cache per 1k），`:92-119` 18 条硬编码平表，
  `:252-257` 线性相乘，**无长度分档**；`:245` 表外模型 `return 0`；动态拉取的模型不带价格（`provider.ts:197-204`）。
- **后果**：① 长提示（>200k 档）**少算**；② 动态模型成本恒 0 ⇒ `checkLimits`（`:222`，默认 $5/会话、$20/天）
  **永不触发**，成本闸门形同虚设。
- **上游对照**：Pi `ModelCostTier { inputTokensAbove }` + `calculateCost`（`ai/src/models.ts:1200-1209`，
  请求级"最高命中档适用整个请求"）；**类型与计算函数在 v1.0.4 就有，v1.1.0 补的是数据管道**。
  明确未建模：OpenRouter 时段定价（`openrouter-catalog.ts:66-73` 注释 + 测试断言）。
- **修法代价**：中（分档结构 + 价格数据 + 判据）。

### G5 ★★ **`run_code` 的 SDK 描述与实际返回形状不一致**（"描述即契约"类）

- **形态**（`run-code.ts`）：
  - `:193-198` 列出 `sdk.bash/read/write/glob/grep/fetch`，只有 `:200` 一句泛泛 "runs in an async context"，
    **逐条没写返回 Promise / 返回什么形状**；实现 `:229-278` 全是 async。
  - `:266` `sdk.grep` 返回 `{file, line: 0, content}` —— **`line` 恒为 0**（真 bug，其它 grep 给真实行号）。
  - `:268-278` `sdk.fetch` 返回**字符串**（`response.text()`），描述只说 "fetch a URL"。
  - `:192` 描述写 **"QuickJS compiled to WebAssembly"**，实际是 Rust **boa**（`js-remote-runtime.ts:160`、`js_sandbox.rs`）。
  - 宿主工具本身不受影响（registry 一律 `await`，`tools.ts:791`）；风险只在**暴露给模型的 SDK 心智模型**上。
- **上游对照**：Pi `#10555` —— 描述没标 async ⇒ 模型不 await、把 promise 序列化成 `{}`；
  修法是**改描述**（`extensions/codemode/tool.ts:145-147`），不是再提醒模型一句。
- **修法代价**：小（逐条补 async/形状 + 修 `line: 0` + 改 QuickJS→boa）。

### G6 ★★ **token 估算器有三份、常数不一致**（自核）

- **形态**：
  - `token-tracker.ts:31-68`（CJK 感知，**主路径**：`agentic-loop.ts:5314-5322` 的压力/压缩判定）；
  - `context/context.ts:246-247` `Math.ceil(text.length / 4)` —— **朴素 chars/4**，
    却被**活路径**使用：`llm/index.ts:1728` 的压力显示、`compaction-provider.ts` 的 `shouldCompact`；
  - `attachment-formatter.ts:26` 与 `knowledge/chunker.ts:144-152` 各一份。
- **后果**：**中文会话的上下文压力被低报约 2.4×**（1000 个汉字：朴素 250 token vs CJK 感知 600），
  即界面显示"还很空"而实际已接近上限；插件压缩路径也会**太晚**才触发。
  另：`agentic-loop.ts:5080-5081`（选裁预算 = 窗口×0.9）与 `:5431-5437`（压缩保留集预算）
  都建立在同一个偏乐观的常数上 ⇒ 超窗只能等 400 再反应式压缩。
- **上游对照**：Pi 把常数从 4 调到 **3.5**（`#10497`）—— 对我们是**方向一致的提醒，但我们更该做的是"统一估算器"**。
- **修法代价**：小（`context.ts` 改为调用 `token-tracker.estimateTokens`，一份真值）+ 需重跑压缩判据。

### G7 ★★ **每轮重复全量读消息 + `msgCache` 频繁置空**

- **形态**：每轮 `agentic-loop.ts:2133 buildMessages` → `:4994 listMessages`（内存镜像 merge+sort+map，
  `storage/message.ts:548-631`，`:629` **全量排序**），同一轮**第二次**全量读（`:2149 → :5335`）；
  随后全量 `:5078 pruneStaleToolResults`、`:5082 selectMessagesByPriority`、`:5158-5201` fold/micro-compact；
  工具 schema 每轮重建（`:2142 getCoreDefinitions` → `tools.ts:675-677,703-711`，无 memo）。
- **已有增量但常失效**：`msgCache`（`:5016-5069`，键 ≈ Pi 的 head marker），却有 **15+ 处置空**
  （`:2405/2647/2712/2874/3234/3357/3406/3979`）⇒ 真实会话里常走全量重建。
  另：`storage/transcript-cache.ts` 的 10 分钟 TTL 缓存**没有调用者**（只有 `.clear()` 在用）。
- **上游对照**：Pi v1.1.0 的 `#10546`/上下文缓存（`durable/src/harness/context.ts:79-92`：
  键 = head marker，四条分支；tail 前进只扫增量；出现 edit/rewind 立即降级全量；
  空闲 10 分钟保留、忙时永不淘汰）。
- **修法代价**：中。

### G8 ★ **MCP「全部连接」串行 + 结束时才写状态**

- **形态**：`McpManager.tsx:107-113` —— "全部连接"把结果**收集完再一次性** `setStatuses`，
  期间不置 `connecting`（单条连接有"连接中…"，`:264-267`）；按钮也无进行中态（`:178-181`）。
  `mcp.ts:597-622 connectAll` 是**串行** `for … await`；单次 stdio 请求 30s 超时（`lib.rs:2188`），
  一次连接要 handshake + tools/list ⇒ 一个挂住的服务器最坏把全部拖 ~60s。
- **上游对照**：Pi `#10562` —— `/mcp` 不再等所有服务器（`extensions/mcp/index.ts:1278-1285`）。
- **修法代价**：小-中（并发化 + 逐条写状态）。

### G9 ★ **我上一轮刚做的 MCP resources 落后于 v1.1.0 的三处**（自核）

| 维度 | v1.1.0（`coding-agent/src/extensions/mcp/resources.ts`、`docs/mcp.md:238-244`） | 我们的现状（`mcp-resources-tool.ts`） |
|---|---|---|
| 分页 | 列表是 **JSON** `{ server?, resources: [{server, uri, …}], nextCursor? }`，`cursor` 续页 | 只拼**文本**列表，**无 `nextCursor`** ⇒ 资源多的服务器会丢/不分页 |
| 二进制 | 非图片二进制**落临时文件，把路径给模型**（图片直接作为 image 内容给模型） | 只写一句 `[binary resource: …, N base64 chars — not inlined]` ⇒ **数据丢失** |
| 多段 | 多段内容**每段前加 URI 标签**（`resources.ts:317-319`） | 用 `\n\n` 直接 join、**不标 URI** ⇒ 与 Pi 刚在 codemode 修的"输出粘在一起"是同一类缺陷 |

- **修法代价**：小-中（分页字段、落盘 + 路径、逐段 URI 标签）。

### G10 ★ **新模型与推理档位的天花板**

- **模型目录**：内置静态目录只有 **3 条 deepseek**（`model-catalog.ts:65-79`），其余靠动态拉取
  （`provider.ts:155-204` GET `/models`）；全仓无 `claude-haiku-5-5` / `gpt-6-luna`。
  拉到的未知型号吃默认值：上下文窗口 **128k**（`provider.ts:97-106`）、输出 **16384**（`:204`）、成本 **$0**。
- **推理档位**：我们的类型是 `"low" | "medium" | "high"`（`types.ts:41`、`llm/index.ts:942` 另把 `ultra` 映射成 `high`），
  而上游支持到 **`xhigh` / `max`**（自适应思考，`ai/CHANGELOG` 1.1.0 + `bedrock-converse-stream.ts:1339-1355` 的按族钳制）。
- **后果**：目录里的新模型"要手点刷新才出现"；未知型号的默认窗口偏小 ⇒ 过早压缩；
  且**无法表达 `xhigh`/`max`** ⇒ 对支持自适应思考的新模型，我们被锁在 `high`。
- **修法代价**：小-中（补族规则 + 放宽带数枚举 + 判据）。

---

## §4 结构性差距（不适合单轮修，登记为"观察"）

1. **没有执行环境抽象层**：Pi 的 `ExecutionEnv = FileSystem + Shell`（`durable/src/env/index.ts:324`）
   是可替换接口（本地 `NodeExecutionEnv` / 远端 `RemoteExecutionEnv`）；我们是**函数式直调**
   （`src/core/file-api.ts` 每个函数自己 `invoke`）。仍是"上游自己都没接远端实现"⇒ **不做**。
2. **没有"副作用相位"协议**：Pi 用 `commit intent → perform effect → commit outcome`
   （`durable/docs/spec.md` §5.2 effect sandwich），并**明确承认**"重开在意图相位意味着副作用可能已发生"；
   我们有**三态崩溃修复**（`compaction-control.ts:145-212`：`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` /
   `TOOL_COMPLETE`，合成结果 `"tool outcome unknown (crash recovery)"`）—— 是**结构修复**，
   不是"告诉 agent 该拿这个可能已生效的副作用怎么办"。改造成本大，登记为观察。
3. **提示演化不进会话日志**：Pi 把"后续 system 消息可追加/替换/移除具名提示段、加减工具，
  按序重放即当前状态"（`coding-agent/docs/message-types.md`）；我们**每轮现构系统提示**
  并经重建对象透传（第 183 波就因此丢过 `lineNumbers` 与 `diagnostics`）。影响的是
  回放/审计保真度与 resume 后的提示一致性，不是当前功能。

---

## §5 建议顺序（按"真 bug → 用户可见 → 成本正确性 → 性能"）

| 顺序 | 项 | 为什么排这里 | 代价 |
|---|---|---|---|
| 1 | **G1 SSE error 吞成假成功** | 属"假成功"级：用户看到正常收尾、成本记 0、不重试。修它同时让 G2 的文案表能生效 | 小 |
| 2 | **G2 补 `server_busy` / `servers are currently busy`** | 同上一条配套；现有判据文件就是挂点 | 小 |
| 3 | **G3 工具耗时入档** | 读端齐全只缺写入端，属"功能已知失效"；修完立刻可在真机看到数字 | 小-中 |
| 4 | **G6 统一 token 估算器** | 中文会话压力低报 ~2.4×，影响压缩时机与界面读数；修法是"一份真值" | 小 |
| 5 | **G5 `run_code` 描述/形状漂移**（含 `line: 0` 真 bug、QuickJS→boa） | 会让模型写出静默错误的脚本 | 小 |
| 6 | **G4 成本分档 + 表外模型不再恒 $0** | 成本闸门现在形同虚设；涉及价格数据 | 中 |
| 7 | **G8 MCP 全部连接并发化 + 逐条状态** | 用户可感知的等待 | 小-中 |
| 8 | **G9 MCP resources 补齐 v1.1.0 形状**（分页/二进制落盘/URI 标签） | 我上轮刚做的，属"跟上新形状" | 小-中 |
| 9 | **G7 每轮全量读 + msgCache 失效** | 性能，收益需先量（同类问题第 183 波已有记忆化先例） | 中 |
| 10 | **G10 模型族规则 + `xhigh`/`max`** | 影响新模型可用性 | 小-中 |

---

## §6 附：本轮取证元信息

- 上游副本：`.preview-shot/_pi-repo`（tags `v1.0.4`、**`v1.1.0`** 均本地可取；工作区仍在 v1.0.4）。
- 上游增量分布（`git diff --numstat v1.0.4 v1.1.0` 按目录聚合）：
  `coding-agent` 84 / `ai` 48 / `durable` 32 / `tui` 17 / `mcp` 8 / `agent` 7 / `codemode` 7 / 其余 ≤2。
- 三条审计线的详细取证（含全部 `file:line`）其中一份落在 `.preview-shot/_pi-110-delta-audit.md`。
- **未取证的**：`list_mcp_resource_templates` 的真机调用（与另两个共用同一条 sync 与协议路径，单测 MCPR-5 守着）；
  以及 Pi `harness-context.test.ts` 里"扫描次数确实下降"的断言体（只取证了缓存键与分支结构）。
