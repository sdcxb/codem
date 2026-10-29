/**
 * 删会话必须**连带清掉索引侧**的残留（第 233 轮审计 · P1 隐私 / 幽灵结果）。
 *
 * ## 缺陷形态
 *
 * `deleteSession` 只删 `sessions` 行（外键级联带走 messages / tool_calls / attachments …），
 * 但有两张表**没有**级联也没有触发器：
 *
 * 1. **`session_fts`**（虚拟表，SQLite 对虚拟表不做外键级联）——
 *    唯一能清它的命令是 `fts.delete_session`，而**全仓零生产调用者**（只有一次性重建脚本用
 *    `fts.rebuild_all`，还被 `codem-fts-bigram-rebuilt` 标记挡着只跑一次）。
 *    后果：删掉的会话在全文索引里永久残留 ⇒ 《搜索》命中已删会话，返回
 *    `content=""` / 标题为空的**幽灵结果**，而且被删消息的正文仍留在索引里（隐私残留）。
 * 2. **`delegation_tasks`**（schema 里没有外键、也没有 AFTER DELETE 触发器）——
 *    删掉发起/接收会话后，任务行常驻，「委派」页签继续展示指向已删会话的条目。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | DEL-FTS-1 | 删除成功后必须发 `fts.delete_session`（带该会话 id） |
 * | DEL-FTS-2 | 该命令失败 ⇒ 如实上报（`retryable:false` 的 persist 失败），**不阻断删除** |
 * | DEL-DEL-1 | 删除成功后必须清 `delegation_tasks` 里 source/target 命中该会话的行 |
 *
 * 变异自证：去掉 `deleteSession` 成功分支里的两句清理 ⇒ DEL-FTS-1 / DEL-DEL-1 立刻红。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../core/storage/session-jsonl", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    appendSessionTombstone: vi.fn(async () => {}),
    deleteSessionLog: vi.fn(async () => {}),
  };
});

const persistFailures: Array<{ area: string; error: unknown }> = [];
vi.mock("../core/storage/persist-failure", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reportPersistFailure: (area: string, error: unknown) => {
      persistFailures.push({ area, error });
    },
  };
});

import { setStoragePort, getStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import type { FakeStoragePort } from "./fake-storage-port";
import { deleteSession } from "../core/storage/session";

const SESSION = "sess-del-1";

function port(): FakeStoragePort {
  return getStoragePort() as unknown as FakeStoragePort;
}

beforeEach(() => {
  persistFailures.length = 0;
  setStoragePort(
    createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
        ],
        // 会话的全文索引行（假端口允许直接播种，等价于真库的 session_fts 行）
        session_fts: [
          { session_id: SESSION, message_id: "m-1", content: "被删会话的正文片段" },
        ],
        // 委派任务：一个以它为发起方，一个以它为接收方
        delegation_tasks: [
          { id: "d-1", source_session_id: SESSION, target_session_id: "other-1", status: "done" },
          { id: "d-2", source_session_id: "other-2", target_session_id: SESSION, status: "done" },
          { id: "d-3", source_session_id: "other-3", target_session_id: "other-4", status: "done" },
        ],
      } as Record<string, Array<Record<string, unknown>>>,
    }),
  );
});

describe("删会话：索引侧残留", () => {
  it("DEL-FTS-1: 删除成功后必须发 fts.delete_session（带会话 id）", () => {
    deleteSession(SESSION, { confirmBulk: true });
    const calls = port()
      .__writes()
      .filter((w) => w.command === "fts.delete_session");
    expect(calls.length, "删会话必须清全文索引（否则搜索命中已删会话）").toBeGreaterThan(0);
    expect(calls[0].params?.session_id ?? calls[0].params?.sessionId).toBe(SESSION);
  });

  it("DEL-FTS-2: 清索引失败 ⇒ 如实上报，且删除本身仍然成功", () => {
    const p = port();
    const orig = p.data.execute.bind(p.data);
    // 让 fts.delete_session 失败（模拟引擎侧拒绝/未实现）
    (p.data as unknown as { execute: (c: string, params?: unknown) => unknown }).execute = ((cmd: string, params?: unknown) => {
      if (cmd === "fts.delete_session") return Promise.reject(new Error("引擎侧不可用（模拟）"));
      return orig(cmd as never, params as never);
    }) as never;

    deleteSession(SESSION, { confirmBulk: true });

    // 删除照常完成
    expect(p.__table("sessions").some((r) => String(r.id) === SESSION)).toBe(false);
    // 但失败必须可见（不能静默）
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(
          persistFailures.some((f) => String(f.area).includes("fts")),
          "索引没清掉必须上报（否则用户永远不知道搜索结果里有已删会话）",
        ).toBe(true);
        resolve();
      }, 20);
    });
  });

  it("DEL-DEL-1: 删除成功后清掉 delegation_tasks 里 source/target 命中该会话的行", () => {
    deleteSession(SESSION, { confirmBulk: true });
    const rows = port().__table("delegation_tasks");
    const left = rows.filter(
      (r) => String(r.source_session_id) === SESSION || String(r.target_session_id) === SESSION,
    );
    expect(left.map((r) => r.id), "指向已删会话的委派任务必须一起清掉").toEqual([]);
    // 反向对照：与这个会话无关的任务不许被误删
    expect(rows.map((r) => r.id)).toContain("d-3");
  });
});
