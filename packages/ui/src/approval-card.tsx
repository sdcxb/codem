/**
 * 共享审批卡（第 3 步：桌面与手机共用**同一张**决策卡）。
 *
 * ## 这一步之前是什么样
 *
 * 同一个「要不要放行」的问题，仓库里有四份 UI：
 *   · 桌面前台托盘 `src/components/DecisionTray.tsx`（`.decision-tray*`）—— 有折叠、两步拒绝、拒绝理由；
 *   · 手机卡 `packages/ui/src/components.tsx` 的 `ApprovalCard`（`.approval*`）—— 只读 `details.command`，
 *     write/edit 审批在手机上**没有任何内容可看**；
 *   · 桌面权限弹窗 `src/components/PermissionDialog.tsx`（`.permission-*`）—— 多一个「始终允许」；
 *   · 计划 / 澄清 `PlanApprovalCard.tsx`、`ClarificationForm.tsx` —— 各有各的按钮与措辞。
 * 四份实现的措辞、能不能拒绝带理由、有没有折叠，全都不一致。
 *
 * ## 现在只有这一份
 *
 * 宿主只提供三样东西：
 *   1. **数据** `DecisionRequest`（approval / plan / clarification 三个分支，都带 `kind`；
 *      缺哪一项就由调用方不传 —— 卡不会去猜）；
 *   2. **能力位** `DecisionCapabilities`：宿主**真的支持**的能力才置 true。
 *      不支持 ⇒ 那个控件根本不出现（不是画出来再禁用，也不是按"桌面/手机"开分支）；
 *   3. **唯一出口** `onResolve(id, outcome)`。
 *
 * 外壳（托盘定位、遮罩、portal、点遮罩=拒绝、键盘）**留在宿主**：卡不决定自己挂在哪儿。
 * 同一个 `.decision-tray` 在桌面 `codem-ui.css` 里是 `position: fixed` 的浮层，
 * 在权限弹窗的遮罩里则由外壳把定位收回（`.permission-overlay .decision-tray`）。
 *
 * ## 关于类名
 *
 * DOM/类名逐字沿用桌面**已上线**的形态（`.decision-tray*`、`.clarification-*`、计划弹窗的内联样式）：
 * 这样这一步的桌面外观零变化，样式仍然由 `src/styles/codem-ui.css` / `src/styles.css` 提供；
 * 手机壳自己补一份最小替身（`packages/host/web/index.html`）。
 * **把这两份 CSS 收进共享包是下一步**（`ui.css`），所以这里刻意不做改名。
 */
import { Fragment, memo, useMemo, useState } from "react";
import { Check, ChevronDown, ClipboardList, ShieldAlert, X } from "lucide-react";

// ====== 数据模型 ======

export type DecisionRisk = "low" | "medium" | "high";

/** 审批：放行 / 拒绝。`detail` 是「批准前必须看见的那段内容」（bash=命令，其余=参数 JSON）。 */
export interface ApprovalDecisionRequest {
  kind: "approval";
  id: string;
  /** 工具名（`bash` / `write` / `edit` …） */
  tool: string;
  /** 一句话说明（`执行命令: xxx` / 手机上 Host 给的 summary） */
  summary: string;
  /** 长内容：命令或参数 JSON（缺省表示没有可展示的明细） */
  detail?: string;
  /** 涉及资源路径（桌面权限弹窗的「资源路径」行） */
  resource?: string;
  /** 来源标注（`[手机发起]` / `[委派任务]`）：让用户知道这条请求是谁发起的 */
  originLabel?: string;
  /** 风险级别：由宿主自己算（工具 + 参数），卡只负责按级别显示 */
  risk?: DecisionRisk;
}

/** 计划审批：模型 `exit_plan_mode` 提交的计划全文。 */
export interface PlanDecisionRequest {
  kind: "plan";
  id: string;
  plan: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  type: "radio" | "checkbox" | "text";
  options?: string[];
  placeholder?: string;
  /** 必填：未作答时「提交」不可用（不是点下去再弹一个错误框） */
  required?: boolean;
}

/** 澄清：AI 反问（`ask_clarification`）。多问题时按顺序逐题渲染。 */
export interface ClarificationDecisionRequest {
  kind: "clarification";
  id: string;
  questions: ClarificationQuestion[];
}

export type DecisionRequest =
  | ApprovalDecisionRequest
  | PlanDecisionRequest
  | ClarificationDecisionRequest;

