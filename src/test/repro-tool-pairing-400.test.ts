/**
 * 回归测试：buildMessages 上下文裁剪后 tool_calls 与 tool 结果数量不匹配 → API 400
 *
 * 用户报告（修复后安装包）：
 *   [Provider] API error: 400 An assistant message with 'tool_calls' must be followed
 *   by tool messages responding to each 'tool_call_id'. (insufficient tool messages
 *   following tool_calls message)
 *
 * 根因（agentic-loop.ts buildMessages）：
 *   1. selectMessagesByPriority 按优先级贪婪裁剪：assistant（带 tool_calls，优先级 2）
 *      高于 tool 结果（优先级 1）。预算不足时，可能保留 assistant 的 tool_calls，
 *      却裁剪掉部分/全部对应的 tool 结果。
 *   2. 旧清理逻辑只检查"assistant 后面是否跟了任意一个 tool 结果"（布尔 hasResults），
 *      不检查数量是否与 tool_calls 匹配。assistant 声明 2 个 tool_calls 但只有 1 个
 *      结果存活时不会被 strip → DeepSeek/OpenAI API 400 拒绝（要求逐 tool_call_id 配对）。
 *
 * 修复：
 *   按 toolCallId 精确配对 ——
 *   - tool 消息若无任何 assistant 声明其 id → 删除（孤儿结果）
 *   - assistant 的 tool_calls 仅保留有存活结果的子集；全丢则整体 strip
 *   - 这样最终消息中每个 assistant 的 tool_calls 数量 === 紧跟的 tool 结果数量
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockListMessages } = vi.hoisted(() => ({ mockListMessages: vi.fn() }));

import { AgenticLoop } from "../core/llm/agentic-loop";
import { messagesToLLMMessages } from "../core/storage/message";

// 最小脚本 provider — 不实际调用
class ScriptedProvider {
  id = "mock-provider";
  config: any = {};
  dynamicModels: any[] | null = null;
  isConfigured() { return true; }
  async *stream(): AsyncGenerator<any> { yield { type: "end", finishReason: "stop" }; }
  async complete() { return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; }
}

describe("buildMessages: tool_calls 与 tool 结果数量必须精确配对（防 API 400）", () => {
  let loop: AgenticLoop;
  let messageStorage: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const provider = new ScriptedProvider();
    loop = new AgenticLoop(provider as any, new Map() as any, {
      maxIterations: 10,
      model: "mock-model",
    });
    // 注入 mock MessageStorage：listMessages 返回 DB 原始格式，
    // messagesToLLMMessages 用真实实现（保证转换一致性）
    messageStorage = {
      listMessages: mockListMessages,
      messagesToLLMMessages,
    };
    (loop as any).getMessageStorage = () => messageStorage;
  });

  it("FIX-001: 超预算裁剪后，每个 assistant 的 tool_calls 数量必须等于存活 tool 结果数量（防 API 400）", async () => {
    // 构造大量消息超过 100000 token 预算，强制 selectMessagesByPriority 裁剪。
    // 真实场景：AI 连续跑几十次 bash，每次结果几千字符。
    const dbMsgs: any[] = [{ id: "u0", role: "user", content: "任务开始", timestamp: 1, status: "done" }];
    let ts = 2;
    for (let i = 0; i < 60; i++) {
      dbMsgs.push({
        id: `a${i}`, role: "assistant", content: `第 ${i} 次调用`,
        toolCalls: [
          { id: `call_${i}`, tool: "bash", args: {}, status: "done", result: "x".repeat(9000) },
        ],
        timestamp: ts++, status: "done",
      });
      dbMsgs.push({ id: `u${i + 1}`, role: "user", content: "继续", timestamp: ts++, status: "done" });
    }
    mockListMessages.mockReturnValue(dbMsgs);

    const result = await (loop as any).buildMessages("sess-fix-001");

    // 不变量：消息流中每个带 tool_calls 的 assistant，其 tool_calls 数量 === 紧跟的 tool 结果数量
    for (let i = 0; i < result.length; i++) {
      const m = result[i];
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        const callCount = m.tool_calls.length;
        let resultCount = 0;
        for (let j = i + 1; j < result.length; j++) {
          if (result[j].role === "tool") { resultCount++; }
          else if (result[j].role === "assistant" || result[j].role === "user") { break; }
        }
        expect(resultCount).toBe(callCount);
      }
    }
  });

  it("FIX-002: 裁剪导致某 assistant 的 tool_calls 全部无结果 → 整体 strip（不残留悬空 tool_calls）", async () => {
    // 超预算场景：早期 assistant 的 tool 结果被裁掉，但 assistant 文本被保留
    const dbMsgs: any[] = [{ id: "u0", role: "user", content: "开始", timestamp: 1, status: "done" }];
    let ts = 2;
    for (let i = 0; i < 80; i++) {
      dbMsgs.push({
        id: `a${i}`, role: "assistant", content: `调用 ${i}`,
        toolCalls: [
          { id: `call_${i}`, tool: "bash", args: {}, status: "done", result: "y".repeat(9000) },
        ],
        timestamp: ts++, status: "done",
      });
    }
    mockListMessages.mockReturnValue(dbMsgs);

    const result = await (loop as any).buildMessages("sess-fix-002");

    // 不变量同上
    for (let i = 0; i < result.length; i++) {
      const m = result[i];
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        let resultCount = 0;
        for (let j = i + 1; j < result.length; j++) {
          if (result[j].role === "tool") { resultCount++; }
          else if (result[j].role === "assistant" || result[j].role === "user") { break; }
        }
        expect(resultCount).toBe(m.tool_calls.length);
      }
    }
    // 不存在悬空 tool_calls 的 assistant（tool_calls 存在但结果数 0）
    for (const m of result) {
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        expect(result.some((x: any) => x.role === "tool" && x.toolCallId === m.tool_calls[0].id)).toBe(true);
      }
    }
  });

  it("FIX-003: 孤儿 tool 结果（无 assistant 声明其 toolCallId）→ 删除", async () => {
    // messagesToLLMMessages 正常不会产出孤儿，但防御性验证清理逻辑：
    // 构造一个 selected 中 tool 结果引用了不存在的 tool_call id 的场景。
    // 通过 mock listMessages 返回含孤儿 tool 结果的消息。
    mockListMessages.mockReturnValue([
      { id: "u1", role: "user", content: "任务", timestamp: 1, status: "done" },
      {
        id: "a1", role: "assistant", content: "调用工具",
        toolCalls: [
          { id: "call_1", tool: "bash", args: {}, status: "done", result: "R1" },
        ],
        timestamp: 2, status: "done",
      },
      // 孤儿：assistant a1 只声明了 call_1，但多出一条 call_ghost 的结果
      { id: "ghost", role: "tool", toolCallId: "call_ghost", content: "幽灵结果", timestamp: 3, status: "done" },
      { id: "u2", role: "user", content: "继续", timestamp: 4, status: "done" },
    ]);

    const result = await (loop as any).buildMessages("sess-fix-003");
    const toolIds = result.filter((m: any) => m.role === "tool").map((t: any) => t.toolCallId);
    // call_ghost 的孤儿结果被删除；call_1 正常保留
    expect(toolIds).toContain("call_1");
    expect(toolIds).not.toContain("call_ghost");
  });

  it("FIX-004: 预算充足（不裁剪）时输出与输入一致，配对完整", async () => {
    mockListMessages.mockReturnValue([
      { id: "u1", role: "user", content: "任务", timestamp: 1, status: "done" },
      {
        id: "a1", role: "assistant", content: "调用工具",
        toolCalls: [
          { id: "call_1", tool: "bash", args: {}, status: "done", result: "R1" },
          { id: "call_2", tool: "bash", args: {}, status: "done", result: "R2" },
        ],
        timestamp: 2, status: "done",
      },
      { id: "u2", role: "user", content: "继续", timestamp: 4, status: "done" },
    ]);

    const result = await (loop as any).buildMessages("sess-fix-004");
    const assistant = result.find((m: any) => m.id === "a1");
    expect(assistant.tool_calls).toHaveLength(2);
    const tools = result.filter((m: any) => m.role === "tool");
    expect(tools.map((t: any) => t.toolCallId)).toEqual(["call_1", "call_2"]);
  });
});
