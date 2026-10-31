/**
 * 上下文水位的**唯一计算入口**（第 122 轮）。
 *
 * ## 为什么必须是共享模块，而不是各组件各算一遍
 *
 * 本仓已经因为「同一件事两套口径」栽过两次，而且都是用户直接看到矛盾：
 *
 * 1. **第 71 轮**：概览卡与委派页签显示同一事实的两个答案；
 * 2. **第 72 轮**：上下文面板上「占用率 21%」紧跟着「压力等级：临界 +
 *    🔴 上下文即将满！请立即压缩或开启新对话」—— 因为进度条走"模型侧口径"
 *    （可见 → 裁剪陈旧工具结果 → 按优先级选进真实窗口 ×0.9），
 *    而压力等级另调 `getPressureLevelFromMessages`（另一套分母、且不裁剪不选择）。
 *
 * 第 122 轮要新增一个**常驻水位提示条**（用户不必打开面板就能看到告警）。
 * 如果它自己再算一遍水位，那就是第三次犯同一个错：面板说 21%、提示条说临界。
 * 所以水位计算收进这里，**面板与提示条都调它**。
 *
 * ## 口径与模型侧严格一致
 *
 * `used` 是「模型这一次真的会收到的消息的估算 token」，不是"库里所有行的 token"。
 * 链条与 `agentic-loop.ts::buildMessages` 相同：
 * `listVisibleMessages` → `pruneStaleToolResults` → `summarizeModelContext`
 * （预算 = 真实窗口 × 0.9）。**面板存在的意义就是回答"上下文还剩多少"，
 * 那就必须是模型侧那个数。**
 */
import { useEffect, useState } from "react";
import {
  getContextManager,
  summarizeDisplayPressure,
  type TokenBudget,
} from "./context";
import { foldForLevelIfNeeded } from "../llm/tool-output-fold";
import { summarizeModelContext, estimateRawContextTokens } from "../llm/compaction-budget";
import { pruneStaleToolResults } from "../llm/context-fold";
import { getTokenTracker, estimateToolDefinitionTokens } from "../llm/token-tracker";
import { peekLLMEngine } from "../llm";
import { readRequestContext, messageSetFingerprint } from "../llm/request-context";
import { listVisibleMessages, isHiddenStateAuthoritative } from "../storage/message";

/**
 * 拿不到真实窗口时的兜底窗口。
 *
 * 这里原来在 `ContextMonitor.tsx:26` 是 `DEFAULT_BUDGET.total = 128000`，
 * 面板用它既当"无会话时的占位 budget"又当"窗口兜底"。水位要共用同一个兜底，
 * 否则"面板显示用了 12%"与"提示条按另一个窗口算"又会分叉。
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * 水位的**唯一阈值来源**（与 `core/context/context.ts::PRESSURE_THRESHOLDS` 同源）。
 *
 * 这里不重新定义数字 —— 只给 `summarizeDisplayPressure` 算出的等级起名字，
 * 避免"阈值写第二遍"。等级由比值导出，见 `summarizeDisplayPressure`。
 */
export const WATER_LEVEL = {
  /** 等级 0（< 50%）：正常 */
  NORMAL: 0,
  /** 等级 1（≥ 50%，< 70%）：提示条不出现（还没到需要打扰用户的程度） */
  ELEVATED: 1,
  /** 等级 2（≥ 70%，< 90%）：常驻提示条出现 */
  HIGH: 2,
  /** 等级 3（≥ 90%）：紧急 */
  CRITICAL: 3,
} as const;

export interface ContextWaterLevel {
  /** 模型侧口径下"这一次真的会收到"的估算 token */
  used: number;
  /** 模型侧可用预算（真实窗口 × 0.9） */
  available: number;
  /** 占用率 0..1 */
  ratio: number;
  /** 百分比（整数） */
  percent: number;
  /** 压力等级 0..3 */
  level: number;
  /** 可见消息条数（与模型侧同一个入口 `listVisibleMessages`） */
  messageCount: number;
  /**
   * ★ 全量审计（用户现场）：这次读数是否建立在**权威隐藏状态**之上。
   * false = 索引镜像还没就绪（此刻的条数/占用可能把已压缩隐藏的历史算进来）——
   * 调用方**必须**当「未知」处理，不许据此弹「上下文即将满」。
   */
  authoritative: boolean;
  /** ★ 阶梯痕迹：本轮静默折叠了多少条较远的工具输出（0 = 没折） */
  foldedToolOutputs?: number;
}

