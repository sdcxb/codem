/**
 * 第 187 波：App 级消息的**归属投递**（跨会话污染 + "不在屏就静默丢"）
 *
 * ## 被守的缺陷（真机形态）
 *
 * `runAgenticLoop` 拿到的是一个**归属会话**（`session`），而 `App.tsx` 的 `addMessage` 写的是
 * **store 里"当前加载的那份消息列表"**（`loadedSessionId`）—— 两者在 `await` 之后可能已经
 * 不是同一个会话（用户切走了）。于是原来那 6 处裸 `addMessage(...)`
 * （会话忙 / 引擎未初始化 / MiMo 认证缺失 / provider 未配置 / 工作树失败 / 工作树已创建）
 * 把错误气泡加进**别人的会话**里。
 *
 * 改成语义正确的"写进归属会话"之后会冒出第二个问题：用户此刻已经切走 ⇒ 那条气泡他当场看不见
 * （上一轮没敢改它的原因）。所以修法是两面一起：**写进归属会话** + **不在屏就把归属会话标成未读**
 * （走既有的已读水位 ⇒ 侧栏 `session-unread-badge` 出现）。
 *
 * ## 用例与判据
 *
 * | 用例 | 守什么 |
 * | --- | --- |
 * | XSESS-1 | 归属会话不是"在屏会话"时：消息进**归属那份**、不进当前会话的界面列表；落库也只落到归属会话 |
 * | XSESS-2 | 归属会话不在屏 ⇒ 被标成未读（**水位下降** + 未读数 ≥ 1），且**幂等**（不会一路踩低） |
 * | XSESS-3 | 反向对照：归属会话**在屏** ⇒ 照常进界面、水位一动不动、未读 0 |
 * | XSESS-4 | 源码级（**按锚点取段**）：loop 前导段 0 处裸 `addMessage(...)`，6 个早退锚点各自走 `safeAddMessage` |
 * | XSESS-5 | 源码级（**按锚点取段**）：`handleSend` 的 8 处"落库档"全走 `deliverToOwningSession`（内含真落库），7 处"纯界面档"各自的 `[XSESS-5]` 登记与裸投递都在（清单只许变小） |
 * | XSESS-6 | 行为不变量：**被标未读的会话里必须真的有一条能看到的行**（徽标不许指向空会话 = 不许编造数字） |
 *
 * ## 判据为什么用真 store + 假存储端口
 *
 * 落库链条是同步的（`saveMessages` → `MessageStorage.createMessage` → 假端口同步落表），
 * 所以"某个 sessionId 下多了什么"在同一个 tick 内就可见，不需要 await（与
 * `session-ownership.test.ts` 同一套搭法）。未读水位走 `settings` 域，也要先就绪。
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { getSession } from "../core/storage/session";
import {
  computeUnreadBySession,
  getSessionReadMark,
  markSessionRead,
  markSessionUnread,
  unreadFor,
  __resetReadState,
} from "../core/session/session-read-state";
import { useProjectStore } from "../core/store";
import { deliverOwnedMessage } from "../core/ui/loop-owned-message";
import { isSessionOnScreen } from "../core/ui/loop-stream-state";
import { __resetSaveFingerprints, useAppStore, type Message } from "../store";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SESSION_A = "sess-owned-A";
const SESSION_B = "sess-owned-B";
/** A 的消息条数（水位、未读的判据都按它算） */
const A_COUNT = 3;

/**
 * 去掉注释再扫（XSESS-4/5 共用一份：判"投递调用了哪个入口"必须**只看代码**，
 * 注释里出现的名字不算 —— 否则"注释里写着 safeAddMessage"就能蒙混过去）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

let port: FakeStoragePort;

const msg = (id: string, content: string, timestamp = 9_000): Message => ({
  id,
  role: "system",
  content,
  timestamp,
  status: "error",
});

/** 该会话在**索引**里的内容（落库判据） */
const indexedContents = (sid: string): string[] =>
  port
    .__table("messages")
    .filter((r) => r.session_id === sid)
    .map((r) => String(r.content ?? ""));

const indexedRows = (sid: string): number => indexedContents(sid).length;

const storeMessageIds = (): string[] => useAppStore.getState().messages.map((m) => m.id);

