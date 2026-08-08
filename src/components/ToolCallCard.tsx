/**
 * ToolCallCard — 工具调用胶囊卡片
 *
 * 对标 wecode ToolBlock：inline-flex pill 样式，带背景框图标。
 * 支持折叠/展开查看参数和结果。
 */

import { memo, useState, useMemo } from "react";
import { Wrench, CheckCircle2, XCircle, LoaderCircle, ChevronDown, ChevronRight, FileText, Search, Terminal, FileEdit, FolderSearch } from "lucide-react";

export interface ToolCallCardProps {
  toolName: string;
  toolArgs?: string;
  toolResult?: string;
  status: "running" | "done" | "error";
  duration?: number;
  /** 参数摘要（用于卡片头部显示） */
  argsSummary?: string;
}

/** 根据工具名获取对应图标 */
function getToolIcon(toolName: string) {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("terminal") || lower.includes("shell")) return Terminal;
  if (lower.includes("edit") || lower.includes("write") || lower.includes("create")) return FileEdit;
  if (lower.includes("read") || lower.includes("cat")) return FileText;
  if (lower.includes("grep") || lower.includes("search") || lower.includes("glob")) return Search;
  if (lower.includes("file") || lower.includes("path")) return FolderSearch;
  return Wrench;
}

/** 获取工具友好显示名 */
function getToolDisplayName(toolName: string): string {
  const lower = toolName.toLowerCase();
  const displayNames: Record<string, string> = {
    bash: "Execute Command",
    read: "Read File",
    edit: "Edit File",
    write: "Write File",
    grep: "Search Code",
    glob: "Find Files",
    todowrite: "Update Tasks",
    search_notebook: "Search Knowledge",
    web_search: "Web Search",
    load_skill: "Load Skill",
    spawn_subagent: "Sub-agent",
    create_note: "Create Note",
    edit_note: "Edit Note",
    delete_note: "Delete Note",
    link_notes: "Link Notes",
  };
  if (displayNames[lower]) return displayNames[lower];
  return toolName;
}

export const ToolCallCard = memo(function ToolCallCard({
  toolName,
  toolArgs,
  toolResult,
  status,
  duration,
  argsSummary,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const ToolIcon = useMemo(() => getToolIcon(toolName), [toolName]);
  const displayName = useMemo(() => getToolDisplayName(toolName), [toolName]);
  const hasDetail = Boolean(toolArgs || toolResult);
  const isRunning = status === "running";
  const isError = status === "error";

  return (
    <div className="tool-call-card-wrap">
      {/* Compact inline pill */}
      <div
        className={`tool-call-pill ${isError ? "error" : ""} ${hasDetail ? "expandable" : ""}`}
        onClick={hasDetail ? () => setExpanded((e) => !e) : undefined}
        role={hasDetail ? "button" : undefined}
      >
        {/* Icon with background frame */}
        <div className="tool-pill-icon-frame">
          {isRunning ? (
            <LoaderCircle size={10} className="tool-pill-icon-spin" />
          ) : isError ? (
            <XCircle size={10} className="tool-pill-icon-error" />
          ) : (
            <ToolIcon size={10} className="tool-pill-icon" />
          )}
        </div>

        {/* Tool name + preview */}
        <span className="tool-pill-text">
          {displayName}
          {argsSummary && <span className="tool-pill-preview"> {argsSummary}</span>}
        </span>

        {/* Duration */}
        {duration !== undefined && duration > 0 && (
          <span className="tool-pill-duration">{(duration / 1000).toFixed(1)}s</span>
        )}

        {/* Expand indicator */}
        {hasDetail && (
          expanded ? <ChevronDown size={12} className="tool-pill-chevron" />
                   : <ChevronRight size={12} className="tool-pill-chevron" />
        )}
      </div>

      {/* Expanded detail */}
      {expanded && hasDetail && (
        <div className="tool-pill-detail">
          {toolArgs && (
            <div className="tool-pill-detail-section">
              <span className="tool-pill-detail-label">Args</span>
              <pre className="tool-pill-detail-code">{toolArgs}</pre>
            </div>
          )}
          {toolResult && (
            <div className="tool-pill-detail-section">
              <span className="tool-pill-detail-label">Result</span>
              <pre className="tool-pill-detail-code">{toolResult}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
