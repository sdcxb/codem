/**
 * BootSplash — 启动加载屏
 *
 * 应用启动时显示的优雅加载动画。
 * 包含：
 * - 居中 Logo + 脉冲动画
 * - 加载进度条
 * - 加载状态文字
 * - 渐隐退出动画
 *
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 */

import { useState, useEffect, memo } from "react";
import { LoaderCircle, Sparkles, CheckCircle2 } from "lucide-react";

interface BootSplashProps {
  /** 是否可见 */
  visible: boolean;
  /** 加载阶段 */
  phase?: "initializing" | "loading-db" | "loading-config" | "ready";
  /** 加载进度（0-100） */
  progress?: number;
  /** 应用名称 */
  appName?: string;
  /** 加载完成回调（渐隐动画结束后） */
  onComplete?: () => void;
}

const PHASE_LABELS: Record<string, { zh: string; en: string }> = {
  initializing: { zh: "正在初始化...", en: "Initializing..." },
  "loading-db": { zh: "正在加载数据库...", en: "Loading database..." },
  "loading-config": { zh: "正在加载配置...", en: "Loading configuration..." },
  ready: { zh: "就绪", en: "Ready" },
};

export const BootSplash = memo(function BootSplash({
  visible,
  phase = "initializing",
  progress = 0,
  appName = "Codem",
  onComplete,
}: BootSplashProps) {
  const [fadingOut, setFadingOut] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!visible) {
      setHidden(true);
      return;
    }
    setHidden(false);
    setFadingOut(false);
  }, [visible]);

  // 当 phase 变为 ready 时，启动渐隐动画
  useEffect(() => {
    if (phase === "ready" && visible) {
      const timer = setTimeout(() => {
        setFadingOut(true);
        setTimeout(() => {
          setHidden(true);
          onComplete?.();
        }, 400);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [phase, visible, onComplete]);

  if (hidden) return null;

  const isReady = phase === "ready";
  const phaseLabel = PHASE_LABELS[phase]?.zh || PHASE_LABELS.initializing.zh;
  const displayProgress = isReady ? 100 : Math.max(0, Math.min(100, progress));

  return (
    <div
      className={`boot-splash ${fadingOut ? "fading-out" : ""} ${isReady ? "ready" : ""}`}
      aria-hidden={!visible}
    >
      <div className="boot-splash-content">
        {/* Logo 区域 */}
        <div className="boot-splash-logo">
          {isReady ? (
            <CheckCircle2 size={48} className="boot-splash-logo-icon ready" />
          ) : (
            <Sparkles size={48} className="boot-splash-logo-icon pulsing" />
          )}
        </div>

        {/* 应用名称 */}
        <h1 className="boot-splash-title">{appName}</h1>

        {/* 加载状态 */}
        <div className="boot-splash-status">
          {!isReady && (
            <LoaderCircle size={14} className="spinning boot-splash-spinner" />
          )}
          <span className="boot-splash-phase">{phaseLabel}</span>
        </div>

        {/* 进度条 */}
        <div className="boot-splash-progress-bar">
          <div
            className="boot-splash-progress-fill"
            style={{ width: `${displayProgress}%` }}
          />
        </div>

        {/* 进度百分比 */}
        <span className="boot-splash-progress-text">
          {Math.round(displayProgress)}%
        </span>
      </div>
    </div>
  );
});
