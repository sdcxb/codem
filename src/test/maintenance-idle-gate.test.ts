/**
 * **维护空闲闸**的行为判据（第 46 波 ✓）。
 *
 * 钉住的正是 bug 的形状 ✓：**有回合在跑时，绝不许启动维护** ✗。
 * 以及两条边界 ✓：等超时后允许照样跑 ✓（不饿死维护 ✓）、"静一静"之后又忙起来要重新等 ✓。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForIdle, type IdleGateDeps } from "../core/storage/maintenance-schedule";

/** 假时钟 + 可脚本化的忙闲序列 ✓（每个 sleep 消费一个状态 ✓） */
function fake(script: boolean[], stepMs = 1000) {
  let t = 0;
  let i = 0;
  const deps: IdleGateDeps = {
    isBusy: () => script[Math.min(i, script.length - 1)] ?? false,
    sleep: async (ms) => {
      t += ms;
      i++;
    },
    now: () => t,
  };
  return { deps, stepMs, at: () => t };
}

describe("维护空闲闸：忙的时候绝不开跑 ✓", () => {
  it("IG-1 一开始就空闲 ⇒ 只等「静一静」那一下 ✓，然后开跑 ✓", async () => {
    const f = fake([false]);
    const r = await waitForIdle(f.deps, { stepMs: f.stepMs, settleMs: 3000, maxWaitMs: 60_000 });
    expect(r.idle).toBe(true);
    expect(r.waitedMs, "只应等 settle 那 3s").toBe(3000);
  });

  it("IG-2 ★ 一直忙 ⇒ 退避重试，**不许**在中途开跑 ✗（等满上限才放行 ✓）", async () => {
    const f = fake([true, true, true, true, true, true]);
    const r = await waitForIdle(f.deps, { stepMs: 1000, settleMs: 0, maxWaitMs: 3000 });
    expect(r.idle, "等超时 ⇒ idle=false（由调用方决定照样跑）").toBe(false);
    expect(r.waitedMs, "等待不得超过上限").toBeGreaterThanOrEqual(3000);
    expect(r.waitedMs, "也不该远超上限").toBeLessThan(6000);
  });

  it("IG-3 ★ 「静一静」之后又忙了 ⇒ 必须**重新等** ✗（正是 bug 的形状 ✓）", async () => {
    // 第 1 次看：空闲 ⇒ sleep(settle) ⇒ 再看：忙 ⇒ 退回循环 ⇒ sleep(step) ⇒ 再看：空闲 ⇒ 通过
    const f = fake([false, true, false], 1000);
    const r = await waitForIdle(f.deps, { stepMs: 1000, settleMs: 3000, maxWaitMs: 60_000 });
    expect(r.idle).toBe(true);
    expect(r.waitedMs, "settle 3s + step 1s + settle 3s = 7s").toBe(7000);
  });

  it("IG-4 忙一阵就空 ⇒ 等到空为止 ✓（等待时长 = 退避次数 × 步长 + settle ✓）", async () => {
    const f = fake([true, true, false], 1000);
    const r = await waitForIdle(f.deps, { stepMs: 1000, settleMs: 2000, maxWaitMs: 60_000 });
    expect(r.idle).toBe(true);
    expect(r.waitedMs).toBe(4000); // 2 次退避 + settle 2s
  });

  it("IG-5 默认参数也要行为正确 ✓（不传 opts 不许崩 ✓）", async () => {
    const f = fake([false]);
    const r = await waitForIdle(f.deps);
    expect(r.idle).toBe(true);
  });

  /**
   * 接线判据 ✓：闸**必须**接在 `App.tsx` 的维护之前 ✓，而且必须用 **ref 镜像** ✗ 而不是状态 ✓。
   *
   * 为什么用源码断言 ✓（而不是行为断言 ✗）：`App.tsx` 没有便宜的整机夹具 ✓ ——
   * 这是本仓库对 App 层既有的做法 ✓（见 `app-turn-outcome-rendering.test.ts` 的同款说明 ✓）。
   * 但**行为**的那一半已经在 IG-1..5 里钉住了 ✓ ⇒ 这里只守"别再被接错" ✓。
   */
  it("IG-6 ★ 接线：`App.tsx` 里空闲闸在维护之前 ✓，且用 ref 镜像而不是状态 ✗", () => {
    const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
    const iGate = app.indexOf("await waitForIdle(");
    const iMaint = app.indexOf("await runDatabaseMaintenance();");
    expect(iGate, "必须有空闲闸").toBeGreaterThan(0);
    expect(iMaint, "维护调用必须还在").toBeGreaterThan(0);
    expect(iGate, "★ 闸必须在维护**之前**（否则等于没接）").toBeLessThan(iMaint);
    expect(app, "★ 判据必须读 ref 镜像（读状态 = 读到启动那一刻的陈旧值 ✗）").toMatch(
      /isBusy: \(\) => streamingRef\.current/,
    );
    expect(app, "ref 镜像必须被同步").toMatch(/streamingRef\.current = isStreaming;/);
  });
});
