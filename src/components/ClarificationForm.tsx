/**
 * ClarificationForm — AI 反问表单（第 3 步：只剩数据映射 + 文案）
 *
 * 表单本体（单选 / 多选 / 文本、必填门控、提交与取消）在
 * `packages/ui/src/approval-card.tsx` 的 `clarification` 分支里；本文件把
 * `ClarificationFormData`（单一问题，来自 `ask_clarification`）映射成共享卡的
 * `ClarificationDecisionRequest`，并把双语按钮文案/占位符传下去。
 *
 * 与 `InteractiveFormDialog` 的分工（刻意不合并）：
 * - 这里服务 `ask_clarification`：一个问题、`radio|checkbox|text` 三选一；
 * - `InteractiveFormDialog` 服务 `interactive_form_question`：多问题 + 自定义输入 + 默认值，
 *   是那个工具**专用**的对话框 UI，留在桌面。
 *
 * 必填的处置：以前是"点提交 → 弹一个错误框"（`alertDialog`），现在是**提交按钮不可用** ——
 * 用户不会先点到一个什么都没发生的按钮再被追着报错。
 */
import { memo, useMemo } from "react";

import { ApprovalCard, type DecisionLabels } from "../../packages/ui/src/approval-card";
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

  const labels = useMemo<Partial<DecisionLabels>>(
    () => ({
      submit: `✓ ${S.clarification.submit[lang]}`,
      cancel: `✕ ${S.clarification.cancel[lang]}`,
      requiredMark: S.clarification.requiredMark[lang],
      textPlaceholder: S.clarification.placeholder[lang],
    }),
    [lang],
  );

  return (
    <ApprovalCard
      request={{
        kind: "clarification",
        id: form.formId,
        questions: [
          {
            id: form.formId,
            question: form.question,
            type: form.type,
            required: form.required,
            placeholder: S.clarification.placeholder[lang],
            ...(form.options ? { options: form.options } : {}),
          },
        ],
      }}
      capabilities={{ alwaysAllow: false, rejectReason: false }}
      labels={labels}
      onResolve={(_id, outcome) => {
        if (outcome.kind === "clarify") onSubmit(outcome.answers);
        else if (outcome.kind === "cancel") onCancel();
      }}
    />
  );
});
