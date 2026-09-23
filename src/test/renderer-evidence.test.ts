/**
 * 渲染侧崩溃取证（第 71 轮）—— 真机事故：**页面白屏 / 显示「页面已崩溃」**，
 * 而当时查遍本机没有任何痕迹（详见 `src/core/diagnostics/renderer-evidence.ts` 顶部）。
 *
 * 这个文件守住三件事：
 *   ① 心跳的**内容**必须够定位（JS 堆、DOM 规模、是否在跑回合、存活时长），
 *      而不是一句"我还活着"；
 *   ② 异常与卸载必须真的发出去（`window.onerror` / `unhandledrejection` / `pagehide`）；
 *   ③ 没有 Tauri 宿主（浏览器预览、单测）时**静默跳过**，绝不因此抛错 ——
 *      取证代码反过来把应用弄崩是最糟的形态。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectSample,
  formatSample,
  installRendererEvidence,
  parseRendererCrashRecord,
  formatRendererCrashMessage,
  reportRendererCrashIfAny,
  __resetRendererEvidence,
  HEARTBEAT_INTERVAL_MS,
} from "../core/diagnostics/renderer-evidence";

type Invoke = ReturnType<typeof vi.fn>;
let invoke: Invoke;

function installTauriHost(): Invoke {
  const fn = vi.fn(async () => undefined);
  (globalThis as any).__TAURI__ = { core: { invoke: fn } };
  return fn;
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetRendererEvidence();
  invoke = installTauriHost();
});

afterEach(() => {
  __resetRendererEvidence();
  vi.useRealTimers();
  delete (globalThis as any).__TAURI__;
});

describe("渲染侧崩溃取证", () => {
  it("EV-1: 心跳内容够定位（堆 / DOM / 消息数 / 是否在跑回合 / 存活时长都在一行里）", () => {
    const sample = collectSample();
    expect(sample).toHaveProperty("heapUsedMB");
    expect(sample).toHaveProperty("heapLimitMB");
    expect(typeof sample.domNodes).toBe("number");
    expect(typeof sample.messageBubbles).toBe("number");
    expect(typeof sample.turnRunning).toBe("boolean");
    expect(typeof sample.uptimeSec).toBe("number");

    const line = formatSample(sample);
    expect(line).toContain("dom=");
    expect(line).toContain("msgs=");
    expect(line).toContain("turn=");
    expect(line).toContain("uptime=");
    // 堆取不到时必须如实写 `heap=?`，不能编造数字
    expect(line).toMatch(/heap=(\?|\d+(\.\d+)?\/\d+(\.\d+)?MB)/);
  });

  it("EV-2: 装上之后**立刻**发一条心跳，之后按间隔继续发（崩溃前一定有基线）", () => {
    installRendererEvidence(1000);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invoke.mock.calls[0] as unknown as [string, { sample: string }];
    expect(cmd).toBe("log_renderer_heartbeat");
    expect(args.sample).toContain("uptime=");

    vi.advanceTimersByTime(3000);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("EV-3: 幂等 —— 重复安装不会挂两个定时器（否则日志会被心跳刷爆）", () => {
    installRendererEvidence(1000);
    installRendererEvidence(1000);
    installRendererEvidence(1000);
    expect(invoke).toHaveBeenCalledTimes(1); // 只有第一次那次"立刻发"
    vi.advanceTimersByTime(3000);
    expect(invoke).toHaveBeenCalledTimes(4); // 仍按单个定时器计数
  });

  it("EV-3b: 重置必须把监听器摘干净（否则一条异常会被重复上报，看起来像「出了 N 次错」）", () => {
    installRendererEvidence(HEARTBEAT_INTERVAL_MS);
    __resetRendererEvidence();
    installRendererEvidence(HEARTBEAT_INTERVAL_MS);
    __resetRendererEvidence();
    installRendererEvidence(HEARTBEAT_INTERVAL_MS);
    invoke.mockClear();

    window.dispatchEvent(new ErrorEvent("error", { message: "once" }));

    const errs = (invoke.mock.calls as unknown as Array<[string, unknown]>).filter(
      (c) => c[0] === "log_renderer_event",
    );
    expect(errs.length, "同一次异常只许上报一次").toBe(1);
  });

  it("EV-4: 全局异常与未处理拒绝都必须落盘（打包版里这些原本只进控制台）", () => {
    installRendererEvidence(HEARTBEAT_INTERVAL_MS);
    invoke.mockClear();

    window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "app.js", lineno: 12, colno: 3 }));
    const rejectEvent = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejectEvent.reason = new Error("promise blew up");
    window.dispatchEvent(rejectEvent);

    const calls = invoke.mock.calls as unknown as Array<[string, { level: string; message: string }]>;
    const errs = calls.filter((c) => c[0] === "log_renderer_event");
    expect(errs.length).toBe(2);
    expect(errs[0][1].level).toBe("ERROR");
    expect(errs[0][1].message).toContain("boom");
    expect(errs[0][1].message).toContain("app.js:12:3");
    expect(errs[1][1].message).toContain("promise blew up");
    // 异常行里也要带上当时的水位（否则"崩前的内存"就丢了）
    expect(errs[0][1].message).toContain("uptime=");
  });

  it("EV-5: 页面被卸载时留一行（这样'没有这一行'就能反证是直接崩掉的）", () => {
    installRendererEvidence(HEARTBEAT_INTERVAL_MS);
    invoke.mockClear();

    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));

    const msgs = (invoke.mock.calls as unknown as Array<[string, { message: string }]>)
      .filter((c) => c[0] === "log_renderer_event")
      .map((c) => c[1].message);
    expect(msgs.some((m) => m.startsWith("pagehide"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("beforeunload"))).toBe(true);
  });

  it("EV-6: 没有 Tauri 宿主时静默跳过（取证代码绝不许把应用弄崩）", () => {
    delete (globalThis as any).__TAURI__;
    expect(() => installRendererEvidence(1000)).not.toThrow();
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(() => window.dispatchEvent(new ErrorEvent("error", { message: "x" }))).not.toThrow();
  });

  it("EV-7: 宿主 invoke 抛错也不许冒泡（心跳是尽力而为）", () => {
    (globalThis as any).__TAURI__ = {
      core: {
        invoke: vi.fn(() => {
          throw new Error("IPC 挂了");
        }),
      },
    };
    __resetRendererEvidence();
    expect(() => installRendererEvidence(1000)).not.toThrow();
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });

  // ========== 崩溃标记：让"白屏一闪、自己恢复了"对用户可见 ==========
  // 真机事故：Rust 侧会自动重载恢复，但用户完全不知情 —— 这种崩溃既不会被反馈，
  // 也就永远查不清。下面这组守住"标记解析不许编造 + 上报只发生一次"。

  it("EV-8: 标记解析：缺字段就留空，解析不了就返回 null（绝不编造原因）", () => {
    expect(parseRendererCrashRecord(null)).toBeNull();
    expect(parseRendererCrashRecord("")).toBeNull();
    expect(parseRendererCrashRecord("not json")).toBeNull();
    expect(parseRendererCrashRecord("[]")).toBeNull();
    expect(parseRendererCrashRecord("{}"), "没有 kind/reason 的标记等于没有信息").toBeNull();

    const ok = parseRendererCrashRecord(
      JSON.stringify({ at: 1790000000000, kind: "RENDER_PROCESS_EXITED(1)", reason: "CRASHED(3)", exitCode: -2147483645 }),
    );
    expect(ok).not.toBeNull();
    expect(ok!.kind).toBe("RENDER_PROCESS_EXITED(1)");
    expect(ok!.reason).toBe("CRASHED(3)");
    expect(ok!.exitCode).toBe(-2147483645);
    expect(ok!.module).toBeUndefined(); // 没给就是没给
  });

  it("EV-9: 提示文本必须带上可转述的判据（kind / reason / exit_code）", () => {
    const msg = formatRendererCrashMessage({
      kind: "RENDER_PROCESS_EXITED(1)",
      reason: "OUT_OF_MEMORY(5)",
      exitCode: 5,
      module: "C:\\Windows\\System32\\onnxruntime.dll",
      memory: "host=77MB webview_total=416MB",
    });
    expect(msg).toContain("已自动重载恢复");
    expect(msg).toContain("kind=RENDER_PROCESS_EXITED(1)");
    expect(msg).toContain("reason=OUT_OF_MEMORY(5)");
    expect(msg).toContain("exit_code=5");
    expect(msg).toContain("onnxruntime.dll");
  });

  it("EV-10: 有标记就上报一次；没有标记（或宿主不在）就什么都不做", async () => {
    (globalThis as any).__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd: string) =>
          cmd === "take_renderer_crash_marker"
            ? JSON.stringify({ kind: "RENDER_PROCESS_EXITED(1)", reason: "CRASHED(3)", exitCode: 0 })
            : null,
        ),
      },
    };
    const report = vi.fn();
    const rec = await reportRendererCrashIfAny(report);
    expect(rec).not.toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toContain("reason=CRASHED(3)");

    // 没有标记（Rust 返回 null）⇒ 不弹任何提示
    (globalThis as any).__TAURI__ = { core: { invoke: vi.fn(async () => null) } };
    const report2 = vi.fn();
    expect(await reportRendererCrashIfAny(report2)).toBeNull();
    expect(report2).not.toHaveBeenCalled();

    // 没有宿主 ⇒ 同样什么都不做，且不抛
    delete (globalThis as any).__TAURI__;
    const report3 = vi.fn();
    await expect(reportRendererCrashIfAny(report3)).resolves.toBeNull();
    expect(report3).not.toHaveBeenCalled();
  });
});
