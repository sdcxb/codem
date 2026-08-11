/**
 * 组件渲染测试 — 状态管理 Store
 *
 * 验证 Zustand store 的实际行为：消息添加/更新、流式状态切换。
 * 这比读源码字符串更能捕获回归。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
import type { Message } from "../store";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content: "test",
    timestamp: Date.now(),
    status: "done",
    ...overrides,
  };
}

describe("useAppStore — 状态管理行为测试", () => {
  beforeEach(() => {
    // 重置 store 状态
    const store = useAppStore.getState();
    store.messages = [];
    store.isStreaming = false;
    store.activeSessions.clear();
    store.stepProgress = null;
    store.llmStatus = null;
    store.streamStartTime = null;
  });

  it("addMessage：添加消息到列表", () => {
    const store = useAppStore.getState();
    const msg = makeMessage({ id: "test-1", content: "hello" });
    store.addMessage(msg);

    const messages = useAppStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("test-1");
    expect(messages[0].content).toBe("hello");
  });

  it("addMessage：多条消息按顺序追加", () => {
    const store = useAppStore.getState();
    store.addMessage(makeMessage({ id: "m1", content: "first" }));
    store.addMessage(makeMessage({ id: "m2", content: "second" }));
    store.addMessage(makeMessage({ id: "m3", content: "third" }));

    const messages = useAppStore.getState().messages;
    expect(messages).toHaveLength(3);
    expect(messages[0].id).toBe("m1");
    expect(messages[2].id).toBe("m3");
  });

  it("updateMessage：更新指定消息内容", () => {
    const store = useAppStore.getState();
    store.addMessage(makeMessage({ id: "u1", content: "original" }));
    store.updateMessage("u1", { content: "updated" });

    const messages = useAppStore.getState().messages;
    expect(messages[0].content).toBe("updated");
  });

  it("updateMessage：更新不存在的消息不报错", () => {
    const store = useAppStore.getState();
    expect(() => store.updateMessage("nonexistent", { content: "x" })).not.toThrow();
  });

  it("setStreaming：设置流式状态", () => {
    const store = useAppStore.getState();
    store.setStreaming(true);
    expect(useAppStore.getState().isStreaming).toBe(true);

    store.setStreaming(false);
    expect(useAppStore.getState().isStreaming).toBe(false);
  });

  it("setSessionActive：管理 activeSessions Map", () => {
    const store = useAppStore.getState();
    store.setSessionActive("session-1", true);
    expect(useAppStore.getState().activeSessions.has("session-1")).toBe(true);

    store.setSessionActive("session-1", false);
    expect(useAppStore.getState().activeSessions.has("session-1")).toBe(false);
  });

  it("setStreaming + setSessionActive：多会话隔离", () => {
    const store = useAppStore.getState();

    // session-1 开始流式
    store.setSessionActive("session-1", true);
    store.setStreaming(true);
    expect(useAppStore.getState().isStreaming).toBe(true);

    // session-2 也开始流式
    store.setSessionActive("session-2", true);

    // session-1 结束，但 session-2 仍在运行
    store.setSessionActive("session-1", false);
    store.setStreaming(false);
    expect(useAppStore.getState().isStreaming).toBe(true); // 因为 session-2 还在

    // session-2 也结束
    store.setSessionActive("session-2", false);
    store.setStreaming(false);
    expect(useAppStore.getState().isStreaming).toBe(false);
  });

  it("addToolCall：添加工具调用到消息", () => {
    const store = useAppStore.getState();
    store.addMessage(makeMessage({ id: "tc-1", role: "assistant", content: "" }));

    store.addToolCall("tc-1", {
      id: "tool-1",
      name: "read",
      args: { path: "/test.ts" },
      status: "running",
    });

    const messages = useAppStore.getState().messages;
    expect(messages[0].toolCalls).toBeDefined();
    expect(messages[0].toolCalls![0].name).toBe("read");
    expect(messages[0].toolCalls![0].status).toBe("running");
  });

  it("updateToolCall：更新工具调用状态", () => {
    const store = useAppStore.getState();
    store.addMessage(makeMessage({ id: "tc-2", role: "assistant", content: "" }));
    store.addToolCall("tc-2", {
      id: "tool-2",
      name: "write",
      args: { path: "/test.ts" },
      status: "running",
    });

    store.updateToolCall("tc-2", "tool-2", {
      status: "done",
      result: "success",
    });

    const messages = useAppStore.getState().messages;
    expect(messages[0].toolCalls![0].status).toBe("done");
    expect(messages[0].toolCalls![0].result).toBe("success");
  });

  it("setStepProgress：设置步骤进度", () => {
    const store = useAppStore.getState();
    store.setStepProgress({
      currentStep: 2,
      totalSteps: 5,
      label: "Executing tools",
    });

    const progress = useAppStore.getState().stepProgress;
    expect(progress).not.toBeNull();
    expect(progress!.currentStep).toBe(2);
    expect(progress!.totalSteps).toBe(5);
  });

  it("setLLMStatus：设置 LLM 连接状态", () => {
    const store = useAppStore.getState();
    store.setLLMStatus("streaming");
    expect(useAppStore.getState().llmStatus).toBe("streaming");

    store.setLLMStatus(null);
    expect(useAppStore.getState().llmStatus).toBeNull();
  });
});
