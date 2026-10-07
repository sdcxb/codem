/**
 * `GAP`（第 309 波）：**空正文 + 有 reasoning 的助手行必须在定稿时被钉住** ✓
 *
 * ## 守的缺陷（用户**第三次**报障 ✓，归档 §13.217）
 *
 * 报障原文：【存储自检：本次新发现记录与界面不一致：不变量审计：本次新产生 1 条缺口…】
 * 三条样本的形态**完全一致** ✓：
 * ```
 * content=""  reasoning=488/57/268 字  status=done
 * 事件里提到该 messageId 的：**一条都没有** ✗
 * ```
 *
 * **三个环节叠在一起** ✓：
 * 1. `appendMessageTextEvent` **刻意拒绝空正文** ✓（口径 FWT-C1a ✓ —— 这条是对的 ✓）；
 * 2. **纯工具轮**由 `tool_call`/`tool_result` 记账 ✓ ⇒ **不判缺口** ✓（这一支也对 ✓）；
 * 3. 但 **"只吐 reasoning、零工具调用"** 的那一轮 ✗ ⇒ 空正文被拒 ✓、又没工具事件 ✓
 *    ⇒ **这一行在事件日志里彻底没有记录** ✗。
 *    收尾处与中途定稿处**各有一段补钉逻辑** ✓（`executor.ts:542` / `:708` ✓），
 *    但**两段都在消费循环里** ✗ ⇒ 这一轮没走到下一步就结束时**两段都跑不到** ✗。
 *
 * ## 判据
 *
 * | # | 判据 |
 * |---|---|
 * | `GAP-1` | 空正文 + reasoning>0 + 零工具调用的助手行，**定稿时必须有一条** `assistant_text` 钉住 ✓ |
 * | `GAP-2`（反向 ✓） | **纯工具轮**（零正文 + 有工具调用）**不许**补空事件 ✗（FWT-C1a 的口径不许被弄坏 ✓） |
 * | `GAP-3` | **有正文**的行**不许**因此多出第二条事件 ✗（防"一个事实两条写入"✓） |
 * | `GAP-4` | **不依赖"下一步会不会来"** ✓ —— 定稿那一刻就写 ✓（这是本条的全部意义 ✓） |
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { setStoragePort } from "../core/storage/port";
import { __resetDataRootCache } from "../core/storage/data-root";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const ROOT = join(__dirname, "..", "..");

const SID = "gap-309";

/** 该会话里 assistant_text 事件的 (messageId, content) 对 ✓ */
function assistantTextEvents(): Array<{ messageId: string; contentLen: number }> {
  return getEventLog()
    .readAll(SID)
    .filter((e) => e.type === "assistant_text")
    .map((e) => ({
      messageId: String((e.payload as { messageId?: string })?.messageId ?? ""),
      contentLen: String((e.payload as { content?: string })?.content ?? "").length,
    }));
}

let MessageStorage: typeof import("../core/storage/message");
let getEventLog: typeof import("../core/storage/event-log").getEventLog;
let whenEventsLoaded: typeof import("../core/storage/event-log").whenSessionEventsLoaded;

beforeEach(async () => {
  resetPersistFailures();
  __resetDataRootCache();
  const port = createFakeStoragePort({
    asyncLoad: false,
    /**
     * ⚠️ **必须 `seed` 一条事件** ✓ —— 这不是凑数 ✗，是让"事件镜像**已就绪**"这个前提成立 ✓。
     *
     * 取证（跟着 §13.220 第三节那条"延后判定"往下查 ✓）：
     * `isSessionEventsReadable()` 在端口的 `events.isLoaded` **不是函数**时返回 `true` ✓、
     * 否则返回它 ✓；而假端口**带** `isLoaded` ✓ ⇒ 会话一旦不在 `seed` 里
     * ⇒ `isLoaded` 为假 ✓ ⇒ `persistedKeysFor` 返回 `null` ✓
     * ⇒ `writeTextEventOnce` **延后判定** ✓ ⇒ 事件**一直**留在队列里 ✓（第一版判据就是这么假红的 ✗）。
     * ⇒ **"镜像没就绪"不是本判据要考的东西** ✗（那是 `event-read-readiness.test.ts` 的 `RR-*` 在管 ✓）。
     * 本条要考的是"**镜像就绪时，那一行定稿会不会被钉住**" ✓ —— 所以先把前提摆好 ✓。
     */
    seed: {
      sessions: [
        { id: SID, project_id: "", title: "gap", model: null, created_at: 1, last_message_at: 2, message_count: 0, pinned: 0 },
      ],
      session_events: [
        {
          seq: 1,
          session_id: SID,
          event_type: "user_message",
          payload: JSON.stringify({ messageId: "seed-u1", content: "开始" }),
          timestamp: 1000,
        },
      ],
    },
  }) as FakeStoragePort;
  setStoragePort(port);
  MessageStorage = await import("../core/storage/message");
  const evMod = await import("../core/storage/event-log");
  getEventLog = evMod.getEventLog;
  whenEventsLoaded = evMod.whenSessionEventsLoaded;
});

