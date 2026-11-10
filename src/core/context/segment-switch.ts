/**
 * 段式上下文：**规则版** compact/switch 决策 + handoff 生成 + 写入（P0-3 / D1 / D2 / D3 / D11）。
 *
 * ## 三条硬边界
 *
 * 1. **不新建 Session**：switch 只写一条 `kind="switch"` 的 epoch marker（D1）；
 * 2. **不删旧消息**：marker 只改变模型视图的 cutoff，时间线一条不少（D3）；
 * 3. **默认产生 switch**：调用方必须先看 `codem-context-config.segmentEpochs`
 *    （2026-11-06 起默认 true；显式 false 仍回旧路径，供灰度回滚与 D11 对照）；
 *    本模块**不自己读开关** —— 判断放在唯一调用点，免得出现「两处各判一次」。
 *
 * ## 为什么是规则、不是小模型
 *
 * 25 §6 P0-3 的顺序是「先规则版 → 影子小模型 → 灰度」。规则版的价值是**可解释**：
 * 每个决定都有 `reason`，写进 `context_steward_decision` 事件，事后能复盘
 * 「为什么这次切了段」。
 *
 * ## 已知边界（诚实标注）
 *
 * - 决策有两个入口：**回合中途**（压力触发点，`turnCompleted:false`）与
 *   **回合完成出口**（`agentic-loop.ts` 的 `trySwitchOnCompletion`，`turnCompleted:true`）。
 *   两个入口都用**同一把水尺**（`compactionThreshold` / hard 线）：压力没到考虑线时，
 *   完成态也**不换段**（继续当前段）；到了考虑线才按「任务边界」换段。
 *   ⚠️ 2026-11 修正：旧实现让完成态**无视**压力线（「完成即边界」），结果是超过 keepCount
 *   之后**每个用户回合都切一段** —— 真实 200 轮不可能只有 3 段（规模化验收因此造假）。
 *   现在完成态与中途共用 `pressure >= compactionThreshold` 这个触发条件；连压 ≥2 / 接近
 *   hard 两条救援信号仍按原常量生效。
 * - handoff 是**机械摘录**（最近用户原话 / 最近改动路径 / 计数），不是语义摘要：
 *   它保证「关键事实不丢」，但不假装理解任务。真正的语义 handoff 要等小模型灰度。
 *
 * ## 写入侧不在这里
 *
 * 本文件只有**纯函数**（决策 / handoff 文本 / 路径抽取）。真正落库的那一步
 * （写 epoch marker + 决策事件）在 `core/storage/context-switch.ts` ——
 * 它必须读整个会话的时间线，属于数据层；放这里会让
 * `no-sync-mirror-reads` 的结构边界失效。
 */

import { resolveStewardPolicy, type StewardPolicy } from "./steward-policy";

/** 压力模型：沿用唯一的 0.5 / 0.7 / 0.9（D2），这里只用 0.7 与 0.9 */
const SEGMENT_CONSIDER_RATIO = 0.7;
const SEGMENT_HARD_RATIO = 0.9;
/** 连续压缩几次之后倾向换段（25 §6：连续压缩 ≥2 倾向 switch） */
const SEGMENT_SWITCH_AFTER_COMPACTIONS = 2;

type EpochAction = "none" | "compact" | "switch";

export interface EpochDecisionInput {
  /** 当前压力（0..1，与 `context.ts` 的 PRESSURE_THRESHOLDS 同一把尺） */
  pressure: number;
  /** 考虑线（默认 0.7） */
  threshold?: number;
  /** hard 线（默认 0.9） */
  hardThreshold?: number;
  /** 回合是否已完成；调用点拿不到终态时传 false（见文件头的已知边界） */
  turnCompleted?: boolean;
  /** 连续压缩次数（loop 的 `state.consecutiveCompactions`） */
  consecutiveCompactions?: number;
  /** 模型真实窗口（P2 自适应；缺省 128000 ⇒ 不调整） */
  modelContextWindow?: number;
  /** 本轮观测到的**新增** token 均值（P2 自适应；缺省/0 ⇒ 不调整） */
  observedAvgTurnTokens?: number;
  /**
   * 显式策略（P2）：给了就以它的 consider / hard 为准（`threshold` / `hardThreshold` 不再参与）；
   * 不给则由本函数按「配置 + 观测」现算（见 `resolveStewardPolicy`）。
   */
  policy?: StewardPolicy;
}

export interface EpochDecision {
  action: EpochAction;
  reason: string;
}

