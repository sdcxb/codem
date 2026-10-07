/**
 * 工具契约 —— 把「这个工具是什么」从**七组硬编码名单**里搬回工具自己身上。
 *
 * ## 为什么要有这个文件
 *
 * 在契约化之前，「某个工具是否可并发 / 是否只读 / 有没有超时 / 要不要落盘」
 * 这些事实分散在 **7 组、19 个定义点**的硬编码名单里：
 *
 * | 名单 | 位置 |
 * | --- | --- |
 * | 并发安全 | `concurrency-policy.ts`、`streaming-executor.ts` |
 * | 沙箱覆盖（读/写） | `tool-pipeline.ts` 的 `SandboxGuard` |
 * | 超时豁免 | `streaming-executor.ts` 的 `noTimeoutTools`（**两份，且已经漂移**） |
 * | 落盘豁免 | `tool-result-storage.ts` 的 `NEVER_PERSIST_TOOLS` |
 * | micro-compact | `micro-compact.ts` 的 `COMPACTABLE_TOOLS` / `NEVER_COMPACT_TOOLS` |
 * | 计划模式写工具 | `tool-pipeline.ts` 的 `PlanModeGuard` |
 * | recon 工具 | `agentic-loop.ts` 的 `RECON_TOOL_NAMES` |
 *
 * **失败机制很具体**：新增工具要往 5–7 处登记，漏一处**不报错、不警告**，
 * 只是那个工具静默地少一项能力。本仓已经因此栽过三次：
 * `web_search`（真实只读却不在并发名单里 → 一直被串行）、
 * `lsp_tool`（权限规则从未命中）、`read_attachment`（沙箱名单加了也不生效）。
 *
 * 更直接的证据：`noTimeoutTools` 那份名单在 `runOneTool` 与 `executeSingle`
 * 里**各写了一份、内容还不一样**（前者 11 个、后者 6 个）——同一批工具走不同
 * 执行路径就有不同超时行为。这正是多份真相的必然结果。
 *
 * ## 取向：声明优先，缺省保守（照 zcode / DSH 的成熟做法）
 *
 * - zcode `core/src/tool/types.ts` 的 `ToolMetadata` 把 `readOnly` / `destructive` /
 *   `concurrentSafe` / `sideEffectScope` / `timeoutMs` / `maxOutputBytes` 定为工具属性，
 *   注释写明「**由 executor 读取，而不是在调用点按工具名猜测**」；
 * - DSH 更收敛（只有 `isConcurrencySafe?(args)` / `timeoutMs?` / 必填 `output`），
 *   且注释明确 **只有显式 `true` 才并行，缺省即独占**。
 *
 * 我们两者取齐：**字段全部可选，缺省值一律落在安全侧**（不并发、要超时、
 * 不豁免落盘），需要「特权」的工具显式声明。于是「漏声明」＝「少一项优化」，
 * 而不是「行为取决于你漏了哪个名单」。
 *
 * ## 第 121 轮：把「改了什么」和「访问了什么」拆成两个字段
 *
 * 契约化第一版只有一个 `sideEffectScope`，而我们拿它同时表达了：
 * ①「这个工具会改变哪类状态」（并发/快照/计划模式要的）；
 * ②「这个工具会碰到哪类边界」（沙箱要的）。
 *
 * 这两件事**正交**，混在一起导致实测 51 个工具里 `"none"` 的有 **0 个** ——
 * 字段名是「副作用」，实际全被填成了「访问边界」，于是沙箱那个粗筛一次都不命中，
 * 字段对沙箱毫无区分能力。现在拆开：`sideEffectScope`（改了什么，zcode 同义）+
 * `accessScope`（访问了什么，只有沙箱读）。
 */

