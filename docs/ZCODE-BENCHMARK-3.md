# 第三轮对标审计：工具契约维度（zcode / DSH / 我方）

> 对象：`zai-org/ZCode` v3.14.3（commit `29628c9a`，本地 `.preview-shot/_zcode-ref`）
> 基线：DSH（`.deepseek-harness-ref/packages/`）
> 我方：本仓库，**已完成工具契约化（1.16.204）之后**的状态
> 方法：全部结论附 `文件:行号` + 逐字原文。**本轮先修上一轮的一处错误**（见 §0）。

---

## 0. 先更正上一轮的一处错误

上一轮我写道：

> 两边都读了声明，但都留了名字回退

**这对 zcode 成立，对 DSH 不成立。** DSH 是无条件纯声明：

`core/tools/src/index.ts:259-269`：

```
* Pure synchronous classifier for overlap with sibling tool calls. Only
* `true` opts in; omission, exceptions, non-`true` returns, and invalid
* `defineTool` arguments are exclusive.
```

没有名字名单，也不接受「可读性推断」。zcode 才是「声明优先 + 名字兜底」（`scheduler.ts:97`：`tool.readOnly ?? this.readOnlyTools.has(tool.toolName!)`）。

**我们的形态与 zcode 一致**（`isConcurrencySafe()` 的契约优先、名字兜底），这个选择本身没问题——但下面 §3 会说明 zcode 的兜底表里有个坑，我们**没有**踩。

---

## 1. 结论摘要

契约化之后，我们在**字段完备度**上已经超过 zcode（它有 15 个字段、其中若干无消费者；我们只有 6 个、每个都有消费者且被门禁守着）。

本轮审计发现 **4 处真实差异**，其中 **1 处是语义判定错误（我们错了）**，**2 处是能力缺口**，**1 处是我们比两边都好的地方**。

| # | 差异 | 谁更好 | 严重度 |
| --- | --- | --- | --- |
| A | `sideEffectScope` 语义：我们把「访问了什么」和「改了什么」混成一个字段 | **zcode 更严谨** | 中 |
| B | 输出契约：我们有框架但 **0 个工具注册、校验不拦**；DSH 是**必填 + 抛错** | **DSH ≫ 我们** | 高 |
| C | 入参归一化：两边都有这一步（zcode 位置有讲究），**我们没有** | **两边都比我们全** | 中 |
| D | 单一判据入口：zcode 有 `canRunInParallel()` 一处，我们**散在 7 处**且含按名特例 | **zcode 更收敛** | 中 |
| E | 契约字段必须有消费者（门禁） | **我们独有，两边都没有** | — |

---

## 2. 差异 A：`sideEffectScope` 的语义——**我们错了**

### 事实

zcode `tool/handlers/read.ts:470-475`：

```ts
readOnly: true,
destructive: false,
concurrentSafe: true,
timeoutMs: 30000,
maxOutputBytes: READ_MAX_FILE_SIZE_BYTES,
sideEffectScope: "none",        // ← 读文件，但作用域是 none
```

`grep.ts:145-150`、`glob.ts:90-95` 完全相同（都是 `sideEffectScope: "none"`）。

而 `bash.ts:451-456`：

```ts
readOnly: false,
destructive: false,
concurrentSafe: false,
timeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
maxOutputBytes: 10_000_000,
sideEffectScope: "system",
```

### 判据

`tool/scheduler.ts:97-102` 把只读与作用域**联合**起来用：

```ts
const readOnly = tool.readOnly ?? (hasToolName ? this.readOnlyTools.has(tool.toolName!) : false);
if (tool.destructive) return false;
if (tool.concurrentSafe === true) return true;
if (tool.concurrentSafe === false) return false;
if (readOnly) return true;
return tool.sideEffectScope === "none";
```

以及 `runtime/methods/tools.ts:50-53`：

```ts
readOnly:
  metadata?.readOnly === undefined
    ? undefined
    : metadata.readOnly && sideEffectScope === "none",   // ← 联合判定
```

**所以在 zcode 的语义里 `sideEffectScope` = 「会不会**改变**外部状态」**：读文件不改变任何东西 ⇒ `"none"`（尽管它访问了文件系统）。

### 我们的实现

