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
import { summarizeModelContext } from "../llm/compaction-budget";
import { pruneStaleToolResults } from "../llm/context-fold";
import { getTokenTracker } from "../llm/token-tracker";
import { listVisibleMessages } from "../storage/message";

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
};

/**
 * 计算某个会话当前的水位（模型侧口径）。
 *
 * @param sessionId 会话 id；为空或读取失败时返回 {@link UNKNOWN_WATER_LEVEL}
 */
export function readContextWaterLevel(sessionId: string): ContextWaterLevel {
  if (!sessionId) return UNKNOWN_WATER_LEVEL;
  try {
    const visible = listVisibleMessages(sessionId);
    const contextWindow = getTokenTracker().getContextWindow() || FALLBACK_CONTEXT_WINDOW;
    const { usedTokens, budgetTokens } = summarizeModelContext(
      pruneStaleToolResults(visible as never[]),
      contextWindow,
    );
    const display = summarizeDisplayPressure(usedTokens, budgetTokens);
    return {
      used: usedTokens,
      available: budgetTokens,
      ratio: display.ratio,
      percent: display.percent,
      level: display.level,
      messageCount: visible.length,
    };
  } catch {
    // 读不到水位时**不报假警**。真实的读取失败由既有上报通道
    // （`reportActionFailure`）负责，这里静默降级即可 —— 水位提示条绝不能
    // 因为"读失败"而显示"上下文即将满"。
    return UNKNOWN_WATER_LEVEL;
  }
}

/**
 * 把面板已有的 `TokenBudget` 转成水位。
 *
 * 面板自己算 `budget`（它还要显示 systemPrompt / outputReserve 明细），
 * 但**等级与百分比必须由同一对 `used/available` 导出**，所以走这里，
 * 面板不再单独算压力。
 */
export function waterLevelFromBudget(budget: TokenBudget, messageCount: number): ContextWaterLevel {
  const display = summarizeDisplayPressure(budget.used, budget.available);
  return {
    used: budget.used,
    available: budget.available,
    ratio: display.ratio,
    percent: display.percent,
    level: display.level,
    messageCount,
  };
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
export function useContextWaterLevel(sessionId: string, pollMs = 3000): ContextWaterLevel {
  const [level, setLevel] = useState<ContextWaterLevel>(UNKNOWN_WATER_LEVEL);
  useEffect(() => {
    if (!sessionId) {
      setLevel(UNKNOWN_WATER_LEVEL);
      return;
    }
    setLevel(readContextWaterLevel(sessionId));
    const timer = setInterval(() => setLevel(readContextWaterLevel(sessionId)), pollMs);
    return () => clearInterval(timer);
  }, [sessionId, pollMs]);
  return level;
}