/** 算不出水位时的取值。
 *
 * **不是"100%" / 不是 CRITICAL** —— 「算不出来」不等于「快满了」，与
 * `pressureLevelForRatio` 对 `NaN` 的取向一致（第 72 轮定的）。 */
export const UNKNOWN_WATER_LEVEL: ContextWaterLevel = {
  used: 0,
  available: 0,
  ratio: 0,
  percent: 0,
  level: WATER_LEVEL.NORMAL,
  messageCount: 0,
  /* 未知不是「满」，也不是「权威」 */
  authoritative: false,
};

/**
 * 计算某个会话当前的水位（模型侧口径）。
 *
 * @param sessionId 会话 id；为空或读取失败时返回 {@link UNKNOWN_WATER_LEVEL}
 */
/**
 * 水位结果缓存：同一会话、同一消息集合（长度/最后一条/内容总长/工具结果总长/窗口）
 * 直接复用上一拍。水位每 3 秒轮询一次；没有缓存时，大工具输出会话每次都要把
 * 全部消息重新 prune/fold/估算一遍，主线程会周期性卡住。
 */
const WATER_CACHE_MAX = 32;
/** 仅判据/诊断使用：清空水位缓存，验证冷/热两条路径。 */
export function __resetWaterLevelCache(): void { waterCache.clear(); }
const waterCache = new Map<string, { sig: string; result: ContextWaterLevel }>();

function waterSignature(visible: any[], contextWindow: number, overheadTokens: number, requestKey: string): string {
  let size = 0;
  for (const m of visible) {
    const content = typeof m?.content === "string" ? m.content : "";
    size += content.length;
    if (typeof m?.reasoning === "string") size += m.reasoning.length;
    const calls = (m as { toolCalls?: Array<{ result?: unknown; args?: unknown }> })?.toolCalls;
    if (Array.isArray(calls)) {
      for (const tc of calls) {
        size += typeof tc?.result === "string" ? tc.result.length : 0;
        if (tc?.args !== undefined) size += 1;
      }
    }
  }
  const last = visible[visible.length - 1];
  return `${visible.length}:${String(last?.id ?? "")}:${String(last?.timestamp ?? "")}:${size}:${contextWindow}:${overheadTokens}:${requestKey}`;
}

/**
 * 每次请求都带、但不属于消息列表的固定开销：系统提示 + 工具定义。
 *
 * 工具定义只从**已初始化的**引擎取（`peekLLMEngine`），避免为了算水位去构造引擎；
 * 引擎尚未初始化时只计系统提示，等引擎起来后的下一拍会重新计算并刷新缓存。
 */
function requestOverheadTokens(): { system: number; tools: number; total: number } {
  let system = 0;
  try {
    system = Math.max(0, Math.floor(Number(getContextManager().getConfig().systemPromptTokens) || 0));
  } catch {
    system = 0;
  }
  let tools = 0;
  try {
    const engine = peekLLMEngine();
    if (engine) {
      const defs = [
        ...engine.tools.getCoreDefinitions(),
        ...engine.tools.getDeferredDefinitions(),
      ];
      tools = Math.max(0, estimateToolDefinitionTokens(defs));
    }
  } catch {
    tools = 0;
  }
  return { system, tools, total: system + tools };
}

