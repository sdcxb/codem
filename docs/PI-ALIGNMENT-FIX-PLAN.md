# Pi Agent Harness 1.0 对标修复计划（2026-10-02 · 起于 v1.16.221）

> ⚠️ **历史文档（不再维护）** —— 这是某一轮的记录，**不是当前的缺口清单**。
>
> 当前缺口与状态**只有一份**：[`docs/GAP-LIST.md`](./GAP-LIST.md)（第 72 轮起维护）。
> 本文里的"待办 / 未实现 / 缺口 / 未完成"类结论都是**按当时的事实**写下的，
> 之后可能已经完成、已经改口径、或者已经被别的做法取代 ——
> 引用本文之前，请在 `GAP-LIST.md` 与**代码**里各复核一次。
>
> 保留本文的理由：它是那一轮的取证记录（当时的数字、现场形态、判断依据），
> 删掉就等于把"我们当时为什么这么做"一起删掉。



> 对标对象：**Pi Agent Harness 1.0.0**（`earendil-works/pi`，作者 badlogicgames / Mario Zechner，奥地利）。
> 参考源：`C:\mimo-gui\.preview-shot\_pi-repo`，**已克隆**，HEAD `9b3c19d`，`git describe` = `v1.0.0-10-g9b3c19d`，
> 全部 13 个包均为 `1.0.0`（`@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`、`pi-codemode`、`pi-mcp`、`pi-protocol`、`pi-server`、`pi-tui`、`pi-client`、`pi-durable`、`pi-telemetry`、`pi-evals`、`chord`）。
> 本文所有结论都从**源码**得出；**没有**引用任何二手文章（见 §0）。

---

## §0 取证条件与限制（先说不确定的地方）

| 项 | 状态 |
|---|---|
| `git clone` Pi 仓库 | ✅ 成功。交接单说「`web_fetch` 被 DNS 拦、但 `git` 能访问 GitHub」——**核实为真**，本轮完全靠 git 拿到源码 |
| 交接单给的三方对比文章 <https://dev.classmethod.jp/en/articles/reona-coding-harness-opencode-pi-dsh/> | ❌ **没读到**，`web_fetch` 报 `URL hostname "dev.classmethod.jp" resolves to a non-public IP address`。**本文不引用它，也不假装读过。** |
| npm 上的 `@ai-sdk/harness-pi` | ⚠️ 与本仓库**不是同一个东西**。`C:\mimo-gui\.preview-shot\_pi-repo` 是 Pi 官方 monorepo（包名 `@earendil-works/*`）。交接单把这两者混在一句里，**已更正**：我们对标的是 `earendil-works/pi`。 |
| `packages/evals` 的外部依赖 `vitest-evals@0.15.0` / `@vitest-evals/core@0.15.0` 的类型定义 | ⚠️ 仓库里**没有 `node_modules`**，所以 `createHarness` / `Harness` / `UsageSummary` 的**外部类型契约未找到证据**。§2 里凡涉及它的地方都按"从 Pi 的调用点可读出的**形状**"表述，不当成已核实的接口。 |

**交接单让我"别信我的转述"**，照做结果：交接单说 Pi 1.0「主打 MCP 与一个叫 Codemode 的机制」。**前半对，后半不完整**——
Codemode 不是一个笼统的"机制"，它有两半，而**交接单漏掉的那一半更有价值**（见 §2 P-0 与 §4）。

---

## §1 Pi 的真实结构（与我们对比的前提）

| 层 | 是什么 | 证据 |
|---|---|---|
| **纯引擎** `packages/agent` | `runAgentLoop` → `runLoop`，**两层 `while(true)`**；不做 I/O | `packages/agent/src/agent-loop.ts:179-183` |
| **会话外壳** `packages/coding-agent` | `core/agent-session.ts`（4348 行 / 158 KB）。所有上下文工作通过**三个可注入钩子**挂上去 | `:759`（`prepareRequest`，含压缩检查）、`:858`（`finishTurn`）、`:870`（`prepareNextTurn`） |
| 内置工具 | `read, bash, powershell, edit, write, grep, find, ls` 八个 | `src/core/tools/index.ts:95-105` |

**结构上最大的一条差别**：我们的 `AgenticLoop`（`src/core/llm/agentic-loop.ts`，3969 行）是**单体**——
压缩、micro-compact、引导、needs-you、文件变更跟踪、自动提交、计划宏步**全部硬编码在 `run()` 体内**
（`:1400-1436` 压缩、`:1438-1462` 引导、`:1490-1572` 文件跟踪/自动提交）。Pi 把同样这些行为**全部从外部**通过三个钩子注册。
后果是 Pi 的循环能**独立测试**（`packages/agent/test` + faux provider），我们的不能。
**这条我判为「差异」不判「隐患」**：我们的循环虽然难测，但行为是共址可读的；Pi 的 `agent-session.ts` 158 KB、
要靠追四个钩子安装点才能读懂循环行为。**不为了"更可测"去重写核心循环**——收益在工程侧，代价和风险都在核心路径上。

