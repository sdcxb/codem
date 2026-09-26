/**
 * FC-*：功能上下文链路的回归（第 45 轮审计 `.preview-shot/_audit/FEATURE-CONTEXT.md`）
 *
 * 覆盖的条目（每条都在文件里有对应用例）：
 *
 * | 用例 | 守什么 | 报告条目 |
 * | --- | --- | --- |
 * | FC-D0a~d | 主聊天 `user_message` / `assistant_text` 事件真的写进去；流式中间态不写、重复落库不膨胀、正文改写才补写 | P0-D0 |
 * | FC-D1a/b | 空事件日志不再把"Context: 0 visible messages"注进系统提示 | P1-D1 |
 * | FC-I1a~c | 笔记本回合不再全局改写 `currentSession`；窗口期内各读写方按"列表归属"工作 | P0-I1 |
 * | FC-I2a/b | 前台回合与后台回合共享同一张"正在执行"登记表（同一会话不并发） | P1-I2 |
 * | FC-I3a | 委派 `cwd` 按**目标会话所属项目**解析 | P1-I3 |
 * | FC-D2a~c | 分叉的项目归属取源会话；worktree 在**源项目的仓库**里建/删 | P1-D2 |
 * | FC-D3a/b | 分叉继承会话级模式字段；附件 id 换新（源消息的附件不被搬走） | P1-D3 |
 * | FC-D6a | 分叉不再复制事件日志 ⇒ 子会话事件与消息主键一致 | P2-D6 |
 * | FC-D4a~g | 压缩摘要标记的折叠、级联、以及**标记主键的唯一性**（同一毫秒/跨会话不许撞车） | P1-D4 |
 * | FC-D5a~c | 手动压缩挂并发闸门、写 `compaction` 事件、折叠旧标记 | P1-D5 |
 *
 * ## 判据为什么落在"假端口里的行内容"
 *
 * 全是"用户数据写去哪了"的问题：`sessions` / `messages` / `attachments` /
 * `session_events` 四张表的行内容就是事实。所以凡是涉及归属的用例都断言**目标行里的列值**
 * （不是"某个函数被调用了"）。
 *
 * 每个用例用**独立的会话 id**：`message.ts` 里有若干模块级状态（`localHiddenIds`、
 * `writtenTextEventFingerprints`）刻意不随端口更换清空，共用 id 会让用例互相串味
 * （见 `compaction-budget.test.ts` 的 SESSION_BASE 说明）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  /** `setCompactionInProgress` 的调用序列（FC-D5b 用） */
  compactionGateCalls: [] as boolean[],
  /** worktree 操作的调用记录（FC-D2b/c 用） */
  createWorktreeCalls: [] as Array<{ projectPath: string; sessionId: string }>,
  removeWorktreeCalls: [] as Array<{ projectPath: string; worktreePath: string }>,
}));

/**
 * `core/environment` 的受控替身：只替换与"在哪跑"有关的四件事，
 * 其余（类型、设置读写）保持真实 —— 这样 `core/store.ts` 的行为除 worktree 之外不变。
 */
vi.mock("../core/environment", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // 强制"每个项目都用 git worktree"，这样分叉路径一定会走到建 worktree 那一步
    getProjectExecutionMode: () => "git_worktree",
    getWorktreeRoot: (projectPath: string) => `${projectPath}\\.wt`,
    createWorktree: async (projectPath: string, sessionId: string) => {
      hoisted.createWorktreeCalls.push({ projectPath, sessionId });
      return `${projectPath}\\.wt\\${sessionId}`;
    },
    removeWorktree: async (projectPath: string, worktreePath: string) => {
      hoisted.removeWorktreeCalls.push({ projectPath, worktreePath });
    },
  };
});

/** `compaction-state` 的调用记录包装（真实现照旧生效，只是多记一笔） */
vi.mock("../core/storage/compaction-state", async (importOriginal) => {
  const actual = await importOriginal<{
    isCompactionInProgress: () => boolean;
    setCompactionInProgress: (v: boolean) => void;
  }>();
  return {
    ...actual,
    setCompactionInProgress: (v: boolean) => {
      hoisted.compactionGateCalls.push(v);
      actual.setCompactionInProgress(v);
    },
  };
});

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import {
  createMessage,
  listMessages,
  listVisibleMessages,
  copyMessageToSession,
  __resetTextEventFingerprints,
} from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { getEventProjection } from "../core/storage/event-projection";
import { getSurfaceManager } from "../core/llm/surface-manager";
import {
  foldStaleCompactionMarkers,
  isCompactionMarker,
  COMPACTION_MARKER_PREFIXES,
} from "../core/llm/compaction-budget";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { manualCompact } from "../components/ContextMonitor";
import { isCompactionInProgress } from "../core/storage/compaction-state";
import {
  isSessionExecuting,
  startSessionExecution,
  endSessionExecution,
  executeSessionTurn,
} from "../core/session";
import { useProjectStore } from "../core/store";
import { useAppStore, __resetSaveFingerprints, type Message } from "../store";
import { readFileSync } from "node:fs";
import * as path from "node:path";

let port: FakeStoragePort;
let seq = 0;
/** 每个用例一个会话 id（模块级状态不随端口清空，见文件头） */
const sid = (tag: string) => `sess-fc-${tag}-${++seq}`;

const eventsOf = (sessionId: string) =>
  port.__table("session_events").filter((r) => r.session_id === sessionId);
const rowsOf = (table: string) => port.__table(table);

/**
 * 预置一行数据（走端口的真实写路径 `crud.upsert`，假端口是**同步**写表）。
 *
 * ⚠️ 不能"往 `port.__table("x")` 里 push"：`__table` 返回的是**拷贝**
 * （`fake-storage-port.ts:1624` 的 `.map(cloneRow)`），塞进去的行不会进库 ——
 * 第一版夹具就是这么写的，结果是"源会话不存在 → fork 抛错"这类假失败。
 */
function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

function seedSession(id: string, projectId = "p1", extra: Record<string, unknown> = {}) {
  seedRow("sessions", {
    id,
    project_id: projectId,
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
    ...extra,
  });
}

function seedMessage(m: Message, sessionId: string, extra: Record<string, unknown> = {}) {
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
    ...extra,
  });
}

function seedEvent(sessionId: string, eventType: string, payload: unknown, ts = 1) {
  const rows = port.__table("session_events");
  seedRow("session_events", {
    seq: rows.length + 1,
    session_id: sessionId,
    event_type: eventType,
    payload: JSON.stringify(payload),
    timestamp: ts,
  });
}

function resetStores() {
  useAppStore.getState().clearMessages();
  useAppStore.getState().activeSessions.clear();
  useProjectStore.setState({
    currentProject: null,
    currentSession: null,
    projects: [],
    sessions: [],
  });
}