export type DecisionOutcome =
  | { kind: "allow" }
  | { kind: "always-allow" }
  /** `reason`（可选）是给引擎的拒绝理由：宿主必须原样放进 `PermissionResult.reason`，由引擎带进工具结果 */
  | { kind: "deny"; reason?: string }
  | { kind: "plan-approve" }
  | { kind: "plan-reject"; feedback: string }
  | { kind: "clarify"; answers: Record<string, string | string[]> }
  | { kind: "cancel" };

/**
 * 宿主能力位（**必填**）：只有宿主真的会兑现的能力才置 true。
 *
 * `alwaysAllow` —— 「始终允许」要求宿主能把决策记住并真的跳过下一次询问。
 * 引擎侧**已经兑现**：`agentic-loop.ts` 读 `PermissionResult.alwaysAllow`，按**会话 + 精确
 * `(tool, resource)`** 记忆（不写通配，避免盖过 S2 的硬 deny）。所以宿主要在
 * "**下一次真的会问、且真的会被记住**"的入口才打开它（桌面前台 ask 模式）；
 * `auto` 模式会对危险命令二次裁决、`full` 根本不问 ⇒ 那里画出来就是骗人。
 * 远端审批（手机/微信发起的回合）刻意只做一次性授权（`approval-broker.ts` AB-4）。
 */
export interface DecisionCapabilities {
  alwaysAllow: boolean;
  /** 拒绝是否分两步（先展开理由输入框，再「确认拒绝」）；宿主必须能把理由送到消费方 */
  rejectReason: boolean;
}

export interface DecisionLabels {
  approve: string;
  reject: string;
  confirmReject: string;
  rejectReasonPlaceholder: string;
  alwaysAllow: string;
  resource: string;
  expand: string;
  collapse: string;
  riskLow: string;
  riskMedium: string;
  riskHigh: string;
  requiredMark: string;
  textPlaceholder: string;
  submit: string;
  cancel: string;
  planTitle: string;
  planIntro: string;
  planApprove: string;
  planReject: string;
  planConfirmReject: string;
  planBack: string;
  planFeedbackPlaceholder: string;
}

/** 默认文案（中文）：宿主只覆盖自己语言/措辞不同的键 */
export const DEFAULT_DECISION_LABELS: DecisionLabels = {
  approve: "批准",
  reject: "拒绝",
  confirmReject: "确认拒绝",
  rejectReasonPlaceholder: "拒绝原因（可选）",
  alwaysAllow: "始终允许",
  resource: "资源路径",
  expand: "展开",
  collapse: "折叠",
  riskLow: "低风险",
  riskMedium: "中风险",
  riskHigh: "高风险",
  requiredMark: " *",
  textPlaceholder: "请输入您的回答...",
  submit: "提交",
  cancel: "取消",
  planTitle: "计划审批",
  planIntro: "模型提交了以下计划，请审批后开始执行：",
  planApprove: "批准并执行",
  planReject: "拒绝",
  planConfirmReject: "拒绝计划",
  planBack: "返回",
  planFeedbackPlaceholder: "输入拒绝理由（可选）...",
};

const RISK_COLOR: Record<DecisionRisk, string> = {
  low: "var(--success)",
  medium: "var(--warning)",
  high: "var(--error)",
};

// ====== Host 视图 → 卡片请求 ======

