/**
 * DWE：域写通知（第 6 轮）—— 写路径必须真的通知，而通知不得影响写本身。
 *
 * 这条判据是「有写才读」的地基：侧栏/水位都靠它把轮询降成 0。如果通知没接上，
 * 它们表面上"更省"，实际上是**永远不刷新**（最坏的一种假优化）。
 *
 * 同时守住两条反向性质：
 * - 监听方抛错 **不影响写**（写是事实，通知是尽力而为）；
 * - 取消订阅后不再收到通知。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { domainWrite } from "../core/storage/domain-store";
import { subscribeDomainWrites, __resetDomainWriteListeners } from "../core/storage/domain-write-events";

beforeEach(() => {
  __resetDomainWriteListeners();
  setStoragePort(createFakeStoragePort({ seed: { projects: [{ id: "p1", name: "项目", path: "C:\\work", created_at: 1, last_accessed_at: 1 }] } }));
});

afterEach(() => {
  __resetDomainWriteListeners();
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("DWE：域写通知", () => {
  it("写一张表 ⇒ 订阅方收到该表名", () => {
    const seen: string[] = [];
    subscribeDomainWrites((t) => seen.push(t));
    const ok = domainWrite(
      "projects",
      [{ id: "p2", name: "新项目", path: "C:\\work2", created_at: 2, last_accessed_at: 2 }],
      { note: "DWE 判据", scope: "test" },
    );
    expect(ok, "假端口应已就绪，写必须被接受").toBe(true);
    expect(seen, "写完不通知 ⇒ 依赖它的侧栏/水位永远不会刷新").toContain("projects");
  });

  it("监听方抛错不影响写（写成功仍返回 true）", () => {
    subscribeDomainWrites(() => {
      throw new Error("boom");
    });
    const ok = domainWrite(
      "projects",
      [{ id: "p3", name: "又一颗", path: "C:\\work3", created_at: 3, last_accessed_at: 3 }],
      { note: "DWE 判据", scope: "test" },
    );
    expect(ok, "通知出错把写也带崩了 ⇒ 一个 UI 订阅能毁掉数据链路").toBe(true);
  });

  it("取消订阅后不再收到通知", () => {
    const seen: string[] = [];
    const unsub = subscribeDomainWrites((t) => seen.push(t));
    unsub();
    domainWrite("projects", [{ id: "p4", name: "四号", path: "C:\\work4", created_at: 4, last_accessed_at: 4 }], {
      note: "DWE 判据",
      scope: "test",
    });
    expect(seen).toEqual([]);
  });
});
