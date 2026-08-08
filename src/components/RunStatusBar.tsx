/**
 * RunStatusBar — 运行状态条
 *
 * 在对话区顶部显示当前运行状态（思考中/执行中/呈现中），
 * 包含阶段图标、处理消息、经过时长。
 */

import { memo, useState, useEffect } from "react";
import { Brain, LoaderCircle, Sparkles, CheckCircle2, TriangleAlert, Circle } from "lucide-react";
import type { RunPhase } from "../core/llm/run-status-tracker";
import { phaseLabel, processingMessage, formatRunDuration, getRunElapsed } from "../core/llm/run-status-tracker";

interface RunStatusBarProps {
  phase: RunPhase;
  startedAt: number | null;
  isRunning: boolean;
  error?: string;
  /** 目标工具/Agent 名称 */
  target?: string;
  /** 可点击跳转到底部 */
  onClick?: () => void;
}

const PHASE_ICON: Record<RunPhase, typeof Brain> = {
  idle: Circle,
  thinking: Brain,
  working: LoaderCircle,
  presenting: Sparkles,
  reviewing: CheckCircle2,
  completed: CheckCircle2,
  error: TriangleAlert,
};

export const RunStatusBar = memo(function RunStatusBar({
  phase,
  startedAt,
  isRunning,
  error = "",
  target = "",
  onClick,
}: RunStatusBarProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning || !startedAt) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => {
      setElapsed(getRunElapsed({ phase, startedAt, isRunning, target, error } as any));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, startedAt, phase, target, error]);

  if (!isRunning && phase !== "error" && phase !== "completed") return null;

  const Icon = PHASE_ICON[phase] || Circle;
  const label = phase === "error" ? error || "运行出错" : processingMessage(phase) || phaseLabel(phase);

  return (
    <div
      className={`run-status-bar phase-${phase} ${onClick ? "clickable" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <div className="run-status-bar-left">
        <Icon
          size={14}
          className={isRunning && (phase === "working" || phase === "thinking") ? "spinning" : ""}
        />
        <span className="run-status-bar-label">{label}</span>
        {target && <span className="run-status-bar-target">{target}</span>}
      </div>
      {isRunning && startedAt && (
        <span className="run-status-bar-time">{formatRunDuration(elapsed)}</span>
      )}
    </div>
  );
});