`tool-contract.ts` 的字段注释：

```ts
/** 副作用范围。`none`：不碰外部世界（纯计算、查询内存态）。...
 *  `workspace`：读写工作区文件（`write` / `edit` / `read` / `glob` …）。 */
```

我们用 `"workspace"` 表示「**访问**工作区」——于是 19 个只读工具全是 `scope != "none"`：

```
read / grep / glob / lsp / read_attachment    scope=workspace
web_search / fact_check / figma_fetch         scope=network
session_search / session_trace / get_goal …   scope=session
terminal_list / terminal_read / cordis_inspect scope=system
```

实测：**51 个工具里 19 个是「只读但 scope != none」**。若照 zcode 的 `readOnly && scope === "none"` 判据，这 19 个只读工具**全部会被判为不可并发**——把最该并行的东西串行化。

（注：zcode 靠 `concurrentSafe: true` 短路救回来了，所以它**实际行为**没错。但那条联合判据是**诱导性的错误抽象**：它把「只读」与「作用域为 none」当成同一件事。）

### 为什么会混——不是笔误，是承重的

我们的 `sideEffectScope` 被**两个真实消费者**用来做「要不要管这个工具」的粗筛：

`tool-pipeline.ts:486`（沙箱）：

```ts
if (contract.sideEffectScope === "none") return { action: "proceed" };
```

`tool-pipeline.ts:586`（计划模式认「哪些是 shell 类」）：

```ts
const isShellLike = toolName === "bash" || contract.sideEffectScope === "system";
```

**`read` 必须能过沙箱的路径检查**（沙箱要拦「读工作区外的文件」）。而按 zcode 语义 `read` 应当是 `"none"` ⇒ 会被这行**直接放行、完全绕过沙箱路径检查**。

**【这是我的推断，标注清楚】**：代码里没有一句话写「所以 read 标 workspace 是为了让沙箱覆盖读操作」。但机制上是成立的、且是**唯一**能让 `read` 受沙箱路径检查约束的写法——契约化之前沙箱那份名单里就明确有 `read`（`readTools` 数组），契约化时必须等价地表达出来，否则就是**沙箱覆盖缩水**。所以「标 `workspace` 是承重的」这个结论可靠；「当初是刻意这么设计的」这一层是推断。

### 建议

**把两个概念拆开，别在一个字段里塞两件事。**

方案（推荐）：`sideEffectScope` 回归 zcode 语义（改了什么），另加 `accessScope`（访问了什么边界）供沙箱用。

| 字段 | 语义 | 消费者 |
| --- | --- | --- |
| `sideEffectScope` | **改变**了哪类外部状态（`none` = 不改） | 并发判定、计划模式、快照 |
| `accessScope` | **访问**了哪类边界 | 沙箱（路径检查的粗筛） |

重构后的读数会变成：

```
read    { readOnly: true, sideEffectScope: "none", accessScope: "workspace" }
write   { readOnly: false, sideEffectScope: "workspace", accessScope: "workspace" }
web_search { readOnly: true, sideEffectScope: "none", accessScope: "network" }
bash    { readOnly: false, sideEffectScope: "system", accessScope: "system" }
```

好处有三：①并发判据可以简化成 zcode 那种「`readOnly || scope === "none"`」而**不会**误伤只读工具；②沙箱不再靠「scope != none」这种间接推断；③两个概念各自可被门禁守住（例如「`readOnly: true` 的工具 `sideEffectScope` 必须是 `none`」——这条在拆分之后才是**真判据**，现在写不了）。

**顺便补一个我们缺的枚举值**：zcode 的 `ToolSideEffectScope` 有 `"userInteraction"`（`contracts/src/tools/contract.ts:7`），我们没有。它有真实消费者——zcode 的 `READ_ONLY_TOOLS` 里 `AskUserQuestion` 是「只读」但显然**永不并发**（会阻塞等用户）。我们靠「不标 readOnly」隐式表达同一件事，但那样就丢掉了「它其实无副作用、只是会阻塞」这个信息。

---

## 3. 差异 B：输出契约——**DSH 远强于我们**

### 我们的实际状态（三条都是实测）

