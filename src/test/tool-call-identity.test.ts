/**
 * 工具调用的**身份**不能丢（第 71 轮真机实测发现）
 *
 * 现场：装机版跑了一个真实回合，产出溢出文件，文件名是
 * `…\spill\<会话>\bash--1790131192728.txt` —— **中间那截调用 id 是空的**。
 *
 * 根因不在溢出本身：工具处理器（`agentic-loop.ts` 里 `async (name, args, ctx) => …`）
 * 返回的 `ToolCallResult.id` 一直是**空串**（`id: ""` 是字面量，全仓 6 处），
 * 而 `ToolCallResult` 是处理器签名里唯一能被管线读到的东西 —— 调用 id 根本进不去。
 * 受影响的不止文件名：`EventLogFinalizeMiddleware` 写事件日志时也读 `result.id`，
 * 于是 `tool_call` / `tool_result` 两类事件的 `toolCallId` **全是空串**
 * （事件日志是"执行轨迹 / 事后复盘"的数据源，空 id 让记录回指不到具体调用）。
 *
 * 修法：`streaming-executor` 在每次调用管线时把 `tc.id` 注入
 * `ctx.toolCallId`（处理器签名不动），读取方一律 `result.id || ctx.toolCallId`。
 *
 * 这个文件守住三件事：
 *   ① 管线确实按次拿到了调用 id（走真实 `StreamingToolExecutorImpl.execute`）；
 *   ② 事件日志写下的 `toolCallId` 不再是空串；
 *   ③ 处理器将来补上 `result.id` 时，**它优先**（不能被 ctx 覆盖）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// 事件日志的写入口：只关心"写下去的是什么"
const appended = vi.hoisted(() => [] as Array<{ sessionId: string; type: string; payload: Record<string, unknown> }>);
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => ({
    append: (sessionId: string, type: string, payload: Record<string, unknown>) => {
      appended.push({ sessionId, type, payload });
      return { seq: appended.length };
    },
  }),
}));

// 文件 API：溢出落盘要断言"写的是哪个路径"
vi.mock("../core/file-api", () => ({
  getAppDataDir: vi.fn(async () => "C:\\appdata\\"),
  getDefaultCwd: vi.fn(async () => "C:\\work"),
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  renameFile: vi.fn(async () => undefined),
  listDirectory: vi.fn(async () => []),
  deleteFile: vi.fn(async () => undefined),
}));

import { StreamingToolExecutorImpl, type ToolExecutorContext } from "../core/llm/streaming-executor";
import { EventLogFinalizeMiddleware } from "../core/llm/tool-pipeline";
import { SpillPolicyMiddleware } from "../core/llm/spill-policy";
import { retainToolResult } from "../core/storage/spill";
import { writeFile, renameFile } from "../core/file-api";
import type { ToolCallResult } from "../core/llm/types";

const writeFileMock = vi.mocked(writeFile);

function ctx(): ToolExecutorContext {
  return {
    sessionId: "s-identity",
    messageId: "m-1",
    cwd: "C:\\mimo-gui",
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
  };
}

function toolCall(id: string, name = "bash") {
  return { id, name, input: { command: "echo hi" }, status: "pending" as const };
}

/** 照抄真机形状：处理器返回的结果里 `id` 是空串 */
const handlerLikeRealOne = async (name: string, args: Record<string, unknown>) =>
  ({ id: "", name, input: args, output: "A".repeat(100), status: "completed" as const });

