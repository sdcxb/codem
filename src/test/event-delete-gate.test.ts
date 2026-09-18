/**
 * 事件删除命令的**线协议形状**（第 55 轮）
 *
 * ## 为什么要在"真端口 + 记录型 transport"上断言
 *
 * 引擎的 `events.delete_session` 装了批量删除闸门（`repo.rs::events_delete_session`，
 * 与 `crud.delete` / `sessions.delete` 共用判据）：受保护表单次删除（含级联）超过 **50 行**
 * 必须显式 `confirm_bulk: true`，否则**拒绝执行**、一行都不删。真机实测（临时库、60 条事件）：
 *
 * ```text
 * events.delete_session { session_id: "s1" }
 *   → {"code":"OTHER","message":"参数 confirm_bulk 不合法：拒绝级联删除：
 *      删除会话 s1 的全部事件 会连带删除 60 行（上限 50）…"}
 * ```
 *
 * 而生产代码 `RustEventsPort.deleteEventsAsync` 原来**不带这个参数** —— 于是任何事件数
 * 超过 50 的会话都会走到"被拒绝"这一支；而调用方 `event-log.ts::deleteAllForSession`
 * 会**先把内存镜像清空**，结果就是"进程内读不到事件、库里一条没少、重启后又回来"。
 *
 * ## 为什么不能靠假存储端口守这条
 *
 * 假端口的 `events.deleteAsync` 是**整个 `RustEventsPort.deleteEventsAsync` 的替身**——
 * 而"传不传 `confirm_bulk`"正发生在被替掉的那段生产代码里，替身看不到参数。
 * 在替身里"复刻闸门"只会得到一条永远为真的断言（第 55 轮真的这么写过一版，才发现这一点）。
 * 所以要断言**参数形状**，只能在真端口上接一个记录型 transport。
 */

import { describe, expect, it } from "vitest";

import { RustStoragePort, type StorageTransport } from "../core/storage/rust-port";

/** 记录每次 invokeCommand 的命令与参数，一律返回成功 */
function recordingTransport() {
  const calls: Array<{ command: string; params?: Record<string, unknown> }> = [];
  const transport: StorageTransport = {
    async invokeCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ command, params });
      return { ok: true, result: { written: 0 } } as T;
    },
    async invokeBatch<T>(): Promise<T> {
      return { ok: true, result: {} } as T;
    },
    async health<T>(): Promise<T> {
      return { ok: true, result: {} } as T;
    },
    async integrityCheck<T>(): Promise<T> {
      return { ok: true, result: {} } as T;
    },
    async checkpoint<T>(): Promise<T> {
      return { ok: true, result: {} } as T;
    },
    async capabilities<T>(): Promise<T> {
      return { commands: [] } as T;
    },
  };
  return { transport, calls };
}

/** 等排队的写真正发出去（`enqueue` 是异步链，给足微任务与宏任务） */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("EVGATE：`events.delete_session` 必须带 confirm_bulk", () => {
  it("EVGATE-1: 真端口发出的这条命令要带 `confirm_bulk: true`（不带 → 真引擎拒绝、镜像却已被清空）", async () => {
    const { transport, calls } = recordingTransport();
    const port = new RustStoragePort(transport, () => {});

    port.deleteEventsAsync("s1");
    await settle();

    const del = calls.filter((c) => c.command === "events.delete_session");
    expect(del.length, "必须真的发出这条命令（而不是只清内存）").toBe(1);
    expect(del[0].params?.session_id).toBe("s1");
    expect(
      del[0].params?.confirm_bulk,
      "删一个会话的全部事件必然超过闸门上限（50 行）：不带 confirm_bulk 会被引擎拒绝，" +
        "而调用方已经把内存镜像清空了 —— 那正是「进程内读不到、重启又回来」的形态",
    ).toBe(true);
  });

  it("EVGATE-2: 金丝雀 —— 闸门判据本身在引擎侧是有用例的（这里只守渲染侧的参数形状）", async () => {
    /**
     * 引擎侧的闸门由 Rust 用例 `events_delete_session_respects_the_cascade_gate` 守着
     * （`src-tauri/codem-db/tests/engine_tests.rs`）。这条金丝雀确认那个用例还在 ——
     * 否则"渲染侧带对了参数"就没有意义（闸门被删掉了，参数也就无所谓了）。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(__dirname, "..", "..");
    const tests = fs.readFileSync(
      path.join(root, "src-tauri", "codem-db", "tests", "engine_tests.rs"),
      "utf8",
    );
    expect(
      tests.includes("events_delete_session_respects_the_cascade_gate"),
      "引擎侧的闸门用例不见了：要么被删了，要么改了名（改名前请同步这条注释）",
    ).toBe(true);
  });
});