**Pi 也刻意比我们简单**（诚实记录）：没有迭代上限、没有无进展阀门、没有 stall guard、没有重复守卫、没有 loop-stop 日志。
它唯一的失控保护是截断输出的 fail（`agent-loop.ts:478-503`）和工具批次的 `terminate`（`:689-691`）。

---

## §2 Pi 有而我们缺的、且**本轮要修**的（我方缺陷，Pi 的机制是修法）

### P-0 差异｜Codemode 的**真实**定义（更正交接单，并说明为什么其中一半我们不抄）

- **它是什么**：`packages/codemode`（`@earendil-works/pi-codemode`）是一个**QuickJS-in-WASM 沙箱**，
  外面套一个普通工具 `codemode`，参数只有一个字符串 `code`。
  - 证据：`packages/codemode/README.md:3` — 「Runs model-written JavaScript in a QuickJS VM (compiled to WebAssembly) where the only capability is calling injected tools. **Nested tool calls never enter the LLM context**; only the script's output and return value do.」
  - 隔离事实：每次 `execute()` 全新 worker + 全新 VM；堆上限 256 MB（`extensions/codemode/execute.ts:57`）；宿主桥接放在闭包里（`codemode/src/runtime/prelude-source.ts:5`）；全局量冻结且保留字受保护（`:113-114`、`:320-325`；`runtime/host.ts:24-34`）
  - 嵌套调用走**真管线**（校验/钩子/权限都生效）：`extensions/codemode/tool.ts:8-10` + `execute.ts:363` `await ctx.executeTool(tool.name, args, ...)`
- **它解决两个不同的问题**：
  1. **工具往返的 token 成本** —— 嵌套调用**不进模型上下文**，只有脚本输出进。
  2. **（交接单漏掉的这半）工具声明的 token 膨胀** —— 暴露方式变成一条轴 `direct | model-only | codemode | deferred | hidden`，
     并且 inline 声明有**硬预算 3000 token**（`extensions/codemode/tool.ts:154 DEFAULT_CODEMODE_INLINE_BUDGET = 3000`），
     按"最便宜的优先、轮转"打包，保证每个命名空间都被代表到（`:205-228`）；没声明的工具用 `searchTools()`（BM25）在运行时找。
     决定性的一行：`packages/coding-agent/src/core/mcp-servers.ts:25` — `/** Default: \`codemode\`. */`
     —— **MCP 工具默认根本不声明给模型**，只能从脚本里调。
- **我们的现状**：`src/core/llm/tools/run-code.ts` 有一个 `run_code`，但它的"隔离"是
  `run-code.ts:62` `new Function("sdk", "console", "Promise", ...)` —— **进程内、无 VM 边界**，
  且 `sdk.grep` 把行号丢掉（`run-code.ts:155` 返回 `line: 0`）。**它是这个想法的原型，不是实现。**
- **我们复刻的代价**：真做 = 高（WASM VM 依赖 + worker 宿主协议 + 全局加固 + 中断/取消 + 每个工具都要有
  `structuredContent` vs 文本的双通道契约）。
- **不做的后果**：见 P-2（安全那一半是**必须**处理的 bug）；批量/过滤那一半不做，则"探索 40 个文件"仍然烧掉几十次往返。
- **建议**：
  - **做（安全那一半，本轮）**：P-2。
  - **做（效果那一半，下一轮）**：先做**声明预算 + 命名空间分组**（便宜、直接压每轮 token），再做按需声明。
  - **不抄它的词表**：`direct / model-only / codemode / deferred / hidden` 五个值、`store()`/`load()`、
    `models.classify()`、`describeNamespace()`、207 行的脚本 API —— 这是 Pi 内部最聪明的部分，**也最违反用户口径「不要太复杂、不要让用户面对看不懂的机制」**。
    要它的**效果**（少声明、按需查找），不要它的**词汇表**；产品面最多一个 on/off。

### P-1 隐患｜**被输出上限截断的那一批工具调用，我们照常执行**（Pi 整批拒绝）

- **现象**：`finish_reason === "length"`（撞到单次输出上限）时，若这一批里有内容型工具（`write` 等），
  我们**照常执行**，只在结果后面**追加一句警告**请模型自己核对完整性。
