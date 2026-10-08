/**
 * 镜像"加载被上限截断"必须**按会话**记录 —— 第 184 波存储审计 S3 的回归判据。
 *
 * ## 缺陷形态（审计原文）
 *
 * `RustMessageMirror.truncated` 是一个**实例字段（全局）、且永不重置**：
 * `private truncated = false` 只在某会话循环到 `maxRounds` 时置真，
 * 没有 per-session 记录、没有任何复位点；而 `message.ts::rustMessageSource`
 * 又**不带会话**地问它 —— 于是只要**一个**会话超过 `maxRounds(60) × maxBatch(5000)`
 * （单会话 ≈29.5 万行），本进程内**所有**会话的索引读一律返回空
 * （`listMessagesFromIndex` 走 `return []`，界面暂时读不到 / 欢迎页）。
 * 库里的数据完好，但要重启才恢复。
 *
 * ## 判据（本文件守的三条）
 *
 * - S3-A 【真端口】一个会话截断**不得**让另一个会话也被判为截断（按会话记录，且能说出是哪些）；
 * - S3-B 【读路径】被截断的会话"读不到"要**如实暴露**（`isMessagesReadUnavailable`），
 *   而**别的**会话照常读得出（`listMessagesFromIndex` 非空）；
 * - S3-C 【复位】重新加载**完整**之后，本会话的截断标记必须被清掉（不许永久粘住）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { RustStoragePort } from "../core/storage/rust-port";
import { createFakeStoragePort } from "./fake-storage-port";

const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

/**
 * 轮询等待某个判据成立（真实定时器）。
 *
 * 为什么不能只 `await Promise.resolve()`：一次会话加载是**60 轮分页**，
 * 每轮都要过一次 IPC 包装（`withIpcTimeout` 的 `Promise.race` + 定时器），
 * 纯微任务循环跑不完 —— 那样"没有触顶"会变成夹具问题而不是被测行为。
 */
async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  return pred();
}

/**
 * 假传输。
 *
 * `big` 默认**永远**还有下一页（每页 1 行）—— 目的是把 60 轮跑满
 * （截断判据是"轮次触顶"，不是"总行数"，所以这里不需要真的造 30 万行）。
 * 把 `bigComplete` 打开之后它改成"一页给完"，用来验证重新加载完整时会**清掉**截断标记。
 */
function transport(state: { bigComplete: boolean }) {
  return {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "messages.list") {
        const p = (params ?? {}) as { session_id: string; offset?: number };
        const sid = String(p.session_id ?? "");
        const offset = Number(p.offset ?? 0);
        if (sid === "big") {
          return {
            ok: true,
            result: {
              items: [
                { id: `big-m${offset}`, session_id: sid, role: "user", content: "内容", timestamp: offset, hidden: 0 },
              ],
              has_more: !state.bigComplete,
            },
          } as never;
        }
        if (offset === 0) {
          return {
            ok: true,
            result: {
              items: [
                { id: "small-m0", session_id: sid, role: "user", content: "小会话", timestamp: 1, hidden: 0 },
              ],
              has_more: false,
            },
          } as never;
        }
        return { ok: true, result: { items: [], has_more: false } } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
}

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("消息镜像的截断**按会话**记录（第 184 波存储审计 S3）", () => {
  it("S3-A【真端口】: 一个会话被截断时，**别的**会话不得被判为截断", async () => {
    const port = new RustStoragePort(transport({ bigComplete: false }) as never, () => {}, {
      messageMirrorBudgetRows: 100_000,
    });
    setStoragePort(port);
    await port.start();

    port.messages.ensureLoaded("big");
    await settle();
    port.messages.ensureLoaded("small");
    await waitUntil(() => port.messages.isLoaded("big") && port.messages.isLoaded("small"));

    expect(port.messages.isTruncated("big"), "轮次触顶的会话必须被标为截断").toBe(true);
    expect(
      port.messages.isTruncated("small"),
      "修前这里是全局布尔：small 会被 big 的截断一起判死（它的索引读整批作废）",
    ).toBe(false);
    const stats = port.messages.stats();
    expect(stats.truncated, "兼容读数：有任何一个被截断就是 true").toBe(true);
    expect(stats.truncatedSessions, "截断必须**可见**：要能说出是哪几个会话").toEqual(["big"]);
  });

  it("S3-B【读路径】: 截断的会话如实报「读不到」，别的会话照常读出索引行", async () => {
    const port = createFakeStoragePort({
      seed: {
        messages: [
          { id: "small-m0", session_id: "small", role: "user", content: "小会话", timestamp: 1, hidden: 0 },
          { id: "big-m0", session_id: "big", role: "user", content: "大会话", timestamp: 2, hidden: 0 },
        ],
      },
    });
    setStoragePort(port);
    const mirror = port.messages as unknown as {
      __markLoaded(sid: string): void;
      __setTruncated(v: boolean, sid?: string): void;
    };
    mirror.__markLoaded("small");
    mirror.__markLoaded("big");
    mirror.__setTruncated(true, "big");

    const msgMod = await import("../core/storage/message");
    expect(
      msgMod.listMessagesFromIndex("small").map((m) => m.id),
      "修前：big 的截断把**所有**会话的索引读变成空（这就是「界面暂时读不到」的机制）",
    ).toEqual(["small-m0"]);
    expect(msgMod.isMessagesReadUnavailable("small"), "small 这一次读没有不可用").toBe(false);
    expect(
      msgMod.isMessagesReadUnavailable("big"),
      "被截断的那个会话必须**如实**说「读不到」（不许静默返回空）",
    ).toBe(true);
  });

  it("S3-C【复位】: 重新加载**完整**之后不该继续背着截断标记", async () => {
    const state = { bigComplete: false };
    const port = new RustStoragePort(transport(state) as never, () => {}, { messageMirrorBudgetRows: 100_000 });
    setStoragePort(port);
    await port.start();

    port.messages.ensureLoaded("big");
    await waitUntil(() => port.messages.isLoaded("big"));
    expect(port.messages.isTruncated("big"), "夹具前提：第一次加载触顶").toBe(true);

    // 数据变小了（真的拉得完）→ 作废并重新加载 → 截断标记必须被清掉
    state.bigComplete = true;
    (port.messages as unknown as { reload(sid: string): void }).reload("big");
    await waitUntil(() => port.messages.isLoaded("big"));

    expect(
      port.messages.isTruncated("big"),
      "这次加载是完整的 ⇒ 不许再算截断（修前没有复位点，标记会永久粘住这个会话）",
    ).toBe(false);
    expect(port.messages.stats().truncatedSessions, "stats 里也要跟着清掉").toEqual([]);
  });
});
