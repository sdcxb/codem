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

/*
 * ## 第 97 轮：删掉 `buildActivityTimeline()`（连同 ActivityItem / ActivityGroup）
 *
 * 它原来是"活动时间线"的数据来源，但**没有任何消费方**：全仓 grep 只剩两处**注释**在提它
 * （`App.tsx` 说"由别的呈现路径消费"、`codem-ui.css` 说"数据仍由它产出"），
 * `项目功能树-全量.md` 也记着「当前无消费方（TrajectoryPanel 自绘轨迹）」。
 *
 * 而且它的实现是个**半成品**（源码里自己写着"简化"）：
 * `const commentary = content.slice(cursor, cursor)` 恒为空串、`cursor = cursor` 从不前进，
 * 于是内容会被整段塞进末尾的 "text-tail" 组 —— 谁真去调它，拿到的就是**错的归属**。
 *
 * 留着它有实际风险（不查调用方就调用 ⇒ 界面上的文本挂错位置），所以按本仓库"死代码要定性"的纪律删掉；
 * 两处提到它的注释也已同步改掉（注释指向不存在的东西，与代码说谎是同一类问题）。
 */
