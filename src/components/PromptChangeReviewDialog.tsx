/**
 * PromptChangeReviewDialog — D2: 提示词修改审核对话框。
 *
 * 当 AI 调用 submit_prompt_changes 工具时，此组件被渲染。
 * 显示原始提示词与建议提示词的 diff 对比，用户可以逐个应用或取消。
 *
 * IP 声明：本组件为 Codem 项目原创。
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, X, ChevronDown, ChevronRight, FileText } from "lucide-react";
import type { PromptChange } from "../core/llm/tools";

interface PromptChangeReviewDialogProps {
  changes: PromptChange[];
  onApply: (appliedChanges: PromptChange[]) => void;
  onCancel: () => void;
}

export function PromptChangeReviewDialog({ changes, onApply, onCancel }: PromptChangeReviewDialogProps) {
  const [decisionMap, setDecisionMap] = useState<Record<number, "pending" | "apply" | "skip">>({});
  const [expandedMap, setExpandedMap] = useState<Record<number, boolean>>({});

  const toggleExpand = (idx: number) => {
    setExpandedMap({ ...expandedMap, [idx]: !expandedMap[idx] });
  };

  const setDecision = (idx: number, decision: "apply" | "skip") => {
    setDecisionMap({ ...decisionMap, [idx]: decision });
  };

  const handleApplyAll = () => {
    const applied = changes.filter((_, idx) => decisionMap[idx] !== "skip");
    onApply(applied);
  };

  const pendingCount = changes.filter((_, idx) => !decisionMap[idx]).length;
  const applyCount = changes.filter((_, idx) => decisionMap[idx] === "apply").length;
  const skipCount = changes.filter((_, idx) => decisionMap[idx] === "skip").length;

return createPortal(
<div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-editor"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "800px", width: "90vw", padding: "0", background: "var(--bg-secondary, #1a1a2e)" }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-color, #333)",
          }}
        >
          <FileText size={20} style={{ color: "var(--accent-color, #6c5ce7)" }} />
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
            提示词修改审核 ({changes.length} 项变更)
          </h2>
          <button
            onClick={onCancel}
            style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary, #888)" }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px", maxHeight: "60vh", overflowY: "auto" }}>
          {changes.map((change, idx) => {
            const decision = decisionMap[idx] || "pending";
            const expanded = expandedMap[idx] !== false; // Default expanded

            return (
              <div
                key={idx}
                style={{
                  marginBottom: idx < changes.length - 1 ? "16px" : "0",
                  borderRadius: "10px",
                  border: `2px solid ${
                    decision === "apply"
                      ? "rgba(46, 204, 113, 0.4)"
                      : decision === "skip"
                        ? "rgba(231, 76, 60, 0.3)"
                        : "var(--border-color, #444)"
                  }`,
                  overflow: "hidden",
                  background: "var(--bg-tertiary, #16213e)",
                }}
              >
                {/* Change header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "12px 16px",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleExpand(idx)}
                >
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span style={{ fontSize: "14px", fontWeight: 500 }}>
                    {change.name} ({change.type})
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDecision(idx, "apply");
                      }}
                      style={{
                        padding: "4px 12px",
                        borderRadius: "6px",
                        border: decision === "apply" ? "none" : "1px solid var(--border-color, #444)",
                        background: decision === "apply" ? "#2ecc71" : "transparent",
                        color: decision === "apply" ? "white" : "var(--text-secondary, #888)",
                        cursor: "pointer",
                        fontSize: "12px",
                        fontWeight: 500,
                      }}
                    >
                      <Check size={12} style={{ display: "inline", marginRight: "4px" }} />
                      应用
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDecision(idx, "skip");
                      }}
                      style={{
                        padding: "4px 12px",
                        borderRadius: "6px",
                        border: decision === "skip" ? "none" : "1px solid var(--border-color, #444)",
                        background: decision === "skip" ? "#e74c3c" : "transparent",
                        color: decision === "skip" ? "white" : "var(--text-secondary, #888)",
                        cursor: "pointer",
                        fontSize: "12px",
                        fontWeight: 500,
                      }}
                    >
                      <X size={12} style={{ display: "inline", marginRight: "4px" }} />
                      跳过
                    </button>
                  </div>
                </div>

                {/* Diff content */}
                {expanded && (
                  <div style={{ borderTop: "1px solid var(--border-color, #333)" }}>
                    {/* Original */}
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color, #333)" }}>
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          color: "#e74c3c",
                          marginBottom: "6px",
                        }}
                      >
                        原始提示词
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          fontSize: "13px",
                          lineHeight: "1.5",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          color: "var(--text-secondary, #aaa)",
                          maxHeight: "200px",
                          overflowY: "auto",
                        }}
                      >
                        {change.original}
                      </pre>
                    </div>

                    {/* Suggested */}
                    <div style={{ padding: "12px 16px" }}>
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          color: "#2ecc71",
                          marginBottom: "6px",
                        }}
                      >
                        优化后提示词
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          fontSize: "13px",
                          lineHeight: "1.5",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          color: "var(--text-primary, #e0e0e0)",
                          maxHeight: "200px",
                          overflowY: "auto",
                        }}
                      >
                        {change.suggested}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderTop: "1px solid var(--border-color, #333)",
          }}
        >
          <div style={{ fontSize: "13px", color: "var(--text-secondary, #888)" }}>
            {applyCount > 0 && <span style={{ color: "#2ecc71" }}>{applyCount} 项应用</span>}
            {skipCount > 0 && <span style={{ marginLeft: "8px", color: "#e74c3c" }}>{skipCount} 项跳过</span>}
            {pendingCount > 0 && <span style={{ marginLeft: "8px" }}>{pendingCount} 项待定</span>}
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              onClick={onCancel}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "1px solid var(--border-color, #444)",
                background: "transparent",
                color: "var(--text-secondary, #888)",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              全部取消
            </button>
            <button
              onClick={handleApplyAll}
              disabled={applyCount === 0}
              style={{
                padding: "8px 20px",
                borderRadius: "8px",
                border: "none",
                background: applyCount > 0 ? "var(--accent-color, #6c5ce7)" : "var(--border-color, #333)",
                color: applyCount > 0 ? "white" : "var(--text-secondary, #666)",
                cursor: applyCount > 0 ? "pointer" : "not-allowed",
                fontSize: "14px",
                fontWeight: 500,
              }}
            >
              应用选中 ({applyCount})
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
