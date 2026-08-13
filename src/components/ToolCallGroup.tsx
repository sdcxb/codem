/**
 * ToolCallGroup — 工具调用组
 *
 * 对标 wecode：去外框，inline 排列，连续相同工具自动合并为 "ToolName x N"。
 * 渲染折叠：连续 3+ 个只读操作（read/grep/glob）自动折叠前面的，只展开最后一个。
 */

import { memo, useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Wrench, LoaderCircle } from "lucide-react";
import { ToolCallCard, type ToolCallCardProps } from "./ToolCallCard";

/** 只读工具列表 — 这些工具的连续调用可以自动折叠 */
const READ_ONLY_TOOLS = new Set(["read", "Read File", "grep", "Search Code", "glob", "Find Files"]);

/** 当连续只读操作达到此数量时，自动折叠前面的 */
const COLLAPSE_THRESHOLD = 3;

interface ToolCallGroupProps {
  items: ToolCallCardProps[];
  /** 组标题 */
  title?: string;
  /** 默认展开 */
  defaultExpanded?: boolean;
}

interface MergedItem {
  toolName: string;
  count: number;
  items: ToolCallCardProps[];
  isRunning: boolean;
  hasError: boolean;
  doneCount: number;
}

export const ToolCallGroup = memo(function ToolCallGroup({
  items,
  title = "Tool Calls",
  defaultExpanded = true,
}: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Merge consecutive same-tool calls
  const mergedItems = useMemo(() => {
    const result: MergedItem[] = [];
    for (const item of items) {
      const last = result[result.length - 1];
      if (last && last.toolName === item.toolName) {
        last.count++;
        last.items.push(item);
        if (item.status === "running") last.isRunning = true;
        if (item.status === "error") last.hasError = true;
        if (item.status === "done") last.doneCount++;
      } else {
        result.push({
          toolName: item.toolName,
          count: 1,
          items: [item],
          isRunning: item.status === "running",
          hasError: item.status === "error",
          doneCount: item.status === "done" ? 1 : 0,
        });
      }
    }

    // 渲染折叠：将连续的只读操作分组成折叠段
    // 当一组连续的只读操作达到 COLLAPSE_THRESHOLD 时，
    // 前面的默认折叠，只展开最后一个
    for (const merged of result) {
      if (READ_ONLY_TOOLS.has(merged.toolName) && merged.count >= COLLAPSE_THRESHOLD) {
        // 标记前面的 items 为折叠状态（通过添加 collapsed 标记）
        (merged as any).autoCollapse = true;
      }
    }

    return result;
  }, [items]);

  if (!items.length) return null;

  const totalDone = items.filter((i) => i.status === "done").length;
  const totalError = items.filter((i) => i.status === "error").length;
  const totalRunning = items.filter((i) => i.status === "running").length;

  return (
    <div className="tool-call-group-inline">
      {/* Group header — lightweight, no outer border */}
      <button
        className="tool-group-header-inline"
        onClick={() => setExpanded((e) => !e)}
        aria-label={expanded ? "Collapse tools" : "Expand tools"}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} />
        <span className="tool-group-title-inline">{title}</span>
        <span className="tool-group-count-inline">
          {totalDone}/{items.length}
          {totalRunning > 0 && <span className="tool-group-running-inline"> · {totalRunning} running</span>}
          {totalError > 0 && <span className="tool-group-errors-inline"> · {totalError} failed</span>}
        </span>
        {totalRunning > 0 && <LoaderCircle size={12} className="tool-group-spin" />}
      </button>

      {/* Inline tool pills */}
      {expanded && (
        <div className="tool-group-body-inline">
          {mergedItems.map((merged, idx) =>
            merged.count > 1 ? (
              <div key={idx} className="tool-merged-group">
                {/* 渲染折叠：只读操作组达到阈值时，前面的默认折叠 */}
                {(merged as any).autoCollapse
                  ? <CollapsedReadGroup merged={merged} />
                  : merged.items.map((item, subIdx) => (
                      <ToolCallCard key={subIdx} {...item} />
                    ))
                }
                <span className="tool-merged-badge">
                  {merged.isRunning ? `${merged.doneCount}/${merged.count}` : `x ${merged.count}`}
                </span>
              </div>
            ) : (
              <ToolCallCard key={idx} {...merged.items[0]} />
            )
          )}
        </div>
      )}
    </div>
  );
});

/**
 * CollapsedReadGroup — 折叠的连续只读操作组
 *
 * 当连续的 read/grep/glob 操作达到阈值时，前面的操作默认折叠，
 * 只展开最后一个。用户可以点击展开全部。
 */
const CollapsedReadGroup = memo(function CollapsedReadGroup({ merged }: { merged: MergedItem }) {
  const [showAll, setShowAll] = useState(false);
  const items = merged.items;
  const lastItem = items[items.length - 1];
  const hiddenCount = items.length - 1;

  if (showAll) {
    return (
      <>
        {items.map((item, subIdx) => (
          <ToolCallCard key={subIdx} {...item} />
        ))}
        <button
          className="tool-collapse-toggle"
          onClick={() => setShowAll(false)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary, #a0a0a8)",
            cursor: "pointer",
            fontSize: "11px",
            padding: "2px 6px",
          }}
        >
          <ChevronDown size={10} style={{ display: "inline", marginRight: 2 }} />
          {hiddenCount} earlier {merged.toolName} calls — click to collapse
        </button>
      </>
    );
  }

  return (
    <>
      <button
        className="tool-collapse-toggle"
        onClick={() => setShowAll(true)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-secondary, #a0a0a8)",
          cursor: "pointer",
          fontSize: "11px",
          padding: "2px 6px",
          display: "flex",
          alignItems: "center",
          gap: "4px",
        }}
      >
        <ChevronRight size={10} />
        {hiddenCount} earlier {merged.toolName} calls collapsed
      </button>
      <ToolCallCard {...lastItem} />
    </>
  );
});
