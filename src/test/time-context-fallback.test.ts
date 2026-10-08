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
import { minutePrecisionDate } from "../core/prompt/prompt";
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

/**
 * 从注入文本里取**时间戳那一行**的原始形态（`Time sampled while preparing turn N, step M: <ts> [Zone]`）。
 * 返回解析出的 `{ ts, zone }`，`ts` 是可直接被 `new Date()` 解析的时间串。
 */
function sampledTimestamp(): { ts: string; zone: string; line: string } {
  const text = buildTimeContext(SID, 1, 1);
  const line = text.split("\n").find((l) => l.startsWith("Time sampled"));
  if (!line) throw new Error(`注入文本里没有 Time sampled 行：${text}`);
  const m = /^Time sampled while preparing turn \d+, step \d+: (.+?) \[([^\]]+)\]$/.exec(line);
  if (!m) throw new Error(`时间戳行的形态不认识（判据无从解析）：${line}`);
  return { ts: m[1], zone: m[2], line };
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

/**
 * `TIME-CTX-1`：时间上下文的**时间戳**必须与真实瞬时一致，且与同请求的系统提示 date 同口径。
 *
 * ## 修复前的正身（第 189 波 R1，实测）
 *
 * `formatTimestamp` 旧实现 = `date.toISOString()`（**UTC 数字**）去掉 `.000Z` + 拼**本机偏移**：
 * `TZ=Asia/Shanghai`、本地 `2026-10-08 06:30` ⇒ `2026-10-07T22:30:00+08:00`，
 * 解析回 `2026-10-07T14:30Z` —— **比真实瞬时早 8 小时**。而"刚修好的"系统提示写
 * `2026-10-08T06:30:00.000+08:00`（`minutePrecisionDate`）⇒ 同一请求两个"现在几点"，
 * 数字与小时数都不同；尾部那条还自带时区名，模型更可能采信错的那条。
 *
 * ## 判据怎么做到"任何机器时区都能红"
 *
 * 时区**可注入**：把 `Date.prototype.getTimezoneOffset()` 固定成 `-480`（东八区）。
 * 于是"输出解析回来的瞬时 == 输入瞬时"这条断言在 UTC 机器上也**必须**成立
 * —— 只要实现是"UTC 数字 + 拼偏移"，它当场差 8 小时。
 * 时钟同样可注入（`vi.setSystemTime`，本文件既有的机制）。
 */
describe("TIME-CTX-1：时间戳的瞬时与标注必须一致（且与系统提示 date 同口径）", () => {
  /** 整秒时刻（`beforeEach` 注入的就是它；亚秒为 0 ⇒ "解析回来必须逐毫秒相等"是可断言的强形式） */
  const TC_NOW = NOW; // 1_800_000_000_000 = 2027-01-15T08:00:00Z

  /** 固定"东八区"（分钟，东为正 480 ⇒ `getTimezoneOffset()` 为 -480） */
  function withFixedEast8<T>(fn: () => T): T {
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
    try {
      return fn();
    } finally {
      spy.mockRestore();
    }
  }

  it("TIME-CTX-1①：固定时区（+08:00）下，输出解析回的**瞬时**必须等于输入瞬时", () => {
    const port = installPort();
    seedSession(port);
    port.events.ensureLoaded(SID);

    withFixedEast8(() => {
      const { ts, zone } = sampledTimestamp();
      const parsed = new Date(ts).getTime();
      expect(Number.isNaN(parsed), `时间戳必须可解析，实际：${ts}`).toBe(false);
      expect(
        parsed,
        `时间戳标注的瞬时必须等于真实瞬时（旧实现"UTC 数字 + 拼本机偏移"会早 8 小时），实际：${ts}`,
      ).toBe(TC_NOW);
      // 字段必须是**本地**（东八区 ⇒ UTC 08:00 = 本地 16:00），偏移标注必须是 +08:00
      expect(ts.slice(0, 19), `东八区本地墙上时间，实际：${ts}`).toBe("2027-01-15T16:00:00");
      expect(ts.endsWith("+08:00"), `偏移标注必须与字段同源，实际：${ts}`).toBe(true);
      expect(new Date(ts).getUTCHours(), "UTC 视图必须回到 08:00").toBe(8);
      expect(zone.length, "IANA 时区名仍在").toBeGreaterThan(0);
    });
  });

  it("TIME-CTX-1②：与**同请求**的系统提示 date 表示同一分钟（同一处偏移口径）", () => {
    const port = installPort();
    seedSession(port);
    port.events.ensureLoaded(SID);

    withFixedEast8(() => {
      const { ts } = sampledTimestamp();
      // 系统提示里的 date（默认时钟 = setSystemTime 注入的那一刻）与尾部时间戳必须同一分钟
      const dateStr = minutePrecisionDate();
      expect(
        ts.slice(0, 16),
        `尾部时间戳与系统提示 date 必须是同一分钟、同一偏移：${ts} vs ${dateStr}`,
      ).toBe(dateStr.slice(0, 16));
      const offsetOf = (s: string) => /([+-]\d{2}:\d{2})$/.exec(s)?.[1];
      expect(offsetOf(ts), `偏移也必须一致：${ts} vs ${dateStr}`).toBe(offsetOf(dateStr));
      // 两侧解析回来都必须是同一分钟（防"两边一起错"）
      expect(Math.floor(new Date(ts).getTime() / 60_000)).toBe(Math.floor(TC_NOW / 60_000));
      expect(Math.floor(new Date(dateStr).getTime() / 60_000)).toBe(Math.floor(TC_NOW / 60_000));
    });
  });

  it("TIME-CTX-1③（真实本机时区，不做任何注入）：解析回的瞬时仍必须等于输入瞬时", () => {
    const port = installPort();
    seedSession(port);
    port.events.ensureLoaded(SID);
    const { ts } = sampledTimestamp();
    expect(
      new Date(ts).getTime(),
      `无论本机在哪个时区，标注的瞬时都必须是真实瞬时，实际：${ts}`,
    ).toBe(TC_NOW);
    expect(ts.slice(0, 16)).toBe(minutePrecisionDate().slice(0, 16));
  });

  it("TIME-CTX-1④（反向，防「一律写 Z」）：偏移标注必须来自真实时区，不许硬编码", () => {
    const port = installPort();
    seedSession(port);
    port.events.ensureLoaded(SID);
    // 东八区 ⇒ 必须写 +08:00（写 Z 或写 -08:00 都会红）
    withFixedEast8(() => {
      expect(sampledTimestamp().ts).toContain("+08:00");
    });
    // 西五区（`getTimezoneOffset()` = +300）⇒ 必须写 -05:00
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300);
    try {
      clearTimeContext(SID);
      const { ts } = sampledTimestamp();
      expect(ts, "西五区必须写 -05:00").toContain("-05:00");
      expect(new Date(ts).getTime(), "换时区后瞬时仍然不变").toBe(TC_NOW);
      expect(ts.slice(0, 19), "西五区本地墙上时间（UTC 08:00 - 5h）").toBe("2027-01-15T03:00:00");
    } finally {
      spy.mockRestore();
    }
  });
});
