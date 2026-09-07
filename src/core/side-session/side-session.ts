/**
 * side-session — 临时会话（B1，对标 EAC dsh-side-session / Codex side session）
 *
 * 基于当前主会话的上下文（最近消息 + 项目 cwd），发起一次**不污染主会话**的
 * 独立流式问答。区别于：
 * - fork：复制消息到新会话（会创建持久会话记录）
 * - delegate：后台在目标会话执行
 * - subagent：委派执行任务
 *
 * 本模块：给定主会话上下文 + 问题 → 组装 LLM 消息（含简洁 system 与最近
 * 对话窗口）→ 用当前默认 provider/model 流式回答，回答只回流到调用方 UI
 * （SideSessionPanel），绝不写入 store/DB。
 */

import type { LLMMessage } from "../llm/types";
import type { Message } from "../../store";

export interface SideSessionTurn {
  id: string;
  question: string;
  answer: string;
  error?: string;
  createdAt: number;
  streaming?: boolean;
}

export interface SideSessionContext {
  /** 当前会话标题（窗口标题用） */
  sessionTitle: string;
  /** 工作目录 */
  cwd: string | null;
  /** 最近消息窗口（按时间正序） */
  messages: Message[];
}

/** 上下文窗口上限：取最近 N 条消息（近似 EAC "加长"档位的一档） */
export const SIDE_CTX_MAX_MESSAGES = 60;
/** 单条消息注入上限字符（防超长工具输出撑爆） */
export const SIDE_CTX_MAX_CHARS = 8000;

export function genTurnId(): string {
  return `side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从当前会话 store 提取 side-session 上下文：
 * - 最多 SIDE_CTX_MAX_MESSAGES 条最近 user/assistant 消息（system 跳过）
 * - 每条截断到 SIDE_CTX_MAX_CHARS
 */
export function collectSessionContext(
  allMessages: Message[],
  sessionTitle: string,
  cwd: string | null,
  maxMessages: number = SIDE_CTX_MAX_MESSAGES,
): SideSessionContext {
  const visible = allMessages.filter((m) => m.role === "user" || m.role === "assistant");
  const recent = visible.slice(-maxMessages).map((m) => ({
    ...m,
    content: m.content.length > SIDE_CTX_MAX_CHARS
      ? m.content.slice(0, SIDE_CTX_MAX_CHARS) + "\n…(截断)"
      : m.content,
  }));
  return { sessionTitle, cwd, messages: recent };
}

/**
 * 把主会话消息窗口 + 新问题组装成 LLM 请求消息。
 * 系统提示带项目 cwd，帮助模型定位；历史 user/assistant 原样透传。
 */
export function buildSideMessages(ctx: SideSessionContext, question: string): LLMMessage[] {
  const system: LLMMessage = {
    id: "side-sys",
    role: "system",
    content:
      "You are helping the user with a quick follow-up question based on the ongoing conversation. " +
      "Answer concisely and directly. Do not claim to have modified any files." +
      (ctx.cwd ? `\nCurrent working directory: ${ctx.cwd}` : ""),
  };
  const history: LLMMessage[] = ctx.messages.map((m, i) => ({
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));
  const q: LLMMessage = {
    id: `side-q-${Date.now()}`,
    role: "user",
    content: question,
  };
  return [system, ...history, q];
}

/**
 * 组装回答文本（流式或一次性由调用方决定）。
 * 本函数保持纯数据：回答内容由 provider.stream / complete 产生。
 */
export function formatSideError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