1. **框架存在**：`output-contract.ts` 有 `OutputSchema` / `validateOutput` / `validateToolOutput` / `registerOutputContract`。
2. **管线真的调了**：`tool-pipeline.ts:951` 注册了 `OutputContractValidationMiddleware`，`:699` 调 `validateToolOutput`。
3. **但零个工具注册过契约**：全仓 `registerOutputContract(` 只出现在 `cookbook.ts` 的示例代码里。

于是 `validateToolOutput` 永远命中这一行并返回：

```ts
const contract = outputContracts.get(toolName);
if (!contract?.schema) {
  return { valid: true, errors: [] };   // ← 恒真
}
```

**即使验失败，也只 `console.warn` 不拦**（`tool-pipeline.ts:700-702`）。

### DSH 的做法

`core/tools/src/index.ts:222-224`：

```ts
export interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
```

`ToolOutputDefinition`（`:212-219`）三件套：

```ts
readonly schema: JsonSchemaNode                                   // 必填
render(args, value): ContentBlock[]                               // 结构化值 → 模型可见内容
presentationMeta?(args, value): JsonValue                         // 纯函数、可重放
```

违反时**抛错**（`:1795-1796`）：

```ts
const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
```

而且 `schema` 描述的是**结构化值**（`execute` 返回 `Promise<unknown>`，由 `output.schema` 界定），`render` 才负责变成给模型看的文本。

### 根因：我们的工具结果是**不透明字符串**

`types.ts`：

```ts
export interface ToolCallResult {
  output?: string;      // ← 只有字符串
  ...
}
```

没有结构化值这一层。这带来一串下游后果：

- **无法校验**：没有「值」就没有可校验对象；`output-contract` 即使注册了契约，也只能去 parse 字符串（它不是这么设计的）。
- **字符串嗅探扩散**：`micro-compact.ts` 必须靠正则从文本里抠出文件路径、退出码、命令（`:214-230`），因为它拿不到结构化字段。
- **`spill` 只能按字节数截**：无法按语义字段裁剪。
- **结果展示/回执**（`tool_complete` 的渲染）也只能拿字符串猜。

### 建议（这是本轮最值钱的一条）

**给工具结果加结构化 `value`，分三步，每步都能独立交付：**

1. **加字段不改行为**：`ToolCallResult` 增加可选 `value?: unknown` 与 `meta?: JsonValue`（照 DSH）。工具可以**逐步**开始返回它；没有 `value` 的老工具照旧走 `output` 字符串。
2. **把 `output-contract.ts` 接真**：至少给**高频且结果结构化**的几个工具注册契约（`read` / `grep` / `glob` / `bash` / `job_*`），并**把校验从 `warn` 改成按策略拦截**（先只用 `error` 级别告警 + 计数上报，验证无假阳性后再拦）。
3. **让 `micro-compact` / `spill` 改读结构化字段**，删掉那些正则嗅探。

**不要**一次给 156 个工具补 `output.schema`（DSH 是必填，我们做不到一步到位）。逐步推进，但**每个注册了契约的工具就多一份真实保障**。

---

## 4. 差异 C：入参归一化——两边都有，我们没有

### zcode 把它做成管线里显式一步，位置是刻意的

`tool/executor/call-runner.ts` 的顺序：

```
171  let executionInput = preparedInitialInput.input;
175  validateInitialModelToolInput(executionInput, entry, …)   // schema 校验
230  executionInput = resolution.input;                         // ← 归一化
     runPreToolUseHooks(…, executionInput, …)                  // hook
     （之后权限、prepareApproval、handler）
```

`types.ts` 对 `normalizeInput` 的注释（逐字）：

> 把模型发出的入参**归一化成将要发生的执行事实**。executor 在 `validateInput` 之后、PreToolUse hook 之前调用，返回值直接替换 `executionInput`。
>
> **位置就是全部的意义。** 此后 hook、项目权限规则、权限事件载荷、`prepareApproval`、handler 读到的都是同一份归一化输入。

### 我们的状态

全仓搜 `normalizeInput|normalizeToolInput|canonicalInput|normalizeArgs`：**零命中**。

而我们在**用散落的容错代替它**（实测）：

