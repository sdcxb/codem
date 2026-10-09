/**
 * GAP-LIST `O-42`：**「写消息 → 读计数」必须同步可见**，否则未读徽标只能靠「宁可多显示 1 条」兜住。
 *
 * ## 被守的缺陷（时序，逐句对着代码）
 *
 * `markSessionUnread` 的语义是「让这个会话至少显示 1 条未读」：把**已读水位**往下踩一格，
 * 于是 `unreadFor(count, mark) = count - mark` 至少是 1。原来的实现无条件把水位算成
 * `Math.min(known, prev) - 1`，理由写在注释里（第 187 波）：
 * 「`message_count` 由引擎侧 `repo.rs::bump_session_message_count` 维护，镜像隔着一次 IPC，
 *   所以『这条消息的计数落地了没有』在这里看不出来」。
 *
 * 那个理由**在当时的调用顺序下是真的**，而且比注释写的更硬：
 * `App.tsx::safeAddMessage` 里 `deliverOwnedMessage(...)`（= 标未读）**先于**
 * `persistLoopMessages()`（= 写消息）执行 ⇒ 标未读那一刻 `known` **必然是旧值**，
 * 于是水位被踩到 `prev - 1`；随后计数涨上来（`prev + 1`）⇒ `unread = 2` 而实际只有 1 条。
 * 也就是说：**根因不是"算错一条"，而是"标未读发生在写消息之前 + 写路径的计数不同步可见"**。
 *
 * ## 修法与两条不变量
 *
 * ① 写路径让**渲染侧读模型在写入返回时就反映新计数**（`storage/message.ts` 的
 * `messageCountAdjustment`：本进程首次写入的消息 ⇒ 该会话 +1；引擎把权威计数
 * （`messages.upsert_index` 的 `session_message_count`）回传后归零对账）；
 * ② 标未读挪到**写消息之后**（`loop-owned-message.ts` 的 `persist` 回调）。
 * 于是两条不变量同时成立：
 *
 * - **写入后**（计数同步可见）`unreadFor(...)` 必须**恰好等于 1** —— 多一条就是 O-42 记的偏差；
 * - **写入前 / 计数不可见**时仍然**至少 1 条** —— 那是 `-1` 兜底分支存在的唯一理由（不许静默丢）。
 *
 * ## 判据与反向对照
 *
 * | 编号 | 钉什么 | 反向对照 |
 * | --- | --- | --- |
 * | UNREAD-V1 | 写消息 ⇒ 计数**同步**可见（`getSession().messageCount` 立刻 +1）、标未读走**精确分支**（水位一格都不动）、未读**恰好 1** | 同一条用例直接对照"水位若被踩到 anchor-1 ⇒ 未读就是 2"（= 修前的形态）；把精确分支改回踩一格必红（`tools/mutate/specs/unread-191.mjs` 的 MUT-2） |
 * | UNREAD-V2 | 计数**不可见**时（标未读发生在写之前）仍然「至少 1 条」：水位**恰好踩一格**，计数涨上来之后未读恰好 1 | UNREAD-V1 是它的反向对照（可见时**不许**踩那一格）；把兜底改坏（不踩 / 踩两格）必红（MUT-3） |
 *
 * ## 为什么用共享假端口 + 一个"镜像契约"包装
 *
 * 共享假端口 `createFakeStoragePort` **不维护 `sessions.message_count`**
 * （`fake-storage-port.ts:1146-1149` 明写"没有 `bump_session_message_count` 的等价物"），
 * 而真端口的 `applyMessageWrite` / `rust-port.ts` 有那份"写入即刻反映"的契约。
 * 所以这里用一个显式包装把那份契约补上/去掉：
 *
 * - 包上 ⇒ 与真端口同形：写入返回时读模型与镜像都能看到新计数（UNREAD-V1）；
 * - 不包 ⇒ 老实现 / 极简替身的形态：写进去了，但渲染侧**看不到**（UNREAD-V2）。
 *
 * 两种形态都是**真实存在过的端口契约**，不是"为了测而造的开关"：`message.ts` 的写路径
 * 正是按"端口有没有 `applyMessageWrite`"决定要不要把这次写入算进读模型
 * （没有那份契约就不许假装看得见）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { getSession } from "../core/storage/session";
import { __resetMessageCountAdjustment } from "../core/storage/message";
import {
  computeUnreadBySession,
  getSessionReadMark,
  markSessionRead,
  unreadFor,
  __resetReadState,
} from "../core/session/session-read-state";
import { deliverOwnedMessage } from "../core/ui/loop-owned-message";
import { __resetSaveFingerprints, useAppStore, type Message } from "../store";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SESSION = "s-vis";
const ANCHOR = 3;

/** 该会话**引擎/镜像**里的计数（假端口那一列；真机由 `repo.rs::bump_session_message_count` 维护） */
let port: FakeStoragePort;
let engineMessageCount = ANCHOR;

