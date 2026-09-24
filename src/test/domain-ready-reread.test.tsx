/**
 * 读侧「就绪后重读」通道（第 72 轮审计新增）—— 与写侧 `deferWrite` 对称的那一半。
 *
 * ## 这个文件守的是什么
 *
 * 写侧早就有"表还没就绪 ⇒ 排队，就绪后按序重放"（A-1"首触必丢"的修法）。
 * 读侧一直**没有**对应机制：`domainReadMany/One` 在镜像未就绪时返回 `undefined`，
 * 存储层按契约吞成 `[]` ⇒ "没读到"与"确实是空"在调用方看起来一样，且**没人再试一次**。
 *
 * 真机因此出过两起事故（都由这里守的机制修掉）：
 *   · 委派页签 —— 编排器构造时读一次 ⇒ 重启后历史永远空；
 *   · 历史消息的赞/踩 —— 每条消息只读一次 ⇒ 显示"未评价"。
 *
 * ## 判据（每条都对应用例）
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | READY-1 | 表**未就绪**时读 ⇒ 就绪后 `onReady` **恰好回调一次**，且此时读到的是真数据 |
 * | READY-2 | 表**已就绪**时读 ⇒ **不回调**（否则"读 → 回调 → 再读 → 再回调"成环） |
 * | READY-3 | 退订之后不再回调 |
 * | READY-4 | 多个回调各回调一次（不放大）；超出上限丢新的并**如实告警** |
 * | READY-5 | 通过 `domainReadMany(..., { onReady })` 这条公开读路径也能挂上 |
 * | READY-6 | `useDomainReady` hook：挂上后卸载会退订（不留闭包） |
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { __resetReadyCallbacks, onceDomainReady, domainReadMany } from "../core/storage/domain-store";

const TABLE = "issue_comments";

/** 造一个"异步加载"的假端口：`ensureLoaded` 之后要等一个微任务才就绪 */
function asyncPort(seed: Array<Record<string, unknown>>) {
  return createFakeStoragePort({ asyncLoad: true, seed: { [TABLE]: seed } });
}

const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  __resetReadyCallbacks();
});