/** Host 侧审批视图（`approval.requested` 事件的 `payload.approval`）。 */
export interface ApprovalItem {
  approvalId: string;
  tool: string;
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * 把 Host 的审批视图映射成卡片请求。
 *
 * `details` 里除 `command` 之外的键（`write` 的 `path`/`bytes`、bash 的 `cwd`）以前在手机上
 * **整段丢掉**（旧手机卡只读 `details.command`），于是 write/edit 审批在手机上没有内容可看。
 * 现在命令仍按命令原文展示，其余细节作为 JSON 明细展示。
 */
export function toApprovalDecision(item: ApprovalItem): ApprovalDecisionRequest {
  const details = item.details ?? {};
  const command = typeof details.command === "string" ? details.command : undefined;
  const rest = Object.fromEntries(Object.entries(details).filter(([key]) => key !== "command"));
  const detail = command ?? (Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : undefined);
  return {
    kind: "approval",
    id: item.approvalId,
    tool: item.tool,
    summary: item.summary,
    ...(detail === undefined ? {} : { detail }),
  };
}

// ====== 卡片 ======

export interface ApprovalCardProps {
  request: DecisionRequest;
  capabilities: DecisionCapabilities;
  /** 文案覆盖（宿主语言）：只传需要覆盖的键 */
  labels?: Partial<DecisionLabels>;
  /** 宿主正在提交（手机 Host 往返期间）：动作按钮禁用 */
  busy?: boolean;
  /** 唯一出口 */
  onResolve: (id: string, outcome: DecisionOutcome) => void;
}

export const ApprovalCard = memo(function ApprovalCard({
  request,
  capabilities,
  labels,
  busy = false,
  onResolve,
}: ApprovalCardProps) {
  const text = useMemo(() => ({ ...DEFAULT_DECISION_LABELS, ...labels }), [labels]);

  /* 三个分支共用的交互状态：可折叠、两步拒绝、计划反馈、澄清作答。
     全部放在组件顶层（而不是拆成三个子组件）是有意的 —— 一份实现、一套状态语义。 */
  const [expanded, setExpanded] = useState(true);
  const [rejectArmed, setRejectArmed] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [feedbackShown, setFeedbackShown] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  // ---------- 审批 ----------
  if (request.kind === "approval") {
    const riskText =
      request.risk === "low" ? text.riskLow
        : request.risk === "medium" ? text.riskMedium
          : request.risk === "high" ? text.riskHigh
            : null;

    const reject = (): void => {
      if (!capabilities.rejectReason) {
        onResolve(request.id, { kind: "deny" });
        return;
      }
      if (!rejectArmed) {
        setRejectArmed(true);
        return;
      }
      const reason = rejectReason.trim();
      onResolve(request.id, reason ? { kind: "deny", reason } : { kind: "deny" });
      setRejectReason("");
      setRejectArmed(false);
    };

    return (
      <div
        className="decision-tray"
        role="alertdialog"
        aria-label={request.tool}
        data-decision-kind="approval"
        data-decision-id={request.id}
      >
        <div className="decision-tray-header">
          <button
            className="decision-tray-toggle"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? text.collapse : text.expand}
          >
            <ChevronDown size={14} className={expanded ? "" : "rotated"} />
          </button>
          <ShieldAlert size={16} className="decision-tray-icon approval" />
          <div className="decision-tray-title-area">
            <strong>{request.tool}</strong>
            {request.originLabel ? <span>{request.originLabel}</span> : null}
            {riskText ? (
              <span style={{ color: RISK_COLOR[request.risk as DecisionRisk] }}>{riskText}</span>
            ) : null}
            <span>{request.summary}</span>
          </div>
        </div>

        {expanded && (
          <div className="decision-tray-body">
            {request.detail ? (
              <div className="decision-tray-args">
                <pre>{request.detail}</pre>
              </div>
            ) : null}

            {request.resource ? (
              <div className="decision-tray-question">
                <label>{text.resource}</label>
                <span className="mono">{request.resource}</span>
              </div>
            ) : null}

            {rejectArmed ? (
              <input
                className="decision-tray-reject-input"
                placeholder={text.rejectReasonPlaceholder}
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                autoFocus
              />
            ) : null}

            <div className="decision-tray-actions">
              <button
                className="decision-tray-btn approve"
                disabled={busy}
                onClick={() => onResolve(request.id, { kind: "allow" })}
              >
                <Check size={14} />
                <span>{text.approve}</span>
              </button>
              {capabilities.alwaysAllow ? (
                <button
                  className="decision-tray-btn submit"
                  disabled={busy}
                  onClick={() => onResolve(request.id, { kind: "always-allow" })}
                >
                  <Check size={14} />
                  <span>{text.alwaysAllow}</span>
                </button>
              ) : null}
              <button className="decision-tray-btn reject" disabled={busy} onClick={reject}>
                <X size={14} />
                <span>{rejectArmed ? text.confirmReject : text.reject}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---------- 计划审批 ----------
  if (request.kind === "plan") {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={text.planTitle}
        data-decision-kind="plan"
        data-decision-id={request.id}
        /* 点卡片内部不应触发外壳的「点遮罩 = 拒绝」 */
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "90vw", maxWidth: 680, maxHeight: "80vh",
          background: "var(--bg-primary, #1e1e2e)",
          borderRadius: "var(--radius-md)", display: "flex", flexDirection: "column",
          border: "1px solid var(--border-primary)",
          overflow: "hidden",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-primary)",
        }}>
          <ClipboardList size={16} />
          <span style={{ fontSize: "var(--fs-lg)", fontWeight: 700 }}>{text.planTitle}</span>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginBottom: 8 }}>
            {text.planIntro}
          </div>
          <div style={{
            background: "var(--bg-secondary, #181825)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius)", padding: 12,
            fontSize: "var(--fs-base)", lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            fontFamily: "'Cascadia Code', 'Fira Code', monospace",
            maxHeight: "50vh", overflowY: "auto",
          }}>
            {request.plan}
          </div>
        </div>

        {feedbackShown && (
          <div style={{ padding: "0 16px 8px" }}>
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={text.planFeedbackPlaceholder}
              style={{
                width: "100%", minHeight: 60, padding: "8px 10px",
                background: "var(--bg-secondary, #181825)",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-sm)", color: "inherit", fontSize: "var(--fs-base)",
                resize: "vertical",
              }}
              autoFocus
            />
          </div>
        )}