export function readContextWaterLevel(sessionId: string): ContextWaterLevel {
  if (!sessionId) return UNKNOWN_WATER_LEVEL;
  /**
   * ★ 全量审计（用户现场）：**权威隐藏状态没就绪 ⇒ 报「未知」** ——
   * 真机形态：启动后日志已 hydrate（149 条，含 6 万字符的大工具输出）而索引镜像还没加载 ⇒
   * 隐藏集为空 ⇒ 水位算出 99%「上下文即将满（剩 1,553 tokens）」，镜像就绪后变 5%（横幅自己消失）。
   * 与「读不到 ≠ 一条消息都没有」同一条纪律：读不到 ≠ 快满了。
   */
  if (!isHiddenStateAuthoritative(sessionId)) return UNKNOWN_WATER_LEVEL;
  try {
    const visible = listVisibleMessages(sessionId);
    const contextWindow = getTokenTracker().getContextWindow() || FALLBACK_CONTEXT_WINDOW;
    const overhead = requestOverheadTokens();
    const snapshot = readRequestContext(sessionId);
    const requestKey = snapshot ? `${snapshot.at}:${snapshot.promptTokens}` : "";
    const sig = waterSignature(visible as never[], contextWindow, overhead.total, requestKey);
    const cached = waterCache.get(sessionId);
    if (cached?.sig === sig) return cached.result;

    /**
     * 最近一次真实请求的 promptTokens 只在「可见消息 id 完全一致」时可用：
     * 新消息、删除、压缩都会改变 id 集合，此时退回估算，避免拿上一轮的真实值冒充这一轮。
     */
    const sameVisibleSet = !!snapshot
      && snapshot.promptTokens > 0
      && snapshot.contextWindow === contextWindow
      && snapshot.visibleFingerprint === messageSetFingerprint(visible as never[])
      && snapshot.visibleIds.length === visible.length
      && visible.every((m, i) => m.id === snapshot.visibleIds[i]);
    if (sameVisibleSet && snapshot) {
      const available = Math.max(1, contextWindow - getContextManager().getConfig().outputReserve);
      const display = summarizeDisplayPressure(snapshot.promptTokens, available);
      const exactResult: ContextWaterLevel = {
        used: snapshot.promptTokens,
        available,
        ratio: display.ratio,
        percent: Math.min(100, display.percent),
        level: display.level,
        messageCount: visible.length,
        authoritative: true,
        foldedToolOutputs: 0,
      };
      if (waterCache.size >= WATER_CACHE_MAX) waterCache.clear();
      waterCache.set(sessionId, { sig, result: exactResult });
      return exactResult;
    }
    /**
     * ★ 工具输出折叠阶梯（用户提的机制）：水位必须按**折叠后的视图**算 ——
     * 引擎发出去的就是折叠后的消息（见 `agentic-loop.buildMessages`），
     * 水位/面板/引擎三处走同一个 `foldForLevelIfNeeded`，否则会出现
     * 「面板显示 85% 但横幅不弹」（引擎折了、这里没算）这种自相矛盾。
     * 折叠是**读时视图**：库里原文一字不动，"取回"就是重跑工具。
     */
    /*
     * ★ 2026-10-19：读数用**原始** token（不做优先级选择）。
     * 用 `summarizeModelContext(...).usedTokens` 时，选择器会把预算塞满 ⇒ 长会话恒为 ~100%，
     * 折叠前后读数不降反升（真机：253K/128K 的两个会话都在 100%），折叠永远"看起来没生效"。
     */
    const estimate = (ms: any[]) => estimateRawContextTokens(ms as never[]);
    const pruned = pruneStaleToolResults(visible as never[]);
    const budgetTokens = summarizeModelContext(pruned as never[], contextWindow).budgetTokens;
    const fold = foldForLevelIfNeeded(pruned, { available: budgetTokens, estimate });
    const used = Math.round(fold.ratioAfter * budgetTokens) + overhead.total;
    const display = summarizeDisplayPressure(used, budgetTokens);
    const result: ContextWaterLevel = {
      used,
      available: budgetTokens,
      ratio: display.ratio,
      /* 超过预算时百分比显示 100%（原始值仍可从 used/available 看出超了多少） */
      percent: Math.min(100, display.percent),
      level: display.level,
      messageCount: visible.length,
      authoritative: true,
      /* ★ 阶梯痕迹：这一轮静默折了多少条（>0 时界面用一行说明，不弹窗） */
      foldedToolOutputs: fold.folded,
    };
    if (waterCache.size >= WATER_CACHE_MAX) waterCache.clear();
    waterCache.set(sessionId, { sig, result });
    return result;
  } catch {
    // 读不到水位时**不报假警**。真实的读取失败由既有上报通道
    // （`reportActionFailure`）负责，这里静默降级即可 —— 水位提示条绝不能
    // 因为"读失败"而显示"上下文即将满"。
    return UNKNOWN_WATER_LEVEL;
  }
}

