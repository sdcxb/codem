/**
 * 时间上下文注入 —— **读不到事件时不许把"上次活动时间"写成 unavailable**（第 60 轮）
 *
 * ## 背景
 *
 * `findLastVisibleMessageTime` 从事件日志里取最后一条模型可见消息的时间戳，
 * 而 `getEventLog().readAll(sessionId)` 在该会话的**事件镜像没加载完**时返回空数组
 * （读路由的既定行为）。原来这里把"空"直接当成"查不到时间"，
 * 于是注入给模型的文本是 `Elapsed since the preceding model-visible message: unavailable.`
 *
 * 真机形态：应用启动后**第一轮**提示词拼装（`agentic-loop.ts:1267`）往往就是第一次
 * 访问该会话的事件 —— 镜像还没到，模型看到的"上次活动时间"就是 unavailable。
 * 这是同一根因（"读不到"被当成"没有"）在**模型可见面**上的表现，
 * 与维护审计里那次 934 vs 749 是同一个错误的两张脸。
 *
 * ## 这一组用例的判据
 *
 * 1. 事件读得到 → 用事件的时间戳（**优先级不许被回退路径抢走**）；
 * 2. 事件读不到、消息表有数据 → 回退到消息表的最后时间戳，**必须给出真实时长**；
 * 3. 两边都没有 → 才允许 `unavailable`（新会话就是这么个形态）。
 *
 * ⚠️ 这里守的是"回退是**同步**的"：提示词拼装是同步的，
 * 任何"后台算好、下次再用"的写法都救不了它要救的那个场景 —— 第 60 轮第一版
 * 就是这样写的（异步预热缓存），用例 2 会直接红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTimeContext, clearTimeContext } from "../core/llm/time-context";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SID = "tc-session";
/** 让"上次活动时间"是一个**确定的整数秒**：固定 now，再让消息时间戳离它有 90 秒 */
const NOW = 1_800_000_000_000;
const NINETY_SECONDS_AGO = NOW - 90_000;

function installTauriStub(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

function installPort(): FakeStoragePort {
  const port = createFakeStoragePort();
  setStoragePort(port);
  return port;
}

function seedSession(port: FakeStoragePort): void {
  void port.data.execute("crud.upsert", {
    table: "sessions",
    rows: [
      { id: SID, project_id: "", title: "tc", model: null, created_at: 1, last_message_at: 2, message_count: 1, pinned: 0 },
    ],
    mode: "replace",
  });
}

function seedMessage(port: FakeStoragePort, id: string, timestamp: number): void {
  void port.data.execute("crud.upsert", {
    table: "messages",
    rows: [
      {
        id,
        session_id: SID,
        role: "user",
        content: "问题",
        reasoning: null,
        timestamp,
        model: null,
        status: "done",
        hidden: 0,
        trimmed: 0,
      },
    ],
    mode: "replace",
  });
}

function seedEvent(port: FakeStoragePort, seq: number, timestamp: number): void {
  void port.data.execute("crud.upsert", {
    table: "session_events",
    rows: [
      {
        seq,
        session_id: SID,
        event_type: "user_message",
        payload: JSON.stringify({ messageId: "u-1", content: "问题" }),
        timestamp,
      },
    ],
    mode: "replace",
  });
}

/** 从注入文本里取"距离上一条模型可见消息"的那一行 */
function elapsedLine(): string {
  const text = buildTimeContext(SID, 1, 1);
  const line = text.split("\n").find((l) => l.startsWith("Elapsed since"));
  if (!line) throw new Error(`注入文本里没有 Elapsed 行：${text}`);
  return line;
}

beforeEach(() => {
  installTauriStub();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearTimeContext(SID);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TC：时间上下文的「上次活动时间」", () => {
  it("TC-1: 事件读得到 → 用事件的时间戳（90 秒前 → `1m 30s`）", async () => {
    const port = installPort();
    seedSession(port);
    seedMessage(port, "u-1", NINETY_SECONDS_AGO + 30_000); // 消息更近，但事件才是优先来源
    seedEvent(port, 1, NINETY_SECONDS_AGO);
    port.events.ensureLoaded(SID);

    expect(elapsedLine()).toBe("Elapsed since the preceding model-visible message: 1m 30s.");
  });

  it("TC-2: 事件读不到（镜像未就绪）但消息表有数据 → **必须回退**，不许写 unavailable", async () => {
    /*
     * 这就是真机启动第一轮的形态：事件镜像还没加载（读路由返回空数组），
     * 而消息表有数据。修之前注入的是 `unavailable` —— 模型据此以为"没有历史活动"。
     */
    const port = installPort();
    seedSession(port);
    seedMessage(port, "u-1", NINETY_SECONDS_AGO);
    // 刻意**不** ensureLoaded：事件镜像未就绪 → readAll 返回空数组

    expect(elapsedLine(), "回退必须是同步的：异步预热在这一刻拿不到值").toBe(
      "Elapsed since the preceding model-visible message: 1m 30s.",
    );
  });

  it("TC-3: 两边都没有（新会话）→ 才允许 unavailable", async () => {
    const port = installPort();
    seedSession(port);
    port.events.ensureLoaded(SID);

    expect(elapsedLine()).toBe("Elapsed since the preceding model-visible message: unavailable.");
  });
});
