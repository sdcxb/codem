/**
 * 会话日志镜像（`cachedLogMessages`）的**生产清理时机**契约（第 63 轮）。
 *
 * ## 审计原文与它的要害
 *
 * > `message.ts:704 cachedLogMessages` — 每个被访问过的会话的**全部消息正文**常驻，
 * > 而清理入口 `clearSessionLogCache` 在**生产代码里没有调用者**（只有测试调）。
 *
 * 增长不是"用户点开多少会话"，而是"进程里有谁按会话扫过一遍"：
 * 启动维护的 `detectSessionsBehindLog` 为了让"索引落后于权威日志"能被发现，
 * 会主动把**每个会话**的日志读一遍（`ensureSessionLogHydrated`），
 * 重建索引（`session-log-bridge`）也是按批 hydrate —— 一次启动就把全部会话的正文留在了内存里。
 *
 * ## 为什么本文件**没有**"按预算逐出"的用例（这是有意的）
 *
 * 给这个结构加预算/ LRU 会在读路径上制造**静默的少历史**，证据是硬的：
 *
 * 1. 被索引裁剪的历史（`hidden = 1, trimmed = 1`）**只存在于日志那一侧**
 *    （`listMessagesFromIndex` 是 `WHERE hidden = 0` 的索引视图）；
 *    真机库只读实测：会话 `1788268497135-31x6vdt97` 共 657 行，**157 行**是裁剪行
 *    —— 清掉它的日志镜像 = 用户直接少看到 24% 的历史，且不是"读不到"而是"读到了更少的集合"；
 * 2. 没有任何东西会把它补回来：`store.loadMessages` 只在结果**为空**时才
 *    `ensureSessionLogHydrated`（`store.ts` 那一整段都在 `if (totalCount === 0)` 里），
 *    UI 的"正在读取历史… / 暂时读不到"也只在 `messages.length === 0` 时渲染；
 * 3. 存储层**没有**"当前会话"这个概念（`store.ts` 把它存在 React state 里），
 *    而 `listMessages` 还会被 fork / 父会话 / 不在场会话的维护路径调用 ——
 *    所以"最近被读的会话"并不等于"UI 正在看的会话"，逐出无法保证不碰它。
 *
 * 结论：**只释放"可证明没有读者"的会话**（会话已被删除）。
 * 该判据把"是否正在被读"这个问题变成了不需要回答的问题。
 *
 * 本文件钉住四条：
 *
 * - LC-1 删除成功 ⇒ 立刻释放（正文与读状态一起清）；
 * - LC-2 【对照】没删的会话**一个都不许碰**；
 * - LC-3 删除**失败** ⇒ 不许释放（会话还在，它仍可能被读）；
 * - LC-4 释放能压住"紧随其后的那一次 hydrate"（否则释放等于白做）；
 *   更晚的 hydrate 照常写回（读语义与改动前一致，由维护清扫再释放）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { useAppStore } from "../store";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const A = "sess-log-release-a";
const B = "sess-log-release-b";
const APP_DIR = "C:/fake-appdata/";
const files = new Map<string, string>();

/** 夹具：假的应用数据目录 + 假的文件 IPC（JSONL 走这两个动词） */
function installFakeFs() {
  files.clear();
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") {
          const p = String(args?.path);
          if (!files.has(p)) throw new Error(`not found: ${p}`);
          return files.get(p);
        }
        if (cmd === "write_file") {
          files.set(String(args?.path), String(args?.content ?? ""));
          return null;
        }
        if (cmd === "list_directory") return { entries: [], files: [] };
        return null;
      },
    },
  };
}

/** 一行合法 JSONL 记录（只给读路径真正需要的字段） */
const jsonlLine = (id: string, content: string, ts: number) =>
  JSON.stringify({ id, role: "user", content, timestamp: ts });

function seedLog(sessionId: string, count: number) {
  const lines = Array.from({ length: count }, (_, i) => jsonlLine(`${sessionId}-m${i}`, `正文 ${i}`, i + 1));
  files.set(`${APP_DIR}sessions/${sessionId}.jsonl`, `${lines.join("\n")}\n`);
}

let port: FakeStoragePort;

