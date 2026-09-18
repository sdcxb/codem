/**
 * 「读不到」与「没有」必须说成两句话 —— **消费方逐个收口**（第 61 轮）
 *
 * ## 背景：同一个根因，第 60 轮只修了维护那一处
 *
 * `EventLog.readAll(sid)` 有一条硬路由规则：**该会话的事件镜像没加载完 → 返回空数组**。
 * 第 60 轮在维护的不变量审计里证明了它的代价（同一份数据两次维护报 **934** 与 **749**，
 * 934 恰好等于会话的消息行总数 —— 把"读不到"当成了"没有缺口"，于是反过来把每条消息
 * 都报成缺口）。
 *
 * 但**同一根因还有四个生产消费方**，它们的失真面向用户 / 模型 / 落盘报告：
 *
 * | 消费方 | 把空当成 | 后果 |
 * | --- | --- | --- |
 * | `session_event_search`（模型可见工具） | "没有匹配" | 对模型说"这个会话里没有相关事件"（**假话**） |
 * | `session_event_read`（模型可见工具） | "seq 不存在" | 同上 |
 * | `generatePostmortem`（**落盘**报告） | "会话可能没正常启动"、`totalEvents: 0` | 假结论被持久化，事后排查当成事实 |
 * | `uiTrajectory.getSessionTrajectory`（面板） | "没有轨迹" | 面板空着，而本次运行的步骤就在内存里 |
 *
 * ## 这一组用例的判据
 *
 * 每一处都**成对**断言：镜像没就绪时**不许**下结论（要么如实说"读不到"，要么退回内存），
 * 镜像就绪时**必须**给出真结论（"确实没有"是真话）。只测一半就会漏掉"修过头"——
 * 比如把"确实没有匹配"也改口成"读不到"，那会让模型永远查不到东西。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEventLog, isSessionEventsReadable, whenSessionEventsLoaded } from "../core/storage/event-log";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SID = "readiness-session";

function installTauriStub(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

/**
 * 建端口 + 播种一段事件；`load` 决定是否把事件镜像标成"已就绪"。
 *
 * ⚠️ 事件行必须**直接用 `seed` 摆进表里**，不能走 `getEventLog().append()`：
 * `append` 内部会 `ensureLoaded`（读路由的既定行为），而假端口是**同步就绪**的，
 * 于是"播了种"就等于"镜像已加载" —— 第一版就是这么写的，RR-1 因此拿到 `true`。
 * 也就是说：想造出"库里有事件、但镜像没加载"这个状态，只能绕开事件写路径。
 */
function install(opts: { load: boolean; asyncLoad?: boolean }): FakeStoragePort {
  const port = createFakeStoragePort({
    asyncLoad: opts.asyncLoad === true,
    seed: {
      sessions: [
        { id: SID, project_id: "", title: "readiness", model: null, created_at: 1, last_message_at: 2, message_count: 2, pinned: 0 },
      ],
      session_events: [
        {
          seq: 1,
          session_id: SID,
          event_type: "user_message",
          payload: JSON.stringify({ messageId: "u-1", content: "帮我查一下 rainbow 配置" }),
          timestamp: 1000,
        },
        {
          seq: 2,
          session_id: SID,
          event_type: "assistant_text",
          payload: JSON.stringify({ messageId: "a-1", content: "rainbow 配置在 config.json" }),
          timestamp: 1100,
        },
      ],
    },
  });
  setStoragePort(port);
  if (opts.load) port.events.ensureLoaded(SID);
  return port;
}

/** 把一个会话的事件通道钉成"永远不就绪"（回调不触发、isLoaded 恒 false） */
function wedgeEventMirror(port: FakeStoragePort): void {
  const events = port.events as unknown as {
    isLoaded: (s: string) => boolean;
    ensureLoaded: (s: string, cb?: () => void) => void;
  };
  events.isLoaded = () => false;
  events.ensureLoaded = () => {};
}

