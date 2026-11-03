/**
 * DecisionTray — 桌面前台审批托盘（第 3 步：只剩外壳与接线）
 *
 * 这一步之前这里有**一整套**审批 UI（折叠、两步拒绝、拒绝理由、澄清作答），
 * 而手机另有一份简化卡、权限弹窗又有第三份。现在卡片本体只有一份：
 * `packages/ui/src/approval-card.tsx`（桌面与手机共用）。
 *
 * 本文件保留的原因是 **slot 身份**（`app.decision-tray`）与桌面外壳：
 * 托盘是 `position: fixed` 的底部浮层（样式仍在 `src/styles/codem-ui.css`），
 * 而卡片不知道自己挂在哪儿 —— 定位属于外壳。
 */
import { memo } from "react";

import {
  ApprovalCard,
  type ApprovalDecisionRequest,
  type DecisionCapabilities,
  type DecisionLabels,
  type DecisionOutcome,
} from "../../packages/ui/src/approval-card";

export interface DecisionTrayProps {
  /** 待决策请求；`null` = 不渲染（宿主决定隐藏，卡片不做开关） */
  request: ApprovalDecisionRequest | null;
  capabilities: DecisionCapabilities;
  /** 文案覆盖（宿主语言 / 比默认更严格的措辞）：只传需要覆盖的键 */
  labels?: Partial<DecisionLabels>;
  onResolve: (id: string, outcome: DecisionOutcome) => void;
}

export const DecisionTray = memo(function DecisionTray({
  request,
  capabilities,
  labels,
  onResolve,
}: DecisionTrayProps) {
  if (!request) return null;
  return (
    <ApprovalCard
      request={request}
      capabilities={capabilities}
      labels={labels}
      onResolve={onResolve}
    />
  );
});
