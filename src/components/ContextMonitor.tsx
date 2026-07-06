import { useState, useEffect } from "react";
import { getLLMEngine } from "../core/llm";
import { getContextManager, type TokenBudget } from "../core/context/context";
import { getCostTracker } from "../core/llm/cost-tracker";

interface ContextMonitorProps {
  sessionId: string;
  visible: boolean;
}

export function ContextMonitor({ sessionId, visible }: ContextMonitorProps) {
  const [budget, setBudget] = useState<TokenBudget | null>(null);
  const [pressure, setPressure] = useState(0);
  const [todayCost, setTodayCost] = useState(0);

  useEffect(() => {
    if (!visible) return;

    const update = () => {
      try {
        const { listMessages } = require("../core/storage/message");
        const messages = listMessages(sessionId);

        const contextManager = getContextManager();
        const b = contextManager.calculateBudgetFromMessages(messages);
        setBudget(b);
        setPressure(contextManager.getPressureLevelFromMessages(messages));

        const costTracker = getCostTracker();
        const today = costTracker.getTodayCost();
        setTodayCost(today);
      } catch {}
    };

    update();
    const interval = setInterval(update, 3000);
    return () => clearInterval(interval);
  }, [sessionId, visible]);

  if (!visible || !budget) return null;

  const usagePercent = Math.round((budget.used / budget.available) * 100);
  const pressureColor = pressure === 0 ? "var(--success)"
    : pressure === 1 ? "var(--info)"
    : pressure === 2 ? "var(--warning)"
    : "var(--error)";

  const pressureLabel = pressure === 0 ? "正常"
    : pressure === 1 ? "中等"
    : pressure === 2 ? "较高"
    : "临界";

  return (
    <div className="context-monitor">
      <div className="context-monitor-header">
        <span className="context-monitor-icon">📊</span>
        <span>上下文状态</span>
      </div>

      <div className="context-monitor-body">
        <div className="context-usage">
          <div className="context-usage-bar">
            <div
              className="context-usage-fill"
              style={{ width: `${Math.min(usagePercent, 100)}%`, background: pressureColor }}
            />
          </div>
          <div className="context-usage-info">
            <span>{budget.used.toLocaleString()} / {budget.available.toLocaleString()} tokens</span>
            <span style={{ color: pressureColor }}>{usagePercent}%</span>
          </div>
        </div>

        <div className="context-stats">
          <div className="context-stat">
            <span className="context-stat-label">压力等级</span>
            <span className="context-stat-value" style={{ color: pressureColor }}>
              {pressureLabel}
            </span>
          </div>
          <div className="context-stat">
            <span className="context-stat-label">剩余</span>
            <span className="context-stat-value">{budget.remaining.toLocaleString()} tokens</span>
          </div>
          <div className="context-stat">
            <span className="context-stat-label">今日费用</span>
            <span className="context-stat-value">${todayCost.toFixed(4)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
