/**
 * D2：`abort()` 之后**不许再派发任何工具调用**（排队中的那些调用尤其不许）。
 *
 * ## 缺陷形态
 *
 * `AgenticLoop.abort()` → `executor.abortAll()` 只做两件事：中止**在飞**调用的
 * controller、`this.running.clear()`。而补位循环的判据是
 * `this.running.size < window` —— 清空之后 `0 < window` 恒成立，于是
 * **排队中的调用会带着全新的、从未被中止的 controller 继续开跑**。
 * `executeSingle` 那条（不可并发工具的）路径连一个中止检查都没有。
 *
 * 真机表现：用户点了 ■，界面显示"已停止"，被排队的那几条写操作**照样执行**（真写盘）。
 *
 * ## 这一组用例的判据
 *
 * 用一次回复里的 **3 个不可并发**（各自独占一组，走 `executeSingle` 路径）的
 * 自定义工具调用：在收到第一个 `tool_start` 后立刻 `abort()`，然后断言
 *
 * 1. 工具处理器**最多被调用一次**（改前是 3 次 —— 三次全部真的跑了）；
 * 2. 每个未派发的调用都收到一条 `TOOL_ABORTED_BEFORE_DISPATCH` 的合成失败结果
 *    （对标 DSH `appendSkippedToolCall`：调用不能凭空消失，界面也不能永远停在"运行中"）。
 *
 * 工具处理器只计数、不碰磁盘（`persistResult: false` + `sideEffectScope: "session"`，
 * 连执行器的落盘与快照都不会触发）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { TOOL_ABORTED_BEFORE_DISPATCH } from "../core/llm/streaming-executor";

const SESSION_ID = "dsh-d2-abort";
const CWD = "C:\\d2-abort";
const TOOL_NAME = "probe_write_style";

/** 一次回复里给 3 个**不可并发**的调用（各自独占一组 → 走 executeSingle 路径） */
function threeSequentialCalls(): any[] {
  const out: any[] = [];
  for (let i = 1; i <= 3; i++) {
    const id = `call_${i}`;
    out.push({ type: "tool_use_start", id, name: TOOL_NAME });
    out.push({ type: "tool_use_delta", id, input: JSON.stringify({ path: `file-${i}.txt`, content: `payload-${i}` }) });
    out.push({ type: "tool_use_end", id, input: { path: `file-${i}.txt`, content: `payload-${i}` } });
  }
  out.push({ type: "end", finishReason: "tool_use" });
  return out;
}

class ScriptedProvider {
  id = "d2-provider";
  name = "D2 Mock";
  private scripts: any[][] = [];
  setScript(scripts: any[][]) {
    this.scripts = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(): AsyncGenerator<any> {
    const script = this.scripts.shift() ?? [{ type: "end", finishReason: "stop" }];
    for (const e of script) yield e;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

describe("D2：abort() 之后不许再派发排队中的工具调用", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("D2-A: 第一个 tool_start 后 abort() → 处理器最多跑一次，其余调用收到「未派发即中止」", async () => {
    const handlerCalls: string[] = [];
    const registry = createDefaultToolRegistry();
    registry.register({
      id: TOOL_NAME,
      description: "测试用「写类」工具：只计数，不碰磁盘",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      // 不可并发 ⇒ 每个调用独占一组（正是缺陷里"组循环没有中止检查"的那条路径）
      contract: {
        readOnly: false,
        concurrencySafe: false,
        sideEffectScope: "session",
        accessScope: "none",
        persistResult: false,
      },
      async execute(args: any, ctx: any) {
        handlerCalls.push(String(args?.path ?? "?"));
        return { title: "probe", output: `wrote ${args?.path}` };
      },
    } as any);

    const provider = new ScriptedProvider();
    provider.setScript([threeSequentialCalls()]);

    const loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 3,
      model: "d2-model",
      securityMode: "full",
    });

    const events: any[] = [];
    let abortedAtFirstStart = false;
    for await (const e of loop.run(SESSION_ID, "写三个文件", CWD, "system prompt")) {
      events.push(e);
      if (e.type === "tool_start" && !abortedAtFirstStart) {
        abortedAtFirstStart = true;
        loop.abort(); // 用户点 ■
      }
    }

    expect(abortedAtFirstStart, "前置：必须真的观察到第一个 tool_start").toBe(true);
    expect(
      handlerCalls.length,
      `中止之后不许再派发（改前 3 个调用会全部执行，真机上就是"停止后照样写盘"）。实际执行了: ${handlerCalls.join(",")}`,
    ).toBeLessThanOrEqual(1);

    const skipped = events.filter(
      (e) => e.type === "tool_error" && (e as any).code === TOOL_ABORTED_BEFORE_DISPATCH,
    );
    expect(
      skipped.length,
      "未派发的调用必须留下有序的合成失败结果（否则界面永远停在「运行中」）",
    ).toBeGreaterThanOrEqual(2);
    expect(
      handlerCalls.length + skipped.length,
      `每个模型发出的调用都必须有交代（要么真的执行、要么收到合成失败结果，不许凭空消失）：执行 ${handlerCalls.length} + 跳过 ${skipped.length}`,
    ).toBe(3);
  });
});
