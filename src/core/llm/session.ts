/**
 * Message V2 / Session 的**类型定义**（唯一存活的部分）。
 *
 * ## 第 102 轮：这里原本还有一个 `SessionManager` 类，已删除
 *
 * 审计发现它**只剩一个调用方**，而那个调用方本身也是死代码（`src/core/llm/processor.ts` 的
 * `Processor` 类，全仓没有 `new Processor(`；产物里也被 tree-shake 掉了）。
 * 真正在跑的是 `core/llm/agentic-loop.ts` + `core/storage/session.ts` + `core/store.ts`。
 *
 * 处置：连带 `Processor` 一起删（`SessionManager` 的 load/save/deleteV2Session 三段
 * 只服务于它），**只保留类型** —— 这些类型是全仓在用的（`context.ts`、`memory.ts`、
 * `recovery.ts`、`SessionRecovery.tsx`、`v2-session.ts` 都 import type 它们）。
 *
 * 顺带删掉的还有两处"只为了另一边存在"的痕迹：`subagent.ts` 里那句从未被使用的
 * `import type { ProcessorEvent }`，以及 `tool-args-truncation.test.ts::ARGS-6` 里
 * 对 `processor.ts` 的字符串断言（判据本身保留，只去掉已不存在的那一条）。
 */

// ========== Message V2 ==========
export interface MessageV2 {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  timestamp: number;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cost?: number;
  };
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | StepStartPart
  | StepFinishPart;

export interface TextPart {
  type: "text";
  content: string;
}

export interface ReasoningPart {
  type: "reasoning";
  content: string;
}

export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: "pending" | "running" | "completed" | "error";
  error?: string;
  metadata?: Record<string, any>;
}

export interface FilePart {
  type: "file";
  path: string;
  action: "read" | "write" | "edit";
}

export interface StepStartPart {
  type: "step_start";
  name: string;
}

export interface StepFinishPart {
  type: "step_finish";
  name: string;
  duration: number;
  result: "success" | "error";
}

// ========== Session ==========
export interface Session {
  id: string;
  projectId: string;
  title: string;
  messages: MessageV2[];
  createdAt: number;
  updatedAt: number;
  model: string;
  totalUsage: {
    promptTokens: number;
    completionTokens: number;
    cost: number;
  };
}
