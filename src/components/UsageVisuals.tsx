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
// R7：按天聚合与日期标签一律走**唯一口径**（本地日）—— 旧写法一边用 `toDateString()`（本地）、
// 一边（cost-tracker）用 `toISOString()` 的 UTC 日 ⇒ 同一功能两套"哪一天"
import { localDateString, localDayWindows, localTimeParts } from "../core/time/local-time";

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
    const cells: { date: number; tokens: number; level: 0 | 1 | 2 | 3 | 4 }[] = [];

    /*
     * O-40：格子一律取**本地日历日窗口**（唯一实现 `localDayWindows`）——
     * 旧写法 `now - i * 24h` 在夏令时跳变日会与本地日 key 错开 1 小时（记录算进相邻格子）。
     * 每格的 `date` 就是该窗口的本地日开始瞬时，格子数恒为 `days`。
     */
    const windows = localDayWindows(days, Date.now());

    // 按天聚合 token 用量（键 = 唯一口径的本地日）
    const dailyTokens: Record<string, number> = {};
    for (const r of records) {
      const dayKey = localDateString(new Date(r.timestamp));
      dailyTokens[dayKey] = (dailyTokens[dayKey] || 0) + (r.inputTokens + r.outputTokens);
    }

    // 计算最大值用于分级
    const maxTokens = Math.max(...Object.values(dailyTokens), 1);

    // 生成网格数据（窗口由旧到新 ⇒ 最后一格是今天）
    for (const w of windows) {
      const dayKey = localDateString(new Date(w.start));
      const tokens = dailyTokens[dayKey] || 0;
      const ratio = tokens / maxTokens;
      let level: 0 | 1 | 2 | 3 | 4 = 0;
      if (tokens > 0) {
        if (ratio < 0.25) level = 1;
        else if (ratio < 0.5) level = 2;
        else if (ratio < 0.75) level = 3;
        else level = 4;
      }
      cells.push({ date: w.date, tokens, level });
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
          <div className="token-activity-legend-cell" style={{ background: "color-mix(in srgb, var(--accent) 20%, transparent)" }} />
          <div className="token-activity-legend-cell" style={{ background: "color-mix(in srgb, var(--accent) 40%, transparent)" }} />
          <div className="token-activity-legend-cell" style={{ background: "color-mix(in srgb, var(--accent) 60%, transparent)" }} />
          <div className="token-activity-legend-cell" style={{ background: "color-mix(in srgb, var(--accent) 85%, transparent)" }} />
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
    const labels: string[] = [];
    const costs: number[] = [];
    const tokens: number[] = [];

    /*
     * O-40：窗口边界一律取**本地日历日窗口**（唯一实现 `localDayWindows`，与 `TokenActivityGrid` 同一处）——
     * 旧写法 `[now - i * 24h, +24h)` 既与标签错开（标签是本地日、窗口是滚动 24h），
     * 又在 DST 跳变日与本地日 key 错开 1 小时。
     */
    for (const w of localDayWindows(days, Date.now())) {
      const dayStart = w.start;
      const dayEnd = w.end; // = 次日本地日的起点（不是 start + 24h）
      const dayDate = new Date(dayStart);
      // 展示格式（M/D）可以不同于其它处，但**字段必须来自唯一口径**（不再自己 getMonth/getDate）
      const parts = localTimeParts(dayDate);
      const label = `${parts.month}/${parts.day}`;
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
