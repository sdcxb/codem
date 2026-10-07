/**
 * `CTX`（第 309 波）：`totalEvents` **不许把诊断类事件算进上下文** ✓
 *
 * ## 守的缺陷（**两次真实回归**换来的 ✓，归档 §13.210）
 *
 * `projectSurface().totalEvents` 被 `surface-manager.ts::buildSurfaceNotice` 拼进系统提示词 ✓：
 * `[Context: N visible messages, M total events]` ✓ —— 而 **M 每轮都进上下文** ✗
 * ⇒ 只要这一轮比上一轮**多写一条事件** ✓，M 就变了 ✓
 * ⇒ **第二轮的上下文不再以第一轮的为前缀** ✗
 * ⇒ **provider 前缀缓存整段失效** ✓（而缓存正是**目标②**在读的东西 ✓）。
 *
 * **不是理论** ✓：我为"回合出口留痕"加过两次事件 ✓，
 * **两次都把 `dsh-d5-prefix-cache-stability` 打红** ✗
 * （第一次 `turn_end` ✓、第二次"回合心跳" ✓，机制逐字相同 ✓）。
 *
 * ⇒ 结构性约束 ✓：**`totalEvents` 排除诊断类之前，任何新事件都会破坏前缀缓存** ✗
 * —— 必须先解它 ✓，再谈加事件 ✓。
 *
 * ## 判据
 *
 * | # | 判据 |
 * |---|---|
 * | `CTX-1` | `loop_stopped` / `turn_end` **不计入** `totalEvents` ✓ |
 * | `CTX-2` | **会进上下文**的事件（`user_message` / `assistant_text` / `tool_call` / `tool_result` / `compaction`）**必须照数** ✓ |
 * | `CTX-3`（反向 ✓） | 加一条诊断事件**不许**改变 `M` ✓ —— 这条直接就是"前缀缓存不会被新诊断毁掉"的机器判据 ✓ |
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { getEventLog } from "../core/storage/event-log";
import { getEventProjection } from "../core/storage/event-projection";

const SID = "ctx-309";

async function install() {
  const port = createFakeStoragePort({
    asyncLoad: false,
    seed: {
      sessions: [{ id: SID, project_id: "", title: "ctx", model: null, created_at: 1, last_message_at: 2, message_count: 0, pinned: 0 }],
    },
  });
  setStoragePort(port);
  return port;
}

/** 读 `totalEvents`（走生产路径 ✓：`projectSurface` ✓） */
const total = () => getEventProjection().projectSurface(SID).totalEvents;

beforeEach(async () => {
  await install();
});

afterEach(() => {
  setStoragePort(null);
});

describe("CTX：上下文里的事件计数不许被诊断事件污染", () => {
  it("CTX-1: `loop_stopped` / `turn_end` 不计入 `totalEvents`", async () => {
    const log = getEventLog();
    const before = total();
    log.append(SID, "loop_stopped", { reason: "completed_unverified", phase: "heartbeat" });
    log.append(SID, "turn_end", { reason: "loop_end" });
    expect(
      total(),
      "诊断类事件**不产生任何消息**，把它们算进『context 里有多少事件』本来就是错的",
    ).toBe(before);
  });

  it("CTX-2: 会进上下文的事件**必须照数**（宁可多算，不可漏算）", async () => {
    const log = getEventLog();
    const before = total();
    log.append(SID, "user_message", { messageId: "u1", content: "你好" });
    log.append(SID, "assistant_text", { messageId: "a1", content: "在" });
    expect(total(), "这三类都真的进上下文 ⇒ 必须被数到").toBeGreaterThan(before);

    const mid = total();
    log.append(SID, "tool_call", { messageId: "a1", toolCallId: "t1", name: "bash", input: {} });
    log.append(SID, "tool_result", { messageId: "a1", toolCallId: "t1", output: "ok" });
    expect(total(), "工具调用/结果同样进上下文 ⇒ 必须被数到").toBeGreaterThan(mid);

    /**
     * ## ★ 第 309 波补：把**其余"会产生消息"的类型也钉住** ✓
     *
     * 为什么必须补 ✗：`CONTEXT_NEUTRAL_EVENT_TYPES` 的**极性是反的** ✓
     * （排除名单 ⇒ 新类型默认**被算进** `totalEvents` ⇒ 默认破坏前缀缓存 ✗，见归档 §13.213 第五节 ✓）。
     * 下一波要把它翻成**允许名单** ✓ —— 而翻极性时**最危险的错是漏登记** ✗
     * （漏了 ⇒ 那个类型的事件不再被数 ⇒ **M 变成假读数** ✗，比"多算"更糟 ✓）。
     * ⇒ **这条判据就是翻极性时的守门人** ✓：下面每加一类，
     * 翻完极性之后**必须仍然绿** ✓；漏登记任何一类，这里当场红 ✓。
     */
    for (const [type, payload] of [
      ["assistant_reasoning", { messageId: "a1", content: "想一下" }],
      ["compaction", { summary: "摘要", removedIds: [] }],
      ["session_snapshot", { messages: [] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const b = total();
      log.append(SID, type, payload);
      expect(
        total(),
        `\`${type}\` 也会进上下文体量 ⇒ 必须被数到（翻成"允许名单"时最容易漏的就是它）`,
      ).toBeGreaterThan(b);
    }
  });

  it("CTX-3（反向）: 加一条诊断事件**不许**改变 `M`（= 前缀缓存不会被新诊断毁掉）", async () => {
    const log = getEventLog();
    log.append(SID, "user_message", { messageId: "u1", content: "第一轮" });
    const m1 = total();
    /** 模拟"这一轮里写了一条诊断事件"（心跳/出口/停止原因 ✓） */
    log.append(SID, "loop_stopped", { reason: "turn_heartbeat", phase: "heartbeat", iteration: 1 });
    log.append(SID, "loop_stopped", { reason: "completed_unverified", phase: "unrun-family" });
    const m2 = total();
    expect(
      m2,
      "`M` 变了 ⇒ 第二轮不再以第一轮为前缀 ⇒ provider 前缀缓存失效（这就是 dsh-d5 两次被弄红的机制）",
    ).toBe(m1);
  });
});
