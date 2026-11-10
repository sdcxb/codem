/**
 * P0-0 契约：epoch 的 `kind` / `segmentSeq`（D1 / D3 / E2）。
 *
 * ## 守什么
 *
 * 1. **旧路径零改动**：不传 kind 时写 `compact` / `segmentSeq=1`，
 *    读回来的投影与今天完全一致；
 * 2. **新形态可表达**：`kind="switch"` 能被写入、读回、参与投影，
 *    且**不改变** `[marker, ...cutoff 之后]` 这个形状（switch 只换语义，不换形状）；
 * 3. **不猜**：未知 `kind` 一律降级 `compact` —— 把未知当 switch 会让读路径
 *    误以为需要读完整时间线（D11 那条门禁的被守面）；
 * 4. **`hasSwitchEpoch` 必须扫全部 epoch**，不能只看最新一条：
 *    switch 之后段内还会 compact，最新 epoch 通常是 compact（这正是
 *    `context-view.ts` 三级比较那段注释描述的形态）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyContextCutoff,
  buildContextEpochMetadata,
  hasSwitchEpoch,
  readLatestContextEpoch,
  type ContextEpochMessageLike,
} from "../core/context/context-view";

function msg(id: string, timestamp: number): ContextEpochMessageLike {
  return { id, role: "user", timestamp };
}

function markerFrom(input: Record<string, unknown>): ContextEpochMessageLike {
  const metadata = buildContextEpochMetadata(input as never);
  return {
    id: String(input.epochId),
    role: "user",
    timestamp: Number(input.createdAt ?? 0),
    metadata: metadata ?? undefined,
  };
}

describe("epoch 契约 — kind / segmentSeq", () => {
  it("EC-1: 不传 kind 时写出 compact / segmentSeq=1（旧调用点零改动）", () => {
    const metadata = buildContextEpochMetadata({
      epochId: "compact-100-1",
      cutoffMessageId: "m2",
      createdAt: 100,
    });
    expect(metadata).not.toBeNull();
    const epoch = (metadata as { contextEpoch: Record<string, unknown> }).contextEpoch;
    expect(epoch.kind).toBe("compact");
    expect(epoch.segmentSeq).toBe(1);
  });

  it("EC-2: 显式 switch + 段号可写入并读回", () => {
    const marker = markerFrom({
      epochId: "compact-200-2",
      cutoffMessageId: "m9",
      createdAt: 200,
      removedCount: 3,
      keptCount: 2,
      trigger: "switch",
      kind: "switch",
      segmentSeq: 3,
    });
    const epoch = readLatestContextEpoch([msg("m1", 1), marker]);
    expect(epoch).not.toBeNull();
    expect(epoch?.kind).toBe("switch");
    expect(epoch?.segmentSeq).toBe(3);
    expect(epoch?.cutoffMessageId).toBe("m9");
  });

  it("EC-3: 旧 marker（无 kind / segmentSeq 字段）读回 compact / 1", () => {
    const legacy: ContextEpochMessageLike = {
      id: "compact-10-1",
      role: "user",
      timestamp: 10,
      metadata: {
        contextEpoch: {
          epochId: "compact-10-1",
          seq: 1,
          cutoffMessageId: "m2",
          createdAt: 10,
          removedCount: 1,
          keptCount: 1,
          trigger: "auto",
        },
      },
    };
    const epoch = readLatestContextEpoch([legacy]);
    expect(epoch?.kind).toBe("compact");
    expect(epoch?.segmentSeq).toBe(1);
  });

  it("EC-4: 未知 kind 降级为 compact（不猜 switch）", () => {
    for (const bogus of ["history", "Switch", "", 42, null]) {
      const epoch = readLatestContextEpoch([{
        id: "compact-10-1",
        metadata: { contextEpoch: { epochId: "e", cutoffMessageId: "m2", kind: bogus } },
      } as never]);
      expect(epoch?.kind, `kind=${String(bogus)} 不许被当成 switch`).toBe("compact");
    }
  });

  it("EC-5: hasSwitchEpoch 扫全部 epoch（switch 之后的 compact 不能把它盖掉）", () => {
    const switchEpoch = markerFrom({
      epochId: "compact-100-1",
      cutoffMessageId: "m2",
      createdAt: 100,
      kind: "switch",
      segmentSeq: 2,
    });
    const laterCompact = markerFrom({
      epochId: "compact-300-3",
      cutoffMessageId: "m5",
      createdAt: 300,
      kind: "compact",
      segmentSeq: 2,
    });
    const input = [msg("m1", 1), switchEpoch, msg("m2", 2), msg("m3", 3), laterCompact, msg("m5", 5)];

    expect(readLatestContextEpoch(input)?.epochId, "最新 epoch 是 compact").toBe("compact-300-3");
    expect(hasSwitchEpoch(input), "但历史里确实换过段 ⇒ 必须为真").toBe(true);
  });

  it("EC-6: 没有 switch / 伪 marker / 无 metadata 时 hasSwitchEpoch 为假", () => {
    const compact = markerFrom({ epochId: "compact-100-1", cutoffMessageId: "m2", createdAt: 100 });
    expect(hasSwitchEpoch([])).toBe(false);
    expect(hasSwitchEpoch([msg("m1", 1), compact, msg("m2", 2)])).toBe(false);
    expect(hasSwitchEpoch([
      { id: "user-1", role: "user", timestamp: 5, content: "[上下文已自动压缩] 用户粘回来的" },
      { id: "compact-9-9", role: "user", timestamp: 6 },
    ] as never)).toBe(false);
  });

  it("EC-7: switch epoch 的投影形状与 compact 相同（marker + cutoff 之后），旧段不被删", () => {
    const switchEpoch = markerFrom({
      epochId: "compact-100-1",
      cutoffMessageId: "m2",
      createdAt: 100,
      trigger: "switch",
      kind: "switch",
      segmentSeq: 2,
    });
    const input = [msg("m1", 1), switchEpoch, msg("m2", 2), msg("m3", 3)];
    const out = applyContextCutoff(input);
    expect(out.applied).toBe(true);
    expect(out.epoch?.kind).toBe("switch");
    expect(out.messages.map((m) => m.id)).toEqual(["compact-100-1", "m2", "m3"]);
    /* 完整时间线由调用方拿原始数组：函数不就地裁剪（EC 的模型视图只是投影） */
    expect(input.map((m) => m.id), "输入数组不许被改").toEqual(["m1", "compact-100-1", "m2", "m3"]);
  });

  it("EC-8: segmentSeq 非法值（负数 / NaN / 缺失）一律归 1", () => {
    for (const bogus of [-3, Number.NaN, undefined, "abc"]) {
      const epoch = readLatestContextEpoch([{
        id: "compact-10-1",
        metadata: { contextEpoch: { epochId: "e", cutoffMessageId: "m2", segmentSeq: bogus } },
      } as never]);
      expect(epoch?.segmentSeq).toBe(1);
    }
  });

  /**
   * EC-9（P0 重启缺陷，2026-11）：**新旧由 `createdAt` 决定**，`seq` 只在同刻消歧。
   *
   * 被守的形态（独立复核的现场）：老会话已有 `seq=9` 的 epoch；进程重启后
   * `nextCompactionMarkerId` 的计数器归零，新写入的 epoch 是 `seq=1`。虽然
   * `createdAt` 更新，按 `seq` 优先排序仍会选老那条 ⇒ 模型视图不换段、
   * `currentSegmentInfo` 一直报旧段（静默失效，无任何报错）。
   *
   * 变红方式：把 `selectLatestContextEpoch` 的比较顺序改回 `seq` 优先 ⇒ 本条红。
   */
  it("EC-9: 老 epoch seq=9/createdAt=100 + 新 epoch seq=1/createdAt=200 ⇒ 选新者", () => {
    const oldEpoch = markerFrom({
      epochId: "compact-100-9",
      cutoffMessageId: "m2",
      createdAt: 100,
      seq: 9,
      segmentSeq: 5,
    });
    const newEpoch = markerFrom({
      epochId: "compact-200-1",
      cutoffMessageId: "m6",
      createdAt: 200,
      seq: 1,
      segmentSeq: 6,
    });
    const timeline = [msg("m1", 1), oldEpoch, msg("m2", 2), msg("m3", 3), newEpoch, msg("m6", 6)];

    expect(readLatestContextEpoch(timeline)?.epochId, "createdAt 更新的必须胜出").toBe("compact-200-1");
    expect(
      readLatestContextEpoch([...timeline].reverse())?.epochId,
      "数组位置不是判据：倒序输入也必须是同一条",
    ).toBe("compact-200-1");
    const projection = applyContextCutoff(timeline);
    expect(projection.epoch?.epochId, "投影必须按新 cutoff 切").toBe("compact-200-1");
    expect(projection.messages.map((m) => m.id), "新段只保留新 cutoff 之后").toEqual(["compact-200-1", "m6"]);
  });

  /**
   * EC-10：三级比较的**第二级**仍然保留 —— **同 createdAt 的 seq tie-break**。
   *
   * ⚠️ 这条**不是**「seq 优先」的守卫：`createdAt` 不同时永远 `createdAt` 大者胜
   * （EC-9/EC-11 钉的就是那条）。这里只在**同一时刻（同毫秒）**两次写入时让
   * `seq` 大者胜；`seq` 也相同时，后出现的那条（数组里更靠后 = 后写入）胜。
   * 把本用例误读成「排序以 seq 为主」会让 EC-9 的重启缺陷复活 —— 两件事别混。
   *
   * 为什么必须留着：只把创建时间一起比会让「同毫秒双写」退化成随机选择，
   * 而 `nextCompactionMarkerId` 的存在前提就是"同一毫秒内可以连续压两次"。
   */
  it("EC-10（同 createdAt 的 seq tie-break，不是 seq 优先）: 同 createdAt ⇒ seq 大者胜；同 createdAt 同 seq ⇒ 后出现者胜", () => {
    const seq1 = markerFrom({ epochId: "compact-100-1", cutoffMessageId: "m2", createdAt: 100, seq: 1 });
    const seq2 = markerFrom({ epochId: "compact-100-2", cutoffMessageId: "m5", createdAt: 100, seq: 2 });
    expect(readLatestContextEpoch([seq1, seq2])?.epochId).toBe("compact-100-2");
    expect(readLatestContextEpoch([seq2, seq1])?.epochId, "同刻由 seq 决定，与位置无关").toBe("compact-100-2");

    const later = markerFrom({ epochId: "compact-100-3", cutoffMessageId: "m9", createdAt: 100, seq: 9 });
    const earlier = markerFrom({ epochId: "compact-100-4", cutoffMessageId: "m3", createdAt: 100, seq: 9 });
    expect(readLatestContextEpoch([later, earlier])?.epochId, "同刻同 seq 取后出现的那条").toBe("compact-100-4");
  });

  /**
   * EC-11（重启模拟）：**重置计数器模块**后写出的 epoch 仍必须被选中。
   *
   * 为什么单独一条：EC-9 的 `seq=1` 是手写的。真实重启会重置
   * `compaction-budget.ts` 里那个模块级计数器，于是新 epoch 的 id 尾号回到 1，
   * 而 compact 写路径**没有**显式 `seq` ⇒ `buildContextEpochMetadata` 从 id 尾号取 1。
   * 这条真的 `vi.resetModules()` + 重新 import，按生产写法造 epoch，独立构造两轮，
   * 两轮都必须选新者（证明选择不依赖那个计数器曾经到过几）。
   *
   * 变红方式：比较顺序改回 seq 优先 ⇒ 本条红（选到 seq=9 的老 epoch）。
   */
  it("EC-11: 计数器模块重置（模拟重启）后，两轮独立构造仍选新者", async () => {
    for (let round = 0; round < 2; round += 1) {
      vi.resetModules();
      const freshBudget = await import("../core/llm/compaction-budget");
      const freshId = freshBudget.nextCompactionMarkerId("auto");
      expect(freshId.endsWith("-1"), "重置后的第一枚 marker id 必须以 -1 结尾（计数器归零）").toBe(true);

      const oldEpoch = markerFrom({
        epochId: "compact-100-9",
        cutoffMessageId: "m2",
        createdAt: 100,
        seq: 9,
        segmentSeq: 2,
      });
      /* 生产形态：compact 写路径不给 seq，序号从 id 尾号取（重启后 = 1） */
      const freshMetadata = buildContextEpochMetadata({
        epochId: freshId,
        cutoffMessageId: "m6",
        createdAt: 200,
      });
      expect((freshMetadata as { contextEpoch: { seq: number } }).contextEpoch.seq, "前提：新 epoch 的 seq 确实比老的 9 小").toBe(1);
      const freshEpoch = { id: freshId, role: "user", timestamp: 200, metadata: freshMetadata ?? undefined };
      const timeline = [msg("m1", 1), oldEpoch, msg("m2", 2), msg("m3", 3), freshEpoch, msg("m6", 6)];

      expect(
        readLatestContextEpoch(timeline)?.epochId,
        `第 ${round + 1} 轮：重启后新 epoch 的 seq 更小，但 createdAt 更新 ⇒ 必须选它`,
      ).toBe(freshId);
    }
  });

  /**
   * EC-12（P1-2）：`handoffRef` / `notesRef` —— **有才写、缺省读回 undefined**。
   *
   * 守两件事：
   * 1. 写侧：传入非空引用时两个键都出现且值逐字保留；没有时**整个键都不出现**
   *    （不写空串占位 —— 缺省必须能被读侧表达成"没有这个引用"）；
   * 2. 读侧：旧 marker（完全没有这两个字段）必须照常读出 epoch，且两个引用都是 undefined。
   *
   * 变红方式：把写侧的 `...(handoffRef ? { handoffRef } : {})` 改成恒写（空串会造出
   * "存在但不可读"的引用），或读侧不再返回这两个字段 ⇒ 本条红。
   */
  it("EC-12: handoffRef / notesRef 有才写、旧 marker 缺省兼容", () => {
    const withRefs = buildContextEpochMetadata({
      epochId: "compact-300-2",
      cutoffMessageId: "m9",
      createdAt: 300,
      kind: "switch",
      segmentSeq: 2,
      handoffRef: "compact-300-2",
      notesRef: "note-abc",
    }) as { contextEpoch: Record<string, unknown> };
    expect(withRefs.contextEpoch.handoffRef, "handoff 引用必须写出").toBe("compact-300-2");
    expect(withRefs.contextEpoch.notesRef, "notes 引用必须写出").toBe("note-abc");

    const withoutRefs = buildContextEpochMetadata({
      epochId: "compact-400-1",
      cutoffMessageId: "m3",
      createdAt: 400,
    }) as { contextEpoch: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(withoutRefs.contextEpoch, "handoffRef"), "没有 handoff ⇒ 键不出现").toBe(false);
    expect(Object.prototype.hasOwnProperty.call(withoutRefs.contextEpoch, "notesRef"), "没有 notes ⇒ 键不出现").toBe(false);

    /* 读侧：带引用的 marker 读回原值 */
    const marker = markerFrom({
      epochId: "compact-300-2",
      cutoffMessageId: "m9",
      createdAt: 300,
      kind: "switch",
      segmentSeq: 2,
      handoffRef: "compact-300-2",
      notesRef: "note-abc",
    });
    const epoch = readLatestContextEpoch([msg("m1", 1), marker]);
    expect(epoch?.handoffRef).toBe("compact-300-2");
    expect(epoch?.notesRef).toBe("note-abc");

    /* 旧 marker：没有这两个键，照常读出（不能因此判成"坏 marker"） */
    const legacy: ContextEpochMessageLike = {
      id: "compact-10-1",
      role: "user",
      timestamp: 10,
      metadata: {
        contextEpoch: {
          epochId: "compact-10-1",
          seq: 1,
          cutoffMessageId: "m2",
          createdAt: 10,
        },
      },
    };
    const legacyEpoch = readLatestContextEpoch([legacy]);
    expect(legacyEpoch, "旧 marker 必须照常可读").not.toBeNull();
    expect(legacyEpoch?.handoffRef).toBeUndefined();
    expect(legacyEpoch?.notesRef).toBeUndefined();
  });
});
