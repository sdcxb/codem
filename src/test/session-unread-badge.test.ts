/**
 * 侧栏「会话未读徽标」的真实数据源（第 72 轮审计新增）
 *
 * ## 审计结论（这个文件要守的东西）
 *
 * 那个徽标原来是**死代码**：`Sidebar.tsx` 读 `session.unreadCount`，而全仓
 * **没有任何写入点**（`sessions` 表没有这一列、Rust 侧也没有 `unread_count`）——
 * 组件永远不显示。修法不是给个默认值（那正是本次审计在治的病：界面上的数字没有真实来源），
 * 而是补上**已读水位**这个数据源：未读 = 该会话现在的条数 − 你上次看它时的条数。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | UNREAD-1 | `unreadFor` 语义：无水位 ⇒ 全部条数（新会话）；有水位 ⇒ 差值；水位更大 ⇒ 0 |
 * | UNREAD-2 | `markSessionRead` **只前进不回退**（计数被复核修小时不许把水位拉回去） |
 * | UNREAD-3 | 批量算未读：只有 >0 的会话进结果 |
 * | UNREAD-4 | 一次性迁移：历史会话被标成"已读"；列表为空时**不打标记**（否则会漏掉历史会话） |
 * | UNREAD-5 | 迁移之后新建的会话没有水位 ⇒ 全部条数算未读（"委派出去的子会话有消息"看得见） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetPersistFailures } from "../core/storage/persist-failure";

let port: import("./fake-storage-port").FakeStoragePort;

beforeEach(async () => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort } = await import("../core/storage/port");
  port = createFakeStoragePort({ seed: {} });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  await new Promise((r) => setTimeout(r, 20));
  const { __resetReadState } = await import("../core/session/session-read-state");
  __resetReadState();
});

afterEach(async () => {
  const { setStoragePort } = await import("../core/storage/port");
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
});

describe("会话未读（已读水位）", () => {
  it("UNREAD-1: unreadFor 语义 —— 无水位算全部、有水位算差、水位更大算 0", async () => {
    const { unreadFor } = await import("../core/session/session-read-state");
    expect(unreadFor(0, null), "没有消息就没有未读").toBe(0);
    expect(unreadFor(5, null), "没有水位 = 启用功能之后才出现的会话 ⇒ 全部算未读").toBe(5);
    expect(unreadFor(10, 7), "看过 7 条、现在 10 条 ⇒ 3 条新消息").toBe(3);
    expect(unreadFor(10, 10), "刚好读到最新 ⇒ 0").toBe(0);
    expect(unreadFor(10, 12), "水位比条数大（计数被修正过）⇒ 不许出现负数徽标").toBe(0);
  });

  it("UNREAD-2: markSessionRead 只前进不回退（幂等）", async () => {
    const { markSessionRead, getSessionReadMark } = await import("../core/session/session-read-state");
    markSessionRead("s1", 5);
    expect(getSessionReadMark("s1")).toBe(5);

    markSessionRead("s1", 3); // 计数被复核修小
    expect(getSessionReadMark("s1"), "水位不许被拉回去，否则徽标会凭空冒出来").toBe(5);

    markSessionRead("s1", 5);
    expect(getSessionReadMark("s1")).toBe(5); // 幂等

    markSessionRead("s1", 9);
    expect(getSessionReadMark("s1"), "有新消息、你看了 ⇒ 前进").toBe(9);

    markSessionRead("", 100); // 空 id：忽略
    expect(getSessionReadMark("")).toBeNull();
  });

  it("UNREAD-3: 批量算未读只列出真正有未读的会话", async () => {
    const { markSessionRead, computeUnreadBySession } = await import("../core/session/session-read-state");
    markSessionRead("read-up", 4);
    markSessionRead("partial", 2);
    const out = computeUnreadBySession([
      { id: "read-up", messageCount: 4 },
      { id: "partial", messageCount: 7 },
      { id: "brand-new", messageCount: 3 },
      { id: "empty", messageCount: 0 },
    ]);
    expect(out).toEqual({ partial: 5, "brand-new": 3 });
  });

  it("UNREAD-4: 一次性迁移 —— 历史会话标成已读；列表为空时**不打标记**", async () => {
    const { ensureReadStateInitialized, getSessionReadMark, getReadWatermarks } = await import(
      "../core/session/session-read-state"
    );

    expect(ensureReadStateInitialized([]), "列表为空时不能打标记（会把历史会话整批漏掉）").toBe(false);
    expect(ensureReadStateInitialized([{ id: "old-1", messageCount: 657 }]), "第一次要迁移").toBe(true);
    expect(getSessionReadMark("old-1"), "历史会话按'此刻已读'初始化，不能顶一个 657 的徽标").toBe(657);
    expect(ensureReadStateInitialized([{ id: "old-2", messageCount: 10 }]), "只迁移一次").toBe(false);
    expect(getReadWatermarks()["old-2"], "第二次不再补").toBeUndefined();
  });

  it("UNREAD-5: 迁移之后新建的会话（无水位）全部条数算未读 —— 委派子会话有消息时看得见", async () => {
    const { ensureReadStateInitialized, computeUnreadBySession } = await import("../core/session/session-read-state");
    ensureReadStateInitialized([{ id: "history", messageCount: 100 }]);

    // 迁移之后：被委派的子会话产生了消息（它有 6 条，从没被打开过）
    const out = computeUnreadBySession([
      { id: "history", messageCount: 100 },
      { id: "delegated-child", messageCount: 6 },
    ]);
    expect(out).toEqual({ "delegated-child": 6 });
  });

  it("UNREAD-6: 侧栏确实把算出来的未读传给了会话项（接线不能被悄悄删掉）", async () => {
    const src = await vi.importActual<typeof import("fs")>("fs");
    const raw = src.readFileSync("src/components/Sidebar.tsx", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code, "必须从水位模块取未读").toContain("computeUnreadBySession");
    expect(code, "必须做一次性迁移").toContain("ensureReadStateInitialized");
    expect(code, "每个会话项都要拿到未读数（少一处就有一类会话永远不显示徽标）").toContain("unread={sessionUnread[");
    expect(code, "徽标必须读 prop，而不是那个没人写的 session.unreadCount").not.toContain("session.unreadCount");
    expect(code, "旧的死代码形态（(session.unreadCount as number) || 0）一个字都不许留").not.toContain("unreadCount as number");
  });

  it("UNREAD-7: 正在看的会话由写入点推进水位（否则徽标永远清不掉）", async () => {
    const src = await vi.importActual<typeof import("fs")>("fs");
    const raw = src.readFileSync("src/components/ChatPanel.tsx", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code, "ChatPanel 必须推进已读水位").toContain("markSessionRead(");
    expect(code, "推进时取'库里计数 / store 计数 / 已加载条数'的最大值（估小会凭空多出徽标）").toContain("Math.max(");
  });

  /**
   * ⚠️ 这两条来自**真机核对**（不是想出来的）：第一版实现两个地方都"算得对但看得不对"——
   *
   * 1. 侧栏按 `allSessions` 快照算未读，而那是**上次加载时**的条数；委派出去的子会话在后台
   *    产出消息之后，快照还是旧的 ⇒ 徽标一直不出现（真机实测：0 个徽标，而库里那个会话已有 4 条）；
   * 2. 正在看的会话由 `messages.length` 变化触发推进水位，但最后一条消息**落库**可能晚于那次触发
   *    ⇒ 水位停在 4、库里已是 5 ⇒ 你正在看的会话反挂 1 条未读。
   *
   * 两条的修法都是"按同一频率再算/再推进一次"，所以这里把它们钉死。
   */
  it("UNREAD-8: 未读必须**实时**：侧栏轮询要刷新会话列表；正在看的会话要反复推进水位", async () => {
    const src = await vi.importActual<typeof import("fs")>("fs");
    const sidebar = src.readFileSync("src/components/Sidebar.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const chat = src.readFileSync("src/components/ChatPanel.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

    expect(
      sidebar,
      "侧栏轮询里必须先刷新会话列表（只按旧快照算 = 有新消息也不显示徽标 —— 真机抓到过）。" +
        "判据要落在**轮询体内那一句**上：文件别处（挂载时的那个 effect）也有 loadAllSessions()，" +
        "只断言'文件里出现过'会被它蒙混过去",
    ).toContain("loadAllSessions(); } catch");
    expect(chat, "正在看的会话要按同一频率再推进一次水位（最后一条落库可能晚于 effect）").toContain("setInterval(mark");
  });
});
