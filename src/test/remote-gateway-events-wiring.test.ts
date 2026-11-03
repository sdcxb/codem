/**
 * 网关事件接线判据（GW-E5..GW-E9，ADR-0005 M2）。
 *
 * 行为判据在 `gateway-event-publisher.test.ts`（投影/队列/审批）与 Rust
 * `cargo test --lib phone::gateway`（SSE/seq/续传/终态）；这个文件守的是
 * **它真的接在唯一循环上，而且没有第二个真相**：
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | GW-E5 | 渲染层能产出的事件名 ⊂ Rust 白名单；`gateway.reset/ready` 只能由 Rust 发 |
 * | GW-E6 | `/events` 在 Rust 侧流式处理（鉴权先于响应头；不套 25s 整连接时限） |
 * | GW-E7 | 观察者调用点在循环里、在写库分支之前，且中止后不再转发 |
 * | GW-E8 | `session.get` 真的带运行态（刷新后能停） |
 * | GW-E9 | 发布器/审批比较器/代理订阅各只有一处（不建第二套） |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapLoopEventToGatewayEvent } from "../core/remote/gateway-events";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function matchArray(src: string, name: string): string[] {
  const body = new RegExp(`${name}\\s*:\\s*&\\[&str\\]\\s*=\\s*&\\[([\\s\\S]*?)\\];`).exec(src)?.[1] ?? "";
  expect(body, `找不到 Rust 数组 ${name}`).not.toBe("");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const LOOP_EVENT_SAMPLES = [
  { type: "text_delta", text: "hi" },
  { type: "reasoning_delta", text: "think" },
  { type: "tool_start", toolCall: { id: "c1", name: "read", input: {} } },
  { type: "tool_complete", toolCall: { id: "c1", name: "read" }, result: { output: "ok" } },
  { type: "tool_error", toolCall: { id: "c1", name: "read" }, error: "x" },
  { type: "start" },
  { type: "end" },
];

describe("网关事件接线（M2）", () => {
  it("GW-E5: 渲染层产出的事件名全部在 Rust 白名单里；reset/ready 只能由 Rust 发", () => {
    const eventsRs = read("src-tauri/src/phone/gateway/events.rs");
    const publishable = matchArray(eventsRs, "PUBLISHABLE_EVENT_TYPES");
    expect(publishable.length).toBeGreaterThan(0);

    const produced = new Set<string>();
    for (const sample of LOOP_EVENT_SAMPLES) {
      const mapped = mapLoopEventToGatewayEvent(sample as never, {
        sessionId: "s1",
        runId: "run-1",
      });
      if (mapped) produced.add(mapped.type);
    }
    // 运行生命周期与审批事件由 desktop-engine 产生（见下一条断言）。
    for (const required of [
      "run.started",
      "run.finished",
      "run.failed",
      "run.cancelled",
      "approval.requested",
      "approval.resolved",
    ]) {
      produced.add(required);
    }
    const engine = read("src/core/remote/desktop-engine.ts");
    const projection = read("src/core/remote/gateway-events.ts");
    for (const type of produced) {
      expect(publishable, `Rust 白名单缺事件类型 ${type}`).toContain(type);
    }
    // desktop-engine / 事件投影里确实写了这些生命周期与审批类型（不是只在本判据里出现）
    expect(engine).toContain('type: "run.started"');
    expect(projection).toContain('"run.cancelled"');
    expect(projection).toContain('type: "approval.requested"');
    expect(projection).toContain('type: "approval.resolved"');

    // 对齐信号不允许渲染层伪造：reset/ready 由 SSE 流自己产生。
    expect(publishable).not.toContain("gateway.reset");
    expect(publishable).not.toContain("gateway.ready");
    expect(eventsRs).toContain('pub const RESET_EVENT: &str = "gateway.reset";');
    expect(eventsRs).toContain('pub const READY_EVENT: &str = "gateway.ready";');
  });

  it("GW-E6: /events 在 Rust 侧流式处理：鉴权先于响应头，且不套 25s 整连接时限", () => {
    const mod = read("src-tauri/src/phone/gateway/mod.rs");
    const events = read("src-tauri/src/phone/gateway/events.rs");

    // 路由：GET /events 走流式；其它方法 405。
    expect(mod).toContain("const EVENTS_PATH: &str = \"/events\";");
    expect(mod).toMatch(/EVENTS_PATH if method == "GET" => Route::Events/);
    // `handle_conn` 在读请求之后**先分叉**事件流，再进 25s 的普通路由超时。
    const branch = mod.indexOf('if classify(&req.method, &req.path) == Route::Events {');
    const normal = mod.indexOf("let resp = match timeout(", branch);
    expect(branch).toBeGreaterThan(0);
    expect(normal, "事件流必须绕过 25s 整连接时限").toBeGreaterThan(branch);
    // 鉴权/参数都在写响应头之前（失败只能拿到 JSON，不会建立事件流）。
    const authIdx = mod.indexOf("authenticate_device(&st, headers.device_token()).await");
    const streamIdx = mod.indexOf("events::serve_stream(");
    expect(authIdx).toBeGreaterThan(0);
    expect(streamIdx).toBeGreaterThan(authIdx);
    expect(mod).toContain('json_error(401, "unauthorized"');

    // 帧形状：id + data、注释心跳、续传头都真的实现了。
    expect(events).toContain("format!(\"id: {}\\ndata: {}\\n\\n\"");
    expect(mod).toContain('header_value(head, "last-event-id")');
    expect(mod).toContain("last_event_id");
    expect(events).toContain(": ping");
    expect(events).toContain("\"retry: 2000\\n\\n\"");
  });

  it("GW-E7: 观察者在循环里、写库分支之前，且中止后不再转发", () => {
    const executor = read("src/core/session/executor.ts");
    const loop = executor.indexOf("for await (const event of engine.process(");
    const abort = executor.indexOf("if (abort.signal.aborted) break;", loop);
    const observer = executor.indexOf("onEvent(event);", abort);
    const write = executor.indexOf("switch (event.type) {", observer);
    expect(loop).toBeGreaterThan(0);
    expect(abort).toBeGreaterThan(loop);
    expect(observer, "观察者必须在消费循环里被调用").toBeGreaterThan(abort);
    expect(write, "观察者先于写库分支（看到的是同一份事件）").toBeGreaterThan(observer);

    // 观察者失败不影响回合（观测设施的纪律）
    expect(executor).toContain('console.warn("[SessionExecutor] onEvent observer failed:", e);');
  });

  it("GW-E8: session.get 带运行态（刷新/重连后仍能停）", () => {
    const engine = read("src/core/remote/desktop-engine.ts");
    const detail = engine.slice(
      engine.indexOf("function gatewaySessionDetail("),
      engine.indexOf("// ========== M2 事件发布 =========="),
    );
    expect(detail).toContain("gatewayRuns.activeForSession(sessionId)");
    expect(detail).toContain("run: run ? { runId: run.runId, state: run.state } : null");
    // 只报网关自己的 run（桌面回合不能编一个点了必失败的 runId）
    expect(detail).not.toContain("isSessionExecuting(sessionId) ? { runId");
  });

  it("GW-E9: 发布器/审批比较器/代理订阅各只有一处", () => {
    const engine = read("src/core/remote/desktop-engine.ts");
    const count = (needle: string) => (engine.match(new RegExp(needle, "g")) ?? []).length;
    expect(count("new GatewayEventPublisher\\("), "发布器只允许一处").toBe(1);
    expect(count("new ApprovalEventTracker\\("), "审批比较器只允许一处").toBe(1);
    expect(count("subscribeApprovals\\("), "审批订阅只允许一处").toBe(1);
    // 事件映射只从 runAgentTurn 的观察者进来（没有第二个 mapLoopEventToGatewayEvent 调用点）
    expect(count("mapLoopEventToGatewayEvent\\(")).toBe(1);
  });
});