/** 源码文本（源码级断言用：UI 回调没法在 Node 里直接触发） */
const appSource = () => readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
const contextMonitorSource = () =>
  readFileSync(path.join(process.cwd(), "src", "components", "ContextMonitor.tsx"), "utf8");

beforeEach(() => {
  resetPersistFailures();
  __resetSaveFingerprints();
  __resetTextEventFingerprints();
  hoisted.compactionGateCalls.length = 0;
  hoisted.createWorktreeCalls.length = 0;
  hoisted.removeWorktreeCalls.length = 0;
  // 测试环境固有噪音：没有 __TAURI__，JSONL 那条腿必然告警（与既有用法一致）
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  port = createFakeStoragePort();
  setStoragePort(port);
  resetStores();
});

afterEach(() => {
  resetStores();
  setStoragePort(null);
  __resetSaveFingerprints();
  __resetTextEventFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
});

// ======================================================================
// P0-D0：主聊天的文本事件写入（定稿写一条，流式不写）
// ======================================================================

describe("FC-D0：主聊天事件双写（P0-D0）", () => {
  it("FC-D0a: 用户消息写 user_message；助手定稿写一条 assistant_text（内容=定稿正文），流式中间态一条都不写", () => {
    const S = sid("d0a");
    seedSession(S);

    createMessage({ id: "u1", role: "user", content: "帮我看一下 A 文件", timestamp: 1, status: "done" }, S);
    const userEvents = eventsOf(S).filter((e) => e.event_type === "user_message");
    expect(userEvents, "主聊天的 user_message 必须真的写进事件日志（改前恒为 0 条）").toHaveLength(1);
    expect(JSON.parse(String(userEvents[0].payload))).toEqual({
      messageId: "u1",
      content: "帮我看一下 A 文件",
    });

    // ① 流式空壳（App.tsx 在 text_delta 时先建空壳）
    createMessage({ id: "a1", role: "assistant", content: "", timestamp: 2, status: "streaming" }, S);
    // ② 流式半截正文（tool_start / tool_complete / 2 秒 autosave 都会落一次库）
    createMessage({ id: "a1", role: "assistant", content: "我先看", timestamp: 2, status: "streaming" }, S);
    createMessage({ id: "a1", role: "assistant", content: "我先看一下这个文件", timestamp: 2, status: "streaming" }, S);
    expect(
      eventsOf(S).filter((e) => e.event_type === "assistant_text"),
      "流式中间态不是定稿，一条都不该写（否则事件表按增量膨胀）",
    ).toHaveLength(0);

    // ③ 定稿（App.tsx 的 safeUpdateMessage(status:"done") 之后紧跟 persistLoopMessages()）
    createMessage(
      { id: "a1", role: "assistant", content: "这个文件里有一个未处理的错误分支。", timestamp: 2, status: "done" },
      S,
    );
    const assistantEvents = eventsOf(S).filter((e) => e.event_type === "assistant_text");
    expect(assistantEvents, "定稿恰好写一条").toHaveLength(1);
    expect(JSON.parse(String(assistantEvents[0].payload))).toMatchObject({
      messageId: "a1",
      content: "这个文件里有一个未处理的错误分支。",
    });
  });

  it("FC-D0b: 同一份定稿正文反复落库不再增行；正文被改写才补一条（投影后写者胜）", () => {
    const S = sid("d0b");
    seedSession(S);
    const final = { id: "a2", role: "assistant" as const, content: "完成：已修复 3 处", timestamp: 5, status: "done" as const };
    createMessage(final, S);
    createMessage(final, S); // saveMessages 再次全量写一遍（指纹相同）
    createMessage({ ...final }, S);
    expect(eventsOf(S).filter((e) => e.event_type === "assistant_text")).toHaveLength(1);

    // 正文被改写（纠错回写 / 编辑重发）→ 补一条，投影取最新
    createMessage({ ...final, content: "完成：已修复 4 处" }, S);
    const list = eventsOf(S).filter((e) => e.event_type === "assistant_text");
    expect(list, "正文变了才补一条").toHaveLength(2);
    expect(JSON.parse(String(list[1].payload)).content).toBe("完成：已修复 4 处");
    expect(getEventProjection().projectSurface(S).messages.find((m) => m.id === "a2")?.content).toBe(
      "完成：已修复 4 处",
    );
  });

  /**
   * FC-D0d：**重载后不得重复落库**（第 176 轮修 O-29）。
   *
   * 现场（第 154 轮装机复核顺手看到的）：跑完一个回合后**重载页面**（启动维护重跑），
   * 副本库里该会话出现成对重复：`seq=8991` 与 `seq=9001` 是同一条 `user_message`、
   * `seq=8995` 与 `seq=9002` 是同一条 `assistant_text`。
   * 根因：去重用的指纹表（`writtenTextEventFingerprints`）是**模块级内存态**，页面一重载就空了，
   * 而重载后 store 会把当前会话的消息再 `saveMessages` 一遍 ⇒ 同一条正文被当成"第一次写"。
   *
   * 这里用 `__resetTextEventFingerprints()` **模拟重载**（清掉进程内快路径、事件表原样保留），
   * 再落库同一份定稿正文：事件表**不得新增行**。
   * 反向对照（同一条用例里）：正文**真的被改写**时必须补一条 —— 去重不能把改写也吞掉。
   */
  it("FC-D0d: 重载（内存指纹清空）后再落库同一份定稿正文，事件表不得新增行（O-29）", () => {
    const S = sid("d0d");
    seedSession(S);
    const userMsg = { id: "u-reload", role: "user" as const, content: "重载前那条正文", timestamp: 11, status: "done" as const };
    const assistantMsg = { id: "a-reload", role: "assistant" as const, content: "重载前那条回复", timestamp: 12, status: "done" as const };
    const countOf = (type: string) => eventsOf(S).filter((e) => e.event_type === type).length;

    createMessage(userMsg, S);
    createMessage(assistantMsg, S);
    expect(countOf("user_message"), "首次落库写一条").toBe(1);
    expect(countOf("assistant_text"), "首次落库写一条").toBe(1);

    /* —— 模拟页面重载：进程内快路径清空，权威事件表（持久）还在 —— */
    __resetTextEventFingerprints();

    createMessage(userMsg, S);
    createMessage(assistantMsg, S);
    expect(countOf("user_message"), "重载后重复落库同一份正文 ⇒ 不该新增事件行").toBe(1);
    expect(countOf("assistant_text"), "重载后重复落库同一份正文 ⇒ 不该新增事件行").toBe(1);

    /* 反向对照：正文真的被改写 ⇒ 必须补一条（持久判据只挡"同类型+同 id+同内容"） */
    createMessage({ ...assistantMsg, content: "重载后改写过的回复" }, S);
    expect(countOf("assistant_text"), "正文变了要补一条，去重不能把改写吞掉").toBe(2);
    const list = eventsOf(S).filter((e) => e.event_type === "assistant_text");
    expect(JSON.parse(String(list[1].payload)).content).toBe("重载后改写过的回复");
  });

  it("FC-D0c: 消费方语义 —— 投影里的助手正文等于定稿正文，用户消息按 messageId 去重", () => {
    const S = sid("d0c");    seedSession(S);
    createMessage({ id: "u9", role: "user", content: "问题", timestamp: 1, status: "done" }, S);
    createMessage({ id: "a9", role: "assistant", content: "", timestamp: 2, status: "streaming" }, S);
    createMessage({ id: "a9", role: "assistant", content: "答案", timestamp: 2, status: "done" }, S);
    // 再写一遍同一条用户消息（不同的写入路径，例如 fork 复制后的列表落库）
    createMessage({ id: "u9", role: "user", content: "问题", timestamp: 1, status: "done" }, S);

    expect(eventsOf(S).filter((e) => e.event_type === "user_message")).toHaveLength(1);
    const surface = getEventProjection().projectSurface(S);
    expect(surface.messages.map((m) => `${m.role}:${m.content}`)).toEqual(["user:问题", "assistant:答案"]);
  });

  it("FC-D0d: 端口没接手时事件不会写，指纹不记账 ⇒ 端口恢复后仍能补写（不丢事件）", () => {
    const S = sid("d0d");
    setStoragePort(null); // A 态：没有任何存储
    void getEventLog().append(S, "user_message", { messageId: "x", content: "y" });
    setStoragePort(port);
    const S2 = sid("d0d-b");
    seedSession(S2);
    createMessage({ id: "u2", role: "user", content: "端口回来了", timestamp: 1, status: "done" }, S2);
    createMessage({ id: "u2", role: "user", content: "端口回来了", timestamp: 1, status: "done" }, S2);
    expect(eventsOf(S2).filter((e) => e.event_type === "user_message")).toHaveLength(1);
  });
});

