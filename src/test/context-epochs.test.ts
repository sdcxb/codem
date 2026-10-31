import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { epochRowsFromTimeline, syncContextEpochs, listContextEpochs } from "../core/storage/context-epochs";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";

const S = "s-epochs";

describe("context_epochs 投影", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({
      seed: { sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }] },
    }));
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("CE-1: 从 marker metadata 抽出 epoch；旧 marker 没有 metadata 跳过", () => {
    const rows = epochRowsFromTimeline("s1", [
      { id: "old", role: "user", content: "x", timestamp: 1, status: "done" },
      {
        id: "compact-100-1",
        role: "user",
        content: "summary",
        timestamp: 2,
        status: "done",
        metadata: JSON.stringify({
          contextEpoch: {
            epochId: "compact-100-1",
            seq: 1,
            cutoffMessageId: "m3",
            removedCount: 2,
            keptCount: 3,
            trigger: "auto",
            createdAt: 100,
          },
        }),
      },
    ] as never);
    expect(rows).toEqual([{
      id: "compact-100-1",
      session_id: "s1",
      seq: 1,
      cutoff_message_id: "m3",
      removed_count: 2,
      kept_count: 3,
      trigger_kind: "auto",
      created_at: 100,
    }]);
  });

  it("CE-2: metadata 是对象同样可读", () => {
    const rows = epochRowsFromTimeline("s1", [{
      id: "compact-100-1",
      role: "user",
      content: "summary",
      timestamp: 2,
      status: "done",
      metadata: { contextEpoch: { epochId: "compact-100-1", cutoffMessageId: "m3" } },
    }] as never);
    expect(rows[0].cutoff_message_id).toBe("m3");
    expect(rows[0].seq).toBe(0);
  });

  it("CE-3: sync 后能从表里按最新在前读回（命令 this 绑定）", async () => {
    const timeline = [{
      id: "compact-100-1",
      role: "user",
      content: "summary",
      timestamp: 2,
      status: "done",
      metadata: { contextEpoch: { epochId: "compact-100-1", seq: 1, cutoffMessageId: "m3", createdAt: 100 } },
    }, {
      id: "compact-200-2",
      role: "user",
      content: "summary2",
      timestamp: 3,
      status: "done",
      metadata: { contextEpoch: { epochId: "compact-200-2", seq: 2, cutoffMessageId: "m9", createdAt: 200 } },
    }] as never;
    await syncContextEpochs(S, timeline);
    const rows = await listContextEpochs(S);
    expect(rows.map((r) => r.id)).toEqual(["compact-200-2", "compact-100-1"]);
  });
});
