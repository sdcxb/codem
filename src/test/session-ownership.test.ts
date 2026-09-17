/**
 * P0-1 / P0-2 回归：**消息列表的归属**（跨会话数据污染）
 *
 * ## 被守的缺陷（真机形态）
 *
 * 会话 A 正在流式时切到会话 B。A 的后台 `runAgenticLoop` 还在跑，之后每一次
 * `start` / `tool_start` / `tool_complete` / `tool_error` / `finally` 都调
 * `saveMessages(A)` —— 而当时的实现写的是 **`get().messages`**，也就是
 * "**当前加载的那个会话**"（此时是 B）的列表，逐条按调用方给的 sessionId（A）落库。
 *
 * 落库去向（`MessageStorage.createMessage` → `appendSessionMessage` → JSONL /
 * FTS / eventLog）**全部按 sessionId 决定归属、对消息本身零校验**，而读路径
 * `listMessagesMerged` 会把 JSONL 合并回结果 —— 于是 B 的消息被追加进 A 的**权威日志**，
 * 而且是权威副本，不会被索引修正。
 *
 * 第二个方向（同一根因）：`addMessage` 被 `isViewingSession()` 拦掉之后，
 * "持久化"却依赖 store 列表 → **后台会话自己产生的 App 级消息一条都没落库**
 * （注释里承诺的 "Always persist to DB regardless" 是假的）。
 *
 * ## 用例与判据
 *
 * | 用例 | 守什么 |
 * | --- | --- |
 * | SO-1 | `loadedSessionId=A` 时无 explicit 的 `saveMessages("B")` **必须被拒绝**（不静默、不照写） |
 * | SO-2 | 带 explicit 的 `saveMessages("B", list)` 照写（后台会话唯一的正路） |
 * | SO-3 | `loadMoreMessages(A)` 的 300ms 回调在会话已切换后**不得**把 A 的历史拼进 `messages`，且 `isLoadingMore` 必须归 false |
 * | SO-4 | 源码级：`runAgenticLoop` 内不再有无 explicit 的 `saveMessages(session.id)`；`safeAddMessage` 在非查看态**仍然落库** |
 *
 * ## 判据为什么是"假端口的 messages 表"
 *
 * `store.saveMessages` 的落库链条是同步的：
 * `MessageStorage.createMessage(msg, sessionId)` → `writeIndexViaRust` →
 * `port.applyMessageWrite`（同步改镜像）+ `port.data.execute("messages.upsert_index")`
 * （假端口**同步**落表）。所以"某个 sessionId 下多了几行"在同一个 tick 内就可见，
 * 不需要 await。JSONL 那条腿在测试环境里走 `window.__TAURI__`（不存在）→
 * 内部 catch 后告警，不写任何文件。
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { __resetSaveFingerprints, useAppStore, type Message } from "../store";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SESSION_A = "sess-ownership-A";
const SESSION_B = "sess-ownership-B";

let port: FakeStoragePort;

/** 该会话在**索引**里的行数（落库判据）。 */
const indexedRows = (sid: string): number => port.__table("messages").filter((r) => r.session_id === sid).length;

/** 该会话在索引里的内容（断言"写进去的是哪几条"）。 */
const indexedContents = (sid: string): string[] =>
  port
    .__table("messages")
    .filter((r) => r.session_id === sid)
    .map((r) => String(r.content ?? ""));

function makeMessage(id: string, content: string, timestamp: number): Message {
  return { id, role: "user", content, timestamp, status: "done" };
}

/** A 会话的历史：30 条（> loadMessages 的 INITIAL_LIMIT=10，于是能触发 loadMoreMessages） */
const aHistory = (): Message[] =>
  Array.from({ length: 30 }, (_, i) => makeMessage(`a-${i + 1}`, `A 的第 ${i + 1} 条`, 1_000 + i));

/** B 会话的历史：1 条 */
const bHistory = (): Message[] => [makeMessage("b-1", "B 的唯一一条", 5_000)];

beforeEach(() => {
  resetPersistFailures();
  __resetSaveFingerprints();
  /*
   * 静音两条**测试环境固有**的告警：
   * ① `[SessionJSONL] 追加消息失败` —— 测试里没有 `window.__TAURI__`，
   *    `appendFile` 必然抛（file-api 的 getAppDataDir 读不到 `core`）。这是环境差异，
   *    不是被测行为；JSONL 那条腿在真机上由 Tauri 写文件，测试里无从验证。
   * ② `console.error` 保留（`reportPersistFailure` 走的是它，SO-1 要看到它的存在）。
   */
  vi.spyOn(console, "warn").mockImplementation(() => {});
  /*
   * 每例一个干净的假端口（文件头"判据为什么是假端口的 messages 表"）。
   * `setup.ts` 也会装一个，这里显式覆盖成**带预置数据**的那个。
   */
  port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: SESSION_A, project_id: "p1", title: "A", created_at: 1, last_message_at: 2, message_count: 0 },
        { id: SESSION_B, project_id: "p1", title: "B", created_at: 1, last_message_at: 2, message_count: 0 },
      ],
      messages: [
        ...aHistory().map((m) => ({ ...m, session_id: SESSION_A, hidden: 0 })),
        ...bHistory().map((m) => ({ ...m, session_id: SESSION_B, hidden: 0 })),
      ],
    },
  });
  setStoragePort(port);

  // store 复位（既有做法：component-store.test.ts 的 beforeEach）
  const s = useAppStore.getState();
  s.clearMessages();
  s.activeSessions.clear();
});