beforeEach(() => {
  installTauriStub();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RR：两个共用判据本身", () => {
  it("RR-1: `isSessionEventsReadable` —— 未就绪为 false、就绪为 true、没有端口为 true", async () => {
    const port = install({ load: false });
    expect(isSessionEventsReadable(SID), "镜像未加载完 → 不许说读得到").toBe(false);

    port.events.ensureLoaded(SID);
    expect(isSessionEventsReadable(SID), "加载完 → 读得到").toBe(true);

    setStoragePort(null);
    expect(isSessionEventsReadable(SID), "没有端口 = 没有可判的东西（与维护里同一条判据）").toBe(true);
  });

  it("RR-2: `whenSessionEventsLoaded` —— 已就绪立即 true；异步加载完成后 true", async () => {
    const port = install({ load: true, asyncLoad: true });
    // asyncLoad 打开时 `ensureLoaded` 排到微任务：等待必须真的等
    const ok = await whenSessionEventsLoaded(SID, 2000);
    expect(ok, "异步加载完成 → true").toBe(true);
    expect(port.events.isLoaded(SID)).toBe(true);
  });

  it("RR-3: `whenSessionEventsLoaded` —— 等不到就返回 false（**不许**假装就绪）", async () => {
    const port = install({ load: false });
    wedgeEventMirror(port);

    vi.useFakeTimers();
    const pending = whenSessionEventsLoaded(SID, 3000);
    await vi.advanceTimersByTimeAsync(3500);
    const ok = await pending;
    vi.useRealTimers();

    expect(ok, "超时 = 读不到 ⇒ 调用方必须如实说，不许当成'没有数据'").toBe(false);
  });
});

describe("RR：模型可见的工具（`session_event_search` / `session_event_read`）", () => {
  it("RR-4: 镜像没就绪 → **不许**说「没有匹配」，要如实说读不到（并标记为错误）", async () => {
    const port = install({ load: false });
    wedgeEventMirror(port);

    const { createSessionEventSearchTool } = await import("../core/llm/tools/session-search");
    const tool = createSessionEventSearchTool();

    vi.useFakeTimers();
    const pending = tool.execute({ session_id: SID, query: "rainbow" }, {} as never);
    await vi.advanceTimersByTimeAsync(6000);
    const res = await pending;
    vi.useRealTimers();

    expect(res.output, "假话：'No events found matching' 会让模型以为这个会话没有相关记录").not.toContain(
      "No events found matching",
    );
    expect(res.output).toContain("读不到");
    expect(res.isError, "这是一次**没跑成**的查询，不是'查了没有'").toBe(true);
  });

  it("RR-5: 镜像就绪 → 正常搜索必须真的找到（不许被上面的改动改坏）", async () => {
    install({ load: true });
    const { createSessionEventSearchTool } = await import("../core/llm/tools/session-search");
    const tool = createSessionEventSearchTool();

    const res = await tool.execute({ session_id: SID, query: "rainbow" }, {} as never);
    // 两条事件都含 "rainbow"（用户提问 + 助手回答）⇒ 就该报 2 条
    expect(res.output).toContain("Found 2 event(s)");
    expect(res.output).toContain("rainbow");
  });

  it("RR-6: 镜像就绪但确实没有匹配 → 「没有匹配」是**真话**，必须照说", async () => {
    install({ load: true });
    const { createSessionEventSearchTool } = await import("../core/llm/tools/session-search");
    const tool = createSessionEventSearchTool();

    const res = await tool.execute({ session_id: SID, query: "绝不会出现的词_zzz" }, {} as never);
    expect(res.output).toContain("No events found matching");
  });

  it("RR-7: `session_event_read`：镜像没就绪 → 不许说「seq 不存在」", async () => {
    const port = install({ load: false });
    wedgeEventMirror(port);

    const { createSessionEventReadTool } = await import("../core/llm/tools/session-search");
    const tool = createSessionEventReadTool();

    vi.useFakeTimers();
    const pending = tool.execute({ session_id: SID, seq: 2 }, {} as never);
    await vi.advanceTimersByTimeAsync(6000);
    const res = await pending;
    vi.useRealTimers();

    expect(res.output).not.toContain("not found in session");
    expect(res.output).toContain("读不到");
  });

  it("RR-8: `session_event_read`：镜像就绪 → 真的读得出那条事件", async () => {
    install({ load: true });
    const { createSessionEventReadTool } = await import("../core/llm/tools/session-search");
    const tool = createSessionEventReadTool();

    const res = await tool.execute({ session_id: SID, seq: 2 }, {} as never);
    expect(res.output).toContain("▶ [seq=2]");
    expect(res.output).toContain("rainbow");
  });
});