```ts
tool-pipeline.ts:492   const path = (args.path || args.file_path) as string;
tool-pipeline.ts:588   const command = String((args as any)?.command ?? (args as any)?.cmd ?? "");
tools.ts:847           let command = args.command as string;          // ← 不接受 cmd！
agentic-loop.ts:954    typeof args.command === "string" ? args.command  // ← 不接受 cmd
```

**后果是同一份入参在不同层被解释成不同的东西**：命令分析器接受 `cmd` 别名，但 `tools.ts` 的直接执行路径不认 `cmd`。模型写 `{cmd: "..."}` 时，权限/计划模式看到命令、执行层看到空——**这是一致性缺口，不是假想问题**（我们上个月刚修过同形态的 `$` 记号与 `oldString` 问题）。

### 建议

加一个**每工具可选的 `normalizeInput(args)`**，插在管线里 `validateInput`（若有）之后、**权限/hook 之前**，返回值**替换**后续所有层看到的入参。然后：

- 把 `path || file_path`、`command ?? cmd` 这类容错**收进各自的归一化函数**，删掉散落点；
- 门禁：断言「归一化之后的入参在所有消费者处是同一个对象」（可做成结构性判据：消费者不再写 `args.cmd`）。

zcode 那句「位置就是全部的意义」值得原样抄进注释。

---

## 5. 差异 D：判据入口散在 7 处，且已经长出按名特例

### zcode：一处

只有 `scheduler.ts:85-103` 的 `canRunInParallel()` 一个判定点；`batch-runner.ts` 不再重复判定（唯一引用是注释里解释旧策略）。结果是**没有第二处真相**。

### 我们：7 个读取点，各自写判据

```
tool-pipeline.ts:486    contract.sideEffectScope === "none"            (沙箱粗筛)
tool-pipeline.ts:506    contract.destructive ? … : contract.readOnly ? …  (文案)
tool-pipeline.ts:586    toolName === "bash" || scope === "system"      (shell 类：含按名特例!)
tool-pipeline.ts:633    !contract.readOnly                             (计划模式)
agentic-loop.ts:2649    scope === "workspace" && !readOnly              (快照)
streaming-executor.ts   contract.concurrencySafe                        (并发)
tool-result-storage.ts  contract.persistResult                          (落盘)
```

**而且已经出现了按工具名的特例**：`tool-pipeline.ts:586` 的 `toolName === "bash" ||`。这一条的存在本身就是信号——它说明「shell 类」这个概念**没有被契约表达出来**，只好回到按名硬编码。这正是我们这轮要消灭的形态，它在契约化当天就重新长了出来。

### 建议

把判据收敛成**命名谓词**（`tool-contract.ts` 里），各消费者只调用它：

```ts
canRunInParallel(contract, args?)      // 并发
requiresPathGuard(contract)            // 沙箱是否介入（替代 scope !== "none" 的间接推断）
mutatesWorkspace(contract)             // 快照
isShellLike(toolName, contract)        // 若能由契约表达，就不要带 toolName
shouldPersist(contract)                // 落盘
```

好处是**门禁可以打在谓词上而不是打在 7 个调用点**，并且 `toolName === "bash"` 这类特例会被迫显式化（要么进契约，要么写明理由）。

---

## 6. 差异 E：我们比两边都好的地方（保持）

**「每个契约字段必须有真实消费者」这门禁，zcode 和 DSH 都没有。**

zcode 的 `ToolMetadata` 有 15 个字段，其中至少 `riskLevel` / `needsApproval` / `providerVisible` / `modelInstructions` / `stopOnTurnSuccess` 在我们这套架构里**没有对应消费者**；DSH 相对收敛但也有 `presentationMeta` / `providerNative` 这类可选面。

我们有 `src/test/tool-contract-consumers.test.ts`：从 `ToolContract` 接口**解析出字段名**（不是手写清单），断言每个字段都在非解析器文件里被读取过。变异验证：加一个没有消费者的 `riskLevel` 字段 ⇒ 当场红。

**这正是防止「把七组名单换成一堆空壳字段」的那道闸。** 建议保持，并且在按 §2 拆出 `accessScope` 时**先想清谁读它**（沙箱那处要同步改成读新字段，否则新字段立刻是个空壳、门禁会红——这是门禁在正常工作，不是障碍）。

---

## 7. 优化建议（按性价比）

