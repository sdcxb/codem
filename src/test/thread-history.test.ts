/**
 * P0-2：Thread History（`thread_history_search` / `thread_history_read` / `thread_segment_list`）。
 *
 * ## 被守的缺陷（24 §8 / 25 §6 P0-2）
 *
 * 压缩/换段之后模型视图只剩最新一段，旧段事实还在时间线里但**没有回读入口**。
 * 这一组判据钉住：
 *
 * 1. 分段规则 = `switch` 换段、`compact` 不换段（旧数据恒 1 段）；
 * 2. 检索读的是**完整时间线**（能搜到换段前的原话），且带上段号；
 * 3. 按 id 回读给的是原文 + 邻域（不是摘要）；
 * 4. 找不到时**如实说找不到**，不伪装成"没有历史"；
 * 5. 三个工具都是只读契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage } from "../core/storage/message";
import { buildContextEpochMetadata, readContextEpochOf } from "../core/context/context-view";
import { readThreadHistory, searchThreadHistory, segmentsOf } from "../core/context/thread-history";
import {
  createThreadHistoryReadTool,
  createThreadHistorySearchTool,
  createThreadSegmentListTool,
} from "../core/llm/tools/thread-history";

const S = "sess-thread-history";

type M = { id: string; role?: string; content?: unknown; timestamp?: number; metadata?: Record<string, unknown> | null };

const readEpoch = (m: M) => readContextEpochOf(m as never);

function marker(id: string, kind: "compact" | "switch", cutoff: string, seq: number, ts: number): M {
  return {
    id,
    role: "user",
    content: kind === "switch" ? "[已切换到新段]" : "[上下文已自动压缩]",
    timestamp: ts,
    metadata: buildContextEpochMetadata({
      epochId: id,
      cutoffMessageId: cutoff,
      createdAt: 100 * seq,
      removedCount: 1,
      keptCount: 1,
      trigger: kind === "switch" ? "switch" : "auto",
      kind,
      segmentSeq: seq,
    }) ?? undefined,
  };
}

function ctx(sessionId: string = S) {
  return { sessionId, messageId: "m", cwd: "C:\\repo", abort: new AbortController().signal, messages: [], metadata: () => {} } as never;
}

/** m1 · switch · m2 · compact · m3 */
function fixture(): M[] {
  return [
    { id: "m1", role: "user", content: "第一段里说过的重要事实", timestamp: 1 },
    marker("compact-switch-2", "switch", "m2", 2, 2),
    { id: "m2", role: "assistant", content: "第二段开头", timestamp: 3 },
    marker("compact-400-3", "compact", "m3", 3, 4),
    { id: "m3", role: "user", content: "第二段末", timestamp: 5 },
  ];
}

describe("thread history — 分段与检索（纯函数）", () => {
  it("TH-1: switch 换段、compact 不换段；旧数据只有 1 段", () => {
    const segs = segmentsOf(fixture(), readEpoch);
    expect(segs.map((s) => s.segmentSeq)).toEqual([1, 2]);
    expect(segs[0], "第一段只有 m1").toMatchObject({ startIndex: 0, endIndex: 0, messageCount: 1 });
    expect(segs[1], "第二段从 switch marker 起").toMatchObject({ startIndex: 1, endIndex: 4, messageCount: 4 });
    expect(segs[1].epochs.map((e) => e.kind), "compact 留在同一段里").toEqual(["switch", "compact"]);

    const legacy: M[] = [{ id: "a", content: "x", timestamp: 1 }, { id: "b", content: "y", timestamp: 2 }];
    expect(segmentsOf(legacy, readEpoch)).toHaveLength(1);
  });

  it("TH-2: 检索能命中换段前的原话，并带上段号", () => {
    const hits = searchThreadHistory(fixture(), "重要事实", 10, readEpoch);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "m1", segmentSeq: 1 });
    expect(hits[0].snippet).toContain("重要事实");

    /* compact 不换段：它在第 2 段里，命中仍必须报 segment 2（不是 3） */
    const late = searchThreadHistory(fixture(), "第二段末", 10, readEpoch);
    expect(late).toHaveLength(1);
    expect(late[0].segmentSeq, "compact 不换段").toBe(2);
  });

  it("TH-3: limit 有界；空查询不返回任何结果", () => {
    const many: M[] = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, content: "命中 命中", timestamp: i }));
    expect(searchThreadHistory(many, "命中", 5, readEpoch)).toHaveLength(5);
    expect(searchThreadHistory(many, "   ", 5, readEpoch)).toHaveLength(0);
  });

  it("TH-4: 按 id 回读给原文 + 邻域 + 段号", () => {
    const win = readThreadHistory(fixture(), "m2", 1, 1, readEpoch);
    expect(win).not.toBeNull();
    expect(win!.segmentSeq).toBe(2);
    expect(win!.messages.map((m) => m.id)).toEqual(["compact-switch-2", "m2", "compact-400-3"]);
    expect(readThreadHistory(fixture(), "no-such-id", 1, 1, readEpoch)).toBeNull();
  });
});

describe("thread history — 工具层", () => {
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

  function seedSession() {
    createMessage({ id: "m1", role: "user", content: "第一段里说过的重要事实", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 2,
      status: "done",
      metadata: marker("compact-switch-2", "switch", "m2", 2, 2).metadata,
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "第二段开头", timestamp: 3, status: "done" }, S);
    createMessage({
      id: "compact-400-3",
      role: "user",
      content: "[上下文已自动压缩]",
      timestamp: 4,
      status: "done",
      metadata: marker("compact-400-3", "compact", "m3", 3, 4).metadata,
    }, S);
    createMessage({ id: "m3", role: "user", content: "第二段末", timestamp: 5, status: "done" }, S);
  }

  it("TH-5: search 工具能搜到换段前原话并给出 id / 段号", async () => {
    seedSession();
    const res = await createThreadHistorySearchTool().execute({ query: "重要事实" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("m1");
    expect(res.output).toContain("segment 1");
    expect(res.output).toContain("thread_history_read");
  });

  it("TH-6: read 工具给原文与邻域；不存在的 id 如实报错", async () => {
    seedSession();
    const tool = createThreadHistoryReadTool();
    const ok = await tool.execute({ id: "m2" }, ctx());
    expect(ok.isError).toBe(false);
    expect(ok.output).toContain("第二段开头");
    expect(ok.output).toContain("第一段里说过的重要事实");

    const bad = await tool.execute({ id: "nope" }, ctx());
    expect(bad.isError).toBe(true);
    expect(bad.output).toMatch(/not in this conversation/i);
  });

  it("TH-7: segment_list 列出两段与两种 epoch", async () => {
    seedSession();
    const res = await createThreadSegmentListTool().execute({}, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("2 segment(s)");
    expect(res.output).toContain("switch");
    expect(res.output).toContain("compact");
    expect(res.output).toContain("cutoff=m2");
  });

  it("TH-8: 三个工具都声明只读契约，且已在注册表里", () => {
    for (const tool of [createThreadHistorySearchTool(), createThreadHistoryReadTool(), createThreadSegmentListTool()]) {
      expect(tool.contract?.readOnly, `${tool.id} 必须只读`).toBe(true);
    }
    const src = readFileSync(join(process.cwd(), "src/core/llm/tools.ts"), "utf8");
    expect(src).toContain("createThreadHistoryTools()");
  });
});
