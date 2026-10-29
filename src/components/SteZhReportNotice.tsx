/**
 * SteZhReportNotice — 回复后轻量警告：只提示，不改写正文。
 *
 * 目前只抓一种高价值错位：正文写“已验证”，但本轮没有任何测试/构建/类型检查命令。
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  STE_ZH_CHANGED_EVENT,
  getSteZhMode,
  validateSteZhReport,
} from "../core/ste-zh";

export function SteZhReportNotice({
  text,
  toolCalls,
}: {
  text: string;
  toolCalls?: Array<{ tool?: string; args?: unknown; status?: string }>;
}) {
  const [enabled, setEnabled] = useState(() => getSteZhMode() !== "off");

  useEffect(() => {
    const sync = () => setEnabled(getSteZhMode() !== "off");
    window.addEventListener(STE_ZH_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(STE_ZH_CHANGED_EVENT, sync as EventListener);
  }, []);

  const findings = useMemo(
    () => (enabled ? validateSteZhReport(text, toolCalls) : []),
    [enabled, text, toolCalls],
  );

  if (findings.length === 0) return null;
  return (
    <div className="ste-zh-report-warning" role="status">
      <AlertTriangle size={12} />
      <span>{findings[0].message}</span>
    </div>
  );
}