/**
 * 给假端口补上**真端口的那份镜像契约**（`rust-port.ts::applyMessageWrite` →
 * `RustMessageMirror.applyWrite`）：一次新增的写入 ⇒ 该会话计数 +1。
 *
 * 引擎侧的规则逐字对齐（`repo.rs:1348-1350`）：**只有新增行**才 +1（`exists == 0`），
 * 覆盖写不动计数。包装本身是显式的、只在本文件里生效 —— 假端口那一侧一个字节都不改。
 *
 * `present: false` 时把钩子整个**去掉**（= 老实现 / 极简替身的形态）：写进去了，
 * 但渲染侧**看不到**新计数 —— 兜底分支存在的那一半现场。
 */
function withMirrorContract(p: FakeStoragePort, present: boolean): FakeStoragePort {
  const original = p.applyMessageWrite;
  const wrapped = (row: { id: string; session_id: string }) => {
    const sessions = p.__table("sessions");
    const target = sessions.find((r) => String(r.id) === String(row.session_id));
    const messages = p.__table("messages");
    const isNew = !messages.some((r) => String(r.id) === String(row.id));
    original(row);
    if (target && isNew) {
      target.message_count = Number(target.message_count ?? 0) + 1;
      engineMessageCount = Number(target.message_count);
    }
  };
  return new Proxy(p, {
    get(t, prop, recv) {
      /*
       * 钩子缺席必须**真的缺席**（返回 `undefined` 而不是一个空函数）——
       * `message.ts` 的写路径正是按 `typeof port.applyMessageWrite === "function"`
       * 决定要不要把这次写入算进读模型。
       */
      if (prop === "applyMessageWrite") return present ? wrapped : undefined;
      return Reflect.get(t, prop, recv);
    },
  }) as FakeStoragePort;
}

function switchStoreTo(sessionId: string): void {
  useAppStore.getState().loadMessages(sessionId);
}

const notice = (id: string, content: string): Message => ({
  id,
  role: "system",
  content,
  timestamp: 9_000,
  status: "done",
});

/** 建一个只装本会话的假端口；`mirrorContract` 决定有没有"写入即刻反映"的契约 */
async function setup(mirrorContract: boolean): Promise<void> {
  engineMessageCount = ANCHOR;
  const base = createFakeStoragePort({
    seed: {
      sessions: [
        {
          id: SESSION,
          project_id: "p1",
          title: "可见性",
          created_at: 1,
          last_message_at: 2,
          message_count: ANCHOR,
        },
      ],
      messages: [],
    },
  });
  await base.config.warmup();
  port = withMirrorContract(base, mirrorContract);
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  port.domains.ensureLoaded("sessions");
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  resetPersistFailures();
  __resetSaveFingerprints();
  // 读模型增量是**模块级**状态（生命周期 = 进程内一次 IPC 往返）：用例之间必须清掉，
  // 否则上一条用例的增量会漏到这一条（本波第一版正是这样假红的）
  __resetMessageCountAdjustment();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetReadState();
  useAppStore.getState().clearMessages();
});

