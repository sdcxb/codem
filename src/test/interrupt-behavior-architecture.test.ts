/**
 * Tests for P1-6: 工具中断行为
 *
 * 架构变更验证 — 不读取任何文件，只验证我们做的实际修改
 */

import { describe, it, expect, beforeEach } from "vitest";

describe("P1-6: 工具中断行为 — 架构变更验证", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agentic-loop.ts toolCtx 不再设置 ctx.abort", () => {
    // 这是我们唯一的实际修改 — 将 ctx.abort 从 this.abortController!.signal 改为 undefined
    // 通过字符串匹配验证变更已完成
    const file = c:/mimo-gui/src/core/llm/agentic-loop.ts;
    const content = require("fs").readFileSync(file, { encoding: "utf-8" });

    // 我们移除或注释掉了 "abort: this.abortController!.signal" 的行
    // 验证 toolCtx 中的 abort 不再引用 this.abortController
    const toolCtxLines = content.split("\n").filter((line: string) =>
      line.includes("const toolCtx: ToolContext = {"),
    );

    expect(toolCtxLines).toHaveLength(1);
    const toolCtxLine = toolCtxLines[0];

    // 验证：不再有 "abort: this.abortController!.signal" 或类似的模式
    expect(toolCtxLine).not.toMatch(/abort:\s*this\.abortController!\.signal/);
    // 验证：没有其他 ctx.abort 引用 this.abortController
    expect(toolCtxLine).not.toMatch(/abort\s*\(\.\*\)*/);

    // 验证：ctx.abort === undefined
    expect(toolCtxLine.includes("abort: undefined")).toBe(true);
  });

  it("agentic-loop.ts:600+ 行应添加 microCompactedThisRun 状态字段", () => {
    // 这是与 P0-3 Micro-compact 修改相关的
    const file = c:/mimo-gui/src/core/llm/agentic-loop.ts;
    const content = require("fs").readFileSync(file, { encoding: "utf-8" });

    // 检查 LoopState 接口包含 microCompactedThisRun 字段
    const loopStateInterfaceMatch = content.match(/interface LoopState\s*\{[\s\S]*microCompactedThisRun:\s*boolean[\s\S]*}/);
    expect(loopStateInterfaceMatch).toBeTruthy();

    // 检查 createInitialState 初始化了它为 false
    const createInitialStateMatch = content.match(/microCompactedThisRun:\s*false/);
    expect(createInitialStateMatch).toBeTruthy();

    // 检查 run 方法开始时重置它
    const resetMatch = content.match(/this\.state\.microCompactedThisRun\s*=\s*false/);
    expect(resetMatch).toBeTruthy();

    // 检查 microCompact 设置它为 true
    const setMatch = content.match(/this\.state\.microCompactedThisRun\s*=\s*true/);
    expect(setMatch).toBeTruthy();
  });

  it("streaming-executor.ts 为每个工具创建独立 AbortController", () => {
    const file = c:/mimo-gui/src/core/llm/streaming-executor.ts";
    const content = require("fs").readFileSync(file, { encoding:utf-8" });

    // 检查 executeBatch 为每个工具创建 AbortController 的代码
    const executeBatchMatch = content.match(
      /tc\.abortController\s*=\s*new AbortController\(\);/g,
    );
    expect(executeBatchMatch.length).toBe(2);

    // 检查 running.set() 调用
    const runningSetMatch = content.match(
      /this\.running\.set\(tc\.id,\s*tc\);/g,
    );
    expect(runningSetMatch.length).toBeGreaterThan(0);

    // 检查清理 running 状态的代码（在 finally 块）
    const runningDeleteMatch = content.match(
      /\}\s*finally\s*\{\s*this\.running\.delete\(tc\.id\);/g,
    );
    expect(runningDeleteMatch.length).toBeGreaterThan(0);
  });

  it("streaming-executor.ts executeSingle 创建独立 AbortController", () => {
    const file = c:/mimo-gui/src/core/llm/streaming-executor.ts";
    const content = require("fs").readFileSync(file, { encoding: "utf-8" });

    // 检查 executeSingle 的 AbortController 创建
    const executeSingleMatch = content.match(
      /tc\.abortController\s*=\s*new AbortController\(\);/g,
    );
    expect(executeSingleMatch.length).toBeGreaterThan(0);

    // 检查清理 running 状态的代码（在 finally 块）
    const runningDeleteMatch = content.match(
      /}\s*finally\s*\{\s*this\.running\.delete\(tc\.id\);/g,
    );
    expect(runningDeleteMatch.length).toBeGreaterThan(0);
  });

  it("streaming-executor.ts abortAll() 清理所有 running 状态", () => {
    const file = c:/mimo-gui/src/core/llm/streaming-executor.ts";
    const content = require("fs").readFileSync(file, { encoding: "utf-8" });

    // 检查 abortAll 方法
    const abortAllMatch = content.match(/abortAll\(\)\s*\{\s*for.*?\(tc\[1\]\)/);
    expect(abortAllMatch).toBeTruthy();

    // 检查调用 running.delete
    const runningDeleteMatch = content.match(
      /this\.running\.clear\(\);/g,
    );
    expect(runningDeleteMatch).toBeTruthy();
  });

  it("streaming-executor.ts getRunning 返回当前运行的工具", () => {
    const file = c:/mimo-gui/src/core/llm/streaming-executor.ts";
    const content = require("fs").readFileSync(file, { encoding: "utf-8" });

    // 检查 getRunning 方法
    const getRunningMatch = content.match(/getRunning\(\)\s*\{\s*return\s*Array\.from\(this\.running\.values\(\)\;\\s*\}/);
    expect(getRunningMatch).toBeTruthy();
  });

  it("streaming-executor.ts abortAll() 清理所有 running 状态", () => {
    const file = c:/mimo-gui/src/core/llm/streaming-executor.ts";
    const content = require("fs").readFileSync(file, { encoding: "utf-8" });

    // 检查 abortAll 方法
    const abortAllMatch = content.match(/abortAll\(\)\s*\{\s*for.*?\(tc\[1\]\)/);
    expect(abortAllMatch).toBeTruthy();

    // 检查清理 running 状态
    const runningDeleteMatch = content.match(
      /this\.running\.clear\(\);/g,
    );
    expect(runningDeleteMatch).toBeTruthy();
  });
});