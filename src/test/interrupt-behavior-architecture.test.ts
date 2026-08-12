/**
 * Tests for P1-6: 工具中断行为
 *
 * 架构变更验证 — 通过读取源代码验证修改
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";

describe("P1-6: 工具中断行为 — 架构变更验证", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agentic-loop.ts toolCtx 不再设置 ctx.abort", () => {
    const content = fs.readFileSync("src/core/llm/agentic-loop.ts", "utf-8");

    // 验证 toolCtx 中的 abort 设为 undefined
    const toolCtxLines = content.split("\n").filter((line: string) =>
      line.includes("abort: undefined"),
    );

    expect(toolCtxLines.length).toBeGreaterThan(0);
  });

  it("agentic-loop.ts LoopState 包含 microCompactedThisRun", () => {
    const content = fs.readFileSync("src/core/llm/agentic-loop.ts", "utf-8");

    expect(content).toMatch(/microCompactedThisRun:\s*boolean/);
    expect(content).toMatch(/microCompactedThisRun:\s*false/);
    expect(content).toMatch(/this\.state\.microCompactedThisRun\s*=\s*true/);
  });

  it("streaming-executor.ts 为每个工具创建独立 AbortController", () => {
    const content = fs.readFileSync("src/core/llm/streaming-executor.ts", "utf-8");

    const abortControllerMatches = content.match(
      /tc\.abortController\s*=\s*new AbortController\(\);/g,
    );
    expect(abortControllerMatches?.length ?? 0).toBeGreaterThanOrEqual(2);

    const runningSetMatches = content.match(
      /this\.running\.set\(tc\.id,\s*tc\);/g,
    );
    expect(runningSetMatches?.length ?? 0).toBeGreaterThan(0);
  });

  it("streaming-executor.ts abortAll() 清理所有 running 状态", () => {
    const content = fs.readFileSync("src/core/llm/streaming-executor.ts", "utf-8");

    expect(content).toMatch(/abortAll\(\)/);
    expect(content).toMatch(/this\.running\.clear\(\)/);
  });

  it("streaming-executor.ts getRunning 返回当前运行的工具", () => {
    const content = fs.readFileSync("src/core/llm/streaming-executor.ts", "utf-8");

    expect(content).toMatch(/getRunning\(\)/);
    expect(content).toMatch(/Array\.from\(this\.running\.values\(\)\)/);
  });
});
