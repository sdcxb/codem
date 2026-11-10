/**
 * 段分隔卡（P0-4 / D1）：换段处淡色分隔，默认**不打扰**。
 *
 * ## 为什么需要
 *
 * 换段之后模型视野只剩最新一段，而用户在对话流里看不出"这里换过段"——
 * 于是「为什么它忘了前面」变成了不可解释的现象。分隔卡只说明**边界在哪**，
 * 不显示百分比、不弹提示（25 §10.7：默认安静，可检查）。
 *
 * ## 数据来源（FAIL 9 修完之后）
 *
 * 段号由**数据层**算出（`storage/thread-history.ts::segmentDividerAnchors`）：
 * 对每个 switch epoch，取"时间线上第一条仍然在 ContextView 里的消息"作为锚点。
 *
 * 早期实现让组件从"这条消息自己的 metadata"里读 switch —— 那个形态在
 * "换段之后又压缩过一次"时必然失效（ContextView 只保留最新 marker，switch 不在视图里），
 * 分隔卡会静默消失。所以现在**组件只接收算好的段号**，不自己解析 metadata。
 */
import type { ReactElement } from "react";

export interface SegmentDividerProps {
  /** 该消息所在的段号（由数据层锚点算出）；未提供 = 不是段首 */
  segmentSeq?: number;
  enabled: boolean;
}

export function SegmentDivider({ segmentSeq, enabled }: SegmentDividerProps): ReactElement | null {
  if (!enabled) return null;
  if (typeof segmentSeq !== "number" || !Number.isFinite(segmentSeq) || segmentSeq < 2) return null;

  return (
    <div
      role="separator"
      aria-label={`第 ${segmentSeq} 段开始`}
      data-testid="segment-divider"
      data-segment-seq={segmentSeq}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "10px 0 6px",
        color: "var(--text-muted)",
        fontSize: "var(--fs-xs, 11px)",
        userSelect: "none",
      }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--border-primary)", opacity: 0.6 }} />
      <span>第 {segmentSeq} 段</span>
      <span style={{ flex: 1, height: 1, background: "var(--border-primary)", opacity: 0.6 }} />
    </div>
  );
}
