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

import * as fs from "fs";
import * as path from "path";

import { getStoragePort } from "../core/storage/port";
import { MemoryService } from "../core/memory/memory";
import type { FakeStoragePort } from "./fake-storage-port";
import {
  ContextManager,
  type CompactionConfig,
  type TokenBudget,
} from "../core/context/context";
import type { Message } from "../store";

// ========== 辅助函数 ==========

/**
 * **存储 schema 的真源**（第 18 轮，L1）。
 *
 * 这里原来用 `getDatabase().exec("SELECT name FROM sqlite_master WHERE name='memory'")`
 * 问旧引擎"表建出来没有"。旧库在 rust 模式下**刻意不加载**（`setup.ts` 也不再 `initDatabase()`），
 * 而引擎建库执行的就是这份 `schema.sql`（`codem-db` 侧 `migrate.rs`）—— 所以判据换成读它：
 * 断言的对象（"这张表在存储里存在"）与强度都没变，只是**真源从旧库的目录表搬到了 Rust 侧 schema**。
 */
const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/codem-db/sql/schema.sql"),
  "utf-8",
);

/** `schema.sql` 是否声明了这张表（等价于旧库那一次 `sqlite_master` 查询） */
function schemaDeclaresTable(table: string): boolean {
  return new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(`).test(SCHEMA_SQL);
}

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

  beforeEach(() => {
    /*
     * 第 18 轮（L1）：这里原来的 `resetDatabase()` / `initDatabase()` 是**只为旧库存在**的清理。
     * `setup.ts` 每个用例前都注册一个干净的内存端口（旧引擎刻意不加载），端口本身就是空的，
     * 所以这一段没有存在的必要 —— 留着只会让"测试依赖旧引擎"这件事继续隐身。
     */
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

  beforeEach(() => {
    /*
     * 第 18 轮（L1）：这里原来的 `resetDatabase()` / `initDatabase()` 是**只为旧库存在**的清理。
     * `setup.ts` 每个用例前都注册一个干净的内存端口（旧引擎刻意不加载），端口本身就是空的，
     * 所以这一段没有存在的必要 —— 留着只会让"测试依赖旧引擎"这件事继续隐身。
     */
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
  beforeEach(() => {
    /*
     * 第 18 轮（L1）：这里原来的 `resetDatabase()` / `initDatabase()` 是**只为旧库存在**的清理。
     * `setup.ts` 每个用例前都注册一个干净的内存端口（旧引擎刻意不加载），端口本身就是空的，
     * 所以这一段没有存在的必要 —— 留着只会让"测试依赖旧引擎"这件事继续隐身。
     */
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
  beforeEach(() => {
    /*
     * 第 18 轮（L1）：这里原来的 `resetDatabase()` / `initDatabase()` 是**只为旧库存在**的清理。
     * `setup.ts` 每个用例前都注册一个干净的内存端口（旧引擎刻意不加载），端口本身就是空的，
     * 所以这一段没有存在的必要 —— 留着只会让"测试依赖旧引擎"这件事继续隐身。
     */
    localStorage.clear();
  });

  /** 当前用例的存储端口（`setup.ts` 每例注册一个内存假端口） */
  function port(): FakeStoragePort {
    return getStoragePort() as unknown as FakeStoragePort;
  }

  // CTXT-016
  it("CTXT-016: memory 表存在", () => {
    expect(schemaDeclaresTable("memory"), "memory 表必须由引擎 schema 建出").toBe(true);
  });

  /**
   * CTXT-017 ~ CTXT-020：**记忆存取走产品路径 + 端口**（第 18 轮，L1）。
   *
   * 原来这四条直接用裸 SQL 打旧库的 `memory` 表（`INSERT` / `SELECT` / `UPDATE` / `DELETE`）。
   * 旧库在 rust 模式下刻意不存在，而且产品**根本不读写那张表** —— 记忆走的是
   * `saveMemory` / `loadMemory`（配置面扩展域：内存镜像 + `memory.set` 写穿）。
   * 判据因此换成端口语义，断言的对象（"记忆内容存得进、读得回"）与强度保持不变：
   *   ① 写入必须**写穿到端口**（`memory.set`）—— 只改内存不算存下来；
   *   ② 读取走**产品路径**：新建一个 `MemoryService` 从存储重新加载（等价于原来那次 SELECT）。
   */
  it("CTXT-017: 写入和读取 memory", () => {
    const svc = new MemoryService();
    const entry = svc.add({ scope: "global", key: "k1", content: "记忆内容" });

    expect(
      port().__writes().some((w) => w.command === "memory.set"),
      "记忆必须写穿到端口（只改内存不算存下来）",
    ).toBe(true);

    const reloaded = new MemoryService();
    expect(reloaded.get(entry.id)!.content).toBe("记忆内容");
  });

  // CTXT-018
  it("CTXT-018: 更新 memory", () => {
    const svc = new MemoryService();
    const entry = svc.add({ scope: "global", key: "k2", content: "旧内容" });
    expect(svc.update(entry.id, { content: "新内容" })).toBe(true);

    const reloaded = new MemoryService();
    expect(reloaded.get(entry.id)!.content).toBe("新内容");
  });

  // CTXT-019
  it("CTXT-019: 删除 memory", () => {
    const svc = new MemoryService();
    const entry = svc.add({ scope: "global", key: "k3", content: "内容" });
    expect(svc.delete(entry.id)).toBe(true);

    // 删除同样要落库：重载后不得复活（原来断言的是"旧库里查不到这行了"）
    const reloaded = new MemoryService();
    expect(reloaded.get(entry.id), "删除后重新加载不得再出现").toBeUndefined();
  });

  // CTXT-020
  it("CTXT-020: memory 中文内容正确存储", () => {
    const content = "这是一段中文记忆 🧠";
    const svc = new MemoryService();
    const entry = svc.add({ scope: "global", key: "k4", content });

    const reloaded = new MemoryService();
    expect(reloaded.get(entry.id)!.content).toBe(content);
  });
});

describe("上下文压缩 — 恢复数据", () => {
  beforeEach(() => {
    /*
     * 第 18 轮（L1）：这里原来的 `resetDatabase()` / `initDatabase()` 是**只为旧库存在**的清理。
     * `setup.ts` 每个用例前都注册一个干净的内存端口（旧引擎刻意不加载），端口本身就是空的，
     * 所以这一段没有存在的必要 —— 留着只会让"测试依赖旧引擎"这件事继续隐身。
     */
    localStorage.clear();
  });

  it("CTXT-015: recovery_data 表存在", () => {
    expect(schemaDeclaresTable("recovery_data"), "recovery_data 表必须由引擎 schema 建出").toBe(true);
  });
});