- **证据（我方）**：`src/core/llm/agentic-loop.ts:2787-2798` —
  ```ts
  // 第 67 波（同类问题清查）：**截断的"合法 JSON"也可能写下半截文件**。
  // 如果本次回复的结束原因是 length（达到输出上限），而调用的是内容型工具，
  // 那参数 JSON 有可能"恰好"是完整的、但内容被切在了一个合法边界上 —— 我们不能证明它完整，
  // 所以**明确提示模型去核对并补齐**，同时落一条事件（可统计"多常见"）。
  if (finishReason === "length" && isContentBearingTool(name)) {
    console.warn(`[AgenticLoop] ${name} ran in a response truncated by the output limit — asking the model to verify completeness`);
    result.output = `${result.output ?? ""}\n\n[WARNING] ...请立刻核对它是否完整...`;
  }
  ```
  注意注释自己写了「**我们不能证明它完整**」——然后**还是执行了**。写入已经落盘，警告是事后追加的。
  对比我们已有的、更强的处理：`:2414-2433` 对**参数不是合法 JSON** 的调用是**一律不执行**（第 66 波）。
  所以本仓对"参数坏"是 fail-closed，对"参数可能被静默截断"是 fail-open —— **两种不确定性的处置不一致**。
- **证据（Pi）**：`packages/agent/src/agent-loop.ts:471-477`（理由写在注释里）——
  「Streamed tool-call arguments are finalized with a best-effort JSON salvage parser, so a truncated message can yield tool calls whose arguments parse and validate but **silently incomplete**. **None of them are safe to execute**; report each as an error so the model can re-issue them.」
  实现：`:478-503 failToolCallsFromTruncatedMessage`，逐个产出 `isError: true` 的结果，文案
  `Tool call "X" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`
- **影响**：这是一个**静默写坏文件**的类别 —— 用户看到"文件写好了"，实际是半截内容，而模型被事后那句警告带着去"核对"，
  很可能认为已写对。事故形态隐蔽：参数恰好是合法 JSON、内容恰好切在合法边界上。**用户会怪模型。**
- **修法**：`finishReason === "length"` 时，对**内容型工具**（以及任何参数可能被截断的调用）**不执行**，
  改为产出 `isError: true` 的结果 + 可操作指引（请重新发出这次调用 / 长文件用 `write` + `append: true` 分块）。
  即把 `:2791` 的"执行 + 事后警告"改成"拒绝 + 明确要求重发"，与 `:2414-2433` 的第 66 波处置对齐。
  **保留**已有的自动续写预算（`MAX_TRUNCATED_CONTINUATIONS = 3`，`:260`），它解决的是"正文被截断"，与本条互补。
- **判据**：`src/test/pi-p1-truncated-toolcall-not-executed.test.ts` ——
  假 provider 返回一个 `finish_reason: "length"` 且带一个 `write` 调用的响应；
  断言 **`write` 的 handler 从未被调用**（磁盘逐字节未变）且模型收到一条 `isError` 的结果。
- **变异自证**：把新加的拒绝分支退回成"执行 + 追加警告"（即 `:2791` 的现状）⇒ handler 调用计数变 1，用例变红。
- **置信度**：高（两侧代码都逐行读过；我方注释本身就承认"不能证明它完整"）。**已排除一个可能的反驳**：
  我核对了 `:1796` 的截断续写分支，确认它**只在 `toolCallsInIteration === 0` 的块内**（`:1730` 开块），
  所以"有工具调用的截断响应"确实绕过了它、走到了 `:2785` 的执行路径。

### P-2 隐患｜`run_code` 自称"在隔离的环境中执行"，实际既不是隔离、**还绕过了权限闸门**

- **现象**：`run_code` 用 `new Function(...)` 在一个**全局变量白名单**里执行模型写的代码。
  文件头注释写的是「在隔离的环境中执行 TypeScript 代码」（`run-code.ts:4-5`），
  工具给模型看的 guidance/description 也写 `"in a sandboxed environment"`（`:91-92`）——**这个承诺不成立**。
  **更严重的是第二层**（这一层不在最初的取证报告里，是我沿着调用链自己查出来的）：
  它的 `sdk.bash` / `sdk.write` **直接调文件 API**，**绕过了对应工具的权限闸门**。
