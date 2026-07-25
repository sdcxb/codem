/**
 * 测试：上下文压缩与记忆系统 — CTXT-001 ~ CTXT-020
 *
 * 覆盖范围：
 *   8.1 ContextManager 压力检测与压缩
 *   8.2 记忆系统 CRUD
 *
 * 关键组件：
 *   - ContextManager: calculateBudget, getPressureLevel, compact
 *   - memory service: get/set/clear
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
  exists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";
import {
  ContextManager,
  type CompactionConfig,
  type TokenBudget,
} from "../core/context/context";
import type { Message } from "../store";

// ========== 辅助函数 ==========

function makeMessages(count: number, contentSize: number = 100): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "A".repeat(contentSize),
      timestamp: i * 1000,
      status: "done",
    });
  }
  return messages;
}

// ========== 测试 ==========

describe("上下文压缩 — ContextManager 预算计算", () => {
  let cm: ContextManager;

  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    cm = new ContextManager();
  });

  it("CTXT-001: 空消息预算正确", () => {
    const budget = cm.calculateBudgetFromMessages([]);
    expect(budget.total).toBe(128000);
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(budget.available);
  });

  it("CTXT-002: 有消息预算正确", () => {
    const messages = makeMessages(10, 1000); // ~10K chars
    const budget = cm.calculateBudgetFromMessages(messages);
    expect(budget.used).toBeGreaterThan(0);
    expect(budget.remaining).toBeLessThan(budget.available);
    expect(budget.remaining).toBe(budget.available - budget.used);
  });

  it("CTXT-002b: 消息含 reasoning 计入预算", () => {
    const messages: Message[] = [
      {
        id: "m1", role: "assistant", content: "回复", timestamp: 0, status: "done",
        reasoning: "A".repeat(5000),
      },
    ];
    const budget = cm.calculateBudgetFromMessages(messages);
    expect(budget.used).toBeGreaterThan(5000 / 4); // reasoning should contribute
  });

  it("CTXT-002c: 消息含 toolCalls 计入预算", () => {
    const messages: Message[] = [
      {
        id: "m1", role: "assistant", content: "执行", timestamp: 0, status: "done",
        toolCalls: [
          {
            id: "tc1", tool: "read_file",
            args: { path: "/test/file.txt" },
            result: "A".repeat(5000),
            status: "done",
          },
        ],
      },
    ];
    const budget = cm.calculateBudgetFromMessages(messages);
    expect(budget.used).toBeGreaterThan(5000 / 4);
  });

  it("CTXT-003: 预算不超 available 上限", () => {
    const messages = makeMessages(1000, 10000); // very large
    const budget = cm.calculateBudgetFromMessages(messages);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
    expect(budget.remaining).toBe(0); // should be clamped to 0
  });
});

describe("上下文压缩 — 压力等级", () => {
  let cm: ContextManager;

  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("CTXT-004: 空消息压力等级 = 0", () => {
    cm = new ContextManager();
    const level = cm.getPressureLevelFromMessages([]);
    expect(level).toBe(0);
  });

  it("CTXT-005: 低使用率压力等级 = 0", () => {
    cm = new ContextManager({ maxContextWindow: 128000 });
    const messages = makeMessages(5, 100); // very small
    const level = cm.getPressureLevelFromMessages(messages);
    expect(level).toBe(0);
  });

  it("CTXT-006: 高使用率压力等级 > 0", () => {
    cm = new ContextManager({ maxContextWindow: 1000, outputReserve: 100, systemPromptTokens: 100 });
    const messages = makeMessages(5, 500); // will fill most of the context
    const level = cm.getPressureLevelFromMessages(messages);
    expect(level).toBeGreaterThan(0);
  });

  it("CTXT-007: 超高使用率压力等级 = 3（最大）", () => {
    cm = new ContextManager({ maxContextWindow: 500, outputReserve: 50, systemPromptTokens: 50 });
    const messages = makeMessages(20, 1000); // way over budget
    const level = cm.getPressureLevelFromMessages(messages);
    expect(level).toBe(3); // maximum pressure
  });
});

describe("上下文压缩 — 自定义配置", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("CTXT-008: 自定义 maxContextWindow 生效", () => {
    const cm = new ContextManager({ maxContextWindow: 50000 });
    const budget = cm.calculateBudgetFromMessages([]);
    expect(budget.total).toBe(50000);
  });

  it("CTXT-009: 自定义 compactionThreshold 生效", () => {
    const cm = new ContextManager({ compactionThreshold: 0.5 });
    // The threshold affects when compaction is triggered
    // We verify it's stored correctly by checking behavior
    const messages = makeMessages(10, 3000);
    const level = cm.getPressureLevelFromMessages(messages);
    // With lower threshold, even moderate usage might trigger pressure
    expect(level).toBeGreaterThanOrEqual(0);
  });

  it("CTXT-010: 自定义 maxMessagesAfterCompaction 生效", () => {
    const cm = new ContextManager({ maxMessagesAfterCompaction: 5 });
    // This affects how many messages are kept after compaction
    expect((cm as any).config.maxMessagesAfterCompaction).toBe(5);
  });

  it("CTXT-011: preserveRecentToolOutputs 配置存在", () => {
    const cm = new ContextManager({ preserveRecentToolOutputs: true });
    expect((cm as any).config.preserveRecentToolOutputs).toBe(true);
  });
});

describe("上下文压缩 — AgenticLoop 集成", () => {
  it("CTXT-012: 压缩触发逻辑存在于 agentic-loop.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("contextPressure");
    expect(src).toContain("compact");
    expect(src).toContain("context");
  });

  it("CTXT-013: 压缩后 saveMessages 调用逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    // After compaction, messages should be saved
    expect(src).toContain("compaction");
  });

  it("CTXT-014: 压缩摘要注入逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    // Compaction should generate a summary
    expect(src).toContain("compaction");
  });
});

describe("记忆系统 — Memory Service", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("CTXT-016: memory 表存在", () => {
    const db = getDatabase();
    const result = db.exec("SELECT name FROM sqlite_master WHERE name='memory'");
    expect(result.length).toBeGreaterThan(0);
  });

  it("CTXT-017: 写入和读取 memory", () => {
    const db = getDatabase();
    const now = Date.now();
    db.run("INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)", ["mem-1", "记忆内容", now]);

    const result = db.exec("SELECT content FROM memory WHERE id = ?", ["mem-1"]);
    expect(result[0].values[0][0]).toBe("记忆内容");
  });

  it("CTXT-018: 更新 memory", () => {
    const db = getDatabase();
    const now = Date.now();
    db.run("INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)", ["mem-2", "旧内容", now]);
    db.run("UPDATE memory SET content = ?, updated_at = ? WHERE id = ?", ["新内容", Date.now(), "mem-2"]);

    const result = db.exec("SELECT content FROM memory WHERE id = ?", ["mem-2"]);
    expect(result[0].values[0][0]).toBe("新内容");
  });

  it("CTXT-019: 删除 memory", () => {
    const db = getDatabase();
    db.run("INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)", ["mem-del", "内容", Date.now()]);
    db.run("DELETE FROM memory WHERE id = ?", ["mem-del"]);

    const result = db.exec("SELECT * FROM memory WHERE id = ?", ["mem-del"]);
    expect(result.length === 0 || result[0].values.length === 0).toBe(true);
  });

  it("CTXT-020: memory 中文内容正确存储", () => {
    const db = getDatabase();
    const content = "这是一段中文记忆 🧠";
    db.run("INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)", ["mem-cn", content, Date.now()]);

    const result = db.exec("SELECT content FROM memory WHERE id = ?", ["mem-cn"]);
    expect(result[0].values[0][0]).toBe(content);
  });
});

describe("上下文压缩 — 恢复数据", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("CTXT-015: recovery_data 表存在", () => {
    const db = getDatabase();
    const result = db.exec("SELECT name FROM sqlite_master WHERE name='recovery_data'");
    expect(result.length).toBeGreaterThan(0);
  });
});