/**
 * **副作用**范围 —— 这个工具会**改变**哪一类外部状态。
 *
 * ## 语义定义（第 121 轮修正，此前我们把它用错了）
 *
 * `"none"` = **不改变任何外部状态**。注意：读文件**不改**任何东西 ⇒ `read` 是 `"none"`，
 * 尽管它访问了文件系统。「访问」是另一个字段（`accessScope`）的事。
 *
 * zcode 同义（`tool/handlers/read.ts:470-475`：`readOnly: true, sideEffectScope: "none"`；
 * `bash.ts:451-456`：`readOnly: false, sideEffectScope: "system"`）。
 *
 * ## 我们此前为什么用错了
 *
 * `read` / `grep` / `glob` / `web_search` 等 19 个只读工具全被标成了
 * `"workspace"` / `"network"` —— 因为 `SandboxGuard` 拿这个字段当「要不要做路径检查」的
 * 粗筛（`if (scope === "none") return proceed`），而 `read` **必须**能过沙箱。
 * 拆字段之后沙箱改读 `accessScope`，这个字段才回到它该有的语义。
 *
 * ## 与 zcode 的一处差异（有意保留）
 *
 * zcode 把 `readOnly && sideEffectScope === "none"` **联合**起来当「可并发」判据
 * （`tool/scheduler.ts:97-102`、`runtime/methods/tools.ts:50-53`）。
 * **我们不这么做** —— 那个联合是多余且诱导性的：`readOnly` 本身已是正确判据，
 * 联合只会导出「只读但访问文件 ⇒ 不可并发」这种错误结论（zcode 自己靠
 * `concurrentSafe: true` 短路才没出事）。我们保持 `readOnly` 独立判定。
 */
type ToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

/**
 * **访问**范围 —— 这个工具会碰到哪一类外部边界（只读也算）。
 *
 * 与 `sideEffectScope` 正交：`read` 是 `sideEffectScope: "none"` +
 * `accessScope: "workspace"`。
 *
 * 消费者是 `SandboxGuard`：`accessScope !== "none"` 时守卫尝试做路径检查；
 * 取不到 `path` 则放行 —— 那是「按 id 访问的资源」的固有边界（附件），
 * 见 `sandbox-boundary.test.ts` 的产品决策。
 */
type ToolAccessScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session";

/** `timeoutMs` 的哨兵值：显式声明「本工具不设超时」。 */
export const NO_TIMEOUT = -1;

/**
 * 工具契约字段。全部可选，缺省值在 `resolveToolContract` 里统一落定。
 */
