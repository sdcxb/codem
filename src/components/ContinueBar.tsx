/**
 * 桌面端「继续」条（与共享 UI 的 ContinueBar 对齐）。
 *
 * 为什么只是一个按钮：仓库硬规则禁止自动续跑/目标模式（AGENTS.md §5.9）。
 * 上一轮**正常结束**后给出可点的「继续」，用户点才发下一轮 —— 不自动开轮、不持久化目标。
 */
import { useLang } from "../core/i18n/lang";

export function ContinueBar({ onContinue }: { onContinue: () => void }): React.ReactElement {
  const zh = useLang() === "zh";
  return (
    <div
      data-testid="continue-bar"
      style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "4px 0" }}
    >
      <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>
        {zh ? "上一轮结束了" : "Last turn finished"}
      </span>
      <button type="button" onClick={onContinue}>
        {zh ? "继续" : "Continue"}
      </button>
    </div>
  );
}
