/**
 * Tests for P1-6: 工具中断行为
 *
 * 行为测试 — 导入真实模块，验证类和方法存在性及行为。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../core/storage/database", () => ({
  getDatabase: () => ({ run: vi.fn(), exec: vi.fn().mockReturnValue([]) }),
  persistDatabase: vi.fn(),
}));

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

import { StreamingToolExecutorImpl, getStreamingToolExecutor } from "../core/llm/streaming-executor";

describe("P1-6: 工具中断行为 — 行为验证", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("StreamingToolExecutorImpl 类可导入", () => {
    expect(StreamingToolExecutorImpl).toBeDefined();
    expect(typeof StreamingToolExecutorImpl).toBe("function");
  });

  it("getStreamingToolExecutor 返回实例", () => {
    const executor = getStreamingToolExecutor();
    expect(executor).toBeInstanceOf(StreamingToolExecutorImpl);
  });

  it("executor 暴露 abortAll 方法", () => {
    const executor = getStreamingToolExecutor();
    expect(typeof executor.abortAll).toBe("function");
  });

  it("executor 暴露 getRunning 方法", () => {
    const executor = getStreamingToolExecutor();
    expect(typeof executor.getRunning).toBe("function");
  });

  it("abortAll 后 getRunning 返回空数组", () => {
    const executor = getStreamingToolExecutor();
    executor.abortAll();
    expect(executor.getRunning()).toEqual([]);
  });
});
