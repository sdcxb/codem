/**
 * DOCI-9：状态标签「不许骗人」。
 *
 * 核心一条：`needs_ocr` **不得**显示成「已索引」。扫描件没有可检索文本，
 * 说成已索引会让模型得出「文档里没有这件事」的假结论 —— 这是 ADR-0008 §13 的底线。
 */
import { describe, expect, it } from "vitest";
import { docBadgeOf, docIndexSummary, docStageLabel } from "../core/document/status-labels";

describe("DOCI-9 附件徽标", () => {
  it("五种关键状态各有明确的标签与语气", () => {
    expect(docBadgeOf({ status: "ready" })).toMatchObject({ label: "已索引", tone: "ok" });
    expect(docBadgeOf({ status: "indexing" })).toMatchObject({ label: "索引中", tone: "busy" });
    expect(docBadgeOf({ status: "needs_ocr" })).toMatchObject({ label: "需 OCR", tone: "warn" });
    expect(docBadgeOf({ status: "needs_engine" })).toMatchObject({ label: "需引擎", tone: "warn" });
    expect(docBadgeOf({ status: "failed" })).toMatchObject({ label: "失败", tone: "bad" });
  });

  it("needs_ocr 绝不显示成「已索引」", () => {
    const badge = docBadgeOf({ status: "needs_ocr" });
    expect(badge?.label).not.toBe("已索引");
    expect(badge?.tone).not.toBe("ok");
    expect(badge?.title).toContain("没有可提取文本");
  });

  it("失败/失效/过大都是可行动状态，不是静默", () => {
    for (const status of ["failed", "stale", "too_large", "needs_password", "unsupported"]) {
      const badge = docBadgeOf({ status });
      expect(badge, status).not.toBeNull();
      expect(badge!.title.length).toBeGreaterThan(0);
    }
  });

  it("未入索引（没有 document 行）返回 null，不编造状态", () => {
    expect(docBadgeOf(undefined)).toBeNull();
    expect(docBadgeOf(null)).toBeNull();
  });
});

describe("DOCI-9 状态条摘要", () => {
  it("按固定顺序聚合，只显示有内容的档位", () => {
    const summary = docIndexSummary({ pending: 1, indexing: 2, ready: 5, needs_ocr: 1, failed: 1 });
    expect(summary.map((s) => s.key)).toEqual(["running", "ready", "attention", "failed"]);
    expect(summary[0].count).toBe(3);
    expect(summary[1].count).toBe(5);
    expect(summary[2].count).toBe(1);
  });

  it("空状态返回空数组（不渲染零值噪点）", () => {
    expect(docIndexSummary({})).toEqual([]);
  });

  it("阶段文案可读", () => {
    expect(docStageLabel("extracting")).toBe("提取中");
    expect(docStageLabel("indexing")).toBe("写入索引");
    expect(docStageLabel("weird")).toBe("weird");
  });
});
