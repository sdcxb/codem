/**
 * InteractiveFormDialog — D3: 交互式表单对话框。
 *
 * 当 AI 调用 interactive_form_question 工具时，此组件被渲染。
 * 显示一个或多个问题（选择题或文本输入题），等待用户提交答案。
 *
 * IP 声明：本组件为 Codem 项目原创。
 */

import { useState, useEffect } from "react";
import { Check, X, Star, HelpCircle } from "lucide-react";
import type { InteractiveFormQuestion } from "../core/llm/tools";

interface InteractiveFormDialogProps {
  questions: InteractiveFormQuestion[];
  onSubmit: (answers: Record<string, unknown>) => void;
  onCancel: () => void;
}

export function InteractiveFormDialog({ questions, onSubmit, onCancel }: InteractiveFormDialogProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [useCustom, setUseCustom] = useState<Record<string, boolean>>({});

  // Initialize defaults
  useEffect(() => {
    const init: Record<string, unknown> = {};
    for (const q of questions) {
      if (q.default) {
        init[q.id] = q.default;
      } else if (q.input_type === "choice" && !q.multi_select) {
        init[q.id] = [];
      } else if (q.input_type === "text") {
        init[q.id] = "";
      }
    }
    setAnswers(init);
  }, [questions]);

  const handleChoiceSelect = (questionId: string, value: string, multiSelect: boolean) => {
    if (multiSelect) {
      const current = (answers[questionId] as string[]) || [];
      const updated = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      setAnswers({ ...answers, [questionId]: updated });
    } else {
      setAnswers({ ...answers, [questionId]: [value] });
    }
    // Reset custom mode
    setUseCustom({ ...useCustom, [questionId]: false });
  };

  const handleTextChange = (questionId: string, value: string) => {
    setAnswers({ ...answers, [questionId]: value });
  };

  const handleCustomToggle = (questionId: string) => {
    const isCustom = !useCustom[questionId];
    setUseCustom({ ...useCustom, [questionId]: isCustom });
    if (isCustom) {
      setCustomInputs({ ...customInputs, [questionId]: "" });
      setAnswers({ ...answers, [questionId]: "" });
    } else {
      // Reset to empty selection
      setAnswers({ ...answers, [questionId]: [] });
    }
  };

  const handleSubmit = () => {
    // Validate required questions
    for (const q of questions) {
      if (q.required !== false) {
        const ans = answers[q.id];
        if (!ans || (Array.isArray(ans) && ans.length === 0) || (typeof ans === "string" && !ans.trim())) {
          return; // Don't submit if required question is empty
        }
      }
    }
    onSubmit(answers);
  };

  const isSingleQuestion = questions.length === 1;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-editor"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "600px", width: "90vw", padding: "0", background: "var(--bg-secondary, #1a1a2e)" }}
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
          <HelpCircle size={20} style={{ color: "var(--accent-color, #6c5ce7)" }} />
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
            {isSingleQuestion ? questions[0].question : "请回答以下问题"}
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
          {questions.map((q, qIdx) => (
            <div key={q.id} style={{ marginBottom: qIdx < questions.length - 1 ? "24px" : "0" }}>
              {!isSingleQuestion && (
                <label
                  style={{
                    display: "block",
                    fontSize: "14px",
                    fontWeight: 500,
                    marginBottom: "10px",
                    color: "var(--text-primary, #e0e0e0)",
                  }}
                >
                  {q.question}
                  {q.required !== false && <span style={{ color: "#e74c3c", marginLeft: "4px" }}>*</span>}
                </label>
              )}

              {q.input_type === "choice" && (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {q.options?.map((opt) => {
                      const currentAns = answers[q.id];
                      const isSelected = Array.isArray(currentAns)
                        ? currentAns.includes(opt.value)
                        : currentAns === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => handleChoiceSelect(q.id, opt.value, q.multi_select || false)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            padding: "10px 14px",
                            borderRadius: "8px",
                            border: isSelected
                              ? "2px solid var(--accent-color, #6c5ce7)"
                              : "2px solid var(--border-color, #444)",
                            background: isSelected
                              ? "rgba(108, 92, 231, 0.15)"
                              : "var(--bg-tertiary, #16213e)",
                            cursor: "pointer",
                            textAlign: "left",
                            transition: "all 0.15s",
                            color: "var(--text-primary, #e0e0e0)",
                            fontSize: "14px",
                          }}
                        >
                          <div
                            style={{
                              width: q.multi_select ? "18px" : "18px",
                              height: "18px",
                              borderRadius: q.multi_select ? "4px" : "50%",
                              border: isSelected
                                ? "none"
                                : "2px solid var(--text-secondary, #666)",
                              background: isSelected ? "var(--accent-color, #6c5ce7)" : "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            {isSelected && <Check size={12} color="white" />}
                          </div>
                          <span>{opt.label}</span>
                          {opt.recommended && (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "3px",
                                fontSize: "11px",
                                padding: "2px 8px",
                                borderRadius: "10px",
                                background: "rgba(46, 204, 113, 0.2)",
                                color: "#2ecc71",
                                marginLeft: "auto",
                              }}
                            >
                              <Star size={10} fill="#2ecc71" />
                              推荐
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* "Other" option for choice questions */}
                  <button
                    onClick={() => handleCustomToggle(q.id)}
                    style={{
                      marginTop: "8px",
                      padding: "8px 14px",
                      background: "none",
                      border: `1px dashed var(--border-color, #444)`,
                      borderRadius: "8px",
                      cursor: "pointer",
                      color: "var(--text-secondary, #888)",
                      fontSize: "13px",
                      width: "100%",
                      textAlign: "left",
                    }}
                  >
                    {useCustom[q.id] ? "▼ 取消自定义输入" : "+ 其他（自定义输入）"}
                  </button>

                  {useCustom[q.id] && (
                    <input
                      type="text"
                      value={customInputs[q.id] || ""}
                      onChange={(e) => {
                        setCustomInputs({ ...customInputs, [q.id]: e.target.value });
                        handleTextChange(q.id, e.target.value);
                      }}
                      placeholder="请输入自定义答案..."
                      style={{
                        width: "100%",
                        marginTop: "8px",
                        padding: "10px 14px",
                        borderRadius: "8px",
                        border: "2px solid var(--border-color, #444)",
                        background: "var(--bg-tertiary, #16213e)",
                        color: "var(--text-primary, #e0e0e0)",
                        fontSize: "14px",
                        outline: "none",
                      }}
                      autoFocus
                    />
                  )}
                </>
              )}

              {q.input_type === "text" && (
                <input
                  type="text"
                  value={(answers[q.id] as string) || ""}
                  onChange={(e) => handleTextChange(q.id, e.target.value)}
                  placeholder={q.placeholder || "请输入..."}
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    border: "2px solid var(--border-color, #444)",
                    background: "var(--bg-tertiary, #16213e)",
                    color: "var(--text-primary, #e0e0e0)",
                    fontSize: "14px",
                    outline: "none",
                  }}
                  autoFocus={isSingleQuestion}
                />
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            padding: "16px 20px",
            borderTop: "1px solid var(--border-color, #333)",
          }}
        >
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
            取消
          </button>
          <button
            onClick={handleSubmit}
            style={{
              padding: "8px 20px",
              borderRadius: "8px",
              border: "none",
              background: "var(--accent-color, #6c5ce7)",
              color: "white",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: 500,
            }}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}
