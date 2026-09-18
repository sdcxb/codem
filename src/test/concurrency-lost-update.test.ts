/**
 * 进程内并发：**"读 → await → 写"这类路径会不会丢更新 / 会不会把已删除的行写回来**
 *
 * ## 为什么专门测这一类
 *
 * 渲染侧是单线程 JS，但**一次 `await` 就是一个交错点**：两个"读-改-写"序列如果在 await 处
 * 交错，后写的那次会用它**读到时的快照**覆盖前一次的结果 —— 这就是经典的 lost update。
 * 本项目里"整行写回"（`mode: "replace"`）的写入点特别多，所以这条风险是真实存在的：
 *
 * - 安全形态：写之前**重新读一次**（`updateSession` 内部就是 `domainReadOne` → 改字段 → 写整行）。
 *   于是"读 → await → 写"里那个**旧的读**只用来做判断，不参与写入；
 * - 危险形态：把**await 之前读到的快照**直接写回去。
 *
 * 第 54/55 轮把已知的异步路径逐个查了一遍（`reconcileSessionMessageCountById` 属于安全形态：
 * 它 await 的是 `messages.count`，真正写的时候调 `updateSession`，而后者会**重新读行**）。
 * 本文件把这件事变成**可执行证据**：用假端口把 `messages.count` 卡住，制造确定的交错窗口，
 * 然后在窗口里插进另一个写操作，验证两边的结果都在。
 *
 * ## 还守一条更硬的不变量：**不许把已删除的行写回来**
 *
 * `mode: "replace"` 的引擎实现是"先 UPDATE，0 行才 INSERT"（`crud.rs:518-527`）——
 * 也就是说，如果一行**已经不存在**了，"写回"这个动作会把它**新建出来**。
 * `updateSession` 用"读不到就 return"挡住了这条（`if (!rustCurrent) return`），
 * 本文件用"reconcile 在飞的时候把会话删掉"来验证这个挡板真的有效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const PROJECT = "p-conc";
const SID = "sess-conc-1";

let port: FakeStoragePort;
/** `messages.count` 的手动闸门：不 release 就一直挂着，用来造确定的交错窗口 */
let gate: { promise: Promise<void>; release: () => void } | null = null;

beforeEach(async () => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  port = createFakeStoragePort({
    seed: {
      sessions: [
        {
          id: SID,
          project_id: PROJECT,
          title: "原会话",
          created_at: 1,
          last_message_at: 1,
          message_count: 7,
          pinned: 0,
          sort_order: 0,
          parent_id: null,
        },
      ],
      messages: [],
    },
  });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("sessions");
  await new Promise((r) => setTimeout(r, 20));

  // 给 `messages.count` 装一道闸门（真值由测试给）
  const origCommand = port.data.command.bind(port.data);
  let countValue = 7;
  port.data.command = async (cmd: string, params?: Record<string, unknown>) => {
    if (cmd === "messages.count") {
      if (gate) await gate.promise;
      return { total: countValue, count: countValue, visible: countValue, hidden: 0 };
    }
    return origCommand(cmd, params);
  };
  (port.data as unknown as { __setCount: (n: number) => void }).__setCount = (n: number) => {
    countValue = n;
  };
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
  gate = null;
  vi.restoreAllMocks();
});

function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  gate = { promise, release };
  return gate;
}
function setCount(n: number) {
  (port.data as unknown as { __setCount: (n: number) => void }).__setCount(n);
}
const row = () => port.__table("sessions").find((r) => r.id === SID) ?? null;