/**
 * **loop 边界的决策入口**（P0-3 / D11）：把「开关 + 两个数字」压成一个纯函数。
 *
 * 为什么单独抽出来：`agentic-loop` 里那一段无法用单测直接驱动（要起 provider/工具/存储），
 * 而「开关关着时永远不许 switch」是**门禁级**的事实 —— 它必须有一条不依赖重型 loop 的判据。
 * 于是把「读配置 + 拼参数」收在这里，loop 只做 `if (epochActionForLoop(cfg, state) !== "switch") return`。
 *
 * @returns 开关关闭 ⇒ `"none"`（连 compact 都不主张，压缩仍走原有阈值逻辑）
 */
export function epochActionForLoop(
  config: { segmentEpochs?: boolean; compactionThreshold?: number },
  state: { contextPressure: number; consecutiveCompactions: number },
  options: { turnCompleted?: boolean; policy?: StewardPolicy } = {},
): "none" | "compact" | "switch" {
  if (config.segmentEpochs !== true) return "none";
  return decideEpochAction({
    pressure: state.contextPressure,
    threshold: config.compactionThreshold,
    /* 回合终态由调用点提供：中途触发点传 false，完成出口传 true（P0：完成态换段） */
    turnCompleted: options.turnCompleted === true,
    consecutiveCompactions: state.consecutiveCompactions,
    /* P2：自适应策略由调用点算好传入（窗口 / 单轮观测只有 loop 知道） */
    policy: options.policy,
  }).action;
}

/**
 * 规则版决策。
 *
 * 顺序（先硬信号、再水位、最后按完成态分流），每一条都能单独解释：
 * 1. 压力越过 hard 线 ⇒ `switch`（中途/完成都切：再压也救不回来了）；
 * 2. **未完成**且压力低于考虑线 ⇒ `none`（压力线仍然管中途，什么都不做）；
 * 3. 连续压缩 ≥2 ⇒ `switch`（同一段里再压也压不动 —— 救援信号优先于「完成态不切」）；
 * 4. 未完成（此时压力已过考虑线）⇒ `compact`（中途换段会把任务切走 —— 25 §6 的护栏）；
 * 5. 已完成且压力 ≥ 考虑线 ⇒ `switch`（任务边界 + 水位达标 = 段边界）；
 * 6. 已完成但压力低于考虑线（且没有救援信号）⇒ `none`（继续当前段）。
 *
 * ## ⚠️ 为什么完成态**也**看压力线（2026-11 修正）
 *
 * 旧顺序把 `turnCompleted` 提到水位判断之前，写成「完成即边界」：完成态一律 `switch`，
 * 不看 `compactionThreshold`。当时的理由是「正常会话完成时压力只有 0.0x，用阈值会把
 * 完成换段挡死」；但那把**触发条件**和**任务边界**混成了一条规则 —— 真实后果是：
 * 历史超过 `keepCount` 之后，**每个用户回合都切一段**（200 轮 ≈ 200 段），
 * 与 25 §6 P0-3 的「完成任务在**阈值处** switch；未完成在阈值处 compact；接近 hard /
 * 连压 ≥2 才救援」直接冲突（规模化验收 200 轮/3 段因此长期靠种子消息伪装）。
 *
 * 现在完成态与中途共用同一把水尺：`pressure >= threshold` 才是换段触发条件。
 * 低压力完成只表示「这一轮做完了」，不表示「上下文该换段了」 —— 继续当前段更省也更快
 * （handoff + 新段前缀重建都要钱）。救援信号（hard / 连压 ≥2）保持原样，不因这次修正被推翻。
 *
 * ## P2：自适应只换刻度，不换判据
 *
 * `threshold` / `hardThreshold` 仍是配置里的**基线**；实际参与比较的两个数字来自
 * {@link resolveStewardPolicy}（窗口 / 单轮观测 / 连压）。默认输入下它给的仍是
 * 0.7 / 0.9，所以本函数的行为与引入 P2 之前**逐字相同**；只有调用点真的把窗口或观测
 * 传进来时才会提前。阈值调整会拼进 reason（`自适应：…`），默认不调整时 reason 一字不改。
 */