- **证据（我方）**：
  - `src/core/llm/tools/run-code.ts:62` — `const fn = new Function("sdk", "console", "Promise", "JSON", "Math", "Date", "Array", "Object", "String", "Number", "Boolean", "RegExp", "Map", "Set", "Error", wrappedCode);`
  - `src/core/llm/tools/run-code.ts:4-5` / `:91` / `:92` —— 三处都声称 sandboxed/隔离
  - **闸门绕过（关键）**：`src/core/llm/tools/run-code.ts:128-139` ——
    `async bash(command: string, opts?) { const { executeCommand } = await import("../../file-api"); const result = await executeCommand(command, ctx.cwd, cmdTimeout); ... }`
    —— 它**没有**调用 `analyzeBashCommand`（真 `bash` 工具的检查在 `src/core/permission/security-mode.ts:151-180` 与 `bash-analyzer.ts:201`）。
    所以模型可以**把危险命令包在 `run_code` 里**执行，分析器一次都不会跑。
  - `src/core/llm/tools/run-code.ts:144-147` —— `sdk.write` 直接 `await writeFile(path, content, { workspace: ctx.cwd })`，
    **绕过**真 `write` 工具的覆盖保护与写确认（`tools.ts:1400-1460`，阈值 `OVERWRITE_SIMILARITY_THRESHOLD = 0.1` 在 `:321`）。
  - `src/core/permission/security-mode.ts:149-183` —— `isAutoApprovable` 只对 `if (tool === "bash" && resource)` 做特殊处理，
    最后一行 `return true;` ⇒ **`run_code` 在"替我审批"（auto）模式下被自动放行**，而它比 `bash` 能力更强。
  - 同族第二个出口：`src/core/llm/tools/run-code.ts:193-209` 的 `execRunCode` 用同一套"直连 file-api"的 sdk
    （调用方之一见 `src/core/llm/workflow-engine.ts:137`）。
  - **本仓自己已经知道它是系统级工具**：`src/core/llm/tool-contract.ts:382` 把它与 `terminal_*` 并列为系统类工具；
    `src/test/tool-contract-predicates.test.ts:111` 断言 `isShellLike("run_code", { sideEffectScope: "system" }) === true`。
    **契约层认它是 shell-like，权限层却没有据此处置它** —— 这正是"链路中间缺一节"的形状。
- **证据（Pi，修法的形状）**：Pi 的等价机制把嵌套调用**送回真管线**，所以校验/钩子/权限**与直接调用完全一致**：
  `packages/coding-agent/src/extensions/codemode/tool.ts:8-10` ——
  「Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so validation, `tool_call`/`tool_result` hooks, and **permission checks apply exactly as for direct calls**.」
  实现见 `execute.ts:363` `const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });`
  隔离实现见 `packages/codemode/README.md:3`、`prelude-source.ts:113-114,320-325`、`runtime/host.ts:24-34`、`execute.ts:57`（256 MB 堆上限）。
- **影响**：这是一条**真实的权限绕过**，不是措辞问题。
  危险命令（`Remove-Item -Recurse -Force`、`Invoke-Expression` 等，分析器本来会拦）只要包进 `run_code` 就会执行；
  低相似度覆盖写也不会弹确认。**用户以为自己受"安全模式"保护，实际有第二条没人看的门。**
  附带：`new Function` 的白名单**不构成边界** —— 通过原型链可以取回真实全局对象（`({}).constructor.constructor("return globalThis")()`），
  因此模型写的代码与渲染进程同权限。**我没有构造并验证一个漏洞利用**，我核实的是**这两条边界都不存在**。
- **修法（本轮）**：**不换运行时（那是下一轮的决定），先把闸门接回来、把话说实**：
  1. `sdk.bash` 执行前用 `analyzeBashCommand` 分类，`dangerous` ⇒ **fail-closed 拒绝执行**，
     并把命中的模式回报给脚本/模型，指引它改用 `bash` 工具让用户被问到；
     分析器抛错时**也按拒绝处理**（对齐 `security-mode.ts:161-163` 的既有先例）。
  2. `sdk.write` 在目标已存在、`securityMode === "ask"` 且 `ctx.onWriteConfirm` 存在时，走**与 `write` 工具相同**的确认路径。
  3. 三个出口（`createRunCodeTool` 的 guidance/description、文件头、`execRunCode` 的可达性）**一律改成说实话**：
     代码在**应用进程内**、拥有应用的权限，**不是**安全沙箱，嵌套调用受权限检查。
  4. `execRunCode` 的可达性必须查清：若它可由模型侧代码触达，同样要接闸门；否则要写明为什么安全。
  5. **（复核这一层时新发现的第二个缺陷 —— fail-open）** `confirmWriteIfNeeded` 的读盘 catch 是**空的**，
     于是**任何**读失败都被当成"文件不存在"⇒ 走"新建"分支 ⇒ **跳过覆盖确认**。
     而"已存在但读不到"是真实存在的（二进制/超大文件、权限、引擎暂时不可用），
     此时 `write_file` **可能照样写得下去** —— 用户在被覆盖之前**一次都没被问过**。
     修法：只有**能确认"路径不存在"**才当新建；**判不出来一律按"可能已存在"处理**（有确认通道就去问）。
     判据 `src/test/pi-p2b-run-code-unreadable-confirm.test.ts`（5 条），变异自证见 §5。
     —— 记它的价值在于：**这条不在最初的取证报告里，是"沿着同一个闸门把每个分支走到底"才浮出来的。**
     同一层里"绕过"和"fail-open"是两种不同的坏法，只找前者会漏掉后者。
- **判据**：`src/test/pi-p2-run-code-permission-parity.test.ts` ——
  ① 危险命令在 `run_code` 内**必须被拒**：断言底层命令执行器**从未被调用**，且返回文案说明拒绝原因
  （**并且先把"这条命令确实被分析器判为 dangerous"断言出来** —— 否则"输入本身就不危险"会让这条判据假绿，见 §5 的假绿形态三）；
  ② **反向对照**：无害的只读命令**照常执行**（防止修成"一律拒绝"）；
  ③ 写确认在 `run_code` 内被尊重：reject ⇒ 文件未被写；accept ⇒ 被写；
  ④ 模型看到的文案里**不含** 隔离/沙箱/isolated/sandbox。
