/**
 * 网关 run 归属表判据（GW-R1..GW-R8，ADR-0005 M2 写路径第一批）。
 *
 * 这张表是"手机发起的 run 到底是谁的、还在不在跑"的唯一记录：
 * 同会话单 run、`requestId` 幂等、取消归属、终态记账都在这里定死。
 * 它**不**执行任何东西（执行复用 `executeSessionTurn`），所以可以用纯 Node 测。
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_GATEWAY_RUN_HISTORY,
  GatewayRunRegistry,
  type GatewayRunRegistryOptions,
} from "../core/remote/gateway-runs";

/** 可预测的时钟与 id：判据不依赖真实时间/随机数。 */
function make(opts: GatewayRunRegistryOptions = {}) {
  let clock = 1_000;
  let seq = 0;
  const registry = new GatewayRunRegistry({
    now: () => clock,
    newRunId: () => `run-${++seq}`,
    ...opts,
  });
  return {
    registry,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("网关 run 归属表", () => {
  it("GW-R1: 新 run 处于 running，可按会话查到", () => {
    const { registry } = make();
    const claim = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.deduplicated).toBe(false);
    expect(claim.run).toMatchObject({
      runId: "run-1",
      sessionId: "s1",
      clientId: "a",
      requestId: "r1",
      state: "running",
      cancelRequested: false,
    });
    expect(registry.activeForSession("s1")?.runId).toBe("run-1");
    expect(registry.activeCount()).toBe(1);
  });

  it("GW-R2: 同会话第二个请求 → BUSY（同一设备）/ RUN_OWNED（别的设备）", () => {
    const { registry } = make();
    const first = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    expect(first.ok).toBe(true);

    const same = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r2" });
    expect(same.ok).toBe(false);
    if (!same.ok) {
      expect(same.code).toBe("BUSY");
      expect(same.active?.runId).toBe("run-1");
    }

    const other = registry.claim({ sessionId: "s1", clientId: "b", requestId: "r1" });
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.code).toBe("RUN_OWNED");
      expect(other.active?.clientId).toBe("a");
    }
    // 不同会话互不影响
    expect(registry.claim({ sessionId: "s2", clientId: "a" }).ok).toBe(true);
  });

  it("GW-R3: 同 requestId 重发拿回同一个 runId（不再启动第二次）", () => {
    const { registry } = make();
    const first = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    const again = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.run.runId).toBe(first.run.runId);
    expect(again.deduplicated).toBe(true);
    expect(registry.activeCount()).toBe(1);

    // 运行结束后重发仍是同一次（幂等跨终态保持）
    registry.finish(first.run.runId, "finished");
    const later = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    expect(later.ok).toBe(true);
    if (later.ok) {
      expect(later.run.runId).toBe(first.run.runId);
      expect(later.deduplicated).toBe(true);
      expect(later.run.state).toBe("finished");
    }

    // 但**新的** requestId 必须能开新 run —— 终态不能把会话永久锁住
    const next = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r2" });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.run.runId).not.toBe(first.run.runId);
      expect(next.run.state).toBe("running");
    }
  });

  it("GW-R4: 幂等键只对同一设备有效（另一台设备不能借 requestId 拿到别人的 runId）", () => {
    const { registry } = make();
    registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    const other = registry.claim({ sessionId: "s1", clientId: "b", requestId: "r1" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("RUN_OWNED");
  });

  it("GW-R3b: findByRequestId 只按同一会话 + 同一设备解析（忙预检之前回答重发）", () => {
    const { registry } = make();
    const claim = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    if (!claim.ok) throw new Error("claim failed");

    expect(
      registry.findByRequestId({ sessionId: "s1", clientId: "a", requestId: "r1" })?.runId,
    ).toBe(claim.run.runId);
    expect(registry.findByRequestId({ sessionId: "s1", clientId: "b", requestId: "r1" })).toBeUndefined();
    expect(registry.findByRequestId({ sessionId: "s2", clientId: "a", requestId: "r1" })).toBeUndefined();
    expect(registry.findByRequestId({ sessionId: "s1", clientId: "a" })).toBeUndefined();
    expect(registry.findByRequestId({ sessionId: "s1", clientId: "a", requestId: "  " })).toBeUndefined();
  });

  it("GW-R5: 取消只允许发起者，且终态落成 cancelled", () => {
    const { registry } = make();
    const claim = registry.claim({ sessionId: "s1", clientId: "a", requestId: "r1" });
    if (!claim.ok) throw new Error("claim failed");
    const runId = claim.run.runId;

    const foreign = registry.requestCancel({ runId, clientId: "b" });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("RUN_OWNED");

    const own = registry.requestCancel({ runId, clientId: "a" });
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.cancelled).toBe(true);

    // 终态由"取消过"决定：即使 executor 把这一轮报成失败，也不该显示成 failed。
    const settled = registry.finish(runId, "failed");
    expect(settled?.state).toBe("cancelled");
    expect(settled?.cancelRequested).toBe(true);
    expect(settled?.endedAt).toBe(1_000);
  });

  it("GW-R6: 找不到 / 已结束的取消如实回答（不报错、不假装停了）", () => {
    const { registry } = make();
    const missing = registry.requestCancel({ runId: "run-404" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("RUN_NOT_FOUND");

    const claim = registry.claim({ sessionId: "s1", clientId: "a" });
    if (!claim.ok) throw new Error("claim failed");
    registry.finish(claim.run.runId, "finished");
    const late = registry.requestCancel({ runId: claim.run.runId, clientId: "a" });
    expect(late.ok).toBe(true);
    if (late.ok) {
      expect(late.cancelled).toBe(false);
      expect(late.run.state).toBe("finished");
    }
  });

  it("GW-R7: finish 幂等；没有 run 的 finish 返回 undefined", () => {
    const { registry, advance } = make();
    const claim = registry.claim({ sessionId: "s1", clientId: "a" });
    if (!claim.ok) throw new Error("claim failed");
    advance(20);
    const first = registry.finish(claim.run.runId, "finished");
    expect(first?.state).toBe("finished");
    expect(first?.endedAt).toBe(1_020);
    advance(20);
    expect(registry.finish(claim.run.runId, "failed")?.state).toBe("finished");
    expect(registry.finish("run-404", "failed")).toBeUndefined();
  });

  it("GW-R8: 条目有界 —— 只淘汰终态，活动 run 永不淘汰；空 sessionId 拒绝", () => {
    const { registry } = make({ maxRuns: 2 });
    expect(registry.claim({ sessionId: "" }).ok).toBe(false);

    const a = registry.claim({ sessionId: "s1", clientId: "a" });
    const b = registry.claim({ sessionId: "s2", clientId: "a" });
    if (!a.ok || !b.ok) throw new Error("claim failed");
    registry.finish(a.run.runId, "finished");
    registry.finish(b.run.runId, "finished");
    expect(registry.size()).toBe(2);

    const c = registry.claim({ sessionId: "s3", clientId: "a" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(registry.size()).toBe(2);
    // 最老的终态被淘汰；活动 run 保留
    expect(registry.get(a.run.runId)).toBeUndefined();
    expect(registry.get(b.run.runId)).toBeDefined();
    expect(registry.get(c.run.runId)?.state).toBe("running");
    expect(DEFAULT_GATEWAY_RUN_HISTORY).toBe(100);
  });
});
