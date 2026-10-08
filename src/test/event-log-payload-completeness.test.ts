/**
 * ★ 第 185 波（复审 I-3）：**事件日志里的 `duration` / `diagnostics` 不许「时有时无」**。
 *
 * ## 钉的是什么
 *
 * `event-types.ts` 把 `ToolCallPayload.duration` 声明成权威日志的一部分（并写明
 * 「不写这里，重载/重建后看不到耗时」），`ToolResultPayload` 这一波又补上 `diagnostics`
 * —— 而**唯一运行时写入者**（`tool-pipeline.ts` 的 event-log finalize）**一个都没写**：
 * 迁移路径（`event-log.ts` 的 `migrateMessagesToEvents`）写了 `duration`，
 * 运行时那条不写 ⇒ 同一份日志两种形状，重建会话看不到工具耗时与结构化诊断。
 *
 * ## 判据（驱动**真的**事件日志 + 真的最终中间件 + 真的迁移函数 + 真的投影）
 *
 * | id | 钉什么 |
 * |---|---|
 * | ELP-1 | 运行时写入：`tool_call` 带 `duration`、`tool_result` 带 `diagnostics` |
 * | ELP-2 | 迁移路径：索引里的 `metadata.duration` / `metadata.diagnostics` 同样落到事件上（**两边同形**） |
 * | ELP-3 | 重建路径：投影把 `duration` 还原到 `tool_use` 块、把 `diagnostics` 还原到工具消息的 `metadata` |
 * | ELP-4 | 反向对照：没有诊断时**不许**凭空补空数组（「未上报」≠「上报空数组」，契约按键存在性判） |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** 迁移路径的输入（消息索引）：由 `listMessages` 替身给出 */
const store = vi.hoisted(() => ({ messages: [] as any[] }));

vi.mock("../core/storage/message", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, listMessages: () => store.messages };
});

import { initDefaultPipeline, getToolPipeline } from "../core/llm/tool-pipeline";
import { getEventLog, migrateMessagesToEvents } from "../core/storage/event-log";
import { EventProjection } from "../core/storage/event-projection";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import type { ToolContext } from "../core/llm/tools";

const DIAG = [{ severity: "warn" as const, code: "TRUNCATED", message: "结果被截断，已分页" }];

function ctx(sessionId: string, toolCallId: string): ToolContext {
  return {
    sessionId,
    messageId: `m-${sessionId}`,
    cwd: "C:/ws",
    messages: [],
    abort: new AbortController().signal,
    metadata: () => {},
    securityMode: "auto",
    toolCallId,
  } as never;
}

function payloads(type: string, sessionId: string) {
  return getEventLog()
    .readAll(sessionId)
    .filter((e) => e.type === type)
    .map((e) => e.payload);
}

beforeEach(async () => {
  store.messages = [];
  setStoragePort(createFakeStoragePort());
  await initDefaultPipeline({
    isPlanMode: () => false,
    isSandboxEnabled: () => false,
    isPathWithinWorkspace: () => true,
    checkPermission: async () => ({ allowed: true }),
  });
});

afterEach(() => {
  setStoragePort(null);
});

describe("I-3：事件日志的 duration / diagnostics 必须两侧同形", () => {
  it("ELP-1: 运行时写入者必须写上 duration 与 diagnostics", async () => {
    const sid = "s-elp-1";
    const r = await getToolPipeline().execute(
      "probe_tool",
      { path: "a.ts" },
      ctx(sid, "call-elp-1") as never,
      async () => ({
        id: "call-elp-1",
        name: "probe_tool",
        input: { path: "a.ts" },
        output: "结果",
        status: "completed" as const,
        diagnostics: DIAG,
      }),
    );

    expect(r.result.status, "前置：这次调用必须真的跑完（否则测不到写入者）").toBe("completed");

    const call = payloads("tool_call", sid);
    expect(call, "必须写下 tool_call").toHaveLength(1);
    expect(
      typeof call[0].duration,
      `tool_call.duration 必须落进权威日志（改前唯一运行时写入者不写它 ⇒ 重建后看不到耗时）；实际 payload=${JSON.stringify(call[0])}`,
    ).toBe("number");
    expect(call[0].duration as number).toBeGreaterThanOrEqual(0);

    const result = payloads("tool_result", sid);
    expect(result, "必须写下 tool_result").toHaveLength(1);
    expect(result[0].diagnostics, "结构化诊断必须落进权威日志").toEqual(DIAG);
  });

  it("ELP-2: 迁移路径与运行时**同形**（索引里的 metadata 落到事件上）", async () => {
    store.messages = [
      {
        id: "m-mig",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-mig-1",
            tool: "read",
            args: { path: "a.ts" },
            result: "内容",
            metadata: { duration: 1234, diagnostics: DIAG },
          },
        ],
      },
    ];

    await migrateMessagesToEvents("s-mig");

    const call = payloads("tool_call", "s-mig");
    expect(call).toHaveLength(1);
    expect(call[0].duration, "迁移路径本来就有 duration（判据的另一半是运行时那条）").toBe(1234);

    const result = payloads("tool_result", "s-mig");
    expect(result).toHaveLength(1);
    expect(
      result[0].diagnostics,
      "迁移路径也要带上 diagnostics —— 否则运行时写进去的诊断在「日志重建」里拿不到",
    ).toEqual(DIAG);
  });

  it("ELP-3: 投影（重建路径）必须把两者还原出来", async () => {
    const sid = "s-proj";
    const log = getEventLog();
    log.append(sid, "tool_call", {
      toolCallId: "c1",
      messageId: "m1",
      tool: "read",
      args: { path: "a.ts" },
      status: "completed",
      duration: 42,
    });
    log.append(sid, "tool_result", {
      toolCallId: "c1",
      messageId: "m1",
      result: "内容",
      status: "completed",
      diagnostics: DIAG,
    });

    const messages = new EventProjection().projectAll(sid);

    const assistant = messages.find((m) => m.id === "m1")!;
    const block = (assistant.content as any[]).find((b) => b.type === "tool_use");
    expect(block?.duration, "tool_use 块必须带上耗时（改前投影只搬 {type,id,name,input}）").toBe(42);

    const toolMsg = messages.find((m) => m.role === "tool")!;
    expect(
      (toolMsg.metadata as any)?.diagnostics,
      "工具消息必须带上结构化诊断（放进 metadata，不许混进给模型看的 content）",
    ).toEqual(DIAG);
    expect(String(toolMsg.content), "诊断不许被塞进正文").not.toContain("TRUNCATED");
  });

  it("ELP-4: 反向对照 —— 没有诊断时不许凭空写空数组", async () => {
    const sid = "s-elp-4";
    await getToolPipeline().execute(
      "probe_tool",
      { path: "a.ts" },
      ctx(sid, "call-elp-4") as never,
      async () => ({
        id: "call-elp-4",
        name: "probe_tool",
        input: { path: "a.ts" },
        output: "结果",
        status: "completed" as const,
      }),
    );

    const call = payloads("tool_call", sid)[0];
    /**
     * `duration` 是**管线自己量的**（永远有值），所以这条只约束"值有效"；
     * 真正要防的是 `diagnostics` 被补成 `[]`（"未上报"与"上报空数组"是两件事）。
     */
    expect(Number.isFinite(call.duration as number)).toBe(true);
    expect("diagnostics" in payloads("tool_result", sid)[0], "没有诊断时不许写这个键").toBe(false);
  });
});
