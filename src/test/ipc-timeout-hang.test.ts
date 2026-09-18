/**
 * IPC 挂死保护（第 51 轮）：**"永远不回"也必须变成一个错误**
 *
 * ## 守的缺陷
 *
 * 引擎侧有 `busy_timeout=5000`（锁等待有界），但**渲染侧此前完全没有超时**：
 * `invokeCommand` 的 promise 一旦不 settle（Tauri 命令卡在 `spawn_blocking`、
 * 磁盘/杀软层面的 IO 挂住、通道异常），调用方的 `await` 就**永远不回**。
 *
 * 界面表现是"转圈转到天荒地老"；而本项目**所有**既有机制
 * ——重试白名单、失败横幅、"读不到 vs 没有数据"三态、`CORRUPT` 重建标记——
 * 都建立在同一个前提上：**错误会被抛出来**。
 * "什么都不发生"不是一种用户能处理的状态。
 *
 * ## 判据
 *
 * | 情形 | 期望 |
 * | --- | --- |
 * | 命令一直不返回 | 到点抛 `StorageError`，`code = "UNAVAILABLE"`，**`retryable = false`** |
 * | 同上 | 消息里写明是哪条命令超时、超时多少秒（真机排查要看） |
 * | 命令很快返回 | 完全不受影响（超时器必须被清掉，不许留悬挂的 timer） |
 * | 命令**先**失败 | 抛它自己的错误（超时不许把真实错误盖掉） |
 *
 * `retryable = false` 是**刻意的**：超时不能证明命令没生效（引擎可能已经写完、
 * 只是回包没回来），自动重试对 `messages.create` / `events.append` 就是**插入两条**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RustStoragePort, type StorageTransport } from "../core/storage/rust-port";

/** 造一个指定行为的假传输层 */
function makeTransport(invokeCommand: (command: string) => Promise<unknown>) {
  return {
    invokeCommand,
    invokeBatch: async () => ({ ok: true, result: { items: [] } }),
    health: async () => ({ ok: true, result: { ready: true } }),
    integrityCheck: async () => ({ ok: true, result: { ok: true } }),
    checkpoint: async () => ({ ok: true, result: { ok: true } }),
    capabilities: async () => ({ ok: true, result: { commands: [] } }),
  } as unknown as StorageTransport;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("IPCTIMEOUT：卡死的 IPC 必须变成可见的错误", () => {
  it("IPCTIMEOUT-1: 命令一直不返回 → 到点抛 UNAVAILABLE 且**不可重试**", async () => {
    const port = new RustStoragePort(
      makeTransport(() => new Promise(() => {})), // 永远不 settle
      () => {},
    );

    vi.useFakeTimers();
    const p = port.data.query("crud.list", { table: "messages", limit: 1 });
    // 挂死的 promise 不会有未处理拒绝：这里同时把断言挂上，避免 vitest 报 unhandled
    const settled = p.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(61_000);

    const r = await settled;
    expect(r.ok, "不许永远挂着 —— 必须变成一个错误").toBe(false);
    const err = (r as { e: { code?: string; retryable?: boolean; message?: string } }).e;
    expect(err.code).toBe("UNAVAILABLE");
    expect(
      err.retryable,
      "超时不能证明命令没生效（可能已写完只是回包丢了）→ 自动重试会插入两条",
    ).toBe(false);
    expect(err.message, "真机排查要知道是哪条命令、超时多久").toContain("crud.list");
    expect(err.message).toContain("60");
  });

  it("IPCTIMEOUT-2: 命令很快返回 → 不受影响，且不留悬挂的 timer", async () => {
    let calls = 0;
    const port = new RustStoragePort(
      makeTransport(async () => {
        calls++;
        return { ok: true, result: { items: [{ id: "m1" }], has_more: false } };
      }),
      () => {},
    );

    vi.useFakeTimers();
    const res = await port.data.query<{ items: unknown[] }>("crud.list", { table: "messages" });
    expect(res.items.length).toBe(1);
    expect(calls).toBe(1);

    // 若超时器没被清掉，推进时间会留下一个已 reject 的 promise（这里断言"没有未处理拒绝"）
    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.on("unhandledRejection", onUnhandled);
    await vi.advanceTimersByTimeAsync(120_000);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled, "成功返回后超时器必须被清掉（否则每次调用都留一个定时器）").toBe(false);
  });

  it("IPCTIMEOUT-3: 命令**先**失败 → 抛它自己的错误（超时不许把真实错误盖掉）", async () => {
    const port = new RustStoragePort(
      makeTransport(async () => {
        throw new Error("桥断了");
      }),
      () => {},
    );

    vi.useFakeTimers();
    const p = port.data.query("crud.list", { table: "messages" });
    const settled = p.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(61_000);

    const r = await settled;
    expect(r.ok).toBe(false);
    const err = (r as { e: { code?: string; message?: string } }).e;
    expect(err.code, "桥断了的错误码不能被超时改写成 UNAVAILABLE").not.toBe("UNAVAILABLE");
    expect(err.message, "真实原因要保留（'桥断了'）").toContain("桥断了");
  });

  it("IPCTIMEOUT-4: 批量写也受同样的保护（它是另一个 IPC 出口）", async () => {
    const transport = {
      invokeCommand: async () => ({ ok: true, result: {} }),
      invokeBatch: () => new Promise(() => {}), // 永远不 settle
      health: async () => ({ ok: true, result: { ready: true } }),
      integrityCheck: async () => ({ ok: true, result: { ok: true } }),
      checkpoint: async () => ({ ok: true, result: { ok: true } }),
      capabilities: async () => ({ ok: true, result: { commands: [] } }),
    } as unknown as StorageTransport;
    const port = new RustStoragePort(transport, () => {});

    vi.useFakeTimers();
    const p = port.data.write([{ command: "settings.set", params: { key: "k", value: "v" } }]);
    const settled = p.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(61_000);

    const r = await settled;
    expect(r.ok, "批量出口也必须会被超时打断").toBe(false);
    expect((r as { e: { message?: string } }).e.message).toContain("storage_batch");
  });
});
