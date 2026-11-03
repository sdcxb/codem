/**
 * 租约判据（LEASE-1..5，D-5）：
 * - 首个客户端获得租约；
 * - 第二个客户端 hello **不被授予**，且能被告知"可接管"；
 * - 接管必须**二次确认**（第一次只返回 needsConfirmation）；
 * - 确认后接管并返回前任；
 * - TTL 过期后无需确认、任何客户端可直接获得。
 */
import { describe, expect, it } from "vitest";

import { LeaseManager } from "../../packages/host/src/lease";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("LEASE-1 首个客户端", () => {
  it("无人持有时直接授予，并带 TTL", () => {
    const c = clock();
    const m = new LeaseManager(90_000, c.now);
    const r = m.hello("phone-A", "Pixel");
    expect(r.granted).toBe(true);
    expect(r.lease).toMatchObject({ holder: "remote", clientId: "phone-A", deviceName: "Pixel" });
    expect(r.lease.expiresAt).toBe(1_000_000 + 90_000);
  });

  it("同一客户端重复 hello 是续期，不是冲突", () => {
    const c = clock();
    const m = new LeaseManager(90_000, c.now);
    m.hello("phone-A");
    c.advance(30_000);
    const again = m.hello("phone-A");
    expect(again.granted).toBe(true);
    expect(again.lease.expiresAt).toBe(1_000_000 + 30_000 + 90_000);
  });
});

describe("LEASE-2 后到者不被授予", () => {
  it("他人持有时 hello 返回现状 + canTakeover", () => {
    const m = new LeaseManager(90_000, clock().now);
    m.hello("phone-A");
    const r = m.hello("desktop-B");
    expect(r.granted).toBe(false);
    expect(r.canTakeover).toBe(true);
    expect(r.lease.clientId).toBe("phone-A");
  });
});

describe("LEASE-3/4 二次确认接管", () => {
  it("第一次 takeover 不授予，只要求确认", () => {
    const m = new LeaseManager(90_000, clock().now);
    m.hello("phone-A");
    const first = m.takeover("desktop-B", false);
    expect(first.granted).toBe(false);
    expect(first.needsConfirmation).toBe(true);
    expect(first.previousHolder).toBe("phone-A");
  });

  it("confirm=true 才真正接管，并返回前任", () => {
    const m = new LeaseManager(90_000, clock().now);
    m.hello("phone-A");
    const r = m.takeover("desktop-B", true, "Laptop");
    expect(r.granted).toBe(true);
    expect(r.lease.clientId).toBe("desktop-B");
    expect(r.previousHolder).toBe("phone-A");
    expect(m.hello("phone-A").granted).toBe(false);
  });
});

describe("LEASE-5 过期与释放", () => {
  it("TTL 过期后任意客户端可直接获得", () => {
    const c = clock();
    const m = new LeaseManager(90_000, c.now);
    m.hello("phone-A");
    c.advance(90_001);
    expect(m.view().holder).toBe("none");
    expect(m.hello("desktop-B").granted).toBe(true);
  });

  it("持有者可以主动释放", () => {
    const m = new LeaseManager(90_000, clock().now);
    m.hello("phone-A");
    expect(m.release("phone-A").holder).toBe("none");
    expect(m.hello("desktop-B").granted).toBe(true);
  });

  it("非持有者释放无效（不能把别人的租约弄没）", () => {
    const m = new LeaseManager(90_000, clock().now);
    m.hello("phone-A");
    m.release("desktop-B");
    expect(m.view().clientId).toBe("phone-A");
  });
});
