/**
 * 水位优先使用「最近一次真实请求」的 promptTokens；可见集合变了必须退回估算。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage } from "../core/storage/message";
import { readContextWaterLevel, __resetWaterLevelCache } from "../core/context/water-level";
import {
  recordRequestContext,
  recordRequestPromptTokens,
  __resetRequestContextForTests,
} from "../core/llm/request-context";

const S = "sess-exact-water";

describe("水位真实请求快照", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __resetWaterLevelCache();
    __resetRequestContextForTests();
    setStoragePort(createFakeStoragePort({
      seed: {
        sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    }));
    createMessage({ id: "m1", role: "user", content: "真实请求消息", timestamp: 1, status: "done" }, S);
  });

  afterEach(() => {
    setStoragePort(null);
    __resetRequestContextForTests();
    vi.restoreAllMocks();
  });

  it("WX-1: 可见 id 完全一致时，used 用真实 promptTokens", () => {
    recordRequestContext({ sessionId: S, visibleIds: ["m1"], systemPrompt: "system", tools: [] });
    recordRequestPromptTokens(S, 1234);
    const level = readContextWaterLevel(S);
    expect(level.used).toBe(1234);
    expect(level.available).toBeGreaterThan(0);
  });

  it("WX-2: 可见集合变了（新消息）时，不拿上一轮真实值冒充", () => {
    recordRequestContext({ sessionId: S, visibleIds: ["m0"], systemPrompt: "system", tools: [] });
    recordRequestPromptTokens(S, 1234);
    createMessage({ id: "m2", role: "assistant", content: "新回复", timestamp: 2, status: "done" }, S);
    // m2 加入后 id 集合 = m1,m2，与快照 m0 不一致
    const level = readContextWaterLevel(S);
    expect(level.used).not.toBe(1234);
  });
});