/** 把界面切到 B（= 用户在 await 期间切走了，A 不在屏） */
function switchToB(): void {
  useAppStore.getState().loadMessages(SESSION_B);
  // `isSessionOnScreen` 还有一支兜底判据（`currentSession`）—— 这里显式落定，避免别的用例的残留
  useProjectStore.setState({ currentSession: null } as never);
  expect(useAppStore.getState().loadedSessionId, "前置：界面装的是 B 的消息").toBe(SESSION_B);
  expect(isSessionOnScreen(SESSION_A), "前置：A 不在屏").toBe(false);
  expect(isSessionOnScreen(SESSION_B), "前置：B 在屏").toBe(true);
}

beforeEach(async () => {
  resetPersistFailures();
  __resetSaveFingerprints();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: SESSION_A, project_id: "p1", title: "A", created_at: 1, last_message_at: 2, message_count: A_COUNT },
        { id: SESSION_B, project_id: "p1", title: "B", created_at: 1, last_message_at: 2, message_count: 1 },
      ],
      messages: [
        ...[1, 2, 3].map((i) => ({
          id: `a-${i}`,
          session_id: SESSION_A,
          role: "user",
          content: `A 的第 ${i} 条`,
          timestamp: 1_000 + i,
          status: "done",
          hidden: 0,
        })),
        { id: "b-1", session_id: SESSION_B, role: "user", content: "B 的唯一一条", timestamp: 5_000, status: "done", hidden: 0 },
      ],
    },
  });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  port.domains.ensureLoaded("sessions");
  await new Promise((r) => setTimeout(r, 20));
  __resetReadState();

  useAppStore.getState().clearMessages();
  useProjectStore.setState({ currentSession: null } as never);
});

