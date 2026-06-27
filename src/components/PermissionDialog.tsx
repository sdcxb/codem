import type { PermissionRequest } from "../core/permission/permission";

interface PermissionDialogProps {
  request: PermissionRequest;
  onResolve: (allow: boolean, alwaysAllow?: boolean) => void;
}

function getToolDescription(tool: string, input: Record<string, unknown>): string {
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
    case "spawn_subagent":
      return `启动子智能体: ${input.agentId || "?"}`;
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
  return "medium";
}

function getRiskColor(level: "low" | "medium" | "high"): string {
  switch (level) {
    case "low": return "var(--success)";
    case "medium": return "var(--warning)";
    case "high": return "var(--error)";
  }
}

function getRiskLabel(level: "low" | "medium" | "high"): string {
  switch (level) {
    case "low": return "低风险";
    case "medium": return "中风险";
    case "high": return "高风险";
  }
}

export function PermissionDialog({ request, onResolve }: PermissionDialogProps) {
  const description = getToolDescription(request.tool, request.input);
  const riskLevel = getRiskLevel(request.tool, request.input);

  return (
    <div className="permission-overlay">
      <div className="permission-dialog">
        <div className="permission-header">
          <span className="permission-icon">🔒</span>
          <h3>需要权限确认</h3>
        </div>

        <div className="permission-body">
          <div className="permission-tool">
            <span className="permission-tool-name">{request.tool}</span>
            <span
              className="permission-risk"
              style={{ color: getRiskColor(riskLevel) }}
            >
              {getRiskLabel(riskLevel)}
            </span>
          </div>

          <div className="permission-description">{description}</div>

          {request.resource && (
            <div className="permission-resource">
              <label>资源路径</label>
              <span className="mono">{request.resource}</span>
            </div>
          )}
        </div>

        <div className="permission-actions">
          <button
            className="permission-btn deny"
            onClick={() => onResolve(false)}
          >
            拒绝
          </button>
          <button
            className="permission-btn allow"
            onClick={() => onResolve(true)}
          >
            允许
          </button>
          <button
            className="permission-btn allow-always"
            onClick={() => onResolve(true, true)}
          >
            始终允许
          </button>
        </div>
      </div>
    </div>
  );
}