export interface ToolContract {
  /** 只读：不修改任何持久状态。只读工具可并发、权限可自动放行。 */
  readOnly?: boolean;
  /**
   * 破坏性：可能造成**不可逆**损失（删文件、改历史、覆盖未备份内容）。
   * 破坏性工具一律独占执行，且**即使声明了 `concurrencySafe` 也不生效**。
   */
  destructive?: boolean;
  /**
   * 可与其他调用并发。
   *
   * 缺省（`undefined`）时**按 `readOnly` 推导**：只读 ⇒ 可并发，否则独占。
   * 显式 `false` 可让一个只读工具也独占（例如它依赖全局可变缓存）。
   */
  concurrencySafe?: boolean;
  /**
   * **改变**了哪类外部状态。`"none"` = 不改（读操作就是 `"none"`）。
   * 缺省：`readOnly` 为真 ⇒ `"none"`，否则 `"workspace"`。
   */
  sideEffectScope?: ToolSideEffectScope;
  /**
   * **访问**了哪类边界（只读也算）。缺省 `"workspace"`。
   *
   * 只读且不碰文件系统的工具（`web_search`、`get_goal`、`job_list` …）
   * **应该**显式写出来，否则沙箱会对它白做一次路径检查（取不到 path 就放行，
   * 行为没错但分类不准）。
   */
  accessScope?: ToolAccessScope;
  /**
   * 会阻塞等用户输入（提问、确认框）。
   *
   * 为什么要单独一个字段：这类工具**无副作用**（`readOnly` 可以是 true）却
   * **永远不能与别的调用并发** —— 它等的是人，人不会因为并行就答得更快；
   * 更要紧的是它若与「等用户同意写文件」的确认框并发，两个框会互相盖住。
   *
   * zcode 用 `ToolSideEffectScope` 里的 `"userInteraction"` 表达同一件事。
   */
  blocksOnUserInput?: boolean;
  /**
   * 超时预算（毫秒）。缺省用执行器的 `toolTimeout`；
   * 要「永不超时」必须显式写 `NO_TIMEOUT`。
   */
  timeoutMs?: number;
  /**
   * 超大结果是否落盘（换成预览 + 定位说明）。
   *
   * 缺省 `true`（落盘）。少数工具必须**不**落盘，否则会形成
   * 「落盘 → 模型 read 回来 → 又落盘」的循环（`read` 就是典型），
   * 或者结果本身就是一个短标识符（子智能体 id），落盘反而让模型拿不到它。
   */
  persistResult?: boolean;
  /**
   * 模型入参的**归一化**：把模型发出的参数整理成「将要发生的事实」，
   * 返回值**替换**后续所有层（权限 / hook / 守卫 / handler）看到的入参。
   *
   * **位置是全部的意义**（照 zcode `tool/executor/call-runner.ts` 的 `normalizeInput`）：
   * 必须在**权限判定之前**，否则权限层与执行层可能对同一份入参得出不同结论。
   * zcode 的原话：「此后 hook、项目权限规则、权限事件载荷、`prepareApproval`、
   * handler 读到的都是同一份归一化输入」。
   *
   * 典型用途：参数别名（`cmd` → `command`）、相对路径 → 绝对路径、
   * 补齐隐含默认值。**抛错即视为入参非法**（会被转成可行动的错误回给模型）。
   */
  normalizeInput?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * **声明式结果契约**（第 121 轮新增，照 DSH 的 `output.schema`）。
   *
   * 声明之后，工具的 `execute` 应当返回结构化 `value`，管线会：
   * 1. 用 `outputSchema` **校验** `value`（不合法 ⇒ 拦下并如实报错）；
   * 2. 用 `renderOutput`（缺省用内置的通用渲染）生成给模型看的 `output`；
   * 3. 把 `value` 保留在结果上，供下游**结构化**消费（不再字符串嗅探）。
   *
   * **没有声明的工具行为零变化**（只填 `output` 字符串照旧可用）。
   * 这是有意的渐进路径：DSH 把 `output` 定为必填是它的**终态**，
   * 我们有 156 个工具，一步到位不现实；但**每注册一个就多一份真实保障**。
   *
   * 支持的 JSON Schema 子集见 `output-value.ts`（type / properties / required /
   * items / enum / additionalProperties）——刻意只支持够用的一小撮，
   * 不引入完整 schema 引擎。
   */
  outputSchema?: Record<string, unknown>;
  /**
   * 把校验过的 `value` 渲染成给模型看的文本。
   *
   * 缺省由 `renderOutputValue()` 通用渲染（对象逐字段、数组逐行）。
   * 需要特定排版（表格、Markdown、只挑关键字段）的工具自己提供。
   *
   * 必须是**纯函数**：同样的 `value` 永远渲染出同样的文本（否则重放/hash 会漂）。
   */
  renderOutput?: (value: unknown) => string;
}

/** 解析后的契约：每个字段都有确定的布尔/数值，消费者不需要再各自补默认值。 */
export interface ResolvedToolContract {
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  sideEffectScope: ToolSideEffectScope;
  accessScope: ToolAccessScope;
  blocksOnUserInput: boolean;
  /**
   * 声明的超时预算。`undefined` = **没声明**（消费者用它自己的默认值）；
   * `NO_TIMEOUT` = 明确不设超时；其它数值 = 该工具的预算。
   *
   * 刻意不把 `undefined` 归一成 `0`：「没声明」与「声明 0 毫秒」是两件事，
   * 混在一起会让消费者无法判断该不该套用自己的默认值。
   * 判断一律走 `resolveToolTimeout()`。
   */
  timeoutMs: number | undefined;
  persistResult: boolean;
}

