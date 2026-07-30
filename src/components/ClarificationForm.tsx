/**
 * ClarificationForm — AI 提问的交互式表单
 *
 * 支持单选、多选、文本输入
 * 用户填写后，答案格式化为 Markdown 消息发回 AI
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";
import type { ClarificationFormData } from "../core/llm/agentic-loop";

interface ClarificationFormProps {
  /** Form data from AI */
  form: ClarificationFormData;
  /** User submitted answers */
  onSubmit: (answers: Record<string, string | string[]>) => void;
  /** User cancelled the form */
  onCancel: () => void;
}

export const ClarificationForm = memo(function ClarificationForm({
  form,
  onSubmit,
  onCancel,
}: ClarificationFormProps) {
  const lang = useLang();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  const handleSubmit = () => {
    if (form.required && !answers[form.formId]) {
      alert(S.clarification.required[lang]);
      return;
    }
    onSubmit(answers);
  };

  const handleRadioChange = (value: string) => {
    setAnswers({ [form.formId]: value });
  };

  const handleCheckboxChange = (value: string, checked: boolean) => {
    const current = (answers[form.formId] as string[]) || [];
    if (checked) {
      setAnswers({ [form.formId]: [...current, value] });
    } else {
      setAnswers({ [form.formId]: current.filter((v) => v !== value) });
    }
  };

  const handleTextChange = (value: string) => {
    setAnswers({ [form.formId]: value });
  };

  return (
    <div className="clarification-form">
      <div className="clarification-question">{form.question}</div>
      {form.required && (
        <div className="clarification-required">{S.clarification.requiredMark[lang]}</div>
      )}

      <div className="clarification-inputs">
        {form.type === "radio" && form.options && (
          <div className="radio-group">
            {form.options.map((option, index) => (
              <label key={index} className="radio-option">
                <input
                  type="radio"
                  name={form.formId}
                  value={option}
                  checked={answers[form.formId] === option}
                  onChange={(e) => handleRadioChange(e.target.value)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        )}

        {form.type === "checkbox" && form.options && (
          <div className="checkbox-group">
            {form.options.map((option, index) => (
              <label key={index} className="checkbox-option">
                <input
                  type="checkbox"
                  name={form.formId}
                  value={option}
                  checked={(answers[form.formId] as string[])?.includes(option) || false}
                  onChange={(e) => handleCheckboxChange(option, e.target.checked)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        )}

        {form.type === "text" && (
          <textarea
            className="clarification-textarea"
            rows={3}
            placeholder={S.clarification.placeholder[lang]}
            value={answers[form.formId] as string || ""}
            onChange={(e) => handleTextChange(e.target.value)}
          />
        )}
      </div>

      <div className="clarification-actions">
        <button className="clarification-btn submit" onClick={handleSubmit}>
          ✓ {S.clarification.submit[lang]}
        </button>
        <button className="clarification-btn cancel" onClick={onCancel}>
          ✕ {S.clarification.cancel[lang]}
        </button>
      </div>
    </div>
  );
});