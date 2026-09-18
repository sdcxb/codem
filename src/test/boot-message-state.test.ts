/**
 * 启动那一瞬间：**「还没到」不许被渲染成「读不到」**（第 49 轮，真机实测发现的）
 *
 * ## 缺陷（真机时间线，不是我推测的）
 *
 * 打包版启动后对着一条**真有 277 条消息**的会话轮询 DOM，拿到的时间线是：
 *
 * | 时刻 | 界面 |
 * | --- | --- |
 * | t=0ms | 0 条气泡，无告警（还在起始态） |
 * | **t=225ms** | **「暂时读不到这个会话的历史消息／这不代表消息丢了…」** |
 * | t=379ms | 告警消失，出现第 1 条气泡 |
 * | t=999ms | 3 条气泡，加载指示器消失 |
 *
 * 也就是每次启动都会对着一个**完好**的会话弹 154ms 的假警报。
 * 成因：镜像按会话**惰性加载**，而 `isMessagesReadUnavailable()` 用的判据是
 * `isLoaded === false` —— 那个状态同时代表两件完全不同的事：
 *
 * 1. **还没到**（加载任务在途，马上就有）→ 应当渲染"加载中"；
 * 2. **读不到**（端口没有该能力 / 加载失败过）→ 才是告警 + 重试。
 *
 * 把 1 说成 2 有两层代价：用户会以为存储坏了；而"狼来了"喊多了，
 * **真正**的"读不到"就没人信了 —— 那正是这条告警存在的意义。
 *
 * ## 判据（每条都有用例）
 *
 * | 情形 | `messagesLoading` | `messagesReadUnavailable` |
 * | --- | --- | --- |
 * | 镜像在途（`isLoading` 真） | `true` | `false` |
 * | 端口不在 / 加载已定论仍不可用 | `false` | `true` |
 * | 镜像就绪、消息读到了 | `false` | `false` |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { __resetSaveFingerprints, useAppStore, type Message } from "../store";
import { isMessagesReadPending, isMessagesReadUnavailable } from "../core/storage/message";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SESSION = "sess-boot-state";

const history = (): Message[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `m-${i + 1}`,
    role: "user" as const,
    content: `第 ${i + 1} 条`,
    timestamp: 1_000 + i,
    status: "done" as const,
  }));

let port: FakeStoragePort;

beforeEach(() => {
  resetPersistFailures();
  __resetSaveFingerprints();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const s = useAppStore.getState();
  s.clearMessages();
});

afterEach(() => {
  useAppStore.getState().clearMessages();
  setStoragePort(null);
  __resetSaveFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("BOOT：启动那一瞬间的三态（加载中 / 读不到 / 读到了）", () => {
  it("BOOT-1: 镜像在途 → 报「加载中」，**不许**报「读不到」（真机那条 154ms 假警报）", async () => {
    port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION, project_id: "p1", title: "S", created_at: 1, last_message_at: 2, message_count: 0 },
        ],
        messages: history().map((m) => ({ ...m, session_id: SESSION, hidden: 0 })),
      },
      // 打开异步加载：`ensureLoaded` 之后要等一个微任务才就绪 —— 真实端口就是这样
      asyncLoad: true,
    });
    setStoragePort(port);

    useAppStore.getState().loadMessages(SESSION);

    // 这一刻镜像**在途**：真实端口上新进会话的第一次读正好落在这个窗口里
    expect(isMessagesReadPending(SESSION), "前置：镜像确实在途").toBe(true);
    const during = useAppStore.getState();
    expect(
      during.messagesReadUnavailable,
      "「还在加载」被说成「读不到」= 每次启动弹一次假警报（真机实测 225~379ms）",
    ).toBe(false);
    expect(during.messagesLoading, "必须如实标记为加载中").toBe(true);

    // 等加载完成 + 就绪回调重读
    await new Promise((r) => setTimeout(r, 20));

    const after = useAppStore.getState();
    expect(after.messages.length, "就绪后应当读到真实历史（窗口是最后 INITIAL_LIMIT=10 条）").toBe(10);
    expect(after.messagesLoading, "读到之后加载中标记必须清掉").toBe(false);
    expect(after.messagesReadUnavailable).toBe(false);
  });

  it("BOOT-2: 端口不在 → 仍然是「读不到」（不许把真告警一起弄丢）", () => {
    setStoragePort(null);

    useAppStore.getState().loadMessages(SESSION);

    const s = useAppStore.getState();
    expect(isMessagesReadUnavailable(SESSION), "没有数据源 = 读不到").toBe(true);
    expect(isMessagesReadPending(SESSION), "没有端口就没有「在途」这一说").toBe(false);
    expect(s.messagesReadUnavailable, "真「读不到」必须照旧报警").toBe(true);
    expect(s.messagesLoading, "不许把它误标成加载中（那会把告警永久藏起来）").toBe(false);
  });

  it("BOOT-3: 就绪之后三态归位（加载中 → 读到了，两个标记都不留）", async () => {
    port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION, project_id: "p1", title: "S", created_at: 1, last_message_at: 2, message_count: 0 },
        ],
        messages: history().map((m) => ({ ...m, session_id: SESSION, hidden: 0 })),
      },
    });
    setStoragePort(port);

    useAppStore.getState().loadMessages(SESSION);
    await new Promise((r) => setTimeout(r, 20));

    const s = useAppStore.getState();
    expect(s.messages.length).toBe(10); // 窗口 = 最后 10 条
    expect(s.messagesLoading).toBe(false);
    expect(s.messagesReadUnavailable).toBe(false);
  });
});

describe("BOOT-WIRE：界面三支必须互斥（否则会出现自相矛盾的画面）", () => {
  const read = (rel: string) =>
    require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", rel), "utf8");

  it("BOOT-WIRE-1: ChatPanel 有「加载中」这一支，且欢迎页在加载期间不出现", () => {
    const src = read("src/components/ChatPanel.tsx");
    expect(src, "必须有加载中分支").toContain('data-testid="messages-loading"');
    expect(src, "加载中优先于读不到").toContain(
      "messages.length === 0 && messagesLoading && !messagesReadUnavailable",
    );
    expect(
      src,
      "欢迎页（开始新对话）在加载期间不许出现 —— 那会让用户以为会话是空的",
    ).toContain("messages.length === 0 && !messagesReadUnavailable && !messagesLoading");
  });

  it("BOOT-WIRE-2: 「加载中」的判据来自端口（不是自己猜的计时器）", () => {
    const src = read("src/core/storage/message.ts");
    expect(src).toContain("export function isMessagesReadPending");
    expect(src, "判据必须问端口的 isLoading，而不是 setTimeout 猜").toContain(
      "port.messages.isLoading(sessionId)",
    );
    const store = read("src/store.ts");
    expect(store).toContain("MessageStorage.isMessagesReadPending(sessionId)");
  });
});