// ======================================================================
// P1-D1：SurfaceNotice 不拿空事件日志当事实
// ======================================================================

describe("FC-D1：SurfaceNotice（P1-D1）", () => {
  it("FC-D1a: 事件日志为空（含镜像未就绪）→ 不注入任何结论（返回空串，而不是 Context: 0 visible messages）", () => {
    const S = sid("d1a");
    seedSession(S);
    // 有消息、但一条事件都没有（端口刚起来 / 事件域还没就绪 —— 正是真机常见形态）
    seedMessage({ id: "m1", role: "user", content: "你好", timestamp: 1, status: "done" }, S);
    expect(getEventLog().readAll(S)).toHaveLength(0);
    expect(
      getSurfaceManager().buildSurfaceNotice(S),
      "空的读结果 = 我不知道，不是 0 条 —— 不能把假事实喂进系统提示词",
    ).toBe("");
  });

  it("FC-D1b: 有事件时正常给出条数（注入是准确的）", () => {
    const S = sid("d1b");
    seedSession(S);
    createMessage({ id: "m1", role: "user", content: "你好", timestamp: 1, status: "done" }, S);
    const notice = getSurfaceManager().buildSurfaceNotice(S);
    expect(notice).toContain("1 visible messages");
    expect(notice).toContain("total events");
  });
});

// ======================================================================
// P0-I1：笔记本回合不再全局改写 currentSession
// ======================================================================

describe("FC-I1：笔记本回合与 currentSession（P0-I1）", () => {
  it("FC-I1a: handleNotebookSend 不再改写 currentSession，且把笔记本 id 显式传给 runAgenticLoop", () => {
    const src = appSource();
    const start = src.indexOf("const handleNotebookSend = async");
    expect(start, "handleNotebookSend 必须存在").toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("const handleNotebookCancel", start));
    expect(body, "不许再出现'把笔记本会话写进全局 currentSession'").not.toContain("currentSession: session");
    expect(body, "不许再用裸 setState 改写 project store 的会话").not.toContain("useProjectStore.setState");
    expect(body, "笔记本 id 必须显式传给 loop（setState 是异步的，闭包读到的还是旧值）").toContain(
      "runAgenticLoop(message, session, undefined, { notebookId: nbId })",
    );
  });

  it("FC-I1b: 窗口期内各读写方的判据 —— 面板按 uiSessionId、UI 更新按消息列表归属、落库按列表归属", () => {
    const src = appSource();
    // ① 面板/权限/确认：按"在屏的会话"取值（笔记本模式下 = 消息列表归属）
    expect(src).toContain("const uiSessionId = activeNotebookId");
    expect(src, "写入确认面板必须按 uiSessionId 取值").toContain("pendingWriteConfirms.get(uiSessionId)");
    expect(src, "权限面板必须按 uiSessionId 取值").toContain("pendingPermissions.get(uiSessionId)");
    expect(src, "澄清表单必须按 uiSessionId 取值").toContain("pendingClarifications.get(uiSessionId)");
    // ② runAgenticLoop 的 UI 更新判据：先问消息列表归属
    const viewingIdx = src.indexOf("const isViewingSession = () => {");
    const viewingBody = src.slice(viewingIdx, viewingIdx + 700);
    expect(viewingBody, "UI 更新判据必须以 loadedSessionId 为第一判据").toContain(
      "useAppStore.getState().loadedSessionId === session.id",
    );
    // ③ 自动保存：按 loadedSessionId 落库（不再按 currentSession 认领列表）
    const autoIdx = src.indexOf("// Auto-save messages with debounce");
    const autoEnd = src.indexOf("}, [messages, isStreaming, loadedSessionId]);", autoIdx);
    expect(autoEnd, "自动保存的 effect 依赖里必须有 loadedSessionId").toBeGreaterThan(autoIdx);
    const autoBody = src.slice(autoIdx, autoEnd);
    expect(autoBody, "自动保存必须按列表归属落库").toContain("const owner = loadedSessionId;");
    expect(autoBody, "落库目标不许再用 currentSession.id（认领列表的口径已换成归属）").not.toContain(
      "saveMessages(currentSession",
    );
  });

  it("FC-I1c: 行为 —— 列表属于笔记本会话时 saveMessages 就写笔记本会话（与 currentSession 指向谁无关）", () => {
    const MAIN = sid("i1c-main");
    const NB = sid("i1c-nb");
    seedSession(MAIN);
    seedSession(NB, "notebook:nb1");
    seedMessage({ id: "main-1", role: "user", content: "主聊天的历史", timestamp: 1, status: "done" }, MAIN);
    seedMessage({ id: "nb-1", role: "user", content: "笔记本的历史", timestamp: 1, status: "done" }, NB);

    // 笔记本工作区打开时：消息列表被 loadMessages(笔记本会话) 换成笔记本的
    useAppStore.getState().loadMessages(NB);
    expect(useAppStore.getState().loadedSessionId).toBe(NB);

    // 自动保存的口径 = 列表归属 ⇒ 写笔记本会话（改前的口径是 currentSession.id）
    useAppStore.getState().saveMessages(NB);
    const nbRows = rowsOf("messages").filter((r) => r.session_id === NB);
    expect(nbRows.map((r) => r.id)).toContain("nb-1");
    expect(
      rowsOf("messages").filter((r) => r.session_id === MAIN).map((r) => r.id),
      "主聊天那份列表没被笔记本回合写脏",
    ).toEqual(["main-1"]);

    // 前台回合的落库是**显式**形态：即使 currentSession 指向别的会话也照写自己的会话
    useProjectStore.setState({ currentSession: { id: MAIN } as any });
    useAppStore.getState().saveMessages(NB, [
      { id: "nb-2", role: "user", content: "笔记本回合的新消息", timestamp: 3, status: "done" } as Message,
      { id: "nb-1", role: "user", content: "笔记本的历史", timestamp: 1, status: "done" } as Message,
    ]);
    expect(
      rowsOf("messages").filter((r) => r.session_id === NB).map((r) => r.id).sort(),
      "笔记本回合的消息必须落在笔记本会话里",
    ).toEqual(["nb-1", "nb-2"]);
    expect(
      rowsOf("messages").filter((r) => r.session_id === MAIN).map((r) => r.id),
      "任何一条都不许落进主会话",
    ).toEqual(["main-1"]);
  });
});