beforeEach(async () => {
  resetPersistFailures();
  installFakeFs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: A, project_id: "p1", title: "A", created_at: 1, last_message_at: 2, message_count: 0 },
        { id: B, project_id: "p1", title: "B", created_at: 1, last_message_at: 2, message_count: 0 },
      ],
      messages: [],
    },
  });
  setStoragePort(port);

  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  msgMod.__resetSessionLogReadFailuresForTests();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache?.();
  useAppStore.getState().clearMessages();

  seedLog(A, 3);
  seedLog(B, 4);
});

afterEach(() => {
  useAppStore.getState().clearMessages();
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
});

describe("会话日志镜像的生产清理时机 —— 只释放'可证明没有读者'的会话", () => {
  it("LC-1: 会话删除**成功**后立刻释放它的日志正文镜像", async () => {
    const msgMod = await import("../core/storage/message");
    const SessionStorage = await import("../core/storage/session");

    expect(await msgMod.hydrateSessionLog(A), "夹具前提：日志里有 3 条").toBe(3);
    expect(msgMod.sessionLogReadState(A)).toBe("hydrated");

    SessionStorage.deleteSession(A, { confirmBulk: true });

    expect(
      msgMod.sessionLogReadState(A),
      "删除之后必须回到 pending（= 正文不再驻留；下次真被读会重新从权威日志加载）",
    ).toBe("pending");
    expect(msgMod.logLiveMessageCount(A), "正文条数也要一并变成'不知道'（null），不许留一个旧快照").toBeNull();
  });

  it("LC-2: 【对照】没被删除的会话一个都不许碰", async () => {
    const msgMod = await import("../core/storage/message");
    const SessionStorage = await import("../core/storage/session");

    expect(await msgMod.hydrateSessionLog(A)).toBe(3);
    expect(await msgMod.hydrateSessionLog(B)).toBe(4);

    SessionStorage.deleteSession(A, { confirmBulk: true });

    expect(msgMod.sessionLogReadState(A), "被删的那个释放了").toBe("pending");
    expect(msgMod.sessionLogReadState(B), "**没被删的那个必须原封不动**").toBe("hydrated");
    expect(msgMod.logLiveMessageCount(B), "对照组的正文与条数都不受影响").toBe(4);
  });

  it("LC-3: 删除**失败** ⇒ 不许释放（会话还在，它仍然可能被读）", async () => {
    const msgMod = await import("../core/storage/message");
    const SessionStorage = await import("../core/storage/session");

    expect(await msgMod.hydrateSessionLog(A)).toBe(3);

    // 端口卸掉 = 删除拿不到任何写通道 → `domainDelete` 返回 false（走 `reportWriteNotAccepted`）
    setStoragePort(null);
    SessionStorage.deleteSession(A, { confirmBulk: true });

    expect(
      msgMod.sessionLogReadState(A),
      "删除没成功，会话还在 → 释放只会白白制造一次'非空但不完整'的读",
    ).toBe("hydrated");
    expect(msgMod.logLiveMessageCount(A)).toBe(3);
  });

  it("LC-4: 释放能压住'在释放的同时还在途的那一次 hydrate'，之后的读取照常驻留", async () => {
    const msgMod = await import("../core/storage/message");
    expect(await msgMod.hydrateSessionLog(A), "夹具前提：先正常驻留一次").toBe(3);

    /*
     * 制造"已经发起读取、还没写回"的形态：先释放（清掉驻留），
     * 再发起一次 hydrate —— 并用一次释放**跨越**它（模拟"读取期间会话被删除"）。
     */
    msgMod.releaseSessionLogCache(A, "用例：删除");
    const inFlight = msgMod.hydrateSessionLog(A);
    msgMod.releaseSessionLogCache(A, "用例：读取期间又被删除");
    expect(await inFlight, "那次 hydrate 自己照常返回条数（调用方不受影响）").toBe(3);

    expect(
      msgMod.sessionLogReadState(A),
      "跨越了一次释放的那次写回必须被丢弃 —— 否则释放当场白做",
    ).toBe("pending");

    // 之后的读取照常写回（否则会永远停在"正在读取历史…"）
    expect(await msgMod.hydrateSessionLog(A)).toBe(3);
    expect(msgMod.sessionLogReadState(A), "更晚的读取必须能正常驻留").toBe("hydrated");
  });
});
