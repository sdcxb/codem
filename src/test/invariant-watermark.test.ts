/**
 * 不变量审计「水位」的回归契约（第 47 轮真机复核的产物）
 *
 * ## 这一组用例守的是一个**我刚刚亲手引入并被抓到的缺陷**
 *
 * 第 47 轮给不变量审计补上了"上次水位"，用来把**历史缺口**与**本次新产生**分开。
 * 第一版的口径是「水位 = 本次仍然存在的指纹」（允许收缩）。它在单元测试里全绿，
 * 但在真机上当场自相矛盾 —— 同一天三次维护分别报 `fresh = 0`、`0`、`118`/`138`，
 * 而"新产生"的语义是**事件双写又断了一条路**，不该在没人改数据的情况下反复报警。
 *
 * 加临时诊断后拿到决定性数字：
 *
 * ```text
 * presentKeys=777 watermarkKeys=757 newViolations=138 notInWatermark=138
 * ```
 *
 * 水位里**缺了 138 个"本次存在"的指纹**，而上一轮水位正是用它自己的 `presentKeys`
 * 写的 —— 于是唯一的解释是 **`presentKeys` 集合本身会在两次维护之间漂移/收缩**
 * （真机上实测到过 671 / 744 / 777 三种规模，水位也随之从 777 缩到 757）。
 * 报出来的样例逐条比对，**全部落在修复前的历史消息区间里**（不是新消息）。
 *
 * 至于"为什么会收缩"，探针实测排除了一个想当然的解释：把消息行置 `hidden=1`
 * **不会**让不变量看不见它 —— 它读的是 `listMessages`（用户面视图，合并权威 JSONL），
 * 索引裁剪本来就不隐藏历史。所以摆动来自**参与审计的集合组合**（会话集合 ×
 * 各会话可见集合），而不是"隐藏状态翻转"。这正是 `WATERMARK-1` 用**会话集合变小**
 * 来复现同一类收缩的原因（用隐藏状态根本造不出这个状态）。
 *
 * **判据自己会报警，比没有判据更糟** —— 它要么把人吓到不再看告警，要么让真正的新缺口
 * 淹在噪声里。所以口径改成 **并集水位**（只增不减），本文件把六条性质钉成断言。
 *
 * ## 为什么这些用例跑在**真端口契约**上
 *
 * 第 46 轮的教训（见 `SESSION-STATE.md`）：测试双比实现宽松会把缺陷藏起来。
 * 这里的核心是"写进 settings 的值"与"镜像里真的看得到那条消息"，所以一律走
 * `setStoragePort(createFakeStoragePort(...))` + **经端口的写命令**造状态
 * （`port.data.execute`，与既有用例的 `seedRow` 同一种做法），
 * 断言的是**真实的 settings 行**，不是"函数被调用了"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";

const SESSION = "wm-session";
const WATERMARK_KEY = "codem-invariant-watermark";

let port: FakeStoragePort;

/** 经端口写一行（**必须这样**：直接推 `__table` 不动镜像，被测代码读的是镜像） */
function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

function seedSession(id = SESSION) {
  seedRow("sessions", {
    id,
    project_id: "",
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
  });
}

/** 一条**可见、无事件**的助手消息 —— 不变量眼中的"缺口"（VISIBLE_BUT_NOT_RECORDED） */
function seedGapMessage(id: string, over: Record<string, unknown> = {}) {
  seedRow("messages", {
    id,
    session_id: SESSION,
    role: "assistant",
    content: `正文 ${id}`,
    timestamp: 10,
    status: "done",
    hidden: 0,
    trimmed: 0,
    ...over,
  });
}

async function installPort(seed: () => void = () => {}) {
  port = createFakeStoragePort();
  await port.config.warmup();
  setStoragePort(port);
  seed();
  return port;
}

/** 读水位（DB 里的真实值） */
const readWatermark = (): { v: number; at: number; keys: string[] } | null =>
  getSettingJSON<{ v: number; at: number; keys: string[] } | null>(WATERMARK_KEY, null);

/** 某条消息的缺口指纹 */
const fp = (id: string) => `${SESSION}|VISIBLE_BUT_NOT_RECORDED|${id}`;

