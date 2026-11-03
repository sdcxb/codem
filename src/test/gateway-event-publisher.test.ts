/**
 * 网关事件投影判据（GW-E1..GW-E4，ADR-0005 M2）。
 *
 * 这一层是"桌面循环 → 手机事件流"的唯一投影：
 * 1. 事件名/载荷与 Host 同名同形（共享 UI 的 reducer 只有一份）；
 * 2. 发布**串行**（IPC 不串行会让 tool.end 抢在 tool.start 前面）；
 * 3. 工具结果有上限（手机不该为一次工具拉几百 KB）；
 * 4. 审批 requested/resolved 由**同一张待批表**的变化推出（谁答的都会同步）。
 *
 * 真实 SSE（seq/Last-Event-ID/缺口/终态保留）由 Rust `cargo test --lib
 * phone::gateway` 钉住；这里只钉投影与队列。
 */
import { describe, it, expect } from "vitest";

import {
  ApprovalEventTracker,
  GatewayEventPublisher,
  TOOL_PREVIEW_MAX_CHARS,
  gatewayTerminalEvent,
  mapLoopEventToGatewayEvent,
  type GatewayOutboundEvent,
} from "../core/remote/gateway-events";
import type { GatewayApprovalView } from "../core/remote/gateway-engine";

const CTX = { sessionId: "s1", runId: "run-1" };

describe("GW-E1 循环事件映射", () => {
  it("正文/推理/工具开始结束错误与 Host 同名同形", () => {
    expect(mapLoopEventToGatewayEvent({ type: "text_delta", text: "你好" }, CTX)).toEqual({
      sessionId: "s1",
      type: "assistant.text",
      payload: { text: "你好" },
      runId: "run-1",
    });
    expect(mapLoopEventToGatewayEvent({ type: "reasoning_delta", text: "想一下" }, CTX)).toMatchObject({
      type: "assistant.reasoning",
      payload: { text: "想一下" },
    });
    expect(
      mapLoopEventToGatewayEvent(
        { type: "tool_start", toolCall: { id: "c1", name: "read", input: { path: "a.ts" } } },
        CTX,
      ),
    ).toMatchObject({
      type: "tool.start",
      payload: { id: "c1", name: "read", args: { path: "a.ts" } },
      runId: "run-1",
    });
    expect(
      mapLoopEventToGatewayEvent(
        {
          type: "tool_complete",
          toolCall: { id: "c1", name: "read" },
          result: { output: "文件内容", isError: false },
        },
        CTX,
      ),
    ).toMatchObject({
      type: "tool.end",
      payload: { id: "c1", name: "read", preview: "文件内容", isError: false },
    });
    expect(
      mapLoopEventToGatewayEvent(
        { type: "tool_error", toolCall: { id: "c1", name: "read" }, error: "ENOENT" },
        CTX,
      ),
    ).toMatchObject({ type: "tool.error", payload: { id: "c1", name: "read", error: "ENOENT" } });
  });

  it("工具入参只给摘要：写文件的整篇 content 不进事件流", () => {
    const mapped = mapLoopEventToGatewayEvent(
      {
        type: "tool_start",
        toolCall: { id: "c1", name: "write", input: { path: "a.ts", content: "x".repeat(20_000) } },
      },
      CTX,
    )!;
    const args = (mapped.payload as { args: { path: string; content: string } }).args;
    expect(args.path).toBe("a.ts");
    // 单个字符串上限与工具结果摘要同一量级（2000）；关键是不能是原始的 20_000。
    expect(args.content.length).toBe(2000);
    expect(JSON.stringify(mapped).length).toBeLessThan(10_000);

    // 字段太多/太长 ⇒ 只留可展示的短字段并标记 truncated（不把整包发给手机）
    const bloated: Record<string, string> = {};
    for (let i = 0; i < 40; i++) bloated[`k${i}`] = "y".repeat(2000);
    const brief = mapLoopEventToGatewayEvent(
      { type: "tool_start", toolCall: { id: "c2", name: "write", input: { path: "b.ts", ...bloated } } },
      CTX,
    )!;
    const briefArgs = (brief.payload as { args: Record<string, unknown> }).args;
    expect(briefArgs.truncated).toBe(true);
    expect(briefArgs.path).toBe("b.ts");

    // 循环引用不抛（观测设施不许把回合搞挂）
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      mapLoopEventToGatewayEvent(
        { type: "tool_start", toolCall: { id: "c3", name: "x", input: circular } },
        CTX,
      ),
    ).not.toThrow();
  });

  it("迭代边界/空 delta 不产生事件；工具结果有上限", () => {
    expect(mapLoopEventToGatewayEvent({ type: "start" }, CTX)).toBeNull();
    expect(mapLoopEventToGatewayEvent({ type: "end" }, CTX)).toBeNull();
    expect(mapLoopEventToGatewayEvent({ type: "text_delta", text: "" }, CTX)).toBeNull();

    const long = "x".repeat(TOOL_PREVIEW_MAX_CHARS * 2);
    const clipped = mapLoopEventToGatewayEvent(
      { type: "tool_complete", toolCall: { id: "c1", name: "bash" }, result: { output: long } },
      CTX,
    );
    expect((clipped!.payload as { preview: string }).preview.length).toBe(TOOL_PREVIEW_MAX_CHARS);

    // 没有 toolCall 的畸形事件不猜，直接不发。
    expect(mapLoopEventToGatewayEvent({ type: "tool_start" }, CTX)).toBeNull();
  });
});

