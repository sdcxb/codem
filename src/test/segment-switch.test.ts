/**
 * P0-3：规则版 compact/switch（D1 / D2 / D3 / D11）。
 *
 * ## 守什么
 *
 * 1. **决策可解释**：低压力什么都不做、中途只压不切、**水位达标且完成**才切；
 *    每条都给 reason（2026-11 修正：完成态不再「完成即边界」，见 DS-9a/DS-9b）；
 * 2. **switch 不新建 Session、不删消息**：只写一条 `kind="switch"` 的 epoch，
 *    时间线长度 +1，旧消息一条不少；
 * 3. **模型视图 = [handoff marker, ...最近 keep 条]**（与 compact 同形，D3）；
 * 4. **handoff 是机械摘录**：8 段结构齐全，关键事实（最近的用户原话 / 路径）在里面；
 * 5. **诊断可见**：决策写 `context_steward_decision` 事件，不混进用户消息。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage, listMessages, listTimelineMessages } from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { buildSwitchHandoff, decideEpochAction, epochActionForLoop, extractPathsFrom } from "../core/context/segment-switch";
import { performSegmentSwitch } from "../core/storage/context-switch";
import {
  buildContextEpochMetadata,
  readLatestContextEpoch,
  type ContextEpochMessageLike,
} from "../core/context/context-view";

describe("decideEpochAction — 规则版决策", () => {
  it("DS-1: 低于考虑线 ⇒ none（什么都不做）", () => {
    expect(decideEpochAction({ pressure: 0.5 }).action).toBe("none");
  });

  /**
   * DS-9（真机缺陷 · 2026-11 修正）：**完成态也要看水位**。
   *
   * 被守的形态（独立复核的高优先级产品缺陷）：旧实现让完成态无视 `compactionThreshold`
   * —— 只要 `turnCompleted:true` 就 `switch`。历史超过 `keepCount` 之后，**每个用户回合都切一段**：
   * 真实 200 轮不可能只有 3 段，而规模化验收当时用 155 条种子 + 3 个真实回合冒充 200 轮/3 段。
   * 25 §6 P0-3 的口径是「完成任务在**阈值处** switch；未完成在阈值处 compact；
   * 接近 hard / 连压 ≥2 才救援」。
   *
   * 现在拆成**正反两条**（都不许删弱）：
   * - DS-9a 正向：完成 + 压力 ≥ 考虑线（同一 water-level 口径，含恰好等于）⇒ switch；
   * - DS-9b 反向：完成 + 压力 < 考虑线（且没有救援信号）⇒ none（继续当前段）。
   *
   * 变红方式：
   * - 去掉完成态的水位判断（退回「完成即边界」）⇒ DS-9b 红、ICM-1 段数 ≫3 红；
   * - 让水位判断恒 true（例如写成 `threshold = 0`）⇒ DS-9b 红（低压力也 switch）。
   */
  it("DS-9a: 已完成 + 压力达到考虑线 ⇒ switch（同一 water-level 口径，含等于）", () => {
    for (const pressure of [0.8, 0.79, 0.7]) {
      const d = decideEpochAction({ pressure, turnCompleted: true, threshold: 0.7 });
      expect(d.action, `完成态在水位达标时必须换段（pressure=${pressure}）`).toBe("switch");
      expect(d.reason, "理由要写清是「完成 + 水位达标」").toContain("completed");
    }
    /* 恰好等于阈值也要切（`>=` 口径，与压缩触发同一把尺） */
    expect(decideEpochAction({ pressure: 0.7, turnCompleted: true, threshold: 0.7 }).action).toBe("switch");
  });

  it("DS-9b: 已完成 + 压力低于考虑线 ⇒ none（继续当前段，不再每回合切）", () => {
    for (const pressure of [0, 0.01, 0.2, 0.69]) {
      const d = decideEpochAction({ pressure, turnCompleted: true, threshold: 0.7 });
      expect(d.action, `完成态不许无视水位（pressure=${pressure}）`).toBe("none");
      expect(d.reason).toContain("consider");
    }
    /* 反向对照：同一个低压力 + 救援信号（连压 ≥2）时仍要切 —— 证明上一条不是「恒 none」 */
    expect(
      decideEpochAction({ pressure: 0.2, turnCompleted: true, threshold: 0.7, consecutiveCompactions: 2 }).action,
      "连压 ≥2 的救援信号不因完成态修正被削弱",
    ).toBe("switch");
  });

  it("DS-10: 未完成 + 压力远低于阈值 ⇒ none（压力线仍然管中途）", () => {
    for (const pressure of [0, 0.01, 0.2, 0.79]) {
      expect(
        decideEpochAction({ pressure, turnCompleted: false, threshold: 0.8 }).action,
        `中途低于考虑线时什么都不做（pressure=${pressure}）`,
      ).toBe("none");
    }
  });

  it("DS-2: 中途过线 ⇒ compact（不许把任务切走）", () => {
    const d = decideEpochAction({ pressure: 0.75, turnCompleted: false });
    expect(d.action).toBe("compact");
    expect(d.reason).toContain("mid-turn");
  });

  it("DS-3: 已完成 + 压力过考虑线 ⇒ switch（任务边界 + 水位达标）", () => {
    expect(decideEpochAction({ pressure: 0.75, turnCompleted: true }).action).toBe("switch");
    /* 反向对照：同一个人「完成」但压力在考虑线之下 ⇒ 不许切（DS-9b 的同一事实） */
    expect(decideEpochAction({ pressure: 0.5, turnCompleted: true }).action).toBe("none");
  });

  it("DS-4: 接近 hard 线 ⇒ switch，理由要写出来", () => {
    const d = decideEpochAction({ pressure: 0.93, turnCompleted: true });
    expect(d.action).toBe("switch");
    expect(d.reason).toContain("hard");
  });

  it("DS-5: 连续压缩 ≥2 ⇒ 倾向 switch（同样要写明理由）", () => {
    const d = decideEpochAction({ pressure: 0.75, turnCompleted: true, consecutiveCompactions: 2 });
    expect(d.action).toBe("switch");
    expect(d.reason).toContain("consecutive");
  });

  /**
   * DS-6/7/8 是 **loop 边界**的判据：`agentic-loop` 那一段本身要起 provider/工具/存储，
   * 不适合直接驱动；但"开关关闭时永远不许 switch"是门禁级事实，必须有一条不依赖重型
   * loop 的判据。`epochActionForLoop` 就是 loop 实际调用的那个函数（接线见
   * `agentic-loop.ts::trySwitchSegment`）。
   *
   * ⚠️ 2026-11-06 起 `codem-context-config` 的**默认值**是 true（用户授权，D11 兼容矩阵已补）。
   * 这条判据守的是函数自身的 fail-closed 契约：显式 false 或调用方没合并默认值（undefined）
   * 时都必须 none —— 不是「默认关」。
   */
  it("DS-6: 显式关闭 / 字段缺省 ⇒ 永远 none，pressure 再高也不换段", () => {
    for (const pressure of [0.75, 0.95, 1]) {
      expect(
        epochActionForLoop({ segmentEpochs: false, compactionThreshold: 0.7 }, {
          contextPressure: pressure,
          consecutiveCompactions: 5,
        }),
        `开关关闭时 pressure=${pressure} 也不许主张换段`,
      ).toBe("none");
      expect(
        epochActionForLoop({ segmentEpochs: undefined }, { contextPressure: 1, consecutiveCompactions: 5 }),
        "字段缺省（调用方没合并 DEFAULT_CONFIG）按关处理，fail-closed",
      ).toBe("none");
    }
  });

  it("DS-7: 开关打开 + 接近 hard ⇒ switch", () => {
    expect(
      epochActionForLoop({ segmentEpochs: true, compactionThreshold: 0.7 }, {
        contextPressure: 0.95,
        consecutiveCompactions: 0,
      }),
    ).toBe("switch");
  });

  it("DS-8: 开关打开 + 中途一般压力 ⇒ compact（不是 switch）", () => {
    expect(
      epochActionForLoop({ segmentEpochs: true, compactionThreshold: 0.7 }, {
        contextPressure: 0.75,
        consecutiveCompactions: 0,
      }),
    ).toBe("compact");
  });
});

