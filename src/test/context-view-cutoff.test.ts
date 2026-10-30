/**
 * 上下文检查点读侧契约（G0 第 1 步）。
 *
 * 这里只测纯函数：没有 epoch 时**行为与旧实现一致**；有 epoch 时按
 * `cutoffMessageId` 裁剪；任何异常都 fail-open + warning，不静默丢/不返回空。
 */
import { describe, expect, it } from "vitest";
import { applyContextCutoff, buildContextEpochMetadata, type ContextEpochMessageLike } from "../core/context/context-view";

function msg(id: string, timestamp: number): ContextEpochMessageLike {
  return { id, role: "user", timestamp };
}

function epochMarker(
  id: string,
  cutoffMessageId: string,
  seq: number,
  timestamp: number,
  metadataOverride?: Record<string, unknown>,
): ContextEpochMessageLike {
  return {
    id,
    role: "user",
    timestamp,
    metadata: {
      contextEpoch: {
        epochId: id,
        seq,
        cutoffMessageId,
        createdAt: timestamp,
        removedCount: 2,
        keptCount: 1,
        trigger: "auto",
        ...metadataOverride,
      },
    },
  };
}

describe("applyContextCutoff — 读侧检查点契约", () => {
  it("CV-CUT-1: 没有 epoch 时原样返回（旧行为零变化）", () => {
    const input = [msg("m1", 1), msg("m2", 2), msg("m3", 3)];
    const out = applyContextCutoff(input);
    expect(out.applied).toBe(false);
    expect(out.epoch).toBeNull();
    expect(out.warnings).toEqual([]);
    expect(out.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(out.messages).toBe(input);
  });

  it("CV-CUT-2: 有 epoch 时 = marker + cutoff 之后的消息", () => {
    const input = [
      msg("m1", 1),
      msg("m2", 2),
      epochMarker("compact-10-1", "m3", 1, 10),
      msg("m3", 11),
      msg("m4", 12),
    ];
    const out = applyContextCutoff(input);
    expect(out.applied).toBe(true);
    expect(out.epoch?.epochId).toBe("compact-10-1");
    expect(out.messages.map((m) => m.id)).toEqual(["compact-10-1", "m3", "m4"]);
    expect(out.warnings).toEqual([]);
  });

  it("CV-CUT-3: 多 epoch 取 seq 最大，而不是取最后出现的那条", () => {
    const input = [
      msg("m1", 1),
      epochMarker("compact-10-1", "m2", 1, 10),
      msg("m2", 11),
      epochMarker("compact-20-2", "m4", 2, 20),
      msg("m3", 21),
      msg("m4", 22),
    ];
    const out = applyContextCutoff(input);
    expect(out.epoch?.epochId).toBe("compact-20-2");
    expect(out.messages.map((m) => m.id)).toEqual(["compact-20-2", "m4"]);
  });

  it("CV-CUT-4: cutoff 不在列表 ⇒ fail-open 全量 + warning", () => {
    const input = [msg("m1", 1), epochMarker("compact-10-1", "missing", 1, 10), msg("m2", 2)];
    const out = applyContextCutoff(input);
    expect(out.applied).toBe(false);
    expect(out.messages.map((m) => m.id)).toEqual(["m1", "compact-10-1", "m2"]);
    expect(out.warnings.join(" ")).toContain("cutoff message missing not found");
  });

  it("CV-CUT-5: 用户伪造正文前缀但 id 不是 marker ⇒ 不构成 epoch", () => {
    const fake = {
      id: "user-1",
      role: "user",
      timestamp: 5,
      content: "[上下文已自动压缩] 这是用户粘回来的",
      metadata: { contextEpoch: { cutoffMessageId: "m2", seq: 9 } },
    } as unknown as ContextEpochMessageLike;
    const input = [msg("m1", 1), fake, msg("m2", 2)];
    const out = applyContextCutoff(input);
    expect(out.applied).toBe(false);
    expect(out.messages.map((m) => m.id)).toEqual(["m1", "user-1", "m2"]);
  });

  it("CV-CUT-6: 有 marker id 前缀但没有 metadata ⇒ 不猜 cutoff", () => {
    const markerWithoutMeta: ContextEpochMessageLike = { id: "compact-10-1", role: "user", timestamp: 10 };
    const input = [msg("m1", 1), markerWithoutMeta, msg("m2", 2)];
    const out = applyContextCutoff(input);
    expect(out.applied).toBe(false);
    expect(out.messages.map((m) => m.id)).toEqual(["m1", "compact-10-1", "m2"]);
  });

  it("CV-CUT-7: marker 排在 cutoff 之后（真实时间戳形态）⇒ 仍保留 cutoff 起的消息，marker 前置", () => {
    const input = [msg("m1", 1), msg("m2", 2), epochMarker("compact-10-1", "m2", 1, 10), msg("m3", 3)];
    const out = applyContextCutoff(input);
    expect(out.applied).toBe(true);
    expect(out.messages.map((m) => m.id)).toEqual(["compact-10-1", "m2", "m3"]);
    expect(out.warnings).toEqual([]);
  });

  it("CV-CUT-8: epochId 缺失时回退 marker id；不修改输入数组", () => {
    const marker = epochMarker("compact-10-1", "m2", 1, 10, { epochId: undefined });
    const input = [msg("m1", 1), marker, msg("m2", 2)];
    const before = input.map((m) => m.id);
    const out = applyContextCutoff(input);
    expect(out.epoch?.epochId).toBe("compact-10-1");
    expect(out.messages.map((m) => m.id)).toEqual(["compact-10-1", "m2"]);
    expect(input.map((m) => m.id)).toEqual(before);
  });

  it("CV-CUT-9: buildContextEpochMetadata → applyContextCutoff 往返一致", () => {
    const metadata = buildContextEpochMetadata({
      epochId: "compact-manual-100-7",
      cutoffMessageId: "m2",
      createdAt: 100,
      removedCount: 4,
      keptCount: 2,
      trigger: "manual",
    });
    expect(metadata).not.toBeNull();
    const marker: ContextEpochMessageLike = {
      id: "compact-manual-100-7",
      role: "user",
      timestamp: 99,
      metadata: metadata!,
    };
    const out = applyContextCutoff([msg("m1", 1), marker, msg("m2", 2), msg("m3", 3)]);
    expect(out.applied).toBe(true);
    expect(out.epoch).toMatchObject({
      epochId: "compact-manual-100-7",
      seq: 7,
      cutoffMessageId: "m2",
      removedCount: 4,
      keptCount: 2,
      trigger: "manual",
    });
    expect(out.messages.map((m) => m.id)).toEqual(["compact-manual-100-7", "m2", "m3"]);
  });

  it("CV-CUT-10: 缺少 epochId 或 cutoff 时不构造半截 metadata", () => {
    expect(buildContextEpochMetadata({ epochId: "", cutoffMessageId: "m2", createdAt: 1 })).toBeNull();
    expect(buildContextEpochMetadata({ epochId: "compact-1-1", cutoffMessageId: "", createdAt: 1 })).toBeNull();
  });
});
