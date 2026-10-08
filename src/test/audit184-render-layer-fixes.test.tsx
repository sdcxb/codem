/**
 * 第 184 波（UI 审计 `.preview-shot/_audit184-ui.md`）：渲染层缺陷的判据
 *
 * 覆盖 F1 ~ F6 六条。**判据钉的是行为/可达性**，不是"源码里有某个字符串"：
 * 凡是"渲染层没有便宜夹具"的部分（回合收尾、流式归属、中止收尾）都先把逻辑抽成纯函数
 * （`src/core/ui/loop-stream-state.ts` / `src/core/ui/generated-files-cleanup.ts`），
 * 再用行为断言钉住；只有"界面接线"那一层才用源码检查，并明确标注。
 *
 * | 用例 | 缺陷 | 造法 | 判据 |
 * | --- | --- | --- | --- |
 * | F1a | 两种「在屏会话」判据 | `loadedSessionId`=笔记本、`currentSession`=主会话 | 判成"在屏" |
 * | F1b | 笔记本流式正文不进界面 | 同一状态下跑 `routeBufferedTextToOwnCopy` | 界面正文真的被追加 |
 * | F1c | 上面那半 + autosave 覆盖定稿 | autosave 写空壳 → loop 的 explicit 落库 | 库里那行是**完整正文** |
 * | F1d | 后台会话被写进别的会话 | 两个会话都加载过 | 界面那份不动、loop 那份有全文 |
 * | F1e | 判据只有一份（接线检查） | 流式两条 flush 路径 | 不许再出现 `currentSession?.id === sessionId` |
 * | F2a/b | 末轮无正文 → 助手消息永不收尾 | `buildTurnFinalize` | status 落定 + metadata 落 + 文件清单清 |
 * | F3a | 中止后终局事件被丢弃 | `shouldProcessEventAfterAbort` | `end` 必须放行 |
 * | F3b | 中止后工具卡片永久转圈 | `applyAbortToRunningToolCalls` | running → 终态且有结果文案 |
 * | F3c | 「已停止」在 App 里不可达 | 真引擎（可控 SSE 流）中途 `abort()` | 真的吐出 `end{result.type:"aborted"}` 且被放行 |
 * | F3d | App 接线（接线检查） | 源码 | 守卫走 `shouldProcessEventAfterAbort`，收尾统一收 running |
 * | F4a | 恢复列表读失败说成「没有」 | 面板渲染（`getAllSessions` 抛错） | 显示「读取失败」 + 重试，**不显示**「暂无可恢复的会话」 |
 * | F4b | 无当前项目时按钮毫无反应 | 面板渲染 + 点「恢复此会话」 | 出现可读原因，且**不关窗** |
 * | F4c | `switchSession` 静默 no-op | store 行为 | 找不到会话 → 返回 false；找到 → true |
 * | F4d | 切换失败仍关窗 | 面板渲染（会话不在 store 里） | 不关窗 + 说明原因 |
 * | F5a | 删除失败也抹记录（模块行为） | 注入失败的 `invoke` | `deleted` 为空 ⇒ 调用方不抹记录；失败可见 |
 * | F5b | 同上，ChatPanel 真渲染 | `__TAURI__` 存在但 invoke 抛错 | 条目仍在 + 面板显示失败 |
 * | F5c | 两条路径同形（接线检查） | ChatPanel / NbChatPanel 源码 | 都不再"无条件 removeGeneratedFiles" |
 * | F6a | 笔记本侧把「读不到」说成「空」 | NbChatPanel 真渲染 | 三态齐全：在途 / 读不到 + 重试 / 确实空 |
 * | F6b | 反向对照 | 读到且确实空 | 欢迎页照旧出现 |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({
  recovery: {
    getAllSessions: vi.fn(() => [] as any[]),
    getRecoverySummary: vi.fn(() => ({
      totalSessions: 0,
      totalMessages: 0,
      recoverableSessions: 0,
      lastSaved: 0,
    })),
    deleteSession: vi.fn(),
  },
}));

vi.mock("../core/recovery/recovery", () => ({
  getSessionRecoveryService: () => hoisted.recovery,
  // 别的模块可能顺带 import 这个类型/函数
  SessionRecoveryService: class {},
}));

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures, getPersistFailures } from "../core/storage/persist-failure";
import { listMessages } from "../core/storage/message";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { useAppStore, __resetSaveFingerprints, type Message } from "../store";
import { useProjectStore } from "../core/store";
import type { Session } from "../core/types";
import {
  routeBufferedTextToOwnCopy,
  isSessionOnScreen,
  buildTurnFinalize,
  applyAbortToRunningToolCalls,
  shouldProcessEventAfterAbort,
  type LoopSnapshotRef,
  type ViewStateRef,
} from "../core/ui/loop-stream-state";
import { deleteGeneratedFiles } from "../core/ui/generated-files-cleanup";
import { SessionRecovery } from "../components/SessionRecovery";
import { TooltipProvider } from "../components/ui/tooltip";
import { ChatPanel } from "../components/ChatPanel";
import { NbChatPanel } from "../components/NbChatPanel";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** 源码注释里会引用这些字符串（说明"修前是什么样"），比对时要先剥掉注释 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * 取 `marker` 与其后 `endMarker` **之间**的那一段源码（两个标记本身不含在内）。
 *
 * 用途：这些接线检查不能只断言"某句在文件里出现过" —— 变异自证时发现，
 * `if (assistantContent) { safeUpdateMessage(...) }` 这种**把语句重新罩进条件里**
 * 的改法仍然能让"包含某字符串"的断言通过（仓库里既有教训：
 * 源码文本断言会在这种缺陷上假绿）。所以断言必须落在**语句所在的那一段**里，
 * 且用"按来源序排的两处锚点"取段（不数花括号：注释/字符串里的花括号会把计数带偏）。
 */
function sourceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker);
  if (a < 0) return "";
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) return "";
  return src.slice(a, b);
}

let port: FakeStoragePort;
let seq = 0;
const sid = (tag: string) => `sess-184-${tag}-${++seq}`;

function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

function seedSession(id: string, projectId = "p1") {
  seedRow("sessions", {
    id,
    project_id: projectId,
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
  });
}

function seedMessage(m: Message, sessionId: string) {
  seedRow("messages", {
    id: m.id,
    session_id: sessionId,
    role: m.role,
    content: m.content,
    reasoning: null,
    timestamp: m.timestamp,
    model: null,
    status: m.status ?? "done",
    hidden: 0,
  });
}

/** 从库里读出某条消息的正文（**权威落库结果**，不是内存里那份） */
function storedContent(sessionId: string, messageId: string): string | undefined {
  return listMessages(sessionId, { limit: 1000, offset: 0 }).find((m) => m.id === messageId)?.content;
}

beforeEach(() => {
  resetPersistFailures();
  __resetSaveFingerprints();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  port = createFakeStoragePort();
  setStoragePort(port);
  useAppStore.getState().clearMessages();
  useProjectStore.setState({ currentProject: null, currentSession: null, projects: [], sessions: [] });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().clearMessages();
  useProjectStore.setState({ currentProject: null, currentSession: null, projects: [], sessions: [] });
  setStoragePort(null);
  __resetSaveFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
});

/* ======================================================================
 * F1：笔记本回合的流式正文必须进界面（「在屏会话」只有一份判据）
 * ====================================================================== */

