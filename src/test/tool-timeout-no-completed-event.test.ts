/**
 * ★ 第 185 波 T4 判据：**超时/中止之后，事件日志里不许再出现 `completed` 的 `tool_result`**。
 *
 * ## 钉的是什么缺陷（`.preview-shot/_audit184-tools.md` 的 T4）
 *
 * `streaming-executor` 的超时/中止那两支只做 `controller.abort()` + `reject`
 * （**放弃等待**）—— 没有任何东西取消管线 promise。于是当工具**不观察** `ctx.abort` 时：
 * 调用方已经 `yield tool_error`（模型与界面被告知超时），而管线照旧走完 Layer 4/5，
 * `EventLogFinalizeMiddleware` **无条件**写下一条 `status:"completed"` 的 `tool_result`
 * ⇒ **同一个 `toolCallId` 留下两份相反的事实**，事后复盘回答不了
 * "那次超时到底有没有落地副作用"。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | `T4-A` | 工具挂住并被超时 ⇒ 事件里**恰好一条** `tool_result`，且状态是 `error`（带 `TOOL_RESULT_ABANDONED`）——**绝不许出现 completed** |
 * | `T4-B` | 反向对照：正常完成的调用照旧写 `completed`（不许把成功也标成失败） |
 * | `T4-C` | 判据不许过宽：用户点 ■（`abortAll`）后，**在飞工具在收到取消前就跑完并返回成功**时调用方照样 yield `tool_complete` ⇒ 事件**必须也是 completed**（若用 `abort.aborted` 判就会写成 error，那是新的两份真相） |
 * | `T4-D` | 用户中止且工具**观察到了**取消（抛 AbortError）⇒ 调用方看到失败 ⇒ 事件也必须是 error |
 *
 * `T4-C`/`T4-D` 合起来钉住"判定必须与调用方的裁决一致"，而不是"看到 abort 就算失败"。
 *
 * 这里驱动的是**真的** `StreamingToolExecutorImpl` + 真的 `EventLogFinalizeMiddleware`
 * （只把事件日志换成记录式假实现）—— 判据长在**生产里真的会跑的那条链**上。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const appended: Array<{ sessionId: string; type: string; payload: Record<string, unknown> }> = [];
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => ({
    append: (sessionId: string, type: string, payload: Record<string, unknown>) => {
      appended.push({ sessionId, type, payload });
      return { seq: appended.length, sessionId, type, payload };
    },
  }),
}));

import { initDefaultPipeline, TOOL_RESULT_ABANDONED } from "../core/llm/tool-pipeline";
import {
  StreamingToolExecutorImpl,
  TOOL_TIMEOUT,
  type StreamingToolCall,
  type ToolExecutorContext,
  type ToolExecutorEvent,
} from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctx(): ToolExecutorContext {
  return {
    sessionId: "s-t4",
    messageId: "m-t4",
    cwd: "C:/proj",
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
  };
}

function tool(id: string): StreamingToolCall {
  return { id, name: "read", input: { path: "a.ts" }, status: "pending" } as StreamingToolCall;
}

async function drain(gen: AsyncGenerator<ToolExecutorEvent>): Promise<ToolExecutorEvent[]> {
  const out: ToolExecutorEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function resultsFor(id: string) {
  return appended.filter((a) => a.type === "tool_result" && a.payload.toolCallId === id);
}

/**
 * 等管线把剩下几层跑完（这是缺陷的另一半：它**会**继续跑完并落事件）。
 *
 * ⚠️ 必须**轮询等待**而不是 `sleep(固定值)`：这条判据在"事件还没落"与"事件落了但状态错"
 * 之间要能分辨，而满载并行下固定睡眠会先看到前者、报出一句与缺陷无关的假红
 * （本判据第一版就这么假红过一次）。
 */
async function waitForResults(id: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = resultsFor(id);
  while (rows.length === 0 && Date.now() < deadline) {
    await sleep(20);
    rows = resultsFor(id);
  }
  return rows;
}

beforeEach(async () => {
  appended.length = 0;
  await initDefaultPipeline({
    isPlanMode: () => false,
    isSandboxEnabled: () => false,
    isPathWithinWorkspace: () => true,
    checkPermission: async () => ({ allowed: true }),
  });
});

