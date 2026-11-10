/**
 * Anthropic Messages 的**提示缓存断点**（`cache_control: { type: "ephemeral" }`）——
 * 全仓唯一实现。
 *
 * ## 被修的缺陷（为什么必须有这一层）
 *
 * `usage-normalize.ts` 早就能解析 Anthropic 的两个缓存桶
 * （`cache_read_input_tokens` / `cache_creation_input_tokens`），UI 与统计也支持
 * 「已上报 / 未上报」两态；但**请求体里从来没有 `cache_control`** ——
 * provider 不会缓存任何前缀，于是真实会话里「缓存命中」永远是 0 或缺失。
 * 上一轮真机 A/B 三轮全是 `cacheReported:false`，根因就是请求里没有断点
 * （不是 provider 不支持：同一个 key / 同一条 `/v1/messages` 路径）。
 *
 * ## 断点放在哪（Anthropic 上限 4 个；这里用 2 个）
 *
 * 1. **system**：字符串 ⇒ 转成一个 text block 数组并挂 `cache_control`；
 *    已经是 block 数组 ⇒ 给**最后一个** block 挂（本仓的转换器目前产出字符串，
 *    数组分支是为「system 将来变多块」与直接调用方保留的形态，不是死代码）。
 * 2. **稳定前缀的最后一条消息**：由调用方（`agentic-loop`）用
 *    `stablePrefixLastMessageId()` 标出锚点；断点落在**锚点消息的最后一个 content
 *    block** 上，而**不是**「所在 wire 消息的最后一块」——
 *    `toAnthropicMessages` 会把连续同角色的消息合并，易变尾部（时间上下文 /
 *    计划上下文）经常和锚点落在同一个 wire 消息里；用 wire 末块会把易变文本
 *    也圈进断点（每轮必 miss，等于没加）。
 *
 * 易变尾部（时间上下文 / 工作集索引 / 计划上下文 / 目标摘要 / 表面状态）
 * **一个断点都不加**。拿不到锚点的直接调用方（压缩摘要、单元测试等）退化为
 * 「倒数第 2 条 wire 消息」—— 这是**明确记录的降级**，不是正确路径；
 * 日志里会标 `source=fallback`，真实会话走的是 `source=anchor`。
 *
 * ## 开关
 *
 * `codem-context-config.promptCache`（缺键 = **默认开**；显式 `false` ⇒ 一个
 * `cache_control` 都不发）。只作用于 Anthropic Messages：OpenAI / Gemini 的 wire
 * 形状不受影响（它们的适配器根本不调用本模块）。
 *
 * ## 只加元数据，不动正文
 *
 * 断点只往 content block 上挂 `cache_control` 元数据：**消息文本、顺序、角色
 * 一个字节都不改**。没有断点可用时（没有 system、消息不足两条）就干脆不加，
 * 绝不为了「看起来有缓存」去造一个 block。
 */
import { getSettingJSON } from "../storage/settings";

/** `codem-context-config`（Anthropic 提示缓存开关与压缩参数共用这一个设置键） */
const CONTEXT_CONFIG_KEY = "codem-context-config";

/**
 * 默认值：**开**。
 *
 * 旧用户的 `codem-context-config` 里没有 `promptCache` 这个键 ⇒ 读出来必须是开；
 * 要回旧路径（一个 `cache_control` 都不发）必须**显式**写 `false`。
 * `context.ts` 的 `DEFAULT_CONFIG.promptCache` 引用这个常量（唯一口径）。
 */
export const DEFAULT_PROMPT_CACHE = true;

/**
 * 工作集索引消息的固定 id（见 `agentic-loop.ts::attachWorkingSetIndex`）。
 *
 * 它**每轮都可能变**（索引行来自「刚被移出的最旧那一段」），所以不能进稳定前缀：
 * 锚点必须取它**前面**那条。
 */
const WORKING_SET_INDEX_ID = "ctx-workingset-index";

/** Anthropic 断点元数据（`ephemeral` = 默认 5 分钟 TTL，不需要 beta 头） */
function ephemeral(): { type: "ephemeral" } {
  return { type: "ephemeral" };
}

/**
 * 读开关：`codem-context-config.promptCache`。
 *
 * - 没有存储端口（Host / 单测 / 早期启动）⇒ `getSettingJSON` 返回 `null` ⇒ 默认开；
 * - 有值且**严格等于 `false`** ⇒ 关（字符串 `"false"`、0 都不算关：那是坏数据，
 *   坏数据不许悄悄关掉一个计费相关的能力）；
 * - 读配置抛错 ⇒ 按默认开，并让设置层自己的上报通道留痕（本函数不吞业务错误，
 *   只吞「读不到」这一种，因为缓存是**优化**，不该让读配置失败把请求搞挂）。
 */
