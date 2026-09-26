/**
 * 第 84 波审计修正：可持续子智能体（agent-teams 成员 / 后台 subagent）**缺阀门**。
 *
 * 修复前：
 *   ① 没有空闲看门狗 —— LLM 流挂死或工具卡住时，成员永远停在 running，
 *      队长/看板等不到结算，也没人知道为什么（进程里连一个能中断它的句柄都没有：
 *      子智能体的 scoped loop 不进 loopPool，`abortSession(childId)` 找不到它）；
 *   ② 没有轮次预算 —— 可持续子智能体可以被无限次唤醒，一个自我循环的成员
 *      或不停派活的队长能无上限烧 token；
 *   ③ 续聊轮被中止时仍结算成 **completed**（`aborted` 只用于 break），
 *      队长看到"成员已完成"，实际上这一轮什么都没做完。
 *
 * 修复后：空闲即中断并如实结算；轮次用尽明确报错；中止 = cancelled。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../core/storage/message", () => ({
  createMessage: vi.fn(),
  listMessages: vi.fn(() => []),
}));
/* 同 message-index-cutover：mock 要跟上真实接口（第 176 轮新增两个导出 + readAll） */
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => ({ append: vi.fn(), readAll: () => [] }),
  isSessionEventsReadable: () => true,
  whenSessionEventsLoaded: () => Promise.resolve(true),
}));

import { SubagentRuntime } from "../core/subagent/runtime";
import { LLMEngine } from "../core/llm/index";

/** 可控的假引擎：processSubagent 是一个由测试驱动的异步生成器 */
function makeEngine() {
  const calls: string[] = [];
  let mode: "complete" | "hang" = "complete";
  const engine = {
    abortSession: vi.fn((id: string) => calls.push(`abort:${id}`)),
    processSubagent: async function* (sessionId: string, message: string) {
      calls.push(`process:${sessionId}:${message}`);
      if (mode === "hang") {
        // 一直在产出（所以空闲看门狗不会响），但要能被中断 —— 中断只在事件边界被察觉
        for (let i = 0; i < 2000; i++) {
          await new Promise((r) => setTimeout(r, 5));
          yield { type: "text_delta", text: "." } as any;
        }
        return;
      }
      yield { type: "text_delta", text: "**状态**: success\n**摘要**: 完成" } as any;
      yield { type: "end", result: {} } as any;
    },
  } as unknown as LLMEngine;
  return { engine, calls, setMode: (m: "complete" | "hang") => { mode = m; } };
}

function makeProvider() {
  return {
    name: "spawn",
    capabilities: { depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: vi.fn(),
    prepareContinuable: vi.fn(async () => ({})),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function startChild(engine: LLMEngine) {
  const rt = new SubagentRuntime(engine);
  rt.registerProvider(makeProvider());
  const { childId } = await rt.startContinuable({
    provider: "spawn",
    label: "team:成员",
    request: { prompt: "你是成员", parentSessionId: "cap-1", cwd: "C:/proj", agentId: "general" },
    signal: new AbortController().signal,
  });
  return { rt, childId };
}

describe("可持续子智能体：值守与预算", () => {
  it("SUBV-1: 正常一轮结束后任务结算为 completed（正常路径不回退）", async () => {
    const { engine } = makeEngine();
    const { rt, childId } = await startChild(engine);
    await rt.waitForTask(childId);
    const task = rt.getTask(childId)!;
    expect(task.status).toBe("completed");
    expect(task.result?.status).toBe("success");
  });

  it("SUBV-2（修复点）: 被中止的续聊轮不能结算成 completed", async () => {
    const { engine, setMode } = makeEngine();
    setMode("complete");
    const { rt, childId } = await startChild(engine);
    await rt.waitForTask(childId);

    // 第二轮：立刻中断（模拟用户/队长中断）
    setMode("hang");
    const p = rt.followup("cap-1", childId, "再干一件事", { signal: new AbortController().signal });
    await p;
    await new Promise((r) => setTimeout(r, 5));
    rt.interrupt(childId, { kind: "ancestor", callerSessionId: "cap-1" });
    await rt.waitForTask(childId);

    const task = rt.getTask(childId)!;
    expect(task.status, "被中断必须是 cancelled 而不是 completed").toBe("cancelled");
    expect(task.error || task.result?.summary).toMatch(/中断|interrupted/);
  });

  it("SUBV-3（修复点）: 轮次预算用尽后 followup 明确报错，而不是无限唤醒", async () => {
    const { engine } = makeEngine();
    const { rt, childId } = await startChild(engine);
    // 直接把轮次刷到上限（预算常量是模块内的 60）
    const activation = (rt as any).activations.get(childId);
    activation.turns = 60;

    await expect(
      rt.followup("cap-1", childId, "继续", { signal: new AbortController().signal }),
    ).rejects.toThrow(/轮次预算|turns/);
    expect(console.warn).toBeDefined();
  });

  it("SUBV-4（修复点）: 源码契约 —— 续聊轮必须挂空闲看门狗并可真的中断", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/subagent/runtime.ts"), "utf-8");
    const idx = src.indexOf("private async executeContinuableTurn");
    expect(idx).toBeGreaterThan(-1);
    // 直到下一个方法定义为止的整段（固定 4000 字符会被中断分支切掉）
    const rest = src.slice(idx);
    const nextMethod = rest.indexOf("\n  private ", 10);
    const block = nextMethod > 0 ? rest.slice(0, nextMethod) : rest;
    expect(block, "必须有空闲看门狗").toContain("idleWatchdog(");
    expect(block, "挂死时必须真的中断引擎里的那一轮").toContain("abortSession(activation.childId)");
    expect(block, "每个事件都要重新上弦").toContain("watchdog.pulse()");
    expect(block, "中止要如实结算为 cancelled").toContain("status = 'cancelled'");
    expect(block, "挂死原因要写进摘要").toMatch(/没有任何事件/);
  });

  it("SUBV-5: 引擎侧 scoped loop 必须可被 abortSession 找到（否则看门狗无句柄）", () => {
    const engine = new LLMEngine();
    const scopedTools = engine.tools.createScope();
    const loop: any = engine.getAgenticLoop(undefined, "child-1", scopedTools);
    const abortSpy = vi.spyOn(loop, "abort");

    engine.abortSession("child-1");
    expect(abortSpy, "abortSession 必须能中断子智能体的 scoped loop").toHaveBeenCalled();
    engine.cleanupSessionLoop("child-1");
  });
});
