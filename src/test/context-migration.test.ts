/**
 * 旧压缩历史回填：幂等、dry-run、失败不伪造成功。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const durable: Array<{ id: string }> = [];
const appendCalls: Array<{ id: string; hidden?: number }> = [];
let readFailure: Error | null = null;
let appendFailure: Error | null = null;

vi.mock("../core/storage/session-jsonl", () => ({
  readSessionMessages: async () => {
    if (readFailure) throw readFailure;
    return { messages: durable, skippedLines: 0, tornTailLines: 0, salvagedLines: 0 };
  },
  appendSessionMessage: async (_sessionId: string, message: { id: string; hidden?: number }) => {
    if (appendFailure) throw appendFailure;
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
    readFailure = null;
    appendFailure = null;
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

  it("MIG-4: 日志读失败/回读失败 ⇒ 不伪造 appended，全部记 failed", async () => {
    createMessage({ id: "old", role: "user", content: "旧压缩消息", timestamp: 1, status: "done" }, S);
    updateMessage("old", { hidden: 1 } as never);
    appendCalls.length = 0;
    durable.length = 0;
    readFailure = new Error("E_IO");
    const report = await migrateSessionLegacyHistory(S);
    expect(report.failed).toBe(1);
    expect(report.appended).toBe(0);
  });

  it("MIG-5: 追加写失败 ⇒ failed 计数，不声称已回填", async () => {
    createMessage({ id: "old", role: "user", content: "旧压缩消息", timestamp: 1, status: "done" }, S);
    updateMessage("old", { hidden: 1 } as never);
    appendCalls.length = 0;
    durable.length = 0;
    appendFailure = new Error("disk full");
    const report = await migrateSessionLegacyHistory(S);
    expect(report.appended).toBe(0);
    expect(report.failed).toBe(1);
  });

  it("MIG-6: trimmed=1 是索引裁剪，不是旧压缩，不回填", async () => {
    createMessage({ id: "trimmed", role: "user", content: "索引裁剪", timestamp: 1, status: "done" }, S);
    updateMessage("trimmed", { hidden: 1, trimmed: 1 } as never);
    appendCalls.length = 0;
    durable.length = 0;
    const report = await migrateSessionLegacyHistory(S);
    expect(report.hiddenRows).toBe(0);
    expect(appendCalls).toHaveLength(0);
  });

  it("MIG-7: 没有旧 hidden ⇒ 零动作", async () => {
    createMessage({ id: "normal", role: "user", content: "正常", timestamp: 1, status: "done" }, S);
    const report = await migrateSessionLegacyHistory(S);
    expect(report).toMatchObject({ hiddenRows: 0, appended: 0, failed: 0 });
  });
});
