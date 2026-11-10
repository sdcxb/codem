/**
 * P1-1 收尾：**手动压缩的 marker 也要带会话笔记摘要**（COMPACT-NOTES）
 *
 * ## 被守的缺陷
 *
 * 自动压缩（`agentic-loop.ts::compactMessages`）从 P1-1 起就把
 * `buildThreadNotesDigest(sessionId)` 拼进 marker 尾部；手动压缩（
 * `ContextMonitor.manualCompact`）漏了这一步 —— 用户点一次「压缩上下文」，
 * 新段里模型只看到摘要，**看不到「目标 / 进度 / 卡点」**，而笔记明明还在存储里。
 *
 * 本判据钉住三件事：
 * 1. 有笔记 ⇒ 手动压缩的 marker 里出现笔记段（且是**调用**现有 digest 的产物）；
 * 2. 旧消息完整（检查点模式：不删、不隐藏）—— 压缩不许把历史吃掉；
 * 3. 预算放不下 / 没有笔记 ⇒ 整段省略，摘要与旧行为原样保留（回退不阻断）。
 *
 * | id | 钉什么 | 变红方式 |
 * |---|---|---|
 * | MC-N1 | 手动 marker 含「## 会话笔记」与笔记正文 | 不拼 notes ⇒ 红 |
 * | MC-N2 | 手动压缩不删任何旧消息（30 条仍可读） | 走删除路径 ⇒ 红 |
 * | MC-N3 | 笔记超预算 ⇒ 整段省略，摘要照旧 | 强行拼进去（突破 marker 预算）⇒ 红 |
 * | MC-N4 | 没有笔记 ⇒ marker 与旧版一致（无笔记段，摘要仍在） | 空段/标题残留 ⇒ 红 |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  appendThreadNote,
  forgetThreadNotes,
  __resetThreadNotesCache,
} from "../core/context/thread-notes";

const SESSION = "cm-manual-notes";

const listVisibleMessagesMock = vi.fn();
const deleteMessagesByIdsMock = vi.fn();
const createMessageMock = vi.fn();

vi.mock("../core/storage/message", () => ({
  isHiddenStateAuthoritative: () => true,
  listMessages: (...args: unknown[]) => listVisibleMessagesMock(...args),
  listVisibleMessages: (...args: unknown[]) => listVisibleMessagesMock(...args),
  deleteMessagesByIds: (...args: unknown[]) => deleteMessagesByIdsMock(...args),
  getLastDeleteReport: vi.fn(() => ({ requested: 0, unresolved: 0, sessions: [], softDeleteResponded: true })),
  getLastPersistError: () => null,
  flushPendingPersist: async () => true,
  updateMessage: vi.fn(),
  createMessage: (...args: unknown[]) => createMessageMock(...args),
}));

const { manualCompact } = await import("../components/ContextMonitor");

/** 30 条极短消息：保留 20 ⇒ 移除 10、removedChars 远小于 800（预算下界 800 生效） */
function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `content ${i}`,
    timestamp: i,
  }));
}

function markerOfFirstCreate(): string {
  expect(createMessageMock.mock.calls.length, "必须写了一条摘要标记").toBe(1);
  const message = createMessageMock.mock.calls[0][0] as { content: string; metadata?: any };
  return message.content;
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  __resetThreadNotesCache();
  listVisibleMessagesMock.mockReset().mockReturnValue(makeMessages(30));
  deleteMessagesByIdsMock.mockReset();
  createMessageMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  forgetThreadNotes(SESSION);
  __resetThreadNotesCache();
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("COMPACT-NOTES：手动压缩把会话笔记拼进 marker", () => {
  it("MC-N1：有笔记 ⇒ marker 里出现「## 会话笔记」与笔记正文", () => {
    appendThreadNote(SESSION, { text: "目标：补完 25 号文 P1-4 群聊页", tag: "goal" });
    appendThreadNote(SESSION, { text: "卡点：手动压缩的 marker 里没有笔记摘要" });

    const result = manualCompact(SESSION);
    expect(result.removed, "前提：确实发生了压缩").toBeGreaterThan(0);

    const marker = markerOfFirstCreate();
    expect(marker, "手动 marker 必须含笔记段标题").toContain("## 会话笔记");
    expect(marker, "笔记正文要原样进入 marker（untrusted 标注由 digest 自带）").toContain(
      "卡点：手动压缩的 marker 里没有笔记摘要",
    );
    expect(marker, "摘要段仍在（笔记是附加，不是替换）").toContain("以下对话的摘要");
  });

  it("MC-N2：手动压缩走检查点模式 —— 旧消息一条都不删", () => {
    appendThreadNote(SESSION, { text: "目标：不删历史" });
    const messages = makeMessages(30);
    listVisibleMessagesMock.mockReturnValue(messages);

    manualCompact(SESSION);

    expect(deleteMessagesByIdsMock.mock.calls.length, "检查点模式不许调用删除").toBe(0);
    expect(messages, "调用方手里的旧消息仍是 30 条（不隐藏、不删除）").toHaveLength(30);
  });

  it("MC-N3：笔记超过 marker 预算 ⇒ 整段省略，摘要照旧且不超预算", () => {
    /**
     * `buildThreadNotesDigest` 会**逐条**把笔记裁到 320 字符（再多条则按 8KB 裁）。
     * 所以"一条超长笔记"并不足以撑爆 800 字符的 marker 预算（实测它被裁成 ~320）；
     * 这里用 10 条 × 320 字符的合法笔记把 digest 撑到 ~3.3KB，远超预算。
     */
    for (let i = 0; i < 10; i += 1) {
      appendThreadNote(SESSION, { text: `超长笔记 ${i}：${"细".repeat(400)}` });
    }

    const result = manualCompact(SESSION);
    expect(result.removed).toBeGreaterThan(0);

    const marker = markerOfFirstCreate();
    expect(marker, "放不下时笔记段必须整段省略（不许突破预算）").not.toContain("## 会话笔记");
    expect(marker, "摘要主产物仍在").toContain("以下对话的摘要");
    expect(marker.length, `marker 长度 ${marker.length} 超过 max(800, 待压内容) 的预算`).toBeLessThanOrEqual(800);
  });

  it("MC-N4：没有笔记 ⇒ marker 与旧版一致（无笔记段，摘要仍在）", () => {
    const result = manualCompact(SESSION);
    expect(result.removed).toBeGreaterThan(0);

    const marker = markerOfFirstCreate();
    expect(marker, "没有笔记就不许留空标题").not.toContain("## 会话笔记");
    expect(marker).toContain("以下对话的摘要");
    expect(marker).toContain("较早的");
  });
});
