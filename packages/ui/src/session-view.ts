/**
 * 共享 UI 的**纯视图模型**（阶段 2）。
 *
 * 为什么先有它：手机壳、桌面、未来的 Android 壳要显示同一种东西，就必须先把
 * 「消息行 → 界面元素」的映射做成**纯函数**，否则每端都会各自解释一遍（这套仓库最忌讳的
 * 两套行为）。React 组件只是它的渲染器。
 */

export interface MessageRow {
  id: string;
  role: string;
  content?: string;
  toolCallId?: string | null;
  timestamp?: number;
}

export interface ToolInfo {
  name: string;
  output?: string;
  status?: string;
  args?: unknown;
  duration?: number;
}

export type MessageView =
  | { kind: "text"; id: string; roleLabel: string; body: string; role: string }
  | {
      kind: "tool";
      id: string;
      roleLabel: "tool";
      toolName: string;
      toolStatus: string;
      output: string;
    };

const ROLE_LABELS: Record<string, string> = {
  user: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** 消息行 → 视图元素。工具结果按 toolCallId 关联到调用名（关联不上就显示 id，不丢信息）。 */
export function messageViews(rows: MessageRow[], tools: Record<string, ToolInfo> = {}): MessageView[] {
  const out: MessageView[] = [];
  for (const row of rows) {
    if (row.role === "tool") {
      const call = row.toolCallId ? tools[row.toolCallId] : undefined;
      const metaName = (row as { metadata?: { toolName?: unknown } }).metadata?.toolName;
      out.push({
        kind: "tool",
        id: row.id,
        roleLabel: "tool",
        toolName: call?.name ?? (typeof metaName === "string" && metaName ? metaName : row.toolCallId ? `tool:${row.toolCallId}` : "tool"),
        toolStatus: call?.status ?? "done",
        output: String(row.content ?? call?.output ?? ""),
        ...(call?.args !== undefined ? { toolArgs: typeof call.args === "string" ? call.args : JSON.stringify(call.args, null, 2) } : {}),
        ...(typeof call?.duration === "number" ? { duration: call.duration } : {}),
      });
      continue;
    }
    out.push({
      kind: "text",
      id: row.id,
      roleLabel: roleLabel(row.role),
      body: String(row.content ?? ""),
      role: row.role,
    });
  }
  return out;
}

/** 运行状态 → 人话（手机顶部那颗 pill） */
export function runStateLabel(state: string | null | undefined): string {
  switch (state) {
    case "running":
      return "运行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "已失败";
    case "cancelled":
      return "已停止";
    default:
      return "就绪";
  }
}

/** 会话列表的副标题：消息数 + 最后活动时间（没有时间就不显示假的） */
export function sessionMeta(session: { messageCount?: number; lastMessageAt?: number }): string {
  const parts: string[] = [];
  if (typeof session.messageCount === "number") parts.push(`${session.messageCount} 条消息`);
  if (session.lastMessageAt) {
    const d = new Date(session.lastMessageAt);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleString());
  }
  return parts.join(" · ");
}

/** 工具卡片的标题行（`read ✓` / `read …` / `read ✗`） */
export function toolCardTitle(toolName: string, status: string): string {
  const mark = status === "running" ? "…" : status === "error" ? "✗" : "✓";
  return `${toolName} ${mark}`;
}