beforeEach(() => {
  setStoragePort(null);
  localStorage.clear();
  // 测试环境固有噪音：没有 __TAURI__，JSONL 那条腿必然告警
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("不变量水位：并集口径（漂移不许产生假警报）", () => {
  it("WATERMARK-1: 会话集合变小（真机上水位从 777 缩到 757 的那种漂移）→ 水印不许丢，缺口回来也不许报新", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");

    /*
     * 第一次：两个会话，各一条缺口 → 水位 2 键。
     *
     * ⚠️ 为什么用"会话集合变化"来模拟漂移，而不是"把消息置为 hidden"：
     * 探针（`zz-probe` 一次性脚本）实测过 —— 被测实现读的是 `listMessages`，
     * 那是**用户面视图**（合并权威 JSONL），把行置 `hidden=1` 之后它**照样返回**那行
     * （这是设计：索引裁剪不隐藏历史）。所以"隐藏/取消隐藏"在测试里根本造不出
     * 集合变化。真机上那个 671 / 744 / 777 的摆动来自**参与审计的会话集合与
     * 各会话可见集合的组合**，这里用前者来复现同一类收缩。
     */
    await installPort(() => {
      seedSession();
      seedGapMessage("m1");
    });
    // 第二个会话（同一条消息 id 不同会话 → 两个指纹）
    seedRow("sessions", {
      id: "wm-session-2",
      project_id: "",
      title: "第二个",
      model: null,
      created_at: 1,
      last_message_at: 2,
      message_count: 0,
      pinned: 0,
    });
    seedRow("messages", {
      id: "m2",
      session_id: "wm-session-2",
      role: "assistant",
      content: "正文 m2",
      timestamp: 10,
      status: "done",
      hidden: 0,
      trimmed: 0,
    });

    const first = await auditInvariantsForSessions([SESSION, "wm-session-2"]);
    expect(first.violations, "两个会话各一条缺口").toBe(2);
    expect(first.newViolations, "第一次没有水位 → 全算历史缺口").toBe(0);
    expect(readWatermark()!.keys.length, "水位记住两个指纹").toBe(2);

    /*
     * 第二次只审一个会话 —— 集合**变小**。第一版口径在这里把水位写成 1 键（收缩），
     * 于是第三个会话再回来时，它那一条就被判成"新产生"。
     */
    const second = await auditInvariantsForSessions([SESSION]);
    expect(second.violations).toBe(1);
    expect(
      readWatermark()!.keys.length,
      "水位必须**只增不减**（并集口径）；第一版在这里收缩成 1 键 —— 那正是真机假警报的根",
    ).toBe(2);
    expect(readWatermark()!.keys, "而且两个指纹都还在").toContain("wm-session-2|VISIBLE_BUT_NOT_RECORDED|m2");

    // 集合又变回来：那条缺口"重新出现"，但它不是新产生的
    const third = await auditInvariantsForSessions([SESSION, "wm-session-2"]);
    expect(third.violations, "它又是一个缺口").toBe(2);
    expect(
      third.newViolations,
      "但它**不是新产生的** —— 真机上这里报过 118/138 条，逐条比对全部落在历史消息区间（判据自己会报警 = 判据失效）",
    ).toBe(0);
  });

  it("WATERMARK-2: 水位只增不减（新键并进去，老键永不被抹掉）", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");

    await installPort(() => {
      seedSession();
      seedGapMessage("a");
    });
    await auditInvariantsForSessions([SESSION]);
    const afterFirst = readWatermark()!.keys;
    expect(afterFirst).toEqual([fp("a")]);

    // 再加一条新的缺口消息
    seedGapMessage("b");
    await auditInvariantsForSessions([SESSION]);
    const afterSecond = readWatermark()!.keys;

    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    for (const k of afterFirst) {
      expect(afterSecond, `并集口径下 ${k} 必须还在`).toContain(k);
    }
    expect(afterSecond).toContain(fp("b"));
  });

  it("WATERMARK-3: 能力没丢 —— 真正新出现的缺口仍然要报成新产生", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");

    // 基线：一条历史缺口
    await installPort(() => {
      seedSession();
      seedGapMessage("old");
    });
    await auditInvariantsForSessions([SESSION]);

    // 现在出现一条**全新的**消息（本版之后写的），而事件双写没写 ——
    // 这正是这条不变量存在的理由（P0-D0 那一类）
    seedGapMessage("brand-new");
    const out = await auditInvariantsForSessions([SESSION]);

    expect(out.violations, "两条都是缺口").toBe(2);
    expect(
      out.newViolations,
      "新那条必须被报出来 —— 并集水位只去掉噪声，不许把判据做成哑巴",
    ).toBe(1);
  });

  it("WATERMARK-4: 第一次审计（没有水位）→ 全部算历史缺口，并写下水位", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");

    await installPort(() => {
      seedSession();
      seedGapMessage("x1");
      seedGapMessage("x2");
      seedGapMessage("x3");
    });
    expect(readWatermark(), "前提：还没有水位").toBeNull();

    const out = await auditInvariantsForSessions([SESSION]);

    expect(out.violations).toBe(3);
    expect(
      out.newViolations,
      "升级版本后第一次启动绝不能把几百条老缺口报成『本次新产生』—— 那就是第 46 轮修掉的那个假警报",
    ).toBe(0);
    expect(readWatermark()!.keys.length, "但水位必须写下来，供下一轮比对").toBe(3);
  });

  it("WATERMARK-5: 水位形状不对（损坏/被改）→ 按没有水位处理，不伪造『全是新的』", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");

    await installPort(() => {
      seedSession();
      seedGapMessage("y1");
    });
    setSettingJSON(WATERMARK_KEY, { 不是: "水位" });

    const out = await auditInvariantsForSessions([SESSION]);

    expect(out.violations).toBe(1);
    expect(
      out.newViolations,
      "形状不对 = 没有水位 = 全算历史缺口（『读不到』不许被当成『全是新缺口』）",
    ).toBe(0);
    expect(readWatermark()!.keys.length, "并且用本次结果重建成合法水位").toBe(1);
  });

  it("WATERMARK-6: 零个可检查会话 → 三件事实一起为零，且**不动**水位", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");

    await installPort(() => {
      seedSession();
      seedGapMessage("z1");
    });
    await auditInvariantsForSessions([SESSION]);
    const before = readWatermark()!;

    /*
     * `structuralErrors` 与 `unreadableSessions` 是第 60 轮加进返回值的两件事实
     * （事件库结构异常数 / 因事件镜像未就绪而**没检查**的会话数）。
     * 这里**逐字列出**整个形状（而不是只断言其中几个字段）：这个对象就是"审计到底
     * 发生了什么"的完整契约，多一个字段、少一个字段都要在这里留下痕迹。
     */
    const out = await auditInvariantsForSessions([]);

    expect(out).toEqual({
      checked: 0,
      violations: 0,
      newViolations: 0,
      structuralErrors: 0,
      unreadableSessions: 0,
      samples: [],
    });
    expect(readWatermark()!.at, "没跑就不该留下『这次已经报过了』的痕迹").toBe(before.at);
  });

  it("WATERMARK-7: 水位保留**插入顺序**（超限时要靠它丢最旧的键，不能按字典序排）", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");

    /*
     * 故意让插入顺序与字典序**相反**：字典序会把 "aaa…" 排到最前，
     * 而它其实是最后被记住的。若实现还在写回前 sort，这个断言就会红 ——
     * 而"丢最旧"就会变成"丢字典序最小的"，那是完全不同的行为。
     */
    await installPort(() => {
      seedSession();
      seedGapMessage("zzz-oldest"); // 先出现 → 最早被记住
    });
    await auditInvariantsForSessions([SESSION]);

    seedGapMessage("aaa-newest"); // 后出现 → 最晚被记住
    await auditInvariantsForSessions([SESSION]);

    const keys = readWatermark()!.keys;
    expect(keys, "插入顺序必须原样保留（最旧在前）").toEqual([
      fp("zzz-oldest"),
      fp("aaa-newest"),
    ]);
    expect(keys, "按字典序排会把 aaa 放最前 —— 那样就分不出谁最旧了").not.toEqual(
      [...keys].sort(),
    );
  });

  it("WATERMARK-8: 水位**有界** —— 上限内正常并集，且不丢键", async () => {
    const { auditInvariantsForSessions } = await import("../core/storage/maintenance");
    const { __MAX_INVARIANT_WATERMARK_KEYS_FOR_TEST } = await import("../core/storage/maintenance");

    // 上限是 20000：这里不真的造 2 万个缺口（太慢），只验证**上限存在且是个正数**，
    // 以及"远小于上限时一个键都不丢"这条实际会走到的路径。
    expect(
      __MAX_INVARIANT_WATERMARK_KEYS_FOR_TEST,
      "上限必须存在（并集只增不减，没有上限会让 settings 里的值无界增长）",
    ).toBeGreaterThan(0);

    await installPort(() => {
      seedSession();
      for (let i = 0; i < 12; i += 1) seedGapMessage(`cap-${i}`);
    });
    const out = await auditInvariantsForSessions([SESSION]);

    expect(out.violations).toBe(12);
    expect(
      readWatermark()!.keys.length,
      "远小于上限时不许丢任何键",
    ).toBe(12);
  });
});
