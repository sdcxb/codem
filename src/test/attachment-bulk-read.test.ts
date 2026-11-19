/**
 * ATT-BULK：读一个会话的消息列表时，附件**只许读一次**（第 5 轮真实缺陷）。
 *
 * ## 现场
 *
 * `listMessagesFromIndex` 原来对**每条消息**调 `attachmentsFromMirror(id)`，
 * 而那是 `domainReadMany(ATTACHMENT_TABLE, …, { message_id })` → 端口的
 * `domains.find()` 实现是「整表复制 + 全量过滤」（`rust-port` 的 `all()` = `[...list]`）。
 * 于是读 M 条消息 = M 次整表复制：M=500 / A=2000 时单次开会话就是百万级行复制，
 * 而且开会话要好几次（列表 + 上下文历史 + 每 3s 水位轮询）。
 *
 * ## 判据
 *
 * - 端口接手时（routed），读 N 条消息只调用 **1** 次 domain 读；
 * - 附件仍然挂到正确的消息上（按 message_id 分桶，组内 added_at 升序）；
 * - 端口未接手时返回空列表（不碰旧库，保持既有语义）。
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const domainReadMany = vi.fn();

vi.mock("../core/storage/domain-store", async () => {
  const actual = await vi.importActual<typeof import("../core/storage/domain-store")>("../core/storage/domain-store");
  return {
    ...actual,
    domainReadMany: (...args: unknown[]) => domainReadMany(...args),
  };
});

/* 端口接手：把 storage port 换成一个最小消息镜像（listMessagesFromIndex 走 routed 分支） */
const mirrorRows = [
  { id: "m1", session_id: "s1", role: "user", content: "一", timestamp: 1 },
  { id: "m2", session_id: "s1", role: "assistant", content: "二", timestamp: 2 },
  { id: "m3", session_id: "s1", role: "user", content: "三", timestamp: 3 },
];

vi.mock("../core/storage/port", () => ({
  hasStoragePort: () => true,
  getStoragePort: () => ({
    messages: {
      ensureLoaded: () => undefined,
      isLoaded: () => true,
      isTruncated: () => false,
      list: () => mirrorRows,
      hiddenIds: () => [],
    },
  }),
}));

import { listMessagesFromIndex } from "../core/storage/message";

beforeEach(() => {
  domainReadMany.mockReset();
  domainReadMany.mockImplementation((table: string) => {
    if (table !== "attachments") return [];
    return [
      { id: "a2", message_id: "m1", name: "b.png", type: "image", added_at: 20 },
      { id: "a1", message_id: "m1", name: "a.png", type: "image", added_at: 10 },
      { id: "a3", message_id: "m3", name: "c.txt", type: "file", added_at: 5 },
    ];
  });
});

describe("ATT-BULK：附件批量读", () => {
  it("读 3 条消息只读一次附件表（不是每条一次）", () => {
    const messages = listMessagesFromIndex("s1");
    const attachmentReads = domainReadMany.mock.calls.filter((c) => c[0] === "attachments");
    expect(attachmentReads.length, "每条消息一次 attachments 读 ⇒ O(M×A) 整表复制").toBe(1);
    expect(messages.length).toBe(3);
  });

  it("附件按 message_id 正确分桶，组内按 added_at 升序", () => {
    const messages = listMessagesFromIndex("s1");
    const byId = new Map(messages.map((m) => [m.id, m]));
    expect(byId.get("m1")?.attachments?.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(byId.get("m2")?.attachments ?? []).toEqual([]);
    expect(byId.get("m3")?.attachments?.map((a) => a.id)).toEqual(["a3"]);
  });
});
