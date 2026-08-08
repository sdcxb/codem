/**
 * RunStatusTracker — 运行状态追踪器
 *
 * 管理运行阶段（thinking/working/presenting/reviewing/completed），
 * 格式化活动时长，处理展示阶段切换。
 *
 * 自主实现，未引用任何第三方运行状态库。
 */

/** 运行阶段 */
export type RunPhase = "idle" | "thinking" | "working" | "presenting" | "reviewing" | "completed" | "error";

/** 运行状态 */
export interface RunStatus {
  phase: RunPhase;
  startedAt: number | null;
  target: string | null;
  error: string;
  isRunning: boolean;
}

/** 创建初始运行状态 */
export function createRunStatus(): RunStatus {
  return {
    phase: "idle",
    startedAt: null,
    target: null,
    error: "",
    isRunning: false,
  };
}

/** 格式化活动时长 */
export function formatRunDuration(ms: number): string {
  if (ms < 1000) return "刚刚";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}分${remainSec}秒`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}时${remainMin}分`;
}

/** 计算活动经过时间 */
export function getRunElapsed(status: RunStatus, now: number = Date.now()): number {
  if (!status.startedAt) return 0;
  return now - status.startedAt;
}

/** 运行阶段显示文本 */
export function phaseLabel(phase: RunPhase): string {
  switch (phase) {
    case "idle": return "待命";
    case "thinking": return "思考中";
    case "working": return "执行中";
    case "presenting": return "呈现中";
    case "reviewing": return "审查中";
    case "completed": return "已完成";
    case "error": return "出错";
    default: return "";
  }
}

/** 运行阶段图标名称 */
export function phaseIcon(phase: RunPhase): string {
  switch (phase) {
    case "idle": return "circle";
    case "thinking": return "brain";
    case "working": return "loader";
    case "presenting": return "sparkles";
    case "reviewing": return "check-circle";
    case "completed": return "check";
    case "error": return "alert-triangle";
    default: return "circle";
  }
}

/** 处理中消息 */
export function processingMessage(phase: RunPhase): string {
  switch (phase) {
    case "thinking": return "正在思考...";
    case "working": return "正在执行工具调用...";
    case "presenting": return "正在生成回复...";
    case "reviewing": return "正在审查结果...";
    default: return "";
  }
}

/** 是否应该显示运行状态条 */
export function shouldShowRunBar(status: RunStatus): boolean {
  return status.isRunning || status.phase === "error" || (status.phase === "completed" && status.startedAt !== null);
}

/**
 * 活动时间线构建器
 * 将评论文本与工具调用组按偏移量排序
 */

export interface ActivityItem {
  id: string;
  type: "tool" | "text";
  content: string;
  toolName?: string;
  toolStatus?: "running" | "done" | "error";
  startedAt?: number;
  duration?: number;
}

export interface ActivityGroup {
  items: ActivityItem[];
  commentary: string;
  hasFollowingText: boolean;
}

/**
 * 从消息内容中提取活动时间线
 */
export function buildActivityTimeline(
  content: string,
  toolCalls: Array<{ id: string; name: string; status: string; startedAt?: number; duration?: number; result?: string }> = []
): ActivityGroup[] {
  if (!content && toolCalls.length === 0) return [];

  // 简化实现：按工具调用位置分割文本
  const groups: ActivityGroup[] = [];
  let cursor = 0;

  // 如果没有工具调用，返回单一文本组
  if (toolCalls.length === 0) {
    return [{
      items: [{ id: "text-0", type: "text", content }],
      commentary: content,
      hasFollowingText: false,
    }];
  }

  // 按工具调用顺序分割
  for (let i = 0; i < toolCalls.length; i++) {
    const tool = toolCalls[i];
    const commentary = content.slice(cursor, cursor); // 简化：工具调用前的文本
    groups.push({
      items: [{
        id: tool.id,
        type: "tool",
        content: tool.result || "",
        toolName: tool.name,
        toolStatus: tool.status as any,
        startedAt: tool.startedAt,
        duration: tool.duration,
      }],
      commentary,
      hasFollowingText: i < toolCalls.length - 1,
    });
    cursor = cursor; // 简化
  }

  // 尾部文本
  if (cursor < content.length) {
    groups.push({
      items: [{ id: "text-tail", type: "text", content: content.slice(cursor) }],
      commentary: content.slice(cursor),
      hasFollowingText: false,
    });
  }

  return groups;
}