describe("GW-E2 发布队列串行", () => {
  it("前一条没发完，后一条不会抢跑；flush 后按产生顺序发完", async () => {
    const sent: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const publisher = new GatewayEventPublisher(
      (event) =>
        new Promise<void>((resolve, reject) => {
          sent.push(event.type);
          if (event.type === "first") {
            releaseFirst = resolve;
          } else if (event.type === "boom") {
            reject(new Error("ipc down"));
          } else {
            resolve();
          }
        }),
    );
    publisher.publish({ sessionId: "s1", type: "first", payload: {} });
    publisher.publish({ sessionId: "s1", type: "second", payload: {} });
    publisher.publish({ sessionId: "s1", type: "third", payload: {} });

    // 第一条还没完成：后两条必须还在队列里（否则 tool.end 会抢在 tool.start 前到达）。
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["first"]);
    releaseFirst!();
    await publisher.flush();
    expect(sent).toEqual(["first", "second", "third"]);
    expect(publisher.failureCount()).toBe(0);
  });

  it("单条发送失败不阻断后续事件，但必须可见（不静默）", async () => {
    const warnings: string[] = [];
    const sent: string[] = [];
    const publisher = new GatewayEventPublisher(
      async (event) => {
        sent.push(event.type);
        if (event.type === "boom") throw new Error("ipc down");
      },
      (message) => warnings.push(message),
    );
    publisher.publish({ sessionId: "s1", type: "ok-1", payload: {} });
    publisher.publish({ sessionId: "s1", type: "boom", payload: {} });
    publisher.publish({ sessionId: "s1", type: "ok-2", payload: {} });
    await publisher.flush();
    expect(sent).toEqual(["ok-1", "boom", "ok-2"]);
    expect(publisher.failureCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("boom");
  });
});

describe("GW-E3 审批事件", () => {
  const view = (over: Partial<GatewayApprovalView> = {}): GatewayApprovalView => ({
    requestId: "perm-1",
    sessionId: "s1",
    tool: "bash",
    preview: "command: ls",
    input: { command: "ls" },
    status: "open",
    revision: 1,
    ...over,
  });

  it("新待批 → requested；状态未变不重复；被处理 → resolved（含谁处理的）", () => {
    const tracker = new ApprovalEventTracker();
    const first = tracker.diff([view()]);
    expect(first.map((e) => e.type)).toEqual(["approval.requested"]);
    expect(first[0].sessionId).toBe("s1");
    expect((first[0].payload as any).approval).toMatchObject({
      approvalId: "perm-1",
      tool: "bash",
      summary: "command: ls",
      details: { command: "ls" },
    });

    // 只是 revision 变了（仍待批）：不重复推送（否则手机卡片会闪）。
    expect(tracker.diff([view({ revision: 2 })])).toEqual([]);

    const resolved = tracker.diff([
      view({ status: "resolved", revision: 3, decidedAction: "allow", decidedBy: "desktop" }),
    ]);
    expect(resolved).toEqual([
      {
        sessionId: "s1",
        type: "approval.resolved",
        payload: { approvalId: "perm-1", decision: "allow", decidedBy: "desktop" },
      },
    ]);
    // 已决定后再看一次：不重复。
    expect(
      tracker.diff([
        view({ status: "resolved", revision: 3, decidedAction: "allow", decidedBy: "desktop" }),
      ]),
    ).toEqual([]);
  });

  it("回合收口（expired + deny）也会收掉手机上的卡片", () => {
    const tracker = new ApprovalEventTracker();
    tracker.diff([view()]);
    const closed = tracker.diff([
      view({ status: "expired", revision: 2, decidedAction: "deny", decidedBy: "phone" }),
    ]);
    expect(closed).toHaveLength(1);
    expect((closed[0].payload as { decision: string }).decision).toBe("deny");
  });

  it("没有 sessionId 的条目被丢掉（否则发布器/网关只会报一条无效事件）", () => {
    const tracker = new ApprovalEventTracker();
    expect(tracker.diff([view({ sessionId: "" })])).toEqual([]);
  });
});

describe("GW-E4 终态与发布形状", () => {
  it("终态词映射：finished→succeeded / failed / cancelled（取消不能落成 failed）", () => {
    expect(gatewayTerminalEvent("s1", "run-1", "finished")).toEqual({
      sessionId: "s1",
      type: "run.finished",
      payload: { state: "succeeded" },
      runId: "run-1",
    });
    expect(gatewayTerminalEvent("s1", "run-1", "failed", "provider 500")).toEqual({
      sessionId: "s1",
      type: "run.failed",
      payload: { state: "failed", error: "provider 500" },
      runId: "run-1",
    });
    expect(gatewayTerminalEvent("s1", "run-1", "cancelled")).toEqual({
      sessionId: "s1",
      type: "run.cancelled",
      payload: { state: "cancelled" },
      runId: "run-1",
    });
  });

  it("事件载荷可 JSON 序列化（IPC 只接受可序列化值）", () => {
    const mapped: GatewayOutboundEvent = mapLoopEventToGatewayEvent(
      { type: "tool_start", toolCall: { id: "c1", name: "read", input: { path: "a.ts" } } },
      CTX,
    )!;
    expect(() => JSON.stringify(mapped)).not.toThrow();
    expect(JSON.parse(JSON.stringify(mapped))).toMatchObject({
      sessionId: "s1",
      type: "tool.start",
      runId: "run-1",
    });
  });
});
