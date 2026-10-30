/**
 * 回滚迁移：cutoff 之前的消息写回 hidden，旧版本可见视图 = 压缩后上下文。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage, listTimelineMessages } from "../core/storage/message";
import { buildContextEpochMetadata } from "../core/context/context-view";
import { rollbackSessionToClassicHidden } from "../core/storage/context-rollback";

const S = "sess-context-rollback";

function seedTimeline() {
  createMessage({ id: "m1", role: "user", content: "第一轮", timestamp: 1, status: "done" }, S);
  createMessage({ id: "m2", role: "assistant", content: "第一轮回答", timestamp: 2, status: "done" }, S);
  createMessage({ id: "m3", role: "user", content: "第二轮", timestamp: 3, status: "done" }, S);
  createMessage({
    id: "compact-100-1",
    role: "user",
    content: "[上下文已自动压缩]\n摘要",
    timestamp: 4,
    status: "done",
    metadata: buildContextEpochMetadata({
      epochId: "compact-100-1",
      cutoffMessageId: "m3",
      createdAt: 100,
      removedCount: 2,
      keptCount: 1,
      trigger: "auto",
    }) ?? undefined,
  }, S);
}

describe("rollbackSessionToClassicHidden", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({
      seed: {
        sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
      },
    }));
    seedTimeline();
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("RB-1: dry-run 只统计 cutoff 之前的消息", async () => {
    const report = await rollbackSessionToClassicHidden(S, { dryRun: true });
    expect(report.epochId).toBe("compact-100-1");
    expect(report.cutoffMessageId).toBe("m3");
    expect(report.candidates).toBe(2);
    expect(report.hidden).toBe(0);
  });

  it("RB-2: apply 后 cutoff 之前的消息 hidden=1，marker 与 cutoff 之后保持可见", async () => {
    const report = await rollbackSessionToClassicHidden(S);
    expect(report.hidden).toBe(2);
    const timeline = listTimelineMessages(S);
    const hiddenIds = timeline
      .filter((m) => Number((m as unknown as { hidden?: number }).hidden ?? 0) === 1)
      .map((m) => m.id);
    expect(hiddenIds.sort()).toEqual(["m1", "m2"]);
    expect(timeline.find((m) => m.id === "compact-100-1")).toBeTruthy();
    expect(timeline.find((m) => m.id === "m3")).toBeTruthy();
  });
});