describe("RR：落盘报告（`generatePostmortem`）", () => {
  it("RR-9: 镜像没就绪 → 报告必须写明「统计不完整」，不许编原因", async () => {
    const port = install({ load: false });
    wedgeEventMirror(port);

    const { generatePostmortem } = await import("../core/llm/postmortem");
    vi.useFakeTimers();
    const pending = generatePostmortem(SID, "模拟的请求失败");
    await vi.advanceTimersByTimeAsync(6000);
    const report = await pending;
    vi.useRealTimers();

    expect(report.eventsReadable, "报告必须自带'读到了吗'这个事实").toBe(false);
    expect(
      report.possibleCauses.some((c) => c.includes("INCOMPLETE")),
      "必须说明统计不完整",
    ).toBe(true);
    expect(
      report.possibleCauses.some((c) => c.includes("may not have started properly")),
      "读不到时**不许**断言'会话可能没正常启动'（那是编原因）",
    ).toBe(false);
  });

  it("RR-10: 镜像就绪 → 报告统计是真值（含 totalEvents 与工具统计）", async () => {
    install({ load: true });
    const log = getEventLog();
    log.append(SID, "tool_call", { toolCallId: "tc-1", messageId: "a-1", tool: "bash", args: {} });
    log.append(SID, "tool_result", { toolCallId: "tc-1", status: "error" });

    const { generatePostmortem } = await import("../core/llm/postmortem");
    const report = await generatePostmortem(SID, "模拟的请求失败");

    expect(report.eventsReadable).toBe(true);
    expect(report.eventSummary.totalEvents, "4 条事件（2 播种 + 1 调用 + 1 结果）").toBe(4);
    expect(report.toolCallStats.totalCalls).toBe(1);
    expect(report.toolCallStats.failedCalls).toBe(1);
    expect(report.possibleCauses.some((c) => c.includes("1 tool call(s) failed"))).toBe(true);
  });

  it("RR-11: 就绪但确实没有事件 → 这时才允许说「可能没正常启动」", async () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    port.events.ensureLoaded("empty-session");

    const { generatePostmortem } = await import("../core/llm/postmortem");
    const report = await generatePostmortem("empty-session", "模拟的请求失败");

    expect(report.eventsReadable).toBe(true);
    expect(report.eventSummary.totalEvents).toBe(0);
    expect(report.possibleCauses.some((c) => c.includes("may not have started properly"))).toBe(true);
  });
});

describe("RR：轨迹面板（`uiTrajectory.getSessionTrajectory`，同步路径）", () => {
  it("RR-12: 镜像没就绪 → 退回**内存里的本次运行步骤**，不许返回空", async () => {
    const port = install({ load: false });
    const { uiTrajectoryProvider } = await import("../core/provider/ui-trajectory-provider");

    let trajectory: any = null;
    const ctx = {
      provide: (_name: string, impl: unknown) => {
        trajectory = impl;
        return () => {};
      },
      get: () => ({ register: () => () => {}, inject: () => () => {} }),
    };
    (uiTrajectoryProvider as unknown as (c: unknown) => unknown)(ctx);

    trajectory.record(SID, "turn_start", { note: "本次运行的第一步" });
    wedgeEventMirror(port);

    const steps = trajectory.getSessionTrajectory(SID);
    expect(steps.length, "读不到事件时返回空 = 面板说'没有轨迹'，而步骤就在内存里").toBeGreaterThan(0);
    expect(steps[0].type).toBe("turn_start");
  });

  it("RR-13: 镜像就绪 → 仍然以事件日志为准（含历史）", async () => {
    install({ load: true });
    const { uiTrajectoryProvider } = await import("../core/provider/ui-trajectory-provider");

    let trajectory: any = null;
    const ctx = {
      provide: (_name: string, impl: unknown) => {
        trajectory = impl;
        return () => {};
      },
      get: () => ({ register: () => () => {}, inject: () => () => {} }),
    };
    (uiTrajectoryProvider as unknown as (c: unknown) => unknown)(ctx);

    trajectory.record(SID, "turn_start", { note: "落库后应当能从事件日志读回来" });
    const steps = trajectory.getSessionTrajectory(SID);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s: { type: string }) => s.type === "turn_start")).toBe(true);
  });
});