async function drain(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

beforeEach(() => {
  appended.length = 0;
});

describe("工具调用身份：调用 id 必须一路传到 ctx 与事件日志", () => {
  it("TID-1: 管线拿到的 ctx 里有本次调用的 id（走真实执行器）", async () => {
    let seen: ToolExecutorContext | null = null;
    const executor = new StreamingToolExecutorImpl();
    const realHandler = async (name: string, args: Record<string, unknown>, c: ToolExecutorContext) => {
      seen = c;
      return { id: "", name, input: args, output: "ok", status: "completed" as const };
    };

    await drain(executor.execute([toolCall("call_00_ABC")], ctx(), realHandler) as any);

    expect(seen, "处理器必须被调用").not.toBeNull();
    expect(seen!.toolCallId, "ctx 里必须带上本次调用的 id").toBe("call_00_ABC");
  });

  it("TID-2: 事件日志里的 toolCallId 不再是空串（处理器返回空 id 时用 ctx 兜底）", async () => {
    const mw = new EventLogFinalizeMiddleware();
    const c = { ...ctx(), toolCallId: "call_00_XYZ" };
    const result: ToolCallResult = { id: "", name: "bash", input: {}, output: "big", status: "completed" };

    await mw.execute("bash", {}, result, c as any, []);

    const call = appended.find((a) => a.type === "tool_call");
    const res = appended.find((a) => a.type === "tool_result");
    expect(call, "必须写了 tool_call 事件").toBeTruthy();
    expect(res, "必须写了 tool_result 事件").toBeTruthy();
    expect(call!.payload.toolCallId, "真机实测到的缺陷：这里是空串").toBe("call_00_XYZ");
    expect(res!.payload.toolCallId).toBe("call_00_XYZ");
  });

  it("TID-3: 处理器将来补上 result.id 时**它优先**，ctx 不许覆盖它", async () => {
    const mw = new EventLogFinalizeMiddleware();
    const c = { ...ctx(), toolCallId: "from-ctx" };
    const result: ToolCallResult = { id: "from-result", name: "bash", input: {}, output: "x", status: "completed" };

    await mw.execute("bash", {}, result, c as any, []);

    expect(appended.find((a) => a.type === "tool_call")!.payload.toolCallId).toBe("from-result");
  });

  it("TID-4: 两处都没有 id 时写空串（不编造），且不抛", async () => {
    const mw = new EventLogFinalizeMiddleware();
    const result: ToolCallResult = { id: "", name: "bash", input: {}, output: "x", status: "completed" };

    await expect(mw.execute("bash", {}, result, ctx() as any, [])).resolves.toBeTruthy();
    expect(appended.find((a) => a.type === "tool_call")!.payload.toolCallId).toBe("");
  });

  it("TID-5: 溢出文件名用的是真实调用 id（不是 `bash--<毫秒>.txt`）", async () => {
    const mw = new SpillPolicyMiddleware({ maxInlineBytes: 4096 });
    const res = await mw.execute(
      "bash",
      {},
      { id: "", name: "bash", input: {}, output: "A".repeat(50000), status: "completed" } as any,
      { sessionId: "s1", toolCallId: "call_00_RealId" } as any,
    );

    expect(res.action).toBe("replace");
    const replaced = (res as any).replacedOutput as string;
    expect(replaced).toMatch(/bash-call_00_RealId-\d{10,}\.txt/);
    expect(replaced, "不许再出现悬空连字符").not.toMatch(/bash--\d{10,}\.txt/);
    expect(writeFileMock.mock.calls[0][0]).toMatch(/bash-call_00_RealId-\d{10,}\.txt\.tmp$/);
  });

  /**
   * ⚠️ 这条是"防御线"，不是补丁：`callId` 传空串时（上游将来又漏了）文件名也必须
   * 仍然能被保留期清理认出来（`pruneSpillFiles` 靠 `-<毫秒>.txt` 判保留期）。
   */
  it("TID-6: 调用 id 缺失时文件名仍然合法（无悬空连字符，且被清理器认得出）", async () => {
    const r = await retainToolResult("A".repeat(50000), {
      sessionId: "s1", toolName: "bash", callId: "", maxInlineBytes: 4096,
    });

    const name = r.locator!.split("\\").pop()!;
    expect(name).toMatch(/^bash-\d{10,}\.txt$/);
    expect(name, "不许出现悬空连字符").not.toContain("--");
    expect(/-(\d{10,})\.txt$/.test(name), "清理器的判据必须仍然成立").toBe(true);
  });
});
