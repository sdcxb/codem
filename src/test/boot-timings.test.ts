/**
 * 启动打点：三个时刻必须**真的可被读出来**（第 233 轮审计 · 冷启动收尾）。
 *
 * ## 为什么这条判据必须存在
 *
 * 我们改了启动时序（材质探测最多阻塞 60ms、就绪即放行点击），但 `tsc`、jsdom 判据、
 * `vite build` **都证明不了**"用户等了多久"：
 * - jsdom 没有真实 paint；
 * - `vite build` 只证明体积；
 * - 渲染侧 `console.*` 一退出就没了（`codem-runtime-*.log` 默认只收 Rust 侧）。
 *
 * 所以启动时序的验收只能在**真机**上做，而真机取值的前提是"这三个数真的被写进了磁盘日志"。
 * 这条判据钉的正是那个**通道**：命令名、参数形状、单行格式、以及在无 Tauri 环境下不抛。
 *
 * | # | 行为 |
 * |---|---|
 * | BOOT-T-1 | 有 `__TAURI__` ⇒ 恰好调用一次 `log_renderer_event`，message 里含 `first-paint=`/`fcp=`/`ready=`/`origin=` |
 * | BOOT-T-2（反向对照）| 无 Tauri ⇒ 不调用、不抛（浏览器调试与 jsdom 都走这条） |
 * | BOOT-T-3 | 拿不到的指标写 `n/a`，**不许**补 0（补 0 会让真机读数看起来"极快"） |
 *
 * 变异自证：把 `reportBootTimings` 改成不调 invoke ⇒ BOOT-T-1 红；
 * 把 `num(null)` 改成 `"0.0"` ⇒ BOOT-T-3 红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatBootTimings,
  readBootTimings,
  reportBootTimings,
  reportBootTimingsAfterPaint,
} from "../core/boot/boot-timings";

type Invoke = (cmd: string, args: unknown) => unknown;

function installTauri(invoke: Invoke) {
  (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
}

beforeEach(() => {
  delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
});

afterEach(() => {
  delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
  vi.restoreAllMocks();
});

describe("启动打点：可被真机读出", () => {
  it("BOOT-T-1: 有 Tauri ⇒ 一次 log_renderer_event，且带上三个时刻", () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    installTauri((cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve();
    });

    expect(reportBootTimings()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("log_renderer_event");
    const args = calls[0].args as { level: string; message: string };
    expect(args.level, "级别要能 grep（SAMPLE 是既有 daemon 用的非错误级别）").toBe("SAMPLE");
    for (const key of ["first-paint=", "fcp=", "ready=", "origin="]) {
      expect(args.message, `缺少 ${key}`).toContain(key);
    }
    // 单行：日志按行组织，换行会把一条打点拆成两条
    expect(args.message).not.toContain("\n");
  });

  it("BOOT-T-2（反向对照）: 无 Tauri ⇒ 不调用、不抛", () => {
    expect(() => reportBootTimings()).not.toThrow();
    expect(reportBootTimings(), "没有通道时必须如实返回 false").toBe(false);
  });

  it("BOOT-T-3: 拿不到的指标写 n/a，不许补 0", () => {
    const line = formatBootTimings({ firstPaint: null, fcp: null, ready: 12.34, origin: 1234 });
    expect(line).toContain("first-paint=n/a");
    expect(line).toContain("fcp=n/a");
    expect(line, "补 0 会让真机读数看起来极快").not.toContain("first-paint=0");
    expect(line).toContain("ready=12.3");
  });

  it("BOOT-T-4: readBootTimings 只读真实 paint 条目（没有就 null）", () => {
    const t = readBootTimings();
    // jsdom 里没有 paint timing ⇒ 两个字段都必须是 null，而不是编出来的数字
    expect(t.firstPaint).toBeNull();
    expect(t.fcp).toBeNull();
    expect(t.ready).toBeGreaterThanOrEqual(0);
    expect(t.origin).toBeGreaterThan(0);
  });

  it("BOOT-T-5: 打点挂在两帧之后（首帧画完才读 paint）", async () => {
    const calls: unknown[] = [];
    installTauri((_cmd, args) => {
      calls.push(args);
      return Promise.resolve();
    });
    const rafs: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      rafs.push(cb);
      return rafs.length;
    });

    reportBootTimingsAfterPaint();
    expect(rafs, "必须排进 rAF，而不是同步发").toHaveLength(1);
    expect(calls, "第一帧还没跑，不许发").toHaveLength(0);

    rafs.shift()!(0); // 第一帧：再排一帧
    expect(calls).toHaveLength(0);
    rafs.shift()!(0); // 第二帧：发
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });
});
