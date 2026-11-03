/**
 * `TurnWriter` 的判据（TW-*）。
 *
 * 用**记录型假存储**，断言"一个回合的落库顺序"：
 * hydrate → user 行 → assistant 壳 → 工具行（带 toolCallId + 回填状态）→ 收尾正文。
 * 顺序错了（例如先写 assistant 或忘了 hydrate），模型下一轮就看不到本回合的工具结果。
 */
import { describe, expect, it } from "vitest";

import { createTurnWriter, type TurnWriterStorage } from "../../packages/agent/src/turn-writer";

type Call = [string, ...unknown[]];

function fakeStorage(hydrateResult = 0) {
  const calls: Call[] = [];
  const storage: TurnWriterStorage = {
    createMessage: (m, sid) => calls.push(["createMessage", m, sid]),
    updateMessage: (id, patch) => calls.push(["updateMessage", id, patch]),
    addToolCall: (id, call) => calls.push(["addToolCall", id, call]),
    updateToolCall: (id, toolId, patch) => calls.push(["updateToolCall", id, toolId, patch]),
    hydrateSessionLog: async (sid) => {
      calls.push(["hydrateSessionLog", sid]);
      return hydrateResult;
    },
  };
  return { calls, storage };
}

describe("TW-1 begin", () => {
  it("先 hydrate，再建 user 行、再建 assistant 壳（顺序不能反）", async () => {
    const { calls, storage } = fakeStorage(3);
    const writer = createTurnWriter({
      sessionId: "s1",
      storage,
      now: () => 1000,
      idPrefix: "t",
    });
    const ids = await writer.begin("你好");
    expect(calls.map((c) => c[0])).toEqual(["hydrateSessionLog", "createMessage", "createMessage"]);
    expect(ids).toEqual({ userId: "t-user-1000", assistantId: "t-assistant-1000" });

    const user = calls[1][1] as Record<string, unknown>;
    const assistant = calls[2][1] as Record<string, unknown>;
    expect(user.role).toBe("user");
    expect(user.content).toBe("你好");
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("");
  });

  it("hydrate 失败不阻断回合（如实降级，不静默成功）", async () => {
    const storage = fakeStorage().storage;
    storage.hydrateSessionLog = async () => {
      throw new Error("disk down");
    };
    const writer = createTurnWriter({ sessionId: "s1", storage, now: () => 1 });
    await expect(writer.begin("x")).resolves.toEqual({ userId: "turn-user-1", assistantId: "turn-assistant-1" });
  });

  it("重复 begin 直接报错（一个回合只允许一条助手行）", async () => {
    const { storage } = fakeStorage();
    const writer = createTurnWriter({ sessionId: "s1", storage, now: () => 1 });
    await writer.begin("a");
    await expect(writer.begin("b")).rejects.toThrow(/只能调用一次/);
  });
});

describe("TW-2 onToolResult", () => {
  it("写 role=tool 行（带 toolCallId）+ 回填工具状态", async () => {
    const { calls, storage } = fakeStorage();
    const writer = createTurnWriter({ sessionId: "s1", storage, now: () => 5, idPrefix: "h" });
    const { assistantId } = await writer.begin("读文件");
    calls.length = 0;
    writer.onToolResult({
      toolCall: { id: "call-1", name: "read", input: { path: "a.txt" } },
      result: { output: "hello" },
    });
    expect(calls.map((c) => c[0])).toEqual(["addToolCall", "createMessage", "updateToolCall"]);
    const row = calls[1][1] as Record<string, unknown>;
    expect(row.role).toBe("tool");
    expect(row.toolCallId).toBe("call-1");
    expect(row.content).toBe("hello");
    expect(calls[0][1]).toBe(assistantId);
    expect(calls[2][1]).toBe(assistantId);
  });

  it("没有 id 的调用不写法（避免造孤儿行）", async () => {
    const { calls, storage } = fakeStorage();
    const writer = createTurnWriter({ sessionId: "s1", storage, now: () => 5 });
    await writer.begin("x");
    calls.length = 0;
    writer.onToolResult({ toolCall: { id: "", name: "read" }, result: {} });
    expect(calls).toEqual([]);
  });
});

describe("TW-3 finish", () => {
  it("成功写 done、失败写 error（正文都要写）", async () => {
    const { calls, storage } = fakeStorage();
    const writer = createTurnWriter({ sessionId: "s1", storage, now: () => 9, idPrefix: "h" });
    const { assistantId } = await writer.begin("x");
    calls.length = 0;
    writer.finish("答案", "succeeded");
    expect(calls[0]).toEqual(["updateMessage", assistantId, { content: "答案", status: "done" }]);
    calls.length = 0;
    writer.finish("坏了", "failed");
    expect(calls[0]).toEqual(["updateMessage", assistantId, { content: "坏了", status: "error" }]);
  });
});