/**
 * 提示条可见性的**防抖状态机**（2026-10-19，用户实报「打开就闪一下」）。
 *
 * ## 被守的缺陷
 *
 * 会话一打开，水位要经过几拍：索引镜像未就绪（UNKNOWN）→ 就绪后先读到"高"→
 * 同一轮里折叠/压缩把读数拉下来 → 又可能升回去。`visible` 直接跟着每一拍变化，
 * 用户看到的就是「出现 1–2 秒 → 消失 → 几秒后又出现」。
 *
 * ## 规则（只作用于"风险"这条显示理由）
 *
 * - 连续 `showAfter` 次（默认 2 拍 ≈ 6 秒）都 **≥ 90%（critical）** 才显示；
 * - 连续 `hideAfter` 次低于该线才隐藏；
 *
 * ⚠️ 阈值是 **90% 而不是 70%**（2026-10-19 用户拍板 A）：70–90% 交给**自动压缩**
 * （阈值 0.7、压完留 30% 余量）静默处理；提示条只在"压缩也不一定够"的临界档出现，
 * 避免"打开会话先被提示、发一轮又被压下去"的打扰。
 * - `authoritative === false`（读不到/未就绪）**不改可见性**（保持上一拍），
 *   因为"读不到"既不证明满、也不证明不满。
 *
 * "本轮真的丢过上下文"那条理由是**事实**，不参与防抖（该立刻说）。
 */
export interface WaterBannerState {
  level: ContextWaterLevel;
  visible: boolean;
  showStreak: number;
  hideStreak: number;
}

export const INITIAL_WATER_BANNER_STATE: WaterBannerState = {
  level: UNKNOWN_WATER_LEVEL,
  visible: false,
  showStreak: 0,
  hideStreak: 0,
};

export function reduceWaterBanner(
  prev: WaterBannerState,
  level: ContextWaterLevel,
  opts: { showAfter?: number; hideAfter?: number } = {},
): WaterBannerState {
  const showAfter = Math.max(1, opts.showAfter ?? 2);
  const hideAfter = Math.max(1, opts.hideAfter ?? 2);
  if (!level.authoritative) {
    // 读数不可信：保留可见性与 streaks，只更新展示用的 level（避免 UI 闪成 0%）
    return { ...prev, level };
  }
  /* A 方案：只在 critical（≥90%）提示；70–90% 由自动压缩静默处理 */
  const high = level.level >= WATER_LEVEL.CRITICAL;
  if (high) {
    const showStreak = prev.showStreak + 1;
    return {
      level,
      visible: prev.visible || showStreak >= showAfter,
      showStreak,
      hideStreak: 0,
    };
  }
  const hideStreak = prev.hideStreak + 1;
  return {
    level,
    visible: prev.visible && hideStreak < hideAfter,
    showStreak: 0,
    hideStreak,
  };
}

/**
 * 带防抖的水位订阅（提示条用）。
 *
 * 与 `useContextWaterLevel` 同频轮询，但可见性由 `reduceWaterBanner` 决定；
 * 会话切换时重置（否则上一个会话的 visible 会带过来）。
 */
export function useStableContextWaterLevel(
  sessionId: string,
  pollMs = 3000,
): WaterBannerState {
  const [state, setState] = useState<WaterBannerState>(INITIAL_WATER_BANNER_STATE);
  useEffect(() => {
    if (!sessionId) {
      setState(INITIAL_WATER_BANNER_STATE);
      return;
    }
    setState(INITIAL_WATER_BANNER_STATE);
    const tick = () => {
      const next = readContextWaterLevel(sessionId);
      setState((prev) => reduceWaterBanner(prev, next));
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return () => clearInterval(timer);
  }, [sessionId, pollMs]);
  return state;
}

/**
 * 订阅水位变化。
 *
 * ## 为什么是**轮询**而不是"内容变化时重算"
 *
 * 一开始我想让调用方传一个"消息版本号"进来，变了才重算。查过之后发现**没有这样一个
 * 便宜的版本号可用**：
 *
 * - `useAppStore().messages` 只装了**最后 10 条**（`loadMessages` 的分页合同，
 *   见 `App.tsx:4047` 的注释）—— 用它当版本号会在长会话里**永远不变**；
 * - `currentSession.messageCount` 是库里那一列，随保存延迟更新，且压缩后会变小；
 * - 事件日志/消息表的变更没有对外发订阅。
 *
 * 于是这里按 `ContextMonitor` 既有做法**轮询**（它本来就是 `setInterval(update, 3000)`）。
 * 提示条与面板用同一个间隔、同一个计算，屏幕上的数字才不会有第二个答案。
 * 轮询只在有会话时跑（`sessionId` 为空直接不启），且每次只是一次内存表读 + 一次估算。
 *
 * @param pollMs 轮询间隔（默认与 ContextMonitor 一致：3000ms）
 */
