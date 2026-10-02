/**
 * 超时路径上的「中止失败」必须**并进要上抛的错误**（审计门禁 #1 / P2）。
 *
 * ## 缺陷形态
 *
 * `timeoutTimer` 在超时时**先** `controller.abort()` 再 `reject("... timed out ...")`。
 * 但当 `abort()` **自己抛了**的时候，原来的 catch 只做一件事：
 * `console.warn('[streaming-executor.ts] abort on timeout failed:', e)` ——
 * 然后照旧 reject 那句"超时"。
 *
 * 这是**实质性**的信息丢失：abort 抛错意味着"工具已经被叫停"这个前提不成立，
 * 工具**可能还在跑**，副作用（写文件、跑命令）还会继续落盘。模型与用户只看到
 * 一句普通的超时，完全不知道还有一份可能仍在运行的副作用。
 *
 * `tools/audit/scan-false-success.mjs` 的 P2 判据（动作类函数里 catch 只有日志）
 * 正是把这一处标成未豁免命中的。
 *
 * ## 判据（断言**上抛的错误对象**，不看源码文本）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | ABORTFAIL-A | `abort()` 抛错 + 工具挂住（并发批路径） | tool_error 的 error 文本同时含"超时"与中止失败原因，code 仍是 TOOL_TIMEOUT |
 * | ABORTFAIL-B | 同上，串行（executeSingle）路径 | 一致（两条路径共用同一个 timeoutTimer） |
 * | ABORTFAIL-C | 反向对照：`abort()` 正常 | error 文本**不得**含中止失败那句（不是无条件拼接） |
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  StreamingToolExecutorImpl,
  TOOL_TIMEOUT,
  type StreamingToolCall,
  type ToolExecutorContext,
  type ToolExecutorEvent,
} from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

/** 中止失败的原始原因 —— 断言它必须出现在上抛的错误里 */
const ABORT_FAILURE_REASON = "controller is in a broken state";

function ctx(): ToolExecutorContext {
  return {
    sessionId: "test-session",
    messageId: "test-msg",
    cwd: "C:/tmp/test",
    messages: [],
    metadata: () => {},
    abort: new AbortController().signal,
  };
}

/** 永不 resolve：确保超时必然先到 */
const hang = () => new Promise<ToolCallResult>(() => {});

function tool(id: string, name: string): StreamingToolCall {
  return { id, name, input: { id }, status: "pending" };
}

async function drain(gen: AsyncGenerator<ToolExecutorEvent>): Promise<ToolExecutorEvent[]> {
  const out: ToolExecutorEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** 让 `AbortController.prototype.abort` 抛错（模拟"中止信号送不出去"） */
function breakAbort() {
  vi.spyOn(AbortController.prototype, "abort").mockImplementation(() => {
    throw new Error(ABORT_FAILURE_REASON);
  });
}

type TimeoutErrorEvent = { type: "tool_error"; error: string; code?: string };

/** 超时 + abort() 抛错 → 断言上抛的错误带上了中止失败的原因 */
async function expectAbortFailureSurfaced(toolName: string): Promise<void> {
  breakAbort();
  const executor = new StreamingToolExecutorImpl({
    toolTimeout: 40,
    maxConcurrent: 5,
    concurrencySafeTools: ["read"],
  });

  const events = await drain(executor.execute([tool("t1", toolName)], ctx(), hang));
  const err = events.find((e) => e.type === "tool_error") as TimeoutErrorEvent | undefined;

  expect(err, "挂住的工具必须被超时终止").toBeTruthy();
  expect(String(err?.error), "超时下限（既有契约）不许丢").toMatch(/timed out after 40ms/);
  expect(err?.code, "机器可读码仍是 TOOL_TIMEOUT").toBe(TOOL_TIMEOUT);
  expect(
    String(err?.error),
    "abort() 抛错意味着工具可能还在跑 —— 这件事必须随错误上抛，不能只进 console.warn",
  ).toContain(ABORT_FAILURE_REASON);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("超时中止失败：必须并进上抛的错误，而不是只打一行日志", () => {
  it("ABORTFAIL-A: 并发批路径（runOneTool）", async () => {
    await expectAbortFailureSurfaced("read");
  });

  it("ABORTFAIL-B: 串行路径（executeSingle）—— 两条路径共用同一个 timeoutTimer", async () => {
    await expectAbortFailureSurfaced("write");
  });

  it("ABORTFAIL-C 反向对照：abort() 正常时不得无条件拼接中止失败那句", async () => {
    const executor = new StreamingToolExecutorImpl({
      toolTimeout: 40,
      maxConcurrent: 5,
      concurrencySafeTools: ["read"],
    });

    const events = await drain(executor.execute([tool("t1", "read")], ctx(), hang));
    const err = events.find((e) => e.type === "tool_error") as { error: string } | undefined;

    expect(String(err?.error)).toMatch(/timed out after 40ms/);
    expect(
      String(err?.error),
      "中止是成功的：多出来的那句会让所有超时错误都变成半真半假",
    ).not.toContain("abort signal could not be delivered");
  });
});
