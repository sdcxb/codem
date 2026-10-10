/**
 * `O-57` 的**引擎那一半**在渲染侧这一边的契约（产品写路径 + 单一写入者）。
 *
 * ## 这一族判据挡的是什么
 *
 * 1. `LMA-ACT-1`：走**产品真路径**写一条消息之后，会话的 `last_message_at` 必须
 *    跟着这条消息的时间走，而且**只增不减**（写一条更早的也不许回退），
 *    并且 `listSessions` 的**可见顺序**真的跟着它走 —— 这一条把"引擎维护"与
 *    "用户在侧栏看到的结果"连起来（引擎侧的真源判据是 Rust 的 LMA-1..4）。
 * 2. `LMA-ACT-2`（反向对照 / 第二个写入者）：`useProjectStore.updateSession({title})`
 *    **不许**再顺手盖一个 `Date.now()` —— 那一列现在只有引擎写（消息写入），
 *    渲染侧只有**显式**给出的 `lastMessageAt` 才照写。
 *    第 191 波对 `message_count` 做过同一件事（见 `session-count-single-writer.test.ts`）：
 *    一个列有两个写入者时，用户看到的是"改名把旧会话顶到最上面"这种无来由的变化。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { __awaitPendingWrites } from "../core/storage/domain-store";
import * as SessionStorage from "../core/storage/session";
import * as MessageStorage from "../core/storage/message";
import { useProjectStore } from "../core/store";

const SESSION = "sess-lma";
const OTHER = "sess-lma-2";
const NOW = 1_700_000_000_000;

let port: FakeStoragePort;

const sessionRow = (id = SESSION): Record<string, unknown> =>
  port.__table("sessions").find((r) => r.id === id)!;

function mkSession(id: string, lastMessageAt: number, projectId = "p-lma") {
  SessionStorage.createSession({
    id,
    projectId,
    title: `会话 ${id}`,
    createdAt: 1,
    lastMessageAt,
    messageCount: 0,
  });
}

const msg = (id: string, timestamp: number) =>
  ({ id, role: "user", content: `内容 ${id}`, timestamp, status: "done" }) as never;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // 本文件只驱动"索引写路径"（端口），而 `createMessage` 还会顺手往权威 JSONL 日志追加 ——
  // 测试环境没有 Tauri 文件通道，那条路径**必然**报一次"数据根目录解析失败"。
  // 它与本判据无关（索引那一份仍然写成了），这里静音以免淹没真正的失败信息。
  vi.spyOn(console, "error").mockImplementation(() => {});
  port = createFakeStoragePort();
  setStoragePort(port);
});

afterEach(async () => {
  await __awaitPendingWrites();
  vi.restoreAllMocks();
  setStoragePort(null);
  useProjectStore.setState({ sessions: [], currentSession: null } as never);
});

describe("LMA-ACT：会话活动时间由消息写入维护（O-57）", () => {
  it("LMA-ACT-1：写消息 ⇒ 活动时间跟到这条消息；更早的不许回退；侧栏顺序跟着走", async () => {
    mkSession(SESSION, 1);
    mkSession(OTHER, NOW - 10_000); // 另一个会话：先写、时间更早

    // ① 先给"另一个会话"写一条较早的消息 ⇒ 它应当排在前面（时间倒序）
    MessageStorage.createMessage(msg("m-other", NOW - 10_000), OTHER);
    await __awaitPendingWrites();
    expect(
      SessionStorage.listSessions("p-lma").map((s) => s.id),
      "前提：另一个会话只有一条较早的消息，应排在前面",
    ).toEqual([OTHER, SESSION]);

    // ② 再给本会话写一条**更新**的消息 ⇒ 它必须顶到最上面
    MessageStorage.createMessage(msg("m-1", NOW), SESSION);
    await __awaitPendingWrites();
    expect(
      Number(sessionRow().last_message_at),
      "写消息必须把会话的活动时间抬到这条消息的 timestamp（引擎在同一事务里维护）",
    ).toBe(NOW);
    expect(
      SessionStorage.listSessions("p-lma").map((s) => s.id),
      "用户看得见的那一半：刚聊过的会话必须排在前面（这一条在修复前是红的 —— 活动时间停在创建时刻）",
    ).toEqual([SESSION, OTHER]);

    // ③ 覆盖写一条**更早**的时间戳（流式更新用的是这条消息原来的时间）⇒ 不许回退
    MessageStorage.createMessage(msg("m-1", NOW - 5_000), SESSION);
    await __awaitPendingWrites();
    expect(
      Number(sessionRow().last_message_at),
      "更早的 timestamp 不许把活动时间拉回去 —— 这一列只增不减（否则会话会掉回「更早」组）",
    ).toBe(NOW);
  });

  it("LMA-ACT-2：`store.updateSession({title})` 不许再盖 `lastMessageAt`；显式给出时照写", async () => {
    mkSession(SESSION, NOW);
    useProjectStore.setState({ sessions: [], currentSession: null } as never);

    // 改名（隐式）—— 与聊天无关的动作不许改动活动时间
    useProjectStore.getState().updateSession(SESSION, { title: "改过的标题" });
    await __awaitPendingWrites();
    expect(sessionRow().title, "前提：改名本身必须写进去（否则这条判据是空转）").toBe("改过的标题");
    expect(
      Number(sessionRow().last_message_at),
      "改名**不许**把活动时间盖成 Date.now()（那是第二个写入者：会让旧会话无来由地顶到最上面）",
    ).toBe(NOW);

    // 反向对照：显式给出时必须照写（App.tsx / NotebookWorkspace 的发送路径就靠它做即时反馈）
    useProjectStore.getState().updateSession(SESSION, { lastMessageAt: NOW + 1_000 });
    await __awaitPendingWrites();
    expect(
      Number(sessionRow().last_message_at),
      "调用方**显式**给出 lastMessageAt 时必须照写（否则发送路径的即时反馈会失效）",
    ).toBe(NOW + 1_000);
  });
});
