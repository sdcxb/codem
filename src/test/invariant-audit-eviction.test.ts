/**
 * 维护的不变量审计 **在镜像被内存预算逐出之后仍然不许报假缺口**（第 63 轮）。
 *
 * ## 守的缺陷（真机形态，写在 `maintenance.ts` 自己的注释里）
 *
 * `runAllInvariants(sid)` 的两条判据分别读 `EventLog.readAll(sid)`（事件）与
 * `MessageStorage.listMessages(sid)`（消息）。两者都有同一条硬路由规则：
 * **该会话的镜像没加载完 → 返回空数组 / 空列表**。于是"读不到"与"没有数据"在返回值上同形：
 *
 * | 那次维护 | 报出的历史缺口 | 与会话消息行数的关系 |
 * | --- | --- | --- |
 * | 事件镜像没加载完 | **934** | = 657 + 277（两个会话的**全部消息行**） |
 * | 镜像已加载 | **749** | = 505 + 244（与 DB 真值逐条相等） |
 *
 * 第 60 轮的修法是"判定前先 `waitForSessionMirrors(sessionIds)` 等就绪"。但那次等的是
 * **批量快照** —— 而第 63 轮给事件镜像补上跨会话预算（对齐消息镜像本来就有的 20000 行）之后，
 * 批量加载**会把先加载完的会话按 LRU 逐出**：头上判为就绪的会话，轮到它读的时候可能已经不在了。
 * 于是同样的假缺口会回来。
 *
 * ## 本文件钉住三条
 *
 * 1. **危险形态取证**（IAE-1）：批量加载之后确实存在"某会话事件读成空、而消息读得到"的会话
 *    —— 那就是假缺口的生成条件（不是数据缺陷）；
 * 2. **有逐出也不许报假缺口**（IAE-2）：同夹具下跑 `auditInvariantsForSessions`，
 *    违规必须为 **0**，并且每个会话要么被**真的检查过**、要么被如实计入
 *    `unreadableSessions`（绝不许"读不到"被折算成缺口）；
 * 3. **对照**（IAE-3）：预算充足（没有逐出）时，三个会话全部被检查、`unreadableSessions` 为 0。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { RustStoragePort } from "../core/storage/rust-port";

vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
}));
vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async () => {},
  appendMessageTombstone: async () => {},
  readSessionMessages: () => [],
}));

const SESSIONS = ["s1", "s2", "s3"] as const;
/** 每个会话 2 条消息 + 2 条与之配对的事件（**一致**的数据：正确的审计应当报 0 违规） */
const MESSAGES_PER_SESSION = 2;

const settle = async () => {
  for (let i = 0; i < 32; i++) await Promise.resolve();
};

function transport() {
  return {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (command === "messages.list") {
        const sid = String(p.session_id ?? "");
        const offset = Number(p.offset ?? 0);
        const limit = Number(p.limit ?? 5000);
        const all = Array.from({ length: MESSAGES_PER_SESSION }, (_, i) => ({
          id: `${sid}-m${i}`,
          session_id: sid,
          role: i === 0 ? "user" : "assistant",
          content: `内容 ${sid} ${i}`,
          timestamp: i + 1,
          hidden: 0,
          trimmed: 0,
        }));
        const items = all.slice(offset, offset + limit);
        return {
          ok: true,
          result: { items, has_more: offset + items.length < all.length, next_cursor: null },
        } as never;
      }
      if (command === "events.list") {
        const sid = String(p.session_id ?? "");
        const from = p.from_seq === undefined ? 0 : Number(p.from_seq);
        const limit = Number(p.limit ?? 5000);
        const all = [
          { seq: 1, session_id: sid, type: "user_message", payload: JSON.stringify({ messageId: `${sid}-m0` }), timestamp: 1 },
          { seq: 2, session_id: sid, type: "assistant_text", payload: JSON.stringify({ messageId: `${sid}-m1` }), timestamp: 2 },
        ];
        const items = all.filter((e) => e.seq >= from).slice(0, limit);
        return {
          ok: true,
          result: { items, has_more: false, next_cursor: null },
        } as never;
      }
      if (command === "messages.count") return { ok: true, result: { total: MESSAGES_PER_SESSION } } as never;
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
      if (command === "attachments.list") return { ok: true, result: { items: [] } } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
}

/**
 * 装一个端口并**模拟维护的批量就绪**（`waitForSessionMirrors` 做的事：
 * 对每个会话触发两侧镜像的加载，然后等它们完成）。
 */
async function installPortAndBulkLoad(opts: {
  messageMirrorBudgetRows?: number;
  eventMirrorBudgetRows?: number;
}) {
  const port = new RustStoragePort(transport() as never, () => {}, opts);
  setStoragePort(port);
  await port.start();
  for (const sid of SESSIONS) {
    port.messages.ensureLoaded(sid);
    port.events.ensureLoaded(sid);
  }
  await settle();
  return port;
}

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("维护的不变量审计 —— 镜像被内存预算逐出之后不许报假缺口", () => {
  it("IAE-1: 【危险形态取证】批量加载后确实存在'事件读成空 + 消息读得到'的会话", async () => {
    // 消息预算给足（20 行），事件预算只够装一个会话（2 行）→ 事件侧必然发生逐出
    const port = await installPortAndBulkLoad({ messageMirrorBudgetRows: 1000, eventMirrorBudgetRows: 2 });

    expect(port.events.stats().evictions, "夹具前提：事件镜像确实发生了逐出").toBeGreaterThan(0);
    const evicted = SESSIONS.find((sid) => !port.events.isLoaded(sid));
    expect(evicted, "夹具前提：至少有一个会话的事件镜像被逐出").toBeTruthy();

    // 这就是假缺口的生成条件：消息读得到（2 条），事件读成空（0 条）——
    // 判据会把每条消息报成 VISIBLE_BUT_NOT_RECORDED（真机那次是 934 = 657 + 277）。
    const MessageStorage = await import("../core/storage/message");
    expect(port.events.readAll(evicted!)).toEqual([]);
    expect(MessageStorage.listMessages(evicted!)).toHaveLength(MESSAGES_PER_SESSION);
  });

  it("IAE-2: 同夹具下审计必须报 0 违规（宁可不检查，也绝不把'读不到'算成缺口）", async () => {
    await installPortAndBulkLoad({ messageMirrorBudgetRows: 1000, eventMirrorBudgetRows: 2 });

    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");
    const res = await auditInvariantsForSessions([...SESSIONS]);

    expect(res.violations, "镜像被逐出不是数据缺口：一条违规都不许报").toBe(0);
    expect(res.structuralErrors).toBe(0);
    expect(
      res.checked + res.unreadableSessions,
      "每个会话要么被真的检查过、要么被如实计入'读不到'（不许两处都不算）",
    ).toBe(SESSIONS.length);
    expect(res.unreadableSessions, "被逐出的会话会重新加载后读完 —— 不该有'读不到'").toBe(0);
    expect(res.checked).toBe(SESSIONS.length);
  });

  it("IAE-3: 【对照】预算充足（没有逐出）⇒ 三个会话全部被检查、0 违规、0 读不到", async () => {
    const port = await installPortAndBulkLoad({ messageMirrorBudgetRows: 1000, eventMirrorBudgetRows: 1000 });

    expect(port.events.stats().evictions, "对照前提：这一场没有逐出").toBe(0);

    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");
    const res = await auditInvariantsForSessions([...SESSIONS]);

    expect(res.checked).toBe(SESSIONS.length);
    expect(res.unreadableSessions).toBe(0);
    expect(res.violations).toBe(0);
  });
});