export function isPromptCacheEnabled(): boolean {
  try {
    const config = getSettingJSON<{ promptCache?: boolean } | null>(CONTEXT_CONFIG_KEY, null);
    return config?.promptCache !== false;
  } catch {
    return DEFAULT_PROMPT_CACHE;
  }
}

/**
 * 稳定前缀最后一条消息的 id（断点 2 的锚点）。
 *
 * 规则：
 * - 请求数组里有工作集索引消息（`ctx-workingset-index`）⇒ 取它**前面**那条
 *   （索引本身每轮都变，不能进稳定前缀）；
 * - 否则取数组**最后一条**（此刻易变尾部还没拼上来，见 `agentic-loop` 的
 *   `promptCacheAnchorId` 计算点）；
 * - 空数组 / 索引正好是第一条 / 锚点没有 id ⇒ `undefined`（调用方据此退化，
 *   绝不瞎猜一个位置）。
 *
 * ⚠️ 这里**不**用 `Array.prototype.findLastIndex`：本仓 `tsconfig` 的 target/lib
 * 是 ES2021，那个 API 类型上不存在（写了 `tsc` 直接红）。
 */
export function stablePrefixLastMessageId(
  messages: ReadonlyArray<{ id?: string }> | undefined,
): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  let indexAt = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.id === WORKING_SET_INDEX_ID) {
      indexAt = i;
      break;
    }
  }
  if (indexAt === 0) return undefined;
  const anchor = indexAt > 0 ? messages[indexAt - 1] : messages[messages.length - 1];
  const id = anchor && typeof anchor.id === "string" ? anchor.id : "";
  return id.length > 0 ? id : undefined;
}

/**
 * system 断点：把 system 提示变成「带 `cache_control` 的 block 数组」。
 *
 * - 空字符串 / 空数组 ⇒ `undefined`（请求里连 `system` 字段都不发，与旧形态一致）；
 * - 字符串 ⇒ `[{ type: "text", text, cache_control }]`（Anthropic 只认 block 上的元数据）；
 * - block 数组 ⇒ 给**最后一个** block 挂断点（原地修改，调用方传入的是本次请求
 *   自己构造的数组，不与历史消息共享引用）。
 *
 * 只在开关打开时被调用；关闭时 `streamAnthropic` 保留旧的字符串形态。
 */
export function anthropicSystemWithCache(system: string | any[] | undefined): any[] | undefined {
  if (typeof system === "string") {
    if (!system) return undefined;
    return [{ type: "text", text: system, cache_control: ephemeral() }];
  }
  if (Array.isArray(system)) {
    if (system.length === 0) return undefined;
    const last = system[system.length - 1];
    if (last && typeof last === "object") {
      (last as { cache_control?: unknown }).cache_control = ephemeral();
    }
    return system;
  }
  return undefined;
}

/**
 * 消息断点：在 wire messages 的指定位置挂 `cache_control`。
 *
 * `at` 是 `{ messageIndex, blockIndex }`：`messageIndex` 指向 wire 消息，
 * `blockIndex` 指向该消息 `content` 数组里的 block（由 `toAnthropicMessages`
 * 在转换时算出 —— 它才看得到「锚点消息的最后一块」在合并后的哪个下标上）。
 * `blockIndex < 0` 时退回该消息的最后一块（只在调用方没给 block 时发生）。
 *
 * 返回**是否真的挂上**：位置不存在 / content 为空 / block 不是对象 ⇒ `false`，
 * 调用方据此在日志里如实写 `message=0`（不许把"没加上"写成"已加"）。
 */
export function placeAnthropicMessageBreakpoint(
  messages: any[],
  at: { messageIndex: number; blockIndex: number } | null,
): boolean {
  if (!at || !Array.isArray(messages)) return false;
  const message = messages[at.messageIndex];
  const content = message && Array.isArray(message.content) ? message.content : null;
  if (!content || content.length === 0) return false;
  const blockIndex = at.blockIndex >= 0 ? at.blockIndex : content.length - 1;
  const block = content[blockIndex];
  if (!block || typeof block !== "object") return false;
  (block as { cache_control?: unknown }).cache_control = ephemeral();
  return true;
}