describe("F1：笔记本回合的流式正文", () => {
  it("F1a: 消息列表属于笔记本会话、currentSession 指向主会话 ⇒ 仍然判成「在屏」", () => {
    const MAIN = sid("f1a-main");
    const NB = sid("f1a-nb");

    useAppStore.getState().loadMessages(NB);
    useProjectStore.setState({ currentSession: { id: MAIN } as Session });

    expect(useAppStore.getState().loadedSessionId, "前置：列表归属是笔记本会话").toBe(NB);
    expect(useProjectStore.getState().currentSession?.id, "前置：全局当前会话是主会话").toBe(MAIN);

    /**
     * 反向自证：**修前那条判据**（`currentSession?.id === sessionId`）在这里必然为假
     * —— 这就是笔记本正文不进界面的原因（`flushStreamBuffer` 当时用的正是它）。
     */
    const legacyPredicate = useProjectStore.getState().currentSession?.id === NB;
    expect(legacyPredicate, "修前判据：currentSession 从不被笔记本改写 ⇒ 判成『不在屏』").toBe(false);

    expect(
      isSessionOnScreen(NB),
      "笔记本工作区从不改 currentSession（第 45 轮 P0-I1 的修法）——「在屏」必须认列表归属",
    ).toBe(true);
  });

  it("F1b: 笔记本会话在屏时，流式增量真的追加进界面那份，且 loop 那份同步有全文", () => {
    const MAIN = sid("f1b-main");
    const NB = sid("f1b-nb");
    const MSG = "assistant-nb-1";

    useAppStore.getState().loadMessages(NB);
    useAppStore.getState().addMessage({
      id: MSG,
      role: "assistant",
      content: "",
      timestamp: 1,
      status: "streaming",
    });
    useProjectStore.setState({ currentSession: { id: MAIN } as Session });

    const loopMessages = new Map<string, Message>([
      [MSG, { id: MSG, role: "assistant", content: "", timestamp: 1, status: "streaming" }],
    ]);
    const snapshotRef: LoopSnapshotRef = { current: { sessionId: NB, messages: loopMessages } };
    const viewRef: ViewStateRef = { current: null };

    const first = routeBufferedTextToOwnCopy({
      sessionId: NB,
      messageId: MSG,
      text: "笔记本的",
      field: "content",
      snapshotRef,
      viewRef,
    });
    // 这一次调用就是 App 的 flushStreamBuffer 会做的事
    if (first.viewing) useAppStore.getState().appendToMessage(MSG, "笔记本的");
    const second = routeBufferedTextToOwnCopy({
      sessionId: NB,
      messageId: MSG,
      text: "回答正文",
      field: "content",
      snapshotRef,
      viewRef,
    });
    if (second.viewing) useAppStore.getState().appendToMessage(MSG, "回答正文");

    expect(first.viewing, "判成『不在屏』就是 F1 本身").toBe(true);
    const ui = useAppStore.getState().messages.find((m) => m.id === MSG);
    expect(ui?.content, "笔记本问答的正文必须真的进界面（修前界面全空）").toBe("笔记本的回答正文");
    expect(
      loopMessages.get(MSG)?.content,
      "loop 自己那份也必须有全文（否则回合结束时落库写下去的是空壳）",
    ).toBe("笔记本的回答正文");
  });

  it("F1c: autosave 写下的空壳**不许**盖掉定稿正文（loop 的 explicit 落库是最后一次写）", () => {
    const MAIN = sid("f1c-main");
    const NB = sid("f1c-nb");
    const MSG = "assistant-nb-2";
    seedSession(NB);

    useAppStore.getState().loadMessages(NB);
    useAppStore.getState().addMessage({
      id: MSG,
      role: "assistant",
      content: "",
      timestamp: 1,
      status: "streaming",
    });
    useProjectStore.setState({ currentSession: { id: MAIN } as Session });

    const loopMessages = new Map<string, Message>([
      [MSG, { id: MSG, role: "assistant", content: "", timestamp: 1, status: "streaming" }],
    ]);
    const snapshotRef: LoopSnapshotRef = { current: { sessionId: NB, messages: loopMessages } };
    const viewRef: ViewStateRef = { current: null };
    for (const chunk of ["定稿", "正文"]) {
      const r = routeBufferedTextToOwnCopy({
        sessionId: NB,
        messageId: MSG,
        text: chunk,
        field: "content",
        snapshotRef,
        viewRef,
      });
      if (r.viewing) useAppStore.getState().appendToMessage(MSG, chunk);
    }

    /**
     * ① autosave（`App.tsx` 的 effect，owner = `loadedSessionId`）：此刻界面那份
     * 已经因为 F1 的修复而有正文，所以**这一半只有"修好之后"才成立** ——
     * 为了证明"就算 autosave 写的是空壳也不会赢"，这里显式模拟**空壳那一版**
     * （修前界面上就是空壳，指纹与定稿正文必然不同 ⇒ 一定会被写一次）。
     */
    useAppStore.setState({
      messages: useAppStore.getState().messages.map((m) => (m.id === MSG ? { ...m, content: "" } : m)),
    });
    useAppStore.getState().saveMessages(NB);
    expect(storedContent(NB, MSG), "前置：空壳确实被写进去过一次（复现审计里那一半）").toBe("");

    /**
     * ② 回合结束：loop 用 **explicit** 形态落库自己那份（`persistLoopMessages`），
     * 它发生在 autosave 之后（`finally` 里 `setStreaming(false)` 之后）。
     */
    __resetSaveFingerprints(); // 模拟"loop 的落库晚于 autosave"这件事（指纹缓存不掩盖它）
    useAppStore.getState().saveMessages(NB, [...loopMessages.values()]);

    expect(
      storedContent(NB, MSG),
      "定稿正文必须赢 —— 修前它根本不存在（正文只在 loop 快照外被丢掉），现在它是最后一次写",
    ).toBe("定稿正文");
  });

  it("F1d: 后台会话（两个都没在屏）不许把正文写进界面那份，但 loop 那份要有全文", () => {
    const OTHER = sid("f1d-other");
    const BG = sid("f1d-bg");
    const MSG = "assistant-bg-1";

    useAppStore.getState().loadMessages(OTHER);
    useAppStore.getState().addMessage({ id: MSG, role: "assistant", content: "", timestamp: 1, status: "streaming" });
    useProjectStore.setState({ currentSession: { id: OTHER } as Session });

    const loopMessages = new Map<string, Message>([
      [MSG, { id: MSG, role: "assistant", content: "", timestamp: 1, status: "streaming" }],
    ]);
    const snapshotRef: LoopSnapshotRef = { current: { sessionId: BG, messages: loopMessages } };
    const viewRef: ViewStateRef = { current: null };

    const r = routeBufferedTextToOwnCopy({
      sessionId: BG,
      messageId: MSG,
      text: "后台的正文",
      field: "content",
      snapshotRef,
      viewRef,
    });
    if (r.viewing) useAppStore.getState().appendToMessage(MSG, "后台的正文");

    expect(r.viewing, "后台会话不在屏上").toBe(false);
    expect(
      useAppStore.getState().messages.find((m) => m.id === MSG)?.content,
      "在屏那份属于别的会话 —— 不许被写脏",
    ).toBe("");
    expect(loopMessages.get(MSG)?.content, "后台会话的正文仍必须进 loop 那份（不然落库是空壳）").toBe("后台的正文");
  });

  it("F1e: 接线检查 —— 流式两条 flush 路径不许再自己判「在屏」（只许有一份判据）", () => {
    const src = stripComments(read("src/App.tsx"));
    const start = src.indexOf("const flushStreamBuffer = useCallback");
    const end = src.indexOf("const flushReasoningBuffer = useCallback");
    expect(start, "找不到 flushStreamBuffer（代码搬家了就更新这条接线检查）").toBeGreaterThan(-1);
    expect(end, "找不到 flushReasoningBuffer").toBeGreaterThan(start);
    // 正文那条 flush + 两者之间的 `streamViewRef` 声明
    const flush = src.slice(start, end);
    expect(flush, "正文那条 flush 必须走共用判据").toContain("routeBufferedTextToOwnCopy");
    const reasoning = src.slice(end, src.indexOf("// Flush all buffers on unmount"));
    expect(reasoning, "推理那条 flush 同样走共用判据（两处一个口径）").toContain("routeBufferedTextToOwnCopy");
    expect(
      flush + reasoning,
      "不许再自己读全局当前会话当判据（那正是笔记本正文不进界面的原因）",
    ).not.toContain("useProjectStore.getState()");
    // isViewingSession 也必须是同一个实现的别名
    expect(src, "runAgenticLoop 的查看判据同样走同一份实现").toContain(
      "const isViewingSession = () => isSessionOnScreen(session.id);",
    );
  });
});

