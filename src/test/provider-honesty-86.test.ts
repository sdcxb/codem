/**
 * 第 86 波：把"看起来有、实际没有"的服务面修成真的。
 *
 * 修复前的事实：
 *   · `hooks-provider` 把 `ctx.get('hooks')` 暴露成有 register/unregister/executeHooks/
 *     listHooks/clearAllHooks 的服务，并声称"第三方插件通过 ctx.hooks.register() 注册"
 *     —— 而 HookManager **根本没有这四个方法**：任何插件调用都 TypeError；
 *     `clearAllHooks()` 是空函数（禁用插件不会清任何钩子）。
 *   · `uiJobs.cancelJob/retryJob` 在 automation 服务缺失时直接 `return true`（假成功）。
 *   · `uiGoal.setGoal` 在 driver 缺失时**凭空造一个目标对象**返回（没有任何地方存过它）。
 *   · `sessionCheckpoint.saveCheckpoint` 返回 void，若调用方没带 id 就永远无法按 id 取回。
 *   · `schedule.addRecurring(0)` 会创建"能多快就多快"的紧循环定时器。
 *   · `computer.setMode` 写库失败不报（界面显示已切换，重启后变回去）。
 *   · `computer_screenshot` 之外的 computer_* 工具经 `simpleOut` 返回 `Error:` 文本
 *     （第 84 波的状态判定负责把它标成失败，这里只验证文本契约仍在）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookManager } from "../core/hooks/hook-manager";

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: vi.fn(() => ({ hooks: [] })),
  setSettingJSON: vi.fn(),
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
}));

const ctx = {
  sessionId: "s1",
  toolName: "bash",
  input: { command: "ls" },
  cwd: "C:/proj",
} as any;

describe("运行时钩子（插件注册）真的能用", () => {
  it("HK2-1（修复点）: register / unregister / listHooks / clearAllHooks 都真实生效", () => {
    const m = new HookManager();
    expect(typeof (m as any).register).toBe("function");
    expect(typeof (m as any).unregister).toBe("function");
    expect(typeof (m as any).executeHooks).toBe("function");
    expect(typeof (m as any).listHooks).toBe("function");
    expect(typeof (m as any).clearAllHooks).toBe("function");

    const id = m.register("Stop", () => "ok", { name: "plugin-hook" });
    expect(m.runtimeHookCount()).toBe(1);
    expect(m.listHooks("Stop").some((h) => h.id === id && h.type === "runtime")).toBe(true);

    expect(m.unregister("Stop", id)).toBe(true);
    expect(m.runtimeHookCount()).toBe(0);
    expect(m.unregister("Stop", id), "重复注销返回 false").toBe(false);

    m.register("Stop", () => 1);
    m.clearAllHooks();
    expect(m.runtimeHookCount(), "clearAllHooks 必须真的清空（原来是个空函数）").toBe(0);
  });

  it("HK2-2: executeHooks 按事件分发并按注册顺序收集结果", async () => {
    const m = new HookManager();
    const calls: string[] = [];
    m.register("SessionStart", async () => { calls.push("a"); return "A"; });
    m.register("SessionStart", () => { calls.push("b"); return "B"; });
    m.register("Stop", () => "其它事件不参与");

    const results = await m.executeHooks("SessionStart", { foo: 1 });
    expect(calls).toEqual(["a", "b"]);
    expect(results).toEqual(["A", "B"]);
  });

  it("HK2-3: 单个运行时钩子抛错不中断其它钩子，但错误可见", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new HookManager();
    m.register("Stop", () => { throw new Error("plugin boom"); });
    m.register("Stop", () => "依然执行");

    const results = await m.executeHooks("Stop", {});
    expect(results[0].error).toContain("plugin boom");
    expect(results[1]).toBe("依然执行");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/plugin boom/);
    warn.mockRestore();
  });

  it("HK2-4（修复点）: 运行时 PreToolUse 钩子能真的拦下/改参数，写错 action 也 fail-closed", async () => {
    const m = new HookManager();
    m.register("PreToolUse", () => ({ action: "deny", denyMessage: "plugin says no" }));
    const denied = await m.executePreToolHooks("bash", { command: "rm -rf /" }, ctx);
    expect(denied.action).toBe("deny");
    expect(denied.denyMessage).toContain("plugin says no");

    const m2 = new HookManager();
    m2.register("PreToolUse", () => ({ action: "modify", modifiedInput: { command: "ls -la" } }));
    const modified = await m2.executePreToolHooks("bash", { command: "rm -rf /" }, ctx);
    expect(modified.action).toBe("modify");
    expect(modified.modifiedInput).toEqual({ command: "ls -la" });

    const m3 = new HookManager();
    m3.register("PreToolUse", () => ({ action: "denied" })); // 写错名字
    const weird = await m3.executePreToolHooks("bash", { command: "ls" }, ctx);
    expect(weird.action, "未识别的 action 不能静默放行").toBe("deny");

    const m4 = new HookManager();
    m4.register("PreToolUse", () => undefined); // 只是观察，没有裁决
    expect((await m4.executePreToolHooks("bash", { command: "ls" }, ctx)).action).toBe("allow");
  });

  it("HK2-5: 运行时 PostToolUse 钩子能替换输出", async () => {
    const m = new HookManager();
    m.register("PostToolUse", () => "被插件改写的结果");
    const out = await m.executePostToolHooks("bash", { command: "ls" }, "原始输出", ctx);
    expect(out).toBe("被插件改写的结果");
  });
});

describe("服务面不再伪造成功", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("HK2-6（修复点）: uiJobs 在 automation 缺失时抛错，而不是返回 true", async () => {
    const { uiJobsProvider } = await import("../core/provider/ui-jobs-provider");
    const provided: Record<string, any> = {};
    const fakeCtx: any = {
      get: () => undefined,
      provide: (name: string, svc: any) => { provided[name] = svc; return () => {}; },
    };
    // 该 provider 需要 slots —— 提供一个最小替身
    const slots = {
      register: () => () => {},
      inject: () => () => {},
    };
    fakeCtx.get = (name: string) => (name === "slots" ? slots : undefined);

    uiJobsProvider(fakeCtx);
    const svc = provided.uiJobs;
    expect(svc).toBeTruthy();
    await expect(svc.cancelJob("job-1")).rejects.toThrow(/automation/);
    await expect(svc.retryJob("job-1")).rejects.toThrow(/automation/);
  });

  it("HK2-7（修复点）: uiJobs 在 automation 存在时正常转发", async () => {
    const { uiJobsProvider } = await import("../core/provider/ui-jobs-provider");
    const provided: Record<string, any> = {};
    const automation = { cancel: vi.fn(async () => true), retry: vi.fn(async () => true), list: vi.fn(() => []) };
    const slots = { register: () => () => {}, inject: () => () => {} };
    const fakeCtx: any = {
      get: (name: string) => (name === "slots" ? slots : name === "automation" ? automation : undefined),
      provide: (name: string, svc: any) => { provided[name] = svc; return () => {}; },
    };

    uiJobsProvider(fakeCtx);
    const svc = provided.uiJobs;
    await expect(svc.cancelJob("job-1")).resolves.toBe(true);
    await expect(svc.retryJob("job-1")).resolves.toBe(true);
    expect(automation.cancel).toHaveBeenCalledWith("job-1");
    expect(automation.retry).toHaveBeenCalledWith("job-1");
  });

  it("HK2-8（修复点）: uiGoal 在 driver 缺失时抛错，不再凭空造目标对象", async () => {
    const { uiGoalProvider } = await import("../core/provider/ui-goal-provider");
    const provided: Record<string, any> = {};
    const slots = { register: () => () => {}, inject: () => () => {} };
    const fakeCtx: any = {
      get: (name: string) => (name === "slots" ? slots : undefined),
      provide: (name: string, svc: any) => { provided[name] = svc; return () => {}; },
    };

    uiGoalProvider(fakeCtx);
    const svc = provided.uiGoal;
    await expect(svc.setGoal({ objective: "x" })).rejects.toThrow(/goalRoundDriver/);
    expect(await svc.getGoals()).toEqual([]);
  });

  it("HK2-9（修复点）: sessionCheckpoint.saveCheckpoint 返回可用的 id", async () => {
    const { sessionCheckpointProvider } = await import("../core/provider/session-checkpoint-provider");
    const provided: Record<string, any> = {};
    const fakeCtx: any = { provide: (name: string, svc: any) => { provided[name] = svc; return () => {}; } };
    vi.spyOn(console, "info").mockImplementation(() => {});

    sessionCheckpointProvider(fakeCtx);
    const svc = provided.sessionCheckpoint;
    const id = svc.saveCheckpoint("s1", { iteration: 5 });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // 关键：能按返回的 id 取回（原来没带 id 的检查点永远取不回来）
    expect(svc.restore("s1", id)).toMatchObject({ iteration: 5 });
    vi.mocked(console.info).mockRestore();
  });

  it("HK2-10（修复点）: schedule.addRecurring 拒绝会打满主线程的间隔", async () => {
    const { scheduleProvider } = await import("../core/provider/schedule-provider");
    const provided: Record<string, any> = {};
    const fakeCtx: any = {
      get: () => undefined,
      provide: (name: string, svc: any) => { provided[name] = svc; return () => {}; },
    };
    scheduleProvider(fakeCtx);
    const svc = provided.schedule;

    expect(() => svc.addRecurring(0, "x")).toThrow(/intervalMs/);
    expect(() => svc.addRecurring(50, "x")).toThrow(/intervalMs/);
  });

  it("HK2-11（修复点）: 提醒到点但没有通知通道时必须告警（不能静默丢）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scheduleProvider } = await import("../core/provider/schedule-provider");
    const provided: Record<string, any> = {};
    const fakeCtx: any = {
      get: () => undefined, // 没有 inbox
      provide: (name: string, svc: any) => { provided[name] = svc; return () => {}; },
    };
    scheduleProvider(fakeCtx);

    // 过去时间 → 立即触发
    provided.schedule.addReminder(new Date(Date.now() - 1000), "该吃药了");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/没有任何通知通道/);
    warn.mockRestore();
  });
});
