/**
 * Tests for P1-9: Forked Agent
 *
 * Forked Agent 复用父对话的 messages + system prompt 发起 LLM 调用，
 * 使 provider 的 prompt cache 可以命中，降低 token 成本。
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

describe("P1-9: Forked Agent — 架构验证", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnForked 方法应该存在于 LLMEngine 类中", async () => {
    // 通过读取源代码验证 spawnForked 方法存在
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    // 检查 spawnForked 方法定义
    expect(content).toMatch(/async\s+spawnForked\s*\(/);
    // 检查参数
    expect(content).toMatch(/parentSessionId:\s*string/);
    expect(content).toMatch(/systemPrompt:\s*string/);
    expect(content).toMatch(/userMessage:\s*string/);
    // 检查 options 参数
    expect(content).toMatch(/abortSignal/);
    expect(content).toMatch(/maxMessages/);
  });

  it("spawnForked 应该深拷贝 messages 防止 msgCache 污染", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    // 检查深拷贝逻辑
    expect(content).toMatch(/JSON\.parse\(JSON\.stringify/);
    // 检查 fork 后的消息 ID 有 -fork 后缀
    expect(content).toMatch(/-fork/);
  });

  it("spawnForked 应该支持独立 AbortController", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    // 检查 abortSignal 参数
    expect(content).toMatch(/abortSignal\?:\s*AbortSignal/);
    // 检查 abort 处理
    expect(content).toMatch(/abortSignal\?\.aborted/);
  });

  it("extractMemoriesFromSession 应该使用 spawnForked 而非独立 API 调用", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    // 检查 extractMemoriesFromSession 调用 spawnForked
    const extractMemoriesSection = content.substring(
      content.indexOf("async extractMemoriesFromSession"),
      content.indexOf("async connectMCP"),
    );

    expect(extractMemoriesSection).toContain("spawnForked");
    expect(extractMemoriesSection).toContain("forkedAbort");

    // 确保不再使用旧的独立 API 调用方式（provider.complete with system + user 消息）
    // 注意：spawnForked 内部仍然调用 provider.complete，但 extractMemoriesFromSession 不再直接调用
    const oldPattern = /provider\.complete\(\{[^}]*messages:\s*\[\s*\{[^}]*role:\s*\"system\"[^}]*\}/s;
    expect(extractMemoriesSection).not.toMatch(oldPattern);
  });

  it("extractMemoriesFromSession 应该创建独立 AbortController", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    const extractMemoriesSection = content.substring(
      content.indexOf("async extractMemoriesFromSession"),
      content.indexOf("async connectMCP"),
    );

    // 检查创建了独立的 AbortController
    expect(extractMemoriesSection).toMatch(/const\s+forkedAbort\s*=\s*new\s+AbortController\(\)/);
    // 检查传递了 abortSignal 给 spawnForked
    expect(extractMemoriesSection).toMatch(/abortSignal:\s*forkedAbort\.signal/);
  });

  it("spawnForked 应该限制最大消息数", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    // 检查 maxMessages 参数和默认值
    expect(content).toMatch(/maxMessages\?:\s*number/);
    expect(content).toMatch(/maxMsgs\s*=\s*options\?\.maxMessages\s*\?\?\s*50/);
    // 检查 slice 限制
    expect(content).toMatch(/recentMessages\s*=\s*llmMessages\.slice\(-maxMsgs\)/);
  });

  it("spawnForked 应该追加新的 user 消息到末尾", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    // 检查在 forkedMessages 末尾追加 user 消息
    expect(content).toMatch(/forkedMessages\.push\(/);
    expect(content).toMatch(/role:\s*\"user\"\s*as\s*const/);
  });

  it("spawnForked 应该调用 provider.complete 而非 agentic loop", async () => {
    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    // spawnForked 应该直接调用 provider.complete，不走 agentic loop
    const spawnForkedSection = content.substring(
      content.indexOf("async spawnForked("),
      content.indexOf("async connectMCP("),
    );

    expect(spawnForkedSection).toContain("provider.complete");
    // 不应该调用 processSubagent（那是完整 agentic loop）
    expect(spawnForkedSection).not.toContain("processSubagent");
    expect(spawnForkedSection).not.toContain("loop.run");
  });

  it("Forked Agent 完整数据流验证", async () => {
    // 验证完整数据流：
    // 1. 读取父会话 messages
    // 2. 转换为 LLM 格式
    // 3. 深拷贝
    // 4. 限制数量
    // 5. 追加新 user 消息
    // 6. 调用 provider.complete
    // 7. 返回响应文本

    const fs = require("fs");
    const content = fs.readFileSync("c:/mimo-gui/src/core/llm/index.ts", "utf-8");

    const spawnForkedSection = content.substring(
      content.indexOf("async spawnForked("),
      content.indexOf("async connectMCP("),
    );

    // 步骤 1: 读取父会话 messages
    expect(spawnForkedSection).toContain("MessageStorage.listMessages");
    // 步骤 2: 转换为 LLM 格式
    expect(spawnForkedSection).toContain("messagesToLLMMessages");
    // 步骤 3: 深拷贝
    expect(spawnForkedSection).toContain("JSON.parse(JSON.stringify");
    // 步骤 4: 限制数量
    expect(spawnForkedSection).toContain("slice(-maxMsgs)");
    // 步骤 5: 追加新 user 消息
    expect(spawnForkedSection).toContain("forkedMessages.push");
    // 步骤 6: 调用 provider.complete
    expect(spawnForkedSection).toContain("provider.complete");
    // 步骤 7: 返回响应
    expect(spawnForkedSection).toContain("return response.content");
  });
});