export function decideEpochAction(input: EpochDecisionInput): EpochDecision {
  const pressure = Number.isFinite(input.pressure) ? Number(input.pressure) : 0;
  const streak = Math.max(0, Math.floor(Number(input.consecutiveCompactions) || 0));
  const turnCompleted = input.turnCompleted === true;

  /**
   * P2：**只调整决策输入**。显式 `policy` 优先（loop 会把窗口/观测算好后传进来）；
   * 否则按「配置基线 + 观测」现算 —— 与 `resolveStewardPolicy` 是同一个实现，不另写一套。
   */
  const policy =
    input.policy ??
    resolveStewardPolicy({
      baseConsider: input.threshold,
      baseHard: input.hardThreshold,
      modelContextWindow: input.modelContextWindow,
      observedAvgTurnTokens: input.observedAvgTurnTokens,
      consecutiveCompactions: streak,
      pressure,
    });
  const threshold = Number.isFinite(policy.consider) ? policy.consider : SEGMENT_CONSIDER_RATIO;
  const hard = Number.isFinite(policy.hard) ? policy.hard : SEGMENT_HARD_RATIO;
  /** 只有在策略真的改过阈值时才拼审计信息：默认路径的 reason 必须与旧版逐字一致。 */
  const policyNote = policy.adjusted ? `（自适应：${policy.reason}）` : "";

  /**
   * **hard 线优先**（D2）：0.9 之后继续往同一段里塞，压缩已经救不回来
   * （连压 ≥3 会直接熔断成「上下文窗口已满」）。这时换段是唯一还能保住任务的动作。
   * 完成/未完成都适用 —— 这是救援，不是任务边界判断。
   */
  if (pressure >= hard) {
    return { action: "switch", reason: `pressure ${pressure.toFixed(3)} >= hard ${hard}${policyNote}` };
  }
  /**
   * 压力线**仍然管中途**（既有行为，一字未改）：未完成且没到考虑线 ⇒ 什么都不做。
   * 放在连压判断之前是旧顺序 —— 中途的 `consecutiveCompactions` 只在
   * 「压力已经过线」的压缩块里累计，这条顺序保证低压力中途不会因历史遗留计数而切段。
   */
  if (!turnCompleted && pressure < threshold) {
    return { action: "none", reason: `pressure ${pressure.toFixed(3)} < consider ${threshold}${policyNote}` };
  }
  /**
   * **连压 ≥2 优先于「完成态不切」**（25 §6）：连续压缩两次还没把压力压下去，
   * 说明「同一段里再压也压不动」 —— 这时换段是唯一能让任务继续的动作。
   * 保持既有顺序：它在完成态的水位判断之前，所以「低位 + 连压 2」仍然切
   * （救援信号不因这次修正被削弱）。
   */
  if (streak >= SEGMENT_SWITCH_AFTER_COMPACTIONS) {
    return { action: "switch", reason: `after ${streak} consecutive compactions${policyNote}` };
  }
  if (!turnCompleted) {
    return {
      action: "compact",
      reason: `mid-turn (not completed) at pressure ${pressure.toFixed(3)}${policyNote}`,
    };
  }
  /**
   * 完成态：**水位达标才换段**（2026-11 修正点，见函数头）。
   * `pressure < threshold` 走到这里 ⇒ `none`（继续当前段）。
   */
  if (pressure < threshold) {
    return {
      action: "none",
      reason: `completed below consider ${threshold} at pressure ${pressure.toFixed(3)}${policyNote}`,
    };
  }
  return {
    action: "switch",
    reason: `completed turn at pressure ${pressure.toFixed(3)} >= consider ${threshold}${policyNote}`,
  };
}

/**
 * 2026-11-09：显式开启 segmentEpochs 时，**本回合第一拍**的压力穿越不能先做预防性压缩。
 *
 * 为什么：`decideEpochAction` 在 `turnCompleted:false` 时按设计只会说 compact，
 * 于是 0.7 的首次穿越被压缩吃掉；等回合真正完成时压力已经降到线下，完成出口
 * 只能得到 none —— 显式开启的完成态 switch 永远不会发生。
 *
 * 规则只推迟「第一拍、规则明确说 compact、确实有东西可切、还剩一次输出余量」这一种情形；
 * hard 线 / 连压 ≥2 / 已切过 / 后续迭代 / 默认关闭全部保持原路径。
 */
export interface BoundaryDeferralInput {
  segmentEpochs: boolean;
  turnCompleted: boolean;
  action: "none" | "compact" | "switch";
  iteration: number;
  switchedThisTurn: boolean;
  viewMessageCount: number;
  keepRecent: number;
  headroomTokens: number;
  outputReserveTokens: number;
}