afterEach(() => {
  useAppStore.getState().clearMessages();
  setStoragePort(null);
  __resetSaveFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
});
describe("P0-1 跨会话污染：saveMessages 必须按归属拒绝", () => {
  it("SO-1: loadedSessionId=A 时，无 explicit 的 saveMessages(\"B\") 不写一条，并如实上报（不静默）", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    expect(useAppStore.getState().loadedSessionId, "前置：A 已加载").toBe(SESSION_A);
    expect(useAppStore.getState().messages.map((m) => m.id), "前置：列表是 A 的").toEqual(
      aHistory().slice(20).map((m) => m.id),
    );

    const bRowsBefore = indexedRows(SESSION_B);

    /*
     * 这就是后台 loop 在"用户切到 B 之后"打出的那一句：
     * 无 explicit + sessionId=B，而 store 里的列表是 A 的。
     *
     * 改前：无任何归属校验 → 把 A 的 10 条**按 B 落库**（污染 B 的权威日志）。
     * 改后：拒绝 + `reportPersistFailure("store.saveMessages", …)`。
     */
    useAppStore.getState().saveMessages(SESSION_B);

    expect(
      indexedRows(SESSION_B),
      `B 的索引行数不得增加（改前会 +10）。实际内容：${JSON.stringify(indexedContents(SESSION_B))}`,
    ).toBe(bRowsBefore);
    expect(indexedContents(SESSION_B)).not.toContain("A 的第 30 条");

    const failures = getPersistFailures();
    expect(
      failures.map((f) => f.area),
      "拒绝必须走统一上报通道（静默拒绝同样违规）",
    ).toContain("store.saveMessages");
    const entry = failures.find((f) => f.area === "store.saveMessages")!;
    expect(entry.lastMessage, "上报文案要能看出被拒绝的两个会话").toContain(SESSION_A);
    expect(entry.lastMessage).toContain(SESSION_B);
  });

  it("SO-2: 带 explicit 的 saveMessages(\"B\", list) 照写，且不上报失败（后台会话的正路）", () => {
    useAppStore.getState().loadMessages(SESSION_A);

    const bRowsBefore = indexedRows(SESSION_B);
    const explicit = [
      makeMessage("bg-1", "后台会话自己的消息 1", 6_000),
      makeMessage("bg-2", "后台会话自己的消息 2", 6_001),
    ];

    useAppStore.getState().saveMessages(SESSION_B, explicit);

    expect(indexedRows(SESSION_B) - bRowsBefore, "explicit 的这一份必须照写").toBe(explicit.length);
    expect(indexedContents(SESSION_B)).toContain("后台会话自己的消息 1");
    expect(indexedContents(SESSION_B)).toContain("后台会话自己的消息 2");
    expect(indexedContents(SESSION_B), "A 的消息不许跟着 explicit 一起过去").not.toContain("A 的第 30 条");
    expect(
      getPersistFailures(),
      "explicit 路径是正路，不该产生失败上报",
    ).toEqual([]);
  });
});

describe("P0-2 loadMoreMessages 的 300ms 回调必须校验会话", () => {
  it("SO-3: 回调期间切到 B → 不得把 A 的历史拼进 messages，且 isLoadingMore 归 false", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    expect(useAppStore.getState().hasMoreMessages, "前置：A 还有更早的历史").toBe(true);

    /*
     * ⚠️ 假计时器必须**在**调用 `loadMoreMessages` 之前装上：
     * 那个 300ms 回调的 timer 是在调用里创建的，先调用再装假计时器只会拿到一个
     * 已经排进真实事件循环的 timer（测试同步跑完，回调根本不会触发 → 用例假绿）。
     */
    vi.useFakeTimers();
    try {
      useAppStore.getState().loadMoreMessages(SESSION_A, 20);
      expect(useAppStore.getState().isLoadingMore, "前置：翻页中").toBe(true);

      // 用户在 300ms 窗口内切到了 B
      useAppStore.getState().loadMessages(SESSION_B);
      expect(useAppStore.getState().messages.map((m) => m.id), "前置：列表已是 B 的").toEqual(["b-1"]);

      // 让排队的那次回调触发
      vi.advanceTimersByTime(500);
    } finally {
      vi.useRealTimers();
    }

    const after = useAppStore.getState();
    expect(
      after.messages.map((m) => m.id),
      "改前：这里会变成 A 的 20 条历史 + B 的 1 条（跨会话污染）",
    ).toEqual(["b-1"]);
    expect(after.isLoadingMore, "被丢弃的回调必须把 loading 归 false，否则翻页永久卡住").toBe(false);
  });
});

