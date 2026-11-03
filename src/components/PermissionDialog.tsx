/**
 * PermissionDialog — 桌面权限确认弹窗（第 3 步：只剩外壳 + 桌面口径的风险判定）
 *
 * 这一步之前这是**第三份**审批 UI（`.permission-*`）：它比前台托盘多一个「始终允许」、
 * 多一个风险分级、宽 420px 居中。现在卡片本体与前台托盘是同一张
 * （`packages/ui/src/approval-card.tsx`），本文件只剩两件桌面自己的事：
 *
 * 1. **外壳**：`createPortal` + `.permission-overlay` 遮罩（卡不决定自己挂在哪儿；
 *    遮罩里的定位由 `codem-ui.css` 的 `.permission-overlay .decision-tray` 收回）；
 * 2. **桌面口径**：`getToolDescription`（给用户看的一句话）与 `getRiskLevel`
 *    （按工具 + 参数算风险等级）—— 这是桌面业务逻辑，不是 UI 形状。
 *
 * 能力位按入口如实置：
 * - `alwaysAllow`：**恒为 false**。引擎侧已经能兑现「始终允许」（`agentic-loop.ts` 会读
 *   `PermissionResult.alwaysAllow` 并按会话记忆），但这条通道是两个**后台**入口
 *   （委派 / 远端），它们不该替用户做"本次运行内一直放行"的决定：
 *   远端审批更是刻意只做一次性授权（`approval-broker.ts` AB-4）。
 *   桌面**前台**托盘才提供该按钮（`App.tsx` 的 `app.decision-tray`）。
 * - `rejectReason`：由宿主显式打开。只有**理由真能送到引擎**的入口才该开：
 *   委派回合直接兑现引擎 Promise（能送到）；远端待批项要走 `answerApproval()`，
 *   它的契约只有 allow/deny（AB-4），理由送不到 ⇒ 保持一步拒绝。
 */
import { createPortal } from "./ui/portal";
import type { PermissionRequest } from "../core/permission/permission";
import { ApprovalCard } from "../../packages/ui/src/approval-card";

interface PermissionDialogProps {
  request: PermissionRequest;
  onResolve: (allow: boolean, alwaysAllow?: boolean, reason?: string) => void;
  /** 是否提供「拒绝理由」输入框（默认 false：一步拒绝，与远端通道一致） */
  rejectReason?: boolean;
}

export function getToolDescription(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "bash":
      return `执行命令: ${input.command || "?"}`;
    case "write":
      return `写入文件: ${input.path || "?"}`;
    case "edit":
      return `编辑文件: ${input.path || "?"}`;
    case "read":
      return `读取文件: ${input.path || "?"}`;
    case "glob":
      return `搜索文件: ${input.pattern || "?"}`;
    case "grep":
      return `搜索内容: ${input.pattern || "?"}`;
    case "zvec_grep_search":
      return `语义搜索(本地索引): ${(input.query || input.fts || "?").toString()}`;
    case "zvec_grep_rg":
      return `精确搜索(rg): ${(input.command || input.pattern || "?").toString()}`;
    case "spawn_subagent":
    case "subagent":
      return `启动子智能体: ${input.agentId || input.description || "?"}`;
    case "report":
      return `子智能体汇报`;
    case "send_message":
      return `向子智能体 ${input.subagent_id || "?"} 发送消息`;
    case "interrupt_agent":
      return `中断智能体: ${input.agent_id || "?"}`;
    case "list_agents":
      return `列出子智能体`;
    default:
      return `调用工具: ${tool}`;
  }
}

function getRiskLevel(tool: string, input: Record<string, unknown>): "low" | "medium" | "high" {
  if (tool === "bash") {
    const cmd = String(input.command || "");
    if (/rm\s+-rf|git\s+push\s+--force|git\s+reset\s+--hard|sudo|chmod|chown/.test(cmd)) {
      return "high";
    }
    if (/rm\s|mv\s|delete|drop\s+table/i.test(cmd)) {
      return "high";
    }
    if (/git\s+push|npm\s+publish|yarn\s+publish/.test(cmd)) {
      return "medium";
    }
    return "medium";
  }
  if (tool === "write" || tool === "edit") return "medium";
  if (tool === "read" || tool === "glob" || tool === "grep") return "low";
  if (tool.startsWith("zvec_grep_")) return "low"; // zg 检索为只读
  return "medium";
}

/**
 * 审批来源标注：App 给 `request.title` 加了前缀（`[手机发起] bash` / `[委派任务] bash`，
 * 例如 `App.tsx` 的远端审批分支）。去掉工具名后缀就是来源；标题里没有工具名时整段当来源。
 */
function originLabelOf(request: PermissionRequest): string | undefined {
  const title = request.title;
  if (!title) return undefined;
  if (request.tool && title.endsWith(request.tool)) {
    return title.slice(0, title.length - request.tool.length).trim() || undefined;
  }
  return title;
}

export function PermissionDialog({ request, onResolve, rejectReason = false }: PermissionDialogProps) {
  const input = request.input ?? {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const detail = command ?? (Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : undefined);
  const originLabel = originLabelOf(request);
  const risk = getRiskLevel(request.tool, input);

  return createPortal(
    <div className="permission-overlay">
      <ApprovalCard
        request={{
          kind: "approval",
          id: request.id,
          tool: request.tool,
          summary: getToolDescription(request.tool, input),
          risk,
          ...(detail === undefined ? {} : { detail }),
          ...(request.resource ? { resource: request.resource } : {}),
          ...(originLabel ? { originLabel } : {}),
        }}
        capabilities={{ alwaysAllow: false, rejectReason }}
        onResolve={(_id, outcome) => {
          if (outcome.kind === "always-allow") onResolve(true, true);
          // 拒绝理由必须原样交给引擎（`rejectReason` 打开时才有）；空理由不写。
          else if (outcome.kind === "deny") onResolve(false, false, outcome.reason);
          else onResolve(true, false);
        }}
      />
    </div>,
  );
}
