/**
 * RepeatToolReminder — 循环防护中间件
 *
 * 设计对标 DSH `@deepseek-ai/dsh-repeat-tool-reminder`。
 *
 * 这是一个咨询式循环断路器，不是模型面向的工具：
 * - 不出现在工具列表中
 * - 从不否决或重写调用
 * - 只做一件事：监视每个 agent 的工具调用流，
 *   计数连续调用同一工具 + 相同规范化参数的运行次数，
 *   在配置的运行长度处注入升级提醒
 *
 * 提醒内容：告诉模型停止重复自己、重新阅读上一个结果、
 * 改变方法或结束任务。决策（不同方式重试、收集更多证据
 * 或结束）完全由模型做出。
 *
 * 链键：`(tool name, canonical arguments)`
 * - 规范化 = 深排序 + JSON.stringify
 * - 参数对象仅属性顺序不同算相同
 * - 被排除的工具调用对链透明（不递增也不重置）
 *
 * per-agent 隔离：WeakMap<sessionId, Chain>
 *
 * 提醒投递：通过 post-execute 的 append 操作注入到结果末尾
 */

import type { PostExecuteMiddleware, PostExecuteResult } from "./tool-pipeline";
import type { ToolCallResult } from "./types";
import type { ToolExecutorContext } from "./streaming-executor";

// ========== Configuration ==========

export interface RepeatToolReminderConfig {
  /** 连续重复次数阈值，到达时触发提醒。默认 [3, 5, 8] */
  thresholds?: number[];
  /** 要跟踪的工具名模式（空 = 所有工具） */
  include?: string[];
  /** 对链透明的工具名模式。默认排除 todo_write */
  exclude?: string[];
  /** 提醒中引用的参数预览字符上限。默认 500 */
  argumentsPreviewChars?: number;
}

const DEFAULT_THRESHOLDS = [3, 5, 8];
const DEFAULT_EXCLUDE = ["todo_write", "load_skill", "update_todo"];
const DEFAULT_PREVIEW_CHARS = 500;

// ========== Chain Key ==========

/**
 * 将参数对象规范化：深排序键 + JSON.stringify。
 * 参数仅属性顺序不同算相同。
 */
function canonicalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(args));
}

function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep);
  }
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * 链键 = (tool name, canonical arguments)
 */
interface ChainKey {
  toolName: string;
  canonicalArgs: string;
}

interface Chain {
  /** 当前链键 */
  current: ChainKey | null;
  /** 连续计数 */
  count: number;
  /** 已触发的阈值集合（避免同一阈值重复触发） */
  firedThresholds: Set<number>;
}

// ========== Pattern Matching ==========

/**
 * 简单通配符匹配 — 支持 `*` 通配符。
 * `grep*` 匹配 `grep_search`，`mcp_*` 匹配 `mcp_fetch`。
 */
function matchPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern === "*") return true;
  // 将 `*` 转为正则 `.*`
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`).test(name);
}

function matchesAnyPattern(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => matchPattern(p, name));
}

// ========== Reminders ==========

/** 第一阈值提醒 — 简短通用提示 */
const FIRST_THRESHOLD_REMINDER =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: " +
  "if the task is not complete, try a different approach or different arguments " +
  "instead of repeating the call.";

/** 后续阈值提醒 — 详细形式，命名工具、运行长度和参数 */
function laterThresholdReminder(
  toolName: string,
  count: number,
  canonicalArgs: string,
  previewChars: number,
): string {
  const argsPreview = canonicalArgs.length > previewChars
    ? canonicalArgs.slice(0, previewChars) + `… (+${canonicalArgs.length - previewChars} more chars)`
    : canonicalArgs;

  return [
    "Repeated tool call detected:",
    `- tool: ${toolName}`,
    `- consecutive_calls: ${count}`,
    `- arguments: ${argsPreview}`,
    "The repeated calls are not making progress. " +
      "Do not call this tool with these exact arguments again. " +
      "Inspect the latest result and choose a different action, " +
      "different arguments, or finish the task if enough evidence has been gathered.",
  ].join("\n");
}

// ========== Middleware ==========

/**
 * 循环防护 post-execute 中间件。
 *
 * 在 post-execute 层监听工具调用：
 * - 相同 (tool name, canonical args) 连续调用 → 递增计数
 * - 不同调用 → 重置链
 * - 被排除的工具 → 透明（不递增也不重置）
 * - 到达阈值 → 在结果末尾追加提醒
 * - 用户消息 → 重置链（在新 turn 开始时）
 */
export class RepeatToolReminderMiddleware implements PostExecuteMiddleware {
  name = "repeat-tool-reminder";
  private thresholds: number[];
  private include: string[];
  private exclude: string[];
  private argumentsPreviewChars: number;

  /** per-session 链状态 */
  private chains = new Map<string, Chain>();

  constructor(config: RepeatToolReminderConfig = {}) {
    // 阈值验证：空列表/非整数/小于2/重复值 → 抛出
    const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
    if (thresholds.length === 0) {
      throw new Error("repeat-tool-reminder: thresholds must not be empty");
    }
    for (const t of thresholds) {
      if (!Number.isInteger(t) || t < 2) {
        throw new Error(
          `repeat-tool-reminder: threshold ${t} must be an integer >= 2`,
        );
      }
    }
    // 去重 + 升序排序
    this.thresholds = [...new Set(thresholds)].sort((a, b) => a - b);

    this.include = config.include ?? [];
    this.exclude = config.exclude ?? DEFAULT_EXCLUDE;
    this.argumentsPreviewChars = config.argumentsPreviewChars ?? DEFAULT_PREVIEW_CHARS;

    // 验证参数预览字符
    if (!Number.isInteger(this.argumentsPreviewChars) || this.argumentsPreviewChars < 1) {
      throw new Error(
        `repeat-tool-reminder: argumentsPreviewChars must be an integer >= 1`,
      );
    }
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
  ): Promise<PostExecuteResult> {
    // 被排除的工具 → 透明
    if (matchesAnyPattern(toolName, this.exclude)) {
      return { action: "keep" };
    }

    // include 非空但工具不在 include 列表中 → 透明
    if (this.include.length > 0 && !matchesAnyPattern(toolName, this.include)) {
      return { action: "keep" };
    }

    const canonicalArgs = canonicalizeArgs(args);
    const key: ChainKey = { toolName, canonicalArgs };

    // 获取或创建链
    let chain = this.chains.get(ctx.sessionId);
    if (!chain) {
      chain = { current: null, count: 0, firedThresholds: new Set() };
      this.chains.set(ctx.sessionId, chain);
    }

    // 检查是否与上一次相同
    const isSame =
      chain.current !== null &&
      chain.current.toolName === key.toolName &&
      chain.current.canonicalArgs === key.canonicalArgs;

    if (isSame) {
      // 递增
      chain.count++;
    } else {
      // 重置链
      chain.current = key;
      chain.count = 1;
      chain.firedThresholds.clear();
    }

    // 检查是否到达阈值
    const threshold = this.thresholds.find(
      (t) => chain!.count === t && !chain!.firedThresholds.has(t),
    );

    if (threshold === undefined) {
      return { action: "keep" };
    }

    // 标记已触发
    chain.firedThresholds.add(threshold);

    // 构建提醒文本
    const isFirst = threshold === this.thresholds[0];
    const reminderText = isFirst
      ? FIRST_THRESHOLD_REMINDER
      : laterThresholdReminder(toolName, chain.count, canonicalArgs, this.argumentsPreviewChars);

    // 将提醒追加到结果末尾
    const appendedText = `\n\n---\n[loop-breaker] ${reminderText}`;

    return {
      action: "append",
      appendedText,
    };
  }

  /**
   * 重置会话的链（在新 turn 开始时调用）。
   * 对标 DSH 的 `agent/pre-step` 用户消息重置。
   */
  resetChain(sessionId: string): void {
    this.chains.delete(sessionId);
  }

  /**
   * 清理所有链（应用退出时）。
   */
  clear(): void {
    this.chains.clear();
  }
}
