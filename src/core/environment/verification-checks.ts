/**
 * 「本轮检查」的数据源（第 233 轮 · 二次升级 Phase C）。
 *
 * ## 为什么需要它
 *
 * 新一轮 Inspector 的验收要求是「真实会话中 checks 有数据时显示，无数据时明确『无检查记录』」。
 * 而仓库里**没有任何地方**把"这轮跑过什么检查、结果如何"记下来 —— 工具结果只活在消息流里，
 * 面板读不到。所以先补一条**有界、可读**的记录。
 *
 * ## 记什么 / 不记什么
 *
 * - 只记**验证类命令**（`isVerificationCommand`：测试/类型检查/构建/lint）；
 * - 每条只留 `{ command, ok, at }` —— **不记输出**（输出可能很大，且含用户代码）；
 * - 每个会话最多保留 `MAX_CHECKS` 条（环形），**不写数据库、不加迁移**：走设置面
 *   （`setSettingJSON`）就够了，它是既有的、可持久化的 JSON 面。
 *
 * ## 口径（如实）
 *
 * 面板标题写的是「最近检查」而**不是**「本轮检查」：记录不绑定 turn 序号
 * （turn 边界在跟踪器里，工具执行在循环里，两处没有共享计数器）。
 * 与其编一个假绑定，不如把标签写实 —— 判据 `turn-checks.test.ts` 钉住这个措辞。
 */
import { getSettingJSON, setSettingJSON } from "../storage/settings";

export interface VerificationCheck {
  /** 实际执行的命令（截断到 200 字符，够辨认） */
  command: string;
  /** 通过与否（工具自己的 isError 取反） */
  ok: boolean;
  /** 记录时刻 */
  at: number;
}

const SETTING_KEY = "codem-verification-checks";
/** 每会话保留多少条（够看清最近一轮的检查，又不会让设置面膨胀） */
export const MAX_CHECKS = 20;

type Store = Record<string, VerificationCheck[]>;

function readStore(): Store {
  try {
    const raw = getSettingJSON<Store>(SETTING_KEY, {});
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** 记一条检查（有界；失败静默 —— 这条记录不许影响工具执行） */
export function recordVerificationCheck(sessionId: string, check: Omit<VerificationCheck, "at">): void {
  if (!sessionId) return;
  try {
    const store = readStore();
    const list = Array.isArray(store[sessionId]) ? store[sessionId] : [];
    list.push({ command: check.command.slice(0, 200), ok: check.ok, at: Date.now() });
    store[sessionId] = list.slice(-MAX_CHECKS);
    setSettingJSON(SETTING_KEY, store);
  } catch {
    // 记录失败不影响主流程
  }
}

/** 读某会话最近的检查（新→旧） */
export function listVerificationChecks(sessionId: string): VerificationCheck[] {
  if (!sessionId) return [];
  const list = readStore()[sessionId];
  return Array.isArray(list) ? [...list].reverse() : [];
}

/** 仅判据使用 */
export function __resetVerificationChecksForTests(): void {
  try {
    setSettingJSON(SETTING_KEY, {});
  } catch {
    // ignore
  }
}
