/**
 * 测试：临时会话（side-session，B1，对标 EAC dsh-side-session）纯逻辑层
 *
 * 覆盖 SIDES-001 ~ SIDES-005：
 *   - SIDES-001: collectSessionContext 取最近 user/assistant 消息（跳过 system）
 *   - SIDES-002: 消息窗口上限（最多 N 条）
 *   - SIDES-003: 超长消息截断
 *   - SIDES-004: buildSideMessages 组装 system + 历史 + 新问题
 *   - SIDES-005: 空会话也可提问（只有 system + 问题）
 */
import { describe, it, expect } from "vitest";
import { collectSessionContext, buildSideMessages, extractStreamDelta, SIDE_CTX_MAX_CHARS, SIDE_CTX_MAX_MESSAGES } from "../core/side-session/side-session";
import type { Message } from "../store";

function makeMsg(role: "user" | "assistant" | "system", content: string, id: string): Message {
  return { id, role, content, timestamp: Date.now(), status: "done" };
}

describe("side-session — 纯逻辑层", () => {
  it("SIDES-001: 收集最近 user/assistant 消息（跳过 system）", () => {
    const msgs = [
      makeMsg("system", "system content", "s1"),
      makeMsg("user", "你好", "u1"),
      makeMsg("assistant", "你好！", "a1"),
    ];
    const ctx = collectSessionContext(msgs, "会话", "D:/proj");
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(ctx.sessionTitle).toBe("会话");
    expect(ctx.cwd).toBe("D:/proj");
  });

  it("SIDES-002: 消息窗口上限生效", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < SIDE_CTX_MAX_MESSAGES + 20; i++) {
      msgs.push(makeMsg("user", `q${i}`, `u${i}`));
    }
    const ctx = collectSessionContext(msgs, "t", null);
    expect(ctx.messages.length).toBeLessThanOrEqual(SIDE_CTX_MAX_MESSAGES);
    // 保留最近的消息（窗口尾）
    expect(ctx.messages[ctx.messages.length - 1].id).toBe(`u${SIDE_CTX_MAX_MESSAGES + 19}`);
  });

  it("SIDES-003: 超长消息截断", () => {
    const long = "x".repeat(SIDE_CTX_MAX_CHARS + 500);
    const msgs = [makeMsg("user", long, "u1")];
    const ctx = collectSessionContext(msgs, "t", null);
    expect(ctx.messages[0].content.length).toBeLessThanOrEqual(SIDE_CTX_MAX_CHARS + 8); // 截断标记 ~8 字符
    expect(ctx.messages[0].content).toContain("截断");
  });

  it("SIDES-004: buildSideMessages 组装 system + 历史 + 新问题", () => {
    const msgs = [makeMsg("user", "第一问", "u1"), makeMsg("assistant", "第一答", "a1")];
    const ctx = collectSessionContext(msgs, "会话", "D:/proj");
    const llm = buildSideMessages(ctx, "追问");
    expect(llm.length).toBe(4); // system + 2 history + question
    expect(llm[0].role).toBe("system");
    expect(llm[0].content).toContain("D:/proj");
    expect(llm[1].content).toBe("第一问");
    expect(llm[2].role).toBe("assistant");
    expect(llm[3].role).toBe("user");
    expect(llm[3].content).toBe("追问");
  });

  it("SIDES-005: 空会话也可提问（只有 system + 问题）", () => {
    const ctx = collectSessionContext([], "空会话", null);
    const llm = buildSideMessages(ctx, "直接问");
    expect(llm.length).toBe(2);
    expect(llm[0].role).toBe("system");
    expect(llm[1].role).toBe("user");
    expect(llm[1].content).toBe("直接问");
  });

  it("SIDES-006: extractStreamDelta 提取 text_delta 增量，忽略其它事件", () => {
    expect(extractStreamDelta({ type: "text_delta", text: "你好" })).toBe("你好");
    expect(extractStreamDelta({ type: "start", id: "x", model: "m" })).toBe("");
    expect(extractStreamDelta({ type: "heartbeat" })).toBe("");
    expect(extractStreamDelta({ type: "reasoning_delta", text: "思考" })).toBe(""); // 推理不注入回答
    expect(extractStreamDelta({ type: "tool_use_delta", id: "t", input: "{}" })).toBe("");
    expect(extractStreamDelta("garbage")).toBe("");
    expect(extractStreamDelta(null)).toBe("");
  });

  it("SIDES-007: extractStreamDelta 兼容裸 content 事件", () => {
    expect(extractStreamDelta({ content: "x" })).toBe("x");
    expect(extractStreamDelta({ content: 123 })).toBe("");
  });
});
