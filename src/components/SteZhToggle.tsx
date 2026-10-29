/**
 * SteZhToggle — 顶部三态开关：关 → 智能 → 全量 → 关。
 *
 * - 关：不注入规则；
 * - 智能：短任务/普通短请求走最小规则，汇报/子 agent 走完整/字段规则；
 * - 全量：始终完整规则。
 *
 * 只切换设置；下一轮 buildSystemPrompt 读取后决定注入内容。历史消息不重写。
 */
import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import {
  STE_ZH_CHANGED_EVENT,
  cycleSteZhMode,
  getSteZhMode,
  setSteZhMode,
  type SteZhMode,
} from "../core/ste-zh";
import { useLang } from "../core/i18n/lang";

const LABELS: Record<SteZhMode, { zh: string; en: string }> = {
  off: { zh: "关闭（点击开启智能模式）", en: "off (click for smart mode)" },
  smart: { zh: "智能模式（点击切到全量）", en: "smart (click for full mode)" },
  full: { zh: "全量模式（点击关闭）", en: "full (click to turn off)" },
};

export function SteZhToggle() {
  const lang = useLang();
  const zh = lang === "zh";
  const [mode, setMode] = useState<SteZhMode>(() => getSteZhMode());

  useEffect(() => {
    const sync = () => setMode(getSteZhMode());
    window.addEventListener(STE_ZH_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(STE_ZH_CHANGED_EVENT, sync as EventListener);
  }, []);

  const next = cycleSteZhMode(mode);
  return (
    <button
      className={`agent-toggle ${mode !== "off" ? "active" : ""}`}
      onClick={() => setSteZhMode(next)}
      title={`STE 汇报规范：${LABELS[mode][zh ? "zh" : "en"]}`}
      aria-pressed={mode !== "off"}
      data-ste-zh-mode={mode}
    >
      <MessageSquareText size={16} />
    </button>
  );
}