/**
 * 运行时注册的工具（MCP 等）不可能带声明，只能按名字兜底。
 *
 * 这张表**故意保持很短**，且每加一条都要写清「为什么它必须在这里」。
 * 它与 `concurrency-policy.ts` 的 `DYNAMIC_TOOL_ID_ALLOWLIST` 是同一类例外。
 */
const UNKNOWN_TOOL_FALLBACK_READONLY: readonly string[] = [
  // zvec-grep MCP 在运行时注册，只读搜索工具（见 concurrency-policy.ts 的同类说明）
  "zvec_grep_search",
  "zvec_grep_rg",
];

/** 没有任何声明的外部工具（MCP / 动态注册）按名字判断是否只读。 */
function isFallbackReadOnly(name: string): boolean {
  return UNKNOWN_TOOL_FALLBACK_READONLY.includes(name);
}

/**
 * 把（可能不完整的）契约解析成完整契约。**所有字段的缺省值都在这里落定**，
 * 消费者不该再各自补一遍（那正是本文件要消灭的「多份真相」）。
 *
 * ## 并发判定的优先级（照 zcode `scheduler.ts:97-102`，但默认值更保守）
 *
 * 1. `destructive === true` ⇒ 永不并发（一票否决，即使声明了 `concurrencySafe`）
 * 2. `blocksOnUserInput === true` ⇒ 永不并发（等用户的东西不能并行）
 * 3. `concurrencySafe` 显式给了 ⇒ 用它
 * 4. 否则 `readOnly === true` ⇒ 可并发
 * 5. 否则独占
 *
 * 注意第 4 步**只看 `readOnly`**，不看 `sideEffectScope` —— 见文件头「与 zcode 的
 * 一处差异」。第 5 步也**不再**接受 `sideEffectScope === "none"` 作为可并发依据：
 * 拆字段之后 `"none"` 是「无副作用」，而一个会阻塞等用户输入的无副作用工具
 * （`ask_clarification`）显然不该并发 —— 用 `blocksOnUserInput` 显式表达。
 *
 * `readOnly` 与 `destructive` 互斥检查不在这里做 —— 那是**声明本身有问题**，
 * 由 `src/test/tool-contract.test.ts` 的门禁直接判红，而不是运行时悄悄修正。
 */
export function resolveToolContract(
  contract: ToolContract | undefined,
  toolName: string,
): ResolvedToolContract {
  const c = contract ?? {};

  const readOnly = c.readOnly ?? isFallbackReadOnly(toolName);
  const destructive = c.destructive ?? false;
  const blocksOnUserInput = c.blocksOnUserInput ?? false;
  const sideEffectScope: ToolSideEffectScope =
    c.sideEffectScope ?? (readOnly ? "none" : "workspace");
  // 访问范围与副作用无关：只读的 `read` 同样访问 workspace（沙箱要拦工作区外读取）
  const accessScope: ToolAccessScope = c.accessScope ?? "workspace";

  let concurrencySafe: boolean;
  if (destructive) {
    concurrencySafe = false;
  } else if (blocksOnUserInput) {
    concurrencySafe = false;
  } else if (c.concurrencySafe !== undefined) {
    concurrencySafe = c.concurrencySafe;
  } else {
    concurrencySafe = readOnly;
  }

  return {
    readOnly,
    destructive,
    concurrencySafe,
    sideEffectScope,
    accessScope,
    blocksOnUserInput,
    // 保持 undefined = 没声明（消费者用默认值）；不在这里归一成数字
    timeoutMs: c.timeoutMs,
    // 缺省落盘。少数工具显式 `persistResult: false`。
    persistResult: c.persistResult ?? true,
  };
}

/**
 * 决定一次调用该不该套超时、套多久。**所有消费者都必须走这个函数**，
 * 不要在调用点重新写一遍 `if (NO_TIMEOUT) ...` 的判断（那正是本文件要消灭的东西）。
 *
 * @param resolved 工具契约
 * @param defaultTimeoutMs 执行器的默认预算（没有声明时用它）
 */
