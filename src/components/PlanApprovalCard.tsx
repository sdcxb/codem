/**
 * PlanApprovalCard — 计划审批弹窗（第 3 步：只剩外壳 + 双语文案）
 *
 * 卡片本体（计划全文、两步拒绝、拒绝理由）在 `packages/ui/src/approval-card.tsx`
 * 的 `plan` 分支里，桌面与手机共用同一份；本文件只保留桌面自己的外壳：
 * `createPortal` + `.modal-overlay` + **点遮罩 = 拒绝**（这条交互属于外壳，不属于卡片）。
 */
import { useMemo } from "react";
import { createPortal } from "./ui/portal";

import { ApprovalCard, type DecisionLabels } from "../../packages/ui/src/approval-card";
import { useLang } from "../core/i18n/lang";

interface PlanApprovalCardProps {
  plan: string;
  onApprove: () => void;
  onReject: (feedback: string) => void;
}

export function PlanApprovalCard({ plan, onApprove, onReject }: PlanApprovalCardProps) {
  const lang = useLang();

  /* 中文走共享卡默认文案；英文在这里覆盖（i18n 属桌面/宿主，不进共享包） */
  const labels = useMemo<Partial<DecisionLabels>>(
    () =>
      lang === "zh"
        ? {}
        : {
            planTitle: "Plan Approval",
            planIntro:
              "The model has submitted the following plan. Review and approve to begin execution:",
            planApprove: "Approve & Execute",
            planReject: "Reject",
            planConfirmReject: "Reject Plan",
            planBack: "Back",
            planFeedbackPlaceholder: "Enter rejection reason (optional)...",
          },
    [lang],
  );

  return createPortal(
    <div className="modal-overlay" onClick={() => onReject("")}>
      <ApprovalCard
        request={{ kind: "plan", id: "plan-approval", plan }}
        capabilities={{ alwaysAllow: false, rejectReason: false }}
        labels={labels}
        onResolve={(_id, outcome) => {
          if (outcome.kind === "plan-approve") onApprove();
          else if (outcome.kind === "plan-reject") onReject(outcome.feedback);
        }}
      />
    </div>,
  );
}
