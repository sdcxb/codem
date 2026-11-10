/**
 * P0-4：段分隔卡（`SegmentDivider`）+ 数据层锚点。
 *
 * ## 守什么
 *
 * 1. 只有"第 2 段及以后"的段首才画分隔（第 1 段没有边界）；
 * 2. 开关关着 ⇒ **渲染 null**（灰度期不许改变所有用户的界面）；
 * 3. 不显示百分比/水位（25 §10.7：默认安静）；
 * 4. **FAIL 9 的核心**：换段之后又压缩过一次时，switch marker 已不在 ContextView 里，
 *    但锚点仍要落在"这一段的第一条可见消息"上（数据层按时间线算，不看消息 metadata）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { SegmentDivider } from "../components/SegmentDivider";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage } from "../core/storage/message";
import { buildContextEpochMetadata } from "../core/context/context-view";
import { segmentDividerAnchors, segmentDiagnostics } from "../core/storage/thread-history";

describe("SegmentDivider", () => {
  it("SD-1: 段首（seq>=2）+ 开关开 ⇒ 画分隔并标出段号", () => {
    render(<SegmentDivider segmentSeq={2} enabled />);
    const divider = screen.getByTestId("segment-divider");
    expect(divider.getAttribute("data-segment-seq")).toBe("2");
    expect(divider.textContent).toContain("第 2 段");
  });

  it("SD-2: 开关关 ⇒ 什么都不画（灰度安全）", () => {
    const { container } = render(<SegmentDivider segmentSeq={2} enabled={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("SD-3: 非段首（undefined / 第 1 段）⇒ 不画分隔", () => {
    expect(render(<SegmentDivider enabled />).container.innerHTML).toBe("");
    expect(render(<SegmentDivider segmentSeq={1} enabled />).container.innerHTML).toBe("");
  });

  it("SD-5: ChatPanel 真的渲染了它（接线判据，钉 JSX 本体）", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ChatPanel.tsx"), "utf8");
    /* 只查组件名会被 import 满足；必须钉 JSX 与开关表达式 */
    expect(src).toMatch(/<SegmentDivider[\s\S]{0,160}enabled=\{segmentEpochsOn\(\)\}/);
    expect(src, "锚点必须来自数据层（按时间线算），不是消息 metadata").toContain("segmentDividerAnchors");
  });


  it("SD-8: C13 —— 会话头显示「已整理 · 第 N 段」，不出现压缩/换段/水位字样", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ChatPanel.tsx"), "utf8");
    expect(src, "状态必须来自数据层段诊断").toContain("segmentDiagnostics");
    expect(src, "用户可见文案只讲「整理」").toContain("已整理 · 第");
    expect(src, "不许把内部术语暴露给用户").not.toContain("已换段");
  });  it("SD-6: 分隔卡不显示百分比/水位（默认安静）", () => {
    render(<SegmentDivider segmentSeq={3} enabled />);
    expect(screen.getByTestId("segment-divider").textContent ?? "").not.toMatch(/%|水位|即将满/);
  });
});

describe("段分隔锚点（FAIL 9：换段后再压缩仍要画得出来）", () => {
  const S = "sess-divider-anchors";
  const epoch = (id: string, kind: "compact" | "switch", cutoff: string, seq: number) =>
    buildContextEpochMetadata({
      epochId: id,
      cutoffMessageId: cutoff,
      createdAt: seq * 100,
      kind,
      segmentSeq: seq,
      trigger: kind,
    }) ?? undefined;

  beforeEach(() => {
    setStoragePort(createFakeStoragePort({
      seed: { sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }] },
    }));
  });
  afterEach(() => setStoragePort(null));

  it("SD-7: switch → compact 之后，锚点落在该段第一条**仍可见**的消息上", () => {
    createMessage({ id: "m1", role: "user", content: "第一段", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 2,
      status: "done",
      metadata: epoch("compact-switch-2", "switch", "m2", 2),
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "二", timestamp: 3, status: "done" }, S);
    createMessage({ id: "m3", role: "user", content: "三", timestamp: 4, status: "done" }, S);
    createMessage({
      id: "compact-400-3",
      role: "user",
      content: "[上下文已自动压缩]",
      timestamp: 5,
      status: "done",
      metadata: epoch("compact-400-3", "compact", "m3", 2),
    }, S);
    createMessage({ id: "m4", role: "user", content: "四", timestamp: 6, status: "done" }, S);

    /* 前提：switch marker 已经不在 ContextView 里（最新 marker 是 compact） */
    const anchors = segmentDividerAnchors(S);
    expect(anchors, "换段后再压缩一次，锚点仍必须存在").toHaveLength(1);
    expect(anchors[0].segmentSeq).toBe(2);
    expect(anchors[0].anchorMessageId, "锚点 = 该段第一条仍可见的消息").toBe("m3");

    const diag = segmentDiagnostics(S);
    expect(diag).toMatchObject({ segments: 2, switches: 1, compacts: 1, messages: 6 });
  });
});
