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
 * ## 保留名字兜底
 *
 * 运行时注册的工具（MCP 的 `zvec_grep_search` 等）**不可能**带声明，所以
 * `resolveConcurrencySafe` 等函数保留一份收窄的兜底表 —— 契约化不消灭例外，
 * 只是让例外变短且集中。zcode 的 `scheduler.ts:97` 同样是
 * `tool.readOnly ?? this.readOnlyTools.has(...)` 这个「声明优先、名字兜底」形态。
 */

/**
 * 副作用范围。
 *
 * - `none`：不碰外部世界（纯计算、查询内存态）。**这是唯一能自动判定为可并发的前提。**
 * - `workspace`：读写工作区文件（`write` / `edit` / `read` / `glob` …）。
 * - `git`：改动 git 状态（提交、重置、push）。
 * - `network`：发起网络请求。
 * - `system`：改动系统状态（进程、注册表、安装、终端）。
 * - `session`：只改本会话/本 agent 的状态（清单、待办、目标、委派）。
 */
export type ToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session";

/**
 * `timeoutMs` 的哨兵值：显式声明「本工具不设超时」。
 *
 * 为什么需要哨兵而不是 `timeoutMs: undefined`：`undefined` 与「字段没写」无法区分，
 * 而这两者语义不同 —— 没写 = 用执行器的默认超时；写了 `NO_TIMEOUT` = 明确不要超时。
 */
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
  /** 副作用范围。`none` 视为可并发前提之一。缺省 `"workspace"`（多数工具碰文件）。 */
  sideEffectScope?: ToolSideEffectScope;
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
}

/** 解析后的契约：每个字段都有确定的布尔/数值，消费者不需要再各自补默认值。 */
export interface ResolvedToolContract {
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  sideEffectScope: ToolSideEffectScope;
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
export const UNKNOWN_TOOL_FALLBACK_READONLY: readonly string[] = [
  // zvec-grep MCP 在运行时注册，只读搜索工具（见 concurrency-policy.ts 的同类说明）
  "zvec_grep_search",
  "zvec_grep_rg",
];

/** 没有任何声明的外部工具（MCP / 动态注册）按名字判断是否只读。 */
export function isFallbackReadOnly(name: string): boolean {
  return UNKNOWN_TOOL_FALLBACK_READONLY.includes(name);
}

/**
 * 把（可能不完整的）契约解析成完整契约。
 *
 * ## 优先级（照 zcode `scheduler.ts:97-102`，但默认值更保守）
 *
 * 1. `destructive === true` ⇒ 永不并发（一票否决，即使声明了 `concurrencySafe`）
 * 2. `concurrencySafe` 显式给了 ⇒ 用它
 * 3. 否则 `readOnly === true` ⇒ 可并发
 * 4. 否则 `sideEffectScope === "none"` ⇒ 可并发
 * 5. 都不满足 ⇒ 独占
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
  const sideEffectScope: ToolSideEffectScope =
    c.sideEffectScope ?? (readOnly ? "none" : "workspace");

  let concurrencySafe: boolean;
  if (destructive) {
    concurrencySafe = false;
  } else if (c.concurrencySafe !== undefined) {
    concurrencySafe = c.concurrencySafe;
  } else if (readOnly) {
    concurrencySafe = true;
  } else {
    concurrencySafe = sideEffectScope === "none";
  }

  return {
    readOnly,
    destructive,
    concurrencySafe,
    sideEffectScope,
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