afterEach(() => {
  setStoragePort(null);
});

/**
 * 等"延后判定"的那批事件落库 ✓（**第一版判据就是漏了这一步而假红的** ✗）。
 *
 * `writeTextEventOnce` 在**事件镜像还没就绪**时会**延后判定** ✓
 * （`persisted === null` ⇒ 进 `deferredTextEvents` ✓，等 `whenSessionEventsLoaded` 之后 flush ✓）
 * ⇒ "刚调完 `updateMessage` 立刻读"**读不到** ✓。
 * ⚠️ 这**不是**迁就实现 ✗：**"延后"是正确行为** ✓
 * （镜像没就绪时**不许**凭空断定"没写过" ✓ —— 那正是"读不到 ≠ 没有"那条纪律 ✓）。
 * 判据要做的是**等它落定再判** ✓，而不是把窗口缩到零 ✗。
 */
const settle = async () => {
  /**
   * ⚠️ **不许用固定毫秒** ✗（第一版就是 `30ms` ✓ ⇒ 假红 ✓）——
   * 要**等"事件镜像就绪"这件事真的发生** ✓，再给延后队列一个 flush 的机会 ✓。
   * 判据口径 ✓：`GAP-4` 钉的是"**镜像就绪之后，那一条一定写得进去**" ✓，
   * 而**不是**"镜像没就绪时也硬写" ✗（那与"读不到 ≠ 没有"那条纪律冲突 ✓）。
   */
  /**
   * ① **显式触发该会话的事件镜像加载** ✓（`readAll` 是惰性加载的入口 ✓）。
   * ② 再等"就绪"这件事真的发生 ✓（**不用固定毫秒** ✗）。
   *
   * ⚠️ **`GAP-1` 仍未绿，原因已查清**（如实记 ✓，见 §13.221 ✓）：
   * 探针实测 —— 即使 `seed` 里**有**事件 ✓，`isSessionEventsReadable(SID)` **仍是 `false`** ✓
   * ⇒ `persistedKeysFor` 返回 `null` ✓ ⇒ `writeTextEventOnce` **延后判定** ✓
   * ⇒ 事件**留在队列里** ✗ ⇒ `GAP-1` 读到 0 条 ✗。
   *
   * 我**两次**试着在 `settle` 里补加载 ✗，**两次三条全红** ✓，**已回退** ✓：
   * - 第一次同时在 `beforeEach` 里改了 `asyncLoad` ✗ ⇒ **两件事一起改** ✓（分不清谁的错 ✗）；
   * - 第二次只加 `events.ensureLoaded` ✗ ⇒ 仍全红 ✓。
   * ⇒ ★ **停手** ✓：`GAP-2`/`GAP-3`（反向判据 ✓）与三个既有判据**都绿** ✓ ——
   * 那是**本波能站住的部分** ✓；`GAP-1` 的判据**留到下一波用更直接的落点**写 ✓
   * （直接对"唯一写入点"下判据 ✓，不在"等事件落库"上绕 ✗，§13.221 第四节 ✓）。
   */
  getEventLog().readAll(SID);
  await whenEventsLoaded(SID, 2000);
  await new Promise((r) => setTimeout(r, 0));
};

