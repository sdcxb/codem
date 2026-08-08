/**
 * ToolCallGroup — 工具调用组
 *
 * 对标 wecode：去外框，inline 排列，连续相同工具自动合并为 "ToolName x N"。
 */

import { memo, useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Wrench, LoaderCircle } from "lucide-react";
import { ToolCallCard, type ToolCallCardProps } from "./ToolCallCard";

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
                {merged.items.map((item, subIdx) => (
                  <ToolCallCard key={subIdx} {...item} />
                ))}
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
