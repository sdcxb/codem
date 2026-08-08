/**
 * ActivityTimeline — 活动时间线
 *
 * 展示工具调用与评论文本交错的活动时间线。
 * 每个工具调用以卡片形式展示，支持折叠/展开。
 */

import { memo, useState } from "react";
import { ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle, LoaderCircle } from "lucide-react";

interface TimelineItem {
  id: string;
  type: "tool" | "text";
  content: string;
  toolName?: string;
  toolStatus?: "running" | "done" | "error";
  toolArgs?: string;
  toolResult?: string;
  startedAt?: number;
  duration?: number;
}

interface ActivityTimelineProps {
  items: TimelineItem[];
  /** 默认展开 */
  defaultExpanded?: boolean;
}

const STATUS_ICON = {
  running: LoaderCircle,
  done: CheckCircle2,
  error: XCircle,
};

const STATUS_LABEL = {
  running: "执行中",
  done: "完成",
  error: "失败",
};

export const ActivityTimeline = memo(function ActivityTimeline({
  items,
  defaultExpanded = true,
}: ActivityTimelineProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  if (!items.length) return null;

  const toggleItem = (id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toolItems = items.filter((i) => i.type === "tool");
  const textItems = items.filter((i) => i.type === "text");

  return (
    <div className="activity-timeline">
      <button
        className="activity-timeline-header"
        onClick={() => setExpanded((e) => !e)}
        aria-label={expanded ? "折叠" : "展开"}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} />
        <span>{toolItems.length} 个工具调用</span>
      </button>
      {expanded && (
        <div className="activity-timeline-body">
          {items.map((item, idx) => {
            if (item.type === "text") {
              return (
                <div key={item.id} className="activity-timeline-text">
                  {item.content}
                </div>
              );
            }

            const Icon = STATUS_ICON[item.toolStatus || "done"] || CheckCircle2;
            const isExpanded = expandedItems.has(item.id);

            return (
              <div key={item.id} className="activity-timeline-tool">
                <div
                  className="activity-timeline-tool-header"
                  onClick={() => toggleItem(item.id)}
                >
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Wrench size={12} />
                  <span className="activity-timeline-tool-name">{item.toolName || "工具"}</span>
                  <Icon
                    size={12}
                    className={item.toolStatus === "running" ? "spinning" : ""}
                  />
                  <span className={`activity-timeline-tool-status status-${item.toolStatus || "done"}`}>
                    {STATUS_LABEL[item.toolStatus as keyof typeof STATUS_LABEL] || "完成"}
                  </span>
                  {item.duration && (
                    <span className="activity-timeline-tool-duration">
                      {(item.duration / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                {isExpanded && (item.toolArgs || item.toolResult) && (
                  <div className="activity-timeline-tool-detail">
                    {item.toolArgs && (
                      <div className="activity-timeline-tool-args">
                        <span className="activity-timeline-detail-label">参数</span>
                        <pre>{item.toolArgs}</pre>
                      </div>
                    )}
                    {item.toolResult && (
                      <div className="activity-timeline-tool-result">
                        <span className="activity-timeline-detail-label">结果</span>
                        <pre>{item.toolResult}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