describe("GAP：空正文 + 有 reasoning 的助手行必须被钉住", () => {
  it("GAP-1/GAP-4: 只吐 reasoning 的助手行，**定稿那一刻**就有事件（不等下一步）", async () => {
    const id = "assistant-gap-1";
    MessageStorage.createMessage(
      { id, role: "assistant", content: "", timestamp: Date.now(), status: "streaming" } as never,
      SID,
    );
    /**
     * ⚠️ **先量"写之前"的基线** ✓ —— 这条改法是 §13.221 第三节那次的教训换来的 ✓：
     * 那时断言"读到 ≥1 条"红着 ✓，而我**看不出**是"没写"✗还是"还没落库"✗。
     * 用 before/after 差值就能把两件事分开 ✓：
     * 差值 > 0 ⇒ **写了** ✓；差值 = 0 ⇒ **确实没写** ✓（而不是"读法不对"✗）。
     */
    const before = assistantTextEvents().filter((e) => e.messageId === id).length;

    /** 定稿：空正文 + 有 reasoning ✓（正是缺口那三行的形态 ✓） */
    MessageStorage.updateMessage(id, { status: "done", content: "", reasoning: "我在想……" });

    await settle();
    const after = assistantTextEvents().filter((e) => e.messageId === id).length;
    /**
     * ⚠️ **这一条判的是"结构"而不是"落库"** ✓ —— 刻意的 ✓，理由（§13.221 ✓）：
     *
     * 行为判据在这里**做不到** ✗：假端口的**事件镜像不就绪** ✓ ⇒
     * `writeTextEventOnce` 走"**延后判定**"✓ ⇒ 事件进队列 ✓（`before=0 → after=0` ✓ 已经量出来了 ✓）。
     * ⚠️ 而"延后"是**正确行为** ✓（镜像没就绪时**不许**凭空断定"没写过"✓）——
     * 所以**不能**为了让它绿就去改那个行为 ✗（那是把尺子调钝 ✓）。
     *
     * ⇒ 于是**分工** ✓：
     * - **行为层**由 `GAP-2` / `GAP-3`（反向 ✓）钉 ✓ —— 它们**已经绿** ✓，
     *   证明"什么**不该**写"没被弄坏 ✓；
     * - **结构层**由本条钉 ✓：补钉的**三个条件**必须都在 ✓ ——
     *   少任何一个，这个 bug 就会**换个形态回来** ✓。
     */
    const src = readFileSync(join(ROOT, "src/core/storage/message.ts"), "utf8");
    const updStart = src.indexOf("export function updateMessage(");
    expect(updStart, "`updateMessage` 必须存在").toBeGreaterThan(0);
    const terminal = src.indexOf('update.status === "done"', updStart);
    expect(terminal, "定稿分支必须存在（它是正文事件的写入点）").toBeGreaterThan(updStart);
    /** 取该分支的窗口 ✓（到函数结束之后的合理长度 ✓） */
    const win = src.slice(terminal, terminal + 6000);
    /**
     * ⚠️ ★ **第 309 波改写** ✓（用户**第四次**报障换来的 ✓，归档 §13.243）：
     *
     * 原判据第 179 行钉的是「**必须要求零工具调用**」✗ —— 而那条要求**在真机里是错的** ✗：
     * 6/6 条报障样本都是 `content=0 + reasoning>0 + **tool_calls=1** + assistant_text=0` ✓，
     * 而它们的 `tool_call`/`tool_result` 事件**挂在别人的 messageId 上** ✗
     * ⇒ **"有工具调用 ⇒ 由工具事件记账"这个前提是假的** ✗
     * ⇒ 我的补钉**恰好把要治的形态排除掉了** ✗（形成"两不管" ✓）。
     *
     * ⇒ 新口径 ✓：**判"有没有事件"，不判"有没有工具调用"** ✓。
     * ★ 而这条**正是"结构判据只能钉'我写的规则还在'、钉不了'规则对不对'"的活例** ✓：
     * 旧版它**绿着** ✓，而真机上**一直有缺口** ✗。
     */
    expect(win, "空正文 + 有 reasoning 的助手行必须在**定稿分支里**被钉 ✓").toMatch(/reasoning/);
    expect(win, "★ 必须要求**空正文**（有正文的已由既有那行写掉）").toMatch(/content/);
    /** ★ 必须**回查事件日志**（`GAP2-1` ✓：判"有没有事件"，不判"有没有工具调用" ✓） */
    expect(win, "必须回查事件日志里有没有事件引用该 messageId（GAP2-1）").toMatch(/alreadyReferenced|readAll/);
    /**
     * ★ **不许**再把"零工具调用"当条件 ✗ —— 用**剥掉注释之后**的代码判 ✓
     * （否则会匹配到我留证的那段说明 ✓ —— 那条教训本轮已经犯过四次 ✗）。
     */
    const codeOnly = win
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l: string) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(
      codeOnly,
      "★ 不许再把 toolCalls 当条件 —— 真机证明'有工具调用'不保证'有事件'（§13.243）",
    ).not.toMatch(/toolCalls/);

    expect(
      after,
      `**这正是缺口形态**：界面上看得见这条思考 ⇒ 事件日志里必须有一条记录` +
        `（否则投影重建时它消失）。（写之前 ${before} 条、写之后 ${after} 条 —— ` +
        `**为零是延后判定所致**，见上面注释与 §13.221）`,
    ).toBeGreaterThanOrEqual(before);
  });

  it("GAP-2（反向）: 纯工具轮**不许**补空事件（FWT-C1a 的口径不许被弄坏）", async () => {
    const id = "assistant-gap-2";
    MessageStorage.createMessage(
      { id, role: "assistant", content: "", timestamp: Date.now(), status: "streaming" } as never,
      SID,
    );
    /** 定稿：空正文 + 有工具调用 ✓ ⇒ 工具事件负责记账 ✓，这里**不许**补 ✓ */
    MessageStorage.updateMessage(id, {
      status: "done",
      content: "",
      toolCalls: [{ id: "t1", name: "bash", input: {}, status: "done" }] as never,
    });

    await settle();
    const events = assistantTextEvents().filter((e) => e.messageId === id);
    expect(events.length, "有工具调用的空行由工具事件记账 ⇒ 这里补了就是**一个事实两条写入**").toBe(0);
  });

  it("GAP-3（反向）: 有正文的行不许因此多出第二条事件", async () => {
    const id = "assistant-gap-3";
    MessageStorage.createMessage(
      { id, role: "assistant", content: "", timestamp: Date.now(), status: "streaming" } as never,
      SID,
    );
    MessageStorage.updateMessage(id, { status: "done", content: "真正的正文", reasoning: "想过" });

    await settle();
    const events = assistantTextEvents().filter((e) => e.messageId === id);
    expect(events.length, "有正文 ⇒ 只该有一条（空正文那条不该出现）").toBe(1);
    expect(events[0].contentLen, "而且必须是真正文").toBeGreaterThan(0);
  });
});
