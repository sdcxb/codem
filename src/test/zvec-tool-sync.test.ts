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

  it("只读/并发集合包含 zvec_grep_search（防误拦截/串行）", async () => {
    // 并发名单已收敛到 concurrency-policy.ts，所以这里断言**名单内容**，
    // 而不是断言某个具体文件的文本里出现该字符串。
    //
    // 旧写法是 `expect(streaming).toContain('"zvec_grep_search"')`：它把
    // 「名单在哪两处硬编码」这件事也钉死了，于是任何把名单收敛到一个模块的重构
    // 都会红 —— 而收敛正是我们要的。断言内容而不是断言位置。
    const { CONCURRENCY_SAFE_TOOL_IDS } = await import("../core/llm/concurrency-policy");
    expect([...CONCURRENCY_SAFE_TOOL_IDS]).toContain("zvec_grep_search");
    expect([...CONCURRENCY_SAFE_TOOL_IDS]).toContain("zvec_grep_rg");

    // 名单必须真的被管线与调度器消费（而不是又一份没人读的真相）
    const pipeline = readFileSync(join(__dirname, "../core/llm/tool-pipeline.ts"), "utf-8");
    expect(pipeline).toContain("CONCURRENCY_SAFE_TOOL_IDS");
    const streaming = readFileSync(join(__dirname, "../core/llm/streaming-executor.ts"), "utf-8");
    expect(streaming).toContain("DEFAULT_CONCURRENCY_SAFE_TOOLS");

    // 子智能体的只读白名单仍须允许 zg 工具（这条与名单位置无关，保留原文断言）
    const agent = readFileSync(join(__dirname, "../core/agent/agent.ts"), "utf-8");
    expect(agent).toContain('"zvec_grep_search"');
    expect(agent).toContain('{ tool: "zvec_grep_search", action: "allow" }');
  });
});
