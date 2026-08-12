/**
 * Tests for P1-9: Forked Agent
 *
 * Forked Agent 复用父对话的 messages + system prompt 发起 LLM 调用，
 * 使 provider 的 prompt cache 可以命中，降低 token 成本。
 *
 * 行为测试 — 导入真实模块，验证导出和方法存在性。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock storage/database
vi.mock("../core/storage/database", () => ({
  getDatabase: () => ({
    run: vi.fn(),
    exec: vi.fn().mockReturnValue([]),
  }),
  persistDatabase: vi.fn(),
}));

vi.mock("../core/storage/message", () => ({
  listMessages: vi.fn().mockReturnValue([
    { id: "msg-1", role: "user", content: "Hello", timestamp: Date.now() },
    { id: "msg-2", role: "assistant", content: "Hi there!", timestamp: Date.now() },
    { id: "msg-3", role: "user", content: "How are you?", timestamp: Date.now() },
    { id: "msg-4", role: "assistant", content: "I'm good!", timestamp: Date.now() },
    { id: "msg-5", role: "user", content: "What is 2+2?", timestamp: Date.now() },
    { id: "msg-6", role: "assistant", content: "4", timestamp: Date.now() },
    { id: "msg-7", role: "user", content: "Thanks!", timestamp: Date.now() },
    { id: "msg-8", role: "assistant", content: "You're welcome!", timestamp: Date.now() },
    { id: "msg-9", role: "user", content: "Goodbye", timestamp: Date.now() },
    { id: "msg-10", role: "assistant", content: "See you later!", timestamp: Date.now() },
  ]),
  messagesToLLMMessages: vi.fn().mockReturnValue([
    { id: "msg-1", role: "user", content: "Hello" },
    { id: "msg-2", role: "assistant", content: "Hi there!" },
    { id: "msg-3", role: "user", content: "How are you?" },
    { id: "msg-4", role: "assistant", content: "I'm good!" },
    { id: "msg-5", role: "user", content: "What is 2+2?" },
    { id: "msg-6", role: "assistant", content: "4" },
    { id: "msg-7", role: "user", content: "Thanks!" },
    { id: "msg-8", role: "assistant", content: "You're welcome!" },
    { id: "msg-9", role: "user", content: "Goodbye" },
    { id: "msg-10", role: "assistant", content: "See you later!" },
  ]),
  createMessage: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  getSettingJSON: vi.fn().mockReturnValue(null),
  setSettingJSON: vi.fn(),
}));

vi.mock("../core/storage/transcript-cache", () => ({
  TranscriptCache: {
    buildKey: vi.fn().mockResolvedValue("mock-key"),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("../core/i18n/lang", () => ({
  getLang: vi.fn().mockReturnValue("zh"),
}));

import { LLMEngine } from "../core/llm/index";

describe("P1-9: Forked Agent — 行为验证", () => {
  let engine: LLMEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new LLMEngine();
  });

  it("LLMEngine 类可实例化", () => {
    expect(engine).toBeInstanceOf(LLMEngine);
  });

  it("spawnForked 方法存在于 LLMEngine 原型上", () => {
    expect(typeof engine.spawnForked).toBe("function");
  });

  it("extractMemoriesFromSession 方法存在于 LLMEngine 原型上", () => {
    expect(typeof engine.extractMemoriesFromSession).toBe("function");
  });

  it("spawnForked 返回 Promise（async 方法）", () => {
    // spawnForked 是 async，调用后应返回 Promise
    // 不传 provider 时会抛错，但返回值类型应为 Promise
    const result = engine.spawnForked("test-session", "system", "user msg");
    expect(result).toBeInstanceOf(Promise);
    // 静默消费 rejection 避免未处理的 rejection 警告
    result.catch(() => {});
  });

  it("extractMemoriesFromSession 返回 Promise（async 方法）", () => {
    const result = engine.extractMemoriesFromSession("test-session");
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {});
  });
});
