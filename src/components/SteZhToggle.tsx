/**
 * SteZhToggle — 顶部一键启停「简化技术中文汇报」插件。
 *
 * 只切换设置；下一轮 buildSystemPrompt 读取设置后决定是否注入规则。
 * 历史消息不重写。
 */
import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import {
  STE_ZH_CHANGED_EVENT,
  isSteZhEnabled,
  setSteZhEnabled,
} from "../core/ste-zh";
import { useLang } from "../core/i18n/lang";

export function SteZhToggle() {
  const lang = useLang();
  const zh = lang === "zh";
  const [enabled, setEnabled] = useState(() => isSteZhEnabled());

  useEffect(() => {
    const sync = () => setEnabled(isSteZhEnabled());
    window.addEventListener(STE_ZH_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(STE_ZH_CHANGED_EVENT, sync as EventListener);
  }, []);

  return (
    <button
      className={`agent-toggle ${enabled ? "active" : ""}`}
      onClick={() => setSteZhEnabled(!enabled)}
      title={
        zh
          ? `STE 汇报规范：${enabled ? "已开启（点击关闭）" : "已关闭（点击开启）"}`
          : `STE reporting: ${enabled ? "on (click to turn off)" : "off (click to turn on)"}`
      }
      aria-pressed={enabled}
    >
      <MessageSquareText size={16} />
    </button>
  );
}