describe("第 185 波 T4：被判失败的调用不许再落一条 completed 的事实", () => {
  it("T4-A: 工具挂住被超时（且它不观察 abort）⇒ 事件里不许出现 completed", async () => {
    const executor = new StreamingToolExecutorImpl({
      toolTimeout: 40,
      maxConcurrent: 1,
      concurrencySafeTools: ["read"],
    });

    /** 经典夹具：**完全不看 `ctx.abort`** 的工具，睡够之后照旧返回"成功"。 */
    const stubborn = async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
      await sleep(200);
      return { id: "", name, input: args, output: "side effects landed", status: "completed" };
    };

    const events = await drain(executor.execute([tool("tc-timeout")], ctx(), stubborn) as never);

    const err = events.find((e) => e.type === "tool_error");
    expect(err, "挂住的工具必须被超时终止").toBeTruthy();
    expect((err as { code?: string }).code).toBe(TOOL_TIMEOUT);

    /** 等管线把剩下几层跑完（缺陷的另一半：它**会**继续跑完并落事件）。 */
    const rows = await waitForResults("tc-timeout");
    expect(rows.length, "无论成败都必须有一条 tool_result（可见即已记录）").toBe(1);
    expect(
      String(rows[0].payload.status),
      "★ 调用方已判超时 —— 这里绝不许写 completed（那正是「同一 toolCallId 两份相反事实」）",
    ).toBe("error");
    expect(String(rows[0].payload.error)).toContain(TOOL_RESULT_ABANDONED);
  });

  it("T4-B: 反向对照 —— 正常完成的调用照旧落 completed（不许把成功也标成失败）", async () => {
    const executor = new StreamingToolExecutorImpl({
      toolTimeout: 5000,
      maxConcurrent: 1,
      concurrencySafeTools: ["read"],
    });
    const ok = async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => ({
      id: "",
      name,
      input: args,
      output: "file content",
      status: "completed",
    });

    const events = await drain(executor.execute([tool("tc-ok")], ctx(), ok) as never);
    expect(events.some((e) => e.type === "tool_complete")).toBe(true);
    await sleep(20);

    const rows = resultsFor("tc-ok");
    expect(rows.length).toBe(1);
    expect(String(rows[0].payload.status)).toBe("completed");
    expect(rows[0].payload.error, "成功不该带失败原因").toBeUndefined();
  });

  it("T4-C: 判据不许过宽 —— abortAll 后「跑完了」的调用，调用方报成功，事件也必须是 completed", async () => {
    const executor = new StreamingToolExecutorImpl({
      toolTimeout: 5000,
      maxConcurrent: 1,
      concurrencySafeTools: ["read"],
    });
    /** 不观察取消的工具：它会在收到取消之后照旧返回成功。 */
    const stubborn = async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
      await sleep(150);
      return { id: "", name, input: args, output: "landed anyway", status: "completed" };
    };

    const events: ToolExecutorEvent[] = [];
    const run = (async () => {
      for await (const ev of executor.execute([tool("tc-abort-ok")], ctx(), stubborn) as never) {
        events.push(ev);
      }
    })();

    await sleep(30);
    executor.abortAll();
    await run;

    const callerSaw = events.find((e) => e.type === "tool_complete" || e.type === "tool_error") as
      | { type: string }
      | undefined;
    const rows = await waitForResults("tc-abort-ok");
    expect(rows.length).toBe(1);
    /**
     * 调用方拿到的是 `tool_complete`（工具真的跑完了、副作用真的落了）——
     * 事件若按 `ctx.abort.aborted` 写成 error，就制造了**新的**两份真相。
     */
    expect(callerSaw?.type, "夹具前提：这个工具跑完了，调用方看到的是成功").toBe("tool_complete");
    expect(
      String(rows[0].payload.status),
      "★ 与调用方的裁决保持一致：它报成功，事件就必须是 completed",
    ).toBe("completed");
  });

  it("T4-D: abortAll 且工具观察到了取消（抛 AbortError）⇒ 调用方看到失败，事件也必须是 error", async () => {
    const executor = new StreamingToolExecutorImpl({
      toolTimeout: 5000,
      maxConcurrent: 1,
      concurrencySafeTools: ["read"],
    });
    /** 会观察取消的工具：被中止时如实抛错。 */
    const observable = async (
      name: string,
      args: Record<string, unknown>,
      c: ToolExecutorContext,
    ): Promise<ToolCallResult> => {
      await new Promise<void>((resolve) => {
        if (c.abort.aborted) return resolve();
        c.abort.addEventListener("abort", () => resolve());
      });
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    };

    const events: ToolExecutorEvent[] = [];
    const run = (async () => {
      for await (const ev of executor.execute([tool("tc-abort-err")], ctx(), observable) as never) {
        events.push(ev);
      }
    })();

    await sleep(30);
    executor.abortAll();
    await run;

    expect(events.some((e) => e.type === "tool_error"), "中止必须让调用方看到失败").toBe(true);
    /**
     * ⚠️ 这里按"本会话全部 tool_result"取，而不是按 `toolCallId` 过滤：
     * 走到"未派发即中止"那条早退时，管线给的 `result.id` 是 `ctx.messageId`
     * （`tool-pipeline.ts` 那三处早退的历史形态，本轮不动），于是事件的 `toolCallId`
     * 不是调用 id。那是**另一个**缺陷，不该让这条判据替它背锅（beforeEach 已清空记录，
     * 所以这里只会有本次调用的一行）。
     */
    const rows = appended.filter((a) => a.type === "tool_result");
    expect(rows.length).toBe(1);    expect(String(rows[0].payload.status), "★ 调用方报失败，事件也必须是 error").toBe("error");
  });
});
