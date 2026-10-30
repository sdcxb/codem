/**
 * 完整时间线 vs 模型视图（G0 第 3 步）。
 *
 * 必须分开：
 * - `listMessages` = 模型可见集合（cutoff + 旧 hidden 过滤）；
 * - `listTimelineMessages` = 完整时间线（含旧压缩 hidden / trimmed，不应用 cutoff）。
 *
 * 这里用假端口只测索引镜像路径：旧压缩行在索引里 hidden=1，模型视图看不到，
 * 但完整时间线必须还能读到。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import {
  createMessage,
  deleteMessage,
  listMessages,
  listTimelineMessages,
  updateMessage,
} from "../core/storage/message";
import { buildContextEpochMetadata } from "../core/context/context-view";
import { needsLegacyBackfill } from "../core/storage/context-history";

const S = "sess-context-timeline";

describe("listTimelineMessages — 完整历史不被 cutoff/hidden 抹掉", () => {
  beforeEach(() => {
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

  it("TL-1: 旧压缩 hidden 行在模型视图不可见，但在完整时间线可见", () => {
    createMessage({ id: "m-old", role: "user", content: "被压缩的旧消息", timestamp: 1, status: "done" }, S);
    createMessage({ id: "m-new", role: "assistant", content: "新消息", timestamp: 2, status: "done" }, S);
    updateMessage("m-old", { hidden: 1 } as never);

    const model = listMessages(S).map((m) => m.id);
    const timeline = listTimelineMessages(S).map((m) => m.id);
    expect(model, "模型视图排除 hidden").not.toContain("m-old");
    expect(model).toContain("m-new");
    expect(timeline, "完整时间线必须保留旧消息").toContain("m-old");
    expect(timeline).toContain("m-new");
  });

  it("TL-2: 有检查点时，cutoff 之前的历史只在完整时间线里", () => {
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

    const model = listMessages(S).map((m) => m.id);
    const timeline = listTimelineMessages(S).map((m) => m.id);
    expect(model).toEqual(["compact-100-1", "m3"]);
    expect(timeline, "压缩前的提问/回答仍在完整时间线里").toEqual(["m1", "m2", "m3", "compact-100-1"]);
  });

  it("TL-3: 用户主动删除的消息不进完整时间线（只有压缩不删）", () => {
    createMessage({ id: "keep", role: "user", content: "保留", timestamp: 1, status: "done" }, S);
    createMessage({ id: "gone", role: "assistant", content: "用户删掉", timestamp: 2, status: "done" }, S);
    deleteMessage("gone");

    const timeline = listTimelineMessages(S).map((m) => m.id);
    expect(timeline).toContain("keep");
    expect(timeline, "用户删除是唯一允许的破坏性路径").not.toContain("gone");
  });

  it("TL-4: 只有 hidden=1 且 trimmed≠1 才算需要自动回填", () => {
    expect(needsLegacyBackfill([{ id: "a", hidden: 1 }] as never)).toBe(true);
    expect(needsLegacyBackfill([{ id: "a", hidden: 1, trimmed: 1 }] as never)).toBe(false);
    expect(needsLegacyBackfill([{ id: "a" }] as never)).toBe(false);
  });
});
