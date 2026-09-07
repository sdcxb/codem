/**
 * 测试：消息编辑并回退（Edit & Rewind，对标 dsh-message-rewind / Trae）数据层语义
 *
 * 覆盖 REWIND-001 ~ REWIND-004：
 *   - REWIND-001: 回退 = 复制被编辑消息之前的前缀到新会话（不含被编辑消息本身）
 *   - REWIND-002: 编辑后的消息作为新 user 轮写入新会话末尾
 *   - REWIND-003: 原会话消息保持不变（无删除 = fork 而非 in-place）
 *   - REWIND-004: 复制出的消息获得全新 id（会话间不冲突）
 *
 * 被测链路：App.tsx handleEditAndRewind 所依赖的 MessageStorage 操作组合
 * （createMessage(msg, sessionId) / listMessages）。App 层 handler 本身依赖
 * 大量 UI 状态，不在本文件范围。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

const PROJECT_ID = "proj-rewind-test";
const SRC_SESSION = "sess-rewind-src";
const DST_SESSION = "sess-rewind-dst";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content: "content",
    timestamp: Date.now(),
    status: "done",
    ...overrides,
  };
}

function setup(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID, name: "回退测试", path: "D:\\test", createdAt: Date.now(), lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SRC_SESSION, projectId: PROJECT_ID, title: "源会话", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  });
  SessionStorage.createSession({
    id: DST_SESSION, projectId: PROJECT_ID, title: "Rewind: 源会话", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  });
}

/** 复刻 App.tsx handleEditAndRewind 的数据操作（与 handler 保持同构） */
function rewindDataLayer(
  srcSessionId: string,
  dstSessionId: string,
  messageId: string,
  newContent: string,
): { prefixCopied: number } {
  const all = MessageStorage.listMessages(srcSessionId);
  const targetIdx = all.findIndex((m) => m.id === messageId);
  if (targetIdx < 0) throw new Error("target message not found");
  const prefix = all.slice(0, targetIdx); // everything BEFORE the edited message

  const ts = Date.now();
  const clone = (m: Message): Message => ({
    ...m,
    id: `${m.id}-rw-${ts}-${Math.random().toString(36).slice(2, 7)}`,
    toolCalls: m.toolCalls?.map((tc) => ({ ...tc, id: `${tc.id}-rw-${ts}-${Math.random().toString(36).slice(2, 7)}` })),
  });
  for (const m of prefix) MessageStorage.createMessage(clone(m), dstSessionId);
  MessageStorage.createMessage({
    id: `user-rw-${ts}-${Math.random().toString(36).slice(2, 7)}`,
    role: "user", content: newContent, timestamp: Date.now(), status: "done",
  }, dstSessionId);
  return { prefixCopied: prefix.length };
}

describe("MessageStorage — Edit & Rewind fork 语义（数据层）", () => {
  beforeEach(async () => {
    await resetDatabase();
    await initDatabase();
    setup();
  });

  it("REWIND-001: 回退复制被编辑消息之前的前缀到新会话（不含被编辑消息本身）", () => {
    const m1 = makeMessage({ id: "u1", role: "user", content: "第一问" });
    const a1 = makeMessage({ id: "a1", role: "assistant", content: "第一答" });
    const m2 = makeMessage({ id: "u2", role: "user", content: "要回退的第二问" });
    const a2 = makeMessage({ id: "a2", role: "assistant", content: "第二答" });
    for (const m of [m1, a1, m2, a2]) MessageStorage.createMessage(m, SRC_SESSION);

    const { prefixCopied } = rewindDataLayer(SRC_SESSION, DST_SESSION, "u2", "改过的第二问");

    expect(prefixCopied).toBe(2); // [u1, a1] 前缀
    const dst = MessageStorage.listMessages(DST_SESSION);
    expect(dst).toHaveLength(3);
    // 前缀角色顺序保持 user→assistant；编辑消息追加为新 user 轮
    expect(dst[0].role).toBe("user");
    expect(dst[0].content).toBe("第一问");
    expect(dst[1].role).toBe("assistant");
    expect(dst[1].content).toBe("第一答");
    expect(dst[2].role).toBe("user");
    expect(dst[2].content).toBe("改过的第二问");
    // 被编辑消息本体（第二问）不进入新会话（它被编辑内容取代）
    expect(dst.some((m) => m.content === "要回退的第二问")).toBe(false);
  });

  it("REWIND-002: 编辑后的消息作为新 user 轮写入新会话末尾", () => {
    const m1 = makeMessage({ id: "u1", role: "user", content: "第一问" });
    const a1 = makeMessage({ id: "a1", role: "assistant", content: "第一答" });
    const m2 = makeMessage({ id: "u2", role: "user", content: "第二问" });
    for (const m of [m1, a1, m2]) MessageStorage.createMessage(m, SRC_SESSION);

    rewindDataLayer(SRC_SESSION, DST_SESSION, "u2", "改写后的新内容 ✓");
    const dst = MessageStorage.listMessages(DST_SESSION);
    const last = dst[dst.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("改写后的新内容 ✓");
  });

  it("REWIND-003: 原会话消息保持不变（fork 而非 in-place 删除）", () => {
    const m1 = makeMessage({ id: "u1", role: "user", content: "第一问" });
    const a1 = makeMessage({ id: "a1", role: "assistant", content: "第一答" });
    const m2 = makeMessage({ id: "u2", role: "user", content: "第二问" });
    const a2 = makeMessage({ id: "a2", role: "assistant", content: "第二答" });
    for (const m of [m1, a1, m2, a2]) MessageStorage.createMessage(m, SRC_SESSION);

    rewindDataLayer(SRC_SESSION, DST_SESSION, "u2", "改写内容");

    const src = MessageStorage.listMessages(SRC_SESSION);
    expect(src).toHaveLength(4); // 一条未删
    expect(src.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("REWIND-004: 复制出的消息获得全新 id（跨会话不冲突）", () => {
    const m1 = makeMessage({ id: "u1", role: "user", content: "第一问" });
    const a1 = makeMessage({ id: "a1", role: "assistant", content: "第一答" });
    const m2 = makeMessage({ id: "u2", role: "user", content: "第二问" });
    for (const m of [m1, a1, m2]) MessageStorage.createMessage(m, SRC_SESSION);

    rewindDataLayer(SRC_SESSION, DST_SESSION, "u2", "改写");
    const dst = MessageStorage.listMessages(DST_SESSION);
    const ids = new Set(dst.map((m) => m.id));
    expect(ids.size).toBe(dst.length); // 无重复
    for (const m of dst) {
      expect(m.id.startsWith("u1") || m.id.startsWith("a1") || m.id.startsWith("user-rw-")).toBe(true);
      expect(m.id).not.toBe("u2"); // 被编辑消息原始 id 不存在
    }
  });
});