### P0 — 语义正确性，改动小

| # | 事项 | 依据 |
| --- | --- | --- |
| 1 | **拆开 `sideEffectScope`**：回归 zcode 语义（改了什么），新增 `accessScope`（访问了什么）供沙箱用；补 `"userInteraction"` 枚举值 | §2。当前把「只读」与「作用域 none」混为一谈，是**语义错误**（zcode 靠 `concurrentSafe` 短路才没出事） |
| 2 | **收敛判据入口**：`canRunInParallel` / `requiresPathGuard` / `mutatesWorkspace` / `shouldPersist` 做成命名谓词，消费者只调用它们；把 `toolName === "bash"` 特例显式化 | §5。契约化当天就长回了按名特例，说明缺这一层 |

### P1 — 能力缺口，需要一点设计

| # | 事项 | 依据 |
| --- | --- | --- |
| 3 | **工具结果加结构化 `value` / `meta`**（新增可选字段，老工具不变），并把 `output-contract` 从「恒真」接到真校验上 | §3。这是最值钱的一条：没有结构化值，`micro-compact`/`spill`/结果展示都只能靠字符串嗅探 |
| 4 | **加 `normalizeInput` 管线步骤**，位置在权限/hook 之前；把 `path‖file_path`、`command‖cmd` 的散落容错收进归一化函数 | §4。我们目前**用散落容错代替归一化**，不同层对同一份入参解释不同 |

### P2 — 长期

| # | 事项 | 依据 |
| --- | --- | --- |
| 5 | 给高频工具逐步注册 `output.schema`，成熟后再考虑强制 | §3。DSH 必填是终态，不是起点 |
| 6 | 权限声明从「`agent.ts` 里的规则表」迁到工具自己身上（zcode 有 `needsApproval` / `riskLevel` / `resolvePermissionCapability`） | §8。否则工具注册表与权限表是**两份会漂移的真相** |

---

## 8. 附：本轮核证过、确认**不是**缺口的

避免下一轮又被重新提起：

| 项 | 核证结果 |
| --- | --- |
| **zcode 的 `dependencies` + 拓扑排序** | ❌ **不是我们的缺口**。`runtime/methods/tools.ts:49` 硬编码 `dependsOn: []`（全仓仅此一处赋值），所以工具调度**永远进入同一层**，拓扑排序与 `validateNoCycles` 在工具路径上**不生效**。那套机制是给 `workflow/` 的节点图用的（`contracts/src/workflow/index.ts`）。不必抄。 |
| **zcode 的 rolling pool** | ✅ 已对齐（1.16.203）。两边都是「有界窗口 + 完成即补位」。 |
| **并发上限 10** | ✅ 已对齐。且实测历史分布最大并发 4，这个数字当前不是瓶颈。 |
| **`destructive` 一票否决并发** | ✅ 已对齐（我们 `resolveToolContract` 里 `destructive ⇒ concurrencySafe = false`）。 |
| **`timeoutMs` / `maxOutputBytes` 按工具声明** | ✅ 已对齐（我们 `timeoutMs`；`maxOutputBytes` 等价的机制是 `maxResultSizeChars` + spill 的 `maxInlineBytes`）。 |
| **`stopOnTurnSuccess`（成功即终结本轮）** | ⬜ 我们**没有**。但当前也没有「终态工具」这种需求（zcode 只给 `submit_result` 用）。**不列建议**，等有真实消费者再说——否则就是空壳字段。 |

---

## 9. 一句话总结

契约化之后，**字段完备度我们不输任何一边**（6 个字段、每个都有消费者、还有门禁守着），**但三处结构性差距仍在**：

1. **语义错误**：`sideEffectScope` 混了「改了什么」和「访问了什么」（§2，建议立刻拆）；
2. **能力缺口**：工具结果是**不透明字符串** ⇒ 输出契约形同虚设、下游只能字符串嗅探（§3，最值钱）；
3. **能力缺口**：**没有入参归一化** ⇒ 同一份入参在不同层被解释成不同东西（§4）。

zcode 的 `dependencies`/拓扑排序看着唬人，但它自己的工具路径上 `dependsOn` 恒为空 —— **那不是差距，是没启用的机制**。不必抄。