export function resolveToolTimeout(
  resolved: ResolvedToolContract,
  defaultTimeoutMs: number,
): { useTimeout: boolean; timeoutMs: number } {
  if (resolved.timeoutMs === NO_TIMEOUT) {
    return { useTimeout: false, timeoutMs: 0 };
  }
  return {
    useTimeout: true,
    timeoutMs: resolved.timeoutMs ?? defaultTimeoutMs,
  };
}

// ============================================================
// 命名谓词 —— 消费者只调用它们，不自己写判据
// ============================================================

/**
 * 沙箱是否要为这个调用做路径检查。
 *
 * 判据是 `accessScope !== "none"`（**访问**了外部边界），不是「有没有副作用」——
 * 读文件也要拦（工作区外的读取同样要挡）。这是拆字段之后才成为可能的正确判据：
 * 拆之前用 `sideEffectScope !== "none"` 会把「无副作用的网络工具」也拉进来做
 * 一次无意义的路径检查。
 */
export function requiresPathGuard(contract: ResolvedToolContract): boolean {
  return contract.accessScope !== "none";
}

/**
 * 这个调用会不会**改变工作区内容**（快照要覆盖它的原因）。
 *
 * `workspace` 且非只读 —— 只读地访问工作区（`read` / `grep`）不需要快照。
 */
export function mutatesWorkspace(contract: ResolvedToolContract): boolean {
  return contract.sideEffectScope === "workspace" && !contract.readOnly;
}

/**
 * 该不该在**执行前**为它拍快照。
 *
 * 除「改工作区」外，破坏性动作（删笔记、杀任务、关终端）也要 —— 它们同样可能
 * 不可逆，只是改的不是文件。旧实现按名字列举（`["write","edit","bash"]`），
 * 于是 `multi_edit` 这种同类工具漏登记就静默失去保护。
 */
export function needsPreCallSnapshot(contract: ResolvedToolContract): boolean {
  return mutatesWorkspace(contract) || contract.destructive;
}

/** 该不该把超大结果落盘（换成预览 + 定位说明）。 */
export function shouldPersist(contract: ResolvedToolContract): boolean {
  return contract.persistResult;
}

/**
 * 该不该在计划模式（只读契约）下放行。
 *
 * 判据是契约的 `readOnly` —— **不含** `sideEffectScope === "none"`：
 * 一个无副作用但会改会话态的工具仍然不是「只读」。
 */
export function allowedInReadOnlyMode(contract: ResolvedToolContract): boolean {
  return contract.readOnly;
}

/**
 * 是不是「同一工具既可能只读、也可能写」的 shell 类工具。
 *
 * ## 为什么这里必须按工具名特判（本仓唯一一处）
 *
 * `bash` 不可能用静态声明表达「它会不会写」——**同一个工具**执行
 * `Get-ChildItem` 时不改任何东西、执行 `Set-Content` 时改文件。
 * 契约是**静态**的，所以它只能声明成保守的 `sideEffectScope: "system"`，
 * 真正判定必须落在**命令意图**上（`analyzeBashCommand`）。
 *
 * ## 为什么还要带 `contract.sideEffectScope === "system"` 这一半
 *
 * 那样以后新增的系统类工具（`run_code`、`terminal_*`）会**自动**被纳入
 * 这个「按命令意图判定」的通道，不需要谁记得来改这里 —— 也就是说：
 * 声明负责「要不要走这条通道」，名字只负责「`bash` 这个特例本身」。
 *
 * 旧实现在守卫里内联了 `toolName === "bash" || ...`，读代码的人看不出
 * 这是刻意的特例还是漏改。抽到这里并把理由写清楚。
 */
export function isShellLike(toolName: string, contract: ResolvedToolContract): boolean {
  return toolName === "bash" || contract.sideEffectScope === "system";
}