- **变异自证**：逐条改坏关键行（去掉危险命令拒绝 / 去掉写确认调用 / 把 "sandboxed" 加回描述）⇒ 对应用例变红。
- **置信度**：高（闸门缺失与绕过路径都是可直接复核的结构事实；`isAutoApprovable` 的 `return true` 已逐行读过）。

### P-3 隐患｜工具失败靠**文本启发式**判断，而不是显式契约（Pi 与 DSH 都是显式声明）

- **现象**：我们靠"输出首行是否匹配 `Error:`/`错误：`/`失败：`"+ 内容型工具白名单来判成功/失败。
  这导致 `docs/DSH-ALIGNMENT-FIX-PLAN.md` 的 D9/D10 两条假成功：失败文案的首行不匹配正则，就被判成 `completed`。
- **证据（我方）**：`src/core/llm/tool-result-status.ts:40`（正则）、`:72-76`（判定）、`:21-37`（内容型白名单）；
  `src/core/llm/tools.ts` 全文只有 **3 处** `isError`（`:926` 的 bash 缺参、`:449` 的类型声明、`:713` 的读取）
  —— 即"失败必须是 error"这条承诺**靠巧合维持**。
- **证据（Pi）**：`packages/coding-agent/docs/extensions.md:138-140` ——
  「Throw from `execute()` to produce a failed tool result. **Returning an object does not mark it as an error.**」
  失败是**契约行为**（throw），不是文本约定，所以 Pi 不需要启发式。
- **证据（DSH）**：工具超时返回结构化 `{ isError: true, error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } } }`
  （`dsh-tool-call-timeout-policy/lib/index.js:41-48`），机器可读、不靠文本。
- **影响**：**每一处"失败但首行不是 `Error:`"的返回都是一颗地雷**，且新写的工具会继续踩。
  这是 D9/D10 的**根因**，只修那两处是治症状。
- **修法**：把 `isError` 从"可选"变成工具返回的**必填**字段（`ToolExecuteResult` 上），
  让 `classifyToolResult` 的文本启发式**退化为兼容层**（保留但仅用于老工具），
  并加一条**架构判据**：新增的工具返回若既没声明 `isError` 又输出疑似失败文案，必须判红。
- **判据**：`src/test/pi-p3-tool-result-declares-status.test.ts` ——
  对所有已注册工具做一次"契约普查"：断言每个工具的失败返回路径都能通过 `isError` 表达
  （用**行为**方式：对每个工具构造一次代表性失败，断言 `classifyToolResult` 得到 `error` 且 `error` 字段非空）；
  再加一条**反向**判据：故意注册一个"失败却只写文案、不设 `isError`"的假工具，断言普查**判红**（证明普查真的在检查，不是恒绿）。
- **变异自证**：把某个工具的 `isError: true` 去掉 ⇒ 该工具的普查项变红。
- **置信度**：高（"只有 3 处 `isError`"是可穷举的静态事实）。**本轮只落地 D9/D10 两处 +
  这条普查判据**；把"必填化"作为下一轮的收口（它会触及工具契约类型，属于较大改动）。

### P-4 缺失｜我们没有**成对评测**的尺子（Pi 有可复用的方法学）

- **它是什么**：一个"计划在前、成对执行、只报成对差值"的评测器。每个评测集输出 pass rate 提升，
  以及 **tokens / tool calls / latency / 估算美元成本**四项的**成对均值差**。
- **它解决什么问题**：用户口径「同样用 DS 模型，水平和 token 消耗都不差于 dsh」目前**无法证伪**。这是现成的方法学。
- **证据（Pi）**：
  - `packages/evals/src/report.ts:21-30` — `EvalMetrics { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, toolCalls, totalMs, estimatedCostUsd }`
  - `packages/evals/src/report.ts:36-41` — `PairedMetricSummary { eligiblePairs, controlMean, treatmentMean, meanDelta }`
  - `packages/evals/src/report.ts:398-401 / :454-456` — 成对报 Tokens / Tools / Latency / Cost
  - **最有价值的是它的"拒绝过度声称"纪律**：`report.ts:249-281`（一对样本只有两侧各得**恰好一个**分数才算数；
    缺失/重复/跳过/未评分/出错的臂会**阻塞该对**）与 `:379`（有阻塞就**不给出** headline pass rate）；
    `README.md:103` — 「Missing telemetry remains unavailable rather than being treated as zero」；
    `:105` — 「One repetition cannot establish stability」；`plan.ts:52-56` 按运行号**交替顺序**以降序偏。
  - ⚠️ **必须说清楚**：`packages/evals` **本身不是代码质量 benchmark** —— 它只做一件事，
    即"文档 lift"对照实验（`README.md:9`；`harness.ts:494-506` 在 `without_docs` 臂里删掉 README/CHANGELOG/docs 并剥掉系统提示的 `<docs>` 段）。
    **它没有任何 SWE-bench 式的任务集，也没有任何"Pi 更省 token"的实测数字。**（我在仓库里**未找到证据**支持任何 Pi 自报的节省幅度。）
