/**
 * 成本历史的调用类型标签（判据）：压缩记录必须显示「上下文压缩」，普通对话不显示。
 */
import { describe, expect, it } from "vitest";
import { usageKindLabel } from "../core/llm/usage-label";

describe("USAGE-LABEL：成本历史标签", () => {
  it("UL-1: compaction → 中文标签", () => {
    expect(usageKindLabel("compaction")).toBe("上下文压缩");
  });

  it("UL-2: chat / 未标记（老记录）→ 不显示标签", () => {
    expect(usageKindLabel("chat")).toBeNull();
    expect(usageKindLabel(undefined)).toBeNull();
  });
});