describe("performSegmentSwitch — 写入 switch epoch", () => {
  const S = "sess-segment-switch";

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({
      seed: { sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }] },
    }));
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  function seed(n: number) {
    for (let i = 1; i <= n; i += 1) {
      createMessage({
        id: `m${i}`,
        role: i % 2 === 1 ? "user" : "assistant",
        content: i === 1 ? "第一段的关键约束：不要用 force push" : `消息 ${i}`,
        timestamp: i,
        status: "done",
      }, S);
    }
  }

  it("SS-1: 写一条 kind=switch 的 epoch；旧消息一条不少", () => {
    seed(6);
    const before = listTimelineMessages(S).length;

    const result = performSegmentSwitch(S, { keepCount: 2, now: 1000 });

    expect(result.switched).toBe(true);
    expect(result.segmentSeq).toBe(2);
    expect(result.removed).toBe(4);
    expect(result.kept).toBe(2);
    const timeline = listTimelineMessages(S);
    expect(timeline.length, "只多了一条 marker").toBe(before + 1);
    const marker = timeline.find((m) => m.id === result.epochId)!;
    const epoch = (marker.metadata as Record<string, any>).contextEpoch;
    expect(epoch.kind).toBe("switch");
    expect(epoch.segmentSeq).toBe(2);
    expect(epoch.cutoffMessageId, "cutoff = 最近 keep 条的第一条").toBe("m5");
  });

  it("SS-7: 没有可切的内容（keep ≥ 时间线）不写空段", () => {
    seed(3);
    const result = performSegmentSwitch(S, { keepCount: 10, now: 1000 });
    expect(result.switched, "切不出东西就不许写 marker").toBe(false);
    expect(result.reason).toContain("nothing to cut");
    expect(
      listTimelineMessages(S).filter((m) => (m.metadata as any)?.contextEpoch?.kind === "switch"),
      "时间线里不许出现空段 marker",
    ).toHaveLength(0);
  });

  it("SS-2: 模型视图 = [marker, ...最近 keep 条]（与 compact 同形）", () => {
    seed(6);
    const result = performSegmentSwitch(S, { keepCount: 2, now: 1000 });
    expect(listMessages(S).map((m) => m.id)).toEqual([result.epochId, "m5", "m6"]);
  });

  it("SS-3: handoff 8 段齐全，且带上最近用户原话与路径", () => {
    createMessage({ id: "u1", role: "user", content: "请在 C:\\repo\\src\\a.ts 里修掉这个 bug", timestamp: 1, status: "done" }, S);
    createMessage({ id: "u2", role: "user", content: "别动 public API", timestamp: 2, status: "done" }, S);

    const timeline = listTimelineMessages(S);
    const handoff = buildSwitchHandoff(
      timeline as unknown as Array<{ id: string; role?: string; content?: unknown; timestamp?: number }>,
      timeline as unknown as Array<{ id: string; content?: unknown }>,
      2,
    );

    for (const heading of [
      "## Goals",
      "## Constraints and preferences",
      "## Progress",
      "## Decisions",
      "## Facts to keep",
      "## Open threads",
      "## Next step",
      "## Where to look",
    ]) {
      expect(handoff, `handoff 缺段：${heading}`).toContain(heading);
    }
    expect(handoff).toContain("别动 public API");
    expect(handoff).toContain("C:\\repo\\src\\a.ts");
  });

  it("SS-4: 空会话不写（如实返回原因）", () => {
    const result = performSegmentSwitch(S, { now: 1 });
    expect(result.switched).toBe(false);
    expect(result.reason).toContain("empty");
  });

  it("SS-5: 决策写进 context_steward_decision 事件（诊断面，不混进用户消息）", () => {
    seed(6);
    const result = performSegmentSwitch(S, { keepCount: 2, now: 1000 });
    const events = getEventLog().readRange(S, 1, 50);
    const decision = events.find((e) => e.type === "context_steward_decision");
    expect(decision, "决策事件必须落库").toBeTruthy();
    expect((decision!.payload as Record<string, unknown>).action).toBe("switch");
    expect((decision!.payload as Record<string, unknown>).epochId).toBe(result.epochId);
    /* 模型可见集合里不该多出"系统说明"式用户消息（marker 是既有机制，不算新增通道） */
    expect(listMessages(S).some((m) => String(m.content).includes("steward_decision"))).toBe(false);
  });

  it("SS-6: extractPathsFrom 去重保序、只取像路径的串", () => {
    const paths = extractPathsFrom([
      { content: "看 C:\\repo\\a.ts 和 /var/log/app.log，再看 C:\\repo\\a.ts" },
      { content: "没有路径" },
    ]);
    expect(paths).toEqual(["C:\\repo\\a.ts", "/var/log/app.log"]);
  });

  /**
   * SS-8（P0 重启缺陷 · 写侧）：新段号 = **已有最大段号 + 1**，与 marker id 尾号无关。
   *
   * 被守的形态（独立复核的现场）：老会话已有第 9 段；进程重启后
   * `nextCompactionMarkerId()` 的进程内计数器归零，旧实现让 epoch 的 `seq`（以及由它
   * 派生的段号）跟着 id 尾号走 ⇒ 新段变成 1，排序永远选不中它，
   * `currentSegmentInfo` 一直报旧段。
   *
   * 变红方式：把 `performSegmentSwitch` 的 `segmentSeq` 改回
   * `readLatestContextEpoch(timeline).segmentSeq + 1`，或去掉 `seq: segmentSeq`
   * 让 metadata 从 id 尾号取序号 ⇒ 本条红。
   */
  it("SS-8: 已有第 9 段 ⇒ 新 switch 是第 10 段；seq 与段号都从时间线算，id 尾号不作数", () => {
    seed(6);
    /* 老会话：时间线里已有第 9 段（seq=9），cutoff 在第一段 */
    createMessage({
      id: "compact-100-9",
      role: "user",
      content: "[上下文已自动压缩] 旧段摘要",
      timestamp: 0.5,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-100-9",
        cutoffMessageId: "m1",
        createdAt: 100,
        removedCount: 1,
        keptCount: 5,
        trigger: "auto",
        kind: "switch",
        seq: 9,
        segmentSeq: 9,
      }) ?? undefined,
    }, S);
    /**
     * 第 9 段之后又发生过一次**段内压缩**：它的 `segmentSeq` 缺省是 1，而 `createdAt` 更新。
     * 于是「最新那条」= compact（段号 1）—— 只按最新那条 + 1 会让新段号**回退到 2**。
     * 段号必须取**全时间线最大值**（这条用例就是区分两种算法的形态）。
     */
    createMessage({
      id: "compact-300-7",
      role: "user",
      content: "[上下文已自动压缩] 第 9 段内的压缩",
      timestamp: 0.6,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-300-7",
        cutoffMessageId: "m2",
        createdAt: 300,
        trigger: "auto",
      }) ?? undefined,
    }, S);

    const result = performSegmentSwitch(S, { keepCount: 2, now: 1000 });
    expect(result.switched).toBe(true);
    expect(result.segmentSeq, "已有最大段号 9 ⇒ 新段必须是 10（不是最新那条的 1+1=2）").toBe(10);

    const timeline = listTimelineMessages(S);
    const marker = timeline.find((m) => m.id === result.epochId)!;
    const epoch = (marker.metadata as Record<string, any>).contextEpoch;
    expect(epoch.segmentSeq, "段号不许回退").toBe(10);
    expect(epoch.seq, "epoch 排序号也必须显式给（不能回到 id 尾号计数器）").toBe(10);
    expect(epoch.cutoffMessageId, "新 epoch 的 cutoff 必须是这次切段真实保留集的第一条").toBe("m5");
    expect(
      readLatestContextEpoch(timeline as unknown as ContextEpochMessageLike[])?.epochId,
      "新 epoch 必须是最新那条（否则读侧又选回旧段）",
    ).toBe(result.epochId);
    /* 新 cutoff 生效：模型视图只保留新的 keep（旧 cutoff 之后的旧消息不再全露） */
    expect(listMessages(S).map((m) => m.id)).toEqual([result.epochId, "m5", "m6"]);
  });

  /**
   * SS-9（P0 重启缺陷 · 读侧）：老 epoch `seq=9`、新 epoch 尾号归零 `seq=1`，
   * 但新者 `createdAt` 更新 ⇒ 模型视图必须切到新 cutoff。
   *
   * 为什么不复用 `performSegmentSwitch` 造新 epoch：写侧修复后它已经显式给段号了，
   * 而这条守的是**已经存在于库里的数据形态** —— compact 写路径仍从 id 尾号取 `seq`，
   * 重启后就是 `seq=1`；修复前写下的 switch 也是同一形态。选择规则必须对它们成立。
   *
   * 变红方式：`selectLatestContextEpoch` 改回 `seq` 优先 ⇒ 本条红（选到老 cutoff，
   * 模型视图露出 m2–m6 而不是只剩 m6）。
   */
  it("SS-9: 重启后新 epoch 的 seq 更小但 createdAt 更新 ⇒ 模型视图切到新 cutoff", () => {
    seed(6);
    /* 老 epoch：序号大、创建得早（cutoff = m2）；时间戳放在历史之前，免得它落在新 cutoff 之后 */
    createMessage({
      id: "compact-100-9",
      role: "user",
      content: "[上下文已自动压缩] 重启前的检查点",
      timestamp: 0.5,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-100-9",
        cutoffMessageId: "m2",
        createdAt: 100,
        trigger: "auto",
      }) ?? undefined,
    }, S);
    /* 新 epoch：重启后计数器归零 ⇒ id 尾号 1 ⇒ metadata.seq=1（没显式给 seq） */
    createMessage({
      id: "compact-200-1",
      role: "user",
      content: "[上下文已自动压缩] 重启后的检查点",
      timestamp: 200,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-200-1",
        cutoffMessageId: "m6",
        createdAt: 200,
        trigger: "auto",
      }) ?? undefined,
    }, S);

    const timeline = listTimelineMessages(S);
    const newEpochId = "compact-200-1";
    expect(
      readLatestContextEpoch(timeline as unknown as ContextEpochMessageLike[])?.epochId,
      "createdAt 更新的新 epoch 必须胜出（seq 小不算旧）",
    ).toBe(newEpochId);
    expect(listMessages(S).map((m) => m.id), "模型视图 = [新 marker, 新 cutoff 之后]").toEqual([newEpochId, "m6"]);
  });
});