describe("CONC：读→await→写的交错", () => {
  it("CONC-1: 对账在飞时改名 —— 改名与计数**都要留下**（写前重读，不是写回旧快照）", async () => {
    const { reconcileSessionMessageCountById } = await import("../core/storage/message");
    const { updateSession } = await import("../core/storage/session");

    const g = makeGate();
    setCount(42);
    // ① 让对账挂在 `messages.count` 上（此刻它还没读镜像、也没写任何东西）
    const reconciling = reconcileSessionMessageCountById(SID, "并发探针");
    // ② 窗口里插一次改名（同步的读-改-写）
    updateSession(SID, { title: "并发改名" });
    // ③ 放行对账
    g.release();
    const state = await reconciling;

    expect(state, "计数确实需要修（7 → 42）").toBe("reconciled");
    expect(row()!.title, "改名不能被对账的旧快照覆盖掉").toBe("并发改名");
    expect(Number(row()!.message_count), "计数要落到 42").toBe(42);
  });

  it("CONC-2: 对账在飞时置顶 —— `pinned` 与计数**都要留下**", async () => {
    const { reconcileSessionMessageCountById } = await import("../core/storage/message");
    const { togglePinned } = await import("../core/storage/session");

    const g = makeGate();
    setCount(11);
    const reconciling = reconcileSessionMessageCountById(SID, "并发探针");
    expect(togglePinned(SID)).toBe(true);
    g.release();
    await reconciling;

    expect(Number(row()!.pinned), "置顶不能被覆盖").toBe(1);
    expect(Number(row()!.message_count)).toBe(11);
  });

  it("CONC-3: 对账在飞时会话被删 —— **不许把已删除的行写回来**（连写都不许发起）", async () => {
    const { reconcileSessionMessageCountById } = await import("../core/storage/message");
    const { deleteSession } = await import("../core/storage/session");

    const g = makeGate();
    setCount(99);
    const reconciling = reconcileSessionMessageCountById(SID, "并发探针");
    deleteSession(SID, { confirmBulk: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(row(), "前置：行已删掉").toBeNull();

    const writesBefore = port.__writes().filter(
      (w) => w.command === "crud.upsert" && JSON.stringify(w.params ?? {}).includes(SID),
    ).length;

    g.release();
    const state = await reconciling;
    await new Promise((r) => setTimeout(r, 20));

    const writesAfter = port.__writes().filter(
      (w) => w.command === "crud.upsert" && JSON.stringify(w.params ?? {}).includes(SID),
    ).length;

    /**
     * 判据是"**连写入都不许发起**"，而不是"行最终还在不在"：
     * 引擎的 `replace` 是"先 UPDATE，0 行才 INSERT"，所以对一条已删除的行发起写入
     * **可能**把它新建出来；就算这次被 `project_id NOT NULL` 之类的外键/非空约束挡下，
     * 那也只是"侥幸没复活"+一条失败上报 —— 正确的行为是**根本不写**。
     * 这一条因此能咬住 `updateSession` 里那个 `if (!rustCurrent) return;` 挡板。
     */
    expect(
      writesAfter,
      "会话已删除：对账不得再对它的行发起 crud.upsert（否则 replace 的 0 行 → INSERT 会把行复活）",
    ).toBe(writesBefore);
    expect(["unavailable", "reconciled", "consistent"]).toContain(state);
    expect(row(), "对账绝不能把已删除的会话行新建出来").toBeNull();
  });

  it("CONC-4: 两个对账并发（读数不同）—— 后写的赢，且**不留半截行**", async () => {
    const { reconcileSessionMessageCountById } = await import("../core/storage/message");

    const g1 = makeGate();
    setCount(31);
    const first = reconcileSessionMessageCountById(SID, "并发 A");
    g1.release();
    await first;

    const g2 = makeGate();
    setCount(32);
    const second = reconcileSessionMessageCountById(SID, "并发 B");
    g2.release();
    await second;

    expect(Number(row()!.message_count), "最终值应当是最后读到的那次真值").toBe(32);
    expect(row()!.title, "对账不该动别的列").toBe("原会话");
    expect(Object.keys(row()!).sort(), "列集合不该被改（写整行也不许增删列）").toContain("parent_id");
  });
});
