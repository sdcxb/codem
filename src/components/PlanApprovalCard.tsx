/**
 * P0-3: Plan Approval Card — Plan Mode 审批 UI
 *
 * 当模型调用 exit_plan_mode 工具时，弹出此卡片展示计划内容，
 * 用户可以选择批准或拒绝，并填写反馈。
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardList } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { useLang } from "../core/i18n/lang";

interface PlanApprovalCardProps {
  plan: string;
  onApprove: () => void;
  onReject: (feedback: string) => void;
}

export function PlanApprovalCard({ plan, onApprove, onReject }: PlanApprovalCardProps) {
  const lang = useLang();
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);

  const card = (
    <div className="modal-overlay" onClick={() => onReject("")}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "90vw", maxWidth: 680, maxHeight: "80vh",
          background: "var(--bg-primary, #1e1e2e)",
          borderRadius: 12, display: "flex", flexDirection: "column",
          border: "1px solid var(--border-color, #333)",
          overflow: "hidden",
        }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-color, #333)",
        }}>
          <ClipboardList size={18} />
          <span style={{ fontSize: 16, fontWeight: 700 }}>
            {lang === "zh" ? "计划审批" : "Plan Approval"}
          </span>
        </div>

        {/* Plan content */}
        <div style={{
          flex: 1, overflowY: "auto", padding: "12px 16px",
        }}>
          <div style={{
            fontSize: 12, color: "#6b7280", marginBottom: 8,
          }}>
            {lang === "zh" ? "模型提交了以下计划，请审批后开始执行：" : "The model has submitted the following plan. Review and approve to begin execution:"}
          </div>
          <div style={{
            background: "var(--bg-secondary, #181825)",
            border: "1px solid var(--border-color, #333)",
            borderRadius: 8, padding: 12,
            fontSize: 13, lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            fontFamily: "'Cascadia Code', 'Fira Code', monospace",
            maxHeight: "50vh", overflowY: "auto",
          }}>
            {plan}
          </div>
        </div>

        {/* Feedback input (shown when rejecting) */}
        {showFeedback && (
          <div style={{ padding: "0 16px 8px" }}>
            <textarea
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder={lang === "zh" ? "输入拒绝理由（可选）..." : "Enter rejection reason (optional)..."}
              style={{
                width: "100%", minHeight: 60, padding: "8px 10px",
                background: "var(--bg-secondary, #181825)",
                border: "1px solid var(--border-color, #333)",
                borderRadius: 6, color: "inherit", fontSize: 13,
                resize: "vertical",
              }}
              autoFocus
            />
          </div>
        )}

        {/* Actions */}
        <div style={{
          display: "flex", gap: 8, justifyContent: "flex-end",
          padding: "12px 16px",
          borderTop: "1px solid var(--border-color, #333)",
        }}>
          {showFeedback ? (
            <>
              <button onClick={() => { setShowFeedback(false); setFeedback(""); }} style={btnStyle}>
                {lang === "zh" ? "返回" : "Back"}
              </button>
              <button onClick={() => onReject(feedback)} style={{ ...btnStyle, background: "var(--error)", color: "#fff", border: "none" }}>
                <ActionIcons.close size={14} />
                {lang === "zh" ? "拒绝计划" : "Reject Plan"}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setShowFeedback(true)} style={btnStyle}>
                <ActionIcons.close size={14} />
                {lang === "zh" ? "拒绝" : "Reject"}
              </button>
              <button onClick={onApprove} style={{ ...btnStyle, background: "var(--success)", color: "#fff", border: "none" }}>
                <ActionIcons.confirm size={14} />
                {lang === "zh" ? "批准并执行" : "Approve & Execute"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(card, document.body);
}

const btnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "6px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  border: "1px solid var(--border-color, #333)", background: "transparent", color: "inherit",
};
