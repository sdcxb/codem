import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { epochRowsFromTimeline, syncContextEpochs, listContextEpochs } from "../core/storage/context-epochs";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { COMPACTION_MARKER_READ_HINT, composeCompactionMarkerText } from "../core/llm/compaction-budget";

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
      /* P0-0：旧 marker 没有 kind/segmentSeq ⇒ 投影按同一份归一补 compact / 1 */
      kind: "compact",
      segment_seq: 1,
      /* P0-0：compact 不写 handoff_json（可空列） */
      handoff_json: null,
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

  it("CE-4: 坏 metadata/缺 cutoff 不写半截；负数/NaN 归零", () => {
    const rows = epochRowsFromTimeline("s1", [
      { id: "bad-json", metadata: "{not json" },
      { id: "no-cutoff", metadata: { contextEpoch: { epochId: "e1" } } },
      {
        id: "negative",
        metadata: { contextEpoch: { epochId: "e2", cutoffMessageId: "m2", seq: -5, removedCount: Number.NaN } },
      },
    ] as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "e2", seq: 0, removed_count: 0 });
  });

  it("CE-3: sync 后能从表里按最新在前读回（命令 this 绑定 + 新字段往返）", async () => {
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
      metadata: {
        contextEpoch: {
          epochId: "compact-200-2", seq: 2, cutoffMessageId: "m9", createdAt: 200,
          kind: "switch", segmentSeq: 3,
        },
      },
    }] as never;
    await syncContextEpochs(S, timeline);
    const rows = await listContextEpochs(S);
    expect(rows.map((r) => r.id)).toEqual(["compact-200-2", "compact-100-1"]);
    /* P0-0：新字段必须真的经过 TS 适配层落库再读回（漏字段 = 面板/审计看到假的 compact/1） */
    expect(rows[0]).toMatchObject({ kind: "switch", segment_seq: 3 });
    expect(rows[1]).toMatchObject({ kind: "compact", segment_seq: 1 });
  });

  /**
   * CE-8（P0 重启缺陷）：派生索引的新旧也由 **`created_at`** 决定 —— 与真引擎
   * `repo.rs::context_epochs_list` 的 SQL（`created_at DESC, seq DESC`）同口径。
   *
   * 被守的形态：重启后计数器归零，新 epoch 的 `seq=1` 比老会话的 `seq=9` 小；
   * 按 `seq DESC` 排会把老检查点摆在完整历史面板的第一行（"最新检查点"读错）。
   *
   * 变红方式：把 `repo.rs` 的 SQL 或测试双 `fake-storage-port` 的同口径排序改回
   * `seq` 优先 ⇒ 本条红。
   */
  it("CE-8: 重启后新 epoch 的 seq 更小但 created_at 更新 ⇒ 仍排在最新", async () => {
    const timeline = [{
      id: "compact-100-9",
      role: "user",
      content: "old",
      timestamp: 100,
      status: "done",
      metadata: { contextEpoch: { epochId: "compact-100-9", seq: 9, cutoffMessageId: "m2", createdAt: 100 } },
    }, {
      id: "compact-200-1",
      role: "user",
      content: "new",
      timestamp: 200,
      status: "done",
      metadata: { contextEpoch: { epochId: "compact-200-1", seq: 1, cutoffMessageId: "m6", createdAt: 200 } },
    }] as never;
    await syncContextEpochs(S, timeline);
    const rows = await listContextEpochs(S);
    expect(
      rows.map((r) => r.id),
      "created_at 更新的必须排最前（seq 小不算旧）",
    ).toEqual(["compact-200-1", "compact-100-9"]);
  });

  it("CE-5: 派生表命令失败不抛给 UI（读回空，主链路不受影响）", async () => {
    setStoragePort(createFakeStoragePort({
      failCommands: ["context_epochs.list"],
      seed: { sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }] },
    }));
    await expect(listContextEpochs(S)).resolves.toEqual([]);
  });

  it("CE-6: switch epoch 投影出 kind=switch + 段号；非法值按同一份归一降级", () => {
    const rows = epochRowsFromTimeline("s1", [
      {
        id: "compact-100-1",
        metadata: { contextEpoch: { epochId: "e1", cutoffMessageId: "m3", kind: "switch", segmentSeq: 4 } },
      },
      {
        id: "compact-200-2",
        metadata: { contextEpoch: { epochId: "e2", cutoffMessageId: "m4", kind: "bogus", segmentSeq: 0 } },
      },
      {
        id: "compact-300-3",
        metadata: { contextEpoch: { epochId: "e3", cutoffMessageId: "m5", kind: "switch", segmentSeq: -2 } },
      },
    ] as never);
    expect(rows[0]).toMatchObject({ kind: "switch", segment_seq: 4 });
    expect(rows[1], "未知 kind 猜成 compact，段号 0 归 1").toMatchObject({ kind: "compact", segment_seq: 1 });
    expect(rows[2], "负段号也归 1，但 switch 语义保留").toMatchObject({ kind: "switch", segment_seq: 1 });
  });

  /**
   * P0-0（D1/E2）：`handoff_json` 的可空契约与「switch 才写」。
   *
   * 变红方式：把 `handoff_json` 从行类型/写入里删掉 ⇒ switch 行读回 null；
   * 给 compact 也塞 JSON ⇒ 第二条断言红。
   */
  it("CE-9: switch 行带可解析的 handoff_json；compact 行保持 null", () => {
    const rows = epochRowsFromTimeline("s1", [
      {
        id: "sw-1",
        content: "[段切换 handoff] segment 2\n\n## 目标\n把迁移做完",
        metadata: { contextEpoch: { epochId: "sw-1", cutoffMessageId: "m3", kind: "switch", segmentSeq: 2, createdAt: 5 } },
      },
      {
        id: "cp-1",
        content: "[上下文已自动压缩] 摘要",
        metadata: { contextEpoch: { epochId: "cp-1", cutoffMessageId: "m2", kind: "compact", segmentSeq: 1, createdAt: 4 } },
      },
    ] as never);

    expect(rows[1].handoff_json, "compact 行不许有 handoff").toBeNull();
    expect(typeof rows[0].handoff_json).toBe("string");
    const payload = JSON.parse(rows[0].handoff_json!);
    expect(payload).toMatchObject({ v: 1, ref: "sw-1", segmentSeq: 2, truncated: false });
    expect(payload.summary).toContain("把迁移做完");
    expect(payload.originalChars).toBe("[段切换 handoff] segment 2\n\n## 目标\n把迁移做完".length);
  });

  /**
   * P0-0：8 KB 硬上限 —— 超限必须**可解析地截断并标注**，不许静默丢内容或写出坏 JSON。
   *
   * 变红方式：去掉长度上限 ⇒ `json.length` 超 8192；截断后不写 truncated/originalChars
   * ⇒ 第二条断言红；先截断再判断导致 JSON 被切一半 ⇒ `JSON.parse` 抛错。
   */
  it("CE-10: handoff_json 超 8KB ⇒ 截断且标注（仍是合法 JSON）", () => {
    const long = "交接正文".repeat(4000); // 16000 字符
    const rows = epochRowsFromTimeline("s1", [{
      id: "sw-long",
      content: long,
      metadata: { contextEpoch: { epochId: "sw-long", cutoffMessageId: "m3", kind: "switch", segmentSeq: 2, createdAt: 5 } },
    }] as never);

    const json = rows[0].handoff_json!;
    expect(json.length, "落库的 JSON 必须 ≤ 8KB（字符口径）").toBeLessThanOrEqual(8 * 1024);
    const payload = JSON.parse(json);
    expect(payload.truncated, "超限必须标注").toBe(true);
    expect(payload.originalChars).toBe(long.length);
    expect(payload.summary.length).toBeLessThan(long.length);
    expect(long.startsWith(payload.summary), "截断必须是前缀，不许掐中段").toBe(true);
  });

  /**
   * P0-0：旧行兼容 —— 库里已有的行没有 `handoff_json` 字段时，适配层归一成 null；
   * 读侧不许因为 `undefined` 抛错，也不许把旧 compact 行误读成 switch。
   */
  it("CE-11: 旧行没有 handoff_json 字段 ⇒ 读回 null（不抛错）", async () => {
    setStoragePort(createFakeStoragePort({
      seed: {
        sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }],
        context_epochs: [{
          id: "old-row", session_id: S, seq: 1, cutoff_message_id: "m2",
          removed_count: 1, kept_count: 2, trigger_kind: "auto",
          kind: "compact", segment_seq: 1, created_at: 10,
        }],
      },
    }));
    const rows = await listContextEpochs(S);
    expect(rows).toHaveLength(1);
    expect(rows[0].handoff_json).toBeNull();
  });
});

/**
 * P0：压缩 marker 的**尾部回读提示**（易变尾部，不动稳定前缀）。
 *
 * 为什么要判据：marker 前缀被解析器（`COMPACTION_MARKER_PREFIXES`）、折叠逻辑与
 * 既有快照依赖 —— 改前缀等于改协议。追加一行只影响尾部；这条同时钉住"前缀不变"
 * 与"提示真的在最后"，防止后来者把提示插到段中或改写第一行。
 */
describe("P0：压缩 marker 尾部回读提示", () => {
  it("CE-7: 自动压缩 marker 以稳定前缀开头、以回读提示结尾", () => {
    const text = composeCompactionMarkerText({
      summary: "",
      middleDigest: "- 确定性要点：用户要求不要 force push",
      removedCount: 30,
      keptCount: 8,
      summarizedCount: 30,
    });
    expect(text.startsWith("[上下文已自动压缩]"), "稳定前缀不许动").toBe(true);
    expect(text.endsWith(COMPACTION_MARKER_READ_HINT), "提示必须在易变尾部").toBe(true);
    expect(text, "要写出回读工具名与「不会删除」").toContain("thread_history_read");
    expect(text).toContain("不会删除");
  });
});