- **我们复刻的代价**：**中，且全部在开发者侧、用户侧零可见面**。
  `plan.ts` + `report.ts` 约 540 行，消费边界不依赖 Pi（只吃 `@vitest-evals/core` 的 `ReportCase`/`run.usage`/`run.timings`）；
  需要写一个 Codem 适配器，让它返回同样形状的 `usage`/`timings`/`events`；
  臂必须能**无头驱动**（我们的引擎在桌面应用进程里，这是真正的工作量）；
  并且要求 `cost-tracker` 能出 `input/output/cacheRead/cacheWrite` 四个桶 —— **即 D6/D7 是它的前置**。
  **不要**移植它的 Docker/uid-drop 沙箱（`src/docker.ts` + `docker/entrypoint.ts` 假设"容器里的 Node CLI"），我们用 `src/core/sandbox/`。
- **不做的后果**：token/质量的主张永远没有数字支撑；每一次"压缩改好了"都无法验证，token 回退要等用户抱怨才被发现。
- **建议**：**做**。见 `docs/DSH-ALIGNMENT-FIX-PLAN.md` §4 的尺子设计（本轮交付"怎么测 + 计量已可信"，
  **不产出**任何"我方优于/等于 DSH"的数字 —— 那要真跑过才说）。

---

## §3 Pi 有但我们**明确不做**的（"它很好但不该做"是合法结论）

用户口径：**「不要太复杂、不要让用户面对看不懂的机制。」** 下面每条都把**用户能感知的收益**与**内部复杂度**分开写。

| # | Pi 的机制 | 用户能感知的收益 | 内部复杂度 | 建议与理由 |
|---|---|---|---|---|
| 1 | **自动 prompt cache 保温**（空闲时用 `maxTokens: 1` 重发**整个**上次请求，门槛是期望节省 ≥ $0.05，默认**开启**；`cache-warmer.ts:398/20/390/29-32/357-361`，`settings-manager.ts:1023-1026`） | 短暂空闲后不会整段按全价重算 —— 但用户**看不见**它，只会在账单上偶发地少一点 | **高**：一个定时器 + "这份记录还是上次请求的前缀吗"的判定（`sdk.ts:345-357`）+ 花费闸门 + 开关；作者自己把"继续概率"**硬编码成 0.15**（`:21-26`，注释说 per-session 估计并不比这个常数好），还要加安全视界和"错过截止就 abort，免得晚刷新反而变成全价写入" | **不做自动保温**。它**在用户空闲时自主花用户的钱**，而收益用户不可见。**改为做事后提示**：`cache-stats.ts:70-89` 的口径（`missedTokens = min(prevPrompt, prompt) - cacheRead`，1024 token 噪声地板，折算成钱，且压缩/换模型后重置以避免误报）是**一次算术 + 一行提示**，用户看得懂（「这轮因为 5 分钟 TTL 到期，约 12k 缓存 token 按全价重算了」）。**做提示，不做保温。** |
| 2 | **暴露词表** `direct / model-only / codemode / deferred / hidden` + `store()`/`load()`/`models.classify()`/`models.generateImages()`/`describeNamespace()` + 207 行脚本 API（`docs/extensions.md:154-160`、`docs/codemode.md`） | 无。用户不会去配 `"exposure": "codemode"` | 高 | **不做词表**。要的是**效果**（少声明、按需查找），见 P-0 的建议。Pi 自己对外也只暴露成一个字符串配置 —— 那就是可接受的上限 |
| 3 | **session tree + prompt 作为可重放 diff**（`docs/session-format.md:80`；系统提示与工具装载本身就是带 `sections`/`toolsAdded`/`toolsRemoved` 的条目，重放即得当前提示） | 崩溃后重开能接着跑、分支/fork 精确（`durable/README.md:110-113`、`:113-119` 的 `requestId` 幂等） | **极高**。我们的 `src/core/storage/`（`session-jsonl.ts` 38 KB、`event-log.ts` 48 KB、`event-projection.ts` 35 KB、`message.ts` 176 KB）**已经比 Pi 的发布版存储复杂**；改成 tree 是**重写存储契约**，不是加功能 | **不做架构**。但**偷两个便宜的点子**：(a) 把系统提示/工具装载记成**可重放的段级 diff** —— 现在我们的提示是每次从头组装的，答不了"第 40 轮实际收到的是什么提示"（诊断价值真实、改动局部）；(b) `context_edit`（`docs/session-format.md:139-147`）：**只改模型上下文**的追加式记录，原始历史/导出/账单都不动，且**分支相对、可回退**（`agent-session.ts:2994-2998` 用它做溢出修复）—— 这是"重试一次而不必对用户撒谎说没发生过"的机制，**用户能理解也能受益**，值得下轮评估 |
| 4 | **`packages/durable` + `packages/protocol`** 的强持久化与成帧协议 | 无直接感知 | 高，且**它自己标着 Experimental**：`durable/README.md:3-5`「**Experimental.** The API changes without notice between releases」；`protocol/README.md:39-41` 明写「Peer authentication ... are not implemented」+「**no compatibility guarantees**」。而且**它不是 `pi` CLI 实际运行的那套**（CLI 走 JSONL tree，durable 只在 `src/experimental/durable/` 接线） | **不做**。把一个研究运行时搬进一个"用户不能面对看不懂的机制"的产品里，方向就是错的。**注意**：它里面**有**我们真缺的耐久性保证（多条目原子提交 `README.md:83`、按步检查点的任务状态机 `:110-113`）—— 那些**思想**值得借，**实现**不搬 |
| 5 | **MCP OAuth 2.1 + 动态客户端注册 + 回环回调 + PKCE**，以及 MCP **resources**（`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`，`extensions/mcp/resources.ts:34-36`） | 连需要登录的 MCP 服务时**不用手工贴 token**；能读 MCP 资源而不只是工具 | 中（OAuth 流程 + 令牌刷新 + 回环监听） | **观察**。先确认用户实际要连的 MCP 服务里有没有需要 OAuth 的；如果只有 stdio 本地服务，这个成本换不来可感知收益。**我们有而 Pi 没有的是权限层**（`src/core/permission/`）—— Pi 的 README 明确说它没有（见 §5），这一点不能拿去交换 |
| 6 | **`packages/coding-agent` 的 extension 体系**（jiti 直接加载 TS、无构建步骤，可注册工具/命令/快捷键/provider/MCP/渲染器，`docs/extensions.md:34-48/73-86`） | 用户能"让 Pi 自己给自己写扩展"（`README.md:17`） | 高，且有**尖锐的边界**：`extensions.md:5` 明写「An extension runs inside the Pi process with the **same operating-system permissions**」，扩展能看到提示、工具调用、文件、**凭据**与会话历史 | **不做**。我们已有 `src/core/plugin-loader/` 与一套插件市场/皮肤契约，能力面不弱；Pi 的这套是"用安全换灵活"，与我们的权限模型冲突 |