export function shouldDeferBoundaryCompaction(input: BoundaryDeferralInput): boolean {
  if (input.segmentEpochs !== true) return false;
  if (input.turnCompleted) return false;
  if (input.iteration !== 1) return false;
  if (input.switchedThisTurn) return false;
  if (input.action !== "compact") return false;
  if (input.viewMessageCount <= input.keepRecent) return false;
  if (input.headroomTokens < input.outputReserveTokens) return false;
  return true;
}
const HANDOFF_SECTION_MAX_ITEMS = 5;
const HANDOFF_ITEM_MAX_CHARS = 200;

function textOf(message: { content?: unknown }): string {
  return typeof message.content === "string" ? message.content : "";
}

function clip(text: string, max = HANDOFF_ITEM_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 从消息正文里抽绝对路径（Windows 盘符 / POSIX 绝对路径），去重保序 */
export function extractPathsFrom(messages: ReadonlyArray<{ content?: unknown }>): string[] {
  const out: string[] = [];
  const re = /(?:[A-Za-z]:\\[^\s"'`，。；：、）)\]]+|(?:\/[\w.-]+){2,})/g;
  for (const message of messages) {
    const text = textOf(message);
    for (const match of text.match(re) ?? []) {
      const trimmed = match.replace(/[.,;:]+$/, "");
      if (trimmed.length < 3) continue;
      if (!out.includes(trimmed)) out.push(trimmed);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/**
 * 生成 switch 的 handoff 正文（8 段结构，25 §4.4）。
 *
 * 每一段都**只写能从时间线机械拿到的事实**；拿不到就写「（无自动摘录）」——
 * 不做语义总结，也就不会编。
 */
export function buildSwitchHandoff(
  timeline: ReadonlyArray<{ id: string; role?: string; content?: unknown; timestamp?: number }>,
  keep: ReadonlyArray<{ id: string; content?: unknown }>,
  segmentSeq: number,
  /**
   * P1-1：会话笔记摘要（`thread-notes.ts::buildThreadNotesDigest` 的产物）。
   *
   * 只能拼在**末尾**（易变尾部）：笔记每轮都可能变，写进稳定前缀会击穿 provider 的
   * 前缀缓存（NOTE-4）。传空串/不传 ⇒ 行为与旧版逐字一致（notes 不可用回退现有摘要，
   * 不阻断换段）。
   */
  notesDigest?: string,
): string {
  const userLines = timeline
    .filter((m) => m.role === "user")
    .slice(-HANDOFF_SECTION_MAX_ITEMS)
    .map((m) => `- ${clip(textOf(m))}`)
    .filter((line) => line !== "- ");
  const paths = extractPathsFrom(timeline).slice(0, 8);
  const lastTs = timeline.length > 0 ? Number(timeline[timeline.length - 1].timestamp ?? 0) : 0;

  return [
    `[段切换 handoff] segment ${segmentSeq}`,
    "",
    "## Goals（用户最近说过什么，机械摘录）",
    ...(userLines.length > 0 ? userLines : ["- （无自动摘录）"]),
    "",
    "## Constraints and preferences",
    "- （无自动摘录：本段没有结构化的偏好记录）",
    "",
    "## Progress（Done / In progress / Blocked）",
    `- 本段共 ${timeline.length} 条消息；换段后模型可见最近 ${keep.length} 条`,
    "",
    "## Decisions（含 rejected）",
    "- （无自动摘录）",
    "",
    "## Facts to keep（路径 / 命令 / ID / 错误原文）",
    ...(paths.length > 0 ? paths.map((p) => `- ${p}`) : ["- （无自动摘录）"]),
    "",
    "## Open threads（未回答问题、承诺、等谁）",
    "- （无自动摘录：完成态判断不在本片）",
    "",
    "## Next step",
    `- 继续当前任务；需要旧细节时用 thread_history_search / thread_history_read 回读（时间线共 ${timeline.length} 条）`,
    "",
    "## Where to look（锚点 + 关键词）",
    ...(paths.length > 0 ? paths.map((p) => `- ${p}`) : ["- （无自动摘录）"]),
    "",
    /**
     * P1-1：会话笔记摘要（untrusted）—— 没有笔记时**整段不出现**，handoff 与旧版一致。
     * 放在 `_生成于` 之前：marker 的解析只看开头前缀，追加在中段/尾部都不改协议。
     */
    ...(notesDigest && notesDigest.trim().length > 0 ? [notesDigest, ""] : []),
    `_生成于 ${new Date(lastTs || Date.now()).toISOString()}；原文未删除。_`,
  ].join("\n");
}
