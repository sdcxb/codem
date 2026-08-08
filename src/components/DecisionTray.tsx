/**
 * DecisionTray — 决策托盘
 *
 * 内嵌在对话底部的决策 UI，替代弹窗式权限对话框。
 * 支持两种模式：审批（Approval）和澄清（Clarification）。
 */

import { useState, useCallback, memo } from "react";
import { ShieldAlert, MessageSquare, Check, X, Send, ChevronDown } from "lucide-react";

export interface ApprovalRequest {
  type: "approval";
  id: string;
  toolName: string;
  description: string;
  args?: string;
}

export interface ClarificationRequest {
  type: "clarification";
  id: string;
  questions: Array<{
    id: string;
    question: string;
    options?: string[];
    placeholder?: string;
  }>;
}

export type DecisionRequest = ApprovalRequest | ClarificationRequest;

interface DecisionTrayProps {
  request: DecisionRequest | null;
  onApprove: (id: string) => void;
  onReject: (id: string, reason?: string) => void;
  onClarify: (id: string, answers: Record<string, string>) => void;
}

export const DecisionTray = memo(function DecisionTray({
  request,
  onApprove,
  onReject,
  onClarify,
}: DecisionTrayProps) {
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>({});
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const handleApprove = useCallback(() => {
    if (request) onApprove(request.id);
  }, [request, onApprove]);

  const handleReject = useCallback(() => {
    if (request) onReject(request.id, rejectReason || undefined);
    setRejectReason("");
    setShowRejectInput(false);
  }, [request, onReject, rejectReason]);

  const handleClarify = useCallback(() => {
    if (request && request.type === "clarification") {
      onClarify(request.id, clarifyAnswers);
      setClarifyAnswers({});
    }
  }, [request, onClarify, clarifyAnswers]);

  if (!request) return null;

  return (
    <div className="decision-tray">
      <div className="decision-tray-header">
        <button
          className="decision-tray-toggle"
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? "折叠" : "展开"}
        >
          <ChevronDown size={14} className={expanded ? "" : "rotated"} />
        </button>
        {request.type === "approval" ? (
          <>
            <ShieldAlert size={16} className="decision-tray-icon approval" />
            <div className="decision-tray-title-area">
              <strong>{request.toolName}</strong>
              <span>{request.description}</span>
            </div>
          </>
        ) : (
          <>
            <MessageSquare size={16} className="decision-tray-icon clarification" />
            <div className="decision-tray-title-area">
              <strong>需要补充信息</strong>
              <span>{request.questions.length} 个问题</span>
            </div>
          </>
        )}
      </div>

      {expanded && (
        <div className="decision-tray-body">
          {request.type === "approval" && (
            <>
              {request.args && (
                <div className="decision-tray-args">
                  <pre>{request.args}</pre>
                </div>
              )}
              {showRejectInput && (
                <input
                  className="decision-tray-reject-input"
                  placeholder="拒绝原因（可选）"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  autoFocus
                />
              )}
              <div className="decision-tray-actions">
                <button
                  className="decision-tray-btn approve"
                  onClick={handleApprove}
                >
                  <Check size={14} />
                  <span>批准</span>
                </button>
                <button
                  className="decision-tray-btn reject"
                  onClick={handleReject}
                >
                  <X size={14} />
                  <span>{showRejectInput ? "确认拒绝" : "拒绝"}</span>
                </button>
              </div>
            </>
          )}

          {request.type === "clarification" && (
            <>
              {request.questions.map((q) => (
                <div key={q.id} className="decision-tray-question">
                  <label>{q.question}</label>
                  {q.options ? (
                    <div className="decision-tray-options">
                      {q.options.map((opt) => (
                        <button
                          key={opt}
                          className={`decision-tray-option ${clarifyAnswers[q.id] === opt ? "selected" : ""}`}
                          onClick={() => setClarifyAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      className="decision-tray-answer-input"
                      placeholder={q.placeholder || "请输入..."}
                      value={clarifyAnswers[q.id] || ""}
                      onChange={(e) => setClarifyAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
              <div className="decision-tray-actions">
                <button
                  className="decision-tray-btn submit"
                  onClick={handleClarify}
                  disabled={request.questions.some((q) => !clarifyAnswers[q.id])}
                >
                  <Send size={14} />
                  <span>提交</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});
