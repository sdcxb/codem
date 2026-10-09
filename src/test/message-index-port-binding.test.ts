/**
 * `INDEX-CALL-1`：消息的**查询索引写穿必须带着端口对象调用**（`this` 不能丢）。
 *
 * ## 这条判据是**真机验证抓出来的回归**的产物（第 192 波）
 *
 * 装机版 1.16.300 的真机现场：启动后 **13 条 console error** + 一条用户可见的横幅
 * 「数据保存失败（message.createMessage.index）… 这次改动目前只在内存里，重启应用后会丢」。
 * 根因一行：`message.ts` 的索引写穿写成了
 *
 *     const viaCommand = port.data.command;
 *     void viaCommand("messages.upsert_index", params)     // ← 脱离对象调用
 *
 * 而真端口 `RustDataPort.command` 的第一句是 `this.traceDestructive(...)`
 * ⇒ `this` 是 undefined ⇒ `TypeError: Cannot read properties of undefined (reading 'traceDestructive')`
 * ⇒ **每一条消息的索引写入都失败**（权威 JSONL 日志仍然写下了，所以"消息没丢"，但索引一直是空的）。
 *
 * ## 为什么全量单测当时是绿的（这才是重点）
 *
 * 测试替身 `fake-storage-port` 的方法不依赖 `this`（普通闭包转发），拆出来调用**毫无问题** ——
 * 于是"拆出来调用"这个形态在 CI 里**结构上不可见**。这与本仓反复强调的
 * 「**测试双不得比实现宽松**」是同一条纪律。
 *
 * 所以本判据有两半，缺一不可：
 * 1. 假端口补了**接收者检查**（`assertBoundToData`）⇒ 拆出来调用当场 TypeError，与真端口同形；
 * 2. 这条断言走**产品真路径**（`MessageStorage.createMessage`）并检查**索引表里真的有那一行**
 *    —— 不是检查"函数被调用过"（那可能被 fire-and-forget 的失败吞掉）。
 *
 * 反向对照：把 `.call(port.data, …)` 改回 `viaCommand(…)` ⇒ 本判据立刻红
 * （变异波次 `index-call-192`）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import * as MessageStorage from "../core/storage/message";
import type { Message } from "../store";

const SESSION_ID = "sess-index-call";

function useFreshPort(): FakeStoragePort {
  const p = createFakeStoragePort();
  setStoragePort(p);
  return p;
}

function message(id: string): Message {
  return {
    id,
    role: "user",
    content: "这条消息必须进查询索引",
    timestamp: 1_700_000_000_000,
    status: "done",
  } as Message;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // console.error 也一起盯着：真机那次的表现就是"控制台 13 条 error"
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  setStoragePort(null);
});

describe("INDEX-CALL-1：索引写穿必须带着端口对象调用", () => {
  it("INDEX-CALL-1：createMessage 之后索引表里真的有这一行（拆掉接收者 ⇒ 直接红）", () => {
    const port = useFreshPort();

    MessageStorage.createMessage(message("m-index-1"), SESSION_ID);

    // ① 写穿命令确实发出去了（`messages.upsert_index` 是结构性命令，走 `data.command`）
    expect(
      port.__writes().map((w) => w.command),
      "索引写穿必须发出 messages.upsert_index",
    ).toContain("messages.upsert_index");

    // ② **索引里真的有那一行** —— 这才是真正的判据：
    //    `this` 丢掉时命令会当场抛，`onIndexFailure` 只上报不抛，于是"命令发过了"照样成立、
    //    而这一行落不进去。所以必须断言**结果**，不能只断言"调用过"。
    expect(
      port.__table("messages").map((r) => r.id),
      "查询索引里必须真的有这条消息（`this` 丢了的时候这里是空的 —— 真机 1.16.300 的实际形态）",
    ).toContain("m-index-1");
  });

  it("INDEX-CALL-1 反向对照：假端口必须和真端口一样**挑剔接收者**（否则这条判据守不住任何东西）", async () => {
    const port = useFreshPort();
    const detachedCommand = port.data.command!;
    const detachedExecute = port.data.execute;

    // 真端口在这里抛 `Cannot read properties of undefined (reading 'traceDestructive')`；
    // 假端口必须抛（而不是"悄悄成功"——那正是 1.16.300 全量单测全绿的原因）
    await expect(
      Promise.resolve().then(() => detachedCommand("messages.upsert_index", { id: "x" })),
      "脱离对象调用 data.command 必须当场失败",
    ).rejects.toThrow(/this/);
    await expect(
      Promise.resolve().then(() => detachedExecute("messages.upsert_index", { id: "x" })),
      "脱离对象调用 data.execute 必须当场失败",
    ).rejects.toThrow(/this/);

    // 恒真对照：**带着对象**调用时必须正常（否则上面的断言只是"这个替身坏了"）
    await expect(port.data.command("messages.upsert_index", { id: "y", session_id: SESSION_ID })).resolves.toBeTruthy();
  });
});