/* ======================================================================
 * F2：末轮无正文也要收尾
 * ====================================================================== */

describe("F2：回合收尾与「有没有正文」解耦", () => {
  it("F2a: 末轮只调工具、没吐正文 ⇒ 仍然落 status/metadata/generatedFiles", () => {
    const fin = buildTurnFinalize({
      assistantMsgId: "assistant-empty",
      lastEvent: {
        type: "end",
        result: { type: "stop", reason: "completed", usage: { inputTokens: 12, outputTokens: 3 } },
      },
      generatedFiles: ["C:\\x\\a.ts", "C:\\x\\b.ts"],
      lang: "zh",
      now: 1234,
    });

    expect(fin.messageId).toBe("assistant-empty");
    expect(fin.update.status, "没有正文也必须落定 status（否则气泡永久转圈）").toBe("done");
    expect(fin.update.generatedFiles, "本轮产物清单要落进消息（气泡里的「清理过程文件」靠它）").toEqual([
      "C:\\x\\a.ts",
      "C:\\x\\b.ts",
    ]);
    expect(fin.update.metadata?.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(fin.update.metadata?.turnEndTime).toBe(1234);
  });

  it("F2b: 末轮以失败/中断收场（`{type:'error'}`）⇒ status=error + TurnStatus 落进 metadata", () => {
    const fin = buildTurnFinalize({
      assistantMsgId: "assistant-err",
      lastEvent: { type: "end", result: { type: "error", error: "API error 400: bad model" } },
      generatedFiles: [],
      lang: "zh",
    });

    expect(fin.update.status).toBe("error");
    expect(fin.update.generatedFiles, "没有产物 ⇒ 不写 generatedFiles（而不是留上一轮的）").toBeUndefined();
    expect(fin.update.metadata?.turnStatus?.kind).toBe("error");
    expect(fin.update.metadata?.turnStatus?.code).toBe("llm_call_failed");
  });

  it("F2c: App 接线 —— 收尾块不许再被 `if (assistantContent)` 罩住，且文件清单无条件清", () => {
    const src = stripComments(read("src/App.tsx"));
    const marker = "const { update } = buildTurnFinalize({";
    const idx = src.indexOf(marker);
    expect(idx, "找不到收尾块（代码搬家了就更新这条接线检查）").toBeGreaterThan(-1);
    /**
     * ⚠️ 判据落在**收尾那一段**（两处来源序锚点之间），不是"文件里出现过某字符串"：
     * 变异自证时试过 `if (assistantContent) { safeUpdateMessage(...); clear(); }`，
     * 那种"包含某字符串"的写法照样通过 —— 那种假绿正是本仓库记录过的教训。
     */
    const block = sourceBetween(src, marker, "if (sessionAbort.signal.aborted) {");
    expect(block.length, "取不到收尾那一段").toBeGreaterThan(0);
    expect(block, "收尾不许再挂在正文条件上").not.toContain("assistantContent");
    expect(block, "status/metadata/generatedFiles 必须落在这条消息上").toContain(
      "safeUpdateMessage(assistantMsgId, update);",
    );
    expect(
      block,
      "generatedFilesRef 必须**无条件**清空（残留会让下一轮「修改了 N 个文件」把上一轮算进来）",
    ).toContain("generatedFilesRef.current.clear();");
  });
});

/* ======================================================================
 * F3：点停止之后仍要处理收尾
 * ====================================================================== */

describe("F3：中止后的收尾", () => {
  it("F3a: 中止后只放行终局事件，过程性事件（正文/工具）一律跳过", () => {
    expect(shouldProcessEventAfterAbort(true, "end"), "`end` 是唯一能看到「⏹ 已停止」的分支").toBe(true);
    for (const t of ["text_delta", "reasoning_delta", "tool_start", "tool_complete", "start"]) {
      expect(shouldProcessEventAfterAbort(true, t), `${t} 是过程性事件，中止后不该继续消费`).toBe(false);
    }
    expect(shouldProcessEventAfterAbort(false, "text_delta"), "没中止时一切照旧").toBe(true);
  });

  it("F3b: running 的工具调用收成终态（有结果文案）；已完成的卡片不许被改", () => {
    const msg: Message = {
      id: "m-abort",
      role: "assistant",
      content: "",
      timestamp: 1,
      status: "streaming",
      toolCalls: [
        { id: "t1", tool: "write", args: {}, status: "running" },
        { id: "t2", tool: "read", args: {}, status: "done", result: "已读到" },
      ],
    };
    const fixed = applyAbortToRunningToolCalls(msg);
    expect(fixed, "有 running 的卡片就必须收尾").not.toBeNull();
    expect(fixed!.toolCalls![0].status, "修前没有任何回收点 ⇒ 卡片永久转圈、落库也是 running").toBe("error");
    expect(String(fixed!.toolCalls![0].result), "要给出「为什么停了」的说明").toMatch(/已停止/);
    expect(fixed!.toolCalls![1], "已完成的卡片原样保留").toEqual(msg.toolCalls![1]);
    expect(msg.toolCalls![0].status, "纯函数不许就地改入参").toBe("running");

    const none: Message = { id: "m-ok", role: "assistant", content: "答", timestamp: 1, status: "done" };
    expect(applyAbortToRunningToolCalls(none), "没有 running 的卡片 ⇒ 不做多余写入").toBeNull();
    expect(applyAbortToRunningToolCalls(undefined)).toBeNull();
  });

  it("F3c: 真引擎（可控 SSE 流）中途 abort ⇒ 真的吐出 end{result.type:'aborted'}，且它会被放行", async () => {
    const { OpenAICompatibleProvider } = await import("../core/llm/provider");
    const { AgenticLoop } = await import("../core/llm/agentic-loop");
    const { createDefaultToolRegistry } = await import("../core/llm/tools");

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode('data: {"id":"m1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      },
      pull() {
        return new Promise<void>(() => {});
      },
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body,
      text: async () => "",
      headers: new Headers(),
    })) as never;

    const provider = new OpenAICompatibleProvider({
      id: "f3-provider",
      name: "F3 Mock",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      models: [
        {
          id: "f3-model",
          name: "F3 Model",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "f3-model",
      securityMode: "full",
    });

    const events: any[] = [];
    let aborted = false;
    let consumedAfterAbort: string[] = [];
    for await (const e of loop.run("sess-184-f3c", "你好", "C:\\f3", "sys")) {
      // ★ 这一句就是 App 修前的守卫：中止后 break ⇒ end 及其后全丢
      if (aborted && e.type === "end") consumedAfterAbort.push(e.type);
      events.push(e);
      if (e.type === "text_delta" && !aborted) {
        aborted = true;
        loop.abort();
      }
      // 修后的守卫语义：中止后只放行终局事件
      if (aborted && !shouldProcessEventAfterAbort(true, e.type)) {
        // App 里这里是 `break`（继续 for-await 会 drain，但用例只关心终局事件到没到）
      }
    }
    controller = null;

    expect(aborted, "前置：必须真的在流中途按下取消").toBe(true);
    const ends = events.filter((e) => e.type === "end");
    expect(ends.length, "引擎必须吐出恰好一个 end（`agentic-loop.ts:2833`）").toBe(1);
    expect(
      ends[0].result.type,
      "引擎确实用 `{type:'aborted'}` 收场 —— 修前 App 的守卫在 switch 之前 break，这个事件被丢掉",
    ).toBe("aborted");
    expect(
      shouldProcessEventAfterAbort(true, "end"),
      "修后的守卫必须放行它，否则 `turn-outcome.ts` 那句「⏹ 已停止」在 App 里永远不可达",
    ).toBe(true);
    expect(consumedAfterAbort, "反向自证：这条 end 只有在放行时才会被消费").toEqual(["end"]);
  });

  it("F3d: App 接线 —— 事件循环入口走 `shouldProcessEventAfterAbort`，中止收尾统一收 running", () => {
    const src = stripComments(read("src/App.tsx"));
    const guardMarker = "if (!shouldProcessEventAfterAbort(";
    const guardIdx = src.indexOf(guardMarker);
    expect(guardIdx, "事件循环入口必须按「终局事件仍要处理」的判据筛事件").toBeGreaterThan(-1);
    /**
     * ⚠️ 两处来源序锚点之间的这一段就是"事件循环入口的守卫"。
     * 变异自证试过"在写好的守卫**前面**再加一句 `if (sessionAbort.signal.aborted) break;`"
     * —— 那种改法能让"包含某字符串"的断言通过，而 `end` 事件又被丢掉了（正是 F3 本身）。
     */
    const guard = sourceBetween(src, "lastEventAt = Date.now();", guardMarker);
    expect(guard.length, "取不到守卫之前那一段（代码搬家了就更新这条接线检查）").toBeGreaterThan(0);
    expect(guard, "旧守卫不许复活：`if (aborted) break;` 会把终局事件一起丢掉").not.toMatch(
      /if \(sessionAbort\.signal\.aborted\)\s*break;/,
    );
    // 中止收尾：那一整段里必须真的收 running 的卡片并落库
    const abort = sourceBetween(src, "if (sessionAbort.signal.aborted) {", "} catch (error: any) {");
    expect(abort.length, "取不到中止收尾那一段").toBeGreaterThan(0);
    expect(abort, "中止后必须把仍为 running 的工具卡片收成终态").toContain(
      "applyAbortToRunningToolCalls(loopMessages.get(assistantMsgId))",
    );
    expect(abort, "收尾必须落库（否则重启后卡片照旧转圈）").toContain("persistLoopMessages();");
  });
});

/* ======================================================================
 * F4：会话恢复面板的三处「假成功 / 假空」
 * ====================================================================== */

function makeSession(id: string): Session {
  return {
    id,
    projectId: "p1",
    title: `会话 ${id}`,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Session;
}

describe("F4：会话恢复面板", () => {
  it("F4a: 读列表失败 ⇒ 如实说「读取失败」并给重试；**不许**说「暂无可恢复的会话」", () => {
    hoisted.recovery.getAllSessions.mockImplementation(() => {
      throw new Error("storage engine not ready");
    });
    render(createElement(SessionRecovery, { onClose: () => {} }));

    const err = screen.getByTestId("session-recovery-read-error");
    expect(err.textContent, "把「读不到」说成「没有」正是这条通道代价最高的误报").toContain("读取失败");
    expect(err.textContent, "要说清这不代表没有").toContain("不代表没有");
    expect(screen.getByText("重新读取"), "必须给重试入口").toBeTruthy();
    expect(
      screen.queryByText("暂无可恢复的会话"),
      "读失败时渲染空态 = 把故障说成「没有数据」",
    ).toBeNull();
    expect(
      getPersistFailures().some((f) => f.area === "sessionRecovery.loadSessions"),
      "失败还要进仓库统一的可见通道",
    ).toBe(true);
  });

  it("F4a-2: 重试按钮真的会再读一次（读到之后告警消失、列表出现）", () => {
    hoisted.recovery.getAllSessions.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    // 第二次读：成功
    hoisted.recovery.getAllSessions.mockImplementation(() => [makeSession("sess-recoverable-1")]);

    render(createElement(SessionRecovery, { onClose: () => {} }));
    expect(screen.getByTestId("session-recovery-read-error")).toBeTruthy();

    fireEvent.click(screen.getByText("重新读取"));

    expect(screen.queryByTestId("session-recovery-read-error"), "重试成功后告警必须消失").toBeNull();
    expect(screen.getByText("会话 sess-recoverable-1")).toBeTruthy();
  });

  it("F4b: 无当前项目时点「恢复此会话」⇒ 给出可读原因，且**不关窗**", () => {
    hoisted.recovery.getAllSessions.mockReturnValue([makeSession("sess-no-project")]);
    const onClose = vi.fn();
    useProjectStore.setState({ currentProject: null, sessions: [] });

    render(createElement(SessionRecovery, { onClose }));
    fireEvent.click(screen.getByText("会话 sess-no-project"));
    fireEvent.click(screen.getByText(/恢复此会话/));

    const err = screen.getByTestId("session-recovery-action-error");
    expect(err.textContent, "修前这里 `if (!currentProject) return;` —— 按钮毫无反应").toMatch(/项目/);
    expect(onClose, "什么都没发生就不许关窗").not.toHaveBeenCalled();
  });

  it("F4c: switchSession 找不到会话 ⇒ 返回 false（不再静默 no-op）；找到 ⇒ true", () => {
    const S = sid("f4c");
    useProjectStore.setState({ sessions: [makeSession(S)], currentSession: null });

    expect(
      useProjectStore.getState().switchSession("sess-does-not-exist"),
      "静默 no-op 让调用方以为切换成功了（F4 第三处）",
    ).toBe(false);
    expect(useProjectStore.getState().currentSession, "失败的切换不许改动状态").toBeNull();

    expect(useProjectStore.getState().switchSession(S)).toBe(true);
    expect(useProjectStore.getState().currentSession?.id).toBe(S);
  });

  it("F4d: 会话不在 store 列表里 ⇒ 不关窗 + 说明原因 + 上报", async () => {
    hoisted.recovery.getAllSessions.mockReturnValue([makeSession("sess-ghost")]);
    const onClose = vi.fn();
    useProjectStore.setState({ currentProject: { id: "p1", name: "P", path: "C:\\p" } as any, sessions: [] });

    render(createElement(SessionRecovery, { onClose }));
    fireEvent.click(screen.getByText("会话 sess-ghost"));
    fireEvent.click(screen.getByText(/恢复此会话/));

    const err = await screen.findByTestId("session-recovery-action-error");
    expect(err.textContent, "恢复失败必须如实（弹窗照常关闭 = 用户以为恢复成功、实际什么都没发生）").toContain(
      "sess-ghost",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(getPersistFailures().some((f) => f.area === "sessionRecovery.handleRecover")).toBe(true);
  });
});

/* ======================================================================
 * F5：清理过程文件 —— 删除失败不许抹记录
 * ====================================================================== */

describe("F5：清理过程文件", () => {
  it("F5a: 删除失败 ⇒ 不算 deleted、进失败台账（调用方因此不抹记录）", async () => {
    const okFile = "C:\\x\\good.txt";
    const badFile = "C:\\x\\busy.txt";
    const invoke = vi.fn(async (file: string) => {
      if (file === badFile) throw new Error("EBUSY: 文件被占用");
      return null;
    });

    const res = await deleteGeneratedFiles({ files: [okFile, badFile], invoke, area: "test.deleteFiles" });

    expect(res.deleted, "只有真的删掉的才算删掉").toEqual([okFile]);
    expect(res.failed.map((f) => f.file), "失败项必须被报出来（记录要留着）").toEqual([badFile]);
    expect(String(res.failed[0].error)).toContain("EBUSY");
    expect(
      getPersistFailures().some((f) => f.area === "test.deleteFiles"),
      "修前失败只有一行 console.warn ⇒ 界面上与成功完全一样",
    ).toBe(true);
  });

  it("F5a-2: 没有桌面删除通道（`__TAURI__` 缺失）也算失败，不许当成删掉了", async () => {
    (globalThis as any).window.__TAURI__ = undefined;
    const res = await deleteGeneratedFiles({ files: ["C:\\x\\a.txt"], area: "test.deleteFiles.noTauri" });
    expect(res.deleted, "`?.` 让整条链路静默变 undefined 并被当成「删掉了」，正是缺陷形态").toEqual([]);
    expect(res.failed).toHaveLength(1);
  });

  it("F5b: ChatPanel 真渲染 —— invoke 抛错时条目仍在、面板如实提示", async () => {
    const FILES = ["C:\\x\\keep-me.txt"];
    (globalThis as any).window.__TAURI__ = {
      core: {
        invoke: vi.fn(async () => {
          throw new Error("EPERM: 删除被拒绝");
        }),
      },
    };
    useAppStore.setState({
      messages: [
        {
          id: "msg-del",
          role: "assistant",
          content: "写好了",
          timestamp: 1,
          status: "done",
          generatedFiles: [...FILES],
        },
      ],
      loadedSessionId: "sess-del",
    });

    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ChatPanel, {
          onSend: () => {},
          onCancel: () => {},
          onToggleSidebar: () => {},
          connected: true,
          model: "m",
          onModelChange: () => {},
          sessionId: "sess-del",
        } as any),
      ),
    );

    fireEvent.click(screen.getByText(/清理过程文件/));
    fireEvent.click(screen.getByText("删除"));

    const alert = await screen.findByTestId("chat-cleanup-failed");
    expect(alert.textContent, "必须如实告诉用户「文件还在」（而不是静默成功）").toContain("keep-me.txt");
    expect(
      useAppStore.getState().messages.find((m) => m.id === "msg-del")?.generatedFiles,
      "物理删除失败 ⇒ 条目与落库记录都不许抹掉（不可逆）",
    ).toEqual(FILES);
  });

  it("F5c: 接线检查 —— 两条面板路径同形，都不许“无条件 removeGeneratedFiles”", () => {
    for (const rel of ["src/components/ChatPanel.tsx", "src/components/NbChatPanel.tsx"]) {
      const src = stripComments(read(rel));
      expect(src, `${rel} 必须走共用实现（不是各写一份）`).toContain("deleteGeneratedFiles(");
      expect(
        src,
        `${rel} 不许再出现"失败也照样抹记录"的写法`,
      ).not.toMatch(/removeGeneratedFiles\(messageId,\s*files\)/);
      expect(src, `${rel} 只对真的删掉的条目抹记录`).toContain(
        "if (deleted.length > 0) removeGeneratedFiles(messageId, deleted);",
      );
    }
  });
});

