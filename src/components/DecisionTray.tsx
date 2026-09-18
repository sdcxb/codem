/**
 * DecisionTray — 决策托盘
 *
 * 内嵌在对话底部的决策 UI，替代弹窗式权限对话框。
 * 支持两种模式：审批（Approval）和澄清（Clarification）。
 */

import { useState, useCallback, memo } from "react";
import { ShieldAlert, MessageSquare, Send } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";

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

  /**
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P1）：这段"两步拒绝"以前是**死的**
   *
   * 组件里有 `showRejectInput` 状态、有那个"拒绝原因（可选）"输入框、
   * 按钮文案还会随它切成「确认拒绝」—— 但全仓**只有 `setShowRejectInput(false)`**
   * 一处赋值，从来没有人把它设成 `true`。于是：
   * 输入框永不出现、按钮永远显示「拒绝」、`rejectReason` 永远是空串 ——
   * 也就是说 `onReject(id, reason)` 的第二个参数**永远是 `undefined`**，
   * 而下游（审批链路）拿不到任何拒绝理由。
   * 形态与本仓库已修掉的"快速访问死 UI"、`aiBoundary` 死参数完全一样。
   *
   * 现在把它接上：第一次点「拒绝」→ 展开理由输入框（按钮变「确认拒绝」）；
   * 第二次点 → 带着理由提交。
   */
  const handleReject = useCallback(() => {
    if (!request) return;
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    onReject(request.id, rejectReason || undefined);
    setRejectReason("");
    setShowRejectInput(false);
  }, [request, onReject, rejectReason, showRejectInput]);

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
          <ActionIcons.expand size={14} className={expanded ? "" : "rotated"} />
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
                  <ActionIcons.confirm size={14} />
                  <span>批准</span>
                </button>
                <button
                  className="decision-tray-btn reject"
                  onClick={handleReject}
                >
                  <ActionIcons.close size={14} />
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
