/**
 * `domain-store` 的契约测试（B0-1，第 42 轮新增）
 *
 * ## 为什么必须补这个文件
 *
 * `domain-store.ts` 的文件头写着"三条不变量**都由 domain-store.test.ts 守住**" ——
 * 但这个文件**从来不存在**。于是那三条不变量（未加载不路由 / 先本地再写穿 /
 * 超上限不镜像）一直**没有任何测试**，只有各域自己的间接覆盖。
 *
 * 更关键的是：本轮实测推翻了一次"直接删回退"的改动（基线被打红），
 * 根因是**判据无法区分两种状态** —— 而当时也没有任何测试能把这件事说清楚。
 * 所以这里把"两态"钉成契约：它是后续 L3 删除（23 个文件、185 处）的**安全前提**。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  domainDelete,
  domainDeleteWhere,
  domainEnsureLoaded,
  domainPort,
  domainPortRegistered,
  domainReadMany,
  domainReadOne,
  domainReplaceTable,
  domainWrite,
  shouldFallbackToLegacy,
} from "../core/storage/domain-store";

const TABLE = "note_links";
const opts = { scope: "test.scope", note: "测试用" };

function rowsOf(port: ReturnType<typeof createFakeStoragePort>): Array<Record<string, unknown>> {
  return port.__table(TABLE);
}

beforeEach(() => {
  setStoragePort(null);
});
afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

// ========== 不变量 1：两态必须可区分（B0-1 的核心） ==========

describe("两态判据：端口未注册（A） vs 端口在但镜像未就绪（B）", () => {
  it("A 态：端口未注册 → shouldFallbackToLegacy 为真（旧库是唯一数据源）", () => {
    setStoragePort(null);
    expect(shouldFallbackToLegacy(), "端口都没有，只能回退旧库").toBe(true);
    expect(domainPortRegistered()).toBe(false);
    expect(domainPort(TABLE)).toBeNull();
  });

  it("A 态：端口未注册 → 判据为真且端口层面完全不可用（第 19 轮：wasm 端口形态已不存在（旧引擎删除））", () => {
    setStoragePort(null);
    /**
     * 第 19 轮：这条用例原来叫"A 态：端口是 wasm（回滚开关）→ 同样回退旧库"，
     * 用 `createFakeStoragePort({ kind: "wasm" })` 模拟回滚形态。
     * wasm 端口形态已不存在（旧引擎删除），A 态只剩"端口未注册"，
     * 所以改写成 `setStoragePort(null)` —— 断言一条没少（还多了一条 `domainPort` 为 null）。
     */
    expect(shouldFallbackToLegacy(), "端口都没有，只能回退旧库").toBe(true);
    expect(domainPortRegistered()).toBe(false);
    expect(domainPort(TABLE), "没有端口就没有域端口").toBeNull();
  });

  it("B 态：端口是 rust 且镜像已就绪 → 不回退，且端口可用", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    expect(shouldFallbackToLegacy(), "端口在就不该碰旧库").toBe(false);
    expect(domainPortRegistered()).toBe(true);
    expect(domainPort(TABLE), "fake 端口即时就绪").not.toBeNull();
  });

  it("B 态：端口是 rust 但该表**永不就绪** → 仍然不回退（这是防读写分裂的关键）", () => {
    const port = createFakeStoragePort({ neverReady: [TABLE] });
    setStoragePort(port);
    expect(shouldFallbackToLegacy(), "镜像没就绪 ≠ 该回退：回退会写进另一个数据源").toBe(false);
    expect(domainPort(TABLE), "未就绪 → 端口层面确实不可用").toBeNull();
  });
});

// ========== 不变量 2：只有镜像就绪才路由 ==========

describe("不变量：只有镜像加载完成后才路由", () => {
  it("未就绪时读返回 undefined（而不是空数组）—— 调用方据此区分'没接手'与'确实没有'", () => {
    setStoragePort(createFakeStoragePort({ neverReady: [TABLE] }));
    expect(domainReadMany(TABLE, (r) => r)).toBeUndefined();
    expect(domainReadOne(TABLE, { id: "x" }, (r) => r)).toBeUndefined();
  });

  it("未就绪时写/删返回 false / null（不假装成功）", () => {
    setStoragePort(createFakeStoragePort({ neverReady: [TABLE] }));
    expect(domainWrite(TABLE, [{ id: "a" }], opts), "未接手必须如实返回 false").toBe(false);
    expect(domainDelete(TABLE, { id: "a" }, opts)).toBe(false);
    expect(domainDeleteWhere(TABLE, () => true, "id", opts)).toBeNull();
    expect(domainReplaceTable(TABLE, [{ id: "a" }])).toBe(false);
  });

  it("就绪后路由生效：读得到刚写的行", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    expect(domainWrite(TABLE, [{ id: "a", source_note_id: "s1" }], opts)).toBe(true);
    const rows = domainReadMany(TABLE, (r) => r, { id: "a" });
    expect(rows?.length, "写完立刻读得到（先更新本地镜像）").toBe(1);
  });
});

// ========== 不变量 3：写 = 先本地镜像、再写穿 ==========

describe("不变量：写先更新本地镜像，再写穿", () => {
  it("写穿失败必须如实上报，而不是静默吞掉", async () => {
    const port = createFakeStoragePort({ failWrites: true });
    setStoragePort(port);
    domainWrite(TABLE, [{ id: "a" }], { ...opts, note: "应上报" });
    // 写穿是异步的（不阻塞调用方）：等一个微任务轮次
    await new Promise((r) => setTimeout(r, 0));
    expect(port.__writeFailures(), "落库失败必须被记账").toBeGreaterThan(0);
  });

  it("本地镜像立刻生效（调用方紧接着的同步读能看到自己刚写的）", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    domainWrite(TABLE, [{ id: "a", source_note_id: "s1" }], opts);
    // 不 await：同步读必须已经能看到
    expect(rowsOf(port).some((r) => r.id === "a"), "本地镜像已生效").toBe(true);
  });
});

// ========== domainEnsureLoaded：B 态下的正确处置 ==========

describe("domainEnsureLoaded：B 态下'等就绪后执行'（而不是回退旧库）", () => {
  it("就绪时立即回调", () => {
    setStoragePort(createFakeStoragePort());
    let called = 0;
    domainEnsureLoaded(TABLE, () => {
      called++;
    });
    expect(called, "fake 端口即时就绪 → 同步回调一次").toBe(1);
  });

  it("未就绪时不回调（避免在错误的时机写入）", () => {
    setStoragePort(createFakeStoragePort({ neverReady: [TABLE] }));
    let called = 0;
    domainEnsureLoaded(TABLE, () => {
      called++;
    });
    expect(called, "永不就绪 → 永不回调").toBe(0);
  });

  it("端口未注册时是安全的 no-op（A 态由调用方走旧库）", () => {
    setStoragePort(null);
    expect(() => domainEnsureLoaded(TABLE, () => {})).not.toThrow();
  });
});
