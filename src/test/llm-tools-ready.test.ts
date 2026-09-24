/**
 * 第 115 轮（O-25）：把「延后注册」的六批工具变成**可等待**的 —— 契约用例。
 *
 * ## 为什么需要这条契约
 *
 * `LLMEngine` 里 squad / issue / agent-teams / computer-use / session-delegation / subagent-tools
 * 六批工具都是用 `import(spec).then(注册)` 注册的：**fire-and-forget，没有任何等待点**。
 * 第 114 轮量到的直接证据：`src/core/agent-teams/tools.ts` 的函数覆盖率会在
 * **24.13%（7/29）** 与 **62.06%（18/29）** 之间跳 —— 就是这条路径有时跑完、有时没跑完。
 * 放到真机上，含义是"引擎刚建好就发第一条消息时，工具表可能还缺这几批工具"。
 *
 * 修法：`whenToolsReady()`（等六批动态 import 落定）+ `process()` 在构建请求前 await 它。
 * 这份用例钉住契约：**await 之后，这些工具必须在工具表里**。
 */
import { describe, it, expect } from "vitest";
import { LLMEngine } from "../core/llm/index";

describe("LLMEngine — 延后注册工具的就绪屏障（O-25）", () => {
  it("TOOLS-READY-1 await whenToolsReady() 之后，agent-teams 一批在工具表里", async () => {
    const engine = new LLMEngine();
    await engine.whenToolsReady();
    const ids = engine.tools.getAll().map((t) => t.id);
    expect(ids).toContain("agent_teams_create");
    expect(ids).toContain("agent_teams_status");
    expect(ids).toContain("agent_teams_delete");
  });

  it("TOOLS-READY-2 屏障可重复 await（幂等；第二次不再新增工具、也不会挂住）", async () => {
    const engine = new LLMEngine();
    await engine.whenToolsReady();
    const before = engine.tools.getAll().length;
    await engine.whenToolsReady();
    expect(engine.tools.getAll().length).toBe(before);
  });

  it("TOOLS-READY-3 两次构造各自的屏障互不干扰（不是全局单例状态）", async () => {
    const a = new LLMEngine();
    const b = new LLMEngine();
    await Promise.all([a.whenToolsReady(), b.whenToolsReady()]);
    const count = (e: LLMEngine) => e.tools.getAll().filter((t) => t.id.startsWith("agent_teams_")).length;
    expect(count(a)).toBe(10);
    expect(count(b)).toBe(10);
  });

  it("TOOLS-READY-4 process() 仍是 async generator（屏障加在它内部，不改入口形状）", () => {
    const engine = new LLMEngine();
    const gen = engine.process("sess-x", "hi", process.cwd());
    expect(typeof gen[Symbol.asyncIterator]).toBe("function");
    void gen.return?.(undefined as never);
  });
});