afterEach(() => {
  useAppStore.getState().clearMessages();
  setStoragePort(null);
  __resetSaveFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("XSESS：归属投递（写进归属会话 + 不在屏标未读）", () => {
  it("XSESS-1: 用户切走后投递 —— 消息进归属那份/归属会话的库，**不进**当前会话的界面列表", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    switchToB();

    const bRowsBefore = indexedRows(SESSION_B);
    const ownCopy = new Map<string, Message>();
    const err = msg("err-owned-1", "[Error] LLM Engine 未初始化。");

    const r = deliverOwnedMessage({ sessionId: SESSION_A, message: err, ownCopy });

    expect(r.recorded, "必须记进归属那份（落库来源）").toBe(true);
    expect(ownCopy.get(err.id), "归属那份里就是这条").toBe(err);
    expect(storeMessageIds(), "**当前会话（B）的界面列表一条都不许多**").not.toContain(err.id);

    // App 的落库那一句（`persistLoopMessages` → `saveMessages(session.id, explicit)`）按同一语义复刻
    useAppStore.getState().saveMessages(SESSION_A, [...ownCopy.values()]);

    expect(indexedContents(SESSION_A), "归属会话 A 的库里要有这条").toContain(err.content);
    expect(indexedRows(SESSION_B), "B 的索引行数不许变").toBe(bRowsBefore);
    expect(indexedContents(SESSION_B), "B 的库里不许出现这条").not.toContain(err.content);

    /*
     * 反向对照（这个判据真的能红）：修前的形态是**裸 `addMessage`** ——
     * 写的是"当前加载的那份列表"，于是同一条消息落到 **B** 的界面上（跨会话污染）。
     */
    const polluted = msg("err-bare-1", "[Error] 修前形态：裸 addMessage");
    useAppStore.getState().addMessage(polluted);
    expect(
      storeMessageIds(),
      "对照：裸 addMessage 一定落进当前会话（B）—— 这就是被修掉的那个行为",
    ).toContain(polluted.id);
  });

  it("XSESS-2: 归属会话不在屏 ⇒ 标成未读（水位下降 + 未读 ≥ 1），且幂等", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    // 前置：用户看过 A（水位 = 当前条数）
    markSessionRead(SESSION_A, A_COUNT);
    expect(getSessionReadMark(SESSION_A), "前置：水位 = 3").toBe(A_COUNT);
    expect(computeUnreadBySession([{ id: SESSION_A, messageCount: A_COUNT }]), "前置：没有未读").toEqual({});
    expect(getSession(SESSION_A)?.messageCount, "前置：库里读得到 A 的条数（模块取的就是它）").toBe(A_COUNT);

    switchToB();

    const r = deliverOwnedMessage({
      sessionId: SESSION_A,
      message: msg("err-owned-2", "[Error] MiMo auth not found."),
      ownCopy: new Map(),
    });

    expect(r.onScreen, "A 不在屏").toBe(false);
    expect(r.markedUnread, "不在屏必须留下未读痕迹（不许静默丢）").toBe(true);
    expect(getSessionReadMark(SESSION_A), "水位必须被退一格").toBeLessThan(A_COUNT);
    const unread = computeUnreadBySession([{ id: SESSION_A, messageCount: A_COUNT }]);
    expect(unread[SESSION_A] ?? 0, `A 必须出现在未读里：${JSON.stringify(unread)}`).toBeGreaterThanOrEqual(1);
    expect(unreadFor(A_COUNT, getSessionReadMark(SESSION_A))).toBeGreaterThanOrEqual(1);

    /*
     * 幂等：一轮里每条工具消息都会投递一次 —— 水位不许被一路踩低（既会写出假数字，也是写风暴）。
     * 第一次标记之后"水位 < 条数"本身就已经是"有未读"的状态，后续投递必须什么都不做。
     */
    const afterFirst = getSessionReadMark(SESSION_A);
    deliverOwnedMessage({
      sessionId: SESSION_A,
      message: msg("err-owned-3", "[Error] provider not configured."),
      ownCopy: new Map(),
    });
    expect(getSessionReadMark(SESSION_A), "第二次投递不许再把水位降下去").toBe(afterFirst);
  });

  it("XSESS-3: 反向对照 —— 归属会话正在屏时：照常进界面、水位不动、未读 0", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    markSessionRead(SESSION_A, A_COUNT);
    expect(isSessionOnScreen(SESSION_A), "前置：A 在屏").toBe(true);

    const hero = msg("err-onscreen-1", "[Error] 工作树创建失败，使用本地目录");
    const r = deliverOwnedMessage({ sessionId: SESSION_A, message: hero, ownCopy: new Map() });

    expect(r.onScreen).toBe(true);
    expect(r.markedUnread, "在屏不许被误标未读").toBe(false);
    expect(getSessionReadMark(SESSION_A), "在屏时水位一动不动").toBe(A_COUNT);
    expect(computeUnreadBySession([{ id: SESSION_A, messageCount: A_COUNT }]), "在屏时未读恒 0").toEqual({});

    /*
     * "照常进界面"：App 那一行是 `if (isViewingSession()) addMessage(msg);`
     * （同一个判据，源码级由 XSESS-4 的锚点守着）。这里按同一语义复刻一次，
     * 判据落在**可观察结果**上。
     */
    if (r.onScreen) useAppStore.getState().addMessage(hero);
    expect(storeMessageIds(), "在屏 ⇒ 照常进界面").toContain(hero.id);
  });

  it("XSESS-3b: 水位语义本身 —— 退一格保证 ≥1 条，且绝不抬高/抹掉更早的未读", () => {
    // 有水位、且水位 = 条数（正常态）：退一格
    markSessionRead("s-normal", 5);
    expect(markSessionUnread("s-normal", 5), "标记生效").toBe(true);
    expect(getSessionReadMark("s-normal")).toBe(4);
    expect(unreadFor(5, getSessionReadMark("s-normal"))).toBe(1);

    // 水位比条数大（计数被 `max(...)` 推高过的漂移态）：钉到条数以下，绝不抬高
    markSessionRead("s-drift", 9);
    markSessionUnread("s-drift", 4);
    expect(getSessionReadMark("s-drift"), "只降不升").toBe(3);
    expect(unreadFor(4, getSessionReadMark("s-drift"))).toBe(1);

    // 本来就有更早的未读（水位 3、条数 10）：不许把它抹掉（结果仍是 10 - 2）
    markSessionRead("s-older", 3);
    markSessionUnread("s-older", 10);
    expect(getSessionReadMark("s-older"), "计数已越过水位 ⇒ 什么都不用做").toBe(3);
    expect(unreadFor(10, getSessionReadMark("s-older"))).toBe(7);

    // 没有水位（迁移后新建的会话）：本来就"全部条数算未读"，不凭空造水位
    expect(markSessionUnread("s-new", 6), "没有水位就不需要（也不该）动它").toBe(false);
    expect(getSessionReadMark("s-new")).toBeNull();
    expect(unreadFor(6, getSessionReadMark("s-new"))).toBe(6);

    // 空 id：忽略
    expect(markSessionUnread("", 3)).toBe(false);
  });
});