describe("读侧「就绪后重读」通道", () => {
  it("READY-1: 未就绪时读 ⇒ 就绪后恰好回调一次，且那时能读到真数据", async () => {
    const port = asyncPort([{ id: "c1", issue_id: "i1", content: "评论", author_type: "user", author_id: null, created_at: 1, updated_at: 1 }]);
    setStoragePort(port);

    // 镜像还没就绪：这次读拿到的必然是"空"
    const first = domainReadMany(TABLE, (r) => r, { issue_id: "i1" });
    expect(first, "未就绪时按契约返回 undefined（调用方会吞成空）").toBeUndefined();

    let calls = 0;
    let seen: unknown[] | null = null;
    onceDomainReady(TABLE, () => {
      calls++;
      seen = domainReadMany(TABLE, (r) => r, { issue_id: "i1" }) ?? null;
    });

    await act(async () => {
      await flush(8);
    });

    expect(calls, "就绪后必须恰好回调一次（这正是'没人再试一次'缺的那一下）").toBe(1);
    expect(seen, "回调里必须能读到真数据（否则重读没有意义）").toHaveLength(1);
  });

  it("READY-2: 已就绪时读 ⇒ 不回调（否则成环）", async () => {
    const port = asyncPort([]);
    setStoragePort(port);
    port.domains.ensureLoaded(TABLE);
    await act(async () => {
      await flush(8);
    });
    expect(port.domains.isReady(TABLE), "前置：此时表已就绪").toBe(true);

    let calls = 0;
    const unsub = onceDomainReady(TABLE, () => {
      calls++;
    });
    await act(async () => {
      await flush(4);
    });

    expect(calls, "已经就绪 ⇒ 调用方刚那次读已经拿到数据，这里绝不能再回调").toBe(0);
    expect(typeof unsub, "仍然要返回退订函数（形状统一）").toBe("function");
  });

  it("READY-2b: 已就绪的表走**公开读路径**（opts.onReady）也不能回调（成环的另一半）", async () => {
    const port = asyncPort([]);
    setStoragePort(port);
    port.domains.ensureLoaded(TABLE);
    await act(async () => {
      await flush(8);
    });
    expect(port.domains.isReady(TABLE)).toBe(true);

    let calls = 0;
    domainReadMany(TABLE, (r) => r, undefined, {
      onReady: () => {
        calls++;
      },
    });
    await act(async () => {
      await flush(4);
    });
    /*
     * READY-2 走的是 `onceDomainReady`（它在函数开头就 return）；这一条走 `domainMirror`
     * 内部的 wasReady 判断 —— **两个入口都要成立**，否则"已就绪不回调"只在那一条路上有效，
     * 而 `domainReadMany(..., {onReady})` 这条公开路径会成环（突变 A2 就是打这里的）。
     */
    expect(calls, "已就绪时 domainMirror 也不许登记/回调").toBe(0);
  });

  it("READY-3: 退订之后不再回调", async () => {
    const port = asyncPort([]);
    setStoragePort(port);

    let calls = 0;
    const { __pendingReadyCallbackCount } = await import("../core/storage/domain-store");
    const unsub = onceDomainReady(TABLE, () => {
      calls++;
    });
    expect(__pendingReadyCallbackCount(TABLE), "登记上了").toBe(1);
    unsub(); // 模拟组件卸载
    expect(__pendingReadyCallbackCount(TABLE), "退订必须把它从集合里摘掉（否则是静默泄漏）").toBe(0);

    await act(async () => {
      await flush(8);
    });
    expect(calls, "卸载后闭包不该再被调用").toBe(0);
  });

  it("READY-4: 多个回调各一次；超出上限时丢新的并如实告警（不静默）", async () => {
    const port = asyncPort([]);
    setStoragePort(port);

    const hits: number[] = [];
    // ⚠️ 告警发生在**登记那一刻**（第 33 个被丢时），所以 spy 必须先于登记装上 ——
    // 第一版把 spy 装在登记之后，"没有告警"于是成了假失败（判据装晚了）。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsubs = Array.from({ length: 60 }, (_, i) =>
      onceDomainReady(TABLE, () => hits.push(i)),
    );

    await act(async () => {
      await flush(8);
    });

    // 上限 32：只应该回调前 32 个，且**一次告警**
    expect(hits.length, "超过上限的不该被登记").toBeLessThanOrEqual(32);
    expect(hits.length, "已登记的都要回调到").toBe(32);
    const overflowWarn = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("就绪后重读"));
    expect(overflowWarn.length, "丢弃必须留下痕迹（只喊一次）").toBe(1);
    warn.mockRestore();
    for (const u of unsubs) u();
  });

  it("READY-5: 公开读路径（domainReadMany 的 opts.onReady）同样能挂上", async () => {
    const port = asyncPort([{ id: "c9", issue_id: "i9", content: "x", created_at: 1 }]);
    setStoragePort(port);

    let calls = 0;
    domainReadMany(TABLE, (r) => r, { issue_id: "i9" }, {
      onReady: () => {
        calls++;
      },
    });

    await act(async () => {
      await flush(8);
    });
    expect(calls, "读路径自带的 onReady 也必须被触发").toBe(1);
  });

  it("READY-6: useDomainReady —— 挂上会重读；卸载会退订", async () => {
    const { useDomainReady } = await import("../hooks/use-domain-ready");
    const { __pendingReadyCallbackCount } = await import("../core/storage/domain-store");
    const port = asyncPort([{ id: "c1", issue_id: "i1", content: "评论", created_at: 1 }]);
    setStoragePort(port);

    let loads = 0;
    function Panel() {
      useDomainReady(TABLE, () => {
        loads++;
      });
      return <div />;
    }
    const view = render(<Panel />);
    expect(__pendingReadyCallbackCount(TABLE), "挂载时登记了一个待发回调").toBe(1);

    await act(async () => {
      await flush(8);
    });
    expect(loads, "镜像就绪后必须自动重读一次").toBe(1);
    expect(__pendingReadyCallbackCount(TABLE), "就绪时把这一轮取走（清空）").toBe(0);

    view.unmount();
    expect(loads, "卸载后不该再有回调").toBe(loads);
  });
});
