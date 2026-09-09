/**
 * zvec-grep 工具接入回归 — 双轨路由契约：
 * 1) zg MCP 工具经 syncZvecTools 注册进共享 ToolRegistry（仿 codegraph）；
 * 2) 内置 grep 描述携带精确/语义双轨路由提示；
 * 3) 只读/并发/权限集合包含 zvec_grep_search，避免误拦截或串行化。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const llmTools = join(__dirname, "../core/llm/tools");

describe("zvec-grep 工具接入：双轨路由契约", () => {
  it("zvec-tool.ts 提供 syncZvecTools/createZvecTool 且服务器名 zvec_grep", async () => {
    const mod = await import("../core/llm/tools/zvec-tool");
    expect(typeof mod.syncZvecTools).toBe("function");
    expect(typeof mod.createZvecTool).toBe("function");
    expect(mod.ZVEC_MCP_SERVER_NAME).toBe("zvec_grep");
    expect(typeof mod.isZvecMcpTool).toBe("function");
  });

  it("engine 构建系统提示时同步 zg 工具（llm/index 调用 syncZvecTools）", () => {
    const src = readFileSync(join(__dirname, "../core/llm/index.ts"), "utf-8");
    expect(src).toContain("syncZvecTools");
    expect(src).toContain('this.syncZvecTools()');
  });

  it("内置 grep 工具描述携带双轨路由（精确→grep；语义/跨文件→zvec_grep_search）", () => {
    const src = readFileSync(join(llmTools, "../tools.ts"), "utf-8");
    expect(src).toContain("EXACT-route");
    expect(src).toContain("prefer zvec_grep_search");
    expect(src).toContain("zvec_grep_search then grep to verify");
  });

  it("只读/并发集合包含 zvec_grep_search（防误拦截/串行）", () => {
    const streaming = readFileSync(join(__dirname, "../core/llm/streaming-executor.ts"), "utf-8");
    expect(streaming).toContain('"zvec_grep_search"');
    const pipeline = readFileSync(join(__dirname, "../core/llm/tool-pipeline.ts"), "utf-8");
    expect(pipeline).toContain('"zvec_grep_search", "zvec_grep_rg"');
    const agent = readFileSync(join(__dirname, "../core/agent/agent.ts"), "utf-8");
    expect(agent).toContain('"zvec_grep_search"');
    expect(agent).toContain('{ tool: "zvec_grep_search", action: "allow" }');
  });
});