/* ======================================================================
 * F6：笔记本侧必须与主聊天同一套三态
 * ====================================================================== */

function renderNbPanel() {
  return render(
    createElement(NbChatPanel, {
      onSend: () => {},
      onCancel: () => {},
      connected: true,
      model: "m",
      onModelChange: () => {},
      currentSessionId: "sess-nb-184",
      guidedQuestions: [],
      loadingQuestions: false,
      hasSources: true,
    } as any),
  );
}

describe("F6：笔记本面板的三态（读失败 ≠ 空）", () => {
  it("F6a: 读不到 ⇒ 显示「读不到」+重试，**不显示**欢迎页", () => {
    useAppStore.setState({
      messages: [],
      loadedSessionId: "sess-nb-184",
      messagesReadUnavailable: true,
      messagesLoading: false,
    });
    renderNbPanel();

    const branch = screen.getByTestId("nb-messages-unavailable");
    expect(branch.textContent, "要说清「这不代表消息丢了」").toContain("不代表");
    expect(screen.getByTestId("nb-messages-retry"), "必须给重试入口（修前连入口都没有）").toBeTruthy();
    expect(screen.queryByText("开始知识问答"), "读失败时渲染欢迎页 = 把故障说成「这个会话是空的」").toBeNull();
  });

  it("F6a-2: 在途 ⇒ 显示「正在读取历史消息」，既不是读不到、也不是欢迎页", () => {
    useAppStore.setState({
      messages: [],
      loadedSessionId: "sess-nb-184",
      messagesReadUnavailable: false,
      messagesLoading: true,
    });
    renderNbPanel();

    expect(screen.getByTestId("nb-messages-loading").textContent).toContain("正在读取历史消息");
    expect(screen.queryByTestId("nb-messages-unavailable"), "在途不许被说成读不到（狼来了）").toBeNull();
    expect(screen.queryByText("开始知识问答")).toBeNull();
  });

  it("F6b 反向对照: 读到了且确实空 ⇒ 欢迎页照旧（别把三态改成永远不显示欢迎页）", () => {
    useAppStore.setState({
      messages: [],
      loadedSessionId: "sess-nb-184",
      messagesReadUnavailable: false,
      messagesLoading: false,
    });
    renderNbPanel();

    expect(screen.getByText("开始知识问答")).toBeTruthy();
    expect(screen.queryByTestId("nb-messages-unavailable")).toBeNull();
    expect(screen.queryByTestId("nb-messages-loading")).toBeNull();
  });

  it("F6c: 重试真的会重新读这个笔记本会话", () => {
    useAppStore.setState({
      messages: [],
      loadedSessionId: "sess-nb-184",
      messagesReadUnavailable: true,
      messagesLoading: false,
    });
    const loadMessages = vi.spyOn(useAppStore.getState(), "loadMessages");
    renderNbPanel();
    fireEvent.click(screen.getByTestId("nb-messages-retry"));
    expect(loadMessages, "重试必须落到 store 的读路径上（不是只清个标记）").toHaveBeenCalledWith("sess-nb-184");
  });
});