afterEach(() => {
  setStoragePort(null);
  useAppStore.getState().clearMessages();
  __resetSaveFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("UNREAD-V：写消息 → 读计数同步可见（GAP-LIST O-42）", () => {
  it("UNREAD-V1: 写入后计数立刻可见 ⇒ 标未读不许把水位踩到「多一条」，未读恰好 1", async () => {
    await setup(true);
    switchStoreTo("s-other");

    markSessionRead(SESSION, ANCHOR);
    expect(getSessionReadMark(SESSION), "前置：已读水位 = 锚点值").toBe(ANCHOR);
    expect(getSession(SESSION)?.messageCount, "前置：写之前计数就是锚点值").toBe(ANCHOR);

    const msg = notice("vis-1", "写进去的这一条");
    const r = deliverOwnedMessage({
      sessionId: SESSION,
      message: msg,
      ownCopy: new Map([[msg.id, msg]]),
      // App 的 `saveMessages(session, [...ownCopy.values()])` 那一句按同一语义复刻
      persist: () => useAppStore.getState().saveMessages(SESSION, [msg]),
    });

    // ① 写入**真的**发生了（否则下面的绿是"什么都没做"换来的）
    expect(
      port.__table("messages").filter((x) => String(x.session_id) === SESSION).length,
      "归属会话的库里必须真的多了这一条",
    ).toBe(1);

    // ② 写消息 → 读计数：**同步可见**（这就是 O-42 要的那一条）
    expect(
      getSession(SESSION)?.messageCount,
      "写入返回时读模型必须已经反映新计数（O-42：写消息 → 读计数同步可见）",
    ).toBe(ANCHOR + 1);

    // ③ 标未读走**精确分支**：水位一格都不动（计数已经越过水位，徽标自己就看得见）
    expect(r.markedUnread, "标未读照旧生效（徽标要出现）").toBe(true);
    expect(
      getSessionReadMark(SESSION),
      "计数同步可见时水位**不许**被踩到 anchor - 1（那会让计数涨上来后多显示一条）",
    ).toBe(ANCHOR);

    // ④ 不变量：写入后未读**恰好 1**
    expect(
      unreadFor(Number(getSession(SESSION)?.messageCount ?? 0), getSessionReadMark(SESSION)),
      "写入后未读必须恰好 1（O-42 记的偏差就是这里变成 2）",
    ).toBe(1);

    /*
     * 反向对照（这条判据真的能抓红）：**水位一旦被踩到 anchor - 1**（= 修前的形态），
     * 计数涨上来之后未读就变成 2 而实际只有 1 条 —— 这正是 O-42 的偏差本身。
     * 同一份输入、两种水位，直接对照，不依赖任何实现细节。
     */
    expect(
      unreadFor(ANCHOR + 1, ANCHOR - 1),
      "对照：水位被多踩一格 ⇒ 未读 2（实际 1 条）—— 即被修掉的那个偏差",
    ).toBe(2);
  });

  it("UNREAD-V2: 计数**不可见**时仍然「至少 1 条」—— 水位恰好踩一格（-1 兜底分支的唯一理由）", async () => {
    await setup(false);
    switchStoreTo("s-other");

    markSessionRead(SESSION, ANCHOR);
    expect(getSessionReadMark(SESSION), "前置：已读水位 = 锚点值").toBe(ANCHOR);

    /*
     * ⚠️ **刻意走"先标未读"的形态**（不给 `persist`）：第 187 波的 `safeAddMessage`
     * 就是这个顺序 —— 标的那一刻计数还是旧值。这正是兜底分支唯一要保住的现场：
     * 计数不可见 ⇒ 必须踩一格，否则那条消息在计数涨上来之前**一条都不显示**。
     */
    const msg = notice("inv-1", "先标未读、后写消息");
    const r = deliverOwnedMessage({ sessionId: SESSION, message: msg, ownCopy: new Map([[msg.id, msg]]) });

    expect(r.markedUnread, "计数不可见也必须留下未读痕迹（不许静默丢）").toBe(true);
    expect(
      getSession(SESSION)?.messageCount,
      "反向对照：这个端口**没有**「写入即刻反映到读模型」的契约 ⇒ 读模型停在锚点值",
    ).toBe(ANCHOR);
    expect(
      getSessionReadMark(SESSION),
      "恰好踩一格（anchor - 1）：少踩一条都不显示、多踩一条就变成 2",
    ).toBe(ANCHOR - 1);
    expect(unreadFor(ANCHOR, getSessionReadMark(SESSION)), "此时（计数还是旧值）未读 ≥ 1").toBeGreaterThanOrEqual(1);

    /*
     * 随后消息真的落库（假端口里 `message_count` 由我们自己按引擎语义维护 ——
     * 它就是"渲染侧下一次读到的那一列"）⇒ 未读**恰好 1**：`-1` 兜底没有多显示。
     */
    useAppStore.getState().saveMessages(SESSION, [msg]);
    expect(
      port.__table("messages").filter((x) => String(x.session_id) === SESSION).length,
      "落库这一步必须真的写出这一条",
    ).toBe(1);
    expect(
      unreadFor(engineMessageCount, getSessionReadMark(SESSION)),
      "计数涨上来（引擎的 bump 落地）之后未读恰好 1 —— 这就是「-1 兜底」要保住的不变量",
    ).toBe(1);

    // 批量口径（侧栏读的就是它）：计数可见之前也必须列出这个会话
    expect(
      computeUnreadBySession([{ id: SESSION, messageCount: ANCHOR }])[SESSION] ?? 0,
      "侧栏必须列出它（否则那条消息静默丢）",
    ).toBeGreaterThanOrEqual(1);
  });

  it("UNREAD-V2b: 反向对照的**漂移态** —— 水位比读到的计数高时，兜底必须按「读到的条数」踩一格", async () => {
    /*
     * 这个形态真机上有两个来源（都不是想出来的）：
     * ① `ChatPanel` 推进水位时取 `Math.max(库里计数, store 计数, messages.length)`
     *    —— 任何一次"store 比库里新"都会把水位推到条数**之上**；
     * ② 计数被删除/压缩路径按索引真值重算得**更小**（`reconcileSessionMessageCountById`）。
     * 此时"相对水位踩一格"（`prev - 1`）算出来的未读是 **0** —— 兜底失效、静默丢。
     */
    await setup(false);
    switchStoreTo("s-other");
    const drifted = ANCHOR + 2; // 水位被推高到 5，而读到的条数是 3
    markSessionRead(SESSION, drifted);
    const msg = notice("inv-drift", "漂移态下写的这一条");
    const r = deliverOwnedMessage({ sessionId: SESSION, message: msg, ownCopy: new Map([[msg.id, msg]]) });

    expect(r.markedUnread, "漂移态也必须留下未读痕迹").toBe(true);
    const known = Number(getSession(SESSION)?.messageCount ?? 0);
    expect(known, "反向对照：读到的计数（= 3）比水位（= 5）小").toBeLessThan(drifted);
    expect(
      getSessionReadMark(SESSION),
      "兜底基准是「读到的条数」⇒ 水位必须落在 known - 1（按 prev 踩一格会留下未读 0）",
    ).toBe(known - 1);
    expect(unreadFor(known, getSessionReadMark(SESSION)), "漂移态下未读必须 ≥ 1").toBeGreaterThanOrEqual(1);
    // 反向对照：按水位踩一格 ⇒ 未读 0（兜底失效的形态）
    expect(unreadFor(known, drifted - 1), "对照：按 prev 踩一格 ⇒ 未读 0").toBe(0);
  });

  /**
   * 源码级：**顺序**本身是这批判据的语义（`O-42` 的实质就是顺序 + 同步可见）。
   * 两处调用点都必须把落库交给投递模块（`persist`）—— 否则"先写、后标"只存在于用例里。
   */
  it("UNREAD-V3: App 的两处归属投递都把落库交给投递模块（先写、后标，防后人改回先标后写）", async () => {
    const { readFileSync } = await vi.importActual<typeof import("fs")>("fs");
    const raw = readFileSync("src/App.tsx", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code, "safeAddMessage 必须把 `persistLoopMessages` 交给投递模块").toMatch(
      /deliverOwnedMessage\(\{[^}]*ownCopy: loopMessages[^}]*persist: persistLoopMessages[^}]*\}\)/s,
    );
    expect(code, "deliverToOwningSession 必须把落库交给投递模块（不许再在它之后自己 saveMessages）").toMatch(
      /deliverOwnedMessage\(\{[^}]*persist: \(\) => saveMessages\(owningSession\.id, \[m\]\)[^}]*\}\)/s,
    );
  });
});