// ======================================================================
// P1-I2：同一会话不并发（前台 + 后台共享登记表）
// ======================================================================

describe("FC-I2：前台/后台并发守卫（P1-I2）", () => {
  it("FC-I2a: 前台登记后 isSessionExecuting 为真、后台 executeSessionTurn 被拒绝；注销后恢复", async () => {
    const S = sid("i2a");
    expect(isSessionExecuting(S)).toBe(false);

    startSessionExecution(S);
    expect(isSessionExecuting(S), "前台回合必须登记（改前前台不登记，后台看不见它）").toBe(true);

    const res = await executeSessionTurn({
      sessionId: S,
      message: "后台任务",
      cwd: "C:\\x",
      engine: {} as any,
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("已在执行中");

    endSessionExecution(S);
    expect(isSessionExecuting(S)).toBe(false);
  });

  it("FC-I2b: runAgenticLoop 有前台守卫 + 成对登记（try/finally 覆盖全部早退路径）", () => {
    const src = appSource();
    const idx = src.indexOf("const runAgenticLoop = async (");
    expect(idx, "runAgenticLoop 必须存在").toBeGreaterThan(0);
    const end = src.indexOf("\n  const handleRegenerate", idx);
    const body = src.slice(idx, end > 0 ? end : undefined);
    expect(body).toContain("if (isSessionExecuting(session.id)) {");
    expect(body, "前台回合必须登记进同一张'正在执行'表").toContain("startSessionExecution(session.id);");
    const startAt = body.indexOf("startSessionExecution(session.id);");
    const endAt = body.indexOf("endSessionExecution(session.id);");
    expect(endAt, "注销与登记必须成对（同一函数内）").toBeGreaterThan(startAt);
    expect(
      body.slice(startAt, endAt),
      "登记之后的整个函数体必须包在同一个 try 里 —— 任何早退路径都要能到 finally",
    ).toContain("finally {");
  });
});

// ======================================================================
// P1-I3：委派 cwd 按目标会话所属项目
// ======================================================================

describe("FC-I3：委派回合的工作目录（P1-I3）", () => {
  it("FC-I3a: 委派 cwd 按目标会话 projectId 解析（同文件两条规则统一），不再直接取当前项目", () => {
    const src = appSource();
    expect(src, "必须按目标会话的项目反查路径").toContain("getStoredProject(session.projectId)");
    expect(src, "会话有 worktree 时优先用 worktree").toContain("if (session.worktreePath) {");
    // 不许再出现"先取当前项目当 cwd"的旧写法
    expect(src).not.toContain("const project = useProjectStore.getState().currentProject;\n      let cwd = project?.path");
  });
});

// ======================================================================
// P1-D2：分叉的项目归属 + worktree 的仓库
// ======================================================================

describe("FC-D2：分叉的项目归属（P1-D2）", () => {
  it("FC-D2a: 子会话挂到**源会话**的项目下（而不是当前打开的项目），parent_id 指向源会话", () => {
    const SRC = sid("d2a-src");
    const projA = { id: "proj-A", name: "A", path: "C:\\repoA", createdAt: 1, lastAccessedAt: 1 };
    const projB = { id: "proj-B", name: "B", path: "C:\\repoB", createdAt: 1, lastAccessedAt: 1 };
    useProjectStore.setState({
      projects: [projA, projB] as any,
      currentProject: projA as any, // 用户此刻打开的是 A 项目
      sessions: [
        {
          id: SRC,
          projectId: "proj-B", // 源会话属于 B 项目
          title: "B 项目的会话",
          createdAt: 1,
          lastMessageAt: 2,
          messageCount: 1,
          pinned: false,
        } as any,
      ],
    });
    seedSession(SRC, "proj-B");
    seedMessage({ id: "src-1", role: "user", content: "B 项目的内容", timestamp: 1, status: "done" }, SRC);

    const child = useProjectStore.getState().forkSession(SRC, 0, "Fork: B 项目的会话");

    // ① 落库**内容**：fork 那一笔写进 sessions 的行必须带源项目 + parent_id
    //
    // ⚠️ 这里读"发给引擎的那一笔写"而不是 `__table` 的最终行：假端口的
    // `mode:"replace"` 是**整行替换**，而真引擎的 replace 是
    // `UPDATE(仅提供的列) → 0 行才 INSERT`（`crud.rs:501–509`，并有
    // `crud_upsert_replace_does_not_cascade_delete_children` 断言"未提供的列保持原值"）。
    // 也就是说紧随其后的 `updateSession(child.id, …)` 在真机上保留 parent_id，
    // 在假端口上会把它抹掉 —— 拿假端口的最终行断言 parent_id 会得到一个**假失败**。
    const forkWrite = port
      .__writes()
      .find(
        (w) =>
          w.command === "crud.upsert" &&
          (w.params as any)?.table === "sessions" &&
          Array.isArray((w.params as any)?.rows) &&
          ((w.params as any).rows as Array<Record<string, unknown>>).some((r) => r.id === child.id),
      );
    expect(forkWrite, "fork 必须真的把子会话行写进 sessions").toBeTruthy();
    const writtenRow = ((forkWrite!.params as any).rows as Array<Record<string, unknown>>).find(
      (r) => r.id === child.id,
    )!;
    expect(writtenRow.project_id, "内容来自 B 项目 → 子会话必须挂在 B 项目下（改前挂到当前项目 A）").toBe("proj-B");
    expect(writtenRow.parent_id, "谱系来源（session_trace 的唯一数据源）").toBe(SRC);

    // ② 读回的行内容：project_id 必须真的是 B（改前是"A"）
    const childRow = rowsOf("sessions").find((r) => r.id === child.id);
    expect(childRow, "子会话行必须落地").toBeTruthy();
    expect(childRow?.project_id).toBe("proj-B");
    expect(
      rowsOf("messages").filter((r) => r.session_id === child.id).map((r) => String(r.content)),
      "内容确实来自源会话",
    ).toEqual(["B 项目的内容"]);
  });

  it("FC-D2b: worktree 建在**源会话所属项目**的仓库里（不许在错的仓库 git worktree add）", () => {
    const SRC = sid("d2b-src");
    const projA = { id: "proj-A", name: "A", path: "C:\\repoA", createdAt: 1, lastAccessedAt: 1 };
    const projB = { id: "proj-B", name: "B", path: "C:\\repoB", createdAt: 1, lastAccessedAt: 1 };
    useProjectStore.setState({
      projects: [projA, projB] as any,
      currentProject: projA as any,
      sessions: [
        { id: SRC, projectId: "proj-B", title: "B 的会话", createdAt: 1, lastMessageAt: 2, messageCount: 0, pinned: false } as any,
      ],
    });
    seedSession(SRC, "proj-B");

    const child = useProjectStore.getState().forkSession(SRC, 0, "Fork");

    expect(hoisted.createWorktreeCalls, "worktree 恰好建一次").toHaveLength(1);
    expect(hoisted.createWorktreeCalls[0].projectPath, "必须用源项目 B 的路径，不是当前项目 A").toBe("C:\\repoB");
    expect(hoisted.createWorktreeCalls[0].projectPath).not.toBe("C:\\repoA");
    const childRow = rowsOf("sessions").find((r) => r.id === child.id);
    expect(String(childRow?.worktree_path ?? ""), "worktree_path 必须落在 B 仓库下").toContain("C:\\repoB");
  });

  it("FC-D2c: 删会话时的 worktree 清理也用**该会话所属项目**的路径", () => {
    const SESS = sid("d2c");
    const projA = { id: "proj-A", name: "A", path: "C:\\repoA", createdAt: 1, lastAccessedAt: 1 };
    const projB = { id: "proj-B", name: "B", path: "C:\\repoB", createdAt: 1, lastAccessedAt: 1 };
    useProjectStore.setState({
      projects: [projA, projB] as any,
      currentProject: projA as any, // 当前打开 A
      sessions: [
        {
          id: SESS,
          projectId: "proj-B",
          title: "B 的会话",
          createdAt: 1,
          lastMessageAt: 2,
          messageCount: 0,
          pinned: false,
          executionMode: "git_worktree",
          worktreePath: "C:\\repoB\\.wt\\sess",
        } as any,
      ],
    });
    seedSession(SESS, "proj-B");

    useProjectStore.getState().deleteSession(SESS);

    expect(hoisted.removeWorktreeCalls, "清理恰好一次").toHaveLength(1);
    expect(hoisted.removeWorktreeCalls[0].projectPath, "必须用 B 仓库的根（改前用当前项目 A 的根）").toBe("C:\\repoB");
    expect(hoisted.removeWorktreeCalls[0].worktreePath).toBe("C:\\repoB\\.wt\\sess");
  });
});

// ======================================================================
// P1-D3：分叉继承模式字段 + 附件归属
// ======================================================================

describe("FC-D3：分叉的字段继承与附件归属（P1-D3）", () => {
  it("FC-D3a: 会话级模式字段必须继承（改前被显式写成 null）", () => {
    const SRC = sid("d3a");
    useProjectStore.setState({ projects: [] as any, currentProject: null, sessions: [] });
    seedSession(SRC, "p1", {
      model: "deepseek-chat",
      execution_mode: "current_workspace",
      correction_mode: 1,
      deep_thinking_mode: 1,
      preserve_executor: 0,
      worktree_branch: "feature/x",
    });

    const child = useProjectStore.getState().forkSession(SRC, 0, "Fork");
    const row = rowsOf("sessions").find((r) => r.id === child.id);
    expect(row?.model).toBe("deepseek-chat");
    expect(row?.correction_mode, "纠错模式不能丢").toBe(1);
    expect(row?.deep_thinking_mode, "深度思考模式不能丢").toBe(1);
    expect(row?.preserve_executor).toBe(0);
    expect(row?.worktree_branch).toBe("feature/x");
  });

  it("FC-D3b: 附件 id 换新 —— 源消息的附件不被改指到子会话，子会话拿到的附件正文完整", () => {
    const SRC = sid("d3b");
    useProjectStore.setState({ projects: [] as any, currentProject: null, sessions: [] });
    seedSession(SRC, "p1");
    seedMessage(
      { id: "src-msg", role: "user", content: "带附件的消息", timestamp: 1, status: "done" },
      SRC,
    );
    rowsOf("attachments"); // 触发一次读取（表名常量与生产一致）
    seedRow("attachments", {
      id: "att-1",
      session_id: SRC,
      message_id: "src-msg",
      name: "设计稿.md",
      type: "file",
      path: null,
      content: "附件正文（内联）",
      preview: null,
      sandbox_path: null,
      mime_type: "text/markdown",
      size: 24,
      added_at: 1,
    });

    // 前置：源消息读得到附件（镜像只给元数据、正文留空 —— 正是真机形态）
    const srcVisible = listMessages(SRC).find((m) => m.id === "src-msg");
    expect(srcVisible?.attachments?.map((a) => a.id)).toEqual(["att-1"]);

    const child = useProjectStore.getState().forkSession(SRC, 0, "Fork");

    // ① 源会话那张附件行**原样不动**
    const srcAtt = rowsOf("attachments").find((r) => r.id === "att-1");
    expect(srcAtt?.message_id, "源消息的附件被改指到 fork 会话 = 用户可见的附件凭空消失").toBe("src-msg");
    expect(srcAtt?.session_id).toBe(SRC);
    // ② 子会话拿到**自己的**附件行（新 id + 正确归属 + 正文完整）
    const forkMsg = rowsOf("messages").find((r) => r.session_id === child.id);
    expect(forkMsg, "子会话必须有一条复制来的消息").toBeTruthy();
    const forkAtt = rowsOf("attachments").find((r) => r.message_id === String(forkMsg?.id));
    expect(forkAtt, "子会话必须有属于自己消息的附件行").toBeTruthy();
    expect(String(forkAtt?.id)).not.toBe("att-1");
    expect(String(forkAtt?.session_id)).toBe(child.id);
    expect(String(forkAtt?.content), "附件正文必须带过去（否则是'点开没内容'的假附件）").toBe("附件正文（内联）");
    expect(String(forkAtt?.name)).toBe("设计稿.md");
    // ③ 子会话消息里的附件 id 也必须换新
    const childVisible = listMessages(child.id).find((m) => m.id === String(forkMsg?.id));
    expect(childVisible?.attachments?.map((a) => a.id)).toEqual([String(forkAtt?.id)]);
  });

  it("FC-D3c: copyMessageToSession 同时换新消息 id / 工具调用 id / 附件 id", () => {
    const S = sid("d3c");
    seedSession(S);
    const newId = copyMessageToSession(
      {
        id: "m",
        role: "assistant",
        content: "带工具调用与附件",
        timestamp: 1,
        status: "done",
        toolCalls: [{ id: "tc-1", tool: "read", args: {}, status: "done", result: "ok" }],
        attachments: [{ id: "a-1", name: "f.txt", type: "file", content: "正文" }],
      } as any,
      S,
      "sfx",
    );
    const row = rowsOf("messages").find((r) => r.id === newId);
    expect(newId).toBe("m-fork-sfx");
    expect(row?.content).toBe("带工具调用与附件");
    expect(rowsOf("tool_calls").some((r) => String(r.id).includes("-fork-sfx"))).toBe(true);
    expect(rowsOf("attachments").some((r) => String(r.id).includes("-fork-sfx"))).toBe(true);
  });
});

// ======================================================================
// P2-D6：分叉不再复制事件日志 ⇒ 主键一致
// ======================================================================

describe("FC-D6：分叉的事件与消息主键一致性（P2-D6）", () => {
  it("FC-D6a: 子会话不继承源会话事件；子会话自己的事件全部指向子会话真实存在的消息", () => {
    const SRC = sid("d6a-src");
    useProjectStore.setState({ projects: [] as any, currentProject: null, sessions: [] });
    seedSession(SRC, "p1");
    seedMessage({ id: "s-user", role: "user", content: "源会话的问题", timestamp: 1, status: "done" }, SRC);
    seedMessage({ id: "s-ass", role: "assistant", content: "源会话的回答", timestamp: 2, status: "done" }, SRC);
    // 源会话的事件：消息事件 + 一条会话级反馈（原来会被整段抄给子会话）
    seedEvent(SRC, "user_message", { messageId: "s-user" }, 1);
    seedEvent(SRC, "assistant_text", { messageId: "s-ass" }, 2);
    seedEvent(SRC, "session_meta", { action: "feedback_record" }, 3);

    const child = useProjectStore.getState().forkSession(SRC, 1, "Fork");

    const childEvents = eventsOf(child.id);
    expect(
      childEvents.filter((e) => e.event_type === "session_meta"),
      "会话级事件（反馈等）不该被抄进子会话（否则子会话凭空出现源会话的反馈）",
    ).toHaveLength(0);
    expect(
      childEvents.map((e) => JSON.parse(String(e.payload)).messageId).filter(Boolean),
      "子会话的事件里不许出现源会话的消息 id",
    ).not.toContain("s-user");
    expect(childEvents.map((e) => JSON.parse(String(e.payload)).messageId).filter(Boolean)).not.toContain("s-ass");

    // 子会话的事件主键必须能在子会话的消息表里找到
    const childMessageIds = new Set(rowsOf("messages").filter((r) => r.session_id === child.id).map((r) => String(r.id)));
    expect(childMessageIds.size, "前置：子会话确实有复制来的消息").toBeGreaterThan(0);
    for (const evt of childEvents) {
      const payload = JSON.parse(String(evt.payload)) as { messageId?: string };
      if (!payload.messageId) continue;
      expect(
        childMessageIds.has(payload.messageId),
        `事件 ${evt.event_type} 指向的消息 ${payload.messageId} 必须真实存在于子会话（改前事件抄源 id，全部是孤儿）`,
      ).toBe(true);
    }
    // 反之也要成立：子会话的消息都有对应事件（不变量 checkVisibleRecordedInvariant 的口径）
    const eventMessageIds = new Set(
      childEvents.map((e) => (JSON.parse(String(e.payload)) as { messageId?: string }).messageId).filter(Boolean),
    );
    for (const id of childMessageIds) {
      expect(eventMessageIds.has(id), `子会话消息 ${id} 必须有对应事件`).toBe(true);
    }
  });
});

// ======================================================================
// P1-D4：压缩摘要标记的折叠与级联
// ======================================================================

describe("FC-D4：压缩摘要累积（P1-D4 / C13）", () => {
  const mkMsg = (id: string, role: string, content: string, ts: number) => ({ id, role, content, timestamp: ts });

  it("FC-D4a: 标记前缀判定覆盖自动与手动两种（手动标记原来连扫描都匹配不到）", () => {
    expect([...COMPACTION_MARKER_PREFIXES]).toEqual([
      "[上下文已自动压缩]",
      "[上下文已手动压缩]",
    ]);
    expect(isCompactionMarker({ role: "user", content: "[上下文已自动压缩]\n摘要" })).toBe(true);
    expect(isCompactionMarker({ role: "user", content: "[上下文已手动压缩]\n摘要" })).toBe(true);
    expect(isCompactionMarker({ role: "assistant", content: "[上下文已自动压缩]" })).toBe(false);
    expect(isCompactionMarker({ role: "user", content: "普通消息" })).toBe(false);
  });

  it("FC-D4b: 保留集里的旧标记被折叠进待删集，并作为级联摘要输入", () => {
    // 构造"标记落在保留集里"的形态（标记的时间戳比它之后的若干条更早，
    // 但当保留窗口足够短时它会落进保留集）
    const messages = [
      mkMsg("m1", "user", "早期问题", 1),
      mkMsg("m2", "assistant", "早期回答", 2),
      mkMsg("marker-old", "user", "[上下文已自动压缩]\n## 关键决策\n- 用 A 方案", 3),
      mkMsg("m4", "assistant", "后续回答", 4),
      mkMsg("m5", "user", "最近问题", 5),
    ];
    const plan = foldStaleCompactionMarkers(messages, 3); // 保留最后 3 条 → 标记落进保留集
    expect(plan.foldedMarkers, "保留集里的旧标记必须被折叠（否则它永远留在上下文里）").toBe(1);
    expect(plan.keepCount, "折叠后保留集从标记之后开始（标记与它之前的一并进待删集）").toBe(2);
    expect(plan.existingSummary, "旧摘要必须被取出来当级联输入（summary of summaries）").toContain("用 A 方案");
  });

  it("FC-D4c: 标记不在保留集里时照样能取到级联摘要（并认手动前缀）", () => {
    const messages = [
      mkMsg("marker-manual", "user", "[上下文已手动压缩]\n旧的手动摘要内容", 1),
      mkMsg("m2", "assistant", "a", 2),
      mkMsg("m3", "user", "b", 3),
      mkMsg("m4", "assistant", "c", 4),
    ];
    const plan = foldStaleCompactionMarkers(messages, 2);
    expect(plan.foldedMarkers, "标记本来就在待删集里 → 不需要折叠").toBe(0);
    expect(plan.keepCount).toBe(2);
    expect(plan.existingSummary, "改前只认 [上下文已自动压缩]，手动摘要会被丢掉").toContain("旧的手动摘要内容");
  });

  it("FC-D4d: 没有标记时不改变保留集（既有压缩行为不变）", () => {
    const messages = [mkMsg("m1", "user", "a", 1), mkMsg("m2", "assistant", "b", 2)];
    const plan = foldStaleCompactionMarkers(messages, 1);
    expect(plan.foldedMarkers).toBe(0);
    expect(plan.keepCount).toBe(1);
    expect(plan.existingSummary).toBe("");
  });

  it("FC-D4e: 端到端（真实 doCompactMessages）—— 手动摘要被级联进新摘要，且旧标记被软删、可见标记只剩一条", async () => {
    const S = sid("d4e");
    seedSession(S);
    // 22 条可见消息：第一条是**手动压缩**留下的标记，其余是历史（> 20 条才会真的发生移除）
    seedMessage(
      { id: "marker-manual", role: "user", content: "[上下文已手动压缩]\n关键约束：必须在 Windows 上跑", timestamp: 0, status: "done" },
      S,
    );
    for (let i = 0; i < 21; i++) {
      seedMessage(
        { id: `h${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `历史 ${i}`, timestamp: 10 + i, status: "done" },
        S,
      );
    }
    // 摘要由 LLM 生成：stub provider 会把**收到的级联输入**原样汇报出来，
    // 于是"旧手动摘要有没有进请求"这件事可以直接断言（不必靠猜）
    let seenRequest = "";
    const provider = {
      id: "stub",
      complete: async (req: any) => {
        seenRequest = String(req?.messages?.find((m: any) => m.role === "user")?.content ?? "");
        return {
          content: seenRequest.includes("必须在 Windows 上跑") ? "## 关键上下文\n- 级联成功" : "## 关键上下文\n- 级联丢失",
        };
      },
    };
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      model: "stub",
      securityMode: "full",
      contextWindow: 128000,
    });

    const removed = await (loop as any).doCompactMessages(S, () => ({ safe: true }));
    expect(removed, "22 条里应移除超过 20 条的那部分").toBeGreaterThan(0);
    expect(seenRequest, "旧的手动摘要必须作为'已有摘要'进入摘要请求（改前 existingSummary 恒为空）").toContain(
      "这是之前对话的已有摘要",
    );
    expect(seenRequest).toContain("必须在 Windows 上跑");

    const marker = rowsOf("messages")
      .filter((r) => r.session_id === S && String(r.content ?? "").startsWith("[上下文已自动压缩]"))
      .map((r) => String(r.content));
    expect(marker, "恰好写一条新的自动标记").toHaveLength(1);
    expect(marker[0], "级联必须带上旧的手动摘要（改前 existingSummary 恒为空）").toContain("级联成功");

    const visible = listVisibleMessages(S).map((m) => m.id);
    expect(visible, "旧的手动标记必须被软删（不再留在上下文里）").not.toContain("marker-manual");
    expect(
      listMessages(S).filter((m) => isCompactionMarker(m as any)).length,
      "可见的摘要标记有且仅有一条（不累积）",
    ).toBe(1);
  });
  it("FC-D4f: 连续两次压缩后可见标记仍只有一条（复核：报告说的'标记落在保留集里导致累积'在当前代码里不可复现）", async () => {
    const S = sid("d4f");
    seedSession(S);
    /**
     * ⚠️ **时间是可控制的输入，不是环境噪声**（这条用例原来偶发变红的机制就在这里）。
     *
     * 标记主键原先是 `compact-${Date.now()}`（毫秒粒度，而 `messages.id` 是**全局主键**）。
     * 两次压缩的"写标记"落在同一毫秒时，新标记会写进**刚刚被软删的旧标记那一行**：
     * 引擎对不传 `hidden` 的写入刻意保留 hidden（`repo.rs:1018-1031`），读路径又叠加
     * `message.ts:616` 的 `localHiddenIds`（只增不减）—— 于是标记写成功却读不到，
     * 可见标记**一条都不剩**。冻结时钟把"同一毫秒"从偶发（实测：同一进程里跑 30 次
     * 两连压，11 次撞上）变成**必然发生**，这条用例因此从"偶尔抓到"变成"每次都抓"。
     */
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const provider = { id: "stub", complete: async () => ({ content: "第一版摘要" }) };
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      model: "stub",
      securityMode: "full",
      contextWindow: 128000,
    });
    // 30 条 → 第一次压缩（保留 20，移除 10）
    for (let i = 0; i < 30; i++) {
      seedMessage(
        { id: `a${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `第一批 ${i}`, timestamp: 10 + i, status: "done" },
        S,
      );
    }
    const first = await (loop as any).doCompactMessages(S, () => ({ safe: true }));
    expect(first).toBeGreaterThan(0);
    expect(listVisibleMessages(S).filter((m) => isCompactionMarker(m as any))).toHaveLength(1);

    // 再来 10 条 → 第二次压缩：旧标记必须进入待删集（它永远是可见列表里最旧的一条，
    // 因为标记的时间戳是"它自己那份保留集第一条 - 1"），于是不会累积
    for (let i = 0; i < 10; i++) {
      seedMessage(
        { id: `b${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `第二批 ${i}`, timestamp: 100 + i, status: "done" },
        S,
      );
    }
    const second = await (loop as any).doCompactMessages(S, () => ({ safe: true }));
    expect(second).toBeGreaterThan(0);
    const markers = listVisibleMessages(S).filter((m) => isCompactionMarker(m as any));
    expect(markers, "可见标记仍然只有一条").toHaveLength(1);
    expect(markers[0].content).toContain("[上下文已自动压缩]");
    /**
     * 主键唯一性：两次压缩必须写出**两个不同的**标记主键。时钟不前进时仍然成立 ——
     * 这是"标记不会继承已软删行的 hidden"的根因判据（改前这里是同一个 id，见上面的说明）。
     */
    const markerRows = rowsOf("messages").filter(
      (r) => r.session_id === S && String(r.id).startsWith("compact-"),
    );
    expect(
      markerRows.map((r) => String(r.id)),
      "两次压缩的标记主键必须不同（同一个 ms 前缀 + 进程内序号）",
    ).toHaveLength(2);
    expect(new Set(markerRows.map((r) => String(r.id))).size, "标记主键不许重复").toBe(2);
    expect(
      markerRows.filter((r) => Number(r.hidden ?? 0) === 0).map((r) => String(r.id)),
      "两条标记行里恰好只有本次这条是可见的（另一条是上一次的旧标记，已软删）",
    ).toEqual([markers[0].id]);
    clock.mockRestore();
  });

  it("FC-D4g: 两个会话在同一毫秒压缩 —— 各自的摘要标记必须留在自己的会话里（主键是全局的）", async () => {
    const A = sid("d4g-a");
    const B = sid("d4g-b");
    seedSession(A);
    seedSession(B);
    // 同一毫秒（改前两个会话会生成同一个主键 `compact-${ms}`）
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const provider = { id: "stub", complete: async () => ({ content: "摘要" }) };
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      model: "stub",
      securityMode: "full",
      contextWindow: 128000,
    });
    for (const S of [A, B]) {
      for (let i = 0; i < 30; i++) {
        seedMessage(
          { id: `${S}-m${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `内容 ${i}`, timestamp: 10 + i, status: "done" },
          S,
        );
      }
    }
    await (loop as any).doCompactMessages(A, () => ({ safe: true }));
    await (loop as any).doCompactMessages(B, () => ({ safe: true }));

    for (const S of [A, B]) {
      const rows = rowsOf("messages").filter(
        (r) => r.session_id === S && String(r.id).startsWith("compact-"),
      );
      expect(
        rows.map((r) => String(r.id)),
        "每个会话都必须有自己那一行标记（主键撞车时后写者按主键整行覆盖，前一个会话的行连同归属被抢走）",
      ).toHaveLength(1);
      expect(
        listVisibleMessages(S).filter((m) => isCompactionMarker(m as any)),
        "每个会话的标记都必须读得到（否则那个会话压缩后连摘要都没有）",
      ).toHaveLength(1);
    }
    clock.mockRestore();
  });
});

describe("FC-D5：手动压缩（P1-D5）", () => {
  const seedHistory = (S: string, n: number, first?: { id: string; content: string }) => {
    if (first) {
      seedMessage({ id: first.id, role: "user", content: first.content, timestamp: 0, status: "done" }, S);
    }
    for (let i = 0; i < n; i++) {
      seedMessage(
        { id: `h${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `历史 ${i}`, timestamp: 10 + i, status: "done" },
        S,
      );
    }
  };

  it("FC-D5a: 手动压缩写 compaction 事件（removedMessageIds / summary / before-after 齐全）", () => {
    const S = sid("d5a");
    seedSession(S);
    seedHistory(S, 25);

    const result = manualCompact(S);
    expect(result.removed).toBe(5);
    expect(result.kept).toBe(20);

    const compactions = eventsOf(S).filter((e) => e.event_type === "compaction");
    expect(compactions, "手动压缩必须在事件日志里留下记录（改前一条都不写）").toHaveLength(1);
    const payload = JSON.parse(String(compactions[0].payload));
    expect(payload.removedMessageIds).toHaveLength(5);
    expect(payload.messagesBefore).toBe(25);
    expect(payload.messagesAfter).toBe(21);
    expect(String(payload.summary)).toContain("[上下文已手动压缩]");

    const hidden = rowsOf("messages").filter((r) => r.session_id === S && Number(r.hidden ?? 0) === 1);
    expect(hidden.map((r) => String(r.id)).sort(), "被移除的消息是软删（行仍在库里，反馈外键目标不丢）").toEqual([
      "h0",
      "h1",
      "h2",
      "h3",
      "h4",
    ]);
  });

  it("FC-D5b: 手动压缩期间并发闸门是**真的**置位（UI 自动保存据此退让）", () => {
    const S = sid("d5b");
    seedSession(S);
    seedHistory(S, 25);

    let gateDuringWrite: boolean | null = null;
    /**
     * 用一条自定义包装观察闸门。
     *
     * ## 第 45 轮（线协议 P2-4）：两个通道都要包
     *
     * 手动压缩的删除走 `deleteMessagesByIds` → `message.ts::deleteMessageIndexRows`，
     * 而它现在优先走 `data.command`（结构化回报）—— 只包 `execute` 会让这个观察点
     * **永远不触发**（`gateDuringWrite` 恒为 `null`），用例从"验闸门"退化成"验空转"。
     * 真端口里 `execute` 与 `command` 是同一条 dispatch，所以这里两个都包、判据一致。
     */
    const originalExecute = port.data.execute.bind(port.data);
    const originalCommand = port.data.command!.bind(port.data);
    const observe = (cmd: string) => {
      if (cmd === "messages.delete" && gateDuringWrite === null) gateDuringWrite = isCompactionInProgress();
    };
    (port.data as any).execute = async (cmd: string, params?: Record<string, unknown>) => {
      observe(cmd);
      return originalExecute(cmd as any, params as any);
    };
    (port.data as any).command = async (cmd: string, params?: Record<string, unknown>) => {
      observe(cmd);
      return originalCommand(cmd as any, params as any);
    };

    manualCompact(S);

    expect(gateDuringWrite, "删除动作发生时闸门必须是开的（改前手动压缩从不置位 → 自动保存会写回被删消息）").toBe(true);
    expect(isCompactionInProgress(), "动作结束必须复位（否则自动保存永久停摆）").toBe(false);
    expect(hoisted.compactionGateCalls, "置位/复位成对").toEqual([true, false]);
  });

  it("FC-D5c: 手动压缩把保留集里的旧标记折叠掉，并把旧摘要带进新摘要（反复压缩不累积）", () => {
    const S = sid("d5c");
    seedSession(S);
    // 手动压缩会保留最近 20 条；让待删集里有一条旧的**自动**标记 → 它必须被折叠并级联
    seedHistory(S, 25, { id: "marker-auto", content: "[上下文已自动压缩]\n旧自动摘要：方案是 X" });

    manualCompact(S);

    const markers = rowsOf("messages")
      .filter((r) => r.session_id === S && Number(r.hidden ?? 0) === 0)
      .map((r) => String(r.content ?? ""))
      .filter((c) => isCompactionMarker({ role: "user", content: c }));
    expect(markers, "可见标记只剩本次这一条").toHaveLength(1);
    expect(markers[0]).toContain("[上下文已手动压缩]");
    expect(markers[0], "旧摘要内容必须在（级联），否则第二次手动压缩就把前一次结论丢了").toContain("方案是 X");
    expect(rowsOf("messages").filter((r) => r.session_id === S).find((r) => r.id === "marker-auto")?.hidden).toBe(1);
  });

  it("FC-D5d: 手动压缩的实现里闸门与事件都在（源码级，防止后续被删掉）", () => {
    const src = contextMonitorSource();
    const idx = src.indexOf("export function manualCompact");
    const body = src.slice(idx, src.indexOf("export function ContextMonitor"));
    expect(body).toContain("setCompactionInProgress(true)");
    expect(body).toContain("setCompactionInProgress(false)");
    expect(body).toContain('getEventLog().append(sessionId, "compaction"');
    expect(body).toContain("foldStaleCompactionMarkers");
  });
});
