/**
 * 目标模式设置（3 个键，全部有默认值 —— 不设置也能用）。
 *
 * | 键 | 默认 | 语义 |
 * |---|---|---|
 * | `codem-goal-mode` | `auto` | `auto`：多阶段任务自动进入目标模式；`off`：只用 run 自主 |
 * | `codem-goal-resume` | `true` | 打开会话时自动恢复 active 目标（重启恢复） |
 * | `codem-goal-budget` | `{mode:"unlimited"}` | 默认不限；可选 capped（达限暂停） |
 *
 * 读路径刻意**全部带默认值**：设置键不存在（新装/旧库）时不能变成「目标模式失效」，
 * 也不能抛错把聊天打断（`getSetting` 在端口未就绪时返回 null）。
 */

import { getSetting, getSettingJSON, setSetting, setSettingJSON } from "../storage/settings";
import type { GoalBudget } from "./types";
import { DEFAULT_GOAL_BUDGET } from "./types";

const GOAL_MODE_KEY = "codem-goal-mode";
const GOAL_RESUME_KEY = "codem-goal-resume";
const GOAL_BUDGET_KEY = "codem-goal-budget";

export type GoalModeSetting = "auto" | "off";

/** 纯解析：未知值一律回落默认（`auto`）—— 不让脏值静默关掉功能 */
function parseGoalMode(raw: unknown): GoalModeSetting {
  return raw === "off" ? "off" : "auto";
}

/**
 * 纯解析预算。
 *
 * 只有显式 `mode:"capped"` 且**至少给了一个有效上限**才算 capped ——
 * 否则「capped 但没有任何上限」会变成一个永远不触发的假上限（比 unlimited 更糟：
 * 界面显示有上限，实际永远不停）。
 */
function parseGoalBudget(raw: unknown): GoalBudget {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GOAL_BUDGET };
  const obj = raw as Record<string, unknown>;
  if (obj.mode !== "capped") return { ...DEFAULT_GOAL_BUDGET };
  const positive = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  const maxTokens = positive(obj.maxTokens);
  const maxMinutes = positive(obj.maxMinutes);
  const maxTurns = positive(obj.maxTurns);
  if (maxTokens === undefined && maxMinutes === undefined && maxTurns === undefined) {
    return { ...DEFAULT_GOAL_BUDGET };
  }
  return {
    mode: "capped",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxMinutes !== undefined ? { maxMinutes } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

export function getGoalModeSetting(): GoalModeSetting {
  try {
    return parseGoalMode(getSetting(GOAL_MODE_KEY));
  } catch {
    // 读失败 ⇒ **关闭**（fail-closed）：读不到用户意图时不能擅自启动自主长任务。
    // 用户仍可手动开启；下一次能读到设置就恢复正常。
    return "off";
  }
}

export function setGoalModeSetting(value: GoalModeSetting): void {
  setSetting(GOAL_MODE_KEY, value);
}

/** 目标模式是否参与自动判断（`off` 时连规划调用都不发） */
export function isGoalModeEnabled(): boolean {
  return getGoalModeSetting() === "auto";
}

/**
 * 打开会话是否自动恢复目标。
 *
 * 默认开（产品要求：重启后不用重新配置）。**读失败时取 false（fail-closed）**：
 * 读不到设置就自动续跑一个长任务 = 用户没同意的自主执行，宁可让他点一下「继续目标」。
 */
export function getGoalResumeOnOpen(): boolean {
  try {
    const raw = getSetting(GOAL_RESUME_KEY);
    // 未设置 ⇒ 默认开；显式 "false"/"0" 才关（脏值按默认开处理）
    return raw === "false" || raw === "0" ? false : true;
  } catch {
    return false;
  }
}

export function setGoalResumeOnOpen(value: boolean): void {
  setSetting(GOAL_RESUME_KEY, value ? "true" : "false");
}

export function getGoalBudgetSetting(): GoalBudget {
  try {
    return parseGoalBudget(getSettingJSON<unknown>(GOAL_BUDGET_KEY, DEFAULT_GOAL_BUDGET));
  } catch {
    return { ...DEFAULT_GOAL_BUDGET };
  }
}

export function setGoalBudgetSetting(value: GoalBudget): void {
  setSettingJSON(GOAL_BUDGET_KEY, parseGoalBudget(value));
}