---

## §4 Pi 的真正弱点（对标时不要把它当基准线）

1. **没有任何内置权限系统，而且它自己明说。** `README.md:42-43` —
   「Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access.
   By default, it runs with the permissions of the user and process that launched it.」
   替代方案是把安全**外包给容器**（`:44-48` 的 Gondolin 微 VM / 普通 Docker / OpenShell）与"项目信任"
   （`docs/security.md:29-33`，而它自己也承认信任「does not limit what tool calls can access or affect」），
   外加**示例**扩展（`examples/extensions/permission-gate.ts`、`protected-paths.ts`）。
   **我们的 `src/core/permission/`（评测器、规则、审批 broker、bash 分析器、安全模式）是真实优势，不能拿去换它的容器化哲学。**
2. **agent 进程本身没有沙箱**：`docs/extensions.md:5`、`docs/how-pi-works.md:49`。
3. **复杂度集中**：`core/agent-session.ts` 158 KB / 4348 行、`core/package-manager.ts` 87 KB；
   循环行为只能靠追四个钩子安装点（`agent-session.ts:759/858/870`）来读懂。
4. **它的 evals 不衡量编码质量**，仓库里**也没有任何自报的 token 节省数字**（§2 P-4 已说明）。
5. **两套会话系统并存**，加上 `protocol` v8 / `chord` / `server` / `client` 组成的研究栈，都不在用户关键路径上。
6. **工具面比我们薄**：核心只有八个内置工具（`core/tools/index.ts:95-105`），没有 web 搜索/抓取、subagent、
   todo/plan、LSP、computer-use、notebook（我**没有**逐一审计是否有扩展形态的等价物，故仅就 core 而言）。
7. **`run_code` 类执行是它做得比我们好的地方，也是照出我们 bug 的镜子**：Pi 的等价物是真 VM 隔离，
   而我们的 `src/core/llm/tools/run-code.ts:62` 在应用进程里 `new Function` —— 见 P-2。

---

## §5 本轮实施清单

