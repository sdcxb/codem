/**
 * 桌面端「继续」条（与共享 UI 的 ContinueBar 同形）。
 *
 * 只在**普通会话**的一轮正常结束后出现；目标模式由 GoalModeBar 管（ADR-0006）。
 * 用户点才发下一轮 —— 不自动开轮、不持久化目标。
 *
 * 样式必须走共享类：`.continue-bar` 负责布局，`.primary` 负责主题按钮。
 * 2026-11-04 真机回归发现这里曾用内联 flex + 裸 `<button>`：
 * 内容贴到窗口最右、按钮退回浏览器默认样式（共享 CSS 完全没生效）。
 */
import { useLang } from "../core/i18n/lang";

export function ContinueBar({ onContinue }: { onContinue: () => void }): React.ReactElement {
  const zh = useLang() === "zh";
  return (
    <div className="continue-bar desktop-continue-bar" data-testid="continue-bar">
      <span className="continue-hint">
        {zh ? "上一轮结束了" : "Last turn finished"}
      </span>
      <button type="button" className="primary" onClick={onContinue}>
        {zh ? "继续" : "Continue"}
      </button>
    </div>
  );
}
