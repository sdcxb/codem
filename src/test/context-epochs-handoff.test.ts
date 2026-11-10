/**
 * P0-0（D1/E2）：switch 的 handoff 摘要**从真实换段路径落进派生索引**。
 *
 * ## 为什么单点投影用例不够
 *
 * `context-epochs.test.ts` 直接构造 timeline 数组，它证明的是「给定一条 switch marker，
 * 投影会算 handoff_json」；但契约要求的是「真实 switch 之后，索引里能查到这份 handoff」。
 * 这中间有两处会断：
 * 1. `performSegmentSwitch` 写的 marker 正文/元数据变了，投影取不到正文；
 * 2. 适配层的写入列漏了 handoff_json（`syncContextEpochs` 写了，落库却丢了）。
 *
 * 本文件从 `performSegmentSwitch` 进，读回 `context_epochs.list`，两条一起钉住。
 *
 * ## 口径
 *
 * - `context_epochs` 是**派生索引**：switch 写的是权威 marker；索引在投影（本用例显式
 *   `syncContextEpochs`，真机是打开完整历史/审计时）后才有行 —— 契约不要求换段同步写库；
 * - `handoff_json` 是 marker 正文的**有界副本**（≤8KB），不是第二套摘要；
 * - 旧行没有这一格 ⇒ null（CE-11 已钉）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { createMessage, listTimelineMessages } from "../core/storage/message";
import { performSegmentSwitch } from "../core/storage/context-switch";
import { listContextEpochs, syncContextEpochs } from "../core/storage/context-epochs";

const S = "s-epoch-handoff";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  /* 没有 Tauri 文件层时 JSONL 会走 PersistFailure（console.error）；这里只静音，不影响断言 */
  vi.spyOn(console, "error").mockImplementation(() => {});
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

function seedHistory(count: number): void {
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `m-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `第 ${i} 条历史：迁移脚本与验收记录`,
        timestamp: 1_000 + i,
        status: "done",
      },
      S,
    );
  }
}

describe("switch → context_epochs.handoff_json", () => {
  it("CE-12: 真实 performSegmentSwitch 后投影，handoff_json 含 marker 正文且可解析", async () => {
    seedHistory(30);

    const switched = performSegmentSwitch(S, { keepCount: 20, now: 9_999 });
    expect(switched.switched).toBe(true);
    expect(switched.epochId).toBeTruthy();

    const timeline = listTimelineMessages(S);
    await syncContextEpochs(S, timeline);
    const rows = await listContextEpochs(S);
    const switchRow = rows.find((row) => row.kind === "switch");
    expect(switchRow, "switch 行必须进派生索引").toBeTruthy();
    expect(switchRow!.id).toBe(switched.epochId);
    expect(switchRow!.segment_seq).toBe(switched.segmentSeq);

    expect(typeof switchRow!.handoff_json, "switch 行必须有 handoff_json").toBe("string");
    const payload = JSON.parse(switchRow!.handoff_json!);
    expect(payload.ref).toBe(switched.epochId);
    expect(payload.segmentSeq).toBe(switched.segmentSeq);
    expect(payload.summary).toContain("段切换 handoff");
    expect(payload.summary.length).toBeGreaterThan(0);
    expect(payload.truncated).toBe(false);
  });

  it("CE-13: compact 标记不进 handoff_json（可空列不是「所有 epoch 都塞一份」）", async () => {
    seedHistory(5);
    /* 手动造一条旧 compact marker（与生产 marker 同前缀，避免被当成 switch） */
    createMessage(
      {
        id: "compact-1-1",
        role: "user",
        content: "[上下文已自动压缩] 旧摘要",
        timestamp: 2_000,
        status: "done",
        metadata: {
          contextEpoch: {
            epochId: "compact-1-1",
            seq: 1,
            cutoffMessageId: "m-3",
            removedCount: 2,
            keptCount: 3,
            trigger: "auto",
            kind: "compact",
            segmentSeq: 1,
            createdAt: 2_000,
          },
        },
      },
      S,
    );

    await syncContextEpochs(S, listTimelineMessages(S));
    const rows = await listContextEpochs(S);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("compact");
    expect(rows[0].handoff_json).toBeNull();
  });
});