| 序 | 项 | 状态 | 判据文件 | 变异自证（实际执行） |
|---|---|---|---|---|
| 1 | P-1 截断的 tool-call 一律不执行 | 🔄 本轮实施中 | `pi-p1-truncated-toolcall-not-executed.test.ts` | 见最终结果 |
| 2 | P-2 `run_code` 闸门接回 + 边界说实话 | ✅ | `pi-p2-run-code-permission-parity.test.ts`（11 条）+ `pi-p2b-run-code-unreadable-confirm.test.ts`（5 条） | ①`refusal = null` ⇒ `包装在 run_code 里的危险命令绝不能被真的执行: expected "vi.fn()" to not be called at all, but actually been called 1 times`；②禁掉 reject 分支 ⇒ `用户拒绝后不得写盘: ...actually been called 1 times`；③把 `in a sandboxed environment` 加回描述 ⇒ `不得声称沙箱/隔离`；④分析器 catch 改成 `return null` ⇒ fail-closed 用例变红；⑤（P2B，我复核这一层时新发现的 fail-open）把"读失败"重新当成"新文件" ⇒ `读不到不能当成「文件不存在」而跳过确认 —— 那是 fail-open: expected "vi.fn()" to be called 1 times, but got 0 times` |
| 3 | P-3 工具失败显式化 | 🟡 **部分**：具体实例已收口（`docs/DSH-ALIGNMENT-FIX-PLAN.md` 的 D8/D9/D10/D10b 共 11 处路径），**"**`isError` **必填化"的普查判据未做** | `dsh-d10b-tool-failure-class.test.ts`（13 条） | 3 组变异，红点与所修路径 1:1 |
| 4 | P-4 成对评测尺子（开发者侧工具） | ✅ | `tools/eval/paired-report.selftest.mjs`（19 条）+ `paired-report.mutation.mjs` | **5/5 咬住**：缺数据当 0 / 空平均当 0 / 去掉阻塞检查 / 去掉重复次数检查 / 差值方向搞反，每一条都红了 |
| 5 | P-0 更正交接单对 Codemode 的转述 | ✅ | 本文 §2 P-0 | 纯文档 |

**P-2 实施中发现的两条超出原描述的加重项**（由实施者与我的核查共同确认，详见 §2 P-2）：
`sdk.write` 还绕过了真 `write` 工具的**受保护路径拒绝**（`.git/.env/node_modules`）；
以及同一条链路上 **`workflow-engine.ts:120-133` 的 `createWorkflowTool()` 有完全相同的开口**（已注册给 LLM，见 `tools.ts:2055`），
`run_code` 已关、**`workflow` 仍然敞着** —— 已记入 §4 与 `docs/DSH-PI-FEATURE-SUGGESTIONS.md`，**本轮未修**。

**P-2 之后仍然不设防的部分（诚实声明，不要读成"已修好"）**：
执行仍然是应用进程内的 `new Function`（`run-code.ts` 的 `executeCode`），**全局白名单不是安全边界**；
`run_code` 内只有 bash 与 write 接了闸门，`sdk.read/glob/grep/fetch` 仍是直连（无 workspace 检查、`sdk.fetch` 无出网限制）；
非危险命令的嵌套 bash **仍不做权限评估**（真管线的 `checkPermission` 不会被进入）。所以这不是与 Pi 的 `ctx.executeTool` 的完全等价 —— 是**把最危险的门关上了 + 把话说实了**。

---

## §6 结论：Pi 值不值得我们学的三件事

1. **学它的「评测方法学」，不学它的评测用例。** `packages/evals` 本身只做文档 lift 对照，
   但 `report.ts` + `plan.ts` 里的**成对差值 + "成对样本不足就拒绝给结论"**正是我们缺的、
   且是唯一现成的、能把用户那条验收标准变成可判真假的方法学。价值全在开发者侧、用户侧零可见面，
   完全符合「不要太复杂」。**做**，按模式移植而不按包移植。
2. **学它的「工具输出与工具声明的 token 纪律」，不学它的暴露词表。** 三件可独立落地且用户能感知的事：
   ① 截断的 tool-call 参数**一律不执行**（`agent-loop.ts:471-503`，代价最低、纯保护、用户完全看不见，= P-1）；
   ② 给声明的工具 schema 设**硬预算**并按命名空间分组（`tool.ts:154`、`:205-228`）；
   ③ 在工具边界**一次做对**截断并落盘完整输出（`truncate.ts:11-12`、`bash.ts:342-353`）。
   反过来，五值暴露词表、`store()/load()`、`models.classify()`、207 行脚本 API —— **要效果，不要词汇表**。
3. **学它的「一次失败的可逆性」，不学它的存储架构。** 最值钱的具体机制是 `context_edit` + 溢出重试：
   把一次失败尝试从**模型上下文**里摘掉，而原始历史、导出、账单都不动，且编辑分支相对、可回退
   （`docs/session-format.md:139-147`、`agent-session.ts:2994-2998`）。**不要**跟着做 session tree 重写（§3 第 3 条）。
   同时明确不抄：prompt cache **自动保温**（它的**事后提示**值得做，**自动保温**只值得作为显式 opt-in）、
   以及 Pi 整套**权限缺失**（那是我们的优势）。