describe("SO-4 源码级守卫（防后人回退）", () => {
  const appPath = path.join(__dirname, "..", "App.tsx");

  /** 取 `runAgenticLoop` 的函数体（从声明处到下一个顶层声明/结尾） */
  function runAgenticLoopBody(): string {
    const src = readFileSync(appPath, "utf-8");
    const start = src.indexOf("const runAgenticLoop = async (");
    expect(start, "runAgenticLoop 必须存在").toBeGreaterThan(0);
    // 同级的下一个顶层 `const xxx = ` 之前即为函数体（用行首缩进 2 空格判定）
    const rest = src.slice(start);
    const end = rest.indexOf("\n  const handleRegenerate", 1);
    return rest.slice(0, end > 0 ? end : rest.length);
  }

  /** 源码里的块注释 / 行注释区间（用于排除"注释里提到 saveMessages"造成的假阳性） */
  function commentRanges(src: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const re = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push([m.index, m.index + m[0].length]);
    return out;
  }

  it("SO-4a: runAgenticLoop 内不存在无 explicit 的 saveMessages(...)", () => {
    const body = runAgenticLoopBody();
    const comments = commentRanges(body);
    const inComment = (i: number) => comments.some(([a, b]) => i >= a && i < b);

    const calls: Array<{ args: string; at: number }> = [];
    const re = /saveMessages\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      if (!inComment(m.index)) calls.push({ args: m[1], at: m.index });
    }

    expect(calls.length, "loop 内的落库调用点不该被整批删掉（后台消息必须落库）").toBeGreaterThan(0);
    const bad = calls.filter((c) => !c.args.includes(",")).map((c) => c.args);
    expect(
      bad,
      `这些调用没有 explicit 消息列表 → 会写"当前显示的会话"的列表：${JSON.stringify(bad)}`,
    ).toEqual([]);

    /*
     * 反向确认：loop 里确实存在**带 explicit** 的落库（否则上面那条"不许有无 explicit"
     * 会被"把落库整批删掉"绕过 —— 那正是另一半缺陷：后台消息一条都不落库）。
     */
    const withExplicit = calls.filter((c) => c.args.includes(","));
    expect(withExplicit.length, "loop 里必须有带 explicit 消息列表的落库调用").toBeGreaterThan(0);
  });

  it("SO-4b: safeAddMessage 在非查看态仍然落库（防一刀切删掉落库）", () => {
    expect(existsSync(appPath)).toBe(true);
    const body = runAgenticLoopBody();
    const declAt = body.indexOf("const safeAddMessage");
    expect(declAt, "safeAddMessage 必须存在").toBeGreaterThan(0);
    // 到下一个 helper 声明为止，就是 safeAddMessage 的函数体
    const end = body.indexOf("const safeUpdateMessage", declAt);
    const snippet = body.slice(declAt, end > declAt ? end : declAt + 700);

    /** 这份实现的"函数体一级缩进"（正文行里最小的那个缩进；首行是声明、行尾的 `};` 不算） */
    const contentLines = snippet
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => l.trim().length > 0 && !/^\s*\};?\s*$/.test(l));
    const baseline = Math.min(...contentLines.map((l) => l.length - l.trimStart().length));
    const topLevel = contentLines
      .filter((l) => l.length - l.trimStart().length === baseline)
      .join("\n");

    /*
     * 落库必须是 `safeAddMessage` 里的**一级语句**。
     *
     * 为什么用缩进判据而不是"抠掉 if 块"：`if (isViewingSession()) addMessage(msg);`
     * 本来就没有大括号（单语句 if），按大括号配平去抠会连函数体一起抠掉。
     * 而"落库是不是一级语句"恰好等价于我们要守的东西 ——
     * 一旦有人把它挪进 `if (isViewingSession()) { … }`，它的缩进就比函数体深一级，
     * 这条断言立刻变红（那正是"后台会话不落库"的原形）。
     */
    expect(
      /persistLoopMessages\s*\(|MessageStorage\.createMessage\s*\(/.test(topLevel),
      `safeAddMessage 里必须有**无条件**的落库调用（非查看态也要落库）。一级语句只有：\n${topLevel}`,
    ).toBe(true);
    // 反向：UI 更新仍然只在查看时做（"不再更新 UI"同样不是我们要的修法）
    expect(
      /if\s*\(isViewingSession\(\)\)/.test(snippet),
      "safeAddMessage 里应保留 isViewingSession() 分支（UI 更新仍按查看态）",
    ).toBe(true);
  });
});
