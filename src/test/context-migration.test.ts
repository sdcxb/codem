/**
 * 旧压缩历史回填：幂等、dry-run、失败不伪造成功。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const durable: Array<{ id: string }> = [];
const appendCalls: Array<{ id: string; hidden?: number }> = [];

vi.mock("../core/storage/session-jsonl", () => ({
  readSessionMessages: async () => ({ messages: durable, skippedLines: 0, tornTailLines: 0, salvagedLines: 0 }),
  appendSessionMessage: async (_sessionId: string, message: { id: string; hidden?: number }) => {
    appendCalls.push({ id: message.id, hidden: message.hidden });
    durable.push({ id: message.id });
  },
  flushSessionLogWrites: async () => {},
}));

import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage, updateMessage } from "../core/storage/message";
import { migrateSessionLegacyHistory } from "../core/storage/context-migration";

const S = "sess-context-migration";

describe("migrateSessionLegacyHistory", () => {
  beforeEach(() => {
    durable.length = 0;
    appendCalls.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({
      seed: {
        sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    }));
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("MIG-1: 旧 hidden 行以正常记录回填，且回读校验通过", async () => {
    createMessage({ id: "old", role: "user", content: "旧压缩消息", timestamp: 1, status: "done" }, S);
    updateMessage("old", { hidden: 1 } as never);
    appendCalls.length = 0;
    durable.length = 0; // 旧版本的权威日志里只有墓碑，没有正常记录

    const report = await migrateSessionLegacyHistory(S);
    expect(report.hiddenRows).toBe(1);
    expect(report.appended).toBe(1);
    expect(report.failed).toBe(0);
    expect(appendCalls.map((x) => x.id)).toEqual(["old"]);
    expect(appendCalls[0].hidden, "重建后仍必须是 hidden，不能把旧压缩放回模型").toBe(1);
  });

  it("MIG-2: 幂等 —— 日志已有同 id 时跳过", async () => {
    createMessage({ id: "old", role: "user", content: "旧压缩消息", timestamp: 1, status: "done" }, S);
    updateMessage("old", { hidden: 1 } as never);
    durable.push({ id: "old" });
    appendCalls.length = 0;

    const report = await migrateSessionLegacyHistory(S);
    expect(report.hiddenRows).toBe(1);
    expect(report.alreadyDurable).toBe(1);
    expect(report.appended).toBe(0);
    expect(appendCalls).toHaveLength(0);
  });

  it("MIG-3: dry-run 不写日志", async () => {
    createMessage({ id: "old", role: "user", content: "旧压缩消息", timestamp: 1, status: "done" }, S);
    updateMessage("old", { hidden: 1 } as never);
    appendCalls.length = 0;
    durable.length = 0;

    const report = await migrateSessionLegacyHistory(S, { dryRun: true });
    expect(report.hiddenRows).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(appendCalls).toHaveLength(0);
  });
});