describe("XSESS-4 源码级同源守卫（按锚点取段，防后人回退）", () => {
  const appPath = path.join(__dirname, "..", "App.tsx");

  /** `runAgenticLoop` 的函数体（与 session-ownership.test.ts 的 SO-4a 同一套锚点） */
  function loopBody(): string {
    const src = readFileSync(appPath, "utf-8");
    const start = src.indexOf("const runAgenticLoop = async (");
    expect(start, "runAgenticLoop 必须存在").toBeGreaterThan(0);
    const rest = src.slice(start);
    const end = rest.indexOf("\n  const handleRegenerate", 1);
    return rest.slice(0, end > 0 ? end : rest.length);
  }

  /** loop 的**前导段**：从函数声明到 `let assistantMsgId`（6 处早退全在里面） */
  function preamble(): string {
    const body = loopBody();
    const end = body.indexOf("let assistantMsgId");
    expect(end, "前导段的结束锚点（let assistantMsgId）必须存在").toBeGreaterThan(0);
    return body.slice(0, end);
  }

  /** 去掉注释（避免"注释里提到 addMessage"造成假阳性） */

  /** 6 处早退各自的**内容锚点**（每条都在 `safeAddMessage({...})` 的正文里） */
  const ANCHORS = [
    "这个会话已有一轮正在执行中",
    "LLM Engine 未初始化",
    "MiMo auth not found",
    // 取到 `\n\nDebug` 为止：同一段前面还有一条文本相同的 `console.warn`（日志，不是消息）
    "not configured.\\n\\nDebug",
    "工作树创建失败",
    "工作树已创建",
  ];

  it("XSESS-4a: 前导段里 0 处裸 addMessage，6 处早退一律 safeAddMessage", () => {
    const code = stripComments(preamble());
    /*
     * "裸"的定义：**任何**不是 `safeAddMessage` 的 `addMessage(...)` 调用 ——
     * 包括 `useAppStore.getState().addMessage(...)`（它的前面是个 `.`，
     * 所以不能靠"前面是不是标识符"来判，必须先把合法的那份抠掉）。
     */
    const withoutSafe = code.replace(/safeAddMessage/g, "SAFE_DELIVER");
    const bare = [...withoutSafe.matchAll(/addMessage\s*\(\{/g)].map((m) => m[0]);
    expect(
      bare,
      `前导段的每条早退都必须写进**归属会话**（safeAddMessage）—— 裸 addMessage 写的是"当前加载的"那个会话：${JSON.stringify(bare)}`,
    ).toEqual([]);

    const safeCalls = [...code.matchAll(/safeAddMessage\s*\(\{/g)].length;
    expect(safeCalls, "6 处早退一处都不许少（删掉一处也是丢信息）").toBe(ANCHORS.length);
  });

  it("XSESS-4b: 6 个锚点各自紧邻的调用是 safeAddMessage（逐条取段，不用「文件里包含某字符串」）", () => {
    const code = stripComments(preamble());
    for (const anchor of ANCHORS) {
      const at = code.indexOf(anchor);
      expect(at, `锚点必须还在：${anchor}`).toBeGreaterThan(0);
      const before = code.slice(Math.max(0, at - 400), at);
      const lastSafe = before.lastIndexOf("safeAddMessage({");
      expect(lastSafe, `「${anchor}」这条消息必须经 safeAddMessage 投递（写进归属会话）`).toBeGreaterThan(-1);
      expect(
        at - (Math.max(0, at - 400) + lastSafe),
        `「${anchor}」紧邻的上一个投递调用就是 safeAddMessage`,
      ).toBeLessThan(400);
    }
  });

  it("XSESS-4c: 投递模块确实被判据覆盖（接线不能被悄悄删掉）", () => {
    const src = readFileSync(appPath, "utf-8");
    const code = stripComments(src);
    expect(code, "App 必须用归属投递模块").toContain("deliverOwnedMessage(");
    expect(code, "safeAddMessage 必须把它当一级语句调用（不在 if 里面）").toMatch(
      /const safeAddMessage[\s\S]{0,600}?deliverOwnedMessage\(/,
    );
    expect(code, "界面那一支仍然只在查看时更新（这条行为不变）").toMatch(
      /if \(isViewingSession\(\)\) addMessage\(msg\);/,
    );
  });
});

/* ======================================================================
 * XSESS-5：`handleSend` 的 8 处"落库档" + 7 处"纯界面档"（第 187 波第二批）
 *
 * 为什么是两档：这 8 处都是**错误 / 不可复现的结果 / 工作区副作用 / 用户自己的输入** ——
 * 必须留档，于是落库 + （不在屏时）未读兜底；剩下 7 处是同步路径上的**纯界面回执**
 * （含 🔍 那种故意不持久化的瞬时进度），它们本来就写的就是归属会话，保持不动，
 * 但各自留一条 `[XSESS-5]` 登记 —— 清单**只许变小 / 改动必须显式登记**。
 * ====================================================================== */

describe("XSESS-5 源码级：handleSend 的归属投递清单（按锚点取段）", () => {
  const appPath = path.join(__dirname, "..", "App.tsx");

  /** `handleSend` 的函数体（到下一个顶层声明为止） */
  function handleSendBody(): string {
    const src = readFileSync(appPath, "utf-8");
    const start = src.indexOf("const handleSend = async (");
    expect(start, "handleSend 必须存在").toBeGreaterThan(0);
    const rest = src.slice(start);
    const end = rest.indexOf("\n  const handleSaveAIResponseAsNote", 1);
    expect(end, "handleSend 的收尾锚点必须存在").toBeGreaterThan(0);
    return rest.slice(0, end);
  }

  /**
   * 7 处"落库档"各自**独占**的内容锚点（都在 `deliverToOwningSession({...})` 的实参里）。
   * 第 8 处（无附件那条用户消息）没有独占锚点 —— `content: userContent` 与带附件那条同形 ——
   * 所以它由"切块后的那一块不含 attachments"来钉。
   */
  const OWNED_ANCHORS = [
    "电脑操作已批准", // /computer 批准·撤销回执（内容不可复现：再输一次是切换不是查询）
    "记忆整合完成", // /memory consolidate 结果（数字不可复现）
    "AGENTS.md 已生成并写入项目根目录", // 工作区真的写了一个文件
    "生成 AGENTS.md 失败", // 真错误
    "反馈已留档到会话", // 留档回执（含 ⚠️ 那条"用户要采取动作"的失败分支）
    "记录反馈失败", // 真错误
    "attachments: syncedAttachments", // 带附件的用户消息（这一轮的输入）
  ];

  /** 7 处"纯界面档"的内容锚点（按**源码里的字面**写法，`\n` 是两字符） */
  const SAFE_ANCHORS = [
    "记忆提取已关闭",
    "记忆提取已开启",
    "记忆状态:",
    "用法：\\n/memory on",
    "未找到项目路径",
    "正在分析项目结构并生成 AGENTS.md",
    "用法：/feedback",
  ];

  it("XSESS-5a: 8 处落库档全走 deliverToOwningSession，且锚点各自唯一对应一处", () => {
    const code = stripComments(handleSendBody());
    const chunks = code.split("deliverToOwningSession(").slice(1);
    expect(chunks.length, "落库档必须是 8 处（少一处 = 有一处退回了裸投递）").toBe(8);

    for (const marker of OWNED_ANCHORS) {
      const hit = chunks.filter((c) => c.includes(marker));
      expect(hit.length, `「${marker}」必须**恰好**落在一处 deliverToOwningSession 的实参里`).toBe(1);
    }

    const plain = chunks.filter((c) => c.includes("content: userContent") && !c.includes("attachments:"));
    expect(plain.length, "无附件那条用户消息也必须走 deliverToOwningSession").toBe(1);
  });

  it("XSESS-5b: 落库档必须**真落库**（标未读与落库同生共死）", () => {
    const code = stripComments(handleSendBody());
    const at = code.indexOf("const deliverToOwningSession");
    expect(at, "handleSend 里必须有归属投递 helper").toBeGreaterThan(-1);
    const block = code.slice(at, code.indexOf("\n    };", at));
    expect(block, "helper 必须调归属投递（不在屏时才会标未读）").toContain("deliverOwnedMessage(");
    expect(block, "在屏仍然照常进界面（判据只有 isSessionOnScreen 一份）").toContain("isSessionOnScreen(");
    expect(
      block,
      "必须**显式落库**（`saveMessages(owningSession.id, [...])`）—— 否则徽标会指向一个打开后什么都看不到的会话（= 编造数字）",
    ).toMatch(/saveMessages\(\s*owningSession\.id\s*,\s*\[/);
    expect(
      block,
      "落库不许依赖「当前加载的那份列表」（无 explicit 的形态会被归属守卫拒绝、还会报一条假失败）",
    ).not.toMatch(/saveMessages\(\s*owningSession\.id\s*\)/);
  });

  it("XSESS-5c: 7 处纯界面档各自有 [XSESS-5] 登记且仍是裸投递（清单只许变小）", () => {
    const raw = handleSendBody();
    const code = stripComments(raw);

    /*
     * ① 清单闸门：handleSend 里只许剩下这 7 处裸投递 ——
     * 多一处 = 某个落库档退回了裸投递；少一处 = 某个纯界面档被改了（那就要同步改这份登记）。
     */
    const withoutOwned = code.replace(/deliverToOwningSession/g, "OWNED_DELIVER");
    const bare = [...withoutOwned.matchAll(/addMessage\s*\(\{/g)].length;
    expect(bare, "handleSend 里的裸投递只许剩下 7 处（同步路径那一批）").toBe(7);

    /*
     * ② 登记与调用点**一对一且按源码顺序**。
     * `[XSESS-5]` 这个 token 在 App.tsx 里**只许出现在这 7 条登记上**（别处注释提到它会让计数错位 ——
     * 第一版"往前 700 字窗口里找登记"就是这样假绿的：窗口会捞到**上一个站点**的登记）。
     */
    const markers = [...raw.matchAll(/\[XSESS-5\]/g)].map((m) => m.index ?? -1);
    expect(markers.length, "7 处纯界面档各要正好一条 XSESS-5 登记（多/少都说明是没登记就改了）").toBe(7);

    SAFE_ANCHORS.forEach((needle, i) => {
      const at = raw.indexOf(needle);
      expect(at, `纯界面档的锚点必须还在：${needle}`).toBeGreaterThan(-1);
      expect(
        markers.filter((p) => p < at).length,
        `「${needle}」的登记必须紧挨在它自己前面、且按源码顺序排第 ${i + 1} 条`,
      ).toBe(i + 1);

      // 反向：它紧邻的投递调用必须仍是**裸** addMessage（不是 deliverToOwningSession）
      const cAt = code.indexOf(needle);
      const before = code.slice(Math.max(0, cAt - 500), cAt);
      expect(
        before.lastIndexOf("addMessage({"),
        `「${needle}」必须保持纯界面投递（同步路径，不该落库、也不该标未读）`,
      ).toBeGreaterThan(before.lastIndexOf("deliverToOwningSession({"));
    });
  });
});

/* ======================================================================
 * XSESS-6：行为不变量 —— 徽标必须指向一条**真能看到的行**
 *
 * 这是"纯界面档不许制造未读徽标"的另一面：**落了库的**才可以标未读。
 * 若哪天有人把落库那一句删掉，徽标就会指向一个打开后什么都没有的会话（编造数字）。
 * 源码那一面由 XSESS-5b 守；这里守的是"这条不变量本身可判"。
 * ====================================================================== */

describe("XSESS-6：标未读与落库同生共死（徽标不许指向空会话）", () => {
  it("XSESS-6a: 投递 + 落库 ⇒ 徽标背后真的多了一条能看到的行", () => {
    useAppStore.getState().loadMessages(SESSION_A);
    markSessionRead(SESSION_A, A_COUNT);
    switchToB();

    const notice = msg("notice-owned-1", "记忆整合完成：合并 3 条重复，清理 1 条过期");
    const ownCopy = new Map<string, Message>();
    const r = deliverOwnedMessage({ sessionId: SESSION_A, message: notice, ownCopy });
    // App 的 deliverToOwningSession 里那一句（XSESS-5b 按取段守着它）
    useAppStore.getState().saveMessages(SESSION_A, [...ownCopy.values()]);

    expect(r.markedUnread, "不在屏 ⇒ 标未读").toBe(true);
    expect(indexedContents(SESSION_A), "徽标背后必须有一条真能看到的行").toContain(notice.content);
    const unread = computeUnreadBySession([{ id: SESSION_A, messageCount: indexedRows(SESSION_A) }]);
    expect(unread[SESSION_A] ?? 0, "未读数按库里真实条数算得出来").toBeGreaterThanOrEqual(1);
  });

  it("XSESS-6b: 反向对照 —— 只标未读、不落库 = 徽标指向一个打开后什么都没有的会话（被禁止的形态）", () => {
    const ghost = "sess-ghost-empty";
    markSessionRead(ghost, 3);
    expect(markSessionUnread(ghost, 3), "标记本身会成功").toBe(true);
    expect(unreadFor(3, getSessionReadMark(ghost)), "徽标说「有 1 条新消息」").toBe(1);
    expect(indexedContents(ghost), "可这个会话里一条新行都没有 ⇒ 这就是编造数字").toEqual([]);
  });
});