        <div style={{
          display: "flex", gap: 8, justifyContent: "flex-end",
          padding: "12px 16px",
          borderTop: "1px solid var(--border-primary)",
        }}>
          {feedbackShown ? (
            <>
              <button onClick={() => { setFeedbackShown(false); setFeedback(""); }} style={PLAN_BUTTON_STYLE} disabled={busy}>
                {text.planBack}
              </button>
              <button
                onClick={() => onResolve(request.id, { kind: "plan-reject", feedback })}
                style={{ ...PLAN_BUTTON_STYLE, background: "var(--error)", color: "var(--text-on-accent)", border: "none" }}
                disabled={busy}
              >
                <X size={14} />
                {text.planConfirmReject}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setFeedbackShown(true)} style={PLAN_BUTTON_STYLE} disabled={busy}>
                <X size={14} />
                {text.planReject}
              </button>
              <button
                onClick={() => onResolve(request.id, { kind: "plan-approve" })}
                style={{ ...PLAN_BUTTON_STYLE, background: "var(--success)", color: "var(--text-on-accent)", border: "none" }}
                disabled={busy}
              >
                <Check size={14} />
                {text.planApprove}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ---------- 澄清（AI 反问） ----------
  const answered = (question: ClarificationQuestion): boolean => {
    const value = answers[question.id];
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "string" && value.trim() !== "";
  };
  const complete = request.questions.every((question) => !question.required || answered(question));
  const setAnswer = (id: string, value: string | string[]): void =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  return (
    <div
      className="clarification-form"
      data-decision-kind="clarification"
      data-decision-id={request.id}
    >
      {request.questions.map((question) => (
        /* Fragment（不是包一层 div）：`.clarification-form` 是 flex + gap 容器，
           多包一层会吃掉题面/必填标记/输入区之间的间距，与桌面原来的 DOM 不一致。 */
        <Fragment key={question.id}>
          <div className="clarification-question">{question.question}</div>
          {question.required ? (
            <div className="clarification-required">{text.requiredMark}</div>
          ) : null}

          <div className="clarification-inputs">
            {question.type === "radio" && question.options ? (
              <div className="radio-group">
                {question.options.map((option) => (
                  <label key={option} className="radio-option">
                    <input
                      type="radio"
                      name={question.id}
                      value={option}
                      checked={answers[question.id] === option}
                      onChange={() => setAnswer(question.id, option)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            ) : null}

            {question.type === "checkbox" && question.options ? (
              <div className="checkbox-group">
                {question.options.map((option) => {
                  const picked = Array.isArray(answers[question.id])
                    ? (answers[question.id] as string[])
                    : [];
                  return (
                    <label key={option} className="checkbox-option">
                      <input
                        type="checkbox"
                        name={question.id}
                        value={option}
                        checked={picked.includes(option)}
                        onChange={(event) =>
                          setAnswer(
                            question.id,
                            event.target.checked
                              ? [...picked, option]
                              : picked.filter((value) => value !== option),
                          )
                        }
                      />
                      <span>{option}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            {question.type === "text" ? (
              <textarea
                className="clarification-textarea"
                rows={3}
                placeholder={question.placeholder ?? text.textPlaceholder}
                value={typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""}
                onChange={(event) => setAnswer(question.id, event.target.value)}
              />
            ) : null}
          </div>
        </Fragment>
      ))}

      <div className="clarification-actions">
        <button
          className="clarification-btn submit"
          disabled={busy || !complete}
          onClick={() => onResolve(request.id, { kind: "clarify", answers })}
        >
          {text.submit}
        </button>
        <button
          className="clarification-btn cancel"
          disabled={busy}
          onClick={() => onResolve(request.id, { kind: "cancel" })}
        >
          {text.cancel}
        </button>
      </div>
    </div>
  );
});

const PLAN_BUTTON_STYLE = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "6px 14px", borderRadius: "var(--radius-sm)", fontSize: "var(--fs-base)", cursor: "pointer",
  border: "1px solid var(--border-primary)", background: "transparent", color: "inherit",
} as const;
