/**
 * UsageVisuals — 用量统计可视化组件
 *
 * 包含：
 * - TokenActivityGrid: Token 活跃度热力图（类 GitHub 贡献图）
 * - UsageChart: 每日用量柱状图
 *
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 */

import { memo, useMemo } from "react";
import type { UsageRecord } from "../core/llm/cost-tracker";

// ========== TokenActivityGrid ==========

interface TokenActivityGridProps {
  records: UsageRecord[];
  /** 显示天数（默认 28 天 = 4 周） */
  days?: number;
}

export const TokenActivityGrid = memo(function TokenActivityGrid({
  records,
  days = 28,
}: TokenActivityGridProps) {
  const gridData = useMemo(() => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const cells: { date: number; tokens: number; level: 0 | 1 | 2 | 3 | 4 }[] = [];

    // 按天聚合 token 用量
    const dailyTokens: Record<string, number> = {};
    for (const r of records) {
      const dayKey = new Date(r.timestamp).toDateString();
      dailyTokens[dayKey] = (dailyTokens[dayKey] || 0) + (r.inputTokens + r.outputTokens);
    }

    // 计算最大值用于分级
    const maxTokens = Math.max(...Object.values(dailyTokens), 1);

    // 生成网格数据
    for (let i = days - 1; i >= 0; i--) {
      const date = now - i * dayMs;
      const dayKey = new Date(date).toDateString();
      const tokens = dailyTokens[dayKey] || 0;
      const ratio = tokens / maxTokens;
      let level: 0 | 1 | 2 | 3 | 4 = 0;
      if (tokens > 0) {
        if (ratio < 0.25) level = 1;
        else if (ratio < 0.5) level = 2;
        else if (ratio < 0.75) level = 3;
        else level = 4;
      }
      cells.push({ date, tokens, level });
    }

    return cells;
  }, [records, days]);

  return (
    <div>
      <div className="token-activity-grid">
        {gridData.map((cell, i) => (
          <div
            key={i}
            className={`token-activity-cell level-${cell.level}`}
            title={`${new Date(cell.date).toLocaleDateString("zh-CN")}: ${cell.tokens.toLocaleString()} tokens`}
          />
        ))}
      </div>
      <div className="token-activity-legend">
        <span>少</span>
        <div className="token-activity-legend-bar">
          <div className="token-activity-legend-cell" style={{ background: "var(--surface-1)" }} />
          <div className="token-activity-legend-cell" style={{ background: "rgba(124, 108, 240, 0.20)" }} />
          <div className="token-activity-legend-cell" style={{ background: "rgba(124, 108, 240, 0.40)" }} />
          <div className="token-activity-legend-cell" style={{ background: "rgba(124, 108, 240, 0.60)" }} />
          <div className="token-activity-legend-cell" style={{ background: "rgba(124, 108, 240, 0.85)" }} />
        </div>
        <span>多</span>
      </div>
    </div>
  );
});

// ========== UsageChart ==========

interface UsageChartProps {
  records: UsageRecord[];
  /** 显示天数 */
  days?: number;
}

export const UsageChart = memo(function UsageChart({
  records,
  days = 7,
}: UsageChartProps) {
  const chartData = useMemo(() => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const labels: string[] = [];
    const costs: number[] = [];
    const tokens: number[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - i * dayMs;
      const dayEnd = dayStart + dayMs;
      const dayDate = new Date(dayStart);
      const label = `${dayDate.getMonth() + 1}/${dayDate.getDate()}`;
      labels.push(label);

      let dayCost = 0;
      let dayTokens = 0;
      for (const r of records) {
        if (r.timestamp >= dayStart && r.timestamp < dayEnd) {
          dayCost += r.cost;
          dayTokens += r.inputTokens + r.outputTokens;
        }
      }
      costs.push(dayCost);
      tokens.push(dayTokens);
    }

    return { labels, costs, tokens };
  }, [records, days]);

  const maxCost = Math.max(...chartData.costs, 0.01);
  const totalCost = chartData.costs.reduce((a, b) => a + b, 0);
  const totalTokens = chartData.tokens.reduce((a, b) => a + b, 0);

  return (
    <div className="usage-chart">
      <div className="usage-chart-header">
        <span className="usage-chart-title">每日用量</span>
        <div className="usage-chart-summary">
          <div className="usage-chart-stat">
            <span className="usage-chart-stat-value">${totalCost.toFixed(4)}</span>
            <span className="usage-chart-stat-label">总费用</span>
          </div>
          <div className="usage-chart-stat">
            <span className="usage-chart-stat-value">{totalTokens.toLocaleString()}</span>
            <span className="usage-chart-stat-label">Tokens</span>
          </div>
        </div>
      </div>
      <div className="usage-chart-bars">
        {chartData.costs.map((cost, i) => (
          <div
            key={i}
            className="usage-chart-bar"
            style={{ height: `${(cost / maxCost) * 100}%` }}
          >
            <div className="usage-chart-bar-tooltip">
              {chartData.labels[i]}: ${cost.toFixed(4)} / {chartData.tokens[i].toLocaleString()} tokens
            </div>
          </div>
        ))}
      </div>
      <div className="usage-chart-labels">
        {chartData.labels.map((label, i) => (
          <span key={i} className="usage-chart-label">{label}</span>
        ))}
      </div>
    </div>
  );
});
